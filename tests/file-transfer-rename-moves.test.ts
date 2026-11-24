import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ampleFileCliBrokerPaths } from "../src/local/cli/broker.js";
import { setFileOperationBoundaryHookForTests } from "../src/local/file-operations.js";
import { setSystemTrashHandler } from "../src/local/move-to-system-trash.js";
import { startLocalApi } from "../src/local/server.js";
import { isPartialUndo, moveBackPlan, movesUndo, type FileUndo, type MoveAnswer, type MoveBackHost, type PartialUndo } from "../web-local/src/components/file-manager/file-manager-undo.js";

/**
 * A move between places on one disk renames each item
 * (docs/product-model.md, "Finder's file actions", Moves): the item itself
 * goes, at once, with everything it has. Nothing is copied, so nothing a
 * copy does not carry (a resource fork, Finder tags and comments, a
 * download's quarantine mark, flags, dates) can be lost, and ⌘Z renames it
 * back.
 */

type Api = Awaited<ReturnType<typeof startLocalApi>>;
type Call = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: Record<string, any> | null }>;
type Place = { kind: "connected-folder" | "standard"; id: string };

const run = promisify(execFile);
const onMac = process.platform === "darwin";

async function sandboxApi(t: test.TestContext): Promise<{ api: Api; call: Call; sandbox: string }> {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "amplefile-rename-moves-")));
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
const onDisk = (path: string) => ({ place: computer, path: relative("/", path) });
const inFolder = (folder: { id: string }, path: string) => ({ place: { kind: "connected-folder", id: folder.id } as Place, path });
const transfer = (call: Call, body: unknown) => call("/api/file-transfer", { method: "POST", body });

async function receipts(sandbox: string): Promise<Array<{ requestId: string; command: string; outcome: string; detail?: string; surface?: string }>> {
  const journal = await readFile(join(ampleFileCliBrokerPaths(join(sandbox, "state")).root, "receipts", "act.jsonl"), "utf8").catch(() => "");
  return journal.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function tree(root: string, prefix = ""): Promise<string[]> {
  const listed: string[] = [];
  for (const name of (await readdir(root)).filter((entry) => !entry.startsWith(".")).sort()) {
    const path = join(root, name);
    if ((await lstat(path)).isDirectory()) listed.push(`${prefix}${name}/`, ...await tree(path, `${prefix}${name}/`));
    else listed.push(`${prefix}${name}=${await readFile(path, "utf8")}`);
  }
  return listed;
}

/** What an item has besides its contents, as the Mac tells it: its extended attributes (the system's own provenance mark aside) and its flags. */
async function extras(path: string): Promise<{ attributes: string[]; flags: string }> {
  const names = (await run("/usr/bin/xattr", ["-s", "--", path])).stdout.split("\n").filter((name) => name && name !== "com.apple.provenance").sort();
  return { attributes: names, flags: (await run("/usr/bin/stat", ["-f", "%f", "--", path])).stdout.trim() };
}

/** A text clipping as Finder makes one: its text is in the resource fork, and it carries a tag, a comment, and a download's mark. */
async function clipping(path: string): Promise<void> {
  await writeFile(path, "");
  await writeFile(join(path, "..namedfork", "rsrc"), "the clipping's text");
  await run("/usr/bin/xattr", ["-w", "com.apple.metadata:_kMDItemUserTags", "Red", path]);
  await run("/usr/bin/xattr", ["-w", "com.apple.metadata:kMDItemFinderComment", "keep this", path]);
  await run("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", path]);
}

function windowHost(call: Call, names: Record<string, string> = {}): MoveBackHost {
  return {
    transfer: async (body) => {
      const answer = await transfer(call, body);
      if (answer.status !== 200) throw Object.assign(new Error(answer.body?.error ?? `status ${answer.status}`), { status: answer.status, code: answer.body?.code });
      return answer.body as Awaited<ReturnType<MoveBackHost["transfer"]>>;
    },
    restore: async (point) => {
      const restored = await call(`/api/connected-folders/${point.connectedFolderId}/history/checkpoints/${point.checkpointId}/restore`, { method: "POST", body: {} });
      if (restored.status !== 200) throw Object.assign(new Error(restored.body?.error ?? `status ${restored.status}`), { status: restored.status, code: restored.body?.code });
    },
    copiesChanged: async (copies) => {
      const answer = await call("/api/file-transfer/copies-changed", { method: "POST", body: { copies } });
      if (answer.status !== 200) throw new Error(answer.body?.error ?? `status ${answer.status}`);
      return answer.body!.changed;
    },
    nameOf: (folder) => folder.path ? folder.path.slice(folder.path.lastIndexOf("/") + 1) : names[folder.place.id] ?? folder.place.id,
  };
}

