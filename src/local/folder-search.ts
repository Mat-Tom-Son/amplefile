import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

import { isAlwaysHiddenConnectedFolderEntry } from "./connected-folder-ignore.js";
import { listConnectedFolders, resolveConnectedFolderPath } from "./connected-folder.js";
import { isHomeFolder, isSystemHiddenEntry } from "./hidden-entries.js";
import { directoryLooksGenerated, isHistoryAlwaysSkippedSegment } from "./history-capture-policy.js";
import { isOfficeLockFileName } from "./office-lock-files.js";
import { decodeRetrievalCursor, encodeRetrievalCursor, retrievalError } from "./retrieval-cursor.js";
import { accessError, standardFolderPathBase, standardFolderRoot, type StandardFolderId } from "./standard-folders.js";
import { ampleFileStateRoot } from "./state-paths.js";

/**
 * Search in a Standard Folder or a folder in the computer place: names and the
 * text of ordinary files, in the folder shown and everything beneath it.
 *
 * There is no index. Each page walks the disk live, depth first in a fixed
 * order (a folder's files, then its folders, each by name), within budgets of
 * time, entries, files read, and bytes read, and says truthfully when one
 * stopped it, with a cursor that continues where it stopped.
 *
 * What it never does: follow a symbolic link, read `.amplefile/`, `.pi/`, or
 * AmpleFile's own application data, read a binary or oversized file, leave
 * the searched folder's filesystem, or descend into a folder History skips as
 * not the person's work (`.git`, `node_modules`, caches, virtual environments)
 * unless that folder is the one searched. Hidden entries (hidden-entries.ts)
 * are searched only when asked for, the same rule as the listing's
 * `includeHidden`.
 *
 * A registered Connected Folder inside the searched folder is left to its own
 * search, which applies its ignore rules and covers its Chats; the result
 * names each one it passed so the window can search it there.
 */

export interface FolderSearchNameMatch {
  /** Relative to the place's top, like a listing's paths. */
  path: string;
  name: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt?: string;
  hidden?: true;
}

/** The Connected Folder search's file match, with the file's size and date for the result row. */
export interface FolderSearchFileMatch {
  path: string;
  /** The first line in the file that matched, counted from 1. */
  line: number;
  preview: string;
  sizeBytes: number;
  updatedAt: string;
  hidden?: true;
}

export type FolderSearchStop = "matches" | "files" | "bytes" | "entries" | "time" | "results";

export interface FolderSearchCoverage {
  /** Counters describe this page; an excluded folder counts once, not its contents. */
  internal: number;
  symbolicLink: number;
  hidden: number;
  /** Folders History skips as not the person's work. */
  generated: number;
  otherFilesystem: number;
  binary: number;
  oversized: number;
  unreadable: number;
  changed: number;
  nonRegular: number;
  visitedEntries: number;
  scannedBytes: number;
  /** Which budget ended this page, or null when the search reached its end. */
  stoppedBy: FolderSearchStop | null;
  consistency: "live";
  complete: boolean;
}

export interface FolderSearchResult {
  query: string;
  names: FolderSearchNameMatch[];
  files: FolderSearchFileMatch[];
  /** Always empty: a Standard Folder has no Chats. Kept so the result reads like a Connected Folder search's. */
  chats: [];
  /** Registered Connected Folders inside the searched folder, left to their own search. */
  connectedFolders: Array<{ connectedFolderId: string; path: string }>;
  truncated: boolean;
  scannedFiles: number;
  nextCursor: string | null;
  coverage: FolderSearchCoverage;
}

export interface FolderSearchOptions {
  /** The folder searched, relative to the place's top; "" is the top. */
  path?: string;
  cursor?: string;
  includeHidden?: boolean;
  /** Name and text matches together, per page. */
  maxMatches?: number;
  maxScannedFiles?: number;
  maxScannedBytes?: number;
  maxEntries?: number;
  maxMilliseconds?: number;
  signal?: AbortSignal;
  home?: string;
  platform?: NodeJS.Platform;
}

