import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createConnectedFolderCheckpoint, createConnectedFolderMutationCheckpoint, restoreConnectedFolderCheckpoint, restoreFileVersion, listConnectedFolderCheckpoints, previewConnectedFolderCheckpointRestore } from "../src/local/history.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";
import { registerLinkedConnectedFolder, withConnectedFolderHistoryOperation } from "../src/local/connected-folder.js";

async function fixture(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "history-boundary-"));
  const root = join(sandbox, "connected-folder");
  configureAmpleFileStateRoot(join(sandbox, "state"));
  await mkdir(root);
  t.after(async () => { configureAmpleFileStateRoot(undefined); await rm(sandbox, { recursive: true, force: true }); });
  return { sandbox, root };
}

test("restore refuses deleting or overwriting content its new safety checkpoint cannot capture", async (t) => {
  const { root } = await fixture(t);
  const oldLimit = process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES;
  process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = "32";
  t.after(() => { if (oldLimit === undefined) delete process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES; else process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = oldLimit; });
  const added = await createConnectedFolderMutationCheckpoint(root, { deleteOnRestore: ["added"] });
  await mkdir(join(root, "added"));
  const bytes = Buffer.alloc(64, 7);
  await writeFile(join(root, "added", "large.bin"), bytes);
  const preview = await previewConnectedFolderCheckpointRestore(root, added.checkpointId);
  assert.match(preview.conflicts.join(), /cannot be recovered/);
  assert.deepEqual(preview.removePaths, ["added"]);
  await assert.rejects(restoreConnectedFolderCheckpoint(root, added.checkpointId), /cannot be recovered/);
  assert.deepEqual(await readFile(join(root, "added", "large.bin")), bytes);
  await writeFile(join(root, "note.txt"), "small");
  const cp = await createConnectedFolderCheckpoint(root);
  await writeFile(join(root, "note.txt"), bytes);
  await assert.rejects(restoreConnectedFolderCheckpoint(root, cp.checkpointId), /cannot be recovered/);
  await assert.rejects(restoreFileVersion(root, "note.txt", cp.files.find((file) => file.path === "note.txt")!.hashSha256), /cannot be recovered/);
  assert.deepEqual(await readFile(join(root, "note.txt")), bytes);
});

test("additive undo never recursively deletes protected metadata", async (t) => {
  const { root } = await fixture(t);
  const cp = await createConnectedFolderMutationCheckpoint(root, { deleteOnRestore: ["added"] });
  await mkdir(join(root, "added", ".work-fold"), { recursive: true });
  await writeFile(join(root, "added", ".work-fold", "sentinel"), "preserve");
  await assert.rejects(restoreConnectedFolderCheckpoint(root, cp.checkpointId), /cannot be recovered/);
  assert.equal(await readFile(join(root, "added", ".work-fold", "sentinel"), "utf8"), "preserve");
});

test("History excludes nested Connected Folders and refuses older checkpoints after child registration", async (t) => {
  const { root } = await fixture(t);
  const child = join(root, "child"); await mkdir(child);
  await registerLinkedConnectedFolder(root);
  await writeFile(join(child, "note.txt"), "before");
  const old = await createConnectedFolderCheckpoint(root);
  await registerLinkedConnectedFolder(child);
  await writeFile(join(child, "note.txt"), "after");
  const current = await createConnectedFolderCheckpoint(root);
  assert.equal(current.files.some((file) => file.path.startsWith("child/")), false);
  const targeted = await createConnectedFolderMutationCheckpoint(root, { paths: ["child/note.txt"] });
  assert.equal(targeted.files.length, 0);
  await assert.rejects(restoreConnectedFolderCheckpoint(root, old.checkpointId), /another registered Connected Folder/);
  assert.equal(await readFile(join(child, "note.txt"), "utf8"), "after");
});

test("old directory exclusions protect descendants after ignore rules change", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, "scratch"));
  await writeFile(join(root, ".gitignore"), "scratch/\n");
  await writeFile(join(root, "scratch", "note.txt"), "precious");
  const cp = await createConnectedFolderCheckpoint(root);
  await writeFile(join(root, ".gitignore"), "");
  assert.deepEqual((await previewConnectedFolderCheckpointRestore(root, cp.checkpointId)).removePaths, []);
  await restoreConnectedFolderCheckpoint(root, cp.checkpointId);
  assert.equal(await readFile(join(root, "scratch", "note.txt"), "utf8"), "precious");
});

