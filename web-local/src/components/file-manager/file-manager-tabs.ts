import { freshHistory, pushLocation, type FolderHistory } from "./file-manager-navigation";
import { placeKey, sameLocation, type FileManagerLocation, type FileManagerPlace } from "./file-manager-places";

/**
 * Folder tabs (docs/product-model.md, "Folder tabs"): each tab is its own
 * folder view, with its own place, Back and Forward, selection, scroll
 * position, search, and whether it shows the Trash or Recents. Everything
 * here is plain data, so the window's tab strip, keys, and menus all change
 * tabs through these functions and tests can check them without a DOM.
 */

/** What a tab's list area shows: the folder, the computer's Trash, or Recents. */
export type FolderTabView = "folder" | "trash" | "recents";

export interface FolderTab {
  id: string;
  /** Where the tab is, and its Back and Forward. */
  history: FolderHistory;
  view: FolderTabView;
  selection: string[];
  /** The folder list's scroll position when the tab was last left. */
  scrollTop: number;
  /** The search field's text, and where it searches. */
  query: string;
  searchScope: "here" | "all";
}

export interface FolderTabs {
  tabs: FolderTab[];
  activeId: string;
}

/** Folder tabs a window keeps: enough for any real use, few enough that a runaway loop cannot fill the strip. */
export const folderTabLimit = 64;

/** Back and Forward kept for a restored tab, each way. */
export const restoredHistoryLimit = 20;

export function newFolderTab(id: string, location: FileManagerLocation, view: FolderTabView = "folder"): FolderTab {
  return { id, history: freshHistory(location), view, selection: [], scrollTop: 0, query: "", searchScope: "here" };
}

export function singleFolderTab(id: string, location: FileManagerLocation): FolderTabs {
  return { tabs: [newFolderTab(id, location)], activeId: id };
}

/** The tab shown. A state always has one; a stale `activeId` falls back to the first tab. */
export function activeFolderTab(state: FolderTabs): FolderTab {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]!;
}

/**
 * A new tab right after `after` (the tab shown, by default), as Finder and
 * GNOME Files put it. It comes to the front unless `activate` is false. At
 * the limit nothing opens.
 */
export function openFolderTab(state: FolderTabs, tab: FolderTab, options: { after?: string; activate?: boolean } = {}): FolderTabs {
  if (state.tabs.length >= folderTabLimit) return state;
  const anchor = state.tabs.findIndex((item) => item.id === (options.after ?? state.activeId));
  const index = anchor < 0 ? state.tabs.length : anchor + 1;
  const tabs = [...state.tabs.slice(0, index), tab, ...state.tabs.slice(index)];
  return { tabs, activeId: options.activate === false ? state.activeId : tab.id };
}

/**
 * Closing a tab. The tab shown hands the front to the tab after it, or the
 * one before when it was last. Null when it was the window's only tab: the
 * window closes rather than showing no folder.
 */
export function closeFolderTab(state: FolderTabs, id: string): FolderTabs | null {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  if (state.tabs.length === 1) return null;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  return { tabs, activeId: (tabs[index] ?? tabs[index - 1])!.id };
}

/** Every tab but one closed, the one kept in front. */
export function closeOtherFolderTabs(state: FolderTabs, keep: string): FolderTabs {
  const tab = state.tabs.find((item) => item.id === keep);
  return tab ? { tabs: [tab], activeId: tab.id } : state;
}

/** A tab dragged to another place in the strip: `toIndex` is where it lands among the tabs as they are now. */
export function moveFolderTab(state: FolderTabs, id: string, toIndex: number): FolderTabs {
  const from = state.tabs.findIndex((tab) => tab.id === id);
  if (from < 0) return state;
  const target = Math.max(0, Math.min(state.tabs.length - 1, toIndex));
  if (target === from) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(target, 0, moved!);
  return { ...state, tabs };
}

export function selectFolderTab(state: FolderTabs, id: string): FolderTabs {
  return state.activeId === id || !state.tabs.some((tab) => tab.id === id) ? state : { ...state, activeId: id };
}

