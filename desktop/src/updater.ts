import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { BrowserWindow, MessageBoxOptions } from "electron";

const require = createRequire(import.meta.url);

const defaultStartupDelayMs = 5_000;
const defaultUpdateIntervalMs = 4 * 60 * 60 * 1_000;
const defaultTransientRetryDelayMs = 60_000;
const defaultSquirrelStageTimeoutMs = 5 * 60 * 1_000;

export type DesktopUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface DesktopUpdateStatus {
  supported: boolean;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string;
  error: string | null;
}

/** Kept as an alias for callers from the initial public release. */
export type DesktopUpdateCheckResult = DesktopUpdateStatus;

export interface DesktopUpdateInfoLike {
  version: string;
}

export interface DesktopUpdateCheckResultLike {
  isUpdateAvailable: boolean;
  updateInfo: DesktopUpdateInfoLike;
  downloadPromise?: Promise<unknown> | null;
}

export interface DesktopUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  installerPath?: string | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<DesktopUpdateCheckResultLike | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface DesktopUpdateMessage {
  type: "info" | "error";
  title: string;
  message: string;
  detail?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  noLink?: boolean;
}

export interface DesktopUpdaterHost {
  isSupported(): boolean;
  platform(): NodeJS.Platform;
  currentVersion(): string;
  now(): string;
  installerExists(path: string): boolean;
  showMessage(options: DesktopUpdateMessage): Promise<{ response: number }>;
  setProgress(value: number): void;
  emitStatus(status: DesktopUpdateStatus): void;
  /**
   * Hand the downloaded update to the platform installer and wait until it
   * has fetched and validated it, while the app is still fully running.
   * Squirrel.Mac otherwise only fetches inside `quitAndInstall()`, after the
   * app has already shut its backend down. Absent means nothing to stage.
   */
  stageDownloadedUpdate?(): Promise<void>;
}

export interface DesktopUpdateInstallFailure {
  message: string;
  /** True when the person chose to restart into the update; false at quit. */
  relaunch: boolean;
}

export interface DesktopUpdaterOptions {
  getWindow?: () => BrowserWindow | null;
  prepareToInstall: () => Promise<void>;
  /**
   * Called when an install fails after `prepareToInstall` has shut the
   * backend down. The window can no longer work, so the host must relaunch
   * or quit rather than show the update as ready again.
   */
  onInstallFailedAfterShutdown?: (failure: DesktopUpdateInstallFailure) => void;
  updater?: DesktopUpdaterAdapter;
  host?: DesktopUpdaterHost;
  automaticChecks?: boolean;
  timings?: Partial<{
    startupDelayMs: number;
    updateIntervalMs: number;
    transientRetryDelayMs: number;
  }>;
}

export function hasPackagedDesktopUpdateFeed(options: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
  fileExists?: (path: string) => boolean;
}): boolean {
  if (!options.isPackaged || (options.platform !== "win32" && options.platform !== "darwin")) return false;
  return (options.fileExists ?? existsSync)(join(options.resourcesPath, "app-update.yml"));
}

export function hasDownloadedUpdatePayload(options: {
  platform: NodeJS.Platform;
  updateDownloadedEventReceived: boolean;
  installerPath: string | null;
  installerExists: boolean;
}): boolean {
  if (!options.updateDownloadedEventReceived) return false;
  // Squirrel.Mac owns the downloaded ZIP and does not expose installerPath.
  if (options.platform === "darwin") return true;
  return Boolean(options.installerPath && options.installerExists);
}

/**
 * Mature installed-update lifecycle. The feed always comes from the packaged
 * app-update.yml; this class never overrides GitHub, signing, or publisher data.
 */
export class DesktopUpdater {
  private readonly updater: DesktopUpdaterAdapter;
  private readonly host: DesktopUpdaterHost;
  private readonly prepareToInstall: () => Promise<void>;
  private readonly onInstallFailedAfterShutdown: (failure: DesktopUpdateInstallFailure) => void;
  private readonly automaticChecks: boolean;
  private readonly startupDelayMs: number;
  private readonly updateIntervalMs: number;
  private readonly transientRetryDelayMs: number;
  private status: DesktopUpdateStatus;
  private configured = false;
  private disposed = false;
  private backgroundCheckInFlight = false;
  private installAfterDownload = false;
  private installOnQuit = false;
  private downloadedUpdateReady = false;
  /** The platform installer has fetched and validated the downloaded update. */
  private downloadedUpdateStaged = false;
  /** Where an in-flight install is; errors mean different things in each stage. */
  private installStage: "idle" | "staging" | "shutting_down" | "handed_off" | "failed_after_shutdown" = "idle";
  private installRelaunches = false;
  private checkPromise: Promise<DesktopUpdateStatus> | null = null;
  private installPromise: Promise<DesktopUpdateStatus> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private promptingForRestart = false;