/** A file larger than this is skipped, not read: text search over it is not what a person browsing a folder means. */
export const maxSearchedFileBytes = 8 * 1024 * 1024;

export const folderSearchBudgets = {
  maxMatches: { fallback: 200, maximum: 1_000 },
  maxScannedFiles: { fallback: 20_000, maximum: 100_000 },
  maxScannedBytes: { fallback: 128 * 1024 * 1024, maximum: 1024 * 1024 * 1024 },
  maxEntries: { fallback: 200_000, maximum: 2_000_000 },
  maxMilliseconds: { fallback: 5_000, maximum: 30_000 },
} as const;

/** Formats whose bytes are not text; their names are matched, their contents never read. */
const binaryExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".ico", ".icns", ".raw", ".cr2", ".nef", ".dng", ".psd",
  ".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".aiff",
  ".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".wmv",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".tar", ".dmg", ".iso", ".pkg", ".deb", ".rpm", ".appimage",
  ".pdf", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".odt", ".ods", ".odp", ".pages", ".numbers", ".key", ".epub",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a", ".class", ".jar", ".wasm", ".pyc", ".node",
  ".sqlite", ".db", ".woff", ".woff2", ".ttf", ".otf",
]);

interface Frame {
  /** Relative to the searched folder; "" is the folder itself. */
  path: string;
  /** The last entry finished, as [0 file | 1 folder, name]. */
  after: [number, string] | null;
  /** dev:ino when pushed; a folder replaced since is skipped, never entered. */
  identity: string;
}

interface FolderSearchCursor { scope: string; stack: Frame[] }

const fileBatch = 32;

