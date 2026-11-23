/**
 * The file manager's places beyond one Connected Folder
 * (docs/product-model.md, "The file manager window"): Standard Folders,
 * transfers between places including the move between Connected Folders,
 * Compress, Recents, and Go to Folder. This module owns the list of open local
 * APIs that a paste run in the desktop's main process uses.
 */

import { createLocalEventSink } from "../local-event-stream.js";
import { isAlwaysHiddenConnectedFolderEntry } from "../connected-folder-ignore.js";
import {
  assertStandardFolderPathUnowned,
  computerFolderId,
  createStandardFolderFolder,
  isStandardFolderId,
  listStandardFolders,
  removeSidebarFolder,
  renameStandardFolderEntry,
  resolveStandardFolderPath,
  scanStandardFolder,
  standardFolderEntryInfo,
  standardFolderFilePreview,
  standardFolderName,
  standardFolderPathBase,
  standardFolderRegistrationTarget,
  standardFolderRoot,
  type StandardFolderId,
} from "../standard-folders.js";
import { goToFolder } from "../go-to-folder.js";
import { comparableForms, comparablePath, formsContain } from "../path-comparison.js";
import { resolveFolderLocation, scanComputerFolder } from "../folder-locations.js";
import { compressInto, copyHoldsAll, folderBlockingRemoval, isInside, measureCopy, moveInto, relativeTo, removeIdentityFoldersKeptAt, sourceLostPart, sourceUnchanged, type CopiedSource } from "../file-transfer.js";
import { assertExtractable, extractFolderName, stageExtract, type StagedExtract } from "../archive-extract.js";
import {
  chosenForItem,
  commitUnit,
  findConflicts,
  parseConflictRequest,
  planPlacements,
  removeEmptiedMergeSources,
  stageUnit,
  summarize,
  takeBackUnit,
  type ConflictPolicy,
  type PlacementPlan,
  type PlacementRun,
  type PlacementSource,
  type PlacementUnit,
  type ReplacedItem,
  type StagedUnit,
  type TransferConflict,
} from "../file-conflicts.js";
import { moveToSystemTrash } from "../move-to-system-trash.js";
import {
  cancelFileOperation,
  isFileOperationCancelled,
  parseFileOperationId,
  runFileOperation,
  runningFileOperations,
  subscribeFileOperations,
  type FileOperationControl,
} from "../file-operations.js";
import { homedir as userHomedir } from "node:os";
import { lstat, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createConnectedFolderMutationCheckpoint, discardConnectedFolderCheckpoint, type ConnectedFolderCheckpoint } from "../history.js";
import type { AmpleFileRecentlyDeletedUncoveredPath } from "../recently-deleted-store.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import {
  createConnectedFolderFolder,
  ensureSafeConnectedFolderRoot,
  getConnectedFolder,
  listConnectedFolders,
  outermostConnectedFolderPaths,
  resolveConnectedFolderDeleteTarget,
  touchConnectedFolderRoot,
  resolveConnectedFolderPath,
  scanConnectedFolderTree,
  nestedRegisteredConnectedFolderPaths,
  withConnectedFolderHistoryOperations,
  withConnectedFolderTouchBatch,
  type TreeEntry,
  type ConnectedFolderSummary,
} from "../connected-folder.js";
import { registerConnectedFolderInternal } from "./connected-folder-routes.js";
import { openStandardFolderFileStream } from "./event-streams.js";
import { treeListingQuery } from "./tree-listing-query.js";
import { applyConnectedFolderDelete, moveConnectedFolderEntriesWithHistory, normalizeConnectedFolderRelativePath } from "./file-changes.js";
import { sendConnectedFolderRawFile } from "./file-routes.js";
import { badRequest, errorMessage, httpError, match, notFound, readJsonBody, sendJson, unavailable } from "./http.js";
import { runDesktopSettingsAct } from "./prepared-act-adapters.js";
import {
  checkpointAdditiveWritesOrUndo,
  requestHasUnsettledWork,
  reserveCapabilityMutation,
  runSettledConnectedFolderDeletion,
  runWithHistorySafety,
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
  // Copy, paste, duplicate, and move across the file manager's places. An
  // optional `operationId` reports progress and makes the transfer cancellable.
  if (method === "POST" && url.pathname === "/api/file-transfer") {
    const body = await readJsonBody<{ mode?: unknown; sources?: unknown; target?: unknown; operationId?: unknown; conflicts?: unknown }>(state, req);
    sendJson(res, await transferFileEntries(body, state));
    return true;
  }
  // Compress: one item becomes "name.zip" beside it, several become "Archive.zip".
  if (method === "POST" && url.pathname === "/api/file-transfer/compress") {
    const body = await readJsonBody<{ place?: unknown; paths?: unknown; operationId?: unknown }>(state, req);
    const result = await compressEntries(body);
    sendJson(res, result, "cancelled" in result ? 200 : 201);
    return true;
  }
  // Extract: an archive becomes a new folder beside it, named after it.
  if (method === "POST" && url.pathname === "/api/file-transfer/extract") {
    const body = await readJsonBody<{ place?: unknown; path?: unknown; operationId?: unknown; conflicts?: unknown }>(state, req);
    const result = await extractEntry(state, body);
    sendJson(res, result, "conflicts" in result || "cancelled" in result || result.path === null ? 200 : 201);
    return true;
  }
  // Cancel: a running copy, move, Compress, or Extract stops at its next safe boundary.
  if (method === "POST" && url.pathname === "/api/file-transfer/cancel") {
    const body = await readJsonBody<{ operationId?: unknown }>(state, req);
    const operationId = parseFileOperationId(body.operationId);
    if (!operationId) throw badRequest("Choose an operation to stop.");
    const cancelled = cancelFileOperation(operationId);
    if (!cancelled) throw notFound("That operation isn’t running.");
    sendJson(res, { operationId, ...cancelled });
    return true;
  }
  // The file operations running now, and their progress as it happens.
  if (method === "GET" && url.pathname === "/api/file-transfer/operations") {
    sendJson(res, { operations: runningFileOperations() });
    return true;
  }
  if (method === "GET" && url.pathname === "/api/file-transfer/events") {
    if (state.localEventStreams.size >= 64) throw httpError(429, "Too many local event connections.");
    const sink = createLocalEventSink(res);
    state.localEventStreams.add(sink);
    // The sink closes itself if the window falls too far behind.
    const stop = subscribeFileOperations((event) => { sink.send(event); });
    const heartbeat = setInterval(() => sink.heartbeat(), 15_000);
    heartbeat.unref();
    sink.onClose(() => { clearInterval(heartbeat); stop(); state.localEventStreams.delete(sink); });
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
  // Where a folder on this computer opens (the path bar above a place's top,
  // Command-Up from it): the place holding it, as Go to Folder resolves one.
  if (method === "GET" && url.pathname === "/api/folder-location") {
    const path = url.searchParams.get("path") ?? "";
    if (!isAbsolute(path) || path.includes("\0")) throw badRequest("A full path is required.");
    const location = await resolveFolderLocation(path, await listConnectedFolders(), userHomedir(), { reveal: url.searchParams.get("reveal") === "1" });
    if (!location) throw notFound("There’s no folder or file at that path.");
    sendJson(res, { location });
    return true;
  }
  // Remove from Sidebar: a folder the person added with + leaves the list; the folder stays as it is.
  const sidebarFolderMatch = match(url.pathname, /^\/api\/standard-folders\/(added-[0-9a-f]{16})$/);
  if (method === "DELETE" && sidebarFolderMatch) {
    removeSidebarFolder(sidebarFolderMatch[1]);
    sendJson(res, { removed: true });
    return true;
  }
  const standardFolderMatch = match(url.pathname, /^\/api\/standard-folders\/([^/]+)\/(tree|file-info|file-preview|raw-file|events|rename-local-entry|folders|connected-folders)$/);
  if (standardFolderMatch) {
    const standardFolderId = standardFolderMatch[1];
    if (!isStandardFolderId(standardFolderId)) throw notFound("That standard folder isn’t on this computer.");
    const route = standardFolderMatch[2];
    const path = url.searchParams.get("path") ?? "";
    if (method === "GET" && route === "tree") {
      // The computer place's top is the disk's root, which the Standard Folder scan never takes as a folder.
      const listing = treeListingQuery(url.searchParams, true);
      sendJson(res, standardFolderId === computerFolderId ? await scanComputerFolder(path, undefined, listing) : await scanStandardFolder(standardFolderId, path, undefined, undefined, listing));
      return true;
    }
    if (method === "GET" && route === "file-info") {
      if (!path) throw badRequest("A path inside the folder is required.");
      sendJson(res, await standardFolderEntryInfo(standardFolderId, path));
      return true;
    }
    if (method === "GET" && route === "file-preview") {
      if (!path) throw badRequest("A path inside the folder is required.");
      sendJson(res, { preview: await standardFolderFilePreview(standardFolderId, path) });
      return true;
    }
    if (method === "GET" && route === "raw-file") {
      if (!path) throw badRequest("File path is required.");
      const base = standardFolderPathBase(standardFolderId, path);
      if (!base) throw badRequest("File path is required.");
      await sendConnectedFolderRawFile(res, base.root, base.path);
      return true;
    }
    if (method === "GET" && route === "events") {
      await openStandardFolderFileStream(state, createLocalEventSink(res), standardFolderId, path, { includeHidden: url.searchParams.get("includeHidden") === "1" });
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

/** One item that left its folder for another, for Undo to move back: its path in the place it came from, and where it is in the target's place. */
type TransferMove = { from: string; fromPlace: TransferPlaceRef; to: string };

interface ResolvedTransferItem {
  abs: string;
  place: TransferPlaceRef | null;
  connectedFolder: ConnectedFolderSummary | null;
  relativePath: string;
  /** The name it takes in the target, when the request gives one (Undo puts an item back under the name it had). */
  name?: string;
}

/** The name a request gives an item in the target: one visible path segment's worth, never AmpleFile's or Pi's own folders. */
function transferSourceName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value || value === "." || value === ".." || /[/\\\0]/.test(value) || Buffer.byteLength(value, "utf8") > 255 || isAlwaysHiddenConnectedFolderEntry(value)) {
    throw badRequest("That name can’t be used for an item.");
  }
  return value;
}

/** The items as the plan takes them: where each is, the key its clash is chosen by, and the name it takes when not its own. */
function placementSources(sources: readonly ResolvedTransferItem[]): PlacementSource[] {
  return sources.map((item) => ({ source: item.abs, key: sourceKey(item), ...(item.name ? { name: item.name } : {}) }));
}

function transferPlace(value: unknown): TransferPlaceRef {
  const record = value as { kind?: unknown; id?: unknown } | null;
  if (!record || (record.kind !== "connected-folder" && record.kind !== "standard") || typeof record.id !== "string" || !record.id) throw badRequest("Choose where the items are.");
  return { kind: record.kind, id: record.id };
}

/**
 * A source (read or change) may itself be a symbolic link: it is copied,
 * moved, or compressed as a link, never followed. A target is a real folder.
 */
async function resolveTransferItem(place: TransferPlaceRef, path: string, purpose: "read" | "change" | "target"): Promise<ResolvedTransferItem> {
  const finalLink = purpose !== "target";
  if (place.kind === "connected-folder") {
    const connectedFolder = await getConnectedFolder(place.id);
    const abs = resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, path, { finalLink });
    if (purpose === "target") await assertTargetOutsideNestedFolders(connectedFolder, abs);
    return { abs, place, connectedFolder, relativePath: normalizeConnectedFolderRelativePath(path) };
  }
  if (!isStandardFolderId(place.id)) throw notFound("That folder isn’t in the sidebar anymore.");
  const abs = purpose === "read"
    ? resolveStandardFolderPath(place.id, path, userHomedir(), { finalLink })
    : await assertStandardFolderPathUnowned(place.id, path, userHomedir(), { allowContaining: purpose === "target", finalLink });
  return { abs, place, connectedFolder: null, relativePath: normalizeConnectedFolderRelativePath(path) };
}

/** A Connected Folder nested in another, with every way its root compares (src/local/path-comparison.ts). */
interface NestedFolder { name: string; forms: string[] }

/**
 * The Connected Folders nested in `connectedFolder`: the ones registered
 * inside it, pending removals included, and any other registered Connected
 * Folder that the disk resolves to a folder inside it, however its path was
 * written when it was registered (in another letter case, with an accent
 * spelled the other way, or through a linked folder).
 */
async function nestedFoldersOf(connectedFolder: ConnectedFolderSummary): Promise<NestedFolder[]> {
  const root = ensureSafeConnectedFolderRoot(connectedFolder.connectedFolderRoot);
  const candidates = [
    ...(await nestedRegisteredConnectedFolderPaths(root)).map((relativePath) => ({ name: relativePath, root: join(root, ...relativePath.split("/")) })),
    ...(await listConnectedFolders()).filter((other) => other.id !== connectedFolder.id).map((other) => ({ name: other.name, root: other.connectedFolderRoot })),
  ];
  if (!candidates.length) return [];
  const own = await comparableForms(root);
  const nested: NestedFolder[] = [];
  for (const candidate of candidates) {
    const forms = await comparableForms(candidate.root);
    // Inside this Connected Folder, not the one this is nested in.
    if (formsContain(own, forms) && !formsContain(forms, own)) nested.push({ name: candidate.name, forms });
  }
  return nested;
}

/** The nested Connected Folder a path belongs to (`inside`) or holds (`holds`), or null. */
async function nestedFolderAt(nested: readonly NestedFolder[], path: string, options: { finalLink?: boolean } = {}): Promise<{ name: string; relation: "inside" | "holds" } | null> {
  if (!nested.length) return null;
  const asked = await comparableForms(path, options);
  for (const other of nested) {
    if (formsContain(other.forms, asked)) return { name: other.name, relation: "inside" };
    if (formsContain(asked, other.forms)) return { name: other.name, relation: "holds" };
  }
  return null;
}

/**
 * A folder items are put in, named through a Connected Folder, is that
 * Connected Folder's own: never a nested Connected Folder or a folder inside
 * one, whose files belong to its own Worker and History. The window opens a
 * nested Connected Folder as itself; this refuses a request that names it
 * through its parent. A folder that holds a nested one is the parent's.
 */
async function assertTargetOutsideNestedFolders(connectedFolder: ConnectedFolderSummary, target: string): Promise<void> {
  const nested = await nestedFolderAt(await nestedFoldersOf(connectedFolder), target);
  if (nested?.relation === "inside") throw httpError(409, `${nested.name} is a Connected Folder of its own. Open that Connected Folder to put items in it.`);
}

/**
 * An item that leaves a Connected Folder is never a nested Connected Folder,
 * an item inside one, or a folder that holds one. The delete's own check
 * (`resolveConnectedFolderDeleteTarget`) finds the nested ones written the
 * way this Connected Folder is; this finds one registered under any other
 * spelling of its path, so it cannot leave through its parent. `nested` is
 * read once for a move (`nestedFoldersOf`), not once for each item.
 */
async function assertSourceClearOfNestedFolders(nested: readonly NestedFolder[], absolutePath: string, relativePath: string): Promise<void> {
  const found = await nestedFolderAt(nested, absolutePath, { finalLink: true });
  if (!found) return;
  throw httpError(409, found.relation === "inside"
    ? `${relativePath} belongs to the ${found.name} Connected Folder. Open that Connected Folder to change it.`
    : `${relativePath} holds the ${found.name} Connected Folder, which has its own Worker. Remove that Connected Folder from AmpleFile first, or change it in ${process.platform === "darwin" ? "Finder" : "your file manager"}.`);
}

/**
 * Copy (and Duplicate) adds to the target and keeps a restore point there; a
 * move inside one Connected Folder is History's own move; a move inside or
 * between plain folders is a plain move, as Finder's. A move that leaves a
 * Connected Folder, for another one or for a plain folder, copies the items
 * and then takes each out of its source through that Connected Folder's
 * delete; a move from plain folders into a Connected Folder copies them and
 * then removes each original once its copy is whole (`moveRows`). Items taken
 * from more than one Connected Folder, or from a Connected Folder and a plain
 * folder at once, are copied, and the answer says so. Items from outside the
 * places (a Finder paste or drop) can only be copied in.
 *
 * With an `operationId` the transfer reports its progress and can be
 * cancelled (src/local/file-operations.ts). A cancelled transfer keeps the
 * items it finished, takes back the one in hand, answers `cancelled: true`
 * with the sources it did not get to in `notDone`, and keeps a restore point
 * for what it did write.
 *
 * `conflicts` (src/local/file-conflicts.ts) asks which names clash
 * (`{ check: true }`, nothing written) or chooses what happens to each clash.
 * Without it a taken name gets the " copy" naming, as before.
 *
 * A source may carry the `name` it takes in the target, and a move's target
 * may say `create: true` to have its missing folders made: Undo uses both to
 * put an item back exactly where it was, under the name it had.
 */
export async function transferFileEntries(
  body: { mode?: unknown; sources?: unknown; target?: unknown; operationId?: unknown; conflicts?: unknown },
  state: LocalApiState | undefined = openLocalApiStates.at(-1),
) {
  const operationId = parseFileOperationId(body.operationId);
  const mode = body.mode === "move" || body.mode === "duplicate" ? body.mode : body.mode === "copy" ? "copy" : null;
  if (!mode) throw badRequest("Choose copy, duplicate, or move.");
  const conflicts = parseConflictRequest(body.conflicts);
  if (conflicts.check) {
    const { target, sources, missingTarget } = await resolveTransferRequest(body, mode, "check");
    // A folder still to be made holds nothing to clash with.
    if (missingTarget) return { conflicts: [] as TransferConflict[] };
    return { conflicts: await findConflicts(placementSources(sources), target.abs, { duplicate: mode === "duplicate" }) };
  }
  return runFileOperation(operationId, mode, async (operation) => {
    const { target, sources, created } = await resolveTransferRequest(body, mode, "run");
    if (!created) return transferResolvedEntries(target, sources, mode, state, operation, conflicts.policy);
    try {
      const result = await transferResolvedEntries(target, sources, mode, state, operation, conflicts.policy);
      // Folders made for items that then did not arrive are taken away again.
      if (!result.written.length) { await created.discard(); return result; }
      return { ...result, restorePoints: [...result.restorePoints, ...created.restorePoints] };
    } catch (error) {
      await created.discard();
      throw error;
    }
  }, (result) => "cancelled" in result && result.cancelled ? "cancelled" : "succeeded");
}

/** A source as the request named it: its path in its place, or its path on disk. */
function sourceKey(item: ResolvedTransferItem): string {
  return item.place ? item.relativePath : item.abs;
}

/** The folders a move made for its target, with the restore point that takes them away in a Connected Folder. */
interface CreatedTarget {
  /** Comes after the move's own restore points: the folders go once the items have. */
  restorePoints: TransferRestorePoint[];
  /** Removes the folders again, while they are empty. */
  discard: () => Promise<void>;
}

async function resolveTransferRequest(body: { sources?: unknown; target?: unknown }, mode: "copy" | "duplicate" | "move", purpose: "check" | "run") {
  if (!Array.isArray(body.sources) || !body.sources.length || body.sources.length > 5_000) throw badRequest("Choose items to copy or move.");
  const targetRecord = body.target as { place?: unknown; path?: unknown; create?: unknown } | null;
  const target = await resolveTransferItem(transferPlace(targetRecord?.place), typeof targetRecord?.path === "string" ? targetRecord.path : "", "target");
  const mayCreate = mode === "move" && targetRecord?.create === true;
  const missingTarget = mayCreate && !(await lstat(target.abs).catch(() => null));
  if (!missingTarget) {
    const targetInfo = await stat(target.abs).catch(() => null);
    if (!targetInfo?.isDirectory()) throw badRequest("Choose a folder to put them in.");
  }

  const sources: ResolvedTransferItem[] = [];
  for (const raw of body.sources as unknown[]) {
    const record = raw as { nativePath?: unknown; place?: unknown; path?: unknown; name?: unknown } | null;
    const name = transferSourceName(record?.name);
    if (typeof record?.nativePath === "string") {
      if (mode === "move") throw badRequest("Items from Finder are copied in, not moved.");
      const abs = resolve(record.nativePath);
      if (!(await lstat(abs).catch(() => null))) throw badRequest(`“${basename(abs)}” isn’t there anymore.`);
      sources.push({ abs, place: null, connectedFolder: null, relativePath: "", ...(name ? { name } : {}) });
      continue;
    }
    if (typeof record?.path !== "string" || !record.path.trim()) throw badRequest("Choose items to copy or move.");
    sources.push({ ...await resolveTransferItem(transferPlace(record.place), record.path, mode === "move" ? "change" : "read"), ...(name ? { name } : {}) });
  }
  for (const source of sources) {
    if (isInside(source.abs, target.abs)) throw badRequest(`“${basename(source.abs)}” can’t go inside itself.`);
  }
  // Every source is checked before a folder is made for them.
  const created = missingTarget && purpose === "run" ? await createTransferTarget(target) : null;
  return { target, sources, missingTarget, created };
}

/**
 * Makes the folders of a move's target that are not there (Undo putting
 * items back into a folder a merge emptied and removed), each through its
 * place's own New Folder, so the place's rules for names and for nested
 * Connected Folders apply. In a Connected Folder one restore point takes
 * them away again.
 */
async function createTransferTarget(target: ResolvedTransferItem): Promise<CreatedTarget> {
  const place = target.place!;
  const segments = target.relativePath.split("/").filter((part) => part && part !== ".");
  // A place's own folder is never made here.
  if (!segments.length) throw badRequest("Choose a folder to put them in.");
  const root = transferTargetRoot(target);
  let existing = 0;
  while (existing < segments.length && await lstat(join(root, ...segments.slice(0, existing + 1))).catch(() => null)) existing += 1;
  const made: string[] = [];
  const discard = async () => {
    for (const path of [...made].reverse()) await rmdir(join(root, ...path.split("/"))).catch(() => undefined);
  };
  const make = async () => {
    for (let depth = existing; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join("/");
      const path = segments.slice(0, depth + 1).join("/");
      const folder = target.connectedFolder
        ? await createConnectedFolderFolder(target.connectedFolder.connectedFolderRoot, parent, segments[depth]!)
        : await createStandardFolderFolder(place.id as StandardFolderId, parent, segments[depth]!);
      if (folder.path !== path) throw badRequest("Choose a folder to put them in.");
      made.push(path);
    }
  };
  if (!target.connectedFolder) {
    try { await make(); } catch (error) { await discard(); throw error; }
    return { restorePoints: [], discard };
  }
  const connectedFolder = target.connectedFolder;
  const top = segments.slice(0, existing + 1).join("/");
  const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
    deleteOnRestore: [top],
    reason: "pre_create",
    label: `Before creating ${segments[existing]}`,
  });
  try {
    await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, make);
  } catch (error) {
    await discard();
    throw error;
  }
  return {
    restorePoints: [{ connectedFolderId: connectedFolder.id, checkpointId: safety.checkpointId }],
    discard: async () => {
      await discard();
      if (!(await lstat(join(root, ...top.split("/"))).catch(() => null))) await discardConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, safety.checkpointId).catch(() => undefined);
    },
  };
}

