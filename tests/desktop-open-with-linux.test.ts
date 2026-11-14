import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openFileWithPickedApp, openWithDialogOptions, type OpenWithLaunchPlan } from "../desktop/src/open-with.js";
import {
  applicationsDirs,
  currentDesktops,
  desktopAppFromEntry,
  desktopAppFromFile,
  desktopFileId,
  desktopLocaleKeys,
  detectMimeType,
  expandDesktopExec,
  findDesktopIconPng,
  isDesktopAppShown,
  linuxLaunchEnvironment,
  linuxOpenWithChoices,
  linuxOpenWithLaunchPlan,
  loadDesktopApps,
  mimeAppsListPaths,
  mimeTypeFromGlobs,
  mimeTypeLineage,
  openWithMenuLabels,
  parseDesktopEntry,
  parseGioContentType,
  parseMimeAppsList,
  parseMimeDatabase,
  resolveMimeHandlers,
  splitDesktopList,
  tokenizeDesktopExec,
  unescapeDesktopString,
  xdgDataDirs,
  type LinuxDesktopApp,
} from "../desktop/src/open-with-linux.js";

function entry(fields: Record<string, string>, group = "Desktop Entry"): string {
  return `[${group}]\n${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function app(id: string, overrides: Partial<LinuxDesktopApp> = {}): LinuxDesktopApp {
  return {
    id,
    path: `/usr/share/applications/${id}`,
    source: "system",
    name: id.replace(/\.desktop$/, ""),
    exec: `${id.replace(/\.desktop$/, "")} %F`,
    tryExec: null,
    icon: null,
    workingDirectory: null,
    terminal: false,
    dbusActivatable: false,
    noDisplay: false,
    hidden: false,
    onlyShowIn: [],
    notShowIn: [],
    mimeTypes: [],
    ...overrides,
  };
}

async function fixture(): Promise<{ root: string; write: (path: string, text: string) => Promise<string>; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "amplefile-open-with-"));
  return {
    root,
    write: async (path, text) => {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text);
      return full;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Parsing

test("desktop entries keep groups, ignore comments, and keep the first duplicate key", () => {
  const groups = parseDesktopEntry([
    "# comment",
    "[Desktop Entry]",
    "Name=First",
    "Name=Second",
    "  Exec = editor %f",
    "Name[de]=Erster",
    "bad key=x",
    "[Desktop Action new-window]",
    "Name=New Window",
    "[Desktop Entry]",
    "Name=Duplicate group ignored",
  ].join("\n"));
  assert.equal(groups.get("Desktop Entry")?.get("Name"), "First");
  assert.equal(groups.get("Desktop Entry")?.get("Exec"), "editor %f");
  assert.equal(groups.get("Desktop Entry")?.get("Name[de]"), "Erster");
  assert.equal(groups.get("Desktop Entry")?.has("bad key"), false);
  assert.equal(groups.get("Desktop Action new-window")?.get("Name"), "New Window");
});

test("string escapes and semicolon lists follow the spec", () => {
  assert.equal(unescapeDesktopString("a\\sb\\nc\\td\\\\e\\;"), "a b\nc\td\\e\\;");
  assert.deepEqual(splitDesktopList("text/plain;text/x-c\\;odd;;image/png"), ["text/plain", "text/x-c;odd", "image/png"]);
  assert.deepEqual(splitDesktopList(""), []);
});

test("locale keys go from most to least specific and C has none", () => {
  assert.deepEqual(desktopLocaleKeys({ LANG: "sr_RS.UTF-8@latin" }), ["sr_RS@latin", "sr_RS", "sr@latin", "sr"]);
  assert.deepEqual(desktopLocaleKeys({ LC_ALL: "de_DE.UTF-8", LANG: "fr_FR.UTF-8" }), ["de_DE", "de"]);
  assert.deepEqual(desktopLocaleKeys({ LC_MESSAGES: "pt_BR", LANG: "en_US.UTF-8" }), ["pt_BR", "pt"]);
  assert.deepEqual(desktopLocaleKeys({ LC_ALL: "C.UTF-8" }), []);
  assert.deepEqual(desktopLocaleKeys({}), []);
});

test("application entries use localized names and skip non-applications", () => {
  const text = entry({ Type: "Application", Name: "Text Editor", "Name[de]": "Texteditor", "Name[de_AT]": "Texteditor (AT)", Exec: "gnome-text-editor %U", MimeType: "Text/Plain;", Icon: "org.gnome.TextEditor", NoDisplay: "false", OnlyShowIn: "GNOME;Unity;" });
  const parsed = desktopAppFromEntry({ id: "org.gnome.TextEditor.desktop", path: "/x/org.gnome.TextEditor.desktop", source: "system", text, env: { LANG: "de_DE.UTF-8" } });
  assert.equal(parsed?.name, "Texteditor");
  assert.deepEqual(parsed?.mimeTypes, ["text/plain"]);
  assert.deepEqual(parsed?.onlyShowIn, ["GNOME", "Unity"]);
  assert.equal(desktopAppFromEntry({ id: "a", path: "/a", source: "system", text, env: { LANG: "de_AT.UTF-8" } })?.name, "Texteditor (AT)");
  assert.equal(desktopAppFromEntry({ id: "a", path: "/a", source: "system", text, env: { LANG: "ja_JP.UTF-8" } })?.name, "Text Editor");
  assert.equal(desktopAppFromEntry({ id: "l", path: "/l", source: "system", text: entry({ Type: "Link", Name: "Web", URL: "https://example.com" }), env: {} }), null);
  assert.equal(desktopAppFromEntry({ id: "n", path: "/n", source: "system", text: entry({ Type: "Application", Exec: "x" }), env: {} }), null);
  assert.equal(desktopAppFromEntry({ id: "e", path: "/e", source: "system", text: entry({ Type: "Application", Name: "No Exec" }), env: {} }), null);
  assert.equal(desktopAppFromEntry({ id: "d", path: "/d", source: "system", text: entry({ Type: "Application", Name: "Bus", DBusActivatable: "true" }), env: {} })?.dbusActivatable, true);
  assert.equal(desktopAppFromEntry({ id: "h", path: "/h", source: "user", text: entry({ Hidden: "true" }), env: {} })?.hidden, true);
  assert.equal(desktopAppFromEntry({ id: "g", path: "/g", source: "user", text: entry({ Type: "Application", Name: "x", Exec: "x" }, "Other Group"), env: {} }), null);
});

test("visibility honors NoDisplay, Hidden, OnlyShowIn, and NotShowIn against every current desktop", () => {
  assert.equal(isDesktopAppShown(app("a.desktop"), ["niri"]), true);
  assert.equal(isDesktopAppShown(app("a.desktop", { noDisplay: true }), ["niri"]), false);
  assert.equal(isDesktopAppShown(app("a.desktop", { hidden: true }), ["niri"]), false);
  assert.equal(isDesktopAppShown(app("a.desktop", { onlyShowIn: ["GNOME"] }), ["niri"]), false);
  assert.equal(isDesktopAppShown(app("a.desktop", { onlyShowIn: ["GNOME"] }), ["ubuntu", "GNOME"]), true);
  assert.equal(isDesktopAppShown(app("a.desktop", { notShowIn: ["KDE"] }), ["kde"]), false);
  assert.equal(isDesktopAppShown(app("a.desktop", { notShowIn: ["KDE"] }), []), true);
  assert.deepEqual(currentDesktops({ XDG_CURRENT_DESKTOP: "Unity", ORIGINAL_XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }), ["ubuntu", "GNOME"]);
  assert.deepEqual(currentDesktops({}), []);
});

// ---------------------------------------------------------------------------
// Directories

test("data directories default sensibly, keep precedence, and add Flatpak and Snap only when missing", () => {
  const home = "/home/me";
  assert.deepEqual(xdgDataDirs({}, home), [
    "/home/me/.local/share",
    "/usr/local/share",
    "/usr/share",
    "/home/me/.local/share/flatpak/exports/share",
    "/var/lib/flatpak/exports/share",
    "/var/lib/snapd/desktop",
  ]);
  assert.deepEqual(xdgDataDirs({ XDG_DATA_HOME: "/data/home/", XDG_DATA_DIRS: "/var/lib/flatpak/exports/share/:relative:/usr/share/" }, home), [
    "/data/home",
    "/var/lib/flatpak/exports/share",
    "/usr/share",
    "/home/me/.local/share/flatpak/exports/share",
    "/var/lib/snapd/desktop",
  ]);
  assert.deepEqual(applicationsDirs({ XDG_DATA_DIRS: "/usr/share" }, home).map((dir) => dir.source), ["user", "system", "flatpak", "flatpak", "snap"]);
  assert.equal(desktopFileId("/usr/share/applications", "/usr/share/applications/kde4/okular.desktop"), "kde4-okular.desktop");
});

test("mimeapps.list files are listed per desktop first, in spec order", () => {
  const paths = mimeAppsListPaths({ XDG_CONFIG_HOME: "/c", XDG_CONFIG_DIRS: "/etc/xdg", XDG_DATA_HOME: "/d", XDG_DATA_DIRS: "/usr/share" }, "/home/me", ["niri"], []);
  assert.deepEqual(paths, [
    "/c/niri-mimeapps.list", "/c/mimeapps.list",
    "/etc/xdg/niri-mimeapps.list", "/etc/xdg/mimeapps.list",
    "/d/applications/niri-mimeapps.list", "/d/applications/mimeapps.list",
    "/usr/share/applications/niri-mimeapps.list", "/usr/share/applications/mimeapps.list",
  ]);
});

// ---------------------------------------------------------------------------
// MIME

const mimeDatabase = parseMimeDatabase({
  aliases: "application/x-pdf application/pdf\ntext/x-markdown text/markdown\n",
  subclasses: "text/markdown text/plain\ntext/x-python application/x-executable\ntext/x-python text/plain\napplication/x-executable application/octet-stream\n",
  globs2: "# comment\n50:text/plain:*.txt\n50:text/markdown:*.md\n50:application/pdf:*.pdf\n55:application/x-tar:*.tar\n50:application/x-compressed-tar:*.tar.gz\n50:text/x-makefile:makefile\n50:text/x-c:*.C:cs\n",
});

test("type lineage resolves aliases, subclasses, and text/plain but leaves out octet-stream", () => {
  assert.deepEqual(mimeTypeLineage("text/x-markdown", mimeDatabase), ["text/x-markdown", "text/markdown", "text/plain"]);
  assert.deepEqual(mimeTypeLineage("text/x-python", mimeDatabase), ["text/x-python", "application/x-executable", "text/plain"]);
  assert.deepEqual(mimeTypeLineage("text/csv", mimeDatabase), ["text/csv", "text/plain"]);
  assert.deepEqual(mimeTypeLineage("application/octet-stream", mimeDatabase), ["application/octet-stream"]);
  assert.deepEqual(mimeTypeLineage("IMAGE/PNG", mimeDatabase), ["image/png"]);
});

test("glob matching prefers weight, then the longer pattern, and honors case sensitivity", () => {
  assert.equal(mimeTypeFromGlobs("Notes.TXT", mimeDatabase.globs), "text/plain");
  assert.equal(mimeTypeFromGlobs("a.tar.gz", mimeDatabase.globs), "application/x-compressed-tar");
  assert.equal(mimeTypeFromGlobs("a.tar", mimeDatabase.globs), "application/x-tar");
  assert.equal(mimeTypeFromGlobs("Makefile", mimeDatabase.globs), "text/x-makefile");
  assert.equal(mimeTypeFromGlobs("x.C", mimeDatabase.globs), "text/x-c");
  assert.equal(mimeTypeFromGlobs("x.c", mimeDatabase.globs), null);
  assert.equal(mimeTypeFromGlobs("$(x).pdf", mimeDatabase.globs), "application/pdf");
  assert.equal(mimeTypeFromGlobs("no-extension", mimeDatabase.globs), null);
});

test("gio's content type is parsed strictly", () => {
  assert.equal(parseGioContentType("uri: file:///a\nattributes:\n  standard::content-type: text/plain\n"), "text/plain");
  assert.equal(parseGioContentType("attributes:\n  standard::content-type: not a type\n"), null);
  assert.equal(parseGioContentType(""), null);
});

test("type detection prefers gio, then xdg-mime, then globs, with the absolute path as its own argument", async () => {
  const calls: Array<[string, string[]]> = [];
  const path = "/folder/--version";
  assert.equal(await detectMimeType(path, { gio: "/usr/bin/gio", xdgMime: "/usr/bin/xdg-mime", database: mimeDatabase, run: async (command, args) => { calls.push([command, args]); return "  standard::content-type: image/png\n"; } }), "image/png");
  assert.deepEqual(calls, [["/usr/bin/gio", ["info", "-a", "standard::content-type", "/folder/--version"]]]);
  assert.equal(await detectMimeType("/f/a.txt", { gio: "/usr/bin/gio", xdgMime: "/usr/bin/xdg-mime", database: mimeDatabase, run: async (command) => { if (command.endsWith("gio")) throw new Error("no"); return "application/pdf\n"; } }), "application/pdf");
  assert.equal(await detectMimeType("/f/a.txt", { gio: null, xdgMime: null, database: mimeDatabase }), "text/plain");
  assert.equal(await detectMimeType("/f/blob", { gio: null, xdgMime: null, database: mimeDatabase }), "application/octet-stream");
  await assert.rejects(detectMimeType("relative.txt", { gio: null, xdgMime: null, database: mimeDatabase }), /absolute/);
});

// ---------------------------------------------------------------------------
// Associations

test("mimeapps.list sections are parsed by type", () => {
  const list = parseMimeAppsList("[Default Applications]\ntext/plain=b.desktop;a.desktop;\n[Added Associations]\nText/Plain=c.desktop;\n[Removed Associations]\ntext/plain=d.desktop\n");
  assert.deepEqual(list.defaults.get("text/plain"), ["b.desktop", "a.desktop"]);
  assert.deepEqual(list.added.get("text/plain"), ["c.desktop"]);
  assert.deepEqual(list.removed.get("text/plain"), ["d.desktop"]);
});

test("associations: added first, removed hides lower precedence, defaults pick the first installed", () => {
  const apps = new Map([
    ["editor.desktop", app("editor.desktop", { mimeTypes: ["text/plain"] })],
    ["office.desktop", app("office.desktop", { mimeTypes: ["text/plain"] })],
    ["unwanted.desktop", app("unwanted.desktop", { mimeTypes: ["text/plain"] })],
    ["added.desktop", app("added.desktop")],
    ["md.desktop", app("md.desktop", { mimeTypes: ["text/markdown"] })],
    ["gnome-only.desktop", app("gnome-only.desktop", { mimeTypes: ["text/plain"], onlyShowIn: ["GNOME"] })],
    ["helper.desktop", app("helper.desktop", { mimeTypes: ["text/plain"], noDisplay: true })],
  ]);
  const user = parseMimeAppsList("[Default Applications]\ntext/markdown=missing.desktop;office.desktop\n[Added Associations]\ntext/plain=added.desktop;missing.desktop\n[Removed Associations]\ntext/plain=unwanted.desktop;added.desktop\n");
  const system = parseMimeAppsList("[Default Applications]\ntext/plain=unwanted.desktop;editor.desktop\n[Added Associations]\ntext/plain=unwanted.desktop\n");
  const resolved = resolveMimeHandlers({ lineage: ["text/markdown", "text/plain"], apps, mimeAppsLists: [user, system], desktops: ["niri"] });
  // office is the explicit default for markdown; added.desktop survives because
  // a file's own removals only apply to lower precedence; unwanted is removed;
  // GNOME-only and NoDisplay apps are not offered.
  assert.deepEqual(resolved, { ids: ["office.desktop", "md.desktop", "added.desktop", "editor.desktop"], defaultId: "office.desktop" });

  const plain = resolveMimeHandlers({ lineage: ["text/plain"], apps, mimeAppsLists: [user, system], desktops: ["niri"] });
  // The system default's first choice was removed by the user file, so the next installed one wins.
  assert.equal(plain.defaultId, "editor.desktop");
  assert.equal(plain.ids[0], "editor.desktop");
});

test("without an explicit default the first shown handler leads, and a NoDisplay default is still offered", () => {
  const apps = new Map([
    ["hidden-handler.desktop", app("hidden-handler.desktop", { mimeTypes: ["image/png"], noDisplay: true })],
    ["viewer.desktop", app("viewer.desktop", { mimeTypes: ["image/png"] })],
  ]);
  assert.deepEqual(resolveMimeHandlers({ lineage: ["image/png"], apps, mimeAppsLists: [], desktops: [] }), { ids: ["viewer.desktop"], defaultId: "viewer.desktop" });
  const chosen = parseMimeAppsList("[Default Applications]\nimage/png=hidden-handler.desktop\n");
  assert.deepEqual(resolveMimeHandlers({ lineage: ["image/png"], apps, mimeAppsLists: [chosen], desktops: [] }), { ids: ["hidden-handler.desktop", "viewer.desktop"], defaultId: "hidden-handler.desktop" });
  assert.deepEqual(resolveMimeHandlers({ lineage: ["video/mp4"], apps, mimeAppsLists: [], desktops: [] }), { ids: [], defaultId: null });
});

test("menu labels name the packaging when two handlers share a name", () => {
  const labels = openWithMenuLabels([
    app("google-chrome.desktop", { name: "Google Chrome" }),
    app("com.google.Chrome.desktop", { name: "Google Chrome", source: "flatpak" }),
    app("org.gnome.Papers.desktop", { name: "Papers" }),
  ]);
  assert.deepEqual([...labels.values()], ["Google Chrome (google-chrome)", "Google Chrome (Flatpak)", "Papers"]);
});

// ---------------------------------------------------------------------------
// Exec expansion

const hostile = [
  "/home/me/Folder/--version",
  "/home/me/Folder/$(touch pwned)",
  "/home/me/Folder/`id`.txt",
  "/home/me/Folder/a b \"quoted\" 'single'.txt",
  "/home/me/Folder/line\nbreak;rm -rf ~.txt",
  "/home/me/Folder/100% %f %u.txt",
  "/home/me/Folder/-e",
];

test("field codes expand into exactly one argument per file, whatever the name", () => {
  for (const filePath of hostile) {
    const argv = expandDesktopExec("editor --new-window %f", { filePath, name: "Editor", icon: null, desktopFilePath: "/a/editor.desktop" });
    assert.deepEqual(argv, ["editor", "--new-window", filePath]);
    const uri = expandDesktopExec("viewer %U", { filePath, name: "Viewer", icon: null, desktopFilePath: null });
    assert.equal(uri.length, 2);
    assert.match(uri[1], /^file:\/\/\//);
    assert.equal(decodeURIComponent(new URL(uri[1]).pathname), filePath);
    assert.doesNotMatch(uri[1], /[\s"`\n]/);
  }
});

