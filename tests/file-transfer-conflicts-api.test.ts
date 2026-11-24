import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { setFileOperationBoundaryHookForTests, type FileOperationBoundary, type FileOperationProgress } from "../src/local/file-operations.js";
import { setFileCopyStrategyForTests } from "../src/local/file-transfer.js";
import { startLocalApi } from "../src/local/server.js";
import { setSystemTrashHandler } from "../src/local/move-to-system-trash.js";

/**
 * Name conflicts over the local API's file-transfer routes
 * (src/local/file-conflicts.ts, src/local/api/place-routes.ts).
 */

type Api = Awaited<ReturnType<typeof startLocalApi>>;
type Call = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: Record<string, any> | null }>;

async function sandboxApi(t: test.TestContext): Promise<{ api: Api; call: Call; sandbox: string }> {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "amplefile-conflicts-api-")));
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

async function restore(call: Call, points: Array<{ connectedFolderId: string; checkpointId: string }>): Promise<void> {
  for (const point of points) {
    const restored = await call(`/api/connected-folders/${point.connectedFolderId}/history/checkpoints/${point.checkpointId}/restore`, { method: "POST", body: {} });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
  }
}

function cancelAt(t: test.TestContext, call: Call, when: (point: FileOperationBoundary, progress: FileOperationProgress) => boolean): void {
  let fired = false;
  setFileOperationBoundaryHookForTests(async ({ operationId, point, progress }) => {
    if (fired || !when(point, progress)) return;
    fired = true;
    await call("/api/file-transfer/cancel", { method: "POST", body: { operationId } });
  });
  t.after(() => setFileOperationBoundaryHookForTests(null));
}

const visible = async (path: string) => (await readdir(path)).filter((name) => !name.startsWith(".")).sort();

test("a copy into a Connected Folder asks first, then keeps both, skips, or replaces with a restore point that undoes it", async (t) => {
  const { call } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  for (const [name, content] of [["a.txt", "new a"], ["b.txt", "new b"], ["c.txt", "new c"], ["fresh.txt", "fresh"]]) await writeFile(join(source.connectedFolderRoot, name!), content!);
  await mkdir(join(source.connectedFolderRoot, "Report"));
  for (const [name, content] of [["a.txt", "old a"], ["b.txt", "old b"], ["c.txt", "old c"], ["Report", "a file named Report"]]) await writeFile(join(target.connectedFolderRoot, name!), content!);
  const sources = ["a.txt", "b.txt", "c.txt", "fresh.txt", "Report"].map((path) => ({ place: { kind: "connected-folder", id: source.id }, path }));
  const destination = { place: { kind: "connected-folder", id: target.id }, path: "" };

  const check = await call("/api/file-transfer", { method: "POST", body: { mode: "copy", sources, target: destination, conflicts: { check: true } } });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body!.conflicts.map((conflict: any) => [conflict.key, conflict.source.kind, conflict.existing.kind, conflict.canMerge]), [
    ["a.txt", "file", "file", false], ["b.txt", "file", "file", false], ["c.txt", "file", "file", false], ["Report", "folder", "file", false],
  ]);
  assert.deepEqual(await visible(target.connectedFolderRoot), ["Report", "a.txt", "b.txt", "c.txt"], "a check writes nothing");

  const copied = await call("/api/file-transfer", {
    method: "POST",
    body: { mode: "copy", sources, target: destination, conflicts: { apply: "replace", items: { "b.txt": "skip", "c.txt": "keep-both" } } },
  });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.deepEqual(copied.body!.written, ["a.txt", "c copy.txt", "fresh.txt", "Report copy"]);
  assert.deepEqual(copied.body!.replaced, [{ path: "a.txt", recovery: "history" }]);
  assert.deepEqual(copied.body!.skipped, [{ path: "b.txt", reason: "chosen" }]);
  assert.deepEqual(copied.body!.merged, []);
  assert.equal(await readFile(join(target.connectedFolderRoot, "a.txt"), "utf8"), "new a");
  assert.equal(await readFile(join(target.connectedFolderRoot, "b.txt"), "utf8"), "old b");
  assert.equal(await readFile(join(target.connectedFolderRoot, "Report"), "utf8"), "a file named Report", "Replace for all never puts a folder over a file");
  assert.equal(copied.body!.restorePoints.length, 1);
  await restore(call, copied.body!.restorePoints);
  assert.equal(await readFile(join(target.connectedFolderRoot, "a.txt"), "utf8"), "old a", "the restore point brings back what was replaced");
  assert.deepEqual(await visible(target.connectedFolderRoot), ["Report", "a.txt", "b.txt", "c.txt"], "and takes away what was added");

  // Only that item's own Replace puts a folder where a file is.
  const explicit = await call("/api/file-transfer", { method: "POST", body: { mode: "copy", sources: sources.slice(4), target: destination, conflicts: { items: { Report: "replace" } } } });
  assert.equal(explicit.status, 200, JSON.stringify(explicit.body));
  assert.deepEqual(explicit.body!.replaced, [{ path: "Report", recovery: "history" }]);
  assert.ok((await lstat(join(target.connectedFolderRoot, "Report"))).isDirectory());
  assert.deepEqual(await visible(target.connectedFolderRoot), ["Report", "a.txt", "b.txt", "c.txt"], "no working copy is left");

  // No conflicts field: the " copy" naming, and today's answer.
  const plain = await call("/api/file-transfer", { method: "POST", body: { mode: "copy", sources: sources.slice(0, 1), target: destination } });
  assert.deepEqual(Object.keys(plain.body!).sort(), ["mode", "restorePoints", "written"]);
  assert.deepEqual(plain.body!.written, ["a copy.txt"]);
});

