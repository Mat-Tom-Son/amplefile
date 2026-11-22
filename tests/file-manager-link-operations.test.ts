import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveConnectedFolderPath } from "../src/local/connected-folder.js";
import { startLocalApi } from "../src/local/server.js";
import { addSidebarFolder, assertStandardFolderPathUnowned, resolveStandardFolderPath } from "../src/local/standard-folders.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";

/**
 * A symbolic link is an item in the file manager (docs/product-model.md,
 * "Symbolic links"): Rename, Delete, Copy, Duplicate, Move, and Compress act
 * on the link itself, a broken link included, and never on what it points
 * to. Copying or moving a link recreates the link as written. A link in the
 * middle of a path is still never traversed: nothing is written through a
 * link, into a linked folder, or read from inside one.
 */

const links = ["notes link", "Projects link", "broken link"] as const;
const targets: Record<(typeof links)[number], string> = { "notes link": "notes.txt", "Projects link": "Projects", "broken link": "gone.txt" };

async function sandbox(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amplefile-link-operations-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A folder with a file, a folder, a link to each, and a broken link. */
async function linkedFolder(folder: string): Promise<void> {
  await mkdir(join(folder, "Projects"), { recursive: true });
  await mkdir(join(folder, "Elsewhere"), { recursive: true });
  await writeFile(join(folder, "notes.txt"), "notes");
  await writeFile(join(folder, "Projects", "plan.md"), "# Plan\n");
  for (const link of links) await symlink(targets[link], join(folder, link));
}

/** Every name in the folder (one level down too), with each link's target. */
async function snapshot(folder: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number) => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === ".amplefile") continue;
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) out.push(`${prefix}${name} -> ${await readlink(path)}`);
      else out.push(`${prefix}${name}${info.isDirectory() ? "/" : ""}`);
      if (info.isDirectory() && depth < 1) await walk(path, `${prefix}${name}/`, depth + 1);
    }
  };
  await walk(folder, "", 0);
  return out;
}

/** The targets the folder's own items keep: a link operation never touches them. */
async function targetsUntouched(folder: string): Promise<void> {
  assert.equal(await readFile(join(folder, "notes.txt"), "utf8"), "notes");
  assert.equal(await readFile(join(folder, "Projects", "plan.md"), "utf8"), "# Plan\n");
}

async function assertLink(path: string, target: string, label: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  assert.ok(info?.isSymbolicLink(), `${label}: ${path} is a link`);
  assert.equal(await readlink(path), target, `${label}: points where it did`);
}

