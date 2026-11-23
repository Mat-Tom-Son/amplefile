import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import JSZip from "jszip";

import { abandonedCompressAfterMs, compressInto } from "../src/local/file-transfer.js";
import { archiveEntrySegments, extractArchive, extractClash, extractFolderName, linkStaysInside } from "../src/local/archive-extract.js";
import { setDiskSpaceProbeForTests } from "../src/local/disk-space.js";
import { setZip64ForTests } from "../src/local/zip-writer.js";

const exec = promisify(execFile);
import { cancelFileOperation, runFileOperation, setFileOperationBoundaryHookForTests } from "../src/local/file-operations.js";

/**
 * Extract (src/local/archive-extract.ts): an archive's one file or folder
 * lands beside it as itself, several items land in a new folder named after
 * it, and every archive is treated as hostile.
 */

async function folder(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "archive-extract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A zip from JSZip, with each placeholder name swapped for a same-length hostile one in both its headers. */
async function zipWith(files: Record<string, { content?: string | Buffer; unixPermissions?: number; dir?: boolean }>, rename: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, file] of Object.entries(files)) {
    if (file.dir) zip.folder(name);
    else zip.file(name, file.content ?? "", { unixPermissions: file.unixPermissions, binary: true });
  }
  let bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
  for (const [from, to] of Object.entries(rename)) {
    assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
    const fromBytes = Buffer.from(from);
    const toBytes = Buffer.from(to);
    for (let at = bytes.indexOf(fromBytes); at >= 0; at = bytes.indexOf(fromBytes, at + 1)) toBytes.copy(bytes, at);
  }
  bytes = Buffer.from(bytes);
  return bytes;
}

/** One tar header and its data, as `tar` writes them. */
function tarEntry(name: string, options: { type?: string; content?: Buffer | string; linkName?: string; mode?: number } = {}): Buffer {
  const content = Buffer.from(options.content ?? "");
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${(options.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, "latin1");
  header.write(options.type ?? "0", 156, "latin1");
  if (options.linkName) header.write(options.linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function tar(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

/** A pax extended header naming the next entry's path. */
function paxPath(path: string): Buffer {
  const body = (length: number) => `${length} path=${path}\n`;
  let length = Buffer.byteLength(body(0));
  while (Buffer.byteLength(body(length)) !== length) length = Buffer.byteLength(body(length));
  return tarEntry("PaxHeader", { type: "x", content: body(length) });
}

async function listTree(path: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of (await readdir(path)).sort()) {
    const info = await lstat(join(path, entry));
    found.push(`${prefix}${entry}${info.isDirectory() ? "/" : ""}`);
    if (info.isDirectory()) found.push(...await listTree(join(path, entry), `${prefix}${entry}/`));
  }
  return found;
}

test("an archive of several items extracts into a new folder beside it, named after it, never replacing one", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "Photos.zip"), await zipWith({ "a.jpg": { content: "a" }, "Trip/b.jpg": { content: "b" }, "Empty/": { dir: true } }));
  const first = await extractArchive(join(root, "Photos.zip"));
  assert.equal(first.path, join(root, "Photos"));
  assert.equal(first.kind, "folder");
  assert.deepEqual(await listTree(first.path), ["Empty/", "Trip/", "Trip/b.jpg", "a.jpg"]);
  assert.equal(await readFile(join(first.path, "Trip", "b.jpg"), "utf8"), "b");
  assert.equal(first.files, 2);
  const second = await extractArchive(join(root, "Photos.zip"));
  assert.equal(second.path, join(root, "Photos copy"), "a taken name gets “copy”");
  assert.equal(await readFile(join(root, "Photos", "a.jpg"), "utf8"), "a", "the first folder stays");
  assert.deepEqual((await readdir(root)).sort(), ["Photos", "Photos copy", "Photos.zip"], "no working folder is left");
  assert.equal(extractFolderName("backup.tar.gz"), "backup");
  assert.equal(extractFolderName("backup.TGZ"), "backup");
});

test("a compressed folder extracts back to the folder, not a folder inside one", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Trip", "Day 1"), { recursive: true });
  await writeFile(join(root, "Trip", "Day 1", "plan.md"), "plan");
  const archive = await compressInto([join(root, "Trip")], root);
  await rm(join(root, "Trip"), { recursive: true });
  const extracted = await extractArchive(archive);
  assert.equal(extracted.path, join(root, "Trip"));
  assert.equal(await readFile(join(root, "Trip", "Day 1", "plan.md"), "utf8"), "plan");
});

