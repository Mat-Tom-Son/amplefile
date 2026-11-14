import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Linux "Open With" from the desktop's own data: freedesktop desktop entries,
 * mimeapps.list associations, and shared-mime-info. Parsing, resolution, and
 * Exec expansion are pure functions; the loaders below only read files and
 * run `gio`/`xdg-mime` with argument vectors. Nothing here changes a default
 * application or writes to the desktop's configuration.
 *
 * Specifications:
 * - Desktop Entry 1.5: https://specifications.freedesktop.org/desktop-entry-spec/latest/
 * - MIME Applications Associations 1.0.1: https://specifications.freedesktop.org/mime-apps-spec/latest/
 * - Shared MIME-info Database: https://specifications.freedesktop.org/shared-mime-info-spec/latest/
 */

export type DesktopEntryGroups = Map<string, Map<string, string>>;

export type DesktopAppSource = "user" | "system" | "flatpak" | "snap";

export interface DesktopApplicationsDir {
  /** The `applications` directory itself. */
  path: string;
  source: DesktopAppSource;
}

export interface LinuxDesktopApp {
  /** Desktop file id, for example `org.gnome.TextEditor.desktop`. */
  id: string;
  /** Absolute path of the desktop file that won precedence for this id. */
  path: string;
  source: DesktopAppSource;
  name: string;
  exec: string | null;
  tryExec: string | null;
  icon: string | null;
  workingDirectory: string | null;
  terminal: boolean;
  dbusActivatable: boolean;
  noDisplay: boolean;
  hidden: boolean;
  onlyShowIn: string[];
  notShowIn: string[];
  mimeTypes: string[];
}

export interface MimeAppsList {
  defaults: Map<string, string[]>;
  added: Map<string, string[]>;
  removed: Map<string, string[]>;
}

export interface MimeDatabase {
  aliases: Map<string, string>;
  /** Child type to its direct parents, in file order. */
  parents: Map<string, string[]>;
  globs: MimeGlob[];
}

export interface MimeGlob {
  weight: number;
  type: string;
  pattern: string;
  caseSensitive: boolean;
}

export interface LinuxOpenWithChoices {
  mimeType: string;
  /** Visible, launchable handlers: the default (when there is one) first. */
  apps: LinuxDesktopApp[];
  defaultId: string | null;
}

export type LinuxLaunchPlan = { kind: "spawn" | "exec"; command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };

const fallbackMimeType = "application/octet-stream";
const maxDesktopEntryBytes = 256 * 1024;
const maxApplicationsDepth = 4;

// ---------------------------------------------------------------------------
// Desktop entry parsing (pure)

/**
 * Groups and keys of a desktop entry; later duplicate keys are ignored as the
 * spec requires. mimeapps.list uses the same syntax with MIME types as keys.
 */
export function parseDesktopEntry(text: string, keys: "desktop-entry" | "mime-types" = "desktop-entry"): DesktopEntryGroups {
  const keyPattern = keys === "mime-types" ? /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/ : /^[A-Za-z0-9-]+(\[[A-Za-z0-9_.@-]+\])?$/;
  const groups: DesktopEntryGroups = new Map();
  let current: Map<string, string> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[ \t]+/, "");
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const end = line.indexOf("]");
      const name = end > 1 ? line.slice(1, end) : "";
      if (!name || /[[\]]/.test(name) || groups.has(name)) { current = null; continue; }
      current = new Map();
      groups.set(name, current);
      continue;
    }
    if (!current) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trimEnd();
    if (!keyPattern.test(key) || current.has(key)) continue;
    current.set(key, line.slice(equals + 1).replace(/^[ \t]+/, ""));
  }
  return groups;
}

/** The `string`/`localestring` escapes: `\s`, `\n`, `\t`, `\r`, and `\\`. */
export function unescapeDesktopString(value: string): string {
  return value.replace(/\\([sntr\\])/g, (_match, code: string) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[code] ?? code);
}

