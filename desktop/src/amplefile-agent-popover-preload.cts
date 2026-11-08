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

const rawWindowMaterial = argumentValue("window-material");
const windowMaterial = rawWindowMaterial === "vibrancy" ? "vibrancy" : "none";
const productName = argumentValue("product-name");
const internalProtocol = argumentValue("internal-protocol");
// Mirrors maxManagementAttachments; dropped text lands in the composer, so it may be long.
const maxStagedItems = 1_000;
const maxStagedValueLength = 4 * 1024 * 1024;

// This window needs the local API session, fixed popover actions, and opening
// a selected Connected Folder–relative result through the existing checked path handler. Keep
// it separate from the main renderer preload so a UI bug here cannot reach
// folder pickers, restricted-app brokers, updates, settings, or shell actions.
contextBridge.exposeInMainWorld("ampleFileDesktop", {
  desktop: true,
  clipboard: {
    write: (content: { text: string; html?: string }) => ipcRenderer.invoke("amplefile:clipboard:write", content),
  },
  api: {
    baseUrl: argumentValue("api-base-url"),
    getSessionHeaders: () => ipcRenderer.invoke("amplefile:api:session-headers"),
  },
  app: {
    name: productName,
    version: argumentValue("app-version"),
    platform: process.platform,
    iconUrl: internalProtocol ? `${internalProtocol}://app/_desktop-assets/icon-32.png` : "",
  },
  ampleFileAgent: {
    openResultFile: (connectedFolderId: string, path: string) => ipcRenderer.invoke("amplefile:connected-folder:open-path", { connectedFolderId, path, action: "open" }),
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file) ?? "";
      } catch {
        return "";
      }
    },
    hide: () => ipcRenderer.send("amplefile:agent:hide"),
    openMainWindow: () => ipcRenderer.invoke("amplefile:agent:open-main"),
    openAiModelsSettings: () => ipcRenderer.invoke("amplefile:agent:open-ai-models-settings"),
    onStaged: (callback: (items: Array<{ kind: "path" | "text"; value: string }>) => void) => {
      const listener = (_event: unknown, items: unknown) => {
        if (!Array.isArray(items)) return;
        const safe = items.slice(0, maxStagedItems).filter((item): item is { kind: "path" | "text"; value: string } =>
          Boolean(item) && typeof item === "object"
          && ((item as { kind?: unknown }).kind === "path" || (item as { kind?: unknown }).kind === "text")
          && typeof (item as { value?: unknown }).value === "string"
          && (item as { value: string }).value.length <= maxStagedValueLength);
        if (safe.length) callback(safe);
      };
      ipcRenderer.on("amplefile:agent:staged", listener);
      return () => ipcRenderer.removeListener("amplefile:agent:staged", listener);
    },
  },
  window: {
    material: windowMaterial,
    getAccentColor: () => ipcRenderer.invoke("amplefile:window:accent-color"),
    onAccentColorChanged: (callback: (color: string | null) => void) => {
      const listener = (_event: unknown, color: unknown) => callback(typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : null);
      ipcRenderer.on("amplefile:window:accent-color-changed", listener);
      return () => ipcRenderer.removeListener("amplefile:window:accent-color-changed", listener);
    },
  },
});
