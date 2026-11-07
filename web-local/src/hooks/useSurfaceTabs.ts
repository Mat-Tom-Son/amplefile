import { useCallback, useEffect, useRef, useState } from "react";

import { chatDisplayTitle } from "../lib/format";
import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import { retargetMovedPath } from "../lib/tree";
import type { AgentExtensionSurfaceView, BrowserSurfaceTab, CapabilitySurface, ConversationSummary, RestrictedAppInstalled, ConnectedFolderSummary, ConnectedFolderSurfaceTab } from "../types";

const surfaceTabsStorageKey = "amplefile.connected-folder.surface-tabs.v1";

export function useSurfaceTabs({
  connectedFolder,
  connectedFolders,
  fixtureMode = false,
  openChatConnectedFolderId,
  onOpenChatConnectedFolderConsumed,
  onSwitchConnectedFolder,
}: {
  connectedFolder: ConnectedFolderSummary;
  connectedFolders: ConnectedFolderSummary[];
  fixtureMode?: boolean;
  openChatConnectedFolderId?: string | null;
  onOpenChatConnectedFolderConsumed?: () => void;
  onSwitchConnectedFolder?: (connectedFolder: ConnectedFolderSummary) => void;
}) {
  const initialStateRef = useRef<SurfaceTabsState | null>(null);
  const skipNextPersistRef = useRef(!fixtureMode);
  const recentSurfaceTabIdsByConnectedFolderRef = useRef<Map<string, string>>(new Map());
  const recentChatSurfaceTabIdsByConnectedFolderRef = useRef<Map<string, string>>(new Map());
  const previousActiveSurfaceTabIdRef = useRef<string | null | undefined>(undefined);
  const previousConnectedFolderCountRef = useRef(connectedFolders.length);
  const previousConnectedFolderIdRef = useRef(connectedFolder.id);
  if (!initialStateRef.current) {
    const initialState = fixtureMode
      ? defaultSurfaceTabsState(connectedFolder)
      : readStoredSurfaceTabsState(connectedFolder, connectedFolders);
    initialStateRef.current = initialState;
  }
  const [surfaceTabs, setSurfaceTabs] = useState<ConnectedFolderSurfaceTab[]>(() => initialStateRef.current?.tabs ?? [newChatSurfaceTab(connectedFolder)]);
  const [activeSurfaceTabId, setActiveSurfaceTabId] = useState<string | null>(() => initialStateRef.current?.activeTabId ?? newChatSurfaceTabId(connectedFolder.id));

  useEffect(() => {
    recordActiveSurfaceTabConnectedFolderRecency(recentSurfaceTabIdsByConnectedFolderRef.current, surfaceTabs, activeSurfaceTabId);
    recordActiveSurfaceTabConnectedFolderRecency(recentChatSurfaceTabIdsByConnectedFolderRef.current, surfaceTabs.filter((tab) => tab.kind === "chat"), activeSurfaceTabId);
  }, [activeSurfaceTabId, surfaceTabs]);

  useEffect(() => {
    const activeChanged = previousActiveSurfaceTabIdRef.current !== activeSurfaceTabId;
    const connectedFoldersHydrated = previousConnectedFolderCountRef.current === 0 && connectedFolders.length > 0;
    previousActiveSurfaceTabIdRef.current = activeSurfaceTabId;
    previousConnectedFolderCountRef.current = connectedFolders.length;
    if (!activeChanged && !connectedFoldersHydrated) return;
    const targetConnectedFolder = surfaceTabConnectedFolderSwitchTarget({
      activeTabId: activeSurfaceTabId,
      activeConnectedFolderId: connectedFolder.id,
      tabs: surfaceTabs,
      connectedFolders,
    });
    if (targetConnectedFolder) onSwitchConnectedFolder?.(targetConnectedFolder);
  }, [activeSurfaceTabId, onSwitchConnectedFolder, surfaceTabs, connectedFolder.id, connectedFolders]);

  useEffect(() => {
    if (previousConnectedFolderIdRef.current === connectedFolder.id) return;
    previousConnectedFolderIdRef.current = connectedFolder.id;
    const resolution = surfaceTabActivationForConnectedFolder({
      activeTabId: activeSurfaceTabId,
      recentTabIdsByConnectedFolder: recentSurfaceTabIdsByConnectedFolderRef.current,
      tabs: surfaceTabs,
      connectedFolder,
    });
    if (!resolution || resolution.tabId === activeSurfaceTabId) return;
    if (resolution.tabToAdd) {
      const tabToAdd = resolution.tabToAdd;
      setSurfaceTabs((current) => current.some((tab) => tab.id === tabToAdd.id) ? current : [...current, tabToAdd]);
    }
    setActiveSurfaceTabId(resolution.tabId);
  }, [activeSurfaceTabId, surfaceTabs, connectedFolder]);

  useEffect(() => {
    if (openChatConnectedFolderId !== connectedFolder.id) return;
    const existingDraftTab = surfaceTabs.find((tab) => tab.kind === "chat" && tab.connectedFolderId === connectedFolder.id && !tab.conversationId);
    if (existingDraftTab) {
      setActiveSurfaceTabId(existingDraftTab.id);
      onOpenChatConnectedFolderConsumed?.();
      return;
    }
    const tab = newChatSurfaceTab(connectedFolder);
    setSurfaceTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveSurfaceTabId(tab.id);
    onOpenChatConnectedFolderConsumed?.();
  }, [openChatConnectedFolderId, onOpenChatConnectedFolderConsumed, surfaceTabs, connectedFolder.id, connectedFolder.name]);

  useEffect(() => {
    if (!connectedFolders.length) return;
    setSurfaceTabs((current) => {
      const next = filterSurfaceTabsToConnectedFolders(current, connectedFolders);
      const resolved = next.length ? next : [newChatSurfaceTab(connectedFolder)];
      setActiveSurfaceTabId((currentActiveTabId) => (
        currentActiveTabId && resolved.some((tab) => tab.id === currentActiveTabId)
          ? currentActiveTabId
          : resolved[0]?.id ?? null
      ));
      return resolved;
    });
  }, [connectedFolder.id, connectedFolder.name, connectedFolders]);

  useEffect(() => {
    setActiveSurfaceTabId((current) => {
      if (surfaceTabs.some((tab) => tab.id === current)) return current;
      return surfaceTabs[0]?.id ?? null;
    });
  }, [surfaceTabs]);

  useEffect(() => {
    if (fixtureMode) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    writeStoredSurfaceTabsState({ tabs: surfaceTabs, activeTabId: activeSurfaceTabId });
  }, [activeSurfaceTabId, fixtureMode, surfaceTabs]);

  function syncSurfaceTabConversationTitles(groups: Record<string, ConversationSummary[]>): void {
    setSurfaceTabs((current) => current.map((tab) => {
      if (tab.kind !== "chat" || !tab.conversationId) return tab;
      const refreshedConversation = groups[tab.connectedFolderId]?.find((conversation) => conversation.id === tab.conversationId);
      if (!refreshedConversation) return tab;
      const title = chatDisplayTitle({ serverTitle: refreshedConversation.title });
      return tab.title === title ? tab : { ...tab, title };
    }));
  }

  function openChatSurfaceTab(targetConnectedFolder: ConnectedFolderSummary, conversation: ConversationSummary | null = null): string {
    if (conversation) {
      const existingTab = surfaceTabs.find((tab) => tab.kind === "chat" && tab.connectedFolderId === targetConnectedFolder.id && tab.conversationId === conversation.id);
      if (existingTab) {
        setSurfaceTabs((current) => current.map((tab) => (
          tab.id === existingTab.id ? { ...tab, title: chatDisplayTitle({ serverTitle: conversation.title }) } : tab
        )));
        setActiveSurfaceTabId(existingTab.id);
        return existingTab.id;
      }
    }
    const tab = conversation ? chatSurfaceTab(targetConnectedFolder, conversation) : newChatSurfaceTab(targetConnectedFolder, { fresh: true });
    setSurfaceTabs((current) => conversation ? upsertSurfaceTab(current, tab) : [...current, tab]);
    setActiveSurfaceTabId(tab.id);
    return tab.id;
  }

  function openHistorySurfaceTab(targetConnectedFolder: ConnectedFolderSummary, checkpointId?: string, title = "History"): void {
    const tab = historySurfaceTab(targetConnectedFolder, checkpointId, title);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openFileSurfaceTab(targetConnectedFolder: ConnectedFolderSummary, path: string): void {
    const tab = fileSurfaceTab(targetConnectedFolder, path);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  /**
   * Opens a page folder's tab, or selects it; an open tab keeps its title,
   * and its view unless one is asked for (Files' Data row asks for Data).
   */
  function openPageSurfaceTab(targetConnectedFolder: ConnectedFolderSummary, path: string, title?: string, view?: "preview" | "data"): void {
    const tab = pageSurfaceTab(targetConnectedFolder, path, title);
    setSurfaceTabs((current) => current.some((item) => item.id === tab.id)
      ? view ? current.map((item) => item.id === tab.id && item.kind === "page" && item.view !== view ? { ...item, view } : item) : current
      : [...current, view ? { ...tab, view } : tab]);
    setActiveSurfaceTabId(tab.id);
  }

  /** Keeps a page tab's title and chosen view, so they survive a restart. */
  const updatePageSurfaceTab = useCallback((tabId: string, update: { title?: string; view?: "preview" | "data" }): void => {
    setSurfaceTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.id !== tabId || tab.kind !== "page") return tab;
        const title = update.title?.trim() || tab.title;
        const view = update.view ?? tab.view;
        if (title === tab.title && view === tab.view) return tab;
        changed = true;
        return { ...tab, title, ...(view ? { view } : {}) };
      });
      return changed ? next : current;
    });
  }, []);

  function openAppStudioSurfaceTab(targetConnectedFolder: ConnectedFolderSummary): void {
    const tab = appStudioSurfaceTab(targetConnectedFolder);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openChecksSurfaceTab(targetConnectedFolder: ConnectedFolderSummary): void {
    const tab = checksSurfaceTab(targetConnectedFolder);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openConnectedFolderAutomationsSurfaceTab(targetConnectedFolder: ConnectedFolderSummary): void {
    const tab = spaceAutomationsSurfaceTab(targetConnectedFolder);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openConnectedFolderAutomationSurfaceTab(targetConnectedFolder: ConnectedFolderSummary, automation: { automationId: string; title: string }): void {
    const tab = connectedFolderAutomationSurfaceTab(targetConnectedFolder, automation);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openExtensionSurfaceTab(
    targetConnectedFolder: ConnectedFolderSummary,
    surface: CapabilitySurface,
    view: AgentExtensionSurfaceView,
  ): void {
    const tab = extensionSurfaceTab(targetConnectedFolder, surface, view);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openRestrictedAppSurfaceTab(
    targetConnectedFolder: ConnectedFolderSummary,
    app: { appId: string; digest: string; featureInstallationId: string },
    target: { appTabId: string; title: string; route: string; state?: unknown },
  ): void {
    const tab = restrictedAppSurfaceTab(targetConnectedFolder.id, app, target);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function updateRestrictedAppSurfaceTab(
    connectedFolderId: string,
    app: { appId: string; digest: string; featureInstallationId: string },
    target: { appTabId: string; title: string; route: string; state?: unknown },
  ): void {
    const id = restrictedAppSurfaceTabId(connectedFolderId, app.appId, app.digest, target.appTabId, app.featureInstallationId);
    setSurfaceTabs((current) => current.map((tab) => tab.id === id && tab.kind === "restricted-app"
      ? restrictedAppSurfaceTab(connectedFolderId, app, target)
      : tab));
  }

  /**
   * Opens a browser tab (docs/built-in-browser.md). It belongs to no
   * Connected Folder, so selecting it keeps the Connected Folder that is open. A tab the
   * desktop opened (a link, or a Worker's page) brings its own page id.
   */
  function openBrowserSurfaceTab(options: { pageId?: string; url?: string; title?: string; show?: boolean } = {}): string {
    const tab = browserSurfaceTab(options.pageId ?? newBrowserPageId(), options.url ?? "", options.title);
    setSurfaceTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    if (options.show !== false) setActiveSurfaceTabId(tab.id);
    return tab.id;
  }

  /** Keeps a browser tab's address and title in step with its page, so they survive a restart. */
  const updateBrowserSurfaceTab = useCallback((pageId: string, page: { url: string; title: string }): void => {
    setSurfaceTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.kind !== "browser" || tab.pageId !== pageId) return tab;
        const title = browserTabTitle(page.title, page.url);
        if (tab.url === page.url && tab.title === title) return tab;
        changed = true;
        return { ...tab, url: page.url, title };
      });
      return changed ? next : current;
    });
  }, []);

  function closeRestrictedAppSurfaceTab(connectedFolderId: string, appId: string, digest: string, appTabId: string, featureInstallationId: string): void {
    closeSurfaceTab(restrictedAppSurfaceTabId(connectedFolderId, appId, digest, appTabId, featureInstallationId));
  }

  const reconcileRestrictedAppSurfaceTabs = useCallback((
    appsByConnectedFolder: Record<string, RestrictedAppInstalled[]>,
    knownConnectedFolderIds: ReadonlySet<string>,
  ): void => {
    setSurfaceTabs((current) => {
      const next = closeUnavailableRestrictedAppSurfaceTabs(current, appsByConnectedFolder, knownConnectedFolderIds);
      if (next === current) return current;
      setActiveSurfaceTabId((currentActiveTabId) => {
        if (currentActiveTabId && next.some((tab) => tab.id === currentActiveTabId)) return currentActiveTabId;
        const removedActiveIndex = current.findIndex((tab) => tab.id === currentActiveTabId);
        const fallback = next[Math.max(0, Math.min(removedActiveIndex, next.length - 1))] ?? next[0];
        return fallback?.id ?? null;
      });
      return next;
    });
  }, []);

  /** Tabs the person closed, newest last, for Reopen Closed Tab; kept for this window's life. Browser tabs keep their own. */
  const closedSurfaceTabsRef = useRef<Array<{ tab: ConnectedFolderSurfaceTab; index: number; at: number }>>([]);

  /** Closes a tab. `remember` keeps it for Reopen Closed Tab: only the person's own closes are remembered. */
  function closeSurfaceTab(tabId: string, remember = false): void {
    const index = surfaceTabs.findIndex((tab) => tab.id === tabId);
    const closing = surfaceTabs[index];
    if (remember && closing && closing.kind !== "browser") {
      closedSurfaceTabsRef.current = [...closedSurfaceTabsRef.current, { tab: closing, index, at: Date.now() }].slice(-25);
    }
    setSurfaceTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) return current;
      const next = current.filter((tab) => tab.id !== tabId);
      setActiveSurfaceTabId((currentActiveTabId) => {
        if (currentActiveTabId && currentActiveTabId !== tabId && next.some((tab) => tab.id === currentActiveTabId)) {
          return currentActiveTabId;
        }
        const fallback = next[Math.max(0, Math.min(index, next.length - 1))] ?? next[0];
        return fallback?.id ?? null;
      });
      return next;
    });
  }

  /** Opens the tab the person closed last again, in its old place. False when there is none left to reopen. */
  function reopenClosedSurfaceTab(canReopen: (tab: ConnectedFolderSurfaceTab) => boolean): boolean {
    while (closedSurfaceTabsRef.current.length) {
      const { tab, index } = closedSurfaceTabsRef.current.at(-1)!;
      closedSurfaceTabsRef.current = closedSurfaceTabsRef.current.slice(0, -1);
      if (surfaceTabs.some((open) => open.id === tab.id) || !canReopen(tab)) continue;
      setSurfaceTabs((current) => current.some((open) => open.id === tab.id) ? current : [...current.slice(0, index), tab, ...current.slice(index)]);
      setActiveSurfaceTabId(tab.id);
      return true;
    }
    return false;
  }

  /** When the person last closed a tab Reopen Closed Tab can bring back; 0 when none. */
  function lastClosedSurfaceTabAt(): number {
    return closedSurfaceTabsRef.current.at(-1)?.at ?? 0;
  }

  const reorderSurfaceTabs = useCallback((ids: string[]): void => {
    setSurfaceTabs((current) => reorderSurfaceTabList(current, ids));
  }, []);

  function handleTabConversationActivated(tabId: string, tabConnectedFolder: ConnectedFolderSummary, conversation: ConversationSummary | null): void {
    if (!conversation) return;
    const duplicate = surfaceTabs.find((tab) => tab.kind === "chat" && tab.id !== tabId && tab.connectedFolderId === tabConnectedFolder.id && tab.conversationId === conversation.id);
    if (duplicate) {
      setSurfaceTabs((current) => current.filter((tab) => tab.id !== tabId));
      setActiveSurfaceTabId((current) => activeTabAfterConversationActivation(current, tabId, duplicate.id));
      return;
    }
    const nextTab: ConnectedFolderSurfaceTab = {
      id: tabId,
      kind: "chat",
      connectedFolderId: tabConnectedFolder.id,
      conversationId: conversation.id,
      title: chatDisplayTitle({ serverTitle: conversation.title }),
    };
    setSurfaceTabs((current) => {
      return current.map((tab) => tab.id === tabId ? nextTab : tab);
    });
  }

  function removeConnectedFolderSurfaceTabs(connectedFolderId: string): void {
    setSurfaceTabs((current) => current.filter((tab) => tab.connectedFolderId !== connectedFolderId));
  }

  function retargetFileSurfaceTabsForMove(connectedFolderId: string, sourcePath: string, movedPath: string): void {
    setSurfaceTabs((current) => retargetFileSurfaceTabs(current, connectedFolderId, sourcePath, movedPath));
    // A file or page tab's id names its path, so the selected tab follows it.
    setActiveSurfaceTabId((current) => {
      for (const [prefix, tabId] of [[`file:${connectedFolderId}:`, fileSurfaceTabId], [`page:${connectedFolderId}:`, pageSurfaceTabId]] as const) {
        if (!current?.startsWith(prefix)) continue;
        const path = current.slice(prefix.length);
        const nextPath = retargetMovedPath(path, sourcePath, movedPath);
        return nextPath && nextPath !== path ? tabId(connectedFolderId, nextPath) : current;
      }
      return current;
    });
  }

  function closeFileSurfaceTabsForDeletedPaths(connectedFolderId: string, deletedPaths: Set<string>): void {
    setSurfaceTabs((current) => closeFileSurfaceTabs(current, connectedFolderId, deletedPaths));
  }

  /** The Chat tab a person was last in for this Connected Folder, while it is still open. */
  function recentChatSurfaceTab(connectedFolderId: string): ConnectedFolderSurfaceTab | null {
    const recentTabId = recentChatSurfaceTabIdsByConnectedFolderRef.current.get(connectedFolderId);
    return surfaceTabs.find((tab) => tab.id === recentTabId && tab.kind === "chat" && tab.connectedFolderId === connectedFolderId) ?? null;
  }

  function updateSurfaceTabConversationTitle(connectedFolderId: string, conversation: ConversationSummary): void {
    setSurfaceTabs((current) => current.map((tab) => (
      tab.kind === "chat" && tab.connectedFolderId === connectedFolderId && tab.conversationId === conversation.id
        ? { ...tab, title: chatDisplayTitle({ serverTitle: conversation.title }) }
        : tab
    )));
  }

  return {
    surfaceTabs,
    activeSurfaceTabId,
    setActiveSurfaceTabId,
    syncSurfaceTabConversationTitles,
    openChatSurfaceTab,
    openHistorySurfaceTab,
    openFileSurfaceTab,
    openPageSurfaceTab,
    updatePageSurfaceTab,
    openAppStudioSurfaceTab,
    openChecksSurfaceTab,
    openConnectedFolderAutomationsSurfaceTab,
    openConnectedFolderAutomationSurfaceTab,
    openExtensionSurfaceTab,
    openRestrictedAppSurfaceTab,
    updateRestrictedAppSurfaceTab,
    closeRestrictedAppSurfaceTab,
    reconcileRestrictedAppSurfaceTabs,
    openBrowserSurfaceTab,
    updateBrowserSurfaceTab,
    closeSurfaceTab,
    reopenClosedSurfaceTab,
    lastClosedSurfaceTabAt,
    reorderSurfaceTabs,
    handleTabConversationActivated,
    removeConnectedFolderSurfaceTabs,
    retargetFileSurfaceTabsForMove,
    closeFileSurfaceTabsForDeletedPaths,
    recentChatSurfaceTab,
    updateSurfaceTabConversationTitle,
  };
}

