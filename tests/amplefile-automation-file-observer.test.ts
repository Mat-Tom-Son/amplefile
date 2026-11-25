import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rename, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";
import { registerLinkedConnectedFolder } from "../src/local/connected-folder.js";
import {
  observeAmpleFileAutomationFiles,
  ampleFileAutomationArrivedPaths,
  ampleFileAutomationChangedPaths,
  ampleFileAutomationPlacedFileIds,
  AmpleFileAutomationFileWatch,
  type AmpleFileAutomationFileSnapshot,
} from "../src/local/automations/automation-file-observer.js";
import { ampleFileAutomationBounds, type AmpleFileAutomationFilesChangedTrigger } from "../src/local/automations/automation-declarations.js";

test("folder observation bounds file types, detects same-size edits, and refuses linked or separately owned trees", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "amplefile-observer-"));
  configureAmpleFileStateRoot(join(dir, "state"));
  t.after(async () => { configureAmpleFileStateRoot(undefined); await rm(dir, { recursive: true, force: true }); });
  const root = join(dir, "connected-folder");
  await mkdir(join(root, "Drafts"), { recursive: true });
  const connectedFolder = await registerLinkedConnectedFolder(root);
  await writeFile(join(root, "Drafts/a.md"), "before");
  await writeFile(join(root, "Drafts/b.txt"), "outside filter");
  const trigger: AmpleFileAutomationFilesChangedTrigger = { kind: "files-changed", connectedFolder: connectedFolder.id, watch: { kind: "tree", path: "Drafts", recursive: true, extensions: [".md"] }, debounceSeconds: 2, cooldownMinutes: 1 };
  const before = await observeAmpleFileAutomationFiles(trigger);
  assert.deepEqual(Object.keys(before.entries), ["Drafts/a.md"]);
  await writeFile(join(root, "Drafts/a.md"), "after!");
  assert.notEqual((await observeAmpleFileAutomationFiles(trigger)).digest, before.digest);
  await symlink(join(root, "Drafts/a.md"), join(root, "Drafts/link.md"));
  await assert.rejects(observeAmpleFileAutomationFiles(trigger), /link/i);
  await rm(join(root, "Drafts/link.md"));
  await mkdir(join(root, "Drafts/Child"));
  await registerLinkedConnectedFolder(join(root, "Drafts/Child"));
  await assert.rejects(observeAmpleFileAutomationFiles(trigger), /another registered Connected Folder/);
});

test("observer combines changes through cooldown, reports the changed paths, and fresh baselines do not catch up", () => {
  const watch = new AmpleFileAutomationFileWatch();
  const trigger: AmpleFileAutomationFilesChangedTrigger = { kind: "files-changed", connectedFolder: "space-aaaaaaaaaaaaaaaa", watch: { kind: "tree", path: "Drafts", recursive: false, extensions: [".md"] }, debounceSeconds: 2, cooldownMinutes: 1 };
  const snapshot = (n: number) => ({ digest: `${n}`, entries: { "a.md": `${n}` } });
  assert.equal(watch.observe(snapshot(1), 0, trigger), null);
  assert.equal(watch.observe(snapshot(2), 1_000, trigger), null);
  // The paths feed {{trigger.changedFiles}}; the count is always the true one.
  assert.deepEqual(watch.observe(snapshot(2), 3_000, trigger), { changedCount: 1, changedPaths: ["a.md"] });
  assert.equal(watch.observe(snapshot(3), 4_000, trigger), null);
  assert.equal(watch.observe(snapshot(3), 6_000, trigger), null);
  assert.equal(watch.observe(snapshot(4), 60_000, trigger), null);
  assert.deepEqual(watch.observe(snapshot(4), 63_000, trigger), { changedCount: 1, changedPaths: ["a.md"] });
  watch.reset();
  assert.equal(watch.observe(snapshot(5), 200_000, trigger), null);
  assert.equal(watch.observe(snapshot(5), 202_000, trigger), null);
});

