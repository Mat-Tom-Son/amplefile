import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { steerQueuePlaceholder } from "../web-local/src/components/chat/ChatPanel.js";
import { automationsEmptyText } from "../web-local/src/components/modals/AutomationsPane.js";
import { fileManagerShortcutGroups } from "../web-local/src/components/modals/KeyboardShortcutsPane.js";
import { browserLoadErrorText } from "../web-local/src/lib/browser-pages.js";
import { revealInFileManagerLabel } from "../web-local/src/lib/file-actions.js";
import { desktopShortcutText } from "../web-local/src/lib/keyboard.js";
import { computerNoun, systemFileManagerName } from "../web-local/src/lib/platform.js";

// The Mac app's words stay exactly as they ship; Linux gets its own.
const root = process.cwd();
const read = (path: string) => readFile(join(root, path), "utf8");

function filesRows(platform: NodeJS.Platform | undefined, desktop: boolean) {
  return fileManagerShortcutGroups(platform, desktop).find((group) => group.title === "Files")!.rows;
}

test("shortcut hints read ⇧⌘G on the Mac and Ctrl+Shift+G on Linux", () => {
  assert.equal(desktopShortcutText(["Command", "Shift", "G"], "darwin"), "⇧⌘G");
  assert.equal(desktopShortcutText(["Ctrl", "Shift", "G"], "linux"), "Ctrl+Shift+G");
  assert.equal(desktopShortcutText(["Ctrl", "Enter"], "linux"), "Ctrl+Enter");
  assert.equal(steerQueuePlaceholder("darwin"), "Steer (Enter) · Queue (⌘Enter)");
  assert.equal(steerQueuePlaceholder("linux"), "Steer (Enter) · Queue (Ctrl+Enter)");
});

test("the computer and its file manager are named for the platform", () => {
  assert.equal(computerNoun("darwin"), "Mac");
  assert.equal(computerNoun("linux"), "computer");
  assert.equal(systemFileManagerName("darwin"), "Finder");
  assert.equal(systemFileManagerName("linux"), "your file manager");
  assert.equal(revealInFileManagerLabel("darwin"), "Show in Finder");
  assert.equal(revealInFileManagerLabel("linux"), "Show in File Manager");
  assert.equal(browserLoadErrorText({ code: -106, description: "ERR_INTERNET_DISCONNECTED" }, "darwin"), "This Mac isn’t connected to the internet.");
  assert.equal(browserLoadErrorText({ code: -106, description: "ERR_INTERNET_DISCONNECTED" }, "linux"), "This computer isn’t connected to the internet.");
});

test("Settings → Automations points to the AmpleFile Agent where each desktop keeps it", () => {
  assert.equal(automationsEmptyText("darwin"), "No automations yet. To set one up, ask the AmpleFile Agent in the menu bar. Say what should happen, when, and in which Connected Folders.");
  assert.equal(automationsEmptyText("linux"), "No automations yet. To set one up, open View → AmpleFile Agent and ask it. Say what should happen, when, and in which Connected Folders.");
});

test("Shortcut Keys keeps the Mac rows and speaks Linux on Linux", () => {
  const action = (rows: ReturnType<typeof filesRows>, key: string) => rows.filter((row) => row.keys.at(-1) === key).map((row) => row.action);
  const mac = filesRows("darwin", true);
  assert.deepEqual(action(mac, "Space"), ["Quick Look the selected item."]);
  assert.deepEqual(action(mac, "C"), ["Copy the selected items (Finder can paste them too)."]);
  assert.deepEqual(action(mac, "V"), ["Paste items copied here or in Finder.", "Move the items copied here into this folder."]);
  assert.deepEqual(action(mac, "Backspace"), ["Delete. Undo it from History, or from the Trash in a Standard Folder."]);
  assert.deepEqual(mac.find((row) => row.keys.at(-1) === "V" && row.keys.length === 3)?.keys, ["Option", "Command", "V"]);

  const linux = filesRows("linux", true);
  assert.deepEqual(action(linux, "Space"), [], "Linux has no Quick Look, so Space is not offered");
  assert.deepEqual(action(linux, "C"), ["Copy the selected items (your file manager can paste them too)."]);
  assert.deepEqual(action(linux, "V"), ["Paste items copied here or in your file manager.", "Move the items copied here into this folder."]);
  assert.deepEqual(action(linux, "Backspace"), ["Delete. Undo it from History, or from the Trash in a Standard Folder."], "a Standard Folder's items go to the desktop's Trash on Linux too");
  assert.deepEqual(linux.find((row) => row.keys.at(-1) === "V" && row.keys.length === 3)?.keys, ["Alt", "Ctrl", "V"]);
  for (const row of linux) assert.doesNotMatch(row.action, /Finder|Quick Look|Mac\b/);

  const browser = filesRows(undefined, false);
  assert.deepEqual(action(browser, "Backspace"), ["Delete. Undo it from History."], "the plain browser has no Trash to undo from");
});

test("renderer strings that name the Mac go through the platform helpers", async () => {
  const [fileManager, commandLine, browserPages, shortcuts] = await Promise.all([
    read("web-local/src/components/file-manager/FileManagerView.tsx"),
    read("web-local/src/components/modals/CommandLinePane.tsx"),
    read("web-local/src/hooks/useBrowserPages.ts"),
    read("web-local/src/components/modals/KeyboardShortcutsPane.tsx"),
  ]);
  assert.match(fileManager, /Add files to \$\{targetName\} in \$\{systemFileManagerName\(\)\}, or put it to work first\./);
  assert.match(fileManager, /title=\{`Go to Folder… \(\$\{desktopShortcutText\(\[desktopShortcutModifierKey\(\), "Shift", "G"\]\)\}\)`\}/);
  assert.doesNotMatch(fileManager, /⇧⌘G\)"/);
  // Space asks the Mac app for Quick Look only from the browser; on another desktop it does nothing.
  assert.match(fileManager, /if \(!bridge\) \{ showToast\(\{ text: "Quick Look is available in the Mac app", tone: "info" \}\); return; \}\n\s*\/\/[^\n]*\n\s*if \(!mac\) return;/);
  assert.match(commandLine, /`Not found on this \$\{computer\}`/);
  assert.match(commandLine, /`\$\{name\} isn't set up on this \$\{computer\}\.`/);
  assert.doesNotMatch(commandLine, /this Mac/);
  assert.match(browserPages, /actionLabel: revealInFileManagerLabel\(\)/);
  assert.doesNotMatch(shortcuts, /Finder can paste|in Finder\./);
});
