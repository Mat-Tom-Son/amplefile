import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";

import { nativeConnectedFolderMenuItems, parseNativeConnectedFolderMenuRequest } from "../desktop/src/connected-folder-context-menu.js";
import { nativeFileMenuItems, parseNativeFileMenuRequest } from "../desktop/src/file-context-menu.js";
import { macTerminalBundleId, macTerminalLaunchPlan, openFolderInTerminal } from "../desktop/src/open-terminal.js";
import { resolveConnectedFolderPath } from "../src/local/connected-folder.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";
import { createFileManagerHarness } from "./support/file-manager.js";

const point = { x: 4, y: 8 };
const folderCapabilities = { open: true, attach: false, history: true, upload: true, rename: true, delete: true, newTab: true };
const commands = (items: ReturnType<typeof nativeFileMenuItems>) => items.map((item) => item.type === "separator" ? "-" : item.command);

test("Open Terminal Here hands Terminal the folder through open, never a shell, as a path only a folder satisfies", () => {
  assert.equal(macTerminalBundleId, "com.apple.Terminal");
  // The trailing slash: Terminal runs an executable or a .command file it is handed, and a file cannot end in "/".
  assert.deepEqual(macTerminalLaunchPlan("/Users/ana/Projects/Notes & ideas"), {
    kind: "exec", command: "/usr/bin/open", args: ["-b", "com.apple.Terminal", "/Users/ana/Projects/Notes & ideas/"],
  });
  assert.deepEqual(macTerminalLaunchPlan("/").args, ["-b", "com.apple.Terminal", "/"]);
  assert.throws(() => macTerminalLaunchPlan("Projects"), /Choose a folder/);
  assert.throws(() => macTerminalLaunchPlan("/Users/ana/\0Projects"), /Choose a folder/);
});

test("the host opens only a folder that is still the same folder, under the place's path policy", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amplefile-open-terminal-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Notes"));
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, "notes.txt"), "x");
  await symlink(join(root, "Notes"), join(root, "Notes link"));
  const plans: unknown[] = [];
  const launch = async (plan: unknown) => { plans.push(plan); };
  const inPlace = (path: string) => ({ resolveFolder: async () => resolveConnectedFolderPath(root, path), launch });

  await openFolderInTerminal(inPlace("Notes"));
  assert.deepEqual(plans, [{ kind: "exec", command: "/usr/bin/open", args: ["-b", "com.apple.Terminal", `${join(root, "Notes")}/`] }]);
  // The place's path policy refuses before anything is checked or opened.
  for (const refused of ["../Notes", ".pi", "Notes link"]) await assert.rejects(openFolderInTerminal(inPlace(refused)));
  // A file, a missing folder, and a link handed over directly are not folders.
  await assert.rejects(openFolderInTerminal(inPlace("notes.txt")), /Choose a folder/);
  await assert.rejects(openFolderInTerminal(inPlace("Gone")), /Choose a folder/);
  await assert.rejects(openFolderInTerminal({ resolveFolder: async () => join(root, "Notes link"), launch }), /Choose a folder/);
  await assert.rejects(openFolderInTerminal({ resolveFolder: async () => null, launch }), /Choose a folder/);
  // A folder replaced by another of the same name between the two checks is refused.
  let asked = 0;
  await assert.rejects(openFolderInTerminal({
    resolveFolder: async () => {
      asked += 1;
      if (asked === 2) { await rename(join(root, "Notes"), join(root, "Notes old")); await mkdir(join(root, "Notes")); }
      return join(root, "Notes");
    },
    launch,
  }), /That folder changed/);
  assert.equal(plans.length, 1);
  // A launch that fails says so plainly, without the command line.
  await assert.rejects(openFolderInTerminal({ resolveFolder: async () => join(root, "Notes"), launch: async () => { throw new Error("Command failed: /usr/bin/open -b com.apple.Terminal /secret/path"); } }), /^Error: AmpleFile couldn’t open Terminal\.$/);
});

test("a folder's native menu on a Mac offers Open Terminal Here before Show in Finder; a file or a package does not", () => {
  const folder = parseNativeFileMenuRequest({ connectedFolderId: "lab", path: "Notes", kind: "folder", capabilities: { ...folderCapabilities, terminal: true }, point });
  assert.equal(folder.capabilities.terminal, true);
  const items = commands(nativeFileMenuItems(folder, "darwin"));
  assert.ok(items.indexOf("open-terminal") >= 0 && items.indexOf("open-terminal") === items.indexOf("reveal") - 1);
  assert.ok(nativeFileMenuItems(folder, "darwin").some((item) => item.type === "item" && item.label === "Open Terminal Here"));
  // The folder background is the folder shown.
  const background = parseNativeFileMenuRequest({ connectedFolderId: "lab", path: "", kind: "folder", capabilities: { ...folderCapabilities, terminal: true }, point });
  assert.ok(commands(nativeFileMenuItems(background, "darwin")).includes("open-terminal"));
  // Without the capability (an older window, or the browser preview) the item is not there.
  const plain = parseNativeFileMenuRequest({ connectedFolderId: "lab", path: "Notes", kind: "folder", capabilities: folderCapabilities, point });
  assert.ok(!commands(nativeFileMenuItems(plain, "darwin")).includes("open-terminal"));
  const file = parseNativeFileMenuRequest({ connectedFolderId: "lab", path: "Notes/a.txt", kind: "file", capabilities: { ...folderCapabilities, terminal: true }, point });
  assert.ok(!commands(nativeFileMenuItems(file, "darwin")).includes("open-terminal"));
  const app = parseNativeFileMenuRequest({ connectedFolderId: "lab", path: "Apps/Sketch.app", kind: "folder", capabilities: { ...folderCapabilities, package: true, terminal: true }, point });
  assert.ok(!commands(nativeFileMenuItems(app, "darwin")).includes("open-terminal"));
  // Windows has no terminal launch.
  assert.ok(!commands(nativeFileMenuItems(folder, "win32")).includes("open-terminal"));
  assert.throws(() => parseNativeFileMenuRequest({ connectedFolderId: "lab", path: "Notes", kind: "folder", capabilities: { ...folderCapabilities, terminal: "yes" }, point }), /capabilities are invalid/);
});

