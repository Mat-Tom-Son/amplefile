import { dirname } from "node:path";

/** A folder or file the system handed over, and how it opens: selected in its parent folder, in a window of its own. */
export interface FileManagerOpenPath {
  path: string;
  reveal: boolean;
  newWindow: boolean;
}

/** At most this many windows open for one request. */
export const maximumWindowsPerRequest = 8;

/**
 * One Finder request: macOS hands over every item of it as its own open-file
 * event, one after another in the same turn. The first opens in the most
 * recently focused window; each further folder opens in a window of its own,
 * as Finder does, up to `maximumWindowsPerRequest`. Files in one folder share
 * that folder's window, the first of them selected, and a path named twice
 * opens once.
 */
export function finderOpenPaths(paths: readonly string[], isFolder: (path: string) => boolean): FileManagerOpenPath[] {
  const opened = new Set<string>();
  const chosen: FileManagerOpenPath[] = [];
  for (const path of paths) {
    const window = isFolder(path) ? path : dirname(path);
    if (opened.has(window)) continue;
    opened.add(window);
    chosen.push({ path, reveal: false, newWindow: chosen.length > 0 });
    if (chosen.length >= maximumWindowsPerRequest) break;
  }
  return chosen;
}
