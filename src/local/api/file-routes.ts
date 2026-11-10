/**
 * One Connected Folder's file routes (search, the tree, reading and saving,
 * generated pictures, moves, deletes, ignore rules, file events, uploads) and
 * the suggested messages written from the folder.
 */

import { createLocalEventSink } from "../local-event-stream.js";
import type { ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { listConversations } from "../agent/chat-store.js";
import { isGeneratedImageId } from "../agent/generated-image-store.js";
import { createConnectedFolderMutationCheckpoint } from "../history.js";
import { searchConnectedFolder } from "../search.js";
import { readConnectedFolderIgnoreState, setConnectedFolderIgnoreState } from "../connected-folder-ignore.js";
import {
  createConnectedFolderFolder,
  createConnectedFolderTextFile,
  findExistingConnectedFolderFilePaths,
  getConnectedFolder,
  getConnectedFolderEntryInfo,
  getConnectedFolderFilePreview,
  moveConnectedFolderEntry,
  readConnectedFolderTextFile,
  renameConnectedFolderEntry,
  resolveConnectedFolderPath,
  scanConnectedFolderTree,
  nestedRegisteredConnectedFolderPaths,
  writeConnectedFolderTextFile,
  writeUploadedFiles,
  type ConnectedFolderSummary,
} from "../connected-folder.js";
import { getClient } from "./conversation-clients.js";
import { openConnectedFolderFileStream } from "./event-streams.js";
import {
  deleteConnectedFolderEntriesWithRecovery,
  deleteConnectedFolderEntryWithRecovery,
  moveConnectedFolderEntriesWithHistory,
  normalizeConnectedFolderRelativePath,
} from "./file-changes.js";
import {
  badRequest,
  match,
  notFound,
  optionalBoundedInteger,
  parseRelativePaths,
  readJsonBody,
  readMultipartBody,
  sendJson,
} from "./http.js";
import { runDesktopSettingsAct } from "./prepared-act-adapters.js";
import { checkpointAdditiveWritesOrUndo, runWithHistorySafety } from "./reservations.js";
import type { LocalApiRequest, LocalApiState } from "./state.js";

/** Search inside one Connected Folder. */
export async function handleSearchRoutes({ req, res, url, method }: LocalApiRequest): Promise<boolean> {
  const searchMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/search$/);
  if (method === "GET" && searchMatch) {
    const connectedFolder = await getConnectedFolder(searchMatch[1]);
    const scope = url.searchParams.get("scope") ?? "all";
    if (scope !== "all" && scope !== "files" && scope !== "chats") throw badRequest("Search scope is unsupported.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const result = await searchConnectedFolder(connectedFolder.connectedFolderRoot, url.searchParams.get("q") ?? "", {
        includeFiles: scope !== "chats",
        includeChats: scope !== "files",
        signal: controller.signal,
        path: url.searchParams.get("path") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        maxMatches: optionalBoundedInteger(url.searchParams.get("limit"), "limit"),
      });
      if (!controller.signal.aborted && !res.destroyed) sendJson(res, result);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
    return true;
  }
  return false;
}