/** A semicolon-separated list, honoring `\;` inside an item. */
export function splitDesktopList(value: string): string[] {
  const items: string[] = [];
  let item = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      const next = value[index + 1];
      if (next === ";") { item += ";"; index += 1; continue; }
      item += char + next;
      index += 1;
      continue;
    }
    if (char === ";") { items.push(unescapeDesktopString(item)); item = ""; continue; }
    item += char;
  }
  if (item) items.push(unescapeDesktopString(item));
  return items.map((value) => value.trim()).filter(Boolean);
}

/**
 * Locale keys to try for `Name[...]`, most specific first, from LC_ALL,
 * LC_MESSAGES, or LANG: lang_COUNTRY@MODIFIER, lang_COUNTRY, lang@MODIFIER, lang.
 */
export function desktopLocaleKeys(env: NodeJS.ProcessEnv): string[] {
  const value = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  const match = /^([a-zA-Z]{2,3})(?:_([A-Za-z0-9]+))?(?:\.[^@]*)?(?:@(.+))?$/.exec(value);
  if (!match || value === "C" || value.startsWith("C.") || value === "POSIX") return [];
  const [, lang, country, modifier] = match;
  const keys: string[] = [];
  if (country && modifier) keys.push(`${lang}_${country}@${modifier}`);
  if (country) keys.push(`${lang}_${country}`);
  if (modifier) keys.push(`${lang}@${modifier}`);
  keys.push(lang);
  return keys;
}

function localizedValue(group: Map<string, string>, key: string, localeKeys: string[]): string | undefined {
  for (const locale of localeKeys) {
    const value = group.get(`${key}[${locale}]`);
    if (value !== undefined) return value;
  }
  return group.get(key);
}

function booleanValue(value: string | undefined): boolean {
  return value?.trim() === "true";
}

/**
 * An application entry from a desktop file, or null for anything that is not
 * a well-formed `Type=Application` entry. Visibility is decided separately.
 */
export function desktopAppFromEntry(input: { id: string; path: string; source: DesktopAppSource; text: string; env: NodeJS.ProcessEnv }): LinuxDesktopApp | null {
  const group = parseDesktopEntry(input.text).get("Desktop Entry");
  if (!group) return null;
  const localeKeys = desktopLocaleKeys(input.env);
  const hidden = booleanValue(group.get("Hidden"));
  const type = group.get("Type")?.trim();
  if (!hidden && type !== "Application") return null;
  const name = unescapeDesktopString(localizedValue(group, "Name", localeKeys) ?? "").trim();
  const exec = group.get("Exec");
  const dbusActivatable = booleanValue(group.get("DBusActivatable"));
  if (!hidden && (!name || (!exec?.trim() && !dbusActivatable))) return null;
  const optional = (key: string) => {
    const value = group.get(key);
    return value === undefined || !value.trim() ? null : unescapeDesktopString(value).trim();
  };
  return {
    id: input.id,
    path: input.path,
    source: input.source,
    name,
    exec: exec?.trim() ? exec.trim() : null,
    tryExec: optional("TryExec"),
    icon: optional("Icon"),
    workingDirectory: optional("Path"),
    terminal: booleanValue(group.get("Terminal")),
    dbusActivatable,
    noDisplay: booleanValue(group.get("NoDisplay")),
    hidden,
    onlyShowIn: splitDesktopList(group.get("OnlyShowIn") ?? ""),
    notShowIn: splitDesktopList(group.get("NotShowIn") ?? ""),
    mimeTypes: splitDesktopList(group.get("MimeType") ?? "").map((type) => type.toLowerCase()),
  };
}

/** The running desktops, honoring the value Electron saves before it overrides XDG_CURRENT_DESKTOP. */
export function currentDesktops(env: NodeJS.ProcessEnv): string[] {
  const value = env.ORIGINAL_XDG_CURRENT_DESKTOP ?? env.XDG_CURRENT_DESKTOP ?? "";
  return value.split(":").map((desktop) => desktop.trim()).filter(Boolean);
}