test("field codes: %F, %u, %i, %c, %k, %%, deprecated codes, and codes inside words", () => {
  const input = { filePath: "/f/a b.txt", name: "My App", icon: "my-icon", desktopFilePath: "/apps/my.desktop" };
  assert.deepEqual(expandDesktopExec("app %F", input), ["app", "/f/a b.txt"]);
  assert.deepEqual(expandDesktopExec("app %u", input), ["app", "file:///f/a%20b.txt"]);
  assert.deepEqual(expandDesktopExec("app %i --name %c --from %k %f", input), ["app", "--icon", "my-icon", "--name", "My App", "--from", "/apps/my.desktop", "/f/a b.txt"]);
  assert.deepEqual(expandDesktopExec("app %i %f", { ...input, icon: null }), ["app", "/f/a b.txt"]);
  assert.deepEqual(expandDesktopExec("app --open=%f --pct=100%%", input), ["app", "--open=/f/a b.txt", "--pct=100%"]);
  assert.deepEqual(expandDesktopExec("app %d %D %n %N %v %m %f", input), ["app", "/f/a b.txt"]);
  // Only the first file code receives the file.
  assert.deepEqual(expandDesktopExec("app %f %u", input), ["app", "/f/a b.txt"]);
  // Without a file code the file is appended.
  assert.deepEqual(expandDesktopExec("app --new", input), ["app", "--new", "/f/a b.txt"]);
});

