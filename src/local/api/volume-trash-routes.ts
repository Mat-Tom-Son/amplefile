/**
 * Drives and the system Trash for the file manager window
 * (docs/architecture.md, "Drives and the system Trash"): the drives a system
 * file manager shows and when that list changes, the space on the volume
 * holding a place's folder, Eject, and the system Trash with Put Back, Delete
 * Immediately, and Empty Trash. The last two are irreversible and sit behind
 * the window's confirmation.
 *
 * The window names a drive or a Trash item only by the opaque id a listing
 * gave; the host finds it again and decides everything else.
 */

import { homedir } from "node:os";
import { dirname, relative, sep } from "node:path";

import { createLocalEventSink } from "../local-event-stream.js";
import {
  getConnectedFolder,
  listConnectedFolders,
  resolveConnectedFolderPath,
  withConnectedFolderHistoryOperation,
  withConnectedFolderHistoryOperations,
} from "../connected-folder.js";
import { createConnectedFolderMutationCheckpoint } from "../history.js";
import { resolveFolderLocation, type FolderLocation } from "../folder-locations.js";
import { accessError as standardFolderAccessError, isStandardFolderId, resolveStandardFolderPath } from "../standard-folders.js";
import {
  deleteTrashItemsImmediately,
  emptySystemTrash,
  findTrashItem,
  listSystemTrash,
  systemTrashPlatform,
  performPutBack,
  planPutBack,
  readTrashRecord,
  returnToTrash,
  TrashError,
  type PutBackResult,
} from "../system-trash.js";
import {
  ejectVolume,
  listVolumeRecords,
  listVolumes,
  noteVolumesMayHaveChanged,
  subscribeVolumes,
  volumeHolds,
  volumeSpaceForPath,
  type VolumeRecord,
} from "../volumes.js";
import { parseFileOperationId, runFileOperation } from "../file-operations.js";
import { badRequest, errorMessage, httpError, notFound, readJsonBody, sendJson } from "./http.js";
import { requestHasUnsettledWork } from "./reservations.js";
import type { LocalApiRequest, LocalApiState } from "./state.js";

export async function handleVolumeAndTrashRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // The drives a system file manager shows; the startup disk is the computer place, not one of them.
  if (method === "GET" && url.pathname === "/api/volumes") {
    sendJson(res, { volumes: await listVolumes() });
    return true;
  }
  // The list again whenever a drive appears, goes, or is renamed. The first event is the current list.
  if (method === "GET" && url.pathname === "/api/volumes/events") {
    if (state.localEventStreams.size >= 64) throw httpError(429, "Too many local event connections.");
    const sink = createLocalEventSink(res);
    state.localEventStreams.add(sink);
    const stop = subscribeVolumes((event) => { sink.send(event); });
    const heartbeat = setInterval(() => sink.heartbeat(), 15_000);
    heartbeat.unref();
    sink.onClose(() => { clearInterval(heartbeat); stop(); state.localEventStreams.delete(sink); });
    return true;
  }
  // Total and free space on the volume holding a place's folder, for the window's status line.
  if (method === "GET" && url.pathname === "/api/volume-space") {
    const path = await placePath(url.searchParams.get("placeKind"), url.searchParams.get("placeId"), url.searchParams.get("path") ?? "");
    const space = await volumeSpaceForPath(path);
    if (!space) throw notFound("AmpleFile can’t measure the space there.");
    sendJson(res, space);
    return true;
  }
  if (method === "POST" && url.pathname === "/api/volumes/eject") {
    const body = await readJsonBody<{ volumeId?: unknown }>(state, req);
    if (typeof body.volumeId !== "string" || !body.volumeId) throw badRequest("Choose a drive to eject.");
    sendJson(res, await ejectListedVolume(state, body.volumeId));
    return true;
  }
  // What the system Trash holds; Put Back where the system's records allow it.
  if (method === "GET" && url.pathname === "/api/trash") {
    sendJson(res, await listSystemTrash());
    return true;
  }
  if (method === "POST" && url.pathname === "/api/trash/put-back") {
    const body = await readJsonBody<{ itemId?: unknown }>(state, req);
    if (typeof body.itemId !== "string" || !body.itemId) throw badRequest("Choose an item to put back.");
    sendJson(res, await putBackTrashItem(body.itemId));
    return true;
  }
  // Irreversible: the window asks first. Delete Immediately acts only on ids a listing minted.
  // An optional `operationId` reports progress as a "delete" file operation and makes it stoppable
  // between items (src/local/file-operations.ts); a stopped deletion answers `cancelled` and `notDone`.
  if (method === "POST" && url.pathname === "/api/trash/delete") {
    const body = await readJsonBody<{ itemIds?: unknown; operationId?: unknown }>(state, req);
    const ids = body.itemIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 10_000 || ids.some((id) => typeof id !== "string" || !id || id.length > 64)) {
      throw badRequest("Choose items to delete.");
    }
    sendJson(res, await runFileOperation(parseFileOperationId(body.operationId), "delete", (operation) => deleteTrashItemsImmediately(ids as string[], {}, operation), deletionOutcome));
    return true;
  }
  if (method === "POST" && url.pathname === "/api/trash/empty") {
    const body = await readJsonBody<{ operationId?: unknown } | null>(state, req);
    sendJson(res, await runFileOperation(parseFileOperationId(body?.operationId), "delete", (operation) => emptySystemTrash({}, operation), deletionOutcome));
    return true;
  }
  return false;
}

