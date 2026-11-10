import type { BrowserOpenTabCommand, BrowserPageState } from "../../../src/shared/browser";
import { browserAddressFor } from "../../../src/shared/browser";

type BrowserBridge = NonNullable<NonNullable<Window["ampleFileDesktop"]>["browser"]>;

/**
 * The preview's browser (`/?fixture=connected-folder`): the Browser pane over
 * sample pages, with no desktop host and no page drawn. It starts with no
 * tabs, as a new profile does. Two of its recent pages show what the pane says
 * when a Worker is using a page and when a site is waiting on the person.
 */
export function createFixtureBrowserBridge(workerOwner: string): BrowserBridge {
  const pages = new Map<string, BrowserPageState>();
  const listeners = { state: new Set<(state: BrowserPageState) => void>(), open: new Set<(command: BrowserOpenTabCommand) => void>(), close: new Set<(command: { pageId: string }) => void>() };
  const recent = [
    { url: "https://supplier.example.com/orders", title: "Orders — Supplier Portal", visits: 4, lastVisitedAt: new Date().toISOString() },
    { url: "https://maps.example.com/", title: "Maps", visits: 2, lastVisitedAt: new Date().toISOString() },
    { url: "https://docs.example.com/guide", title: "Getting Started — Docs", visits: 1, lastVisitedAt: new Date().toISOString() },
  ];
  const titleOf = (url: string) => recent.find((entry) => entry.url === url)?.title ?? url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const emit = (state: BrowserPageState) => { pages.set(state.pageId, state); for (const listener of listeners.state) listener(state); };
  const load = (pageId: string, url: string): BrowserPageState => {
    const previous = pages.get(pageId);
    const state: BrowserPageState = {
      pageId, url, title: titleOf(url), favicon: null, loading: false, canGoBack: Boolean(previous), canGoForward: false, error: null, crashed: false, audible: false,
      sitePermissions: [], notice: null, muted: false, zoomPercent: 100, blockedPopup: null,
      permissionRequest: url.startsWith("https://maps.example.com") ? { requestId: `${pageId}-location`, origin: "https://maps.example.com", kinds: ["location"] } : null,
      worker: url.startsWith("https://supplier.example.com") ? { owner: workerOwner } : null,
    };
    emit(state);
    return state;
  };
  const subscribe = <T,>(set: Set<(value: T) => void>) => (listener: (value: T) => void) => { set.add(listener); return () => { set.delete(listener); }; };
  return {
    mount: async (request) => pages.get(request.pageId) ?? (request.url ? load(request.pageId, request.url) : null),
    layout: () => undefined,
    unmount: async () => undefined,
    navigate: async (pageId, address) => {
      const url = browserAddressFor(address);
      if (!url) throw new Error("Type an address or something to search for.");
      return load(pageId, url);
    },
    command: async (pageId, command) => {
      const page = pages.get(pageId);
      if (page && command.type === "dismiss-blocked-popup") emit({ ...page, blockedPopup: null });
    },
    close: async (pageId) => { pages.delete(pageId); },
    respondPermission: async (pageId, _requestId, decision) => {
      const page = pages.get(pageId);
      if (page) emit({ ...page, permissionRequest: null, sitePermissions: [{ kind: "location", decision }] });
    },
    sync: () => undefined,
    states: async () => [...pages.values()],
    showDownload: async () => undefined,
    popupTabMenu: async () => null,
    suggest: async (text) => recent.filter((entry) => `${entry.url} ${entry.title}`.toLowerCase().includes(text.toLowerCase())),
    recent: async () => recent,
    clearHistory: async () => { recent.length = 0; },
    onState: subscribe(listeners.state),
    onOpenTab: subscribe(listeners.open),
    onCloseTab: subscribe(listeners.close),
    onShortcut: () => () => undefined,
    onFindResult: () => () => undefined,
    onDownload: () => () => undefined,
  };
}
