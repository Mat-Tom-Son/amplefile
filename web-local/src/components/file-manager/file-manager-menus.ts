import { canOpenDirectly } from "../../lib/file-actions";
import { isExtractableArchive, type FileMenuCapabilities } from "../../../../src/shared/file-menu";
import type { TreeEntry } from "../../types";
import type { FileManagerPlace } from "./file-manager-places";

/** One item in the window's own menu (Linux, Windows, and the browser preview); "-" is a separator. */
export interface QuickMenuItem { label: string; command: string }

/** The window's own menu at a point, and what runs when an item is chosen (null when the menu is dismissed). */
export interface QuickMenuState { x: number; y: number; items: QuickMenuItem[]; run: (command: string | null) => void }

/** What one row (or the folder shown, when `isItem` is false) offers in its menu. */
export function itemMenuCapabilities(target: TreeEntry, isItem: boolean, where: { place: FileManagerPlace; fixtureMode: boolean; canPaste: boolean; newWindow?: boolean }): FileMenuCapabilities {
  if (target.link) {
    const there = target.link.target !== "missing";
    return { open: there, original: there, attach: false, history: false, upload: false, rename: true, delete: true, organize: true, link: true };
  }
  return {
    open: target.kind === "folder" || canOpenDirectly(target.path),
    newTab: isItem && target.kind === "folder",
    newWindow: isItem && target.kind === "folder" && Boolean(where.newWindow),
    attach: false,
    history: where.place.kind === "connected-folder" && target.kind === "file",
    upload: false,
    rename: Boolean(target.path) && !target.nestedFolder,
    delete: isItem && !target.nestedFolder,
    worker: !where.fixtureMode && target.kind === "folder" && !target.nestedFolder && (where.place.kind === "standard" || Boolean(target.path)),
    organize: isItem && !target.nestedFolder,
    paste: target.kind === "folder" && !target.nestedFolder && where.canPaste,
    extract: isItem && target.kind === "file" && isExtractableArchive(target.name),
  };
}

/** Several rows: only what applies to all of them; a nested Connected Folder among them is changed only from itself. */
export function selectionMenuCapabilities(several: readonly TreeEntry[]): FileMenuCapabilities {
  const locked = several.some((item) => item.nestedFolder);
  return { open: false, attach: false, history: false, upload: false, rename: false, delete: !locked, organize: !locked };
}