  constructor(options: DesktopUpdaterOptions) {
    this.updater = options.updater ?? defaultUpdaterAdapter();
    this.host = options.host ?? defaultElectronHost(options.getWindow ?? (() => null));
    this.prepareToInstall = options.prepareToInstall;
    this.onInstallFailedAfterShutdown = options.onInstallFailedAfterShutdown ?? (() => undefined);
    this.automaticChecks = options.automaticChecks !== false;
    this.startupDelayMs = options.timings?.startupDelayMs ?? defaultStartupDelayMs;
    this.updateIntervalMs = options.timings?.updateIntervalMs ?? defaultUpdateIntervalMs;
    this.transientRetryDelayMs = options.timings?.transientRetryDelayMs ?? defaultTransientRetryDelayMs;
    this.status = {
      supported: this.supported,
      phase: this.supported ? "idle" : "unsupported",
      currentVersion: this.host.currentVersion(),
      availableVersion: null,
      progressPercent: null,
      checkedAt: null,
      message: this.supported
        ? "Ready to check for updates."
        : "Updates are not available in this build.",
      error: null,
    };
  }

  get supported(): boolean {
    return this.host.isSupported();
  }

  start(): void {
    if (this.disposed || this.configured) return;
    this.configured = true;
    if (!this.supported) {
      this.setStatus({ phase: "unsupported", message: "Updates are not available in this build." });
      return;
    }

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowDowngrade = false;
    this.updater.allowPrerelease = false;
    this.updater.on("checking-for-update", this.onCheckingForUpdate);
    this.updater.on("update-available", this.onUpdateAvailable);
    this.updater.on("update-not-available", this.onUpdateNotAvailable);
    this.updater.on("download-progress", this.onDownloadProgress);
    this.updater.on("update-downloaded", this.onUpdateDownloaded);
    this.updater.on("update-cancelled", this.onUpdateCancelled);
    this.updater.on("error", this.onError);
    this.setStatus({ phase: "idle", message: "Ready to check for updates.", error: null });

    if (!this.automaticChecks) return;
    this.scheduleBackgroundCheck(this.startupDelayMs);
    this.intervalTimer = setInterval(() => { void this.check(false); }, this.updateIntervalMs);
    this.intervalTimer.unref();
  }

  getStatus(): DesktopUpdateStatus {
    return {
      ...this.status,
      supported: this.supported,
      currentVersion: this.host.currentVersion(),
    };
  }