test("changed paths are sorted and capped, and the count stays true", () => {
  const watch = new AmpleFileAutomationFileWatch();
  const trigger: AmpleFileAutomationFilesChangedTrigger = { kind: "files-changed", connectedFolder: "space-aaaaaaaaaaaaaaaa", watch: { kind: "tree", path: "Drafts", recursive: false, extensions: [".md"] }, debounceSeconds: 2, cooldownMinutes: 1 };
  const many = ampleFileAutomationBounds.maxChangedPathsRecorded + 1;
  const entries = Object.fromEntries(
    Array.from({ length: many }, (_, index) => [`note-${String(index).padStart(3, "0")}.md`, "1"]),
  );
  assert.equal(watch.observe({ digest: "base", entries: {} }, 0, trigger), null);
  assert.equal(watch.observe({ digest: "changed", entries }, 1_000, trigger), null);
  const observed = watch.observe({ digest: "changed", entries }, 4_000, trigger);
  assert.equal(observed?.changedCount, many);
  assert.equal(observed?.changedPaths.length, ampleFileAutomationBounds.maxChangedPathsRecorded);
  assert.deepEqual(observed?.changedPaths, [...observed!.changedPaths].sort());
  assert.equal(observed?.changedPaths[0], "note-000.md");
});

const draftsTrigger: AmpleFileAutomationFilesChangedTrigger = { kind: "files-changed", connectedFolder: "space-aaaaaaaaaaaaaaaa", watch: { kind: "tree", path: "Drafts", recursive: false, extensions: [".md"] }, debounceSeconds: 2, cooldownMinutes: 0 };

/** Feeds one look to the watch and returns what fired once that look has settled for the debounce. */
function settle(watch: AmpleFileAutomationFileWatch, snapshot: AmpleFileAutomationFileSnapshot, at: number) {
  assert.equal(watch.observe(snapshot, at, draftsTrigger), null);
  return watch.observe(snapshot, at + 2_000, draftsTrigger);
}

test("only a new path or a new size or modification time counts as a change; metadata, renames, and removals never do", () => {
  const before = { digest: "a", entries: { "S/same.md": "1:10:5:100:100", "S/opened.md": "1:11:5:100:100", "S/edited.md": "1:12:5:100:100", "S/old-name.md": "1:13:5:100:100", "S/gone.md": "1:14:5:100:100", "S/renamed-and-edited.md": "1:15:5:100:100" } };
  const after = { digest: "b", entries: {
    "S/same.md": "1:10:5:100:100",
    // Opening a file, a Finder tag, Spotlight, or a sync client: change time only.
    "S/opened.md": "1:11:5:100:999",
    "S/edited.md": "1:12:5:101:101",
    "S/new-name.md": "1:13:5:100:200",
    "S/edited-after-rename.md": "1:15:6:300:300",
    "S/new.md": "1:16:5:100:100",
  } };
  assert.deepEqual(ampleFileAutomationChangedPaths(before, after), ["S/edited-after-rename.md", "S/edited.md", "S/new.md"]);
  const renamed = { digest: "c", entries: { "S/b.md": "1:10:5:100:300" } };
  assert.deepEqual(ampleFileAutomationChangedPaths({ digest: "d", entries: { "S/a.md": "1:10:5:100:100" } }, renamed), []);
  assert.deepEqual(ampleFileAutomationChangedPaths(renamed, { digest: "e", entries: { "S/a.md": "1:10:5:100:400" } }), [], "renaming back is a rename too");
  // A copy beside the original is a new file, even with the same size and time.
  assert.deepEqual(ampleFileAutomationChangedPaths(renamed, { digest: "f", entries: { "S/b.md": "1:10:5:100:300", "S/b copy.md": "1:17:5:100:300" } }), ["S/b copy.md"]);
});

test("a watch starts no run for a file's metadata, a rename, or a removal, and still runs for a new file", () => {
  const watch = new AmpleFileAutomationFileWatch();
  const look = (entries: Record<string, string>) => ({ digest: JSON.stringify(entries), entries });
  assert.equal(watch.observe(look({ "a.md": "1:10:5:100:100", "b.md": "1:11:5:100:100" }), 0, draftsTrigger), null);
  assert.equal(settle(watch, look({ "a.md": "1:10:5:100:777", "b.md": "1:11:5:100:100" }), 10_000), null, "change time only");
  assert.equal(settle(watch, look({ "renamed.md": "1:10:5:100:888", "b.md": "1:11:5:100:100" }), 20_000), null, "a rename");
  assert.equal(settle(watch, look({ "renamed.md": "1:10:5:100:888" }), 30_000), null, "a removal");
  assert.deepEqual(settle(watch, look({ "renamed.md": "1:10:5:100:888", "new.md": "1:12:5:100:100" }), 40_000), { changedCount: 1, changedPaths: ["new.md"] });
});

