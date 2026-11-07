import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Settings24Regular } from "@fluentui/react-icons";
import { AlertTriangle, CirclePlus, Download, Loader2, Search, X } from "./components/chrome/icons";
import type { ConnectedFolderAppearanceState } from "../../src/shared/connected-folder-appearance";

import { connectedFolderPathDragType, connectedFolderPathsDragType, sidebarCollapsedStorageKey, agentPanelStorageKey } from "./constants";
import { copyToClipboard } from "./lib/clipboard";
import { deleteFolderConfirm, deleteSelectionConfirm } from "./ui-contract";
import { fileSelectionLabel } from "../../src/shared/file-selection";
import { ChatActionsPopover } from "./components/chat/ChatActionsPopover";
import { ChatPanel } from "./components/chat/ChatPanel";
import { ConnectedFolderSurfaceTabBar } from "./components/chat/ConnectedFolderSurfaceTabBar";
import { BrowserTabPanel, type BrowserTabWorker } from "./components/browser/BrowserTabPanel";
import { AmpleFileLoadingState } from "./components/brand/AmpleFileBrand";
import { CenteredState, ConnectedFolderIconGlyph } from "./components/chrome/common";
import { DesktopTitleBar } from "./components/chrome/DesktopTitleBar";
import { CommandPaletteHost, type CommandPaletteCommand } from "./components/modals/CommandPaletteHost";
import { CreateConnectedFolderModal } from "./components/modals/CreateConnectedFolderModal";
import { ConnectAiDialog } from "./components/modals/ConnectAiDialog";
import { DesktopSettingsModal, type SettingsPage } from "./components/modals/DesktopSettingsModal";
import { FileVersionHistoryModal } from "./components/modals/FileVersionHistoryModal";
import { SkillsExtensionsModal } from "./components/modals/SkillsExtensionsModal";
import { ConnectedFolderAppearanceModal, type ConnectedFolderAppearanceSection } from "./components/modals/ConnectedFolderAppearanceModal";
import { TextInputModal } from "./components/modals/TextInputModal";
import { NewFolderModal, type NewFolderTarget } from "./components/modals/NewFolderModal";
import { subscribeControlEvents } from "./lib/control-events";
import { OnboardingFlow } from "./components/onboarding/OnboardingFlow";
import { FileManagerWelcome } from "./components/file-manager/FileManagerWelcome";
import { onConnectAiRequested, requestConnectAi } from "./lib/connect-ai";
import { settleIn } from "./lib/motion";
import { FileDetailsPane } from "./components/panes/FileDetailsPane";
import { PageTab } from "./components/pages/PageTab";
import { ChecksPane, ChecksToolbarButton } from "./components/panes/ChecksPane";
import { AppStudioPane } from "./components/panes/AppStudioPane";
import { ConnectedFolderAutomationsPane } from "./components/panes/ConnectedFolderAutomationsPane";
import { ConnectedFolderAutomationsNavigator } from "./components/panes/ConnectedFolderAutomationsNavigator";
import { ExtensionSurfacePane, ExtensionSurfaceUnavailable, ExtensionSurfaceView } from "./components/panes/ExtensionSurface";
import { RestrictedAppViewport } from "./components/panes/RestrictedAppViewport";
import { ConnectedFolderModeRail, ConnectedFolderPaneHeader } from "./components/panes/connectedFolderChrome";
import { FileContentSearch } from "./components/panes/FileContentSearch";
import { ChatsPane, HistoryPane, ConnectedFoldersPane, restorePointTitle, type ModelScope } from "./components/panes/connectedFolderPanes";
import { FileContextMenu } from "./components/tree/FileContextMenu";
import { FileManagerView } from "./components/file-manager/FileManagerView";
import { useAppLayout } from "./lib/app-layout";
import { restrictedAppAttentionKey, useRestrictedAppAttention } from "./hooks/useRestrictedAppAttention";
import { FileTree, FileTreeLoadingState } from "./components/tree/FileTree";
import type { ConnectedFolderUiFixture } from "./fixtures/connected-folder-fixture";
import { useApplicationAppearance } from "./hooks/useApplicationAppearance";
import { useConnectedFolderCustomizations } from "./hooks/useConnectedFolderCustomizations";
import { collectDroppedUploadFiles, type DroppedUploadFile } from "./lib/dropped-files";
import { ConnectedFolderAppearanceProvider, useConnectedFolderIdentityResolver } from "./lib/connected-folder-appearance-context";
import { usePaneResize } from "./hooks/usePaneResize";
import { useModelConfigurationRevision } from "./hooks/useModelConfigurationRevision";
import { useBootstrapRefresh } from "./hooks/useBootstrapRefresh";
import { folderActivityStatuses, useChatActivity } from "./hooks/useChatActivity";
import { useRestrictedApps } from "./hooks/useRestrictedApps";
import { useSurfaceTabs } from "./hooks/useSurfaceTabs";
import { useBrowserTabs } from "./hooks/useBrowserTabs";
import { useConnectedFolderTree } from "./hooks/useConnectedFolderTree";
import { useConnectedFolderPages } from "./hooks/useConnectedFolderPages";
import { useConnectedFolderChecks } from "./hooks/useConnectedFolderChecks";
import { useFolderAutomations } from "./hooks/useFolderAutomations";
import { api, apiForm, apiUrl, errorText } from "./lib/api";
import { queueHistoryRequest } from "./lib/history-queue";
import { chatActivityKey, conversationLifecycleView, resolveChatSnoozePresets } from "./lib/chat-lifecycle";
import { appChangeDraft, chatContextRequestForTab, chatDraftRequestForTab } from "./lib/chat-context-request";
import { contributedSurfaces, resolveSurfaceForKey, surfaceMatchesTab } from "./lib/capability-surfaces";
import { canOpenDirectly, draggedConnectedFolderPaths, hasNativeFiles, hasConnectedFolderPathDrag, nativeOpenLabel } from "./lib/file-actions";
import { chatDisplayTitle, formatItemCount } from "./lib/format";
import { readStoredJsonValue, readStoredValue, writeStoredJsonValue, writeStoredValue } from "./lib/storage";
import { readConnectedFolderSetUpOffers, connectedFolderSetUpMessage, writeConnectedFolderSetUpOffers, type ConnectedFolderSetUpMode } from "./lib/connected-folder-setup";
import { ConnectedFolderSetUpCard } from "./components/panes/ConnectedFolderSetUpCard";
import { WindowChromeControls } from "./components/chrome/WindowChromeControls";
import { AmpleFileAgentChat } from "./popover/PopoverApp";
import { ampleFileAgentDraftEvent, type AmpleFileAgentDraftDetail } from "./lib/agent-draft";
import { defaultFileSort, fileSortStorageKey, normalizeFileSort, sortFileTree, type FileSort } from "./lib/file-sort";
import { FileSortMenu } from "./components/tree/FileSortMenu";
import { isMacOS, connectedFolderEntryNativePath } from "./lib/platform";
import { resolveRestrictedAppOpenRequest, restrictedAppRailMode, restrictedAppRailLabel, type RestrictedAppNavigatorTarget } from "./lib/restricted-app-navigation";
import { getLocalAppStudio, getLocalAppConnectedFolderRemovalImpact, prepareRestrictedAppChange } from "./lib/restricted-apps";
import { collectLoadedFileEntries, findTreeEntry, isInsideFolder, moveTreeEntry, parentFolderPath, removeTreeEntries } from "./lib/tree";
import { outermostTreePaths, selectableTreePaths, treeEntriesByPath, visibleTreePaths } from "./lib/tree-selection";
import { deleteLocalFileRequest, deleteLocalFilesRequest, pendingDeleteGroups, pendingDeleteKey, settledPendingDeletes, type PendingDelete } from "./lib/pending-deletes";
import { connectedFolderIdentityFor, connectedFolderIdentityStyle } from "./lib/connected-folder-identity";
import { childFolderPaths, combineActivityStatuses, descendantFolders, folderAncestors, folderTreeRows } from "./lib/folder-nesting";
import type { MentionFolderOption } from "./components/chat/FolderMentionMenu";
import { mentionNames } from "./lib/folder-mentions";
import { removeConnectedFolderConfirmText, surfacePanelDomId, surfaceTabDomId, connectedFolderHeaderSourceBadgeLabel } from "./lib/connected-folder-ui";
import type { AgentCatalog, AgentExtensionSurface, AgentStatus, AppThemePreference, SkillsExtensionsView, BootstrapResponse, ChatActionsState, ChatContextPathRequest, ChatDraftRequest, ConversationSummary, DesktopUpdateStatus, FileContextMenuState, RestrictedAppInstalled, TreeEntry, ConnectedFolderPane, ConnectedFolderRailMode, ConnectedFolderSummary } from "./types";
import { ConfirmDialogHost, requestConfirm, showToast, ToastHost } from "./ui/feedback";

const fixtureRequested = new URLSearchParams(window.location.search).get("fixture") === "connected-folder";

type DesktopActionCommand = "toggle-sidebar" | "toggle-agent-panel" | "new-chat" | "reload-connected-folder-state" | "open-capabilities" | "open-skills" | "open-extensions" | "open-command-palette" | "close-tab" | "customize-connected-folder" | "app-change-chat" | "open-app-build-chat" | "open-app-result-file" | "open-app-studio";
/** A cross-cutting request handled by the open Connected Folder view; app navigation from Settings carries the app or Chat it names. */
type DesktopAction = { id: number; command: DesktopActionCommand | "open-checks"; connectedFolderId?: string; app?: RestrictedAppInstalled; conversationId?: string; runtimeInstanceId?: string; path?: string; title?: string };
interface MoveLocalEntriesResult {
  moved: Array<{ fromPath: string; path: string; name: string }>;
  safetyCheckpointId: string;
  failed?: { path: string; error: string };
  notMoved?: string[];
}
interface ConnectedFolderChecksControl {
  connectedFolderId: string;
  suspend: () => Promise<void>;
  resume: () => Promise<void>;
}

