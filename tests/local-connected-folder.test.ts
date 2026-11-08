import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { createConnectedFolderCheckpoint, restoreConnectedFolderCheckpoint } from "../src/local/history.js";
import {
  configureAmpleFileStateRoot,
  connectedFolderManifestFile,
  connectedFolderRegistryFile,
  connectedFolderStateDir,
} from "../src/local/state-paths.js";
import {
  beginConnectedFolderRemoval,
  copyPathIntoConnectedFolder,
  createManagedConnectedFolder,
  createConnectedFolderFolder,
  createConnectedFolderTextFile,
  finalizeConnectedFolderRemoval,
  getConnectedFolder,
  listConnectedFolders,
  listPendingConnectedFolderRemovals,
  readConnectedFolderTextFile,
  registerManagedConnectedFolder,
  renameConnectedFolder,
  registerLinkedConnectedFolder,
  resolveConnectedFolderPath,
  scanConnectedFolderTree,
  type ConnectedFolderRegistry,
  writeUploadedFiles,
  writeConnectedFolderTextFile,
} from "../src/local/connected-folder.js";
import { readConnectedFolderIgnoreState, setConnectedFolderIgnoreState } from "../src/local/connected-folder-ignore.js";

let sandbox = "";
let stateRoot = "";
let contentRoot = "";

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "connected-folder-local-test-"));
  stateRoot = join(sandbox, "state");
  contentRoot = join(sandbox, "content");
  configureAmpleFileStateRoot(stateRoot);
});

after(async () => {
  configureAmpleFileStateRoot(undefined);
  await rm(sandbox, { recursive: true, force: true });
});

test("an unreadable registry never becomes an empty Connected Folder list", async () => {
  await mkdir(stateRoot, { recursive: true });
  const file = connectedFolderRegistryFile();
  const previous = await readFile(file).catch(() => null);
  try {
    await writeFile(file, "{ incomplete registry");
    await assert.rejects(listConnectedFolders(), /Connected Folder registry could not be read safely/);
    assert.equal(await readFile(file, "utf8"), "{ incomplete registry", "reading leaves the recoverable file untouched");
  } finally {
    if (previous) await writeFile(file, previous);
    else await rm(file, { force: true });
  }
});

test("managed Connected Folders keep portable identity metadata inside a hidden .amplefile folder", async () => {
  const connectedFolder = await createManagedConnectedFolder("Personal Connected Folder", contentRoot);
  const initialManifest = JSON.parse(await readFile(connectedFolderManifestFile(connectedFolder.connectedFolderRoot), "utf8")) as Record<string, unknown>;
  initialManifest.futurePortableField = { retained: true };
  await writeFile(connectedFolderManifestFile(connectedFolder.connectedFolderRoot), `${JSON.stringify(initialManifest, null, 2)}\n`, "utf8");
  const uploaded = await writeUploadedFiles(connectedFolder.connectedFolderRoot, "", [{
    fileName: "notes.txt",
    relativePath: "Notes/notes.txt",
    data: Buffer.from("hello space\n"),
  }]);

  assert.equal(uploaded[0]?.path, "Notes/notes.txt");
  assert.equal((await readConnectedFolderTextFile(connectedFolder.connectedFolderRoot, "Notes/notes.txt")).text, "hello space\n");
  assert.equal((await scanConnectedFolderTree(connectedFolder.connectedFolderRoot)).entries[0]?.name, "Notes");
  const currentConnectedFolder = (await listConnectedFolders()).find((item) => item.id === connectedFolder.id);
  assert.ok(currentConnectedFolder);
  assert.equal(existsSync(connectedFolderManifestFile(connectedFolder.connectedFolderRoot)), true);
  assert.deepEqual(JSON.parse(await readFile(connectedFolderManifestFile(connectedFolder.connectedFolderRoot), "utf8")), {
    version: 1,
    id: currentConnectedFolder.id,
    name: currentConnectedFolder.name,
    createdAt: currentConnectedFolder.createdAt,
    updatedAt: currentConnectedFolder.updatedAt,
    futurePortableField: { retained: true },
  });
  assert.equal((await listConnectedFolders()).length, 1);
  assert.throws(() => resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, "../outside.txt"), /escapes/);
  for (const reserved of [".amplefile", ".AMPLEFILE", ".work-fold", ".WORK-FOLD", ".pi", ".PI"]) {
    assert.throws(
      () => resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, `ordinary/${reserved}/secret.txt`),
      /reserved/i,
      `${reserved} stays outside ordinary Connected Folder file APIs`,
    );
  }
});