test("a merged folder combines contents, applying the inner choice, and its restore point undoes it", async (t) => {
  const { call } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  await mkdir(join(source.connectedFolderRoot, "Photos", "Trip"), { recursive: true });
  await mkdir(join(target.connectedFolderRoot, "Photos", "Trip"), { recursive: true });
  await writeFile(join(source.connectedFolderRoot, "Photos", "a.jpg"), "new a");
  await writeFile(join(target.connectedFolderRoot, "Photos", "a.jpg"), "old a");
  await writeFile(join(source.connectedFolderRoot, "Photos", "Trip", "b.jpg"), "new b");
  await writeFile(join(target.connectedFolderRoot, "Photos", "Trip", "b.jpg"), "old b");
  await writeFile(join(source.connectedFolderRoot, "Photos", "Trip", "c.jpg"), "c");
  await writeFile(join(target.connectedFolderRoot, "Photos", "kept.jpg"), "kept");
  const body = (conflicts: unknown) => ({
    mode: "copy",
    sources: [{ place: { kind: "connected-folder", id: source.id }, path: "Photos" }],
    target: { place: { kind: "connected-folder", id: target.id }, path: "" },
    conflicts,
  });
  const check = await call("/api/file-transfer", { method: "POST", body: body({ check: true }) });
  assert.equal(check.body!.conflicts[0].canMerge, true);
  assert.equal(check.body!.conflicts[0].insideClashes, 2);

  const merged = await call("/api/file-transfer", { method: "POST", body: body({ items: { Photos: "merge" }, inside: "replace" }) });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.deepEqual(merged.body!.written, ["Photos"]);
  assert.deepEqual(merged.body!.merged, ["Photos"]);
  assert.deepEqual(merged.body!.replaced.map((item: any) => item.path).sort(), ["Photos/Trip/b.jpg", "Photos/a.jpg"]);
  const photos = join(target.connectedFolderRoot, "Photos");
  assert.equal(await readFile(join(photos, "a.jpg"), "utf8"), "new a");
  assert.equal(await readFile(join(photos, "Trip", "b.jpg"), "utf8"), "new b");
  assert.equal(await readFile(join(photos, "Trip", "c.jpg"), "utf8"), "c");
  assert.equal(await readFile(join(photos, "kept.jpg"), "utf8"), "kept", "what was only there stays");
  await restore(call, merged.body!.restorePoints);
  assert.equal(await readFile(join(photos, "a.jpg"), "utf8"), "old a");
  assert.equal(await readFile(join(photos, "Trip", "b.jpg"), "utf8"), "old b");
  assert.ok(!existsSync(join(photos, "Trip", "c.jpg")));
  assert.equal(await readFile(join(photos, "kept.jpg"), "utf8"), "kept");

  const keepBoth = await call("/api/file-transfer", { method: "POST", body: body({ apply: "merge" }) });
  assert.equal(keepBoth.status, 200, JSON.stringify(keepBoth.body));
  assert.deepEqual((await readdir(photos)).sort(), ["Trip", "a copy.jpg", "a.jpg", "kept.jpg"], "inside clashes keep both unless chosen");
  assert.deepEqual((await readdir(join(photos, "Trip"))).sort(), ["b copy.jpg", "b.jpg", "c.jpg"]);
});

