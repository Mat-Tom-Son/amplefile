import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { copyInto, freeDestination, placeFolderWithoutReplacing, removeOwnedItem } from "./file-transfer.js";
import { isAlwaysHiddenConnectedFolderEntry } from "./connected-folder-ignore.js";
import { isFileOperationCancelled, untrackedFileOperation, type FileOperationControl } from "./file-operations.js";
import { parseMountInfo } from "./volumes.js";

/**
 * The system Trash, read and put back (docs/architecture.md, "Drives and the
 * system Trash"). Deleting in a Standard Folder or any other folder is the
 * desktop's own Move to Trash; this module lets the window list what is there
 * return an item to where it was, and, behind the window's confirmation,
 * empty it or delete items immediately (below, "Permanent deletion").
 *
 * Linux follows the FreeDesktop Trash specification: the home trash at
 * `$XDG_DATA_HOME/Trash` and, on each mounted volume, `$topdir/.Trash/$uid`
 * (only under a sticky, non-link `.Trash`) and `$topdir/.Trash-$uid`. Each
 * holds `files/` and `info/<name>.trashinfo`. Everything read there is
 * untrusted: an info file is opened without following a link and read only
 * up to a small bound, its `Path` is percent-decoded strictly and refused
 * when it names `.` or `..`, a volume's item may only go back onto that same
 * volume, and no link inside a trash folder is ever followed.
 *
 * macOS keeps no original location AmpleFile can read (Finder records it in
 * its own private metadata), and listing `~/.Trash` needs the person's
 * permission, so there Put Back stays in Finder.
 *
 * Items are named by ids this process mints from where they sit; a caller
 * never supplies a path.
 */

export type TrashItemKind = "file" | "folder" | "link" | "other";

export interface TrashItem {
  /** Opaque, minted by this process; stable while the item stays in the Trash. */
  id: string;
  /** The item's name where it came from, else its name in the Trash. */
  name: string;
  /** Where it was before it was moved to the Trash; null when the record is missing or unreadable. */
  originalPath: string | null;
  /** When it was moved to the Trash (ISO), when recorded. */
  deletedAt: string | null;
  kind: TrashItemKind;
  /** A file's size, or a folder's total when it could be measured quickly; null otherwise. */
  sizeBytes: number | null;
  /** The home Trash, or the Trash on a drive. */
  trash: "home" | "volume";
  /** The drive's Trash: its mount path. Null for the home Trash. */
  volumePath: string | null;
  /** Whether Put Back can return it; when false, `putBackNote` says why. */
  canPutBack: boolean;
  putBackNote?: string;
}

export interface TrashListing {
  items: TrashItem[];
  /** More items than one listing returns. */
  truncated: boolean;
  /** Whether this computer's Trash supports Put Back at all (false on macOS). */
  putBackAvailable: boolean;
}

/** One trash folder: where its `files/` and `info/` are, and where its relative paths start. */
export interface TrashDirectory {
  root: string;
  /** Relative `Path` values start here: `$XDG_DATA_HOME` for the home trash, the volume's top for a volume's. */
  base: string;
  trash: "home" | "volume";
  /** A volume trash's items go back only inside it. */
  topdir: string | null;
}

export interface TrashOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** `$XDG_DATA_HOME`; ignored unless absolute, as the base directory specification says. */
  xdgDataHome?: string;
  uid?: number;
  /** Volume tops to look in (Linux); by default every real mount in the mount table. */
  volumeTops?: readonly string[];
  /** macOS: volume tops whose `.Trashes/<uid>` to list (default the entries of `/Volumes`). */
  macVolumeTops?: readonly string[];
}

let trashOptionsForTests: TrashOptions | null = null;

/** Tests point the Trash at a sandbox (home, data folder, uid, volume tops); null restores this computer's. */
export function setTrashOptionsForTests(options: TrashOptions | null): void {
  trashOptionsForTests = options;
}

function withTestOptions(options: TrashOptions): TrashOptions {
  return trashOptionsForTests ? { ...trashOptionsForTests, ...options } : options;
}

export const trashLimits = {
  /** Items one listing returns, across every trash folder. */
  maxItems: 10_000,
  /** An info file larger than this is not a trash record. */
  maxInfoBytes: 64 * 1024,
  /** Entries a listing walks to measure folders, across every folder in it. */
  measureEntries: 50_000,
  /** The `directorysizes` cache is read only up to this. */
  maxDirectorySizesBytes: 2 * 1024 * 1024,
  maxPathLength: 4_096,
} as const;

export class TrashError extends Error {
  readonly status: number;
  readonly statusCode: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.statusCode = status;
  }
}

const idKey = randomBytes(32);

function trashItemId(root: string, trashName: string): string {
  return `trash-${createHmac("sha256", idKey).update(`${root}\0${trashName}`).digest("base64url").slice(0, 27)}`;
}

function currentUid(options: TrashOptions): number {
  return options.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
}

// Info files ----------------------------------------------------------------

export interface ParsedTrashInfo {
  originalPath: string | null;
  deletedAt: string | null;
  /** Why the record cannot be used to put the item back. */
  problem?: string;
}