/** Reorder known slots without dropping tabs opened during the gesture. */
export function reorderSurfaceTabList(tabs: ConnectedFolderSurfaceTab[], ids: string[]): ConnectedFolderSurfaceTab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered = [...new Set(ids)].flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const selected = new Set(ordered.map((tab) => tab.id));
  let index = 0;
  const next = tabs.map((tab) => selected.has(tab.id) ? ordered[index++]! : tab);
  return next.every((tab, position) => tab === tabs[position]) ? tabs : next;
}

function newChatSurfaceTab(connectedFolder: ConnectedFolderSummary, options: { fresh?: boolean } = {}): ConnectedFolderSurfaceTab {
  return {
    id: options.fresh ? `chat:${connectedFolder.id}:draft:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}` : newChatSurfaceTabId(connectedFolder.id),
    kind: "chat",
    connectedFolderId: connectedFolder.id,
    conversationId: null,
    title: "New Chat",
  };
}

interface SurfaceTabsState {
  tabs: ConnectedFolderSurfaceTab[];
  activeTabId: string | null;
}

function defaultSurfaceTabsState(connectedFolder: ConnectedFolderSummary): SurfaceTabsState {
  return {
    tabs: [newChatSurfaceTab(connectedFolder)],
    activeTabId: newChatSurfaceTabId(connectedFolder.id),
  };
}