/** One Connected Folder's files: suggestions, the tree, reading and saving, generated pictures, moves, renames, new folders, added files, deletes, ignore rules, file events, and uploads. */
export async function handleFileRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // Suggested messages written from the folder: one bounded model call on the
  // Connected Folder's model over its names and recent Chat titles, kept until the folder or its Chats change.
  const suggestionsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/suggestions$/);
  if (method === "GET" && suggestionsMatch) {
    const connectedFolder = await getConnectedFolder(suggestionsMatch[1]);
    // The window drops this request when the person moves on; the model call
    // behind it stops with it.
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const suggestions = await folderSuggestions(state, connectedFolder, url.searchParams.get("path") ?? "", controller.signal);
      if (!controller.signal.aborted && !res.destroyed) sendJson(res, { suggestions });
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
    return true;
  }

  const treeMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/tree$/);
  if (method === "GET" && treeMatch) {
    const connectedFolder = await getConnectedFolder(treeMatch[1]);
    const maxDepthValue = Number(url.searchParams.get("maxDepth") ?? 20);
    const maxDepth = Number.isFinite(maxDepthValue) ? Math.min(Math.max(Math.floor(maxDepthValue), 0), 50) : 20;
    const scan = await scanConnectedFolderTree(
      connectedFolder.connectedFolderRoot,
      maxDepth,
      url.searchParams.get("path") ?? "",
      { includeIgnored: url.searchParams.get("includeIgnored") !== "0", nestedFolderPaths: await nestedRegisteredConnectedFolderPaths(connectedFolder.connectedFolderRoot) },
    );
    sendJson(res, { tree: scan.entries, truncated: scan.truncated });
    return true;
  }

  const fileMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/file$/);
  if (method === "GET" && fileMatch) {
    const connectedFolder = await getConnectedFolder(fileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    sendJson(res, await readConnectedFolderTextFile(connectedFolder.connectedFolderRoot, path));
    return true;
  }
  if (method === "PUT" && fileMatch) {
    const connectedFolder = await getConnectedFolder(fileMatch[1]);
    const body = await readJsonBody<{ path?: string; text?: string; expectedHashSha256?: unknown }>(state, req);
    if (!body.path?.trim() || typeof body.text !== "string") throw badRequest("A file path and text are required.");
    // The hash the editor read (GET returns it, and each save returns the
    // new one): a save over content that changed since is a 409, file untouched.
    const expectedHashSha256 = body.expectedHashSha256;
    if (expectedHashSha256 !== undefined && (typeof expectedHashSha256 !== "string" || !/^[0-9a-f]{64}$/iu.test(expectedHashSha256))) {
      throw badRequest("expectedHashSha256 must be the file's SHA-256 hash.");
    }
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      paths: [body.path],
      reason: "pre_edit",
      label: `Before editing ${body.path}`,
    });
    const file = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => writeConnectedFolderTextFile(connectedFolder.connectedFolderRoot, body.path!, body.text!, expectedHashSha256 === undefined ? {} : { expectedHashSha256 }));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return true;
  }

  const fileInfoMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/file-info$/);
  if (method === "GET" && fileInfoMatch) {
    const connectedFolder = await getConnectedFolder(fileInfoMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("Connected Folder item path is required.");
    const hash = await fileInfoHashWanted(connectedFolder.connectedFolderRoot, path, url.searchParams.get("hash"));
    sendJson(res, await getConnectedFolderEntryInfo(connectedFolder.connectedFolderRoot, path, { hash }));
    return true;
  }

  const filePreviewMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/file-preview$/);
  if (method === "GET" && filePreviewMatch) {
    const connectedFolder = await getConnectedFolder(filePreviewMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("Connected Folder item path is required.");
    sendJson(res, { preview: await getConnectedFolderFilePreview(connectedFolder.connectedFolderRoot, path) });
    return true;
  }

  const pathsExistMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/paths-exist$/);
  if (method === "POST" && pathsExistMatch) {
    const connectedFolder = await getConnectedFolder(pathsExistMatch[1]);
    const body = await readJsonBody<{ paths?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string")) {
      throw badRequest("Connected Folder paths must be an array of strings.");
    }
    sendJson(res, { existing: await findExistingConnectedFolderFilePaths(connectedFolder.connectedFolderRoot, body.paths) });
    return true;
  }

  // Pictures generate_image made: their bytes for a Chat to show,
  // what the Chat needs to offer Add to folder or Show in Files, and Add to folder.
  const generatedImageMatch = match(url.pathname, /^\/api\/generated-images\/([^/]+)$/);
  if (method === "GET" && generatedImageMatch) {
    const found = isGeneratedImageId(generatedImageMatch[1]) ? await state.generatedImages.read(generatedImageMatch[1]) : null;
    if (!found) throw notFound("This picture is not on this computer.");
    res.writeHead(200, {
      "content-type": found.record.mimeType,
      "content-length": found.bytes.length,
      "content-disposition": "inline",
      "cache-control": "private, max-age=31536000, immutable",
    });
    res.end(found.bytes);
    return true;
  }
  const connectedFolderImageMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/generated-images\/([^/]+)(\/add)?$/);
  if (connectedFolderImageMatch && (method === "GET" || (method === "POST" && connectedFolderImageMatch[3]))) {
    const connectedFolder = await getConnectedFolder(connectedFolderImageMatch[1]);
    const imageId = connectedFolderImageMatch[2]!;
    const record = isGeneratedImageId(imageId) ? await state.generatedImages.get(imageId) : null;
    if (!record) throw notFound("This picture is not on this computer.");
    const addedPath = record.added?.[connectedFolder.id];
    const stillThere = addedPath ? await state.generatedImages.matches(record, resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, addedPath)).catch(() => false) : false;
    if (method === "GET") {
      sendJson(res, { name: record.name, mimeType: record.mimeType, ...(stillThere ? { addedPath } : {}) });
      return true;
    }
    // Add to folder: the same additive write and restore point as an upload.
    if (stillThere) { sendJson(res, { path: addedPath, added: false }); return true; }
    const found = await state.generatedImages.read(imageId);
    if (!found) throw notFound("This picture is not on this computer.");
    const [written] = await writeUploadedFiles(connectedFolder.connectedFolderRoot, "", [{ fileName: record.name, data: found.bytes }]);
    await checkpointAdditiveWritesOrUndo(connectedFolder.connectedFolderRoot, [written!.path], {
      reason: "pre_upload",
      label: `Before adding ${record.name}`,
    });
    await state.generatedImages.noteAdded(imageId, connectedFolder.id, written!.path);
    sendJson(res, { path: written!.path, added: true }, 201);
    return true;
  }

  const rawFileMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/raw-file$/);
  if (method === "GET" && rawFileMatch) {
    const connectedFolder = await getConnectedFolder(rawFileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    await sendConnectedFolderRawFile(res, connectedFolder.connectedFolderRoot, path);
    return true;
  }

  const moveMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/move-local-entry$/);
  if (method === "POST" && moveMatch) {
    const connectedFolder = await getConnectedFolder(moveMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string; targetFolderPath?: string }>(state, req);
    if (!body.sourcePath?.trim()) throw badRequest("Select a file or folder to move.");
    const moveSource = normalizeConnectedFolderRelativePath(body.sourcePath);
    const moveTargetFolder = normalizeConnectedFolderRelativePath(body.targetFolderPath ?? "");
    const moveDestination = [moveTargetFolder, basename(moveSource)].filter(Boolean).join("/");
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      movesOnRestore: [{ fromPath: moveDestination, toPath: moveSource }],
      reason: "pre_move",
      label: `Before moving ${body.sourcePath}`,
    });
    const moved = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => moveConnectedFolderEntry(connectedFolder.connectedFolderRoot, {
      sourcePath: moveSource,
      targetFolderPath: body.targetFolderPath ?? "",
    }));
    sendJson(res, { moved, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return true;
  }

  // Several Files rows into one folder under one restore point.
  const moveManyMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/move-local-entries$/);
  if (method === "POST" && moveManyMatch) {
    const connectedFolder = await getConnectedFolder(moveManyMatch[1]);
    const body = await readJsonBody<{ sourcePaths?: unknown; targetFolderPath?: unknown }>(state, req);
    const sourcePaths = connectedFolderPathList(body.sourcePaths, "Select files or folders to move.");
    if (body.targetFolderPath !== undefined && typeof body.targetFolderPath !== "string") throw badRequest("Choose a folder to move them into.");
    const result = await moveConnectedFolderEntriesWithHistory(connectedFolder, sourcePaths, body.targetFolderPath ?? "");
    sendJson(res, result);
    return true;
  }

  const renameMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/rename-local-entry$/);
  if (method === "POST" && renameMatch) {
    const connectedFolder = await getConnectedFolder(renameMatch[1]);
    const body = await readJsonBody<{ path?: string; newName?: string }>(state, req);
    if (!body.path?.trim() || !body.newName?.trim()) throw badRequest("A Connected Folder item and new name are required.");
    const renameSource = normalizeConnectedFolderRelativePath(body.path);
    const renameParent = renameSource.includes("/") ? renameSource.slice(0, renameSource.lastIndexOf("/")) : "";
    const renameDestination = [renameParent, body.newName].filter(Boolean).join("/");
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      movesOnRestore: [{ fromPath: renameDestination, toPath: renameSource }],
      reason: "pre_rename",
      label: `Before renaming ${body.path}`,
    });
    const renamed = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => renameConnectedFolderEntry(connectedFolder.connectedFolderRoot, { path: body.path!, newName: body.newName! }));
    sendJson(res, { renamed, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return true;
  }

  const foldersMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/folders$/);
  if (method === "POST" && foldersMatch) {
    const connectedFolder = await getConnectedFolder(foldersMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A folder name is required.");
    const folderTarget = [normalizeConnectedFolderRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      deleteOnRestore: [folderTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const folder = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => createConnectedFolderFolder(connectedFolder.connectedFolderRoot, body.parentPath ?? "", body.name!));
    sendJson(res, { folder, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return true;
  }

  const filesMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/files$/);
  if (method === "POST" && filesMatch) {
    const connectedFolder = await getConnectedFolder(filesMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string; text?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A file name is required.");
    const fileTarget = [normalizeConnectedFolderRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      deleteOnRestore: [fileTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const file = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => createConnectedFolderTextFile(connectedFolder.connectedFolderRoot, body.parentPath ?? "", body.name!, body.text ?? ""));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return true;
  }

  const deleteMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/local-file$/);
  if (method === "DELETE" && deleteMatch) {
    const connectedFolder = await getConnectedFolder(deleteMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("Select a file or folder to delete.");
    // Every deletion the desktop performs leaves a receipt, and a delete
    // History cannot fully keep a copy of lands in Recently deleted rather
    // than being refused (docs/act-ledger.md).
    const removal = await runDesktopSettingsAct(state, "files.delete", async (requestId) => {
      const value = await deleteConnectedFolderEntryWithRecovery(state, connectedFolder, body.path!, { receiptId: requestId });
      return {
        value,
        detail: value.recovery.kind === "recently-deleted"
          ? `Connected Folder ${connectedFolder.id}; trash ${value.recovery.entryId}`
          : `Connected Folder ${connectedFolder.id}; checkpoint ${value.safetyCheckpointId}`,
      };
    });
    const { recovery, ...deleted } = removal.value;
    sendJson(res, {
      ...deleted,
      historySkippedPaths: recovery.kind === "recently-deleted" ? recovery.uncovered.map((file) => file.path) : [],
      ...(recovery.kind === "recently-deleted"
        ? { recentlyDeleted: { entryId: recovery.entryId, restoreBy: recovery.restoreBy, uncoveredCount: recovery.uncovered.length } }
        : {}),
    });
    return true;
  }

  // Several Files rows under one restore point: each row still
  // gets its own receipt and its own History or Recently deleted recovery.
  const deleteManyMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/local-files$/);
  if (method === "DELETE" && deleteManyMatch) {
    const connectedFolder = await getConnectedFolder(deleteManyMatch[1]);
    const body = await readJsonBody<{ paths?: unknown }>(state, req);
    const paths = connectedFolderPathList(body.paths, "Select files or folders to delete.");
    const result = await deleteConnectedFolderEntriesWithRecovery(state, connectedFolder, paths);
    sendJson(res, {
      deleted: result.deleted.map(({ recovery, ...row }) => ({
        ...row,
        ...(recovery.kind === "recently-deleted"
          ? { recentlyDeleted: { entryId: recovery.entryId, restoreBy: recovery.restoreBy, uncoveredCount: recovery.uncovered.length } }
          : {}),
      })),
      safetyCheckpointId: result.safetyCheckpointId,
      historySkippedPaths: result.deleted.flatMap((row) => row.recovery.kind === "recently-deleted" ? row.recovery.uncovered.map((file) => file.path) : []),
      ...(result.failed ? { failed: result.failed, notDeleted: result.notDeleted } : {}),
    });
    return true;
  }

  const ignoreMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/ignore-paths$/);
  if (method === "GET" && ignoreMatch) {
    const connectedFolder = await getConnectedFolder(ignoreMatch[1]);
    sendJson(res, await readConnectedFolderIgnoreState(connectedFolder.connectedFolderRoot));
    return true;
  }
  if (method === "POST" && ignoreMatch) {
    const connectedFolder = await getConnectedFolder(ignoreMatch[1]);
    const body = await readJsonBody<{ paths?: unknown; ignored?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string") || typeof body.ignored !== "boolean") {
      throw badRequest("Connected Folder paths and an ignore decision are required.");
    }
    sendJson(res, await setConnectedFolderIgnoreState(connectedFolder.connectedFolderRoot, body.paths, body.ignored));
    return true;
  }

  const fileEventsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/file-events$/);
  if (method === "GET" && fileEventsMatch) {
    const connectedFolder = await getConnectedFolder(fileEventsMatch[1]);
    await openConnectedFolderFileStream(state, createLocalEventSink(res), connectedFolder.connectedFolderRoot, fileEventsMatch[1]);
    return true;
  }

  const uploadMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/upload-local-files$/);
  if (method === "POST" && uploadMatch) {
    const connectedFolder = await getConnectedFolder(uploadMatch[1]);
    const multipart = await readMultipartBody(state, req);
    const relativePaths = parseRelativePaths(multipart.fields.get("relativePaths"), multipart.files.length);
    const uploaded = await writeUploadedFiles(
      connectedFolder.connectedFolderRoot,
      multipart.fields.get("targetFolderPath") ?? "",
      multipart.files.map((file, index) => ({ fileName: file.fileName, relativePath: relativePaths[index], data: file.data })),
    );
    const safety = await checkpointAdditiveWritesOrUndo(connectedFolder.connectedFolderRoot, uploaded.map((file) => file.path), {
      reason: "pre_upload",
      label: `Before uploading ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}`,
    });
    sendJson(res, { uploaded, safetyCheckpointId: safety?.checkpointId ?? null, historySkippedPaths: safety?.skippedLargeFiles ?? [] }, 201);
    return true;
  }
  return false;
}

