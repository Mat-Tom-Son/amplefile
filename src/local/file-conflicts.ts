import type { Stats } from "node:fs";
import { lstat, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { untrackedFileOperation, type FileOperationControl } from "./file-operations.js";
import {
  claimWorkingPath,
  copyItemTo,
  freeDestination,
  isInside,
  placeFolderWithoutReplacing,
  placeWithoutReplacing,
  removeOwnedItem,
} from "./file-transfer.js";

/**
 * Name conflicts for copy, move, and Extract (docs/product-model.md, "The
 * file manager window"). Without a policy a taken name gets Finder's " copy"
 * naming, as it always has. With one, the caller first asks which names
 * clash (nothing is written), shows the person one dialog, and then runs the
 * operation with a choice for each clash or for all of them:
 *
 * - **keep-both**: the " copy" naming.
 * - **skip**: the item is left where it is.
 * - **replace**: the item takes the name and the one there goes where the
 *   place can recover it (a Connected Folder's restore point, else the
 *   system Trash; the result says when neither could keep it).
 * - **merge** (a folder onto a folder): the contents are combined, and each
 *   clash inside takes the `inside` choice, or the choice for all.
 *
 * A folder is never replaced by a file, or a file by a folder, unless that
 * item's own choice says replace; a choice for all keeps both instead.
 *
 * The work is planned first, then staged: new items are written in place,
 * and a replacement is written under a hidden working name beside the item
 * it replaces, so a cancel never touches what is there. The replacements are
 * committed last, each one disposing of the old item and only then taking
 * its name.
 */

export type ConflictChoice = "keep-both" | "skip" | "replace" | "merge";
export type InsideConflictChoice = "keep-both" | "skip" | "replace";

export interface ConflictPolicy {
  /** The choice for every clash without its own. Default: keep-both. */
  apply?: ConflictChoice;
  /** Choices for single clashes, by the `key` the check answered. */
  items?: Record<string, ConflictChoice>;
  /** Clashes inside a merged folder. Default: `apply` when it is keep-both, skip, or replace; else keep-both. */
  inside?: InsideConflictChoice;
}

const choices = new Set<ConflictChoice>(["keep-both", "skip", "replace", "merge"]);

/** Reads a request's `conflicts`: absent, `{ check: true }`, or a policy. */
export function parseConflictRequest(value: unknown): { check: boolean; policy: ConflictPolicy | null } {
  if (value === undefined || value === null) return { check: false, policy: null };
  const record = value as Record<string, unknown>;
  if (typeof record !== "object" || Array.isArray(record)) throw badRequest("Choose what happens when a name is taken.");
  if (record.check === true) return { check: true, policy: null };
  const policy: ConflictPolicy = {};
  if (record.apply !== undefined) {
    if (!choices.has(record.apply as ConflictChoice)) throw badRequest("Choose Keep Both, Skip, Replace, or Merge.");
    policy.apply = record.apply as ConflictChoice;
  }
  if (record.inside !== undefined) {
    if (record.inside !== "keep-both" && record.inside !== "skip" && record.inside !== "replace") throw badRequest("Choose Keep Both, Skip, or Replace for what clashes inside a merged folder.");
    policy.inside = record.inside;
  }
  if (record.items !== undefined) {
    if (!record.items || typeof record.items !== "object" || Array.isArray(record.items)) throw badRequest("Choose what happens to each item.");
    const items: Record<string, ConflictChoice> = {};
    for (const [key, choice] of Object.entries(record.items as Record<string, unknown>)) {
      if (!choices.has(choice as ConflictChoice)) throw badRequest("Choose Keep Both, Skip, Replace, or Merge.");
      items[key] = choice as ConflictChoice;
    }
    policy.items = items;
  }
  return { check: false, policy };
}

/** One side of a clash, as the dialog shows it. */
export interface ConflictItemSummary {
  kind: "file" | "folder" | "link" | "other";
  /** A file's size, or what a folder holds when counting it is quick; else null. */
  sizeBytes: number | null;
  modifiedAt: string;
}

/** A name the operation would take that is already taken. */
export interface TransferConflict {
  /** Pass back in `conflicts.items` to choose for this clash. */
  key: string;
  /** The taken name in the destination folder. */
  name: string;
  source: ConflictItemSummary;
  existing: ConflictItemSummary;
  /** Both are folders, so Merge is offered. */
  canMerge: boolean;
  /** For two folders: how many names inside them clash too, counted through folders that would merge; null when too many to count quickly. */
  insideClashes?: number | null;
}

/** An item the operation places: its path now and the name it is chosen by. */
export interface PlacementSource {
  source: string;
  key: string;
  /** The name it takes, when not its own (an extracted folder's working name). */
  name?: string;
}

/** One item to place, after the plan resolved its clash. */
export interface PlacementUnit {
  source: string;
  /** The name it takes, or the folder and name a keep-both copy starts from. */
  destination: string;
  action: "place" | "replace" | "skip";
  /** A taken name gets the " copy" naming (keep-both, or no policy). */
  duplicate: boolean;
  /**
   * Why an item is skipped: the person's choice, a Connected Folder identity
   * a merge never doubles, or an item a move finds already in its folder.
   */
  reason?: "chosen" | "identity" | "already-there";
  /** The top-level item it belongs to. */
  top: number;
}

export interface PlacementPlan {
  units: PlacementUnit[];
  /** Folders merged into one already there, outermost first. */
  merged: Array<{ source: string; destination: string; top: number }>;
  tops: Array<{ action: "place" | "replace" | "skip" | "merge"; destination: string }>;
}

/** Folders a merge never combines or replaces: a Connected Folder's identity stays its own. */
const identityFolders = new Set([".amplefile"]);

interface PlanOptions {
  /** Every item is a duplicate beside itself (⌘D). */
  duplicate?: boolean;
  /** A move carries `.amplefile`; a copy leaves it behind. */
  withIdentity?: boolean;
  /** A move: an item already in the folder stays as it is. */
  move?: boolean;
  /**
   * Whether an item already there may be replaced or merged into, for a place
   * with rules of its own (inside a nested Connected Folder, never). False
   * keeps both instead.
   */
  mayChange?: (existing: string) => Promise<boolean>;
}

/**
 * Plans where each item goes. No policy is today's behavior: every taken
 * name gets the " copy" naming. An item copied into its own folder is always
 * a duplicate beside itself.
 */
export async function planPlacements(
  items: readonly PlacementSource[],
  targetFolder: string,
  policy: ConflictPolicy | null,
  options: PlanOptions = {},
): Promise<PlacementPlan> {
  const plan: PlacementPlan = { units: [], merged: [], tops: [] };
  for (const [top, item] of items.entries()) {
    const destination = join(targetFolder, item.name ?? basename(item.source));
    const besideItself = resolve(dirname(item.source)) === resolve(targetFolder);
    if (options.move && besideItself && policy) {
      plan.units.push({ source: item.source, destination, action: "skip", duplicate: false, reason: "already-there", top });
      plan.tops.push({ action: "skip", destination });
      continue;
    }
    if (options.duplicate || besideItself || !policy) {
      plan.units.push({ source: item.source, destination, action: "place", duplicate: Boolean(options.duplicate || besideItself), top });
      plan.tops.push({ action: "place", destination });
      continue;
    }
    const explicit = policy.items?.[item.key];
    const choice = await resolveChoice(item.source, destination, explicit ?? policy.apply ?? "keep-both", explicit !== undefined, options);
    plan.tops.push({ action: choice === "keep-both" || choice === "free" ? "place" : choice, destination });
    if (choice === "merge") {
      plan.merged.push({ source: item.source, destination, top });
      await planMerge(item.source, destination, insideChoice(policy), top, plan, options);
    } else {
      plan.units.push(unitFor(item.source, destination, choice, top));
    }
  }
  return plan;
}

function insideChoice(policy: ConflictPolicy): InsideConflictChoice {
  if (policy.inside) return policy.inside;
  return policy.apply === "skip" || policy.apply === "replace" ? policy.apply : "keep-both";
}

function unitFor(source: string, destination: string, choice: "free" | "keep-both" | "skip" | "replace", top: number): PlacementUnit {
  if (choice === "skip") return { source, destination, action: "skip", duplicate: false, reason: "chosen", top };
  if (choice === "replace") return { source, destination, action: "replace", duplicate: false, top };
  return { source, destination, action: "place", duplicate: false, top };
}

/** The choice that applies to one item: "free" when nothing is there. */
async function resolveChoice(
  source: string,
  destination: string,
  choice: ConflictChoice,
  explicit: boolean,
  options: PlanOptions,
): Promise<"free" | ConflictChoice> {
  const existing = await lstat(destination).catch(() => null);
  if (!existing) return "free";
  const sourceInfo = await lstat(source);
  // The item itself, or a folder holding it, is never replaced or merged into.
  if (sameItem(sourceInfo, existing) || isInside(destination, source)) return "keep-both";
  if (choice === "skip" || choice === "keep-both") return choice;
  if (options.mayChange && !await options.mayChange(destination)) return "keep-both";
  const bothFolders = sourceInfo.isDirectory() && existing.isDirectory();
  if (choice === "merge") return bothFolders ? "merge" : "keep-both";
  // A folder for a file, or a file for a folder, only by that item's own choice.
  if (sourceInfo.isDirectory() !== existing.isDirectory() && !explicit) return "keep-both";
  return "replace";
}

async function planMerge(source: string, destination: string, inside: InsideConflictChoice, top: number, plan: PlacementPlan, options: PlanOptions): Promise<void> {
  for (const name of (await readdir(source)).sort()) {
    const child = join(source, name);
    const childDestination = join(destination, name);
    if (identityFolders.has(name)) {
      if (!options.withIdentity) continue;
      // A merge never doubles or replaces a Connected Folder's identity.
      if (await lstat(childDestination).catch(() => null)) {
        plan.units.push({ source: child, destination: childDestination, action: "skip", duplicate: false, reason: "identity", top });
        continue;
      }
    }
    const [childInfo, existing] = await Promise.all([lstat(child), lstat(childDestination).catch(() => null)]);
    if (existing && childInfo.isDirectory() && existing.isDirectory() && (!options.mayChange || await options.mayChange(childDestination))) {
      plan.merged.push({ source: child, destination: childDestination, top });
      await planMerge(child, childDestination, inside, top, plan, options);
      continue;
    }
    const choice = await resolveChoice(child, childDestination, inside, false, options);
    plan.units.push(unitFor(child, childDestination, choice === "merge" ? "keep-both" : choice, top));
  }
}

function sameItem(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The clashes an operation would meet, without writing anything. */
export async function findConflicts(items: readonly PlacementSource[], targetFolder: string, options: { duplicate?: boolean } = {}): Promise<TransferConflict[]> {
  if (options.duplicate) return [];
  const conflicts: TransferConflict[] = [];
  for (const item of items) {
    if (resolve(dirname(item.source)) === resolve(targetFolder)) continue;
    const name = item.name ?? basename(item.source);
    const conflict = await describeConflict(item.key, item.source, join(targetFolder, name));
    if (conflict) conflicts.push(conflict);
  }
  return conflicts;
}

/** A clash between `source` and whatever is at `destination`, or null when the name is free. */
export async function describeConflict(key: string, source: string, destination: string, sourceSummary?: ConflictItemSummary): Promise<TransferConflict | null> {
  const existing = await lstat(destination).catch(() => null);
  if (!existing) return null;
  const sourceInfo = await lstat(source);
  if (sameItem(sourceInfo, existing)) return null;
  const canMerge = sourceInfo.isDirectory() && existing.isDirectory();
  return {
    key,
    name: basename(destination),
    source: sourceSummary ?? await summarize(source, sourceInfo),
    existing: await summarize(destination, existing),
    canMerge,
    ...(canMerge ? { insideClashes: await countInsideClashes(source, destination) } : {}),
  };
}

/** How much a folder walk for a summary or a clash count may visit. */
const quickWalkEntries = 10_000;

export async function summarize(path: string, info?: Stats): Promise<ConflictItemSummary> {
  const item = info ?? await lstat(path);
  const kind = item.isSymbolicLink() ? "link" : item.isDirectory() ? "folder" : item.isFile() ? "file" : "other";
  let sizeBytes: number | null = item.isFile() ? item.size : null;
  if (kind === "folder") {
    const total = { bytes: 0, visited: 0 };
    sizeBytes = await folderBytes(path, total) ? total.bytes : null;
  }
  return { kind, sizeBytes, modifiedAt: item.mtime.toISOString() };
}

async function folderBytes(path: string, total: { bytes: number; visited: number }): Promise<boolean> {
  let names: string[];
  try { names = await readdir(path); } catch { return false; }
  for (const name of names) {
    if (++total.visited > quickWalkEntries) return false;
    const info = await lstat(join(path, name)).catch(() => null);
    if (!info) continue;
    if (info.isFile()) total.bytes += info.size;
    else if (info.isDirectory() && !await folderBytes(join(path, name), total)) return false;
  }
  return true;
}

async function countInsideClashes(source: string, destination: string): Promise<number | null> {
  const state = { clashes: 0, visited: 0 };
  return await countClashes(source, destination, state) ? state.clashes : null;
}

async function countClashes(source: string, destination: string, state: { clashes: number; visited: number }): Promise<boolean> {
  let names: string[];
  try { names = await readdir(source); } catch { return false; }
  for (const name of names) {
    if (identityFolders.has(name)) continue;
    if (++state.visited > quickWalkEntries) return false;
    const existing = await lstat(join(destination, name)).catch(() => null);
    if (!existing) continue;
    const child = await lstat(join(source, name)).catch(() => null);
    if (child?.isDirectory() && existing.isDirectory()) {
      if (!await countClashes(join(source, name), join(destination, name), state)) return false;
    } else {
      state.clashes += 1;
    }
  }
  return true;
}

// ---- carrying out a plan ----

/** What happened to an item that was replaced. */
export interface ReplacedItem {
  /** Where it was. */
  path: string;
  /**
   * Where it can be recovered from: the Connected Folder's restore point
   * (`history`), Recently Deleted (when History could not keep all of it),
   * the system Trash, or nowhere (`gone`, when the place has no Trash the
   * host can use).
   */
  recovery: "history" | "recently-deleted" | "trash" | "gone";
  entryId?: string;
  restoreBy?: string;
}

/** Takes the item at a path out of the way of its replacement. */
export type DisposeReplaced = (path: string) => Promise<ReplacedItem>;

export interface StagedUnit {
  unit: PlacementUnit;
  /** Where the item is now: its name for a placed one, its working name for a replacement not yet committed. */
  at: string | null;
  /** A move renamed it out of its source (it can be put back); a copy, or a move across disks, wrote it. */
  renamed: boolean;
  committed: boolean;
  release?: () => void;
}

export interface PlacementRun {
  mode: "copy" | "move";
  withIdentity?: boolean;
  operation?: FileOperationControl;
}

const replaceWorkingPrefix = ".AmpleFile-replace-";

/**
 * Writes one unit where it goes: a placed item under its name (or the
 * " copy" naming), a replacement under a working name beside the item it
 * replaces. A move renames on the same disk and copies across disks, taking
 * the source away only once the copy is whole. A cancel inside the copy
 * takes back what it wrote.
 */
export async function stageUnit(unit: PlacementUnit, run: PlacementRun): Promise<StagedUnit> {
  const operation = run.operation ?? untrackedFileOperation;
  if (unit.action === "skip") return { unit, at: null, renamed: false, committed: true };
  const folder = dirname(unit.destination);
  if (unit.action === "place") {
    if (run.mode === "move") {
      // Never onto an item that took the name meanwhile.
      try {
        const at = await placeStaged(unit.source, folder, basename(unit.destination));
        return { unit, at, renamed: true, committed: true };
      } catch (error) {
        if ((error as { code?: string }).code !== "EXDEV") throw error;
      }
      const destination = await freeDestination(folder, basename(unit.destination));
      await copyItemTo(unit.source, destination, { withIdentity: true, operation });
      await rm(unit.source, { recursive: true, force: true });
      return { unit, at: destination, renamed: false, committed: true };
    }
    const destination = await freeDestination(folder, basename(unit.destination), { duplicate: unit.duplicate });
    await copyItemTo(unit.source, destination, { withIdentity: run.withIdentity, operation });
    return { unit, at: destination, renamed: false, committed: true };
  }
  const working = claimWorkingPath(folder, replaceWorkingPrefix);
  try {
    if (run.mode === "move") {
      try {
        await rename(unit.source, working.path);
        return { unit, at: working.path, renamed: true, committed: false, release: working.release };
      } catch (error) {
        if ((error as { code?: string }).code !== "EXDEV") throw error;
      }
    }
    await copyItemTo(unit.source, working.path, { withIdentity: run.mode === "move" || run.withIdentity, operation });
    return { unit, at: working.path, renamed: false, committed: false, release: working.release };
  } catch (error) {
    working.release();
    throw error;
  }
}

/**
 * Commits a staged replacement: the item there is disposed of first, then the
 * replacement takes the name (or, should something take it meanwhile, the
 * " copy" naming). A move across disks takes the source away last.
 */
export async function commitUnit(staged: StagedUnit, dispose: DisposeReplaced, run: PlacementRun): Promise<{ at: string; replaced: ReplacedItem | null }> {
  if (staged.committed || staged.unit.action !== "replace" || !staged.at) return { at: staged.at ?? staged.unit.destination, replaced: null };
  const replaced = await lstat(staged.unit.destination).catch(() => null) ? await dispose(staged.unit.destination) : null;
  const at = await placeStaged(staged.at, dirname(staged.unit.destination), basename(staged.unit.destination));
  staged.release?.();
  staged.committed = true;
  staged.at = at;
  if (run.mode === "move" && !staged.renamed) await rm(staged.unit.source, { recursive: true, force: true });
  return { at, replaced };
}

/** Puts back a staged unit a cancel or failure stopped: a renamed one returns to its source, a written one is removed. */
export async function takeBackUnit(staged: StagedUnit): Promise<void> {
  if (!staged.at) return;
  try {
    if (staged.renamed) {
      if (!await lstat(staged.unit.source).catch(() => null)) await rename(staged.at, staged.unit.source);
    } else {
      await removeOwnedItem(staged.at);
    }
  } finally {
    staged.release?.();
  }
}

/** After a move, removes each merged source folder its items all left, deepest first. */
export async function removeEmptiedMergeSources(plan: PlacementPlan): Promise<void> {
  for (const merged of [...plan.merged].reverse()) await rmdir(merged.source).catch(() => undefined);
}

async function placeStaged(working: string, folder: string, name: string): Promise<string> {
  const info = await lstat(working);
  if (info.isDirectory()) return placeFolderWithoutReplacing(working, folder, name);
  if (info.isFile()) {
    const placed = await placeWithoutReplacing(working, folder, name);
    await rm(working, { force: true });
    return placed;
  }
  const destination = await freeDestination(folder, name);
  await rename(working, destination);
  return destination;
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400, statusCode: 400 });
}