test("two folders merged at once each follow their own answer, and what a merge replaces goes where its place can recover it", async (t) => {
  const { api, call, sandbox } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  const plain = join(sandbox, "Plain");
  for (const root of [source.connectedFolderRoot, target.connectedFolderRoot, plain]) {
    const age = root === source.connectedFolderRoot ? "new" : "old";
    for (const name of ["Docs", "Pics", "Mail"]) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, "same.txt"), `${age} ${name}`);
    }
    // History keeps no copy of a file over its limit.
    await writeFile(join(root, "Docs", "large.bin"), `${age} and larger than the limit History keeps`);
  }
  await writeFile(join(source.connectedFolderRoot, "Pics", "only.txt"), "only");
  const previousCap = process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES;
  process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = "16";
  t.after(() => { if (previousCap === undefined) delete process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES; else process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = previousCap; });
  const sources = ["Docs", "Pics", "Mail"].map((path) => ({ place: { kind: "connected-folder", id: source.id }, path }));
  const conflicts = { items: { Docs: "merge", Pics: "merge", Mail: "merge" }, insideItems: { Docs: "replace", Pics: "skip", Mail: "keep-both" } };

  // In a Connected Folder: History keeps what was replaced, and Recently Deleted what History could not.
  const inFolder = await call("/api/file-transfer", { method: "POST", body: { mode: "copy", sources, target: { place: { kind: "connected-folder", id: target.id }, path: "" }, conflicts } });
  assert.equal(inFolder.status, 200, JSON.stringify(inFolder.body));
  assert.deepEqual(inFolder.body!.merged, ["Docs", "Pics", "Mail"]);
  assert.equal(await readFile(join(target.connectedFolderRoot, "Docs", "same.txt"), "utf8"), "new Docs", "Docs: replaced");
  assert.equal(await readFile(join(target.connectedFolderRoot, "Pics", "same.txt"), "utf8"), "old Pics", "Pics: skipped");
  assert.deepEqual((await readdir(join(target.connectedFolderRoot, "Pics"))).sort(), ["only.txt", "same.txt"], "what was only in the folder coming in arrives");
  assert.deepEqual((await readdir(join(target.connectedFolderRoot, "Mail"))).sort(), ["same copy.txt", "same.txt"], "Mail: both kept");
  assert.equal(await readFile(join(target.connectedFolderRoot, "Mail", "same.txt"), "utf8"), "old Mail");
  assert.deepEqual(inFolder.body!.skipped, [{ path: "Pics/same.txt", reason: "chosen" }]);
  const recovered = Object.fromEntries(inFolder.body!.replaced.map((item: any) => [item.path, item.recovery]));
  assert.deepEqual(recovered, { "Docs/large.bin": "recently-deleted", "Docs/same.txt": "history" });
  assert.deepEqual((await api.recentlyDeleted.list()).entries.map((entry) => entry.originalPath), ["Docs/large.bin"]);

  // In a plain folder: the system Trash, or gone when no Trash can take it.
  const trashed: string[] = [];
  setSystemTrashHandler(async (path) => {
    const content = await readFile(path, "utf8");
    if (content.includes("larger")) throw new Error("no Trash");
    trashed.push(content);
    await rm(path);
  });
  t.after(() => setSystemTrashHandler(null));
  const inPlain = await call("/api/file-transfer", { method: "POST", body: { mode: "copy", sources, target: { place: { kind: "standard", id: "computer" }, path: relative("/", plain) }, conflicts } });
  assert.equal(inPlain.status, 200, JSON.stringify(inPlain.body));
  assert.equal(await readFile(join(plain, "Docs", "same.txt"), "utf8"), "new Docs");
  assert.equal(await readFile(join(plain, "Pics", "same.txt"), "utf8"), "old Pics");
  assert.deepEqual((await readdir(join(plain, "Mail"))).sort(), ["same copy.txt", "same.txt"]);
  assert.deepEqual(trashed, ["old Docs"]);
  assert.deepEqual(Object.fromEntries(inPlain.body!.replaced.map((item: any) => [relative(plain, join("/", item.path)), item.recovery])), { "Docs/large.bin": "gone", "Docs/same.txt": "trash" });
});

