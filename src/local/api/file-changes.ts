/**
 * Changing a Connected Folder's files with their recovery: deletes that go to
 * History or Recently Deleted, moves under one restore point, and adding files
 * from outside. Deletes queue for the Connected Folder's History before they
 * reserve it (see `reservations.ts`).
 */

import { lstat, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createConnectedFolderMutationCheckpoint, discardConnectedFolderCheckpoint } from "../history.js";
import {
  AmpleFileRecentlyDeletedError,
  type AmpleFileRecentlyDeletedEntry,
  type AmpleFileRecentlyDeletedUncoveredPath,
} from "../recently-deleted-store.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import {
  copyPathIntoConnectedFolder,
  checkConnectedFolderMoves,
  deleteConnectedFolderEntry,
  ensureSafeConnectedFolderRoot,
  moveConnectedFolderEntry,
  outermostConnectedFolderPaths,
  resolveConnectedFolderDeleteTarget,
  resolveConnectedFolderPath,
  touchConnectedFolderRoot,
  withConnectedFolderHistoryOperation,
  withConnectedFolderTouchBatch,
  type ConnectedFolderMovedEntry,
  type ConnectedFolderSummary,
} from "../connected-folder.js";
import { badRequest, errorMessage } from "./http.js";
import { runDesktopSettingsAct } from "./prepared-act-adapters.js";
import {
  checkpointAdditiveWritesOrUndo,
  reserveCapabilityMutation,
  runSettledConnectedFolderDeletion,
  runWithHistorySafety,
} from "./reservations.js";
import type { LocalApiState } from "./state.js";

export async function addExternalFilesInternal(
  connectedFolder: ConnectedFolderSummary,
  input: { fromPaths: string[]; toDir?: string; cwd: string },
): Promise<{ copied: string[]; checkpointId: string | null }> {
  if (!input.fromPaths.length) throw new AmpleFileCliError("usage", "Provide at least one --from <path> to add.");
  const toDir = normalizeConnectedFolderRelativePath(input.toDir ?? "");
  const sources: string[] = [];
  for (const raw of input.fromPaths) {
    const trimmed = raw.trim();
    if (!trimmed) throw new AmpleFileCliError("usage", "Source paths cannot be empty.");
    const source = isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
    const info = await lstat(source).catch(() => null);
    if (!info) throw new AmpleFileCliError("notFound", `Source not found: ${trimmed}.`);
    if (info.isSymbolicLink()) throw new AmpleFileCliError("usage", `Symbolic-link sources cannot be added: ${trimmed}.`);
    if (!info.isFile() && !info.isDirectory()) {
      throw new AmpleFileCliError("usage", `Only files and folders can be added: ${trimmed}.`);
    }
    if (pathContainsPath(connectedFolder.connectedFolderRoot, source)) {
      throw new AmpleFileCliError("usage", `Source is already inside this Connected Folder: ${trimmed}. Move it in Files instead.`);
    }
    if (pathContainsPath(source, connectedFolder.connectedFolderRoot)) {
      throw new AmpleFileCliError("usage", `Source contains this Connected Folder and cannot be copied into it: ${trimmed}.`);
    }
    sources.push(source);
  }
  const copied: string[] = [];
  try {
    await withConnectedFolderTouchBatch(async () => {
      for (const source of sources) copied.push(await copyPathIntoConnectedFolder(source, connectedFolder.connectedFolderRoot, toDir));
    });
  } catch (error) {
    // A mid-batch failure must not strand earlier copies without a restore
    // point: undo them best-effort, then surface the failure.
    await Promise.all(copied.map((path) =>
      rm(resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, path), { recursive: true, force: true }).catch(() => undefined)));
    throw error;
  }
  const safety = await checkpointAdditiveWritesOrUndo(connectedFolder.connectedFolderRoot, copied, {
    reason: "pre_add",
    label: `Before adding ${copied.length} item${copied.length === 1 ? "" : "s"}`,
  });
  return { copied, checkpointId: safety?.checkpointId ?? null };
}

export type AmpleFileDeleteRecovery =
  | { kind: "history" }
  | { kind: "recently-deleted"; entryId: string; restoreBy: string; uncovered: AmpleFileRecentlyDeletedUncoveredPath[] };

export interface AmpleFileDeleteResult {
  deleted: true;
  path: string;
  kind: "file" | "folder";
  safetyCheckpointId: string;
  recovery: AmpleFileDeleteRecovery;
}

