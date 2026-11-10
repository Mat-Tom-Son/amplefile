import {
  Add16Regular,
  ArrowClockwise16Regular,
  ArrowLeft16Regular,
  ArrowRight16Regular,
  Chat16Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  Dismiss12Regular,
  Dismiss16Regular,
  Globe16Regular,
  Info16Regular,
  LockClosed16Regular,
  Open16Regular,
  PanelBottomContract20Regular,
  PanelBottomExpand20Regular,
  PanelTopContract20Regular,
  PanelTopExpand20Regular,
  Search16Regular,
  ShieldQuestion20Regular,
  Speaker216Regular,
  SpeakerMute16Regular,
  Warning16Regular,
  WindowNew16Regular,
} from "@fluentui/react-icons";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import "./file-manager-browser.css";
import {
  browserConnection,
  browserDisplayAddress,
  browserPermissionNames,
  browserPermissionPhrase,
  type BrowserFindResult,
  type BrowserPageState,
  type BrowserPermissionRequest,
  type BrowserViewRequest,
} from "../../../../src/shared/browser";
import type { BrowserPages } from "../../hooks/useBrowserPages";
import { browserAddressToOpen, browserErrorText, browserHost, browserQuestionGuardMs, browserSplitLimits, browserTabTitle, clampBrowserFraction, type BrowserPaneLayout, type BrowserTab } from "../../lib/browser-pages";
import { requestConfirm } from "../../ui/feedback";
import { nativeViewBounds, nativeViewOccluded } from "../../lib/native-view";
import { isMacOS } from "../../lib/platform";
import { createTabChromeMotion } from "../../lib/tab-chrome-motion";

type BrowserBridge = NonNullable<BrowserPages["bridge"]>;
type HistoryEntry = Awaited<ReturnType<BrowserBridge["recent"]>>[number];

/** Who is using a page: a Worker, named by its Connected Folder, with a way to its Chat. */
export interface BrowserPaneWorker {
  label: string;
  title: string;
  onOpen?: () => void;
}

/** One row under the address field: what Return does with the typed text, then pages from history. */
interface AddressSuggestion {
  key: string;
  url: string;
  label: string;
  detail?: string;
}

/**
 * The Browser pane (docs/built-in-browser.md): the built-in browser's tabs,
 * under the folder's contents in the file manager window. Its tab strip is
 * always there while a tab is open; the address row and the page show unless
 * the pane is collapsed. The page itself is the desktop host's, drawn over
 * the placeholder at the bottom, and keeps running whatever is shown here.
 */
