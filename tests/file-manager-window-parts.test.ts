import assert from "node:assert/strict";
import test from "node:test";

import { freshHistory, pushLocation, stepBack, stepForward } from "../web-local/src/components/file-manager/file-manager-navigation.js";
import { droppedInternalPaths, dropGoesNowhere, internalDragLifetimeMs, listDropTarget } from "../web-local/src/components/file-manager/file-manager-drops.js";
import { itemMenuCapabilities, selectionMenuCapabilities } from "../web-local/src/components/file-manager/file-manager-menus.js";
import { fileUndoLimit, moveBackPlan, moveBackRequests, movedBack, movedItems, movesUndo, pushUndo, transferConnectedFolderIds, transferLabel, undoneByMovingBack, type FileUndo, type TransferBody, type TransferMove } from "../web-local/src/components/file-manager/file-manager-undo.js";
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

test("a move a plain folder took part in is undone by moving its items back where they were", () => {
  const documents: FileManagerPlace = { kind: "standard", id: "documents" };
  const desktop: FileManagerPlace = { kind: "standard", id: "desktop" };
  // History undoes a move between Connected Folders, or inside one; a plain folder on either side has none.
  assert.equal(undoneByMovingBack(undefined, lab), false);
  assert.equal(undoneByMovingBack([], documents), false);
  assert.equal(undoneByMovingBack([{ from: "a.md", to: "a.md", fromPlace: { kind: "connected-folder", id: "other" } }], lab), false);
  assert.equal(undoneByMovingBack([{ from: "a.md", to: "Notes/a.md", fromPlace: lab }], documents), true, "out of a Connected Folder");
  assert.equal(undoneByMovingBack([{ from: "a.md", to: "a.md", fromPlace: documents }], lab), true, "into a Connected Folder");
  assert.equal(undoneByMovingBack([{ from: "a.md", to: "a.md" }], documents), true, "inside a plain folder");

  // What ⌘Z needs: the items, a target Connected Folder's restore points when it replaced there or a copy stayed, and whether ⇧⌘Z applies.
  const point = { connectedFolderId: "lab", checkpointId: "before" };
  assert.equal(moveBackPlan({ moves: [], restorePoints: [point] }, lab), null, "History alone undoes it");
  const intoLab = { moves: [{ from: "a.md", to: "a.md", fromPlace: documents }], restorePoints: [point] };
  assert.deepEqual(moveBackPlan(intoLab, lab), { items: [{ at: { place: lab, path: "a.md" }, home: { place: documents, path: "a.md" } }], restores: [], redoable: true });
  assert.deepEqual(moveBackPlan({ ...intoLab, replaced: [{}] }, lab)?.restores, [point]);
  assert.equal(moveBackPlan({ ...intoLab, replaced: [{}] }, lab)?.redoable, false);
  assert.deepEqual(moveBackPlan({ ...intoLab, notRemoved: ["b.md"] }, lab)?.restores, [point], "a copy that stayed in both places goes with the restore point");
  assert.equal(moveBackPlan({ ...intoLab, merged: ["Photos"] }, lab)?.redoable, false);
  assert.deepEqual(moveBackPlan({ moves: [{ from: "a.md", to: "a.md", fromPlace: lab }], restorePoints: [point], replaced: [] }, documents)?.restores, [], "the Connected Folder the items left is not restored: they are moved back into it");

  // One request for each folder the items came from, each item under the name it had, the folder made again if it is gone.
  const items = movedItems([
    { from: "a.md", to: "Inbox/a copy.md", fromPlace: lab },
    { from: "Photos/Trip/b.jpg", to: "Inbox/Photos/Trip/b.jpg", fromPlace: lab },
    { from: "Photos/Trip/c.jpg", to: "Inbox/Photos/Trip/c copy.jpg", fromPlace: lab },
    { from: "Desk/d.txt", to: "Inbox/d.txt", fromPlace: desktop },
    { from: "e.txt", to: "Inbox/e.txt" },
  ], documents);
  const requests = moveBackRequests(items);
  assert.deepEqual(requests.map((request) => request.body), [
    { mode: "move", sources: [{ place: documents, path: "Inbox/a copy.md", name: "a.md" }], target: { place: lab, path: "", create: true } },
    { mode: "move", sources: [{ place: documents, path: "Inbox/Photos/Trip/b.jpg", name: "b.jpg" }, { place: documents, path: "Inbox/Photos/Trip/c copy.jpg", name: "c.jpg" }], target: { place: lab, path: "Photos/Trip", create: true } },
    { mode: "move", sources: [{ place: documents, path: "Inbox/d.txt", name: "d.txt" }], target: { place: desktop, path: "Desk", create: true } },
    { mode: "move", sources: [{ place: documents, path: "Inbox/e.txt", name: "e.txt" }], target: { place: documents, path: "", create: true } },
  ]);
  assert.deepEqual(requests.map((request) => request.items.length), [1, 2, 1, 1]);
  assert.deepEqual(transferConnectedFolderIds(requests[0]!.body), ["lab"], "a move back into a Connected Folder waits its turn in its History");

  // The redo is the same items the other way, for the ones the answer says went back.
  const second = requests[1]!;
  const redo = movedBack(second.items, [{ from: "Inbox/Photos/Trip/b.jpg", to: "Photos/Trip/b.jpg", fromPlace: documents }]);
  assert.deepEqual(redo, [{ at: { place: lab, path: "Photos/Trip/b.jpg" }, home: { place: documents, path: "Inbox/Photos/Trip/b.jpg" } }], "an item that did not go back is not redone");
  assert.deepEqual(moveBackRequests(redo).map((request) => request.body), [
    { mode: "move", sources: [{ place: lab, path: "Photos/Trip/b.jpg", name: "b.jpg" }], target: { place: documents, path: "Inbox/Photos/Trip", create: true } },
  ]);
  assert.deepEqual(movedBack(second.items, undefined), []);
});

