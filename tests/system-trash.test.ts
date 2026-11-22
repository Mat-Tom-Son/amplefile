import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findTrashItem,
  listSystemTrash,
  parseTrashDeletionDate,
  parseTrashInfo,
  percentDecodePath,
  performPutBack,
  planPutBack,
  trashLimits,
  type TrashItem,
  type TrashOptions,
} from "../src/local/system-trash.js";

/**
 * The system Trash (src/local/system-trash.ts): FreeDesktop trash records
 * read as untrusted data, listing, Put Back without replacing anything, and
 * the macOS branch, which lists only.
 */

const uid = typeof process.getuid === "function" ? process.getuid() : 1000;

interface Sandbox { root: string; home: string; dataHome: string; trash: string; volume: string; options: TrashOptions }

async function sandbox(t: test.TestContext): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "amplefile-system-trash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home", "ana");
  const dataHome = join(home, ".local", "share");
  const trash = join(dataHome, "Trash");
  const volume = join(root, "media", "USB");
  await mkdir(join(trash, "files"), { recursive: true });
  await mkdir(join(trash, "info"), { recursive: true });
  await mkdir(volume, { recursive: true });
  return { root, home, dataHome, trash, volume, options: { platform: "linux", home, xdgDataHome: dataHome, uid, volumeTops: [volume] } };
}

