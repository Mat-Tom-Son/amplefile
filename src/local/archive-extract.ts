import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, symlink, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, posix, sep } from "node:path";
import type { Readable } from "node:stream";
import { createGunzip, createInflateRaw, crc32 } from "node:zlib";

import { assertDiskSpace, watchDiskSpace } from "./disk-space.js";
import {
  claimWorkingPath,
  extractWorkingPrefix,
  placeFolderWithoutReplacing,
  removeAbandonedWorkingItems,
  removeOwnedItem,
} from "./file-transfer.js";
import { untrackedFileOperation, type FileOperationControl } from "./file-operations.js";

/**
 * Extract: an archive becomes a new folder beside it, named after it
 * ("Photos.zip" → "Photos"; a taken name gets " copy" unless the caller chose
 * otherwise, src/local/file-conflicts.ts). The folder is written under a
 * hidden working name and takes its name only once complete, so a refused,
 * failed, or cancelled Extract leaves nothing behind. An archive whose whole
 * content is one folder of that same name fills the new folder with that
 * folder's content, so compressing a folder and extracting the archive gives
 * the folder back.
 *
 * Every archive is treated as hostile:
 * - an entry that would land outside the new folder (an absolute path, a
 *   drive letter, `..`) refuses the whole archive;
 * - a symbolic link is made only when it points inside the new folder (it is
 *   checked again once made); hard links and special files are left out;
 * - nothing is written into `.amplefile/` or `.pi/`;
 * - a file keeps the execute bits the archive records, never a set-id or
 *   sticky bit and never more than 0755; folders are 0755;
 * - a zip entry that inflates past the size it declares, or whose checksum
 *   does not match, refuses the archive; and
 * - the disk guard (src/local/disk-space.ts) refuses to start when the
 *   archive's declared size does not fit and stops before the disk fills.
 */

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

/** Why an entry was left out. */
export type ExtractSkipReason = "link" | "hard-link" | "special" | "configuration" | "repeat";

/** What an Extract wrote and what it left out. */
export interface ExtractResult {
  /** The new folder. */
  folder: string;
  files: number;
  folders: number;
  links: number;
  bytes: number;
  /**
   * Entries left out: a symbolic link pointing outside the new folder (`link`),
   * hard links, special files, Connected Folder or Pi configuration, and
   * repeats of a name already written.
   */
  skipped: Array<{ path: string; reason: ExtractSkipReason }>;
}

/** An extraction finished under its working name, not yet given its own. */
export interface StagedExtract extends Omit<ExtractResult, "folder"> {
  /** The folder holding what was extracted, inside the hidden working folder. */
  folder: string;
  /** The name it takes: the archive's, without its extension. */
  name: string;
  /** The folder the archive is in, where the new folder goes. */
  parent: string;
  /** Removes whatever is left of the working folder. */
  discard(): Promise<void>;
}

/** The archive format a file's name says, or null when Extract cannot open it. */
export function archiveFormat(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  return null;
}

/** The folder an archive extracts into: its name without the archive's extension. */
export function extractFolderName(name: string): string {
  const lower = name.toLowerCase();
  for (const extension of [".tar.gz", ".tgz", ".tar", ".zip"]) {
    if (lower.endsWith(extension) && name.length > extension.length) return name.slice(0, -extension.length);
  }
  return `${name} folder`;
}

/** Checks that `archive` is one Extract opens, before anything is written. */
export async function assertExtractable(archive: string): Promise<void> {
  if (!archiveFormat(basename(archive))) throw badRequest("AmpleFile can extract .zip, .tar, .tar.gz, and .tgz archives.");
  const info = await lstat(archive).catch(() => null);
  if (!info?.isFile()) throw badRequest(`“${basename(archive)}” isn’t an archive file.`);
}

