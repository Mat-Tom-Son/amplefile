import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { useViewport } from "./FileEntries";
import { drawnIndexes, visibleRange } from "./file-manager-layout";
import type { FileManagerSearchResult } from "./useFileManagerSearch";

/** A result row is this tall until one is measured (the stylesheet's 26px at the default size). */
const defaultRowHeight = 26;
/** What a view whose height is not known yet (not laid out) is taken to show. */
const fallbackViewport = 1_000;

/**
 * Search results, placed by index as a folder's rows are (FileEntries): a
 * search that finds thousands of items draws only the rows in view, and the
 * chosen one, so results keep arriving and the list keeps scrolling quickly
 * however many there are.
 */
export function FileManagerSearchRows({ results, chosenKey, scrollRef, renderRow }: {
  results: readonly FileManagerSearchResult[];
  chosenKey: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** One row, moved down to `top` within the list. */
  renderRow: (result: FileManagerSearchResult, index: number, top: number) => ReactNode;
}) {
  const viewport = useViewport(scrollRef);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(defaultRowHeight);
  const [offset, setOffset] = useState(4);
  const count = results.length;
  const chosen = chosenKey ? results.findIndex((result) => result.key === chosenKey) : -1;
  const range = visibleRange({ count, itemSize: rowHeight, offset, scrollTop: viewport.scrollTop, viewport: viewport.height || fallbackViewport });
  const drawn = drawnIndexes(count, range, [chosen]);

  // Measure what the stylesheet made of a row and of the space above the first one.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const style = getComputedStyle(container);
    const top = container.offsetTop + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
    if (Math.abs(top - offset) > 0.5) setOffset(top);
    const measured = (container.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
    if (measured > 0 && Math.abs(measured - rowHeight) > 0.5) setRowHeight(measured);
  });

  // Screen readers hear how many results there are, not how many are drawn.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.setAttribute("aria-rowcount", String(count + 1));
    return () => scroller.removeAttribute("aria-rowcount");
  }, [scrollRef, count]);

  return <div className="fm-rows is-placed" role="rowgroup" ref={containerRef} style={{ height: count * rowHeight }}>
    {drawn.map((index) => renderRow(results[index]!, index, index * rowHeight))}
  </div>;
}