test("linked Google Drive folders keep portable metadata hidden from Files", async () => {
  const linkedRoot = join(sandbox, "Google Drive", "My Drive", "Project");
  await mkdir(linkedRoot, { recursive: true });
  await mkdir(join(linkedRoot, ".pi", "skills"), { recursive: true });
  await writeFile(join(linkedRoot, ".pi", "skills", "private.md"), "hidden capability", "utf8");
  await mkdir(join(linkedRoot, ".work-fold", "conversations"), { recursive: true });
  await writeFile(join(linkedRoot, ".work-fold", "records.json"), "earlier identity", "utf8");
  await writeFile(join(linkedRoot, ".work-fold", "conversations", "old.jsonl"), "earlier chat", "utf8");
  const existingFile = join(linkedRoot, "existing.txt");
  await writeFile(existingFile, "original", "utf8");
  const connectedFolder = await registerLinkedConnectedFolder(linkedRoot);
  assert.equal(connectedFolder.connectedFolderRoot, linkedRoot);
  assert.equal(connectedFolder.location.storage, "linked");
  assert.equal(connectedFolder.location.providerHint, "google-drive");
  assert.equal(await readFile(existingFile, "utf8"), "original");
  assert.equal(existsSync(connectedFolderManifestFile(linkedRoot)), true);
  assert.equal((await scanConnectedFolderTree(linkedRoot)).entries[0]?.path, "existing.txt");
  assert.equal(await readFile(join(linkedRoot, ".work-fold", "records.json"), "utf8"), "earlier identity");
});

test("a moved linked folder preserves its manifest identity when it is relinked", async () => {
  const originalRoot = join(sandbox, "portable-connected-folder-original");
  const movedRoot = join(sandbox, "portable-connected-folder-moved");
  await mkdir(originalRoot, { recursive: true });
  const original = await registerLinkedConnectedFolder(originalRoot);
  await rename(originalRoot, movedRoot);

  const relinked = await registerLinkedConnectedFolder(movedRoot);
  assert.equal(relinked.id, original.id);
  assert.equal(relinked.name, original.name);
  assert.equal(relinked.connectedFolderRoot, movedRoot);
  assert.equal((await listConnectedFolders()).filter((connectedFolder) => connectedFolder.id === original.id).length, 1);

  const duplicateRoot = join(sandbox, "portable-connected-folder-copy");
  await mkdir(join(duplicateRoot, ".amplefile"), { recursive: true });
  await writeFile(connectedFolderManifestFile(duplicateRoot), await readFile(connectedFolderManifestFile(movedRoot), "utf8"), "utf8");
  await assert.rejects(registerLinkedConnectedFolder(duplicateRoot), /identity is already linked to another folder/);
});

test("Connected Folder listing survives when portable metadata can no longer be maintained", async () => {
  const linkedRoot = join(sandbox, "metadata-became-unwritable");
  await mkdir(linkedRoot, { recursive: true });
  const connectedFolder = await registerLinkedConnectedFolder(linkedRoot);
  await rm(join(linkedRoot, ".amplefile"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".amplefile"), "temporarily blocked", "utf8");

  assert.equal((await listConnectedFolders()).some((item) => item.id === connectedFolder.id), true);
});

test("blocked portable metadata does not leave a failed linked registration in the registry", async () => {
  const linkedRoot = join(sandbox, "blocked-registration-metadata");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, ".amplefile"), "blocks the metadata directory", "utf8");

  await assert.rejects(registerLinkedConnectedFolder(linkedRoot));
  assert.equal((await listConnectedFolders()).some((item) => item.connectedFolderRoot === linkedRoot), false);
});

test("failed portable writes do not apply a Connected Folder rename", async () => {
  const linkedRoot = join(sandbox, "blocked-rename-metadata");
  await mkdir(linkedRoot, { recursive: true });
  const connectedFolder = await registerLinkedConnectedFolder(linkedRoot);
  await rm(join(linkedRoot, ".amplefile"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".amplefile"), "blocks the metadata directory", "utf8");

  await assert.rejects(renameConnectedFolder(connectedFolder.id, "Failed rename"));
  const current = (await listConnectedFolders()).find((item) => item.id === connectedFolder.id);
  assert.equal(current?.name, connectedFolder.name);
  assert.equal(current?.updatedAt, connectedFolder.updatedAt);
});

test("failed portable writes do not rebind a moved Connected Folder identity", async () => {
  const originalRoot = join(sandbox, "blocked-rebind-original");
  const movedRoot = join(sandbox, "blocked-rebind-moved");
  await mkdir(originalRoot, { recursive: true });
  const connectedFolder = await registerLinkedConnectedFolder(originalRoot);
  const portableManifest = await readFile(connectedFolderManifestFile(originalRoot), "utf8");
  await rename(originalRoot, movedRoot);
  await rm(join(movedRoot, ".amplefile"), { recursive: true, force: true });
  await writeFile(join(movedRoot, ".amplefile"), "blocks the metadata directory", "utf8");

  await assert.rejects(registerLinkedConnectedFolder(movedRoot));
  await rm(join(movedRoot, ".amplefile"), { force: true });
  await mkdir(join(movedRoot, ".amplefile"), { recursive: true });
  await writeFile(connectedFolderManifestFile(movedRoot), portableManifest, "utf8");
  await rename(movedRoot, originalRoot);
  const current = (await listConnectedFolders()).find((item) => item.id === connectedFolder.id);
  assert.equal(current?.connectedFolderRoot, originalRoot);
});

