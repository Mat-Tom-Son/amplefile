import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type DragEvent, type KeyboardEvent, type SetStateAction } from "react";
import { ChevronDown16Regular, ChevronUp16Regular, FolderArrowRight16Regular, Globe20Regular, Sparkle16Regular, Grid20Regular, MoreHorizontal20Regular, PanelRight20Regular, TextBulletListLtr20Regular } from "@fluentui/react-icons";

import "./file-manager.css";
import "./file-manager-dialogs.css";
import { ChevronLeft, ChevronRight, Search, X } from "../chrome/icons";
import { TextInputModal } from "../modals/TextInputModal";
import { NewFolderModal, type NewFolderTarget } from "../modals/NewFolderModal";
import { FileVersionHistoryModal } from "../modals/FileVersionHistoryModal";
import { SkillsExtensionsModal } from "../modals/SkillsExtensionsModal";
import { connectedFolderSetUpMessage } from "../../lib/connected-folder-setup";
import { requestConnectAi } from "../../lib/connect-ai";
import type { SettingsPage } from "../modals/DesktopSettingsModal";
import { api, errorText } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { nativeOpenLabel } from "../../lib/file-actions";
import { untitledChatLabel } from "../../constants";
import { desktopPlatform, isMacOS, connectedFolderEntryNativePath } from "../../lib/platform";
import { desktopShortcutModifierKey, desktopShortcutText } from "../../lib/keyboard";
import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";
import { settleIn } from "../../lib/motion";
import { useConnectedFolderCustomizations } from "../../hooks/useConnectedFolderCustomizations";
import { ConnectedFolderAppearanceModal, type ConnectedFolderAppearanceSection } from "../modals/ConnectedFolderAppearanceModal";
import type { ModelScope } from "../panes/AiModelsPane";
import { useConnectedFolderIdentityResolver } from "../../lib/connected-folder-appearance-context";
import { requestConfirm, showToast } from "../../ui/feedback";
import type { ConnectedFolderAppearanceState } from "../../../../src/shared/connected-folder-appearance";
import type { ConnectedFolderUiFixture } from "../../fixtures/connected-folder-fixture";
import type { AgentStatus, ConversationSummary, DesktopUpdateStatus, TreeEntry, ConnectedFolderSummary } from "../../types";
import {
  defaultFileManagerSort,
  fileKindLabel,
  collapseCrumbs,
  fileManagerPathBar,
  fileManagerStatusText,
  formatFileManagerDate,
  nextFileManagerSort,
  normalizeFileManagerSort,
  normalizeFileManagerView,
  parentPath,
  rangeSelection,
  sortFileManagerEntries,
  typeSelectMatch,
  type FileManagerSort,
  type FileManagerSortKey,
  type FileManagerView as FileManagerViewMode,
} from "./file-manager-model";
import { FilePreview } from "./FilePreview";
import { EntryIcon, FileEntries, rowDomId, type EntriesLayout, type EntryHandlers, type FolderLook } from "./FileEntries";
import {
  isShowHiddenFilesKey,
  linkKindLabel,
  folderListingMaxEntries,
  shownEntries,
} from "./file-manager-layout";
import { previewSpaceAction } from "./file-preview-model";
import {
  computerName,
  computerRoot,
  homePlace,
  isComputerPlace,
  placeApiBase,
  placeKey,
  placeNativePath,
  samePlace,
  sidebarStandardFolders,
  standardFolderNames,
  type FileManagerLocation,
  type FileManagerOpenRequest,
  type FileManagerPlace,
  type StandardFolderSummary,
} from "./file-manager-places";
import { useFolderListing } from "./useFolderListing";
import { useFileManagerSearch, type FileManagerSearchResult, type FileManagerSearchScope } from "./useFileManagerSearch";
import { useStandardFolders } from "./useFileManagerPlaces";
import { useFileManagerActivity } from "./useFileManagerActivity";
import { chatActivityKey } from "../../lib/chat-lifecycle";
import { FileManagerPanel } from "./FileManagerPanel";
import { ChatPanel, WorkerModelRow } from "../chat/ChatPanel";
import { PaneResizer, panelWidthSpec, sidebarWidthSpec, usePaneWidth } from "./PaneResizer";
import { BrowserPane, BrowserSplitResizer, type BrowserPaneWorker } from "./BrowserPane";
import { useBrowserPages } from "../../hooks/useBrowserPages";
import { browserHost, browserWorkerChat, clampBrowserFraction, effectiveBrowserLayout, type BrowserPaneLayout } from "../../lib/browser-pages";
import { GoToFolderSheet, type GoToFolderLookup } from "./GoToFolderSheet";
import { UpdateIndicator } from "./UpdateIndicator";
import { useWorkerChanges } from "./useWorkerChanges";
import { useFileOperations } from "./useFileOperations";
import { FileOperationsTray } from "./FileOperationsTray";
import { useConflictQuestion } from "./ConflictDialog";
import { TrashGlyph } from "./file-manager-glyphs";
import { TintedFolder } from "./file-manager-folder";
import { useFolderAutomations } from "../../hooks/useFolderAutomations";
import { useCalendarDay } from "../../hooks/useCalendarDay";
// Drives, the Trash, thumbnails, folder sizes, plain-folder search, and the window with no Connected Folder.
import { currentDriveKey, driveRows, ejectMessage, locationIsOnDrive, statusWithSpace, type DriveRow } from "./file-manager-drives";
import { useDrives, useVolumeSpace } from "./useDrives";
import { TrashView } from "./TrashView";
import { type TrashItem } from "./file-manager-trash";
import { useRememberedFolderSizes } from "./file-manager-folder-size";
import { stoppedEarlyText, usePlainFolderSearch } from "./usePlainFolderSearch";
// The window's parts, each in its own file: navigation, selection, file changes, the clipboard, drops, menus, and the sidebar.
import { type FolderHistory } from "./file-manager-navigation";
// Folder tabs and per-folder view settings.
import { folderTabKey, folderTabStepKey, folderTabTitles, isNewTabKey, stepFolderTab, withTabHistory, type FolderTabNaming, type FolderTabView } from "./file-manager-tabs";
import { folderViewKey, readFolderViews, rememberFolderView, type FolderViewSettings } from "./file-manager-folder-views";
import { useFolderTabs, type PanelChat } from "./useFolderTabs";
import { FolderTabStrip, type FolderTabItem } from "./FolderTabStrip";
import { useFileManagerNavigation } from "./useFileManagerNavigation";
import { useFileSelection } from "./useFileSelection";
import { useFileChanges } from "./useFileChanges";
import { useFileClipboard } from "./useFileClipboard";
import { useFileDrops } from "./useFileDrops";
import { useFileManagerMenus } from "./useFileManagerMenus";
import { ActionMenu, QuickMenu } from "./FileManagerMenus";
import { FileManagerSidebar, RecentsGlyph } from "./FileManagerSidebar";
import { SetUpOffer, SuggestingComposer, WorkerReceipt } from "./FileManagerPanelParts";
import { fixtureLookup, fixtureRecents, type FixturePlaces } from "./file-manager-fixture-places";
import { chatTitleOrNull, cssEscape, desktopErrorText, hiddenKey, joinNative, letterKey, listItemDomId, placeFileBridge, recentKey, sameFolder, type RecentItem } from "./file-manager-view-helpers";

const viewStorageKey = "amplefile.file-manager.view.v1";
const panelStorageKey = "amplefile.file-manager.panel.v1";
const sortStorageKey = "amplefile.file-manager.sort.v1";
/** Show Hidden Files, for the whole window, kept on this computer like the view. */
const showHiddenStorageKey = "amplefile.file-manager.show-hidden.v1";
/** Icons or List and the sort, remembered for each folder on this computer (file-manager-folder-views.ts). */
const folderViewsStorageKey = "amplefile.file-manager.folder-views.v1";
/** The Browser pane's share of the main area when the folder and the browser are both shown. */
const browserSplitStorageKey = "amplefile.file-manager.browser-split.v1";
/** How the Browser pane was left, so a window closed and reopened, or reloaded, shows the same tab the same way. Pages do not outlive a quit, so neither does this. */
const browserPaneStorageKey = "amplefile.file-manager.browser-pane.v1";
function readStoredBrowserPane(parsed: unknown): { layout: BrowserPaneLayout; activePageId: string | null } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const { layout, activePageId } = parsed as { layout?: unknown; activePageId?: unknown };
  if (layout !== "collapsed" && layout !== "split" && layout !== "full") return null;
  return { layout, activePageId: typeof activePageId === "string" ? activePageId : null };
}
const typeSelectResetMs = 900;
const noSetUpOffers: readonly string[] = [];

/**
 * The file manager layout (docs/product-model.md, "The file manager
 * window"): a Finder-style window over the same local API and desktop bridge
 * Files uses. The sidebar opens the Standard Folders and every Connected Folder;
 * any other folder opens in the computer place (Go to Folder, the path bar,
 * Command-Up, or a folder handed to AmpleFile).
 */
