import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { mock, type TestContext } from "node:test";

import { startLocalApi } from "../src/local/server.js";
import { connectedFolderManifestFile } from "../src/local/state-paths.js";

/**
 * The local API's several-item acts touch the Connected Folder they change
 * once when they end, not once per item: each touch commits the registry and
 * the portable manifest with fsync.
 */

async function sandboxApi(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-local-api-touch-batch-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => { await api.close(); await rm(sandbox, { recursive: true, force: true }); });
  const call = async (path: string, method: string, body: unknown) => {
    const response = await fetch(`${api.origin}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };
  return { api, sandbox, call };
}

/** Counts commits of a Connected Folder's portable manifest (each is a rename into place). */
function countManifestCommits(t: TestContext, root: string): { count: number } {
  const counter = { count: 0 };
  const manifest = resolve(connectedFolderManifestFile(root));
  const original = fsPromises.rename;
  mock.method(fsPromises, "rename", (async (from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
    if (resolve(String(to)) === manifest) counter.count += 1;
    return original(from, to);
  }) as typeof original);
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  return counter;
}

test("a several-item move, delete, and move between Connected Folders each touch the source once", async (t) => {
  const { sandbox, call } = await sandboxApi(t);
  const root = join(sandbox, "source");
  await mkdir(join(root, "Target"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt"]) await writeFile(join(root, name), name);
  const source = (await call("/api/connected-folders/local-folder", "POST", { connectedFolderRoot: root })).body!.connectedFolder;
  const target = (await call("/api/connected-folders", "POST", { name: "Elsewhere" })).body!.connectedFolder;
  const counter = countManifestCommits(t, root);

  const moved = await call(`/api/connected-folders/${source.id}/move-local-entries`, "POST", { sourcePaths: ["a.txt", "b.txt", "c.txt"], targetFolderPath: "Target" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body!.moved.length, 3);
  assert.equal(counter.count, 1, "three moves, one touch");

  const deleted = await call(`/api/connected-folders/${source.id}/local-files`, "DELETE", { paths: ["d.txt", "e.txt"] });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body!.deleted.length, 2);
  assert.equal(counter.count, 2, "two deletes, one touch");

  const transferred = await call("/api/file-transfer", "POST", {
    mode: "move",
    sources: ["f.txt", "g.txt"].map((path) => ({ place: { kind: "connected-folder", id: source.id }, path })),
    target: { place: { kind: "connected-folder", id: target.id }, path: "" },
  });
  assert.equal(transferred.status, 200, JSON.stringify(transferred.body));
  assert.deepEqual(transferred.body!.written, ["f.txt", "g.txt"]);
  assert.equal(counter.count, 3, "two items moved out, one touch of the source");
});
