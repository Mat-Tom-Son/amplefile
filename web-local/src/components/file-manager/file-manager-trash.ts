import { formatCapacity } from "./file-manager-drives";
import type { FileManagerPlace } from "./file-manager-places";

/**
 * The system Trash in the file manager window (docs/product-model.md, "The
 * file manager window"): what the computer's Trash holds, from any app, with
 * Put Back, Delete Immediately, and Empty Trash. The last two are permanent,
 * so each asks first in a dialog that names what will be lost. AmpleFile's own
 * Recently Deleted, in Settings, is a different list.
 */

export interface TrashItem {
  id: string;
  name: string;
  originalPath: string | null;
  deletedAt: string | null;
  kind: "file" | "folder" | "link" | "other";
  sizeBytes: number | null;
  trash: "home" | "volume";
  volumePath: string | null;
  canPutBack: boolean;
  putBackNote?: string;
}

export interface TrashListing { items: TrashItem[]; truncated: boolean; putBackAvailable: boolean }

export interface PutBackResult {
  path: string;
  name: string;
  renamed: boolean;
  recreatedFolders: string[];
  location: { place: FileManagerPlace; path: string; select: string | null } | null;
  restorePoint: { connectedFolderId: string; checkpointId: string } | null;
}

export interface PermanentDeletionResult {
  removed: Array<{ id: string; name: string; originalPath: string | null }>;
  failed: Array<{ id: string; name: string; error: string }>;
  notFound: string[];
  strayRecordsRemoved?: number;
  /** Stop came first: `notDone` lists the ids still in the Trash. */
  cancelled?: true;
  notDone?: string[];
}

/** Sent on the window when something was just moved to the system Trash, so a Trash view already shown reads it again. */
export const trashChangedEvent = "amplefile:system-trash-changed";

/** The one line that tells the system Trash and AmpleFile's Recently Deleted apart. */
export const trashDifferenceText = "Items moved to the Trash from any app, including this window. Connected Folders and Chats AmpleFile removes go to Recently Deleted in Settings instead.";

export type TrashSortKey = "name" | "location" | "deleted" | "size";
export interface TrashSort { key: TrashSortKey; ascending: boolean }
export const defaultTrashSort: TrashSort = { key: "deleted", ascending: false };

/** Where an item was before it was deleted: its original folder, as a path a person reads. */
export function trashLocationText(item: TrashItem): string {
  if (!item.originalPath) return item.trash === "volume" && item.volumePath ? item.volumePath : "Unknown";
  const slash = item.originalPath.lastIndexOf("/");
  return slash > 0 ? item.originalPath.slice(0, slash) : "/";
}

export function trashSizeText(item: TrashItem): string {
  return item.sizeBytes === null ? "--" : formatCapacity(item.sizeBytes);
}

/** Items in the order the column headers ask, names breaking ties. */
export function sortTrashItems(items: readonly TrashItem[], sort: TrashSort): TrashItem[] {
  const direction = sort.ascending ? 1 : -1;
  const byName = (left: TrashItem, right: TrashItem) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
  const value = (item: TrashItem): number | string | null => sort.key === "deleted" ? (item.deletedAt ? Date.parse(item.deletedAt) : null)
    : sort.key === "size" ? item.sizeBytes
    : sort.key === "location" ? trashLocationText(item).toLocaleLowerCase()
    : null;
  return [...items].sort((left, right) => {
    if (sort.key === "name") return direction * byName(left, right);
    const a = value(left);
    const b = value(right);
    // Unknown dates and sizes sort last either way.
    if (a === null && b !== null) return 1;
    if (b === null && a !== null) return -1;
    if (a !== null && b !== null && a !== b) return direction * (a < b ? -1 : 1);
    return byName(left, right);
  });
}

export function nextTrashSort(current: TrashSort, key: TrashSortKey): TrashSort {
  if (current.key === key) return { key, ascending: !current.ascending };
  return { key, ascending: key === "name" || key === "location" };
}

/** Items whose name holds the search text (the toolbar's Search, while the Trash is shown). */
export function filterTrashItems(items: readonly TrashItem[], query: string): TrashItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? items.filter((item) => item.name.toLocaleLowerCase().includes(needle)) : [...items];
}

