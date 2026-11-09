import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";

import {
  createConnectedFolderCheckpoint,
  createConnectedFolderMutationCheckpoint,
  discardConnectedFolderCheckpoint,
  listConnectedFolderCheckpoints,
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

test("a checkpoint reads only the newest manifests and the whole ledger only when over the limit", async (t) => {
  const root = await fixture(t);
  const oldMax = process.env.AMPLEFILE_HISTORY_MAX_CHECKPOINTS;
  process.env.AMPLEFILE_HISTORY_MAX_CHECKPOINTS = "50";
  t.after(() => { if (oldMax === undefined) delete process.env.AMPLEFILE_HISTORY_MAX_CHECKPOINTS; else process.env.AMPLEFILE_HISTORY_MAX_CHECKPOINTS = oldMax; });
  await writeFile(join(root, "note.txt"), "one");
  const newest = await createConnectedFolderCheckpoint(root, { label: "Newest" });
  const template = JSON.parse(await readFile(manifestPath(root, newest.checkpointId), "utf8")) as ConnectedFolderCheckpoint;
  for (let index = 0; index < 40; index += 1) {
    const second = String(index).padStart(2, "0");
    const checkpointId = `cp-202501010000${second}-${String(index).padStart(8, "0")}`;
    await writeFile(manifestPath(root, checkpointId), JSON.stringify({ ...template, checkpointId, createdAt: `2025-01-01T00:00:${second}.000Z`, label: `Old ${index}` }));
  }

  const checkpointsDirectory = join(connectedFolderHistoryRoot(root), "checkpoints");
  const reads: string[] = [];
  const original = fsPromises.readFile;
  mock.method(fsPromises, "readFile", (async (...args: Parameters<typeof original>) => {
    if (String(args[0]).startsWith(checkpointsDirectory)) reads.push(String(args[0]));
    return original(...args);
  }) as typeof original);
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });

  const same = await createConnectedFolderCheckpoint(root, { label: "Unchanged" });
  assert.equal(same.checkpointId, newest.checkpointId, "an unchanged full capture still reuses the newest manifest");
  assert.deepEqual(reads, [manifestPath(root, newest.checkpointId)], "only the newest second's manifest is read");

  reads.length = 0;
  await writeFile(join(root, "note.txt"), "two");
  await createConnectedFolderMutationCheckpoint(root, { paths: ["note.txt"] });
  assert.deepEqual(reads, [], "a targeted checkpoint under the limit reads no manifest");

  for (let index = 0; index < 10; index += 1) {
    await writeFile(join(root, "note.txt"), `more ${index}`);
    await createConnectedFolderMutationCheckpoint(root, { paths: ["note.txt"] });
  }
  assert.equal((await listConnectedFolderCheckpoints(root, 1000)).length, 50, "pruning still runs once the ledger is over the limit");
  assert.equal((await listConnectedFolderCheckpoints(root, 1000)).some((checkpoint) => checkpoint.label === "Old 0"), false, "the oldest are pruned first");
});

test("a restore deletes a blob whose bytes fail their hash so the next capture rewrites it", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "note.txt"), "the original words");
  const first = await createConnectedFolderCheckpoint(root, { label: "First" });
  const blob = blobPath(root, hashOf(first, "note.txt"));
  await writeFile(blob, "the 0riginal words"); // Same size, wrong bytes.

  await writeFile(join(root, "note.txt"), "changed");
  await assert.rejects(restoreConnectedFolderCheckpoint(root, first.checkpointId), /missing saved content/);
  assert.equal(existsSync(blob), false, "the damaged blob is deleted");

  await writeFile(join(root, "copy.txt"), "the original words");
  await createConnectedFolderCheckpoint(root, { label: "Second" });
  await restoreConnectedFolderCheckpoint(root, first.checkpointId);
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "the original words");
});

