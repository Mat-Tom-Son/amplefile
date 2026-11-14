import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { parseDesktopEntry, runCommand, xdgDataDirs, type CommandRunner } from "./open-with-linux.js";

/**
 * Icon lookup per the freedesktop Icon Theme Specification 0.13
 * (https://specifications.freedesktop.org/icon-theme-spec/latest/): the
 * current theme, its `Inherits` chain, hicolor, then unthemed fallback icons.
 * Parsing and lookup are pure over an injected directory lister, so fixture
 * theme directories test them; the loaders below only read files and run
 * read-only `gdbus`/`gsettings` queries with argument vectors. Nothing here
 * decodes an image.
 */

export type IconDirectoryType = "Fixed" | "Scalable" | "Threshold";

export interface IconThemeDirectory {
  /** Path relative to the theme directory, for example `16x16/apps`. */
  path: string;
  size: number;
  scale: number;
  type: IconDirectoryType;
  minSize: number;
  maxSize: number;
  threshold: number;
}

export interface IconTheme {
  name: string;
  inherits: string[];
  directories: IconThemeDirectory[];
}

/** Lists a directory's file names; null when it is missing or unreadable. */
export type DirectoryLister = (path: string) => Promise<ReadonlySet<string> | null>;

export type IconFileFormat = "png" | "svg";

export interface ResolvedIconFile {
  path: string;
  format: IconFileFormat;
}

/** Extensions in the spec's order; XPM is left out because nothing here can decode it. */
const iconExtensions: IconFileFormat[] = ["png", "svg"];
const maxIndexThemeBytes = 512 * 1024;
const maxThemeDepth = 16;
const maxDirectoriesPerTheme = 1_024;
const maxIconSize = 4_096;

// ---------------------------------------------------------------------------
// index.theme (pure)

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maxIconSize ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= maxIconSize ? parsed : fallback;
}

