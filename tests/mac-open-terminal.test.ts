import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";

import { nativeConnectedFolderMenuItems, parseNativeConnectedFolderMenuRequest } from "../desktop/src/connected-folder-context-menu.js";
import { nativeFileMenuItems, parseNativeFileMenuRequest } from "../desktop/src/file-context-menu.js";
import { macTerminalBundleId, macTerminalLaunchPlan } from "../desktop/src/open-terminal.js";
import { createFileManagerHarness } from "./support/file-manager.js";

const point = { x: 4, y: 8 };
const folderCapabilities = { open: true, attach: false, history: true, upload: true, rename: true, delete: true, newTab: true };
const commands = (items: ReturnType<typeof nativeFileMenuItems>) => items.map((item) => item.type === "separator" ? "-" : item.command);

test("Open Terminal Here hands the folder to Terminal through open, never a shell", () => {
  assert.equal(macTerminalBundleId, "com.apple.Terminal");
  assert.deepEqual(macTerminalLaunchPlan("/Users/ana/Projects/Notes & ideas"), {
    kind: "exec", command: "/usr/bin/open", args: ["-b", "com.apple.Terminal", "/Users/ana/Projects/Notes & ideas"],
  });
  assert.throws(() => macTerminalLaunchPlan("Projects"), /Choose a folder/);
  assert.throws(() => macTerminalLaunchPlan("/Users/ana/\0Projects"), /Choose a folder/);
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
  // The folder is checked as a directory, then again, by identity, just before Terminal is asked to open it.
  assert.match(main, /const plan = macTerminalLaunchPlan\(folder\);\n\s*const current = await resolveFolder\(\) === folder \? await lstat\(folder\) : null;/);
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
