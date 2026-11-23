import { sameLocation, type FileManagerLocation } from "./file-manager-places";

/** Where a folder view is, and where Back and Forward go. */
export interface FolderHistory {
  location: FileManagerLocation;
  back: FileManagerLocation[];
  forward: FileManagerLocation[];
}

/** A folder view that has been nowhere else yet. */
export function freshHistory(location: FileManagerLocation): FolderHistory {
  return { location, back: [], forward: [] };
}

/** Going somewhere new: the folder left joins Back, and Forward is cleared. Going where the view already is changes nothing. */
export function pushLocation(history: FolderHistory, next: FileManagerLocation): FolderHistory {
  if (sameLocation(next, history.location)) return history;
  return { location: next, back: [...history.back, history.location], forward: [] };
}

/** Back: the last folder left, with the one shown joining Forward. Null when there is nowhere to go back to. */
export function stepBack(history: FolderHistory): FolderHistory | null {
  const previous = history.back.at(-1);
  if (!previous) return null;
  return { location: previous, back: history.back.slice(0, -1), forward: [history.location, ...history.forward] };
}

/** Forward: the folder Back left, with the one shown joining Back. Null when there is nowhere to go forward to. */
export function stepForward(history: FolderHistory): FolderHistory | null {
  const next = history.forward[0];
  if (!next) return null;
  return { location: next, back: [...history.back, history.location], forward: history.forward.slice(1) };
}
