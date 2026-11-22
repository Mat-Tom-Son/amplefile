import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { setFileOperationBoundaryHookForTests, type FileOperationBoundary, type FileOperationProgress } from "../src/local/file-operations.js";
import { setFileCopyStrategyForTests } from "../src/local/file-transfer.js";
import { startLocalApi } from "../src/local/server.js";

/**
 * Progress, cancel, and Extract over the local API's file-transfer routes
 * (src/local/file-operations.ts, src/local/api/place-routes.ts).
 */

type Api = Awaited<ReturnType<typeof startLocalApi>>;
type Call = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: Record<string, any> | null }>;

async function sandboxApi(t: test.TestContext): Promise<{ api: Api; call: Call; sandbox: string }> {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-file-operations-api-"));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => { await api.close(); await rm(sandbox, { recursive: true, force: true }); });
  const call: Call = async (path, init = {}) => {
    const response = await fetch(`${api.origin}${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };
  return { api, call, sandbox };
}

async function connectedFolder(call: Call, name: string): Promise<{ id: string; connectedFolderRoot: string }> {
  const created = await call("/api/connected-folders", { method: "POST", body: { name } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body!.connectedFolder;
}

/**
 * At a boundary that `when` picks, once: asks the API to cancel the
 * operation, so the cancel route itself is what stops it.
 */
function cancelAt(t: test.TestContext, call: Call, when: (point: FileOperationBoundary, progress: FileOperationProgress) => boolean): { responses: Array<Record<string, any> | null> } {
  const responses: Array<Record<string, any> | null> = [];
  let fired = false;
  setFileOperationBoundaryHookForTests(async ({ operationId, point, progress }) => {
    if (fired || !when(point, progress)) return;
    fired = true;
    responses.push((await call("/api/file-transfer/cancel", { method: "POST", body: { operationId } })).body);
  });
  t.after(() => setFileOperationBoundaryHookForTests(null));
  return { responses };
}

async function checkpointIds(call: Call, connectedFolderId: string): Promise<string[]> {
  const listed = await call(`/api/connected-folders/${connectedFolderId}/history/checkpoints`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return (listed.body!.checkpoints as Array<{ checkpointId: string }>).map((checkpoint) => checkpoint.checkpointId);
}

/** Reads the file operation event stream until `until` sees what it waits for. */
async function readEvents(api: Api, until: (events: any[]) => boolean, start: () => Promise<unknown>): Promise<any[]> {
  const controller = new AbortController();
  const response = await fetch(`${api.origin}/api/file-transfer/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const events: any[] = [];
  let buffered = "";
  const decoder = new TextDecoder();
  // The first event lists what is running; only then start the work.
  let started: Promise<unknown> | null = null;
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
      if (!started && events.length) started = start();
    }
    await started;
  } finally {
    controller.abort();
  }
  return events;
}