/** Strict percent-decoding to UTF-8 text; null for a stray `%`, bytes that are not text, or a NUL. */
export function percentDecodePath(value: string): string | null {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "%") {
      const hex = value.slice(index + 1, index + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(...Buffer.from(char, "utf8"));
  }
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer) || text.includes("\0")) return null;
  return text;
}

/** The specification's `YYYY-MM-DDThh:mm:ss` in local time (and the compact form older tools wrote). */
export function parseTrashDeletionDate(value: string): string | null {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) {
    // A local time skipped by a clock change still names a moment; anything else is not a date.
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * A normalized absolute path from an info file's `Path`: absolute as written,
 * or relative to the trash's base. Refused when it names `.` or `..`, holds a
 * control character, or is the disk's top.
 */
export function trashOriginalPath(decoded: string, base: string): string | null {
  if (!decoded || decoded.length > trashLimits.maxPathLength || /[\0-\x1f\x7f]/.test(decoded)) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  const parts = segments.filter(Boolean);
  if (!parts.length) return null;
  if (decoded.startsWith("/")) return `/${parts.join("/")}`;
  const baseParts = resolve(base).split(sep).filter(Boolean);
  return `/${[...baseParts, ...parts].join("/")}`;
}

/** An info file's `[Trash Info]` group (desktop entry syntax); anything off-pattern is a problem, not a guess. */
export function parseTrashInfo(text: string, base: string): ParsedTrashInfo {
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && (!lines[index]!.trim() || lines[index]!.trimStart().startsWith("#"))) index += 1;
  if (lines[index]?.trim() !== "[Trash Info]") return { originalPath: null, deletedAt: null, problem: "Its Trash record is damaged." };
  let rawPath: string | null = null;
  let rawDate: string | null = null;
  let duplicate = false;
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("[")) break;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1);
    if (key === "Path") { if (rawPath !== null) duplicate = true; rawPath = value; }
    if (key === "DeletionDate") { if (rawDate !== null) duplicate = true; rawDate = value; }
  }
  const deletedAt = rawDate === null ? null : parseTrashDeletionDate(rawDate);
  if (duplicate) return { originalPath: null, deletedAt, problem: "Its Trash record is damaged." };
  if (rawPath === null) return { originalPath: null, deletedAt, problem: "Its Trash record doesn’t say where it came from." };
  const decoded = percentDecodePath(rawPath);
  const originalPath = decoded === null ? null : trashOriginalPath(decoded, base);
  if (!originalPath) return { originalPath: null, deletedAt, problem: "Its Trash record names a location AmpleFile can’t use." };
  return { originalPath, deletedAt };
}

