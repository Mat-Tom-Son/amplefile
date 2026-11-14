import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { closedLastWindowNeedsNotice, stillRunningNotice } from "../desktop/src/still-running-notice.js";

const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");

test("Linux and Windows say AmpleFile is still running; macOS leaves it to the Dock", () => {
  const linux = stillRunningNotice("linux", "AmpleFile");
  assert.equal(linux?.title, "AmpleFile is still running");
  assert.match(linux!.body, /Open AmpleFile again to bring back its window/);
  assert.match(linux!.body, /File → Quit/);
  assert.doesNotMatch(linux!.body, /tray/i, "the Linux notice must make sense on desktops with no tray");
  assert.match(stillRunningNotice("win32", "AmpleFile")!.body, /tray icon/);
  assert.equal(stillRunningNotice("darwin", "AmpleFile"), null);
});

test("closing the last Linux window tells the person once, never during Quit or an update restart", () => {
  assert.equal(closedLastWindowNeedsNotice({ platform: "linux", quitting: false, alreadyShown: false }), true);
  assert.equal(closedLastWindowNeedsNotice({ platform: "linux", quitting: false, alreadyShown: true }), false);
  assert.equal(closedLastWindowNeedsNotice({ platform: "linux", quitting: true, alreadyShown: false }), false);
  assert.equal(closedLastWindowNeedsNotice({ platform: "win32", quitting: false, alreadyShown: false }), false, "Windows notices on close-to-tray instead");
  assert.equal(closedLastWindowNeedsNotice({ platform: "darwin", quitting: false, alreadyShown: false }), false);
});

test("the host keeps Linux alive after the last window and reuses the one persisted notice flag", () => {
  assert.match(main, /app\.on\("window-all-closed", \(\) => \{\s*if \(quittingForUpdate\) return;\s*if \(process\.platform === "win32"\) app\.quit\(\);\s*\}\);/);
  const closed = /mainWindow\.on\("closed", \(\) => \{([\s\S]*?)\n  \}\);/.exec(main)?.[1] ?? "";
  assert.match(closed, /closedLastWindowNeedsNotice\(\{ platform: process\.platform, quitting: quitting \|\| quittingForUpdate, alreadyShown: desktopPreferences\.trayNoticeShown \}\)\) maybeShowStillRunningNotice\(\)/);
  assert.doesNotMatch(closed, /process\.platform === "linux"[^\n]*app\.quit/, "closing the window never quits Linux");
  const notice = /function maybeShowStillRunningNotice\(\): void \{([\s\S]*?)\n\}/.exec(main)?.[1] ?? "";
  assert.match(notice, /desktopPreferences\.trayNoticeShown\) return;\s*updateDesktopPreferences\(\{ trayNoticeShown: true \}\)/);
  assert.doesNotMatch(main, /maybeShowTrayNotice/);
});

test("Check for Updates… appears only where the updater has a feed", () => {
  assert.equal((main.match(/label: "Check for Updates\.\.\."/g) ?? []).length, 1, "one helper owns the item");
  assert.match(main, /function checkForUpdatesMenuItems\([^\n]*\n\s*if \(!updatesSupportedHere\(\)\) return \[\];/);
  assert.match(main, /function updatesSupportedHere\(\): boolean \{\s*if \(desktopUpdater\) return desktopUpdater\.supported;\s*return !localMacSmokeBuild && hasPackagedDesktopUpdateFeed\(/);
  assert.equal((main.match(/checkForUpdatesMenuItems\(/g) ?? []).length, 4, "help menu, macOS app menu, tray menu, and the definition");
});
