import { useRef, useState, type DragEvent } from "react";

import { apiForm, errorText } from "../../lib/api";
import { collectDroppedUploadFiles } from "../../lib/dropped-files";
import { formatItemCount } from "../../lib/format";
import { connectedFolderEntryNativePath, systemFileManagerName } from "../../lib/platform";
import { showToast } from "../../ui/feedback";
import type { TreeEntry } from "../../types";
import { canDropInto, dragPayload } from "./file-manager-layout";
import { parentPath } from "./file-manager-model";
import { placeKey, samePlace, type FileManagerLocation, type FileManagerPlace } from "./file-manager-places";
import { droppedInternalPaths, dropGoesNowhere, listDropTarget, type InternalDrag } from "./file-manager-drops";
import { historyTurn, transferLabel } from "./file-manager-undo";
import { desktopErrorText, internalDragType, type PlaceFileBridge } from "./file-manager-view-helpers";
import { moveResultMessage } from "./move-result";
import type { FileChanges } from "./useFileChanges";

export interface FileDropsContext {
  fixtureMode: boolean;
  place: FileManagerPlace;
  placeRoot: string;
  location: FileManagerLocation;
  folderName: string;
  bridge: PlaceFileBridge | null;
  selection: readonly string[];
  selected: ReadonlySet<string>;
  byPath: ReadonlyMap<string, TreeEntry>;
  /** The list shows search results or Recents, which take no drop. */
  listTakesNoDrop: boolean;
  listing: { refresh: () => Promise<unknown> };
  changes: FileChanges;
  select: (paths: string[]) => void;
  nameOfPlace: (place: FileManagerPlace) => string;
  onError: (message: string | null) => void;
}

/**
 * Dragging items out of the list and dropping them anywhere the window takes
 * them: the list, a folder row, a sidebar place, or the message box. A drag
 * out of the list keeps the window's own record of what it carries, so a
 * drop back in moves rather than copies.
 */