  /** `interactive=false` is a silent background check with transient retry. */
  check(interactive = true): Promise<DesktopUpdateStatus> {
    if (!this.supported || this.disposed) return Promise.resolve(this.getStatus());
    const current = this.getStatus();
    // A wake or periodic check must not flip the status (or the downloaded
    // payload state) while a download or install is in flight.
    if (current.phase === "ready" || current.phase === "installing" || current.phase === "downloading") return Promise.resolve(current);
    if (this.installPromise) return Promise.resolve(current);
    if (!interactive && current.phase === "available") return Promise.resolve(current);
    if (this.checkPromise) return this.checkPromise;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.checkPromise = this.runCheck(!interactive).finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async updateNow(): Promise<DesktopUpdateStatus> {
    if (!this.supported || this.disposed) return this.getStatus();
    const current = this.getStatus();
    if (current.phase === "installing" || current.phase === "checking" || current.phase === "downloading") return current;
    if (current.phase === "ready") return this.install();

    const checked = current.phase === "available" ? current : await this.check(true);
    if (checked.phase !== "available") return checked;

    this.installAfterDownload = true;
    try {
      this.setStatus({ phase: "downloading", progressPercent: 0, message: "Downloading update...", error: null });
      await this.updater.downloadUpdate();
      return this.getStatus();
    } catch (error) {
      this.installAfterDownload = false;
      this.downloadedUpdateReady = false;
      return this.setStatus({
        phase: "error",
        progressPercent: null,
        message: "Update download failed.",
        error: errorMessage(error),
      });
    }
  }

  install(): Promise<DesktopUpdateStatus> {
    return this.beginInstall({ forceRunAfter: true });
  }

  shouldInstallOnQuit(): boolean {
    return this.supported && this.installOnQuit && this.status.phase === "ready";
  }

  installDownloadedUpdateOnQuit(): Promise<DesktopUpdateStatus> {
    if (!this.shouldInstallOnQuit()) return Promise.resolve(this.getStatus());
    return this.beginInstall({ forceRunAfter: false });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.retryTimer = null;
    this.intervalTimer = null;
    this.updater.off("checking-for-update", this.onCheckingForUpdate);
    this.updater.off("update-available", this.onUpdateAvailable);
    this.updater.off("update-not-available", this.onUpdateNotAvailable);
    this.updater.off("download-progress", this.onDownloadProgress);
    this.updater.off("update-downloaded", this.onUpdateDownloaded);
    this.updater.off("update-cancelled", this.onUpdateCancelled);
    this.updater.off("error", this.onError);
    this.host.setProgress(-1);
  }

  private async runCheck(background: boolean): Promise<DesktopUpdateStatus> {
    this.backgroundCheckInFlight = background;
    try {
      this.setStatus({ phase: "checking", progressPercent: null, message: "Checking for updates...", error: null });
      const result = await this.updater.checkForUpdates();
      if (!result) {
        return this.setStatus({
          phase: "not_available",
          progressPercent: null,
          checkedAt: this.host.now(),
          message: "No update feed is configured.",
          error: null,
        });
      }
      if (result.isUpdateAvailable) {
        return this.setStatus({
          phase: "available",
          availableVersion: result.updateInfo.version,
          progressPercent: null,
          checkedAt: this.host.now(),
          message: `AmpleFile ${result.updateInfo.version} is available.`,
          error: null,
        });
      }
      return this.setStatus({
        phase: "not_available",
        availableVersion: null,
        progressPercent: null,
        checkedAt: this.host.now(),
        message: `AmpleFile ${this.host.currentVersion()} is up to date.`,
        error: null,
      });
    } catch (error) {
      const message = errorMessage(error);
      if (background && isTransientNetworkUpdateError(message)) return this.deferTransientCheck(message);
      return this.setStatus({ phase: "error", progressPercent: null, message: "Update check failed.", error: message });
    } finally {
      this.backgroundCheckInFlight = false;
    }
  }

  /**
   * Order matters: stage and validate while everything still runs, then shut
   * down, then hand off. A failure before shutdown leaves a working app; a
   * failure after it can only relaunch or quit, never report "ready".
   */
  private beginInstall(options: { forceRunAfter: boolean }): Promise<DesktopUpdateStatus> {
    if (!this.supported || this.disposed || this.status.phase !== "ready") return Promise.resolve(this.getStatus());
    if (this.installPromise) return this.installPromise;

    const installerPath = this.downloadedInstallerPath();
    if (!hasDownloadedUpdatePayload({
      platform: this.host.platform(),
      updateDownloadedEventReceived: this.downloadedUpdateReady,
      installerPath,
      installerExists: Boolean(installerPath && this.host.installerExists(installerPath)),
    })) {
      this.installOnQuit = false;
      this.downloadedUpdateReady = false;
      return Promise.resolve(this.setStatus({
        phase: "error",
        progressPercent: null,
        message: "Downloaded update payload is missing.",
        error: this.host.platform() === "darwin"
          ? "Squirrel.Mac has no downloaded update ready to install."
          : installerPath ? `Installer not found at ${installerPath}.` : "No downloaded update installer path was available.",
      }));
    }

    this.installOnQuit = false;
    this.installRelaunches = options.forceRunAfter;
    this.setStatus({
      phase: "installing",
      progressPercent: 100,
      message: options.forceRunAfter ? "Restarting to install update..." : "Installing update...",
      error: null,
    });
    this.installPromise = (async () => {
      if (!this.downloadedUpdateStaged && this.host.stageDownloadedUpdate) {
        this.installStage = "staging";
        try {
          await this.host.stageDownloadedUpdate();
          this.downloadedUpdateStaged = true;
        } catch (error) {
          return this.failBeforeShutdown(errorMessage(error));
        }
      }
      this.installStage = "shutting_down";
      try {
        await this.prepareToInstall();
        if (this.installStage !== "shutting_down") return this.getStatus();
        this.installStage = "handed_off";
        this.updater.quitAndInstall(true, options.forceRunAfter);
      } catch (error) {
        this.failAfterShutdown(errorMessage(error));
      }
      return this.getStatus();
    })();
    return this.installPromise;
  }

  /** The platform installer rejected the payload; the app is untouched. */
  private failBeforeShutdown(message: string): DesktopUpdateStatus {
    this.installPromise = null;
    this.installStage = "idle";
    this.installOnQuit = false;
    this.downloadedUpdateReady = false;
    this.downloadedUpdateStaged = false;
    return this.setStatus({
      phase: "error",
      progressPercent: null,
      message: "The downloaded update could not be prepared for installation.",
      error: message,
    });
  }

  /** The backend is already shut down: report the failure and let the host relaunch or quit. */
  private failAfterShutdown(message: string): DesktopUpdateStatus {
    if (this.installStage === "failed_after_shutdown") return this.getStatus();
    this.installStage = "failed_after_shutdown";
    this.installOnQuit = false;
    const status = this.setStatus({
      phase: "error",
      progressPercent: null,
      message: this.installRelaunches
        ? "The update could not be installed. AmpleFile is restarting."
        : "The update could not be installed.",
      error: message,
    });
    this.onInstallFailedAfterShutdown({ message, relaunch: this.installRelaunches });
    return status;
  }

  private downloadedInstallerPath(): string | null {
    return typeof this.updater.installerPath === "string" && this.updater.installerPath.trim()
      ? this.updater.installerPath
      : null;
  }

  private scheduleBackgroundCheck(delayMs: number): void {
    if (!this.supported || this.disposed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.check(false);
    }, delayMs);
    this.retryTimer.unref();
  }

