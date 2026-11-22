import type { TreeEntry } from "../../types";
import { fileKindLabel } from "./file-manager-model";

/**
 * Pure helpers for how the file manager window lays out and handles a
 * folder's items (docs/product-model.md, "The file manager window"): which
 * rows a scrolled list draws, which items a selection rectangle covers, what
 * a drag carries, how a link and a hidden item read, and the Show Hidden
 * Files key. Kept free of React and the DOM so tests can cover them directly.
 */

/** Folders at or below this many items draw every row; larger ones draw only the rows in view. */
export const fullyDrawnItemLimit = 300;
/** Rows drawn past each edge of the view, so a quick scroll never shows a gap. */
export const windowOverscan = 8;
/**
 * What a one-level listing asks for: the host's largest one-level bound, so
 * an ordinary large folder is complete (the listing still says when a folder
 * holds more).
 */
export const folderListingMaxEntries = 200_000;

/** A run of items, `end` exclusive. */
export interface ItemRange { start: number; end: number }

/**
 * The items a scrolled list draws: those whose band overlaps the view, plus
 * `overscan` on each side. `offset` is where the first item starts inside
 * the scrolled content; `itemSize` is one item's height (one row of tiles in
 * icon view, where `count` counts rows of tiles).
 */
export function visibleRange(input: { count: number; itemSize: number; offset: number; scrollTop: number; viewport: number; overscan?: number }): ItemRange {
  const { count, itemSize, offset, scrollTop, viewport } = input;
  const overscan = input.overscan ?? windowOverscan;
  if (count <= 0 || !(itemSize > 0)) return { start: 0, end: 0 };
  const top = scrollTop - offset;
  const start = clamp(Math.floor(top / itemSize) - overscan, 0, count);
  const end = clamp(Math.ceil((top + Math.max(0, viewport)) / itemSize) + overscan, 0, count);
  return { start, end: Math.max(start, end) };
}

/**
 * The indexes to draw: every one in a small folder, else the window, with
 * the item that has the keyboard kept too (a screen reader's active row must
 * exist even when it is scrolled away).
 */
export function drawnIndexes(count: number, range: ItemRange, keep: ReadonlyArray<number> = []): number[] {
  if (count <= fullyDrawnItemLimit) return Array.from({ length: count }, (_, index) => index);
  const drawn: number[] = [];
  for (let index = range.start; index < range.end; index += 1) drawn.push(index);
  for (const index of keep) {
    if (index >= 0 && index < count && (index < range.start || index >= range.end)) drawn.push(index);
  }
  return drawn.sort((left, right) => left - right);
}

/** Icon view's columns, as the grid's own `repeat(auto-fill, minmax(110px, 1fr))` would place them. */
export function gridColumns(width: number, tile = { minWidth: 110, gap: 6, padding: 32 }): number {
  if (!(width > 0)) return 1;
  return Math.max(1, Math.floor((width - tile.padding + tile.gap) / (tile.minWidth + tile.gap)));
}

/**
 * The scroll position that brings one item fully into view, or null when it
 * already is. `stickyTop` is what covers the top of the view (the list's
 * column headings).
 */
export function revealScrollTop(input: { index: number; itemSize: number; offset: number; scrollTop: number; viewport: number; stickyTop?: number; itemHeight?: number }): number | null {
  const { index, itemSize, offset, scrollTop, viewport } = input;
  if (index < 0 || !(itemSize > 0)) return null;
  const stickyTop = input.stickyTop ?? 0;
  const top = offset + index * itemSize;
  const bottom = top + (input.itemHeight ?? itemSize);
  if (top - stickyTop < scrollTop) return Math.max(0, top - stickyTop);
  if (viewport > 0 && bottom > scrollTop + viewport) return bottom - viewport;
  return null;
}

/** A selection rectangle in the scrolled content's coordinates. */
export interface BandRect { left: number; top: number; right: number; bottom: number }

/** The rectangle between where a drag started and where the pointer is now. */
export function bandRect(start: { x: number; y: number }, current: { x: number; y: number }): BandRect {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    right: Math.max(start.x, current.x),
    bottom: Math.max(start.y, current.y),
  };
}

/** Where a list's rows sit: one row per item from `offset` down, spanning `left` to `right`. */
export interface ListGeometry { kind: "list"; count: number; offset: number; itemSize: number; left: number; right: number }
/** Where icon view's tiles sit: `columns` to a row of tiles, each `columnWidth` wide and `tileHeight` tall. */
export interface GridGeometry { kind: "grid"; count: number; offset: number; rowSize: number; tileHeight: number; columns: number; columnWidth: number; gap: number; left: number }

/**
 * The items a selection rectangle touches, by index, in shown order. It works
 * from the layout, not from drawn rows, so items scrolled out of the drawn
 * range still count.
 */
