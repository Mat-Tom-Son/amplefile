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
  browserAddressFor,
  browserConnection,
  browserDisplayAddress,
  browserPermissionNames,
  browserPermissionPhrase,
  browserSearchUrl,
  type BrowserFindResult,
  type BrowserPageState,
  type BrowserViewRequest,
} from "../../../../src/shared/browser";
import type { BrowserPages } from "../../hooks/useBrowserPages";
import { browserHost, browserSplitLimits, browserTabTitle, clampBrowserFraction, type BrowserPaneLayout, type BrowserTab } from "../../lib/browser-pages";
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
export function BrowserPane({ browser, layout, onLayout, sample = false, describeWorker, onError }: {
  browser: BrowserPages;
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
    // Beside the folder they sit over the folder's list; with the folder folded away, just above the page.
    const viewport = layout === "full" ? pane.querySelector<HTMLElement>(".fm-browser-viewport") : null;
    const place = () => {
      root.setProperty("--fm-notice-bottom", `${Math.max(40, Math.round(window.innerHeight - (viewport ?? pane).getBoundingClientRect().top + 10))}px`);
    };
    place();
    const observer = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(place) : null;
    observer?.observe(pane);
    if (viewport) observer?.observe(viewport);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      root.removeProperty("--fm-notice-bottom");
    };
  }, [layout, activeId]);

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
      if (command === "duplicate" && url) browser.newTab(url);
      else if (command === "close") browser.close(tab.pageId);
      else if (command === "close-others") for (const other of others) browser.close(other.pageId);
      else if (command === "reopen-closed") browser.reopenClosed();
    }).catch(() => undefined);
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

  // The app's own browser keys while the pane has focus; the same keys arrive from the host while a page has it.
  function paneKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey && tabs.length > 1) {
      event.preventDefault();
      const index = tabs.findIndex((tab) => tab.pageId === activeId);
      const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      if (next) choose(next);
      return;
    }
    const command = isMacOS() ? event.metaKey : event.ctrlKey;
    if (!command || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "t") {
      event.preventDefault();
      event.nativeEvent.stopPropagation();
      if (event.shiftKey) browser.reopenClosed(); else newTab();
    } else if (/^[1-9]$/.test(key) && !event.shiftKey) {
      // ⌘1 to ⌘8 choose a tab by its place, and ⌘9 the last one, as browsers do.
      const tab = key === "9" ? tabs.at(-1) : tabs[Number(key) - 1];
      if (!tab) return;
      event.preventDefault();
      event.nativeEvent.stopPropagation();
      choose(tab);
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
      onNewTab={newTab}
      onReopenClosed={browser.reopenClosed}
      onSelectIndex={(index) => { const tab = index === 8 ? tabs.at(-1) : tabs[index]; if (tab) browser.select(tab.pageId); }}
      onCycle={(step) => { const index = tabs.findIndex((tab) => tab.pageId === active.pageId); const next = tabs[(index + step + tabs.length) % tabs.length]; if (next) browser.select(next.pageId); }}
      onError={onError}
    /> : null}
  </section>;
}

/**
 * The tab in front: Back, Forward, Reload, the address field, what a site or
 * a Worker has to say, and the placeholder the desktop host draws the page
 * over. Only the person answers a site's question, and only here.
 */
