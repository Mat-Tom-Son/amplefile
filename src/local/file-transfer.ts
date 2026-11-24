import { randomBytes } from "node:crypto";
import { constants as fsConstants, lstatSync, type Stats } from "node:fs";
import { access, chmod, copyFile, link, lstat, mkdir, open, readdir, readlink, rename, rm, rmdir, symlink, unlink, utimes } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { assertDiskSpace, watchDiskSpace } from "./disk-space.js";
import { untrackedFileOperation, type FileOperationControl } from "./file-operations.js";
import { extrasCopyLacks } from "./extended-attributes.js";
import { comparableContains, comparablePath } from "./path-comparison.js";
import { writeZip, type ZipWriterEntry } from "./zip-writer.js";

/**
 * The file manager's copy, paste, duplicate, move, and compress
 * (docs/product-model.md, "The file manager window"), as Finder does
 * them: nothing is ever replaced (a name already taken gets " copy", then
 * " copy 2"), a folder is never copied or moved into itself, and a copy never
 * carries a Connected Folder's identity (`.amplefile/`) with it.
 *
 * What a copy made here carries: each file's bytes, mode, and modification
 * time; each folder's mode and modification time; each link as written. It
 * does not carry extended attributes (a resource fork, Finder tags and
 * comments, a download's quarantine mark), access control lists, file flags
 * (hidden, locked), or creation dates: the runtime's file copy keeps none of
 * them, on any disk. So a move on one disk never copies: it renames
 * (`renameInto`), and the item goes with everything it has. A move across
 * disks copies, and its original is kept when it has something the copy
 * does not (src/local/extended-attributes.ts).
 */

/** Folders a copy or archive leaves behind: a Connected Folder's identity and History stay with the Connected Folder. */
const identityFolders = new Set([".amplefile"]);

/**
 * Finder's own note about a folder's window (icon places, the view), which
 * it writes whenever the folder is open in Finder. It is not what the folder
 * holds: History ignores it and Compress leaves it out. A copy carries the
 * one it finds, and the checks before an original goes do not ask about it,
 * so Finder rewriting it while a move runs does not keep the original back.
 */
const finderNote = ".DS_Store";

/** Whether a path is another one or inside it, as written: macOS and Windows disks ignore case and how an accent is spelled by default. */
export function isInside(parentPath: string, childPath: string): boolean {
  return comparableContains(comparablePath(parentPath), comparablePath(childPath));
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
  options: { withIdentity?: boolean; operation?: FileOperationControl; read?: CopiedSource } = {},
): Promise<TransferFileIdentity> {
  return copyTree(source, destination, copyFilter(source, options), options.operation ?? untrackedFileOperation, options.read);
}

/** The identity claimed when a copy creates its root. It survives a rename. */
export type TransferFileIdentity = Pick<Stats, "dev" | "ino">;

