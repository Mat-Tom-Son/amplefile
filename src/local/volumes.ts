import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readFile, readlink, stat, statfs } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * The drives a system file manager shows, for the file manager window
 * (docs/architecture.md, "Drives and the system Trash"). Host-only: the window
 * names a drive by the opaque id this module mints and opens its mount path
 * through the computer place.
 *
 * On Linux the source is the kernel's own mount table, `/proc/self/mountinfo`,
 * read as untrusted data: octal escapes are decoded, and a line that does not
 * parse is skipped. A drive is shown when it is somewhere a person mounts or
 * finds drives (`/run/media/<user>`, `/media`, `/mnt`, or a visible folder in
 * the home folder), or when it is any other real block-device mount outside
 * the system's own folders. Kernel and pseudo filesystems, snap and other
 * loop mounts, and every other mount of the disk the system started from
 * (Fedora's btrfs `/home` subvolume) are left out. On macOS the source is
 * `/Volumes` without the startup disk. Mount points are never followed: a link
 * in `/Volumes` (the startup disk's own entry) is skipped.
 */

export interface VolumeSummary {
  /** Opaque, minted by this process; stable while the drive stays mounted. */
  id: string;
  /** The drive's label, else its mount folder's name. */
  name: string;
  /** Where it is mounted; the window opens it through the computer place. */
  mountPath: string;
  /** Null when the drive cannot be measured (no permission, or a stalled network share). */
  totalBytes: number | null;
  /** Space the person can still use, as Finder and Files report it. */
  freeBytes: number | null;
  /** Whether AmpleFile offers Eject for it: a drive the person can remove or unmount without an administrator. */
  ejectable: boolean;
  /** The filesystem type, as supporting detail ("ext4", "exfat", "apfs"). */
  fileSystem: string | null;
}

export interface LinuxMount {
  mountId: number;
  parentId: number;
  majorMinor: string;
  /** The folder of the filesystem mounted here ("/" unless a subvolume or a bind mount). */
  root: string;
  mountPoint: string;
  options: string[];
  fileSystem: string;
  source: string;
  superOptions: string[];
}

/** Mount tables are read whole, but never more than this. */
const maxMountInfoBytes = 4 * 1024 * 1024;
const maxListedVolumes = 256;

/** Decodes the kernel's octal escapes (`\040` for a space); null when the decoded bytes are not text. */
export function decodeMountField(field: string): string | null {
  if (!field || field.includes("\0")) return null;
  const bytes: number[] = [];
  for (let index = 0; index < field.length; index += 1) {
    const char = field[index]!;
    if (char === "\\" && /^[0-7]{3}$/.test(field.slice(index + 1, index + 4))) {
      const value = Number.parseInt(field.slice(index + 1, index + 4), 8);
      if (value > 255) return null;
      bytes.push(value);
      index += 3;
      continue;
    }
    bytes.push(...Buffer.from(char, "utf8"));
  }
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  // A name that is not valid UTF-8 cannot be named back to the system exactly.
  if (!Buffer.from(text, "utf8").equals(buffer) || text.includes("\0")) return null;
  return text;
}

/** `/proc/self/mountinfo`, one mount per line (proc(5)); malformed lines are skipped. */
export function parseMountInfo(text: string): LinuxMount[] {
  const mounts: LinuxMount[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.length > 16_384) continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    if (separator < 6 || fields.length < separator + 4) continue;
    const mountId = Number(fields[0]);
    const parentId = Number(fields[1]);
    if (!Number.isSafeInteger(mountId) || !Number.isSafeInteger(parentId) || !/^\d+:\d+$/.test(fields[2]!)) continue;
    const root = decodeMountField(fields[3]!);
    const mountPoint = decodeMountField(fields[4]!);
    const fileSystem = decodeMountField(fields[separator + 1]!);
    const source = decodeMountField(fields[separator + 2]!) ?? "";
    if (!root || !mountPoint || !fileSystem || !mountPoint.startsWith("/") || !root.startsWith("/")) continue;
    if (mountPoint.split("/").some((part) => part === ".." || part === ".")) continue;
    mounts.push({
      mountId,
      parentId,
      majorMinor: fields[2]!,
      root,
      mountPoint: mountPoint.length > 1 ? mountPoint.replace(/\/+$/, "") : mountPoint,
      options: fields[5]!.split(","),
      fileSystem,
      source,
      superOptions: (fields[separator + 3] ?? "").split(","),
    });
  }
  return mounts;
}

/** Filesystems that are the kernel's or a sandbox's, never a drive. */
const pseudoFileSystems = new Set([
  "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs", "debugfs", "devpts", "devtmpfs", "efivarfs",
  "fusectl", "hugetlbfs", "mqueue", "nsfs", "overlay", "proc", "pstore", "ramfs", "rpc_pipefs", "securityfs",
  "selinuxfs", "squashfs", "sysfs", "tmpfs", "tracefs", "nfsd", "devfs", "aufs", "erofs",
  "fuse.portal", "fuse.gvfsd-fuse", "fuse.snapfuse", "fuse.lxcfs", "fuse.xdg-document-portal", "fuse.squashfuse",
  "fuse.flatpak", "fuse.revokefs-fuse",
]);

/** Folders that belong to the system: a mount at or under one is never a drive the person uses. */
const systemFolders = ["/proc", "/sys", "/dev", "/run", "/boot", "/efi", "/var", "/snap", "/usr", "/etc", "/tmp", "/opt",
  "/root", "/home", "/nix", "/gnu", "/sysroot", "/ostree", "/lib", "/lib64", "/bin", "/sbin", "/srv", "/swap", "/recovery"];

/** Where people mount and find drives; any real filesystem here is shown. */
function userMountFolders(user: string): string[] {
  return [`/run/media/${user}`, "/media", "/mnt"];
}

function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

export interface LinuxVolumeContext {
  home: string;
  user: string;
  /** Filesystem labels by device path (`/dev/sdb1` → "Photos"), from `/dev/disk/by-label`. */
  labels?: ReadonlyMap<string, string>;
  /** Whether the block device behind a mount is removable (`/sys/dev/block/M:m/…/removable`). */
  removable?: ReadonlySet<string>;
}

/**
 * The mounts a person would call drives. The root volume itself is the
 * computer place, not a drive; its subvolume and bind mounts are its own
 * folders. A mount point that is mounted over again shows the newest mount.
 */
export function linuxUserVolumes(mounts: readonly LinuxMount[], context: LinuxVolumeContext): Array<{ mount: LinuxMount; name: string; ejectable: boolean }> {
  const rootMount = [...mounts].reverse().find((mount) => mount.mountPoint === "/");
  const rootSource = rootMount && rootMount.source.startsWith("/dev/") ? rootMount.source : null;
  const userFolders = userMountFolders(context.user);
  const home = context.home.replace(/\/+$/, "");
  const newest = new Map<string, LinuxMount>();
  for (const mount of mounts) newest.set(mount.mountPoint, mount);
  const shown: Array<{ mount: LinuxMount; name: string; ejectable: boolean }> = [];
  for (const mount of newest.values()) {
    if (mount.mountPoint === "/" || pseudoFileSystems.has(mount.fileSystem)) continue;
    const path = mount.mountPoint;
    // Hidden folders (a dot segment) hold tool and sandbox mounts, never drives.
    if (path.split("/").some((part) => part.startsWith("."))) continue;
    const inUserFolder = userFolders.some((folder) => isUnder(folder, path) && path !== folder)
      || (path === "/mnt" || path === "/media");
    const inHome = home && home !== "/" && isUnder(home, path) && path !== home;
    const blockDevice = mount.source.startsWith("/dev/") && !mount.source.startsWith("/dev/loop") && !mount.source.startsWith("/dev/zram");
    const sameDiskAsRoot = rootSource !== null && mount.source === rootSource;
    if (inUserFolder || inHome) {
      // A loop mount there is a disk image the person opened; the root disk's own subvolumes are not drives.
      if (sameDiskAsRoot) continue;
    } else {
      if (!blockDevice || sameDiskAsRoot || mount.root !== "/") continue;
      if (systemFolders.some((folder) => isUnder(folder, path))) continue;
    }
    // Another mount of a shown disk's folder (a bind mount) is not a second drive.
    if (mount.root !== "/" && !inUserFolder) continue;
    // udisks mounts what the person plugs in under /run/media/<user> (or /media on Debian and Ubuntu); they unmount it without an administrator.
    const managedByDesktop = (isUnder(`/run/media/${context.user}`, path) && path !== `/run/media/${context.user}`)
      || (isUnder("/media", path) && path !== "/media" && path !== `/media/${context.user}`);
    const ejectable = managedByDesktop || context.removable?.has(mount.majorMinor) === true;
    const label = context.labels?.get(mount.source);
    shown.push({ mount, name: label || basename(path) || path, ejectable });
    if (shown.length >= maxListedVolumes) break;
  }
  return shown.sort((left, right) => left.name.localeCompare(right.name) || left.mount.mountPoint.localeCompare(right.mount.mountPoint));
}

/** udev's names in `/dev/disk/by-label` escape unsafe bytes as `\xNN`. */
export function decodeUdevLabel(name: string): string | null {
  const bytes: number[] = [];
  for (let index = 0; index < name.length; index += 1) {
    if (name[index] === "\\" && /^x[0-9a-fA-F]{2}$/.test(name.slice(index + 1, index + 4))) {
      bytes.push(Number.parseInt(name.slice(index + 2, index + 4), 16));
      index += 3;
      continue;
    }
    bytes.push(...Buffer.from(name[index]!, "utf8"));
  }
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer) || /[\0-\x1f\x7f]/.test(text)) return null;
  return text.trim() || null;
}