function readStoredSurfaceTabsState(connectedFolder: ConnectedFolderSummary, connectedFolders: ConnectedFolderSummary[]): SurfaceTabsState {
  const stored = readStoredJsonValue<SurfaceTabsState>(surfaceTabsStorageKey, normalizeStoredSurfaceTabsValue, { tabs: [], activeTabId: null });
  if (!stored.tabs.length) return defaultSurfaceTabsState(connectedFolder);
  if (!connectedFolders.length) return normalizeActiveSurfaceTab(stored);
  const restored = restoreStoredSurfaceTabsForConnectedFolders(stored, connectedFolders);
  return restored.tabs.length ? restored : defaultSurfaceTabsState(connectedFolder);
}

function writeStoredSurfaceTabsState(state: SurfaceTabsState): void {
  writeStoredJsonValue(surfaceTabsStorageKey, {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
  });
}

function normalizeStoredSurfaceTabsValue(parsed: unknown): SurfaceTabsState {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { tabs: [], activeTabId: null };
  const record = parsed as Record<string, unknown>;
  const storedActiveTabId = typeof record.activeTabId === "string" ? record.activeTabId : null;
  const tabs = Array.isArray(record.tabs) ? normalizeStoredSurfaceTabs(record.tabs) : [];
  // A restored tab whose id was rebuilt (an older file tab) stays the selected tab.
  const storedActive = Array.isArray(record.tabs) && storedActiveTabId
    ? record.tabs.find((tab) => tab && typeof tab === "object" && (tab as Record<string, unknown>).id === storedActiveTabId)
    : undefined;
  const rebuiltActive = storedActive ? normalizeStoredSurfaceTab(storedActive) : null;
  const activeTabId = rebuiltActive?.id ?? storedActiveTabId;
  return normalizeActiveSurfaceTab({ tabs, activeTabId });
}

