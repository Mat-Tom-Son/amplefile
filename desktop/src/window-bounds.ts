interface Bounds { x: number; y: number; width: number; height: number }

/** Preserve the chosen display while keeping the whole window on its work area. */
export function fitWindowToWorkArea<T extends Bounds>(state: T, workArea: Bounds, minimum: Pick<Bounds, "width" | "height">): T {
  const width = Math.min(Math.max(state.width, minimum.width), workArea.width);
  const height = Math.min(Math.max(state.height, minimum.height), workArea.height);
  return {
    ...state, width, height,
    x: Math.max(workArea.x, Math.min(state.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(state.y, workArea.y + workArea.height - height)),
  };
}
