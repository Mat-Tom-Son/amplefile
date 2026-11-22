import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveConnectedFolderPath } from "../src/local/connected-folder.js";
import { startLocalApi } from "../src/local/server.js";
import { addSidebarFolder, assertStandardFolderPathUnowned, resolveStandardFolderPath } from "../src/local/standard-folders.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";

/**
 * The file manager window shows symbolic links but offers only Open, Show in
 * the system file manager, and Copy Path on one. The host refuses every other
 * change to a link row too, a broken link included: renaming, deleting,
 * moving, copying, compressing, extracting, writing, ignoring, making a
 * folder in it, adding files to it, or connecting it. Each refusal leaves
 * the folder exactly as it was.
 */

const links = ["notes link", "Projects link", "broken link"] as const;

async function sandbox(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amplefile-link-refusals-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A folder with a file, a folder, a link to each, and a broken link. */
async function linkedFolder(folder: string): Promise<void> {
  await mkdir(join(folder, "Projects"), { recursive: true });
  await writeFile(join(folder, "notes.txt"), "notes");
  await writeFile(join(folder, "Projects", "plan.md"), "# Plan\n");
  await symlink("notes.txt", join(folder, "notes link"));
  await symlink("Projects", join(folder, "Projects link"));
  await symlink("gone.txt", join(folder, "broken link"));
}

/** Every name in the folder (one level down too), with each link's target: what a refused change must leave alone. */
async function snapshot(folder: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (directory: string, prefix: string, depth: number) => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === ".amplefile") continue;
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) out.push(`${prefix}${name} -> ${await readlink(path)}`);
      else out.push(`${prefix}${name}${info.isDirectory() ? "/" : ""}`);
      if (info.isDirectory() && !info.isSymbolicLink() && depth < 1) await walk(path, `${prefix}${name}/`, depth + 1);
    }
  };
  await walk(folder, "", 0);
  return out;
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
    return { status: response.status, text };
  };
  return { api, call };
}

test("the path policy refuses a broken link's own name, as it refuses a working link", async (t) => {
  const root = await sandbox(t);
  await linkedFolder(root);
  for (const name of links) {
    assert.throws(() => resolveConnectedFolderPath(root, name), /symbolic links/, name);
    assert.throws(() => resolveConnectedFolderPath(root, `${name}/inside.txt`), /symbolic links/, `${name}/inside.txt`);
  }
  assert.equal(resolveConnectedFolderPath(root, "notes.txt"), join(root, "notes.txt"));
  assert.equal(resolveConnectedFolderPath(root, "not-there-yet.txt"), join(root, "not-there-yet.txt"), "a name nothing holds yet still resolves");
});

test("every Connected Folder route that changes files refuses a link row, a broken one included", async (t) => {
  const root = await sandbox(t);
  const folder = join(root, "Folder");
  await mkdir(folder);
  await linkedFolder(folder);
  const { call } = await startApi(t, root);
  const registered = await call("POST", "/api/connected-folders/local-folder", { connectedFolderRoot: folder });
  assert.equal(registered.status, 201, registered.text);
  const id = (JSON.parse(registered.text) as { connectedFolder: { id: string } }).connectedFolder.id;
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
      ["rename", "POST", `${base}/rename-local-entry`, { path: link, newName: `${link} renamed` }],
      ["move one", "POST", `${base}/move-local-entry`, { sourcePath: link, targetFolderPath: "Projects" }],
      ["move several", "POST", `${base}/move-local-entries`, { sourcePaths: [link], targetFolderPath: "Projects" }],
      ["move into", "POST", `${base}/move-local-entry`, { sourcePath: "notes.txt", targetFolderPath: link }],
      ["delete one", "DELETE", `${base}/local-file`, { path: link }],
      ["delete several", "DELETE", `${base}/local-files`, { paths: [link] }],
      ["write", "PUT", `${base}/file`, { path: link, text: "changed" }],
      ["new folder in", "POST", `${base}/folders`, { parentPath: link, name: "Inside" }],
      ["new file in", "POST", `${base}/files`, { parentPath: link, name: "inside.txt", text: "" }],
      ["add files to", "POST", `${base}/upload-local-files`, upload],
      ["connect", "POST", `${base}/nested-folders`, { path: link }],
      ["copy", "POST", "/api/file-transfer", { mode: "copy", sources: [{ place, path: link }], target: { place, path: "Projects" } }],
      ["duplicate", "POST", "/api/file-transfer", { mode: "duplicate", sources: [{ place, path: link }], target: { place, path: "" } }],
      ["transfer move", "POST", "/api/file-transfer", { mode: "move", sources: [{ place, path: link }], target: { place, path: "Projects" } }],
      ["copy into", "POST", "/api/file-transfer", { mode: "copy", sources: [{ place, path: "notes.txt" }], target: { place, path: link } }],
      ["compress", "POST", "/api/file-transfer/compress", { place, paths: [link] }],
      ["extract", "POST", "/api/file-transfer/extract", { place, path: link }],
    ];
    for (const [label, method, path, body] of attempts) {
      const result = await call(method, path, body);
      if (result.status < 400) accepted.push(`${label} “${link}” answered ${result.status}: ${result.text}`);
      if ((await snapshot(folder)).join("\n") !== before.join("\n")) changed.push(`${label} “${link}”`);
    }
  }
  assert.deepEqual(accepted, [], "every change to a link row is refused");
  assert.deepEqual(changed, [], "a refused change leaves the folder as it was");
});

