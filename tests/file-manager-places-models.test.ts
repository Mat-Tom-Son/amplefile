import assert from "node:assert/strict";
import test from "node:test";

import {
  currentDriveKey,
  driveLocation,
  driveRows,
  ejectMessage,
  formatCapacity,
  locationIsOnDrive,
  parseVolumesEvent,
  statusWithSpace,
  volumeSpacePath,
  type VolumeSummary,
} from "../web-local/src/components/file-manager/file-manager-drives.js";
import {
  confirmPermanent,
  deleteImmediatelyConfirm,
  emptyTrashConfirm,
  filterTrashItems,
  nextTrashSort,
  permanentResultMessage,
  putBackBlocker,
  putBackMessage,
  sortTrashItems,
  trashLocationText,
  type TrashItem,
} from "../web-local/src/components/file-manager/file-manager-trash.js";
import { canThumbnail, thumbnailPath, thumbnailSize, thumbnailVersion, ThumbnailCache, ThumbnailQueue, type ThumbnailOutcome } from "../web-local/src/components/file-manager/file-manager-thumbnails.js";
import { canMeasureFolder, folderSizeColumnText, folderSizeText, type FolderSize } from "../web-local/src/components/file-manager/file-manager-folder-size.js";
import { mergeFolderSearchPage, stoppedEarlyText } from "../web-local/src/components/file-manager/usePlainFolderSearch.js";
import type { TreeEntry } from "../web-local/src/types.js";
import { showsFileManager } from "../web-local/src/components/file-manager/file-manager-welcome-model.js";

// Drives and the system Trash in the file manager window (docs/product-model.md, "The file manager window").

const usb: VolumeSummary = { id: "volume-1", name: "USB Stick", mountPath: "/run/media/ana/USB Stick", totalBytes: 64 * 1024 ** 3, freeBytes: 12.5 * 1024 ** 3, ejectable: true, fileSystem: "vfat" };
const data: VolumeSummary = { id: "volume-2", name: "data", mountPath: "/mnt/data", totalBytes: null, freeBytes: null, ejectable: false, fileSystem: "ext4" };
const computer = { kind: "standard" as const, id: "computer" };

test("the Drives section starts with the computer's own disk, then each drive by name, opened in the computer place", () => {
  const rows = driveRows([usb, data], "File System");
  assert.deepEqual(rows.map((row) => row.name), ["File System", "data", "USB Stick"]);
  assert.deepEqual(rows[0]!.location, { place: computer, path: "" }, "the disk's row is the top of the file system");
  assert.equal(rows[0]!.ejectable, false);
  assert.deepEqual(rows[2]!.location, { place: computer, path: "run/media/ana/USB Stick" });
  assert.equal(rows[2]!.ejectable, true);
  assert.equal(rows[2]!.detail, "12.5 GB free of 64 GB");
  assert.equal(rows[1]!.detail, null, "a drive the host could not measure says nothing about space");
  assert.deepEqual(driveLocation("/mnt/data/"), { place: computer, path: "mnt/data" });
});

test("the row holding the folder shown is current: the deepest drive, else the disk only at its top", () => {
  const rows = driveRows([usb, data], "File System");
  assert.equal(currentDriveKey(rows, { place: computer, path: "" }), "computer");
  assert.equal(currentDriveKey(rows, { place: computer, path: "run/media/ana/USB Stick/Photos" }), "volume-1");
  assert.equal(currentDriveKey(rows, { place: computer, path: "mnt/data" }), "volume-2");
  assert.equal(currentDriveKey(rows, { place: computer, path: "mnt/database" }), null, "a sibling with a longer name is not inside");
  assert.equal(currentDriveKey(rows, { place: computer, path: "etc" }), null);
  assert.equal(currentDriveKey(rows, { place: { kind: "standard", id: "home" }, path: "" }), null);
  assert.equal(locationIsOnDrive({ place: computer, path: "run/media/ana/USB Stick/a" }, usb), true);
  assert.equal(locationIsOnDrive({ place: { kind: "connected-folder", id: "x" }, path: "" }, usb), false);
});

