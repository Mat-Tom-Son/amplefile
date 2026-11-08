import { api } from "./api";
import type { RestrictedAppAutomationRunReceipt, RestrictedAppConnectionStatus, RestrictedAppCredential, RestrictedAppInstalled, RestrictedAppStorageUsage, RestrictedAppDataRecovery, LocalAppInstallOperation, LocalAppPresentation, LocalAppProject, LocalAppRelease, LocalAppReleaseDeletionResult, LocalAppRetainedData, LocalAppUpdateOperation } from "../types";

function collectionPath(connectedFolderId: string): string {
  return `/api/connected-folders/${encodeURIComponent(connectedFolderId)}/restricted-apps`;
}

export interface RestrictedAppChangeDraft {
  id: string;
  sourceConnectedFolderId: string;
  sourcePath: string;
  appId: string;
  title: string;
  version: string;
  baseDigest: string;
  buildConversationId: string | null;
}

export interface RestrictedAppBuildContext {
  sourceConnectedFolderId: string;
  sourcePath: string | null;
  buildConversationId: string | null;
  updateTargetRuntimeInstanceId: string | null;
}

export async function getRestrictedAppBuildContext(app: RestrictedAppInstalled): Promise<RestrictedAppBuildContext> {
  return (await api<{ context: RestrictedAppBuildContext }>(`${collectionPath(app.connectedFolderId)}/${encodeURIComponent(app.manifest.id)}/build-context?expectedDigest=${encodeURIComponent(app.digest)}&featureInstallationId=${encodeURIComponent(app.featureInstallationId)}`)).context;
}

export async function prepareRestrictedAppChange(app: RestrictedAppInstalled, requestId: string): Promise<RestrictedAppChangeDraft> {
  return (await api<{ change: RestrictedAppChangeDraft }>(`${collectionPath(app.connectedFolderId)}/${encodeURIComponent(app.manifest.id)}/change`, {
    method: "POST", body: { requestId, expectedDigest: app.digest, featureInstallationId: app.featureInstallationId }, idempotent: true,
  })).change;
}

function proposalPath(connectedFolderId: string, conversationId: string, proposalId?: string): string {
  const collection = `/api/connected-folders/${encodeURIComponent(connectedFolderId)}/conversations/${encodeURIComponent(conversationId)}/restricted-app-proposals`;
  return proposalId ? `${collection}/${encodeURIComponent(proposalId)}` : collection;
}

function studioPath(connectedFolderId: string): string {
  return `/api/connected-folders/${encodeURIComponent(connectedFolderId)}/app-studio`;
}

export async function declareLocalAppProject(connectedFolderId: string, presentation: LocalAppPresentation): Promise<LocalAppProject> {
  return (await api<{ project: LocalAppProject }>(studioPath(connectedFolderId), {
    method: "PUT",
    body: presentation,
  })).project;
}

export async function prepareLocalAppRelease(connectedFolderId: string, displayVersion: string): Promise<LocalAppRelease> {
  return (await api<{ release: LocalAppRelease }>(`${studioPath(connectedFolderId)}/releases/prepare`, {
    method: "POST",
    body: { displayVersion },
  })).release;
}

export async function publishLocalAppRelease(connectedFolderId: string, releaseDigest: string): Promise<LocalAppRelease> {
  return (await api<{ release: LocalAppRelease }>(`${studioPath(connectedFolderId)}/releases/publish`, {
    method: "POST",
    body: { releaseDigest },
  })).release;
}

export async function deleteLocalAppRelease(
  connectedFolderId: string,
  releaseDigest: string,
): Promise<LocalAppReleaseDeletionResult> {
  return (await api<{ deletion: LocalAppReleaseDeletionResult }>(
    `${studioPath(connectedFolderId)}/releases/${encodeURIComponent(releaseDigest)}`,
    { method: "DELETE" },
  )).deletion;
}

export async function prepareLocalAppInstall(
  connectedFolderId: string,
  targetConnectedFolderId: string,
  releaseDigest: string,
): Promise<LocalAppInstallOperation> {
  return (await api<{ operation: LocalAppInstallOperation }>(`${studioPath(connectedFolderId)}/installs/prepare`, {
    method: "POST",
    body: { targetConnectedFolderId: targetConnectedFolderId, releaseDigest },
  })).operation;
}

export async function prepareLocalAppUpdate(
  connectedFolderId: string,
  runtimeInstanceId: string,
  releaseDigest: string,
  continuityPolicy: "eligible" | "reset" = "eligible",
): Promise<LocalAppUpdateOperation> {
  return (await api<{ operation: LocalAppUpdateOperation }>(`${studioPath(connectedFolderId)}/instances/${encodeURIComponent(runtimeInstanceId)}/updates/prepare`, {
    method: "POST",
    body: { releaseDigest, continuityPolicy },
  })).operation;
}

