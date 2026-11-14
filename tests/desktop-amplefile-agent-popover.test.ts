import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  displayMatching,
  displayNearestPoint,
  linuxCursorIsReliable,
  panelEdge,
  popoverPlacement,
  type PopoverDisplay,
  type PopoverRect,
} from "../desktop/src/amplefile-agent-popover-placement.js";
import { trayPopoverToggleAction, trayToggleBlurGraceMs } from "../desktop/src/tray-popover-toggle.js";

const popover = await readFile(new URL("../desktop/src/amplefile-agent-popover.ts", import.meta.url), "utf8");

test("a visible popover always toggles hidden", () => {
  assert.equal(trayPopoverToggleAction({ visible: true, lastBlurHiddenAt: null }, 1_000), "hide");
  // Visibility wins even with a fresh blur timestamp (devtools kept it open).
  assert.equal(trayPopoverToggleAction({ visible: true, lastBlurHiddenAt: 990 }, 1_000), "hide");
});

test("a tray click right after its own blur-hide stays closed instead of flashing", () => {
  // The dismissal race: mousedown blurs (hides) the popover, then the click's
  // toggle runs. Within the grace window the click means "close it".
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 1_000 }, 1_000), "suppress");
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 1_000 }, 1_000 + trayToggleBlurGraceMs), "suppress");
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 1_000 }, 1_000 + trayToggleBlurGraceMs + 1), "show");
});

test("clean opens and stale or skewed timestamps show the popover", () => {
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: null }, 1_000), "show");
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 0 }, 10_000), "show");
  // A clock that moved backwards must not suppress future clicks forever.
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 2_000 }, 1_000), "show");
});

