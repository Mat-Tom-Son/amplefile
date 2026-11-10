/**
 * History routes: restore points, previews, reading and comparing versions,
 * and restoring a restore point or a file.
 */

import {
  createConnectedFolderCheckpoint,
  listConnectedFolderCheckpoints,
  listConnectedFolderCheckpointPage,
  listFileVersionPage,
  restoreFileVersion,
  restoreConnectedFolderCheckpoint,
  previewConnectedFolderCheckpointRestore,
} from "../history.js";
import { compareHistoryFile, readHistoryFile } from "../history-review.js";
import { getConnectedFolder } from "../connected-folder.js";
import { badRequest, match, optionalBoundedInteger, readJsonBody, sendJson } from "./http.js";
import { runHistoryRestore } from "./reservations.js";
import type { LocalApiRequest } from "./state.js";

/** History: restore points, previews, reading and comparing versions, and restoring files. */
export async function handleHistoryRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  const checkpointCollectionMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/checkpoints$/);
  if (checkpointCollectionMatch && method === "GET") {
    const connectedFolder = await getConnectedFolder(checkpointCollectionMatch[1]);
    sendJson(res, await listConnectedFolderCheckpointPage(connectedFolder.connectedFolderRoot, { cursor: url.searchParams.get("cursor") ?? undefined, limit: optionalBoundedInteger(url.searchParams.get("limit"), "limit") }));
    return true;
  }
  if (checkpointCollectionMatch && method === "POST") {
    const connectedFolder = await getConnectedFolder(checkpointCollectionMatch[1]);
    const body = await readJsonBody<{ label?: string }>(state, req);
    const existingIds = new Set((await listConnectedFolderCheckpoints(connectedFolder.connectedFolderRoot, 1000)).map((checkpoint) => checkpoint.checkpointId));
    const checkpoint = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, { label: body.label, reason: "manual" });
    const created = !existingIds.has(checkpoint.checkpointId);
    sendJson(res, { checkpoint, created }, created ? 201 : 200);
    return true;
  }
  const checkpointRestoreMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/checkpoints\/([^/]+)\/restore$/);
  if (method === "POST" && checkpointRestoreMatch) {
    const connectedFolder = await getConnectedFolder(checkpointRestoreMatch[1]);
    sendJson(res, await runHistoryRestore(state, connectedFolder, () => restoreConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, checkpointRestoreMatch[2])));
    return true;
  }

  const checkpointPreviewMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/checkpoints\/([^/]+)\/preview$/);
  if (method === "GET" && checkpointPreviewMatch) {
    const connectedFolder = await getConnectedFolder(checkpointPreviewMatch[1]);
    sendJson(res, { preview: await previewConnectedFolderCheckpointRestore(connectedFolder.connectedFolderRoot, checkpointPreviewMatch[2]) });
    return true;
  }

  const historyReviewMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/(read|diff)$/);
  if (method === "GET" && historyReviewMatch) {
    const connectedFolder = await getConnectedFolder(historyReviewMatch[1]);
    const path = url.searchParams.get("path")?.trim();
    if (!path) throw badRequest("A Connected Folder–relative file path is required.");
    if (historyReviewMatch[2] === "read") {
      const checkpointId = url.searchParams.get("checkpointId")?.trim();
      if (!checkpointId) throw badRequest("A checkpointId is required.");
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once("aborted", abort); res.once("close", abort);
      try {
        const review = await readHistoryFile(connectedFolder.connectedFolderRoot, {
          path, checkpointId, signal: controller.signal,
          offsetBytes: optionalBoundedInteger(url.searchParams.get("offsetBytes"), "offsetBytes"),
          lengthBytes: optionalBoundedInteger(url.searchParams.get("lengthBytes"), "lengthBytes"),
          expectedSha256: url.searchParams.get("expectedSha256") ?? undefined,
        });
        if (!controller.signal.aborted && !res.destroyed) sendJson(res, { review });
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { req.off("aborted", abort); res.off("close", abort); }
    } else {
      const fromCheckpointId = url.searchParams.get("fromCheckpointId")?.trim();
      if (!fromCheckpointId) throw badRequest("A fromCheckpointId is required.");
      const toCheckpointId = url.searchParams.get("toCheckpointId")?.trim();
      sendJson(res, { comparison: await compareHistoryFile(connectedFolder.connectedFolderRoot, {
        path, fromCheckpointId, ...(toCheckpointId ? { toCheckpointId } : {}),
      }) });
    }
    return true;
  }

  const fileVersionsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/file-versions$/);
  if (method === "GET" && fileVersionsMatch) {
    const connectedFolder = await getConnectedFolder(fileVersionsMatch[1]);
    const path = url.searchParams.get("path")?.trim();
    if (!path) throw badRequest("A Connected Folder–relative file path is required.");
    sendJson(res, { path, ...await listFileVersionPage(connectedFolder.connectedFolderRoot, path, { cursor: url.searchParams.get("cursor") ?? undefined, limit: optionalBoundedInteger(url.searchParams.get("limit"), "limit") }) });
    return true;
  }
  if (method === "POST" && fileVersionsMatch) {
    const connectedFolder = await getConnectedFolder(fileVersionsMatch[1]);
    const body = await readJsonBody<{ path?: string; hashSha256?: string }>(state, req);
    if (!body.path?.trim() || !body.hashSha256?.trim()) throw badRequest("A file path and version hash are required.");
    sendJson(res, { result: await runHistoryRestore(state, connectedFolder, () => restoreFileVersion(connectedFolder.connectedFolderRoot, body.path!, body.hashSha256!)) });
    return true;
  }
  return false;
}
