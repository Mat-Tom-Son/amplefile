import { HistoryFileComparison } from "./HistoryFileComparison";
import { useConnectedFolderIdentityResolver } from "../../lib/connected-folder-appearance-context";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowSync16Regular,
  Chat16Regular,
  Checkmark12Regular,
  Checkmark16Regular,
  ChevronRight16Regular,
  Clock16Regular,
  Delete16Regular,
  Dismiss16Regular,
  FolderAdd20Regular,
  FolderOpen20Regular,
  History20Regular,
  MoreHorizontal16Regular,
  Search16Regular,
} from "@fluentui/react-icons";
import { api, errorText } from "../../lib/api";
import { queueHistoryRequest } from "../../lib/history-queue";
import { ActivityDot } from "../chrome/ActivityDot";
import { descendantFolders, folderTreeRows } from "../../lib/folder-nesting";
import { aggregateChatActivityStatus, chatActivityKey, chatSnoozeTimeLabel, conversationLifecycleView, isRecentlyResurfaced } from "../../lib/chat-lifecycle";
import { shortFolderLocation } from "../../lib/folder-location";
import { formatChatListTime, formatItemCount } from "../../lib/format";
import { connectedFolderIdentityStyle } from "../../lib/connected-folder-identity";
import type {
  ChatActivityStatus,
  ConversationSummary,
  ConnectedFolderCheckpoint,
  ConnectedFolderCustomizationMap,
  ConnectedFolderSummary,
} from "../../types";
import { ConnectedFolderIconGlyph } from "../chrome/common";
import { requestConfirm, showToast } from "../../ui/feedback";
import { ChatContentSearch } from "./ChatContentSearch";
import type { FixtureRestorePoint } from "../../fixtures/connected-folder-files";