/**
 * The per–Connected Folder client that carries bounded inference (the file
 * manager's folder suggestions). It is streamed, never prompted, so no Chat is
 * created and no transcript exists; the name only keeps it separate from the
 * Connected Folder's real conversations.
 */
const ampleFileInferenceConversationId = "amplefile.inference";

/** A JSON list of Connected Folder paths from a request body. */
function connectedFolderPathList(value: unknown, emptyMessage: string): string[] {
  if (!Array.isArray(value) || !value.length) throw badRequest(emptyMessage);
  if (value.some((path) => typeof path !== "string" || !path.trim())) throw badRequest("Each item must be a Connected Folder path.");
  return value as string[];
}

export async function sendConnectedFolderRawFile(res: ServerResponse, connectedFolderRoot: string, relativePath: string): Promise<void> {
  const path = resolveConnectedFolderPath(connectedFolderRoot, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  res.writeHead(200, {
    "content-type": contentTypeForPath(path),
    "content-length": info.size,
    "content-disposition": "inline",
  });
  if (!info.size) {
    res.end();
    return;
  }
  // A preview that changes aborts its fetch. pipeline() destroys the read
  // stream when the response closes, so an abandoned read never keeps the file
  // open, and the read stops at the length already promised to the client.
  await pipeline(createReadStream(path, { end: info.size - 1 }), res);
}

/**
 * Whether the file-info route reads a whole file to hash it. The Info panel
 * needs only its dates and size; the hash is compared with History's versions
 * of the file. A caller says `hash=1` or `hash=0`; otherwise a file is hashed
 * only when it is small enough for History to keep versions of it (the same
 * limit as history.ts), so selecting a multi-gigabyte file never reads it all.
 */
async function fileInfoHashWanted(connectedFolderRoot: string, path: string, requested: string | null): Promise<boolean> {
  if (requested === "1" || requested === "true") return true;
  if (requested === "0" || requested === "false") return false;
  let absolutePath: string;
  try { absolutePath = resolveConnectedFolderPath(connectedFolderRoot, path); } catch { return false; }
  const info = await stat(absolutePath).catch(() => null);
  return Boolean(info?.isFile() && info.size <= historyVersionedFileLimitBytes());
}

/** History's per-file limit for keeping versions; history.ts reads the same setting. */
function historyVersionedFileLimitBytes(): number {
  const configured = Number(process.env.AMPLEFILE_HISTORY_MAX_FILE_BYTES);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 100 * 1024 * 1024;
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".txt": return "text/plain; charset=utf-8";
    case ".md": case ".markdown": return "text/markdown; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".html": case ".htm": return "text/html; charset=utf-8";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

const folderSuggestionCache = new Map<string, { key: string; at: number; suggestions: string[] }>();
const folderSuggestionLifetimeMs = 30 * 60 * 1_000;

/**
 * Up to four short messages a person might send next, written by the
 * Connected Folder's own model from the folder's names (and the folder shown inside
 * it) and its recent Chat titles. Kept while those stay the same; an empty
 * list means "use the plain ones" (no model, or the call failed).
 */
async function folderSuggestions(state: LocalApiState, connectedFolder: ConnectedFolderSummary, path: string, signal?: AbortSignal): Promise<string[]> {
  const relativePath = normalizeConnectedFolderRelativePath(path);
  const scan = await scanConnectedFolderTree(connectedFolder.connectedFolderRoot, 0, relativePath, { includeIgnored: false, nestedFolderPaths: await nestedRegisteredConnectedFolderPaths(connectedFolder.connectedFolderRoot) }).catch(() => null);
  const entries = (scan?.entries ?? []).slice(0, 80).map((entry) => `${entry.kind === "folder" ? "folder" : "file"}: ${entry.name}${entry.updatedAt ? ` (changed ${entry.updatedAt.slice(0, 10)})` : ""}`);
  const chats = (await listConversations(connectedFolder.connectedFolderRoot).catch(() => [])).slice(0, 8).map((chat) => chat.title).filter(Boolean);
  const key = JSON.stringify([relativePath, entries, chats]);
  const cacheKey = `${connectedFolder.id}\0${relativePath}`;
  const cached = folderSuggestionCache.get(cacheKey);
  if (cached && cached.key === key && Date.now() - cached.at < folderSuggestionLifetimeMs) return cached.suggestions;
  if (signal?.aborted) return [];
  try {
    const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, ampleFileInferenceConversationId);
    const outcome = await client.infer({
      instructions: [
        "Suggest up to four short messages this person might send next to the assistant that works in this folder.",
        "Each is an instruction or question in their own words, 2 to 6 words, plain and specific to what is actually here (name real files or folders when it helps).",
        "No numbering, quotes, or emoji. Prefer useful work: tidy, summarize, find, compare, plan, draft. Don't suggest anything that deletes files.",
      ].join(" "),
      input: JSON.stringify({ folder: relativePath ? `${connectedFolder.name}/${relativePath}` : connectedFolder.name, items: entries, recentChats: chats }),
      outputSchema: {
        type: "object",
        properties: { suggestions: { type: "array", items: { type: "string", maxLength: 48 }, maxItems: 4 } },
        required: ["suggestions"],
        additionalProperties: false,
      } as never,
      maxOutputBytes: 2_048,
      ...(signal ? { signal } : {}),
    });
    // A call stopped because the window moved on says nothing about the folder.
    if (signal?.aborted) return [];
    const suggestions = outcome.kind === "json"
      ? ((outcome.json as { suggestions?: unknown }).suggestions as unknown[] ?? []).filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().replace(/[.]$/, "")).slice(0, 4)
      : [];
    folderSuggestionCache.set(cacheKey, { key, at: Date.now(), suggestions });
    return suggestions;
  } catch {
    return [];
  }
}
