import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  createFullHistoryCapturePolicy,
  createTargetedHistoryCapturePolicy,
  type HistoryCapturePolicy,
} from "./history-capture-policy.js";
import type { HistoryPageInfo, HistoryPageOptions } from "../shared/history-review.js";
import { decodeRetrievalCursor, encodeRetrievalCursor, retrievalError } from "./retrieval-cursor.js";
import { isOfficeLockFileName } from "./office-lock-files.js";
import { connectedFolderHistoryRoot } from "./state-paths.js";
import { assertConnectedFolderDoesNotContainState, ensureSafeConnectedFolderRoot, resolveConnectedFolderPath, nestedRegisteredConnectedFolderPaths, withConnectedFolderHistoryOperation } from "./connected-folder.js";

export interface CheckpointFileEntry {
  path: string;
  hashSha256: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface CheckpointMove {
  fromPath: string;
  toPath: string;
}

export interface CheckpointSkippedFile {
  path: string;
  sizeBytes: number;
  reason: "too_large" | "unreadable" | "symbolic_link" | "excluded";
}

export interface ConnectedFolderCheckpoint {
  schemaVersion: "0.2.0";
  checkpointId: string;
  createdAt: string;
  label?: string;
  reason: string;
  scope: "full" | "targeted";
  manifestHash: string;
  fileCount: number;
  totalBytes: number;
  skippedLargeFiles: string[];
  skippedFiles: CheckpointSkippedFile[];
  captureRoots: string[];
  deleteOnRestore: string[];
  movesOnRestore: CheckpointMove[];
  directories: string[];
  files: CheckpointFileEntry[];
}

export interface ConnectedFolderFileVersion {
  path: string;
  hashSha256: string;
  sizeBytes: number;
  modifiedAt: string;
  capturedAt: string;
  checkpointId: string;
  checkpointLabel?: string;
  source: "checkpoint";
}

export interface ConnectedFolderRestoreResult {
  restored: true;
  checkpointId: string;
  safetyCheckpointId: string;
  restoredFiles: string[];
  deletedFiles: string[];
  movedEntries: CheckpointMove[];
  unchangedFiles: number;
  skippedLargeFiles: string[];
}

export interface StoredBlobRef {
  hashSha256: string;
  sizeBytes: number;
}

const checkpointIdPattern = /^cp-[A-Za-z0-9-]{10,80}$/;
/** Files hashed concurrently during a capture; bounds memory for in-memory reads. */
const captureHashConcurrency = 8;
/** Files at or above this size are hashed from a stream instead of being read whole. */
const captureStreamHashBytes = 8 * 1024 * 1024;
/**
 * How many new blobs one capture, or restored files one restore, flushes to
 * disk one by one. On macOS a flush is a full device flush (F_FULLFSYNC), about
 * 4 ms per small file, so flushing all 10,000 files of a first capture would
 * add some 40 s while the folder's History is held. Writes past this budget
 * are renamed into place unflushed; the manifest, which is the commit point,
 * is always flushed with its directory. The trade-off: after a power loss a
 * bulk capture's newest blobs may be cut short or lost. A blob of the wrong
 * size is rewritten by the next capture of the same content, a blob whose
 * bytes fail their hash is deleted at restore time so the next capture
 * rewrites it, and a restore never uses content that fails its hash. A bulk
 * restore's later files may likewise be cut short by a power loss; its
 * "Before restoring" restore point still holds what was there.
 */
const individuallyFlushedWritesPerOperation = 200;

/** The flushes one capture or restore may still spend; absent for a single write, which always flushes. */
interface FlushBudget { remaining: number }

function newFlushBudget(): FlushBudget {
  return { remaining: individuallyFlushedWritesPerOperation };
}

function spendFlush(budget: FlushBudget | undefined): boolean {
  if (!budget) return true;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

export async function storeConnectedFolderBlob(connectedFolderRoot: string, bytes: Buffer): Promise<StoredBlobRef> {
  const root = ensureHistoryRoot(connectedFolderRoot);
  const stored = await writeConnectedFolderBlob(root, bytes);
  await ensureHistoryMeta(root);
  return stored;
}

/** Stores bytes by hash; the caller ensures the History metadata once. */
async function writeConnectedFolderBlob(root: string, bytes: Buffer, budget?: FlushBudget): Promise<StoredBlobRef> {
  const hashSha256 = sha256(bytes);
  const blobPath = connectedFolderBlobPath(root, hashSha256);
  if (!await storedBlobIntact(blobPath, bytes.byteLength)) {
    await mkdir(dirname(blobPath), { recursive: true });
    const stagingPath = `${blobPath}.tmp-${randomUUID().slice(0, 8)}`;
    try {
      await writeNewFile(stagingPath, bytes, spendFlush(budget));
      await rename(stagingPath, blobPath);
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => undefined);
      if (!await storedBlobIntact(blobPath, bytes.byteLength)) throw error;
    }
  }
  return { hashSha256, sizeBytes: bytes.byteLength };
}

/**
 * A stored blob is trusted to hold its hash's content only when its size also
 * matches. A blob cut short by a crash or power loss fails that check, so the
 * next capture of the same content replaces it instead of every restore
 * point that names it staying unrestorable.
 */
async function storedBlobIntact(blobPath: string, sizeBytes: number): Promise<boolean> {
  const info = await stat(blobPath).catch(() => null);
  return Boolean(info?.isFile() && info.size === sizeBytes);
}

/** Writes a new file and, when asked, flushes it to disk before anyone can rename it into place. */
async function writeNewFile(path: string, bytes: Buffer | string, flush: boolean): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(bytes);
    if (flush) await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    // Not every platform allows directory handles; the fsynced file and
    // atomic rename remain the commit.
  }
}

