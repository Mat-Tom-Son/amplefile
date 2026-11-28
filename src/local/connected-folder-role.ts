/**
 * The Role store: `.amplefile/role.json` in a Connected Folder's own folder
 * (docs/product-model.md, "Role"). A read never writes: a malformed,
 * oversized, symbolic-link, or newer-version file reads as no role and stays
 * exactly as it is. A write is bounded, atomic (temp file, fsync, rename), and
 * refuses to replace a file a newer AmpleFile wrote.
 */
import { randomUUID } from "node:crypto";
import { mkdir, lstat, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ConnectedFolderRoleError,
  applyConnectedFolderRoleInput,
  connectedFolderRoleFileName,
  connectedFolderRoleLimits,
  connectedFolderRolesEqual,
  parseConnectedFolderRoleFile,
  serializeConnectedFolderRole,
  type ConnectedFolderRole,
  type ConnectedFolderRoleInput,
  type ParsedConnectedFolderRole,
} from "../shared/connected-folder-role.js";
import { connectedFolderMetadataDir } from "./state-paths.js";

export {
  ConnectedFolderRoleError,
  type ConnectedFolderRole,
  type ConnectedFolderRoleInput,
} from "../shared/connected-folder-role.js";

export function connectedFolderRoleFile(connectedFolderRoot: string): string {
  return join(connectedFolderMetadataDir(connectedFolderRoot), connectedFolderRoleFileName);
}

type FileRead = { kind: "missing" } | { kind: "unreadable" } | { kind: "parsed"; parsed: ParsedConnectedFolderRole };

async function readRoleFile(connectedFolderRoot: string): Promise<FileRead> {
  let file: string;
  try {
    file = connectedFolderRoleFile(connectedFolderRoot);
  } catch {
    // A metadata directory that is a symbolic link is not ours to read through.
    return { kind: "unreadable" };
  }
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > connectedFolderRoleLimits.fileBytes) return { kind: "unreadable" };
    return { kind: "parsed", parsed: parseConnectedFolderRoleFile(await readFile(file, "utf8")) };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
}

/** The folder's Role, or null when it has none or the file is not one this version can read. Never writes. */
export async function readConnectedFolderRole(connectedFolderRoot: string): Promise<ConnectedFolderRole | null> {
  const read = await readRoleFile(connectedFolderRoot);
  return read.kind === "parsed" && read.parsed.kind === "role" ? read.parsed.role : null;
}

/** The Role's purpose alone, for lists; "" when there is none. */
export async function readConnectedFolderRolePurpose(connectedFolderRoot: string): Promise<string> {
  return (await readConnectedFolderRole(connectedFolderRoot))?.purpose ?? "";
}

export interface ConnectedFolderRoleChange {
  /** The Role now in the folder, or null when it has none. */
  role: ConnectedFolderRole | null;
  /** The Role before this change, so a person can put it back. */
  previousRole: ConnectedFolderRole | null;
  /** False when the change left the Role as it was; nothing was written. */
  changed: boolean;
}

const chains = new Map<string, Promise<unknown>>();

/** One writer per folder at a time inside this process; the rename keeps readers whole across processes. */
async function serialized<T>(connectedFolderRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(connectedFolderRoot);
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

/**
 * Applies the input to the folder's Role: a given field replaces the old one,
 * an empty one clears it, an omitted one stays. A Role left empty removes the
 * file. Refuses (and writes nothing) over an invalid input or over a file a
 * newer AmpleFile wrote.
 */
export async function writeConnectedFolderRole(
  connectedFolderRoot: string,
  input: ConnectedFolderRoleInput,
  options: { now?: () => Date } = {},
): Promise<ConnectedFolderRoleChange> {
  return serialized(connectedFolderRoot, async () => {
    const existing = await readRoleFile(connectedFolderRoot);
    assertWritable(existing);
    const previousRole = existing.kind === "parsed" && existing.parsed.kind === "role" ? existing.parsed.role : null;
    const next = applyConnectedFolderRoleInput(previousRole, input, (options.now?.() ?? new Date()).toISOString());
    if (connectedFolderRolesEqual(previousRole, next)) return { role: previousRole, previousRole, changed: false };
    if (!next) {
      await removeRoleFile(connectedFolderRoot);
      return { role: null, previousRole, changed: true };
    }
    await writeRoleFile(connectedFolderRoot, serializeConnectedFolderRole(next));
    return { role: next, previousRole, changed: true };
  });
}

/** Removes the folder's Role. A file a newer AmpleFile wrote is refused, not removed. */
export async function clearConnectedFolderRole(connectedFolderRoot: string): Promise<ConnectedFolderRoleChange> {
  return serialized(connectedFolderRoot, async () => {
    const existing = await readRoleFile(connectedFolderRoot);
    assertWritable(existing);
    const previousRole = existing.kind === "parsed" && existing.parsed.kind === "role" ? existing.parsed.role : null;
    if (existing.kind === "missing") return { role: null, previousRole: null, changed: false };
    await removeRoleFile(connectedFolderRoot);
    return { role: null, previousRole, changed: true };
  });
}

function assertWritable(existing: FileRead): void {
  if (existing.kind === "unreadable") {
    throw new ConnectedFolderRoleError("This folder's Role file cannot be replaced safely (it is not a plain file AmpleFile can read). Move it aside in Finder to set a Role.", "unavailable");
  }
  if (existing.kind === "parsed" && existing.parsed.kind === "newer-version") {
    throw new ConnectedFolderRoleError("This folder's Role was written by a newer version of AmpleFile, so this version will not change it. Update AmpleFile to edit it.", "newer-version");
  }
}

async function removeRoleFile(connectedFolderRoot: string): Promise<void> {
  await rm(connectedFolderRoleFile(connectedFolderRoot), { force: true });
}

async function writeRoleFile(connectedFolderRoot: string, text: string): Promise<void> {
  const directory = connectedFolderMetadataDir(connectedFolderRoot);
  // The folder itself must exist; never create it (or a missing mount) just to hold a Role.
  if (!(await stat(resolve(connectedFolderRoot)).then((entry) => entry.isDirectory(), () => false))) {
    throw new ConnectedFolderRoleError("This Connected Folder's folder is not available.", "unavailable");
  }
  await mkdir(directory, { recursive: false }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  });
  const file = join(directory, connectedFolderRoleFileName);
  const temporary = join(directory, `.${connectedFolderRoleFileName}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory sync is best effort; the fsynced temp file and the rename are the commit.
  }
}