test("a named copy streams its progress and answers as an unnamed one does", async (t) => {
  const { api, call } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  await mkdir(join(source.connectedFolderRoot, "Trip"));
  for (let index = 0; index < 5; index += 1) await writeFile(join(source.connectedFolderRoot, "Trip", `${index}.txt`), "x".repeat(100));
  const body = (operationId?: string) => ({
    mode: "copy",
    sources: [{ place: { kind: "connected-folder", id: source.id }, path: "Trip" }],
    target: { place: { kind: "connected-folder", id: target.id }, path: "" },
    ...(operationId ? { operationId } : {}),
  });
  let named: Awaited<ReturnType<Call>> | null = null;
  const events = await readEvents(api, (seen) => seen.some((event) => event.type === "finished"), async () => {
    named = await call("/api/file-transfer", { method: "POST", body: body("copy-trip") });
  });
  assert.equal(named!.status, 200, JSON.stringify(named!.body));
  assert.deepEqual(Object.keys(named!.body!).sort(), ["mode", "restorePoints", "written"]);
  assert.deepEqual(named!.body!.written, ["Trip"]);
  assert.deepEqual(events[0], { type: "operations", operations: [] });
  const progress = events.filter((event) => event.type === "progress").map((event) => event.operation);
  assert.ok(progress.length >= 2);
  assert.deepEqual(Object.keys(progress.at(-1)).sort(), ["bytesDone", "bytesTotal", "cancellable", "cancelling", "current", "itemsDone", "itemsTotal", "kind", "operationId", "stage", "startedAt"]);
  assert.ok(progress.some((operation) => operation.stage === "copying"));
  const last = progress.at(-1);
  assert.equal(last.stage, "finishing", "the restore point is kept last");
  assert.equal(last.cancellable, false);
  assert.deepEqual([last.itemsDone, last.itemsTotal, last.bytesDone, last.bytesTotal], [6, 6, 500, 500]);
  assert.deepEqual(events.at(-1), { type: "finished", operationId: "copy-trip", kind: "copy", outcome: "succeeded" });

  const unnamed = await call("/api/file-transfer", { method: "POST", body: body() });
  assert.equal(unnamed.status, 200);
  assert.deepEqual(Object.keys(unnamed.body!).sort(), ["mode", "restorePoints", "written"]);
  assert.deepEqual(unnamed.body!.written, ["Trip copy"]);

  // The window's one event connection can follow the same stream.
  const multiplexed = await fetch(`${api.origin}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscriptions: [{ id: "transfers", path: "/api/file-transfer/events" }] }),
  });
  const reader = multiplexed.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const first = JSON.parse(new TextDecoder().decode(value).split("\n").find((line) => line.startsWith("data: "))!.slice(6));
  assert.deepEqual(first, { subscriptionId: "transfers", event: { type: "operations", operations: [] } });
});

test("operation ids are checked, and a cancel names a running operation", async (t) => {
  const { call } = await sandboxApi(t);
  const target = await connectedFolder(call, "Target");
  const bad = await call("/api/file-transfer", { method: "POST", body: { mode: "copy", sources: [], target: { place: { kind: "connected-folder", id: target.id }, path: "" }, operationId: "not ok!" } });
  assert.equal(bad.status, 400);
  const missing = await call("/api/file-transfer/cancel", { method: "POST", body: { operationId: "nothing-running" } });
  assert.equal(missing.status, 404);
  assert.equal((await call("/api/file-transfer/cancel", { method: "POST", body: {} })).status, 400);
  assert.deepEqual((await call("/api/file-transfer/operations")).body, { operations: [] });
});

test("a copy cancelled between items keeps what finished, with a restore point for it", async (t) => {
  const { call } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  for (const name of ["one.txt", "two.txt", "three.txt"]) await writeFile(join(source.connectedFolderRoot, name), name);
  const cancel = cancelAt(t, call, (point, progress) => point === "item" && progress.stage === "copying" && progress.itemsDone === 1);
  const copied = await call("/api/file-transfer", {
    method: "POST",
    body: {
      mode: "copy",
      operationId: "three",
      sources: ["one.txt", "two.txt", "three.txt"].map((path) => ({ place: { kind: "connected-folder", id: source.id }, path })),
      target: { place: { kind: "connected-folder", id: target.id }, path: "" },
    },
  });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.equal(cancel.responses[0]!.cancelling, true);
  assert.equal(cancel.responses[0]!.operation.operationId, "three");
  assert.equal(copied.body!.cancelled, true);
  assert.deepEqual(copied.body!.written, ["one.txt"]);
  assert.deepEqual(copied.body!.notDone, ["two.txt", "three.txt"]);
  assert.deepEqual((await readdir(target.connectedFolderRoot)).filter((name) => !name.startsWith(".")), ["one.txt"]);
  assert.equal(copied.body!.restorePoints.length, 1);
  const restorePoint = copied.body!.restorePoints[0];
  assert.ok((await checkpointIds(call, target.id)).includes(restorePoint.checkpointId));
  // The restore point takes back what the cancelled copy wrote, and only that.
  const restored = await call(`/api/connected-folders/${target.id}/history/checkpoints/${restorePoint.checkpointId}/restore`, { method: "POST", body: {} });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.ok(!existsSync(join(target.connectedFolderRoot, "one.txt")));
  for (const name of ["one.txt", "two.txt", "three.txt"]) assert.equal(await readFile(join(source.connectedFolderRoot, name), "utf8"), name);
});

test("a copy cancelled inside a file leaves no partial item and no restore point", async (t) => {
  const { call } = await sandboxApi(t);
  setFileCopyStrategyForTests({ clone: false, streamAboveBytes: 1024, chunkBytes: 256 });
  t.after(() => setFileCopyStrategyForTests(null));
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  await mkdir(join(source.connectedFolderRoot, "Footage"));
  await writeFile(join(source.connectedFolderRoot, "Footage", "clip.mov"), Buffer.alloc(8192, 5));
  const before = await checkpointIds(call, target.id);
  cancelAt(t, call, (point, progress) => point === "chunk" && progress.bytesDone >= 2048);
  const copied = await call("/api/file-transfer", {
    method: "POST",
    body: { mode: "copy", operationId: "mid-file", sources: [{ place: { kind: "connected-folder", id: source.id }, path: "Footage" }], target: { place: { kind: "connected-folder", id: target.id }, path: "" } },
  });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.equal(copied.body!.cancelled, true);
  assert.deepEqual(copied.body!.written, []);
  assert.deepEqual(copied.body!.restorePoints, []);
  assert.ok(!existsSync(join(target.connectedFolderRoot, "Footage")), "the half-copied folder is gone");
  assert.deepEqual(await checkpointIds(call, target.id), before, "no restore point for nothing written");
  assert.equal((await readFile(join(source.connectedFolderRoot, "Footage", "clip.mov"))).length, 8192);
});

test("a move between Connected Folders cancelled while copying moves nothing and releases the source", async (t) => {
  const { call } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  for (const name of ["a.txt", "b.txt"]) await writeFile(join(source.connectedFolderRoot, name), name);
  const before = await checkpointIds(call, source.id);
  cancelAt(t, call, (point, progress) => point === "item" && progress.stage === "copying" && progress.itemsDone === 1);
  const body = (operationId: string) => ({
    mode: "move",
    operationId,
    sources: ["a.txt", "b.txt"].map((path) => ({ place: { kind: "connected-folder", id: source.id }, path })),
    target: { place: { kind: "connected-folder", id: target.id }, path: "" },
  });
  const moved = await call("/api/file-transfer", { method: "POST", body: body("move-copying") });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body, { mode: "move", written: [], restorePoints: [], cancelled: true, notDone: ["a.txt", "b.txt"] });
  for (const name of ["a.txt", "b.txt"]) {
    assert.equal(await readFile(join(source.connectedFolderRoot, name), "utf8"), name, "the source survives");
    assert.ok(!existsSync(join(target.connectedFolderRoot, name)), "no copy is left");
  }
  assert.deepEqual(await checkpointIds(call, source.id), before, "the source's restore point went with the move");
  // The source's reservation was released: the same move now goes through.
  setFileOperationBoundaryHookForTests(null);
  const again = await call("/api/file-transfer", { method: "POST", body: body("move-again") });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body!.written, ["a.txt", "b.txt"]);
  assert.equal(again.body!.cancelled, undefined);
});

test("a move between Connected Folders cancelled while removing keeps what moved and nothing twice", async (t) => {
  const { call } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(source.connectedFolderRoot, name), name);
  let removals = 0;
  cancelAt(t, call, (point) => point === "remove" && ++removals === 2);
  const moved = await call("/api/file-transfer", {
    method: "POST",
    body: {
      mode: "move",
      operationId: "move-removing",
      sources: ["a.txt", "b.txt", "c.txt"].map((path) => ({ place: { kind: "connected-folder", id: source.id }, path })),
      target: { place: { kind: "connected-folder", id: target.id }, path: "" },
    },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body!.cancelled, true);
  assert.deepEqual(moved.body!.written, ["a.txt"]);
  assert.deepEqual(moved.body!.notDone, ["b.txt", "c.txt"]);
  assert.ok(!existsSync(join(source.connectedFolderRoot, "a.txt")), "the item that left its source moved");
  assert.equal(await readFile(join(target.connectedFolderRoot, "a.txt"), "utf8"), "a.txt");
  for (const name of ["b.txt", "c.txt"]) {
    assert.equal(await readFile(join(source.connectedFolderRoot, name), "utf8"), name, "the rest stay in the source");
    assert.ok(!existsSync(join(target.connectedFolderRoot, name)), "and their copies are gone");
  }
  const [targetPoint, sourcePoint] = moved.body!.restorePoints as Array<{ connectedFolderId: string; checkpointId: string }>;
  assert.equal(targetPoint!.connectedFolderId, target.id);
  assert.equal(sourcePoint!.connectedFolderId, source.id);
  const targetCheckpoints = await checkpointIds(call, target.id);
  assert.ok(targetCheckpoints.includes(targetPoint!.checkpointId));
  assert.equal(targetCheckpoints.length, 1, "the narrowed restore point replaced the first");
  // Each restore point undoes what happened on its side.
  assert.equal((await call(`/api/connected-folders/${target.id}/history/checkpoints/${targetPoint!.checkpointId}/restore`, { method: "POST", body: {} })).status, 200);
  assert.ok(!existsSync(join(target.connectedFolderRoot, "a.txt")));
  assert.equal((await call(`/api/connected-folders/${source.id}/history/checkpoints/${sourcePoint!.checkpointId}/restore`, { method: "POST", body: {} })).status, 200);
  assert.equal(await readFile(join(source.connectedFolderRoot, "a.txt"), "utf8"), "a.txt");
});

test("Compress cancelled over the API writes nothing", async (t) => {
  const { call } = await sandboxApi(t);
  const folder = await connectedFolder(call, "Folder");
  await writeFile(join(folder.connectedFolderRoot, "video.mov"), Buffer.alloc(2 * 1024 * 1024, 1));
  const before = await checkpointIds(call, folder.id);
  cancelAt(t, call, (point, progress) => point === "chunk" && progress.bytesDone > 200_000);
  const compressed = await call("/api/file-transfer/compress", { method: "POST", body: { place: { kind: "connected-folder", id: folder.id }, paths: ["video.mov"], operationId: "zip-it" } });
  assert.equal(compressed.status, 200, JSON.stringify(compressed.body));
  assert.deepEqual(compressed.body, { path: null, restorePoints: [], cancelled: true });
  assert.deepEqual((await readdir(folder.connectedFolderRoot)).filter((name) => name !== ".amplefile"), ["video.mov"]);
  assert.deepEqual(await checkpointIds(call, folder.id), before);
  setFileOperationBoundaryHookForTests(null);
  const whole = await call("/api/file-transfer/compress", { method: "POST", body: { place: { kind: "connected-folder", id: folder.id }, paths: ["video.mov"] } });
  assert.equal(whole.status, 201);
  assert.deepEqual(Object.keys(whole.body!).sort(), ["path", "restorePoints"], "an unnamed Compress answers as before");
});

test("Extract makes a folder beside the archive with a restore point, and a cancel or refusal leaves nothing", async (t) => {
  const { call } = await sandboxApi(t);
  const folder = await connectedFolder(call, "Folder");
  const zip = new JSZip();
  zip.file("Trip/plan.md", "plan");
  zip.file("Trip/photo.jpg", Buffer.alloc(300_000, 2), { binary: true });
  zip.file(".amplefile/connected-folder.json", "{\"id\":\"space-0123456789abcdef\"}");
  await mkdir(join(folder.connectedFolderRoot, "Downloads"));
  await writeFile(join(folder.connectedFolderRoot, "Downloads", "Trip.zip"), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const place = { kind: "connected-folder", id: folder.id };

  const extracted = await call("/api/file-transfer/extract", { method: "POST", body: { place, path: "Downloads/Trip.zip" } });
  assert.equal(extracted.status, 201, JSON.stringify(extracted.body));
  assert.equal(extracted.body!.path, "Downloads/Trip");
  assert.equal(extracted.body!.files, 2);
  assert.deepEqual(extracted.body!.skipped, [{ path: ".amplefile/connected-folder.json", reason: "configuration" }]);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Downloads", "Trip", "plan.md"), "utf8"), "plan");
  assert.ok(!existsSync(join(folder.connectedFolderRoot, "Downloads", "Trip", ".amplefile")));
  assert.equal(extracted.body!.restorePoints.length, 1);
  assert.ok((await checkpointIds(call, folder.id)).includes(extracted.body!.restorePoints[0].checkpointId));

  const before = await checkpointIds(call, folder.id);
  cancelAt(t, call, (point, progress) => point === "chunk" && progress.stage === "extracting");
  const cancelled = await call("/api/file-transfer/extract", { method: "POST", body: { place, path: "Downloads/Trip.zip", operationId: "unzip" } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual(cancelled.body, { path: null, restorePoints: [], cancelled: true });
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "Downloads"))).sort(), ["Trip", "Trip.zip"], "no second folder and no working folder");
  assert.deepEqual(await checkpointIds(call, folder.id), before);

  setFileOperationBoundaryHookForTests(null);
  const hostile = new JSZip();
  hostile.file("zz/escape.txt", "evil");
  const bytes = await hostile.generateAsync({ type: "nodebuffer" });
  for (let at = bytes.indexOf("zz/escape"); at >= 0; at = bytes.indexOf("zz/escape", at + 1)) bytes.write("../escape", at);
  await writeFile(join(folder.connectedFolderRoot, "Downloads", "bad.zip"), bytes);
  const refused = await call("/api/file-transfer/extract", { method: "POST", body: { place, path: "Downloads/bad.zip", operationId: "bad" } });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body!.error, /outside its folder/);
  assert.ok(!existsSync(join(folder.connectedFolderRoot, "escape.txt")));
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "Downloads"))).sort(), ["Trip", "Trip.zip", "bad.zip"]);
  assert.equal((await call("/api/file-transfer/extract", { method: "POST", body: { place, path: "Downloads" } })).status, 400, "a folder is not an archive");
});
