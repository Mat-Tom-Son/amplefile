import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ampleFileCliBrokerPaths } from "../src/local/cli/broker.js";
import { setFileOperationBoundaryHookForTests, type FileOperationBoundary } from "../src/local/file-operations.js";
import { setSystemTrashHandler } from "../src/local/move-to-system-trash.js";
import { startLocalApi } from "../src/local/server.js";
import { moveBackPlan, movesUndo, type FileUndo, type MoveAnswer, type MoveBackHost, type PartialUndo } from "../web-local/src/components/file-manager/file-manager-undo.js";

/**
 * What a move between a Connected Folder and a plain folder must never do
 * (docs/product-model.md, "Finder's file actions", Moves): take an item out
 * of its source unless the copy is that item, whole; say an original is
 * still there when part of it is gone; or let ⌘Z take away the only whole
 * copy. Each test is a case that once lost content or misreported it.
 */

type Api = Awaited<ReturnType<typeof startLocalApi>>;
type Call = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: Record<string, any> | null }>;
type Place = { kind: "connected-folder" | "standard"; id: string };

const run = promisify(execFile);

async function sandboxApi(t: test.TestContext): Promise<{ api: Api; call: Call; sandbox: string }> {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "amplefile-move-safety-")));
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

const computer: Place = { kind: "standard", id: "computer" };
/** A folder or file anywhere on disk, as the computer place names it. */
const onDisk = (path: string) => ({ place: computer, path: relative("/", path) });
const inFolder = (folder: { id: string }, path: string) => ({ place: { kind: "connected-folder", id: folder.id } as Place, path });
const transfer = (call: Call, body: unknown) => call("/api/file-transfer", { method: "POST", body });

/** Runs `act` at the `nth` boundary of a kind (the first by default), once. */
function atBoundary(t: test.TestContext, kind: FileOperationBoundary, act: () => Promise<unknown>, nth = 1): void {
  let seen = 0;
  setFileOperationBoundaryHookForTests(async ({ point }) => {
    if (point !== kind) return;
    seen += 1;
    if (seen === nth) await act();
  });
  t.after(() => setFileOperationBoundaryHookForTests(null));
}