test("an archive of one file extracts as that file beside it, as Finder's Archive Utility does", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "report.txt"), "the report");
  await chmod(join(root, "report.txt"), 0o755);
  const archive = await compressInto([join(root, "report.txt")], root);
  assert.equal(archive, join(root, "report.txt.zip"));
  // Beside the file it came from, it keeps both, Finder's way.
  const beside = await extractArchive(archive);
  assert.equal(beside.path, join(root, "report copy.txt"));
  assert.equal(beside.kind, "file");
  assert.equal(await readFile(beside.path, "utf8"), "the report");
  assert.equal((await stat(beside.path)).mode & 0o7777, 0o755, "its execute bits come back");
  await rm(join(root, "report.txt"));
  await rm(beside.path);
  const back = await extractArchive(archive);
  assert.equal(back.path, join(root, "report.txt"), "not report.txt/report.txt");
  assert.deepEqual((await readdir(root)).sort(), ["report.txt", "report.txt.zip"], "no working folder is left");

  await writeFile(join(root, "notes.tgz"), gzipSync(tar(tarEntry("notes.md", { content: "notes" }))));
  const tarred = await extractArchive(join(root, "notes.tgz"));
  assert.equal(tarred.path, join(root, "notes.md"));
  assert.equal(await readFile(tarred.path, "utf8"), "notes");
});

test("an archive of one folder extracts as that folder, whatever its name, and its links must stay inside it", async (t) => {
  const root = await folder(t);
  // Archive Utility's zips carry __MACOSX beside the folder: it is not an item.
  await writeFile(join(root, "Photos.zip"), await zipWith({ "Holiday/day1.jpg": { content: "1" }, "Holiday/Inner/day2.jpg": { content: "2" }, "__MACOSX/Holiday/._day1.jpg": { content: "fork" } }));
  const zipped = await extractArchive(join(root, "Photos.zip"));
  assert.equal(zipped.path, join(root, "Holiday"), "not Photos/Holiday");
  assert.equal(zipped.kind, "folder");
  assert.deepEqual(await listTree(zipped.path), ["Inner/", "Inner/day2.jpg", "day1.jpg"]);

  await writeFile(join(root, "outside"), "not to be reached");
  await writeFile(join(root, "tool.tar"), tar(
    tarEntry("Tool/", { type: "5" }),
    tarEntry("Tool/lib/real", { content: "real" }),
    tarEntry("Tool/bin/run", { type: "2", linkName: "../lib/real" }),
    // Inside the archive's top, but outside the folder once it lands beside the archive.
    tarEntry("Tool/up", { type: "2", linkName: "../outside" }),
    tarEntry("Tool", { type: "2", linkName: "elsewhere" }),
  ));
  const tarred = await extractArchive(join(root, "tool.tar"));
  assert.equal(tarred.path, join(root, "Tool"));
  assert.equal(await readFile(join(tarred.path, "bin", "run"), "utf8"), "real");
  assert.ok(!(await lstat(join(tarred.path, "up")).catch(() => null)), "a link leading out of the folder is left out");
  assert.deepEqual(tarred.skipped.map((item) => `${item.reason}:${item.path}`).sort(), ["link:Tool/up", "repeat:Tool"]);
  assert.equal(tarred.links, 1);
});

test("an archive whose one top item is a link, or that holds nothing, still makes a folder", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "shortcut.tar"), tar(tarEntry("shortcut", { type: "2", linkName: "target" })));
  const linked = await extractArchive(join(root, "shortcut.tar"));
  assert.equal(linked.path, join(root, "shortcut"), "the link stays inside a new folder, where it was checked");
  assert.equal(linked.kind, "folder");
  assert.equal(await readlink(join(linked.path, "shortcut")), "target");

  await writeFile(join(root, "empty.zip"), await zipWith({ "__MACOSX/._x": { content: "fork" } }));
  const empty = await extractArchive(join(root, "empty.zip"));
  assert.equal(empty.path, join(root, "empty"));
  assert.deepEqual(await readdir(empty.path), []);
});