/** Reads an info file without following a link, refusing anything that is not a small regular file. */
async function readInfoFile(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > trashLimits.maxInfoBytes) return null;
    const buffer = Buffer.alloc(Math.min(info.size, trashLimits.maxInfoBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Finding trash folders --------------------------------------------------------

async function realDirectory(path: string): Promise<import("node:fs").Stats | null> {
  const info = await lstat(path).catch(() => null);
  return info?.isDirectory() && !info.isSymbolicLink() ? info : null;
}

/** A trash folder is used only when it, its `files/`, and its `info/` are real folders (never links). */
async function usableTrash(root: string, uid: number, requireOwner: boolean): Promise<boolean> {
  const info = await realDirectory(root);
  if (!info || (requireOwner && uid >= 0 && info.uid !== uid)) return false;
  return Boolean(await realDirectory(join(root, "files")) && await realDirectory(join(root, "info")));
}

/** Pseudo filesystems never hold a volume trash; tmpfs at /tmp can (GLib makes one there). */
const nonVolumeFileSystems = new Set(["proc", "sysfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "pstore", "securityfs",
  "debugfs", "tracefs", "configfs", "fusectl", "mqueue", "hugetlbfs", "bpf", "binfmt_misc", "autofs", "efivarfs",
  "rpc_pipefs", "nsfs", "selinuxfs", "squashfs", "overlay", "fuse.portal", "fuse.gvfsd-fuse", "fuse.snapfuse", "fuse.lxcfs"]);

async function linuxVolumeTops(): Promise<string[]> {
  const text = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  const tops = new Set<string>();
  for (const mount of parseMountInfo(text.slice(0, 4 * 1024 * 1024))) {
    if (nonVolumeFileSystems.has(mount.fileSystem)) continue;
    if (/^\/(proc|sys|dev)(\/|$)/.test(mount.mountPoint)) continue;
    if (/^\/run(\/|$)/.test(mount.mountPoint) && !/^\/run\/media\//.test(mount.mountPoint)) continue;
    tops.add(mount.mountPoint);
  }
  return [...tops].slice(0, 512);
}

/** The home trash, then each volume's own, in the specification's order. */
export async function linuxTrashDirectories(options: TrashOptions = {}): Promise<TrashDirectory[]> {
  const home = resolve(options.home ?? homedir());
  const uid = currentUid(options);
  const dataHome = options.xdgDataHome && isAbsolute(options.xdgDataHome) ? resolve(options.xdgDataHome)
    : options.xdgDataHome === undefined && process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) && options.home === undefined
      ? resolve(process.env.XDG_DATA_HOME) : join(home, ".local", "share");
  const directories: TrashDirectory[] = [];
  const seen = new Set<string>();
  const add = async (directory: TrashDirectory, requireOwner: boolean) => {
    if (seen.has(directory.root) || !await usableTrash(directory.root, uid, requireOwner)) return;
    const info = await lstat(directory.root);
    const key = `${info.dev}:${info.ino}`;
    if (seen.has(key)) return;
    seen.add(directory.root);
    seen.add(key);
    directories.push(directory);
  };
  await add({ root: join(dataHome, "Trash"), base: dataHome, trash: "home", topdir: null }, false);
  for (const top of options.volumeTops ?? await linuxVolumeTops()) {
    if (!isAbsolute(top)) continue;
    const shared = join(top, ".Trash");
    const sharedInfo = await realDirectory(shared);
    // The shared `.Trash` must be sticky, or a user could have planted another's folder in it.
    if (sharedInfo && (sharedInfo.mode & 0o1000) !== 0 && uid >= 0) {
      await add({ root: join(shared, String(uid)), base: top, trash: "volume", topdir: top }, true);
    }
    if (uid >= 0) await add({ root: join(top, `.Trash-${uid}`), base: top, trash: "volume", topdir: top }, true);
  }
  return directories;
}

// Listing ----------------------------------------------------------------------

interface TrashEntry {
  directory: TrashDirectory;
  trashName: string;
  id: string;
}

/** Info names in one trash folder that pair with an item; names that are not text are skipped. */
async function trashEntries(directory: TrashDirectory, limit: number): Promise<{ entries: TrashEntry[]; truncated: boolean }> {
  const entries: TrashEntry[] = [];
  const names = await readdir(join(directory.root, "info"), { withFileTypes: true }).catch(() => []);
  let truncated = false;
  for (const entry of names) {
    if (!entry.name.endsWith(".trashinfo") || entry.isSymbolicLink() || !entry.isFile()) continue;
    const trashName = entry.name.slice(0, -".trashinfo".length);
    if (!trashName || trashName === "." || trashName === ".." || trashName.includes("/") || trashName.includes("�")) continue;
    if (entries.length >= limit) { truncated = true; break; }
    entries.push({ directory, trashName, id: trashItemId(directory.root, trashName) });
  }
  return { entries, truncated };
}

/** The `directorysizes` cache: a folder's size, valid while its info file's time (in seconds) matches. */
async function readDirectorySizes(root: string): Promise<Map<string, { size: number; mtime: number }>> {
  const sizes = new Map<string, { size: number; mtime: number }>();
  const text = await readInfoLikeFile(join(root, "directorysizes"), trashLimits.maxDirectorySizesBytes);
  if (!text) return sizes;
  for (const line of text.split("\n")) {
    const [size, mtime, name, ...rest] = line.split(" ");
    if (rest.length || !size || !mtime || !name || !/^\d{1,18}$/.test(size) || !/^\d{1,14}$/.test(mtime)) continue;
    const decoded = percentDecodePath(name);
    if (decoded && !decoded.includes("/")) sizes.set(decoded, { size: Number(size), mtime: Number(mtime) });
  }
  return sizes;
}

async function readInfoLikeFile(path: string, maxBytes: number): Promise<string | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return null; } finally { await handle.close().catch(() => undefined); }
}

/** A folder's total file bytes, walking without following links, within a shared budget; null when it runs out. */
async function measureFolder(path: string, budget: { entries: number }): Promise<number | null> {
  let total = 0;
  const pending = [path];
  while (pending.length) {
    const folder = pending.pop()!;
    const children = await readdir(folder, { withFileTypes: true }).catch(() => null);
    if (!children) return null;
    for (const child of children) {
      budget.entries -= 1;
      if (budget.entries < 0) return null;
      const childPath = join(folder, child.name);
      if (child.isDirectory()) { pending.push(childPath); continue; }
      if (child.isFile()) {
        const info = await lstat(childPath).catch(() => null);
        if (info?.isFile()) total += info.size;
      }
    }
  }
  return total;
}

function kindOf(info: import("node:fs").Stats): TrashItemKind {
  return info.isSymbolicLink() ? "link" : info.isDirectory() ? "folder" : info.isFile() ? "file" : "other";
}

/** What the system Trash holds, newest first. */
export async function listSystemTrash(givenOptions: TrashOptions = {}): Promise<TrashListing> {
  const options = withTestOptions(givenOptions);
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return listMacTrash(options);
  if (platform !== "linux") return { items: [], truncated: false, putBackAvailable: false };
  const items: TrashItem[] = [];
  let truncated = false;
  const budget = { entries: trashLimits.measureEntries };
  for (const directory of await linuxTrashDirectories(options)) {
    const listed = await trashEntries(directory, trashLimits.maxItems - items.length);
    truncated ||= listed.truncated;
    const sizes = listed.entries.length ? await readDirectorySizes(directory.root) : new Map<string, { size: number; mtime: number }>();
    for (const entry of listed.entries) {
      const item = await describeEntry(entry, sizes, budget);
      if (item) items.push(item);
    }
    if (items.length >= trashLimits.maxItems) { truncated = true; break; }
  }
  items.sort((left, right) => (right.deletedAt ?? "").localeCompare(left.deletedAt ?? "") || left.name.localeCompare(right.name));
  return { items, truncated, putBackAvailable: true };
}

