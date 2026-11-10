import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withConnectedFolderHistoryOperation } from "../src/local/connected-folder.js";
import { startLocalApi } from "../src/local/server.js";

/**
 * A History restore queues for its Connected Folder's History turn before it
 * reserves the folder, so while it waits the folder keeps accepting turns,
 * and its check for running work happens once it holds History.
 */
test("a restore waiting for History does not hold the Connected Folder's turns off", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-restore-queue-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", { description: "Hold a test turn", handler: async () => "held" });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
  });
  let release: () => void = () => {};
  t.after(async () => { release(); await api.close(); });

  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Restore Queue" });
  const root = connectedFolder.connectedFolderRoot;
  await writeFile(join(root, "note.txt"), "before");
  const created = await fetch(new URL(`/api/connected-folders/${connectedFolder.id}/history/checkpoints`, api.origin), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Before" }),
  });
  assert.equal(created.status, 201);
  const { checkpoint } = await created.json() as { checkpoint: { checkpointId: string } };
  await writeFile(join(root, "note.txt"), "after");

  // Something else holds this folder's History, so the restore waits.
  const held = withConnectedFolderHistoryOperation(root, () => new Promise<void>((resolve) => { release = resolve; }));
  const restore = fetch(new URL(`/api/connected-folders/${connectedFolder.id}/history/checkpoints/${checkpoint.checkpointId}/restore`, api.origin), {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // A turn is accepted while the restore waits; it is not refused as a
  // capability change in progress.
  const turn = await api.actFacade.sendMessage({ connectedFolder: connectedFolder.id, newConversation: true, content: "/hold" });
  assert.ok(turn.taskId);

  release();
  await held;
  // Once the restore holds History it checks for running work then, and the
  // turn accepted meanwhile is running.
  const restored = await restore;
  assert.equal(restored.status, 409);
  assert.match((await restored.json() as { error: string }).error, /agent work/);
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "after");

  const deadline = Date.now() + 15_000;
  while ((await api.actFacade.turnStatus({ connectedFolder: connectedFolder.id, taskId: turn.taskId })).task.state === "running") {
    if (Date.now() > deadline) throw new Error("The turn did not finish.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // With nothing running, the same restore goes through.
  const again = await fetch(new URL(`/api/connected-folders/${connectedFolder.id}/history/checkpoints/${checkpoint.checkpointId}/restore`, api.origin), {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "before");
});
