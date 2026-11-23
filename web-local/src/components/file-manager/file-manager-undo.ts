import { queueHistoryRequest } from "../../lib/history-queue";
import type { FileManagerPlace } from "./file-manager-places";

/** One ⌘Z step: running it undoes the change and returns the entry that redoes it. `cannot` says plainly why Undo can't put a change back (an item a Replace sent to the Trash). */
export interface FileUndo { label: string; run: () => Promise<FileUndo | null>; cannot?: string }

/** ⌘Z and ⇧⌘Z remember the last 50 changes each. */
export const fileUndoLimit = 50;

/** The stack with one more entry, the oldest dropped past the limit. */
export function pushUndo(stack: readonly FileUndo[], entry: FileUndo): FileUndo[] {
  return [...stack.slice(-(fileUndoLimit - 1)), entry];
}

/** A transfer's body, as /api/file-transfer takes it. */
export type TransferBody = { mode: "copy" | "move" | "duplicate"; sources: Array<{ place: FileManagerPlace; path: string } | { nativePath: string }>; target: { place: FileManagerPlace; path: string } };

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
