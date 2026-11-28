/**
 * The desktop IPC contract: every channel between the Electron main process
 * (desktop/src/main.ts and the modules it starts), the sandboxed preloads
 * (desktop/src/*.cts), and the renderer (`window.ampleFileDesktop`, typed in
 * web-local/src/desktop.d.ts from `AmpleFileDesktopBridge` below), declared
 * once.
 *
 * - `DesktopInvokeChannels`: renderer → main requests (`ipcRenderer.invoke`,
 *   `ipcMain.handle`), each with its arguments and its answer.
 * - `DesktopSendChannels`: renderer → main messages with no answer
 *   (`ipcRenderer.send`, `ipcMain.on`).
 * - `DesktopEventChannels`: main → renderer notifications
 *   (`webContents.send`, `ipcRenderer.on`).
 *
 * The main process registers handlers through `ipcMain` from
 * desktop/src/desktop-ipc-main.ts, and the preloads view Electron's
 * `ipcRenderer` as `DesktopIpcRenderer`; both are typed by these maps, so a
 * channel renamed, added, or retyped in one place and not the others fails
 * `npm run check`. Handlers still receive their arguments as `unknown` and
 * check them: a renderer is never trusted to have sent what the contract says.
 *
 * This module is types only. The preloads run sandboxed and can require
 * nothing but Electron, so they import it with `import type`.
 */
import type { AutomationDeleteResponse, AutomationDetailResponse, AutomationDisableResponse, AutomationEnableProposalResponse, AutomationEnableResponse, AutomationHistoryResponse, AutomationProposalsResponse, AutomationRunResponse, AutomationsResponse, AutomationStopResponse } from "./automation-settings-view.js";
import type { BrowserCommand, BrowserDownload, BrowserFindResult, BrowserHistoryEntry, BrowserOpenTabCommand, BrowserPageState, BrowserShortcut, BrowserTabMenuCommand, BrowserTabsSync, BrowserViewRequest } from "./browser.js";
import type { ClipboardContent, ClipboardWriter } from "./clipboard.js";
import type { FileMenuCapabilities, FileMenuCommand } from "./file-menu.js";
import type { ConflictPolicy, FileManagerPlace, TransferAnswer } from "./file-transfer.js";
import type { ModelContextDiagnosticsBridge } from "./model-context-diagnostics.js";
import type { RailTooltipRequest } from "./rail-tooltip.js";

// ---------------------------------------------------------------------------
// What crosses the bridge
// ---------------------------------------------------------------------------

export type DesktopUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

/** Where an update stands, from the app's own updater (desktop/src/updater.ts) or, in the Linux build, the system's packages. */
export interface DesktopUpdateStatus {
  supported: boolean;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string;
  error: string | null;
  /**
   * "system" when the computer's package manager installs AmpleFile's
   * updates (a repository-managed Linux RPM; that source is in the Linux build only):
   * "ready" then means the update is already installed and only a restart is
   * left. Absent for the app's own updater.
   */
  updatesFrom?: "app" | "system";
}

/** Saved provider credentials, as far as the window may know: whether they are there, never what they are. */
export interface SecureSettingsStatus {
  encryptionAvailable: boolean;
  configuredProviders: string[];
  /**
   * Saved provider credentials could not be decrypted (for example after the
   * Safe Storage key was reset). They were set aside next to the settings file,
   * never deleted, and the person needs to re-enter their credentials. Derived
   * from the set-aside files, so it survives a restart; it clears once
   * credentials are saved again.
   */
  credentialsNeedReentry: boolean;
}

/** The packaged Pi runtime's health (desktop/src/pi-runtime.ts). */
export interface PiRuntimeHealth {
  ok: boolean;
  configured: boolean;
  version: string;
  message?: string;
}

export interface DesktopRuntimeHealth {
  pi: PiRuntimeHealth;
  settings: SecureSettingsStatus;
}

export type CommandLineSkillTarget = "claude" | "codex";

export interface CommandLineSkillStatus {
  /** The agent's own folder exists on this computer. */
  available: boolean;
  installed: "none" | "current" | "outdated";
  /** Where the skill file goes. */
  path: string;
}

/** Settings → Command Line: the command on Terminal's PATH and the skill file (desktop/src/command-line-install.ts). */
export interface CommandLineStatus {
  command: string;
  path: {
    /** Only an installed Mac app in a fixed place can put its command on the PATH. */
    supported: boolean;
    /** Why not, in plain words, when it can't. */
    reason: string | null;
    state: "installed" | "missing" | "elsewhere";
    binDirectory: string | null;
    entryFile: string;
  };
  skills: Record<CommandLineSkillTarget, CommandLineSkillStatus>;
}

