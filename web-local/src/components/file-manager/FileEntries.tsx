import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type MutableRefObject, type RefObject } from "react";

import type { TreeEntry } from "../../types";
import { formatBytes } from "../../lib/format";
import type { ConnectedFolderIconOption } from "../../connected-folder-icons";
import { fileManagerIcon, formatFileManagerDate } from "./file-manager-model";
import { drawnIndexes, gridColumns, isDraggableEntry, visibleRange, type GridGeometry, type ListGeometry } from "./file-manager-layout";
import { TintedFolder } from "./file-manager-folder";
import { isMarkedPath } from "./useWorkerChanges";

/**
 * A folder's items in list or icon view (docs/product-model.md, "The file
 * manager window"). Every item has its place in the scrolled content, but a
 * large folder draws only the rows in view (and the one with the keyboard),
 * so 100,000 items open and scroll as quickly as a hundred. The layout it
 * draws is published in `layoutRef`, which the window reads to scroll an item
 * into view, step through icon view's rows, and hit-test a selection
 * rectangle over rows that are not drawn.
 */

export type FolderLook = { color: string; symbol: ConnectedFolderIconOption["Icon"] | null };

export interface EntryHandlers {
  click: (entry: TreeEntry, event: MouseEvent<HTMLElement>) => void;
  open: (entry: TreeEntry) => void;
  contextMenu: (entry: TreeEntry, event: MouseEvent<HTMLElement>) => void;
  dragStart: (entry: TreeEntry, event: DragEvent<HTMLElement>) => void;
}

/** Where the window's items are, in the scrolled content's coordinates. */
export type EntriesLayout = (ListGeometry & { stickyTop: number; itemHeight: number }) | (GridGeometry & { stickyTop: number; rows: number });

/** List rows are this tall until one is measured (the stylesheet's 26px at the default size). */
const defaultRowHeight = 26;
/** An icon tile until one is measured: its padding, icon, gap, and one line of name. */
const defaultTileHeight = 106;
const tileRowGap = 12;
const tileColumnGap = 6;
/** What a view whose height is not known yet (not laid out) is taken to show. */
const fallbackViewport = 1_000;

