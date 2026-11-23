import { useEffect, useRef, type Dispatch, type MouseEvent, type MutableRefObject, type RefObject, type SetStateAction } from "react";

import type { TreeEntry } from "../../types";
import { rangeSelection, type FileManagerView as FileManagerViewMode } from "./file-manager-model";
import { bandHits, bandRect, bandSelection, revealScrollTop } from "./file-manager-layout";
import { cssEscape } from "./file-manager-view-helpers";
import type { EntriesLayout } from "./FileEntries";

export interface FileSelectionContext {
  mac: boolean;
  view: FileManagerViewMode;
  selection: readonly string[];
  setSelection: Dispatch<SetStateAction<string[]>>;
  selected: ReadonlySet<string>;
  /** The shown items' paths, in shown order. */
  order: readonly string[];
  byPath: ReadonlyMap<string, TreeEntry>;
  /** The folder list, which scrolls. */
  contentRef: RefObject<HTMLDivElement | null>;
  /** Where the drawn items are, as FileEntries last published it. */
  entriesLayoutRef: MutableRefObject<EntriesLayout | null>;
  /** The list shows the folder's items (not search results or Recents), ready, with something in it: a rectangle can start. */
  bandAllowed: boolean;
  /** Changes when the folder shown or the view changes: a rectangle never outlives the folder it was drawn in. */
  folderKey: string;
}

/**
 * The selection in the folder list: clicks with Shift and Command (Ctrl),
 * scrolling an item into view, and the selection rectangle. The selection
 * itself is the caller's, so it can belong to whatever holds the folder shown.
 */