/**
 * Captures one Connected Folder file into the blob store without holding large files in
 * memory. The common case — content already stored — costs one streamed read.
 * A new blob is copied (a clone on APFS) into a private staging file and then
 * hashed again from that copy, so the stored bytes always match the recorded
 * hash even if the source file changes mid-capture.
 */
async function storeConnectedFolderBlobFromFile(root: string, absolutePath: string, sizeBytes: number, budget?: FlushBudget): Promise<StoredBlobRef> {
  if (sizeBytes < captureStreamHashBytes) {
    return writeConnectedFolderBlob(root, await readFile(absolutePath), budget);
  }
  const hashSha256 = await sha256File(absolutePath);
  const blobPath = connectedFolderBlobPath(root, hashSha256);
  if (await storedBlobIntact(blobPath, sizeBytes)) return { hashSha256, sizeBytes };
  await mkdir(dirname(blobPath), { recursive: true });
  const stagingPath = `${blobPath}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    await copyFile(absolutePath, stagingPath);
    if (spendFlush(budget)) await syncFile(stagingPath);
    const stagedHash = await sha256File(stagingPath);
    const stagedInfo = await stat(stagingPath);
    const finalPath = connectedFolderBlobPath(root, stagedHash);
    if (await storedBlobIntact(finalPath, stagedInfo.size)) {
      await rm(stagingPath, { force: true });
    } else {
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await rename(stagingPath, finalPath);
      } catch (error) {
        await rm(stagingPath, { force: true }).catch(() => undefined);
        if (!await storedBlobIntact(finalPath, stagedInfo.size)) throw error;
      }
    }
    return { hashSha256: stagedHash, sizeBytes: stagedInfo.size };
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}
export async function readConnectedFolderBlob(connectedFolderRoot: string, hashSha256: string): Promise<Buffer | null> {
  const root = ensureHistoryRoot(connectedFolderRoot);
  const normalized = normalizeHash(hashSha256);
  const blobPath = connectedFolderBlobPath(root, normalized);
  const before = await stat(blobPath).catch(() => null);
  const bytes = await readFile(blobPath).catch(() => null);
  if (!bytes) return null;
  if (sha256(bytes) === normalized) return bytes;
  await discardDamagedBlob(blobPath, before);
  return null;
}

/**
 * Deletes a blob whose bytes do not match its hash, so the next capture of the
 * same content writes it again instead of skipping an existing path of the
 * right size. Only the exact file that was read is deleted: if a capture has
 * already replaced it, the replacement stays.
 */
async function discardDamagedBlob(blobPath: string, read: Awaited<ReturnType<typeof stat>> | null): Promise<void> {
  const current = await stat(blobPath).catch(() => null);
  if (!read || !current || current.ino !== read.ino || current.dev !== read.dev
    || current.size !== read.size || current.mtimeMs !== read.mtimeMs) return;
  await rm(blobPath, { force: true }).catch(() => undefined);
}

async function createConnectedFolderCheckpointUnlocked(
  connectedFolderRoot: string,
  options: { label?: string; reason?: string } = {},
): Promise<ConnectedFolderCheckpoint> {
  const root = ensureHistoryRoot(connectedFolderRoot);
  const captured = await capturePaths(root, [""], await createFullHistoryCapturePolicy(root));
  return persistCheckpoint(root, {
    reason: options.reason?.trim() || "manual",
    label: options.label,
    scope: "full",
    captureRoots: [],
    deleteOnRestore: [],
    movesOnRestore: [],
    ...captured,
  });
}

async function createConnectedFolderMutationCheckpointUnlocked(
  connectedFolderRoot: string,
  options: {
    paths?: string[];
    deleteOnRestore?: string[];
    movesOnRestore?: CheckpointMove[];
    label?: string;
    reason?: string;
  },
): Promise<ConnectedFolderCheckpoint> {
  const root = ensureHistoryRoot(connectedFolderRoot);
  const captureRoots = collapsePaths((options.paths ?? []).map((path) => canonicalPath(root, path, true).path));
  const deleteOnRestore = collapsePaths((options.deleteOnRestore ?? []).map((path) => canonicalPath(root, path, true).path));
  const movesOnRestore = (options.movesOnRestore ?? []).map((move) => ({
    fromPath: canonicalPath(root, move.fromPath, true).path,
    toPath: canonicalPath(root, move.toPath, true).path,
  }));
  const captured = await capturePaths(root, captureRoots, createTargetedHistoryCapturePolicy());
  return persistCheckpoint(root, {
    reason: options.reason?.trim() || "mutation",
    label: options.label,
    scope: "targeted",
    captureRoots,
    deleteOnRestore,
    movesOnRestore,
    ...captured,
  });
}

export async function listConnectedFolderCheckpoints(connectedFolderRoot: string, limit = 50): Promise<ConnectedFolderCheckpoint[]> {
  const root = ensureHistoryRoot(connectedFolderRoot);
  return (await readCheckpointManifests(root)).slice(0, Math.min(Math.max(limit, 1), 1000));
}

/** A page of the full retained ledger; the cursor rejects a changed source. */
export async function listConnectedFolderCheckpointPage(connectedFolderRoot: string, options: HistoryPageOptions = {}): Promise<HistoryPageInfo & { checkpoints: ConnectedFolderCheckpoint[] }> {
  const root = ensureHistoryRoot(connectedFolderRoot);
  return withConnectedFolderHistoryOperation(root, async () => {
    const checkpoints = await readCheckpointManifests(root);
    const page = historyPage(root, "checkpoints", checkpoints, options);
    return { ...page.info, checkpoints: page.items };
  });
}

function historyPage<T>(root: string, selector: string, items: T[], options: HistoryPageOptions): { items: T[]; info: HistoryPageInfo } {
  const sourceHash = createHash("sha256");
  for (const item of items) sourceHash.update(JSON.stringify(item)).update("\n");
  const sourceVersion = sourceHash.digest("hex");
  const scope = createHash("sha256").update(JSON.stringify([root, selector])).digest("hex");
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw retrievalError("History page limit must be between 1 and 1000.");
  const cursor = options.cursor ? decodeRetrievalCursor<{ scope: string; sourceVersion: string; offset: number }>(options.cursor) : undefined;
  if (cursor && (cursor.scope !== scope || cursor.sourceVersion !== sourceVersion)) throw retrievalError("History changed or this cursor belongs to another selection. Start the listing again.", 409);
  const offset = cursor?.offset ?? 0;
  const end = Math.min(items.length, offset + limit);
  return { items: items.slice(offset, end), info: { total: items.length, sourceVersion,
    nextCursor: end < items.length ? encodeRetrievalCursor({ scope, sourceVersion, offset: end }) : null } };
}

export async function getConnectedFolderCheckpoint(connectedFolderRoot: string, checkpointId: string): Promise<ConnectedFolderCheckpoint | null> {
  if (!checkpointIdPattern.test(checkpointId)) return null;
  const root = ensureHistoryRoot(connectedFolderRoot);
  return readCheckpointManifest(join(checkpointsDir(root), `${checkpointId}.json`));
}

async function discardConnectedFolderCheckpointUnlocked(connectedFolderRoot: string, checkpointId: string): Promise<void> {
  if (!checkpointIdPattern.test(checkpointId)) return;
  const root = ensureHistoryRoot(connectedFolderRoot);
  await rm(join(checkpointsDir(root), `${checkpointId}.json`), { force: true });
  const { checkpoints, damaged } = await readCheckpointLedger(root);
  await garbageCollectObjects(root, checkpoints, damaged);
}

async function restoreConnectedFolderCheckpointUnlocked(connectedFolderRoot: string, checkpointId: string): Promise<ConnectedFolderRestoreResult> {
  const root = ensureHistoryRoot(connectedFolderRoot);
  const checkpoint = await getConnectedFolderCheckpoint(root, checkpointId);
  if (!checkpoint) throw notFound("Restore point not found.");
  validateCheckpointPaths(root, checkpoint);
  const staged = await stageCheckpointContent(root, checkpoint);
  try {
    await preflightRestore(root, checkpoint);
    await assertRestoreOwnership(root, checkpoint);

    const safety = checkpoint.scope === "full"
      ? await createConnectedFolderCheckpoint(root, { reason: "pre_restore", label: `Before restoring ${checkpointId}` })
      : await createTargetedRestoreSafety(root, checkpoint);
    assertRestoreCoverage(checkpoint, safety);
    await assertRestoreOwnership(root, checkpoint);

    const movedEntries: CheckpointMove[] = [];
    for (const move of checkpoint.movesOnRestore) {
      const from = canonicalPath(root, move.fromPath, false).absolutePath;
      const to = canonicalPath(root, move.toPath, true).absolutePath;
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      movedEntries.push(move);
    }

    const deletedFiles: string[] = [];
    for (const path of collapsePaths(checkpoint.deleteOnRestore)) {
      const target = canonicalPath(root, path, true).absolutePath;
      if (!existsSync(target)) continue;
      await rm(target, { recursive: true, force: true });
      deletedFiles.push(path);
    }

    for (const directory of checkpoint.directories) {
      await mkdir(canonicalPath(root, directory, true).absolutePath, { recursive: true });
    }

    const current = checkpoint.scope === "full"
      ? new Map(safety.files.map((file) => [file.path, file]))
      : new Map<string, CheckpointFileEntry>();
    const restoredFiles: string[] = [];
    const flushBudget = newFlushBudget();
    let unchangedFiles = 0;
    for (const file of checkpoint.files) {
      if (current.get(file.path)?.hashSha256 === file.hashSha256) {
        unchangedFiles += 1;
        continue;
      }
      const bytes = await readFile(staged.pathsByHash.get(file.hashSha256)!);
      const target = canonicalPath(root, file.path, true).absolutePath;
      await mkdir(dirname(target), { recursive: true });
      await atomicRestoreFile(root, file.path, bytes, flushBudget);
      restoredFiles.push(file.path);
    }

    if (checkpoint.scope === "full") {
      const selectedPaths = new Set(checkpoint.files.map((file) => file.path));
      const selectedSkipped = new Set(checkpoint.skippedFiles.map((file) => file.path));
      for (const file of safety.files) {
        if (selectedPaths.has(file.path) || [...selectedSkipped].some((path) => file.path === path || file.path.startsWith(`${path}/`))) continue;
        const target = canonicalPath(root, file.path, false).absolutePath;
        await rm(target, { force: true });
        deletedFiles.push(file.path);
      }
    }

    return {
      restored: true,
      checkpointId,
      safetyCheckpointId: safety.checkpointId,
      restoredFiles: restoredFiles.sort(),
      deletedFiles: [...new Set(deletedFiles)].sort(),
      movedEntries,
      unchangedFiles,
      skippedLargeFiles: checkpoint.skippedLargeFiles,
    };
  } finally {
    await rm(staged.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function listFileVersions(connectedFolderRoot: string, relativePath: string, limit = 50): Promise<ConnectedFolderFileVersion[]> {
  return (await listFileVersionPage(connectedFolderRoot, relativePath, { limit: Math.min(Math.max(limit, 1), 200) })).versions;
}

export async function listFileVersionPage(connectedFolderRoot: string, relativePath: string, options: HistoryPageOptions = {}): Promise<HistoryPageInfo & { versions: ConnectedFolderFileVersion[] }> {
  const root = ensureHistoryRoot(connectedFolderRoot);
  const path = canonicalPath(root, relativePath, true).path;
  return withConnectedFolderHistoryOperation(root, async () => {
    const versions: ConnectedFolderFileVersion[] = [];
    const seen = new Set<string>();
    for (const checkpoint of await readCheckpointManifests(root)) {
      const file = checkpoint.files.find((entry) => entry.path === path);
      if (!file || seen.has(file.hashSha256) || !(await hasConnectedFolderBlob(root, file.hashSha256))) continue;
      seen.add(file.hashSha256);
      versions.push({ path, hashSha256: file.hashSha256, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt,
        capturedAt: checkpoint.createdAt, checkpointId: checkpoint.checkpointId,
        ...(checkpoint.label ? { checkpointLabel: checkpoint.label } : {}), source: "checkpoint" });
    }
    const page = historyPage(root, `versions:${path}`, versions, options);
    return { ...page.info, versions: page.items };
  });
}

async function restoreFileVersionUnlocked(
  connectedFolderRoot: string,
  relativePath: string,
  hashSha256: string,
): Promise<{ restored: true; path: string; hashSha256: string; previousHashSha256: string | null; safetyCheckpointId: string }> {
  const root = ensureHistoryRoot(connectedFolderRoot);
  const { path, absolutePath } = canonicalPath(root, relativePath, true);
  const normalizedHash = normalizeHash(hashSha256);
  const bytes = await readConnectedFolderBlob(root, normalizedHash);
  if (!bytes) throw notFound("File version not found.");
  const currentInfo = await stat(absolutePath).catch(() => null);
  if (currentInfo && !currentInfo.isFile()) throw new Error("The selected path is currently a folder.");
  const currentBytes = currentInfo?.isFile() ? await readFile(absolutePath) : null;
  const safety = await createConnectedFolderMutationCheckpoint(root, {
    paths: currentBytes ? [path] : [],
    deleteOnRestore: currentBytes ? [] : [path],
    reason: "pre_file_restore",
    label: `Before restoring ${path}`,
  });
  assertRestoreCoverage({ ...safety, files: [{ path, hashSha256: normalizedHash, sizeBytes: bytes.length, modifiedAt: new Date().toISOString() }], deleteOnRestore: [] }, safety);
  await assertRestoreOwnership(root, safety);
  await atomicRestoreFile(root, path, bytes);
  return {
    restored: true,
    path,
    hashSha256: normalizedHash,
    previousHashSha256: currentBytes ? sha256(currentBytes) : null,
    safetyCheckpointId: safety.checkpointId,
  };
}

async function capturePaths(root: string, requestedPaths: string[], policy: HistoryCapturePolicy, persistBlobs = true): Promise<{
  directories: string[];
  files: CheckpointFileEntry[];
  skippedFiles: CheckpointSkippedFile[];
}> {
  const directories = new Set<string>();
  const files = new Map<string, CheckpointFileEntry>();
  const skipped = new Map<string, CheckpointSkippedFile>();
  const nestedPaths = await nestedRegisteredConnectedFolderPaths(root);
  const pendingFiles: Array<{ path: string; absolutePath: string; sizeBytes: number; modifiedAt: string }> = [];
  const flushBudget = newFlushBudget();

  const visit = async (absolutePath: string): Promise<void> => {
    const path = toPosix(relative(root, absolutePath));
    if (path && nestedPaths.some((nested) => path === nested || path.startsWith(`${nested}/`))) {
      skipped.set(path, { path, sizeBytes: 0, reason: "excluded" });
      return;
    }
    const info = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") skipped.set(path, { path, sizeBytes: 0, reason: "unreadable" });
      return null;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      if (path) skipped.set(path, { path, sizeBytes: 0, reason: "symbolic_link" });
      return;
    }
    if (info.isDirectory()) {
      if (path && (nestedPaths.some((nested) => path === nested || path.startsWith(`${nested}/`)) || await policy.excludeDirectory(path, absolutePath))) {
        skipped.set(path, { path, sizeBytes: 0, reason: "excluded" });
        return;
      }
      if (path) directories.add(path);
      await policy.enterDirectory(path, absolutePath);
      const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => {
        skipped.set(path, { path, sizeBytes: 0, reason: "unreadable" });
        return [];
      });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (isOfficeLockFileName(entry.name)) continue;
        await visit(join(absolutePath, entry.name));
      }
      return;
    }
    if (!info.isFile() || !path) return;
    if (policy.excludeFile(path)) {
      skipped.set(path, { path, sizeBytes: info.size, reason: "excluded" });
      return;
    }
    if (info.size > maxVersionedFileBytes()) {
      skipped.set(path, { path, sizeBytes: info.size, reason: "too_large" });
      return;
    }
    pendingFiles.push({ path, absolutePath, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
  };

  if (requestedPaths.includes("")) await visit(root);
  else for (const path of collapsePaths(requestedPaths)) await visit(canonicalPath(root, path, true).absolutePath);

  // History is a recovery boundary, so metadata is never treated as proof of
  // content identity. External tools can preserve both size and mtime while
  // replacing bytes; every capture hashes what is actually on disk. The hashing
  // itself runs a bounded number of files at a time.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pendingFiles.length) {
      const file = pendingFiles[next]!;
      next += 1;
      try {
        const blob = persistBlobs ? await storeConnectedFolderBlobFromFile(root, file.absolutePath, file.sizeBytes, flushBudget)
          : { hashSha256: await sha256File(file.absolutePath), sizeBytes: file.sizeBytes };
        files.set(file.path, { path: file.path, hashSha256: blob.hashSha256, sizeBytes: blob.sizeBytes, modifiedAt: file.modifiedAt });
      } catch {
        skipped.set(file.path, { path: file.path, sizeBytes: file.sizeBytes, reason: "unreadable" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(captureHashConcurrency, pendingFiles.length) }, () => worker()));
  // Once per capture that stored content, not once per file.
  if (persistBlobs && files.size) await ensureHistoryMeta(root);

  return {
    directories: [...directories].sort((left, right) => left.localeCompare(right)),
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    skippedFiles: [...skipped.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function persistCheckpoint(root: string, input: {
  reason: string;
  label?: string;
  scope: "full" | "targeted";
  captureRoots: string[];
  deleteOnRestore: string[];
  movesOnRestore: CheckpointMove[];
  directories: string[];
  files: CheckpointFileEntry[];
  skippedFiles: CheckpointSkippedFile[];
}): Promise<ConnectedFolderCheckpoint> {
  const material = {
    scope: input.scope,
    captureRoots: input.captureRoots,
    deleteOnRestore: input.deleteOnRestore,
    movesOnRestore: input.movesOnRestore,
    directories: input.directories,
    files: input.files.map(({ path, hashSha256 }) => ({ path, hashSha256 })),
    skippedFiles: input.skippedFiles,
  };
  const manifestHash = sha256(Buffer.from(stableJson(material), "utf8"));
  const latest = input.scope === "full" ? await readLatestCheckpoint(root) : null;
  if (input.scope === "full" && latest?.scope === "full" && latest.manifestHash === manifestHash) return latest;

  const createdAt = new Date().toISOString();
  const checkpoint: ConnectedFolderCheckpoint = {
    schemaVersion: "0.2.0",
    checkpointId: `cp-${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    createdAt,
    ...(input.label?.trim() ? { label: input.label.trim().slice(0, 160) } : {}),
    reason: input.reason,
    scope: input.scope,
    manifestHash,
    fileCount: input.files.length,
    totalBytes: input.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    skippedLargeFiles: input.skippedFiles.filter((file) => file.reason === "too_large").map((file) => file.path),
    skippedFiles: input.skippedFiles,
    captureRoots: input.captureRoots,
    deleteOnRestore: input.deleteOnRestore,
    movesOnRestore: input.movesOnRestore,
    directories: input.directories,
    files: input.files,
  };
  await atomicJsonWrite(join(checkpointsDir(root), `${checkpoint.checkpointId}.json`), checkpoint);
  await ensureHistoryMeta(root);
  await pruneHistory(root);
  return checkpoint;
}

