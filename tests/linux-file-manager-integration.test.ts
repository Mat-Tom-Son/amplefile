import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fileManagerRequest,
  localPathFromFileUri,
  maxFileManagerUriLength,
  maxFileManagerUris,
  type FileManagerServiceState,
} from "../desktop/src/linux-file-manager-service.js";
import {
  desktopEntryName,
  fileManagerServiceFileContent,
  fileManagerServiceFilePath,
  LinuxFileManagerIntegration,
  linuxFileManagerLaunchCommand,
  mimeappsDefault,
  openFoldersByDefaultStatus,
  parseServiceFile,
  readFileManagerServiceFile,
  removeFileManagerServiceFile,
  serviceExecArgument,
  setOpenFoldersByDefault,
  splitServiceExec,
  systemFileManagerProgram,
  unsetOpenFoldersByDefault,
  userMimeappsPath,
  withMimeappsDefault,
  writeFileManagerServiceFile,
  type LinuxFileManagerEnvironment,
} from "../desktop/src/linux-file-manager-integration.js";
import { fileManagerOpenPath } from "../desktop/src/linux-file-manager-host.js";
import type { FileManagerService } from "../desktop/src/linux-file-manager-service.js";

/**
 * Settings → File Manager on Linux, against a fake XDG_DATA_HOME,
 * XDG_CONFIG_HOME and XDG_DATA_DIRS: the URIs other apps send, the per-user
 * D-Bus service file, and the default folder handler.
 */

// ---------------------------------------------------------------------------
// URIs

test("file: URIs become absolute, normalized local paths", () => {
  assert.equal(localPathFromFileUri("file:///home/me/Downloads/report.pdf"), "/home/me/Downloads/report.pdf");
  assert.equal(localPathFromFileUri("file:///tmp/a%20b/%C3%A9t%C3%A9.txt"), "/tmp/a b/été.txt");
  assert.equal(localPathFromFileUri("FILE://localhost/tmp/x/"), "/tmp/x");
  assert.equal(localPathFromFileUri("file:///tmp/a/../b/./c"), "/tmp/b/c");
  assert.equal(localPathFromFileUri("file:///"), "/");
  assert.equal(localPathFromFileUri("file:///tmp/50%25%23%3F"), "/tmp/50%#?");
});

test("anything but a plain local file: URI is ignored", () => {
  for (const value of [
    "https://example.invalid/x", "/tmp/plain-path", "file:relative", "file://otherhost/tmp/x", "file:///tmp/x?query",
    "file:///tmp/x#fragment", "file:///tmp/bad%zz", "file:///tmp/half%4", "file:///tmp/nul%00name", "file:///tmp/%FF%FE",
    "file:///tmp/new\nline", "file://", 42, null, ["file:///tmp"],
    `file:///${"a".repeat(maxFileManagerUriLength)}`,
  ]) assert.equal(localPathFromFileUri(value), null, JSON.stringify(value));
});

test("a request keeps usable URIs in order, without repeats, from the first 64 only", () => {
  const uris = Array.from({ length: maxFileManagerUris + 10 }, (_, index) => index === 0 ? "https://x.invalid" : `file:///tmp/${index % 70}`);
  const request = fileManagerRequest("ShowItems", ["file:///tmp/1", ...uris], "startup_TIME123");
  assert.ok(request);
  assert.equal(request.paths[0], "/tmp/1");
  // The first 64: /tmp/1, an https URI, /tmp/1 again, then /tmp/2 to /tmp/62.
  assert.equal(request.paths.length, maxFileManagerUris - 2);
  assert.equal(request.paths.at(-1), "/tmp/62");
  assert.equal(request.startupId, "startup_TIME123");
  assert.equal(fileManagerRequest("ShowItems", ["ftp://x"], ""), null);
  assert.equal(fileManagerRequest("ShowItems", "file:///tmp", ""), null);
  assert.equal(fileManagerRequest("ShowFolders", ["file:///tmp"], "bad id with spaces")?.startupId, null);
  assert.equal(fileManagerRequest("ShowFolders", ["file:///tmp"], "x".repeat(257))?.startupId, null);
});

test("ShowFolders opens the folder; ShowItems and ShowItemProperties show the item selected in its folder", () => {
  assert.deepEqual(fileManagerOpenPath({ method: "ShowFolders", paths: ["/a", "/b"], startupId: null }), { path: "/a", reveal: false });
  assert.deepEqual(fileManagerOpenPath({ method: "ShowItems", paths: ["/a/f"], startupId: null }), { path: "/a/f", reveal: true });
  assert.deepEqual(fileManagerOpenPath({ method: "ShowItemProperties", paths: ["/a/f"], startupId: null }), { path: "/a/f", reveal: true });
});

