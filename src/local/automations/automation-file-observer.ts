import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { isAlwaysHiddenConnectedFolderEntry } from "../connected-folder-ignore.js";
import type { AutomationCatchUpReason } from "../../shared/automation-presentation.js";
import { listConnectedFolders, resolveConnectedFolderPath } from "../connected-folder.js";
import { resolveFolderTargets } from "./folder-targets.js";
import { ampleFileAutomationBounds, type AmpleFileAutomationFilesChangedTrigger } from "./automation-declarations.js";

export type { AutomationCatchUpReason as AmpleFileAutomationCatchUpReason } from "../../shared/automation-presentation.js";

export interface AmpleFileAutomationFileSnapshot { digest: string; entries: Record<string, string>; }
export type AmpleFileAutomationFileObserver = (trigger: AmpleFileAutomationFilesChangedTrigger) => Promise<AmpleFileAutomationFileSnapshot>;

/**
 * The observer's scan bounds. Metadata only, polled every few seconds:
 * generous counts, no byte ceiling. A saved folder snapshot never holds more
 * files than one scan can see.
 */
export const ampleFileAutomationFileObserverBounds = Object.freeze({
  maxFiles: 50_000,
  maxVisitedEntries: 200_000,
  maxDepth: 256,
});

/** Metadata only: no file bytes become conversation or model context. A
 * bounded ordinary-folder scan works on synchronized drives as well as local
 * disks without relying on lossy OS watcher events. */
export const observeAmpleFileAutomationFiles: AmpleFileAutomationFileObserver = async (trigger) => {
  const connectedFolders = await listConnectedFolders();
  const connectedFolder = connectedFolders.find((item) => item.id === trigger.connectedFolder);
  if (!connectedFolder) throw new Error("The watched Connected Folder is no longer registered.");
  if (!trigger.watch.path) return observeTopLevel(connectedFolder.connectedFolderRoot, trigger.watch.extensions);
  const watched = resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, trigger.watch.path);
  for (const child of connectedFolders) {
    if (child.id === connectedFolder.id) continue;
    const contains = (parent: string, childPath: string) => {
      const path = relative(resolve(parent), resolve(childPath));
      return !path || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    };
    if (!contains(connectedFolder.connectedFolderRoot, child.connectedFolderRoot)) continue;
    if (contains(watched, child.connectedFolderRoot) || contains(child.connectedFolderRoot, watched)) throw new Error("A watched folder cannot overlap another registered Connected Folder.");
  }
  const folderBefore = await lstat(watched);
  if (!folderBefore.isDirectory() || folderBefore.isSymbolicLink()) throw new Error("The watched folder must be an ordinary directory.");
  const resolution = await resolveFolderTargets(connectedFolder.connectedFolderRoot, [{ ...trigger.watch, role: "primary" }], {
    limits: { ...ampleFileAutomationFileObserverBounds },
  });
  const entries: Record<string, string> = Object.create(null);
  for (const file of resolution.files) {
    const info = await lstat(resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, file.path), { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("A watched file changed type during observation.");
    entries[file.path] = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  }
  const folderAfter = await lstat(resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, trigger.watch.path));
  if (folderAfter.dev !== folderBefore.dev || folderAfter.ino !== folderBefore.ino) throw new Error("The watched folder moved during observation.");
  const digest = createHash("sha256").update(JSON.stringify({ folder: [folderAfter.dev, folderAfter.ino], entries: Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)) })).digest("hex");
  return { digest, entries };
};

/**
 * A Connected Folder's own top level (declaration version 6): the ordinary files
 * directly in it with a watched extension. Subfolders are never entered, so
 * a nested Connected Folder is never read, and hidden AmpleFile, Pi, and Office
 * lock files are left out as everywhere else.
 */
async function observeTopLevel(connectedFolderRoot: string, extensions: readonly string[]): Promise<AmpleFileAutomationFileSnapshot> {
  const root = resolve(connectedFolderRoot);
  const folderBefore = await lstat(root);
  if (!folderBefore.isDirectory() || folderBefore.isSymbolicLink()) throw new Error("The watched folder must be an ordinary directory.");
  const wanted = new Set(extensions.map((extension) => extension.toLocaleLowerCase("en-US")));
  const entries: Record<string, string> = Object.create(null);
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".") || isAlwaysHiddenConnectedFolderEntry(entry.name)) continue;
    if (!wanted.has(extname(entry.name).toLocaleLowerCase("en-US"))) continue;
    if (++count > ampleFileAutomationFileObserverBounds.maxFiles) throw new Error(`The watched folder holds more than ${ampleFileAutomationFileObserverBounds.maxFiles} matching files.`);
    const info = await lstat(resolveConnectedFolderPath(root, entry.name), { bigint: true }).catch(() => null);
    if (!info?.isFile()) continue;
    entries[entry.name] = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  }
  const folderAfter = await lstat(root);
  if (folderAfter.dev !== folderBefore.dev || folderAfter.ino !== folderBefore.ino) throw new Error("The watched folder moved during observation.");
  const digest = createHash("sha256").update(JSON.stringify({ folder: [folderAfter.dev, folderAfter.ino], entries: Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)) })).digest("hex");
  return { digest, entries };
}

