/**
 * What keeps a change apart from running agent work: capability and Connected
 * Folder mutation reservations (`state.capabilityMutations`), the
 * settled-deletion check, and the History queue and safety wrappers around
 * restores and added files. A reservation refuses and never waits; a History
 * claim waits. Each function's order of History claim, reservation, blocker
 * check, and effect is its contract.
 */

import { rm } from "node:fs/promises";
import { isPiProjectMutationTrusted } from "../agent/pi-runtime-config.js";
import { isAmpleFileRequestSettled, type AmpleFileRequestRecord } from "../requests/request-records.js";
import { createConnectedFolderMutationCheckpoint, discardConnectedFolderCheckpoint, type ConnectedFolderCheckpoint } from "../history.js";
import { getConnectedFolder, resolveConnectedFolderPath, withConnectedFolderHistoryOperation } from "../connected-folder.js";
import { invalidateAllClients, invalidateAmpleFileClients } from "./conversation-clients.js";
import { publishControlHint } from "./event-streams.js";
import { badRequest, busyRefusal, errorMessage, forbidden, httpError } from "./http.js";
import type { LocalApiState } from "./state.js";

export type CapabilityScope = "global" | "project";
export const globalCapabilityMutationKey = "*";

/**
 * What a refusal for unsettled work says, in the words of the act refused.
 * The reasons and the refusal's shape (`busyRefusal`: 409 with the code
 * `busy`) belong to this module; an act that is not a capability change or a
 * deletion, such as Eject, supplies its own words for the same reasons.
 */
export interface SettledWorkWording {
  /** Another change has this Connected Folder, or every one, reserved. */
  changing: string;
  /** A Worker turn or Chat compaction is running there. */
  working: string;
  /** A request there is running, waiting on an answer, or draining after Stop. */
  outstanding: string;
  /** A background job or Automation run may be writing there; the kernel's reason. */
  blocked(blocker: string): string;
}

/** The words a capability change and a deletion refuse in. */
const defaultWording: SettledWorkWording = {
  changing: "Wait for the current capability change to finish.",
  working: "Wait for affected agent work to finish before changing capabilities.",
  outstanding: "Finish or stop this Connected Folder's outstanding work before deleting.",
  blocked: (blocker) => blocker,
};

/**
 * A restore queues for its Connected Folder's History turn first and only
 * then reserves the folder and checks for running work, so a waiting restore
 * neither holds new turns, instruction saves, or deletions off nor acts on a
 * stale check. The inner restore joins the same History turn (reentrant).
 */
export async function runHistoryRestore<T>(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  operation: () => Promise<T>,
): Promise<T> {
  const connectedFolderId = connectedFolder.id;
  return withConnectedFolderHistoryOperation(connectedFolder.connectedFolderRoot, async () => {
    reserveCapabilityMutation(state, connectedFolderId, "project", connectedFolderId);
    try {
      const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(connectedFolderId);
      if (blockers.length) throw busyRefusal(blockers[0]!);
      await getConnectedFolder(connectedFolderId);
      return await operation();
    } finally { state.capabilityMutations.delete(connectedFolderId); }
  });
}

/** Stop is not settled until its accepted turns have actually drained. */
export function requestHasUnsettledWork(state: LocalApiState, request: AmpleFileRequestRecord): boolean {
  return [request, ...state.requests.subtree(request.requestId)].some((record) => !isAmpleFileRequestSettled(record));
}

/**
 * Called with the Connected Folder's mutation fence held: refuses, never
 * waits, while a request there is unsettled (running, waiting on an answer,
 * or draining after Stop) or a background job or Automation run may be
 * writing there (AGENTS.md, "Settled deletion").
 */
async function assertConnectedFolderSettled(state: LocalApiState, connectedFolderId: string, wording: SettledWorkWording): Promise<void> {
  assertNoUnsettledRequest(state, connectedFolderId, wording);
  const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(connectedFolderId);
  if (blockers.length) throw busyRefusal(wording.blocked(blockers[0]!));
  assertNoUnsettledRequest(state, connectedFolderId, wording);
}