test("a merge never replaces or merges into a nested Connected Folder", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  await mkdir(join(source.connectedFolderRoot, "Photos", "Trip"), { recursive: true });
  await writeFile(join(source.connectedFolderRoot, "Photos", "a.jpg"), "new a");
  await writeFile(join(source.connectedFolderRoot, "Photos", "Trip", "b.jpg"), "new b");
  const sources = [{ place: { kind: "connected-folder", id: source.id }, path: "Photos" }];
  const conflicts = { items: { Photos: "merge" }, insideItems: { Photos: "replace" } };
  setSystemTrashHandler(async (path) => { await rm(path, { recursive: true }); });
  t.after(() => setSystemTrashHandler(null));

  // A Connected Folder nested in the target Connected Folder.
  const targetRoot = join(sandbox, "target");
  await mkdir(join(targetRoot, "Photos", "Trip"), { recursive: true });
  await writeFile(join(targetRoot, "Photos", "a.jpg"), "old a");
  await writeFile(join(targetRoot, "Photos", "Trip", "b.jpg"), "the nested Connected Folder's b");
  const target = (await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: targetRoot } })).body!.connectedFolder;
  assert.equal((await call(`/api/connected-folders/${target.id}/nested-folders`, { method: "POST", body: { path: "Photos/Trip" } })).status, 201);
  // And one inside a plain folder.
  const plain = join(sandbox, "Plain");
  await mkdir(join(plain, "Photos", "Trip"), { recursive: true });
  await writeFile(join(plain, "Photos", "a.jpg"), "old a");
  await writeFile(join(plain, "Photos", "Trip", "b.jpg"), "the Connected Folder's b");
  assert.equal((await call("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: join(plain, "Photos", "Trip") } })).status, 201);

  const nestedContent = (root: string) => root === plain ? "the Connected Folder's b" : "the nested Connected Folder's b";
  for (const [root, at] of [[targetRoot, { kind: "connected-folder", id: target.id }], [plain, { kind: "standard", id: "computer" }]] as const) {
    const inside = (path: string) => ({ place: at, path: root === plain ? relative("/", join(plain, path)) : path });
    // A folder that holds a Connected Folder is not merged into: the choice for it keeps both.
    const merged = await call("/api/file-transfer", { method: "POST", body: { mode: "copy", sources, target: inside(""), conflicts } });
    assert.equal(merged.status, 200, `${root}: ${JSON.stringify(merged.body)}`);
    assert.deepEqual(merged.body!.merged, [], root);
    assert.deepEqual(merged.body!.replaced, [], root);
    assert.deepEqual(await visible(root), ["Photos", "Photos copy"], root);
    assert.equal(await readFile(join(root, "Photos", "a.jpg"), "utf8"), "old a", root);
    // The Connected Folder itself is neither replaced nor merged into, whichever is chosen for it by name.
    for (const choice of ["replace", "merge"]) {
      const onto = await call("/api/file-transfer", {
        method: "POST",
        body: { mode: "copy", sources: [{ place: { kind: "connected-folder", id: source.id }, path: "Photos/Trip" }], target: inside("Photos"), conflicts: { items: { "Photos/Trip": choice }, inside: "replace" } },
      });
      assert.equal(onto.status, 200, `${root} ${choice}: ${JSON.stringify(onto.body)}`);
      assert.deepEqual(onto.body!.replaced, [], `${root} ${choice}`);
      assert.deepEqual(onto.body!.merged, [], `${root} ${choice}`);
      assert.equal(await readFile(join(root, "Photos", "Trip", "b.jpg"), "utf8"), nestedContent(root), `${root} ${choice}`);
      assert.deepEqual((await readdir(join(root, "Photos", "Trip"))).filter((name) => !name.startsWith(".")), ["b.jpg"], `${root} ${choice}`);
    }
    assert.deepEqual(await visible(join(root, "Photos")), ["Trip", "Trip copy", "Trip copy 2", "a.jpg"], root);
  }
});

test("a replace outside a Connected Folder sends the old item to the Trash, or says it is gone", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  await mkdir(join(sandbox, "Here", "From"), { recursive: true });
  await writeFile(join(sandbox, "Here", "From", "doc.txt"), "new");
  await writeFile(join(sandbox, "Here", "doc.txt"), "old");
  const computer = (path: string) => ({ place: { kind: "standard", id: "computer" }, path: relative("/", path) });
  const trashed: string[] = [];
  setSystemTrashHandler(async (path) => { trashed.push(await readFile(path, "utf8")); await rm(path); });
  t.after(() => setSystemTrashHandler(null));
  const body = { mode: "copy", sources: [computer(join(sandbox, "Here", "From", "doc.txt"))], target: computer(join(sandbox, "Here")), conflicts: { apply: "replace" } };
  const replaced = await call("/api/file-transfer", { method: "POST", body });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual(replaced.body!.replaced, [{ path: relative("/", join(sandbox, "Here", "doc.txt")), recovery: "trash" }]);
  assert.deepEqual(trashed, ["old"]);
  assert.equal(await readFile(join(sandbox, "Here", "doc.txt"), "utf8"), "new");
  assert.deepEqual(replaced.body!.restorePoints, []);

  setSystemTrashHandler(async () => { throw new Error("no Trash"); });
  await writeFile(join(sandbox, "Here", "From", "doc.txt"), "newer");
  const gone = await call("/api/file-transfer", { method: "POST", body });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(gone.body!.replaced[0].recovery, "gone", "with no Trash the host can use, the result says the old item is gone");
  assert.equal(await readFile(join(sandbox, "Here", "doc.txt"), "utf8"), "newer");

  // A move inside the place, onto a folder: merge.
  await mkdir(join(sandbox, "Here", "From", "Box"), { recursive: true });
  await mkdir(join(sandbox, "Here", "Box"));
  await writeFile(join(sandbox, "Here", "From", "Box", "in.txt"), "in");
  await writeFile(join(sandbox, "Here", "Box", "there.txt"), "there");
  const moved = await call("/api/file-transfer", { method: "POST", body: { mode: "move", sources: [computer(join(sandbox, "Here", "From", "Box"))], target: computer(join(sandbox, "Here")), conflicts: { apply: "merge" } } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual((await readdir(join(sandbox, "Here", "Box"))).sort(), ["in.txt", "there.txt"]);
  assert.ok(!existsSync(join(sandbox, "Here", "From", "Box")), "the emptied source folder goes");
});

test("a move inside a Connected Folder that replaces keeps restore points that undo it in order", async (t) => {
  const { call } = await sandboxApi(t);
  const folder = await connectedFolder(call, "Folder");
  await mkdir(join(folder.connectedFolderRoot, "Inbox"));
  await mkdir(join(folder.connectedFolderRoot, "Done"));
  await writeFile(join(folder.connectedFolderRoot, "Inbox", "plan.md"), "new plan");
  await writeFile(join(folder.connectedFolderRoot, "Inbox", "extra.md"), "extra");
  await writeFile(join(folder.connectedFolderRoot, "Done", "plan.md"), "old plan");
  const moved = await call("/api/file-transfer", {
    method: "POST",
    body: {
      mode: "move",
      sources: ["Inbox/plan.md", "Inbox/extra.md"].map((path) => ({ place: { kind: "connected-folder", id: folder.id }, path })),
      target: { place: { kind: "connected-folder", id: folder.id }, path: "Done" },
      conflicts: { apply: "replace" },
    },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body!.written, ["Done/plan.md", "Done/extra.md"]);
  assert.deepEqual(moved.body!.replaced, [{ path: "Done/plan.md", recovery: "history" }]);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Done", "plan.md"), "utf8"), "new plan");
  assert.deepEqual(await readdir(join(folder.connectedFolderRoot, "Inbox")), []);
  assert.equal(moved.body!.restorePoints.length, 2);
  await restore(call, moved.body!.restorePoints);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Inbox", "plan.md"), "utf8"), "new plan");
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Inbox", "extra.md"), "utf8"), "extra");
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Done", "plan.md"), "utf8"), "old plan");
  assert.deepEqual(await readdir(join(folder.connectedFolderRoot, "Done")), ["plan.md"]);
});

test("a move between Connected Folders replaces through the target's delete, and a cancel before that leaves the item there", async (t) => {
  const { call } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  const body = (operationId?: string) => ({
    mode: "move",
    ...(operationId ? { operationId } : {}),
    sources: ["a.txt", "b.txt"].map((path) => ({ place: { kind: "connected-folder", id: source.id }, path })),
    target: { place: { kind: "connected-folder", id: target.id }, path: "" },
    conflicts: { apply: "replace" },
  });
  const plant = async () => {
    for (const name of ["a.txt", "b.txt"]) {
      await writeFile(join(source.connectedFolderRoot, name), `new ${name}`);
      await writeFile(join(target.connectedFolderRoot, name), `old ${name}`);
    }
  };
  await plant();
  // Cancelled before the second item leaves: the first moved over its old one, the second stays and so does its old one.
  let removals = 0;
  cancelAt(t, call, (point) => point === "remove" && ++removals === 2);
  const stopped = await call("/api/file-transfer", { method: "POST", body: body("replace-move") });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body!.cancelled, true);
  assert.deepEqual(stopped.body!.written, ["a.txt"]);
  assert.deepEqual(stopped.body!.notDone, ["b.txt"]);
  assert.deepEqual(stopped.body!.replaced, [{ path: "a.txt", recovery: "history" }]);
  assert.equal(await readFile(join(target.connectedFolderRoot, "a.txt"), "utf8"), "new a.txt");
  assert.equal(await readFile(join(target.connectedFolderRoot, "b.txt"), "utf8"), "old b.txt", "the item the cancel spared is untouched");
  assert.equal(await readFile(join(source.connectedFolderRoot, "b.txt"), "utf8"), "new b.txt");
  assert.ok(!existsSync(join(source.connectedFolderRoot, "a.txt")));
  assert.deepEqual(await visible(target.connectedFolderRoot), ["a.txt", "b.txt"], "no working copy is left");
  await restore(call, stopped.body!.restorePoints);
  assert.equal(await readFile(join(target.connectedFolderRoot, "a.txt"), "utf8"), "old a.txt");
  assert.equal(await readFile(join(source.connectedFolderRoot, "a.txt"), "utf8"), "new a.txt");

  setFileOperationBoundaryHookForTests(null);
  await plant();
  const whole = await call("/api/file-transfer", { method: "POST", body: body() });
  assert.equal(whole.status, 200, JSON.stringify(whole.body));
  assert.deepEqual(whole.body!.written, ["a.txt", "b.txt"]);
  assert.equal(whole.body!.replaced.length, 2);
  assert.deepEqual(await visible(source.connectedFolderRoot), []);
});

test("a replacement cancelled while it is copied leaves the old item and no working file", async (t) => {
  const { call } = await sandboxApi(t);
  setFileCopyStrategyForTests({ clone: false, streamAboveBytes: 1024, chunkBytes: 256 });
  t.after(() => setFileCopyStrategyForTests(null));
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  await writeFile(join(source.connectedFolderRoot, "first.txt"), "first");
  await writeFile(join(source.connectedFolderRoot, "video.mov"), Buffer.alloc(8192, 1));
  await writeFile(join(target.connectedFolderRoot, "video.mov"), "old video");
  cancelAt(t, call, (point, progress) => point === "chunk" && progress.current === "video.mov" && progress.bytesDone > 2048);
  const copied = await call("/api/file-transfer", {
    method: "POST",
    body: {
      mode: "copy",
      operationId: "replace-cancel",
      sources: ["first.txt", "video.mov"].map((path) => ({ place: { kind: "connected-folder", id: source.id }, path })),
      target: { place: { kind: "connected-folder", id: target.id }, path: "" },
      conflicts: { apply: "replace" },
    },
  });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.equal(copied.body!.cancelled, true);
  assert.deepEqual(copied.body!.written, ["first.txt"]);
  assert.deepEqual(copied.body!.notDone, ["video.mov"]);
  assert.deepEqual(copied.body!.replaced, []);
  assert.equal(await readFile(join(target.connectedFolderRoot, "video.mov"), "utf8"), "old video");
  assert.deepEqual((await readdir(target.connectedFolderRoot)).filter((name) => name !== ".amplefile").sort(), ["first.txt", "video.mov"], "no working file is left");
  await restore(call, copied.body!.restorePoints);
  assert.ok(!existsSync(join(target.connectedFolderRoot, "first.txt")));
});

test("Extract asks first, then skips, replaces, or merges into the folder already there", async (t) => {
  const { call } = await sandboxApi(t);
  const folder = await connectedFolder(call, "Folder");
  const zip = new JSZip();
  zip.file("Trip/plan.md", "new plan");
  zip.file("Trip/map.png", "map");
  await writeFile(join(folder.connectedFolderRoot, "Trip.zip"), await zip.generateAsync({ type: "nodebuffer" }));
  await mkdir(join(folder.connectedFolderRoot, "Trip"));
  await writeFile(join(folder.connectedFolderRoot, "Trip", "plan.md"), "old plan");
  await writeFile(join(folder.connectedFolderRoot, "Trip", "notes.md"), "notes");
  const place = { kind: "connected-folder", id: folder.id };
  const extract = (conflicts: unknown) => call("/api/file-transfer/extract", { method: "POST", body: { place, path: "Trip.zip", conflicts } });

  const check = await extract({ check: true });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body!.conflicts.map((conflict: any) => [conflict.key, conflict.source.kind, conflict.existing.kind, conflict.canMerge]), [["Trip", "folder", "folder", true]]);
  // A check does not read the archive, so it cannot count what clashes inside: null has the dialog ask what to do about it all the same.
  assert.equal(check.body!.conflicts[0].insideClashes, null);

  // Merge follows the answer for the same-named items inside: skip leaves the one there, keep-both adds a copy.
  const kept = await extract({ items: { Trip: "merge" }, insideItems: { Trip: "skip" } });
  assert.equal(kept.status, 201, JSON.stringify(kept.body));
  assert.deepEqual(kept.body!.skippedClashes, [{ path: "Trip/plan.md", reason: "chosen" }]);
  assert.deepEqual(kept.body!.replaced, []);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Trip", "plan.md"), "utf8"), "old plan");
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "Trip"))).sort(), ["map.png", "notes.md", "plan.md"]);
  await restore(call, kept.body!.restorePoints);
  const both = await extract({ items: { Trip: "merge" }, insideItems: { Trip: "keep-both" } });
  assert.equal(both.status, 201, JSON.stringify(both.body));
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "Trip"))).sort(), ["map.png", "notes.md", "plan copy.md", "plan.md"]);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Trip", "plan copy.md"), "utf8"), "new plan");
  await restore(call, both.body!.restorePoints);
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "Trip"))).sort(), ["notes.md", "plan.md"]);

  const skipped = await extract({ apply: "skip" });
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.equal(skipped.body!.path, null);
  assert.deepEqual(skipped.body!.skippedClashes, [{ path: "Trip", reason: "chosen" }]);

  const merged = await extract({ apply: "merge", inside: "replace" });
  assert.equal(merged.status, 201, JSON.stringify(merged.body));
  assert.equal(merged.body!.path, "Trip");
  assert.deepEqual(merged.body!.merged, ["Trip"]);
  assert.deepEqual(merged.body!.replaced, [{ path: "Trip/plan.md", recovery: "history" }]);
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "Trip"))).sort(), ["map.png", "notes.md", "plan.md"]);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Trip", "plan.md"), "utf8"), "new plan");
  await restore(call, merged.body!.restorePoints);
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "Trip"))).sort(), ["notes.md", "plan.md"]);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Trip", "plan.md"), "utf8"), "old plan");

  const replaced = await extract({ apply: "replace" });
  assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
  assert.deepEqual(replaced.body!.replaced, [{ path: "Trip", recovery: "history" }]);
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "Trip"))).sort(), ["map.png", "plan.md"]);
  assert.deepEqual(await visible(folder.connectedFolderRoot), ["Trip", "Trip.zip"], "no working folder is left");
  await restore(call, replaced.body!.restorePoints);
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "Trip"))).sort(), ["notes.md", "plan.md"]);

  const plain = await call("/api/file-transfer/extract", { method: "POST", body: { place, path: "Trip.zip" } });
  assert.equal(plain.status, 201);
  assert.equal(plain.body!.path, "Trip copy", "no conflicts field: the “copy” naming");
  assert.equal(plain.body!.replaced, undefined);
});