test("the name-clash check names what Extract will make, reading no more of the archive than it must", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "report.txt.zip"), await zipWith({ "report.txt": { content: "r" } }));
  assert.equal(await extractClash(join(root, "report.txt.zip")), null, "a free name is no clash");
  await writeFile(join(root, "report.txt"), "old");
  assert.deepEqual(await extractClash(join(root, "report.txt.zip")), { name: "report.txt", kind: "file" });

  await writeFile(join(root, "Photos.zip"), await zipWith({ "Holiday/a.jpg": { content: "a" } }));
  assert.equal(await extractClash(join(root, "Photos.zip")), null);
  await mkdir(join(root, "Photos"));
  assert.equal(await extractClash(join(root, "Photos.zip")), null, "a taken archive name does not matter when the one folder's is free");
  await mkdir(join(root, "Holiday"));
  assert.deepEqual(await extractClash(join(root, "Photos.zip")), { name: "Holiday", kind: "folder" });

  // The first item's name is taken, but a second item makes it a folder of the archive's name, which is free.
  await writeFile(join(root, "mixed.tgz"), gzipSync(tar(tarEntry("Holiday/a.jpg", { content: "a" }), tarEntry("b.jpg", { content: "b" }))));
  assert.equal(await extractClash(join(root, "mixed.tgz")), null);
  await mkdir(join(root, "mixed"));
  assert.deepEqual(await extractClash(join(root, "mixed.tgz")), { name: "mixed", kind: "folder" });

  // A folder of the archive's own name is its name either way: the rest, here damaged, is never read.
  const whole = gzipSync(tar(tarEntry("bundle/", { type: "5" }), tarEntry("bundle/big.bin", { content: randomBytes(400_000) })));
  await writeFile(join(root, "bundle.tgz"), whole.subarray(0, whole.length - 200_000));
  await mkdir(join(root, "bundle"));
  assert.deepEqual(await extractClash(join(root, "bundle.tgz")), { name: "bundle", kind: "folder" });
  await rm(join(root, "bundle"), { recursive: true });
  assert.equal(await extractClash(join(root, "bundle.tgz")), null, "nor when neither name is taken");
  await assert.rejects(extractArchive(join(root, "bundle.tgz")), "extracting still reads all of it");
  assert.ok(!existsSync(join(root, "bundle")));
});

test("tar and gzipped tar archives extract, with long names", async (t) => {
  const root = await folder(t);
  const longName = `${"deep/".repeat(30)}file.txt`;
  const body = tar(
    tarEntry("docs/", { type: "5" }),
    tarEntry("docs/readme.txt", { content: "hello" }),
    paxPath(longName),
    tarEntry("ignored-name", { content: "long" }),
    tarEntry("big.bin", { content: Buffer.alloc(3000, 9) }),
  );
  await writeFile(join(root, "bundle.tar"), body);
  await writeFile(join(root, "bundle2.tgz"), gzipSync(body));
  for (const [archive, name] of [["bundle.tar", "bundle"], ["bundle2.tgz", "bundle2"]] as const) {
    const result = await extractArchive(join(root, archive));
    assert.equal(result.path, join(root, name));
    assert.equal(await readFile(join(result.path, "docs", "readme.txt"), "utf8"), "hello");
    assert.equal(await readFile(join(result.path, ...longName.split("/")), "utf8"), "long");
    assert.equal((await stat(join(result.path, "big.bin"))).size, 3000);
    assert.ok(!existsSync(join(result.path, "ignored-name")));
  }
});

test("an entry that would land outside its folder refuses the whole archive and leaves nothing", async (t) => {
  const root = await folder(t);
  const hostile = ["../evil.txt", "/etc/x.txt", "C:/win.txt", "ok/../../x.txt", "a\\..\\..\\x.txt"];
  for (const [index, name] of hostile.entries()) {
    const placeholder = "pqrst"[index]!.repeat(Buffer.byteLength(name));
    await writeFile(join(root, "bad.zip"), await zipWith({ "fine.txt": { content: "fine" }, [placeholder]: { content: "evil" } }, { [placeholder]: name }));
    await assert.rejects(extractArchive(join(root, "bad.zip")), (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 400, name);
      assert.match(error.message, /outside its folder/);
      return true;
    });
    assert.deepEqual(await readdir(root), ["bad.zip"], `${name}: nothing is left beside the archive`);
  }
  assert.ok(!existsSync(join(root, "..", "evil.txt")));
  for (const name of ["../x", "/x", "C:\\x", "a/../../x", "x\0y"]) assert.throws(() => archiveEntrySegments(name), /outside its folder/, name);
  assert.deepEqual(archiveEntrySegments("./a//b/./c"), { segments: ["a", "b", "c"] });
  assert.equal(linkStaysInside(["bin", "tool"], "../lib/tool"), true);
  for (const target of ["../x", "/etc/passwd", "C:/x", "a\\..\\..\\x", "", ".amplefile/connected-folder.json"]) assert.equal(linkStaysInside(["tool"], target), false, target);

  await writeFile(join(root, "bad.tar"), tar(tarEntry("fine.txt", { content: "fine" }), tarEntry("../../escape.txt", { content: "evil" })));
  await assert.rejects(extractArchive(join(root, "bad.tar")), /outside its folder/);
  await writeFile(join(root, "bad2.tar"), tar(paxPath("/abs/escape.txt"), tarEntry("x", { content: "evil" })));
  await assert.rejects(extractArchive(join(root, "bad2.tar")), /outside its folder/);
  assert.deepEqual((await readdir(root)).sort(), ["bad.tar", "bad.zip", "bad2.tar"]);
});

