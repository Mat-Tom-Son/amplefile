/**
 * Where a browser page shows. The desktop host draws the page as its own
 * view above everything the window draws, over a placeholder element here. So
 * the window measures the placeholder, and whenever one of its own overlays
 * (a dialog, a menu, a notice) would sit across the page, it asks the host to
 * step the page aside for as long as the overlay is there.
 */

export interface NativeViewBounds { x: number; y: number; width: number; height: number }

/** The placeholder's inner box, in the window's CSS pixels. */
export function nativeViewBounds(element: HTMLElement, box: DOMRect = element.getBoundingClientRect()): NativeViewBounds {
  const style = getComputedStyle(element);
  const left = box.left + pixels(style.borderLeftWidth);
  const top = box.top + pixels(style.borderTopWidth);
  const right = box.right - pixels(style.borderRightWidth);
  const bottom = box.bottom - pixels(style.borderBottomWidth);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

/**
 * What the window draws over other content: every dialog and sheet, the
 * in-window menus, notices, and anything that names itself with
 * `data-native-view-occluder` (the address bar's suggestions, a site's menu).
 */
const occluderSelector = [
  "[data-native-view-occluder='true']",
  ".modal-backdrop",
  ".context-menu",
  ".toast",
  ".fm-goto",
  "[role='menu']",
  "[role='dialog']",
].join(",");

/** True while one of the window's overlays crosses the placeholder's box. */
export function nativeViewOccluded(element: HTMLElement, box: DOMRect = element.getBoundingClientRect()): boolean {
  for (const candidate of element.ownerDocument.querySelectorAll<HTMLElement>(occluderSelector)) {
    if (candidate === element || candidate.contains(element) || element.contains(candidate)) continue;
    // A leaving copy (lib/motion.ts) is still drawn until its exit ends.
    const style = getComputedStyle(candidate);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const other = candidate.getBoundingClientRect();
    if (other.width <= 0 || other.height <= 0) continue;
    if (other.right > box.left && other.left < box.right && other.bottom > box.top && other.top < box.bottom) return true;
  }
  return false;
}