test("Extract of an archive with loose items asks about the new folder's name like any other clash", async (t) => {
  // The new folder is made under a working name beside the archive: that is not a copy of an item into its own folder.
  const { call } = await sandboxApi(t);
  const folder = await connectedFolder(call, "Folder");
  const zip = new JSZip();
  zip.file("a.txt", "new a");
  zip.file("sub/b.txt", "b");
  await writeFile(join(folder.connectedFolderRoot, "photos.zip"), await zip.generateAsync({ type: "nodebuffer" }));
  await mkdir(join(folder.connectedFolderRoot, "photos"));
  await writeFile(join(folder.connectedFolderRoot, "photos", "a.txt"), "old a");
  await writeFile(join(folder.connectedFolderRoot, "photos", "kept.txt"), "kept");
  const place = { kind: "connected-folder", id: folder.id };
  const extract = (conflicts: unknown) => call("/api/file-transfer/extract", { method: "POST", body: { place, path: "photos.zip", conflicts } });

  const merged = await extract({ items: { photos: "merge" }, inside: "replace" });
  assert.equal(merged.status, 201, JSON.stringify(merged.body));
  assert.equal(merged.body!.path, "photos");
  assert.deepEqual(merged.body!.merged, ["photos"]);
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "photos"))).sort(), ["a.txt", "kept.txt", "sub"]);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "photos", "a.txt"), "utf8"), "new a");

  const replaced = await extract({ items: { photos: "replace" } });
  assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
  assert.equal(replaced.body!.path, "photos");
  assert.deepEqual(replaced.body!.replaced, [{ path: "photos", recovery: "history" }]);
  assert.deepEqual((await readdir(join(folder.connectedFolderRoot, "photos"))).sort(), ["a.txt", "sub"]);
  assert.deepEqual(await visible(folder.connectedFolderRoot), ["photos", "photos.zip"], "no working folder is left");
});

