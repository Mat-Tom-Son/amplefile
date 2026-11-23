import { isAbsolute, relative, sep } from "node:path";

/**
 * Paste in the file manager window (docs/product-model.md, "Finder's file
 * actions"): the desktop reads the system pasteboard, never the window, and
 * decides what the paste carries.
 *
 * - Items copied or cut in this window paste by place, so a Cut (or ⌥⌘V)
 *   moves them through the place's own move rules.
 * - Files another app put on the pasteboard are copied in; when that app
 *   marked them cut (GNOME Files, Nemo, Caja, Thunar, Dolphin), or the person
 *   chose ⌥⌘V, they move instead, named by where they are: inside a Connected
 *   Folder by that Connected Folder, anywhere else by the computer place.
 */

export type PastePlace = { kind: "connected-folder" | "standard"; id: string };
export type PasteSource = { place: PastePlace; path: string } | { nativePath: string };

export interface FileClipboardPasteRequest {
  target: { place: PastePlace; path: string };
  mode: "copy" | "move";
  /** What this window last copied or cut, by place and as absolute paths. */
  internal: { place: PastePlace; paths: string[]; nativePaths: string[]; cut: boolean } | null;
  /** The window's id for this paste's progress (src/local/file-operations.ts). */
  operationId?: string;
  /** Passed to the transfer as is: a conflicts-first check, or the person's choices. */
  conflicts?: unknown;
}

export interface PasteboardFiles {
  paths: string[];
  /** What the app that put them there asked for; null when its formats do not say (a Mac's pasteboard never does). */
  operation: "copy" | "cut" | null;
}

export interface PastePlan {
  sources: PasteSource[];
  mode: "copy" | "move";
  /** The items were copied or cut in this window. */
  fromHere: boolean;
  /** The items were cut (here or in another app), so a finished paste empties the pasteboard. */
  cut: boolean;
}

const maxPasteItems = 5_000;

export function parseFileClipboardPasteRequest(value: unknown): FileClipboardPasteRequest {
  if (!isRecord(value) || !isRecord(value.target)) throw new Error("Choose where to paste.");
  const target = { place: parsePlace(value.target.place), path: typeof value.target.path === "string" ? value.target.path : "" };
  const internalRecord = isRecord(value.internal) ? value.internal : null;
  const internal = internalRecord && Array.isArray(internalRecord.paths) && Array.isArray(internalRecord.nativePaths)
    ? {
      place: parsePlace(internalRecord.place),
      paths: strings(internalRecord.paths),
      nativePaths: strings(internalRecord.nativePaths),
      cut: internalRecord.cut === true,
    }
    : null;
  return {
    target,
    mode: value.mode === "move" ? "move" : "copy",
    internal,
    ...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
    ...(value.conflicts !== undefined ? { conflicts: value.conflicts } : {}),
  };
}

/**
 * What a paste carries and whether it moves. `connectedFolderRoots` are the
 * registered Connected Folders' folders, so a file cut elsewhere that lives
 * in one moves through that Connected Folder (with its History and refusals).
 */
export function planFileClipboardPaste(
  request: FileClipboardPasteRequest,
  pasteboard: PasteboardFiles,
  connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>,
): PastePlan {
  const internal = request.internal;
  const fromHere = Boolean(internal) && (!pasteboard.paths.length || sameSet(pasteboard.paths, internal!.nativePaths));
  if (fromHere) {
    const cut = internal!.cut;
    return {
      sources: internal!.paths.slice(0, maxPasteItems).map((path) => ({ place: internal!.place, path })),
      mode: cut ? "move" : request.mode,
      fromHere: true,
      cut,
    };
  }
  const paths = pasteboard.paths.filter((path) => isAbsolute(path) && !path.includes("\0")).slice(0, maxPasteItems);
  const cut = pasteboard.operation === "cut";
  if (cut || request.mode === "move") {
    return { sources: paths.map((path) => placeSourceForPath(path, connectedFolders)), mode: "move", fromHere: false, cut };
  }
  return { sources: paths.map((nativePath) => ({ nativePath })), mode: "copy", fromHere: false, cut: false };
}

/** A file on disk as a place source: the deepest Connected Folder holding it, else the computer place. */
export function placeSourceForPath(path: string, connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>): { place: PastePlace; path: string } {
  const holder = connectedFolders
    .filter((item) => inside(item.connectedFolderRoot, path))
    .sort((left, right) => right.connectedFolderRoot.length - left.connectedFolderRoot.length)[0];
  if (holder) return { place: { kind: "connected-folder", id: holder.id }, path: relative(holder.connectedFolderRoot, path).split(sep).join("/") };
  return { place: { kind: "standard", id: "computer" }, path: path.replace(/^[\\/]+/, "").split(sep).join("/") };
}

/** Whether the pasteboard still holds exactly these files (so items cut here stay drawn as cut). */
export function pasteboardHolds(pasteboard: PasteboardFiles, nativePaths: readonly string[]): boolean {
  return nativePaths.length > 0 && sameSet(pasteboard.paths, nativePaths);
}

function inside(root: string, path: string): boolean {
  const from = relative(root, path);
  return Boolean(from) && !from.startsWith("..") && !isAbsolute(from);
}

function sameSet(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((path) => second.includes(path));
}

function parsePlace(value: unknown): PastePlace {
  if (!isRecord(value) || (value.kind !== "connected-folder" && value.kind !== "standard") || typeof value.id !== "string" || !value.id) {
    throw new Error("Choose where to paste.");
  }
  return { kind: value.kind, id: value.id };
}

function strings(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string").slice(0, maxPasteItems);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
