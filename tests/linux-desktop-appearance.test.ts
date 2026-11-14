import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  fallbackWindowButtonLayout,
  isKdeDesktop,
  linuxNativeThemeSource,
  parseGnomeButtonLayout,
  parseGVariantText,
  parseKdeButtonLayout,
  parseLinuxWindowChromeState,
  parsePortalReadOutput,
  parseSettingChangedLine,
  portalAccentColor,
  portalColorScheme,
  portalHighContrast,
} from "../src/shared/linux-desktop-appearance.js";
import { LinuxDesktopSettings } from "../desktop/src/linux-desktop-settings.js";

test("GNOME button layouts keep their sides and order and leave out what AmpleFile does not draw", () => {
  assert.deepEqual(parseGnomeButtonLayout("appmenu:close"), { left: [], right: ["close"] }, "GNOME's default");
  assert.deepEqual(parseGnomeButtonLayout("appmenu:minimize,close"), { left: [], right: ["minimize", "close"] });
  assert.deepEqual(parseGnomeButtonLayout("close,minimize,maximize:appmenu"), { left: ["close", "minimize", "maximize"], right: [] }, "elementary/macOS-like left side");
  assert.deepEqual(parseGnomeButtonLayout(":minimize,maximize,close"), { left: [], right: ["minimize", "maximize", "close"] });
  assert.deepEqual(parseGnomeButtonLayout("appmenu:"), { left: [], right: [] }, "no buttons at all, as tiling setups often choose");
  assert.deepEqual(parseGnomeButtonLayout("icon, spacer ,close:maximize,close,bogus"), { left: ["close"], right: ["maximize"] }, "a duplicate keeps its first place");
  assert.equal(parseGnomeButtonLayout("close,minimize"), null, "no colon is no layout");
  assert.equal(parseGnomeButtonLayout(42), null);
  assert.equal(parseGnomeButtonLayout(undefined), null);
});

test("KDE's kwinrc button letters map to the three window buttons, with KDE's defaults when unset", () => {
  assert.deepEqual(parseKdeButtonLayout(""), { left: [], right: ["minimize", "maximize", "close"] });
  assert.deepEqual(parseKdeButtonLayout("[org.kde.kdecoration2]\nButtonsOnLeft=XIA\nButtonsOnRight=H\n"), { left: ["close", "minimize", "maximize"], right: [] });
  assert.deepEqual(parseKdeButtonLayout("[Windows]\nButtonsOnRight=X\n[org.kde.kdecoration2]\nButtonsOnRight=IX\nBorderSize=Normal\n"), { left: [], right: ["minimize", "close"] }, "other groups are ignored");
  assert.deepEqual(parseKdeButtonLayout("[org.kde.kdecoration2]\nButtonsOnLeft=\nButtonsOnRight=\n"), { left: [], right: [] });
  assert.equal(isKdeDesktop("KDE"), true);
  assert.equal(isKdeDesktop("ubuntu:GNOME"), false);
  assert.equal(isKdeDesktop(undefined), false);
});

test("the portal's accent is an sRGB triple in 0..1; anything else means no accent", () => {
  // What this Fedora/niri host's GNOME portal returned for GNOME's red accent.
  assert.equal(portalAccentColor([0.90196079015731812, 0.17647059261798859, 0.25882354378700256]), "#e62d42");
  assert.equal(portalAccentColor([0, 0, 0]), "#000000");
  assert.equal(portalAccentColor([1, 1, 1]), "#ffffff");
  assert.equal(portalAccentColor([1.5, -1, 0]), null, "out of range is unset");
  assert.equal(portalAccentColor([-1, -1, -1]), null);
  assert.equal(portalAccentColor([0.1, 0.2]), null);
  assert.equal(portalAccentColor("#ff0000"), null);
  assert.equal(portalAccentColor(undefined), null);
  assert.equal(portalAccentColor([Number.NaN, 0, 0]), null);
});

test("color scheme and contrast read the portal's enumerations", () => {
  assert.equal(portalColorScheme(1), "dark");
  assert.equal(portalColorScheme(2), "light");
  assert.equal(portalColorScheme(0), null);
  assert.equal(portalColorScheme(undefined), null);
  assert.equal(portalHighContrast(1), true);
  assert.equal(portalHighContrast(0), false);
  assert.equal(linuxNativeThemeSource("system", "dark"), "dark");
  assert.equal(linuxNativeThemeSource("system", null), "system");
  assert.equal(linuxNativeThemeSource("light", "dark"), "light", "an explicit Appearance mode wins");
});

test("gdbus output parses into values, through ReadOne's and Read's variant wrapping", () => {
  assert.equal(parsePortalReadOutput("(<uint32 1>,)\n"), 1);
  assert.equal(parsePortalReadOutput("(<'appmenu:minimize,close'>,)\n"), "appmenu:minimize,close");
  assert.deepEqual(parsePortalReadOutput("(<(0.90196079015731812, 0.17647059261798859, 0.25882354378700256)>,)"), [0.90196079015731812, 0.17647059261798859, 0.25882354378700256]);
  assert.deepEqual(parsePortalReadOutput("(<<(1.5, -1.0, 0.0)>>,)"), [1.5, -1, 0], "the older Read wraps twice");
  assert.deepEqual(parseGVariantText("(@as [], [1, 2], true, 'it\\'s')"), [[], [1, 2], true, "it's"]);
  assert.throws(() => parseGVariantText("(<uint32 1>,) trailing"));
  assert.throws(() => parseGVariantText("('unterminated"));
  assert.throws(() => parsePortalReadOutput("(1, 2)"));
});

