import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { resolveConnectedFolderPath, scanConnectedFolderTree } from "../src/local/connected-folder.js";
import { AmpleFileCliError, parseAmpleFileCliActArgv } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";

// Rename, move, New Folder, and New File have one owner each, reached from the
// window's routes and from the CLI's act lane. Whatever name the effect gives
// the item is the name its History restore point and its receipt describe.

async function startConnectedFolder(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-file-verbs-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "File Verbs" });
  const root = connectedFolder.connectedFolderRoot;
  const base = `${api.origin}/api/connected-folders/${connectedFolder.id}`;
  async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  }
  async function restoreOverHttp(checkpointId: string): Promise<void> {
    const restored = await post(`/history/checkpoints/${checkpointId}/restore`, {});
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
  }
  async function listing(): Promise<string[]> {
    const walk = async (dir: string, prefix: string): Promise<string[]> => {
      const names: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!prefix && (entry.name === ".amplefile" || entry.name === ".work-fold")) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        names.push(path);
        if (entry.isDirectory()) names.push(...await walk(join(dir, entry.name), path));
      }
      return names;
    };
    return (await walk(root, "")).sort();
  }
  return { api, sandbox, facade: api.actFacade, id: connectedFolder.id, root, post, restoreOverHttp, listing };
}

const usage = (error: unknown) => error instanceof AmpleFileCliError && error.code === "usage" && /240 characters/.test(error.message);

test("the resolver preserves edge and inner spaces in file names", async (t) => {
  const { root } = await startConnectedFolder(t);
  for (const path of [" left.txt", "right.txt ", "inner space.txt", "dir/ name "]) {
    assert.equal(resolveConnectedFolderPath(root, path), join(root, path));
  }
  assert.equal(resolveConnectedFolderPath(root, ""), root);
  await writeFile(join(root, "sentinel"), "root item");
  assert.ok((await scanConnectedFolderTree(root, 0, "   ")).entries.some((entry) => entry.name === "sentinel"));
});

test("a CLI creation path preserves a parent whose name is a space", async (t) => {
  const { facade, id, root } = await startConnectedFolder(t);
  await mkdir(join(root, " "));
  const path = " /child.txt";
  const created = await facade.filesCreate({ connectedFolder: id, path });
  assert.equal(created.path, path);
  assert.equal(existsSync(join(root, path)), true);
  assert.equal(existsSync(join(root, "child.txt")), false);
  await facade.historyRestore({ connectedFolder: id, checkpointId: created.safetyCheckpointId });
  assert.equal(existsSync(join(root, path)), false);
});

test("whole-folder History restores exact spaced names and leaves their twins alone", async (t) => {
  const { facade, id, root } = await startConnectedFolder(t);
  const originals = { " left.txt": "saved left", "right.txt ": "saved right", "left.txt": "twin left", "right.txt": "twin right" };
  for (const [path, bytes] of Object.entries(originals)) await writeFile(join(root, path), bytes);
  const saved = await facade.historySave({ connectedFolder: id });
  await writeFile(join(root, " left.txt"), "edited");
  await rm(join(root, "right.txt "));
  await facade.historyRestore({ connectedFolder: id, checkpointId: saved.checkpoint.checkpointId });
  for (const [path, bytes] of Object.entries(originals)) assert.equal(await readFile(join(root, path), "utf8"), bytes, path);
});