test("Exec quoting: double quotes, escapes, and the two escape levels", () => {
  const input = { filePath: "/f/x", name: "n", icon: null, desktopFilePath: null };
  assert.deepEqual(expandDesktopExec("\"/opt/My App/bin/app\" --title \"a \\\\\"b\\\\\" \\\\$HOME \\\\`c\\\\` d\\\\\\\\e\" %f", input), ["/opt/My App/bin/app", "--title", "a \"b\" $HOME `c` d\\e", "/f/x"]);
  assert.deepEqual(expandDesktopExec("app \"\" %f", input), ["app", "", "/f/x"]);
  assert.deepEqual(expandDesktopExec("app\\s--flag %f", input), ["app", "--flag", "/f/x"]);
  assert.deepEqual(expandDesktopExec("pre\"fix with\"post %f", input), ["prefix withpost", "/f/x"]);
  assert.throws(() => expandDesktopExec("app \"unterminated %f", input), /unterminated/);
  assert.throws(() => expandDesktopExec("sh -c \"editor %f\"", input), /quoted/);
  assert.throws(() => expandDesktopExec("", input), /no command/);
  assert.throws(() => expandDesktopExec("app %f", { ...input, filePath: "relative" }), /absolute/);
  assert.deepEqual(tokenizeDesktopExec("a  b").map((segments) => segments.map((segment) => segment.text).join("")), ["a", "b"]);
});

