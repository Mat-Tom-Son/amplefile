import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { typographyFontOptionsForPlatform } from "../web-local/src/constants.js";
import { nativeOpenLabel, revealInFileManagerLabel } from "../web-local/src/lib/file-actions.js";
import { desktopShortcutKeyLabel, desktopShortcutKeySpokenName, desktopShortcutModifierKey } from "../web-local/src/lib/keyboard.js";
import { typographyFontForPlatform, connectedFolderEntryNativePath } from "../web-local/src/lib/platform.js";
import { readFileManagerWindowSource } from "./support/file-manager-source.js";

const root = process.cwd();
const [app, fileManager, fileManagerCss, rendererMain, styles, customization, settings] = await Promise.all([
  read("web-local/src/App.tsx"),
  readFileManagerWindowSource(),
  read("web-local/src/components/file-manager/file-manager.css"),
  read("web-local/src/main.tsx"),
  read("web-local/src/styles.css"),
  read("web-local/src/styles.css"),
  read("web-local/src/components/modals/AppearanceSettingsPane.tsx"),
]);

test("typography ships the brand font everywhere and omits the Windows-only Segoe choice on macOS", () => {
  assert.deepEqual(typographyFontOptionsForPlatform("darwin").map(({ value, label }) => [value, label]), [
    ["default", "Default"],
    ["verdana", "Verdana"],
    ["aptos", "Aptos"],
  ]);
  assert.deepEqual(typographyFontOptionsForPlatform("win32").map(({ value, label }) => [value, label]), [
    ["default", "Default"],
    ["stable", "Segoe UI"],
    ["verdana", "Verdana"],
    ["aptos", "Aptos"],
  ]);
  assert.equal(typographyFontForPlatform("stable", "darwin"), "default");
  assert.equal(typographyFontForPlatform("stable", "win32"), "stable");
  // Inter is bundled, so the default stack does not fork per platform.
  assert.match(styles, /--amplefile-font-family-default:\s*"Inter Variable"/);
  assert.doesNotMatch(styles, /:root\[data-platform="darwin"\][\s\S]{0,200}--amplefile-font-family-default/);
  assert.match(settings, /"Device Setting"/);
  assert.doesNotMatch(settings, /Match your device’s appearance/);
  assert.doesNotMatch(settings, /Match Windows/);
});

test("macOS shortcut and file labels use native notation without changing Windows", () => {
  assert.equal(desktopShortcutModifierKey("darwin"), "Command");
  assert.equal(desktopShortcutKeyLabel("Command", "darwin"), "⌘");
  assert.equal(desktopShortcutKeyLabel("Option", "darwin"), "⌥");
  assert.equal(desktopShortcutKeyLabel("Shift", "darwin"), "⇧");
  assert.equal(desktopShortcutKeyLabel("Ctrl", "darwin"), "⌃");
  assert.equal(desktopShortcutKeyLabel("Enter", "darwin"), "↩");
  assert.equal(desktopShortcutKeyLabel("Esc", "darwin"), "⎋");
  assert.equal(desktopShortcutKeyLabel("Home", "darwin"), "Home");
  assert.equal(desktopShortcutKeyLabel("End", "darwin"), "End");
  assert.equal(desktopShortcutModifierKey("win32"), "Ctrl");
  assert.equal(desktopShortcutKeyLabel("Shift", "win32"), "Shift");
  assert.equal(desktopShortcutKeyLabel("Ctrl", "win32"), "Ctrl");
  assert.equal(desktopShortcutKeyLabel("Esc", "win32"), "Esc");
  assert.equal(["Ctrl", "Tab"].map(desktopShortcutKeySpokenName).join(" plus "), "Control plus Tab");
  assert.equal(desktopShortcutKeySpokenName("Esc"), "Escape");
  assert.equal(revealInFileManagerLabel("darwin"), "Show in Finder");
  assert.equal(nativeOpenLabel({ name: "legacy.doc", path: "legacy.doc", kind: "file" }, "darwin").text, "Show in Finder");
  assert.equal(nativeOpenLabel({ name: "legacy.doc", path: "legacy.doc", kind: "file" }, "win32").text, "Show in File Explorer");
  assert.equal(connectedFolderEntryNativePath("/Users/mat/connected-folder", "notes/draft.md", "darwin"), "/Users/mat/connected-folder/notes/draft.md");
  assert.equal(connectedFolderEntryNativePath("C:\\Users\\mat\\connected-folder", "notes/draft.md", "win32"), "C:\\Users\\mat\\connected-folder\\notes\\draft.md");
});