/**
 * The one delete both the desktop route and `files delete` run
 * (docs/act-ledger.md). A delete never refuses for lack of
 * coverage: History keeps what it can, and when the restore point could not
 * cover every matched file the selected entry is *moved* into Recently
 * deleted instead of erased, so one delete keeps one undo reference.
 *
 * `.amplefile/`, `.work-fold/`, and `.pi/` remain invalid endpoints, and the
 * Connected Folder root still cannot be deleted: the path policy runs first, unchanged.
 */
export async function deleteConnectedFolderEntryWithRecovery(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  target: string,
  context: { receiptId: string | null },
): Promise<AmpleFileDeleteResult> {
  // Queue for the folder's History first, then reserve and check for
  // unsettled work, so a waiting delete holds nothing off and checks late.
  return withConnectedFolderHistoryOperation(connectedFolder.connectedFolderRoot, async () => {
    reserveCapabilityMutation(state, connectedFolder.id, "project", connectedFolder.id);
    try {
      return await runSettledConnectedFolderDeletion(state, connectedFolder.id, () => deleteSettledConnectedFolderEntryWithRecovery(state, connectedFolder, target, context));
    } finally {
      state.capabilityMutations.delete(connectedFolder.id);
    }
  });
}

async function deleteSettledConnectedFolderEntryWithRecovery(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  target: string,
  context: { receiptId: string | null },
): Promise<AmpleFileDeleteResult> {
  const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
    paths: [target],
    reason: "pre_delete",
    label: `Before deleting ${target}`,
  });
  return runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => applyConnectedFolderDelete(
    state,
    connectedFolder,
    target,
    safety.skippedFiles.map((file) => ({ path: file.path, reason: file.reason })),
    safety.checkpointId,
    context,
  ));
}

/**
 * One delete under a restore point already taken: erased when History kept a
 * copy of all of it, else moved whole into Recently deleted with the files
 * History could not keep. One row and each row of a several-row delete run it.
 */
export async function applyConnectedFolderDelete(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  target: string,
  uncovered: AmpleFileRecentlyDeletedUncoveredPath[],
  safetyCheckpointId: string,
  context: { receiptId: string | null },
): Promise<AmpleFileDeleteResult> {
  if (!uncovered.length) {
    const deleted = await deleteConnectedFolderEntry(connectedFolder.connectedFolderRoot, target);
    return { ...deleted, safetyCheckpointId, recovery: { kind: "history" as const } };
  }
  const entry = await resolveConnectedFolderDeleteTarget(connectedFolder.connectedFolderRoot, target);
  let trashed: AmpleFileRecentlyDeletedEntry;
  try {
    trashed = await state.recentlyDeleted.moveTreeToRecentlyDeleted({
      kind: entry.kind,
      reason: "files.delete",
      sourcePath: entry.absolutePath,
      connectedFolderId: connectedFolder.id,
      connectedFolderName: connectedFolder.name,
      originalPath: entry.path,
      receiptId: context.receiptId,
      uncovered,
    });
  } catch (error) {
    // An error naming an entry means a complete copy already landed in
    // Recently Deleted (across volumes) and only releasing the original
    // failed, possibly partway. The error says so and names the entry, so a
    // caller can list it with what it kept.
    if (error instanceof AmpleFileRecentlyDeletedError && error.entryId !== undefined) {
      const kept = await state.recentlyDeleted.get(error.entryId).catch(() => null);
      throw Object.assign(new AmpleFileCliError(
        "failure",
        `AmpleFile copied ${entry.path} into Recently Deleted but could not remove all of it from here: ${errorMessage(error.cause ?? error)}. The whole item is kept in Recently Deleted, and what could not be removed stays here.`,
        { cause: error },
      ), kept ? { recentlyDeleted: { entryId: kept.id, restoreBy: kept.restoreBy } } : {});
    }
    throw new AmpleFileCliError(
      "failure",
      `AmpleFile could not move ${entry.path} to Recently deleted: ${errorMessage(error).replace(/\.$/u, "")}. Nothing was deleted.`,
      { cause: error },
    );
  }
  await touchConnectedFolderRoot(connectedFolder.connectedFolderRoot).catch(() => undefined);
  return {
    deleted: true as const,
    path: entry.path,
    kind: entry.kind,
    safetyCheckpointId,
    recovery: { kind: "recently-deleted" as const, entryId: trashed.id, restoreBy: trashed.restoreBy, uncovered },
  };
}