function encode(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

async function trashFile(trash: string, trashName: string, originalPath: string, content: string | null = "content", date = "2026-11-20T09:15:30"): Promise<void> {
  if (content !== null) await writeFile(join(trash, "files", trashName), content);
  await writeFile(join(trash, "info", `${trashName}.trashinfo`), `[Trash Info]\nPath=${encode(originalPath)}\nDeletionDate=${date}\n`);
}

async function itemNamed(options: TrashOptions, name: string): Promise<TrashItem> {
  const listing = await listSystemTrash(options);
  const item = listing.items.find((candidate) => candidate.name === name);
  assert.ok(item, `${name} is listed: ${JSON.stringify(listing.items.map((candidate) => candidate.name))}`);
  return item;
}

async function putBack(options: TrashOptions, id: string, connectedFolders: Array<{ id: string; connectedFolderRoot: string; name: string }> = []) {
  const found = await findTrashItem(id, options);
  assert.ok(found, "the item is found by its id");
  return performPutBack(found, await planPutBack(found, connectedFolders, { home: options.home }));
}

test("trash records are decoded strictly and refused when they name . or .., a stray %, or bytes that are not text", () => {
  assert.equal(percentDecodePath("/home/ana/My%20Notes/caf%C3%A9.txt"), "/home/ana/My Notes/café.txt");
  assert.equal(percentDecodePath("/bad%zz"), null);
  assert.equal(percentDecodePath("/trailing%"), null);
  assert.equal(percentDecodePath("/nul%00name"), null);
  assert.equal(percentDecodePath("/not%FFtext"), null);

  const good = parseTrashInfo("# made by Files\n\n[Trash Info]\r\nPath=/home/ana/Report%20Q3.pdf\r\nDeletionDate=2026-11-20T09:15:30\r\n[Other]\nPath=/elsewhere\n", "/home/ana/.local/share");
  assert.equal(good.originalPath, "/home/ana/Report Q3.pdf");
  assert.equal(good.deletedAt, new Date(2026, 10, 20, 9, 15, 30).toISOString());
  assert.equal(good.problem, undefined);

  // A volume's record is relative to its top.
  assert.equal(parseTrashInfo("[Trash Info]\nPath=Photos/a.jpg\n", "/media/USB").originalPath, "/media/USB/Photos/a.jpg");
  assert.equal(parseTrashInfo("[Trash Info]\nPath=//home//ana/x\n", "/").originalPath, "/home/ana/x");

  for (const [text, why] of [
    ["Path=/home/ana/x\n", "no group header"],
    ["[Trash Info]\nPath=/home/ana/x\nPath=/etc/passwd\n", "Path twice"],
    ["[Trash Info]\nDeletionDate=2026-11-20T09:15:30\n", "no Path"],
    ["[Trash Info]\nPath=../../etc/passwd\n", "relative .."],
    ["[Trash Info]\nPath=/home/ana/../../etc/passwd\n", "absolute .."],
    ["[Trash Info]\nPath=/home/ana/./x\n", "a . segment"],
    ["[Trash Info]\nPath=/home/ana/%2E%2E/x\n", "an encoded .."],
    ["[Trash Info]\nPath=/home/ana/line%0Abreak\n", "a control character"],
    ["[Trash Info]\nPath=/\n", "the disk's top"],
    ["[Trash Info]\nPath=\n", "an empty path"],
    [`[Trash Info]\nPath=/${"a".repeat(trashLimits.maxPathLength + 1)}\n`, "an enormous path"],
  ] as const) {
    const parsed = parseTrashInfo(text, "/home/ana/.local/share");
    assert.equal(parsed.originalPath, null, why);
    assert.ok(parsed.problem, why);
  }
  assert.equal(parseTrashDeletionDate("20040831T22:32:08"), new Date(2004, 7, 31, 22, 32, 8).toISOString(), "the compact form older tools wrote");
  assert.equal(parseTrashDeletionDate("2026-13-01T00:00:00"), null);
  assert.equal(parseTrashDeletionDate("yesterday"), null);
});

test("the home Trash and a drive's Trash are listed with names, original paths, dates, kinds, and sizes", async (t) => {
  const box = await sandbox(t);
  await trashFile(box.trash, "Report Q3.pdf", join(box.home, "Documents", "Report Q3.pdf"), "x".repeat(1234));
  await mkdir(join(box.trash, "files", "Holiday"));
  await writeFile(join(box.trash, "files", "Holiday", "a.jpg"), "aaaa");
  await mkdir(join(box.trash, "files", "Holiday", "inner"));
  await writeFile(join(box.trash, "files", "Holiday", "inner", "b.jpg"), "bbbbbb");
  await symlink("/etc", join(box.trash, "files", "Holiday", "outside"));
  await trashFile(box.trash, "Holiday", join(box.home, "Pictures", "Holiday"), null, "2026-11-21T10:00:00");
  await symlink("/etc/passwd", join(box.trash, "files", "shortcut"));
  await trashFile(box.trash, "shortcut", join(box.home, "shortcut"), null);
  // A record without its item is a leftover; an item without a record is not listed.
  await trashFile(box.trash, "gone.txt", join(box.home, "gone.txt"), null);
  await writeFile(join(box.trash, "files", "no-record.txt"), "x");

  const volumeTrash = join(box.volume, `.Trash-${uid}`);
  await mkdir(join(volumeTrash, "files"), { recursive: true });
  await mkdir(join(volumeTrash, "info"), { recursive: true });
  await writeFile(join(volumeTrash, "files", "clip.mov"), "movie");
  await writeFile(join(volumeTrash, "info", "clip.mov.trashinfo"), "[Trash Info]\nPath=Videos/clip.mov\nDeletionDate=2026-11-19T08:00:00\n");

  const listing = await listSystemTrash(box.options);
  assert.equal(listing.putBackAvailable, true);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.items.map((item) => item.name), ["Holiday", "Report Q3.pdf", "shortcut", "clip.mov"]);
  const [holiday, report, shortcut, clip] = listing.items as [TrashItem, TrashItem, TrashItem, TrashItem];
  assert.equal(report.originalPath, join(box.home, "Documents", "Report Q3.pdf"));
  assert.equal(report.kind, "file");
  assert.equal(report.sizeBytes, 1234);
  assert.equal(report.trash, "home");
  assert.equal(report.canPutBack, true);
  assert.match(report.id, /^trash-[A-Za-z0-9_-]{27}$/);
  assert.ok(!report.id.includes("Report"), "the id does not reveal the path");
  assert.equal(holiday.kind, "folder");
  assert.equal(holiday.sizeBytes, 10, "a folder's files, without following the link inside it");
  assert.equal(shortcut.kind, "link");
  assert.equal(clip.trash, "volume");
  assert.equal(clip.volumePath, box.volume);
  assert.equal(clip.originalPath, join(box.volume, "Videos", "clip.mov"));
  assert.equal(clip.deletedAt, new Date(2026, 10, 19, 8, 0, 0).toISOString());
});

