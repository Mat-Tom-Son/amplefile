import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import test from "node:test";

import {
  hasPackagedDesktopUpdateFeed,
  hasDownloadedUpdatePayload,
  DesktopUpdater,
  stageSquirrelMacUpdate,
  type DesktopUpdateCheckResultLike,
  type DesktopUpdateInstallFailure,
  type DesktopUpdateMessage,
  type DesktopUpdateStatus,
  type DesktopUpdaterAdapter,
  type DesktopUpdaterHost,
} from "../desktop/src/updater.js";

test("installed Windows and macOS builds with an updater feed enable update controls", () => {
  const resourcesPath = "C:\\Program Files\\AmpleFile\\resources";
  const expectedFeed = join(resourcesPath, "app-update.yml");
  const fileExists = (path: string) => path === expectedFeed;

  assert.equal(hasPackagedDesktopUpdateFeed({ isPackaged: true, platform: "win32", resourcesPath, fileExists }), true);
  assert.equal(hasPackagedDesktopUpdateFeed({ isPackaged: true, platform: "darwin", resourcesPath, fileExists }), true);
  assert.equal(hasPackagedDesktopUpdateFeed({ isPackaged: true, platform: "win32", resourcesPath, fileExists: () => false }), false);
  assert.equal(hasPackagedDesktopUpdateFeed({ isPackaged: false, platform: "win32", resourcesPath, fileExists }), false);
  assert.equal(hasPackagedDesktopUpdateFeed({ isPackaged: true, platform: "linux", resourcesPath, fileExists }), false);
});

test("downloaded payload readiness follows each platform updater", () => {
  assert.equal(hasDownloadedUpdatePayload({ platform: "darwin", updateDownloadedEventReceived: false, installerPath: null, installerExists: false }), false);
  assert.equal(hasDownloadedUpdatePayload({ platform: "darwin", updateDownloadedEventReceived: true, installerPath: null, installerExists: false }), true);
  assert.equal(hasDownloadedUpdatePayload({ platform: "win32", updateDownloadedEventReceived: true, installerPath: null, installerExists: false }), false);
  assert.equal(hasDownloadedUpdatePayload({ platform: "win32", updateDownloadedEventReceived: true, installerPath: "C:\\updates\\AmpleFile.exe", installerExists: true }), true);
});

class FakeUpdater extends EventEmitter implements DesktopUpdaterAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowDowngrade = true;
  allowPrerelease = true;
  installerPath: string | null = "C:\\updates\\AmpleFile-Setup.exe";
  checkResult: DesktopUpdateCheckResultLike | null = {
    isUpdateAvailable: true,
    updateInfo: { version: "1.1.0" },
  };
  checkError: Error | null = null;
  downloadError: Error | null = null;
  quitError: Error | null = null;
  checkCalls = 0;
  quitCalls: Array<{ silent: boolean | undefined; forceRunAfter: boolean | undefined }> = [];

  async checkForUpdates(): Promise<DesktopUpdateCheckResultLike | null> {
    this.checkCalls += 1;
    if (this.checkError) throw this.checkError;
    return this.checkResult;
  }

  async downloadUpdate(): Promise<void> {
    if (this.downloadError) throw this.downloadError;
    this.emit("download-progress", { percent: 42 });
    this.emit("update-downloaded", { version: this.checkResult?.updateInfo.version ?? "1.1.0" });
  }

  quitAndInstall(silent?: boolean, forceRunAfter?: boolean): void {
    this.quitCalls.push({ silent, forceRunAfter });
    if (this.quitError) throw this.quitError;
  }
}

class FakeHost implements DesktopUpdaterHost {
  supported = true;
  platformValue: NodeJS.Platform = "win32";
  version = "1.0.0";
  nowValue = "2026-07-10T12:00:00.000Z";
  installerPresent = true;
  messageResponse = 1;
  messages: DesktopUpdateMessage[] = [];
  statuses: DesktopUpdateStatus[] = [];
  progress: number[] = [];
  events: string[] = [];
  stageError: Error | null = null;
  stageCalls = 0;

  isSupported(): boolean { return this.supported; }
  platform(): NodeJS.Platform { return this.platformValue; }
  currentVersion(): string { return this.version; }
  now(): string { return this.nowValue; }
  installerExists(): boolean { return this.installerPresent; }
  async showMessage(options: DesktopUpdateMessage): Promise<{ response: number }> {
    this.messages.push(options);
    return { response: this.messageResponse };
  }
  setProgress(value: number): void { this.progress.push(value); }
  emitStatus(status: DesktopUpdateStatus): void { this.statuses.push(status); }
  async stageDownloadedUpdate(): Promise<void> {
    this.stageCalls += 1;
    this.events.push("stage");
    if (this.stageError) throw this.stageError;
  }
}

