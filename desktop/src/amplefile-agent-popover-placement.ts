/**
 * Where the AmpleFile Agent popover opens. Pure geometry over Electron's
 * screen data (DIP rectangles), so it is unit-tested without a display.
 *
 * macOS and Windows anchor to the tray icon: under a menu-bar icon, above a
 * taskbar tray, centered on the primary display without one. Linux usually
 * has no tray geometry (a StatusNotifierItem reports none, so getBounds() is
 * all zeros), and on Wayland, XWayland included, the global pointer position
 * is not reliable after a click in another client such as the panel's tray
 * menu. So on Linux the popover anchors to what asked for it:
 *
 * - the AmpleFile window (View → AmpleFile Agent, a draft sent from the
 *   window): inside its top-right corner, just under the title bar;
 * - a tray click with real tray geometry: as on the other platforms;
 * - a tray click without geometry: the pointer when it is trustworthy (an
 *   X11 session), else the work-area corner nearest the desktop's panel, on
 *   the display of the AmpleFile window or of the pointer.
 *
 * The result always lies inside one display's work area, shrunk to fit a
 * small or heavily scaled display.
 */

export interface PopoverRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoverPoint {
  x: number;
  y: number;
}

export interface PopoverDisplay {
  bounds: PopoverRect;
  workArea: PopoverRect;
}

export type PopoverAnchor =
  /** The tray icon was clicked (or its menu used); bounds may be empty. */
  | { kind: "tray"; trayBounds: PopoverRect | null }
  /** An AmpleFile window asked; null when there is no window to anchor to. */
  | { kind: "window"; windowBounds: PopoverRect | null };

export interface PopoverPlacementInput {
  platform: NodeJS.Platform;
  anchor: PopoverAnchor;
  size: { width: number; height: number };
  displays: PopoverDisplay[];
  primary: PopoverDisplay;
  /** The pointer, or null when the platform cannot report it reliably. */
  cursor: PopoverPoint | null;
  /** The main AmpleFile window, when one exists; picks the display without a better anchor. */
  appWindowBounds: PopoverRect | null;
}

export const popoverEdgeGap = 6;
/** Matches the Linux and Windows title bar height in main.ts. */
export const popoverTitleBarHeight = 40;
const popoverWindowInset = 12;

function usable(rect: PopoverRect | null): rect is PopoverRect {
  return Boolean(rect && rect.width > 0 && rect.height > 0 && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite));
}

function contains(rect: PopoverRect, point: PopoverPoint): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function distanceToRect(rect: PopoverRect, point: PopoverPoint): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/** Electron's getDisplayNearestPoint. */
export function displayNearestPoint(displays: PopoverDisplay[], primary: PopoverDisplay, point: PopoverPoint): PopoverDisplay {
  const containing = displays.find((display) => contains(display.bounds, point));
  if (containing) return containing;
  let best = primary;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const display of displays) {
    const distance = distanceToRect(display.bounds, point);
    if (distance < bestDistance) { best = display; bestDistance = distance; }
  }
  return best;
}

/** Electron's getDisplayMatching: the display with the largest overlap, else the nearest. */
export function displayMatching(displays: PopoverDisplay[], primary: PopoverDisplay, rect: PopoverRect): PopoverDisplay {
  let best: PopoverDisplay | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const width = Math.min(rect.x + rect.width, display.bounds.x + display.bounds.width) - Math.max(rect.x, display.bounds.x);
    const height = Math.min(rect.y + rect.height, display.bounds.y + display.bounds.height) - Math.max(rect.y, display.bounds.y);
    const area = width > 0 && height > 0 ? width * height : 0;
    if (area > bestArea) { best = display; bestArea = area; }
  }
  return best ?? displayNearestPoint(displays, primary, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
}

type PanelEdge = "top" | "bottom" | "left" | "right";

/** The edge where the desktop reserves the most space (its panel), or null with none. */
export function panelEdge(display: PopoverDisplay): PanelEdge | null {
  const { bounds, workArea } = display;
  const reserved: Array<[PanelEdge, number]> = [
    ["top", workArea.y - bounds.y],
    ["bottom", bounds.y + bounds.height - (workArea.y + workArea.height)],
    ["left", workArea.x - bounds.x],
    ["right", bounds.x + bounds.width - (workArea.x + workArea.width)],
  ];
  const [edge, size] = reserved.reduce((best, next) => next[1] > best[1] ? next : best);
  return size > 0 ? edge : null;
}

/** Clamps a rectangle of the given size into the work area, shrinking it when it cannot fit. */
function clampIntoWorkArea(position: PopoverPoint, size: { width: number; height: number }, area: PopoverRect): PopoverRect {
  const gap = popoverEdgeGap;
  const width = Math.max(1, Math.min(size.width, area.width - 2 * gap));
  const height = Math.max(1, Math.min(size.height, area.height - 2 * gap));
  const minX = area.x + Math.min(gap, Math.max(0, (area.width - width) / 2));
  const minY = area.y + Math.min(gap, Math.max(0, (area.height - height) / 2));
  const maxX = Math.max(minX, area.x + area.width - width - gap);
  const maxY = Math.max(minY, area.y + area.height - height - gap);
  // Fractional DIPs (125% scaling) round inward so the edge never crosses the work area.
  const x = Math.min(Math.max(Math.round(position.x), Math.ceil(minX)), Math.floor(maxX));
  const y = Math.min(Math.max(Math.round(position.y), Math.ceil(minY)), Math.floor(maxY));
  return { x, y, width: Math.floor(width), height: Math.floor(height) };
}

