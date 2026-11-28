/**
 * Folders the system asked AmpleFile to open (Finder's Open With, a drop on
 * the Dock icon): the queue, the order they open in, and how long a window
 * waits for one. Each opens in the most recently focused window, as it did
 * when there was one window; the further folders of one request each open in
 * a new window, as Finder does (finder-open-paths.ts).
 *
 * A window brought back while a folder is still being found is owed a place:
 * its renderer waits for it (file-manager-windows.ts), so it never shows a
 * working message box for another Connected Folder first. That wait ends only
 * when nothing queued or being found can answer it any more. Finding a folder
 * is capped: one that takes longer than `lookupLimitMs` is given up, never
 * handed late to a window that has moved on, and the person is told.
 *
 * It knows nothing of Electron, so it is tested on its own;
 * desktop/src/main.ts supplies the windows and the lookup.
 */
import type { FileManagerOpenPath } from "./finder-open-paths.js";
import type { FileManagerWindowLike, FileManagerWindows } from "./file-manager-windows.js";

/** A timer that can be cancelled; the default never keeps the app alive on its own. */
export type OpenPathTimer = (callback: () => void, ms: number) => () => void;

export interface OpenPathDrainHost<W extends FileManagerWindowLike, Location> {
  windows: FileManagerWindows<W, Location>;
  /** Where a path opens, or null when nothing is there. */
  lookUp(target: FileManagerOpenPath): Promise<Location | null>;
  /** The front window, bringing back the windows that were open when none is (those it brings back are owed a place). */
  frontWindow(): Promise<W>;
  /** A new window made at `location`, which it has before its renderer loads. */
  newWindow(location: Location): Promise<W>;
  show(window: W): void;
  /** Hands a window that is already open a place to show. */
  hand(window: W, location: Location): void;
  /** Nothing is at the path any more (Finder may pass a path that moved before AmpleFile was ready). */
  notFound(path: string): void;
  /** Finding the folder took longer than `lookupLimitMs`: its open was given up. */
  overdue(path: string): void;
  /** How long finding one folder may take. */
  lookupLimitMs: number;
  /** How often a window owed a place checks whether anything can still answer it. */
  waitCheckMs: number;
  setTimer?: OpenPathTimer;
}

const defaultTimer: OpenPathTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const overdue = Symbol("overdue");

export class OpenPathDrain<W extends FileManagerWindowLike, Location> {
  readonly #host: OpenPathDrainHost<W, Location>;
  readonly #setTimer: OpenPathTimer;
  readonly #queue: Array<string | FileManagerOpenPath> = [];
  #running: Promise<void> | null = null;

  constructor(host: OpenPathDrainHost<W, Location>) {
    this.#host = host;
    this.#setTimer = host.setTimer ?? defaultTimer;
  }

  /** Folders to open, in order. A plain path opens as given in the most recent window. */
  queue(...targets: Array<string | FileManagerOpenPath>): void {
    this.#queue.push(...targets);
  }

  /** Folders queued and not yet being found. */
  get pending(): number {
    return this.#queue.length;
  }

  /** A folder is queued or being found, so a window owed a place may still get it. */
  get busy(): boolean {
    return this.#running !== null || this.#queue.length > 0;
  }

  /** Opens the queued folders, one at a time, each in its window; a call during a run waits for it and then opens what is left. */
  async drain(): Promise<void> {
    if (this.#running) {
      await this.#running;
      if (this.#queue.length) await this.drain();
      return;
    }
    this.#running = this.#run().finally(() => {
      this.#running = null;
      // Every folder is found or given up: windows owed a place that were handed none show their own place now.
      this.#host.windows.settleOpenLocation();
    });
    await this.#running;
    if (this.#queue.length) await this.drain();
  }

  /**
   * A window brought back while folders are queued or being found waits for
   * its place. It stops waiting on its own only once nothing can answer it;
   * if folders are still queued with nothing finding them, finding starts.
   */
  owe(window: W): void {
    if (!this.#host.windows.awaitOpenLocation(window)) return;
    const check = () => {
      if (!this.busy) {
        this.#host.windows.settleOpenLocation(window);
        return;
      }
      if (!this.#running) void this.drain().catch(() => undefined);
      this.#setTimer(check, this.#host.waitCheckMs);
    };
    this.#setTimer(check, this.#host.waitCheckMs);
  }

  async #run(): Promise<void> {
    while (this.#queue.length) {
      const entry = this.#queue.shift();
      const target = typeof entry === "string" ? { path: entry, reveal: false, newWindow: false } : entry;
      if (!target?.path) continue;
      const opensNewWindow = target.newWindow && this.#host.windows.size > 0;
      if (!opensNewWindow) this.#host.show(await this.#host.frontWindow());
      const location = await this.#lookUp(target);
      if (location === overdue) {
        this.#host.overdue(target.path);
        continue;
      }
      if (!location) {
        this.#host.notFound(target.path);
        continue;
      }
      if (opensNewWindow) {
        this.#host.show(await this.#host.newWindow(location));
        continue;
      }
      const window = await this.#host.frontWindow();
      this.#host.show(window);
      this.#host.hand(window, location);
    }
  }

  /** Finds a folder, or gives it up past the limit; an answer that comes later is dropped. */
  async #lookUp(target: FileManagerOpenPath): Promise<Location | null | typeof overdue> {
    let cancel = () => {};
    const late = new Promise<typeof overdue>((resolve) => { cancel = this.#setTimer(() => resolve(overdue), this.#host.lookupLimitMs); });
    try {
      return await Promise.race([this.#host.lookUp(target).catch(() => null), late]);
    } finally {
      cancel();
    }
  }
}