/**
 * Whether an entry belongs in a chooser: not Hidden or NoDisplay, and allowed
 * by OnlyShowIn/NotShowIn for the current desktops. (NoDisplay apps still
 * handle files when launched as defaults; a chooser leaves them out, as GNOME
 * and KDE do.)
 */
export function isDesktopAppShown(app: LinuxDesktopApp, desktops: string[]): boolean {
  if (app.hidden || app.noDisplay) return false;
  const lower = new Set(desktops.map((desktop) => desktop.toLowerCase()));
  if (app.onlyShowIn.length && !app.onlyShowIn.some((desktop) => lower.has(desktop.toLowerCase()))) return false;
  if (app.notShowIn.some((desktop) => lower.has(desktop.toLowerCase()))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Directories and precedence (pure)

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function dataSource(dataDir: string, home: string): DesktopAppSource {
  const normalized = trimTrailingSlash(dataDir);
  if (normalized.endsWith("/flatpak/exports/share")) return "flatpak";
  if (normalized.startsWith("/var/lib/snapd/desktop")) return "snap";
  return normalized === trimTrailingSlash(join(home, ".local/share")) ? "user" : "system";
}

/**
 * Data directories in precedence order: XDG_DATA_HOME, then XDG_DATA_DIRS
 * (default `/usr/local/share:/usr/share`). Flatpak's and Snap's exported
 * directories are appended when the session did not already list them.
 */
export function xdgDataDirs(env: NodeJS.ProcessEnv, home: string, extras = packagedAppDataDirs(home)): string[] {
  const absolute = (value: string) => isAbsolute(value) ? trimTrailingSlash(value) : null;
  const dataHome = absolute(env.XDG_DATA_HOME ?? "") ?? join(home, ".local/share");
  const listed = (env.XDG_DATA_DIRS?.trim() ? env.XDG_DATA_DIRS : "/usr/local/share:/usr/share")
    .split(":").map(absolute).filter((value): value is string => Boolean(value));
  const ordered = [dataHome, ...listed, ...extras];
  return ordered.filter((value, index) => ordered.indexOf(value) === index);
}

/** Flatpak's (user and system) and Snap's exported data directories. */
export function packagedAppDataDirs(home: string): string[] {
  return [join(home, ".local/share/flatpak/exports/share"), "/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop"];
}

export function applicationsDirs(env: NodeJS.ProcessEnv, home: string, extras = packagedAppDataDirs(home)): DesktopApplicationsDir[] {
  return xdgDataDirs(env, home, extras).map((dataDir) => ({ path: join(dataDir, "applications"), source: dataSource(dataDir, home) }));
}

/** Desktop file id: the path below `applications/` with `/` turned into `-`. */
export function desktopFileId(applicationsDir: string, filePath: string): string {
  return relative(applicationsDir, filePath).split(sep).join("-");
}

/**
 * mimeapps.list files in precedence order: per-desktop then generic, in
 * XDG_CONFIG_HOME, XDG_CONFIG_DIRS, XDG_DATA_HOME/applications, and each
 * XDG_DATA_DIRS/applications.
 */
export function mimeAppsListPaths(env: NodeJS.ProcessEnv, home: string, desktops: string[], extras = packagedAppDataDirs(home)): string[] {
  const absolute = (value: string) => isAbsolute(value) ? trimTrailingSlash(value) : null;
  const configHome = absolute(env.XDG_CONFIG_HOME ?? "") ?? join(home, ".config");
  const configDirs = (env.XDG_CONFIG_DIRS?.trim() ? env.XDG_CONFIG_DIRS : "/etc/xdg").split(":").map(absolute).filter((value): value is string => Boolean(value));
  const names = [...desktops.map((desktop) => `${desktop.toLowerCase()}-mimeapps.list`), "mimeapps.list"];
  const dirs = [configHome, ...configDirs, ...applicationsDirs(env, home, extras).map((dir) => dir.path)];
  const paths = dirs.flatMap((dir) => names.map((name) => join(dir, name)));
  return paths.filter((value, index) => paths.indexOf(value) === index);
}

export function parseMimeAppsList(text: string): MimeAppsList {
  const groups = parseDesktopEntry(text, "mime-types");
  const read = (name: string) => {
    const result = new Map<string, string[]>();
    for (const [type, value] of groups.get(name) ?? []) result.set(type.toLowerCase(), splitDesktopList(value));
    return result;
  };
  return { defaults: read("Default Applications"), added: read("Added Associations"), removed: read("Removed Associations") };
}

// ---------------------------------------------------------------------------
// MIME types (pure)

export function parseMimeDatabase(input: { aliases?: string; subclasses?: string; globs2?: string }): MimeDatabase {
  const pairs = (text: string | undefined) => (text ?? "").split("\n")
    .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/)).filter((parts) => parts.length >= 2)
    .map(([first, second]) => [first.toLowerCase(), second.toLowerCase()] as const);
  const aliases = new Map<string, string>();
  for (const [alias, canonical] of pairs(input.aliases)) if (!aliases.has(alias)) aliases.set(alias, canonical);
  const parents = new Map<string, string[]>();
  for (const [child, parent] of pairs(input.subclasses)) parents.set(child, [...(parents.get(child) ?? []), parent]);
  const globs: MimeGlob[] = [];
  for (const line of (input.globs2 ?? "").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [weight, type, pattern, flags = ""] = line.split(":");
    if (!type || !pattern || type === "__NOGLOBS__") continue;
    globs.push({ weight: Number(weight) || 50, type: type.toLowerCase(), pattern, caseSensitive: flags.split(",").includes("cs") });
  }
  return { aliases, parents, globs };
}