test("the popover consumes a suppressed toggle so the next click reopens it", () => {
  assert.match(popover, /if \(action === "suppress"\) \{[\s\S]*?this\.#lastBlurHiddenAt = null;[\s\S]*?return;/);
  assert.match(popover, /trayPopoverToggleAction\(\s*\{ visible: this\.isVisible\(\), lastBlurHiddenAt: this\.#lastBlurHiddenAt \},\s*Date\.now\(\),\s*\)/);
});

test("only blur-caused hides arm the tray-click grace", () => {
  // Programmatic hides (Escape, Open AmpleFile) emit a trailing blur after the
  // window is already hidden; arming the grace there would swallow reopens.
  assert.match(
    popover,
    /window\.on\("blur", \(\) => \{[\s\S]*?if \(!window\.isVisible\(\)\) return;[\s\S]*?this\.#lastBlurHiddenAt = Date\.now\(\);[\s\S]*?this\.hide\(\);[\s\S]*?\}\);/,
  );
});

test("the macOS popover is a nonactivating panel that never transforms the process type", () => {
  // type: "panel" keeps app activation with the previous app, so summoning
  // the popover cannot raise the main window behind it; without
  // skipTransformProcessType Electron turns the whole app into a
  // UIElementApplication (Dock icon gone, app force-deactivated) the moment
  // the popover window exists.
  assert.match(popover, /\.\.\.\(process\.platform === "darwin" \? \{ type: "panel" as const \} : \{\}\)/);
  assert.match(popover, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true, skipTransformProcessType: true \}\)/);
});

test("summoning the popover focuses its content without activating the app on macOS", () => {
  assert.match(
    popover,
    /window\.show\(\);\s*if \(process\.platform === "darwin"\) \{[\s\S]*?window\.webContents\.focus\(\);[\s\S]*?\} else \{\s*window\.focus\(\);\s*\}/,
  );
});

test("a second tray event during a cold open reuses the pending show", () => {
  assert.match(popover, /if \(this\.#pendingShow\) return this\.#pendingShow;/);
  assert.match(popover, /finally \{\s*this\.#pendingShow = null;\s*\}/);
});

// ---------------------------------------------------------------------------
// Placement

const size = { width: 400, height: 560 };
const display = (bounds: PopoverRect, workArea: PopoverRect = bounds): PopoverDisplay => ({ bounds, workArea });
const inside = (placed: PopoverRect, area: PopoverRect) =>
  placed.x >= area.x && placed.y >= area.y && placed.x + placed.width <= area.x + area.width && placed.y + placed.height <= area.y + area.height;

test("macOS and Windows placement is unchanged: under a menu-bar icon, above a taskbar tray, centered without one", () => {
  const mac = display({ x: 0, y: 0, width: 1512, height: 982 }, { x: 0, y: 33, width: 1512, height: 949 });
  const tray = { x: 1300, y: 4, width: 24, height: 24 };
  assert.deepEqual(popoverPlacement({ platform: "darwin", anchor: { kind: "tray", trayBounds: tray }, size, displays: [mac], primary: mac, cursor: null, appWindowBounds: null }), { x: 1512 - 400 - 6, y: 34, ...size });
  // A window-anchored request on macOS still uses the tray rule.
  assert.deepEqual(popoverPlacement({ platform: "darwin", anchor: { kind: "window", windowBounds: { x: 0, y: 0, width: 800, height: 600 } }, size, displays: [mac], primary: mac, cursor: { x: 5, y: 5 }, appWindowBounds: null }), { x: 556, y: 33 + Math.round((949 - 560) / 3), ...size });
  const win = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1040 });
  const taskbar = { x: 1800, y: 1050, width: 24, height: 24 };
  assert.deepEqual(popoverPlacement({ platform: "win32", anchor: { kind: "tray", trayBounds: taskbar }, size, displays: [win], primary: win, cursor: null, appWindowBounds: null }), { x: 1920 - 400 - 6, y: 1050 - 560 - 6, ...size });
  assert.deepEqual(popoverPlacement({ platform: "win32", anchor: { kind: "tray", trayBounds: { x: 0, y: 0, width: 0, height: 0 } }, size, displays: [win], primary: win, cursor: null, appWindowBounds: null }), { x: 760, y: Math.round((1040 - 560) / 3), ...size });
});

test("Linux opens the popover inside the asking window's top-right corner, under the title bar", () => {
  const screenRect = display({ x: 0, y: 0, width: 1536, height: 960 }, { x: 0, y: 30, width: 1536, height: 930 });
  const window = { x: 100, y: 80, width: 1200, height: 800 };
  const placed = popoverPlacement({ platform: "linux", anchor: { kind: "window", windowBounds: window }, size, displays: [screenRect], primary: screenRect, cursor: null, appWindowBounds: window });
  assert.deepEqual(placed, { x: 100 + 1200 - 400 - 12, y: 80 + 40 + 6, ...size });
  // A window pushed against the right edge keeps the popover on its display.
  const edge = popoverPlacement({ platform: "linux", anchor: { kind: "window", windowBounds: { x: 1400, y: 500, width: 600, height: 400 } }, size, displays: [screenRect], primary: screenRect, cursor: null, appWindowBounds: null });
  assert.ok(inside(edge, screenRect.workArea), JSON.stringify(edge));
  assert.equal(edge.x, 1536 - 400 - 6);
  assert.equal(edge.y, 960 - 560 - 6);
});

test("Linux uses the asking window's display on multi-monitor layouts, including fractional scales", () => {
  // Left 1920x1200 at 125% (1536x960 DIPs), right 2560x1440 at 100%, offset vertically.
  const left = display({ x: 0, y: 0, width: 1536, height: 960 });
  const right = display({ x: 1536, y: -200, width: 2560, height: 1440 }, { x: 1536, y: -168, width: 2560, height: 1408 });
  const window = { x: 2000.4, y: -150.6, width: 1000, height: 700 };
  const placed = popoverPlacement({ platform: "linux", anchor: { kind: "window", windowBounds: window }, size, displays: [left, right], primary: left, cursor: null, appWindowBounds: window });
  assert.ok(inside(placed, right.workArea), JSON.stringify(placed));
  assert.ok(Number.isInteger(placed.x) && Number.isInteger(placed.y));
  // A window mostly on the left display anchors there even when it spills over.
  const spill = { x: 1000, y: 100, width: 800, height: 600 };
  assert.ok(inside(popoverPlacement({ platform: "linux", anchor: { kind: "window", windowBounds: spill }, size, displays: [left, right], primary: left, cursor: null, appWindowBounds: spill }), left.workArea));
});

test("Linux without tray geometry uses the work-area corner by the panel, never the primary display's center", () => {
  const top = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 32, width: 1920, height: 1048 });
  const bottom = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1040 });
  const leftPanel = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 48, y: 0, width: 1872, height: 1080 });
  const none = display({ x: 0, y: 0, width: 1920, height: 1080 });
  const empty = { kind: "tray" as const, trayBounds: { x: 0, y: 0, width: 0, height: 0 } };
  const place = (d: PopoverDisplay) => popoverPlacement({ platform: "linux", anchor: empty, size, displays: [d], primary: d, cursor: null, appWindowBounds: null });
  assert.deepEqual(place(top), { x: 1920 - 400 - 6, y: 32 + 6, ...size });
  assert.deepEqual(place(bottom), { x: 1920 - 400 - 6, y: 1040 - 560 - 6, ...size });
  assert.deepEqual(place(leftPanel), { x: 48 + 6, y: 6, ...size });
  assert.deepEqual(place(none), { x: 1920 - 400 - 6, y: 6, ...size });
  // The AmpleFile window's display wins over the primary one.
  const second = display({ x: 1920, y: 0, width: 1280, height: 800 }, { x: 1920, y: 30, width: 1280, height: 770 });
  const onSecond = popoverPlacement({ platform: "linux", anchor: empty, size, displays: [none, second], primary: none, cursor: null, appWindowBounds: { x: 2000, y: 100, width: 900, height: 600 } });
  assert.deepEqual(onSecond, { x: 1920 + 1280 - 400 - 6, y: 30 + 6, ...size });
  // View → AmpleFile Agent with no window to anchor to behaves the same way.
  assert.deepEqual(popoverPlacement({ platform: "linux", anchor: { kind: "window", windowBounds: null }, size, displays: [top], primary: top, cursor: null, appWindowBounds: null }), place(top));
});

test("Linux tray clicks open beside a reliable pointer, away from the panel", () => {
  const top = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 32, width: 1920, height: 1048 });
  const bottom = display({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1040 });
  const anchor = { kind: "tray" as const, trayBounds: null };
  assert.deepEqual(popoverPlacement({ platform: "linux", anchor, size, displays: [top], primary: top, cursor: { x: 1700, y: 12 }, appWindowBounds: null }), { x: 1500, y: 38, ...size });
  assert.deepEqual(popoverPlacement({ platform: "linux", anchor, size, displays: [top], primary: top, cursor: { x: 900, y: 12 }, appWindowBounds: null }), { x: 700, y: 38, ...size });
  assert.deepEqual(popoverPlacement({ platform: "linux", anchor, size, displays: [bottom], primary: bottom, cursor: { x: 1900, y: 1060 }, appWindowBounds: null }), { x: 1920 - 400 - 6, y: 1040 - 560 - 6, ...size });
  // Real tray geometry, when a host reports it, is used and kept on screen.
  const placed = popoverPlacement({ platform: "linux", anchor: { kind: "tray", trayBounds: { x: 1880, y: 4, width: 24, height: 24 } }, size, displays: [top], primary: top, cursor: null, appWindowBounds: null });
  assert.ok(inside(placed, top.workArea), JSON.stringify(placed));
});