function BrowserPageView({ bridge, tab, sample, page, worker, onNavigate, onNewTab, onReopenClosed, onSelectIndex, onCycle, onError }: {
  bridge: BrowserBridge;
  tab: BrowserTab;
  sample: boolean;
  /** The page's latest state from the desktop host; absent until the page exists. */
  page: BrowserPageState | undefined;
  worker: BrowserPaneWorker | null;
  onNavigate: (address: string) => Promise<void>;
  onNewTab: () => void;
  onReopenClosed: () => void;
  onSelectIndex: (index: number) => void;
  onCycle: (step: 1 | -1) => void;
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
  const callbacksRef = useRef({ onNewTab, onReopenClosed, onSelectIndex, onCycle });
  callbacksRef.current = { onNewTab, onReopenClosed, onSelectIndex, onCycle };

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
      const key = JSON.stringify([next.bounds, next.active, next.occluded]);
      if (key === sent) return;
      sent = key;
      bridge.layout(next);
    };
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
    }).catch((caught) => {
      if (!disposed) onError(caught instanceof Error ? caught.message : "The page could not open.");
    });
    return () => {
      disposed = true;
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

  // The page had the keyboard, so the browser's own keys arrive from the host.
  useEffect(() => bridge.onShortcut((shortcut) => {
    if (shortcut.pageId !== tab.pageId) return;
    const key = shortcut.key.toLowerCase();
    if (key === "tab" && shortcut.ctrlKey) callbacksRef.current.onCycle(shortcut.shiftKey ? -1 : 1);
    else if (key === "l") focusAddress();
    else if (key === "f") openFind();
    else if (key === "t") { if (shortcut.shiftKey) callbacksRef.current.onReopenClosed(); else callbacksRef.current.onNewTab(); }
    else if (/^[1-9]$/.test(key)) callbacksRef.current.onSelectIndex(Number(key) - 1);
  }), [bridge, tab.pageId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    void bridge.command(tab.pageId, { type: "stop-find" });
    void bridge.command(tab.pageId, { type: "focus" });
  }

  function find(text: string, options: { forward: boolean; newSearch: boolean }): void {
    if (!text) {
      setFindResult(null);
      void bridge.command(tab.pageId, { type: "stop-find" });
      return;
    }
    void bridge.command(tab.pageId, { type: "find", text, ...options });
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
    const target = browserAddressFor(text);
    const first: AddressSuggestion[] = target
      ? [target.startsWith(browserSearchUrl) ? { key: "search", url: target, label: `Search Google for “${text}”` } : { key: "go", url: target, label: target }]
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
    if (!address.trim()) return;
    closeSuggestions();
    setDraft(null);
    addressRef.current?.blur();
    void onNavigate(address)
      .then(() => bridge.command(tab.pageId, { type: "focus" }))
      .catch((caught) => onError(caught instanceof Error ? caught.message : "The page could not open."));
  }

  function answer(decision: "allow" | "block"): void {
    const request = page?.permissionRequest;
    if (!request) return;
    void bridge.respondPermission(tab.pageId, request.requestId, decision).catch((caught) => onError(caught instanceof Error ? caught.message : "The site’s request could not be answered."));
  }

  function command(type: "back" | "forward" | "reload" | "stop"): void {
    void bridge.command(tab.pageId, { type }).catch((caught) => onError(caught instanceof Error ? caught.message : "The browser could not do that."));
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
      if (hasPage) void bridge.command(tab.pageId, { type: "focus" });
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

  // ⌘L and ⌘F while the pane's own controls have the keyboard.
  function viewKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    const meta = isMacOS() ? event.metaKey : event.ctrlKey;
    if (!meta || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key !== "l" && key !== "f") return;
    if (key === "f" && !hasPage) return;
    event.preventDefault();
    event.nativeEvent.stopPropagation();
    if (key === "l") focusAddress(); else openFind();
  }

  const loading = page?.loading ?? false;
  const address = draft ?? browserDisplayAddress(url);
  const external = /^https?:/i.test(url);
  const request = page?.permissionRequest ?? null;
  const connection = hasPage ? browserConnection(url) : "none";
  const connectionText = connection === "secure"
    ? "Connection is secure"
    : connection === "insecure"
      ? "Connection is not secure. Don’t enter passwords or payment details on this site."
      : /^file:/i.test(url) ? "This is a file on this computer" : "This page is served by this computer";
  return <div className="fm-browser-page" onKeyDown={viewKeyDown}>
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
          {page && page.zoomPercent !== 100 ? <button type="button" className="fm-browser-zoom" onClick={() => { void bridge.command(tab.pageId, { type: "zoom-reset" }); }} title="Reset Zoom" aria-label={`Zoom ${page.zoomPercent}%. Reset zoom`}>{page.zoomPercent}%</button> : null}
        </div>
        {siteOpen ? <div className="fm-browser-site-menu" ref={siteMenuRef} role="menu" aria-label={`Settings for ${browserHost(url)}`} data-native-view-occluder="true">
          <span className="fm-browser-site-menu-h">{browserHost(url) || url}</span>
          <span className={`fm-browser-site-menu-s${connection === "insecure" ? " is-insecure" : ""}`}>{connectionText}</span>
          {page?.sitePermissions.map((item) => <div className="fm-browser-site-menu-row" key={item.kind}>
            <span>{browserPermissionNames[item.kind]}</span>
            <span className="fm-browser-site-menu-decision">{item.decision === "allow" ? "Allowed" : "Blocked"}</span>
            <button type="button" className="fm-btn is-small" role="menuitem" onClick={() => { void bridge.command(tab.pageId, { type: "forget-permission", kind: item.kind }); }} title="The site asks again the next time it needs this">Ask Again</button>
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
      <button type="button" className="fm-browser-tool" disabled={!external} onClick={() => { void window.ampleFileDesktop?.shell.openExternal(url).catch((caught) => onError(caught instanceof Error ? caught.message : "The page could not open.")); }} aria-label="Open in Your Web Browser" title="Open in Your Web Browser"><Open16Regular /></button>
    </div>
    {request ? <div className="fm-browser-strip is-question" role="alert">
      <ShieldQuestion20Regular aria-hidden="true" />
      <span className="fm-browser-strip-text"><strong>{browserHost(request.origin)}</strong> wants to {browserPermissionPhrase(request.kinds)}.</span>
      <button type="button" className="fm-btn is-small" onClick={() => answer("block")}>Block</button>
      <button type="button" className="fm-btn is-small is-primary" onClick={() => answer("allow")}>Allow</button>
    </div> : null}
    {page?.notice ? <div className="fm-browser-strip" role="status">
      <Warning16Regular aria-hidden="true" />
      <span className="fm-browser-strip-text">{page.notice.text}</span>
      {isMacOS() ? <button type="button" className="fm-btn is-small" onClick={() => { void bridge.command(tab.pageId, { type: "open-privacy-settings", kind: page.notice!.kind }); }}>Open System Settings</button> : null}
      <button type="button" className="fm-browser-tool" onClick={() => { void bridge.command(tab.pageId, { type: "dismiss-notice" }); }} aria-label="Dismiss" title="Dismiss"><Dismiss16Regular /></button>
    </div> : null}
    {page?.blockedPopup ? <div className="fm-browser-strip" role="status">
      <WindowNew16Regular aria-hidden="true" />
      <span className="fm-browser-strip-text">Pop-up blocked{page.blockedPopup.origin ? ` from ${browserHost(page.blockedPopup.origin)}` : ""}: <span className="fm-browser-strip-url">{page.blockedPopup.url}</span></span>
      <button type="button" className="fm-btn is-small" disabled={!page.blockedPopup.origin} onClick={() => { void bridge.command(tab.pageId, { type: "allow-popups" }); }}>Always Allow on This Site</button>
      <button type="button" className="fm-btn is-small is-primary" onClick={() => { void bridge.command(tab.pageId, { type: "open-blocked-popup" }); }}>Open It</button>
      <button type="button" className="fm-browser-tool" onClick={() => { void bridge.command(tab.pageId, { type: "dismiss-blocked-popup" }); }} aria-label="Dismiss" title="Dismiss"><Dismiss16Regular /></button>
    </div> : null}
    {findOpen ? <div className="fm-browser-strip is-find" role="search">
      <input
        ref={findRef}
        type="search"
        aria-label="Find in Page"
        placeholder="Find in Page"
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
          <button type="button" className="fm-text-button" onClick={() => { void bridge.clearHistory().then(() => setRecent([])).catch((caught) => onError(caught instanceof Error ? caught.message : "History could not be cleared.")); }}>Clear Browsing History</button>
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