/** What the application menu sends the window it was used in. */
export type RendererMenuCommand =
  | "new-connected-folder"
  | "open-local-folder"
  | "open-terminal"
  | "get-info"
  | "new-chat"
  | "close-tab"
  | "refresh"
  | "check-for-updates"
  | "open-settings"
  | "open-about"
  | "open-capabilities"
  | "open-skills"
  | "open-extensions"
  | "open-command-palette"
  | "open-keyboard-shortcuts"
  | "toggle-hidden-files"
  | "new-tab"
  | "next-tab"
  | "previous-tab"
  | "toggle-tab-bar";

/** A menu of the application menu the window's own menu bar can pop up (Linux and Windows). */
export type ApplicationMenuId = "file" | "edit" | "view" | "help";

/** What the window's menus show while it is the one in front. */
export interface WindowMenuState {
  connectedFolderOpen: boolean;
  /** Show Hidden Files, which the View menu checks. */
  showHiddenFiles: boolean;
  /** The window shows the file manager, with its folder tabs: New Tab, Close Tab, and the tab items act on it. */
  folderTabsOpen: boolean;
  /** On Linux and the Mac, the current tab shows a folder that can be opened in a terminal. */
  terminalFolderOpen?: boolean;
  /** View → Show Tab Bar: the window's folder tab strip shows even with one tab. */
  showTabBar: boolean;
}

/** A place and folder a window shows: the same shape a folder handed to the app opens at. */
export interface WindowLocation {
  place: { kind: "connected-folder" | "standard"; id: string };
  path: string;
  select?: string | null;
  /** Reported only: the tab in front shows the Trash or Recents rather than this folder. */
  view?: "trash" | "recents";
}

/** Where a folder or file handed to AmpleFile opens: a place, the folder shown in it, and an item to select. */
export interface OpenLocation {
  place: { kind: "connected-folder" | "standard"; id: string };
  path: string;
  select: string | null;
}

/** A location handed to one window, which its renderer takes and acknowledges by `token`. */
export interface OpenLocationRequest<Location = OpenLocation> {
  token: string;
  location: Location;
}

export type PathAction = "open" | "open-native" | "reveal";

export interface OpenWithResult {
  opened: boolean;
  canceled: boolean;
  appName: string | null;
}

export interface CloseToTrayStatus {
  supported: boolean;
  enabled: boolean;
}

export interface StandardFolderTrashResult {
  trashed: string[];
  failed: { path: string; error: string } | null;
}

/** An item dropped on or sent to the AmpleFile Agent popover: a path reference or text for its composer. */
export interface AmpleFileAgentStagedItem {
  kind: "path" | "text";
  value: string;
}

/** A Copy (a list of absolute paths), or a Cut, which the host remembers for every window by place. */
export type FileClipboardWriteRequest =
  | string[]
  | { paths: string[]; operation: "cut"; from?: { place: FileManagerPlace; paths: string[] } };

/** A paste into a place's folder; the host reads the pasteboard, never the window. */
export interface FileClipboardPasteRequest {
  target: { place: FileManagerPlace; path: string };
  mode: "copy" | "move";
  /** What this window last copied, by place and as absolute paths. A Cut is the host's, never the window's. */
  internal: { place: FileManagerPlace; paths: string[]; nativePaths: string[] } | null;
  /** The window's id for this paste's progress (src/local/file-operations.ts). */
  operationId?: string;
  /** A conflicts-first check, or the person's choices; passed to the transfer as is. */
  conflicts?: { check: true } | ConflictPolicy;
  /** The check's `plan`: the run is refused when the pasteboard has changed since. */
  plan?: string;
}

export interface FileClipboardCut {
  nativePaths: string[];
}

/** The native right-click menu for a file manager row (macOS; desktop/src/file-context-menu.ts). */
export interface NativeFileMenuRequest {
  /** Empty when the entry is in a standard folder instead. */
  connectedFolderId: string;
  /**
   * Set instead of a Connected Folder id for an entry in Desktop, Documents, or
   * Downloads (the file manager's Standard Folders, optional; older renderers
   * omit it). Delete there is the system's Move to Trash.
   */
  standardFolderId?: string;
  path: string;
  kind: "file" | "folder";
  /** What the row offers (src/shared/file-menu.ts); the optional ones are absent in older renderers. */
  capabilities: FileMenuCapabilities;
  /**
   * Set when the clicked row is one of several selected together (optional;
   * older renderers omit it). The menu then offers only the actions that apply
   * to all of them, and the renderer applies the command to the whole selection.
   */
  selection?: { files: number; folders: number };
  point: { x: number; y: number };
}