function assertNoUnsettledRequest(state: LocalApiState, connectedFolderId: string, wording: SettledWorkWording): void {
  if (state.requests.list({ connectedFolderId }).some((request) => requestHasUnsettledWork(state, request))) {
    throw busyRefusal(wording.outstanding);
  }
}

/** Called with the Connected Folder's mutation fence held; deletion refuses instead of interrupting work. */
export async function runSettledConnectedFolderDeletion<T>(state: LocalApiState, connectedFolderId: string, operation: () => Promise<T>): Promise<T> {
  await assertConnectedFolderSettled(state, connectedFolderId, defaultWording);
  await getConnectedFolder(connectedFolderId);
  assertNoUnsettledRequest(state, connectedFolderId, defaultWording);
  return operation();
}

/**
 * One act that takes several Connected Folders out from under their work at
 * once (Eject takes every one on the drives that leave): each is reserved as
 * a deletion reserves it, then each must be settled as a deletion requires,
 * then the act runs, and every reservation is released when it ends. A
 * refusal is the deletion's, for the same reasons and with the same `busy`
 * code, in the act's words for that Connected Folder. The act asks nothing of
 * the folders themselves, so none is read here: a drive that is leaving may be
 * slow to answer, or no longer hold the folder.
 */
export async function runWithSettledConnectedFolders<T>(
  state: LocalApiState,
  connectedFolders: ReadonlyArray<{ id: string; wording: SettledWorkWording }>,
  operation: () => Promise<T>,
): Promise<T> {
  const reserved: string[] = [];
  try {
    for (const { id, wording } of connectedFolders) {
      reserveCapabilityMutation(state, id, "project", id, wording);
      reserved.push(id);
    }
    for (const { id, wording } of connectedFolders) await assertConnectedFolderSettled(state, id, wording);
    return await operation();
  } finally {
    for (const id of reserved) state.capabilityMutations.delete(id);
  }
}

export async function runCapabilityMutation<T>(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  scope: CapabilityScope,
  operation: () => Promise<T>,
  options: { requireProjectTrust?: boolean; preserveClients?: boolean } = {},
): Promise<T> {
  const key = scope === "global" ? globalCapabilityMutationKey : connectedFolder.id;
  reserveCapabilityMutation(state, connectedFolder.id, scope, key);
  try {
    if (
      scope === "project"
      && options.requireProjectTrust !== false
      && !await isPiProjectMutationTrusted(connectedFolder.connectedFolderRoot, state.runtimeProvider)
    ) {
      throw forbidden("Trust this Connected Folder before changing Connected Folder–scoped capabilities.");
    }
    const result = await operation();
    if (!options.preserveClients) {
      if (scope === "global") await invalidateAllClients(state);
      else await invalidateAmpleFileClients(state, connectedFolder.id);
    }
    publishControlHint(state, "models");
    return result;
  } finally {
    state.capabilityMutations.delete(key);
  }
}

export async function runConnectedFolderMutation<T>(
  state: LocalApiState,
  connectedFolderId: string,
  operation: () => Promise<T>,
): Promise<T> {
  reserveCapabilityMutation(state, connectedFolderId, "project", connectedFolderId);
  try {
    await revalidateMutatedConnectedFolder(state, connectedFolderId);
    const result = await operation();
    await invalidateAmpleFileClients(state, connectedFolderId);
    return result;
  } finally {
    state.capabilityMutations.delete(connectedFolderId);
  }
}

