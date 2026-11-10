/**
 * The file manager's places beyond one Connected Folder
 * (docs/product-model.md, "The file manager window"): Standard Folders,
 * transfers between places including the move between Connected Folders,
 * Compress, Recents, and Go to Folder. This module owns the list of open local
 * APIs that a paste run in the desktop's main process uses.
 */

import { createLocalEventSink } from "../local-event-stream.js";
import {
  assertStandardFolderPathUnowned,
  createStandardFolderFolder,
  isStandardFolderId,
  listStandardFolders,
  removeSidebarFolder,
  renameStandardFolderEntry,
  resolveStandardFolderPath,
  scanStandardFolder,
  standardFolderEntryInfo,
  standardFolderRegistrationTarget,
  standardFolderRoot,
  type StandardFolderId,
} from "../standard-folders.js";
import { goToFolder } from "../go-to-folder.js";
import { compressInto, copyHoldsAll, copyInto, isInside, moveInto, relativeTo, removeIdentityFoldersKeptAt } from "../file-transfer.js";
import { homedir as userHomedir } from "node:os";
import { lstat, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createConnectedFolderMutationCheckpoint, discardConnectedFolderCheckpoint, type ConnectedFolderCheckpoint } from "../history.js";
import type { AmpleFileRecentlyDeletedUncoveredPath } from "../recently-deleted-store.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import {
  ensureSafeConnectedFolderRoot,
  getConnectedFolder,
  listConnectedFolders,
  outermostConnectedFolderPaths,
  resolveConnectedFolderDeleteTarget,
  resolveConnectedFolderPath,
  scanConnectedFolderTree,
  nestedRegisteredConnectedFolderPaths,
  withConnectedFolderHistoryOperations,
  withConnectedFolderTouchBatch,
  type TreeEntry,
  type ConnectedFolderSummary,
} from "../connected-folder.js";
import { registerConnectedFolderInternal, runDesktopSettingsAct } from "../server.js";
import { openStandardFolderFileStream } from "./event-streams.js";
import { applyConnectedFolderDelete, moveConnectedFolderEntriesWithHistory, normalizeConnectedFolderRelativePath } from "./file-changes.js";
import { sendConnectedFolderRawFile } from "./file-routes.js";
import { badRequest, errorMessage, httpError, match, notFound, readJsonBody, sendJson, unavailable } from "./http.js";
import {
  checkpointAdditiveWritesOrUndo,
  requestHasUnsettledWork,
  reserveCapabilityMutation,
  runSettledConnectedFolderDeletion,
} from "./reservations.js";
import type { LocalApiRequest, LocalApiState } from "./state.js";

