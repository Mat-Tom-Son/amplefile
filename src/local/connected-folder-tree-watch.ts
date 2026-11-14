import { readFileSync, watch as nodeWatch } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Live file events for a Connected Folder on Linux, at one kernel watch per
 * folder.
 *
 * Node's recursive `fs.watch` on Linux places a watch on every file and every
 * folder beneath the root. The kernel caps watches per user across all apps
 * (`fs.inotify.max_user_watches`), so one large Connected Folder could spend
 * the whole allowance and make other apps fail. A watch on a folder already
 * reports changes to the files directly inside it, so this watches folders
 * only, leaves out the folders the caller names, and stops at a budget.
 *
 * A folder left out, or beyond the budget, can still be watched one level deep
 * while it is on screen: see `show`.
 */

export interface ConnectedFolderTreeWatcher {
  close(): void;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export type WatchConnectedFolderDirectory = (
  directory: string,
  listener: (eventType: string, fileName: string | Buffer | null) => void,
) => ConnectedFolderTreeWatcher;

export interface ConnectedFolderTreeWatchOptions {
  /** A change at a slash-separated path under the root; `null` when the kernel named none. */
  onChange(eventType: string, relativePath: string | null): void;
  onError(error: unknown): void;
  /** Whether a folder's contents stay unwatched. Asked once per folder, never for the root. */
  skipDirectory(relativePath: string): boolean | Promise<boolean>;
  /** The most folders watched as part of the tree. Defaults to a share of the kernel's allowance. */
  maxDirectories?: number;
  /** The most folders kept watched only because they were shown. */
  maxShownDirectories?: number;
  watchDirectory?: WatchConnectedFolderDirectory;
}

export interface ConnectedFolderTreeWatch {
  /** Settles when the folders present at the start are watched. */
  readonly ready: Promise<void>;
  /** False when the budget or the kernel's allowance ran out before every folder was watched. */
  complete(): boolean;
  directoryCount(): number;
  /** Watches one folder level that is on screen, when the tree watch does not already cover it. */
  show(relativePath: string): Promise<void>;
  /** Applies changed skip answers: drops folders now skipped and adds folders now allowed. */
  rescan(): Promise<void>;
  close(): void;
}

const mostTreeDirectories = 16_384;
const fewestTreeDirectories = 256;
const fallbackTreeDirectories = 8_192;
const defaultShownDirectories = 8;

/** An eighth of the kernel's per-user watch allowance, within fixed bounds. */
export function connectedFolderWatchBudget(readLimit: () => string = () => readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8")): number {
  let limit: number;
  try {
    limit = Number.parseInt(readLimit().trim(), 10);
  } catch {
    return fallbackTreeDirectories;
  }
  if (!Number.isFinite(limit) || limit <= 0) return fallbackTreeDirectories;
  return Math.min(mostTreeDirectories, Math.max(fewestTreeDirectories, Math.floor(limit / 8)));
}

export function watchConnectedFolderTree(root: string, options: ConnectedFolderTreeWatchOptions): ConnectedFolderTreeWatch {
  const watchDirectory: WatchConnectedFolderDirectory = options.watchDirectory ?? ((directory, listener) => nodeWatch(directory, listener));
  const maxDirectories = Math.max(1, options.maxDirectories ?? connectedFolderWatchBudget());
  const maxShown = Math.max(0, options.maxShownDirectories ?? defaultShownDirectories);
  /** Every watched folder by its path under the root; the root is "". */
  const watchers = new Map<string, ConnectedFolderTreeWatcher>();
  /** Folders watched one level deep only because they were shown, oldest first. */
  const shown = new Set<string>();
  let exhausted = false;
  let closed = false;
  // Walks, drops and rescans run one at a time, so two cannot disagree about
  // which folders are watched.
  let work: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = work.then(() => closed ? undefined : task()).catch((error) => { if (!closed) options.onError(error); });
    work = next;
    return next;
  };

  const absolute = (relativePath: string) => relativePath ? join(root, ...relativePath.split("/")) : root;
  const child = (relativePath: string, name: string) => relativePath ? `${relativePath}/${name}` : name;

  const stopWatching = (relativePath: string) => {
    const watcher = watchers.get(relativePath);
    if (!watcher) return;
    watchers.delete(relativePath);
    shown.delete(relativePath);
    try { watcher.close(); } catch { /* already closed */ }
  };
  const dropSubtree = (relativePath: string) => {
    if (!relativePath) return;
    const prefix = `${relativePath}/`;
    for (const watched of [...watchers.keys()]) if (watched === relativePath || watched.startsWith(prefix)) stopWatching(watched);
  };

