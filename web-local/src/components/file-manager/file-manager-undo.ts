import { queueHistoryRequest } from "../../lib/history-queue";
import type { FileManagerPlace } from "./file-manager-places";

/**
 * One ⌘Z step: running it undoes the change and returns the entry that redoes
 * it, or a `PartialUndo` when it could not put everything back. `cannot`
 * says plainly why Undo can't put a change back (an item a Replace sent to
 * the Trash). `resumes` marks a step that keeps its place when it is refused
 * because work is still going on (`isBusyRefusal`), so it stays on the stack
 * and running it again goes on from there. Any other failure ends the step:
 * one that could never succeed must not block the changes under it.
 */
export interface FileUndo { label: string; run: () => Promise<FileUndo | PartialUndo | null>; cannot?: string; resumes?: boolean }

/**
 * What a step answers when it did only part of its work: `said` is what the
 * window says in place of "Undid …" (what did not go back, where it is, and
 * why), and `reverse` redoes the part that was done. The step is over: it
 * does not stay on the stack.
 */
export interface PartialUndo { said: string; reverse: FileUndo | null }

export function isPartialUndo(outcome: FileUndo | PartialUndo | null): outcome is PartialUndo {
  return Boolean(outcome) && "said" in outcome!;
}

/**
 * Whether a request was refused only because work is still going on (a
 * Connected Folder's turn, a question waiting, another change in hand): the
 * engine answers 409 with the code `busy`. The same request can succeed
 * later, which is the one reason a ⌘Z step keeps its place.
 */
export function isBusyRefusal(error: unknown): boolean {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  return status === 409 && code === "busy";
}

/** A raw error from the disk as it reads in a message: its code, what it was doing, and the path. */
const rawDiskError = /\bE[A-Z0-9]{3,}: [^,'\n]+(?:, [a-z]+)?(?: '([^'\n]*)')?(?: -> '[^'\n]*')?/g;

/** Why a request failed, as a sentence: the disk's own error codes and full paths are never shown. */
export function plainReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? "")).trim();
  const plain = text.replace(rawDiskError, (_whole, path: string | undefined) => path ? `the disk would not change “${path.slice(path.lastIndexOf("/") + 1)}”` : "the disk would not allow it");
  if (!plain) return "It could not be done.";
  const sentence = plain[0]!.toUpperCase() + plain.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** ⌘Z and ⇧⌘Z remember the last 50 changes each. */
export const fileUndoLimit = 50;

/** The stack with one more entry, the oldest dropped past the limit. */
export function pushUndo(stack: readonly FileUndo[], entry: FileUndo): FileUndo[] {
  return [...stack.slice(-(fileUndoLimit - 1)), entry];
}

/**
 * A transfer's body, as /api/file-transfer takes it. A source's `name` is the
 * name it takes in the target, and a move's target with `create` has its
 * missing folders made: Undo uses both to put an item back where it was.
 */
export type TransferBody = {
  mode: "copy" | "move" | "duplicate";
  sources: Array<{ place: FileManagerPlace; path: string; name?: string } | { nativePath: string }>;
  target: { place: FileManagerPlace; path: string; create?: boolean };
  /** `skip`: a source that is no longer there is left out and named in the answer, and the rest still go. */
  missing?: "skip";
};

/** A folder in a place. */
export interface FolderRef { place: FileManagerPlace; path: string }

/** The Connected Folders a transfer writes History in: its target's and its sources'. */
export function transferConnectedFolderIds(body: TransferBody): string[] {
  return [body.target.place, ...body.sources.map((source) => "place" in source ? source.place : null)]
    .flatMap((item) => item?.kind === "connected-folder" ? [item.id] : []);
}

/**
 * A request that writes History waits its turn in every Connected Folder it
 * touches, the way the History list's requests do, so the host never turns
 * one away for overlapping another.
 */
export function historyTurn<T>(connectedFolderIds: readonly string[], request: () => Promise<T>): Promise<T> {
  const ids = [...new Set(connectedFolderIds)].sort();
  return ids.reduceRight<() => Promise<T>>((next, id) => () => queueHistoryRequest(id, next), request)();
}

/** One item by its name, or how many there are, for messages and operation titles. */
export function transferLabel(paths: readonly string[]): string {
  if (paths.length !== 1) return `${paths.length} items`;
  const only = paths[0]!;
  return only.slice(Math.max(only.lastIndexOf("/"), only.lastIndexOf("\\")) + 1);
}

/** One item a move took out of its folder, as the engine's answer lists it: its path where it came from, and where it is in the target's place. */
export interface TransferMove { from: string; to: string; fromPlace?: FileManagerPlace }

/** An item a move left somewhere (`at`) that Undo puts back where it was (`home`). */
export interface MovedItem { at: { place: FileManagerPlace; path: string }; home: { place: FileManagerPlace; path: string } }