test("CLI file mutations preserve spaced sources and destinations", async (t) => {
  const { facade, id, root } = await startConnectedFolder(t);
  await mkdir(join(root, " archive "));
  await writeFile(join(root, " left.txt"), "spaced");
  await writeFile(join(root, "left.txt"), "twin");
  const rename = parseAmpleFileCliActArgv(["files", "rename", "--connected-folder", id, "--path", " left.txt", "--name", "right.txt "]);
  assert.equal(rename.path, " left.txt");
  assert.equal(rename.entryName, "right.txt ");
  const renamed = await facade.filesRename({ connectedFolder: id, path: rename.path!, newName: rename.entryName! });
  assert.equal(renamed.path, "right.txt ");
  await writeFile(join(root, "right.txt"), "other twin");
  const move = parseAmpleFileCliActArgv(["files", "move", "--connected-folder", id, "--from", renamed.path, "--to", " archive "]);
  assert.equal(move.toDir, " archive ");
  const moved = await facade.filesMove({ connectedFolder: id, fromPath: move.fromPaths![0]!, toDir: move.toDir! });
  assert.equal(moved.path, " archive /right.txt ");
  const twin = join(root, " archive ", "right.txt");
  await writeFile(twin, "nested twin");
  assert.equal(await readFile(join(root, moved.path), "utf8"), "spaced");
  await facade.filesDelete({ connectedFolder: id, path: moved.path });
  assert.equal(existsSync(join(root, moved.path)), false);
  assert.equal(await readFile(twin, "utf8"), "nested twin");
  assert.equal(await readFile(join(root, "left.txt"), "utf8"), "twin");
  assert.equal(await readFile(join(root, "right.txt"), "utf8"), "other twin");
});

test("a name longer than 240 characters is refused by every file verb on both surfaces, and nothing changes", async (t) => {
  const { facade, id, root, post, listing } = await startConnectedFolder(t);
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "a.txt"), "a", "utf8");
  const before = await listing();
  const long = `${"n".repeat(237)}.md`;
  assert.equal(long.length, 240);
  const tooLong = `${"n".repeat(238)}.md`;

  for (const [path, body] of [
    ["/rename-local-entry", { path: "notes/a.txt", newName: tooLong }],
    ["/folders", { parentPath: "notes", name: tooLong }],
    ["/files", { parentPath: "notes", name: tooLong, text: "x" }],
  ] as const) {
    const refused = await post(path, body);
    assert.equal(refused.status, 400, `${path}: ${JSON.stringify(refused.json)}`);
    assert.match(String(refused.json.error), /240 characters/);
  }
  await assert.rejects(() => facade.filesRename({ connectedFolder: id, path: "notes/a.txt", newName: tooLong }), usage);
  await assert.rejects(() => facade.filesMkdir({ connectedFolder: id, path: `notes/${tooLong}` }), usage);
  await assert.rejects(() => facade.filesCreate({ connectedFolder: id, path: `notes/${tooLong}` }), usage);
  assert.deepEqual(await listing(), before);

  // The limit itself is allowed, and is kept whole.
  const renamed = await post("/rename-local-entry", { path: "notes/a.txt", newName: long });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal((renamed.json.renamed as { path: string }).path, `notes/${long}`);
  assert.equal(existsSync(join(root, "notes", long)), true);
});

test("restoring a rename's History point puts back the original name, whatever name the rename was given", async (t) => {
  const { facade, id, root, post, restoreOverHttp } = await startConnectedFolder(t);
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "draft.md"), "draft", "utf8");

  // The window's rename route.
  const renamed = await post("/rename-local-entry", { path: "notes/draft.md", newName: "  final.md  " });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal((renamed.json.renamed as { path: string }).path, "notes/final.md");
  await restoreOverHttp(renamed.json.safetyCheckpointId as string);
  assert.equal(existsSync(join(root, "notes", "draft.md")), true);
  assert.equal(existsSync(join(root, "notes", "final.md")), false);

  // `files rename` on the CLI.
  const cliRenamed = await facade.filesRename({ connectedFolder: id, path: "notes/draft.md", newName: "  final.md  " });
  assert.equal(cliRenamed.path, "notes/  final.md  ");
  assert.equal(cliRenamed.fromPath, "notes/draft.md");
  assert.equal(cliRenamed.priorName, "draft.md");
  await facade.historyRestore({ connectedFolder: id, checkpointId: cliRenamed.safetyCheckpointId });
  assert.equal(existsSync(join(root, "notes", "draft.md")), true);
  assert.equal(existsSync(join(root, "notes", "final.md")), false);
});

