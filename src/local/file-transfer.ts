import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, readdir, readlink, rename, rm, rmdir, symlink, utimes } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { assertDiskSpace, watchDiskSpace } from "./disk-space.js";
import { untrackedFileOperation, type FileOperationControl } from "./file-operations.js";
import { writeZip, type ZipWriterEntry } from "./zip-writer.js";

/**
 * The file manager's copy, paste, duplicate, move, and compress
 * (docs/product-model.md, "The file manager window"), as Finder does
 * them: nothing is ever replaced (a name already taken gets " copy", then
 * " copy 2"), a folder is never copied or moved into itself, and a copy never
 * carries a Connected Folder's identity (`.amplefile/`) with it.
 */

/** Folders a copy or archive leaves behind: a Connected Folder's identity and History stay with the Connected Folder. */
const identityFolders = new Set([".amplefile"]);

export function isInside(parentPath: string, childPath: string): boolean {
  const parent = comparison(parentPath);
  const child = comparison(childPath);
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** "report.pdf" → "report copy.pdf", then "report copy 2.pdf", as Finder names a duplicate. */
export function finderCopyName(name: string, attempt: number): string {
  const extension = name.startsWith(".") && !name.slice(1).includes(".") ? "" : extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} copy${attempt > 1 ? ` ${attempt}` : ""}${extension}`;
}

/** A free name in a folder: the item's own name when it is free (and not a duplicate), else Finder's copy names. */
export async function freeDestination(folder: string, name: string, options: { duplicate?: boolean } = {}): Promise<string> {
  if (!options.duplicate && !(await exists(join(folder, name)))) return join(folder, name);
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const candidate = join(folder, finderCopyName(name, attempt));
    if (!(await exists(candidate))) return candidate;
  }
  throw Object.assign(new Error(`There are too many copies of “${name}” here already.`), { status: 409, statusCode: 409 });
}

/**
 * Copies a file or folder into a folder and returns where it landed. The copy
 * leaves every `.amplefile` folder behind unless `withIdentity` is set, which
 * only a move does: the original is about to go, so its identity and Chats
 * travel with it instead of being duplicated.
 */
export async function copyInto(
  source: string,
  targetFolder: string,
  options: { duplicate?: boolean; withIdentity?: boolean; operation?: FileOperationControl } = {},
): Promise<string> {
  if (isInside(source, targetFolder)) throw badRequest(`“${basename(source)}” can’t be copied into itself.`);
  const destination = await freeDestination(targetFolder, basename(source), options);
  await copyTree(source, destination, copyFilter(source, options), options.operation ?? untrackedFileOperation);
  return destination;
}

/**
 * Copies a file or folder to a destination that is free, as `copyInto` does
 * once it has chosen the name: with modes, times, and links as written,
 * leaving `.amplefile` behind unless `withIdentity` is set, and taking back
 * what it wrote if it fails or is cancelled.
 */
export async function copyItemTo(
  source: string,
  destination: string,
  options: { withIdentity?: boolean; operation?: FileOperationControl } = {},
): Promise<void> {
  await copyTree(source, destination, copyFilter(source, options), options.operation ?? untrackedFileOperation);
}

/** What a copy of `source` leaves behind: every `.amplefile` folder unless it carries the identity. */
function copyFilter(source: string, options: { withIdentity?: boolean }): ((path: string) => boolean) | undefined {
  return options.withIdentity ? undefined : (path) => path === source || !identityFolders.has(basename(path));
}

/**
 * How much a copy of `source` writes: its files, folders, and links, and the
 * bytes of its files, leaving out what the copy leaves behind. A tracked
 * operation stops here at a cancel.
 */
export async function measureCopy(
  source: string,
  options: { withIdentity?: boolean; operation?: FileOperationControl } = {},
): Promise<{ items: number; bytes: number }> {
  const total = { items: 0, bytes: 0 };
  await measureTree(source, copyFilter(source, options), options.operation ?? untrackedFileOperation, total);
  return total;
}

async function measureTree(path: string, filter: ((path: string) => boolean) | undefined, operation: FileOperationControl, total: { items: number; bytes: number }): Promise<void> {
  if (filter && !filter(path)) return;
  const info = await lstat(path);
  total.items += 1;
  if (info.isFile()) total.bytes += info.size;
  if (!info.isDirectory()) return;
  await operation.boundary("item");
  for (const entry of await readdir(path)) await measureTree(join(path, entry), filter, operation, total);
}

/**
 * Whether a copy holds everything its source does, so the source can go with
 * nothing lost: every folder, every file at the same size and modification
 * time (the copy keeps timestamps), every link pointing where it did. An `.amplefile` folder
 * anywhere in the source never counts as held: a Connected Folder's identity
 * and Chats leave their source only by moving whole into Recently Deleted.
 * A source that is no longer there has nothing left to lose.
 *
 * `withIdentity` is for a source in a plain folder, which has no Recently
 * Deleted to leave through: an `.amplefile` folder then counts as held when
 * the copy carries it whole, like any other folder.
 */
export async function copyHoldsAll(source: string, copy: string, options: { withIdentity?: boolean } = {}): Promise<boolean> {
  return treeHeld(source, copy, { identity: options.withIdentity === true });
}

/**
 * After a move could not take an item out of its source: removes each
 * `.amplefile` folder from the item's copy whose counterpart in the source is
 * still there with the same files, so no identity exists twice. One whose
 * source counterpart is gone or different stays in the copy, which may be the
 * only place it is whole. Links are not followed.
 *
 * The copy is the move's own, so a read-only folder in it (a copy keeps its
 * source's modes) is made writable for the removal, and the folder holding the
 * identity gets its mode back afterwards. Returns the `.amplefile` folders, or
 * the folders it could not look inside, that may still hold an identity that
 * is also whole in the source; an empty list means none.
 */
export async function removeIdentityFoldersKeptAt(copy: string, source: string): Promise<string[]> {
  const info = await lstat(copy).catch(() => null);
  if (!info?.isDirectory()) return [];
  let entries: string[];
  try {
    entries = await readdir(copy);
  } catch {
    // A folder of the copy that cannot be read may hold an identity; only
    // say so when the source has something there to duplicate.
    return await lstat(source).then((item) => item.isDirectory(), () => false) ? [copy] : [];
  }
  const left: string[] = [];
  for (const entry of entries) {
    const copied = join(copy, entry);
    const original = join(source, entry);
    if (!identityFolders.has(entry)) { left.push(...await removeIdentityFoldersKeptAt(copied, original)); continue; }
    try {
      const originalInfo = await lstat(original).catch(() => null);
      if (!originalInfo?.isDirectory() || !await treeHeld(copied, original, { identity: true })) continue;
      await removeOwnedFolder(copy, copied);
    } catch {
      left.push(copied);
    }
  }
  return left;
}

/** Removes `path`, a folder inside `parent`, both written by this app, whatever modes they were copied with. */
async function removeOwnedFolder(parent: string, path: string): Promise<void> {
  const parentMode = (await lstat(parent)).mode & 0o7777;
  const parentWritable = (parentMode & 0o300) === 0o300;
  if (!parentWritable) await chmod(parent, parentMode | 0o300);
  const widened: Array<{ path: string; mode: number }> = [];
  try {
    await makeFoldersWritable(path, widened);
    await rm(path, { recursive: true, force: true });
  } finally {
    // Whatever a failed removal left keeps the modes it was copied with:
    // deepest first, so every folder is still reachable when its mode returns.
    for (const folder of widened.reverse()) await chmod(folder.path, folder.mode).catch(() => undefined);
    if (!parentWritable) await chmod(parent, parentMode).catch(() => undefined);
  }
}

/** Gives each folder at and under `path` u+rwx, recording the ones it changed. */
async function makeFoldersWritable(path: string, widened: Array<{ path: string; mode: number }>): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory()) return;
  const mode = info.mode & 0o7777;
  if ((mode & 0o700) !== 0o700) {
    await chmod(path, mode | 0o700);
    widened.push({ path, mode });
  }
  for (const entry of await readdir(path)) await makeFoldersWritable(join(path, entry), widened);
}

/** Whether everything at `from` is also at `into`, the same. */
async function treeHeld(from: string, into: string, options: { identity: boolean }): Promise<boolean> {
  const [original, other] = await Promise.all([lstat(from).catch(() => null), lstat(into).catch(() => null)]);
  if (!original) return true;
  if (!other) return false;
  if (original.isSymbolicLink()) {
    if (!other.isSymbolicLink()) return false;
    const [written, copied] = await Promise.all([readlink(from).catch(() => null), readlink(into).catch(() => null)]);
    return written !== null && written === copied;
  }
  if (original.isFile()) {
    return other.isFile() && other.size === original.size && Math.abs(other.mtimeMs - original.mtimeMs) <= sameTimeToleranceMs;
  }
  if (!original.isDirectory() || !other.isDirectory()) return false;
  for (const entry of await readdir(from)) {
    if (!options.identity && identityFolders.has(entry)) return false;
    if (!await treeHeld(join(from, entry), join(into, entry), options)) return false;
  }
  return true;
}

/** Disks that keep coarse times (FAT keeps two seconds) may round a copied time. */
const sameTimeToleranceMs = 2_000;

/** Moves a file or folder into a folder on the same computer (copying across disks), returning where it landed. */
export async function moveInto(source: string, targetFolder: string, operation: FileOperationControl = untrackedFileOperation): Promise<string> {
  if (isInside(source, targetFolder)) throw badRequest(`“${basename(source)}” can’t be moved into itself.`);
  const destination = await freeDestination(targetFolder, basename(source));
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as { code?: string }).code !== "EXDEV") throw error;
    // Across disks the item is copied, then its source goes. A cancel stops
    // only the copy, which takes back what it wrote; once the copy is whole
    // the move finishes, so the item is never in neither place.
    await copyTree(source, destination, undefined, withoutCounts(operation));
    await rm(source, { recursive: true, force: true });
  }
  return destination;
}

/** A move inside one place counts items, not what a copy across disks writes for one. */
function withoutCounts(operation: FileOperationControl): FileOperationControl {
  return {
    get operationId() { return operation.operationId; },
    get cancelRequested() { return operation.cancelRequested; },
    stage: (stage, options) => operation.stage(stage, options),
    addTotals: () => undefined,
    setTotals: () => undefined,
    current: (name) => operation.current(name),
    itemsDone: () => undefined,
    bytesDone: () => undefined,
    boundary: (point) => operation.boundary(point),
  };
}

/**
 * Copies to a destination that was free a moment ago, keeping modes,
 * modification times, and links as written. A copy that fails or is
 * cancelled partway takes back what it wrote, so a failed or stopped paste
 * or move never leaves a half-written item behind; a destination that turned
 * out to be taken is someone else's and stays.
 */
async function copyTree(source: string, destination: string, filter: ((path: string) => boolean) | undefined, operation: FileOperationControl): Promise<void> {
  const written = { root: false };
  try {
    await copyEntry(source, destination, filter, operation, written);
  } catch (error) {
    if (written.root) await removeOwnedItem(destination).catch(() => undefined);
    throw error;
  }
}

/**
 * Files at least this large are copied a chunk at a time, so a cancel can
 * stop inside one; smaller ones, and any the disk can clone, are copied by
 * the system in one call, which keeps their extended attributes.
 */
const copyStrategy = { clone: true, streamAboveBytes: 8 * 1024 * 1024, chunkBytes: 1024 * 1024 };

/** Tests only: whether copies may clone, and from what size a file is copied a chunk at a time. */
export function setFileCopyStrategyForTests(strategy: Partial<typeof copyStrategy> | null): void {
  Object.assign(copyStrategy, { clone: true, streamAboveBytes: 8 * 1024 * 1024, chunkBytes: 1024 * 1024 }, strategy ?? {});
}

async function copyEntry(
  source: string,
  destination: string,
  filter: ((path: string) => boolean) | undefined,
  operation: FileOperationControl,
  written: { root: boolean },
): Promise<void> {
  await operation.boundary("item");
  const info = await lstat(source);
  operation.current(basename(source));
  const claimed = () => { written.root = true; };
  if (info.isSymbolicLink()) {
    // A link is copied as written: pointing a relative link back into the
    // source would leave it dangling once a move removes the source.
    await symlink(await readlink(source), destination);
    claimed();
  } else if (info.isDirectory()) {
    await mkdir(destination);
    claimed();
    for (const entry of await readdir(source)) {
      const child = join(source, entry);
      if (filter && !filter(child)) continue;
      await copyEntry(child, join(destination, entry), filter, operation, written);
    }
    await chmod(destination, info.mode & 0o7777);
  } else if (info.isFile()) {
    await copyFileEntry(source, destination, info, operation, claimed);
  } else {
    throw Object.assign(new Error(`“${basename(source)}” is a special file that can’t be copied.`), { code: "ERR_FS_CP_UNKNOWN" });
  }
  operation.itemsDone();
}

async function copyFileEntry(source: string, destination: string, info: Stats, operation: FileOperationControl, claimed: () => void): Promise<void> {
  // An untracked copy is today's plain copy; a tracked one first tries a clone, which is instant.
  if (operation.operationId && copyStrategy.clone) {
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE);
      claimed();
      await utimes(destination, info.atime, info.mtime);
      operation.bytesDone(info.size);
      return;
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") throw error;
      await rm(destination, { force: true }).catch(() => undefined);
    }
  }
  if (!operation.operationId || info.size < copyStrategy.streamAboveBytes) {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    claimed();
    await keepTimes(destination, info);
    operation.bytesDone(info.size);
    return;
  }
  const input = await open(source, "r");
  try {
    const output = await open(destination, "wx", 0o600);
    claimed();
    try {
      const buffer = Buffer.allocUnsafe(copyStrategy.chunkBytes);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        for (let offset = 0; offset < bytesRead;) offset += (await output.write(buffer, offset, bytesRead - offset)).bytesWritten;
        operation.bytesDone(bytesRead);
        await operation.boundary("chunk");
      }
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
  await utimes(destination, info.atime, info.mtime);
  await chmod(destination, info.mode & 0o7777);
}

/** A copied file keeps its source's times; a read-only one is opened for the change and given its mode back. */
async function keepTimes(path: string, info: Stats): Promise<void> {
  try {
    await utimes(path, info.atime, info.mtime);
  } catch (error) {
    if ((error as { code?: string }).code !== "EPERM" && (error as { code?: string }).code !== "EACCES") throw error;
    await chmod(path, (info.mode & 0o7777) | 0o200);
    await utimes(path, info.atime, info.mtime);
    await chmod(path, info.mode & 0o7777);
  }
}

/** Removes an item this app wrote (a partial copy, or a copy it takes back), whatever modes it was copied with. */
export async function removeOwnedItem(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (!info.isDirectory()) { await rm(path, { force: true }); return; }
  await removeOwnedFolder(dirname(path), path);
}

/**
 * Compress, as Finder's: one item becomes "name.zip" beside it, several become
 * "Archive.zip", and a name already taken gets " copy" or a number. The
 * archive streams to a hidden file beside it, one file read at a time, and
 * takes its name only once complete, so a failed, refused, or cancelled
 * Compress leaves nothing behind. Any size compresses (the archive takes the
 * 64-bit zip records it needs); the disk guard (src/local/disk-space.ts)
 * refuses to start on a nearly full disk and stops before filling it.
 */
export async function compressInto(
  sources: readonly string[],
  targetFolder: string,
  operation: FileOperationControl = untrackedFileOperation,
): Promise<string> {
  if (!sources.length) throw badRequest("Choose items to compress.");
  const entries: ZipWriterEntry[] = [];
  const total = { bytes: 0 };
  for (const source of sources) await collectArchiveEntries(source, basename(source), entries, total, operation);
  operation.setTotals(entries.length, total.bytes);
  await assertDiskSpace(targetFolder, 0, "compress these items");
  operation.stage("compressing");
  const name = sources.length === 1 ? `${basename(sources[0]!)}.zip` : "Archive.zip";
  await removeAbandonedWorkingItems(targetFolder, compressWorkingPrefix);
  const working = claimWorkingPath(targetFolder, compressWorkingPrefix);
  try {
    const output = await open(working.path, "wx", 0o644);
    try {
      await writeZip(entries, output, operation, watchDiskSpace(targetFolder, "finish compressing"));
    } finally {
      await output.close();
    }
    operation.stage("finishing");
    return await placeWithoutReplacing(working.path, targetFolder, name);
  } finally {
    working.release();
    await rm(working.path, { force: true }).catch(() => undefined);
  }
}

const compressWorkingPrefix = ".AmpleFile-compress-";
/** The hidden working folder an Extract writes into before it takes its name. */
export const extractWorkingPrefix = ".AmpleFile-extract-";
const workingSuffix = ".partial";
/** Working files and folders this process is writing right now. */
const writingNow = new Set<string>();
/** A working file untouched this long belongs to a Compress or Extract that ended without finishing (the app quit or crashed). */
export const abandonedCompressAfterMs = 10 * 60 * 1_000;

/** A new hidden working name in `folder`, marked as being written by this process until `release` runs. */
export function claimWorkingPath(folder: string, prefix: string): { path: string; release: () => void } {
  const path = join(folder, `${prefix}${randomBytes(8).toString("hex")}${workingSuffix}`);
  writingNow.add(resolve(path));
  return { path, release: () => { writingNow.delete(resolve(path)); } };
}

/**
 * Removes the hidden working files and folders a Compress or Extract left in
 * a folder when the app quit or crashed partway. One being written now, here
 * or by another running copy of the app (it keeps changing), is left alone.
 */
export async function removeAbandonedWorkingItems(folder: string, prefix: string): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(workingSuffix)) continue;
    const path = join(folder, name);
    if (writingNow.has(resolve(path))) continue;
    const info = await lstat(path).catch(() => null);
    if (!info || (!info.isFile() && !info.isDirectory()) || Date.now() - info.mtimeMs < abandonedCompressAfterMs) continue;
    await removeOwnedItem(path).catch(() => undefined);
  }
}

async function collectArchiveEntries(
  path: string,
  name: string,
  entries: ZipWriterEntry[],
  total: { bytes: number },
  operation: FileOperationControl,
): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    // Stored as the link it is, never what it points to.
    entries.push({ kind: "link", name, target: await readlink(path), date: info.mtime });
    return;
  }
  if (!info.isDirectory() && !info.isFile()) return;
  if (info.isDirectory()) {
    entries.push({ kind: "folder", name, date: info.mtime, mode: info.mode & 0o7777 });
    await operation.boundary("item");
    for (const entry of (await readdir(path)).sort()) {
      if (identityFolders.has(entry) || entry === ".DS_Store") continue;
      await collectArchiveEntries(join(path, entry), `${name}/${entry}`, entries, total, operation);
    }
    return;
  }
  total.bytes += info.size;
  entries.push({ kind: "file", name, path, date: info.mtime, mode: info.mode & 0o7777, size: info.size });
}

/** Gives a finished file its name, the first free one, never replacing an item that took it meanwhile. */
export async function placeWithoutReplacing(file: string, folder: string, name: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const destination = await freeDestination(folder, name);
    try {
      await link(file, destination);
      return destination;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "EEXIST") continue;
      // A disk without hard links: the name was free a moment ago.
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV") throw error;
      await rename(file, destination);
      return destination;
    }
  }
  throw Object.assign(new Error(`There are too many copies of “${name}” here already.`), { status: 409, statusCode: 409 });
}

/**
 * Gives a finished folder its name, the first free one, never replacing an
 * item that took it meanwhile: the name is claimed with an empty folder
 * first, which only this rename then replaces. A claim someone wrote into
 * meanwhile is theirs; the next name is tried.
 */
export async function placeFolderWithoutReplacing(folderPath: string, parent: string, name: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const destination = await freeDestination(parent, name);
    try {
      await mkdir(destination);
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") continue;
      throw error;
    }
    try {
      await rename(folderPath, destination);
      return destination;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") {
        await rmdir(destination).catch(() => undefined);
        throw error;
      }
    }
  }
  throw Object.assign(new Error(`There are too many copies of “${name}” here already.`), { status: 409, statusCode: 409 });
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${bytes} bytes`;
}

/** A path inside a root as the API names it: forward slashes, no leading slash. */
export function relativeTo(root: string, path: string): string {
  return relative(root, path).split(sep).filter(Boolean).join("/");
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400, statusCode: 400 });
}


/** macOS and Windows disks ignore case by default. */
function comparison(value: string): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "") || sep;
  return process.platform === "linux" ? resolved : resolved.toLocaleLowerCase();
}
