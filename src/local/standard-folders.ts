import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  getConnectedFolderEntryInfo,
  getConnectedFolderFilePreview,
  listConnectedFolders,
  nestedRegisteredConnectedFolderPaths,
  resolveNestableFolderPath,
  resolveConnectedFolderPath,
  scanConnectedFolderTree,
  type TreeEntry,
  type ConnectedFolderEntryInfo,
  type ConnectedFolderFilePreview,
} from "./connected-folder.js";
import { isAlwaysHiddenConnectedFolderEntry } from "./connected-folder-ignore.js";
import { isSystemHiddenEntry } from "./hidden-entries.js";
import { entersMacDataVolume, macDataVolumeRefusal, usualMacPath, withoutMacDataVolumeName, isInsideMacDataVolume } from "./mac-data-volume.js";
import { ampleFileStateRoot } from "./state-paths.js";
import { linuxUserDirectories } from "./standard-folder-locations.js";

/**
 * Standard Folders (docs/product-model.md, "The file manager window"):
 * the person's Desktop, Documents, Downloads, Pictures, home folder, and
 * iCloud Drive, shown in the file manager's sidebar the way Finder shows them,
 * plus any folder the person added with the section's + button. The host
 * resolves each folder (from the home folder, or from the machine-local list
 * of added folders, which only the desktop folder picker writes); the renderer
 * names one only by id and a path inside it.
 *
 * A standard folder is not a Connected Folder. It has no Worker, History, or
 * `.amplefile/` record, and AmpleFile writes nothing into it except what the
 * person does by hand: rename, a new folder, Move to Trash (desktop), or
 * "Connect This Folder", which registers it. Anything inside a registered
 * Connected Folder belongs to that Connected Folder, so these routes refuse to change it
 * and the person uses it from the Connected Folders section instead.
 */
export const builtInStandardFolderIds = ["desktop", "documents", "downloads", "pictures", "home", "icloud"] as const;
export type BuiltInStandardFolderId = typeof builtInStandardFolderIds[number];
/**
 * The place for every other folder on this computer: its top is the disk's
 * root, so any folder is a path inside it. It has no sidebar row and follows
 * the Standard Folder rules (docs/product-model.md, "Other folders").
 */
export const computerFolderId = "computer";
/** A built-in place, the computer place, or a folder the person added (`added-` and 16 hex digits). */
export type StandardFolderId = BuiltInStandardFolderId | typeof computerFolderId | `added-${string}`;

const builtInFolders: Record<BuiltInStandardFolderId, { name: (home: string) => string; path: (home: string) => string }> = {
  desktop: { name: () => "Desktop", path: (home) => join(home, "Desktop") },
  documents: { name: () => "Documents", path: (home) => join(home, "Documents") },
  downloads: { name: () => "Downloads", path: (home) => join(home, "Downloads") },
  pictures: { name: () => "Pictures", path: (home) => join(home, "Pictures") },
  // The home folder goes by the person's account name, as in Finder.
  home: { name: (home) => basename(home) || "Home", path: (home) => home },
  icloud: { name: () => "iCloud Drive", path: (home) => join(home, "Library", "Mobile Documents", "com~apple~CloudDocs") },
};

export interface StandardFolderSummary {
  id: StandardFolderId;
  name: string;
  /** The folder on this computer, for Copy Path and nested Connected Folder matching. */
  root: string;
  /** Set when this folder is itself a registered Connected Folder; the sidebar then lists it there. */
  connectedFolderId: string | null;
  /** True for a folder the person added with +; only those can be removed from the sidebar. */
  added?: boolean;
}

interface AddedFolder { id: `added-${string}`; root: string; name: string }

export function isBuiltInStandardFolderId(value: unknown): value is BuiltInStandardFolderId {
  return typeof value === "string" && (builtInStandardFolderIds as readonly string[]).includes(value);
}

export function isStandardFolderId(value: unknown): value is StandardFolderId {
  return isBuiltInStandardFolderId(value) || value === computerFolderId || (typeof value === "string" && addedFolders().some((folder) => folder.id === value));
}