// ---------------------------------------------------------------------------
// The service file

async function sandbox(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "amplefile-file-manager-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_DIRS: join(root, "system"),
    XDG_CONFIG_DIRS: join(root, "system-config"),
    XDG_CURRENT_DESKTOP: "X-AmpleFile-Test",
    PATH: process.env.PATH,
    HOME: join(root, "home"),
  };
  return { root, env, home: join(root, "home"), launchCommand: ["/opt/AmpleFile/amplefile-desktop"] };
}

test("launch commands: the installed executable, the AppImage file, or Electron with the app folder", () => {
  assert.deepEqual(linuxFileManagerLaunchCommand({ isPackaged: true, execPath: "/opt/AmpleFile/amplefile-desktop", appPath: "/opt/AmpleFile/resources/app.asar" }), ["/opt/AmpleFile/amplefile-desktop"]);
  assert.deepEqual(linuxFileManagerLaunchCommand({ isPackaged: true, execPath: "/tmp/.mount_X/amplefile-desktop", appPath: "x", appImage: "/home/me/Apps/AmpleFile.AppImage" }), ["/home/me/Apps/AmpleFile.AppImage"]);
  assert.deepEqual(linuxFileManagerLaunchCommand({ isPackaged: false, execPath: "/repo/node_modules/electron/dist/electron", appPath: "/repo" }), ["/repo/node_modules/electron/dist/electron", "/repo"]);
});

test("Exec arguments are quoted the way the bus splits them, and unsafe ones are refused", () => {
  assert.equal(serviceExecArgument("/opt/AmpleFile/amplefile-desktop"), "/opt/AmpleFile/amplefile-desktop");
  assert.equal(serviceExecArgument("/home/me/My Apps/AmpleFile.AppImage"), "'/home/me/My Apps/AmpleFile.AppImage'");
  assert.equal(serviceExecArgument("/tmp/$HOME `x` \"y\""), "'/tmp/$HOME `x` \"y\"'");
  assert.throws(() => serviceExecArgument("/tmp/it's"), /quotes/);
  assert.throws(() => serviceExecArgument("/tmp/new\nline"), /control/);
  assert.throws(() => serviceExecArgument(""), /quotes or control/);
  const words = ["/home/me/My Apps/AmpleFile.AppImage", "/tmp/$HOME \"y\"", "plain"];
  assert.deepEqual(splitServiceExec(words.map(serviceExecArgument).join(" ")), words);
  assert.deepEqual(splitServiceExec(`/usr/bin/nautilus --gapplication-service`), ["/usr/bin/nautilus", "--gapplication-service"]);
  assert.deepEqual(splitServiceExec(`"/a b/\\"c" d\\ e`), ["/a b/\"c", "d e"]);
});

test("the service file names FileManager1, starts this AmpleFile, and says who wrote it", () => {
  const content = fileManagerServiceFileContent(["/home/me/My Apps/AmpleFile.AppImage"], null);
  assert.equal(content, [
    "# Written by AmpleFile for Settings → File Manager → Show Files from Other Apps.",
    "# Turning that off removes this file and puts back any file it replaced.",
    "[D-BUS Service]",
    "Name=org.freedesktop.FileManager1",
    "Exec='/home/me/My Apps/AmpleFile.AppImage'",
    "",
  ].join("\n"));
  assert.deepEqual(parseServiceFile(content), { name: "org.freedesktop.FileManager1", exec: ["/home/me/My Apps/AmpleFile.AppImage"], writtenByAmpleFile: true, replaced: null });
  const earlier = "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=/home/me/.local/bin/thinkpad-files --gapplication-service\n";
  assert.equal(parseServiceFile(fileManagerServiceFileContent(["/x"], earlier)).replaced, earlier);
  // Someone else's file mentioning AmpleFile later is not AmpleFile's.
  assert.equal(parseServiceFile(`[D-BUS Service]\n# Written by AmpleFile\nName=org.freedesktop.FileManager1\nExec=/x\n`).writtenByAmpleFile, false);
});

