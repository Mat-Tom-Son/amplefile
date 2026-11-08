import type React from "react";
import { connectedFolderPathDragType, connectedFolderPathsDragType } from "../constants";
import { desktopPlatform, type DesktopPlatform } from "./platform";
import { fileExtension } from "./tree";
import type { TreeEntry } from "../types";

function nativeOpenLabel(entry: TreeEntry, platform: DesktopPlatform = desktopPlatform()): { text: string; office: boolean } {
  if (entry.kind === "folder") return { text: "Open Folder", office: false };
  const extension = fileExtension(entry.path);
  if ([".doc", ".docm", ".dot", ".dotm", ".xls", ".xlsb", ".xlsm", ".ppt", ".pptm"].includes(extension)) return { text: revealInFileManagerLabel(platform), office: true };
  if ([".docx", ".dotx"].includes(extension)) return { text: "Open in Word", office: true };
  if ([".xlsx", ".csv"].includes(extension)) return { text: "Open in Excel", office: true };
  if ([".pptx", ".potx"].includes(extension)) return { text: "Open in PowerPoint", office: true };
  return { text: "Open", office: false };
}

function canOpenDirectly(path: string): boolean {
  const extension = fileExtension(path);
  return new Set([
    ".pdf",
    ".docx",
    ".dotx",
    ".xlsx",
    ".csv",
    ".pptx",
    ".potx",
    ".txt",
    ".md",
    ".markdown",
    ".rtf",
    ".json",
    ".xml",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
  ]).has(extension);
}

function revealInFileManagerLabel(platform: DesktopPlatform = desktopPlatform()): string {
  if (platform === "win32") return "Show in File Explorer";
  if (platform === "darwin") return "Show in Finder";
  return "Show in File Manager";
}

function hasNativeFiles(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function hasConnectedFolderPathDrag(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(connectedFolderPathDragType);
}

/**
 * The rows a Files drag carries: every selected row when several were dragged
 * together, else the one row. A single-row drag also sets the one-path type,
 * which older drop targets read.
 */
function draggedConnectedFolderPaths(dataTransfer: DataTransfer): string[] {
  try {
    const several: unknown = JSON.parse(dataTransfer.getData(connectedFolderPathsDragType) || "null");
    if (Array.isArray(several) && several.length && several.every((path) => typeof path === "string" && path)) return several;
  } catch { /* not a several-row drag */ }
  const one = dataTransfer.getData(connectedFolderPathDragType) || dataTransfer.getData("text/plain");
  return one ? [one] : [];
}

export { canOpenDirectly, draggedConnectedFolderPaths, hasNativeFiles, hasConnectedFolderPathDrag, nativeOpenLabel, revealInFileManagerLabel };
