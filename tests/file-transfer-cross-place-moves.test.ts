import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { ampleFileCliBrokerPaths } from "../src/local/cli/broker.js";
import { setFileOperationBoundaryHookForTests, type FileOperationBoundary, type FileOperationProgress } from "../src/local/file-operations.js";
import { setSystemTrashHandler } from "../src/local/move-to-system-trash.js";
import { startLocalApi } from "../src/local/server.js";
import { setCrossPlaceMoveRenameForTests } from "../src/local/api/place-routes.js";
import { isPartialUndo, moveBackPlan, movesUndo, type MoveAnswer, type MoveBackHost } from "../web-local/src/components/file-manager/file-manager-undo.js";

// A test's folders are all on one disk, where a move between places renames
// (tests/file-transfer-rename-moves.test.ts). These tests are about a move
// across disks, which copies and then takes the original away, so they ask
// for that.
setCrossPlaceMoveRenameForTests(false);

/**
 * A move between a Connected Folder and a plain folder is a move
 * (docs/product-model.md, "Finder's file actions", Moves): the items are
 * copied, then each leaves its source under that place's own rules. A
 * Connected Folder source leaves through its delete, with the receipt, the
 * restore point, Recently Deleted, and the refusals a delete has; a plain
 * source is removed once its copy is whole, and never while a Connected
 * Folder owns it. Undo moves the items back.
 */

type Api = Awaited<ReturnType<typeof startLocalApi>>;
type Call = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: Record<string, any> | null }>;
type Place = { kind: "connected-folder" | "standard"; id: string };

async function sandboxApi(t: test.TestContext, options: Partial<Parameters<typeof startLocalApi>[0]> = {}): Promise<{ api: Api; call: Call; sandbox: string }> {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "amplefile-cross-place-moves-")));
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false, ...options });
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

const computer: Place = { kind: "standard", id: "computer" };
/** A folder or file anywhere on disk, as the computer place names it. */
const onDisk = (path: string) => ({ place: computer, path: relative("/", path) });
const inFolder = (folder: { id: string }, path: string) => ({ place: { kind: "connected-folder", id: folder.id } as Place, path });
const transfer = (call: Call, body: unknown) => call("/api/file-transfer", { method: "POST", body });

function atBoundary(t: test.TestContext, when: (point: FileOperationBoundary, progress: FileOperationProgress) => boolean, act: (operationId: string) => Promise<unknown>): void {
  let fired = false;
  setFileOperationBoundaryHookForTests(async ({ operationId, point, progress }) => {
    if (fired || !when(point, progress)) return;
    fired = true;
    await act(operationId);
  });
  t.after(() => setFileOperationBoundaryHookForTests(null));
}

const cancelAt = (t: test.TestContext, call: Call, when: (point: FileOperationBoundary, progress: FileOperationProgress) => boolean) =>
  atBoundary(t, when, (operationId) => call("/api/file-transfer/cancel", { method: "POST", body: { operationId } }));

async function checkpointIds(call: Call, connectedFolderId: string): Promise<string[]> {
  const listed = await call(`/api/connected-folders/${connectedFolderId}/history/checkpoints`);
  return (listed.body!.checkpoints as Array<{ checkpointId: string }>).map((checkpoint) => checkpoint.checkpointId).sort();
}

