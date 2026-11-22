import { nativePathParts } from "./file-manager-model";

/**
 * The places the file manager window opens (docs/product-model.md,
 * "The file manager window"): a Connected Folder, one of the Standard
 * Folders (Desktop, Documents, Downloads, Pictures, the home folder, iCloud
 * Drive, and any folder added with +), or the computer place, which holds
 * every other folder on the computer under the Standard Folder rules
 * ("Other folders"). The host resolves each; the window names a place only
 * by its id and a path inside it.
 */
export type FileManagerPlace =
  | { kind: "connected-folder"; id: string }
  | { kind: "standard"; id: string };

export interface FileManagerLocation { place: FileManagerPlace; path: string }

/** A location the host resolved for the window to show (a folder handed to AmpleFile), with an item to select there. */
export interface FileManagerOpenRequest { id: number; location: FileManagerLocation; select: string | null }

/** The computer place: its top is the disk, so every folder on the computer is a path inside it. It has no sidebar row. */
export const computerPlace: FileManagerPlace = { kind: "standard", id: "computer" };
/** The disk's root, the computer place's top (AmpleFile runs on macOS and Linux). */
export const computerRoot = "/";

export function isComputerPlace(place: FileManagerPlace): boolean {
  return place.kind === "standard" && place.id === computerPlace.id;
}

/** The disk's name, as the path bar shows it: "Macintosh HD" on a Mac, "File System" on Linux. */
export function computerName(): string {
  return nativePathParts(computerRoot)[0] ?? computerRoot;
}

/** A place's folder on this computer joined with a path inside it. */
export function placeNativePath(root: string, path: string): string {
  const base = root.replace(/[\\/]+$/, "");
  return path ? `${base}/${path}` : base || computerRoot;
}

/**
 * The folder above a place's top, as an absolute path, for Command-Up and the
 * path bar: null at the disk itself, where there is nothing above.
 */
export function enclosingNativeFolder(root: string): string | null {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
  return parent || computerRoot;
}

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

/**
 * A place's file events. A Standard Folder's events leave out hidden entries
 * unless `includeHidden` asks for them, as its listing does; a Connected
 * Folder's cover everything already.
 */
export function placeEventsUrl(place: FileManagerPlace, path: string, options: { includeHidden?: boolean } = {}): string {
  const base = placeApiBase(place);
  if (place.kind === "connected-folder") return `${base}/file-events`;
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  if (options.includeHidden) query.set("includeHidden", "1");
  const search = query.toString();
  return `${base}/events${search ? `?${search}` : ""}`;
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
