import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

import { listConnectedFolders, nestedRegisteredConnectedFolderPaths, scanConnectedFolderTree, type TreeEntry } from "./connected-folder.js";
import { isAlwaysHiddenConnectedFolderEntry } from "./connected-folder-ignore.js";
import {
  accessError,
  computerFolderId,
  isShownStandardEntry,
  listStandardFolders,
  standardFolderPathBase,
  standardFolderRoot,
} from "./standard-folders.js";

/**
 * Where any folder on this computer opens in the file manager window
 * (docs/product-model.md, "Other folders"). The host is the authority: a path
 * is resolved to its real location, then to the place that holds it, the
 * deepest registered Connected Folder first, then the most specific Standard
 * Folder, and otherwise the computer place, whose top is the disk's root and
 * which follows the Standard Folder rules. The window names a place only by
 * that id and a relative path, so every route keeps resolving and checking it.
 */
export interface FolderLocationPlace { kind: "connected-folder" | "standard"; id: string }

export interface FolderLocation {
  place: FolderLocationPlace;
  /** The folder shown, relative to the place's top ("" for the top itself). */
  path: string;
  /** An item to select in that folder, relative to the place's top: the file a path named, or the folder a reveal came from. */
  select: string | null;
}

interface KnownPlace { place: FolderLocationPlace; root: string }

/**
 * The location a path opens at: a folder shows itself; a file shows its folder
 * with the file selected. With `reveal`, a folder is shown selected in its
 * enclosing folder too (Command-Up from a place's top). Null when nothing is
 * at the path. Refuses hidden AmpleFile and Pi data, which no place shows.
 */
export async function resolveFolderLocation(
  path: string,
  connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>,
  home = homedir(),
  options: { reveal?: boolean } = {},
): Promise<FolderLocation | null> {
  // The real location, so a link anywhere in the path is never traversed by a place's routes.
  const real = await realpath(resolve(path)).catch(() => null);
  if (!real) return null;
  const info = await stat(real).catch(() => null);
  if (!info || (!info.isDirectory() && !info.isFile())) return null;
  const diskRoot = parse(real).root;
  const showsItself = info.isDirectory() && (!options.reveal || real === diskRoot);
  const folder = showsItself ? real : dirname(real);
  const holder = deepestPlace(folder, await knownPlaces(connectedFolders, home));
  const inside = (target: string) => relative(holder.root, target).split(sep).filter(Boolean).join("/");
  const location: FolderLocation = { place: holder.place, path: inside(folder), select: showsItself ? null : inside(real) };
  for (const relativePath of [location.path, location.select ?? ""]) {
    if (relativePath.split("/").some((part) => isAlwaysHiddenConnectedFolderEntry(part))) {
      throw Object.assign(new Error("That folder is hidden AmpleFile or Pi data."), { status: 400, statusCode: 400 });
    }
  }
  return location;
}

async function knownPlaces(connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>, home: string): Promise<KnownPlace[]> {
  const places: KnownPlace[] = [];
  const add = async (place: FolderLocationPlace, root: string) => {
    // A registered folder that is gone (or a Standard Folder that is a link) holds nothing.
    const real = await realpath(root).catch(() => null);
    if (real) places.push({ place, root: real });
  };
  for (const connectedFolder of connectedFolders) await add({ kind: "connected-folder", id: connectedFolder.id }, connectedFolder.connectedFolderRoot);
  // The home folder holds the other Standard Folders; the deepest match wins, so it opens only what nothing else holds.
  for (const folder of await listStandardFolders(connectedFolders, home)) {
    if (!folder.connectedFolderId) await add({ kind: "standard", id: folder.id }, folder.root);
  }
  return places;
}

/** The deepest place holding a folder; a Connected Folder wins over a Standard Folder at the same depth, and the computer place holds the rest. */
function deepestPlace(folder: string, places: readonly KnownPlace[]): KnownPlace {
  let best: KnownPlace | null = null;
  for (const candidate of places) {
    if (!contains(candidate.root, folder)) continue;
    if (!best || candidate.root.length > best.root.length || (candidate.root.length === best.root.length && candidate.place.kind === "connected-folder")) best = candidate;
  }
  return best ?? { place: { kind: "standard", id: computerFolderId }, root: parse(folder).root };
}

/**
 * One level of a folder in the computer place, with the Standard Folder
 * listing's rules: no dotfiles, no links, and nothing of AmpleFile's or Pi's.
 * A folder below the disk's top is listed by the shared tree scan from its
 * first folder (see standardFolderPathBase); the top itself, which that scan
 * never takes as a root, is read here. A registered Connected Folder is
 * marked, as a Standard Folder's listing marks one, so opening it goes there.
 */
export async function scanComputerFolder(relativePath: string, home = homedir()): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
  try {
    const base = standardFolderPathBase(computerFolderId, relativePath, home);
    if (base) {
      const scan = await scanConnectedFolderTree(base.root, 0, base.path, { includeIgnored: true, nestedFolderPaths: await nestedRegisteredConnectedFolderPaths(base.root) });
      return {
        tree: scan.entries
          .filter((entry) => isShownStandardEntry(entry.name))
          .map(({ children: _children, ...entry }) => ({ ...entry, path: `${base.prefix}/${entry.path}` })),
        truncated: scan.truncated,
      };
    }
    return { tree: await scanDiskTop(standardFolderRoot(computerFolderId, home)), truncated: false };
  } catch (error) {
    throw accessError(error, computerFolderId);
  }
}

async function scanDiskTop(top: string): Promise<TreeEntry[]> {
  const registered = new Set((await listConnectedFolders()).map((connectedFolder) => comparison(connectedFolder.connectedFolderRoot)));
  const entries = (await readdir(top, { withFileTypes: true }))
    .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()) && isShownStandardEntry(entry.name));
  const listed = await Promise.all(entries.map(async (entry): Promise<TreeEntry | null> => {
    const path = join(top, entry.name);
    // An entry that disappears between the read and its stat is skipped, as the tree scan skips one.
    const info = await stat(path).catch(() => null);
    if (!info) return null;
    if (info.isFile()) return { name: entry.name, path: entry.name, kind: "file", sizeBytes: info.size, updatedAt: info.mtime.toISOString() };
    if (registered.has(comparison(path))) return { name: entry.name, path: entry.name, kind: "folder", updatedAt: info.mtime.toISOString(), hasChildren: false, nestedFolder: true };
    const children = await readdir(path).catch(() => []);
    return { name: entry.name, path: entry.name, kind: "folder", updatedAt: info.mtime.toISOString(), hasChildren: children.some((name) => isShownStandardEntry(name)) };
  }));
  return listed
    .filter((entry): entry is TreeEntry => Boolean(entry))
    .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "folder" ? -1 : 1);
}

function contains(root: string, path: string): boolean {
  const parent = comparison(root);
  const child = comparison(path);
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** macOS and Windows disks ignore case by default. */
function comparison(value: string): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "") || sep;
  return process.platform === "linux" ? resolved : resolved.toLocaleLowerCase();
}
