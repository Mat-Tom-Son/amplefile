import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  addSidebarFolder,
  assertStandardFolderPathUnowned,
  removeSidebarFolder,
  standardFolderRoot,
  createStandardFolderFolder,
  isStandardFolderId,
  listStandardFolders,
  renameStandardFolderEntry,
  scanStandardFolder,
  standardFolderEntryInfo,
  standardFolderRegistrationTarget,
} from "../src/local/standard-folders.js";
import { registerLinkedConnectedFolder } from "../src/local/connected-folder.js";
import { comparableForms, comparablePath, comparableRealPath, formsContain } from "../src/local/path-comparison.js";
import { nativeFileMenuItems, parseNativeFileMenuRequest } from "../desktop/src/file-context-menu.js";

async function home(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "standard-folders-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "Desktop"));
  await mkdir(join(root, "Downloads"));
  return root;
}

test("only the standard folders on this computer are listed, and a registered one says so", async (t) => {
  const root = await home(t);
  const folders = await listStandardFolders([{ id: "af-downloads", connectedFolderRoot: join(root, "Downloads") }], root);
  assert.deepEqual(folders.map((folder) => [folder.id, folder.name, folder.connectedFolderId]), [
    ["desktop", "Desktop", null],
    ["downloads", "Downloads", "af-downloads"],
    // The home folder goes by the account's name, as in Finder.
    ["home", basename(root), null],
  ]);
  assert.equal(isStandardFolderId("downloads"), true);
  assert.equal(isStandardFolderId("library"), false);
  assert.equal(isStandardFolderId("../Documents"), false);
});

test("a standard folder lists one level without the files Finder hides, and stays inside itself", async (t) => {
  const root = await home(t);
  const downloads = join(root, "Downloads");
  await writeFile(join(downloads, "receipt.pdf"), "pdf");
  await writeFile(join(downloads, ".DS_Store"), "x");
  await writeFile(join(downloads, ".hidden"), "x");
  await mkdir(join(downloads, "Receipts"));
  await writeFile(join(downloads, "Receipts", "inner.pdf"), "pdf");
  await mkdir(join(downloads, ".amplefile"));

  const listing = await scanStandardFolder("downloads", "", root);
  assert.deepEqual(listing.tree.map((entry) => entry.name).sort(), ["Receipts", "receipt.pdf"]);
  assert.equal(listing.tree.find((entry) => entry.name === "Receipts")?.children, undefined, "one level only");
  assert.deepEqual((await scanStandardFolder("downloads", "Receipts", root)).tree.map((entry) => entry.path), ["Receipts/inner.pdf"]);
  await assert.rejects(scanStandardFolder("downloads", "../Desktop", root), /escapes/);
  await assert.rejects(scanStandardFolder("downloads", ".amplefile", root), /reserved/);

  const info = await standardFolderEntryInfo("downloads", "receipt.pdf", root);
  assert.equal(info.sizeBytes, 3);
  assert.equal(info.hashSha256, null, "a standard folder's Info never waits on hashing a large download");
});

test("a Connected Folder is found however its path is written: another case, an accent spelled the other way, or a linked folder on the way", async (t) => {
  const root = await home(t);
  const downloads = join(root, "Downloads");

  // Registered under the composed spelling; asked about under the decomposed one, and in capitals.
  await mkdir(join(downloads, "Caf\u00e9", "Menus"), { recursive: true });
  await registerLinkedConnectedFolder(join(downloads, "Caf\u00e9"));
  if (existsSync(join(downloads, "Cafe\u0301"))) {
    for (const spelling of ["Cafe\u0301", "Cafe\u0301/Menus", ...(existsSync(join(downloads, "CAFE\u0301")) ? ["CAFE\u0301", "CAFE\u0301/menus"] : [])]) {
      await assert.rejects(assertStandardFolderPathUnowned("downloads", spelling, root, { finalLink: true }), /is a Connected Folder/, JSON.stringify(spelling));
    }
  }

  // Registered through a linked folder; asked about by the real path, which no part of the registered path spells.
  await mkdir(join(downloads, "Real", "Proj", "Notes"), { recursive: true });
  await mkdir(join(downloads, "Real", "Beside"));
  await symlink(join(downloads, "Real"), join(root, "Desktop", "Shortcut"));
  await registerLinkedConnectedFolder(join(root, "Desktop", "Shortcut", "Proj"));
  for (const path of ["Real/Proj", "Real/Proj/Notes", "Real"]) {
    await assert.rejects(assertStandardFolderPathUnowned("downloads", path, root, { finalLink: true }), /is a Connected Folder/, path);
  }
  await assert.doesNotReject(assertStandardFolderPathUnowned("downloads", "Real/Beside", root, { finalLink: true }));
  await assert.doesNotReject(assertStandardFolderPathUnowned("downloads", "Real", root, { allowContaining: true }), "adding beside it is still fine");
  await assert.rejects(assertStandardFolderPathUnowned("downloads", "Real/Proj", root, { allowContaining: true }), /is a Connected Folder/);

  // A link to a Connected Folder is an item of its own: it is renamed or removed as the link it is.
  await symlink(join(downloads, "Real", "Proj"), join(downloads, "To Proj"));
  await assert.doesNotReject(assertStandardFolderPathUnowned("downloads", "To Proj", root, { finalLink: true }));
});