test("a damaged, linked, or enormous record lists the item without Put Back; untrustworthy trash folders are ignored", async (t) => {
  const box = await sandbox(t);
  await writeFile(join(box.trash, "files", "damaged.txt"), "x");
  await writeFile(join(box.trash, "info", "damaged.txt.trashinfo"), "Path=/home/ana/damaged.txt\n");
  await writeFile(join(box.trash, "files", "linked.txt"), "x");
  await writeFile(join(box.root, "elsewhere.trashinfo"), `[Trash Info]\nPath=${join(box.home, "linked.txt")}\n`);
  await symlink(join(box.root, "elsewhere.trashinfo"), join(box.trash, "info", "big.txt.trashinfo"));
  await writeFile(join(box.trash, "files", "big.txt"), "x");
  await writeFile(join(box.trash, "files", "huge.txt"), "x");
  await writeFile(join(box.trash, "info", "huge.txt.trashinfo"), `[Trash Info]\nPath=${join(box.home, "huge.txt")}\n#${"x".repeat(trashLimits.maxInfoBytes)}\n`);
  const listing = await listSystemTrash(box.options);
  const damaged = listing.items.find((item) => item.name === "damaged.txt");
  assert.ok(damaged);
  assert.equal(damaged.originalPath, null);
  assert.equal(damaged.canPutBack, false);
  assert.match(damaged.putBackNote!, /damaged/);
  assert.ok(!listing.items.some((item) => item.name === "big.txt"), "a record that is a link is not read at all");
  const huge = listing.items.find((item) => item.name === "huge.txt");
  assert.equal(huge?.canPutBack, false);

  // A drive's item may only go back onto that drive.
  const volumeTrash = join(box.volume, `.Trash-${uid}`);
  await mkdir(join(volumeTrash, "files"), { recursive: true });
  await mkdir(join(volumeTrash, "info"), { recursive: true });
  await writeFile(join(volumeTrash, "files", "evil.desktop"), "[Desktop Entry]");
  await writeFile(join(volumeTrash, "info", "evil.desktop.trashinfo"), `[Trash Info]\nPath=${join(box.home, ".config", "autostart", "evil.desktop")}\n`);
  const evil = (await listSystemTrash(box.options)).items.find((item) => item.name === "evil.desktop");
  assert.equal(evil?.canPutBack, false);
  assert.match(evil!.putBackNote!, /outside the drive/);
  await assert.rejects(putBack(box.options, evil!.id), (error: { statusCode?: number }) => error.statusCode === 409);
  assert.ok(!existsSync(join(box.home, ".config", "autostart", "evil.desktop")));

  // A shared .Trash without the sticky bit, and a trash folder that is a link, are not trusted.
  await rm(volumeTrash, { recursive: true });
  await mkdir(join(box.volume, ".Trash", String(uid), "files"), { recursive: true });
  await mkdir(join(box.volume, ".Trash", String(uid), "info"), { recursive: true });
  await chmod(join(box.volume, ".Trash"), 0o777);
  await writeFile(join(box.volume, ".Trash", String(uid), "files", "planted.txt"), "x");
  await writeFile(join(box.volume, ".Trash", String(uid), "info", "planted.txt.trashinfo"), "[Trash Info]\nPath=planted.txt\n");
  const otherVolume = join(box.root, "media", "Other");
  await mkdir(otherVolume, { recursive: true });
  await symlink(join(box.volume, ".Trash", String(uid)), join(otherVolume, `.Trash-${uid}`));
  const names = (await listSystemTrash({ ...box.options, volumeTops: [box.volume, otherVolume] })).items.map((item) => item.name);
  assert.ok(!names.includes("planted.txt"), JSON.stringify(names));
  await chmod(join(box.volume, ".Trash"), 0o1777);
  assert.ok((await listSystemTrash(box.options)).items.some((item) => item.name === "planted.txt"), "with the sticky bit, the shared .Trash is used");
});