async function receipts(sandbox: string): Promise<Array<{ requestId: string; command: string; outcome: string; detail?: string; error?: string }>> {
  const journal = await readFile(join(ampleFileCliBrokerPaths(join(sandbox, "state")).root, "receipts", "act.jsonl"), "utf8").catch(() => "");
  return journal.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

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

/** The window's own requests: a transfer that fails is an error, as its `api` helper makes it. */
function windowHost(call: Call, names: Record<string, string> = {}): MoveBackHost {
  return {
    transfer: async (body) => {
      const answer = await transfer(call, body);
      if (answer.status !== 200) throw new Error(answer.body?.error ?? `status ${answer.status}`);
      return answer.body as Awaited<ReturnType<MoveBackHost["transfer"]>>;
    },
    restore: async (point) => {
      const restored = await call(`/api/connected-folders/${point.connectedFolderId}/history/checkpoints/${point.checkpointId}/restore`, { method: "POST", body: {} });
      if (restored.status !== 200) throw new Error(restored.body?.error ?? `status ${restored.status}`);
    },
    nameOf: (folder) => folder.path ? folder.path.slice(folder.path.lastIndexOf("/") + 1) : names[folder.place.id] ?? folder.place.id,
  };
}

/** The ⌘Z step the window records for a move's answer when a plain folder took part. */
function undoFor(label: string, answer: Record<string, any>, target: { place: Place; path: string }, host: MoveBackHost): FileUndo {
  const plan = moveBackPlan(answer as MoveAnswer, target);
  assert.ok(plan, "a plain folder took part, so the items are moved back");
  return movesUndo(label, plan, host);
}

const partial = (outcome: FileUndo | PartialUndo | null): PartialUndo | null => outcome && "said" in outcome ? outcome : null;

test("a plain original with a folder that cannot be changed stays whole, is said to be in both places, and ⌘Z leaves it whole", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(join(plain, "proj", "locked"), { recursive: true });
  await writeFile(join(plain, "proj", "a.txt"), "a");
  await writeFile(join(plain, "proj", "b.txt"), "b");
  await writeFile(join(plain, "proj", "locked", "c.txt"), "c");
  await chmod(join(plain, "proj", "locked"), 0o555);
  t.after(() => chmod(join(plain, "proj", "locked"), 0o755).catch(() => undefined));
  const before = await tree(join(plain, "proj"));
  try {
    const moved = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "proj"))], target: inFolder(work, "") });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(await tree(join(plain, "proj")), before, "nothing of the original was removed");
    assert.deepEqual(moved.body!.notRemoved, [onDisk(join(plain, "proj")).path], "the original is said to be still there, and it is");
    assert.deepEqual(moved.body!.moves, [], "it did not move");
    assert.match(moved.body!.failed.error, /can’t be changed/);
    assert.deepEqual(moved.body!.failures, [moved.body!.failed]);
    assert.equal(moved.body!.partlyRemoved, undefined);
    assert.deepEqual(await tree(join(work.connectedFolderRoot, "proj")), before, "the copy is whole");
    assert.deepEqual((await receipts(sandbox)).filter((receipt) => receipt.command === "files.move"), [], "no removal was journaled, because none was tried");

    // Nothing moved, so ⌘Z is History's: it takes the copy away, and the original is whole.
    assert.equal(moveBackPlan(moved.body as MoveAnswer, { place: { kind: "connected-folder", id: work.id }, path: "" }), null);
    const restore = () => call(`/api/connected-folders/${work.id}/history/checkpoints/${moved.body!.restorePoints[0].checkpointId}/restore`, { method: "POST", body: {} });
    assert.deepEqual(moved.body!.restorePoints.map((point: any) => point.connectedFolderId), [work.id]);
    // The copy kept its folder's read-only mode, so History cannot take it away until that folder can be changed.
    assert.notEqual((await restore()).status, 200);
    assert.deepEqual(await tree(join(plain, "proj")), before, "⌘Z refused: every file is still in the folder it came from");
    await chmod(join(work.connectedFolderRoot, "proj", "locked"), 0o755);
    const restored = await restore();
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.ok(!existsSync(join(work.connectedFolderRoot, "proj")), "the copy is gone");
    assert.deepEqual(await tree(join(plain, "proj")), before, "after ⌘Z every file is still in the folder it came from");
  } finally {
    await chmod(join(plain, "proj", "locked"), 0o755).catch(() => undefined);
    await chmod(join(work.connectedFolderRoot, "proj", "locked"), 0o755).catch(() => undefined);
  }
});