test("renderer publishes platform and material before mounting and keeps Mac scrollbars native", () => {
  const datasetIndex = rendererMain.indexOf("document.documentElement.dataset.platform");
  const renderIndex = rendererMain.indexOf("ReactDOM.createRoot");
  assert.ok(datasetIndex >= 0 && datasetIndex < renderIndex);
  assert.match(rendererMain, /windowMaterial === "mica" \|\| windowMaterial === "vibrancy"/);
  assert.match(styles, /:root:not\(\[data-platform="darwin"\]\) \*::-webkit-scrollbar/);
  assert.doesNotMatch(styles, /(?:^|\n)\*::-webkit-scrollbar/);
  assert.match(customization, /:root\[data-platform="darwin"\] \*[\s\S]*?scrollbar-width:\s*auto[\s\S]*?scrollbar-gutter:\s*auto/);
});

test("macOS vibrancy is confined to navigation with an opaque work surface and solid fallback", () => {
  assert.match(fileManagerCss, /:root\[data-window-material="vibrancy"\] \.fm-shell \{\s*background:\s*transparent;/);
  assert.match(fileManagerCss, /:root\[data-window-material="vibrancy"\] \.fm-main \{\s*background:\s*var\(--fm-window\);/);
  assert.match(customization, /data-platform="darwin"[\s\S]*?-webkit-app-region:\s*drag/);
  assert.match(customization, /data-platform="darwin"[\s\S]*?--amplefile-window-inset-top:\s*32px/);
  assert.doesNotMatch(customization, /data-window-material="none"/);
});

test("desktop Connected Folder state and Finder-open automation are wired in the renderer", () => {
  assert.match(app, /connectedFolder\.setActiveConnectedFolder\?\.\(activeConnectedFolder\?\.id \?\? null\)/);
  assert.match(app, /desktopConnectedFolder\.onOpenLocation\(\(\{ place, path, select \}\) =>/);
  assert.match(app, /function refreshOnReturn\(\)[\s\S]*?void refreshBootstrap\(\)/);
  assert.match(app, /window\.addEventListener\("focus", refreshOnReturn\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", refreshOnReturn\)/);
  assert.match(app, /window\.removeEventListener\("focus", refreshOnReturn\)/);
  assert.match(app, /document\.removeEventListener\("visibilitychange", refreshOnReturn\)/);
});

test("Darwin file context menus use native command IDs while other desktops draw the same items in the window", () => {
  assert.match(fileManager, /if \(mac && popupFileMenu\)/);
  assert.match(fileManager, /const owner = place\.kind === "standard" \? \{ connectedFolderId: "", standardFolderId: place\.id \} : \{ connectedFolderId: place\.id \};/);
  assert.match(fileManager, /open: target\.kind === "folder" \|\| canOpenDirectly\(target\.path\)/);
  for (const command of ["open", "reveal", "show-original", "copy-path", "version-history", "new-folder", "rename", "delete", "cut", "extract"]) {
    assert.match(fileManager, new RegExp(`command === "${command}"`));
  }
  // Elsewhere the window draws the shared list (src/shared/file-menu.ts) itself.
  assert.match(fileManager, /const items = fileMenuItems\(\{/, "non-Mac and bridge-less sessions draw the same items in the window");
  const nativeRequests = [...fileManager.matchAll(/const command = await popupFileMenu\(\{([\s\S]*?)\bpoint,?\s*\}\);/g)].map((match) => match[1]!);
  // One request for an item, several selected together, or a link: the capabilities say which.
  assert.equal(nativeRequests.length, 1, "one native popup request");
  assert.match(fileManager, /link: true/, "a link row asks for the link menu");
  for (const request of nativeRequests) {
    assert.doesNotMatch(request, /(?:label|callback|onSelect):/, "native popup requests must contain data and capabilities only");
  }
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}
