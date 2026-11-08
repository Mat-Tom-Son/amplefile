import { ApiError, apiUrl } from "./api";

/** A file through any place's raw-file route (a Connected Folder's or a standard folder's), as a `blob:` URL. */
export async function rawFileObjectUrlAt(apiBase: string, path: string, signal?: AbortSignal): Promise<string> {
  return URL.createObjectURL(await sessionBlob(apiUrl(`${apiBase}/raw-file?path=${encodeURIComponent(path)}`), signal));
}

/** The same file's bytes, for a caller that keeps them (a `blob:` URL cannot be fetched back under the renderer's policy). */
export async function connectedFolderRawFileBlob(connectedFolderId: string, path: string, signal?: AbortSignal): Promise<Blob> {
  return sessionBlob(apiUrl(`/api/connected-folders/${connectedFolderId}/raw-file?path=${encodeURIComponent(path)}`), signal);
}

/**
 * A picture generate_image made, from AmpleFile's machine-local store.
 * Rejects with a 404 ApiError when the picture is not on this
 * computer, for example in a Chat that traveled.
 */
export async function generatedImageBlob(imageId: string, signal?: AbortSignal): Promise<Blob> {
  return sessionBlob(apiUrl(`/api/generated-images/${encodeURIComponent(imageId)}`), signal);
}

async function sessionBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const sessionHeaders = await window.ampleFileDesktop?.api.getSessionHeaders?.();
  const response = await fetch(url, { headers: sessionHeaders ?? {}, signal });
  if (!response.ok) throw new ApiError(response.status, response.statusText || `Request failed (${response.status}).`);
  return response.blob();
}