export function mergeMimeDatabases(databases: MimeDatabase[]): MimeDatabase {
  const merged: MimeDatabase = { aliases: new Map(), parents: new Map(), globs: [] };
  for (const database of databases) {
    for (const [alias, canonical] of database.aliases) if (!merged.aliases.has(alias)) merged.aliases.set(alias, canonical);
    for (const [child, parents] of database.parents) if (!merged.parents.has(child)) merged.parents.set(child, parents);
    merged.globs.push(...database.globs);
  }
  return merged;
}

function globExpression(pattern: string, caseSensitive: boolean): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, caseSensitive ? "" : "i");
}

/** A type from file name globs alone (the last fallback when gio and xdg-mime are missing). */
export function mimeTypeFromGlobs(fileName: string, globs: MimeGlob[]): string | null {
  let best: MimeGlob | null = null;
  for (const glob of globs) {
    if (!globExpression(glob.pattern, glob.caseSensitive).test(fileName)) continue;
    if (!best || glob.weight > best.weight || (glob.weight === best.weight && glob.pattern.length > best.pattern.length)) best = glob;
  }
  return best?.type ?? null;
}

/**
 * The type, its canonical name, and its ancestors in breadth-first order.
 * Every text/* type is a text/plain; application/octet-stream is left out
 * unless asked for, because every file would otherwise list every hex editor.
 */
export function mimeTypeLineage(type: string, database: MimeDatabase): string[] {
  const start = type.toLowerCase();
  const canonical = database.aliases.get(start) ?? start;
  const lineage: string[] = [];
  const queue = [canonical];
  if (start !== canonical) lineage.push(start);
  while (queue.length && lineage.length < 32) {
    const current = queue.shift()!;
    if (lineage.includes(current)) continue;
    lineage.push(current);
    const parents = [...(database.parents.get(current) ?? [])];
    if (current.startsWith("text/") && current !== "text/plain") parents.push("text/plain");
    queue.push(...parents.map((parent) => database.aliases.get(parent) ?? parent));
  }
  return canonical === fallbackMimeType ? lineage : lineage.filter((value) => value !== fallbackMimeType);
}

/** `standard::content-type: text/plain` from `gio info -a standard::content-type`. */
export function parseGioContentType(output: string): string | null {
  const match = /^\s*standard::content-type:\s*(\S+)\s*$/m.exec(output);
  return match && isMimeType(match[1]) ? match[1].toLowerCase() : null;
}

