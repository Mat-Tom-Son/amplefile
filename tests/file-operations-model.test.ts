import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOperationEvent,
  canStop,
  conflictChoices,
  conflictItemLine,
  conflictPolicy,
  copiesLeftMessage,
  nextOperationReveal,
  operationDetail,
  operationFraction,
  operationShowAfterMs,
  operationTitle,
  remainingConflicts,
  replacedMessage,
  stoppedMessage,
  undoCovers,
  visibleOperations,
  type FileOperationProgress,
  type WindowOperation,
} from "../web-local/src/components/file-manager/file-operations-model.js";
import type { TransferConflict } from "../src/shared/file-transfer.js";

function operation(id: string, startedAt: number, progress: Partial<FileOperationProgress> | null = null): WindowOperation {
  return {
    id,
    kind: "copy",
    title: operationTitle("copy", "3 items", "Documents"),
    startedAt,
    progress: progress ? {
      operationId: id,
      kind: "copy",
      stage: "copying",
      itemsDone: 0,
      itemsTotal: null,
      bytesDone: 0,
      bytesTotal: null,
      current: null,
      cancellable: true,
      cancelling: false,
      startedAt: new Date(startedAt).toISOString(),
      ...progress,
    } : null,
    stopping: false,
  };
}

test("a quick operation never shows; a long one shows after the threshold, oldest first", () => {
  const ops = [operation("b", 1_000), operation("a", 500)];
  assert.deepEqual(visibleOperations(ops, 1_000 + operationShowAfterMs - 1).map((item) => item.id), ["a"]);
  assert.deepEqual(visibleOperations(ops, 1_000 + operationShowAfterMs).map((item) => item.id), ["a", "b"]);
  assert.equal(nextOperationReveal(ops, 1_000), 100, "the next one to show is the older operation");
  assert.equal(nextOperationReveal([operation("c", 1_000)], 1_000), operationShowAfterMs);
  assert.equal(nextOperationReveal(ops, 5_000), null);
  assert.equal(operationTitle("copy", "3 items", "Documents"), "Copying 3 items to Documents");
  assert.equal(operationTitle("extract", "photos.zip", null), "Extracting photos.zip");
});

test("progress events move only the window's own operations, and a cancel the engine accepted reads as stopping", () => {
  const ops = [operation("mine", 0)];
  const listed = applyOperationEvent(ops, { type: "operations", operations: [{ ...operation("mine", 0, { itemsDone: 2, itemsTotal: 10 }).progress!, operationId: "mine" }, { ...operation("other", 0, {}).progress! }] });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.progress?.itemsDone, 2);
  const moved = applyOperationEvent(listed, { type: "progress", operation: { ...listed[0]!.progress!, itemsDone: 5, bytesDone: 500, bytesTotal: 1_000, current: "report.pdf", cancelling: true } });
  assert.equal(moved[0]!.stopping, true);
  assert.equal(operationFraction(moved[0]!.progress), 0.5, "bytes decide the fraction when there is a byte total");
  assert.equal(applyOperationEvent(moved, { type: "finished", operationId: "mine", kind: "copy", outcome: "cancelled" }), moved, "a finished event leaves removal to the request's answer");
});

test("the detail line says the stage, items and bytes, and the item in hand", () => {
  const running = operation("x", 0, { itemsDone: 12, itemsTotal: 340, bytesDone: 1_200_000_000, bytesTotal: 4_500_000_000, current: "report.pdf" });
  assert.equal(operationDetail(running), "Copying 12 of 340 items · 1.2 GB of 4.5 GB — report.pdf");
  assert.equal(operationDetail(operation("y", 0)), "Waiting to start…");
  assert.equal(operationDetail(operation("z", 0, { stage: "preparing" })), "Preparing…");
  const extracting = { ...operation("e", 0, { kind: "extract", stage: "extracting", bytesDone: 50_000, bytesTotal: 200_000, itemsDone: 7, itemsTotal: null }) };
  assert.equal(operationDetail(extracting), "Extracting 50.0 KB of 200 KB", "Extract counts the archive read, not items");
  assert.equal(operationFraction(operation("u", 0, { itemsTotal: null, bytesTotal: null }).progress), null, "no total, no fraction");
  assert.equal(operationFraction(operation("t", 0, { itemsDone: 1, itemsTotal: 4 }).progress), 0.25, "items decide without a byte total");
  assert.equal(operationFraction(operation("v", 0, { stage: "finishing" }).progress), 1);
  // Stop: offered while it can stop; a quick History move and a finishing step cannot.
  assert.equal(canStop(running), true);
  assert.equal(canStop({ ...running, stopping: true }), false);
  assert.equal(canStop(operation("w", 0, { cancellable: false })), false);
  assert.equal(operationDetail({ ...operation("w", 0, { cancellable: false }), stopping: true }), "Finishing…");
  assert.equal(operationDetail({ ...running, stopping: true }), "Stopping…");
});