function normalizeStoredSurfaceTabs(tabs: unknown[]): ConnectedFolderSurfaceTab[] {
  const next: ConnectedFolderSurfaceTab[] = [];
  const seenIds = new Set<string>();
  for (const value of tabs) {
    const tab = normalizeStoredSurfaceTab(value);
    if (!tab || seenIds.has(tab.id)) continue;
    seenIds.add(tab.id);
    next.push(tab);
  }
  return next;
}

function normalizeStoredSurfaceTab(value: unknown): ConnectedFolderSurfaceTab | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "browser") {
    if (typeof record.pageId !== "string" || !browserPageIdPattern.test(record.pageId)) return null;
    const url = typeof record.url === "string" && record.url.length <= 32_768 ? record.url : "";
    return browserSurfaceTab(record.pageId, url, typeof record.title === "string" ? record.title : undefined);
  }
  if (typeof record.id !== "string" || typeof record.connectedFolderId !== "string" || typeof record.title !== "string") return null;
  if (record.kind === "chat") {
    if (record.conversationId !== null && typeof record.conversationId !== "string") return null;
    return {
      id: record.id,
      kind: "chat",
      connectedFolderId: record.connectedFolderId,
      conversationId: record.conversationId,
      title: record.title,
    };
  }
  if (record.kind === "file") {
    if (typeof record.path !== "string") return null;
    // Tabs saved before files had a tab each carry the old per–Connected Folder id.
    return {
      id: fileSurfaceTabId(record.connectedFolderId, record.path),
      kind: "file",
      connectedFolderId: record.connectedFolderId,
      path: record.path,
      title: record.title,
    };
  }
  if (record.kind === "page") {
    if (typeof record.path !== "string" || !validPagePath(record.path)) return null;
    return {
      id: pageSurfaceTabId(record.connectedFolderId, record.path),
      kind: "page",
      connectedFolderId: record.connectedFolderId,
      path: record.path,
      title: record.title || pageFolderTitle(record.path),
      ...(record.view === "data" || record.view === "preview" ? { view: record.view } : {}),
    };
  }
  if (record.kind === "history") {
    if (record.checkpointId !== undefined && typeof record.checkpointId !== "string") return null;
    return {
      id: record.id,
      kind: "history",
      connectedFolderId: record.connectedFolderId,
      checkpointId: typeof record.checkpointId === "string" ? record.checkpointId : undefined,
      title: record.title,
    };
  }
  if (record.kind === "app-studio") {
    return {
      id: `app-studio:${record.connectedFolderId}`,
      kind: "app-studio",
      connectedFolderId: record.connectedFolderId,
      title: record.title,
    };
  }
  if (record.kind === "checks") {
    return {
      id: `checks:${record.connectedFolderId}`,
      kind: "checks",
      connectedFolderId: record.connectedFolderId,
      title: "Checks",
    };
  }
  if (record.kind === "connected-folder-automation") {
    if (typeof record.automationId !== "string" || !record.automationId || record.automationId.length > 200) return null;
    return {
      id: `connected-folder-automation:${record.connectedFolderId}:${record.automationId}`,
      kind: "connected-folder-automation",
      connectedFolderId: record.connectedFolderId,
      automationId: record.automationId,
      title: record.title,
    };
  }
  if (record.kind === "connected-folder-automations") {
    return {
      id: `connected-folder-automations:${record.connectedFolderId}`,
      kind: "connected-folder-automations",
      connectedFolderId: record.connectedFolderId,
      title: "Automations",
    };
  }
  if (record.kind === "extension") {
    if (typeof record.surfaceId !== "string" || typeof record.viewId !== "string") return null;
    if (record.surfaceExecution !== undefined && record.surfaceExecution !== "full-trust-pi") return null;
    return {
      id: record.id,
      kind: "extension",
      connectedFolderId: record.connectedFolderId,
      surfaceId: record.surfaceId,
      surfaceExecution: "full-trust-pi",
      viewId: record.viewId,
      title: record.title,
    };
  }
  if (record.kind === "restricted-app") {
    if (typeof record.appId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(record.appId)) return null;
    if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.digest)) return null;
    if (typeof record.appTabId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(record.appTabId)) return null;
    if (typeof record.route !== "string" || !validRestrictedAppRoute(record.route)) return null;
    if (typeof record.featureInstallationId !== "string" || !/^feature-installation_[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(record.featureInstallationId)) return null;
    const id = restrictedAppSurfaceTabId(record.connectedFolderId, record.appId, record.digest, record.appTabId, record.featureInstallationId);
    return {
      id,
      kind: "restricted-app",
      connectedFolderId: record.connectedFolderId,
      appId: record.appId,
      featureInstallationId: record.featureInstallationId,
      digest: record.digest,
      appTabId: record.appTabId,
      route: record.route,
      ...(record.state !== undefined ? { state: record.state } : {}),
      title: record.title,
    };
  }
  return null;
}

