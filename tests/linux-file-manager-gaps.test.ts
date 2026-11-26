import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";

import { linuxTerminalLaunchPlan } from "../desktop/src/linux-open-terminal.js";
import { openFolderInTerminal } from "../desktop/src/open-terminal.js";
import { parseLinuxMountableVolumes } from "../src/local/linux-mountable-volumes.js";
import { startLocalApi } from "../src/local/server.js";
import { listMountableVolumes, mountListedLinuxVolume, type ToolRunner } from "../src/local/volumes.js";
import { createFileManagerHarness } from "./support/file-manager.js";

async function scratch(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "amplefile-linux-file-manager-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("Open Terminal Here prefers the desktop selection, then TERMINAL, then installed terminals", { skip: process.platform !== "linux" }, async (t) => {
  const root = await scratch(t);
  const folder = join(root, "Photos & notes");
  const xdg = join(root, "xdg-terminal-exec");
  const ghostty = join(root, "ghostty");
  const custom = join(root, "my terminal");
  const env = { PATH: root, TERMINAL: custom, ELECTRON_RUN_AS_NODE: "1" };
  await mkdir(folder);
  for (const tool of [ghostty, custom]) await writeFile(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(xdg, "#!/bin/sh\necho ghostty.desktop\n", { mode: 0o755 });
  const plan = await linuxTerminalLaunchPlan(folder, env);
  assert.equal(plan.command, xdg);
  assert.deepEqual(plan.args, [`--dir=${folder}`]);
  assert.equal(plan.cwd, folder);
  assert.equal(plan.env.ELECTRON_RUN_AS_NODE, undefined);
  await writeFile(xdg, "#!/bin/sh\nexit 1\n");
  assert.equal((await linuxTerminalLaunchPlan(folder, env)).command, custom);
  const configured = await linuxTerminalLaunchPlan(folder, { ...env, TERMINAL: `"${custom}" --title 'Work $here'` });
  assert.equal(configured.command, custom);
  assert.deepEqual(configured.args, ["--title", "Work $here"]);
  assert.equal(configured.cwd, folder);
  await rm(custom);
  const fallback = await linuxTerminalLaunchPlan(folder, env);
  assert.equal(fallback.command, ghostty);
  assert.deepEqual(fallback.args, [`--working-directory=${folder}`]);
  await assert.rejects(linuxTerminalLaunchPlan("../Photos", env), /Choose a folder/);
});

test("Open Terminal Here checks the folder again after an asynchronous terminal lookup", async (t) => {
  const root = await scratch(t);
  const folder = join(root, "Notes");
  await mkdir(folder);
  let launched = false;
  await assert.rejects(openFolderInTerminal({
    resolveFolder: async () => folder,
    launchPlan: async (path) => {
      await rename(path, join(root, "Old Notes"));
      await mkdir(path);
      return { kind: "spawn", command: "terminal", args: [], cwd: path };
    },
    launch: async () => { launched = true; },
  }), /That folder changed/);
  assert.equal(launched, false);
});

test("Linux Info reads file and link metadata on request under the place's path policy", { skip: process.platform !== "linux" }, async (t) => {
  const root = await scratch(t);
  await writeFile(join(root, "file.txt"), "data");
  await chmod(join(root, "file.txt"), 0o640);
  await symlink(join(root, "file.txt"), join(root, "link"));
  await symlink(root, join(root, "linked-folder"));
  await mkdir(join(root, ".pi"));
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "content"), loadEnv: false });
  t.after(() => api.close());
  const details = (path: string) => fetch(`${api.origin}/api/standard-folders/computer/entry-details?path=${encodeURIComponent(`${root.slice(1)}/${path}`)}`);
  const response = await details("file.txt");
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.permissions, "rw-r----- (0640)");
  assert.ok(info.owner && info.group && info.modifiedAt);
  assert.ok(info.createdAt === null || Number.isFinite(Date.parse(info.createdAt)));
  assert.equal((await (await details("link")).json()).permissions, "rwxrwxrwx (0777)");
  for (const path of ["linked-folder/file.txt", ".pi", "../outside"]) assert.equal((await details(path)).status, 400);
});

const partition = (name: string, props: Record<string, unknown> = {}) => ({ type: "part", name: `/dev/${name}`, "maj:min": "8:17", fstype: "vfat", mountpoints: [null], ...props });
const disk = (name: string, children: unknown[], props: Record<string, unknown> = {}) => ({ type: "disk", name: `/dev/${name}`, children, ...props });
const blockDevices = (...blockdevices: unknown[]) => JSON.stringify({ blockdevices });