export function App() {
  const appearance = useApplicationAppearance({ fixtureMode: fixtureRequested });
  const theme = appearance.theme;
  const themePreference = appearance.preferences.mode;
  const setThemePreference = useCallback((mode: AppThemePreference) => appearance.store.update({ mode }), [appearance.store]);
  const layout = useAppLayout();
  const [fixture, setFixture] = useState<ConnectedFolderUiFixture | null>(null);
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [activeConnectedFolderId, setActiveConnectedFolderId] = useState(() => localStorage.getItem("amplefile.connected-folder.active") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [createConnectedFolderOpen, setCreateConnectedFolderOpen] = useState(false);
  // Connect your AI: one dialog for every surface that finds no model connected.
  const [connectAiOpen, setConnectAiOpen] = useState(false);
  const afterConnectAi = useRef<(() => void) | undefined>(undefined);
  useEffect(() => onConnectAiRequested((then) => { afterConnectAi.current = then; setConnectAiOpen(true); }), []);
  // Connected Folders just added that still show the Set up for me card (2026-10-11).
  const [setUpOffers, setSetUpOffers] = useState<string[]>(() => readConnectedFolderSetUpOffers());
  useEffect(() => {
    if (!boot) return;
    const registered = new Set(boot.connectedFolders.map((item) => item.id));
    changeSetUpOffers((current) => current.filter((id) => registered.has(id)));
  }, [boot?.connectedFolders]);
  const changeSetUpOffers = useCallback((change: (current: string[]) => string[]) => {
    setSetUpOffers((current) => {
      const next = change(current);
      if (next.length !== current.length || next.some((id, index) => id !== current[index])) writeConnectedFolderSetUpOffers(next);
      return next;
    });
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A draft headed for the agent panel should not land behind Settings.
  useEffect(() => {
    function revealAgentPanel(event: Event): void {
      queueMicrotask(() => { if (event.defaultPrevented) setSettingsOpen(false); });
    }
    window.addEventListener(ampleFileAgentDraftEvent, revealAgentPanel);
    return () => window.removeEventListener(ampleFileAgentDraftEvent, revealAgentPanel);
  }, []);
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPage>("appearance");
  const [settingsModelScope, setSettingsModelScope] = useState<ModelScope | undefined>(undefined);
  const [settingsFocusAiModel, setSettingsFocusAiModel] = useState(false);
  const [settingsWorkerConnectedFolderId, setSettingsWorkerConnectedFolderId] = useState<string | undefined>();
  const [settingsFocusWorkerInstructions, setSettingsFocusWorkerInstructions] = useState(false);
  const [settingsBackAction, setSettingsBackAction] = useState<(() => void) | null>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const [modelConfigurationRevision, modelConfigurationChanged] = useModelConfigurationRevision(!fixtureRequested);
  const activeChecksControlRef = useRef<ConnectedFolderChecksControl | null>(null);
  const [pendingConnectedFolderOpen, setPendingConnectedFolderOpen] = useState<{ id: number; connectedFolderId: string; view?: "checks" } | null>(null);
  const [desktopAction, setDesktopAction] = useState<DesktopAction | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const handleRestrictedAppError = useCallback((caught: unknown) => setError(errorText(caught)), []);
  // Installed apps live above the Connected Folder view so Settings → Apps and the rail read one list.
  const restrictedAppsState = useRestrictedApps({ activeConnectedFolderId: boot ? activeConnectedFolderId : "", connectedFolders: boot?.connectedFolders, fixtureMode: fixtureRequested, onError: handleRestrictedAppError });
  const showDesktopTitleBar = window.ampleFileDesktop?.app.platform === "win32";

  const openSettings = useCallback((page: SettingsPage = "appearance", modelScope?: ModelScope, focusAiModel = false, workerConnectedFolderId?: string, focusWorkerInstructions = false, backToCustomization?: () => void) => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settingsReturnFocusRef.current = focused && focused !== document.body && !focused.closest(".modal-backdrop")
      ? focused : document.querySelector<HTMLButtonElement>(".connected-folder-pane-switch-trigger");
    setSettingsInitialPage(page);
    setSettingsModelScope(page === "ai-models" ? modelScope : undefined);
    setSettingsFocusAiModel(page === "ai-models" && focusAiModel);
    setSettingsWorkerConnectedFolderId(page === "ai-models" ? workerConnectedFolderId : undefined);
    setSettingsFocusWorkerInstructions(page === "ai-models" && focusWorkerInstructions);
    setSettingsBackAction(() => backToCustomization ?? null);
    setSettingsOpen(true);
  }, []);
  const openKeyboardShortcuts = useCallback(() => openSettings("shortcuts"), [openSettings]);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsBackAction(null);
    const target = settingsReturnFocusRef.current;
    window.requestAnimationFrame(() => { if (target?.isConnected && !target.inert) target.focus(); });
  }, []);
  const updateActiveChecksControl = useCallback((control: ConnectedFolderChecksControl | null) => {
    if (control || activeChecksControlRef.current?.connectedFolderId === activeConnectedFolderId) {
      activeChecksControlRef.current = control;
    }
  }, [activeConnectedFolderId]);

  useScrollbarActivity();

  const refreshBootstrap = useBootstrapRefresh(!fixtureRequested, (result) => {
    setBoot(result);
    setActiveConnectedFolderId((current) => result.connectedFolders.some((item) => item.id === current) ? current : result.connectedFolders[0]?.id ?? "");
  }, setError);

  useEffect(() => {
    if (fixtureRequested) return;
    return subscribeControlEvents((hint) => {
      if (hint === "connected-folders" || hint === "reset") void refreshBootstrap();
    });
  }, [refreshBootstrap]);

  useEffect(() => {
    if (fixtureRequested) {
      void import("./fixtures/connected-folder-fixture").then(({ buildConnectedFolderFixture }) => {
        const next = buildConnectedFolderFixture(); setFixture(next);
        // `&firstRun=1` previews first run: no Connected Folders yet and no AI connected.
        const firstRun = new URLSearchParams(window.location.search).get("firstRun") === "1";
        setBoot({ connectedFolders: firstRun ? [] : next.connectedFolders, agent: firstRun ? { ...next.agent, configured: false } : next.agent });
        setActiveConnectedFolderId(firstRun ? "" : next.activeConnectedFolderId);
      }).catch((caught) => setError(errorText(caught)));
      return;
    }
    void refreshBootstrap();
  }, [refreshBootstrap]);

  useEffect(() => {
    if (fixtureRequested) return;
    function refreshOnReturn() {
      if (document.visibilityState !== "visible") return;
      void refreshBootstrap();
    }
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [refreshBootstrap]);

  const activeConnectedFolder = useMemo(() => boot?.connectedFolders.find((item) => item.id === activeConnectedFolderId) ?? boot?.connectedFolders[0] ?? null, [activeConnectedFolderId, boot]);
  useEffect(() => {
    if (!fixtureRequested && boot) {
      if (activeConnectedFolder) localStorage.setItem("amplefile.connected-folder.active", activeConnectedFolder.id);
      else localStorage.removeItem("amplefile.connected-folder.active");
    }
    if (activeConnectedFolder) setActiveConnectedFolderId(activeConnectedFolder.id);
  }, [activeConnectedFolder?.id, Boolean(boot)]);
  useEffect(() => {
    if (fixtureRequested) return;
    let cancelled = false;
    void window.ampleFileDesktop?.connectedFolder.setActiveConnectedFolder?.(activeConnectedFolder?.id ?? null).catch(async (caught) => {
      if (cancelled) return;
      const current = await refreshBootstrap();
      if (!cancelled && (!activeConnectedFolder || !current || current.connectedFolders.some((item) => item.id === activeConnectedFolder.id))) setError(errorText(caught));
    });
    return () => { cancelled = true; };
  }, [activeConnectedFolder?.id, activeConnectedFolder?.name, activeConnectedFolder?.connectedFolderRoot]);
  useEffect(() => {
    const desktopConnectedFolder = window.ampleFileDesktop?.connectedFolder;
    if (!desktopConnectedFolder?.onOpenConnectedFolder || !boot) return;
    return desktopConnectedFolder.onOpenConnectedFolder((connectedFolderId, view) => {
      setPendingConnectedFolderOpen({ id: Date.now(), connectedFolderId, view });
      if (!boot.connectedFolders.some((connectedFolder) => connectedFolder.id === connectedFolderId)) void refreshBootstrap();
    });
  }, [boot?.connectedFolders, refreshBootstrap]);
  useEffect(() => {
    if (!pendingConnectedFolderOpen || !boot?.connectedFolders.some((connectedFolder) => connectedFolder.id === pendingConnectedFolderOpen.connectedFolderId)) return;
    setActiveConnectedFolderId(pendingConnectedFolderOpen.connectedFolderId);
    if (pendingConnectedFolderOpen.view === "checks") setDesktopAction({ id: pendingConnectedFolderOpen.id, command: "open-checks" });
    setPendingConnectedFolderOpen(null);
  }, [pendingConnectedFolderOpen, boot?.connectedFolders]);
  useEffect(() => {
    const updates = window.ampleFileDesktop?.updates;
    if (!updates) return;
    let cancelled = false;
    void updates.getStatus().then((status) => { if (!cancelled) setUpdateStatus(status); }).catch((caught) => { if (!cancelled) setError(errorText(caught)); });
    const unsubscribe = updates.onStatusChanged((status) => { if (!cancelled) setUpdateStatus(status); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  useEffect(() => {
    const menu = window.ampleFileDesktop?.menu;
    if (!menu) return;
    menu.setState({ connectedFolderOpen: Boolean(activeConnectedFolder) });
    return menu.onCommand((command) => {
      if (command === "new-connected-folder") setCreateConnectedFolderOpen(true);
      else if (command === "open-local-folder") void openFolder();
      else if (command === "check-for-updates") void checkForUpdates();
      else if (command === "open-settings") openSettings();
      else if (command === "open-about") openSettings("about");
      else if (command === "open-keyboard-shortcuts") openKeyboardShortcuts();
      else if (command === "new-chat" || command === "reload-connected-folder-state" || command === "open-capabilities" || command === "open-skills" || command === "open-extensions" || command === "open-command-palette" || command === "close-tab" || command === "toggle-sidebar" || command === "toggle-agent-panel") {
        setDesktopAction({ id: Date.now(), command });
      }
    });
  }, [activeConnectedFolder?.id, openKeyboardShortcuts, openSettings, refreshBootstrap]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "/" || event.code === "Slash")) {
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        openKeyboardShortcuts();
      }
    }
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [openKeyboardShortcuts]);
  useEffect(() => {
    const unsubscribe = window.ampleFileDesktop?.runtime.onRendererRecovered?.(() => {
      showToast({ text: "AmpleFile recovered from a problem and reloaded.", tone: "info" });
    });
    return unsubscribe;
  }, []);
  useEffect(() => window.ampleFileDesktop?.agent.onOpenSettings((scope) => openSettings("ai-models", scope, true)), [openSettings]);

  async function createConnectedFolder(name: string) {
    if (fixtureRequested) { setCreateConnectedFolderOpen(false); showToast({ text: "Connected Folder creation is disabled in the preview", tone: "info" }); return; }
    const checksControl = activeChecksControlRef.current;
    try {
      await checksControl?.suspend();
      const result = await api<{ connectedFolder: ConnectedFolderSummary }>("/api/connected-folders", { method: "POST", body: { name } });
      await refreshBootstrap(); setActiveConnectedFolderId(result.connectedFolder.id); setCreateConnectedFolderOpen(false);
      changeSetUpOffers((current) => [...current.filter((id) => id !== result.connectedFolder.id), result.connectedFolder.id]);
    } finally {
      void checksControl?.resume();
    }
  }

  async function openFolder() {
    const picker = window.ampleFileDesktop?.connectedFolder;
    if (!picker) return setError("Folder selection is available in the desktop app.");
    let checksControl: ConnectedFolderChecksControl | null = null;
    try {
      const selected = await picker.chooseFolder(); if (!selected) return;
      checksControl = activeChecksControlRef.current;
      await checksControl?.suspend();
      const result = await api<{ connectedFolder: ConnectedFolderSummary }>("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: selected.path, folderGrantId: selected.folderGrantId } });
      await refreshBootstrap(); setActiveConnectedFolderId(result.connectedFolder.id);
      changeSetUpOffers((current) => [...current.filter((id) => id !== result.connectedFolder.id), result.connectedFolder.id]);
    } catch (caught) { setError(errorText(caught)); }
    finally { void checksControl?.resume(); }
  }

  async function checkForUpdates() {
    try { const status = await window.ampleFileDesktop?.updates.check(); if (status) setUpdateStatus(status); } catch (caught) { setError(errorText(caught)); }
  }

  /** A provider was connected from first run or the Connect AI dialog. */
  /** First run's one-click start: a Standard Folder (Downloads, say) becomes the first Connected Folder. Nothing moves. */
  async function putStandardFolderToWork(standardFolderId: string) {
    if (fixture) { showToast({ text: "Making Connected Folders is disabled in the preview", tone: "info" }); return; }
    try {
      const { connectedFolder } = await api<{ connectedFolder: ConnectedFolderSummary }>(`/api/standard-folders/${encodeURIComponent(standardFolderId)}/connected-folders`, { method: "POST", body: { path: "" } });
      await refreshBootstrap();
      setActiveConnectedFolderId(connectedFolder.id);
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  function aiConnected(agent: AgentStatus) {
    setBoot((current) => current ? { ...current, agent } : current);
    modelConfigurationChanged();
  }

  async function runUpdateAction() {
    const updates = window.ampleFileDesktop?.updates;
    if (!updates) return;
    try {
      const status = updateStatus?.phase === "ready"
        ? await updates.install()
        : updateStatus?.phase === "available" || updateStatus?.phase === "error"
          ? await updates.updateNow()
          : await updates.check();
      setUpdateStatus(status);
    } catch (caught) { setError(errorText(caught)); }
  }

  // In the file manager an error is a notice like the others (owner request, 2026-11-07): one card style, stacked, never a bar over the window.
  const errorsAsNotices = layout === "file-manager" && Boolean(activeConnectedFolder);
  useEffect(() => {
    if (!errorsAsNotices || !error) return;
    showToast({ text: error, tone: "error" });
    setError(null);
  }, [error, errorsAsNotices]);
  if (!boot || (fixtureRequested && !fixture)) return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""}`} data-theme={theme}>{showDesktopTitleBar ? <DesktopTitleBar /> : null}<AmpleFileLoadingState message={error ?? "Loading your Connected Folders and Workers."} action={error ? <button className="ui-control" type="button" onClick={() => { setError(null); void refreshBootstrap(); }}>Try Again</button> : undefined} /></div>;

  const fileManagerLayout = layout === "file-manager" && Boolean(activeConnectedFolder);
  // First run in the file manager wears its look too, before there is a Connected Folder to show.
  const fileManagerShell = layout === "file-manager";
  return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""}${fileManagerShell ? " layout-file-manager" : ""}`} data-theme={theme}>
    {showDesktopTitleBar ? <DesktopTitleBar /> : null}
    {activeConnectedFolder && fileManagerLayout ? <ConnectedFolderAppearanceProvider palette={appearance.preferences.palette}><FileManagerView connectedFolder={activeConnectedFolder} connectedFolders={boot.connectedFolders} appearance={boot.appearance} agent={boot.agent} desktopAction={desktopAction} fixture={fixture} onSwitchConnectedFolder={(connectedFolder) => setActiveConnectedFolderId(connectedFolder.id)} onOpenSettings={openSettings} onRefreshBootstrap={refreshBootstrap} onCreateConnectedFolder={() => setCreateConnectedFolderOpen(true)} onOpenFolder={() => void openFolder()} onError={setError} /></ConnectedFolderAppearanceProvider>
    : activeConnectedFolder ? <ConnectedFolderAppearanceProvider palette={appearance.preferences.palette}><ConnectedFolderView connectedFolder={activeConnectedFolder} connectedFolders={boot.connectedFolders} restrictedAppsStore={restrictedAppsState} agent={boot.agent} modelConfigurationRevision={modelConfigurationRevision} appearance={boot.appearance} fixture={fixture} desktopAction={desktopAction} updateStatus={updateStatus} themePreference={themePreference} onThemePreferenceChange={setThemePreference} onUpdateAction={() => void runUpdateAction()} onSwitchConnectedFolder={(connectedFolder) => setActiveConnectedFolderId(connectedFolder.id)} onRefreshBootstrap={refreshBootstrap} onCreateConnectedFolder={() => setCreateConnectedFolderOpen(true)} onOpenFolder={() => void openFolder()} onChecksControlChange={updateActiveChecksControl} onOpenSettings={openSettings} onOpenShortcuts={openKeyboardShortcuts} onError={setError} setUpOffered={setUpOffers.includes(activeConnectedFolder.id)} onCloseSetUpOffer={() => changeSetUpOffers((current) => current.filter((id) => id !== activeConnectedFolder.id))} /></ConnectedFolderAppearanceProvider> : fileManagerShell ? <FileManagerWelcome agentConfigured={Boolean(boot.agent?.configured)} fixtureMode={Boolean(fixture)} onAiConnected={aiConnected} onPutToWork={putStandardFolderToWork} onCreateConnectedFolder={() => setCreateConnectedFolderOpen(true)} onOpenFolder={() => void openFolder()} onOpenSettings={() => openSettings("ai-models", "agent", true)} /> : <OnboardingFlow agentConfigured={Boolean(boot.agent?.configured)} onAiConnected={aiConnected} onCreateConnectedFolder={() => setCreateConnectedFolderOpen(true)} onOpenFolder={() => void openFolder()} onOpenSettings={() => openSettings("ai-models", "agent", true)} fixtureMode={Boolean(fixture)} />}
    {error && !fileManagerLayout ? <div className="global-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss"><X size={15} /></button></div> : null}
    {createConnectedFolderOpen ? <CreateConnectedFolderModal onClose={() => setCreateConnectedFolderOpen(false)} onCreate={createConnectedFolder} /> : null}
    {connectAiOpen ? <ConnectAiDialog fixtureMode={Boolean(fixture)} onClose={() => { afterConnectAi.current = undefined; setConnectAiOpen(false); }} onConnected={(connected) => { aiConnected(connected.status); const then = afterConnectAi.current; afterConnectAi.current = undefined; then?.(); }} onOpenSettings={() => { setConnectAiOpen(false); openSettings("ai-models", "agent", true); }} /> : null}
    {settingsOpen ? <DesktopSettingsModal layout={fileManagerLayout ? "file-manager" : "classic"} appearance={appearance} onCustomizeConnectedFolder={(connectedFolderId) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "customize-connected-folder", connectedFolderId }); }} connectedFolder={settingsWorkerConnectedFolderId ? boot.connectedFolders.find((item) => item.id === settingsWorkerConnectedFolderId) ?? null : activeConnectedFolder} connectedFolders={boot.connectedFolders} restrictedApps={restrictedAppsState} onChangeApp={(app) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "app-change-chat", connectedFolderId: app.sourceConnectedFolderId, app }); }} onOpenAppBuildChat={(connectedFolderId, conversationId) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "open-app-build-chat", connectedFolderId, conversationId }); }} onOpenAppResultFile={(connectedFolderId, path) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "open-app-result-file", connectedFolderId, path }); }} onOpenAppStudio={(connectedFolderId, runtimeInstanceId) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "open-app-studio", connectedFolderId, ...(runtimeInstanceId ? { runtimeInstanceId } : {}) }); }} agentStatus={boot.agent} fixtureMode={Boolean(fixture)} initialPage={settingsInitialPage} initialModelScope={settingsModelScope} focusAiModel={settingsFocusAiModel} focusWorkerInstructions={settingsFocusWorkerInstructions} onAgentConfigured={(agent) => setBoot((current) => current ? { ...current, agent } : current)} onModelChanged={modelConfigurationChanged} updateStatus={updateStatus} onUpdateAction={() => void runUpdateAction()} onBackToCustomization={settingsBackAction ? () => { setSettingsOpen(false); setSettingsBackAction(null); settingsBackAction(); } : undefined} onClose={closeSettings} /> : null}
    <ConfirmDialogHost /><ToastHost />
  </div>;
}