/** Labels from `/dev/disk/by-label`, whose entries are links; each link is read, never followed. */
async function linuxDeviceLabels(): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const folder = "/dev/disk/by-label";
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names.slice(0, 512)) {
    const target = await readlink(join(folder, name)).catch(() => null);
    const label = decodeUdevLabel(name);
    if (target && label) labels.set(resolve(folder, target), label);
  }
  return labels;
}

async function linuxRemovableDevices(mounts: readonly LinuxMount[]): Promise<Set<string>> {
  const removable = new Set<string>();
  for (const mount of mounts) {
    if (!mount.source.startsWith("/dev/") || removable.has(mount.majorMinor)) continue;
    // A partition's own folder has no `removable`; its disk is the folder above.
    const device = `/sys/dev/block/${mount.majorMinor}`;
    for (const candidate of [join(device, "removable"), join(device, "..", "removable")]) {
      const value = await readFile(candidate, "utf8").catch(() => null);
      if (value !== null) {
        if (value.trim() === "1") removable.add(mount.majorMinor);
        break;
      }
    }
  }
  return removable;
}

/** Space on the filesystem holding a path, without following a link at the path itself. */
export async function measureVolume(path: string): Promise<{ totalBytes: number; freeBytes: number } | null> {
  try {
    const info = await statfs(path);
    const total = Number(info.blocks) * Number(info.bsize);
    const free = Number(info.bavail) * Number(info.bsize);
    if (!Number.isFinite(total) || !Number.isFinite(free) || total < 0 || free < 0) return null;
    return { totalBytes: total, freeBytes: Math.min(free, total) };
  } catch {
    return null;
  }
}