test("a plain original that only partly goes counts as moved, is said to be partly removed, and ⌘Z never takes away the whole copy", { skip: process.platform !== "darwin" && "needs the Mac's locked flag" }, async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const workPlace: Place = { kind: "connected-folder", id: work.id };
  const plain = join(sandbox, "Plain");
  await mkdir(join(plain, "proj", "sub"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) await writeFile(join(plain, "proj", name), name);
  await writeFile(join(plain, "proj", "sub", "locked.txt"), "locked");
  const before = await tree(join(plain, "proj"));
  const unlock = () => run("chflags", ["-R", "nouchg", plain]).catch(() => undefined);
  t.after(unlock);
  try {
    // Locked once it is copied, as a file in use can become: it cannot be removed, and nothing says so until the removal meets it.
    atBoundary(t, "remove", () => run("chflags", ["uchg", join(plain, "proj", "sub", "locked.txt")]));
    const moved = await transfer(call, { mode: "move", operationId: "partly", sources: [onDisk(join(plain, "proj"))], target: inFolder(work, "") });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(await tree(join(work.connectedFolderRoot, "proj")), before, "the copy is whole");
    const left = await tree(join(plain, "proj"));
    assert.notDeepEqual(left, before, "part of the original went");
    assert.ok(left.includes("sub/locked.txt=locked"), "what could not be removed is still there");
    const path = onDisk(join(plain, "proj")).path;
    assert.deepEqual(moved.body!.moves, [{ from: path, fromPlace: computer, to: "proj" }], "it counts as moved: the whole item is only in the Connected Folder");
    assert.equal(moved.body!.notRemoved, undefined, "it is not said to be still where it was");
    assert.deepEqual(moved.body!.partlyRemoved.map((item: any) => item.path), [path]);
    assert.match(moved.body!.partlyRemoved[0].error, /Part of “proj” could not be removed: “locked.txt” is locked or can’t be changed/);
    assert.deepEqual((await receipts(sandbox)).filter((receipt) => receipt.command === "files.move").map((receipt) => receipt.outcome), ["accepted", "error"], "the removal was journaled first, and is recorded as not completed");

    // ⌘Z moves it back; the name is taken by what is left, so it says so and the whole copy stays where it is.
    const outcome = partial(await undoFor("Move proj", moved.body!, { place: workPlace, path: "" }, windowHost(call, { [work.id]: "Work" })).run());
    assert.ok(outcome, "⌘Z does not claim it undid the move");
    assert.match(outcome.said, /“proj”/);
    assert.match(outcome.said, /Work/);
    assert.doesNotMatch(outcome.said, /^Undid/);
    assert.deepEqual(await tree(join(work.connectedFolderRoot, "proj")), before, "the whole copy is still in the Connected Folder");
    assert.deepEqual(await tree(join(plain, "proj")), left, "and nothing was added beside what is left of the original");
    assert.deepEqual(await readdir(plain), ["proj"], "no “proj copy” was made");
  } finally {
    await unlock();
  }
});

test("a Connected Folder item that changed while it was being copied stays where it was, into a plain folder or another Connected Folder", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const other = await connectedFolder(call, "Other");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  for (const [name, target] of [["ToPlain", onDisk(plain)], ["ToOther", inFolder(other, "")]] as const) {
    const folder = join(work.connectedFolderRoot, name);
    await mkdir(folder);
    await writeFile(join(folder, "a.txt"), "as it was");
    // While the copy is made and before the original goes: one file edited, one added.
    atBoundary(t, "remove", async () => {
      await writeFile(join(folder, "a.txt"), "edited during the move");
      await writeFile(join(folder, "late.txt"), "added during the move");
    });
    const moved = await transfer(call, { mode: "move", operationId: `changed-${name}`, sources: [inFolder(work, name)], target });
    setFileOperationBoundaryHookForTests(null);
    assert.equal(moved.status, 200, `${name}: ${JSON.stringify(moved.body)}`);
    assert.deepEqual(await tree(folder), ["a.txt=edited during the move", "late.txt=added during the move"], `${name}: both writes are still in the Connected Folder`);
    assert.match(moved.body!.failed.error, /changed while it was being copied/, name);
    assert.deepEqual(moved.body!.notRemoved, [name], `${name}: the copy made before the change is also in the target`);
    if (moved.body!.moves) assert.deepEqual(moved.body!.moves, [], `${name}: it did not move`);
    assert.equal((await receipts(sandbox)).filter((receipt) => receipt.command === "files.delete").length, 0, `${name}: no delete was journaled, because none was tried`);
  }
});