export async function searchStandardFolder(id: StandardFolderId, rawQuery: string, options: FolderSearchOptions = {}): Promise<FolderSearchResult> {
  const query = rawQuery.trim();
  if (!query) throw retrievalError("Enter something to search for.");
  if (query.length > 1024) throw retrievalError("Search text is too long.");
  const needle = query.toLocaleLowerCase();
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const budgets = {
    matches: budget(options.maxMatches, "maxMatches"),
    files: budget(options.maxScannedFiles, "maxScannedFiles"),
    bytes: budget(options.maxScannedBytes, "maxScannedBytes"),
    entries: budget(options.maxEntries, "maxEntries"),
    milliseconds: budget(options.maxMilliseconds, "maxMilliseconds"),
  };
  const deadline = Date.now() + budgets.milliseconds;
  aborted(options.signal);

  // The folder searched, under the place's path policy: no link anywhere in
  // the path, nothing reserved, nothing outside the place.
  const placePath = (options.path ?? "").split("/").filter((part) => part && part !== ".").join("/");
  let start: string;
  try {
    const base = standardFolderPathBase(id, placePath, home);
    start = base ? resolveConnectedFolderPath(base.root, base.path) : standardFolderRoot(id, home);
  } catch (error) {
    throw accessError(error, id);
  }
  const startInfo = await lstat(start).catch((error) => { throw accessError(error, id); });
  if (!startInfo.isDirectory()) throw Object.assign(new Error("Search looks inside a folder."), { status: 400, statusCode: 400 });
  const startDev = startInfo.dev;

  const connectedFolderRoots = new Map<string, string>();
  for (const connectedFolder of await listConnectedFolders()) {
    const real = await realpath(connectedFolder.connectedFolderRoot).catch(() => null);
    if (real) connectedFolderRoots.set(comparable(real, platform), connectedFolder.id);
  }
  const stateRoot = await realpath(ampleFileStateRoot()).catch(() => resolve(ampleFileStateRoot()));
  const realStart = await realpath(start).catch(() => start);

  const coverage: FolderSearchCoverage = {
    internal: 0, symbolicLink: 0, hidden: 0, generated: 0, otherFilesystem: 0, binary: 0, oversized: 0, unreadable: 0, changed: 0, nonRegular: 0,
    visitedEntries: 0, scannedBytes: 0, stoppedBy: null, consistency: "live", complete: false,
  };
  const result: FolderSearchResult = { query, names: [], files: [], chats: [], connectedFolders: [], truncated: false, scannedFiles: 0, nextCursor: null, coverage };
  const toPlace = (relativePath: string) => [placePath, relativePath].filter(Boolean).join("/");

  // The searched folder belongs to a Connected Folder: that Connected Folder's search covers it.
  const owner = [...connectedFolderRoots].find(([root]) => contains(root, comparable(realStart, platform)));
  if (owner) {
    result.connectedFolders.push({ connectedFolderId: owner[1], path: placePath });
    coverage.complete = true;
    return result;
  }

  const scope = digest(JSON.stringify([id, realStart, query, options.includeHidden === true]));
  const cursor = options.cursor ? decodeRetrievalCursor<FolderSearchCursor>(options.cursor) : null;
  if (cursor && cursor.scope !== scope) throw retrievalError("This cursor belongs to a different search. Start the search again.", 409);
  const stack: Frame[] = cursor?.stack ?? [{ path: "", after: null, identity: identityOf(startInfo) }];

  let resultBytes = 0;
  const admit = (match: FolderSearchNameMatch | FolderSearchFileMatch): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(match));
    if (resultBytes + bytes > 512 * 1024) return false;
    resultBytes += bytes;
    return true;
  };
  const matchCount = () => result.names.length + result.files.length;
  const stopReason = (): FolderSearchStop | null => {
    if (matchCount() >= budgets.matches) return "matches";
    if (result.scannedFiles >= budgets.files) return "files";
    if (coverage.scannedBytes >= budgets.bytes) return "bytes";
    if (coverage.visitedEntries >= budgets.entries) return "entries";
    if (Date.now() >= deadline) return "time";
    return null;
  };

  const listings = new Map<Frame, { entries: Dirent[]; index: number; absolute: string; atHome: boolean }>();
  // Every page moves the walk forward: no budget stops it before its first
  // step, so a cursor always continues somewhere new.
  let steps = 0;
  walk: while (stack.length) {
    aborted(options.signal);
    const stop = steps++ > 0 ? stopReason() : null;
    if (stop) { coverage.stoppedBy = stop; break; }
    const frame = stack.at(-1)!;
    let listing = listings.get(frame);
    if (!listing) {
      const absolute = frame.path ? join(start, ...frame.path.split("/")) : start;
      // A folder replaced since it was found (by a link, or by another
      // folder) is never entered: its identity is checked before reading.
      const info = await lstat(absolute).catch(() => null);
      if (!info?.isDirectory() || identityOf(info) !== frame.identity) {
        coverage.changed++;
        stack.pop();
        continue;
      }
      const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
      if (!entries) { coverage.unreadable++; stack.pop(); continue; }
      entries.sort(compareEntries);
      let index = 0;
      if (frame.after) {
        let end = entries.length;
        while (index < end) {
          const middle = (index + end) >>> 1;
          if (compareKeys(entryKey(entries[middle]!), frame.after) <= 0) index = middle + 1;
          else end = middle;
        }
      }
      listing = { entries, index, absolute, atHome: isHomeFolder(absolute, home, platform) };
      listings.set(frame, listing);
    }
    const { entries, absolute, atHome } = listing;

    // Consecutive files are read together; a folder is handled on its own,
    // because the walk descends into it before the next entry.
    const batch: Dirent[] = [];
    while (listing.index < entries.length && batch.length < fileBatch && !entries[listing.index]!.isDirectory()) batch.push(entries[listing.index++]!);
    if (!batch.length) {
      const entry = entries[listing.index++];
      if (!entry) { stack.pop(); listings.delete(frame); continue; }
      coverage.visitedEntries++;
      frame.after = entryKey(entry);
      const relativePath = frame.path ? `${frame.path}/${entry.name}` : entry.name;
      const hidden = isSystemHiddenEntry(entry.name, { platform, atHomeFolder: atHome });
      if (isAlwaysHiddenConnectedFolderEntry(entry.name)) { coverage.internal++; continue; }
      if (hidden && !options.includeHidden) { coverage.hidden++; continue; }
      const childPath = join(absolute, entry.name);
      const info = await lstat(childPath).catch(() => null);
      if (!info) { coverage.unreadable++; continue; }
      if (!info.isDirectory()) { coverage.changed++; continue; }
      if (info.dev !== startDev) { coverage.otherFilesystem++; continue; }
      if (comparable(childPath, platform) === comparable(stateRoot, platform)) { coverage.internal++; continue; }
      if (entry.name.toLocaleLowerCase().includes(needle)) {
        const match: FolderSearchNameMatch = { path: toPlace(relativePath), name: entry.name, kind: "folder", updatedAt: info.mtime.toISOString(), ...(hidden ? { hidden: true as const } : {}) };
        if (!admit(match)) { listing.index--; frame.after = previousKey(entries, listing.index); coverage.visitedEntries--; coverage.stoppedBy = "results"; break walk; }
        result.names.push(match);
      }
      const connectedFolderId = connectedFolderRoots.get(comparable(childPath, platform));
      if (connectedFolderId) { result.connectedFolders.push({ connectedFolderId, path: toPlace(relativePath) }); continue; }
      if (isHistoryAlwaysSkippedSegment(entry.name) || await directoryLooksGenerated(childPath)) { coverage.generated++; continue; }
      stack.push({ path: relativePath, after: null, identity: identityOf(info) });
      continue;
    }

    const outcomes = await Promise.all(batch.map((entry) => inspectFile(entry, absolute, atHome, needle, platform, options.includeHidden === true, startDev, options.signal)));
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index]!;
      const entry = batch[index]!;
      // A match past the page's room is left for the next page, which reads its file again.
      const matches = [outcome.name, outcome.file].filter((match): match is FolderSearchNameMatch | FolderSearchFileMatch => Boolean(match));
      if (matches.length && matchCount() + matches.length > budgets.matches && matchCount() > 0) {
        coverage.stoppedBy = "matches";
        listing.index -= outcomes.length - index;
        break walk;
      }
      const relativePath = frame.path ? `${frame.path}/${entry.name}` : entry.name;
      const placed = matches.map((match) => ({ ...match, path: toPlace(relativePath) }));
      if (!placed.every(admit)) {
        coverage.stoppedBy = "results";
        listing.index -= outcomes.length - index;
        break walk;
      }
      coverage.visitedEntries++;
      frame.after = entryKey(entry);
      if (outcome.counter) coverage[outcome.counter]++;
      coverage.scannedBytes += outcome.bytes;
      if (outcome.read) result.scannedFiles++;
      for (const match of placed) {
        if ("line" in match) result.files.push(match);
        else result.names.push(match);
      }
    }
  }
  aborted(options.signal);
  const more = stack.length > 0;
  coverage.complete = !more && coverage.unreadable === 0 && coverage.changed === 0;
  result.truncated = !coverage.complete;
  result.nextCursor = more ? encodeRetrievalCursor({ scope, stack } satisfies FolderSearchCursor) : null;
  if (!more) coverage.stoppedBy = null;
  return result;
}

