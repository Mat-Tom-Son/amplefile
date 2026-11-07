import { useConnectedFolderIdentityResolver } from "../../lib/connected-folder-appearance-context";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Checkmark16Regular, ChevronDown16Regular, Dismiss12Regular, Speaker216Regular, SpeakerMute16Regular } from "@fluentui/react-icons";

import { chatDisplayTitle } from "../../lib/format";
import { chatActivityKey } from "../../lib/chat-lifecycle";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { readStoredValue, writeStoredValue } from "../../lib/storage";
import { groupSurfaceTabsByConnectedFolder } from "../../lib/surface-tab-groups";
import { createSurfaceTabMotion } from "../../lib/surface-tab-motion";
import { createSurfaceTabReorder } from "../../lib/surface-tab-reorder";
import { connectedFolderIdentityStyle } from "../../lib/connected-folder-identity";
import { surfacePanelDomId, surfaceTabDomId } from "../../lib/connected-folder-ui";
import type { BrowserSurfaceTab, ChatActivityStatus, ConversationSummary, ConnectedFolderCustomizationMap, ConnectedFolderSummary, ConnectedFolderSurfaceTab } from "../../types";
import { BrowserTabIcon, FluentGlyph, NewBrowserTabIcon, NewChatIcon, ConnectedFolderIconGlyph } from "../chrome/common";
import { useFinishCelebration } from "../../hooks/useFinishCelebration";

const groupSurfaceTabsStorageKey = "amplefile.connected-folder.surface-tabs.group-by-connected-folder.v1";

export type SurfaceTabOverflow = "start" | "end" | "both" | null;

/** What a browser tab shows beyond its title: the page's icon, and whether it is loading or playing sound. */
export interface BrowserTabLook {
  favicon: string | null;
  loading: boolean;
  audible: boolean;
  muted: boolean;
  /** The site is waiting for the person to allow or block something. */
  asking: boolean;
  /** A Worker is using the page right now. */
  worker: boolean;
}

/** Size tier for the tab strip: compact above three tabs, dense above six. */
export function surfaceTabCountTier(tabCount: number): "tab-count-dense" | "tab-count-compact" | "" {
  if (tabCount > 6) return "tab-count-dense";
  if (tabCount > 3) return "tab-count-compact";
  return "";
}

/** Which edges of a horizontally scrolling strip hide content. */
export function surfaceTabOverflow(scrollLeft: number, scrollWidth: number, clientWidth: number): SurfaceTabOverflow {
  const tolerance = 1;
  if (scrollWidth - clientWidth <= tolerance) return null;
  const hiddenStart = scrollLeft > tolerance;
  const hiddenEnd = scrollLeft + clientWidth < scrollWidth - tolerance;
  if (hiddenStart && hiddenEnd) return "both";
  if (hiddenStart) return "start";
  if (hiddenEnd) return "end";
  return null;
}