function restoreStoredSurfaceTabsForConnectedFolders(state: SurfaceTabsState, connectedFolders: ConnectedFolderSummary[]): SurfaceTabsState {
  return normalizeActiveSurfaceTab({
    tabs: filterSurfaceTabsToConnectedFolders(state.tabs, connectedFolders),
    activeTabId: state.activeTabId,
  });
}

function filterSurfaceTabsToConnectedFolders(tabs: ConnectedFolderSurfaceTab[], connectedFolders: ConnectedFolderSummary[]): ConnectedFolderSurfaceTab[] {
  const connectedFolderIds = new Set(connectedFolders.map((item) => item.id));
  // Browser tabs belong to no Connected Folder, so removing one never closes them.
  const kept = tabs.filter((tab) => tab.connectedFolderId === null || connectedFolderIds.has(tab.connectedFolderId));
  // Every registry read (each window focus) passes a new list; keeping the
  // same array when nothing closed avoids a re-render and a saved-tabs write.
  return kept.length === tabs.length ? tabs : kept;
}

function normalizeActiveSurfaceTab(state: SurfaceTabsState): SurfaceTabsState {
  if (state.activeTabId && state.tabs.some((tab) => tab.id === state.activeTabId)) return state;
  return {
    tabs: state.tabs,
    activeTabId: state.tabs[0]?.id ?? null,
  };
}