async function describeEntry(entry: TrashEntry, sizes: Map<string, { size: number; mtime: number }>, budget: { entries: number }): Promise<TrashItem | null> {
  const itemPath = join(entry.directory.root, "files", entry.trashName);
  const info = await lstat(itemPath).catch(() => null);
  // An info file whose item is gone is a leftover; the specification says to ignore it.
  if (!info) return null;
  const infoPath = join(entry.directory.root, "info", `${entry.trashName}.trashinfo`);
  const text = await readInfoFile(infoPath);
  const parsed = text === null ? { originalPath: null, deletedAt: null, problem: "Its Trash record can’t be read." } : parseTrashInfo(text, entry.directory.base);
  let { problem } = parsed;
  if (!problem && entry.directory.topdir && parsed.originalPath && !pathInside(entry.directory.topdir, parsed.originalPath)) {
    problem = "Its Trash record names a place outside the drive it was trashed on.";
  }
  let sizeBytes: number | null = null;
  if (info.isFile() || info.isSymbolicLink()) sizeBytes = info.size;
  else if (info.isDirectory()) {
    const cached = sizes.get(entry.trashName);
    const infoTime = await lstat(infoPath).then((stats) => Math.floor(stats.mtimeMs / 1000), () => null);
    sizeBytes = cached && infoTime !== null && cached.mtime === infoTime ? cached.size : await measureFolder(itemPath, budget);
  }
  return {
    id: entry.id,
    name: parsed.originalPath ? basename(parsed.originalPath) : entry.trashName,
    originalPath: parsed.originalPath,
    deletedAt: parsed.deletedAt,
    kind: kindOf(info),
    sizeBytes,
    trash: entry.directory.trash,
    volumePath: entry.directory.topdir,
    canPutBack: !problem,
    ...(problem ? { putBackNote: problem } : {}),
  };
}

// macOS ----------------------------------------------------------------------

const macPutBackNote = "Put this back from the Trash in Finder. AmpleFile can’t read where macOS recorded it came from.";

/**
 * macOS: `~/.Trash` and each volume's `.Trashes/<uid>`, listed only. Reading
 * `~/.Trash` needs the person's permission (Full Disk Access); without it the
 * listing is refused with a plain message.
 */
async function listMacTrash(options: TrashOptions): Promise<TrashListing> {
  const home = resolve(options.home ?? homedir());
  const uid = currentUid(options);
  const roots: Array<{ root: string; trash: "home" | "volume"; topdir: string | null }> = [{ root: join(home, ".Trash"), trash: "home", topdir: null }];
  const tops = options.macVolumeTops ?? await readdir("/Volumes").then((names) => names.filter((name) => !name.startsWith(".")).map((name) => join("/Volumes", name)), () => []);
  for (const top of tops) roots.push({ root: join(top, ".Trashes", String(uid)), trash: "volume", topdir: top });
  const items: TrashItem[] = [];
  let truncated = false;
  const budget = { entries: trashLimits.measureEntries };
  for (const [index, source] of roots.entries()) {
    const info = await lstat(source.root).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    let names: import("node:fs").Dirent[];
    try {
      names = await readdir(source.root, { withFileTypes: true });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (index === 0 && (code === "EPERM" || code === "EACCES")) {
        throw new TrashError(403, "AmpleFile isn’t allowed to see the Trash. Allow Full Disk Access for AmpleFile in System Settings → Privacy & Security, or open the Trash in Finder.");
      }
      continue;
    }
    for (const name of names) {
      if (name.name === ".DS_Store" || name.name.includes("�")) continue;
      if (items.length >= trashLimits.maxItems) { truncated = true; break; }
      const itemPath = join(source.root, name.name);
      const stats = await lstat(itemPath).catch(() => null);
      if (!stats) continue;
      items.push({
        id: trashItemId(source.root, name.name),
        name: name.name,
        originalPath: null,
        deletedAt: null,
        kind: kindOf(stats),
        sizeBytes: stats.isFile() || stats.isSymbolicLink() ? stats.size : stats.isDirectory() ? await measureFolder(itemPath, budget) : null,
        trash: source.trash,
        volumePath: source.topdir,
        canPutBack: false,
        putBackNote: macPutBackNote,
      });
    }
  }
  items.sort((left, right) => left.name.localeCompare(right.name));
  return { items, truncated, putBackAvailable: false };
}

// Put Back ---------------------------------------------------------------------

/** A Trash item found again by its id, with its record. */
export interface FoundTrashItem {
  directory: TrashDirectory;
  trashName: string;
  itemPath: string;
  infoPath: string;
  info: ParsedTrashInfo;
  kind: TrashItemKind;
}

/** Finds an item by the id a listing gave; null when it is no longer in the Trash. */
export async function findTrashItem(id: string, givenOptions: TrashOptions = {}): Promise<FoundTrashItem | null> {
  const options = withTestOptions(givenOptions);
  if (!/^trash-[A-Za-z0-9_-]{27}$/.test(id)) return null;
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return null;
  for (const directory of await linuxTrashDirectories(options)) {
    const { entries } = await trashEntries(directory, Number.MAX_SAFE_INTEGER);
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) continue;
    const itemPath = join(directory.root, "files", entry.trashName);
    const stats = await lstat(itemPath).catch(() => null);
    if (!stats) return null;
    const infoPath = join(directory.root, "info", `${entry.trashName}.trashinfo`);
    const text = await readInfoFile(infoPath);
    const info = text === null ? { originalPath: null, deletedAt: null, problem: "Its Trash record can’t be read." } : parseTrashInfo(text, directory.base);
    return { directory, trashName: entry.trashName, itemPath, infoPath, info, kind: kindOf(stats) };
  }
  return null;
}

