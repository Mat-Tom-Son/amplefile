import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

import {
  getConnectedFolder,
  listConnectedFolders,
  nestedRegisteredConnectedFolderPaths,
  resolveListedSymbolicLink,
  scanConnectedFolderTree,
  type ListedSymbolicLink,
  type TreeEntry,
} from "./connected-folder.js";
import { isAlwaysHiddenConnectedFolderEntry } from "./connected-folder-ignore.js";
import {
  accessError,
  computerFolderId,
  isShownStandardEntry,
  isStandardFolderId,
  listStandardFolders,
  macDataVolumeRefusal,
  macDataVolumeRoot,
  standardFolderPathBase,
  standardFolderRoot,
  type StandardFolderScanOptions,
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
  // The real location, so a link anywhere in the path is never traversed by a place's routes,
  // under its usual name when it came by the Mac's data volume.
  const resolved = await realpath(resolve(path)).catch(() => null);
  if (!resolved) return null;
  const real = await withoutMacDataVolumeName(resolved);
  if (isInsideMacDataVolume(real)) throw Object.assign(new Error(macDataVolumeRefusal), { status: 400, statusCode: 400 });
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

/**
 * macOS: a path by the data volume's second name (`/System/Volumes/Data/Users/ana`)
 * under its usual one (`/Users/ana`) when that is the same folder or file;
 * anything else is returned as it is.
 */
export async function withoutMacDataVolumeName(path: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform !== "darwin" || !isInsideMacDataVolume(path, platform)) return path;
  const usual = path.slice(macDataVolumeRoot.length) || "/";
  const [aliased, plain] = await Promise.all([stat(path).catch(() => null), stat(usual).catch(() => null)]);
  return aliased && plain && aliased.dev === plain.dev && aliased.ino === plain.ino ? usual : path;
}

function isInsideMacDataVolume(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  const lower = path.toLowerCase();
  const root = macDataVolumeRoot.toLowerCase();
  return lower === root || lower.startsWith(`${root}/`);
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
 * listing's rules: dotfiles and links only when asked for, and nothing of
 * AmpleFile's or Pi's.
 * A folder below the disk's top is listed by the shared tree scan from its
 * first folder (see standardFolderPathBase); the top itself, which that scan
 * never takes as a root, is read here. A registered Connected Folder is
 * marked, as a Standard Folder's listing marks one, so opening it goes there.
 */
export async function scanComputerFolder(relativePath: string, home = homedir(), options: StandardFolderScanOptions = {}): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
  try {
    const base = standardFolderPathBase(computerFolderId, relativePath, home);
    if (base) {
      // The same optional listing additions a Standard Folder takes (links, hidden entries, a larger one-level bound).
      const scan = await scanConnectedFolderTree(base.root, 0, base.path, {
        includeIgnored: true,
        nestedFolderPaths: await nestedRegisteredConnectedFolderPaths(base.root),
        ...(options.includeLinks ? { includeLinks: true } : {}),
        ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      });
      return {
        tree: scan.entries
          .filter((entry) => options.includeHidden || isShownStandardEntry(entry.name))
          .map(({ children: _children, ...entry }) => ({
            ...entry,
            path: `${base.prefix}/${entry.path}`,
            ...(options.includeHidden && !isShownStandardEntry(entry.name) ? { hidden: true as const } : {}),
          })),
        truncated: scan.truncated,
      };
    }
    return { tree: await scanDiskTop(standardFolderRoot(computerFolderId, home), options), truncated: false };
  } catch (error) {
    throw accessError(error, computerFolderId);
  }
}

/**
 * The disk's top, under the same rules as any other listing in the computer
 * place: dotfiles only when `includeHidden` asks (marked `hidden`), symbolic
 * links only when `includeLinks` asks (Linux keeps `/bin` and `/lib` as
 * links), each with what it points to and never followed, and nothing of
 * AmpleFile's or Pi's ever.
 */