/**
 * The native right-click menu for a Connected Folder tab, or for a Chat in the
 * Chats list: the Chat's own actions, then the tab strip's. Browser tabs have
 * their own menu in built-in-browser.ts.
 */
export type NativeTabMenuCommand =
  | "rename"
  | "copy"
  | "resume"
  | "archive"
  | "restore"
  | "delete"
  | "close"
  | "close-others"
  | "close-right"
  | "reopen"
  | `snooze:${string}`;

export interface NativeTabMenuSnoozePreset {
  id: string;
  label: string;
  detail: string;
}

export interface NativeTabMenuRequest {
  /** The Chat's actions; absent for a tab that holds no saved Chat. */
  chat?: { lifecycle: "active" | "snoozed" | "archived"; snooze: NativeTabMenuSnoozePreset[] };
  /** The tab strip's actions; absent when the menu opens from the Chats list. */
  tab?: { hasOthers: boolean; hasRight: boolean; canReopen: boolean };
  point: { x: number; y: number };
}

/**
 * The native right-click menu for the Connected Folder header (macOS), with the
 * same actions as the in-app menu other platforms show.
 */
export type NativeConnectedFolderMenuCommand = "new-chat" | "customize" | "organize" | "reveal" | "manage" | "skills" | "settings"
  | "put-to-work" | "remove-from-sidebar" | "create-connected-folder" | "use-existing-folder" | "remove-connected-folder" | "open-in-new-tab" | "open-in-new-window"
  | "open-terminal";

export interface NativeConnectedFolderMenuRequest {
  /**
   * Which of the header's actions this Connected Folder offers. Organize asks
   * the Connected Folder's Worker to organize it. Manage Connected Folders
   * is there unless `manage` is false. The file manager's Action menu
   * adds Skills & Extensions and Settings and leaves out Manage,
   * since its sidebar lists the Connected Folders; older renderers omit all three.
   */
  actions: {
    newChat: boolean; customize: boolean; organize: boolean; reveal: boolean; skills?: boolean; settings?: boolean; manage?: boolean;
    /** The file manager's Standard Folders: register the folder, or take an added one off the sidebar. */
    putToWork?: boolean; removeFromSidebar?: boolean;
    /** The file manager's + beside Connected Folders. */
    createConnectedFolder?: boolean; useExistingFolder?: boolean;
    /**
     * The file manager's Connected Folder menus: Disconnect… a linked folder
     * (its files stay), or, with `removeDeletes`, Delete Connected Folder… a
     * managed one (it moves to Recently Deleted).
     */
    remove?: boolean; removeDeletes?: boolean;
    /** The file manager's sidebar: open the folder in a new folder tab, or in a new window. */
    openInNewTab?: boolean;
    openInNewWindow?: boolean;
    /** The file manager's sidebar: Open Terminal Here, for the folder the menu is about. */
    openTerminal?: boolean;
  };
  point: { x: number; y: number };
}

type Point = { x: number; y: number };

// ---------------------------------------------------------------------------
// The channels
// ---------------------------------------------------------------------------

/** Renderer → main requests: each channel's arguments and what it answers. */
export interface DesktopInvokeChannels {
  "amplefile:clipboard:write": (content: ClipboardContent) => void;
  "amplefile:diagnostics:request": (input: Parameters<ModelContextDiagnosticsBridge["request"]>[0]) => unknown;
  "amplefile:diagnostics:close": () => void;
  "amplefile:api:session-headers": () => Record<string, string>;
  "amplefile:runtime:health": () => DesktopRuntimeHealth;
  "amplefile:settings:status": () => SecureSettingsStatus;
  "amplefile:shell:open-external": (url: string) => void;