test("launch plans prefer gio launch with the absolute path and no option separator", () => {
  const editor = app("editor.desktop", { path: "/usr/share/applications/editor.desktop", name: "Editor", exec: "editor %f" });
  const env = { PATH: "/usr/bin", ORIGINAL_XDG_CURRENT_DESKTOP: "niri", XDG_CURRENT_DESKTOP: "Unity", CHROME_DESKTOP: "amplefile.desktop" };
  for (const filePath of hostile) {
    const plan = linuxOpenWithLaunchPlan(editor, filePath, { gio: "/usr/bin/gio", terminalExec: null, env, home: "/home/me" });
    assert.deepEqual({ kind: plan.kind, command: plan.command, args: plan.args, cwd: plan.cwd }, { kind: "exec", command: "/usr/bin/gio", args: ["launch", "/usr/share/applications/editor.desktop", filePath], cwd: "/home/me" });
    assert.equal(plan.env.XDG_CURRENT_DESKTOP, "niri");
    assert.equal(plan.env.CHROME_DESKTOP, undefined);
  }
  assert.throws(() => linuxOpenWithLaunchPlan(editor, "relative.txt", { gio: "/usr/bin/gio", terminalExec: null, env, home: "/h" }), /absolute/);
});

test("without gio the Exec line is spawned directly, terminal apps need a terminal launcher", () => {
  const tools = { gio: null, terminalExec: null, env: {}, home: "/home/me" };
  const editor = app("editor.desktop", { name: "Editor", exec: "editor --new %F", workingDirectory: "/opt/editor" });
  assert.deepEqual(linuxOpenWithLaunchPlan(editor, "/f/$(x).txt", tools), { kind: "spawn", command: "editor", args: ["--new", "/f/$(x).txt"], env: {}, cwd: "/opt/editor" });
  const vim = app("vim.desktop", { name: "Vim", exec: "vim %F", terminal: true });
  assert.throws(() => linuxOpenWithLaunchPlan(vim, "/f/a", tools), /runs in a terminal/);
  assert.deepEqual(linuxOpenWithLaunchPlan(vim, "/f/a", { ...tools, terminalExec: "/usr/bin/xdg-terminal-exec" }).args, ["vim", "/f/a"]);
  assert.throws(() => linuxOpenWithLaunchPlan(app("bus.desktop", { name: "Bus", exec: null, dbusActivatable: true }), "/f/a", tools), /launcher/);
});