test("turning it on writes the file; off removes it; another copy's file reads as elsewhere", async (t) => {
  const box = await sandbox(t);
  assert.deepEqual(await readFileManagerServiceFile(box), { kind: "none" });
  await writeFileManagerServiceFile(box);
  const path = fileManagerServiceFilePath(box);
  assert.equal(path, join(box.root, "data", "dbus-1", "services", "org.freedesktop.FileManager1.service"));
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  assert.deepEqual(await readFileManagerServiceFile(box), { kind: "ours", exec: box.launchCommand, pointsHere: true, replaced: null });
  assert.deepEqual(await readFileManagerServiceFile({ ...box, launchCommand: ["/elsewhere/amplefile-desktop"] }), { kind: "ours", exec: box.launchCommand, pointsHere: false, replaced: null });
  assert.equal(await removeFileManagerServiceFile(box), true);
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.equal(await removeFileManagerServiceFile(box), false);
});

test("the person's own earlier service file is kept inside AmpleFile's and put back byte for byte, by any copy", async (t) => {
  const box = await sandbox(t);
  const path = fileManagerServiceFilePath(box);
  await mkdir(join(box.root, "data", "dbus-1", "services"), { recursive: true });
  const earlier = "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=/home/me/.local/bin/thinkpad-files --gapplication-service\n";
  await writeFile(path, earlier);
  assert.deepEqual(await readFileManagerServiceFile(box), { kind: "other", program: "thinkpad-files", content: earlier });
  await writeFileManagerServiceFile(box);
  // Turning it on again (or from another copy) keeps the original, not AmpleFile's own file.
  const otherCopy = { ...box, launchCommand: ["/other/amplefile"] };
  await writeFileManagerServiceFile(otherCopy);
  const ours = await readFileManagerServiceFile(otherCopy);
  assert.equal(ours.kind === "ours" && ours.replaced, earlier);
  assert.equal(await removeFileManagerServiceFile(box), true);
  assert.equal(await readFile(path, "utf8"), earlier);
});

test("someone else's file is never removed, and an unreadable one is not replaced", async (t) => {
  const box = await sandbox(t);
  const path = fileManagerServiceFilePath(box);
  await mkdir(path, { recursive: true });
  await assert.rejects(writeFileManagerServiceFile(box), /isn't a file AmpleFile can read and keep/);
  await rm(path, { recursive: true });
  const other = "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=/usr/bin/dolphin\n";
  await writeFile(path, other);
  assert.equal(await removeFileManagerServiceFile(box), false);
  assert.equal(await readFile(path, "utf8"), other);
});

test("through a symbolic link, the link's target is replaced and the link kept", async (t) => {
  const box = await sandbox(t);
  const path = fileManagerServiceFilePath(box);
  await mkdir(join(box.root, "data", "dbus-1", "services"), { recursive: true });
  const target = join(box.root, "dotfiles.service");
  await writeFile(target, "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=/usr/bin/nemo\n");
  await symlink(target, path);
  await writeFileManagerServiceFile(box);
  assert.match(await readFile(target, "utf8"), /Written by AmpleFile/);
  await removeFileManagerServiceFile(box);
  assert.equal(await readFile(target, "utf8"), "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=/usr/bin/nemo\n");
});

test("the system file manager is found by name, whatever its file is called", async (t) => {
  const box = await sandbox(t);
  assert.equal(await systemFileManagerProgram(box.env), null);
  const services = join(box.root, "system", "dbus-1", "services");
  await mkdir(services, { recursive: true });
  await writeFile(join(services, "org.freedesktop.Notifications.service"), "[D-BUS Service]\nName=org.freedesktop.Notifications\nExec=/usr/bin/mako\n");
  await writeFile(join(services, "org.kde.dolphin.FileManager1.service"), "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=/usr/bin/dolphin --daemon\n");
  assert.equal(await systemFileManagerProgram(box.env), "Dolphin");
});

// ---------------------------------------------------------------------------
// mimeapps.list

test("mimeapps.list: read, set, add, and remove one default, leaving every other line", () => {
  const text = "# my settings\n[Default Applications]\ntext/html=google-chrome.desktop\n\n[Added Associations]\ninode/directory=org.gnome.Nautilus.desktop;\n";
  assert.equal(mimeappsDefault(text, "inode/directory"), null);
  const added = withMimeappsDefault(text, "inode/directory", "amplefile-desktop.desktop");
  assert.equal(added, "# my settings\n[Default Applications]\ntext/html=google-chrome.desktop\ninode/directory=amplefile-desktop.desktop\n\n[Added Associations]\ninode/directory=org.gnome.Nautilus.desktop;\n");
  assert.equal(mimeappsDefault(added, "inode/directory"), "amplefile-desktop.desktop");
  assert.equal(withMimeappsDefault(added, "inode/directory", null), text);
  assert.equal(withMimeappsDefault(added, "inode/directory", "a.desktop;b.desktop;"), added.replace("amplefile-desktop.desktop", "a.desktop;b.desktop;"));
  assert.equal(withMimeappsDefault("", "inode/directory", "x.desktop"), "[Default Applications]\ninode/directory=x.desktop\n");
  assert.equal(withMimeappsDefault("[Added Associations]\na=b\n", "inode/directory", "x.desktop"), "[Added Associations]\na=b\n\n[Default Applications]\ninode/directory=x.desktop\n");
  assert.equal(withMimeappsDefault("[Default Applications]\r\na=b\r\n", "inode/directory", "x.desktop"), "[Default Applications]\r\na=b\r\ninode/directory=x.desktop\r\n");
});

// ---------------------------------------------------------------------------
// The default folder handler

/** Stands in for xdg-mime: the user's mimeapps.list first, then the system's. */
function fakeXdgMime(box: { root: string; env: NodeJS.ProcessEnv; home: string }, options: { ignoreDefault?: boolean } = {}) {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command !== "xdg-mime") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    const userPath = userMimeappsPath(box);
    const user = await readFile(userPath, "utf8").catch(() => "");
    if (args[0] === "query") {
      const system = await readFile(join(box.root, "system", "applications", "mimeapps.list"), "utf8").catch(() => "");
      return `${(mimeappsDefault(user, args[2]!) ?? mimeappsDefault(system, args[2]!) ?? "").split(";")[0]}\n`;
    }
    if (args[0] === "default" && !options.ignoreDefault) {
      await mkdir(join(box.root, "config"), { recursive: true });
      await writeFile(userPath, withMimeappsDefault(user, args[2]!, args[1]!));
    }
    return "";
  };
  return { run, calls };
}