export function ConnectedFoldersPane({
  connectedFolder,
  connectedFolders,
  identities,
  onCreate,
  onOpenFolder,
  onCustomize,
  onRemove,
  onDone,
}: {
  connectedFolder: ConnectedFolderSummary;
  connectedFolders: ConnectedFolderSummary[];
  identities: ConnectedFolderCustomizationMap;
  onCreate: () => void;
  onOpenFolder: () => void;
  onCustomize: (connectedFolder: ConnectedFolderSummary) => void;
  onRemove?: (connectedFolder: ConnectedFolderSummary) => void;
  onDone?: () => void;
}) {
  const connectedFolderIdentityFor = useConnectedFolderIdentityResolver();
  const paneRef = useRef<HTMLDivElement>(null);

  // Choosing Manage Connected Folders closes the menu that had focus; land focus here
  // so Escape and Tab start from this pane instead of the page body.
  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body) paneRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="connected-folder-pane-content connected-folders-pane professional-surface professional-connected-folders" ref={paneRef} tabIndex={-1}>
      <div className="professional-connected-folder-actions" aria-label="Add a Connected Folder">
        <button className="professional-connected-folder-action" type="button" onClick={onOpenFolder}>
          <span className="professional-connected-folder-action-icon" aria-hidden="true"><FolderOpen20Regular /></span>
          <strong>Connect Folder</strong>
        </button>
        <button className="professional-connected-folder-action" type="button" onClick={onCreate}>
          <span className="professional-connected-folder-action-icon" aria-hidden="true"><FolderAdd20Regular /></span>
          <strong>New Connected Folder</strong>
        </button>
      </div>

      <section className="connected-folder-pane-section professional-section-card">
        <div className="professional-section-heading">
          <span>Your Connected Folders</span>
          <span className="connected-folders-pane-heading-end">
            <strong>{formatItemCount(connectedFolders.length, "connected-folder")}</strong>
            {onDone ? <button className="connected-folders-pane-done" type="button" onClick={onDone}>Done</button> : null}
          </span>
        </div>
        <div className="connected-folder-switcher">
          {connectedFolders.map((item) => {
            const identity = connectedFolderIdentityFor(item, identities);
            const active = item.id === connectedFolder.id;
            const deletesFolder = item.location.storage === "managed";
            const location = item.location.storage === "managed" ? "" : shortFolderLocation(item.connectedFolderRoot);
            const subtitle = item.location.providerHint === "google-drive" ? (location ? `Google Drive · ${location}` : "Google Drive") : location;
            return (
              <div className={active ? "connected-folder-card-shell active" : "connected-folder-card-shell"} key={item.id} style={connectedFolderIdentityStyle(identity)}>
                <div className="connected-folder-card-row">
                  <button
                    className={active ? "connected-folder-tab connected-folder-card-main active" : "connected-folder-tab connected-folder-card-main"}
                    type="button"
                    onClick={() => onCustomize(item)}
                    aria-label={`Customize ${item.name}`}
                    title="Customize Connected Folder"
                  >
                    <span className="connected-folder-tab-icon connected-folder-identity-icon"><ConnectedFolderIconGlyph icon={identity.Icon} size={16} /></span>
                    <span className="connected-folder-tab-copy">
                      <strong>{item.name}</strong>
                      {subtitle ? <span title={item.connectedFolderRoot || undefined}>{subtitle}</span> : null}
                    </span>
                    {active ? <span className="active-dot" aria-label="Active Connected Folder"><Checkmark12Regular /></span> : null}
                  </button>
                  <span className="connected-folder-card-actions">
                    {onRemove ? (
                      <button
                        className="connected-folder-card-delete"
                        type="button"
                        onClick={() => onRemove(item)}
                        aria-label={`${deletesFolder ? "Delete" : "Remove"} ${item.name}`}
                        title={deletesFolder ? "Delete Connected Folder" : "Disconnect"}
                      >
                        <Delete16Regular />
                      </button>
                    ) : null}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** Chats grouped the way people remember them: Today, Yesterday, the last week, the last month, Earlier. */
export function chatDateGroups(chats: ConversationSummary[], now: number): Array<{ label: string; chats: ConversationSummary[] }> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1_000;
  const labelFor = (updatedAt: string) => {
    const time = Date.parse(updatedAt);
    if (!Number.isFinite(time) || time >= startOfToday.getTime()) return "Today";
    if (time >= startOfToday.getTime() - day) return "Yesterday";
    if (time >= startOfToday.getTime() - 7 * day) return "Previous 7 Days";
    if (time >= startOfToday.getTime() - 30 * day) return "Previous 30 Days";
    return "Earlier";
  };
  const groups: Array<{ label: string; chats: ConversationSummary[] }> = [];
  for (const chat of chats) {
    const label = labelFor(chat.updatedAt);
    const group = groups.at(-1)?.label === label ? groups.at(-1)! : groups.find((item) => item.label === label);
    if (group) group.chats.push(chat);
    else groups.push({ label, chats: [chat] });
  }
  return groups;
}

export function ChatsPane({
  connectedFolder,
  connectedFolders,
  conversations,
  customizations,
  activeConversationId,
  onOpen,
  onNew,
  onActions,
  activityStatuses,
}: {
  connectedFolder: ConnectedFolderSummary;
  connectedFolders: ConnectedFolderSummary[];
  conversations: Record<string, ConversationSummary[]>;
  customizations: ConnectedFolderCustomizationMap;
  activeConversationId?: string | null;
  onOpen: (connectedFolder: ConnectedFolderSummary, conversation: ConversationSummary) => void;
  onNew: (connectedFolder: ConnectedFolderSummary) => void;
  onActions: (connectedFolder: ConnectedFolderSummary, conversation: ConversationSummary, event: React.MouseEvent<HTMLElement>) => void;
  activityStatuses: Record<string, ChatActivityStatus>;
}) {
  const connectedFolderIdentityFor = useConnectedFolderIdentityResolver();
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [expandedOtherConnectedFolderIds, setExpandedOtherConnectedFolderIds] = useState<Set<string>>(() => new Set());
  // Snoozed and Archived are quiet rows at the bottom (2026-10-01), closed
  // until asked for, instead of a tab bar every visit has to read past.
  const [openShelves, setOpenShelves] = useState<Set<"snoozed" | "archived">>(() => new Set());
  const normalized = query.trim().toLocaleLowerCase();
  // The Connected Folders inside this one belong to it here: their Chats sit right
  // under its own, indented the way the Connected Folder switcher shows them.
  const nestedRows = useMemo(() => folderTreeRows(descendantFolders(connectedFolder, connectedFolders)), [connectedFolder, connectedFolders]);
  const nestedIds = new Set(nestedRows.map((row) => row.connectedFolder.id));
  const orderedConnectedFolders = [connectedFolder, ...nestedRows.map((row) => row.connectedFolder), ...connectedFolders.filter((item) => item.id !== connectedFolder.id && !nestedIds.has(item.id))];
  const allChats = orderedConnectedFolders.flatMap((item) => (conversations[item.id] ?? []).map((chat) => ({ item, chat })));
  const shelfChats = (view: "snoozed" | "archived") => allChats.filter(({ chat }) => conversationLifecycleView(chat, now) === view);

  useEffect(() => {
    if (!allChats.some(({ chat }) => conversationLifecycleView(chat, now) === "snoozed")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [allChats.map(({ chat }) => chat.snoozedUntil ?? "").join("|"), now]);

  useEffect(() => {
    setExpandedOtherConnectedFolderIds(new Set());
  }, [connectedFolder.id]);

  const matchesQuery = (chat: ConversationSummary) => !normalized || chat.title.toLocaleLowerCase().includes(normalized);
  // While searching, every Chat is fair game, snoozed and archived included.
  function chatsFor(item: ConnectedFolderSummary): ConversationSummary[] {
    return (conversations[item.id] ?? []).filter((chat) =>
      (normalized ? true : conversationLifecycleView(chat, now) === "active") && matchesQuery(chat));
  }

  function toggle<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T): void {
    setter((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function chatSecondary(chat: ConversationSummary, item: ConnectedFolderSummary | null): string {
    const view = conversationLifecycleView(chat, now);
    const time = view === "snoozed" && chat.snoozedUntil
      ? chatSnoozeTimeLabel(chat.snoozedUntil)
      : view === "archived" && chat.archivedAt
        ? `Archived ${formatChatListTime(chat.archivedAt)}`
        : isRecentlyResurfaced(chat, now)
          ? "Back now"
          : formatChatListTime(chat.updatedAt);
    return item ? `${item.name} · ${time}` : time;
  }

  function renderChatRows(entries: Array<{ item: ConnectedFolderSummary; chat: ConversationSummary }>, showFolder: boolean): ReactNode {
    return entries.map(({ item, chat }) => {
      const status = activityStatuses[chatActivityKey(item.id, chat.id)];
      const resurfaced = conversationLifecycleView(chat, now) === "active" && isRecentlyResurfaced(chat, now);
      return (
        <div
          className={[
            "chat-connected-folder-row-shell",
            chat.id === activeConversationId ? "active" : "",
            status ? `status-${status}` : "",
            resurfaced ? "resurfaced" : "",
          ].filter(Boolean).join(" ")}
          key={`${item.id}:${chat.id}`}
          onContextMenu={(event) => { event.preventDefault(); onActions(item, chat, event); }}
        >
          <button
            className="chat-connected-folder-row"
            type="button"
            aria-current={chat.id === activeConversationId ? "page" : undefined}
            onClick={() => onOpen(item, chat)}
          >
            <span className="chat-connected-folder-row-title">{chat.title}</span>
            <span className="chat-connected-folder-row-meta">
              {status ? <ActivityDot status={status} labeled /> : null}
              <span className="chat-connected-folder-row-time">{chatSecondary(chat, showFolder ? item : null)}</span>
            </span>
          </button>
          <button
            className="chat-connected-folder-row-actions"
            type="button"
            aria-label={`Actions for ${chat.title}`}
            title="Chat Actions"
            onClick={(event) => onActions(item, chat, event)}
          >
            <MoreHorizontal16Regular />
          </button>
        </div>
      );
    });
  }

  function renderChatList(item: ConnectedFolderSummary, list: ConversationSummary[], className: string, emptyText: string | null): ReactNode {
    return (
      <div className={`chat-connected-folder-list ${className}`}>
        {renderChatRows(list.map((chat) => ({ item, chat })), false)}
        {!list.length && emptyText ? <span className="chat-connected-folder-empty">{emptyText}</span> : null}
      </div>
    );
  }

  // A long history reads by date; a short one, or a search, stays one list.
  function renderDatedChatList(item: ConnectedFolderSummary, list: ConversationSummary[], className: string, emptyText: string | null): ReactNode {
    const groups = chatDateGroups(list, now);
    if (normalized || groups.length < 2) return renderChatList(item, list, className, emptyText);
    return (
      <div className={`chat-connected-folder-list ${className}`}>
        {groups.map(({ label, chats }) => (
          <div className="chat-date-group" key={label} role="group" aria-label={label}>
            <h4 className="chat-date-group-label">{label}</h4>
            {renderChatRows(chats.map((chat) => ({ item, chat })), false)}
          </div>
        ))}
      </div>
    );
  }

  const currentList = chatsFor(connectedFolder);
  const currentIdentity = connectedFolderIdentityFor(connectedFolder, customizations);
  const otherConnectedFolderGroups = connectedFolders
    .filter((item) => item.id !== connectedFolder.id && !nestedIds.has(item.id))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((item) => {
      const list = chatsFor(item);
      const status = aggregateChatActivityStatus(item.id, conversations[item.id] ?? [], activityStatuses);
      return { item, list, status };
    });
  const shelves = (["snoozed", "archived"] as const).map((view) => ({ view, entries: shelfChats(view) })).filter((shelf) => shelf.entries.length > 0);

  return (
    <div className="connected-folder-pane-content chats-pane professional-surface professional-chats">
      <div className="file-tree-toolbar professional-pane-toolbar">
        <label className="file-tree-search">
          <Search16Regular aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search Chats"
            aria-label="Search Chats"
          />
          {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear Chat Search" title="Clear Chat Search"><Dismiss16Regular /></button> : null}
        </label>
      </div>
      <div className="chat-connected-folder-groups">
        <section className="chat-connected-folder-group chat-connected-folder-group-current" style={connectedFolderIdentityStyle(currentIdentity)}>
          <div className="chat-connected-folder-heading">
            <span className="connected-folder-identity-icon" aria-hidden="true"><ConnectedFolderIconGlyph icon={currentIdentity.Icon} size={15} /></span>
            <strong>{connectedFolder.name}</strong>
            <button className="ui-control ui-control--icon" type="button" onClick={() => onNew(connectedFolder)} aria-label={`New Chat in ${connectedFolder.name}`} title="New Chat"><Chat16Regular /></button>
          </div>
          {renderDatedChatList(connectedFolder, currentList, "chat-connected-folder-list-current", normalized ? null : nestedRows.length ? null : "No Chats Yet")}
          {nestedRows.map(({ connectedFolder: item, depth }) => {
            const identity = connectedFolderIdentityFor(item, customizations);
            const list = chatsFor(item);
            if (normalized && !list.length) return null;
            const status = aggregateChatActivityStatus(item.id, conversations[item.id] ?? [], activityStatuses);
            return (
              <div className="chat-nested-connected-folder" key={item.id} style={{ ...connectedFolderIdentityStyle(identity), "--folder-depth": depth + 1 } as CSSProperties}>
                <div className="chat-nested-connected-folder-heading">
                  <span className="connected-folder-identity-icon chat-other-connected-folder-icon" aria-hidden="true"><ConnectedFolderIconGlyph icon={identity.Icon} size={13} /></span>
                  <span className="chat-nested-connected-folder-name">{item.name}</span>
                  {status ? <ActivityDot status={status} /> : null}
                  <button className="ui-control ui-control--icon" type="button" onClick={() => onNew(item)} aria-label={`New Chat in ${item.name}`} title="New Chat"><Chat16Regular /></button>
                </div>
                {list.length ? renderChatList(item, list, "chat-connected-folder-list-nested", null) : null}
              </div>
            );
          })}
        </section>
        {otherConnectedFolderGroups.length ? (
          <section className="chat-other-connected-folders" aria-label="Chats in other Connected Folders">
            {otherConnectedFolderGroups.map(({ item, list, status }) => {
              const identity = connectedFolderIdentityFor(item, customizations);
              const expanded = Boolean(normalized) || expandedOtherConnectedFolderIds.has(item.id);
              if (normalized && !list.length) return null;
              return (
                <div className={expanded ? "chat-other-connected-folder expanded" : "chat-other-connected-folder"} key={item.id} style={connectedFolderIdentityStyle(identity)}>
                  <div className="chat-other-connected-folder-header">
                    <button
                      className="chat-other-connected-folder-toggle"
                      type="button"
                      disabled={Boolean(normalized)}
                      aria-label={`${expanded ? "Hide" : "Show"} chats in ${item.name}`}
                      aria-expanded={expanded}
                      aria-controls={`chat-other-connected-folder-${item.id}`}
                      onClick={() => toggle(setExpandedOtherConnectedFolderIds, item.id)}
                    >
                      <span className="connected-folder-identity-icon chat-other-connected-folder-icon" aria-hidden="true"><ConnectedFolderIconGlyph icon={identity.Icon} size={14} /></span>
                      <span>{item.name}</span>
                      <ChevronRight16Regular aria-hidden="true" />
                      {status ? <ActivityDot status={status} /> : null}
                    </button>
                    <button className="ui-control ui-control--icon" type="button" onClick={() => onNew(item)} aria-label={`New Chat in ${item.name}`} title="New Chat"><Chat16Regular /></button>
                  </div>
                  {expanded ? <div id={`chat-other-connected-folder-${item.id}`}>{renderChatList(item, list, "chat-connected-folder-list-other", "No Chats Yet")}</div> : null}
                </div>
              );
            })}
          </section>
        ) : null}
        {!normalized && shelves.length ? (
          <section className="chat-shelves" aria-label="Snoozed and archived Chats">
            {shelves.map(({ view, entries }) => {
              const open = openShelves.has(view);
              return (
                <div className={open ? "chat-shelf open" : "chat-shelf"} key={view}>
                  <button
                    className="chat-shelf-toggle"
                    type="button"
                    aria-expanded={open}
                    aria-controls={`chat-shelf-${view}`}
                    onClick={() => toggle(setOpenShelves, view)}
                  >
                    <span>{view === "snoozed" ? "Snoozed" : "Archived"}</span>
                    <small>{entries.length}</small>
                    <ChevronRight16Regular aria-hidden="true" />
                  </button>
                  {open ? <div className="chat-connected-folder-list chat-shelf-list" id={`chat-shelf-${view}`}>{renderChatRows(entries, true)}</div> : null}
                </div>
              );
            })}
          </section>
        ) : null}
        <ChatContentSearch
          connectedFolders={orderedConnectedFolders}
          conversations={conversations}
          query={query}
          now={now}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}

export interface HistoryRestorePreview {
  checkpointId: string;
  scope: "full" | "targeted";
  restoreFiles: string[];
  removePaths: string[];
  moves: Array<{ fromPath: string; toPath: string }>;
  excludedPaths: string[];
  uncoveredPaths: string[];
  conflicts: string[];
}

export function HistoryPane({ connectedFolder, fixtureItems, fixtureRestorePoints, refreshRequest = 0, selectedCheckpointId, onOpen, onRestored, onError }: {
  connectedFolder: ConnectedFolderSummary;
  fixtureItems?: ConnectedFolderCheckpoint[];
  /** The preview's restore point pages and Compare views, by restore point. */
  fixtureRestorePoints?: Record<string, FixtureRestorePoint>;
  refreshRequest?: number;
  selectedCheckpointId?: string;
  onOpen?: (item: ConnectedFolderCheckpoint) => void;
  onRestored?: () => void | Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [items, setItems] = useState<ConnectedFolderCheckpoint[]>(fixtureItems ?? []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<HistoryRestorePreview | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewError, setPreviewError] = useState("");
  const [comparisonPath, setComparisonPath] = useState("");
  useEffect(() => { setComparisonPath(""); }, [connectedFolder.id, selectedCheckpointId]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null); setPreviewError("");
    if (selectedCheckpointId && fixtureItems) {
      const fixturePreview = fixtureRestorePoints?.[selectedCheckpointId]?.preview;
      if (fixturePreview) setPreview(fixturePreview);
      else setPreviewError("Restore previews are unavailable for demonstration data.");
    }
    if (!fixtureItems) {
      // An obsolete effect skips its reads; one already sent still finishes
      // before the next starts (development Strict Mode replay, a quickly
      // changed restore point).
      const read = <T,>(path: string) => queueHistoryRequest(connectedFolder.id, async () => cancelled ? null : api<T>(path));
      void (async () => {
        const listed = await read<{ checkpoints: ConnectedFolderCheckpoint[] }>(`/api/connected-folders/${connectedFolder.id}/history/checkpoints`);
        if (!listed || cancelled) return;
        setItems(listed.checkpoints);
        if (!selectedCheckpointId) return;
        const result = await read<{ preview: HistoryRestorePreview }>(`/api/connected-folders/${connectedFolder.id}/history/checkpoints/${selectedCheckpointId}/preview`);
        if (result && !cancelled) setPreview(result.preview);
      })().catch((error) => {
        if (cancelled) return;
        if (selectedCheckpointId) setPreviewError(errorText(error));
        else onError(errorText(error));
      });
    }
    return () => { cancelled = true; };
  }, [connectedFolder.id, selectedCheckpointId, fixtureItems, fixtureRestorePoints, refreshRequest, previewRevision]);

  useEffect(() => { setNotice(""); }, [connectedFolder.id, fixtureItems]);

  async function load() {
    try { setItems((await queueHistoryRequest(connectedFolder.id, () => api<{ checkpoints: ConnectedFolderCheckpoint[] }>(`/api/connected-folders/${connectedFolder.id}/history/checkpoints`))).checkpoints); }
    catch (caught) { onError(errorText(caught)); }
  }

  async function savePoint() {
    if (fixtureItems) return;
    setBusy(true);
    try {
      const result = await queueHistoryRequest(connectedFolder.id, () => api<{ created: boolean }>(`/api/connected-folders/${connectedFolder.id}/history/checkpoints`, { method: "POST", body: { label: "Manual Restore Point" } }));
      setNotice(result.created ? "Restore point saved." : "Current files already match the latest restore point.");
      await load();
    }
    catch (caught) { setNotice(""); onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  async function restore(item: ConnectedFolderCheckpoint) {
    if (fixtureItems) {
      if (selectedCheckpointId === item.checkpointId) showToast({ text: "Restoring is disabled in the preview", tone: "info" });
      else onOpen?.(item);
      return;
    }
    if (selectedCheckpointId !== item.checkpointId && onOpen) { onOpen(item); return; }
    let reviewed: HistoryRestorePreview;
    try {
      reviewed = (await queueHistoryRequest(connectedFolder.id, () => api<{ preview: HistoryRestorePreview }>(`/api/connected-folders/${connectedFolder.id}/history/checkpoints/${item.checkpointId}/preview`))).preview;
      setPreview(reviewed);
    } catch (error) { setPreviewError(errorText(error)); return; }
    if (reviewed.conflicts.length) return;
    const changing = restorePointChanges(reviewed).length;
    const confirmed = await requestConfirm({
      title: reviewed.scope === "targeted" ? "Undo these changes?" : `Restore ${connectedFolder.name} to ${formatDate(item.createdAt)}?`,
      body: `${changing} ${changing === 1 ? "file changes" : "files change"}. Your current files are saved first, so you can undo this from History.`,
      confirmLabel: reviewed.scope === "targeted" ? "Undo Changes" : "Restore", tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await queueHistoryRequest(connectedFolder.id, () => api(`/api/connected-folders/${connectedFolder.id}/history/checkpoints/${item.checkpointId}/restore`, { method: "POST", body: {} }));
      await load(); setPreviewRevision((value) => value + 1);
      setComparisonPath("");
      showToast({ text: "Restored. Your previous files are saved in History.", tone: "success" });
      await onRestored?.();
    }
    catch (caught) { onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  if (selectedCheckpointId) {
    // One action at the top and one list of what it changes (2026-10-30).
    const selected = items.find((item) => item.checkpointId === selectedCheckpointId);
    const changes = preview ? restorePointChanges(preview) : [];
    const leftAlone = preview ? restorePointLeftAlone(preview) : [];
    const fixtureComparisons = fixtureItems ? fixtureRestorePoints?.[selectedCheckpointId]?.comparisons : undefined;
    return <div className="connected-folder-pane-content history-pane professional-surface professional-history history-review">
      <header className="history-review-header">
        <div className="history-review-identity">
          <h1>{selected ? restorePointTitle(selected) : "Restore Point"}</h1>
          {selected ? <p className="history-detail-meta">{formatDate(selected.createdAt)}</p> : null}
        </div>
        {preview && changes.length ? <button className="ui-control ui-control--primary" type="button" disabled={busy || !selected || preview.conflicts.length > 0} onClick={() => selected && void restore(selected)}>
          {busy ? "Restoring…" : preview.scope === "targeted" ? "Undo These Changes" : "Restore"}
        </button> : null}
      </header>
      {previewError ? <p role="alert">{previewError}</p> : null}
      {!preview && !previewError ? <p className="history-review-status" role="status">Checking your files…</p> : null}
      {preview?.conflicts.map((conflict) => <p role="alert" key={conflict}>{conflict}</p>)}
      {preview && !changes.length && !preview.conflicts.length ? <p className="history-review-status">Your files already match this restore point.</p> : null}
      {changes.length ? <section className="history-restore-changes">
        <h2>{changes.length} {changes.length === 1 ? "file" : "files"} changed since then</h2>
        <ul>{changes.map((change) => {
          const comparing = comparisonPath === change.path;
          return <li key={`${change.kind}:${change.path}`}>
            <div className="history-change-row">
              <span className="history-change-name" title={change.detail ?? change.path}>
                <strong>{pathBaseName(change.path)}</strong>
                {change.detail ?? pathFolder(change.path) ? <small>{change.detail ?? pathFolder(change.path)}</small> : null}
              </span>
              <span className="history-change-kind">{change.kind}</span>
              {change.kind !== "Moved" && (!fixtureItems || fixtureComparisons?.[change.path]) ? <button className="ui-control ui-control--quiet compact" type="button" aria-expanded={comparing} onClick={() => setComparisonPath(comparing ? "" : change.path)}>{comparing ? "Hide" : "Compare"}</button> : null}
            </div>
            {comparing ? <HistoryFileComparison connectedFolderId={connectedFolder.id} path={change.path} fromCheckpointId={selectedCheckpointId} refreshRequest={refreshRequest + previewRevision} fixtureComparison={fixtureComparisons?.[change.path]} /> : null}
          </li>;
        })}</ul>
      </section> : null}
      {leftAlone.length ? <p className="history-review-note">Restoring leaves these alone: {leftAlone.join(", ")}</p> : null}
    </div>;
  }

  return (
    <div className="connected-folder-pane-content history-pane professional-surface professional-history">
      <div className="history-pane-actions">
        <div className="history-title"><h2>History</h2><span>{items.length} restore {items.length === 1 ? "point" : "points"}</span></div>
        {notice ? <p className="history-save-status" role="status"><Checkmark16Regular />{notice}</p> : null}
        <button className="ui-control ui-control--primary" type="button" onClick={() => void savePoint()} disabled={busy || Boolean(fixtureItems)}>
          {busy ? <ArrowSync16Regular className="spin" /> : <Clock16Regular />}Save Restore Point
        </button>
      </div>
      <div className="history-journal">
        {!items.length ? <EmptyState icon={<History20Regular />} title="No Restore Points Yet" detail="Save a restore point to keep a version of this Connected Folder." /> : null}
        {historyDateGroups(items).map(({label,points}) => <section key={label} className="history-day"><h3>{label}</h3><div>{points.map(item => <button className={item.checkpointId===selectedCheckpointId ? "history-entry selected" : "history-entry"} aria-current={item.checkpointId===selectedCheckpointId ? "true" : undefined} type="button" key={item.checkpointId} disabled={!onOpen && (busy || Boolean(fixtureItems))} onClick={()=>onOpen ? onOpen(item) : void restore(item)} aria-label={`Review ${restorePointTitle(item)}`}>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time>
          <span><strong>{restorePointTitle(item)}</strong><small>{item.fileCount} {item.fileCount === 1 ? 'file' : 'files'}</small></span>
          <ChevronRight16Regular aria-hidden="true"/>
        </button>)}</div></section>)}
      </div>
    </div>
  );
}

// Saved labels predate the plain words; older ones still say "turn" or "Assistant".
const restorePointTitles: Record<string, string> = {
  "Before turn": "Before a Worker reply",
  "After turn": "After a Worker reply",
  "Before Assistant turn": "Before a Worker reply",
  "After Assistant turn": "After a Worker reply",
  "Manual Restore Point": "Saved by you",
};

/** A restore point's name in the words the rest of the app uses. */
export function restorePointTitle(item: Pick<ConnectedFolderCheckpoint, "label" | "reason">): string {
  const label = item.label?.trim() || item.reason;
  // The host names the safety point taken before a restore after the restore
  // point's id ("Before restoring cp-20261107013801-1a2b3c4d"); the id means nothing to a person.
  if (/^Before restoring cp-\d{14}-[0-9a-f]{8}$/u.test(label)) return "Before restoring";
  return restorePointTitles[label] ?? label;
}

type RestorePointChange = { kind: "Changed" | "Added" | "Moved"; path: string; detail?: string };

/**
 * What changed since the restore point, which is what restoring undoes.
 * Files that still match are never listed: the host only reports a file whose
 * saved copy differs from the one on disk or is missing from it.
 */
function restorePointChanges(preview: HistoryRestorePreview): RestorePointChange[] {
  return [
    ...preview.restoreFiles.map((path): RestorePointChange => ({ kind: "Changed", path })),
    ...preview.removePaths.map((path): RestorePointChange => ({ kind: "Added", path })),
    // The host describes a move the way restoring undoes it, from where the
    // file is now back to where it was, so the change since then runs the other way.
    ...preview.moves.map((move): RestorePointChange => ({ kind: "Moved", path: move.fromPath, detail: `from ${move.toPath}` })),
  ];
}

/**
 * What restoring will not touch, minus the folders History never covers
 * (`.amplefile`, `.pi`, `.workspace`), which every restore point leaves alone.
 */
function restorePointLeftAlone(preview: HistoryRestorePreview): string[] {
  const neverCovered = /^\.(?:amplefile|pi|workspace)(?:\/|$)/u;
  return [...new Set([...preview.excludedPaths, ...preview.uncoveredPaths])].filter((path) => !neverCovered.test(path));
}

function pathBaseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function pathFolder(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

function historyDateGroups(items: ConnectedFolderCheckpoint[]): Array<{ label: string; points: ConnectedFolderCheckpoint[] }> {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const groups = new Map<string, { label: string; points: ConnectedFolderCheckpoint[] }>();
  for (const point of items) {
    const date = new Date(point.createdAt);
    const key = date.toDateString();
    const label = key === now.toDateString() ? "Today" : key === yesterday.toDateString() ? "Yesterday"
      : date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
    const group = groups.get(key) ?? { label, points: [] };
    group.points.push(point);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export { AiModelsPane, type ModelScope } from "./AiModelsPane";

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail?: string }) {
  return (
    <div className="professional-empty-state">
      <span className="professional-empty-icon" aria-hidden="true">{icon}</span>
      <div><h2>{title}</h2>{detail ? <p>{detail}</p> : null}</div>
    </div>
  );
}

function formatDate(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
