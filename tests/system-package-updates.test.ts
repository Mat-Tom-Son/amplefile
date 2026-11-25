import assert from "node:assert/strict";
import test from "node:test";
import {
  readAsarPackageVersion,
  repositoryEnabled,
  SystemPackageUpdates,
  systemPackageInstallation,
  systemPackageUpdatesMessage,
  type InstalledFileIdentity,
} from "../desktop/src/system-package-updates.js";
import type { DesktopUpdateStatus } from "../src/shared/desktop-ipc.js";
import { updateActionLabel, updateCallFor, updateIndicatorFor } from "../web-local/src/lib/update-status.js";
import { updateRestartConfirm } from "../web-local/src/lib/update-restart.js";

const entry = "[amplefile]\nname=AmpleFile Linux preview builds\nbaseurl=https://example.invalid/rpm/$basearch\nenabled=1\ngpgcheck=1\nrepo_gpgcheck=1\n";
const rpmInstall = {
  platform: "linux" as NodeJS.Platform,
  isPackaged: true,
  execPath: "/opt/AmpleFile/amplefile-desktop",
  resourcesPath: "/opt/AmpleFile/resources",
  appImage: undefined,
  productName: "AmpleFile",
  repositoryId: "amplefile",
  readText: (path: string) => path === "/etc/yum.repos.d/amplefile.repo" ? entry : null,
};

test("a dnf entry is enabled unless the person turned it off", () => {
  assert.equal(repositoryEnabled(entry, "amplefile"), true);
  assert.equal(repositoryEnabled(entry.replace("enabled=1\n", ""), "amplefile"), true, "dnf treats a missing enabled as on");
  for (const off of ["0", "no", "False", "off"]) assert.equal(repositoryEnabled(entry.replace("enabled=1", `enabled = ${off}`), "amplefile"), false);
  assert.equal(repositoryEnabled(entry, "other"), false);
  assert.equal(repositoryEnabled(`${entry}[other]\nenabled=0\n`, "amplefile"), true);
  assert.equal(repositoryEnabled(`# enabled=0\n${entry}`, "amplefile"), true);
});

test("only the repository-managed RPM install reports system updates", () => {
  assert.deepEqual(systemPackageInstallation(rpmInstall), { repositoryFile: "/etc/yum.repos.d/amplefile.repo", watchedFile: "/opt/AmpleFile/resources/app.asar" });
  // An AppImage, a DEB or unenrolled RPM (no entry), a disabled entry, a development run, other places, and other platforms.
  assert.equal(systemPackageInstallation({ ...rpmInstall, appImage: "/home/a/AmpleFile.AppImage", execPath: "/tmp/.mount_x/amplefile-desktop" }), null);
  assert.equal(systemPackageInstallation({ ...rpmInstall, appImage: "/home/a/AmpleFile.AppImage" }), null);
  assert.equal(systemPackageInstallation({ ...rpmInstall, readText: () => null }), null);
  assert.equal(systemPackageInstallation({ ...rpmInstall, readText: () => entry.replace("enabled=1", "enabled=0") }), null);
  assert.equal(systemPackageInstallation({ ...rpmInstall, isPackaged: false }), null);
  assert.equal(systemPackageInstallation({ ...rpmInstall, execPath: "/home/a/out/linux/linux-unpacked/amplefile-desktop" }), null);
  assert.equal(systemPackageInstallation({ ...rpmInstall, platform: "darwin" }), null);
});

/** An ASAR archive with the given files, laid out as @electron/asar writes it. */
function asar(files: Record<string, string>): Buffer {
  const header: { files: Record<string, { size: number; offset: string }> } = { files: {} };
  const bodies: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    header.files[name] = { size: body.length, offset: String(offset) };
    bodies.push(body);
    offset += body.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const padding = (4 - (json.length % 4)) % 4;
  const headerPickle = Buffer.alloc(8 + json.length + padding);
  headerPickle.writeUInt32LE(4 + json.length + padding, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, ...bodies]);
}
const reader = (bytes: Buffer) => (position: number, length: number) => bytes.subarray(position, position + length);