/** Where Put Back will place an item, decided before anything moves. */
export interface PutBackPlan {
  /** The real folder the item goes into (missing folders included, as they will be). */
  parent: string;
  /** The name it asks for; a taken name gets Finder's " copy". */
  name: string;
  /** Folders to create first, outermost first. */
  missingFolders: string[];
  /** The registered Connected Folder that holds the destination, deepest first; History records the Put Back there. */
  connectedFolder: { id: string; connectedFolderRoot: string; name: string } | null;
}

/** At most this many missing folders are recreated for one item. */
const maxRecreatedFolders = 16;

/**
 * Decides where an item goes back. The recorded folder is walked from the
 * disk's top without following any link except a system one (owned by the
 * administrator, such as `/home` → `/var/home` on Fedora Silverblue). Missing
 * folders are recreated only below an existing real folder inside the home
 * folder or a Connected Folder (home Trash) or on the item's own drive (a
 * drive's Trash), never in
 * AmpleFile's or Pi's hidden data, and never more than a few levels.
 */
export async function planPutBack(
  item: FoundTrashItem,
  connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string; name: string }>,
  options: { home?: string } = {},
): Promise<PutBackPlan> {
  const name = item.info.originalPath ? basename(item.info.originalPath) : "";
  if (item.info.problem || !item.info.originalPath || !name) {
    throw new TrashError(409, `AmpleFile can’t put “${name || item.trashName}” back. ${item.info.problem ?? "Its Trash record is damaged."} Move it out of the Trash by hand instead.`);
  }
  if (item.directory.topdir && !pathInside(item.directory.topdir, item.info.originalPath)) {
    throw new TrashError(409, `AmpleFile can’t put “${name}” back: its Trash record names a place outside the drive it was trashed on.`);
  }
  const recordedParent = dirname(item.info.originalPath);
  const parts = recordedParent.split("/").filter(Boolean);
  let real = "/";
  const missingFolders: string[] = [];
  for (const [index, part] of parts.entries()) {
    const candidate = join(real, part);
    let info: import("node:fs").Stats | null;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw new TrashError(403, `AmpleFile can’t reach the folder “${name}” came from.`);
      info = null;
    }
    if (!info) {
      missingFolders.push(...parts.slice(index).map((_, offset) => join(real, ...parts.slice(index, index + offset + 1))));
      break;
    }
    if (info.isSymbolicLink()) {
      // Only the system's own links are followed, and only to a real folder.
      const target = info.uid === 0 ? await realpath(candidate).catch(() => null) : null;
      const targetInfo = target ? await realDirectory(target) : null;
      if (!target || !targetInfo) {
        throw new TrashError(409, `AmpleFile can’t put “${name}” back: the folder it came from is now reached through a link. Move it out of the Trash by hand instead.`);
      }
      real = target;
      continue;
    }
    if (!info.isDirectory()) {
      throw new TrashError(409, `AmpleFile can’t put “${name}” back: “${part}”, where it came from, is no longer a folder.`);
    }
    real = candidate;
  }
  const parent = missingFolders.length ? join(real, ...parts.slice(parts.length - missingFolders.length)) : real;
  const holder = connectedFolders
    .filter((connectedFolder) => pathInside(resolve(connectedFolder.connectedFolderRoot), parent))
    .sort((left, right) => right.connectedFolderRoot.length - left.connectedFolderRoot.length)[0] ?? null;
  if (missingFolders.length) {
    const existing = real;
    const home = resolve(options.home ?? trashOptionsForTests?.home ?? homedir());
    // Inside a Connected Folder its History records the new folders with the item.
    const inside = item.directory.topdir ? pathInside(item.directory.topdir, existing)
      : pathInside(home, existing) || Boolean(holder && pathInside(resolve(holder.connectedFolderRoot), existing));
    const reserved = missingFolders.some((folder) => isAlwaysHiddenConnectedFolderEntry(basename(folder)));
    if (!inside || reserved || missingFolders.length > maxRecreatedFolders) {
      throw new TrashError(409, `AmpleFile can’t put “${name}” back: the folder it came from, ${recordedParent}, is gone. Move it out of the Trash by hand instead.`);
    }
  }
  if (isAlwaysHiddenConnectedFolderEntry(name) || parent.split("/").some((part) => isAlwaysHiddenConnectedFolderEntry(part))) {
    throw new TrashError(409, `AmpleFile can’t put “${name}” back into hidden AmpleFile or Pi data.`);
  }
  return { parent, name, missingFolders, connectedFolder: holder ? { id: holder.id, connectedFolderRoot: resolve(holder.connectedFolderRoot), name: holder.name } : null };
}