test("Put Back returns an item to where it was and removes its record", async (t) => {
  const box = await sandbox(t);
  const documents = join(box.home, "Documents");
  await mkdir(documents, { recursive: true });
  await trashFile(box.trash, "notes.txt", join(documents, "notes.txt"), "my notes");
  const item = await itemNamed(box.options, "notes.txt");
  const result = await putBack(box.options, item.id);
  assert.deepEqual(result, { path: join(documents, "notes.txt"), name: "notes.txt", renamed: false, recreatedFolders: [] });
  assert.equal(await readFile(join(documents, "notes.txt"), "utf8"), "my notes");
  assert.ok(!existsSync(join(box.trash, "files", "notes.txt")));
  assert.ok(!existsSync(join(box.trash, "info", "notes.txt.trashinfo")));
  assert.equal(await findTrashItem(item.id, box.options), null, "an item put back is no longer found");
  assert.equal(await findTrashItem("trash-../../etc/passwd", box.options), null, "only a minted id is accepted");
});

test("Put Back never replaces anything: a taken name gets Finder's copy names, for files, links, and folders", async (t) => {
  const box = await sandbox(t);
  const documents = join(box.home, "Documents");
  await mkdir(join(documents, "Project"), { recursive: true });
  await writeFile(join(documents, "report.pdf"), "the new report");
  await writeFile(join(documents, "Project", "keep.txt"), "keep");
  await trashFile(box.trash, "report.pdf", join(documents, "report.pdf"), "the old report");
  await trashFile(box.trash, "report.2.pdf", join(documents, "report.pdf"), "the oldest report", "2026-11-19T09:00:00");
  await mkdir(join(box.trash, "files", "Project"));
  await writeFile(join(box.trash, "files", "Project", "old.txt"), "old");
  await trashFile(box.trash, "Project", join(documents, "Project"), null);
  await symlink("/etc/hosts", join(box.trash, "files", "hosts-link"));
  await writeFile(join(documents, "hosts-link"), "a file took the name");
  await trashFile(box.trash, "hosts-link", join(documents, "hosts-link"), null);

  const listing = await listSystemTrash(box.options);
  const reports = listing.items.filter((item) => item.name === "report.pdf");
  assert.equal(reports.length, 2);
  const first = await putBack(box.options, reports[0]!.id);
  const second = await putBack(box.options, reports[1]!.id);
  assert.equal(first.name, "report copy.pdf");
  assert.equal(first.renamed, true);
  assert.equal(second.name, "report copy 2.pdf");
  assert.equal(await readFile(join(documents, "report.pdf"), "utf8"), "the new report");
  assert.equal(await readFile(join(documents, "report copy.pdf"), "utf8"), "the old report");
  assert.equal(await readFile(join(documents, "report copy 2.pdf"), "utf8"), "the oldest report");

  const project = await putBack(box.options, listing.items.find((item) => item.name === "Project")!.id);
  assert.equal(project.name, "Project copy");
  assert.equal(await readFile(join(documents, "Project", "keep.txt"), "utf8"), "keep");
  assert.equal(await readFile(join(documents, "Project copy", "old.txt"), "utf8"), "old");

  const link = await putBack(box.options, listing.items.find((item) => item.name === "hosts-link")!.id);
  assert.equal(link.name, "hosts-link copy");
  assert.ok((await lstat(link.path)).isSymbolicLink(), "a link goes back as a link, never followed");
  assert.equal(await readlink(link.path), "/etc/hosts");
});

