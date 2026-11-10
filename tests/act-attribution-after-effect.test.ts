import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AmpleFileRequestStore } from "../src/local/requests/request-store.js";
import { startLocalApi } from "../src/local/server.js";

/**
 * Attribution is written after an act's effect lands (docs/act-ledger.md,
 * "Receipts, not gates"). A failure to write it must not turn the completed
 * act into an error, or an agent retries and repeats the effect.
 */
test("an act whose attribution cannot be written still reports its completed effect", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-act-attribution-"));
  const requestStore = await AmpleFileRequestStore.open({ rootPath: join(sandbox, "state", "requests") });
  const attempts: string[] = [];
  requestStore.recordAction = async (_parentTaskId, action) => {
    attempts.push(action.command);
    throw new Error("disk full");
  };
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false, requestStore });
  const warn = t.mock.method(console, "warn", () => undefined);
  t.after(async () => { await api.close(); await rm(sandbox, { recursive: true, force: true }); });

  const created = await api.actFacade.createConnectedFolder({ name: "Attributed" });
  assert.equal(created.connectedFolder.name, "Attributed");

  const outside = join(sandbox, "outside.txt");
  await writeFile(outside, "outside");
  const added = await api.actFacade.addFiles({ connectedFolder: created.connectedFolder.id, fromPaths: [outside], cwd: sandbox });
  assert.deepEqual(added.copied, ["outside.txt"]);
  assert.ok(added.checkpointId, "the copy keeps its restore point");
  assert.deepEqual((await readdir(created.connectedFolder.connectedFolderRoot)).filter((name) => !name.startsWith(".")), ["outside.txt"], "copied exactly once");

  const registeredRoot = join(sandbox, "linked");
  await mkdir(registeredRoot);
  const registered = await api.actFacade.registerConnectedFolder({ connectedFolderRoot: registeredRoot });
  assert.ok(registered.connectedFolder.id);

  assert.deepEqual(attempts, ["connected-folders.create", "files.add", "connected-folders.register"]);
  assert.equal(warn.mock.callCount(), 3, "each failed attribution is logged");
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /could not record connected-folders\.create.*act itself completed/);
});
