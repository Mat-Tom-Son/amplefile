import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFileClipboardPasteRequest,
  pasteboardFileList,
  pasteboardHolds,
  pasteboardHoldsCut,
  placeSourceForPath,
  planFileClipboardPaste,
  readPasteboardFileList,
} from "../desktop/src/file-clipboard-paste.js";

/**
 * Paste in the window (docs/product-model.md, "Finder's file actions"): a Cut
 * made in any window pastes by its place as a move while the pasteboard still
 * holds it; what was copied here pastes by place; another app's files are
 * copied in, or moved when that app cut them (GNOME Files, Dolphin) or the
 * person chose ⌥⌘V.
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
  // A window never says it cut: a Cut is the host's, so a `cut` from the window is dropped.
  assert.deepEqual(request, {
    target,
    mode: "copy",
    internal: { place: documents, paths: ["a.txt"], nativePaths: ["/home/ana/Documents/a.txt"] },
    operationId: "fm-1",
    conflicts: { apply: "replace" },
  });
  assert.throws(() => parseFileClipboardPasteRequest({ mode: "copy" }), /where to paste/);
  assert.throws(() => parseFileClipboardPasteRequest({ target: { place: { kind: "elsewhere", id: "x" }, path: "" } }), /where to paste/);
});

test("a Cut made in any window pastes as a move by its place while the pasteboard holds it with its token", () => {
  const nativePaths = ["/home/ana/Documents/a.txt", "/home/ana/Documents/b"];
  const cut = { place: documents, paths: ["a.txt", "b"], nativePaths, token: "0123456789abcdef0123456789abcdef" };
  const held = { paths: ["/home/ana/Documents/b", "/home/ana/Documents/a.txt"], operation: null, cutToken: cut.token };
  // The window pasting may be another one, with nothing of its own or a Copy of something else.
  for (const internal of [null, { place: documents, paths: ["c.txt"], nativePaths: ["/home/ana/Documents/c.txt"] }]) {
    assert.deepEqual(planFileClipboardPaste({ target, mode: "copy", internal }, held, [notes], cut), {
      sources: [{ place: documents, path: "a.txt" }, { place: documents, path: "b" }],
      mode: "move",
      fromHere: true,
      cut: true,
      from: { place: documents, paths: ["a.txt", "b"] },
    });
  }
  // Finder copied the same files fresh: no token, so it is a Copy of them, not this Cut.
  const fresh = { paths: nativePaths, operation: null, cutToken: null };
  assert.deepEqual(planFileClipboardPaste({ target, mode: "copy", internal: null }, fresh, [notes], cut), {
    sources: nativePaths.map((nativePath) => ({ nativePath })),
    mode: "copy",
    fromHere: false,
    cut: false,
    from: null,
  });
  // Another Cut's token, or other files with this token, are not this Cut either.
  assert.equal(planFileClipboardPaste({ target, mode: "copy", internal: null }, { ...held, cutToken: "fedcba9876543210fedcba9876543210" }, [notes], cut).cut, false);
  assert.equal(planFileClipboardPaste({ target, mode: "copy", internal: null }, { ...held, paths: ["/home/ana/Documents/a.txt"] }, [notes], cut).cut, false);
});

test("what this window copied pastes by place, as the key asked, while the pasteboard holds exactly it", () => {
  const internal = { place: documents, paths: ["a.txt", "b"], nativePaths: ["/home/ana/Documents/a.txt", "/home/ana/Documents/b"] };
  const copied = { paths: [...internal.nativePaths].reverse(), operation: null };
  assert.deepEqual(planFileClipboardPaste({ target, mode: "copy", internal }, copied, [notes]), {
    sources: [{ place: documents, path: "a.txt" }, { place: documents, path: "b" }],
    mode: "copy",
    fromHere: true,
    cut: false,
    from: { place: documents, paths: ["a.txt", "b"] },
  });
  assert.equal(planFileClipboardPaste({ target, mode: "move", internal }, copied, [notes]).mode, "move", "⌥⌘V moves what was copied here");
  // A Cut of the same files took the pasteboard since (its token is there): the window's Copy is not what it holds.
  assert.equal(planFileClipboardPaste({ target, mode: "copy", internal }, { ...copied, cutToken: "0123456789abcdef" }, [notes]).fromHere, false);
  // An empty pasteboard on a Mac holds nothing, even a Copy made here earlier.
  assert.deepEqual(planFileClipboardPaste({ target, mode: "copy", internal }, { paths: [], operation: null }, [notes]).sources, []);
  // Where the desktop reads no files from the pasteboard, the window's own Copy pastes.
  assert.equal(planFileClipboardPaste({ target, mode: "copy", internal }, { paths: [], operation: null, unreadable: true }, [notes]).fromHere, true);
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
    from: null,
  });
  // Copied in another app: copied in, by path.
  assert.deepEqual(planFileClipboardPaste({ target, mode: "copy", internal: null }, { paths: ["/tmp/x"], operation: "copy" }, [notes]), {
    sources: [{ nativePath: "/tmp/x" }],
    mode: "copy",
    fromHere: false,
    cut: false,
    from: null,
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

test("the pasteboard holds exactly these files, or exactly a Cut with its token", () => {
  assert.equal(pasteboardHolds({ paths: ["/a", "/b"], operation: "cut" }, ["/b", "/a"]), true);
  assert.equal(pasteboardHolds({ paths: ["/a"], operation: "cut" }, ["/a", "/b"]), false);
  assert.equal(pasteboardHolds({ paths: ["/c"], operation: "copy" }, ["/a"]), false);
  assert.equal(pasteboardHolds({ paths: [], operation: null }, []), false);
  const cut = { place: documents, paths: ["a", "b"], nativePaths: ["/a", "/b"], token: "0123456789abcdef" };
  assert.equal(pasteboardHoldsCut({ paths: ["/b", "/a"], operation: null, cutToken: cut.token }, cut), true);
  assert.equal(pasteboardHoldsCut({ paths: ["/b", "/a"], operation: null, cutToken: null }, cut), false, "Finder's fresh Copy of the same files");
  assert.equal(pasteboardHoldsCut({ paths: [], operation: null }, cut), false, "emptied, or text copied since");
  // Where the pasteboard carries no token, the same files hold the Cut; where no files can be read, only AmpleFile replaces it.
  assert.equal(pasteboardHoldsCut({ paths: ["/a", "/b"], operation: "cut" }, { ...cut, token: null }), true);
  assert.equal(pasteboardHoldsCut({ paths: ["/c"], operation: "copy" }, { ...cut, token: null }), false);
  assert.equal(pasteboardHoldsCut({ paths: [], operation: null, unreadable: true }, cut), true);
  assert.equal(pasteboardHoldsCut({ paths: ["/a"], operation: null, cutToken: cut.token }, { ...cut, nativePaths: [] }), false);
});

test("a Mac file list carries a Cut's token in a comment that other apps skip, and reads back with it", () => {
  const paths = ["/Users/ana/R&D <draft>.txt", "/Users/ana/Notes"];
  const copy = pasteboardFileList(paths);
  assert.match(copy, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist /);
  assert.match(copy, /<plist version="1\.0"><array><string>\/Users\/ana\/R&amp;D &lt;draft&gt;\.txt<\/string><string>\/Users\/ana\/Notes<\/string><\/array><\/plist>$/);
  assert.deepEqual(readPasteboardFileList(copy), { paths, cutToken: null });
  const cut = pasteboardFileList(paths, "0123456789abcdef0123456789abcdef");
  assert.match(cut, /<plist version="1\.0"><!-- AmpleFile Cut 0123456789abcdef0123456789abcdef --><array>/);
  assert.deepEqual(readPasteboardFileList(cut), { paths, cutToken: "0123456789abcdef0123456789abcdef" });
  // What macOS writes for Finder's Copy of the same files: the same paths, no token.
  const finder = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<array>\n\t<string>/Users/ana/Notes</string>\n</array>\n</plist>\n`;
  assert.deepEqual(readPasteboardFileList(finder), { paths: ["/Users/ana/Notes"], cutToken: null });
  assert.deepEqual(readPasteboardFileList(""), { paths: [], cutToken: null });
});
