import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { pageFateOnWindowClose } from "../desktop/src/browser-page-homes.js";
import { FileManagerWindows, ownerConnectedFolderId, parseWindowLocation } from "../desktop/src/file-manager-windows.js";
import {
  cascadeBounds,
  maximumRestoredWindows,
  parseWindowPlacements,
  placementsAfterClose,
  savePlacement,
  separateRestoredPlacements,
  serializeWindowPlacements,
  windowCascadeStep,
  type WindowPlacement,
} from "../desktop/src/window-placements.js";

const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const browserHost = await readFile(new URL("../desktop/src/built-in-browser.ts", import.meta.url), "utf8");
const preload = await readFile(new URL("../desktop/src/preload.cts", import.meta.url), "utf8");

class FakeWindow {
  destroyed = false;
  constructor(readonly id: number) {}
  isDestroyed(): boolean { return this.destroyed; }
}

/** The body of one function or handler in main.ts, up to its closing line. */
function section(source: string, start: string, end = "\n}\n"): string {
  const index = source.indexOf(start);
  assert.ok(index >= 0, `main.ts has ${start}`);
  return source.slice(index, source.indexOf(end, index) + end.length);
}

// ── The window registry ─────────────────────────────────────────────────────

test("the registry numbers windows with the smallest free slot and keeps them in focus order", () => {
  const windows = new FileManagerWindows<FakeWindow>();
  const one = new FakeWindow(11);
  const two = new FakeWindow(12);
  const three = new FakeWindow(13);
  assert.equal(windows.add(one).slot, 1);
  assert.equal(windows.add(two).slot, 2);
  assert.deepEqual(windows.windows(), [two, one], "the newest window is in front");
  windows.focus(one);
  assert.equal(windows.mostRecent()?.window, one);
  windows.remove(one);
  assert.equal(windows.add(three).slot, 1, "a closed window's slot is used again");
  assert.equal(windows.size, 2);
  two.destroyed = true;
  assert.deepEqual(windows.windows(), [three], "a destroyed window is never a target");
  assert.equal(windows.entry(two), null);
  assert.throws(() => windows.add(new FakeWindow(14), 1), /taken/);
  assert.equal(windows.add(new FakeWindow(15), 5).slot, 5, "a saved window keeps its slot");
});

test("a command goes to the window it was given in, else the front window; nothing else is a file manager window", () => {
  const windows = new FileManagerWindows<FakeWindow>();
  const one = new FakeWindow(1);
  const two = new FakeWindow(2);
  windows.add(one);
  windows.add(two);
  windows.focus(one);
  assert.equal(windows.target(two)?.window, two, "the menu used in a window, or the window that asked");
  assert.equal(windows.target(undefined)?.window, one, "no window given: the front one");
  assert.equal(windows.target({ id: 999 })?.window, one, "the popover or a browser pop-up is not a file manager window");
  assert.equal(windows.has({ id: 999 }), false);
  const empty = new FileManagerWindows<FakeWindow>();
  assert.equal(empty.target(undefined), null);
  assert.equal(empty.mostRecent(), null);
});

test("each window keeps its own menu state, and the application menu shows the front window's", () => {
  const windows = new FileManagerWindows<FakeWindow>();
  const one = new FakeWindow(1);
  const two = new FakeWindow(2);
  windows.add(one);
  windows.add(two);
  const closed = { folderTabsOpen: false, showTabBar: false };
  assert.deepEqual(windows.menuState(), { connectedFolderOpen: false, showHiddenFiles: false, ...closed });
  windows.updateMenuState(one, { connectedFolderOpen: true, showHiddenFiles: true, folderTabsOpen: true, showTabBar: true });
  assert.deepEqual(windows.menuState(), { connectedFolderOpen: false, showHiddenFiles: false, ...closed }, "window 2 is in front");
  windows.focus(one);
  assert.deepEqual(windows.menuState(), { connectedFolderOpen: true, showHiddenFiles: true, folderTabsOpen: true, showTabBar: true }, "each window's own folder tabs and Show Tab Bar");
  windows.updateMenuState(one, { showHiddenFiles: false, unknown: 1 });
  assert.deepEqual(windows.entry(one)?.menuState, { connectedFolderOpen: true, showHiddenFiles: false, folderTabsOpen: true, showTabBar: true }, "a key left out keeps its value");
  assert.equal(windows.updateMenuState({ id: 99 }, { connectedFolderOpen: true }), null);
  assert.equal(windows.updateMenuState(null, { connectedFolderOpen: true }), null);
});