test("the sidebar's native menus offer Open Terminal Here when the window asks for it", () => {
  const request = parseNativeConnectedFolderMenuRequest({
    actions: { openInNewTab: true, newChat: false, customize: true, organize: true, reveal: true, openTerminal: true, skills: true, settings: true, manage: false },
    point,
  });
  assert.equal(request.actions.openTerminal, true);
  assert.deepEqual(nativeConnectedFolderMenuItems(request).filter((item) => item.type === "item").map((item) => item.label).slice(0, 6), [
    "Open in New Tab", "Customize Connected Folder", "Organize", "Open Terminal Here", "Show in Finder", "Skills & Extensions…",
  ]);
  const without = parseNativeConnectedFolderMenuRequest({ actions: { newChat: false, customize: false, organize: false, reveal: true }, point });
  assert.ok(!nativeConnectedFolderMenuItems(without).some((item) => item.type === "item" && item.command === "open-terminal"));
  assert.throws(() => parseNativeConnectedFolderMenuRequest({ actions: { newChat: false, customize: false, organize: false, reveal: true, openTerminal: "yes" }, point }), /invalid/);
});

test("the Mac host registers the handler, exposes it, and lists it in the File menu", async () => {
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  const preload = await readFile(new URL("../desktop/src/preload.cts", import.meta.url), "utf8");
  assert.match(main, /if \(process\.platform === "darwin"\) \{\n\s*ipcMain\.handle\("amplefile:place:open-terminal", async \(event, value: unknown\) => \{\n\s*assertTrustedMainRenderer\(event\);/);
  // The checks live in openFolderInTerminal (tested above), with the places' own path policies as its resolver.
  assert.match(main, /await openFolderInTerminal\(\{\n\s*resolveFolder: async \(\) => place\.kind === "connected-folder"\n\s*\? resolveConnectedFolderPath\(\(await getConnectedFolder\(place\.id\)\)\.connectedFolderRoot, path\)\n\s*: isStandardFolderId\(place\.id\) \? resolveStandardFolderPath\(place\.id, path\) : null,\n\s*launch: launchOpenWith,/);
  assert.match(main, /\{ id: "open-terminal", label: "Open Terminal Here", enabled: state\.terminalFolderOpen === true, click: menuCommand\("open-terminal"\) \}/);
  assert.match(main, /setMenuItemEnabled\(menu, "open-terminal", state\.terminalFolderOpen === true\);/);
  assert.match(preload, /\.\.\.\(process\.platform === "darwin" \? \{\n\s*openTerminal: \(location: Pick<WindowLocation, "place" \| "path">\) => ipcRenderer\.invoke\("amplefile:place:open-terminal", location\),/);
});

test("on a Mac the window offers Open Terminal Here in a folder's menu, the sidebar's menu, and the File menu", async (t) => {
  const opened: unknown[] = [];
  const fileMenus: Array<{ path: string; capabilities: Record<string, unknown> }> = [];
  const headerMenus: Array<{ actions: Record<string, unknown> }> = [];
  const menuStates: Array<Record<string, unknown>> = [];
  const { dom, module } = await createFileManagerHarness(t, (path) => {
    if (path === "/api/volumes") return { volumes: [] };
    if (path === "/api/standard-folders") return { folders: [{ id: "home", name: "ana", root: "/Users/ana", connectedFolderId: null }] };
    if (path.startsWith("/api/standard-folders/home/tree")) return { tree: [{ kind: "folder", name: "Notes", path: "Notes" }, { kind: "file", name: "a.txt", path: "a.txt", sizeBytes: 1 }] };
    if (path.startsWith("/api/standard-folders/computer/tree")) return { tree: [] };
    return undefined;
  });
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = {
    app: { platform: "darwin" },
    connectedFolder: {
      popupFileMenu: async (request: { path: string; capabilities: Record<string, unknown> }) => { fileMenus.push(request); return "open-terminal"; },
      popupHeaderMenu: async (request: { actions: Record<string, unknown> }) => { headerMenus.push(request); return "open-terminal"; },
    },
    menu: { setState: (state: Record<string, unknown>) => { menuStates.push(state); } },
    openTerminal: async (where: unknown) => { opened.push(where); },
  };
  t.after(() => { delete scope.ampleFileDesktop; });
  const props = {
    connectedFolder: null, connectedFolders: [], agent: { ready: true, configured: false } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  };
  await dom.render(createElement(module.FileManagerView, props));
  const row = (name: string) => dom.container.querySelector(`[data-fm-path="${name}"]`);
  const rightClick = (element: Element) => dom.act(() => { element.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await dom.waitFor(() => Boolean(row("Notes")));
  // The File menu's item is enabled while a folder is shown.
  await dom.waitFor(() => menuStates.some((state) => state.terminalFolderOpen === true));

  // A folder's menu asks the native menu for the item and opens that folder.
  await rightClick(row("Notes")!);
  await dom.waitFor(() => opened.length === 1);
  assert.equal(fileMenus.at(-1)?.capabilities.terminal, true);
  assert.deepEqual(opened[0], { place: { kind: "standard", id: "home" }, path: "Notes" });

  // A Standard Folder's sidebar menu opens the Standard Folder itself.
  await rightClick(dom.container.querySelector('.fm-sidebar-item[aria-current="page"]')!);
  await dom.waitFor(() => opened.length === 2);
  assert.equal(headerMenus.at(-1)?.actions.openTerminal, true);
  assert.deepEqual(opened[1], { place: { kind: "standard", id: "home" }, path: "" });

  // File → Open Terminal Here opens the folder shown.
  await dom.render(createElement(module.FileManagerView, { ...props, desktopAction: { id: 1, command: "open-terminal" } }));
  await dom.waitFor(() => opened.length === 3);
  assert.deepEqual(opened[2], { place: { kind: "standard", id: "home" }, path: "" });
});

test("on a Mac a Connected Folder's sidebar menu offers it, the toolbar's Action menu and Recents do not", async (t) => {
  const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
  const opened: unknown[] = [];
  const fileMenus: Array<{ path: string; capabilities: Record<string, unknown> }> = [];
  const headerMenus: Array<{ actions: Record<string, unknown> }> = [];
  let headerAnswer: string | null = "open-terminal";
  const { dom, module } = await createFileManagerHarness(t, (path, options) => {
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true, provider: "test", model: "synthetic" } };
    if (path.startsWith("/api/agent/composer")) return { composer: null };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path === "/api/volumes") return { volumes: [] };
    if (path === "/api/recents") return { recents: [] };
    if (path.includes("/tree")) return { tree: [{ kind: "folder", name: "Notes", path: "Notes" }] };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations") && options.method !== "POST") return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    if (path.includes("/file-info")) return { modifiedAt: "2026-09-27T12:00:00Z" };
    return undefined;
  });
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = {
    app: { platform: "darwin" },
    connectedFolder: {
      popupFileMenu: async (request: { path: string; capabilities: Record<string, unknown> }) => { fileMenus.push(request); return null; },
      popupHeaderMenu: async (request: { actions: Record<string, unknown> }) => { headerMenus.push(request); return headerAnswer; },
    },
    menu: { setState() {} },
    openTerminal: async (where: unknown) => { opened.push(where); },
  };
  t.after(() => { delete scope.ampleFileDesktop; });
  const props = {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  };
  await dom.render(createElement(module.FileManagerView, props));
  const rightClick = (element: Element) => dom.act(() => { element.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await dom.waitFor(() => Boolean(dom.container.querySelector('[data-fm-path="Notes"]')));

  // The sidebar's menu for the Connected Folder opens its top.
  const sidebarRow = [...dom.container.querySelectorAll(".fm-sidebar-item")].find((item) => item.textContent?.includes("Lab"))!;
  await rightClick(sidebarRow);
  await dom.waitFor(() => opened.length === 1);
  assert.equal(headerMenus.at(-1)?.actions.openTerminal, true);
  assert.deepEqual(opened[0], { place: { kind: "connected-folder", id: "lab" }, path: "" });

  // The toolbar's Action menu does not offer it: File has it for the folder shown.
  headerAnswer = null;
  await dom.act(() => { dom.container.querySelector<HTMLButtonElement>('[aria-label="Action"]')!.click(); });
  await dom.waitFor(() => headerMenus.length === 2);
  assert.equal(headerMenus[1]!.actions.openTerminal, undefined);

  // In Recents the background menu stands for no folder the person can see, so it does not offer it.
  await dom.act(() => { dom.container.querySelector<HTMLButtonElement>(".fm-sidebar-top .fm-sidebar-item")!.click(); });
  await dom.waitFor(() => dom.container.querySelector('.fm-sidebar-top .fm-sidebar-item[aria-current="page"]') !== null);
  await rightClick(dom.container.querySelector(".fm-content")!);
  await dom.waitFor(() => fileMenus.length === 1);
  assert.equal(fileMenus[0]!.capabilities.terminal, undefined);
  assert.equal(opened.length, 1);
});