/** A theme name or subdirectory that cannot climb out of the icon directories. */
function safeRelativePath(value: string): boolean {
  return Boolean(value) && !value.includes("\0") && !isAbsolute(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function isSafeIconThemeName(name: string): boolean {
  return name.length <= 255 && !name.includes("/") && safeRelativePath(name);
}

/** The icon name itself: a file name without a directory, as the spec requires. */
export function isSafeIconName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.includes("/") && !name.includes("\0") && name !== "." && name !== "..";
}

/**
 * A theme's `[Icon Theme]` group and its directories (`Directories` and
 * `ScaledDirectories`); directories without a valid Size are skipped, as
 * GTK does. Null when the file has no `[Icon Theme]` group.
 */
export function parseIconThemeIndex(name: string, text: string): IconTheme | null {
  const groups = parseDesktopEntry(text);
  const header = groups.get("Icon Theme");
  if (!header) return null;
  const list = (key: string) => (header.get(key) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const inherits = list("Inherits").filter(isSafeIconThemeName);
  const names = [...list("Directories"), ...list("ScaledDirectories")];
  const directories: IconThemeDirectory[] = [];
  for (const path of names.filter((value, index) => names.indexOf(value) === index)) {
    if (directories.length >= maxDirectoriesPerTheme) break;
    const group = groups.get(path);
    if (!group || !safeRelativePath(path)) continue;
    const size = positiveInteger(group.get("Size"), 0);
    if (!size) continue;
    const declared = group.get("Type")?.trim();
    const type: IconDirectoryType = declared === "Fixed" || declared === "Scalable" ? declared : "Threshold";
    directories.push({
      path,
      size,
      scale: positiveInteger(group.get("Scale"), 1),
      type,
      minSize: positiveInteger(group.get("MinSize"), size),
      maxSize: positiveInteger(group.get("MaxSize"), size),
      threshold: nonNegativeInteger(group.get("Threshold"), 2),
    });
  }
  return { name, inherits, directories };
}

/** DirectoryMatchesSize from the spec. */
export function directoryMatchesSize(directory: IconThemeDirectory, size: number, scale: number): boolean {
  if (directory.scale !== scale) return false;
  if (directory.type === "Fixed") return directory.size === size;
  if (directory.type === "Scalable") return directory.minSize <= size && size <= directory.maxSize;
  return directory.size - directory.threshold <= size && size <= directory.size + directory.threshold;
}

/** DirectorySizeDistance from the spec, in device pixels. */
export function directorySizeDistance(directory: IconThemeDirectory, size: number, scale: number): number {
  const wanted = size * scale;
  if (directory.type === "Fixed") return Math.abs(directory.size * directory.scale - wanted);
  const low = directory.type === "Scalable" ? directory.minSize : directory.size - directory.threshold;
  const high = directory.type === "Scalable" ? directory.maxSize : directory.size + directory.threshold;
  if (wanted < low * directory.scale) return directory.minSize * directory.scale - wanted;
  if (wanted > high * directory.scale) return wanted - directory.maxSize * directory.scale;
  return 0;
}

/**
 * The theme, then its ancestors depth first in `Inherits` order (each once),
 * then hicolor, which every theme implicitly inherits. Missing themes are
 * skipped.
 */
export function iconThemeChain(start: string, themes: ReadonlyMap<string, IconTheme>): IconTheme[] {
  const chain: IconTheme[] = [];
  const seen = new Set<string>();
  const visit = (name: string, depth: number) => {
    if (seen.has(name) || depth > maxThemeDepth) return;
    seen.add(name);
    const theme = themes.get(name);
    if (!theme) return;
    chain.push(theme);
    for (const parent of theme.inherits) visit(parent, depth + 1);
  };
  visit(start, 0);
  if (!seen.has("hicolor")) visit("hicolor", 0);
  return chain;
}

/**
 * The search roots: `$HOME/.icons`, each `$XDG_DATA_DIRS/icons` (data home
 * first), then `/usr/share/pixmaps` for unthemed icons.
 */
export function iconBaseDirs(env: NodeJS.ProcessEnv, home: string, extras?: string[]): string[] {
  const dirs = [join(home, ".icons"), ...xdgDataDirs(env, home, extras).map((dir) => join(dir, "icons")), "/usr/share/pixmaps"];
  return dirs.filter((value, index) => dirs.indexOf(value) === index);
}

/**
 * LookupIcon from the spec for one theme: the first file in a directory
 * that matches the size, else the file in the nearest directory (the first
 * one found wins a tie). The theme's directory may exist in several base
 * directories; earlier bases win.
 */
export async function lookupThemedIcon(input: { icon: string; size: number; scale: number; theme: IconTheme; baseDirs: string[]; list: DirectoryLister }): Promise<ResolvedIconFile | null> {
  const { icon, size, scale, theme, baseDirs, list } = input;
  let closest: ResolvedIconFile | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const directory of theme.directories) {
    const matches = directoryMatchesSize(directory, size, scale);
    const distance = matches ? 0 : directorySizeDistance(directory, size, scale);
    if (!matches && distance >= closestDistance) continue;
    for (const base of baseDirs) {
      const dir = join(base, theme.name, directory.path);
      const names = await list(dir);
      if (!names) continue;
      const format = iconExtensions.find((extension) => names.has(`${icon}.${extension}`));
      if (!format) continue;
      const found = { path: join(dir, `${icon}.${format}`), format };
      if (matches) return found;
      closest = found;
      closestDistance = distance;
      break;
    }
  }
  return closest;
}

/** LookupFallbackIcon: `<base>/<icon>.<ext>` directly in a base directory. */
export async function lookupFallbackIcon(icon: string, baseDirs: string[], list: DirectoryLister): Promise<ResolvedIconFile | null> {
  for (const base of baseDirs) {
    const names = await list(base);
    if (!names) continue;
    const format = iconExtensions.find((extension) => names.has(`${icon}.${extension}`));
    if (format) return { path: join(base, `${icon}.${format}`), format };
  }
  return null;
}

/**
 * FindIcon from the spec: the theme chain, then the unthemed fallback. An
 * absolute `Icon=` path is used as is when it names a PNG or SVG file.
 */
export async function findIconFile(input: { icon: string | null; size: number; scale: number; chain: IconTheme[]; baseDirs: string[]; list: DirectoryLister }): Promise<ResolvedIconFile | null> {
  const { icon } = input;
  if (!icon || icon.includes("\0")) return null;
  if (isAbsolute(icon)) {
    const format = iconExtensions.find((extension) => icon.toLowerCase().endsWith(`.${extension}`));
    if (!format) return null;
    const slash = icon.lastIndexOf("/");
    const names = await input.list(icon.slice(0, slash) || "/");
    return names?.has(icon.slice(slash + 1)) ? { path: icon, format } : null;
  }
  if (!isSafeIconName(icon)) return null;
  for (const theme of input.chain) {
    const found = await lookupThemedIcon({ ...input, icon, theme });
    if (found) return found;
  }
  return lookupFallbackIcon(icon, input.baseDirs, input.list);
}

// ---------------------------------------------------------------------------
// The current theme's name (pure parsing)

/**
 * The string inside `gdbus call` output for the settings portal's
 * `ReadOne` (`(<'Papirus'>,)`) or older `Read` (`(<<'Papirus'>>,)`), or
 * `gsettings get` output (`'Papirus'`).
 */
export function parseGVariantString(output: string): string | null {
  const match = /'((?:[^'\\]|\\.)*)'/.exec(output);
  if (!match) return null;
  const value = match[1].replace(/\\(.)/g, "$1");
  return value || null;
}

