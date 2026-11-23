import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { expandTypedPath, goToFolder } from "../src/local/go-to-folder.js";

async function home(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-to-folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Documents", "Projects", "Roomcraft", "Assets"), { recursive: true });
  await writeFile(join(root, "Documents", "Projects", "Roomcraft", "Assets", "Roomcraft.unity"), "scene");
  await mkdir(join(root, "Documents", "Projects", "Recipes"));
  await mkdir(join(root, "Documents", "Projects", ".hidden"));
  await mkdir(join(root, "Downloads"));
  return root;
}

test("a typed path opens the place holding it: a Connected Folder before a Standard Folder, the deepest first", async (t) => {
  const root = await home(t);
  const projects = join(root, "Documents", "Projects");
  const connectedFolders = [{ id: "space-roomcraft", connectedFolderRoot: join(projects, "Roomcraft") }];

  const folder = await goToFolder(join(projects, "Roomcraft", "Assets"), connectedFolders, root);
  assert.deepEqual(folder.target, { place: { kind: "connected-folder", id: "space-roomcraft" }, path: "Assets", select: null });

  // A file opens its folder with the file selected, as Finder's Go to Folder does.
  const file = await goToFolder(join(projects, "Roomcraft", "Assets", "Roomcraft.unity"), connectedFolders, root);
  assert.deepEqual(file.target, { place: { kind: "connected-folder", id: "space-roomcraft" }, path: "Assets", select: "Assets/Roomcraft.unity" });

  // Outside the Connected Folder, the most specific Standard Folder (Documents, not the home folder).
  const documents = await goToFolder("~/Documents/Projects", connectedFolders, root);
  assert.deepEqual(documents.target, { place: { kind: "standard", id: "documents" }, path: "Projects", select: null });
  const homeFolder = await goToFolder("~", connectedFolders, root);
  assert.deepEqual(homeFolder.target, { place: { kind: "standard", id: "home" }, path: "", select: null });
});

test("Go to Folder completes names in the typed folder and says plainly what it can't open", async (t) => {
  const root = await home(t);
  const partial = await goToFolder("~/Documents/Projects/R", [], root);
  assert.equal(partial.target, null, "a partial name opens nothing yet");
  assert.deepEqual(partial.suggestions.map((item) => item.name), ["Recipes", "Roomcraft"]);
  const listed = await goToFolder("~/Documents/Projects/", [], root);
  assert.deepEqual(listed.suggestions.map((item) => item.name), ["Recipes", "Roomcraft"], "dot folders stay hidden");
  const missing = await goToFolder(join(root, "Nowhere", "at all"), [], root);
  assert.equal(missing.target, null);
  assert.equal(missing.message, "There’s no folder or file at that path.");
  await mkdir(join(root, "Documents", "Projects", "Roomcraft", ".amplefile"));
  const hidden = await goToFolder("~/Documents/Projects/Roomcraft/.amplefile", [], root);
  assert.equal(hidden.target, null);
  assert.match(hidden.message ?? "", /hidden AmpleFile or Pi data/);
  assert.deepEqual((await goToFolder("~/Documents/Projects/Roomcraft/.amplefile/", [], root)).suggestions, [], "nothing inside it is listed");
  assert.equal(expandTypedPath("relative/name", root), null, "names relative to the folder shown are resolved in the window");
});

test("Go to Folder opens any folder on the computer, and completes names outside the places too", async (t) => {
  const root = await home(t);
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "go-to-folder-elsewhere-")));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await mkdir(join(elsewhere, "Shared", "Scans"), { recursive: true });
  await writeFile(join(elsewhere, "Shared", "Scans", "page1.png"), "png");
  // Outside every Connected Folder and Standard Folder, the computer place holds it, by its path from the disk's root.
  const folder = await goToFolder(join(elsewhere, "Shared", "Scans"), [], root);
  assert.deepEqual(folder.target, { place: { kind: "standard", id: "computer" }, path: join(elsewhere, "Shared", "Scans").slice(1), select: null });
  const file = await goToFolder(join(elsewhere, "Shared", "Scans", "page1.png"), [], root);
  assert.deepEqual(file.target, { place: { kind: "standard", id: "computer" }, path: join(elsewhere, "Shared", "Scans").slice(1), select: join(elsewhere, "Shared", "Scans", "page1.png").slice(1) });
  assert.deepEqual((await goToFolder(join(elsewhere, "Shared", "Sc"), [], root)).suggestions.map((item) => item.name), ["Scans"]);
  const disk = await goToFolder("/", [], root);
  assert.deepEqual(disk.target, { place: { kind: "standard", id: "computer" }, path: "", select: null });
});