function undoFor(label: string, answer: Record<string, any>, target: { place: Place; path: string }, host: MoveBackHost): FileUndo {
  const plan = moveBackPlan(answer as MoveAnswer, target);
  assert.ok(plan, "the items are moved back");
  return movesUndo(label, plan, host);
}

const partial = (outcome: FileUndo | PartialUndo | null): PartialUndo | null => isPartialUndo(outcome) ? outcome : null;

test("a move on one disk takes the item itself, with its resource fork, tags, comment, quarantine mark, flags, and dates, in every direction", { skip: !onMac && "extended attributes and flags are read the Mac's way" }, async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const other = await connectedFolder(call, "Other");
  const plain = join(sandbox, "Plain");
  await mkdir(join(plain, "Trip", "Photos"), { recursive: true });
  await clipping(join(plain, "Trip", "note.textClipping"));
  await writeFile(join(plain, "Trip", "Photos", "a.jpg"), "a");
  await run("/usr/bin/xattr", ["-w", "com.apple.metadata:_kMDItemUserTags", "Blue", join(plain, "Trip")]);
  await run("/usr/bin/chflags", ["hidden", join(plain, "Trip", "Photos")]);
  const was = new Date("2024-03-12T14:02:00Z");
  await utimes(join(plain, "Trip"), was, was);
  const before = {
    inode: (await lstat(join(plain, "Trip", "note.textClipping"))).ino,
    clipping: await extras(join(plain, "Trip", "note.textClipping")),
    folder: await extras(join(plain, "Trip")),
    photos: await extras(join(plain, "Trip", "Photos")),
  };
  assert.deepEqual(before.clipping.attributes, ["com.apple.ResourceFork", "com.apple.metadata:_kMDItemUserTags", "com.apple.metadata:kMDItemFinderComment", "com.apple.quarantine"]);
  assert.notEqual(before.photos.flags, "0", "the folder is hidden");

  /** Everything the item had is still on it, and it is the same file. */
  const whole = async (root: string, where: string) => {
    assert.equal(await readFile(join(root, "Trip", "note.textClipping", "..namedfork", "rsrc"), "utf8"), "the clipping's text", `${where}: the clipping's text`);
    assert.deepEqual(await extras(join(root, "Trip", "note.textClipping")), before.clipping, `${where}: the clipping`);
    assert.deepEqual(await extras(join(root, "Trip")), before.folder, `${where}: the folder's tag`);
    assert.deepEqual(await extras(join(root, "Trip", "Photos")), before.photos, `${where}: the hidden folder`);
    assert.equal((await lstat(join(root, "Trip"))).mtimeMs, was.getTime(), `${where}: the folder's date`);
    assert.equal((await lstat(join(root, "Trip", "note.textClipping"))).ino, before.inode, `${where}: the same file, not a copy of it`);
  };

  // From a plain folder into a Connected Folder.
  const into = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "Trip"))], target: inFolder(work, "") });
  assert.equal(into.status, 200, JSON.stringify(into.body));
  assert.deepEqual(into.body!.moves, [{ from: onDisk(join(plain, "Trip")).path, fromPlace: computer, to: "Trip" }]);
  assert.ok(!existsSync(join(plain, "Trip")), "it left the plain folder");
  await whole(work.connectedFolderRoot, "in the Connected Folder");
  assert.equal(into.body!.failed, undefined);
  assert.equal(into.body!.notRemoved, undefined);

  // Between two Connected Folders.
  const between = await transfer(call, { mode: "move", sources: [inFolder(work, "Trip")], target: inFolder(other, "") });
  assert.equal(between.status, 200, JSON.stringify(between.body));
  assert.ok(!existsSync(join(work.connectedFolderRoot, "Trip")));
  await whole(other.connectedFolderRoot, "in the other Connected Folder");
  assert.equal(between.body!.recentlyDeleted, undefined, "nothing was erased, so nothing was set aside");
  assert.deepEqual(between.body!.restorePoints.map((point: any) => point.connectedFolderId).sort(), [work.id, other.id].sort(), "a restore point on both sides, as before");

  // Out of a Connected Folder into a plain folder.
  const out = await transfer(call, { mode: "move", sources: [inFolder(other, "Trip")], target: onDisk(plain) });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  await whole(plain, "back in the plain folder");

  // The receipts are the ones a move leaves: one for each item that left its place, journaled first.
  const journal = await receipts(sandbox);
  assert.deepEqual(journal.filter((receipt) => receipt.outcome === "ok").map((receipt) => [receipt.command, receipt.surface]), [["files.move", "main-window"], ["files.delete", "main-window"], ["files.delete", "main-window"]]);
  for (const done of journal.filter((receipt) => receipt.outcome === "ok")) assert.ok(journal.some((receipt) => receipt.requestId === done.requestId && receipt.outcome === "accepted"));

  // ⌘Z renames it back, with everything.
  const outcome = await undoFor("Move Trip", out.body!, { place: computer, path: onDisk(plain).path }, windowHost(call, { [other.id]: "Other" })).run();
  assert.ok(outcome && !isPartialUndo(outcome), JSON.stringify(outcome));
  await whole(other.connectedFolderRoot, "after ⌘Z");
  assert.ok(!existsSync(join(plain, "Trip")));
});