function assertRestoreCoverage(checkpoint: ConnectedFolderCheckpoint, safety: ConnectedFolderCheckpoint): void {
  const writes = checkpoint.files.map((file) => file.path);
  const uncovered = safety.skippedFiles.filter((skip) =>
    writes.some((path) => path === skip.path || path.startsWith(`${skip.path}/`))
    || checkpoint.deleteOnRestore.some((path) => skip.path === path || skip.path.startsWith(`${path}/`) || path.startsWith(`${skip.path}/`)));
  if (uncovered.length) {
    throw new Error(`Restore refused: current content cannot be recovered: ${uncovered.slice(0, 5).map((file) => `${file.path} (${file.reason})`).join(", ")}. No files were changed.`);
  }
}

async function assertRestoreOwnership(root: string, checkpoint: ConnectedFolderCheckpoint): Promise<void> {
  const nested = await nestedRegisteredConnectedFolderPaths(root);
  const paths = [...checkpoint.files.map((file) => file.path), ...checkpoint.directories,
    ...checkpoint.deleteOnRestore, ...checkpoint.movesOnRestore.flatMap((move) => [move.fromPath, move.toPath])];
  for (const path of paths) {
    if (nested.some((child) => path === child || path.startsWith(`${child}/`)
      || checkpoint.deleteOnRestore.includes(path) && child.startsWith(`${path}/`)
      || checkpoint.movesOnRestore.some((move) => move.fromPath === path || move.toPath === path) && child.startsWith(`${path}/`))) {
      throw new Error(`Restore refused: ${path} belongs to or contains another registered Connected Folder. No files were changed.`);
    }
  }
}

