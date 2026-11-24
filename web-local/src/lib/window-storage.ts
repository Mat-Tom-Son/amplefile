/**
 * Renderer state for one file manager window (docs/product-model.md,
 * "Windows"). AmpleFile can show several windows, and every window's renderer
 * shares one local storage. Most of what is kept there is a preference every
 * window starts from (the view, the sort, Show Hidden Files, panel widths): a
 * window keeps its own copy while it is open, and the last one changed is what
 * the next window starts with. A few things belong to one window only, the
 * Connected Folder it shows, its folder tabs, and how it left its Browser
 * pane, so they are kept under a key of that window's own.
 *
 * The host numbers each window with a slot (desktop/src/file-manager-windows.ts):
 * window 1 keeps the keys AmpleFile always used, so one window behaves as
 * before, and window N adds `.window-N`. A new window, as opposed to one
 * coming back, starts without what an earlier window in its slot left.
 */

/** Keys kept per window; everything else in local storage is shared by every window. */
export const perWindowStorageKeys = [
  "amplefile.connected-folder.active",
  "amplefile.file-manager.browser-pane.v1",
  // Its folder tabs, so two windows never restore or overwrite each other's.
  "amplefile.file-manager.tabs.v1",
] as const;

type PerWindowStorageKey = (typeof perWindowStorageKeys)[number];

/** Marks this window's session once its fresh start was handled, so a reload keeps what it has since stored. */
const startedSessionKey = "amplefile.window.started";

/** This window's slot: 1 for the first window, and outside the desktop app. */
export function windowSlot(): number {
  const slot = typeof window === "undefined" ? undefined : window.ampleFileDesktop?.windows?.slot;
  return typeof slot === "number" && Number.isInteger(slot) && slot >= 1 ? slot : 1;
}

/** The local storage key this window keeps a per-window value under. */
export function windowStorageKey(key: PerWindowStorageKey, slot = windowSlot()): string {
  return slot === 1 ? key : `${key}.window-${slot}`;
}

/**
 * Called once as the renderer starts, before anything reads per-window
 * storage: a new window forgets what an earlier window in its slot left.
 */
export function startWindowStorage(): void {
  if (typeof window === "undefined" || !window.ampleFileDesktop?.windows?.fresh) return;
  try {
    if (window.sessionStorage.getItem(startedSessionKey)) return;
    window.sessionStorage.setItem(startedSessionKey, "1");
    for (const key of perWindowStorageKeys) window.localStorage.removeItem(windowStorageKey(key));
  } catch {
    // Storage can be unavailable; the window then starts from whatever it reads.
  }
}

/** Tells the desktop where this window is, so File → New Window opens there. */
export function reportWindowLocation(location: { place: { kind: "connected-folder" | "standard"; id: string }; path: string } | null, view: "folder" | "trash" | "recents" = "folder"): void {
  if (typeof window === "undefined") return;
  // A tab showing the Trash or Recents shows no Connected Folder, though it keeps the folder it came from.
  window.ampleFileDesktop?.windows?.setLocation(location ? { place: { kind: location.place.kind, id: location.place.id }, path: location.path, ...(view !== "folder" ? { view } : {}) } : null);
}
