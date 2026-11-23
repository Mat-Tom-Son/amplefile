import type {
  AutomationDetailResponse,
  AutomationHistoryResponse,
  AutomationsResponse,
  AutomationRunResponse,
  AutomationEnableResponse,
  AutomationEnableProposalResponse,
  AutomationProposalsResponse,
} from "./components/modals/AutomationsPane";

export {};

interface AmpleFileDesktopUpdateStatus {
  supported: boolean;
  phase: "unsupported" | "idle" | "checking" | "available" | "not_available" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string;
  error: string | null;
}

interface AmpleFileCommandLineSkillStatus {
  available: boolean;
  installed: "none" | "current" | "outdated";
  path: string;
}

interface AmpleFileCommandLineStatus {
  command: string;
  path: { supported: boolean; reason: string | null; state: "installed" | "missing" | "elsewhere"; binDirectory: string | null; entryFile: string };
  skills: { claude: AmpleFileCommandLineSkillStatus; codex: AmpleFileCommandLineSkillStatus };
}

type AmpleFileDesktopMenuCommand =
  | "new-connected-folder"
  | "open-local-folder"
  | "new-chat"
  | "refresh"
  | "check-for-updates"
  | "open-settings"
  | "open-about"
  | "open-capabilities"
  | "open-skills"
  | "open-extensions"
  | "open-command-palette"
  | "open-keyboard-shortcuts"
  | "close-tab"
  | "toggle-hidden-files"
  | "new-tab"
  | "next-tab"
  | "previous-tab"
  | "toggle-tab-bar";

type AmpleFileDesktopMenuId = "file" | "edit" | "view" | "help";
type AmpleFileDesktopPathAction = "open" | "open-native" | "reveal";
/** Where a folder or file handed to AmpleFile opens: a place, the folder shown in it, and an item to select. */
type AmpleFileDesktopOpenLocation = { place: { kind: "connected-folder" | "standard"; id: string }; path: string; select: string | null };
type AmpleFileDesktopFileMenuCommand = "open" | "open-in-new-tab" | "open-in-new-window" | "open-with" | "reveal" | "copy-path" | "attach-chat" | "version-history" | "new-folder" | "upload-here" | "refresh" | "give-worker" | "rename" | "delete"
  | "copy" | "paste" | "duplicate" | "compress" | "new-folder-with-selection";

type AmpleFileDesktopTabMenuCommand = "rename" | "copy" | "resume" | "archive" | "restore" | "delete" | "close" | "close-others" | "close-right" | "reopen" | `snooze:${string}`;

type AmpleFileDesktopHeaderMenuCommand = "new-chat" | "customize" | "organize" | "reveal" | "manage" | "skills" | "settings"
  | "put-to-work" | "remove-from-sidebar" | "create-connected-folder" | "use-existing-folder" | "remove-connected-folder" | "open-in-new-tab" | "open-in-new-window";

interface AmpleFileDesktopHeaderMenuRequest {
  /**
   * The file manager's Action menu adds Skills & Extensions and Settings and
   * leaves out Manage; its sidebar uses the Standard Folder and + commands.
   */
  actions: {
    newChat: boolean; customize: boolean; organize: boolean; reveal: boolean; skills?: boolean; settings?: boolean; manage?: boolean;
    putToWork?: boolean; removeFromSidebar?: boolean; createConnectedFolder?: boolean; useExistingFolder?: boolean; remove?: boolean; removeDeletes?: boolean;
    /** The sidebar's folders: Open in New Tab and Open in New Window. */
    openInNewTab?: boolean;
    openInNewWindow?: boolean;
  };
  point: { x: number; y: number };
}

interface AmpleFileDesktopTabMenuRequest {
  chat?: { lifecycle: "active" | "snoozed" | "archived"; snooze: Array<{ id: string; label: string; detail: string }> };
  tab?: { hasOthers: boolean; hasRight: boolean; canReopen: boolean };
  point: { x: number; y: number };
}

interface AmpleFileDesktopFileMenuRequest {
  /** Empty for an entry in a standard folder. */
  connectedFolderId: string;
  /** Desktop, Documents, or Downloads in the file manager; Delete becomes Move to Trash. */
  standardFolderId?: string;
  path: string;
  kind: "file" | "folder";
  capabilities: {
    open: boolean;
    attach: boolean;
    history: boolean;
    upload: boolean;
    rename: boolean;
    delete: boolean;
    worker?: boolean;
    /** The file manager's Copy, Duplicate, Compress, and New Folder with Selection, and Paste on a folder. */
    organize?: boolean;
    paste?: boolean;
    /** A symbolic link: only Open, Show in Finder, and Copy Path. */
    link?: boolean;
    /** A folder: Open in New Tab, and Open in New Window where the desktop has windows. */
    newTab?: boolean;
    newWindow?: boolean;
  };
  /** Several rows selected together: the menu offers only what applies to all of them. */
  selection?: { files: number; folders: number };
  point: { x: number; y: number };
}

