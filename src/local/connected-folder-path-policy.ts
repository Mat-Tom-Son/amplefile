/**
 * Portable Connected Folder metadata and executable Pi configuration never belong to
 * ordinary Files, History, attachment, Check, or restricted-app payloads.
 * The predecessor apps' metadata folders (`.work-fold/` and `.workspace/`)
 * stay hidden the same way; AmpleFile never reads them.
 * Match case-insensitively on every platform so a package prepared on macOS
 * cannot expose a reserved Windows path after transfer.
 */
export function isReservedConnectedFolderPathSegment(segment: string): boolean {
  const normalized = segment.toLocaleLowerCase("en-US");
  return normalized === ".amplefile" || normalized === ".work-fold" || normalized === ".workspace" || normalized === ".pi";
}

export function containsReservedConnectedFolderPathSegment(path: string): boolean {
  return path.split(/[\\/]+/u).some(isReservedConnectedFolderPathSegment);
}