export function useFileSelection(context: FileSelectionContext) {
  const { mac, view, selection, setSelection, selected, order, byPath, contentRef, entriesLayoutRef, bandAllowed, folderKey } = context;
  const anchorRef = useRef<string | null>(null);
  const indexByPathRef = useRef<ReadonlyMap<string, number>>(new Map());
  // A Map per render is cheap next to the list; the ref keeps the latest for scrolling.
  indexByPathRef.current = useIndexByPath(order);

  function select(paths: string[], anchor = paths.at(-1) ?? null) {
    setSelection(paths);
    anchorRef.current = anchor;
    const last = paths.at(-1);
    if (last) window.requestAnimationFrame(() => revealPath(last));
  }

  /**
   * Scrolls an item into view. A large folder draws only the rows in view, so
   * this works from the layout rather than from the item's row, which may not
   * be drawn yet.
   */
  function revealPath(path: string) {
    const scroller = contentRef.current;
    const layout = entriesLayoutRef.current;
    const index = indexByPathRef.current.get(path);
    if (!scroller || !layout || index === undefined) {
      scroller?.querySelector<HTMLElement>(`[data-fm-path="${cssEscape(path)}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    const target = layout.kind === "list"
      ? revealScrollTop({ index, itemSize: layout.itemSize, offset: layout.offset, scrollTop: scroller.scrollTop, viewport: scroller.clientHeight, stickyTop: layout.stickyTop })
      : revealScrollTop({ index: Math.floor(index / layout.columns), itemSize: layout.rowSize, itemHeight: layout.tileHeight, offset: layout.offset, scrollTop: scroller.scrollTop, viewport: scroller.clientHeight });
    if (target !== null) scroller.scrollTop = target;
  }

  function clickEntry(entry: TreeEntry, event: MouseEvent<HTMLElement>) {
    // The click that ends a selection rectangle is not a click on the row it ended over.
    if (bandJustEnded()) return;
    contentRef.current?.focus({ preventScroll: true });
    const toggle = mac ? event.metaKey : event.ctrlKey;
    if (event.shiftKey) { select(rangeSelection(order, anchorRef.current, entry.path), anchorRef.current ?? entry.path); return; }
    if (toggle) {
      const next = selected.has(entry.path) ? selection.filter((path) => path !== entry.path) : [...selection, entry.path];
      select(next, entry.path);
      return;
    }
    select([entry.path]);
  }

  // ---- The selection rectangle ----
  // Dragging from empty space (or, in the list, from a row outside its icon
  // and name, as in Finder) draws a rectangle that selects what it touches;
  // Shift or Command (Ctrl) adds to the selection. It works from the layout,
  // so rows scrolled out of the drawn range still count, and the list scrolls
  // while the pointer is near its top or bottom edge.
  const bandRef = useRef<HTMLDivElement | null>(null);
  const bandStateRef = useRef<{ start: { x: number; y: number }; client: { x: number; y: number }; base: string[]; additive: boolean; active: boolean; hits: string; frame: number | null } | null>(null);
  const bandEndedRef = useRef(0);
  const bandJustEnded = () => Date.now() - bandEndedRef.current < 80;

  function contentPoint(client: { x: number; y: number }): { x: number; y: number } {
    const scroller = contentRef.current!;
    const box = scroller.getBoundingClientRect();
    return { x: client.x - box.left + scroller.scrollLeft, y: client.y - box.top + scroller.scrollTop };
  }

  function startBand(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !bandAllowed) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a[href], input, textarea, select, [contenteditable='true'], .fm-list-head")) return;
    const row = target.closest<HTMLElement>("[data-fm-path]");
    if (row && (view === "icons" || target.closest(".fm-row-icon, .fm-row-name"))) return;
    const scroller = contentRef.current;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    // A press on the scroll bar scrolls.
    if (scroller.clientWidth && event.clientX - box.left >= scroller.clientWidth) return;
    if (scroller.clientHeight && event.clientY - box.top >= scroller.clientHeight) return;
    // Nothing under the pointer starts its own drag, and no text is selected.
    event.preventDefault();
    scroller.focus({ preventScroll: true });
    const additive = event.shiftKey || (mac ? event.metaKey : event.ctrlKey);
    const client = { x: event.clientX, y: event.clientY };
    bandStateRef.current = { start: contentPoint(client), client, base: additive ? selection.filter((path) => byPath.has(path)) : [], additive, active: false, hits: "", frame: null };
  }

  const bandActionsRef = useRef<{ update: () => void; end: () => void }>({ update: () => undefined, end: () => undefined });
  bandActionsRef.current = {
    update: () => {
      const band = bandStateRef.current;
      const scroller = contentRef.current;
      if (!band || !scroller) return;
      const point = contentPoint(band.client);
      if (!band.active) {
        if (Math.abs(point.x - band.start.x) < 4 && Math.abs(point.y - band.start.y) < 4) return;
        band.active = true;
        band.frame = window.requestAnimationFrame(autoScrollBand);
      }
      const rect = bandRect(band.start, point);
      const drawn = bandRef.current;
      if (drawn) {
        drawn.style.display = "block";
        drawn.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
        drawn.style.width = `${rect.right - rect.left}px`;
        drawn.style.height = `${rect.bottom - rect.top}px`;
      }
      const layout = entriesLayoutRef.current;
      const hits = layout ? bandHits(rect, layout) : [];
      const key = hits.length ? `${hits[0]}:${hits.at(-1)}:${hits.length}` : "";
      if (key === band.hits) return;
      band.hits = key;
      const next = bandSelection(order, hits, band.base, band.additive);
      setSelection(next);
      anchorRef.current = next.at(-1) ?? null;
    },
    end: () => {
      const band = bandStateRef.current;
      bandStateRef.current = null;
      if (!band) return;
      if (band.frame !== null) window.cancelAnimationFrame(band.frame);
      if (bandRef.current) bandRef.current.style.display = "none";
      if (band.active) bandEndedRef.current = Date.now();
    },
  };

  /** While the pointer is near the top or bottom edge, the list scrolls under the rectangle, faster the further out it is. */
  function autoScrollBand() {
    const band = bandStateRef.current;
    const scroller = contentRef.current;
    if (!band || !band.active || !scroller) return;
    const box = scroller.getBoundingClientRect();
    // The visible band of the list: under the column headings, above any horizontal scroll bar.
    const top = box.top + (entriesLayoutRef.current?.stickyTop ?? 0);
    const bottom = box.top + scroller.clientHeight;
    const edge = 28;
    let step = 0;
    if (bottom - top > 2 * edge) {
      if (band.client.y < top + edge) step = -Math.min(40, Math.ceil((top + edge - band.client.y) / 2));
      else if (band.client.y > bottom - edge) step = Math.min(40, Math.ceil((band.client.y - (bottom - edge)) / 2));
    }
    if (step) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + step;
      if (scroller.scrollTop !== before) bandActionsRef.current.update();
    }
    band.frame = window.requestAnimationFrame(autoScrollBand);
  }

  useEffect(() => {
    const move = (event: globalThis.MouseEvent) => {
      const band = bandStateRef.current;
      if (!band) return;
      band.client = { x: event.clientX, y: event.clientY };
      bandActionsRef.current.update();
    };
    const up = () => { if (bandStateRef.current) bandActionsRef.current.end(); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); window.removeEventListener("blur", up); };
  }, []);
  // A rectangle never outlives the folder it was drawn in.
  useEffect(() => { bandActionsRef.current.end(); }, [folderKey]);

  return { anchorRef, select, revealPath, clickEntry, bandRef, startBand, bandJustEnded };
}

function useIndexByPath(order: readonly string[]): ReadonlyMap<string, number> {
  const memo = useRef<{ order: readonly string[]; map: ReadonlyMap<string, number> } | null>(null);
  if (memo.current?.order !== order) memo.current = { order, map: new Map(order.map((path, index) => [path, index])) };
  return memo.current.map;
}
