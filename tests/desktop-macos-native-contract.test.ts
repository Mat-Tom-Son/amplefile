import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const preload = await readFile(new URL("../desktop/src/preload.cts", import.meta.url), "utf8");

test("Darwin file menus require the trusted main renderer and canonical Connected Folder validation", () => {
  assert.match(
    main,
    /ipcMain\.handle\("amplefile:connected-folder:popup-file-menu"[\s\S]*?assertTrustedMainRenderer\(event\)[\s\S]*?process\.platform !== "darwin"[\s\S]*?parseNativeFileMenuRequest\(value\)[\s\S]*?validateNativeFileMenuEntry\(request\)[\s\S]*?popupNativeFileMenu\(request\)/,
  );
  assert.match(main, /validateNativeFileMenuEntry[\s\S]*?resolveConnectedFolderItem\(request\.connectedFolderId, request\.path\)/);
});

test("Darwin tab menus require the trusted main renderer and build their items in the host", () => {
  assert.match(
    main,
    /ipcMain\.handle\("amplefile:connected-folder:popup-tab-menu"[\s\S]*?assertTrustedMainRenderer\(event\)[\s\S]*?process\.platform !== "darwin"[\s\S]*?popupNativeTabMenu\(parseNativeTabMenuRequest\(value\)\)/,
  );
  assert.match(main, /function popupNativeTabMenu[\s\S]*?popupNativeCommandMenu\(nativeTabMenuItems\(request\), request\.point\)/);
  assert.match(preload, /popupTabMenu: \(request[\s\S]*?ipcRenderer\.invoke\("amplefile:connected-folder:popup-tab-menu", request\)/);
});

test("the Darwin Connected Folder header menu requires the trusted main renderer and builds its items in the host", () => {
  assert.match(
    main,
    /ipcMain\.handle\("amplefile:connected-folder:popup-header-menu"[\s\S]*?assertTrustedMainRenderer\(event\)[\s\S]*?process\.platform !== "darwin"[\s\S]*?parseNativeConnectedFolderMenuRequest\(value\)[\s\S]*?popupNativeCommandMenu\(nativeConnectedFolderMenuItems\(request\), request\.point\)/,
  );
  assert.match(preload, /popupHeaderMenu: \(request[\s\S]*?ipcRenderer\.invoke\("amplefile:connected-folder:popup-header-menu", request\)/);
});

test("Finder and Open Recent recreate the Mac window before automation a queued Connected Folder", () => {
  assert.match(
    main,
    /drainPendingMacOpenPaths[\s\S]*?while \(pendingMacOpenPaths\.length\)[\s\S]*?await ensureMainWindow\(\)[\s\S]*?registeredConnectedFolderIdForOpenPath\(path\)[\s\S]*?amplefile:connected-folder:open-connected-folder/,
  );
  assert.match(main, /registeredConnectedFolderIdForOpenPath[\s\S]*?info\.isDirectory\(\)[\s\S]*?realpath\(connectedFolder\.connectedFolderRoot\)[\s\S]*?samePath\(openedRoot, registeredRoot\)/);
  assert.match(main, /request = \{ token: randomUUID\(\), connectedFolderId \}[\s\S]*?amplefile:connected-folder:open-connected-folder/);
  assert.match(preload, /deliveredTokens[\s\S]*?amplefile:connected-folder:take-open-connected-folder[\s\S]*?then\(deliver\)/);
});

test("the interactive local API is app-lifetime state rather than BrowserWindow state", () => {
  assert.match(main, /localApiLifetime = new AppLifetimeResource/);
  assert.match(main, /createMainWindow[\s\S]*?ensureInteractiveLocalApi\(\)/);
  assert.doesNotMatch(main, /mainWindow\.on\("closed"[\s\S]{0,300}localApiLifetime\.close/);
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
    /app\.on\("second-instance", \(_event, argv, _workingDirectory, additionalData\) => \{[\s\S]*?ampleFileSecondInstanceIntent\(argv, additionalData\)[\s\S]*?intent\.kind === "cli-invalid"[\s\S]*?return;[\s\S]*?intent\.kind === "cli"[\s\S]*?processAmpleFileCliRequest\(intent\.requestId\)[\s\S]*?return;[\s\S]*?interactiveRequested = true;[\s\S]*?startInteractiveApp\(\)\.then\(showWindow\)/,
  );
  // Parsing ids inline would fall through to showWindow whenever both
  // channels came back empty — CLI-shaped launches must not do that.
  assert.doesNotMatch(main, /ampleFileCliRequestIdFromInstanceData\(additionalData\)/);
});

test("the main window reveals itself only on its first ready-to-show", () => {
  // Renderer recoveries can re-emit ready-to-show; a window the person hid
  // (close-to-tray, minimize) must not resurface on an autonomous reload.
  assert.match(main, /mainWindow\.once\("ready-to-show", \(\) => mainWindow\?\.show\(\)\)/);
  assert.doesNotMatch(main, /mainWindow\.on\("ready-to-show"/);
});
