import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DesktopUpdateStatus, DesktopUpdates } from "./updater.js";

/**
 * Updates for an RPM installed from AmpleFile's Fedora package repository
 * (docs/linux-build.md, "Package repository"). The system's package manager
 * checks, downloads and installs them with the rest of the computer's
 * software; AmpleFile makes no network call of its own. What AmpleFile does is
 * notice when its installed files were replaced while it runs (a `dnf
 * upgrade` with AmpleFile open), and then offer a restart through the same
 * status, sidebar indicator and confirmation as an app update. It never
 * restarts on its own: accepted work keeps running until the person chooses.
 */

const defaultPollIntervalMs = 60_000;

export const systemPackageUpdatesMessage = "AmpleFile updates arrive with your system's software updates.";

/** The installed files AmpleFile watches, and the repository entry that enrolled them. */
export interface SystemPackageInstallation {
  repositoryFile: string;
  /** The packaged application archive: a package upgrade always replaces it. */
  watchedFile: string;
}

/** Enough of a file's identity to tell that it was replaced, not just read. */
export interface InstalledFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/**
 * Whether a dnf repository file enables the repository `id`. dnf treats a
 * missing `enabled` as on; a person who sets `enabled=0` has opted out.
 */
export function repositoryEnabled(text: string, id: string): boolean {
  let section: string | null = null;
  let found = false;
  let enabled = true;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      if (section === id) found = true;
      continue;
    }
    if (section !== id) continue;
    const separator = line.indexOf("=");
    if (separator <= 0 || line.slice(0, separator).trim().toLowerCase() !== "enabled") continue;
    enabled = !["0", "no", "false", "off"].includes(line.slice(separator + 1).trim().toLowerCase());
  }
  return found && enabled;
}

/**
 * The repository-managed RPM install this process runs from, or null: an
 * AppImage, a DEB, an RPM built without enrolment, a development run, or a
 * person who disabled the repository keep the wording of a build without
 * updates.
 */
export function systemPackageInstallation(options: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  resourcesPath: string;
  /** `$APPIMAGE`, set by the AppImage runtime. */
  appImage: string | undefined;
  productName: string;
  repositoryId: string;
  readText: (path: string) => string | null;
}): SystemPackageInstallation | null {
  if (options.platform !== "linux" || !options.isPackaged || options.appImage) return null;
  if (dirname(options.execPath) !== `/opt/${options.productName}`) return null;
  const repositoryFile = `/etc/yum.repos.d/${options.repositoryId}.repo`;
  const entry = options.readText(repositoryFile);
  if (entry === null || !repositoryEnabled(entry, options.repositoryId)) return null;
  return { repositoryFile, watchedFile: join(options.resourcesPath, "app.asar") };
}

/** Reads `length` bytes at `position`; fewer only at the end of the file. */
export type ReadAt = (position: number, length: number) => Buffer;

/**
 * The `version` in an ASAR archive's root package.json, or null when the
 * archive cannot be read that way. The archive starts with two Chromium
 * pickles: the first holds the header pickle's size, the second the header
 * JSON, which lists each file's size and offset after the header.
 */