function recordActiveSurfaceTabConnectedFolderRecency(recentTabIdsByConnectedFolder: Map<string, string>, tabs: ConnectedFolderSurfaceTab[], activeTabId: string | null): void {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab || activeTab.connectedFolderId === null) return;
  recentTabIdsByConnectedFolder.set(activeTab.connectedFolderId, activeTab.id);
}

function activeTabAfterConversationActivation(currentActiveTabId: string | null, sourceTabId: string, duplicateTabId: string): string | null {
  return currentActiveTabId === sourceTabId ? duplicateTabId : currentActiveTabId;
}

function surfaceTabConnectedFolderSwitchTarget({
  activeTabId,
  activeConnectedFolderId,
  tabs,
  connectedFolders,
}: {
  activeTabId: string | null;
  activeConnectedFolderId: string;
  tabs: ConnectedFolderSurfaceTab[];
  connectedFolders: ConnectedFolderSummary[];
}): ConnectedFolderSummary | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  // A browser tab keeps whichever Connected Folder is open.
  if (!activeTab || activeTab.connectedFolderId === null || activeTab.connectedFolderId === activeConnectedFolderId) return null;
  return connectedFolders.find((item) => item.id === activeTab.connectedFolderId) ?? null;
}

function surfaceTabActivationForConnectedFolder({
  activeTabId,
  recentTabIdsByConnectedFolder,
  tabs,
  connectedFolder,
}: {
  activeTabId: string | null;
  recentTabIdsByConnectedFolder: Map<string, string>;
  tabs: ConnectedFolderSurfaceTab[];
  connectedFolder: ConnectedFolderSummary;
}): { tabId: string; tabToAdd?: ConnectedFolderSurfaceTab } | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (activeTab?.connectedFolderId === connectedFolder.id) return null;

  const recentTabId = recentTabIdsByConnectedFolder.get(connectedFolder.id);
  const recentTab = recentTabId ? tabs.find((tab) => tab.id === recentTabId && tab.connectedFolderId === connectedFolder.id) : null;
  if (recentTab) return { tabId: recentTab.id };

  const draftTab = tabs.find((tab) => tab.kind === "chat" && tab.connectedFolderId === connectedFolder.id && !tab.conversationId);
  if (draftTab) return { tabId: draftTab.id };

  const tab = newChatSurfaceTab(connectedFolder);
  return { tabId: tab.id, tabToAdd: tab };
}