/** Extracts `archive` into a new folder beside it and returns what it wrote. */
export async function extractArchive(archive: string, operation: FileOperationControl = untrackedFileOperation): Promise<ExtractResult> {
  const staged = await stageExtract(archive, operation);
  try {
    operation.stage("finishing");
    const folder = await placeFolderWithoutReplacing(staged.folder, staged.parent, staged.name);
    const { discard: _discard, name: _name, parent: _parent, ...result } = staged;
    return { ...result, folder };
  } finally {
    await staged.discard();
  }
}

/** Extracts `archive` under a hidden working name beside it; the caller places it and then discards what is left. */
export async function stageExtract(archive: string, operation: FileOperationControl = untrackedFileOperation): Promise<StagedExtract> {
  await assertExtractable(archive);
  const format = archiveFormat(basename(archive))!;
  const info = await lstat(archive);
  const parent = dirname(archive);
  const name = extractFolderName(basename(archive));
  await removeAbandonedWorkingItems(parent, extractWorkingPrefix);
  const working = claimWorkingPath(parent, extractWorkingPrefix);
  const discard = async () => {
    working.release();
    await removeOwnedItem(working.path).catch(() => undefined);
  };
  try {
    await mkdir(working.path, { mode: 0o755 });
    const writer = new ExtractWriter(working.path, operation, watchDiskSpace(parent, "finish extracting this archive"));
    operation.setTotals(null, info.size);
    if (format === "zip") await readZip(archive, info.size, writer, operation);
    else {
      // A tar holds about as much as it measures; a gzipped one cannot say until it is read.
      if (format === "tar") await assertDiskSpace(parent, info.size, "extract this archive");
      operation.stage("extracting");
      await readTar(archive, format === "tar.gz", writer, operation);
    }
    await writer.finishLinks();
    const inside = await readdir(working.path);
    const collapsed = inside.length === 1 && inside[0] === name && (await lstat(join(working.path, name))).isDirectory();
    return {
      folder: collapsed ? join(working.path, name) : working.path,
      name,
      parent,
      files: writer.files,
      folders: writer.folders,
      links: writer.links,
      bytes: writer.bytes,
      skipped: writer.skipped,
      discard,
    };
  } catch (error) {
    await discard();
    throw error;
  }
}

/** Folder names an archive never writes into: a Connected Folder's identity and Pi's project configuration. */
const configurationFolders = new Set([".amplefile", ".pi"]);

/**
 * The path segments an archive entry names, or why it is left out. An entry
 * that would land outside the new folder throws: such an archive is refused
 * whole, not mended.
 */
export function archiveEntrySegments(raw: string): { segments: string[] } | { skip: "configuration" | "metadata" } {
  if (raw.includes("\0")) throw refusedEntry(raw);
  // Some zip tools write Windows separators; read them as separators so a
  // "..\\" cannot pass as a name.
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw refusedEntry(raw);
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) throw refusedEntry(raw);
  if (segments.some((segment) => configurationFolders.has(segment.toLowerCase()))) return { skip: "configuration" };
  // The resource forks a Mac's Archive Utility stores beside each file.
  if (segments[0] === "__MACOSX") return { skip: "metadata" };
  return { segments };
}

/**
 * Whether a symbolic link at `segments` pointing at `target` stays inside the
 * new folder as written: a relative target that never climbs above the top
 * and never names configuration.
 */
export function linkStaysInside(segments: readonly string[], target: string): boolean {
  if (!target || target.includes("\0") || target.includes("\\") || target.startsWith("/") || /^[A-Za-z]:/.test(target)) return false;
  const resolved = posix.normalize(posix.join(...segments.slice(0, -1), target));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) return false;
  return !resolved.split("/").some((segment) => configurationFolders.has(segment.toLowerCase()));
}

function refusedEntry(raw: string): Error {
  const shown = raw.replace(/\0/g, "␀").slice(0, 200);
  return badRequest(`This archive has an item that would land outside its folder (“${shown}”). Nothing was extracted.`);
}