async function transferResolvedEntries(
  target: ResolvedTransferItem,
  sources: readonly ResolvedTransferItem[],
  mode: "copy" | "duplicate" | "move",
  state: LocalApiState | undefined,
  operation: FileOperationControl,
  chosen: ConflictPolicy | null,
) {
  const items = placementSources(sources);
  // A name given to an item is placed by the plan, which is what gives it that name.
  const policy = chosen ?? (sources.some((item) => item.name) ? {} : null);
  const sameConnectedFolder = (item: ResolvedTransferItem) => Boolean(item.connectedFolder && target.connectedFolder && item.connectedFolder.id === target.connectedFolder.id);
  const targetRoot = transferTargetRoot(target);

  if (mode === "move" && sources.every(sameConnectedFolder)) {
    // With choices for clashes, the move is planned here; else it is History's own move.
    if (policy && (sources.some((item) => item.name) || (await findConflicts(items, target.abs)).length)) {
      return moveWithinConnectedFolder(state, target.connectedFolder!, sources, target, policy, operation);
    }
    // History's own move renames each item; it is quick and is not stopped partway.
    operation.setTotals(sources.length, null);
    operation.stage("moving", { cancellable: false });
    const moved = await moveConnectedFolderEntriesWithHistory(target.connectedFolder!, sources.map((item) => item.relativePath), target.relativePath);
    operation.itemsDone(moved.moved.length);
    return {
      mode,
      written: moved.moved.map((item) => item.path),
      restorePoints: [{ connectedFolderId: target.connectedFolder!.id, checkpointId: moved.safetyCheckpointId }],
      ...(moved.failed ? { failed: moved.failed } : {}),
    };
  }
  // Between plain folders (Standard Folders, added folders, and the computer place) a move is a plain move, as Finder's.
  if (mode === "move" && target.place?.kind === "standard" && sources.every((item) => item.place?.kind === "standard")) {
    if (policy) {
      const plan = await planPlacements(items, target.abs, policy, { withIdentity: true, move: true, mayChange: standardMayChange(target.place.id as StandardFolderId) });
      operation.stage("moving");
      const executed = await executePlacement(plan, { run: { mode: "move", withIdentity: true, operation }, target: { root: targetRoot, connectedFolder: null }, state, history: "none", reason: "", label: "" });
      const result = placementResult(plan, executed, targetRoot, sources.map(sourceKey));
      return { mode, written: result.written, moves: plannedMoves(plan, executed, sources, targetRoot), restorePoints: [], ...result.extras, ...result.stop };
    }
    operation.setTotals(sources.length, null);
    operation.stage("moving");
    const moves: TransferMove[] = [];
    let cancelled = false;
    for (const source of sources) {
      try {
        await operation.boundary("item");
        operation.current(basename(source.abs));
        const destination = await moveInto(source.abs, target.abs, operation);
        moves.push({ from: source.relativePath, fromPlace: source.place!, to: relativeTo(standardFolderRoot(target.place.id as StandardFolderId), destination) });
        operation.itemsDone();
      } catch (error) {
        if (!isFileOperationCancelled(error)) throw error;
        cancelled = true;
        break;
      }
    }
    return {
      mode,
      written: moves.map((item) => item.to),
      moves,
      restorePoints: [],
      ...(cancelled ? { cancelled: true as const, notDone: sources.slice(moves.length).map(sourceKey) } : {}),
    };
  }
  // Out of one Connected Folder, into another or into a plain folder.
  const sourceConnectedFolder = sources[0]?.connectedFolder ?? null;
  if (mode === "move" && sourceConnectedFolder && sources.every((item) => item.connectedFolder?.id === sourceConnectedFolder.id)) {
    if (!state) throw unavailable("AmpleFile isn’t ready to move items out of a Connected Folder yet.");
    return moveOutOfConnectedFolder(state, sourceConnectedFolder, sources, target, operation, policy);
  }
  // Out of plain folders, into a Connected Folder.
  if (mode === "move" && target.connectedFolder && sources.every((item) => item.place?.kind === "standard")) {
    if (!state) throw unavailable("AmpleFile isn’t ready to move items into a Connected Folder yet.");
    return moveIntoConnectedFolder(state, sources, target, operation, policy);
  }
  // What is left of a move is items taken from more than one Connected Folder, or from a Connected Folder and a plain folder at once: they are copied, and the answer says so.
  const copiedInstead = mode === "move";
  const label = `Before ${mode === "duplicate" ? "duplicating" : "pasting"} ${sources.length === 1 ? basename(sources[0]!.abs) : `${sources.length} items`}`;
  const plan = await planPlacements(items, target.abs, policy, {
    duplicate: mode === "duplicate",
    mayChange: target.connectedFolder ? connectedFolderMayChange(target.connectedFolder) : target.place?.kind === "standard" ? standardMayChange(target.place.id as StandardFolderId) : undefined,
  });
  const copy = async () => {
    const executed = await executePlacement(plan, {
      run: { mode: "copy", operation },
      target: { root: targetRoot, connectedFolder: target.connectedFolder },
      state,
      history: "additive",
      reason: "pre_copy",
      label,
    });
    const result = placementResult(plan, executed, targetRoot, sources.map(sourceKey));
    return {
      mode: copiedInstead ? "copy" : mode,
      written: result.written,
      restorePoints: executed.restorePoints,
      ...(copiedInstead ? { copiedInstead: true } : {}),
      ...(chosen ? result.extras : {}),
      ...result.stop,
    };
  };
  return target.connectedFolder && planReplaces(plan) ? withSettledReplace(state, target.connectedFolder, copy) : copy();
}

