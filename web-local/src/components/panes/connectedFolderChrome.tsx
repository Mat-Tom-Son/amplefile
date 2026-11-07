import { useConnectedFolderIdentityResolver } from "../../lib/connected-folder-appearance-context";
import { restrictedAppRailMode, restrictedAppRailLabel } from "../../lib/restricted-app-navigation";
import type { ConnectedFolderSetUpMode } from "../../lib/connected-folder-setup";
import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Blocks } from "lucide-react";
import { createPortal } from "react-dom";
import {
  ArrowDownload20Regular,
  ArrowClockwise20Regular,
  ArrowReset20Regular,
  ArrowUndo20Regular,
  ArrowUpload20Regular,
  Apps24Filled,
  ChatAdd16Regular,
  Folder16Regular,
  FolderOpen16Regular,
  PaintBrush16Regular,
  ImageSparkle16Regular,
  Wand16Regular,
  Apps24Regular,
  ChatMultiple24Filled,
  ChatMultiple24Regular,
  Checkmark16Regular,
  Checkmark20Regular,
  ChevronDown20Regular,
  ChevronLeft20Regular,
  ChevronRight20Regular,
  Dismiss20Regular,
  DocumentFolder24Filled,
  DocumentFolder24Regular,
  Flash24Filled,
  Flash24Regular,
  FolderAdd20Regular,
  FolderOpen20Regular,
  History24Filled,
  History24Regular,
  ImageAdd20Regular,
  Search20Regular,
  Warning20Regular,
} from "@fluentui/react-icons";
import {
  accentIdentityFromHex,
  createConnectedFolderAppearanceProposal,
  parseConnectedFolderAppearanceProposal,
  upgradeConnectedFolderAppearanceCustomization,
  type ConnectedFolderAppearanceBannerLayout,
  type ConnectedFolderAppearanceBannerIconStyle,
  type ConnectedFolderAppearanceBannerTitleFill,
} from "../../../../src/shared/connected-folder-appearance";
import { filterConnectedFolderIconOptions, knownConnectedFolderIconOption, connectedFolderIconOptions, connectedFolderIconGroups, type ConnectedFolderIconGroupId } from "../../connected-folder-icons";
import { connectedFolderBannerOptions } from "../../constants";
import { errorText } from "../../lib/api";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import { revealInFileManagerLabel } from "../../lib/file-actions";
import { isMacOS } from "../../lib/platform";
import { normalizeConnectedFolderCustomizations } from "../../lib/connected-folder-customization";
import { normalizeConnectedFolderColor, processConnectedFolderBannerImageFile, connectedFolderColorOptions, connectedFolderIdentityStyle, connectedFolderBannerImageStyle, type ConnectedFolderIdentity } from "../../lib/connected-folder-identity";
import { ConnectedFolderBannerPreview } from "../chrome/ConnectedFolderBannerPreview";
import { ConnectedFolderBannerTitle } from "../chrome/ConnectedFolderBannerTitle";
import { connectedFolderBannerPresets } from "../../lib/connected-folder-banner-presets";
import { readableTextColorOn } from "../../lib/color-contrast";
import { surfaceDomIdSuffix, connectedFolderHeaderSourceBadgeLabel } from "../../lib/connected-folder-ui";
import type { SkillsExtensionsView, CapabilitySurface, ChatActivityStatus, RestrictedAppInstalled, ConnectedFolderCustomization, ConnectedFolderCustomizationMap, ConnectedFolderCustomizationPatch, ConnectedFolderRailMode, ConnectedFolderSummary } from "../../types";
import { ConnectedFolderIconGlyph } from "../chrome/common";
import { ActivityDot } from "../chrome/ActivityDot";
import { combineActivityStatuses, descendantFolders, folderAncestors, folderTreeRows } from "../../lib/folder-nesting";

