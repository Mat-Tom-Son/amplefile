/**
 * The file manager windows (docs/product-model.md, "Windows"). AmpleFile can
 * show several at once; each has its own location, selection, panel, menu
 * state, and place on the screen, and all of them share the same Connected
 * Folders, running Chats, and file operations through the local API.
 *
 * This registry is the host's one answer to "which window": the window a menu
 * command goes to (the one the menu was used in, else the focused or most
 * recently focused one), the window a reply goes to (the one that asked), the
 * window a folder handed to the app opens in, and the window a Worker's
 * browser page appears in. It knows nothing of Electron, so it is tested on
 * its own; desktop/src/main.ts keeps the BrowserWindows in it.
 */

export interface FileManagerWindowLike {
  readonly id: number;
  isDestroyed(): boolean;
}

type WindowReference = Pick<FileManagerWindowLike, "id"> & Partial<Pick<FileManagerWindowLike, "isDestroyed">>;

/** What the window's menus show while it is the one in front. */
export interface WindowMenuState {
  connectedFolderOpen: boolean;
  /** Show Hidden Files, which the View menu checks. */
  showHiddenFiles: boolean;
  /** The window shows the file manager, with its folder tabs: New Tab, Close Tab, and the tab items act on it. */
  folderTabsOpen: boolean;
  /** On Linux, the current tab shows a folder that can be opened in a terminal. */
  terminalFolderOpen?: boolean;
  /** View → Show Tab Bar: the window's folder tab strip shows even with one tab. */
  showTabBar: boolean;
}

/** The Connected Folder a window shows, as the host-owned registry names it. */
export interface WindowConnectedFolder {
  id: string;
  name: string;
  connectedFolderRoot: string;
}

/** A place and folder a window shows: the same shape a folder handed to the app opens at. */
export interface WindowLocation {
  place: { kind: "connected-folder" | "standard"; id: string };
  path: string;
  select?: string | null;
  /** Reported only: the tab in front shows the Trash or Recents rather than this folder. */
  view?: "trash" | "recents";
}

export interface OpenLocationRequest<Location> {
  token: string;
  location: Location;
}

export interface FileManagerWindowEntry<W extends FileManagerWindowLike, Location> {
  readonly window: W;
  /**
   * A small number naming the window across launches: its saved size and
   * position and its per-window renderer storage use it. The first window is 1.
   */
  readonly slot: number;
  menuState: WindowMenuState;
  /**
   * The Connected Folder the window last showed, as its renderer named it, for
   * Open Recent. What the window shows now is `shownConnectedFolder(entry)`:
   * none while the tab in front is a plain folder, Trash, or Recents.
   */
  connectedFolder: WindowConnectedFolder | null;
  /** Bumped on every change of `connectedFolder`, so a slower registry read never overwrites a newer one. */
  connectedFolderGeneration: number;
  /** Where the window is, as its renderer last said; New Window opens there. */
  location: WindowLocation | null;
  /** A location handed to the window that its renderer has not taken yet (it may still be loading). */
  pendingOpenLocation: OpenLocationRequest<Location> | null;
}

export const defaultWindowMenuState: WindowMenuState = Object.freeze({ connectedFolderOpen: false, showHiddenFiles: false, folderTabsOpen: false, showTabBar: false });

export class FileManagerWindows<W extends FileManagerWindowLike, Location = WindowLocation> {
  readonly #entries = new Map<number, FileManagerWindowEntry<W, Location>>();
  /** Window ids, most recently focused first. */
  #recent: number[] = [];

  get size(): number {
    return this.live().length;
  }