export interface PermanentConfirm { title: string; body: string; confirmLabel: string; tone: "danger" }

/** Delete Immediately's question: names the items, and says it cannot be undone. */
export function deleteImmediatelyConfirm(items: readonly TrashItem[]): PermanentConfirm {
  const one = items.length === 1 ? items[0]! : null;
  const named = one ? `“${one.name}”` : `${items.length.toLocaleString()} items`;
  const listed = one ? "" : ` (${items.slice(0, 3).map((item) => `“${item.name}”`).join(", ")}${items.length > 3 ? ", and more" : ""})`;
  return {
    title: one ? `Delete ${named} Immediately?` : `Delete ${named} Immediately?`,
    body: `${one ? named : `These ${named}${listed}`} will be deleted from the Trash for good. You can’t undo this.`,
    confirmLabel: "Delete Immediately",
    tone: "danger",
  };
}

/** Empty Trash's question: says how much is lost, everything in the Trash, and that it cannot be undone. */
export function emptyTrashConfirm(listing: Pick<TrashListing, "items" | "truncated">): PermanentConfirm {
  const count = listing.items.length;
  const total = listing.items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
  const counted = listing.truncated ? `more than ${count.toLocaleString()} items` : count === 1 ? "1 item" : `${count.toLocaleString()} items`;
  return {
    title: "Empty the Trash?",
    body: `Everything in the Trash (${counted}${total ? `, ${formatCapacity(total)}` : ""}) will be deleted for good, including items on connected drives. You can’t undo this.`,
    confirmLabel: "Empty Trash",
    tone: "danger",
  };
}

/**
 * The gate in front of every permanent deletion: the person's answer to the
 * question comes first, and nothing is sent unless it is yes.
 */
export async function confirmPermanent<T>(question: PermanentConfirm, ask: (question: PermanentConfirm) => Promise<boolean>, run: () => Promise<T>): Promise<T | null> {
  if (!(await ask(question))) return null;
  return run();
}

/** What the window says after Delete Immediately or Empty Trash: what went, and plainly what didn't. */
export function permanentResultMessage(result: PermanentDeletionResult, emptied: boolean): { text: string; tone: "success" | "error" } {
  const removed = result.removed.length;
  if (result.cancelled) {
    const left = result.notDone?.length ?? 0;
    return {
      text: removed
        ? `Stopped. ${removed === 1 ? `“${result.removed[0]!.name}” was` : `${removed.toLocaleString()} items were`} deleted for good; ${left ? `${left === 1 ? "1 item is" : `${left.toLocaleString()} items are`} still in the Trash` : "nothing else was"}.`
        : "Stopped. Nothing was deleted; everything is still in the Trash.",
      tone: "success",
    };
  }
  if (result.failed.length) {
    const first = result.failed[0]!;
    const others = result.failed.length - 1;
    return {
      text: `“${first.name}” couldn’t be deleted: ${first.error}${others ? ` ${others === 1 ? "1 other item" : `${others} other items`} couldn’t be deleted either.` : ""}`,
      tone: "error",
    };
  }
  if (emptied) return { text: "The Trash is empty.", tone: "success" };
  return { text: removed === 1 ? `Deleted “${result.removed[0]!.name}”` : `Deleted ${removed.toLocaleString()} items`, tone: "success" };
}

/** What Put Back says, naming a new name when the old one was taken. */
export function putBackMessage(result: PutBackResult, originalName: string): string {
  return result.renamed ? `Put back “${originalName}” as “${result.name}”` : `Put back “${result.name}”`;
}

/** Why Put Back is not offered for a selection, or null when it is. */
export function putBackBlocker(listing: Pick<TrashListing, "putBackAvailable"> | null, selection: readonly TrashItem[]): string | null {
  if (!selection.length) return null;
  if (listing && !listing.putBackAvailable) return selection[0]?.putBackNote ?? "Put items back from the Trash in the system file manager.";
  const blocked = selection.find((item) => !item.canPutBack);
  return blocked ? blocked.putBackNote ?? `“${blocked.name}” can’t be put back.` : null;
}
