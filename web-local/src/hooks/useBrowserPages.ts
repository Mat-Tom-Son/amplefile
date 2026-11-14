import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { BrowserPageState } from "../../../src/shared/browser";
import { browserTabsReducer, emptyBrowserTabs, newBrowserPageId, savedFileName, type BrowserTab } from "../lib/browser-pages";
import { revealInFileManagerLabel } from "../lib/file-actions";
import { showToast } from "../ui/feedback";

export type BrowserBridge = NonNullable<NonNullable<Window["ampleFileDesktop"]>["browser"]>;

/**
 * The keyboard is coming back to the window from a page. The window would
 * give it to whatever last had it, and if that is a field the person typed
 * in earlier (a Chat's message box), what they type next, meant for the
 * site, would land there. So a field outside a dialog gives the keyboard up
 * before it arrives: the tab in front takes it, and with no tab, nothing does.
 */
export function keepKeyboardOutOfFields(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active.closest('[role="dialog"]')) return;
  if (!(active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
  const front = document.querySelector<HTMLElement>('.fm-browser-tab [role="tab"][tabindex="0"]');
  if (front) front.focus();
  else active.blur();
}

export interface BrowserPages {
  /** False where there is no browser: a development API without the desktop app. */
  available: boolean;
  /** True once the desktop's open pages have been read: pages that outlived the window are tabs by then. */
  ready: boolean;
  bridge: BrowserBridge | null;
  tabs: BrowserTab[];
  activeId: string | null;
  pages: Readonly<Record<string, BrowserPageState>>;
  canReopen: boolean;
  /** A new tab in front: blank, or loading `url`. */
  newTab: (url?: string) => string;
  select: (pageId: string) => void;
  /** The person closes a tab; its page closes with it. */
  close: (pageId: string) => void;
  reopenClosed: () => void;
  /** Loads what the person typed in a tab, creating its page the first time. */
  navigate: (pageId: string, address: string) => Promise<void>;
}

/**
 * The window's half of the built-in browser (docs/built-in-browser.md). The
 * desktop host owns the pages and stays the authority: this keeps the tab
 * list in step with it (pages that survive a window reload, tabs a Worker or
 * a link opens, pages the host closes), tells it which tab is in front, and
 * says when a download lands. `bridge` is the desktop's, or the preview's
 * sample one; `viewingPageId` is the page the person can see right now, if
 * any (not one under a dialog, in a hidden window, or folded away); `onShow`
 * runs when the host asks for a tab to be brought forward.
 */
export function useBrowserPages({ bridge, viewingPageId: shownPageId, onShow }: { bridge: BrowserBridge | null; viewingPageId: string | null; onShow: () => void }): BrowserPages {
  const [state, dispatch] = useReducer(browserTabsReducer, emptyBrowserTabs);
  const [ready, setReady] = useState(false);
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!bridge) return;
    const offState = bridge.onState((page) => dispatch({ type: "page-state", state: page }));
    const offOpen = bridge.onOpenTab((command) => {
      dispatch({ type: "host-open", command });
      if (command.show) onShowRef.current();
    });
    const offClose = bridge.onCloseTab(({ pageId }) => dispatch({ type: "host-close", pageId }));
    // A page that had the keyboard was taken out of the window, and the window is about to be given the keyboard.
    const offKeyboard = bridge.onShortcut((shortcut) => { if (shortcut.key === "KeyboardReturned") keepKeyboardOutOfFields(); });
    const offDownload = bridge.onDownload((download) => {
      if (download.state === "completed") {
        showToast({
          // The name it was saved under: a second "report.txt" is "report (1).txt".
          text: `Downloaded ${savedFileName(download.path, download.filename)}`,
          tone: "success",
          actionLabel: revealInFileManagerLabel(),
          onAction: () => { void bridge.showDownload(download.path).catch(() => undefined); },
          durationMs: 8000,
        });
      } else if (download.state === "interrupted") {
        showToast({ text: `${download.filename} didn’t finish downloading`, tone: "error" });
      }
    });
    // Pages outlive a window reload, and a Worker may have opened some before the window existed.
    void bridge.states().then((pages) => { for (const page of pages) dispatch({ type: "page-state", state: page }); }).catch(() => undefined).then(() => setReady(true));
    return () => { offState(); offOpen(); offClose(); offKeyboard(); offDownload(); };
  }, [bridge]);

  // Workers list the same tabs, in the same order, and learn which one the person has in front.
  // A new tab nobody has typed an address into has no page, so Workers are not told about it.
  const synced = useMemo(() => state.tabs.filter((tab) => tab.url).map((tab) => ({ pageId: tab.pageId, url: state.pages[tab.pageId]?.url || tab.url, title: state.pages[tab.pageId]?.title || tab.title })), [state.tabs, state.pages]);
  const viewingPageId = shownPageId && shownPageId === state.activeId && synced.some((tab) => tab.pageId === shownPageId) ? shownPageId : null;
  const syncKey = JSON.stringify([viewingPageId, synced]);
  useEffect(() => {
    bridge?.sync({ tabs: synced, viewingPageId });
  }, [bridge, syncKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const newTab = useCallback((url?: string) => {
    const pageId = newBrowserPageId();
    dispatch({ type: "new", pageId, ...(url ? { url } : {}) });
    return pageId;
  }, []);
  const select = useCallback((pageId: string) => dispatch({ type: "select", pageId }), []);
  const close = useCallback((pageId: string) => {
    dispatch({ type: "close", pageId });
    void bridge?.close(pageId).catch(() => undefined);
  }, [bridge]);
  const reopenClosed = useCallback(() => {
    if (stateRef.current.closed.length) dispatch({ type: "reopen", pageId: newBrowserPageId() });
  }, []);
  const navigate = useCallback(async (pageId: string, address: string) => {
    if (!bridge) return;
    dispatch({ type: "page-state", state: await bridge.navigate(pageId, address) });
  }, [bridge]);

  return { available: Boolean(bridge), ready, bridge, tabs: state.tabs, activeId: state.activeId, pages: state.pages, canReopen: state.closed.length > 0, newTab, select, close, reopenClosed, navigate };
}
