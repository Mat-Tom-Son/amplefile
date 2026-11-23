import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readFile, readlink, statfs } from "node:fs/promises";
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
 * (Fedora's btrfs `/home` subvolume) are left out. On macOS the source is the
 * system's mount table too, as `/sbin/mount` prints it: the mounts directly
 * inside `/Volumes`. The startup disk is not among them, because its entry
 * there is a link, not a mount.
 *
 * Finding the drives asks no drive anything, so a share whose server has gone
 * cannot hold the list up. Measuring a drive does ask it, and is bounded
 * (`MountCalls`).
 */

export interface VolumeSummary {
  /** Opaque, minted by this process; stable while the drive stays mounted. */
  id: string;
  /** The drive's label, else its mount folder's name. */
  name: string;
  /** Where it is mounted; the window opens it through the computer place. */
  mountPath: string;
  /** Null when the drive cannot be measured (no permission, or a drive that has stopped answering). */
  totalBytes: number | null;
  /** Space the person can still use, as Finder and Files report it. */
  freeBytes: number | null;
  /** Whether AmpleFile offers Eject for it: a drive the person can remove or unmount without an administrator. */
  ejectable: boolean;
  /** The filesystem type, as supporting detail ("ext4", "exfat", "apfs", "smbfs"). */
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

// System tools ---------------------------------------------------------------

export interface ToolCommand { command: string; args: string[] }
export interface ToolResult { code: number | null; stdout: string; stderr: string; missing?: boolean }
export interface ToolLimits {
  /** How long the tool may run before it is stopped. */
  timeoutMs?: number;
  /** How much of each output stream is kept, in characters. */
  maxOutput?: number;
  /**
   * A tool that only reads. One that runs over its time is killed outright and
   * let go of, so a tool the kernel will not let die (one waiting on a share
   * whose server has gone) cannot hold this process open. Its answer comes only
   * when it has really gone, which may be never: a caller that cannot wait
   * races it (`answerWithin`).
   */
  readOnly?: boolean;
}
export type ToolRunner = (command: ToolCommand, limits?: ToolLimits) => Promise<ToolResult>;
/** Eject's tools have the same shape. */
export type EjectCommand = ToolCommand;
export type EjectCommandResult = ToolResult;
export type EjectRunner = ToolRunner;

const toolTimeoutMs = 60_000;
const maxToolOutput = 16 * 1024;

/** Runs one tool without a shell, with a time limit and bounded output. */
export const runTool: ToolRunner = (command, limits = {}) => new Promise((done) => {
  const maxOutput = limits.maxOutput ?? maxToolOutput;
  let child: ChildProcess;
  let stdout = "";
  let stderr = "";
  try {
    child = spawn(command.command, command.args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
  } catch {
    done({ code: null, stdout, stderr, missing: true });
    return;
  }
  const timer = setTimeout(() => {
    if (!limits.readOnly) { child.kill("SIGTERM"); return; }
    child.kill("SIGKILL");
    child.unref();
    for (const stream of [child.stdout, child.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
  }, limits.timeoutMs ?? toolTimeoutMs);
  timer.unref();
  // Decoded as a stream, so a name whose bytes fall in two chunks stays whole.
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < maxOutput) stdout = (stdout + chunk).slice(0, maxOutput); });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < maxOutput) stderr = (stderr + chunk).slice(0, maxOutput); });
  child.once("error", (error) => {
    clearTimeout(timer);
    done({ code: null, stdout, stderr: stderr || error.message, missing: (error as { code?: string }).code === "ENOENT" });
  });
  child.once("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
});

/** A tool's answer, or null when none has come a moment after the tool's own time limit. */
async function answerWithin(answer: Promise<ToolResult>, timeoutMs: number): Promise<ToolResult | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((done) => { timer = setTimeout(() => done(null), timeoutMs + 250); });
  try { return await Promise.race([answer, late]); }
  finally { clearTimeout(timer); }
}

/** Maps with at most `atOnce` running together, keeping the order. */
async function mapLimited<T, R>(items: readonly T[], atOnce: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]!);
    }
  }));
  return results;
}

// macOS mounts -------------------------------------------------------------

export interface MacMount {
  /** The device node (`/dev/disk4s2`) or the share (`//ana@nas/photos`). */
  device: string;
  mountPoint: string;
  fileSystem: string;
  options: string[];
}

