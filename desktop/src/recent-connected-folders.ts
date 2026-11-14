import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Open Recent on Linux. On macOS, showing a Connected Folder records its
 * folder with `app.addRecentDocument`, and the system's Open Recent menu
 * lists those folders; Electron's recent-documents calls do nothing on Linux.
 * Linux keeps the same record in the app profile instead: the ids of the
 * Connected Folders shown most recently, newest first. Names and folders are
 * always resolved from the Connected Folder registry when the menu is built,
 * so a renamed one shows its new name and a disconnected one drops out.
 * Nothing is written into a Connected Folder or into the desktop's shared
 * recent-files list.
 */

export const maxRecentConnectedFolders = 10;
const maxRecordBytes = 64 * 1024;

export interface RecentConnectedFolderEntry {
  id: string;
  label: string;
  connectedFolderRoot: string;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\n\r]/.test(value);
}

/** The stored ids, tolerating a missing, damaged, or foreign file. */
export function parseRecentConnectedFolders(text: string | null): string[] {
  if (!text || text.length > maxRecordBytes) return [];
  try {
    const parsed = JSON.parse(text) as { connectedFolderIds?: unknown };
    const ids = Array.isArray(parsed?.connectedFolderIds) ? parsed.connectedFolderIds.filter(validId) : [];
    return ids.filter((id, index) => ids.indexOf(id) === index).slice(0, maxRecentConnectedFolders);
  } catch {
    return [];
  }
}

export function serializeRecentConnectedFolders(ids: readonly string[]): string {
  return `${JSON.stringify({ version: 1, connectedFolderIds: ids.slice(0, maxRecentConnectedFolders) }, null, 2)}\n`;
}

/** The list after showing a Connected Folder: it moves to the front, once. */
export function recordRecentConnectedFolder(ids: readonly string[], id: string): string[] {
  if (!validId(id)) return [...ids];
  return [id, ...ids.filter((existing) => existing !== id)].slice(0, maxRecentConnectedFolders);
}

/** The ids still registered, in order; disconnected ones are forgotten. */
export function pruneRecentConnectedFolders(ids: readonly string[], registered: ReadonlyArray<{ id: string }>): string[] {
  const known = new Set(registered.map((connectedFolder) => connectedFolder.id));
  return ids.filter((id) => known.has(id));
}

function homeRelative(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/**
 * Menu entries, newest first: the Connected Folder's name, with its folder
 * added when two share a name. Labels are plain text; the caller escapes
 * Electron's `&` mnemonic.
 */
export function recentConnectedFolderMenuEntries(
  ids: readonly string[],
  registered: ReadonlyArray<{ id: string; name: string; connectedFolderRoot: string }>,
  home: string,
): RecentConnectedFolderEntry[] {
  const byId = new Map(registered.map((connectedFolder) => [connectedFolder.id, connectedFolder]));
  const shown = ids.map((id) => byId.get(id)).filter((connectedFolder): connectedFolder is NonNullable<typeof connectedFolder> => Boolean(connectedFolder));
  const counts = new Map<string, number>();
  for (const connectedFolder of shown) counts.set(connectedFolder.name, (counts.get(connectedFolder.name) ?? 0) + 1);
  return shown.map((connectedFolder) => ({
    id: connectedFolder.id,
    label: (counts.get(connectedFolder.name) ?? 0) > 1 ? `${connectedFolder.name} (${homeRelative(connectedFolder.connectedFolderRoot, home)})` : connectedFolder.name,
    connectedFolderRoot: connectedFolder.connectedFolderRoot,
  }));
}

export function recentConnectedFoldersPath(userDataDir: string): string {
  return join(userDataDir, "recent-connected-folders.json");
}

export async function readRecentConnectedFolders(path: string): Promise<string[]> {
  try {
    return parseRecentConnectedFolders(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

/** Replaces the record atomically (write a sibling, then rename). */
export async function writeRecentConnectedFolders(path: string, ids: readonly string[]): Promise<void> {
  const temporary = join(dirname(path), `.recent-connected-folders-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, serializeRecentConnectedFolders(ids), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