export interface PutBackResult {
  /** Where the item is now. */
  path: string;
  /** Its name there; differs from the recorded name when that was taken. */
  name: string;
  renamed: boolean;
  /** Folders created for it, outermost first. */
  recreatedFolders: string[];
}

/** Codes that mean the filesystem cannot make hard links (FAT, exFAT, some network shares). */
const noHardLinks = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS", "EACCES"]);

/**
 * Moves the item to its planned place without ever replacing anything: a
 * folder by claiming its name first, a file by a hard link that fails on a
 * taken name. On a disk without hard links, a file is renamed to a name found
 * free a moment before. When the item's place is on another disk, it is
 * copied whole and only then leaves the Trash. Its record goes last, so a
 * failure leaves it in the Trash as it was.
 */
export async function performPutBack(item: FoundTrashItem, plan: PutBackPlan): Promise<PutBackResult> {
  const recreatedFolders: string[] = [];
  try {
    for (const folder of plan.missingFolders) {
      await mkdir(folder);
      recreatedFolders.push(folder);
    }
    const destination = await placeWithoutReplacing(item, plan);
    // The item is back; its record goes now (a leftover record is ignored by every Trash reader).
    await unlink(item.infoPath).catch(() => undefined);
    const finalName = basename(destination);
    return { path: destination, name: finalName, renamed: finalName !== plan.name, recreatedFolders };
  } catch (error) {
    for (const folder of [...recreatedFolders].reverse()) await rmdir(folder).catch(() => undefined);
    throw putBackError(error, plan.name);
  }
}

async function placeWithoutReplacing(item: FoundTrashItem, plan: PutBackPlan): Promise<string> {
  const current = await lstat(item.itemPath);
  if (current.isDirectory()) {
    try {
      return await placeFolderWithoutReplacing(item.itemPath, plan.parent, plan.name);
    } catch (error) {
      if ((error as { code?: string }).code !== "EXDEV") throw error;
      return copyOutOfTrash(item, plan);
    }
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const destination = await freeDestination(plan.parent, plan.name);
    try {
      await link(item.itemPath, destination);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (code === "EEXIST") continue;
      if (code === "EXDEV") return copyOutOfTrash(item, plan);
      if (!noHardLinks.has(code)) throw error;
      // No hard links on this disk: the name was free a moment ago.
      if (await lstat(destination).then(() => true, () => false)) continue;
      await rename(item.itemPath, destination);
      return destination;
    }
    await unlink(item.itemPath).catch(async (error) => {
      // The item is in both places; take back the new name so it stays one item in the Trash.
      await unlink(destination).catch(() => undefined);
      throw error;
    });
    return destination;
  }
  throw new TrashError(409, `There are too many copies of “${plan.name}” there already.`);
}

/**
 * Across disks: the item is renamed, inside the Trash, into a working folder
 * under its own name, copied whole to its place, and only then removed from
 * the Trash. A failed copy is taken back and the item returns to its name in
 * the Trash.
 */
async function copyOutOfTrash(item: FoundTrashItem, plan: PutBackPlan): Promise<string> {
  const working = join(item.directory.root, "files", `.AmpleFile-put-back-${randomBytes(6).toString("hex")}`);
  await mkdir(working);
  const staged = join(working, plan.name);
  try {
    await rename(item.itemPath, staged);
  } catch (error) {
    await rmdir(working).catch(() => undefined);
    throw error;
  }
  let destination: string;
  try {
    destination = await copyInto(staged, plan.parent, { withIdentity: true });
  } catch (error) {
    await rename(staged, item.itemPath).catch(() => undefined);
    await rmdir(working).catch(() => undefined);
    throw error;
  }
  await removeOwnedItem(staged).catch(() => undefined);
  await rmdir(working).catch(() => undefined);
  return destination;
}

/**
 * Returns an item Put Back placed to its name in the Trash, for a Put Back
 * whose History record could not be written. Its record was removed last, so
 * it is written again with the same content.
 */
export async function returnToTrash(item: FoundTrashItem, result: PutBackResult, recordText: string): Promise<boolean> {
  // An item copied from another disk stays where it was put back; the caller says so.
  if (!await rename(result.path, item.itemPath).then(() => true, () => false)) return false;
  const handle = await open(item.infoPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(() => null);
  if (handle) {
    try { await handle.writeFile(recordText, "utf8"); } finally { await handle.close().catch(() => undefined); }
  }
  for (const folder of [...result.recreatedFolders].reverse()) await rmdir(folder).catch(() => undefined);
  return true;
}

/** The info file as it is now, to write it again if a Put Back must be taken back. */
export async function readTrashRecord(item: FoundTrashItem): Promise<string | null> {
  return readInfoFile(item.infoPath);
}

function putBackError(error: unknown, name: string): unknown {
  if (error instanceof TrashError || typeof (error as { statusCode?: unknown })?.statusCode === "number") return error;
  const code = (error as { code?: string })?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new TrashError(403, `AmpleFile isn’t allowed to put “${name}” back where it came from.`);
  }
  if (code === "ENOENT") return new TrashError(404, `“${name}” isn’t in the Trash anymore.`);
  if (code === "ENOSPC") return new TrashError(507, `There isn’t enough space to put “${name}” back.`);
  return error;
}

