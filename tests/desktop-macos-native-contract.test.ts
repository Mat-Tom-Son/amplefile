import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const preload = await readFile(new URL("../desktop/src/preload.cts", import.meta.url), "utf8");

test("Darwin file menus require the trusted main renderer and canonical Connected Folder validation", () => {
  assert.match(
    main,
    /ipcMain\.handle\("amplefile:connected-folder:popup-file-menu"[\s\S]*?assertTrustedMainRenderer\(event\)[\s\S]*?process\.platform !== "darwin"[\s\S]*?parseNativeFileMenuRequest\(value\)[\s\S]*?validateNativeFileMenuEntry\(request\)[\s\S]*?popupNativeFileMenu\(request, senderWindow\(event\)\)/,
  );
  assert.match(main, /validateNativeFileMenuEntry[\s\S]*?resolveConnectedFolderItem\(request\.connectedFolderId, request\.path\)/);
});

test("Darwin tab menus require the trusted main renderer and build their items in the host", () => {
  assert.match(
    main,
    /ipcMain\.handle\("amplefile:connected-folder:popup-tab-menu"[\s\S]*?assertTrustedMainRenderer\(event\)[\s\S]*?process\.platform !== "darwin"[\s\S]*?popupNativeTabMenu\(parseNativeTabMenuRequest\(value\), senderWindow\(event\)\)/,
  );
  assert.match(main, /function popupNativeTabMenu[\s\S]*?popupNativeCommandMenu\(nativeTabMenuItems\(request\), request\.point, window\)/);
  assert.match(preload, /popupTabMenu: \(request[\s\S]*?ipcRenderer\.invoke\("amplefile:connected-folder:popup-tab-menu", request\)/);
});

test("the Darwin file menu shares the command-menu helper: zoom-scaled point, deferred close, and its icon", () => {
  // Every native menu shows in the window that asked for it.
  assert.match(main, /function popupNativeFileMenu\(request: NativeFileMenuRequest, window: BrowserWindow \| null\): Promise<NativeFileMenuCommand \| null> \{\n\s*return popupNativeCommandMenu\(nativeFileMenuItems\(request, process\.platform\), request\.point, window\);\n\}/);
  const helper = main.slice(main.indexOf("function popupNativeCommandMenu"));
  const body = helper.slice(0, helper.indexOf("\n}\n"));
  assert.match(body, /const zoom = window\.webContents\.getZoomFactor\(\) \|\| 1;/);
  assert.match(body, /x: Math\.round\(point\.x \* zoom\)/);
  assert.match(body, /callback: \(\) => setTimeout\(\(\) => finish\(null\), 0\)/);
  assert.match(body, /item\.icon === "amplefile" \? ampleFileMenuIcon\(\) : \{\}/);
  // Every native context menu pops up through the one helper.
  assert.equal((main.match(/Menu\.buildFromTemplate\([^)]*\)\)?\.popup\(\{\n\s*window,\n\s*x:/g) ?? []).length, 1);
});

test("the Darwin Connected Folder header menu requires the trusted main renderer and builds its items in the host", () => {
  assert.match(
    main,
    /ipcMain\.handle\("amplefile:connected-folder:popup-header-menu"[\s\S]*?assertTrustedMainRenderer\(event\)[\s\S]*?process\.platform !== "darwin"[\s\S]*?parseNativeConnectedFolderMenuRequest\(value\)[\s\S]*?popupNativeCommandMenu\(nativeConnectedFolderMenuItems\(request\), request\.point, senderWindow\(event\)\)/,
  );
  assert.match(preload, /popupHeaderMenu: \(request[\s\S]*?ipcRenderer\.invoke\("amplefile:connected-folder:popup-header-menu", request\)/);
});

test("the menu bar's items work in every place: Refresh with any folder shown, the AmpleFile Agent with or without a Connected Folder", () => {
  const menus = main.slice(main.indexOf("function buildApplicationSubmenuTemplate("), main.indexOf("function macApplicationMenu("));
  // File → Refresh (⌘R) reads the folder shown again in a Connected Folder, a Standard Folder, the disk, or any other
  // folder, so it follows whether the window shows its folders, not whether a Connected Folder is open.
  assert.match(menus, /\{ id: "refresh", label: "Refresh", accelerator: "CommandOrControl\+R", enabled: state\.folderTabsOpen, click: menuCommand\("refresh"\) \}/);
  assert.doesNotMatch(main, /Refresh Connected Folder|reload-connected-folder-state|refresh-connected-folder/);
  // View → Toggle AmpleFile Agent (⌘J) shows or hides the menu-bar popover from the host, always enabled where the
  // popover lives; it no longer goes to a window that has no agent panel.
  assert.match(menus, /\.\.\.\(ampleFileAgentPopoverHosted\(\) \? \[\n\s*\{ id: "toggle-amplefile-agent", label: "Toggle AmpleFile Agent", accelerator: "CommandOrControl\+J", click: \(\) => \{ void toggleAmpleFileAgentPopover\(\); \} \},/);
  assert.match(main, /function ampleFileAgentPopoverHosted\(\): boolean \{\n\s*return process\.platform === "darwin" \|\| process\.platform === "win32";\n\}/);
  assert.doesNotMatch(main, /toggle-agent-panel/);
  // The window has no sidebar to hide, so View → Toggle Sidebar (⌘B) is gone rather than dead.
  assert.doesNotMatch(main, /Toggle Sidebar|toggle-sidebar|CommandOrControl\+B"/);
  // Of the three, only the folder-tabs gate is left in the menu state, and nothing of them waits on a Connected Folder.
  const refresh = main.slice(main.indexOf("function refreshApplicationMenuState("), main.indexOf("function setMenuItemEnabled("));
  assert.match(refresh, /setMenuItemEnabled\(menu, "refresh", state\.folderTabsOpen\);/);
  assert.doesNotMatch(refresh, /"(?:refresh|toggle-amplefile-agent)", state\.connectedFolderOpen/);
  assert.doesNotMatch(refresh, /toggle-amplefile-agent/);
});

test("Finder and Open Recent recreate the Mac window before showing a queued folder where it lives", () => {
  assert.match(
    main,
    /drainPendingOpenPaths[\s\S]*?while \(pendingOpenPaths\.length\)[\s\S]*?await ensureWindow\(\)[\s\S]*?folderLocationForOpenPath\(target\.path[,)][\s\S]*?handOpenLocation\(window, location\)/,
  );
  assert.match(main, /folderLocationForOpenPath[\s\S]*?resolveFolderLocation\(path, await listConnectedFolders\(\), homedir\(\)[,)]/);
  assert.match(main, /request = \{ token: randomUUID\(\), location \}[\s\S]*?amplefile:file-manager:open-location/);
  assert.match(preload, /deliveredTokens[\s\S]*?amplefile:file-manager:take-open-location[\s\S]*?then\(deliver\)/);
});

test("the interactive local API is app-lifetime state rather than BrowserWindow state", () => {
  assert.match(main, /localApiLifetime = new AppLifetimeResource/);
  assert.match(main, /createFileManagerWindow[\s\S]*?ensureInteractiveLocalApi\(\)/);
  assert.doesNotMatch(main, /window\.on\("closed"[\s\S]{0,1200}localApiLifetime\.close/);
  assert.match(main, /shutdown[\s\S]*?localApiLifetime\.close\(\)/);
});

test("ad hoc Mac smoke builds use a separate identity and never start the production updater", () => {
  assert.match(main, /localMacSmokeProductName = productIdentity\.macSmokeProductName/);
  assert.match(main, /localMacSmokeBuild[\s\S]*?packagedBuildChannel\(\) === "mac-local-smoke"/);
  assert.match(main, /packagedBuildChannel[\s\S]*?ampleFileBuildChannel[\s\S]*?Historical production packages/);
  assert.match(main, /configureUpdater[\s\S]*?desktopUpdater \|\| localMacSmokeBuild/);
});

test("the Mac Quit item enters the deferred graceful coordinator instead of a native-role reentrant quit", () => {
  const macMenu = main.slice(main.indexOf("function macApplicationMenu"), main.indexOf("function macWindowMenu"));
  assert.match(main, /id: "quit-connected-folder"[\s\S]*?accelerator: "Command\+Q"[\s\S]*?click: requestApplicationQuit/);
  assert.doesNotMatch(macMenu, /\{ role: "quit" \}/);
  assert.match(main, /app\.on\("before-quit"[\s\S]*?shouldPreventNativeQuit\(\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?quitCoordinator\.requestQuit\(\)/);
});

test("headless CLI relaunches never front the interactive window", () => {
  // The shim relaunches the executable for every request; only a genuine
  // interactive relaunch (person opened AmpleFile again) reaches showWindow.
  assert.match(
    main,
    /app\.on\("second-instance", \(_event, argv, _workingDirectory, additionalData\) => \{[\s\S]*?ampleFileSecondInstanceIntent\(argv, additionalData\)[\s\S]*?intent\.kind === "cli-invalid"[\s\S]*?return;[\s\S]*?intent\.kind === "cli"[\s\S]*?processAmpleFileCliRequest\(intent\.requestId\)[\s\S]*?return;[\s\S]*?interactiveRequested = true;[\s\S]*?startInteractiveApp\(\)\.then\(showFrontWindow\)/,
  );
  // Parsing ids inline would fall through to showWindow whenever both
  // channels came back empty — CLI-shaped launches must not do that.
  assert.doesNotMatch(main, /ampleFileCliRequestIdFromInstanceData\(additionalData\)/);
});

test("the main window reveals itself only on its first ready-to-show", () => {
  // Renderer recoveries can re-emit ready-to-show; a window the person hid
  // (close-to-tray, minimize) must not resurface on an autonomous reload.
  assert.match(main, /window\.once\("ready-to-show", \(\) => \{ if \(!window\.isDestroyed\(\)\) window\.show\(\); \}\)/);
  assert.doesNotMatch(main, /window\.on\("ready-to-show"/);
});