type EntryKind = "file" | "folder" | "link" | "hard-link" | "special";

/** The longest link target Extract reads. */
const maxLinkTargetBytes = 4096;

/** Writes entries into the working folder. */
class ExtractWriter {
  files = 0;
  folders = 0;
  links = 0;
  bytes = 0;
  readonly skipped: ExtractResult["skipped"] = [];
  private readonly made = new Set<string>();
  private readonly pendingLinks: Array<{ rawPath: string; segments: string[]; target: string }> = [];

  constructor(
    private readonly root: string,
    private readonly operation: FileOperationControl,
    private readonly watchDisk: (bytes: number) => Promise<void>,
  ) {}

  /**
   * Opens an entry: null when it is left out, else where its bytes go (a
   * folder needs none). Folders an entry sits in are made as needed.
   */
  async begin(rawPath: string, kind: Exclude<EntryKind, "link">): Promise<FileHandle | null | "folder"> {
    const read = archiveEntrySegments(rawPath);
    if ("skip" in read) {
      if (read.skip === "configuration" && kind !== "folder") this.skipped.push({ path: rawPath, reason: "configuration" });
      return null;
    }
    if (kind === "hard-link" || kind === "special") {
      this.skipped.push({ path: rawPath, reason: kind });
      return null;
    }
    const { segments } = read;
    if (!segments.length) return null;
    await this.ensureFolders(segments.slice(0, kind === "folder" ? segments.length : -1));
    if (kind === "folder") return "folder";
    const target = join(this.root, ...segments);
    this.operation.current(segments.at(-1)!);
    try {
      const handle = await open(target, "wx", 0o600);
      this.files += 1;
      return handle;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      this.skipped.push({ path: rawPath, reason: "repeat" });
      return null;
    }
  }

  /** Closes a file and gives it its mode: readable by all, writable by its owner, executable where the archive says. */
  async finishFile(handle: FileHandle, archivedMode: number): Promise<void> {
    await handle.chmod(0o644 | (archivedMode & 0o111));
    await handle.close();
  }

  /** Notes a symbolic link, made once every file is written so no write ever passes through one. */
  addLink(rawPath: string, target: string): void {
    const read = archiveEntrySegments(rawPath);
    if ("skip" in read) {
      if (read.skip === "configuration") this.skipped.push({ path: rawPath, reason: "configuration" });
      return;
    }
    if (!read.segments.length) return;
    if (!linkStaysInside(read.segments, target)) {
      this.skipped.push({ path: rawPath, reason: "link" });
      return;
    }
    this.pendingLinks.push({ rawPath, segments: read.segments, target });
  }

  /**
   * Makes the links, then checks where each really leads: one that reaches
   * outside the new folder through another link is removed and reported.
   */
  async finishLinks(): Promise<void> {
    const made: Array<{ rawPath: string; path: string }> = [];
    for (const link of this.pendingLinks) {
      const path = join(this.root, ...link.segments);
      if (!await this.foldersAreReal(link.segments.slice(0, -1))) {
        this.skipped.push({ path: link.rawPath, reason: "link" });
        continue;
      }
      await this.ensureFolders(link.segments.slice(0, -1));
      try {
        await symlink(link.target, path);
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
        this.skipped.push({ path: link.rawPath, reason: "repeat" });
        continue;
      }
      made.push({ rawPath: link.rawPath, path });
    }
    const root = await realpath(this.root);
    for (const link of made) {
      let leadsInside = true;
      try {
        const real = await realpath(link.path);
        leadsInside = real === root || real.startsWith(`${root}${sep}`);
      } catch (error) {
        // A link to something the archive did not hold stays, as written; a loop does not.
        leadsInside = (error as { code?: string }).code === "ENOENT";
      }
      if (leadsInside) { this.links += 1; continue; }
      await unlink(link.path);
      this.skipped.push({ path: link.rawPath, reason: "link" });
    }
  }