test("the installed archive's version is read from its package.json", () => {
  assert.equal(readAsarPackageVersion(reader(asar({ "LICENSE": "MIT", "package.json": JSON.stringify({ name: "amplefile-desktop", version: "0.2.2" }) }))), "0.2.2");
  assert.equal(readAsarPackageVersion(reader(asar({ "LICENSE": "MIT" }))), null);
  assert.equal(readAsarPackageVersion(reader(asar({ "package.json": "{not json" }))), null);
  assert.equal(readAsarPackageVersion(reader(asar({ "package.json": JSON.stringify({ version: "<script>" }) }))), null);
  assert.equal(readAsarPackageVersion(reader(Buffer.from("not an archive at all"))), null);
  assert.equal(readAsarPackageVersion(reader(Buffer.alloc(0))), null);
});

function harness({ files = [{ dev: 1, ino: 10, size: 100, mtimeMs: 1 }] as Array<InstalledFileIdentity | null>, installed = "0.2.2" as string | null } = {}) {
  const statuses: DesktopUpdateStatus[] = [];
  const calls: string[] = [];
  let file: InstalledFileIdentity | null = files[0] ?? null;
  const updates = new SystemPackageUpdates({
    installation: { repositoryFile: "/etc/yum.repos.d/amplefile.repo", watchedFile: "/opt/AmpleFile/resources/app.asar" },
    automaticChecks: false,
    prepareToRestart: async () => { calls.push("prepareToRestart"); },
    relaunch: () => { calls.push("relaunch"); },
    host: {
      currentVersion: () => "0.2.1",
      identify: () => file,
      installedVersion: () => installed,
      emitStatus: (status) => { statuses.push(status); },
    },
  });
  return { updates, statuses, calls, replace(next: InstalledFileIdentity | null) { file = next; } };
}

test("an enrolled install says updates arrive with the system's, with no update command of its own", async () => {
  const { updates, statuses, calls } = harness();
  updates.start();
  const status = updates.getStatus();
  assert.equal(updates.supported, false, "no Check for Updates command: the app has no feed of its own");
  assert.equal(status.supported, false, "no sidebar indicator and no About button while nothing changed");
  assert.equal(status.phase, "unsupported");
  assert.equal(status.message, systemPackageUpdatesMessage);
  assert.equal(status.message, "AmpleFile updates arrive with your system's software updates.");
  assert.equal(status.updatesFrom, "system");
  assert.equal(statuses.at(-1)?.message, systemPackageUpdatesMessage);
  assert.equal((await updates.check()).phase, "unsupported");
  assert.equal((await updates.install()).phase, "unsupported", "nothing to restart into");
  assert.deepEqual(calls, []);
  assert.equal(await updates.prepareForApplicationQuit(), false, "an ordinary quit stays ordinary");
});

test("files replaced under the running app offer a restart, once the change holds", async () => {
  const { updates, calls, replace } = harness();
  updates.start();
  replace(null);
  assert.equal((await updates.check()).phase, "unsupported", "unreadable mid-transaction: nothing yet");
  replace({ dev: 1, ino: 11, size: 120, mtimeMs: 2 });
  assert.equal((await updates.check()).phase, "unsupported", "a change seen once may still be in progress");
  replace({ dev: 1, ino: 12, size: 130, mtimeMs: 3 });
  assert.equal((await updates.check()).phase, "unsupported", "still changing");
  const ready = await updates.check();
  assert.equal(ready.phase, "ready");
  assert.equal(ready.supported, true);
  assert.equal(ready.availableVersion, "0.2.2");
  assert.equal(ready.updatesFrom, "system");
  assert.equal(ready.message, "AmpleFile 0.2.2 was installed. Restart AmpleFile to use it.");
  assert.equal(updates.supported, false, "still no Check for Updates command");
  assert.deepEqual(calls, [], "never restarts on its own");
});

test("a later build of the same version, and an unreadable version, still offer the restart", async () => {
  const same = harness({ installed: "0.2.1" });
  same.updates.start();
  same.replace({ dev: 1, ino: 11, size: 100, mtimeMs: 2 });
  await same.updates.check();
  assert.equal((await same.updates.check()).message, "AmpleFile was updated. Restart AmpleFile to use the update.");
  const unknown = harness({ installed: null });
  unknown.updates.start();
  unknown.replace({ dev: 1, ino: 11, size: 100, mtimeMs: 2 });
  await unknown.updates.check();
  const status = await unknown.updates.check();
  assert.equal(status.availableVersion, null);
  assert.equal(status.message, "AmpleFile was updated. Restart AmpleFile to use the update.");
});

