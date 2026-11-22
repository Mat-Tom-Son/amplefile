import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cancelFileOperation,
  fileOperationProgressIntervalMs,
  runFileOperation,
  runningFileOperations,
  setFileOperationBoundaryHookForTests,
  subscribeFileOperations,
  type FileOperationEvent,
} from "../src/local/file-operations.js";
import { compressInto, copyInto, measureCopy, moveInto, setFileCopyStrategyForTests } from "../src/local/file-transfer.js";

/**
 * Progress and cancel for the file manager's long operations
 * (src/local/file-operations.ts), on the file engine itself.
 */

async function folder(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "file-operations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function follow(t: test.TestContext): FileOperationEvent[] {
  const events: FileOperationEvent[] = [];
  const stop = subscribeFileOperations((event) => events.push(event));
  t.after(stop);
  return events;
}

function holdAt(t: test.TestContext, hook: Parameters<typeof setFileOperationBoundaryHookForTests>[0]): void {
  setFileOperationBoundaryHookForTests(hook);
  t.after(() => setFileOperationBoundaryHookForTests(null));
}

/** Copies a file a chunk at a time from 1 KB, never by cloning, so a test can stop inside one. */
function chunkedCopies(t: test.TestContext): void {
  setFileCopyStrategyForTests({ clone: false, streamAboveBytes: 1024, chunkBytes: 256 });
  t.after(() => setFileCopyStrategyForTests(null));
}

test("a named copy reports items and bytes as it goes, at a bounded rate, and says how it ended", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Trip", "Photos"), { recursive: true });
  for (let index = 0; index < 40; index += 1) await writeFile(join(root, "Trip", "Photos", `${index}.jpg`), "x".repeat(1000));
  await mkdir(join(root, "Target"));
  const events = follow(t);
  assert.deepEqual(events[0], { type: "operations", operations: [] }, "the first event lists what is running");

  const destination = await runFileOperation("copy-1", "copy", async (operation) => {
    const measured = await measureCopy(join(root, "Trip"), { operation });
    assert.deepEqual(measured, { items: 42, bytes: 40_000 });
    operation.addTotals(measured.items, measured.bytes);
    operation.stage("copying");
    return copyInto(join(root, "Trip"), join(root, "Target"), { operation });
  });
  assert.equal(destination, join(root, "Target", "Trip"));
  assert.equal((await readdir(join(destination, "Photos"))).length, 40);

  const progress = events.flatMap((event) => event.type === "progress" ? [event.operation] : []);
  assert.ok(progress.length >= 2);
  const last = progress.at(-1)!;
  assert.equal(last.operationId, "copy-1");
  assert.equal(last.kind, "copy");
  assert.equal(last.itemsTotal, 42);
  assert.equal(last.bytesTotal, 40_000);
  for (const [index, event] of progress.entries()) {
    if (index) assert.ok(event.bytesDone >= progress[index - 1]!.bytesDone, "bytes only go up");
  }
  assert.ok(progress.some((event) => event.stage === "copying" && event.current !== null), "the item in hand is named");
  // 42 items and 40 chunks of bytes, sent at most once an interval apart from stage changes.
  assert.ok(progress.length < 20, `progress is throttled (${progress.length} events in ${fileOperationProgressIntervalMs} ms steps)`);
  assert.deepEqual(events.at(-1), { type: "finished", operationId: "copy-1", kind: "copy", outcome: "succeeded" });
  assert.deepEqual(runningFileOperations(), []);
});

test("an operation id is held while it runs, and an unknown or finishing one cannot be cancelled", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const running = runFileOperation("held", "compress", async (operation) => {
    await held;
    operation.stage("finishing");
    assert.deepEqual(cancelFileOperation("held")?.cancelling, false, "a finishing operation runs to its end");
    return "done";
  });
  await assert.rejects(runFileOperation("held", "copy", async () => "second"), (error: Error & { statusCode?: number }) => error.statusCode === 409);
  assert.equal(cancelFileOperation("nobody"), null);
  release();
  assert.equal(await running, "done");
  assert.equal(cancelFileOperation("held"), null, "a finished id is free again");
  t.diagnostic("ids are reusable once finished");
});

test("a cancel inside a file takes the partial copy back and leaves the source as it was", async (t) => {
  const root = await folder(t);
  chunkedCopies(t);
  await mkdir(join(root, "Trip"));
  await writeFile(join(root, "Trip", "a.txt"), "small");
  await writeFile(join(root, "Trip", "z-video.mov"), Buffer.alloc(8192, 7));
  await mkdir(join(root, "Target"));
  await writeFile(join(root, "Target", "kept.txt"), "kept");
  holdAt(t, ({ operationId, point, progress }) => {
    if (point === "chunk" && progress.current === "z-video.mov" && progress.bytesDone > 2048) cancelFileOperation(operationId);
  });
  const events = follow(t);
  await assert.rejects(
    runFileOperation("mid-file", "copy", (operation) => copyInto(join(root, "Trip"), join(root, "Target"), { operation })),
    (error: Error & { cancelled?: boolean }) => error.cancelled === true,
  );
  assert.deepEqual(await readdir(join(root, "Target")), ["kept.txt"], "no half-written folder or file is left");
  assert.equal((await stat(join(root, "Trip", "z-video.mov"))).size, 8192, "the source is whole");
  assert.equal(await readFile(join(root, "Trip", "a.txt"), "utf8"), "small");
  const finished = events.at(-1);
  assert.deepEqual(finished, { type: "finished", operationId: "mid-file", kind: "copy", outcome: "cancelled" });
  assert.ok(events.some((event) => event.type === "progress" && event.operation.cancelling), "the stream shows it stopping");
});