  /** Counts bytes about to be written and checks the disk now and then. */
  async wrote(count: number): Promise<void> {
    this.bytes += count;
    await this.watchDisk(count);
  }

  private async foldersAreReal(segments: readonly string[]): Promise<boolean> {
    let path = this.root;
    for (const segment of segments) {
      path = join(path, segment);
      const info = await lstat(path).catch(() => null);
      if (info && !info.isDirectory()) return false;
    }
    return true;
  }

  private async ensureFolders(segments: readonly string[]): Promise<void> {
    let path = this.root;
    for (const segment of segments) {
      path = join(path, segment);
      if (this.made.has(path)) continue;
      const existing = await lstat(path).catch(() => null);
      if (existing && !existing.isDirectory()) throw badRequest(`This archive is damaged: “${segment}” is both a file and a folder. Nothing was extracted.`);
      if (!existing) {
        await mkdir(path, { mode: 0o755 });
        this.folders += 1;
      }
      this.made.add(path);
    }
  }
}

/** Writes all of `chunk`, counting it first. */
async function writeChunk(handle: FileHandle, writer: ExtractWriter, chunk: Buffer): Promise<void> {
  await writer.wrote(chunk.length);
  for (let offset = 0; offset < chunk.length;) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
}

// ---- zip ----

interface ZipEntry {
  name: string;
  kind: EntryKind;
  mode: number;
  method: number;
  encrypted: boolean;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

/** The most central directory Extract reads: room for some two million entries. */
const maxCentralDirectoryBytes = 256 * 1024 * 1024;

async function readZip(archive: string, archiveSize: number, writer: ExtractWriter, operation: FileOperationControl): Promise<void> {
  const handle = await open(archive, "r");
  try {
    const entries = await readZipDirectory(handle, archiveSize);
    operation.setTotals(entries.length, archiveSize);
    // The sizes an archive declares are checked as each entry inflates.
    await assertDiskSpace(dirname(archive), entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.size : 0), 0), "extract this archive");
    operation.stage("extracting");
    for (const entry of entries) {
      await operation.boundary("entry");
      await extractZipEntry(archive, archiveSize, handle, entry, writer, operation);
      operation.itemsDone();
    }
  } finally {
    await handle.close();
  }
}

async function extractZipEntry(
  archive: string,
  archiveSize: number,
  handle: FileHandle,
  entry: ZipEntry,
  writer: ExtractWriter,
  operation: FileOperationControl,
): Promise<void> {
  if (entry.encrypted && (entry.kind === "file" || entry.kind === "link")) throw badRequest("This archive is protected with a password. Nothing was extracted; open it in Finder instead.");
  if (entry.kind === "link") {
    if (entry.size > maxLinkTargetBytes) { writer.addLink(entry.name, ""); return; }
    const chunks: Buffer[] = [];
    await readZipData(archive, archiveSize, handle, entry, operation, async (chunk) => { chunks.push(chunk); });
    writer.addLink(entry.name, Buffer.concat(chunks).toString("utf8"));
    return;
  }
  const target = await writer.begin(entry.name, entry.kind);
  if (target === "folder" || target === null) {
    operation.bytesDone(entry.compressedSize);
    return;
  }
  let finished = false;
  try {
    await readZipData(archive, archiveSize, handle, entry, operation, (chunk) => writeChunk(target, writer, chunk));
    await writer.finishFile(target, entry.mode);
    finished = true;
  } finally {
    if (!finished) await target.close().catch(() => undefined);
  }
}

