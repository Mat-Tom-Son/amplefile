import { apiUrl } from "./api";

/** A Files row removed from the tree while its Undo is offered; the host deletes it when that window closes. */
export interface PendingDelete {
  connectedFolderId: string;
  path: string;
  name: string;
  selectedPath: string | null;
  deletedTabPaths: Set<string>;
  /** Rows deleted together from Files' selection share one id and go to the host in one request. */
  batchId?: number;
}

/**
 * A delete always goes through (docs/receipts-not-gates.md, F20). `recentlyDeleted` is
 * present when History could not keep a copy of everything, so the entry is
 * waiting in Settings → Recently Deleted instead of being gone.
 */
export interface DeleteLocalFileResult {
  recentlyDeleted?: { entryId: string; restoreBy: string; uncoveredCount: number };
}

/**
 * Several rows under one History restore point. `failed` is set when a row
 * failed after earlier rows were deleted; the rows after it were left alone.
 */
export interface DeleteLocalFilesResult {
  deleted: Array<{ path: string; kind: "file" | "folder" } & DeleteLocalFileResult>;
  safetyCheckpointId: string;
  failed?: { path: string; error: string };
  notDeleted?: string[];
}

export async function deleteLocalFileRequest(pending: PendingDelete, keepalive = false): Promise<DeleteLocalFileResult> {
  // A delete History could not fully keep a copy of still succeeds: the
  // entry is waiting in Recently Deleted instead (docs/receipts-not-gates.md).
  return await sendDeleteRequest<DeleteLocalFileResult>(`/api/connected-folders/${pending.connectedFolderId}/local-file`, { path: pending.path }, keepalive) ?? {};
}

/** Several rows in one request: one History restore point, while each row keeps its own receipt and recovery. */
export async function deleteLocalFilesRequest(connectedFolderId: string, paths: readonly string[], keepalive = false): Promise<DeleteLocalFilesResult> {
  const result = await sendDeleteRequest<DeleteLocalFilesResult>(`/api/connected-folders/${connectedFolderId}/local-files`, { paths }, keepalive);
  if (!result) throw new Error("The delete finished without an answer. Refresh Files to see what changed.");
  return result;
}

/** Deletes use fetch rather than `api()` so keepalive can carry them while the window closes. */
async function sendDeleteRequest<T>(path: string, body: unknown, keepalive: boolean): Promise<T | null> {
  const sessionHeaders = await window.ampleFileDesktop?.api.getSessionHeaders?.();
  const response = await fetch(apiUrl(path), {
    method: "DELETE",
    headers: { "content-type": "application/json", ...(sessionHeaders ?? {}) },
    body: JSON.stringify(body),
    keepalive,
  });
  if (response.ok) {
    try { return await response.json() as T; } catch { return null; }
  }
  let message = response.statusText || `Request failed (${response.status}).`;
  try { message = (await response.json() as { error?: string }).error || message; } catch { /* keep the status message */ }
  throw new Error(message);
}