async function receipts(sandbox: string): Promise<Array<{ requestId: string; command: string; outcome: string; detail?: string; surface?: string }>> {
  const journal = await readFile(join(ampleFileCliBrokerPaths(join(sandbox, "state")).root, "receipts", "act.jsonl"), "utf8").catch(() => "");
  return journal.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const visible = async (path: string) => (await readdir(path)).filter((name) => !name.startsWith(".")).sort();

/** The system Trash for a test: what went there, by content. */
function recordTrash(t: test.TestContext): string[] {
  const trashed: string[] = [];
  setSystemTrashHandler(async (path) => { trashed.push((await lstat(path)).isDirectory() ? `folder ${path}` : await readFile(path, "utf8")); await rm(path, { recursive: true }); });
  t.after(() => setSystemTrashHandler(null));
  return trashed;
}

test("a move out of a Connected Folder into a plain folder copies, then takes each item out through the Connected Folder's delete", async (t) => {
  const { api, call, sandbox } = await sandboxApi(t);
  const trashed = recordTrash(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  await mkdir(join(work.connectedFolderRoot, "Reports"));
  await writeFile(join(work.connectedFolderRoot, "notes.md"), "notes");
  await writeFile(join(work.connectedFolderRoot, "Reports", "q1.txt"), "q1");

  const moved = await transfer(call, { mode: "move", sources: [inFolder(work, "notes.md"), inFolder(work, "Reports")], target: onDisk(plain) });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body!.mode, "move");
  assert.equal(moved.body!.copiedInstead, undefined, "the originals do not stay");
  assert.deepEqual(moved.body!.written, [onDisk(join(plain, "notes.md")).path, onDisk(join(plain, "Reports")).path]);
  assert.deepEqual(moved.body!.moves, [
    { from: "notes.md", fromPlace: { kind: "connected-folder", id: work.id }, to: onDisk(join(plain, "notes.md")).path },
    { from: "Reports", fromPlace: { kind: "connected-folder", id: work.id }, to: onDisk(join(plain, "Reports")).path },
  ]);
  assert.deepEqual(await visible(work.connectedFolderRoot), [], "the items left the Connected Folder");
  assert.equal(await readFile(join(plain, "notes.md"), "utf8"), "notes");
  assert.equal(await readFile(join(plain, "Reports", "q1.txt"), "utf8"), "q1");
  assert.deepEqual(trashed, [], "nothing goes to the system Trash");
  assert.equal(moved.body!.recentlyDeleted, undefined, "History kept all of it");

  // Each item leaving is the Connected Folder's delete, journaled before it happens.
  const journal = await receipts(sandbox);
  const removals = journal.filter((receipt) => receipt.command === "files.delete" && receipt.outcome === "ok" && receipt.detail?.includes("moved to a plain folder"));
  assert.equal(removals.length, 2, JSON.stringify(journal));
  for (const removal of removals) {
    assert.equal(removal.surface, "main-window");
    assert.ok(journal.some((receipt) => receipt.requestId === removal.requestId && receipt.outcome === "accepted"));
  }

  // One restore point, the Connected Folder's: a plain folder has no History.
  assert.deepEqual(moved.body!.restorePoints.map((point: any) => point.connectedFolderId), [work.id]);
  const restored = await call(`/api/connected-folders/${work.id}/history/checkpoints/${moved.body!.restorePoints[0].checkpointId}/restore`, { method: "POST", body: {} });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(await readFile(join(work.connectedFolderRoot, "notes.md"), "utf8"), "notes", "History kept what left");
  assert.equal(await readFile(join(work.connectedFolderRoot, "Reports", "q1.txt"), "utf8"), "q1");
  assert.deepEqual((await api.recentlyDeleted.list()).entries, []);
});

test("what History could not keep leaves a Connected Folder for a plain folder through Recently Deleted, and a carried identity stays whole", async (t) => {
  const { api, call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  // A disconnected Connected Folder inside: its identity and Chats travel with a move.
  const old = join(work.connectedFolderRoot, "Old");
  await mkdir(join(old, ".amplefile", "conversations"), { recursive: true });
  await writeFile(join(old, ".amplefile", "connected-folder.json"), JSON.stringify({ id: "space-0123456789abcdef" }));
  await writeFile(join(old, ".amplefile", "conversations", "chat.jsonl"), "{\"role\":\"user\"}\n");
  await writeFile(join(old, "kept.txt"), "kept");
  // A link: History keeps no copy of one, and the copy carries it.
  await writeFile(join(work.connectedFolderRoot, "target.txt"), "target");
  await symlink("target.txt", join(work.connectedFolderRoot, "link.txt"));

  const moved = await transfer(call, { mode: "move", sources: [inFolder(work, "Old"), inFolder(work, "link.txt")], target: onDisk(plain) });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body!.failed, undefined);
  assert.ok(!existsSync(old), "the folder left the Connected Folder");
  assert.equal(await readFile(join(plain, "Old", ".amplefile", "conversations", "chat.jsonl"), "utf8"), "{\"role\":\"user\"}\n", "the move carried its Chats");
  assert.ok((await lstat(join(plain, "link.txt"))).isSymbolicLink(), "a link moves as a link");
  assert.ok(!existsSync(join(work.connectedFolderRoot, "link.txt")));
  // The identity never leaves by being erased: the whole folder waits in Recently Deleted too.
  assert.deepEqual(moved.body!.recentlyDeleted.map((item: any) => item.path), ["Old"]);
  const entries = (await api.recentlyDeleted.list()).entries;
  assert.equal(entries.length, 1, "the link's copy holds it, so only the identity is parked");
  assert.equal(entries[0]!.connectedFolderId, work.id);
});

test("a move out of a Connected Folder into a plain folder refuses, before copying anything, for the Connected Folder itself and for a nested Connected Folder", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const sourceRoot = join(sandbox, "source");
  await mkdir(join(sourceRoot, "Projects", "Child"), { recursive: true });
  await writeFile(join(sourceRoot, "Projects", "Child", "child.txt"), "child");
  await writeFile(join(sourceRoot, "Projects", "plain.txt"), "plain");
  const source = (await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: sourceRoot } })).body!.connectedFolder;
  assert.equal((await call(`/api/connected-folders/${source.id}/nested-folders`, { method: "POST", body: { path: "Projects/Child" } })).status, 201);
  const plain = join(sandbox, "Plain");
  await mkdir(plain);

  for (const path of ["Projects", "Projects/Child", "Projects/Child/child.txt"]) {
    const refused = await transfer(call, { mode: "move", sources: [inFolder(source, path)], target: onDisk(plain) });
    assert.equal(refused.status, 409, `${path}: ${JSON.stringify(refused.body)}`);
    assert.deepEqual(await readdir(plain), [], "nothing was copied");
    assert.equal(await readFile(join(sourceRoot, "Projects", "Child", "child.txt"), "utf8"), "child");
  }
  const root = await transfer(call, { mode: "move", sources: [inFolder(source, ".")], target: onDisk(plain) });
  assert.equal(root.status, 400, JSON.stringify(root.body));
  assert.match(root.body!.error, /Choose the items inside it/);
  assert.deepEqual(await readdir(plain), []);

  // What the nested Connected Folder does not own moves as usual.
  const moved = await transfer(call, { mode: "move", sources: [inFolder(source, "Projects/plain.txt")], target: onDisk(plain) });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(await readFile(join(plain, "plain.txt"), "utf8"), "plain");
  assert.ok(!existsSync(join(sourceRoot, "Projects", "plain.txt")));
});