test("a location handed to a window waits for that window's renderer alone, and is taken once", () => {
  const windows = new FileManagerWindows<FakeWindow, { path: string }>();
  const one = new FakeWindow(1);
  const two = new FakeWindow(2);
  windows.add(one);
  windows.add(two);
  assert.equal(windows.handOpenLocation(two, { token: "t-2", location: { path: "Projects" } }), true);
  assert.equal(windows.takeOpenLocation(one), null, "another window never takes it");
  windows.acknowledgeOpenLocation(one, "t-2");
  assert.deepEqual(windows.takeOpenLocation(two), { token: "t-2", location: { path: "Projects" } });
  assert.equal(windows.takeOpenLocation(two), null, "taken once");
  windows.handOpenLocation(one, { token: "t-1", location: { path: "Docs" } });
  windows.acknowledgeOpenLocation(one, "other");
  assert.notEqual(windows.entry(one)?.pendingOpenLocation, null, "only its own token clears it");
  windows.acknowledgeOpenLocation(one, "t-1");
  assert.equal(windows.entry(one)?.pendingOpenLocation, null);
  assert.equal(windows.handOpenLocation({ id: 42 }, { token: "x", location: { path: "" } }), false);
});

test("a Worker's window is the one showing its Connected Folder, else the front window", () => {
  const windows = new FileManagerWindows<FakeWindow>();
  const one = new FakeWindow(1);
  const two = new FakeWindow(2);
  const three = new FakeWindow(3);
  windows.add(one).connectedFolder = { id: "space-aaaa", name: "Quotes", connectedFolderRoot: "/q" };
  windows.add(two).connectedFolder = { id: "space-bbbb", name: "Receipts", connectedFolderRoot: "/r" };
  windows.add(three).connectedFolder = { id: "space-aaaa", name: "Quotes", connectedFolderRoot: "/q" };
  windows.focus(two);
  assert.equal(windows.workerWindow("space-aaaa/conversation-1")?.window, three, "the most recent window showing it");
  assert.equal(windows.workerWindow("space-bbbb/conversation-9")?.window, two);
  assert.equal(windows.workerWindow("space-cccc/conversation-1")?.window, two, "nobody shows it: the front window");
  assert.equal(windows.workerWindow(null)?.window, two, "the AmpleFile Agent or no owner: the front window");
  assert.equal(ownerConnectedFolderId("space-aaaa/conversation-1"), "space-aaaa");
  assert.equal(ownerConnectedFolderId("no-slash"), null);
  assert.equal(ownerConnectedFolderId("/leading"), null);
  assert.equal(ownerConnectedFolderId(undefined), null);
});

test("a location from a renderer is a place and a relative folder, never an absolute or escaping path", () => {
  assert.deepEqual(parseWindowLocation({ place: { kind: "standard", id: "documents" }, path: "Taxes/2026" }), { place: { kind: "standard", id: "documents" }, path: "Taxes/2026" });
  assert.deepEqual(parseWindowLocation({ place: { kind: "connected-folder", id: "space-1" }, path: "", select: "a.pdf" }), { place: { kind: "connected-folder", id: "space-1" }, path: "", select: "a.pdf" });
  for (const bad of [
    null, "Documents", [], { place: { kind: "standard", id: "documents" } },
    { place: { kind: "drive", id: "x" }, path: "" },
    { place: { kind: "standard", id: "" }, path: "" },
    { place: { kind: "standard", id: "documents" }, path: "/etc" },
    { place: { kind: "standard", id: "documents" }, path: "a/../../etc" },
    { place: { kind: "standard", id: "documents" }, path: "C:\\Windows" },
    { place: { kind: "standard", id: "documents" }, path: "a\0b" },
    { place: { kind: "standard", id: "documents" }, path: "", select: 3 },
  ]) assert.equal(parseWindowLocation(bad), null, JSON.stringify(bad));
});