export function transferFileStillAt(path: string, expected: TransferFileIdentity): boolean {
  try {
    const current = lstatSync(path, { throwIfNoEntry: false });
    return current?.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

/**
 * One entry of a source as a copy read it: what it was, which file it was
 * (its inode), and for a file its size, modification time, and change time,
 * exactly as the disk gave them before its bytes were read, and when that
 * was (`readAt`). A folder keeps how many entries it had; a link, where it
 * pointed.
 */
export interface CopiedEntry { kind: "file" | "folder" | "link"; ino: number; size: number; mtimeMs: number; ctimeMs: number; readAt: number; link?: string; entries?: number }

/** What a copy read of its source, entry by entry, by path. */
export type CopiedSource = Map<string, CopiedEntry>;

/**
 * Whether a source is still the item a copy read (`read`, filled by
 * `copyItemTo`): every entry there now is one the copy read, the same file
 * (inode) at the same size, the same modification time, and the same change
 * time (which a write, a rename, or a change of mode or attributes moves
 * even when the modification time is put back), to the disk's own precision;
 * every link points where it did; and no folder gained or lost an entry. Nothing is allowed for a coarse clock here, unlike `copyHoldsAll`:
 * both readings are of the same file on the same disk. This is what a move
 * asks before an original goes, so a file written, added, or swapped while
 * the copy was made keeps the original where it is. Finder's `.DS_Store`
 * inside a folder is not asked about.
 *
 * A disk with a coarse clock (FAT keeps two seconds) cannot show a rewrite
 * at the same size within one tick of its clock: `filesTooFreshToTell` names
 * the files that were read that soon after they were written, for the
 * caller to compare byte for byte (`sameBytes`). A copy that left something
 * behind (an `.amplefile` folder without `withIdentity`) never passes.
 */
export async function sourceUnchanged(source: string, read: CopiedSource): Promise<boolean> {
  const was = read.get(source);
  const info = await lstat(source).catch(() => null);
  if (!was || !info || info.ino !== was.ino) return false;
  if (info.isSymbolicLink()) return was.kind === "link" && await readlink(source).catch(() => null) === was.link;
  if (info.isFile()) return was.kind === "file" && info.size === was.size && info.mtimeMs === was.mtimeMs && info.ctimeMs === was.ctimeMs;
  if (!info.isDirectory() || was.kind !== "folder") return false;
  const names = (await readdir(source).catch(() => null))?.filter((name) => name !== finderNote);
  if (!names || names.length !== was.entries) return false;
  for (const name of names) if (!await sourceUnchanged(join(source, name), read)) return false;
  return true;
}

/**
 * How coarse the clock that wrote a modification time looks, in
 * milliseconds: FAT keeps two seconds, HFS+ one, exFAT ten milliseconds,
 * and a disk that keeps nanoseconds almost never lands on a whole one.
 * Zero when the time is finer than a millisecond.
 */
function clockTick(mtimeMs: number): number {
  if (mtimeMs % 1 !== 0) return 0;
  return mtimeMs % 2000 === 0 ? 2000 : mtimeMs % 1000 === 0 ? 1000 : mtimeMs % 10 === 0 ? 10 : 1;
}

/**
 * The files at and under `source` that a copy read within one tick of the
 * clock that wrote their modification time. A rewrite at the same size in
 * that tick leaves the time as it was, so `sourceUnchanged` cannot tell;
 * each is to be compared with its copy byte for byte before the original
 * goes. On a disk that keeps fine times this is empty.
 */
export function filesTooFreshToTell(source: string, read: CopiedSource): string[] {
  const fresh: string[] = [];
  for (const path of moveReadPaths(source, read)) {
    const was = read.get(path)!;
    if (was.kind !== "file") continue;
    const tick = clockTick(was.mtimeMs);
    if (tick && was.readAt - was.mtimeMs < tick) fresh.push(path);
  }
  return fresh;
}

/** Whether two files hold the same bytes. */
export async function sameBytes(left: string, right: string): Promise<boolean> {
  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const [a, b] = await Promise.all([open(left, flags).catch(() => null), open(right, flags).catch(() => null)]);
  try {
    if (!a || !b) return false;
    const [leftBefore, rightBefore] = await Promise.all([a.stat(), b.stat()]);
    if (!leftBefore.isFile() || !rightBefore.isFile() || leftBefore.size !== rightBefore.size) return false;
    const one = Buffer.allocUnsafe(256 * 1024);
    const other = Buffer.allocUnsafe(256 * 1024);
    for (;;) {
      const [x, y] = await Promise.all([readFully(a, one), readFully(b, other)]);
      if (x !== y || one.compare(other, 0, y, 0, x) !== 0) return false;
      if (!x) break;
    }
    const [leftAfter, rightAfter] = await Promise.all([lstat(left), lstat(right)]);
    return sameFileSnapshot(leftBefore, leftAfter) && sameFileSnapshot(rightBefore, rightAfter);
  } catch {
    return false;
  } finally {
    await a?.close().catch(() => undefined);
    await b?.close().catch(() => undefined);
  }
}

function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** Fills `buffer` from a file, as far as the file goes; returns how much. */
async function readFully(file: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, null);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return filled;
}

/**
 * Moves an item into a folder on the same disk by renaming it: all at once,
 * with everything it has (its extended attributes, access control list,
 * flags, and dates are the item's own and go with it), and never onto an
 * item that took the name meanwhile, which gets the " copy" naming instead.
 * Returns where it landed. On another disk it fails with `EXDEV` and nothing
 * has changed.
 */
export async function renameInto(source: string, folder: string, name: string): Promise<string> {
  const info = await lstat(source);
  if (info.isDirectory()) return placeFolderWithoutReplacing(source, folder, name);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const destination = await freeDestination(folder, name);
    if (!info.isFile()) {
      // A link is renamed as the link it is; the name was free a moment ago.
      await rename(source, destination);
      return destination;
    }
    try {
      // A second name for the file claims the destination without replacing anything; then the old name goes.
      await link(source, destination);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "EEXIST") continue;
      if (code === "EXDEV") throw error;
      // A disk without hard links, or a file that cannot have another: the name was free a moment ago.
      await rename(source, destination);
      return destination;
    }
    try {
      await unlink(source);
    } catch (error) {
      // The item could not leave its folder, so it does not stay in the other one too.
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    return destination;
  }
  throw Object.assign(new Error(`There are too many copies of “${name}” here already.`), { status: 409, statusCode: 409 });
}

/** Whether an item and a folder are on one disk, so the item can be renamed into the folder. */
export async function onOneDisk(item: string, folder: string): Promise<boolean> {
  const [one, other] = await Promise.all([lstat(item).catch(() => null), lstat(folder).catch(() => null)]);
  return Boolean(one && other && one.dev === other.dev);
}

