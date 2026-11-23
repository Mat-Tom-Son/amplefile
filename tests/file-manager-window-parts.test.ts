import assert from "node:assert/strict";
import test from "node:test";

import { freshHistory, pushLocation, stepBack, stepForward } from "../web-local/src/components/file-manager/file-manager-navigation.js";
import { droppedInternalPaths, dropGoesNowhere, internalDragLifetimeMs, listDropTarget } from "../web-local/src/components/file-manager/file-manager-drops.js";
import { itemMenuCapabilities, selectionMenuCapabilities } from "../web-local/src/components/file-manager/file-manager-menus.js";
import { fileUndoLimit, pushUndo, transferConnectedFolderIds, transferLabel, type FileUndo } from "../web-local/src/components/file-manager/file-manager-undo.js";
import type { FileManagerLocation, FileManagerPlace } from "../web-local/src/components/file-manager/file-manager-places.js";
import type { TreeEntry } from "../web-local/src/types.js";

// The window's parts that hold no DOM: each is tested on its own, as later
// work on one area (navigation, drops, menus, undo) changes only its file.
const lab: FileManagerPlace = { kind: "connected-folder", id: "lab" };
const home: FileManagerPlace = { kind: "standard", id: "home" };
const at = (place: FileManagerPlace, path = ""): FileManagerLocation => ({ place, path });

test("Back and Forward: going somewhere pushes, Back and Forward step through, and going somewhere new clears Forward", () => {
  let history = freshHistory(at(lab));
  history = pushLocation(history, at(lab, "Notes"));
  history = pushLocation(history, at(home, "Documents"));
  assert.deepEqual(history.back, [at(lab), at(lab, "Notes")]);
  assert.equal(pushLocation(history, at(home, "Documents")), history, "going where the view already is changes nothing");

  const back = stepBack(history)!;
  assert.deepEqual(back.location, at(lab, "Notes"));
  assert.deepEqual(back.forward, [at(home, "Documents")]);
  const forward = stepForward(back)!;
  assert.deepEqual(forward, history);

  const elsewhere = pushLocation(back, at(home));
  assert.deepEqual(elsewhere.forward, [], "a new place clears Forward");
  assert.equal(stepBack(freshHistory(at(lab))), null);
  assert.equal(stepForward(freshHistory(at(lab))), null);
});

test("a drop is this window's own drag only for the same items, in the same place, recently", () => {
  const drag = { place: lab, paths: ["Notes/a.md", "b.md"], at: 1_000 };
  assert.deepEqual(droppedInternalPaths(drag, 2_000, { carried: { place: lab, paths: ["Notes/a.md", "b.md"] } }), drag.paths);
  assert.equal(droppedInternalPaths(drag, 2_000, { carried: { place: home, paths: ["Notes/a.md", "b.md"] } }), null, "another place's items");
  assert.equal(droppedInternalPaths(drag, 2_000, { carried: { place: lab, paths: ["b.md", "Notes/a.md"] } }), null, "a different order is a different drag");
  assert.equal(droppedInternalPaths(drag, 2_000, { carried: null }), null);
  assert.deepEqual(droppedInternalPaths(drag, 2_000, { names: ["b.md", "a.md"] }), drag.paths, "the desktop's drag is matched by name");
  assert.equal(droppedInternalPaths(drag, 2_000, { names: ["a.md"] }), null);
  assert.equal(droppedInternalPaths(drag, 1_000 + internalDragLifetimeMs + 1, { names: ["a.md", "b.md"] }), null, "an old drag is not this window's any more");
  assert.equal(droppedInternalPaths(null, 2_000, { names: ["a.md"] }), null);
});