test("Linux offers ordinary filesystems on external disks and rechecks the opaque id before mounting", async () => {
  const photos = partition("sdb1", { label: "Photo Drive", uuid: "1234-5678" });
  let inventory = blockDevices(
    disk("sda", [partition("sda2", { mountpoints: ["/"] }), partition("sda3")], { hotplug: true }),
    disk("sdb", [photos, partition("sdb2", { fstype: "crypto_LUKS" }), partition("sdb3", { mountpoints: ["/mnt/other"] })], { tran: "usb" }),
    disk("sdc", [partition("sdc1")]),
    { type: "loop", name: "/dev/loop0", rm: true, fstype: "vfat", "maj:min": "7:0" },
  );
  assert.deepEqual(parseLinuxMountableVolumes(inventory).map((item) => item.device), ["/dev/sdb1"]);
  const commands: string[][] = [];
  const run: ToolRunner = async ({ command, args }) => {
    commands.push([command, ...args]);
    return { code: 0, stdout: command === "lsblk" ? inventory : "the mount path is verified in mountinfo", stderr: "" };
  };
  const listed = await listMountableVolumes(run, "linux");
  const item = listed[0]!;
  assert.deepEqual(Object.keys(item).sort(), ["id", "name"]);
  assert.equal(item.name, "Photo Drive");
  await assert.rejects(mountListedLinuxVolume("volume-00000000000000000000", run), /isn’t available/);
  assert.ok(commands.every(([command]) => command === "lsblk"));
  const readMounts = async () => "21 1 8:1 / / rw - ext4 /dev/sda1 rw\n22 21 8:17 / /mnt/Photo\\040Drive rw - vfat /dev/sdb1 rw";
  assert.deepEqual(await mountListedLinuxVolume(item.id, run, readMounts), { mountPath: "/mnt/Photo Drive" });
  assert.deepEqual(commands.at(-1), ["udisksctl", "mount", "--no-user-interaction", "--block-device", "/dev/sdb1"]);
  inventory = blockDevices(disk("sdb", [{ ...photos, uuid: "8765-4321" }], { tran: "usb" }));
  await assert.rejects(mountListedLinuxVolume(item.id, run), /isn’t available/);
  assert.equal(commands.filter(([command]) => command === "udisksctl").length, 1);
});

