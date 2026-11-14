import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Files on the Linux clipboard, the way Linux file managers exchange them.
 *
 * Reading: GNOME Files (Nautilus), Nemo, Caja and Thunar offer
 * `x-special/gnome-copied-files` ("copy" or "cut", then one file URI per
 * line); Dolphin and most other apps offer `text/uri-list` (RFC 2483: CRLF
 * lines, `#` comments), with KDE's `application/x-kde-cutselection` set to
 * "1" for Cut. Older Nautilus on Wayland offered only text: the line
 * `x-special/nautilus-clipboard`, then the gnome-copied-files body.
 *
 * Writing: under X11 the clipboard helper (`linux-clipboard-helper.ts`)
 * offers every format at once. Electron's clipboard writes one custom format
 * per call, and each write replaces the clipboard, so where the helper cannot
 * run `writeLinuxClipboardFiles` writes only `text/uri-list`, which Chromium
 * publishes as its file-list format; GNOME Files and Dolphin paste it, and GTK
 * and the desktop portal read it as a file list. AmpleFile's own Copy is
 * always a copy: moving is chosen when pasting, not when copying.
 */

export const gnomeCopiedFilesFormat = "x-special/gnome-copied-files";
export const uriListFormat = "text/uri-list";
export const kdeCutSelectionFormat = "application/x-kde-cutselection";
const nautilusTextHeader = "x-special/nautilus-clipboard";

export type LinuxFileClipboardOperation = "copy" | "cut";

export interface LinuxClipboardFiles {
  paths: string[];
  /** What the copying app asked for; null when its formats do not say. */
  operation: LinuxFileClipboardOperation | null;
}

/** The parts of Electron's clipboard this module uses, so tests and a real Electron run share the code. */
export interface LinuxFileClipboardAccess {
  read(format: string): string;
  readText(): string;
  writeBuffer(format: string, buffer: Buffer): void;
}

/** One absolute path as a percent-encoded `file://` URI (spaces, `#`, `%`, `?` and non-ASCII are escaped). */
export function fileUriFromPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Only absolute file paths can be copied.");
  return pathToFileURL(path).href;
}

/** A local absolute path for a `file://` URI, or null for anything else (other schemes, remote hosts, malformed or encoded-slash URIs). */
export function pathFromFileUri(uri: string): string | null {
  const value = uri.trim();
  if (!/^file:/i.test(value)) return null;
  let path: string;
  try {
    path = fileURLToPath(value);
  } catch {
    return null;
  }
  if (!isAbsolute(path) || path.includes("\0")) return null;
  return path;
}

/** The `text/uri-list` body for paths: CRLF-terminated lines, as RFC 2483 asks. */
export function formatUriList(paths: readonly string[]): string {
  return paths.map((path) => `${fileUriFromPath(path)}\r\n`).join("");
}

/** The `x-special/gnome-copied-files` body: the operation, then one URI per line. */
export function formatGnomeCopiedFiles(paths: readonly string[], operation: LinuxFileClipboardOperation = "copy"): string {
  return [operation, ...paths.map(fileUriFromPath)].join("\n");
}

/** Local paths named by a `text/uri-list` body; comment lines, blank lines and non-file URIs are ignored. */
export function parseUriList(value: string): string[] {
  const paths: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const path = pathFromFileUri(entry);
    if (path !== null && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** The operation and local paths of an `x-special/gnome-copied-files` body; null when it is not one. */
export function parseGnomeCopiedFiles(value: string): LinuxClipboardFiles | null {
  const [first, ...rest] = value.replace(/\0+$/, "").split(/\r?\n/);
  const operation = first?.trim();
  if (operation !== "copy" && operation !== "cut") return null;
  return { operation, paths: parseUriList(rest.join("\n")) };
}

/** Older Nautilus's text form: `x-special/nautilus-clipboard`, then the gnome-copied-files body. Null for any other text. */
export function parseNautilusClipboardText(value: string): LinuxClipboardFiles | null {
  const match = /^x-special\/nautilus-clipboard\r?\n([\s\S]*)$/.exec(value);
  if (!match) return null;
  return parseGnomeCopiedFiles(match[1] ?? "");
}

/**
 * The files on the clipboard, preferring the format that also says copy or
 * cut. Text is used only in Nautilus's own marked form: ordinary copied text
 * that happens to look like a path is never treated as files.
 */
export function readLinuxClipboardFiles(clipboard: Pick<LinuxFileClipboardAccess, "read" | "readText">): LinuxClipboardFiles {
  const gnome = parseGnomeCopiedFiles(safeRead(() => clipboard.read(gnomeCopiedFilesFormat)));
  if (gnome?.paths.length) return gnome;
  const uriPaths = parseUriList(safeRead(() => clipboard.read(uriListFormat)));
  if (uriPaths.length) {
    const kdeCut = safeRead(() => clipboard.read(kdeCutSelectionFormat)).trim() === "1";
    return { paths: uriPaths, operation: kdeCut ? "cut" : null };
  }
  const nautilusText = parseNautilusClipboardText(safeRead(() => clipboard.readText()));
  if (nautilusText?.paths.length) return nautilusText;
  return { paths: [], operation: null };
}

/** Puts files on the clipboard as a copy that Linux file managers paste. */
export function writeLinuxClipboardFiles(clipboard: Pick<LinuxFileClipboardAccess, "writeBuffer">, paths: readonly string[]): void {
  if (!paths.length) throw new Error("Choose items to copy.");
  clipboard.writeBuffer(uriListFormat, Buffer.from(formatUriList(paths), "utf8"));
}

function safeRead(read: () => string): string {
  try {
    const value = read();
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