export function isMimeType(value: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value.trim());
}

// ---------------------------------------------------------------------------
// Association resolution (pure)

/**
 * The handlers for a type, following the MIME Applications Associations
 * spec: each mimeapps.list (in precedence order) adds its Added Associations
 * that a higher-precedence file did not remove, then removes its Removed
 * Associations from everything of lower precedence, including the entries'
 * own MimeType keys. Exact-type handlers come before those of parent types.
 * The default is the first installed Default Applications entry for the
 * nearest type; failing that, the first handler, which is what `gio open`
 * and `xdg-open` would choose.
 */
export function resolveMimeHandlers(input: {
  lineage: string[];
  /** Installed apps by id after precedence; order is data-directory order. */
  apps: Map<string, LinuxDesktopApp>;
  mimeAppsLists: MimeAppsList[];
  desktops: string[];
}): { ids: string[]; defaultId: string | null } {
  const ids: string[] = [];
  const add = (id: string) => { if (!ids.includes(id)) ids.push(id); };
  const usable = (id: string) => {
    const app = input.apps.get(id);
    return Boolean(app && !app.hidden);
  };
  let defaultId: string | null = null;
  for (const type of input.lineage) {
    const removed = new Set<string>();
    for (const list of input.mimeAppsLists) {
      if (!defaultId) {
        const chosen = (list.defaults.get(type) ?? []).find((id) => !removed.has(id) && usable(id));
        if (chosen) defaultId = chosen;
      }
      for (const id of list.added.get(type) ?? []) if (!removed.has(id) && usable(id)) add(id);
      for (const id of list.removed.get(type) ?? []) removed.add(id);
    }
    for (const [id, app] of input.apps) {
      if (!app.hidden && app.mimeTypes.includes(type) && !removed.has(id)) add(id);
    }
  }
  const shown = (id: string) => isDesktopAppShown(input.apps.get(id)!, input.desktops);
  // An explicitly chosen default is offered even when it sets NoDisplay: it is
  // what opening the file would use. Otherwise the first shown handler leads.
  if (defaultId && !shown(defaultId) && input.apps.get(defaultId)!.noDisplay && !input.apps.get(defaultId)!.hidden) {
    return { ids: [defaultId, ...ids.filter((id) => id !== defaultId && shown(id))], defaultId };
  }
  if (defaultId && !shown(defaultId)) defaultId = null;
  defaultId ??= ids.find(shown) ?? null;
  return { ids: [...(defaultId ? [defaultId] : []), ...ids.filter((id) => id !== defaultId && shown(id))], defaultId };
}

/**
 * Menu labels: the app's name, with its packaging added when two handlers
 * share one name (a Flatpak Chrome next to the system one, for example).
 */
export function openWithMenuLabels(apps: LinuxDesktopApp[]): Map<string, string> {
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const app of apps) counts.set(app.name, (counts.get(app.name) ?? 0) + 1);
  for (const app of apps) {
    if ((counts.get(app.name) ?? 0) < 2) { labels.set(app.id, app.name); continue; }
    const qualifier = app.source === "flatpak" ? "Flatpak" : app.source === "snap" ? "Snap" : app.id.replace(/\.desktop$/, "");
    labels.set(app.id, `${app.name} (${qualifier})`);
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Exec expansion and launching (pure)

interface ExecSegment { text: string; quoted: boolean }

/**
 * Splits an Exec value into arguments: string escapes first, then the Exec
 * quoting rules (double quotes; `\"`, `` \` ``, `\$`, `\\` inside them).
 */
export function tokenizeDesktopExec(exec: string): ExecSegment[][] {
  const value = unescapeDesktopString(exec);
  const tokens: ExecSegment[][] = [];
  let token: ExecSegment[] | null = null;
  let segment = "";
  let quoted = false;
  const flush = () => {
    if (segment) (token ??= []).push({ text: segment, quoted });
    segment = "";
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (char === "\\" && index + 1 < value.length && "\"`$\\".includes(value[index + 1])) { segment += value[index + 1]; index += 1; continue; }
      if (char === "\"") { (token ??= []).push({ text: segment, quoted: true }); segment = ""; quoted = false; continue; }
      segment += char;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n") {
      flush();
      if (token) tokens.push(token);
      token = null;
      continue;
    }
    if (char === "\"") { flush(); quoted = true; token ??= []; continue; }
    segment += char;
  }
  if (quoted) throw new Error("The app's command line has an unterminated quote.");
  flush();
  if (token) tokens.push(token);
  return tokens;
}