test("after Stop the window says what was done and what was not", () => {
  assert.equal(stoppedMessage("copy", { written: ["a", "b", "c"], restorePoints: [], cancelled: true, notDone: ["d", "e"] }), "Stopped. 3 items were copied; 2 items were not.");
  assert.equal(stoppedMessage("copy", { written: [], restorePoints: [], cancelled: true, notDone: ["d"] }), "Stopped. Nothing was copied.");
  assert.equal(stoppedMessage("move", { written: ["a"], restorePoints: [], cancelled: true, notDone: ["b"] }), "Stopped. 1 item was moved; 1 item was not. It stays where it was.");
  assert.equal(stoppedMessage("move", { written: [], restorePoints: [], cancelled: true, notDone: ["a", "b"], leftInTarget: ["Projects/a"] }), "Stopped. Nothing was moved. They stay where they were. 1 copy could not be taken back and is also in the destination: “a”.");
  assert.equal(stoppedMessage("duplicate", { written: ["a copy"], restorePoints: [], cancelled: true, notDone: [] }), "Stopped. 1 item was duplicated.");
  assert.equal(stoppedMessage("compress", { path: null, written: [], restorePoints: [], cancelled: true }), "Stopped. No archive was made.");
  assert.equal(stoppedMessage("extract", { path: null, written: [], restorePoints: [], cancelled: true }), "Stopped. Nothing was extracted.");
  // Empty Trash and Delete Immediately run as a "delete" operation.
  assert.equal(operationTitle("delete", "3 items", null), "Deleting 3 items");
  assert.equal(operationDetail({ ...operation("t", 0, { kind: "delete", stage: "removing", itemsDone: 4, itemsTotal: 10, current: "old.iso" }), kind: "delete" }), "Deleting 4 of 10 items — old.iso");
  assert.equal(stoppedMessage("delete", { written: ["a", "b"], restorePoints: [], cancelled: true, notDone: ["c"] }), "Stopped. 2 items were deleted for good; 1 item is still in the Trash.");
  assert.equal(stoppedMessage("delete", { written: [], restorePoints: [], cancelled: true, notDone: ["c"] }), "Stopped. Nothing was deleted; everything is still in the Trash.");
});

const fileClash: TransferConflict = { key: "notes.txt", name: "notes.txt", source: { kind: "file", sizeBytes: 2_048, modifiedAt: "2026-03-12T14:02:00Z" }, existing: { kind: "file", sizeBytes: 10, modifiedAt: "2026-01-01T09:00:00Z" }, canMerge: false };
const folderClash: TransferConflict = { key: "Projects", name: "Projects", source: { kind: "folder", sizeBytes: null, modifiedAt: "2026-03-12T14:02:00Z" }, existing: { kind: "folder", sizeBytes: 5_000_000, modifiedAt: "2026-01-01T09:00:00Z" }, canMerge: true, insideClashes: 3 };
const mixedClash: TransferConflict = { key: "Plan", name: "Plan", source: { kind: "file", sizeBytes: 1, modifiedAt: "2026-03-12T14:02:00Z" }, existing: { kind: "folder", sizeBytes: null, modifiedAt: "2026-01-01T09:00:00Z" }, canMerge: false };

test("the clash dialog offers Merge only between two folders and describes both items", () => {
  assert.deepEqual(conflictChoices(fileClash), ["keep-both", "skip", "replace"]);
  assert.deepEqual(conflictChoices(folderClash), ["keep-both", "skip", "replace", "merge"]);
  const date = (iso: string) => iso.slice(0, 10);
  assert.equal(conflictItemLine(fileClash.source, date), "A file, 2.0 KB, modified 2026-03-12");
  assert.equal(conflictItemLine(folderClash.source, date), "A folder, modified 2026-03-12", "a folder whose size is not quick to count shows none");
  assert.equal(conflictItemLine({ kind: "link", sizeBytes: 12, modifiedAt: "2026-03-12" }, date), "A link, modified 2026-03-12");
});