test("Extract of an archive holding one file lands that file beside it and asks about its name", async (t) => {
  const { call } = await sandboxApi(t);
  const folder = await connectedFolder(call, "Folder");
  await writeFile(join(folder.connectedFolderRoot, "report.txt"), "old report");
  const place = { kind: "connected-folder", id: folder.id };
  const compressed = await call("/api/file-transfer/compress", { method: "POST", body: { place, paths: ["report.txt"] } });
  assert.equal(compressed.status, 201, JSON.stringify(compressed.body));
  assert.equal(compressed.body!.path, "report.txt.zip");
  // A newer report travels in the archive.
  const zip = new JSZip();
  zip.file("report.txt", "new report");
  await writeFile(join(folder.connectedFolderRoot, "report.txt.zip"), await zip.generateAsync({ type: "nodebuffer" }));
  const extract = (conflicts?: unknown) => call("/api/file-transfer/extract", { method: "POST", body: { place, path: "report.txt.zip", ...(conflicts ? { conflicts } : {}) } });

  const check = await extract({ check: true });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body!.conflicts.map((conflict: any) => [conflict.key, conflict.source.kind, conflict.existing.kind, conflict.canMerge]), [["report.txt", "file", "file", false]]);

  const skipped = await extract({ items: { "report.txt": "skip" } });
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.equal(skipped.body!.path, null);
  assert.deepEqual(skipped.body!.skippedClashes, [{ path: "report.txt", reason: "chosen" }]);
  assert.deepEqual(await visible(folder.connectedFolderRoot), ["report.txt", "report.txt.zip"], "a skipped Extract writes nothing");

  const replaced = await extract({ items: { "report.txt": "replace" } });
  assert.equal(replaced.status, 201, JSON.stringify(replaced.body));
  assert.equal(replaced.body!.path, "report.txt", "the file itself, not a folder holding it");
  assert.deepEqual(replaced.body!.replaced, [{ path: "report.txt", recovery: "history" }]);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "report.txt"), "utf8"), "new report");
  assert.deepEqual(await visible(folder.connectedFolderRoot), ["report.txt", "report.txt.zip"], "no working folder is left");
  await restore(call, replaced.body!.restorePoints);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "report.txt"), "utf8"), "old report");

  const kept = await extract({ items: { "report.txt": "keep-both" } });
  assert.equal(kept.status, 201, JSON.stringify(kept.body));
  assert.equal(kept.body!.path, "report copy.txt");
  assert.equal(await readFile(join(folder.connectedFolderRoot, "report copy.txt"), "utf8"), "new report");
});