test("a content edit succeeds when post-mutation portable metadata maintenance is blocked", async () => {
  const linkedRoot = join(sandbox, "blocked-touch-metadata");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, "draft.txt"), "before", "utf8");
  const connectedFolder = await registerLinkedConnectedFolder(linkedRoot);
  await rm(join(linkedRoot, ".amplefile"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".amplefile"), "blocks the metadata directory", "utf8");

  await writeConnectedFolderTextFile(linkedRoot, "draft.txt", "after");
  assert.equal(await readFile(join(linkedRoot, "draft.txt"), "utf8"), "after");
  const current = (await listConnectedFolders()).find((item) => item.id === connectedFolder.id);
  assert.equal(current?.updatedAt, connectedFolder.updatedAt);
});

test("linked folders cannot overlap Connected Folder application state", async () => {
  await mkdir(stateRoot, { recursive: true });
  await assert.rejects(registerLinkedConnectedFolder(stateRoot), /cannot contain, or be contained by/);
  await assert.rejects(registerLinkedConnectedFolder(sandbox), /cannot contain, or be contained by/);
  await assert.rejects(createConnectedFolderCheckpoint(sandbox), /does not contain AmpleFile application data/);
});

test("managed Connected Folder removal refuses a mismatched managed-content boundary", async () => {
  const connectedFolder = await createManagedConnectedFolder("Removal guard", contentRoot);
  await assert.rejects(beginConnectedFolderRemoval(connectedFolder.id, join(sandbox, "different-managed-root")), /only delete a managed Connected Folder/);
  assert.equal(existsSync(connectedFolder.connectedFolderRoot), true);
});

test("a removal-intent persistence failure leaves the Connected Folder and managed folder untouched", async () => {
  const connectedFolder = await createManagedConnectedFolder("Removal intent failure", contentRoot);
  await writeFile(join(connectedFolder.connectedFolderRoot, "keep.txt"), "keep", "utf8");

  await assert.rejects(beginConnectedFolderRemoval(connectedFolder.id, contentRoot, {
    async persistRegistry() {
      throw new Error("simulated registry write failure");
    },
  }), /simulated registry write failure/);

  assert.equal((await listConnectedFolders()).some((item) => item.id === connectedFolder.id), true);
  assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "keep.txt"), "utf8"), "keep");
  assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
});

test("managed-folder cleanup failure leaves a hidden, recoverable removal intent", async () => {
  const connectedFolder = await createManagedConnectedFolder("Removal cleanup retry", contentRoot);
  await writeFile(join(connectedFolder.connectedFolderRoot, "retry.txt"), "retry", "utf8");
  await beginConnectedFolderRemoval(connectedFolder.id, contentRoot);

  const pending = await finalizeConnectedFolderRemoval(connectedFolder.id, {
    async claimManagedRoot() {
      throw new Error("simulated managed-folder lock");
    },
  });
  assert.deepEqual(pending, {
    removed: true,
    deleted: false,
    connectedFolderRoot: connectedFolder.connectedFolderRoot,
    cleanupPending: true,
  });
  assert.equal((await listConnectedFolders()).some((item) => item.id === connectedFolder.id), false);
  assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "retry.txt"), "utf8"), "retry");
  assert.equal((await listPendingConnectedFolderRemovals())[0]?.phase, "requested");

  const recovered = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
  assert.equal(existsSync(connectedFolder.connectedFolderRoot), false);
  assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
});

test("a preserve-disposition removal unregisters a managed Connected Folder while its folder provably survives", async () => {
  const connectedFolder = await createManagedConnectedFolder("Managed keep-folder", contentRoot);
  await writeFile(join(connectedFolder.connectedFolderRoot, "keep.md"), "still here", "utf8");

  const intent = await beginConnectedFolderRemoval(connectedFolder.id, contentRoot, {}, { folderDisposition: "preserve" });
  assert.equal(intent.folderDisposition, "preserve");
  assert.equal(intent.storage, "managed");
  assert.equal(intent.managedBase, null, "a preserve intent records no managed-content boundary");
  assert.equal(intent.managedRootIdentity, null, "a preserve intent holds no deletion identity");

  // The durable intent round-trips the strict registry read, and an
  // in-flight preserve intent cannot be converted into a deletion.
  assert.equal((await listPendingConnectedFolderRemovals())[0]?.folderDisposition, "preserve");
  await assert.rejects(beginConnectedFolderRemoval(connectedFolder.id, contentRoot), /different folder disposition/);

  // A crash between app-state cleanup and registry finalization keeps the
  // preserve semantics: the pending result never claims a deletion.
  const pending = await finalizeConnectedFolderRemoval(connectedFolder.id, {
    async removeConnectedFolderState() {
      throw new Error("simulated app-state lock");
    },
  });
  assert.deepEqual(pending, {
    removed: true,
    deleted: false,
    connectedFolderRoot: connectedFolder.connectedFolderRoot,
    cleanupPending: true,
  });

  const removed = await finalizeConnectedFolderRemoval(connectedFolder.id, {
    async claimManagedRoot() {
      throw new Error("a preserve removal must never claim the managed root");
    },
    async removeClaimedManagedRoot() {
      throw new Error("a preserve removal must never delete the managed root");
    },
  });
  assert.deepEqual(removed, {
    removed: true,
    deleted: false,
    connectedFolderRoot: connectedFolder.connectedFolderRoot,
    cleanupPending: false,
  });
  assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "keep.md"), "utf8"), "still here");
  assert.equal(existsSync(connectedFolderManifestFile(connectedFolder.connectedFolderRoot)), true, "the portable identity persists");
  assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
  assert.equal((await listConnectedFolders()).some((item) => item.id === connectedFolder.id), false);

  // The preserved folder registers again with the same portable identity.
  const reRegistered = await registerLinkedConnectedFolder(connectedFolder.connectedFolderRoot);
  assert.equal(reRegistered.id, connectedFolder.id, "re-registration restores the persisted identity");
});

