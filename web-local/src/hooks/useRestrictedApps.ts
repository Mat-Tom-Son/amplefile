import { useCallback, useEffect, useRef, useState } from "react";

import { listRestrictedApps } from "../lib/restricted-apps";
import { subscribeControlEvents } from "../lib/control-events";
import type { RestrictedAppInstalled, ConnectedFolderSummary } from "../types";

const emptyRestrictedAppFixtures: Record<string, RestrictedAppInstalled[]> = {};

export function useRestrictedApps({
  activeConnectedFolderId,
  connectedFolders,
  fixtureMode = false,
  fixtureApps = emptyRestrictedAppFixtures,
  onError,
}: {
  activeConnectedFolderId: string;
  connectedFolders?: readonly Pick<ConnectedFolderSummary, "id">[];
  fixtureMode?: boolean;
  fixtureApps?: Record<string, RestrictedAppInstalled[]>;
  onError: (error: unknown) => void;
}) {
  const [appsByConnectedFolder, setAppsByConnectedFolder] = useState<Record<string, RestrictedAppInstalled[]>>(fixtureApps);
  const [knownConnectedFolderIds, setKnownConnectedFolderIds] = useState<Set<string>>(() => new Set(Object.keys(fixtureApps)));
  const [loadingConnectedFolderIds, setLoadingConnectedFolderIds] = useState<Set<string>>(() => new Set());
  const requestVersionsRef = useRef(new Map<string, number>());
  const nextRequestRef = useRef(0);
  const registeredIdsRef = useRef<Set<string> | null>(null);
  registeredIdsRef.current = connectedFolders ? new Set(connectedFolders.map((connectedFolder) => connectedFolder.id)) : null;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestVersionsRef.current.clear(); };
  }, []);

  const refresh = useCallback(async (connectedFolderId: string) => {
    if (!connectedFolderId || !mountedRef.current || (registeredIdsRef.current && !registeredIdsRef.current.has(connectedFolderId))) return;
    if (fixtureMode) {
      setAppsByConnectedFolder((current) => ({ ...current, [connectedFolderId]: fixtureApps[connectedFolderId] ?? current[connectedFolderId] ?? [] }));
      setKnownConnectedFolderIds((current) => new Set(current).add(connectedFolderId));
      return;
    }
    const requestVersion = ++nextRequestRef.current;
    requestVersionsRef.current.set(connectedFolderId, requestVersion);
    setLoadingConnectedFolderIds((current) => new Set(current).add(connectedFolderId));
    try {
      const apps = await listRestrictedApps(connectedFolderId);
      if (!mountedRef.current || (registeredIdsRef.current && !registeredIdsRef.current.has(connectedFolderId)) || requestVersionsRef.current.get(connectedFolderId) !== requestVersion) return;
      setAppsByConnectedFolder((current) => ({ ...current, [connectedFolderId]: apps }));
      setKnownConnectedFolderIds((current) => new Set(current).add(connectedFolderId));
    } catch (caught) {
      if (mountedRef.current && (!registeredIdsRef.current || registeredIdsRef.current.has(connectedFolderId)) && requestVersionsRef.current.get(connectedFolderId) === requestVersion) onError(caught);
    } finally {
      if (requestVersionsRef.current.get(connectedFolderId) === requestVersion) {
        setLoadingConnectedFolderIds((current) => {
          const next = new Set(current);
          next.delete(connectedFolderId);
          return next;
        });
      }
    }
  }, [fixtureApps, fixtureMode, onError]);

  useEffect(() => {
    if (fixtureMode) {
      setAppsByConnectedFolder({ ...fixtureApps, [activeConnectedFolderId]: fixtureApps[activeConnectedFolderId] ?? [] });
      setKnownConnectedFolderIds(new Set([...Object.keys(fixtureApps), activeConnectedFolderId]));
      return;
    }
    const registered = registeredIdsRef.current;
    if (registered) {
      for (const id of requestVersionsRef.current.keys()) if (!registered.has(id)) requestVersionsRef.current.delete(id);
      setAppsByConnectedFolder((current) => Object.keys(current).every((id) => registered.has(id))
        ? current
        : Object.fromEntries(Object.entries(current).filter(([id]) => registered.has(id))));
      setKnownConnectedFolderIds((current) => keepRegistered(current, registered));
      setLoadingConnectedFolderIds((current) => keepRegistered(current, registered));
    }
    for (const id of new Set([...requestVersionsRef.current.keys(), activeConnectedFolderId])) void refresh(id);
  }, [activeConnectedFolderId, connectedFolders, fixtureApps, fixtureMode, refresh]);

  useEffect(() => {
    if (fixtureMode) return;
    return subscribeControlEvents((hint) => {
      if (hint === "connected-folders" || hint === "reset") {
        // App re-reads the registry first. Invalidate pending old reads now;
        // its new Connected Folders prop will refresh only the surviving registrations.
        for (const [id, version] of requestVersionsRef.current) requestVersionsRef.current.set(id, version + 1);
        return;
      }
      if (hint !== "apps") return;
      const ids = new Set([...requestVersionsRef.current.keys(), activeConnectedFolderId]);
      for (const id of ids) void refresh(id);
    });
  }, [activeConnectedFolderId, fixtureMode, refresh]);

  const replaceApps = useCallback((connectedFolderId: string, apps: RestrictedAppInstalled[]) => {
    setAppsByConnectedFolder((current) => ({ ...current, [connectedFolderId]: apps }));
    setKnownConnectedFolderIds((current) => new Set(current).add(connectedFolderId));
  }, []);

  const upsertApp = useCallback((app: RestrictedAppInstalled) => {
    setAppsByConnectedFolder((current) => {
      const existing = current[app.connectedFolderId] ?? [];
      const next = existing.some((item) => item.featureInstallationId === app.featureInstallationId)
        ? existing.map((item) => item.featureInstallationId === app.featureInstallationId ? app : item)
        : [...existing, app];
      return { ...current, [app.connectedFolderId]: next };
    });
    setKnownConnectedFolderIds((current) => new Set(current).add(app.connectedFolderId));
  }, []);

  const removeApp = useCallback((connectedFolderId: string, featureInstallationId: string) => {
    setAppsByConnectedFolder((current) => ({
      ...current,
      [connectedFolderId]: (current[connectedFolderId] ?? []).filter((item) => item.featureInstallationId !== featureInstallationId),
    }));
    setKnownConnectedFolderIds((current) => new Set(current).add(connectedFolderId));
  }, []);

  const replaceRuntimeInstanceApps = useCallback((
    connectedFolderId: string,
    runtimeInstanceId: string,
    apps: RestrictedAppInstalled[],
  ) => {
    setAppsByConnectedFolder((current) => {
      const preserved = (current[connectedFolderId] ?? []).filter((item) => item.runtimeInstanceId !== runtimeInstanceId);
      const replacements = apps.filter((item) => (
        item.connectedFolderId === connectedFolderId && item.runtimeInstanceId === runtimeInstanceId
      ));
      const next = [...preserved, ...replacements].sort((left, right) => (
        left.manifest.title.localeCompare(right.manifest.title) || left.manifest.id.localeCompare(right.manifest.id)
      ));
      return { ...current, [connectedFolderId]: next };
    });
    setKnownConnectedFolderIds((current) => new Set(current).add(connectedFolderId));
  }, []);

  return {
    appsByConnectedFolder,
    knownConnectedFolderIds,
    loadingConnectedFolderIds,
    refresh,
    replaceApps,
    replaceRuntimeInstanceApps,
    upsertApp,
    removeApp,
  };
}

/** The same set when every id is still registered, so a registry read alone causes no re-render. */
function keepRegistered(ids: Set<string>, registered: ReadonlySet<string>): Set<string> {
  return [...ids].every((id) => registered.has(id)) ? ids : new Set([...ids].filter((id) => registered.has(id)));
}