test("Extract never merges into a Mac package: Merge is not offered, and chosen anyway it keeps both", async (t) => {
  const { call } = await sandboxApi(t);
  const folder = await connectedFolder(call, "Folder");
  await mkdir(join(folder.connectedFolderRoot, "Tool.app", "Contents"), { recursive: true });
  await writeFile(join(folder.connectedFolderRoot, "Tool.app", "Contents", "Info.plist"), "old");
  const zip = new JSZip();
  zip.file("Tool.app/Contents/Info.plist", "new");
  zip.file("Tool.app/Contents/MacOS/Tool", "#!/bin/sh\n");
  await writeFile(join(folder.connectedFolderRoot, "Tool.zip"), await zip.generateAsync({ type: "nodebuffer" }));
  const place = { kind: "connected-folder", id: folder.id };
  const extract = (conflicts: unknown) => call("/api/file-transfer/extract", { method: "POST", body: { place, path: "Tool.zip", conflicts } });

  const check = await extract({ check: true });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  const mac = process.platform === "darwin";
  assert.deepEqual(check.body!.conflicts.map((conflict: any) => [conflict.key, conflict.source.kind, conflict.canMerge]), [["Tool.app", "folder", !mac]]);
  if (!mac) return;

  const merged = await extract({ items: { "Tool.app": "merge" } });
  assert.equal(merged.status, 201, JSON.stringify(merged.body));
  assert.notEqual(merged.body!.path, "Tool.app", "nothing was merged into the app");
  assert.deepEqual(merged.body!.merged, []);
  assert.equal(await readFile(join(folder.connectedFolderRoot, "Tool.app", "Contents", "Info.plist"), "utf8"), "old");
  assert.equal(await readFile(join(folder.connectedFolderRoot, merged.body!.path, "Contents", "Info.plist"), "utf8"), "new");
});