/** Next and previous tab, wrapping round at the ends, as the platforms' tab keys do. */
export function stepFolderTab(state: FolderTabs, step: 1 | -1): FolderTabs {
  if (state.tabs.length < 2) return state;
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  const next = state.tabs[(Math.max(0, index) + step + state.tabs.length) % state.tabs.length]!;
  return { ...state, activeId: next.id };
}

export function updateFolderTab(state: FolderTabs, id: string, update: (tab: FolderTab) => FolderTab): FolderTabs {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab;
    const next = update(tab);
    if (next !== tab) changed = true;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

/**
 * A tab's Back and Forward changed. Going to another folder starts the tab
 * fresh there, as leaving a folder does: nothing selected, no search, at the
 * top of the list.
 */
export function withTabHistory(tab: FolderTab, history: FolderHistory): FolderTab {
  if (history === tab.history) return tab;
  if (sameLocation(history.location, tab.history.location)) return { ...tab, history };
  return { ...tab, history, selection: [], query: "", scrollTop: 0 };
}

/**
 * The tab in front goes to `location`, as going there would take it: the
 * folder replaces the Trash or Recents, and Back returns to where the tab
 * was. A window handed a place as it opens starts this way.
 */
export function showInFrontTab(state: FolderTabs, location: FileManagerLocation): FolderTabs {
  return updateFolderTab(state, activeFolderTab(state).id, (tab) => {
    const shown = withTabHistory(tab, pushLocation(tab.history, location));
    return shown.view === "folder" ? shown : { ...shown, view: "folder" };
  });
}

/**
 * Every tab showing a place that has gone (a Connected Folder disconnected,
 * a folder taken off the sidebar, a drive ejected) goes to `fallback`, as
 * the tab shown does.
 */
export function relocateFolderTabs(state: FolderTabs, gone: (location: FileManagerLocation) => boolean, fallback: FileManagerLocation): FolderTabs {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (!gone(tab.history.location)) return tab;
    changed = true;
    return withTabHistory(tab, { location: fallback, back: [], forward: [] });
  });
  return changed ? { ...state, tabs } : state;
}

// ---- Kept on this computer ----

/** A tab as it is kept between launches: where it is and what it shows. Selection, scroll, and search start fresh. */
export interface StoredFolderTab {
  location: FileManagerLocation;
  back?: FileManagerLocation[];
  forward?: FileManagerLocation[];
  view?: FolderTabView;
}

export interface StoredFolderTabs {
  tabs: StoredFolderTab[];
  active: number;
  /** View → Show Tab Bar: the strip stays even with one tab. */
  showTabBar: boolean;
}

export function storedFolderTabs(state: FolderTabs, showTabBar: boolean): StoredFolderTabs {
  return {
    tabs: state.tabs.map((tab) => ({
      location: tab.history.location,
      back: tab.history.back.slice(-restoredHistoryLimit),
      forward: tab.history.forward.slice(0, restoredHistoryLimit),
      ...(tab.view !== "folder" ? { view: tab.view } : {}),
    })),
    active: Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeId)),
    showTabBar,
  };
}

/**
 * Tabs read back from storage, or null when nothing usable is there. Every
 * location is checked for shape; anything malformed is dropped rather than
 * trusted. `makeId` gives each restored tab a fresh id.
 */
export function restoreFolderTabs(parsed: unknown, makeId: () => string): { state: FolderTabs; showTabBar: boolean } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { tabs?: unknown; active?: unknown; showTabBar?: unknown };
  const showTabBar = record.showTabBar === true;
  if (!Array.isArray(record.tabs)) return null;
  const tabs: FolderTab[] = [];
  let active = typeof record.active === "number" && Number.isInteger(record.active) ? record.active : 0;
  record.tabs.forEach((raw, index) => {
    const stored = raw as Partial<StoredFolderTab> | null;
    const location = readLocation(stored?.location);
    if (!location || tabs.length >= folderTabLimit) {
      if (index < active) active -= 1;
      return;
    }
    const tab = newFolderTab(makeId(), location, stored?.view === "trash" || stored?.view === "recents" ? stored.view : "folder");
    tab.history = {
      location,
      back: readLocations(stored?.back).slice(-restoredHistoryLimit),
      forward: readLocations(stored?.forward).slice(0, restoredHistoryLimit),
    };
    tabs.push(tab);
  });
  if (!tabs.length) return null;
  return { state: { tabs, activeId: tabs[Math.max(0, Math.min(tabs.length - 1, active))]!.id }, showTabBar };
}

