import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { buildFixtureFolderAutomations } from "../fixtures/connected-folder-fixture";
import type { FolderAutomationsResponse, FolderAutomationView } from "../../../src/shared/automation-presentation";

const automationsChanged = "amplefile:automations-changed";

/** Refresh Connected Folder views after an Automation action in this renderer. */
export function notifyFolderAutomationsChanged(): void {
  window.dispatchEvent(new Event(automationsChanged));
}

export function folderAutomationsPath(connectedFolderId: string): string {
  return `/api/connected-folders/${encodeURIComponent(connectedFolderId)}/automations`;
}

/**
 * The automations whose trigger or steps name a Connected Folder, cached per Connected Folder
 * (docs/automations.md). The active Connected Folder is read when it changes
 * and whenever the window regains focus. The preview reads fixture data and
 * never touches the network.
 */
export function useFolderAutomations(activeConnectedFolderId: string, fixtureMode: boolean) {
  const [byConnectedFolder, setByConnectedFolder] = useState<Record<string, FolderAutomationView[]>>(
    () => fixtureMode ? buildFixtureFolderAutomations() : {},
  );
  const requestRef = useRef<Record<string, number>>({});

  const refresh = useCallback(async (connectedFolderId: string): Promise<void> => {
    if (fixtureMode) return;
    const request = (requestRef.current[connectedFolderId] ?? 0) + 1;
    requestRef.current[connectedFolderId] = request;
    try {
      const response = await api<FolderAutomationsResponse>(folderAutomationsPath(connectedFolderId));
      if (requestRef.current[connectedFolderId] !== request) return;
      setByConnectedFolder((current) => sameAutomations(current[connectedFolderId], response.automations)
        ? current
        : { ...current, [connectedFolderId]: response.automations });
    } catch {
      // A failed read keeps the last known list; the next focus retries.
    }
  }, [fixtureMode]);

  useEffect(() => {
    if (fixtureMode) return;
    void refresh(activeConnectedFolderId);
    const onFocus = () => { void refresh(activeConnectedFolderId); };
    const onChange = () => {
      for (const connectedFolderId of new Set([activeConnectedFolderId, ...Object.keys(requestRef.current)])) void refresh(connectedFolderId);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(automationsChanged, onChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(automationsChanged, onChange);
    };
  }, [activeConnectedFolderId, fixtureMode, refresh]);

  return { byConnectedFolder, refresh };
}

function sameAutomations(left: FolderAutomationView[] | undefined, right: FolderAutomationView[]): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}