test("paths are compared as written and as the disk resolves them", async (t) => {
  const root = await realpath(await home(t));
  await mkdir(join(root, "Real", "Inner"), { recursive: true });
  await symlink(join(root, "Real"), join(root, "Link"));
  const real = comparablePath(join(root, "Real", "Inner"));
  assert.equal(await comparableRealPath(join(root, "Link", "Inner")), real);
  assert.equal(await comparableRealPath(join(root, "Link", "Inner", "not", "there")), comparablePath(join(root, "Real", "Inner", "not", "there")), "what is not there yet keeps its own spelling");
  assert.equal(await comparableRealPath(join(root, "Link"), { finalLink: true }), comparablePath(join(root, "Link")), "a final link is the item itself");
  assert.equal(await comparableRealPath(join(root, "Link")), comparablePath(join(root, "Real")));
  assert.deepEqual(await comparableForms(join(root, "Link", "Inner")), [comparablePath(join(root, "Link", "Inner")), real]);
  assert.deepEqual(await comparableForms(join(root, "Real")), [comparablePath(join(root, "Real"))], "one way to write it is listed once");
  assert.equal(formsContain([comparablePath("/a/b")], [comparablePath("/a/b/c")]), true);
  assert.equal(formsContain([comparablePath("/a/b")], [comparablePath("/a/bc")]), false);
  assert.equal(formsContain([comparablePath("/x"), comparablePath("/a")], [comparablePath("/y"), comparablePath("/a")]), true, "any way of writing either");
  if (process.platform !== "linux") {
    assert.equal(comparablePath("/Volumes/Work/Cafe\u0301/"), comparablePath("/volumes/work/Caf\u00e9"));
  } else {
    assert.notEqual(comparablePath("/srv/Cafe\u0301"), comparablePath("/srv/Caf\u00e9"));
  }
});

test("rename and New Folder refuse names that would collide or hide, and change only the named item", async (t) => {
  const root = await home(t);
  const downloads = join(root, "Downloads");
  await writeFile(join(downloads, "a.txt"), "a");
  await writeFile(join(downloads, "b.txt"), "b");

  await assert.rejects(renameStandardFolderEntry("downloads", "a.txt", "b.txt", root), /already exists/);
  await assert.rejects(renameStandardFolderEntry("downloads", "a.txt", "../a.txt", root), /can’t contain/);
  await assert.rejects(renameStandardFolderEntry("downloads", "a.txt", ".a.txt", root), /period/);
  await assert.rejects(renameStandardFolderEntry("downloads", "", "Other", root), /can’t be renamed/);
  assert.deepEqual(await renameStandardFolderEntry("downloads", "a.txt", "notes.txt", root), { path: "notes.txt" });
  assert.equal(existsSync(join(downloads, "notes.txt")), true);
  assert.equal(existsSync(join(downloads, "a.txt")), false);
  // A case-only rename finds the item itself on a case-insensitive disk and still goes ahead.
  assert.deepEqual(await renameStandardFolderEntry("downloads", "notes.txt", "Notes.txt", root), { path: "Notes.txt" });
  // On a case-sensitive disk two spellings can be two separate entries.
  if (!existsSync(join(downloads, "notes.txt"))) {
    await writeFile(join(downloads, "notes.txt"), "separate contents", { flag: "wx" });
    await assert.rejects(renameStandardFolderEntry("downloads", "notes.txt", "Notes.txt", root), /already exists/);
    assert.equal(await readFile(join(downloads, "notes.txt"), "utf8"), "separate contents");
  }

  assert.deepEqual(await createStandardFolderFolder("downloads", "", "Receipts", root), { path: "Receipts" });
  await assert.rejects(createStandardFolderFolder("downloads", "", "Receipts", root), /already exists/);
  assert.deepEqual(await createStandardFolderFolder("downloads", "Receipts", "2026", root), { path: "Receipts/2026" });
});

