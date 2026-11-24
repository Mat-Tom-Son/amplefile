import { useState, type MouseEvent } from "react";

import { errorText } from "../../lib/api";
import { revealInFileManagerLabel } from "../../lib/file-actions";
import { desktopPlatform } from "../../lib/platform";
import { fileMenuItems } from "../../../../src/shared/file-menu";
import type { ConnectedFolderSummary, TreeEntry } from "../../types";
import { parentPath } from "./file-manager-model";
import type { FileManagerLocation, FileManagerPlace, StandardFolderSummary } from "./file-manager-places";
import { itemMenuCapabilities, selectionMenuCapabilities, type QuickMenuItem, type QuickMenuState } from "./file-manager-menus";
import type { PlaceFileBridge } from "./file-manager-view-helpers";

/** The Action menu's Connected Folder (null for the place shown when it is not one) and where the window's own copy of it is drawn. */
export interface ActionMenuState { target: ConnectedFolderSummary | null; x: number; y: number; /** Opened from the sidebar, which offers Open in New Tab (and Open in New Window where the desktop has windows). */ sidebar?: boolean; newWindow?: boolean; terminal?: boolean }

/** What the menus' items do; each is the window's own action, run as if its button or key had been used. */
export interface FileManagerMenuActions {
  openEntry: (entry: TreeEntry) => Promise<void>;
  /** Open in New Tab: a folder row, or a sidebar place's top. */
  openEntryInNewTab: (entry: TreeEntry) => void;
  openEntryInNewWindow: (entry: TreeEntry) => void;
  /** Show Package Contents: the window goes inside a Mac package. */
  showPackageContents: (entry: TreeEntry) => Promise<void>;
  openPlaceInNewTab: (place: FileManagerPlace) => void;
  /** Open in New Window, where the desktop can open another window (null elsewhere). */
  openInNewWindow: ((where: FileManagerLocation) => void) | null;
  openLocal: (path: string, action: "reveal" | "open" | "open-native" | "open-with") => Promise<void>;
  openTerminal: (where: FileManagerLocation) => Promise<void>;
  showOriginal: (entry: TreeEntry) => Promise<void>;
  copyPaths: (paths: readonly string[]) => Promise<void>;
  showVersionHistory: ((entry: TreeEntry) => void) | null;
  requestNewFolder: (parent: string) => void;
  refresh: () => Promise<unknown>;
  putToWork: (path: string, target?: FileManagerPlace) => Promise<void>;
  requestRename: (entry: TreeEntry | undefined) => void;
  deletePaths: (paths: readonly string[]) => Promise<void>;
  copySelection: (entries?: TreeEntry[]) => Promise<void>;
  cutSelection: (entries?: TreeEntry[]) => Promise<void>;
  pasteInto: (targetPath?: string, mode?: "copy" | "move") => Promise<void>;
  duplicateSelection: (entries?: TreeEntry[]) => Promise<void>;
  compressSelection: (entries?: TreeEntry[]) => Promise<void>;
  extractArchive: (entry: TreeEntry) => Promise<void>;
  groupSelection: (entries?: TreeEntry[]) => Promise<void>;
  canPaste: () => Promise<boolean>;
  // The Action menu and the sidebar's menus.
  openSettings: () => void;
  customize: (target: ConnectedFolderSummary) => void;
  removeConnectedFolder: (target: ConnectedFolderSummary) => Promise<void>;
  openSkills: (target: ConnectedFolderSummary) => void;
  organize: (target: ConnectedFolderSummary) => void;
  removeStandardFolder: (folder: StandardFolderSummary) => Promise<void>;
  createConnectedFolder: () => void;
  connectFolder: () => void;
}

export interface FileManagerMenusContext {
  mac: boolean;
  fixtureMode: boolean;
  place: FileManagerPlace;
  location: FileManagerLocation;
  placeName: string;
  bridge: PlaceFileBridge | null;
  selection: readonly string[];
  selected: ReadonlySet<string>;
  byPath: ReadonlyMap<string, TreeEntry>;
  select: (paths: string[]) => void;
  actions: FileManagerMenuActions;
  onError: (message: string | null) => void;
}