test("Linux menus omit external reveal without querying settings, offer Terminal, and open a drive after mounting", async (t) => {
  let statusCalls = 0;
  const opened: unknown[] = [];
  const { dom, module, requests } = await createFileManagerHarness(t, (path) => {
    if (path === "/api/volumes") return { volumes: [], mountable: [{ id: "volume-test", name: "Photo Drive" }] };
    if (path === "/api/volumes/mount") return { mountPath: "/mnt/Photo Drive" };
    if (path === "/api/standard-folders") return { folders: [{ id: "home", name: "Home", root: "/home/ana", connectedFolderId: null }] };
    if (path === "/api/standard-folders/home/entry-details?path=Notes") return { createdAt: "2026-11-20T15:00:00Z", modifiedAt: "2026-11-20T15:00:00Z", permissions: "rwx------ (0700)", owner: "ana", group: "staff" };
    if (path.startsWith("/api/standard-folders/home/tree")) return { tree: [{ kind: "folder", name: "Notes", path: "Notes" }] };
    if (path.startsWith("/api/standard-folders/computer/tree")) return { tree: [] };
    return undefined;
  });
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = {
    app: { platform: "linux" }, connectedFolder: {},
    fileManagerIntegration: { status: () => { statusCalls += 1; return Promise.resolve(null); } },
    openTerminal: async (where: unknown) => { opened.push(where); },
  };
  t.after(() => { delete scope.ampleFileDesktop; });
  const props = {
    connectedFolder: null, connectedFolders: [], agent: { ready: true, configured: false } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  };
  await dom.render(createElement(module.FileManagerView, props));
  const notes = () => dom.container.querySelector('[data-fm-path="Notes"]');
  const menu = () => [...dom.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const rightClick = (element: Element) => dom.act(() => { element.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await dom.waitFor(() => Boolean(notes()));
  assert.ok(!requests.some(({ path }) => path.includes("entry-details")));
  await rightClick(notes()!);
  await dom.waitFor(() => menu().some((item) => item.textContent === "Open Terminal Here"));
  assert.ok(!menu().some((item) => item.textContent === "Show in File Manager"));
  await dom.waitFor(() => dom.container.querySelector(".fm-panel")?.textContent?.includes("Permissionsrwx------ (0700)") === true);
  assert.match(dom.container.querySelector(".fm-panel")?.textContent ?? "", /Created.*OwneranaGroupstaff/);
  await dom.act(() => { menu().find((item) => item.textContent === "Open Terminal Here")!.click(); });
  assert.deepEqual(opened, [{ place: { kind: "standard", id: "home" }, path: "Notes" }]);
  const background = () => dom.container.querySelector(".fm-content")!;
  await rightClick(background());
  await dom.waitFor(() => menu().length > 0);
  assert.ok(menu().some((item) => item.textContent === "Open Terminal Here"));
  assert.ok(!menu().some((item) => item.textContent === "Show in File Manager"));
  await dom.act(() => { (dom.container.querySelector(".fm-menu-back") as HTMLElement).click(); });
  await rightClick(dom.container.querySelector('.fm-sidebar-item[aria-current="page"]')!);
  await dom.waitFor(() => menu().length > 0);
  assert.ok(!menu().some((item) => item.textContent === "Show in File Manager"));
  await dom.act(() => { (dom.container.querySelector(".fm-menu-back") as HTMLElement).click(); });
  assert.equal(statusCalls, 0);
  await dom.render(createElement(module.FileManagerView, { ...props, desktopAction: { id: 1, command: "open-terminal" } }));
  await dom.waitFor(() => opened.length === 2);
  assert.deepEqual(opened[1], { place: { kind: "standard", id: "home" }, path: "" });
  const mount = dom.container.querySelector<HTMLButtonElement>('[aria-label="Mount Photo Drive"]');
  assert.ok(Boolean(mount));
  await dom.act(() => { mount!.click(); });
  await dom.waitFor(() => requests.some((request) => request.path.includes("path=mnt%2FPhoto+Drive")));
  assert.deepEqual(requests.find((request) => request.path === "/api/volumes/mount")?.body, { volumeId: "volume-test" });
});

test("Get Info opens the panel at Info for an item, from its menu and from the File menu, even with the panel hidden", async (t) => {
  const { dom, module } = await createFileManagerHarness(t, (path) => {
    if (path === "/api/volumes") return { volumes: [], mountable: [] };
    if (path === "/api/standard-folders") return { folders: [{ id: "home", name: "Home", root: "/home/ana", connectedFolderId: null }] };
    if (path.startsWith("/api/standard-folders/home/entry-details")) return { createdAt: null, modifiedAt: "2026-11-20T15:00:00Z", permissions: "rw-r--r-- (0644)", owner: "ana", group: "staff" };
    if (path.startsWith("/api/standard-folders/home/tree")) return { tree: [{ kind: "file", name: "plan.txt", path: "plan.txt", sizeBytes: 12 }, { kind: "file", name: "other.txt", path: "other.txt", sizeBytes: 3 }] };
    if (path.startsWith("/api/standard-folders/computer/tree")) return { tree: [] };
    return undefined;
  });
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = { app: { platform: "linux" }, connectedFolder: {} };
  t.after(() => { delete scope.ampleFileDesktop; });
  const props = {
    connectedFolder: null, connectedFolders: [], agent: { ready: true, configured: false } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  };
  await dom.render(createElement(module.FileManagerView, props));
  const row = (name: string) => dom.container.querySelector(`[data-fm-path="${name}"]`);
  const panel = () => dom.container.querySelector(".fm-panel");
  const menu = () => [...dom.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const rightClick = (element: Element) => dom.act(() => { element.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await dom.waitFor(() => Boolean(row("plan.txt")));

  // With the panel hidden there is nowhere for Info to show, so Get Info brings it back.
  await dom.act(() => { dom.container.querySelector<HTMLButtonElement>('[aria-label="Show or hide the panel"]')!.click(); });
  assert.equal(panel(), null);
  await rightClick(row("plan.txt")!);
  await dom.waitFor(() => menu().some((item) => item.textContent === "Get Info"));
  await dom.act(() => { menu().find((item) => item.textContent === "Get Info")!.click(); });
  await dom.waitFor(() => (panel()?.textContent ?? "").includes("plan.txt"));
  assert.match(panel()!.textContent!, /Permissionsrw-r--r-- \(0644\)/);

  // The folder background's Get Info is the folder shown.
  await rightClick(dom.container.querySelector(".fm-content")!);
  await dom.waitFor(() => menu().some((item) => item.textContent === "Get Info"));
  await dom.act(() => { menu().find((item) => item.textContent === "Get Info")!.click(); });
  await dom.waitFor(() => !(panel()?.textContent ?? "").includes("plan.txt"));
  assert.equal(dom.container.querySelectorAll(".fm-row.is-selected, [aria-selected='true'][data-fm-path]").length, 0);

  // The File menu's Get Info (Ctrl+I) is for the selection as it stands, with the panel hidden again.
  await dom.act(() => { (row("other.txt") as HTMLElement).click(); });
  await dom.act(() => { dom.container.querySelector<HTMLButtonElement>('[aria-label="Show or hide the panel"]')!.click(); });
  assert.equal(panel(), null);
  // Behind a dialog it does nothing: the panel stays hidden.
  const dialog = window.document.createElement("div");
  dialog.setAttribute("role", "dialog");
  window.document.body.append(dialog);
  await dom.render(createElement(module.FileManagerView, { ...props, desktopAction: { id: 2, command: "get-info" } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(panel(), null);
  dialog.remove();
  await dom.render(createElement(module.FileManagerView, { ...props, desktopAction: { id: 3, command: "get-info" } }));
  await dom.waitFor(() => (panel()?.textContent ?? "").includes("other.txt"));
});
