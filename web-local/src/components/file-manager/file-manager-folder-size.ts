import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { api, errorText } from "../../lib/api";
import { formatCapacity } from "./file-manager-drives";
import { placeApiBase, placeKey, type FileManagerPlace } from "./file-manager-places";

/**
 * Folder sizes in the file manager window (docs/product-model.md, "The file
 * manager window"). Info asks the host to measure the folder it describes
 * (`GET …/folder-size`), shows "Calculating…" meanwhile, and shows "At least"
 * when the host's bound stopped the count early, with the reason on the Size
 * row itself for anyone who points at it. A size measured in this session
 * also fills the list's Size column for that folder; nothing measures the
 * folders a list merely shows.
 */

export interface FolderSize {
  path: string;
  bytes: number;
  bytesOnDisk: number | null;
  items: number;
  files: number;
  folders: number;
  links: number;
  unreadable: number;
  otherVolumes: number;
  complete: boolean;
  stoppedBy: "time-limit" | "item-limit" | null;
  elapsedMs: number;
  measuredAt: string;
  cached: boolean;
}

export type FolderSizeState =
  | { status: "idle" }
  | { status: "calculating" }
  | { status: "done"; size: FolderSize }
  | { status: "error"; message: string };

/**
 * What Info says about a measurement. `detail` is why the figure is a minimum
 * or leaves something out; Info shows it when the Size row is pointed at, never
 * as text of its own.
 */
export function folderSizeText(size: FolderSize): { size: string; items: string; detail: string | null } {
  const partial = size.stoppedBy !== null;
  const items = size.items === 1 ? "1 item" : `${size.items.toLocaleString()} items`;
  const notes: string[] = [];
  if (size.stoppedBy === "time-limit") notes.push("This folder is large: counting stopped after 10 seconds, so the size is a minimum.");
  if (size.stoppedBy === "item-limit") notes.push(`This folder is large: counting stopped after ${size.items.toLocaleString()} items, so the size is a minimum.`);
  if (size.unreadable > 0) notes.push("Some items couldn’t be read and aren’t counted.");
  if (size.otherVolumes > 0) notes.push(size.otherVolumes === 1 ? "Another drive attached inside this folder isn’t counted." : "Other drives attached inside this folder aren’t counted.");
  return {
    size: partial ? `At least ${formatCapacity(size.bytes)}` : formatCapacity(size.bytes),
    items: partial ? `More than ${items}` : items,
    detail: notes.length ? notes.join(" ") : null,
  };
}

/** The Size column's short form: "1.2 GB", or "≥ 1.2 GB" when the count stopped early. */
export function folderSizeColumnText(size: FolderSize): string {
  return size.stoppedBy !== null ? `≥ ${formatCapacity(size.bytes)}` : formatCapacity(size.bytes);
}

/** Whether a folder can be measured: never the disk's top in the computer place (the host refuses to walk a whole disk). */
export function canMeasureFolder(place: FileManagerPlace, path: string): boolean {
  return !(place.kind === "standard" && place.id === "computer" && !path);
}

// ---- Measurements kept for this session ----

const measured = new Map<string, FolderSize>();
const listeners = new Set<() => void>();
let version = 0;

function sizeKey(place: FileManagerPlace, path: string): string {
  return `${placeKey(place)}\0${path}`;
}

export function rememberFolderSize(place: FileManagerPlace, path: string, size: FolderSize): void {
  measured.set(sizeKey(place, path), size);
  version += 1;
  for (const listener of listeners) listener();
}

export function rememberedFolderSize(place: FileManagerPlace, path: string): FolderSize | undefined {
  return measured.get(sizeKey(place, path));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The Size column's text for folders measured in this session, among the paths a listing shows. */
export function useRememberedFolderSizes(place: FileManagerPlace, paths: readonly string[]): ReadonlyMap<string, string> | null {
  const current = useSyncExternalStore(subscribe, () => version, () => version);
  const key = placeKey(place);
  return useMemo(() => {
    if (!measured.size) return null;
    const shown = new Map<string, string>();
    for (const path of paths) {
      const size = measured.get(`${key}\0${path}`);
      if (size) shown.set(path, folderSizeColumnText(size));
    }
    return shown.size ? shown : null;
  }, [current, key, paths]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * One folder's size, measured when asked for. Leaving the folder (or turning
 * it off) withdraws the request, and the host stops a walk nobody waits for.
 */
export function useFolderSize(place: FileManagerPlace | null, apiBase: string | null, path: string, enabled: boolean): { state: FolderSizeState; recalculate: () => void } {
  const [state, setState] = useState<FolderSizeState>({ status: "idle" });
  const [fresh, setFresh] = useState(0);
  const base = apiBase ?? (place ? placeApiBase(place) : null);
  const allowed = Boolean(enabled && base && place && canMeasureFolder(place, path));
  useEffect(() => {
    if (!allowed || !base || !place) { setState({ status: "idle" }); return; }
    const known = fresh ? undefined : rememberedFolderSize(place, path);
    if (known) setState({ status: "done", size: known });
    else setState({ status: "calculating" });
    const controller = new AbortController();
    // Arrowing through folders asks only about the one it settles on.
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ path });
      if (fresh) query.set("fresh", "1");
      void api<{ folderSize: FolderSize }>(`${base}/folder-size?${query.toString()}`, { signal: controller.signal })
        .then(({ folderSize }) => {
          if (controller.signal.aborted) return;
          rememberFolderSize(place, path, folderSize);
          setState({ status: "done", size: folderSize });
        })
        .catch((caught) => {
          if (controller.signal.aborted) return;
          if (!known) setState({ status: "error", message: errorText(caught) });
        });
    }, known ? 0 : 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [allowed, base, path, fresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const recalculate = useCallback(() => setFresh((value) => value + 1), []);
  return { state, recalculate };
}