interface FileOutcome {
  name: FolderSearchNameMatch | null;
  file: FolderSearchFileMatch | null;
  /** The coverage counter this entry adds to; null for a file read in full. */
  counter: "internal" | "hidden" | "symbolicLink" | "binary" | "oversized" | "unreadable" | "changed" | "nonRegular" | "otherFilesystem" | null;
  bytes: number;
  read: boolean;
}

/** One non-folder entry: its name, and the first line of its text that matches. */
async function inspectFile(entry: Dirent, directory: string, atHome: boolean, needle: string, platform: NodeJS.Platform, includeHidden: boolean, startDev: number, signal?: AbortSignal): Promise<FileOutcome> {
  const skip = (counter: FileOutcome["counter"]): FileOutcome => ({ name: null, file: null, counter, bytes: 0, read: false });
  if (isAlwaysHiddenConnectedFolderEntry(entry.name) || isOfficeLockFileName(entry.name)) return skip("internal");
  const hidden = isSystemHiddenEntry(entry.name, { platform, atHomeFolder: atHome });
  if (hidden && !includeHidden) return skip("hidden");
  if (entry.isSymbolicLink()) return skip("symbolicLink");
  if (!entry.isFile()) return skip("nonRegular");
  const path = join(directory, entry.name);
  const info = await lstat(path).catch(() => null);
  if (!info) return skip("unreadable");
  if (!info.isFile()) return skip("changed");
  const hiddenMark = hidden ? { hidden: true as const } : {};
  const stamp = { sizeBytes: info.size, updatedAt: info.mtime.toISOString() };
  const name: FolderSearchNameMatch | null = entry.name.toLocaleLowerCase().includes(needle)
    ? { path: "", name: entry.name, kind: "file", ...stamp, ...hiddenMark }
    : null;
  const noContent = (counter: FileOutcome["counter"]): FileOutcome => ({ name, file: null, counter, bytes: 0, read: false });
  if (info.dev !== startDev) return noContent("otherFilesystem");
  if (binaryExtensions.has(extname(entry.name).toLocaleLowerCase())) return noContent("binary");
  if (info.size > maxSearchedFileBytes) return noContent("oversized");
  if (info.size === 0) return { name, file: null, counter: null, bytes: 0, read: true };
  if (signal?.aborted) return noContent("unreadable");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW: the file is read only if it is still the ordinary file the
    // walk found, never a link swapped in; its identity is checked again on the handle.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || identityOf(opened) !== identityOf(info)) return noContent("changed");
    const bytes = Buffer.alloc(Math.min(opened.size, maxSearchedFileBytes));
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    const content = bytes.subarray(0, filled);
    if (looksBinary(content.subarray(0, 8192))) return { name, file: null, counter: "binary", bytes: filled, read: true };
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
    catch { return { name, file: null, counter: "binary", bytes: filled, read: true }; }
    const found = firstMatchingLine(text, needle);
    return {
      name,
      file: found ? { path: "", line: found.line, preview: preview(found.text, found.at, needle.length), ...stamp, ...hiddenMark } : null,
      counter: null,
      bytes: filled,
      read: true,
    };
  } catch {
    return { name, file: null, counter: "unreadable", bytes: 0, read: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function firstMatchingLine(text: string, needle: string): { line: number; text: string; at: number } | null {
  // Most files do not match: one lower-cased pass answers that before any line is split.
  if (!text.toLocaleLowerCase().includes(needle)) return null;
  let line = 1;
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const body = text.slice(start, end < 0 ? text.length : end).replace(/\r$/u, "");
    const at = body.toLocaleLowerCase().indexOf(needle);
    if (at >= 0) return { line, text: body, at };
    if (end < 0) break;
    start = end + 1;
    line += 1;
  }
  return null;
}

function entryKey(entry: Dirent): [number, string] {
  return [entry.isDirectory() ? 1 : 0, entry.name];
}

function previousKey(entries: readonly Dirent[], index: number): [number, string] | null {
  return index > 0 ? entryKey(entries[index - 1]!) : null;
}

function compareKeys(left: readonly [number, string], right: readonly [number, string]): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
}

function compareEntries(left: Dirent, right: Dirent): number {
  return compareKeys(entryKey(left), entryKey(right));
}

function identityOf(info: Stats): string {
  return `${info.dev}:${info.ino}`;
}

function comparable(value: string, platform: NodeJS.Platform): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "") || sep;
  return platform === "linux" ? resolved : resolved.toLocaleLowerCase();
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function preview(line: string, at: number, length: number): string {
  const start = Math.max(0, at - 80);
  const value = `${start ? "…" : ""}${line.slice(start, at + length + 80).trim()}`;
  return value.length > 240 ? `${value.slice(0, 240)}…` : value;
}

function looksBinary(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true;
  let controls = 0;
  for (const byte of bytes) if (byte < 9 || (byte > 13 && byte < 32)) controls++;
  return bytes.length > 0 && controls / bytes.length > 0.1;
}

function budget(value: number | undefined, name: keyof typeof folderSearchBudgets): number {
  const { fallback, maximum } = folderSearchBudgets[name];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw retrievalError(`${name} must be between 1 and ${maximum}.`);
  return value;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Search cancelled."), { name: "AbortError" });
}