/**
 * The argument vector for opening one file, per the Desktop Entry field
 * codes: %f/%F the absolute path, %u/%U its file:// URI, %i `--icon <Icon>`,
 * %c the name, %k the desktop file, %% a percent sign; deprecated codes are
 * dropped. Only the first file code receives the file. A file code inside a
 * quoted argument is refused, because such commands usually hand that
 * argument to a shell. An Exec without any file code gets the path appended,
 * because the person asked this app to open this file.
 */
export function expandDesktopExec(exec: string, input: { filePath: string; name: string; icon: string | null; desktopFilePath: string | null }): string[] {
  if (!isAbsolute(input.filePath) || input.filePath.includes("\0")) throw new Error("An absolute file path is required.");
  const tokens = tokenizeDesktopExec(exec);
  const argv: string[] = [];
  let fileUsed = false;
  for (const segments of tokens) {
    if (segments.length === 1 && !segments[0].quoted) {
      const whole = segments[0].text;
      if (whole === "%F" || whole === "%U" || whole === "%f" || whole === "%u") {
        if (!fileUsed) argv.push(whole.toLowerCase() === "%u" ? pathToFileURL(input.filePath).href : input.filePath);
        fileUsed = true;
        continue;
      }
      if (whole === "%i") {
        if (input.icon) argv.push("--icon", input.icon);
        continue;
      }
    }
    let text = "";
    for (const segment of segments) {
      if (segment.quoted) {
        if (/%[fFuUick]/.test(segment.text.replace(/%%/g, ""))) throw new Error("The app's command line passes the file inside a quoted argument.");
        text += segment.text.replace(/%%/g, "%");
        continue;
      }
      for (let index = 0; index < segment.text.length; index += 1) {
        const char = segment.text[index];
        if (char !== "%" || index + 1 >= segment.text.length) { text += char; continue; }
        const code = segment.text[index + 1];
        index += 1;
        if (code === "%") text += "%";
        else if (code === "f" || code === "F") { if (!fileUsed) text += input.filePath; fileUsed = true; }
        else if (code === "u" || code === "U") { if (!fileUsed) text += pathToFileURL(input.filePath).href; fileUsed = true; }
        else if (code === "c") text += input.name;
        else if (code === "k") text += input.desktopFilePath ?? "";
        else if (code === "i") text += input.icon ?? "";
        // %d %D %n %N %v %m and unknown codes expand to nothing.
      }
    }
    // A quoted empty argument ("") stays; a word made only of empty field codes goes.
    if (text || segments.some((segment) => segment.quoted)) argv.push(text);
  }
  if (!argv.length) throw new Error("The app has no command to run.");
  if (!fileUsed) argv.push(input.filePath);
  return argv;
}

/**
 * The environment an opened app inherits: Electron's saved
 * XDG_CURRENT_DESKTOP restored, and what Chromium sets for its own process
 * removed. Chromium sets CHROME_DESKTOP to AmpleFile's desktop file,
 * NO_AT_BRIDGE=1 (which would turn off accessibility in a GTK app), and
 * GDK_BACKEND (overwriting any value the person had), so none of them is the
 * person's own setting.
 */
export function linuxLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  if (env.ORIGINAL_XDG_CURRENT_DESKTOP !== undefined) next.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
  delete next.ORIGINAL_XDG_CURRENT_DESKTOP;
  for (const key of ["CHROME_DESKTOP", "NO_AT_BRIDGE", "GDK_BACKEND", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "GIO_LAUNCHED_DESKTOP_FILE", "GIO_LAUNCHED_DESKTOP_FILE_PID"]) delete next[key];
  return next;
}