test("links leading outside, hard links, special files, and Connected Folder or Pi configuration are left out", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "mixed.zip"), await zipWith({
    "keep.txt": { content: "keep" },
    "link": { content: "/etc/passwd", unixPermissions: 0o120777 },
    "fifo": { content: "", unixPermissions: 0o010644 },
    ".amplefile/connected-folder.json": { content: "{}" },
    "Sub/.pi/extensions/run.ts": { content: "export default () => {}" },
    "Sub/.AmpleFile/x.json": { content: "{}" },
    "__MACOSX/._keep.txt": { content: "fork" },
  }));
  const zipped = await extractArchive(join(root, "mixed.zip"));
  assert.deepEqual(await listTree(zipped.path), ["Sub/", "keep.txt"]);
  assert.deepEqual(zipped.skipped.map((item) => `${item.reason}:${item.path}`).sort(), [
    "configuration:.amplefile/connected-folder.json",
    "configuration:Sub/.AmpleFile/x.json",
    "configuration:Sub/.pi/extensions/run.ts",
    "link:link",
    "special:fifo",
  ]);

  await writeFile(join(root, "mixed.tar"), tar(
    tarEntry("keep.txt", { content: "keep" }),
    tarEntry("symlink", { type: "2", linkName: "/etc/passwd" }),
    tarEntry("up", { type: "2", linkName: "../../outside" }),
    tarEntry("hardlink", { type: "1", linkName: "/etc/passwd" }),
    tarEntry("device", { type: "3" }),
    tarEntry("pipe", { type: "6" }),
    tarEntry(".pi/settings.json", { content: "{}" }),
    tarEntry("to-config", { type: "2", linkName: ".pi/settings.json" }),
  ));
  const tarred = await extractArchive(join(root, "mixed.tar"));
  // What is left out is not an item: the one file left lands beside the archive.
  assert.equal(tarred.path, join(root, "keep.txt"));
  assert.equal(tarred.kind, "file");
  assert.deepEqual(tarred.skipped.map((item) => `${item.reason}:${item.path}`).sort(), [
    "configuration:.pi/settings.json", "hard-link:hardlink", "link:symlink", "link:to-config", "link:up", "special:device", "special:pipe",
  ]);
});

