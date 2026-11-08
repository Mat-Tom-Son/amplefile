/**
 * The places the file manager's sidebar opens (docs/product-model.md,
 * "The file manager window"): a Connected Folder, or one of the Standard
 * Folders (Desktop, Documents, Downloads, Pictures, the home folder, iCloud
 * Drive, and any folder added with +).
 */
export type FileManagerPlace =
  | { kind: "connected-folder"; id: string }
  | { kind: "standard"; id: string };

export interface FileManagerLocation { place: FileManagerPlace; path: string }

export interface StandardFolderSummary {
  id: string;
  name: string;
  root: string;
  /** Set when the folder is itself a registered Connected Folder. */
  connectedFolderId: string | null;
  /** A folder the person added with +, which Remove from Sidebar takes away. */
  added?: boolean;
}

export const standardFolderNames: Record<string, string> = { desktop: "Desktop", documents: "Documents", downloads: "Downloads", pictures: "Pictures", home: "Home", icloud: "iCloud Drive" };

export function placeKey(place: FileManagerPlace): string {
  return `${place.kind}:${place.id}`;
}

export function samePlace(left: FileManagerPlace, right: FileManagerPlace): boolean {
  return placeKey(left) === placeKey(right);
}

export function sameLocation(left: FileManagerLocation, right: FileManagerLocation): boolean {
  return samePlace(left.place, right.place) && left.path === right.path;
}

/** The local API routes for a place's files. */
export function placeApiBase(place: FileManagerPlace): string {
  return place.kind === "connected-folder"
    ? `/api/connected-folders/${encodeURIComponent(place.id)}`
    : `/api/standard-folders/${encodeURIComponent(place.id)}`;
}

export function placeEventsUrl(place: FileManagerPlace, path: string): string {
  const base = placeApiBase(place);
  if (place.kind === "connected-folder") return `${base}/file-events`;
  return `${base}/events${path ? `?path=${encodeURIComponent(path)}` : ""}`;
}

/**
 * Standard Folders that are not registered Connected Folders. A registered one is
 * listed with the other Connected Folders instead, so it is never shown twice.
 */
export function sidebarStandardFolders(
  folders: readonly StandardFolderSummary[],
  connectedFolders: ReadonlyArray<{ id: string }>,
): StandardFolderSummary[] {
  const registered = new Set(connectedFolders.map((connectedFolder) => connectedFolder.id));
  return folders.filter((folder) => !folder.connectedFolderId || !registered.has(folder.connectedFolderId));
}
