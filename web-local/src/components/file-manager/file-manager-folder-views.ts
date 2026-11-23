import { normalizeFileManagerSort, normalizeFileManagerView, type FileManagerSort, type FileManagerView } from "./file-manager-model";
import type { FileManagerLocation } from "./file-manager-places";

/**
 * Per-folder view settings: Icons or List and the sort are remembered for
 * each folder on this computer (in the window's local storage, never in the
 * folder), bounded, with the least recently chosen dropped first. A folder
 * with nothing remembered shows the person's last choice.
 */

/** Icons or List, and the sort, as one folder was last shown. */
export interface FolderViewSettings { view: FileManagerView; sort: FileManagerSort }

/** One remembered folder: its settings and when they were last chosen, so the oldest go first. */
export interface RememberedFolderView extends FolderViewSettings { at: number }

/** Folders whose view is remembered on this computer; past this the least recently chosen are dropped. */
export const folderViewLimit = 400;

/**
 * Where a folder's view is remembered: a Connected Folder by its portable id
 * and the path inside it, so a moved Connected Folder keeps its views; any
 * other folder by its path on disk. Null for the Trash and Recents, and for a
 * place whose folder on disk is not known.
 */
export function folderViewKey(location: FileManagerLocation, nativePath: string | null): string | null {
  if (location.place.kind === "connected-folder") return `connected-folder:${location.place.id}\0${location.path}`;
  return nativePath ? `path:${nativePath.replace(/[\\/]+$/, "") || "/"}` : null;
}

export function readFolderViews(parsed: unknown): Record<string, RememberedFolderView> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, RememberedFolderView> = {};
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || key.length > 8192) continue;
    const value = raw as { view?: unknown; sort?: unknown; at?: unknown };
    out[key] = { view: normalizeFileManagerView(value.view), sort: normalizeFileManagerSort(value.sort), at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0 };
  }
  return boundFolderViews(out, folderViewLimit);
}

/** One folder's settings remembered, the least recently chosen dropped past `limit`. */
export function rememberFolderView(views: Readonly<Record<string, RememberedFolderView>>, key: string, settings: FolderViewSettings, now: number, limit = folderViewLimit): Record<string, RememberedFolderView> {
  return boundFolderViews({ ...views, [key]: { view: settings.view, sort: settings.sort, at: now } }, limit);
}

function boundFolderViews(views: Record<string, RememberedFolderView>, limit: number): Record<string, RememberedFolderView> {
  const keys = Object.keys(views);
  if (keys.length <= limit) return views;
  const kept = keys.sort((a, b) => views[b]!.at - views[a]!.at).slice(0, limit);
  return Object.fromEntries(kept.map((key) => [key, views[key]!]));
}
