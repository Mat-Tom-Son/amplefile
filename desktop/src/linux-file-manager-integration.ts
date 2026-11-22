import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import type {
  LinuxFileManagerStatus,
  OpenFoldersByDefaultStatus,
  ShowFilesFromOtherAppsStatus,
} from "../../src/shared/linux-file-manager-settings.js";
import { FileManagerService, fileManagerBusName, type FileManagerRequest, type FileManagerServiceState } from "./linux-file-manager-service.js";
import { busDaemonCall, SessionBusConnection } from "./linux-session-bus.js";

/**
 * Settings → File Manager on Linux: AmpleFile as the file manager other apps
 * use, as two choices the person makes in the app and can undo there.
 *
 * - **Show Files from Other Apps** writes a per-user D-Bus service file,
 *   `$XDG_DATA_HOME/dbus-1/services/org.freedesktop.FileManager1.service`,
 *   so the session bus starts AmpleFile on demand, and AmpleFile owns the
 *   name while it runs. A per-user service file takes precedence over the
 *   system file manager's file of the same name (dbus-daemon and
 *   dbus-broker both read `$XDG_DATA_HOME` before `$XDG_DATA_DIRS`). The file
 *   itself is the remembered choice. When the person already had their own
 *   file there, its bytes are kept inside AmpleFile's file, and turning the
 *   choice off writes them back.
 * - **Open Folders with AmpleFile** sets this user's default `inode/directory`
 *   handler with `xdg-mime` (or `gio mime`), remembering what was there, and
 *   turning it off restores that entry in `$XDG_CONFIG_HOME/mimeapps.list`.
 *
 * The packages install no service file and change no default.
 */

export const fileManagerServiceFileName = `${fileManagerBusName}.service`;
export const folderMimeType = "inode/directory";
const ampleFileMarker = "# Written by AmpleFile";
const replacedPrefix = "# amplefile-replaced: ";
const maxServiceFileBytes = 64 * 1024;
const maxMimeappsBytes = 1024 * 1024;
const maxDesktopEntryBytes = 256 * 1024;
const commandTimeoutMs = 5_000;

export interface LinuxFileManagerEnvironment {
  env: NodeJS.ProcessEnv;
  home: string;
  /** The command that starts this copy of AmpleFile. */
  launchCommand: string[];
  /** AmpleFile's desktop entry id, `amplefile-desktop.desktop`. */
  desktopId: string;
  /** Where the folder handler that was there before is remembered (in the app's data folder). */
  statePath: string;
  /** Runs a program without a shell and resolves its stdout; a missing program rejects with code ENOENT. */
  run?: (command: string, args: string[]) => Promise<string>;
}