/**
 * Each item a planned plain move took out of its folder, for Undo to move
 * back: a top-level item by its own path, and for a merged folder each item
 * inside it that moved.
 */
function plannedMoves(plan: PlacementPlan, executed: ExecutedPlacement, sources: readonly ResolvedTransferItem[], targetRoot: string): TransferMove[] {
  return plan.units.flatMap((unit, index) => {
    const staged = executed.staged[index];
    if (unit.action === "skip" || !staged?.at || !staged.committed) return [];
    const source = sources[unit.top]!;
    return [{ from: [source.relativePath, relativeTo(source.abs, unit.source)].filter(Boolean).join("/"), fromPlace: source.place!, to: relativeTo(targetRoot, staged.at) }];
  });
}

/** Where a target's relative paths are measured from. */
function transferTargetRoot(target: ResolvedTransferItem): string {
  return target.connectedFolder?.connectedFolderRoot ?? (target.place?.kind === "standard" ? standardFolderRoot(target.place.id as StandardFolderId) : target.abs);
}

function planReplaces(plan: PlacementPlan): boolean {
  return plan.units.some((unit) => unit.action === "replace");
}

/** An item in a Connected Folder may be replaced or merged into where it could be deleted: never a nested Connected Folder or what is inside one. */
function connectedFolderMayChange(connectedFolder: ConnectedFolderSummary): (path: string) => Promise<boolean> {
  return async (path) => {
    try {
      await resolveConnectedFolderDeleteTarget(connectedFolder.connectedFolderRoot, relativeTo(connectedFolder.connectedFolderRoot, path));
      return true;
    } catch {
      return false;
    }
  };
}