async function desktopEntries(root: string, options: { ampleFile?: boolean } = {}) {
  const applications = join(root, "system", "applications");
  await mkdir(applications, { recursive: true });
  await writeFile(join(applications, "org.gnome.Nautilus.desktop"), "[Desktop Entry]\nName=Files\nName[de]=Dateien\nExec=nautilus --new-window %U\n");
  await writeFile(join(applications, "mimeapps.list"), "[Default Applications]\ninode/directory=org.gnome.Nautilus.desktop\n");
  if (options.ampleFile !== false) await writeFile(join(applications, "amplefile-desktop.desktop"), "[Desktop Entry]\nName=AmpleFile\nExec=/opt/AmpleFile/amplefile-desktop %U\n");
}

function handlerEnvironment(box: Awaited<ReturnType<typeof sandbox>>, run?: LinuxFileManagerEnvironment["run"]): LinuxFileManagerEnvironment {
  return { ...box, desktopId: "amplefile-desktop.desktop", statePath: join(box.root, "app-data", "file-manager-integration.json"), run };
}

test("open folders with AmpleFile: on, then off gives folders back and leaves mimeapps.list as it was", async (t) => {
  const box = await sandbox(t);
  await desktopEntries(box.root);
  const { run } = fakeXdgMime(box);
  const environment = handlerEnvironment(box, run);
  await mkdir(join(box.root, "config"), { recursive: true });
  const before = "[Default Applications]\ntext/html=google-chrome.desktop\n";
  await writeFile(userMimeappsPath(box), before);
  assert.equal(await desktopEntryName(environment, "org.gnome.Nautilus.desktop"), "Files");
  assert.deepEqual(await openFoldersByDefaultStatus(environment), { state: "off", current: "Files", previous: null, reason: null });
  await setOpenFoldersByDefault(environment);
  assert.deepEqual(await openFoldersByDefaultStatus(environment), { state: "on", current: "AmpleFile", previous: "Files", reason: null });
  await unsetOpenFoldersByDefault(environment);
  assert.equal(await readFile(userMimeappsPath(box), "utf8"), before);
  assert.deepEqual(await openFoldersByDefaultStatus(environment), { state: "off", current: "Files", previous: null, reason: null });
  await assert.rejects(stat(environment.statePath), { code: "ENOENT" });
});

