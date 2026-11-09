import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  createConnectedFolderCheckpoint,
  discardConnectedFolderCheckpoint,
  restoreConnectedFolderCheckpoint,
  type ConnectedFolderCheckpoint,
} from "../src/local/history.js";
import { configureAmpleFileStateRoot, connectedFolderHistoryRoot } from "../src/local/state-paths.js";

async function fixture(t: TestContext): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-history-durability-"));
  const root = join(sandbox, "connected-folder");
  configureAmpleFileStateRoot(join(sandbox, "state"));
  await mkdir(root, { recursive: true });
  t.after(async () => {
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  return root;
}

function blobPath(root: string, hash: string): string {
  return join(connectedFolderHistoryRoot(root), "objects", hash.slice(0, 2), hash.slice(2));
}

function hashOf(checkpoint: ConnectedFolderCheckpoint, path: string): string {
  const file = checkpoint.files.find((entry) => entry.path === path);
  assert.ok(file, `${path} was captured`);
  return file.hashSha256;
}

function manifestPath(root: string, checkpointId: string): string {
  return join(connectedFolderHistoryRoot(root), "checkpoints", `${checkpointId}.json`);
}

test("a later capture repairs a blob cut short by a crash", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "note.txt"), "the original words");
  const first = await createConnectedFolderCheckpoint(root, { label: "First" });
  const blob = blobPath(root, hashOf(first, "note.txt"));
  await truncate(blob, 4);

  await writeFile(join(root, "note.txt"), "changed");
  await assert.rejects(restoreConnectedFolderCheckpoint(root, first.checkpointId), /missing saved content/);

  // The same content is captured again (here from a copy of the file).
  await writeFile(join(root, "copy.txt"), "the original words");
  await createConnectedFolderCheckpoint(root, { label: "Second" });
  assert.equal(await readFile(blob, "utf8"), "the original words", "the damaged blob is rewritten");

  await restoreConnectedFolderCheckpoint(root, first.checkpointId);
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "the original words");
});

test("a later capture repairs a damaged blob of a streamed large file", async (t) => {
  const root = await fixture(t);
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 7, 3);
  await writeFile(join(root, "large.bin"), bytes);
  const first = await createConnectedFolderCheckpoint(root, { label: "First" });
  const blob = blobPath(root, hashOf(first, "large.bin"));
  await truncate(blob, 1024);

  await writeFile(join(root, "large.bin"), "small now");
  await writeFile(join(root, "large-copy.bin"), bytes);
  await createConnectedFolderCheckpoint(root, { label: "Second" });
  assert.deepEqual(await readFile(blob), bytes, "the damaged blob is rewritten");

  await restoreConnectedFolderCheckpoint(root, first.checkpointId);
  assert.deepEqual(await readFile(join(root, "large.bin")), bytes);
});

test("garbage collection keeps blobs named by a manifest it cannot parse", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "note.txt"), "kept by a damaged manifest");
  const damaged = await createConnectedFolderCheckpoint(root, { label: "Damaged" });
  const damagedHash = hashOf(damaged, "note.txt");
  const text = await readFile(manifestPath(root, damaged.checkpointId), "utf8");
  // Cut the manifest short just after the file's hash, as a power loss might.
  await writeFile(manifestPath(root, damaged.checkpointId), text.slice(0, text.lastIndexOf(damagedHash) + damagedHash.length));

  await writeFile(join(root, "note.txt"), "newer content");
  const later = await createConnectedFolderCheckpoint(root, { label: "Later" });
  await discardConnectedFolderCheckpoint(root, later.checkpointId);

  assert.equal(existsSync(blobPath(root, damagedHash)), true, "the damaged manifest's blob survives collection");
  assert.equal(existsSync(blobPath(root, hashOf(later, "note.txt"))), false, "unreferenced content is still collected");
});

test("garbage collection keeps blobs named by a manifest from a newer schema", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "note.txt"), "future content");
  const future = await createConnectedFolderCheckpoint(root, { label: "Future" });
  const futureHash = hashOf(future, "note.txt");
  const manifest = JSON.parse(await readFile(manifestPath(root, future.checkpointId), "utf8")) as Record<string, unknown>;
  await writeFile(manifestPath(root, future.checkpointId), JSON.stringify({ ...manifest, schemaVersion: "9.0.0" }));

  await writeFile(join(root, "note.txt"), "newer content");
  const later = await createConnectedFolderCheckpoint(root, { label: "Later" });
  await discardConnectedFolderCheckpoint(root, later.checkpointId);
  assert.equal(existsSync(blobPath(root, futureHash)), true);
});

test("garbage collection stops when a manifest cannot be read at all", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "note.txt"), "first");
  const first = await createConnectedFolderCheckpoint(root, { label: "First" });
  await writeFile(join(root, "note.txt"), "second");
  const second = await createConnectedFolderCheckpoint(root, { label: "Second" });
  // A manifest name the store cannot read as a file.
  await mkdir(join(connectedFolderHistoryRoot(root), "checkpoints", "cp-20260101000000-unreadable.json"));

  await discardConnectedFolderCheckpoint(root, second.checkpointId);
  assert.equal(existsSync(blobPath(root, hashOf(second, "note.txt"))), true, "nothing is collected while a manifest is unreadable");
  assert.equal(existsSync(blobPath(root, hashOf(first, "note.txt"))), true);
});

test("checkpoint writes leave no staging files behind", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "a.txt"), "a");
  await createConnectedFolderCheckpoint(root);
  const history = connectedFolderHistoryRoot(root);
  const leftovers: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(directory, entry.name));
      else if (/\.tmp/.test(entry.name)) leftovers.push(entry.name);
    }
  };
  await walk(history);
  assert.deepEqual(leftovers, []);
});
