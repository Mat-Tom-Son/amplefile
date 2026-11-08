
import type { TreeEntry } from "../types";

export function findTreeEntry(entries: TreeEntry[], path: string): TreeEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    if (entry.kind === "folder" && entry.children?.length) {
      const found = findTreeEntry(entry.children, path);
      if (found) return found;
    }
  }
  return null;
}

export function eventPathTouchesFolder(eventPath: string, folderPath: string): boolean {
  return eventPath === folderPath || eventPath.startsWith(`${folderPath}/`) || parentFolderPath(eventPath) === folderPath;
}

export function fileExtension(path: string): string {
  const match = /\.[^.\\/]+$/.exec(path);
  return match ? match[0].toLowerCase() : "";
}

export function parentFolderPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}