test("gdbus monitor lines become setting changes; other lines are ignored", () => {
  assert.deepEqual(
    parseSettingChangedLine("/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'color-scheme', <uint32 1>)"),
    { namespace: "org.freedesktop.appearance", key: "color-scheme", value: 1 },
  );
  assert.deepEqual(
    parseSettingChangedLine("/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.gnome.desktop.wm.preferences', 'button-layout', <'appmenu:'>)"),
    { namespace: "org.gnome.desktop.wm.preferences", key: "button-layout", value: "appmenu:" },
  );
  assert.equal(parseSettingChangedLine("Monitoring signals on object /org/freedesktop/portal/desktop owned by org.freedesktop.portal.Desktop"), null);
  assert.equal(parseSettingChangedLine("/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged (garbage"), null);
});

test("chrome state from IPC is checked before the title bar draws it", () => {
  assert.deepEqual(parseLinuxWindowChromeState({ buttonLayout: { left: ["close"], right: [] }, maximized: true, fullScreen: false, focused: false, highContrast: true }),
    { buttonLayout: { left: ["close"], right: [] }, maximized: true, fullScreen: false, focused: false, highContrast: true });
  assert.equal(parseLinuxWindowChromeState({ buttonLayout: { left: ["shade"], right: [] } }), null);
  assert.equal(parseLinuxWindowChromeState({ buttonLayout: { left: [] } }), null);
  assert.equal(parseLinuxWindowChromeState(null), null);
});

class FakeMonitor extends EventEmitter {
  stdout = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill() { this.killed = true; return true; }
}

function portal(values: Record<string, string>) {
  const calls: string[][] = [];
  const gdbus = async (args: string[]) => {
    calls.push(args);
    const key = `${args.at(-2)} ${args.at(-1)}`;
    const value = values[key];
    if (value === undefined) throw Object.assign(new Error("GDBus.Error:org.freedesktop.portal.Error.NotFound: Requested setting not found"), { stderr: "Error: GDBus.Error:org.freedesktop.portal.Error.NotFound" });
    return value;
  };
  return { gdbus, calls };
}

const hostValues = {
  "org.freedesktop.appearance accent-color": "(<(0.90196079015731812, 0.17647059261798859, 0.25882354378700256)>,)\n",
  "org.freedesktop.appearance color-scheme": "(<uint32 1>,)\n",
  "org.freedesktop.appearance contrast": "(<uint32 0>,)\n",
  "org.gnome.desktop.wm.preferences button-layout": "(<'appmenu:minimize,close'>,)\n",
};