test("a managed folder registers again with its portable identity, and only inside the managed base", async () => {
  // How a Connected Folder's folder comes back from Recently deleted
  // (docs/act-ledger.md): the folder is already in the managed
  // base, and its `.amplefile/connected-folder.json` identity is what makes it the same
  // Connected Folder rather than a copy.
  const connectedFolder = await createManagedConnectedFolder("Restorable", contentRoot);
  await writeFile(join(connectedFolder.connectedFolderRoot, "brief.md"), "# brief\n", "utf8");
  await beginConnectedFolderRemoval(connectedFolder.id, contentRoot, {});
  // The removal moves the claimed folder away instead of erasing it, exactly
  // as the trash io does; putting it back is what a restore then does.
  const parked = join(dirname(connectedFolder.connectedFolderRoot), "parked-managed-folder");
  await finalizeConnectedFolderRemoval(connectedFolder.id, {
    removeClaimedManagedRoot: async (claimPath) => { await rename(claimPath, parked); },
  });
  assert.equal((await listConnectedFolders()).some((item) => item.id === connectedFolder.id), false);
  assert.equal(existsSync(connectedFolder.connectedFolderRoot), false);

  await rename(parked, connectedFolder.connectedFolderRoot);
  const restored = await registerManagedConnectedFolder(connectedFolder.connectedFolderRoot, "Restorable", contentRoot);
  assert.equal(restored.id, connectedFolder.id, "the portable identity comes back with the folder");
  assert.equal(restored.location.storage, "managed");
  assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "brief.md"), "utf8"), "# brief\n");

  // Nothing outside the managed base is a managed Connected Folder, and a missing
  // folder is refused rather than created.
  const outside = join(dirname(contentRoot), "outside-managed-base");
  await mkdir(outside, { recursive: true });
  await assert.rejects(
    () => registerManagedConnectedFolder(outside, "Outside", contentRoot),
    /inside its managed-content folder/,
  );
  await assert.rejects(
    () => registerManagedConnectedFolder(join(contentRoot, "never-existed"), "Ghost", contentRoot),
    /does not exist/,
  );
  await assert.rejects(
    () => registerManagedConnectedFolder(contentRoot, "The base itself", contentRoot),
    /inside its managed-content folder/,
  );
});