interface AmpleFileBrowserHistoryEntry {
  url: string;
  title: string;
  visits: number;
  lastVisitedAt: string;
}

type AmpleFileBrowserCommand =
  | { type: "back" | "forward" | "reload" | "stop" | "focus" | "stop-find" | "inspect" | "zoom-in" | "zoom-out" | "zoom-reset" | "dismiss-notice" | "print" | "save-pdf" | "open-blocked-popup" | "allow-popups" | "dismiss-blocked-popup" | "leave-page" | "stay-on-page" }
  | { type: "mute"; muted: boolean }
  | { type: "find"; text: string; forward: boolean; newSearch: boolean }
  | { type: "forget-permission" | "open-privacy-settings"; kind: import("../../src/shared/browser").BrowserSitePermission };

declare global {
  interface Window {
    ampleFileDesktop?: {
      desktop: true;
      clipboard?: import("../../src/shared/clipboard").ClipboardWriter;
      api: {
        baseUrl: string;
        getSessionHeaders: () => Promise<Record<string, string>>;
      };
      app: {
        name: string;
        version: string;
        platform: NodeJS.Platform;
        iconUrl: string;
      };
      runtime: {
        getHealth: () => Promise<{
          pi: { ok: boolean; configured?: boolean; version?: string; message?: string };
          settings: { encryptionAvailable: boolean; configuredProviders: string[]; credentialsNeedReentry?: boolean };
        }>;
        onRendererRecovered: (listener: () => void) => () => void;
      };
      connectedFolder: {
        chooseFolder: () => Promise<{ path: string; folderGrantId: string } | null>;
        revealFolder: (connectedFolderId: string) => Promise<void>;
        openPath: (connectedFolderId: string, path: string, action?: AmpleFileDesktopPathAction) => Promise<void>;
        openPathWith?: (connectedFolderId: string, path: string) => Promise<{ opened: boolean; canceled: boolean; appName: string | null }>;
        /** Drags these items (files and folders) out to other apps. */
        startDrag: (connectedFolderId: string, paths: string[]) => Promise<boolean>;
        previewFile: (connectedFolderId: string, path: string) => Promise<boolean>;
        popupFileMenu?: (request: AmpleFileDesktopFileMenuRequest) => Promise<AmpleFileDesktopFileMenuCommand | null>;
        /** A Connected Folder tab's or a Chat's right-click menu (macOS). */
        popupTabMenu?: (request: AmpleFileDesktopTabMenuRequest) => Promise<AmpleFileDesktopTabMenuCommand | null>;
        /** The Connected Folder header's right-click menu (macOS). */
        popupHeaderMenu?: (request: AmpleFileDesktopHeaderMenuRequest) => Promise<AmpleFileDesktopHeaderMenuCommand | null>;
        setActiveConnectedFolder: (connectedFolderId: string | null) => Promise<void>;
        /** A folder or file the system asked AmpleFile to open, as the host resolved it. */
        onOpenLocation: (listener: (location: AmpleFileDesktopOpenLocation) => void) => () => void;
        onOpenFolder: (listener: () => void) => () => void;
      };
      /** Standard Folders in the file manager (absent in older desktop builds). */
      standardFolder?: {
        openPath: (standardFolderId: string, path: string, action?: AmpleFileDesktopPathAction) => Promise<void>;
        openPathWith: (standardFolderId: string, path: string) => Promise<{ opened: boolean; canceled: boolean; appName: string | null }>;
        startDrag: (standardFolderId: string, paths: string[]) => Promise<boolean>;
        previewFile: (standardFolderId: string, path: string) => Promise<boolean>;
        trash: (standardFolderId: string, paths: string[]) => Promise<{ trashed: string[]; failed: { path: string; error: string } | null }>;
        /** Opens the folder picker and adds the chosen folder to Standard Folders (absent in older desktop builds). */
        add?: () => Promise<{ id: string; name: string } | null>;
      };
      /** A symbolic link a listing showed: opens what it points to (a file), or shows the link itself (absent in older desktop builds). */
      placeLink?: {
        open: (place: { kind: "connected-folder" | "standard"; id: string }, path: string, action: "open" | "reveal") => Promise<void>;
      };
      /**
       * Files on the system pasteboard, to and from Finder (absent in older
       * desktop builds). The window never reads the pasteboard: paste happens
       * in the desktop process, which answers with what landed.
       */
      fileClipboard?: {
        /**
         * A Copy, or with "cut" a Cut: the host remembers a Cut for every
         * window, by `from` (the same items by place), so a paste in any
         * window moves them. Linux file managers paste a Cut as a move too.
         */
        write: (paths: string[], operation?: "copy" | "cut", from?: { place: { kind: "connected-folder" | "standard"; id: string }; paths: string[] }) => Promise<boolean>;
        paste: (request: {
          target: { place: { kind: "connected-folder" | "standard"; id: string }; path: string };
          mode: "copy" | "move";
          /** What this window copied; a Cut is the host's. */
          internal: { place: { kind: "connected-folder" | "standard"; id: string }; paths: string[]; nativePaths: string[] } | null;
          operationId?: string;
          conflicts?: { check: true } | import("./components/file-manager/file-operations-model").ConflictPolicy;
          /** The check's `plan`: the run is refused when the pasteboard has changed since. */
          plan?: string;
        }) => Promise<import("./components/file-manager/file-operations-model").TransferAnswer>;
        /** What is cut in any window while the pasteboard still holds it, as absolute paths; null for nothing (absent in older desktop builds). */
        cut?: () => Promise<{ nativePaths: string[] } | null>;
        /** Esc: cancels the Cut in every window. */
        cancelCut?: () => Promise<void>;
        /** Every change of what is cut, from any window. */
        onCutChanged?: (callback: (cut: { nativePaths: string[] } | null) => void) => () => void;
      };
      agent: {
        /** The local path of a file dropped on the AmpleFile Agent panel. */
        getPathForFile?: (file: File) => string;
        openAmpleFileAgentDraft?: (text: string) => Promise<boolean>;
        onOpenSettings: (listener: (scope?: "agent") => void) => () => void;
      };
      /** Main-window-only automation management; absent from the popover preload. */
      automations?: {
        list: () => Promise<AutomationsResponse>;
        /** Pending `*.amplefile-automation.json` files in the AmpleFile Agent's working folder. */
        proposals: () => Promise<AutomationProposalsResponse>;
        /** Turns on one pending file by absolute path, through the same enable path as the CLI. */
        enableProposal: (path: string) => Promise<AutomationEnableProposalResponse>;
        show: (automationId: string) => Promise<AutomationDetailResponse>;
        history: (automationId: string) => Promise<AutomationHistoryResponse>;
        enable: (automationId: string) => Promise<AutomationEnableResponse>;
        /** Turns on a ready-made Automation for one Connected Folder (absent in older desktop builds). */
        enableTemplate?: (connectedFolderId: string, templateId: string) => Promise<AutomationEnableResponse>;
        run: (automationId: string) => Promise<AutomationRunResponse>;
        stop: (automationId: string) => Promise<unknown>;
        disable: (automationId: string) => Promise<unknown>;
        delete: (automationId: string) => Promise<unknown>;
      };
      ampleFileAgent?: {
        openResultFile?: (connectedFolderId: string, path: string) => Promise<void>;
        getPathForFile: (file: File) => string;
        hide: () => void;
        openMainWindow: () => Promise<boolean>;
        openAiModelsSettings: () => Promise<boolean>;
        onStaged: (listener: (items: Array<{ kind: "path" | "text"; value: string }>) => void) => () => void;
      };
      /** The built-in browser's tabs; main-window only (docs/built-in-browser.md). */
      browser?: {
        mount: (request: import("../../src/shared/browser").BrowserViewRequest) => Promise<import("../../src/shared/browser").BrowserPageState | null>;
        layout: (request: import("../../src/shared/browser").BrowserViewRequest) => void;
        unmount: (pageId: string) => Promise<void>;
        navigate: (pageId: string, address: string) => Promise<import("../../src/shared/browser").BrowserPageState>;
        command: (pageId: string, command: AmpleFileBrowserCommand) => Promise<void>;
        close: (pageId: string) => Promise<void>;
        respondPermission: (pageId: string, requestId: string, decision: "allow" | "block") => Promise<void>;
        sync: (tabs: import("../../src/shared/browser").BrowserTabsSync) => void;
        states: () => Promise<import("../../src/shared/browser").BrowserPageState[]>;
        /** Shows a file the browser downloaded in Finder or Explorer. */
        showDownload: (path: string) => Promise<void>;
        /** A browser tab's right-click menu; resolves with what the tab strip should do, if anything. */
        popupTabMenu: (pageId: string, url: string, point: { x: number; y: number }, options: { canReopen: boolean; hasOthers: boolean }) => Promise<import("../../src/shared/browser").BrowserTabMenuCommand | null>;
        /** Pages from history matching what someone typed in the address bar. */
        suggest: (text: string) => Promise<AmpleFileBrowserHistoryEntry[]>;
        /** The most recently visited pages, for a new tab. */
        recent: () => Promise<AmpleFileBrowserHistoryEntry[]>;
        clearHistory: () => Promise<void>;
        onState: (listener: (state: import("../../src/shared/browser").BrowserPageState) => void) => () => void;
        onOpenTab: (listener: (command: import("../../src/shared/browser").BrowserOpenTabCommand) => void) => () => void;
        onCloseTab: (listener: (command: { pageId: string }) => void) => () => void;
        onShortcut: (listener: (shortcut: import("../../src/shared/browser").BrowserShortcut) => void) => () => void;
        onFindResult: (listener: (result: import("../../src/shared/browser").BrowserFindResult) => void) => () => void;
        onDownload: (listener: (download: import("../../src/shared/browser").BrowserDownload) => void) => () => void;
      };
      window: {
        material: "mica" | "vibrancy" | "none";
        setTheme: (theme: "light" | "dark", source?: "light" | "dark" | "system") => void;
        railTooltip: {
          show: (request: {
            text: string;
            bounds: { x: number; y: number; width: number; height: number };
            theme: "light" | "dark";
          }) => void;
          hide: () => void;
        };
        getAccentColor: () => Promise<string | null>;
        onAccentColorChanged: (listener: (accent: string | null) => void) => () => void;
        /** Closes this window when its last folder tab closes; minimize and maximize are for a title bar the window draws itself. */
        control?: (action: "minimize" | "toggle-maximize" | "close") => void;
        getCloseToTray: () => Promise<{ supported: boolean; enabled: boolean }>;
        setCloseToTray: (enabled: boolean) => Promise<{ supported: boolean; enabled: boolean }>;
      };
      shell: {
        openExternal: (url: string) => Promise<void>;
      };
      updates: {
        getStatus: () => Promise<AmpleFileDesktopUpdateStatus>;
        check: () => Promise<AmpleFileDesktopUpdateStatus>;
        install: () => Promise<AmpleFileDesktopUpdateStatus>;
        updateNow: () => Promise<AmpleFileDesktopUpdateStatus>;
        onStatusChanged: (listener: (status: AmpleFileDesktopUpdateStatus) => void) => () => void;
      };
      settings: {
        /**
         * `credentialsNeedReentry`: saved provider credentials could not be
         * decrypted and were set aside, so the person must connect again.
         */
        getStatus: () => Promise<{ encryptionAvailable: boolean; configuredProviders: string[]; credentialsNeedReentry?: boolean }>;
      };
      /** Other AI agents: the command on Terminal's PATH and the skill file (Settings → Command Line). */
      commandLine?: {
        status: () => Promise<AmpleFileCommandLineStatus>;
        installPath: () => Promise<AmpleFileCommandLineStatus>;
        removePath: () => Promise<AmpleFileCommandLineStatus>;
        installSkill: (target: "claude" | "codex") => Promise<AmpleFileCommandLineStatus>;
        removeSkill: (target: "claude" | "codex") => Promise<AmpleFileCommandLineStatus>;
        skill: () => Promise<string>;
      };
      /**
       * File manager windows (absent in older desktop builds): which one this is (slot 1 is the first; `fresh` is a
       * window just opened rather than one coming back), where it is, so File → New Window opens there, and new windows.
       */
      windows?: {
        slot: number;
        fresh: boolean;
        newWindow: () => Promise<boolean>;
        /** Open in New Window: another window at this place and folder, with `select` selected there. */
        openInNewWindow: (location: { place: { kind: "connected-folder" | "standard"; id: string }; path: string; select?: string | null }) => Promise<boolean>;
        setLocation: (location: { place: { kind: "connected-folder" | "standard"; id: string }; path: string } | null) => void;
      };
      menu: {
        /** What the menu bar reflects; a key left out keeps its value. */
        setState: (state: { connectedFolderOpen?: boolean; showHiddenFiles?: boolean; folderTabsOpen?: boolean; showTabBar?: boolean }) => void;
        popup: (menuId: AmpleFileDesktopMenuId, bounds: { x: number; y: number }) => Promise<void>;
        onCommand: (listener: (command: AmpleFileDesktopMenuCommand) => void) => () => void;
      };
    };
  }
}