export function ConnectedFolderSurfaceTabBar({
  tabs,
  connectedFolders,
  connectedFolderCustomizations,
  conversations,
  chatActivityStatuses,
  activeTabId,
  newChatConnectedFolderId,
  onActivate,
  onClose,
  onReorder,
  onNewChatInConnectedFolder,
  onTabMenu,
  browserTabLooks = {},
  onNewBrowserTab,
  onBrowserTabMenu,
}: {
  tabs: ConnectedFolderSurfaceTab[];
  connectedFolders: ConnectedFolderSummary[];
  connectedFolderCustomizations: ConnectedFolderCustomizationMap;
  conversations: Record<string, ConversationSummary[]>;
  chatActivityStatuses: Record<string, ChatActivityStatus>;
  activeTabId: string | null;
  newChatConnectedFolderId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (ids: string[]) => void;
  onNewChatInConnectedFolder: (connectedFolder: ConnectedFolderSummary) => void;
  /** A Connected Folder tab's right-click menu, with its Chat when it holds a saved one. */
  onTabMenu: (tab: ConnectedFolderSurfaceTab, connectedFolder: ConnectedFolderSummary, conversation: ConversationSummary | null, event: ReactMouseEvent<HTMLElement>) => void;
  /** Each browser tab's page icon and state, by page id. */
  browserTabLooks?: Record<string, BrowserTabLook>;
  /** Present in the desktop app, where the built-in browser runs. */
  onNewBrowserTab?: () => void;
  /** A browser tab's right-click menu. */
  onBrowserTabMenu?: (tab: BrowserSurfaceTab, event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const connectedFolderIdentityFor = useConnectedFolderIdentityResolver();
  const [connectedFolderMenuOpen, setConnectedFolderMenuOpen] = useState(false);
  const [groupByConnectedFolder, setGroupByConnectedFolder] = useState(() => readStoredValue(groupSurfaceTabsStorageKey) === "true");
  const [overflow, setOverflow] = useState<SurfaceTabOverflow>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const activeChromeRef = useRef<HTMLSpanElement | null>(null);
  const tabMotionRef = useRef<ReturnType<typeof createSurfaceTabMotion> | null>(null);
  const reorderRef = useRef<ReturnType<typeof createSurfaceTabReorder> | null>(null);
  const previousSelectionRef = useRef<{ id: string | null; layout: string } | null>(null);
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const openConnectedFolderCount = new Set(tabs.map((tab) => tab.connectedFolderId)).size;
  const groupingActive = groupByConnectedFolder && openConnectedFolderCount > 1;
  const reorderOptionsRef = useRef({ groupingActive, onReorder });
  reorderOptionsRef.current = { groupingActive, onReorder };
  const orderedTabs = useMemo(
    () => groupingActive ? groupSurfaceTabsByConnectedFolder(tabs).flatMap((group) => group.tabs) : tabs,
    [groupingActive, tabs],
  );
  const tabGroups = useMemo(
    () => groupingActive
      ? groupSurfaceTabsByConnectedFolder(tabs).map((group) => ({ ...group, grouped: true }))
      : [{ connectedFolderId: null, tabs, grouped: false }],
    [groupingActive, tabs],
  );
  const countTier = surfaceTabCountTier(tabs.length);
  const tabLayout = JSON.stringify([groupingActive, orderedTabs.map((tab) => tab.id)]);
  const menuConnectedFolders = [
    ...connectedFolders.filter((item) => item.id === newChatConnectedFolderId),
    ...connectedFolders.filter((item) => item.id !== newChatConnectedFolderId),
  ];

  useLayoutEffect(() => {
    if (!tabsRef.current || !activeChromeRef.current) return;
    const motion = createSurfaceTabMotion(tabsRef.current, activeChromeRef.current);
    tabMotionRef.current = motion;
    return () => { motion.dispose(); tabMotionRef.current = null; };
  }, []);

  useLayoutEffect(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    const reorder = createSurfaceTabReorder(strip, {
      grouped: () => reorderOptionsRef.current.groupingActive,
      commit: (ids) => reorderOptionsRef.current.onReorder(ids),
      announce: (id, position, count) => {
        const title = strip.ownerDocument.getElementById(surfaceTabDomId(id))?.textContent ?? "Tab";
        setReorderAnnouncement(`${title} moved to position ${position} of ${count}.`);
      },
    });
    reorderRef.current = reorder;
    return () => { reorder.dispose(); reorderRef.current = null; };
  }, []);

  useLayoutEffect(() => {
    const previous = previousSelectionRef.current;
    const active = activeTabId ? document.getElementById(surfaceTabDomId(activeTabId))?.closest<HTMLElement>(".surface-tab") ?? null : null;
    tabMotionRef.current?.select(active, Boolean(previous?.id && previous.id !== activeTabId && previous.layout === tabLayout));
    previousSelectionRef.current = { id: activeTabId, layout: tabLayout };
  }, [activeTabId, tabLayout]);

  useLayoutEffect(() => { reorderRef.current?.layout(); }, [tabLayout]);

  useEffect(() => {
    if (!connectedFolderMenuOpen) return;
    window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      setConnectedFolderMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setConnectedFolderMenuOpen(false);
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [connectedFolderMenuOpen]);

  useEffect(() => {
    const tabStrip = tabsRef.current;
    if (!tabStrip) return;
    function revealActiveTab(): void {
      const activeTab = activeTabId ? document.getElementById(surfaceTabDomId(activeTabId)) : null;
      activeTab?.closest(".surface-tab")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    revealActiveTab();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => revealActiveTab());
    observer.observe(tabStrip);
    return () => observer.disconnect();
  }, [activeTabId, groupingActive, countTier]);

  useEffect(() => {
    const tabStrip = tabsRef.current;
    if (!tabStrip) return;
    const strip = tabStrip;
    function measureOverflow(): void {
      setOverflow(surfaceTabOverflow(strip.scrollLeft, strip.scrollWidth, strip.clientWidth));
    }
    function scrollVerticalWheel(event: WheelEvent): void {
      if (strip.scrollWidth <= strip.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      const lineHeight = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
      strip.scrollLeft += event.deltaY * lineHeight;
    }
    measureOverflow();
    strip.addEventListener("scroll", measureOverflow, { passive: true });
    strip.addEventListener("wheel", scrollVerticalWheel, { passive: false });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measureOverflow());
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", measureOverflow);
      strip.removeEventListener("wheel", scrollVerticalWheel);
      observer?.disconnect();
    };
  }, [orderedTabs, groupingActive, countTier]);

  function handleTabListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!orderedTabs.length) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    if (event.altKey && event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      const focused = (event.target as HTMLElement).closest<HTMLElement>(".surface-tab")?.dataset.tabId;
      const tab = orderedTabs.find((item) => item.id === focused);
      if (!tab) return;
      event.preventDefault(); event.stopPropagation();
      const peers = groupingActive ? orderedTabs.filter((item) => item.connectedFolderId === tab.connectedFolderId) : orderedTabs;
      const index = peers.indexOf(tab);
      const target = peers[index + (event.key === "ArrowRight" ? 1 : -1)];
      if (!target) return;
      const ids = orderedTabs.map((item) => item.id);
      const from = ids.indexOf(tab.id); const to = ids.indexOf(target.id);
      [ids[from], ids[to]] = [ids[to]!, ids[from]!];
      reorderRef.current?.reorder(ids);
      setReorderAnnouncement(`${tab.title} moved to position ${peers.indexOf(target) + 1} of ${peers.length}.`);
      return;
    }
    if (event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;

    const activeIndex = orderedTabs.findIndex((tab) => tab.id === activeTabId);
    const currentIndex = activeIndex >= 0 ? activeIndex : 0;
    const lastIndex = orderedTabs.length - 1;
    let nextIndex = currentIndex;

    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = lastIndex;
    else if (event.key === "ArrowRight") nextIndex = activeIndex >= 0 ? (currentIndex + 1) % orderedTabs.length : 0;
    else if (event.key === "ArrowLeft") nextIndex = activeIndex >= 0 ? (currentIndex - 1 + orderedTabs.length) % orderedTabs.length : lastIndex;

    const nextTab = orderedTabs[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    onActivate(nextTab.id);
    window.requestAnimationFrame(() => document.getElementById(surfaceTabDomId(nextTab.id))?.focus());
  }

  function connectedFolderMenuItems(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]') ?? []);
  }

  function handleConnectedFolderMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = connectedFolderMenuItems();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(currentIndex, items.length, event.key as MenuNavigationKey);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  function handleConnectedFolderMenuSelect(targetConnectedFolder: ConnectedFolderSummary): void {
    setConnectedFolderMenuOpen(false);
    onNewChatInConnectedFolder(targetConnectedFolder);
  }

  function handleOpenTabSelect(tabId: string): void {
    setConnectedFolderMenuOpen(false);
    onActivate(tabId);
    window.requestAnimationFrame(() => document.getElementById(surfaceTabDomId(tabId))?.focus());
  }

  function toggleConnectedFolderGrouping(): void {
    const next = !groupByConnectedFolder;
    setGroupByConnectedFolder(next);
    writeStoredValue(groupSurfaceTabsStorageKey, next ? "true" : null);
    setConnectedFolderMenuOpen(false);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  }

  function renderBrowserTabIcon(tab: BrowserSurfaceTab) {
    const look = browserTabLooks[tab.pageId];
    if (look?.loading) return <span className="surface-tab-browser-spinner" />;
    return look?.favicon
      ? <img className="surface-tab-favicon" src={look.favicon} alt="" draggable={false} />
      : <FluentGlyph icon={BrowserTabIcon} size={15} filled={false} />;
  }

  /** A browser tab carries its page's icon instead of a Connected Folder's, and selecting it keeps the open Connected Folder. */
  function renderBrowserTab(tab: BrowserSurfaceTab, grouped: boolean) {
    const look = browserTabLooks[tab.pageId];
    const state = [
      look?.asking ? "waiting for you" : "",
      look?.worker ? "a Worker is using it" : "",
      look?.loading ? "loading" : "",
      look?.muted ? "muted" : look?.audible ? "playing sound" : "",
    ].filter(Boolean).map((part) => `, ${part}`).join("");
    return (
      <span
        className={["surface-tab", "surface-tab-browser", grouped ? "grouped" : "", tab.id === activeTabId ? "active" : ""].filter(Boolean).join(" ")}
        key={tab.id}
        data-tab-id={tab.id}
        data-exit-motion="collapse-inline"
        title={tab.url ? `${tab.title}\n${tab.url}` : tab.title}
        onContextMenu={(event) => onBrowserTabMenu?.(tab, event)}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose(tab.id);
        }}
      >
        <button
          id={surfaceTabDomId(tab.id)}
          className="surface-tab-main"
          type="button"
          role="tab"
          aria-selected={tab.id === activeTabId}
          aria-controls={surfacePanelDomId(tab.id)}
          aria-label={`${tab.title}, browser tab${state}`}
          tabIndex={tab.id === activeTabId ? 0 : -1}
          aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
          onPointerDown={(event) => reorderRef.current?.begin(event.nativeEvent, tab.id, event.currentTarget)}
          onClick={() => { if (!reorderRef.current?.consumeClick()) onActivate(tab.id); }}
        >
          <span className="surface-tab-icon" aria-hidden="true">{renderBrowserTabIcon(tab)}</span>
          <span className="surface-tab-copy">
            <span className="surface-tab-title">{tab.title}</span>
          </span>
          {look?.muted ? <SpeakerMute16Regular className="surface-tab-audio-marker" aria-hidden="true" /> : look?.audible ? <Speaker216Regular className="surface-tab-audio-marker" aria-hidden="true" /> : null}
          {/* The same pulse a running Worker shows on a Chat tab. */}
          {look?.worker ? <span className="surface-tab-chat-status running" aria-hidden="true" /> : null}
          {look?.asking ? <span className="surface-tab-browser-asking" aria-hidden="true" /> : null}
        </button>
        <button
          className="surface-tab-close"
          type="button"
          onClick={() => onClose(tab.id)}
          aria-label={`Close ${tab.title}`}
          title="Close Tab"
        >
          <Dismiss12Regular />
        </button>
      </span>
    );
  }

  // Two open files with one name each show their folder.
  const fileTitleCounts = new Map<string, number>();
  for (const tab of tabs) if (tab.kind === "file") fileTitleCounts.set(tab.title, (fileTitleCounts.get(tab.title) ?? 0) + 1);

  function renderSurfaceTab(tab: ConnectedFolderSurfaceTab, grouped: boolean) {
    if (tab.kind === "browser") return renderBrowserTab(tab, grouped);
    const tabConnectedFolder = connectedFolders.find((item) => item.id === tab.connectedFolderId);
    const connectedFolderName = tabConnectedFolder?.name ?? "Connected Folder";
    const resolvedConnectedFolder = tabConnectedFolder ?? fallbackConnectedFolderSummary(tab.connectedFolderId, connectedFolderName);
    const identity = connectedFolderIdentityFor(resolvedConnectedFolder, connectedFolderCustomizations);
    const Icon = identity.Icon;
    const style = connectedFolderIdentityStyle(identity);
    const activity = tab.kind === "chat" && tab.conversationId
      ? chatActivityStatuses[chatActivityKey(tab.connectedFolderId, tab.conversationId)]
      : undefined;
    const conversation = tab.kind === "chat" && tab.conversationId
      ? conversations[tab.connectedFolderId]?.find((item) => item.id === tab.conversationId)
      : undefined;
    const activityLabel = activity === "running" ? "Worker is working" : activity === "attention" ? "Worker finished" : "";
    const folderDetail = tab.kind === "file" && (fileTitleCounts.get(tab.title) ?? 0) > 1
      ? tab.path.split("/").slice(0, -1).at(-1) || connectedFolderName
      : null;
    return (
      <span
        className={["surface-tab", grouped ? "grouped" : "", tab.id === activeTabId ? "active" : "", activity ? `chat-${activity}` : ""].filter(Boolean).join(" ")}
        key={tab.id}
        data-tab-id={tab.id}
        data-exit-motion="collapse-inline"
        data-connected-folder-id={tab.connectedFolderId}
        style={style}
        title={`${tab.title} - ${connectedFolderName}${activityLabel ? ` · ${activityLabel}` : ""}`}
        onContextMenu={(event) => onTabMenu(tab, resolvedConnectedFolder, tab.kind === "chat" && tab.conversationId
          ? conversation ?? {
            id: tab.conversationId,
            title: chatDisplayTitle({ serverTitle: tab.title }),
            updatedAt: new Date().toISOString(),
          }
          : null, event)}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose(tab.id);
        }}
      >
        <button
          id={surfaceTabDomId(tab.id)}
          className="surface-tab-main"
          type="button"
          role="tab"
          aria-selected={tab.id === activeTabId}
          aria-controls={surfacePanelDomId(tab.id)}
          aria-label={`${tab.title} in ${connectedFolderName}${activityLabel ? `, ${activityLabel}` : ""}`}
          tabIndex={tab.id === activeTabId ? 0 : -1}
          aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
          onPointerDown={(event) => reorderRef.current?.begin(event.nativeEvent, tab.id, event.currentTarget)}
          onClick={() => { if (!reorderRef.current?.consumeClick()) onActivate(tab.id); }}
        >
          {grouped ? null : <span className="surface-tab-icon" aria-hidden="true"><ConnectedFolderIconGlyph icon={Icon} size={15} /></span>}
          <span className="surface-tab-copy">
            <span className="surface-tab-title">{tab.title}{folderDetail ? <span className="surface-tab-detail">{folderDetail}</span> : null}</span>
          </span>
          {activity ? <TabActivityDot status={activity} /> : null}
        </button>
        <button
          className="surface-tab-close"
          type="button"
          onClick={() => onClose(tab.id)}
          aria-label={`Close ${tab.title}`}
          title="Close Tab"
        >
          <Dismiss12Regular />
        </button>
      </span>
    );
  }

  return (
    <div className={tabs.length ? "surface-tabbar" : "surface-tabbar empty"}>
      <span className="sr-only" role="status" aria-live="polite">{reorderAnnouncement}</span>
      <div
        ref={tabsRef}
        className={["surface-tabs", groupingActive ? "surface-tabs-grouped" : "", countTier].filter(Boolean).join(" ")}
        data-overflow={overflow ?? undefined}
        role="tablist"
        aria-label="Open Tabs"
        onKeyDown={handleTabListKeyDown}
      >
        <span ref={activeChromeRef} className="surface-tab-active-chrome" aria-hidden="true" />
        {tabGroups.map((group) => {
          if (!group.grouped) return group.tabs.map((tab) => renderSurfaceTab(tab, false));
          if (group.connectedFolderId === null) {
            return (
              <span className="surface-tab-group surface-tab-group-browser" role="presentation" key="browser">
                <span className="surface-tab-group-label" title="Browser" aria-hidden="true">
                  <FluentGlyph icon={BrowserTabIcon} size={15} filled={false} />
                </span>
                <span className="surface-tab-group-tabs" role="presentation">
                  {group.tabs.map((tab) => renderSurfaceTab(tab, true))}
                </span>
              </span>
            );
          }
          const tabConnectedFolder = connectedFolders.find((item) => item.id === group.connectedFolderId)
            ?? fallbackConnectedFolderSummary(group.connectedFolderId, "connected-folder");
          const identity = connectedFolderIdentityFor(tabConnectedFolder, connectedFolderCustomizations);
          // The group carries the Connected Folder's colors so its icon chip and the
          // line under its tabs match; the name shows on hover, and each tab's
          // accessible name already says which Connected Folder it is in.
          return (
            <span className="surface-tab-group" role="presentation" key={group.connectedFolderId} style={connectedFolderIdentityStyle(identity)}>
              <span className="surface-tab-group-label" title={tabConnectedFolder.name} aria-hidden="true">
                <ConnectedFolderIconGlyph icon={identity.Icon} size={15} />
              </span>
              <span className="surface-tab-group-tabs" role="presentation">
                {group.tabs.map((tab) => renderSurfaceTab(tab, true))}
              </span>
            </span>
          );
        })}
      </div>
      <div className="surface-tab-actions">
        {onNewBrowserTab ? (
          <button
            className="surface-tab-action surface-tab-new-browser"
            type="button"
            onClick={() => {
              setConnectedFolderMenuOpen(false);
              onNewBrowserTab();
            }}
            aria-label="Open a Browser Tab"
            title="New Browser Tab"
          >
            <FluentGlyph icon={NewBrowserTabIcon} size={18} />
          </button>
        ) : null}
        <div
          className="surface-tab-connected-folder-menu-anchor"
          ref={menuAnchorRef}
          onBlurCapture={(event) => {
            if (connectedFolderMenuOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setConnectedFolderMenuOpen(false);
          }}
        >
          <div className="surface-tab-new-chat" role="group" aria-label="New Chat">
            <button
              className="surface-tab-action surface-tab-new-chat-main"
              type="button"
              onClick={() => {
                setConnectedFolderMenuOpen(false);
                const current = connectedFolders.find((item) => item.id === newChatConnectedFolderId);
                if (current) onNewChatInConnectedFolder(current); else setConnectedFolderMenuOpen(true);
              }}
              aria-label="Start a New Chat"
              title="New Chat in This Connected Folder"
            >
              <FluentGlyph icon={NewChatIcon} size={18} />
            </button>
            <button
              ref={menuButtonRef}
              className="surface-tab-action surface-tab-new-chat-trigger"
              type="button"
              onClick={() => setConnectedFolderMenuOpen((current) => !current)}
              aria-label="Choose where to start a new Chat"
              aria-haspopup="menu"
              aria-expanded={connectedFolderMenuOpen}
              aria-controls="new-chat-connected-folder-menu"
              title="New Chat in another Connected Folder, or open tabs"
            >
              <ChevronDown16Regular aria-hidden="true" />
            </button>
          </div>
          {connectedFolderMenuOpen ? (
            <div
              ref={menuRef}
              id="new-chat-connected-folder-menu"
              className="surface-tab-connected-folder-menu"
              role="menu"
              aria-label="Tab Actions"
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={handleConnectedFolderMenuKeyDown}
            >
              <span className="surface-tab-connected-folder-menu-heading">Choose a Connected Folder</span>
              {menuConnectedFolders.map((item) => {
                const identity = connectedFolderIdentityFor(item, connectedFolderCustomizations);
                const Icon = identity.Icon;
                const current = item.id === newChatConnectedFolderId;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    key={item.id}
                    style={connectedFolderIdentityStyle(identity)}
                    onClick={() => handleConnectedFolderMenuSelect(item)}
                    title={`New Chat in ${item.name}`}
                  >
                    <span className="connected-folder-identity-icon"><ConnectedFolderIconGlyph icon={Icon} size={14} /></span>
                    <span className="surface-tab-connected-folder-menu-copy"><strong>{item.name}</strong>{current ? <small>Current Connected Folder</small> : null}</span>
                  </button>
                );
              })}
              {orderedTabs.length ? (
                <>
                  <span className="surface-tab-connected-folder-menu-separator" role="separator" />
                  <span className="surface-tab-connected-folder-menu-heading">Open Tabs</span>
                  {orderedTabs.map((tab) => {
                    const active = tab.id === activeTabId;
                    if (tab.kind === "browser") {
                      return (
                        <button
                          className="surface-tab-open-item surface-tab-open-item-browser"
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          aria-label={`${tab.title}, browser tab`}
                          tabIndex={-1}
                          key={tab.id}
                          onClick={() => handleOpenTabSelect(tab.id)}
                          title={tab.url || tab.title}
                        >
                          <span className="connected-folder-identity-icon">{renderBrowserTabIcon(tab)}</span>
                          <span className="surface-tab-connected-folder-menu-copy"><strong>{tab.title}</strong></span>
                        </button>
                      );
                    }
                    const tabConnectedFolder = connectedFolders.find((item) => item.id === tab.connectedFolderId)
                      ?? fallbackConnectedFolderSummary(tab.connectedFolderId, "connected-folder");
                    const identity = connectedFolderIdentityFor(tabConnectedFolder, connectedFolderCustomizations);
                    return (
                      <button
                        className="surface-tab-open-item"
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        aria-label={`${tab.title} in ${tabConnectedFolder.name}`}
                        tabIndex={-1}
                        key={tab.id}
                        style={connectedFolderIdentityStyle(identity)}
                        onClick={() => handleOpenTabSelect(tab.id)}
                        title={`${tab.title} - ${tabConnectedFolder.name}`}
                      >
                        <span className="connected-folder-identity-icon"><ConnectedFolderIconGlyph icon={identity.Icon} size={14} /></span>
                        <span className="surface-tab-connected-folder-menu-copy"><strong>{tab.title}</strong></span>
                      </button>
                    );
                  })}
                </>
              ) : null}
              <span className="surface-tab-connected-folder-menu-separator" role="separator" />
              <span className="surface-tab-connected-folder-menu-heading">Tab Layout</span>
              <button
                className="surface-tab-group-toggle"
                type="button"
                role="menuitemcheckbox"
                aria-checked={groupByConnectedFolder}
                tabIndex={-1}
                onClick={toggleConnectedFolderGrouping}
              >
                <span className="surface-tab-menu-check" aria-hidden="true">{groupByConnectedFolder ? <Checkmark16Regular /> : null}</span>
                <span className="surface-tab-connected-folder-menu-copy">
                  <strong>Group by Connected Folder</strong>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A Chat tab's activity dot, with the reply-landed moment when its Worker finishes. */
function TabActivityDot({ status }: { status: ChatActivityStatus }) {
  const dotRef = useRef<HTMLSpanElement | null>(null);
  useFinishCelebration(dotRef, status);
  return <span ref={dotRef} className={`surface-tab-chat-status ${status}`} aria-hidden="true" />;
}

function fallbackConnectedFolderSummary(id: string, name: string): ConnectedFolderSummary {
  return {
    id,
    name,
    connectedFolderRoot: "",
    location: { kind: "local", storage: "linked" },
    createdAt: "",
    updatedAt: "",
  };
}
