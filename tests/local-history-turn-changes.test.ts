import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  compareConnectedFolderTurnCheckpoints,
  createConnectedFolderCheckpoint,
  restoreConnectedFolderCheckpoint,
  undoConnectedFolderTurnChanges,
} from "../src/local/history.js";
import { startLocalApi } from "../src/local/server.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";
import { workerChangesFromTurn } from "../web-local/src/components/file-manager/useWorkerChanges.js";

async function fixture(t: TestContext): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-turn-changes-"));
  const root = join(sandbox, "connected-folder");
  configureAmpleFileStateRoot(join(sandbox, "state"));
  await mkdir(root, { recursive: true });
  t.after(async () => {
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  return root;
}

test("a Worker turn's changes come from its own before and after, and Undo keeps what changed since", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "budget.md"), "budget v1", "utf8");
  await writeFile(join(root, "scan.pdf"), "scan", "utf8");
  await writeFile(join(root, "old.txt"), "old", "utf8");
  const before = await createConnectedFolderCheckpoint(root, { reason: "pre_turn", label: "Before turn" });

  // The Worker's turn: changes a file, adds two, files one away, and deletes one.
  await writeFile(join(root, "budget.md"), "budget v2", "utf8");
  await writeFile(join(root, "summary.md"), "summary", "utf8");
  await writeFile(join(root, "notes.md"), "notes", "utf8");
  await mkdir(join(root, "Receipts"));
  await rename(join(root, "scan.pdf"), join(root, "Receipts", "scan.pdf"));
  await rm(join(root, "old.txt"));
  const after = await createConnectedFolderCheckpoint(root, { reason: "post_turn", label: "After turn" });

  // The person, after the turn: moves a file in from elsewhere and edits one the Worker wrote.
  await writeFile(join(root, "from-downloads.pdf"), "mine", "utf8");
  await writeFile(join(root, "notes.md"), "notes, edited by the person", "utf8");

  const changes = await compareConnectedFolderTurnCheckpoints(root, before.checkpointId, after.checkpointId);
  assert.deepEqual(changes, {
    added: ["notes.md", "summary.md"],
    changed: ["budget.md"],
    removed: ["old.txt"],
    moved: [{ fromPath: "scan.pdf", toPath: "Receipts/scan.pdf" }],
  });
  const receipt = workerChangesFromTurn({ ...changes, beforeCheckpointId: before.checkpointId, afterCheckpointId: after.checkpointId, settledAt: after.createdAt });
  assert.ok(receipt);
  assert.equal(receipt!.paths.has("from-downloads.pdf"), false, "the person's later arrival is not the Worker's change");

  const undone = await undoConnectedFolderTurnChanges(root, before.checkpointId, after.checkpointId);
  assert.deepEqual(undone.kept, ["notes.md"], "a file changed again since the turn is kept and named");
  assert.equal(await readFile(join(root, "budget.md"), "utf8"), "budget v1");
  assert.equal(existsSync(join(root, "summary.md")), false);
  assert.equal(await readFile(join(root, "scan.pdf"), "utf8"), "scan");
  assert.equal(existsSync(join(root, "Receipts")), false, "an emptied folder the turn made goes");
  assert.equal(await readFile(join(root, "old.txt"), "utf8"), "old");
  assert.equal(await readFile(join(root, "from-downloads.pdf"), "utf8"), "mine", "the person's later arrival stays");
  assert.equal(await readFile(join(root, "notes.md"), "utf8"), "notes, edited by the person");

  // Restoring the undo's own restore point puts the turn's changes back (redo).
  await restoreConnectedFolderCheckpoint(root, undone.safetyCheckpointId);
  assert.equal(await readFile(join(root, "budget.md"), "utf8"), "budget v2");
  assert.equal(await readFile(join(root, "summary.md"), "utf8"), "summary");
  assert.equal(await readFile(join(root, "Receipts", "scan.pdf"), "utf8"), "scan");
  assert.equal(existsSync(join(root, "old.txt")), false);
  assert.equal(await readFile(join(root, "from-downloads.pdf"), "utf8"), "mine");
});

test("the receipt's routes read only a recorded Worker turn and undo only its own pair", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-turn-changes-api-"));
  const sessionToken = "turn-changes-test-session";
  const agentDir = join(sandbox, "agent");
  await mkdir(agentDir);
  const api = await startLocalApi({
    port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "folders"), sessionToken, loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } },
  });
  t.after(async () => {
    await api.close();
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Receipt Connected Folder" });
  const base = `${api.origin}/api/connected-folders/${connectedFolder.id}/history/worker-changes`;
  const headers = { "x-amplefile-session": sessionToken, "content-type": "application/json" };
  const read = await fetch(base, { headers });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { changes: null }, "no Worker turn, no receipt");

  await writeFile(join(connectedFolder.connectedFolderRoot, "a.txt"), "a", "utf8");
  const before = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, { reason: "manual" });
  await writeFile(join(connectedFolder.connectedFolderRoot, "a.txt"), "b", "utf8");
  const after = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, { reason: "manual" });
  const undo = await fetch(`${base}/undo`, { method: "POST", headers, body: JSON.stringify({ beforeCheckpointId: before.checkpointId, afterCheckpointId: after.checkpointId }) });
  assert.equal(undo.status, 404, "a pair no Worker turn recorded is refused");
  assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "a.txt"), "utf8"), "b", "and nothing changed");
});
