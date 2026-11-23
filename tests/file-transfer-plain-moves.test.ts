import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startLocalApi } from "../src/local/server.js";
import { addSidebarFolder } from "../src/local/standard-folders.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";

/**
 * Between plain folders (Standard Folders, folders added to the sidebar, and
 * any other folder through the computer place) a move is a move, as in
 * Finder: the item leaves where it was. That is also how a Cut made in GNOME
 * Files or Dolphin pastes here (desktop/src/file-clipboard-paste.ts names
 * such a file by the computer place). Each move names the place it came from,
 * so Undo can put it back there.
 */

test("a move between two plain places moves the item and says where it came from", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "amplefile-plain-moves-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = join(root, "From");
  const to = join(root, "To");
  await mkdir(join(from, "Folder"), { recursive: true });
  await mkdir(to);
  await writeFile(join(from, "one.txt"), "one");
  await writeFile(join(from, "Folder", "two.txt"), "two");
  await writeFile(join(root, "three.txt"), "three");
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), connectedFolderBase: join(root, "content"), loadEnv: false });
  t.after(async () => { await api.close(); configureAmpleFileStateRoot(undefined); });
  const fromPlace = { kind: "standard", id: addSidebarFolder(from, root).id };
  const toPlace = { kind: "standard", id: addSidebarFolder(to, root).id };
  const computer = { kind: "standard", id: "computer" };
  const post = async (body: unknown) => {
    const response = await fetch(`${api.origin}/api/file-transfer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };

  const moved = await post({ mode: "move", sources: [{ place: fromPlace, path: "one.txt" }, { place: fromPlace, path: "Folder" }], target: { place: toPlace, path: "" } });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.copiedInstead, undefined);
  assert.deepEqual(moved.json.written, ["one.txt", "Folder"]);
  assert.deepEqual(moved.json.moves, [
    { from: "one.txt", fromPlace, to: "one.txt" },
    { from: "Folder", fromPlace, to: "Folder" },
  ]);
  assert.equal(await lstat(join(from, "one.txt")).catch(() => null), null, "the item left its source");
  assert.equal(await readFile(join(to, "Folder", "two.txt"), "utf8"), "two");

  // A file named by the computer place (another app's Cut) moves into an added folder.
  const cut = await post({ mode: "move", sources: [{ place: computer, path: `${root.slice(1)}/three.txt` }], target: { place: toPlace, path: "" } });
  assert.equal(cut.status, 200, JSON.stringify(cut.json));
  assert.deepEqual(cut.json.moves, [{ from: `${root.slice(1)}/three.txt`, fromPlace: computer, to: "three.txt" }]);
  assert.equal(await lstat(join(root, "three.txt")).catch(() => null), null);

  // Undo, as the window does it: back to the place and folder each came from.
  const back = await post({ mode: "move", sources: [{ place: toPlace, path: "three.txt" }], target: { place: computer, path: root.slice(1) } });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(await readFile(join(root, "three.txt"), "utf8"), "three");
});