/** The items a move's answer says it moved, each with where it is now and where it came from. */
export function movedItems(moves: readonly TransferMove[], target: FileManagerPlace): MovedItem[] {
  return moves.map((move) => ({ at: { place: target, path: move.to }, home: { place: move.fromPlace ?? target, path: move.from } }));
}

/** An item a move left in both places: the original that could not leave its source, and its copy in the target. */
export interface KeptCopy { original: FolderRef; copy: FolderRef }

/** The parts of a move's answer that decide how ⌘Z undoes it. */
export interface MoveAnswer {
  /** Listed by every move that is undone by moving items back: between places, and between plain folders. */
  moves?: TransferMove[];
  restorePoints: Array<{ connectedFolderId: string; checkpointId: string }>;
  replaced?: readonly unknown[];
  merged?: readonly unknown[];
  notRemoved?: readonly string[];
  /** Each item in both places, with where its copy is. */
  copies?: readonly TransferMove[];
  leftInTarget?: readonly string[];
}

/**
 * How ⌘Z undoes a move whose items are moved back: the items; the restore
 * points to run afterwards (`restores`); whether ⇧⌘Z can do the move again;
 * the copies a restore point would take away, to be looked at first
 * (`copies`); and the copies Undo cannot take back (`leftCopies`).
 */
export interface MoveBackPlan {
  items: MovedItem[];
  restores: MoveAnswer["restorePoints"];
  redoable: boolean;
  /** Copies in a Connected Folder of items that are also still in their source: a restore point takes them away, but only while each original still holds what its copy does. */
  copies: KeptCopy[];
  /** Copies the move left in a plain folder of items that never left their source: no History takes them back. */
  leftCopies: { names: string[]; where: FolderRef } | null;
  /** Set on the plan ⇧⌘Z runs, so what it says is about doing the move again. */
  redo?: boolean;
}

/**
 * How ⌘Z undoes a move between places, or between plain folders, or null
 * when History alone undoes the change (a move inside one Connected Folder,
 * a copy). Each item goes back where it came from: a plain folder has no
 * History, and an item renamed out of a Connected Folder is the item
 * itself, with things History does not keep, so it is moved back, never
 * made again from a restore point. The restore points run afterwards are
 * the target Connected Folder's, when the move replaced something there or
 * a copy stayed in both places. A move that replaced something or merged
 * folders is not redone: what it replaced is back, and moving the items
 * again would not take away the folders the merge had emptied. Copies the
 * move left in a plain folder stay there, and Undo says so.
 */
export function moveBackPlan(answer: MoveAnswer, target: FolderRef): MoveBackPlan | null {
  if (!answer.moves) return null;
  const leftover = [...new Set([...(answer.notRemoved ?? []), ...(answer.leftInTarget ?? [])])];
  const inHistory = target.place.kind === "connected-folder";
  const restores = inHistory && (answer.replaced?.length || leftover.length)
    ? answer.restorePoints.filter((point) => point.connectedFolderId === target.place.id)
    : [];
  if (!answer.moves.length && !restores.length) return null;
  return {
    items: movedItems(answer.moves, target.place),
    restores,
    redoable: !answer.replaced?.length && !answer.merged?.length,
    copies: inHistory ? (answer.copies ?? []).map((kept) => ({ original: { place: kept.fromPlace ?? target.place, path: kept.from }, copy: { place: target.place, path: kept.to } })) : [],
    leftCopies: !inHistory && leftover.length ? { names: leftover.map(baseName), where: target } : null,
  };
}

/** The request that moves items back into one folder, and the items it is for. */
export interface MoveBackRequest { body: TransferBody & { conflicts: { apply: "skip" }; missing: "skip" }; items: MovedItem[] }

/**
 * The moves that put items back: one request for each folder they came from,
 * in the order the first item of each was moved, every item under the name
 * it had, and the folder made again when a merge emptied and removed it. An
 * item whose name is taken at home by now is skipped, never given another
 * name and never put in place of what is there: it stays where the move put
 * it, and Undo says so. An item that is no longer where the move put it
 * (renamed or removed since) is left out and named, and the rest still go.
 */
