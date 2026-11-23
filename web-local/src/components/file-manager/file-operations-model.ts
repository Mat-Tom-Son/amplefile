import type { FileManagerPlace } from "./file-manager-places";

/**
 * The window's side of the transfer engine (src/local/file-operations.ts,
 * src/local/file-conflicts.ts): what a copy, move, Duplicate, Compress, or
 * Extract the window started is doing, what Stop left done and not done, and
 * how the person's answers to a name clash become the engine's choices.
 * Pure, so the rules are tested without a window (docs/product-model.md,
 * "Finder's file actions").
 */

/** `delete` is Empty Trash and Delete Immediately in the Trash view. */
export type FileOperationKind = "copy" | "duplicate" | "move" | "compress" | "extract" | "delete";
export type FileOperationStage = "preparing" | "copying" | "moving" | "removing" | "compressing" | "extracting" | "finishing";

export interface FileOperationProgress {
  operationId: string;
  kind: FileOperationKind;
  stage: FileOperationStage;
  itemsDone: number;
  itemsTotal: number | null;
  bytesDone: number;
  bytesTotal: number | null;
  current: string | null;
  cancellable: boolean;
  cancelling: boolean;
  startedAt: string;
}

export type FileOperationEvent =
  | { type: "operations"; operations: FileOperationProgress[] }
  | { type: "progress"; operation: FileOperationProgress }
  | { type: "finished"; operationId: string; kind: FileOperationKind; outcome: "succeeded" | "cancelled" | "failed"; error?: string };

export type ConflictChoice = "keep-both" | "skip" | "replace" | "merge";
export type InsideChoice = "keep-both" | "skip" | "replace";

export interface ConflictItemSummary { kind: "file" | "folder" | "link" | "other"; sizeBytes: number | null; modifiedAt: string }

export interface TransferConflict {
  key: string;
  name: string;
  source: ConflictItemSummary;
  existing: ConflictItemSummary;
  canMerge: boolean;
  insideClashes?: number | null;
}

export interface ConflictPolicy {
  apply?: ConflictChoice;
  items?: Record<string, ConflictChoice>;
  inside?: InsideChoice;
}

export type TransferRestorePoint = { connectedFolderId: string; checkpointId: string };

export interface ReplacedItem { path: string; recovery: "history" | "recently-deleted" | "trash" | "gone"; entryId?: string; restoreBy?: string }

/** The transfer engine's answer to a copy, move, Duplicate, paste, Compress, or Extract, every optional part included. */
export interface TransferAnswer {
  mode?: string;
  /** Compress and Extract: the new archive or folder, or null when nothing was made. */
  path?: string | null;
  written: string[];
  restorePoints: TransferRestorePoint[];
  copiedInstead?: boolean;
  moves?: Array<{ from: string; to: string; fromPlace?: FileManagerPlace }>;
  cancelled?: boolean;
  notDone?: string[];
  leftInTarget?: string[];
  replaced?: ReplacedItem[];
  skipped?: Array<{ path: string; reason: string }>;
  skippedClashes?: Array<{ path: string; reason: string }>;
  merged?: string[];
  failed?: { path: string; error: string };
  recentlyDeleted?: Array<{ path: string; entryId: string; restoreBy: string }>;
  conflicts?: TransferConflict[];
  // Paste through the desktop.
  nothing?: boolean;
  /** The items were cut in a window of this app or copied in this one, and pasted by place. */
  fromHere?: boolean;
  count?: number;
  moved?: boolean;
  cut?: boolean;
  /** Where the items pasted by place came from (a Cut in any window, or this window's Copy). */
  from?: { place: FileManagerPlace; paths: string[] } | null;
}

/** One operation the window started, as its operations area shows it. */
export interface WindowOperation {
  id: string;
  kind: FileOperationKind;
  /** What it is, in the person's words: "Copying 3 items to Documents". */
  title: string;
  /** When the window started it (ms), so a quick one never shows. */
  startedAt: number;
  progress: FileOperationProgress | null;
  /** Stop was pressed. */
  stopping: boolean;
}