export function useFileDrops(context: FileDropsContext) {
  const { fixtureMode, place, placeRoot, location, folderName, bridge, selection, selected, byPath, listTakesNoDrop, listing, changes, select, nameOfPlace, onError } = context;
  // Where a drag would land: "" for the folder shown, a folder row's path, or null.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // The files dragged out of this list, so dropping them back on a folder row moves them rather than copying.
  const internalDragRef = useRef<InternalDrag | null>(null);
  const [sidebarDrop, setSidebarDrop] = useState<string | null>(null);
  const [composerDrop, setComposerDrop] = useState(false);

  /**
   * A drag from the list: a selected item carries the whole selection, an
   * unselected one just itself, files and folders alike (never a link or a
   * Connected Folder nested here). The desktop drags them out to any app;
   * dropped back on a folder row or a sidebar place, they move there. The
   * browser preview, which cannot drag files out, drags them inside the
   * window only.
   */
  function startDrag(entry: TreeEntry, event: DragEvent<HTMLElement>) {
    const items = dragPayload(entry, selection.filter((path) => byPath.has(path)), byPath);
    if (!items.length) { event.preventDefault(); return; }
    if (!selected.has(entry.path)) select([entry.path]);
    const paths = items.map((item) => item.path);
    internalDragRef.current = { place, paths, at: Date.now() };
    if (bridge && !fixtureMode) {
      event.preventDefault();
      void bridge.drag(paths).catch((caught) => onError(desktopErrorText(errorText(caught))));
      return;
    }
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(internalDragType, JSON.stringify({ place, paths }));
    // A drag that ends anywhere else carries nothing into a later drop.
    const started = internalDragRef.current;
    window.addEventListener("dragend", () => window.setTimeout(() => { if (internalDragRef.current === started) internalDragRef.current = null; }, 0), { once: true });
    event.dataTransfer.setData("text/plain", paths.map((path) => connectedFolderEntryNativePath(placeRoot, path)).join("\n"));
  }

  /** A drag the window can take: files from another app, or items dragged inside the window. */
  function isItemDrag(event: DragEvent<HTMLElement>): boolean {
    return event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes(internalDragType);
  }

  /**
   * Dropping onto the list, in any place: items from another app are copied
   * into the folder shown, or the folder row they land on; items dragged out
   * of this list onto a folder row move there. Both go through the transfer
   * route paste uses, so a Connected Folder keeps History for them, and
   * anything a Connected Folder owns inside a Standard Folder or an other
   * folder is refused there and changed through that Connected Folder.
   */
  function dropTargetFor(event: DragEvent<HTMLElement>): string {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-fm-path]");
    const entry = row ? byPath.get(row.dataset.fmPath ?? "") : undefined;
    const dragged = internalDragRef.current && samePlace(internalDragRef.current.place, place) ? internalDragRef.current.paths : [];
    return listDropTarget(entry, dragged, location.path);
  }

  /** The items a drop carries when they were dragged out of this window: matched by name (the desktop's drag) or by the window's own drag. */
  function internalDrag(event: DragEvent<HTMLElement>): string[] | null {
    const current = internalDragRef.current;
    if (event.dataTransfer.types.includes(internalDragType)) {
      let carried: unknown;
      try {
        carried = JSON.parse(event.dataTransfer.getData(internalDragType));
      } catch {
        return null;
      }
      return droppedInternalPaths(current, Date.now(), { carried });
    }
    return droppedInternalPaths(current, Date.now(), { names: Array.from(event.dataTransfer.files).map((file) => file.name) });
  }

  function dragOverList(event: DragEvent<HTMLDivElement>) {
    if (listTakesNoDrop || !isItemDrag(event)) return;
    event.preventDefault();
    const target = dropTargetFor(event);
    const internal = internalDragRef.current;
    const nowhere = dropGoesNowhere(internal, place, target);
    event.dataTransfer.dropEffect = nowhere ? "none" : internal ? "move" : "copy";
    const shown = nowhere ? null : target;
    setDropTarget((current) => current === shown ? current : shown);
  }

  async function dropOnList(event: DragEvent<HTMLDivElement>) {
    if (listTakesNoDrop || !isItemDrag(event)) return;
    event.preventDefault();
    const target = dropTargetFor(event);
    setDropTarget(null);
    await dropInto({ place, path: target }, event, target ? target.slice(target.lastIndexOf("/") + 1) : folderName);
  }

  /**
   * One drop, wherever it lands (the list, a folder row, a sidebar place): a
   * file dragged out of this list moves there; files from Finder are copied
   * in. Both go through the same transfer as paste, so ⌘Z undoes them.
   */
  async function dropInto(target: { place: FileManagerPlace; path: string }, event: DragEvent<HTMLElement>, targetName: string, options: { select?: boolean } = {}): Promise<string[]> {
    const moving = internalDrag(event);
    const movingPlace = internalDragRef.current?.place ?? null;
    internalDragRef.current = null;
    const getPath = window.ampleFileDesktop?.agent?.getPathForFile;
    const nativePaths = moving || !getPath ? [] : Array.from(event.dataTransfer.files).map((file) => getPath(file)).filter(Boolean);
    // Collect before the first await: a dropped folder is readable only during the drop.
    const collected = moving || nativePaths.length ? null : collectDroppedUploadFiles(event.dataTransfer);
    if (fixtureMode) { showToast({ text: "Adding files is disabled in the preview", tone: "info" }); return []; }
    try {
      if (moving && movingPlace) {
        // Items already in the target stay; none goes into itself or a folder inside it.
        const sources = moving.filter((path) => !(samePlace(movingPlace, target.place) && (parentPath(path) === target.path || !canDropInto(target.path, [path]))));
        if (!sources.length) return [];
        const result = await changes.startTransfer({ mode: "move", sources: sources.map((path) => ({ place: movingPlace, path })), target }, targetName, transferLabel(sources));
        if (!result) return [];
        await changes.afterTransfer(result, target, `Move ${transferLabel(sources)}`, options.select ?? samePlace(target.place, place));
        if (changes.reportOutcome("move", result) && result.cancelled) return result.written;
        showToast(result.copiedInstead
          ? { text: `Copied ${transferLabel(sources)} to ${targetName}. The original stays where it was.`, tone: "success" }
          : moveResultMessage(transferLabel(sources), targetName, nameOfPlace(movingPlace), result));
        return result.written;
      }
      if (nativePaths.length) {
        const result = await changes.startTransfer({ mode: "copy", sources: nativePaths.map((nativePath) => ({ nativePath })), target }, targetName, transferLabel(nativePaths));
        if (!result) return [];
        await changes.afterTransfer(result, target, `Add ${transferLabel(nativePaths)}`, options.select ?? samePlace(target.place, place));
        if (changes.reportOutcome("copy", result) && result.cancelled) return result.written;
        if (result.written.length) showToast({ text: `Added ${transferLabel(nativePaths)} to ${targetName}`, tone: "success" });
        return result.written;
      }
      // A browser without file paths can still upload into a Connected Folder.
      const files = await collected!;
      if (!files.length) return [];
      if (target.place.kind !== "connected-folder") { showToast({ text: `Add files to ${targetName} in ${systemFileManagerName()}, or put it to work first.`, tone: "info" }); return []; }
      const form = new FormData();
      form.set("targetFolderPath", target.path);
      form.set("relativePaths", JSON.stringify(files.map((item) => item.relativePath)));
      files.forEach((item) => form.append("files", item.file, item.file.name));
      const uploaded = await historyTurn([target.place.id], () => apiForm<{ uploaded: Array<{ path: string }>; safetyCheckpointId: string | null }>(`/api/connected-folders/${encodeURIComponent(target.place.id)}/upload-local-files`, form));
      if (uploaded.safetyCheckpointId) changes.recordUndo(changes.restorePointsUndo(`Add ${formatItemCount(files.length, "file")}`, [{ connectedFolderId: target.place.id, checkpointId: uploaded.safetyCheckpointId }]));
      await listing.refresh();
      showToast({ text: `Added ${files.length === 1 ? files[0]!.file.name : formatItemCount(files.length, "file")} to ${targetName}`, tone: "success" });
      return uploaded.uploaded.map((item) => item.path);
    } catch (caught) {
      onError(errorText(caught));
      return [];
    }
  }

  /** Dropping onto a sidebar place: into the top of that Connected Folder or Standard Folder. */
  function sidebarDragOver(target: FileManagerPlace, event: DragEvent<HTMLElement>) {
    if (!isItemDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = internalDragRef.current && target.kind === "connected-folder" && internalDragRef.current.place.kind === "connected-folder" ? "move" : "copy";
    const key = placeKey(target);
    setSidebarDrop((current) => current === key ? current : key);
  }

  async function sidebarDropInto(target: FileManagerPlace, name: string, event: DragEvent<HTMLElement>) {
    if (!isItemDrag(event)) return;
    event.preventDefault();
    setSidebarDrop(null);
    await dropInto({ place: target, path: "" }, event, name, { select: false });
  }

  /** Dropping onto the message box: the files join the message's references (from Finder, they are added to this folder first). */
  async function composerDropFiles(event: DragEvent<HTMLElement>, attach: (paths: readonly string[]) => void) {
    if (!isItemDrag(event)) return;
    event.preventDefault();
    setComposerDrop(false);
    const internal = internalDrag(event);
    if (internal && internalDragRef.current && samePlace(internalDragRef.current.place, place)) {
      internalDragRef.current = null;
      attach(internal);
      return;
    }
    const written = await dropInto({ place, path: location.path }, event, folderName, { select: false });
    if (written.length) attach(written);
  }

  return {
    dropTarget,
    setDropTarget,
    sidebarDrop,
    setSidebarDrop,
    composerDrop,
    setComposerDrop,
    startDrag,
    isItemDrag,
    dragOverList,
    dropOnList,
    dropInto,
    sidebarDragOver,
    sidebarDropInto,
    composerDropFiles,
  };
}

export type FileDrops = ReturnType<typeof useFileDrops>;