test("a drop lands on a folder row unless it is a link, a nested Connected Folder, or one of the items dragged", () => {
  const folder = { kind: "folder", path: "Notes", name: "Notes" } as TreeEntry;
  assert.equal(listDropTarget(folder, [], "Here"), "Notes");
  assert.equal(listDropTarget({ ...folder, link: { target: "folder", targetPath: "/x" } } as TreeEntry, [], "Here"), "Here");
  assert.equal(listDropTarget({ ...folder, nestedFolder: true } as TreeEntry, [], "Here"), "Here");
  assert.equal(listDropTarget(folder, ["Notes"], "Here"), "Here", "a folder is not dropped into itself");
  assert.equal(listDropTarget({ kind: "file", path: "a.md", name: "a.md" } as TreeEntry, [], "Here"), "Here");
  assert.equal(listDropTarget(undefined, [], ""), "");

  assert.equal(dropGoesNowhere({ place: lab, paths: ["Notes/a.md"], at: 0 }, lab, "Notes"), true, "back where they are");
  assert.equal(dropGoesNowhere({ place: lab, paths: ["Notes/a.md"], at: 0 }, lab, ""), false);
  assert.equal(dropGoesNowhere({ place: lab, paths: ["Notes/a.md"], at: 0 }, home, "Notes"), false, "another place takes them");
  assert.equal(dropGoesNowhere(null, lab, "Notes"), false);
});

test("the item menu offers what applies: History in a Connected Folder, Paste once something was copied, never changes to a nested Connected Folder", () => {
  const file = { kind: "file", path: "a.zip", name: "a.zip" } as TreeEntry;
  const folder = { kind: "folder", path: "Notes", name: "Notes" } as TreeEntry;
  const inLab = itemMenuCapabilities(file, true, { place: lab, fixtureMode: false, canPaste: true });
  assert.equal(inLab.history, true);
  assert.equal(inLab.extract, true);
  assert.equal(inLab.paste, false, "Paste goes into a folder");
  assert.equal(itemMenuCapabilities(file, true, { place: home, fixtureMode: false, canPaste: false }).history, false);
  assert.equal(itemMenuCapabilities(folder, true, { place: lab, fixtureMode: false, canPaste: true }).paste, true);
  assert.equal(itemMenuCapabilities(folder, true, { place: lab, fixtureMode: false, canPaste: false }).paste, false);
  const nested = itemMenuCapabilities({ ...folder, nestedFolder: true } as TreeEntry, true, { place: lab, fixtureMode: false, canPaste: true });
  assert.equal(nested.rename, false);
  assert.equal(nested.delete, false);
  const shown = itemMenuCapabilities({ kind: "folder", path: "", name: "Lab" } as TreeEntry, false, { place: lab, fixtureMode: false, canPaste: false });
  assert.equal(shown.delete, false, "the folder shown is not deleted from its own background");
  const link = itemMenuCapabilities({ ...file, link: { target: "missing", targetPath: "/gone" } } as TreeEntry, true, { place: home, fixtureMode: false, canPaste: false });
  assert.equal(link.open, false);
  assert.equal(link.delete, true, "a broken link is still deleted as itself");
  assert.equal(selectionMenuCapabilities([file, { ...folder, nestedFolder: true } as TreeEntry]).delete, false);
  assert.equal(selectionMenuCapabilities([file, folder]).delete, true);
});

test("⌘Z keeps the last fifty changes, and a transfer's History turns cover each Connected Folder it touches", () => {
  let stack: FileUndo[] = [];
  for (let index = 0; index < fileUndoLimit + 5; index += 1) stack = pushUndo(stack, { label: `change ${index}`, run: async () => null });
  assert.equal(stack.length, fileUndoLimit);
  assert.equal(stack[0]!.label, "change 5");
  assert.equal(stack.at(-1)!.label, `change ${fileUndoLimit + 4}`);

  assert.deepEqual(transferConnectedFolderIds({ mode: "move", sources: [{ place: lab, path: "a" }, { nativePath: "/tmp/b" }, { place: { kind: "connected-folder", id: "other" }, path: "c" }], target: { place: home, path: "" } }), ["lab", "other"]);
  assert.equal(transferLabel(["Notes/a.md"]), "a.md");
  assert.equal(transferLabel(["a", "b"]), "2 items");
});