  "amplefile:connected-folder:choose-folder": () => { path: string; folderGrantId: string } | null;
  "amplefile:connected-folder:reveal-folder": (connectedFolderId: string) => void;
  "amplefile:connected-folder:open-path": (request: { connectedFolderId: string; path: string; action: PathAction }) => void;
  "amplefile:connected-folder:open-path-with": (request: { connectedFolderId: string; path: string }) => OpenWithResult;
  "amplefile:connected-folder:start-drag": (request: { connectedFolderId: string; paths: string[] }) => boolean;
  "amplefile:connected-folder:preview-file": (request: { connectedFolderId: string; path: string }) => boolean;
  "amplefile:connected-folder:popup-file-menu": (request: NativeFileMenuRequest) => FileMenuCommand | null;
  "amplefile:connected-folder:popup-tab-menu": (request: NativeTabMenuRequest) => NativeTabMenuCommand | null;
  "amplefile:connected-folder:popup-header-menu": (request: NativeConnectedFolderMenuRequest) => NativeConnectedFolderMenuCommand | null;
  "amplefile:connected-folder:set-active-connected-folder": (connectedFolderId: string | null) => void;

  "amplefile:standard-folder:open-path": (request: { standardFolderId: string; path: string; action: PathAction }) => void;
  "amplefile:standard-folder:open-path-with": (request: { standardFolderId: string; path: string }) => OpenWithResult;
  "amplefile:standard-folder:start-drag": (request: { standardFolderId: string; paths: string[] }) => boolean;
  "amplefile:standard-folder:preview-file": (request: { standardFolderId: string; path: string }) => boolean;
  "amplefile:standard-folder:trash": (request: { standardFolderId: string; paths: string[] }) => StandardFolderTrashResult;
  "amplefile:standard-folder:add": () => { id: string; name: string } | null;
  "amplefile:place:open-link": (request: { place: FileManagerPlace; path: string; action: "open" | "reveal" }) => void;
  "amplefile:place:open-terminal": (location: Pick<WindowLocation, "place" | "path">) => void;

  "amplefile:file-clipboard:write": (request: FileClipboardWriteRequest) => boolean;
  "amplefile:file-clipboard:paste": (request: FileClipboardPasteRequest) => TransferAnswer;
  "amplefile:file-clipboard:cut": () => FileClipboardCut | null;
  "amplefile:file-clipboard:cancel-cut": () => void;

  "amplefile:file-manager:take-open-location": () => OpenLocationRequest | null;
  "amplefile:window:new-window": () => boolean;
  "amplefile:window:open-in-new-window": (location: WindowLocation) => boolean;
  "amplefile:window:accent-color": () => string | null;
  "amplefile:window:get-close-to-tray": () => CloseToTrayStatus;
  "amplefile:window:set-close-to-tray": (enabled: boolean) => CloseToTrayStatus;
  "amplefile:menu:popup": (menuId: ApplicationMenuId, bounds: Point) => void;

  "amplefile:agent:open-agent-draft": (text: string) => boolean;
  "amplefile:agent:open-main": () => boolean;
  "amplefile:agent:open-ai-models-settings": () => boolean;

  "amplefile:automations:list": () => AutomationsResponse;
  "amplefile:automations:proposals": () => AutomationProposalsResponse;
  "amplefile:automations:enable-proposal": (path: string) => AutomationEnableProposalResponse;
  "amplefile:automations:show": (automationId: string) => AutomationDetailResponse;
  "amplefile:automations:history": (automationId: string) => AutomationHistoryResponse;
  "amplefile:automations:enable": (automationId: string) => AutomationEnableResponse;
  "amplefile:automations:enable-template": (request: { connectedFolderId: string; templateId: string }) => AutomationEnableResponse;
  "amplefile:automations:run": (automationId: string) => AutomationRunResponse;
  "amplefile:automations:stop": (automationId: string) => AutomationStopResponse;
  "amplefile:automations:disable": (automationId: string) => AutomationDisableResponse;
  "amplefile:automations:delete": (automationId: string) => AutomationDeleteResponse;

  "amplefile:browser:mount": (request: BrowserViewRequest) => BrowserPageState | null;
  "amplefile:browser:unmount": (pageId: string) => void;
  "amplefile:browser:navigate": (pageId: string, address: string) => BrowserPageState;
  "amplefile:browser:command": (pageId: string, command: BrowserCommand) => void;
  "amplefile:browser:close": (pageId: string) => void;
  "amplefile:browser:respond-permission": (pageId: string, requestId: string, decision: "allow" | "block") => void;
  "amplefile:browser:states": () => BrowserPageState[];
  "amplefile:browser:show-download": (path: string) => void;
  "amplefile:browser:suggest": (text: string) => BrowserHistoryEntry[];
  "amplefile:browser:popup-tab-menu": (pageId: string, url: string, point: Point, options: { canReopen: boolean; hasOthers: boolean }) => BrowserTabMenuCommand | null;
  "amplefile:browser:recent": () => BrowserHistoryEntry[];
  "amplefile:browser:clear-history": () => void;