/** A stalled network share must not hold the list up. */
const measureTimeoutMs = 1_500;

async function measureWithin(path: string): Promise<{ totalBytes: number; freeBytes: number } | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((done) => { timer = setTimeout(() => done(null), measureTimeoutMs); timer.unref(); });
  try { return await Promise.race([measureVolume(path), timeout]); }
  finally { clearTimeout(timer); }
}

const idKey = randomBytes(32);

function volumeId(mountPath: string, device: string): string {
  return `volume-${createHmac("sha256", idKey).update(`${mountPath}\0${device}`).digest("hex").slice(0, 20)}`;
}

/** What one listing knows about a volume beyond what the window sees: how to eject it. */
export interface VolumeRecord extends VolumeSummary {
  /** The device or share behind the mount, for the eject tool; never sent to the window. */
  device: string;
}

export interface VolumeListOptions {
  platform?: NodeJS.Platform;
  home?: string;
  user?: string;
  /** Linux: the mount table's text (tests pass a sample). */
  mountInfo?: string;
  labels?: ReadonlyMap<string, string>;
  removable?: ReadonlySet<string>;
  /** macOS: the folder holding mounted volumes (tests pass a sandbox). */
  volumesFolder?: string;
  /** macOS: whether a `/Volumes` entry is a mounted volume (tests stand in for a real mount). */
  isMounted?: (path: string, info: import("node:fs").Stats) => boolean;
  /** Skip measuring (tests that only check which drives are listed). */
  measure?: (path: string) => Promise<{ totalBytes: number; freeBytes: number } | null>;
}

type VolumeSource = (options?: VolumeListOptions) => Promise<VolumeRecord[]>;
let volumeSourceForTests: VolumeSource | null = null;

/** Tests replace the computer's drives with their own list; null restores the real one. */
export function setVolumeSourceForTests(source: VolumeSource | null): void {
  volumeSourceForTests = source;
}