function ConnectedFolderModeRail({
  activeMode,
  paneHidden = false,
  connectedFolder,
  surfaces,
  apps,
  appAttention,
  onModeChange,
  onOpenSkillsExtensions,
  accountControl,
  updateControl,
  automations = null,
}: {
  activeMode: ConnectedFolderRailMode;
  /** The navigation pane is hidden, so no destination reads as selected. */
  paneHidden?: boolean;
  connectedFolder: ConnectedFolderSummary;
  surfaces: CapabilitySurface[];
  apps: RestrictedAppInstalled[];
  /** How many new things an app named for its rail dot; 0 shows none. */
  appAttention?: (app: RestrictedAppInstalled) => number;
  onModeChange: (mode: ConnectedFolderRailMode) => void;
  /**
   * A Connected Folder's own Automations entry (docs/automations.md, F15 as
   * amended 2026-09-24), present only while an automation touches this
   * Connected Folder. `active` follows the Automations tab, not the navigator mode.
   */
  automations?: { active: boolean } | null;
  /** The rail's Add button opens the Skills & Extensions popup (2026-09-25: no Add menu, no Library, no Apps tab). */
  onOpenSkillsExtensions: (view: SkillsExtensionsView) => void;
  accountControl: ReactNode;
  updateControl?: ReactNode;
}) {
  const shownMode: ConnectedFolderRailMode | null = paneHidden ? null : activeMode;
  const FilesIcon = shownMode === "files" ? DocumentFolder24Filled : DocumentFolder24Regular;
  const ChatsIcon = shownMode === "chats" ? ChatMultiple24Filled : ChatMultiple24Regular;
  const HistoryIcon = shownMode === "history" ? History24Filled : History24Regular;
  const primaryItems: Array<{ mode: ConnectedFolderRailMode; label: string; ariaLabel: string; icon: ReactNode }> = [
    { mode: "files", label: "Files", ariaLabel: "Files", icon: <FilesIcon className="fluent-rail-icon" /> },
    { mode: "chats", label: "Chats", ariaLabel: "Chats", icon: <ChatsIcon className="fluent-rail-icon" /> },
    { mode: "history", label: "History", ariaLabel: "History", icon: <HistoryIcon className="fluent-rail-icon" /> },
  ];

  return (
    <nav className="connected-folder-mode-rail professional-connected-folder-rail" aria-label="AmpleFile navigation">
      <div className="connected-folder-rail-nav">
        {primaryItems.map((item) => (
          <button
            className={[
              "connected-folder-rail-button",
              shownMode === item.mode ? "active" : "",
            ].filter(Boolean).join(" ")}
            type="button"
            key={item.mode}
            onClick={() => onModeChange(item.mode)}
            aria-label={item.ariaLabel}
            title={item.label}
            aria-current={shownMode === item.mode ? "page" : undefined}
          >
            <span className="connected-folder-rail-icon" aria-hidden="true">{item.icon}</span>
            <span className="connected-folder-rail-label">{item.label}</span>
          </button>
        ))}
        {automations ? (
          <button
            className={["connected-folder-rail-button", automations.active ? "active" : ""].filter(Boolean).join(" ")}
            type="button"
            onClick={() => onModeChange("automations")}
            aria-label="Automations"
            title="Automations"
            aria-current={automations.active ? "page" : undefined}
          >
            <span className="connected-folder-rail-icon" aria-hidden="true">
              {automations.active ? <Flash24Filled className="fluent-rail-icon" /> : <Flash24Regular className="fluent-rail-icon" />}
            </span>
            <span className="connected-folder-rail-label">Automations</span>
          </button>
        ) : null}
        {surfaces.length || apps.length ? <span className="connected-folder-rail-app-divider" aria-hidden="true" /> : null}
        {surfaces.map((surface) => {
          const mode = `app:${surface.key}` as const;
          const SurfaceIcon = shownMode === mode ? Apps24Filled : Apps24Regular;
          // An icon name outside the catalog keeps the generic Apps glyph.
          const contributedIcon = knownConnectedFolderIconOption(surface.icon);
          return (
            <button
              className={["connected-folder-rail-button", "connected-folder-rail-app", shownMode === mode ? "active" : ""].filter(Boolean).join(" ")}
              type="button"
              key={surface.key}
              onClick={() => onModeChange(mode)}
              aria-label={surface.title}
              title={surface.title}
              aria-current={shownMode === mode ? "page" : undefined}
            >
              <span className="connected-folder-rail-icon" aria-hidden="true">
                {contributedIcon
                  ? <ConnectedFolderIconGlyph icon={contributedIcon.Icon} size={24} filled={shownMode === mode} className="fluent-rail-icon" />
                  : <SurfaceIcon className="fluent-rail-icon" />}
              </span>
              <span className="connected-folder-rail-label">{surface.title}</span>
            </button>
          );
        })}
        {apps.map((app) => {
          const mode = restrictedAppRailMode(connectedFolder.id, app.manifest.id, app.featureInstallationId);
          const label = restrictedAppRailLabel(app, apps);
          const attention = appAttention?.(app) ?? 0;
          const AppIcon = shownMode === mode ? Apps24Filled : Apps24Regular;
          const contributedIcon = knownConnectedFolderIconOption(app.manifest.ui.icon);
          return (
            <button
              className={["connected-folder-rail-button", "connected-folder-rail-app", shownMode === mode ? "active" : ""].filter(Boolean).join(" ")}
              type="button"
              key={app.featureInstallationId}
              onClick={() => onModeChange(mode)}
              aria-label={attention ? `${label}, ${attention} new` : label}
              title={label}
              aria-current={shownMode === mode ? "page" : undefined}
            >
              {attention ? <span className="connected-folder-rail-attention" aria-hidden="true" /> : null}
              <span className="connected-folder-rail-icon" aria-hidden="true">
                {contributedIcon
                  ? <ConnectedFolderIconGlyph icon={contributedIcon.Icon} size={24} filled={shownMode === mode} className="fluent-rail-icon" />
                  : <AppIcon className="fluent-rail-icon" />}
              </span>
              <span className="connected-folder-rail-label">{label}</span>
            </button>
          );
        })}
      </div>
      <div className="connected-folder-rail-account">
        <div className="connected-folder-rail-tools">
          {updateControl ? <div className="connected-folder-rail-update">{updateControl}</div> : null}
          <button
            className="connected-folder-rail-quiet-button connected-folder-rail-add-button"
            type="button"
            onClick={() => onOpenSkillsExtensions("installed")}
            aria-label="Skills & Extensions"
            title="Skills & Extensions"
          >
            <Blocks size={24} strokeWidth={1.5} aria-hidden="true" />
            <span>Add</span>
          </button>
        </div>
        <div className="connected-folder-rail-settings-control">
          {accountControl}
        </div>
      </div>
    </nav>
  );
}

const bannerLayoutOptions: ReadonlyArray<{ id: ConnectedFolderAppearanceBannerLayout; label: string }> = [
  { id: "card", label: "Card" },
  { id: "compact", label: "Compact" },
  { id: "band", label: "Band" },
  { id: "cover", label: "Cover" },
];

const bannerTitleFillOptions: ReadonlyArray<{ id: ConnectedFolderAppearanceBannerTitleFill; label: string }> = [
  { id: "frosted", label: "Frosted" },
  { id: "solid", label: "Solid" },
  { id: "accent", label: "Accent" },
  { id: "none", label: "None" },
];

const bannerIconStyleOptions: ReadonlyArray<{ id: ConnectedFolderAppearanceBannerIconStyle; label: string }> = [
  { id: "none", label: "None" },
  { id: "plain", label: "Plain" },
  { id: "square", label: "Square" },
  { id: "circle", label: "Circle" },
];