  /** Returns whether the folder is now watched. */
  const startWatching = (relativePath: string, becauseShown: boolean): boolean => {
    if (closed) return false;
    if (watchers.has(relativePath)) {
      // A folder shown earlier that the tree now reaches becomes part of the tree.
      if (!becauseShown) shown.delete(relativePath);
      return true;
    }
    if (!becauseShown && watchers.size - shown.size >= maxDirectories) {
      exhausted = true;
      return false;
    }
    let watcher: ConnectedFolderTreeWatcher;
    try {
      watcher = watchDirectory(absolute(relativePath), (eventType, fileName) => onDirectoryEvent(relativePath, eventType, fileName));
    } catch (error) {
      // ENOSPC is the kernel's allowance; a folder that vanished or cannot be
      // read is simply not watched.
      if (errorCode(error) === "ENOSPC" || errorCode(error) === "EMFILE") exhausted = true;
      else if (!relativePath) throw error;
      return false;
    }
    watchers.set(relativePath, watcher);
    if (becauseShown) shown.add(relativePath);
    watcher.on("error", (error) => {
      if (closed || watchers.get(relativePath) !== watcher) return;
      if (errorCode(error) === "ENOSPC" || errorCode(error) === "EMFILE") exhausted = true;
      if (relativePath) stopWatching(relativePath);
      else options.onError(error);
    });
    return true;
  };

  /** Watches a folder and the folders beneath it, nearest first. Returns the folders newly watched. */
  const walk = async (start: string): Promise<string[]> => {
    const added: string[] = [];
    const pending = [start];
    for (let index = 0; index < pending.length; index++) {
      if (closed) break;
      const relativePath = pending[index]!;
      if (relativePath && await options.skipDirectory(relativePath)) continue;
      const already = watchers.has(relativePath) && !shown.has(relativePath);
      if (!startWatching(relativePath, false)) {
        if (exhausted) break;
        continue;
      }
      if (!already) added.push(relativePath);
      try {
        for await (const entry of await opendir(absolute(relativePath))) {
          // A symbolic link is not followed: its target may lie outside the root.
          if (entry.isDirectory()) pending.push(child(relativePath, entry.name));
        }
      } catch { /* vanished or unreadable; its parent reports what happens to it */ }
    }
    return added;
  };

  /** A name appeared in or left a watched folder: follow a folder that arrived, forget one that left. */
  const reconcile = (parent: string, relativePath: string) => enqueue(async () => {
    const info = await lstat(absolute(relativePath)).catch(() => null);
    // The watch on a folder that was moved or replaced still follows the old
    // one, under a path that is no longer true.
    dropSubtree(relativePath);
    if (!info?.isDirectory()) return;
    // A folder watched only because it is shown does not extend the tree.
    if (!watchers.has(parent) || shown.has(parent)) return;
    // Files written before the new folders were watched went unreported; one
    // event per new folder lets a view of it reload.
    for (const added of await walk(relativePath)) options.onChange("rename", added);
  });

  const onDirectoryEvent = (relativePath: string, eventType: string, fileName: string | Buffer | null) => {
    if (closed) return;
    const name = Buffer.isBuffer(fileName) ? fileName.toString("utf8") : fileName ?? "";
    if (!name) {
      options.onChange(eventType, relativePath || null);
      return;
    }
    const changed = child(relativePath, name);
    options.onChange(eventType, changed);
    if (eventType === "rename") void reconcile(relativePath, changed);
  };

  const ready = enqueue(async () => { await walk(""); });

  return {
    ready,
    complete: () => !exhausted,
    directoryCount: () => watchers.size,
    show: (requested) => enqueue(async () => {
      const relativePath = normalizeRelativePath(requested);
      if (relativePath === null || maxShown === 0) return;
      if (watchers.has(relativePath)) {
        if (shown.delete(relativePath)) shown.add(relativePath);
        return;
      }
      const info = await lstat(absolute(relativePath)).catch(() => null);
      if (!info?.isDirectory() || !startWatching(relativePath, true)) return;
      while (shown.size > maxShown) stopWatching(shown.values().next().value!);
    }),
    rescan: () => enqueue(async () => {
      for (const relativePath of [...watchers.keys()].sort()) {
        if (!relativePath || !watchers.has(relativePath) || shown.has(relativePath)) continue;
        if (await options.skipDirectory(relativePath)) dropSubtree(relativePath);
      }
      exhausted = false;
      await walk("");
    }),
    close: () => {
      if (closed) return;
      closed = true;
      for (const watcher of watchers.values()) {
        try { watcher.close(); } catch { /* already closed */ }
      }
      watchers.clear();
      shown.clear();
    },
  };
}

/** A slash-separated path under the root, or null when it would leave it. */
function normalizeRelativePath(value: string): string | null {
  const parts = value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  return parts.includes("..") ? null : parts.join("/");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}