function readLocations(value: unknown): FileManagerLocation[] {
  return Array.isArray(value) ? value.map(readLocation).filter((item): item is FileManagerLocation => Boolean(item)) : [];
}

function readLocation(value: unknown): FileManagerLocation | null {
  if (!value || typeof value !== "object") return null;
  const { place, path } = value as { place?: unknown; path?: unknown };
  if (!place || typeof place !== "object" || typeof path !== "string") return null;
  const { kind, id } = place as { kind?: unknown; id?: unknown };
  if ((kind !== "connected-folder" && kind !== "standard") || typeof id !== "string" || !id || id.length > 512) return null;
  // A relative path inside its place: never absolute, never climbing out.
  if (path.length > 4096 || path.includes("\0") || path.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(path)) return null;
  return { place: { kind, id } as FileManagerPlace, path };
}

// ---- Titles ----

/** What a tab's title is made from: its folder's name and, for telling two same-named folders apart, the names of the folders above it, nearest first. */
export interface FolderTabNaming {
  name: string;
  /** The folders above, nearest first (for /Users/you/Lab/Notes: Lab, you, Users). */
  above: readonly string[];
  /** Identifies the folder itself, so two tabs on the same folder share a title. */
  key: string;
}

/**
 * Each tab's title: its folder's name; where two tabs show different folders
 * with the same name, each adds as few of the folders above it as tell them
 * apart, as “Notes — Lab” and “Notes — Work”, or “Notes — 2025/Lab”.
 */
export function folderTabTitles(namings: readonly FolderTabNaming[]): string[] {
  return namings.map((naming) => {
    const rivals = namings.filter((other) => other.name === naming.name && other.key !== naming.key);
    if (!rivals.length) return naming.name;
    const longest = Math.max(naming.above.length, ...rivals.map((other) => other.above.length));
    for (let depth = 1; depth <= longest; depth += 1) {
      const mine = naming.above.slice(0, depth).join("\0");
      if (rivals.every((other) => other.above.slice(0, depth).join("\0") !== mine)) return titleWith(naming, depth);
    }
    return titleWith(naming, naming.above.length);
  });
}

function titleWith(naming: FolderTabNaming, depth: number): string {
  const above = naming.above.slice(0, depth).filter(Boolean);
  return above.length ? `${naming.name} — ${[...above].reverse().join("/")}` : naming.name;
}

/** A location's identity for tab titles: a Connected Folder by its id, anywhere else by its place. */
export function folderTabKey(location: FileManagerLocation, view: FolderTabView): string {
  return view === "folder" ? `${placeKey(location.place)}\0${location.path}` : view;
}

// ---- Keys ----

/** The keys a tab key is read from. */
type TabKey = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/**
 * Next (1) and previous (-1) tab, as each platform has them: Ctrl+Tab and
 * Ctrl+Shift+Tab everywhere, ⇧⌘] and ⇧⌘[ on the Mac, Ctrl+PageDown and
 * Ctrl+PageUp elsewhere (GNOME Files' keys). Null for any other key.
 */
export function folderTabStepKey(event: TabKey, mac: boolean): 1 | -1 | null {
  if (event.altKey) return null;
  if (event.key === "Tab" && event.ctrlKey && !event.metaKey) return event.shiftKey ? -1 : 1;
  if (mac) {
    if (!event.metaKey || !event.shiftKey || event.ctrlKey) return null;
    if (event.code === "BracketRight" || event.key === "}") return 1;
    if (event.code === "BracketLeft" || event.key === "{") return -1;
    return null;
  }
  if (!event.ctrlKey || event.shiftKey || event.metaKey) return null;
  if (event.key === "PageDown") return 1;
  if (event.key === "PageUp") return -1;
  return null;
}

/** New Tab: ⌘T on the Mac, Ctrl+T elsewhere, by its physical key. */
export function isNewTabKey(event: TabKey, mac: boolean): boolean {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return command && !event.shiftKey && !event.altKey && (event.code === "KeyT" || (!event.code && event.key.toLowerCase() === "t"));
}
