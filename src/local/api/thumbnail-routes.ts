/**
 * Picture thumbnails and folder sizes for the file manager window, in every
 * kind of place: a Connected Folder, a Standard Folder, and the computer place.
 * Each resolves its path under the same policy as the place's `raw-file`
 * route: nothing outside the place, no symbolic link on the way, nothing in
 * `.amplefile/` or `.pi/`. Neither writes anything into the place.
 *
 *   GET /api/connected-folders/:id/thumbnail?path=…&size=64|128|256[&v=…]
 *   GET /api/standard-folders/:id/thumbnail?path=…&size=64|128|256[&v=…]
 *   GET /api/connected-folders/:id/folder-size?path=…[&fresh=1]
 *   GET /api/standard-folders/:id/folder-size?path=…[&fresh=1]
 *   GET /api/{connected-folders|standard-folders}/:id/entry-details?path=… (Linux)
 *
 * See thumbnails.ts and folder-size.ts for what each answers and its bounds.
 */

import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { getConnectedFolder, resolveConnectedFolderPath } from "../connected-folder.js";
import { isAlwaysHiddenConnectedFolderEntry } from "../connected-folder-ignore.js";
import { FolderSizes } from "../folder-size.js";
import { readLinuxEntryDetails } from "../linux-entry-details.js";
import { accessError, computerFolderId, isStandardFolderId, standardFolderPathBase, standardFolderRoot } from "../standard-folders.js";
import { isThumbnailSize, ThumbnailRefusedError, thumbnailServiceFor } from "../thumbnails.js";
import { badRequest, match, notFound, sendJson } from "./http.js";
import type { LocalApiRequest } from "./state.js";

const folderSizes = new FolderSizes();

export async function handleThumbnailRoutes({ req, res, url, method }: LocalApiRequest): Promise<boolean> {
  if (method !== "GET") return false;
  const found = match(url.pathname, /^\/api\/(connected-folders|standard-folders)\/([^/]+)\/(thumbnail|folder-size|entry-details)$/);
  if (!found) return false;
  const [, placeKind, placeId, route] = found as [string, "connected-folders" | "standard-folders", string, "thumbnail" | "folder-size" | "entry-details"];
  if (route === "entry-details" && process.platform !== "linux") return false;
  const relativePath = url.searchParams.get("path") ?? "";
  if (route === "entry-details" && !relativePath) throw badRequest("Choose an item to inspect.");
  const place = await resolvePlacePath(placeKind, placeId, relativePath, route);
  if (route === "entry-details") {
    try {
      sendJson(res, await readLinuxEntryDetails(place.path));
    } catch (error) {
      throw accessErrorFor(placeKind, placeId, error);
    }
    return true;
  }

  // The request going away (a tile scrolled out of view, the window moving on) stops the work.
  const controller = new AbortController();
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });

  if (route === "thumbnail") {
    const size = Number(url.searchParams.get("size") ?? "");
    if (!isThumbnailSize(size)) throw badRequest("size must be 64, 128, or 256.");
    if (!relativePath) throw badRequest("File path is required.");
    try {
      const answer = await thumbnailServiceFor().thumbnail({
        path: place.path,
        size,
        ...(place.connectedFolderRoot ? { connectedFolderRoot: place.connectedFolderRoot } : {}),
        ifNoneMatch: req.headers["if-none-match"] ?? null,
        signal: controller.signal,
      });
      // Naming the version the listing showed lets the window keep the answer without asking again.
      const cacheControl = url.searchParams.get("v") === answer.version ? "private, max-age=31536000, immutable" : "private, no-cache";
      if (answer.kind === "not-modified") {
        res.writeHead(304, { etag: answer.etag, "cache-control": cacheControl });
        res.end();
        return true;
      }
      res.writeHead(200, {
        "content-type": "image/webp",
        "content-length": answer.bytes.length,
        "content-disposition": "inline",
        etag: answer.etag,
        "cache-control": cacheControl,
      });
      res.end(answer.bytes);
    } catch (error) {
      if (controller.signal.aborted) { res.destroy(); return true; }
      if (error instanceof ThumbnailRefusedError) {
        sendRefusal(res, error);
        return true;
      }
      throw accessErrorFor(placeKind, placeId, error);
    }
    return true;
  }

  try {
    const size = await folderSizes.measure(place.path, { signal: controller.signal, fresh: url.searchParams.get("fresh") === "1" });
    sendJson(res, { folderSize: { path: relativePath, ...size } });
  } catch (error) {
    if (controller.signal.aborted) { res.destroy(); return true; }
    throw accessErrorFor(placeKind, placeId, error);
  }
  return true;
}

function sendRefusal(res: ServerResponse, error: ThumbnailRefusedError): void {
  const body = JSON.stringify({ error: error.message, reason: error.reason });
  res.writeHead(error.statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** The absolute path for a place's relative path, under the place's path policy; a policy refusal is a 400. */
async function resolvePlacePath(
  placeKind: "connected-folders" | "standard-folders",
  placeId: string,
  relativePath: string,
  route: "thumbnail" | "folder-size" | "entry-details",
): Promise<{ path: string; connectedFolderRoot?: string }> {
  if (relativePath.includes("\0")) throw badRequest("Path escapes the selected folder.");
  // Info uses lstat, so it can read the final link's own metadata without following it.
  const finalLink = route === "entry-details";
  if (placeKind === "connected-folders") {
    const connectedFolder = await getConnectedFolder(placeId);
    return { path: policy(() => resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, relativePath, { finalLink })), connectedFolderRoot: connectedFolder.connectedFolderRoot };
  }
  if (!isStandardFolderId(placeId)) throw notFound("That standard folder isn’t on this computer.");
  // The first segment in the computer place is normally the path policy's own root.
  if (finalLink && placeId === computerFolderId && /^[^/\\]+$/.test(relativePath) && relativePath !== "." && relativePath !== ".."
    && !isAlwaysHiddenConnectedFolderEntry(relativePath)) {
    return { path: join(standardFolderRoot(placeId), relativePath) };
  }
  const base = policy(() => standardFolderPathBase(placeId, relativePath));
  // The computer place's top is the whole disk: no thumbnail, and no size to walk.
  if (!base) throw badRequest(route === "thumbnail" ? "File path is required." : "Choose a folder on the disk.");
  return { path: policy(() => resolveConnectedFolderPath(base.root, base.path, { finalLink })) };
}

function policy<T>(resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    if (typeof (error as { statusCode?: unknown })?.statusCode === "number") throw error;
    throw badRequest(error instanceof Error ? error.message : String(error));
  }
}

function accessErrorFor(placeKind: "connected-folders" | "standard-folders", placeId: string, error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return notFound("File not found.");
  if (placeKind === "standard-folders" && isStandardFolderId(placeId)) return accessError(error, placeId);
  if (code === "EACCES" || code === "EPERM") return Object.assign(new Error("AmpleFile isn’t allowed to read that item."), { statusCode: 403 });
  return error;
}
