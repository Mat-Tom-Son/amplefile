import { useCallback, useEffect, useRef, useState } from "react";

import { api, errorText } from "../../lib/api";
import type { TreeEntry } from "../../types";
import { placeApiBase, placeKey, type FileManagerPlace } from "./file-manager-places";
import { snippet, type FileManagerSearchResult } from "./useFileManagerSearch";
import { searchResultsPerRun, type SearchPause } from "./file-manager-search-progress";

/**
 * Search in a Standard Folder or the computer place (docs/product-model.md,
 * "Search"): names and file text below the folder shown, through the host's
 * folder search (`GET /api/standard-folders/:id/search`). The host answers a
 * bounded page at a time; the window asks for the next page itself until the
 * search reaches its end, so it finds everything, unless the person presses
 * Stop or a run gathers `searchResultsPerRun` results (file-manager-search-progress.ts).
 * Hidden items are searched only while Show Hidden Files is on. Connected
 * Folders inside are listed, not searched: their own search applies their rules.
 */

export type FolderSearchStop = "matches" | "files" | "bytes" | "entries" | "time" | "results";

export interface FolderSearchPage {
  query: string;
  names: Array<{ path: string; name: string; kind: "file" | "folder"; sizeBytes?: number; updatedAt?: string; hidden?: true }>;
  files: Array<{ path: string; line: number; preview: string; sizeBytes: number; updatedAt: string; hidden?: true }>;
  connectedFolders: Array<{ connectedFolderId: string; path: string }>;
  truncated: boolean;
  scannedFiles: number;
  nextCursor: string | null;
  /** Counters describe this page alone; `complete` too, so the window adds up `unreadable` and `changed` across pages. */
  coverage: { stoppedBy: FolderSearchStop | null; complete: boolean; unreadable: number; changed?: number; visitedEntries: number; scannedBytes: number };
}

export interface PlainFolderSearchState {
  results: FileManagerSearchResult[];
  status: "idle" | "searching" | "done" | "error";
  error: string | null;
  /** Set when the search stopped short of its end: Keep Searching goes on from there. */
  paused: SearchPause | null;
  /** Files read so far, across pages. */
  scannedFiles: number;
  /** Some folders could not be read, or changed while being read. */
  incomplete: boolean;
  /** Connected Folders inside the folder searched, which this search leaves to their own. */
  connectedFoldersInside: string[];
  /** Stops a running search where it is; the results so far stay. */
  stop: () => void;
  /** Goes on from where the search stopped; only while `paused`. */
  continueSearch: () => void;
}

const debounceMs = 250;

/** Folds one page into the results so far: every name match first, then text matches for files not already named. */
export function mergeFolderSearchPage(place: FileManagerPlace, previous: { names: FileManagerSearchResult[]; texts: FileManagerSearchResult[] }, page: Pick<FolderSearchPage, "names" | "files">, needle: string): { names: FileManagerSearchResult[]; texts: FileManagerSearchResult[] } {
  const names = [...previous.names];
  const texts = [...previous.texts];
  const seen = new Set([...names, ...texts].map((result) => result.path));
  for (const match of page.names) {
    if (seen.has(match.path)) continue;
    seen.add(match.path);
    names.push(plainResult(place, { name: match.name, path: match.path, kind: match.kind, ...(match.sizeBytes !== undefined ? { sizeBytes: match.sizeBytes } : {}), ...(match.updatedAt ? { updatedAt: match.updatedAt } : {}) }, { kind: "name" }));
  }
  for (const match of page.files) {
    if (seen.has(match.path)) continue;
    seen.add(match.path);
    texts.push(plainResult(place, { name: match.path.slice(match.path.lastIndexOf("/") + 1), path: match.path, kind: "file", sizeBytes: match.sizeBytes, updatedAt: match.updatedAt }, { kind: "content", ...snippet(match.preview, needle) }));
  }
  return { names, texts };
}

function plainResult(place: FileManagerPlace, entry: Pick<TreeEntry, "name" | "path" | "kind" | "sizeBytes" | "updatedAt">, match: FileManagerSearchResult["match"]): FileManagerSearchResult {
  return {
    key: `${placeKey(place)}\0${entry.path}`,
    connectedFolderId: "",
    place,
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    match,
  };
}

/** The sample window's search: names and text in its sample trees. */
function fixturePage(tree: readonly TreeEntry[], path: string, needle: string): FolderSearchPage {
  const lower = needle.toLocaleLowerCase();
  const names: FolderSearchPage["names"] = [];
  const walk = (items: readonly TreeEntry[]) => {
    for (const item of items) {
      if (!path || item.path.startsWith(`${path}/`)) {
        if (item.name.toLocaleLowerCase().includes(lower)) names.push({ path: item.path, name: item.name, kind: item.kind, ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}), ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}) });
      }
      if (item.children) walk(item.children);
    }
  };
  walk(tree);
  return { query: needle, names, files: [], connectedFolders: [], truncated: false, scannedFiles: 0, nextCursor: null, coverage: { stoppedBy: null, complete: true, unreadable: 0, visitedEntries: names.length, scannedBytes: 0 } };
}

