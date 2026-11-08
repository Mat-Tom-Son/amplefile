import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteFolderConfirm,
  recentlyDeletedSettings,
} from "../web-local/src/ui-contract.js";

test("Recently deleted says what is waiting, how long, and what AmpleFile never erases", () => {
  // Settings → Recently deleted (docs/receipts-not-gates.md, F20):
  // nothing AmpleFile destroys is gone at the moment it happens, and the copy
  // names the retention window and the clean-break rule instead of implying
  // permanence either way.
  assert.equal(recentlyDeletedSettings.heading, "Recently Deleted");
  assert.equal(recentlyDeletedSettings.restore, "Restore");
  assert.equal(recentlyDeletedSettings.saveCopy, "Save a Copy");
  assert.equal(recentlyDeletedSettings.deleteNow, "Delete Now");
  // Deleting a plain folder in Files says "Folder", not "Connected Folder".
  assert.equal(deleteFolderConfirm.confirmLabel, "Delete Folder");
  assert.match(recentlyDeletedSettings.deleteNowConfirm, /cannot be brought back/i);
  assert.match(recentlyDeletedSettings.retentionLabel, /^Keep Deleted Items For$/);
  assert.match(recentlyDeletedSettings.heldNote, /legacy Workspace records/i);
  assert.match(recentlyDeletedSettings.heldNote, /cannot be deleted/i);
  assert.match(recentlyDeletedSettings.damagedNote, /could not be read/i);
});

test("person-facing fold copy promises receipts and undo, never a gate", () => {
  // docs/receipts-not-gates.md: no surface offers an authority mode, a
  // policy, or a decision card.
  const copy = JSON.stringify({ recentlyDeletedSettings });
  assert.doesNotMatch(copy, /staged|approv|polic|Reviewed|Unrestricted|needs-you card|decision card|consecrat/i);
  assert.doesNotMatch(JSON.stringify(recentlyDeletedSettings), /\bmode\b|\bcard\b|sandbox|digest|recently-deleted/i);
});
