import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  maxRecentConnectedFolders,
  parseRecentConnectedFolders,
  pruneRecentConnectedFolders,
  readRecentConnectedFolders,
  recentConnectedFolderMenuEntries,
  recentConnectedFoldersPath,
  recordRecentConnectedFolder,
  serializeRecentConnectedFolders,
  writeRecentConnectedFolders,
} from "../desktop/src/recent-connected-folders.js";

const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");

test("showing a Connected Folder moves it to the front, once, within the limit", () => {
  let ids: string[] = [];
  ids = recordRecentConnectedFolder(ids, "space-a");
  ids = recordRecentConnectedFolder(ids, "space-b");
  ids = recordRecentConnectedFolder(ids, "space-a");
  assert.deepEqual(ids, ["space-a", "space-b"]);
  for (let index = 0; index < 20; index += 1) ids = recordRecentConnectedFolder(ids, `space-${index}`);
  assert.equal(ids.length, maxRecentConnectedFolders);
  assert.equal(ids[0], "space-19");
  assert.deepEqual(recordRecentConnectedFolder(["space-a"], ""), ["space-a"]);
});

test("the record tolerates damage and keeps only valid, unique ids", () => {
  assert.deepEqual(parseRecentConnectedFolders(null), []);
  assert.deepEqual(parseRecentConnectedFolders("{not json"), []);
  assert.deepEqual(parseRecentConnectedFolders("[]"), []);
  assert.deepEqual(parseRecentConnectedFolders(JSON.stringify({ connectedFolderIds: ["space-a", 7, "", "space-a", "bad\nid", "space-b"] })), ["space-a", "space-b"]);
  assert.deepEqual(parseRecentConnectedFolders(serializeRecentConnectedFolders(["space-a", "space-b"])), ["space-a", "space-b"]);
});

test("menu entries come from the registry: renamed names, disconnected ones dropped, same names told apart", () => {
  const registered = [
    { id: "space-a", name: "Taxes", connectedFolderRoot: "/home/person/Documents/Taxes" },
    { id: "space-b", name: "Taxes", connectedFolderRoot: "/srv/shared/Taxes" },
    { id: "space-c", name: "Photos & Video", connectedFolderRoot: "/home/person/Pictures" },
  ];
  assert.deepEqual(pruneRecentConnectedFolders(["space-c", "space-gone", "space-a"], registered), ["space-c", "space-a"]);
  assert.deepEqual(recentConnectedFolderMenuEntries(["space-c", "space-gone", "space-a", "space-b"], registered, "/home/person"), [
    { id: "space-c", label: "Photos & Video", connectedFolderRoot: "/home/person/Pictures" },
    { id: "space-a", label: "Taxes (~/Documents/Taxes)", connectedFolderRoot: "/home/person/Documents/Taxes" },
    { id: "space-b", label: "Taxes (/srv/shared/Taxes)", connectedFolderRoot: "/srv/shared/Taxes" },
  ]);
});

test("the record lives in the app profile and is replaced atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-open-recent-"));
  try {
    const path = recentConnectedFoldersPath(root);
    assert.equal(path, join(root, "recent-connected-folders.json"));
    assert.deepEqual(await readRecentConnectedFolders(path), []);
    await writeRecentConnectedFolders(path, ["space-a", "space-b"]);
    assert.deepEqual(await readRecentConnectedFolders(path), ["space-a", "space-b"]);
    await writeFile(path, "garbage");
    assert.deepEqual(await readRecentConnectedFolders(path), []);
    await writeRecentConnectedFolders(path, []);
    assert.deepEqual(await readdir(root), ["recent-connected-folders.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Linux records shown Connected Folders, titles the window like the Mac, and offers Open Recent", () => {
  assert.match(main, /if \(process\.platform === "darwin"\) app\.addRecentDocument\(connectedFolder\.connectedFolderRoot\);\s*if \(process\.platform === "linux"\) void updateRecentConnectedFolders\(\(ids\) => recordRecentConnectedFolder\(ids, connectedFolder\.id\)\);/);
  assert.match(main, /\.\.\.\(process\.platform === "linux" \? \[linuxOpenRecentMenuItem\(\)\] : \[\]\),/);
  assert.match(main, /if \(process\.platform === "darwin"\) window\.setRepresentedFilename\([^;]*;\s*window\.setTitle\(activeNativeConnectedFolder\?\.name \?\? productName\);/);
  // A recent entry opens only through the registered-folder path a launcher argument uses.
  assert.match(main, /async function openRecentConnectedFolder[\s\S]*?pendingOpenPaths\.push\(connectedFolder\.connectedFolderRoot\);\s*await drainPendingOpenPaths\(\);/);
});
