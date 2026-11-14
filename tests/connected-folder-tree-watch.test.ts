import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test, { type TestContext } from "node:test";

import {
  connectedFolderWatchBudget,
  watchConnectedFolderTree,
  type ConnectedFolderTreeWatch,
  type WatchConnectedFolderDirectory,
} from "../src/local/connected-folder-tree-watch.js";

const linuxOnly = { skip: process.platform !== "linux" };

async function sandboxRoot(t: TestContext): Promise<string> {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "Connected Folder tree watch ")));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return sandbox;
}

/** A stand-in for the kernel: records which folders are watched and never reports a change. */
function recordingWatch(root: string) {
  const watched = new Set<string>();
  const watchDirectory: WatchConnectedFolderDirectory = (directory) => {
    const path = relative(root, directory).split(sep).join("/");
    assert.equal(watched.has(path), false, `${path} was watched twice`);
    watched.add(path);
    return { close: () => { watched.delete(path); }, on: () => undefined };
  };
  return { watched, watchDirectory, sorted: () => [...watched].sort() };
}

function startRecorded(t: TestContext, root: string, options: {
  skip?: (path: string) => boolean;
  maxDirectories?: number;
  maxShownDirectories?: number;
}) {
  const kernel = recordingWatch(root);
  const tree = watchConnectedFolderTree(root, {
    onChange: () => undefined,
    onError: (error) => { throw error; },
    skipDirectory: options.skip ?? (() => false),
    maxDirectories: options.maxDirectories ?? 1_000,
    maxShownDirectories: options.maxShownDirectories,
    watchDirectory: kernel.watchDirectory,
  });
  t.after(() => tree.close());
  return { tree, kernel };
}

test("a Connected Folder is watched one folder at a time, never one file at a time", async (t) => {
  const root = await sandboxRoot(t);
  await mkdir(join(root, "Drafts", "Old"), { recursive: true });
  await mkdir(join(root, "Photos"));
  for (let index = 0; index < 40; index++) await writeFile(join(root, "Drafts", `note-${index}.md`), "note");
  await writeFile(join(root, "Drafts", "Old", "a.txt"), "a");

  const { tree, kernel } = startRecorded(t, root, {});
  await tree.ready;
  assert.deepEqual(kernel.sorted(), ["", "Drafts", "Drafts/Old", "Photos"]);
  assert.equal(tree.directoryCount(), 4);
  assert.equal(tree.complete(), true);

  tree.close();
  assert.equal(kernel.watched.size, 0, "closing releases every watch");
});

test("skipped folders and everything beneath them stay unwatched, and symbolic links are not followed", async (t) => {
  const root = await sandboxRoot(t);
  const outside = await sandboxRoot(t);
  await mkdir(join(outside, "elsewhere"));
  await mkdir(join(root, "app", "node_modules", "left-pad", "lib"), { recursive: true });
  await mkdir(join(root, "app", "src"), { recursive: true });
  await mkdir(join(root, ".git", "objects", "ab"), { recursive: true });
  await symlink(outside, join(root, "linked"), "dir");

  const asked: string[] = [];
  const { tree, kernel } = startRecorded(t, root, {
    skip: (path) => { asked.push(path); return /(^|\/)(node_modules|\.git)$/.test(path); },
  });
  await tree.ready;
  assert.deepEqual(kernel.sorted(), ["", "app", "app/src"]);
  assert.equal(asked.includes(""), false, "the root is never skipped");
  assert.equal(asked.some((path) => path.startsWith("app/node_modules/")), false, "a skipped folder is not read");
});

test("the watch budget keeps the folders nearest the root and reports the tree incomplete", async (t) => {
  const root = await sandboxRoot(t);
  await mkdir(join(root, "a", "deep", "deeper"), { recursive: true });
  await mkdir(join(root, "b"));
  await mkdir(join(root, "c"));

  const { tree, kernel } = startRecorded(t, root, { maxDirectories: 4 });
  await tree.ready;
  assert.deepEqual(kernel.sorted(), ["", "a", "b", "c"]);
  assert.equal(tree.complete(), false);
});

test("a folder on screen is watched one level deep even when the tree leaves it out", async (t) => {
  const root = await sandboxRoot(t);
  for (const name of ["one", "two", "three"]) await mkdir(join(root, "node_modules", name, "lib"), { recursive: true });
  await writeFile(join(root, "node_modules", "file.txt"), "not a folder");

  const { tree, kernel } = startRecorded(t, root, { skip: (path) => path === "node_modules", maxShownDirectories: 2 });
  await tree.ready;
  assert.deepEqual(kernel.sorted(), [""]);

  await tree.show("node_modules");
  assert.deepEqual(kernel.sorted(), ["", "node_modules"], "one level, not the folders inside it");
  await tree.show("node_modules/one");
  await tree.show("node_modules/two");
  assert.deepEqual(kernel.sorted(), ["", "node_modules/one", "node_modules/two"], "the least recently shown folder is released");

  await tree.show("node_modules/one");
  await tree.show("node_modules/three");
  assert.deepEqual(kernel.sorted(), ["", "node_modules/one", "node_modules/three"], "showing a folder again keeps it");

  await tree.show("");
  await tree.show("node_modules/file.txt");
  await tree.show("node_modules/missing");
  await tree.show("../outside");
  assert.deepEqual(kernel.sorted(), ["", "node_modules/one", "node_modules/three"]);
});

