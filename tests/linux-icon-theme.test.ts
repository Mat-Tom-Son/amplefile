import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  cachedDirectoryLister,
  currentIconThemeName,
  directoryMatchesSize,
  directorySizeDistance,
  findIconFile,
  iconBaseDirs,
  iconThemeChain,
  isSafeIconName,
  isSafeIconThemeName,
  loadIconThemes,
  parseGVariantString,
  parseIconThemeIndex,
  parseKdeIconTheme,
  type IconTheme,
  type IconThemeDirectory,
} from "../desktop/src/linux-icon-theme.js";

function dir(fields: Partial<IconThemeDirectory> & { size: number }): IconThemeDirectory {
  return { path: "d", scale: 1, type: "Threshold", minSize: fields.size, maxSize: fields.size, threshold: 2, ...fields };
}

test("index.theme parsing reads inheritance, scaled directories and defaults", () => {
  const theme = parseIconThemeIndex("Example", [
    "[Icon Theme]",
    "Name=Example",
    "Inherits=Papirus, ../escape ,breeze",
    "Directories=16x16/apps,scalable/apps,broken,../up",
    "ScaledDirectories=16x16@2x/apps",
    "",
    "[16x16/apps]",
    "Size=16",
    "Type=Fixed",
    "",
    "[scalable/apps]",
    "Size=48",
    "Type=Scalable",
    "MinSize=8",
    "MaxSize=512",
    "",
    "[broken]",
    "Type=Fixed",
    "",
    "[../up]",
    "Size=16",
    "",
    "[16x16@2x/apps]",
    "Size=16",
    "Scale=2",
    "Context=Applications",
  ].join("\n"));
  assert.ok(theme);
  assert.deepEqual(theme.inherits, ["Papirus", "breeze"]);
  assert.deepEqual(theme.directories, [
    { path: "16x16/apps", size: 16, scale: 1, type: "Fixed", minSize: 16, maxSize: 16, threshold: 2 },
    { path: "scalable/apps", size: 48, scale: 1, type: "Scalable", minSize: 8, maxSize: 512, threshold: 2 },
    { path: "16x16@2x/apps", size: 16, scale: 2, type: "Threshold", minSize: 16, maxSize: 16, threshold: 2 },
  ]);
  assert.equal(parseIconThemeIndex("Nope", "[Desktop Entry]\nName=x\n"), null);
});

test("directory size matching and distance follow the spec", () => {
  assert.equal(directoryMatchesSize(dir({ size: 16, type: "Fixed" }), 16, 1), true);
  assert.equal(directoryMatchesSize(dir({ size: 16, type: "Fixed" }), 16, 2), false);
  assert.equal(directoryMatchesSize(dir({ size: 16, type: "Fixed", scale: 2 }), 16, 2), true);
  assert.equal(directoryMatchesSize(dir({ size: 48, type: "Scalable", minSize: 8, maxSize: 512 }), 16, 1), true);
  assert.equal(directoryMatchesSize(dir({ size: 18 }), 16, 1), true);
  assert.equal(directoryMatchesSize(dir({ size: 22 }), 16, 1), false);

  assert.equal(directorySizeDistance(dir({ size: 32, type: "Fixed" }), 16, 2), 0);
  assert.equal(directorySizeDistance(dir({ size: 48, type: "Fixed" }), 16, 1), 32);
  assert.equal(directorySizeDistance(dir({ size: 48, type: "Scalable", minSize: 24, maxSize: 512 }), 16, 1), 8);
  assert.equal(directorySizeDistance(dir({ size: 48, type: "Scalable", minSize: 8, maxSize: 512 }), 16, 2), 0);
  assert.equal(directorySizeDistance(dir({ size: 8, type: "Scalable", minSize: 4, maxSize: 8 }), 16, 1), 8);
  assert.equal(directorySizeDistance(dir({ size: 24 }), 16, 1), 8);
});

test("the theme chain is depth first, visits each theme once and ends with hicolor", () => {
  const theme = (name: string, inherits: string[]): IconTheme => ({ name, inherits, directories: [] });
  const themes = new Map([
    ["ThinkPad", theme("ThinkPad", ["Papirus-Dark", "Adwaita"])],
    ["Papirus-Dark", theme("Papirus-Dark", ["Papirus", "hicolor"])],
    ["Papirus", theme("Papirus", ["breeze", "hicolor", "ThinkPad"])],
    ["Adwaita", theme("Adwaita", ["hicolor"])],
    ["hicolor", theme("hicolor", [])],
  ]);
  assert.deepEqual(iconThemeChain("ThinkPad", themes).map((entry) => entry.name), ["ThinkPad", "Papirus-Dark", "Papirus", "hicolor", "Adwaita"]);
  assert.deepEqual(iconThemeChain("Missing", themes).map((entry) => entry.name), ["hicolor"]);
  assert.deepEqual(iconThemeChain("Adwaita", new Map([["Adwaita", theme("Adwaita", [])], ["hicolor", theme("hicolor", [])]])).map((entry) => entry.name), ["Adwaita", "hicolor"]);
});

