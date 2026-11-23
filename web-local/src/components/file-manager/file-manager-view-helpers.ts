import type { KeyboardEvent } from "react";

import { untitledChatLabel } from "../../constants";
import { placeKey, type FileManagerPlace } from "./file-manager-places";

/**
 * Small helpers the file manager window's parts share: the desktop calls for
 * one place's files, DOM ids, and path comparisons. None of them holds state.
 */

/** What the window puts on a drag inside it where the desktop has no drag of its own (the browser preview). */
export const internalDragType = "application/x-amplefile-items";

/** The desktop calls for one place's files. */
export interface PlaceFileBridge {
  open: (path: string, action: "open" | "open-native" | "reveal") => Promise<void>;
  openWith: ((path: string) => Promise<{ opened: boolean; canceled: boolean; appName: string | null }>) | null;
  drag: (paths: string[]) => Promise<unknown>;
  preview: (path: string) => Promise<boolean>;
}

export function placeFileBridge(place: FileManagerPlace): PlaceFileBridge | null {
  const desktop = window.ampleFileDesktop;
  if (place.kind === "connected-folder" && desktop?.connectedFolder) {
    const files = desktop.connectedFolder;
    const openWith = files.openPathWith;
    return {
      open: (path, action) => path ? files.openPath(place.id, path, action) : files.revealFolder(place.id),
      openWith: openWith ? (path) => openWith(place.id, path) : null,
      drag: (path) => files.startDrag(place.id, path),
      preview: (path) => files.previewFile(place.id, path),
    };
  }
  if (place.kind === "standard" && desktop?.standardFolder) {
    const files = desktop.standardFolder;
    return {
      open: (path, action) => files.openPath(place.id, path, action),
      openWith: (path) => files.openPathWith(place.id, path),
      drag: (path) => files.startDrag(place.id, path),
      preview: (path) => files.previewFile(place.id, path),
    };
  }
  return null;
}

/** A file in Recents: where it lives, and when it last changed. */
export interface RecentItem { place: FileManagerPlace; path: string; name: string; kind: "file"; sizeBytes?: number; updatedAt: string; where: string }

export function recentKey(item: RecentItem): string {
  return `${placeKey(item.place)}\0${item.path}`;
}

/** Titles a Chat carries before it has its own: the server's seed, the renderer's label, and an old default. */
const placeholderChatTitles = new Set([untitledChatLabel, "New Chat", "amplefile chat"].map((title) => title.toLocaleLowerCase()));

/** A Chat's own title once it has one; until then the panel keeps the person's words. */
export function chatTitleOrNull(title: string | null | undefined): string | null {
  const trimmed = title?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed && !placeholderChatTitles.has(trimmed.toLocaleLowerCase()) ? trimmed : null;
}

/** A letter key by its physical key (⌥ changes the letter it types), or by the letter when no code is given. */
export function letterKey(event: Pick<KeyboardEvent<HTMLElement>, "code" | "altKey" | "key">, letter: string): boolean {
  return event.code === `Key${letter.toUpperCase()}` || (!event.code && !event.altKey && event.key.toLowerCase() === letter);
}

export function hiddenKey(place: FileManagerPlace, path: string): string {
  return `${placeKey(place)}\0${path}`;
}

/** A Recents or search row's id, for the list's aria-activedescendant. */
export function listItemDomId(kind: "recent" | "result", key: string): string {
  return `fm-${kind}-${encodeURIComponent(key).replace(/%/g, "_")}`;
}

export function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

export function joinNative(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${path}`;
}

export function sameFolder(first: string, second: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
  return normalize(first) === normalize(second);
}

/** The desktop's error for a failed call, without Electron's "Error invoking remote method" wrapper. */
export function desktopErrorText(text: string): string {
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}