test("relinking a moved Connected Folder preserves its machine-local History", async (t) => {
  const { root, sandbox } = await fixture(t);
  const original = await registerLinkedConnectedFolder(root);
  await writeFile(join(root, "note.txt"), "before");
  const cp = await createConnectedFolderCheckpoint(root);
  const moved = join(sandbox, "moved"); await rename(root, moved);
  assert.equal((await registerLinkedConnectedFolder(moved)).id, original.id);
  assert.equal((await listConnectedFolderCheckpoints(moved))[0]?.checkpointId, cp.checkpointId);
  await writeFile(join(moved, "note.txt"), "after");
  await restoreConnectedFolderCheckpoint(moved, cp.checkpointId);
  assert.equal(await readFile(join(moved, "note.txt"), "utf8"), "before");
  assert.equal(existsSync(root), false);
});

test("History holds ownership stable and queues independent writers instead of refusing them", async (t) => {
  const { root } = await fixture(t);
  const child = join(root, "Child"); await mkdir(child);
  await writeFile(join(root, "note.txt"), "before");
  const order: string[] = [];
  let release!: () => void;
  const held = withConnectedFolderHistoryOperation(root, () => new Promise<void>((resolve) => { release = resolve; }))
    .then(() => order.push("held"));
  const registration = registerLinkedConnectedFolder(child).then((value) => { order.push("registered"); return value; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const checkpoint = createConnectedFolderCheckpoint(root).then((value) => { order.push("checkpoint"); return value; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, [], "a nested registration and a capture both wait while History holds the root");
  release();
  const [, registered, captured] = await Promise.all([held, registration, checkpoint]);
  assert.equal(registered.connectedFolderRoot, child);
  assert.equal(captured.files.some((file) => file.path === "note.txt"), true);
  assert.equal(captured.skippedFiles.some((file) => file.path === "Child" && file.reason === "excluded"), true, "the capture saw the registration it queued behind");
  assert.deepEqual(order, ["held", "registered", "checkpoint"], "a waiting registration is not overtaken by a later capture");
});

test("a queued registration holds up only History on the folders it touches", async (t) => {
  const { root, sandbox } = await fixture(t);
  const child = join(root, "Child"); await mkdir(child);
  const unrelated = join(sandbox, "unrelated"); await mkdir(unrelated);
  await writeFile(join(unrelated, "a.txt"), "a");
  let release!: () => void;
  const held = withConnectedFolderHistoryOperation(root, () => new Promise<void>((resolve) => { release = resolve; }));
  let registered = false;
  const registration = registerLinkedConnectedFolder(child).then(() => { registered = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const captured = await createConnectedFolderCheckpoint(unrelated);
  assert.equal(captured.files.length, 1, "an unrelated folder's capture completes while the registration waits");
  await registerLinkedConnectedFolder(unrelated);
  assert.equal(registered, false, "the nested registration still waits for History on its parent");
  release(); await Promise.all([held, registration]);
  assert.equal(registered, true);
});

test("History on different Connected Folders runs side by side", async (t) => {
  const { root, sandbox } = await fixture(t);
  const other = join(sandbox, "other"); await mkdir(other);
  let release!: () => void;
  const held = withConnectedFolderHistoryOperation(root, () => new Promise<void>((resolve) => { release = resolve; }));
  await writeFile(join(other, "a.txt"), "a");
  const captured = await createConnectedFolderCheckpoint(other);
  assert.equal(captured.files.length, 1);
  release(); await held;
});

test("History refuses a nested claim it would deadlock waiting for", async (t) => {
  const { root, sandbox } = await fixture(t);
  const child = join(root, "Child"); await mkdir(child);
  const unrelated = join(sandbox, "other"); await mkdir(unrelated);
  await withConnectedFolderHistoryOperation(root, async () => {
    await assert.rejects(registerLinkedConnectedFolder(child), /Wait for History/);
    // A registration that touches nothing History holds does not need to wait.
    await registerLinkedConnectedFolder(unrelated);
    // The same root is reentrant for a restore's own safety capture.
    await createConnectedFolderCheckpoint(root);
  });
  await registerLinkedConnectedFolder(child);
});

test("relinking a moved Connected Folder waits for History on its old root", async (t) => {
  const { root, sandbox } = await fixture(t);
  await registerLinkedConnectedFolder(root);
  const moved = join(sandbox, "moved"); await rename(root, moved);
  let release!: () => void;
  const held = withConnectedFolderHistoryOperation(root, () => new Promise<void>((resolve) => { release = resolve; }));
  let relinked = false;
  const relink = registerLinkedConnectedFolder(moved).then(() => { relinked = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(relinked, false, "the state relocation waits for the old root's History");
  release(); await Promise.all([held, relink]);
  assert.equal(relinked, true);
});