test("an item that leaves a Connected Folder whole, for Recently Deleted, takes what was added during the copy with it", async (t) => {
  const { api, call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  // A disconnected Connected Folder inside: History keeps no copy of its identity, so it leaves whole.
  const old = join(work.connectedFolderRoot, "Old");
  await mkdir(join(old, ".amplefile"), { recursive: true });
  await writeFile(join(old, ".amplefile", "connected-folder.json"), JSON.stringify({ id: "space-0123456789abcdef" }));
  await writeFile(join(old, "kept.txt"), "kept");
  atBoundary(t, "remove", () => writeFile(join(old, "late.txt"), "added during the move"));
  const moved = await transfer(call, { mode: "move", operationId: "whole", sources: [inFolder(work, "Old")], target: onDisk(plain) });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body!.failed, undefined, "nothing is erased, so the change does not stop it");
  assert.ok(!existsSync(old), "it left the Connected Folder");
  const entries = (await api.recentlyDeleted.list()).entries;
  assert.equal(entries.length, 1);
  assert.equal(await readFile(join(entries[0]!.payloadPath, "late.txt"), "utf8"), "added during the move", "what was added is kept with the whole item");
});

test("a plain original rewritten at the same size while it was being copied stays where it was", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  await writeFile(join(plain, "ledger.txt"), "balance 100");
  // The same size, a moment later: within the two seconds a copy's time may differ by on a coarse disk.
  atBoundary(t, "remove", () => writeFile(join(plain, "ledger.txt"), "balance 999"));
  const moved = await transfer(call, { mode: "move", operationId: "same-size", sources: [onDisk(join(plain, "ledger.txt"))], target: inFolder(work, "") });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(await readFile(join(plain, "ledger.txt"), "utf8"), "balance 999", "the rewrite is still there");
  assert.match(moved.body!.failed.error, /changed while it was being copied/);
  assert.deepEqual(moved.body!.moves, []);

  // The same size and the same time, but another file: written beside it and renamed over it, with the time put back.
  setFileOperationBoundaryHookForTests(null);
  await writeFile(join(plain, "report.txt"), "draft one");
  const written = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  await utimes(join(plain, "report.txt"), written, written);
  atBoundary(t, "remove", async () => {
    await writeFile(join(plain, ".report.txt.new"), "draft two");
    await utimes(join(plain, ".report.txt.new"), written, written);
    await rename(join(plain, ".report.txt.new"), join(plain, "report.txt"));
  });
  const replaced = await transfer(call, { mode: "move", operationId: "same-time", sources: [onDisk(join(plain, "report.txt"))], target: inFolder(work, "") });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal((await lstat(join(plain, "report.txt"))).mtimeMs, written.getTime(), "the time is the one it had");
  assert.equal(await readFile(join(plain, "report.txt"), "utf8"), "draft two", "the new file is still there");
  assert.match(replaced.body!.failed.error, /changed while it was being copied/);
});

test("after one item fails its check the rest still move, and each failure is named", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(plain, name), name);
  // As the second item is about to go.
  atBoundary(t, "remove", () => writeFile(join(plain, "b.txt"), "b, edited during the move"), 2);
  const moved = await transfer(call, { mode: "move", operationId: "one-fails", sources: ["a.txt", "b.txt", "c.txt"].map((name) => onDisk(join(plain, name))), target: inFolder(work, "") });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(await tree(plain), ["b.txt=b, edited during the move"], "the other two left");
  assert.deepEqual(moved.body!.moves.map((move: any) => move.to), ["a.txt", "c.txt"]);
  assert.deepEqual(moved.body!.failures.map((failure: any) => failure.path), [onDisk(join(plain, "b.txt")).path]);
  assert.deepEqual(moved.body!.notRemoved, [onDisk(join(plain, "b.txt")).path]);
  assert.deepEqual(moved.body!.failed, moved.body!.failures[0], "the first failure is also given on its own, as before");
});