test("links that stay inside the new folder are made, and one that escapes through another link is removed", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "links.tar"), tar(
    tarEntry("lib/", { type: "5" }),
    tarEntry("lib/libthing.so.1", { content: "library" }),
    tarEntry("lib/libthing.so", { type: "2", linkName: "libthing.so.1" }),
    tarEntry("bin/", { type: "5" }),
    tarEntry("bin/thing", { type: "2", linkName: "../lib/libthing.so" }),
    tarEntry("dangling", { type: "2", linkName: "not-in-the-archive" }),
    // "here" is the new folder itself, so "here/.." would be the folder beside it.
    tarEntry("here", { type: "2", linkName: "." }),
    tarEntry("escape", { type: "2", linkName: "here/../outside" }),
    // A file never lands through a link: "here/x" would write into the folder through "here".
    tarEntry("loop", { type: "2", linkName: "loop" }),
  ));
  await writeFile(join(root, "outside"), "not to be reached");
  const result = await extractArchive(join(root, "links.tar"));
  assert.equal(await readFile(join(result.path, "bin", "thing"), "utf8"), "library", "a link inside the folder works");
  assert.equal(await readlink(join(result.path, "bin", "thing")), "../lib/libthing.so", "kept as written");
  assert.equal(await readlink(join(result.path, "dangling")), "not-in-the-archive");
  assert.ok(existsSync(join(result.path, "here")));
  assert.ok(!existsSync(join(result.path, "escape")), "a link reaching outside through another link is removed");
  assert.ok(!(await lstat(join(result.path, "loop")).catch(() => null)), "a link to itself is removed");
  assert.deepEqual(result.skipped.map((item) => `${item.reason}:${item.path}`).sort(), ["link:escape", "link:loop"]);
  assert.equal(result.links, 4);
});
test("Extract keeps the execute bits an archive records, never a set-id or sticky bit, never more than 0755", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "tools.zip"), await zipWith({
    "run.sh": { content: "#!/bin/sh\n", unixPermissions: 0o104777 },
    "notes.txt": { content: "notes", unixPermissions: 0o100666 },
    "own.sh": { content: "#!/bin/sh\n", unixPermissions: 0o100700 },
    "bin/": { dir: true, unixPermissions: 0o041777 },
  }));
  const zipped = await extractArchive(join(root, "tools.zip"));
  const mode = async (path: string) => (await stat(join(zipped.path, path))).mode & 0o7777;
  assert.equal(await mode("run.sh"), 0o755);
  assert.equal(await mode("notes.txt"), 0o644, "not writable by others");
  assert.equal(await mode("own.sh"), 0o744);
  assert.equal((await mode("bin")) & 0o7022, 0, "a folder is never more than 0755");

  await writeFile(join(root, "tools.tar"), tar(tarEntry("run.sh", { content: "#!/bin/sh\n", mode: 0o6777 }), tarEntry("data", { content: "d", mode: 0o600 })));
  const tarred = await extractArchive(join(root, "tools.tar"));
  assert.equal((await stat(join(tarred.path, "run.sh"))).mode & 0o7777, 0o755);
  assert.equal((await stat(join(tarred.path, "data"))).mode & 0o7777, 0o644);

  // What Compress writes keeps its modes, so an executable round-trips.
  await mkdir(join(root, "Tool"));
  await writeFile(join(root, "Tool", "go"), "#!/bin/sh\n", { mode: 0o755 });
  await chmod(join(root, "Tool", "go"), 0o755);
  const archive = await compressInto([join(root, "Tool")], root);
  await rm(join(root, "Tool"), { recursive: true });
  const back = await extractArchive(archive);
  assert.equal((await stat(join(back.path, "go"))).mode & 0o7777, 0o755);
});
test("a zip entry that inflates past its declared size is refused, and the disk guard stops what does not fit", async (t) => {
  const root = await folder(t);
  // An entry that inflates past the size it declares is refused.
  const honest = await zipWith({ "c.bin": { content: Buffer.alloc(50_000) } });
  const lying = Buffer.from(honest);
  const central = lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(1000, central + 24);
  await writeFile(join(root, "lying.zip"), lying);
  await assert.rejects(extractArchive(join(root, "lying.zip")), /damaged/);

  // A zip whose declared sizes do not fit the disk is refused before anything is written.
  await writeFile(join(root, "bomb.zip"), await zipWith({ "a.bin": { content: Buffer.alloc(600_000) }, "b.bin": { content: Buffer.alloc(600_000) } }));
  assert.ok((await stat(join(root, "bomb.zip"))).size < 10_000, "the archive is small");
  setDiskSpaceProbeForTests(async () => 1_500_000, 1_000_000);
  t.after(() => setDiskSpaceProbeForTests(null));
  await assert.rejects(extractArchive(join(root, "bomb.zip")), (error: Error & { statusCode?: number }) => {
    assert.equal(error.statusCode, 507);
    assert.match(error.message, /isn’t enough space on the disk to extract this archive \(it needs about 1 MB; 1 MB is free\)/);
    return true;
  });
  // A gzipped tar cannot say its size first, so the guard stops it while it writes.
  let free = 50_000_000;
  setDiskSpaceProbeForTests(async () => (free -= 20_000_000), 20_000_000, 100_000);
  await writeFile(join(root, "bomb.tgz"), gzipSync(tar(tarEntry("a.bin", { content: Buffer.alloc(2_000_000) }))));
  await assert.rejects(extractArchive(join(root, "bomb.tgz")), /disk is almost full/);
  assert.deepEqual((await readdir(root)).sort(), ["bomb.tgz", "bomb.zip", "lying.zip"], "what it wrote is gone");
});
test("Extract takes any number of items, and Compress writes the 64-bit records a large archive needs", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Many"));
  for (let index = 0; index < 300; index += 1) await writeFile(join(root, "Many", `f${index}.txt`), `file ${index}`);
  await writeFile(join(root, "Many", "big.bin"), randomBytes(300_000));
  setZip64ForTests(true);
  t.after(() => setZip64ForTests(false));
  const archive = await compressInto([join(root, "Many")], root);
  setZip64ForTests(false);
  if (existsSync("/usr/bin/unzip")) {
    const checked = await exec("/usr/bin/unzip", ["-t", archive]);
    assert.match(checked.stdout, /No errors detected/);
  }
  await rm(join(root, "Many"), { recursive: true });
  const back = await extractArchive(archive);
  assert.equal((await readdir(back.path)).length, 301);
  assert.equal(await readFile(join(back.path, "f299.txt"), "utf8"), "file 299");
  assert.equal(back.files, 301);
});
test("damaged, protected, and unknown archives are refused plainly", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "notes.zip"), "this is not a zip");
  await assert.rejects(extractArchive(join(root, "notes.zip")), /isn’t a zip archive/);
  const good = await zipWith({ "a.txt": { content: "hello hello hello" } });
  await writeFile(join(root, "cut.zip"), good.subarray(0, 40));
  await assert.rejects(extractArchive(join(root, "cut.zip")));
  const protectedZip = Buffer.from(good);
  const central = protectedZip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  protectedZip.writeUInt16LE(protectedZip.readUInt16LE(central + 8) | 1, central + 8);
  await writeFile(join(root, "locked.zip"), protectedZip);
  await assert.rejects(extractArchive(join(root, "locked.zip")), /protected with a password/);
  const corrupt = Buffer.from(good);
  corrupt.writeUInt32LE((corrupt.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16);
  await writeFile(join(root, "corrupt.zip"), corrupt);
  await assert.rejects(extractArchive(join(root, "corrupt.zip")), /damaged/);
  await writeFile(join(root, "notes.rar"), "rar");
  await assert.rejects(extractArchive(join(root, "notes.rar")), /can extract \.zip, \.tar, \.tar\.gz, and \.tgz/);
  await writeFile(join(root, "bad.tar"), Buffer.alloc(512, 0x41));
  await assert.rejects(extractArchive(join(root, "bad.tar")), /damaged/);
  assert.deepEqual((await readdir(root)).sort(), ["bad.tar", "corrupt.zip", "cut.zip", "locked.zip", "notes.rar", "notes.zip"]);
});