/** The drives on this computer, with what Eject needs. */
export async function listVolumeRecords(options: VolumeListOptions = {}): Promise<VolumeRecord[]> {
  if (volumeSourceForTests) return volumeSourceForTests(options);
  const platform = options.platform ?? process.platform;
  const measure = options.measure ?? measureWithin;
  if (platform === "linux") {
    const text = options.mountInfo ?? await readMountInfo();
    const mounts = parseMountInfo(text);
    const visible = linuxUserVolumes(mounts, {
      home: options.home ?? homedir(),
      user: options.user ?? safeUserName(),
      labels: options.labels ?? (options.mountInfo === undefined ? await linuxDeviceLabels() : new Map()),
      removable: options.removable ?? (options.mountInfo === undefined ? await linuxRemovableDevices(mounts) : new Set()),
    });
    return Promise.all(visible.map(async ({ mount, name, ejectable }) => {
      const space = await measure(mount.mountPoint);
      return {
        id: volumeId(mount.mountPoint, `${mount.majorMinor}:${mount.source}`),
        name,
        mountPath: mount.mountPoint,
        totalBytes: space?.totalBytes ?? null,
        freeBytes: space?.freeBytes ?? null,
        ejectable,
        fileSystem: mount.fileSystem,
        device: mount.source,
      };
    }));
  }
  if (platform === "darwin") return listMacVolumes(options.volumesFolder ?? "/Volumes", measure, options.isMounted);
  return [];
}

/** The drives as the window sees them. */
export async function listVolumes(options: VolumeListOptions = {}): Promise<VolumeSummary[]> {
  return (await listVolumeRecords(options)).map(({ device: _device, ...volume }) => volume);
}

async function readMountInfo(): Promise<string> {
  const text = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  return text.length > maxMountInfoBytes ? text.slice(0, maxMountInfoBytes) : text;
}

function safeUserName(): string {
  try { return userInfo().username; } catch { return basename(homedir()); }
}

/**
 * `/Volumes` without the startup disk: its entry there is a link to `/`, and
 * links are skipped; an entry on the same device as `/` or as `/Volumes`
 * itself is a folder, not a mounted volume.
 */
async function listMacVolumes(
  folder: string,
  measure: (path: string) => Promise<{ totalBytes: number; freeBytes: number } | null>,
  isMounted?: (path: string, info: import("node:fs").Stats) => boolean,
): Promise<VolumeRecord[]> {
  const names = await readdir(folder).catch(() => [] as string[]);
  const folderInfo = await stat(folder).catch(() => null);
  const startup = await stat("/").catch(() => null);
  const data = await stat("/System/Volumes/Data").catch(() => null);
  const volumes: VolumeRecord[] = [];
  for (const name of names.slice(0, maxListedVolumes)) {
    if (!name || name.startsWith(".")) continue;
    const path = join(folder, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const mounted = isMounted
      ? isMounted(path, info)
      : !(folderInfo && info.dev === folderInfo.dev) && !(startup && info.dev === startup.dev) && !(data && info.dev === data.dev);
    if (!mounted) continue;
    const space = await measure(path);
    volumes.push({
      id: volumeId(path, String(info.dev)),
      name,
      mountPath: path,
      totalBytes: space?.totalBytes ?? null,
      freeBytes: space?.freeBytes ?? null,
      // Every mounted volume but the startup disk can be ejected with diskutil; it says when one cannot.
      ejectable: true,
      fileSystem: null,
      device: path,
    });
  }
  return volumes.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Space on the volume holding a path: total and what the person can still
 * use. The path need not exist; its nearest existing folder is measured, and a
 * link is never followed (its own folder is measured instead).
 */
export async function volumeSpaceForPath(path: string): Promise<{ totalBytes: number; freeBytes: number } | null> {
  let current = resolve(path);
  for (let depth = 0; depth < 4_096; depth += 1) {
    const info = await lstat(current).catch(() => null);
    if (info && info.isDirectory() && !info.isSymbolicLink()) return measureVolume(current);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

// Eject ------------------------------------------------------------------

export interface EjectCommand { command: string; args: string[] }
export interface EjectCommandResult { code: number | null; stdout: string; stderr: string; missing?: boolean }
export type EjectRunner = (command: EjectCommand) => Promise<EjectCommandResult>;

/**
 * The system's own tools, in the order tried. On Linux, `gio mount -e`
 * unmounts and safely removes the drive as Files does; `gio mount -u` unmounts
 * one that cannot be powered off; `udisksctl unmount` serves a desktop without
 * GIO. On macOS, `diskutil eject`, then `diskutil unmount` for a network share.
 */
export function ejectCommands(volume: Pick<VolumeRecord, "mountPath" | "device">, platform: NodeJS.Platform = process.platform): EjectCommand[] {
  if (platform === "darwin") {
    return [
      { command: "diskutil", args: ["eject", volume.mountPath] },
      { command: "diskutil", args: ["unmount", volume.mountPath] },
    ];
  }
  return [
    { command: "gio", args: ["mount", "-e", volume.mountPath] },
    { command: "gio", args: ["mount", "-u", volume.mountPath] },
    ...(volume.device.startsWith("/dev/") ? [{ command: "udisksctl", args: ["unmount", "--no-user-interaction", "-b", volume.device] }] : []),
  ];
}

const ejectTimeoutMs = 60_000;
const maxToolOutput = 16 * 1024;

/** Runs one tool without a shell, with a time limit and bounded output. */
export const runEjectCommand: EjectRunner = (command) => new Promise((done) => {
  let child: ChildProcess;
  let stdout = "";
  let stderr = "";
  try {
    child = spawn(command.command, command.args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
  } catch {
    done({ code: null, stdout, stderr, missing: true });
    return;
  }
  const timer = setTimeout(() => child.kill("SIGTERM"), ejectTimeoutMs);
  timer.unref();
  child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < maxToolOutput) stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < maxToolOutput) stderr += chunk.toString("utf8"); });
  child.once("error", (error) => {
    clearTimeout(timer);
    done({ code: null, stdout, stderr: stderr || error.message, missing: (error as { code?: string }).code === "ENOENT" });
  });
  child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
});

let ejectRunnerForTests: EjectRunner | null = null;

/** Tests record the tools an eject would run; null restores spawning them. */
export function setEjectRunnerForTests(runner: EjectRunner | null): void {
  ejectRunnerForTests = runner;
}

export class VolumeEjectError extends Error {
  readonly status: number;
  readonly statusCode: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.statusCode = status;
  }
}