export function standardFolderRoot(id: StandardFolderId, home = homedir()): string {
  if (id === computerFolderId) return parse(resolve(home)).root;
  if (isBuiltInStandardFolderId(id)) {
    if (process.platform === "linux" && id !== "home" && id !== "icloud") {
      const configured = linuxUserDirectories(resolve(home))[id];
      if (configured) return configured;
    }
    return builtInFolders[id].path(resolve(home));
  }
  const added = addedFolders().find((folder) => folder.id === id);
  if (!added) throw Object.assign(new Error("That folder isn’t in the sidebar anymore."), { status: 404, statusCode: 404 });
  return added.root;
}

export function standardFolderName(id: StandardFolderId, home = homedir()): string {
  // The path bar's name for the disk (web-local file-manager-model.ts, nativePathParts).
  if (id === computerFolderId) return process.platform === "linux" ? "File System" : "Macintosh HD";
  if (isBuiltInStandardFolderId(id)) {
    if (process.platform === "linux" && id !== "home" && id !== "icloud") {
      const configured = linuxUserDirectories(resolve(home))[id];
      if (configured) return basename(configured);
    }
    return builtInFolders[id].name(resolve(home));
  }
  return addedFolders().find((folder) => folder.id === id)?.name ?? "Folder";
}

/** The standard folders that exist on this computer. Stat only: listing one's contents is what asks macOS for access. */
export async function listStandardFolders(
  connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<StandardFolderSummary[]> {
  const folders: StandardFolderSummary[] = [];
  const places = [
    ...builtInStandardFolderIds.filter(id => id !== "icloud" || platform === "darwin").map((id) => ({ id: id as StandardFolderId, name: standardFolderName(id, home), root: standardFolderRoot(id, home), added: false })),
    ...addedFolders().map((folder) => ({ ...folder, added: true })),
  ];
  for (const place of places) {
    // XDG points a disabled directory at HOME; keep just the Home sidebar row.
    if (platform === "linux" && place.id !== "home" && !place.added && samePath(place.root, resolve(home))) continue;
    // Looking inside ~/Library/Mobile Documents is what asks macOS for iCloud
    // access, so iCloud Drive is listed when that folder exists and asks only once opened.
    const probe = place.id === "icloud" ? dirname(place.root) : place.root;
    const info = await lstat(probe).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const registered = connectedFolders.find((connectedFolder) => samePath(connectedFolder.connectedFolderRoot, place.root));
    folders.push({ id: place.id, name: place.name, root: place.root, connectedFolderId: registered?.id ?? null, ...(place.added ? { added: true } : {}) });
  }
  return folders;
}

export interface StandardFolderScanOptions {
  /** Keep what the system file manager hides, each entry marked `hidden: true`. */
  includeHidden?: boolean;
  /** List symbolic links as entries carrying `link` (never followed). */
  includeLinks?: boolean;
  /** A higher entry bound for this one-level listing, up to `maxOneLevelTreeEntries`. */
  maxEntries?: number;
}

/**
 * One level of a standard folder, without what Finder hides (dotfiles, and
 * Library in the home folder) unless `includeHidden` asks for those, marked.
 * `.amplefile/`, `.pi/`, and the other always-hidden entries never appear.
 */
export async function scanStandardFolder(
  id: StandardFolderId,
  relativePath: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
  options: StandardFolderScanOptions = {},
): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
  const root = standardFolderRoot(id, home);
  const atHomeRoot = samePath(root, resolve(home)) && !relativePath.split("/").some((part) => part && part !== ".");
  try {
    const scan = await scanConnectedFolderTree(root, 0, relativePath, {
      includeIgnored: true,
      nestedFolderPaths: await nestedRegisteredConnectedFolderPaths(root),
      ...(options.includeLinks ? { includeLinks: true } : {}),
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
    });
    // Hidden means exactly what the default listing leaves out, so the
    // window's Show Hidden Files only ever adds rows and removes them again.
    const isHidden = (entry: TreeEntry) => !isShownStandardEntry(entry.name) || (platform === "darwin" && atHomeRoot && entry.name === "Library");
    return {
      tree: scan.entries
        .filter((entry) => options.includeHidden || !isHidden(entry))
        .map(({ children: _children, ...entry }) => options.includeHidden && isHidden(entry) ? { ...entry, hidden: true as const } : entry),
      truncated: scan.truncated,
    };
  } catch (error) {
    throw accessError(error, id);
  }
}

