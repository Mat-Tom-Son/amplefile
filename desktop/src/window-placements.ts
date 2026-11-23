/**
 * Where each file manager window was on the screen, kept between launches in
 * `window-state.json`. Every window that was open when AmpleFile quit comes
 * back where it was; a window closed while others stayed open is forgotten;
 * the last window closed is kept, so the next one opens where it was. A new
 * window opens a step down and to the right of the window it came from, so
 * two windows never sit exactly on top of each other.
 *
 * The file used to hold one window's bounds as a plain object; that reads as
 * window 1.
 */
import { fitWindowToWorkArea } from "./window-bounds.js";

export interface WindowBounds { x: number; y: number; width: number; height: number }

export interface WindowPlacement extends WindowBounds {
  /** The window's slot (desktop/src/file-manager-windows.ts). */
  slot: number;
  isMaximized: boolean;
}

/** How far a new window is moved from the one it came from, and from any window already there. */
export const windowCascadeStep = 28;
/** At most this many windows are kept and restored. */
export const maximumRestoredWindows = 12;

function placementFrom(value: unknown, fallbackSlot: number): WindowPlacement | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const parts = [record.x, record.y, record.width, record.height];
  if (!parts.every((part) => typeof part === "number" && Number.isFinite(part))) return null;
  const slot = typeof record.slot === "number" && Number.isInteger(record.slot) && record.slot >= 1 ? record.slot : fallbackSlot;
  return {
    slot,
    x: Math.round(record.x as number),
    y: Math.round(record.y as number),
    width: Math.max(1, Math.round(record.width as number)),
    height: Math.max(1, Math.round(record.height as number)),
    isMaximized: record.isMaximized === true,
  };
}

/** The saved windows, by slot, from the file's parsed JSON; the one-window form is window 1. */
export function parseWindowPlacements(value: unknown): WindowPlacement[] {
  if (typeof value !== "object" || value === null) return [];
  const windows = (value as { windows?: unknown }).windows;
  if (!Array.isArray(windows)) {
    const single = placementFrom(value, 1);
    return single ? [{ ...single, slot: 1 }] : [];
  }
  const bySlot = new Map<number, WindowPlacement>();
  windows.forEach((entry, index) => {
    const placement = placementFrom(entry, index + 1);
    if (placement && !bySlot.has(placement.slot)) bySlot.set(placement.slot, placement);
  });
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot).slice(0, maximumRestoredWindows);
}

export function serializeWindowPlacements(placements: readonly WindowPlacement[]): string {
  const windows = [...placements].sort((a, b) => a.slot - b.slot).map(({ slot, x, y, width, height, isMaximized }) => ({ slot, x, y, width, height, isMaximized }));
  return `${JSON.stringify({ windows }, null, 2)}\n`;
}

/** The list with this window's placement saved (replacing what its slot had). */
export function savePlacement(placements: readonly WindowPlacement[], placement: WindowPlacement): WindowPlacement[] {
  return [...placements.filter((entry) => entry.slot !== placement.slot), placement].sort((a, b) => a.slot - b.slot);
}

/**
 * The list once a window closed. A window closed while others stay open is
 * forgotten; the last one keeps its place, so the next window opens there.
 * During Quit nothing is forgotten, so every open window comes back.
 */
export function placementsAfterClose(placements: readonly WindowPlacement[], slot: number, rule: { quitting: boolean; othersOpen: number }): WindowPlacement[] {
  if (rule.quitting || rule.othersOpen <= 0) return [...placements];
  return placements.filter((entry) => entry.slot !== slot);
}

/**
 * Which saved windows to open at launch, or when a window comes back after
 * the last one closed: every saved window, or window 1 at its default place
 * when nothing was saved.
 */
export function placementsToRestore(placements: readonly WindowPlacement[]): WindowPlacement[] {
  return [...placements].sort((a, b) => a.slot - b.slot);
}

/**
 * Bounds for a new window: a step down and right of `from`, moved again while
 * another window already starts there, and kept on the work area (back to its
 * top left when a step would leave it).
 */
export function cascadeBounds(
  from: WindowBounds,
  taken: readonly WindowBounds[],
  workArea: WindowBounds,
  minimum: Pick<WindowBounds, "width" | "height">,
  step = windowCascadeStep,
): WindowBounds {
  const size = fitWindowToWorkArea({ ...from }, workArea, minimum);
  const occupied = (x: number, y: number) => taken.some((bounds) => Math.abs(bounds.x - x) < step / 2 && Math.abs(bounds.y - y) < step / 2);
  let x = from.x + step;
  let y = from.y + step;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    if (x + size.width > workArea.x + workArea.width || y + size.height > workArea.y + workArea.height) {
      // Start again at the work area's top left, one step further in each round.
      const round = Math.floor(attempt / 8) + 1;
      x = workArea.x + step * round;
      y = workArea.y + step * round;
      if (x + size.width > workArea.x + workArea.width || y + size.height > workArea.y + workArea.height) {
        x = workArea.x;
        y = workArea.y;
      }
    }
    if (!occupied(x, y)) break;
    x += step;
    y += step;
  }
  return fitWindowToWorkArea({ x, y, width: size.width, height: size.height }, workArea, minimum);
}

/**
 * Saved windows that would open exactly on top of one opened before them
 * move a step, so every restored window can be seen.
 */
export function separateRestoredPlacements(
  placements: readonly WindowPlacement[],
  workAreaFor: (bounds: WindowBounds) => WindowBounds,
  minimum: Pick<WindowBounds, "width" | "height">,
): WindowPlacement[] {
  const placed: WindowPlacement[] = [];
  for (const placement of placementsToRestore(placements)) {
    const collides = placed.some((other) => other.x === placement.x && other.y === placement.y);
    if (!collides) {
      placed.push(placement);
      continue;
    }
    const bounds = cascadeBounds(placement, placed, workAreaFor(placement), minimum);
    placed.push({ ...placement, ...bounds });
  }
  return placed;
}