function ConnectedFolderPaneHeader({
  connectedFolder,
  identity,
  connectedFolders,
  connectedFolderCustomizations,
  onSwitchConnectedFolder,
  onCreateConnectedFolder,
  onOpenFolder,
  onManageConnectedFolders,
  managingConnectedFolders = false,
  switchable = true,
  action,
  onNewChat,
  onOpenAppearance,
  onRevealFolder,
  onSetUp,
  folderStatuses = {},
}: {
  connectedFolder: ConnectedFolderSummary;
  identity: ConnectedFolderIdentity;
  connectedFolders: ConnectedFolderSummary[];
  connectedFolderCustomizations: ConnectedFolderCustomizationMap;
  /** One activity status per Connected Folder id (2026-10-01): dots in the switcher and on the header. */
  folderStatuses?: Readonly<Record<string, ChatActivityStatus>>;
  onSwitchConnectedFolder: (connectedFolder: ConnectedFolderSummary) => void;
  onCreateConnectedFolder: () => void;
  onOpenFolder: () => void;
  onManageConnectedFolders: () => void;
  managingConnectedFolders?: boolean;
  switchable?: boolean;
  action?: ReactNode;
  /** Right-click actions on the Connected Folder header (2026-09-25). */
  onNewChat?: () => void;
  onOpenAppearance?: () => void;
  onRevealFolder?: () => void;
  /** Set up for me, or Just the look (2026-10-11). */
  onSetUp?: (mode: ConnectedFolderSetUpMode) => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [slim, setSlim] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const switchTriggerRef = useRef<HTMLButtonElement>(null);
  // The banner slims to a strip while the list below it scrolls and returns at
  // the top (2026-10-27). Only a list with room to spare slims it, so the
  // height it gives back can never pull the list back to the top and flicker.
  useEffect(() => {
    const pane = headerRef.current?.closest(".connected-folder-mode-pane");
    if (!pane) return;
    function followListScroll(event: Event) {
      const list = event.target;
      if (!(list instanceof HTMLElement) || list.contains(headerRef.current)) return;
      if (list.scrollTop <= 0) setSlim(false);
      else if (list.scrollTop > 24 && list.scrollHeight - list.clientHeight > 160) setSlim(true);
    }
    pane.addEventListener("scroll", followListScroll, true);
    return () => pane.removeEventListener("scroll", followListScroll, true);
  }, []);
  useEffect(() => { setSlim(false); }, [connectedFolder.id]);
  const switcherEnabled = switchable && Boolean(connectedFolderCustomizations && onSwitchConnectedFolder);
  const switcherId = `connected-folder-header-switcher-${surfaceDomIdSuffix(connectedFolder.id)}`;
  const detail = connectedFolderHeaderSourceBadgeLabel(connectedFolder);
  const ancestors = useMemo(() => folderAncestors(connectedFolder, connectedFolders), [connectedFolder, connectedFolders]);
  const breadcrumbIdentityFor = useConnectedFolderIdentityResolver();
  const hiddenAncestors = ancestors.length > 2 ? ancestors.slice(0, -2) : [];
  const [breadcrumbMenuOpen, setBreadcrumbMenuOpen] = useState(false);
  const breadcrumbMoreRef = useRef<HTMLButtonElement>(null);
  const breadcrumbMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setBreadcrumbMenuOpen(false); }, [connectedFolder.id]);
  useEffect(() => {
    if (!breadcrumbMenuOpen) return;
    window.requestAnimationFrame(() => breadcrumbMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    function closeOnOutside(event: PointerEvent) {
      if (breadcrumbMenuRef.current?.contains(event.target as Node) || breadcrumbMoreRef.current?.contains(event.target as Node)) return;
      setBreadcrumbMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setBreadcrumbMenuOpen(false);
      breadcrumbMoreRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [breadcrumbMenuOpen]);

  function renderCrumb(item: ConnectedFolderSummary, role?: "menuitem") {
    // Each containing Connected Folder is a small pill in its own icon and color.
    const crumbIdentity = breadcrumbIdentityFor(item, connectedFolderCustomizations);
    return (
      <button
        className="connected-folder-pane-breadcrumb-link"
        type="button"
        role={role}
        tabIndex={role ? -1 : undefined}
        title={`Back to ${item.name}`}
        style={connectedFolderIdentityStyle(crumbIdentity)}
        onClick={() => { setBreadcrumbMenuOpen(false); onSwitchConnectedFolder(item); }}
      >
        <span className="connected-folder-pane-breadcrumb-icon" aria-hidden="true"><ConnectedFolderIconGlyph icon={crumbIdentity.Icon} size={11} filled /></span>
        <span className="connected-folder-pane-breadcrumb-name">{item.name}</span>
      </button>
    );
  }
  // The header's dot speaks for the Connected Folders inside this one: a parent shows
  // at a glance when one of its Workers is busy or has a reply waiting.
  const nestedStatus = useMemo(
    () => combineActivityStatuses(descendantFolders(connectedFolder, connectedFolders).map((item) => folderStatuses[item.id])),
    [folderStatuses, connectedFolder, connectedFolders],
  );
  const headerClassName = [
    "connected-folder-pane-current",
    "connected-folder-pane-header",
    "professional-pane-header",
    "connected-folder-banner-surface",
    "connected-folder-identity-header",
    `banner-layout-${identity.bannerLayout}`,
    `banner-${identity.bannerName}`,
    identity.bannerImage ? "has-banner-image" : "",
    switcherEnabled ? "has-switcher" : "",
    switcherOpen ? "switcher-open" : "",
    action ? "has-action" : "",
    ancestors.length ? "has-breadcrumb" : "",
  ].filter(Boolean).join(" ");

  useEffect(() => {
    if (!switcherEnabled) setSwitcherOpen(false);
  }, [switcherEnabled]);

  useEffect(() => {
    if (!switcherOpen) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (headerRef.current?.contains(event.target as Node)) return;
      setSwitcherOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setSwitcherOpen(false);
      window.requestAnimationFrame(() => switchTriggerRef.current?.focus());
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [switcherOpen]);

  /** The Mac app uses the native menu, like every other right-click there; elsewhere the in-app menu. */
  async function openHeaderMenu(point: { x: number; y: number }) {
    const popupHeaderMenu = window.ampleFileDesktop?.connectedFolder.popupHeaderMenu;
    if (!isMacOS() || !popupHeaderMenu) { setContextMenu(point); return; }
    const command = await popupHeaderMenu({
      actions: { newChat: Boolean(onNewChat), customize: Boolean(onOpenAppearance), setUp: Boolean(onSetUp), reveal: Boolean(onRevealFolder) },
      point: { x: Math.round(point.x), y: Math.round(point.y) },
    }).catch(() => null);
    if (command === "new-chat") onNewChat?.();
    else if (command === "customize") onOpenAppearance?.();
    else if (command === "set-up") onSetUp?.("full");
    else if (command === "look") onSetUp?.("look");
    else if (command === "reveal") onRevealFolder?.();
    else if (command === "manage") onManageConnectedFolders();
  }

  function toggleSwitcher() {
    if (!switcherEnabled) return;
    setSwitcherOpen((current) => !current);
  }

  const identityLockup = (
    <span className="connected-folder-pane-current-copy connected-folder-identity-header-copy">
      <span className="connected-folder-pane-current-lockup">
        <ConnectedFolderBannerTitle identity={identity} name={connectedFolder.name} caret={switcherEnabled} />
      </span>
      <span className="sr-only">{detail}</span>
    </span>
  );

  return (
    <div
      className={["connected-folder-pane-header-wrap", "connected-folder-identity-header-wrap", `banner-layout-${identity.bannerLayout}`, slim && !switcherOpen ? "slim" : ""].filter(Boolean).join(" ")}
      ref={headerRef}
      onBlurCapture={(event) => {
        if (switcherOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSwitcherOpen(false);
      }}
    >
      <div
        className={headerClassName}
        style={connectedFolderIdentityStyle(identity)}
        aria-label={switcherEnabled ? undefined : `Current Connected Folder: ${connectedFolder.name}. ${detail}`}
        onContextMenu={(event) => {
          if (!onNewChat && !onOpenAppearance && !onRevealFolder && !onSetUp) return;
          event.preventDefault();
          setSwitcherOpen(false);
          void openHeaderMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {identity.bannerImage ? (
          <span className={identity.bannerPreset ? "connected-folder-pane-banner-image has-banner-preset" : "connected-folder-pane-banner-image"} aria-hidden="true">
            <img src={identity.bannerImage} alt="" draggable={false} style={connectedFolderBannerImageStyle(identity.bannerFraming)} />
            <span className="connected-folder-pane-banner-scrim" />
          </span>
        ) : null}
        {switcherEnabled ? (
          <button
            ref={switchTriggerRef}
            className="connected-folder-pane-switch-trigger"
            type="button"
            aria-label={`Current Connected Folder: ${connectedFolder.name}. ${detail}. Switch Connected Folder`}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            aria-controls={switcherId}
            onClick={toggleSwitcher}
            title="Switch Connected Folder"
          >
            {identityLockup}
            {nestedStatus ? <span className="connected-folder-pane-nested-activity"><ActivityDot status={nestedStatus} /></span> : null}
          </button>
        ) : identityLockup}
        {ancestors.length ? (
          // The way back up lives with the Connected Folder's name (2026-10-01): the
          // nearest two containing Connected Folders are links, and anything further
          // out folds into "…", which opens the full tree in the switcher.
          <nav className="connected-folder-pane-breadcrumb" aria-label="Containing Connected Folders">
            {hiddenAncestors.length ? (
              <>
                <button
                  ref={breadcrumbMoreRef}
                  className="connected-folder-pane-breadcrumb-more"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={breadcrumbMenuOpen}
                  aria-label={`${hiddenAncestors.length} more containing ${hiddenAncestors.length === 1 ? "Connected Folder" : "Connected Folders"}`}
                  title={hiddenAncestors.map((item) => item.name).join(" › ")}
                  onClick={() => setBreadcrumbMenuOpen((current) => !current)}
                >
                  …
                </button>
                <ChevronRight20Regular className="connected-folder-pane-breadcrumb-separator" aria-hidden="true" />
              </>
            ) : null}
            {ancestors.slice(-2).map((item, index, list) => (
              <Fragment key={item.id}>
                {renderCrumb(item)}
                {index < list.length - 1 ? <ChevronRight20Regular className="connected-folder-pane-breadcrumb-separator" aria-hidden="true" /> : null}
              </Fragment>
            ))}
          </nav>
        ) : null}
        {action ? (
          <span className="connected-folder-pane-header-action professional-header-action connected-folder-pane-action-group">
            {action}
          </span>
        ) : null}
      </div>
      {breadcrumbMenuOpen && hiddenAncestors.length ? (
        // The Connected Folders "…" stands for, outermost first, as the same pills.
        <div
          ref={breadcrumbMenuRef}
          className="connected-folder-pane-breadcrumb-menu"
          role="menu"
          aria-label="More containing Connected Folders"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const items = Array.from(breadcrumbMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
            const next = nextMenuItemIndex(items.findIndex((item) => item === document.activeElement), items.length, event.key as MenuNavigationKey);
            if (next === null) return;
            event.preventDefault();
            items[next]?.focus();
          }}
        >
          {hiddenAncestors.map((item, index) => (
            <div className="connected-folder-pane-breadcrumb-menu-row" key={item.id} style={{ "--folder-depth": index } as CSSProperties}>
              {renderCrumb(item, "menuitem")}
            </div>
          ))}
        </div>
      ) : null}
      {switcherEnabled && switcherOpen ? (
        <ConnectedFolderHeaderSwitcher
          id={switcherId}
          currentConnectedFolder={connectedFolder}
          connectedFolders={connectedFolders}
          connectedFolderCustomizations={connectedFolderCustomizations}
          onSwitchConnectedFolder={onSwitchConnectedFolder}
          onCreateConnectedFolder={onCreateConnectedFolder}
          onOpenFolder={onOpenFolder}
          onManageConnectedFolders={onManageConnectedFolders}
          managingConnectedFolders={managingConnectedFolders}
          folderStatuses={folderStatuses}
          onClose={() => setSwitcherOpen(false)}
        />
      ) : null}
      {contextMenu ? (
        <FolderContextMenu
          anchor={headerRef.current}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => { setContextMenu(null); switchTriggerRef.current?.focus(); }}
          onNewChat={onNewChat}
          onOpenAppearance={onOpenAppearance}
          onRevealFolder={onRevealFolder}
          onSetUp={onSetUp}
          onManageConnectedFolders={onManageConnectedFolders}
        />
      ) : null}
    </div>
  );
}

/** The Connected Folder header's right-click menu: the things a person does with this Connected Folder most. */
function FolderContextMenu({ anchor, x, y, onClose, onNewChat, onOpenAppearance, onRevealFolder, onSetUp, onManageConnectedFolders }: {
  anchor: HTMLElement | null;
  x: number;
  y: number;
  onClose: () => void;
  onNewChat?: () => void;
  onOpenAppearance?: () => void;
  onRevealFolder?: () => void;
  onSetUp?: (mode: ConnectedFolderSetUpMode) => void;
  onManageConnectedFolders: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Focus enters once, on open: the header re-renders while the menu is up,
  // and arrow-key navigation must not snap back to the first item.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    function closeOnOutside(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("pointerdown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [onClose]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(currentIndex, items.length, event.key as MenuNavigationKey);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  const run = (action: () => void) => { onClose(); action(); };
  const style: CSSProperties = { left: Math.max(8, Math.min(x, window.innerWidth - 226)), top: Math.max(8, Math.min(y, window.innerHeight - (onSetUp ? 264 : 196))) };
  return createPortal(
    <Fragment>
      <div className="context-menu-backdrop folder-context-menu-backdrop" aria-hidden="true" onContextMenu={(event) => event.preventDefault()} />
      <div ref={menuRef} className="context-menu folder-context-menu" style={style} role="menu" aria-label="Connected Folder actions" onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()} onKeyDown={handleKeyDown} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose(); }}>
        {onNewChat ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onNewChat)}><ChatAdd16Regular aria-hidden="true" />New Chat</button> : null}
        {onOpenAppearance ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onOpenAppearance)}><PaintBrush16Regular aria-hidden="true" />Customize Connected Folder</button> : null}
        {onSetUp ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onSetUp("full"))}><Wand16Regular aria-hidden="true" />Set Up for Me</button> : null}
        {onSetUp ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onSetUp("look"))}><ImageSparkle16Regular aria-hidden="true" />Just the Look</button> : null}
        {onRevealFolder ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onRevealFolder)}><FolderOpen16Regular aria-hidden="true" />{revealInFileManagerLabel()}</button> : null}
        <div className="context-menu-separator" role="separator" />
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(onManageConnectedFolders)}><Folder16Regular aria-hidden="true" />Manage Connected Folders</button>
      </div>
    </Fragment>,
    anchor?.closest(".app-shell") ?? document.body,
  );
}

