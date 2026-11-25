import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanConnectedFolderTree, type TreeEntry } from "../src/local/connected-folder.js";
import { scanComputerFolder, scanDiskTop } from "../src/local/folder-locations.js";
import { isMacPackageName, macPackageKind } from "../src/shared/mac-packages.js";
import { fileMenuItems, type FileMenuItem } from "../src/shared/file-menu.js";
import { nativeFileMenuItems, parseNativeFileMenuRequest } from "../desktop/src/file-context-menu.js";
import { itemMenuCapabilities } from "../web-local/src/components/file-manager/file-manager-menus.js";
import { listDropTarget } from "../web-local/src/components/file-manager/file-manager-drops.js";
import { fileKindLabel, fileManagerIcon } from "../web-local/src/components/file-manager/file-manager-model.js";
import { linkKindLabel } from "../web-local/src/components/file-manager/file-manager-layout.js";

/**
 * Mac packages (docs/product-model.md, "Packages"): a folder Finder shows as
 * one item, an app or a document, is marked by the host on macOS only, opens
 * in its app, and is gone inside only by Show Package Contents; copying,
 * moving, Compress, search, and size still treat it as a folder.
 */

async function sandbox(t: test.TestContext): Promise<string> {
  // Resolved, so paths compare equal to what realpath reports (macOS /var → /private/var).
  const root = await realpath(await mkdtemp(join(tmpdir(), "mac-packages-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A folder with an app, a document package, a framework, a plain folder, a file named like an app, and links. */
async function packagesFolder(root: string): Promise<void> {
  await mkdir(join(root, "Sketch.app", "Contents", "MacOS"), { recursive: true });
  await writeFile(join(root, "Sketch.app", "Contents", "Info.plist"), "<plist/>");
  await mkdir(join(root, "Deck.key"));
  await writeFile(join(root, "Deck.key", "Index.zip"), "slides");
  await mkdir(join(root, "Thing.framework"));
  await mkdir(join(root, "Plain"));
  await writeFile(join(root, "notes.app"), "a file, not a package");
  await symlink(join(root, "Sketch.app"), join(root, "Sketch"));
  await symlink(join(root, "Plain"), join(root, "Plain link"));
}

const marks = (entries: readonly TreeEntry[]) => Object.fromEntries(entries.map((entry) => [entry.name, Boolean(entry.package)]));

test("package names are known by extension, any case, and a framework is a plain folder as in Finder", () => {
  for (const name of ["Safari.app", "Notes.APP", "Deck.key", "Story.pages", "Budget.numbers", "Photos Library.photoslibrary", "Memo.rtfd", "App.xcodeproj", "Disk.sparsebundle", "Install.pkg"]) {
    assert.equal(isMacPackageName(name), true, name);
  }
  for (const name of ["Thing.framework", "app", ".app", "Folder", "notes.txt", "constructor", "x.constructor"]) assert.equal(isMacPackageName(name), false, name);
  assert.equal(macPackageKind("Safari.app"), "Application");
  assert.equal(macPackageKind("Story.pages"), "Pages document");
  assert.equal(macPackageKind("Photos Library.photoslibrary"), "Photos library");
  assert.equal(macPackageKind("Folder"), "Package");
});

test("a Mac's listings mark packages and links to them, and still list inside them as folders", async (t) => {
  const root = await sandbox(t);
  await packagesFolder(root);
  const scan = await scanConnectedFolderTree(root, 2, "", { includeLinks: true, packagePlatform: "darwin" });
  assert.deepEqual(marks(scan.entries), {
    "Deck.key": true, "Plain": false, "Sketch.app": true, "Thing.framework": false,
    "Plain link": false, "Sketch": true, "notes.app": false,
  });
  const app = scan.entries.find((entry) => entry.name === "Sketch.app")!;
  assert.equal(app.kind, "folder", "a package is the folder it is");
  assert.deepEqual(app.children?.map((entry) => entry.name), ["Contents"], "and a recursive listing walks inside it");
  // Inside a package (Show Package Contents), its folders are plain folders.
  const inside = await scanConnectedFolderTree(root, 0, "Sketch.app", { packagePlatform: "darwin" });
  assert.deepEqual(marks(inside.entries), { Contents: false });
});

test("other systems' listings mark no packages", async (t) => {
  const root = await sandbox(t);
  await packagesFolder(root);
  const scan = await scanConnectedFolderTree(root, 0, "", { includeLinks: true, packagePlatform: "linux" });
  assert.ok(scan.entries.every((entry) => !("package" in entry)), JSON.stringify(scan.entries));
  const top = await scanDiskTop(root, { includeLinks: true }, "linux");
  assert.ok(top.every((entry) => !("package" in entry)));
});

test("the disk's top and the computer place mark packages as every listing does on a Mac", async (t) => {
  const root = await sandbox(t);
  await packagesFolder(root);
  const top = await scanDiskTop(root, { includeLinks: true }, "darwin");
  assert.deepEqual(marks(top), {
    "Deck.key": true, "Plain": false, "Sketch.app": true, "Thing.framework": false,
    "Plain link": false, "Sketch": true, "notes.app": false,
  });
  // A folder below the top is listed by the shared scan, which marks this computer's packages.
  const listing = await scanComputerFolder(root.slice(1), undefined, { includeLinks: true });
  assert.equal(listing.tree.find((entry) => entry.name === "Sketch.app")?.package, process.platform === "darwin" ? true : undefined);
});

const packageEntry = (name: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({ kind: "folder", name, path: `Apps/${name}`, package: true, ...extra });
const where = { place: { kind: "connected-folder", id: "lab" } as const, fixtureMode: false, canPaste: true, newWindow: true };
const labels = (items: readonly FileMenuItem[]) => items.map((item) => item.type === "separator" ? "-" : `${item.label}=${item.command}`);

test("a package's menu opens it and offers Show Package Contents, never folder actions", () => {
  const capabilities = itemMenuCapabilities(packageEntry("Sketch.app"), true, where);
  assert.equal(capabilities.package, true);
  assert.equal(capabilities.newTab, false);
  assert.equal(capabilities.newWindow, false);
  assert.equal(capabilities.paste, false);
  assert.equal(capabilities.worker, false);
  assert.deepEqual(labels(fileMenuItems({ path: "Apps/Sketch.app", kind: "folder", capabilities })), [
    "Open=open",
    "Show Package Contents=show-package-contents",
    "Show in Finder=reveal",
    "Copy Item Path=copy-path",
    "Get Info=get-info",
    "-",
    "Copy “Sketch.app”=copy", "Cut “Sketch.app”=cut", "Duplicate=duplicate", "Compress “Sketch.app”=compress",
    "-",
    "Rename…=rename",
    "Delete Item=delete",
  ]);
  // The same list reaches the native menu, which accepts the capability.
  const native = parseNativeFileMenuRequest({ connectedFolderId: "lab", path: "Apps/Sketch.app", kind: "folder", capabilities, point: { x: 1, y: 1 } });
  assert.equal(native.capabilities.package, true);
  assert.deepEqual(labels(nativeFileMenuItems(native)), labels(fileMenuItems({ path: "Apps/Sketch.app", kind: "folder", capabilities })));
  // A plain folder is unchanged.
  const folder = itemMenuCapabilities({ kind: "folder", name: "Plain", path: "Plain" }, true, where);
  assert.equal(folder.package, undefined);
  assert.ok(labels(fileMenuItems({ path: "Plain", kind: "folder", capabilities: folder })).includes("Open Folder=open"));

  // A link to a package (/Applications/Safari.app) opens the app, shows inside it, and is otherwise a link.
  const link = packageEntry("Safari.app", { link: { target: "folder", targetPath: "/System/Applications/Safari.app" } });
  const linkCapabilities = itemMenuCapabilities(link, true, where);
  assert.deepEqual(labels(fileMenuItems({ path: link.path, kind: "folder", capabilities: linkCapabilities })).slice(0, 5), [
    "Open=open", "Show Package Contents=show-package-contents", "Show Original=show-original", "Show in Finder=reveal", "Copy Link Path=copy-path",
  ]);
});

test("a package reads as what it is, is drawn as one item, and takes no drop", () => {
  assert.equal(fileKindLabel(packageEntry("Sketch.app")), "Application");
  assert.equal(fileKindLabel(packageEntry("Deck.key")), "Keynote presentation");
  assert.equal(fileKindLabel({ kind: "folder", name: "Sketch.app" }), "Folder", "only the host's mark makes a package");
  assert.equal(fileManagerIcon(packageEntry("Sketch.app")).className, "fm-ic fm-ic-app");
  assert.deepEqual(fileManagerIcon(packageEntry("Deck.key")), { className: "fm-ic fm-ic-doc fm-tag-slides", label: "KEY" });
  assert.equal(fileManagerIcon(packageEntry("Thing.bundle")).className, "fm-ic fm-ic-box");
  assert.equal(fileManagerIcon({ kind: "folder", name: "Sketch.app" }).className, "fm-ic fm-ic-folder");
  assert.equal(linkKindLabel({ target: "folder", targetPath: "/System/Applications/Safari.app" }, true), "Link to Application");
  assert.equal(linkKindLabel({ target: "folder", targetPath: "/System/Applications/Safari.app" }), "Link to Folder");
  assert.equal(listDropTarget(packageEntry("Sketch.app"), [], "Apps"), "Apps", "a drop on a package lands in the folder shown");
  assert.equal(listDropTarget({ kind: "folder", name: "Plain", path: "Apps/Plain" }, [], "Apps"), "Apps/Plain");
});
