import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "./components/chrome/icons";

import { AmpleFileLoadingState } from "./components/brand/AmpleFileBrand";
import { DesktopTitleBar } from "./components/chrome/DesktopTitleBar";
import { CreateConnectedFolderModal } from "./components/modals/CreateConnectedFolderModal";
import { ConnectAiDialog } from "./components/modals/ConnectAiDialog";
import { DesktopSettingsModal, type SettingsPage } from "./components/modals/DesktopSettingsModal";
import { subscribeControlEvents } from "./lib/control-events";
import { FileManagerWelcome } from "./components/file-manager/FileManagerWelcome";
import { onConnectAiRequested } from "./lib/connect-ai";
import { type ModelScope } from "./components/panes/connectedFolderPanes";
import { FileManagerView } from "./components/file-manager/FileManagerView";
import type { ConnectedFolderUiFixture } from "./fixtures/connected-folder-fixture";
import { useApplicationAppearance } from "./hooks/useApplicationAppearance";
import { ConnectedFolderAppearanceProvider } from "./lib/connected-folder-appearance-context";
import { useModelConfigurationRevision } from "./hooks/useModelConfigurationRevision";
import { useBootstrapRefresh } from "./hooks/useBootstrapRefresh";
import { api, errorText } from "./lib/api";
import { readConnectedFolderSetUpOffers, writeConnectedFolderSetUpOffers } from "./lib/connected-folder-setup";
import { ampleFileAgentDraftEvent } from "./lib/agent-draft";
import { isMacOS } from "./lib/platform";
import type { AgentStatus, AppThemePreference, BootstrapResponse, DesktopUpdateStatus, ConnectedFolderSummary } from "./types";
import { ConfirmDialogHost, requestConfirm, showToast, ToastHost } from "./ui/feedback";
import { buildFixtureUpdateStatus, fixtureUpdatePhaseFromQuery } from "./fixtures/settings-fixture";
import { readRunningWork, runDesktopUpdateAction, type DesktopUpdateCalls } from "./lib/update-restart";

const fixtureRequested = new URLSearchParams(window.location.search).get("fixture") === "connected-folder";

type DesktopActionCommand = "toggle-sidebar" | "toggle-agent-panel" | "new-chat" | "reload-connected-folder-state" | "open-capabilities" | "open-skills" | "open-extensions" | "open-command-palette" | "close-tab" | "customize-connected-folder";
/** A cross-cutting request handled by the open Connected Folder view. */
type DesktopAction = { id: number; command: DesktopActionCommand; connectedFolderId?: string };