function defaultRun(env: NodeJS.ProcessEnv) {
  return (command: string, args: string[]) => new Promise<string>((resolve, reject) => {
    execFile(command, args, { env, timeout: commandTimeoutMs, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function runner(environment: LinuxFileManagerEnvironment) {
  return environment.run ?? defaultRun(environment.env);
}

/** The command a service file or launcher uses to start this copy of AmpleFile. */
export function linuxFileManagerLaunchCommand(options: { isPackaged: boolean; execPath: string; appPath: string; appImage?: string }): string[] {
  // An AppImage's executable lives in a mount that ends with the process; start the image itself.
  if (options.isPackaged) return [options.appImage && isAbsolute(options.appImage) ? options.appImage : options.execPath];
  return [options.execPath, options.appPath];
}

// ---------------------------------------------------------------------------
// The D-Bus service file

function dataHome(environment: Pick<LinuxFileManagerEnvironment, "env" | "home">): string {
  const value = environment.env.XDG_DATA_HOME?.trim();
  return value && isAbsolute(value) ? value : join(environment.home, ".local", "share");
}

function dataDirs(env: NodeJS.ProcessEnv): string[] {
  const value = env.XDG_DATA_DIRS?.trim();
  const dirs = (value ? value.split(":") : ["/usr/local/share", "/usr/share"]).filter((dir) => isAbsolute(dir));
  return dirs.length ? dirs : ["/usr/local/share", "/usr/share"];
}

export function fileManagerServiceFilePath(environment: Pick<LinuxFileManagerEnvironment, "env" | "home">): string {
  return join(dataHome(environment), "dbus-1", "services", fileManagerServiceFileName);
}

/**
 * Quotes one argument for a service file's Exec line. dbus-daemon and
 * dbus-broker both split it with POSIX shell quoting (no expansion), so a
 * single-quoted word is taken literally. An argument with a single quote or
 * a control character is refused rather than escaped.
 */
export function serviceExecArgument(value: string): string {
  if (!value || /[\u0000-\u001f\u007f']/.test(value)) throw new Error(`AmpleFile can't be started from a path containing quotes or control characters (${JSON.stringify(value)}).`);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value}'`;
}

/** Splits an Exec line the way the bus does: single and double quotes, backslash escapes, no expansion. */
export function splitServiceExec(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) throw new Error("Unclosed quote in Exec.");
      word += line.slice(index + 1, end);
      index = end;
      inWord = true;
    } else if (char === "\"") {
      index += 1;
      while (index < line.length && line[index] !== "\"") {
        if (line[index] === "\\" && index + 1 < line.length && "\"\\$`\n".includes(line[index + 1]!)) index += 1;
        word += line[index];
        index += 1;
      }
      if (index >= line.length) throw new Error("Unclosed quote in Exec.");
      inWord = true;
    } else if (char === "\\" && index + 1 < line.length) {
      word += line[++index];
      inWord = true;
    } else if (char === " " || char === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

export function fileManagerServiceFileContent(launchCommand: string[], replaced: string | null): string {
  if (!launchCommand.length) throw new Error("AmpleFile doesn't know how to start itself.");
  const lines = [
    `${ampleFileMarker} for Settings → File Manager → Show Files from Other Apps.`,
    "# Turning that off removes this file and puts back any file it replaced.",
  ];
  if (replaced !== null) lines.push(`${replacedPrefix}${Buffer.from(replaced, "utf8").toString("base64")}`);
  lines.push("[D-BUS Service]", `Name=${fileManagerBusName}`, `Exec=${launchCommand.map(serviceExecArgument).join(" ")}`, "");
  return lines.join("\n");
}

export interface ParsedServiceFile {
  name: string | null;
  exec: string[] | null;
  writtenByAmpleFile: boolean;
  /** The earlier file AmpleFile replaced, from an AmpleFile-written file. */
  replaced: string | null;
}

export function parseServiceFile(text: string): ParsedServiceFile {
  let group: string | null = null;
  let name: string | null = null;
  let exec: string[] | null = null;
  let replaced: string | null = null;
  const lines = text.split(/\r?\n/);
  const writtenByAmpleFile = lines[0]?.startsWith(ampleFileMarker) ?? false;
  for (const raw of lines) {
    const line = raw.trim();
    if (writtenByAmpleFile && raw.startsWith(replacedPrefix)) {
      const encoded = raw.slice(replacedPrefix.length).trim();
      if (/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) && encoded.length <= maxServiceFileBytes * 2) {
        try {
          replaced = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
        } catch {
          replaced = null;
        }
      }
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      group = header[1]!;
      continue;
    }
    if (group !== "D-BUS Service") continue;
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (key === "Name" && name === null) name = value;
    else if (key === "Exec" && exec === null) {
      try {
        exec = splitServiceExec(value);
      } catch {
        exec = [];
      }
    }
  }
  return { name, exec, writtenByAmpleFile, replaced };
}

export type ServiceFileState =
  | { kind: "none" }
  | { kind: "ours"; exec: string[]; pointsHere: boolean; replaced: string | null }
  | { kind: "other"; program: string | null; content: string | null };

function sameCommand(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

async function readBounded(path: string, limit: number): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      const targetInfo = await lstat(target);
      if (!targetInfo.isFile() || targetInfo.size > limit) return null;
    } else if (!info.isFile() || info.size > limit) {
      return null;
    }
    const text = await readFile(path, "utf8");
    return text.length <= limit ? text : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    return null;
  }
}

export async function readFileManagerServiceFile(environment: Pick<LinuxFileManagerEnvironment, "env" | "home" | "launchCommand">): Promise<ServiceFileState> {
  let text: string | null;
  try {
    text = await readBounded(fileManagerServiceFilePath(environment), maxServiceFileBytes);
  } catch {
    return { kind: "none" };
  }
  if (text === null) return { kind: "other", program: null, content: null };
  const parsed = parseServiceFile(text);
  if (parsed.writtenByAmpleFile && parsed.name === fileManagerBusName && parsed.exec?.length) {
    return { kind: "ours", exec: parsed.exec, pointsHere: sameCommand(parsed.exec, environment.launchCommand), replaced: parsed.replaced };
  }
  return { kind: "other", program: programName(parsed.exec), content: text };
}

const knownFileManagers: Record<string, string> = {
  nautilus: "Files",
  dolphin: "Dolphin",
  nemo: "Nemo",
  thunar: "Thunar",
  caja: "Caja",
  "pcmanfm-qt": "PCManFM-Qt",
  pcmanfm: "PCManFM",
  "cosmic-files": "COSMIC Files",
};

function programName(exec: string[] | null): string | null {
  const program = exec?.[0];
  if (!program) return null;
  const name = basename(program);
  return knownFileManagers[name] ?? name;
}

/** The program the system's own FileManager1 service file starts, if one is installed. */
export async function systemFileManagerProgram(env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const dir of dataDirs(env)) {
    const servicesDir = join(dir, "dbus-1", "services");
    let names: string[];
    try {
      names = (await readdir(servicesDir)).filter((name) => name.endsWith(".service")).sort((a, b) => (a === fileManagerServiceFileName ? -1 : b === fileManagerServiceFileName ? 1 : a.localeCompare(b)));
    } catch {
      continue;
    }
    for (const name of names.slice(0, 2_000)) {
      let text: string | null;
      try {
        text = await readBounded(join(servicesDir, name), maxServiceFileBytes);
      } catch {
        continue;
      }
      if (!text || !text.includes(fileManagerBusName)) continue;
      const parsed = parseServiceFile(text);
      if (parsed.name === fileManagerBusName) return programName(parsed.exec);
    }
  }
  return null;
}

/** Writes a file by renaming a sibling into place, so a reader never sees half of it; through a symbolic link, the link's target is replaced. */
async function writeAtomically(path: string, content: string): Promise<void> {
  let target = path;
  try {
    if ((await lstat(path)).isSymbolicLink()) target = await realpath(path);
  } catch {
    // A missing file is written where it was asked for.
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.amplefile-${process.pid}-${Date.now()}`);
  try {
    await writeFile(temporary, content, { mode: 0o644, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Puts AmpleFile's service file in place, keeping the person's own earlier file inside it. */
export async function writeFileManagerServiceFile(environment: Pick<LinuxFileManagerEnvironment, "env" | "home" | "launchCommand">): Promise<void> {
  const current = await readFileManagerServiceFile(environment);
  if (current.kind === "other" && current.content === null) {
    throw new Error(`AmpleFile can't set this up: ${fileManagerServiceFilePath(environment)} isn't a file AmpleFile can read and keep. Move it away and try again.`);
  }
  const replaced = current.kind === "other" ? current.content : current.kind === "ours" ? current.replaced : null;
  await writeAtomically(fileManagerServiceFilePath(environment), fileManagerServiceFileContent(environment.launchCommand, replaced));
}

/** Removes AmpleFile's service file, putting back the file it replaced; leaves anyone else's file alone. */
export async function removeFileManagerServiceFile(environment: Pick<LinuxFileManagerEnvironment, "env" | "home" | "launchCommand">): Promise<boolean> {
  const current = await readFileManagerServiceFile(environment);
  if (current.kind !== "ours") return false;
  const path = fileManagerServiceFilePath(environment);
  if (current.replaced !== null) await writeAtomically(path, current.replaced);
  else await rm(path, { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// The default folder handler

function configHome(environment: Pick<LinuxFileManagerEnvironment, "env" | "home">): string {
  const value = environment.env.XDG_CONFIG_HOME?.trim();
  return value && isAbsolute(value) ? value : join(environment.home, ".config");
}

export function userMimeappsPath(environment: Pick<LinuxFileManagerEnvironment, "env" | "home">): string {
  return join(configHome(environment), "mimeapps.list");
}

/** The raw value of `mime` in a mimeapps.list's [Default Applications], or null. */
export function mimeappsDefault(text: string, mime: string): string | null {
  let inDefaults = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      inDefaults = header[1] === "Default Applications";
      continue;
    }
    if (!inDefaults || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals > 0 && line.slice(0, equals).trim() === mime) return line.slice(equals + 1).trim();
  }
  return null;
}

/**
 * The mimeapps.list text with `mime` in [Default Applications] set to
 * `value`, or removed when `value` is null. Every other line stays as it was.
 */
export function withMimeappsDefault(text: string, mime: string, value: string | null): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  let inDefaults = false;
  let groupEnd = -1;
  let found = false;
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      if (inDefaults) groupEnd = out.length;
      inDefaults = header[1] === "Default Applications";
      out.push(raw);
      continue;
    }
    const equals = line.indexOf("=");
    if (inDefaults && !line.startsWith("#") && equals > 0 && line.slice(0, equals).trim() === mime) {
      if (!found && value !== null) out.push(`${mime}=${value}`);
      found = true;
      continue;
    }
    out.push(raw);
  }
  if (inDefaults) groupEnd = out.length;
  if (!found && value !== null) {
    if (groupEnd >= 0) {
      // After the group's last entry, before any blank lines that separate it from the next group.
      let insertAt = groupEnd;
      while (insertAt > 0 && out[insertAt - 1]!.trim() === "") insertAt -= 1;
      out.splice(insertAt, 0, `${mime}=${value}`);
    } else {
      if (out.length && out[out.length - 1]!.trim() !== "") out.push("");
      out.push("[Default Applications]", `${mime}=${value}`);
    }
  }
  return out.length ? out.join(newline) + newline : "";
}

async function readUserMimeapps(environment: LinuxFileManagerEnvironment): Promise<string> {
  try {
    const text = await readBounded(userMimeappsPath(environment), maxMimeappsBytes);
    if (text === null) throw new Error(`AmpleFile can't read ${userMimeappsPath(environment)}.`);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function isMissingProgram(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** The desktop entry id folders open with now, as the desktop resolves it, or null when none is set. */
export async function queryFolderHandler(environment: LinuxFileManagerEnvironment): Promise<string | null> {
  const run = runner(environment);
  try {
    const id = (await run("xdg-mime", ["query", "default", folderMimeType])).trim().split(/\r?\n/)[0]?.trim() ?? "";
    return /^[^\s/]+\.desktop$/.test(id) ? id : null;
  } catch (error) {
    if (!isMissingProgram(error)) throw new Error(`xdg-mime couldn't say how folders open (${messageOf(error)}).`);
  }
  try {
    const output = await run("gio", ["mime", folderMimeType]);
    const match = /^[^\n]*Default application[^\n]*:\s*(\S+\.desktop)\s*$/m.exec(output);
    return match?.[1] ?? null;
  } catch (error) {
    if (isMissingProgram(error)) throw new MissingToolsError();
    if (/No default application/i.test(String((error as { stdout?: unknown }).stdout ?? ""))) return null;
    throw new Error(`gio couldn't say how folders open (${messageOf(error)}).`);
  }
}

class MissingToolsError extends Error {
  constructor() {
    super("Changing how folders open needs xdg-mime (from xdg-utils) or gio (from GLib), and neither is installed.");
  }
}

async function setFolderHandlerWithTools(environment: LinuxFileManagerEnvironment, desktopId: string): Promise<void> {
  const run = runner(environment);
  try {
    await run("xdg-mime", ["default", desktopId, folderMimeType]);
    return;
  } catch (error) {
    if (!isMissingProgram(error)) throw new Error(`xdg-mime couldn't change how folders open (${messageOf(error)}).`);
  }
  try {
    await run("gio", ["mime", folderMimeType, desktopId]);
  } catch (error) {
    if (isMissingProgram(error)) throw new MissingToolsError();
    throw new Error(`gio couldn't change how folders open (${messageOf(error)}).`);
  }
}

/** The desktop entry file for an id, searched as the desktop does ($XDG_DATA_HOME, then $XDG_DATA_DIRS). */
export async function findDesktopEntry(environment: Pick<LinuxFileManagerEnvironment, "env" | "home">, desktopId: string): Promise<string | null> {
  if (!/^[^\s/]+\.desktop$/.test(desktopId)) return null;
  for (const dir of [dataHome(environment), ...dataDirs(environment.env)]) {
    const path = join(dir, "applications", desktopId);
    try {
      if ((await lstat(path)).isFile() || (await lstat(await realpath(path))).isFile()) return path;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/** An app's name from its desktop entry, or the id without `.desktop`. */
export async function desktopEntryName(environment: Pick<LinuxFileManagerEnvironment, "env" | "home">, desktopId: string): Promise<string> {
  const fallback = desktopId.replace(/\.desktop$/, "");
  const path = await findDesktopEntry(environment, desktopId);
  if (!path) return fallback;
  try {
    const text = await readBounded(path, maxDesktopEntryBytes);
    let inEntry = false;
    for (const raw of (text ?? "").split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^\[(.+)\]$/.exec(line);
      if (header) {
        inEntry = header[1] === "Desktop Entry";
        continue;
      }
      if (inEntry && line.startsWith("Name=")) {
        const name = line.slice("Name=".length).trim();
        return name && name.length <= 80 ? name : fallback;
      }
    }
  } catch {
    // Fall back to the id.
  }
  return fallback;
}

interface FolderHandlerRecord {
  /** The [Default Applications] value mimeapps.list had for folders, or null when it had none. */
  userEntry: string | null;
  /** The handler the desktop resolved before AmpleFile, for naming it. */
  effective: string | null;
}

async function readRecord(statePath: string): Promise<FolderHandlerRecord | null> {
  try {
    const data = JSON.parse(await readFile(statePath, "utf8")) as { version?: unknown; folderHandler?: unknown };
    const record = data.folderHandler as Partial<FolderHandlerRecord> | undefined;
    if (data.version !== 1 || !record) return null;
    const text = (value: unknown) => value === null || (typeof value === "string" && value.length <= 4096 && !/[\r\n]/.test(value));
    return text(record.userEntry) && text(record.effective) ? { userEntry: record.userEntry ?? null, effective: record.effective ?? null } : null;
  } catch {
    return null;
  }
}

async function writeRecord(statePath: string, record: FolderHandlerRecord | null): Promise<void> {
  if (record === null) {
    await rm(statePath, { force: true });
    return;
  }
  await writeAtomically(statePath, `${JSON.stringify({ version: 1, folderHandler: record }, null, 2)}\n`);
}

function firstDesktopId(value: string | null): string | null {
  return value?.split(";").map((part) => part.trim()).find((part) => part.endsWith(".desktop")) ?? null;
}

export async function openFoldersByDefaultStatus(environment: LinuxFileManagerEnvironment): Promise<OpenFoldersByDefaultStatus> {
  let current: string | null;
  try {
    current = await queryFolderHandler(environment);
  } catch (error) {
    return { state: "unavailable", current: null, previous: null, reason: messageOf(error) };
  }
  const currentName = current ? await desktopEntryName(environment, current) : null;
  if (current === environment.desktopId) {
    const record = await readRecord(environment.statePath);
    const previousId = firstDesktopId(record?.userEntry ?? null) ?? record?.effective ?? null;
    return { state: "on", current: currentName, previous: previousId ? await desktopEntryName(environment, previousId) : null, reason: null };
  }
  if (!await findDesktopEntry(environment, environment.desktopId)) {
    return {
      state: "unavailable",
      current: currentName,
      previous: null,
      reason: `AmpleFile's desktop entry (${environment.desktopId}) isn't installed, so the desktop can't open folders with it. Installing AmpleFile's DEB or RPM package adds it.`,
    };
  }
  return { state: "off", current: currentName, previous: null, reason: null };
}

/** Makes AmpleFile this user's default folder handler, remembering what was there. */
export async function setOpenFoldersByDefault(environment: LinuxFileManagerEnvironment): Promise<void> {
  const before = await queryFolderHandler(environment);
  if (before === environment.desktopId) return;
  if (!await findDesktopEntry(environment, environment.desktopId)) {
    throw new Error(`AmpleFile's desktop entry (${environment.desktopId}) isn't installed, so the desktop can't open folders with it.`);
  }
  const mimeappsBefore = await readUserMimeapps(environment);
  const record: FolderHandlerRecord = { userEntry: mimeappsDefault(mimeappsBefore, folderMimeType), effective: before };
  await writeRecord(environment.statePath, record);
  await setFolderHandlerWithTools(environment, environment.desktopId);
  const after = await queryFolderHandler(environment);
  if (after !== environment.desktopId) {
    // Leave things as they were: put the person's own entry back.
    await restoreUserEntry(environment, record.userEntry);
    await writeRecord(environment.statePath, null);
    const name = after ? await desktopEntryName(environment, after) : "no app";
    throw new Error(`Folders still open with ${name}: a setting AmpleFile doesn't change takes precedence over your own (${userMimeappsPath(environment)}).`);
  }
}

async function restoreUserEntry(environment: LinuxFileManagerEnvironment, userEntry: string | null): Promise<void> {
  const text = await readUserMimeapps(environment);
  const next = withMimeappsDefault(text, folderMimeType, userEntry);
  if (next !== text) await writeAtomically(userMimeappsPath(environment), next);
}

/** Gives folders back to what opened them before; when AmpleFile isn't the handler, changes nothing. */
export async function unsetOpenFoldersByDefault(environment: LinuxFileManagerEnvironment): Promise<void> {
  const current = await queryFolderHandler(environment);
  const record = await readRecord(environment.statePath);
  if (current !== environment.desktopId) {
    await writeRecord(environment.statePath, null);
    return;
  }
  const userEntry = mimeappsDefault(await readUserMimeapps(environment), folderMimeType);
  if (firstDesktopId(userEntry) !== environment.desktopId) {
    throw new Error("Folders open with AmpleFile because of a setting outside your own mimeapps.list, which AmpleFile didn't make and can't undo.");
  }
  // xdg-mime and gio can set a default but not remove one, so the entry is restored in mimeapps.list itself.
  await restoreUserEntry(environment, record && firstDesktopId(record.userEntry) !== environment.desktopId ? record.userEntry : null);
  await writeRecord(environment.statePath, null);
  if (await queryFolderHandler(environment) === environment.desktopId) {
    throw new Error("Folders still open with AmpleFile: the desktop's own default names it. Choose another app in your desktop's settings.");
  }
}

// ---------------------------------------------------------------------------
// The whole choice, as Settings sees it

export interface LinuxFileManagerIntegrationOptions {
  environment: LinuxFileManagerEnvironment;
  onRequest: (request: FileManagerRequest) => void;
  log?: (message: string) => void;
  /** Tests stand in a private bus or a fake service. */
  service?: FileManagerService;
}

export class LinuxFileManagerIntegration {
  readonly service: FileManagerService;
  private readonly log: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: LinuxFileManagerIntegrationOptions) {
    this.log = options.log ?? (() => {});
    this.service = options.service ?? new FileManagerService({ onRequest: options.onRequest, log: this.log });
  }

  private get environment(): LinuxFileManagerEnvironment { return this.options.environment; }

  /** One change at a time: a status read never sees half of a change. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** At startup: answer as the file manager when the person chose this copy of AmpleFile. */
  startIfChosen(): Promise<void> {
    return this.serialize(async () => {
      const file = await readFileManagerServiceFile(this.environment);
      if (file.kind === "ours" && file.pointsHere) await this.service.start();
    });
  }

  stop(): Promise<void> {
    return this.service.stop();
  }

  status(): Promise<LinuxFileManagerStatus> {
    return this.serialize(() => this.readStatus());
  }

  setShowFilesFromOtherApps(enabled: boolean): Promise<LinuxFileManagerStatus> {
    return this.serialize(async () => {
      if (enabled) {
        await writeFileManagerServiceFile(this.environment);
        await this.reloadBus();
        await this.service.start();
      } else {
        await this.service.stop();
        if (await removeFileManagerServiceFile(this.environment)) await this.reloadBus();
      }
      return this.readStatus();
    });
  }

  setOpenFoldersByDefault(enabled: boolean): Promise<LinuxFileManagerStatus> {
    return this.serialize(async () => {
      if (enabled) await setOpenFoldersByDefault(this.environment);
      else await unsetOpenFoldersByDefault(this.environment);
      return this.readStatus();
    });
  }

  private async readStatus(): Promise<LinuxFileManagerStatus> {
    const [showFilesFromOtherApps, openFoldersByDefault] = await Promise.all([this.showFilesStatus(), openFoldersByDefaultStatus(this.environment)]);
    return { showFilesFromOtherApps, openFoldersByDefault };
  }

  private async showFilesStatus(): Promise<ShowFilesFromOtherAppsStatus> {
    const file = await readFileManagerServiceFile(this.environment);
    const systemFileManager = await systemFileManagerProgram(this.environment.env);
    if (file.kind === "none") return { state: "off", reason: null, replaced: null, systemFileManager };
    if (file.kind === "other") return { state: "off", reason: null, replaced: null, systemFileManager: file.program ?? systemFileManager };
    const replaced = file.replaced !== null ? programName(parseServiceFile(file.replaced).exec) : null;
    if (!file.pointsHere) {
      return { state: "elsewhere", reason: `Set up for another copy of AmpleFile (${file.exec[0]}). Turn this on to use this copy.`, replaced, systemFileManager };
    }
    let state = this.service.current();
    if (state.kind === "stopped") state = await this.service.start();
    return { ...serviceStateView(state), replaced, systemFileManager };
  }

  /** Asks the bus to read service files again; dbus-broker reads them only then. */
  private async reloadBus(): Promise<void> {
    const live = this.service.busConnection();
    let connection: SessionBusConnection | null = null;
    try {
      connection = live ?? await SessionBusConnection.open({ env: this.environment.env });
      await busDaemonCall(connection, "ReloadConfig", "", [], 5_000);
    } catch (error) {
      this.log(`could not ask the session bus to reload its service files: ${messageOf(error)}`);
    } finally {
      if (connection && connection !== live) connection.close();
    }
  }
}

function serviceStateView(state: FileManagerServiceState): Pick<ShowFilesFromOtherAppsStatus, "state" | "reason"> {
  switch (state.kind) {
    case "owner":
      return { state: "on", reason: null };
    case "queued":
      return { state: "waiting", reason: `${state.currentOwner ?? "Another file manager"} is answering for now. AmpleFile takes over when it closes.` };
    case "unavailable":
      return { state: "unavailable", reason: state.reason };
    default:
      return { state: "waiting", reason: "AmpleFile is getting ready to answer." };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