test("the settings follower reads the portal, then follows its SettingChanged signals until stopped", async () => {
  const { gdbus } = portal(hostValues);
  const monitor = new FakeMonitor();
  const changes: unknown[] = [];
  let monitorArgs: string[] = [];
  const settings = new LinuxDesktopSettings({
    env: { XDG_CURRENT_DESKTOP: "niri" },
    gdbus,
    spawnMonitor: (args) => { monitorArgs = args; return monitor as unknown as ChildProcess; },
    onChange: (next) => changes.push(next),
  });
  await settings.start();
  assert.deepEqual(settings.current(), { accentColor: "#e62d42", colorScheme: "dark", highContrast: false, buttonLayout: { left: [], right: ["minimize", "close"] } });
  assert.deepEqual(monitorArgs, ["monitor", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop"]);
  assert.equal(changes.length, 1);

  monitor.stdout.write("/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'accent-color', <(-1.0, -1.0, -1.0)>)\n");
  monitor.stdout.write("/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.gnome.desktop.wm.preferences', 'button-layout', <'close:'>)\n");
  monitor.stdout.write("/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.freedesktop.appearance', 'contrast', <uint32 1>)\n");
  monitor.stdout.write("/org/freedesktop/portal/desktop: org.freedesktop.portal.Settings.SettingChanged ('org.gnome.desktop.interface', 'font-name', <'Cantarell 11'>)\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settings.current(), { accentColor: null, colorScheme: "dark", highContrast: true, buttonLayout: { left: ["close"], right: [] } });
  assert.equal(changes.length, 4, "an unrelated setting changes nothing");

  settings.stop();
  assert.equal(monitor.killed, true);
  assert.equal(monitor.stdin.destroyed, true, "closing stdin also stops the wrapped gdbus");
});

test("without gdbus or a portal, everything stays at today's fallback and no monitor starts", async () => {
  let spawned = false;
  const missing = new LinuxDesktopSettings({
    env: {},
    gdbus: async () => { throw Object.assign(new Error("spawn gdbus ENOENT"), { code: "ENOENT" }); },
    spawnMonitor: () => { spawned = true; return new FakeMonitor() as unknown as ChildProcess; },
    onChange: () => assert.fail("nothing changes"),
  });
  await missing.start();
  assert.equal(spawned, false);
  assert.deepEqual(missing.current(), { accentColor: null, colorScheme: null, highContrast: false, buttonLayout: fallbackWindowButtonLayout });

  const { gdbus } = portal({});
  const empty = new LinuxDesktopSettings({ env: {}, gdbus, spawnMonitor: () => new FakeMonitor() as unknown as ChildProcess, onChange: () => assert.fail("nothing changes") });
  await empty.start();
  assert.deepEqual(empty.current().buttonLayout, fallbackWindowButtonLayout);
  empty.stop();
});

test("an older portal without ReadOne is read through Read, and a portal that appears later is read again", async () => {
  const calls: string[] = [];
  let available = false;
  const gdbus = async (args: string[]) => {
    const method = args[args.indexOf("--method") + 1]!;
    calls.push(method);
    if (!available) throw Object.assign(new Error("no owner"), { stderr: "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown" });
    if (method.endsWith(".ReadOne")) throw Object.assign(new Error("x"), { stderr: "GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such method “ReadOne”" });
    return args.at(-1) === "color-scheme" ? "(<<uint32 2>>,)" : args.at(-1) === "button-layout" ? "(<<'close,maximize:'>>,)" : "(<<uint32 0>>,)";
  };
  const monitor = new FakeMonitor();
  const settings = new LinuxDesktopSettings({ env: {}, gdbus, spawnMonitor: () => monitor as unknown as ChildProcess, onChange: () => {} });
  await settings.start();
  assert.equal(settings.current().colorScheme, null);
  available = true;
  monitor.stdout.write("The name org.freedesktop.portal.Desktop is owned by :1.42\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settings.current().colorScheme, "light");
  assert.deepEqual(settings.current().buttonLayout, { left: ["close", "maximize"], right: [] });
  assert.ok(calls.some((method) => method.endsWith(".Read")));
  settings.stop();
});

test("on KDE Plasma the button layout comes from kwinrc, not GNOME's key", async () => {
  const { gdbus } = portal(hostValues);
  const read: string[] = [];
  const settings = new LinuxDesktopSettings({
    env: { XDG_CURRENT_DESKTOP: "KDE", XDG_CONFIG_HOME: "/home/me/.config" },
    gdbus,
    spawnMonitor: () => new FakeMonitor() as unknown as ChildProcess,
    readTextFile: async (path) => { read.push(path); return "[org.kde.kdecoration2]\nButtonsOnLeft=X\nButtonsOnRight=IA\n"; },
    onChange: () => {},
  });
  await settings.start();
  assert.deepEqual(read, ["/home/me/.config/kwinrc"]);
  assert.deepEqual(settings.current().buttonLayout, { left: ["close"], right: ["minimize", "maximize"] });
  settings.applyChange("org.gnome.desktop.wm.preferences", "button-layout", "appmenu:close");
  assert.deepEqual(settings.current().buttonLayout, { left: ["close"], right: ["minimize", "maximize"] });
  settings.stop();
});

test("the real monitor wrapper stops gdbus when AmpleFile's end of its stdin closes", async () => {
  const source = await readFile(new URL("../desktop/src/linux-desktop-settings.ts", import.meta.url), "utf8");
  assert.match(source, /exec 3<&0; gdbus "\$@" <\/dev\/null & child=\$!; \( read -r _ <&3; kill "\$child" 2>\/dev\/null \) & exec 3<&-; wait "\$child"/);
});

test("Linux menus and window chrome: Close Tab, Close Window, Paste and Match Style, and no Electron overlay", async () => {
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /\{ id: "close-tab", label: "Close Tab", accelerator: "Control\+W", enabled: rendererMenuState\.connectedFolderOpen, click: \(\) => sendRendererMenuCommand\("close-tab"\) \}/);
  assert.match(main, /\{ role: "close", label: "Close Window", accelerator: "Shift\+Control\+W" \}/);
  assert.match(main, /process\.platform === "linux" \? \[\{ role: "pasteAndMatchStyle" as const, accelerator: "Shift\+Control\+V" \}\]/);
  // The Mac items stay exactly as they were.
  assert.match(main, /\{ id: "close-tab", label: "Close Tab", accelerator: "CommandOrControl\+W", enabled: rendererMenuState\.connectedFolderOpen, click: \(\) => sendRendererMenuCommand\("close-tab"\) \},\n\s*\{ role: "close", accelerator: "Shift\+CommandOrControl\+W" \},/);
  // Only Windows asks Electron for the title-bar overlay.
  const options = main.slice(main.indexOf("mainWindow = new BrowserWindow({"), main.indexOf("show: false,", main.indexOf("mainWindow = new BrowserWindow({")));
  assert.equal(options.match(/titleBarOverlay:/g)?.length, 1);
  assert.match(options, /\.\.\.\(process\.platform === "win32" \? \{\n[^\n]*\n\s*titleBarStyle: "hidden",\n\s*titleBarOverlay: titleBarOverlayFor/);
});
