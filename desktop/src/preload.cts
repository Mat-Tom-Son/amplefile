const { contextBridge, ipcRenderer, webUtils } = require("electron") as typeof import("electron");

function argumentValue(name: string): string {
  const prefix = `--amplefile-${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  if (!argument) return "";
  try {
    return decodeURIComponent(argument.slice(prefix.length));
  } catch {
    return "";
  }
}

const apiBaseUrl = argumentValue("api-base-url");
const appVersion = argumentValue("app-version");
const productName = argumentValue("product-name");
const internalProtocol = argumentValue("internal-protocol");
const rawWindowMaterial = argumentValue("window-material");
const windowMaterial = rawWindowMaterial === "mica" || rawWindowMaterial === "vibrancy" ? rawWindowMaterial : "none";

contextBridge.exposeInMainWorld("ampleFileDesktop", {
  desktop: true,
  clipboard: {
    write: (content: { text: string; html?: string }) => ipcRenderer.invoke("amplefile:clipboard:write", content),
  },
  api: {
    baseUrl: apiBaseUrl,
    getSessionHeaders: () => ipcRenderer.invoke("amplefile:api:session-headers"),
  },
  app: {
    name: productName,
    version: appVersion,
    platform: process.platform,
    iconUrl: internalProtocol ? `${internalProtocol}://app/_desktop-assets/icon-32.png` : "",
  },
  runtime: {
    getHealth: () => ipcRenderer.invoke("amplefile:runtime:health"),
    onRendererRecovered: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("amplefile:runtime:renderer-recovered", listener);
      return () => ipcRenderer.removeListener("amplefile:runtime:renderer-recovered", listener);
    },
  },
  connectedFolder: {
    chooseFolder: () => ipcRenderer.invoke("amplefile:connected-folder:choose-folder"),
    revealFolder: (connectedFolderId: string) => ipcRenderer.invoke("amplefile:connected-folder:reveal-folder", connectedFolderId),
    openPath: (connectedFolderId: string, path: string, action: "open" | "open-native" | "reveal" = "open") => (
      ipcRenderer.invoke("amplefile:connected-folder:open-path", { connectedFolderId, path, action })
    ),
    openPathWith: (connectedFolderId: string, path: string) => ipcRenderer.invoke("amplefile:connected-folder:open-path-with", { connectedFolderId, path }),
    startDrag: (connectedFolderId: string, path: string) => ipcRenderer.invoke("amplefile:connected-folder:start-drag", { connectedFolderId, path }),
    previewFile: (connectedFolderId: string, path: string) => ipcRenderer.invoke("amplefile:connected-folder:preview-file", { connectedFolderId, path }),
    ...(process.platform === "darwin" ? {
      popupFileMenu: (request: {
        connectedFolderId: string;
        standardFolderId?: string;
        path: string;
        kind: "file" | "folder";
        capabilities: { open: boolean; attach: boolean; history: boolean; upload: boolean; rename: boolean; delete: boolean; worker?: boolean; organize?: boolean; paste?: boolean };
        selection?: { files: number; folders: number };
        point: { x: number; y: number };
      }) => ipcRenderer.invoke("amplefile:connected-folder:popup-file-menu", request),
      popupTabMenu: (request: {
        chat?: { lifecycle: "active" | "snoozed" | "archived"; snooze: Array<{ id: string; label: string; detail: string }> };
        tab?: { hasOthers: boolean; hasRight: boolean; canReopen: boolean };
        point: { x: number; y: number };
      }) => ipcRenderer.invoke("amplefile:connected-folder:popup-tab-menu", request),
      popupHeaderMenu: (request: {
        actions: {
          newChat: boolean; customize: boolean; setUp: boolean; reveal: boolean; skills?: boolean; settings?: boolean; manage?: boolean;
          putToWork?: boolean; removeFromSidebar?: boolean; createConnectedFolder?: boolean; useExistingFolder?: boolean; remove?: boolean;
        };
        point: { x: number; y: number };
      }) => ipcRenderer.invoke("amplefile:connected-folder:popup-header-menu", request),
    } : {}),
    setActiveConnectedFolder: (connectedFolderId: string | null) => ipcRenderer.invoke("amplefile:connected-folder:set-active-connected-folder", connectedFolderId),
    onOpenConnectedFolder: (callback: (connectedFolderId: string) => void) => {
      let disposed = false;
      const deliveredTokens = new Set<string>();
      const deliver = (value: unknown) => {
        if (disposed || !value || typeof value !== "object" || Array.isArray(value)) return;
        const request = value as { token?: unknown; connectedFolderId?: unknown };
        if (typeof request.token !== "string" || !request.token || request.token.length > 128
          || typeof request.connectedFolderId !== "string" || !request.connectedFolderId || request.connectedFolderId.length > 512) return;
        if (deliveredTokens.has(request.token)) return;
        deliveredTokens.add(request.token);
        if (deliveredTokens.size > 32) deliveredTokens.delete(deliveredTokens.values().next().value as string);
        callback(request.connectedFolderId);
        ipcRenderer.send("amplefile:connected-folder:ack-open-connected-folder", request.token);
      };
      const listener = (_event: unknown, value: unknown) => deliver(value);
      ipcRenderer.on("amplefile:connected-folder:open-connected-folder", listener);
      void ipcRenderer.invoke("amplefile:connected-folder:take-open-connected-folder").then(deliver).catch(() => undefined);
      return () => {
        disposed = true;
        ipcRenderer.removeListener("amplefile:connected-folder:open-connected-folder", listener);
      };
    },
    onOpenFolder: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("amplefile:menu:open-folder", listener);
      return () => ipcRenderer.removeListener("amplefile:menu:open-folder", listener);
    },
  },
  // Desktop, Documents, and Downloads in the file manager: the host resolves each folder by id.
  standardFolder: {
    openPath: (standardFolderId: string, path: string, action: "open" | "open-native" | "reveal" = "open") => (
      ipcRenderer.invoke("amplefile:standard-folder:open-path", { standardFolderId, path, action })
    ),
    openPathWith: (standardFolderId: string, path: string) => ipcRenderer.invoke("amplefile:standard-folder:open-path-with", { standardFolderId, path }),
    startDrag: (standardFolderId: string, path: string) => ipcRenderer.invoke("amplefile:standard-folder:start-drag", { standardFolderId, path }),
    previewFile: (standardFolderId: string, path: string) => ipcRenderer.invoke("amplefile:standard-folder:preview-file", { standardFolderId, path }),
    trash: (standardFolderId: string, paths: string[]) => ipcRenderer.invoke("amplefile:standard-folder:trash", { standardFolderId, paths }),
    add: () => ipcRenderer.invoke("amplefile:standard-folder:add"),
  },
  fileClipboard: {
    write: (paths: string[]) => ipcRenderer.invoke("amplefile:file-clipboard:write", paths),
    paste: (request: { target: { place: { kind: "connected-folder" | "standard"; id: string }; path: string }; mode: "copy" | "move"; internal: { place: { kind: "connected-folder" | "standard"; id: string }; paths: string[]; nativePaths: string[] } | null }) => ipcRenderer.invoke("amplefile:file-clipboard:paste", request),
  },
  agent: {
    // A file dropped on the AmpleFile agent panel becomes a path reference, as in the popover.
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file) ?? "";
      } catch {
        return "";
      }
    },
    openAmpleFileAgentDraft: (text: string) => ipcRenderer.invoke("amplefile:agent:open-agent-draft", text),
    onOpenSettings: (callback: (scope?: "agent") => void) => {
      const listener = (_event: unknown, scope: unknown) => callback(scope === "agent" ? "agent" : undefined);
      ipcRenderer.on("amplefile:agent:open-settings", listener);
      return () => ipcRenderer.removeListener("amplefile:agent:open-settings", listener);
    },
  },
  // Main-window-only Automation management. The popover preload deliberately
  // omits this namespace; the matching main-process handlers also validate
  // the exact main renderer before reaching the in-process Settings facade.
  automations: {
    list: () => ipcRenderer.invoke("amplefile:automations:list"),
    proposals: () => ipcRenderer.invoke("amplefile:automations:proposals"),
    enableProposal: (path: string) => ipcRenderer.invoke("amplefile:automations:enable-proposal", path),
    show: (automationId: string) => ipcRenderer.invoke("amplefile:automations:show", automationId),
    history: (automationId: string) => ipcRenderer.invoke("amplefile:automations:history", automationId),
    enable: (automationId: string) => ipcRenderer.invoke("amplefile:automations:enable", automationId),
    enableTemplate: (connectedFolderId: string, templateId: string) => ipcRenderer.invoke("amplefile:automations:enable-template", { connectedFolderId, templateId }),
    run: (automationId: string) => ipcRenderer.invoke("amplefile:automations:run", automationId),
    stop: (automationId: string) => ipcRenderer.invoke("amplefile:automations:stop", automationId),
    disable: (automationId: string) => ipcRenderer.invoke("amplefile:automations:disable", automationId),
    delete: (automationId: string) => ipcRenderer.invoke("amplefile:automations:delete", automationId),
  },
  restrictedApps: {
    mountView: (request: unknown) => ipcRenderer.invoke("amplefile:restricted-app-view:mount", request),
    layoutView: (request: unknown) => ipcRenderer.send("amplefile:restricted-app-view:layout", request),
    unmountView: (mountId: string) => ipcRenderer.invoke("amplefile:restricted-app-view:unmount", mountId),
    onTabCommand: (callback: (command: unknown) => void) => {
      const listener = (_event: unknown, command: unknown) => callback(command);
      ipcRenderer.on("amplefile:restricted-app-view:tab-command", listener);
      return () => ipcRenderer.removeListener("amplefile:restricted-app-view:tab-command", listener);
    },
    onViewState: (callback: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on("amplefile:restricted-app-view:state", listener);
      return () => ipcRenderer.removeListener("amplefile:restricted-app-view:state", listener);
    },
    attentionStates: () => ipcRenderer.invoke("amplefile:restricted-app-view:attention-states"),
    onAttention: (callback: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on("amplefile:restricted-app-view:attention", listener);
      return () => ipcRenderer.removeListener("amplefile:restricted-app-view:attention", listener);
    },
    onOpenRequest: (callback: (owner: unknown) => void) => {
      const listener = (_event: unknown, owner: unknown) => callback(owner);
      ipcRenderer.on("amplefile:restricted-app-view:open-request", listener);
      return () => ipcRenderer.removeListener("amplefile:restricted-app-view:open-request", listener);
    },
  },
  // The built-in browser's tabs (docs/built-in-browser.md). Pages run in the
  // main process; this renderer only places them and shows their state.
  browser: {
    mount: (request: unknown) => ipcRenderer.invoke("amplefile:browser:mount", request),
    layout: (request: unknown) => ipcRenderer.send("amplefile:browser:layout", request),
    unmount: (pageId: string) => ipcRenderer.invoke("amplefile:browser:unmount", pageId),
    navigate: (pageId: string, address: string) => ipcRenderer.invoke("amplefile:browser:navigate", pageId, address),
    command: (pageId: string, command: unknown) => ipcRenderer.invoke("amplefile:browser:command", pageId, command),
    close: (pageId: string) => ipcRenderer.invoke("amplefile:browser:close", pageId),
    respondPermission: (pageId: string, requestId: string, decision: "allow" | "block") => ipcRenderer.invoke("amplefile:browser:respond-permission", pageId, requestId, decision),
    sync: (tabs: unknown) => ipcRenderer.send("amplefile:browser:sync", tabs),
    states: () => ipcRenderer.invoke("amplefile:browser:states"),
    showDownload: (path: string) => ipcRenderer.invoke("amplefile:browser:show-download", path),
    suggest: (text: string) => ipcRenderer.invoke("amplefile:browser:suggest", text),
    popupTabMenu: (pageId: string, url: string, point: { x: number; y: number }, options: { canReopen: boolean; hasOthers: boolean }) => ipcRenderer.invoke("amplefile:browser:popup-tab-menu", pageId, url, point, options),
    recent: () => ipcRenderer.invoke("amplefile:browser:recent"),
    clearHistory: () => ipcRenderer.invoke("amplefile:browser:clear-history"),
    onState: (callback: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on("amplefile:browser:state", listener);
      return () => ipcRenderer.removeListener("amplefile:browser:state", listener);
    },
    onOpenTab: (callback: (command: unknown) => void) => {
      const listener = (_event: unknown, command: unknown) => callback(command);
      ipcRenderer.on("amplefile:browser:open-tab", listener);
      return () => ipcRenderer.removeListener("amplefile:browser:open-tab", listener);
    },
    onCloseTab: (callback: (command: unknown) => void) => {
      const listener = (_event: unknown, command: unknown) => callback(command);
      ipcRenderer.on("amplefile:browser:close-tab", listener);
      return () => ipcRenderer.removeListener("amplefile:browser:close-tab", listener);
    },
    onShortcut: (callback: (shortcut: unknown) => void) => {
      const listener = (_event: unknown, shortcut: unknown) => callback(shortcut);
      ipcRenderer.on("amplefile:browser:shortcut", listener);
      return () => ipcRenderer.removeListener("amplefile:browser:shortcut", listener);
    },
    onFindResult: (callback: (result: unknown) => void) => {
      const listener = (_event: unknown, result: unknown) => callback(result);
      ipcRenderer.on("amplefile:browser:find-result", listener);
      return () => ipcRenderer.removeListener("amplefile:browser:find-result", listener);
    },
    onDownload: (callback: (download: unknown) => void) => {
      const listener = (_event: unknown, download: unknown) => callback(download);
      ipcRenderer.on("amplefile:browser:download", listener);
      return () => ipcRenderer.removeListener("amplefile:browser:download", listener);
    },
  },
  window: {
    material: windowMaterial,
    setTheme: (theme: "light" | "dark", source?: "light" | "dark" | "system") => ipcRenderer.send("amplefile:window:set-theme", theme, source),
    railTooltip: {
      show: (request: unknown) => ipcRenderer.send("amplefile:window:rail-tooltip-show", request),
      hide: () => ipcRenderer.send("amplefile:window:rail-tooltip-hide"),
    },
    getAccentColor: () => ipcRenderer.invoke("amplefile:window:accent-color"),
    getCloseToTray: () => ipcRenderer.invoke("amplefile:window:get-close-to-tray"),
    setCloseToTray: (enabled: boolean) => ipcRenderer.invoke("amplefile:window:set-close-to-tray", enabled),
    onAccentColorChanged: (callback: (accent: string | null) => void) => {
      const listener = (_event: unknown, accent: string | null) => callback(accent);
      ipcRenderer.on("amplefile:window:accent-color-changed", listener);
      return () => ipcRenderer.removeListener("amplefile:window:accent-color-changed", listener);
    },
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("amplefile:shell:open-external", url),
  },
  updates: {
    getStatus: () => ipcRenderer.invoke("amplefile:updates:status"),
    check: () => ipcRenderer.invoke("amplefile:updates:check"),
    install: () => ipcRenderer.invoke("amplefile:updates:install"),
    updateNow: () => ipcRenderer.invoke("amplefile:updates:update-now"),
    onStatusChanged: (callback: (status: unknown) => void) => {
      const listener = (_event: unknown, status: unknown) => callback(status);
      ipcRenderer.on("amplefile:updates:status-changed", listener);
      return () => ipcRenderer.removeListener("amplefile:updates:status-changed", listener);
    },
  },
  settings: {
    getStatus: () => ipcRenderer.invoke("amplefile:settings:status"),
  },
  commandLine: {
    status: () => ipcRenderer.invoke("amplefile:command-line:status"),
    installPath: () => ipcRenderer.invoke("amplefile:command-line:install-path"),
    removePath: () => ipcRenderer.invoke("amplefile:command-line:remove-path"),
    installSkill: (target: "claude" | "codex") => ipcRenderer.invoke("amplefile:command-line:install-skill", target),
    removeSkill: (target: "claude" | "codex") => ipcRenderer.invoke("amplefile:command-line:remove-skill", target),
    skill: () => ipcRenderer.invoke("amplefile:command-line:skill"),
  },
  menu: {
    setState: (state: unknown) => ipcRenderer.send("amplefile:menu:set-state", state),
    popup: (menuId: unknown, bounds: unknown) => ipcRenderer.invoke("amplefile:menu:popup", menuId, bounds),
    onCommand: (callback: (command: unknown) => void) => {
      const listener = (_event: unknown, command: unknown) => callback(command);
      ipcRenderer.on("amplefile:menu-command", listener);
      return () => ipcRenderer.removeListener("amplefile:menu-command", listener);
    },
  },
});
