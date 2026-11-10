import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createPackage, createPackageWithOptions } from "@electron/asar";
import ts from "typescript";
import { handleRendererRequest, rendererBuildDirectory } from "../desktop/src/renderer-protocol.ts";
import { builderExcludedNames, verifyPackagedRenderer } from "../scripts/verify-packaged-renderer.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const builder = require(join(rootDir, "electron-builder.desktop.cjs"));

const page = (script: string, extra = "") =>
  `<!doctype html><html><head>${extra}<link rel="icon" href="data:image/png;base64,AA==" /></head><body><script type="module" crossorigin src="${script}"></script></body></html>`;

/** A renderer build shaped like Vite's output: two pages and their hashed assets. */
async function writeRendererBuild(appRoot: string): Promise<void> {
  const renderer = join(appRoot, "dist", "web-local");
  await mkdir(join(renderer, "assets"), { recursive: true });
  await writeFile(join(renderer, "index.html"), page("/assets/index-abc123.js", '<link rel="stylesheet" crossorigin href="/assets/index-abc123.css">'));
  await writeFile(join(renderer, "popover.html"), page("/assets/popover-def456.js"));
  await writeFile(join(renderer, "assets", "index-abc123.js"), 'document.documentElement.dataset.loaded = "index";\n');
  await writeFile(join(renderer, "assets", "index-abc123.css"), ":root { color-scheme: light dark; }\n");
  await writeFile(join(renderer, "assets", "popover-def456.js"), 'document.documentElement.dataset.loaded = "popover";\n');
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "renderer-archive-smoke", version: "1.0.0", main: "main.mjs" }));
}