test("a move out of a Connected Folder into a plain folder waits for that Connected Folder's outstanding work, as a delete does", async (t) => {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "amplefile-cross-place-busy-")));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  const released = join(sandbox, "released");
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `import { existsSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("hold", {
    description: "Hold a test turn",
    handler: async () => { while (!existsSync(${JSON.stringify(released)})) await new Promise((resolve) => setTimeout(resolve, 25)); },
  });
}\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
  });
  t.after(async () => {
    await writeFile(released, "").catch(() => undefined);
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const call: Call = async (path, init = {}) => {
    const response = await fetch(`${api.origin}${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };
  const source = (await api.actFacade.createConnectedFolder({ name: "Busy source" })).connectedFolder;
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  await writeFile(join(source.connectedFolderRoot, "notes.md"), "notes");
  const sent = await api.actFacade.sendMessage({ connectedFolder: source.id, newConversation: true, content: "/hold" });
  const status = () => api.actFacade.conversationStatus({ connectedFolder: source.id, conversationId: sent.conversationId });
  await waitFor(async () => (await status()).state === "running");
  const body = { mode: "move", sources: [inFolder(source, "notes.md")], target: onDisk(plain) };

  const busy = await transfer(call, body);
  assert.equal(busy.status, 409, JSON.stringify(busy.body));
  assert.match(busy.body!.error, /outstanding work/);
  assert.equal(busy.body!.code, "busy", "the one refusal that says the same request can succeed later");
  assert.deepEqual(await readdir(plain), [], "nothing was copied");
  assert.ok(existsSync(join(source.connectedFolderRoot, "notes.md")));

  // The same items the other way: a plain folder has no work to wait for,
  // but putting them back by replacing waits for the Connected Folder's.
  await writeFile(join(plain, "notes.md"), "newer notes");
  const replacing = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "notes.md"))], target: inFolder(source, ""), conflicts: { apply: "replace" } });
  assert.equal(replacing.status, 409, JSON.stringify(replacing.body));
  assert.equal(await readFile(join(plain, "notes.md"), "utf8"), "newer notes", "the original stays");
  assert.equal(await readFile(join(source.connectedFolderRoot, "notes.md"), "utf8"), "notes", "nothing was replaced");

  await writeFile(released, "");
  await waitFor(async () => (await status()).state !== "running");
  await rm(join(plain, "notes.md"));
  const settled = await transfer(call, body);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(await readFile(join(plain, "notes.md"), "utf8"), "notes");
  assert.ok(!existsSync(join(source.connectedFolderRoot, "notes.md")));
});

test("Stop during a move out of a Connected Folder into a plain folder leaves nothing in two places", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(work.connectedFolderRoot, name), name);
  const before = await checkpointIds(call, work.id);
  const body = (operationId: string) => ({ mode: "move", operationId, sources: ["a.txt", "b.txt", "c.txt"].map((path) => inFolder(work, path)), target: onDisk(plain) });

  cancelAt(t, call, (point, progress) => point === "item" && progress.stage === "copying" && progress.itemsDone === 1);
  const copying = await transfer(call, body("out-copying"));
  assert.equal(copying.status, 200, JSON.stringify(copying.body));
  assert.deepEqual(copying.body, { mode: "move", written: [], moves: [], restorePoints: [], cancelled: true, notDone: ["a.txt", "b.txt", "c.txt"] });
  assert.deepEqual(await readdir(plain), [], "every copy was taken back");
  assert.deepEqual(await visible(work.connectedFolderRoot), ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(await checkpointIds(call, work.id), before, "no restore point for a move that moved nothing");

  let removals = 0;
  setFileOperationBoundaryHookForTests(null);
  cancelAt(t, call, (point) => point === "remove" && ++removals === 2);
  const removing = await transfer(call, body("out-removing"));
  assert.equal(removing.status, 200, JSON.stringify(removing.body));
  assert.equal(removing.body!.cancelled, true);
  assert.deepEqual(removing.body!.written, [onDisk(join(plain, "a.txt")).path]);
  assert.deepEqual(removing.body!.moves.map((move: any) => move.from), ["a.txt"]);
  assert.deepEqual(removing.body!.notDone, ["b.txt", "c.txt"]);
  assert.deepEqual(await readdir(plain), ["a.txt"], "the copies of the rest are gone");
  assert.deepEqual(await visible(work.connectedFolderRoot), ["b.txt", "c.txt"], "the rest stay in the Connected Folder");
  assert.deepEqual(removing.body!.restorePoints.map((point: any) => point.connectedFolderId), [work.id]);
});