/**
 * Files a catch-up owes one run: added or changed while AmpleFile could not
 * watch the folder. A set, never a queue: every later gap merges into it, and
 * the run it starts lists the paths that still exist.
 */
export interface AmpleFileAutomationOwedCatchUp {
  reason: AutomationCatchUpReason;
  paths: string[];
  foundAt: string;
}

/**
 * What an automation that declares `"ifMissed": "run"` keeps between sessions
 * (src/local/automations/automation-file-snapshots.ts): the snapshot its
 * observer has accounted for, when it last started a run (so cooldown
 * survives a restart), any catch-up it still owes, and any new files that
 * arrived during an automation run and still wait for their follow-up run.
 */
export interface AmpleFileAutomationSavedFileState {
  snapshot: AmpleFileAutomationFileSnapshot;
  savedAt: string;
  lastTriggeredAt?: string;
  owed?: AmpleFileAutomationOwedCatchUp;
  arrived?: string[];
}

export interface AmpleFileAutomationFileWatchStatus {
  state: "starting" | "watching" | "paused" | "error";
  detail?: string;
  lastObservedAt?: string;
  lastTriggeredAt?: string;
  /** A catch-up found and waiting for the folder to settle, its cooldown, or other automation work. */
  catchingUp?: { reason: AutomationCatchUpReason; count: number };
  /** New files that arrived during an automation run, waiting for their follow-up run. */
  followingUp?: { count: number };
  /** When this session's watch last started a catch-up run. */
  lastCatchUpAt?: string;
  /** A plain sentence about the catch-up a person should know, such as why one could not happen. */
  notice?: string;
}

export interface AmpleFileAutomationFileWatchFiring {
  changedCount: number;
  changedPaths: string[];
  /** Present when the run includes files that changed while AmpleFile could not watch. */
  catchUp?: { reason: AutomationCatchUpReason; count: number };
  /** Present when the run is a follow-up: `count` new files arrived while an automation run was working. */
  followUp?: { count: number };
}

/** Why a saved snapshot cannot be compared: it may already contain an automation run's own edits. */
export const ampleFileAutomationDirtySnapshotNotice =
  "An automation was running when AmpleFile stopped watching, so it took a fresh look instead of catching up; files that changed in that gap were not caught up.";

/**
 * A snapshot entry in the observer's `dev:ino:size:mtime:ctime` form, split
 * into the file it names (device and inode) and its content (size and
 * modification time); null for any other form, which compares whole.
 */
function entryIdentity(value: string): { file: string; content: string } | null {
  const parts = value.split(":");
  return parts.length === 5 ? { file: `${parts[0]}:${parts[1]}`, content: `${parts[2]}:${parts[3]}` } : null;
}

function entryAt(snapshot: AmpleFileAutomationFileSnapshot, path: string): string | undefined {
  return Object.hasOwn(snapshot.entries, path) ? snapshot.entries[path] : undefined;
}

/**
 * What counts as a change, live and in a catch-up alike: a path counts when
 * it is new, or when its size or modification time differs. Device, inode,
 * and change-time differences alone are not enough — a remount, a sync
 * client, a Finder tag, or merely opening a file (macOS records when it was
 * last opened) can change those without changing the file. A file that only
 * has a new name does not count either: a path that appears with the same
 * device, inode, size, and modification time as a path that disappeared is
 * that file, renamed. Removed files never count. Entries that are not the
 * observer's form compare whole.
 */