/** Inflates one entry's data, checking it against the size and checksum the archive declares. */
async function readZipData(
  archive: string,
  archiveSize: number,
  handle: FileHandle,
  entry: ZipEntry,
  operation: FileOperationControl,
  take: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  if (entry.method !== 0 && entry.method !== 8) throw badRequest("This archive uses a kind of compression AmpleFile can’t open. Nothing was extracted; open it in Finder instead.");
  const header = await readAt(handle, entry.localHeaderOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== 0x04034b50) throw damaged();
  const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressedSize > archiveSize) throw damaged();
  let written = 0;
  let crc = 0;
  if (entry.compressedSize) {
    const raw = createReadStream(archive, { start, end: start + entry.compressedSize - 1, highWaterMark: 256 * 1024 });
    const inflating = entry.method === 8;
    // Progress counts the archive's bytes as they are read.
    if (inflating) raw.on("data", (chunk) => operation.bytesDone(chunk.length));
    const content: Readable = inflating ? raw.pipe(createInflateRaw()) : raw;
    raw.once("error", (error) => content.destroy(error));
    try {
      for await (const chunk of content as AsyncIterable<Buffer>) {
        if (!inflating) operation.bytesDone(chunk.length);
        written += chunk.length;
        // An entry that inflates past the size it declares is damaged or a bomb.
        if (written > entry.size) throw damaged();
        crc = crc32(chunk, crc);
        await take(chunk);
        await operation.boundary("chunk");
      }
    } finally {
      raw.destroy();
      content.destroy();
    }
  }
  if (written !== entry.size || crc !== entry.crc) throw damaged();
}