/** The file manager's places beyond one Connected Folder: Standard Folders, transfers between places, Compress, Recents, and Go to Folder. */
export async function handlePlaceRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // Standard Folders (docs/product-model.md, "The file manager window"):
  // Desktop, Documents, and Downloads for the file manager's sidebar. The host
  // resolves each from the home folder; nothing here writes `.amplefile/` data.
  if (method === "GET" && url.pathname === "/api/standard-folders") {
    sendJson(res, { folders: await listStandardFolders(await listConnectedFolders()) });
    return true;
  }
  // Copy, paste, duplicate, and move across the file manager's places.
  if (method === "POST" && url.pathname === "/api/file-transfer") {
    const body = await readJsonBody<{ mode?: unknown; sources?: unknown; target?: unknown }>(state, req);
    sendJson(res, await transferFileEntries(body, state));
    return true;
  }
  // Compress: one item becomes "name.zip" beside it, several become "Archive.zip".
  if (method === "POST" && url.pathname === "/api/file-transfer/compress") {
    const body = await readJsonBody<{ place?: unknown; paths?: unknown }>(state, req);
    sendJson(res, await compressEntries(body), 201);
    return true;
  }
  // Recents: what changed lately across the Connected Folders and the top of Desktop, Documents, and Downloads.
  if (method === "GET" && url.pathname === "/api/recents") {
    sendJson(res, { recents: await recentFiles(await listConnectedFolders()) });
    return true;
  }
  // Go to Folder (⇧⌘G): a typed path opens the Connected Folder or Standard Folder holding it, with completions.
  if (method === "GET" && url.pathname === "/api/go-to-folder") {
    sendJson(res, await goToFolder(url.searchParams.get("path") ?? "", await listConnectedFolders()));
    return true;
  }
  // Remove from Sidebar: a folder the person added with + leaves the list; the folder stays as it is.
  const sidebarFolderMatch = match(url.pathname, /^\/api\/standard-folders\/(added-[0-9a-f]{16})$/);
  if (method === "DELETE" && sidebarFolderMatch) {
    removeSidebarFolder(sidebarFolderMatch[1]);
    sendJson(res, { removed: true });
    return true;
  }
  const standardFolderMatch = match(url.pathname, /^\/api\/standard-folders\/([^/]+)\/(tree|file-info|raw-file|events|rename-local-entry|folders|connected-folders)$/);
  if (standardFolderMatch) {
    const standardFolderId = standardFolderMatch[1];
    if (!isStandardFolderId(standardFolderId)) throw notFound("That standard folder isn’t on this computer.");
    const route = standardFolderMatch[2];
    const path = url.searchParams.get("path") ?? "";
    if (method === "GET" && route === "tree") {
      sendJson(res, await scanStandardFolder(standardFolderId, path));
      return true;
    }
    if (method === "GET" && route === "file-info") {
      if (!path) throw badRequest("A path inside the folder is required.");
      sendJson(res, await standardFolderEntryInfo(standardFolderId, path));
      return true;
    }
    if (method === "GET" && route === "raw-file") {
      if (!path) throw badRequest("File path is required.");
      await sendConnectedFolderRawFile(res, standardFolderRoot(standardFolderId), path);
      return true;
    }
    if (method === "GET" && route === "events") {
      await openStandardFolderFileStream(state, createLocalEventSink(res), standardFolderId, path);
      return true;
    }
    if (method === "POST" && route === "rename-local-entry") {
      const body = await readJsonBody<{ path?: unknown; newName?: unknown }>(state, req);
      if (typeof body.path !== "string" || typeof body.newName !== "string") throw badRequest("An item and a new name are required.");
      sendJson(res, await renameStandardFolderEntry(standardFolderId, body.path, body.newName));
      return true;
    }
    if (method === "POST" && route === "folders") {
      const body = await readJsonBody<{ parentPath?: unknown; name?: unknown }>(state, req);
      if (typeof body.name !== "string") throw badRequest("Enter a name.");
      if (body.parentPath !== undefined && typeof body.parentPath !== "string") throw badRequest("Choose where the folder goes.");
      sendJson(res, await createStandardFolderFolder(standardFolderId, body.parentPath ?? "", body.name), 201);
      return true;
    }
    // "Connect This Folder": the click is the registration act, as choosing
    // a folder in the picker is; the host resolved the standard folder itself.
    if (method === "POST" && route === "connected-folders") {
      const body = await readJsonBody<{ path?: unknown }>(state, req);
      if (body.path !== undefined && typeof body.path !== "string") throw badRequest("Choose a folder.");
      const target = await standardFolderRegistrationTarget(standardFolderId, body.path ?? "");
      const connectedFolder = await registerConnectedFolderInternal(state, target);
      sendJson(res, { connectedFolder }, 201);
      return true;
    }
  }
  return false;
}

type TransferPlaceRef = { kind: "connected-folder" | "standard"; id: string };

/**
 * The running local APIs, newest last. The desktop's paste runs
 * `transferFileEntries` in the main process without a request; a move between
 * Connected Folders needs the API's request graph and Recently Deleted, so it
 * uses the open API's.
 */
const openLocalApiStates: LocalApiState[] = [];

/** Records a started local API as the newest open one. */
export function rememberOpenLocalApi(state: LocalApiState): void {
  openLocalApiStates.push(state);
}

/** Forgets a local API that is closing. */
export function forgetOpenLocalApi(state: LocalApiState): void {
  const open = openLocalApiStates.indexOf(state);
  if (open >= 0) openLocalApiStates.splice(open, 1);
}

type TransferRestorePoint = { connectedFolderId: string; checkpointId: string };

interface ResolvedTransferItem {
  abs: string;
  place: TransferPlaceRef | null;
  connectedFolder: ConnectedFolderSummary | null;
  relativePath: string;
}

function transferPlace(value: unknown): TransferPlaceRef {
  const record = value as { kind?: unknown; id?: unknown } | null;
  if (!record || (record.kind !== "connected-folder" && record.kind !== "standard") || typeof record.id !== "string" || !record.id) throw badRequest("Choose where the items are.");
  return { kind: record.kind, id: record.id };
}

