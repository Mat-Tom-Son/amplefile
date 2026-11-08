import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { ampleFileStateRoot, configureAmpleFileStateRoot, connectedFolderRegistryFile, connectedFolderStateDir } from "../src/local/state-paths.js";
import { createConnectedFolderCheckpoint, listConnectedFolderCheckpoints } from "../src/local/history.js";
import { AmpleFileRecentlyDeletedStore } from "../src/local/recently-deleted-store.js";
import {
  beginConnectedFolderRemoval,
  createManagedConnectedFolder,
  listPendingConnectedFolderRemovals,
  type ConnectedFolderRegistry,
  type ConnectedFolderRemovalIo,
} from "../src/local/connected-folder.js";

test("a failed removal-intent commit preserves the Connected Folder", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-removal-intent-api-"));
  const stateBase = join(sandbox, "state");
  const connectedFolderBase = join(sandbox, "connected-folders");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    connectedFolderBase,
    loadEnv: false,
    connectedFolderRemovalIo: {
      async persistRegistry() {
        throw new Error("simulated removal-intent persistence failure");
      },
    },
  });
  try {
    const connectedFolder = await createConnectedFolder(api, "Atomic source");
    const response = await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}`, { method: "DELETE" });
    assert.equal(response.status, 500);
    assert.match((await response.json() as { error: string }).error, /simulated removal-intent persistence failure/);

    const bootstrap = await request<{ connectedFolders: Array<{ id: string }> }>(api, "/api/bootstrap");
    assert.equal(bootstrap.connectedFolders.some((item) => item.id === connectedFolder.id), true);
    assert.equal(existsSync(connectedFolder.connectedFolderRoot), true);
    assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("managed-folder deletion failure returns committed removal and startup recovery finishes it", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-removal-folder-api-"));
  const stateBase = join(sandbox, "state");
  const connectedFolderBase = join(sandbox, "connected-folders");
  let blockManagedDelete = true;
  const removalIo: Partial<ConnectedFolderRemovalIo> = {
    async claimManagedRoot(rootPath, claimPath) {
      if (blockManagedDelete) throw new Error("simulated managed-folder lock");
      await rename(rootPath, claimPath);
    },
  };
  let api: LocalApiHandle | null = null;
  try {
      api = await startLocalApi({
      port: 0,
      stateBase,
      connectedFolderBase,
      loadEnv: false,
        connectedFolderRemovalIo: removalIo,
    });
    const connectedFolder = await createConnectedFolder(api, "Locked source");
    await writeFile(join(connectedFolder.connectedFolderRoot, "keep-until-retry.txt"), "pending", "utf8");
    const removal = await request<{
      removed: true;
      deleted: boolean;
      cleanupPending: boolean;
      recentlyDeleted: { entryId: string } | null;
    }>(api, `/api/connected-folders/${connectedFolder.id}`, { method: "DELETE" });
    assert.deepEqual(removal, { removed: true, deleted: false, connectedFolderRoot: connectedFolder.connectedFolderRoot, cleanupPending: true, recentlyDeleted: null });
    assert.equal(existsSync(connectedFolder.connectedFolderRoot), true);
    assert.equal((await request<{ connectedFolders: Array<{ id: string }> }>(api, "/api/bootstrap")).connectedFolders.some((item) => item.id === connectedFolder.id), false);
    assert.equal((await listPendingConnectedFolderRemovals())[0]?.phase, "requested");

    await api.close();
    api = null;
    blockManagedDelete = false;
    api = await startLocalApi({
      port: 0,
      stateBase,
      connectedFolderBase,
      loadEnv: false,
      connectedFolderRemovalIo: removalIo,
    });
    assert.equal(existsSync(connectedFolder.connectedFolderRoot), false);
    assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
    assert.deepEqual((await request<{ connectedFolders: unknown[] }>(api, "/api/bootstrap")).connectedFolders, []);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("startup removal recovery finalizes the intent and leaves state a Checks build left behind unread", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-removal-check-state-api-"));
  const stateBase = join(sandbox, "state");
  const connectedFolderBase = join(sandbox, "connected-folders");
  let api: LocalApiHandle | null = null;
  try {
      api = await startLocalApi({
      port: 0,
      stateBase,
      connectedFolderBase,
      loadEnv: false,
      });
    const connectedFolder = await createConnectedFolder(api, "Leftover Check state");
    const intent = await beginConnectedFolderRemoval(connectedFolder.id, connectedFolderBase);
    assert.equal(intent.phase, "requested");
    // Check state an earlier build left is neither read, required, nor
    // deleted.
    const checkState = join(ampleFileStateRoot(), "checks", "connected-folders", "leftover-0123456789abcdef.json");
    await mkdir(dirname(checkState), { recursive: true });
    await writeFile(checkState, "{damaged current state", "utf8");

    await api.close();
    api = null;
    api = await startLocalApi({
      port: 0,
      stateBase,
      connectedFolderBase,
      loadEnv: false,
    });
    assert.equal(await readFile(checkState, "utf8"), "{damaged current state");
    assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
    assert.equal(existsSync(connectedFolder.connectedFolderRoot), false);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("final registry persistence failure keeps a retryable intent after folder removal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-removal-registry-api-"));
  const stateBase = join(sandbox, "state");
  const connectedFolderBase = join(sandbox, "connected-folders");
  let blockFinalCommit = true;
  const removalIo: Partial<ConnectedFolderRemovalIo> = {
    async persistRegistry(registry) {
      if (blockFinalCommit && registry.pendingRemovals.length === 0) {
        throw new Error("simulated final Connected Folder registry failure");
      }
      await persistRegistryForTest(registry);
    },
  };
  let api: LocalApiHandle | null = null;
  try {
      api = await startLocalApi({
      port: 0,
      stateBase,
      connectedFolderBase,
      loadEnv: false,
        connectedFolderRemovalIo: removalIo,
    });
    const connectedFolder = await createConnectedFolder(api, "Registry source");
    const removal = await request<{
      removed: true;
      deleted: boolean;
      cleanupPending: boolean;
      recentlyDeleted: { entryId: string; restoreBy: string } | null;
    }>(api, `/api/connected-folders/${connectedFolder.id}`, { method: "DELETE" });
    assert.equal(removal.removed, true);
    assert.equal(removal.deleted, true);
    assert.equal(removal.cleanupPending, true);
    assert.equal(existsSync(connectedFolder.connectedFolderRoot), false);
    // The claimed folder was moved, not erased (docs/act-ledger.md).
    const kept = (await api.recentlyDeleted.list()).entries.filter((entry) => entry.kind === "connected-folder");
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.originalPath, connectedFolder.connectedFolderRoot);
    assert.equal(removal.recentlyDeleted?.entryId, kept[0]?.id);
    assert.equal((await listPendingConnectedFolderRemovals())[0]?.phase, "requested");

    await api.close();
    api = null;
    blockFinalCommit = false;
    api = await startLocalApi({
      port: 0,
      stateBase,
      connectedFolderBase,
      loadEnv: false,
      connectedFolderRemovalIo: removalIo,
    });
    assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
    assert.deepEqual((await request<{ connectedFolders: unknown[] }>(api, "/api/bootstrap")).connectedFolders, []);
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("startup carries remaining History into a deletion whose folder already reached Recently deleted", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-removal-history-recovery-"));
  const stateBase = join(sandbox, "state");
  const recentlyDeletedRoot = join(stateBase, "recently-deleted");
  let blockedStatePath: string | null = null;
  let api: LocalApiHandle | null = null;
  try {
    const recentlyDeleted = await AmpleFileRecentlyDeletedStore.open({ rootPath: recentlyDeletedRoot, io: {
      async rename(from, to) {
        if (from === blockedStatePath) throw new Error("simulated History move interruption");
        await rename(from, to);
      },
    } });
    api = await startLocalApi({ port: 0, stateBase, connectedFolderBase: join(sandbox, "connected-folders"), loadEnv: false, recentlyDeletedStore: recentlyDeleted });
    const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "History source" });
    await writeFile(join(connectedFolder.connectedFolderRoot, "draft.txt"), "Original draft\n");
    const checkpoint = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, { label: "Before interruption" });
    blockedStatePath = connectedFolderStateDir(connectedFolder.connectedFolderRoot);
    const removal = await request<{ cleanupPending: boolean }>(api, `/api/connected-folders/${connectedFolder.id}`, { method: "DELETE" });
    assert.equal(removal.cleanupPending, true);
    assert.equal(existsSync(connectedFolder.connectedFolderRoot), false);
    assert.equal(existsSync(blockedStatePath), true, "History has not moved yet");
    const [entry] = (await api.recentlyDeleted.list()).entries;
    assert.ok(entry);
    assert.equal(entry.stateDir, undefined);
    await api.close();
    api = null;
    blockedStatePath = null;
    api = await startLocalApi({ port: 0, stateBase, connectedFolderBase: join(sandbox, "connected-folders"), loadEnv: false, recentlyDeletedStore: await AmpleFileRecentlyDeletedStore.open({ rootPath: recentlyDeletedRoot }) });
    assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
    assert.equal((await api.recentlyDeleted.get(entry.id))?.stateDir, true);
    assert.equal(existsSync(connectedFolderStateDir(connectedFolder.connectedFolderRoot)), false);
    await api.recentlyDeleted.restoreTree(entry.id, { absolutePath: connectedFolder.connectedFolderRoot, stateDirFor: connectedFolderStateDir });
    assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "draft.txt"), "utf8"), "Original draft\n");
    assert.ok((await listConnectedFolderCheckpoints(connectedFolder.connectedFolderRoot)).some((item) => item.id === checkpoint.id), "the original checkpoint is restored");
  } finally {
    await api?.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an intent an older build marked app-state-removed still finalizes at startup", async () => {
  // Earlier builds with Connected Folder apps recorded a removal's progress
  // past its app cleanup as `app-state-removed`. Recovery
  // finishes such an intent exactly like a `requested` one.
  const sandbox = await mkdtemp(join(tmpdir(), "connected-folder-removal-app-state-phase-"));
  const stateBase = join(sandbox, "state");
  const connectedFolderBase = join(sandbox, "connected-folders");
  let api: LocalApiHandle | null = null;
  try {
    configureAmpleFileStateRoot(stateBase);
    const connectedFolder = await createManagedConnectedFolder("Old phase", connectedFolderBase);
    await beginConnectedFolderRemoval(connectedFolder.id, connectedFolderBase);
    const registryFile = connectedFolderRegistryFile();
    const registry = JSON.parse(await readFile(registryFile, "utf8")) as ConnectedFolderRegistry;
    registry.pendingRemovals[0]!.phase = "app-state-removed";
    await persistRegistryForTest(registry);
    assert.equal((await listPendingConnectedFolderRemovals())[0]?.phase, "app-state-removed");

    api = await startLocalApi({ port: 0, stateBase, connectedFolderBase, loadEnv: false });
    assert.deepEqual(await listPendingConnectedFolderRemovals(), []);
    assert.equal(existsSync(connectedFolder.connectedFolderRoot), false);
    assert.deepEqual((await request<{ connectedFolders: unknown[] }>(api, "/api/bootstrap")).connectedFolders, []);
    const kept = (await api.recentlyDeleted.list()).entries.filter((entry) => entry.kind === "connected-folder");
    assert.equal(kept.length, 1, "the managed folder reached Recently deleted, not an erase");
  } finally {
    await api?.close();
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function createConnectedFolder(api: LocalApiHandle, name: string): Promise<{ id: string; connectedFolderRoot: string }> {
  const { connectedFolder } = await request<{ connectedFolder: { id: string; connectedFolderRoot: string } }>(api, "/api/connected-folders", {
    method: "POST",
    body: { name },
  });
  return connectedFolder;
}

async function request<T = unknown>(
  api: LocalApiHandle,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${api.origin}${path}`, {
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.body),
    }),
  });
  const value = await response.json() as T & { error?: string };
  assert.equal(response.ok, true, value.error);
  return value;
}

async function persistRegistryForTest(registry: ConnectedFolderRegistry): Promise<void> {
  const file = connectedFolderRegistryFile();
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.test.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(temp, file);
}