/** Each zip entry's name and Unix file type, read from the central directory. */
async function zipEntryTypes(path: string): Promise<Map<string, { type: number; content: string }>> {
  const bytes = await readFile(path);
  const entries = new Map<string, { type: number; content: string }>();
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const size = bytes.readUInt32LE(offset + 20);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localName = bytes.readUInt16LE(local + 26);
    const localExtra = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    entries.set(name, { type: mode & 0o170000, content: bytes.subarray(start, start + size).toString("utf8") });
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function startApi(t: test.TestContext, root: string) {
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "content"), loadEnv: false });
  t.after(async () => { await api.close(); configureAmpleFileStateRoot(undefined); });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${api.origin}${path}`, {
      method,
      ...(body instanceof FormData ? { body } : body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
  };
  return { api, call };
}

async function connect(call: Awaited<ReturnType<typeof startApi>>["call"], folder: string): Promise<string> {
  const registered = await call("POST", "/api/connected-folders/local-folder", { connectedFolderRoot: folder });
  assert.equal(registered.status, 201, registered.text);
  return (registered.json() as { connectedFolder: { id: string } }).connectedFolder.id;
}

test("the path policy lets the last segment be a link only when asked, and never a link before it", async (t) => {
  const root = await sandbox(t);
  await linkedFolder(root);
  for (const name of links) {
    assert.throws(() => resolveConnectedFolderPath(root, name), /symbolic links/, `${name}: refused by default`);
    assert.equal(resolveConnectedFolderPath(root, name, { finalLink: true }), join(root, name), `${name}: the link itself, when asked`);
    assert.throws(() => resolveConnectedFolderPath(root, `${name}/inside.txt`), /symbolic links/, `${name}/inside.txt`);
    assert.throws(() => resolveConnectedFolderPath(root, `${name}/inside.txt`, { finalLink: true }), /symbolic links/, `${name}/inside.txt with finalLink`);
  }
  assert.throws(() => resolveConnectedFolderPath(root, "Projects link/plan.md", { finalLink: true }), /symbolic links/, "a real file behind a linked folder");
  assert.equal(resolveConnectedFolderPath(root, "notes.txt", { finalLink: true }), join(root, "notes.txt"));
  assert.equal(resolveConnectedFolderPath(root, "not-there-yet.txt"), join(root, "not-there-yet.txt"), "a name nothing holds yet still resolves");
});

test("a Connected Folder still refuses every change through or into a link", async (t) => {
  const root = await sandbox(t);
  const folder = join(root, "Folder");
  await mkdir(folder);
  await linkedFolder(folder);
  const { call } = await startApi(t, root);
  const id = await connect(call, folder);
  const base = `/api/connected-folders/${id}`;
  const place = { kind: "connected-folder", id };
  const before = await snapshot(folder);
  const accepted: string[] = [];
  const changed: string[] = [];
  for (const link of links) {
    const upload = new FormData();
    upload.set("targetFolderPath", link);
    upload.set("relativePaths", JSON.stringify(["added.txt"]));
    upload.append("files", new Blob(["added"]), "added.txt");
    const attempts: Array<[string, string, string, unknown]> = [
      ["move into", "POST", `${base}/move-local-entry`, { sourcePath: "notes.txt", targetFolderPath: link }],
      ["write", "PUT", `${base}/file`, { path: link, text: "changed" }],
      ["new folder in", "POST", `${base}/folders`, { parentPath: link, name: "Inside" }],
      ["new file in", "POST", `${base}/files`, { parentPath: link, name: "inside.txt", text: "" }],
      ["add files to", "POST", `${base}/upload-local-files`, upload],
      ["connect", "POST", `${base}/nested-folders`, { path: link }],
      ["copy into", "POST", "/api/file-transfer", { mode: "copy", sources: [{ place, path: "notes.txt" }], target: { place, path: link } }],
      ["copy from inside", "POST", "/api/file-transfer", { mode: "copy", sources: [{ place, path: `${link}/plan.md` }], target: { place, path: "Elsewhere" } }],
      ["delete inside", "DELETE", `${base}/local-file`, { path: `${link}/plan.md` }],
      ["rename inside", "POST", `${base}/rename-local-entry`, { path: `${link}/plan.md`, newName: "other.md" }],
      ["extract", "POST", "/api/file-transfer/extract", { place, path: link }],
    ];
    for (const [label, method, path, body] of attempts) {
      const result = await call(method, path, body);
      if (result.status < 400) accepted.push(`${label} “${link}” answered ${result.status}: ${result.text}`);
      if ((await snapshot(folder)).join("\n") !== before.join("\n")) changed.push(`${label} “${link}”`);
    }
  }
  assert.deepEqual(accepted, [], "nothing is written through or into a link");
  assert.deepEqual(changed, [], "a refused change leaves the folder as it was");
});

test("in a Connected Folder a link copies, duplicates, compresses, renames, moves, and deletes as itself", async (t) => {
  const root = await sandbox(t);
  const folder = join(root, "Folder");
  await mkdir(folder);
  await linkedFolder(folder);
  const { call } = await startApi(t, root);
  const id = await connect(call, folder);
  const base = `/api/connected-folders/${id}`;
  const place = { kind: "connected-folder", id };

  for (const link of links) {
    const target = targets[link];
    const copied = await call("POST", "/api/file-transfer", { mode: "copy", sources: [{ place, path: link }], target: { place, path: "Elsewhere" } });
    assert.equal(copied.status, 200, `copy ${link}: ${copied.text}`);
    assert.deepEqual(copied.json().written, [`Elsewhere/${link}`]);
    await assertLink(join(folder, "Elsewhere", link), target, `copy ${link}`);

    const duplicated = await call("POST", "/api/file-transfer", { mode: "duplicate", sources: [{ place, path: link }], target: { place, path: "" } });
    assert.equal(duplicated.status, 200, `duplicate ${link}: ${duplicated.text}`);
    await assertLink(join(folder, `${link} copy`), target, `duplicate ${link}`);

    const compressed = await call("POST", "/api/file-transfer/compress", { place, paths: [link] });
    assert.equal(compressed.status, 201, `compress ${link}: ${compressed.text}`);
    const zip = await zipEntryTypes(join(folder, compressed.json().path as string));
    assert.deepEqual([...zip.entries()], [[link, { type: 0o120000, content: target }]], `compress ${link} stores the link, not its target`);

    const renamed = await call("POST", `${base}/rename-local-entry`, { path: `${link} copy`, newName: `${link} renamed` });
    assert.equal(renamed.status, 200, `rename ${link}: ${renamed.text}`);
    await assertLink(join(folder, `${link} renamed`), target, `rename ${link}`);
    // Undo through History: the rename's restore point moves the link back.
    const undone = await call("POST", `${base}/history/checkpoints/${renamed.json().safetyCheckpointId as string}/restore`, {});
    assert.equal(undone.status, 200, `undo rename ${link}: ${undone.text}`);
    await assertLink(join(folder, `${link} copy`), target, `undo rename ${link}`);

    const moved = await call("POST", "/api/file-transfer", { mode: "move", sources: [{ place, path: `${link} copy` }], target: { place, path: "Projects" } });
    assert.equal(moved.status, 200, `move ${link}: ${moved.text}`);
    await assertLink(join(folder, "Projects", `${link} copy`), target, `move ${link}`);

    // History keeps no copy of a link, so a deleted link waits in Recently Deleted.
    const deleted = await call("DELETE", `${base}/local-file`, { path: `Projects/${link} copy` });
    assert.equal(deleted.status, 200, `delete ${link}: ${deleted.text}`);
    assert.equal(await lstat(join(folder, "Projects", `${link} copy`)).catch(() => null), null, `delete ${link}`);
    const entryId = (deleted.json().recentlyDeleted as { entryId?: string } | undefined)?.entryId;
    assert.ok(entryId, `delete ${link} names its Recently Deleted entry: ${deleted.text}`);
    const restored = await call("POST", `/api/settings/recently-deleted/${entryId}/restore`, {});
    assert.equal(restored.status, 200, `restore ${link}: ${restored.text}`);
    await assertLink(join(folder, "Projects", `${link} copy`), target, `restore ${link}`);

    const deletedMany = await call("DELETE", `${base}/local-files`, { paths: [`Elsewhere/${link}`] });
    assert.equal(deletedMany.status, 200, `delete several ${link}: ${deletedMany.text}`);
    assert.equal(await lstat(join(folder, "Elsewhere", link)).catch(() => null), null);
    await targetsUntouched(folder);
  }
  // The original links are where they were, pointing where they did.
  for (const link of links) await assertLink(join(folder, link), targets[link], `original ${link}`);
});

test("a move between Connected Folders carries a link as a link", async (t) => {
  const root = await sandbox(t);
  const from = join(root, "From");
  const to = join(root, "To");
  await mkdir(from);
  await mkdir(to);
  await linkedFolder(from);
  const { call } = await startApi(t, root);
  const fromId = await connect(call, from);
  const toId = await connect(call, to);
  const moved = await call("POST", "/api/file-transfer", {
    mode: "move",
    sources: links.map((path) => ({ place: { kind: "connected-folder", id: fromId }, path })),
    target: { place: { kind: "connected-folder", id: toId }, path: "" },
  });
  assert.equal(moved.status, 200, moved.text);
  for (const link of links) {
    await assertLink(join(to, link), targets[link], `moved ${link}`);
    assert.equal(await lstat(join(from, link)).catch(() => null), null, `${link} left its source`);
  }
  await targetsUntouched(from);
});

test("in a Standard Folder and an other folder a link renames, copies, duplicates, moves, and compresses as itself", async (t) => {
  const root = await sandbox(t);
  const added = join(root, "Added");
  await mkdir(added);
  await linkedFolder(added);
  const { call } = await startApi(t, root);
  const sidebar = addSidebarFolder(added, root);
  const places = [
    { place: { kind: "standard", id: sidebar.id }, prefix: "" },
    { place: { kind: "standard", id: "computer" }, prefix: `${added.slice(1)}/` },
  ];
  for (const { place, prefix } of places) {
    const base = `/api/standard-folders/${place.id}`;
    for (const name of links) {
      const link = `${prefix}${name}`;
      const target = targets[name];
      assert.equal(resolveStandardFolderPath(place.id, link, root, { finalLink: true }), join(added, name));
      assert.equal(await assertStandardFolderPathUnowned(place.id, link, root, { finalLink: true }), join(added, name));
      assert.throws(() => resolveStandardFolderPath(place.id, link, root), /symbolic links/, "refused unless asked");
      assert.throws(() => resolveStandardFolderPath(place.id, `${link}/plan.md`, root, { finalLink: true }), /symbolic links/, "never through it");

      const copied = await call("POST", "/api/file-transfer", { mode: "copy", sources: [{ place, path: link }], target: { place, path: `${prefix}Elsewhere` } });
      assert.equal(copied.status, 200, `${place.id}: copy ${name}: ${copied.text}`);
      await assertLink(join(added, "Elsewhere", name), target, `${place.id}: copy ${name}`);
      await rm(join(added, "Elsewhere", name));

      const duplicated = await call("POST", "/api/file-transfer", { mode: "duplicate", sources: [{ place, path: link }], target: { place, path: prefix.replace(/\/$/, "") } });
      assert.equal(duplicated.status, 200, `${place.id}: duplicate ${name}: ${duplicated.text}`);
      await assertLink(join(added, `${name} copy`), target, `${place.id}: duplicate ${name}`);

      const renamed = await call("POST", `${base}/rename-local-entry`, { path: `${link} copy`, newName: `${name} renamed` });
      assert.equal(renamed.status, 200, `${place.id}: rename ${name}: ${renamed.text}`);
      await assertLink(join(added, `${name} renamed`), target, `${place.id}: rename ${name}`);

      const moved = await call("POST", "/api/file-transfer", { mode: "move", sources: [{ place, path: `${prefix}${name} renamed` }], target: { place, path: `${prefix}Elsewhere` } });
      assert.equal(moved.status, 200, `${place.id}: move ${name}: ${moved.text}`);
      await assertLink(join(added, "Elsewhere", `${name} renamed`), target, `${place.id}: move ${name}`);
      await rm(join(added, "Elsewhere", `${name} renamed`));

      const compressed = await call("POST", "/api/file-transfer/compress", { place, paths: [link] });
      assert.equal(compressed.status, 201, `${place.id}: compress ${name}: ${compressed.text}`);
      const archive = join(added, `${name}.zip`);
      assert.deepEqual([...(await zipEntryTypes(archive)).entries()], [[name, { type: 0o120000, content: target }]]);
      await rm(archive);

      for (const [label, method, path, body] of [
        ["new folder in", "POST", `${base}/folders`, { parentPath: link, name: "Inside" }],
        ["connect", "POST", `${base}/connected-folders`, { path: link }],
        ["copy into", "POST", "/api/file-transfer", { mode: "copy", sources: [{ place, path: `${prefix}notes.txt` }], target: { place, path: link } }],
        ["extract", "POST", "/api/file-transfer/extract", { place, path: link }],
      ] as Array<[string, string, string, unknown]>) {
        const result = await call(method, path, body);
        assert.ok(result.status >= 400, `${place.id}: ${label} “${link}” is refused: ${result.status} ${result.text}`);
      }
      await targetsUntouched(added);
      await assertLink(join(added, name), target, `${place.id}: original ${name}`);
    }
  }
});

test("a folder holding links compresses them as links", async (t) => {
  const root = await sandbox(t);
  const folder = join(root, "Folder");
  await mkdir(folder);
  await linkedFolder(folder);
  await symlink("plan.md", join(folder, "Projects", "plan link"));
  const { call } = await startApi(t, root);
  const id = await connect(call, folder);
  const compressed = await call("POST", "/api/file-transfer/compress", { place: { kind: "connected-folder", id }, paths: ["Projects"] });
  assert.equal(compressed.status, 201, compressed.text);
  const entries = await zipEntryTypes(join(folder, "Projects.zip"));
  assert.deepEqual(entries.get("Projects/plan link"), { type: 0o120000, content: "plan.md" });
  assert.equal(entries.get("Projects/plan.md")?.type, 0o100000);
  // Extract makes the link again, since it stays inside the new folder.
  const moved = await call("POST", "/api/file-transfer/extract", { place: { kind: "connected-folder", id }, path: "Projects.zip" });
  assert.equal(moved.status, 201, moved.text);
  await assertLink(join(folder, moved.json().path as string, "plan link"), "plan.md", "extracted link");
});