function ConnectedFolderHeaderSwitcher({
  id,
  currentConnectedFolder,
  connectedFolders,
  connectedFolderCustomizations,
  onSwitchConnectedFolder,
  onCreateConnectedFolder,
  onOpenFolder,
  onManageConnectedFolders,
  managingConnectedFolders,
  folderStatuses = {},
  onClose,
}: {
  id: string;
  folderStatuses?: Readonly<Record<string, ChatActivityStatus>>;
  currentConnectedFolder: ConnectedFolderSummary;
  connectedFolders: ConnectedFolderSummary[];
  connectedFolderCustomizations: ConnectedFolderCustomizationMap;
  onSwitchConnectedFolder: (connectedFolder: ConnectedFolderSummary) => void;
  onCreateConnectedFolder: () => void;
  onOpenFolder: () => void;
  onManageConnectedFolders: () => void;
  managingConnectedFolders: boolean;
  onClose: () => void;
}) {
  const connectedFolderIdentityFor = useConnectedFolderIdentityResolver();
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Rows are in tree order now, so start on the current Connected Folder, not the first row.
    const current = switcherRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"][aria-current="page"]')
      ?? switcherRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    current?.focus();
    current?.scrollIntoView({ block: "nearest" });
  }, []);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(switcherRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(currentIndex, items.length, event.key as MenuNavigationKey);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  return (
    <div className="connected-folder-header-switcher professional-connected-folder-switcher" id={id} role="menu" aria-label="Connected Folder menu" data-native-view-occluder="true" ref={switcherRef} onKeyDown={handleMenuKeyDown}>
      <div className="connected-folder-header-switcher-list">
        {/* work-folders inside work-folders read as a tree (2026-10-01): indentation
            says who owns what, so no row needs to explain it. */}
        {folderTreeRows(connectedFolders.some((item) => item.id === currentConnectedFolder.id) ? connectedFolders : [currentConnectedFolder, ...connectedFolders]).map(({ connectedFolder: item, depth }) => {
          const active = item.id === currentConnectedFolder.id;
          const itemIdentity = connectedFolderIdentityFor(item, connectedFolderCustomizations);
          const status = folderStatuses[item.id];
          return (
            <button
              className={["connected-folder-header-switcher-row", active ? "active" : "", depth ? "nested" : ""].filter(Boolean).join(" ")}
              type="button"
              role="menuitem"
              key={item.id}
              aria-current={active ? "page" : undefined}
              style={{ ...connectedFolderIdentityStyle(itemIdentity), "--folder-depth": depth } as CSSProperties}
              onClick={() => {
                onClose();
                if (!active) onSwitchConnectedFolder(item);
              }}
            >
              <span className="connected-folder-header-switcher-icon" aria-hidden="true" data-connected-folder-icon={itemIdentity.iconName}><ConnectedFolderIconGlyph icon={itemIdentity.Icon} size={17} filled /></span>
              <span className="connected-folder-header-switcher-copy"><strong>{item.name}</strong></span>
              {status ? <ActivityDot status={status} /> : <span aria-hidden="true" />}
              <span className="connected-folder-header-switcher-badge">{connectedFolderHeaderSourceBadgeLabel(item)}</span>
              {active ? <Checkmark16Regular className="connected-folder-header-switcher-check" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <div className="connected-folder-header-switcher-actions" aria-label="connected-folder actions">
        <button
          className="connected-folder-header-switcher-action"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onOpenFolder();
          }}
        >
          <FolderOpen20Regular aria-hidden="true" />
          <span>Connect Folder</span>
        </button>
        <button
          className="connected-folder-header-switcher-action"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onCreateConnectedFolder();
          }}
        >
          <FolderAdd20Regular aria-hidden="true" />
          <span>New Connected Folder</span>
        </button>
        <button
          className={managingConnectedFolders ? "connected-folder-header-switcher-action connected-folder-header-switcher-manage active" : "connected-folder-header-switcher-action connected-folder-header-switcher-manage"}
          type="button"
          role="menuitem"
          aria-current={managingConnectedFolders ? "true" : undefined}
          onClick={() => {
            onClose();
            onManageConnectedFolders();
          }}
        >
          <Apps24Regular aria-hidden="true" />
          <span>Manage Connected Folders</span>
        </button>
      </div>
    </div>
  );
}

function ConnectedFolderNameEditor({
  connectedFolder,
  onRenameConnectedFolder,
}: {
  connectedFolder: ConnectedFolderSummary;
  onRenameConnectedFolder: (connectedFolder: ConnectedFolderSummary, name: string) => Promise<void>;
}) {
  const [name, setName] = useState(connectedFolder.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(connectedFolder.name);
    setSaving(false);
    setError(null);
  }, [connectedFolder.id, connectedFolder.name]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      setError("Enter a Connected Folder name.");
      return;
    }
    if (nextName === connectedFolder.name) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRenameConnectedFolder(connectedFolder, nextName);
    } catch (renameError) {
      setError(errorText(renameError));
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || saving || name === connectedFolder.name) return;
    event.preventDefault();
    setName(connectedFolder.name);
    setError(null);
  }

  return (
    <div className="connected-folder-name-editor">
      <form className="connected-folder-name-form" onSubmit={(event) => void handleSubmit(event)}>
        <label>
          <span>Name</span>
          <input
            value={name}
            maxLength={80}
            autoComplete="off"
            disabled={saving}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            aria-label={`Connected Folder name for ${connectedFolder.name}`}
          />
        </label>
        <button className="connected-folder-name-save" type="submit" disabled={saving || !name.trim() || name.trim() === connectedFolder.name} aria-label={saving ? "Saving Name" : undefined}>
          {saving ? <ArrowClockwise20Regular className="spin" aria-hidden="true" /> : "Save"}
        </button>
      </form>
      {error ? <span className="connected-folder-name-error" role="alert">{error}</span> : null}
    </div>
  );
}