function newChatSurfaceTabId(connectedFolderId: string): string {
  return `chat:${connectedFolderId}:new`;
}

function chatSurfaceTab(connectedFolder: ConnectedFolderSummary, conversation: ConversationSummary): ConnectedFolderSurfaceTab {
  return {
    id: `chat:${connectedFolder.id}:${conversation.id}`,
    kind: "chat",
    connectedFolderId: connectedFolder.id,
    conversationId: conversation.id,
    title: chatDisplayTitle({ serverTitle: conversation.title }),
  };
}

function historySurfaceTab(connectedFolder: ConnectedFolderSummary, checkpointId?: string, title = "History"): ConnectedFolderSurfaceTab {
  return {
    id: checkpointId ? `history:${connectedFolder.id}:${checkpointId}` : `history:${connectedFolder.id}`,
    kind: "history",
    connectedFolderId: connectedFolder.id,
    checkpointId,
    title,
  };
}

/** Each file opens in its own tab; opening a file that is already open selects its tab. */
function fileSurfaceTab(connectedFolder: ConnectedFolderSummary, path: string): ConnectedFolderSurfaceTab {
  return {
    id: fileSurfaceTabId(connectedFolder.id, path),
    kind: "file",
    connectedFolderId: connectedFolder.id,
    path,
    title: fileSurfaceTitle(path),
  };
}

function fileSurfaceTabId(connectedFolderId: string, path: string): string {
  return `file:${connectedFolderId}:${path}`;
}