  "amplefile:updates:status": () => DesktopUpdateStatus;
  "amplefile:updates:check": () => DesktopUpdateStatus;
  "amplefile:updates:install": () => DesktopUpdateStatus;
  "amplefile:updates:update-now": () => DesktopUpdateStatus;

  "amplefile:command-line:status": () => CommandLineStatus;
  "amplefile:command-line:install-path": () => CommandLineStatus;
  "amplefile:command-line:remove-path": () => CommandLineStatus;
  "amplefile:command-line:install-skill": (target: CommandLineSkillTarget) => CommandLineStatus;
  "amplefile:command-line:remove-skill": (target: CommandLineSkillTarget) => CommandLineStatus;
  "amplefile:command-line:skill": () => string;

}

/** Renderer → main messages that get no answer. */
export interface DesktopSendChannels {
  "amplefile:file-manager:ack-open-location": (token: string) => void;
  "amplefile:window:set-location": (location: WindowLocation | null) => void;
  "amplefile:window:set-theme": (theme: "light" | "dark", source?: "light" | "dark" | "system") => void;
  "amplefile:window:control": (action: "minimize" | "toggle-maximize" | "close") => void;
  "amplefile:window:rail-tooltip-show": (request: RailTooltipRequest) => void;
  "amplefile:window:rail-tooltip-hide": () => void;
  /** What the menu bar reflects; a key left out keeps its value. */
  "amplefile:menu:set-state": (state: Partial<WindowMenuState>) => void;
  "amplefile:agent:hide": () => void;
  "amplefile:browser:layout": (request: BrowserViewRequest) => void;
  "amplefile:browser:sync": (tabs: BrowserTabsSync) => void;
}

/** Main → renderer notifications. */
export interface DesktopEventChannels {
  "amplefile:runtime:renderer-recovered": () => void;
  "amplefile:file-manager:open-location": (request: OpenLocationRequest) => void;
  /** Declared and listened for by the main preload; nothing sends it. */
  "amplefile:menu:open-folder": () => void;
  "amplefile:menu-command": (command: RendererMenuCommand) => void;
  "amplefile:file-clipboard:cut-changed": (cut: FileClipboardCut | null) => void;
  "amplefile:agent:open-settings": (scope?: "agent") => void;
  "amplefile:agent:staged": (items: AmpleFileAgentStagedItem[]) => void;
  "amplefile:window:accent-color-changed": (accent: string | null) => void;
  "amplefile:updates:status-changed": (status: DesktopUpdateStatus) => void;
  "amplefile:browser:state": (state: BrowserPageState) => void;
  "amplefile:browser:open-tab": (command: BrowserOpenTabCommand) => void;
  "amplefile:browser:close-tab": (command: { pageId: string }) => void;
  "amplefile:browser:shortcut": (shortcut: BrowserShortcut) => void;
  "amplefile:browser:find-result": (result: BrowserFindResult) => void;
  "amplefile:browser:download": (download: BrowserDownload) => void;
}

export type DesktopInvokeChannel = keyof DesktopInvokeChannels;
export type DesktopSendChannel = keyof DesktopSendChannels;
export type DesktopEventChannel = keyof DesktopEventChannels;

export type DesktopInvokeArgs<C extends DesktopInvokeChannel> = Parameters<DesktopInvokeChannels[C]>;
export type DesktopInvokeResult<C extends DesktopInvokeChannel> = ReturnType<DesktopInvokeChannels[C]>;
export type DesktopSendArgs<C extends DesktopSendChannel> = Parameters<DesktopSendChannels[C]>;
export type DesktopEventArgs<C extends DesktopEventChannel> = Parameters<DesktopEventChannels[C]>;

/** What a receiving side holds before it checks them: the same arity, every value unchecked. */
export type Unchecked<Args extends unknown[]> = { [K in keyof Args]: unknown };