export async function standardFolderEntryInfo(id: StandardFolderId, relativePath: string, home = homedir()): Promise<ConnectedFolderEntryInfo> {
  // Downloads holds multi-gigabyte installers; the Info panel never waits on a hash.
  try {
    const base = standardFolderPathBase(id, relativePath, home);
    if (!base) throw badRequest("A path inside the folder is required.");
    const info = await getConnectedFolderEntryInfo(base.root, base.path, { hash: false });
    return base.prefix ? { ...info, path: [base.prefix, info.path].filter(Boolean).join("/") } : info;
  } catch (error) {
    throw accessError(error, id);
  }
}

/** Space's Preview of a file in a standard folder: the same bounded read and kinds as a Connected Folder's file-preview. */
export async function standardFolderFilePreview(id: StandardFolderId, relativePath: string, home = homedir()): Promise<ConnectedFolderFilePreview> {
  try {
    const base = standardFolderPathBase(id, relativePath, home);
    if (!base) throw badRequest("A path inside the folder is required.");
    return await getConnectedFolderFilePreview(base.root, base.path);
  } catch (error) {
    throw accessError(error, id);
  }
}

/** The file for a path inside a standard folder, under the same path policy as a Connected Folder's. */
export function resolveStandardFolderPath(id: StandardFolderId, relativePath: string, home = homedir(), options: { finalLink?: boolean } = {}): string {
  const base = standardFolderPathBase(id, relativePath, home);
  return base ? resolveConnectedFolderPath(base.root, base.path, options) : standardFolderRoot(id, home);
}

/**
 * Where a place's path is resolved under the Connected Folder path policy: the
 * place's own folder and the path inside it. That policy never takes the
 * disk's root as a folder, so the computer place resolves a path from its
 * first folder ("home/ana/Notes" is "ana/Notes" inside "/home", with "home"
 * as the prefix that puts it back). Null for the computer place's top, the
 * disk itself, which only its listing and the watcher read.
 */