async function resolveTransferItem(place: TransferPlaceRef, path: string, purpose: "read" | "change" | "target"): Promise<ResolvedTransferItem> {
  if (place.kind === "connected-folder") {
    const connectedFolder = await getConnectedFolder(place.id);
    return { abs: resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, path), place, connectedFolder, relativePath: normalizeConnectedFolderRelativePath(path) };
  }
  if (!isStandardFolderId(place.id)) throw notFound("That folder isn’t in the sidebar anymore.");
  const abs = purpose === "read"
    ? resolveStandardFolderPath(place.id, path)
    : await assertStandardFolderPathUnowned(place.id, path, userHomedir(), { allowContaining: purpose === "target" });
  return { abs, place, connectedFolder: null, relativePath: normalizeConnectedFolderRelativePath(path) };
}

/**
 * Copy (and Duplicate) adds to the target and keeps a restore point there; a
 * move inside one Connected Folder is History's own move; a move between two
 * Connected Folders keeps a restore point on each side; a move inside one Standard
 * Folder is a plain move, as Finder's. Any other move copies, leaving the
 * original where it is, and says so. Items from outside the places (a Finder
 * paste or drop) can only be copied in.
 */
export async function transferFileEntries(
  body: { mode?: unknown; sources?: unknown; target?: unknown },
  state: LocalApiState | undefined = openLocalApiStates.at(-1),
) {
  const mode = body.mode === "move" || body.mode === "duplicate" ? body.mode : body.mode === "copy" ? "copy" : null;
  if (!mode) throw badRequest("Choose copy, duplicate, or move.");
  if (!Array.isArray(body.sources) || !body.sources.length || body.sources.length > 5_000) throw badRequest("Choose items to copy or move.");
  const targetRecord = body.target as { place?: unknown; path?: unknown } | null;
  const target = await resolveTransferItem(transferPlace(targetRecord?.place), typeof targetRecord?.path === "string" ? targetRecord.path : "", "target");
  const targetInfo = await stat(target.abs).catch(() => null);
  if (!targetInfo?.isDirectory()) throw badRequest("Choose a folder to put them in.");

  const sources: ResolvedTransferItem[] = [];
  for (const raw of body.sources as unknown[]) {
    const record = raw as { nativePath?: unknown; place?: unknown; path?: unknown } | null;
    if (typeof record?.nativePath === "string") {
      if (mode === "move") throw badRequest("Items from Finder are copied in, not moved.");
      const abs = resolve(record.nativePath);
      if (!(await lstat(abs).catch(() => null))) throw badRequest(`“${basename(abs)}” isn’t there anymore.`);
      sources.push({ abs, place: null, connectedFolder: null, relativePath: "" });
      continue;
    }
    if (typeof record?.path !== "string" || !record.path.trim()) throw badRequest("Choose items to copy or move.");
    sources.push(await resolveTransferItem(transferPlace(record.place), record.path, mode === "move" ? "change" : "read"));
  }
  for (const source of sources) {
    if (isInside(source.abs, target.abs)) throw badRequest(`“${basename(source.abs)}” can’t go inside itself.`);
  }

  const sameConnectedFolder = (item: ResolvedTransferItem) => Boolean(item.connectedFolder && target.connectedFolder && item.connectedFolder.id === target.connectedFolder.id);
  const placeKey = (item: ResolvedTransferItem) => item.place ? `${item.place.kind}:${item.place.id}` : "";

  if (mode === "move" && sources.every(sameConnectedFolder)) {
    const moved = await moveConnectedFolderEntriesWithHistory(target.connectedFolder!, sources.map((item) => item.relativePath), target.relativePath);
    return {
      mode,
      written: moved.moved.map((item) => item.path),
      restorePoints: [{ connectedFolderId: target.connectedFolder!.id, checkpointId: moved.safetyCheckpointId }],
      ...(moved.failed ? { failed: moved.failed } : {}),
    };
  }
  if (mode === "move" && target.place?.kind === "standard" && sources.every((item) => placeKey(item) === placeKey(target))) {
    const moves: Array<{ from: string; to: string }> = [];
    for (const source of sources) {
      const destination = await moveInto(source.abs, target.abs);
      moves.push({ from: source.relativePath, to: relativeTo(standardFolderRoot(target.place.id as StandardFolderId), destination) });
    }
    return { mode, written: moves.map((item) => item.to), moves, restorePoints: [] };
  }
  const sourceConnectedFolder = sources[0]?.connectedFolder ?? null;
  const crossConnectedFolderMove = mode === "move" && Boolean(target.connectedFolder) && Boolean(sourceConnectedFolder)
    && sources.every((item) => item.connectedFolder?.id === sourceConnectedFolder!.id);
  if (crossConnectedFolderMove) {
    if (!state) throw unavailable("AmpleFile isn’t ready to move items between Connected Folders yet.");
    return moveBetweenConnectedFolders(state, sourceConnectedFolder!, sources, target);
  }
  const copiedInstead = mode === "move";
  const label = (verb: string) => `Before ${verb} ${sources.length === 1 ? basename(sources[0]!.abs) : `${sources.length} items`}`;

  const written: string[] = [];
  try {
    for (const source of sources) {
      const sameFolder = dirname(source.abs) === target.abs;
      written.push(await copyInto(source.abs, target.abs, { duplicate: mode === "duplicate" || sameFolder }));
    }
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
    throw error;
  }
  const targetRoot = target.connectedFolder?.connectedFolderRoot ?? (target.place?.kind === "standard" ? standardFolderRoot(target.place.id as StandardFolderId) : target.abs);
  const writtenPaths = written.map((path) => relativeTo(targetRoot, path));
  const restorePoints: TransferRestorePoint[] = [];
  if (target.connectedFolder) {
    const targetSafety = await checkpointAdditiveWritesOrUndo(target.connectedFolder.connectedFolderRoot, writtenPaths, { reason: "pre_copy", label: label(mode === "duplicate" ? "duplicating" : "pasting") });
    if (targetSafety) restorePoints.push({ connectedFolderId: target.connectedFolder.id, checkpointId: targetSafety.checkpointId });
  }
  return { mode: copiedInstead ? "copy" : mode, written: writtenPaths, restorePoints, ...(copiedInstead ? { copiedInstead: true } : {}) };
}