/** A quick operation finishes before this and never shows its progress. */
export const operationShowAfterMs = 600;

/** Running operations the area shows: those older than the quick threshold, oldest first. */
export function visibleOperations(operations: readonly WindowOperation[], now: number): WindowOperation[] {
  return operations.filter((operation) => now - operation.startedAt >= operationShowAfterMs).sort((left, right) => left.startedAt - right.startedAt);
}

/** When the next hidden operation becomes visible, for a timer; null when none waits. */
export function nextOperationReveal(operations: readonly WindowOperation[], now: number): number | null {
  const waiting = operations.map((operation) => operation.startedAt + operationShowAfterMs - now).filter((wait) => wait > 0);
  return waiting.length ? Math.min(...waiting) : null;
}

/** An event from the engine applied to the window's operations; operations the window did not start are left out. */
export function applyOperationEvent(operations: readonly WindowOperation[], event: FileOperationEvent): readonly WindowOperation[] {
  if (event.type === "operations") {
    const byId = new Map(event.operations.map((item) => [item.operationId, item]));
    return operations.map((operation) => byId.has(operation.id) ? { ...operation, progress: byId.get(operation.id)! } : operation);
  }
  if (event.type === "progress") {
    return operations.map((operation) => operation.id === event.operation.operationId ? { ...operation, progress: event.operation, stopping: operation.stopping || event.operation.cancelling } : operation);
  }
  // A finished operation leaves when its request answers; the event only stops a stale bar from moving.
  return operations;
}

const stageWords: Record<FileOperationStage, string> = {
  preparing: "Preparing…",
  copying: "Copying",
  moving: "Moving",
  removing: "Removing the originals",
  compressing: "Compressing",
  extracting: "Extracting",
  finishing: "Finishing…",
};

/** How far along it is, 0–1, or null when the engine cannot tell (a tar Extract's item count, a quick rename move). */
export function operationFraction(progress: FileOperationProgress | null): number | null {
  if (!progress) return null;
  if (progress.stage === "finishing") return 1;
  if (progress.bytesTotal && progress.bytesTotal > 0) return Math.min(1, progress.bytesDone / progress.bytesTotal);
  if (progress.itemsTotal && progress.itemsTotal > 0) return Math.min(1, progress.itemsDone / progress.itemsTotal);
  return null;
}

/** The line under the title: the stage, the items and bytes, and the item in hand. */
export function operationDetail(operation: WindowOperation): string {
  const progress = operation.progress;
  if (operation.stopping) return progress && !progress.cancellable ? "Finishing…" : "Stopping…";
  if (!progress) return "Waiting to start…";
  // A deletion from the Trash is all removing: it says Deleting.
  const parts: string[] = [progress.kind === "delete" && progress.stage === "removing" ? "Deleting" : stageWords[progress.stage]];
  if (progress.stage !== "preparing" && progress.stage !== "finishing") {
    // Extract counts the archive's bytes read, not its items.
    if (progress.kind !== "extract") parts.push(progress.itemsTotal !== null ? `${progress.itemsDone.toLocaleString()} of ${countWord(progress.itemsTotal, "item")}` : countWord(progress.itemsDone, "item"));
    if (progress.bytesTotal !== null && progress.bytesTotal > 0) parts.push(`${formatSize(progress.bytesDone)} of ${formatSize(progress.bytesTotal)}`);
  }
  const line = parts.length > 1 ? `${parts[0]} ${parts.slice(1).join(" · ")}` : parts[0]!;
  return progress.current ? `${line} — ${progress.current}` : line;
}

/** Whether Stop is offered: not once it is finishing, nor for a move History makes as one rename. */
export function canStop(operation: WindowOperation): boolean {
  return !operation.stopping && (operation.progress?.cancellable ?? true);
}