function looksBusy(output: string): boolean {
  return /busy|in use|dissent|could not be unmounted|open files|EBUSY/i.test(output);
}

/**
 * Ejects one volume with the system's tools. A busy drive gets a plain
 * message; when no tool exists, so does that. The caller has checked that the
 * listing marks the volume ejectable and that no Connected Folder on it has
 * unfinished work.
 */
export async function ejectVolume(volume: VolumeRecord, platform: NodeJS.Platform = process.platform): Promise<void> {
  const run = ejectRunnerForTests ?? runEjectCommand;
  let missing = 0;
  let firstFailure = "";
  const commands = ejectCommands(volume, platform);
  // Each tool in turn until one succeeds: an eject a drive cannot do falls back to an unmount.
  for (const command of commands) {
    const result = await run(command);
    if (result.missing) { missing += 1; continue; }
    if (result.code === 0) return;
    const output = `${result.stderr}\n${result.stdout}`;
    if (looksBusy(output)) {
      throw new VolumeEjectError(409, `“${volume.name}” is in use. Close the files and apps using it, then try again.`);
    }
    firstFailure ||= output.trim().split("\n").find((line) => line.trim())?.trim().slice(0, 300) ?? "";
  }
  if (missing === commands.length) {
    throw new VolumeEjectError(503, platform === "darwin"
      ? "AmpleFile can’t eject drives here because diskutil isn’t available."
      : "AmpleFile can’t eject drives here: neither gio nor udisksctl is installed. Eject it from your file manager instead.");
  }
  throw new VolumeEjectError(500, `“${volume.name}” couldn’t be ejected${firstFailure ? `: ${firstFailure}` : "."}`);
}

// Change notification ------------------------------------------------------

export type VolumeEvent = { type: "volumes"; volumes: VolumeSummary[] };
type VolumeListener = (event: VolumeEvent) => void;

const listeners = new Set<VolumeListener>();
let monitor: { stop(): void } | null = null;
let lastSignature: string | null = null;
let lastVolumes: VolumeSummary[] = [];
let refreshTimer: NodeJS.Timeout | null = null;
let refreshing: Promise<void> | null = null;
let refreshAgain = false;

/** The set of drives, without their space, which changes all the time. */
function signature(volumes: readonly VolumeSummary[]): string {
  return JSON.stringify(volumes.map((volume) => [volume.id, volume.name, volume.mountPath, volume.ejectable]));
}