test("restoring a move's History point puts the item back, on both surfaces", async (t) => {
  const { facade, id, root, post, restoreOverHttp } = await startConnectedFolder(t);
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "archive"));
  await writeFile(join(root, "docs", "plan.md"), "plan", "utf8");

  const moved = await post("/move-local-entry", { sourcePath: "docs/plan.md", targetFolderPath: "archive/" });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal((moved.json.moved as { path: string }).path, "archive/plan.md");
  await restoreOverHttp(moved.json.safetyCheckpointId as string);
  assert.equal(existsSync(join(root, "docs", "plan.md")), true);
  assert.equal(existsSync(join(root, "archive", "plan.md")), false);

  const cliMoved = await facade.filesMove({ connectedFolder: id, fromPath: "docs/plan.md", toDir: "archive" });
  assert.equal(cliMoved.path, "archive/plan.md");
  await facade.historyRestore({ connectedFolder: id, checkpointId: cliMoved.safetyCheckpointId });
  assert.equal(existsSync(join(root, "docs", "plan.md")), true);
  assert.equal(existsSync(join(root, "archive", "plan.md")), false);
});

test("restoring a New Folder or New File History point removes the item it made, on both surfaces", async (t) => {
  const { facade, id, root, post, restoreOverHttp, listing } = await startConnectedFolder(t);
  await mkdir(join(root, "notes"));
  const before = await listing();

  // The window's New Folder and New File, with names the effect trims.
  const folder = await post("/folders", { parentPath: "notes", name: " Made Folder " });
  assert.equal(folder.status, 201, JSON.stringify(folder.json));
  assert.equal((folder.json.folder as { path: string }).path, "notes/Made Folder");
  await restoreOverHttp(folder.json.safetyCheckpointId as string);
  assert.deepEqual(await listing(), before);

  const file = await post("/files", { parentPath: "notes", name: " made.md ", text: "made" });
  assert.equal(file.status, 201, JSON.stringify(file.json));
  assert.equal((file.json.file as { path: string }).path, "notes/made.md");
  await restoreOverHttp(file.json.safetyCheckpointId as string);
  assert.deepEqual(await listing(), before);

  // `files mkdir` and `files create` on the CLI.
  const cliFolder = await facade.filesMkdir({ connectedFolder: id, path: "notes/ Made Folder" });
  assert.equal(cliFolder.path, "notes/ Made Folder");
  await facade.historyRestore({ connectedFolder: id, checkpointId: cliFolder.safetyCheckpointId });
  assert.deepEqual(await listing(), before);

  const cliFile = await facade.filesCreate({ connectedFolder: id, path: "notes/ made.md" });
  assert.equal(cliFile.path, "notes/ made.md");
  await facade.historyRestore({ connectedFolder: id, checkpointId: cliFile.safetyCheckpointId });
  assert.deepEqual(await listing(), before);
});