export function standardFolderPathBase(
  id: StandardFolderId,
  relativePath: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): { root: string; path: string; prefix: string } | null {
  if (id !== computerFolderId) return { root: standardFolderRoot(id, home), path: relativePath, prefix: "" };
  if (relativePath.includes("\0") || relativePath.startsWith("/") || relativePath.startsWith("\\")) throw badRequest("Path escapes the selected folder.");
  const parts = relativePath.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw badRequest("Path escapes the selected folder.");
  const first = parts[0];
  if (!first) return null;
  if (entersMacDataVolume(parts, platform)) throw badRequest(macDataVolumeRefusal);
  if (isAlwaysHiddenConnectedFolderEntry(first)) throw badRequest("Path selects reserved .amplefile, .work-fold, or .pi metadata.");
  const root = join(standardFolderRoot(id, home), first);
  // The first folder is the policy's root, which it checks only for being a link; say so the way a deeper link is refused.
  // A link at the disk's top itself (`/bin`) is only opened, revealed, or copied as a path.
  if (lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw badRequest("Paths cannot traverse symbolic links or junctions.");
  return { root, path: parts.slice(1).join("/"), prefix: first };
}

/**
 * Refuses a change to anything a registered Connected Folder owns: the standard
 * folder itself when it is registered, a registered folder inside it, or
 * anything inside one. Those changes go through the Connected Folder, which keeps
 * History for them. Renaming or trashing a folder that holds a Connected Folder
 * would carry it along, so that is refused too; adding a folder next to one
 * (`allowContaining`) is not.
 */
export async function assertStandardFolderPathUnowned(
  id: StandardFolderId,
  relativePath: string,
  home = homedir(),
  options: { allowContaining?: boolean; finalLink?: boolean } = {},
): Promise<string> {
  const target = resolveStandardFolderPath(id, relativePath, home, { finalLink: options.finalLink === true });
  for (const connectedFolder of await listConnectedFolders()) {
    if (pathContains(connectedFolder.connectedFolderRoot, target) || (!options.allowContaining && pathContains(target, connectedFolder.connectedFolderRoot))) {
      throw Object.assign(
        new Error(`${connectedFolder.name} is a Connected Folder. Open it from the Connected Folders section to change it, so History keeps the change.`),
        { status: 409, statusCode: 409 },
      );
    }
  }
  return target;
}

export async function renameStandardFolderEntry(id: StandardFolderId, relativePath: string, newName: string, home = homedir()): Promise<{ path: string }> {
  if (!relativePath.trim()) throw badRequest(`${standardFolderName(id, home)} itself can’t be renamed.`);
  // A symbolic link is renamed as itself.
  const source = await assertStandardFolderPathUnowned(id, relativePath, home, { finalLink: true });
  const name = validEntryName(newName);
  if (name === basename(source)) return { path: toRelative(id, source, home) };
  const destination = join(dirname(source), name);
  await assertStandardFolderPathUnowned(id, toRelative(id, destination, home), home, { allowContaining: true, finalLink: true });
  const existing = await lstat(destination).catch(() => null);
  // A case-only rename on a case-insensitive disk finds the source itself.
  const sameItem = existing && name.toLocaleLowerCase() === basename(source).toLocaleLowerCase();
  if (existing && !sameItem) throw conflict(`An item named “${name}” already exists here.`);
  try {
    await rename(source, destination);
  } catch (error) {
    throw accessError(error, id);
  }
  return { path: toRelative(id, destination, home) };
}

export async function createStandardFolderFolder(id: StandardFolderId, parentPath: string, folderName: string, home = homedir()): Promise<{ path: string }> {
  const parent = await assertStandardFolderPathUnowned(id, parentPath, home, { allowContaining: true });
  const name = validEntryName(folderName);
  const destination = join(parent, name);
  if (await lstat(destination).catch(() => null)) throw conflict(`An item named “${name}” already exists here.`);
  try {
    await mkdir(destination);
  } catch (error) {
    throw accessError(error, id);
  }
  return { path: toRelative(id, destination, home) };
}

/** The folder "Connect This Folder" registers: the standard folder itself, or a folder inside it. */
export async function standardFolderRegistrationTarget(id: StandardFolderId, relativePath: string, home = homedir()): Promise<string> {
  if (id === computerFolderId) {
    const base = standardFolderPathBase(id, relativePath, home);
    if (!base) throw badRequest("The whole disk can’t be a Connected Folder. Choose a folder on it.");
    if (base.path) return resolveNestableFolderPath(base.root, base.path);
    const info = await lstat(base.root).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error("That folder isn’t on this computer anymore."), { status: 404, statusCode: 404 });
    return base.root;
  }
  const root = standardFolderRoot(id, home);
  if (relativePath.split("/").filter((part) => part && part !== ".").length) return resolveNestableFolderPath(root, relativePath);
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error(`${standardFolderName(id, home)} isn’t on this computer.`), { status: 404, statusCode: 404 });
  return root;
}

/** Shown in a default Standard Folder listing: not hidden by the system file manager's rules (outside the home folder's Library), and never an always-hidden entry. */
export function isShownStandardEntry(name: string): boolean {
  return Boolean(name) && !isSystemHiddenEntry(name, { platform: process.platform, atHomeFolder: false }) && !isAlwaysHiddenConnectedFolderEntry(name);
}

/** macOS answers EPERM until the person allows AmpleFile into Desktop, Documents, Downloads, Pictures, or iCloud Drive. */
export function accessError(error: unknown, id: StandardFolderId): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EPERM" || code === "EACCES") {
    // In the computer place, name the folder refused (Node puts it on the error), not the disk.
    const refused = id === computerFolderId ? (error as { path?: unknown }).path : null;
    const name = typeof refused === "string" && refused ? `“${basename(refused) || refused}”` : standardFolderName(id);
    return Object.assign(
      new Error(id === computerFolderId && process.platform !== "darwin"
        ? `You don’t have permission to use ${name}.`
        : `AmpleFile isn’t allowed to open ${name}. Allow it in System Settings → Privacy & Security → Files and Folders.`),
      { status: 403, statusCode: 403 },
    );
  }
  return error;
}

/**
 * The folders the person added to the sidebar with +, kept on this computer
 * only. The desktop app's folder picker adds one; Remove from Sidebar takes
 * one away. Removing never touches the folder.
 */