test("a file copied a chunk at a time keeps its contents, mode, and time", async (t) => {
  const root = await folder(t);
  chunkedCopies(t);
  const content = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251));
  await writeFile(join(root, "data.bin"), content, { mode: 0o640 });
  const before = await stat(join(root, "data.bin"));
  await mkdir(join(root, "Target"));
  const copied = await runFileOperation("chunked", "copy", (operation) => copyInto(join(root, "data.bin"), join(root, "Target"), { operation }));
  assert.deepEqual(await readFile(copied), content);
  const after = await stat(copied);
  assert.equal(after.mode & 0o777, 0o640);
  assert.ok(Math.abs(after.mtimeMs - before.mtimeMs) < 2_000);
});

test("a cancel between items keeps what finished and stops before the next", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Target"));
  for (const name of ["one.txt", "two.txt", "three.txt"]) await writeFile(join(root, name), name);
  holdAt(t, ({ operationId, point, progress }) => {
    if (point === "item" && progress.itemsDone === 1) cancelFileOperation(operationId);
  });
  const written: string[] = [];
  await assert.rejects(runFileOperation("between", "copy", async (operation) => {
    operation.stage("copying");
    for (const name of ["one.txt", "two.txt", "three.txt"]) written.push(await copyInto(join(root, name), join(root, "Target"), { operation }));
  }), /Stopped/);
  assert.deepEqual(written, [join(root, "Target", "one.txt")]);
  assert.deepEqual(await readdir(join(root, "Target")), ["one.txt"]);
});

test("a move within one disk is a rename, which is never stopped halfway", async (t) => {
  // Only the copy a move makes across disks has chunks to stop at, and it is
  // the same copy as above.
  const root = await folder(t);
  chunkedCopies(t);
  await writeFile(join(root, "big.bin"), Buffer.alloc(4096, 1));
  await mkdir(join(root, "Target"));
  holdAt(t, ({ operationId, point }) => { if (point === "chunk") cancelFileOperation(operationId); });
  const moved = await runFileOperation("rename", "move", (operation) => moveInto(join(root, "big.bin"), join(root, "Target"), operation));
  assert.equal(moved, join(root, "Target", "big.bin"), "a rename has no chunk to stop at and finishes");
  assert.ok(!existsSync(join(root, "big.bin")));
});

test("a Compress cancelled inside a file leaves no archive and no working file", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Trip"));
  await writeFile(join(root, "Trip", "a.txt"), "a".repeat(100));
  await writeFile(join(root, "Trip", "video.mov"), Buffer.alloc(2 * 1024 * 1024, 3));
  holdAt(t, ({ operationId, point, progress }) => {
    if (point === "chunk" && progress.current === "video.mov" && progress.bytesDone > 300_000) cancelFileOperation(operationId);
  });
  const events = follow(t);
  await assert.rejects(runFileOperation("zip", "compress", (operation) => compressInto([join(root, "Trip")], root, undefined, operation)), /Stopped/);
  assert.deepEqual((await readdir(root)).sort(), ["Trip"], "no archive and no hidden working file");
  const stages = events.flatMap((event) => event.type === "progress" ? [event.operation.stage] : []);
  assert.ok(stages.includes("compressing"));
  const compressing = events.flatMap((event) => event.type === "progress" && event.operation.stage === "compressing" ? [event.operation] : []).at(-1)!;
  assert.equal(compressing.itemsTotal, 3);
  assert.equal(compressing.bytesTotal, 100 + 2 * 1024 * 1024);
  assert.deepEqual(events.at(-1), { type: "finished", operationId: "zip", kind: "compress", outcome: "cancelled" });
});

test("an untracked Compress and copy behave as before", async (t) => {
  const root = await folder(t);
  await writeFile(join(root, "notes.txt"), "notes");
  const events = follow(t);
  const archive = await compressInto([join(root, "notes.txt")], root);
  assert.equal(archive, join(root, "notes.txt.zip"));
  const copy = await copyInto(join(root, "notes.txt"), root, { duplicate: true });
  assert.equal(copy, join(root, "notes copy.txt"));
  assert.deepEqual(events, [{ type: "operations", operations: [] }], "an operation nobody named sends nothing");
});