test("⌘Z says what it could not put back, and never gives an item another name at home", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  setSystemTrashHandler(async (path) => { await rm(path, { recursive: true }); });
  t.after(() => setSystemTrashHandler(null));
  const work = await connectedFolder(call, "Work");
  const workPlace: Place = { kind: "connected-folder", id: work.id };
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  await writeFile(join(plain, "notes.md"), "moved notes");
  await writeFile(join(plain, "other.md"), "other");
  const host = windowHost(call, { [work.id]: "Work" });

  const moved = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "notes.md")), onDisk(join(plain, "other.md"))], target: inFolder(work, "") });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  // Meanwhile the name at home is taken.
  await writeFile(join(plain, "notes.md"), "a new file with that name");
  const outcome = partial(await undoFor("Move 2 items", moved.body!, { place: workPlace, path: "" }, host).run());
  assert.ok(outcome, "⌘Z does not say it undid the move");
  assert.match(outcome.said, /“notes.md”/);
  assert.match(outcome.said, /Plain/, "it says where the name is taken");
  assert.match(outcome.said, /Work/, "and where the item still is");
  assert.deepEqual(await tree(plain), ["notes.md=a new file with that name", "other.md=other"], "the other item went back, and nothing was renamed");
  assert.deepEqual(await tree(work.connectedFolderRoot), ["notes.md=moved notes"], "the item that could not go back is still where the move put it");

  // An item that goes back but cannot leave where the move put it is in both places, and ⌘Z says that.
  await mkdir(join(work.connectedFolderRoot, "proj", "locked"), { recursive: true });
  await writeFile(join(work.connectedFolderRoot, "proj", "locked", "c.txt"), "c");
  const out = await transfer(call, { mode: "move", sources: [inFolder(work, "proj")], target: onDisk(plain) });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  await chmod(join(plain, "proj", "locked"), 0o555);
  try {
    const back = partial(await undoFor("Move proj", out.body!, { place: computer, path: onDisk(plain).path }, host).run());
    assert.ok(back, "⌘Z does not say it undid the move");
    assert.match(back.said, /“proj”/);
    assert.match(back.said, /also still in Plain/);
    assert.deepEqual(await tree(join(work.connectedFolderRoot, "proj")), ["locked/", "locked/c.txt=c"], "it is back");
    assert.deepEqual(await tree(join(plain, "proj")), ["locked/", "locked/c.txt=c"], "and whole where the move put it");
  } finally {
    await chmod(join(plain, "proj", "locked"), 0o755).catch(() => undefined);
    await chmod(join(work.connectedFolderRoot, "proj", "locked"), 0o755).catch(() => undefined);
  }
});

test("⌘Z after a move that left a copy in a plain folder moves the rest back and says the copy is still there", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  await writeFile(join(work.connectedFolderRoot, "a.txt"), "a");
  await writeFile(join(work.connectedFolderRoot, "b.txt"), "b");
  // As the second item is about to leave the Connected Folder.
  atBoundary(t, "remove", () => writeFile(join(work.connectedFolderRoot, "b.txt"), "b, edited during the move"), 2);
  const target = onDisk(plain);
  const moved = await transfer(call, { mode: "move", operationId: "left-copy", sources: [inFolder(work, "a.txt"), inFolder(work, "b.txt")], target });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body!.moves.map((move: any) => move.from), ["a.txt"]);
  assert.deepEqual(moved.body!.notRemoved, ["b.txt"]);
  assert.deepEqual(await tree(plain), ["a.txt=a", "b.txt=b"]);

  const outcome = partial(await undoFor("Move 2 items", moved.body!, target, windowHost(call, { [work.id]: "Work" })).run());
  assert.ok(outcome, "⌘Z says more than that it undid the move");
  assert.equal(outcome.said, "Undid Move 2 items. The copy of “b.txt” that the move left in Plain is still there.");
  assert.deepEqual(await tree(work.connectedFolderRoot), ["a.txt=a", "b.txt=b, edited during the move"], "what moved is back, and what never left is as it was");
  assert.deepEqual(await tree(plain), ["b.txt=b"], "a plain folder has no History to take the copy away");
});