export function addedFoldersFile(): string {
  return join(ampleFileStateRoot(), "sidebar-folders.json");
}

let addedFoldersCache: { mtimeMs: number; folders: AddedFolder[] } | null = null;

function addedFolders(): AddedFolder[] {
  const file = addedFoldersFile();
  let mtimeMs: number;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return []; }
  if (addedFoldersCache?.mtimeMs === mtimeMs) return addedFoldersCache.folders;
  let folders: AddedFolder[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; folders?: unknown };
    if (parsed.version === 1 && Array.isArray(parsed.folders)) {
      folders = parsed.folders.filter((item): item is AddedFolder => typeof item === "object" && item !== null
        && typeof (item as AddedFolder).id === "string" && /^added-[0-9a-f]{16}$/.test((item as AddedFolder).id)
        && typeof (item as AddedFolder).root === "string" && (item as AddedFolder).root.startsWith(sep)
        && typeof (item as AddedFolder).name === "string")
        // One kept by the Mac data volume's second name is used under its usual one, or left out when it has none.
        .map((item) => ({ ...item, root: withoutMacDataVolumeName(item.root) }))
        .filter((item) => !isInsideMacDataVolume(item.root));
    }
  } catch { folders = []; }
  addedFoldersCache = { mtimeMs, folders };
  return folders;
}

function writeAddedFolders(folders: AddedFolder[]): void {
  const file = addedFoldersFile();
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, folders }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  addedFoldersCache = null;
}

/** Adds a folder the person chose in the folder picker; a folder already in the sidebar is returned as it is. */
export function addSidebarFolder(folderPath: string, home = homedir()): { id: StandardFolderId; name: string } {
  // A folder chosen by the Mac data volume's second name is kept under its usual one (mac-data-volume.ts).
  const root = usualMacPath(resolve(folderPath));
  const info = statSync(root, { throwIfNoEntry: false });
  if (!info?.isDirectory()) throw badRequest("Choose a folder.");
  for (const id of builtInStandardFolderIds) {
    if (samePath(standardFolderRoot(id, home), root)) return { id, name: standardFolderName(id, home) };
  }
  const existing = addedFolders().find((folder) => samePath(folder.root, root));
  if (existing) return { id: existing.id, name: existing.name };
  const folder: AddedFolder = {
    id: `added-${createHash("sha256").update(comparisonPath(root)).digest("hex").slice(0, 16)}`,
    root,
    name: basename(root) || root,
  };
  writeAddedFolders([...addedFolders(), folder]);
  return { id: folder.id, name: folder.name };
}

/** Remove from Sidebar: only a folder the person added, and never the folder itself. */
export function removeSidebarFolder(id: string): void {
  if (isBuiltInStandardFolderId(id)) throw badRequest("Built-in folders stay in the sidebar.");
  const folders = addedFolders();
  if (!folders.some((folder) => folder.id === id)) throw Object.assign(new Error("That folder isn’t in the sidebar anymore."), { status: 404, statusCode: 404 });
  writeAddedFolders(folders.filter((folder) => folder.id !== id));
}

function validEntryName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === "..") throw badRequest("Enter a name.");
  if (/[/\\\0:]/.test(name)) throw badRequest("A name can’t contain / \\ or :.");
  if (name.startsWith(".")) throw badRequest("A name can’t start with a period.");
  if (Buffer.byteLength(name, "utf8") > 255) throw badRequest("That name is too long.");
  if (isAlwaysHiddenConnectedFolderEntry(name)) throw badRequest("That name is reserved.");
  return name;
}

function toRelative(id: StandardFolderId, path: string, home: string): string {
  return relative(standardFolderRoot(id, home), path).split(sep).join("/");
}

function samePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right);
}

function pathContains(parentPath: string, childPath: string): boolean {
  const parent = comparisonPath(parentPath);
  const child = comparisonPath(childPath);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/** macOS and Windows disks ignore case by default; a wrongly cased path names the same folder. */
function comparisonPath(value: string): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "linux" ? resolved : resolved.toLocaleLowerCase();
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400, statusCode: 400 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409, statusCode: 409 });
}