  /** Registers a new window, in front of the others; `slot` defaults to the smallest one free. */
  add(window: W, slot = this.nextSlot()): FileManagerWindowEntry<W, Location> {
    if (!Number.isInteger(slot) || slot < 1) throw new Error("A window slot is a positive whole number.");
    if (this.live().some((entry) => entry.slot === slot && entry.window !== window)) throw new Error(`Window slot ${slot} is taken.`);
    const entry: FileManagerWindowEntry<W, Location> = {
      window,
      slot,
      menuState: { ...defaultWindowMenuState },
      connectedFolder: null,
      connectedFolderGeneration: 0,
      location: null,
      pendingOpenLocation: null,
    };
    this.#entries.set(window.id, entry);
    this.focus(window);
    return entry;
  }

  /** Forgets a window that closed; answers its entry, or null when it was not registered. */
  remove(window: W | number): FileManagerWindowEntry<W, Location> | null {
    const id = typeof window === "number" ? window : window.isDestroyed()
      ? [...this.#entries].find(([, entry]) => entry.window === window)?.[0]
      : window.id;
    if (id === undefined) return null;
    const entry = this.#entries.get(id) ?? null;
    this.#entries.delete(id);
    this.#recent = this.#recent.filter((recent) => recent !== id);
    return entry;
  }

  /** The entry of a registered, live window; null for anything else (the popover, a browser pop-up, a closed window). */
  entry(window: WindowReference | null | undefined): FileManagerWindowEntry<W, Location> | null {
    if (!window || window.isDestroyed?.()) return null;
    const entry = this.#entries.get(window.id);
    return entry && !entry.window.isDestroyed() ? entry : null;
  }

  has(window: WindowReference | null | undefined): boolean {
    return this.entry(window) !== null;
  }

  /** The window was focused: it is now the most recent. */
  focus(window: WindowReference): void {
    const entry = this.entry(window);
    if (!entry) return;
    const windowId = entry.window.id;
    this.#recent = [windowId, ...this.#recent.filter((id) => id !== windowId)];
  }

  /** Live windows, most recently focused first. */
  live(): FileManagerWindowEntry<W, Location>[] {
    const result: FileManagerWindowEntry<W, Location>[] = [];
    for (const id of this.#recent) {
      const entry = this.#entries.get(id);
      if (entry && !entry.window.isDestroyed()) result.push(entry);
    }
    return result;
  }

  windows(): W[] {
    return this.live().map((entry) => entry.window);
  }

  /** The focused file manager window, else the one focused most recently; null when none is open. */
  mostRecent(): FileManagerWindowEntry<W, Location> | null {
    return this.live()[0] ?? null;
  }

  /**
   * Where a command goes: the window it was given in (a menu used in that
   * window, the window that sent a request) when that is a file manager
   * window, else the most recent one.
   */
  target(window?: WindowReference | null): FileManagerWindowEntry<W, Location> | null {
    return this.entry(window) ?? this.mostRecent();
  }

  /** The smallest slot no open window uses. */
  nextSlot(): number {
    const taken = new Set(this.live().map((entry) => entry.slot));
    let slot = 1;
    while (taken.has(slot)) slot += 1;
    return slot;
  }

  /** The most recent window whose tab in front shows a Connected Folder, or null when none does. */
  showing(connectedFolderId: string | null | undefined): FileManagerWindowEntry<W, Location> | null {
    if (!connectedFolderId) return null;
    return this.live().find((entry) => shownConnectedFolder(entry)?.id === connectedFolderId) ?? null;
  }

  /**
   * The window a Worker's browser page appears in: the one whose tab in front
   * shows that Chat's Connected Folder, else the most recent one. `owner` names the Chat
   * as `<connected-folder id>/<conversation id>` (src/shared/browser.ts).
   */
  workerWindow(owner: string | null | undefined): FileManagerWindowEntry<W, Location> | null {
    return this.showing(ownerConnectedFolderId(owner)) ?? this.mostRecent();
  }

  /** The menu state the application menu shows: the front window's, or nothing open. */
  menuState(): WindowMenuState {
    return this.mostRecent()?.menuState ?? { ...defaultWindowMenuState };
  }

  /** A renderer sends only what changed; a key it leaves out keeps its value. */
  updateMenuState(window: WindowReference | null | undefined, value: unknown): WindowMenuState | null {
    const entry = this.entry(window);
    if (!entry) return null;
    const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    entry.menuState = {
      ...entry.menuState,
      connectedFolderOpen: typeof record.connectedFolderOpen === "boolean" ? record.connectedFolderOpen : entry.menuState.connectedFolderOpen,
      showHiddenFiles: typeof record.showHiddenFiles === "boolean" ? record.showHiddenFiles : entry.menuState.showHiddenFiles,
      folderTabsOpen: typeof record.folderTabsOpen === "boolean" ? record.folderTabsOpen : entry.menuState.folderTabsOpen,
      ...(typeof record.terminalFolderOpen === "boolean" ? { terminalFolderOpen: record.terminalFolderOpen } : {}),
      showTabBar: typeof record.showTabBar === "boolean" ? record.showTabBar : entry.menuState.showTabBar,
    };
    return entry.menuState;
  }

  /** Hands a location to a window; its renderer takes it when it is ready (or now, when it already is). */
  handOpenLocation(window: WindowReference | null | undefined, request: OpenLocationRequest<Location>): boolean {
    const entry = this.entry(window);
    if (!entry) return false;
    entry.pendingOpenLocation = request;
    return true;
  }

  /** The window's renderer takes the location handed to it, once. */
  takeOpenLocation(window: WindowReference | null | undefined): OpenLocationRequest<Location> | null {
    const entry = this.entry(window);
    if (!entry) return null;
    const request = entry.pendingOpenLocation;
    entry.pendingOpenLocation = null;
    return request;
  }

  /** The renderer showed the location sent to it; nothing is left to take. */
  acknowledgeOpenLocation(window: WindowReference | null | undefined, token: unknown): void {
    const entry = this.entry(window);
    if (entry && typeof token === "string" && entry.pendingOpenLocation?.token === token) entry.pendingOpenLocation = null;
  }
}

/** The Connected Folder in a browser page owner (`<connected-folder id>/<conversation id>`), or null. */
export function ownerConnectedFolderId(owner: string | null | undefined): string | null {
  if (typeof owner !== "string") return null;
  const slash = owner.indexOf("/");
  return slash > 0 ? owner.slice(0, slash) : null;
}

/**
 * The Connected Folder a window shows now, which its title names and a
 * Worker's browser page follows: the one its tab in front is in, and none
 * while that tab shows a plain folder, the computer, the Trash, or Recents.
 * Before its renderer reports where it is, the one it last named.
 */
export function shownConnectedFolder(entry: Pick<FileManagerWindowEntry<FileManagerWindowLike, unknown>, "connectedFolder" | "location">): WindowConnectedFolder | null {
  const location = entry.location;
  if (!location) return entry.connectedFolder;
  if (location.view || location.place.kind !== "connected-folder" || location.place.id !== entry.connectedFolder?.id) return null;
  return entry.connectedFolder;
}

/** A location a renderer reported or asked to open, checked for shape only; null when it is not one. */
export function parseWindowLocation(value: unknown): WindowLocation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const place = record.place as Record<string, unknown> | undefined;
  if (!place || typeof place !== "object") return null;
  if (place.kind !== "connected-folder" && place.kind !== "standard") return null;
  if (typeof place.id !== "string" || !place.id || place.id.length > 512 || place.id.includes("\0")) return null;
  const path = record.path;
  if (typeof path !== "string" || path.length > 4096 || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return null;
  if (path.split(/[\\/]/).some((segment) => segment === "..")) return null;
  const select = record.select;
  if (select !== undefined && select !== null && (typeof select !== "string" || select.length > 4096 || select.includes("\0"))) return null;
  const view = record.view === "trash" || record.view === "recents" ? record.view : undefined;
  return { place: { kind: place.kind, id: place.id }, path, ...(typeof select === "string" ? { select } : {}), ...(view ? { view } : {}) };
}