// ── Where windows open and come back ────────────────────────────────────────

test("the one-window state file reads as window 1, and the list keeps one entry per slot", () => {
  assert.deepEqual(parseWindowPlacements({ x: 10.4, y: 20, width: 1440, height: 960, isMaximized: true }), [{ slot: 1, x: 10, y: 20, width: 1440, height: 960, isMaximized: true }]);
  assert.deepEqual(parseWindowPlacements({ windows: [
    { slot: 2, x: 5, y: 5, width: 100, height: 100 },
    { slot: 2, x: 9, y: 9, width: 100, height: 100 },
    { x: 1, y: 1, width: 100, height: 100 },
    { slot: 4, x: "no" },
  ] }), [
    { slot: 2, x: 5, y: 5, width: 100, height: 100, isMaximized: false },
    { slot: 3, x: 1, y: 1, width: 100, height: 100, isMaximized: false },
  ]);
  assert.deepEqual(parseWindowPlacements(null), []);
  assert.deepEqual(parseWindowPlacements({ x: 1 }), []);
  const many = { windows: Array.from({ length: 30 }, (_, index) => ({ slot: index + 1, x: 0, y: 0, width: 10, height: 10 })) };
  assert.equal(parseWindowPlacements(many).length, maximumRestoredWindows);
  const saved: WindowPlacement[] = [{ slot: 2, x: 1, y: 2, width: 3, height: 4, isMaximized: false }, { slot: 1, x: 5, y: 6, width: 7, height: 8, isMaximized: true }];
  assert.deepEqual(parseWindowPlacements(JSON.parse(serializeWindowPlacements(saved))), [...saved].sort((a, b) => a.slot - b.slot));
});

test("a window closed while others stay open is forgotten; the last one and every window at Quit come back", () => {
  const one: WindowPlacement = { slot: 1, x: 0, y: 0, width: 1200, height: 800, isMaximized: false };
  const two: WindowPlacement = { slot: 2, x: 28, y: 28, width: 1200, height: 800, isMaximized: false };
  const both = savePlacement(savePlacement([], two), one);
  assert.deepEqual(both.map((entry) => entry.slot), [1, 2]);
  assert.deepEqual(savePlacement(both, { ...two, x: 300 }).find((entry) => entry.slot === 2)?.x, 300, "a move replaces the slot's place");
  assert.deepEqual(placementsAfterClose(both, 2, { quitting: false, othersOpen: 1 }).map((entry) => entry.slot), [1], "one of several closed");
  assert.deepEqual(placementsAfterClose([one], 1, { quitting: false, othersOpen: 0 }).map((entry) => entry.slot), [1], "the last one keeps its place");
  assert.deepEqual(placementsAfterClose(both, 2, { quitting: true, othersOpen: 1 }).map((entry) => entry.slot), [1, 2], "Quit keeps every open window");
});

test("a new window opens a step from the window it came from, clear of every open window and on the screen", () => {
  const workArea = { x: 0, y: 0, width: 2000, height: 1200 };
  const minimum = { width: 1100, height: 760 };
  const from = { x: 100, y: 100, width: 1200, height: 800 };
  assert.deepEqual(cascadeBounds(from, [from], workArea, minimum), { x: 100 + windowCascadeStep, y: 100 + windowCascadeStep, width: 1200, height: 800 });
  const taken = [from, { ...from, x: 128, y: 128 }];
  assert.deepEqual(cascadeBounds(from, taken, workArea, minimum), { x: 156, y: 156, width: 1200, height: 800 }, "a place already taken is skipped");
  const corner = cascadeBounds({ x: 780, y: 380, width: 1200, height: 800 }, [], workArea, minimum);
  assert.ok(corner.x + corner.width <= 2000 && corner.y + corner.height <= 1200, "a step off the screen starts again at the top left");
  assert.deepEqual({ x: corner.x, y: corner.y }, { x: windowCascadeStep, y: windowCascadeStep });
  const restored = separateRestoredPlacements([
    { slot: 1, x: 100, y: 100, width: 1200, height: 800, isMaximized: false },
    { slot: 2, x: 100, y: 100, width: 1200, height: 800, isMaximized: false },
  ], () => workArea, minimum);
  assert.notDeepEqual({ x: restored[1]!.x, y: restored[1]!.y }, { x: 100, y: 100 }, "two saved windows never open exactly on top of each other");
  assert.equal(restored[1]!.slot, 2);
});

