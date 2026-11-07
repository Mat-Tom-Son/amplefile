import type { ConnectedFolderSummary } from "../types";

export function connectedFolderHeaderSourceBadgeLabel(connectedFolder: ConnectedFolderSummary): string {
  if (connectedFolder.location.providerHint === "google-drive") return "Google Drive";
  return connectedFolder.location.storage === "linked" ? "Linked Folder" : "On This Computer";
}
export function surfaceDomIdSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (character) => `-${character.charCodeAt(0).toString(16)}-`);
}

export function surfaceTabDomId(tabId: string): string {
  return `surface-tab-${surfaceDomIdSuffix(tabId)}`;
}

export function surfacePanelDomId(tabId: string): string {
  return `surface-panel-${surfaceDomIdSuffix(tabId)}`;
}

export interface ConnectedFolderAppStudioRemovalSummary {
  project: unknown | null;
  previews: readonly unknown[];
  releases: readonly unknown[];
  operations: readonly unknown[];
  incomingPreparedOperationCount?: number;
}

export function removeConnectedFolderConfirmText(
  connectedFolder: ConnectedFolderSummary,
  appStudio?: ConnectedFolderAppStudioRemovalSummary,
): string {
  const folderOutcome = connectedFolder.location.storage === "linked"
    ? `${connectedFolder.name} stops being a Connected Folder. The folder and everything inside it stay where they are on your computer.`
    : `Delete ${connectedFolder.name} from this computer? Its managed folder — every file and folder inside it, and its Chats and History — `
      + "moves to Recently Deleted in Settings, where you can put it back until its time runs out.";
  if (!appStudio) return folderOutcome;
  const consequences: string[] = [];
  if (appStudio.project) {
    const appState = [
      formatRemovalCount(appStudio.previews.length, "Development preview"),
      formatRemovalCount(appStudio.releases.length, "Release"),
      formatRemovalCount(appStudio.operations.length, "prepared operation"),
    ].join(", ");
    consequences.push(`Its App Studio history on this computer (${appState}, with their receipts) moves to Recently Deleted too. Once the Connected Folder is back, you can put that back from there.`);
  }
  if (appStudio.incomingPreparedOperationCount) {
    consequences.push(`This also cancels ${formatRemovalCount(appStudio.incomingPreparedOperationCount, "prepared App operation")} aimed at this Connected Folder; ${appStudio.incomingPreparedOperationCount === 1 ? "it waits" : "they wait"} in Recently Deleted until the Connected Folder is back.`);
  }
  return consequences.length ? `${folderOutcome} ${consequences.join(" ")}` : folderOutcome;
}
function formatRemovalCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