/** An item in a Standard Folder may be replaced or merged into unless it is, or holds, a Connected Folder. */
function standardMayChange(id: StandardFolderId): (path: string) => Promise<boolean> {
  return async (path) => {
    try {
      await assertStandardFolderPathUnowned(id, relativeTo(standardFolderRoot(id), path));
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Replacing an item in a Connected Folder deletes it, so it waits for that
 * Connected Folder's outstanding work as a delete does, with its History
 * claimed and its capabilities reserved for the whole operation.
 */
async function withSettledReplace<T>(state: LocalApiState | undefined, connectedFolder: ConnectedFolderSummary, operation: () => Promise<T>): Promise<T> {
  if (!state) throw unavailable("AmpleFile isn’t ready to replace items in a Connected Folder yet.");
  return withConnectedFolderHistoryOperations([connectedFolder.connectedFolderRoot], async () => {
    reserveCapabilityMutation(state, connectedFolder.id, "project", connectedFolder.id);
    try {
      return await runSettledConnectedFolderDeletion(state, connectedFolder.id, operation);
    } finally {
      state.capabilityMutations.delete(connectedFolder.id);
    }
  });
}

interface PlacementTarget {
  /** Where target-relative paths are measured from. */
  root: string;
  connectedFolder: ConnectedFolderSummary | null;
}

interface ExecutedPlacement {
  /** Each unit's staging, by its place in the plan; null when it was not reached or was taken back. */
  staged: Array<StagedUnit | null>;
  cancelled: boolean;
  failed?: { path: string; error: string };
  replaced: ReplacedItem[];
  /** In the order to restore them. */
  restorePoints: TransferRestorePoint[];
}

/**
 * Carries out a plan: every unit is staged (a cancel keeps what finished and
 * takes back a replacement not yet committed; a failure takes back what a copy
 * wrote, as a copy always has), then, in a Connected Folder, a restore point
 * is taken, and last each replacement is committed. The restore point is
 * taken before any item is replaced, so it captures each item to be
 * replaced. For `additive` it also lists everything written to be removed,
 * so restoring it undoes the whole operation. For `moves` it moves back the
 * items already moved, and a second restore point, taken once the
 * replacements are committed, moves back exactly the ones that were; it
 * comes first, so restoring both in order undoes the whole move.
 */
async function executePlacement(plan: PlacementPlan, options: {
  run: PlacementRun;
  target: PlacementTarget;
  state: LocalApiState | undefined;
  history: "additive" | "moves" | "none";
  reason: string;
  label: string;
}): Promise<ExecutedPlacement> {
  const { run, target } = options;
  const operation = run.operation!;
  const staged: Array<StagedUnit | null> = plan.units.map(() => null);
  const executed: ExecutedPlacement = { staged, cancelled: false, replaced: [], restorePoints: [] };
  const takeBackAll = async (which: (unit: StagedUnit) => boolean) => {
    for (const [index, unit] of staged.entries()) {
      if (!unit?.at || !which(unit)) continue;
      await takeBackUnit(unit).catch(() => undefined);
      staged[index] = null;
    }
  };
  try {
    const units = plan.units.filter((unit) => unit.action !== "skip");
    if (operation.operationId && run.mode === "copy") {
      for (const unit of units) {
        const measured = await measureCopy(unit.source, { withIdentity: run.withIdentity, operation });
        operation.addTotals(measured.items, measured.bytes);
      }
    } else {
      operation.setTotals(units.length, null);
    }
    operation.stage(run.mode === "copy" ? "copying" : "moving");
    for (const [index, unit] of plan.units.entries()) {
      if (unit.action === "skip") continue;
      await operation.boundary("item");
      operation.current(basename(unit.source));
      staged[index] = await stageUnit(unit, run);
      if (run.mode === "move") operation.itemsDone();
    }
  } catch (error) {
    if (!isFileOperationCancelled(error)) {
      // A copy that fails takes back all it wrote; a move keeps what it moved.
      await takeBackAll((unit) => run.mode === "copy" || !unit.committed);
      throw error;
    }
    executed.cancelled = true;
    await takeBackAll((unit) => !unit.committed);
  }
  operation.stage("finishing");

  const done = staged.filter((unit): unit is StagedUnit => Boolean(unit?.at));
  const pending = done.filter((unit) => !unit.committed);
  const connectedFolder = target.connectedFolder;
  let checkpoint: ConnectedFolderCheckpoint | null = null;
  const cfRoot = connectedFolder?.connectedFolderRoot ?? "";
  const moveBack = (unit: StagedUnit) => ({ fromPath: relativeTo(cfRoot, unit.at!), toPath: relativeTo(cfRoot, unit.unit.source) });
  if (connectedFolder && options.history !== "none" && done.length) {
    const finalPath = (unit: StagedUnit) => relativeTo(cfRoot, unit.committed ? unit.at! : unit.unit.destination);
    const replacedPaths = pending.map((unit) => relativeTo(cfRoot, unit.unit.destination));
    try {
      if (options.history === "moves") {
        checkpoint = await createConnectedFolderMutationCheckpoint(cfRoot, {
          paths: replacedPaths,
          movesOnRestore: done.filter((unit) => unit.committed).map(moveBack),
          reason: options.reason,
          label: options.label,
        });
      } else if (pending.length) {
        checkpoint = await createConnectedFolderMutationCheckpoint(cfRoot, { paths: replacedPaths, deleteOnRestore: done.map(finalPath), reason: options.reason, label: options.label });
      } else {
        checkpoint = await checkpointAdditiveWritesOrUndo(cfRoot, done.map(finalPath), { reason: options.reason, label: options.label });
      }
    } catch (error) {
      // No restore point, no change: what was written goes, what was moved goes back.
      await takeBackAll(() => true);
      throw error;
    }
    if (checkpoint) executed.restorePoints.push({ connectedFolderId: connectedFolder.id, checkpointId: checkpoint.checkpointId });
  }

  for (const [index, unit] of plan.units.entries()) {
    const current = staged[index];
    if (!current?.at || current.committed) continue;
    try {
      const dispose = connectedFolder
        ? (path: string) => disposeInConnectedFolder(options.state, connectedFolder, checkpoint!, path)
        : disposeToSystemTrash;
      const committed = await commitUnit(current, dispose, run);
      if (committed.replaced) executed.replaced.push(committed.replaced);
    } catch (error) {
      executed.failed = { path: relativeTo(target.root, unit.destination), error: errorMessage(error) };
      await takeBackAll((other) => !other.committed);
      break;
    }
  }
  const replacedNow = pending.filter((unit) => unit.committed);
  if (connectedFolder && options.history === "moves" && replacedNow.length) {
    // The replacements that happened, moved back first when restoring.
    const after = await createConnectedFolderMutationCheckpoint(cfRoot, { movesOnRestore: replacedNow.map(moveBack), reason: options.reason, label: options.label });
    executed.restorePoints.unshift({ connectedFolderId: connectedFolder.id, checkpointId: after.checkpointId });
  }
  if (run.mode === "move") await removeEmptiedMergeSources(plan);
  return executed;
}

/** The item a Connected Folder's replacement takes the place of goes through that Connected Folder's delete, with its receipt and recovery. */
async function disposeInConnectedFolder(
  state: LocalApiState | undefined,
  connectedFolder: ConnectedFolderSummary,
  checkpoint: ConnectedFolderCheckpoint,
  path: string,
): Promise<ReplacedItem> {
  if (!state) throw unavailable("AmpleFile isn’t ready to replace items in a Connected Folder yet.");
  const relativePath = relativeTo(connectedFolder.connectedFolderRoot, path);
  const capturedAs = relative(ensureSafeConnectedFolderRoot(connectedFolder.connectedFolderRoot), path).split(sep).join("/");
  // What History could not keep of it goes whole into Recently Deleted.
  const uncovered = checkpoint.skippedFiles
    .filter((file) => file.path === capturedAs || file.path.startsWith(`${capturedAs}/`))
    .map((file) => ({ path: file.path, reason: file.reason }));
  const { value } = await runDesktopSettingsAct(state, "files.delete", async (requestId) => {
    const deleted = await applyConnectedFolderDelete(state, connectedFolder, relativePath, uncovered, checkpoint.checkpointId, { receiptId: requestId });
    return {
      value: deleted,
      detail: deleted.recovery.kind === "recently-deleted"
        ? `Connected Folder ${connectedFolder.id}; replaced; trash ${deleted.recovery.entryId}`
        : `Connected Folder ${connectedFolder.id}; replaced; checkpoint ${deleted.safetyCheckpointId}`,
    };
  });
  return value.recovery.kind === "recently-deleted"
    ? { path, recovery: "recently-deleted", entryId: value.recovery.entryId, restoreBy: value.recovery.restoreBy }
    : { path, recovery: "history" };
}

/** Outside a Connected Folder a replaced item goes to the system Trash, or, with no Trash the host can use, is removed and said to be gone. */
async function disposeToSystemTrash(path: string): Promise<ReplacedItem> {
  if (await moveToSystemTrash(path)) return { path, recovery: "trash" };
  await rm(path, { recursive: true, force: false });
  return { path, recovery: "gone" };
}

/** Where top-level item `index` ended up, or null when it did not (skipped, taken back, not reached). */
function topUnitAt(plan: PlacementPlan, executed: ExecutedPlacement, index: number): string | null {
  const top = plan.tops[index]!;
  const units = plan.units.map((unit, at) => ({ unit, staged: executed.staged[at] })).filter((item) => item.unit.top === index);
  if (top.action === "merge") return units.some((item) => item.staged?.at && item.staged.committed) ? top.destination : null;
  const own = units[0];
  return own?.staged?.at && own.staged.committed ? own.staged.at : null;
}

/**
 * What a planned operation answers: the top-level items written (a merged
 * folder by its name), the sources it did not finish when it stopped, and,
 * with conflict choices, what was replaced, skipped, and merged.
 */
function placementResult(plan: PlacementPlan, executed: ExecutedPlacement, targetRoot: string, names: readonly string[]) {
  const written: string[] = [];
  const notDone: string[] = [];
  for (const [index, top] of plan.tops.entries()) {
    const at = topUnitAt(plan, executed, index);
    if (at) written.push(relativeTo(targetRoot, at));
    const unfinished = plan.units.some((unit, position) => unit.top === index && unit.action !== "skip" && !(executed.staged[position]?.at && executed.staged[position]!.committed));
    if (top.action !== "skip" && unfinished) notDone.push(names[index]!);
  }
  const skipped = plan.units.filter((unit) => unit.action === "skip").map((unit) => ({ path: relativeTo(targetRoot, unit.destination), reason: unit.reason ?? "chosen" }));
  const merged = plan.tops.flatMap((top, index) => top.action === "merge" && topUnitAt(plan, executed, index) ? [relativeTo(targetRoot, top.destination)] : []);
  return {
    written,
    extras: {
      replaced: executed.replaced.map((item) => ({ ...item, path: relativeTo(targetRoot, item.path) })),
      skipped,
      merged,
    },
    stop: {
      ...(executed.cancelled ? { cancelled: true as const, notDone } : {}),
      ...(executed.failed ? { failed: executed.failed, notDone } : {}),
    },
  };
}

/**
 * A move inside one Connected Folder with choices for its clashes: each item
 * passes a delete's checks (never the Connected Folder itself or a nested
 * Connected Folder), and one restore point moves everything back and puts
 * each replaced item back.
 */
async function moveWithinConnectedFolder(
  state: LocalApiState | undefined,
  connectedFolder: ConnectedFolderSummary,
  sources: readonly ResolvedTransferItem[],
  target: ResolvedTransferItem,
  policy: ConflictPolicy,
  operation: FileOperationControl,
) {
  const root = connectedFolder.connectedFolderRoot;
  for (const source of sources) await resolveConnectedFolderDeleteTarget(root, source.relativePath);
  if (target.relativePath && target.relativePath !== ".") await resolveConnectedFolderDeleteTarget(root, target.relativePath);
  const plan = await planPlacements(placementSources(sources), target.abs, policy, {
    withIdentity: true,
    move: true,
    mayChange: connectedFolderMayChange(connectedFolder),
  });
  const label = sources.length === 1 ? `Before moving ${sources[0]!.relativePath}` : `Before moving ${sources.length} items`;
  const move = () => withConnectedFolderTouchBatch(async () => {
    const executed = await executePlacement(plan, {
      run: { mode: "move", withIdentity: true, operation },
      target: { root, connectedFolder },
      state,
      history: "moves",
      reason: "pre_move",
      label,
    });
    await touchConnectedFolderRoot(root).catch(() => undefined);
    const result = placementResult(plan, executed, root, sources.map(sourceKey));
    return { mode: "move" as const, written: result.written, restorePoints: executed.restorePoints, ...result.extras, ...result.stop };
  });
  return planReplaces(plan) ? withSettledReplace(state, connectedFolder, move) : withConnectedFolderHistoryOperations([root], move);
}

/** One top-level item of a move between places: where it is, its path in the place it comes from, and the name it takes when not its own. */
interface MoveEntry { absolutePath: string; path: string; place: TransferPlaceRef; name?: string }

/** A plain target folder by name, for messages and restore-point labels. */
function transferTargetName(target: ResolvedTransferItem): string {
  return basename(target.abs) || "the disk";
}

/**
 * A move out of a Connected Folder, into another one or into a plain folder:
 * a copy into the target, carrying any `.amplefile` identity a disconnected
 * Connected Folder keeps, then the source's own delete. Every source passes
 * the delete's checks before anything is copied (never the Connected Folder
 * itself, never a nested Connected Folder or anything inside one, whose
 * Chats and History are its own), and the move waits for the source's
 * outstanding work as a delete does. Each source then leaves through the
 * delete's recovery: erased when the source's restore point kept all of it,
 * else moved whole into Recently Deleted with the files History could not
 * keep (docs/act-ledger.md).
 *
 * A cancel while copying takes back every copy and moves nothing. A cancel
 * while items leave the source keeps the items that already left (moved),
 * takes back the copies of the rest (which stay in the source), and narrows
 * a target Connected Folder's restore point to what moved. Either way the
 * source's reservation is released.
 *
 * With conflict choices, each item that clashes is planned first: a skipped
 * one stays in the source, a merged folder moves its contents item by item,
 * and a replacement is copied under a working name and takes its name (the
 * item there going through the target Connected Folder's delete, or to the
 * system Trash in a plain folder) only as its source leaves. Replacing in a
 * Connected Folder waits for that Connected Folder's outstanding work too.
 */
async function moveOutOfConnectedFolder(
  state: LocalApiState,
  from: ConnectedFolderSummary,
  sources: readonly ResolvedTransferItem[],
  target: ResolvedTransferItem,
  operation: FileOperationControl,
  policy: ConflictPolicy | null,
) {
  const to = target.connectedFolder;
  for (const source of sources) {
    const path = normalizeConnectedFolderRelativePath(source.relativePath);
    if (!path || path === ".") throw badRequest(`${from.name} can’t be moved into ${to?.name ?? transferTargetName(target)}. Choose the items inside it.`);
  }
  if (state.requests.list({ connectedFolderId: from.id }).some((request) => requestHasUnsettledWork(state, request))) {
    throw httpError(409, `Finish or stop ${from.name}’s outstanding work before moving items out of it.`);
  }
  // Every Connected Folder's History the move touches is claimed at once,
  // before the source is reserved: a waiting move holds nothing off, and two
  // opposite moves between the same folders cannot hold each other up.
  return withConnectedFolderHistoryOperations(to ? [from.connectedFolderRoot, to.connectedFolderRoot] : [from.connectedFolderRoot], async () => {
    reserveCapabilityMutation(state, from.id, "project", from.id);
    try {
      // One touch of the source when the move ends, not one per item it removes.
      return await runSettledConnectedFolderDeletion(state, from.id, () => withConnectedFolderTouchBatch(async () => {
        const root = from.connectedFolderRoot;
        const place: TransferPlaceRef = { kind: "connected-folder", id: from.id };
        const named = new Map(sources.flatMap((source) => source.name ? [[source.relativePath, source.name] as const] : []));
        const entries: MoveEntry[] = [];
        const nested = await nestedFoldersOf(from);
        for (const path of outermostConnectedFolderPaths(sources.map((source) => source.relativePath))) {
          const entry = await resolveConnectedFolderDeleteTarget(root, path);
          await assertSourceClearOfNestedFolders(nested, entry.absolutePath, entry.path);
          const name = named.get(entry.path);
          entries.push({ absolutePath: entry.absolutePath, path: entry.path, place, ...(name ? { name } : {}) });
        }
        const plan = await planMove(entries, target, policy, to ? connectedFolderMayChange(to) : standardMayChange(target.place!.id as StandardFolderId));
        if (!to || !planReplaces(plan)) return moveRows(state, from, to, entries, plan, target, operation, policy);
        // Replacing deletes items in the target, so it waits for the target's work too.
        reserveCapabilityMutation(state, to.id, "project", to.id);
        try {
          return await runSettledConnectedFolderDeletion(state, to.id, () => moveRows(state, from, to, entries, plan, target, operation, policy));
        } finally {
          state.capabilityMutations.delete(to.id);
        }
      }));
    } finally {
      state.capabilityMutations.delete(from.id);
    }
  });
}

/**
 * A move from plain folders into a Connected Folder: a copy into the target,
 * carrying any `.amplefile` identity a disconnected Connected Folder keeps,
 * under one restore point there, then each original is removed, as Finder
 * removes it after a move across disks. Nothing goes to the system Trash:
 * the item is not deleted, it is in the Connected Folder, where History has
 * it from then on, and Undo moves it back.
 *
 * An original goes only once its copy is whole (every folder, every file at
 * the same size and time, every link, and any `.amplefile` it carried), and
 * only while no Connected Folder owns it or sits inside it, which is checked
 * before anything is copied and again as it goes. Each removal is journaled
 * first, as `files.move` from the main window. An original that cannot go
 * stays, and the answer says so.
 *
 * A plain folder has no Worker, so nothing there is waited for; replacing an
 * item in the target waits for the target's outstanding work, as any
 * replacement there does. Cancel, failure, and conflict choices behave as in
 * a move out of a Connected Folder.
 */
async function moveIntoConnectedFolder(
  state: LocalApiState,
  sources: readonly ResolvedTransferItem[],
  target: ResolvedTransferItem,
  operation: FileOperationControl,
  policy: ConflictPolicy | null,
) {
  const to = target.connectedFolder!;
  for (const source of sources) {
    if (!source.relativePath || source.relativePath === ".") throw badRequest(`${standardFolderName(source.place!.id as StandardFolderId)} itself can’t be moved into ${to.name}. Choose the items inside it.`);
  }
  // An item inside another selected item moves with it.
  const outermost = sources.filter((item, index) => !sources.some((other, at) => at !== index && isInside(other.abs, item.abs) && (at < index || !isInside(item.abs, other.abs))));
  const entries: MoveEntry[] = outermost.map((item) => ({ absolutePath: item.abs, path: item.relativePath, place: item.place!, ...(item.name ? { name: item.name } : {}) }));
  const plan = await planMove(entries, target, policy, connectedFolderMayChange(to));
  // One touch of the target when the move ends, not one per item it replaces.
  const move = () => withConnectedFolderTouchBatch(() => moveRows(state, null, to, entries, plan, target, operation, policy));
  return planReplaces(plan) ? withSettledReplace(state, to, move) : withConnectedFolderHistoryOperations([to.connectedFolderRoot], move);
}

/** Where each item of a move between places goes; a move carries `.amplefile`. */
function planMove(entries: readonly MoveEntry[], target: ResolvedTransferItem, policy: ConflictPolicy | null, mayChange: (path: string) => Promise<boolean>): Promise<PlacementPlan> {
  return planPlacements(entries.map((entry) => ({ source: entry.absolutePath, key: entry.path, ...(entry.name ? { name: entry.name } : {}) })), target.abs, policy, {
    withIdentity: true,
    move: true,
    mayChange,
  });
}

/**
 * The copy, then the removal of each moved item from its source, for a move
 * that crosses places: out of a Connected Folder (`from`), into one (`to`),
 * or both. A Connected Folder source leaves through its delete; a plain
 * source is removed once its copy is whole (`removeMovedPlainSource`). When
 * only one side is a Connected Folder, History holds only that side, so the
 * answer also lists each item that moved (`moves`) for Undo to move back.
 */
async function moveRows(
  state: LocalApiState,
  from: ConnectedFolderSummary | null,
  to: ConnectedFolderSummary | null,
  entries: readonly MoveEntry[],
  plan: PlacementPlan,
  target: ResolvedTransferItem,
  operation: FileOperationControl,
  policy: ConflictPolicy | null,
) {
  const toRoot = transferTargetRoot(target);
  const names = entries.map((entry) => entry.path);
  const listsMoves = !from || !to;
  // The items that leave the source: each top-level item, or for a merged
  // folder each item inside it that is placed or replaces one.
  const rows = plan.units.map((unit, index) => ({ unit, index })).filter((row) => row.unit.action !== "skip");
  /** An item's path in the place it comes from. */
  const rowPath = (unit: PlacementUnit) => {
    const entry = entries[unit.top]!;
    return [entry.path, relativeTo(entry.absolutePath, unit.source)].filter(Boolean).join("/");
  };
  const extras = (executed: ExecutedPlacement) => policy ? placementResult(plan, executed, toRoot, names).extras : {};
  const noMoves = listsMoves ? { moves: [] as TransferMove[] } : {};
  const nothingMoved = () => ({
    mode: "move" as const,
    written: [] as string[],
    ...noMoves,
    restorePoints: [] as TransferRestorePoint[],
    cancelled: true as const,
    notDone: entries.map((entry) => entry.path),
    ...(policy ? { replaced: [], skipped: [], merged: [] } : {}),
  });
  const executed: ExecutedPlacement = { staged: plan.units.map(() => null), cancelled: false, replaced: [], restorePoints: [] };
  if (!rows.length) return { mode: "move" as const, written: [] as string[], ...noMoves, restorePoints: [] as TransferRestorePoint[], ...extras(executed) };
  try {
    if (operation.operationId) {
      for (const row of rows) {
        const measured = await measureCopy(row.unit.source, { withIdentity: true, operation });
        operation.addTotals(measured.items, measured.bytes);
      }
    }
  } catch (error) {
    if (isFileOperationCancelled(error)) return nothingMoved();
    throw error;
  }
  const label = entries.length === 1 ? `Before moving ${basename(entries[0]!.absolutePath)}` : `Before moving ${entries.length} items`;
  // A Connected Folder source keeps a restore point for everything about to leave it.
  const safety = from ? await createConnectedFolderMutationCheckpoint(from.connectedFolderRoot, {
    paths: rows.map((row) => rowPath(row.unit)),
    reason: "pre_move",
    label: `${label} to ${to?.name ?? transferTargetName(target)}`,
  }) : null;
  const discardSourcePoint = async () => {
    if (from && safety) await discardConnectedFolderCheckpoint(from.connectedFolderRoot, safety.checkpointId).catch(() => undefined);
  };
  // History names the files it could not keep the way it names its
  // capture roots; each one belongs to exactly one item.
  const capturedAs = from ? rows.map((row) => relative(ensureSafeConnectedFolderRoot(from.connectedFolderRoot), row.unit.source).split(sep).join("/")) : [];
  const notKept = rows.map((): AmpleFileRecentlyDeletedUncoveredPath[] => []);
  for (const file of safety?.skippedFiles ?? []) {
    const row = capturedAs.findIndex((path) => file.path === path || file.path.startsWith(`${path}/`));
    if (row < 0) {
      await discardSourcePoint();
      throw new AmpleFileCliError("failure", `AmpleFile could not tell which item ${file.path} belongs to. Nothing was moved.`);
    }
    notKept[row]!.push({ path: file.path, reason: file.reason });
  }

  const staged = executed.staged;
  const stagedAt = (row: { index: number }) => staged[row.index]!;
  // What the copy read of each source, entry by entry, before it read it:
  // an original is erased only while it is still exactly that.
  const read: CopiedSource = new Map();
  try {
    operation.stage("copying");
    // A moved folder keeps its `.amplefile` identity and Chats: registered
    // Connected Folders were refused before this, so it is only ever a
    // disconnected one, and the original is about to go.
    for (const row of rows) {
      await operation.boundary("item");
      staged[row.index] = await stageUnit(row.unit, { mode: "copy", withIdentity: true, operation, read });
    }
  } catch (error) {
    for (const row of rows) if (staged[row.index]) await takeBackUnit(staged[row.index]!).catch(() => undefined);
    await discardSourcePoint();
    if (isFileOperationCancelled(error)) return nothingMoved();
    throw error;
  }
  // Where each item is in the target: its name, or for a replacement still to commit, the name it will take.
  const finalPath = (row: { unit: PlacementUnit; index: number }) => relativeTo(toRoot, stagedAt(row).committed ? stagedAt(row).at! : row.unit.destination);
  // What History could not keep is safe when the copy holds all of it (a
  // `.git`, an ignored build folder, a large file, a link), checked file
  // by file. Anything else, and any `.amplefile` identity, keeps the item
  // out of a plain delete: it leaves the source whole, by moving into
  // Recently Deleted.
  const uncovered = await Promise.all(rows.map(async (row, position) => {
    const missing: AmpleFileRecentlyDeletedUncoveredPath[] = [];
    for (const file of notKept[position]!) {
      const inside = (file.path === capturedAs[position] ? "" : file.path.slice(capturedAs[position]!.length + 1)).split("/").filter(Boolean);
      const identity = inside.some((segment) => segment === ".amplefile");
      if (identity || !await copyHoldsAll(join(row.unit.source, ...inside), join(stagedAt(row).at!, ...inside))) missing.push(file);
    }
    return missing;
  }));
  const replacing = rows.filter((row) => row.unit.action === "replace");
  let targetSafety: ConnectedFolderCheckpoint | null = null;
  if (to) {
    try {
      // With replacements, the target's restore point is taken before any item
      // there is replaced, so it captures each of them.
      targetSafety = replacing.length
        ? await createConnectedFolderMutationCheckpoint(toRoot, {
          paths: replacing.map((row) => relativeTo(toRoot, row.unit.destination)),
          deleteOnRestore: rows.map(finalPath),
          reason: "pre_move",
          label,
        })
        : await checkpointAdditiveWritesOrUndo(toRoot, rows.map(finalPath), { reason: "pre_move", label });
    } catch (error) {
      if (replacing.length) for (const row of rows) await takeBackUnit(stagedAt(row)).catch(() => undefined);
      await discardSourcePoint();
      throw error;
    }
  }
  const restorePoints: TransferRestorePoint[] = [
    ...(to && targetSafety ? [{ connectedFolderId: to.id, checkpointId: targetSafety.checkpointId }] : []),
    ...(from && safety ? [{ connectedFolderId: from.id, checkpointId: safety.checkpointId }] : []),
  ];
  const recentlyDeleted: Array<{ path: string; entryId: string; restoreBy: string }> = [];
  // Which items have left their source: only those count as moved.
  const moved = new Set<number>();
  // Which items could not leave their source, are whole there, and have their copy in the target too.
  const inBoth = new Set<number>();
  /** Every item that did not move, and why. */
  const failures: Array<{ path: string; error: string }> = [];
  /** Items that moved, but part of whose original could not be removed and is still in the source. */
  const partlyRemoved: Array<{ path: string; error: string }> = [];
  const duplicateIdentities: string[] = [];
  // Whether a replacement was begun. From then on the target's restore point
  // may be the only thing that brings back the item it took the place of
  // (a replacement can fail after that item went), so it is never discarded
  // or narrowed.
  let replacementBegun = false;
  const result = (stop: Record<string, unknown>) => {
    // An item is in the target when it moved, or when it stayed in its source and its copy stayed too.
    const view: ExecutedPlacement = { ...executed, staged: staged.map((unit, index) => unit && (moved.has(index) || inBoth.has(index)) ? unit : null) };
    const outcome = placementResult(plan, view, toRoot, names);
    return {
      mode: "move" as const,
      written: outcome.written,
      ...(listsMoves ? { moves: rows.filter((row) => moved.has(row.index)).map((row): TransferMove => ({ from: rowPath(row.unit), fromPlace: entries[row.unit.top]!.place, to: relativeTo(toRoot, stagedAt(row).at!) })) } : {}),
      restorePoints,
      ...(recentlyDeleted.length ? { recentlyDeleted } : {}),
      ...(policy ? outcome.extras : {}),
      // `failed` is the first failure, as an answer with one failure always gave it.
      ...(failures.length ? { failed: failures[0]!, failures } : {}),
      ...(inBoth.size ? { notRemoved: rows.filter((row) => inBoth.has(row.index)).map((row) => rowPath(row.unit)) } : {}),
      ...(partlyRemoved.length ? { partlyRemoved } : {}),
      ...(duplicateIdentities.length ? { duplicateIdentities } : {}),
      ...stop,
    };
  };
  const changedWhileCopied = (source: string) => httpError(409, `“${basename(source)}” changed while it was being copied, so it stays where it was.`);
  operation.stage("removing");
  for (const [position, row] of rows.entries()) {
    try {
      await operation.boundary("remove");
    } catch (error) {
      if (!isFileOperationCancelled(error)) throw error;
      return stopMoveBeforeRemoving(position);
    }
    const source = row.unit.source;
    operation.current(basename(source));
    // Whether the removal began: only then can part of the original be gone.
    let removing = false;
    try {
      // An original that is gone by now has nothing to remove: the item is where the move put it.
      const there = Boolean(await lstat(source).catch(() => null));
      // An item that leaves a Connected Folder whole, for Recently Deleted,
      // loses nothing whatever it holds by now. Any other original is erased,
      // so it goes only while it is still the item that was copied (the same
      // files, unchanged since the copy read them), the copy holds all of
      // it, and no folder of it stands in the way of removing all of it.
      // All three are checked before the copy replaces anything.
      const erased = there && (!from || !uncovered[position]!.length);
      if (erased && !(await sourceUnchanged(source, read) && await copyHoldsAll(source, stagedAt(row).at!, { withIdentity: true }))) throw changedWhileCopied(source);
      if (erased) await assertRemovableWhole(source);
      if (row.unit.action === "replace") {
        replacementBegun = true;
        const committed = await commitUnit(stagedAt(row), to ? (path) => disposeInConnectedFolder(state, to, targetSafety!, path) : disposeToSystemTrash, { mode: "copy" });
        if (committed.replaced) executed.replaced.push(committed.replaced);
      }
      if (there && from) {
        // Each item leaving the source is that Connected Folder's delete,
        // with the delete's own receipt, as the delete routes record it.
        const movedTo = to ? to.id : "a plain folder";
        const { value: removed } = await runDesktopSettingsAct(state, "files.delete", async (requestId) => {
          // Rechecked as it goes.
          if (erased && !await sourceUnchanged(source, read)) throw changedWhileCopied(source);
          removing = true;
          const value = await applyConnectedFolderDelete(state, from, rowPath(row.unit), uncovered[position]!, safety!.checkpointId, { receiptId: requestId });
          return {
            value,
            detail: value.recovery.kind === "recently-deleted"
              ? `Connected Folder ${from.id}; moved to ${movedTo}; trash ${value.recovery.entryId}`
              : `Connected Folder ${from.id}; moved to ${movedTo}; checkpoint ${value.safetyCheckpointId}`,
          };
        });
        if (removed.recovery.kind === "recently-deleted") recentlyDeleted.push({ path: rowPath(row.unit), entryId: removed.recovery.entryId, restoreBy: removed.recovery.restoreBy });
      } else if (there) {
        await removeMovedPlainSource(state, to!, entries[row.unit.top]!, source, read, targetSafety?.checkpointId ?? null, () => { removing = true; });
      }
      moved.add(row.index);
    } catch (error) {
      // A release across volumes that failed partway still left a whole
      // copy in Recently Deleted; it is listed with the rest.
      const kept = (error as { recentlyDeleted?: { entryId: string; restoreBy: string } }).recentlyDeleted;
      if (kept) recentlyDeleted.push({ path: rowPath(row.unit), entryId: kept.entryId, restoreBy: kept.restoreBy });
      // A removal is not all-or-nothing. When part of the original went
      // before it failed, the whole item is only in the target: it counts as
      // moved, so Undo moves it back and never takes the copy away, and what
      // is left in the source is named.
      if (removing && await sourceLostPart(source, read)) {
        moved.add(row.index);
        partlyRemoved.push({ path: rowPath(row.unit), error: errorMessage(error) });
        continue;
      }
      // Otherwise the original is where it was, all of it, and the next item
      // still goes. A replacement not yet made is taken back, so the item
      // there stays. A copy already placed stays, so the item is in both
      // places: without a copied identity whose original is whole in the
      // source (no identity exists twice); one that could not be removed
      // from the copy is named, not hidden.
      failures.push({ path: rowPath(row.unit), error: errorMessage(error) });
      const copy = stagedAt(row);
      if (!copy.committed) { await takeBackUnit(copy).catch(() => undefined); staged[row.index] = null; continue; }
      inBoth.add(row.index);
      const left = await removeIdentityFoldersKeptAt(copy.at!, source).catch(() => [copy.at!]);
      duplicateIdentities.push(...left.map((path) => relativeTo(toRoot, path)));
    }
  }
  await removeEmptiedMergeSources(plan);
  if (!moved.size && !inBoth.size && !replacementBegun) {
    // Nothing is in the target and nothing left the source: no restore point has anything to put back.
    if (to && targetSafety) await discardConnectedFolderCheckpoint(toRoot, targetSafety.checkpointId).catch(() => undefined);
    await discardSourcePoint();
    restorePoints.splice(0, restorePoints.length);
  }
  return result({});

  /**
   * A cancel before item `position` leaves its source: that item and the
   * rest stay where they are and their copies go, so none of them is in two
   * places. With no replacement made yet, a target Connected Folder's
   * restore point is narrowed to what is in the target (a new one first, so
   * the old one is discarded only once it is replaced); with nothing there,
   * every restore point goes. Once a replacement was begun, the target's
   * restore point is kept as taken. Once an item was replaced the target's restore point
   * stays as taken: it captured every item to be replaced, and those not
   * replaced are unchanged.
   */
  async function stopMoveBeforeRemoving(position: number) {
    // A copy that cannot be taken back stays, named, and keeps the target's
    // first restore point, which covers it; its identity goes as when an
    // item cannot leave its source.
    const leftInTarget: string[] = [];
    for (const rest of rows.slice(position)) {
      const copy = stagedAt(rest);
      try {
        await takeBackUnit(copy);
        staged[rest.index] = null;
      } catch {
        leftInTarget.push(relativeTo(toRoot, copy.at!));
        const left = await removeIdentityFoldersKeptAt(copy.at!, rest.unit.source).catch(() => [copy.at!]);
        duplicateIdentities.push(...left.map((path) => relativeTo(toRoot, path)));
      }
    }
    const notDone = entries.filter((_, top) => rows.some((rest) => rest.unit.top === top && !moved.has(rest.index))).map((entry) => entry.path);
    if (leftInTarget.length) return result({ cancelled: true, notDone, leftInTarget });
    // What is in the target: the items that moved, and the copies of items that could not leave their source.
    const movedPaths = rows.filter((rest) => moved.has(rest.index) || inBoth.has(rest.index)).map(finalPath);
    if (!movedPaths.length && !replacementBegun) {
      if (to && targetSafety) await discardConnectedFolderCheckpoint(toRoot, targetSafety.checkpointId).catch(() => undefined);
      await discardSourcePoint();
      restorePoints.splice(0, restorePoints.length);
      return result({ cancelled: true, notDone });
    }
    if (to && targetSafety && movedPaths.length && !replacementBegun) {
      const narrowed = await createConnectedFolderMutationCheckpoint(toRoot, { deleteOnRestore: movedPaths, reason: "pre_move", label }).catch(() => null);
      if (narrowed) {
        await discardConnectedFolderCheckpoint(toRoot, targetSafety.checkpointId).catch(() => undefined);
        restorePoints.splice(0, 1, { connectedFolderId: to.id, checkpointId: narrowed.checkpointId });
      }
    }
    return result({ cancelled: true, notDone });
  }
}

/**
 * Takes an item a move copied into a Connected Folder out of the plain
 * folder it came from. The removal is journaled before it happens
 * (`files.move`, the main window's surface) and rechecked as it happens: it
 * is refused, leaving the original whole, when a Connected Folder has come
 * to own the top-level item it belongs to or to sit inside it, when the
 * original is no longer exactly what the copy read, or when a folder of it
 * cannot be changed. The journal records a refusal or a failure as the
 * act's error.
 *
 * `began` is called as the removal starts. Removing a folder is not
 * all-or-nothing, so a failure after that may have taken part of the
 * original; the caller asks what is left (`sourceLostPart`) before it says
 * where the item is.
 */
async function removeMovedPlainSource(
  state: LocalApiState,
  to: ConnectedFolderSummary,
  entry: MoveEntry,
  absolutePath: string,
  read: CopiedSource,
  checkpointId: string | null,
  began: () => void,
): Promise<void> {
  const name = basename(absolutePath);
  await runDesktopSettingsAct(state, "files.move", async () => {
    const top = await assertStandardFolderPathUnowned(entry.place.id as StandardFolderId, entry.path, userHomedir(), { finalLink: true });
    if (!isInside(top, absolutePath)) throw httpError(409, `“${name}” is not where it was, so it stays.`);
    if (!await sourceUnchanged(absolutePath, read)) throw httpError(409, `“${name}” changed while it was being copied, so it stays where it was.`);
    await assertRemovableWhole(absolutePath);
    began();
    try {
      await rm(absolutePath, { recursive: true, force: false });
    } catch (error) {
      const reason = removalFailure(error);
      throw httpError(409, await sourceLostPart(absolutePath, read)
        ? `Part of “${name}” could not be removed: ${reason}. What is left of it is still where it was; all of it is in ${to.name}.`
        : `“${name}” could not be removed: ${reason}. It stays where it was.`);
    }
    return { value: null, detail: `Connected Folder ${to.id}; moved in from a plain folder${checkpointId ? `; checkpoint ${checkpointId}` : ""}` };
  });
}

/**
 * Refuses to start removing an original that could not go whole: a folder in
 * it, or the folder it is in, cannot be changed (src/local/file-transfer.ts,
 * `folderBlockingRemoval`). The original's own permissions are the person's;
 * they are never widened to remove it.
 */
async function assertRemovableWhole(source: string): Promise<void> {
  const blocked = await folderBlockingRemoval(source);
  if (!blocked) return;
  const name = basename(source);
  if (comparablePath(blocked) === comparablePath(source)) throw httpError(409, `“${name}” can’t be changed, so it stays where it was.`);
  throw httpError(409, isInside(source, blocked)
    ? `“${basename(blocked)}” in “${name}” can’t be changed, so “${name}” stays where it was.`
    : `“${basename(blocked) || blocked}”, the folder “${name}” is in, can’t be changed, so “${name}” stays where it was.`);
}

/** Why a removal failed, in a few words: the item it stopped at when the disk names one. */
function removalFailure(error: unknown): string {
  const { code, path } = error as { code?: string; path?: unknown };
  const at = typeof path === "string" && path ? basename(path) : null;
  if ((code === "EPERM" || code === "EACCES") && at) return `“${at}” is locked or can’t be changed`;
  return errorMessage(error).replace(/\.$/u, "");
}

async function compressEntries(body: { place?: unknown; paths?: unknown; operationId?: unknown }) {
  const operationId = parseFileOperationId(body.operationId);
  return runFileOperation(operationId, "compress", async (operation) => {
    const place = transferPlace(body.place);
    if (!Array.isArray(body.paths) || !body.paths.length || body.paths.some((path) => typeof path !== "string" || !path.trim())) throw badRequest("Choose items to compress.");
    const items = await Promise.all((body.paths as string[]).map((path) => resolveTransferItem(place, path, "read")));
    const folder = dirname(items[0]!.abs);
    const folderRelative = items[0]!.relativePath.includes("/") ? items[0]!.relativePath.slice(0, items[0]!.relativePath.lastIndexOf("/")) : "";
    const target = await resolveTransferItem(place, folderRelative, "target");
    let archive: string;
    try {
      archive = await compressInto(items.map((item) => item.abs), folder, operation);
    } catch (error) {
      // A cancelled Compress wrote nothing: its working file is gone.
      if (isFileOperationCancelled(error)) return { path: null, restorePoints: [] as TransferRestorePoint[], cancelled: true as const };
      throw error;
    }
    const root = target.connectedFolder?.connectedFolderRoot ?? standardFolderRoot(place.id as StandardFolderId);
    const path = relativeTo(root, archive);
    const safety = target.connectedFolder
      ? await checkpointAdditiveWritesOrUndo(target.connectedFolder.connectedFolderRoot, [path], { reason: "pre_compress", label: `Before compressing ${items.length === 1 ? basename(items[0]!.abs) : `${items.length} items`}` })
      : null;
    return { path, restorePoints: safety ? [{ connectedFolderId: target.connectedFolder!.id, checkpointId: safety.checkpointId }] : [] };
  }, (result) => "cancelled" in result ? "cancelled" : "succeeded");
}

/**
 * Extract (src/local/archive-extract.ts): a `.zip`, `.tar`, `.tar.gz`, or
 * `.tgz` in a Connected Folder or Standard Folder becomes a new folder beside
 * it, with a restore point in a Connected Folder. A cancelled or refused
 * Extract writes nothing. `conflicts` works as for a transfer, keyed by the
 * new folder's name: a skipped Extract reads nothing, and a replaced or
 * merged one is extracted first and placed last.
 */
async function extractEntry(state: LocalApiState, body: { place?: unknown; path?: unknown; operationId?: unknown; conflicts?: unknown }) {
  const operationId = parseFileOperationId(body.operationId);
  const conflicts = parseConflictRequest(body.conflicts);
  const resolveArchive = async () => {
    const place = transferPlace(body.place);
    if (typeof body.path !== "string" || !body.path.trim()) throw badRequest("Choose an archive to extract.");
    const item = await resolveTransferItem(place, body.path, "read");
    // A link to an archive is extracted from the archive itself, where it really is.
    if ((await lstat(item.abs).catch(() => null))?.isSymbolicLink()) throw badRequest("This is a link. Show the original to extract the archive it points to.");
    await assertExtractable(item.abs);
    const folderRelative = item.relativePath.includes("/") ? item.relativePath.slice(0, item.relativePath.lastIndexOf("/")) : "";
    const target = await resolveTransferItem(place, folderRelative, "target");
    const name = extractFolderName(basename(item.abs));
    return { place, item, target, name, destination: join(dirname(item.abs), name) };
  };
  if (conflicts.check) {
    const { item, name, destination } = await resolveArchive();
    const archive = await lstat(item.abs);
    const existing = await lstat(destination).catch(() => null);
    if (!existing) return { conflicts: [] as TransferConflict[] };
    return {
      conflicts: [{
        key: name,
        name,
        source: { kind: "folder" as const, sizeBytes: null, modifiedAt: archive.mtime.toISOString() },
        existing: await summarize(destination, existing),
        canMerge: existing.isDirectory(),
        // A check does not read the archive, so what would clash inside is not counted: the dialog asks without a number.
        ...(existing.isDirectory() ? { insideClashes: null } : {}),
      }],
    };
  }
  return runFileOperation(operationId, "extract", async (operation) => {
    const { place, item, target, name, destination } = await resolveArchive();
    const root = target.connectedFolder?.connectedFolderRoot ?? standardFolderRoot(place.id as StandardFolderId);
    const policy = conflicts.policy;
    const choice = policy ? chosenForItem(policy, name) ?? policy.apply ?? "keep-both" : "keep-both";
    // A skipped Extract reads nothing.
    if (choice === "skip" && await lstat(destination).catch(() => null)) {
      return { path: null, restorePoints: [] as TransferRestorePoint[], replaced: [], merged: [], skippedClashes: [{ path: relativeTo(root, destination), reason: "chosen" as const }] };
    }
    let staged: StagedExtract;
    try {
      staged = await stageExtract(item.abs, operation);
    } catch (error) {
      if (isFileOperationCancelled(error)) return { path: null, restorePoints: [] as TransferRestorePoint[], cancelled: true as const };
      throw error;
    }
    try {
      const plan = await planPlacements([{ source: staged.folder, key: name, name }], staged.parent, policy, {
        newItems: true,
        mayChange: target.connectedFolder ? connectedFolderMayChange(target.connectedFolder) : standardMayChange(place.id as StandardFolderId),
      });
      const label = `Before extracting ${basename(item.abs)}`;
      const placeExtracted = async () => {
        const executed = await executePlacement(plan, {
          run: { mode: "move", operation: untrackedProgress(operation) },
          target: { root, connectedFolder: target.connectedFolder },
          state,
          history: "additive",
          reason: "pre_extract",
          label,
        });
        if (executed.failed) throw Object.assign(new Error(executed.failed.error), { status: 500, statusCode: 500 });
        const result = placementResult(plan, executed, root, [name]);
        return {
          path: result.written[0] ?? null,
          restorePoints: executed.restorePoints,
          files: staged.files,
          folders: staged.folders,
          links: staged.links,
          bytes: staged.bytes,
          ...(staged.skipped.length ? { skipped: staged.skipped } : {}),
          ...(policy ? { replaced: result.extras.replaced, merged: result.extras.merged, skippedClashes: result.extras.skipped } : {}),
        };
      };
      operation.stage("finishing");
      return target.connectedFolder && planReplaces(plan) ? await withSettledReplace(state, target.connectedFolder, placeExtracted) : await placeExtracted();
    } finally {
      await staged.discard();
    }
  }, (result) => "cancelled" in result ? "cancelled" : "succeeded");
}

/**
 * Placing what an Extract wrote is quick renames under the finishing stage:
 * the operation's stage and totals stay as the extraction left them.
 */
function untrackedProgress(operation: FileOperationControl): FileOperationControl {
  return {
    get operationId() { return operation.operationId; },
    get cancelRequested() { return false; },
    stage: () => undefined,
    addTotals: () => undefined,
    setTotals: () => undefined,
    current: () => undefined,
    itemsDone: () => undefined,
    bytesDone: () => undefined,
    boundary: async () => undefined,
  };
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