test("the person's own earlier default comes back, a list included", async (t) => {
  const box = await sandbox(t);
  await desktopEntries(box.root);
  const applications = join(box.root, "data", "applications");
  await mkdir(applications, { recursive: true });
  await writeFile(join(applications, "thunar.desktop"), "[Desktop Entry]\nName=Thunar\n");
  const environment = handlerEnvironment(box, fakeXdgMime(box).run);
  await mkdir(join(box.root, "config"), { recursive: true });
  const before = "[Default Applications]\ninode/directory=thunar.desktop;org.gnome.Nautilus.desktop;\n";
  await writeFile(userMimeappsPath(box), before);
  await setOpenFoldersByDefault(environment);
  assert.equal((await openFoldersByDefaultStatus(environment)).previous, "Thunar");
  await unsetOpenFoldersByDefault(environment);
  assert.equal(await readFile(userMimeappsPath(box), "utf8"), before);
});

test("turning it off after the person chose another app changes nothing", async (t) => {
  const box = await sandbox(t);
  await desktopEntries(box.root);
  const environment = handlerEnvironment(box, fakeXdgMime(box).run);
  await setOpenFoldersByDefault(environment);
  const elsewhere = "[Default Applications]\ninode/directory=org.gnome.Nautilus.desktop\n";
  await writeFile(userMimeappsPath(box), elsewhere);
  assert.equal((await openFoldersByDefaultStatus(environment)).state, "off");
  await unsetOpenFoldersByDefault(environment);
  assert.equal(await readFile(userMimeappsPath(box), "utf8"), elsewhere);
});

