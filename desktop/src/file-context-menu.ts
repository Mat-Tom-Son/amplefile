import { isAbsolute } from "node:path";
import { fileMenuItems, type FileMenuCapabilities, type FileMenuCommand, type FileMenuItem } from "../../src/shared/file-menu.js";
import type { NativeFileMenuRequest } from "../../src/shared/desktop-ipc.js";

export type NativeFileMenuCommand = FileMenuCommand;

export type NativeFileMenuItem = FileMenuItem;

const requestKeys = new Set(["connectedFolderId", "standardFolderId", "path", "kind", "capabilities", "selection", "point"]);
const capabilityKeys = new Set(["open", "attach", "history", "upload", "rename", "delete", "worker", "organize", "paste", "extract", "link", "original", "package", "newTab", "newWindow", "terminal"]);
const optionalCapabilityKeys = new Set(["worker", "organize", "paste", "extract", "link", "original", "package", "newTab", "newWindow", "terminal"]);
const pointKeys = new Set(["x", "y"]);
const selectionKeys = new Set(["files", "folders"]);
const maxSelectionCount = 1_000_000;

export function parseNativeFileMenuRequest(value: unknown): NativeFileMenuRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) throw new Error("The native file menu request is invalid.");
  const connectedFolderId = typeof value.connectedFolderId === "string" ? value.connectedFolderId.trim() : "";
  const standardFolderId = typeof value.standardFolderId === "string" ? value.standardFolderId.trim() : "";
  if (typeof value.path !== "string") throw new Error("A safe relative Connected Folder path is required.");
  const path = value.path;
  const kind = value.kind;
  const capabilities = value.capabilities;
  const point = value.point;
  if (value.standardFolderId !== undefined) {
    if (connectedFolderId || !standardFolderId || standardFolderId.length > 64) throw new Error("A valid standard folder id is required.");
  } else if (!connectedFolderId || connectedFolderId.length > 512) throw new Error("A valid Connected Folder id is required.");
  if (path.length > 4096 || path.includes("\0") || isAbsolute(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path)) {
    throw new Error("A safe relative Connected Folder path is required.");
  }
  if (kind !== "file" && kind !== "folder") throw new Error("A valid Connected Folder entry kind is required.");
  if (!path && kind !== "folder") throw new Error("The Connected Folder root must be a folder.");
  if (!isRecord(capabilities) || !hasOnlyKeys(capabilities, capabilityKeys)) throw new Error("Native file menu capabilities are invalid.");
  if (!isRecord(point) || !hasOnlyKeys(point, pointKeys)) throw new Error("The native file menu position is invalid.");
  for (const key of capabilityKeys) {
    if (optionalCapabilityKeys.has(key) && capabilities[key] === undefined) continue;
    if (typeof capabilities[key] !== "boolean") throw new Error("Native file menu capabilities are invalid.");
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("The native file menu position is invalid.");
  const selection = value.selection === undefined ? undefined : parseSelection(value.selection);
  return {
    connectedFolderId,
    ...(standardFolderId ? { standardFolderId } : {}),
    path,
    kind,
    capabilities: {
      open: capabilities.open as boolean,
      attach: capabilities.attach as boolean,
      history: capabilities.history as boolean,
      upload: capabilities.upload as boolean,
      rename: capabilities.rename as boolean,
      delete: capabilities.delete as boolean,
      ...(capabilities.worker === true ? { worker: true } : {}),
      ...(capabilities.organize === true ? { organize: true } : {}),
      ...(capabilities.paste === true ? { paste: true } : {}),
      ...(capabilities.extract === true ? { extract: true } : {}),
      ...(capabilities.link === true ? { link: true } : {}),
      ...(capabilities.original === true ? { original: true } : {}),
      ...(capabilities.package === true ? { package: true } : {}),
      ...(capabilities.newTab === true ? { newTab: true } : {}),
      ...(capabilities.newWindow === true ? { newWindow: true } : {}),
      ...(capabilities.terminal === true ? { terminal: true } : {}),
    },
    ...(selection ? { selection } : {}),
    point: {
      x: Math.max(0, Math.min(1_000_000, Math.round(point.x as number))),
      y: Math.max(0, Math.min(1_000_000, Math.round(point.y as number))),
    },
  };
}

function parseSelection(value: unknown): { files: number; folders: number } {
  if (!isRecord(value) || !hasOnlyKeys(value, selectionKeys)) throw new Error("The native file menu selection is invalid.");
  const { files, folders } = value;
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= maxSelectionCount;
  if (!count(files) || !count(folders) || files + folders < 2) throw new Error("The native file menu selection is invalid.");
  return { files, folders };
}

/** The native menu's items: the window's own item menu, from the same list (src/shared/file-menu.ts). */
export function nativeFileMenuItems(request: NativeFileMenuRequest, platform: NodeJS.Platform = "darwin"): NativeFileMenuItem[] {
  return fileMenuItems(request, platform);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
