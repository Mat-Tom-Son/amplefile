import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { typographyFontOptionsForPlatform } from "../web-local/src/constants.js";
import { nativeOpenLabel, revealInFileManagerLabel } from "../web-local/src/lib/file-actions.js";
import { desktopShortcutKeyLabel, desktopShortcutKeySpokenName, desktopShortcutModifierKey } from "../web-local/src/lib/keyboard.js";
import { typographyFontForPlatform, connectedFolderEntryNativePath } from "../web-local/src/lib/platform.js";

const root = process.cwd();
const [app, fileManager, fileManagerCss, rendererMain, styles, customization, settings] = await Promise.all([
  read("web-local/src/App.tsx"),
  read("web-local/src/components/file-manager/FileManagerView.tsx"),
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
  assert.match(app, /desktopConnectedFolder\.onOpenConnectedFolder\(\(connectedFolderId\) =>/);
  assert.match(app, /function refreshOnReturn\(\)[\s\S]*?void refreshBootstrap\(\)/);
  assert.match(app, /window\.addEventListener\("focus", refreshOnReturn\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", refreshOnReturn\)/);
  assert.match(app, /window\.removeEventListener\("focus", refreshOnReturn\)/);
  assert.match(app, /document\.removeEventListener\("visibilitychange", refreshOnReturn\)/);
});

test("Darwin file context menus use native command IDs while Windows keeps the React menu", () => {
  assert.match(fileManager, /if \(mac && popupFileMenu\)/);
  assert.match(fileManager, /const owner = place\.kind === "standard" \? \{ connectedFolderId: "", standardFolderId: place\.id \} : \{ connectedFolderId: place\.id \};/);
  assert.match(fileManager, /popupFileMenu\(\{\n\s*\.\.\.owner,\n\s*path: target\.path,\n\s*kind: target\.kind,\n\s*capabilities: \{/);
  assert.match(fileManager, /open: target\.kind === "folder" \|\| canOpenDirectly\(target\.path\)/);
  for (const command of ["open", "reveal", "copy-path", "version-history", "new-folder", "rename", "delete"]) {
    assert.match(fileManager, new RegExp(`command === "${command}"`));
  }
  assert.match(fileManager, /setContextMenu\(\{ entry: target,[\s\S]*?returnFocusTarget: contentRef\.current \}\)/, "non-Mac and bridge-less sessions retain the React menu");
  const nativeRequests = [...fileManager.matchAll(/const command = await popupFileMenu\(\{([\s\S]*?)\bpoint,?\s*\}\);/g)].map((match) => match[1]!);
  assert.equal(nativeRequests.length, 2, "native popup requests must be present");
  for (const request of nativeRequests) {
    assert.doesNotMatch(request, /(?:label|callback|onSelect):/, "native popup requests must contain data and capabilities only");
  }
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}
