import { queueHistoryRequest } from "../../lib/history-queue";
import type { FileManagerPlace } from "./file-manager-places";

/**
 * One ⌘Z step: running it undoes the change and returns the entry that redoes
 * it. `cannot` says plainly why Undo can't put a change back (an item a
 * Replace sent to the Trash). `resumes` marks a step that keeps its place when
 * it is refused partway, so it stays on the stack and running it again goes
 * on from there.
 */
export interface FileUndo { label: string; run: () => Promise<FileUndo | null>; cannot?: string; resumes?: boolean }

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
  notRemoved?: readonly unknown[];
  leftInTarget?: readonly unknown[];
}

/**
 * How ⌘Z undoes a move a plain folder took part in, or null when History
 * alone undoes it: the items to move back; the restore points to run
 * afterwards, which are those of a Connected Folder the items went into when
 * they replaced something there or a copy stayed in both places; and whether
 * ⇧⌘Z can do the move again. A move that replaced something or merged folders
 * is not redone: what it replaced is back, and moving the items again would
 * not take away the folders the merge had emptied.
 */
export function moveBackPlan(answer: MoveAnswer, target: FileManagerPlace): { items: MovedItem[]; restores: MoveAnswer["restorePoints"]; redoable: boolean } | null {
  if (!undoneByMovingBack(answer.moves, target)) return null;
  const restores = target.kind === "connected-folder" && (answer.replaced?.length || answer.notRemoved?.length || answer.leftInTarget?.length) ? answer.restorePoints : [];
  return { items: movedItems(answer.moves!, target), restores, redoable: !answer.replaced?.length && !answer.merged?.length };
}

/**
 * The moves that put items back: one request for each folder they came from,
 * in the order the first item of each was moved, every item under the name
 * it had, and the folder made again when a merge emptied and removed it.
 */
export function moveBackRequests(items: readonly MovedItem[]): Array<{ body: TransferBody; items: MovedItem[] }> {
  const groups = new Map<string, { body: TransferBody; items: MovedItem[] }>();
  for (const item of items) {
    const slash = item.home.path.lastIndexOf("/");
    const parent = slash < 0 ? "" : item.home.path.slice(0, slash);
    const key = `${item.home.place.kind}\n${item.home.place.id}\n${parent}`;
    const group = groups.get(key) ?? { body: { mode: "move" as const, sources: [], target: { place: item.home.place, path: parent, create: true } }, items: [] };
    group.body.sources.push({ place: item.at.place, path: item.at.path, name: item.home.path.slice(slash + 1) });
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

/** What a move-back step asks of the window: one transfer, and one restore of a Connected Folder's restore point. */
export interface MoveBackHost {
  transfer: (body: TransferBody) => Promise<{ moves?: TransferMove[] }>;
  restore: (point: { connectedFolderId: string; checkpointId: string }) => Promise<unknown>;
}

/**
 * The ⌘Z step for a move a plain folder took part in. A plain folder has no
 * History, so each item is moved back to the folder it came from, under the
 * name it had, as a move of its own (out of a Connected Folder that is its
 * delete, refused while that Connected Folder has unfinished work).
 * `restores` are the restore points of a Connected Folder the items went
 * into, run afterwards: they bring back what the items replaced there and
 * take away a copy that stayed in both places.
 *
 * The step keeps its place: refused partway, it goes on from there when run
 * again. Its redo, when the move can be redone (`moveBackPlan`), moves the
 * items out again from where they went back to.
 */
export function movesUndo(
  label: string,
  items: readonly MovedItem[],
  restores: ReadonlyArray<{ connectedFolderId: string; checkpointId: string }>,
  redoable: boolean,
  host: MoveBackHost,
): FileUndo {
  let remaining = [...items];
  let pending = [...restores];
  const back: MovedItem[] = [];
  return {
    label,
    resumes: true,
    run: async () => {
      for (const request of moveBackRequests(remaining)) {
        const answer = await host.transfer(request.body);
        back.push(...movedBack(request.items, answer.moves));
        remaining = remaining.filter((item) => !request.items.includes(item));
      }
      while (pending.length) {
        await host.restore(pending[0]!);
        pending = pending.slice(1);
      }
      return redoable && back.length ? movesUndo(label, back, [], true, host) : null;
    },
  };
}