/** A bridge method's answer: the channel's answer, as `ipcRenderer.invoke` resolves it. */
type Answer<C extends DesktopInvokeChannel> = Promise<DesktopInvokeResult<C>>;
/** A bridge method that invokes its channel with its own arguments. */
type Invoke<C extends DesktopInvokeChannel> = (...args: DesktopInvokeArgs<C>) => Answer<C>;
/** A bridge method that sends its channel its own arguments. */
type Send<C extends DesktopSendChannel> = (...args: DesktopSendArgs<C>) => void;
type Unsubscribe = () => void;
/** A bridge method that hands each of its channel's events to a listener, until unsubscribed. */
type Listen<C extends DesktopEventChannel> = (listener: (...args: DesktopEventArgs<C>) => void) => Unsubscribe;

/**
 * Electron's `ipcRenderer`, as a preload may use it: only the contract's
 * channels, with their arguments and answers. A preload assigns
 * `electron.ipcRenderer` to this type; nothing changes at run time.
 */
export interface DesktopIpcRenderer {
  invoke<C extends DesktopInvokeChannel>(channel: C, ...args: DesktopInvokeArgs<C>): Promise<DesktopInvokeResult<C>>;
  send<C extends DesktopSendChannel>(channel: C, ...args: DesktopSendArgs<C>): void;
  on<C extends DesktopEventChannel>(channel: C, listener: (event: unknown, ...args: DesktopEventArgs<C>) => void): unknown;
  removeListener<C extends DesktopEventChannel>(channel: C, listener: (event: unknown, ...args: DesktopEventArgs<C>) => void): unknown;
}

// ---------------------------------------------------------------------------
// What the preloads expose
// ---------------------------------------------------------------------------

/**
 * `window.ampleFileDesktop` as the file manager window's preload
 * (desktop/src/preload.cts) exposes it, and as the renderer reads it. One
 * renderer type serves the file manager window and the AmpleFile Agent
 * popover, whose preload exposes a narrow slice (`AmpleFileAgentPopoverBridge`),
 * so what the popover leaves out is optional here, as are the platform-only
 * parts.
 */