/**
 * How to start an app with one file. With `gio`, the desktop's own launcher
 * (`gio launch <desktop file> <absolute path>`) runs it, which handles
 * Flatpak, Snap, D-Bus activation, and terminal apps. The path is absolute,
 * so it is never read as an option; `--` is not passed because `gio launch`
 * would forward it as a file. Without gio, the Exec line is expanded here
 * and spawned directly, never through a shell; terminal apps then need
 * `xdg-terminal-exec` and are refused honestly without it.
 */
export function linuxOpenWithLaunchPlan(app: LinuxDesktopApp, filePath: string, tools: { gio: string | null; terminalExec: string | null; env: NodeJS.ProcessEnv; home: string }): LinuxLaunchPlan {
  if (!isAbsolute(filePath) || filePath.includes("\0")) throw new Error("An absolute file path is required.");
  const env = linuxLaunchEnvironment(tools.env);
  if (tools.gio) return { kind: "exec", command: tools.gio, args: ["launch", app.path, filePath], env, cwd: tools.home };
  if (!app.exec) throw new Error(`${app.name} can only be started by the desktop's launcher (gio).`);
  const argv = expandDesktopExec(app.exec, { filePath, name: app.name, icon: app.icon, desktopFilePath: app.path });
  const cwd = app.workingDirectory && isAbsolute(app.workingDirectory) ? app.workingDirectory : tools.home;
  if (app.terminal) {
    if (!tools.terminalExec) throw new Error(`${app.name} runs in a terminal, and no terminal launcher (gio or xdg-terminal-exec) is available.`);
    return { kind: "spawn", command: tools.terminalExec, args: argv, env, cwd };
  }
  const [command, ...args] = argv;
  return { kind: "spawn", command, args, env, cwd };
}

// ---------------------------------------------------------------------------
// Loading from the system (side effects: file reads and argv-only commands)

export async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!name || name.includes("\0")) return null;
  const candidates = name.includes("/")
    ? (isAbsolute(name) ? [name] : [])
    : (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter).filter((dir) => isAbsolute(dir)).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

async function readTextFile(path: string, limit = maxDesktopEntryBytes): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > limit) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function desktopFilesUnder(dir: string, depth = 0): Promise<string[]> {
  if (depth > maxApplicationsDepth) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await desktopFilesUnder(path, depth + 1));
    else if (entry.name.endsWith(".desktop") && (entry.isFile() || entry.isSymbolicLink())) files.push(path);
  }
  return files;
}

/** Installed applications by desktop file id; the first directory that has an id wins it, Hidden or not. */
export async function loadDesktopApps(dirs: DesktopApplicationsDir[], env: NodeJS.ProcessEnv): Promise<Map<string, LinuxDesktopApp>> {
  const apps = new Map<string, LinuxDesktopApp>();
  const claimed = new Set<string>();
  for (const dir of dirs) {
    for (const path of await desktopFilesUnder(dir.path)) {
      const id = desktopFileId(dir.path, path);
      if (claimed.has(id)) continue;
      claimed.add(id);
      const text = await readTextFile(path);
      const app = text === null ? null : desktopAppFromEntry({ id, path, source: dir.source, text, env });
      if (app) apps.set(id, app);
    }
  }
  return apps;
}

/** Removes apps whose TryExec program is missing. */
export async function withoutMissingTryExec(apps: Map<string, LinuxDesktopApp>, env: NodeJS.ProcessEnv): Promise<Map<string, LinuxDesktopApp>> {
  const kept = new Map<string, LinuxDesktopApp>();
  for (const [id, app] of apps) {
    if (app.tryExec && !(await findExecutable(app.tryExec, env))) continue;
    kept.set(id, app);
  }
  return kept;
}

export async function loadMimeAppsLists(paths: string[]): Promise<MimeAppsList[]> {
  const lists: MimeAppsList[] = [];
  for (const path of paths) {
    const text = await readTextFile(path);
    if (text !== null) lists.push(parseMimeAppsList(text));
  }
  return lists;
}