/** The title an operation shows while it runs. */
export function operationTitle(kind: FileOperationKind, what: string, where: string | null): string {
  const verb = { copy: "Copying", duplicate: "Duplicating", move: "Moving", compress: "Compressing", extract: "Extracting", delete: "Deleting" }[kind];
  return where ? `${verb} ${what} to ${where}` : `${verb} ${what}`;
}

/**
 * After Stop: plainly, what was done and what was not, from the request's own
 * answer (`written`, `notDone`, `leftInTarget`, or no new archive or folder).
 */
export function stoppedMessage(kind: FileOperationKind, answer: TransferAnswer): string {
  if (kind === "compress") return "Stopped. No archive was made.";
  if (kind === "extract") return "Stopped. Nothing was extracted.";
  const done = answer.written.length;
  const notDone = answer.notDone?.length ?? 0;
  if (kind === "delete") {
    return done
      ? `Stopped. ${countWord(done, "item", true)} ${done === 1 ? "was" : "were"} deleted for good; ${notDone ? `${countWord(notDone, "item")} ${notDone === 1 ? "is" : "are"} still in the Trash` : "nothing else was"}.`
      : "Stopped. Nothing was deleted; everything is still in the Trash.";
  }
  const verb = kind === "move" && !answer.copiedInstead ? "moved" : kind === "duplicate" ? "duplicated" : "copied";
  const sentences: string[] = [];
  if (!done) sentences.push(`Stopped. Nothing was ${verb}.`);
  else sentences.push(`Stopped. ${countWord(done, "item", true)} ${done === 1 ? "was" : "were"} ${verb}${notDone ? `; ${countWord(notDone, "item")} ${notDone === 1 ? "was" : "were"} not` : ""}.`);
  if (kind === "move" && !answer.copiedInstead && notDone) sentences.push(`${notDone === 1 ? "It stays" : "They stay"} where ${notDone === 1 ? "it was" : "they were"}.`);
  if (answer.leftInTarget?.length) sentences.push(`${countWord(answer.leftInTarget.length, "copy", true)} could not be taken back and ${answer.leftInTarget.length === 1 ? "is" : "are"} also in the destination: ${names(answer.leftInTarget)}.`);
  return sentences.join(" ");
}

/**
 * What a Replace did with the items it took the place of: History keeps them
 * (⌘Z brings them back), Recently Deleted holds what History could not keep,
 * the system Trash holds them in a plain folder, or they are gone when no
 * Trash could take them. Skipped clashes are said too. Empty when neither.
 */
export function replacedMessage(answer: TransferAnswer): string {
  const sentences: string[] = [];
  const replaced = answer.replaced ?? [];
  const by = (recovery: ReplacedItem["recovery"]) => replaced.filter((item) => item.recovery === recovery).map((item) => item.path);
  const history = by("history");
  const recentlyDeleted = by("recently-deleted");
  const trash = by("trash");
  const gone = by("gone");
  if (history.length) sentences.push(`Replaced ${names(history)}. History keeps the old ${history.length === 1 ? "one" : "ones"}: Undo brings ${history.length === 1 ? "it" : "them"} back.`);
  if (recentlyDeleted.length) sentences.push(`Replaced ${names(recentlyDeleted)}. What History could not keep of the old ${recentlyDeleted.length === 1 ? "one" : "ones"} is in Recently Deleted.`);
  if (trash.length) sentences.push(`Replaced ${names(trash)}. The old ${trash.length === 1 ? "one is" : "ones are"} in the Trash.`);
  if (gone.length) sentences.push(`Replaced ${names(gone)}. No Trash could take the old ${gone.length === 1 ? "one" : "ones"}, so ${gone.length === 1 ? "it is" : "they are"} gone.`);
  const skipped = [...(answer.skipped ?? []), ...(answer.skippedClashes ?? [])];
  if (skipped.length) sentences.push(`Skipped ${countWord(skipped.length, "item")} with the same name.`);
  return sentences.join(" ");
}