/**
 * `/sbin/mount`'s lines, `<device> on <mount point> (<type>, <option>, …)`,
 * for the mounts directly inside one folder. Read as untrusted text. A device
 * or a name may hold spaces, " on ", and parentheses, so the options are the
 * last parenthesized group, and the mount point starts at the last
 * ` on <folder>/` and has no further slash (a volume's name cannot hold one).
 * Hidden names are skipped, a line that does not parse is skipped, and a mount
 * point mounted over again shows the newest mount.
 */
export function parseMacMounts(text: string, folder = "/Volumes"): MacMount[] {
  const parent = folder.replace(/\/+$/, "");
  const marker = ` on ${parent}/`;
  const newest = new Map<string, MacMount>();
  for (const line of text.split("\n")) {
    if (!line.endsWith(")") || line.length > 16_384 || line.includes("\0")) continue;
    const open = line.lastIndexOf(" (");
    if (open < 0) continue;
    const head = line.slice(0, open);
    const at = head.lastIndexOf(marker);
    if (at <= 0) continue;
    const name = head.slice(at + marker.length);
    if (!name || name.startsWith(".") || name.includes("/")) continue;
    const options = line.slice(open + 2, -1).split(",").map((option) => option.trim()).filter(Boolean);
    if (!options.length || !/^[\w.-]{1,64}$/.test(options[0]!)) continue;
    const mountPoint = `${parent}/${name}`;
    newest.set(mountPoint, { device: head.slice(0, at), mountPoint, fileSystem: options[0]!, options });
  }
  return [...newest.values()];
}

const mountTableTimeoutMs = 5_000;

/** The mount table as `mount` prints it from what the kernel already holds: it asks no file system, so no share can stall it. */
async function readMacMountTable(run: ToolRunner): Promise<string> {
  const result = await answerWithin(run({ command: "/sbin/mount", args: [] }, { timeoutMs: mountTableTimeoutMs, maxOutput: maxMountInfoBytes, readOnly: true }), mountTableTimeoutMs);
  if (!result || result.code !== 0) throw new Error("AmpleFile couldn’t read which drives are connected.");
  return result.stdout;
}

// Measuring ------------------------------------------------------------------

export interface VolumeSpace { totalBytes: number; freeBytes: number }