/**
 * A move between two Connected Folders: a copy into the target, carrying any
 * `.amplefile` identity a disconnected Connected Folder keeps, then the
 * source's own delete. Every source passes the delete's checks before
 * anything is copied (never the Connected Folder itself, never a nested
 * Connected Folder or anything inside one, whose Chats and History are its
 * own), and the move waits for the source's outstanding work as a delete
 * does. Each source then leaves through the delete's recovery: erased when
 * the source's restore point kept all of it, else moved whole into Recently
 * Deleted with the files History could not keep (docs/act-ledger.md).
 */
async function moveBetweenConnectedFolders(
  state: LocalApiState,
  from: ConnectedFolderSummary,
  sources: readonly ResolvedTransferItem[],
  target: ResolvedTransferItem,
) {
  const to = target.connectedFolder!;
  for (const source of sources) {
    const path = normalizeConnectedFolderRelativePath(source.relativePath);
    if (!path || path === ".") throw badRequest(`${from.name} can’t be moved into ${to.name}. Choose the items inside it.`);
  }
  if (state.requests.list({ connectedFolderId: from.id }).some((request) => requestHasUnsettledWork(state, request))) {
    throw httpError(409, `Finish or stop ${from.name}’s outstanding work before moving items out of it.`);
  }
  // Both Connected Folders' History is claimed at once, before the source is
  // reserved: a waiting move holds nothing off, and two opposite moves
  // between the same folders cannot hold each other up.
  return withConnectedFolderHistoryOperations([from.connectedFolderRoot, to.connectedFolderRoot], async () => {
    reserveCapabilityMutation(state, from.id, "project", from.id);
    try {
      // One touch of the source when the move ends, not one per item it removes.
      return await runSettledConnectedFolderDeletion(state, from.id, () => withConnectedFolderTouchBatch(async () => {
        const root = from.connectedFolderRoot;
        const entries: Array<{ absolutePath: string; path: string; kind: "file" | "folder" }> = [];
        for (const path of outermostConnectedFolderPaths(sources.map((source) => source.relativePath))) {
          entries.push(await resolveConnectedFolderDeleteTarget(root, path));
        }
        const label = entries.length === 1 ? `Before moving ${basename(entries[0]!.absolutePath)}` : `Before moving ${entries.length} items`;
        const safety = await createConnectedFolderMutationCheckpoint(root, {
          paths: entries.map((entry) => entry.path),
          reason: "pre_move",
          label: `${label} to ${to.name}`,
        });
        // History names the files it could not keep the way it names its
        // capture roots; each one belongs to exactly one source.
        const historyRoot = ensureSafeConnectedFolderRoot(root);
        const capturedAs = entries.map((entry) => relative(historyRoot, entry.absolutePath).split(sep).join("/"));
        const notKept = entries.map((): AmpleFileRecentlyDeletedUncoveredPath[] => []);
        for (const file of safety.skippedFiles) {
          const row = capturedAs.findIndex((path) => file.path === path || file.path.startsWith(`${path}/`));
          if (row < 0) {
            await discardConnectedFolderCheckpoint(root, safety.checkpointId).catch(() => undefined);
            throw new AmpleFileCliError("failure", `AmpleFile could not tell which item ${file.path} belongs to. Nothing was moved.`);
          }
          notKept[row]!.push({ path: file.path, reason: file.reason });
        }

        const written: string[] = [];
        try {
          // A moved folder keeps its `.amplefile` identity and Chats: registered
          // nested Connected Folders were refused above, so this is only ever a
          // disconnected one, and the original is about to go.
          for (const entry of entries) written.push(await copyInto(entry.absolutePath, target.abs, { withIdentity: true }));
        } catch (error) {
          await Promise.all(written.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
          await discardConnectedFolderCheckpoint(root, safety.checkpointId).catch(() => undefined);
          throw error;
        }
        const writtenPaths = written.map((path) => relativeTo(to.connectedFolderRoot, path));
        // What History could not keep is safe when the copy holds all of it (a
        // `.git`, an ignored build folder, a large file, a link), checked file
        // by file. Anything else, and any `.amplefile` identity, keeps the item
        // out of a plain delete: it leaves the source whole, by moving into
        // Recently Deleted.
        const uncovered = await Promise.all(entries.map(async (entry, row) => {
          const missing: AmpleFileRecentlyDeletedUncoveredPath[] = [];
          for (const file of notKept[row]!) {
            const inside = (file.path === capturedAs[row] ? "" : file.path.slice(capturedAs[row]!.length + 1)).split("/").filter(Boolean);
            const identity = inside.some((segment) => segment === ".amplefile");
            if (identity || !await copyHoldsAll(join(entry.absolutePath, ...inside), join(written[row]!, ...inside))) missing.push(file);
          }
          return missing;
        }));
        let targetSafety: ConnectedFolderCheckpoint | null;
        try {
          targetSafety = await checkpointAdditiveWritesOrUndo(to.connectedFolderRoot, writtenPaths, { reason: "pre_move", label });
        } catch (error) {
          await discardConnectedFolderCheckpoint(root, safety.checkpointId).catch(() => undefined);
          throw error;
        }
        const restorePoints: TransferRestorePoint[] = [
          ...(targetSafety ? [{ connectedFolderId: to.id, checkpointId: targetSafety.checkpointId }] : []),
          { connectedFolderId: from.id, checkpointId: safety.checkpointId },
        ];
        const recentlyDeleted: Array<{ path: string; entryId: string; restoreBy: string }> = [];
        for (const [index, entry] of entries.entries()) {
          try {
            // Each item leaving the source is that Connected Folder's delete,
            // with the delete's own receipt, as the delete routes record it.
            const { value: removed } = await runDesktopSettingsAct(state, "files.delete", async (requestId) => {
              const value = await applyConnectedFolderDelete(state, from, entry.path, uncovered[index]!, safety.checkpointId, { receiptId: requestId });
              return {
                value,
                detail: value.recovery.kind === "recently-deleted"
                  ? `Connected Folder ${from.id}; moved to ${to.id}; trash ${value.recovery.entryId}`
                  : `Connected Folder ${from.id}; moved to ${to.id}; checkpoint ${value.safetyCheckpointId}`,
              };
            });
            if (removed.recovery.kind === "recently-deleted") recentlyDeleted.push({ path: entry.path, entryId: removed.recovery.entryId, restoreBy: removed.recovery.restoreBy });
          } catch (error) {
            // A release across volumes that failed partway still left a whole
            // copy in Recently Deleted; it is listed with the rest.
            const kept = (error as { recentlyDeleted?: { entryId: string; restoreBy: string } }).recentlyDeleted;
            if (kept) recentlyDeleted.push({ path: entry.path, entryId: kept.entryId, restoreBy: kept.restoreBy });
            // Everything is already in the target; what could not leave the
            // source stays there, and both restore points still apply. A copied
            // identity whose original is still whole in the source goes from
            // the copy, so no identity exists twice; one whose original did not
            // survive stays in the copy. One that could not be removed from the
            // copy is named, not hidden.
            const duplicateIdentities: string[] = [];
            for (const [offset, copy] of written.slice(index).entries()) {
              const left = await removeIdentityFoldersKeptAt(copy, entries[index + offset]!.absolutePath).catch(() => [copy]);
              duplicateIdentities.push(...left.map((path) => relativeTo(to.connectedFolderRoot, path)));
            }
            return {
              mode: "move" as const,
              written: writtenPaths,
              restorePoints,
              ...(recentlyDeleted.length ? { recentlyDeleted } : {}),
              failed: { path: entry.path, error: errorMessage(error) },
              notRemoved: entries.slice(index).map((item) => item.path),
              ...(duplicateIdentities.length ? { duplicateIdentities } : {}),
            };
          }
        }
        return { mode: "move" as const, written: writtenPaths, restorePoints, ...(recentlyDeleted.length ? { recentlyDeleted } : {}) };
      }));
    } finally {
      state.capabilityMutations.delete(from.id);
    }
  });
}

async function compressEntries(body: { place?: unknown; paths?: unknown }) {
  const place = transferPlace(body.place);
  if (!Array.isArray(body.paths) || !body.paths.length || body.paths.some((path) => typeof path !== "string" || !path.trim())) throw badRequest("Choose items to compress.");
  const items = await Promise.all((body.paths as string[]).map((path) => resolveTransferItem(place, path, "read")));
  const folder = dirname(items[0]!.abs);
  const folderRelative = items[0]!.relativePath.includes("/") ? items[0]!.relativePath.slice(0, items[0]!.relativePath.lastIndexOf("/")) : "";
  const target = await resolveTransferItem(place, folderRelative, "target");
  const archive = await compressInto(items.map((item) => item.abs), folder);
  const root = target.connectedFolder?.connectedFolderRoot ?? standardFolderRoot(place.id as StandardFolderId);
  const path = relativeTo(root, archive);
  const safety = target.connectedFolder
    ? await checkpointAdditiveWritesOrUndo(target.connectedFolder.connectedFolderRoot, [path], { reason: "pre_compress", label: `Before compressing ${items.length === 1 ? basename(items[0]!.abs) : `${items.length} items`}` })
    : null;
  return { path, restorePoints: safety ? [{ connectedFolderId: target.connectedFolder!.id, checkpointId: safety.checkpointId }] : [] };
}

/**
 * Recents: files changed in the last 30 days, newest first: everything in the
 * Connected Folders (as their own rules show them) and the files at the top of
 * Desktop, Documents, and Downloads.
 */
async function recentFiles(connectedFolders: readonly ConnectedFolderSummary[]) {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  const found: Array<{ place: TransferPlaceRef; path: string; name: string; kind: "file"; sizeBytes?: number; updatedAt: string; where: string }> = [];
  const collect = (place: TransferPlaceRef, where: string, entries: readonly TreeEntry[]) => {
    for (const entry of entries) {
      if (entry.nestedFolder) continue;
      if (entry.children) collect(place, where, entry.children);
      if (entry.kind !== "file" || !entry.updatedAt || Date.parse(entry.updatedAt) < since) continue;
      found.push({ place, path: entry.path, name: entry.name, kind: "file", ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}), updatedAt: entry.updatedAt, where });
    }
  };
  for (const connectedFolder of connectedFolders) {
    const scan = await scanConnectedFolderTree(connectedFolder.connectedFolderRoot, 20, "", { includeIgnored: false, nestedFolderPaths: await nestedRegisteredConnectedFolderPaths(connectedFolder.connectedFolderRoot) }).catch(() => null);
    if (scan) collect({ kind: "connected-folder", id: connectedFolder.id }, connectedFolder.name, scan.entries);
  }
  const standard = await listStandardFolders(connectedFolders).catch(() => []);
  for (const folder of standard) {
    if (folder.connectedFolderId || !["desktop", "documents", "downloads"].includes(folder.id)) continue;
    const scan = await scanStandardFolder(folder.id, "").catch(() => null);
    if (scan) collect({ kind: "standard", id: folder.id }, folder.name, scan.tree);
  }
  return found.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 200);
}