/**
 * After a removal of `source` failed: whether part of it went. True when
 * anything the copy read there is no longer there. A removal is not
 * all-or-nothing, so a failed one is asked this before anyone is told the
 * original is still where it was.
 */
export async function sourceLostPart(source: string, read: CopiedSource): Promise<boolean> {
  for (const path of moveReadPaths(source, read)) if (!await lstat(path).catch(() => null)) return true;
  return false;
}

/** The source entries a move verifies, excluding Finder's notes inside folders. */
export function* moveReadPaths(source: string, read: CopiedSource): IterableIterator<string> {
  const inside = source.endsWith(sep) ? source : `${source}${sep}`;
  for (const path of read.keys()) {
    if (path === source || (path.startsWith(inside) && basename(path) !== finderNote)) yield path;
  }
}

/**
 * The folder that stops `path` from being removed whole: its parent, or a
 * folder inside it that holds something, when this user cannot take entries
 * out of it or cannot read it. Null when nothing in sight stops it. Asked
 * before a move's original goes, so a folder marked read-only is found
 * while the original is still whole rather than halfway through removing it.
 * A locked file, or a folder another rule protects, is not seen here; a
 * removal that fails on one is asked `sourceLostPart`.
 */
export async function folderBlockingRemoval(path: string): Promise<string | null> {
  if (!await canTakeEntriesOut(dirname(path))) return dirname(path);
  return folderBlockingInside(path);
}

async function folderBlockingInside(path: string): Promise<string | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory()) return null;
  const names = await readdir(path).catch(() => null);
  if (!names) return path;
  if (names.length && !await canTakeEntriesOut(path)) return path;
  for (const name of names) {
    const blocked = await folderBlockingInside(join(path, name));
    if (blocked) return blocked;
  }
  return null;
}