/** A place's folder on disk, by the window's place reference, under each place's own path policy. */
async function placePath(kind: string | null, id: string | null, path: string): Promise<string> {
  if (!id) throw badRequest("Choose a place.");
  if (kind === "connected-folder") {
    const connectedFolder = await getConnectedFolder(id);
    return resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, path);
  }
  if (kind === "standard") {
    if (!isStandardFolderId(id)) throw notFound("That folder isn’t in the sidebar anymore.");
    try {
      return resolveStandardFolderPath(id, path);
    } catch (error) {
      throw standardFolderAccessError(error, id);
    }
  }
  throw badRequest("Choose a place.");
}

/**
 * Ejects a drive the listing marks ejectable. A drive holding a registered
 * Connected Folder is ejected only when that Connected Folder's work is
 * settled, as a deletion requires (AGENTS.md, "Settled deletion"): no running
 * turn or compaction, no request still running, waiting on an answer, or
 * draining after Stop, and no background job or Automation run writing
 * there. Each such Connected Folder's History is held and the folder reserved
 * through the eject, so no turn starts meanwhile.
 */
async function ejectListedVolume(state: LocalApiState, volumeId: string): Promise<{ volumeId: string; ejected: true }> {
  const volume = (await listVolumeRecords()).find((candidate) => candidate.id === volumeId);
  if (!volume) throw notFound("That drive isn’t connected anymore.");
  if (!volume.ejectable) throw httpError(409, `“${volume.name}” can’t be ejected from AmpleFile.`);
  const held = (await listConnectedFolders()).filter((connectedFolder) => volumeHolds(volume, connectedFolder.connectedFolderRoot));
  await withConnectedFolderHistoryOperations(held.map((connectedFolder) => connectedFolder.connectedFolderRoot), async () => {
    const reserved: string[] = [];
    try {
      for (const connectedFolder of held) {
        reserveForEject(state, connectedFolder, volume);
        reserved.push(connectedFolder.id);
      }
      for (const connectedFolder of held) await assertSettledForEject(state, connectedFolder, volume);
      await ejectVolume(volume);
    } finally {
      for (const id of reserved) state.capabilityMutations.delete(id);
    }
  });
  noteVolumesMayHaveChanged();
  return { volumeId, ejected: true };
}

/** The shared Connected Folder reservation (src/local/api/reservations.ts), refused in eject's words. */
function reserveForEject(state: LocalApiState, connectedFolder: { id: string; name: string }, volume: VolumeRecord): void {
  if (state.capabilityMutations.has("*") || state.capabilityMutations.has(connectedFolder.id)) {
    throw httpError(409, `Wait for the current change to ${connectedFolder.name} to finish before ejecting “${volume.name}”.`);
  }
  const prefix = `${connectedFolder.id}:`;
  if ([...state.runningTurns, ...state.compactingConversations].some((key) => key.startsWith(prefix))) {
    throw httpError(409, `${connectedFolder.name}’s Worker is working. Wait for it to finish, or stop it, before ejecting “${volume.name}”.`);
  }
  state.capabilityMutations.add(connectedFolder.id);
}