test("theme and icon names cannot leave the icon directories", () => {
  assert.equal(isSafeIconThemeName("Papirus-Dark"), true);
  for (const name of ["", ".", "..", "a/b", "/abs", "x\0y"]) assert.equal(isSafeIconThemeName(name), false, name);
  assert.equal(isSafeIconName("org.gnome.TextEditor"), true);
  for (const name of ["", ".", "..", "a/b", "x\0y"]) assert.equal(isSafeIconName(name), false, name);
});

test("the current theme's name comes from portal, GSettings or kdeglobals output", async () => {
  assert.equal(parseGVariantString("(<'ThinkPad'>,)\n"), "ThinkPad");
  assert.equal(parseGVariantString("(<<'Papirus Dark'>>,)\n"), "Papirus Dark");
  assert.equal(parseGVariantString("'Adwaita'\n"), "Adwaita");
  assert.equal(parseGVariantString("''\n"), null);
  assert.equal(parseGVariantString("Error: No such interface"), null);
  assert.equal(parseKdeIconTheme("[General]\nName=x\n[Icons]\nTheme=breeze-dark\n"), "breeze-dark");

  const findTool = async (name: string) => `/usr/bin/${name}`;
  const calls: string[][] = [];
  const portal = await currentIconThemeName({ env: {}, home: "/nohome", findTool, run: async (command, args) => {
    calls.push([command, ...args]);
    return "(<'ThinkPad'>,)";
  } });
  assert.equal(portal, "ThinkPad");
  assert.equal(calls[0][0], "/usr/bin/gdbus");
  assert.ok(calls[0].includes("org.freedesktop.portal.Settings.ReadOne"));

  const gsettings = await currentIconThemeName({ env: {}, home: "/nohome", findTool, run: async (command) => {
    if (command.endsWith("gdbus")) throw new Error("no portal");
    return "'Papirus'\n";
  } });
  assert.equal(gsettings, "Papirus");

  const root = await mkdtemp(join(tmpdir(), "amplefile-icon-theme-"));
  try {
    await writeFile(join(root, "kdeglobals"), "[Icons]\nTheme=breeze\n");
    const kde = await currentIconThemeName({ env: { XDG_CONFIG_HOME: root }, home: "/nohome", findTool: async () => null });
    assert.equal(kde, "breeze");
    const unsafe = await currentIconThemeName({ env: {}, home: "/nohome", findTool, run: async () => "'../../etc'" });
    assert.equal(unsafe, "hicolor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("icon lookup follows the theme chain, sizes, scales and the pixmaps fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-icon-theme-"));
  const home = join(root, "home");
  const share = join(root, "usr/share");
  const write = async (path: string, text = "x") => {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
  };
  try {
    await write("home/.local/share/icons/Custom/index.theme", "[Icon Theme]\nName=Custom\nInherits=Base\nDirectories=22x22/places\n\n[22x22/places]\nSize=22\nType=Fixed\n");
    await write("home/.local/share/icons/Custom/22x22/places/folder.png");
    await write("usr/share/icons/Base/index.theme", [
      "[Icon Theme]", "Name=Base", "Directories=16x16/apps,48x48/apps,scalable/apps", "ScaledDirectories=16x16@2/apps",
      "[16x16/apps]", "Size=16", "Type=Fixed",
      "[16x16@2/apps]", "Size=16", "Scale=2", "Type=Fixed",
      "[48x48/apps]", "Size=48", "Type=Fixed",
      "[scalable/apps]", "Size=48", "Type=Scalable", "MinSize=32", "MaxSize=512",
    ].join("\n"));
    await write("usr/share/icons/Base/16x16/apps/editor.svg");
    await write("usr/share/icons/Base/16x16/apps/editor.png");
    await write("usr/share/icons/Base/16x16@2/apps/editor.png");
    await write("usr/share/icons/Base/48x48/apps/viewer.png");
    await write("usr/share/icons/Base/scalable/apps/viewer.svg");
    await write("usr/share/icons/Base/48x48/apps/big.png");
    await write("usr/share/icons/Base/16x16/apps/legacy.xpm");
    await write("usr/share/icons/hicolor/index.theme", "[Icon Theme]\nName=Hicolor\nDirectories=scalable/apps\n\n[scalable/apps]\nSize=16\nType=Scalable\nMinSize=1\nMaxSize=512\n");
    await write("usr/share/icons/hicolor/scalable/apps/only-hicolor.svg");
    // The user's data directory wins a theme directory that exists twice.
    await write("home/.local/share/icons/hicolor/scalable/apps/only-hicolor.svg");
    await write("pixmaps/old-app.png");

    const env = { XDG_DATA_HOME: join(home, ".local/share"), XDG_DATA_DIRS: share };
    const baseDirs = iconBaseDirs(env, home, []).map((dir) => dir === "/usr/share/pixmaps" ? join(root, "pixmaps") : dir);
    assert.deepEqual(baseDirs, [join(home, ".icons"), join(home, ".local/share/icons"), join(share, "icons"), join(root, "pixmaps")]);
    const themes = await loadIconThemes("Custom", baseDirs);
    assert.deepEqual([...themes.keys()].sort(), ["Base", "Custom", "hicolor"]);
    const chain = iconThemeChain("Custom", themes);
    const list = cachedDirectoryLister();
    const find = (icon: string | null, scale = 1) => findIconFile({ icon, size: 16, scale, chain, baseDirs, list });

    // PNG comes before SVG in the same directory, as the spec orders extensions.
    assert.deepEqual(await find("editor"), { path: join(share, "icons/Base/16x16/apps/editor.png"), format: "png" });
    assert.deepEqual(await find("editor", 2), { path: join(share, "icons/Base/16x16@2/apps/editor.png"), format: "png" });
    // No exact match: the nearest directory (scalable from 32 px is nearer than 48 px fixed).
    assert.deepEqual(await find("viewer"), { path: join(share, "icons/Base/scalable/apps/viewer.svg"), format: "svg" });
    assert.deepEqual(await find("big"), { path: join(share, "icons/Base/48x48/apps/big.png"), format: "png" });
    assert.deepEqual(await find("viewer", 2), { path: join(share, "icons/Base/scalable/apps/viewer.svg"), format: "svg" });
    assert.deepEqual(await find("only-hicolor"), { path: join(home, ".local/share/icons/hicolor/scalable/apps/only-hicolor.svg"), format: "svg" });
    assert.deepEqual(await find("folder"), { path: join(home, ".local/share/icons/Custom/22x22/places/folder.png"), format: "png" });
    assert.deepEqual(await find("old-app"), { path: join(root, "pixmaps/old-app.png"), format: "png" });
    assert.equal(await find("legacy"), null);
    assert.equal(await find("missing"), null);
    assert.equal(await find("../Base/16x16/apps/editor"), null);
    assert.equal(await find(null), null);
    // An absolute Icon= path is used only when it names an existing PNG or SVG.
    const absolute = join(share, "icons/Base/scalable/apps/viewer.svg");
    assert.deepEqual(await find(absolute), { path: absolute, format: "svg" });
    assert.equal(await find(join(share, "icons/Base/16x16/apps/legacy.xpm")), null);
    assert.equal(await find(join(share, "icons/Base/nothing.png")), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SVG icons are drawn by a locked-down offscreen renderer, bounded, and never hold up the menu", async () => {
  const source = await readFile(new URL("../desktop/src/linux-menu-icons.ts", import.meta.url), "utf8");
  const chooser = await readFile(new URL("../desktop/src/open-with-linux-chooser.ts", import.meta.url), "utf8");
  // An <img> is Chromium's script-free, fetch-free "SVG as image" mode.
  assert.match(source, /<img alt="" src="\$\{source\}"/);
  assert.match(source, /content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"/);
  assert.match(source, /offscreen: \{ useSharedTexture: false, deviceScaleFactor: 1 \}/);
  assert.match(source, /javascript: false,\s*sandbox: true,\s*contextIsolation: true,\s*nodeIntegration: false/);
  // An in-memory partition ("persist:" would write to disk) that refuses the network and permissions.
  assert.match(source, /const rasterPartition = "amplefile-linux-icon-raster";/);
  assert.match(source, /callback\(\{ cancel: !details\.url\.startsWith\("data:"\) \}\)/);
  assert.match(source, /setPermissionRequestHandler\(\(_contents, _permission, callback\) => callback\(false\)\)/);
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(source, /const maxSvgBytes = 512 \* 1024;/);
  assert.match(source, /const maxPngBytes = 1024 \* 1024;/);
  assert.match(source, /if \(!info\.isFile\(\) \|\| info\.size > limit\) return null;/);
  // Late icons are left out of this menu; the chooser passes a deadline.
  assert.match(source, /Promise\.race\(\[image, deadline\]\)/);
  assert.match(chooser, /linuxMenuIcons\(choices\.apps\.map\(\(app\) => app\.icon\), \{ env, home, deadlineMs: menuIconDeadlineMs \}\)/);
});
