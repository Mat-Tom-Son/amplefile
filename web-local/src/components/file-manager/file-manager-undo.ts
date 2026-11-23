import { queueHistoryRequest } from "../../lib/history-queue";
import type { FileManagerPlace } from "./file-manager-places";

/**
 * One ⌘Z step: running it undoes the change and returns the entry that redoes
 * it, or a `PartialUndo` when it could not put everything back. `cannot`
 * says plainly why Undo can't put a change back (an item a Replace sent to
 * the Trash). `resumes` marks a step that keeps its place when it is refused
 * partway, so it stays on the stack and running it again goes on from there.
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

/**
 * Whether a move's answer is undone by moving its items back rather than by
 * History alone: the items went into a plain folder, or came out of one. A
 * plain folder has no History, so restore points put back only the Connected
 * Folder's side.
 */
export function undoneByMovingBack(moves: readonly TransferMove[] | undefined, target: FileManagerPlace): boolean {
  if (!moves?.length) return false;
  return target.kind === "standard" || moves.some((move) => (move.fromPlace ?? target).kind === "standard");
}

/** The parts of a move's answer that decide how ⌘Z undoes it. */
export interface MoveAnswer {
  moves?: TransferMove[];
  restorePoints: Array<{ connectedFolderId: string; checkpointId: string }>;
  replaced?: readonly unknown[];
  merged?: readonly unknown[];
  notRemoved?: readonly string[];
  leftInTarget?: readonly string[];
}

/**
 * How ⌘Z undoes a move a plain folder took part in: the items to move back;
 * the restore points to run afterwards (`restores`); whether ⇧⌘Z can do the
 * move again; and the copies Undo cannot take back (`leftCopies`).
 */
export interface MoveBackPlan {
  items: MovedItem[];
  restores: MoveAnswer["restorePoints"];
  redoable: boolean;
  /** Copies the move left in a plain folder of items that never left their source: no History takes them back. */
  leftCopies: { names: string[]; where: FolderRef } | null;
  /** Set on the plan ⇧⌘Z runs, so what it says is about doing the move again. */
  redo?: boolean;
}

/**
 * How ⌘Z undoes a move a plain folder took part in, or null when History
 * alone undoes it. The restore points are those of a Connected Folder the
 * items went into, when they replaced something there or a copy stayed in
 * both places. A move that replaced something or merged folders is not
 * redone: what it replaced is back, and moving the items again would not
 * take away the folders the merge had emptied. Copies the move left in a
 * plain folder stay there, and Undo says so.
 */
export function moveBackPlan(answer: MoveAnswer, target: FolderRef): MoveBackPlan | null {
  if (!undoneByMovingBack(answer.moves, target.place)) return null;
  const copies = [...new Set([...(answer.notRemoved ?? []), ...(answer.leftInTarget ?? [])])];
  const inHistory = target.place.kind === "connected-folder";
  return {
    items: movedItems(answer.moves!, target.place),
    restores: inHistory && (answer.replaced?.length || copies.length) ? answer.restorePoints : [],
    redoable: !answer.replaced?.length && !answer.merged?.length,
    leftCopies: !inHistory && copies.length ? { names: copies.map(baseName), where: target } : null,
  };
}

/** The request that moves items back into one folder, and the items it is for. */
export interface MoveBackRequest { body: TransferBody & { conflicts: { apply: "skip" } }; items: MovedItem[] }

/**
 * The moves that put items back: one request for each folder they came from,
 * in the order the first item of each was moved, every item under the name
 * it had, and the folder made again when a merge emptied and removed it. An
 * item whose name is taken at home by now is skipped, never given another
 * name and never put in place of what is there: it stays where the move put
 * it, and Undo says so.
 */
