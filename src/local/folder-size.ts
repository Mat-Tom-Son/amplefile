/**
 * A folder's total size and item count, on request, for the file manager
 * window's list and Info.
 *
 * The walk never follows a symbolic link (a link counts as one item and adds
 * no bytes), stays on the folder's own volume (another volume mounted inside
 * is counted as one folder and not entered), and leaves out AmpleFile's and
 * Pi's portable data (`.amplefile/`, `.pi/`, and an older `.work-fold/`)
 * entirely, so the answer says nothing about what they hold. It stops when the
 * request goes away, and after a time or item bound answers with what it
 * counted so far, marked as partial.
 *
 * A short-lived in-memory cache answers the same folder again for a few
 * seconds, and a request for a folder already being measured waits on that
 * walk. The window re-lists a folder on every change it hears of, and each
 * listing could ask again for every folder row it shows; a deep folder's size
 * cannot be invalidated cheaply (a change deep inside does not touch the
 * folder's own modification time), so a short lifetime bounds how stale an
 * answer can be while sparing repeated walks of the same tree.
 */

import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isReservedConnectedFolderPathSegment } from "./connected-folder-path-policy.js";

export interface FolderSize {
  /** Sum of the files' sizes, in bytes; each name of a hard-linked file counts. */
  bytes: number;
  /** Space the files take on disk, counting a hard-linked file once; null where the system does not report it. */
  bytesOnDisk: number | null;
  /** Everything inside, at any depth: files, folders, links, and other items. */
  items: number;
  files: number;
  folders: number;
  links: number;
  /** Folders inside that could not be read (permission); their contents are not counted. */
  unreadable: number;
  /** Folders inside that are another volume's mount point; their contents are not counted. */
  otherVolumes: number;
  /** True when every folder inside was read to the end. */
  complete: boolean;
  /** Set when a bound stopped the walk early; the totals are what was counted until then. */
  stoppedBy: "time-limit" | "item-limit" | null;
  /** How long the walk took, in milliseconds. */
  elapsedMs: number;
  /** When this answer was measured (ISO). */
  measuredAt: string;
}

export interface FolderSizeLimits {
  /** Stop after this long and answer with a partial total. */
  maxMs: number;
  /** Stop after counting this many items and answer with a partial total. */
  maxItems: number;
  /** File-system calls outstanding at once, across the whole walk. */
  concurrency: number;
}

export const defaultFolderSizeLimits: FolderSizeLimits = Object.freeze({
  maxMs: 10_000,
  maxItems: 1_000_000,
  concurrency: 8,
});

/** Folders read at once; their calls share the `concurrency` bound. */
const folderReaders = 4;

function abortError(): Error {
  return Object.assign(new Error("The request went away."), { name: "AbortError" });
}

/** Measures one folder (an absolute path already resolved under its place's path policy). */
export async function measureFolderSize(folder: string, options: { signal?: AbortSignal; limits?: Partial<FolderSizeLimits> } = {}): Promise<FolderSize> {
  const limits = { ...defaultFolderSizeLimits, ...options.limits };
  const signal = options.signal;
  signal?.throwIfAborted();
  const started = Date.now();
  const top = await lstat(folder, { bigint: true });
  if (!top.isDirectory()) throw Object.assign(new Error("Choose a folder."), { statusCode: 400 });
  const volume = top.dev;
  const totals = { bytes: 0n, bytesOnDisk: 0n, items: 0, files: 0, folders: 0, links: 0, unreadable: 0, otherVolumes: 0 };
  let blocksReported = true;
  const counted = new Set<string>();
  let stoppedBy: FolderSize["stoppedBy"] = null;
  const deadline = started + limits.maxMs;

  const pending: string[] = [folder];
  const stop = (): boolean => {
    if (stoppedBy) return true;
    if (totals.items >= limits.maxItems) stoppedBy = "item-limit";
    else if (Date.now() >= deadline) stoppedBy = "time-limit";
    return stoppedBy !== null;
  };

  // At most `concurrency` file-system calls are outstanding at once, across
  // every folder being read, so the walk never crowds out the app's other
  // file work in Node's shared thread pool.
  let outstanding = 0;
  const slotWaiters: Array<() => void> = [];
  const withSlot = async <T>(call: () => Promise<T>): Promise<T> => {
    while (outstanding >= limits.concurrency) await new Promise<void>((resolve) => slotWaiters.push(resolve));
    outstanding += 1;
    try {
      return await call();
    } finally {
      outstanding -= 1;
      slotWaiters.shift()?.();
    }
  };

  // One entry inside a folder being read.
  const examine = async (parent: string, entry: Dirent): Promise<void> => {
    if (isReservedConnectedFolderPathSegment(entry.name)) return;
    if (entry.isSymbolicLink()) {
      totals.items += 1;
      totals.links += 1;
      return;
    }
    const path = join(parent, entry.name);
    const info = await withSlot(() => lstat(path, { bigint: true })).catch(() => null);
    if (!info) return; // removed while being measured
    if (stoppedBy) return;
    totals.items += 1;
    if (info.isSymbolicLink()) { totals.links += 1; return; }
    if (info.isDirectory()) {
      totals.folders += 1;
      if (info.dev !== volume) { totals.otherVolumes += 1; return; }
      pending.push(path);
      wake();
      return;
    }
    if (info.isFile()) {
      totals.files += 1;
      totals.bytes += info.size;
      if (info.blocks === undefined || info.blocks === null) blocksReported = false;
      else if (info.nlink > 1n) {
        const identity = `${info.dev}:${info.ino}`;
        if (!counted.has(identity)) { counted.add(identity); totals.bytesOnDisk += info.blocks * 512n; }
      } else totals.bytesOnDisk += info.blocks * 512n;
    }
  };

  // Reads one folder and examines its entries.
  const read = async (path: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await withSlot(() => readdir(path, { withFileTypes: true }));
    } catch (error) {
      if (path === folder) throw error;
      totals.unreadable += 1;
      return;
    }
    const examining: Promise<void>[] = [];
    for (const entry of entries) {
      if (signal?.aborted || stop()) break;
      examining.push(examine(path, entry));
      // Keep the number of entries in hand bounded in a very large folder.
      if (examining.length >= limits.concurrency * 4) await Promise.all(examining.splice(0));
    }
    await Promise.all(examining);
  };

  // Several folders are read at once; each reader takes the next folder found.
  let active = 0;
  let wake: () => void = () => undefined;
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (signal?.aborted) { failed = true; reject(signal.reason ?? abortError()); return; }
      while (active < folderReaders && pending.length && !stop()) {
        active += 1;
        read(pending.pop()!).then(() => {
          active -= 1;
          pump();
        }, (error: unknown) => {
          failed = true;
          reject(error);
        });
      }
      if (active === 0) resolve();
    };
    wake = pump;
    pump();
  });
  signal?.throwIfAborted();
  return {
    bytes: Number(totals.bytes),
    bytesOnDisk: blocksReported ? Number(totals.bytesOnDisk) : null,
    items: totals.items,
    files: totals.files,
    folders: totals.folders,
    links: totals.links,
    unreadable: totals.unreadable,
    otherVolumes: totals.otherVolumes,
    complete: stoppedBy === null && pending.length === 0 && totals.unreadable === 0,
    stoppedBy,
    elapsedMs: Date.now() - started,
    measuredAt: new Date().toISOString(),
  };
}