function pathInside(parent: string, child: string): boolean {
  const left = resolve(parent).replace(/\/+$/, "") || "/";
  const right = resolve(child);
  return right === left || right.startsWith(left === "/" ? "/" : `${left}/`);
}

// Permanent deletion ------------------------------------------------------------

/**
 * Empty Trash and Delete Immediately remove items from the system Trash for
 * good. They are irreversible, so the window asks first; the host acts only
 * on ids a current listing mints (Empty Trash on everything there now),
 * checks again at the moment of each removal that the item still sits in a
 * trash folder reached without a link, never follows a link (a linked item is
 * removed as the link), removes the item before its record, and reports
 * exactly what went and what did not.
 *
 * Both take a file-operation control so a caller can report progress and
 * stop between items; the local API does not register them as named
 * operations yet, because `FileOperationKind` has no deletion kind.
 */
export interface TrashDeletionResult {
  /** Items removed for good, with the name and original path the listing showed. */
  removed: Array<{ id: string; name: string; originalPath: string | null }>;
  /** Items that could not be removed, and why; a folder may have been removed in part. */
  failed: Array<{ id: string; name: string; error: string }>;
  /** Requested ids no current listing holds (already gone, or never minted). */
  notFound: string[];
  /** Leftover records (an info file without its item) Empty Trash removed. */
  strayRecordsRemoved: number;
  /** Stopped before every item was handled; `notDone` lists the ids left in the Trash. */
  cancelled?: true;
  notDone?: string[];
}

/** One item in a trash folder, as deletion finds it. */
interface TrashSlot {
  id: string;
  name: string;
  originalPath: string | null;
  /** The trash folder (Linux: holding files/ and info/; macOS: the item's own folder). */
  root: string;
  /** The folder the item sits in, as resolved when it was found. */
  holder: string;
  holderReal: string;
  itemName: string;
  infoPath: string | null;
}

/** Working folders Put Back uses inside a trash folder; deletion leaves them alone. */
const putBackWorkingPrefix = ".AmpleFile-put-back-";

async function linuxSlots(options: TrashOptions, includeUnrecorded: boolean): Promise<{ slots: TrashSlot[]; strayRecords: string[] }> {
  const slots: TrashSlot[] = [];
  const strayRecords: string[] = [];
  for (const directory of await linuxTrashDirectories(options)) {
    const holder = join(directory.root, "files");
    const holderReal = await realpath(holder).catch(() => null);
    if (!holderReal) continue;
    const recorded = new Set<string>();
    for (const entry of (await trashEntries(directory, Number.MAX_SAFE_INTEGER)).entries) {
      const infoPath = join(directory.root, "info", `${entry.trashName}.trashinfo`);
      if (!await lstat(join(holder, entry.trashName)).then(() => true, () => false)) {
        strayRecords.push(infoPath);
        continue;
      }
      recorded.add(entry.trashName);
      const text = await readInfoFile(infoPath);
      const parsed = text === null ? null : parseTrashInfo(text, directory.base);
      const originalPath = parsed?.problem ? null : parsed?.originalPath ?? null;
      slots.push({ id: entry.id, name: originalPath ? basename(originalPath) : entry.trashName, originalPath, root: directory.root, holder, holderReal, itemName: entry.trashName, infoPath });
    }
    if (!includeUnrecorded) continue;
    // Emptying takes everything in files/, recorded or not, and any record a reader could not pair.
    for (const name of await readdir(holder).catch(() => [] as string[])) {
      if (recorded.has(name) || name.startsWith(putBackWorkingPrefix) || name.includes("�")) continue;
      slots.push({ id: trashItemId(directory.root, name), name, originalPath: null, root: directory.root, holder, holderReal, itemName: name, infoPath: null });
      const record = join(directory.root, "info", `${name}.trashinfo`);
      if (await lstat(record).then(() => true, () => false)) slots[slots.length - 1]!.infoPath = record;
    }
    for (const entry of await readdir(join(directory.root, "info"), { withFileTypes: true }).catch(() => [])) {
      if (!entry.name.endsWith(".trashinfo") || entry.isDirectory()) continue;
      const trashName = entry.name.slice(0, -".trashinfo".length);
      const path = join(directory.root, "info", entry.name);
      if (!recorded.has(trashName) && !slots.some((slot) => slot.infoPath === path) && !strayRecords.includes(path)) strayRecords.push(path);
    }
  }
  return { slots, strayRecords };
}

async function macSlots(options: TrashOptions): Promise<TrashSlot[]> {
  const home = resolve(options.home ?? homedir());
  const uid = currentUid(options);
  const roots = [join(home, ".Trash")];
  const tops = options.macVolumeTops ?? await readdir("/Volumes").then((names) => names.filter((name) => !name.startsWith(".")).map((name) => join("/Volumes", name)), () => []);
  for (const top of tops) roots.push(join(top, ".Trashes", String(uid)));
  const slots: TrashSlot[] = [];
  for (const [index, root] of roots.entries()) {
    if (!await realDirectory(root)) continue;
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (index === 0 && (code === "EPERM" || code === "EACCES")) {
        throw new TrashError(403, "AmpleFile isn’t allowed to change the Trash. Allow Full Disk Access for AmpleFile in System Settings → Privacy & Security, or empty the Trash in Finder.");
      }
      continue;
    }
    const holderReal = await realpath(root).catch(() => null);
    if (!holderReal) continue;
    for (const name of names) {
      if (name === ".DS_Store" || name.includes("�")) continue;
      slots.push({ id: trashItemId(root, name), name, originalPath: null, root, holder: root, holderReal, itemName: name, infoPath: null });
    }
  }
  return slots;
}