test("the restart runs only when the person chooses it: shut down, then relaunch, once", async () => {
  const { updates, statuses, calls, replace } = harness();
  updates.start();
  replace({ dev: 1, ino: 11, size: 120, mtimeMs: 2 });
  await updates.check();
  await updates.check();
  const restarting = updates.install();
  assert.equal(statuses.at(-1)?.phase, "installing");
  assert.equal(statuses.at(-1)?.message, "Restarting AmpleFile...");
  const again = updates.updateNow();
  await Promise.all([restarting, again]);
  assert.deepEqual(calls, ["prepareToRestart", "relaunch"]);
  assert.equal(await updates.prepareForApplicationQuit(), true, "the restart has taken over quitting");
  assert.deepEqual(calls, ["prepareToRestart", "relaunch"]);
});

test("a shutdown failure still restarts, since the backend is gone", async () => {
  const calls: string[] = [];
  let file: InstalledFileIdentity = { dev: 1, ino: 10, size: 100, mtimeMs: 1 };
  const updates = new SystemPackageUpdates({
    installation: { repositoryFile: "/etc/yum.repos.d/amplefile.repo", watchedFile: "/opt/AmpleFile/resources/app.asar" },
    automaticChecks: false,
    prepareToRestart: async () => { calls.push("prepareToRestart"); throw new Error("timed out"); },
    relaunch: () => { calls.push("relaunch"); },
    host: { currentVersion: () => "0.2.1", identify: () => file, installedVersion: () => "0.2.2", emitStatus: () => undefined },
  });
  updates.start();
  file = { dev: 1, ino: 11, size: 100, mtimeMs: 2 };
  await updates.check();
  await updates.check();
  const original = console.error;
  console.error = () => undefined;
  try {
    await updates.install();
  } finally {
    console.error = original;
  }
  assert.deepEqual(calls, ["prepareToRestart", "relaunch"]);
});

test("the indicator, About and the restart question name a system-installed update", () => {
  const ready: DesktopUpdateStatus = {
    supported: true, phase: "ready", currentVersion: "0.2.1", availableVersion: "0.2.2", progressPercent: null, checkedAt: null,
    message: "AmpleFile 0.2.2 was installed. Restart AmpleFile to use it.", error: null, updatesFrom: "system",
  };
  assert.equal(updateCallFor(ready), "install");
  assert.equal(updateActionLabel(ready), "Restart to Update");
  const indicator = updateIndicatorFor(ready);
  assert.equal(indicator?.label, "Restart to Update");
  assert.equal(indicator?.click, "update");
  assert.match(indicator!.tooltip, /was installed with your system's software updates\. AmpleFile asks, then quits and opens again to use it\./);
  assert.match(indicator!.announcement!, /^AmpleFile 0\.2\.2 was installed\./);
  const question = updateRestartConfirm("install", ready, { chats: [{ connectedFolderId: "home", conversationId: "c" }], ampleFileAgentWorking: false }, [{ id: "home", name: "Home projects" }]);
  assert.match(question.body!, /^Your system's software updates already installed version 0\.2\.2\. AmpleFile quits and opens again on its own to use it\. 1 Worker Chat is working \(Home projects\)\. Restarting stops this work/);
  assert.equal(question.confirmLabel, "Restart");
  assert.equal(question.tone, "danger");
  const waiting: DesktopUpdateStatus = { ...ready, supported: false, phase: "unsupported", availableVersion: null, message: systemPackageUpdatesMessage };
  assert.equal(updateIndicatorFor(waiting), null, "nothing in the sidebar until files change");
  // The app updater's wording is unchanged.
  const app: DesktopUpdateStatus = { ...ready, updatesFrom: undefined };
  assert.equal(updateActionLabel(app), "Restart and Install");
  assert.match(updateIndicatorFor(app)!.tooltip, /is ready\. AmpleFile asks, then quits and opens again to install it\./);
  assert.equal(updateRestartConfirm("install", app, { chats: [], ampleFileAgentWorking: false }, []).confirmLabel, "Update and Restart");
});

test("on Linux the update source starts before the first window reads its status", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  // Otherwise the window's first read is the "not available" stand-in, and
  // the real status event can arrive before the window subscribes.
  assert.match(main, /if \(process\.platform === "linux"\) configureUpdater\(\);\s*await ensureWindow\(\);\s*configureUpdater\(\);/);
});
