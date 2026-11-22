import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findConflicts, parseConflictRequest, planPlacements } from "../src/local/file-conflicts.js";
import { moveToSystemTrash, setSystemTrashHandler } from "../src/local/system-trash.js";

/**
 * Name conflicts (src/local/file-conflicts.ts) and the system Trash
 * (src/local/system-trash.ts) on the engine itself.
 */

async function folder(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "file-conflicts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a check lists each clash with both items' kind, size, and date, and what merging would meet", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "From", "Photos", "Trip"), { recursive: true });
  await mkdir(join(root, "To", "Photos", "Trip"), { recursive: true });
  await writeFile(join(root, "From", "Photos", "a.jpg"), "aaaa");
  await writeFile(join(root, "To", "Photos", "a.jpg"), "aa");
  await writeFile(join(root, "From", "Photos", "Trip", "b.jpg"), "b");
  await writeFile(join(root, "To", "Photos", "Trip", "b.jpg"), "b");
  await writeFile(join(root, "From", "notes.txt"), "new notes");
  await writeFile(join(root, "To", "notes.txt"), "old");
  await writeFile(join(root, "From", "fresh.txt"), "fresh");
  const conflicts = await findConflicts(["Photos", "notes.txt", "fresh.txt"].map((name) => ({ source: join(root, "From", name), key: `From/${name}` })), join(root, "To"));
  assert.equal(conflicts.length, 2, "a free name is no clash");
  const [photos, notes] = conflicts;
  assert.equal(photos!.key, "From/Photos");
  assert.equal(photos!.canMerge, true);
  assert.equal(photos!.insideClashes, 2, "a.jpg and Trip/b.jpg clash inside");
  assert.deepEqual([photos!.source.kind, photos!.source.sizeBytes, photos!.existing.sizeBytes], ["folder", 5, 3]);
  assert.deepEqual([notes!.source.kind, notes!.source.sizeBytes, notes!.existing.kind, notes!.existing.sizeBytes, notes!.canMerge], ["file", 9, "file", 3, false]);
  assert.ok(!Number.isNaN(Date.parse(notes!.existing.modifiedAt)));
  assert.equal(notes!.insideClashes, undefined);
  assert.deepEqual(await findConflicts([{ source: join(root, "From", "notes.txt"), key: "x" }], join(root, "From")), [], "a copy beside itself is a duplicate, not a clash");
  assert.deepEqual(await findConflicts([{ source: join(root, "From", "notes.txt"), key: "x" }], join(root, "To"), { duplicate: true }), []);
});

test("choices resolve per item or for all, never replace across kinds without that item's own choice, and merge applies the inner choice", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "From", "Docs"), { recursive: true });
  await mkdir(join(root, "To", "Docs"), { recursive: true });
  await writeFile(join(root, "From", "Docs", "a.txt"), "a");
  await writeFile(join(root, "To", "Docs", "a.txt"), "old a");
  await writeFile(join(root, "From", "Docs", "b.txt"), "b");
  await mkdir(join(root, "From", "Report"));
  await writeFile(join(root, "To", "Report"), "a file where a folder goes");
  await writeFile(join(root, "From", "x.txt"), "x");
  await writeFile(join(root, "To", "x.txt"), "old x");
  const items = ["Docs", "Report", "x.txt"].map((name) => ({ source: join(root, "From", name), key: name }));
  const summary = (plan: Awaited<ReturnType<typeof planPlacements>>) => plan.units.map((unit) => `${unit.action}${unit.duplicate ? "+" : ""}:${unit.source.slice(root.length + 6)}`);

  const none = await planPlacements(items, join(root, "To"), null);
  assert.deepEqual(summary(none), ["place:Docs", "place:Report", "place:x.txt"], "no policy places each one, taken names getting “copy” when written");

  const replaceAll = await planPlacements(items, join(root, "To"), { apply: "replace" });
  assert.deepEqual(summary(replaceAll), ["replace:Docs", "place:Report", "replace:x.txt"], "replace for all never puts a folder over a file");
  const explicit = await planPlacements(items, join(root, "To"), { apply: "skip", items: { Report: "replace" } });
  assert.deepEqual(summary(explicit), ["skip:Docs", "replace:Report", "skip:x.txt"], "that item's own Replace may");

  const merge = await planPlacements(items, join(root, "To"), { apply: "merge", inside: "replace" });
  assert.deepEqual(summary(merge), ["replace:Docs/a.txt", "place:Docs/b.txt", "place:Report", "place:x.txt"], "merge combines folders; anything else keeps both");
  assert.deepEqual(merge.tops.map((top) => top.action), ["merge", "place", "place"]);
  const replaceInside = await planPlacements(items, join(root, "To"), { items: { Docs: "merge" }, apply: "replace" });
  assert.deepEqual(summary(replaceInside).slice(0, 2), ["replace:Docs/a.txt", "place:Docs/b.txt"], "inside takes the choice for all when it is keep-both, skip, or replace");

  const guarded = await planPlacements(items, join(root, "To"), { apply: "replace" }, { mayChange: async () => false });
  assert.deepEqual(summary(guarded), ["place:Docs", "place:Report", "place:x.txt"], "an item the place keeps is never replaced");

  assert.deepEqual(parseConflictRequest({ check: true }), { check: true, policy: null });
  assert.deepEqual(parseConflictRequest(undefined), { check: false, policy: null });
  assert.throws(() => parseConflictRequest({ apply: "overwrite" }), /Keep Both, Skip, Replace, or Merge/);
  assert.throws(() => parseConflictRequest({ inside: "merge" }), /inside a merged folder/);
});

test("the Trash: the desktop's own when registered, else the freedesktop.org home Trash on Linux", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "old.txt"), "old");
  const taken: string[] = [];
  setSystemTrashHandler(async (path) => { taken.push(path); await rm(path); });
  t.after(() => setSystemTrashHandler(null));
  assert.equal(await moveToSystemTrash(join(root, "old.txt")), true);
  assert.deepEqual(taken, [join(root, "old.txt")]);
  setSystemTrashHandler(async () => { throw new Error("no Trash here"); });
  await writeFile(join(root, "kept.txt"), "kept");
  assert.equal(await moveToSystemTrash(join(root, "kept.txt")), false, "a Trash that refuses says so");
  assert.ok(existsSync(join(root, "kept.txt")));
  setSystemTrashHandler(null);

  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, "data");
  t.after(() => { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; });
  await mkdir(join(root, "Folder"));
  await writeFile(join(root, "Folder", "a b.txt"), "trash me");
  await writeFile(join(root, "a b.txt"), "and me");
  assert.equal(await moveToSystemTrash(join(root, "Folder", "a b.txt"), "linux"), true);
  assert.equal(await moveToSystemTrash(join(root, "a b.txt"), "linux"), true);
  assert.deepEqual((await readdir(join(root, "data", "Trash", "files"))).sort(), ["a b.2.txt", "a b.txt"], "a second item of the same name gets its own");
  const info = await readFile(join(root, "data", "Trash", "info", "a b.txt.trashinfo"), "utf8");
  assert.match(info, new RegExp(`^\\[Trash Info\\]\\nPath=${join(root, "Folder", "a%20b.txt").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nDeletionDate=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\n$`));
  assert.ok(!existsSync(join(root, "Folder", "a b.txt")));
  assert.equal(await moveToSystemTrash(join(root, "nothing-here"), "linux"), false);
  assert.equal(await moveToSystemTrash(join(root, "Folder"), "win32"), false, "no Trash the host can use");
});