test("a bulk capture flushes only a bounded number of blobs one by one", async (t) => {
  const root = await fixture(t);
  const probe = await fsPromises.open(join(root, "..", "probe"), "w");
  const handlePrototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  let syncs = 0;
  const original = handlePrototype.sync;
  mock.method(handlePrototype, "sync", function (this: unknown) { syncs += 1; return original.call(this); });
  t.after(() => mock.restoreAll());

  for (let index = 0; index < 5; index += 1) await writeFile(join(root, `small-${index}.txt`), `small ${index}`);
  await createConnectedFolderCheckpoint(root, { label: "Few" });
  assert.ok(syncs >= 5 + 2, `each of a few new blobs is flushed, and the manifest too (${syncs})`);

  syncs = 0;
  await mkdir(join(root, "bulk"));
  for (let index = 0; index < 260; index += 1) await writeFile(join(root, "bulk", `file-${index}.txt`), `bulk ${index}`);
  await createConnectedFolderCheckpoint(root, { label: "Bulk" });
  assert.ok(syncs >= 200 && syncs <= 210, `at most 200 blobs are flushed one by one, plus the manifest (${syncs})`);
});

async function withMaxCheckpoints(t: TestContext, value: string): Promise<void> {
  const old = process.env.AMPLEFILE_HISTORY_MAX_CHECKPOINTS;
  process.env.AMPLEFILE_HISTORY_MAX_CHECKPOINTS = value;
  t.after(() => { if (old === undefined) delete process.env.AMPLEFILE_HISTORY_MAX_CHECKPOINTS; else process.env.AMPLEFILE_HISTORY_MAX_CHECKPOINTS = old; });
}

test("retention drops a damaged manifest once it ages out, and History says so", async (t) => {
  const root = await fixture(t);
  await withMaxCheckpoints(t, "3");
  const warnings: string[] = [];
  mock.method(console, "warn", (message: string) => { warnings.push(String(message)); });
  t.after(() => mock.restoreAll());

  await writeFile(join(root, "note.txt"), "only the damaged manifest names this");
  const old = await createConnectedFolderCheckpoint(root, { label: "Old" });
  const oldHash = hashOf(old, "note.txt");
  const text = await readFile(manifestPath(root, old.checkpointId), "utf8");
  await rm(manifestPath(root, old.checkpointId));
  const damagedName = "cp-20250101000000-0000dead";
  await writeFile(manifestPath(root, damagedName), text.slice(0, text.lastIndexOf(oldHash) + oldHash.length));

  for (const value of ["one", "two"]) {
    await writeFile(join(root, "note.txt"), value);
    await createConnectedFolderCheckpoint(root, { label: value });
  }
  assert.equal(existsSync(manifestPath(root, damagedName)), true, "inside the window the damaged manifest stays");
  assert.equal(existsSync(blobPath(root, oldHash)), true, "and its content is kept");
  assert.equal((await listConnectedFolderCheckpoints(root, 100)).length, 2, "the History list leaves the damaged manifest out");
  assert.ok(warnings.some((message) => message.includes(damagedName)), "and reports it");

  await writeFile(join(root, "note.txt"), "three");
  await createConnectedFolderCheckpoint(root, { label: "three" });
  assert.equal(existsSync(manifestPath(root, damagedName)), false, "past the window the damaged manifest is dropped");
  assert.equal(existsSync(blobPath(root, oldHash)), false, "and its content is collected");
  assert.equal((await listConnectedFolderCheckpoints(root, 100)).length, 3);
});

test("an unreadable manifest stops cleanup only until retention drops it", async (t) => {
  const root = await fixture(t);
  await withMaxCheckpoints(t, "2");
  mock.method(console, "warn", () => undefined);
  t.after(() => mock.restoreAll());
  const unreadable = join(connectedFolderHistoryRoot(root), "checkpoints", "cp-20250101000000-unreadable.json");

  await writeFile(join(root, "note.txt"), "first");
  const first = await createConnectedFolderCheckpoint(root, { label: "first" });
  await mkdir(unreadable);
  await writeFile(join(root, "note.txt"), "second");
  await createConnectedFolderCheckpoint(root, { label: "second" });
  assert.equal(existsSync(unreadable), false, "the unreadable manifest is the oldest and ages out first");

  await writeFile(join(root, "note.txt"), "third");
  await createConnectedFolderCheckpoint(root, { label: "third" });
  assert.equal(existsSync(blobPath(root, hashOf(first, "note.txt"))), false, "cleanup runs again");
});