/** Space on the filesystem holding a path, without following a link at the path itself. */
export async function measureVolume(path: string): Promise<VolumeSpace | null> {
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

/**
 * `df -kP <mount>`'s answer: POSIX's one line for the file system, in 1024-byte
 * blocks. The share's name comes first and the mount point last, and either
 * may hold spaces, so the numbers are found by counting back from the end past
 * as many words as the mount point has.
 */
export function parseDfSpace(output: string, mountPath: string): VolumeSpace | null {
  const line = output.split("\n").map((text) => text.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  const words = line.split(/\s+/);
  const mountAt = words.length - mountPath.trim().split(/\s+/).length;
  if (mountAt < 5 || !words[mountAt]!.startsWith("/")) return null;
  const [blocks, , available, capacity] = words.slice(mountAt - 4, mountAt) as [string, string, string, string];
  if (!/^\d+$/.test(blocks) || !/^-?\d+$/.test(available) || !/^(\d+%|-)$/.test(capacity)) return null;
  const total = Number(blocks) * 1024;
  const free = Math.max(0, Number(available)) * 1024;
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
  return { totalBytes: total, freeBytes: Math.min(free, total) };
}

/** A share's space, asked by `df` in a process of its own. */
async function measureWithDf(mountPath: string, run: ToolRunner, timeoutMs: number, platform: NodeJS.Platform): Promise<VolumeSpace | null> {
  const result = await run({ command: platform === "darwin" ? "/bin/df" : "df", args: ["-kP", mountPath] }, { timeoutMs, readOnly: true });
  return result.code === 0 ? parseDfSpace(result.stdout, mountPath) : null;
}

/** A drive that has not answered in this long is listed without its space. */
const measureTimeoutMs = 1_500;
/** libuv gives the whole process four file threads; the list never has more than this many file calls to drives out at once. */
const maxFileCallsOut = 2;
/** How many shares are asked at once. */
const sharesMeasuredAtOnce = 8;

interface MountCall {
  answer: Promise<VolumeSpace | null>;
  deadline: number;
  stalled: boolean;
}

const overdue = Symbol("overdue");

/**
 * Keeps calls to drives from piling up on one that has stopped answering. A
 * file call on a share whose server has gone, or on a failing disk, can wait
 * for ever, and nothing takes it back: in this process it holds one of libuv's
 * four file threads until it returns, and every file route shares those four.
 *
 * So each mount has one call at a time. Listings that overlap share it. One
 * that outlives the time limit leaves the drive's space unknown, and no other
 * call is started on that mount until that one has returned: however often the
 * list is read, a stalled drive holds one call. A file call (`"file"`) is not
 * started while `maxFileCallsOut` of them are out, so the list never takes
 * more than that many of the four threads; the drive it was for shows unknown
 * space until there is room. A tool (`"tool"`) holds a process of its own
 * instead, which is killed at the limit; the mount stays closed until that
 * process has really gone.
 */
export class MountCalls {
  readonly limitMs: number;
  readonly #maxFileCallsOut: number;
  readonly #calls = new Map<string, MountCall>();
  #fileCallsOut = 0;

  constructor(limits: { limitMs?: number; maxFileCallsOut?: number } = {}) {
    this.limitMs = limits.limitMs ?? measureTimeoutMs;
    this.#maxFileCallsOut = limits.maxFileCallsOut ?? maxFileCallsOut;
  }

  /** The space `start` reports for a mount, or null when the mount has not answered within the limit or may not be asked now. */
  async measure(mountPath: string, kind: "file" | "tool", start: () => Promise<VolumeSpace | null>): Promise<VolumeSpace | null> {
    let call = this.#calls.get(mountPath);
    if (!call) {
      if (kind === "file" && this.#fileCallsOut >= this.#maxFileCallsOut) return null;
      const begun: MountCall = { answer: Promise.resolve().then(start).catch(() => null), deadline: Date.now() + this.limitMs, stalled: false };
      if (kind === "file") this.#fileCallsOut += 1;
      void begun.answer.then(() => {
        if (this.#calls.get(mountPath) === begun) this.#calls.delete(mountPath);
        if (kind === "file") this.#fileCallsOut -= 1;
      });
      this.#calls.set(mountPath, begun);
      call = begun;
    }
    const left = call.deadline - Date.now();
    if (!call.stalled && left > 0) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<typeof overdue>((done) => { timer = setTimeout(() => done(overdue), left); });
      try {
        const answer = await Promise.race([call.answer, late]);
        if (answer !== overdue) return answer;
      } finally { clearTimeout(timer); }
    }
    // Still out: the mount stays closed until this call returns, and nobody waits for it again.
    call.stalled = true;
    return null;
  }
}

const mountCalls = new MountCalls();

/**
 * Whether a mount is a disk's volume (a device node) rather than a share or a
 * FUSE mount. A disk's volume is measured in this process; anything else is
 * asked from a process of its own.
 */
function isDiskDevice(device: string): boolean {
  return device.startsWith("/dev/") && device !== "/dev/fuse";
}

const idKey = randomBytes(32);

function volumeId(mountPath: string, device: string): string {
  return `volume-${createHmac("sha256", idKey).update(`${mountPath}\0${device}`).digest("hex").slice(0, 20)}`;
}

/** What one listing knows about a volume beyond what the window sees: how to eject it. */
export interface VolumeRecord extends VolumeSummary {
  /** The device (`/dev/sdb1`, `/dev/disk4s2`) or share (`//nas/photos`) behind the mount; never sent to the window. */
  device: string;
}

type FoundVolume = Omit<VolumeRecord, "totalBytes" | "freeBytes">;

export interface VolumeListOptions {
  platform?: NodeJS.Platform;
  home?: string;
  user?: string;
  /** Linux: the mount table's text (tests pass a sample). */
  mountInfo?: string;
  labels?: ReadonlyMap<string, string>;
  removable?: ReadonlySet<string>;
  /** macOS: the folder holding mounted volumes. */
  volumesFolder?: string;
  /** macOS: `/sbin/mount`'s output (tests pass a sample). */
  mountTable?: string;
  /** Replaces measuring altogether (tests that only check which drives are listed). */
  measure?: (path: string) => Promise<VolumeSpace | null>;
  /** The file call that measures a disk's volume in this process (tests pass one that never returns). */
  statfs?: (path: string) => Promise<VolumeSpace | null>;
  /** Runs `mount` and `df` (tests answer for them). */
  run?: ToolRunner;
  /** The bound on calls to drives (tests bring their own, with a short limit). */
  mountCalls?: MountCalls;
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
  const found = platform === "linux" ? await findLinuxVolumes(options) : platform === "darwin" ? await findMacVolumes(options) : [];
  const spaces = await measureVolumes(found, options, platform);
  return found.map((volume) => {
    const space = spaces.get(volume.mountPath);
    return { ...volume, totalBytes: space?.totalBytes ?? null, freeBytes: space?.freeBytes ?? null };
  });
}

/** The drives as the window sees them. */
export async function listVolumes(options: VolumeListOptions = {}): Promise<VolumeSummary[]> {
  return (await listVolumeRecords(options)).map(({ device: _device, ...volume }) => volume);
}

/**
 * Each drive's space. A disk's volume is measured in this process, one after
 * another, so a healthy list has one file call out at a time. A share is asked
 * by `df`, several at once, each in a process of its own. Both go through
 * `MountCalls`.
 */
async function measureVolumes(volumes: readonly FoundVolume[], options: VolumeListOptions, platform: NodeJS.Platform): Promise<Map<string, VolumeSpace | null>> {
  const spaces = new Map<string, VolumeSpace | null>();
  const measure = options.measure;
  if (measure) {
    await Promise.all(volumes.map(async (volume) => { spaces.set(volume.mountPath, await measure(volume.mountPath)); }));
    return spaces;
  }
  const calls = options.mountCalls ?? mountCalls;
  const fileCall = options.statfs ?? measureVolume;
  const run = options.run ?? runTool;
  await Promise.all([
    (async () => {
      for (const volume of volumes) {
        if (isDiskDevice(volume.device)) spaces.set(volume.mountPath, await calls.measure(volume.mountPath, "file", () => fileCall(volume.mountPath)));
      }
    })(),
    mapLimited(volumes.filter((volume) => !isDiskDevice(volume.device)), sharesMeasuredAtOnce, async (volume) => {
      spaces.set(volume.mountPath, await calls.measure(volume.mountPath, "tool", () => measureWithDf(volume.mountPath, run, calls.limitMs, platform)));
    }),
  ]);
  return spaces;
}

async function findLinuxVolumes(options: VolumeListOptions): Promise<FoundVolume[]> {
  const text = options.mountInfo ?? await readMountInfo();
  const mounts = parseMountInfo(text);
  const visible = linuxUserVolumes(mounts, {
    home: options.home ?? homedir(),
    user: options.user ?? safeUserName(),
    labels: options.labels ?? (options.mountInfo === undefined ? await linuxDeviceLabels() : new Map()),
    removable: options.removable ?? (options.mountInfo === undefined ? await linuxRemovableDevices(mounts) : new Set()),
  });
  return visible.map(({ mount, name, ejectable }) => ({
    id: volumeId(mount.mountPoint, `${mount.majorMinor}:${mount.source}`),
    name,
    mountPath: mount.mountPoint,
    ejectable,
    fileSystem: mount.fileSystem,
    device: mount.source,
  }));
}

async function readMountInfo(): Promise<string> {
  const text = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  return text.length > maxMountInfoBytes ? text.slice(0, maxMountInfoBytes) : text;
}

function safeUserName(): string {
  try { return userInfo().username; } catch { return basename(homedir()); }
}

/**
 * The mounts directly inside `/Volumes`, from the system's mount table. The
 * startup disk is not one: its entry in `/Volumes` is a link, and it is mounted
 * at `/`. Nothing here touches a drive.
 */
async function findMacVolumes(options: VolumeListOptions): Promise<FoundVolume[]> {
  const table = options.mountTable ?? await readMacMountTable(options.run ?? runTool);
  return parseMacMounts(table, options.volumesFolder ?? "/Volumes")
    .slice(0, maxListedVolumes)
    .map((mount) => ({
      id: volumeId(mount.mountPoint, mount.device),
      name: basename(mount.mountPoint),
      mountPath: mount.mountPoint,
      // Every mounted volume but the startup disk can be ejected with diskutil; it says when one cannot.
      ejectable: true,
      fileSystem: mount.fileSystem,
      device: mount.device,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
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

let ejectRunnerForTests: EjectRunner | null = null;

/** Tests record the tools an eject would run, `diskutil info` among them; null restores spawning them. */
export function setEjectRunnerForTests(runner: EjectRunner | null): void {
  ejectRunnerForTests = runner;
}

export type PropertyListValue = string | number | boolean | PropertyListValue[] | Map<string, PropertyListValue>;

const maxPropertyListLength = 1024 * 1024;
const maxPropertyListDepth = 32;

function decodeXmlText(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (whole, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    const code = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Reads the XML property list a system tool prints (`diskutil info -plist`).
 * Untrusted text: bounded in length and depth, and null when it does not read
 * as a property list to the end. A dictionary is a Map, so no key can be taken
 * for a property of the object. Dates and data stay text.
 */
export function parsePropertyList(text: string): PropertyListValue | null {
  if (text.length > maxPropertyListLength) return null;
  const tag = /<(\/?)(plist|dict|array|key|string|integer|real|date|data|true|false)(?:\s[^<>]*)?(\/?)>/g;
  tag.lastIndex = Math.max(0, text.indexOf("<plist"));
  const top = tag.exec(text);
  if (!top || top[1] || top[2] !== "plist") return null;
  const textUntilClose = (name: string): string | null => {
    const end = text.indexOf(`</${name}>`, tag.lastIndex);
    if (end < 0) return null;
    const raw = text.slice(tag.lastIndex, end);
    tag.lastIndex = end + name.length + 3;
    return raw.includes("<") ? null : decodeXmlText(raw);
  };
  const read = (open: RegExpExecArray | null, depth: number): PropertyListValue | undefined => {
    if (!open || open[1] || depth > maxPropertyListDepth) return undefined;
    const name = open[2]!;
    const empty = open[3] === "/";
    if (name === "true" || name === "false") return name === "true";
    if (name === "dict") {
      const dict = new Map<string, PropertyListValue>();
      while (!empty) {
        const next = tag.exec(text);
        if (next?.[1] && next[2] === "dict") break;
        if (!next || next[1] || next[2] !== "key" || next[3]) return undefined;
        const key = textUntilClose("key");
        const value = key === null ? undefined : read(tag.exec(text), depth + 1);
        if (key === null || value === undefined) return undefined;
        dict.set(key, value);
      }
      return dict;
    }
    if (name === "array") {
      const items: PropertyListValue[] = [];
      while (!empty) {
        const next = tag.exec(text);
        if (next?.[1] && next[2] === "array") break;
        const value = read(next, depth + 1);
        if (value === undefined) return undefined;
        items.push(value);
      }
      return items;
    }
    if (name === "key" || name === "plist") return undefined;
    const content = empty ? "" : textUntilClose(name);
    if (content === null) return undefined;
    if (name !== "integer" && name !== "real") return content;
    const number = Number(content.trim());
    return content.trim() && Number.isFinite(number) ? number : undefined;
  };
  return read(tag.exec(text), 0) ?? null;
}

/** The whole disk a partition is on: `disk4` for `disk4s2`, and for `disk4` itself. */
function wholeDiskOf(identifier: unknown): string | null {
  const match = typeof identifier === "string" ? /^(disk\d{1,6})(?:s\d{1,6})*$/.exec(identifier) : null;
  return match ? match[1]! : null;
}

/**
 * The physical disks under a volume, from `diskutil info -plist <mount>`. An
 * APFS volume's own whole disk is its container, a disk the system makes up;
 * what leaves when it is ejected is the disk each of the container's physical
 * stores is a partition of (two for a Fusion Drive). Any other volume's is the
 * whole disk its partition is on. Null when the answer is diskutil's error or
 * does not say.
 */
export function physicalDisksFromDiskutilInfo(text: string): string[] | null {
  const info = parsePropertyList(text);
  if (!(info instanceof Map) || info.get("Error") === true) return null;
  const disks = new Set<string>();
  const stores = info.get("APFSPhysicalStores");
  for (const store of Array.isArray(stores) ? stores : []) {
    const disk = wholeDiskOf(store instanceof Map ? store.get("APFSPhysicalStore") : null);
    if (!disk) return null;
    disks.add(disk);
  }
  if (!disks.size) {
    const disk = wholeDiskOf(info.get("ParentWholeDisk"));
    if (disk) disks.add(disk);
  }
  return disks.size ? [...disks].sort() : null;
}

const diskInfoTimeoutMs = 10_000;
const disksAskedAtOnce = 4;

async function macVolumeDisks(volume: VolumeRecord): Promise<string[] | null> {
  const run = ejectRunnerForTests ?? runTool;
  const result = await answerWithin(run({ command: "diskutil", args: ["info", "-plist", volume.mountPath] }, { timeoutMs: diskInfoTimeoutMs, maxOutput: maxPropertyListLength, readOnly: true }), diskInfoTimeoutMs);
  return result && !result.missing && result.code === 0 ? physicalDisksFromDiskutilInfo(result.stdout) : null;
}

/** The physical disks under a volume; null when they cannot be told. */
export type VolumeDiskSource = (volume: VolumeRecord) => Promise<readonly string[] | null>;
let volumeDiskSourceForTests: VolumeDiskSource | null = null;

/** Tests say which disk each drive is on; null restores asking the system. */
export function setVolumeDiskSourceForTests(source: VolumeDiskSource | null): void {
  volumeDiskSourceForTests = source;
}

export interface EjectCompanion {
  volume: VolumeRecord;
  /** False when the system could not say which disk this drive or the ejected one is on. */
  certain: boolean;
}

/**
 * The other listed drives that leave with one when it is ejected. On macOS
 * `diskutil eject` takes a volume's whole physical disk: every volume of its
 * APFS container, and every other partition of the disk that container is
 * stored on. So each listed disk volume is asked which physical disks it is on
 * (`diskutil info -plist`), and one that shares a disk with the ejected volume
 * goes with it.
 *
 * When the system cannot say which disk one of two drives is on (diskutil
 * missing, failing, slow, or answering something unreadable), the other drive
 * is returned as uncertain, and the caller treats it as leaving too. Refusing
 * an eject that would have been fine costs a second try; taking a disk from
 * under running work cannot be taken back.
 *
 * A share is on no disk: it is unmounted alone and has no companions, and is
 * never one. When no other disk volume is listed, no tool is run.
 *
 * On Linux a drive is still checked alone. `gio mount -e` can take a drive's
 * other partitions too, but the mount table names a partition (for btrfs or an
 * unlocked LUKS volume, not even that) rather than its disk, and which
 * partitions leave depends on whether udisks can eject or power off the drive.
 */
export async function volumesEjectedWith(volume: VolumeRecord, listed: readonly VolumeRecord[], platform: NodeJS.Platform = process.platform): Promise<EjectCompanion[]> {
  const disksOf = volumeDiskSourceForTests ?? (platform === "darwin" ? macVolumeDisks : null);
  if (!disksOf || !isDiskDevice(volume.device)) return [];
  const others = listed.filter((other) => other.id !== volume.id && other.mountPath !== volume.mountPath && isDiskDevice(other.device));
  if (!others.length) return [];
  const [own, ...theirs] = await mapLimited([volume, ...others], disksAskedAtOnce, (asked) => disksOf(asked).catch(() => null));
  return others.flatMap((other, index): EjectCompanion[] => {
    const disks = theirs[index];
    if (!own || !disks) return [{ volume: other, certain: false }];
    return disks.some((disk) => own.includes(disk)) ? [{ volume: other, certain: true }] : [];
  });
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

/** “Photos”, “Photos” and “Music”, or the first three and how many more. */
function quotedNames(volumes: readonly Pick<VolumeSummary, "name">[]): string {
  const names = volumes.slice(0, 3).map((volume) => `“${volume.name}”`);
  if (volumes.length > 3) names.push(`${volumes.length - 3} more`);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * Ejects one volume with the system's tools. A busy drive gets a plain
 * message; when no tool exists, so does that. `alongside` names the drives
 * that leave with it (`volumesEjectedWith`), so a disk that would not go says
 * which drives it holds. The caller has checked that the listing marks the
 * volume ejectable and that no Connected Folder on it, or on a drive that
 * leaves with it, has unfinished work.
 */
export async function ejectVolume(volume: VolumeRecord, platform: NodeJS.Platform = process.platform, alongside: readonly Pick<VolumeSummary, "name">[] = []): Promise<void> {
  const run = ejectRunnerForTests ?? runTool;
  let missing = 0;
  let firstFailure = "";
  const commands = ejectCommands(volume, platform);
  const others = alongside.length ? quotedNames(alongside) : "";
  // Each tool in turn until one succeeds: an eject a drive cannot do falls back to an unmount.
  for (const command of commands) {
    const result = await run(command);
    if (result.missing) { missing += 1; continue; }
    if (result.code === 0) return;
    const output = `${result.stderr}\n${result.stdout}`;
    if (looksBusy(output)) {
      throw new VolumeEjectError(409, others
        ? `“${volume.name}” or another drive on its disk (${others}) is in use. Close the files and apps using them, then try again.`
        : `“${volume.name}” is in use. Close the files and apps using it, then try again.`);
    }
    // diskutil unmounts the volume itself first, so this is the rest of its disk refusing to go.
    if (others && /failed to eject/i.test(output)) {
      throw new VolumeEjectError(409, `The disk holding “${volume.name}” and ${others} couldn’t be ejected. Close the files and apps using those drives, then try again.`);
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