  private deferTransientCheck(message: string): DesktopUpdateStatus {
    console.warn(`AmpleFile update check deferred until the network recovers: ${message}`);
    this.scheduleBackgroundCheck(this.transientRetryDelayMs);
    return this.setStatus({
      phase: "idle",
      progressPercent: null,
      message: "Update check is waiting for the network to come back.",
      error: null,
    });
  }

  private readonly onCheckingForUpdate = (): void => {
    this.setStatus({ phase: "checking", progressPercent: null, message: "Checking for updates...", error: null });
  };

  private readonly onUpdateAvailable = (info: DesktopUpdateInfoLike): void => {
    this.installOnQuit = false;
    this.downloadedUpdateReady = false;
    this.downloadedUpdateStaged = false;
    this.setStatus({
      phase: "available",
      availableVersion: info.version,
      progressPercent: null,
      checkedAt: this.host.now(),
      message: `AmpleFile ${info.version} is available.`,
      error: null,
    });
  };

  private readonly onUpdateNotAvailable = (info: DesktopUpdateInfoLike): void => {
    this.installOnQuit = false;
    this.downloadedUpdateReady = false;
    this.downloadedUpdateStaged = false;
    this.setStatus({
      phase: "not_available",
      availableVersion: null,
      progressPercent: null,
      checkedAt: this.host.now(),
      message: `AmpleFile ${info.version || this.host.currentVersion()} is up to date.`,
      error: null,
    });
  };

  private readonly onDownloadProgress = (info: { percent: number }): void => {
    this.setStatus({
      phase: "downloading",
      progressPercent: Number.isFinite(info.percent) ? Math.max(0, Math.min(100, info.percent)) : null,
      message: "Downloading update...",
      error: null,
    });
  };

  private readonly onUpdateDownloaded = (info: DesktopUpdateInfoLike): void => {
    this.installOnQuit = true;
    this.downloadedUpdateReady = true;
    this.downloadedUpdateStaged = false;
    this.setStatus({
      phase: "ready",
      availableVersion: info.version,
      progressPercent: 100,
      message: `AmpleFile ${info.version} is ready to install.`,
      error: null,
    });
    if (this.installAfterDownload) {
      this.installAfterDownload = false;
      void this.install();
      return;
    }
    if (!this.disposed) void this.promptToRestart(info.version);
  };

  private readonly onUpdateCancelled = (): void => {
    this.installAfterDownload = false;
    this.installOnQuit = false;
    this.downloadedUpdateReady = false;
    this.downloadedUpdateStaged = false;
    this.setStatus({ phase: "idle", progressPercent: null, message: "The update download was cancelled.", error: null });
  };

  private readonly onError = (error: Error): void => {
    const message = errorMessage(error);
    console.warn(`AmpleFile updater error: ${message}`);
    if (this.installPromise) {
      // While staging, the staging promise rejects with this same error and
      // reports it; nothing has shut down yet.
      if (this.installStage === "staging") return;
      if (this.installStage === "shutting_down" || this.installStage === "handed_off") this.failAfterShutdown(message);
      return;
    }
    if ((this.backgroundCheckInFlight || this.isDeferredNetworkStatus()) && isTransientNetworkUpdateError(message)) {
      this.deferTransientCheck(message);
      return;
    }
    if (this.status.phase === "downloading") {
      this.downloadedUpdateReady = false;
      this.downloadedUpdateStaged = false;
    }
    this.setStatus({ phase: "error", progressPercent: null, message: "Update check failed.", error: message });
  };

