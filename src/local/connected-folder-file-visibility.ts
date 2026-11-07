import { lstat } from "node:fs/promises";
import { getConnectedFolder, nestedRegisteredConnectedFolderPaths, resolveConnectedFolderPath } from "./connected-folder.js";
import { isConnectedFolderIgnored, readConnectedFolderIgnoreState } from "./connected-folder-ignore.js";

/**
 * Whether a file a Worker reported is still a visible file of its Connected Folder:
 * a regular file (not a link), not ignored, and not inside a nested
 * Connected Folder. Metadata only; nothing is read.
 */
export async function isConnectedFolderFileVisible(connectedFolderId: string, relativePath: string): Promise<boolean> {
  try {
    const connectedFolder = await getConnectedFolder(connectedFolderId);
    const path = await visiblePath(connectedFolderId, relativePath, connectedFolder.connectedFolderRoot);
    const file = await lstat(path);
    return file.isFile() && !file.isSymbolicLink() && await visiblePath(connectedFolderId, relativePath, connectedFolder.connectedFolderRoot) === path;
  } catch { return false; }
}

async function visiblePath(connectedFolderId: string, relativePath: string, expectedRoot: string): Promise<string> {
  if (typeof relativePath !== "string" || !relativePath || relativePath.length > 2048
    || relativePath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(relativePath)
    || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw unavailable();
  const current = await getConnectedFolder(connectedFolderId);
  if (current.connectedFolderRoot !== expectedRoot) throw unavailable();
  const path = resolveConnectedFolderPath(expectedRoot, relativePath);
  const [ignore, nested] = await Promise.all([readConnectedFolderIgnoreState(expectedRoot), nestedRegisteredConnectedFolderPaths(expectedRoot)]);
  if (isConnectedFolderIgnored(relativePath, ignore.patterns) || nested.some((root) => relativePath === root || relativePath.startsWith(`${root}/`))) throw unavailable();
  return path;
}

function unavailable(): Error {
  return new Error("This file is unavailable, changed, or is outside this Connected Folder's visible files.");
}
