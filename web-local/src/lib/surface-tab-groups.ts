import type { ConnectedFolderSurfaceTab } from "../types";

/**
 * Tabs grouped by the Connected Folder that owns them, in first-seen order.
 * Browser tabs belong to no Connected Folder and share one group, whose id is null.
 */
export function groupSurfaceTabsByConnectedFolder(
  tabs: ConnectedFolderSurfaceTab[],
): Array<{ connectedFolderId: string | null; tabs: ConnectedFolderSurfaceTab[] }> {
  const groups = new Map<string | null, ConnectedFolderSurfaceTab[]>();
  for (const tab of tabs) groups.set(tab.connectedFolderId, [...(groups.get(tab.connectedFolderId) ?? []), tab]);
  return [...groups.entries()]
    .map(([connectedFolderId, groupedTabs]) => ({ connectedFolderId, tabs: groupedTabs }));
}
