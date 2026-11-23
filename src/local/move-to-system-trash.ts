import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

/**
 * The system Trash, for an item a file operation replaces outside a Connected
 * Folder (which keeps its own restore points). The desktop registers the
 * operating system's own Trash (Electron's `shell.trashItem`); without it the
 * host moves the item into the Trash itself where it can: the freedesktop.org
 * Trash on Linux (the home Trash on the same disk, else the disk's own), or
 * `~/.Trash` on the Mac's own disk. Returns false when it cannot, and the
 * caller says the item is gone.
 */

export type SystemTrashHandler = (path: string) => Promise<void>;

let handler: SystemTrashHandler | null = null;

/** The desktop's Trash (Electron's `shell.trashItem`), or null to use the host's own. */
export function setSystemTrashHandler(trash: SystemTrashHandler | null): void {
  handler = trash;
}

/** Moves an item to the system Trash; false when no Trash the host can use takes it. */
export async function moveToSystemTrash(path: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (handler) {
    try {
      await handler(path);
      return true;
    } catch {
      return false;
    }
  }
  try {
    if (platform === "linux") return await moveToFreedesktopTrash(resolve(path));
    if (platform === "darwin") return await moveToMacTrash(resolve(path));
  } catch {
    return false;
  }
  return false;
}

async function moveToMacTrash(path: string): Promise<boolean> {
  const trash = join(homedir(), ".Trash");
  const [item, folder] = await Promise.all([lstat(path), lstat(trash).catch(() => null)]);
  if (!folder?.isDirectory() || folder.dev !== item.dev) return false;
  await rename(path, await freeTrashName(trash, basename(path), () => Promise.resolve(false)));
  return true;
}

/** The freedesktop.org Trash: the home Trash when the item is on its disk, else the disk's own `.Trash-<uid>`. */
async function moveToFreedesktopTrash(path: string): Promise<boolean> {
  const item = await lstat(path);
  const home = resolve(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "Trash");
  await mkdir(join(home, "files"), { recursive: true, mode: 0o700 }).catch(() => undefined);
  const homeTrash = await lstat(join(home, "files")).catch(() => null);
  if (homeTrash?.isDirectory() && homeTrash.dev === item.dev) return trashInto(home, path, path);
  const top = await mountTop(path, item.dev);
  if (!top || typeof process.getuid !== "function") return false;
  const uid = process.getuid();
  // A shared, sticky `.Trash` the administrator made, else the per-user one.
  const shared = join(top, ".Trash");
  const sharedInfo = await lstat(shared).catch(() => null);
  const trash = sharedInfo?.isDirectory() && (sharedInfo.mode & 0o1000)
    ? join(shared, String(uid))
    : join(top, `.Trash-${uid}`);
  await mkdir(join(trash, "files"), { recursive: true, mode: 0o700 });
  await mkdir(join(trash, "info"), { recursive: true, mode: 0o700 });
  await chmod(trash, 0o700).catch(() => undefined);
  const trashInfo = await lstat(trash);
  if (trashInfo.isSymbolicLink() || trashInfo.dev !== item.dev) return false;
  return trashInto(trash, path, relative(top, path).split(sep).join("/"));
}

async function trashInto(trash: string, path: string, recordedPath: string): Promise<boolean> {
  await mkdir(join(trash, "info"), { recursive: true, mode: 0o700 });
  // The info file claims the name first, so two items never share one.
  let infoPath = "";
  const name = await freeTrashName(join(trash, "files"), basename(path), async (candidate) => {
    try {
      const handle = await open(join(trash, "info", `${candidate}.trashinfo`), "wx", 0o600);
      await handle.writeFile(`[Trash Info]\nPath=${encodeTrashPath(recordedPath)}\nDeletionDate=${localTimestamp(new Date())}\n`);
      await handle.close();
      infoPath = join(trash, "info", `${candidate}.trashinfo`);
      return false;
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") return true;
      throw error;
    }
  });
  try {
    await rename(path, name);
    return true;
  } catch (error) {
    await rm(infoPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** A name not yet in `folder`, and not `taken` by the caller's own check. */
async function freeTrashName(folder: string, name: string, taken: (candidate: string) => Promise<boolean>): Promise<string> {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const candidate = attempt === 1 ? name : `${stem}.${attempt}${extension}`;
    if (await lstat(join(folder, candidate)).catch(() => null)) continue;
    if (await taken(candidate)) continue;
    return join(folder, candidate);
  }
  throw new Error("The Trash has too many items with this name.");
}

/** The top of the disk holding `path`: the last folder up the path on the same device. */
async function mountTop(path: string, device: number): Promise<string | null> {
  let current = dirname(path);
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return current;
    const info = await lstat(parent).catch(() => null);
    if (!info || info.dev !== device) return current;
    current = parent;
  }
}

function encodeTrashPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function localTimestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