/** The pre-existing macOS/Windows rule, unchanged. */
function trayPlacement(anchor: PopoverRect | null, size: { width: number; height: number }, displays: PopoverDisplay[], primary: PopoverDisplay): PopoverRect {
  const display = anchor
    ? displayNearestPoint(displays, primary, { x: anchor.x + Math.round(anchor.width / 2), y: anchor.y + Math.round(anchor.height / 2) })
    : primary;
  const area = display.workArea;
  if (!anchor || (anchor.width === 0 && anchor.height === 0)) {
    return {
      x: area.x + Math.round((area.width - size.width) / 2),
      y: area.y + Math.round((area.height - size.height) / 3),
      ...size,
    };
  }
  let x = anchor.x + Math.round(anchor.width / 2) - Math.round(size.width / 2);
  x = Math.min(Math.max(x, area.x + popoverEdgeGap), area.x + area.width - size.width - popoverEdgeGap);
  const anchorCenterY = anchor.y + anchor.height / 2;
  const below = anchorCenterY < area.y + area.height / 2;
  const y = below
    ? Math.min(anchor.y + anchor.height + popoverEdgeGap, area.y + area.height - size.height - popoverEdgeGap)
    : Math.max(anchor.y - size.height - popoverEdgeGap, area.y + popoverEdgeGap);
  return { x, y, ...size };
}

/** The work-area corner nearest the panel; the top-right corner without a panel. */
function panelCornerPlacement(display: PopoverDisplay, size: { width: number; height: number }): PopoverRect {
  const area = display.workArea;
  const edge = panelEdge(display);
  const left = area.x;
  const right = area.x + area.width - size.width;
  const top = area.y;
  const bottom = area.y + area.height - size.height;
  const corner = edge === "bottom" ? { x: right, y: bottom } : edge === "left" ? { x: left, y: top } : { x: right, y: top };
  return clampIntoWorkArea(corner, size, area);
}

export function popoverPlacement(input: PopoverPlacementInput): PopoverRect {
  const { anchor, size, displays, primary } = input;
  if (input.platform !== "linux") {
    return trayPlacement(anchor.kind === "tray" ? anchor.trayBounds : null, size, displays, primary);
  }
  if (anchor.kind === "tray" && usable(anchor.trayBounds)) {
    const placed = trayPlacement(anchor.trayBounds, size, displays, primary);
    const display = displayNearestPoint(displays, primary, { x: anchor.trayBounds.x, y: anchor.trayBounds.y });
    return clampIntoWorkArea(placed, size, display.workArea);
  }
  if (anchor.kind === "window" && usable(anchor.windowBounds)) {
    const window = anchor.windowBounds;
    const display = displayMatching(displays, primary, window);
    const position = {
      x: window.x + window.width - size.width - popoverWindowInset,
      y: window.y + popoverTitleBarHeight + popoverEdgeGap,
    };
    return clampIntoWorkArea(position, size, display.workArea);
  }
  if (anchor.kind === "tray" && input.cursor) {
    // The pointer is on (or in a menu next to) the panel: open beside it,
    // away from the panel, as a panel applet's popup does.
    const display = displayNearestPoint(displays, primary, input.cursor);
    const area = display.workArea;
    const edge = panelEdge(display);
    const position = { x: input.cursor.x - size.width / 2, y: input.cursor.y + popoverEdgeGap };
    if (edge === "bottom" || (!edge && input.cursor.y > area.y + area.height / 2)) position.y = input.cursor.y - size.height - popoverEdgeGap;
    if (edge === "left") position.x = input.cursor.x + popoverEdgeGap;
    if (edge === "right") position.x = input.cursor.x - size.width - popoverEdgeGap;
    if (edge === "left" || edge === "right") position.y = input.cursor.y - size.height / 2;
    return clampIntoWorkArea(position, size, area);
  }
  const display = usable(input.appWindowBounds)
    ? displayMatching(displays, primary, input.appWindowBounds)
    : input.cursor ? displayNearestPoint(displays, primary, input.cursor) : primary;
  return panelCornerPlacement(display, size);
}

/**
 * Whether the pointer position Electron reports is global and current. Only
 * an X11 session qualifies: under Wayland, XWayland only learns the pointer
 * while it is over an X11 window, and native Wayland clients see it only over
 * their own surfaces, so a click in the panel's tray menu leaves a stale point.
 */
export function linuxCursorIsReliable(env: NodeJS.ProcessEnv): boolean {
  if (env.WAYLAND_DISPLAY?.trim() || env.WAYLAND_SOCKET?.trim()) return false;
  const session = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (session === "wayland") return false;
  return Boolean(env.DISPLAY?.trim());
}