async function readZipDirectory(handle: FileHandle, size: number): Promise<ZipEntry[]> {
  // The end record sits in the last 22 bytes plus a comment of up to 65,535.
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = await readAt(handle, size - tailLength, tailLength);
  let end = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) throw badRequest("This isn’t a zip archive AmpleFile can read. Nothing was extracted.");
  let disk = tail.readUInt16LE(end + 4);
  let directoryDisk = tail.readUInt16LE(end + 6);
  let count = tail.readUInt16LE(end + 10);
  let directorySize = tail.readUInt32LE(end + 12);
  let directoryOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    // The 64-bit end record, found through its locator just before the end record.
    const locatorAt = size - tailLength + end - 20;
    if (locatorAt < 0) throw damaged();
    const locator = await readAt(handle, locatorAt, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50) throw damaged();
    const zip64At = safeNumber(locator.readBigUInt64LE(8));
    const zip64 = await readAt(handle, zip64At, 56);
    if (zip64.length < 56 || zip64.readUInt32LE(0) !== 0x06064b50) throw damaged();
    disk = zip64.readUInt32LE(16);
    directoryDisk = zip64.readUInt32LE(20);
    count = safeNumber(zip64.readBigUInt64LE(32));
    directorySize = safeNumber(zip64.readBigUInt64LE(40));
    directoryOffset = safeNumber(zip64.readBigUInt64LE(48));
  }
  if (disk !== 0 || directoryDisk !== 0) throw badRequest("This archive is split across several files. Nothing was extracted; open it in Finder instead.");
  if (directorySize > maxCentralDirectoryBytes || directoryOffset + directorySize > size || count * 46 > directorySize) throw damaged();
  const directory = await readAt(handle, directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw damaged();
    const madeBy = directory.readUInt16LE(at + 4) >> 8;
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const crc = directory.readUInt32LE(at + 16);
    let compressedSize = directory.readUInt32LE(at + 20);
    let uncompressedSize = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const externalAttributes = directory.readUInt32LE(at + 38);
    let localHeaderOffset = directory.readUInt32LE(at + 42);
    const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
    const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    if (at + 46 + nameLength + extraLength + commentLength > directory.length) throw damaged();
    // 64-bit sizes and offset, in that order, for each field that overflowed.
    for (let field = 0; field + 4 <= extra.length;) {
      const id = extra.readUInt16LE(field);
      const length = extra.readUInt16LE(field + 2);
      if (id === 0x0001) {
        let read = field + 4;
        const next = () => {
          if (read + 8 > field + 4 + length) throw damaged();
          const value = safeNumber(extra.readBigUInt64LE(read));
          read += 8;
          return value;
        };
        if (uncompressedSize === 0xffffffff) uncompressedSize = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = next();
      }
      field += 4 + length;
    }
    const name = decodeName(nameBytes, (flags & 0x800) !== 0);
    // A Unix-made entry keeps its file type and mode in the high bits of its attributes.
    const unixMode = madeBy === 3 ? externalAttributes >>> 16 : 0;
    const type = unixMode & 0o170000;
    const kind: EntryKind = type === 0o120000 ? "link"
      : type === 0o040000 || name.endsWith("/") || name.endsWith("\\") ? "folder"
      : type === 0 || type === 0o100000 ? "file"
      : "special";
    entries.push({ name, kind, mode: unixMode & 0o7777, method, encrypted: (flags & 1) !== 0, crc, compressedSize, size: uncompressedSize, localHeaderOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** A zip name: UTF-8 when flagged or when it reads as UTF-8, else the old single-byte encoding as Latin-1. */
function decodeName(bytes: Buffer, utf8: boolean): string {
  if (utf8) return bytes.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (!bytesRead) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged();
  return Number(value);
}

// ---- tar ----

/** The most a tar header record (a long name, extended attributes) may hold. */
const maxTarHeaderRecordBytes = 1024 * 1024;

async function readTar(archive: string, gzipped: boolean, writer: ExtractWriter, operation: FileOperationControl): Promise<void> {
  const raw = createReadStream(archive, { highWaterMark: 256 * 1024 });
  // Progress counts the archive's bytes as they are read.
  if (gzipped) raw.on("data", (chunk) => operation.bytesDone(chunk.length));
  const content: Readable = gzipped ? raw.pipe(createGunzip()) : raw;
  raw.once("error", (error) => content.destroy(error));
  const blocks = new BlockReader(content[Symbol.asyncIterator]() as AsyncIterator<Buffer>, gzipped ? undefined : (length) => operation.bytesDone(length));
  try {
    let longName: string | null = null;
    let longLink: string | null = null;
    let pax: Record<string, string> = {};
    for (;;) {
      await operation.boundary("entry");
      const header = await blocks.read(512);
      if (!header) break;
      if (header.every((byte) => byte === 0)) break;
      if (!tarChecksumMatches(header)) throw damaged();
      const type = String.fromCharCode(header[156]!);
      const paxSize = pax.size === undefined ? null : Number(pax.size);
      if (paxSize !== null && (!Number.isSafeInteger(paxSize) || paxSize < 0)) throw damaged();
      const size = paxSize ?? readTarNumber(header.subarray(124, 136));
      const padded = Math.ceil(size / 512) * 512;
      if (type === "x" || type === "g" || type === "L" || type === "K") {
        if (size > maxTarHeaderRecordBytes) throw damaged();
        const body = await blocks.read(padded);
        if (!body) throw damaged();
        const record = body.subarray(0, size);
        if (type === "x") pax = { ...pax, ...parsePax(record) };
        else if (type === "L") longName = record.toString("utf8").replace(/\0+$/, "");
        else if (type === "K") longLink = record.toString("utf8").replace(/\0+$/, "");
        continue;
      }
      const name = pax.path ?? longName ?? tarHeaderName(header);
      const linkTarget = pax.linkpath ?? longLink ?? cString(header.subarray(157, 257));
      const mode = readTarNumber(header.subarray(100, 108)) & 0o7777;
      pax = {};
      longName = null;
      longLink = null;
      const kind: EntryKind = type === "0" || type === "\0" || type === "7" ? "file"
        : type === "5" ? "folder"
        : type === "2" ? "link"
        : type === "1" ? "hard-link"
        : "special";
      if (kind === "link") {
        writer.addLink(name, linkTarget);
        await blocks.skip(padded);
        operation.itemsDone();
        continue;
      }
      const target = await writer.begin(name, kind);
      if (target === "folder" || target === null) {
        await blocks.skip(padded);
        operation.itemsDone();
        continue;
      }
      let finished = false;
      try {
        let left = size;
        while (left > 0) {
          const chunk = await blocks.readUpTo(Math.min(left, 256 * 1024));
          if (!chunk) throw damaged();
          left -= chunk.length;
          await writeChunk(target, writer, chunk);
          await operation.boundary("chunk");
        }
        await writer.finishFile(target, mode);
        finished = true;
      } finally {
        if (!finished) await target.close().catch(() => undefined);
      }
      await blocks.skip(padded - size);
      operation.itemsDone();
    }
  } finally {
    raw.destroy();
    content.destroy();
  }
}

function tarHeaderName(header: Buffer): string {
  const name = cString(header.subarray(0, 100));
  const ustar = header.subarray(257, 262).toString("latin1") === "ustar";
  const prefix = ustar ? cString(header.subarray(345, 500)) : "";
  return prefix ? `${prefix}/${name}` : name;
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

/** A tar number: octal text, or base-256 when the high bit of its first byte is set. */
function readTarNumber(field: Buffer): number {
  if (field[0]! & 0x80) {
    let value = 0n;
    for (const [index, byte] of field.entries()) value = (value << 8n) | BigInt(index === 0 ? byte & 0x7f : byte);
    return safeNumber(value);
  }
  const text = field.toString("latin1").replace(/[\0 ]+$/, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw damaged();
  return safeNumber(BigInt(`0o${text}`));
}

function tarChecksumMatches(header: Buffer): boolean {
  const stored = readTarNumber(header.subarray(148, 156));
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  return sum === stored;
}

/** Extended header records: "<length> <key>=<value>\n". */
function parsePax(record: Buffer): Record<string, string> {
  const attributes: Record<string, string> = {};
  let at = 0;
  while (at < record.length) {
    const space = record.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(record.subarray(at, space).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= 0 || at + length > record.length) throw damaged();
    const line = record.subarray(space + 1, at + length - 1).toString("utf8");
    const equals = line.indexOf("=");
    if (equals > 0) attributes[line.slice(0, equals)] = line.slice(equals + 1);
    at += length;
  }
  return attributes;
}

/** Reads exact byte counts from a stream of chunks. */
class BlockReader {
  private buffered: Buffer[] = [];
  private bufferedLength = 0;
  private done = false;

  constructor(private readonly source: AsyncIterator<Buffer>, private readonly onChunk?: (length: number) => void) {}

  private async fill(length: number): Promise<void> {
    while (this.bufferedLength < length && !this.done) {
      const next = await this.source.next();
      if (next.done) { this.done = true; break; }
      this.buffered.push(next.value);
      this.bufferedLength += next.value.length;
      this.onChunk?.(next.value.length);
    }
  }

  private take(length: number): Buffer {
    const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered);
    const taken = all.subarray(0, length);
    const rest = all.subarray(length);
    this.buffered = rest.length ? [rest] : [];
    this.bufferedLength = rest.length;
    return taken;
  }

  /** Exactly `length` bytes, or null at the end of the stream. */
  async read(length: number): Promise<Buffer | null> {
    await this.fill(length);
    if (this.bufferedLength < length) return null;
    return this.take(length);
  }

  /** Up to `length` bytes, at least one; null at the end of the stream. */
  async readUpTo(length: number): Promise<Buffer | null> {
    await this.fill(1);
    if (!this.bufferedLength) return null;
    return this.take(Math.min(length, this.bufferedLength));
  }

  async skip(length: number): Promise<void> {
    let left = length;
    while (left > 0) {
      const chunk = await this.readUpTo(Math.min(left, 1024 * 1024));
      if (!chunk) throw damaged();
      left -= chunk.length;
    }
  }
}

function damaged(): Error {
  return badRequest("This archive is damaged or incomplete. Nothing was extracted.");
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400, statusCode: 400 });
}

