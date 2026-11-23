import { useEffect, useRef, useState, type SetStateAction } from "react";

import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";
import type { ChatSendRequest } from "../../types";
import type { FileManagerLocation } from "./file-manager-places";
import {
  activeFolderTab,
  closeFolderTab,
  closeOtherFolderTabs,
  folderTabLimit,
  moveFolderTab,
  newFolderTab,
  openFolderTab,
  relocateFolderTabs,
  restoreFolderTabs,
  selectFolderTab,
  singleFolderTab,
  storedFolderTabs,
  updateFolderTab,
  type FolderTab,
  type FolderTabs,
  type FolderTabView,
} from "./file-manager-tabs";

/** The window's folder tabs, where they were and which was in front, kept on this computer between launches. */
export const folderTabsStorageKey = "amplefile.file-manager.tabs.v1";

/**
 * The Chat a tab's panel holds (docs/product-model.md): one per tab, in the
 * Connected Folder it belongs to. `conversationId` is the Chat opened from
 * History; a new one from the message box keeps it null and learns
 * `activeId`, and its `sendRequest` is dropped once it has gone, so showing
 * the Chat again never sends it twice.
 */
export interface PanelChat {
  key: number;
  connectedFolderId: string;
  conversationId: string | null;
  activeId: string | null;
  title: string;
  sendRequest: ChatSendRequest | null;
  open: boolean;
}

/**
 * The window's folder tabs (file-manager-tabs.ts holds the rules): the tabs,
 * the one in front, View → Show Tab Bar, each tab's Chat, and what is kept
 * on this computer. Restored tabs come back where they were; with nothing
 * kept, the window opens one tab at `startLocation`.
 */
export function useFolderTabs(startLocation: () => FileManagerLocation) {
  const nextIdRef = useRef(1);
  const makeId = () => String(nextIdRef.current++);
  const [initial] = useState(() => {
    const restored = readStoredJsonValue(folderTabsStorageKey, (value) => restoreFolderTabs(value, makeId), null);
    return restored ? { ...restored, restored: true } : { state: singleFolderTab(makeId(), startLocation()), showTabBar: false, restored: false };
  });
  const [state, setState] = useState<FolderTabs>(initial.state);
  const [showTabBar, setShowTabBar] = useState(initial.showTabBar);
  const [chats, setChats] = useState<Readonly<Record<string, PanelChat>>>({});
  const stateRef = useRef(state);
  stateRef.current = state;

  // Kept on this computer: where each tab is and which is in front, written only when that changes.
  const writtenRef = useRef<string | null>(null);
  useEffect(() => {
    const stored = JSON.stringify(storedFolderTabs(state, showTabBar));
    if (stored === writtenRef.current) return;
    writtenRef.current = stored;
    writeStoredJsonValue(folderTabsStorageKey, JSON.parse(stored));
  }, [state, showTabBar]);

  const activeTab = activeFolderTab(state);

  function update(id: string, change: (tab: FolderTab) => FolderTab) {
    setState((current) => updateFolderTab(current, id, change));
  }

  /** A new tab after the one in front (or `after`), at `location`; it comes to the front unless `activate` is false. Its id, or null at the limit. */
  function open(location: FileManagerLocation, options: { view?: FolderTabView; activate?: boolean; after?: string } = {}): string | null {
    if (stateRef.current.tabs.length >= folderTabLimit) return null;
    const tab = newFolderTab(makeId(), location, options.view ?? "folder");
    setState((current) => openFolderTab(current, tab, options));
    return tab.id;
  }

  /**
   * Closes a tab and its Chat (a running reply keeps running on the host, as
   * when a Chat is closed). Returns the tab that comes to the front, or false
   * for the window's last tab, which is not closed here: the window closes.
   */
  function close(id: string): FolderTab | null | false {
    const next = closeFolderTab(stateRef.current, id);
    if (!next) return false;
    setState((current) => closeFolderTab(current, id) ?? current);
    setChats((current) => withoutKeys(current, [id]));
    return next.activeId === stateRef.current.activeId ? null : next.tabs.find((tab) => tab.id === next.activeId) ?? null;
  }

  function closeOthers(keep: string) {
    setState((current) => closeOtherFolderTabs(current, keep));
    setChats((current) => withoutKeys(current, Object.keys(current).filter((id) => id !== keep)));
  }

  function select(id: string) {
    setState((current) => selectFolderTab(current, id));
  }

  function move(id: string, toIndex: number) {
    setState((current) => moveFolderTab(current, id, toIndex));
  }

  function relocate(gone: (location: FileManagerLocation) => boolean, fallback: FileManagerLocation) {
    setState((current) => relocateFolderTabs(current, gone, fallback));
  }

  /** A tab's Chat, set as state is: a value or an update from the current one. */
  function setChat(id: string, action: SetStateAction<PanelChat | null>) {
    setChats((current) => {
      const previous = current[id] ?? null;
      const next = typeof action === "function" ? action(previous) : action;
      if (next === previous) return current;
      if (!next) return withoutKeys(current, [id]);
      return { ...current, [id]: next };
    });
  }

  return {
    tabs: state.tabs,
    activeTab,
    /** The tabs as they are now, for handlers that run after a change this render has not seen. */
    current: () => stateRef.current,
    /** The window opened with tabs kept from before. */
    restored: initial.restored,
    showTabBar,
    setShowTabBar,
    /** The strip shows with more than one tab, or always once Show Tab Bar is on. */
    stripShown: state.tabs.length > 1 || showTabBar,
    update,
    open,
    close,
    closeOthers,
    select,
    move,
    relocate,
    chats,
    setChat,
  };
}

export type FolderTabsModel = ReturnType<typeof useFolderTabs>;

function withoutKeys<T>(record: Readonly<Record<string, T>>, keys: readonly string[]): Readonly<Record<string, T>> {
  if (!keys.some((key) => key in record)) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}