test("a quarantined Extract keeps a nested Mac package whole through Merge", { skip: process.platform !== "darwin" }, async (t) => {
  const { call } = await sandboxApi(t);
  const folder = await connectedFolder(call, "Folder");
  const root = folder.connectedFolderRoot;
  const original = join(root, "Import", "Review.pages");
  await mkdir(original, { recursive: true });
  await writeFile(join(original, "old.txt"), "old document data");

  const zip = new JSZip();
  zip.file("Import/Review.pages/new.txt", "new document data");
  const archive = join(root, "review.zip");
  await writeFile(archive, await zip.generateAsync({ type: "nodebuffer" }));
  const quarantine = "0081;00000000;AmpleFileTest;";
  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", quarantine, archive]);

  const place = { kind: "connected-folder", id: folder.id };
  const merged = await call("/api/file-transfer/extract", { method: "POST", body: { place, path: "review.zip", conflicts: { items: { Import: "merge" }, insideItems: { Import: "replace" } } } });
  assert.equal(merged.status, 201, JSON.stringify(merged.body));
  assert.deepEqual(await readdir(original), ["old.txt"]);
  const newPackage = join(root, "Import", "Review copy.pages");
  assert.equal(await readFile(join(newPackage, "new.txt"), "utf8"), "new document data");
  assert.equal(execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", newPackage], { encoding: "utf8" }).trim(), quarantine);
});

test("a replaced item History cannot keep goes whole into Recently Deleted", async (t) => {
  const { api, call } = await sandboxApi(t);
  const source = await connectedFolder(call, "Source");
  const target = await connectedFolder(call, "Target");
  await writeFile(join(source.connectedFolderRoot, "big.bin"), "new and also larger than the cap");
  await writeFile(join(target.connectedFolderRoot, "big.bin"), "old and also larger than the cap");
  const previousCap = process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES;
  process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = "8";
  t.after(() => { if (previousCap === undefined) delete process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES; else process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = previousCap; });
  const copied = await call("/api/file-transfer", {
    method: "POST",
    body: {
      mode: "copy",
      sources: [{ place: { kind: "connected-folder", id: source.id }, path: "big.bin" }],
      target: { place: { kind: "connected-folder", id: target.id }, path: "" },
      conflicts: { apply: "replace" },
    },
  });
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  const [replaced] = copied.body!.replaced;
  assert.equal(replaced.path, "big.bin");
  assert.equal(replaced.recovery, "recently-deleted");
  assert.equal(typeof replaced.entryId, "string");
  assert.equal(typeof replaced.restoreBy, "string");
  const entries = (await api.recentlyDeleted.list()).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, replaced.entryId);
  assert.equal(await readFile(join(target.connectedFolderRoot, "big.bin"), "utf8"), "new and also larger than the cap");
});