function canTakeEntriesOut(folder: string): Promise<boolean> {
  return access(folder, fsConstants.W_OK | fsConstants.X_OK).then(() => true, () => false);
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
 * the copy carries it whole, like any other folder. Finder's `.DS_Store`
 * inside a folder is not asked about.
 */
export async function copyHoldsAll(source: string, copy: string, options: { withIdentity?: boolean } = {}): Promise<boolean> {
  return treeHeld(source, copy, { identity: options.withIdentity === true });
}

/** Compares the bytes and modes of everything a move must keep, and pins the copies it checked. */
export async function verifyMoveCopyContents(source: string, copy: string): Promise<Map<string, Stats> | null> {
  const checked = new Map<string, Stats>();
  return await treeHeld(source, copy, { identity: true, verifyContents: [], checked }) ? checked : null;
}

/** Whether the destination entries compared by a move still have the same identities, contents, and metadata. */
export async function checkedMoveCopyUnchanged(checked: ReadonlyMap<string, Stats>): Promise<boolean> {
  for (const [path, was] of checked) {
    const current = await lstat(path).catch(() => null);
    if (!current || current.dev !== was.dev || current.ino !== was.ino || current.mode !== was.mode
      || current.size !== was.size || current.mtimeMs !== was.mtimeMs || current.ctimeMs !== was.ctimeMs) return false;
  }
  return true;
}

/**
 * Whether an original and the copy a move left beside it still hold the
 * same things before Undo takes the copy away. Check the bytes, permissions,
 * links and metadata the copy holds. The original can retain metadata and
 * Connected Folder identity that the copy never received.
 */
export async function treesMatch(original: string, copy: string): Promise<boolean> {
  const [one, other] = await Promise.all([lstat(original).catch(() => null), lstat(copy).catch(() => null)]);
  if (!one || !other) return false;
  if (!await treeHeld(original, copy, { identity: "ignore" })) return false;
  const entries: string[] = [];
  if (!await treeHeld(copy, original, { identity: false, verifyContents: entries })) return false;
  return !await extrasCopyLacks(copy, original, entries);
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

/** Whether everything at `from` is also at `into`, the same. An `.amplefile` folder counts as held when carried whole (`identity`), never (`false`), or is not asked about (`"ignore"`). */
async function treeHeld(from: string, into: string, options: { identity: boolean | "ignore"; verifyContents?: string[]; checked?: Map<string, Stats> }): Promise<boolean> {
  const [original, other] = await Promise.all([lstat(from).catch(() => null), lstat(into).catch(() => null)]);
  if (!original) return !options.verifyContents;
  if (!other) return false;
  options.checked?.set(into, other);
  if (options.verifyContents) {
    if ((original.mode & 0o7777) !== (other.mode & 0o7777)) return false;
    options.verifyContents.push(from);
  }
  if (original.isSymbolicLink()) {
    if (!other.isSymbolicLink()) return false;
    const [written, copied] = await Promise.all([readlink(from).catch(() => null), readlink(into).catch(() => null)]);
    return written !== null && written === copied;
  }
  if (original.isFile()) {
    return other.isFile() && other.size === original.size
      && Math.abs(other.mtimeMs - original.mtimeMs) <= sameTimeToleranceMs
      && (!options.verifyContents || await sameBytes(from, into));
  }
  if (!original.isDirectory() || !other.isDirectory()) return false;
  for (const entry of await readdir(from)) {
    if (entry === finderNote) continue;
    if (identityFolders.has(entry) && options.identity === "ignore") continue;
    if (!options.identity && identityFolders.has(entry)) return false;
    if (!await treeHeld(join(from, entry), join(into, entry), options)) return false;
  }
  return true;
}

/**
 * Disks that keep coarse times (FAT keeps two seconds) may round a copied
 * time, so a copy's time may differ from its source's by this much. It is
 * for comparing a copy with its source only: whether the source itself
 * changed is asked exactly (`sourceUnchanged`).
 */
const sameTimeToleranceMs = 2_000;

/**
 * Copies to a destination that was free a moment ago, keeping modes,
 * modification times, and links as written. A copy that fails or is
 * cancelled partway takes back what it wrote, so a failed or stopped paste
 * or move never leaves a half-written item behind; a destination that turned
 * out to be taken is someone else's and stays.
 */
async function copyTree(source: string, destination: string, filter: ((path: string) => boolean) | undefined, operation: FileOperationControl, read?: CopiedSource): Promise<TransferFileIdentity> {
  let identity: TransferFileIdentity | undefined;
  const claimed = (path: string) => { if (!identity) identity = lstatSync(path); };
  try {
    await copyEntry(source, destination, filter, operation, claimed, read);
    if (!identity || !transferFileStillAt(destination, identity)) throw Error("The copy changed where it was being written.");
    return identity;
  } catch (error) {
    if (identity && transferFileStillAt(destination, identity)) await removeOwnedItem(destination).catch(() => undefined);
    throw error;
  }
}

/**
 * Files at least this large are copied a chunk at a time, so a cancel can
 * stop inside one; smaller ones are copied by the runtime in one call. A
 * tracked copy first asks for a clone, which is instant where the runtime
 * can make one; on the Mac it cannot (the request answers `ENOSYS`), so
 * every copy there writes the file's bytes. No copy made here keeps
 * extended attributes, by any of these ways.
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
  claimRoot: (path: string) => void,
  read?: CopiedSource,
): Promise<void> {
  await operation.boundary("item");
  // What the disk says of the entry before any of it is read: `read` keeps it (`sourceUnchanged`).
  const info = await lstat(source);
  const seen = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, readAt: Date.now() };
  operation.current(basename(source));
  const claimed = () => claimRoot(destination);
  if (info.isSymbolicLink()) {
    // A link is copied as written: pointing a relative link back into the
    // source would leave it dangling once a move removes the source.
    const target = await readlink(source);
    read?.set(source, { kind: "link", ...seen, link: target });
    await symlink(target, destination);
    claimed();
  } else if (info.isDirectory()) {
    await mkdir(destination);
    claimed();
    const entries = await readdir(source);
    read?.set(source, { kind: "folder", ...seen, entries: entries.filter((entry) => entry !== finderNote).length });
    for (const entry of entries) {
      const child = join(source, entry);
      if (filter && !filter(child)) continue;
      await copyEntry(child, join(destination, entry), filter, operation, claimRoot, entry === finderNote ? undefined : read);
    }
    // A copied folder keeps its date, as a copied file does; then its mode, which may be read-only.
    await utimes(destination, info.atime, info.mtime).catch(() => undefined);
    await chmod(destination, info.mode & 0o7777);
  } else if (info.isFile()) {
    read?.set(source, { kind: "file", ...seen });
    await copyFileEntry(source, destination, info, operation, claimed);
  } else {
    throw Object.assign(new Error(`“${basename(source)}” is a special file that can’t be copied.`), { code: "ERR_FS_CP_UNKNOWN" });
  }
  operation.itemsDone();
}

async function copyFileEntry(source: string, destination: string, info: Stats, operation: FileOperationControl, claimed: () => void): Promise<void> {
  // An untracked copy is a plain copy; a tracked one first asks for a clone, where the runtime can make one.
  if (operation.operationId && copyStrategy.clone) {
    const cloned = await copyFile(source, destination, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw error;
      return false;
    });
    if (cloned) {
      claimed();
      await utimes(destination, info.atime, info.mtime);
      operation.bytesDone(info.size);
      return;
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
      if (identityFolders.has(entry) || entry === finderNote) continue;
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