export function moveBackRequests(items: readonly MovedItem[]): MoveBackRequest[] {
  const groups = new Map<string, MoveBackRequest>();
  for (const item of items) {
    const parent = parentOf(item.home.path);
    const key = `${item.home.place.kind}\n${item.home.place.id}\n${parent}`;
    const group = groups.get(key) ?? { body: { mode: "move" as const, sources: [], target: { place: item.home.place, path: parent, create: true }, conflicts: { apply: "skip" as const } }, items: [] };
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
}

/**
 * One item a move back did not put back cleanly: its name was `taken` at
 * home, so it stayed; it `failed` and stayed; it went back but is in `both`
 * places; or it went back and `partly` could not be removed.
 */
export interface NotPutBack { item: MovedItem; why: "taken" | "failed" | "both" | "partly"; error?: string }

/** The items of one request that did not go back cleanly, from its answer. An item the answer says nothing about stayed. */
export function notPutBack(items: readonly MovedItem[], answer: MoveBackAnswer): NotPutBack[] {
  const failures = answer.failures ?? (answer.failed ? [answer.failed] : []);
  return items.flatMap((item): NotPutBack[] => {
    const error = failures.find((failure) => failure.path === item.at.path)?.error;
    const partly = answer.partlyRemoved?.find((left) => left.path === item.at.path);
    if (answer.moves?.some((move) => move.from === item.at.path)) return partly ? [{ item, why: "partly", error: partly.error }] : [];
    if (answer.notRemoved?.includes(item.at.path)) return [{ item, why: "both", ...(error ? { error } : {}) }];
    if (answer.skipped?.some((skipped) => skipped.path === item.home.path)) return [{ item, why: "taken" }];
    return [{ item, why: "failed", ...(error ? { error } : {}) }];
  });
}

/** What a move-back step asks of the window: one transfer, one restore of a Connected Folder's restore point, and a folder's name for what it says. */
export interface MoveBackHost {
  transfer: (body: MoveBackRequest["body"]) => Promise<MoveBackAnswer>;
  restore: (point: { connectedFolderId: string; checkpointId: string }) => Promise<unknown>;
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
    const why = error ? ` ${/[.!?]$/.test(error) ? error : `${error}.`}` : "";
    const not = redo ? "moved again" : "put back";
    const back = redo ? `${many ? "are" : "is"} in ${home} again` : `${many ? "are" : "is"} back in ${home}`;
    if (first.why === "taken") return `${who} ${many ? "were" : "was"} not ${not}: ${home} has ${many ? "items with those names" : "an item with that name"} now. ${many ? "They are" : "It is"} still in ${at}.`;
    if (first.why === "failed") return `${who} ${many ? "were" : "was"} not ${not} and ${many ? "are" : "is"} still in ${at}.${why}`;
    if (first.why === "both") return `${who} ${back}, and ${many ? "are" : "is"} also still in ${at}.${why}`;
    return `${who} ${back}, but part of ${many ? "them" : "it"} could not be removed from ${at} and is still there.${why}`;
  });
}

/**
 * The ⌘Z step for a move a plain folder took part in. A plain folder has no
 * History, so each item is moved back to the folder it came from, under the
 * name it had, as a move of its own (out of a Connected Folder that is its
 * delete, refused while that Connected Folder has unfinished work). The
 * plan's `restores` are the restore points of a Connected Folder the items
 * went into, run afterwards: they bring back what the items replaced there
 * and take away a copy that stayed in both places.
 *
 * It never claims more than it did. An item that did not go back (its name
 * is taken at home, or its move back failed), or went back but is also still
 * where the move put it, is said by name with where it is and why, as a
 * `PartialUndo`. Unless every item went back cleanly, the restore points are
 * not run: one would take an item that is still where the move put it away
 * from the only folder that has it. Copies the move left in a plain folder
 * are said too.
 *
 * The step keeps its place when a request is refused outright (a busy
 * Connected Folder): it goes on from there when run again. Its redo, when
 * the move can be redone, moves the items that went back out again.
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
        const answer = await host.transfer(request.body);
        back.push(...movedBack(request.items, answer.moves));
        kept.push(...notPutBack(request.items, answer));
        remaining = remaining.filter((item) => !request.items.includes(item));
      }
      const notes = moveBackReport(kept, host, plan.redo);
      if (!kept.length) {
        while (pending.length) {
          await host.restore(pending[0]!);
          pending = pending.slice(1);
        }
      } else if (pending.length) {
        const folder = host.nameOf({ place: { kind: "connected-folder", id: pending[0]!.connectedFolderId }, path: "" });
        notes.push(`Nothing else in ${folder} was changed back, so nothing there is taken away; its History has the restore point from before the move.`);
      }
      if (plan.leftCopies) {
        const { names, where } = plan.leftCopies;
        notes.push(`The ${names.length === 1 ? "copy" : "copies"} of ${quotedNames(names)} that the move left in ${host.nameOf(where)} ${names.length === 1 ? "is" : "are"} still there.`);
      }
      const reverse = plan.redoable && back.length ? movesUndo(label, { items: back, restores: [], redoable: true, leftCopies: null, redo: !plan.redo }, host) : null;
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