test("an Extract cancelled partway leaves no folder and no working folder, and reports progress", async (t) => {
  const root = await folder(t);
  const files: Record<string, { content: Buffer }> = {};
  for (let index = 0; index < 5; index += 1) files[`part${index}.bin`] = { content: Buffer.alloc(400_000, index) };
  await writeFile(join(root, "parts.zip"), await zipWith(files));
  const seen: number[] = [];
  setFileOperationBoundaryHookForTests(({ operationId, point, progress }) => {
    seen.push(progress.itemsDone);
    if (point === "entry" && progress.itemsDone === 2) cancelFileOperation(operationId);
  });
  t.after(() => setFileOperationBoundaryHookForTests(null));
  await assert.rejects(runFileOperation("extract", "extract", (operation) => extractArchive(join(root, "parts.zip"), operation)), /Stopped/);
  assert.deepEqual(await readdir(root), ["parts.zip"]);
  assert.ok(seen.includes(2));

  setFileOperationBoundaryHookForTests(({ operationId, point, progress }) => {
    if (point === "chunk" && progress.itemsDone === 1) cancelFileOperation(operationId);
  });
  await assert.rejects(runFileOperation("extract-mid", "extract", (operation) => extractArchive(join(root, "parts.zip"), operation)), /Stopped/);
  assert.deepEqual(await readdir(root), ["parts.zip"], "a cancel inside an entry leaves nothing either");
});

test("Extract clears working folders an interrupted Extract left", async (t) => {
  const root = await folder(t);
  const stale = join(root, ".AmpleFile-extract-0123456789abcdef.partial");
  await mkdir(join(stale, "half"), { recursive: true });
  const old = new Date(Date.now() - abandonedCompressAfterMs - 60_000);
  await utimes(stale, old, old);
  await writeFile(join(root, "a.zip"), await zipWith({ "a.txt": { content: "a" } }));
  await extractArchive(join(root, "a.zip"));
  assert.deepEqual((await readdir(root)).sort(), ["a.txt", "a.zip"]);
});
