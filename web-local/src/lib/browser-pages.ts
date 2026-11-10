/**
 * The window's side of the built-in browser (docs/built-in-browser.md): the
 * tabs the Browser pane shows and how much of the main area the pane takes.
 * The desktop host owns the pages; this is what the window remembers about
 * them between its messages. Pure, so it is tested without a window.
 */

import { browserAddressFor, browserSearchUrl, isBrowserAddress, type BrowserOpenTabCommand, type BrowserPageState } from "../../../src/shared/browser";

/** One tab in the Browser pane. `url` is empty for a new tab nobody has typed an address into. */
export interface BrowserTab {
  pageId: string;
  url: string;
  title: string;
}

export interface BrowserTabsState {
  tabs: BrowserTab[];
  activeId: string | null;
  /** Each page's latest state from the desktop host, by page id. */
  pages: Record<string, BrowserPageState>;
  /** Tabs the person closed, newest last, for Reopen Closed Tab. `pageId` is the page that was closed, in case it comes back. */
  closed: Array<{ url: string; title: string; pageId?: string }>;
  /** Pages closed here: a state the host sent before it heard must not bring the tab back. */
  dismissed: string[];
}

export type BrowserTabsAction =
  | { type: "page-state"; state: BrowserPageState }
  | { type: "host-open"; command: BrowserOpenTabCommand }
  | { type: "host-close"; pageId: string }
  | { type: "new"; pageId: string; url?: string; title?: string }
  | { type: "select"; pageId: string }
  | { type: "close"; pageId: string }
  | { type: "reopen"; pageId: string };

export const emptyBrowserTabs: BrowserTabsState = { tabs: [], activeId: null, pages: {}, closed: [], dismissed: [] };

const closedLimit = 25;
const dismissedLimit = 100;

export function browserTabsReducer(state: BrowserTabsState, action: BrowserTabsAction): BrowserTabsState {
  switch (action.type) {
    case "page-state": {
      const page = action.state;
      if (state.dismissed.includes(page.pageId)) return state;
      const known = state.tabs.some((tab) => tab.pageId === page.pageId);
      // A page that has not committed an address yet keeps the tab's own.
      const tabs = known
        ? state.tabs.map((tab) => tab.pageId === page.pageId && page.url ? { ...tab, url: page.url, title: page.title } : tab)
        // The host is the authority: a page it has that this window does not show yet becomes a tab.
        : [...state.tabs, { pageId: page.pageId, url: page.url, title: page.title }];
      return { ...state, tabs, activeId: state.activeId ?? page.pageId, pages: { ...state.pages, [page.pageId]: page } };
    }
    case "host-open": {
      const { command } = action;
      const known = state.tabs.some((tab) => tab.pageId === command.pageId);
      const tabs = known ? state.tabs : [...state.tabs, { pageId: command.pageId, url: command.url, title: command.title }];
      return {
        ...state,
        tabs,
        dismissed: state.dismissed.filter((pageId) => pageId !== command.pageId),
        // A tab the person closed that the desktop offers again (its page asked to be confirmed, and they stayed)
        // never closed, so it is not one to reopen.
        closed: state.closed.filter((entry) => entry.pageId !== command.pageId),
        // A Worker's tabs open behind the person's; a link the person followed comes to the front.
        activeId: command.show || !state.activeId ? command.pageId : state.activeId,
      };
    }
    case "host-close":
      return removeTab(state, action.pageId, false);
    case "new": {
      if (state.tabs.some((tab) => tab.pageId === action.pageId)) return { ...state, activeId: action.pageId };
      return { ...state, tabs: [...state.tabs, { pageId: action.pageId, url: action.url ?? "", title: action.title ?? "" }], activeId: action.pageId };
    }
    case "select":
      return state.tabs.some((tab) => tab.pageId === action.pageId) && state.activeId !== action.pageId ? { ...state, activeId: action.pageId } : state;
    case "close":
      return removeTab(state, action.pageId, true);
    case "reopen": {
      const last = state.closed.at(-1);
      if (!last) return state;
      return {
        ...state,
        closed: state.closed.slice(0, -1),
        tabs: [...state.tabs, { pageId: action.pageId, url: last.url, title: last.title }],
        activeId: action.pageId,
      };
    }
  }
}

function removeTab(state: BrowserTabsState, pageId: string, byPerson: boolean): BrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.pageId === pageId);
  if (index < 0) return state;
  const tab = state.tabs[index]!;
  const tabs = state.tabs.filter((item) => item.pageId !== pageId);
  const pages = { ...state.pages };
  delete pages[pageId];
  // Closing the tab in front shows the one to its right, or the last one, as browsers do.
  const activeId = state.activeId === pageId ? (tabs[index] ?? tabs.at(-1))?.pageId ?? null : state.activeId;
  const url = state.pages[pageId]?.url || tab.url;
  return {
    tabs,
    activeId,
    pages,
    closed: byPerson && url ? [...state.closed, { url, title: state.pages[pageId]?.title || tab.title, pageId }].slice(-closedLimit) : state.closed,
    dismissed: [...state.dismissed.filter((item) => item !== pageId), pageId].slice(-dismissedLimit),
  };
}

const pageIdAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

/** An id for a tab the person opens; the desktop host accepts 6 to 32 lowercase letters and digits. */
export function newBrowserPageId(random: () => number = Math.random): string {
  let id = "";
  for (let index = 0; index < 12; index += 1) id += pageIdAlphabet[Math.floor(random() * pageIdAlphabet.length) % pageIdAlphabet.length];
  return id;
}

/** What a tab is called: the page's title, else its site, else New Tab. */
export function browserTabTitle(tab: BrowserTab, page: BrowserPageState | undefined): string {
  const title = (page?.title || tab.title).trim();
  if (title) return title;
  return browserHost(page?.url || tab.url) || "New Tab";
}

/** The site of an address ("example.com"), or the address itself when it has none. */
export function browserHost(url: string): string {
  if (!url || url === "about:blank") return "";
  try {
    const parsed = new URL(url);
    return parsed.host || (parsed.protocol === "file:" ? decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "") : url);
  } catch {
    return url;
  }
}

/** The Chat a Worker is using a page from: the host names it `<connected-folder id>/<conversation id>`. */
export function browserWorkerChat(owner: string): { connectedFolderId: string; conversationId: string } | null {
  const slash = owner.indexOf("/");
  if (slash <= 0 || slash === owner.length - 1) return null;
  return { connectedFolderId: owner.slice(0, slash), conversationId: owner.slice(slash + 1) };
}

/**
 * How the main area is shared: no Browser pane; its tab strip alone under the
 * folder; the folder above and the page below, with a slider between; or the
 * page alone, the folder folded away.
 */
export type BrowserPaneLayout = "hidden" | "collapsed" | "split" | "full";

/** The layout drawn: a pane with no tabs is not drawn at all. */
export function effectiveBrowserLayout(layout: BrowserPaneLayout, tabCount: number): BrowserPaneLayout {
  return tabCount ? (layout === "hidden" ? "collapsed" : layout) : "hidden";
}

/** The Browser pane's share of the height under the toolbar when nothing is saved. */
export const browserSplitLimits = { defaultFraction: 0.55 } as const;

/** A saved share, kept between 15 and 85 percent so neither half can be dragged away. */
export function clampBrowserFraction(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(Math.max(0.15, Math.min(0.85, value)) * 1000) / 1000 : browserSplitLimits.defaultFraction;
}

/**
 * What the address field opens for what was typed: a web address, a file on
 * this computer, or a search. Anything else the browser cannot show
 * (`chrome://…`, `data:…`, `mailto:…`) is searched for, as `javascript:` is,
 * so Return always leads somewhere and no tab is left blank.
 */
export function browserAddressToOpen(typed: string): { url: string; search: boolean } | null {
  const text = typed.trim();
  const target = browserAddressFor(text);
  if (!target) return null;
  if (isBrowserAddress(target)) return { url: target, search: target.startsWith(browserSearchUrl) };
  return { url: `${browserSearchUrl}${encodeURIComponent(text)}`, search: true };
}

/** What a failed browser call says, without the prefix Electron puts in front of the desktop's own words. */
export function browserErrorText(caught: unknown, fallback: string): string {
  const text = caught instanceof Error ? caught.message : typeof caught === "string" ? caught : "";
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "").trim() || fallback;
}

/** How long a site's question ignores presses after it appears or changes, so a press meant for something else never answers it. */
export const browserQuestionGuardMs = 500;

/**
 * Why a page did not load, in plain words. Chromium's own name for the
 * failure (`ERR_NAME_NOT_RESOLVED`) is kept as supporting detail beside it.
 */
export function browserLoadErrorText(error: { code: number; description: string }): string {
  const code = error.code;
  if (code === -105 || code === -137) return "This site’s address couldn’t be found.";
  if (code === -106) return "This Mac isn’t connected to the internet.";
  if (code === -102) return "The site refused the connection.";
  if (code === -7 || code === -118) return "The site took too long to respond.";
  if (code === -100 || code === -101 || code === -324) return "The connection to the site was interrupted.";
  if (code === -109 || code === -104) return "The site can’t be reached.";
  if (code === -312) return "This address uses a port that browsers block.";
  if (code === -310) return "The site sent the browser in a circle of redirects.";
  if (code === -6) return "There’s no file at that path.";
  if (code === -10) return "The browser isn’t allowed to open that address.";
  if (code === -107 || code === -113 || code === -112) return "A secure connection to the site couldn’t be made.";
  if (code <= -200 && code > -300) return "This site’s security certificate isn’t trusted, so the page was not loaded.";
  return "The page couldn’t be loaded.";
}

/** The name a downloaded file was saved under, which differs from the name asked for when that one was taken. */
export function savedFileName(path: string, fallback: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || fallback;
}
