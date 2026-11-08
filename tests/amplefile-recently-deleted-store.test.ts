import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  AMPLEFILE_RECENTLY_DELETED_DEFAULT_RETENTION_DAYS,
  AmpleFileRecentlyDeletedError,
  AmpleFileRecentlyDeletedStore,
  ampleFileRecentlyDeletedEntryIdPattern,
  type AmpleFileRecentlyDeletedManifest,
  type AmpleFileRecentlyDeletedStoreOptions,
} from "../src/local/recently-deleted-store.js";
import { configureAmpleFileStateRoot, ampleFileStateRoot, ampleFileRecentlyDeletedRoot } from "../src/local/state-paths.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function sandbox(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "amplefile-recently-deleted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function openStore(root: string, options: Partial<AmpleFileRecentlyDeletedStoreOptions> = {}): Promise<AmpleFileRecentlyDeletedStore> {
  return await AmpleFileRecentlyDeletedStore.open({ rootPath: join(root, "recently-deleted"), ...options });
}

async function readManifest(entryPath: string): Promise<AmpleFileRecentlyDeletedManifest> {
  return JSON.parse(await readFile(join(entryPath, "manifest.json"), "utf8")) as AmpleFileRecentlyDeletedManifest;
}

async function writeManifest(entryPath: string, manifest: unknown): Promise<void> {
  await writeFile(join(entryPath, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
}

function exdevError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
}

async function rejectsRecentlyDeletedError(promise: Promise<unknown>, code: AmpleFileRecentlyDeletedError["code"], pattern?: RegExp): Promise<AmpleFileRecentlyDeletedError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AmpleFileRecentlyDeletedError, `expected a AmpleFileTrashError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

/**
 * Plants an entry the way an earlier build kept Connected Folder app data, a
 * Release, or App Studio history: a complete manifest beside its payload file
 * or folder.
 */
async function plantOldAppEntry(
  root: string,
  id: string,
  kind: "app-storage" | "app-retained" | "app-release" | "app-studio",
  restoreBy = "2099-01-01T00:00:00.000Z",
): Promise<string> {
  const entryPath = join(root, "recently-deleted", "entries", id);
  await mkdir(join(entryPath, "payload"), { recursive: true });
  const appData = {
    kind: "app-data", appId: "quotes", appDigest: "a".repeat(64), featureInstallationId: "feature-installation_test",
    runtimeInstanceId: "runtime-instance_test", dataNamespaceId: "data-namespace_test", sourceConnectedFolderId: "connected-folder_source",
    projectId: "project_quotes", releaseDigest: null,
  };
  const payload = kind === "app-release"
    ? { kind: "app-release", projectId: "project_quotes", releaseDigest: `sha256:${"c".repeat(64)}`, displayVersion: "1.0.0", sourceConnectedFolderId: "connected-folder-1" }
    : kind === "app-studio"
      ? { kind: "app-studio", connectedFolderId: "connected-folder-1", projectId: "project_quotes" }
      : kind === "app-retained" ? { ...appData, retainedDataId: "retained-data_1" } : appData;
  if (kind === "app-studio") {
    await mkdir(join(entryPath, "payload", "app-studio"), { recursive: true });
    await writeFile(join(entryPath, "payload", "app-studio", "studio.json"), "{}");
  } else {
    await writeFile(join(entryPath, "payload", kind === "app-release" ? "app-release.json" : "app-data.json"), "{}");
  }
  await writeManifest(entryPath, {
    version: 1, id, kind,
    reason: kind === "app-release" ? "apps.release.delete" : kind === "app-studio" ? "apps.connected-folder.removed" : kind === "app-retained" ? "apps.retained.purge" : "apps.storage.clear",
    connectedFolderId: "connected-folder-1", originalPath: "quotes/data-namespace_test", sizeBytes: 2,
    deletedAt: "2026-11-01T00:00:00.000Z", restoreBy, receiptId: null, payload, complete: true,
  });
  return entryPath;
}

test("ampleFileTrashRoot lives under the state root", () => {
  configureAmpleFileStateRoot("/tmp/amplefile-recently-deleted-state-root");
  try {
    assert.equal(ampleFileRecentlyDeletedRoot(), join(ampleFileStateRoot(), "recently-deleted"));
  } finally {
    configureAmpleFileStateRoot(undefined);
  }
});

test("identity-preserving restores refuse a destination occupied while queued and keep the recovery entry", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const sourcePath = join(root, "chat-saved.jsonl");
  const keep = async (content: string) => {
    await writeFile(sourcePath, content);
    return store.moveTreeToRecentlyDeleted({
      kind: "file", reason: "chats.delete", sourcePath, connectedFolderId: "connected-folder-test",
      originalPath: ".amplefile/conversations/chat-saved.jsonl", receiptId: null,
    });
  };
  const first = await keep("first transcript\n");
  const second = await keep("second transcript\n");
  const outcomes = await Promise.allSettled([
    store.restoreTree(first.id, { absolutePath: sourcePath, onConflict: "error" }),
    store.restoreTree(second.id, { absolutePath: sourcePath, onConflict: "error" }),
  ]);
  assert.equal(outcomes[0]?.status, "fulfilled");
  assert.equal(outcomes[1]?.status, "rejected");
  if (outcomes[1]?.status === "rejected") assert.match(String(outcomes[1].reason), /identity already exists/);
  assert.equal(await readFile(sourcePath, "utf8"), "first transcript\n");
  assert.equal(existsSync(join(root, "chat-saved (2).jsonl")), false);
  const kept = await store.get(second.id);
  assert.ok(kept);
  assert.equal(await readFile(kept.payloadPath, "utf8"), "second transcript\n");
});

test("a removed Skill is kept as a whole folder with its scope, survives reopen, and goes back as an identity", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const skillDir = join(root, "skills", "pack", "writer");
  await mkdir(join(skillDir, "scripts"), { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: writer\n---\n");
  await writeFile(join(skillDir, "scripts", "run.sh"), "#!/bin/sh\n");

  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "skill", reason: "skills.remove", sourcePath: skillDir, connectedFolderId: "amplefile-agent",
    originalPath: "pack/writer", receiptId: null,
  }), "INPUT_INVALID", /names the scope/);
  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "folder", reason: "skills.remove", sourcePath: skillDir, connectedFolderId: "amplefile-agent",
    originalPath: "pack/writer", receiptId: null, skill: { scope: "everywhere", skillName: "writer" },
  }), "INPUT_INVALID", /names the scope/);
  assert.equal(existsSync(join(skillDir, "SKILL.md")), true, "a refused move leaves the Skill in place");

  const entry = await store.moveTreeToRecentlyDeleted({
    kind: "skill", reason: "skills.remove", sourcePath: skillDir, connectedFolderId: "amplefile-agent", connectedFolderName: "Everywhere",
    displayName: "writer", originalPath: "pack/writer", receiptId: "settings:test", skill: { scope: "everywhere", skillName: "writer" },
  });
  assert.equal(existsSync(skillDir), false);
  assert.deepEqual(entry.payload, { kind: "skill", scope: "everywhere", name: "writer", skillName: "writer" });
  assert.equal(entry.payloadPath, join(entry.entryPath, "payload", "writer"));
  assert.equal(entry.sizeBytes, "---\nname: writer\n---\n".length + "#!/bin/sh\n".length);
  assert.equal((await readManifest(entry.entryPath)).kind, "skill");

  const reopened = await openStore(root);
  const listed = await reopened.get(entry.id);
  assert.deepEqual(listed?.payload, entry.payload);

  // Something already at the path is never collision-renamed into a second Skill.
  await mkdir(skillDir, { recursive: true });
  await rejectsRecentlyDeletedError(reopened.restoreTree(entry.id, { absolutePath: skillDir, onConflict: "error" }), "MOVE_FAILED", /already exists/);
  await rm(skillDir, { recursive: true });
  await rm(dirname(skillDir), { recursive: true });
  const restored = await reopened.restoreTree(entry.id, { absolutePath: skillDir, onConflict: "error" });
  assert.deepEqual(restored, { restoredPath: skillDir, renamed: false });
  assert.equal(await readFile(join(skillDir, "scripts", "run.sh"), "utf8"), "#!/bin/sh\n");
  assert.equal(await reopened.get(entry.id), null);

  // A damaged Skill payload is reported, never guessed at.
  const damaged = await reopened.moveTreeToRecentlyDeleted({
    kind: "skill", reason: "skills.remove", sourcePath: skillDir, connectedFolderId: "connected-folder-test",
    originalPath: "pack/writer", receiptId: null, skill: { scope: "connected-folder", skillName: "writer" },
  });
  await writeManifest(damaged.entryPath, { ...(await readManifest(damaged.entryPath)), payload: { kind: "skill", scope: "nowhere", name: "writer", skillName: "writer" } });
  const listing = await reopened.list();
  assert.deepEqual(listing.entries, []);
  assert.match(listing.damaged[0]?.error ?? "", /invalid Skill payload/);
});

test("open creates the layout with default retention, keeps it across reopen, and bounds retention changes", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  assert.equal(store.retentionDays(), AMPLEFILE_RECENTLY_DELETED_DEFAULT_RETENTION_DAYS);
  assert.equal(store.lastPurgeAt(), null);
  for (const child of ["entries", "incoming", "settings.json"]) assert.ok(existsSync(join(store.rootPath, child)), child);
  if (process.platform !== "win32") {
    assert.equal((await stat(store.rootPath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(store.rootPath, "settings.json"))).mode & 0o777, 0o600);
  }

  await store.setRetentionDays(45);
  const reopened = await openStore(root);
  assert.equal(reopened.retentionDays(), 45);

  await rejectsRecentlyDeletedError(reopened.setRetentionDays(400), "INPUT_INVALID", /between 1 and 365/);
  await rejectsRecentlyDeletedError(reopened.setRetentionDays(0), "INPUT_INVALID");
  await rejectsRecentlyDeletedError(reopened.setRetentionDays(7.5), "INPUT_INVALID");
  await rejectsRecentlyDeletedError(AmpleFileRecentlyDeletedStore.open({ rootPath: join(root, "other"), defaultRetentionDays: 0 }), "INPUT_INVALID");

  // The retention change rewrites every complete manifest's restoreBy.
  const connectedFolder = join(root, "connected-folder");
  await mkdir(connectedFolder, { recursive: true });
  await writeFile(join(connectedFolder, "note.txt"), "keep me");
  const entry = await reopened.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "note.txt"), connectedFolderId: "connected-folder-1", originalPath: "note.txt", receiptId: null,
  });
  assert.equal(Date.parse(entry.restoreBy) - Date.parse(entry.deletedAt), 45 * DAY_MS);
  await reopened.setRetentionDays(7);
  const rewritten = await readManifest(entry.entryPath);
  assert.equal(Date.parse(rewritten.restoreBy) - Date.parse(rewritten.deletedAt), 7 * DAY_MS);
  assert.equal((await reopened.list()).retentionDays, 7);

  await writeFile(join(store.rootPath, "settings.json"), "{ not json");
  await rejectsRecentlyDeletedError(openStore(root), "STORE_DAMAGED", /not valid JSON/);
});

test("trashTree moves a file with a complete manifest, size, receipt, and uncovered reasons", async (t) => {
  const root = await sandbox(t);
  const now = new Date("2026-09-10T12:00:00.000Z");
  const store = await openStore(root, { now: () => now });
  const connectedFolder = join(root, "connected-folder");
  await mkdir(join(connectedFolder, "docs"), { recursive: true });
  const source = join(connectedFolder, "docs", "big.bin");
  await writeFile(source, Buffer.alloc(1234, 7));

  const entry = await store.moveTreeToRecentlyDeleted({
    kind: "file",
    reason: "files.delete",
    sourcePath: source,
    connectedFolderId: "connected-folder-1",
    connectedFolderName: "Fold Connected Folder",
    originalPath: "docs/big.bin",
    receiptId: "act_request_1",
    uncovered: [{ path: "docs/big.bin", reason: "too_large" }],
  });

  assert.match(entry.id, ampleFileRecentlyDeletedEntryIdPattern);
  assert.ok(entry.id.startsWith("trash-20260910120000-"));
  assert.equal(existsSync(source), false);
  assert.equal(entry.payloadPath, join(entry.entryPath, "payload", "big.bin"));
  assert.deepEqual(await readFile(entry.payloadPath), Buffer.alloc(1234, 7));
  assert.equal(entry.complete, true);
  assert.equal(entry.kind, "file");
  assert.equal(entry.sizeBytes, 1234);
  assert.equal(entry.sizeApproximate, undefined);
  assert.equal(entry.receiptId, "act_request_1");
  assert.equal(entry.originalPath, "docs/big.bin");
  assert.equal(entry.connectedFolderName, "Fold Connected Folder");
  assert.deepEqual(entry.uncovered, [{ path: "docs/big.bin", reason: "too_large" }]);
  assert.deepEqual(entry.payload, { kind: "tree", name: "big.bin" });
  assert.equal(entry.deletedAt, now.toISOString());
  assert.equal(entry.restoreBy, new Date(now.getTime() + 30 * DAY_MS).toISOString());

  const onDisk = await readManifest(entry.entryPath);
  assert.equal(onDisk.complete, true);
  assert.equal(onDisk.sizeBytes, 1234);
  assert.deepEqual(await store.get(entry.id), entry);

  // Kind must match what is on disk, and nothing moves when it does not.
  await mkdir(join(connectedFolder, "folder"));
  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "folder"), connectedFolderId: "connected-folder-1", originalPath: "folder", receiptId: null,
  }), "INPUT_INVALID", /is a folder/);
  assert.ok(existsSync(join(connectedFolder, "folder")));
  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "folder", reason: "files.delete", sourcePath: join(connectedFolder, "missing"), connectedFolderId: "connected-folder-1", originalPath: "missing", receiptId: null,
  }), "MOVE_FAILED", /Nothing was moved/);
  assert.equal((await store.list()).entries.length, 1);
});

test("trashTree moves a folder verbatim: links stay links and unreadable files arrive byte for byte", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const connectedFolder = join(root, "connected-folder");
  const folder = join(connectedFolder, "bulk");
  await mkdir(join(folder, "nested"), { recursive: true });
  await writeFile(join(folder, "target.txt"), "target");
  await writeFile(join(folder, "nested", "deep.txt"), "deep");
  await symlink("target.txt", join(folder, "link"));
  await symlink("/nowhere/dangling", join(folder, "dangling"));
  const locked = join(folder, "locked.txt");
  await writeFile(locked, "secret bytes");
  const restrictable = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
  if (restrictable) await chmod(locked, 0o000);

  const entry = await store.moveTreeToRecentlyDeleted({
    kind: "folder",
    reason: "files.delete",
    sourcePath: folder,
    connectedFolderId: "connected-folder-1",
    originalPath: "bulk",
    receiptId: "act_request_2",
    uncovered: [{ path: "bulk/link", reason: "symbolic_link" }, { path: "bulk/locked.txt", reason: "unreadable" }],
  });

  assert.equal(existsSync(folder), false);
  assert.equal(entry.kind, "folder");
  const link = join(entry.payloadPath, "link");
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(await readlink(link), "target.txt");
  assert.ok((await lstat(join(entry.payloadPath, "dangling"))).isSymbolicLink());
  assert.equal(await readFile(join(entry.payloadPath, "nested", "deep.txt"), "utf8"), "deep");
  const movedLocked = join(entry.payloadPath, "locked.txt");
  if (restrictable) {
    assert.equal((await stat(movedLocked)).mode & 0o777, 0o000);
    await chmod(movedLocked, 0o600);
  }
  assert.equal(await readFile(movedLocked, "utf8"), "secret bytes");
  assert.equal(entry.sizeApproximate, undefined);
  assert.equal(entry.sizeBytes, "target".length + "deep".length + "secret bytes".length + "target.txt".length + "/nowhere/dangling".length);
});

test("a cross-device move copies through incoming/, releases the source, and commits the manifest", async (t) => {
  const root = await sandbox(t);
  let thrown = false;
  const renames: Array<[string, string]> = [];
  const store = await openStore(root, {
    io: {
      async rename(from, to) {
        renames.push([from, to]);
        if (!thrown) {
          thrown = true;
          throw exdevError();
        }
        await rename(from, to);
      },
    },
  });
  const connectedFolder = join(root, "connected-folder");
  const folder = join(connectedFolder, "drafts");
  await mkdir(join(folder, "inner"), { recursive: true });
  await writeFile(join(folder, "a.txt"), "alpha");
  await writeFile(join(folder, "inner", "b.txt"), "beta");
  await symlink("a.txt", join(folder, "alias"));

  const entry = await store.moveTreeToRecentlyDeleted({
    kind: "folder", reason: "files.delete", sourcePath: folder, connectedFolderId: "connected-folder-1", originalPath: "drafts", receiptId: null,
  });

  assert.equal(thrown, true);
  assert.equal(existsSync(folder), false);
  assert.equal(await readFile(join(entry.payloadPath, "a.txt"), "utf8"), "alpha");
  assert.equal(await readFile(join(entry.payloadPath, "inner", "b.txt"), "utf8"), "beta");
  assert.ok((await lstat(join(entry.payloadPath, "alias"))).isSymbolicLink());
  assert.equal(await readlink(join(entry.payloadPath, "alias")), "a.txt");
  assert.equal(entry.complete, true);
  assert.equal(entry.sizeBytes, "alpha".length + "beta".length + "a.txt".length);
  assert.equal((await readManifest(entry.entryPath)).complete, true);
  assert.deepEqual(await readdir(join(store.rootPath, "incoming")), []);
  assert.ok(renames.some(([from, to]) => from.includes(join("incoming")) && to === entry.payloadPath), "the staged copy was renamed into place");
});

test("a move that fails before landing leaves the source untouched and no entry behind", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root, {
    io: {
      async rename() {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      },
    },
  });
  const connectedFolder = join(root, "connected-folder");
  await mkdir(connectedFolder, { recursive: true });
  await writeFile(join(connectedFolder, "note.txt"), "still here");

  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "note.txt"), connectedFolderId: "connected-folder-1", originalPath: "note.txt", receiptId: null,
  }), "MOVE_FAILED", /could not move .* into Recently deleted: EPERM.*Nothing was moved/);

  assert.equal(await readFile(join(connectedFolder, "note.txt"), "utf8"), "still here");
  assert.deepEqual(await readdir(join(store.rootPath, "entries")), []);
  const listing = await store.list();
  assert.deepEqual(listing.entries, []);
  assert.deepEqual(listing.damaged, []);
});

test("listing tolerates crashes and corruption without discarding content", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const connectedFolder = join(root, "connected-folder");
  await mkdir(connectedFolder, { recursive: true });
  const entriesDir = join(store.rootPath, "entries");

  // (a) the move landed but the commit never happened
  await writeFile(join(connectedFolder, "landed.txt"), "landed bytes");
  const landed = await store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "landed.txt"), connectedFolderId: "connected-folder-1", originalPath: "landed.txt", receiptId: null,
  });
  await writeManifest(landed.entryPath, { ...(await readManifest(landed.entryPath)), complete: false, sizeBytes: 0 });

  // (b) a manifest whose content never arrived
  const orphanId = "trash-20260101000000-0badc0de";
  await mkdir(join(entriesDir, orphanId, "payload"), { recursive: true });
  await writeManifest(join(entriesDir, orphanId), { ...(await readManifest(landed.entryPath)), id: orphanId, complete: false, sizeBytes: 0 });

  // (c) garbage JSON
  const garbageId = "trash-20260101000001-0badc0de";
  await mkdir(join(entriesDir, garbageId, "payload"), { recursive: true });
  await writeFile(join(entriesDir, garbageId, "payload", "x.txt"), "x");
  await writeManifest(join(entriesDir, garbageId), "{ definitely not json");

  // a manifest with an unknown field, and one whose id does not match its directory
  const strangeId = "trash-20260101000002-0badc0de";
  await mkdir(join(entriesDir, strangeId, "payload"), { recursive: true });
  await writeFile(join(entriesDir, strangeId, "payload", "landed.txt"), "x");
  await writeManifest(join(entriesDir, strangeId), { ...(await readManifest(landed.entryPath)), id: strangeId, extra: true });
  const mismatchId = "trash-20260101000003-0badc0de";
  await mkdir(join(entriesDir, mismatchId, "payload"), { recursive: true });
  await writeFile(join(entriesDir, mismatchId, "payload", "landed.txt"), "x");
  await writeManifest(join(entriesDir, mismatchId), { ...(await readManifest(landed.entryPath)), id: landed.id });

  // (d) incoming debris, pure debris, and a payload with no manifest
  await mkdir(join(store.rootPath, "incoming", "stale-copy"), { recursive: true });
  await writeFile(join(store.rootPath, "incoming", "stale-copy", "part.bin"), "partial");
  const debrisId = "trash-20260101000004-0badc0de";
  await mkdir(join(entriesDir, debrisId), { recursive: true });
  await writeFile(join(entriesDir, "stray-file"), "junk");
  const manifestlessId = "trash-20260101000005-0badc0de";
  await mkdir(join(entriesDir, manifestlessId, "payload"), { recursive: true });
  await writeFile(join(entriesDir, manifestlessId, "payload", "precious.txt"), "precious");
  await mkdir(join(entriesDir, "not-an-id", "payload"), { recursive: true });
  await writeFile(join(entriesDir, "not-an-id", "payload", "also.txt"), "also");

  const reopened = await openStore(root);
  assert.equal(existsSync(join(store.rootPath, "incoming", "stale-copy")), false);
  assert.equal(existsSync(join(entriesDir, debrisId)), false);
  assert.equal(existsSync(join(entriesDir, "stray-file")), false);
  assert.ok(existsSync(join(entriesDir, manifestlessId, "payload", "precious.txt")));
  assert.ok(existsSync(join(entriesDir, garbageId, "payload", "x.txt")));

  const listing = await reopened.list();
  assert.deepEqual(listing.entries.map((entry) => entry.id), [landed.id]);
  assert.equal(listing.entries[0]!.complete, true);
  assert.equal(listing.entries[0]!.sizeBytes, "landed bytes".length);
  assert.equal((await readManifest(landed.entryPath)).complete, true, "the missed commit was repaired on disk");
  const damaged = new Map(listing.damaged.map((record) => [record.id, record.error]));
  assert.deepEqual([...damaged.keys()].sort(), [garbageId, manifestlessId, mismatchId, "not-an-id", orphanId, strangeId].sort());
  assert.match(damaged.get(orphanId)!, /never arrived/);
  assert.match(damaged.get(garbageId)!, /not a valid record/);
  assert.match(damaged.get(strangeId)!, /unknown field extra/);
  assert.match(damaged.get(mismatchId)!, /names .* instead of/);
  assert.match(damaged.get(manifestlessId)!, /manifest\.json is missing/);
  await rejectsRecentlyDeletedError(reopened.get(garbageId), "STORE_DAMAGED");
  assert.equal(await reopened.get("trash-20991231235959-ffffffff"), null);
});

test("restoreTree puts a tree back, collision-renames, and removes the entry", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const connectedFolder = join(root, "connected-folder");
  await mkdir(join(connectedFolder, "docs"), { recursive: true });
  await writeFile(join(connectedFolder, "docs", "report.txt"), "v1");
  const file = await store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "docs", "report.txt"), connectedFolderId: "connected-folder-1", originalPath: "docs/report.txt", receiptId: null,
  });

  // The original path is free again: restored in place, parent recreated when needed.
  await rm(join(connectedFolder, "docs"), { recursive: true, force: true });
  const back = await store.restoreTree(file.id, { absolutePath: join(connectedFolder, "docs", "report.txt") });
  assert.deepEqual(back, { restoredPath: join(connectedFolder, "docs", "report.txt"), renamed: false });
  assert.equal(await readFile(join(connectedFolder, "docs", "report.txt"), "utf8"), "v1");
  assert.equal(existsSync(file.entryPath), false);
  assert.deepEqual((await store.list()).entries, []);
  await rejectsRecentlyDeletedError(store.restoreTree(file.id, { absolutePath: join(connectedFolder, "docs", "report.txt") }), "NOT_FOUND", /Nothing in Recently deleted/);

  // An occupied file path renames like connected-folder.ts: `stem (2).ext`.
  await writeFile(join(connectedFolder, "docs", "notes.md"), "older");
  const notes = await store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "docs", "notes.md"), connectedFolderId: "connected-folder-1", originalPath: "docs/notes.md", receiptId: null,
  });
  await writeFile(join(connectedFolder, "docs", "notes.md"), "newer");
  await writeFile(join(connectedFolder, "docs", "notes (2).md"), "also taken");
  const renamedFile = await store.restoreTree(notes.id, { absolutePath: join(connectedFolder, "docs", "notes.md") });
  assert.deepEqual(renamedFile, { restoredPath: join(connectedFolder, "docs", "notes (3).md"), renamed: true });
  assert.equal(await readFile(join(connectedFolder, "docs", "notes (3).md"), "utf8"), "older");
  assert.equal(await readFile(join(connectedFolder, "docs", "notes.md"), "utf8"), "newer");

  // An occupied folder path renames `name-2`.
  await mkdir(join(connectedFolder, "drafts"));
  await writeFile(join(connectedFolder, "drafts", "one.txt"), "one");
  const drafts = await store.moveTreeToRecentlyDeleted({
    kind: "folder", reason: "files.delete", sourcePath: join(connectedFolder, "drafts"), connectedFolderId: "connected-folder-1", originalPath: "drafts", receiptId: null,
  });
  await mkdir(join(connectedFolder, "drafts"));
  const renamedFolder = await store.restoreTree(drafts.id, { absolutePath: join(connectedFolder, "drafts") });
  assert.deepEqual(renamedFolder, { restoredPath: join(connectedFolder, "drafts-2"), renamed: true });
  assert.equal(await readFile(join(connectedFolder, "drafts-2", "one.txt"), "utf8"), "one");

  // App data an older build kept cannot be restored as a tree; relative destinations are refused before anything moves.
  await plantOldAppEntry(root, "trash-20261101000000-0000a0d0", "app-storage");
  await rejectsRecentlyDeletedError(store.restoreTree("trash-20261101000000-0000a0d0", { absolutePath: join(connectedFolder, "app.json") }), "INPUT_INVALID", /Connected Folder app/);
  await rejectsRecentlyDeletedError(store.restoreTree("trash-20261101000000-0000a0d0", { absolutePath: "relative/path" }), "INPUT_INVALID", /absolute path/);
});

test("a failing restore leaves the entry intact", async (t) => {
  const root = await sandbox(t);
  const connectedFolder = join(root, "connected-folder");
  await mkdir(connectedFolder, { recursive: true });
  await writeFile(join(connectedFolder, "keep.txt"), "kept");
  let failRestores = false;
  const store = await openStore(root, {
    io: {
      async rename(from, to) {
        if (failRestores) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        await rename(from, to);
      },
    },
  });
  const entry = await store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "keep.txt"), connectedFolderId: "connected-folder-1", originalPath: "keep.txt", receiptId: null,
  });
  failRestores = true;
  const error = await rejectsRecentlyDeletedError(store.restoreTree(entry.id, { absolutePath: join(connectedFolder, "keep.txt") }), "MOVE_FAILED", /still in Recently deleted/);
  assert.equal(error.entryId, entry.id);
  assert.equal(existsSync(join(connectedFolder, "keep.txt")), false);
  assert.equal(await readFile(entry.payloadPath, "utf8"), "kept");
  assert.deepEqual((await store.list()).entries.map((item) => item.id), [entry.id]);
  failRestores = false;
  await store.restoreTree(entry.id, { absolutePath: join(connectedFolder, "keep.txt") });
  assert.equal(await readFile(join(connectedFolder, "keep.txt"), "utf8"), "kept");
});

test("entries older builds kept for Connected Folder apps still list, expire, and delete now, but never restore", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root, { now: () => new Date("2026-11-08T00:00:00.000Z") });
  const ids = {
    "app-storage": "trash-20261101000000-0000a001",
    "app-retained": "trash-20261101000000-0000a002",
    "app-release": "trash-20261101000000-0000a003",
    "app-studio": "trash-20261101000000-0000a004",
  } as const;
  const paths: Record<string, string> = {};
  for (const [kind, id] of Object.entries(ids)) {
    paths[kind] = await plantOldAppEntry(root, id, kind as keyof typeof ids, kind === "app-retained" ? "2026-11-02T00:00:00.000Z" : "2099-01-01T00:00:00.000Z");
  }

  const listing = await store.list();
  assert.deepEqual(listing.damaged, [], "an old app entry never reads as damaged");
  assert.deepEqual(listing.entries.map((entry) => entry.kind).sort(), ["app-release", "app-retained", "app-storage", "app-studio"]);
  const studio = listing.entries.find((entry) => entry.kind === "app-studio")!;
  assert.equal(studio.payloadPath, join(paths["app-studio"]!, "payload", "app-studio"));
  for (const id of Object.values(ids)) {
    await rejectsRecentlyDeletedError(store.restoreTree(id, { absolutePath: join(root, "anywhere") }), "INPUT_INVALID", /cannot be restored/);
  }
  assert.equal(existsSync(join(paths["app-storage"]!, "payload", "app-data.json")), true, "a refused restore keeps the files");

  // Delete now still works, and retention still removes what expired.
  assert.deepEqual(await store.remove(ids["app-release"]), { removed: true });
  const purged = await store.purgeExpired(new Date("2026-11-08T00:00:00.000Z"));
  assert.deepEqual(purged.purged, [ids["app-retained"]]);
  assert.deepEqual((await store.list()).entries.map((entry) => entry.id).sort(), [ids["app-storage"], ids["app-studio"]]);
});

test("retention purge erases only expired entries, keeps held entries, and runs once per interval", async (t) => {
  const root = await sandbox(t);
  let clock = new Date("2026-09-10T00:00:00.000Z");
  const store = await openStore(root, { now: () => clock });
  const connectedFolder = join(root, "connected-folder");
  await mkdir(join(connectedFolder, "kept"), { recursive: true });
  await writeFile(join(connectedFolder, "kept", "work.txt"), "work");
  await writeFile(join(connectedFolder, "old.txt"), "old");
  await writeFile(join(connectedFolder, "new.txt"), "new");

  const kept = await store.moveTreeToRecentlyDeleted({ kind: "folder", reason: "files.delete", sourcePath: join(connectedFolder, "kept"), connectedFolderId: "connected-folder-1", originalPath: "kept", receiptId: null });
  const old = await store.moveTreeToRecentlyDeleted({ kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "old.txt"), connectedFolderId: "connected-folder-1", originalPath: "old.txt", receiptId: null });
  clock = new Date(clock.getTime() + 10 * DAY_MS);
  const fresh = await store.moveTreeToRecentlyDeleted({ kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "new.txt"), connectedFolderId: "connected-folder-1", originalPath: "new.txt", receiptId: null });
  // An earlier walk could not list everything in this tree and held it.
  const heldAt = clock.toISOString();
  await writeManifest(kept.entryPath, { ...await readManifest(kept.entryPath), held: { reason: "unreadable", noticedAt: heldAt } });

  clock = new Date(Date.parse(old.restoreBy) + 1000);
  const first = await store.purgeExpiredIfDue();
  assert.ok(first);
  assert.deepEqual(first, { purged: [old.id], held: [kept.id], failed: [] });
  assert.equal(existsSync(old.entryPath), false);
  assert.ok(existsSync(join(kept.payloadPath, "work.txt")));
  assert.ok(existsSync(fresh.entryPath));
  assert.equal(store.lastPurgeAt(), clock.toISOString());
  assert.deepEqual((await readManifest(kept.entryPath)).held, { reason: "unreadable", noticedAt: heldAt });

  const heldError = await rejectsRecentlyDeletedError(store.remove(kept.id), "HELD", /could not look through everything/);
  assert.equal(heldError.entryId, kept.id);
  assert.ok(existsSync(join(kept.payloadPath, "work.txt")));

  // Not due again until a day has passed, even across a reopen.
  clock = new Date(clock.getTime() + 60 * 60 * 1000);
  assert.equal(await store.purgeExpiredIfDue(), null);
  const reopened = await openStore(root, { now: () => clock });
  assert.equal(await reopened.purgeExpiredIfDue(), null);
  clock = new Date(Date.parse(fresh.restoreBy) + DAY_MS);
  const second = await reopened.purgeExpiredIfDue();
  assert.deepEqual(second, { purged: [fresh.id], held: [kept.id], failed: [] });
  assert.deepEqual((await reopened.list()).entries.map((item) => item.id), [kept.id]);

  await writeFile(join(connectedFolder, "plain.txt"), "plain");
  const plain = await reopened.moveTreeToRecentlyDeleted({ kind: "file", reason: "files.delete", sourcePath: join(connectedFolder, "plain.txt"), connectedFolderId: "connected-folder-1", originalPath: "plain.txt", receiptId: null });
  assert.deepEqual(await reopened.remove(plain.id), { removed: true });
  assert.equal(existsSync(plain.entryPath), false);
  assert.deepEqual(await reopened.remove(plain.id), { removed: false });
  await rejectsRecentlyDeletedError(reopened.purgeExpiredIfDue(-1), "INPUT_INVALID");
});

test("a tree the store cannot fully list is held by retention and by Delete now", async (t) => {
  const restrictable = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
  if (!restrictable) {
    t.skip("needs a folder this user cannot list");
    return;
  }
  const root = await sandbox(t);
  let clock = new Date("2026-09-10T00:00:00.000Z");
  const store = await openStore(root, { now: () => clock });
  const connectedFolder = join(root, "connected-folder");
  for (const name of ["expired", "deleted"]) {
    await mkdir(join(connectedFolder, name, "locked"), { recursive: true });
    await writeFile(join(connectedFolder, name, "work.txt"), "work");
  }
  const expired = await store.moveTreeToRecentlyDeleted({ kind: "folder", reason: "files.delete", sourcePath: join(connectedFolder, "expired"), connectedFolderId: "connected-folder-1", originalPath: "expired", receiptId: null });
  const deleted = await store.moveTreeToRecentlyDeleted({ kind: "folder", reason: "files.delete", sourcePath: join(connectedFolder, "deleted"), connectedFolderId: "connected-folder-1", originalPath: "deleted", receiptId: null });
  const locked = [join(expired.payloadPath, "locked"), join(deleted.payloadPath, "locked")];
  try {
    for (const path of locked) await chmod(path, 0o000);

    const heldError = await rejectsRecentlyDeletedError(store.remove(deleted.id), "HELD", /could not look through everything/);
    assert.equal(heldError.entryId, deleted.id);
    assert.equal((await readManifest(deleted.entryPath)).held?.reason, "unreadable");

    clock = new Date(Date.parse(expired.restoreBy) + 1000);
    const purged = await store.purgeExpired();
    assert.deepEqual(purged.purged, []);
    assert.deepEqual([...purged.held].sort(), [expired.id, deleted.id].sort());
    assert.deepEqual((await readManifest(expired.entryPath)).held, { reason: "unreadable", noticedAt: clock.toISOString() });
    assert.ok(existsSync(join(expired.payloadPath, "work.txt")));
    assert.ok(existsSync(join(deleted.payloadPath, "work.txt")));
  } finally {
    for (const path of locked) await chmod(path, 0o700).catch(() => undefined);
  }
});

test("a hold reason this build does not record loads without its hold", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const connectedFolder = join(root, "connected-folder");
  await mkdir(join(connectedFolder, "kept"), { recursive: true });
  await writeFile(join(connectedFolder, "kept", "work.txt"), "work");
  const entry = await store.moveTreeToRecentlyDeleted({ kind: "folder", reason: "files.delete", sourcePath: join(connectedFolder, "kept"), connectedFolderId: "connected-folder-1", originalPath: "kept", receiptId: null });
  // An earlier build could record this reason; it holds nothing now.
  await writeManifest(entry.entryPath, { ...await readManifest(entry.entryPath), held: { reason: "legacy-metadata", noticedAt: entry.deletedAt } });

  const listing = await store.list();
  assert.deepEqual(listing.damaged, []);
  assert.deepEqual(listing.entries.map((item) => item.id), [entry.id]);
  assert.equal(listing.entries[0]!.held, undefined);
  assert.deepEqual(await store.remove(entry.id), { removed: true });
  assert.equal(existsSync(entry.entryPath), false);
});

test("a Connected Folder's folder travels with its History state and both come back", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const managed = join(root, "managed");
  const claim = join(managed, ".space-removal-1234");
  await mkdir(join(claim, ".amplefile"), { recursive: true });
  await writeFile(join(claim, ".amplefile", "connected-folder.json"), JSON.stringify({ version: 1, id: "connected-folder_abc", name: "Fold Connected Folder" }));
  await writeFile(join(claim, "notes.txt"), "notes");
  const stateDir = join(root, "state", "connected-folders", "fold-space-abc");
  await mkdir(join(stateDir, "history"), { recursive: true });
  await writeFile(join(stateDir, "history", "cp-1.json"), "{}");

  const entry = await store.moveTreeToRecentlyDeleted({
    kind: "connected-folder",
    reason: "connected-folders.delete",
    sourcePath: claim,
    connectedFolderId: "connected-folder_abc",
    connectedFolderName: "Fold Connected Folder",
    originalPath: join(managed, "Fold Connected Folder"),
    receiptId: "act_request_9",
    stateDirPath: stateDir,
  });
  assert.equal(entry.kind, "connected-folder");
  assert.equal(entry.stateDir, true);
  assert.equal(entry.payloadPath, join(entry.entryPath, "payload", "Fold Connected Folder"));
  assert.equal(existsSync(claim), false);
  assert.equal(existsSync(stateDir), false);
  assert.equal(await readFile(join(entry.entryPath, "state", "history", "cp-1.json"), "utf8"), "{}");
  assert.equal(await readFile(join(entry.payloadPath, ".amplefile", "connected-folder.json"), "utf8"), JSON.stringify({ version: 1, id: "connected-folder_abc", name: "Fold Connected Folder" }));

  // The state destination is required for a Connected Folder entry that carries state, and must be free.
  await rejectsRecentlyDeletedError(store.restoreTree(entry.id, { absolutePath: join(managed, "Fold Connected Folder") }), "INPUT_INVALID", /History state/);
  await mkdir(stateDir, { recursive: true });
  await rejectsRecentlyDeletedError(store.restoreTree(entry.id, { absolutePath: join(managed, "Fold Connected Folder"), stateDirPath: stateDir }), "MOVE_FAILED", /already exists/);
  await rm(stateDir, { recursive: true, force: true });
  assert.ok(existsSync(entry.payloadPath));

  const seen: string[] = [];
  const restored = await store.restoreTree(entry.id, {
    absolutePath: join(managed, "Fold Connected Folder"),
    stateDirFor: (finalPath) => {
      seen.push(finalPath);
      return join(root, "state", "connected-folders", `restored-${finalPath.endsWith("Fold Connected Folder") ? "same" : "renamed"}`);
    },
  });
  assert.deepEqual(seen, [join(managed, "Fold Connected Folder")]);
  assert.deepEqual(restored, {
    restoredPath: join(managed, "Fold Connected Folder"),
    renamed: false,
    stateDirMovedTo: join(root, "state", "connected-folders", "restored-same"),
  });
  assert.equal(await readFile(join(managed, "Fold Connected Folder", "notes.txt"), "utf8"), "notes");
  assert.equal(await readFile(join(root, "state", "connected-folders", "restored-same", "history", "cp-1.json"), "utf8"), "{}");
  assert.equal(existsSync(entry.entryPath), false);

  // A missing state dir at trash time is fine: the entry simply carries none, and stateDirPath moves plainly.
  const claim2 = join(managed, ".space-removal-5678");
  await mkdir(claim2, { recursive: true });
  const plain = await store.moveTreeToRecentlyDeleted({
    kind: "connected-folder", reason: "connected-folders.delete", sourcePath: claim2, connectedFolderId: "connected-folder_def", originalPath: join(managed, "Other"), receiptId: null, stateDirPath: join(root, "state", "connected-folders", "missing"),
  });
  assert.equal(plain.stateDir, undefined);
  await mkdir(join(managed, "Other"));
  const back = await store.restoreTree(plain.id, { absolutePath: join(managed, "Other"), stateDirPath: join(root, "state", "connected-folders", "unused") });
  assert.deepEqual(back, { restoredPath: join(managed, "Other-2"), renamed: true });
  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "folder", reason: "files.delete", sourcePath: join(managed, "Other-2"), connectedFolderId: "connected-folder_def", originalPath: "Other-2", receiptId: null, stateDirPath: stateDir,
  }), "INPUT_INVALID", /Only a Connected Folder/);
});

for (const complete of [false, true]) {
  test(`Connected Folder History survives a missed state marker in ${complete ? "a previously repaired" : "an incomplete"} manifest`, async (t) => {
    const root = await sandbox(t);
    const store = await openStore(root);
    const source = join(root, "managed", "connected-folder");
    const stateDir = join(root, "state", "connected-folder");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "note.txt"), "current bytes");
    await mkdir(join(stateDir, "history"), { recursive: true });
    await writeFile(join(stateDir, "history", "checkpoint.json"), "recoverable prior bytes");
    const entry = await store.moveTreeToRecentlyDeleted({
      kind: "connected-folder", reason: "connected-folders.delete", sourcePath: source, connectedFolderId: "connected-folder-history-recovery",
      originalPath: source, receiptId: null, stateDirPath: stateDir,
    });
    const { stateDir: _stateDir, ...saved } = await readManifest(entry.entryPath);
    // A crash or failed final write leaves the initial manifest; older
    // readers could also have repaired complete without recovering stateDir.
    await writeManifest(entry.entryPath, { ...saved, complete });

    const reopened = await openStore(root);
    const recovered = (await reopened.list()).entries[0]!;
    assert.equal(recovered.complete, true);
    assert.equal(recovered.stateDir, true);
    assert.equal((await readManifest(entry.entryPath)).stateDir, true, "repair persists the discovered History identity");
    await rejectsRecentlyDeletedError(reopened.restoreTree(entry.id, { absolutePath: source }), "INPUT_INVALID", /History state/);
    const restored = await reopened.restoreTree(entry.id, { absolutePath: source, stateDirPath: stateDir });
    assert.equal(restored.stateDirMovedTo, stateDir);
    assert.equal(await readFile(join(source, "note.txt"), "utf8"), "current bytes");
    assert.equal(await readFile(join(stateDir, "history", "checkpoint.json"), "utf8"), "recoverable prior bytes");
    assert.equal(existsSync(entry.entryPath), false);
  });
}

test("a failed final manifest write still leaves carried History discoverable and restorable", async (t) => {
  if (process.platform === "win32") { t.skip("directory write permissions require POSIX"); return; }
  const root = await sandbox(t);
  const source = join(root, "managed", "connected-folder");
  const stateDir = join(root, "state", "connected-folder");
  let blockedEntry: string | null = null;
  t.after(async () => { if (blockedEntry) await chmod(blockedEntry, 0o700).catch(() => undefined); });
  await mkdir(source, { recursive: true });
  await mkdir(join(stateDir, "history"), { recursive: true });
  await writeFile(join(stateDir, "history", "checkpoint.json"), "prior bytes");
  const store = await openStore(root, { io: { async rename(from, to) {
    await rename(from, to);
    if (from === stateDir) {
      blockedEntry = dirname(to);
      await chmod(blockedEntry, 0o500);
    }
  } } });
  const entry = await store.moveTreeToRecentlyDeleted({
    kind: "connected-folder", reason: "connected-folders.delete", sourcePath: source, connectedFolderId: "connected-folder-final-write",
    originalPath: source, receiptId: null, stateDirPath: stateDir,
  });
  const saved = await readManifest(entry.entryPath);
  if (saved.complete) { t.skip("filesystem does not enforce directory write permissions"); return; }
  assert.equal(saved.stateDir, undefined, "the initial manifest remains after the final commit fails");
  const reopened = await openStore(root);
  assert.equal((await reopened.get(entry.id))?.stateDir, true, "disk inspection recovers History even while repair writes fail");
  await chmod(entry.entryPath, 0o700);
  await reopened.restoreTree(entry.id, { absolutePath: source, stateDirPath: stateDir });
  assert.equal(await readFile(join(stateDir, "history", "checkpoint.json"), "utf8"), "prior bytes");
});

test("remaining Connected Folder History can join an interrupted deletion without merging competing copies", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const source = join(root, "managed", "connected-folder");
  const stateDir = join(root, "state", "connected-folder");
  await mkdir(source, { recursive: true });
  await mkdir(join(stateDir, "history"), { recursive: true });
  await writeFile(join(stateDir, "history", "checkpoint.json"), "retained History");
  const entry = await store.moveTreeToRecentlyDeleted({
    kind: "connected-folder", reason: "connected-folders.delete", sourcePath: source, connectedFolderId: "connected-folder-state-attach",
    originalPath: source, receiptId: null,
  });
  const attached = await store.attachConnectedFolderState(entry.id, stateDir);
  assert.equal(attached.stateDir, true);
  assert.equal(existsSync(stateDir), false);
  assert.equal((await store.attachConnectedFolderState(entry.id, stateDir)).stateDir, true, "an already moved source is safe to retry");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "competing.txt"), "other state");
  await rejectsRecentlyDeletedError(store.attachConnectedFolderState(entry.id, stateDir), "MOVE_FAILED", /both.*original path/);
  assert.equal(await readFile(join(stateDir, "competing.txt"), "utf8"), "other state");
  assert.equal(await readFile(join(entry.entryPath, "state", "history", "checkpoint.json"), "utf8"), "retained History");
  const restoredState = join(root, "restored-state");
  await store.restoreTree(entry.id, { absolutePath: source, stateDirPath: restoredState });
  assert.equal(await readFile(join(restoredState, "history", "checkpoint.json"), "utf8"), "retained History");
});

test("malformed unrecorded History state stays damaged rather than disappearing on restore or retention", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const source = join(root, "managed", "connected-folder");
  await mkdir(source, { recursive: true });
  const entry = await store.moveTreeToRecentlyDeleted({
    kind: "connected-folder", reason: "connected-folders.delete", sourcePath: source, connectedFolderId: "connected-folder-damaged-state",
    originalPath: source, receiptId: null,
  });
  await writeFile(join(entry.entryPath, "state"), "unexpected state bytes");
  const listing = await store.list();
  assert.deepEqual(listing.entries, []);
  assert.match(listing.damaged[0]?.error ?? "", /carried History state/);
  await rejectsRecentlyDeletedError(store.restoreTree(entry.id, { absolutePath: source }), "STORE_DAMAGED");
  assert.deepEqual((await store.purgeExpired(new Date(Date.parse(entry.restoreBy) + DAY_MS))).purged, []);
  assert.equal(await readFile(join(entry.entryPath, "state"), "utf8"), "unexpected state bytes");
  assert.equal(existsSync(entry.payloadPath), true);
});

test("entry ids are validated before any path is touched", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const bad = ["../x", "trash-20260910120000-abcdef01/../..", "", "trash-2026-abc", "TRASH-20260910120000-ABCDEF01", "trash-20260910120000-abcdef01\n"];
  for (const id of bad) {
    await rejectsRecentlyDeletedError(store.get(id), "INPUT_INVALID", /look like trash-/);
    await rejectsRecentlyDeletedError(store.restoreTree(id, { absolutePath: join(root, "x") }), "INPUT_INVALID");
    await rejectsRecentlyDeletedError(store.attachConnectedFolderState(id, join(root, "state")), "INPUT_INVALID");
    await rejectsRecentlyDeletedError(store.remove(id), "INPUT_INVALID");
  }
  assert.equal(existsSync(join(root, "x")), false);
  assert.deepEqual(await readdir(join(store.rootPath, "entries")), []);
  assert.ok(ampleFileRecentlyDeletedEntryIdPattern.test("trash-20260910120000-abcdef01"));

  // Inputs are validated with the same care: reasons, ids, and paths.
  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.destroy" as never, sourcePath: join(root, "x"), connectedFolderId: "connected-folder-1", originalPath: "x", receiptId: null,
  }), "INPUT_INVALID");
  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: "relative.txt", connectedFolderId: "connected-folder-1", originalPath: "relative.txt", receiptId: null,
  }), "INPUT_INVALID", /absolute path/);
  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(root, "x"), connectedFolderId: " ", originalPath: "x", receiptId: null,
  }), "INPUT_INVALID");
  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(root, "x"), connectedFolderId: "connected-folder-1", originalPath: "..", receiptId: null,
  }), "INPUT_INVALID", /file or folder name/);
  await rejectsRecentlyDeletedError(store.moveTreeToRecentlyDeleted({
    kind: "file", reason: "files.delete", sourcePath: join(root, "x"), connectedFolderId: "connected-folder-1", originalPath: "x", receiptId: null, uncovered: [{ path: "x", reason: "gone" as never }],
  }), "INPUT_INVALID");
});