export function FileEntries({ view, entries, selected, focusPath, dropTarget, markedPaths, cutPaths = null, kindLabel, day, tintFor, handlers, scrollRef, layoutRef }: {
  view: "list" | "icons";
  entries: readonly TreeEntry[];
  selected: ReadonlySet<string>;
  /** The item with the keyboard: always drawn, so a screen reader's active row exists. */
  focusPath: string | null;
  dropTarget: string | null;
  markedPaths: ReadonlySet<string> | null;
  /** Items cut and not yet pasted: drawn dimmed. */
  cutPaths?: ReadonlySet<string> | null;
  kindLabel: (entry: TreeEntry) => string;
  day: string;
  tintFor: (entry: TreeEntry) => FolderLook | undefined;
  handlers: EntryHandlers;
  /** The scrolled contents (`.fm-content`), whose scroll and size choose what is drawn. */
  scrollRef: RefObject<HTMLDivElement | null>;
  layoutRef: MutableRefObject<EntriesLayout | null>;
}) {
  const viewport = useViewport(scrollRef);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(defaultRowHeight);
  const [tileHeight, setTileHeight] = useState(defaultTileHeight);
  const [frame, setFrame] = useState({ offset: 4, stickyTop: 0, inset: 16 });
  const count = entries.length;
  const focusIndex = useMemo(() => focusPath ? entries.findIndex((entry) => entry.path === focusPath) : -1, [entries, focusPath]);
  const height = viewport.height || fallbackViewport;

  const columns = view === "icons" ? gridColumns(viewport.width) : 1;
  const rows = view === "icons" ? Math.ceil(count / columns) : count;
  const itemSize = view === "icons" ? tileHeight + tileRowGap : rowHeight;
  const range = visibleRange({ count: rows, itemSize, offset: frame.offset, scrollTop: viewport.scrollTop, viewport: height });
  const drawn = drawnIndexes(rows, range, [view === "icons" ? Math.floor(focusIndex / columns) : focusIndex]);

  // Measure what the stylesheet made of a row, a tile, and the space above the first one, and publish the layout.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const scroller = scrollRef.current;
    if (!container || !scroller) return;
    const style = getComputedStyle(container);
    const offset = container.offsetTop + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
    const inset = parseFloat(style.paddingLeft) || (view === "icons" ? 16 : 8);
    const stickyTop = view === "list" ? scroller.querySelector<HTMLElement>(".fm-list-head")?.offsetHeight ?? 0 : 0;
    if (offset !== frame.offset || stickyTop !== frame.stickyTop || inset !== frame.inset) setFrame({ offset, stickyTop, inset });
    const first = container.firstElementChild as HTMLElement | null;
    const measured = first?.offsetHeight ?? 0;
    if (measured > 0 && view === "list" && Math.abs(measured - rowHeight) > 0.5) setRowHeight(measured);
    if (measured > 0 && view === "icons" && Math.abs(measured - tileHeight) > 0.5) setTileHeight(measured);
    const width = container.clientWidth - 2 * inset;
    layoutRef.current = view === "list"
      ? { kind: "list", count, offset, itemSize: rowHeight, itemHeight: rowHeight, left: inset, right: inset + Math.max(0, width), stickyTop }
      : { kind: "grid", count, offset, rowSize: tileHeight + tileRowGap, tileHeight, columns, columnWidth: Math.max(0, (width - (columns - 1) * tileColumnGap) / columns), gap: tileColumnGap, left: inset, stickyTop: 0, rows };
  });
  useEffect(() => () => { layoutRef.current = null; }, [layoutRef]);

  // Screen readers hear how many rows the whole folder has, not how many are drawn.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.setAttribute("aria-rowcount", String(view === "list" ? count + 1 : rows));
    if (view === "icons") scroller.setAttribute("aria-colcount", String(columns));
    else scroller.removeAttribute("aria-colcount");
    return () => { scroller.removeAttribute("aria-rowcount"); scroller.removeAttribute("aria-colcount"); };
  }, [scrollRef, view, count, rows, columns]);

  if (view === "list") {
    return <div className="fm-rows is-placed" role="rowgroup" ref={containerRef} style={{ height: count * rowHeight }}>
      {drawn.map((index) => {
        const entry = entries[index]!;
        const tint = tintFor(entry);
        return <FileRow
          key={entry.path}
          entry={entry}
          index={index}
          top={index * rowHeight}
          selected={selected.has(entry.path)}
          dropTarget={dropTarget === entry.path}
          marked={Boolean(markedPaths && isMarkedPath(entry.path, markedPaths))}
          cut={Boolean(cutPaths?.has(entry.path))}
          kind={kindLabel(entry)}
          day={day}
          tintColor={tint?.color}
          tintSymbol={tint?.symbol}
          handlers={handlers}
        />;
      })}
    </div>;
  }
  const rowSize = tileHeight + tileRowGap;
  return <div className="fm-grid" ref={containerRef} style={{ height: rows ? rows * rowSize - tileRowGap : 0 }}>
    {drawn.map((row) => <div
      key={row}
      role="row"
      aria-rowindex={row + 1}
      className="fm-grid-row"
      style={{ transform: `translateY(${row * rowSize}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {entries.slice(row * columns, row * columns + columns).map((entry, column) => {
        const tint = tintFor(entry);
        return <FileTile
          key={entry.path}
          entry={entry}
          column={column}
          selected={selected.has(entry.path)}
          dropTarget={dropTarget === entry.path}
          marked={Boolean(markedPaths && isMarkedPath(entry.path, markedPaths))}
          cut={Boolean(cutPaths?.has(entry.path))}
          tintColor={tint?.color}
          tintSymbol={tint?.symbol}
          handlers={handlers}
        />;
      })}
    </div>)}
  </div>;
}

/** The scrolled contents' scroll position and size, read at most once a frame. */
function useViewport(scrollRef: RefObject<HTMLDivElement | null>): { scrollTop: number; height: number; width: number } {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0, width: 0 });
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame: number | null = null;
    const read = () => {
      frame = null;
      setViewport((current) => {
        const next = { scrollTop: scroller.scrollTop, height: scroller.clientHeight, width: scroller.clientWidth };
        return current.scrollTop === next.scrollTop && current.height === next.height && current.width === next.width ? current : next;
      });
    };
    const schedule = () => { if (frame === null) frame = window.requestAnimationFrame(read); };
    read();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [scrollRef]);
  return viewport;
}

export function rowDomId(path: string): string {
  return `fm-item-${encodeURIComponent(path).replace(/%/g, "_")}`;
}

function sizeText(entry: TreeEntry): string {
  if (entry.kind === "folder") return "--";
  return typeof entry.sizeBytes === "number" ? formatBytes(entry.sizeBytes) : "--";
}

/** An item's icon; a symbolic link carries the system's small arrow badge. */
export function EntryIcon({ entry, tint }: { entry: TreeEntry; tint?: FolderLook }) {
  const icon = entry.kind === "folder" && tint ? <TintedFolder color={tint.color} symbol={tint.symbol} /> : <EntryGlyph entry={entry} />;
  if (!entry.link) return icon;
  return <span className={`fm-link-icon${entry.link.target === "missing" ? " is-broken" : ""}`}>
    {icon}
    <svg className="fm-link-badge" viewBox="0 0 12 12" aria-hidden="true"><rect x="0.5" y="0.5" width="11" height="11" rx="2.5" /><path d="M4 8.2 8 4.2M5 4h3.2v3.2" /></svg>
  </span>;
}

function EntryGlyph({ entry }: { entry: TreeEntry }) {
  const icon = fileManagerIcon(entry);
  return <span className={icon.className} data-label={icon.label} aria-hidden="true" />;
}

interface EntryViewProps {
  entry: TreeEntry;
  selected: boolean;
  dropTarget: boolean;
  /** Changed by the Worker's last reply. */
  marked: boolean;
  /** Cut and not yet pasted. */
  cut: boolean;
  tintColor?: string;
  tintSymbol?: FolderLook["symbol"];
  handlers: EntryHandlers;
}

function entryTint(color: string | undefined, symbol: FolderLook["symbol"] | undefined): FolderLook | undefined {
  return color === undefined ? undefined : { color, symbol: symbol ?? null };
}

function entryClasses(entry: TreeEntry, selected: boolean, dropTarget: boolean, cut = false): string {
  return `${selected ? " is-selected" : ""}${entry.ignored ? " is-ignored" : ""}${entry.hidden ? " is-hidden" : ""}${entry.link ? " is-link" : ""}${dropTarget ? " is-drop-target" : ""}${cut ? " is-cut" : ""}`;
}

const changedDot = <span className="fm-changed-dot" title="Changed by the Worker" aria-label="Changed by the Worker" role="img" />;

/** One list row; memoised, since a folder can show thousands. */
const FileRow = memo(function FileRow({ entry, index, top, selected, dropTarget, marked, cut, kind, tintColor, tintSymbol, handlers }: EntryViewProps & {
  index: number;
  top: number;
  kind: string;
  /** Today's date; a new day redraws the row's relative date. */
  day: string;
}) {
  return <div
    id={rowDomId(entry.path)}
    role="row"
    aria-rowindex={index + 2}
    aria-selected={selected}
    data-fm-path={entry.path}
    className={`fm-row${index % 2 === 1 ? " is-odd" : ""}${entryClasses(entry, selected, dropTarget, cut)}`}
    style={{ transform: `translateY(${top}px)` }}
    draggable={isDraggableEntry(entry)}
    onClick={(event) => handlers.click(entry, event)}
    onDoubleClick={() => handlers.open(entry)}
    onContextMenu={(event) => handlers.contextMenu(entry, event)}
    onDragStart={(event) => handlers.dragStart(entry, event)}
  >
    <span role="gridcell" className="fm-cell fm-col-name">
      <span className="fm-row-icon"><EntryIcon entry={entry} tint={entryTint(tintColor, tintSymbol)} /></span>
      <span className="fm-row-name" title={entry.link ? `${entry.name}\n${entry.link.target === "missing" ? "Broken link to" : "Link to"} ${entry.link.targetPath}` : entry.name}>{entry.name}</span>
      {marked ? changedDot : null}
    </span>
    <span role="gridcell" className="fm-cell fm-col-modified">{formatFileManagerDate(entry.updatedAt)}</span>
    <span role="gridcell" className="fm-cell fm-col-size">{sizeText(entry)}</span>
    <span role="gridcell" className="fm-cell fm-col-kind" title={kind}>{kind}</span>
  </div>;
});

/** One icon-view tile; memoised like FileRow. */
const FileTile = memo(function FileTile({ entry, column, selected, dropTarget, marked, cut, tintColor, tintSymbol, handlers }: EntryViewProps & { column: number }) {
  return <div
    id={rowDomId(entry.path)}
    role="gridcell"
    aria-colindex={column + 1}
    aria-selected={selected}
    data-fm-path={entry.path}
    className={`fm-tile${entryClasses(entry, selected, dropTarget, cut)}`}
    draggable={isDraggableEntry(entry)}
    onClick={(event) => handlers.click(entry, event)}
    onDoubleClick={() => handlers.open(entry)}
    onContextMenu={(event) => handlers.contextMenu(entry, event)}
    onDragStart={(event) => handlers.dragStart(entry, event)}
  >
    <span className="fm-tile-icon"><EntryIcon entry={entry} tint={entryTint(tintColor, tintSymbol)} /></span>
    <span className="fm-tile-name" title={entry.name}>{marked ? changedDot : null}{middleTruncate(entry.name)}</span>
  </div>;
});

/** Finder keeps both ends of a long name in icon view so the extension stays visible. */
function middleTruncate(name: string, limit = 22): string {
  if (name.length <= limit) return name;
  const tail = Math.min(8, Math.floor(limit / 2) - 1);
  return `${name.slice(0, limit - tail - 1)}…${name.slice(-tail)}`;
}