export async function loadMimeDatabase(dataDirs: string[]): Promise<MimeDatabase> {
  const databases: MimeDatabase[] = [];
  for (const dataDir of dataDirs) {
    const mimeDir = join(dataDir, "mime");
    const [aliases, subclasses, globs2] = await Promise.all(["aliases", "subclasses", "globs2"].map((name) => readTextFile(join(mimeDir, name), 8 * 1024 * 1024)));
    if (aliases !== null || subclasses !== null || globs2 !== null) {
      databases.push(parseMimeDatabase({ aliases: aliases ?? "", subclasses: subclasses ?? "", globs2: globs2 ?? "" }));
    }
  }
  return mergeMimeDatabases(databases);
}

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export const runCommand: CommandRunner = (command, args) => new Promise((resolveRun, rejectRun) => {
  execFile(command, args, { timeout: 5_000, maxBuffer: 256 * 1024, env: linuxLaunchEnvironment(process.env) }, (error, stdout) => error ? rejectRun(error) : resolveRun(String(stdout)));
});

/**
 * The file's type, sniffed by content and name through shared-mime-info:
 * `gio info` first (GLib, present on GNOME, KDE, and most other desktops),
 * then `xdg-mime query filetype`, then the name globs alone. The path is
 * absolute, so neither tool can read it as an option.
 */
export async function detectMimeType(filePath: string, input: { gio: string | null; xdgMime: string | null; database: MimeDatabase; run?: CommandRunner }): Promise<string> {
  if (!isAbsolute(filePath)) throw new Error("An absolute file path is required.");
  const run = input.run ?? runCommand;
  if (input.gio) {
    try {
      const type = parseGioContentType(await run(input.gio, ["info", "-a", "standard::content-type", filePath]));
      if (type) return type;
    } catch { /* fall through */ }
  }
  if (input.xdgMime) {
    try {
      const output = (await run(input.xdgMime, ["query", "filetype", filePath])).trim().split(/[;\s]/)[0] ?? "";
      if (isMimeType(output)) return output.toLowerCase();
    } catch { /* fall through */ }
  }
  return mimeTypeFromGlobs(basename(filePath), input.database.globs) ?? fallbackMimeType;
}

/** Everything the chooser shows for one file, read fresh from the desktop's data. */
export async function linuxOpenWithChoices(filePath: string, input: { env: NodeJS.ProcessEnv; home: string; run?: CommandRunner; extraDataDirs?: string[] }): Promise<LinuxOpenWithChoices & { gio: string | null }> {
  const { env, home } = input;
  const extras = input.extraDataDirs ?? packagedAppDataDirs(home);
  const desktops = currentDesktops(env);
  const dataDirs = xdgDataDirs(env, home, extras);
  const [gio, xdgMime, database] = await Promise.all([findExecutable("gio", env), findExecutable("xdg-mime", env), loadMimeDatabase(dataDirs)]);
  const mimeType = await detectMimeType(filePath, { gio, xdgMime, database, run: input.run });
  const apps = await withoutMissingTryExec(await loadDesktopApps(applicationsDirs(env, home, extras), env), env);
  const lists = await loadMimeAppsLists(mimeAppsListPaths(env, home, desktops, extras));
  const resolved = resolveMimeHandlers({ lineage: mimeTypeLineage(mimeType, database), apps, mimeAppsLists: lists, desktops });
  return { mimeType, apps: resolved.ids.map((id) => apps.get(id)!), defaultId: resolved.defaultId, gio };
}

/** A desktop file the person picked under Other…, read as data. */
export async function desktopAppFromFile(path: string, env: NodeJS.ProcessEnv): Promise<LinuxDesktopApp | null> {
  const text = await readTextFile(path);
  if (text === null) return null;
  const app = desktopAppFromEntry({ id: basename(path), path, source: "user", text, env });
  return app && !app.hidden ? app : null;
}