async function atomicRestoreFile(root: string, path: string, bytes: Buffer, budget?: FlushBudget): Promise<void> {
  const target = canonicalPath(root, path, true).absolutePath;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.amplefile-restore-${randomUUID()}`;
  try {
    await writeNewFile(temporary, bytes, spendFlush(budget));
    canonicalPath(root, path, true);
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

async function createTargetedRestoreSafety(root: string, checkpoint: ConnectedFolderCheckpoint): Promise<ConnectedFolderCheckpoint> {
  const affectedRoots = collapsePaths([...checkpoint.captureRoots, ...checkpoint.deleteOnRestore]);
  const existing: string[] = [];
  const deleteOnRestore: string[] = [];
  for (const path of affectedRoots) {
    if (existsSync(canonicalPath(root, path, true).absolutePath)) existing.push(path);
    else deleteOnRestore.push(path);
  }
  return createConnectedFolderMutationCheckpoint(root, {
    paths: existing,
    deleteOnRestore,
    movesOnRestore: checkpoint.movesOnRestore.map((move) => ({ fromPath: move.toPath, toPath: move.fromPath })),
    reason: "pre_restore",
    label: `Before restoring ${checkpoint.checkpointId}`,
  });
}

async function preflightRestore(root: string, checkpoint: ConnectedFolderCheckpoint): Promise<void> {
  for (const move of checkpoint.movesOnRestore) {
    const from = canonicalPath(root, move.fromPath, false).absolutePath;
    const to = canonicalPath(root, move.toPath, true).absolutePath;
    if (!existsSync(from)) throw new Error(`Cannot undo move because ${move.fromPath} no longer exists.`);
    if (existsSync(to)) throw new Error(`Cannot undo move because ${move.toPath} already exists.`);
  }
  const deletedRoots = collapsePaths(checkpoint.deleteOnRestore);
  for (const file of checkpoint.files) {
    const target = canonicalPath(root, file.path, true).absolutePath;
    const info = await stat(target).catch(() => null);
    const isDeletedFirst = deletedRoots.some((path) => file.path === path || file.path.startsWith(`${path}/`));
    if (info?.isDirectory() && !isDeletedFirst) throw new Error(`Cannot restore file over folder: ${file.path}`);
  }
}

function validateCheckpointPaths(root: string, checkpoint: ConnectedFolderCheckpoint): void {
  for (const directory of checkpoint.directories) canonicalPath(root, directory, true);
  for (const file of checkpoint.files) canonicalPath(root, file.path, true);
  for (const path of checkpoint.captureRoots) canonicalPath(root, path, true);
  for (const path of checkpoint.deleteOnRestore) canonicalPath(root, path, true);
  for (const move of checkpoint.movesOnRestore) {
    canonicalPath(root, move.fromPath, true);
    canonicalPath(root, move.toPath, true);
  }
}

/**
 * The newest checkpoint without parsing the whole ledger. A checkpoint id
 * starts with its creation time to the second, so only the newest second's
 * manifests (and any id without that stamp) need reading; an older second is
 * read only when every newer manifest is damaged.
 */
async function readLatestCheckpoint(root: string): Promise<ConnectedFolderCheckpoint | null> {
  const names = (await readdir(checkpointsDir(root)).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
  const bySecond = new Map<string, string[]>();
  const unstamped: string[] = [];
  for (const name of names) {
    const stamp = /^cp-(\d{14})-/.exec(name)?.[1];
    if (stamp) bySecond.set(stamp, [...(bySecond.get(stamp) ?? []), name]);
    else unstamped.push(name);
  }
  const read = async (group: string[]): Promise<ConnectedFolderCheckpoint[]> =>
    (await Promise.all(group.map((name) => readCheckpointManifest(join(checkpointsDir(root), name)))))
      .filter((checkpoint): checkpoint is ConnectedFolderCheckpoint => checkpoint !== null);
  const unstampedCheckpoints = await read(unstamped);
  for (const stamp of [...bySecond.keys()].sort().reverse()) {
    const group = await read(bySecond.get(stamp)!);
    if (group.length) return sortCheckpoints([...group, ...unstampedCheckpoints])[0]!;
  }
  return sortCheckpoints(unstampedCheckpoints)[0] ?? null;
}

/** Reads the ledger only once it holds more manifests than History keeps. */
async function pruneHistory(root: string): Promise<void> {
  const names = await readdir(checkpointsDir(root)).catch(() => [] as string[]);
  if (names.filter((name) => name.endsWith(".json")).length <= maxRetainedCheckpoints()) return;
  const { checkpoints, damaged } = await readCheckpointLedger(root);
  // A damaged manifest takes a place in the retention window by the time in
  // its id (or its file's time), so its content is kept while it would have
  // been and is let go when it would have aged out.
  const ledger = [
    ...checkpoints.map((checkpoint) => ({ createdAt: checkpoint.createdAt, name: `${checkpoint.checkpointId}.json`, checkpoint, damaged: null })),
    ...damaged.map((manifest) => ({ createdAt: manifest.createdAt, name: manifest.name, checkpoint: null, damaged: manifest })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.name.localeCompare(left.name));
  const retained = ledger.slice(0, maxRetainedCheckpoints());
  const removed = ledger.slice(retained.length);
  if (!removed.length) return;
  for (const entry of removed) {
    await rm(join(checkpointsDir(root), entry.name), { force: true, recursive: entry.damaged !== null }).catch(() => undefined);
  }
  await garbageCollectObjects(root,
    retained.flatMap((entry) => entry.checkpoint ? [entry.checkpoint] : []),
    retained.flatMap((entry) => entry.damaged ? [entry.damaged] : []));
}

/**
 * Deletes blobs no retained checkpoint names. A manifest that failed to parse
 * still protects every hash its text names, and one that could not be read at
 * all stops collection, so content is never deleted on the strength of a
 * manifest AmpleFile merely could not understand.
 */
async function garbageCollectObjects(root: string, retained: ConnectedFolderCheckpoint[], damaged: DamagedCheckpointManifest[]): Promise<void> {
  if (damaged.some((manifest) => manifest.text === null)) return;
  const referenced = new Set(retained.flatMap((checkpoint) => checkpoint.files.map((file) => file.hashSha256)));
  for (const manifest of damaged) {
    for (const hash of manifest.text!.toLowerCase().match(/[a-f0-9]{64}/g) ?? []) referenced.add(hash);
  }
  const objectsRoot = join(connectedFolderHistoryRoot(root), "objects");
  for (const prefix of await readdir(objectsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!prefix.isDirectory()) continue;
    const directory = join(objectsRoot, prefix.name);
    for (const object of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!object.isFile()) continue;
      const hash = `${prefix.name}${object.name}`;
      if (!referenced.has(hash)) await rm(join(directory, object.name), { force: true });
    }
    if (!(await readdir(directory).catch(() => [])).length) await rm(directory, { recursive: true, force: true });
  }
}

async function stageCheckpointContent(
  root: string,
  checkpoint: ConnectedFolderCheckpoint,
): Promise<{ root: string; pathsByHash: Map<string, string> }> {
  const stagingRoot = join(connectedFolderHistoryRoot(root), "restore-staging", randomUUID());
  const pathsByHash = new Map<string, string>();
  const missing: string[] = [];
  await mkdir(stagingRoot, { recursive: true });
  try {
    for (const file of checkpoint.files) {
      if (pathsByHash.has(file.hashSha256)) continue;
      const bytes = await readConnectedFolderBlob(root, file.hashSha256);
      if (!bytes) {
        missing.push(file.path);
        continue;
      }
      const path = join(stagingRoot, normalizeHash(file.hashSha256));
      await writeFile(path, bytes);
      pathsByHash.set(file.hashSha256, path);
    }
    if (missing.length) {
      throw new Error(`Restore point is missing saved content for ${missing.sort().join(", ")}. No files were changed.`);
    }
    return { root: stagingRoot, pathsByHash };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * A manifest that exists but cannot be read as a current checkpoint: cut short
 * by a crash, written by a newer AmpleFile, or unreadable. `text` is null when
 * the file could not be read at all.
 */
interface DamagedCheckpointManifest {
  name: string;
  text: string | null;
  /** From the time stamped in its id, else the file's modification time. */
  createdAt: string;
}

const reportedDamagedManifests = new Set<string>();

/** Says once per manifest and run that History is setting a manifest aside, so the
 * condition reaches the app's log instead of passing silently. */
function reportDamagedManifest(root: string, manifest: DamagedCheckpointManifest): void {
  const key = `${root}\u0000${manifest.name}`;
  if (reportedDamagedManifests.has(key)) return;
  reportedDamagedManifests.add(key);
  console.warn(manifest.text === null
    ? `History for ${root} could not read restore point ${manifest.name}; unused saved content is not cleaned up until retention drops it.`
    : `History for ${root} could not use restore point ${manifest.name}; the content it names is kept until retention drops it.`);
}

function damagedManifestTime(name: string, modifiedAt: Date | null): string {
  const stamp = /^cp-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(name);
  if (stamp) {
    const iso = `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.000Z`;
    if (Number.isFinite(Date.parse(iso))) return iso;
  }
  return (modifiedAt ?? new Date(0)).toISOString();
}

async function readCheckpointLedger(root: string): Promise<{ checkpoints: ConnectedFolderCheckpoint[]; damaged: DamagedCheckpointManifest[] }> {
  const entries = await readdir(checkpointsDir(root)).catch(() => [] as string[]);
  const checkpoints: ConnectedFolderCheckpoint[] = [];
  const damaged: DamagedCheckpointManifest[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const read = await readCheckpointManifestFile(join(checkpointsDir(root), name));
    if (read.checkpoint) checkpoints.push(read.checkpoint);
    else if (read.exists) {
      const modifiedAt = (await lstat(join(checkpointsDir(root), name)).catch(() => null))?.mtime ?? null;
      const manifest = { name, text: read.text, createdAt: damagedManifestTime(name, modifiedAt) };
      damaged.push(manifest);
      reportDamagedManifest(root, manifest);
    }
  }
  return { checkpoints: sortCheckpoints(checkpoints), damaged };
}

function sortCheckpoints(checkpoints: ConnectedFolderCheckpoint[]): ConnectedFolderCheckpoint[] {
  return checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.checkpointId.localeCompare(left.checkpointId));
}

async function readCheckpointManifests(root: string): Promise<ConnectedFolderCheckpoint[]> {
  return (await readCheckpointLedger(root)).checkpoints;
}

async function readCheckpointManifest(path: string): Promise<ConnectedFolderCheckpoint | null> {
  return (await readCheckpointManifestFile(path)).checkpoint;
}

async function readCheckpointManifestFile(path: string): Promise<
  { checkpoint: ConnectedFolderCheckpoint; exists: true; text: string }
  | { checkpoint: null; exists: boolean; text: string | null }
> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { checkpoint: null, exists: (error as NodeJS.ErrnoException)?.code !== "ENOENT", text: null };
  }
  try {
    const value = JSON.parse(text) as Partial<ConnectedFolderCheckpoint>;
    if (value.schemaVersion !== "0.2.0" || !checkpointIdPattern.test(value.checkpointId ?? "") || !Array.isArray(value.files)) {
      return { checkpoint: null, exists: true, text };
    }
    return { checkpoint: { ...value, directories: Array.isArray(value.directories) ? value.directories : [] } as ConnectedFolderCheckpoint, exists: true, text };
  } catch {
    return { checkpoint: null, exists: true, text };
  }
}

async function hasConnectedFolderBlob(root: string, hashSha256: string): Promise<boolean> {
  try {
    return existsSync(connectedFolderBlobPath(root, hashSha256));
  } catch {
    return false;
  }
}

function canonicalPath(root: string, value: string, allowMissing: boolean): { path: string; absolutePath: string } {
  const absolutePath = resolveConnectedFolderPath(root, toPosix(value).replace(/^\/+/, "") || ".");
  const path = toPosix(relative(root, absolutePath));
  if (!path || path === ".") throw new Error("The Connected Folder root cannot be used as a history item.");
  if (!allowMissing && !existsSync(absolutePath)) throw notFound(`Connected Folder item not found: ${path}`);
  return { path, absolutePath };
}

function collapsePaths(paths: string[]): string[] {
  const sorted = [...new Set(paths.filter(Boolean))].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  return sorted.filter((path, index) => !sorted.slice(0, index).some((parent) => path === parent || path.startsWith(`${parent}/`)));
}

function ensureHistoryRoot(connectedFolderRoot: string): string {
  const root = ensureSafeConnectedFolderRoot(connectedFolderRoot);
  assertConnectedFolderDoesNotContainState(root);
  return root;
}

function connectedFolderBlobPath(root: string, hashSha256: string): string {
  const normalized = normalizeHash(hashSha256);
  return join(connectedFolderHistoryRoot(root), "objects", normalized.slice(0, 2), normalized.slice(2));
}

function checkpointsDir(root: string): string {
  return join(connectedFolderHistoryRoot(root), "checkpoints");
}

async function ensureHistoryMeta(root: string): Promise<void> {
  const path = join(connectedFolderHistoryRoot(root), "meta.json");
  if (existsSync(path)) return;
  await atomicJsonWrite(path, { schemaVersion: "0.2.0", connectedFolderRoot: resolve(root), createdAt: new Date().toISOString() });
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeNewFile(temporary, `${JSON.stringify(value, null, 2)}\n`, true);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectoryBestEffort(dirname(path));
}

function maxVersionedFileBytes(): number {
  const configured = Number(process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 100 * 1024 * 1024;
}

function maxRetainedCheckpoints(): number {
  const configured = Number(process.env.AMPLEFILE_HISTORY_MAX_CHECKPOINTS);
  return Number.isFinite(configured) && configured >= 2 ? Math.min(Math.floor(configured), 500) : 100;
}

function normalizeHash(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("Invalid history object hash.");
  return normalized;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

export async function createConnectedFolderCheckpoint(...args: Parameters<typeof createConnectedFolderCheckpointUnlocked>): Promise<Awaited<ReturnType<typeof createConnectedFolderCheckpointUnlocked>>> {
  return withConnectedFolderHistoryOperation(args[0], () => createConnectedFolderCheckpointUnlocked(...args));
}

export async function createConnectedFolderMutationCheckpoint(...args: Parameters<typeof createConnectedFolderMutationCheckpointUnlocked>): Promise<Awaited<ReturnType<typeof createConnectedFolderMutationCheckpointUnlocked>>> {
  return withConnectedFolderHistoryOperation(args[0], () => createConnectedFolderMutationCheckpointUnlocked(...args));
}

export async function discardConnectedFolderCheckpoint(...args: Parameters<typeof discardConnectedFolderCheckpointUnlocked>): Promise<Awaited<ReturnType<typeof discardConnectedFolderCheckpointUnlocked>>> {
  return withConnectedFolderHistoryOperation(args[0], () => discardConnectedFolderCheckpointUnlocked(...args));
}

export async function restoreConnectedFolderCheckpoint(...args: Parameters<typeof restoreConnectedFolderCheckpointUnlocked>): Promise<Awaited<ReturnType<typeof restoreConnectedFolderCheckpointUnlocked>>> {
  return withConnectedFolderHistoryOperation(args[0], () => restoreConnectedFolderCheckpointUnlocked(...args));
}

export async function restoreFileVersion(...args: Parameters<typeof restoreFileVersionUnlocked>): Promise<Awaited<ReturnType<typeof restoreFileVersionUnlocked>>> {
  return withConnectedFolderHistoryOperation(args[0], () => restoreFileVersionUnlocked(...args));
}

export interface ConnectedFolderRestorePreview {
  checkpointId: string;
  scope: "full" | "targeted";
  restoreFiles: string[];
  removePaths: string[];
  moves: CheckpointMove[];
  excludedPaths: string[];
  uncoveredPaths: string[];
  conflicts: string[];
}

export async function previewConnectedFolderCheckpointRestore(connectedFolderRoot: string, checkpointId: string): Promise<ConnectedFolderRestorePreview> {
  return withConnectedFolderHistoryOperation(connectedFolderRoot, async () => {
    const root = ensureHistoryRoot(connectedFolderRoot);
    const checkpoint = await getConnectedFolderCheckpoint(root, checkpointId);
    if (!checkpoint) throw notFound("Restore point not found.");
    validateCheckpointPaths(root, checkpoint);
    const conflicts: string[] = [];
    try { await preflightRestore(root, checkpoint); await assertRestoreOwnership(root, checkpoint); }
    catch (error) { conflicts.push(error instanceof Error ? error.message : "Restore is unavailable."); }
    if (conflicts.length) return { checkpointId, scope: checkpoint.scope, restoreFiles: [], removePaths: [], moves: [], excludedPaths: [], uncoveredPaths: [], conflicts };
    const current = await capturePaths(root, checkpoint.scope === "full" ? [""] : collapsePaths([...checkpoint.captureRoots, ...checkpoint.deleteOnRestore]),
      checkpoint.scope === "full" ? await createFullHistoryCapturePolicy(root) : createTargetedHistoryCapturePolicy(), false);
    try { assertRestoreCoverage(checkpoint, { ...checkpoint, ...current }); }
    catch (error) { conflicts.push(error instanceof Error ? error.message : "Current files cannot be recovered."); }
    const selected = new Set(checkpoint.files.map((file) => file.path));
    const excluded = checkpoint.skippedFiles.map((file) => file.path);
    const currentHashes = new Map(current.files.map((file) => [file.path, file.hashSha256]));
    return {
      checkpointId, scope: checkpoint.scope,
      restoreFiles: checkpoint.files.filter((file) => currentHashes.get(file.path) !== file.hashSha256).map((file) => file.path),
      removePaths: [...new Set([...checkpoint.deleteOnRestore.filter((path) => existsSync(resolveConnectedFolderPath(root, path))),
        ...(checkpoint.scope === "full" ? current.files.filter((file) => !selected.has(file.path) && !excluded.some((path) => file.path === path || file.path.startsWith(`${path}/`))).map((file) => file.path) : [])])],
      moves: checkpoint.movesOnRestore,
      excludedPaths: excluded,
      uncoveredPaths: current.skippedFiles.map((file) => file.path),
      conflicts,
    };
  });
}
