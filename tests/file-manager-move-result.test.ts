import assert from "node:assert/strict";
import test from "node:test";
import { moveResultMessage, moveShortfall } from "../web-local/src/components/file-manager/move-result.js";

test("a move that carried everything says Moved, as before", () => {
  assert.deepEqual(moveResultMessage("2 items", "Archive", { mode: "move", written: ["a", "b"] }), { text: "Moved 2 items to Archive", tone: "success" });
});

test("a move says plainly what was not moved, not removed, or went to Recently Deleted", () => {
  const partial = moveResultMessage("3 items", "Archive", {
    failed: [{ path: "Notes/big.mov", error: "Disk full" }],
    notRemoved: [{ name: "draft.md" }, "Notes/other.md"],
    recentlyDeleted: [{ path: "Notes/huge.iso" }],
  });
  assert.equal(partial.tone, "info");
  assert.equal(partial.text, "Moved what it could of 3 items to Archive. 1 item was not moved: big.mov. 2 items were copied but not removed from where they were: draft.md, other.md. What History could not keep from the original place is in Recently Deleted: huge.iso.");
  const parked = moveResultMessage("a.md", "Archive", { recentlyDeleted: { entryId: "x", restoreBy: "2026-10-01", uncoveredCount: 2 } });
  assert.deepEqual(parked, { text: "Moved a.md to Archive. What History could not keep from the original place is in Recently Deleted.", tone: "success" });
});

test("unknown or malformed shortfall fields are read defensively", () => {
  assert.deepEqual(moveShortfall(null), { failed: 0, notRemoved: 0, recentlyDeleted: 0 });
  assert.deepEqual(moveShortfall({ failed: { path: "a/b.txt", error: "x" }, notRemoved: [1, 2], recentlyDeleted: null }), { failed: ["b.txt"], notRemoved: 2, recentlyDeleted: 0 });
  assert.deepEqual(moveShortfall({ failed: [], notRemoved: false, recentlyDeleted: "weird" }), { failed: [], notRemoved: 0, recentlyDeleted: ["weird"] });
  const many = moveResultMessage("6 items", "Archive", { failed: ["a", "b", "c", "d", "e"] });
  assert.match(many.text, /5 items were not moved: a, b, c and 2 more\./);
});
