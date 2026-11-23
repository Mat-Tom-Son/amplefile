import assert from "node:assert/strict";
import test from "node:test";

import {
  bandHits,
  bandRect,
  bandSelection,
  canDropInto,
  dragPayload,
  drawnIndexes,
  folderListingMaxEntries,
  fullyDrawnItemLimit,
  gridColumns,
  isDraggableEntry,
  isHiddenName,
  isShowHiddenFilesKey,
  linkKindLabel,
  revealScrollTop,
  shownEntries,
  visibleRange,
  type GridGeometry,
  type ListGeometry,
} from "../web-local/src/components/file-manager/file-manager-layout.js";
import type { TreeEntry } from "../web-local/src/types.js";

const file = (path: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({ kind: "file", name: path.slice(path.lastIndexOf("/") + 1), path, ...extra } as TreeEntry);
const folder = (path: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({ kind: "folder", name: path.slice(path.lastIndexOf("/") + 1), path, ...extra } as TreeEntry);

test("a scrolled list draws the rows in view and a few past each edge", () => {
  // 100,000 rows of 26px, the first 4px down, scrolled to row 40,000.
  const range = visibleRange({ count: 100_000, itemSize: 26, offset: 4, scrollTop: 4 + 40_000 * 26, viewport: 520, overscan: 5 });
  assert.deepEqual(range, { start: 39_995, end: 40_025 });
  // The top and the bottom clamp to the folder.
  assert.deepEqual(visibleRange({ count: 100_000, itemSize: 26, offset: 4, scrollTop: 0, viewport: 520, overscan: 5 }), { start: 0, end: 25 });
  assert.deepEqual(visibleRange({ count: 30, itemSize: 26, offset: 4, scrollTop: 10_000, viewport: 520, overscan: 5 }), { start: 30, end: 30 });
  assert.deepEqual(visibleRange({ count: 0, itemSize: 26, offset: 4, scrollTop: 0, viewport: 520 }), { start: 0, end: 0 });
  assert.deepEqual(visibleRange({ count: 10, itemSize: 0, offset: 4, scrollTop: 0, viewport: 520 }), { start: 0, end: 0 });
});

test("a small folder draws every row; a large one its window plus the row with the keyboard", () => {
  assert.equal(drawnIndexes(fullyDrawnItemLimit, { start: 10, end: 20 }).length, fullyDrawnItemLimit);
  assert.deepEqual(drawnIndexes(100_000, { start: 10, end: 14 }, [90_000]), [10, 11, 12, 13, 90_000]);
  assert.deepEqual(drawnIndexes(100_000, { start: 10, end: 14 }, [12, -1, 100_000]), [10, 11, 12, 13], "a kept row in the window, none, or past the end adds nothing");
});

test("icon view fits as many 110px columns as the grid's own rule would", () => {
  assert.equal(gridColumns(0), 1);
  assert.equal(gridColumns(100), 1);
  // 32px of padding, then columns of 110px with 6px between.
  assert.equal(gridColumns(32 + 110), 1);
  assert.equal(gridColumns(32 + 110 * 2 + 6), 2);
  assert.equal(gridColumns(32 + 110 * 2 + 5), 1);
  assert.equal(gridColumns(900), 7);
});

test("scrolling an item into view moves only as far as needed, clear of the column headings", () => {
  const base = { itemSize: 26, offset: 32, viewport: 500, stickyTop: 28 };
  assert.equal(revealScrollTop({ ...base, index: 3, scrollTop: 0 }), null, "already in view");
  assert.equal(revealScrollTop({ ...base, index: 1_000, scrollTop: 0 }), 32 + 1_001 * 26 - 500, "below: its bottom lands at the view's bottom");
  assert.equal(revealScrollTop({ ...base, index: 10, scrollTop: 5_000 }), 32 + 10 * 26 - 28, "above: its top lands under the headings");
  assert.equal(revealScrollTop({ ...base, index: 0, scrollTop: 40 }), 4);
  assert.equal(revealScrollTop({ ...base, index: -1, scrollTop: 0 }), null);
  // Icon view: a row of tiles is shorter than its step.
  assert.equal(revealScrollTop({ index: 5, itemSize: 118, itemHeight: 106, offset: 17, scrollTop: 0, viewport: 400 }), 17 + 5 * 118 + 106 - 400);
});

test("a selection rectangle covers the rows it touches, drawn or not", () => {
  const list: ListGeometry = { kind: "list", count: 100_000, offset: 4, itemSize: 26, left: 8, right: 700 };
  assert.deepEqual(bandHits(bandRect({ x: 600, y: 4 + 26 * 2 + 3 }, { x: 650, y: 4 + 26 * 4 + 1 }), list), [2, 3, 4]);
  // Drawn bottom to top, the same rows.
  assert.deepEqual(bandHits(bandRect({ x: 650, y: 4 + 26 * 4 + 1 }, { x: 600, y: 4 + 26 * 2 + 3 }), list), [2, 3, 4]);
  // Rows far out of any drawn window still count.
  const far = bandHits(bandRect({ x: 20, y: 4 + 26 * 50_000 }, { x: 40, y: 4 + 26 * 60_000 - 1 }), list);
  assert.equal(far.length, 10_000);
  assert.equal(far[0], 50_000);
  assert.deepEqual(bandHits(bandRect({ x: 720, y: 0 }, { x: 800, y: 500 }), list), [], "beside the rows");
  assert.deepEqual(bandHits(bandRect({ x: 20, y: 0 }, { x: 40, y: 3 }), list), [], "above the first row");
  assert.deepEqual(bandHits(bandRect({ x: 20, y: 4 + 26 * 99_999 + 5 }, { x: 40, y: 10_000_000 }), list), [99_999], "past the last row");
});

test("in icon view the rectangle covers the tiles it touches, not the gaps between them", () => {
  // 4 columns of 100px with 6px gaps from x=16; rows every 118px from y=17, tiles 106px tall; 10 tiles.
  const grid: GridGeometry = { kind: "grid", count: 10, offset: 17, rowSize: 118, tileHeight: 106, columns: 4, columnWidth: 100, gap: 6, left: 16 };
  assert.deepEqual(bandHits(bandRect({ x: 20, y: 20 }, { x: 130, y: 140 }), grid), [0, 1, 4, 5]);
  assert.deepEqual(bandHits(bandRect({ x: 117, y: 20 }, { x: 121, y: 300 }), grid), [], "inside the gap between two columns");
  assert.deepEqual(bandHits(bandRect({ x: 20, y: 125 }, { x: 400, y: 134 }), grid), [], "inside the gap between two rows");
  assert.deepEqual(bandHits(bandRect({ x: 20, y: 250 }, { x: 440, y: 300 }), grid), [8, 9], "the last row has only two tiles");
});

test("a rectangle selects what it touches, or adds it with Shift or Command", () => {
  const order = ["a", "b", "c", "d", "e"];
  assert.deepEqual(bandSelection(order, [1, 2], ["e"], false), ["b", "c"]);
  assert.deepEqual(bandSelection(order, [1, 2], ["e", "b"], true), ["e", "b", "c"]);
  assert.deepEqual(bandSelection(order, [], ["e"], true), ["e"]);
  assert.deepEqual(bandSelection(order, [7], [], false), []);
});

test("a drag carries the selection when it starts on a selected item, else just that item; a link drags as itself, never a nested Connected Folder", () => {
  const a = file("a.txt");
  const b = folder("Reports");
  const link = file("shortcut", { link: { target: "file", targetPath: "/elsewhere/x.txt" } });
  const nested = folder("Client", { nestedFolder: true });
  const byPath = new Map([a, b, link, nested].map((entry) => [entry.path, entry]));
  assert.deepEqual(dragPayload(b, ["a.txt", "Reports"], byPath).map((entry) => entry.path), ["a.txt", "Reports"], "folders drag as files do");
  assert.deepEqual(dragPayload(a, ["Reports"], byPath).map((entry) => entry.path), ["a.txt"], "an unselected item drags alone");
  assert.deepEqual(dragPayload(a, ["a.txt", "shortcut", "Client", "Reports"], byPath).map((entry) => entry.path), ["a.txt", "shortcut", "Reports"]);
  assert.deepEqual(dragPayload(link, ["a.txt", "shortcut"], byPath).map((entry) => entry.path), ["a.txt", "shortcut"]);
  assert.deepEqual(dragPayload(nested, [], byPath), []);
  assert.equal(isDraggableEntry(link), true);
  assert.equal(isDraggableEntry(nested), false);
  assert.equal(isDraggableEntry(b), true);
});

test("dragged items never drop into themselves or a folder inside one", () => {
  assert.equal(canDropInto("Reports", ["Reports"]), false);
  assert.equal(canDropInto("Reports/2026", ["Reports"]), false);
  assert.equal(canDropInto("Reports 2", ["Reports"]), true);
  assert.equal(canDropInto("", ["Reports/a.txt"]), true);
});

test("a link's kind says it is one, and what it points to", () => {
  assert.equal(linkKindLabel({ target: "folder", targetPath: "/usr/lib" }), "Link to Folder");
  assert.equal(linkKindLabel({ target: "file", targetPath: "/home/ana/Report.pdf" }), "Link to PDF document");
  assert.equal(linkKindLabel({ target: "file", targetPath: "/usr/bin/python3" }), "Link to Document");
  assert.equal(linkKindLabel({ target: "missing", targetPath: "/gone.txt" }), "Broken Link");
});

test("hidden items show only while Show Hidden Files is on", () => {
  const entries = [file(".env", { hidden: true }), file("notes.txt"), folder(".config", { hidden: true })];
  assert.deepEqual(shownEntries(entries, false).map((entry) => entry.name), ["notes.txt"]);
  assert.equal(shownEntries(entries, true), entries);
  assert.equal(isHiddenName(".env"), true);
  assert.equal(isHiddenName("Icon\r"), true);
  assert.equal(isHiddenName("notes.txt"), false);
});

test("Show Hidden Files has the system's key: Shift-Command-Period on a Mac, Ctrl+H elsewhere", () => {
  const key = (init: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({ key: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init });
  assert.equal(isShowHiddenFilesKey(key({ key: ">", code: "Period", metaKey: true, shiftKey: true }), true), true);
  assert.equal(isShowHiddenFilesKey(key({ key: ".", metaKey: true }), true), false, "Command-Period alone stops a reply");
  assert.equal(isShowHiddenFilesKey(key({ key: "h", ctrlKey: true }), true), false);
  assert.equal(isShowHiddenFilesKey(key({ key: "h", code: "KeyH", ctrlKey: true }), false), true);
  assert.equal(isShowHiddenFilesKey(key({ key: "H", ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(isShowHiddenFilesKey(key({ key: "h", ctrlKey: true, altKey: true }), false), false);
});

test("a one-level listing asks for the host's whole bound", () => {
  assert.equal(folderListingMaxEntries, 200_000);
});