/**
 * At the moment of removal: the trash folder and the folder holding the item
 * are still real folders (no link swapped in), resolve where they did when
 * the item was found, and the item is still there.
 */
async function stillInTrash(slot: TrashSlot): Promise<boolean> {
  if (!await realDirectory(slot.root) || !await realDirectory(slot.holder)) return false;
  if (await realpath(slot.holder).catch(() => null) !== slot.holderReal) return false;
  if (dirname(join(slot.holder, slot.itemName)) !== slot.holder) return false;
  return lstat(join(slot.holder, slot.itemName)).then(() => true, () => false);
}

async function removeSlot(slot: TrashSlot): Promise<void> {
  const path = join(slot.holder, slot.itemName);
  // Removes a link as a link, and a folder whatever its modes; nothing below it is followed.
  await removeOwnedItem(path);
  if (await lstat(path).then(() => true, () => false)) throw new TrashError(500, "Part of it could not be removed.");
  // The record goes after its item, so an interrupted removal never leaves an item without one.
  if (slot.infoPath) await unlink(slot.infoPath).catch((error: { code?: string }) => { if (error.code !== "ENOENT") throw error; });
}

function deletionMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "EACCES" || code === "EPERM") return "AmpleFile isn’t allowed to remove it.";
  if (code === "EBUSY") return "It is in use.";
  if (code === "EROFS") return "The drive it is on is read-only.";
  return error instanceof Error && error.message ? error.message : "It could not be removed.";
}

async function deleteSlots(slots: readonly TrashSlot[], operation: FileOperationControl, result: TrashDeletionResult): Promise<void> {
  operation.setTotals(slots.length, null);
  operation.stage("removing");
  for (const [index, slot] of slots.entries()) {
    try {
      await operation.boundary("item");
    } catch (error) {
      if (!isFileOperationCancelled(error)) throw error;
      result.cancelled = true;
      result.notDone = slots.slice(index).map((left) => left.id);
      return;
    }
    operation.current(slot.name);
    try {
      if (!await stillInTrash(slot)) {
        result.notFound.push(slot.id);
      } else {
        await removeSlot(slot);
        result.removed.push({ id: slot.id, name: slot.name, originalPath: slot.originalPath });
      }
    } catch (error) {
      result.failed.push({ id: slot.id, name: slot.name, error: deletionMessage(error) });
    }
    operation.itemsDone();
  }
}

/** Delete Immediately: removes the listed items with these ids for good. */
export async function deleteTrashItemsImmediately(
  ids: readonly string[],
  givenOptions: TrashOptions = {},
  operation: FileOperationControl = untrackedFileOperation,
): Promise<TrashDeletionResult> {
  const options = withTestOptions(givenOptions);
  const platform = options.platform ?? process.platform;
  const result: TrashDeletionResult = { removed: [], failed: [], notFound: [], strayRecordsRemoved: 0 };
  const wanted = [...new Set(ids)];
  const slots = platform === "linux" ? (await linuxSlots(options, false)).slots : platform === "darwin" ? await macSlots(options) : [];
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const chosen: TrashSlot[] = [];
  for (const id of wanted) {
    const slot = /^trash-[A-Za-z0-9_-]{27}$/.test(id) ? byId.get(id) : undefined;
    if (slot) chosen.push(slot);
    else result.notFound.push(id);
  }
  await deleteSlots(chosen, operation, result);
  return result;
}

/**
 * Empty Trash: removes everything in the system Trash for good. On Linux that
 * is every item in the home trash and each volume's trash, recorded or not,
 * with its record, then any leftover records and the folder-size cache. On
 * macOS it is every item in `~/.Trash` and each volume's `.Trashes/<uid>`.
 */
export async function emptySystemTrash(givenOptions: TrashOptions = {}, operation: FileOperationControl = untrackedFileOperation): Promise<TrashDeletionResult> {
  const options = withTestOptions(givenOptions);
  const platform = options.platform ?? process.platform;
  const result: TrashDeletionResult = { removed: [], failed: [], notFound: [], strayRecordsRemoved: 0 };
  if (platform === "darwin") {
    await deleteSlots(await macSlots(options), operation, result);
    return result;
  }
  if (platform !== "linux") return result;
  const { slots, strayRecords } = await linuxSlots(options, true);
  await deleteSlots(slots, operation, result);
  if (result.cancelled) return result;
  for (const record of strayRecords) {
    const info = await lstat(record).catch(() => null);
    if (!info || info.isDirectory()) continue;
    if (await unlink(record).then(() => true, () => false)) result.strayRecordsRemoved += 1;
  }
  // The folder-size cache describes items that are gone now.
  for (const directory of new Set(slots.map((slot) => slot.root))) {
    const cache = join(directory, "directorysizes");
    const info = await lstat(cache).catch(() => null);
    if (info && !info.isDirectory()) await unlink(cache).catch(() => undefined);
  }
  return result;
}
