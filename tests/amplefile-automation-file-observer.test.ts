import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";
import { registerLinkedConnectedFolder } from "../src/local/connected-folder.js";
import { observeAmpleFileAutomationFiles, AmpleFileAutomationFileWatch } from "../src/local/automations/automation-file-observer.js";
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
