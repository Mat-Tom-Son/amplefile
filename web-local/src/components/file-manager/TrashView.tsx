import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import "./file-manager-places.css";
import { ChevronDown16Regular, ChevronUp16Regular } from "@fluentui/react-icons";

import { api, errorText } from "../../lib/api";
import { requestConfirm, showToast } from "../../ui/feedback";
import type { TreeEntry } from "../../types";
import { EntryIcon } from "./FileEntries";
import { formatFileManagerDate } from "./file-manager-model";
import type { FileManagerLocation } from "./file-manager-places";
import {
  confirmPermanent,
  defaultTrashSort,
  deleteImmediatelyConfirm,
  emptyTrashConfirm,
  unavailableTrashNotice,
  filterTrashItems,
  nextTrashSort,
  permanentResultMessage,
  putBackBlocker,
  putBackMessage,
  sortTrashItems,
  trashDifferenceText,
  trashLocationText,
  trashChangedEvent,
  trashSizeText,
  type PermanentDeletionResult,
  type PutBackResult,
  type TrashItem,
  type TrashListing,
  type TrashSort,
  type TrashSortKey,
} from "./file-manager-trash";

/** The preview's sample Trash; nothing in it can be changed. */
function fixtureTrash(): TrashListing {
  const now = Date.now();
  return {
    putBackAvailable: true,
    truncated: false,
    items: [
      { id: "trash-sample-1", name: "Old invoice.pdf", originalPath: "/home/you/Documents/Old invoice.pdf", deletedAt: new Date(now - 3_600_000).toISOString(), kind: "file", sizeBytes: 184_320, trash: "home", volumePath: null, canPutBack: true },
      { id: "trash-sample-2", name: "Screenshots", originalPath: "/home/you/Desktop/Screenshots", deletedAt: new Date(now - 86_400_000 * 3).toISOString(), kind: "folder", sizeBytes: 12_582_912, trash: "home", volumePath: null, canPutBack: true },
    ],
  };
}

/**
 * The system Trash in the list area (docs/product-model.md, "The file manager
 * window"): name, where it was, when it was deleted, and its size, with Put
 * Back, Delete Immediately, and Empty Trash. The two permanent actions ask
 * first and say what will be lost; nothing goes until the person says yes.
 * The list is read again whenever it is shown and when the window comes back,
 * so an item just moved to the Trash is there.
 */