async function refresh(): Promise<void> {
  // A change while a read is running gets a read of its own after it.
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    try {
      const volumes = await listVolumes();
      const next = signature(volumes);
      lastVolumes = volumes;
      if (next === lastSignature) return;
      lastSignature = next;
      for (const listener of [...listeners]) { try { listener({ type: "volumes", volumes }); } catch { listeners.delete(listener); } }
    } catch { /* the next change tries again */ }
  })().finally(() => {
    refreshing = null;
    if (refreshAgain && listeners.size) { refreshAgain = false; void refresh(); }
  });
  return refreshing;
}

/** Many mount changes arrive together (a drive with several partitions); they share one refresh. */
function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 250);
  refreshTimer.unref();
}

/** Something changed the drives (an eject just finished): listeners hear soon, without waiting for the system's notice. */
export function noteVolumesMayHaveChanged(): void {
  if (listeners.size) scheduleRefresh();
}

/**
 * Linux: `findmnt --poll` waits on the kernel's own mount-table notification
 * and prints a line per change. Without it, the folders drives appear in are
 * watched instead, with a slow check for mounts elsewhere.
 */
function startLinuxMonitor(): { stop(): void } {
  let stopped = false;
  let fallback: { stop(): void } | null = null;
  let child: ChildProcess | null = null;
  try {
    child = spawn("findmnt", ["--poll", "--raw", "--noheadings", "--output", "ACTION"], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
  } catch { child = null; }
  const useFallback = () => {
    if (stopped || fallback) return;
    fallback = startFolderMonitor(["/run/media", `/run/media/${safeUserName()}`, "/media", `/media/${safeUserName()}`, "/mnt", "/run/mount"], 30_000);
  };
  if (child) {
    child.stdout?.on("data", () => scheduleRefresh());
    child.once("error", useFallback);
    child.once("exit", () => { child = null; useFallback(); });
    child.unref();
    (child.stdout as { unref?: () => void } | null)?.unref?.();
  } else useFallback();
  return {
    stop() {
      stopped = true;
      child?.kill("SIGTERM");
      fallback?.stop();
    },
  };
}

/** Watches folders where mounts appear, rearming for ones that appear later, plus a slow check. */
function startFolderMonitor(folders: readonly string[], checkEveryMs: number): { stop(): void } {
  const watchers = new Map<string, FSWatcher>();
  const arm = () => {
    for (const folder of folders) {
      if (watchers.has(folder)) continue;
      try {
        const watcher = watch(folder, () => { arm(); scheduleRefresh(); });
        watcher.on("error", () => { watcher.close(); watchers.delete(folder); });
        watcher.unref();
        watchers.set(folder, watcher);
      } catch { /* not there yet */ }
    }
  };
  arm();
  const timer = setInterval(() => { arm(); scheduleRefresh(); }, checkEveryMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

function startMonitor(): { stop(): void } {
  if (process.platform === "linux") return startLinuxMonitor();
  if (process.platform === "darwin") return startFolderMonitor(["/Volumes"], 60_000);
  return { stop() { /* no drives elsewhere */ } };
}

/**
 * Hears when the list of drives changes. The first event, sent right away,
 * is the current list; later events carry the whole new list when a drive
 * appears, goes, or is renamed (not when only its free space changes). The
 * monitor runs only while someone listens.
 */
export function subscribeVolumes(listener: VolumeListener): () => void {
  listeners.add(listener);
  if (!monitor) {
    monitor = startMonitor();
    lastSignature = null;
  }
  void listVolumes().then((volumes) => {
    if (!listeners.has(listener)) return;
    if (lastSignature === null) { lastSignature = signature(volumes); lastVolumes = volumes; }
    listener({ type: "volumes", volumes });
  }).catch(() => { if (listeners.has(listener)) listener({ type: "volumes", volumes: lastVolumes }); });
  return () => {
    listeners.delete(listener);
    if (!listeners.size && monitor) {
      monitor.stop();
      monitor = null;
      lastSignature = null;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    }
  };
}

/** Whether a path is on a volume: the volume's mount path or inside it. */
export function volumeHolds(volume: Pick<VolumeSummary, "mountPath">, path: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (value: string) => {
    const resolved = resolve(value).replace(/[\\/]+$/, "") || sep;
    return platform === "linux" ? resolved : resolved.toLocaleLowerCase();
  };
  const parent = fold(volume.mountPath);
  const child = fold(path);
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}