test("Electron Builder archives the renderer in app.asar and ships no loose copy", () => {
  assert.ok(builder.files.includes("dist/web-local/**/*"));
  assert.equal(builder.asar, true);
  assert.equal(builder.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(builder.electronFuses.onlyLoadAppFromAsar, true);
  const outside = [...builder.extraResources, ...builder.mac.extraResources, ...builder.extraFiles];
  for (const entry of outside) {
    assert.doesNotMatch(String(entry.from), /web-local/, "the renderer must not be copied beside the archive");
    assert.doesNotMatch(String(entry.to), /web-local/, "the renderer must not be copied beside the archive");
  }
  for (const pattern of builder.asarUnpack) assert.doesNotMatch(pattern, /web-local/, "the renderer must not be unpacked");
});

test("the internal scheme answers renderer files and the one desktop icon, and nothing else", async (t) => {
  assert.equal(rendererBuildDirectory("/Applications/AmpleFile.app/Contents/Resources/app.asar"), "/Applications/AmpleFile.app/Contents/Resources/app.asar/dist/web-local");

  const temporary = await mkdtemp(join(tmpdir(), "amplefile-renderer-protocol-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await writeRendererBuild(temporary);
  const rendererRoot = rendererBuildDirectory(temporary);
  const desktopAssets = join(temporary, "assets");
  await mkdir(desktopAssets);
  await writeFile(join(desktopAssets, "icon-32.png"), "icon");
  await writeFile(join(desktopAssets, "icon.png"), "another icon");
  const fetched: string[] = [];
  const sources = { rendererRoot, desktopAssets, fetchFile: async (fileUrl: string) => { fetched.push(fileUrl); return new Response("served"); } };
  const answer = (path: string, method = "GET", host = "app") => handleRendererRequest({ url: `amplefile-desktop://${host}${path}`, method }, sources);
  const servedFile = async (path: string) => {
    const response = await answer(path);
    assert.equal(await response.text(), "served", path);
    return fetched.pop();
  };

  assert.equal(await servedFile("/assets/index-abc123.js"), pathToFileURL(join(rendererRoot, "assets", "index-abc123.js")).href);
  assert.equal(await servedFile("/"), pathToFileURL(join(rendererRoot, "index.html")).href);
  assert.equal(await servedFile("/popover.html"), pathToFileURL(join(rendererRoot, "popover.html")).href);
  assert.equal(await servedFile("/_desktop-assets/icon-32.png"), pathToFileURL(join(desktopAssets, "icon-32.png")).href);

  const head = await answer("/popover.html", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  assert.equal((await answer("/index.html", "GET", "other")).status, 404, "only the app host answers");
  for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await answer("/index.html", method)).status, 405, method);
  for (const outside of [
    "/missing.js",
    "/assets",
    "/assets/",
    "//",
    "//assets//",
    "/_desktop-assets/icon.png",
    "/_desktop-assets/..%2ficon.png",
    "/..%2f..%2fpackage.json",
    "/assets/..%2f..%2f..%2fpackage.json",
    `/${encodeURIComponent(join(temporary, "package.json"))}`,
  ]) {
    assert.equal((await answer(outside)).status, 404, outside);
  }
  assert.equal((await answer("/assets", "HEAD")).status, 404, "a directory has no bytes to answer with");
  for (const malformed of ["/%E0%A4%A", "/assets/%", "/_desktop-assets/%ZZ"]) {
    assert.equal((await answer(malformed)).status, 400, malformed);
  }
  assert.deepEqual(fetched, [], "refused and HEAD requests never read a file");
});

test("packaged renderer verification accepts the archived build and rejects every loose, missing, or different form", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "amplefile-packaged-renderer-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  type Change = (appRoot: string) => Promise<unknown>;
  /** `build` shapes the renderer build and so the archive made from it;
   * `archive` then changes only what is packaged, and `local` only the build
   * left on disk, the two ways a package and its build can come apart. */
  async function packageRenderer(name: string, { build, archive, local, resources, unpack }: {
    build?: Change; archive?: Change; local?: Change; resources?: (resourcesDir: string) => Promise<unknown>; unpack?: string;
  } = {}): Promise<string[]> {
    const buildRoot = join(temporary, name, "build");
    const appRoot = join(temporary, name, "app");
    const resourcesDir = join(temporary, name, "Resources");
    await mkdir(resourcesDir, { recursive: true });
    for (const root of [buildRoot, appRoot]) {
      await writeRendererBuild(root);
      await build?.(root);
    }
    await archive?.(appRoot);
    await local?.(buildRoot);
    await resources?.(resourcesDir);
    const asarPath = join(resourcesDir, "app.asar");
    if (unpack) await createPackageWithOptions(appRoot, asarPath, { unpack });
    else await createPackage(appRoot, asarPath);
    return verifyPackagedRenderer({ asarPath, resourcesDir, rendererBuildDir: rendererBuildDirectory(buildRoot) });
  }
  const renderer = (appRoot: string, ...path: string[]) => join(appRoot, "dist", "web-local", ...path);
  // What a page never names: a lazily imported chunk and a font from CSS.
  const addUnnamedFiles = async (appRoot: string) => {
    await writeFile(renderer(appRoot, "assets", "settings-777aaa.js"), "export const settings = true;\n");
    await writeFile(renderer(appRoot, "assets", "inter-888bbb.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1]));
  };

  assert.deepEqual(await packageRenderer("archived"), []);
  assert.deepEqual(await packageRenderer("archived-with-unnamed-files", { build: addUnnamedFiles }), []);
  // Electron Builder never packages these names, so a build folder that
  // holds them still matches a correct archive.
  assert.deepEqual(
    [...builderExcludedNames].sort(),
    (require("app-builder-lib/out/fileMatcher").excludedNames as string).split(",").sort(),
    "the verifier's list mirrors the installed Electron Builder's excludedNames",
  );
  assert.deepEqual(
    await packageRenderer("tool-metadata", { local: async (appRoot) => {
      for (const name of [".DS_Store", "._index-abc123.js", "thumbs.db", ".gitkeep", ".gitignore"]) await writeFile(renderer(appRoot, "assets", name), "metadata");
      await mkdir(renderer(appRoot, ".git"));
      await writeFile(renderer(appRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    } }),
    [],
    "tool and system metadata in the build folder is not part of the renderer",
  );
  // An extension the builder drops is different: the renderer would miss it.
  assert.deepEqual(
    await packageRenderer("dropped-extension", { local: (appRoot) => writeFile(renderer(appRoot, "assets", "model-999ccc.obj"), "v 0 0 0\n") }),
    ["app.asar is missing a file of the renderer build: /dist/web-local/assets/model-999ccc.obj."],
  );

  // The archive and the build it came from must be the same files.
  assert.deepEqual(
    await packageRenderer("no-lazy-chunk", { build: addUnnamedFiles, archive: (appRoot) => rm(renderer(appRoot, "assets", "settings-777aaa.js")) }),
    ["app.asar is missing a file of the renderer build: /dist/web-local/assets/settings-777aaa.js."],
  );
  assert.deepEqual(
    await packageRenderer("no-font", { build: addUnnamedFiles, archive: (appRoot) => rm(renderer(appRoot, "assets", "inter-888bbb.woff2")) }),
    ["app.asar is missing a file of the renderer build: /dist/web-local/assets/inter-888bbb.woff2."],
  );
  assert.deepEqual(
    await packageRenderer("stale-file", { archive: (appRoot) => writeFile(renderer(appRoot, "assets", "index-000old.js"), "stale();\n") }),
    ["app.asar holds a renderer file the renderer build does not: /dist/web-local/assets/index-000old.js."],
  );
  assert.deepEqual(
    await packageRenderer("different-bytes", { archive: (appRoot) => writeFile(renderer(appRoot, "assets", "index-abc123.js"), 'document.documentElement.dataset.loaded = "other";\n') }),
    ["Renderer file in app.asar differs from the renderer build: /dist/web-local/assets/index-abc123.js."],
  );
  assert.match(
    (await packageRenderer("no-build", { local: (appRoot) => rm(join(appRoot, "dist"), { recursive: true }) })).join("\n"),
    /^The renderer build to compare app\.asar with was not found at .*build\/dist\/web-local\. Verify a package from the tree that built it\.$/,
  );
  assert.match(
    (await packageRenderer("linked-build", { local: async (appRoot) => {
      await rm(renderer(appRoot, "assets", "popover-def456.js"));
      await symlink("index-abc123.js", renderer(appRoot, "assets", "popover-def456.js"));
    } })).join("\n"),
    /The renderer build holds something other than a regular file: \/dist\/web-local\/assets\/popover-def456\.js/,
  );

  const failuresOf = async (...input: Parameters<typeof packageRenderer>) => (await packageRenderer(...input)).join("\n");
  assert.match(
    await failuresOf("no-popover", { archive: (appRoot) => rm(renderer(appRoot, "popover.html")) }),
    /app\.asar is missing the AmpleFile Agent popover renderer: \/dist\/web-local\/popover\.html/,
  );
  assert.match(
    await failuresOf("no-renderer", { archive: (appRoot) => rm(join(appRoot, "dist"), { recursive: true }) }),
    /app\.asar is missing the renderer index: \/dist\/web-local\/index\.html/,
  );
  assert.match(
    await failuresOf("no-script", { archive: (appRoot) => rm(renderer(appRoot, "assets", "popover-def456.js")) }),
    /popover\.html loads \/assets\/popover-def456\.js, which is not inside app\.asar/,
  );
  assert.match(
    await failuresOf("no-stylesheet", { archive: (appRoot) => rm(renderer(appRoot, "assets", "index-abc123.css")) }),
    /index\.html loads \/assets\/index-abc123\.css, which is not inside app\.asar/,
  );

  // Only a path stays inside the internal scheme: a scheme or a host leaves
  // it, even one that names the app's own host.
  for (const [name, reference] of [
    ["remote-script", "https://example.com/app.js"],
    ["app-host-script", "https://app/assets/index-abc123.js"],
    ["protocol-relative-script", "//app/assets/index-abc123.js"],
    ["backslash-host-script", "\\\\app\\assets\\index-abc123.js"],
    ["file-script", "file:///assets/index-abc123.js"],
    // A browser drops tabs and newlines inside a URL, and control characters
    // around it, before parsing it.
    ["tab-host-script", "/\t/evil.example/assets/index-abc123.js"],
    ["newline-host-script", "/\n/evil.example/assets/index-abc123.js"],
    ["tab-scheme-script", "h\tttps://evil.example/assets/index-abc123.js"],
    ["control-prefix-script", "\x01https://app/assets/index-abc123.js"],
  ]) {
    assert.deepEqual(
      await packageRenderer(name, { build: (appRoot) => writeFile(renderer(appRoot, "index.html"), page(reference)) }),
      [`index.html loads ${/[\0-\x1f]/.test(reference) ? JSON.stringify(reference) : reference} from outside the app.`],
      name,
    );
  }
  assert.deepEqual(
    await packageRenderer("tab-in-path-script", { build: (appRoot) => writeFile(renderer(appRoot, "index.html"), page("/assets/index\t-abc123.js")) }),
    [],
    "a tab inside a path is dropped, and the path still names the archived file",
  );
  assert.deepEqual(
    await packageRenderer("relative-script", { build: (appRoot) => writeFile(renderer(appRoot, "index.html"), page("./assets/index-abc123.js")) }),
    [],
  );
  // A reference inside another attribute's value is not the one the page loads.
  assert.deepEqual(
    await packageRenderer("hidden-script", { build: (appRoot) => writeFile(
      renderer(appRoot, "index.html"),
      '<!doctype html><script type="module" data-note=" src=/assets/index-abc123.js >" src="https://example.com/app.js"></script>',
    ) }),
    ["index.html loads https://example.com/app.js from outside the app."],
  );

  const unpacked = await packageRenderer("unpacked", { unpack: "**/dist/web-local/assets/*.js" });
  assert.deepEqual(unpacked.slice(0, 2), [
    "Renderer file must stay inside app.asar, not unpacked: /dist/web-local/assets/index-abc123.js.",
    "Renderer file must stay inside app.asar, not unpacked: /dist/web-local/assets/popover-def456.js.",
  ]);
  assert.match(unpacked[2], /^Renderer files must not ship outside app\.asar: .*Resources\/app\.asar\.unpacked\/dist\/web-local\.$/);
  assert.equal(unpacked.length, 3);
  assert.deepEqual(
    await packageRenderer("linked-script", { archive: async (appRoot) => {
      await rm(renderer(appRoot, "assets", "popover-def456.js"));
      await symlink("index-abc123.js", renderer(appRoot, "assets", "popover-def456.js"));
    } }),
    ["Renderer file must be a regular file in app.asar, not a link: /dist/web-local/assets/popover-def456.js."],
  );
  assert.deepEqual(
    await packageRenderer("linked-page", { archive: async (appRoot) => {
      await mkdir(join(appRoot, "other"));
      await writeFile(join(appRoot, "other", "page.html"), page("/assets/popover-def456.js"));
      await rm(renderer(appRoot, "popover.html"));
      await symlink("../../other/page.html", renderer(appRoot, "popover.html"));
    } }),
    ["Renderer file must be a regular file in app.asar, not a link: /dist/web-local/popover.html."],
  );
  assert.match(
    await failuresOf("loose-copy", { resources: async (resourcesDir) => {
      await mkdir(join(resourcesDir, "web-local"));
      await writeFile(join(resourcesDir, "web-local", "index.html"), page("/assets/index-abc123.js"));
    } }),
    /Renderer files must not ship outside app\.asar: .*Resources\/web-local/,
  );
});

test("Electron loads the main window and the popover through the internal scheme from inside app.asar", { skip: process.platform !== "darwin", timeout: 45_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "amplefile-renderer-asar-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stage = join(temporary, "app");
  await writeRendererBuild(stage);

  // The archive runs the real serving module, compiled as the desktop build
  // compiles it, behind the scheme privileges the app registers.
  const source = await readFile(join(rootDir, "desktop", "src", "renderer-protocol.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  await writeFile(join(stage, "renderer-protocol.mjs"), compiled.outputText);
  const identity = JSON.parse(await readFile(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
  const scheme: string = identity.internalProtocol;
  // The window icon is the one file the scheme answers from outside the archive.
  const desktopAssets = join(temporary, "Resources", "assets");
  await mkdir(desktopAssets, { recursive: true });
  await writeFile(join(desktopAssets, "icon-32.png"), "icon");
  await writeFile(join(desktopAssets, "icon.png"), "another icon");
  await writeFile(join(stage, "main.mjs"), `
    import { app, BrowserWindow, net, protocol } from "electron";
    import { handleRendererRequest, rendererBuildDirectory } from "./renderer-protocol.mjs";
    const scheme = ${JSON.stringify(scheme)};
    protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
    app.setPath("userData", ${JSON.stringify(join(temporary, "profile"))});
    app.on("window-all-closed", () => {});
    app.whenReady().then(async () => {
      try {
        const rendererRoot = rendererBuildDirectory(app.getAppPath());
        protocol.handle(scheme, (request) => handleRendererRequest(request, {
          rendererRoot,
          desktopAssets: ${JSON.stringify(desktopAssets)},
          fetchFile: (fileUrl) => net.fetch(fileUrl),
        }));
        const loaded = {};
        for (const page of ["index.html", "popover.html"]) {
          const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
          await window.loadURL(scheme + "://app/" + page);
          loaded[page] = await window.webContents.executeJavaScript("document.documentElement.dataset.loaded");
          window.destroy();
        }
        const status = async (path, method = "GET", host = "app") => (await net.fetch(scheme + "://" + host + "/" + path, { method })).status;
        const script = await net.fetch(scheme + "://app/assets/index-abc123.js");
        console.log(JSON.stringify({
          rendererRoot, loaded,
          scriptType: script.headers.get("content-type"),
          script: await script.text(),
          root: await (await net.fetch(scheme + "://app/")).text(),
          icon: await (await net.fetch(scheme + "://app/_desktop-assets/icon-32.png")).text(),
          head: await status("popover.html", "HEAD"),
          post: await status("index.html", "POST"),
          otherHost: await status("index.html", "GET", "other"),
          otherAsset: await status("_desktop-assets/icon.png"),
          missing: await status("assets/missing.js"),
          directory: await status("assets"),
          directorySlash: await status("assets/"),
          doubleSlash: await status("/"),
          malformed: await status("%E0%A4%A"),
          escaped: await status("..%2f..%2fpackage.json"),
        }));
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    });
  `);

  const archive = join(temporary, "Resources", "app.asar");
  await createPackage(stage, archive);
  assert.deepEqual(verifyPackagedRenderer({ asarPath: archive, resourcesDir: dirname(archive), rendererBuildDir: rendererBuildDirectory(stage) }), []);
  // Nothing loose remains for a load to fall back on.
  await rm(stage, { recursive: true });

  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(require("electron"), [archive], { env, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 512 * 1024 });
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
  assert.equal(result.rendererRoot, join(archive, "dist", "web-local"));
  assert.deepEqual(result.loaded, { "index.html": "index", "popover.html": "popover" });
  assert.match(result.scriptType, /javascript/);
  assert.match(result.script, /dataset\.loaded = "index"/);
  assert.match(result.root, /index-abc123\.js/, "the bare origin answers the main window's page");
  assert.equal(result.icon, "icon");
  assert.equal(result.head, 200);
  assert.equal(result.post, 405);
  assert.equal(result.otherHost, 404);
  assert.equal(result.otherAsset, 404);
  assert.equal(result.missing, 404);
  assert.equal(result.directory, 404);
  assert.equal(result.directorySlash, 404);
  assert.equal(result.doubleSlash, 404, "app// names the renderer directory, not a page");
  assert.equal(result.malformed, 400);
  assert.equal(result.escaped, 404);
});
