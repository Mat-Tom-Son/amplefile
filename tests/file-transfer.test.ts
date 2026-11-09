import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { compressInto, copyInto, finderCopyName, moveInto } from "../src/local/file-transfer.js";

async function folder(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "file-transfer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("copies are named as Finder names them, and nothing is ever replaced", async (t) => {
  assert.equal(finderCopyName("report.pdf", 1), "report copy.pdf");
  assert.equal(finderCopyName("report.pdf", 2), "report copy 2.pdf");
  assert.equal(finderCopyName("Photos", 1), "Photos copy");
  assert.equal(finderCopyName(".env", 1), ".env copy");
  const root = await folder(t);
  await mkdir(join(root, "A"));
  await mkdir(join(root, "B"));
  await writeFile(join(root, "A", "notes.txt"), "a");
  await writeFile(join(root, "B", "notes.txt"), "b");
  const pasted = await copyInto(join(root, "A", "notes.txt"), join(root, "B"));
  assert.equal(pasted, join(root, "B", "notes copy.txt"));
  assert.equal(await readFile(join(root, "B", "notes.txt"), "utf8"), "b", "the file already there stays");
  const duplicate = await copyInto(join(root, "A", "notes.txt"), join(root, "A"), { duplicate: true });
  assert.equal(duplicate, join(root, "A", "notes copy.txt"));
  await assert.rejects(copyInto(join(root, "A"), join(root, "A")), /into itself/);
});

test("a copied folder leaves a Connected Folder's identity behind, and a move lands beside what is there", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Trip", ".amplefile"), { recursive: true });
  await writeFile(join(root, "Trip", ".amplefile", "connected-folder.json"), "{}");
  await writeFile(join(root, "Trip", "plan.md"), "plan");
  await mkdir(join(root, "Archive"));
  const copied = await copyInto(join(root, "Trip"), join(root, "Archive"));
  assert.ok(existsSync(join(copied, "plan.md")));
  assert.ok(!existsSync(join(copied, ".amplefile")), "the copy is not the same Connected Folder");
  await writeFile(join(root, "plan.md"), "loose");
  await writeFile(join(root, "Archive", "plan.md"), "kept");
  const moved = await moveInto(join(root, "plan.md"), join(root, "Archive"));
  assert.equal(moved, join(root, "Archive", "plan copy.md"));
  assert.ok(!existsSync(join(root, "plan.md")));
});

test("a copy that fails partway leaves nothing half-written behind", { skip: process.getuid?.() === 0 ? "root reads unreadable files" : false }, async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Trip", "Photos"), { recursive: true });
  await writeFile(join(root, "Trip", "a.txt"), "a");
  await writeFile(join(root, "Trip", "Photos", "b.jpg"), "b");
  await writeFile(join(root, "Trip", "Photos", "z-locked.jpg"), "locked");
  await chmod(join(root, "Trip", "Photos", "z-locked.jpg"), 0o000);
  t.after(() => chmod(join(root, "Trip", "Photos", "z-locked.jpg"), 0o600).catch(() => undefined));
  await mkdir(join(root, "Archive"));
  await writeFile(join(root, "Archive", "kept.txt"), "kept");
  await assert.rejects(copyInto(join(root, "Trip"), join(root, "Archive")));
  assert.deepEqual(await readdir(join(root, "Archive")), ["kept.txt"], "the partial copy is gone and what was there stays");
  await assert.rejects(copyInto(join(root, "Trip"), join(root, "Trip", "Photos")), /into itself/);
  assert.ok(existsSync(join(root, "Trip", "a.txt")), "the source is untouched");
});

test("Compress makes name.zip for one item and Archive.zip for several", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Quotes", ".amplefile"), { recursive: true });
  await writeFile(join(root, "Quotes", "a.txt"), "a");
  await writeFile(join(root, "b.txt"), "b");
  const single = await compressInto([join(root, "Quotes")], root);
  assert.equal(single, join(root, "Quotes.zip"));
  const names = Object.keys((await JSZip.loadAsync(await readFile(single))).files).sort();
  assert.deepEqual(names, ["Quotes/", "Quotes/a.txt"]);
  const several = await compressInto([join(root, "Quotes"), join(root, "b.txt")], root);
  assert.equal(several, join(root, "Archive.zip"));
  assert.equal(await compressInto([join(root, "b.txt")], root), join(root, "b.txt.zip"));
});

test("Compress streams to its name only when complete, and refuses work too large for it", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Album", "Inner"), { recursive: true });
  const photo = Buffer.alloc(256 * 1024, 7);
  await writeFile(join(root, "Album", "one.jpg"), photo);
  await writeFile(join(root, "Album", "Inner", "two.jpg"), photo);
  await writeFile(join(root, "Album", ".DS_Store"), "finder");
  const archive = await compressInto([join(root, "Album")], root);
  const zip = await JSZip.loadAsync(await readFile(archive));
  assert.deepEqual(Object.keys(zip.files).sort(), ["Album/", "Album/Inner/", "Album/Inner/two.jpg", "Album/one.jpg"]);
  assert.deepEqual(await zip.file("Album/Inner/two.jpg")!.async("nodebuffer"), photo);
  assert.deepEqual((await readdir(root)).sort(), ["Album", "Album.zip"], "no working file is left beside it");

  await assert.rejects(compressInto([join(root, "Album")], root, { maxBytes: 300 * 1024, maxEntries: 100 }),
    (error: Error & { statusCode?: number }) => error.statusCode === 413 && /too large to compress here/.test(error.message));
  await assert.rejects(compressInto([join(root, "Album")], root, { maxBytes: 10 * 1024 ** 2, maxEntries: 3 }),
    (error: Error & { statusCode?: number }) => error.statusCode === 413 && /too many items to compress here/.test(error.message));
  assert.deepEqual((await readdir(root)).sort(), ["Album", "Album.zip"], "a refused Compress writes nothing");
});

test("a Compress that fails partway leaves nothing behind", { skip: process.getuid?.() === 0 ? "root reads unreadable files" : false }, async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Album"));
  await writeFile(join(root, "Album", "a.jpg"), "a");
  await writeFile(join(root, "Album", "z-locked.jpg"), "locked");
  await chmod(join(root, "Album", "z-locked.jpg"), 0o000);
  t.after(() => chmod(join(root, "Album", "z-locked.jpg"), 0o600).catch(() => undefined));
  await assert.rejects(compressInto([join(root, "Album")], root));
  assert.deepEqual(await readdir(root), ["Album"]);
});

test("the transfer route reads its target as a place and a path inside it", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/local/server.ts", import.meta.url), "utf8"));
  const body = source.slice(source.indexOf("export async function transferFileEntries"));
  assert.match(body, /transferPlace\(targetRecord\?\.place\)/);
});