export const connectedFolderIconPageSize = 96;

function ConnectedFolderAppearancePanel({
  connectedFolder,
  identity,
  customization,
  canUndo,
  onCustomizeConnectedFolder,
  onReplaceConnectedFolder,
  onUndoConnectedFolder,
  onResetConnectedFolder,
  preview,
  bannerControls = true,
}: {
  connectedFolder: ConnectedFolderSummary;
  identity: ConnectedFolderIdentity;
  customization?: ConnectedFolderCustomization;
  canUndo: boolean;
  /** Shown in place of the banner previews, for a layout that draws no banner. */
  preview?: ReactNode;
  /** False where no banner is drawn (the file manager layout): Banner and Title are left out. */
  bannerControls?: boolean;
  onCustomizeConnectedFolder: (connectedFolderId: string, patch: ConnectedFolderCustomizationPatch) => void;
  onReplaceConnectedFolder: (connectedFolderId: string, customization: ConnectedFolderCustomization) => void;
  onUndoConnectedFolder: (connectedFolderId: string) => void;
  onResetConnectedFolder: (connectedFolderId: string) => void;
}) {
  const [iconGroup, setIconGroup] = useState<ConnectedFolderIconGroupId>("popular");
  const [iconSearchQuery, setIconSearchQuery] = useState("");
  const [iconPage, setIconPage] = useState(0);
  const [bannerUploadBusy, setBannerUploadBusy] = useState(false);
  const [bannerUploadError, setBannerUploadError] = useState<string | null>(null);
  const [proposalImportError, setProposalImportError] = useState<string | null>(null);
  const previousIconConnectedFolderRef = useRef(connectedFolder.id);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);
  const proposalFileInputRef = useRef<HTMLInputElement>(null);
  const connectedFolderId = connectedFolder.id;
  const matchingConnectedFolderIconOptions = useMemo(() => filterConnectedFolderIconOptions(iconSearchQuery, iconGroup), [iconSearchQuery, iconGroup]);
  const iconPageCount = Math.max(1, Math.ceil(matchingConnectedFolderIconOptions.length / connectedFolderIconPageSize));
  const visibleConnectedFolderIconOptions = matchingConnectedFolderIconOptions.slice(iconPage * connectedFolderIconPageSize, (iconPage + 1) * connectedFolderIconPageSize);
  const customized = Boolean(customization && Object.values(customization).some((value) => value !== undefined && value !== null && value !== ""));

  useEffect(() => {
    const changedConnectedFolder = previousIconConnectedFolderRef.current !== connectedFolderId;
    previousIconConnectedFolderRef.current = connectedFolderId;
    const options = changedConnectedFolder ? connectedFolderIconOptions : matchingConnectedFolderIconOptions;
    const selectedIconIndex = options.findIndex((option) => option.name === identity.iconName);
    setIconPage(selectedIconIndex < 0 ? 0 : Math.floor(selectedIconIndex / connectedFolderIconPageSize));
    if (!changedConnectedFolder) return;
    setIconSearchQuery("");
    setBannerUploadBusy(false);
    setBannerUploadError(null);
    setProposalImportError(null);
  }, [connectedFolderId, identity.iconName]);

  const appearancePasses = identity.resolved.passes;

  async function handleBannerFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || bannerUploadBusy) return;
    setBannerUploadBusy(true);
    setBannerUploadError(null);
    try {
      const bannerImage = await processConnectedFolderBannerImageFile(file);
      onCustomizeConnectedFolder(connectedFolderId, { bannerImage, bannerPreset: undefined, bannerFraming: undefined, bannerImagePosition: undefined });
    } catch (uploadError) {
      setBannerUploadError(errorText(uploadError));
    } finally {
      setBannerUploadBusy(false);
    }
  }

  function exportAppearanceProposal() {
    setProposalImportError(null);
    const upgraded = upgradeConnectedFolderAppearanceCustomization(customization ?? {});
    const proposal = createConnectedFolderAppearanceProposal({
      name: `${connectedFolder.name} appearance`,
      description: "A safe, code-free Connected Folder appearance preset.",
      target: { connectedFolderId: connectedFolder.id, connectedFolderName: connectedFolder.name },
      customization: {
        ...upgraded,
        schema: 2,
        primary: upgraded.primary ?? accentIdentityFromHex(identity.color),
        ...(identity.hasCustomSecondary
          ? { secondary: upgraded.secondary ?? accentIdentityFromHex(identity.secondaryColor) }
          : {}),
      },
      createdBy: "human",
    });
    const blob = new Blob([`${JSON.stringify(proposal, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${connectedFolder.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "connected-folder"}-appearance.connected-folder.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function importAppearanceProposal(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setProposalImportError(null);
    try {
      if (file.size > 850_000) throw new Error("Appearance proposal is too large.");
      const proposal = parseConnectedFolderAppearanceProposal(JSON.parse(await file.text()));
      const normalized = normalizeConnectedFolderCustomizations(
        { [connectedFolderId]: proposal.customization },
        new Set([connectedFolderId]),
        new Set(connectedFolderIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])])),
      )[connectedFolderId];
      if (!normalized) throw new Error("The proposal does not contain a supported appearance.");
      onReplaceConnectedFolder(connectedFolderId, normalized);
    } catch (caught) {
      setProposalImportError(errorText(caught));
    }
  }

  return (
    <div className="connected-folder-appearance-inner">
      <div className="connected-folder-appearance-toolbar">
        <button type="button" disabled={!canUndo} onClick={() => onUndoConnectedFolder(connectedFolderId)} title="Undo the last appearance change"><ArrowUndo20Regular />Undo</button>
        <div className="connected-folder-appearance-toolbar-actions">
          <button type="button" disabled={!customized} onClick={() => onResetConnectedFolder(connectedFolderId)}><ArrowReset20Regular />Reset</button>
          <details className="connected-folder-appearance-more">
            <summary aria-label="More Appearance Options">More<ChevronDown20Regular /></summary>
            <div>
              <button type="button" onClick={() => proposalFileInputRef.current?.click()}><ArrowUpload20Regular />Import</button>
              <button type="button" onClick={exportAppearanceProposal}><ArrowDownload20Regular />Export</button>
            </div>
          </details>
        </div>
      </div>
      <input ref={proposalFileInputRef} className="connected-folder-banner-file-input" type="file" accept=".json,application/json" onChange={(event) => void importAppearanceProposal(event)} tabIndex={-1} aria-hidden="true" />
      {proposalImportError ? <div className="connected-folder-appearance-import-error" role="alert">{proposalImportError}</div> : null}
      {preview ?? <ConnectedFolderBannerPreview identity={identity} name={connectedFolder.name} onFrame={(bannerFraming) => onCustomizeConnectedFolder(connectedFolderId, { bannerFraming })} />}
      {!appearancePasses ? <div className="connected-folder-appearance-audit warning" role="status"><Warning20Regular aria-hidden="true" /><span>Choose a higher-contrast accent.</span></div> : null}
      {/* One page with a section each (2026-11-05); the previews above stay in view. */}
      <div className="connected-folder-appearance-sections">
        {bannerControls ? <><section className="connected-folder-appearance-section" id="folder-appearance-section-banner" aria-labelledby="folder-appearance-heading-banner">
          <h3 id="folder-appearance-heading-banner">Banner</h3>
          <div className="connected-folder-banner-section-heading"><strong>Layout</strong></div>
          <div className="connected-folder-banner-layouts" role="group" aria-label="Banner Layout">
            {bannerLayoutOptions.map((option) => <button key={option.id} type="button" className={identity.bannerLayout === option.id ? "active" : ""} aria-pressed={identity.bannerLayout === option.id} onClick={() => onCustomizeConnectedFolder(connectedFolderId, { bannerLayout: option.id })}>
              <span className={`connected-folder-layout-diagram layout-${option.id}`} aria-hidden="true"><i /><b /></span>{option.label}
            </button>)}
          </div>
          <div className="connected-folder-banner-section-heading"><strong>Images</strong><button className="connected-folder-banner-upload-button" type="button" onClick={() => bannerFileInputRef.current?.click()} disabled={bannerUploadBusy}><ImageAdd20Regular />{bannerUploadBusy ? "Uploading…" : "Upload"}</button></div>
          <div className="connected-folder-banner-image-gallery" role="group" aria-label="Built-in banner images">
            {connectedFolderBannerPresets.map((preset) => <button key={preset.id} type="button" className={identity.bannerPreset === preset.id ? "active" : ""} aria-pressed={identity.bannerPreset === preset.id} aria-label={`Use ${preset.label} Image`} onClick={() => onCustomizeConnectedFolder(connectedFolderId, { bannerPreset: preset.id, bannerImage: undefined, bannerFraming: undefined, bannerImagePosition: undefined })}>
              <span><img src={preset.thumbnail} alt="" draggable={false} />{identity.bannerPreset === preset.id ? <Checkmark20Regular /> : null}</span><strong>{preset.label}</strong>
            </button>)}
            {/* The fifth slot is always there: empty until an image is uploaded. */}
            <button type="button" className={customization?.bannerImage ? (!identity.bannerPreset ? "active" : "") : "empty"} aria-pressed={Boolean(customization?.bannerImage && !identity.bannerPreset)} aria-label={customization?.bannerImage ? "Replace Your Image" : "Upload an Image"} disabled={bannerUploadBusy} onClick={() => bannerFileInputRef.current?.click()}>
              <span>{customization?.bannerImage ? <><img src={customization.bannerImage} alt="" draggable={false} />{!identity.bannerPreset ? <Checkmark20Regular /> : null}</> : <ImageAdd20Regular className="connected-folder-banner-image-empty" />}</span><strong>Your Image</strong>
            </button>
          </div>
          <input ref={bannerFileInputRef} className="connected-folder-banner-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onChange={(event) => void handleBannerFileChange(event)} tabIndex={-1} aria-hidden="true" />
          {bannerUploadError ? <span className="connected-folder-banner-upload-error" role="alert">{bannerUploadError}</span> : null}
          <div className="connected-folder-banner-section-heading"><strong>Patterns</strong></div>
          <div className="connected-folder-banner-gallery" role="group" aria-label="Connected Folder banner styles">
            {connectedFolderBannerOptions.map((option) => <button key={option.name} className={["connected-folder-banner-swatch", "connected-folder-banner-surface", `banner-${option.name}`, !identity.bannerImage && identity.bannerName === option.name ? "active" : ""].filter(Boolean).join(" ")} type="button" onClick={() => onCustomizeConnectedFolder(connectedFolderId, { bannerName: option.name, bannerImage: undefined, bannerPreset: undefined, bannerFraming: undefined, bannerImagePosition: undefined })} aria-label={`Use ${option.label} Banner`} aria-pressed={!identity.bannerImage && identity.bannerName === option.name}><span className="connected-folder-banner-swatch-name">{option.label}</span></button>)}
          </div>
          {!identity.bannerImage && identity.bannerName !== "none" ? <div className="connected-folder-pattern-colors">
            <strong>Pattern Colors</strong>
            <div className="connected-folder-color-wheels">
              <label className="connected-folder-color-picker" style={connectedFolderIdentityStyle(identity)} title="Accent Color">
                <span className="connected-folder-color-wheel" aria-hidden="true"><span className="connected-folder-color-wheel-current" /></span>
                <input type="color" value={identity.color} onInput={(event) => onCustomizeConnectedFolder(connectedFolderId, { color: normalizeConnectedFolderColor(event.currentTarget.value) })} aria-label="Choose Pattern Accent Color" />
                <span className="connected-folder-color-value"><small>Accent</small>{identity.color.toUpperCase()}</span>
              </label>
              <label
                className={identity.hasCustomSecondary ? "connected-folder-color-picker secondary" : "connected-folder-color-picker secondary matched"}
                style={{ ...connectedFolderIdentityStyle(identity), "--connected-folder-picker-color": identity.secondaryColor } as CSSProperties}
                title="Second Banner Color"
              >
                <span className="connected-folder-color-wheel" aria-hidden="true">
                  <span className="connected-folder-color-wheel-current" />
                </span>
                <input
                  type="color"
                  value={identity.secondaryColor}
                  onInput={(event) => onCustomizeConnectedFolder(connectedFolderId, { color2: normalizeConnectedFolderColor(event.currentTarget.value) })}
                  aria-label="Choose Second Banner Color"
                />
                <span className="connected-folder-color-value"><small>Second Color</small>{identity.hasCustomSecondary ? identity.secondaryColor.toUpperCase() : "Match accent"}</span>
              </label>
              {identity.hasCustomSecondary ? (
                <button
                  className="connected-folder-color-pair-clear"
                  type="button"
                  onClick={() => onCustomizeConnectedFolder(connectedFolderId, { color2: undefined })}
                  aria-label="Remove Second Banner Color"
                  title="Match Primary Color"
                >
                  <Dismiss20Regular />
                </button>
              ) : null}
            </div>
          </div> : null}
        </section>
        <section className="connected-folder-appearance-section" id="folder-appearance-section-title" aria-labelledby="folder-appearance-heading-title">
          <h3 id="folder-appearance-heading-title">Title</h3>
          <div className="connected-folder-title-options">
            <span id="folder-appearance-title-fill">Background</span>
            <div className="connected-folder-segmented" role="radiogroup" aria-labelledby="folder-appearance-title-fill">
              {bannerTitleFillOptions.map((option) => <button key={option.id} type="button" role="radio" aria-checked={identity.bannerTitleFill === option.id} className={identity.bannerTitleFill === option.id ? "active" : ""} onClick={() => onCustomizeConnectedFolder(connectedFolderId, { bannerTitleFill: option.id })}>{option.label}</button>)}
            </div>
            <span id="folder-appearance-icon-style">Icon Style</span>
            <div className="connected-folder-segmented" role="radiogroup" aria-labelledby="folder-appearance-icon-style">
              {bannerIconStyleOptions.map((option) => <button key={option.id} type="button" role="radio" aria-checked={identity.bannerIconStyle === option.id} className={identity.bannerIconStyle === option.id ? "active" : ""} onClick={() => onCustomizeConnectedFolder(connectedFolderId, { bannerIconStyle: option.id })}>{option.label}</button>)}
            </div>
          </div>
        </section></> : null}
        <section className="connected-folder-appearance-section" id="folder-appearance-section-icon" aria-labelledby="folder-appearance-heading-icon">
          <h3 id="folder-appearance-heading-icon">Icon</h3>
        <div className="connected-folder-icon-picker">
          <label className="connected-folder-icon-search">
            <Search20Regular aria-hidden="true" />
            <input
              type="search"
              value={iconSearchQuery}
              onChange={(event) => {
                setIconSearchQuery(event.currentTarget.value);
                setIconPage(0);
                if (event.currentTarget.value) setIconGroup("all");
              }}
              placeholder="Search icons"
              aria-label="Search Connected Folder icons"
            />
          </label>
          <div className="connected-folder-icon-categories" role="group" aria-label="Icon categories">
            {connectedFolderIconGroups.map((group) => <button key={group.id} type="button" aria-pressed={iconGroup === group.id} onClick={() => { setIconGroup(group.id); setIconSearchQuery(""); setIconPage(0); }}>{group.label}</button>)}
          </div>
          <div className="connected-folder-icon-browser">
            <div className="connected-folder-icon-grid" aria-label="Connected Folder Icon">
              {visibleConnectedFolderIconOptions.map((option) => {
                const Icon = option.Icon;
                return (
                  <button
                    className={identity.iconName === option.name ? "connected-folder-icon-option active" : "connected-folder-icon-option"}
                    key={option.name}
                    type="button"
                    onClick={() => onCustomizeConnectedFolder(connectedFolderId, { iconName: option.name })}
                    aria-label={`Use ${option.label} Icon`}
                    aria-pressed={identity.iconName === option.name}
                    title={option.label}
                  >
                    <ConnectedFolderIconGlyph icon={Icon} size={24} filled={identity.iconName === option.name} />
                  </button>
                );
              })}
              {!visibleConnectedFolderIconOptions.length ? <span className="connected-folder-icon-empty">No Icons Found</span> : null}
            </div>
          </div>
          {iconPageCount > 1 ? (
            <div className="connected-folder-icon-pages" aria-label="Icon pages">
              <button type="button" onClick={() => setIconPage((current) => Math.max(0, current - 1))} disabled={iconPage === 0} aria-label="Previous Icon Page"><ChevronLeft20Regular /></button>
              <span className="connected-folder-icon-pager-status">{iconPage + 1} / {iconPageCount}</span>
              <button type="button" onClick={() => setIconPage((current) => Math.min(iconPageCount - 1, current + 1))} disabled={iconPage >= iconPageCount - 1} aria-label="Next Icon Page"><ChevronRight20Regular /></button>
            </div>
          ) : null}
        </div>
        </section>
        <section className="connected-folder-appearance-section" id="folder-appearance-section-color" aria-labelledby="folder-appearance-heading-color">
          <h3 id="folder-appearance-heading-color">Color</h3>
      <div className="connected-folder-appearance-row colors">
        <div className="connected-folder-color-section-heading"><strong>Accent</strong>
          <div className="connected-folder-color-wheels">
            <span className="connected-folder-custom-color-label">Custom Color</span>
            <label className="connected-folder-color-picker" style={connectedFolderIdentityStyle(identity)}>
              <span className="connected-folder-color-wheel" aria-hidden="true">
                <span className="connected-folder-color-wheel-current" />
              </span>
              <input
                type="color"
                value={identity.color}
                onInput={(event) => onCustomizeConnectedFolder(connectedFolderId, { color: normalizeConnectedFolderColor(event.currentTarget.value) })}
                aria-label="Choose Connected Folder Color"
              />
              <span className="connected-folder-color-value">{identity.color.toUpperCase()}</span>
            </label>
          </div>
        </div>
        <div className="connected-folder-color-controls">
          <div className="connected-folder-color-swatches" role="group" aria-label="Connected Folder color presets">
            {connectedFolderColorOptions.map((option) => (
              <button
                className={identity.color === option.color ? "connected-folder-color-swatch active" : "connected-folder-color-swatch"}
                key={option.label}
                type="button"
                style={{ "--swatch-color": option.color, "--swatch-soft": option.soft, "--swatch-ink": readableTextColorOn(option.color) } as CSSProperties}
                onClick={() => onCustomizeConnectedFolder(connectedFolderId, { color: option.color })}
                aria-label={`Use ${option.label} Color`}
                aria-pressed={identity.color === option.color}
                title={option.label}
              >
                <span className="connected-folder-color-dot" aria-hidden="true">{identity.color === option.color ? <Checkmark20Regular /> : null}</span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
        </section>
      </div>
    </div>
  );
}

export { ConnectedFolderAppearancePanel, ConnectedFolderHeaderSwitcher, ConnectedFolderModeRail, ConnectedFolderNameEditor, ConnectedFolderPaneHeader };