test("the step that moves items back keeps its place when it is refused partway, then restores, and is redone only when nothing was replaced", async () => {
  const documents: FileManagerPlace = { kind: "standard", id: "documents" };
  const items = movedItems([
    { from: "Docs/a.md", to: "a.md", fromPlace: documents },
    { from: "Pics/b.jpg", to: "b.jpg", fromPlace: documents },
  ], lab);
  const sent: TransferBody[] = [];
  const restored: string[] = [];
  let refuse = true;
  const host = {
    transfer: async (body: TransferBody) => {
      // The second folder's request is refused once, as a busy Connected Folder refuses.
      if (body.target.path === "Pics" && refuse) { refuse = false; throw new Error("Finish or stop Lab’s outstanding work before moving items out of it."); }
      sent.push(body);
      const moves: TransferMove[] = body.sources.flatMap((source) => "place" in source ? [{ from: source.path, to: `${body.target.path}/${source.name}`, fromPlace: source.place }] : []);
      return { moves };
    },
    restore: async (point: { checkpointId: string }) => { restored.push(point.checkpointId); },
  };
  const undo = movesUndo("Move 2 items", items, [{ connectedFolderId: "lab", checkpointId: "before-move" }], true, host);
  assert.equal(undo.resumes, true);
  await assert.rejects(undo.run(), /outstanding work/);
  assert.deepEqual(sent.map((body) => body.target.path), ["Docs"], "the first folder's items went back");
  assert.deepEqual(restored, [], "nothing is restored until every item is back");

  // Run again: it goes on with what is left, never sending the first request twice.
  const redo = await undo.run();
  assert.deepEqual(sent.map((body) => body.target.path), ["Docs", "Pics"]);
  assert.deepEqual(restored, ["before-move"]);
  assert.ok(redo, "a move that replaced nothing can be redone");

  // The redo moves the same items out again, from where they went back to, and needs no restore.
  sent.length = 0;
  const undoAgain = await redo.run();
  assert.deepEqual(sent, [
    { mode: "move", sources: [{ place: documents, path: "Docs/a.md", name: "a.md" }, { place: documents, path: "Pics/b.jpg", name: "b.jpg" }], target: { place: lab, path: "", create: true } },
  ]);
  assert.deepEqual(restored, ["before-move"]);
  assert.ok(undoAgain);

  // A move that replaced something puts it back from the restore point and is not redone.
  const replaced = movesUndo("Move a.md", items.slice(0, 1), [{ connectedFolderId: "lab", checkpointId: "held-replaced" }], false, host);
  assert.equal(await replaced.run(), null);
  assert.equal(restored.at(-1), "held-replaced");
});