test("a registered Connected Folder is never removed through another spelling of its path", { skip: process.platform === "linux" && "names are compared as written on Linux" }, async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  // Registered under the composed spelling; asked for under the decomposed one, which the disk treats as the same name.
  const composed = join(plain, "Caf\u00e9");
  const decomposed = join(plain, "Cafe\u0301");
  await mkdir(composed, { recursive: true });
  await writeFile(join(composed, "menu.txt"), "menu");
  if (!existsSync(decomposed)) { t.skip("this disk keeps the two spellings apart"); return; }
  const owned = (await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: composed } })).body!.connectedFolder;
  assert.ok(owned.id);
  // The other spelling, an item inside it, and the other spelling in other letter case where the disk ignores case.
  const shouted = join(plain, "CAFE\u0301");
  for (const path of [decomposed, join(decomposed, "menu.txt"), ...(existsSync(shouted) ? [shouted] : [])]) {
    const refused = await transfer(call, { mode: "move", sources: [onDisk(path)], target: inFolder(work, "") });
    assert.equal(refused.status, 409, `${JSON.stringify(path)}: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body!.error, /is a Connected Folder/);
    assert.equal(await readFile(join(composed, "menu.txt"), "utf8"), "menu", "the Connected Folder is untouched");
    assert.deepEqual(await tree(work.connectedFolderRoot), [], "nothing was copied");
  }
});

test("a Connected Folder registered through a linked folder is never removed through its real path", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const real = join(sandbox, "Real");
  await mkdir(join(real, "Proj"), { recursive: true });
  await writeFile(join(real, "Proj", "doc.txt"), "doc");
  await symlink(real, join(sandbox, "Linked"));
  const registered = await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: join(sandbox, "Linked", "Proj") } });
  if (registered.status !== 201 && registered.status !== 200) { t.skip(`a folder through a link is not registered: ${JSON.stringify(registered.body)}`); return; }
  // The folder itself, an item inside it, and the folder that holds it.
  for (const path of [join(real, "Proj"), join(real, "Proj", "doc.txt"), real]) {
    const refused = await transfer(call, { mode: "move", sources: [onDisk(path)], target: inFolder(work, "") });
    assert.equal(refused.status, 409, `${path}: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body!.error, /is a Connected Folder/);
    assert.equal(await readFile(join(real, "Proj", "doc.txt"), "utf8"), "doc", "the Connected Folder is untouched");
    assert.deepEqual(await tree(work.connectedFolderRoot), [], "nothing was copied");
  }
});

test("a Connected Folder inside another, registered through a linked folder, is never moved out through its parent", async (t) => {
  const { api, call, sandbox } = await sandboxApi(t);
  const parentRoot = join(sandbox, "Parent");
  await mkdir(join(parentRoot, "Area", "Child"), { recursive: true });
  await writeFile(join(parentRoot, "Area", "Child", "doc.txt"), "doc");
  await writeFile(join(parentRoot, "loose.txt"), "loose");
  const parent = (await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: parentRoot } })).body!.connectedFolder;
  // Registered by a path no part of the parent's own spells: through a link to the parent.
  await symlink(parentRoot, join(sandbox, "Linked"));
  const registered = await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: join(sandbox, "Linked", "Area", "Child") } });
  if (registered.status !== 201 && registered.status !== 200) { t.skip(`a folder through a link is not registered: ${JSON.stringify(registered.body)}`); return; }
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  const other = await connectedFolder(call, "Other");

  // The Connected Folder itself, an item inside it, and the folder that holds it; to a plain folder and to another Connected Folder.
  for (const target of [onDisk(plain), inFolder(other, "")]) {
    for (const path of ["Area/Child", "Area/Child/doc.txt", "Area"]) {
      const refused = await transfer(call, { mode: "move", sources: [inFolder(parent, path)], target });
      assert.equal(refused.status, 409, `${path}: ${JSON.stringify(refused.body)}`);
      assert.match(refused.body!.error, /Connected Folder/);
      assert.equal(await readFile(join(parentRoot, "Area", "Child", "doc.txt"), "utf8"), "doc", "the nested Connected Folder is untouched");
    }
  }
  assert.deepEqual(await tree(plain), [], "nothing was copied");
  assert.deepEqual(await tree(other.connectedFolderRoot), []);
  assert.deepEqual((await api.recentlyDeleted.list()).entries, [], "and nothing was set aside");
  // What is the parent's own still moves.
  const moved = await transfer(call, { mode: "move", sources: [inFolder(parent, "loose.txt")], target: onDisk(plain) });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(await tree(plain), ["loose.txt=loose"]);
});

