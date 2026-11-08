import { useEffect, useState } from "react";
import { Checkmark16Regular } from "@fluentui/react-icons";

import { api, errorText } from "../../lib/api";
import { formatBytes, formatDateTime } from "../../lib/format";
import { buildFixtureRecentlyDeleted } from "../../fixtures/settings-fixture";
import { showToast } from "../../ui/feedback";
import { recentlyDeletedSettings } from "../../ui-contract";

/**
 * Settings → Recently deleted (docs/receipts-not-gates.md, F20).
 * Nothing AmpleFile destroys is gone at the moment it happens: History covers
 * ordinary deletion, and whatever it could not keep a copy of waits here until
 * its time runs out. This pane lists what is waiting, puts an item back,
 * removes one item early, and sets how long items are kept. Nothing here
 * empties the whole store. Items left from the removed app platform are still
 * listed and can be deleted early, but cannot be put back.
 * The browser preview (`?fixture=connected-folder`) lists sample items and changes
 * nothing.
 */

/** The `app-*` kinds are older items from the removed app platform: listed, never restorable. */
export type RecentlyDeletedKind = "file" | "folder" | "connected-folder" | "skill" | "app-storage" | "app-retained" | "app-release" | "app-studio";

export interface RecentlyDeletedEntry {
  id: string;
  kind: RecentlyDeletedKind;
  reason:
    | "files.delete"
    | "agent.chat.delete"
    | "chats.delete"
    | "connected-folders.delete"
    | "skills.remove"
    // Older items from the removed app platform.
    | "apps.remove"
    | "apps.connected-folder.removed"
    | "apps.storage.clear"
    | "apps.retained.purge"
    | "apps.uninstall.purge"
    | "apps.release.delete";
  connectedFolderId: string;
  connectedFolderName?: string;
  /** skill only: the scope it goes back into. */
  scope?: "everywhere" | "connected-folder";
  originalPath: string;
  name: string;
  sizeBytes: number;
  sizeApproximate?: true;
  deletedAt: string;
  restoreBy: string;
  receiptId: string | null;
  uncovered?: Array<{ path: string; reason: "too_large" | "unreadable" | "symbolic_link" | "excluded" }>;
  held?: { reason: "legacy-metadata" | "unreadable"; noticedAt: string };
  restorable: "in-place" | "blocked";
  note?: string;
}

export interface RecentlyDeletedResponse {
  entries: RecentlyDeletedEntry[];
  damaged: Array<{ id: string; error: string }>;
  retentionDays: number;
}

const kindLabels: Record<RecentlyDeletedKind, string> = {
  file: "File",
  folder: "Folder",
  "connected-folder": "Connected Folder",
  skill: "Skill",
  "app-storage": "App Data",
  "app-retained": "App Data",
  "app-release": "App",
  "app-studio": "App",
};

const uncoveredLabels: Record<"too_large" | "unreadable" | "symbolic_link" | "excluded", string> = {
  too_large: "too large",
  unreadable: "unreadable",
  symbolic_link: "a link",
  excluded: "kept out of History",
};

export function formatDeletedSize(bytes: number, approximate?: boolean): string {
  // A deleted Connected Folder can pass a gigabyte, which the shared formatter does not show.
  const size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : formatBytes(Math.round(bytes));
  return `${approximate ? "at least " : ""}${size}`;
}

/** What the item was and where it came from, such as "Chat from Notes" or "Everywhere Skill". */
export function describeOrigin(entry: RecentlyDeletedEntry): string {
  if (entry.kind === "skill" && entry.scope === "everywhere") return "Everywhere Skill";
  const label = entry.reason === "agent.chat.delete" || entry.reason === "chats.delete" ? "Chat" : kindLabels[entry.kind];
  return `${label} from ${entry.connectedFolderName ?? entry.connectedFolderId}`;
}

export function describeUncovered(entry: RecentlyDeletedEntry): string | null {
  const uncovered = entry.uncovered ?? [];
  if (!uncovered.length) return null;
  const named = uncovered.slice(0, 3).map((file) => `${file.path} (${uncoveredLabels[file.reason]})`).join(", ");
  const more = uncovered.length > 3 ? `, and ${uncovered.length - 3} more` : "";
  return `History could not keep a copy of ${uncovered.length} file${uncovered.length === 1 ? "" : "s"}: ${named}${more}.`;
}