test("a rescan follows changed skip answers in both directions", async (t) => {
  const root = await sandboxRoot(t);
  await mkdir(join(root, "Archive", "2019"), { recursive: true });
  await mkdir(join(root, "Work", "Now"), { recursive: true });

  const skipped = new Set(["Archive"]);
  const { tree, kernel } = startRecorded(t, root, { skip: (path) => skipped.has(path) });
  await tree.ready;
  assert.deepEqual(kernel.sorted(), ["", "Work", "Work/Now"]);

  skipped.clear();
  skipped.add("Work");
  await tree.rescan();
  assert.deepEqual(kernel.sorted(), ["", "Archive", "Archive/2019"]);
});

test("the watch budget is an eighth of the kernel's allowance within fixed bounds", () => {
  assert.equal(connectedFolderWatchBudget(() => "524288\n"), 16_384);
  assert.equal(connectedFolderWatchBudget(() => "65536\n"), 8_192);
  assert.equal(connectedFolderWatchBudget(() => "8192\n"), 1_024);
  assert.equal(connectedFolderWatchBudget(() => "512\n"), 256);
  assert.equal(connectedFolderWatchBudget(() => "not a number"), 8_192);
  assert.equal(connectedFolderWatchBudget(() => { throw new Error("no /proc"); }), 8_192);
});

/** The inotify watches this process holds, read from the kernel. */
function kernelWatchCount(): number {
  let count = 0;
  for (const descriptor of readdirSync("/proc/self/fdinfo")) {
    try {
      count += (readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8").match(/^inotify wd/gm) ?? []).length;
    } catch { /* the descriptor closed while reading */ }
  }
  return count;
}

function startReal(t: TestContext, root: string, skip: (path: string) => boolean = () => false) {
  const events: string[] = [];
  const tree: ConnectedFolderTreeWatch = watchConnectedFolderTree(root, {
    onChange: (_eventType, path) => { events.push(path ?? ""); },
    onError: (error) => { events.push(`error: ${String(error)}`); },
    skipDirectory: skip,
    maxDirectories: 1_000,
  });
  t.after(() => tree.close());
  const seen = async (path: string) => {
    const started = Date.now();
    while (!events.includes(path)) {
      if (Date.now() - started > 5_000) throw new Error(`No file event for ${path}; saw ${JSON.stringify(events)}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  };
  return { tree, events, seen };
}

test("the kernel holds one watch per folder for a Connected Folder full of files", linuxOnly, async (t) => {
  const root = await sandboxRoot(t);
  await mkdir(join(root, "Drafts", "Old"), { recursive: true });
  for (let index = 0; index < 200; index++) await writeFile(join(root, "Drafts", `note-${index}.md`), "note");

  const before = kernelWatchCount();
  const { tree } = startReal(t, root);
  await tree.ready;
  assert.equal(kernelWatchCount() - before, 3);
  tree.close();
  assert.equal(kernelWatchCount(), before);
});

test("changes are reported in existing folders, new folders, and renamed folders", linuxOnly, async (t) => {
  const root = await sandboxRoot(t);
  await mkdir(join(root, "Drafts", "Old"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });

  const { tree, events, seen } = startReal(t, root, (path) => path === "node_modules");
  await tree.ready;

  await writeFile(join(root, "Drafts", "Old", "deep.txt"), "deep");
  await seen("Drafts/Old/deep.txt");

  await mkdir(join(root, "New", "Inner"), { recursive: true });
  await seen("New");
  // The event for a folder itself arrives once it is watched.
  await seen("New/Inner");
  await writeFile(join(root, "New", "Inner", "later.txt"), "later");
  await seen("New/Inner/later.txt");

  await rename(join(root, "Drafts"), join(root, "Final"));
  await seen("Final/Old");
  events.length = 0;
  await writeFile(join(root, "Final", "Old", "after-rename.txt"), "after");
  await seen("Final/Old/after-rename.txt");
  assert.equal(events.some((path) => path.startsWith("Drafts")), false, "a renamed folder reports under its new name only");

  await writeFile(join(root, "node_modules", "pkg", "index.js"), "skipped");
  await writeFile(join(root, "marker.txt"), "marker");
  await seen("marker.txt");
  assert.equal(events.some((path) => path.startsWith("node_modules/")), false, "a skipped folder reports nothing");

  await tree.show("node_modules/pkg");
  await writeFile(join(root, "node_modules", "pkg", "shown.js"), "shown");
  await seen("node_modules/pkg/shown.js");
});
