import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { mock, type TestContext } from "node:test";

import {
  deleteConnectedFolderEntry,
  getConnectedFolder,
  moveConnectedFolderEntry,
  registerLinkedConnectedFolder,
  withConnectedFolderTouchBatch,
} from "../src/local/connected-folder.js";
import { configureAmpleFileStateRoot, connectedFolderManifestFile, connectedFolderRegistryFile } from "../src/local/state-paths.js";

async function fixture(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-touch-batch-"));
  const root = join(sandbox, "connected-folder");
  configureAmpleFileStateRoot(join(sandbox, "state"));
  await mkdir(join(root, "Target"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) await writeFile(join(root, name), name);
  const connectedFolder = await registerLinkedConnectedFolder(root);
  t.after(async () => {
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  return { root, connectedFolder };
}

/** Counts commits of the registry and of the portable manifest (each is a rename into place). */
function countMetadataCommits(t: TestContext, root: string): { registry: number; manifest: number } {
  const counts = { registry: 0, manifest: 0 };
  const registry = resolve(connectedFolderRegistryFile());
  const manifest = resolve(connectedFolderManifestFile(root));
  const original = fsPromises.rename;
  mock.method(fsPromises, "rename", (async (from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
    if (resolve(String(to)) === registry) counts.registry += 1;
    if (resolve(String(to)) === manifest) counts.manifest += 1;
    return original(from, to);
  }) as typeof original);
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  return counts;
}

test("a batch of moves and deletes commits Connected Folder metadata once", async (t) => {
  const { root, connectedFolder } = await fixture(t);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  const counts = countMetadataCommits(t, root);

  await withConnectedFolderTouchBatch(async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) await moveConnectedFolderEntry(root, { sourcePath: name, targetFolderPath: "Target" });
    for (const name of ["d.txt", "e.txt"]) await deleteConnectedFolderEntry(root, name);
    assert.deepEqual(counts, { registry: 0, manifest: 0 }, "no item commits metadata on its own");
  });

  assert.deepEqual(counts, { registry: 1, manifest: 1 });
  assert.notEqual((await getConnectedFolder(connectedFolder.id)).updatedAt, connectedFolder.updatedAt, "the Connected Folder is still touched");
});

test("each item outside a batch still touches its Connected Folder", async (t) => {
  const { root } = await fixture(t);
  const counts = countMetadataCommits(t, root);
  await moveConnectedFolderEntry(root, { sourcePath: "a.txt", targetFolderPath: "Target" });
  await deleteConnectedFolderEntry(root, "b.txt");
  assert.deepEqual(counts, { registry: 2, manifest: 2 });
});

test("a batch that fails partway still touches the Connected Folder once and keeps the item's error", async (t) => {
  const { root } = await fixture(t);
  const counts = countMetadataCommits(t, root);
  await assert.rejects(withConnectedFolderTouchBatch(async () => {
    await moveConnectedFolderEntry(root, { sourcePath: "a.txt", targetFolderPath: "Target" });
    await moveConnectedFolderEntry(root, { sourcePath: "missing.txt", targetFolderPath: "Target" });
  }), /not found/i);
  assert.deepEqual(counts, { registry: 1, manifest: 1 });
});