export interface AmpleFileBatchDeleteResult {
  deleted: Array<AmpleFileDeleteResult & { receiptId: string }>;
  safetyCheckpointId: string;
  /** Set when a row failed after earlier rows were deleted; the restore point still covers every row. */
  failed?: { path: string; error: string };
  notDeleted?: string[];
}

/**
 * Several rows deleted under one History restore point. Each row
 * keeps what one delete has: the busy refusal and the shared active-work
 * reservation held through every effect, the same path checks, its own
 * receipt, and History or Recently deleted for whatever History cannot keep.
 *
 * Every row is checked before anything is deleted. If a row still fails
 * partway, the rows already deleted stay deleted, the rest are left alone, and
 * the one restore point, which covers every row, brings back what was
 * deleted. When the first row fails, nothing was deleted and the restore point
 * is discarded, exactly as for one row. A row inside another row is deleted
 * with it.
 */
export async function deleteConnectedFolderEntriesWithRecovery(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  targets: readonly string[],
): Promise<AmpleFileBatchDeleteResult> {
  // Queue for the folder's History first, then reserve and check for
  // unsettled work, so a waiting delete holds nothing off and checks late.
  return withConnectedFolderHistoryOperation(connectedFolder.connectedFolderRoot, async () => {
    reserveCapabilityMutation(state, connectedFolder.id, "project", connectedFolder.id);
    try {
      return await runSettledConnectedFolderDeletion(state, connectedFolder.id, () => deleteSettledConnectedFolderEntries(state, connectedFolder, targets));
    } finally {
      state.capabilityMutations.delete(connectedFolder.id);
    }
  });
}

async function deleteSettledConnectedFolderEntries(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  targets: readonly string[],
): Promise<AmpleFileBatchDeleteResult> {
  const root = connectedFolder.connectedFolderRoot;
  const paths = outermostConnectedFolderPaths(targets);
  return withConnectedFolderTouchBatch(async () => {
    if (!paths.length) throw badRequest("Select files or folders to delete.");
    const entries: Array<{ absolutePath: string; path: string; kind: "file" | "folder" }> = [];
    for (const path of paths) entries.push(await resolveConnectedFolderDeleteTarget(root, path));
    const safety = await createConnectedFolderMutationCheckpoint(root, {
      paths: entries.map((entry) => entry.path),
      reason: "pre_delete",
      label: entries.length === 1 ? `Before deleting ${entries[0]!.path}` : `Before deleting ${entries.length} items`,
    });
    // History names the files it could not keep the way it names its capture
    // roots; each one belongs to exactly one row.
    const historyRoot = ensureSafeConnectedFolderRoot(root);
    const capturedAs = entries.map((entry) => relative(historyRoot, entry.absolutePath).split(sep).join("/"));
    const uncovered = entries.map((): AmpleFileRecentlyDeletedUncoveredPath[] => []);
    for (const file of safety.skippedFiles) {
      const row = capturedAs.findIndex((path) => file.path === path || file.path.startsWith(`${path}/`));
      if (row < 0) {
        await discardConnectedFolderCheckpoint(root, safety.checkpointId).catch(() => undefined);
        throw new AmpleFileCliError("failure", `AmpleFile could not tell which item ${file.path} belongs to. Nothing was deleted.`);
      }
      uncovered[row]!.push({ path: file.path, reason: file.reason });
    }
    const deleted: AmpleFileBatchDeleteResult["deleted"] = [];
    for (const [index, entry] of entries.entries()) {
      try {
        const row = await runDesktopSettingsAct(state, "files.delete", async (requestId) => {
          const value = await applyConnectedFolderDelete(state, connectedFolder, entry.path, uncovered[index]!, safety.checkpointId, { receiptId: requestId });
          return {
            value,
            detail: value.recovery.kind === "recently-deleted"
              ? `Connected Folder ${connectedFolder.id}; trash ${value.recovery.entryId}`
              : `Connected Folder ${connectedFolder.id}; checkpoint ${value.safetyCheckpointId}`,
          };
        });
        deleted.push({ ...row.value, receiptId: row.requestId });
      } catch (error) {
        if (!deleted.length) {
          await discardConnectedFolderCheckpoint(root, safety.checkpointId).catch(() => undefined);
          throw error;
        }
        return {
          deleted,
          safetyCheckpointId: safety.checkpointId,
          failed: { path: entry.path, error: errorMessage(error) },
          notDeleted: entries.slice(index + 1).map((item) => item.path),
        };
      }
    }
    return { deleted, safetyCheckpointId: safety.checkpointId };
  });
}