export async function cancelLocalAppOperation(connectedFolderId: string, operationId: string): Promise<boolean> {
  return (await api<{ cancelled: boolean }>(`${studioPath(connectedFolderId)}/operations/${encodeURIComponent(operationId)}`, {
    method: "DELETE",
  })).cancelled;
}

export async function uninstallLocalApp(
  targetConnectedFolderId: string,
  runtimeInstanceId: string,
  dataDisposition: "retain" | "purge",
): Promise<{ removed: boolean; retainedData: LocalAppRetainedData[]; cleanupPending: boolean }> {
  return api(`/api/connected-folders/${encodeURIComponent(targetConnectedFolderId)}/local-app-instances/${encodeURIComponent(runtimeInstanceId)}`, {
    method: "DELETE",
    body: { dataDisposition },
  });
}

export async function purgeLocalAppRetainedData(connectedFolderId: string, retainedDataId: string): Promise<{ purged: boolean; cleanupPending: boolean }> {
  return api(`${studioPath(connectedFolderId)}/retained-data/${encodeURIComponent(retainedDataId)}`, { method: "DELETE" });
}
export async function installRestrictedAppProposal(connectedFolderId: string, conversationId: string, proposalId: string): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${proposalPath(connectedFolderId, conversationId, proposalId)}/install`, { method: "POST" })).app;
}

export async function dismissRestrictedAppProposal(connectedFolderId: string, conversationId: string, proposalId: string): Promise<boolean> {
  return (await api<{ dismissed: boolean }>(proposalPath(connectedFolderId, conversationId, proposalId), { method: "DELETE" })).dismissed;
}

function appPath(connectedFolderId: string, appId: string): string {
  return `${collectionPath(connectedFolderId)}/${encodeURIComponent(appId)}`;
}

export async function listRestrictedApps(connectedFolderId: string): Promise<RestrictedAppInstalled[]> {
  return (await api<{ apps: RestrictedAppInstalled[] }>(collectionPath(connectedFolderId))).apps;
}

/**
 * Removing a preview takes its data with it, so the host leaves a recoverable
 * copy in Recently deleted first (docs/receipts-not-gates.md, F20) and names
 * the entry here.
 */
export async function removeRestrictedApp(
  app: RestrictedAppInstalled,
): Promise<{ removed: boolean; recentlyDeleted: { entryId: string; restoreBy: string } | null }> {
  return await api<{ removed: boolean; recentlyDeleted: { entryId: string; restoreBy: string } | null }>(appPath(app.connectedFolderId, app.manifest.id), {
    method: "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  });
}

export async function listRestrictedAppConnections(app: RestrictedAppInstalled): Promise<RestrictedAppConnectionStatus[]> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ connections: RestrictedAppConnectionStatus[] }>(`${appPath(app.connectedFolderId, app.manifest.id)}/connections?${query}`)).connections;
}

export async function setRestrictedAppNetworkGrant(
  app: RestrictedAppInstalled,
  destinationId: string,
  granted: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.connectedFolderId, app.manifest.id)}/permissions/network/${encodeURIComponent(destinationId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).app;
}

export async function setRestrictedAppFileGrant(
  app: RestrictedAppInstalled,
  permissionId: string,
  granted: boolean,
  root?: string,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.connectedFolderId, app.manifest.id)}/permissions/files/${encodeURIComponent(permissionId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, ...(granted ? { root } : {}) },
  })).app;
}

export async function listRestrictedAppAssistantTasks(app: RestrictedAppInstalled) {
  const query = new URLSearchParams({ featureInstallationId: app.featureInstallationId, expectedDigest: app.digest });
  return (await api<{ tasks: import("../../../src/shared/restricted-app-tasks").RestrictedAppAssistantTask[] }>(`${appPath(app.connectedFolderId, app.manifest.id)}/assistant-tasks?${query}`)).tasks;
}

export async function readRestrictedAppAssistantTask(app: RestrictedAppInstalled, requestId: string) {
  const query = new URLSearchParams({ featureInstallationId: app.featureInstallationId, expectedDigest: app.digest });
  return (await api<{ detail: import("../../../src/shared/restricted-app-tasks").RestrictedAppTaskDetail }>(`${appPath(app.connectedFolderId, app.manifest.id)}/assistant-tasks/${encodeURIComponent(requestId)}?${query}`)).detail;
}

export async function cancelRestrictedAppAssistantTask(app: RestrictedAppInstalled, requestId: string) {
  return (await api<{ task: import("../../../src/shared/restricted-app-tasks").RestrictedAppAssistantTask }>(`${appPath(app.connectedFolderId, app.manifest.id)}/assistant-tasks/${encodeURIComponent(requestId)}/cancel`, {
    method: "POST", body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).task;
}

/**
 * Bounded inference receipts for this installation, across code changes
 * (docs/receipts-not-gates.md, F22: disclosure is after the fact). Every
 * `assistant.infer` call leaves one, with the effective model and its usage.
 */
export async function listRestrictedAppInferenceReceipts(app: RestrictedAppInstalled) {
  const query = new URLSearchParams({ featureInstallationId: app.featureInstallationId, expectedDigest: app.digest });
  return (await api<{ receipts: import("../../../src/shared/restricted-app-inference").RestrictedAppInferenceReceipt[] }>(
    `${appPath(app.connectedFolderId, app.manifest.id)}/inference-receipts?${query}`,
  )).receipts;
}

/**
 * What this installation's notifications did, newest first, across code
 * changes: shown, held back by the spam guard, or unavailable on this computer.
 */
export async function listRestrictedAppNotificationRecord(app: RestrictedAppInstalled, limit?: number) {
  const query = new URLSearchParams({
    featureInstallationId: app.featureInstallationId,
    expectedDigest: app.digest,
    ...(limit === undefined ? {} : { limit: String(limit) }),
  });
  return (await api<{ receipts: import("../../../src/shared/restricted-app-notification-record").RestrictedAppNotificationRecordEntry[] }>(
    `${appPath(app.connectedFolderId, app.manifest.id)}/notification-receipts?${query}`,
  )).receipts;
}

export async function setRestrictedAppNotificationGrant(
  app: RestrictedAppInstalled,
  permissionId: string,
  granted: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.connectedFolderId, app.manifest.id)}/permissions/notifications/${encodeURIComponent(permissionId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).app;
}

export async function setRestrictedAppAutomationEnabled(
  app: RestrictedAppInstalled,
  appAutomationId: string,
  enabled: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.connectedFolderId, app.manifest.id)}/automations/${encodeURIComponent(appAutomationId)}`, {
    method: enabled ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).app;
}