export function RecentlyDeletedPane({ fixtureMode = false }: { fixtureMode?: boolean } = {}) {
  const [data, setData] = useState<RecentlyDeletedResponse | null>(() => fixtureMode ? buildFixtureRecentlyDeleted() : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);

  async function reload(): Promise<void> {
    const next = await api<RecentlyDeletedResponse>("/api/settings/recently-deleted");
    setData(next);
    setRetentionDraft(null);
    setLoadError(null);
  }

  useEffect(() => {
    if (fixtureMode) return;
    let cancelled = false;
    api<RecentlyDeletedResponse>("/api/settings/recently-deleted")
      .then((next) => { if (!cancelled) { setData(next); setLoadError(null); } })
      .catch((caught) => { if (!cancelled) setLoadError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [fixtureMode]);

  async function run(key: string, operation: () => Promise<string | null>): Promise<void> {
    if (busy) return;
    if (fixtureMode) {
      showToast({ text: recentlyDeletedSettings.previewDisabled, tone: "info" });
      return;
    }
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      const done = await operation();
      await reload();
      if (done) setNotice(done);
    } catch (caught) {
      setActionError(errorText(caught));
      await reload().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  async function restore(entry: RecentlyDeletedEntry): Promise<void> {
    await run(`restore-${entry.id}`, async () => {
      await api(`/api/settings/recently-deleted/${entry.id}/restore`, { method: "POST", body: {} });
      window.dispatchEvent(new CustomEvent("amplefile:recently-deleted-restored", { detail: { entryId: entry.id, kind: entry.kind } }));
      return `${entry.name} is back`;
    });
  }

  async function deleteNow(entry: RecentlyDeletedEntry): Promise<void> {
    if (!fixtureMode && !window.confirm(recentlyDeletedSettings.deleteNowConfirm)) return;
    await run(`delete-${entry.id}`, async () => {
      await api(`/api/settings/recently-deleted/${entry.id}`, { method: "DELETE" });
      return `${entry.name} is gone`;
    });
  }

  async function saveRetention(): Promise<void> {
    const days = Number(retentionDraft);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setActionError(recentlyDeletedSettings.retentionRange);
      return;
    }
    await run("retention", async () => {
      await api("/api/settings/recently-deleted/retention", { method: "PUT", body: { retentionDays: days } });
      return recentlyDeletedSettings.retentionSaved;
    });
  }

  const entries = data?.entries ?? [];
  const retentionValue = retentionDraft ?? String(data?.retentionDays ?? 30);

  return (
    <section className="settings-section recently-deleted-pane" aria-label={recentlyDeletedSettings.heading}>
      <div className="recently-deleted-retention">
        <label htmlFor="recently-deleted-retention-input">Keep Deleted Items</label>
        <input
          id="recently-deleted-retention-input"
          type="number"
          min={1}
          max={365}
          value={retentionValue}
          disabled={!data || Boolean(busy)}
          onChange={(event) => setRetentionDraft(event.target.value)}
        />
        <span>days</span>
        <button
          className="ui-control"
          type="button"
          disabled={!data || Boolean(busy) || retentionDraft === null || retentionDraft === String(data?.retentionDays)}
          onClick={() => { void saveRetention(); }}
        >
          {recentlyDeletedSettings.retentionSave}
        </button>
      </div>
      {loadError ? <span className="settings-inline-error" role="alert">{loadError}</span> : null}
      {notice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{notice}</span> : null}
      {actionError ? <span className="settings-inline-error" role="alert">{actionError}</span> : null}
      {data?.damaged.length ? (
        <span className="settings-inline-error" role="alert">
          {recentlyDeletedSettings.damagedNote} ({data.damaged.map((item) => item.id).join(", ")})
        </span>
      ) : null}
      {data && !entries.length ? <p className="recently-deleted-empty">{recentlyDeletedSettings.empty}</p> : null}
      {entries.length ? (
        <div className="settings-list">
          {entries.map((entry) => {
            const uncovered = describeUncovered(entry);
            return (
              <div className="settings-list-row" key={entry.id}>
                <div>
                  <strong>{entry.name}</strong>
                  <small>
                    {describeOrigin(entry)} · {formatDeletedSize(entry.sizeBytes, entry.sizeApproximate)}
                  </small>
                  <small>
                    Deleted {formatDateTime(entry.deletedAt)} · Kept until {new Date(entry.restoreBy).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </small>
                  {uncovered ? <small>{uncovered}</small> : null}
                  {entry.note ? <small>{entry.note}</small> : null}
                  {entry.held ? <small>{recentlyDeletedSettings.heldNote}</small> : null}
                </div>
                <div className="settings-actions recently-deleted-row-actions">
                  {entry.restorable === "in-place" ? (
                    <button
                      className="ui-control"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => { void restore(entry); }}
                    >
                      {recentlyDeletedSettings.restore}
                    </button>
                  ) : null}
                  <button
                    className="ui-control danger"
                    type="button"
                    disabled={Boolean(busy) || Boolean(entry.held)}
                    title={entry.held ? recentlyDeletedSettings.heldNote : undefined}
                    onClick={() => { void deleteNow(entry); }}
                  >
                    {recentlyDeletedSettings.deleteNow}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