test("a move on one disk follows the name-clash choices, stops between items, and refuses what a move refuses", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const trashed: string[] = [];
  setSystemTrashHandler(async (path) => { trashed.push(await readFile(path, "utf8")); await rm(path, { recursive: true }); });
  t.after(() => setSystemTrashHandler(null));
  const work = await connectedFolder(call, "Work");
  const plain = join(sandbox, "Plain");
  await mkdir(join(plain, "Photos"), { recursive: true });
  await mkdir(join(work.connectedFolderRoot, "Photos"));
  for (const [name, content] of [["a.txt", "plain a"], ["b.txt", "plain b"], ["c.txt", "plain c"], ["Photos/x.jpg", "plain x"], ["Photos/only.jpg", "plain only"]]) await writeFile(join(plain, name!), content!);
  for (const [name, content] of [["a.txt", "work a"], ["b.txt", "work b"], ["c.txt", "work c"], ["Photos/x.jpg", "work x"]]) await writeFile(join(work.connectedFolderRoot, name!), content!);
  const key = (name: string) => onDisk(join(plain, name)).path;

  const moved = await transfer(call, {
    mode: "move",
    sources: ["a.txt", "b.txt", "c.txt", "Photos"].map((name) => onDisk(join(plain, name))),
    target: inFolder(work, ""),
    conflicts: { items: { [key("a.txt")]: "keep-both", [key("b.txt")]: "skip", [key("c.txt")]: "replace", [key("Photos")]: "merge" }, insideItems: { [key("Photos")]: "replace" } },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(await tree(work.connectedFolderRoot), ["Photos/", "Photos/only.jpg=plain only", "Photos/x.jpg=plain x", "a copy.txt=plain a", "a.txt=work a", "b.txt=work b", "c.txt=plain c"]);
  assert.deepEqual(await tree(plain), ["b.txt=plain b"], "the skipped item stays, and the merged folder is gone once it is empty");
  assert.deepEqual(moved.body!.replaced.map((item: any) => [item.path, item.recovery]), [["c.txt", "history"], ["Photos/x.jpg", "history"]]);
  assert.deepEqual(moved.body!.merged, ["Photos"]);
  // History keeps what was replaced: its restore point brings both back.
  const restored = await call(`/api/connected-folders/${work.id}/history/checkpoints/${moved.body!.restorePoints[0].checkpointId}/restore`, { method: "POST", body: {} });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(await readFile(join(work.connectedFolderRoot, "c.txt"), "utf8"), "work c");
  assert.equal(await readFile(join(work.connectedFolderRoot, "Photos", "x.jpg"), "utf8"), "work x");

  // Out again, replacing in the plain folder: the item there goes to the Trash.
  await writeFile(join(work.connectedFolderRoot, "b.txt"), "work b, newer");
  const out = await transfer(call, { mode: "move", sources: [inFolder(work, "b.txt")], target: onDisk(plain), conflicts: { items: { "b.txt": "replace" } } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(await readFile(join(plain, "b.txt"), "utf8"), "work b, newer");
  assert.deepEqual(trashed, ["plain b"]);

  // Stop between items: the first stays moved, the rest stay where they were, and nothing is in two places.
  for (const name of ["one.txt", "two.txt", "three.txt"]) await writeFile(join(plain, name), name);
  let seen = 0;
  setFileOperationBoundaryHookForTests(async ({ operationId, point }) => {
    if (point !== "remove") return;
    seen += 1;
    if (seen === 2) await call("/api/file-transfer/cancel", { method: "POST", body: { operationId } });
  });
  t.after(() => setFileOperationBoundaryHookForTests(null));
  const stopped = await transfer(call, { mode: "move", operationId: "stop-rename", sources: ["one.txt", "two.txt", "three.txt"].map((name) => onDisk(join(plain, name))), target: inFolder(work, "") });
  setFileOperationBoundaryHookForTests(null);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body!.cancelled, true);
  assert.deepEqual(stopped.body!.written, ["one.txt"]);
  assert.deepEqual(stopped.body!.notDone, ["two.txt", "three.txt"].map(key));
  assert.ok(existsSync(join(work.connectedFolderRoot, "one.txt")) && !existsSync(join(plain, "one.txt")));
  assert.ok(existsSync(join(plain, "two.txt")) && !existsSync(join(work.connectedFolderRoot, "two.txt")));

  // A read-only folder cannot be taken out of where it is: it stays whole, and the others still move.
  if (process.getuid?.() !== 0) {
    const { chmod } = await import("node:fs/promises");
    await mkdir(join(plain, "Locked"));
    await writeFile(join(plain, "Locked", "in.txt"), "in");
    await chmod(join(plain, "Locked"), 0o555);
    try {
      const refused = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "Locked")), onDisk(join(plain, "two.txt"))], target: inFolder(work, "") });
      assert.equal(refused.status, 200, JSON.stringify(refused.body));
      assert.deepEqual(refused.body!.failures.map((failure: any) => failure.path), [key("Locked")]);
      assert.doesNotMatch(refused.body!.failed.error, /\bE[A-Z]{4,}\b/, "said plainly, not as the disk's error code");
      assert.equal(refused.body!.notRemoved, undefined, "nothing of it is in the Connected Folder");
      assert.deepEqual(await tree(join(plain, "Locked")), ["in.txt=in"]);
      assert.ok(!existsSync(join(work.connectedFolderRoot, "Locked")));
      assert.ok(existsSync(join(work.connectedFolderRoot, "two.txt")), "the other item moved");
    } finally {
      await chmod(join(plain, "Locked"), 0o755);
    }
  }
});

