import { cp, lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

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
 * Compress, as Finder's: one item becomes "name.zip" beside it, several become
 * "Archive.zip", and a name already taken gets " copy" or a number.
 */
export async function compressInto(sources: readonly string[], targetFolder: string): Promise<string> {
  if (!sources.length) throw badRequest("Choose items to compress.");
  const zip = new JSZip();
  for (const source of sources) await addToZip(zip, source, basename(source));
  const name = sources.length === 1 ? `${basename(sources[0]!)}.zip` : "Archive.zip";
  const destination = await freeDestination(targetFolder, name);
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  await writeFile(destination, data, { flag: "wx" });
  return destination;
}

async function addToZip(zip: JSZip, path: string, name: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    const folder = zip.folder(name)!;
    for (const entry of await readdir(path)) {
      if (identityFolders.has(entry) || entry === ".DS_Store") continue;
      await addToZip(folder, join(path, entry), entry);
    }
    return;
  }
  if (info.isFile()) zip.file(name, await readFile(path), { date: info.mtime });
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
