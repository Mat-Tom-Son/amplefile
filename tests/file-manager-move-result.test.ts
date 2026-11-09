import assert from "node:assert/strict";
import test from "node:test";
import { moveResultMessage, moveShortfall } from "../web-local/src/components/file-manager/move-result.js";

test("a move that carried everything says Moved, as before", () => {
  assert.deepEqual(moveResultMessage("2 items", "Archive", "Inbox", { mode: "move", written: ["a", "b"] }), { text: "Moved 2 items to Archive", tone: "success" });
});

test("a move that stopped removing says everything is in the target, what is also still in the source, and why", () => {
  // The file-transfer answer exactly: the failed item is in the target and is
  // the first entry of notRemoved; it is a reason, not a second count.
  const answer = {
    mode: "move",
    written: ["Archive/a.md", "Archive/b.md", "Archive/c.md"],
    failed: { path: "Notes/b.md", error: "Operation not permitted" },
    notRemoved: ["Notes/b.md", "Notes/c.md"],
    recentlyDeleted: [{ path: "Notes/a.md", entryId: "rd-1", restoreBy: "2026-12-09T12:00:00.000Z" }],
  };
  const message = moveResultMessage("3 items", "Archive", "Inbox", answer);
  assert.equal(message.tone, "info");
  assert.equal(message.text, "Copied 3 items to Archive, but 2 items are also still in Inbox: b.md, c.md. Removing b.md failed: Operation not permitted. What History could not keep from Inbox is in Recently Deleted: a.md.");
  assert.doesNotMatch(message.text, /not moved/);
});

test("a complete move whose originals History could not keep says where they went", () => {
  const message = moveResultMessage("a.md", "Archive", "Inbox", { recentlyDeleted: [{ path: "Notes/a.md", entryId: "rd-1", restoreBy: "2026-12-09T12:00:00.000Z" }] });
  assert.deepEqual(message, { text: "Moved a.md to Archive. What History could not keep from Inbox is in Recently Deleted: a.md.", tone: "success" });
});

test("the shortfall reader takes only the known shape", () => {
  assert.deepEqual(moveShortfall(null), { notRemoved: [], failed: null, recentlyDeleted: [], duplicateIdentities: [] });
  assert.deepEqual(moveShortfall({ failed: [{ path: "a" }], notRemoved: [1, "Notes/x.md"], recentlyDeleted: [{ path: "a" }, "b"], duplicateIdentities: [2, ""] }), { notRemoved: ["Notes/x.md"], failed: null, recentlyDeleted: [], duplicateIdentities: [] });
  const many = moveResultMessage("6 items", "Archive", "Inbox", { notRemoved: ["a", "b", "c", "d", "e"] });
  assert.equal(many.text, "Copied 6 items to Archive, but 5 items are also still in Inbox: a, b, c and 2 more.");
});

test("a release across disks that stopped partway is told once, by its reason", () => {
  // The answer the server gives when Recently Deleted is on another disk and
  // releasing the original stopped partway (tests/file-transfer-api.test.ts).
  const answer = {
    mode: "move",
    written: ["Old"],
    restorePoints: [{ connectedFolderId: "space-0123456789abcdef", checkpointId: "cp-1" }, { connectedFolderId: "space-fedcba9876543210", checkpointId: "cp-2" }],
    recentlyDeleted: [{ path: "Old", entryId: "trash-20261109223000-0a1b2c3d", restoreBy: "2026-12-09T22:30:00.000Z" }],
    failed: { path: "Old", error: "AmpleFile copied Old into Recently Deleted but could not remove all of it from here: EACCES: permission denied, unlink '/Users/x/Source/Old/locked/f.txt'. The whole item is kept in Recently Deleted, and what could not be removed stays here." },
    notRemoved: ["Old"],
  };
  const message = moveResultMessage("Old", "Target", "Source", answer);
  assert.equal(message.tone, "info");
  assert.equal(message.text, "Copied Old to Target, but 1 item is also still in Source: Old. Removing Old failed: AmpleFile copied Old into Recently Deleted but could not remove all of it from here: EACCES: permission denied, unlink '/Users/x/Source/Old/locked/f.txt'. The whole item is kept in Recently Deleted, and what could not be removed stays here.");
  assert.doesNotMatch(message.text, /What History could not keep/);
});

test("an identity the move could not drop from a copy is named", () => {
  // The answer for a read-only item whose copy kept its `.amplefile`.
  const answer = {
    mode: "move",
    written: ["D"],
    restorePoints: [{ connectedFolderId: "space-a46db23548a13406", checkpointId: "cp-20261109223238-03e76132" }, { connectedFolderId: "space-c546a1c3e92eaeb2", checkpointId: "cp-20261109223238-11c84dd3" }],
    failed: { path: "D", error: "AmpleFile could not move D to Recently deleted: AmpleFile could not move /x/source/D into Recently deleted: EACCES: permission denied, rename '/x/source/D' -> '/x/state/recently-deleted/entries/trash-20261109223238-27eabc05/payload/D'. Nothing was moved. Nothing was deleted." },
    notRemoved: ["D"],
    duplicateIdentities: ["D/.amplefile"],
  };
  const message = moveResultMessage("D", "Target", "Source", answer);
  assert.equal(message.tone, "info");
  assert.equal(message.text, "Copied D to Target, but 1 item is also still in Source: D. Removing D failed: AmpleFile could not move D to Recently deleted: AmpleFile could not move /x/source/D into Recently deleted: EACCES: permission denied, rename '/x/source/D' -> '/x/state/recently-deleted/entries/trash-20261109223238-27eabc05/payload/D'. Nothing was moved. Nothing was deleted. AmpleFile could not remove the Connected Folder identity from the copy in Target (D), so it is also still in Source. Connect only one of them.");
});