export function FileManagerView({ connectedFolder: activeConnectedFolder, connectedFolders, appearance, agent, fixture, desktopAction, modelConfigurationRevision = 0, onSwitchConnectedFolder, openLocationRequest = null, onOpenedLocation, onOpenSettings, updateStatus = null, onUpdateAction, onRefreshBootstrap, onCreateConnectedFolder, onOpenFolder, setUpOffers = noSetUpOffers, newSetUpOffers = noSetUpOffers, onOfferSetUp, onCloseSetUpOffer, onError }: {
  /** The Connected Folder the window opened in; null when none is registered (the window opens at the home folder). */
  connectedFolder: ConnectedFolderSummary | null;
  connectedFolders: ConnectedFolderSummary[];
  agent: AgentStatus;
  /** Menu-bar commands meant for the window in front, and Settings' Customize button. */
  desktopAction?: { id: number; command: string; connectedFolderId?: string } | null;
  appearance?: ConnectedFolderAppearanceState;
  fixture: ConnectedFolderUiFixture | null;
  /** Bumped when a model choice changes in Settings or elsewhere, so model rows re-read it. */
  modelConfigurationRevision?: number;
  onSwitchConnectedFolder: (connectedFolder: ConnectedFolderSummary) => void;
  /** A folder or file handed to AmpleFile, as the host resolved it: the window goes there and selects the item. */
  openLocationRequest?: FileManagerOpenRequest | null;
  /** The window has shown that request. */
  onOpenedLocation?: (id: number) => void;
  onOpenSettings: (page?: SettingsPage, modelScope?: ModelScope, focusAiModel?: boolean, workerConnectedFolderId?: string, focusWorkerInstructions?: boolean, backToCustomization?: () => void) => void;
  /** The desktop updater's status, shown at the foot of the sidebar when it needs the person. */
  updateStatus?: DesktopUpdateStatus | null;
  /** The same update action as Settings → About's button. */
  onUpdateAction?: () => void;
  onRefreshBootstrap: () => Promise<unknown>;
  /** The + beside Connected Folders: New Connected Folder and Connect Folder, as in the File menu. */
  onCreateConnectedFolder: () => void;
  onOpenFolder: () => void;
  /** Connected Folders just connected whose Set Up for Me card is still showing. */
  setUpOffers?: readonly string[];
  /** Those of them connected since AmpleFile was opened: their card is brought into view, even when this window is only now appearing. */
  newSetUpOffers?: readonly string[];
  /** A folder was connected from this window: offer to set it up. */
  onOfferSetUp?: (connectedFolderId: string) => void;
  /** The card was answered, either way: it does not come back. */
  onCloseSetUpOffer?: (connectedFolderId: string) => void;
  onError: (message: string | null) => void;
}) {
  const fixtureMode = Boolean(fixture);
  const mac = isMacOS();
  // Space asks Quick Look on the Mac; on another desktop (and in its sample
  // window) the window draws its own Preview. The plain browser has neither.
  const builtInPreview = !mac && Boolean(desktopPlatform());
  const resolveIdentity = useConnectedFolderIdentityResolver();
  // Each Connected Folder's name, colors, icon, and banner, edited in Customize Connected Folder.
  const connectedFolderCustomizations = useConnectedFolderCustomizations({
    fixtureCustomizations: fixture ? fixture.customizations : null,
    appearance,
    connectedFolderIds: connectedFolders.map((item) => item.id).join("|"),
  });
  const { customizations } = connectedFolderCustomizations;
  const [customizing, setCustomizing] = useState<{ connectedFolderId: string; section: ConnectedFolderAppearanceSection } | null>(null);
  const customizingConnectedFolder = customizing ? connectedFolders.find((item) => item.id === customizing.connectedFolderId) ?? null : null;
  const standard = useStandardFolders(fixtureMode);

  // With no Connected Folder the window is still a file manager: it opens at the home folder.
  const startLocation = (): FileManagerLocation => activeConnectedFolder ? { place: { kind: "connected-folder", id: activeConnectedFolder.id }, path: "" } : { place: homePlace, path: "" };
  // The window's folder tabs (file-manager-tabs.ts): each has its own place, Back and Forward, selection, scroll
  // position, search, and Trash or Recents view. Everything below that reads "the folder shown" reads the tab in front.
  const folderTabs = useFolderTabs(startLocation);
  const activeTab = folderTabs.activeTab;
  const tabId = activeTab.id;
  const history = activeTab.history;
  // Bound to the tab of this render: work that finishes after the person has gone to another tab lands in its own.
  const setHistory = (update: (current: FolderHistory) => FolderHistory) => folderTabs.update(tabId, (tab) => withTabHistory(tab, update(tab.history)));
  const location = history.location;
  const setLocation = (next: FileManagerLocation) => setHistory((current) => ({ ...current, location: next }));
  const place = location.place;
  const connectedFolder = place.kind === "connected-folder" ? connectedFolders.find((item) => item.id === place.id) ?? null : null;
  const standardFolder = place.kind === "standard" ? standard.folders.find((item) => item.id === place.id) ?? null : null;
  const inComputerPlace = isComputerPlace(place);
  const placeName = connectedFolder?.name
    ?? standardFolder?.name
    ?? (inComputerPlace ? computerName() : null)
    ?? standardFolderNames[place.id] ?? place.id;
  const placeRoot = connectedFolder?.connectedFolderRoot ?? standardFolder?.root ?? (inComputerPlace ? computerRoot : "");
  /** Any place's name, for messages about files moved from it. */
  const nameOfPlace = (target: FileManagerPlace): string => target.kind === "connected-folder"
    ? connectedFolders.find((item) => item.id === target.id)?.name ?? "the original Connected Folder"
    : isComputerPlace(target) ? computerName() : standard.folders.find((item) => item.id === target.id)?.name ?? standardFolderNames[target.id] ?? target.id;
  const apiBase = placeApiBase(place);
  const fixtureTree = fixture
    ? place.kind === "connected-folder" ? fixture.trees[place.id] ?? [] : place.kind === "standard" ? standard.fixtureTrees?.[place.id] ?? [] : []
    : undefined;
  const [showHidden, setShowHiddenState] = useState<boolean>(() => readStoredJsonValue(showHiddenStorageKey, (value) => value === true, false));
  const setShowHidden = (next: boolean) => { setShowHiddenState(next); writeStoredJsonValue(showHiddenStorageKey, next); };
  const toggleShowHiddenRef = useRef<() => void>(() => undefined);
  toggleShowHiddenRef.current = () => setShowHidden(!showHidden);
  // The menu bar's New Tab, Close Tab, the tab keys, and View → Show Tab Bar's check follow this window.
  useEffect(() => { window.ampleFileDesktop?.menu?.setState({ folderTabsOpen: true, showTabBar: folderTabs.showTabBar }); }, [folderTabs.showTabBar]);
  useEffect(() => () => window.ampleFileDesktop?.menu?.setState({ folderTabsOpen: false }), []);
  // The View menu's check mark follows the window.
  useEffect(() => { window.ampleFileDesktop?.menu?.setState({ showHiddenFiles: showHidden }); }, [showHidden]);
  const listing = useFolderListing(place, location.path, fixtureTree, { showHidden });
  const bridge = useMemo(() => placeFileBridge(place), [placeKey(place)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Icons or List and the sort are remembered for each folder on this computer, by its Connected Folder's portable
  // id or its path on disk, never in the folder (file-manager-folder-views.ts). A folder with nothing remembered
  // shows the person's last choice.
  const [lastView, setLastView] = useState<FileManagerViewMode>(() => readStoredJsonValue(viewStorageKey, normalizeFileManagerView, "list"));
  const [lastSort, setLastSort] = useState<FileManagerSort>(() => readStoredJsonValue(sortStorageKey, normalizeFileManagerSort, defaultFileManagerSort));
  const [folderViews, setFolderViews] = useState(() => readStoredJsonValue(folderViewsStorageKey, readFolderViews, {}));
  const folderViewAt = activeTab.view === "folder" ? folderViewKey(location, placeRoot ? (location.path ? connectedFolderEntryNativePath(placeRoot, location.path) : placeRoot) : null) : null;
  const rememberedView = folderViewAt ? folderViews[folderViewAt] : undefined;
  const view = rememberedView?.view ?? lastView;
  const sort = rememberedView?.sort ?? lastSort;
  const viewChosenRef = useRef(false);
  function chooseFolderView(next: FolderViewSettings) {
    if (next.view !== view) { viewChosenRef.current = true; setLastView(next.view); writeStoredJsonValue(viewStorageKey, next.view); }
    if (next.sort !== sort) { setLastSort(next.sort); writeStoredJsonValue(sortStorageKey, next.sort); }
    if (!folderViewAt) return;
    const remembered = rememberFolderView(folderViews, folderViewAt, next, Date.now());
    setFolderViews(remembered);
    writeStoredJsonValue(folderViewsStorageKey, remembered);
  }
  const setView = (next: FileManagerViewMode) => chooseFolderView({ view: next, sort });
  const setSort = (next: FileManagerSort) => chooseFolderView({ view, sort: next });
  const [panelOpen, setPanelOpenState] = useState<boolean>(() => readStoredJsonValue(panelStorageKey, (value) => value !== false, true));
  // The panel slides in when it's shown with the toolbar button, not at launch.
  const panelSeenOpenRef = useRef(panelOpen);
  const panelArrivalRef = useRef(0);
  if (panelOpen && !panelSeenOpenRef.current) panelArrivalRef.current = Date.now() + 400;
  const panelArriving = panelOpen && Date.now() < panelArrivalRef.current;
  useEffect(() => { panelSeenOpenRef.current = panelOpen; }, [panelOpen]);
  const setPanelOpen = (next: boolean) => { setPanelOpenState(next); writeStoredJsonValue(panelStorageKey, next); };
  // A folder connected while the window is open brings its Set Up for Me card into view: the panel opens on Info.
  // An offer left from an earlier day waits quietly where it is. One made just now is shown, including the first
  // folder connected from the welcome, when this window appears with the offer already made.
  const seenSetUpOffersRef = useRef(new Set(setUpOffers.filter((id) => !newSetUpOffers.includes(id))));
  const [infoRequest, setInfoRequest] = useState(0);
  useEffect(() => {
    // The card is at the top of the Connected Folder it is for, so it is brought into view when that one is shown.
    const shown = connectedFolder?.id;
    if (!shown || !setUpOffers.includes(shown) || seenSetUpOffersRef.current.has(shown)) return;
    seenSetUpOffersRef.current.add(shown);
    setPanelOpen(true);
    setInfoRequest((value) => value + 1);
  }, [setUpOffers, connectedFolder?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const folderAutomations = useFolderAutomations(connectedFolder?.id ?? activeConnectedFolder?.id ?? "", fixtureMode);
  // The search field, where it searches, and the selection belong to the tab.
  const query = activeTab.query;
  const setQuery = (next: string) => folderTabs.update(tabId, (tab) => tab.query === next ? tab : { ...tab, query: next });
  const searchScope: FileManagerSearchScope = activeTab.searchScope;
  const setSearchScope = (next: FileManagerSearchScope) => folderTabs.update(tabId, (tab) => tab.searchScope === next ? tab : { ...tab, searchScope: next });
  const [searchSelection, setSearchSelection] = useState<string | null>(null);
  const selection = activeTab.selection;
  const setSelection: Dispatch<SetStateAction<string[]>> = (action) => folderTabs.update(tabId, (tab) => {
    const next = typeof action === "function" ? action(tab.selection) : action;
    return next === tab.selection ? tab : { ...tab, selection: next };
  });
  const [hiddenPaths, setHiddenPaths] = useState<ReadonlySet<string>>(() => new Set());
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Switching between List and Icons settles the new layout in rather than cutting; a folder or tab shown in the other view just appears.
  const viewMotionRef = useRef(view);
  useEffect(() => {
    if (viewMotionRef.current === view) return;
    viewMotionRef.current = view;
    if (viewChosenRef.current) settleIn([contentRef.current]);
    viewChosenRef.current = false;
  }, [view]);
  const searchFieldRef = useRef<HTMLInputElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = usePaneWidth(sidebarWidthSpec);
  const [panelWidth, setPanelWidth] = usePaneWidth(panelWidthSpec);
  // Notices sit over the folder list, centered between the sidebar and the panel; they live outside this view, so the widths go on the page.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--fm-notice-left", `${sidebarWidth}px`);
    root.setProperty("--fm-notice-right", `${panelOpen ? panelWidth : 0}px`);
    return () => { root.removeProperty("--fm-notice-left"); root.removeProperty("--fm-notice-right"); };
  }, [sidebarWidth, panelWidth, panelOpen]);
  const typeSelectRef = useRef<{ text: string; timer: number | null }>({ text: "", timer: null });

  const [renaming, setRenaming] = useState<TreeEntry | null>(null);
  const [newFolderTarget, setNewFolderTarget] = useState<NewFolderTarget | null>(null);
  const [newStandardFolderParent, setNewStandardFolderParent] = useState<string | null>(null);
  const [versionHistory, setVersionHistory] = useState<TreeEntry | null>(null);
  const [skillsFor, setSkillsFor] = useState<ConnectedFolderSummary | null>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  // Recents: files changed lately across the Connected Folders and the top of Desktop, Documents, and Downloads.
  const recentsOpen = activeTab.view === "recents";
  const [recents, setRecents] = useState<RecentItem[] | null>(null);
  const [recentSelection, setRecentSelection] = useState<string | null>(null);
  // The system Trash, shown in the list area like Recents; the items chosen there, for Info.
  const trashOpen = activeTab.view === "trash";
  /** What the tab's list area shows: the folder, the Trash, or Recents. */
  const setTabView = (next: FolderTabView) => folderTabs.update(tabId, (tab) => tab.view === next ? tab : { ...tab, view: next });
  const setRecentsOpen = (open: boolean) => folderTabs.update(tabId, (tab) => open ? (tab.view === "recents" ? tab : { ...tab, view: "recents" }) : tab.view === "recents" ? { ...tab, view: "folder" } : tab);
  const setTrashOpen = (open: boolean) => folderTabs.update(tabId, (tab) => open ? (tab.view === "trash" ? tab : { ...tab, view: "trash" }) : tab.view === "trash" ? { ...tab, view: "folder" } : tab);
  const [trashSelection, setTrashSelection] = useState<TrashItem[]>([]);
  const [trashCount, setTrashCount] = useState<number | null>(null);
  // Mounted drives, kept current by the host's events, and the one being ejected.
  const drives = useDrives(fixtureMode);
  const [ejecting, setEjecting] = useState<string | null>(null);
  // The window's key handler is installed once; it reaches the current undo through this.
  const undoFileChangeRef = useRef<(redo: boolean) => Promise<void>>(async () => undefined);
  // Copies, moves, Compresses, and Extracts running now, with their progress and Stop; and the name-clash question.
  const fileOperations = useFileOperations(!fixtureMode);
  const conflictQuestion = useConflictQuestion();
  // Files dropped onto the message box, referenced alongside the selection.
  const [attachedPaths, setAttachedPaths] = useState<string[]>([]);
  // Bumped when a Worker reply ends here, so the receipt reads what it changed.
  const [turnsSettled, setTurnsSettled] = useState(0);
  // The Chat the panel holds (docs/product-model.md): one per tab, in the Connected Folder it belongs to
  // (useFolderTabs.ts). Another tab's Chat stays mounted out of sight, so a reply running in it goes on as it was.
  const panelChat: PanelChat | null = folderTabs.chats[tabId] ?? null;
  const setPanelChat = (action: SetStateAction<PanelChat | null>) => folderTabs.setChat(tabId, action);

  // The Browser pane (docs/built-in-browser.md): the built-in browser's tabs,
  // under the folder's contents. The tabs belong to no Connected Folder, so
  // they stay as the folder shown changes. A tab a Worker opens arrives as the
  // tab strip alone; the person decides how much of the area the page takes.
  const mainRef = useRef<HTMLElement | null>(null);
  const [browserLayoutChoice, setBrowserLayout] = useState<BrowserPaneLayout>("collapsed");
  const [browserFraction, setBrowserFractionState] = useState(() => readStoredJsonValue(browserSplitStorageKey, clampBrowserFraction, clampBrowserFraction(null)));
  const setBrowserFraction = (next: number) => { setBrowserFractionState(next); writeStoredJsonValue(browserSplitStorageKey, next); };
  // The page the person can see right now, as the pane reports it: Workers are told only that.
  const [browserViewingPageId, setBrowserViewingPageId] = useState<string | null>(null);
  const browser = useBrowserPages({
    bridge: fixture ? fixture.browser ?? null : window.ampleFileDesktop?.browser ?? null,
    viewingPageId: browserViewingPageId,
    // A link the person followed, or a page a Worker was asked to show, opens the pane if it is folded away.
    onShow: () => setBrowserLayout((current) => current === "collapsed" || current === "hidden" ? "split" : current),
  });
  const browserLayout = effectiveBrowserLayout(browserLayoutChoice, browser.tabs.length);
  const browserShown = browserLayout === "split" || browserLayout === "full";
  // With its last tab closed the pane goes away, and the next tab a Worker opens arrives as the strip alone.
  useEffect(() => { if (browser.ready && !browser.tabs.length) setBrowserLayout("collapsed"); }, [browser.ready, browser.tabs.length]);
  // The window was closed and reopened, or reloaded, with pages still running: the pane comes back as it was left,
  // with the same tab in front. Read once, when the desktop's pages are known.
  const browserRestoredRef = useRef(false);
  useEffect(() => {
    if (!browser.ready || browserRestoredRef.current) return;
    browserRestoredRef.current = true;
    const stored = readStoredJsonValue(browserPaneStorageKey, readStoredBrowserPane, null);
    // Pages do not outlive a quit, so the tab that was in front still being here is what says this is the same
    // launch. A size saved in an earlier launch is not applied: a page the person never opened arrives as the strip.
    if (!stored?.activePageId || !browser.tabs.some((tab) => tab.pageId === stored.activePageId)) return;
    browser.select(stored.activePageId);
    setBrowserLayout(stored.layout);
  }, [browser.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!browserRestoredRef.current) return;
    writeStoredJsonValue(browserPaneStorageKey, browser.tabs.length ? { layout: browserLayout === "hidden" ? "collapsed" : browserLayout, activePageId: browser.activeId } : null);
  }, [browserLayout, browser.activeId, browser.tabs.length]);
  // A page asked to be confirmed before it is left (a form half filled in), and the person started the leaving:
  // the window asks, and tells the desktop the answer. Nothing leaves until they say.
  const browserLeaveAskedRef = useRef(new Map<string, AbortController | null>());
  useEffect(() => {
    const asked = browserLeaveAskedRef.current;
    const standing = new Set<string>();
    for (const page of Object.values(browser.pages)) {
      const question = page.leaveQuestion;
      if (!question) continue;
      standing.add(question.requestId);
      if (asked.has(question.requestId)) continue;
      const withdraw = new AbortController();
      asked.set(question.requestId, withdraw);
      const site = browserHost(page.url);
      // The keyboard starts on Cancel: the Return that asked for the address must not also answer Leave.
      void requestConfirm({ title: "Leave This Page?", body: `Changes you made${site ? ` on ${site}` : ""} may not be saved.`, confirmLabel: "Leave", tone: "danger", signal: withdraw.signal })
        .then((leave) => {
          // Withdrawn: the page has already gone, or stayed, without the person. There is nothing left to answer.
          if (withdraw.signal.aborted) return;
          asked.set(question.requestId, null);
          return browser.bridge?.command(page.pageId, { type: leave ? "leave-page" : "stay-on-page" });
        })
        .catch((caught) => onError(errorText(caught)));
    }
    // The question went away on the desktop (a Worker moved the page on, it redirected itself, its tab closed):
    // the dialog goes with it.
    for (const [requestId, withdraw] of asked) {
      if (standing.has(requestId)) continue;
      withdraw?.abort();
      asked.delete(requestId);
    }
  }, [browser.pages]); // eslint-disable-line react-hooks/exhaustive-deps
  function toggleBrowser() {
    if (browserLayout === "hidden") { browser.newTab(); setBrowserLayout("split"); }
    else setBrowserLayout(browserShown ? "collapsed" : "split");
  }
  /** Whose Worker is using a page, and the way to its Chat: the Chat opens in the panel, in its own Connected Folder. */
  function describeBrowserWorker(owner: string): BrowserPaneWorker | null {
    const chat = browserWorkerChat(owner);
    const folder = chat ? connectedFolders.find((item) => item.id === chat.connectedFolderId) : undefined;
    if (!chat || !folder) return { label: "A Worker is using this page", title: "A Worker is using this page" };
    return {
      label: `Worker in ${folder.name}`,
      title: `The ${folder.name} Worker is using this page`,
      onOpen: () => {
        setPanelOpen(true);
        if (!(panelChat && panelChat.connectedFolderId === folder.id && (panelChat.activeId ?? panelChat.conversationId) === chat.conversationId)) {
          setPanelChat({ key: Date.now(), connectedFolderId: folder.id, conversationId: chat.conversationId, activeId: chat.conversationId, title: untitledChatLabel, sendRequest: null, open: true });
        } else setPanelChat({ ...panelChat, open: true });
        // A Chat belongs to its Connected Folder, so the window goes there when another is shown.
        // Already in it, the person keeps their place, whichever of its folders they are in.
        if (folder.id === connectedFolder?.id) return;
        // The folder stays beside the browser only if it was already there.
        const keep = browserLayout;
        navigate({ place: { kind: "connected-folder", id: folder.id }, path: "" }, "push", folder);
        setBrowserLayout(keep);
      },
    };
  }
  // Searching or opening Recents brings the folder back when the browser had the whole area.
  useEffect(() => {
    if (query.trim() || recentsOpen) setBrowserLayout((current) => current === "full" ? "split" : current);
  }, [query, recentsOpen]);
  /** Brings one browser tab into view, from a notice; a tab closed since has nothing to show. */
  function showBrowserTab(pageId: string) {
    if (!browserTabsRef.current.some((tab) => tab.pageId === pageId)) return;
    browser.select(pageId);
    setBrowserLayout((current) => current === "full" ? current : "split");
  }
  const browserTabsRef = useRef(browser.tabs);
  browserTabsRef.current = browser.tabs;
  // A site is waiting on the person and its page is not in view: the window says so once for each question, and
  // takes the notice down when the question is answered, dropped by the page, or brought into view.
  const browserAskedRef = useRef(new Map<string, { pageId: string; dismiss: (() => void) | null }>());
  useEffect(() => {
    const asked = browserAskedRef.current;
    const pending = new Set<string>();
    for (const page of Object.values(browser.pages)) {
      const request = page.permissionRequest;
      if (!request) continue;
      pending.add(request.requestId);
      const inView = browserViewingPageId === page.pageId;
      const known = asked.get(request.requestId);
      if (known) {
        // In view, the question is in front of the person, above the page.
        if (inView && known.dismiss) { known.dismiss(); known.dismiss = null; }
        continue;
      }
      asked.set(request.requestId, {
        pageId: page.pageId,
        dismiss: inView ? null : showToast({ text: `${browserHost(request.origin)} is waiting for your answer`, tone: "info", actionLabel: "Show Page", onAction: () => showBrowserTab(page.pageId), durationMs: 12_000 }),
      });
    }
    for (const [requestId, entry] of asked) {
      if (pending.has(requestId)) continue;
      entry.dismiss?.();
      asked.delete(requestId);
    }
  }, [browser.pages, browserViewingPageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another part of the app (the menu bar, a notification) chose a different
  // Connected Folder: show its top level, as choosing it in the sidebar would.
  const knownActiveRef = useRef(activeConnectedFolder?.id ?? null);
  useEffect(() => {
    const previous = knownActiveRef.current;
    knownActiveRef.current = activeConnectedFolder?.id ?? null;
    if (previous === knownActiveRef.current) return;
    if (!activeConnectedFolder || (place.kind === "connected-folder" && place.id === activeConnectedFolder.id)) return;
    navigate({ place: { kind: "connected-folder", id: activeConnectedFolder.id }, path: "" });
  }, [activeConnectedFolder?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tabs kept from before came back: the window's Connected Folder is the one the tab in front shows.
  useEffect(() => {
    if (folderTabs.restored) followTabConnectedFolder(location.place);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** A tab came to the front in a Connected Folder: it becomes the window's Connected Folder, as going there would make it. */
  function followTabConnectedFolder(target: FileManagerPlace) {
    if (target.kind !== "connected-folder" || target.id === activeConnectedFolder?.id) return;
    const folder = connectedFolders.find((item) => item.id === target.id);
    if (!folder) return;
    // The window already shows it, so the change of Connected Folder is not a request to go there.
    knownActiveRef.current = folder.id;
    onSwitchConnectedFolder(folder);
  }

  // Files dropped on the message box belong to the folder shown, in its tab.
  useEffect(() => { setAttachedPaths([]); }, [tabId, placeKey(place), location.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // A Chat belongs to its Connected Folder; leaving it for another place closes it.
  useEffect(() => {
    if (panelChat && panelChat.connectedFolderId !== connectedFolder?.id) setPanelChat(null);
  }, [placeKey(place)]); // eslint-disable-line react-hooks/exhaustive-deps

  // A Connected Folder removed elsewhere leaves nothing to show; fall back to the active one.
  useEffect(() => {
    if (place.kind === "connected-folder" && !connectedFolder) setLocation(startLocation());
  }, [activeConnectedFolder?.id, place, connectedFolder]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hidden items (dotfiles, and what the system file manager hides) only while Show Hidden Files is on.
  const entries = useMemo(() => shownEntries(listing.entries, showHidden), [listing.entries, showHidden]);
  // The Kind column names a Connected Folder nested here the way the rest of the window does, and says a link is one.
  const kindLabel = (entry: TreeEntry) => entry.link ? linkKindLabel(entry.link) : entry.nestedFolder ? "Connected Folder" : fileKindLabel(entry);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const shown = entries.filter((entry) => !hiddenPaths.has(hiddenKey(place, entry.path)) && (!needle || entry.name.toLocaleLowerCase().includes(needle)));
    return sortFileManagerEntries(shown, sort, kindLabel);
  }, [entries, hiddenPaths, query, sort, placeKey(place)]); // eslint-disable-line react-hooks/exhaustive-deps
  const order = useMemo(() => visible.map((entry) => entry.path), [visible]);
  const byPath = useMemo(() => new Map(visible.map((entry) => [entry.path, entry])), [visible]);
  const selected = useMemo(() => new Set(selection.filter((path) => byPath.has(path))), [byPath, selection]);
  // The selected items in shown order, read once per selection rather than on every render.
  const selectedShown = useMemo(() => selected.size ? visible.filter((entry) => selected.has(entry.path)) : [], [visible, selected]);
  // Where the drawn items are (FileEntries publishes it), for scrolling one into view and for the selection rectangle.
  const entriesLayoutRef = useRef<EntriesLayout | null>(null);
  const focusPath = selection.length ? selection[selection.length - 1] ?? null : null;
  // The built-in Preview follows the selected item, so the arrow keys move it.
  const [previewOpen, setPreviewOpen] = useState(false);

  // Selection belongs to the folder shown; the tab starts it fresh when it goes elsewhere (withTabHistory). Coming
  // back to a tab keeps its selection, with Shift-click extending from its last item. The Preview is put away.
  const locationKey = `${placeKey(place)}\0${location.path}`;
  const shownFolderRef = useRef({ tabId, key: locationKey });
  useEffect(() => {
    const previous = shownFolderRef.current;
    shownFolderRef.current = { tabId, key: locationKey };
    if (previous.tabId === tabId && previous.key === locationKey) return;
    anchorRef.current = previous.tabId === tabId ? null : selection.at(-1) ?? null;
    setPreviewOpen(false);
  }, [tabId, locationKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const folderName = location.path ? location.path.split("/").pop() ?? placeName : placeName;
  // Search names and contents (the design's search): in the folder shown, or every Connected Folder.
  const searching = Boolean(query.trim());
  // A Standard Folder or the computer place searches names and text below it through the host's folder search.
  const plainSearch = place.kind === "standard" && searchScope === "here";
  const searchMode = searching && !trashOpen && (searchScope === "all" || place.kind === "connected-folder" || plainSearch);

  // ---- The window's parts (their own files) ----
  const { anchorRef, select, clickEntry, bandRef, startBand, bandJustEnded } = useFileSelection({
    mac, view, selection, setSelection, selected, order, byPath, contentRef, entriesLayoutRef,
    bandAllowed: !searchMode && !recentsOpen && listing.status === "ready" && visible.length > 0,
    folderKey: `${tabId}\0${placeKey(place)}\0${location.path}\0${view}`,
  });
  const { navigate, goBack, goForward, goToEnclosingFolder, openNativeFolder, showLocation, canGoBack, canGoForward } = useFileManagerNavigation({
    fixtureMode, history, setHistory, placeRoot, activeConnectedFolderId: activeConnectedFolder?.id ?? null, connectedFolders, onSwitchConnectedFolder,
    onNavigate: () => {
      setRecentsOpen(false);
      setTrashOpen(false);
      // Going somewhere brings the folder back when the browser had the whole area.
      setBrowserLayout((current) => current === "full" ? "split" : current);
    },
    listing, contentRef, select, onError,
  });
  const changes = useFileChanges({ fixtureMode, place, location, apiBase, selection, byPath, listing, standard, fileOperations, conflictQuestion, select, setSelection, setHiddenPaths, nameOfPlace, requestRename, onError });
  const { deletePaths, duplicateSelection, renameEntry, runTrashDeletion } = changes;
  const clipboard = useFileClipboard({ fixtureMode, place, placeRoot, location, contentRef, changes, nameOfPlace, onError });
  const { cutItems } = clipboard;
  const drops = useFileDrops({ fixtureMode, place, placeRoot, location, folderName, bridge, selection, selected, byPath, listTakesNoDrop: searchMode || recentsOpen, listing, changes, select, nameOfPlace, onError });
  const { dropTarget, setDropTarget, isItemDrag } = drops;
  const menus = useFileManagerMenus({
    mac, fixtureMode, place, location, placeName, bridge, selection, selected, byPath, select, onError,
    actions: {
      openEntry, openLocal, showOriginal, copyPaths,
      openEntryInNewTab: (entry) => openEntryInNewTab(entry),
      openPlaceInNewTab: (target) => openInNewTab({ place: target, path: "" }),
      showVersionHistory: connectedFolder ? setVersionHistory : null,
      requestNewFolder, refresh: listing.refresh, putToWork, requestRename,
      deletePaths, copySelection: clipboard.copySelection, cutSelection: clipboard.cutSelection, pasteInto: clipboard.pasteInto,
      duplicateSelection, compressSelection: changes.compressSelection, extractArchive: changes.extractArchive, groupSelection: changes.groupSelection,
      canPaste: clipboard.canPaste,
      openSettings: () => onOpenSettings(),
      customize: (target) => setCustomizing({ connectedFolderId: target.id, section: "banner" }),
      removeConnectedFolder, openSkills: setSkillsFor, organize, removeStandardFolder,
      createConnectedFolder: onCreateConnectedFolder, connectFolder: onOpenFolder,
    },
  });
  const { openContextMenu, openActionMenu, quickMenu, setQuickMenu, actionMenu, setActionMenu } = menus;
  // The window's key handler is installed once; it reaches the current undo through this.
  undoFileChangeRef.current = (redo) => changes.undoFileChange(redo);

  // A folder or file handed to AmpleFile (a launcher, Finder, a second launch) opens where the host resolved it.
  useEffect(() => {
    if (!openLocationRequest) return;
    showLocation(openLocationRequest.location, openLocationRequest.select);
    onOpenedLocation?.(openLocationRequest.id);
  }, [openLocationRequest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Folder tabs ----
  // A tab brought to the front shows its list scrolled where it was left, once its folder is listed.
  const pendingScrollRef = useRef<string | null>(null);
  useEffect(() => {
    if (pendingScrollRef.current !== tabId) return;
    if (activeTab.view !== "folder") { pendingScrollRef.current = null; return; }
    if (listing.key !== locationKey || listing.status === "loading") return;
    pendingScrollRef.current = null;
    const top = activeTab.scrollTop;
    window.requestAnimationFrame(() => { if (contentRef.current) contentRef.current.scrollTop = top; });
  }, [tabId, listing.key, listing.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // What was chosen in search results, Recents, or the Trash belongs to the tab it was chosen in.
  const shownTabRef = useRef(tabId);
  useEffect(() => {
    if (shownTabRef.current === tabId) return;
    shownTabRef.current = tabId;
    setSearchSelection(null);
    setRecentSelection(null);
    setTrashSelection([]);
    setTrashCount(null);
  }, [tabId]);

  /** Keeps where the tab in front is scrolled, for when it comes back. */
  function rememberScroll() {
    const top = contentRef.current?.scrollTop ?? 0;
    folderTabs.update(tabId, (tab) => tab.scrollTop === top ? tab : { ...tab, scrollTop: top });
  }

  /** Brings a tab to the front: its folder, selection, search, and Chat, where they were left. */
  function showTab(id: string) {
    if (id === tabId) return;
    const target = folderTabs.current().tabs.find((tab) => tab.id === id);
    if (!target) return;
    rememberScroll();
    pendingScrollRef.current = id;
    folderTabs.select(id);
    afterTabShown(target.history.location, target.view);
  }

  /** A tab has come to the front: Recents is read again, a folder comes back from under a full browser, and a Connected Folder becomes the window's. */
  function afterTabShown(where: FileManagerLocation, shows: FolderTabView) {
    if (shows === "recents") void loadRecents();
    setBrowserLayout((current) => current === "full" ? "split" : current);
    followTabConnectedFolder(where.place);
  }

  /**
   * A new tab right after the one in front. New Tab opens at what the tab in
   * front shows; Open in New Tab at a folder. A middle click leaves it behind,
   * as a browser does; anything else brings it to the front.
   */
  function openInNewTab(where: FileManagerLocation, shows: FolderTabView = "folder", options: { behind?: boolean } = {}) {
    if (!options.behind) rememberScroll();
    const id = folderTabs.open(where, { view: shows, activate: !options.behind });
    if (!id) { showToast({ text: "This window has as many tabs as it can hold. Close one to open another.", tone: "info" }); return; }
    if (options.behind) return;
    afterTabShown(where, shows);
    window.requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true }));
  }

  function newTab() {
    openInNewTab(history.location, activeTab.view);
  }

  /**
   * Closes a tab. Its Chat closes with it; a reply running there keeps
   * running and is in the Connected Folder's History. File operations it
   * started belong to the window and keep going. The last tab closes the
   * window, which leaves AmpleFile running.
   */
  function closeTab(id = tabId) {
    const front = folderTabs.close(id);
    if (front === false) { window.ampleFileDesktop?.window?.control?.("close"); return; }
    if (!front) return;
    pendingScrollRef.current = front.id;
    afterTabShown(front.history.location, front.view);
  }

  /** Next and previous tab, wrapping round. */
  function stepTab(step: 1 | -1) {
    const next = stepFolderTab(folderTabs.current(), step);
    showTab(next.activeId);
  }

  /** Where a folder row opens (a nested Connected Folder, a Standard Folder, or the folder itself), or null for anything else. */
  function folderLocationOf(entry: TreeEntry): FileManagerLocation | null {
    if (entry.kind !== "folder" || entry.link) return null;
    const nested = nestedConnectedFolder(entry);
    if (nested) return { place: { kind: "connected-folder", id: nested.id }, path: "" };
    // A folder that is a Standard Folder opens as that one, so the sidebar shows where you are.
    const sidebarFolder = place.kind === "standard" && placeRoot
      ? standard.folders.find((item) => !item.connectedFolderId && sameFolder(item.root, placeNativePath(placeRoot, entry.path)))
      : undefined;
    if (sidebarFolder) return { place: { kind: "standard", id: sidebarFolder.id }, path: "" };
    return { place, path: entry.path };
  }

  /** Open in New Tab, from a folder's menu, a middle click, or ⌘-double-click (Ctrl elsewhere). */
  function openEntryInNewTab(entry: TreeEntry, options: { behind?: boolean } = {}) {
    const where = folderLocationOf(entry);
    if (where) openInNewTab(where, "folder", options);
  }

  /** A place's name as a tab title shows it. */
  function placeLabel(target: FileManagerPlace): string {
    if (target.kind === "connected-folder") return connectedFolders.find((item) => item.id === target.id)?.name ?? "Connected Folder";
    return isComputerPlace(target) ? computerName() : standard.folders.find((item) => item.id === target.id)?.name ?? standardFolderNames[target.id] ?? target.id;
  }

  /** A place's top on disk, when it is known. */
  function placeRootOf(target: FileManagerPlace): string {
    if (target.kind === "connected-folder") return connectedFolders.find((item) => item.id === target.id)?.connectedFolderRoot ?? "";
    return isComputerPlace(target) ? computerRoot : standard.folders.find((item) => item.id === target.id)?.root ?? "";
  }

  /**
   * A tab's title is its folder's name (the place's own name at its top, the
   * Trash, or Recents). Two tabs on different folders with the same name each
   * add as few of the folders above as tell them apart (folderTabTitles).
   */
  function tabNaming(tab: { history: FolderHistory; view: FolderTabView }): FolderTabNaming & { detail: string } {
    if (tab.view !== "folder") {
      const name = tab.view === "trash" ? "Trash" : "Recents";
      return { name, above: [], key: folderTabKey(tab.history.location, tab.view), detail: name };
    }
    const where = tab.history.location;
    const root = placeRootOf(where.place);
    const name = where.path ? where.path.slice(where.path.lastIndexOf("/") + 1) : placeLabel(where.place);
    const native = root ? (where.path ? connectedFolderEntryNativePath(root, where.path) : root) : "";
    return { name, above: native.split(/[\\/]/).filter(Boolean).slice(0, -1).reverse(), key: folderTabKey(where, "folder"), detail: native || name };
  }

  /** A drag of items over a tab: its folder takes them, the way the list does. */
  function tabDropTarget(id: string): { place: FileManagerPlace; path: string; name: string } | null {
    const tab = folderTabs.tabs.find((item) => item.id === id);
    if (!tab || tab.view !== "folder") return null;
    const where = tab.history.location;
    return { ...where, name: where.path ? where.path.slice(where.path.lastIndexOf("/") + 1) : placeLabel(where.place) };
  }

  function tabDragOver(id: string, event: DragEvent<HTMLElement>) {
    if (!tabDropTarget(id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = drops.hasInternalDrag() ? "move" : "copy";
  }

  async function tabDrop(id: string, event: DragEvent<HTMLElement>) {
    const target = tabDropTarget(id);
    if (!target) return;
    event.preventDefault();
    await drops.dropInto({ place: target.place, path: target.path }, event, target.name, { select: id === tabId });
  }

  /** The registered Connected Folder a nested folder row stands for. */
  function nestedConnectedFolder(entry: TreeEntry): ConnectedFolderSummary | undefined {
    if (!entry.nestedFolder || !placeRoot) return undefined;
    return connectedFolders.find((item) => sameFolder(item.connectedFolderRoot, joinNative(placeRoot, entry.path)));
  }

  async function openEntry(entry: TreeEntry) {
    if (entry.link) { await openLink(entry); return; }
    if (entry.kind === "folder") {
      const where = folderLocationOf(entry);
      if (where) navigate(where);
      return;
    }
    await openLocal(entry.path, nativeOpenLabel(entry).office ? "open-native" : "open");
  }

  /**
   * Opening a symbolic link: a linked folder shows where it really is (the
   * host resolves the link again now); a linked file opens what it points to
   * in its default app; a broken link says so and opens nothing.
   */
  async function openLink(entry: TreeEntry) {
    const link = entry.link;
    if (!link) return;
    if (link.target === "missing") { showToast({ text: `“${entry.name}” is a broken link. What it points to isn’t there.`, tone: "info" }); return; }
    if (link.target === "folder") {
      if (fixtureMode) { showToast({ text: "Opening links is disabled in the preview", tone: "info" }); return; }
      await openNativeFolder(placeNativePath(placeRoot, entry.path));
      return;
    }
    await openLinkInDesktop(entry, "open");
  }

  /** Show Original: the window goes to where the link's target really is, with it selected. */
  async function showOriginal(entry: TreeEntry) {
    const link = entry.link;
    if (!link) return;
    if (link.target === "missing") { showToast({ text: `“${entry.name}” is a broken link. What it points to isn’t there.`, tone: "info" }); return; }
    if (fixtureMode) { showToast({ text: "Showing originals is disabled in the preview", tone: "info" }); return; }
    await openNativeFolder(link.targetPath, true);
  }

  /** A link's file opens, or the link itself is shown in the system file manager, through the desktop. */
  async function openLinkInDesktop(entry: TreeEntry, action: "open" | "reveal") {
    if (fixtureMode) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    const placeLink = window.ampleFileDesktop?.placeLink;
    if (!placeLink) { showToast({ text: "Opening files is available in the Mac app", tone: "info" }); return; }
    try {
      await placeLink.open(place, entry.path, action);
    } catch (caught) {
      onError(desktopErrorText(errorText(caught)));
    }
  }

  async function openLocal(path: string, action: "reveal" | "open" | "open-native" | "open-with") {
    const linked = byPath.get(path);
    if (linked?.link) {
      if (action === "reveal") await openLinkInDesktop(linked, "reveal");
      else if (action === "open") await openLink(linked);
      return;
    }
    if (fixtureMode) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    if (!bridge) { showToast({ text: "Opening files is available in the Mac app", tone: "info" }); return; }
    try {
      if (action === "open-with") {
        if (!bridge.openWith) return;
        const result = await bridge.openWith(path);
        if (result.opened && result.appName) showToast({ text: `Opened in ${result.appName}`, tone: "success" });
        return;
      }
      await bridge.open(path, action);
    } catch (caught) {
      onError(desktopErrorText(errorText(caught)));
    }
  }

  function quickLook(path: string | null) {
    // A link is opened, shown, or its path copied; nothing previews it.
    const target = path ? byPath.get(path) ?? null : null;
    if (target?.link) return;
    // Another desktop's window draws its own Preview, which Space opens and closes.
    if (builtInPreview) {
      const action = previewSpaceAction(previewShown, target);
      if (action) setPreviewOpen(action === "open");
      return;
    }
    const entry = path ? byPath.get(path) : null;
    if (!entry || entry.kind !== "file") return;
    // Quick Look is the Mac's; the plain browser points to the Mac app for it.
    if (!bridge) { showToast({ text: "Quick Look is available in the Mac app", tone: "info" }); return; }
    void bridge.preview(entry.path).catch((caught) => onError(errorText(caught)));
  }

  async function copyPaths(paths: readonly string[]) {
    await copyToClipboard({ text: paths.map((path) => connectedFolderEntryNativePath(placeRoot, path)).join("\n") });
    showToast({ text: paths.length === 1 ? "Path copied" : "Paths copied", tone: "success" });
  }

  async function createStandardFolder(parent: string, name: string) {
    if (place.kind !== "standard") return;
    const created = await api<{ path: string }>(`/api/standard-folders/${encodeURIComponent(place.id)}/folders`, { method: "POST", body: { parentPath: parent, name } });
    await listing.refresh();
    select([created.path]);
  }

  /** "Connect This Folder" inside a Connected Folder, or "Connect This Folder" in a standard folder. */
  async function putToWork(path: string, target: FileManagerPlace = place) {
    if (fixtureMode) { showToast({ text: "Making Connected Folders is disabled in the preview", tone: "info" }); return; }
    try {
      const url = target.kind === "connected-folder"
        ? `/api/connected-folders/${encodeURIComponent(target.id)}/nested-folders`
        : `/api/standard-folders/${encodeURIComponent(target.id)}/connected-folders`;
      const { connectedFolder: created } = await api<{ connectedFolder: ConnectedFolderSummary }>(url, { method: "POST", body: { path } });
      await Promise.all([onRefreshBootstrap(), standard.refresh(), listing.refresh()]);
      onOfferSetUp?.(created.id);
      const open = () => navigate({ place: { kind: "connected-folder", id: created.id }, path: "" }, "push", created);
      if (target.kind === "standard" && (!path || (samePlace(target, place) && path === location.path))) {
        // The folder itself is a Connected Folder now, and the sidebar lists it there.
        open();
        showToast({ text: `${created.name} is now a Connected Folder.`, tone: "success" });
        return;
      }
      showToast({ text: `${created.name} is now a Connected Folder.`, actionLabel: "Open", onAction: open });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /**
   * Disconnect: AmpleFile stops using the folder; a linked folder and
   * its files stay where they are, and a managed one moves to Recently Deleted.
   * The host refuses while that Connected Folder has work that needs it, and
   * its words say what to do.
   */
  async function removeConnectedFolder(target: ConnectedFolderSummary) {
    if (fixtureMode) { showToast({ text: "Disconnecting is disabled in the preview", tone: "info" }); return; }
    const linked = target.location.storage === "linked";
    const confirmed = await requestConfirm({
      title: linked ? `Disconnect ${target.name}?` : `Delete ${target.name}?`,
      body: linked
        ? "AmpleFile stops using this folder as a Connected Folder. The folder and its files stay where they are."
        : "Its folder moves to Recently Deleted, where you can restore it.",
      confirmLabel: linked ? "Disconnect" : "Delete",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await api(`/api/connected-folders/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      connectedFolderCustomizations.forget(target.id);
      const fallback = connectedFolders.find((item) => item.id !== target.id);
      if (place.kind === "connected-folder" && place.id === target.id && fallback) navigate({ place: { kind: "connected-folder", id: fallback.id }, path: "" }, "push", fallback);
      // Other tabs in it go to the same Connected Folder, or home when it was the last.
      folderTabs.relocate((where) => where.place.kind === "connected-folder" && where.place.id === target.id, fallback ? { place: { kind: "connected-folder", id: fallback.id }, path: "" } : { place: homePlace, path: "" });
      await Promise.all([onRefreshBootstrap(), standard.refresh()]);
      showToast({ text: linked ? `${target.name} was removed. The folder is still on your computer.` : `${target.name} moved to Recently Deleted.`, tone: "success" });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /** Before a message goes to a Worker, AI must be connected; Set Up AI comes first, then the message goes. */
  function withAi(send: () => void) {
    if (fixtureMode || agent?.configured) { send(); return; }
    requestConnectAi(send);
  }

  /** The message box: a new Chat in the panel, with the selection (or the folder shown) as references. */
  function startChat(text: string, references: readonly TreeEntry[]) {
    withAi(() => openNewChat(text, references));
  }

  function openNewChat(text: string, references: readonly TreeEntry[]) {
    if (!connectedFolder) return;
    setAttachedPaths([]);
    const paths = references.length ? references.map((entry) => entry.path) : location.path ? [location.path] : [];
    const id = Date.now();
    setPanelChat({ key: id, connectedFolderId: connectedFolder.id, conversationId: null, activeId: null, title: text.length > 42 ? `${text.slice(0, 40)}…` : text, sendRequest: { id, text, paths }, open: true });
  }

  function openChat(conversationId: string, title: string) {
    if (!connectedFolder) return;
    if (panelChat && (panelChat.activeId ?? panelChat.conversationId) === conversationId && panelChat.connectedFolderId === connectedFolder.id) { setPanelChat({ ...panelChat, open: true }); return; }
    setPanelChat({ key: Date.now(), connectedFolderId: connectedFolder.id, conversationId, activeId: conversationId, title, sendRequest: null, open: true });
  }

  // The menu bar's commands that mean something here: Skills & Extensions
  // (⌘⇧S) for the Connected Folder shown, New Chat (⌘⇧N) at the message box, and Refresh (⌘R).
  useEffect(() => {
    if (!desktopAction) return;
    const { command } = desktopAction;
    if (["open-capabilities", "open-skills", "open-extensions"].includes(command)) {
      const target = connectedFolder ?? activeConnectedFolder;
      // Skills & Extensions is pinned to a Connected Folder; with none, there is nothing to open it for yet.
      if (target) setSkillsFor(target);
      else showToast({ text: "Skills & Extensions belong to a Connected Folder. Connect a folder first.", tone: "info" });
    }
    else if (command === "new-chat" && connectedFolder) {
      setPanelOpen(true);
      setPanelChat((current) => current ? { ...current, open: false } : current);
      window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".fm-comp .fm-field input")?.focus());
    } else if (command === "reload-connected-folder-state") void Promise.all([onRefreshBootstrap(), standard.refresh(), listing.refresh()]);
    else if (command === "toggle-hidden-files") toggleShowHiddenRef.current();
    else if (command === "customize-connected-folder" && desktopAction.connectedFolderId) setCustomizing({ connectedFolderId: desktopAction.connectedFolderId, section: "banner" });
    // Close Tab (⌘W): nothing behind a dialog. While the Browser pane has the keyboard it closes the browser tab in
    // front, as it always has (a page that has the keyboard sends its own Close Tab through the desktop host, naming
    // itself). Anywhere else (the folder's list, a Chat's message box, the sidebar) it closes the folder tab in front,
    // and the last one closes the window.
    else if (command === "close-tab") {
      if (document.querySelector('[role="dialog"], .modal-backdrop')) return;
      if (document.activeElement instanceof HTMLElement && document.activeElement.closest(".fm-browser")) {
        if (!browserShown || !browser.activeId) return;
        browser.close(browser.activeId);
        // The keyboard stays in the tab strip, so the next ⌘W closes the next tab.
        window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.fm-browser-tab [role="tab"][tabindex="0"]')?.focus());
        return;
      }
      closeTab();
    }
    else if (command === "new-tab") newTab();
    else if (command === "next-tab") stepTab(1);
    else if (command === "previous-tab") stepTab(-1);
    else if (command === "toggle-tab-bar") folderTabs.setShowTabBar(!folderTabs.showTabBar);
  }, [desktopAction?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function renameConnectedFolder(target: ConnectedFolderSummary, name: string) {
    if (fixtureMode) { showToast({ text: "Connected Folder rename is disabled in the preview", tone: "info" }); return; }
    try {
      await api(`/api/connected-folders/${encodeURIComponent(target.id)}`, { method: "PATCH", body: { name } });
      await onRefreshBootstrap();
      showToast({ text: `Renamed Connected Folder to ${name}`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); throw caught; }
  }

  /** The preview's sample folders, for Go to Folder and Recents. */
  function fixturePlaces(): FixturePlaces {
    return { connectedFolders, connectedFolderTrees: fixture?.trees ?? {}, standardFolders: standard.folders, standardFolderTrees: standard.fixtureTrees ?? null };
  }

  /** Go to Folder's lookup: the host's, or the preview's sample folders. */
  async function lookupPath(path: string): Promise<GoToFolderLookup> {
    if (fixtureMode) return fixtureLookup(path, fixturePlaces());
    return api<GoToFolderLookup>(`/api/go-to-folder?path=${encodeURIComponent(path)}`);
  }


  function goTo(target: NonNullable<GoToFolderLookup["target"]>) {
    setGoToOpen(false);
    setQuery("");
    showLocation({ place: target.place, path: target.path }, target.select);
  }

  /** Clicking a path bar item copies its path; the last item is the folder shown, or the item selected. */
  async function copyNativePath(nativePath: string) {
    if (!nativePath) return;
    await copyToClipboard({ text: nativePath });
    showToast({ text: "Path copied", tone: "success" });
  }

  // New Tab (⌘T, Ctrl+T) and the next and previous tab keys (Ctrl+Tab and Ctrl+Shift+Tab, plus ⇧⌘] and ⇧⌘[ on
  // the Mac and Ctrl+PageDown and Ctrl+PageUp elsewhere). The window owns them so they work wherever the keyboard
  // is, except in the Browser pane, whose own tab keys they are there, and behind a dialog.
  const tabKeysRef = useRef<{ newTab: () => void; step: (step: 1 | -1) => void }>({ newTab: () => undefined, step: () => undefined });
  tabKeysRef.current = { newTab, step: stepTab };
  useEffect(() => {
    function keydown(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      if (event.target instanceof Element && event.target.closest(".fm-browser")) return;
      const step = folderTabStepKey(event, mac);
      if (step) { event.preventDefault(); tabKeysRef.current.step(step); return; }
      if (isNewTabKey(event, mac)) { event.preventDefault(); tabKeysRef.current.newTab(); }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [mac]);

  // ⌘F searches names and contents, and ⇧⌘G goes to a folder by its path, as in Finder.
  useEffect(() => {
    function keydown(event: globalThis.KeyboardEvent) {
      // Show Hidden Files: ⇧⌘. on a Mac, Ctrl+H elsewhere, as the system file manager has it; not while typing.
      if (isShowHiddenFilesKey(event, mac)) {
        const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
        if (typing || document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        toggleShowHiddenRef.current();
        return;
      }
      const command = mac ? event.metaKey : event.ctrlKey;
      if (!command || event.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.shiftKey && (event.key === "g" || event.key === "G")) { event.preventDefault(); setGoToOpen(true); return; }
      // ⌘Z / ⇧⌘Z undo and redo file changes, except while typing, where they stay the text's own.
      if (event.code === "KeyZ") {
        const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
        if (typing) return;
        event.preventDefault();
        void undoFileChangeRef.current(event.shiftKey);
        return;
      }
      if (event.shiftKey || (event.key !== "f" && event.key !== "F")) return;
      event.preventDefault();
      searchFieldRef.current?.focus();
      searchFieldRef.current?.select();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [mac]);

  /** The + beside Standard Folders: the folder picker adds any folder to the sidebar. */
  async function addStandardFolder() {
    const add = window.ampleFileDesktop?.standardFolder?.add;
    if (fixtureMode || !add) { showToast({ text: "Adding folders to the sidebar works in the Mac app", tone: "info" }); return; }
    try {
      const added = await add();
      if (!added) return;
      await standard.refresh();
      navigate({ place: { kind: "standard", id: added.id }, path: "" });
    } catch (caught) { onError(errorText(caught)); }
  }

  async function removeStandardFolder(folder: StandardFolderSummary) {
    try {
      await api(`/api/standard-folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" });
      if (place.kind === "standard" && place.id === folder.id) navigate(startLocation());
      folderTabs.relocate((where) => where.place.kind === "standard" && where.place.id === folder.id, startLocation());
      await standard.refresh();
      showToast({ text: `${folder.name} was removed from the sidebar. The folder is still on your computer.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
  }

  /** Organize, from the Action menu or a Connected Folder's right-click menu: a Chat in the panel asking its Worker to organize it. */
  function organize(target: ConnectedFolderSummary) {
    withAi(() => sendToWorker(target, "Organize this folder.", "Organize this folder."));
  }

  /** Set Up for Me, from the card shown after a folder is connected: a Chat in the panel whose first message the set-up Skill answers. */
  function setUp(target: ConnectedFolderSummary) {
    // The offer closes when the message goes, so backing out of Set Up AI leaves the card where it was.
    withAi(() => { onCloseSetUpOffer?.(target.id); sendToWorker(target, connectedFolderSetUpMessage, "Set Up for Me"); });
  }

  /** A new Chat with one message for a Connected Folder's Worker, going to that Connected Folder first if it is not the one shown. */
  function sendToWorker(target: ConnectedFolderSummary, text: string, title: string) {
    if (target.id !== connectedFolder?.id) navigate({ place: { kind: "connected-folder", id: target.id }, path: "" }, "push", target);
    setPanelOpen(true);
    const id = Date.now();
    setPanelChat({ key: id, connectedFolderId: target.id, conversationId: null, activeId: null, title, sendRequest: { id, text, paths: [] }, open: true });
  }

  /** A file a Chat names: show it here, selected, the way the design does. */
  function showChatFileNow(path: string) {
    if (!connectedFolder) return;
    const folder = parentPath(path);
    if (folder !== location.path) navigate({ place: { kind: "connected-folder", id: connectedFolder.id }, path: folder });
    window.setTimeout(() => select([path]), folder !== location.path ? 300 : 0);
  }
  // Stable for the Chat's lifetime: every reply's links depend on it, and a new
  // function per render would re-resolve and re-render every reply.
  const showChatFileRef = useRef(showChatFileNow);
  showChatFileRef.current = showChatFileNow;
  const showChatFile = useCallback((path: string) => showChatFileRef.current(path), []);

  function requestRename(entry: TreeEntry | undefined) {
    // A link is renamed as itself.
    if (!entry || entry.nestedFolder) return;
    if (fixtureMode) { showToast({ text: "Renaming is disabled in the preview", tone: "info" }); return; }
    setRenaming(entry);
  }

  function requestNewFolder(parent: string) {
    if (fixtureMode) { showToast({ text: "New folders are disabled in the preview", tone: "info" }); return; }
    if (connectedFolder) setNewFolderTarget({ connectedFolderId: connectedFolder.id, connectedFolderName: connectedFolder.name, parentPath: parent });
    else if (place.kind === "standard") setNewStandardFolderParent(parent);
  }

  /** Icon view's tiles to a row, as last drawn. */
  function iconColumns(): number {
    const layout = entriesLayoutRef.current;
    return layout?.kind === "grid" ? layout.columns : 1;
  }

  async function openRecents() {
    setQuery("");
    setTabView("recents");
    await loadRecents();
  }

  /** Recents is read again each time a tab shows it. */
  async function loadRecents() {
    setRecentSelection(null);
    if (fixtureMode) { setRecents(fixtureRecents(fixturePlaces())); return; }
    setRecents(null);
    try {
      setRecents((await api<{ recents: RecentItem[] }>("/api/recents")).recents);
    } catch (caught) {
      setRecents([]);
      onError(errorText(caught));
    }
  }

  /** The sidebar's Trash: the system Trash in the list area, read again each time it is shown. */
  function openTrash() {
    setQuery("");
    setTrashSelection([]);
    setTrashCount(null);
    setTabView("trash");
    setBrowserLayout((current) => current === "full" ? "split" : current);
  }

  /** A drive in the sidebar opens in the computer place at its mount path. */
  function openDrive(row: DriveRow) {
    navigate(row.location);
  }

  /** Eject: the host's plain reason when the drive is busy or refused; leaving it first when it is the folder shown. */
  async function ejectDrive(row: DriveRow) {
    if (!row.volume) return;
    if (fixtureMode) { showToast({ text: "Ejecting is disabled in the preview", tone: "info" }); return; }
    setEjecting(row.key);
    const outcome = await drives.eject(row.volume);
    setEjecting(null);
    if (outcome.ok) {
      const volume = row.volume;
      if (locationIsOnDrive(location, volume)) navigate(startLocation());
      // Other tabs on the drive go where the tab in front would.
      folderTabs.relocate((where) => locationIsOnDrive(where, volume), startLocation());
    }
    showToast(ejectMessage(row.name, outcome));
  }

  function recentRoot(item: RecentItem): string {
    if (item.place.kind === "connected-folder") return connectedFolders.find((wf) => wf.id === item.place.id)?.connectedFolderRoot ?? "";
    return standard.folders.find((folder) => folder.id === item.place.id)?.root ?? "";
  }

  async function openRecent(item: RecentItem) {
    if (fixtureMode) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    try {
      const action = nativeOpenLabel({ name: item.name, path: item.path, kind: "file" }).office ? "open-native" : "open";
      if (item.place.kind === "connected-folder") await window.ampleFileDesktop?.connectedFolder.openPath(item.place.id, item.path, action);
      else await window.ampleFileDesktop?.standardFolder?.openPath(item.place.id, item.path, action);
    } catch (caught) {
      onError(desktopErrorText(errorText(caught)));
    }
  }

  /** ⌘↑ from Recents: the file in its own folder, selected. */
  function showRecentInFolder(item: RecentItem) {
    const switchTo = item.place.kind === "connected-folder" ? connectedFolders.find((wf) => wf.id === item.place.id) : undefined;
    navigate({ place: item.place, path: parentPath(item.path) }, "push", switchTo);
    window.setTimeout(() => select([item.path]), 0);
  }

  function handleRecentsKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = recents ?? [];
    const command = mac ? event.metaKey : event.ctrlKey;
    const index = recentSelection ? items.findIndex((item) => recentKey(item) === recentSelection) : -1;
    const chosen = index >= 0 ? items[index] : undefined;
    if (event.key === "ArrowDown" && !command || event.key === "ArrowUp" && !command) {
      event.preventDefault();
      if (!items.length) return;
      const next = index < 0 ? 0 : Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
      setRecentSelection(recentKey(items[next]!));
      return;
    }
    if (chosen && (event.key === "Enter" || (command && event.key === "ArrowDown"))) { event.preventDefault(); void openRecent(chosen); return; }
    if (chosen && command && event.key === "ArrowUp") { event.preventDefault(); showRecentInFolder(chosen); return; }
  }

  /** The receipt's Undo: History puts back what the Worker's reply changed; ⇧⌘Z redoes it. */
  async function undoWorkerChanges() {
    if (!connectedFolder || !workerChanges) return;
    if (fixtureMode) { showToast({ text: "Restoring is disabled in the preview", tone: "info" }); return; }
    const entry = changes.restorePointsUndo("the Worker’s changes", [{ connectedFolderId: connectedFolder.id, checkpointId: workerChanges.checkpointId }]);
    try {
      const redo = await entry.run();
      if (redo) changes.recordRedo(redo);
      worker.done();
      await listing.refresh();
      showToast({ text: "Undid the Worker’s changes", tone: "success" });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /** The Worker that looks when search asks: the Connected Folder shown, else, searching every Connected Folder, the one this window opened in. A plain folder has no Worker to ask. */
  const askConnectedFolder = connectedFolder ?? (searchScope === "all" ? activeConnectedFolder : null);

  /** Ask in search: a Chat in the panel asking the Worker to find the file by what the person remembers. */
  function askToFind(text: string) {
    if (!askConnectedFolder || !text) return;
    const everywhere = searchScope === "all";
    const message = everywhere
      ? `Find this for me: “${text}”. Look through the files here (names and contents, including subfolders) and tell me which files match, with their paths. If it might be in another Connected Folder, say which.`
      : `Find this for me: “${text}”. Look through the files ${location.path ? `in ${location.path}` : "here"} (names and contents, including subfolders) and tell me which files match, with their paths.`;
    setQuery("");
    if (askConnectedFolder.id !== connectedFolder?.id) navigate({ place: { kind: "connected-folder", id: askConnectedFolder.id }, path: "" }, "push", askConnectedFolder);
    setPanelOpen(true);
    withAi(() => {
      const id = Date.now();
      setPanelChat({ key: id, connectedFolderId: askConnectedFolder.id, conversationId: null, activeId: null, title: `Find “${text.length > 30 ? `${text.slice(0, 28)}…` : text}”`, sendRequest: { id, text: message, paths: [] }, open: true });
    });
  }

  /** Open a search result: a folder here, a file in its default app. */
  async function openSearchResult(result: FileManagerSearchResult) {
    // A result in a Standard Folder or the computer place: a folder opens there, a file in its default app.
    if (result.place) {
      if (result.kind === "folder") { setQuery(""); navigate({ place: result.place, path: result.path }); return; }
      await openLocal(result.path, nativeOpenLabel({ name: result.name, path: result.path, kind: "file" }).office ? "open-native" : "open");
      return;
    }
    const target = connectedFolders.find((item) => item.id === result.connectedFolderId);
    if (!target) return;
    if (result.kind === "folder") {
      setQuery("");
      navigate({ place: { kind: "connected-folder", id: target.id }, path: result.path });
      return;
    }
    if (fixtureMode) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    const files = window.ampleFileDesktop?.connectedFolder;
    if (!files) { showToast({ text: "Opening files is available in the Mac app", tone: "info" }); return; }
    try {
      await files.openPath(target.id, result.path, nativeOpenLabel({ name: result.name, path: result.path, kind: "file" }).office ? "open-native" : "open");
    } catch (caught) {
      onError(desktopErrorText(errorText(caught)));
    }
  }

  function handleSearchKey(event: KeyboardEvent<HTMLDivElement>) {
    const command = mac ? event.metaKey : event.ctrlKey;
    const keys = search.results.map((result) => result.key);
    const index = searchSelection ? keys.indexOf(searchSelection) : -1;
    const chosen = index >= 0 ? search.results[index] : undefined;
    if ((command && event.key === "ArrowDown") || event.key === "Enter") {
      event.preventDefault();
      if (chosen) void openSearchResult(chosen);
      // With nothing chosen, Return asks the Worker to find it.
      else if (event.key === "Enter" && askConnectedFolder && query.trim()) askToFind(query.trim());
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!keys.length) return;
      const next = index < 0 ? (event.key === "ArrowDown" ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
      setSearchSelection(keys[next]!);
      window.requestAnimationFrame(() => contentRef.current?.querySelector<HTMLElement>(`[data-fm-result="${cssEscape(keys[next]!)}"]`)?.scrollIntoView({ block: "nearest" }));
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); if (searchSelection) setSearchSelection(null); else setQuery(""); }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Enter and Space belong to a control inside the list (a sort header, Ask
    // the Worker), never to the selection behind it.
    const onControl = event.target !== event.currentTarget && Boolean((event.target as HTMLElement).closest?.("button, a[href], input, textarea, select, [contenteditable='true']"));
    if (onControl && (event.key === "Enter" || event.key === " ")) return;
    if (searchMode) { handleSearchKey(event); return; }
    if (recentsOpen) { handleRecentsKey(event); return; }
    const command = mac ? event.metaKey : event.ctrlKey;
    const current = focusPath ? order.indexOf(focusPath) : -1;
    const move = (step: number) => {
      event.preventDefault();
      if (!order.length) return;
      const next = current < 0 ? (step > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, current + step));
      const path = order[next]!;
      if (event.shiftKey) select(rangeSelection(order, anchorRef.current ?? focusPath ?? path, path), anchorRef.current ?? focusPath ?? path);
      else select([path]);
    };
    // Finder's Copy, Cut, Paste, Move Item Here (⌥⌘V), and Duplicate; codes, since ⌥ changes the letter.
    if (command && !event.shiftKey && letterKey(event, "c")) { event.preventDefault(); clipboard.noteClipboardKey(); void clipboard.copySelection(); return; }
    if (command && !event.shiftKey && !event.altKey && letterKey(event, "x")) { event.preventDefault(); clipboard.noteClipboardKey(); void clipboard.cutSelection(); return; }
    if (command && !event.shiftKey && letterKey(event, "v")) { event.preventDefault(); clipboard.noteClipboardKey(); void clipboard.pasteInto(location.path, event.altKey ? "move" : "copy"); return; }
    if (command && !event.shiftKey && letterKey(event, "d")) { event.preventDefault(); void duplicateSelection(); return; }
    if (command && event.key === "ArrowDown") { event.preventDefault(); const entry = focusPath ? byPath.get(focusPath) : null; if (entry && selection.length === 1) void openEntry(entry); return; }
    if (command && event.key === "ArrowUp") { event.preventDefault(); goToEnclosingFolder(); return; }
    if (command && event.key === "[") { event.preventDefault(); goBack(); return; }
    if (command && event.key === "]") { event.preventDefault(); goForward(); return; }
    if (command && (event.key === "a" || event.key === "A")) { event.preventDefault(); select([...order], order[0] ?? null); return; }
    if (command && event.key === "Backspace") { event.preventDefault(); void deletePaths(selection.filter((path) => byPath.has(path))); return; }
    if (event.key === "ArrowDown") return move(view === "icons" ? iconColumns() : 1);
    if (event.key === "ArrowUp") return move(view === "icons" ? -iconColumns() : -1);
    if (event.key === "ArrowRight" && view === "icons") return move(1);
    if (event.key === "ArrowLeft" && view === "icons") return move(-1);
    if (event.key === " ") { event.preventDefault(); quickLook(focusPath); return; }
    if (event.key === "Enter" && selection.length === 1) { event.preventDefault(); requestRename(byPath.get(selection[0]!)); return; }
    if (event.key === "Escape" && previewShown) { event.preventDefault(); setPreviewOpen(false); return; }
    if (event.key === "Escape") { if (selection.length) { event.preventDefault(); select([]); } return; }
    if (!command && !event.altKey && event.key.length === 1 && /\S/.test(event.key)) {
      const typed = typeSelectRef.current;
      typed.text += event.key;
      if (typed.timer !== null) window.clearTimeout(typed.timer);
      typed.timer = window.setTimeout(() => { typed.text = ""; typed.timer = null; }, typeSelectResetMs);
      const match = typeSelectMatch(visible, typed.text, focusPath);
      if (match) { event.preventDefault(); select([match]); }
    }
  }

  /** A Connected Folder's folder look: its color, and the icon chosen in Customize, if one was. */
  function folderLook(target: ConnectedFolderSummary): FolderLook {
    const identity = resolveIdentity(target, customizations);
    return { color: identity.color, symbol: customizations[target.id]?.iconName ? identity.Icon : null };
  }

  /** A nested Connected Folder's row is drawn as that Connected Folder's folder. */
  function nestedTint(entry: TreeEntry): FolderLook | undefined {
    const nested = nestedConnectedFolder(entry);
    return nested ? folderLook(nested) : undefined;
  }

  const placeIdentity = connectedFolder ? resolveIdentity(connectedFolder, customizations) : null;
  const single = selected.size === 1 ? byPath.get([...selected][0]!) ?? null : null;
  // Search names and contents (the design's search): in the folder shown, or every Connected Folder.
  // Recents and search results take the list's place by settling in.
  const swapMotionRef = useRef({ recentsOpen, searching });
  useEffect(() => {
    const previous = swapMotionRef.current;
    swapMotionRef.current = { recentsOpen, searching };
    if (previous.recentsOpen !== recentsOpen || previous.searching !== searching) settleIn([contentRef.current]);
  }, [recentsOpen, searching]);
  const previewEntry = builtInPreview && previewOpen && !searchMode && !recentsOpen && focusPath ? byPath.get(focusPath) ?? null : null;
  const previewShown = Boolean(previewEntry);
  // Nothing left to show (the selection was cleared, a search or Recents took the list): the Preview is put away.
  useEffect(() => { if (previewOpen && !previewShown) setPreviewOpen(false); }, [previewOpen, previewShown]);
  const closePreview = () => { setPreviewOpen(false); contentRef.current?.focus({ preventScroll: true }); };
  const connectedFolderSearch = useFileManagerSearch({ query, scope: searchScope, here: connectedFolder ? { connectedFolder, path: location.path } : null, connectedFolders, enabled: searchMode && !plainSearch, fixture: fixture ? { trees: fixture.trees, fileContents: fixture.fileContents } : null });
  const plainFolderSearch = usePlainFolderSearch({ query, place, path: location.path, includeHidden: showHidden, enabled: searchMode && plainSearch, fixtureTree: fixture && place.kind === "standard" ? standard.fixtureTrees?.[place.id] ?? [] : null });
  const search = plainSearch
    ? { results: plainFolderSearch.results, status: plainFolderSearch.status === "done" || plainFolderSearch.status === "error" ? "done" as const : "searching" as const }
    : connectedFolderSearch;
  const searchChosen = searchMode && searchSelection ? search.results.find((result) => result.key === searchSelection) ?? null : null;
  const searchChosenConnectedFolder = searchChosen ? connectedFolders.find((item) => item.id === searchChosen.connectedFolderId) ?? null : null;
  useEffect(() => { setSearchSelection(null); }, [query, searchScope]);
  const recentChosen = recentsOpen && recentSelection ? (recents ?? []).find((item) => recentKey(item) === recentSelection) ?? null : null;
  const crumbs = trashOpen
    ? [{ label: "Trash", path: null, nativePath: "" }]
    : recentsOpen && !searchMode
    ? recentChosen
      ? fileManagerPathBar(recentRoot(recentChosen), parentPath(recentChosen.path), recentChosen.name).map((crumb) => ({ ...crumb, path: null }))
      : [{ label: "Recents", path: null, nativePath: "" }]
    : searchMode
    ? searchChosen && searchChosen.place
      ? fileManagerPathBar(placeRoot, parentPath(searchChosen.path), searchChosen.name).map((crumb) => ({ ...crumb, path: null }))
      : searchChosen && searchChosenConnectedFolder
      ? fileManagerPathBar(searchChosenConnectedFolder.connectedFolderRoot, parentPath(searchChosen.path), searchChosen.name).map((crumb) => ({ ...crumb, path: null }))
      : [{ label: searchScope === "here" ? `Searching “${folderName}”` : "Searching all Connected Folders", path: null, nativePath: "" }]
    : fileManagerPathBar(placeRoot, location.path, single?.name);
  const status = listing.status;
  const statusText = trashOpen
    ? trashCount === null ? "Loading…" : fileManagerStatusText(trashCount, trashSelection.length)
    : recentsOpen && !searchMode
    ? recents ? fileManagerStatusText(recents.length, recentChosen ? 1 : 0) : "Loading…"
    : searchMode
    ? search.status === "done" ? fileManagerStatusText(search.results.length, searchChosen ? 1 : 0) : "Searching…"
    : status === "ready" ? fileManagerStatusText(visible.length, selected.size) : "";
  const sidebarStandard = sidebarStandardFolders(standard.folders, connectedFolders);
  const columns: ReadonlyArray<{ key: FileManagerSortKey; label: string }> = [
    { key: "name", label: "Name" },
    { key: "modified", label: "Date Modified" },
    { key: "size", label: "Size" },
    { key: "kind", label: "Kind" },
  ];
  const isCurrent = (candidate: FileManagerPlace) => !recentsOpen && !trashOpen && samePlace(candidate, place);
  // The path bar adds the free space on the folder's drive, as Finder's status bar does.
  const volumeSpace = useVolumeSpace(trashOpen || recentsOpen ? null : place, location.path, listing.changeCount, fixtureMode);
  const statusLine = trashOpen || recentsOpen || searchMode || status !== "ready" ? statusText : statusWithSpace(statusText, volumeSpace);
  const sidebarDrives = useMemo(() => driveRows(drives.volumes, computerName()), [drives.volumes]);
  const currentDrive = recentsOpen || trashOpen ? null : currentDriveKey(sidebarDrives, location);
  const folderSizes = useRememberedFolderSizes(place, order);
  const activity = useFileManagerActivity(connectedFolders, fixtureMode, panelChat?.open && panelChat.activeId ? chatActivityKey(panelChat.connectedFolderId, panelChat.activeId) : null);
  // Another Connected Folder's folder inside this one belongs to its own Worker.
  // A reply that ran in the background (an Automation, another window) settles here too.
  const runningHere = connectedFolder ? activity.folderStatuses[connectedFolder.id] === "running" : false;
  const worker = useWorkerChanges(connectedFolder, fixture, `${turnsSettled}:${runningHere}`);
  const workerChanges = runningHere ? null : worker.changes;
  const markedPaths = workerChanges?.paths ?? null;
  // Rows are memoised on their entry; the day keeps "Today at…" true after midnight.
  const calendarDay = useCalendarDay();

  // Row handlers stay the same object for the window's life, so a selection
  // change re-renders only the rows whose own state changed.
  const entryHandlersRef = useRef<EntryHandlers | null>(null);
  entryHandlersRef.current = {
    click: clickEntry,
    // ⌘-double-click (Ctrl elsewhere) on a folder opens it in a new tab, as in Finder; a plain double-click opens it here.
    open: (entry, event) => { if (event && (mac ? event.metaKey : event.ctrlKey) && folderLocationOf(entry)) openEntryInNewTab(entry); else void openEntry(entry); },
    contextMenu: (entry, event) => void openContextMenu(entry, event),
    dragStart: drops.startDrag,
  };
  const entryHandlers = useMemo<EntryHandlers>(() => ({
    click: (entry, event) => entryHandlersRef.current!.click(entry, event),
    open: (entry, event) => entryHandlersRef.current!.open(entry, event),
    contextMenu: (entry, event) => entryHandlersRef.current!.contextMenu(entry, event),
    dragStart: (entry, event) => entryHandlersRef.current!.dragStart(entry, event),
  }), []);

  // Suggestions written from the folder, when AI is connected; the plain ones cover a selection and the wait.

  // The message box's references: never a nested Connected Folder or a link.
  const references = [
    ...selectedShown.filter((entry) => !entry.nestedFolder && !entry.link),
    ...attachedPaths.filter((path) => !selected.has(path)).map((path) => byPath.get(path) ?? { name: path.slice(path.lastIndexOf("/") + 1), path, kind: "file" as const }),
  ];
  const composerPlaceholder = references.length === 1
    ? `Work on this ${references[0]!.kind === "folder" ? "folder" : "file"}`
    : references.length > 1 ? `Work on these ${references.length} items` : `Work in ${folderName}`;
  const chatConnectedFolder = panelChat ? connectedFolders.find((item) => item.id === panelChat.connectedFolderId) ?? null : null;
  // Set Up for Me is offered once, at the top of a Connected Folder just connected, until it is answered.
  const setUpOffered = Boolean(connectedFolder && setUpOffers.includes(connectedFolder.id)) && !location.path && !searchMode && !recentsOpen && !selection.length;
  // Every tab's Chat, in tab order, each in its own Connected Folder.
  const tabChats = folderTabs.tabs.flatMap((tab) => {
    const chat = folderTabs.chats[tab.id];
    const folder = chat ? connectedFolders.find((item) => item.id === chat.connectedFolderId) : undefined;
    return chat && folder ? [{ tab, chat, folder }] : [];
  });
  // The strip: each tab's title, with enough of the path to tell two same-named folders apart.
  const tabNamings = folderTabs.tabs.map(tabNaming);
  const tabTitles = folderTabTitles(tabNamings);
  const tabItems: FolderTabItem[] = folderTabs.tabs.map((tab, index) => ({ id: tab.id, title: tabTitles[index]!, detail: tabNamings[index]!.detail, takesDrop: tab.view === "folder" }));

  return <div className="fm-shell" data-view={view} ref={shellRef} style={{ [sidebarWidthSpec.property]: `${sidebarWidth}px`, [panelWidthSpec.property]: `${panelWidth}px` } as CSSProperties}>
    <FileManagerSidebar
      connectedFolders={connectedFolders}
      shownConnectedFolder={connectedFolder}
      standardFolders={sidebarStandard}
      recentsOpen={recentsOpen}
      trashOpen={trashOpen}
      atPlaceTop={!location.path}
      isCurrent={isCurrent}
      folderStatuses={activity.folderStatuses}
      folderLook={folderLook}
      drives={sidebarDrives}
      currentDrive={currentDrive}
      ejecting={ejecting}
      drop={{ over: drops.sidebarDrop, dragOver: drops.sidebarDragOver, dragLeave: () => drops.setSidebarDrop(null), drop: (target, name, event) => void drops.sidebarDropInto(target, name, event) }}
      onOpenRecents={() => void openRecents()}
      onOpenTrash={openTrash}
      onAddStandardFolder={() => void addStandardFolder()}
      onOpenPlace={(target) => navigate({ place: target, path: "" })}
      onStandardFolderMenu={menus.openStandardFolderMenu}
      onAddConnectedFolderMenu={menus.openAddConnectedFolderMenu}
      onConnectedFolderMenu={(item, event) => void openActionMenu(item, event, { sidebar: true })}
      isNewTabClick={(event) => mac ? event.metaKey : event.ctrlKey}
      onOpenInNewTab={(target, options) => target === "recents" || target === "trash" ? openInNewTab(history.location, target, options) : openInNewTab(target, "folder", options)}
      onOpenDrive={openDrive}
      onEjectDrive={(row) => void ejectDrive(row)}
      foot={onUpdateAction ? <UpdateIndicator status={updateStatus} onUpdateAction={onUpdateAction} onOpenAbout={() => onOpenSettings("about")} /> : null}
    />

    <PaneResizer spec={sidebarWidthSpec} side="left" width={sidebarWidth} label="Resize the sidebar" shellRef={shellRef} otherPaneWidth={panelOpen ? panelWidth : 0} onCommit={setSidebarWidth} />
    <section className="fm-main" aria-label={folderName} ref={mainRef} data-browser={browserLayout} style={{ "--fm-browser-fraction": browserFraction } as CSSProperties}>
      <header className="fm-toolbar">
        <div className="fm-capsule">
          <button type="button" className="fm-tool" onClick={goBack} disabled={!canGoBack} aria-label="Back" title="Back"><ChevronLeft size={16} /></button>
          <button type="button" className="fm-tool" onClick={goForward} disabled={!canGoForward} aria-label="Forward" title="Forward"><ChevronRight size={16} /></button>
        </div>
        <h1 className="fm-title">
          {trashOpen ? <span className="fm-title-glyph" aria-hidden="true"><TrashGlyph /></span> : recentsOpen ? <span className="fm-title-glyph" aria-hidden="true"><RecentsGlyph /></span> : !location.path && connectedFolder ? <TintedFolder {...folderLook(connectedFolder)} /> : <span className="fm-ic fm-ic-folder" aria-hidden="true" />}
          <span className="fm-title-text">{trashOpen ? "Trash" : recentsOpen ? "Recents" : folderName}</span>
        </h1>
        <div className="fm-toolbar-space" />
        <div className="fm-capsule" role="group" aria-label="View">
          <button type="button" className={`fm-tool${view === "icons" ? " is-on" : ""}`} aria-pressed={view === "icons"} aria-label="Icons" title="Icons" onClick={() => setView("icons")}><Grid20Regular /></button>
          <button type="button" className={`fm-tool${view === "list" ? " is-on" : ""}`} aria-pressed={view === "list"} aria-label="List" title="List" onClick={() => setView("list")}><TextBulletListLtr20Regular /></button>
        </div>
        <div className="fm-capsule">
          <button type="button" className="fm-tool" aria-label="Action" title="Action" aria-haspopup="menu" onClick={(event) => void openActionMenu(connectedFolder, event)}><MoreHorizontal20Regular /></button>
        </div>
        {browser.available ? <div className="fm-capsule">
          <button type="button" className={`fm-tool${browserShown ? " is-on" : ""}`} aria-pressed={browserShown} aria-label="Browser" title={browserShown ? "Hide Browser" : "Show Browser"} onClick={toggleBrowser}><Globe20Regular /></button>
        </div> : null}
        <label className="fm-search">
          <Search size={14} />
          <input ref={searchFieldRef} type="search" value={query} placeholder="Search names and contents" aria-label={`Search ${folderName}`} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); contentRef.current?.focus(); } }} />
          {query ? <button type="button" className="fm-search-clear" aria-label="Clear search" onClick={() => { setQuery(""); contentRef.current?.focus(); }}><X size={12} /></button> : null}
        </label>
        {/* The last control, nearest the panel it shows and hides. */}
        <div className="fm-capsule">
          <button type="button" className={`fm-tool${panelOpen ? " is-on" : ""}`} aria-pressed={panelOpen} aria-label="Show or hide the panel" title={panelOpen ? "Hide Panel" : "Show Panel"} onClick={() => setPanelOpen(!panelOpen)}><PanelRight20Regular /></button>
        </div>
      </header>
      {/* The folder's half of the main area. With the browser given the whole area it folds away, still mounted. */}
      <div className="fm-files" inert={browserLayout === "full"}>
      {folderTabs.stripShown ? <FolderTabStrip
        tabs={tabItems}
        activeId={tabId}
        onSelect={showTab}
        onClose={closeTab}
        onNew={newTab}
        onMove={folderTabs.move}
        isItemDrag={isItemDrag}
        onItemDragOver={tabDragOver}
        onItemDrop={(id, event) => void tabDrop(id, event)}
      /> : null}
      {searching && !trashOpen ? <div className="fm-scope" role="group" aria-label="Search">
        <span>Search:</span>
        {connectedFolders.length ? <button type="button" className={`fm-pill${searchScope === "all" ? " is-on" : ""}`} aria-pressed={searchScope === "all"} onClick={() => setSearchScope("all")}>All Connected Folders</button> : null}
        <button type="button" className={`fm-pill${searchScope === "here" ? " is-on" : ""}`} aria-pressed={searchScope === "here"} onClick={() => setSearchScope("here")} title={folderName}>“{folderName}”</button>
      </div> : null}

      {trashOpen ? <TrashView key={tabId} fixtureMode={fixtureMode} query={query} onShow={(next, selectPath) => showLocation(next, selectPath)} onSelectionChange={setTrashSelection} onCount={setTrashCount} onError={onError} runDeletion={runTrashDeletion} /> : null}
      <div
        className={`fm-content${searchMode ? " is-search" : ""}${dropTarget === location.path ? " is-drop-target" : ""}`}
        ref={contentRef}
        hidden={trashOpen}
        onDragOver={drops.dragOverList}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
        onDrop={(event) => void drops.dropOnList(event)}
        tabIndex={0}
        role="grid"
        aria-label={`${folderName} contents`}
        aria-multiselectable="true"
        aria-activedescendant={recentsOpen && !searchMode ? (recentSelection ? listItemDomId("recent", recentSelection) : undefined)
          : searchMode ? (searchSelection ? listItemDomId("result", searchSelection) : undefined)
          : focusPath ? rowDomId(focusPath) : undefined}
        onKeyDown={handleKeyDown}
        onMouseDown={startBand}
        onClick={(event) => { if (!bandJustEnded() && !(event.target as HTMLElement).closest("[data-fm-path]")) select([]); }}
        onContextMenu={(event) => { if (!(event.target as HTMLElement).closest("[data-fm-path]")) void openContextMenu(null, event); }}
        // A middle click on a folder opens it in a new tab behind this one, as GNOME Files and browsers do.
        onAuxClick={(event) => {
          if (event.button !== 1 || searchMode || recentsOpen) return;
          const row = (event.target as HTMLElement).closest<HTMLElement>("[data-fm-path]");
          const entry = row ? byPath.get(row.dataset.fmPath ?? "") : undefined;
          if (!entry || !folderLocationOf(entry)) return;
          event.preventDefault();
          openEntryInNewTab(entry, { behind: true });
        }}
      >
        {recentsOpen && !searchMode ? <>
          <div className="fm-list-head" role="row">
            <span role="columnheader" className="fm-col fm-col-name">Name</span>
            <span role="columnheader" className="fm-col fm-col-match">Date Modified</span>
            <span role="columnheader" className="fm-col fm-col-where">Where</span>
          </div>
          {recents === null ? <p className="fm-empty">Loading…</p> : !recents.length ? <p className="fm-empty">Nothing has changed in the last 30 days.</p> : null}
          <div className="fm-rows" role="rowgroup">
            {(recents ?? []).map((item, index) => {
              const key = recentKey(item);
              const entry: TreeEntry = { name: item.name, path: item.path, kind: "file", ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}) };
              return <div
                key={key}
                id={listItemDomId("recent", key)}
                role="row"
                aria-selected={recentSelection === key}
                className={`fm-row${index % 2 ? " is-odd" : ""}${recentSelection === key ? " is-selected" : ""}`}
                title={`${item.where} › ${item.path}`}
                onClick={(event) => { event.stopPropagation(); contentRef.current?.focus({ preventScroll: true }); setRecentSelection(key); }}
                onDoubleClick={() => void openRecent(item)}
              >
                <span role="gridcell" className="fm-cell fm-col-name">
                  <span className="fm-row-icon"><EntryIcon entry={entry} /></span>
                  <span className="fm-row-name">{item.name}</span>
                </span>
                <span role="gridcell" className="fm-cell fm-col-match">{formatFileManagerDate(item.updatedAt)}</span>
                <span role="gridcell" className="fm-cell fm-col-where" title={item.where}>{item.where}</span>
              </div>;
            })}
          </div>
        </> : searchMode ? <>
          <div className="fm-list-head" role="row">
            <span role="columnheader" className="fm-col fm-col-name">Name</span>
            <span role="columnheader" className="fm-col fm-col-match">Match</span>
            <span role="columnheader" className="fm-col fm-col-where">{plainSearch ? "Where" : "Connected Folder"}</span>
          </div>
          {plainSearch && plainFolderSearch.status === "error" ? <div className="fm-empty">
            <span className="fm-empty-text">{plainFolderSearch.error ?? "Couldn’t search this folder."}</span>
          </div> : search.status === "done" && !search.results.length && !(plainSearch && plainFolderSearch.stoppedEarly) ? <p className="fm-empty">No names or text match “{query.trim()}”</p> : null}
          <div className="fm-rows" role="rowgroup">
            {search.results.map((result, index) => {
              const entry: TreeEntry = { name: result.name, path: result.path, kind: result.kind, ...(result.sizeBytes !== undefined ? { sizeBytes: result.sizeBytes } : {}) };
              const where = result.place ? { name: [placeName, ...result.path.split("/").slice(0, -1)].join(" › ") } : connectedFolders.find((item) => item.id === result.connectedFolderId);
              return <div
                key={result.key}
                id={listItemDomId("result", result.key)}
                role="row"
                aria-selected={searchSelection === result.key}
                data-fm-result={result.key}
                className={`fm-row${index % 2 ? " is-odd" : ""}${searchSelection === result.key ? " is-selected" : ""}`}
                onClick={(event) => { event.stopPropagation(); contentRef.current?.focus({ preventScroll: true }); setSearchSelection(result.key); }}
                onDoubleClick={() => void openSearchResult(result)}
              >
                <span role="gridcell" className="fm-cell fm-col-name">
                  <span className="fm-row-icon"><EntryIcon entry={entry} /></span>
                  <span className="fm-row-name" title={result.path}>{result.name}</span>
                </span>
                <span role="gridcell" className={`fm-cell fm-col-match${result.match.kind === "name" ? " is-name" : ""}`}>
                  {result.match.kind === "name" ? "Name" : <>{result.match.pre}{result.match.hit ? <mark>{result.match.hit}</mark> : null}{result.match.post}</>}
                </span>
                <span role="gridcell" className="fm-cell fm-col-where" title={where?.name}>{where?.name ?? ""}</span>
              </div>;
            })}
          </div>
          {/* A plain folder's search reads a bounded amount at a time: it says when it stopped early, and goes on when asked. */}
          {plainSearch && plainFolderSearch.stoppedEarly ? <p className="fm-search-note" role="status">
            <span>{stoppedEarlyText(plainFolderSearch.stoppedEarly, plainFolderSearch.scannedFiles)}</span>
            <button type="button" className="fm-text-button" disabled={plainFolderSearch.status === "searching"} onClick={plainFolderSearch.continueSearch}>{plainFolderSearch.status === "searching" ? "Searching…" : "Keep Searching"}</button>
          </p> : null}
          {plainSearch && plainFolderSearch.status === "done" && plainFolderSearch.incomplete ? <p className="fm-search-note">Some folders couldn’t be read, so they weren’t searched.</p> : null}
          {plainSearch && plainFolderSearch.connectedFoldersInside.length ? <p className="fm-search-note">
            <span>{plainFolderSearch.connectedFoldersInside.length === 1 ? "A Connected Folder inside is searched with its own rules." : "Connected Folders inside are searched with their own rules."}</span>
            <button type="button" className="fm-text-button" onClick={() => setSearchScope("all")}>Search All Connected Folders</button>
          </p> : null}
          {/* Ask in search: the Worker looks for it by meaning, not only by name or text. */}
          {search.status === "done" && askConnectedFolder ? <button type="button" className="fm-ask-row" onClick={() => askToFind(query.trim())}>
            <span className="fm-ask-icon" aria-hidden="true"><Sparkle16Regular /></span>
            <span className="fm-ask-text">Ask {askConnectedFolder.name === folderName ? "the Worker" : `the ${askConnectedFolder.name} Worker`} to find “{query.trim()}”</span>
            <span className="fm-ask-hint">Return</span>
          </button> : null}
        </> : <>
        {view === "list" ? <div className="fm-list-head" role="row">
          {columns.map((column) => <button
            key={column.key}
            type="button"
            role="columnheader"
            className={`fm-col fm-col-${column.key}${sort.key === column.key ? " is-sorted" : ""}`}
            aria-sort={sort.key === column.key ? (sort.ascending ? "ascending" : "descending") : "none"}
            // Like Finder's, a header clicked with the mouse puts focus on the
            // list (from the search field or message box too), so Return and
            // Space act on the selection; Tab still reaches the header.
            onMouseDown={(event) => { event.preventDefault(); contentRef.current?.focus({ preventScroll: true }); }}
            onClick={() => setSort(nextFileManagerSort(sort, column.key))}
          >
            <span>{column.label}</span>
            {sort.key === column.key ? (sort.ascending ? <ChevronUp16Regular className="fm-sort-arrow" /> : <ChevronDown16Regular className="fm-sort-arrow" />) : null}
          </button>)}
        </div> : null}

        {status === "loading" && !visible.length ? <p className="fm-empty">Loading…</p> : null}
        {status === "error" ? <div className="fm-empty">
          <span className="fm-empty-text">{listing.error ?? "Couldn’t load this folder."}</span>
          <button type="button" className="fm-text-button" onClick={() => void listing.refresh()}>Try Again</button>
        </div> : null}
        {status === "ready" && !visible.length ? <p className="fm-empty">{query.trim() ? `No items match “${query.trim()}”` : "This folder is empty."}</p> : null}

        {visible.length ? <FileEntries
          view={view}
          entries={visible}
          selected={selected}
          focusPath={focusPath}
          dropTarget={dropTarget !== location.path ? dropTarget : null}
          markedPaths={markedPaths}
          cutPaths={cutItems && samePlace(cutItems.place, place) ? cutItems.paths : null}
          kindLabel={kindLabel}
          day={calendarDay}
          tintFor={nestedTint}
          handlers={entryHandlers}
          scrollRef={contentRef}
          layoutRef={entriesLayoutRef}
          thumbnailPlace={fixtureMode ? null : place}
          folderSizes={folderSizes}
        /> : null}
        </>}
        <div className="fm-band" ref={bandRef} aria-hidden="true" />
        {listing.truncated && !searchMode && !recentsOpen ? <p className="fm-note">Some items are not shown. This folder holds more than the {folderListingMaxEntries.toLocaleString()} items AmpleFile lists at once.</p> : null}
      </div>

      {/* Copies, moves, Compresses, and Extracts that take a moment: progress and Stop, while the folder stays usable. */}
      <FileOperationsTray operations={fileOperations.shown} onStop={(id) => { void fileOperations.stop(id).then((problem) => { if (problem) onError(problem); }); }} />
      {/* Finder's path bar: click an item to copy its path, double-click a folder to open it; ⇧⌘G goes anywhere by path. */}
      <footer className="fm-pathbar">
        <button type="button" className="fm-goto-button" title={`Go to Folder… (${desktopShortcutText([desktopShortcutModifierKey(), "Shift", "G"])})`} aria-label="Go to Folder" onClick={() => setGoToOpen(true)}><FolderArrowRight16Regular /></button>
        <nav className="fm-crumbs" aria-label="Path">
          {collapseCrumbs(crumbs).map((crumb, index, shown) => <span className={`fm-crumb-wrap${index === shown.length - 1 ? " is-last" : ""}`} key={`${index}:${crumb.label}`}>
            {index ? <ChevronRight size={10} className="fm-crumb-sep" aria-hidden="true" /> : null}
            <button
              type="button"
              className="fm-crumb"
              disabled={!crumb.nativePath}
              title={crumb.nativePath ? `${crumb.hidden ? crumb.hidden.join(" › ") : crumb.nativePath}\nClick to copy the path${!searchMode && (crumb.path !== null || (!crumb.hidden && !recentsOpen)) ? " · Double-click to open" : ""}` : undefined}
              onClick={() => void copyNativePath(crumb.nativePath)}
              onDoubleClick={() => {
                if (searchMode) return;
                if (crumb.path !== null) navigate({ place, path: crumb.path });
                // A folder above the place's top opens wherever it lives.
                else if (crumb.nativePath && !crumb.hidden && !recentsOpen) void openNativeFolder(crumb.nativePath);
              }}
            >{crumb.label}</button>
          </span>)}
        </nav>
        <span className="fm-status">{statusLine}</span>
      </footer>
      </div>
      {/* The band between the folder and the browser: the slider beside the folder, a plain band over the folded strip. */}
      {browserLayout === "split" ? <BrowserSplitResizer fraction={browserFraction} mainRef={mainRef} onCommit={setBrowserFraction} />
        : browserLayout === "collapsed" ? <div className="fm-browser-divide" aria-hidden="true" /> : null}
      {browserLayout !== "hidden" ? <BrowserPane
        browser={browser}
        layout={browserLayout}
        onLayout={setBrowserLayout}
        onViewing={setBrowserViewingPageId}
        sample={fixtureMode}
        describeWorker={describeBrowserWorker}
        onError={onError}
      /> : null}
    </section>

    {panelOpen ? <PaneResizer spec={panelWidthSpec} side="right" width={panelWidth} label="Resize the panel" shellRef={shellRef} otherPaneWidth={sidebarWidth} onCommit={setPanelWidth} /> : null}
    {panelOpen ? <FileManagerPanel
      arriving={panelArriving}
      infoRequest={infoRequest}
      place={place}
      connectedFolder={connectedFolder}
      placeName={placeName}
      placeRoot={placeRoot}
      folderPath={location.path}
      folderName={folderName}
      folderColor={!location.path && placeIdentity ? placeIdentity.color : null}
      folderSymbol={!location.path && connectedFolder ? folderLook(connectedFolder).symbol : null}
      receipt={trashOpen ? null : setUpOffered && connectedFolder ? <SetUpOffer
        name={connectedFolder.name}
        onSetUp={() => setUp(connectedFolder)}
        onDismiss={() => onCloseSetUpOffer?.(connectedFolder.id)}
      /> : workerChanges && connectedFolder && !searchMode && !recentsOpen && !selection.length ? <WorkerReceipt
        changes={workerChanges}
        onShow={(path) => { const folder = parentPath(path); if (folder !== location.path) navigate({ place: { kind: "connected-folder", id: connectedFolder.id }, path: folder }); window.setTimeout(() => select([path]), folder !== location.path ? 300 : 0); }}
        onUndo={() => void undoWorkerChanges()}
        onDone={worker.done}
      /> : null}
      itemCount={visible.length}
      selection={selectedShown}
      automations={connectedFolder ? folderAutomations.byConnectedFolder[connectedFolder.id] ?? [] : []}
      fixture={fixture}
      chat={tabChats.length ? {
        open: Boolean(panelChat && chatConnectedFolder && panelChat.open),
        title: panelChat?.title ?? "",
        onBack: () => setPanelChat((current) => current ? { ...current, open: false } : current),
        // Each tab's Chat, the tab in front's shown: a reply running in another tab's Chat goes on out of sight.
        content: <>{tabChats.map(({ tab, chat, folder }) => {
          const shownId = chat.activeId ?? chat.conversationId;
          const keyFor = (conversationId: string) => chatActivityKey(chat.connectedFolderId, conversationId);
          return <div key={tab.id} className="fm-tab-chat" hidden={tab.id !== tabId}>
            <ChatPanel
              key={chat.key}
              surfaceTabId={`file-manager:${folder.id}:${tab.id}`}
              connectedFolder={folder}
              connectedFolderCustomizations={customizations}
              modelConfigurationRevision={modelConfigurationRevision}
              // A new Chat hands its id back the way a Chat tab does, so ChatPanel
              // keeps it instead of starting over. The preview's sample Chats are
              // looked up by this id, so there a new one stays untargeted.
              targetConversationId={fixtureMode ? chat.conversationId : chat.activeId ?? chat.conversationId}
              contextPathRequest={null}
              sendRequest={chat.sendRequest}
              variant="panel"
              // The composer's Model Settings opens AI Models for this Worker, with the model in focus.
              onOpenModelSettings={() => onOpenSettings("ai-models", "connected-folder", true, folder.id)}
              fixtureMode={fixtureMode}
              fixtureConversations={chat.conversationId ? fixture?.conversations[folder.id] : undefined}
              fixtureTreeEntries={fixture?.trees[folder.id]}
              onOpenConnectedFolderFile={showChatFile}
              onConversationActivated={(conversation: ConversationSummary | null) => {
                if (!conversation) return;
                folderTabs.setChat(tab.id, (current) => current && current.key === chat.key
                  ? { ...current, activeId: conversation.id, title: chatTitleOrNull(conversation.title) ?? current.title }
                  : current);
              }}
              onRunningChange={(conversationId, running) => activity.setRunning(keyFor(conversationId), running)}
              // A reply that lands in a Chat out of sight (another tab's, or one put away) waits as a new reply.
              onSettled={(conversationId, needsAttention) => { activity.setAttention(keyFor(conversationId), needsAttention && !(tab.id === tabId && chat.open && conversationId === shownId)); setTurnsSettled((value) => value + 1); }}
              onViewed={(conversationId) => activity.setAttention(keyFor(conversationId), false)}
              // A reply can change more than files: a look the Worker applied
              // (Set Up for Me, or a look asked for in words) arrives with the bootstrap read.
              onAgentFinished={() => Promise.all([listing.refresh(), onRefreshBootstrap()]).then(() => undefined)}
            />
          </div>;
        })}</>,
      } : null}
      trashSelection={trashOpen ? trashSelection : null}
      aiConnected={fixtureMode || Boolean(agent?.configured)}
      onSetUpAi={() => requestConnectAi()}
      searchItem={trashOpen ? null : recentChosen && !searchMode ? {
        apiBase: recentChosen.place.kind === "connected-folder" ? `/api/connected-folders/${encodeURIComponent(recentChosen.place.id)}` : `/api/standard-folders/${encodeURIComponent(recentChosen.place.id)}`,
        entry: { name: recentChosen.name, path: recentChosen.path, kind: "file", ...(recentChosen.sizeBytes !== undefined ? { sizeBytes: recentChosen.sizeBytes } : {}), updatedAt: recentChosen.updatedAt },
        where: [recentChosen.where, ...recentChosen.path.split("/").slice(0, -1)].join(" › "),
      } : searchChosen && searchChosen.place ? {
        apiBase: placeApiBase(searchChosen.place),
        entry: { name: searchChosen.name, path: searchChosen.path, kind: searchChosen.kind, ...(searchChosen.sizeBytes !== undefined ? { sizeBytes: searchChosen.sizeBytes } : {}), ...(searchChosen.updatedAt ? { updatedAt: searchChosen.updatedAt } : {}) },
        where: [placeName, ...searchChosen.path.split("/").slice(0, -1)].join(" › "),
      } : searchChosen && searchChosenConnectedFolder ? {
        apiBase: `/api/connected-folders/${encodeURIComponent(searchChosenConnectedFolder.id)}`,
        entry: { name: searchChosen.name, path: searchChosen.path, kind: searchChosen.kind, ...(searchChosen.sizeBytes !== undefined ? { sizeBytes: searchChosen.sizeBytes } : {}), ...(searchChosen.updatedAt ? { updatedAt: searchChosen.updatedAt } : {}) },
        where: [searchChosenConnectedFolder.name, ...searchChosen.path.split("/").slice(0, -1)].join(" › "),
      } : null}
      composer={connectedFolder && !trashOpen ? ({ showSuggestions }) => <SuggestingComposer
        connectedFolderId={connectedFolder.id}
        path={location.path}
        writtenSuggestions={!fixtureMode && Boolean(agent?.configured)}
        showSuggestions={showSuggestions}
        automationsOn={(folderAutomations.byConnectedFolder[connectedFolder.id] ?? []).some((automation) => automation.state === "on" || automation.state === "running")}
        placeholder={composerPlaceholder}
        chips={references}
        modelRow={<WorkerModelRow connectedFolder={connectedFolder} fixtureMode={fixtureMode} revision={modelConfigurationRevision * 2 + (agent?.configured ? 1 : 0)} onOpenModelSettings={() => onOpenSettings("ai-models", "connected-folder", true, connectedFolder.id)} />}
        onRemoveChip={(path) => { setSelection((current) => current.filter((item) => item !== path)); setAttachedPaths((current) => current.filter((item) => item !== path)); }}
        dropActive={drops.composerDrop}
        onDragOverBox={(event) => { if (!connectedFolder || !isItemDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; drops.setComposerDrop(true); }}
        onDragLeaveBox={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) drops.setComposerDrop(false); }}
        onDropBox={(event) => void drops.composerDropFiles(event, (paths) => setAttachedPaths((current) => [...new Set([...current, ...paths])]))}
        onSend={(text) => startChat(text, references)}
      /> : null}
      onPutToWork={() => void putToWork(location.path)}
      chatStatuses={activity.chatStatuses}
      historyRefreshKey={listing.changeCount}
      onOpenChat={openChat}
      onRestored={() => void listing.refresh()}
      onError={onError}
    /> : null}

    {actionMenu ? <ActionMenu menu={actionMenu} onClose={() => setActionMenu(null)} onCommand={menus.runActionCommand} /> : null}
    {customizing && customizingConnectedFolder ? <ConnectedFolderAppearanceModal
      key={customizingConnectedFolder.id}
      connectedFolder={customizingConnectedFolder}
      initialSection={customizing.section}
      identity={resolveIdentity(customizingConnectedFolder, customizations)}
      customization={customizations[customizingConnectedFolder.id]}
      canUndo={connectedFolderCustomizations.canUndo(customizingConnectedFolder.id)}
      onRenameConnectedFolder={renameConnectedFolder}
      onCustomizeConnectedFolder={connectedFolderCustomizations.customize}
      onReplaceConnectedFolder={connectedFolderCustomizations.replace}
      onUndoConnectedFolder={connectedFolderCustomizations.undo}
      onResetConnectedFolder={connectedFolderCustomizations.reset}
      // The file manager draws no banner: its Connected Folders are folders in their color, with their icon.
      preview={<div className="fm-customize-preview"><TintedFolder {...folderLook(customizingConnectedFolder)} /><span title={customizingConnectedFolder.name}>{customizingConnectedFolder.name}</span></div>}
      onOpenWorkerSettings={(section, returnSection) => {
        const target = customizingConnectedFolder;
        setCustomizing(null);
        onOpenSettings("ai-models", "connected-folder", section === "model", target.id, section === "instructions", () => setCustomizing({ connectedFolderId: target.id, section: returnSection }));
      }}
      onClose={() => setCustomizing(null)}
    /> : null}
    {previewEntry ? <FilePreview
      key={`${placeKey(place)}:${previewEntry.path}`}
      apiBase={apiBase}
      entry={previewEntry}
      fixtureMode={fixtureMode}
      fixtureText={fixture && place.kind === "connected-folder" ? fixture.fileContents[place.id]?.[previewEntry.path] : undefined}
      onOpen={() => { const entry = previewEntry; closePreview(); void openEntry(entry); }}
      onClose={closePreview}
    /> : null}
    {goToOpen ? <GoToFolderSheet
      initialPath={`${(location.path ? connectedFolderEntryNativePath(placeRoot, location.path) : placeRoot).replace(/[\\/]+$/, "")}/`}
      currentFolder={location.path ? connectedFolderEntryNativePath(placeRoot, location.path) : placeRoot}
      lookup={lookupPath}
      onGo={goTo}
      onClose={() => { setGoToOpen(false); window.requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true })); }}
    /> : null}
    {quickMenu ? <QuickMenu menu={quickMenu} onClose={() => setQuickMenu(null)} /> : null}
    {skillsFor ? <SkillsExtensionsModal connectedFolder={skillsFor} status={agent} initialView="installed" fixtureMode={fixtureMode} onError={onError} onClose={() => setSkillsFor(null)} /> : null}
    {conflictQuestion.element}
    {renaming ? <TextInputModal title="Rename" label="Name" initialValue={renaming.name} confirmLabel="Rename" onSubmit={(name) => renameEntry(renaming, name)} onClose={() => setRenaming(null)} /> : null}
    {newFolderTarget ? <NewFolderModal target={newFolderTarget} fixtureMode={fixtureMode} onCreated={(folder) => { setNewFolderTarget(null); void listing.refresh().then(() => select([folder.path])); }} onClose={() => setNewFolderTarget(null)} /> : null}
    {newStandardFolderParent !== null ? <TextInputModal title="New Folder" label="Name" initialValue="untitled folder" confirmLabel="Create" onSubmit={(name) => createStandardFolder(newStandardFolderParent, name)} onClose={() => setNewStandardFolderParent(null)} /> : null}
    {versionHistory && connectedFolder ? <FileVersionHistoryModal connectedFolder={connectedFolder} filePath={versionHistory.path} fileName={versionHistory.name} onClose={() => setVersionHistory(null)} onRestored={() => void listing.refresh()} /> : null}
  </div>;
}