test("a move out of a Connected Folder into a plain folder follows the name-clash choices, and what it replaces goes to the Trash", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const trashed = recordTrash(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(join(plain, "Docs"), { recursive: true });
  await mkdir(join(work.connectedFolderRoot, "Docs"));
  for (const name of ["a.txt", "b.txt", "c.txt", "Docs/x.txt"]) {
    await writeFile(join(work.connectedFolderRoot, name), `new ${name}`);
    await writeFile(join(plain, name), `old ${name}`);
  }
  await writeFile(join(work.connectedFolderRoot, "Docs", "y.txt"), "new Docs/y.txt");
  const sources = ["a.txt", "b.txt", "c.txt", "Docs"].map((path) => inFolder(work, path));

  const check = await transfer(call, { mode: "move", sources, target: onDisk(plain), conflicts: { check: true } });
  assert.deepEqual(check.body!.conflicts.map((conflict: any) => [conflict.key, conflict.canMerge, conflict.insideClashes ?? null]), [["a.txt", false, null], ["b.txt", false, null], ["c.txt", false, null], ["Docs", true, 1]]);

  const moved = await transfer(call, {
    mode: "move",
    sources,
    target: onDisk(plain),
    conflicts: { items: { "a.txt": "replace", "b.txt": "skip", "c.txt": "keep-both", Docs: "merge" }, insideItems: { Docs: "replace" } },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(await readFile(join(plain, "a.txt"), "utf8"), "new a.txt");
  assert.equal(await readFile(join(plain, "b.txt"), "utf8"), "old b.txt");
  assert.equal(await readFile(join(work.connectedFolderRoot, "b.txt"), "utf8"), "new b.txt", "a skipped item stays in the Connected Folder");
  assert.equal(await readFile(join(plain, "c copy.txt"), "utf8"), "new c.txt");
  assert.equal(await readFile(join(plain, "Docs", "x.txt"), "utf8"), "new Docs/x.txt");
  assert.equal(await readFile(join(plain, "Docs", "y.txt"), "utf8"), "new Docs/y.txt");
  assert.deepEqual(await visible(work.connectedFolderRoot), ["b.txt"], "the merged folder went once its items had");
  assert.deepEqual(trashed.sort(), ["old Docs/x.txt", "old a.txt"]);
  assert.deepEqual(moved.body!.replaced.map((item: any) => [relative(plain, join("/", item.path)), item.recovery]).sort(), [["Docs/x.txt", "trash"], ["a.txt", "trash"]]);
  assert.deepEqual(moved.body!.skipped.map((item: any) => relative(plain, join("/", item.path))), ["b.txt"]);
  assert.deepEqual(moved.body!.merged.map((path: string) => relative(plain, join("/", path))), ["Docs"]);
  // Every item that moved is named, a merged folder's by each item inside it.
  assert.deepEqual(moved.body!.moves.map((move: any) => [move.from, relative(plain, join("/", move.to))]), [
    ["a.txt", "a.txt"], ["c.txt", "c copy.txt"], ["Docs/x.txt", "Docs/x.txt"], ["Docs/y.txt", "Docs/y.txt"],
  ]);
});

test("a move from a plain folder into a Connected Folder copies under a restore point, then removes each original once its copy is whole", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const trashed = recordTrash(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  // A disconnected Connected Folder moves whole, identity and Chats included.
  await mkdir(join(plain, "Album", ".amplefile", "conversations"), { recursive: true });
  await writeFile(join(plain, "Album", ".amplefile", "connected-folder.json"), JSON.stringify({ id: "space-fedcba9876543210" }));
  await writeFile(join(plain, "Album", ".amplefile", "conversations", "chat.jsonl"), "{\"role\":\"user\"}\n");
  await writeFile(join(plain, "Album", "one.jpg"), "one");
  await symlink("one.jpg", join(plain, "Album", "first.jpg"));
  await writeFile(join(plain, "report.txt"), "report");
  const before = await checkpointIds(call, work.id);

  const moved = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "report.txt")), onDisk(join(plain, "Album"))], target: inFolder(work, "") });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body!.mode, "move");
  assert.equal(moved.body!.copiedInstead, undefined);
  assert.deepEqual(moved.body!.written, ["report.txt", "Album"]);
  assert.deepEqual(moved.body!.moves, [
    { from: onDisk(join(plain, "report.txt")).path, fromPlace: computer, to: "report.txt" },
    { from: onDisk(join(plain, "Album")).path, fromPlace: computer, to: "Album" },
  ]);
  assert.deepEqual(await readdir(plain), [], "the originals are gone from the plain folder");
  assert.deepEqual(trashed, [], "and not to the Trash: they are in the Connected Folder");
  assert.equal(await readFile(join(work.connectedFolderRoot, "report.txt"), "utf8"), "report");
  assert.equal(await readFile(join(work.connectedFolderRoot, "Album", ".amplefile", "conversations", "chat.jsonl"), "utf8"), "{\"role\":\"user\"}\n");
  assert.ok((await lstat(join(work.connectedFolderRoot, "Album", "first.jpg"))).isSymbolicLink());
  assert.equal(moved.body!.failed, undefined);

  // The Connected Folder keeps a restore point for what arrived.
  assert.deepEqual(moved.body!.restorePoints.map((point: any) => point.connectedFolderId), [work.id]);
  assert.equal((await checkpointIds(call, work.id)).length, before.length + 1);
  // Each original leaving is journaled before it goes.
  const journal = await receipts(sandbox);
  const removals = journal.filter((receipt) => receipt.command === "files.move" && receipt.outcome === "ok");
  assert.equal(removals.length, 2, JSON.stringify(journal));
  for (const removal of removals) {
    assert.equal(removal.surface, "main-window");
    assert.match(removal.detail!, new RegExp(`^Connected Folder ${work.id}; moved in from a plain folder; checkpoint ${moved.body!.restorePoints[0].checkpointId}$`));
    assert.ok(journal.some((receipt) => receipt.requestId === removal.requestId && receipt.outcome === "accepted"));
  }
});

