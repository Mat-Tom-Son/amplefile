import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { isShownStandardEntry } from "./standard-folders.js";
import { isAlwaysHiddenConnectedFolderEntry } from "./connected-folder-ignore.js";
import { resolveFolderLocation, type FolderLocationPlace } from "./folder-locations.js";

/**
 * Go to Folder (docs/product-model.md, "The file manager window"), as
 * Finder's ⇧⌘G: a typed path becomes the location the file manager opens
 * (folder-locations.ts: the deepest registered Connected Folder holding it,
 * else the most specific Standard Folder, else the computer place, which
 * holds every other folder), and the folders and files whose names start with
 * what is being typed are offered as completions.
 */
export type GoToFolderPlace = FolderLocationPlace;

export interface GoToFolderResult {
  /** Where the typed path opens, when it names a folder or file that exists; a file opens its folder with the file selected. */
  target: { place: GoToFolderPlace; path: string; select: string | null } | null;
  /** Names in the typed path's folder that start with its last part, folders first. */
  suggestions: Array<{ name: string; kind: "folder" | "file"; path: string }>;
  /** Why the path can't be opened, in plain words, when it can't. */
  message: string | null;
}

const maxSuggestions = 12;

export async function goToFolder(
  typed: string,
  connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>,
  home = homedir(),
): Promise<GoToFolderResult> {
  const full = expandTypedPath(typed, home);
  if (!full) return { target: null, suggestions: [], message: null };
  const endsWithSeparator = /[\\/]$/.test(typed.trim());
  // The folder whose names complete the typed path: the path itself after a "/", else its parent.
  const listedFolder = endsWithSeparator ? full : dirname(full);
  const partial = endsWithSeparator ? "" : basename(full);
  const suggestions = await completions(listedFolder, partial);

  let target: GoToFolderResult["target"];
  try {
    target = await resolveFolderLocation(full, connectedFolders, home);
  } catch (error) {
    return { target: null, suggestions, message: error instanceof Error ? error.message : String(error) };
  }
  if (!target) return { target: null, suggestions, message: suggestions.length ? null : "There’s no folder or file at that path." };
  return { target, suggestions, message: null };
}

/** "~" is the home folder; anything else must be a full path (the renderer resolves names relative to the folder shown). */
export function expandTypedPath(typed: string, home = homedir()): string | null {
  const value = typed.trim();
  if (!value) return null;
  if (value === "~") return resolve(home);
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  if (!isAbsolute(value)) return null;
  return resolve(value);
}

async function completions(folder: string, partial: string): Promise<GoToFolderResult["suggestions"]> {
  if (insideHiddenData(folder)) return [];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const needle = partial.toLocaleLowerCase();
  return entries
    .filter((entry) => isShownStandardEntry(entry.name) && !isAlwaysHiddenConnectedFolderEntry(entry.name) && entry.name.toLocaleLowerCase().startsWith(needle))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "folder" as const : "file" as const, path: join(folder, entry.name) }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "folder" ? -1 : 1))
    .slice(0, maxSuggestions);
}

/** Hidden AmpleFile and Pi data is never listed, at any depth. */
function insideHiddenData(folder: string): boolean {
  return resolve(folder).split(sep).some((part) => isAlwaysHiddenConnectedFolderEntry(part));
}
