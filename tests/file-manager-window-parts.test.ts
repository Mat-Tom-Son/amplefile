import assert from "node:assert/strict";
import test from "node:test";

import { freshHistory, pushLocation, stepBack, stepForward } from "../web-local/src/components/file-manager/file-manager-navigation.js";
import { droppedInternalPaths, dropGoesNowhere, internalDragLifetimeMs, listDropTarget } from "../web-local/src/components/file-manager/file-manager-drops.js";
import { itemMenuCapabilities, selectionMenuCapabilities } from "../web-local/src/components/file-manager/file-manager-menus.js";
import { fileUndoLimit, isBusyRefusal, isPartialUndo, moveBackPlan, moveBackReport, moveBackRequests, movedBack, movedItems, movesUndo, notPutBack, plainReason, pushUndo, transferConnectedFolderIds, transferLabel, type FileUndo, type MoveBackAnswer, type MoveBackHost, type MoveBackPlan, type TransferBody, type TransferMove } from "../web-local/src/components/file-manager/file-manager-undo.js";
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

test("a move between places, or between plain folders, is undone by moving its items back where they were", () => {
  const documents: FileManagerPlace = { kind: "standard", id: "documents" };
  const desktop: FileManagerPlace = { kind: "standard", id: "desktop" };
  const other: FileManagerPlace = { kind: "connected-folder", id: "other" };
  const point = { connectedFolderId: "lab", checkpointId: "before" };
  const source = { connectedFolderId: "other", checkpointId: "left" };
  const inLab = { place: lab, path: "" };
  const inDocuments = { place: documents, path: "Inbox" };
  // History alone undoes a move inside one Connected Folder, or a copy: their answers list no moves.
  assert.equal(moveBackPlan({ restorePoints: [point] }, inLab), null);
  assert.equal(moveBackPlan({ restorePoints: [point], replaced: [{}] }, inLab), null, "a copy that replaced something is History's too");
  assert.equal(moveBackPlan({ moves: [], restorePoints: [] }, inDocuments), null, "nothing moved and nothing to restore");

  // What ⌘Z needs: the items, the target Connected Folder's restore points when it replaced there or a copy stayed, and whether ⇧⌘Z applies.
  const intoLab = { moves: [{ from: "a.md", to: "a.md", fromPlace: documents }], restorePoints: [point] };
  assert.deepEqual(moveBackPlan(intoLab, inLab), { items: [{ at: { place: lab, path: "a.md" }, home: { place: documents, path: "a.md" } }], restores: [], redoable: true, copies: [], leftCopies: null });
  assert.deepEqual(moveBackPlan({ ...intoLab, replaced: [{}] }, inLab)?.restores, [point]);
  assert.equal(moveBackPlan({ ...intoLab, replaced: [{}] }, inLab)?.redoable, false);
  assert.equal(moveBackPlan({ ...intoLab, merged: ["Photos"] }, inLab)?.redoable, false);
  // A copy that stayed in both places goes with the restore point, once it is seen to match its original still.
  const both = moveBackPlan({ ...intoLab, notRemoved: ["Docs/b.md"], copies: [{ from: "Docs/b.md", to: "b.md", fromPlace: documents }] }, inLab);
  assert.deepEqual(both?.restores, [point]);
  assert.deepEqual(both?.copies, [{ original: { place: documents, path: "Docs/b.md" }, copy: { place: lab, path: "b.md" } }]);
  assert.equal(both?.leftCopies, null, "History takes it back, so nothing is left over");
  // Nothing moved, but a copy stayed in the Connected Folder: ⌘Z still looks at it before History takes it away.
  const onlyCopies = moveBackPlan({ moves: [], restorePoints: [point], notRemoved: ["Docs/b.md"], copies: [{ from: "Docs/b.md", to: "b.md", fromPlace: documents }] }, inLab);
  assert.deepEqual([onlyCopies?.items, onlyCopies?.restores, onlyCopies?.copies.length], [[], [point], 1]);
  // Between two Connected Folders the items are moved back too, and only the target's restore point is ever run.
  const between = moveBackPlan({ moves: [{ from: "a.md", to: "a.md", fromPlace: other }], restorePoints: [point, source], replaced: [{}] }, inLab);
  assert.deepEqual(between?.items, [{ at: { place: lab, path: "a.md" }, home: { place: other, path: "a.md" } }]);
  assert.deepEqual(between?.restores, [point], "the Connected Folder the items left is not restored: they are moved back into it");
  const outOfLab = { moves: [{ from: "a.md", to: "Inbox/a.md", fromPlace: lab }], restorePoints: [point], replaced: [] };
  assert.deepEqual(moveBackPlan(outOfLab, inDocuments)?.restores, []);
  // A copy the move left in a plain folder has no History to take it back: ⌘Z says it is still there.
  assert.deepEqual(moveBackPlan({ ...outOfLab, notRemoved: ["Notes/b.md"], leftInTarget: ["Inbox/c.md"] }, inDocuments)?.leftCopies, { names: ["b.md", "c.md"], where: inDocuments });
  assert.deepEqual(moveBackPlan({ moves: [{ from: "a.md", to: "a.md" }], restorePoints: [] }, { place: documents, path: "" })?.items.length, 1, "inside a plain folder");

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
    { mode: "move", sources: [{ place: documents, path: "Inbox/a copy.md", name: "a.md" }], target: { place: lab, path: "", create: true }, conflicts: { apply: "skip" }, missing: "skip" },
    { mode: "move", sources: [{ place: documents, path: "Inbox/Photos/Trip/b.jpg", name: "b.jpg" }, { place: documents, path: "Inbox/Photos/Trip/c copy.jpg", name: "c.jpg" }], target: { place: lab, path: "Photos/Trip", create: true }, conflicts: { apply: "skip" }, missing: "skip" },
    { mode: "move", sources: [{ place: documents, path: "Inbox/d.txt", name: "d.txt" }], target: { place: desktop, path: "Desk", create: true }, conflicts: { apply: "skip" }, missing: "skip" },
    { mode: "move", sources: [{ place: documents, path: "Inbox/e.txt", name: "e.txt" }], target: { place: documents, path: "", create: true }, conflicts: { apply: "skip" }, missing: "skip" },
  ]);
  assert.deepEqual(requests.map((request) => request.items.length), [1, 2, 1, 1]);
  assert.deepEqual(transferConnectedFolderIds(requests[0]!.body), ["lab"], "a move back into a Connected Folder waits its turn in its History");

  // The redo is the same items the other way, for the ones the answer says went back.
  const second = requests[1]!;
  const redo = movedBack(second.items, [{ from: "Inbox/Photos/Trip/b.jpg", to: "Photos/Trip/b.jpg", fromPlace: documents }]);
  assert.deepEqual(redo, [{ at: { place: lab, path: "Photos/Trip/b.jpg" }, home: { place: documents, path: "Inbox/Photos/Trip/b.jpg" } }], "an item that did not go back is not redone");
  assert.deepEqual(moveBackRequests(redo).map((request) => request.body), [
    { mode: "move", sources: [{ place: lab, path: "Photos/Trip/b.jpg", name: "b.jpg" }], target: { place: documents, path: "Inbox/Photos/Trip", create: true }, conflicts: { apply: "skip" }, missing: "skip" },
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
      // The second folder's request is refused once, as a busy Connected Folder refuses: 409 with the code that says to try again later.
      if (body.target.path === "Pics" && refuse) { refuse = false; throw Object.assign(new Error("Finish or stop Lab’s outstanding work before moving items out of it."), { status: 409, code: "busy" }); }
      sent.push(body);
      const moves: TransferMove[] = body.sources.flatMap((source) => "place" in source ? [{ from: source.path, to: `${body.target.path}/${source.name}`, fromPlace: source.place }] : []);
      return { moves };
    },
    restore: async (point) => { restored.push(point.checkpointId); },
    copiesChanged: async () => [],
    nameOf: placeName,
  };
  const plan = (over: Partial<MoveBackPlan>): MoveBackPlan => ({ items, restores: [], redoable: true, copies: [], leftCopies: null, ...over });
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
    { mode: "move", sources: [{ place: documents, path: "Docs/a.md", name: "a.md" }, { place: documents, path: "Pics/b.jpg", name: "b.jpg" }], target: { place: lab, path: "", create: true }, conflicts: { apply: "skip" }, missing: "skip" },
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
  const host: MoveBackHost = { transfer: async (body) => { sent.push(body); return answer; }, restore: async (point) => { restored.push(point.checkpointId); }, copiesChanged: async () => [], nameOf: placeName };
  const undo = movesUndo("Move 5 items", { items, restores: [{ connectedFolderId: "lab", checkpointId: "before-move" }], redoable: true, copies: [], leftCopies: null }, host);
  const outcome = await undo.run();
  assert.ok(isPartialUndo(outcome));
  assert.deepEqual(sent.map((body) => body.conflicts), [{ apply: "skip" }], "a name taken at home is skipped, never given “ copy” and never replaced");
  assert.match(outcome.said, /^Undid part of Move 5 items\. “b\.md” was not put back/);
  assert.match(outcome.said, /Nothing else in Lab was changed back/);
  assert.deepEqual(restored, [], "no restore point runs over an item that is still where the move put it");
  assert.ok(outcome.reverse, "what did go back can be moved out again");

  // Nothing went back at all.
  const none = await movesUndo("Move b.md", { items: items.slice(1, 2), restores: [], redoable: true, copies: [], leftCopies: null }, { ...host, transfer: async () => ({ moves: [], skipped: [{ path: "Docs/b.md" }] }) }).run();
  assert.ok(isPartialUndo(none));
  assert.equal(none.said, "Could not undo Move b.md. “b.md” was not put back: Docs has an item with that name now. It is still in Lab.");
  assert.equal(none.reverse, null);

  // Every item went back, but the move had left a copy in a plain folder, which no History takes away.
  const out = movedItems([{ from: "a.md", to: "Inbox/a.md", fromPlace: lab }], documents);
  const left = await movesUndo("Move 2 items", { items: out, restores: [], redoable: true, copies: [], leftCopies: { names: ["b.md"], where: { place: documents, path: "Inbox" } } }, { ...host, transfer: async () => ({ moves: [{ from: "Inbox/a.md", to: "a.md", fromPlace: documents }] }) }).run();
  assert.ok(isPartialUndo(left));
  assert.equal(left.said, "Undid Move 2 items. The copy of “b.md” that the move left in Inbox is still there.");
});