test("each answer names its item; Apply to All sets the default for the rest and stops asking", () => {
  const all = [fileClash, folderClash, mixedClash];
  // One by one.
  const oneByOne = [
    { key: "notes.txt", choice: "replace" as const, applyToAll: false },
    { key: "Projects", choice: "merge" as const, applyToAll: false, inside: "skip" as const },
  ];
  assert.deepEqual(remainingConflicts(all, oneByOne).map((item) => item.key), ["Plan"]);
  assert.deepEqual(conflictPolicy(all, [...oneByOne, { key: "Plan", choice: "skip", applyToAll: false }]), {
    items: { "notes.txt": "replace", Projects: "merge", Plan: "skip" },
    insideItems: { Projects: "skip" },
  });
  // Replace for all: the file↔folder clash is left to the engine's default, which keeps both rather than replacing a folder with a file unasked.
  const replaceAll = [{ key: "notes.txt", choice: "replace" as const, applyToAll: true }];
  assert.deepEqual(remainingConflicts(all, replaceAll), []);
  assert.deepEqual(conflictPolicy(all, replaceAll), { apply: "replace", items: { "notes.txt": "replace" } });
  // Keep Both for all, from the first question.
  assert.deepEqual(conflictPolicy(all, [{ key: "notes.txt", choice: "keep-both", applyToAll: true }]), { apply: "keep-both", items: { "notes.txt": "keep-both" } });
  // Each folder merged keeps its own answer about same-named items inside; the first answer is not the others'.
  const otherFolder: TransferConflict = { ...folderClash, key: "Photos", name: "Photos" };
  assert.deepEqual(conflictPolicy([folderClash, otherFolder], [
    { key: "Projects", choice: "merge", applyToAll: false, inside: "keep-both" },
    { key: "Photos", choice: "merge", applyToAll: false, inside: "replace" },
  ]), { items: { Projects: "merge", Photos: "merge" }, insideItems: { Projects: "keep-both", Photos: "replace" } });
  // Merge for all: the answer given with it is every later merged folder's.
  assert.deepEqual(conflictPolicy([folderClash, otherFolder], [{ key: "Projects", choice: "merge", applyToAll: true, inside: "skip" }]), {
    apply: "merge", items: { Projects: "merge" }, inside: "skip", insideItems: { Projects: "skip" },
  });
  // An inside choice counts only for a Merge.
  assert.deepEqual(conflictPolicy([fileClash], [{ key: "notes.txt", choice: "skip", applyToAll: false, inside: "replace" }]), { items: { "notes.txt": "skip" } });
  // Answers for clashes that are not in this question are ignored.
  assert.deepEqual(conflictPolicy([fileClash], [{ key: "elsewhere", choice: "replace", applyToAll: true }]), { items: {} });
});

test("after a Replace the notice says where the old item went, and Undo is honest about the Trash", () => {
  assert.equal(replacedMessage({ written: [], restorePoints: [] }), "");
  assert.equal(
    replacedMessage({ written: [], restorePoints: [], replaced: [{ path: "Docs/notes.txt", recovery: "history" }] }),
    "Replaced “notes.txt”. History keeps the old one: Undo brings it back.",
  );
  assert.equal(
    replacedMessage({ written: [], restorePoints: [], replaced: [{ path: "a", recovery: "trash" }, { path: "b", recovery: "trash" }], skipped: [{ path: "c", reason: "chosen" }] }),
    "Replaced “a”, “b”. The old ones are in the Trash. Skipped 1 item with the same name.",
  );
  assert.equal(
    replacedMessage({ written: [], restorePoints: [], replaced: [{ path: "a", recovery: "gone" }, { path: "big", recovery: "recently-deleted", entryId: "x", restoreBy: "y" }] }),
    "Replaced “big”. What History could not keep of the old one is in Recently Deleted. Replaced “a”. No Trash could take the old one, so it is gone.",
  );
  assert.equal(replacedMessage({ written: [], restorePoints: [], skippedClashes: [{ path: "photos", reason: "chosen" }] }), "Skipped 1 item with the same name.");
  assert.deepEqual(undoCovers({ written: [], restorePoints: [], replaced: [{ path: "a", recovery: "history" }] }), { covered: true, why: null });
  assert.deepEqual(undoCovers({ written: [], restorePoints: [], replaced: [{ path: "a", recovery: "trash" }] }), { covered: false, why: "Undo can’t bring back “a” from the Trash. Put it back from the Trash." });
  assert.equal(undoCovers({ written: [], restorePoints: [], replaced: [{ path: "a", recovery: "gone" }, { path: "b", recovery: "trash" }] }).why, "Undo can’t bring back “a”: no Trash could take it.");
});

test("a move that left only copies in a plain folder says Undo has nothing to put back", () => {
  assert.equal(copiesLeftMessage({ written: [], restorePoints: [] }, "Documents"), null);
  assert.equal(copiesLeftMessage({ written: ["a"], restorePoints: [], moves: [{ from: "a", to: "a" }], notRemoved: ["b"] }, "Documents"), null, "what moved is moved back");
  assert.equal(
    copiesLeftMessage({ written: ["Docs/a.txt"], restorePoints: [], moves: [], notRemoved: ["Docs/a.txt"] }, "Documents"),
    "Undo has nothing to put back: “a.txt” is still where it was. The copy in Documents stays.",
  );
  assert.equal(
    copiesLeftMessage({ written: [], restorePoints: [], notRemoved: ["a", "b"], leftInTarget: ["b", "c"] }, "Desktop"),
    "Undo has nothing to put back: “a”, “b”, “c” are still where they were. The copies in Desktop stay.",
  );
});
