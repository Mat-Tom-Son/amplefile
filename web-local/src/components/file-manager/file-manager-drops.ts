import type { TreeEntry } from "../../types";
import { parentPath } from "./file-manager-model";
import { canDropInto } from "./file-manager-layout";
import { samePlace, type FileManagerPlace } from "./file-manager-places";

/** Items dragged out of this window's list: where from, and when, so a drop much later is not taken for them. */
export interface InternalDrag { place: FileManagerPlace; paths: string[]; at: number }

/** A drag older than this is no longer this window's own. */
export const internalDragLifetimeMs = 60_000;

/**
 * The items a drop carries when they were dragged out of this window: the
 * window's own drag data must name the same items in the same place; the
 * desktop's drag (which carries files) is matched by their names.
 */
export function droppedInternalPaths(current: InternalDrag | null, now: number, dropped: { carried: unknown } | { names: readonly string[] }): string[] | null {
  if (!current || now - current.at > internalDragLifetimeMs) return null;
  if ("carried" in dropped) {
    const carried = dropped.carried as { place?: FileManagerPlace; paths?: unknown } | null;
    return carried && carried.place && samePlace(carried.place, current.place) && Array.isArray(carried.paths) && carried.paths.length === current.paths.length && carried.paths.every((path, index) => path === current.paths[index]) ? current.paths : null;
  }
  const dragged = current.paths.map((path) => path.slice(path.lastIndexOf("/") + 1));
  return dropped.names.length === dragged.length && dropped.names.every((name) => dragged.includes(name)) ? current.paths : null;
}

/**
 * Where a drop on the list lands: a folder row takes it, unless it is a link,
 * a Connected Folder nested here, or one of the items dragged; anywhere else
 * is the folder shown.
 */
export function listDropTarget(entry: TreeEntry | undefined, draggedHere: readonly string[], folderPath: string): string {
  return entry && entry.kind === "folder" && !entry.nestedFolder && !entry.link && canDropInto(entry.path, draggedHere) ? entry.path : folderPath;
}

/** Dropping items back where they already are does nothing. */
export function dropGoesNowhere(internal: InternalDrag | null, place: FileManagerPlace, target: string): boolean {
  return Boolean(internal && samePlace(internal.place, place) && internal.paths.every((path) => parentPath(path) === target || !canDropInto(target, [path])));
}