/** Whether Undo can put back everything the operation changed: false when a Replace sent something to the Trash or it is gone. */
export function undoCovers(answer: TransferAnswer): { covered: boolean; why: string | null } {
  const replaced = answer.replaced ?? [];
  const trash = replaced.filter((item) => item.recovery === "trash");
  const gone = replaced.filter((item) => item.recovery === "gone");
  if (gone.length) return { covered: false, why: `Undo can’t bring back ${names(gone.map((item) => item.path))}: no Trash could take ${gone.length === 1 ? "it" : "them"}.` };
  if (trash.length) return { covered: false, why: `Undo can’t bring back ${names(trash.map((item) => item.path))} from the Trash. Put ${trash.length === 1 ? "it" : "them"} back from the Trash.` };
  return { covered: true, why: null };
}

/** The person's answer to one clash in the dialog. */
export interface ConflictDecision {
  key: string;
  choice: ConflictChoice;
  /** The rest of the clashes take this choice too. */
  applyToAll: boolean;
  /** For a folder merged into a folder: what happens to same-named items inside. */
  inside?: InsideChoice;
}

/**
 * The engine's choices from the dialog's answers, one clash at a time until
 * the person applies one to all. A choice made for one item names that item;
 * "apply to all" becomes the default for the rest, where the engine keeps
 * both for a clash it does not fit (Merge on a file, Replace between a file
 * and a folder), so a folder is never replaced by a file, or a file by a
 * folder, without being asked about by name.
 */
export function conflictPolicy(conflicts: readonly TransferConflict[], decisions: readonly ConflictDecision[]): ConflictPolicy {
  const items: Record<string, ConflictChoice> = {};
  let apply: ConflictChoice | undefined;
  let inside: InsideChoice | undefined;
  for (const decision of decisions) {
    if (!conflicts.some((conflict) => conflict.key === decision.key)) continue;
    items[decision.key] = decision.choice;
    if (decision.inside && decision.choice === "merge") inside ??= decision.inside;
    if (decision.applyToAll) { apply = decision.choice; break; }
  }
  return { ...(apply ? { apply } : {}), items, ...(inside ? { inside } : {}) };
}

/** Which clashes the dialog still asks about after these answers. */
export function remainingConflicts(conflicts: readonly TransferConflict[], decisions: readonly ConflictDecision[]): TransferConflict[] {
  if (decisions.some((decision) => decision.applyToAll)) return [];
  const answered = new Set(decisions.map((decision) => decision.key));
  return conflicts.filter((conflict) => !answered.has(conflict.key));
}

/** The choices a clash offers: Merge only between two folders. */
export function conflictChoices(conflict: TransferConflict): ConflictChoice[] {
  return conflict.canMerge ? ["keep-both", "skip", "replace", "merge"] : ["keep-both", "skip", "replace"];
}

export const conflictChoiceLabels: Record<ConflictChoice, string> = { "keep-both": "Keep Both", skip: "Skip", replace: "Replace", merge: "Merge" };

/** "A folder, 3.2 MB, modified 12 Mar 2026 at 14:02" for one side of a clash. */
export function conflictItemLine(item: ConflictItemSummary, formatDate: (iso: string) => string): string {
  const kind = { file: "A file", folder: "A folder", link: "A link", other: "An item" }[item.kind];
  const size = item.sizeBytes !== null && item.kind !== "link" ? `, ${formatSize(item.sizeBytes)}` : "";
  return `${kind}${size}, modified ${formatDate(item.modifiedAt)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function countWord(count: number, noun: string, capital = false): string {
  const plural = noun === "copy" ? "copies" : `${noun}s`;
  const text = `${count.toLocaleString()} ${count === 1 ? noun : plural}`;
  return capital ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function names(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).map((path) => `“${basename(path)}”`).join(", ");
  return `${shown}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;
}
