import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalApi } from "../src/local/server.js";

test("Connected Folder act mutations invalidate the visible registry without carrying content in the event", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-connected-folder-events-"));
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "connected-folders"), loadEnv: false });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const response = await fetch(`${api.origin}/api/amplefile-agent/control-events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"reset"}\n\n');
    const nextConnectedFolderHint = async () => {
      let text = "";
      while (!text.includes('data: {"type":"connected-folders"}\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
      for (const line of text.split("\n").filter((line) => line.startsWith("data: "))) {
        assert.deepEqual(Object.keys(JSON.parse(line.slice(6))), ["type"]);
      }
    };
    const created = await api.actFacade.createConnectedFolder({ name: "Purchasing QA" });
    await nextConnectedFolderHint();
    await api.actFacade.connectedFoldersRename({ connectedFolder: created.connectedFolder.id, name: "Purchasing renamed" });
    await nextConnectedFolderHint();
    const folder = join(root, "existing"); await mkdir(folder); await writeFile(join(folder, "brief.md"), "Original bytes");
    const registered = await api.actFacade.registerConnectedFolder({ connectedFolderRoot: folder });
    await nextConnectedFolderHint();
    await api.actFacade.connectedFoldersUnregister({ connectedFolder: registered.connectedFolder.id });
    await nextConnectedFolderHint();
    assert.equal(await readFile(join(folder, "brief.md"), "utf8"), "Original bytes");
    const bootstrap = await (await fetch(`${api.origin}/api/bootstrap`)).json() as { connectedFolders: Array<{ id: string; name: string }> };
    assert.deepEqual(bootstrap.connectedFolders.map(({ id, name }) => ({ id, name })), [{ id: created.connectedFolder.id, name: "Purchasing renamed" }]);
  } finally { clearTimeout(timeout); abort.abort(); await api.close(); await rm(root, { recursive: true, force: true }); }
});

test("an appearance applied, reset, or undone through the act lane tells open windows to re-read", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-appearance-events-"));
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "connected-folders"), loadEnv: false });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15_000);
  try {
    const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Looks" });
    const response = await fetch(`${api.origin}/api/amplefile-agent/control-events`, { signal: abort.signal });
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"reset"}\n\n');
    const nextConnectedFolderHint = async () => {
      let text = "";
      while (!text.includes('data: {"type":"connected-folders"}\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += new TextDecoder().decode(chunk.value);
      }
    };
    await api.actFacade.connectedFoldersAppearanceApply({ connectedFolder: connectedFolder.id, parts: { color: "#7a4cc2" }, cwd: connectedFolder.connectedFolderRoot });
    await nextConnectedFolderHint();
    await api.actFacade.connectedFoldersAppearanceReset({ connectedFolder: connectedFolder.id });
    await nextConnectedFolderHint();
    await api.actFacade.connectedFoldersAppearanceUndo({ connectedFolder: connectedFolder.id });
    await nextConnectedFolderHint();
    const bootstrap = await (await fetch(`${api.origin}/api/bootstrap`)).json() as { appearance: { customizations: Record<string, unknown> } };
    assert.ok(bootstrap.appearance.customizations[connectedFolder.id], "the undone reset brought the look back");
  } finally { clearTimeout(timeout); abort.abort(); await api.close(); await rm(root, { recursive: true, force: true }); }
});
