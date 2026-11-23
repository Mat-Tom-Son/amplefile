import assert from "node:assert/strict";
import test from "node:test";

import { freshHistory, pushLocation, stepBack, stepForward } from "../web-local/src/components/file-manager/file-manager-navigation.js";
import { droppedInternalPaths, dropGoesNowhere, internalDragLifetimeMs, listDropTarget } from "../web-local/src/components/file-manager/file-manager-drops.js";
import { itemMenuCapabilities, selectionMenuCapabilities } from "../web-local/src/components/file-manager/file-manager-menus.js";
import { fileUndoLimit, isPartialUndo, moveBackPlan, moveBackReport, moveBackRequests, movedBack, movedItems, movesUndo, notPutBack, pushUndo, transferConnectedFolderIds, transferLabel, undoneByMovingBack, type FileUndo, type MoveBackAnswer, type MoveBackHost, type MoveBackPlan, type TransferBody, type TransferMove } from "../web-local/src/components/file-manager/file-manager-undo.js";
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
  const inLab = { place: lab, path: "" };
  const inDocuments = { place: documents, path: "Inbox" };
  assert.equal(moveBackPlan({ moves: [], restorePoints: [point] }, inLab), null, "History alone undoes it");
  const intoLab = { moves: [{ from: "a.md", to: "a.md", fromPlace: documents }], restorePoints: [point] };
  assert.deepEqual(moveBackPlan(intoLab, inLab), { items: [{ at: { place: lab, path: "a.md" }, home: { place: documents, path: "a.md" } }], restores: [], redoable: true, leftCopies: null });
  assert.deepEqual(moveBackPlan({ ...intoLab, replaced: [{}] }, inLab)?.restores, [point]);
  assert.equal(moveBackPlan({ ...intoLab, replaced: [{}] }, inLab)?.redoable, false);
  assert.deepEqual(moveBackPlan({ ...intoLab, notRemoved: ["b.md"] }, inLab)?.restores, [point], "a copy that stayed in both places goes with the restore point");
  assert.equal(moveBackPlan({ ...intoLab, notRemoved: ["b.md"] }, inLab)?.leftCopies, null, "History takes it back, so nothing is left over");
  assert.equal(moveBackPlan({ ...intoLab, merged: ["Photos"] }, inLab)?.redoable, false);
  const outOfLab = { moves: [{ from: "a.md", to: "Inbox/a.md", fromPlace: lab }], restorePoints: [point], replaced: [] };
  assert.deepEqual(moveBackPlan(outOfLab, inDocuments)?.restores, [], "the Connected Folder the items left is not restored: they are moved back into it");
  // A copy the move left in a plain folder has no History to take it back: ⌘Z says it is still there.
  assert.deepEqual(moveBackPlan({ ...outOfLab, notRemoved: ["Notes/b.md"], leftInTarget: ["Inbox/c.md"] }, inDocuments)?.leftCopies, { names: ["b.md", "c.md"], where: inDocuments });

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
    { mode: "move", sources: [{ place: documents, path: "Inbox/a copy.md", name: "a.md" }], target: { place: lab, path: "", create: true }, conflicts: { apply: "skip" } },
    { mode: "move", sources: [{ place: documents, path: "Inbox/Photos/Trip/b.jpg", name: "b.jpg" }, { place: documents, path: "Inbox/Photos/Trip/c copy.jpg", name: "c.jpg" }], target: { place: lab, path: "Photos/Trip", create: true }, conflicts: { apply: "skip" } },
    { mode: "move", sources: [{ place: documents, path: "Inbox/d.txt", name: "d.txt" }], target: { place: desktop, path: "Desk", create: true }, conflicts: { apply: "skip" } },
    { mode: "move", sources: [{ place: documents, path: "Inbox/e.txt", name: "e.txt" }], target: { place: documents, path: "", create: true }, conflicts: { apply: "skip" } },
  ]);
  assert.deepEqual(requests.map((request) => request.items.length), [1, 2, 1, 1]);
  assert.deepEqual(transferConnectedFolderIds(requests[0]!.body), ["lab"], "a move back into a Connected Folder waits its turn in its History");

  // The redo is the same items the other way, for the ones the answer says went back.
  const second = requests[1]!;
  const redo = movedBack(second.items, [{ from: "Inbox/Photos/Trip/b.jpg", to: "Photos/Trip/b.jpg", fromPlace: documents }]);
  assert.deepEqual(redo, [{ at: { place: lab, path: "Photos/Trip/b.jpg" }, home: { place: documents, path: "Inbox/Photos/Trip/b.jpg" } }], "an item that did not go back is not redone");
  assert.deepEqual(moveBackRequests(redo).map((request) => request.body), [
    { mode: "move", sources: [{ place: lab, path: "Photos/Trip/b.jpg", name: "b.jpg" }], target: { place: documents, path: "Inbox/Photos/Trip", create: true }, conflicts: { apply: "skip" } },
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
  const host: MoveBackHost = {
    transfer: async (body) => {
      // The second folder's request is refused once, as a busy Connected Folder refuses.
      if (body.target.path === "Pics" && refuse) { refuse = false; throw new Error("Finish or stop Lab’s outstanding work before moving items out of it."); }
      sent.push(body);
      const moves: TransferMove[] = body.sources.flatMap((source) => "place" in source ? [{ from: source.path, to: `${body.target.path}/${source.name}`, fromPlace: source.place }] : []);
      return { moves };
    },
    restore: async (point) => { restored.push(point.checkpointId); },
    nameOf: placeName,
  };
  const plan = (over: Partial<MoveBackPlan>): MoveBackPlan => ({ items, restores: [], redoable: true, leftCopies: null, ...over });
  const undo = movesUndo("Move 2 items", plan({ restores: [{ connectedFolderId: "lab", checkpointId: "before-move" }] }), host);
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
    { mode: "move", sources: [{ place: documents, path: "Docs/a.md", name: "a.md" }, { place: documents, path: "Pics/b.jpg", name: "b.jpg" }], target: { place: lab, path: "", create: true }, conflicts: { apply: "skip" } },
  ]);
  assert.ok(undoAgain && !isPartialUndo(undoAgain));
  assert.deepEqual(restored, ["before-move"]);
  assert.ok(undoAgain);

  // A move that replaced something puts it back from the restore point and is not redone.
  const replaced = movesUndo("Move a.md", plan({ items: items.slice(0, 1), restores: [{ connectedFolderId: "lab", checkpointId: "held-replaced" }], redoable: false }), host);
  assert.equal(await replaced.run(), null);
  assert.equal(restored.at(-1), "held-replaced");
});

