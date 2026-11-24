import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureSafeConnectedFolderRoot, getConnectedFolder, listConnectedFolders, registerLinkedConnectedFolder } from "../src/local/connected-folder.js";
import { resolveFolderLocation } from "../src/local/folder-locations.js";
import { isInsideMacDataVolume, macDataVolumeRoot, withoutMacDataVolumeName } from "../src/local/mac-data-volume.js";
import { addSidebarFolder, computerFolderId, listStandardFolders, standardFolderPathBase } from "../src/local/standard-folders.js";
import { configureAmpleFileStateRoot, connectedFolderRegistryFile } from "../src/local/state-paths.js";

// macOS gives every folder on the data volume a second name under
// /System/Volumes/Data that is not a link (src/local/mac-data-volume.ts).
// Through it a Connected Folder would open as a plain folder and its changes
// would skip History, so nothing goes in, and a path by that name is used
// under its usual one.

const refused = (run: () => unknown) => assert.throws(run, (error: { status?: number; message?: string }) => error.status === 400 && /another name for this Mac’s own folders/.test(error.message ?? ""));

test("the computer place never goes into the Mac's data volume, whatever the case", () => {
  refused(() => standardFolderPathBase(computerFolderId, "System/Volumes/Data", undefined, "darwin"));
  refused(() => standardFolderPathBase(computerFolderId, "System/Volumes/Data/Users/ana/Projects", undefined, "darwin"));
  refused(() => standardFolderPathBase(computerFolderId, "system/VOLUMES/data/Users", undefined, "darwin"));
  assert.deepEqual(standardFolderPathBase(computerFolderId, "System/Volumes", undefined, "darwin"), { root: "/System", path: "Volumes", prefix: "System" });
  assert.deepEqual(standardFolderPathBase(computerFolderId, "System/Volumes/Preboot", undefined, "darwin"), { root: "/System", path: "Volumes/Preboot", prefix: "System" });
  // Elsewhere the name means nothing special.
  assert.deepEqual(standardFolderPathBase(computerFolderId, "System/Volumes/Data/x", undefined, "linux"), { root: "/System", path: "Volumes/Data/x", prefix: "System" });
});

test("a path by the data volume's name opens under its usual one, in the Connected Folder that holds it", { skip: process.platform !== "darwin" && "macOS only" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amplefile-data-volume-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = join(root, "Projects", "Client");
  await mkdir(join(client, "Drafts"), { recursive: true });
  const alias = `${macDataVolumeRoot}${client}`;

  assert.equal(await withoutMacDataVolumeName(alias), client);
  assert.equal(await withoutMacDataVolumeName(client), client, "a usual path is left as it is");
  assert.equal(await withoutMacDataVolumeName(alias, "linux"), alias, "only a Mac has the second name");

  const connectedFolders = [{ id: "space-0123456789abcdef", connectedFolderRoot: client }];
  assert.deepEqual(await resolveFolderLocation(`${alias}/Drafts`, connectedFolders, root), {
    place: { kind: "connected-folder", id: "space-0123456789abcdef" },
    path: "Drafts",
    select: null,
  });
  assert.deepEqual(await resolveFolderLocation(`${macDataVolumeRoot.toLowerCase()}${client}`, connectedFolders, root), {
    place: { kind: "connected-folder", id: "space-0123456789abcdef" },
    path: "",
    select: null,
  }, "the Mac's disk ignores case");
  // The volume's own top has no usual name; it is refused like any path into it.
  await assert.rejects(resolveFolderLocation(macDataVolumeRoot, connectedFolders, root), (error: { status?: number }) => error.status === 400);
});

test("the data volume's name is recognized in any case, with or without a trailing slash, only on a Mac", () => {
  for (const path of [macDataVolumeRoot, `${macDataVolumeRoot}/`, "/system/volumes/DATA/Users", `${macDataVolumeRoot}//Users/ana`]) {
    assert.equal(isInsideMacDataVolume(path, "darwin"), true, path);
  }
  for (const path of ["/System/Volumes", "/System/Volumes/Database", "/Users/ana/System/Volumes/Data"]) assert.equal(isInsideMacDataVolume(path, "darwin"), false, path);
  assert.equal(isInsideMacDataVolume(`${macDataVolumeRoot}/Users`, "linux"), false);
});

test("a sidebar folder and a Connected Folder chosen by the data volume's name are kept under the usual one", { skip: process.platform !== "darwin" && "macOS only" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amplefile-data-volume-roots-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  configureAmpleFileStateRoot(join(root, "state"));
  t.after(() => configureAmpleFileStateRoot(undefined));
  const shared = join(root, "Shared");
  await mkdir(shared);

  const added = addSidebarFolder(`${macDataVolumeRoot}${shared}`, join(root, "home"));
  assert.equal((await listStandardFolders([], join(root, "home"))).find((folder) => folder.id === added.id)?.root, shared);
  assert.deepEqual(addSidebarFolder(shared, join(root, "home")), added, "the same folder by its usual name is the same sidebar row");
  assert.throws(() => addSidebarFolder(macDataVolumeRoot, join(root, "home")), (error: { status?: number }) => error.status === 400);

  assert.equal(ensureSafeConnectedFolderRoot(`${macDataVolumeRoot}${shared}`), shared);
  assert.throws(() => ensureSafeConnectedFolderRoot(`${macDataVolumeRoot}/`), (error: { status?: number }) => error.status === 400);
});

test("a Connected Folder stored by the data volume's name on an earlier build is read under the usual one", { skip: process.platform !== "darwin" && "macOS only" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amplefile-data-volume-registry-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  configureAmpleFileStateRoot(join(root, "state"));
  t.after(() => configureAmpleFileStateRoot(undefined));
  const notes = join(root, "Notes");
  await mkdir(notes);
  const registered = await registerLinkedConnectedFolder(`${macDataVolumeRoot}${notes}`);
  assert.equal(registered.connectedFolderRoot, notes, "connecting by the second name registers the usual one");
  // A registry an earlier build wrote with the second name.
  const file = connectedFolderRegistryFile();
  await writeFile(file, (await readFile(file, "utf8")).split(JSON.stringify(notes)).join(JSON.stringify(`${macDataVolumeRoot}${notes}`)));
  assert.match(await readFile(file, "utf8"), /System\/Volumes\/Data/);
  assert.equal((await getConnectedFolder(registered.id)).connectedFolderRoot, notes);
  assert.deepEqual((await listConnectedFolders()).map((item) => item.connectedFolderRoot), [notes]);
});