async function scanDiskTop(top: string, options: StandardFolderScanOptions = {}): Promise<TreeEntry[]> {
  const registered = new Set((await listConnectedFolders()).map((connectedFolder) => comparison(connectedFolder.connectedFolderRoot)));
  const entries = (await readdir(top, { withFileTypes: true })).filter((entry) => {
    if (!entry.name || isAlwaysHiddenConnectedFolderEntry(entry.name)) return false;
    if (!options.includeHidden && !isShownStandardEntry(entry.name)) return false;
    return entry.isSymbolicLink() ? Boolean(options.includeLinks) : entry.isDirectory() || entry.isFile();
  });
  const listed = await Promise.all(entries.map(async (entry): Promise<TreeEntry | null> => {
    const path = join(top, entry.name);
    const hidden = !isShownStandardEntry(entry.name) ? { hidden: true as const } : {};
    if (entry.isSymbolicLink()) return diskTopLink(entry.name, path, hidden);
    // An entry that disappears between the read and its stat is skipped, as the tree scan skips one.
    const info = await stat(path).catch(() => null);
    if (!info) return null;
    if (info.isFile()) return { name: entry.name, path: entry.name, kind: "file", sizeBytes: info.size, updatedAt: info.mtime.toISOString(), ...hidden };
    if (registered.has(comparison(path))) return { name: entry.name, path: entry.name, kind: "folder", updatedAt: info.mtime.toISOString(), hasChildren: false, nestedFolder: true, ...hidden };
    const children = await readdir(path).catch(() => []);
    const shown = (name: string) => options.includeHidden ? Boolean(name) && !isAlwaysHiddenConnectedFolderEntry(name) : isShownStandardEntry(name);
    return { name: entry.name, path: entry.name, kind: "folder", updatedAt: info.mtime.toISOString(), hasChildren: children.some(shown), ...hidden };
  }));
  return listed
    .filter((entry): entry is TreeEntry => Boolean(entry))
    .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "folder" ? -1 : 1);
}

/** A link at the disk's top, as the tree scan lists one: by what it points to now, a broken one or a loop as missing. */
async function diskTopLink(name: string, path: string, hidden: { hidden?: true }): Promise<TreeEntry | null> {
  const linkInfo = await lstat(path).catch(() => null);
  if (!linkInfo?.isSymbolicLink()) return null;
  const targetInfo = await stat(path).catch(() => null);
  if (targetInfo && !targetInfo.isFile() && !targetInfo.isDirectory()) return null;
  const targetPath = await realpath(path).catch(async () => {
    const named = await readlink(path).catch(() => null);
    return named === null ? null : resolve(dirname(path), named);
  });
  if (targetPath === null) return null;
  const target = targetInfo ? targetInfo.isDirectory() ? "folder" as const : "file" as const : "missing" as const;
  return {
    name,
    path: name,
    kind: target === "folder" ? "folder" : "file",
    ...(target === "file" && targetInfo ? { sizeBytes: targetInfo.size } : {}),
    updatedAt: (targetInfo ?? linkInfo).mtime.toISOString(),
    ...(target === "folder" ? { hasChildren: false } : {}),
    link: { target, targetPath },
    ...hidden,
  };
}

/**
 * A symbolic link a listing in any place showed, resolved now so the desktop
 * can open what it points to or show the link itself (docs/product-model.md,
 * "Symbolic links"). The folder holding the link keeps the place's path
 * policy; the link may point anywhere, and only where it points is read. A
 * link at the disk's top (Linux's `/bin`) is the computer place's first
 * folder, which the policy never takes as a folder, so it is read here.
 */
export async function resolvePlaceSymbolicLink(place: FolderLocationPlace, relativePath: string, home = homedir()): Promise<ListedSymbolicLink> {
  if (place.kind === "connected-folder") return resolveListedSymbolicLink((await getConnectedFolder(place.id)).connectedFolderRoot, relativePath);
  if (!isStandardFolderId(place.id)) throw Object.assign(new Error("That folder isn’t in the sidebar anymore."), { status: 404, statusCode: 404 });
  const parts = relativePath.split("/").filter((part) => part && part !== ".");
  if (place.id === computerFolderId && parts.length === 1) return diskTopSymbolicLink(standardFolderRoot(computerFolderId, home), parts[0]!);
  const base = standardFolderPathBase(place.id, relativePath, home);
  if (!base) throw Object.assign(new Error("Choose a link inside the folder."), { status: 400, statusCode: 400 });
  return resolveListedSymbolicLink(base.root, base.path);
}

async function diskTopSymbolicLink(top: string, name: string): Promise<ListedSymbolicLink> {
  if (name === ".." || name.includes("\\") || isAlwaysHiddenConnectedFolderEntry(name)) throw Object.assign(new Error("Choose a link inside the folder."), { status: 400, statusCode: 400 });
  const linkPath = join(top, name);
  const info = await lstat(linkPath).catch(() => null);
  if (!info) throw Object.assign(new Error("That link isn’t there anymore."), { status: 404, statusCode: 404 });
  if (!info.isSymbolicLink()) throw Object.assign(new Error("That item isn’t a symbolic link."), { status: 400, statusCode: 400 });
  const targetPath = await realpath(linkPath).catch(() => null);
  const target = targetPath ? await stat(targetPath).catch(() => null) : null;
  if (!targetPath || !target) throw Object.assign(new Error("The item this link points to isn’t there."), { status: 404, statusCode: 404 });
  if (!target.isFile() && !target.isDirectory()) throw Object.assign(new Error("This link points to something that isn’t a file or folder."), { status: 400, statusCode: 400 });
  return { linkPath, targetPath, target: target.isDirectory() ? "folder" : "file" };
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