// ── Browser pages and windows ───────────────────────────────────────────────

test("a closing window's pages: a Worker's page moves, the person's closes, and with no window left every page waits unseen", () => {
  assert.equal(pageFateOnWindowClose({ openedBy: "agent", workerUsing: false }, 1), "move");
  assert.equal(pageFateOnWindowClose({ openedBy: "person", workerUsing: true }, 2), "move", "a Worker is using the person's page");
  assert.equal(pageFateOnWindowClose({ openedBy: "person", workerUsing: false }, 1), "close");
  assert.equal(pageFateOnWindowClose({ openedBy: "person", workerUsing: false }, 0), "keep-unseen", "the last window: as before, nothing closes");
  assert.equal(pageFateOnWindowClose({ openedBy: "agent", workerUsing: true }, 0), "keep-unseen");
});

test("the browser host sends a page's events to its own window and lets only that window answer its site", () => {
  assert.match(browserHost, /#send\(page: BrowserPage \| null, channel[\s\S]*?const window = page \? this\.#home\(page\) : this\.#front\(\);/);
  assert.doesNotMatch(browserHost, /this\.#options\.send\(browserChannels\./, "every page event goes through #send");
  assert.doesNotMatch(browserHost, /this\.#options\.window\(\)/);
  assert.match(browserHost, /respondPermission\([^)]*window: BrowserWindow\): void \{\s*const page = this\.#pages\.get\(pageId\);\s*if \(!page \|\| this\.#home\(page\) !== window\) return;/);
  assert.match(browserHost, /states\(window: BrowserWindow\): BrowserPageState\[\] \{[\s\S]*?this\.#adopt\(page, window\) === window/);
  // A Worker's tab goes to its Connected Folder's window; a tab a page opens stays in that page's window.
  assert.match(browserHost, /home \?\? \(openedBy === "agent" \? this\.#options\.workerWindow\(owner\) : this\.#front\(\)\)/);
  assert.match(browserHost, /this\.#createPage\(newPageId\(this\.#pages\), details\.url, opener\.openedBy, options as WebContentsViewConstructorOptions, opener\.owner, this\.#home\(opener\)\)/);
  assert.match(browserHost, /windowClosed\(window: BrowserWindow\): void \{[\s\S]*?pageFateOnWindowClose\(/);
  // main.ts routes every browser request to the window that sent it, and closing a window hands its pages on, never at Quit.
  for (const call of ["mount(parseBrowserViewRequest(value), requireSenderWindow(event))", "sync(parseBrowserTabsSync(value), requireSenderWindow(event))", "states(requireSenderWindow(event))", "respondPermission(pageId, requestId, decision, requireSenderWindow(event))"]) {
    assert.ok(main.includes(call), call);
  }
  assert.match(section(main, 'window.on("closed", () => {', "\n  });\n"), /if \(!endingApp\) builtInBrowser\?\.windowClosed\(window\);/);
  assert.match(main, /workerWindow: \(owner\) => fileManagerWindows\.workerWindow\(owner\)\?\.window \?\? null/);
});

// ── Routing in main.ts ──────────────────────────────────────────────────────

test("there is no single main window: every former use names its window", () => {
  assert.doesNotMatch(main, /\bmainWindow\b/);
  assert.doesNotMatch(main, /activeNativeConnectedFolder\b|pendingOpenLocationRequest|rendererMenuState/);
  assert.match(main, /const fileManagerWindows = new FileManagerWindows<BrowserWindow, FolderLocation>\(\);/);
});

test("menu commands go to the window the menu was used in, else the front window", () => {
  assert.match(main, /function menuCommand\(command: RendererMenuCommand\)[\s\S]*?return \(_item, window\) => sendRendererMenuCommand\(command, window\);/);
  const send = section(main, "function sendRendererMenuCommand(");
  assert.match(send, /const window = fileManagerWindows\.target\(menuWindow\)\?\.window;/);
  assert.match(send, /ensureWindow\(\)\.then\(\(\) => sendRendererMenuCommand\(command\)\)/, "with no window open the windows come back first");
  assert.doesNotMatch(main, /click: \(\) => sendRendererMenuCommand\("(?:new-chat|close-tab|toggle-hidden-files|toggle-sidebar)"\)/);
  // File → New Window takes Command-N; New Connected Folder moves to Option-Command-N.
  assert.match(main, /\{ id: "new-window", label: "New Window", accelerator: "CommandOrControl\+N", click: \(_item, window\) => \{ void openNewWindow\(\{ from: window \}\)/);
  assert.match(main, /\{ label: "New Connected Folder", accelerator: "Alt\+CommandOrControl\+N", click: menuCommand\("new-connected-folder"\) \}/);
  // Check marks and enabled items follow the front window, and each window's own state is kept.
  assert.match(main, /window\.on\("focus", \(\) => \{\s*fileManagerWindows\.focus\(window\);\s*refreshApplicationMenuState\(\);/);
  assert.match(section(main, 'ipcMain.on("amplefile:menu:set-state"', "\n  });\n"), /fileManagerWindows\.updateMenuState\(updated, value\);\s*refreshApplicationMenuState\(\);/);
  assert.match(section(main, "function popupApplicationSubmenu("), /buildApplicationSubmenuTemplate\(menuId, entry\.menuState\)\)\.popup\(\{ window: entry\.window/);
});

test("replies, dialogs, and native menus go to the window that asked", () => {
  assert.match(section(main, "function senderWindow("), /BrowserWindow\.fromWebContents\(event\.sender\)[\s\S]*?entry\.window\.webContents === event\.sender/);
  assert.match(section(main, 'ipcMain.handle("amplefile:connected-folder:choose-folder"', "\n  });\n"), /const window = senderWindow\(event\);/);
  assert.equal((main.match(/const window = senderWindow\(event\);\n\s*const options = openWithDialogOptions\(process\.platform\);\n\s*const choice = window \? await dialog\.showOpenDialog\(window, options\)/g) ?? []).length, 2);
  assert.equal((main.match(/const window = senderWindow\(event\);\n\s*if \(!window\) throw new Error\("The AmpleFile window is not available\."\);\n\s*window\.previewFile/g) ?? []).length, 2);
  assert.match(section(main, 'ipcMain.on("amplefile:window:control"', "\n  });\n"), /const window = senderWindow\(event\);/);
  // A file manager window's renderer is trusted in its top frame; any registered window, not only the first.
  assert.match(section(main, "function assertTrustedMainRenderer("), /if \(!senderWindow\(event\) \|\| !mainFrameMatches\)/);
  // Events every window shows reach every window.
  assert.match(section(main, "function sendAccentColorToRenderers("), /for \(const window of fileManagerWindows\.windows\(\)\)/);
  assert.match(main, /getWindows: \(\) => fileManagerWindows\.windows\(\),/);
});

test("the active Connected Folder is each window's own, and only its title and Open Recent read it", () => {
  const set = section(main, "async function setWindowConnectedFolder(");
  assert.match(set, /const entry = fileManagerWindows\.entry\(window\);/);
  assert.match(set, /generation !== entry\.connectedFolderGeneration/, "a slower registry read never overwrites a newer choice");
  assert.match(set, /applyNativeActiveConnectedFolderToWindow\(entry\);/);
  assert.match(set, /app\.addRecentDocument\(connectedFolder\.connectedFolderRoot\)/);
  assert.match(section(main, 'ipcMain.handle("amplefile:connected-folder:set-active-connected-folder"', "\n  });\n"), /setWindowConnectedFolder\(senderWindow\(event\),/);
  // The kernel (the CLI's context) and the AmpleFile Agent popover follow no window.
  assert.equal((main.match(/entry\.connectedFolder\b|\.connectedFolder = /g) ?? []).length > 0, true);
  assert.doesNotMatch(main, /kernel[^\n]*connectedFolder(?:Generation)?\b[^\n]*entry|kernel\.[a-zA-Z]+\([^\n]*fileManagerWindows/);
  assert.doesNotMatch(section(main, "async function ensureAmpleFileAgentPopover("), /connectedFolder/);
});

test("handed-over folders open in the most recent window, a request's further folders in new windows", () => {
  const drain = section(main, "async function drainPendingOpenPaths(");
  assert.match(drain, /const opensNewWindow = target\.newWindow && fileManagerWindows\.size > 0;/);
  assert.match(drain, /opensNewWindow \? await createFileManagerWindow\(\{ cascadeFrom: frontWindow\(\), fresh: true \}\) : await ensureWindow\(\)/);
  assert.match(drain, /handOpenLocation\(window, location\);/);
  // Finder hands over one request as one open-file event per item; they open together (finder-open-paths.ts).
  assert.match(main, /pendingOpenPaths\.push\(\.\.\.finderOpenPaths\(paths, /);
  const hand = section(main, "function handOpenLocation(");
  assert.match(hand, /fileManagerWindows\.handOpenLocation\(window, request\)/);
  assert.match(hand, /window\.webContents\.send\("amplefile:file-manager:open-location", request\)/);
  // New Window opens at the folder the window it came from shows, else the home folder.
  const open = section(main, "async function openNewWindow(");
  assert.match(open, /options\.location\s*\?\? \(shown \? \{ place: shown\.place, path: shown\.path, select: null \} : null\)\s*\?\? await folderLocationForOpenPath\(homedir\(\)\)/);
  assert.match(open, /createFileManagerWindow\(\{ cascadeFrom: source\?\.window \?\? null, fresh: true \}\)/);
});

test("Open in New Window and New Window are preload methods the host checks", () => {
  assert.match(preload, /openInNewWindow: \(location: WindowLocation\) => ipcRenderer\.invoke\("amplefile:window:open-in-new-window", location\)/);
  assert.match(preload, /newWindow: \(\) => ipcRenderer\.invoke\("amplefile:window:new-window"\)/);
  assert.match(preload, /setLocation: \(location: WindowLocation \| null\) => ipcRenderer\.send\("amplefile:window:set-location", location\)/);
  const handler = section(main, 'ipcMain.handle("amplefile:window:open-in-new-window"', "\n  });\n");
  assert.match(handler, /assertTrustedMainRenderer\(event\);\s*const location = parseWindowLocation\(value\);/);
  assert.match(handler, /await getConnectedFolder\(location\.place\.id\)/, "a Connected Folder must be registered");
  assert.match(handler, /isStandardFolderId\(location\.place\.id\)/);
});

test("closing one of several windows closes only it; the last keeps the app and its work running", () => {
  assert.match(main, /app\.on\("window-all-closed", \(\) => \{\s*if \(quittingForUpdate\) return;\s*if \(process\.platform !== "darwin"\) app\.quit\(\);\s*\}\);/);
  const closed = section(main, 'window.on("closed", () => {', "\n  });\n");
  assert.match(closed, /fileManagerWindows\.remove\(windowId\);\s*const othersOpen = fileManagerWindows\.size;/);
  assert.match(closed, /storeWindowPlacements\(placementsAfterClose\(currentWindowPlacements\(\), slot, \{ quitting: endingApp, othersOpen \}\)\);/);
  assert.match(closed, /if \(othersOpen > 0\) return;\s*if \(process\.platform !== "darwin" && !endingApp\) app\.quit\(\);/);
  assert.doesNotMatch(closed, /localApiLifetime|shutdown\(/, "closing a window never stops accepted work");
  // Windows' close-to-tray applies to the last window only.
  assert.match(main, /if \(process\.platform !== "win32" \|\| !tray \|\| !desktopPreferences\.closeToTray \|\| fileManagerWindows\.size > 1\) return;/);
  // Reopening brings back the windows that were open, every saved one, opened together.
  const ensure = section(main, "function ensureWindow(");
  assert.match(ensure, /separateRestoredPlacements\(currentWindowPlacements\(\)/);
  assert.match(ensure, /Promise\.all\(\(saved\.length \? saved : \[undefined\]\)\.map\(\(placement\) => createFileManagerWindow\(placement \? \{ placement \} : \{\}\)\)\)/);
  assert.match(main, /app\.on\("activate", \(\) => \{ showFrontWindow\(\); \}\);/);
  // Quit and update-restart keep their single coordinator.
  assert.match(main, /app\.on\("before-quit", \(event\) => \{\s*quitting = true;\s*if \(!quitCoordinator\.shouldPreventNativeQuit\(\)\) return;/);
});

test("each window carries its slot to its renderer, and a new window is marked fresh", () => {
  assert.match(main, /rendererArgument\("window-slot", String\(slot\)\)/);
  assert.match(main, /\.\.\.\(options\.fresh \? \[rendererArgument\("window-fresh", "1"\)\] : \[\]\)/);
  assert.match(preload, /argumentValue\("window-slot"\)/);
  assert.match(preload, /const windowFresh = argumentValue\("window-fresh"\) === "1";/);
});

test("the renderer keeps the Connected Folder shown, the folder tabs, and the Browser pane per window; window 1 keeps the keys it always had", async () => {
  const { perWindowStorageKeys, windowStorageKey } = await import("../web-local/src/lib/window-storage.js");
  assert.equal(windowStorageKey("amplefile.connected-folder.active", 1), "amplefile.connected-folder.active");
  assert.equal(windowStorageKey("amplefile.file-manager.browser-pane.v1", 3), "amplefile.file-manager.browser-pane.v1.window-3");
  assert.deepEqual([...perWindowStorageKeys], ["amplefile.connected-folder.active", "amplefile.file-manager.browser-pane.v1", "amplefile.file-manager.tabs.v1"]);
  const tabs = await readFile(new URL("../web-local/src/components/file-manager/useFolderTabs.ts", import.meta.url), "utf8");
  assert.match(tabs, /windowStorageKey\("amplefile\.file-manager\.tabs\.v1"\)/, "each window keeps its own folder tabs");
  const app = await readFile(new URL("../web-local/src/App.tsx", import.meta.url), "utf8");
  const view = await readFile(new URL("../web-local/src/components/file-manager/FileManagerView.tsx", import.meta.url), "utf8");
  const entry = await readFile(new URL("../web-local/src/main.tsx", import.meta.url), "utf8");
  assert.match(app, /const activeConnectedFolderStorageKey = windowStorageKey\("amplefile\.connected-folder\.active"\);/);
  assert.doesNotMatch(app, /localStorage\.(?:get|set|remove)Item\("amplefile\.connected-folder\.active"/);
  assert.match(view, /const browserPaneStorageKey = windowStorageKey\("amplefile\.file-manager\.browser-pane\.v1"\);/);
  assert.match(view, /reportWindowLocation\(location\)/, "the window tells the desktop where it is, for New Window");
  assert.ok(entry.indexOf("startWindowStorage();") < entry.indexOf("<App"), "a new window forgets its slot's leftovers before the app reads them");
});

test("windows never wait on each other's event streams for a connection to the local API", async () => {
  // Every window shares one Chromium session, which allows six connections per host; two windows' streams once
  // left a third window's first request waiting forever.
  assert.match(main, /const localApiHost = "127\.0\.0\.1";/);
  assert.match(main, /app\.commandLine\.appendSwitch\("ignore-connections-limit", localApiHost\);/);
  assert.ok(main.indexOf('appendSwitch("ignore-connections-limit"') < main.indexOf("app.whenReady()"), "set before the app is ready");
  assert.match(main, /startLocalApi\(\{\s*appMode: "desktop",\s*host: localApiHost,/);
  const api = await readFile(new URL("../web-local/src/lib/api.ts", import.meta.url), "utf8");
  assert.match(api, /control-events\|file-transfer\\\/events\|volumes\\\/events\|/, "the drives list rides the window's one multiplexed connection");
});
