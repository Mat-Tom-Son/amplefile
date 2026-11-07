import {
  restrictedAppOpenedFrom,
  restrictedAppRoute,
  restrictedAppState,
  type RestrictedAppOpenedFrom,
} from "../../../src/shared/restricted-app-navigation";
import type { RestrictedAppInstalled, ConnectedFolderRailMode, ConnectedFolderSummary } from "../types";

export interface RestrictedAppOpenRequest {
  connectedFolderId: string;
  appId: string;
  digest: string;
  featureInstallationId: string;
  permissionId: string;
  /** Where the app asked a click on this notification to open its left-pane view. */
  route?: string;
  state?: unknown;
}

/**
 * Where a notification click opens an app's left-pane view. The rail button
 * always opens the app at "/" with no state; a notification click opens the
 * same view, never a tab, at the route and state the app named.
 */
export interface RestrictedAppNavigatorTarget {
  mode: ConnectedFolderRailMode;
  route: string;
  state?: unknown;
  openedFrom: RestrictedAppOpenedFrom;
}

export function restrictedAppRailMode(connectedFolderId: string, appId: string, featureInstallationId: string): ConnectedFolderRailMode {
  return `app:restricted:${connectedFolderId}:${appId}:${featureInstallationId}`;
}

export function resolveRestrictedAppOpenRequest(
  request: RestrictedAppOpenRequest,
  connectedFolders: readonly ConnectedFolderSummary[],
): { connectedFolder: ConnectedFolderSummary; mode: ConnectedFolderRailMode; target: RestrictedAppNavigatorTarget } | null {
  if (!request.connectedFolderId || !request.appId || !request.digest || !request.featureInstallationId || !request.permissionId) return null;
  const connectedFolder = connectedFolders.find((item) => item.id === request.connectedFolderId);
  if (!connectedFolder) return null;
  let openedFrom: RestrictedAppOpenedFrom | null;
  try {
    openedFrom = restrictedAppOpenedFrom({ kind: "notification", permissionId: request.permissionId });
  } catch {
    return null;
  }
  if (!openedFrom) return null;
  const mode = restrictedAppRailMode(connectedFolder.id, request.appId, request.featureInstallationId);
  let route = "/";
  let state: unknown;
  try {
    route = request.route === undefined ? "/" : restrictedAppRoute(request.route);
    state = request.state === undefined ? undefined : restrictedAppState(request.state);
  } catch {
    // The host checked these already; a destination that no longer parses
    // still opens the app, at its home.
    route = "/";
    state = undefined;
  }
  return { connectedFolder, mode, target: { mode, route, ...(state !== undefined ? { state } : {}), openedFrom } };
}

/** Only disambiguate a preview when its installed sibling is also in this rail. */
export function restrictedAppRailLabel(app: RestrictedAppInstalled, apps: readonly RestrictedAppInstalled[]): string {
  return app.runtimeInstanceKind === "development" && apps.some((peer) => peer.manifest.id === app.manifest.id && peer.featureInstallationId !== app.featureInstallationId)
    ? `${app.manifest.title} · Preview` : app.manifest.title;
}