/** A folder by its name, or its place's, as the window names it. */
function placeName(folder: { place: FileManagerPlace; path: string }): string {
  return folder.path ? folder.path.slice(folder.path.lastIndexOf("/") + 1) : ({ lab: "Lab", documents: "Documents", desktop: "Desktop", home: "Home" } as Record<string, string>)[folder.place.id] ?? folder.place.id;
}

test("⌘Z never says it undid a move when an item did not go back, and says where each one is and why", async () => {
  const documents: FileManagerPlace = { kind: "standard", id: "documents" };
  const items = movedItems([
    { from: "Docs/a.md", to: "a.md", fromPlace: documents },
    { from: "Docs/b.md", to: "b.md", fromPlace: documents },
    { from: "Docs/c.md", to: "c.md", fromPlace: documents },
    { from: "Docs/d", to: "d", fromPlace: documents },
    { from: "Docs/e.md", to: "e.md", fromPlace: documents },
  ], lab);
  // The engine's answer to the move back: one went, one's name is taken, one failed, one is in both places, one left a part behind.
  const answer: MoveBackAnswer = {
    moves: [{ from: "a.md", to: "Docs/a.md", fromPlace: lab }, { from: "d", to: "Docs/d", fromPlace: lab }],
    skipped: [{ path: "Docs/b.md", reason: "chosen" }],
    failed: { path: "c.md", error: "“c.md” changed while it was being copied, so it stays where it was." },
    failures: [{ path: "c.md", error: "“c.md” changed while it was being copied, so it stays where it was." }, { path: "e.md", error: "Operation not permitted" }],
    notRemoved: ["e.md"],
    partlyRemoved: [{ path: "d", error: "Part of “d” could not be removed" }],
  };
  const kept = notPutBack(items, answer);
  assert.deepEqual(kept.map((one) => [one.item.at.path, one.why]), [["b.md", "taken"], ["c.md", "failed"], ["d", "partly"], ["e.md", "both"]]);
  assert.deepEqual(notPutBack(items.slice(0, 1), {}).map((one) => one.why), ["failed"], "an item the answer says nothing about stayed");
  assert.deepEqual(moveBackReport(kept, { nameOf: placeName }), [
    "“b.md” was not put back: Docs has an item with that name now. It is still in Lab.",
    "“c.md” was not put back and is still in Lab. “c.md” changed while it was being copied, so it stays where it was.",
    "“d” is back in Docs, but part of it could not be removed from Lab and is still there. Part of “d” could not be removed.",
    "“e.md” is back in Docs, and is also still in Lab. Operation not permitted.",
  ]);
  assert.deepEqual(moveBackReport([kept[0]!, { ...kept[0]!, item: items[2]! }], { nameOf: placeName }, true), [
    "“b.md”, “c.md” were not moved again: Docs has items with those names now. They are still in Lab.",
  ], "items with the same outcome share a sentence, and ⇧⌘Z speaks of moving again");

  const restored: string[] = [];
  const sent: Array<TransferBody & { conflicts?: unknown }> = [];
  const host: MoveBackHost = { transfer: async (body) => { sent.push(body); return answer; }, restore: async (point) => { restored.push(point.checkpointId); }, nameOf: placeName };
  const undo = movesUndo("Move 5 items", { items, restores: [{ connectedFolderId: "lab", checkpointId: "before-move" }], redoable: true, leftCopies: null }, host);
  const outcome = await undo.run();
  assert.ok(isPartialUndo(outcome));
  assert.deepEqual(sent.map((body) => body.conflicts), [{ apply: "skip" }], "a name taken at home is skipped, never given “ copy” and never replaced");
  assert.match(outcome.said, /^Undid part of Move 5 items\. “b\.md” was not put back/);
  assert.match(outcome.said, /Nothing else in Lab was changed back/);
  assert.deepEqual(restored, [], "no restore point runs over an item that is still where the move put it");
  assert.ok(outcome.reverse, "what did go back can be moved out again");

  // Nothing went back at all.
  const none = await movesUndo("Move b.md", { items: items.slice(1, 2), restores: [], redoable: true, leftCopies: null }, { ...host, transfer: async () => ({ moves: [], skipped: [{ path: "Docs/b.md" }] }) }).run();
  assert.ok(isPartialUndo(none));
  assert.equal(none.said, "Could not undo Move b.md. “b.md” was not put back: Docs has an item with that name now. It is still in Lab.");
  assert.equal(none.reverse, null);

  // Every item went back, but the move had left a copy in a plain folder, which no History takes away.
  const out = movedItems([{ from: "a.md", to: "Inbox/a.md", fromPlace: lab }], documents);
  const left = await movesUndo("Move 2 items", { items: out, restores: [], redoable: true, leftCopies: { names: ["b.md"], where: { place: documents, path: "Inbox" } } }, { ...host, transfer: async () => ({ moves: [{ from: "Inbox/a.md", to: "a.md", fromPlace: documents }] }) }).run();
  assert.ok(isPartialUndo(left));
  assert.equal(left.said, "Undid Move 2 items. The copy of “b.md” that the move left in Inbox is still there.");
});