test("free space joins the status line as Finder's does, and the drive list is read only from a well-formed event", () => {
  assert.equal(statusWithSpace("12 items", { totalBytes: null, freeBytes: 40.2 * 1024 ** 3 }), "12 items, 40.2 GB available");
  assert.equal(statusWithSpace("12 items", { totalBytes: 1, freeBytes: null }), "12 items");
  assert.equal(statusWithSpace("12 items", null), "12 items");
  assert.equal(formatCapacity(512), "512 B");
  assert.equal(formatCapacity(3 * 1024 ** 4), "3 TB");
  assert.equal(volumeSpacePath({ kind: "standard", id: "home" }, "Notes"), "/api/volume-space?placeKind=standard&placeId=home&path=Notes");
  assert.deepEqual(parseVolumesEvent(JSON.stringify({ type: "volumes", volumes: [usb, { id: 4 }] })), [usb]);
  assert.equal(parseVolumesEvent("{"), null);
  assert.equal(parseVolumesEvent(JSON.stringify({ type: "other" })), null);
});

test("Eject reports success, or the host's own plain reason", () => {
  assert.deepEqual(ejectMessage("USB Stick", { ok: true }), { text: "“USB Stick” was ejected. You can disconnect it now.", tone: "success" });
  assert.deepEqual(ejectMessage("USB Stick", { ok: false, error: "“USB Stick” is in use. Close the files and apps using it, then try again." }), { text: "“USB Stick” is in use. Close the files and apps using it, then try again.", tone: "error" });
});

const item = (overrides: Partial<TrashItem>): TrashItem => ({ id: "trash-a", name: "a.txt", originalPath: "/home/ana/Documents/a.txt", deletedAt: "2026-11-20T10:00:00Z", kind: "file", sizeBytes: 10, trash: "home", volumePath: null, canPutBack: true, ...overrides });

test("the Trash view sorts, filters, and says where each item was", () => {
  const items = [
    item({ id: "1", name: "b.txt", deletedAt: "2026-11-20T10:00:00Z", sizeBytes: 5 }),
    item({ id: "2", name: "a.txt", deletedAt: "2026-11-21T10:00:00Z", sizeBytes: null }),
    item({ id: "3", name: "c.txt", deletedAt: null, sizeBytes: 50 }),
  ];
  assert.deepEqual(sortTrashItems(items, { key: "deleted", ascending: false }).map((entry) => entry.id), ["2", "1", "3"], "newest first, unknown dates last");
  assert.deepEqual(sortTrashItems(items, { key: "size", ascending: true }).map((entry) => entry.id), ["1", "3", "2"], "unknown sizes last either way");
  assert.deepEqual(sortTrashItems(items, { key: "name", ascending: true }).map((entry) => entry.id), ["2", "1", "3"]);
  assert.deepEqual(nextTrashSort({ key: "deleted", ascending: false }, "deleted"), { key: "deleted", ascending: true });
  assert.deepEqual(nextTrashSort({ key: "deleted", ascending: false }, "name"), { key: "name", ascending: true });
  assert.deepEqual(filterTrashItems(items, " A.T ").map((entry) => entry.id), ["2"]);
  assert.equal(trashLocationText(item({})), "/home/ana/Documents");
  assert.equal(trashLocationText(item({ originalPath: "/top.txt" })), "/");
  assert.equal(trashLocationText(item({ originalPath: null, trash: "volume", volumePath: "/run/media/ana/USB" })), "/run/media/ana/USB");
  assert.equal(trashLocationText(item({ originalPath: null })), "Unknown");
});

test("the permanent actions name what will be lost and say it cannot be undone", () => {
  const one = deleteImmediatelyConfirm([item({ name: "Tax 2025.pdf" })]);
  assert.equal(one.title, "Delete “Tax 2025.pdf” Immediately?");
  assert.match(one.body, /“Tax 2025\.pdf” will be deleted from the Trash for good\. You can’t undo this\./);
  assert.equal(one.tone, "danger");
  const many = deleteImmediatelyConfirm([item({ name: "a" }), item({ name: "b" }), item({ name: "c" }), item({ name: "d" })]);
  assert.equal(many.title, "Delete 4 items Immediately?");
  assert.match(many.body, /“a”, “b”, “c”, and more/);
  const empty = emptyTrashConfirm({ items: [item({ sizeBytes: 2048 }), item({ sizeBytes: null })], truncated: false });
  assert.equal(empty.confirmLabel, "Empty Trash");
  assert.match(empty.body, /2 items, 2\.0 KB/);
  assert.match(empty.body, /You can’t undo this\./);
  assert.match(emptyTrashConfirm({ items: [item({})], truncated: true }).body, /more than 1 items/);
});