test("on disk, a last-opened date, a mode change, a rename, and a removal start no run, and a new file does", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "amplefile-observer-metadata-"));
  configureAmpleFileStateRoot(join(dir, "state"));
  t.after(async () => { configureAmpleFileStateRoot(undefined); await rm(dir, { recursive: true, force: true }); });
  const root = join(dir, "connected-folder");
  await mkdir(join(root, "Drafts"), { recursive: true });
  const connectedFolder = await registerLinkedConnectedFolder(root);
  await writeFile(join(root, "Drafts/a.md"), "kept");
  await writeFile(join(root, "Drafts/b.md"), "kept");
  const trigger: AmpleFileAutomationFilesChangedTrigger = { ...draftsTrigger, connectedFolder: connectedFolder.id };
  const watch = new AmpleFileAutomationFileWatch();
  let now = 0;
  const step = async () => {
    const snapshot = await observeAmpleFileAutomationFiles(trigger);
    now += 10_000;
    assert.equal(watch.observe(snapshot, now, trigger), null);
    return { snapshot, fired: watch.observe(snapshot, now + 2_000, trigger) };
  };
  const baseline = (await step()).snapshot;
  const before = await lstat(join(root, "Drafts/a.md"), { bigint: true });

  // macOS writes the date a file was last opened as an extended attribute;
  // it changes the file's change time and nothing else.
  if (process.platform === "darwin") {
    await promisify(execFile)("xattr", ["-w", "com.apple.lastuseddate#PS", "opened", join(root, "Drafts/a.md")]);
  }
  await chmod(join(root, "Drafts/a.md"), 0o600);
  const after = await lstat(join(root, "Drafts/a.md"), { bigint: true });
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.size, before.size);
  const metadata = await step();
  assert.notEqual(metadata.snapshot.digest, baseline.digest, "the look did see the change time move");
  assert.equal(metadata.fired, null);

  await rename(join(root, "Drafts/b.md"), join(root, "Drafts/b renamed.md"));
  assert.equal((await step()).fired, null);
  await rm(join(root, "Drafts/b renamed.md"));
  assert.equal((await step()).fired, null);
  await writeFile(join(root, "Drafts/new.md"), "new");
  assert.deepEqual((await step()).fired, { changedCount: 1, changedPaths: ["Drafts/new.md"] });
});

test("after automation runs, only new files that no run placed are owed one follow-up; edits, renames, and metadata are absorbed", () => {
  const watch = new AmpleFileAutomationFileWatch();
  const look = (entries: Record<string, string>) => ({ digest: JSON.stringify(entries), entries });
  assert.equal(watch.observe(look({ "Drafts/edited.md": "1:10:5:100:100", "Drafts/raw.md": "1:11:5:100:100", "Drafts/opened.md": "1:12:5:100:100", "Drafts/saved over.md": "1:16:5:100:100" }), 0, draftsTrigger), null);
  watch.pauseForRun();
  assert.equal(watch.view().state, "paused");
  // What the runs placed, by device and inode: an act's file, a copied
  // folder's files, and a file Pi's write tool made then renamed by a shell.
  watch.resumeAfterRuns(["1:13", "1:14", "1:17"], false);
  assert.equal(watch.lookDueAfterRuns, true);
  const after = look({
    "Drafts/edited.md": "1:10:9:200:200",
    "Drafts/filed name.md": "1:11:5:100:300",
    "Drafts/opened.md": "1:12:5:100:400",
    // `sed -i` or a safe-save: a new file in the old one's place is an edit.
    "Drafts/saved over.md": "1:18:7:300:300",
    "Drafts/created-by-act.md": "1:13:5:100:100",
    "Drafts/copied-folder/one.md": "1:14:5:100:100",
    "Drafts/Written Then Renamed.md": "1:17:5:100:500",
    "Drafts/arrived.md": "1:15:5:100:100",
  });
  assert.equal(watch.observe(after, 10_000, draftsTrigger), null, "the first look after the runs compares and waits for the debounce");
  assert.equal(watch.lookDueAfterRuns, false);
  assert.deepEqual(watch.view().followingUp, { count: 1 });
  const fired = watch.observe(after, 12_000, draftsTrigger);
  assert.deepEqual(fired, { changedCount: 1, changedPaths: ["Drafts/arrived.md"], followUp: { count: 1 } });
  assert.equal(watch.view().followingUp, undefined);
});