export function BrowserPane({ browser, layout, onLayout, onViewing, sample = false, describeWorker, onError }: {
  browser: BrowserPages;
  /** The page the person can see right now, or null: folded away, under a dialog, in a hidden window, or showing an error instead. */
  onViewing: (pageId: string | null) => void;
  /** The preview: no host draws a page, so the placeholder says where one would be. */
  sample?: boolean;
  layout: Exclude<BrowserPaneLayout, "hidden">;
  onLayout: (layout: Exclude<BrowserPaneLayout, "hidden">) => void;
  describeWorker: (owner: string) => BrowserPaneWorker | null;
  onError: (message: string) => void;
}) {
  const { bridge, tabs, pages, activeId } = browser;
  const collapsed = layout === "collapsed";
  const active = tabs.find((tab) => tab.pageId === activeId) ?? null;
  const paneRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLSpanElement>(null);
  const motionRef = useRef<ReturnType<typeof createTabChromeMotion> | null>(null);
  const shownRef = useRef<string | null>(null);
  /** What the tab in front can do for the pane's keys: go to its address field, open its find bar. */
  const pageActionsRef = useRef<{ focusAddress: () => void; openFind: () => void } | null>(null);
  /** A tab chosen with a key pressed in a page: the page that comes forward takes the keyboard, as the one that had it did. */
  const focusNextPageRef = useRef(false);
  useEffect(() => { if (collapsed) onViewing(null); }, [collapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onViewing(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The frame behind the tab in front slides to the tab you choose.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const chrome = chromeRef.current;
    if (!strip || !chrome) return;
    const motion = createTabChromeMotion(strip, chrome);
    motionRef.current = motion;
    return () => { motion.dispose(); motionRef.current = null; };
  }, []);
  const shownId = collapsed ? null : activeId;
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const tab = shownId ? strip?.querySelector<HTMLElement>(`[data-browser-tab="${shownId}"]`) ?? null : null;
    motionRef.current?.select(tab, Boolean(shownRef.current && shownId && shownRef.current !== shownId));
    shownRef.current = shownId;
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [shownId, tabs.length]);

  // Notices rise from the bottom of the window, where the page is: keep them above it.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const root = document.documentElement.style;
    // Above the pane's top edge in every size: over the folder's list beside the folder, and over the toolbar with
    // the folder folded away, never over the address row or a site's question.
    const place = () => {
      root.setProperty("--fm-notice-bottom", `${Math.max(40, Math.round(window.innerHeight - pane.getBoundingClientRect().top + 10))}px`);
    };
    place();
    const observer = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(place) : null;
    observer?.observe(pane);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      root.removeProperty("--fm-notice-bottom");
    };
  }, [layout]);

  // The page had the keyboard, so the browser's own keys arrive from the host, which hands the keyboard back to the window.
  const keysRef = useRef<(shortcut: { pageId: string; key: string; shiftKey: boolean; ctrlKey: boolean }) => void>(() => undefined);
  keysRef.current = (shortcut) => {
    const key = shortcut.key.toLowerCase();
    // Close Tab closes the tab the key was pressed in, and the tab that comes forward takes the keyboard, so the
    // next ⌘W closes that one.
    if (key === "w") { focusNextPageRef.current = shortcut.pageId === activeId; browser.close(shortcut.pageId); return; }
    if (key === "t") { if (shortcut.shiftKey) reopenClosed(); else newTab(); return; }
    if (shortcut.pageId !== activeId) return;
    if (key === "l") pageActionsRef.current?.focusAddress();
    else if (key === "f") pageActionsRef.current?.openFind();
    else if (key === "tab" && shortcut.ctrlKey) cycle(shortcut.shiftKey ? -1 : 1, true);
    else if (/^[1-9]$/.test(key)) chooseByNumber(key, true);
  };
  useEffect(() => bridge?.onShortcut((shortcut) => keysRef.current(shortcut)), [bridge]);

  function choose(tab: BrowserTab): void {
    browser.select(tab.pageId);
    if (collapsed) onLayout("split");
  }

  function tabMenu(tab: BrowserTab, event: ReactMouseEvent<HTMLElement>): void {
    if (!bridge) return;
    event.preventDefault();
    const others = tabs.filter((item) => item.pageId !== tab.pageId);
    const url = pages[tab.pageId]?.url || tab.url;
    void bridge.popupTabMenu(tab.pageId, url, { x: event.clientX, y: event.clientY }, { canReopen: browser.canReopen, hasOthers: others.length > 0 }).then((command) => {
      if (command === "duplicate" && url) { browser.newTab(url); if (collapsed) onLayout("split"); }
      else if (command === "close") browser.close(tab.pageId);
      else if (command === "close-others") for (const other of others) browser.close(other.pageId);
      else if (command === "reopen-closed") reopenClosed();
    }).catch((caught) => onError(browserErrorText(caught, "The tab’s menu could not open.")));
  }

  /** A tab that comes to the front is shown, as a new one is: a duplicated or reopened tab has no page until then. */
  function reopenClosed(): void {
    if (!browser.canReopen) return;
    browser.reopenClosed();
    if (collapsed) onLayout("split");
  }

  function cycle(step: 1 | -1, fromPage = false): void {
    if (tabs.length < 2) return;
    const index = tabs.findIndex((tab) => tab.pageId === activeId);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (!next) return;
    focusNextPageRef.current = fromPage;
    choose(next);
  }

  /** ⌘1 to ⌘8 choose a tab by its place, and ⌘9 the last one, as browsers do. */
  function chooseByNumber(key: string, fromPage = false): boolean {
    const tab = key === "9" ? tabs.at(-1) : tabs[Number(key) - 1];
    if (!tab) return false;
    focusNextPageRef.current = fromPage && tab.pageId !== activeId;
    choose(tab);
    return true;
  }

  function tabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (!next) return;
    browser.select(next.pageId);
    window.requestAnimationFrame(() => stripRef.current?.querySelector<HTMLElement>(`[data-browser-tab="${next.pageId}"] [role="tab"]`)?.focus());
  }

  function newTab(): void {
    browser.newTab();
    if (collapsed) onLayout("split");
  }

  // The browser's own keys while the pane has the keyboard, wherever in the pane it is; the same keys arrive from
  // the host while a page has it.
  function paneKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey && tabs.length > 1) {
      event.preventDefault();
      cycle(event.shiftKey ? -1 : 1);
      return;
    }
    const command = isMacOS() ? event.metaKey : event.ctrlKey;
    if (!command || event.altKey) return;
    const key = event.key.toLowerCase();
    const mine = () => { event.preventDefault(); event.nativeEvent.stopPropagation(); };
    if (key === "t") {
      mine();
      if (event.shiftKey) reopenClosed(); else newTab();
    } else if (event.shiftKey) {
      return;
    } else if (/^[1-9]$/.test(key)) {
      if (chooseByNumber(key)) mine();
    } else if (key === "l" && pageActionsRef.current) {
      mine();
      pageActionsRef.current.focusAddress();
    } else if (key === "f" && pageActionsRef.current && (pages[activeId ?? ""] || active?.url)) {
      // Find in Page, not the folder's Search, wherever in the pane the keyboard is.
      mine();
      pageActionsRef.current.openFind();
    }
  }

  return <section className="fm-browser" data-layout={layout} ref={paneRef} aria-label="Browser" onKeyDown={paneKeyDown}>
    <header className="fm-browser-bar">
      <div className="fm-browser-tabs" role="tablist" aria-label="Browser Tabs" ref={stripRef}>
        <span className="fm-browser-tab-chrome" aria-hidden="true" ref={chromeRef} />
        {tabs.map((tab, index) => {
          const page = pages[tab.pageId];
          const title = browserTabTitle(tab, page);
          const selected = !collapsed && tab.pageId === activeId;
          const state = [page?.permissionRequest ? "the site is waiting for your answer" : "", page?.worker ? "a Worker is using it" : "", page?.audible && !page.muted ? "playing sound" : ""].filter(Boolean).join(", ");
          return <div
            key={tab.pageId}
            className={`fm-browser-tab${selected ? " is-on" : ""}`}
            role="presentation"
            data-browser-tab={tab.pageId}
            data-exit-motion="collapse-inline"
            onContextMenu={(event) => tabMenu(tab, event)}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); browser.close(tab.pageId); } }}
          >
            <button
              type="button"
              role="tab"
              className="fm-browser-tab-main"
              aria-selected={selected}
              aria-label={state ? `${title}, ${state}` : title}
              title={title}
              tabIndex={tab.pageId === activeId ? 0 : -1}
              onClick={() => choose(tab)}
              onKeyDown={(event) => tabKeyDown(event, index)}
            >
              <span className="fm-browser-tab-icon" aria-hidden="true">
                {page?.loading ? <span className="fm-browser-spinner" /> : page?.favicon ? <img src={page.favicon} alt="" draggable={false} /> : <Globe16Regular />}
              </span>
              <span className="fm-browser-tab-title">{title}</span>
              {page?.muted ? <SpeakerMute16Regular className="fm-browser-tab-sound" aria-hidden="true" /> : page?.audible ? <Speaker216Regular className="fm-browser-tab-sound" aria-hidden="true" /> : null}
              {page?.permissionRequest ? <span className="fm-dot is-ask" aria-hidden="true" /> : page?.worker ? <span className="fm-dot is-run" aria-hidden="true" /> : null}
            </button>
            <button type="button" className="fm-browser-tab-close" aria-label={`Close ${title}`} title="Close Tab" tabIndex={-1} onClick={() => browser.close(tab.pageId)}><Dismiss12Regular /></button>
          </div>;
        })}
      </div>
      <button type="button" className="fm-browser-tool fm-browser-new" aria-label="New Tab" title="New Tab" onClick={newTab}><Add16Regular /></button>
      <div className="fm-browser-bar-space" />
      <div className="fm-capsule fm-browser-layout" role="group" aria-label="Browser Layout">
        {layout === "full"
          ? <button type="button" className="fm-tool" aria-label="Show Folder" title="Show Folder" onClick={() => onLayout("split")}><PanelTopExpand20Regular /></button>
          : <button type="button" className="fm-tool" aria-label="Hide Folder" title="Hide Folder" onClick={() => onLayout("full")}><PanelTopContract20Regular /></button>}
        {collapsed
          ? <button type="button" className="fm-tool" aria-label="Show Browser" title="Show Browser" aria-expanded={false} onClick={() => onLayout("split")}><PanelBottomExpand20Regular /></button>
          : <button type="button" className="fm-tool" aria-label="Hide Browser" title="Hide Browser" aria-expanded={true} onClick={() => onLayout("collapsed")}><PanelBottomContract20Regular /></button>}
      </div>
    </header>
    {!collapsed && active && bridge ? <BrowserPageView
      key={active.pageId}
      bridge={bridge}
      tab={active}
      sample={sample}
      page={pages[active.pageId]}
      worker={pages[active.pageId]?.worker ? describeWorker(pages[active.pageId]!.worker!.owner) : null}
      onNavigate={(address) => browser.navigate(active.pageId, address)}
      actionsRef={pageActionsRef}
      takeKeyboard={() => { const take = focusNextPageRef.current; focusNextPageRef.current = false; return take; }}
      onShown={(shown) => onViewing(shown ? active.pageId : null)}
      onError={onError}
    /> : null}
  </section>;
}