test("nothing permanent is sent unless the person says yes", async () => {
  const asked: string[] = [];
  let ran = 0;
  const run = async () => { ran += 1; return "done"; };
  const no = await confirmPermanent(deleteImmediatelyConfirm([item({})]), async (question) => { asked.push(question.title); return false; }, run);
  assert.equal(no, null);
  assert.equal(ran, 0, "a no (or a dialog closed) sends nothing");
  const yes = await confirmPermanent(emptyTrashConfirm({ items: [item({})], truncated: false }), async (question) => { asked.push(question.title); return true; }, run);
  assert.equal(yes, "done");
  assert.equal(ran, 1);
  assert.deepEqual(asked, ["Delete “a.txt” Immediately?", "Empty the Trash?"], "the question always comes first");
});

test("results say what went and plainly what did not; Put Back says why not, as the host does on macOS", () => {
  assert.deepEqual(permanentResultMessage({ removed: [{ id: "1", name: "a", originalPath: null }], failed: [], notFound: [] }, false), { text: "Deleted “a”", tone: "success" });
  assert.deepEqual(permanentResultMessage({ removed: [], failed: [], notFound: [], strayRecordsRemoved: 0 }, true), { text: "The Trash is empty.", tone: "success" });
  const failed = permanentResultMessage({ removed: [], failed: [{ id: "1", name: "locked", error: "Permission denied." }, { id: "2", name: "x", error: "y" }], notFound: [] }, true);
  assert.equal(failed.tone, "error");
  assert.equal(failed.text, "“locked” couldn’t be deleted: Permission denied. 1 other item couldn’t be deleted either.");
  assert.equal(putBackMessage({ path: "/a/report copy.pdf", name: "report copy.pdf", renamed: true, recreatedFolders: [], location: null, restorePoint: null }, "report.pdf"), "Put back “report.pdf” as “report copy.pdf”");
  assert.equal(putBackBlocker({ putBackAvailable: true }, [item({})]), null);
  assert.equal(putBackBlocker({ putBackAvailable: true }, [item({ canPutBack: false, putBackNote: "Its record is damaged." })]), "Its record is damaged.");
  const mac = "Put this back from the Trash in Finder. AmpleFile can’t read where macOS recorded it came from.";
  assert.equal(putBackBlocker({ putBackAvailable: false }, [item({ canPutBack: false, putBackNote: mac })]), mac);
  assert.equal(putBackBlocker({ putBackAvailable: true }, []), null);
});

test("the welcome is for a fresh profile and never holds back a folder handed to AmpleFile", () => {
  assert.equal(showsFileManager({ connectedFolders: 0, welcomeDone: false, locationHanded: false }), false);
  assert.equal(showsFileManager({ connectedFolders: 0, welcomeDone: true, locationHanded: false }), true, "Browse Files leaves it");
  assert.equal(showsFileManager({ connectedFolders: 0, welcomeDone: false, locationHanded: true }), true, "a folder handed over is shown");
  assert.equal(showsFileManager({ connectedFolders: 2, welcomeDone: false, locationHanded: false }), true);
});

const home = { kind: "standard" as const, id: "home" };
const at = "2026-09-27T12:00:00.000Z";
const file = (path: string, sizeBytes = 10): TreeEntry => ({ kind: "file", path, name: path.slice(path.lastIndexOf("/") + 1), updatedAt: at, sizeBytes } as TreeEntry);
const size = (overrides: Partial<FolderSize> = {}): FolderSize => ({ path: "Notes", bytes: 3 * 1024 ** 3, bytesOnDisk: null, items: 1234, files: 1200, folders: 34, links: 0, unreadable: 0, otherVolumes: 0, complete: true, stoppedBy: null, elapsedMs: 10, measuredAt: at, cached: false, ...overrides });

test("thumbnails are asked only for the kinds the host draws, at a size for the screen, with the file's version", () => {
  assert.equal(canThumbnail({ kind: "file", name: "a.JPG" }), true);
  assert.equal(canThumbnail({ kind: "file", name: "scan.pdf" }), true);
  assert.equal(canThumbnail({ kind: "file", name: "logo.svg" }), false, "SVG is never drawn by the host");
  assert.equal(canThumbnail({ kind: "file", name: "a.heic" }), false);
  assert.equal(canThumbnail({ kind: "folder", name: "x.png" }), false);
  assert.equal(canThumbnail({ kind: "file", name: "a.png", link: { target: "file", targetPath: "/x" } as never }), false, "a link is never read through");
  assert.equal(thumbnailSize("tile", 1), 128);
  assert.equal(thumbnailSize("tile", 2), 256);
  assert.equal(thumbnailSize("info", 1), 256);
  assert.equal(thumbnailVersion({ sizeBytes: 466, updatedAt: at }), `466-${Date.parse(at)}`);
  assert.equal(thumbnailVersion({ updatedAt: at }), null);
  assert.equal(thumbnailPath(home, file("Pictures/a b.png", 466), 128), `/api/standard-folders/home/thumbnail?path=Pictures%2Fa+b.png&size=128&v=466-${Date.parse(at)}`);
});