function ConnectedFolderView({ connectedFolder, connectedFolders, restrictedAppsStore, agent, modelConfigurationRevision, appearance, fixture, desktopAction, updateStatus, themePreference, onThemePreferenceChange, onUpdateAction, onSwitchConnectedFolder, onRefreshBootstrap, onCreateConnectedFolder, onOpenFolder, onChecksControlChange, onOpenSettings, onOpenShortcuts, onError, setUpOffered, onCloseSetUpOffer }: {
  connectedFolder: ConnectedFolderSummary;
  connectedFolders: ConnectedFolderSummary[];
  restrictedAppsStore: ReturnType<typeof useRestrictedApps>;
  agent: BootstrapResponse["agent"];
  modelConfigurationRevision: number;
  appearance?: ConnectedFolderAppearanceState;
  fixture: ConnectedFolderUiFixture | null;
  desktopAction: DesktopAction | null;
  updateStatus: DesktopUpdateStatus | null;
  themePreference: AppThemePreference;
  onThemePreferenceChange: (theme: AppThemePreference) => void;
  onUpdateAction: () => void;
  onSwitchConnectedFolder: (connectedFolder: ConnectedFolderSummary) => void;
  onRefreshBootstrap: () => Promise<unknown>;
  onCreateConnectedFolder: () => void;
  onOpenFolder: () => void;
  onChecksControlChange: (control: ConnectedFolderChecksControl | null) => void;
  onOpenSettings: (page?: SettingsPage, modelScope?: ModelScope, focusAiModel?: boolean, workerConnectedFolderId?: string, focusWorkerInstructions?: boolean, backToCustomization?: () => void) => void;
  onOpenShortcuts: () => void;
  onError: (message: string | null) => void;
  /** This Connected Folder was just added and its Set up for me card has not been used or dismissed. */
  setUpOffered: boolean;
  onCloseSetUpOffer: () => void;
}) {
  const initialStoredModeRef = useRef(fixture ? null : localStorage.getItem("amplefile.connected-folder.mode"));
  const [activeMode, setActiveMode] = useState<ConnectedFolderRailMode>(() => fixture ? "files" : normalizeMode(initialStoredModeRef.current));
  // Where a notification click opened an app's left-pane view. The rail
  // button, or leaving that app, returns it to its home ("/").
  const [restrictedAppNavigatorTarget, setRestrictedAppNavigatorTarget] = useState<RestrictedAppNavigatorTarget | null>(null);
  const connectedFolderCustomizations = useConnectedFolderCustomizations({
    fixtureCustomizations: fixture ? fixture.customizations : null,
    appearance,
    connectedFolderIds: connectedFolders.map((item) => item.id).join("|"),
  });
  const { customizations } = connectedFolderCustomizations;
  const [conversationGroups, setConversationGroups] = useState<Record<string, ConversationSummary[]>>(() => fixture ? fixtureConversationGroups(fixture) : {});
  const [surfaceCatalogs, setSurfaceCatalogs] = useState<Record<string, AgentExtensionSurface[]>>(() => fixture ? fixture.surfaces : {});
  const surfaceCatalogRequestRef = useRef(0);
  const chatActivity = useChatActivity(Boolean(fixture));
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [renameEntryRequest, setRenameEntryRequest] = useState<{ path: string; name: string } | null>(null);
  const [newFolderTarget, setNewFolderTarget] = useState<NewFolderTarget | null>(null);
  const [chatActions, setChatActions] = useState<ChatActionsState | null>(null);
  const [versionHistory, setVersionHistory] = useState<{ connectedFolder: ConnectedFolderSummary; path: string; name: string } | null>(null);
  const [appearanceConnectedFolderId, setAppearanceConnectedFolderId] = useState<string | null>(null);
  const [appearanceInitialSection, setAppearanceInitialSection] = useState<ConnectedFolderAppearanceSection>("banner");
  const appearanceConnectedFolder = connectedFolders.find((item) => item.id === appearanceConnectedFolderId);
  const appearanceReturnFocusRef = useRef<HTMLElement | null>(null);
  const [contextRequest, setContextRequest] = useState<ChatContextPathRequest | null>(null);
  const [draftRequest, setDraftRequest] = useState<ChatDraftRequest | null>(null);
  const draftRequestId = useRef(0);
  const appChangeRequests = useRef(new Map<string, string>());
  const [appStudioNavigation, setAppStudioNavigation] = useState<{ id: string; sourceConnectedFolderId: string; runtimeInstanceId: string } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const commandPaletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const [historyRefreshRequest, setHistoryRefreshRequest] = useState(0);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadTargetPath, setUploadTargetPath] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  // Another Connected Folder's banner and left pane settle in rather than cutting.
  const modePaneRef = useRef<HTMLElement | null>(null);
  const shownConnectedFolderIdRef = useRef(connectedFolder.id);
  useLayoutEffect(() => {
    if (shownConnectedFolderIdRef.current === connectedFolder.id) return;
    shownConnectedFolderIdRef.current = connectedFolder.id;
    settleIn([modePaneRef.current]);
  }, [connectedFolder.id]);
  const contextRequestId = useRef(0);
  const pendingDeletesRef = useRef(new Map<string, PendingDelete>());
  const pendingDeleteBatchRef = useRef(0);
  const activeConnectedFolderIdRef = useRef(connectedFolder.id);
  activeConnectedFolderIdRef.current = connectedFolder.id;
  const tree = useConnectedFolderTree(connectedFolder, onError, fixture?.trees[connectedFolder.id]);
  // Page folders show a page icon in Files and open their page tab (docs/pages.md).
  const pageFolders = useConnectedFolderPages(connectedFolder.id, Boolean(fixture));
  const [fileSort, setFileSort] = useState<FileSort>(() => readStoredJsonValue(fileSortStorageKey, normalizeFileSort, defaultFileSort));
  const sortedFileEntries = useMemo(() => sortFileTree(tree.visibleEntries, fileSort), [tree.visibleEntries, fileSort]);
  const fileTreeCollapsedPaths = useMemo(() => tree.query ? new Set<string>() : tree.collapsedPaths, [tree.query, tree.collapsedPaths]);
  // The rows Files shows, top to bottom: the order Shift-click selects in.
  const shownTreePaths = useMemo(() => visibleTreePaths(sortedFileEntries, fileTreeCollapsedPaths), [sortedFileEntries, fileTreeCollapsedPaths]);
  // Rows a search hides stay selected, to show again when it clears; deleted rows and rows in a closed folder leave.
  const searchingFiles = Boolean(tree.query.trim());
  useEffect(() => tree.keepSelectionWithin(selectableTreePaths(tree.tree, shownTreePaths, searchingFiles)), [shownTreePaths, searchingFiles, tree.tree]);
  function changeFileSort(next: FileSort): void {
    setFileSort(next);
    writeStoredJsonValue(fileSortStorageKey, next);
  }
  const selectedPathRef = useRef(tree.selectedPath);
  selectedPathRef.current = tree.selectedPath;
  const paneResize = usePaneResize(Boolean(fixture));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readStoredValue(sidebarCollapsedStorageKey) === "true");
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sidebarCollapsedRef.current = sidebarCollapsed;
  function setSidebarHidden(hidden: boolean): void {
    sidebarCollapsedRef.current = hidden;
    setSidebarCollapsed(hidden);
    writeStoredValue(sidebarCollapsedStorageKey, hidden ? "true" : null);
  }
  // The AmpleFile agent panel: open state and width survive restarts, and the
  // chat stays mounted once opened so a closed panel keeps its draft and stream.
  const [agentPanel, setAgentPanel] = useState(() => readStoredJsonValue(agentPanelStorageKey, normalizeAgentPanelState, defaultAgentPanelState));
  const agentPanelOpen = agentPanel.open;
  const [agentPanelMounted, setAgentPanelMounted] = useState(agentPanel.open);
  const [agentControlsTarget, setAgentControlsTarget] = useState<HTMLDivElement | null>(null);
  const [agentPanelResizing, setAgentPanelResizing] = useState(false);
  function updateAgentPanel(update: (current: AgentPanelState) => AgentPanelState): void {
    setAgentPanel((current) => {
      const next = update(current);
      writeStoredJsonValue(agentPanelStorageKey, next);
      return next;
    });
  }
  function toggleAgentPanel(): void {
    setAgentPanelMounted(true);
    updateAgentPanel((current) => ({ ...current, open: !current.open }));
  }
  const [agentDraftRequest, setAgentDraftRequest] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    function takeDraft(event: Event): void {
      const text = (event as CustomEvent<AmpleFileAgentDraftDetail>).detail?.text;
      if (typeof text !== "string" || !text.trim()) return;
      event.preventDefault();
      setAgentPanelMounted(true);
      updateAgentPanel((current) => ({ ...current, open: true }));
      setAgentDraftRequest((current) => ({ id: (current?.id ?? 0) + 1, text }));
    }
    window.addEventListener(ampleFileAgentDraftEvent, takeDraft);
    return () => window.removeEventListener(ampleFileAgentDraftEvent, takeDraft);
  }, []);
  function startAgentPanelResize(event: import("react").PointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setAgentPanelResizing(true);
    const move = (moveEvent: PointerEvent) => {
      const width = clampAgentPanelWidth(window.innerWidth - moveEvent.clientX - 12);
      setAgentPanel((current) => ({ ...current, width }));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setAgentPanelResizing(false);
      setAgentPanel((current) => { writeStoredJsonValue(agentPanelStorageKey, current); return current; });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  function resizeAgentPanelWithKeys(event: import("react").KeyboardEvent<HTMLButtonElement>): void {
    const step = event.shiftKey ? 48 : 16;
    const delta = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    if (event.key === "Home" || event.key === "End" || delta) {
      event.preventDefault();
      updateAgentPanel((current) => ({ ...current, width: event.key === "Home" ? agentPanelMinWidth : event.key === "End" ? clampAgentPanelWidth(Number.POSITIVE_INFINITY) : clampAgentPanelWidth(current.width + delta) }));
    }
  }
  const tabs = useSurfaceTabs({
    connectedFolder,
    connectedFolders,
    fixtureMode: Boolean(fixture),
    onSwitchConnectedFolder,
  });
  const browser = useBrowserTabs(tabs);
  useEffect(() => {
    function openResult(event: Event) {
      const { connectedFolderId, path } = (event as CustomEvent<{ connectedFolderId: string; path: string }>).detail;
      const target = connectedFolders.find((item) => item.id === connectedFolderId);
      if (target && typeof path === "string") tabs.openFileSurfaceTab(target, path);
    }
    window.addEventListener("amplefile:open-result-file", openResult);
    return () => window.removeEventListener("amplefile:open-result-file", openResult);
  }, [connectedFolders, tabs.openFileSurfaceTab]);
  // Background Worker turns (handoffs into nested Connected Folders, CLI sends) light
  // the same dots as open Chat tabs. The host sends a content-free hint on
  // every turn start and end; the renderer requeries the running set.
  const watchedChatKeysRef = useRef<Set<string>>(new Set());
  watchedChatKeysRef.current = new Set(tabs.surfaceTabs.flatMap((tab) => tab.kind === "chat" && tab.conversationId ? [chatActivityKey(tab.connectedFolderId, tab.conversationId)] : []));
  const conversationGroupsRef = useRef(conversationGroups);
  conversationGroupsRef.current = conversationGroups;
  const connectedFoldersRef = useRef(connectedFolders);
  connectedFoldersRef.current = connectedFolders;
  /** Reopen Closed Tab: whichever tab the person closed last, browser or not. */
  function reopenClosedTab(): boolean {
    if (browser.lastClosedAt() > tabs.lastClosedSurfaceTabAt()) return browser.reopenClosed();
    return tabs.reopenClosedSurfaceTab((tab) => connectedFoldersRef.current.some((item) => item.id === tab.connectedFolderId)
      && (tab.kind !== "chat" || !tab.conversationId || Boolean(conversationGroupsRef.current[tab.connectedFolderId]?.some((chat) => chat.id === tab.conversationId))))
      || browser.reopenClosed();
  }
  useEffect(() => {
    if (fixture) return;
    let disposed = false;
    let timer: number | null = null;
    // Only the newest answer counts: an older response resolving late would
    // re-add a finished turn and leave its dot pulsing.
    let generation = 0;
    const upsertConversations = (connectedFolderId: string) => {
      void api<{ conversations: ConversationSummary[] }>(`/api/connected-folders/${connectedFolderId}/conversations`)
        .then(({ conversations }) => {
          if (disposed) return;
          setConversationGroups((current) => {
            // Merge by id: a Chat this window just created may not be on the
            // server's list yet and must not disappear.
            const fresh = new Map(conversations.map((chat) => [chat.id, chat]));
            const localOnly = (current[connectedFolderId] ?? []).filter((chat) => !fresh.has(chat.id));
            return { ...current, [connectedFolderId]: [...conversations, ...localOnly].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) };
          });
        })
        .catch(() => {});
    };
    const refreshActivity = () => {
      const request = ++generation;
      void api<{ running: Array<{ connectedFolderId: string; conversationId: string }> }>("/api/connected-folders/activity").then(({ running }) => {
        if (disposed || request !== generation) return;
        const finished = chatActivity.syncBackgroundRunning(new Set(running.map((item) => chatActivityKey(item.connectedFolderId, item.conversationId))), (key) => watchedChatKeysRef.current.has(key));
        // A handed-off Chat is new to its Connected Folder's list, and a finished one has
        // a new title and time: refresh those Connected Folders' lists.
        const connectedFolderIds = new Set([
          ...running.filter((item) => !conversationGroupsRef.current[item.connectedFolderId]?.some((chat) => chat.id === item.conversationId)).map((item) => item.connectedFolderId),
          ...finished.map((key) => key.slice(0, key.indexOf(":"))),
        ]);
        for (const connectedFolderId of connectedFolderIds) if (connectedFolderId) upsertConversations(connectedFolderId);
      }).catch(() => {});
    };
    refreshActivity();
    const unsubscribe = subscribeControlEvents((hint) => {
      if (hint !== "activity" && hint !== "reset") return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; refreshActivity(); }, 120);
    });
    return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); unsubscribe(); };
  }, [fixture, chatActivity.syncBackgroundRunning]);
  // Once every Connected Folder's Chat list has loaded, a saved mark for a Chat or Connected Folder
  // that no longer exists is gone for good.
  useEffect(() => {
    if (fixture || !connectedFolders.length || connectedFolders.some((item) => !conversationGroups[item.id])) return;
    const known = new Set(connectedFolders.flatMap((item) => (conversationGroups[item.id] ?? []).map((chat) => chatActivityKey(item.id, chat.id))));
    chatActivity.pruneAttention((key) => !known.has(key) && !watchedChatKeysRef.current.has(key));
  }, [fixture, connectedFolders, conversationGroups, chatActivity.pruneAttention]);
  const folderStatuses = useMemo(() => folderActivityStatuses(chatActivity.statuses, conversationGroups), [chatActivity.statuses, conversationGroups]);
  const restrictedAppsState = restrictedAppsStore;
  const [skillsExtensionsView, setSkillsExtensionsView] = useState<SkillsExtensionsView | null>(null);
  const activeTab = tabs.surfaceTabs.find((tab) => tab.id === tabs.activeSurfaceTabId) ?? null;
  // Each file and page has its own tab, so switching those tabs selects it in Files.
  const activeFilePath = (activeTab?.kind === "file" || activeTab?.kind === "page") && activeTab.connectedFolderId === connectedFolder.id ? activeTab.path : null;
  // A multi-selection that already holds the file is left alone, such as several rows that just moved together.
  useEffect(() => {
    if (activeFilePath && !(tree.selectedPaths.size > 1 && tree.selectedPaths.has(activeFilePath))) tree.setSelectedPath(activeFilePath);
  }, [activeFilePath]);
  const checks = useConnectedFolderChecks(connectedFolder, Boolean(fixture), activeTab?.kind !== "checks");
  const folderAutomations = useFolderAutomations(connectedFolder.id, Boolean(fixture));
  const hasFolderAutomations = (folderAutomations.byConnectedFolder[connectedFolder.id]?.length ?? 0) > 0;
  const folderAutomationsLoaded = folderAutomations.byConnectedFolder[connectedFolder.id] !== undefined;
  // The Automations list is fresh whenever it is shown, and once nothing in
  // this Connected Folder is automated any more, the pane falls back to Files.
  useEffect(() => {
    if (activeMode !== "automations") return;
    if (folderAutomationsLoaded && !hasFolderAutomations) setActiveMode("files");
  }, [activeMode, folderAutomationsLoaded, hasFolderAutomations]);
  useEffect(() => {
    if (activeMode === "automations" && !fixture) void folderAutomations.refresh(connectedFolder.id);
  }, [activeMode, connectedFolder.id]);
  useEffect(() => {
    const control = { connectedFolderId: connectedFolder.id, suspend: checks.suspend, resume: checks.resume };
    onChecksControlChange(control);
    return () => onChecksControlChange(null);
  }, [checks.resume, checks.suspend, onChecksControlChange, connectedFolder.id]);
  const connectedFolderIdentityFor = useConnectedFolderIdentityResolver();
  const identity = connectedFolderIdentityFor(connectedFolder, customizations);
  const nestedFolderViews = useMemo(() => new Map([...childFolderPaths(connectedFolder, connectedFolders)].map(([path, child]) => [path, {
    connectedFolder: child,
    identity: connectedFolderIdentityFor(child, customizations),
    status: combineActivityStatuses([child, ...descendantFolders(child, connectedFolders)].map((item) => folderStatuses[item.id])),
  }])), [customizations, folderStatuses, connectedFolder, connectedFolderIdentityFor, connectedFolders]);
  // The Workers a Chat can address with @ (2026-10-01): the Connected Folders inside
  // this one first, then the ones containing it, then everything else.
  const mentionFoldersFor = useCallback((target: ConnectedFolderSummary): MentionFolderOption[] => {
    const inside = folderTreeRows(descendantFolders(target, connectedFolders)).map((row) => row.connectedFolder);
    const containing = folderAncestors(target, connectedFolders).reverse();
    const seen = new Set([target.id, ...inside.map((item) => item.id), ...containing.map((item) => item.id)]);
    const others = connectedFolders.filter((item) => !seen.has(item.id)).sort((left, right) => left.name.localeCompare(right.name));
    const names = mentionNames(connectedFolders);
    return [...inside, ...containing, ...others].map((item) => {
      const itemIdentity = connectedFolderIdentityFor(item, customizations);
      return {
        id: item.id,
        name: names.get(item.id) ?? item.name,
        icon: <ConnectedFolderIconGlyph icon={itemIdentity.Icon} size={13} filled />,
        style: connectedFolderIdentityStyle(itemIdentity),
        status: folderStatuses[item.id] ?? null,
      };
    });
  }, [customizations, folderStatuses, connectedFolderIdentityFor, connectedFolders]);
  const surfaceCatalogKnown = Object.prototype.hasOwnProperty.call(surfaceCatalogs, connectedFolder.id);
  const restrictedAppCatalogKnown = restrictedAppsState.knownConnectedFolderIds.has(connectedFolder.id);
  const restrictedApps = restrictedAppsState.appsByConnectedFolder[connectedFolder.id] ?? [];
  const appAttention = useRestrictedAppAttention();
  useEffect(() => {
    tabs.reconcileRestrictedAppSurfaceTabs(
      restrictedAppsState.appsByConnectedFolder,
      restrictedAppsState.knownConnectedFolderIds,
    );
  }, [restrictedAppsState.appsByConnectedFolder, restrictedAppsState.knownConnectedFolderIds, tabs.reconcileRestrictedAppSurfaceTabs]);
  const surfaces = useMemo(() => contributedSurfaces(connectedFolder.id, surfaceCatalogs[connectedFolder.id] ?? []), [surfaceCatalogs, connectedFolder.id]);
  const activeSurfaceKey = extensionSurfaceIdForMode(activeMode);
  const activeSurface = activeSurfaceKey ? resolveSurfaceForKey(surfaces, activeSurfaceKey) : null;
  const activeRestrictedApp = restrictedApps.find((app) => restrictedAppRailMode(connectedFolder.id, app.manifest.id, app.featureInstallationId) === activeMode) ?? null;
  const previewLocalFile = useCallback((path: string) => {
    const previewFile = window.ampleFileDesktop?.connectedFolder.previewFile;
    if (!isMacOS() || !previewFile) return;
    void previewFile(connectedFolder.id, path).catch((caught) => onError(errorText(caught)));
  }, [onError, connectedFolder.id]);

  const openCommandPalette = useCallback(() => {
    if (commandPaletteBlockedByDialog()) return;
    commandPaletteReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCommandPaletteOpen(true);
  }, []);
  const closeCommandPalette = useCallback((options: { restoreFocus?: boolean } = {}) => {
    setCommandPaletteOpen(false);
    if (options.restoreFocus === false) return;
    const returnFocus = commandPaletteReturnFocusRef.current;
    window.requestAnimationFrame(() => { if (returnFocus?.isConnected) returnFocus.focus(); });
  }, []);

  useEffect(() => { if (!fixture) localStorage.setItem("amplefile.connected-folder.mode", activeMode); }, [activeMode, fixture]);
  // Manage Connected Folders replaces the pane's content; Done and Escape return to
  // whatever the person was doing before they opened it.
  const modeBeforeManagingRef = useRef<ConnectedFolderRailMode>(activeMode === "connected-folders" ? "files" : activeMode);
  useEffect(() => { if (activeMode !== "connected-folders") modeBeforeManagingRef.current = activeMode; }, [activeMode]);
  useEffect(() => {
    if (tree.status === "ready" && activeTab?.kind !== "checks") void checks.refresh();
  }, [activeTab?.kind, checks.refresh, tree.status, tree.tree]);
  useEffect(() => {
    if (!isMacOS() || !window.ampleFileDesktop?.connectedFolder.previewFile) return;
    function previewSelectedFile(event: KeyboardEvent) {
      if (!isQuickLookShortcut(event) || activeMode !== "files") return;
      const path = selectedPathRef.current;
      if (!path || findTreeEntry(tree.tree, path)?.kind !== "file") return;
      event.preventDefault();
      previewLocalFile(path);
    }
    window.addEventListener("keydown", previewSelectedFile);
    return () => window.removeEventListener("keydown", previewSelectedFile);
  }, [activeMode, previewLocalFile, tree.tree]);
  useEffect(() => {
    if (!activeMode.startsWith("app:restricted:") || !restrictedAppCatalogKnown || activeRestrictedApp) return;
    setActiveMode("files");
  }, [activeMode, activeRestrictedApp, restrictedAppCatalogKnown]);
  useEffect(() => {
    const desktop = window.ampleFileDesktop?.restrictedApps;
    if (!desktop) return;
    return desktop.onTabCommand((command) => {
      const installed = restrictedAppsState.appsByConnectedFolder[command.connectedFolderId]?.find((app) => (
        app.manifest.id === command.appId && app.digest === command.digest && app.featureInstallationId === command.featureInstallationId
      ));
      const targetConnectedFolder = connectedFolders.find((item) => item.id === command.connectedFolderId);
      if (!installed || !targetConnectedFolder) return;
      if (command.type === "open" && command.tab) {
        tabs.openRestrictedAppSurfaceTab(targetConnectedFolder, { appId: command.appId, digest: command.digest, featureInstallationId: command.featureInstallationId }, command.tab);
      } else if (command.type === "update" && command.tab) {
        tabs.updateRestrictedAppSurfaceTab(command.connectedFolderId, { appId: command.appId, digest: command.digest, featureInstallationId: command.featureInstallationId }, command.tab);
      } else if (command.type === "close" && command.sourceAppTabId) {
        tabs.closeRestrictedAppSurfaceTab(command.connectedFolderId, command.appId, command.digest, command.sourceAppTabId, command.featureInstallationId);
      }
    });
  }, [restrictedAppsState.appsByConnectedFolder, tabs, connectedFolders]);
  useEffect(() => {
    const desktop = window.ampleFileDesktop?.restrictedApps;
    if (!desktop) return;
    return desktop.onOpenRequest((request) => {
      const target = resolveRestrictedAppOpenRequest(request, connectedFolders);
      if (!target) return;
      if (target.connectedFolder.id !== connectedFolder.id) onSwitchConnectedFolder(target.connectedFolder);
      // A notification click opens the app's left pane, never a tab
      // (2026-10-11), at the route and state the app named for it.
      setSidebarHidden(false);
      setRestrictedAppNavigatorTarget(target.target);
      setActiveMode(target.mode);
    });
  }, [onSwitchConnectedFolder, connectedFolder.id, connectedFolders]);
  useEffect(() => {
    if (restrictedAppNavigatorTarget && restrictedAppNavigatorTarget.mode !== activeMode) setRestrictedAppNavigatorTarget(null);
  }, [activeMode, restrictedAppNavigatorTarget]);
  // A restore from Settings → Recently Deleted can bring back a Chat transcript
  // or a file; the pane cannot reach this state, so it announces the restore.
  useEffect(() => {
    if (fixture) return;
    function onRecentlyDeletedRestored(): void { void loadConversationGroups(); void tree.refresh(false); }
    window.addEventListener("amplefile:recently-deleted-restored", onRecentlyDeletedRestored);
    return () => window.removeEventListener("amplefile:recently-deleted-restored", onRecentlyDeletedRestored);
  }, [fixture, connectedFolders.map((item) => item.id).join("|")]);
  useEffect(() => { if (fixture) { setConversationGroups(fixtureConversationGroups(fixture)); return; } void loadConversationGroups(); }, [fixture, connectedFolders.map((item) => item.id).join("|")]);
  useEffect(() => {
    if (fixture) {
      setSurfaceCatalogs(fixture.surfaces);
      return;
    }
    const requestId = ++surfaceCatalogRequestRef.current;
    void api<AgentCatalog>(`/api/connected-folders/${connectedFolder.id}/agent/catalog`).then((catalog) => {
      if (surfaceCatalogRequestRef.current !== requestId) return;
      setSurfaceCatalogs((current) => ({ ...current, [connectedFolder.id]: catalog.surfaces ?? [] }));
    }).catch((caught) => {
      if (surfaceCatalogRequestRef.current === requestId) onError(errorText(caught));
    });
    return () => { surfaceCatalogRequestRef.current += 1; };
  }, [fixture, connectedFolder.id]);
  useEffect(() => {
    if (!surfaceCatalogKnown || !restrictedAppCatalogKnown || !activeSurfaceKey || activeSurface) return;
    setActiveMode("files");
  }, [activeSurface, activeSurfaceKey, restrictedAppCatalogKnown, surfaceCatalogKnown, connectedFolder.id]);
  useEffect(() => { tabs.syncSurfaceTabConversationTitles(conversationGroups); }, [conversationGroups]);
  useEffect(() => {
    function closeMenus(event: PointerEvent) { if (event.target instanceof Element && event.target.closest(".context-menu")) return; setFileContextMenu(null); }
    document.addEventListener("pointerdown", closeMenus); return () => document.removeEventListener("pointerdown", closeMenus);
  }, []);
  useEffect(() => {
    if (!desktopAction) return;
    if (desktopAction.command === "open-checks") tabs.openChecksSurfaceTab(connectedFolder);
    else if (desktopAction.command === "customize-connected-folder") { const target = connectedFolders.find((item) => item.id === desktopAction.connectedFolderId); if (target) openConnectedFolderAppearance(target); }
    else if (desktopAction.command === "new-chat") openChat(connectedFolder, null);
    // Cmd/Ctrl+R reloads the page while a browser tab is in front.
    else if (desktopAction.command === "reload-connected-folder-state") {
      const front = tabs.surfaceTabs.find((tab) => tab.id === tabs.activeSurfaceTabId);
      if (front?.kind === "browser") browser.reload(front.pageId);
      else void refreshConnectedFolderState();
    }
    else if (desktopAction.command === "open-capabilities" || desktopAction.command === "open-skills" || desktopAction.command === "open-extensions") setSkillsExtensionsView("installed");
    else if (desktopAction.command === "app-change-chat" && desktopAction.app) void startAppChangeChat(desktopAction.app).catch((caught) => onError(errorText(caught)));
    else if (desktopAction.command === "open-app-build-chat" && desktopAction.connectedFolderId && desktopAction.conversationId) void openAppBuildChat(desktopAction.connectedFolderId, desktopAction.conversationId).catch((caught) => onError(errorText(caught)));
    else if (desktopAction.command === "open-app-result-file" && desktopAction.connectedFolderId && desktopAction.path) {
      const target = connectedFolders.find((item) => item.id === desktopAction.connectedFolderId);
      if (target) tabs.openFileSurfaceTab(target, desktopAction.path);
      else onError("The result's Connected Folder is unavailable.");
    }
    else if (desktopAction.command === "open-app-studio" && desktopAction.connectedFolderId) openAppStudio(desktopAction.connectedFolderId, desktopAction.runtimeInstanceId);
    else if (desktopAction.command === "open-command-palette") openCommandPalette();
    else if (desktopAction.command === "toggle-sidebar") setSidebarHidden(!sidebarCollapsedRef.current);
    else if (desktopAction.command === "toggle-agent-panel") toggleAgentPanel();
    else if (desktopAction.command === "close-tab" && tabs.activeSurfaceTabId) tabs.closeSurfaceTab(tabs.activeSurfaceTabId, true);
  }, [desktopAction?.id, openCommandPalette]);
  // The desktop View menu owns Cmd/Ctrl+B and Cmd/Ctrl+J; a browser gets the same keys here.
  useEffect(() => {
    if (window.ampleFileDesktop) return;
    function keydown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || document.querySelector('[role="dialog"]')) return;
      const key = event.key.toLowerCase();
      if (key === "b") { event.preventDefault(); setSidebarHidden(!sidebarCollapsedRef.current); }
      else if (key === "j") { event.preventDefault(); toggleAgentPanel(); }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  // Tab-strip keyboard reach without focusing the tablist: Ctrl+Tab cycles,
  // Cmd/Ctrl+1..9 jumps (9 is the last tab), Cmd/Ctrl+T opens a new Chat tab,
  // and Ctrl+W covers close on platforms whose menu does not own it.
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.altKey || document.querySelector('[role="dialog"]')) return;
      const command = event.metaKey || event.ctrlKey;
      if (event.ctrlKey && !event.metaKey && event.key === "Tab") {
        if (!tabs.surfaceTabs.length) return;
        event.preventDefault();
        const index = tabs.surfaceTabs.findIndex((tab) => tab.id === tabs.activeSurfaceTabId);
        const step = event.shiftKey ? -1 : 1;
        const next = tabs.surfaceTabs[(index + step + tabs.surfaceTabs.length) % tabs.surfaceTabs.length];
        if (next) tabs.setActiveSurfaceTabId(next.id);
        return;
      }
      // Cmd/Ctrl+Shift+T brings back the tab closed last.
      if (command && event.shiftKey && event.key.toLocaleLowerCase() === "t") {
        if (reopenClosedTab()) event.preventDefault();
        return;
      }
      if (!command || event.shiftKey) return;
      if (event.key.toLocaleLowerCase() === "t") {
        event.preventDefault();
        openChat(connectedFolder, null);
        return;
      }
      if (!isMacOS() && event.key.toLocaleLowerCase() === "w") {
        if (!tabs.activeSurfaceTabId) return;
        event.preventDefault();
        tabs.closeSurfaceTab(tabs.activeSurfaceTabId, true);
        return;
      }
      if (event.key >= "1" && event.key <= "9") {
        if (!tabs.surfaceTabs.length) return;
        const target = event.key === "9"
          ? tabs.surfaceTabs.at(-1)
          : tabs.surfaceTabs[Number(event.key) - 1];
        if (!target) return;
        event.preventDefault();
        tabs.setActiveSurfaceTabId(target.id);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [tabs.surfaceTabs, tabs.activeSurfaceTabId, connectedFolder.id]);
  useEffect(() => {
    const flushBeforeUnload = () => flushAllPendingDeletes(true);
    window.addEventListener("beforeunload", flushBeforeUnload);
    window.addEventListener("pagehide", flushBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", flushBeforeUnload);
      window.removeEventListener("pagehide", flushBeforeUnload);
      flushBeforeUnload();
    };
  }, []);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (isCommandPaletteShortcut(event)) {
        if (commandPaletteOpen) {
          event.preventDefault();
          closeCommandPalette();
          return;
        }
        if (commandPaletteBlockedByDialog()) return;
        event.preventDefault();
        openCommandPalette();
      }
    }
    window.addEventListener("keydown", keydown, true); return () => window.removeEventListener("keydown", keydown, true);
  }, [closeCommandPalette, commandPaletteOpen, openCommandPalette]);

  async function loadConversationGroups() {
    const pairs = await Promise.all(connectedFolders.map(async (item) => {
      try { return [item.id, (await api<{ conversations: ConversationSummary[] }>(`/api/connected-folders/${item.id}/conversations`)).conversations] as const; }
      catch { return [item.id, []] as const; }
    }));
    setConversationGroups(Object.fromEntries(pairs));
  }

  async function refreshConnectedFolderState() {
    if (fixture) {
      showToast({ text: "Preview data is already up to date.", tone: "info" });
      return;
    }
    onError(null);
    await Promise.all([onRefreshBootstrap(), tree.refresh(false), loadConversationGroups()]);
    setHistoryRefreshRequest((current) => current + 1);
    showToast({ text: `${connectedFolder.name} refreshed`, tone: "success" });
  }

  function openConnectedFolderAppearance(target: ConnectedFolderSummary) {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Menu items and Settings disappear as the popup opens. Return to the
    // persistent Connected Folder header instead of a detached invoking control.
    appearanceReturnFocusRef.current = focused && focused !== document.body && !focused.closest("[role='menu'], .modal-backdrop")
      ? focused
      : document.querySelector<HTMLButtonElement>(".connected-folder-pane-switch-trigger");
    setAppearanceConnectedFolderId(target.id);
    setAppearanceInitialSection("banner");
  }

  function closeConnectedFolderAppearance() {
    setAppearanceConnectedFolderId(null);
    const returnFocus = appearanceReturnFocusRef.current;
    window.requestAnimationFrame(() => { if (returnFocus?.isConnected && !returnFocus.inert) returnFocus.focus(); });
  }

  async function renameConnectedFolder(target: ConnectedFolderSummary, name: string) {
    if (fixture) { showToast({ text: "Connected Folder rename is disabled in the preview", tone: "info" }); return; }
    await checks.suspend();
    try { await api(`/api/connected-folders/${target.id}`, { method: "PATCH", body: { name } }); await onRefreshBootstrap(); showToast({ text: `Renamed Connected Folder to ${name}`, tone: "success" }); }
    catch (caught) { onError(errorText(caught)); throw caught; }
    finally { void checks.resume(); }
  }

  async function removeConnectedFolder(target: ConnectedFolderSummary) {
    if (fixture) { showToast({ text: "Connected Folder removal is disabled in the preview", tone: "info" }); return; }
    let appStudio;
    let appRemovalImpact;
    try {
      [appStudio, appRemovalImpact] = await Promise.all([
        getLocalAppStudio(target.id),
        getLocalAppConnectedFolderRemovalImpact(target.id),
      ]);
    } catch (caught) {
      onError(`AmpleFile could not verify ${target.name}'s App Studio state. ${errorText(caught)}`);
      return;
    }
    if (appRemovalImpact.activeSourceInstanceCount || appRemovalImpact.activeTargetInstanceCount) {
      onError(`Uninstall every release-backed App sourced by or installed in ${target.name} before removing this Connected Folder.`);
      return;
    }
    if (appRemovalImpact.retainedDataCount) {
      onError(`Purge ${target.name}'s retained App data in App Studio before removing this source Connected Folder.`);
      return;
    }
    const confirmed = await requestConfirm({ title: target.location.storage === "linked" ? `Disconnect ${target.name}?` : `Delete ${target.name}?`, body: removeConnectedFolderConfirmText(target, {
      ...appStudio,
      incomingPreparedOperationCount: appRemovalImpact.incomingPreparedOperationCount,
    }), confirmLabel: target.location.storage === "linked" ? "Disconnect" : "Delete Connected Folder", tone: "danger" });
    if (!confirmed) return;
    const suspendedChecks = target.id === activeConnectedFolderIdRef.current;
    let removed = false;
    try {
      if (suspendedChecks) await checks.suspend();
      const removal = await api<{
        cleanupPending: boolean;
        deleted: boolean;
        recentlyDeleted?: { entryId: string; restoreBy: string } | null;
      }>(`/api/connected-folders/${target.id}`, { method: "DELETE" });
      removed = true;
      connectedFolderCustomizations.forget(target.id);
      tabs.removeConnectedFolderSurfaceTabs(target.id);
      await onRefreshBootstrap();
      showToast({
        text: removal.cleanupPending
          ? target.location.storage === "managed" && !removal.deleted
            ? `${target.name} was removed. AmpleFile will retry deleting its managed folder when it next starts.`
            : `${target.name} was removed. AmpleFile will finish machine-local cleanup when it next starts.`
          : target.location.storage === "linked"
            ? `${target.name} removed. The folder and its files remain on your computer.`
            : removal.recentlyDeleted
              ? `${target.name} was deleted. Its folder is in Recently Deleted until `
                + `${new Date(removal.recentlyDeleted.restoreBy).toLocaleDateString()}; Settings → Recently Deleted puts it back.`
              : `${target.name} and its managed folder were deleted.`,
        tone: removal.cleanupPending ? "info" : "success",
      });
    } catch (caught) {
      if (suspendedChecks && !removed) void checks.resume();
      onError(errorText(caught));
    }
  }

  function openChat(targetConnectedFolder: ConnectedFolderSummary, conversation: ConversationSummary | null) {
    if (conversation) chatActivity.setAttention(chatActivityKey(targetConnectedFolder.id, conversation.id), false);
    tabs.openChatSurfaceTab(targetConnectedFolder, conversation);
  }

  /** Names the Chat using a browser page (its owner is `<connected-folder id>/<conversation id>`). */
  function browserWorker(owner: string | undefined): BrowserTabWorker | null {
    if (!owner) return null;
    const slash = owner.indexOf("/");
    const connectedFolderId = slash > 0 ? owner.slice(0, slash) : owner;
    const conversationId = slash > 0 ? owner.slice(slash + 1) : "";
    if (connectedFolderId === "amplefile-agent") {
      return {
        label: "AmpleFile agent",
        title: "The AmpleFile agent is using this page",
        onOpen: () => { setAgentPanelMounted(true); updateAgentPanel((current) => ({ ...current, open: true })); },
      };
    }
    const target = connectedFolders.find((item) => item.id === connectedFolderId);
    const conversation = target ? conversationGroups[target.id]?.find((item) => item.id === conversationId) ?? null : null;
    if (!target) return { label: "Worker", title: "A Worker is using this page" };
    return {
      label: "Worker",
      title: `${conversation?.title || "A Chat"} in ${target.name} is using this page`,
      ...(conversation ? { onOpen: () => openChat(target, conversation) } : {}),
      onStop: () => {
        void api(`/api/connected-folders/${target.id}/conversations/${conversationId}/abort`, { method: "POST" })
          .catch((caught) => onError(errorText(caught)));
      },
    };
  }

  /** Opens a fresh Chat with the app-building starter text, cursor at the end. */
  async function startAppChangeChat(app: RestrictedAppInstalled) {
    const source = connectedFolders.find((item) => item.id === app.sourceConnectedFolderId);
    if (!source) throw new Error("The app's source Connected Folder is unavailable. Refresh Connected Folders before changing it.");
    const key = `${app.featureInstallationId}:${app.digest}`;
    const requestId = appChangeRequests.current.get(key) ?? crypto.randomUUID();
    appChangeRequests.current.set(key, requestId);
    const change = await prepareRestrictedAppChange(app, requestId);
    const surfaceTabId = tabs.openChatSurfaceTab(source, null);
    setDraftRequest({ id: ++draftRequestId.current, text: appChangeDraft(change), connectedFolderId: source.id, surfaceTabId });
    appChangeRequests.current.delete(key);
  }

  /** Set up for me or Just the look: a fresh Chat whose first message the included set-up Skill answers. */
  async function startSetUp(mode: ConnectedFolderSetUpMode) {
    if (fixture) { showToast({ text: "Set up for me is unavailable in the preview", tone: "info" }); return; }
    // With no AI connected the Worker cannot start; connect first, then carry on.
    if (!agent.configured) { requestConnectAi(() => void sendSetUp(mode)); return; }
    await sendSetUp(mode);
  }

  async function sendSetUp(mode: ConnectedFolderSetUpMode) {
    const target = connectedFolder;
    try {
      const base = `/api/connected-folders/${encodeURIComponent(target.id)}/conversations`;
      const { conversation } = await api<{ conversation: ConversationSummary }>(base, { method: "POST", body: {} });
      await api(`${base}/${encodeURIComponent(conversation.id)}/messages`, {
        method: "POST",
        body: { content: connectedFolderSetUpMessage(mode), contextPaths: [] },
      });
      const { conversations } = await api<{ conversations: ConversationSummary[] }>(base);
      setConversationGroups((current) => ({ ...current, [target.id]: conversations }));
      openChat(target, conversations.find((item) => item.id === conversation.id) ?? conversation);
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  async function openAppBuildChat(sourceConnectedFolderId: string, conversationId: string) {
    const source = connectedFolders.find((item) => item.id === sourceConnectedFolderId);
    if (!source) throw new Error("The app's source Connected Folder is unavailable.");
    const { conversations } = await api<{ conversations: ConversationSummary[] }>(`/api/connected-folders/${encodeURIComponent(source.id)}/conversations`);
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error("That build Chat is no longer available.");
    setConversationGroups((current) => ({ ...current, [source.id]: conversations }));
    openChat(source, conversation);
  }

  function openAppStudio(sourceConnectedFolderId: string, runtimeInstanceId?: string): void {
    const source = connectedFolders.find((item) => item.id === sourceConnectedFolderId);
    if (!source) { onError("The app's source Connected Folder is unavailable."); return; }
    setAppStudioNavigation(runtimeInstanceId ? { id: crypto.randomUUID(), sourceConnectedFolderId: source.id, runtimeInstanceId } : null);
    tabs.openAppStudioSurfaceTab(source);
  }

  function openChatActions(
    targetConnectedFolder: ConnectedFolderSummary,
    conversation: ConversationSummary,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const returnFocusTarget = event.currentTarget;
    const rect = returnFocusTarget.getBoundingClientRect();
    const invokedFromKeyboard = event.clientX === 0 && event.clientY === 0;
    setChatActions({
      connectedFolder: targetConnectedFolder,
      conversation,
      x: invokedFromKeyboard ? Math.round(rect.right - 8) : Math.round(event.clientX),
      y: invokedFromKeyboard ? Math.round(rect.bottom + 4) : Math.round(event.clientY),
      returnFocusTarget,
    });
  }
  /**
   * A Chat's or a Connected Folder tab's right-click menu. On the Mac it is a native
   * menu, like Files and browser tabs; elsewhere a Chat opens the actions popover.
   */
  async function openChatMenu(
    targetConnectedFolder: ConnectedFolderSummary,
    conversation: ConversationSummary | null,
    event: React.MouseEvent<HTMLElement>,
    tabId?: string,
  ): Promise<void> {
    const popupTabMenu = window.ampleFileDesktop?.connectedFolder.popupTabMenu;
    if (!isMacOS() || !popupTabMenu) {
      if (conversation) openChatActions(targetConnectedFolder, conversation, event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    // A button or the keyboard opens the menu under its control; a right-click opens it at the pointer.
    const underAnchor = event.type === "click" || (event.clientX === 0 && event.clientY === 0);
    const point = underAnchor
      ? { x: Math.round(rect.left), y: Math.round(rect.bottom + 4) }
      : { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    const snooze = resolveChatSnoozePresets(new Date());
    const others = tabId ? tabs.surfaceTabs.filter((tab) => tab.id !== tabId) : [];
    const toRight = tabId ? tabs.surfaceTabs.slice(tabs.surfaceTabs.findIndex((tab) => tab.id === tabId) + 1) : [];
    try {
      const command = await popupTabMenu({
        ...(conversation ? { chat: { lifecycle: conversationLifecycleView(conversation), snooze: snooze.map(({ id, label, detail }) => ({ id, label, detail })) } } : {}),
        ...(tabId ? { tab: { hasOthers: others.length > 0, hasRight: toRight.length > 0, canReopen: tabs.lastClosedSurfaceTabAt() > 0 || browser.lastClosedAt() > 0 } } : {}),
        point,
      });
      if (command === "close") { if (tabId) tabs.closeSurfaceTab(tabId, true); return; }
      if (command === "close-others") { for (const other of others) tabs.closeSurfaceTab(other.id, true); return; }
      if (command === "close-right") { for (const other of toRight) tabs.closeSurfaceTab(other.id, true); return; }
      if (command === "reopen") { reopenClosedTab(); return; }
      if (!command || !conversation) return;
      if (command === "rename") setChatActions({ connectedFolder: targetConnectedFolder, conversation, x: point.x, y: point.y, returnFocusTarget: anchor, view: "rename" });
      else if (command === "copy") await copyChat(targetConnectedFolder, conversation);
      else if (command === "delete") await deleteChat(targetConnectedFolder, conversation);
      else if (command === "resume") await updateChatLifecycle(targetConnectedFolder, conversation, { snoozedUntil: null });
      else if (command === "archive" || command === "restore") await updateChatLifecycle(targetConnectedFolder, conversation, { archived: command === "archive" });
      else {
        const preset = snooze.find((item) => command === `snooze:${item.id}`);
        if (preset) await updateChatLifecycle(targetConnectedFolder, conversation, { snoozedUntil: preset.snoozedUntil });
      }
    } catch (caught) { onError(errorText(caught)); }
  }
  function attachToChat(paths: string | readonly string[]) {
    // The Chat in front, else the one the person was last in, else a blank draft.
    const connectedFolderChats = tabs.surfaceTabs.filter((tab) => tab.kind === "chat" && tab.connectedFolderId === connectedFolder.id);
    const existing = connectedFolderChats.find((tab) => tab.id === tabs.activeSurfaceTabId)
      ?? tabs.recentChatSurfaceTab(connectedFolder.id)
      ?? connectedFolderChats.find((tab) => tab.kind === "chat" && !tab.conversationId);
    const surfaceTabId = existing?.id ?? tabs.openChatSurfaceTab(connectedFolder, null);
    if (existing) tabs.setActiveSurfaceTabId(existing.id);
    setContextRequest({ id: ++contextRequestId.current, paths: typeof paths === "string" ? [paths] : [...paths], connectedFolderId: connectedFolder.id, surfaceTabId });
  }

  /** The rows an action on this row covers: every selected row when it is one of several, else just this row. */
  function filesSelectionFor(path: string): string[] {
    if (!path || tree.selectedPaths.size < 2 || !tree.selectedPaths.has(path)) return [path];
    const shown = shownTreePaths.filter((item) => tree.selectedPaths.has(item));
    return shown.length > 1 ? shown : [path];
  }

  async function openContextMenu(entry: TreeEntry, event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const selection = filesSelectionFor(entry.path);
    if (selection.length > 1) { await openSelectionContextMenu(entry, selection, event); return; }
    // Like Finder, a right-click on a row outside the selection selects just that row.
    if (entry.path && !tree.selectedPaths.has(entry.path)) tree.setSelectedPath(entry.path);
    const returnFocusTarget = event.currentTarget as HTMLElement;
    const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    const popupFileMenu = window.ampleFileDesktop?.connectedFolder.popupFileMenu;
    if (isMacOS() && popupFileMenu) {
      setFileContextMenu(null);
      try {
        const command = await popupFileMenu({
          connectedFolderId: connectedFolder.id,
          path: entry.path,
          kind: entry.kind,
          capabilities: {
            open: entry.kind === "folder" || canOpenDirectly(entry.path),
            attach: entry.kind === "file",
            history: entry.kind === "file",
            upload: entry.kind === "folder",
            rename: Boolean(entry.path) && !holdsNestedFolder(entry),
            delete: Boolean(entry.path) && !holdsNestedFolder(entry),
            worker: canGiveOwnWorker(entry),
          },
          point,
        });
        if (command === "open") {
          if (entry.kind === "file") {
            tree.setSelectedPath(entry.path);
            tabs.openFileSurfaceTab(connectedFolder, entry.path);
            await openLocalPath(entry.path, nativeOpenLabel(entry).office ? "open-native" : "open");
          } else await openLocalPath(entry.path, "open");
        } else if (command === "open-with") await openLocalPath(entry.path, "open-with");
        else if (command === "reveal") await openLocalPath(entry.path, "reveal");
        else if (command === "copy-path") await copyPath(entry.path);
        else if (command === "attach-chat") attachToChat(entry.path);
        else if (command === "version-history") openVersionHistory(connectedFolder, entry.path);
        else if (command === "new-folder") requestNewFolder(entry.path);
        else if (command === "upload-here") chooseUpload(entry.path);
        else if (command === "refresh") await tree.refresh(false);
        else if (command === "give-worker") await giveOwnWorker(entry.path);
        else if (command === "rename") renameEntry(entry.path);
        else if (command === "delete") await deleteEntry(entry.path);
      } catch (caught) { onError(errorText(caught)); }
      return;
    }
    setFileContextMenu({ entry, x: Math.min(point.x, window.innerWidth - 250), y: Math.min(point.y, window.innerHeight - 420), returnFocusTarget });
  }

  /** Several rows selected together get only what applies to all of them: attach, copy paths, delete. */
  async function openSelectionContextMenu(entry: TreeEntry, paths: string[], event: React.MouseEvent<HTMLElement>) {
    const returnFocusTarget = event.currentTarget as HTMLElement;
    const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    const byPath = treeEntriesByPath(tree.tree);
    const entries = paths.map((path) => byPath.get(path)).filter((item): item is TreeEntry => Boolean(item));
    const files = entries.filter((item) => item.kind === "file").length;
    const canDelete = !entries.some(holdsNestedFolder);
    const popupFileMenu = window.ampleFileDesktop?.connectedFolder.popupFileMenu;
    if (isMacOS() && popupFileMenu) {
      setFileContextMenu(null);
      try {
        const command = await popupFileMenu({
          connectedFolderId: connectedFolder.id,
          path: entry.path,
          kind: entry.kind,
          capabilities: { open: false, attach: files === entries.length, history: false, upload: false, rename: false, delete: canDelete },
          selection: { files, folders: entries.length - files },
          point,
        });
        if (command === "attach-chat") attachToChat(paths);
        else if (command === "copy-path") await copyPaths(paths);
        else if (command === "delete") await deleteEntries(paths);
      } catch (caught) { onError(errorText(caught)); }
      return;
    }
    setFileContextMenu({ entry, selection: entries, x: Math.min(point.x, window.innerWidth - 250), y: Math.min(point.y, window.innerHeight - 200), returnFocusTarget });
  }
  // "Connect This Folder" (2026-10-01): any plain folder below this
  // Connected Folder's root can become a nested Connected Folder; its row turns into the door row.
  function canGiveOwnWorker(entry: TreeEntry): boolean {
    return !fixture && entry.kind === "folder" && Boolean(entry.path) && !entry.nestedFolder;
  }

  // A folder that holds a nested Connected Folder cannot be renamed or deleted from
  // here (the host refuses), so the menus never offer it.
  function holdsNestedFolder(entry: TreeEntry): boolean {
    if (entry.kind !== "folder" || !entry.path) return false;
    const prefix = `${entry.path.toLocaleLowerCase()}/`;
    return [...nestedFolderViews.keys()].some((path) => path.toLocaleLowerCase().startsWith(prefix));
  }

  async function giveOwnWorker(path: string): Promise<void> {
    try {
      const { connectedFolder: created } = await api<{ connectedFolder: ConnectedFolderSummary }>(`/api/connected-folders/${connectedFolder.id}/nested-folders`, { method: "POST", body: { path } });
      await Promise.all([onRefreshBootstrap(), tree.refresh(false)]);
      showToast({ text: `${created.name} is now a Connected Folder.`, actionLabel: "Open", onAction: () => onSwitchConnectedFolder(created) });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  function openRootContextMenu(event: React.MouseEvent<HTMLElement>) { if ((event.target as HTMLElement).closest("[data-tree-row]")) return; openContextMenu({ name: connectedFolder.name, path: "", kind: "folder" }, event); }

  async function uploadFiles(files: DroppedUploadFile[], targetFolderPath: string) {
    if (!files.length || fixture) return;
    const form = new FormData();
    form.set("targetFolderPath", targetFolderPath);
    form.set("relativePaths", JSON.stringify(files.map((item) => item.relativePath)));
    files.forEach((item) => form.append("files", item.file, item.file.name));
    setUploadingFiles(true);
    onError(null);
    try {
      await apiForm(`/api/connected-folders/${connectedFolder.id}/upload-local-files`, form);
      await tree.refresh();
      showToast({ text: formatItemCount(files.length, "file") + " added", tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setUploadingFiles(false); }
  }
  async function uploadDroppedFilesForChat(dataTransfer: DataTransfer): Promise<string[]> {
    // Collect before the first await: dropped directory entries are only
    // readable while the drop event's DataTransfer is alive.
    const collected = collectDroppedUploadFiles(dataTransfer);
    if (fixture) return [];
    const files = await collected;
    if (!files.length) return [];
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const targetFolderPath = `Dropped/${localDate}`;
    const form = new FormData();
    form.set("targetFolderPath", targetFolderPath);
    form.set("relativePaths", JSON.stringify(files.map((item) => item.relativePath)));
    files.forEach((item) => form.append("files", item.file, item.file.name));
    setUploadingFiles(true);
    try {
      const result = await apiForm<{ uploaded: Array<{ path: string }> }>(`/api/connected-folders/${connectedFolder.id}/upload-local-files`, form);
      void tree.refresh();
      showToast({ text: `${formatItemCount(files.length, "file")} added to ${targetFolderPath}`, tone: "success" });
      return result.uploaded.map((item) => item.path);
    } finally {
      setUploadingFiles(false);
    }
  }
  function chooseUpload(targetPath = "") { setUploadTargetPath(targetPath); uploadRef.current?.click(); }

  function requestNewFolder(parentPath = "") {
    setNewFolderTarget({ connectedFolderId: connectedFolder.id, connectedFolderName: connectedFolder.name, parentPath });
  }
  async function folderCreated(folder: { path: string; name: string }, target: NewFolderTarget) {
    showHistorySaved(`Created ${folder.name}`);
    if (activeConnectedFolderIdRef.current !== target.connectedFolderId) return;
    tree.setQuery("");
    await tree.refresh();
    if (activeConnectedFolderIdRef.current !== target.connectedFolderId) return;
    if (target.parentPath) tree.toggleFolder(target.parentPath, true);
  }

  async function moveEntry(sourcePath: string, targetFolderPath: string) {
    if (fixture || !sourcePath || sourcePath === targetFolderPath || isInsideFolder(targetFolderPath, sourcePath)) return;
    tree.setMovingTreePaths(new Set([sourcePath]));
    try {
      const result = await api<{ moved: { path: string; name: string }; safetyCheckpointId: string }>(`/api/connected-folders/${connectedFolder.id}/move-local-entry`, { method: "POST", body: { sourcePath, targetFolderPath } });
      const preview = moveTreeEntry(tree.tree, sourcePath, targetFolderPath);
      tree.setTree(preview.entries);
      tabs.retargetFileSurfaceTabsForMove(connectedFolder.id, sourcePath, result.moved.path);
      showHistorySaved(`Moved ${result.moved.name}`);
    }
    catch (caught) { onError(errorText(caught)); }
    finally { tree.setMovingTreePaths(new Set()); }
  }

  /** Several rows dragged together: one request and one History restore point, and they stay selected where they land. */
  async function moveEntries(sourcePaths: readonly string[], targetFolderPath: string) {
    const outermost = outermostTreePaths(sourcePaths);
    if (outermost.length <= 1) { if (outermost[0]) await moveEntry(outermost[0], targetFolderPath); return; }
    // A folder cannot go inside itself; rows already in the target stay put.
    if (fixture || outermost.some((path) => path === targetFolderPath || isInsideFolder(targetFolderPath, path))) return;
    const sources = outermost.filter((path) => parentFolderPath(path) !== targetFolderPath);
    if (!sources.length) return;
    tree.setMovingTreePaths(new Set(sources));
    let result: MoveLocalEntriesResult | null = null;
    try {
      result = await api<MoveLocalEntriesResult>(`/api/connected-folders/${connectedFolder.id}/move-local-entries`, { method: "POST", body: { sourcePaths: sources, targetFolderPath } });
    }
    catch (caught) { onError(errorText(caught)); }
    finally { tree.setMovingTreePaths(new Set()); }
    if (!result) return;
    for (const item of result.moved) {
      tree.setTree((current) => moveTreeEntry(current, item.fromPath, targetFolderPath).entries);
      tabs.retargetFileSurfaceTabsForMove(connectedFolder.id, item.fromPath, item.path);
    }
    // Rows after a failure stayed put; the restore point covers exactly the ones that moved.
    if (result.failed) onError(result.failed.error);
    const moved = result.moved.map((item) => item.path);
    if (!moved.length) return;
    tree.selectPaths(moved, moved.at(-1));
    showHistorySaved(`Moved ${formatItemCount(moved.length, "item")}`);
  }

  async function deleteEntry(path: string) {
    if (!path || fixture) return;
    const entry = findTreeEntry(tree.tree, path);
    if (entry?.kind === "folder") {
      const confirmed = await requestConfirm({ title: deleteFolderConfirm.title(entry.name), body: deleteFolderConfirm.body, confirmLabel: deleteFolderConfirm.confirmLabel, tone: "danger" });
      if (!confirmed) return;
    }
    const selectedPath = tree.selectedPath && (tree.selectedPath === path || tree.selectedPath.startsWith(`${path}/`)) ? tree.selectedPath : null;
    const deletedTabPaths = new Set(tabs.surfaceTabs.flatMap((tab) => (tab.kind === "file" || tab.kind === "page") && tab.connectedFolderId === connectedFolder.id && (tab.path === path || tab.path.startsWith(`${path}/`)) ? [tab.path] : []));
    const pending: PendingDelete = { connectedFolderId: connectedFolder.id, path, name: entry?.name ?? path, selectedPath, deletedTabPaths };
    pendingDeletesRef.current.set(pendingDeleteKey(pending), pending);
    tree.setTree((current) => removeTreeEntries(current, new Set([path])));
    showToast({ text: `Removed ${pending.name}`, tone: "success", actionLabel: "Undo", durationMs: 6500,
      onAction: () => {
        if (pendingDeletesRef.current.get(pendingDeleteKey(pending)) !== pending) return;
        pendingDeletesRef.current.delete(pendingDeleteKey(pending));
        if (pending.connectedFolderId !== activeConnectedFolderIdRef.current) return;
        const restoreSelection = Boolean(pending.selectedPath && (!selectedPathRef.current || selectedPathRef.current === pending.selectedPath));
        void refreshTreeWithPendingDeletes().then(() => {
          if (pending.connectedFolderId === activeConnectedFolderIdRef.current && pending.selectedPath && restoreSelection) tree.setSelectedPath(pending.selectedPath);
        });
      },
      onClose: (reason) => { if (reason !== "action") void commitPendingDelete(pending); },
    });
  }

  /**
   * Several rows from Files' selection, under one Undo and, once that window
   * closes, one request: one History restore point for all of them, while the
   * host still gives each row its own receipt, busy refusal, and Recently
   * Deleted recovery (docs/receipts-not-gates.md).
   */
  async function deleteEntries(paths: readonly string[]) {
    const targets = outermostTreePaths(paths);
    if (targets.length <= 1) { if (targets[0]) await deleteEntry(targets[0]); return; }
    if (fixture) return;
    const byPath = treeEntriesByPath(tree.tree);
    const entries = targets.map((path) => byPath.get(path));
    // Counted the way the menu counts them: every highlighted row goes, a selected folder's rows with it.
    const files = paths.filter((path) => byPath.get(path)?.kind === "file").length;
    const label = fileSelectionLabel(files, paths.length - files);
    if (entries.some((entry) => entry?.kind === "folder")) {
      const confirmed = await requestConfirm({ title: deleteSelectionConfirm.title(label), body: deleteSelectionConfirm.body, confirmLabel: deleteSelectionConfirm.confirmLabel(label), tone: "danger" });
      if (!confirmed) return;
    }
    const selection = [...tree.selectedPaths];
    const focus = tree.selectedPath;
    const batchId = ++pendingDeleteBatchRef.current;
    const pendings = targets.map((path, index): PendingDelete => ({
      connectedFolderId: connectedFolder.id,
      path,
      name: entries[index]?.name ?? path,
      selectedPath: null,
      batchId,
      deletedTabPaths: new Set(tabs.surfaceTabs.flatMap((tab) => (tab.kind === "file" || tab.kind === "page") && tab.connectedFolderId === connectedFolder.id && (tab.path === path || tab.path.startsWith(`${path}/`)) ? [tab.path] : [])),
    }));
    for (const pending of pendings) pendingDeletesRef.current.set(pendingDeleteKey(pending), pending);
    tree.setTree((current) => removeTreeEntries(current, new Set(targets)));
    showToast({ text: `Removed ${formatItemCount(paths.length, "item")}`, tone: "success", actionLabel: "Undo", durationMs: 6500,
      onAction: () => {
        const waiting = pendings.filter((pending) => pendingDeletesRef.current.get(pendingDeleteKey(pending)) === pending);
        if (!waiting.length) return;
        for (const pending of waiting) pendingDeletesRef.current.delete(pendingDeleteKey(pending));
        if (pendings[0]!.connectedFolderId !== activeConnectedFolderIdRef.current) return;
        void refreshTreeWithPendingDeletes().then(() => {
          const current = selectedPathRef.current;
          if (pendings[0]!.connectedFolderId === activeConnectedFolderIdRef.current && (!current || selection.includes(current))) tree.selectPaths(selection, focus);
        });
      },
      onClose: (reason) => { if (reason !== "action") void commitPendingDeletes(pendings); },
    });
  }

  function renameEntry(path: string) {
    if (!path) return;
    if (fixture) {
      showToast({ text: "File rename is disabled in the preview", tone: "info" });
      return;
    }
    const entry = findTreeEntry(tree.tree, path);
    setRenameEntryRequest({ path, name: entry?.name ?? path.split("/").pop() ?? path });
  }
  async function submitEntryRename(name: string) {
    if (!renameEntryRequest || name === renameEntryRequest.name) return;
    const result = await api<{ renamed: { path: string }; safetyCheckpointId: string }>(`/api/connected-folders/${connectedFolder.id}/rename-local-entry`, {
      method: "POST",
      body: { path: renameEntryRequest.path, newName: name },
    });
    tabs.retargetFileSurfaceTabsForMove(connectedFolder.id, renameEntryRequest.path, result.renamed.path);
    await tree.refresh();
    showHistorySaved(`Renamed ${renameEntryRequest.name}`);
  }

  async function openLocalPath(path: string, action: "reveal" | "open" | "open-native" | "open-with", targetConnectedFolder = connectedFolder) {
    if (fixture) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    const desktop = window.ampleFileDesktop;
    try {
      if (action === "open-with") {
        const openPathWith = desktop?.connectedFolder.openPathWith;
        if (!path || !openPathWith) return;
        const result = await openPathWith(targetConnectedFolder.id, path);
        if (result.opened && result.appName) showToast({ text: `Opened in ${result.appName}`, tone: "success" });
        return;
      }
      if (!path) await desktop?.connectedFolder.revealFolder?.(targetConnectedFolder.id); else if (desktop?.connectedFolder.openPath) await desktop.connectedFolder.openPath(targetConnectedFolder.id, path, action); else await desktop?.connectedFolder.revealFolder?.(targetConnectedFolder.id);
    }
    catch (caught) { onError(errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "")); }
  }
  const canOpenWith = !fixture && typeof window.ampleFileDesktop?.connectedFolder.openPathWith === "function";
  function openVersionHistory(targetConnectedFolder: ConnectedFolderSummary, path: string) {
    if (fixture) { showToast({ text: "Version history is disabled in the preview", tone: "info" }); return; }
    setVersionHistory({ connectedFolder: targetConnectedFolder, path, name: path.split("/").pop() ?? path });
  }
  async function copyPath(path: string) { const full = connectedFolderEntryNativePath(connectedFolder.connectedFolderRoot, path); await copyToClipboard({ text: full }); showToast({ text: "Path copied", tone: "success" }); }
  async function copyPaths(paths: readonly string[]) { await copyToClipboard({ text: paths.map((path) => connectedFolderEntryNativePath(connectedFolder.connectedFolderRoot, path)).join("\n") }); showToast({ text: "Paths copied", tone: "success" }); }

  function updateDropTarget(event: React.DragEvent<HTMLElement>, target: string) { event.preventDefault(); if (hasNativeFiles(event) || hasConnectedFolderPathDrag(event)) { event.dataTransfer.dropEffect = hasNativeFiles(event) ? "copy" : "move"; tree.setDropTargetFolderPath(target); } }
  function clearDropTarget(event?: React.DragEvent<HTMLElement>) { if (event && event.currentTarget.contains(event.relatedTarget as Node | null)) return; tree.setDropTargetFolderPath(null); }
  async function dropOnTarget(event: React.DragEvent<HTMLElement>, target: string) {
    event.preventDefault();
    tree.setDropTargetFolderPath(null);
    if (hasNativeFiles(event)) {
      try {
        const files = await collectDroppedUploadFiles(event.dataTransfer);
        if (!files.length) {
            onError("Drop one or more files. Empty folders cannot be added.");
          return;
        }
        await uploadFiles(files, target);
      }
      catch (caught) { onError(errorText(caught)); }
      return;
    }
    const sources = hasConnectedFolderPathDrag(event) ? draggedConnectedFolderPaths(event.dataTransfer) : [];
    if (sources.length) await moveEntries(sources, target);
  }
  function startTreeDrag(path: string, event: React.DragEvent<HTMLElement>) {
    // Like Finder: dragging a selected row carries every selected row; dragging another row selects it first.
    const paths = filesSelectionFor(path);
    if (!tree.selectedPaths.has(path)) tree.setSelectedPath(path);
    tree.setMovingTreePaths(new Set(paths));
    event.dataTransfer.setData(connectedFolderPathDragType, path);
    if (paths.length > 1) {
      event.dataTransfer.setData(connectedFolderPathsDragType, JSON.stringify(paths));
      const byPath = treeEntriesByPath(tree.tree);
      const files = paths.filter((item) => byPath.get(item)?.kind === "file").length;
      setSelectionDragImage(event, fileSelectionLabel(files, paths.length - files));
    }
    // A text field takes just the dragged row's path; the full set travels in its own type.
    event.dataTransfer.setData("text/plain", path);
    event.dataTransfer.effectAllowed = "move";
  }
  function endTreeDrag() { tree.setMovingTreePaths(new Set()); tree.setDropTargetFolderPath(null); }

  function startNativeFileDrag(path: string, event: React.DragEvent<HTMLElement>) {
    if (!event.altKey || !window.ampleFileDesktop?.connectedFolder.startDrag) return false;
    event.preventDefault();
    void window.ampleFileDesktop.connectedFolder.startDrag(connectedFolder.id, path).catch((caught) => onError(errorText(caught)));
    return true;
  }

  async function commitPendingDelete(pending: PendingDelete) {
    const key = pendingDeleteKey(pending);
    if (pendingDeletesRef.current.get(key) !== pending) return;
    pendingDeletesRef.current.delete(key);
    try {
      const result = await deleteLocalFileRequest(pending);
      tabs.closeFileSurfaceTabsForDeletedPaths(pending.connectedFolderId, pending.deletedTabPaths);
      if (result.recentlyDeleted) showRecentlyDeletedNotice([pending.name]);
    } catch (caught) {
      onError(errorText(caught));
      if (pending.connectedFolderId === activeConnectedFolderIdRef.current) {
        const restoreSelection = Boolean(pending.selectedPath && (!selectedPathRef.current || selectedPathRef.current === pending.selectedPath));
        await refreshTreeWithPendingDeletes();
        if (pending.selectedPath && restoreSelection) tree.setSelectedPath(pending.selectedPath);
      }
    }
  }

  /** The rows of one Undo still waiting, sent as one request: one History restore point for all of them. */
  async function commitPendingDeletes(pendings: readonly PendingDelete[]) {
    const waiting = pendings.filter((pending) => pendingDeletesRef.current.get(pendingDeleteKey(pending)) === pending);
    if (waiting.length <= 1) { if (waiting[0]) await commitPendingDelete(waiting[0]); return; }
    for (const pending of waiting) pendingDeletesRef.current.delete(pendingDeleteKey(pending));
    const connectedFolderId = waiting[0]!.connectedFolderId;
    try {
      const result = await deleteLocalFilesRequest(connectedFolderId, waiting.map((pending) => pending.path));
      const settled = settledPendingDeletes(waiting, result);
      tabs.closeFileSurfaceTabsForDeletedPaths(connectedFolderId, settled.closedTabPaths);
      if (settled.inRecentlyDeleted.length) showRecentlyDeletedNotice(settled.inRecentlyDeleted);
      if (result.failed) {
        // The rows after the one that failed were left alone, so they come back.
        onError(result.failed.error);
        if (connectedFolderId === activeConnectedFolderIdRef.current) await refreshTreeWithPendingDeletes();
      }
    } catch (caught) {
      onError(errorText(caught));
      if (connectedFolderId === activeConnectedFolderIdRef.current) await refreshTreeWithPendingDeletes();
    }
  }

  function showRecentlyDeletedNotice(names: readonly string[]) {
    showToast({
      text: names.length === 1
        ? `${names[0]} is in Recently Deleted — History could not keep a copy of everything in it.`
        : `${formatItemCount(names.length, "item")} are in Recently Deleted — History could not keep a copy of everything in them.`,
      tone: "info",
      durationMs: 8000,
    });
  }

  function flushAllPendingDeletes(keepalive = false) {
    // Rows deleted together still go together.
    for (const group of pendingDeleteGroups(pendingDeletesRef.current.values())) {
      if (!keepalive) {
        void commitPendingDeletes(group);
        continue;
      }
      for (const pending of group) pendingDeletesRef.current.delete(pendingDeleteKey(pending));
      const sent = group.length === 1
        ? deleteLocalFileRequest(group[0]!, true)
        : deleteLocalFilesRequest(group[0]!.connectedFolderId, group.map((pending) => pending.path), true);
      void sent.catch(() => {});
    }
  }

  async function refreshTreeWithPendingDeletes() {
    await tree.refresh();
    const pendingPaths = new Set([...pendingDeletesRef.current.values()].filter((item) => item.connectedFolderId === connectedFolder.id).map((item) => item.path));
    if (pendingPaths.size) tree.setTree((current) => removeTreeEntries(current, pendingPaths));
  }

  function showHistorySaved(text: string) {
    showToast({ text: `${text}. Restore point saved in History.`, tone: "success" });
  }

  async function saveRestorePoint() {
    if (fixture) return;
    try {
      const result = await queueHistoryRequest(connectedFolder.id, () => api<{ created: boolean }>(`/api/connected-folders/${connectedFolder.id}/history/checkpoints`, { method: "POST", body: { label: "Manual Restore Point" } }));
      setHistoryRefreshRequest((current) => current + 1);
      setActiveMode("history");
      showToast(result.created
        ? { text: "Restore point saved", tone: "success" }
        : { text: "Current files already match the latest restore point", tone: "info" });
    } catch (caught) { onError(errorText(caught)); }
  }

  async function renameChat(targetConnectedFolder: ConnectedFolderSummary, conversation: ConversationSummary, title: string) {
    if (fixture) { const updated = { ...conversation, title }; replaceConversationSummary(targetConnectedFolder.id, updated); tabs.updateSurfaceTabConversationTitle(targetConnectedFolder.id, updated); return; }
    const result = await api<{ conversation: ConversationSummary }>(`/api/connected-folders/${targetConnectedFolder.id}/conversations/${conversation.id}`, { method: "PATCH", body: { title } });
    replaceConversationSummary(targetConnectedFolder.id, result.conversation);
    tabs.updateSurfaceTabConversationTitle(targetConnectedFolder.id, result.conversation);
  }

  async function copyChat(targetConnectedFolder: ConnectedFolderSummary, conversation: ConversationSummary) {
    if (fixture) return;
    const result = await api<{ conversation: ConversationSummary }>(`/api/connected-folders/${targetConnectedFolder.id}/conversations/${conversation.id}/copy`, { method: "POST", body: {} });
    setConversationGroups((current) => ({
      ...current,
      [targetConnectedFolder.id]: [result.conversation, ...(current[targetConnectedFolder.id] ?? []).filter((item) => item.id !== result.conversation.id)],
    }));
    openChat(targetConnectedFolder, result.conversation);
  }

  function replaceConversationSummary(connectedFolderId: string, conversation: ConversationSummary): void {
    setConversationGroups((current) => ({
      ...current,
      [connectedFolderId]: (current[connectedFolderId] ?? []).map((item) => item.id === conversation.id ? conversation : item),
    }));
  }

  async function updateChatLifecycle(
    targetConnectedFolder: ConnectedFolderSummary,
    conversation: ConversationSummary,
    patch: { archived?: boolean; snoozedUntil?: string | null },
    options: { announce?: boolean } = {},
  ): Promise<ConversationSummary> {
    const previous = conversation;
    const updated = fixture
      ? applyFixtureChatLifecycle(conversation, patch)
      : (await api<{ conversation: ConversationSummary }>(
          `/api/connected-folders/${targetConnectedFolder.id}/conversations/${conversation.id}`,
          { method: "PATCH", body: patch },
        )).conversation;
    replaceConversationSummary(targetConnectedFolder.id, updated);

    const lifecycle = conversationLifecycleView(updated);
    const openTab = tabs.surfaceTabs.find((tab) =>
      tab.kind === "chat"
      && tab.connectedFolderId === targetConnectedFolder.id
      && tab.conversationId === conversation.id);
    if (lifecycle !== "active") {
      if (openTab) tabs.closeSurfaceTab(openTab.id);
      chatActivity.setRunning(chatActivityKey(targetConnectedFolder.id, conversation.id), false);
      chatActivity.setAttention(chatActivityKey(targetConnectedFolder.id, conversation.id), false);
    }
    if (options.announce === false) return updated;

    const feedback = chatLifecycleFeedback(previous, updated);
    showToast({
      text: feedback.text,
      tone: "success",
      actionLabel: "Undo",
      durationMs: 6500,
      onAction: () => {
        const latest = (conversationGroups[targetConnectedFolder.id] ?? []).find((item) => item.id === conversation.id) ?? updated;
        void updateChatLifecycle(targetConnectedFolder, latest, feedback.undo, { announce: false })
          .then((restored) => { if (openTab) openChat(targetConnectedFolder, restored); })
          .catch((caught) => onError(errorText(caught)));
      },
    });
    return updated;
  }

  async function deleteChat(targetConnectedFolder: ConnectedFolderSummary, conversation: ConversationSummary): Promise<void> {
    const recentlyDeleted = fixture
      ? null
      : (await api<{ deleted: { conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } } }>(
          `/api/connected-folders/${targetConnectedFolder.id}/conversations/${conversation.id}`,
          { method: "DELETE" },
        )).deleted.recentlyDeleted;
    setConversationGroups((current) => ({
      ...current,
      [targetConnectedFolder.id]: (current[targetConnectedFolder.id] ?? []).filter((item) => item.id !== conversation.id),
    }));
    for (const tab of tabs.surfaceTabs) {
      if (tab.kind === "chat" && tab.connectedFolderId === targetConnectedFolder.id && tab.conversationId === conversation.id) tabs.closeSurfaceTab(tab.id);
    }
    chatActivity.setRunning(chatActivityKey(targetConnectedFolder.id, conversation.id), false);
    chatActivity.setAttention(chatActivityKey(targetConnectedFolder.id, conversation.id), false);
    showToast({
      text: `Moved "${chatDisplayTitle({ serverTitle: conversation.title })}" to Recently Deleted`,
      tone: "success",
      durationMs: 6500,
      ...(recentlyDeleted ? {
        actionLabel: "Undo",
        onAction: () => {
          void api(`/api/settings/recently-deleted/${recentlyDeleted.entryId}/restore`, { method: "POST", body: {} })
            .then(() => api<{ conversations: ConversationSummary[] }>(`/api/connected-folders/${targetConnectedFolder.id}/conversations`))
            .then(({ conversations }) => setConversationGroups((current) => ({ ...current, [targetConnectedFolder.id]: conversations })))
            .catch((caught) => onError(errorText(caught)));
        },
      } : {}),
    });
  }

  function selectRailMode(mode: ConnectedFolderRailMode): void {
    // Every rail destination brings a hidden navigation pane back.
    setSidebarHidden(false);
    // The rail button opens an app at its home, even when a notification
    // had opened it somewhere else.
    setRestrictedAppNavigatorTarget(null);
    setActiveMode(mode);
    // Apps and Extension surfaces show their left pane and never open a tab by
    // themselves; a tab comes from a click inside that pane, like a file.
  }

  function openInstalledRestrictedApp(targetConnectedFolder: ConnectedFolderSummary, app: RestrictedAppInstalled): void {
    restrictedAppsState.upsertApp(app);
    if (targetConnectedFolder.id !== connectedFolder.id) onSwitchConnectedFolder(targetConnectedFolder);
    setRestrictedAppNavigatorTarget(null);
    setActiveMode(restrictedAppRailMode(targetConnectedFolder.id, app.manifest.id, app.featureInstallationId));
  }

  function updateSurfaceCatalog(targetConnectedFolderId: string, catalog: AgentCatalog): void {
    setSurfaceCatalogs((current) => ({ ...current, [targetConnectedFolderId]: catalog.surfaces ?? [] }));
  }

  const commands = useMemo<CommandPaletteCommand[]>(() => [
    ...(["files", "chats", "history"] as ConnectedFolderPane[]).map((mode) => ({ id: `go:${mode}`, groupId: "go-to" as const, groupLabel: "Go", label: mode[0]!.toUpperCase() + mode.slice(1), defaultVisible: true, run: () => selectRailMode(mode) })),
    { id: "go:connected-folder-apps", groupId: "go-to" as const, groupLabel: "Go", label: "Apps", defaultVisible: true, run: () => onOpenSettings("apps") },
    { id: "go:assistant-tools", groupId: "go-to" as const, groupLabel: "Go", label: "Skills & Extensions", defaultVisible: true, run: () => setSkillsExtensionsView("installed") },
    ...([{ id: "go:checks", groupId: "go-to" as const, groupLabel: "Go", label: "Checks", detail: checks.status?.needsAttention ? `${checks.status.needsAttention} need attention` : undefined, defaultVisible: true, run: () => tabs.openChecksSurfaceTab(connectedFolder) }]),
    { id: "action:discover-skills-extensions", groupId: "actions" as const, groupLabel: "Actions", label: "Discover Skills & Extensions", keywords: ["capabilities", "discover", "install", "tools", "browse"], run: () => setSkillsExtensionsView("discover") },
    ...surfaces.map((surface) => ({ id: `app:${surface.key}`, groupId: "go-to" as const, groupLabel: "Go", label: surface.title, detail: surface.scope === "project" ? "Pi Extension · This Connected Folder only" : "Pi Extension · Everywhere", run: () => selectRailMode(`app:${surface.key}`) })),
    ...restrictedApps.map((app) => ({ id: `restricted-app:${app.featureInstallationId}`, groupId: "go-to" as const, groupLabel: "Go", label: restrictedAppRailLabel(app, restrictedApps), detail: "App · This Connected Folder", run: () => selectRailMode(restrictedAppRailMode(connectedFolder.id, app.manifest.id, app.featureInstallationId)) })),
    ...connectedFolders.map((item) => ({ id: `connected-folder:${item.id}`, groupId: "switch-connected-folder" as const, groupLabel: "Switch Connected Folder", label: item.name, detail: connectedFolderHeaderSourceBadgeLabel(item), matchTargets: [item.name, item.connectedFolderRoot], run: () => onSwitchConnectedFolder(item) })),
    ...Object.entries(conversationGroups).flatMap(([connectedFolderId, conversations]) => conversations.map((conversation) => {
      const lifecycle = conversationLifecycleView(conversation);
      return {
        id: `chat:${connectedFolderId}:${conversation.id}`,
        groupId: "chats" as const,
        groupLabel: "Chats",
        label: conversation.title,
        detail: lifecycle === "archived" ? "Archived" : lifecycle === "snoozed" ? "Snoozed" : undefined,
        run: () => { const target = connectedFolders.find((item) => item.id === connectedFolderId); if (target) openChat(target, conversation); },
      };
    })),
    ...collectLoadedFileEntries(tree.tree).flatMap((entry) => {
      const matchTargets = [entry.name, entry.path];
      return [
        { id: `reveal-file:${connectedFolder.id}:${entry.path}`, groupId: "files" as const, groupLabel: "Files", label: `Reveal in Files: ${entry.name}`, detail: entry.path, matchTargets, minQueryLength: 2, run: () => { selectRailMode("files"); tree.setSelectedPath(entry.path); tabs.openFileSurfaceTab(connectedFolder, entry.path); } },
        { id: `attach-file:${connectedFolder.id}:${entry.path}`, groupId: "files" as const, groupLabel: "Files", label: `Attach to Chat: ${entry.name}`, detail: entry.path, matchTargets, minQueryLength: 2, run: () => attachToChat(entry.path) },
      ];
    }),
    { id: "action:new-chat", groupId: "actions", groupLabel: "Actions", label: "New Chat", keywords: ["chat", "conversation", "assistant"], defaultVisible: true, run: () => openChat(connectedFolder, null) },
    ...(browser.available ? [
      { id: "action:new-browser-tab", groupId: "actions" as const, groupLabel: "Actions", label: "New Browser Tab", keywords: ["browser", "web", "website", "internet", "page"], defaultVisible: true, run: browser.newTab },
    ] : []),
    { id: "action:reopen-closed-tab", groupId: "actions", groupLabel: "Actions", label: "Reopen Closed Tab", keywords: ["browser", "undo", "restore", "closed", "tab"], run: () => { if (!reopenClosedTab()) showToast({ text: "No closed tab to reopen", tone: "info" }); } },
    ...(!fixture ? [
      { id: "action:set-up", groupId: "actions" as const, groupLabel: "Actions", label: "Set Up for Me", keywords: ["organize", "tidy", "setup", "banner", "instructions"], run: () => { void startSetUp("full"); } },
      { id: "action:just-the-look", groupId: "actions" as const, groupLabel: "Actions", label: "Just the Look", keywords: ["banner", "icon", "color", "appearance", "customize"], run: () => { void startSetUp("look"); } },
    ] : []),
    ...(!fixture ? [{ id: "action:save-restore-point", groupId: "actions" as const, groupLabel: "Actions", label: "Save Restore Point", keywords: ["history", "checkpoint", "backup"], defaultVisible: true, run: () => { void saveRestorePoint(); } }] : []),
    // Files has no toolbar buttons (2026-10-01): its actions live in the
    // right-click menu and here, so the keyboard reaches them too.
    { id: "action:files-new-subfolder", groupId: "files", groupLabel: "Files", label: "New Folder in Files", keywords: ["mkdir", "directory", "subfolder"], run: () => { selectRailMode("files"); requestNewFolder(); } },
    { id: "action:files-add", groupId: "files", groupLabel: "Files", label: "Add Files", keywords: ["upload", "import", "drop"], run: () => { selectRailMode("files"); chooseUpload(""); } },
    { id: "action:files-refresh", groupId: "files", groupLabel: "Files", label: "Refresh Files", keywords: ["reload", "rescan"], run: () => { void tree.refresh(false); } },
    { id: "action:new-connected-folder", groupId: "actions", groupLabel: "Actions", label: "New Connected Folder", defaultVisible: true, run: onCreateConnectedFolder },
    { id: "action:open-folder", groupId: "actions", groupLabel: "Actions", label: "Connect Folder", defaultVisible: true, run: onOpenFolder },
    { id: "action:settings", groupId: "actions", groupLabel: "Actions", label: "Settings", defaultVisible: true, run: onOpenSettings },
    { id: "action:toggle-sidebar", groupId: "actions", groupLabel: "Actions", label: sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar", keywords: ["navigation", "pane", "files", "collapse"], run: () => setSidebarHidden(!sidebarCollapsed) },
    { id: "action:toggle-agent-panel", groupId: "actions", groupLabel: "Actions", label: agentPanelOpen ? "Close AmpleFile agent" : "Open AmpleFile agent", keywords: ["agent", "chat", "panel"], run: toggleAgentPanel },
    { id: "action:shortcuts", groupId: "actions", groupLabel: "Actions", label: "Shortcut Keys", run: onOpenShortcuts },
    ...(["light", "dark", "system"] as AppThemePreference[]).map((preference) => ({ id: `theme:${preference}`, groupId: "actions" as const, groupLabel: "Actions", label: preference === "system" ? "Use Device Theme" : `Use ${preference === "light" ? "Light" : "Dark"} Theme`, detail: themePreference === preference ? "Current" : undefined, keywords: ["appearance", "color", "mode"], run: () => onThemePreferenceChange(preference) })),
  ], [agentPanelOpen, browser.available, checks.status, conversationGroups, fixture, restrictedApps, sidebarCollapsed, surfaces, themePreference, tree.selectedPath, tree.tree, connectedFolders, connectedFolder.id]);

  const layoutStyle = { ...(connectedFolderIdentityStyle(identity)), ...(paneResize.sidebarWidth ? { "--connected-folder-sidebar-width": `${paneResize.sidebarWidth}px` } : {}), "--agent-panel-width": `${agentPanel.width}px` } as CSSProperties;

  function leaveManageFolders(): void {
    selectRailMode(modeBeforeManagingRef.current);
  }

  // Escape leaves Manage Connected Folders only when nothing inside the pane claimed it:
  // an open switcher menu, a dialog, or a modal keeps its own Escape.
  function leaveManageFoldersOnEscape(event: import("react").KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape" || event.defaultPrevented || activeMode !== "connected-folders") return;
    if (event.currentTarget.querySelector('[aria-expanded="true"]')) return;
    if ((event.target as Element).closest?.('[role="menu"], [role="dialog"]') || document.querySelector('[aria-modal="true"]')) return;
    event.preventDefault();
    leaveManageFolders();
  }

  const layoutClassName = ["connected-folder-layout", paneResize.sidebarResizing || agentPanelResizing ? "resizing" : "", sidebarCollapsed ? "sidebar-collapsed" : "", agentPanelOpen ? "agent-panel-open" : ""].filter(Boolean).join(" ");
  return <main className={layoutClassName} ref={paneResize.connectedFolderLayoutRef} style={layoutStyle}>
    <WindowChromeControls sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarHidden(!sidebarCollapsed)} agentPanelOpen={agentPanelOpen} onToggleAgentPanel={toggleAgentPanel} agentControlsRef={setAgentControlsTarget} />
    <ConnectedFolderModeRail activeMode={activeMode} paneHidden={sidebarCollapsed} connectedFolder={connectedFolder} surfaces={surfaces} apps={restrictedApps} appAttention={(app) => appAttention.get(restrictedAppAttentionKey(app.connectedFolderId, app.manifest.id, app.featureInstallationId)) ?? 0} onModeChange={selectRailMode} onOpenSkillsExtensions={setSkillsExtensionsView} accountControl={<button className="connected-folder-rail-account-button" type="button" onClick={() => onOpenSettings()} aria-label="Settings" title="Settings"><Settings24Regular aria-hidden="true" /></button>} automations={hasFolderAutomations ? { active: !sidebarCollapsed && activeMode === "automations" } : null} updateControl={updateStatus && updateNeedsAttention(updateStatus) ? <DesktopUpdateButton status={updateStatus} onClick={onUpdateAction} /> : undefined} />
    <section ref={modePaneRef} className={`connected-folder-mode-pane connected-folder-mode-pane-${activeMode}`} id="connected-folder-file-panel" onKeyDown={activeMode === "connected-folders" ? leaveManageFoldersOnEscape : undefined}>
      <ConnectedFolderPaneHeader connectedFolder={connectedFolder} identity={identity} connectedFolders={connectedFolders} connectedFolderCustomizations={customizations} folderStatuses={folderStatuses} onSwitchConnectedFolder={onSwitchConnectedFolder} onCreateConnectedFolder={onCreateConnectedFolder} onOpenFolder={onOpenFolder} onManageConnectedFolders={() => setActiveMode("connected-folders")} managingConnectedFolders={activeMode === "connected-folders"} onNewChat={() => openChat(connectedFolder, null)} onOpenAppearance={() => openConnectedFolderAppearance(connectedFolder)} {...(!fixture && typeof window.ampleFileDesktop?.connectedFolder.revealFolder === "function" ? { onRevealFolder: () => void openLocalPath("", "reveal") } : {})} {...(!fixture ? { onSetUp: (mode: ConnectedFolderSetUpMode) => void startSetUp(mode) } : {})} />
      {setUpOffered ? <ConnectedFolderSetUpCard connectedFolderName={connectedFolder.name} onSetUp={(mode) => { onCloseSetUpOffer(); void startSetUp(mode); }} onDismiss={onCloseSetUpOffer} /> : null}
      {activeMode === "connected-folders" ? <ConnectedFoldersPane connectedFolder={connectedFolder} connectedFolders={connectedFolders} identities={customizations} onCreate={onCreateConnectedFolder} onOpenFolder={onOpenFolder} onCustomize={openConnectedFolderAppearance} onRemove={(target) => void removeConnectedFolder(target)} onDone={leaveManageFolders} /> : null}
      {activeMode === "files" ? <div className="local-files-panel">
        <input
          ref={uploadRef}
          className="hidden-file-input"
          type="file"
          multiple
          tabIndex={-1}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
            event.target.value = "";
            void uploadFiles(files, uploadTargetPath);
          }}
        />
        <div className="file-tree-toolbar">
          <label className="file-tree-search">
            <Search size={15} />
            <input
              aria-label="Search files"
              type="search"
              placeholder="Search files"
              value={tree.query}
              onChange={(event) => tree.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && tree.query) {
                  event.preventDefault();
                  tree.setQuery("");
                }
              }}
            />
            {tree.query ? <button type="button" onClick={() => tree.setQuery("")} aria-label="Clear File Search" title="Clear File Search"><X size={14} /></button> : null}
          </label>
          <FileSortMenu sort={fileSort} onChange={changeFileSort} />
          {tree.query ? <span className="file-tree-search-count">{tree.searchHydrating ? "Searching" : formatItemCount(tree.matchCount, "match", "matches")}</span> : null}
          {tree.treeTruncated ? <span className="file-tree-truncated" title="This Connected Folder holds more items than Files lists at once. Open a folder to see its contents, or search by name or contents.">Partial List</span> : null}
          <ChecksToolbarButton status={checks.status} loading={checks.loading} unavailable={checks.unavailable} onClick={() => tabs.openChecksSurfaceTab(connectedFolder)} />
        </div>
        <div
          className={["file-tree-shell", uploadingFiles ? "uploading-files" : "", tree.dropTargetFolderPath === "" ? "root-drop-target" : ""].filter(Boolean).join(" ")}
          onContextMenu={openRootContextMenu}
          onDragEnter={(event) => updateDropTarget(event, "")}
          onDragOver={(event) => updateDropTarget(event, "")}
          onDragLeave={clearDropTarget}
          onDrop={(event) => void dropOnTarget(event, "")}
          onClick={(event) => { if (!(event.target as HTMLElement).closest("[data-tree-row]")) tree.setSelectedPath(null); }}
          onKeyDown={(event) => { if (event.key === "Escape" && tree.selectedPath) { event.preventDefault(); tree.setSelectedPath(null); } }}
        >
          {uploadingFiles ? <div className="file-upload-progress" aria-live="polite"><Loader2 className="spin" size={14} />Adding Files</div> : null}
          {tree.status === "refreshing" ? <div className="file-tree-refresh-progress" aria-live="polite"><span className="file-tree-refresh-pill delayed-loading"><Loader2 className="spin" size={13} />Updating Files</span></div> : null}
      {tree.status === "loading" ? <FileTreeLoadingState /> : tree.status === "error" ? <div className="empty-inline file-tree-error"><span>Couldn't load this folder.</span><button className="ui-control ui-control--quiet" type="button" onClick={() => void tree.refresh(false)}>Try Again</button></div> : <FileTree key={connectedFolder.id} entries={sortedFileEntries} collapsedPaths={fileTreeCollapsedPaths} loadingFolderPaths={tree.loadingFolderPaths} selectedPath={tree.selectedPath} selectedPaths={tree.selectedPaths} movingTreePaths={tree.movingTreePaths} dropTargetFolderPath={tree.dropTargetFolderPath} checkAttentionPaths={checks.attentionPaths} searchQuery={tree.query} emptyText={tree.query ? "No file or folder names match." : undefined} onToggleFolder={tree.toggleFolder} onSelectFile={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(connectedFolder, path); }} onFocusEntry={tree.setSelectedPath} onToggleSelected={tree.toggleSelectedPath} onSelectRange={(path, additive) => tree.selectPathRange(path, shownTreePaths, additive)} onSelectAll={() => tree.selectPaths(shownTreePaths, tree.selectedPath)} onPreviewFile={isMacOS() ? previewLocalFile : undefined} onOpenFile={(path) => void openLocalPath(path, "open")} onOpenContextMenu={openContextMenu} onRenameEntry={renameEntry} onDeleteEntry={(path) => void deleteEntries(filesSelectionFor(path))} onUpdateDropTarget={updateDropTarget} onDropOnTarget={dropOnTarget} onNativeDragStartFile={startNativeFileDrag} onDragStartEntry={startTreeDrag} onDragEndEntry={endTreeDrag} nestedFolders={nestedFolderViews} onOpenNestedFolder={onSwitchConnectedFolder} pageFolders={pageFolders} onOpenPage={(path) => { tree.setSelectedPath(path); tabs.openPageSurfaceTab(connectedFolder, path, pageFolders.get(path)?.title); }} />}
        </div>
        {fixture ? null : (
          <FileContentSearch
            connectedFolderId={connectedFolder.id}
            query={tree.query}
            onOpenFile={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(connectedFolder, path); }}
          />
        )}
      </div> : null}
      {activeMode === "chats" ? <ChatsPane connectedFolder={connectedFolder} connectedFolders={connectedFolders} conversations={conversationGroups} customizations={customizations} activityStatuses={chatActivity.statuses} activeConversationId={activeTab?.kind === "chat" ? activeTab.conversationId ?? undefined : undefined} onOpen={(target, conversation) => openChat(target, conversation)} onNew={(target) => openChat(target, null)} onActions={(target, chat, event) => void openChatMenu(target, chat, event)} /> : null}
      {activeMode === "automations" ? <ConnectedFolderAutomationsNavigator automations={folderAutomations.byConnectedFolder[connectedFolder.id]} activeAutomationId={activeTab?.kind === "connected-folder-automation" && activeTab.connectedFolderId === connectedFolder.id ? activeTab.automationId : null} onOpen={(automation) => tabs.openConnectedFolderAutomationSurfaceTab(connectedFolder, automation)} onOpenAllAutomations={() => onOpenSettings("automations")} /> : null}
      {activeMode === "history" ? <HistoryPane onRestored={async () => { setHistoryRefreshRequest((value) => value + 1); await tree.refresh(false); await checks.refresh(); }} connectedFolder={connectedFolder} fixtureItems={fixture?.checkpoints[connectedFolder.id]} fixtureRestorePoints={fixture?.restorePoints} refreshRequest={historyRefreshRequest} onOpen={(item) => tabs.openHistorySurfaceTab(connectedFolder, item.checkpointId, restorePointTitle(item))} onError={onError} /> : null}
      {activeSurface ? <ExtensionSurfacePane surface={activeSurface} activeViewId={activeTab?.kind === "extension" && surfaceMatchesTab(activeSurface, activeTab) ? activeTab.viewId : null} onOpenView={(view) => tabs.openExtensionSurfaceTab(connectedFolder, activeSurface, view)} /> : null}
      {activeRestrictedApp ? <RestrictedAppViewport
        key={`${activeRestrictedApp.featureInstallationId}:${activeRestrictedApp.digest}`}
        app={activeRestrictedApp} placement="navigator"
        route={restrictedAppNavigatorTarget?.mode === activeMode ? restrictedAppNavigatorTarget.route : "/"}
        {...(restrictedAppNavigatorTarget?.mode === activeMode ? {
          ...(restrictedAppNavigatorTarget.state !== undefined ? { state: restrictedAppNavigatorTarget.state } : {}),
          openedFrom: restrictedAppNavigatorTarget.openedFrom,
        } : {})}
        active
      /> : null}
    </section>
    <button className="connected-folder-resizer" type="button" role="separator" aria-label="Resize the navigation pane and work area" aria-controls="connected-folder-file-panel connected-folder-chat-panel" aria-orientation="vertical" aria-valuemin={Math.round(paneResize.sidebarResizeBounds.min)} aria-valuemax={Math.round(paneResize.sidebarResizeBounds.max)} aria-valuenow={paneResize.sidebarResizeValue} title="Resize Panes" onPointerDown={paneResize.startSidebarResize} onDoubleClick={paneResize.resetConnectedFolderSidebarWidth} onKeyDown={paneResize.handleSidebarResizeKeyDown}><span className="sr-only">Resize panes</span></button>
    <aside className="right-rail" id="connected-folder-chat-panel">
      <ConnectedFolderSurfaceTabBar tabs={tabs.surfaceTabs} connectedFolders={connectedFolders} connectedFolderCustomizations={customizations} conversations={conversationGroups} chatActivityStatuses={chatActivity.statuses} activeTabId={tabs.activeSurfaceTabId} newChatConnectedFolderId={connectedFolder.id} onActivate={tabs.setActiveSurfaceTabId} onClose={(tabId) => tabs.closeSurfaceTab(tabId, true)} onReorder={tabs.reorderSurfaceTabs} onNewChatInConnectedFolder={(target) => openChat(target, null)} onTabMenu={(tab, target, conversation, event) => void openChatMenu(target, conversation, event, tab.id)} browserTabLooks={browser.looks} onBrowserTabMenu={browser.openTabMenu} {...(browser.available ? { onNewBrowserTab: browser.newTab } : {})} />
      {tabs.surfaceTabs.length ? tabs.surfaceTabs.map((tab) => {
        if (tab.kind === "browser") {
          // A browser tab belongs to no Connected Folder; every Connected Folder shows it.
          const active = tab.id === tabs.activeSurfaceTabId;
          return (
            <div className="connected-folder-surface-body connected-folder-surface-body-browser" role="tabpanel" id={surfacePanelDomId(tab.id)} aria-labelledby={surfaceTabDomId(tab.id)} hidden={!active} key={tab.id}>
              <BrowserTabPanel tab={tab} page={browser.pages[tab.pageId]} active={active} worker={browserWorker(browser.pages[tab.pageId]?.worker?.owner)} onError={onError} />
            </div>
          );
        }
        const targetConnectedFolder = connectedFolders.find((item) => item.id === tab.connectedFolderId);
        if (!targetConnectedFolder) return null;
        const active = tab.id === tabs.activeSurfaceTabId;
        const targetIdentity = connectedFolderIdentityFor(targetConnectedFolder, customizations);
        const targetConversation = tab.kind === "chat" && tab.conversationId
          ? conversationGroups[targetConnectedFolder.id]?.find((conversation) => conversation.id === tab.conversationId) ?? null
          : null;
        const targetConversationLifecycle = targetConversation ? conversationLifecycleView(targetConversation) : "active";
        return (
          <div className="connected-folder-surface-body" role="tabpanel" id={surfacePanelDomId(tab.id)} aria-labelledby={surfaceTabDomId(tab.id)} hidden={!active} key={tab.id} style={connectedFolderIdentityStyle(targetIdentity)}>
            {tab.kind === "page" ? (
              <PageTab
                connectedFolder={targetConnectedFolder}
                path={tab.path}
                title={tab.title}
                view={tab.view ?? "preview"}
                active={active}
                fixtureMode={Boolean(fixture)}
                onViewChange={(view) => tabs.updatePageSurfaceTab(tab.id, { view })}
                onTitleChange={(title) => tabs.updatePageSurfaceTab(tab.id, { title })}
              />
            ) : tab.kind === "file" && tab.path ? (
              <FileDetailsPane connectedFolder={targetConnectedFolder} active={active} path={tab.path} entry={targetConnectedFolder.id === connectedFolder.id ? findTreeEntry(tree.tree, tab.path) : null} fixtureMode={Boolean(fixture)} fixtureText={fixture?.fileContents[targetConnectedFolder.id]?.[tab.path]} onOpenLocal={(path, action) => openLocalPath(path, action, targetConnectedFolder)} onAddToChatContext={attachToChat} onShowVersionHistory={(path) => openVersionHistory(targetConnectedFolder, path)} onRename={targetConnectedFolder.id === connectedFolder.id ? renameEntry : undefined} canOpenWith={canOpenWith} />
            ) : tab.kind === "connected-folder-automations" || tab.kind === "connected-folder-automation" ? (
              <ConnectedFolderAutomationsPane
                connectedFolder={targetConnectedFolder}
                automations={folderAutomations.byConnectedFolder[targetConnectedFolder.id]}
                {...(tab.kind === "connected-folder-automation" ? { automationId: tab.automationId } : {})}
                active={active}
                fixtureMode={Boolean(fixture)}
                onRefresh={() => folderAutomations.refresh(targetConnectedFolder.id)}
                onOpenAllAutomations={() => onOpenSettings("automations")}
              />
            ) : tab.kind === "checks" ? (
              <ChecksPane
                connectedFolder={targetConnectedFolder}
                active={active}
                onOpenFile={(path) => {
                  if (targetConnectedFolder.id === connectedFolder.id) {
                    setActiveMode("files");
                    tree.setSelectedPath(path);
                  }
                  tabs.openFileSurfaceTab(targetConnectedFolder, path);
                }}
                onChecksChanged={() => targetConnectedFolder.id === connectedFolder.id ? checks.refresh() : undefined}
                onAskWorker={(text) => {
                  const surfaceTabId = tabs.openChatSurfaceTab(targetConnectedFolder, null);
                  setDraftRequest({ id: ++draftRequestId.current, text, connectedFolderId: targetConnectedFolder.id, surfaceTabId });
                }}
              />
            ) : tab.kind === "app-studio" ? (
              <AppStudioPane
                connectedFolder={targetConnectedFolder}
                navigation={appStudioNavigation?.sourceConnectedFolderId === targetConnectedFolder.id ? appStudioNavigation : null}
                connectedFolders={connectedFolders}
                active={active}
                previewRevision={(restrictedAppsState.appsByConnectedFolder[targetConnectedFolder.id] ?? [])
                  .filter((app) => app.runtimeInstanceKind === "development")
                  .map((app) => `${app.featureInstallationId}:${app.digest}:${app.updatedAt}`)
                  .sort()
                  .join("|")}
                fixtureMode={Boolean(fixture)}
                onAppsChanged={(connectedFolderId, runtimeInstanceId, apps) => {
                  restrictedAppsState.replaceRuntimeInstanceApps(connectedFolderId, runtimeInstanceId, apps);
                  void restrictedAppsState.refresh(connectedFolderId);
                }}
                onError={onError}
              />
            ) : tab.kind === "history" ? (
              <HistoryPane onRestored={async () => { setHistoryRefreshRequest((value) => value + 1); await tree.refresh(false); await checks.refresh(); }} connectedFolder={targetConnectedFolder} fixtureItems={fixture?.checkpoints[targetConnectedFolder.id]} fixtureRestorePoints={fixture?.restorePoints} refreshRequest={targetConnectedFolder.id === connectedFolder.id ? historyRefreshRequest : 0} selectedCheckpointId={tab.checkpointId} onOpen={(item) => tabs.openHistorySurfaceTab(targetConnectedFolder, item.checkpointId, restorePointTitle(item))} onError={onError} />
            ) : tab.kind === "extension" ? (() => {
              const targetSurfaceInventoryKnown = Object.prototype.hasOwnProperty.call(surfaceCatalogs, targetConnectedFolder.id);
              if (!targetSurfaceInventoryKnown) return <CenteredState icon={<Loader2 className="spin" size={24} />} title="Loading App View" text="Checking the tools installed for this Connected Folder." />;
              const targetSurfaces = contributedSurfaces(targetConnectedFolder.id, surfaceCatalogs[targetConnectedFolder.id] ?? []);
              const surface = targetSurfaces.find((item) => surfaceMatchesTab(item, tab));
              const view = surface?.views.find((item) => item.id === tab.viewId);
              return surface && view ? <ExtensionSurfaceView surface={surface} view={view} /> : <ExtensionSurfaceUnavailable surfaceId={tab.surfaceId} viewId={tab.viewId} execution={tab.surfaceExecution} />;
            })() : tab.kind === "restricted-app" ? (() => {
              if (!restrictedAppsState.knownConnectedFolderIds.has(targetConnectedFolder.id)) return <CenteredState icon={<Loader2 className="spin" size={24} />} title="Loading App" text="Checking the apps installed for this Connected Folder." />;
              const app = restrictedAppsState.appsByConnectedFolder[targetConnectedFolder.id]?.find((item) => item.manifest.id === tab.appId && item.digest === tab.digest && item.featureInstallationId === tab.featureInstallationId);
              return app
                ? <RestrictedAppViewport app={app} placement="tab" appTabId={tab.appTabId} route={tab.route} state={tab.state} active={active} />
                : <CenteredState icon={<AlertTriangle size={24} />} title="App Unavailable" text="This tab belongs to an app revision that is no longer installed in this Connected Folder." />;
            })() : tab.kind === "chat" ? (
              <ChatPanel surfaceTabId={tab.id} connectedFolder={targetConnectedFolder} connectedFolderCustomizations={customizations} modelConfigurationRevision={modelConfigurationRevision} active={active} targetConversationId={tab.conversationId ?? null} lifecycleView={targetConversationLifecycle} onResumeConversation={targetConversation ? () => updateChatLifecycle(targetConnectedFolder, targetConversation, targetConversationLifecycle === "archived" ? { archived: false } : { snoozedUntil: null }).then(() => {}).catch((caught) => onError(errorText(caught))) : undefined} contextPathRequest={chatContextRequestForTab(contextRequest, targetConnectedFolder.id, tab.id)} draftRequest={chatDraftRequestForTab(draftRequest, targetConnectedFolder.id, tab.id)} onAddPathToChatContext={active && targetConnectedFolder.id === connectedFolder.id ? attachToChat : undefined} onUploadDroppedFiles={active && targetConnectedFolder.id === connectedFolder.id ? uploadDroppedFilesForChat : undefined} onOpenConnectedFolderFile={active && targetConnectedFolder.id === connectedFolder.id ? (path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(connectedFolder, path); } : undefined} onConversationActivated={(conversation) => tabs.handleTabConversationActivated(tab.id, targetConnectedFolder, conversation)} onConversationsChanged={(conversations) => setConversationGroups((current) => ({ ...current, [targetConnectedFolder.id]: conversations }))} onRunningChange={(conversationId, running) => chatActivity.setRunning(chatActivityKey(targetConnectedFolder.id, conversationId), running)} onSettled={(conversationId, needsAttention) => chatActivity.setAttention(chatActivityKey(targetConnectedFolder.id, conversationId), needsAttention)} onViewed={(conversationId) => chatActivity.setAttention(chatActivityKey(targetConnectedFolder.id, conversationId), false)} onAgentFinished={() => targetConnectedFolder.id === connectedFolder.id ? tree.refresh() : undefined} onOpenModelSettings={() => onOpenSettings("ai-models", "connected-folder", true, targetConnectedFolder.id)} onOpenConversation={(conversation) => openChat(targetConnectedFolder, conversation)} onRestrictedAppProposalRequested={() => tabs.setActiveSurfaceTabId(tab.id)} onRestrictedAppInstalled={(app) => openInstalledRestrictedApp(targetConnectedFolder, app)} fixtureMode={Boolean(fixture)} fixtureConversations={fixture && (tab.conversationId || tab.id === `chat:${targetConnectedFolder.id}:new`) ? fixture.conversations[targetConnectedFolder.id] : undefined} fixtureTreeEntries={fixture?.trees[targetConnectedFolder.id]} mentionFolders={mentionFoldersFor(targetConnectedFolder)} />
            ) : null}
          </div>
        );
      }) : <ConnectedFolderSurfaceEmptyState connectedFolder={connectedFolder} identity={identity} onNewChat={() => openChat(connectedFolder, null)} />}
    </aside>
    {agentPanelMounted ? <>
      <button className="connected-folder-resizer agent-panel-resizer" type="button" role="separator" aria-label="Resize the AmpleFile agent panel" aria-controls="amplefile-agent-panel" aria-orientation="vertical" aria-valuemin={agentPanelMinWidth} aria-valuenow={agentPanel.width} hidden={!agentPanelOpen} onPointerDown={startAgentPanelResize} onDoubleClick={() => updateAgentPanel((current) => ({ ...current, width: defaultAgentPanelState.width }))} onKeyDown={resizeAgentPanelWithKeys}><span className="sr-only">Resize the AmpleFile agent panel</span></button>
      <aside className="agent-panel" id="amplefile-agent-panel" aria-label="AmpleFile agent" hidden={!agentPanelOpen}>
        <AmpleFileAgentChat host="panel" fixtureMode={Boolean(fixture)} visible={agentPanelOpen} controlsTarget={agentPanelOpen ? agentControlsTarget : null} onOpenModelSettings={() => onOpenSettings("ai-models", "agent", true)} draftRequest={agentDraftRequest} />
      </aside>
    </> : null}
    {appearanceConnectedFolder ? <ConnectedFolderAppearanceModal
      key={appearanceConnectedFolder.id}
      connectedFolder={appearanceConnectedFolder}
      initialSection={appearanceInitialSection}
      identity={connectedFolderIdentityFor(appearanceConnectedFolder, customizations)}
      customization={customizations[appearanceConnectedFolder.id]}
      canUndo={connectedFolderCustomizations.canUndo(appearanceConnectedFolder.id)}
      onRenameConnectedFolder={renameConnectedFolder}
      onCustomizeConnectedFolder={connectedFolderCustomizations.customize}
      onReplaceConnectedFolder={connectedFolderCustomizations.replace}
      onUndoConnectedFolder={connectedFolderCustomizations.undo}
      onResetConnectedFolder={connectedFolderCustomizations.reset}
      onOpenWorkerSettings={(section, returnSection) => {
        setAppearanceConnectedFolderId(null);
        onOpenSettings("ai-models", "connected-folder", section === "model", appearanceConnectedFolder.id, section === "instructions", () => {
          setAppearanceInitialSection(returnSection);
          setAppearanceConnectedFolderId(appearanceConnectedFolder.id);
        });
      }}
      onClose={closeConnectedFolderAppearance}
    /> : null}
    {fileContextMenu ? <FileContextMenu state={fileContextMenu} onSelect={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(connectedFolder, path); }} onOpenLocal={openLocalPath} canOpenWith={canOpenWith} onAddToChatContext={attachToChat} onAttachSelection={attachToChat} onCopyPath={copyPath} onCopyPaths={copyPaths} onShowVersionHistory={(path) => openVersionHistory(connectedFolder, path)} onRename={fileContextMenu.entry.path && !holdsNestedFolder(fileContextMenu.entry) ? renameEntry : undefined} onNewFolder={requestNewFolder} onUploadHere={chooseUpload} onRefresh={() => void tree.refresh(false)} onGiveWorker={canGiveOwnWorker(fileContextMenu.entry) ? (path) => void giveOwnWorker(path) : undefined} onDelete={deleteEntry} onDeleteSelection={deleteEntries} canDelete={!(fileContextMenu.selection ?? [fileContextMenu.entry]).some(holdsNestedFolder)} onClose={() => setFileContextMenu(null)} /> : null}
    {newFolderTarget ? <NewFolderModal target={newFolderTarget} fixtureMode={Boolean(fixture)} onCreated={(folder) => void folderCreated(folder, newFolderTarget)} onClose={() => setNewFolderTarget(null)} /> : null}
    {renameEntryRequest ? <TextInputModal title={`Rename ${renameEntryRequest.name}`} label="Name" initialValue={renameEntryRequest.name} confirmLabel="Rename" onSubmit={submitEntryRename} onClose={() => setRenameEntryRequest(null)} /> : null}
    {chatActions ? <ChatActionsPopover state={chatActions} onRename={renameChat} onLifecycle={(target, conversation, patch) => updateChatLifecycle(target, conversation, patch).then(() => {})} onDelete={deleteChat} onCopy={copyChat} onClose={() => setChatActions(null)} /> : null}
    {versionHistory ? <FileVersionHistoryModal connectedFolder={versionHistory.connectedFolder} filePath={versionHistory.path} fileName={versionHistory.name} onClose={() => setVersionHistory(null)} onRestored={() => void tree.refresh()} /> : null}
    {skillsExtensionsView ? <SkillsExtensionsModal connectedFolder={connectedFolder} status={agent} initialView={skillsExtensionsView} fixtureMode={Boolean(fixture)} onError={onError} onCatalogChanged={(catalog) => updateSurfaceCatalog(connectedFolder.id, catalog)} onClose={() => setSkillsExtensionsView(null)} /> : null}
    {commandPaletteOpen ? <CommandPaletteHost commands={commands} onClose={closeCommandPalette} /> : null}
  </main>;
}

interface AgentPanelState { open: boolean; width: number }
const agentPanelMinWidth = 300;
const defaultAgentPanelState: AgentPanelState = { open: false, width: 380 };

function clampAgentPanelWidth(width: number): number {
  const max = Math.max(agentPanelMinWidth, Math.round(window.innerWidth * 0.5));
  return Math.round(Math.min(max, Math.max(agentPanelMinWidth, width)));
}

function normalizeAgentPanelState(value: unknown): AgentPanelState {
  if (!value || typeof value !== "object") return defaultAgentPanelState;
  const { open, width } = value as Partial<Record<keyof AgentPanelState, unknown>>;
  return {
    open: open === true,
    width: typeof width === "number" && Number.isFinite(width) ? Math.max(agentPanelMinWidth, Math.round(width)) : defaultAgentPanelState.width,
  };
}

function ConnectedFolderSurfaceEmptyState({ connectedFolder, identity, onNewChat }: { connectedFolder: ConnectedFolderSummary; identity: ReturnType<typeof connectedFolderIdentityFor>; onNewChat: () => void }) {
  return <div className="connected-folder-surface-body connected-folder-surface-body-empty"><div className="connected-folder-surface-empty" style={connectedFolderIdentityStyle(identity)}><span className="connected-folder-surface-empty-icon"><ConnectedFolderIconGlyph icon={identity.Icon} size={24} /></span><h2>{connectedFolder.name}</h2><button className="ui-control ui-control--primary" type="button" onClick={onNewChat}><CirclePlus size={16} />New Chat</button></div></div>;
}

function applyFixtureChatLifecycle(
  conversation: ConversationSummary,
  patch: { archived?: boolean; snoozedUntil?: string | null },
): ConversationSummary {
  if (patch.archived !== undefined) {
    return {
      ...conversation,
      archivedAt: patch.archived ? new Date().toISOString() : null,
      snoozedUntil: patch.archived ? null : conversation.snoozedUntil ?? null,
    };
  }
  return { ...conversation, snoozedUntil: patch.snoozedUntil ?? null };
}

function chatLifecycleFeedback(
  previous: ConversationSummary,
  updated: ConversationSummary,
): {
  text: string;
  undo: { archived?: boolean; snoozedUntil?: string | null };
} {
  const before = conversationLifecycleView(previous);
  const after = conversationLifecycleView(updated);
  if (after === "archived") return { text: "Chat archived", undo: { archived: false } };
  if (after === "snoozed") {
    return {
      text: updated.snoozedUntil ? `Chat snoozed until ${new Date(updated.snoozedUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Chat snoozed",
      undo: before === "archived" ? { archived: true } : { snoozedUntil: previous.snoozedUntil ?? null },
    };
  }
  if (before === "archived") return { text: "Chat restored to Active", undo: { archived: true } };
  if (before === "snoozed") return { text: "Chat resumed", undo: { snoozedUntil: previous.snoozedUntil ?? null } };
  return { text: "Chat updated", undo: { snoozedUntil: previous.snoozedUntil ?? null } };
}

function DesktopUpdateButton({ status, onClick }: { status: DesktopUpdateStatus; onClick: () => void }) {
  const busy = status.phase === "checking" || status.phase === "downloading" || status.phase === "installing";
  const title = updateActionLabel(status);
  const tone = status.phase === "available" || status.phase === "ready" ? "available" : busy ? "working" : status.phase === "error" ? "error" : "idle";
  return <button className={`update-button rail-update-button ${tone}`} type="button" onClick={onClick} disabled={busy} aria-label={title} title={title}>{busy ? <Loader2 className="spin" size={16} /> : status.phase === "error" ? <AlertTriangle size={16} /> : <Download size={16} />}</button>;
}

function updateNeedsAttention(status: DesktopUpdateStatus) { return ["available", "downloading", "ready", "error"].includes(status.phase); }
function updateActionLabel(status: DesktopUpdateStatus) {
  if (status.phase === "available") return `Download AmpleFile ${status.availableVersion ?? "update"}`;
  if (status.phase === "downloading") return status.progressPercent === null ? "Downloading Update" : `Downloading Update · ${Math.round(status.progressPercent)}%`;
  if (status.phase === "ready") return `Restart and Install AmpleFile ${status.availableVersion ?? "update"}`;
  if (status.phase === "installing") return "Restarting to Install Update";
  if (status.phase === "error") return "Retry Update";
  if (status.phase === "not_available") return "AmpleFile is up to date";
  return "Check for Updates";
}

function isCommandPaletteShortcut(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLocaleLowerCase() === "k";
}

function isQuickLookShortcut(event: KeyboardEvent) {
  if ((event.key !== " " && event.code !== "Space") || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (document.querySelector(":is(.modal-backdrop, .publish-review-backdrop):not([data-exit-ghost]), [role='dialog'][aria-modal='true']")) return false;
  const target = event.target instanceof Element ? event.target : null;
  return !target?.closest("input, textarea, select, button, a[href], [contenteditable='true'], [role='button'], [role='textbox'], [data-tree-row]");
}

function commandPaletteBlockedByDialog() {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector(":is(.modal-backdrop, .publish-review-backdrop):not([data-exit-ghost]), [role='dialog'][aria-modal='true']"));
}

/** Several rows dragged together show one small label, such as "3 Items", instead of the row under the pointer. */
function setSelectionDragImage(event: React.DragEvent<HTMLElement>, label: string) {
  const image = document.createElement("div");
  image.className = "file-selection-drag-image";
  image.textContent = label;
  document.body.append(image);
  event.dataTransfer.setDragImage(image, -10, -10);
  window.setTimeout(() => image.remove(), 0);
}

function fixtureConversationGroups(fixture: ConnectedFolderUiFixture): Record<string, ConversationSummary[]> { return Object.fromEntries(Object.entries(fixture.conversations).map(([id, conversations]) => [id, conversations.map(({ messages: _messages, ...summary }) => summary)])); }
function normalizeMode(value: string | null): ConnectedFolderRailMode {
  if (value?.startsWith("app:") && /^[a-z0-9][a-z0-9:_-]{0,255}$/i.test(value.slice(4))) return value as ConnectedFolderRailMode;
  return (["files", "chats", "history", "automations"] as ConnectedFolderRailMode[]).includes(value as ConnectedFolderRailMode) ? value as ConnectedFolderRailMode : "files";
}

function extensionSurfaceIdForMode(mode: ConnectedFolderRailMode): string | null {
  return mode.startsWith("app:") && !mode.startsWith("app:restricted:") ? mode.slice(4) : null;
}

function useScrollbarActivity() {
  useEffect(() => {
    if (isMacOS()) return;
    const activeClass = "scrollbars-active";
    const nearClass = "scrollbar-near";
    let timer: number | null = null;
    let nearElement: HTMLElement | null = null;
    const clearTimer = () => { if (timer !== null) window.clearTimeout(timer); timer = null; };
    const active = () => {
      document.body.classList.add(activeClass);
      clearTimer();
      timer = window.setTimeout(() => { document.body.classList.remove(activeClass); timer = null; }, 900);
    };
    const scrollableAncestorFrom = (target: EventTarget | null) => {
      let node = target instanceof Element ? target : null;
      while (node && node !== document.body) {
        if (node instanceof HTMLElement) {
          const style = window.getComputedStyle(node);
          const scrollsY = node.scrollHeight > node.clientHeight && /(auto|scroll|overlay)/.test(style.overflowY);
          const scrollsX = node.scrollWidth > node.clientWidth && /(auto|scroll|overlay)/.test(style.overflowX);
          if (scrollsY || scrollsX) return node;
        }
        node = node.parentElement;
      }
      return null;
    };
    const setNearElement = (next: HTMLElement | null) => {
      if (nearElement === next) return;
      nearElement?.classList.remove(nearClass);
      nearElement = next;
      nearElement?.classList.add(nearClass);
    };
    const pointerMove = (event: PointerEvent) => {
      const scrollable = scrollableAncestorFrom(event.target);
      if (!scrollable) return setNearElement(null);
      const rect = scrollable.getBoundingClientRect();
      const threshold = 24;
      const nearVertical = scrollable.scrollHeight > scrollable.clientHeight && event.clientX >= rect.right - threshold && event.clientX <= rect.right + 2;
      const nearHorizontal = scrollable.scrollWidth > scrollable.clientWidth && event.clientY >= rect.bottom - threshold && event.clientY <= rect.bottom + 2;
      setNearElement(nearVertical || nearHorizontal ? scrollable : null);
    };
    const pointerLeave = () => setNearElement(null);
    document.addEventListener("scroll", active, true);
    document.addEventListener("wheel", active, { passive: true, capture: true });
    document.addEventListener("pointermove", pointerMove, { passive: true, capture: true });
    document.addEventListener("pointerleave", pointerLeave, true);
    return () => {
      clearTimer();
      document.body.classList.remove(activeClass);
      setNearElement(null);
      document.removeEventListener("scroll", active, true);
      document.removeEventListener("wheel", active, true);
      document.removeEventListener("pointermove", pointerMove, true);
      document.removeEventListener("pointerleave", pointerLeave, true);
    };
  }, []);
}