async function assertSettledForEject(state: LocalApiState, connectedFolder: { id: string; name: string }, volume: VolumeRecord): Promise<void> {
  if (state.requests.list({ connectedFolderId: connectedFolder.id }).some((request) => requestHasUnsettledWork(state, request))) {
    throw httpError(409, `Finish or stop ${connectedFolder.name}’s outstanding work before ejecting “${volume.name}”.`);
  }
  const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(connectedFolder.id);
  if (blockers.length) throw httpError(409, blockers[0]!);
}

export interface PutBackResponse extends PutBackResult {
  /** Where the window shows it: its folder, with it selected. Null when no place can show it. */
  location: FolderLocation | null;
  /** The History restore point when it went back into a Connected Folder. */
  restorePoint: { connectedFolderId: string; checkpointId: string } | null;
}

/**
 * Put Back: the item returns to where it was, never replacing anything (a
 * taken name gets Finder's " copy"). Into a registered Connected Folder it
 * goes through that Connected Folder's History, as any file added there does:
 * the folder's History is held, and a restore point recorded after the item is
 * in place removes it again on restore. If that restore point cannot be
 * recorded, the item returns to the Trash.
 */
async function putBackTrashItem(itemId: string): Promise<PutBackResponse> {
  const item = await findTrashItem(itemId);
  if (!item) {
    if (systemTrashPlatform() === "darwin") throw httpError(409, "Put items back from the Trash in Finder. AmpleFile can’t read where macOS recorded they came from.");
    throw notFound("That item isn’t in the Trash anymore.");
  }
  const plan = await planPutBack(item, await listConnectedFolders());
  let result: PutBackResult;
  let restorePoint: PutBackResponse["restorePoint"] = null;
  if (!plan.connectedFolder) {
    result = await performPutBack(item, plan);
  } else {
    const connectedFolder = plan.connectedFolder;
    result = await withConnectedFolderHistoryOperation(connectedFolder.connectedFolderRoot, async () => {
      const registered = await getConnectedFolder(connectedFolder.id);
      if (registered.connectedFolderRoot !== connectedFolder.connectedFolderRoot) throw httpError(409, "That Connected Folder moved. Try again.");
      // The Connected Folder's path policy, for the folder that exists: no links, no hidden AmpleFile or Pi data.
      const existingParent = plan.missingFolders[0] ? dirname(plan.missingFolders[0]) : plan.parent;
      resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, insideConnectedFolder(connectedFolder.connectedFolderRoot, existingParent));
      const record = await readTrashRecord(item);
      const placed = await performPutBack(item, plan);
      const written = insideConnectedFolder(connectedFolder.connectedFolderRoot, plan.missingFolders[0] ?? placed.path);
      try {
        const checkpoint = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
          deleteOnRestore: [written],
          reason: "pre_put_back",
          label: `Before putting back ${placed.name}`,
        });
        restorePoint = { connectedFolderId: connectedFolder.id, checkpointId: checkpoint.checkpointId };
      } catch (error) {
        const returned = record !== null && await returnToTrash(item, placed, record).catch(() => false);
        throw new TrashError(500, returned
          ? `“${placed.name}” stayed in the Trash because ${connectedFolder.name} couldn’t record a restore point: ${errorMessage(error)}`
          : `“${placed.name}” is back, but ${connectedFolder.name} couldn’t record a restore point for it: ${errorMessage(error)}`);
      }
      return placed;
    });
  }
  const location = await resolveFolderLocation(result.path, await listConnectedFolders(), homedir(), { reveal: true }).catch(() => null);
  return { ...result, location, restorePoint };
}

function insideConnectedFolder(root: string, path: string): string {
  return relative(root, path).split(sep).filter(Boolean).join("/");
}

function deletionOutcome(result: { cancelled?: true }): "succeeded" | "cancelled" {
  return result.cancelled ? "cancelled" : "succeeded";
}
