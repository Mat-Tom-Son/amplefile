import type { NativeConnectedFolderMenuCommand, NativeConnectedFolderMenuRequest } from "../../src/shared/desktop-ipc.js";

export type NativeConnectedFolderMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; command: NativeConnectedFolderMenuCommand };

const requestKeys = new Set(["actions", "point"]);
const actionKeys = new Set(["newChat", "customize", "organize", "reveal"]);
const optionalActionKeys = new Set(["skills", "settings", "manage", "putToWork", "removeFromSidebar", "createConnectedFolder", "useExistingFolder", "remove", "removeDeletes", "openInNewTab", "openInNewWindow", "openTerminal"]);
const pointKeys = new Set(["x", "y"]);

export function parseNativeConnectedFolderMenuRequest(value: unknown): NativeConnectedFolderMenuRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) throw new Error("The Connected Folder menu request is invalid.");
  const { actions, point } = value;
  if (!isRecord(actions) || !hasOnlyKeys(actions, new Set([...actionKeys, ...optionalActionKeys]))
    || ![...actionKeys].every((key) => typeof actions[key] === "boolean")
    || ![...optionalActionKeys].every((key) => actions[key] === undefined || typeof actions[key] === "boolean")) {
    throw new Error("The Connected Folder menu request is invalid.");
  }
  if (!isRecord(point) || !hasOnlyKeys(point, pointKeys) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("The Connected Folder menu position is invalid.");
  }
  return {
    actions: {
      newChat: actions.newChat as boolean,
      customize: actions.customize as boolean,
      organize: actions.organize as boolean,
      reveal: actions.reveal as boolean,
      ...(actions.skills === true ? { skills: true } : {}),
      ...(actions.settings === true ? { settings: true } : {}),
      ...(actions.manage === false ? { manage: false } : {}),
      ...(actions.putToWork === true ? { putToWork: true } : {}),
      ...(actions.removeFromSidebar === true ? { removeFromSidebar: true } : {}),
      ...(actions.createConnectedFolder === true ? { createConnectedFolder: true } : {}),
      ...(actions.useExistingFolder === true ? { useExistingFolder: true } : {}),
      ...(actions.remove === true ? { remove: true } : {}),
      ...(actions.removeDeletes === true ? { removeDeletes: true } : {}),
      ...(actions.openInNewTab === true ? { openInNewTab: true } : {}),
      ...(actions.openInNewWindow === true ? { openInNewWindow: true } : {}),
      ...(actions.openTerminal === true ? { openTerminal: true } : {}),
    },
    point: {
      x: Math.max(0, Math.min(1_000_000, Math.round(point.x as number))),
      y: Math.max(0, Math.min(1_000_000, Math.round(point.y as number))),
    },
  };
}

export function nativeConnectedFolderMenuItems(request: NativeConnectedFolderMenuRequest, platform: NodeJS.Platform = "darwin"): NativeConnectedFolderMenuItem[] {
  const { actions } = request;
  const items: NativeConnectedFolderMenuItem[] = [];
  if (actions.openInNewTab) items.push({ type: "item", label: "Open in New Tab", command: "open-in-new-tab" });
  if (actions.openInNewWindow) items.push({ type: "item", label: "Open in New Window", command: "open-in-new-window" });
  if (actions.createConnectedFolder) items.push({ type: "item", label: "New Connected Folder…", command: "create-connected-folder" });
  if (actions.useExistingFolder) items.push({ type: "item", label: "Connect Folder…", command: "use-existing-folder" });
  if (actions.newChat) items.push({ type: "item", label: "New Chat", command: "new-chat" });
  if (actions.customize) items.push({ type: "item", label: "Customize Connected Folder", command: "customize" });
  if (actions.organize) items.push({ type: "item", label: "Organize", command: "organize" });
  if (actions.openTerminal) items.push({ type: "item", label: "Open Terminal Here", command: "open-terminal" });
  if (actions.reveal && platform !== "linux") items.push({ type: "item", label: platform === "darwin" ? "Show in Finder" : platform === "win32" ? "Show in File Explorer" : "Show in File Manager", command: "reveal" });
  if (actions.putToWork) items.push({ type: "item", label: "Connect This Folder", command: "put-to-work" });
  if (actions.skills) items.push({ type: "item", label: "Skills & Extensions…", command: "skills" });
  const tail: NativeConnectedFolderMenuItem[] = [];
  if (actions.removeFromSidebar) tail.push({ type: "item", label: "Remove from Sidebar", command: "remove-from-sidebar" });
  if (actions.remove) tail.push({ type: "item", label: actions.removeDeletes ? "Delete Connected Folder…" : "Disconnect…", command: "remove-connected-folder" });
  if (actions.manage !== false) tail.push({ type: "item", label: "Manage Connected Folders", command: "manage" });
  if (actions.settings) tail.push({ type: "item", label: "Settings…", command: "settings" });
  if (items.length && tail.length) items.push({ type: "separator" });
  items.push(...tail);
  return items;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
