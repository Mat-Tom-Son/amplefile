import { useEffect, useRef, type RefObject } from "react";

import { api, errorText } from "../../lib/api";
import { slideIn } from "../../lib/motion";
import type { ConnectedFolderSummary } from "../../types";
import { navigationSide, parentPath } from "./file-manager-model";
import { enclosingNativeFolder, placeKey, sameLocation, type FileManagerLocation, type FileManagerPlace } from "./file-manager-places";
import { pushLocation, stepBack, stepForward, type FolderHistory } from "./file-manager-navigation";

export interface FileManagerNavigationContext {
  fixtureMode: boolean;
  /** Where the folder view is, and its Back and Forward; held by the caller. */
  history: FolderHistory;
  setHistory: (update: (current: FolderHistory) => FolderHistory) => void;
  /** The top of the place shown on disk, for the folder above it. */
  placeRoot: string;
  activeConnectedFolderId: string | null;
  connectedFolders: readonly ConnectedFolderSummary[];
  onSwitchConnectedFolder: (connectedFolder: ConnectedFolderSummary) => void;
  /** Every navigation, even to where the view already is: Recents and the Trash give way to the folder, and so does a browser with the whole area. */
  onNavigate: () => void;
  listing: { key: string; status: string };
  contentRef: RefObject<HTMLDivElement | null>;
  select: (paths: string[]) => void;
  onError: (message: string | null) => void;
}

/**
 * Going places in the folder view: Back and Forward, Command-Up, a folder on
 * this computer by its path, and an item selected once its folder is shown.
 * Entering a Connected Folder makes it the window's Connected Folder.
 */
export function useFileManagerNavigation(context: FileManagerNavigationContext) {
  const { fixtureMode, history, setHistory, placeRoot, activeConnectedFolderId, connectedFolders, onSwitchConnectedFolder, onNavigate, listing, contentRef, select, onError } = context;
  const location = history.location;

  // The folder you go to slides in once its items are here, from the side you went.
  const navMotionRef = useRef<{ key: string; from: "left" | "right" | "none" } | null>(null);
  useEffect(() => {
    const pending = navMotionRef.current;
    if (!pending || listing.status === "loading" || pending.key !== listing.key) return;
    navMotionRef.current = null;
    slideIn(contentRef.current, pending.from);
  }, [listing.key, listing.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // An item to select once its folder's listing is here (Go to Folder's file, Command-Up's folder, a file handed to AmpleFile).
  const pendingSelectRef = useRef<{ key: string; path: string } | null>(null);
  useEffect(() => {
    const pending = pendingSelectRef.current;
    if (!pending || pending.key !== listing.key || listing.status === "loading") return;
    pendingSelectRef.current = null;
    if (listing.status === "ready") select([pending.path]);
  }, [listing.key, listing.status]); // eslint-disable-line react-hooks/exhaustive-deps

  function navigate(next: FileManagerLocation, mode: "push" | "back" | "forward" = "push", switchTo?: ConnectedFolderSummary) {
    onNavigate();
    if (sameLocation(next, location)) return;
    navMotionRef.current = { key: `${placeKey(next.place)}\0${next.path}`, from: navigationSide({ placeKey: placeKey(location.place), path: location.path }, { placeKey: placeKey(next.place), path: next.path }, mode) };
    if (mode === "push") setHistory((current) => pushLocation(current, next));
    else setHistory((current) => ({ ...current, location: next }));
    if (next.place.kind === "connected-folder" && next.place.id !== activeConnectedFolderId) {
      const nextId = next.place.id;
      const target = switchTo ?? connectedFolders.find((item) => item.id === nextId);
      if (target) onSwitchConnectedFolder(target);
    }
  }
  function goBack() {
    const stepped = stepBack(history);
    if (!stepped) return;
    setHistory((current) => ({ ...current, back: stepped.back, forward: stepped.forward }));
    navigate(stepped.location, "back");
  }
  function goForward() {
    const stepped = stepForward(history);
    if (!stepped) return;
    setHistory((current) => ({ ...current, back: stepped.back, forward: stepped.forward }));
    navigate(stepped.location, "forward");
  }
  function goToEnclosingFolder() {
    if (!location.path) {
      // At a place's top, the enclosing folder is wherever the host says the folder above lives, down to the disk.
      if (placeRoot && enclosingNativeFolder(placeRoot)) void openNativeFolder(placeRoot, true);
      return;
    }
    const from = location.path;
    navigate({ place: location.place, path: parentPath(location.path) });
    window.setTimeout(() => select([from]), 0);
  }
  /**
   * Shows a folder on this computer by its path, at the place the host says
   * holds it (a Connected Folder, a Standard Folder, or the computer place).
   * With `reveal`, the folder's enclosing folder opens with it selected.
   */
  async function openNativeFolder(nativePath: string, reveal = false) {
    if (fixtureMode) return;
    try {
      const query = new URLSearchParams({ path: nativePath });
      if (reveal) query.set("reveal", "1");
      const { location: found } = await api<{ location: { place: FileManagerPlace; path: string; select: string | null } }>(`/api/folder-location?${query.toString()}`);
      showLocation({ place: found.place, path: found.path }, found.select);
    } catch (caught) {
      onError(errorText(caught));
    }
  }
  /** Goes to a location the host resolved, selecting an item there once its folder is shown. */
  function showLocation(next: FileManagerLocation, selectPath: string | null) {
    const switchTo = next.place.kind === "connected-folder" ? connectedFolders.find((item) => item.id === next.place.id) : undefined;
    const key = `${placeKey(next.place)}\0${next.path}`;
    // The item is selected once its folder's items are here: now, when they already are (a window that opened at the
    // folder is still reading it).
    if (selectPath && sameLocation(next, location) && listing.key === key && listing.status !== "loading") select([selectPath]);
    else if (selectPath) pendingSelectRef.current = { key, path: selectPath };
    navigate(next, "push", switchTo);
    window.requestAnimationFrame(() => contentRef.current?.focus({ preventScroll: true }));
  }

  return { navigate, goBack, goForward, goToEnclosingFolder, openNativeFolder, showLocation, canGoBack: history.back.length > 0, canGoForward: history.forward.length > 0 };
}