export interface AmpleFileDesktopBridge {
  desktop: true;
  clipboard?: ClipboardWriter;
  api: {
    baseUrl: string;
    getSessionHeaders: Invoke<"amplefile:api:session-headers">;
  };
  app: {
    name: string;
    version: string;
    platform: NodeJS.Platform;
    desktopEnvironment?: string;
    iconUrl: string;
  };
  runtime: {
    getHealth: Invoke<"amplefile:runtime:health">;
    onRendererRecovered: Listen<"amplefile:runtime:renderer-recovered">;
  };
  connectedFolder: {
    chooseFolder: Invoke<"amplefile:connected-folder:choose-folder">;
    revealFolder: Invoke<"amplefile:connected-folder:reveal-folder">;
    openPath: (connectedFolderId: string, path: string, action?: PathAction) => Answer<"amplefile:connected-folder:open-path">;
    openPathWith?: (connectedFolderId: string, path: string) => Answer<"amplefile:connected-folder:open-path-with">;
    /** Drags these items (files and folders) out to other apps. */
    startDrag: (connectedFolderId: string, paths: string[]) => Answer<"amplefile:connected-folder:start-drag">;
    previewFile: (connectedFolderId: string, path: string) => Answer<"amplefile:connected-folder:preview-file">;
    /** A file manager row's right-click menu (macOS). */
    popupFileMenu?: Invoke<"amplefile:connected-folder:popup-file-menu">;
    /** A Connected Folder tab's or a Chat's right-click menu (macOS). */
    popupTabMenu?: Invoke<"amplefile:connected-folder:popup-tab-menu">;
    /** The Connected Folder header's right-click menu (macOS). */
    popupHeaderMenu?: Invoke<"amplefile:connected-folder:popup-header-menu">;
    setActiveConnectedFolder: Invoke<"amplefile:connected-folder:set-active-connected-folder">;
    /**
     * A folder or file the system asked AmpleFile to open, as the host resolved it: a place, a folder in it, and an item to select.
     * `onTaken` runs once the place already handed to this window, if any, has been delivered.
     */
    onOpenLocation: (listener: (location: OpenLocation) => void, onTaken?: () => void) => Unsubscribe;
    onOpenFolder: Listen<"amplefile:menu:open-folder">;
  };
  /** Desktop, Documents, and Downloads in the file manager: the host resolves each folder by id. */
  standardFolder?: {
    openPath: (standardFolderId: string, path: string, action?: PathAction) => Answer<"amplefile:standard-folder:open-path">;
    openPathWith: (standardFolderId: string, path: string) => Answer<"amplefile:standard-folder:open-path-with">;
    startDrag: (standardFolderId: string, paths: string[]) => Answer<"amplefile:standard-folder:start-drag">;
    previewFile: (standardFolderId: string, path: string) => Answer<"amplefile:standard-folder:preview-file">;
    trash: (standardFolderId: string, paths: string[]) => Answer<"amplefile:standard-folder:trash">;
    /** Opens the folder picker and adds the chosen folder to Standard Folders. */
    add?: Invoke<"amplefile:standard-folder:add">;
  };
  /** A symbolic link a listing showed, in any place: opens what it points to (a file), or shows the link itself. */
  placeLink?: {
    open: (place: FileManagerPlace, path: string, action: "open" | "reveal") => Answer<"amplefile:place:open-link">;
  };
  /** Open Terminal Here; Linux and the Mac. */
  openTerminal?: Invoke<"amplefile:place:open-terminal">;
  /**
   * Files on the system pasteboard, to and from Finder. The window never reads
   * the pasteboard: paste happens in the desktop process, which answers with
   * what landed.
   */
  fileClipboard?: {
    /**
     * A Copy, or with "cut" a Cut: the host remembers a Cut for every
     * window, by `from` (the same items by place), so a paste in any
     * window moves them. Linux file managers paste a Cut as a move too.
     */
    write: (paths: string[], operation?: "copy" | "cut", from?: { place: FileManagerPlace; paths: string[] }) => Answer<"amplefile:file-clipboard:write">;
    paste: Invoke<"amplefile:file-clipboard:paste">;
    /** What is cut in any window while the pasteboard still holds it, as absolute paths; null for nothing. */
    cut?: Invoke<"amplefile:file-clipboard:cut">;
    /** Esc: cancels the Cut in every window. */
    cancelCut?: Invoke<"amplefile:file-clipboard:cancel-cut">;
    /** Every change of what is cut, from any window. */
    onCutChanged?: Listen<"amplefile:file-clipboard:cut-changed">;
  };
  agent: {
    /** The local path of a file dropped on the AmpleFile Agent panel. */
    getPathForFile?: (file: File) => string;
    openAmpleFileAgentDraft?: Invoke<"amplefile:agent:open-agent-draft">;
    onOpenSettings: Listen<"amplefile:agent:open-settings">;
  };
  /** Main-window-only Automation management; absent from the popover preload. */
  automations?: {
    list: Invoke<"amplefile:automations:list">;
    /** Pending `*.amplefile-automation.json` files in the AmpleFile Agent's working folder. */
    proposals: Invoke<"amplefile:automations:proposals">;
    /** Turns on one pending file by absolute path, through the same enable path as the CLI. */
    enableProposal: Invoke<"amplefile:automations:enable-proposal">;
    show: Invoke<"amplefile:automations:show">;
    history: Invoke<"amplefile:automations:history">;
    enable: Invoke<"amplefile:automations:enable">;
    /** Turns on a ready-made Automation for one Connected Folder. */
    enableTemplate?: (connectedFolderId: string, templateId: string) => Answer<"amplefile:automations:enable-template">;
    run: Invoke<"amplefile:automations:run">;
    stop: Invoke<"amplefile:automations:stop">;
    disable: Invoke<"amplefile:automations:disable">;
    delete: Invoke<"amplefile:automations:delete">;
  };
  /** The AmpleFile Agent popover's own actions; only its preload exposes them. */
  ampleFileAgent?: AmpleFileAgentPopoverBridge["ampleFileAgent"];
  /** The built-in browser's tabs; main-window only (docs/built-in-browser.md). Pages run in the main process; the window only places them and shows their state. */
  browser?: {
    mount: Invoke<"amplefile:browser:mount">;
    layout: Send<"amplefile:browser:layout">;
    unmount: Invoke<"amplefile:browser:unmount">;
    navigate: Invoke<"amplefile:browser:navigate">;
    command: Invoke<"amplefile:browser:command">;
    close: Invoke<"amplefile:browser:close">;
    respondPermission: Invoke<"amplefile:browser:respond-permission">;
    sync: Send<"amplefile:browser:sync">;
    states: Invoke<"amplefile:browser:states">;
    /** Shows a file the browser downloaded in Finder or Explorer. */
    showDownload: Invoke<"amplefile:browser:show-download">;
    /** Pages from history matching what someone typed in the address bar. */
    suggest: Invoke<"amplefile:browser:suggest">;
    /** A browser tab's right-click menu; resolves with what the tab strip should do, if anything. */
    popupTabMenu: Invoke<"amplefile:browser:popup-tab-menu">;
    /** The most recently visited pages, for a new tab. */
    recent: Invoke<"amplefile:browser:recent">;
    clearHistory: Invoke<"amplefile:browser:clear-history">;
    onState: Listen<"amplefile:browser:state">;
    onOpenTab: Listen<"amplefile:browser:open-tab">;
    onCloseTab: Listen<"amplefile:browser:close-tab">;
    onShortcut: Listen<"amplefile:browser:shortcut">;
    onFindResult: Listen<"amplefile:browser:find-result">;
    onDownload: Listen<"amplefile:browser:download">;
  };
  window: {
    material: "mica" | "vibrancy" | "none";
    setTheme: Send<"amplefile:window:set-theme">;
    railTooltip: {
      show: Send<"amplefile:window:rail-tooltip-show">;
      hide: Send<"amplefile:window:rail-tooltip-hide">;
    };
    getAccentColor: Invoke<"amplefile:window:accent-color">;
    onAccentColorChanged: Listen<"amplefile:window:accent-color-changed">;
    control?: Send<"amplefile:window:control">;
    getCloseToTray: Invoke<"amplefile:window:get-close-to-tray">;
    setCloseToTray: Invoke<"amplefile:window:set-close-to-tray">;
  };
  shell: {
    openExternal: Invoke<"amplefile:shell:open-external">;
  };
  updates: {
    getStatus: Invoke<"amplefile:updates:status">;
    check: Invoke<"amplefile:updates:check">;
    install: Invoke<"amplefile:updates:install">;
    updateNow: Invoke<"amplefile:updates:update-now">;
    onStatusChanged: Listen<"amplefile:updates:status-changed">;
  };
  settings: {
    /**
     * `credentialsNeedReentry`: saved provider credentials could not be
     * decrypted and were set aside, so the person must connect again.
     */
    getStatus: Invoke<"amplefile:settings:status">;
  };
  /** Other AI agents: the command on Terminal's PATH and the skill file (Settings → Command Line). */
  commandLine?: {
    status: Invoke<"amplefile:command-line:status">;
    installPath: Invoke<"amplefile:command-line:install-path">;
    removePath: Invoke<"amplefile:command-line:remove-path">;
    installSkill: Invoke<"amplefile:command-line:install-skill">;
    removeSkill: Invoke<"amplefile:command-line:remove-skill">;
    skill: Invoke<"amplefile:command-line:skill">;
  };
  /**
   * File manager windows: which one this is (slot 1 is the first; `fresh` is a
   * window just opened rather than one coming back), where it is, so File → New Window opens there, and new windows.
   */
  windows?: {
    slot: number;
    fresh: boolean;
    newWindow: Invoke<"amplefile:window:new-window">;
    /** Open in New Window: another window at this place and folder, with `select` selected there. */
    openInNewWindow: Invoke<"amplefile:window:open-in-new-window">;
    setLocation: Send<"amplefile:window:set-location">;
  };
  menu: {
    /** What the menu bar reflects; a key left out keeps its value. */
    setState: Send<"amplefile:menu:set-state">;
    popup: Invoke<"amplefile:menu:popup">;
    onCommand: Listen<"amplefile:menu-command">;
  };
}

/**
 * `window.ampleFileDesktop` as the AmpleFile Agent popover's narrow preload
 * (desktop/src/amplefile-agent-popover-preload.cts) exposes it: the local API
 * session, fixed popover actions, and opening a result file through the
 * checked path handler. Never widen it with the file manager window's parts.
 */
export interface AmpleFileAgentPopoverBridge {
  desktop: true;
  clipboard: ClipboardWriter;
  api: AmpleFileDesktopBridge["api"];
  app: Omit<AmpleFileDesktopBridge["app"], "desktopEnvironment">;
  ampleFileAgent: {
    openResultFile: (connectedFolderId: string, path: string) => Answer<"amplefile:connected-folder:open-path">;
    getPathForFile: (file: File) => string;
    hide: Send<"amplefile:agent:hide">;
    openMainWindow: Invoke<"amplefile:agent:open-main">;
    openAiModelsSettings: Invoke<"amplefile:agent:open-ai-models-settings">;
    onStaged: Listen<"amplefile:agent:staged">;
  };
  window: {
    material: "vibrancy" | "none";
    getAccentColor: AmpleFileDesktopBridge["window"]["getAccentColor"];
    onAccentColorChanged: AmpleFileDesktopBridge["window"]["onAccentColorChanged"];
  };
}