function createHarness(options: { prepare?: () => Promise<void>; platform?: NodeJS.Platform } = {}) {
  const adapter = new FakeUpdater();
  const host = new FakeHost();
  host.platformValue = options.platform ?? "win32";
  let prepareCalls = 0;
  const failures: DesktopUpdateInstallFailure[] = [];
  const updater = new DesktopUpdater({
    updater: adapter,
    host,
    automaticChecks: false,
    timings: { transientRetryDelayMs: 60 * 60 * 1000 },
    prepareToInstall: options.prepare ?? (async () => { prepareCalls += 1; host.events.push("shutdown"); }),
    onInstallFailedAfterShutdown: (failure) => { failures.push(failure); },
  });
  updater.start();
  return { adapter, host, updater, prepareCalls: () => prepareCalls, failures };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("background transient update failures defer and retry without surfacing an error", async () => {
  const { adapter, updater } = createHarness();
  adapter.checkError = new Error("net::ERR_INTERNET_DISCONNECTED");

  const status = await updater.check(false);

  assert.equal(status.phase, "idle");
  assert.equal(status.error, null);
  assert.match(status.message, /waiting for the network/i);
  updater.dispose();
});

test("manual update failures remain visible instead of being silently deferred", async () => {
  const { adapter, updater } = createHarness();
  adapter.checkError = new Error("net::ERR_INTERNET_DISCONNECTED");

  const status = await updater.check(true);

  assert.equal(status.phase, "error");
  assert.match(status.error ?? "", /ERR_INTERNET_DISCONNECTED/);
  updater.dispose();
});

test("choosing Later keeps a downloaded update ready for explicit install on quit", async () => {
  const { adapter, host, updater } = createHarness();
  host.messageResponse = 1;

  adapter.emit("update-downloaded", { version: "1.1.0" });
  await nextTurn();

  assert.equal(updater.getStatus().phase, "ready");
  assert.match(updater.getStatus().message, /install when you quit/i);
  assert.equal(updater.shouldInstallOnQuit(), true);
  assert.equal(host.messages.length, 1);
  updater.dispose();
});

test("Update now downloads, performs update-specific shutdown, and forces the app to relaunch", async () => {
  const { adapter, updater, prepareCalls } = createHarness();
  const checked = await updater.check(true);
  assert.equal(checked.phase, "available");

  await updater.updateNow();
  await nextTurn();

  assert.equal(adapter.autoDownload, false);
  assert.equal(adapter.autoInstallOnAppQuit, false);
  assert.equal(adapter.autoRunAppAfterInstall, true);
  assert.equal(prepareCalls(), 1);
  assert.deepEqual(adapter.quitCalls, [{ silent: true, forceRunAfter: true }]);
  assert.equal(updater.getStatus().phase, "installing");
  updater.dispose();
});

test("install refuses to quit when the downloaded installer path is missing", async () => {
  const { adapter, host, updater } = createHarness();
  host.installerPresent = false;
  adapter.emit("update-downloaded", { version: "1.1.0" });
  await nextTurn();

  const status = await updater.install();

  assert.equal(status.phase, "error");
  assert.match(status.message, /payload is missing/i);
  assert.equal(adapter.quitCalls.length, 0);
  assert.equal(updater.shouldInstallOnQuit(), false);
  updater.dispose();
});

test("macOS installs after update-downloaded without a Windows installer path", async () => {
  const { adapter, host, updater, prepareCalls } = createHarness({ platform: "darwin" });
  adapter.installerPath = null;
  host.installerPresent = false;
  adapter.emit("update-downloaded", { version: "1.1.0" });
  await nextTurn();

  const status = await updater.install();

  assert.equal(status.phase, "installing");
  assert.equal(prepareCalls(), 1);
  assert.deepEqual(adapter.quitCalls, [{ silent: true, forceRunAfter: true }]);
  updater.dispose();
});

test("a quitAndInstall failure after shutdown never reports ready and asks the host to relaunch", async () => {
  const { adapter, updater, prepareCalls, failures } = createHarness();
  adapter.quitError = new Error("installer launch failed");
  adapter.emit("update-downloaded", { version: "1.1.0" });
  await nextTurn();

  const status = await updater.install();

  assert.equal(prepareCalls(), 1);
  assert.equal(status.phase, "error");
  assert.match(status.error ?? "", /installer launch failed/);
  assert.equal(updater.shouldInstallOnQuit(), false);
  assert.deepEqual(failures, [{ message: "installer launch failed", relaunch: true }]);
  // The backend is gone: a second attempt must not run shutdown or install again.
  await updater.install();
  assert.equal(prepareCalls(), 1);
  assert.equal(adapter.quitCalls.length, 1);
  updater.dispose();
});

test("macOS stages and validates the update with Squirrel before any shutdown", async () => {
  const { adapter, host, updater } = createHarness({ platform: "darwin" });
  adapter.installerPath = null;
  adapter.emit("update-downloaded", { version: "1.1.0" });
  await nextTurn();
  const originalQuit = adapter.quitAndInstall.bind(adapter);
  adapter.quitAndInstall = (silent, forceRunAfter) => { host.events.push("quitAndInstall"); originalQuit(silent, forceRunAfter); };

  const status = await updater.install();

  assert.equal(status.phase, "installing");
  assert.deepEqual(host.events, ["stage", "shutdown", "quitAndInstall"]);
  updater.dispose();
});

test("a Squirrel staging failure leaves the app running and asks for a fresh download", async () => {
  const { adapter, host, updater, prepareCalls, failures } = createHarness({ platform: "darwin" });
  host.stageError = new Error("Code signature at URL did not pass validation");
  adapter.emit("update-downloaded", { version: "1.1.0" });
  await nextTurn();

  const status = await updater.install();

  assert.equal(prepareCalls(), 0);
  assert.equal(adapter.quitCalls.length, 0);
  assert.equal(status.phase, "error");
  assert.match(status.message, /could not be prepared/i);
  assert.match(status.error ?? "", /did not pass validation/);
  assert.equal(updater.shouldInstallOnQuit(), false);
  assert.deepEqual(failures, []);
  updater.dispose();
});

test("a Squirrel error re-emitted during staging is reported once by the staging step", async () => {
  const { adapter, host, updater, prepareCalls, failures } = createHarness({ platform: "darwin" });
  let rejectStage: (error: Error) => void = () => undefined;
  host.stageDownloadedUpdate = () => new Promise<void>((_resolve, reject) => { rejectStage = reject; });
  adapter.emit("update-downloaded", { version: "1.1.0" });
  await nextTurn();

  const pending = updater.install();
  await nextTurn();
  adapter.emit("error", new Error("Squirrel fetch failed"));
  assert.equal(updater.getStatus().phase, "installing");
  rejectStage(new Error("Squirrel fetch failed"));
  const status = await pending;

  assert.equal(status.phase, "error");
  assert.equal(prepareCalls(), 0);
  assert.deepEqual(failures, []);
  updater.dispose();
});

test("an updater error after hand-off fails closed instead of restoring ready", async () => {
  const { adapter, updater, failures } = createHarness({ platform: "darwin" });
  adapter.emit("update-downloaded", { version: "1.1.0" });
  await nextTurn();
  await updater.install();

  adapter.emit("error", new Error("ShipIt could not replace the app"));

  assert.equal(updater.getStatus().phase, "error");
  assert.equal(updater.shouldInstallOnQuit(), false);
  assert.deepEqual(failures, [{ message: "ShipIt could not replace the app", relaunch: true }]);
  updater.dispose();
});

test("install-on-quit stages, runs the update shutdown once, and does not force relaunch", async () => {
  const { adapter, host, updater, prepareCalls, failures } = createHarness({ platform: "darwin" });
  adapter.emit("update-downloaded", { version: "1.1.0" });
  await nextTurn();

  const status = await updater.installDownloadedUpdateOnQuit();

  assert.equal(status.phase, "installing");
  assert.equal(prepareCalls(), 1);
  assert.deepEqual(host.events, ["stage", "shutdown"]);
  assert.deepEqual(adapter.quitCalls, [{ silent: true, forceRunAfter: false }]);
  adapter.emit("error", new Error("late failure"));
  assert.deepEqual(failures, [{ message: "late failure", relaunch: false }]);
  updater.dispose();
});

test("a wake or periodic check cannot flip the status while a download is in flight", async () => {
  const { adapter, updater } = createHarness();
  await updater.check(true);
  adapter.downloadUpdate = () => new Promise<void>(() => { adapter.emit("download-progress", { percent: 10 }); });
  void updater.updateNow();
  await nextTurn();
  assert.equal(updater.getStatus().phase, "downloading");
  const callsBefore = adapter.checkCalls;

  const background = await updater.check(false);
  const interactive = await updater.check(true);

  assert.equal(background.phase, "downloading");
  assert.equal(interactive.phase, "downloading");
  assert.equal(adapter.checkCalls, callsBefore);
  updater.dispose();
});

class FakeSquirrel extends EventEmitter {
  checks = 0;
  outcome: "downloaded" | "error" | "not-available" | "silent" = "downloaded";
  checkForUpdates(): void {
    this.checks += 1;
    setImmediate(() => {
      if (this.outcome === "downloaded") this.emit("update-downloaded");
      else if (this.outcome === "error") this.emit("error", new Error("signature invalid"));
      else if (this.outcome === "not-available") this.emit("update-not-available");
    });
  }
}

test("Squirrel staging resolves on update-downloaded and removes its listeners", async () => {
  const native = new FakeSquirrel();
  await stageSquirrelMacUpdate(native, 1_000);
  assert.equal(native.checks, 1);
  assert.equal(native.listenerCount("update-downloaded"), 0);
  assert.equal(native.listenerCount("error"), 0);
  assert.equal(native.listenerCount("update-not-available"), 0);
});

test("Squirrel staging rejects on error, no update, or timeout", async () => {
  const native = new FakeSquirrel();
  native.outcome = "error";
  await assert.rejects(stageSquirrelMacUpdate(native, 1_000), /signature invalid/);
  native.outcome = "not-available";
  await assert.rejects(stageSquirrelMacUpdate(native, 1_000), /no downloaded update/);
  native.outcome = "silent";
  await assert.rejects(stageSquirrelMacUpdate(native, 5), /in time/);
  assert.equal(native.listenerCount("error"), 0);
});