export function App() {
  const appearance = useApplicationAppearance({ fixtureMode: fixtureRequested });
  const theme = appearance.theme;
  const themePreference = appearance.preferences.mode;
  const setThemePreference = useCallback((mode: AppThemePreference) => appearance.store.update({ mode }), [appearance.store]);
  const [fixture, setFixture] = useState<ConnectedFolderUiFixture | null>(null);
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [activeConnectedFolderId, setActiveConnectedFolderId] = useState(() => localStorage.getItem("amplefile.connected-folder.active") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [createConnectedFolderOpen, setCreateConnectedFolderOpen] = useState(false);
  // Connect your AI: one dialog for every surface that finds no model connected.
  const [connectAiOpen, setConnectAiOpen] = useState(false);
  const afterConnectAi = useRef<(() => void) | undefined>(undefined);
  useEffect(() => onConnectAiRequested((then) => { afterConnectAi.current = then; setConnectAiOpen(true); }), []);
  // Connected Folders just added that still show the Set Up for Me card.
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
  // Offers made since AmpleFile was opened, so the window brings their card into view; not kept between launches.
  const [newSetUpOffers, setNewSetUpOffers] = useState<string[]>([]);
  const offerSetUp = useCallback((connectedFolderId: string) => {
    changeSetUpOffers((current) => [...current.filter((id) => id !== connectedFolderId), connectedFolderId]);
    setNewSetUpOffers((current) => current.includes(connectedFolderId) ? current : [...current, connectedFolderId]);
  }, [changeSetUpOffers]);
  const closeSetUpOffer = useCallback((connectedFolderId: string) => changeSetUpOffers((current) => current.filter((id) => id !== connectedFolderId)), [changeSetUpOffers]);
  // `&setUp=offer` previews the card on the sample Connected Folder shown first.
  const [fixtureSetUpOffer, setFixtureSetUpOffer] = useState(() => fixtureRequested && new URLSearchParams(window.location.search).get("setUp") === "offer");
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
  const [pendingConnectedFolderOpen, setPendingConnectedFolderOpen] = useState<{ id: number; connectedFolderId: string } | null>(null);
  const [desktopAction, setDesktopAction] = useState<DesktopAction | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
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
    return desktopConnectedFolder.onOpenConnectedFolder((connectedFolderId) => {
      setPendingConnectedFolderOpen({ id: Date.now(), connectedFolderId });
      if (!boot.connectedFolders.some((connectedFolder) => connectedFolder.id === connectedFolderId)) void refreshBootstrap();
    });
  }, [boot?.connectedFolders, refreshBootstrap]);
  useEffect(() => {
    if (!pendingConnectedFolderOpen || !boot?.connectedFolders.some((connectedFolder) => connectedFolder.id === pendingConnectedFolderOpen.connectedFolderId)) return;
    setActiveConnectedFolderId(pendingConnectedFolderOpen.connectedFolderId);
    setPendingConnectedFolderOpen(null);
  }, [pendingConnectedFolderOpen, boot?.connectedFolders]);
  useEffect(() => {
    // `&update=<phase>` previews an update phase in Settings → About and the sidebar.
    if (fixtureRequested) {
      const phase = fixtureUpdatePhaseFromQuery(window.location.search);
      if (phase) setUpdateStatus(buildFixtureUpdateStatus(phase));
      return;
    }
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
    const result = await api<{ connectedFolder: ConnectedFolderSummary }>("/api/connected-folders", { method: "POST", body: { name } });
    await refreshBootstrap(); setActiveConnectedFolderId(result.connectedFolder.id); setCreateConnectedFolderOpen(false);
    offerSetUp(result.connectedFolder.id);
  }

  async function openFolder() {
    const picker = window.ampleFileDesktop?.connectedFolder;
    if (!picker) return setError("Folder selection is available in the desktop app.");
    try {
      const selected = await picker.chooseFolder(); if (!selected) return;
      const result = await api<{ connectedFolder: ConnectedFolderSummary }>("/api/connected-folders/local-folder", { method: "POST", body: { connectedFolderRoot: selected.path, folderGrantId: selected.folderGrantId } });
      await refreshBootstrap(); setActiveConnectedFolderId(result.connectedFolder.id);
      offerSetUp(result.connectedFolder.id);
    } catch (caught) { setError(errorText(caught)); }
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
      offerSetUp(connectedFolder.id);
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  function aiConnected(agent: AgentStatus) {
    setBoot((current) => current ? { ...current, agent } : current);
    modelConfigurationChanged();
  }

  /**
   * Settings → About's update button and the sidebar's update indicator both
   * click through here. A download or install ends in a restart, so it asks
   * first and names the work the restart would stop. The preview asks the same
   * question, with `&agentState=running` standing in for a working Chat, and
   * then only says updating is disabled.
   */
  async function runUpdateAction() {
    const desktopUpdates = window.ampleFileDesktop?.updates;
    if (!fixtureRequested && !desktopUpdates) return;
    const previewOnly = async () => { showToast({ text: "Updating is disabled in the preview", tone: "info" }); return null; };
    const updates: DesktopUpdateCalls = desktopUpdates ?? { check: previewOnly, updateNow: previewOnly, install: previewOnly };
    const readWork = fixtureRequested
      ? async () => ({ chats: new URLSearchParams(window.location.search).get("agentState") === "running" && activeConnectedFolder ? [{ connectedFolderId: activeConnectedFolder.id, conversationId: "preview" }] : [], ampleFileAgentWorking: false })
      : () => readRunningWork(api);
    try {
      const next = await runDesktopUpdateAction({ status: updateStatus, updates, confirm: requestConfirm, readWork, connectedFolders: boot?.connectedFolders ?? [] });
      if (next) setUpdateStatus(next);
    } catch (caught) { setError(errorText(caught)); }
  }

  // In the file manager an error is a notice like the others: one card style, stacked, never a bar over the window.
  const errorsAsNotices = Boolean(activeConnectedFolder);
  useEffect(() => {
    if (!errorsAsNotices || !error) return;
    showToast({ text: error, tone: "error" });
    setError(null);
  }, [error, errorsAsNotices]);
  if (!boot || (fixtureRequested && !fixture)) return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""}`} data-theme={theme}>{showDesktopTitleBar ? <DesktopTitleBar /> : null}<AmpleFileLoadingState message={error ?? "Loading your Connected Folders and Workers."} action={error ? <button className="ui-control" type="button" onClick={() => { setError(null); void refreshBootstrap(); }}>Try Again</button> : undefined} /></div>;

  return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""} layout-file-manager`} data-theme={theme}>
    {showDesktopTitleBar ? <DesktopTitleBar /> : null}
    {activeConnectedFolder ? <ConnectedFolderAppearanceProvider palette={appearance.preferences.palette}><FileManagerView connectedFolder={activeConnectedFolder} connectedFolders={boot.connectedFolders} appearance={boot.appearance} agent={boot.agent} desktopAction={desktopAction} fixture={fixture} modelConfigurationRevision={modelConfigurationRevision} onSwitchConnectedFolder={(connectedFolder) => setActiveConnectedFolderId(connectedFolder.id)} onOpenSettings={openSettings} updateStatus={updateStatus} onUpdateAction={() => void runUpdateAction()} onRefreshBootstrap={refreshBootstrap} onCreateConnectedFolder={() => setCreateConnectedFolderOpen(true)} onOpenFolder={() => void openFolder()} setUpOffers={fixture ? (fixtureSetUpOffer ? [fixture.activeConnectedFolderId] : []) : setUpOffers} newSetUpOffers={newSetUpOffers} onOfferSetUp={offerSetUp} onCloseSetUpOffer={fixture ? () => setFixtureSetUpOffer(false) : closeSetUpOffer} onError={setError} /></ConnectedFolderAppearanceProvider>
    : <FileManagerWelcome agentConfigured={Boolean(boot.agent?.configured)} fixtureMode={Boolean(fixture)} onAiConnected={aiConnected} onPutToWork={putStandardFolderToWork} onCreateConnectedFolder={() => setCreateConnectedFolderOpen(true)} onOpenFolder={() => void openFolder()} onOpenSettings={() => openSettings("ai-models", "agent", true)} />}
    {error && !activeConnectedFolder ? <div className="global-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss"><X size={15} /></button></div> : null}
    {createConnectedFolderOpen ? <CreateConnectedFolderModal onClose={() => setCreateConnectedFolderOpen(false)} onCreate={createConnectedFolder} /> : null}
    {connectAiOpen ? <ConnectAiDialog fixtureMode={Boolean(fixture)} onClose={() => { afterConnectAi.current = undefined; setConnectAiOpen(false); }} onConnected={(connected) => { aiConnected(connected.status); const then = afterConnectAi.current; afterConnectAi.current = undefined; then?.(); }} onOpenSettings={() => { setConnectAiOpen(false); openSettings("ai-models", "agent", true); }} /> : null}
    {settingsOpen ? <DesktopSettingsModal appearance={appearance} onCustomizeConnectedFolder={(connectedFolderId) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "customize-connected-folder", connectedFolderId }); }} connectedFolder={settingsWorkerConnectedFolderId ? boot.connectedFolders.find((item) => item.id === settingsWorkerConnectedFolderId) ?? null : activeConnectedFolder} agentStatus={boot.agent} fixtureMode={Boolean(fixture)} initialPage={settingsInitialPage} initialModelScope={settingsModelScope} focusAiModel={settingsFocusAiModel} focusWorkerInstructions={settingsFocusWorkerInstructions} onAgentConfigured={(agent) => setBoot((current) => current ? { ...current, agent } : current)} onModelChanged={modelConfigurationChanged} updateStatus={updateStatus} onUpdateAction={() => void runUpdateAction()} onBackToCustomization={settingsBackAction ? () => { setSettingsOpen(false); setSettingsBackAction(null); settingsBackAction(); } : undefined} onClose={closeSettings} /> : null}
    <ConfirmDialogHost /><ToastHost />
  </div>;
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