export async function runConnectedFolderMutations<T>(
  state: LocalApiState,
  connectedFolderIds: readonly string[],
  operation: () => Promise<T>,
  options: { requiredConnectedFolderIds?: readonly string[] } = {},
): Promise<T> {
  const ids = [...new Set(connectedFolderIds)].sort();
  if (ids.length === 0) throw badRequest("A Connected Folder is required for this change.");
  const requiredConnectedFolderIds = [...new Set(options.requiredConnectedFolderIds ?? ids)].sort();
  if (requiredConnectedFolderIds.length === 0 || requiredConnectedFolderIds.some((connectedFolderId) => !ids.includes(connectedFolderId))) {
    throw new Error("Connected Folder mutation validation must name one or more reserved Connected Folders.");
  }
  if (state.capabilityMutations.has(globalCapabilityMutationKey)
    || ids.some((connectedFolderId) => state.capabilityMutations.has(connectedFolderId))) {
    throw busyRefusal("Wait for the current capability change to finish.");
  }
  if (ids.some((connectedFolderId) => hasActiveCapabilityWorkForConnectedFolder(state, connectedFolderId))) {
    throw httpError(409, "Wait for affected work to finish before changing capabilities.");
  }
  for (const connectedFolderId of ids) state.capabilityMutations.add(connectedFolderId);
  try {
    for (const connectedFolderId of requiredConnectedFolderIds) {
      await revalidateMutatedConnectedFolder(state, connectedFolderId);
    }
    const result = await operation();
    await Promise.all(ids.map((connectedFolderId) => invalidateAmpleFileClients(state, connectedFolderId)));
    return result;
  } finally {
    for (const connectedFolderId of ids) state.capabilityMutations.delete(connectedFolderId);
  }
}

async function revalidateMutatedConnectedFolder(state: LocalApiState, connectedFolderId: string): Promise<void> {
  await state.beforeConnectedFolderMutationRevalidation?.(connectedFolderId);
  await getConnectedFolder(connectedFolderId);
}

export function reserveCapabilityMutation(
  state: LocalApiState,
  connectedFolderId: string,
  scope: CapabilityScope,
  key: string,
  wording: Pick<SettledWorkWording, "changing" | "working"> = defaultWording,
): void {
  const mutationConflict = scope === "global"
    ? state.capabilityMutations.size > 0
    : state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(connectedFolderId);
  if (mutationConflict) throw busyRefusal(wording.changing);

  const runningConflict = scope === "global"
    ? state.runningTurns.size > 0 || state.compactingConversations.size > 0
    : hasActiveCapabilityWorkForConnectedFolder(state, connectedFolderId);
  if (runningConflict) throw busyRefusal(wording.working);
  state.capabilityMutations.add(key);
}

export function assertNoCapabilityMutationForTurn(state: LocalApiState, connectedFolderId: string): void {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(connectedFolderId)) {
    throw httpError(409, "Wait for the current capability change to finish before starting a turn.");
  }
}

function hasActiveCapabilityWorkForConnectedFolder(state: LocalApiState, connectedFolderId: string, exceptTurnKey?: string): boolean {
  const prefix = `${connectedFolderId}:`;
  return [...state.runningTurns, ...state.compactingConversations].some((key) => key.startsWith(prefix) && key !== exceptTurnKey);
}

export async function runWithHistorySafety<T>(connectedFolderRoot: string, checkpointId: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await discardConnectedFolderCheckpoint(connectedFolderRoot, checkpointId).catch(() => undefined);
    throw error;
  }
}

/**
 * Uploads and copy-ins only add files, so restoring to the pre-mutation state
 * means deleting exactly the written paths. The checkpoint is created after
 * the write so deleteOnRestore can name collision-renamed destinations
 * instead of intended paths that may belong to pre-existing files. Placement
 * and its restore record succeed or fail together: when the checkpoint cannot
 * be recorded, the written paths are removed again and the operation fails.
 */
export async function checkpointAdditiveWritesOrUndo(
  connectedFolderRoot: string,
  writtenPaths: string[],
  options: { reason: string; label: string },
): Promise<ConnectedFolderCheckpoint | null> {
  if (!writtenPaths.length) return null;
  try {
    return await createConnectedFolderMutationCheckpoint(connectedFolderRoot, { deleteOnRestore: writtenPaths, ...options });
  } catch (error) {
    await Promise.all(writtenPaths.map((path) =>
      rm(resolveConnectedFolderPath(connectedFolderRoot, path), { recursive: true, force: true }).catch(() => undefined)));
    throw httpError(500, `The added files were removed because Connected Folder could not record a restore point: ${errorMessage(error)}`);
  }
}