test("the launched app's environment drops AmpleFile's markers and restores the desktop", () => {
  const env = linuxLaunchEnvironment({ PATH: "/bin", XDG_CURRENT_DESKTOP: "Unity", ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME", CHROME_DESKTOP: "amplefile-desktop.desktop", NO_AT_BRIDGE: "1", GDK_BACKEND: "x11", ELECTRON_RUN_AS_NODE: "1", HOME: "/home/me" });
  assert.deepEqual(env, { PATH: "/bin", XDG_CURRENT_DESKTOP: "GNOME", HOME: "/home/me" });
  assert.deepEqual(linuxLaunchEnvironment({ XDG_CURRENT_DESKTOP: "niri" }), { XDG_CURRENT_DESKTOP: "niri" });
});

// ---------------------------------------------------------------------------
// Fixture directories end to end

test("fixture data directories: precedence, overrides, Hidden, TryExec, mimeapps, and gio-free detection", async () => {
  const { root, write, cleanup } = await fixture();
  try {
    const home = join(root, "home");
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const tool = join(bin, "present-tool");
    await writeFile(tool, "#!/bin/sh\n");
    await chmod(tool, 0o755);
    const env: NodeJS.ProcessEnv = {
      PATH: bin,
      LANG: "de_DE.UTF-8",
      XDG_CURRENT_DESKTOP: "niri",
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CONFIG_DIRS: join(root, "etc-xdg"),
      XDG_DATA_DIRS: `${join(root, "flatpak/exports/share")}:${join(root, "usr/local/share")}:${join(root, "usr/share")}`,
    };
    const sys = (name: string, fields: Record<string, string>) => write(`usr/share/applications/${name}`, entry({ Type: "Application", ...fields }));
    await sys("editor.desktop", { Name: "Editor", "Name[de]": "Bearbeiter", Exec: "editor %f", MimeType: "text/plain;" });
    // A user override that changes the name wins over the system copy.
    await write("home/.local/share/applications/editor.desktop", entry({ Type: "Application", Name: "My Editor", Exec: "editor --mine %f", MimeType: "text/plain;" }));
    // A user Hidden entry deletes the system app entirely.
    await sys("removed-by-user.desktop", { Name: "Gone", Exec: "gone %f", MimeType: "text/plain;" });
    await write("home/.local/share/applications/removed-by-user.desktop", entry({ Hidden: "true" }));
    // /usr/local/share outranks /usr/share for the same id.
    await sys("dup.desktop", { Name: "Dup System", Exec: "dup %f", MimeType: "text/plain;" });
    await write("usr/local/share/applications/dup.desktop", entry({ Type: "Application", Name: "Dup Local", Exec: "dup-local %f", MimeType: "text/plain;" }));
    await sys("missing-tryexec.desktop", { Name: "Missing", Exec: "missing %f", TryExec: "definitely-not-installed", MimeType: "text/plain;" });
    await sys("present-tryexec.desktop", { Name: "Present", Exec: "present-tool %f", TryExec: "present-tool", MimeType: "text/plain;" });
    await sys("settings-helper.desktop", { Name: "Helper", Exec: "helper %f", NoDisplay: "true", MimeType: "text/plain;" });
    await sys("kde-only.desktop", { Name: "KDE Thing", Exec: "kde %f", OnlyShowIn: "KDE;", MimeType: "text/plain;" });
    await sys("kde4/okular.desktop", { Name: "Okular", Exec: "okular %U", MimeType: "application/pdf;" });
    await sys("broken.desktop", { Name: "Broken" });
    await write("usr/share/applications/not-an-app.txt", "ignored");
    await write("flatpak/exports/share/applications/org.example.Viewer.desktop", entry({ Type: "Application", Name: "Viewer", Exec: "/usr/bin/flatpak run --file-forwarding org.example.Viewer @@ %F @@", MimeType: "text/plain;image/png;" }));
    await symlink(join(root, "usr/share/applications/editor.desktop"), join(root, "usr/share/applications/linked-editor.desktop"));
    await write("usr/share/mime/globs2", "50:text/plain:*.txt\n50:application/pdf:*.pdf\n50:text/markdown:*.md\n");
    await write("usr/share/mime/subclasses", "text/markdown text/plain\n");
    // Per-desktop list outranks the generic list in the same directory.
    await write("home/.config/niri-mimeapps.list", "[Default Applications]\ntext/plain=org.example.Viewer.desktop\n");
    await write("home/.config/mimeapps.list", "[Default Applications]\ntext/plain=editor.desktop\n[Removed Associations]\ntext/plain=dup.desktop\n");
    await write("usr/share/applications/mimeapps.list", "[Added Associations]\ntext/plain=kde4-okular.desktop\n");

    const apps = await loadDesktopApps(applicationsDirs(env, home, []), env);
    assert.equal(apps.get("editor.desktop")?.name, "My Editor");
    assert.equal(apps.get("editor.desktop")?.source, "user");
    assert.equal(apps.get("removed-by-user.desktop")?.hidden, true);
    assert.equal(apps.get("dup.desktop")?.name, "Dup Local");
    assert.equal(apps.get("kde4-okular.desktop")?.name, "Okular");
    assert.equal(apps.get("org.example.Viewer.desktop")?.source, "flatpak");
    assert.equal(apps.has("broken.desktop"), false);
    assert.equal(apps.get("linked-editor.desktop")?.name, "Bearbeiter");

    const file = join(root, "folder", "--version $(x).txt");
    await write("folder/--version $(x).txt", "hello");
    const choices = await linuxOpenWithChoices(file, { env, home, extraDataDirs: [] });
    assert.equal(choices.gio, null);
    assert.equal(choices.mimeType, "text/plain");
    assert.equal(choices.defaultId, "org.example.Viewer.desktop");
    assert.deepEqual(choices.apps.map((entry) => entry.id), [
      "org.example.Viewer.desktop",
      "kde4-okular.desktop",
      "editor.desktop",
      "linked-editor.desktop",
      "present-tryexec.desktop",
    ]);

    const markdown = join(root, "folder", "notes.md");
    await write("folder/notes.md", "# hi");
    const inherited = await linuxOpenWithChoices(markdown, { env, home, extraDataDirs: [] });
    assert.equal(inherited.mimeType, "text/markdown");
    assert.equal(inherited.defaultId, "org.example.Viewer.desktop");

    const picked = await desktopAppFromFile(join(root, "usr/share/applications/kde4/okular.desktop"), env);
    assert.equal(picked?.name, "Okular");
    assert.equal(await desktopAppFromFile(join(root, "home/.local/share/applications/removed-by-user.desktop"), env), null);
    assert.equal(await desktopAppFromFile(join(root, "nope.desktop"), env), null);

    await write("home/.local/share/icons/hicolor/48x48/apps/my-icon.png", "png");
    assert.equal(await findDesktopIconPng("my-icon", env, home), join(home, ".local/share/icons/hicolor/48x48/apps/my-icon.png"));
    assert.equal(await findDesktopIconPng("../escape", env, home), null);
    assert.equal(await findDesktopIconPng(null, env, home), null);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// The shared Open With flow on Linux

test("Linux Other… starts in the installed applications", () => {
  assert.deepEqual(openWithDialogOptions("linux"), {
    title: "Choose an App",
    properties: ["openFile"],
    defaultPath: "/usr/share/applications",
    filters: [{ name: "Applications", extensions: ["desktop"] }, { name: "All Files", extensions: ["*"] }],
  });
});

test("an app picked from the Linux list launches with the rechecked file and reports its name", async () => {
  const launches: OpenWithLaunchPlan[] = [];
  let file = "/Folder/before.txt";
  const editor = app("editor.desktop", { name: "Text Editor", path: "/usr/share/applications/editor.desktop" });
  const result = await openFileWithPickedApp("linux", {
    resolveFile: async () => file,
    pickApp: async (filePath) => {
      assert.equal(filePath, "/Folder/before.txt");
      file = "/Folder/after.txt";
      return { appName: editor.name, launchPlan: (path) => linuxOpenWithLaunchPlan(editor, path, { gio: "/usr/bin/gio", terminalExec: null, env: {}, home: "/h" }) };
    },
    launch: async (plan) => { launches.push(plan); },
  });
  assert.deepEqual(result, { opened: true, canceled: false, appName: "Text Editor" });
  assert.deepEqual(launches.map((plan) => plan.args), [["launch", "/usr/share/applications/editor.desktop", "/Folder/after.txt"]]);
});

test("a Linux app that cannot be started safely is reported without launching", async () => {
  let launched = false;
  await assert.rejects(openFileWithPickedApp("linux", {
    resolveFile: async () => "/Folder/a.txt",
    pickApp: async () => ({ appName: "Vim", launchPlan: (path) => linuxOpenWithLaunchPlan(app("vim.desktop", { name: "Vim", exec: "vim %f", terminal: true }), path, { gio: null, terminalExec: null, env: {}, home: "/h" }) }),
    launch: async () => { launched = true; },
  }), /Couldn't open with Vim\. Vim runs in a terminal/);
  assert.equal(launched, false);
});