test("Put Back recreates a missing folder only where that is clearly safe", async (t) => {
  const box = await sandbox(t);
  await trashFile(box.trash, "plan.md", join(box.home, "Projects", "Garden", "plan.md"), "plan");
  const recreated = await putBack(box.options, (await itemNamed(box.options, "plan.md")).id);
  assert.equal(recreated.path, join(box.home, "Projects", "Garden", "plan.md"));
  assert.deepEqual(recreated.recreatedFolders, [join(box.home, "Projects"), join(box.home, "Projects", "Garden")]);

  // Outside the home folder (and outside any Connected Folder), a missing folder is not invented.
  const outside = join(box.root, "srv", "shared", "data.csv");
  await trashFile(box.trash, "data.csv", outside, "1,2");
  const item = await itemNamed(box.options, "data.csv");
  await assert.rejects(putBack(box.options, item.id), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 409 && /is gone/.test(error.message));
  assert.ok(existsSync(join(box.trash, "files", "data.csv")), "it stays in the Trash");
  assert.ok(!existsSync(join(box.root, "srv")));

  // Inside a registered Connected Folder it is, since History records the new folders with the item.
  const connectedFolderRoot = join(box.root, "srv");
  await mkdir(connectedFolderRoot);
  const found = await findTrashItem(item.id, box.options);
  const plan = await planPutBack(found!, [{ id: "space-0000000000000000", connectedFolderRoot, name: "Shared" }], { home: box.home });
  assert.equal(plan.connectedFolder?.id, "space-0000000000000000");
  assert.deepEqual(plan.missingFolders, [join(connectedFolderRoot, "shared")]);

  // Never into hidden AmpleFile or Pi data.
  await trashFile(box.trash, "settings.json", join(box.home, "Work", ".pi", "settings.json"), "{}");
  await assert.rejects(putBack(box.options, (await itemNamed(box.options, "settings.json")).id), (error: { statusCode?: number }) => error.statusCode === 409);
});

test("Put Back refuses a damaged record and a folder now reached through a link", async (t) => {
  const box = await sandbox(t);
  await writeFile(join(box.trash, "files", "damaged.txt"), "x");
  await writeFile(join(box.trash, "info", "damaged.txt.trashinfo"), "[Trash Info]\nPath=/home/ana/%zz\n");
  const damaged = await itemNamed(box.options, "damaged.txt");
  await assert.rejects(putBack(box.options, damaged.id), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 409 && /can’t put “damaged.txt” back/.test(error.message));

  const real = join(box.root, "real-documents");
  await mkdir(real);
  await symlink(real, join(box.home, "Documents"));
  await trashFile(box.trash, "letter.txt", join(box.home, "Documents", "letter.txt"), "dear");
  await assert.rejects(putBack(box.options, (await itemNamed(box.options, "letter.txt")).id), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 409 && /reached through a link/.test(error.message));
  assert.ok(!existsSync(join(real, "letter.txt")), "the link was not followed");
  assert.ok(existsSync(join(box.trash, "files", "letter.txt")));
});

test("macOS lists the Trash without Put Back, and says plainly when it isn't allowed to look", async (t) => {
  const box = await sandbox(t);
  const macTrash = join(box.home, ".Trash");
  await mkdir(join(macTrash, "Old Folder"), { recursive: true });
  await writeFile(join(macTrash, "Old Folder", "a.txt"), "abc");
  await writeFile(join(macTrash, "photo.heic"), "12345");
  await writeFile(join(macTrash, ".DS_Store"), "finder");
  const options: TrashOptions = { platform: "darwin", home: box.home, uid, macVolumeTops: [] };
  const listing = await listSystemTrash(options);
  assert.equal(listing.putBackAvailable, false);
  assert.deepEqual(listing.items.map((item) => [item.name, item.kind, item.sizeBytes, item.originalPath, item.canPutBack]), [
    ["Old Folder", "folder", 3, null, false],
    ["photo.heic", "file", 5, null, false],
  ]);
  assert.match(listing.items[0]!.putBackNote!, /Finder/);
  assert.equal(await findTrashItem(listing.items[0]!.id, options), null, "Put Back finds nothing to act on");

  if (uid !== 0) {
    await chmod(macTrash, 0o000);
    try {
      await assert.rejects(listSystemTrash(options), (error: { statusCode?: number; message: string }) =>
        error.statusCode === 403 && /Full Disk Access/.test(error.message));
    } finally {
      await chmod(macTrash, 0o700);
    }
  }
});