test("without AmpleFile's desktop entry, or the tools, it is unavailable with the reason", async (t) => {
  const box = await sandbox(t);
  await desktopEntries(box.root, { ampleFile: false });
  const environment = handlerEnvironment(box, fakeXdgMime(box).run);
  const status = await openFoldersByDefaultStatus(environment);
  assert.equal(status.state, "unavailable");
  assert.match(status.reason ?? "", /desktop entry \(amplefile-desktop\.desktop\) isn't installed/);
  await assert.rejects(setOpenFoldersByDefault(environment), /isn't installed/);
  const noTools = handlerEnvironment(box, async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  assert.match((await openFoldersByDefaultStatus(noTools)).reason ?? "", /needs xdg-mime .* or gio/);
});

test("when the desktop ignores the change, AmpleFile says so and leaves things as they were", async (t) => {
  const box = await sandbox(t);
  await desktopEntries(box.root);
  const environment = handlerEnvironment(box, fakeXdgMime(box, { ignoreDefault: true }).run);
  await assert.rejects(setOpenFoldersByDefault(environment), /Folders still open with Files/);
  assert.equal((await openFoldersByDefaultStatus(environment)).state, "off");
  await assert.rejects(stat(environment.statePath), { code: "ENOENT" });
});

test("gio stands in when xdg-mime is missing", async (t) => {
  const box = await sandbox(t);
  await desktopEntries(box.root);
  const calls: string[][] = [];
  let current = "org.gnome.Nautilus.desktop";
  const environment = handlerEnvironment(box, async (command, args) => {
    calls.push([command, ...args]);
    if (command === "xdg-mime") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (args.length === 2) return `Default application for “inode/directory”: ${current}\nRegistered applications:\n\t${current}\n`;
    current = args[2]!;
    return "";
  });
  await setOpenFoldersByDefault(environment);
  assert.deepEqual(calls.filter(([command]) => command === "gio").map((call) => call.slice(1)), [["mime", "inode/directory"], ["mime", "inode/directory", "amplefile-desktop.desktop"], ["mime", "inode/directory"]]);
  assert.equal((await openFoldersByDefaultStatus(environment)).state, "on");
});

const xdgMimeAvailable = process.platform === "linux" && spawnSync("sh", ["-c", "command -v xdg-mime"]).status === 0;

test("with the real xdg-mime: on and off against a fake XDG_CONFIG_HOME restore mimeapps.list exactly", { skip: !xdgMimeAvailable }, async (t) => {
  const box = await sandbox(t);
  await desktopEntries(box.root);
  const environment = handlerEnvironment(box);
  await mkdir(join(box.root, "config"), { recursive: true });
  const before = "[Default Applications]\ntext/html=google-chrome.desktop\n\n[Added Associations]\n";
  await writeFile(userMimeappsPath(box), before);
  assert.equal((await openFoldersByDefaultStatus(environment)).current, "Files");
  await setOpenFoldersByDefault(environment);
  assert.match(await readFile(userMimeappsPath(box), "utf8"), /^inode\/directory=amplefile-desktop\.desktop$/m);
  assert.deepEqual(await openFoldersByDefaultStatus(environment), { state: "on", current: "AmpleFile", previous: "Files", reason: null });
  await unsetOpenFoldersByDefault(environment);
  assert.equal(await readFile(userMimeappsPath(box), "utf8"), before);
  assert.equal((await openFoldersByDefaultStatus(environment)).current, "Files");
});

// ---------------------------------------------------------------------------
// The whole choice

function fakeService(initial: FileManagerServiceState = { kind: "stopped" }) {
  let state: FileManagerServiceState = initial;
  const service = {
    starts: 0,
    stops: 0,
    current: () => state,
    busConnection: () => null,
    start: async () => { service.starts += 1; if (state.kind === "stopped") state = { kind: "owner" }; return state; },
    stop: async () => { service.stops += 1; state = { kind: "stopped" }; },
    set: (next: FileManagerServiceState) => { state = next; },
  };
  return service;
}

test("Settings status reads the system: off, on, waiting, elsewhere, and the file it would give back to", async (t) => {
  const box = await sandbox(t);
  await desktopEntries(box.root);
  const services = join(box.root, "system", "dbus-1", "services");
  await mkdir(services, { recursive: true });
  await writeFile(join(services, "org.freedesktop.FileManager1.service"), "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=/usr/bin/nautilus --gapplication-service\n");
  const service = fakeService();
  // No bus in the sandbox: ReloadConfig fails quietly and is logged.
  const logs: string[] = [];
  const integration = new LinuxFileManagerIntegration({
    environment: { ...handlerEnvironment(box, fakeXdgMime(box).run), env: { ...box.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/amplefile-bus" } },
    onRequest: () => {},
    service: service as unknown as FileManagerService,
    log: (message) => logs.push(message),
  });

  let status = await integration.status();
  assert.deepEqual(status.showFilesFromOtherApps, { state: "off", reason: null, replaced: null, systemFileManager: "Files" });
  assert.equal(service.starts, 0);

  status = await integration.setShowFilesFromOtherApps(true);
  assert.deepEqual(status.showFilesFromOtherApps, { state: "on", reason: null, replaced: null, systemFileManager: "Files" });
  assert.match(logs.join("\n"), /reload its service files/);

  service.set({ kind: "queued", currentOwner: "nautilus" });
  assert.deepEqual((await integration.status()).showFilesFromOtherApps, { state: "waiting", reason: "nautilus is answering for now. AmpleFile takes over when it closes.", replaced: null, systemFileManager: "Files" });
  service.set({ kind: "unavailable", reason: "No session bus is available." });
  assert.equal((await integration.status()).showFilesFromOtherApps.state, "unavailable");

  status = await integration.setShowFilesFromOtherApps(false);
  assert.equal(status.showFilesFromOtherApps.state, "off");
  assert.equal(service.stops, 1);
  await assert.rejects(stat(fileManagerServiceFilePath(box)), { code: "ENOENT" });

  // Another copy of AmpleFile wrote it.
  await writeFileManagerServiceFile({ ...box, launchCommand: ["/elsewhere/AmpleFile.AppImage"] });
  status = await integration.status();
  assert.equal(status.showFilesFromOtherApps.state, "elsewhere");
  assert.match(status.showFilesFromOtherApps.reason ?? "", /another copy of AmpleFile \(\/elsewhere\/AmpleFile\.AppImage\)/);

  // At startup only this copy's own file starts the service.
  const fresh = fakeService();
  const startup = new LinuxFileManagerIntegration({ environment: handlerEnvironment(box), onRequest: () => {}, service: fresh as unknown as FileManagerService });
  await startup.startIfChosen();
  assert.equal(fresh.starts, 0);
  await writeFileManagerServiceFile(box);
  await startup.startIfChosen();
  assert.equal(fresh.starts, 1);

  // Replacing the person's own file names it as what comes back.
  await rm(fileManagerServiceFilePath(box));
  await writeFile(fileManagerServiceFilePath(box), "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=/home/me/.local/bin/thinkpad-files --gapplication-service\n");
  assert.deepEqual((await integration.status()).showFilesFromOtherApps, { state: "off", reason: null, replaced: null, systemFileManager: "thinkpad-files" });
  status = await integration.setShowFilesFromOtherApps(true);
  assert.equal(status.showFilesFromOtherApps.replaced, "thinkpad-files");

  status = await integration.setOpenFoldersByDefault(true);
  assert.equal(status.openFoldersByDefault.state, "on");
  status = await integration.setOpenFoldersByDefault(false);
  assert.equal(status.openFoldersByDefault.state, "off");
});