test("a plain original a Connected Folder owns never moves, and one that changed or came to be owned stays where it was", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(join(plain, "Holder", "Owned"), { recursive: true });
  await mkdir(join(plain, "Area"));
  await writeFile(join(plain, "Holder", "Owned", "doc.txt"), "owned");
  await writeFile(join(plain, "Area", "draft.txt"), "draft");
  await writeFile(join(plain, "busy.log"), "line 1\n");
  const owned = (await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: join(plain, "Holder", "Owned") } })).body!.connectedFolder;
  assert.ok(owned.id);

  // Named through a plain place, an item a Connected Folder owns, or a folder holding one, is refused before anything is copied.
  for (const path of [join(plain, "Holder", "Owned", "doc.txt"), join(plain, "Holder", "Owned"), join(plain, "Holder")]) {
    const refused = await transfer(call, { mode: "move", sources: [onDisk(path)], target: inFolder(work, "") });
    assert.equal(refused.status, 409, `${path}: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body!.error, /is a Connected Folder/);
    assert.deepEqual(await visible(work.connectedFolderRoot), [], "nothing was copied");
    assert.equal(await readFile(join(plain, "Holder", "Owned", "doc.txt"), "utf8"), "owned");
  }
  // A whole place is not an item.
  const whole = await transfer(call, { mode: "move", sources: [{ place: computer, path: "" }], target: inFolder(work, "") });
  assert.equal(whole.status, 400, JSON.stringify(whole.body));

  // An original written to while it was copied is not the item that was copied: it stays, and the answer says so.
  atBoundary(t, (point) => point === "remove", () => appendFile(join(plain, "busy.log"), "line 2, written during the move\n"));
  const changed = await transfer(call, { mode: "move", operationId: "in-changed", sources: [onDisk(join(plain, "busy.log"))], target: inFolder(work, "") });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.match(changed.body!.failed.error, /changed while it was being copied/);
  assert.deepEqual(changed.body!.notRemoved, [onDisk(join(plain, "busy.log")).path]);
  assert.deepEqual(changed.body!.moves, [], "it did not move");
  assert.equal(await readFile(join(plain, "busy.log"), "utf8"), "line 1\nline 2, written during the move\n", "the original is whole and still there");
  assert.deepEqual(changed.body!.written, ["busy.log"], "the answer names the copy that is also in the Connected Folder");
  assert.equal((await receipts(sandbox)).filter((receipt) => receipt.command === "files.move").length, 0, "no removal was journaled, because none was tried");

  // A folder that became a Connected Folder's while its item was being copied keeps the item.
  setFileOperationBoundaryHookForTests(null);
  atBoundary(t, (point) => point === "remove", () => call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: join(plain, "Area") } }));
  const claimed = await transfer(call, { mode: "move", operationId: "in-claimed", sources: [onDisk(join(plain, "Area", "draft.txt"))], target: inFolder(work, "") });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.match(claimed.body!.failed.error, /is a Connected Folder/);
  assert.equal(await readFile(join(plain, "Area", "draft.txt"), "utf8"), "draft", "the Connected Folder's item was not removed");
  const refusal = (await receipts(sandbox)).filter((receipt) => receipt.command === "files.move");
  assert.deepEqual(refusal.map((receipt) => receipt.outcome), ["accepted", "error"], "the refused removal is journaled as refused");
});

test("Stop during a move from a plain folder into a Connected Folder leaves nothing in two places", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(plain, name), name);
  const before = await checkpointIds(call, work.id);
  const body = (operationId: string) => ({ mode: "move", operationId, sources: ["a.txt", "b.txt", "c.txt"].map((name) => onDisk(join(plain, name))), target: inFolder(work, "") });

  cancelAt(t, call, (point, progress) => point === "item" && progress.stage === "copying" && progress.itemsDone === 1);
  const copying = await transfer(call, body("in-copying"));
  assert.equal(copying.status, 200, JSON.stringify(copying.body));
  assert.deepEqual(copying.body, { mode: "move", written: [], moves: [], restorePoints: [], cancelled: true, notDone: ["a.txt", "b.txt", "c.txt"].map((name) => onDisk(join(plain, name)).path) });
  assert.deepEqual(await visible(work.connectedFolderRoot), [], "every copy was taken back");
  assert.deepEqual((await readdir(plain)).sort(), ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(await checkpointIds(call, work.id), before, "no restore point for a move that moved nothing");

  let removals = 0;
  setFileOperationBoundaryHookForTests(null);
  cancelAt(t, call, (point) => point === "remove" && ++removals === 2);
  const removing = await transfer(call, body("in-removing"));
  assert.equal(removing.status, 200, JSON.stringify(removing.body));
  assert.equal(removing.body!.cancelled, true);
  assert.deepEqual(removing.body!.written, ["a.txt"]);
  assert.deepEqual(removing.body!.notDone, ["b.txt", "c.txt"].map((name) => onDisk(join(plain, name)).path));
  assert.deepEqual(await visible(work.connectedFolderRoot), ["a.txt"], "the copies of the rest are gone");
  assert.deepEqual((await readdir(plain)).sort(), ["b.txt", "c.txt"], "the rest stay in the plain folder");
  // The restore point is narrowed to what moved.
  assert.equal(removing.body!.restorePoints.length, 1);
  assert.deepEqual(await checkpointIds(call, work.id), [...before, removing.body!.restorePoints[0].checkpointId].sort());
});

test("a move from a plain folder into a Connected Folder follows the name-clash choices, and History keeps what it replaces", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const trashed = recordTrash(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  for (const name of ["a.txt", "b.txt"]) {
    await writeFile(join(plain, name), `new ${name}`);
    await writeFile(join(work.connectedFolderRoot, name), `old ${name}`);
  }
  const moved = await transfer(call, {
    mode: "move",
    sources: ["a.txt", "b.txt"].map((name) => onDisk(join(plain, name))),
    target: inFolder(work, ""),
    conflicts: { items: { [onDisk(join(plain, "a.txt")).path]: "replace", [onDisk(join(plain, "b.txt")).path]: "skip" } },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body!.replaced, [{ path: "a.txt", recovery: "history" }]);
  assert.deepEqual(trashed, [], "a Connected Folder's replaced item goes to its History, not the Trash");
  assert.equal(await readFile(join(work.connectedFolderRoot, "a.txt"), "utf8"), "new a.txt");
  assert.deepEqual(await readdir(plain), ["b.txt"], "a skipped item stays in the plain folder");
  assert.equal(await readFile(join(work.connectedFolderRoot, "b.txt"), "utf8"), "old b.txt");
  assert.deepEqual(moved.body!.moves.map((move: any) => move.to), ["a.txt"]);

  // Undo, as the window does it: the item moves back under its name, then the restore point puts back what it replaced.
  const back = await transfer(call, { mode: "move", sources: [{ ...inFolder(work, "a.txt"), name: "a.txt" }], target: { ...onDisk(plain), create: true } });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(await readFile(join(plain, "a.txt"), "utf8"), "new a.txt");
  for (const point of moved.body!.restorePoints) {
    const restored = await call(`/api/connected-folders/${point.connectedFolderId}/history/checkpoints/${point.checkpointId}/restore`, { method: "POST", body: {} });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
  }
  assert.equal(await readFile(join(work.connectedFolderRoot, "a.txt"), "utf8"), "old a.txt", "the replaced item is back");
  assert.equal(await readFile(join(plain, "a.txt"), "utf8"), "new a.txt");
});

test("Undo moves the items back where they were, under the names they had, into folders made again when a merge removed them", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  recordTrash(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(join(plain, "Photos", "Trip"), { recursive: true });
  await mkdir(join(work.connectedFolderRoot, "Photos", "Trip"), { recursive: true });
  await writeFile(join(plain, "Photos", "a.jpg"), "plain a");
  await writeFile(join(plain, "Photos", "Trip", "b.jpg"), "plain b");
  await writeFile(join(work.connectedFolderRoot, "Photos", "a.jpg"), "work a");
  await writeFile(join(work.connectedFolderRoot, "Photos", "kept.jpg"), "kept");

  // Merge the plain folder into the Connected Folder's, keeping both where names clash.
  const key = onDisk(join(plain, "Photos")).path;
  const moved = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "Photos"))], target: inFolder(work, ""), conflicts: { items: { [key]: "merge" }, insideItems: { [key]: "keep-both" } } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(await readdir(plain), [], "the merged folder went once its items had");
  assert.deepEqual((await readdir(join(work.connectedFolderRoot, "Photos"))).sort(), ["Trip", "a copy.jpg", "a.jpg", "kept.jpg"]);
  const moves = moved.body!.moves as Array<{ from: string; fromPlace: Place; to: string }>;
  assert.deepEqual(moves.map((move) => [relative(plain, join("/", move.from)), move.to]), [["Photos/Trip/b.jpg", "Photos/Trip/b.jpg"], ["Photos/a.jpg", "Photos/a copy.jpg"]]);

  // Undo, as the window does it: each item back into the folder it came from, under its own name.
  for (const move of moves) {
    const parent = move.from.slice(0, move.from.lastIndexOf("/"));
    const back = await transfer(call, {
      mode: "move",
      sources: [{ ...inFolder(work, move.to), name: move.from.slice(move.from.lastIndexOf("/") + 1) }],
      target: { place: move.fromPlace, path: parent, create: true },
    });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual(back.body!.moves.map((item: any) => item.to), [move.from]);
  }
  assert.equal(await readFile(join(plain, "Photos", "a.jpg"), "utf8"), "plain a", "back under the name it had");
  assert.equal(await readFile(join(plain, "Photos", "Trip", "b.jpg"), "utf8"), "plain b");
  assert.deepEqual((await readdir(join(work.connectedFolderRoot, "Photos"))).sort(), ["Trip", "a.jpg", "kept.jpg"]);
  assert.equal(await readFile(join(work.connectedFolderRoot, "Photos", "a.jpg"), "utf8"), "work a");

  // A folder made for an Undo is the place's own New Folder: in a Connected Folder its restore point comes after the move's.
  await writeFile(join(plain, "loose.txt"), "loose");
  const made = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "loose.txt"))], target: { ...inFolder(work, "New/Deep"), create: true } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(await readFile(join(work.connectedFolderRoot, "New", "Deep", "loose.txt"), "utf8"), "loose");
  assert.equal(made.body!.restorePoints.length, 2);
  // Nothing is made for a move that is refused, or for a copy.
  const refused = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "missing.txt"))], target: { ...inFolder(work, "Never"), create: true } });
  assert.notEqual(refused.status, 200);
  const copy = await transfer(call, { mode: "copy", sources: [inFolder(work, "New/Deep/loose.txt")], target: { ...inFolder(work, "Never"), create: true } });
  assert.equal(copy.status, 400, JSON.stringify(copy.body));
  assert.ok(!existsSync(join(work.connectedFolderRoot, "Never")));
  // A name is one item's name, never a path or AmpleFile's own folder.
  for (const name of ["../up.txt", "a/b.txt", ".amplefile", ".."]) {
    const named = await transfer(call, { mode: "move", sources: [{ ...inFolder(work, "New/Deep/loose.txt"), name }], target: onDisk(plain) });
    assert.equal(named.status, 400, `${name}: ${JSON.stringify(named.body)}`);
  }
  assert.ok(existsSync(join(work.connectedFolderRoot, "New", "Deep", "loose.txt")));
});

test("⌘Z, as the window runs it, undoes a move either way and ⇧⌘Z does it again", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  recordTrash(t);
  const work = await connectedFolder(call, "Work");
  const workPlace: Place = { kind: "connected-folder", id: work.id };
  const plain = join(sandbox, "Plain");
  await mkdir(join(plain, "Photos"), { recursive: true });
  await mkdir(join(work.connectedFolderRoot, "Photos"));
  await writeFile(join(plain, "Photos", "a.jpg"), "plain a");
  await writeFile(join(plain, "Photos", "only.jpg"), "plain only");
  await writeFile(join(plain, "notes.md"), "plain notes");
  await writeFile(join(work.connectedFolderRoot, "Photos", "a.jpg"), "work a");
  await writeFile(join(work.connectedFolderRoot, "notes.md"), "work notes");
  // The window's own requests: a transfer that fails is an error, as its `api` helper makes it.
  const host: MoveBackHost = {
    transfer: async (body) => {
      const answer = await transfer(call, body);
      if (answer.status !== 200) throw Object.assign(new Error(answer.body?.error ?? `status ${answer.status}`), { status: answer.status, code: answer.body?.code });
      return answer.body as Awaited<ReturnType<MoveBackHost["transfer"]>>;
    },
    copiesChanged: async (copies) => (await call("/api/file-transfer/copies-changed", { method: "POST", body: { copies } })).body!.changed,
    nameOf: (folder) => folder.path || folder.place.id,
    restore: async (point) => {
      const restored = await call(`/api/connected-folders/${point.connectedFolderId}/history/checkpoints/${point.checkpointId}/restore`, { method: "POST", body: {} });
      if (restored.status !== 200) throw new Error(restored.body?.error ?? `status ${restored.status}`);
    },
  };
  const snapshot = async () => ({
    plain: await tree(plain),
    work: await tree(work.connectedFolderRoot),
  });
  const before = await snapshot();

  /** The ⌘Z step the window records for a move's answer. */
  const undoFor = (label: string, answer: Record<string, any>, target: Place, path = "") => {
    const plan = moveBackPlan(answer as MoveAnswer, { place: target, path });
    assert.ok(plan, "a plain folder took part, so the items are moved back");
    const step = movesUndo(label, plan, host);
    // Every step here puts everything back, so none answers with what it could not.
    return { run: async () => { const outcome = await step.run(); assert.ok(!isPartialUndo(outcome), JSON.stringify(outcome)); return outcome; } };
  };

  // Into the Connected Folder: a folder merged keeping both, and a file kept beside the one there.
  const photos = onDisk(join(plain, "Photos")).path;
  const notes = onDisk(join(plain, "notes.md")).path;
  const into = await transfer(call, {
    mode: "move",
    sources: [onDisk(join(plain, "Photos")), onDisk(join(plain, "notes.md"))],
    target: { place: workPlace, path: "" },
    conflicts: { items: { [photos]: "merge", [notes]: "keep-both" }, insideItems: { [photos]: "keep-both" } },
  });
  assert.equal(into.status, 200, JSON.stringify(into.body));
  assert.deepEqual(await tree(plain), [], "everything left the plain folder");
  assert.deepEqual(await tree(work.connectedFolderRoot), ["Photos/", "Photos/a copy.jpg=plain a", "Photos/a.jpg=work a", "Photos/only.jpg=plain only", "notes copy.md=plain notes", "notes.md=work notes"]);
  assert.equal(await undoFor("Move 2 items", into.body!, workPlace).run(), null, "a move that merged folders is not redone");
  assert.deepEqual(await snapshot(), before, "⌘Z puts every item back where it was, under the name it had");

  // A move that merged and replaced nothing is done again by ⇧⌘Z, and undone again by ⌘Z.
  const simple = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "notes.md"))], target: { place: workPlace, path: "Photos" } });
  assert.equal(simple.status, 200, JSON.stringify(simple.body));
  const moved = await snapshot();
  assert.deepEqual(moved.plain, ["Photos/", "Photos/a.jpg=plain a", "Photos/only.jpg=plain only"]);
  const redo = await undoFor("Move notes.md", simple.body!, workPlace).run();
  assert.deepEqual(await snapshot(), before);
  assert.ok(redo);
  const undoAgain = await redo.run();
  assert.deepEqual(await snapshot(), moved, "⇧⌘Z moves it out again");
  assert.ok(undoAgain);
  await undoAgain.run();
  assert.deepEqual(await snapshot(), before);

  // Out of the Connected Folder: ⌘Z brings the item back into it.
  const out = await transfer(call, { mode: "move", sources: [inFolder(work, "notes.md")], target: onDisk(join(plain, "Photos")) });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(await readFile(join(plain, "Photos", "notes.md"), "utf8"), "work notes");
  assert.ok(await undoFor("Move notes.md", out.body!, computer, onDisk(join(plain, "Photos")).path).run());
  assert.deepEqual(await snapshot(), before);

  // A move into the Connected Folder that replaced: the item goes back, then the restore point returns what it replaced.
  const replacing = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "notes.md"))], target: { place: workPlace, path: "" }, conflicts: { items: { [notes]: "replace" } } });
  assert.equal(replacing.status, 200, JSON.stringify(replacing.body));
  assert.equal(await readFile(join(work.connectedFolderRoot, "notes.md"), "utf8"), "plain notes");
  assert.equal(await undoFor("Move notes.md", replacing.body!, workPlace).run(), null, "not redone");
  assert.deepEqual(await snapshot(), before, "the replaced item is back, and the moved one is where it came from");

  // A move between two Connected Folders keeps a restore point on each side, and ⌘Z moves the item back too.
  const other = await connectedFolder(call, "Other");
  const between = await transfer(call, { mode: "move", sources: [inFolder(work, "notes.md")], target: inFolder(other, "") });
  assert.equal(between.status, 200, JSON.stringify(between.body));
  assert.equal(between.body!.restorePoints.length, 2);
  assert.ok(!existsSync(join(work.connectedFolderRoot, "notes.md")));
  assert.ok(await undoFor("Move notes.md", between.body!, { kind: "connected-folder", id: other.id }).run());
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await tree(other.connectedFolderRoot), []);
});

test("items taken from a Connected Folder and a plain folder at once are copied, and the answer says so", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const other = await connectedFolder(call, "Other");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  await writeFile(join(plain, "plain.txt"), "plain");
  await writeFile(join(work.connectedFolderRoot, "work.txt"), "work");
  const mixed = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "plain.txt")), inFolder(work, "work.txt")], target: inFolder(other, "") });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  assert.equal(mixed.body!.copiedInstead, true);
  assert.equal(mixed.body!.mode, "copy");
  assert.ok(existsSync(join(plain, "plain.txt")) && existsSync(join(work.connectedFolderRoot, "work.txt")), "the originals stay");
  assert.deepEqual(await visible(other.connectedFolderRoot), ["plain.txt", "work.txt"]);
});

/** Every visible item under a folder, files with their content, for comparing a folder before and after. */
async function tree(root: string, prefix = ""): Promise<string[]> {
  const listed: string[] = [];
  for (const name of (await readdir(root)).filter((entry) => !entry.startsWith(".")).sort()) {
    const path = join(root, name);
    if ((await lstat(path)).isDirectory()) listed.push(`${prefix}${name}/`, ...await tree(path, `${prefix}${name}/`));
    else listed.push(`${prefix}${name}=${await readFile(path, "utf8")}`);
  }
  return listed;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