export function moveBackRequests(items: readonly MovedItem[]): MoveBackRequest[] {
  const groups = new Map<string, MoveBackRequest>();
  for (const item of items) {
    const parent = parentOf(item.home.path);
    const key = `${item.home.place.kind}\n${item.home.place.id}\n${parent}`;
    const group = groups.get(key) ?? { body: { mode: "move" as const, sources: [], target: { place: item.home.place, path: parent, create: true }, conflicts: { apply: "skip" as const }, missing: "skip" as const }, items: [] };
    group.body.sources.push({ place: item.at.place, path: item.at.path, name: baseName(item.home.path) });
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * After a request moved items back: the same items as a redo would move them
 * (now at home, to go where they were), for the ones the answer says moved.
 */
export function movedBack(items: readonly MovedItem[], answerMoves: readonly TransferMove[] | undefined): MovedItem[] {
  return items.flatMap((item) => {
    const move = answerMoves?.find((candidate) => candidate.from === item.at.path);
    return move ? [{ at: { place: item.home.place, path: move.to }, home: item.at }] : [];
  });
}

/** What the engine answers a move back with: what moved, and everything that did not go as asked. */
export interface MoveBackAnswer {
  moves?: TransferMove[];
  skipped?: Array<{ path: string; reason?: string }>;
  failed?: { path: string; error: string };
  failures?: Array<{ path: string; error: string }>;
  notRemoved?: string[];
  partlyRemoved?: Array<{ path: string; error: string }>;
  /** Sources that were no longer there. */
  missing?: Array<{ place: FileManagerPlace; path: string }>;
}

/**
 * One item a move back did not put back cleanly: it is `gone` from where
 * the move put it; its name was `taken` at home, so it stayed; it `failed`
 * and stayed; it went back but is in `both` places; or it went back and
 * `partly` could not be removed.
 */
export interface NotPutBack { item: MovedItem; why: "gone" | "taken" | "failed" | "both" | "partly"; error?: string }

/** The items of one request that did not go back cleanly, from its answer. An item the answer says nothing about stayed. */
export function notPutBack(items: readonly MovedItem[], answer: MoveBackAnswer): NotPutBack[] {
  const failures = answer.failures ?? (answer.failed ? [answer.failed] : []);
  return items.flatMap((item): NotPutBack[] => {
    const error = failures.find((failure) => failure.path === item.at.path)?.error;
    const partly = answer.partlyRemoved?.find((left) => left.path === item.at.path);
    if (answer.moves?.some((move) => move.from === item.at.path)) return partly ? [{ item, why: "partly", error: partly.error }] : [];
    if (answer.notRemoved?.includes(item.at.path)) return [{ item, why: "both", ...(error ? { error } : {}) }];
    if (answer.missing?.some((gone) => gone.path === item.at.path)) return [{ item, why: "gone" }];
    if (answer.skipped?.some((skipped) => skipped.path === item.home.path)) return [{ item, why: "taken" }];
    return [{ item, why: "failed", ...(error ? { error } : {}) }];
  });
}

/**
 * What a move-back step asks of the window: one transfer; one restore of a
 * Connected Folder's restore point; which copies, by position, no longer
 * match the originals they were made from; and a folder's name for what it
 * says.
 */
export interface MoveBackHost {
  transfer: (body: MoveBackRequest["body"]) => Promise<MoveBackAnswer>;
  restore: (point: { connectedFolderId: string; checkpointId: string }) => Promise<unknown>;
  copiesChanged: (copies: readonly KeptCopy[]) => Promise<number[]>;
  nameOf: (folder: FolderRef) => string;
}

/**
 * What ⌘Z (or ⇧⌘Z, with `redo`) says about the items that did not go back
 * cleanly: each by name, where it is now, and why. Items with the same
 * outcome between the same two folders share a sentence.
 */
export function moveBackReport(kept: readonly NotPutBack[], host: Pick<MoveBackHost, "nameOf">, redo = false): string[] {
  const groups = new Map<string, NotPutBack[]>();
  for (const one of kept) {
    const key = [one.why, one.item.home.place.kind, one.item.home.place.id, parentOf(one.item.home.path), one.item.at.place.kind, one.item.at.place.id, parentOf(one.item.at.path)].join("\n");
    groups.set(key, [...(groups.get(key) ?? []), one]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const many = group.length > 1;
    const who = quotedNames(group.map((one) => one.item.home.path));
    const home = host.nameOf({ place: first.item.home.place, path: parentOf(first.item.home.path) });
    const at = host.nameOf({ place: first.item.at.place, path: parentOf(first.item.at.path) });
    const error = group.find((one) => one.error)?.error;
    const why = error ? ` ${plainReason(error)}` : "";
    const not = redo ? "moved again" : "put back";
    const back = redo ? `${many ? "are" : "is"} in ${home} again` : `${many ? "are" : "is"} back in ${home}`;
    if (first.why === "gone") return `${who} ${many ? "were" : "was"} not ${not}: ${many ? "they are" : "it is"} no longer in ${at}.`;
    if (first.why === "taken") return `${who} ${many ? "were" : "was"} not ${not}: ${home} has ${many ? "items with those names" : "an item with that name"} now. ${many ? "They are" : "It is"} still in ${at}.`;
    if (first.why === "failed") return `${who} ${many ? "were" : "was"} not ${not} and ${many ? "are" : "is"} still in ${at}.${why}`;
    if (first.why === "both") return `${who} ${back}, and ${many ? "are" : "is"} also still in ${at}.${why}`;
    return `${who} ${back}, but part of ${many ? "them" : "it"} could not be removed from ${at} and is still there.${why}`;
  });
}

/**
 * The ⌘Z step for a move whose items are moved back (`moveBackPlan`). Each
 * item goes back to the folder it came from, under the name it had, as a
 * move of its own (out of a Connected Folder that is its delete, refused
 * while that Connected Folder has unfinished work). The plan's `restores`
 * are the restore points of a Connected Folder the items went into, run
 * afterwards: they bring back what the items replaced there and take away a
 * copy that stayed in both places.
 *
 * It never claims more than it did. An item that did not go back (it is no
 * longer where the move put it, its name is taken at home, or its move back
 * failed), or went back but is also still where the move put it, is said by
 * name with where it is and why, as a `PartialUndo`. The restore points are
 * run only when every item went back cleanly and every copy they would take
 * away still matches the original it was made from: otherwise one would
 * take an item, or the only copy of a change, away from the only folder
 * that has it. Copies the move left in a plain folder are said too.
 *
 * The step keeps its place only when a request is refused because work is
 * still going on (a busy Connected Folder): it goes on from there when run
 * again. Anything else that fails is said and the step ends, so one item
 * that can never go back does not block the changes under it. Its redo,
 * when the move can be redone, moves the items that went back out again.
 */
export function movesUndo(label: string, plan: MoveBackPlan, host: MoveBackHost): FileUndo {
  let remaining = [...plan.items];
  let pending = [...plan.restores];
  const back: MovedItem[] = [];
  const kept: NotPutBack[] = [];
  return {
    label,
    resumes: true,
    run: async () => {
      for (const request of moveBackRequests(remaining)) {
        let answer: MoveBackAnswer;
        try {
          answer = await host.transfer(request.body);
        } catch (error) {
          if (isBusyRefusal(error)) throw error;
          // Refused for good: these items stay where the move put them, and the rest still go.
          kept.push(...request.items.map((item): NotPutBack => ({ item, why: "failed", error: plainReason(error) })));
          remaining = remaining.filter((item) => !request.items.includes(item));
          continue;
        }
        back.push(...movedBack(request.items, answer.moves));
        kept.push(...notPutBack(request.items, answer));
        remaining = remaining.filter((item) => !request.items.includes(item));
      }
      const notes = moveBackReport(kept, host, plan.redo);
      if (pending.length) {
        const folder = host.nameOf({ place: { kind: "connected-folder", id: pending[0]!.connectedFolderId }, path: "" });
        const history = `its History has the restore point from before the move`;
        // A restore point takes copies away. Each is looked at first: its original must still hold what it does.
        const changed = kept.length || !plan.copies.length ? [] : await host.copiesChanged(plan.copies).catch(() => plan.copies.map((_copy, index) => index));
        if (kept.length) {
          notes.push(`Nothing else in ${folder} was changed back, so nothing there is taken away; ${history}.`);
        } else if (changed.length) {
          const names = quotedNames(changed.map((index) => plan.copies[index]!.copy.path));
          notes.push(`${names} in ${folder}, or the ${changed.length === 1 ? "original it was" : "originals they were"} copied from, changed since the move, so nothing in ${folder} was taken away; ${history}.`);
        } else {
          try {
            while (pending.length) {
              await host.restore(pending[0]!);
              pending = pending.slice(1);
            }
          } catch (error) {
            if (isBusyRefusal(error)) throw error;
            notes.push(`${folder} could not be put back as it was before the move. ${plainReason(error)} ${history[0]!.toUpperCase()}${history.slice(1)}.`);
          }
        }
      }
      if (plan.leftCopies) {
        const { names, where } = plan.leftCopies;
        notes.push(`The ${names.length === 1 ? "copy" : "copies"} of ${quotedNames(names)} that the move left in ${host.nameOf(where)} ${names.length === 1 ? "is" : "are"} still there.`);
      }
      const reverse = plan.redoable && back.length ? movesUndo(label, { items: back, restores: [], redoable: true, copies: [], leftCopies: null, redo: !plan.redo }, host) : null;
      if (!notes.length) return reverse;
      // Never "Undid …" alone when an item did not go back cleanly.
      const did = plan.redo ? "Redid" : "Undid";
      const wentHome = back.length + kept.filter((one) => one.why === "both").length;
      const lead = !kept.length ? `${did} ${label}.` : wentHome ? `${did} part of ${label}.` : `Could not ${plan.redo ? "redo" : "undo"} ${label}.`;
      return { said: [lead, ...notes].join(" "), reverse };
    },
  };
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Up to three names in quotes, then how many more. */
function quotedNames(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).map((path) => `“${baseName(path)}”`).join(", ");
  return `${shown}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;
}