test("a transfer's target is never inside a nested Connected Folder named through its parent", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const parentRoot = join(sandbox, "parent");
  await mkdir(join(parentRoot, "Projects", "Child", "Inner"), { recursive: true });
  await writeFile(join(parentRoot, "notes.md"), "notes");
  const parent = (await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: parentRoot } })).body!.connectedFolder;
  assert.equal((await call(`/api/connected-folders/${parent.id}/nested-folders`, { method: "POST", body: { path: "Projects/Child" } })).status, 201);
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  await writeFile(join(plain, "loose.txt"), "loose");
  const other = await connectedFolder(call, "Other");
  await writeFile(join(other.connectedFolderRoot, "theirs.txt"), "theirs");

  for (const mode of ["copy", "move"] as const) {
    for (const path of ["Projects/Child", "Projects/Child/Inner"]) {
      for (const source of [inFolder(parent, "notes.md"), onDisk(join(plain, "loose.txt")), inFolder(other, "theirs.txt")]) {
        for (const conflicts of [undefined, { check: true }]) {
          const refused = await transfer(call, { mode, sources: [source], target: inFolder(parent, path), ...(conflicts ? { conflicts } : {}) });
          assert.equal(refused.status, 409, `${mode} ${source.path} to ${path}: ${JSON.stringify(refused.body)}`);
          assert.match(refused.body!.error, /Connected Folder/);
        }
      }
      assert.deepEqual(await tree(join(parentRoot, "Projects")), ["Child/", "Child/Inner/"], "nothing was written into the nested Connected Folder");
    }
  }
  assert.equal(await readFile(join(parentRoot, "notes.md"), "utf8"), "notes");
  assert.equal(await readFile(join(plain, "loose.txt"), "utf8"), "loose");
  assert.equal(await readFile(join(other.connectedFolderRoot, "theirs.txt"), "utf8"), "theirs");
  // Duplicate, Compress, and Extract write beside the item, so they are refused there too.
  await writeFile(join(parentRoot, "Projects", "Child", "inside.txt"), "inside");
  await writeFile(join(parentRoot, "Projects", "Child", "old.zip"), "not read: the folder is refused first");
  const beside = [
    await transfer(call, { mode: "duplicate", sources: [inFolder(parent, "Projects/Child/inside.txt")], target: inFolder(parent, "Projects/Child") }),
    await call("/api/file-transfer/compress", { method: "POST", body: { place: inFolder(parent, "").place, paths: ["Projects/Child/inside.txt"] } }),
    await call("/api/file-transfer/extract", { method: "POST", body: { place: inFolder(parent, "").place, path: "Projects/Child/old.zip" } }),
  ];
  for (const refused of beside) {
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body!.error, /Connected Folder/);
  }
  assert.deepEqual((await readdir(join(parentRoot, "Projects", "Child"))).filter((name) => !name.startsWith(".")).sort(), ["Inner", "inside.txt", "old.zip"], "nothing was written beside them");
  await rm(join(parentRoot, "Projects", "Child", "inside.txt"));
  await rm(join(parentRoot, "Projects", "Child", "old.zip"));
  // The folder that holds it is the parent's own.
  const holder = await transfer(call, { mode: "copy", sources: [inFolder(parent, "notes.md")], target: inFolder(parent, "Projects") });
  assert.equal(holder.status, 200, JSON.stringify(holder.body));
});