test("while an automation run counts an act as its own, every verb that places or moves files reports their device and inode", async (t) => {
  const { api, sandbox, facade, id, root } = await startConnectedFolder(t);
  const placed: Array<{ connectedFolderId?: string; taskId?: string; fileIds: string[]; vacatedFileIds: string[] }> = [];
  const asked: Array<{ connectedFolderId?: string; taskId?: string }> = [];
  let counts = true;
  api.automations.countsAsRunWork = (act) => { asked.push({ ...act }); return counts; };
  api.automations.notePlacedFiles = (act) => { placed.push({ ...act, fileIds: [...act.fileIds], vacatedFileIds: [...(act.vacatedFileIds ?? [])] }); };
  const fileId = async (path: string) => {
    const info = await lstat(join(root, path), { bigint: true });
    return `${info.dev}:${info.ino}`;
  };
  const last = () => placed.at(-1)!;
  await writeFile(join(sandbox, "outside.md"), "from elsewhere", "utf8");

  await facade.filesMkdir({ connectedFolder: id, path: "notes" });
  assert.deepEqual(last(), { connectedFolderId: id, fileIds: [], vacatedFileIds: [] }, "a new folder holds no files");
  await facade.filesCreate({ connectedFolder: id, path: "notes/new.md" });
  assert.deepEqual(last(), { connectedFolderId: id, fileIds: [await fileId("notes/new.md")], vacatedFileIds: [] });
  // A rename or move places the file where it went and vacates the name it left.
  await facade.filesRename({ connectedFolder: id, path: "notes/new.md", newName: "renamed.md" });
  assert.deepEqual(last(), { connectedFolderId: id, fileIds: [await fileId("notes/renamed.md")], vacatedFileIds: [await fileId("notes/renamed.md")] });
  await facade.filesMkdir({ connectedFolder: id, path: "archive" });
  await facade.filesMove({ connectedFolder: id, fromPath: "notes/renamed.md", toDir: "archive" });
  assert.deepEqual(last(), { connectedFolderId: id, fileIds: [await fileId("archive/renamed.md")], vacatedFileIds: [await fileId("archive/renamed.md")] });
  await facade.addFiles({ connectedFolder: id, fromPaths: [join(sandbox, "outside.md")], toDir: "notes", cwd: sandbox });
  assert.deepEqual(last().fileIds, [await fileId("notes/outside.md")]);

  // A path typed in another case names the same file on a case-insensitive
  // disk; the identity is the file's, whatever the caller typed.
  await mkdir(join(root, "Screenshots"));
  if (existsSync(join(root, "SCREENSHOTS"))) {
    const created = await facade.filesCreate({ connectedFolder: id, path: "screenshots/typed.png" });
    assert.equal(created.path, "screenshots/typed.png");
    assert.deepEqual(last().fileIds, [await fileId("Screenshots/typed.png")]);
  }

  // A delete vacates the name, measured before the file goes.
  await writeFile(join(root, "notes", "doomed.md"), "doomed", "utf8");
  const doomed = await fileId("notes/doomed.md");
  await facade.filesDelete({ connectedFolder: id, path: "notes/doomed.md" });
  assert.deepEqual(last(), { connectedFolderId: id, fileIds: [], vacatedFileIds: [doomed] });

  // Restores put files back with new inodes.
  await writeFile(join(root, "notes", "kept.md"), "first", "utf8");
  const checkpoint = (await facade.historySave({ connectedFolder: id, label: "before" })).checkpoint;
  await rm(join(root, "notes", "kept.md"));
  await facade.historyRestore({ connectedFolder: id, checkpointId: checkpoint.checkpointId });
  assert.ok(last().fileIds.includes(await fileId("notes/kept.md")), "history restore");
  const version = (await facade.historyVersions({ connectedFolder: id, path: "notes/kept.md" })).versions[0]!;
  await writeFile(join(root, "notes", "kept.md"), "second", "utf8");
  await facade.historyRestoreFile({ connectedFolder: id, path: "notes/kept.md", version: version.hashSha256 });
  assert.deepEqual(last().fileIds, [await fileId("notes/kept.md")], "history restore-file");
  process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES = "1";
  let deleted;
  try {
    deleted = await facade.filesDelete({ connectedFolder: id, path: "notes/outside.md" });
  } finally {
    delete process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES;
  }
  const recovery = deleted.recovery as { kind?: string; entryId?: string };
  assert.equal(recovery.kind, "recently-deleted");
  await facade.recentlyDeletedRestore({ entry: recovery.entryId! });
  assert.deepEqual(last(), { connectedFolderId: id, fileIds: [await fileId("notes/outside.md")], vacatedFileIds: [] }, "recently-deleted restore");
  assert.ok(asked.every((act) => act.connectedFolderId === id && act.taskId === undefined));

  // An act that is no run's work is not even measured.
  counts = false;
  const before = placed.length;
  await facade.filesCreate({ connectedFolder: id, path: "notes/by a person.md" });
  assert.equal(placed.length, before);
});