export function TrashView({ fixtureMode, query, onShow, onSelectionChange, onCount, onError, runDeletion }: {
  fixtureMode: boolean;
  /** The toolbar's Search text: the Trash shows the items whose names hold it. */
  query: string;
  /** Put Back's Show: the item in its folder, selected. */
  onShow: (location: FileManagerLocation, select: string | null) => void;
  onSelectionChange?: (items: TrashItem[]) => void;
  /** How many items the Trash holds, for the path bar's status. */
  onCount?: (count: number | null) => void;
  onError: (message: string | null) => void;
  /**
   * Runs Empty Trash or Delete Immediately as a file operation, with progress
   * and Stop in the window's operations area; without it the request runs
   * plainly. The request gets the operation's id.
   */
  runDeletion?: (title: string, request: (operationId: string | null) => Promise<PermanentDeletionResult>) => Promise<PermanentDeletionResult>;
}) {
  const [listing, setListing] = useState<TrashListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"empty" | "delete" | "put-back" | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const [sort, setSort] = useState<TrashSort>(defaultTrashSort);
  const listRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    if (fixtureMode) { setListing(fixtureTrash()); return; }
    try {
      const next = await api<TrashListing>("/api/trash");
      if (request !== requestRef.current) return;
      setListing(next);
      setLoadError(null);
    } catch (caught) {
      if (request !== requestRef.current) return;
      setLoadError(errorText(caught));
    }
  }, [fixtureMode]);

  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const changed = () => void load();
    window.addEventListener("focus", refresh);
    window.addEventListener(trashChangedEvent, changed);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener(trashChangedEvent, changed); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  const shown = useMemo(() => sortTrashItems(filterTrashItems(listing?.items ?? [], query), sort), [listing, query, sort]);
  const order = useMemo(() => shown.map((item) => item.id), [shown]);
  const chosen = useMemo(() => {
    const ids = new Set(selection);
    return shown.filter((item) => ids.has(item.id));
  }, [selection, shown]);
  useEffect(() => { onSelectionChange?.(chosen); }, [chosen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onCount?.(listing ? listing.items.length : null); }, [listing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onSelectionChange?.([]), []); // eslint-disable-line react-hooks/exhaustive-deps

  function select(ids: string[], anchor = ids.at(-1) ?? null) {
    setSelection(ids);
    anchorRef.current = anchor;
    const last = ids.at(-1);
    if (last) window.requestAnimationFrame(() => [...(listRef.current?.querySelectorAll<HTMLElement>("[data-trash-id]") ?? [])].find((row) => row.dataset.trashId === last)?.scrollIntoView?.({ block: "nearest" }));
  }

  function clickItem(item: TrashItem, event: MouseEvent<HTMLElement>) {
    event.stopPropagation();
    listRef.current?.focus({ preventScroll: true });
    if (event.shiftKey && anchorRef.current) {
      const from = order.indexOf(anchorRef.current);
      const to = order.indexOf(item.id);
      if (from >= 0 && to >= 0) { select(order.slice(Math.min(from, to), Math.max(from, to) + 1), anchorRef.current); return; }
    }
    if (event.metaKey || event.ctrlKey) {
      select(selection.includes(item.id) ? selection.filter((id) => id !== item.id) : [...selection, item.id], item.id);
      return;
    }
    select([item.id]);
  }

  async function putBack(items = chosen) {
    if (!items.length || busy) return;
    if (fixtureMode) { showToast({ text: "Put Back is disabled in the preview", tone: "info" }); return; }
    const blocker = putBackBlocker(listing, items);
    if (blocker) { showToast({ text: blocker, tone: "info" }); return; }
    setBusy("put-back");
    let restored = 0;
    let last: { result: PutBackResult; name: string } | null = null;
    try {
      for (const item of items) {
        const result = await api<PutBackResult>("/api/trash/put-back", { method: "POST", body: { itemId: item.id } });
        restored += 1;
        last = { result, name: item.name };
      }
    } catch (caught) {
      onError(errorText(caught));
    } finally {
      setBusy(null);
      setSelection([]);
      await load();
    }
    if (!last) return;
    const { result, name } = last;
    const location = result.location;
    const partial = restored < items.length;
    showToast({
      text: items.length === 1 ? putBackMessage(result, name) : partial
        ? `Put back ${restored.toLocaleString()} of ${items.length.toLocaleString()} items`
        : `Put back ${restored.toLocaleString()} items`,
      tone: partial ? "info" : "success",
      ...(location ? { actionLabel: "Show", onAction: () => onShow({ place: location.place, path: location.path }, location.select) } : {}),
    });
  }

  async function deleteImmediately(items = chosen) {
    if (!items.length || busy) return;
    if (fixtureMode) { showToast({ text: "Deleting is disabled in the preview", tone: "info" }); return; }
    const ids = items.map((item) => item.id);
    const outcome = await confirmPermanent(deleteImmediatelyConfirm(items), requestConfirm, async () => {
      setBusy("delete");
      try {
        const request = (operationId: string | null) => api<PermanentDeletionResult>("/api/trash/delete", { method: "POST", body: { itemIds: ids, ...(operationId ? { operationId } : {}) } });
        return await (runDeletion ? runDeletion(ids.length === 1 ? `Deleting “${items[0]!.name}”` : `Deleting ${ids.length.toLocaleString()} items`, request) : request(null));
      } finally {
        setBusy(null);
      }
    }).catch((caught) => { onError(errorText(caught)); return null; });
    if (!outcome) return;
    setSelection([]);
    await load();
    showToast(permanentResultMessage(outcome, false));
  }

  async function emptyTrash() {
    if (!listing || busy) return;
    if (fixtureMode) { showToast({ text: "Emptying the Trash is disabled in the preview", tone: "info" }); return; }
    const outcome = await confirmPermanent(emptyTrashConfirm(listing), requestConfirm, async () => {
      setBusy("empty");
      try {
        const request = (operationId: string | null) => api<PermanentDeletionResult>("/api/trash/empty", { method: "POST", body: operationId ? { operationId } : {} });
        return await (runDeletion ? runDeletion("Emptying the Trash", request) : request(null));
      } finally {
        setBusy(null);
      }
    }).catch((caught) => { onError(errorText(caught)); return null; });
    if (!outcome) return;
    setSelection([]);
    await load();
    showToast(permanentResultMessage(outcome, true));
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    const command = event.metaKey || event.ctrlKey;
    const index = selection.length ? order.indexOf(selection.at(-1)!) : -1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!order.length) return;
      const next = index < 0 ? (event.key === "ArrowDown" ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
      const id = order[next]!;
      if (event.shiftKey && anchorRef.current) {
        const from = order.indexOf(anchorRef.current);
        select(order.slice(Math.min(from, next), Math.max(from, next) + 1), anchorRef.current);
      } else select([id]);
      return;
    }
    if (command && (event.key === "a" || event.key === "A")) { event.preventDefault(); select([...order], order[0] ?? null); return; }
    if ((event.key === "Delete" || (command && event.key === "Backspace")) && chosen.length) { event.preventDefault(); void deleteImmediately(); return; }
    if (event.key === "Escape" && selection.length) { event.preventDefault(); select([]); }
  }

  const columns: ReadonlyArray<{ key: TrashSortKey; label: string }> = [
    { key: "name", label: "Name" },
    { key: "location", label: "Original Location" },
    { key: "deleted", label: "Date Deleted" },
    { key: "size", label: "Size" },
  ];
  const blocker = putBackBlocker(listing, chosen);
  const empty = Boolean(listing && !listing.items.length);
  const unavailable = unavailableTrashNotice(listing?.unavailableVolumes);

  return <div className="fm-trash">
    <div className="fm-trash-bar">
      <p className="fm-trash-about">{trashDifferenceText}</p>
      <div className="fm-trash-actions">
        <button type="button" className="fm-btn" disabled={!chosen.length || Boolean(busy) || Boolean(blocker)} title={blocker ?? "Return the selected items to where they were"} onClick={() => void putBack()}>Put Back</button>
        <button type="button" className="fm-btn" disabled={!chosen.length || Boolean(busy)} onClick={() => void deleteImmediately()}>Delete Immediately…</button>
        <button type="button" className="fm-btn is-danger" disabled={!listing || empty || Boolean(busy)} onClick={() => void emptyTrash()}>Empty Trash…</button>
      </div>
    </div>
    {busy ? <div className="fm-trash-progress" role="status" aria-live="polite">
      <span className="fm-trash-spinner" aria-hidden="true" />
      {busy === "empty" ? "Emptying the Trash…" : busy === "delete" ? "Deleting…" : "Putting back…"}
    </div> : null}
    {blocker && chosen.length && listing?.putBackAvailable === false ? <p className="fm-trash-note" role="note">{blocker}</p> : null}
    <div className="fm-content is-trash" ref={listRef} tabIndex={0} role="grid" aria-label="Trash contents" aria-multiselectable="true" onKeyDown={handleKey} onClick={() => select([])}>
      <div className="fm-list-head" role="row">
        {columns.map((column) => <button
          key={column.key}
          type="button"
          role="columnheader"
          className={`fm-col fm-col-${column.key === "deleted" ? "modified" : column.key === "location" ? "where" : column.key}${sort.key === column.key ? " is-sorted" : ""}`}
          aria-sort={sort.key === column.key ? (sort.ascending ? "ascending" : "descending") : "none"}
          onMouseDown={(event) => { event.preventDefault(); listRef.current?.focus({ preventScroll: true }); }}
          onClick={(event) => { event.stopPropagation(); setSort(nextTrashSort(sort, column.key)); }}
        >
          <span>{column.label}</span>
          {sort.key === column.key ? (sort.ascending ? <ChevronUp16Regular className="fm-sort-arrow" /> : <ChevronDown16Regular className="fm-sort-arrow" />) : null}
        </button>)}
      </div>
      {loadError && !listing ? <div className="fm-empty">
        <span className="fm-empty-text">{loadError}</span>
        <button type="button" className="fm-text-button" onClick={() => void load()}>Try Again</button>
      </div> : !listing ? <p className="fm-empty">Loading…</p>
        : empty ? <p className="fm-empty">{unavailable ? "No items found on the drives AmpleFile checked." : "The Trash is empty."}</p>
        : !shown.length ? <p className="fm-empty">No items in the Trash match “{query.trim()}”</p> : null}
      <div className="fm-rows" role="rowgroup">
        {shown.map((item, index) => {
          const entry: TreeEntry = { name: item.name, path: item.name, kind: item.kind === "folder" ? "folder" : "file" };
          const isSelected = selection.includes(item.id);
          const where = trashLocationText(item);
          return <div
            key={item.id}
            role="row"
            data-trash-id={item.id}
            aria-selected={isSelected}
            className={`fm-row${index % 2 ? " is-odd" : ""}${isSelected ? " is-selected" : ""}`}
            onClick={(event) => clickItem(item, event)}
            onDoubleClick={() => { if (item.canPutBack && listing?.putBackAvailable !== false) void putBack([item]); }}
          >
            <span role="gridcell" className="fm-cell fm-col-name">
              <span className="fm-row-icon"><EntryIcon entry={entry} /></span>
              <span className="fm-row-name" title={item.name}>{item.name}</span>
            </span>
            <span role="gridcell" className="fm-cell fm-col-where" title={item.originalPath ?? where}>{where}</span>
            <span role="gridcell" className="fm-cell fm-col-modified">{formatFileManagerDate(item.deletedAt ?? undefined)}</span>
            <span role="gridcell" className="fm-cell fm-col-size">{trashSizeText(item)}</span>
          </div>;
        })}
      </div>
      {unavailable ? <p className="fm-note" role="status">{unavailable} <button type="button" className="fm-text-button" onClick={() => void load()}>Try Again</button></p> : null}
      {listing?.truncated ? <p className="fm-note">The Trash holds more items than AmpleFile lists at once. Empty Trash also removes unlisted items on drives AmpleFile can check.</p> : null}
    </div>
  </div>;
}
