import assert from "node:assert/strict";
import test from "node:test";

import { parseFileClipboardPasteRequest, pasteboardHolds, placeSourceForPath, planFileClipboardPaste } from "../desktop/src/file-clipboard-paste.js";

/**
 * Paste in the window (docs/product-model.md, "Finder's file actions"): what
 * was copied or cut here pastes by place, a Cut as a move; another app's
 * files are copied in, or moved when that app cut them (GNOME Files, Dolphin)
 * or the person chose ⌥⌘V.
 */

const documents = { kind: "standard" as const, id: "documents" };
const notes = { id: "space-0123456789abcdef", connectedFolderRoot: "/home/ana/Notes" };
const target = { place: { kind: "connected-folder" as const, id: notes.id }, path: "Inbox" };

test("a paste request is checked and keeps its progress id and conflict choices", () => {
  const request = parseFileClipboardPasteRequest({
    target,
    mode: "copy",
    internal: { place: documents, paths: ["a.txt"], nativePaths: ["/home/ana/Documents/a.txt"], cut: true },
    operationId: "fm-1",
    conflicts: { apply: "replace" },
  });
  assert.deepEqual(request, {
    target,
    mode: "copy",
    internal: { place: documents, paths: ["a.txt"], nativePaths: ["/home/ana/Documents/a.txt"], cut: true },
    operationId: "fm-1",
    conflicts: { apply: "replace" },
  });
  assert.throws(() => parseFileClipboardPasteRequest({ mode: "copy" }), /where to paste/);
  assert.throws(() => parseFileClipboardPasteRequest({ target: { place: { kind: "elsewhere", id: "x" }, path: "" } }), /where to paste/);
});

test("items cut here paste as a move by place; copied here, as the key asked", () => {
  const internal = { place: documents, paths: ["a.txt", "b"], nativePaths: ["/home/ana/Documents/a.txt", "/home/ana/Documents/b"], cut: true };
  const pasteboard = { paths: ["/home/ana/Documents/b", "/home/ana/Documents/a.txt"], operation: "cut" as const };
  assert.deepEqual(planFileClipboardPaste({ target, mode: "copy", internal }, pasteboard, [notes]), {
    sources: [{ place: documents, path: "a.txt" }, { place: documents, path: "b" }],
    mode: "move",
    fromHere: true,
    cut: true,
  });
  const copied = { ...internal, cut: false };
  assert.equal(planFileClipboardPaste({ target, mode: "copy", internal: copied }, { paths: internal.nativePaths, operation: "copy" }, [notes]).mode, "copy");
  assert.equal(planFileClipboardPaste({ target, mode: "move", internal: copied }, { paths: internal.nativePaths, operation: null }, [notes]).mode, "move", "⌥⌘V moves what was copied here");
  // A Mac's pasteboard has no cut marker: the window's own Cut still moves.
  assert.equal(planFileClipboardPaste({ target, mode: "copy", internal }, { paths: internal.nativePaths, operation: null }, [notes]).mode, "move");
  // The browser preview's paste has no pasteboard at all.
  assert.equal(planFileClipboardPaste({ target, mode: "copy", internal }, { paths: [], operation: null }, [notes]).fromHere, true);
});

test("another app's Cut moves its files, named by the Connected Folder or the computer place that holds them", () => {
  const pasteboard = { paths: ["/home/ana/Notes/Ideas/one.md", "/home/ana/Downloads/two.pdf"], operation: "cut" as const };
  // Something else was copied here earlier; the pasteboard now holds other files, so those win.
  const stale = { place: documents, paths: ["a.txt"], nativePaths: ["/home/ana/Documents/a.txt"], cut: false };
  assert.deepEqual(planFileClipboardPaste({ target, mode: "copy", internal: stale }, pasteboard, [notes]), {
    sources: [
      { place: { kind: "connected-folder", id: notes.id }, path: "Ideas/one.md" },
      { place: { kind: "standard", id: "computer" }, path: "home/ana/Downloads/two.pdf" },
    ],
    mode: "move",
    fromHere: false,
    cut: true,
  });
  // Copied in another app: copied in, by path.
  assert.deepEqual(planFileClipboardPaste({ target, mode: "copy", internal: null }, { paths: ["/tmp/x"], operation: "copy" }, [notes]), {
    sources: [{ nativePath: "/tmp/x" }],
    mode: "copy",
    fromHere: false,
    cut: false,
  });
  // ⌥⌘V on another app's Copy moves, as Finder's does.
  assert.equal(planFileClipboardPaste({ target, mode: "move", internal: null }, { paths: ["/tmp/x"], operation: null }, [notes]).mode, "move");
  assert.deepEqual(planFileClipboardPaste({ target, mode: "copy", internal: null }, { paths: [], operation: null }, [notes]).sources, []);
});

test("the deepest Connected Folder names a file; its own folder is not inside it", () => {
  const nested = { id: "space-fedcba9876543210", connectedFolderRoot: "/home/ana/Notes/Ideas" };
  assert.deepEqual(placeSourceForPath("/home/ana/Notes/Ideas/one.md", [notes, nested]), { place: { kind: "connected-folder", id: nested.id }, path: "one.md" });
  assert.deepEqual(placeSourceForPath("/home/ana/Notes", [notes]), { place: { kind: "standard", id: "computer" }, path: "home/ana/Notes" });
  assert.deepEqual(placeSourceForPath("/home/ana/Notes-old/x", [notes]), { place: { kind: "standard", id: "computer" }, path: "home/ana/Notes-old/x" });
});

test("items cut here stay cut only while the pasteboard holds exactly them", () => {
  assert.equal(pasteboardHolds({ paths: ["/a", "/b"], operation: "cut" }, ["/b", "/a"]), true);
  assert.equal(pasteboardHolds({ paths: ["/a"], operation: "cut" }, ["/a", "/b"]), false);
  assert.equal(pasteboardHolds({ paths: ["/c"], operation: "copy" }, ["/a"]), false);
  assert.equal(pasteboardHolds({ paths: [], operation: null }, []), false);
});
