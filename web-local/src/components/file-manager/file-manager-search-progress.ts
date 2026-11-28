import { fileManagerStatusText } from "./file-manager-model";

/**
 * Search finds everything (docs/product-model.md, "Search"): the host answers
 * a bounded page at a time, and the window asks for the next page itself until
 * the search reaches its end. It stops short only when the person presses
 * Stop, or after gathering `searchResultsPerRun` results, where it pauses and
 * offers Keep Searching so a runaway search ("e" across the whole disk) never
 * fills memory unasked.
 */

/** Why a search that has not reached its end is not running: the person stopped it, or it gathered a run's worth. */
export type SearchPause = "stopped" | "limit";

/** How many results one run gathers before it pauses: far more than a real search finds. */
export const searchResultsPerRun = 10_000;

export interface SearchProgress {
  status: "searching" | "done";
  paused: SearchPause | null;
  /** Results found so far. */
  found: number;
  /** Files whose text was read so far, when the search says. */
  scannedFiles?: number;
}

/** The note at the foot of the results while a search runs or after it paused, and what its button does; null when there is nothing to say. */
export function searchProgressNote(progress: SearchProgress): { text: string; action: "stop" | "continue" } | null {
  if (progress.status === "searching") {
    const files = progress.scannedFiles ?? 0;
    return { text: files > 0 ? `Searching… ${files.toLocaleString()} ${files === 1 ? "file" : "files"} read so far.` : "Searching…", action: "stop" };
  }
  if (progress.paused === "limit") return { text: `Found ${progress.found.toLocaleString()} matches so far, and there may be more.`, action: "continue" };
  if (progress.paused === "stopped") return { text: "Search stopped. There may be more matches.", action: "continue" };
  return null;
}

/** The path bar while searching: "Searching… 240 found", then "240 items", or "240+ items" when it stopped short of the end ("Search stopped" before it found any). */
export function searchStatusText(progress: SearchProgress, selected: number): string {
  if (progress.status === "searching") return progress.found ? `Searching… ${progress.found.toLocaleString()} found` : "Searching…";
  if (progress.paused && !progress.found) return "Search stopped";
  return fileManagerStatusText(progress.found, selected, { partial: progress.paused !== null });
}