test("a ⌘Z step keeps its place only while work is going on; anything else is said once and the step ends", async () => {
  const documents: FileManagerPlace = { kind: "standard", id: "documents" };
  assert.equal(isBusyRefusal(Object.assign(new Error("busy"), { status: 409, code: "busy" })), true);
  assert.equal(isBusyRefusal(Object.assign(new Error("is a Connected Folder"), { status: 409 })), false, "another refusal will not go away by waiting");
  assert.equal(isBusyRefusal(Object.assign(new Error("gone"), { status: 404, code: "busy" })), false);
  assert.equal(isBusyRefusal(new Error("ENOENT: no such file or directory, lstat '/Users/ana/Documents/a.md'")), false);
  // The disk's own words never reach the person.
  assert.equal(plainReason(new Error("ENOENT: no such file or directory, lstat '/Users/ana/Documents/a.md'")), "The disk would not change “a.md”.");
  assert.equal(plainReason(new Error("AmpleFile could not remove it: EPERM: operation not permitted, unlink '/x/y/locked.txt'. It stays.")), "AmpleFile could not remove it: the disk would not change “locked.txt”. It stays.");
  assert.equal(plainReason(new Error("“a.md” isn’t there anymore.")), "“a.md” isn’t there anymore.");
  assert.equal(plainReason(null), "It could not be done.");

  const items = movedItems([
    { from: "Docs/a.md", to: "a.md", fromPlace: documents },
    { from: "Pics/b.jpg", to: "b.jpg", fromPlace: documents },
    { from: "Pics/c.jpg", to: "c.jpg", fromPlace: documents },
  ], lab);
  const restored: string[] = [];
  let calls = 0;
  const host: MoveBackHost = {
    transfer: async (body) => {
      calls += 1;
      // The first folder's request fails for good, as when the disk it was on is gone.
      if (body.target.path === "Docs") throw Object.assign(new Error("ENOENT: no such file or directory, mkdir '/Volumes/Gone/Docs'"), { status: 500 });
      // In the second, one item was renamed away since the move.
      return { moves: [{ from: "b.jpg", to: "Pics/b.jpg", fromPlace: lab }], missing: [{ place: lab, path: "c.jpg" }] };
    },
    restore: async (point) => { restored.push(point.checkpointId); },
    copiesChanged: async () => [],
    nameOf: placeName,
  };
  const outcome = await movesUndo("Move 3 items", { items, restores: [{ connectedFolderId: "lab", checkpointId: "before" }], redoable: true, copies: [], leftCopies: null }, host).run();
  assert.ok(isPartialUndo(outcome), "it answers instead of failing, so the step leaves the stack");
  assert.equal(calls, 2, "the folder after the one that failed was still asked");
  assert.match(outcome.said, /^Undid part of Move 3 items\./);
  assert.match(outcome.said, /“a\.md” was not put back and is still in Lab\. The disk would not change “Docs”\./);
  assert.match(outcome.said, /“c\.jpg” was not put back: it is no longer in Lab\./);
  assert.doesNotMatch(outcome.said, /ENOENT|\/Volumes/);
  assert.deepEqual(restored, []);

  // A copy in both places is looked at before a restore point takes it away.
  const copies = [{ original: { place: documents, path: "Docs/k.md" }, copy: { place: lab, path: "k.md" } }];
  const moved = { ...host, transfer: async (): Promise<MoveBackAnswer> => ({ moves: [{ from: "a.md", to: "Docs/a.md", fromPlace: lab }] }) };
  const planWith = { items: items.slice(0, 1), restores: [{ connectedFolderId: "lab", checkpointId: "before" }], redoable: true, copies, leftCopies: null };
  const changed = await movesUndo("Move 2 items", planWith, { ...moved, copiesChanged: async () => [0] }).run();
  assert.ok(isPartialUndo(changed));
  assert.equal(changed.said, "Undid Move 2 items. “k.md” in Lab, or the original it was copied from, changed since the move, so nothing in Lab was taken away; its History has the restore point from before the move.");
  assert.deepEqual(restored, [], "the restore point was not run");
  const unknown = await movesUndo("Move 2 items", planWith, { ...moved, copiesChanged: async () => { throw new Error("offline"); } }).run();
  assert.ok(isPartialUndo(unknown), "a check that cannot be made is not a yes");
  const same = await movesUndo("Move 2 items", planWith, moved).run();
  assert.ok(same && !isPartialUndo(same));
  assert.deepEqual(restored, ["before"]);

  // A restore point that cannot be run is said, and the step ends; one refused because work is going on keeps the step.
  const failing = await movesUndo("Move a.md", { ...planWith, copies: [] }, { ...moved, restore: async () => { throw Object.assign(new Error("EACCES: permission denied, unlink '/x/Lab/locked/c.txt'"), { status: 500 }); } }).run();
  assert.ok(isPartialUndo(failing));
  assert.equal(failing.said, "Undid Move a.md. Lab could not be put back as it was before the move. The disk would not change “c.txt”. Its History has the restore point from before the move.");
  await assert.rejects(movesUndo("Move a.md", { ...planWith, copies: [] }, { ...moved, restore: async () => { throw Object.assign(new Error("Finish or stop Lab’s outstanding work before deleting."), { status: 409, code: "busy" }); } }).run(), /outstanding work/);
});