  private isDeferredNetworkStatus(): boolean {
    return this.status.phase === "idle" && this.status.message === "Update check is waiting for the network to come back.";
  }

  private async promptToRestart(version: string): Promise<void> {
    if (this.promptingForRestart || this.disposed) return;
    this.promptingForRestart = true;
    try {
      const result = await this.host.showMessage({
        type: "info",
        title: "AmpleFile Update Ready",
        message: `AmpleFile ${version} is ready to install.`,
        detail: "Restart AmpleFile to finish updating. If you choose Later, the update will install when you quit the app.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        await this.install();
        return;
      }
      this.installOnQuit = true;
      this.setStatus({
        phase: "ready",
        availableVersion: version,
        progressPercent: 100,
        message: `AmpleFile ${version} will install when you quit.`,
        error: null,
      });
    } finally {
      this.promptingForRestart = false;
    }
  }

  private setStatus(patch: Partial<DesktopUpdateStatus>): DesktopUpdateStatus {
    this.status = {
      ...this.status,
      ...patch,
      supported: this.supported,
      currentVersion: this.host.currentVersion(),
    };
    const status = this.getStatus();
    this.host.emitStatus(status);
    this.host.setProgress(status.phase === "downloading" && status.progressPercent !== null ? status.progressPercent / 100 : -1);
    return status;
  }
}

export function isTransientNetworkUpdateError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "err_name_not_resolved",
    "err_internet_disconnected",
    "err_network_changed",
    "err_connection_reset",
    "err_connection_timed_out",
    "err_timed_out",
    "enotfound",
    "eai_again",
    "etimedout",
    "econnreset",
    "socket hang up",
    "network socket disconnected",
    "fetch failed",
    "name not resolved",
    "temporary failure in name resolution",
  ].some((needle) => normalized.includes(needle));
}

function defaultUpdaterAdapter(): DesktopUpdaterAdapter {
  const updaterModule = require("electron-updater") as { autoUpdater: DesktopUpdaterAdapter };
  return updaterModule.autoUpdater;
}

/** The slice of Electron's native `autoUpdater` (Squirrel.Mac) staging uses. */
export interface NativeSquirrelUpdaterLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): void;
}

/**
 * electron-updater's MacUpdater points Squirrel.Mac at a local proxy for the
 * downloaded ZIP when `update-downloaded` fires, but with
 * `autoInstallOnAppQuit = false` it only asks Squirrel to fetch it inside
 * `quitAndInstall()`. Asking here makes Squirrel fetch, unpack, and verify the
 * code signature now; MacUpdater observes the same native `update-downloaded`
 * and its later `quitAndInstall()` installs immediately.
 */
export function stageSquirrelMacUpdate(native: NativeSquirrelUpdaterLike, timeoutMs = defaultSquirrelStageTimeoutMs): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      native.removeListener("update-downloaded", onDownloaded);
      native.removeListener("update-not-available", onNotAvailable);
      native.removeListener("error", onError);
    };
    const onDownloaded = () => { cleanup(); resolve(); };
    const onNotAvailable = () => { cleanup(); reject(new Error("Squirrel.Mac found no downloaded update to install.")); };
    const onError = (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); };
    native.on("update-downloaded", onDownloaded);
    native.on("update-not-available", onNotAvailable);
    native.on("error", onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Squirrel.Mac did not finish preparing the update in time."));
    }, timeoutMs);
    timer.unref?.();
    try {
      native.checkForUpdates();
    } catch (error) {
      onError(error);
    }
  });
}

function defaultElectronHost(getWindow: () => BrowserWindow | null): DesktopUpdaterHost {
  const electron = require("electron") as typeof import("electron");
  return {
    stageDownloadedUpdate: () => process.platform === "darwin"
      ? stageSquirrelMacUpdate(electron.autoUpdater)
      : Promise.resolve(),
    isSupported: () => hasPackagedDesktopUpdateFeed({
      isPackaged: electron.app.isPackaged,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
    }),
    platform: () => process.platform,
    currentVersion: () => electron.app.getVersion(),
    now: () => new Date().toISOString(),
    installerExists: existsSync,
    showMessage: async (options) => {
      const window = getWindow();
      const result = window && !window.isDestroyed()
        ? await electron.dialog.showMessageBox(window, options as MessageBoxOptions)
        : await electron.dialog.showMessageBox(options as MessageBoxOptions);
      return { response: result.response };
    },
    setProgress: (value) => {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.setProgressBar(value);
    },
    emitStatus: (status) => {
      const window = getWindow();
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("amplefile:updates:status-changed", status);
      }
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