export function usePlainFolderSearch(input: {
  query: string;
  place: FileManagerPlace;
  path: string;
  includeHidden: boolean;
  enabled: boolean;
  fixtureTree?: readonly TreeEntry[] | null;
}): PlainFolderSearchState {
  const { query, place, path, includeHidden, enabled, fixtureTree } = input;
  const needle = query.trim();
  const idle: Omit<PlainFolderSearchState, "stop" | "continueSearch"> = { results: [], status: "idle", error: null, paused: null, scannedFiles: 0, incomplete: false, connectedFoldersInside: [] };
  const [state, setState] = useState(idle);
  const accumulated = useRef<{ names: FileManagerSearchResult[]; texts: FileManagerSearchResult[] }>({ names: [], texts: [] });
  /** Where the next page starts; null before the first page and after the last. */
  const cursorRef = useRef<string | null>(null);
  /** The search has not reached its end. */
  const moreRef = useRef(false);
  /** What every page so far added up to: files read, items skipped as unreadable or changed, Connected Folders passed. */
  const tallyRef = useRef({ scannedFiles: 0, skipped: 0, connectedFolders: new Set<string>() });
  const controllerRef = useRef<AbortController | null>(null);
  /** The first page waits for typing to pause; Stop in that moment cancels it. */
  const startTimerRef = useRef<number | null>(null);
  const searchKey = `${placeKey(place)}\0${path}\0${includeHidden ? 1 : 0}\0${needle}`;
  const keyRef = useRef(searchKey);
  keyRef.current = searchKey;

  /** Asks for pages one after another until the search ends, is stopped, or gathers a run's worth. */
  const run = useCallback(async (key: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const until = accumulated.current.names.length + accumulated.current.texts.length + searchResultsPerRun;
    setState((current) => ({ ...current, status: "searching", error: null, paused: null }));
    try {
      do {
        let page: FolderSearchPage;
        if (fixtureTree) page = fixturePage(fixtureTree, path, needle);
        else {
          const params = new URLSearchParams({ q: needle });
          if (path) params.set("path", path);
          if (includeHidden) params.set("includeHidden", "1");
          if (cursorRef.current) params.set("cursor", cursorRef.current);
          page = await api<FolderSearchPage>(`${placeApiBase(place)}/search?${params.toString()}`, { signal: controller.signal });
        }
        if (controller.signal.aborted || keyRef.current !== key) return;
        // Everything this page says is read now, as it arrives: a state update can run later, after the next page.
        accumulated.current = mergeFolderSearchPage(place, accumulated.current, page, needle);
        cursorRef.current = page.nextCursor;
        const more = page.nextCursor !== null;
        moreRef.current = more;
        const tally = tallyRef.current;
        tally.scannedFiles += page.scannedFiles;
        tally.skipped += page.coverage.unreadable + (page.coverage.changed ?? 0);
        for (const item of page.connectedFolders) tally.connectedFolders.add(item.connectedFolderId);
        const results = [...accumulated.current.names, ...accumulated.current.texts];
        const limited = more && results.length >= until;
        setState({
          results,
          status: more && !limited ? "searching" : "done",
          error: null,
          paused: limited ? "limit" : null,
          scannedFiles: tally.scannedFiles,
          incomplete: tally.skipped > 0,
          connectedFoldersInside: [...tally.connectedFolders],
        });
        if (limited) return;
      } while (moreRef.current);
    } catch (caught) {
      if (controller.signal.aborted || keyRef.current !== key) return;
      // What was found stays; Keep Searching tries again from the same place.
      const more = moreRef.current;
      setState((current) => ({ ...current, status: "error", error: errorText(caught), paused: more ? "stopped" : null }));
    }
  }, [fixtureTree, includeHidden, needle, path, place]);

  useEffect(() => {
    accumulated.current = { names: [], texts: [] };
    cursorRef.current = null;
    moreRef.current = false;
    tallyRef.current = { scannedFiles: 0, skipped: 0, connectedFolders: new Set() };
    controllerRef.current?.abort();
    if (!enabled || !needle) {
      setState(idle);
      return;
    }
    setState({ ...idle, status: "searching" });
    moreRef.current = true;
    const key = searchKey;
    const timer = startTimerRef.current = window.setTimeout(() => void run(key), debounceMs);
    return () => { window.clearTimeout(timer); controllerRef.current?.abort(); };
  }, [enabled, searchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useCallback(() => {
    if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
    startTimerRef.current = null;
    controllerRef.current?.abort();
    const more = moreRef.current;
    setState((current) => current.status === "searching" ? { ...current, status: "done", paused: more ? "stopped" : null } : current);
  }, []);

  const continueSearch = useCallback(() => {
    if (!moreRef.current || !enabled) return;
    void run(keyRef.current);
  }, [enabled, run]);

  return { ...state, stop, continueSearch };
}