export function readAsarPackageVersion(readAt: ReadAt): string | null {
  try {
    const prefix = readAt(0, 16);
    if (prefix.length < 16 || prefix.readUInt32LE(0) !== 4) return null;
    const headerPickleSize = prefix.readUInt32LE(4);
    const headerLength = prefix.readUInt32LE(12);
    if (headerLength <= 0 || headerLength > 64 * 1024 * 1024 || headerLength + 8 > headerPickleSize) return null;
    const header = JSON.parse(readAt(16, headerLength).toString("utf8")) as { files?: Record<string, { size?: unknown; offset?: unknown; unpacked?: unknown }> };
    const entry = header.files?.["package.json"];
    const size = Number(entry?.size);
    const offset = Number(entry?.offset);
    if (!entry || entry.unpacked || !Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || size <= 0 || size > 1024 * 1024 || offset < 0) return null;
    const bytes = readAt(8 + headerPickleSize + offset, size);
    if (bytes.length !== size) return null;
    const version = (JSON.parse(bytes.toString("utf8")) as { version?: unknown }).version;
    return typeof version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

function sameIdentity(left: InstalledFileIdentity | null, right: InstalledFileIdentity | null): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export interface SystemPackageUpdatesHost {
  currentVersion(): string;
  /** The watched file's identity, or null when it cannot be read (mid-transaction, or removed). */
  identify(path: string): InstalledFileIdentity | null;
  /** The version the watched archive now holds, or null. */
  installedVersion(path: string): string | null;
  emitStatus(status: DesktopUpdateStatus): void;
}

export interface SystemPackageUpdatesOptions {
  installation: SystemPackageInstallation;
  host: SystemPackageUpdatesHost;
  /** Stops accepted work and the backend, the way an app update's restart does. */
  prepareToRestart: () => Promise<void>;
  /** Opens AmpleFile again and quits this process. Called after `prepareToRestart`, even if it failed. */
  relaunch: () => void;
  automaticChecks?: boolean;
  pollIntervalMs?: number;
}

/**
 * The desktop update surface for a repository-managed RPM install. It has no
 * update feed of its own (`supported` is false: no Check for Updates
 * command); its status turns supported, and the indicator appears, only when
 * the installed files changed under the running app.
 */
export class SystemPackageUpdates implements DesktopUpdates {
  readonly supported = false;
  private readonly installation: SystemPackageInstallation;
  private readonly host: SystemPackageUpdatesHost;
  private readonly prepareToRestart: () => Promise<void>;
  private readonly relaunch: () => void;
  private readonly automaticChecks: boolean;
  private readonly pollIntervalMs: number;
  /** The watched file as this process found it at startup. */
  private startupIdentity: InstalledFileIdentity | null = null;
  /** A changed identity seen once; the change counts when the next look finds it again. */
  private pendingIdentity: InstalledFileIdentity | null = null;
  private status: DesktopUpdateStatus;
  private timer: NodeJS.Timeout | null = null;
  private restartPromise: Promise<DesktopUpdateStatus> | null = null;
  private restarting = false;
  private started = false;
  private disposed = false;

  constructor(options: SystemPackageUpdatesOptions) {
    this.installation = options.installation;
    this.host = options.host;
    this.prepareToRestart = options.prepareToRestart;
    this.relaunch = options.relaunch;
    this.automaticChecks = options.automaticChecks !== false;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.status = this.waitingStatus();
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.startupIdentity = this.host.identify(this.installation.watchedFile);
    this.setStatus(this.waitingStatus());
    if (!this.automaticChecks) return;
    this.timer = setInterval(() => { this.look(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  getStatus(): DesktopUpdateStatus {
    return { ...this.status, currentVersion: this.host.currentVersion() };
  }

  /** Looks at the installed files again; never contacts the network. */
  check(): Promise<DesktopUpdateStatus> {
    this.look();
    return Promise.resolve(this.getStatus());
  }

  /** The update is already installed: the only thing left is the restart. */
  updateNow(): Promise<DesktopUpdateStatus> {
    return this.install();
  }

  install(): Promise<DesktopUpdateStatus> {
    if (this.disposed || this.status.phase !== "ready") return this.restartPromise ?? Promise.resolve(this.getStatus());
    if (this.restartPromise) return this.restartPromise;
    this.restarting = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus({ ...this.status, phase: "installing", message: "Restarting AmpleFile..." });
    this.restartPromise = (async () => {
      try {
        await this.prepareToRestart();
      } catch (error) {
        console.error(`AmpleFile could not shut down cleanly before restarting into the installed update: ${error instanceof Error ? error.message : String(error)}`);
      }
      // The backend is gone either way; only a restart leaves a working app.
      this.relaunch();
      return this.getStatus();
    })();
    return this.restartPromise;
  }

  /** True while a restart the person chose is underway: the ordinary quit path must not run twice. */
  async prepareForApplicationQuit(): Promise<boolean> {
    if (this.restartPromise) await this.restartPromise;
    return this.restarting;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private look(): void {
    if (!this.started || this.disposed || this.restarting) return;
    const now = this.host.identify(this.installation.watchedFile);
    // Unreadable (between an RPM transaction's steps, or the package was
    // removed) or unchanged: nothing to offer yet.
    if (!now || sameIdentity(now, this.startupIdentity)) {
      this.pendingIdentity = null;
      return;
    }
    if (!sameIdentity(now, this.pendingIdentity)) {
      // Seen once: wait one more look, so a transaction still writing files
      // is not offered as finished.
      this.pendingIdentity = now;
      return;
    }
    if (this.status.phase === "ready") return;
    const installed = this.host.installedVersion(this.installation.watchedFile);
    const current = this.host.currentVersion();
    this.setStatus({
      supported: true,
      phase: "ready",
      currentVersion: current,
      availableVersion: installed,
      progressPercent: null,
      checkedAt: null,
      message: installed && installed !== current
        ? `AmpleFile ${installed} was installed. Restart AmpleFile to use it.`
        : "AmpleFile was updated. Restart AmpleFile to use the update.",
      error: null,
      updatesFrom: "system",
    });
  }

  private waitingStatus(): DesktopUpdateStatus {
    return {
      supported: false,
      phase: "unsupported",
      currentVersion: this.host.currentVersion(),
      availableVersion: null,
      progressPercent: null,
      checkedAt: null,
      message: systemPackageUpdatesMessage,
      error: null,
      updatesFrom: "system",
    };
  }

  private setStatus(status: DesktopUpdateStatus): void {
    this.status = status;
    if (!this.disposed) this.host.emitStatus(this.getStatus());
  }
}

/** Reads the installed files directly, not through Electron's ASAR-aware fs. */
function originalFs(): Pick<typeof import("node:fs"), "closeSync" | "openSync" | "readFileSync" | "readSync" | "statSync"> {
  try {
    return createRequire(import.meta.url)("original-fs") as typeof import("node:fs");
  } catch {
    return { closeSync, openSync, readFileSync, readSync, statSync };
  }
}

export function identifyInstalledFile(path: string): InstalledFileIdentity | null {
  try {
    const info = originalFs().statSync(path);
    return info.isFile() ? { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

export function installedAsarVersion(path: string): string | null {
  const fs = originalFs();
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, "r");
    const descriptor = fd;
    return readAsarPackageVersion((position, length) => {
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(descriptor, buffer, 0, length, position);
      return buffer.subarray(0, read);
    });
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function readTextFile(path: string): string | null {
  try {
    return originalFs().readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The system package update source for this process, or null when it does
 * not run from a repository-managed RPM install. Its status reaches every
 * file manager window, as the app updater's does.
 */
export function createSystemPackageUpdates(options: {
  productName: string;
  repositoryId: string;
  getWindows: () => import("electron").BrowserWindow[];
  prepareToRestart: () => Promise<void>;
}): SystemPackageUpdates | null {
  const electron = createRequire(import.meta.url)("electron") as typeof import("electron");
  const installation = systemPackageInstallation({
    platform: process.platform,
    isPackaged: electron.app.isPackaged,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    appImage: process.env.APPIMAGE,
    productName: options.productName,
    repositoryId: options.repositoryId,
    readText: readTextFile,
  });
  if (!installation) return null;
  return new SystemPackageUpdates({
    installation,
    prepareToRestart: options.prepareToRestart,
    relaunch: () => {
      electron.app.relaunch();
      electron.app.quit();
    },
    host: {
      currentVersion: () => electron.app.getVersion(),
      identify: identifyInstalledFile,
      installedVersion: installedAsarVersion,
      emitStatus: (status) => {
        for (const window of options.getWindows()) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("amplefile:updates:status-changed", status);
        }
      },
    },
  });
}
