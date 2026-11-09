import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, link, lstat, readdir, rename, rm } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import JSZip from "jszip";

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

/** Copies a file or folder into a folder and returns where it landed. */
export async function copyInto(source: string, targetFolder: string, options: { duplicate?: boolean } = {}): Promise<string> {
  if (isInside(source, targetFolder)) throw badRequest(`“${basename(source)}” can’t be copied into itself.`);
  const destination = await freeDestination(targetFolder, basename(source), options);
  await copyTree(source, destination, (path) => path === source || !identityFolders.has(basename(path)));
  return destination;
}

/** Moves a file or folder into a folder on the same computer (copying across disks), returning where it landed. */
export async function moveInto(source: string, targetFolder: string): Promise<string> {
  if (isInside(source, targetFolder)) throw badRequest(`“${basename(source)}” can’t be moved into itself.`);
  const destination = await freeDestination(targetFolder, basename(source));
  try {
    await rename(source, destination);
  } catch (error) {
    if ((error as { code?: string }).code !== "EXDEV") throw error;
    await copyTree(source, destination);
    await rm(source, { recursive: true, force: true });
  }
  return destination;
}

/**
 * Copies to a destination that was free a moment ago. A copy that fails
 * partway takes back what it wrote, so a failed paste or move never leaves a
 * half-written item behind; a destination that turned out to be taken is
 * someone else's and stays.
 */
async function copyTree(source: string, destination: string, filter?: (path: string) => boolean): Promise<void> {
  try {
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, ...(filter ? { filter } : {}) });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const taken = (code === "ERR_FS_CP_EEXIST" || code === "EEXIST") && resolve((error as { path?: string }).path ?? destination) === resolve(destination);
    if (!taken) await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The most Compress takes on: what it reads in all (before compressing) and
 * how many items. A zip without its 64-bit extension, which is what Compress
 * writes, holds under 4 GB and 65,535 items; larger work belongs to Finder.
 */
export const compressLimits = { maxBytes: 2 * 1024 ** 3, maxEntries: 60_000 } as const;

/**
 * Compress, as Finder's: one item becomes "name.zip" beside it, several become
 * "Archive.zip", and a name already taken gets " copy" or a number. The
 * archive streams to a hidden file beside it, one file read at a time, and
 * takes its name only once complete, so a failed or refused Compress leaves
 * nothing behind.
 */
export async function compressInto(
  sources: readonly string[],
  targetFolder: string,
  limits: { maxBytes: number; maxEntries: number } = compressLimits,
): Promise<string> {
  if (!sources.length) throw badRequest("Choose items to compress.");
  const entries: ArchiveEntry[] = [];
  const total = { bytes: 0 };
  for (const source of sources) await collectArchiveEntries(source, basename(source), entries, total, limits);
  const zip = new JSZip();
  for (const entry of entries) {
    if (entry.kind === "folder") zip.folder(entry.name);
    else zip.file(entry.name, openWhenRead(entry.path), { date: entry.date, binary: true });
  }
  const name = sources.length === 1 ? `${basename(sources[0]!)}.zip` : "Archive.zip";
  const partial = join(targetFolder, `.AmpleFile-compress-${randomBytes(8).toString("hex")}.partial`);
  try {
    await pipeline(
      zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 6 } }),
      createWriteStream(partial, { flags: "wx" }),
    );
    return await placeWithoutReplacing(partial, targetFolder, name);
  } finally {
    await rm(partial, { force: true }).catch(() => undefined);
  }
}

type ArchiveEntry = { kind: "folder"; name: string } | { kind: "file"; name: string; path: string; date: Date };

async function collectArchiveEntries(
  path: string,
  name: string,
  entries: ArchiveEntry[],
  total: { bytes: number },
  limits: { maxBytes: number; maxEntries: number },
): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) return;
  if (entries.length >= limits.maxEntries) throw tooLarge(`This is too many items to compress here (more than ${limits.maxEntries.toLocaleString("en-US")}). Compress it in Finder instead.`);
  if (info.isDirectory()) {
    entries.push({ kind: "folder", name });
    for (const entry of (await readdir(path)).sort()) {
      if (identityFolders.has(entry) || entry === ".DS_Store") continue;
      await collectArchiveEntries(join(path, entry), `${name}/${entry}`, entries, total, limits);
    }
    return;
  }
  total.bytes += info.size;
  if (total.bytes > limits.maxBytes) throw tooLarge(`This is too large to compress here (more than ${formatBytes(limits.maxBytes)}). Compress it in Finder instead.`);
  entries.push({ kind: "file", name, path, date: info.mtime });
}

/** A file's bytes, opened only when the archive reaches it, so one file is open at a time. */
function openWhenRead(path: string): Readable {
  let source: ReturnType<typeof createReadStream> | null = null;
  const stream: Readable = new Readable({
    read() {
      if (source) { source.resume(); return; }
      source = createReadStream(path);
      source.on("data", (chunk) => { if (!stream.push(chunk)) source!.pause(); });
      source.once("end", () => stream.push(null));
      source.once("error", (error) => stream.destroy(error));
    },
    destroy(error, callback) {
      source?.destroy();
      callback(error);
    },
  });
  return stream;
}

/** Gives a finished file its name, the first free one, never replacing an item that took it meanwhile. */
async function placeWithoutReplacing(file: string, folder: string, name: string): Promise<string> {
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

function formatBytes(bytes: number): string {
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

function tooLarge(message: string): Error {
  return Object.assign(new Error(message), { status: 413, statusCode: 413 });
}

/** macOS and Windows disks ignore case by default. */
function comparison(value: string): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "") || sep;
  return process.platform === "linux" ? resolved : resolved.toLocaleLowerCase();
}
