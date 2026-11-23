import { isAbsolute, relative, sep } from "node:path";

/**
 * Paste in the file manager window (docs/product-model.md, "Finder's file
 * actions"): the desktop reads the system pasteboard, never the window, and
 * decides what the paste carries.
 *
 * - Items cut in any window paste by the place they were cut in, as a move
 *   through that place's own move rules, while the pasteboard still holds
 *   exactly what the Cut put there (desktop/src/file-clipboard.ts).
 * - Items copied in this window paste by place too, so ⌥⌘V moves them the
 *   same way.
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
  /** What this window last copied, by place and as absolute paths. A Cut is the host's (RememberedCut), never the window's. */
  internal: { place: PastePlace; paths: string[]; nativePaths: string[] } | null;
  /** The window's id for this paste's progress (src/local/file-operations.ts). */
  operationId?: string;
  /** Passed to the transfer as is: a conflicts-first check, or the person's choices. */
  conflicts?: unknown;
  /**
   * What the conflicts-first check planned (FileClipboard's answer): the run
   * is refused when the pasteboard now asks for something else, so it never
   * carries items other than those the person was asked about.
   */
  plan?: string;
}

export interface PasteboardFiles {
  paths: string[];
  /** What the app that put them there asked for; null when its formats do not say (a Mac's pasteboard never does). */
  operation: "copy" | "cut" | null;
  /** The token an AmpleFile Cut wrote into the file list beside the paths; null when the list has none (Finder's never does). */
  cutToken?: string | null;
  /**
   * Where the desktop reads no files from the pasteboard: what was copied or
   * cut in AmpleFile pastes until something in AmpleFile replaces it.
   */
  unreadable?: boolean;
  /**
   * There, the text the pasteboard holds: AmpleFile writes files as their
   * paths, one per line (pasteboardFileText), so a Cut holds only while that
   * text is still its paths.
   */
  text?: string;
}

/**
 * A Cut made in any window, as the desktop host remembers it: the items by the
 * place they were cut in (so a paste anywhere moves them under that place's
 * rules) and the exact files it put on the pasteboard. `token` is written into
 * the pasteboard's file list with them, so a fresh Copy of the same files
 * (Finder's) is not this Cut; null where the pasteboard carries no token.
 */
export interface RememberedCut {
  place: PastePlace;
  paths: string[];
  nativePaths: string[];
  token: string | null;
}

export interface PastePlan {
  sources: PasteSource[];
  mode: "copy" | "move";
  /** The items were cut in a window of this app or copied in this one, and paste by place. */
  fromHere: boolean;
  /** The items were cut (in this app or another), so a finished paste empties the pasteboard. */
  cut: boolean;
  /** Where the items pasted by place come from, for the window's notices and History; null for another app's files. */
  from: { place: PastePlace; paths: string[] } | null;
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
    }
    : null;
  return {
    target,
    mode: value.mode === "move" ? "move" : "copy",
    internal,
    ...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
    ...(value.conflicts !== undefined ? { conflicts: value.conflicts } : {}),
    ...(typeof value.plan === "string" && /^[0-9a-f]{64}$/.test(value.plan) ? { plan: value.plan } : {}),
  };
}

/**
 * What a paste carries and whether it moves. `connectedFolderRoots` are the
 * registered Connected Folders' folders, so a file cut elsewhere that lives
 * in one moves through that Connected Folder (with its History and refusals).
 * `cut` is the Cut the host remembers, from whichever window made it.
 */