test("a display smaller than the popover shrinks it to fit", () => {
  const tiny = display({ x: 0, y: 0, width: 640, height: 480 }, { x: 0, y: 24, width: 640, height: 456 });
  const placed = popoverPlacement({ platform: "linux", anchor: { kind: "window", windowBounds: { x: 0, y: 24, width: 640, height: 456 } }, size, displays: [tiny], primary: tiny, cursor: null, appWindowBounds: null });
  assert.ok(inside(placed, tiny.workArea), JSON.stringify(placed));
  assert.equal(placed.height, 456 - 12);
  assert.equal(placed.width, 400);
});

test("the panel edge is the side with the most reserved space", () => {
  const small = display({ x: 0, y: 0, width: 10, height: 10 });
  assert.equal(panelEdge(display({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 10, width: 100, height: 90 })), "top");
  assert.equal(panelEdge(display({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 90, height: 100 })), "right");
  assert.equal(panelEdge(display({ x: 0, y: 0, width: 100, height: 100 })), null);
  assert.equal(displayMatching([small], small, { x: 50, y: 50, width: 5, height: 5 }), small);
  const far = display({ x: 100, y: 0, width: 10, height: 10 });
  assert.equal(displayNearestPoint([small, far], small, { x: 90, y: 5 }), far);
});

test("only an X11 session's pointer position is trusted", () => {
  assert.equal(linuxCursorIsReliable({ DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }), true);
  assert.equal(linuxCursorIsReliable({ DISPLAY: ":0" }), true);
  // XWayland (xwayland-satellite on niri, Mutter, KWin) and native Wayland.
  assert.equal(linuxCursorIsReliable({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1", XDG_SESSION_TYPE: "wayland" }), false);
  assert.equal(linuxCursorIsReliable({ DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" }), false);
  assert.equal(linuxCursorIsReliable({}), false);
});

test("the popover resolves its placement through the shared geometry and only shrinks on Linux", () => {
  assert.match(popover, /if \(process\.platform === "linux"\) \{[\s\S]*?window\.setBounds\(placed\);[\s\S]*?\} else \{\s*window\.setPosition\(placed\.x, placed\.y\);/);
  assert.match(popover, /cursor: linux && linuxCursorIsReliable\(process\.env\) \? screen\.getCursorScreenPoint\(\) : null/);
});