export function ampleFileAutomationChangedPaths(
  before: AmpleFileAutomationFileSnapshot,
  after: AmpleFileAutomationFileSnapshot,
): string[] {
  const renamedFrom = new Set<string>();
  for (const [path, value] of Object.entries(before.entries)) {
    const identity = entryIdentity(value);
    if (identity && entryAt(after, path) === undefined) renamedFrom.add(`${identity.file}:${identity.content}`);
  }
  return Object.keys(after.entries)
    .filter((path) => {
      const now = after.entries[path]!;
      const was = entryAt(before, path);
      if (was !== undefined) return (entryIdentity(was)?.content ?? was) !== (entryIdentity(now)?.content ?? now);
      const identity = entryIdentity(now);
      return !identity || !renamedFrom.has(`${identity.file}:${identity.content}`);
    })
    .sort(comparePaths);
}

/**
 * What the first look after automation runs owes one follow-up run: the
 * changes (by the rule above) that are new files — no entry in the look
 * taken before the runs had their device and inode — and that no run placed.
 * An edit keeps its file's device and inode, and so does a rename, so
 * neither counts: either may be a run's own work that AmpleFile cannot tell
 * apart. Entries that are not the observer's form count only at a new path.
 */
export function ampleFileAutomationArrivedPaths(
  beforeRuns: AmpleFileAutomationFileSnapshot,
  after: AmpleFileAutomationFileSnapshot,
  placedByRuns: readonly string[],
): string[] {
  const files = new Set<string>();
  for (const value of Object.values(beforeRuns.entries)) {
    const identity = entryIdentity(value);
    if (identity) files.add(identity.file);
  }
  const placed = (path: string) => placedByRuns.some((item) => path === item || path.startsWith(`${item}/`));
  return ampleFileAutomationChangedPaths(beforeRuns, after).filter((path) => {
    if (placed(path)) return false;
    const identity = entryIdentity(after.entries[path]!);
    return identity ? !files.has(identity.file) : entryAt(beforeRuns, path) === undefined;
  });
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergePaths(...lists: readonly string[][]): string[] {
  return [...new Set(lists.flat())].sort(comparePaths);
}

/**
 * One automation's folder watch. Observation pauses while any automation run
 * works. When the runs end, the first look is compared with the look taken
 * before them, and the new files that arrived meanwhile and that no run
 * placed are owed one follow-up run; edits and renames made during the runs
 * are absorbed. A follow-up run's own pause owes nothing, so nothing chains.
 * Without catch-up (the default) a gap — quit, sleep, an observer error —
 * deliberately restarts from a baseline: changes in a gap never become
 * replayed authority. With `"ifMissed": "run"` the watch also compares its
 * first look after a gap with the saved snapshot and owes one coalesced run
 * for what was added or changed. Cross–Connected Folder handoffs belong in
 * one declared sequence.
 */
export class AmpleFileAutomationFileWatch {
  baseline?: AmpleFileAutomationFileSnapshot;
  candidate?: { snapshot: AmpleFileAutomationFileSnapshot; since: number };
  lastFired = -Infinity;
  status: AmpleFileAutomationFileWatchStatus = { state: "starting" };
  /** Declared `"ifMissed": "run"`: keeps a saved snapshot and catches up after a gap. */
  catchUp: boolean;
  /** The gap the next look should be compared across, when one is due. */
  pendingComparison?: AutomationCatchUpReason;
  /** The saved state: undefined until it has been read, null when there is nothing to compare with. */
  saved?: AmpleFileAutomationSavedFileState | null;
  /** The saved snapshot may predate an automation run's own edits, so it is never compared. */
  dirty = false;
  owed?: AmpleFileAutomationOwedCatchUp;
  /** New files that arrived while automation runs worked and that no run placed: one follow-up run. A set, never a queue. */
  arrived?: string[];
  lastTriggeredAt?: string;
  /** The look this watch had when observation paused for automation runs. */
  #beforeRuns?: AmpleFileAutomationFileSnapshot;
  /** The runs ended and the first look after them is due; the paths runs placed meanwhile. */
  #afterRuns?: { placed: string[] };
  #baselineAt = 0;

  constructor(options: { catchUp?: AutomationCatchUpReason } = {}) {
    this.catchUp = options.catchUp !== undefined;
    if (options.catchUp !== undefined) this.pendingComparison = options.catchUp;
  }

  /** A gap, or a fresh start: the next look is a baseline, with nothing compared across automation runs. */
  reset(paused = false): void {
    this.baseline = undefined;
    this.candidate = undefined;
    this.#beforeRuns = undefined;
    this.#afterRuns = undefined;
    this.status = { ...this.status, state: paused ? "paused" : "starting", detail: undefined };
  }

  /** An automation run started: observation pauses, keeping the look to compare the first look after the runs with. */
  pauseForRun(): void {
    this.#beforeRuns ??= this.baseline;
    this.baseline = undefined;
    this.candidate = undefined;
    this.status = { ...this.status, state: "paused", detail: undefined };
  }

  /**
   * The last automation run working ended. `placed` lists the paths in this
   * watch's Connected Folder that files acts and files steps placed during
   * the runs. `absorb` (a follow-up run was among them) drops the look from
   * before the runs, so the next look is a fresh baseline and nothing chains.
   */
  resumeAfterRuns(placed: readonly string[], absorb: boolean): void {
    if (absorb || !this.#beforeRuns) {
      this.#beforeRuns = undefined;
      this.#afterRuns = undefined;
    } else {
      this.#afterRuns = { placed: [...(this.#afterRuns?.placed ?? []), ...placed] };
    }
    this.baseline = undefined;
    this.candidate = undefined;
    this.status = { ...this.status, state: "starting", detail: undefined };
  }

  /** The first look after automation runs is still due; a run about to start takes it first. */
  get lookDueAfterRuns(): boolean {
    return this.#afterRuns !== undefined;
  }

  /** A gap began (sleep, an observer error): compare the next look with the saved snapshot. */
  expectGap(reason: AutomationCatchUpReason): void {
    if (this.catchUp) this.pendingComparison ??= reason;
  }

  /** Adopts what was saved before this watch existed; a no-op once loaded. */
  load(
    read: { state: AmpleFileAutomationSavedFileState | null; dirty: boolean; problem?: string },
    now: number,
  ): void {
    if (this.saved !== undefined) return;
    this.saved = read.state;
    this.dirty = read.dirty;
    if (!read.state) this.pendingComparison = undefined;
    if (read.problem) this.status = { ...this.status, notice: read.problem };
    const lastTriggeredAt = read.state?.lastTriggeredAt;
    if (lastTriggeredAt !== undefined && Number.isFinite(Date.parse(lastTriggeredAt))) {
      // A clock that moved backwards must not stretch the cooldown.
      this.lastFired = Math.max(this.lastFired, Math.min(Date.parse(lastTriggeredAt), now));
      this.lastTriggeredAt ??= lastTriggeredAt;
      this.status = { ...this.status, lastTriggeredAt: this.status.lastTriggeredAt ?? lastTriggeredAt };
    }
    if (read.state?.owed && !this.owed) this.owed = structuredClone(read.state.owed);
    if (read.state?.arrived && !this.arrived) this.arrived = [...read.state.arrived];
  }

  /** The changed paths feed `{{trigger.changedFiles}}`; the count is always the true one. */
  observe(
    snapshot: AmpleFileAutomationFileSnapshot,
    now: number,
    trigger: AmpleFileAutomationFilesChangedTrigger,
  ): AmpleFileAutomationFileWatchFiring | null {
    this.status = { ...this.status, state: "watching", detail: undefined, lastObservedAt: new Date(now).toISOString() };
    if (!this.baseline) {
      this.#compareWithSaved(snapshot, now);
      this.#compareAfterRuns(snapshot);
      this.#rebase(snapshot, now);
      return null;
    }
    if (snapshot.digest === this.baseline.digest) {
      this.candidate = undefined;
      if ((!this.owed && !this.arrived) || !this.#ready(now, this.#baselineAt, trigger)) return null;
      return this.#fire([], snapshot, now);
    }
    if (this.candidate?.snapshot.digest !== snapshot.digest) { this.candidate = { snapshot, since: now }; return null; }
    if (!this.#ready(now, this.candidate.since, trigger)) return null;
    const changed = ampleFileAutomationChangedPaths(this.baseline, snapshot);
    this.#rebase(snapshot, now);
    return this.#fire(changed, snapshot, now);
  }

  /**
   * An automation run is about to start before this watch made a due
   * comparison — a catch-up, or the first look after earlier runs: compare
   * now, before the run can edit anything, and keep what is owed for after
   * the run. This look is then the one the first look after this run is
   * compared with. The caller saves `snapshot` with the result.
   */
  compareBeforeRun(snapshot: AmpleFileAutomationFileSnapshot, now: number): void {
    // A catch-up compares only with a saved state that has been read.
    if (this.saved !== undefined) this.#compareWithSaved(snapshot, now);
    if (!this.#afterRuns) return;
    this.#compareAfterRuns(snapshot);
    this.#beforeRuns = snapshot;
  }

  /** What the saved state should hold for this snapshot. */
  stateToSave(snapshot: AmpleFileAutomationFileSnapshot, now: number): AmpleFileAutomationSavedFileState {
    return {
      snapshot,
      savedAt: new Date(now).toISOString(),
      ...(this.lastTriggeredAt !== undefined ? { lastTriggeredAt: this.lastTriggeredAt } : {}),
      ...(this.owed ? { owed: structuredClone(this.owed) } : {}),
      ...(this.arrived ? { arrived: [...this.arrived] } : {}),
    };
  }

  /** The status a person sees, with any catch-up or follow-up still waiting. */
  view(): AmpleFileAutomationFileWatchStatus {
    return {
      ...structuredClone(this.status),
      ...(this.owed ? { catchingUp: { reason: this.owed.reason, count: this.owed.paths.length } } : {}),
      ...(this.arrived ? { followingUp: { count: this.arrived.length } } : {}),
    };
  }

  fail(error: unknown): void {
    this.reset();
    this.expectGap("unavailable");
    this.status = { ...this.status, state: "error", detail: error instanceof Error ? error.message : "Folder observation failed." };
  }

  #ready(now: number, settledSince: number, trigger: AmpleFileAutomationFilesChangedTrigger): boolean {
    return now - settledSince >= trigger.debounceSeconds * 1000 && now - this.lastFired >= trigger.cooldownMinutes * 60_000;
  }

  #rebase(snapshot: AmpleFileAutomationFileSnapshot, now: number): void {
    this.baseline = snapshot;
    this.#baselineAt = now;
    this.candidate = undefined;
  }

  #compareWithSaved(snapshot: AmpleFileAutomationFileSnapshot, now: number): void {
    const reason = this.pendingComparison;
    this.pendingComparison = undefined;
    if (reason === undefined || !this.catchUp || !this.saved) return;
    if (this.dirty) {
      this.status = { ...this.status, notice: ampleFileAutomationDirtySnapshotNotice };
      return;
    }
    const found = ampleFileAutomationChangedPaths(this.saved.snapshot, snapshot);
    // What is still owed from an earlier gap stays owed while it exists.
    const stillOwed = (this.owed?.paths ?? []).filter((path) => entryAt(snapshot, path) !== undefined);
    const paths = mergePaths(stillOwed, found);
    this.owed = paths.length
      ? { reason: this.owed?.reason ?? reason, paths, foundAt: this.owed?.foundAt ?? new Date(now).toISOString() }
      : undefined;
    const { notice: _notice, ...status } = this.status;
    this.status = status;
  }

  #compareAfterRuns(snapshot: AmpleFileAutomationFileSnapshot): void {
    const before = this.#beforeRuns;
    const placed = this.#afterRuns?.placed;
    this.#beforeRuns = undefined;
    this.#afterRuns = undefined;
    if (!before || !placed) return;
    // What arrived during earlier runs stays owed while it exists.
    const stillOwed = (this.arrived ?? []).filter((path) => entryAt(snapshot, path) !== undefined);
    const paths = mergePaths(stillOwed, ampleFileAutomationArrivedPaths(before, snapshot, placed));
    this.arrived = paths.length ? paths : undefined;
  }

  #fire(changed: string[], snapshot: AmpleFileAutomationFileSnapshot, now: number): AmpleFileAutomationFileWatchFiring | null {
    let paths = changed;
    let catchUp: AmpleFileAutomationFileWatchFiring["catchUp"];
    let followUp: AmpleFileAutomationFileWatchFiring["followUp"];
    if (this.owed) {
      const present = this.owed.paths.filter((path) => entryAt(snapshot, path) !== undefined);
      if (present.length) {
        paths = mergePaths(paths, present);
        catchUp = { reason: this.owed.reason, count: present.length };
      }
      this.owed = undefined;
    }
    if (this.arrived) {
      const present = this.arrived.filter((path) => entryAt(snapshot, path) !== undefined);
      if (present.length) {
        paths = mergePaths(paths, present);
        followUp = { count: present.length };
      }
      this.arrived = undefined;
    }
    if (!paths.length) return null;
    const at = new Date(now).toISOString();
    this.lastFired = now;
    this.lastTriggeredAt = at;
    this.status.lastTriggeredAt = at;
    if (catchUp) {
      this.status.lastCatchUpAt = at;
      delete this.status.notice;
    }
    return {
      changedCount: paths.length,
      changedPaths: paths.slice(0, ampleFileAutomationBounds.maxChangedPathsRecorded),
      ...(catchUp ? { catchUp } : {}),
      ...(followUp ? { followUp } : {}),
    };
  }
}
