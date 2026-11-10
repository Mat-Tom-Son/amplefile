import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startLocalApi } from "../src/local/server.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The text-save route's stale-overwrite guard: a read returns the file's hash,
 * a save may name the hash it read, and a save over content that changed
 * since is refused with a 409 and leaves the file as it is.
 */
test("a text save that names a stale hash is refused and the file is untouched", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-text-save-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => { await api.close(); await rm(sandbox, { recursive: true, force: true }); });
  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Notes" });
  const file = join(connectedFolder.connectedFolderRoot, "note.txt");
  await writeFile(file, "first");
  const url = `${api.origin}/api/connected-folders/${connectedFolder.id}/file`;
  const save = (body: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const read = await (await fetch(`${url}?path=note.txt`)).json() as { text: string; hashSha256: string };
  assert.deepEqual(read, { text: "first", hashSha256: sha256("first") });

  const saved = await save({ path: "note.txt", text: "second", expectedHashSha256: read.hashSha256 });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as { file: { hashSha256: string } };
  assert.equal(savedBody.file.hashSha256, sha256("second"), "the save returns the hash for the next save");

  // Another app changes the file; a save naming the hash the editor had is refused.
  await writeFile(file, "changed elsewhere");
  const stale = await save({ path: "note.txt", text: "third", expectedHashSha256: savedBody.file.hashSha256 });
  assert.equal(stale.status, 409);
  assert.match((await stale.json() as { error: string }).error, /changed since it was opened/);
  assert.equal(await readFile(file, "utf8"), "changed elsewhere");

  const malformed = await save({ path: "note.txt", text: "third", expectedHashSha256: 42 });
  assert.equal(malformed.status, 400);
  assert.equal(await readFile(file, "utf8"), "changed elsewhere");

  // Without a hash, a save writes as before.
  const unguarded = await save({ path: "note.txt", text: "fourth" });
  assert.equal(unguarded.status, 200);
  assert.equal(await readFile(file, "utf8"), "fourth");
});
