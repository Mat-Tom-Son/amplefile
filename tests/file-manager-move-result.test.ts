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
  assert.deepEqual(moveShortfall(null), { notRemoved: [], failed: null, recentlyDeleted: [] });
  assert.deepEqual(moveShortfall({ failed: [{ path: "a" }], notRemoved: [1, "Notes/x.md"], recentlyDeleted: [{ path: "a" }, "b"] }), { notRemoved: ["Notes/x.md"], failed: null, recentlyDeleted: [] });
  const many = moveResultMessage("6 items", "Archive", "Inbox", { notRemoved: ["a", "b", "c", "d", "e"] });
  assert.equal(many.text, "Copied 6 items to Archive, but 5 items are also still in Inbox: a, b, c and 2 more.");
});