export function bandHits(rect: BandRect, geometry: ListGeometry | GridGeometry): number[] {
  if (geometry.count <= 0) return [];
  if (geometry.kind === "list") {
    if (rect.right < geometry.left || rect.left > geometry.right || !(geometry.itemSize > 0)) return [];
    const start = clamp(Math.floor((rect.top - geometry.offset) / geometry.itemSize), 0, geometry.count);
    const end = clamp(Math.floor((rect.bottom - geometry.offset) / geometry.itemSize) + 1, 0, geometry.count);
    if (rect.bottom < geometry.offset) return [];
    return range(start, end);
  }
  const { columns, columnWidth, gap, rowSize, tileHeight, offset, left } = geometry;
  if (!(rowSize > 0) || !(columnWidth > 0) || columns < 1) return [];
  const rows = Math.ceil(geometry.count / columns);
  const step = columnWidth + gap;
  const hits: number[] = [];
  const firstRow = clamp(Math.floor((rect.top - offset) / rowSize), 0, rows);
  const lastRow = clamp(Math.floor((rect.bottom - offset) / rowSize), -1, rows - 1);
  const firstColumn = clamp(Math.floor((rect.left - left) / step), 0, columns);
  const lastColumn = clamp(Math.floor((rect.right - left) / step), -1, columns - 1);
  for (let row = firstRow; row <= lastRow; row += 1) {
    const rowTop = offset + row * rowSize;
    if (rect.bottom < rowTop || rect.top > rowTop + tileHeight) continue;
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const columnLeft = left + column * step;
      if (rect.right < columnLeft || rect.left > columnLeft + columnWidth) continue;
      const index = row * columns + column;
      if (index < geometry.count) hits.push(index);
    }
  }
  return hits;
}

/**
 * The selection a rectangle makes: the items it touches, or with Shift or
 * Command (Ctrl) those added to what was selected when the drag began.
 */
export function bandSelection(order: readonly string[], hits: readonly number[], base: readonly string[], additive: boolean): string[] {
  const touched = hits.map((index) => order[index]).filter((path): path is string => path !== undefined);
  if (!additive) return touched;
  const kept = new Set(base);
  return [...base, ...touched.filter((path) => !kept.has(path))];
}

/** An item that can leave the list by dragging: not a Connected Folder nested here, and not a symbolic link. */
export function isDraggableEntry(entry: TreeEntry): boolean {
  return !entry.nestedFolder && !entry.link;
}

/**
 * What a drag that starts on `entry` carries: the whole selection when the
 * item is selected (in the order it was selected), just the item otherwise.
 * Items that cannot be dragged are left out.
 */
export function dragPayload(entry: TreeEntry, selection: readonly string[], byPath: ReadonlyMap<string, TreeEntry>): TreeEntry[] {
  if (!selection.includes(entry.path)) return isDraggableEntry(entry) ? [entry] : [];
  if (!isDraggableEntry(entry)) return [];
  return selection.map((path) => byPath.get(path)).filter((item): item is TreeEntry => Boolean(item) && isDraggableEntry(item!));
}

/**
 * Whether dragged items can be dropped into `target` (a folder path in the
 * same place, "" for its top): never into one of themselves or a folder
 * inside one of them.
 */
export function canDropInto(target: string, dragged: readonly string[]): boolean {
  return !dragged.some((path) => target === path || target.startsWith(`${path}/`));
}

/** The Kind column for a symbolic link: what it points to, or that it is broken. */
export function linkKindLabel(link: NonNullable<TreeEntry["link"]>): string {
  if (link.target === "missing") return "Broken Link";
  if (link.target === "folder") return "Link to Folder";
  const name = link.targetPath.slice(Math.max(link.targetPath.lastIndexOf("/"), link.targetPath.lastIndexOf("\\")) + 1);
  return `Link to ${fileKindLabel({ kind: "file", name })}`;
}

/**
 * Whether a name is one the system file manager hides: the window marks one
 * so in a listing it read without the host's marker (the preview's sample
 * folders). The host's `hidden` marker is the authority everywhere else.
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".") || name === "Icon\r";
}

/** The items a folder shows: hidden ones only while Show Hidden Files is on. */
export function shownEntries(entries: readonly TreeEntry[], showHidden: boolean): readonly TreeEntry[] {
  return showHidden ? entries : entries.filter((entry) => !entry.hidden);
}

/**
 * Show Hidden Files' key, as the system file manager has it: Shift-Command-
 * Period on a Mac, Ctrl+H elsewhere.
 */
export function isShowHiddenFilesKey(event: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean): boolean {
  if (event.altKey) return false;
  if (mac) return event.metaKey && event.shiftKey && !event.ctrlKey && (event.code === "Period" || event.key === "." || event.key === ">");
  return event.ctrlKey && !event.metaKey && !event.shiftKey && (event.code === "KeyH" || event.key === "h" || event.key === "H");
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let index = start; index < end; index += 1) out.push(index);
  return out;
}