test("every Standard Folder and other-folder route that changes files refuses a link row, a broken one included", async (t) => {
  const root = await sandbox(t);
  const added = join(root, "Added");
  await mkdir(added);
  await linkedFolder(added);
  const { call } = await startApi(t, root);
  const sidebar = addSidebarFolder(added, root);
  const before = await snapshot(added);
  const accepted: string[] = [];
  const changed: string[] = [];
  // The same folder twice: as a folder added to the sidebar, and as an other folder in the computer place.
  const places = [
    { place: { kind: "standard", id: sidebar.id }, prefix: "" },
    { place: { kind: "standard", id: "computer" }, prefix: `${added.slice(1)}/` },
  ];
  for (const { place, prefix } of places) {
    const base = `/api/standard-folders/${place.id}`;
    for (const name of links) {
      const link = `${prefix}${name}`;
      const attempts: Array<[string, string, string, unknown]> = [
        ["rename", "POST", `${base}/rename-local-entry`, { path: link, newName: `${name} renamed` }],
        ["new folder in", "POST", `${base}/folders`, { parentPath: link, name: "Inside" }],
        ["connect", "POST", `${base}/connected-folders`, { path: link }],
        ["copy", "POST", "/api/file-transfer", { mode: "copy", sources: [{ place, path: link }], target: { place, path: `${prefix}Projects` } }],
        ["duplicate", "POST", "/api/file-transfer", { mode: "duplicate", sources: [{ place, path: link }], target: { place, path: prefix.replace(/\/$/, "") } }],
        ["move", "POST", "/api/file-transfer", { mode: "move", sources: [{ place, path: link }], target: { place, path: `${prefix}Projects` } }],
        ["copy into", "POST", "/api/file-transfer", { mode: "copy", sources: [{ place, path: `${prefix}notes.txt` }], target: { place, path: link } }],
        ["compress", "POST", "/api/file-transfer/compress", { place, paths: [link] }],
        ["extract", "POST", "/api/file-transfer/extract", { place, path: link }],
      ];
      for (const [label, method, path, body] of attempts) {
        const result = await call(method, path, body);
        if (result.status < 400) accepted.push(`${place.id}: ${label} “${link}” answered ${result.status}: ${result.text}`);
        if ((await snapshot(added)).join("\n") !== before.join("\n")) changed.push(`${place.id}: ${label} “${link}”`);
      }
      // Move to Trash runs in the desktop process, which resolves the item through these two first.
      assert.throws(() => resolveStandardFolderPath(place.id, link, root), /symbolic links/, `${place.id}: trash “${link}”`);
      await assert.rejects(assertStandardFolderPathUnowned(place.id, link, root), /symbolic links/, `${place.id}: trash “${link}”`);
    }
  }
  assert.deepEqual(accepted, [], "every change to a link row is refused");
  assert.deepEqual(changed, [], "a refused change leaves the folder as it was");
});