test("a follow-up run's pause, a gap, or a watch with no look before the runs owes nothing", () => {
  const look = (entries: Record<string, string>) => ({ digest: JSON.stringify(entries), entries });
  const arrived = look({ "a.md": "1:10:5:100:100", "new.md": "1:11:5:100:100" });
  const scenarios: Array<[string, (watch: AmpleFileAutomationFileWatch) => void]> = [
    ["a follow-up run was among the runs", (watch) => { watch.pauseForRun(); watch.resumeAfterRuns([], true); }],
    ["the computer slept during the run", (watch) => { watch.pauseForRun(); watch.reset(true); watch.resumeAfterRuns([], false); }],
  ];
  for (const [label, act] of scenarios) {
    const watch = new AmpleFileAutomationFileWatch();
    assert.equal(watch.observe(look({ "a.md": "1:10:5:100:100" }), 0, draftsTrigger), null);
    act(watch);
    assert.equal(watch.observe(arrived, 10_000, draftsTrigger), null, label);
    assert.equal(watch.observe(arrived, 12_000, draftsTrigger), null, label);
  }
  const unseen = new AmpleFileAutomationFileWatch();
  unseen.pauseForRun();
  unseen.resumeAfterRuns([], false);
  assert.equal(unseen.lookDueAfterRuns, false);
  assert.equal(unseen.observe(arrived, 10_000, draftsTrigger), null);
  assert.equal(unseen.observe(arrived, 12_000, draftsTrigger), null);
});

test("on disk, a file saved over by a new file at the same path is an edit, never an arrival", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "amplefile-observer-replace-"));
  configureAmpleFileStateRoot(join(dir, "state"));
  t.after(async () => { configureAmpleFileStateRoot(undefined); await rm(dir, { recursive: true, force: true }); });
  const root = join(dir, "connected-folder");
  await mkdir(join(root, "Drafts"), { recursive: true });
  const connectedFolder = await registerLinkedConnectedFolder(root);
  await writeFile(join(root, "Drafts/notes.md"), "before");
  await writeFile(join(root, "Drafts/caption.md"), "before");
  const trigger: AmpleFileAutomationFilesChangedTrigger = { ...draftsTrigger, connectedFolder: connectedFolder.id };
  const before = await observeAmpleFileAutomationFiles(trigger);
  const inode = async (path: string) => (await lstat(join(root, path), { bigint: true })).ino;
  const notesInode = await inode("Drafts/notes.md");
  const captionInode = await inode("Drafts/caption.md");

  // A safe-save: write a temporary file beside it and rename it over.
  await writeFile(join(root, "Drafts/.notes.md.tmp"), "after, longer");
  await rename(join(root, "Drafts/.notes.md.tmp"), join(root, "Drafts/notes.md"));
  // And, on a Mac, BSD sed's in-place edit, which does the same.
  if (process.platform === "darwin") await promisify(execFile)("sed", ["-i", "", "s/before/after/", join(root, "Drafts/caption.md")]);
  else {
    await writeFile(join(root, "Drafts/.caption.md.tmp"), "after");
    await rename(join(root, "Drafts/.caption.md.tmp"), join(root, "Drafts/caption.md"));
  }
  assert.notEqual(await inode("Drafts/notes.md"), notesInode, "the save made a new file");
  assert.notEqual(await inode("Drafts/caption.md"), captionInode, "the in-place edit made a new file");
  await writeFile(join(root, "Drafts/new.md"), "new");

  const after = await observeAmpleFileAutomationFiles(trigger);
  assert.deepEqual(ampleFileAutomationChangedPaths(before, after), ["Drafts/caption.md", "Drafts/new.md", "Drafts/notes.md"], "the edits still count as live changes");
  assert.deepEqual(ampleFileAutomationArrivedPaths(before, after, new Set()), ["Drafts/new.md"]);
});

test("placed-file ids are the device and inode of each file, inside copied folders too, never through a link", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "amplefile-observer-placed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "batch", "inner"), { recursive: true });
  await writeFile(join(dir, "one.md"), "1");
  await writeFile(join(dir, "batch", "two.md"), "2");
  await writeFile(join(dir, "batch", "inner", "three.md"), "3");
  await symlink(join(dir, "one.md"), join(dir, "batch", "link.md"));
  const id = async (path: string) => {
    const info = await lstat(join(dir, path), { bigint: true });
    return `${info.dev}:${info.ino}`;
  };
  const ids = await ampleFileAutomationPlacedFileIds([join(dir, "one.md"), join(dir, "batch"), join(dir, "missing.md")]);
  assert.deepEqual(ids.sort(), [await id("one.md"), await id("batch/two.md"), await id("batch/inner/three.md")].sort());
});