export function planFileClipboardPaste(
  request: FileClipboardPasteRequest,
  pasteboard: PasteboardFiles,
  connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>,
  cut: RememberedCut | null = null,
): PastePlan {
  if (cut && pasteboardHoldsCut(pasteboard, cut)) {
    const paths = cut.paths.slice(0, maxPasteItems);
    return { sources: paths.map((path) => ({ place: cut.place, path })), mode: "move", fromHere: true, cut: true, from: { place: cut.place, paths } };
  }
  const internal = request.internal;
  // What this window copied, while the pasteboard holds exactly those files with no Cut's token beside them.
  const fromHere = Boolean(internal) && (pasteboard.unreadable === true || (!pasteboard.cutToken && sameSet(pasteboard.paths, internal!.nativePaths)));
  if (fromHere) {
    const paths = internal!.paths.slice(0, maxPasteItems);
    return { sources: paths.map((path) => ({ place: internal!.place, path })), mode: request.mode, fromHere: true, cut: false, from: { place: internal!.place, paths } };
  }
  const paths = pasteboard.paths.filter((path) => isAbsolute(path) && !path.includes("\0")).slice(0, maxPasteItems);
  const otherCut = pasteboard.operation === "cut";
  if (otherCut || request.mode === "move") {
    return { sources: paths.map((path) => placeSourceForPath(path, connectedFolders)), mode: "move", fromHere: false, cut: otherCut, from: null };
  }
  return { sources: paths.map((nativePath) => ({ nativePath })), mode: "copy", fromHere: false, cut: false, from: null };
}

/** A file on disk as a place source: the deepest Connected Folder holding it, else the computer place. */
export function placeSourceForPath(path: string, connectedFolders: ReadonlyArray<{ id: string; connectedFolderRoot: string }>): { place: PastePlace; path: string } {
  const holder = connectedFolders
    .filter((item) => inside(item.connectedFolderRoot, path))
    .sort((left, right) => right.connectedFolderRoot.length - left.connectedFolderRoot.length)[0];
  if (holder) return { place: { kind: "connected-folder", id: holder.id }, path: relative(holder.connectedFolderRoot, path).split(sep).join("/") };
  return { place: { kind: "standard", id: "computer" }, path: path.replace(/^[\\/]+/, "").split(sep).join("/") };
}

/** Whether the pasteboard still holds exactly these files. */
export function pasteboardHolds(pasteboard: PasteboardFiles, nativePaths: readonly string[]): boolean {
  return nativePaths.length > 0 && sameSet(pasteboard.paths, nativePaths);
}

/**
 * Whether the pasteboard still holds what a Cut put there: exactly its files,
 * with its token. Another app's Copy, a Copy made here, and Finder copying the
 * same files fresh all replace the token. Where the pasteboard carries no
 * token, the same files are enough; where no files can be read from it, the
 * Cut holds while its text is still the Cut's paths (or, where no text can
 * be read either, until AmpleFile replaces it).
 */
export function pasteboardHoldsCut(pasteboard: PasteboardFiles, cut: RememberedCut): boolean {
  if (!cut.nativePaths.length) return false;
  if (pasteboard.unreadable === true) return pasteboard.text === undefined || sameText(pasteboard.text, pasteboardFileText(cut.nativePaths));
  if (cut.token !== null && pasteboard.cutToken !== cut.token) return false;
  return sameSet(pasteboard.paths, cut.nativePaths);
}

/** Files as AmpleFile puts them on a pasteboard it reads no files from: their paths, one per line. */
export function pasteboardFileText(paths: readonly string[]): string {
  return paths.join("\n");
}

/** The same text, whatever line endings the system's clipboard gave it. */
function sameText(left: string, right: string): boolean {
  const lines = (value: string) => value.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return lines(left) === lines(right);
}

/**
 * The file list Finder's Copy puts on a Mac's pasteboard (a property list of
 * paths), with a Cut's token in a comment: other apps read the paths as they
 * always do, and AmpleFile reads the token back.
 */
export function pasteboardFileList(paths: readonly string[], cutToken: string | null = null): string {
  const marker = cutToken ? `<!-- ${cutMarker} ${cutToken} -->` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${marker}<array>${paths.map((path) => `<string>${encodeXmlText(path)}</string>`).join("")}</array></plist>`;
}

/** A file list's paths and the Cut token written into it, if any. */
export function readPasteboardFileList(plist: string): { paths: string[]; cutToken: string | null } {
  const paths = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => decodeXmlText(match[1] ?? "")).filter((path) => isAbsolute(path));
  const token = new RegExp(`<!-- ${cutMarker} ([0-9a-f]{16,64}) -->`).exec(plist)?.[1] ?? null;
  return { paths, cutToken: token };
}

const cutMarker = "AmpleFile Cut";

function encodeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeXmlText(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
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