export async function runRestrictedAppAutomationNow(
  app: RestrictedAppInstalled,
  appAutomationId: string,
): Promise<{ app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt }> {
  return api<{ app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt }>(`${appPath(app.connectedFolderId, app.manifest.id)}/automations/${encodeURIComponent(appAutomationId)}/run`, {
    method: "POST",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  });
}

export async function listRestrictedAppAutomationRuns(
  app: RestrictedAppInstalled,
  appAutomationId: string,
): Promise<RestrictedAppAutomationRunReceipt[]> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ runs: RestrictedAppAutomationRunReceipt[] }>(`${appPath(app.connectedFolderId, app.manifest.id)}/automations/${encodeURIComponent(appAutomationId)}/runs?${query}`)).runs;
}

export async function getRestrictedAppStorageUsage(app: RestrictedAppInstalled): Promise<RestrictedAppStorageUsage> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(app.connectedFolderId, app.manifest.id)}/storage?${query}`)).usage;
}

export async function clearRestrictedAppStorage(app: RestrictedAppInstalled): Promise<RestrictedAppStorageUsage> {
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(app.connectedFolderId, app.manifest.id)}/storage`, {
    method: "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).usage;
}

export async function exportRestrictedAppData(app: RestrictedAppInstalled): Promise<unknown> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ backup: unknown }>(`${appPath(app.connectedFolderId, app.manifest.id)}/storage/export?${query}`)).backup;
}

export async function getRestrictedAppDataRecovery(app: RestrictedAppInstalled): Promise<RestrictedAppDataRecovery | null> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ recovery: RestrictedAppDataRecovery | null }>(`${appPath(app.connectedFolderId, app.manifest.id)}/storage/recovery?${query}`)).recovery;
}

export async function restoreRestrictedAppData(app: RestrictedAppInstalled, expectedRevision: number, source: { backup: unknown } | { recoveryId: string }): Promise<RestrictedAppStorageUsage> {
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(app.connectedFolderId, app.manifest.id)}/storage/restore`, {
    method: "POST", body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, expectedRevision, ...source },
  })).usage;
}

export async function setRestrictedAppConnection(
  app: RestrictedAppInstalled,
  destinationId: string,
  credential: RestrictedAppCredential,
): Promise<RestrictedAppConnectionStatus> {
  return (await api<{ connection: RestrictedAppConnectionStatus }>(`${appPath(app.connectedFolderId, app.manifest.id)}/connections/${encodeURIComponent(destinationId)}`, {
    method: "PUT",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, credential },
  })).connection;
}

export async function connectRestrictedAppOAuth(
  app: RestrictedAppInstalled,
  destinationId: string,
): Promise<RestrictedAppConnectionStatus> {
  return (await api<{ connection: RestrictedAppConnectionStatus }>(`${appPath(app.connectedFolderId, app.manifest.id)}/connections/${encodeURIComponent(destinationId)}/oauth`, {
    method: "POST",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).connection;
}

export async function deleteRestrictedAppConnection(app: RestrictedAppInstalled, destinationId: string): Promise<boolean> {
  return (await api<{ removed: boolean }>(`${appPath(app.connectedFolderId, app.manifest.id)}/connections/${encodeURIComponent(destinationId)}`, {
    method: "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).removed;
}