test("⌘Z after an item was renamed or removed puts the others back, says which one it could not, and leaves the undo stack free", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const work = await connectedFolder(call, "Work");
  const workPlace: Place = { kind: "connected-folder", id: work.id };
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  await writeFile(join(work.connectedFolderRoot, "a.txt"), "a");
  await writeFile(join(work.connectedFolderRoot, "b.txt"), "b");
  const host = windowHost(call, { [work.id]: "Work" });
  const target = { place: computer, path: onDisk(plain).path };

  const out = await transfer(call, { mode: "move", sources: [inFolder(work, "a.txt"), inFolder(work, "b.txt")], target: onDisk(plain) });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  // Meanwhile one of them is renamed, as in Finder.
  await rename(join(plain, "a.txt"), join(plain, "a renamed.txt"));

  const outcome = partial(await undoFor("Move 2 items", out.body!, target, host).run());
  assert.ok(outcome, "⌘Z answers; it does not fail");
  assert.match(outcome.said, /“a.txt” was not put back: it is no longer in Plain/);
  assert.doesNotMatch(outcome.said, /ENOENT|EPERM|no such file/i);
  assert.deepEqual(await tree(work.connectedFolderRoot), ["b.txt=b"], "the other item went back");
  assert.deepEqual(await tree(plain), ["a renamed.txt=a"]);

  // The request itself: a source that is gone is a plain refusal, never the disk's own error.
  const gone = await transfer(call, { mode: "move", sources: [onDisk(join(plain, "a.txt"))], target: { place: workPlace, path: "" } });
  assert.equal(gone.status, 404, JSON.stringify(gone.body));
  assert.match(gone.body!.error, /“a.txt” isn’t there anymore/);
  // Asked to carry on without it, it says which one was missing.
  const skipped = await transfer(call, { mode: "move", missing: "skip", sources: [onDisk(join(plain, "a.txt")), onDisk(join(plain, "a renamed.txt"))], target: { place: workPlace, path: "" } });
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.deepEqual(skipped.body!.missing, [{ place: computer, path: onDisk(join(plain, "a.txt")).path }]);
  assert.deepEqual(skipped.body!.written, ["a renamed.txt"]);
});

test("two moves of the same item at once move it once, and the other says it is gone, in plain words", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const one = await connectedFolder(call, "One");
  const two = await connectedFolder(call, "Two");
  const plain = join(sandbox, "Plain");
  await mkdir(plain);
  for (let round = 0; round < 5; round += 1) {
    const name = `item ${round}.txt`;
    await writeFile(join(plain, name), "the item");
    const answers = await Promise.all([one, two].map((folder) => transfer(call, { mode: "move", sources: [onDisk(join(plain, name))], target: inFolder(folder, "") })));
    const places = [one, two].filter((folder) => existsSync(join(folder.connectedFolderRoot, name)));
    assert.equal(places.length, 1, `${name} is in exactly one place: ${JSON.stringify(answers.map((answer) => answer.body))}`);
    assert.equal(await readFile(join(places[0]!.connectedFolderRoot, name), "utf8"), "the item");
    assert.ok(!existsSync(join(plain, name)));
    for (const answer of answers) {
      assert.ok(answer.status === 200 || answer.status === 404, `never an unexplained failure: ${answer.status} ${JSON.stringify(answer.body)}`);
      assert.doesNotMatch(JSON.stringify(answer.body), /ENOENT|EPERM|EEXIST/);
    }
    // The answers agree with the disk: one says it moved the item, the other that it did not.
    assert.equal(answers.filter((answer) => answer.status === 200 && answer.body!.moves?.length === 1).length, 1, JSON.stringify(answers.map((answer) => answer.body)));
  }
});
