import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { AmpleFileCliError } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";

// Rename, move, New Folder, and New File have one owner each, reached from the
// window's routes and from the CLI's act lane. Whatever name the effect gives
// the item is the name its History restore point and its receipt describe.

async function startConnectedFolder(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-file-verbs-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "File Verbs" });
  const root = connectedFolder.connectedFolderRoot;
  const base = `${api.origin}/api/connected-folders/${connectedFolder.id}`;
  async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }
  async function restoreOverHttp(checkpointId: string): Promise<void> {
    const restored = await post(`/history/checkpoints/${checkpointId}/restore`, {});
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
  }
  async function listing(): Promise<string[]> {
    const walk = async (dir: string, prefix: string): Promise<string[]> => {
      const names: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!prefix && (entry.name === ".amplefile" || entry.name === ".work-fold")) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        names.push(path);
        if (entry.isDirectory()) names.push(...await walk(join(dir, entry.name), path));
      }
      return names;
    };
    return (await walk(root, "")).sort();
  }
  return { facade: api.actFacade, id: connectedFolder.id, root, post, restoreOverHttp, listing };
}

const usage = (error: unknown) => error instanceof AmpleFileCliError && error.code === "usage" && /240 characters/.test(error.message);

test("a name longer than 240 characters is refused by every file verb on both surfaces, and nothing changes", async (t) => {
  const { facade, id, root, post, listing } = await startConnectedFolder(t);
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "a.txt"), "a", "utf8");
  const before = await listing();
  const long = `${"n".repeat(237)}.md`;
  assert.equal(long.length, 240);
  const tooLong = `${"n".repeat(238)}.md`;

  for (const [path, body] of [
    ["/rename-local-entry", { path: "notes/a.txt", newName: tooLong }],
    ["/folders", { parentPath: "notes", name: tooLong }],
    ["/files", { parentPath: "notes", name: tooLong, text: "x" }],
  ] as const) {
    const refused = await post(path, body);
    assert.equal(refused.status, 400, `${path}: ${JSON.stringify(refused.json)}`);
    assert.match(String(refused.json.error), /240 characters/);
  }
  await assert.rejects(() => facade.filesRename({ connectedFolder: id, path: "notes/a.txt", newName: tooLong }), usage);
  await assert.rejects(() => facade.filesMkdir({ connectedFolder: id, path: `notes/${tooLong}` }), usage);
  await assert.rejects(() => facade.filesCreate({ connectedFolder: id, path: `notes/${tooLong}` }), usage);
  assert.deepEqual(await listing(), before);

  // The limit itself is allowed, and is kept whole.
  const renamed = await post("/rename-local-entry", { path: "notes/a.txt", newName: long });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal((renamed.json.renamed as { path: string }).path, `notes/${long}`);
  assert.equal(existsSync(join(root, "notes", long)), true);
});

test("restoring a rename's History point puts back the original name, whatever name the rename was given", async (t) => {
  const { facade, id, root, post, restoreOverHttp } = await startConnectedFolder(t);
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "draft.md"), "draft", "utf8");

  // The window's rename route.
  const renamed = await post("/rename-local-entry", { path: "notes/draft.md", newName: "  final.md  " });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal((renamed.json.renamed as { path: string }).path, "notes/final.md");
  await restoreOverHttp(renamed.json.safetyCheckpointId as string);
  assert.equal(existsSync(join(root, "notes", "draft.md")), true);
  assert.equal(existsSync(join(root, "notes", "final.md")), false);

  // `files rename` on the CLI.
  const cliRenamed = await facade.filesRename({ connectedFolder: id, path: " notes/draft.md ", newName: "  final.md  " });
  assert.equal(cliRenamed.path, "notes/final.md");
  assert.equal(cliRenamed.fromPath, "notes/draft.md");
  assert.equal(cliRenamed.priorName, "draft.md");
  await facade.historyRestore({ connectedFolder: id, checkpointId: cliRenamed.safetyCheckpointId });
  assert.equal(existsSync(join(root, "notes", "draft.md")), true);
  assert.equal(existsSync(join(root, "notes", "final.md")), false);
});

test("restoring a move's History point puts the item back, on both surfaces", async (t) => {
  const { facade, id, root, post, restoreOverHttp } = await startConnectedFolder(t);
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "archive"));
  await writeFile(join(root, "docs", "plan.md"), "plan", "utf8");

  const moved = await post("/move-local-entry", { sourcePath: " docs/plan.md ", targetFolderPath: " archive/ " });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal((moved.json.moved as { path: string }).path, "archive/plan.md");
  await restoreOverHttp(moved.json.safetyCheckpointId as string);
  assert.equal(existsSync(join(root, "docs", "plan.md")), true);
  assert.equal(existsSync(join(root, "archive", "plan.md")), false);

  const cliMoved = await facade.filesMove({ connectedFolder: id, fromPath: "docs/plan.md", toDir: "archive" });
  assert.equal(cliMoved.path, "archive/plan.md");
  await facade.historyRestore({ connectedFolder: id, checkpointId: cliMoved.safetyCheckpointId });
  assert.equal(existsSync(join(root, "docs", "plan.md")), true);
  assert.equal(existsSync(join(root, "archive", "plan.md")), false);
});

test("restoring a New Folder or New File History point removes the item it made, on both surfaces", async (t) => {
  const { facade, id, root, post, restoreOverHttp, listing } = await startConnectedFolder(t);
  await mkdir(join(root, "notes"));
  const before = await listing();

  // The window's New Folder and New File, with names the effect trims.
  const folder = await post("/folders", { parentPath: " notes ", name: " Made Folder " });
  assert.equal(folder.status, 201, JSON.stringify(folder.json));
  assert.equal((folder.json.folder as { path: string }).path, "notes/Made Folder");
  await restoreOverHttp(folder.json.safetyCheckpointId as string);
  assert.deepEqual(await listing(), before);

  const file = await post("/files", { parentPath: "notes", name: " made.md ", text: "made" });
  assert.equal(file.status, 201, JSON.stringify(file.json));
  assert.equal((file.json.file as { path: string }).path, "notes/made.md");
  await restoreOverHttp(file.json.safetyCheckpointId as string);
  assert.deepEqual(await listing(), before);

  // `files mkdir` and `files create` on the CLI.
  const cliFolder = await facade.filesMkdir({ connectedFolder: id, path: "notes/ Made Folder" });
  assert.equal(cliFolder.path, "notes/Made Folder");
  await facade.historyRestore({ connectedFolder: id, checkpointId: cliFolder.safetyCheckpointId });
  assert.deepEqual(await listing(), before);

  const cliFile = await facade.filesCreate({ connectedFolder: id, path: "notes/ made.md" });
  assert.equal(cliFile.path, "notes/made.md");
  await facade.historyRestore({ connectedFolder: id, checkpointId: cliFile.safetyCheckpointId });
  assert.deepEqual(await listing(), before);
});