/** `[Icons] Theme=` from KDE's kdeglobals. */
export function parseKdeIconTheme(text: string): string | null {
  return parseDesktopEntry(text).get("Icons")?.get("Theme")?.trim() || null;
}

// ---------------------------------------------------------------------------
// Loading from the system (side effects: file reads and read-only queries)

async function readSmallText(path: string, limit: number): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > limit) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The desktop's icon theme, read only: the settings portal (which also works
 * inside a Flatpak sandbox), then GSettings, then KDE's kdeglobals, else
 * hicolor. `run` lets tests stand in for gdbus and gsettings.
 */
export async function currentIconThemeName(input: { env: NodeJS.ProcessEnv; home: string; run?: CommandRunner; findTool: (name: string) => Promise<string | null> }): Promise<string> {
  const run = input.run ?? runCommand;
  const accept = (value: string | null) => value && isSafeIconThemeName(value) ? value : null;
  const gdbus = await input.findTool("gdbus");
  if (gdbus) {
    const portal = ["call", "--session", "--timeout", "1", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop"];
    for (const method of ["ReadOne", "Read"]) {
      try {
        const name = accept(parseGVariantString(await run(gdbus, [...portal, "--method", `org.freedesktop.portal.Settings.${method}`, "org.gnome.desktop.interface", "icon-theme"])));
        if (name) return name;
      } catch { /* the next source */ }
    }
  }
  const gsettings = await input.findTool("gsettings");
  if (gsettings) {
    try {
      const name = accept(parseGVariantString(await run(gsettings, ["get", "org.gnome.desktop.interface", "icon-theme"])));
      if (name) return name;
    } catch { /* the next source */ }
  }
  const configHome = input.env.XDG_CONFIG_HOME && isAbsolute(input.env.XDG_CONFIG_HOME) ? input.env.XDG_CONFIG_HOME : join(input.home, ".config");
  const kde = await readSmallText(join(configHome, "kdeglobals"), 256 * 1024);
  return accept(kde === null ? null : parseKdeIconTheme(kde)) ?? "hicolor";
}

/** A directory lister that reads each directory once. */
export function cachedDirectoryLister(): DirectoryLister {
  const cache = new Map<string, Promise<ReadonlySet<string> | null>>();
  return (path) => {
    let listing = cache.get(path);
    if (!listing) {
      listing = readdir(path).then((names) => new Set(names) as ReadonlySet<string>, () => null);
      cache.set(path, listing);
    }
    return listing;
  };
}

/**
 * The themes reachable from `start` (and hicolor), each read from the first
 * base directory that has its index.theme.
 */
export async function loadIconThemes(start: string, baseDirs: string[]): Promise<Map<string, IconTheme>> {
  const themes = new Map<string, IconTheme>();
  const pending = [start, "hicolor"];
  const seen = new Set<string>();
  while (pending.length && seen.size < 64) {
    const name = pending.shift()!;
    if (seen.has(name) || !isSafeIconThemeName(name)) continue;
    seen.add(name);
    for (const base of baseDirs) {
      const text = await readSmallText(join(base, name, "index.theme"), maxIndexThemeBytes);
      const theme = text === null ? null : parseIconThemeIndex(name, text);
      if (!theme) continue;
      themes.set(name, theme);
      pending.push(...theme.inherits);
      break;
    }
  }
  return themes;
}