test("anything a registered Connected Folder owns is changed through that Connected Folder, not as a standard folder", async (t) => {
  const root = await home(t);
  const downloads = join(root, "Downloads");
  await mkdir(join(downloads, "Taxes", "Forms"), { recursive: true });
  await writeFile(join(downloads, "Taxes", "w2.pdf"), "w2");
  await writeFile(join(downloads, "loose.pdf"), "x");
  await registerLinkedConnectedFolder(join(downloads, "Taxes"));

  await assert.doesNotReject(assertStandardFolderPathUnowned("downloads", "loose.pdf", root));
  await assert.rejects(assertStandardFolderPathUnowned("downloads", "Taxes", root), /is a Connected Folder/);
  await assert.rejects(assertStandardFolderPathUnowned("downloads", "Taxes/w2.pdf", root), /is a Connected Folder/);
  await assert.rejects(renameStandardFolderEntry("downloads", "Taxes/w2.pdf", "w2-2025.pdf", root), /is a Connected Folder/);
  await assert.rejects(renameStandardFolderEntry("downloads", "loose.pdf", "Taxes", root), /already exists|is a Connected Folder/);
  await assert.rejects(createStandardFolderFolder("downloads", "Taxes", "New", root), /is a Connected Folder/);
  // Trashing or renaming a folder that holds a Connected Folder would carry the Connected Folder along.
  await assert.rejects(assertStandardFolderPathUnowned("downloads", "", root), /is a Connected Folder/);
  // Adding a folder next to one is fine.
  assert.deepEqual(await createStandardFolderFolder("downloads", "", "New", root), { path: "New" });

  const listing = await scanStandardFolder("downloads", "", root);
  assert.equal(listing.tree.find((entry) => entry.name === "Taxes")?.nestedFolder, true, "the registered folder shows as a Connected Folder");
  await assert.rejects(standardFolderRegistrationTarget("downloads", "Taxes", root), /already has its own Worker/);
  assert.equal(await standardFolderRegistrationTarget("downloads", "", root), downloads);
});

test("a standard folder's native menu offers Move to Trash and needs exactly one owner", () => {
  const request = parseNativeFileMenuRequest({
    connectedFolderId: "",
    standardFolderId: "downloads",
    path: "receipt.pdf",
    kind: "file",
    capabilities: { open: true, attach: false, history: false, upload: false, rename: true, delete: true },
    point: { x: 10, y: 10 },
  });
  assert.equal(request.standardFolderId, "downloads");
  assert.deepEqual(nativeFileMenuItems(request).filter((item) => item.type === "item").map((item) => item.type === "item" ? item.label : ""), [
    "Open", "Open With", "Show in Finder", "Copy File Path", "Rename…", "Move to Trash",
  ]);
  const several = parseNativeFileMenuRequest({
    connectedFolderId: "",
    standardFolderId: "downloads",
    path: "receipt.pdf",
    kind: "file",
    capabilities: { open: false, attach: false, history: false, upload: false, rename: false, delete: true },
    selection: { files: 2, folders: 1 },
    point: { x: 10, y: 10 },
  });
  assert.equal(nativeFileMenuItems(several).at(-1)?.type === "item" && (nativeFileMenuItems(several).at(-1) as { label: string }).label, "Move to Trash");
  assert.throws(() => parseNativeFileMenuRequest({
    connectedFolderId: "connected-folder-1",
    standardFolderId: "downloads",
    path: "receipt.pdf",
    kind: "file",
    capabilities: { open: true, attach: false, history: false, upload: false, rename: true, delete: true },
    point: { x: 10, y: 10 },
  }), /standard folder id/);
});

test("Pictures and iCloud Drive appear when the computer has them, and the home folder hides Library as Finder does", async (t) => {
  const root = await home(t);
  await mkdir(join(root, "Pictures"));
  await mkdir(join(root, "Library", "Mobile Documents", "com~apple~CloudDocs"), { recursive: true });
  const folders = await listStandardFolders([], root, "darwin");
  assert.deepEqual(folders.map((folder) => folder.id), ["desktop", "downloads", "pictures", "home", "icloud"]);
  assert.equal(folders.find((folder) => folder.id === "icloud")?.name, "iCloud Drive");
  const listing = await scanStandardFolder("home", "", root, "darwin");
  assert.ok(listing.tree.some((entry) => entry.name === "Desktop"));
  assert.ok(!listing.tree.some((entry) => entry.name === "Library"), "Library stays hidden at the top of the home folder");
});

test("a folder added with + joins Standard Folders until it is removed, and removing never touches the folder", async (t) => {
  const root = await home(t);
  const state = await mkdtemp(join(tmpdir(), "sidebar-state-"));
  const previous = process.env.AMPLEFILE_STATE_DIR;
  process.env.AMPLEFILE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.AMPLEFILE_STATE_DIR; else process.env.AMPLEFILE_STATE_DIR = previous;
    await rm(state, { recursive: true, force: true });
  });
  const projects = join(root, "Projects");
  await mkdir(projects);
  const added = addSidebarFolder(projects, root);
  assert.match(added.id, /^added-[0-9a-f]{16}$/);
  assert.equal(added.name, "Projects");
  assert.equal(addSidebarFolder(projects, root).id, added.id, "adding the same folder again keeps one entry");
  assert.equal(addSidebarFolder(join(root, "Downloads"), root).id, "downloads", "a built-in place is never added twice");
  assert.equal(isStandardFolderId(added.id), true);
  assert.equal(standardFolderRoot(added.id as never, root), projects);
  const listed = await listStandardFolders([], root);
  assert.deepEqual(listed.at(-1), { id: added.id, name: "Projects", root: projects, connectedFolderId: null, added: true });
  assert.throws(() => removeSidebarFolder("downloads"), /Built-in folders stay/);
  removeSidebarFolder(added.id);
  assert.equal(isStandardFolderId(added.id), false);
  assert.ok(existsSync(projects), "the folder itself stays");
});
