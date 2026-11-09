import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { abandonedCompressAfterMs, compressInto, copyHoldsAll, copyInto, finderCopyName, moveInto, removeIdentityFoldersKeptAt } from "../src/local/file-transfer.js";

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

test("a copy holds its source only when every file is there the same, and never when it holds an identity", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "App", "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "App", "node_modules", "pkg", "index.js"), "1");
  await mkdir(join(root, "Target"));
  const copy = await copyInto(join(root, "App"), join(root, "Target"), { withIdentity: true });
  assert.equal(await copyHoldsAll(join(root, "App", "node_modules"), join(copy, "node_modules")), true);
  await writeFile(join(root, "App", "node_modules", "pkg", "late.js"), "added after the copy");
  assert.equal(await copyHoldsAll(join(root, "App", "node_modules"), join(copy, "node_modules")), false, "a file added after the copy is not held");
  await rm(join(root, "App", "node_modules", "pkg", "late.js"));
  await writeFile(join(root, "App", "node_modules", "pkg", "index.js"), "12");
  assert.equal(await copyHoldsAll(join(root, "App", "node_modules"), join(copy, "node_modules")), false, "a changed file is not held");
  await mkdir(join(root, "App", "node_modules", "pkg", ".amplefile"));
  await mkdir(join(copy, "node_modules", "pkg", ".amplefile"));
  await writeFile(join(copy, "node_modules", "pkg", "index.js"), "12");
  assert.equal(await copyHoldsAll(join(root, "App", "node_modules"), join(copy, "node_modules")), false, "an identity is never counted as held");
});

test("a copy keeps relative links as written, and a link counts as held only when it points where its original does", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Proj", "v2"), { recursive: true });
  await writeFile(join(root, "Proj", "v2", "app.txt"), "v2");
  await symlink("v2", join(root, "Proj", "current"));
  await mkdir(join(root, "Target"));
  const copy = await copyInto(join(root, "Proj"), join(root, "Target"));
  assert.equal(await readlink(join(copy, "current")), "v2", "the link is not pointed back into the source");
  assert.equal(await readFile(join(copy, "current", "app.txt"), "utf8"), "v2");
  assert.equal(await copyHoldsAll(join(root, "Proj", "current"), join(copy, "current")), true);
  await rm(join(copy, "current"));
  await symlink(join(root, "Proj", "v2"), join(copy, "current"));
  assert.equal(await copyHoldsAll(join(root, "Proj", "current"), join(copy, "current")), false, "a link pointing elsewhere is not held");
});

test("a copied identity goes only when its original is still whole in the source", async (t) => {
  const root = await folder(t);
  const plant = async (path: string, chat: string) => {
    await mkdir(join(path, "Trip", ".amplefile", "conversations"), { recursive: true });
    await writeFile(join(path, "Trip", ".amplefile", "conversations", "chat.jsonl"), chat);
  };
  for (const name of ["Intact", "Gone", "Changed"]) await plant(join(root, "source", name), "chat");
  await mkdir(join(root, "target"));
  const copies = new Map<string, string>();
  for (const name of ["Intact", "Gone", "Changed"]) copies.set(name, await copyInto(join(root, "source", name), join(root, "target"), { withIdentity: true }));
  await rm(join(root, "source", "Gone", "Trip", ".amplefile"), { recursive: true });
  await writeFile(join(root, "source", "Changed", "Trip", ".amplefile", "conversations", "chat.jsonl"), "chat, then more");
  for (const name of ["Intact", "Gone", "Changed"]) assert.deepEqual(await removeIdentityFoldersKeptAt(copies.get(name)!, join(root, "source", name)), []);
  assert.ok(!existsSync(join(copies.get("Intact")!, "Trip", ".amplefile")), "the source still has it, so the copy is an ordinary copy");
  assert.equal(await readFile(join(copies.get("Gone")!, "Trip", ".amplefile", "conversations", "chat.jsonl"), "utf8"), "chat", "the only whole copy stays");
  assert.ok(existsSync(join(copies.get("Changed")!, "Trip", ".amplefile")), "a source that differs does not stand in for the copy");
});

test("a copied identity it cannot reach is reported, not hidden", { skip: process.getuid?.() === 0 ? "root ignores folder permissions" : false }, async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "source", "Trip", "Inner", ".amplefile"), { recursive: true });
  await writeFile(join(root, "source", "Trip", "Inner", ".amplefile", "connected-folder.json"), "{}");
  await mkdir(join(root, "target"));
  const copy = await copyInto(join(root, "source", "Trip"), join(root, "target"), { withIdentity: true });
  // A folder of the copy that cannot be read may still hold the identity.
  await chmod(join(copy, "Inner"), 0o000);
  try {
    assert.deepEqual(await removeIdentityFoldersKeptAt(copy, join(root, "source", "Trip")), [join(copy, "Inner")]);
  } finally {
    await chmod(join(copy, "Inner"), 0o755);
  }
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

test("Compress clears working files an interrupted Compress left, never one still being written", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "notes.txt"), "notes");
  const abandoned = join(root, ".AmpleFile-compress-0011223344556677.partial");
  const active = join(root, ".AmpleFile-compress-8899aabbccddeeff.partial");
  const lookalike = join(root, ".AmpleFile-compress-notes.txt");
  for (const path of [abandoned, active, lookalike]) await writeFile(path, "partial");
  const old = new Date(Date.now() - abandonedCompressAfterMs - 60_000);
  await utimes(abandoned, old, old);
  await utimes(lookalike, old, old);
  await compressInto([join(root, "notes.txt")], root);
  assert.deepEqual((await readdir(root)).sort(), [".AmpleFile-compress-8899aabbccddeeff.partial", ".AmpleFile-compress-notes.txt", "notes.txt", "notes.txt.zip"],
    "the abandoned working file is gone; one changed recently and anything else stay");
});

test("the transfer route reads its target as a place and a path inside it", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/local/server.ts", import.meta.url), "utf8"));
  const body = source.slice(source.indexOf("export async function transferFileEntries"));
  assert.match(body, /transferPlace\(targetRecord\?\.place\)/);
});
