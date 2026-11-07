import { useEffect, useRef } from "react";

import type { useRestrictedApps } from "../../hooks/useRestrictedApps";
import { RestrictedAppsSection } from "../panes/RestrictedAppsSection";
import { showToast } from "../../ui/feedback";
import type { RestrictedAppInstalled, ConnectedFolderSummary } from "../../types";

export type RestrictedAppsState = ReturnType<typeof useRestrictedApps>;

/**
 * Settings → Apps (2026-09-25): every installed app, listed by the Connected Folder it
 * belongs to, with the grants, connections, automations, data, update and
 * removal controls the retired Connected Folder–owned Apps tab used to hold. Opening
 * an app itself still happens from its rail entry; each Connected Folder's group
 * heading opens that Connected Folder's App Studio.
 */
export function SettingsAppsPane({ connectedFolders, apps, fixtureMode = false, onChangeApp, onOpenBuildChat, onOpenResultFile, onOpenAppStudio }: {
  connectedFolders: ConnectedFolderSummary[];
  apps: RestrictedAppsState | null;
  fixtureMode?: boolean;
  onChangeApp?: (app: RestrictedAppInstalled) => void;
  onOpenBuildChat?: (connectedFolderId: string, conversationId: string) => void;
  onOpenResultFile?: (connectedFolderId: string, path: string) => void;
  onOpenAppStudio?: (connectedFolderId: string, runtimeInstanceId?: string) => void;
}) {
  const knownConnectedFolderIds = apps?.knownConnectedFolderIds;
  const loadingConnectedFolderIds = apps?.loadingConnectedFolderIds;
  const refresh = apps?.refresh;
  const attemptedConnectedFolderIds = useRef(new Set<string>());
  useEffect(() => {
    if (!refresh || !knownConnectedFolderIds || !loadingConnectedFolderIds) return;
    const registered = new Set(connectedFolders.map((connectedFolder) => connectedFolder.id));
    for (const id of attemptedConnectedFolderIds.current) if (!registered.has(id) || knownConnectedFolderIds.has(id)) attemptedConnectedFolderIds.current.delete(id);
    for (const connectedFolder of connectedFolders) {
      if (knownConnectedFolderIds.has(connectedFolder.id) || attemptedConnectedFolderIds.current.has(connectedFolder.id)) continue;
      // A failed read clears loading without making the catalog known. Record
      // the attempt (including a shared in-flight read) so that transition
      // exposes Retry instead of starting an unbounded request loop.
      attemptedConnectedFolderIds.current.add(connectedFolder.id);
      if (!loadingConnectedFolderIds.has(connectedFolder.id)) void refresh(connectedFolder.id);
    }
  }, [knownConnectedFolderIds, loadingConnectedFolderIds, refresh, connectedFolders]);

  const foldersWithApps = connectedFolders.filter((connectedFolder) => (apps?.appsByConnectedFolder[connectedFolder.id] ?? []).length > 0);
  const loading = connectedFolders.some((connectedFolder) => loadingConnectedFolderIds?.has(connectedFolder.id));
  const failedConnectedFolders = connectedFolders.filter((connectedFolder) => attemptedConnectedFolderIds.current.has(connectedFolder.id)
    && !knownConnectedFolderIds?.has(connectedFolder.id) && !loadingConnectedFolderIds?.has(connectedFolder.id));
  const report = (message: string | null) => { if (message) showToast({ text: message, tone: "error" }); };
  return (
    <section className="settings-section settings-apps" aria-labelledby="settings-apps-title">
      <h3 className="sr-only" id="settings-apps-title">Apps</h3>
      {!foldersWithApps.length && !failedConnectedFolders.length ? (
        <p className="settings-section-note">{loading ? "Loading apps…" : "No apps yet. Ask a Worker in a Chat to build one, and it shows up here."}</p>
      ) : null}
      {failedConnectedFolders.length ? <p className="settings-section-note" role="status">
        Could not load apps in {failedConnectedFolders.map((connectedFolder) => connectedFolder.name).join(", ")}.{" "}
        <button className="ui-control" type="button" onClick={() => {
          for (const connectedFolder of failedConnectedFolders) void refresh?.(connectedFolder.id);
        }}>Retry Loading Apps</button>
      </p> : null}
      {foldersWithApps.map((connectedFolder) => (
        <section className="settings-apps-folder" aria-label={`Apps in ${connectedFolder.name}`} key={connectedFolder.id}>
          <div className="settings-apps-folder-heading">
            <h4 className="settings-apps-folder-title">{connectedFolder.name}</h4>
            {/* App Studio is per work-folder, so each group offers it through
                the same open path the details dialog's "Open App Studio" uses. */}
            {onOpenAppStudio ? <button className="ui-control ui-control--quiet" type="button" aria-label={`Open App Studio for ${connectedFolder.name}`} onClick={() => onOpenAppStudio(connectedFolder.id)}>App Studio</button> : null}
          </div>
          <RestrictedAppsSection
            connectedFolder={connectedFolder}
            apps={apps?.appsByConnectedFolder[connectedFolder.id] ?? []}
            loading={Boolean(loadingConnectedFolderIds?.has(connectedFolder.id))}
            fixtureMode={fixtureMode}
            onChangeApp={onChangeApp ? async (app) => onChangeApp(app) : undefined}
            onOpenBuildChat={onOpenBuildChat ? async (connectedFolderId, conversationId) => onOpenBuildChat(connectedFolderId, conversationId) : undefined}
            onOpenResultFile={onOpenResultFile ? async (connectedFolderId, path) => onOpenResultFile(connectedFolderId, path) : undefined}
            onOpenAppStudio={(connectedFolderId, runtimeInstanceId) => onOpenAppStudio?.(connectedFolderId ?? connectedFolder.id, runtimeInstanceId)}
            onUpsertApp={(app) => apps?.upsertApp(app)}
            onRemoveApp={(featureInstallationId) => apps?.removeApp(connectedFolder.id, featureInstallationId)}
            onError={report}
          />
        </section>
      ))}
    </section>
  );
}