/**
 * The window's menus: the item menu (src/shared/file-menu.ts), the Action
 * menu, and the sidebar's menus. On the Mac each is the native menu; elsewhere
 * the window draws its own with the same items (FileManagerMenus.tsx).
 */
export function useFileManagerMenus(context: FileManagerMenusContext) {
  const { mac, fixtureMode, place, location, placeName, bridge, selection, selected, byPath, select, actions, onError } = context;
  const [quickMenu, setQuickMenu] = useState<QuickMenuState | null>(null);
  const [actionMenu, setActionMenu] = useState<ActionMenuState | null>(null);
  const desktop = window.ampleFileDesktop;
  const terminal = !fixtureMode && Boolean(desktop?.openTerminal);

  /** A small menu at the pointer: the native one on the Mac, the in-window one elsewhere. */
  async function popupMenu(event: MouseEvent<HTMLElement>, menuActions: Partial<Record<"reveal" | "putToWork" | "removeFromSidebar" | "createConnectedFolder" | "useExistingFolder" | "openInNewTab" | "openInNewWindow", boolean>>, fallback: QuickMenuItem[], run: (command: string | null) => void) {
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget.getBoundingClientRect();
    const point = event.type === "contextmenu"
      ? { x: Math.round(event.clientX), y: Math.round(event.clientY) }
      : { x: Math.round(anchor.left), y: Math.round(anchor.bottom + 4) };
    const popup = window.ampleFileDesktop?.connectedFolder.popupHeaderMenu;
    if (mac && popup) {
      try { run(await popup({ actions: { newChat: false, customize: false, organize: false, reveal: false, manage: false, ...menuActions }, point })); }
      catch (caught) { onError(errorText(caught)); }
      return;
    }
    setQuickMenu({ x: Math.min(point.x, window.innerWidth - 240), y: Math.min(point.y, window.innerHeight - 160), items: fallback, run });
  }

  /** Right-clicking a Standard Folder: Show in Finder, Connect This Folder, and Remove from Sidebar for one added with +. */
  function openStandardFolderMenu(folder: StandardFolderSummary, event: MouseEvent<HTMLElement>) {
    const target: FileManagerPlace = { kind: "standard", id: folder.id };
    const revealLabel = revealInFileManagerLabel();
    void popupMenu(event, { openInNewTab: true, openInNewWindow: Boolean(actions.openInNewWindow), reveal: true, putToWork: true, removeFromSidebar: Boolean(folder.added) }, [
      { label: "Open in New Tab", command: "open-in-new-tab" },
      ...(actions.openInNewWindow ? [{ label: "Open in New Window", command: "open-in-new-window" }] : []),
      ...(terminal ? [{ label: "Open Terminal Here", command: "open-terminal" }] : []),
      ...(revealLabel ? [{ label: revealLabel, command: "reveal" }] : []),
      { label: "Connect This Folder", command: "put-to-work" },
      ...(folder.added ? [{ label: "Remove from Sidebar", command: "remove-from-sidebar" }] : []),
    ], (command) => {
      if (command === "open-in-new-tab") actions.openPlaceInNewTab(target);
      else if (command === "open-in-new-window") actions.openInNewWindow?.({ place: target, path: "" });
      else if (command === "open-terminal") void actions.openTerminal({ place: target, path: "" });
      else if (command === "reveal") void window.ampleFileDesktop?.standardFolder?.openPath(folder.id, "", "reveal").catch((caught) => onError(errorText(caught)));
      else if (command === "put-to-work") void actions.putToWork("", target);
      else if (command === "remove-from-sidebar") void actions.removeStandardFolder(folder);
    });
  }

  /** The + beside Connected Folders: New Connected Folder or Connect Folder. */
  function openAddConnectedFolderMenu(event: MouseEvent<HTMLElement>) {
    void popupMenu(event, { createConnectedFolder: true, useExistingFolder: true }, [
      { label: "New Connected Folder…", command: "create-connected-folder" },
      { label: "Connect Folder…", command: "use-existing-folder" },
    ], (command) => {
      if (command === "create-connected-folder") actions.createConnectedFolder();
      else if (command === "use-existing-folder") actions.connectFolder();
    });
  }

  /**
   * Finder's Action menu (the toolbar's ⋯, and right-clicking a Connected Folder in
   * the sidebar): the Connected Folder's own commands, then Settings. From the
   * sidebar it starts with Open in New Tab.
   */
  async function openActionMenu(target: ConnectedFolderSummary | null, event: MouseEvent<HTMLElement>, options: { sidebar?: boolean } = {}) {
    const sidebar = Boolean(options.sidebar && target);
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget.getBoundingClientRect();
    const point = event.type === "contextmenu"
      ? { x: Math.round(event.clientX), y: Math.round(event.clientY) }
      : { x: Math.round(anchor.left), y: Math.round(anchor.bottom + 4) };
    const popup = window.ampleFileDesktop?.connectedFolder.popupHeaderMenu;
    if (mac && popup) {
      try {
        const command = await popup({
          actions: { ...(sidebar ? { openInNewTab: true, openInNewWindow: Boolean(actions.openInNewWindow) } : {}), newChat: false, customize: Boolean(target), organize: Boolean(target) && !fixtureMode, reveal: Boolean(bridge) || Boolean(target), skills: Boolean(target), settings: true, manage: false, remove: Boolean(target), removeDeletes: target?.location.storage === "managed" },
          point,
        });
        runActionCommand(command, target);
      } catch (caught) { onError(errorText(caught)); }
      return;
    }
    const height = sidebar ? (terminal ? 248 : 224) : 200;
    setActionMenu({ target, x: Math.min(point.x, window.innerWidth - 240), y: Math.min(point.y, window.innerHeight - height), terminal: sidebar && terminal, ...(sidebar ? { sidebar, newWindow: Boolean(actions.openInNewWindow) } : {}) });
  }

  function runActionCommand(command: string | null, target: ConnectedFolderSummary | null) {
    if (command === "settings") actions.openSettings();
    else if (command === "open-in-new-tab" && target) actions.openPlaceInNewTab({ kind: "connected-folder", id: target.id });
    else if (command === "open-in-new-window" && target) actions.openInNewWindow?.({ place: { kind: "connected-folder", id: target.id }, path: "" });
    else if (command === "open-terminal" && target) void actions.openTerminal({ place: { kind: "connected-folder", id: target.id }, path: "" });
    else if (command === "customize" && target) actions.customize(target);
    else if (command === "remove-connected-folder" && target) void actions.removeConnectedFolder(target);
    else if (command === "skills" && target) actions.openSkills(target);
    else if (command === "organize" && target) actions.organize(target);
    else if (command === "reveal") {
      if (target) void window.ampleFileDesktop?.connectedFolder.revealFolder(target.id).catch((caught) => onError(errorText(caught)));
      else void actions.openLocal("", "reveal");
    }
  }

  /**
   * The item menu (src/shared/file-menu.ts): the native menu on the Mac, the
   * window's own menu elsewhere, with the same items. A link offers Open and
   * Show Original, which reach what it points to, and the ordinary actions,
   * which act on the link itself.
   */
  async function openContextMenu(entry: TreeEntry | null, event: MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    let paths = [...selection];
    if (entry && !selected.has(entry.path)) { paths = [entry.path]; select(paths); }
    if (!entry) { paths = []; select([]); }
    const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    const target: TreeEntry = entry ?? { name: location.path.split("/").pop() || placeName, path: location.path, kind: "folder" };
    const several = entry && paths.length > 1 ? paths.map((path) => byPath.get(path)).filter((item): item is TreeEntry => Boolean(item)) : null;
    const owner = place.kind === "standard" ? { connectedFolderId: "", standardFolderId: place.id } : { connectedFolderId: place.id };
    const capabilities = several ? selectionMenuCapabilities(several) : { ...itemMenuCapabilities(target, Boolean(entry), { place, fixtureMode, canPaste: target.kind === "folder" && !target.link && await actions.canPaste(), newWindow: Boolean(actions.openInNewWindow) }), ...(terminal ? { terminal: true } : {}) };
    const selectionCounts = several ? { files: several.filter((item) => item.kind === "file").length, folders: several.filter((item) => item.kind === "folder").length } : null;
    const run = (command: string | null) => several ? runSelectionCommand(command, several) : runMenuCommand(command, target);
    const popupFileMenu = window.ampleFileDesktop?.connectedFolder.popupFileMenu;
    if (mac && popupFileMenu) {
      try {
        const command = await popupFileMenu({ ...owner, path: target.path, kind: target.kind, capabilities, ...(selectionCounts ? { selection: selectionCounts } : {}), point });
        await run(command);
      } catch (caught) { onError(errorText(caught)); }
      return;
    }
    const items = fileMenuItems({
      ...(place.kind === "standard" ? { standardFolderId: place.id } : {}),
      path: target.path,
      kind: target.kind,
      capabilities,
      ...(selectionCounts ? { selection: selectionCounts } : {}),
    }, desktopPlatform() ?? "browser")
      // Open With needs the desktop's app chooser.
      .filter((item) => item.type === "separator" || item.command !== "open-with" || (!fixtureMode && Boolean(bridge?.openWith)))
      .map((item) => item.type === "separator" ? { label: "", command: "-" } : { label: item.label, command: item.command });
    const height = items.reduce((total, item) => total + (item.command === "-" ? 11 : 24), 12);
    setQuickMenu({
      x: Math.min(point.x, window.innerWidth - 260),
      y: Math.max(8, Math.min(point.y, window.innerHeight - height - 8)),
      items,
      run: (command) => { void run(command); },
    });
  }

  async function runSelectionCommand(command: string | null, several: readonly TreeEntry[]) {
    if (command === "copy-path") await actions.copyPaths(several.map((item) => item.path));
    else if (command === "delete") await actions.deletePaths(several.map((item) => item.path));
    else if (command === "copy") await actions.copySelection([...several]);
    else if (command === "cut") await actions.cutSelection([...several]);
    else if (command === "duplicate") await actions.duplicateSelection([...several]);
    else if (command === "compress") await actions.compressSelection([...several]);
    else if (command === "new-folder-with-selection") await actions.groupSelection([...several]);
  }

  async function runMenuCommand(command: string | null, target: TreeEntry) {
    if (command === "open") await actions.openEntry(target);
    else if (command === "open-in-new-tab") actions.openEntryInNewTab(target);
    else if (command === "open-in-new-window") actions.openEntryInNewWindow(target);
    else if (command === "open-with") await actions.openLocal(target.path, "open-with");
    else if (command === "open-terminal") await actions.openTerminal({ place, path: target.path });
    else if (command === "show-package-contents") await actions.showPackageContents(target);
    else if (command === "reveal") await actions.openLocal(target.path, "reveal");
    else if (command === "show-original") await actions.showOriginal(target);
    else if (command === "copy-path") await actions.copyPaths([target.path]);
    else if (command === "version-history" && actions.showVersionHistory) actions.showVersionHistory(target);
    else if (command === "new-folder") actions.requestNewFolder(target.kind === "folder" ? target.path : parentPath(target.path));
    else if (command === "refresh") await actions.refresh();
    else if (command === "give-worker") await actions.putToWork(target.path);
    else if (command === "rename") actions.requestRename(target);
    else if (command === "delete") await actions.deletePaths([target.path]);
    else if (command === "copy") await actions.copySelection([target]);
    else if (command === "cut") await actions.cutSelection([target]);
    else if (command === "paste") await actions.pasteInto(target.kind === "folder" && !target.link && !target.package ? target.path : parentPath(target.path));
    else if (command === "duplicate") await actions.duplicateSelection([target]);
    else if (command === "compress") await actions.compressSelection([target]);
    else if (command === "extract") await actions.extractArchive(target);
    else if (command === "new-folder-with-selection") await actions.groupSelection([target]);
  }

  return { quickMenu, setQuickMenu, actionMenu, setActionMenu, popupMenu, openStandardFolderMenu, openAddConnectedFolderMenu, openActionMenu, runActionCommand, openContextMenu };
}

export type FileManagerMenus = ReturnType<typeof useFileManagerMenus>;
