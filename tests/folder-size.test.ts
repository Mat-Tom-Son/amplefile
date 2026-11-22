import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerLinkedConnectedFolder } from "../src/local/connected-folder.js";
import { FolderSizes, measureFolderSize } from "../src/local/folder-size.js";
import { startLocalApi } from "../src/local/server.js";
import { addSidebarFolder } from "../src/local/standard-folders.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";

// A folder's size on request (host only): the total and the items inside,
// never following a link, never entering another volume, saying nothing of
// AmpleFile's and Pi's data, stopping when asked, and marked partial when a
// bound stops it.

async function folder(t: test.TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A small tree: 3 files of 1,000 + 2,000 + 3,000 bytes in two folders, plus everything that must not count. */
async function tree(t: test.TestContext): Promise<{ root: string; outside: string }> {
  const root = await folder(t, "amplefile-size-");
  const outside = await folder(t, "amplefile-size-outside-");
  await mkdir(join(root, "Drafts", "Old"), { recursive: true });
  await writeFile(join(root, "a.txt"), "a".repeat(1000));
  await writeFile(join(root, "Drafts", "b.txt"), "b".repeat(2000));
  await writeFile(join(root, "Drafts", "Old", "c.txt"), "c".repeat(3000));
  // AmpleFile's and Pi's data, at the top and deeper: not counted at all.
  await mkdir(join(root, ".amplefile", "conversations"), { recursive: true });
  await writeFile(join(root, ".amplefile", "conversations", "chat.jsonl"), "x".repeat(50_000));
  await mkdir(join(root, "Drafts", ".pi", "skills"), { recursive: true });
  await writeFile(join(root, "Drafts", ".pi", "skills", "SKILL.md"), "x".repeat(40_000));
  await mkdir(join(root, ".PI"), { recursive: true });
  await writeFile(join(root, ".PI", "settings.json"), "x".repeat(30_000));
  // Links: one to a big file and one to a big folder outside; neither is followed.
  await writeFile(join(outside, "big.bin"), "");
  await truncate(join(outside, "big.bin"), 10 * 1024 * 1024);
  await symlink(join(outside, "big.bin"), join(root, "big-link"));
  await symlink(outside, join(root, "Drafts", "outside-link"));
  await symlink(join(outside, "missing"), join(root, "broken-link"));
  return { root, outside };
}

test("a folder's size counts its files and folders, never follows a link, and leaves out AmpleFile's and Pi's data", async (t) => {
  const { root } = await tree(t);
  const size = await measureFolderSize(root);
  assert.equal(size.bytes, 6000);
  assert.equal(size.files, 3);
  assert.equal(size.folders, 2, "Drafts and Old");
  assert.equal(size.links, 3, "each link is one item that adds nothing");
  assert.equal(size.items, 8);
  assert.equal(size.complete, true);
  assert.equal(size.stoppedBy, null);
  assert.equal(size.unreadable, 0);
  assert.equal(size.otherVolumes, 0);
  assert.ok(size.bytesOnDisk === null || size.bytesOnDisk >= 0);
  assert.match(size.measuredAt, /^\d{4}-\d{2}-\d{2}T/);

  // A hard-linked file is two names: both count toward bytes, its space on disk only once.
  await link(join(root, "Drafts", "Old", "c.txt"), join(root, "c-again.txt"));
  const linked = await measureFolderSize(root);
  assert.equal(linked.bytes, 9000);
  assert.equal(linked.files, 4);
  if (linked.bytesOnDisk !== null && size.bytesOnDisk !== null) assert.equal(linked.bytesOnDisk, size.bytesOnDisk);

  await assert.rejects(measureFolderSize(join(root, "a.txt")), { statusCode: 400 });
  await assert.rejects(measureFolderSize(join(root, "big-link")), { statusCode: 400 }, "the folder itself may not be a link");
});

test("a bound stops the walk with a partial total marked as such", async (t) => {
  const root = await folder(t, "amplefile-size-big-");
  for (let folderIndex = 0; folderIndex < 20; folderIndex += 1) {
    await mkdir(join(root, `f${folderIndex}`));
    for (let fileIndex = 0; fileIndex < 20; fileIndex += 1) await writeFile(join(root, `f${folderIndex}`, `${fileIndex}.txt`), "1234567890");
  }
  const whole = await measureFolderSize(root);
  assert.deepEqual([whole.items, whole.bytes, whole.complete], [420, 4000, true]);

  const byItems = await measureFolderSize(root, { limits: { maxItems: 50 } });
  assert.equal(byItems.stoppedBy, "item-limit");
  assert.equal(byItems.complete, false);
  assert.ok(byItems.items >= 50 && byItems.items < 420, `${byItems.items} items`);
  assert.ok(byItems.bytes < 4000);

  const byTime = await measureFolderSize(root, { limits: { maxMs: 0 } });
  assert.equal(byTime.stoppedBy, "time-limit");
  assert.equal(byTime.complete, false);
  assert.ok(byTime.items < 420);
});

test("a walk stops when the request goes away, and is shared and briefly kept otherwise", async (t) => {
  const { root } = await tree(t);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(measureFolderSize(root, { signal: stopped.signal }), { name: "AbortError" });

  const sizes = new FolderSizes({}, 60_000);
  // Two requests share one walk; one leaving does not stop it for the other.
  const leaving = new AbortController();
  const first = sizes.measure(root, { signal: leaving.signal });
  const second = sizes.measure(root);
  leaving.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal((await second).bytes, 6000);
  assert.equal(sizes.walksStarted, 1);
  // Asked again within the lifetime: the kept answer, no walk.
  const kept = await sizes.measure(root);
  assert.equal(kept.cached, true);
  assert.equal(sizes.walksStarted, 1);
  // A fresh ask walks again and sees a change.
  await writeFile(join(root, "Drafts", "Old", "d.txt"), "d".repeat(500));
  const fresh = await sizes.measure(root, { fresh: true });
  assert.deepEqual([fresh.cached, fresh.bytes], [false, 6500]);
  assert.equal(sizes.walksStarted, 2);

  // When every request waiting on a walk goes away, the walk itself stops.
  const big = await folder(t, "amplefile-size-cancel-");
  for (let index = 0; index < 200; index += 1) {
    await mkdir(join(big, `f${index}`));
    await writeFile(join(big, `f${index}`, "x.txt"), "x");
  }
  const cancelling = new FolderSizes({ concurrency: 1 }, 60_000);
  const gone = new AbortController();
  const abandoned = cancelling.measure(big, { signal: gone.signal });
  gone.abort();
  await assert.rejects(abandoned, { name: "AbortError" });
  const next = await cancelling.measure(big);
  assert.equal(next.cached, false, "the abandoned walk left no answer behind");
  assert.equal(next.items, 400);
  assert.equal(cancelling.walksStarted, 2);
});

test("another volume mounted inside is counted as one folder and not entered", async (t) => {
  // /dev's own file system holds other mounts on Linux (/dev/shm, /dev/pts); elsewhere this is skipped.
  const mounted = ["/dev/shm", "/dev/pts", "/dev/mqueue"].filter((path) => existsSync(path) && lstatSync(path).isDirectory() && lstatSync(path).dev !== lstatSync("/dev").dev);
  if (process.platform !== "linux" || !mounted.length) {
    t.skip("No volume mounted inside /dev on this system.");
    return;
  }
  const size = await measureFolderSize("/dev", { limits: { maxMs: 5_000 } });
  assert.ok(size.otherVolumes >= mounted.length, `${size.otherVolumes} other volumes, expected ${mounted.length}`);
});

test("the folder-size routes measure a folder in every kind of place under its path policy", async (t) => {
  const sandbox = await folder(t, "amplefile-size-api-");
  const home = join(sandbox, "home");
  await mkdir(home, { recursive: true });
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => { await api.close(); configureAmpleFileStateRoot(undefined); });

  const { root } = await tree(t);
  await mkdir(join(sandbox, "elsewhere"));
  const connected = await registerLinkedConnectedFolder(root);
  const base = `${api.origin}/api/connected-folders/${connected.id}/folder-size`;
  const whole = await fetch(`${base}?path=`);
  assert.equal(whole.status, 200, await whole.clone().text());
  const body = await whole.json() as { folderSize: Record<string, unknown> };
  assert.deepEqual(
    { path: body.folderSize.path, bytes: body.folderSize.bytes, items: body.folderSize.items, files: body.folderSize.files, folders: body.folderSize.folders, links: body.folderSize.links, complete: body.folderSize.complete, stoppedBy: body.folderSize.stoppedBy, cached: body.folderSize.cached },
    { path: "", bytes: 6000, items: 8, files: 3, folders: 2, links: 3, complete: true, stoppedBy: null, cached: false },
    "registering wrote .amplefile/connected-folder.json, which is not counted",
  );
  const drafts = await (await fetch(`${base}?path=Drafts`)).json() as { folderSize: { bytes: number; items: number } };
  assert.deepEqual([drafts.folderSize.bytes, drafts.folderSize.items], [5000, 4]);
  assert.equal((await fetch(`${base}?path=a.txt`)).status, 400, "a file has no folder size");
  assert.equal((await fetch(`${base}?path=Drafts%2Foutside-link`)).status, 400, "a link is refused");
  assert.equal((await fetch(`${base}?path=..`)).status, 400, "nothing outside the place");
  assert.equal((await fetch(`${base}?path=.amplefile`)).status, 400, "nothing in AmpleFile's data");
  assert.equal((await fetch(`${base}?path=missing`)).status, 404);

  const added = addSidebarFolder(root, home);
  const standard = await (await fetch(`${api.origin}/api/standard-folders/${added.id}/folder-size?path=Drafts%2FOld`)).json() as { folderSize: { bytes: number; items: number } };
  assert.deepEqual([standard.folderSize.bytes, standard.folderSize.items], [3000, 1]);
  const computer = await fetch(`${api.origin}/api/standard-folders/computer/folder-size?path=${encodeURIComponent(join(root, "Drafts").slice(1))}`);
  assert.equal(computer.status, 200);
  assert.equal((await computer.json() as { folderSize: { bytes: number } }).folderSize.bytes, 5000);
  assert.equal((await fetch(`${api.origin}/api/standard-folders/computer/folder-size?path=`)).status, 400, "the whole disk is not walked");
});