test("the thumbnail queue keeps a few out at once, newest first, and a request withdrawn while waiting is never sent", async () => {
  const sent: string[] = [];
  const finish = new Map<string, (outcome: ThumbnailOutcome) => void>();
  const aborted: string[] = [];
  const queue = new ThumbnailQueue((path, signal) => {
    sent.push(path);
    signal.addEventListener("abort", () => aborted.push(path));
    return new Promise((resolve) => finish.set(path, resolve));
  }, 2);
  const requests = ["a", "b", "c", "d", "e"].map((path) => ({ path, ...queue.request(path) }));
  assert.deepEqual(sent, ["a", "b"], "only two out at once");
  assert.equal(queue.pending, 3);
  // Scrolled away before it was sent: it leaves the queue.
  requests[3]!.cancel();
  assert.equal(await requests[3]!.promise.then((outcome) => outcome.kind), "retry");
  // One out is aborted when withdrawn.
  requests[1]!.cancel();
  assert.deepEqual(aborted, ["b"]);
  finish.get("a")!({ kind: "refused" });
  finish.get("b")!({ kind: "refused" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent, ["a", "b", "e", "c"], "the newest waiting request goes first, and the withdrawn one never goes");
  assert.equal(await requests[0]!.promise.then((outcome) => outcome.kind), "refused");
});

test("the thumbnail cache never revokes a picture a tile still shows", () => {
  const revoked: string[] = [];
  const cache = new ThumbnailCache(2, (url) => revoked.push(url));
  cache.store("a", "blob:a");
  const release = cache.use("a");
  cache.store("b", "blob:b");
  cache.store("c", "blob:c");
  assert.deepEqual(revoked, ["blob:b"], "the oldest unused one goes; the one in use stays");
  assert.equal(cache.peek("a"), "blob:a");
  release();
  cache.store("d", null);
  assert.ok(revoked.includes("blob:a"));
  assert.equal(cache.peek("d"), null, "a refusal is remembered as no picture");
});


test("a folder size reads plainly, and says when the host's bound stopped it", () => {
  assert.deepEqual(folderSizeText(size()), { size: "3 GB", items: "1,234 items", note: null });
  const partial = folderSizeText(size({ stoppedBy: "time-limit", complete: false }));
  assert.equal(partial.size, "At least 3 GB");
  assert.equal(partial.items, "More than 1,234 items");
  assert.match(partial.note!, /stopped after 10 seconds/);
  assert.match(folderSizeText(size({ unreadable: 2, complete: false })).note!, /Some items couldn’t be read/);
  assert.equal(folderSizeColumnText(size({ stoppedBy: "item-limit" })), "≥ 3 GB");
  assert.equal(canMeasureFolder({ kind: "standard", id: "computer" }, ""), false, "the disk itself is never walked");
  assert.equal(canMeasureFolder({ kind: "standard", id: "computer" }, "srv"), true);
});

test("plain-folder search pages merge names first and never list a file twice", () => {
  const first = mergeFolderSearchPage(home, { names: [], texts: [] }, {
    names: [{ path: "Notes/lemon.txt", name: "lemon.txt", kind: "file" }],
    files: [{ path: "Notes/lemon.txt", line: 1, preview: "lemon", sizeBytes: 5, updatedAt: at }, { path: "budget.txt", line: 3, preview: "Lemon budget: 40", sizeBytes: 9, updatedAt: at }],
  }, "lemon");
  const second = mergeFolderSearchPage(home, first, { names: [{ path: "Pictures/lemon.png", name: "lemon.png", kind: "file" }], files: [{ path: "budget.txt", line: 9, preview: "lemon", sizeBytes: 9, updatedAt: at }] }, "lemon");
  assert.deepEqual([...second.names, ...second.texts].map((result) => result.path), ["Notes/lemon.txt", "Pictures/lemon.png", "budget.txt"]);
  assert.deepEqual(second.texts[0]!.place, home);
  assert.deepEqual(second.texts[0]!.match, { kind: "content", pre: "", hit: "Lemon", post: " budget: 40" });
  assert.match(stoppedEarlyText("time", 20000), /20,000 files/);
});