/** How long a measured size is answered again without walking. */
export const folderSizeCacheLifetimeMs = 15_000;
const folderSizeCacheEntries = 512;

interface FolderSizeWalk {
  waiters: number;
  controller: AbortController;
  promise: Promise<FolderSize>;
}

/**
 * Folder sizes for the local API: a short-lived cache of answers and one walk
 * per folder at a time. A walk stops when every request waiting on it has gone
 * away. `fresh` skips the cache (Info's explicit refresh).
 */
export class FolderSizes {
  private readonly answers = new Map<string, { at: number; size: FolderSize }>();
  private readonly walks = new Map<string, FolderSizeWalk>();
  /** Walks actually started, for tests. */
  walksStarted = 0;

  constructor(private readonly limits: Partial<FolderSizeLimits> = {}, private readonly lifetimeMs = folderSizeCacheLifetimeMs) {}

  async measure(folder: string, options: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<FolderSize & { cached: boolean }> {
    options.signal?.throwIfAborted();
    const kept = this.answers.get(folder);
    if (kept && !options.fresh && Date.now() - kept.at < this.lifetimeMs) return { ...kept.size, cached: true };
    let walk = this.walks.get(folder);
    if (!walk) {
      const controller = new AbortController();
      const promise = measureFolderSize(folder, { signal: controller.signal, limits: this.limits });
      const created: FolderSizeWalk = { waiters: 0, controller, promise };
      walk = created;
      this.walks.set(folder, created);
      this.walksStarted += 1;
      promise.then((size) => {
        this.answers.delete(folder);
        this.answers.set(folder, { at: Date.now(), size });
        while (this.answers.size > folderSizeCacheEntries) this.answers.delete(this.answers.keys().next().value!);
      }, () => undefined).finally(() => {
        if (this.walks.get(folder) === created) this.walks.delete(folder);
      });
    }
    const current = walk;
    current.waiters += 1;
    const signal = options.signal;
    return new Promise((resolve, reject) => {
      let waiting = true;
      const done = () => {
        if (!waiting) return false;
        waiting = false;
        current.waiters -= 1;
        signal?.removeEventListener("abort", leave);
        return true;
      };
      const leave = () => {
        if (!done()) return;
        // The last request waiting on this walk went away: stop it.
        if (current.waiters === 0) {
          current.controller.abort();
          if (this.walks.get(folder) === current) this.walks.delete(folder);
        }
        reject(Object.assign(new Error("The request went away."), { name: "AbortError" }));
      };
      if (signal?.aborted) { leave(); return; }
      signal?.addEventListener("abort", leave, { once: true });
      current.promise.then(
        (size) => { if (done()) resolve({ ...size, cached: false }); },
        (error) => { if (done()) reject(error); },
      );
    });
  }
}
