import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const preloads = await Promise.all([
  readFile(new URL("../desktop/src/preload.cts", import.meta.url), "utf8"),
  readFile(new URL("../desktop/src/amplefile-agent-popover-preload.cts", import.meta.url), "utf8"),
]);

test("sandboxed desktop preloads only require Electron", () => {
  for (const source of preloads) {
    const requires = [...source.matchAll(/require\(([^)]+)\)/g)].map((match) => match[1]);
    assert.deepEqual(requires, ['"electron"']);
    assert.doesNotMatch(source, /product-identity\.json/);
  }
});

test("no preload or main-process handler serves a Connected Folder app view", () => {
  // There are no Connected Folder apps: no sandboxed app host, app preload,
  // or agent-app protocol.
  for (const source of preloads) assert.doesNotMatch(source, /restrictedApps|restricted-app-view/);
  assert.doesNotMatch(main, /restricted-app-view|restricted-app-preload|restrictedAppProtocol|agent-app/);
});

test("main passes centralized product identity into both sandboxed preloads", () => {
  assert.equal((main.match(/\.\.\.productRendererArguments\(\)/g) ?? []).length, 2);
  assert.match(main, /rendererArgument\("product-name", productName\)/);
  assert.match(main, /rendererArgument\("internal-protocol", appProtocol\)/);
  for (const source of preloads) {
    assert.match(source, /argumentValue\("product-name"\)/);
    assert.match(source, /argumentValue\("internal-protocol"\)/);
  }
});

test("desktop preparation runs the real sandboxed preload smoke", () => {
  assert.match(packageJson.scripts["desktop:prepare"], /desktop:preload:smoke/);
  assert.equal(packageJson.scripts["desktop:preload:smoke"], "node scripts/run-electron.mjs scripts/desktop-preload-electron-smoke.mjs");
});

test("native clipboard writes require a trusted top-level sender and expose no reads", async () => {
  const inspector = await readFile(new URL("../desktop/src/model-context-preload.cts", import.meta.url), "utf8");
  for (const source of [...preloads, inspector]) {
    assert.match(source, /ipcRenderer\.invoke\("amplefile:clipboard:write", content\)/);
    assert.doesNotMatch(source, /clipboard:(?:read|clear)|clipboard\.read/);
  }
  const handler = main.slice(main.indexOf('ipcMain.handle("amplefile:clipboard:write"'));
  const body = handler.slice(0, handler.indexOf("\n  });\n"));
  assert.match(body, /modelContextWindow\.assertSender\(event\)/);
  assert.match(body, /assertTrustedRenderer\(event\)/);
  assert.match(body, /frame\.processId !== mainFrame\.processId/);
  assert.match(body, /frame\.routingId !== mainFrame\.routingId/);
  // Only validated content reaches the clipboard; a picture goes alone, decoded by Electron.
  assert.match(body, /writeDesktopClipboard\(value, \(content\) => clipboard\.write\(/);
  assert.match(body, /\{ image: nativeImage\.createFromDataURL\(content\.image\) \}/);
  assert.match(body, /\{ text: content\.text, \.\.\.\(content\.html !== undefined \? \{ html: content\.html \} : \{\}\) \}/);
});

test("Open with reaches the host only as a Connected Folder file reference and launches only the app the dialog returned", () => {
  const [preload] = preloads;
  assert.match(preload, /openPathWith: \(connectedFolderId: string, path: string\) => ipcRenderer\.invoke\("amplefile:connected-folder:open-path-with", \{ connectedFolderId, path \}\)/);
  const handler = main.slice(main.indexOf('ipcMain.handle("amplefile:connected-folder:open-path-with"'));
  const body = handler.slice(0, handler.indexOf("\n  });\n") + 1);
  assert.match(body, /assertTrustedRenderer\(event\);/);
  assert.match(body, /connectedFolderPathRequest\(value, false\)/);
  assert.match(body, /resolveConnectedFolderItem\(request\.connectedFolderId, request\.path\)/);
  assert.match(body, /dialog\.showOpenDialog\(window, options\)/);
  assert.match(body, /return openFileWithPickedApp\(process\.platform, \{/);
  assert.match(body, /return choice\.canceled \? null : choice\.filePaths\[0\] \?\? null;/);
  assert.match(body, /launch: launchOpenWith/);
  assert.doesNotMatch(body, /shell: true|exec\(/);
  assert.match(main, /spawn\(plan\.command, plan\.args, \{ detached: true, stdio: "ignore" \}\)/);
});