function fileSurfaceTitle(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * Each page folder opens in one tab (docs/pages.md, "Preview and test
 * entries"), titled with the page's title once it is read.
 */
function pageSurfaceTab(connectedFolder: ConnectedFolderSummary, path: string, title?: string): ConnectedFolderSurfaceTab {
  return {
    id: pageSurfaceTabId(connectedFolder.id, path),
    kind: "page",
    connectedFolderId: connectedFolder.id,
    path,
    title: title?.trim() || pageFolderTitle(path),
  };
}

function pageSurfaceTabId(connectedFolderId: string, path: string): string {
  return `page:${connectedFolderId}:${path}`;
}

function pageFolderTitle(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

/** A Connected Folder–relative folder path: no empty, dot, or absolute parts. */
function validPagePath(path: string): boolean {
  if (!path || path.length > 4_096 || path.startsWith("/") || /[\\\0]/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function appStudioSurfaceTab(connectedFolder: ConnectedFolderSummary): ConnectedFolderSurfaceTab {
  return {
    id: `app-studio:${connectedFolder.id}`,
    kind: "app-studio",
    connectedFolderId: connectedFolder.id,
    title: "App Studio",
  };
}

/**
 * One Connected Folder–owned tab onto the automations that touch this Connected Folder
 * (docs/automations.md, F15 as amended 2026-09-24).
 */
export function spaceAutomationsSurfaceTab(connectedFolder: ConnectedFolderSummary): ConnectedFolderSurfaceTab {
  return {
    id: `connected-folder-automations:${connectedFolder.id}`,
    kind: "connected-folder-automations",
    connectedFolderId: connectedFolder.id,
    title: "Automations",
  };
}

/** One automation that touches this Connected Folder, opened from the Automations list in the left pane. */
export function connectedFolderAutomationSurfaceTab(connectedFolder: ConnectedFolderSummary, automation: { automationId: string; title: string }): ConnectedFolderSurfaceTab {
  return {
    id: `connected-folder-automation:${connectedFolder.id}:${automation.automationId}`,
    kind: "connected-folder-automation",
    connectedFolderId: connectedFolder.id,
    automationId: automation.automationId,
    title: automation.title,
  };
}

export function checksSurfaceTab(connectedFolder: ConnectedFolderSummary): ConnectedFolderSurfaceTab {
  return {
    id: `checks:${connectedFolder.id}`,
    kind: "checks",
    connectedFolderId: connectedFolder.id,
    title: "Checks",
  };
}

function extensionSurfaceTab(
  connectedFolder: ConnectedFolderSummary,
  surface: CapabilitySurface,
  view: AgentExtensionSurfaceView,
): ConnectedFolderSurfaceTab {
  return {
    id: `extension:${connectedFolder.id}:${surface.key}:${view.id}`,
    kind: "extension",
    connectedFolderId: connectedFolder.id,
    surfaceId: surface.key,
    surfaceExecution: "full-trust-pi",
    viewId: view.id,
    title: view.title,
  };
}

function restrictedAppSurfaceTab(
  connectedFolderId: string,
  app: { appId: string; digest: string; featureInstallationId: string },
  target: { appTabId: string; title: string; route: string; state?: unknown },
): ConnectedFolderSurfaceTab {
  return {
    id: restrictedAppSurfaceTabId(connectedFolderId, app.appId, app.digest, target.appTabId, app.featureInstallationId),
    kind: "restricted-app",
    connectedFolderId,
    appId: app.appId,
    featureInstallationId: app.featureInstallationId,
    digest: app.digest,
    appTabId: target.appTabId,
    route: target.route,
    ...(target.state !== undefined ? { state: structuredClone(target.state) } : {}),
    title: target.title,
  };
}

const browserPageIdPattern = /^[a-z0-9]{6,32}$/;

function browserSurfaceTab(pageId: string, url: string, title?: string): BrowserSurfaceTab {
  return {
    id: browserSurfaceTabId(pageId),
    kind: "browser",
    connectedFolderId: null,
    pageId,
    url,
    title: browserTabTitle(title ?? "", url),
  };
}

function browserSurfaceTabId(pageId: string): string {
  return `browser:${pageId}`;
}

/** The page's own title; its host while it has none; "New Tab" for a blank tab. */
function browserTabTitle(title: string, url: string): string {
  const trimmed = title.trim();
  if (trimmed) return trimmed.length > 300 ? `${trimmed.slice(0, 299)}…` : trimmed;
  if (!url || url === "about:blank") return "New Tab";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname.split("/").pop() || parsed.pathname);
    return parsed.host || url;
  } catch {
    return url;
  }
}

function newBrowserPageId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

function restrictedAppSurfaceTabId(connectedFolderId: string, appId: string, digest: string, appTabId: string, featureInstallationId: string): string {
  return `restricted-app:${connectedFolderId}:${appId}:${featureInstallationId}:${digest}:${appTabId}`;
}

function closeUnavailableRestrictedAppSurfaceTabs(
  tabs: ConnectedFolderSurfaceTab[],
  appsByConnectedFolder: Record<string, Array<{ manifest: { id: string }; digest: string; featureInstallationId: string }>>,
  knownConnectedFolderIds: ReadonlySet<string>,
): ConnectedFolderSurfaceTab[] {
  const next = tabs.filter((tab) => {
    if (tab.kind !== "restricted-app" || !knownConnectedFolderIds.has(tab.connectedFolderId)) return true;
    return (appsByConnectedFolder[tab.connectedFolderId] ?? []).some((app) => app.manifest.id === tab.appId && app.digest === tab.digest && app.featureInstallationId === tab.featureInstallationId);
  });
  return next.length === tabs.length ? tabs : next;
}

function validRestrictedAppRoute(value: string): boolean {
  if (value.length > 2_048 || /[\\\0\r\n]/.test(value) || !value.startsWith("/") || value.startsWith("//")) return false;
  try {
    return new URL(value, "https://restricted-app.invalid").origin === "https://restricted-app.invalid";
  } catch {
    return false;
  }
}

function upsertSurfaceTab(tabs: ConnectedFolderSurfaceTab[], tab: ConnectedFolderSurfaceTab): ConnectedFolderSurfaceTab[] {
  const existing = tabs.find((item) => item.id === tab.id);
  if (existing) return tabs.map((item) => item.id === tab.id ? { ...existing, ...tab } : item);
  return [...tabs, tab];
}

function retargetFileSurfaceTabs(tabs: ConnectedFolderSurfaceTab[], connectedFolderId: string, sourcePath: string, movedPath: string): ConnectedFolderSurfaceTab[] {
  const seen = new Set<string>();
  return tabs.flatMap((tab) => {
    let next = tab;
    if (tab.kind === "file" && tab.connectedFolderId === connectedFolderId && tab.path) {
      const nextPath = retargetMovedPath(tab.path, sourcePath, movedPath);
      if (nextPath && nextPath !== tab.path) next = { ...tab, id: fileSurfaceTabId(connectedFolderId, nextPath), path: nextPath, title: fileSurfaceTitle(nextPath) };
    }
    // A moved page keeps its title; its test entries start fresh (docs/pages.md).
    if (tab.kind === "page" && tab.connectedFolderId === connectedFolderId && tab.path) {
      const nextPath = retargetMovedPath(tab.path, sourcePath, movedPath);
      if (nextPath && nextPath !== tab.path) next = { ...tab, id: pageSurfaceTabId(connectedFolderId, nextPath), path: nextPath };
    }
    if (seen.has(next.id)) return [];
    seen.add(next.id);
    return [next];
  });
}

function closeFileSurfaceTabs(tabs: ConnectedFolderSurfaceTab[], connectedFolderId: string, deletedPaths: Set<string>): ConnectedFolderSurfaceTab[] {
  return tabs.filter((tab) => (tab.kind !== "file" && tab.kind !== "page") || tab.connectedFolderId !== connectedFolderId || !tab.path || !deletedPaths.has(tab.path));
}

export {
  activeTabAfterConversationActivation,
  browserSurfaceTab,
  browserSurfaceTabId,
  browserTabTitle,
  closeFileSurfaceTabs,
  closeUnavailableRestrictedAppSurfaceTabs,
  fileSurfaceTab,
  fileSurfaceTabId,
  historySurfaceTab,
  pageSurfaceTab,
  pageSurfaceTabId,
  normalizeStoredSurfaceTabsValue,
  recordActiveSurfaceTabConnectedFolderRecency,
  readStoredSurfaceTabsState,
  restoreStoredSurfaceTabsForConnectedFolders,
  retargetFileSurfaceTabs,
  restrictedAppSurfaceTabId,
  surfaceTabActivationForConnectedFolder,
  surfaceTabConnectedFolderSwitchTarget,
  upsertSurfaceTab,
};