export interface AmpleFileBatchMoveResult {
  moved: ConnectedFolderMovedEntry[];
  safetyCheckpointId: string;
  historySkippedPaths: string[];
  /** Set when an item failed after others had moved; the restore point then names exactly the moves that happened. */
  failed?: { path: string; error: string };
  notMoved?: string[];
}

/**
 * Several items moved into one folder under one History restore point.
 * Every item passes every check one move makes before any of
 * them moves, then each runs through `moveConnectedFolderEntry`, the move one item
 * takes. If one still fails partway, the items already moved stay moved, the
 * rest stay put, and the restore point is replaced by one that names exactly
 * the moves that happened, so restoring it undoes them. When the first item
 * fails, nothing moved and the restore point is discarded, as for one item.
 * An item inside another item moves with it.
 */
export async function moveConnectedFolderEntriesWithHistory(
  connectedFolder: ConnectedFolderSummary,
  sourcePaths: readonly string[],
  targetFolderPath: string,
): Promise<AmpleFileBatchMoveResult> {
  return withConnectedFolderTouchBatch(async () => {
    const root = connectedFolder.connectedFolderRoot;
    const sources = outermostConnectedFolderPaths(sourcePaths);
    if (!sources.length) throw badRequest("Select files or folders to move.");
    const plans = await checkConnectedFolderMoves(root, sources, targetFolderPath);
    const label = plans.length === 1 ? `Before moving ${plans[0]!.fromPath}` : `Before moving ${plans.length} items`;
    const safety = await createConnectedFolderMutationCheckpoint(root, {
      movesOnRestore: plans.map((plan) => ({ fromPath: plan.toPath, toPath: plan.fromPath })),
      reason: "pre_move",
      label,
    });
    const moved: ConnectedFolderMovedEntry[] = [];
    for (const [index, plan] of plans.entries()) {
      try {
        moved.push(await moveConnectedFolderEntry(root, { sourcePath: plan.fromPath, targetFolderPath }));
      } catch (error) {
        if (!moved.length) {
          await discardConnectedFolderCheckpoint(root, safety.checkpointId).catch(() => undefined);
          throw error;
        }
        const kept = await restorePointForMoves(root, moved, label, safety.checkpointId, error);
        return {
          moved,
          safetyCheckpointId: kept.checkpointId,
          historySkippedPaths: kept.skippedLargeFiles,
          failed: { path: plan.fromPath, error: errorMessage(error) },
          notMoved: plans.slice(index + 1).map((item) => item.fromPath),
        };
      }
    }
    return { moved, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles };
  });
}

/**
 * The restore point for a several-item move that stopped partway: it names
 * only the moves that happened, because History will not undo a move whose
 * item is not where the move put it. If that record cannot be written, the
 * moves are put back so nothing is left moved without a restore point.
 */
async function restorePointForMoves(
  root: string,
  moved: readonly ConnectedFolderMovedEntry[],
  label: string,
  plannedCheckpointId: string,
  cause: unknown,
): Promise<Awaited<ReturnType<typeof createConnectedFolderMutationCheckpoint>>> {
  try {
    const kept = await createConnectedFolderMutationCheckpoint(root, {
      movesOnRestore: moved.map((item) => ({ fromPath: item.path, toPath: item.fromPath })),
      reason: "pre_move",
      label,
    });
    await discardConnectedFolderCheckpoint(root, plannedCheckpointId).catch(() => undefined);
    return kept;
  } catch (recordError) {
    for (const item of [...moved].reverse()) {
      const parent = item.fromPath.includes("/") ? item.fromPath.slice(0, item.fromPath.lastIndexOf("/")) : "";
      await moveConnectedFolderEntry(root, { sourcePath: item.path, targetFolderPath: parent });
    }
    await discardConnectedFolderCheckpoint(root, plannedCheckpointId).catch(() => undefined);
    throw new AmpleFileCliError("failure", `${errorMessage(cause)} History could not record the moves (${errorMessage(recordError)}), so they were put back.`, { cause });
  }
}

export function pathContainsPath(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function normalizeConnectedFolderRelativePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "");
}