/**
 * The tab in front: Back, Forward, Reload, the address field, what a site or
 * a Worker has to say, and the placeholder the desktop host draws the page
 * over. Only the person answers a site's question, and only here.
 */
function BrowserPageView({ bridge, tab, sample, page, worker, onNavigate, actionsRef, takeKeyboard, onShown, onError }: {
  bridge: BrowserBridge;
  tab: BrowserTab;
  sample: boolean;
  /** The page's latest state from the desktop host; absent until the page exists. */
  page: BrowserPageState | undefined;
  worker: BrowserPaneWorker | null;
  onNavigate: (address: string) => Promise<void>;
  /** Where the pane's keys find this tab's address field and find bar. */
  actionsRef: RefObject<{ focusAddress: () => void; openFind: () => void } | null>;
  /** True once, when this tab was chosen with a key pressed in a page: its page takes the keyboard. */
  takeKeyboard: () => boolean;
  /** Whether the page is drawn where the person can see it. */
  onShown: (shown: boolean) => void;
  onError: (message: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const siteRef = useRef<HTMLDivElement>(null);
  const siteMenuRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);
  const [siteOpen, setSiteOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const suggestRequestRef = useRef(0);
  const [recent, setRecent] = useState<HistoryEntry[] | null>(null);
  const url = page?.url || tab.url;
  // A new tab has no page yet; the first address typed creates it.
  const hasPage = Boolean(page) || Boolean(tab.url);
  const blocked = Boolean(page?.error || page?.crashed);
  const latestRef = useRef({ pageId: tab.pageId, url: tab.url, blocked });
  latestRef.current = { pageId: tab.pageId, url: tab.url, blocked };
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  /** Places the page now rather than on the next frame: a bar that just appeared above the page must not be drawn over. */
  const placeNowRef = useRef<() => void>(() => undefined);
  /** A failed call says why in the window's notice, in the desktop's own words. */
  const run = (work: Promise<unknown>, fallback: string) => { void work.catch((caught) => onError(browserErrorText(caught, fallback))); };

  // Keeps the host's page over the placeholder: placed on mount, moved on every change of size or overlay.
  useLayoutEffect(() => {
    if (!hasPage) return;
    const element = viewportRef.current;
    if (!element) return;
    let disposed = false;
    let mounted = false;
    let frame = 0;
    let sequence = 0;
    let sent = "";
    const request = (): BrowserViewRequest => browserViewRequest(element, sequence++, latestRef.current);
    const update = () => {
      frame = 0;
      if (disposed || !mounted) return;
      const next = request();
      onShownRef.current(next.active && !next.occluded);
      const key = JSON.stringify([next.bounds, next.active, next.occluded]);
      if (key === sent) return;
      sent = key;
      bridge.layout(next);
    };
    placeNowRef.current = () => { if (frame) { window.cancelAnimationFrame(frame); } update(); };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const resizeObserver = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(schedule) : null;
    const mutationObserver = typeof window.MutationObserver === "function" ? new window.MutationObserver(schedule) : null;
    resizeObserver?.observe(element);
    mutationObserver?.observe(document.body, { attributes: true, childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    void bridge.mount(request()).then(() => {
      if (disposed) return;
      mounted = true;
      schedule();
      if (takeKeyboard()) run(bridge.command(tab.pageId, { type: "focus" }), "The page could not take the keyboard.");
    }).catch((caught) => {
      if (!disposed) onError(browserErrorText(caught, "The page could not open."));
    });
    return () => {
      disposed = true;
      placeNowRef.current = () => undefined;
      onShownRef.current(false);
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      void bridge.unmount(tab.pageId).catch(() => undefined);
    };
  }, [bridge, hasPage, tab.pageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The site's menu closes on a click elsewhere or Escape, like the window's other menus.
  useEffect(() => {
    if (!siteOpen) return;
    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (siteRef.current?.contains(event.target) || siteMenuRef.current?.contains(event.target))) return;
      setSiteOpen(false);
    };
    const keyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setSiteOpen(false); };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, [siteOpen]);
  useEffect(() => { setSiteOpen(false); }, [url]);

  useEffect(() => bridge.onFindResult((result) => {
    if (result.pageId === tab.pageId) setFindResult(result);
  }), [bridge, tab.pageId]);

  // A bar above the page appears or goes: the page moves in the same frame, so it is never drawn over the bar.
  const question = page?.permissionRequest ?? null;
  useLayoutEffect(() => { placeNowRef.current(); }, [question?.requestId, page?.notice?.text, page?.blockedPopup?.url, findOpen, blocked]);

  useEffect(() => {
    actionsRef.current = { focusAddress, openFind };
    return () => { actionsRef.current = null; };
  });

  // A new tab is ready to type into, and lists the pages visited lately.
  useEffect(() => {
    if (hasPage) return;
    window.requestAnimationFrame(() => addressRef.current?.focus());
    void bridge.recent().then(setRecent).catch(() => setRecent([]));
  }, [bridge, hasPage]);

  function focusAddress(): void {
    window.requestAnimationFrame(() => {
      addressRef.current?.focus();
      addressRef.current?.select();
    });
  }

  function openFind(): void {
    setFindOpen(true);
    window.requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  }

  function closeFind(): void {
    setFindOpen(false);
    setFindResult(null);
    run(bridge.command(tab.pageId, { type: "stop-find" }), "Find could not be closed.");
    run(bridge.command(tab.pageId, { type: "focus" }), "The page could not take the keyboard.");
  }

  function find(text: string, options: { forward: boolean; newSearch: boolean }): void {
    if (!text) {
      setFindResult(null);
      run(bridge.command(tab.pageId, { type: "stop-find" }), "Find could not be closed.");
      return;
    }
    run(bridge.command(tab.pageId, { type: "find", text, ...options }), "The page could not be searched.");
  }

  /** What someone typed: Return's own row first (the address, or a search), then matching pages from history. */
  function typed(value: string): void {
    setDraft(value);
    setSelectedSuggestion(0);
    const text = value.trim();
    const requestId = ++suggestRequestRef.current;
    if (!text) {
      setSuggestions([]);
      return;
    }
    // An address the browser cannot show is searched for, so Return always leads somewhere.
    const target = browserAddressToOpen(text);
    const first: AddressSuggestion[] = target
      ? [target.search ? { key: "search", url: target.url, label: `Search Google for “${text}”` } : { key: "go", url: target.url, label: target.url }]
      : [];
    setSuggestions(first);
    void bridge.suggest(text).then((entries) => {
      if (requestId !== suggestRequestRef.current) return;
      const found = entries
        .filter((entry) => entry.url !== first[0]?.url)
        .map((entry) => ({ key: entry.url, url: entry.url, label: entry.title || entry.url, ...(entry.title ? { detail: entry.url } : {}) }));
      setSuggestions([...first, ...found]);
    }).catch(() => undefined);
  }

  function closeSuggestions(): void {
    suggestRequestRef.current += 1;
    setSuggestions([]);
    setSelectedSuggestion(0);
  }

  function go(address: string): void {
    const target = browserAddressToOpen(address);
    if (!target) return;
    closeSuggestions();
    setDraft(null);
    addressRef.current?.blur();
    run(onNavigate(target.url).then(() => bridge.command(tab.pageId, { type: "focus" })), "The page could not open.");
  }

  /** The answer goes to the question the bar was drawn for, never to whichever question the page has by now. */
  function answer(request: BrowserPermissionRequest, decision: "allow" | "block"): void {
    run(bridge.respondPermission(tab.pageId, request.requestId, decision), "The site’s request could not be answered.");
  }

  function command(type: "back" | "forward" | "reload" | "stop"): void {
    run(bridge.command(tab.pageId, { type }), "The browser could not do that.");
  }

  async function clearHistory(): Promise<void> {
    const confirmed = await requestConfirm({
      title: "Clear Browsing History?",
      body: "This removes every page the browser remembers visiting, for you and for your Workers. Sign-ins stay. It can’t be undone.",
      confirmLabel: "Clear History",
      tone: "danger",
    });
    if (!confirmed) return;
    run(bridge.clearHistory().then(() => setRecent([])), "History could not be cleared.");
  }

  function addressKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelectedSuggestion((current) => Math.max(0, Math.min(suggestions.length - 1, current + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(suggestions[selectedSuggestion]?.url ?? event.currentTarget.value);
    } else if (event.key === "Escape" && suggestions.length) {
      event.preventDefault();
      closeSuggestions();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(null);
      event.currentTarget.blur();
      if (hasPage) run(bridge.command(tab.pageId, { type: "focus" }), "The page could not take the keyboard.");
    }
  }

  function findKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      find(findText, { forward: !event.shiftKey, newSearch: false });
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFind();
    }
  }

  const loading = page?.loading ?? false;
  const address = draft ?? browserDisplayAddress(url);
  const external = /^https?:/i.test(url);
  const connection = hasPage ? browserConnection(url) : "none";
  const connectionText = connection === "secure"
    ? "Connection is secure"
    : connection === "insecure"
      ? "Connection is not secure. Don’t enter passwords or payment details on this site."
      : /^file:/i.test(url) ? "This is a file on this computer" : "This page is served by this computer";
  return <div className="fm-browser-page">
    <div className="fm-browser-nav">
      <div className="fm-capsule">
        <button type="button" className="fm-tool" disabled={!page?.canGoBack} onClick={() => command("back")} aria-label="Back" title="Back"><ArrowLeft16Regular /></button>
        <button type="button" className="fm-tool" disabled={!page?.canGoForward} onClick={() => command("forward")} aria-label="Forward" title="Forward"><ArrowRight16Regular /></button>
        <button type="button" className="fm-tool" disabled={!hasPage} onClick={() => command(loading ? "stop" : "reload")} aria-label={loading ? "Stop Loading" : "Reload"} title={loading ? "Stop Loading" : "Reload"}>
          {loading ? <Dismiss16Regular /> : <ArrowClockwise16Regular />}
        </button>
      </div>
      <div className="fm-browser-address-wrap">
        <div className={`fm-browser-address${loading ? " is-loading" : ""}`}>
          {connection !== "none" ? <div className="fm-browser-site" ref={siteRef}>
            <button
              type="button"
              className={`fm-browser-site-button${connection === "insecure" ? " is-insecure" : ""}`}
              onClick={() => setSiteOpen((open) => !open)}
              aria-label={`Site Information: ${connectionText}`}
              aria-haspopup="menu"
              aria-expanded={siteOpen}
              title="Site Information"
            >
              {connection === "secure" ? <LockClosed16Regular /> : connection === "insecure" ? <Warning16Regular /> : <Info16Regular />}
              {connection === "insecure" ? <span>Not Secure</span> : null}
            </button>
          </div> : <span className="fm-browser-address-glyph" aria-hidden="true"><Search16Regular /></span>}
          <input
            ref={addressRef}
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            placeholder="Search or type a web address"
            role="combobox"
            aria-label="Address"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls={`fm-browser-suggestions-${tab.pageId}`}
            {...(suggestions[selectedSuggestion] ? { "aria-activedescendant": `fm-browser-suggestion-${tab.pageId}-${selectedSuggestion}` } : {})}
            value={address}
            onChange={(event) => typed(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => { setDraft(null); closeSuggestions(); }}
            onKeyDown={addressKeyDown}
          />
          {page && page.zoomPercent !== 100 ? <button type="button" className="fm-browser-zoom" onClick={() => run(bridge.command(tab.pageId, { type: "zoom-reset" }), "Zoom could not be reset.")} title="Reset Zoom" aria-label={`Zoom ${page.zoomPercent}%. Reset zoom`}>{page.zoomPercent}%</button> : null}
        </div>
        {siteOpen ? <div className="fm-browser-site-menu" ref={siteMenuRef} role="menu" aria-label={`Settings for ${browserHost(url)}`} data-native-view-occluder="true">
          <span className="fm-browser-site-menu-h">{browserHost(url) || url}</span>
          <span className={`fm-browser-site-menu-s${connection === "insecure" ? " is-insecure" : ""}`}>{connectionText}</span>
          {page?.sitePermissions.map((item) => <div className="fm-browser-site-menu-row" key={item.kind}>
            <span>{browserPermissionNames[item.kind]}</span>
            <span className="fm-browser-site-menu-decision">{item.decision === "allow" ? "Allowed" : "Blocked"}</span>
            <button type="button" className="fm-btn is-small" role="menuitem" onClick={() => run(bridge.command(tab.pageId, { type: "forget-permission", kind: item.kind }), "The site’s setting could not be changed.")} title="The site asks again the next time it needs this">Ask Again</button>
          </div>)}
        </div> : null}
        {suggestions.length ? <ul className="fm-browser-suggestions" id={`fm-browser-suggestions-${tab.pageId}`} role="listbox" aria-label="Suggestions" data-native-view-occluder="true">
          {suggestions.map((suggestion, index) => <li
            key={suggestion.key}
            id={`fm-browser-suggestion-${tab.pageId}-${index}`}
            role="option"
            aria-selected={index === selectedSuggestion}
            className={index === selectedSuggestion ? "is-selected" : undefined}
            // Keep the address field focused, so its text stays while a row is chosen.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelectedSuggestion(index)}
            onClick={() => go(suggestion.url)}
          >
            {suggestion.key === "search" ? <Search16Regular aria-hidden="true" /> : <Globe16Regular aria-hidden="true" />}
            <span className="fm-browser-suggestion-label">{suggestion.label}</span>
            {suggestion.detail ? <span className="fm-browser-suggestion-detail">{suggestion.detail}</span> : null}
          </li>)}
        </ul> : null}
      </div>
      {worker ? <div className="fm-browser-worker" role="status" title={worker.title}>
        <span className="fm-dot is-run" aria-hidden="true" />
        <span className="fm-browser-worker-text">{worker.label}</span>
        {worker.onOpen ? <button type="button" className="fm-browser-tool" onClick={worker.onOpen} aria-label="Open the Chat" title="Open the Chat"><Chat16Regular /></button> : null}
      </div> : null}
      <button type="button" className="fm-browser-tool" disabled={!hasPage} onClick={openFind} aria-label="Find in Page" title="Find in Page"><Search16Regular /></button>
      <button type="button" className="fm-browser-tool" disabled={!external} onClick={() => { const open = window.ampleFileDesktop?.shell.openExternal(url); if (open) run(open, "The page could not open."); }} aria-label="Open in Your Web Browser" title="Open in Your Web Browser"><Open16Regular /></button>
    </div>
    {question ? <SiteQuestion key={question.requestId} request={question} onAnswer={(decision) => answer(question, decision)} /> : null}
    {page?.notice ? <div className="fm-browser-strip" role="status">
      <Warning16Regular aria-hidden="true" />
      <span className="fm-browser-strip-text">{page.notice.text}</span>
      {isMacOS() ? <button type="button" className="fm-btn is-small" onClick={() => run(bridge.command(tab.pageId, { type: "open-privacy-settings", kind: page.notice!.kind }), "System Settings could not open.")}>Open System Settings</button> : null}
      <button type="button" className="fm-browser-tool" onClick={() => run(bridge.command(tab.pageId, { type: "dismiss-notice" }), "The notice could not be dismissed.")} aria-label="Dismiss" title="Dismiss"><Dismiss16Regular /></button>
    </div> : null}
    {page?.blockedPopup ? <div className="fm-browser-strip" role="status">
      <WindowNew16Regular aria-hidden="true" />
      <span className="fm-browser-strip-text">Pop-up blocked{page.blockedPopup.origin ? ` from ${browserHost(page.blockedPopup.origin)}` : ""}: <span className="fm-browser-strip-url">{page.blockedPopup.url}</span></span>
      <button type="button" className="fm-btn is-small" disabled={!page.blockedPopup.origin} onClick={() => run(bridge.command(tab.pageId, { type: "allow-popups" }), "The pop-up could not open.")}>Always Allow on This Site</button>
      <button type="button" className="fm-btn is-small is-primary" onClick={() => run(bridge.command(tab.pageId, { type: "open-blocked-popup" }), "The pop-up could not open.")}>Open It</button>
      <button type="button" className="fm-browser-tool" onClick={() => run(bridge.command(tab.pageId, { type: "dismiss-blocked-popup" }), "The notice could not be dismissed.")} aria-label="Dismiss" title="Dismiss"><Dismiss16Regular /></button>
    </div> : null}
    {findOpen ? <div className="fm-browser-strip is-find" role="search">
      <input
        ref={findRef}
        type="search"
        aria-label="Find in Page"
        placeholder="Find in Page"
        maxLength={1000}
        value={findText}
        onChange={(event) => { setFindText(event.target.value); find(event.target.value, { forward: true, newSearch: true }); }}
        onKeyDown={findKeyDown}
      />
      <span className="fm-browser-find-count" aria-live="polite">{findText && findResult ? (findResult.matches ? `${findResult.activeMatch} of ${findResult.matches}` : "No Matches") : ""}</span>
      <button type="button" className="fm-browser-tool" disabled={!findResult?.matches} onClick={() => find(findText, { forward: false, newSearch: false })} aria-label="Previous Match" title="Previous Match"><ChevronUp16Regular /></button>
      <button type="button" className="fm-browser-tool" disabled={!findResult?.matches} onClick={() => find(findText, { forward: true, newSearch: false })} aria-label="Next Match" title="Next Match"><ChevronDown16Regular /></button>
      <button type="button" className="fm-browser-tool" onClick={closeFind} aria-label="Close Find" title="Close Find"><Dismiss16Regular /></button>
    </div> : null}
    <div className="fm-browser-viewport" ref={viewportRef}>
      {!hasPage ? <div className="fm-browser-state is-new">
        {recent?.length ? <div className="fm-browser-recent">
          <h2 className="fm-sec-h">Recent</h2>
          <div className="fm-card">
            {recent.map((entry) => <button type="button" className="fm-browser-recent-item" key={entry.url} onClick={() => go(entry.url)} title={entry.url}>
              <Globe16Regular aria-hidden="true" />
              <span className="fm-browser-recent-title">{entry.title || browserHost(entry.url)}</span>
              <span className="fm-browser-recent-host">{browserHost(entry.url)}</span>
            </button>)}
          </div>
          <button type="button" className="fm-text-button" onClick={() => void clearHistory()}>Clear Browsing History…</button>
        </div> : <>
          <strong>Search or Type a Web Address</strong>
        </>}
        <span className="fm-browser-state-note">Sign-ins here are shared by every Worker and the AmpleFile Agent.</span>
      </div> : page?.crashed ? <div className="fm-browser-state">
        <strong>This Page Stopped</strong>
        <span>Reload it to try again.</span>
        <button type="button" className="fm-btn" onClick={() => command("reload")}>Reload</button>
      </div> : page?.error ? <div className="fm-browser-state">
        <strong>This Page Couldn’t Load</strong>
        <span>{page.error.description || "The site didn’t respond."}</span>
        <code>{page.error.url}</code>
        <button type="button" className="fm-btn" onClick={() => command("reload")}>Try Again</button>
      </div> : sample ? <div className="fm-browser-sample">The page shows here in the Mac app.</div> : null}
    </div>
  </div>;
}

/**
 * A site's question, above its page. Each question is its own bar with its
 * own buttons, and the buttons take no press for a moment after the bar
 * appears: a second press of a double-click, or a press aimed at what was
 * there a moment ago, never answers a question the person has not read. The
 * answer is kept for the site, so a stray one would last.
 */
function SiteQuestion({ request, onAnswer }: { request: BrowserPermissionRequest; onAnswer: (decision: "allow" | "block") => void }) {
  const [armed, setArmed] = useState(false);
  const answered = useRef(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), browserQuestionGuardMs);
    return () => window.clearTimeout(timer);
  }, []);
  const answer = (decision: "allow" | "block") => {
    if (!armed || answered.current) return;
    answered.current = true;
    onAnswer(decision);
  };
  return <div className="fm-browser-strip is-question" role="alert">
    <ShieldQuestion20Regular aria-hidden="true" />
    <span className="fm-browser-strip-text"><strong>{browserHost(request.origin)}</strong> wants to {browserPermissionPhrase(request.kinds)}.</span>
    <button type="button" className="fm-btn is-small" disabled={!armed} onClick={() => answer("block")}>Block</button>
    <button type="button" className="fm-btn is-small is-primary" disabled={!armed} onClick={() => answer("allow")}>Allow</button>
  </div>;
}

function browserViewRequest(element: HTMLElement, sequence: number, latest: { pageId: string; url: string; blocked: boolean }): BrowserViewRequest {
  const box = element.getBoundingClientRect();
  const bounds = nativeViewBounds(element, box);
  const active = !element.closest("[hidden], [inert]") && document.visibilityState === "visible";
  return {
    pageId: latest.pageId,
    url: latest.url,
    sequence,
    bounds,
    active,
    // An error or a stopped page shows its message here instead of the page.
    occluded: !active || latest.blocked || bounds.width < 1 || bounds.height < 1 || nativeViewOccluded(element, box),
  };
}

/**
 * The slider between the folder and the Browser pane. While it is dragged the
 * share goes straight onto the main area's custom property, so both halves
 * reflow every frame without a React render; letting go saves it.
 * Double-click puts the default back, and the arrow keys, Home, End, and
 * Enter work from the keyboard.
 */
export function BrowserSplitResizer({ fraction, mainRef, onCommit }: {
  /** The Browser pane's share of the height under the toolbar. */
  fraction: number;
  mainRef: RefObject<HTMLElement | null>;
  onCommit: (fraction: number) => void;
}) {
  const drag = useRef<{ pointerId: number; current: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const show = (next: number) => mainRef.current?.style.setProperty("--fm-browser-fraction", String(next));
  const at = (clientY: number): number => {
    const main = mainRef.current;
    if (!main) return fraction;
    const box = main.getBoundingClientRect();
    const toolbar = main.querySelector<HTMLElement>(".fm-toolbar")?.getBoundingClientRect().height ?? 0;
    const available = box.height - toolbar;
    return available > 0 ? clampBrowserFraction((box.bottom - clientY) / available) : fraction;
  };

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, current: fraction };
    setDragging(true);
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = at(event.clientY);
    if (next === active.current) return;
    active.current = next;
    show(next);
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (active.current !== fraction) onCommit(active.current);
  }
  function keyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.1 : 0.03;
    let next: number | null = null;
    if (event.key === "ArrowUp") next = fraction + step;
    else if (event.key === "ArrowDown") next = fraction - step;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = 1;
    else if (event.key === "Enter") next = browserSplitLimits.defaultFraction;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampBrowserFraction(next);
    show(clamped);
    onCommit(clamped);
  }

  return <div
    className={`fm-browser-divide fm-browser-resize${dragging ? " is-dragging" : ""}`}
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize the Browser"
    aria-valuemin={15}
    aria-valuemax={85}
    aria-valuenow={Math.round(fraction * 100)}
    tabIndex={0}
    onPointerDown={pointerDown}
    onPointerMove={pointerMove}
    onPointerUp={pointerUp}
    onPointerCancel={pointerUp}
    onLostPointerCapture={pointerUp}
    onDoubleClick={() => { show(browserSplitLimits.defaultFraction); onCommit(browserSplitLimits.defaultFraction); }}
    onKeyDown={keyDown}
  />;
}
