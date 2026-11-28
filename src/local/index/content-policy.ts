/**
 * The indexable files of one Connected Folder (docs/index-and-recall.md).
 *
 * This is not a new rule set: it is the walk Search and History already
 * agree on, built from their primitives.
 *
 * - Always-hidden entries (`.amplefile/`, `.pi/`, and the rest of the
 *   built-in hidden set) and Office lock files, as Search leaves out.
 * - The folder's ignore rules, as Search and Files apply them.
 * - Nested registered Connected Folder roots: a parent's index stops at a
 *   nested root, which keeps its own index.
 * - Symbolic links are never followed.
 * - The History capture policy's directory skips: version-control
 *   internals, installed dependencies, virtual environments, `CACHEDIR.TAG`
 *   caches, and gitignored directories.
 *
 * The walk is bounded like the Automation file observer (files, visited
 * entries, depth) and reports which bound stopped it.
 *
 * On macOS a cloud placeholder (a file a sync service has not downloaded)
 * reports `blocks === 0` with `size > 0`. Such a file is listed as not
 * downloaded and is never opened.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { isAlwaysHiddenConnectedFolderEntry, isConnectedFolderIgnored, readConnectedFolderIgnoreState } from "../connected-folder-ignore.js";
import { comparableRelative, nestedRegisteredConnectedFolderPaths } from "../connected-folder.js";
import { createFullHistoryCapturePolicy } from "../history-capture-policy.js";
import { isOfficeLockFileName } from "../office-lock-files.js";

export const connectedFolderIndexWalkBounds = Object.freeze({
  maxFiles: 50_000,
  maxVisitedEntries: 200_000,
  maxDepth: 64,
});

export interface IndexableFile {
  /** Connected Folder–relative, `/`-separated. */
  path: string;
  size: number;
  mtimeMs: number;
  /** A cloud placeholder: listed, never read. */
  notDownloaded: boolean;
}

export interface IndexWalkExclusions {
  hidden: number;
  lockFile: number;
  ignored: number;
  nested: number;
  generated: number;
  gitignored: number;
  symbolicLink: number;
  nonRegular: number;
  unreadable: number;
}

export interface IndexWalkResult {
  files: IndexableFile[];
  /** Entries left out, each counted once at the entry (a directory's descendants are not counted). */
  excluded: IndexWalkExclusions;
  /** The bound that stopped the walk, or null when it saw everything it could. */
  stoppedBy: "files" | "entries" | "depth" | null;
  /** True when no bound stopped the walk and no directory was unreadable. */
  complete: boolean;
}

export interface IndexWalkOptions {
  signal?: AbortSignal;
  bounds?: Partial<typeof connectedFolderIndexWalkBounds>;
  /** Asked before each directory; true stops the walk as aborted. */
  shouldStop?: () => boolean;
}

export async function listIndexableFiles(connectedFolderRoot: string, options: IndexWalkOptions = {}): Promise<IndexWalkResult> {
  const bounds = { ...connectedFolderIndexWalkBounds, ...options.bounds };
  const ignore = (await readConnectedFolderIgnoreState(connectedFolderRoot).catch(() => ({ patterns: [] as string[] }))).patterns;
  const nested = (await nestedRegisteredConnectedFolderPaths(connectedFolderRoot)).map(comparableRelative);
  const policy = await createFullHistoryCapturePolicy(connectedFolderRoot);
  const excluded: IndexWalkExclusions = { hidden: 0, lockFile: 0, ignored: 0, nested: 0, generated: 0, gitignored: 0, symbolicLink: 0, nonRegular: 0, unreadable: 0 };
  const files: IndexableFile[] = [];
  let visited = 0;
  let stoppedBy: IndexWalkResult["stoppedBy"] = null;
  const stack: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }];
  const isNested = (path: string) => {
    if (!nested.length) return false;
    const key = comparableRelative(path);
    return nested.some((child) => key === child || key.startsWith(`${child}/`));
  };
  walk: while (stack.length) {
    stopIfAsked(options);
    const { path: directory, depth } = stack.pop()!;
    const absoluteDirectory = join(connectedFolderRoot, directory);
    await policy.enterDirectory(directory, absoluteDirectory).catch(() => undefined);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true }).catch(() => null);
    if (!entries) { excluded.unreadable++; continue; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const subdirectories: string[] = [];
    for (const entry of entries) {
      if (visited >= bounds.maxVisitedEntries) { stoppedBy = "entries"; break walk; }
      visited++;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (isAlwaysHiddenConnectedFolderEntry(entry.name)) { excluded.hidden++; continue; }
      if (isOfficeLockFileName(entry.name)) { excluded.lockFile++; continue; }
      if (isNested(path)) { excluded.nested++; continue; }
      if (isConnectedFolderIgnored(path, ignore)) { excluded.ignored++; continue; }
      if (entry.isSymbolicLink()) { excluded.symbolicLink++; continue; }
      if (entry.isDirectory()) {
        const reason = await policy.excludeDirectory(path, join(connectedFolderRoot, path)).catch(() => null);
        if (reason === "builtin") { excluded.generated++; continue; }
        if (reason === "gitignore") { excluded.gitignored++; continue; }
        if (reason === "connected-folder_ignore") { excluded.ignored++; continue; }
        if (depth + 1 > bounds.maxDepth) { stoppedBy ??= "depth"; continue; }
        subdirectories.push(path);
        continue;
      }
      if (!entry.isFile()) { excluded.nonRegular++; continue; }
      if (policy.excludeFile(path)) { excluded.generated++; continue; }
      const info = await lstat(join(connectedFolderRoot, path)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "gone" as const : null);
      // A file removed or renamed since the listing is simply not there.
      if (info === "gone") continue;
      if (!info) { excluded.unreadable++; continue; }
      if (!info.isFile()) { if (info.isSymbolicLink()) excluded.symbolicLink++; else excluded.nonRegular++; continue; }
      if (files.length >= bounds.maxFiles) { stoppedBy = "files"; break walk; }
      files.push({
        path,
        size: info.size,
        mtimeMs: info.mtimeMs,
        notDownloaded: isCloudPlaceholder(info),
      });
    }
    // Depth-first in name order: push in reverse so the first name is walked first.
    for (const path of subdirectories.reverse()) stack.push({ path, depth: depth + 1 });
  }
  return { files, excluded, stoppedBy, complete: stoppedBy === null && excluded.unreadable === 0 };
}

/** macOS reports a cloud placeholder as a non-empty file holding no blocks on disk. */
export function isCloudPlaceholder(info: { size: number | bigint; blocks: number | bigint }): boolean {
  return process.platform === "darwin" && Number(info.blocks) === 0 && Number(info.size) > 0;
}

function stopIfAsked(options: IndexWalkOptions): void {
  if (options.signal?.aborted || options.shouldStop?.()) {
    throw Object.assign(new Error("Indexing stopped."), { name: "AbortError" });
  }
}