test("a preserve marker is valid only on a managed intent that holds no deletion authority", async () => {
  const connectedFolder = await createManagedConnectedFolder("Preserve marker rules", contentRoot);
  await beginConnectedFolderRemoval(connectedFolder.id, contentRoot, {}, { folderDisposition: "preserve" });
  const registryText = await readFile(connectedFolderRegistryFile(), "utf8");
  const poison = (mutate: (intent: Record<string, unknown>) => void) => {
    const registry = JSON.parse(registryText) as { pendingRemovals: Array<Record<string, unknown>> };
    mutate(registry.pendingRemovals[0]!);
    return writeFile(connectedFolderRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  };

  // A preserve intent that somehow gained deletion authority is refused by
  // the strict registry read: the shape itself is the proof.
  await poison((intent) => { intent.managedRootClaimed = true; });
  await assert.rejects(listPendingConnectedFolderRemovals(), /could not be read safely/);

  await poison((intent) => { intent.folderDisposition = "delete"; });
  await assert.rejects(listPendingConnectedFolderRemovals(), /could not be read safely/);

  // Restore the valid preserve intent and complete the removal so later
  // tests see a clean registry.
  await writeFile(connectedFolderRegistryFile(), registryText, "utf8");
  const removed = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.equal(removed.deleted, false);
  assert.equal(existsSync(connectedFolder.connectedFolderRoot), true);
});

test("a durable claim hint cannot finalize while the approved root still exists", async () => {
  const connectedFolder = await createManagedConnectedFolder("Removal claim replay", contentRoot);
  await writeFile(join(connectedFolder.connectedFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginConnectedFolderRemoval(connectedFolder.id, contentRoot);

  const registry = JSON.parse(await readFile(connectedFolderRegistryFile(), "utf8")) as {
    pendingRemovals: Array<{ managedRootClaimed: boolean }>;
  };
  registry.pendingRemovals[0]!.managedRootClaimed = true;
  await writeFile(connectedFolderRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const removed = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.equal(removed.cleanupPending, false);
  assert.equal(removed.deleted, true);
  assert.equal(existsSync(connectedFolder.connectedFolderRoot), false,
    "recovery must reclaim and delete the exact root instead of trusting the progress hint");
  assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
});

test("a final registry-write failure remains idempotently recoverable after managed content is gone", async () => {
  const connectedFolder = await createManagedConnectedFolder("Removal registry retry", contentRoot);
  await beginConnectedFolderRemoval(connectedFolder.id, contentRoot);

  const pending = await finalizeConnectedFolderRemoval(connectedFolder.id, {
    async persistRegistry(registry) {
      if (registry.pendingRemovals.length === 0) {
        throw new Error("simulated final registry write failure");
      }
      await persistConnectedFolderRegistryForTest(registry);
    },
  });
  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.deleted, true);
  assert.equal(existsSync(connectedFolder.connectedFolderRoot), false);
  assert.equal((await listConnectedFolders()).some((item) => item.id === connectedFolder.id), false);
  assert.equal((await listPendingConnectedFolderRemovals())[0]?.connectedFolderId, connectedFolder.id);

  await mkdir(connectedFolder.connectedFolderRoot, { recursive: true });
  const replacementSentinel = join(connectedFolder.connectedFolderRoot, "unrelated-replacement.txt");
  await writeFile(replacementSentinel, "do not delete", "utf8");
  const recovered = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.deepEqual(recovered, {
    removed: true,
    deleted: true,
    connectedFolderRoot: connectedFolder.connectedFolderRoot,
    cleanupPending: false,
  });
  assert.equal(await readFile(replacementSentinel, "utf8"), "do not delete");
  assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
});

test("an unclaimed replacement folder or junction keeps managed removal pending", async () => {
  const connectedFolder = await createManagedConnectedFolder("Removal replacement guard", contentRoot);
  await writeFile(join(connectedFolder.connectedFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginConnectedFolderRemoval(connectedFolder.id, contentRoot);

  const originalAside = join(contentRoot, "approved-original-aside");
  await rename(connectedFolder.connectedFolderRoot, originalAside);
  await mkdir(connectedFolder.connectedFolderRoot, { recursive: false });
  const replacementSentinel = join(connectedFolder.connectedFolderRoot, "unrelated-replacement.txt");
  await writeFile(replacementSentinel, "do not delete", "utf8");

  const refusedReplacement = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.equal(refusedReplacement.cleanupPending, true);
  assert.equal(refusedReplacement.deleted, false);
  assert.equal(await readFile(replacementSentinel, "utf8"), "do not delete");
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");

  await rm(connectedFolder.connectedFolderRoot, { recursive: true, force: true });
  const junctionTarget = join(sandbox, "unrelated-junction-target");
  const junctionSentinel = join(junctionTarget, "outside-managed-root.txt");
  await mkdir(junctionTarget, { recursive: true });
  await writeFile(junctionSentinel, "also do not delete", "utf8");
  await symlink(junctionTarget, connectedFolder.connectedFolderRoot, process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    (await listPendingConnectedFolderRemovals())[0]?.connectedFolderId,
    connectedFolder.id,
    "a later link at the pending path must not make intent parsing inspect live content",
  );
  const refusedJunction = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.equal(refusedJunction.cleanupPending, true);
  assert.equal(refusedJunction.deleted, false);
  assert.equal(await readFile(junctionSentinel, "utf8"), "also do not delete");

  await unlink(connectedFolder.connectedFolderRoot);
  await rm(junctionTarget, { recursive: true, force: true });
  await rename(originalAside, connectedFolder.connectedFolderRoot);
  const recovered = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
  assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
});

test("a root swap during the managed claim never deletes either directory", async () => {
  const connectedFolder = await createManagedConnectedFolder("Removal claim swap", contentRoot);
  await writeFile(join(connectedFolder.connectedFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginConnectedFolderRemoval(connectedFolder.id, contentRoot);

  const originalAside = join(contentRoot, "claim-swap-original-aside");
  let claimedReplacement = "";
  const pending = await finalizeConnectedFolderRemoval(connectedFolder.id, {
    async claimManagedRoot(connectedFolderRoot, claimPath) {
      claimedReplacement = claimPath;
      await rename(connectedFolderRoot, originalAside);
      await mkdir(connectedFolderRoot, { recursive: false });
      await writeFile(join(connectedFolderRoot, "replacement-sentinel.txt"), "replacement", "utf8");
      await rename(connectedFolderRoot, claimPath);
    },
  });

  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.deleted, false);
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");
  assert.equal(existsSync(claimedReplacement), false, "the mismatched claim is restored when the root name is still free");
  assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "replacement-sentinel.txt"), "utf8"), "replacement");
  assert.equal((await listPendingConnectedFolderRemovals())[0]?.managedRootClaimed, false);

  await rm(connectedFolder.connectedFolderRoot, { recursive: true, force: true });
  await rename(originalAside, connectedFolder.connectedFolderRoot);
  const recovered = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
});

test("recovery retries restoration of a mismatched managed claim", async () => {
  const connectedFolder = await createManagedConnectedFolder("Removal claim restore retry", contentRoot);
  await writeFile(join(connectedFolder.connectedFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginConnectedFolderRemoval(connectedFolder.id, contentRoot);

  const originalAside = join(contentRoot, "claim-restore-original-aside");
  let claimPath = "";
  const first = await finalizeConnectedFolderRemoval(connectedFolder.id, {
    async claimManagedRoot(connectedFolderRoot, destination) {
      claimPath = destination;
      await rename(connectedFolderRoot, originalAside);
      await mkdir(connectedFolderRoot, { recursive: false });
      await writeFile(join(connectedFolderRoot, "replacement-sentinel.txt"), "replacement", "utf8");
      await rename(connectedFolderRoot, destination);
    },
    async restoreMismatchedManagedClaim() {
      throw new Error("simulated transient restore failure");
    },
  });
  assert.equal(first.cleanupPending, true);
  assert.equal(await readFile(join(claimPath, "replacement-sentinel.txt"), "utf8"), "replacement");

  const retry = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.equal(retry.cleanupPending, true);
  assert.equal(retry.deleted, false);
  assert.equal(existsSync(claimPath), false);
  assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "replacement-sentinel.txt"), "utf8"), "replacement");
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");

  await rm(connectedFolder.connectedFolderRoot, { recursive: true, force: true });
  await rename(originalAside, connectedFolder.connectedFolderRoot);
  const recovered = await finalizeConnectedFolderRemoval(connectedFolder.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
});

test("a replacement created after the managed claim survives approved-folder deletion", async () => {
  const connectedFolder = await createManagedConnectedFolder("Removal post-claim replacement", contentRoot);
  await writeFile(join(connectedFolder.connectedFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginConnectedFolderRemoval(connectedFolder.id, contentRoot);

  let claimPath = "";
  const replacementSentinel = join(connectedFolder.connectedFolderRoot, "replacement-sentinel.txt");
  const removed = await finalizeConnectedFolderRemoval(connectedFolder.id, {
    async claimManagedRoot(connectedFolderRoot, destination) {
      claimPath = destination;
      await rename(connectedFolderRoot, destination);
      await mkdir(connectedFolderRoot, { recursive: false });
      await writeFile(replacementSentinel, "replacement", "utf8");
      await mkdir(join(connectedFolderRoot, ".amplefile"), { recursive: false });
      await writeFile(join(connectedFolderRoot, ".amplefile", "replacement-metadata.txt"), "replacement metadata", "utf8");
    },
  });

  assert.equal(removed.cleanupPending, false);
  assert.equal(removed.deleted, true);
  assert.equal(existsSync(claimPath), false, "only the identity-verified claim is recursively deleted");
  assert.equal(await readFile(replacementSentinel, "utf8"), "replacement");
  assert.equal(
    await readFile(join(connectedFolder.connectedFolderRoot, ".amplefile", "replacement-metadata.txt"), "utf8"),
    "replacement metadata",
    "external Connected Folder state cleanup must not touch a replacement folder's portable metadata",
  );
  assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
});

async function persistConnectedFolderRegistryForTest(registry: ConnectedFolderRegistry): Promise<void> {
  await writeFile(connectedFolderRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

test("restore points live externally and can restore Connected Folder files", async () => {
  const connectedFolder = await createManagedConnectedFolder("History Target", contentRoot);
  const file = join(connectedFolder.connectedFolderRoot, "draft.txt");
  await writeFile(file, "version one", "utf8");
  const checkpoint = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, { label: "Version one" });
  assert.equal(checkpoint.files.some((entry) => entry.path.startsWith(".amplefile/")), false);
  assert.equal(checkpoint.directories.some((entry) => entry === ".amplefile" || entry.startsWith(".amplefile/")), false);
  await writeFile(file, "version two", "utf8");

  const result = await restoreConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, checkpoint.checkpointId);
  assert.equal(result.restored, true);
  assert.equal(await readFile(file, "utf8"), "version one");
  assert.equal(existsSync(join(connectedFolder.connectedFolderRoot, "history")), false);
});

test("the Connected Folder tree keeps a stable order under batched inspection and survives unreadable entries", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-tree-scan-"));
  t.after(async () => {
    await chmod(join(sandbox, "unreadable"), 0o755).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  // Wide enough to span several inspection batches.
  const names = Array.from({ length: 200 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
  await Promise.all(names.map((name) => writeFile(join(sandbox, name), name, "utf8")));
  await mkdir(join(sandbox, "zeta-folder"), { recursive: true });

  const tree = (await scanConnectedFolderTree(sandbox, 2)).entries;
  assert.deepEqual(
    tree.map((entry) => entry.name),
    ["zeta-folder", ...names],
    "folders sort before files and batching does not disturb the order",
  );

  // A directory that can be listed but not traversed makes stat fail for every
  // child. That must degrade to an empty folder, not break the whole Connected Folder.
  await mkdir(join(sandbox, "unreadable"), { recursive: true });
  await writeFile(join(sandbox, "unreadable", "hidden.txt"), "x", "utf8");
  await chmod(join(sandbox, "unreadable"), 0o444);
  if ((await stat(join(sandbox, "unreadable", "hidden.txt")).catch(() => null)) !== null) {
    t.skip("filesystem does not enforce directory traversal permission");
    return;
  }

  const degraded = (await scanConnectedFolderTree(sandbox, 2)).entries;
  const unreadable = degraded.find((entry) => entry.name === "unreadable");
  assert.equal(unreadable?.kind, "folder");
  assert.deepEqual(unreadable?.children, [], "children that cannot be inspected are skipped");
  assert.equal(degraded.filter((entry) => entry.kind === "file").length, names.length, "the rest of the Connected Folder still lists");
});

test("the Connected Folder tree stops at its entry budget and reports a partial listing", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-tree-budget-"));
  const previous = process.env.AMPLEFILE_TREE_MAX_ENTRIES;
  process.env.AMPLEFILE_TREE_MAX_ENTRIES = "5";
  t.after(async () => {
    if (previous === undefined) delete process.env.AMPLEFILE_TREE_MAX_ENTRIES;
    else process.env.AMPLEFILE_TREE_MAX_ENTRIES = previous;
    await rm(sandbox, { recursive: true, force: true });
  });

  await mkdir(join(sandbox, "nested"), { recursive: true });
  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => writeFile(join(sandbox, `top-${index}.txt`), "x", "utf8")),
    ...Array.from({ length: 8 }, (_, index) => writeFile(join(sandbox, "nested", `deep-${index}.txt`), "x", "utf8")),
  ]);

  const capped = await scanConnectedFolderTree(sandbox, 5);
  assert.equal(capped.truncated, true, "reaching the budget is disclosed rather than silently trimming");
  assert.ok(countTreeEntries(capped.entries) <= 5, `budget must bound total entries, saw ${countTreeEntries(capped.entries)}`);

  // The budget spans the whole walk, not each folder, so a deep Connected Folder cannot
  // multiply it by depth.
  process.env.AMPLEFILE_TREE_MAX_ENTRIES = "1000";
  const whole = await scanConnectedFolderTree(sandbox, 5);
  assert.equal(whole.truncated, false);
  assert.equal(countTreeEntries(whole.entries), 17, "8 top files + nested folder + 8 nested files");
});

test("the Connected Folder tree applies its budget to a stable visible ordering", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-tree-visible-budget-"));
  const previous = process.env.AMPLEFILE_TREE_MAX_ENTRIES;
  process.env.AMPLEFILE_TREE_MAX_ENTRIES = "2";
  t.after(async () => {
    if (previous === undefined) delete process.env.AMPLEFILE_TREE_MAX_ENTRIES;
    else process.env.AMPLEFILE_TREE_MAX_ENTRIES = previous;
    await rm(sandbox, { recursive: true, force: true });
  });

  await Promise.all([
    writeFile(join(sandbox, "zulu.txt"), "z", "utf8"),
    writeFile(join(sandbox, "alpha.txt"), "a", "utf8"),
    writeFile(join(sandbox, "ignored-a.txt"), "i", "utf8"),
    writeFile(join(sandbox, "ignored-b.txt"), "i", "utf8"),
  ]);
  await setConnectedFolderIgnoreState(sandbox, ["ignored-a.txt", "ignored-b.txt"], true);

  const capped = await scanConnectedFolderTree(sandbox, 0, "", { includeIgnored: false });
  assert.deepEqual(capped.entries.map((entry) => entry.name), ["alpha.txt", "zulu.txt"]);
  assert.equal(capped.truncated, false, "ignored entries do not consume the visible entry budget");
});

test("parent file mutations respect nested ownership while allowing siblings and child-owned changes", async () => {
  const parent = await createManagedConnectedFolder("Nested write boundaries", contentRoot);
  const childRoot = join(parent.connectedFolderRoot, "Group", "Child");
  await mkdir(childRoot, { recursive: true });
  await writeFile(join(childRoot, "note.txt"), "child original");
  await registerLinkedConnectedFolder(childRoot);
  const childPath = "Group//./Child";

  await assert.rejects(writeConnectedFolderTextFile(parent.connectedFolderRoot, `${childPath}/note.txt`, "parent overwrite"), /belongs to.*Connected Folder/);
  await assert.rejects(createConnectedFolderTextFile(parent.connectedFolderRoot, childPath, "new.txt", "parent create"), /belongs to.*Connected Folder/);
  await assert.rejects(createConnectedFolderFolder(parent.connectedFolderRoot, childPath, "new-folder"), /belongs to.*Connected Folder/);
  await assert.rejects(writeUploadedFiles(parent.connectedFolderRoot, childPath, [{ fileName: "upload.txt", data: Buffer.from("parent upload") }]), /belongs to.*Connected Folder/);
  await assert.rejects(writeUploadedFiles(parent.connectedFolderRoot, "", [
    { fileName: "first.txt", relativePath: "Preflight/first.txt", data: Buffer.from("first") },
    { fileName: "second.txt", relativePath: "Group/Child/new-directory/second.txt", data: Buffer.from("second") },
  ]), /belongs to.*Connected Folder/);
  assert.equal(existsSync(join(parent.connectedFolderRoot, "Preflight")), false, "a refused batch has no earlier writes or created directories");
  assert.equal(existsSync(join(childRoot, "new-directory")), false);

  const source = join(sandbox, "nested-copy-source", "Child");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "copy.txt"), "copied sibling");
  await assert.rejects(copyPathIntoConnectedFolder(source, parent.connectedFolderRoot, childPath), /belongs to.*Connected Folder/);
  assert.equal(await readFile(join(childRoot, "note.txt"), "utf8"), "child original");
  assert.equal(existsSync(join(childRoot, "new.txt")), false);
  assert.equal(existsSync(join(childRoot, "new-folder")), false);
  assert.equal(existsSync(join(childRoot, "upload.txt")), false);
  assert.equal(existsSync(join(childRoot, "Child")), false);

  await createConnectedFolderFolder(parent.connectedFolderRoot, "Group", "Sibling");
  await createConnectedFolderTextFile(parent.connectedFolderRoot, "Group/Sibling", "note.txt", "parent sibling");
  await writeConnectedFolderTextFile(parent.connectedFolderRoot, "Group/Sibling/note.txt", "updated sibling");
  assert.equal(await readFile(join(parent.connectedFolderRoot, "Group", "Sibling", "note.txt"), "utf8"), "updated sibling");
  assert.deepEqual(await writeUploadedFiles(parent.connectedFolderRoot, "Group", [{ fileName: "Child", data: Buffer.from("collision sibling") }]), [
    { path: "Group/Child (2)", sizeBytes: 17 },
  ], "a colliding nested folder name can become an ordinary sibling file");
  assert.equal(await copyPathIntoConnectedFolder(source, parent.connectedFolderRoot, "Group"), "Group/Child-2");
  assert.equal(await readFile(join(parent.connectedFolderRoot, "Group", "Child-2", "copy.txt"), "utf8"), "copied sibling");

  await writeConnectedFolderTextFile(childRoot, "note.txt", "child update");
  await createConnectedFolderTextFile(childRoot, "", "own.txt", "child create");
  await writeUploadedFiles(childRoot, "", [{ fileName: "own-upload.txt", data: Buffer.from("child upload") }]);
  assert.equal(await readFile(join(childRoot, "note.txt"), "utf8"), "child update");
  assert.equal(await readFile(join(childRoot, "own.txt"), "utf8"), "child create");
  assert.equal(await readFile(join(childRoot, "own-upload.txt"), "utf8"), "child upload");
});

test("a pending managed deletion cannot gain a newly registered nested Connected Folder", async () => {
  const parent = await createManagedConnectedFolder("Pending nested registration", contentRoot);
  const childRoot = join(parent.connectedFolderRoot, "Child");
  await mkdir(childRoot);
  await writeFile(join(childRoot, "note.txt"), "still present");
  await beginConnectedFolderRemoval(parent.id, contentRoot);
  await assert.rejects(registerLinkedConnectedFolder(childRoot), /still being removed/);
  assert.equal(existsSync(connectedFolderManifestFile(childRoot)), false, "the refused registration creates no portable identity");
  assert.equal(await readFile(join(childRoot, "note.txt"), "utf8"), "still present");
  assert.equal((await finalizeConnectedFolderRemoval(parent.id)).cleanupPending, false);
});

function countTreeEntries(entries: Awaited<ReturnType<typeof scanConnectedFolderTree>>["entries"]): number {
  return entries.reduce((total, entry) => total + 1 + countTreeEntries(entry.children ?? []), 0);
}

test("looking up one Connected Folder refreshes only its own manifest and keeps the listing's filters", async () => {
  const looked = await createManagedConnectedFolder("Looked up", contentRoot);
  const other = await createManagedConnectedFolder("Left alone", contentRoot);
  await rm(connectedFolderManifestFile(looked.connectedFolderRoot));
  await rm(connectedFolderManifestFile(other.connectedFolderRoot));

  assert.equal((await getConnectedFolder(looked.id)).id, looked.id);
  assert.equal(existsSync(connectedFolderManifestFile(looked.connectedFolderRoot)), true, "the looked-up Connected Folder's manifest is refreshed");
  assert.equal(existsSync(connectedFolderManifestFile(other.connectedFolderRoot)), false, "a lookup never touches another Connected Folder");

  const moved = `${other.connectedFolderRoot}-moved`;
  await rename(other.connectedFolderRoot, moved);
  try {
    await assert.rejects(getConnectedFolder(other.id), (error: unknown) => (error as { statusCode?: number }).statusCode === 404);
    assert.equal((await listConnectedFolders()).some((item) => item.id === other.id), false);
  } finally {
    await rename(moved, other.connectedFolderRoot);
  }
  assert.equal((await getConnectedFolder(other.id)).id, other.id);
});

test("ignore rule changes in flight each land, and the rules file is replaced whole", async () => {
  const connectedFolder = await createManagedConnectedFolder("Ignore rules", contentRoot);
  const names = Array.from({ length: 8 }, (_, index) => `item-${index}.txt`);
  await Promise.all(names.map((name) => writeFile(join(connectedFolder.connectedFolderRoot, name), name, "utf8")));

  await Promise.all(names.map((name) => setConnectedFolderIgnoreState(connectedFolder.connectedFolderRoot, [name], true)));
  assert.deepEqual((await readConnectedFolderIgnoreState(connectedFolder.connectedFolderRoot)).patterns, [...names].sort());
  const stateFiles = await readdir(connectedFolderStateDir(connectedFolder.connectedFolderRoot));
  assert.equal(stateFiles.some((name) => name.endsWith(".tmp")), false, "no temporary rules file is left behind");

  await setConnectedFolderIgnoreState(connectedFolder.connectedFolderRoot, [names[0]!], false);
  assert.equal((await readConnectedFolderIgnoreState(connectedFolder.connectedFolderRoot)).patterns.includes(names[0]!), false);
});
