import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import JSZip from "jszip";

import { setDiskSpaceProbeForTests } from "../src/local/disk-space.js";
import { abandonedCompressAfterMs, compressInto, copyHoldsAll, copyInto, copyItemTo, finderCopyName, folderBlockingRemoval, isInside, moveInto, removeIdentityFoldersKeptAt, sourceLostPart, sourceUnchanged, type CopiedSource } from "../src/local/file-transfer.js";

const exec = promisify(execFile);

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
  // Leaving a plain folder, which has no Recently Deleted, an identity the copy carries whole counts like any folder.
  assert.equal(await copyHoldsAll(join(root, "App", "node_modules"), join(copy, "node_modules"), { withIdentity: true }), true);
  await writeFile(join(root, "App", "node_modules", "pkg", ".amplefile", "connected-folder.json"), "{}");
  assert.equal(await copyHoldsAll(join(root, "App", "node_modules"), join(copy, "node_modules"), { withIdentity: true }), false, "one the copy lacks part of does not");
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

test("an identity whose removal stops partway keeps the folder modes it was copied with", { skip: process.platform !== "darwin" || process.getuid?.() === 0 ? "needs macOS file flags and a non-root user" : false }, async (t) => {
  const root = await folder(t);
  const identity = join(root, "source", "Trip", ".amplefile");
  await mkdir(join(identity, "conversations"), { recursive: true });
  await writeFile(join(identity, "conversations", "chat.jsonl"), "chat");
  await mkdir(join(root, "target"));
  const copy = await copyInto(join(root, "source", "Trip"), join(root, "target"), { withIdentity: true });
  const copiedChats = join(copy, ".amplefile", "conversations");
  await chmod(copiedChats, 0o555);
  await chmod(join(copy, ".amplefile"), 0o555);
  // A locked file stops the removal partway, whatever the folder modes.
  await exec("chflags", ["uchg", join(copiedChats, "chat.jsonl")]);
  try {
    assert.deepEqual(await removeIdentityFoldersKeptAt(copy, join(root, "source", "Trip")), [join(copy, ".amplefile")]);
    assert.equal((await lstat(copiedChats)).mode & 0o777, 0o555, "a folder the removal left keeps its mode");
    assert.equal((await lstat(join(copy, ".amplefile"))).mode & 0o777, 0o555);
  } finally {
    await exec("chflags", ["nouchg", join(copiedChats, "chat.jsonl")]);
    await chmod(copiedChats, 0o755).catch(() => undefined);
    await chmod(join(copy, ".amplefile"), 0o755).catch(() => undefined);
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

test("Compress streams to its name only when complete, and refuses only a disk too full for it", async (t) => {
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

  // No size or item bound: only a disk without room for its reserve refuses it, before it writes.
  setDiskSpaceProbeForTests(async () => 1024, 1024 * 1024);
  t.after(() => setDiskSpaceProbeForTests(null));
  await assert.rejects(compressInto([join(root, "Album")], root),
    (error: Error & { statusCode?: number }) => error.statusCode === 507 && /isn’t enough space on the disk/.test(error.message));
  assert.deepEqual((await readdir(root)).sort(), ["Album", "Album.zip"], "a refused Compress writes nothing");
  // A disk that fills while it writes stops it, and the working file goes.
  let free = 10 * 1024 ** 3;
  setDiskSpaceProbeForTests(async () => (free -= 4 * 1024 ** 3), 1024 ** 3, 64 * 1024);
  const big = randomBytes(1024 * 1024);
  await writeFile(join(root, "Album", "big.bin"), big);
  await assert.rejects(compressInto([join(root, "Album", "big.bin")], root), /disk is almost full/);
  assert.deepEqual((await readdir(root)).sort(), ["Album", "Album.zip"]);
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
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/local/api/place-routes.ts", import.meta.url), "utf8"));
  const body = source.slice(source.indexOf("export async function transferFileEntries"));
  assert.match(body, /transferPlace\(targetRecord\?\.place\)/);
});

test("a source is still the item a copy read only while nothing in it was written, added, removed, or swapped", async (t) => {
  const root = await folder(t);
  let made = 0;
  /** A fresh item and what a copy of it read. */
  const copied = async (withIdentity = true) => {
    const source = join(root, `Item ${made += 1}`);
    await mkdir(join(source, "sub"), { recursive: true });
    await writeFile(join(source, "a.txt"), "aaaa");
    await writeFile(join(source, "sub", "b.txt"), "bbbb");
    await symlink("a.txt", join(source, "link"));
    await mkdir(join(source, ".amplefile"));
    await writeFile(join(source, ".amplefile", "connected-folder.json"), "{}");
    const read: CopiedSource = new Map();
    await copyItemTo(source, join(root, `Copy ${made}`), { withIdentity, read });
    return { source, read, copy: join(root, `Copy ${made}`) };
  };

  const untouched = await copied();
  assert.equal(await sourceUnchanged(untouched.source, untouched.read), true);
  assert.equal(await sourceLostPart(untouched.source, untouched.read), false);
  // Reading it, or changing its mode, is not a change to what it holds.
  await readFile(join(untouched.source, "a.txt"));
  await chmod(join(untouched.source, "a.txt"), 0o600);
  assert.equal(await sourceUnchanged(untouched.source, untouched.read), true);
  assert.equal(await sourceUnchanged(untouched.source, new Map()), false, "a source no copy read is not known to be unchanged");

  // The same size a moment later: a copy's time may be two seconds off, a source's own may not be off at all.
  const rewritten = await copied();
  await writeFile(join(rewritten.source, "sub", "b.txt"), "BBBB");
  assert.equal(await copyHoldsAll(rewritten.source, rewritten.copy, { withIdentity: true }), true, "the copy check alone would let it go");
  assert.equal(await sourceUnchanged(rewritten.source, rewritten.read), false);
  assert.equal(await sourceLostPart(rewritten.source, rewritten.read), false, "nothing is missing, it only changed");

  const added = await copied();
  await writeFile(join(added.source, "sub", "late.txt"), "late");
  assert.equal(await sourceUnchanged(added.source, added.read), false);

  const removed = await copied();
  await rm(join(removed.source, "sub", "b.txt"));
  assert.equal(await sourceUnchanged(removed.source, removed.read), false);
  assert.equal(await sourceLostPart(removed.source, removed.read), true);
  assert.equal(await sourceLostPart(join(removed.source, "a.txt"), removed.read), false, "asked of one item, another's loss is not its own");

  // Another file under the same name, at the same size and time.
  const swapped = await copied();
  const was = await lstat(join(swapped.source, "a.txt"));
  await writeFile(join(swapped.source, "new"), "AAAA");
  await utimes(join(swapped.source, "new"), was.atime, was.mtime);
  await rename(join(swapped.source, "new"), join(swapped.source, "a.txt"));
  assert.equal(await sourceUnchanged(join(swapped.source, "sub"), swapped.read), true, "the part that did not change");
  assert.equal(await sourceUnchanged(swapped.source, swapped.read), false);

  const relinked = await copied();
  await rm(join(relinked.source, "link"));
  await symlink("sub/b.txt", join(relinked.source, "link"));
  assert.equal(await sourceUnchanged(relinked.source, relinked.read), false);

  const gone = await copied();
  await rm(gone.source, { recursive: true });
  assert.equal(await sourceUnchanged(gone.source, gone.read), false);
  assert.equal(await sourceLostPart(gone.source, gone.read), true);

  // A copy that left the identity behind did not read all of the source.
  const without = await copied(false);
  assert.equal(await sourceUnchanged(without.source, without.read), false);

  // Finder's own note about a folder's window is not what the folder holds: written or rewritten meanwhile, it changes nothing.
  const noted = await copied();
  await writeFile(join(noted.source, "sub", ".DS_Store"), "window");
  assert.equal(await sourceUnchanged(noted.source, noted.read), true);
  assert.equal(await copyHoldsAll(noted.source, noted.copy, { withIdentity: true }), true);
  const kept = join(root, "With note");
  await mkdir(kept);
  await writeFile(join(kept, ".DS_Store"), "before");
  await writeFile(join(kept, "a.txt"), "a");
  const keptRead: CopiedSource = new Map();
  await copyItemTo(kept, join(root, "With note copy"), { withIdentity: true, read: keptRead });
  assert.equal(await readFile(join(root, "With note copy", ".DS_Store"), "utf8"), "before", "a copy still carries the one it finds");
  await writeFile(join(kept, ".DS_Store"), "after, and longer");
  assert.equal(await sourceUnchanged(kept, keptRead), true);
  await rm(join(kept, ".DS_Store"));
  assert.equal(await sourceUnchanged(kept, keptRead), true);
  assert.equal(await sourceLostPart(kept, keptRead), false);
});

test("a folder that would stop a removal partway is found before anything is removed", { skip: process.getuid?.() === 0 ? "root ignores folder permissions" : false }, async (t) => {
  const root = await realpath(await folder(t));
  const item = join(root, "Holder", "Item");
  await mkdir(join(item, "open"), { recursive: true });
  await mkdir(join(item, "locked", "deep"), { recursive: true });
  await mkdir(join(item, "empty"));
  await writeFile(join(item, "open", "a.txt"), "a");
  await writeFile(join(item, "locked", "deep", "b.txt"), "b");
  try {
    assert.equal(await folderBlockingRemoval(item), null);
    assert.equal(await folderBlockingRemoval(join(item, "open", "a.txt")), null);
    // An empty folder goes with its parent's leave, whatever its own mode.
    await chmod(join(item, "empty"), 0o555);
    assert.equal(await folderBlockingRemoval(item), null);
    // A folder that holds something and cannot be changed stops the removal.
    await chmod(join(item, "locked"), 0o555);
    assert.equal(await folderBlockingRemoval(item), join(item, "locked"));
    assert.equal(await folderBlockingRemoval(join(item, "locked")), join(item, "locked"));
    assert.equal(await folderBlockingRemoval(join(item, "locked", "deep")), join(item, "locked"), "the folder it is in");
    assert.equal(await folderBlockingRemoval(join(item, "open")), null);
    await chmod(join(item, "locked"), 0o755);
    // So does the folder the item is in.
    await chmod(join(root, "Holder"), 0o555);
    assert.equal(await folderBlockingRemoval(item), join(root, "Holder"));
  } finally {
    // Before the temporary folder is removed.
    for (const path of [join(root, "Holder"), join(item, "locked"), join(item, "empty")]) await chmod(path, 0o755).catch(() => undefined);
  }
});

test("a folder is inside itself however its name is written, where the disk takes the spellings as one", { skip: process.platform === "linux" && "names are compared as written on Linux" }, () => {
  assert.equal(isInside("/Volumes/Work/Caf\u00e9", "/volumes/work/Cafe\u0301/Menus"), true);
  assert.equal(isInside("/Volumes/Work/Cafe\u0301", "/Volumes/Work/Caf\u00e9"), true);
  assert.equal(isInside("/Volumes/Work/Caf\u00e9", "/Volumes/Work/Caf\u00e9s"), false);
});
