import { useCallback, useEffect, useRef, useState } from "react";

import { api, errorText } from "../../lib/api";
import type { TreeEntry } from "../../types";
import { placeApiBase, placeKey, type FileManagerPlace } from "./file-manager-places";
import { snippet, type FileManagerSearchResult } from "./useFileManagerSearch";

/**
 * Search in a Standard Folder or the computer place (docs/product-model.md,
 * "Search"): names and file text below the folder shown, through the host's
 * folder search (`GET /api/standard-folders/:id/search`). Each page is bounded
 * by time and by how much it reads; when one stops early the window says so
 * and Keep Searching asks for the next page. Hidden items are searched only
 * while Show Hidden Files is on. Connected Folders inside are listed, not
 * searched: their own search applies their rules.
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
  coverage: { stoppedBy: FolderSearchStop | null; complete: boolean; unreadable: number; visitedEntries: number; scannedBytes: number };
}

export interface PlainFolderSearchState {
  results: FileManagerSearchResult[];
  status: "idle" | "searching" | "done" | "error";
  error: string | null;
  /** Set while there is more to search: the page stopped at a bound. */
  stoppedEarly: FolderSearchStop | null;
  /** Files read so far, across pages. */
  scannedFiles: number;
  /** Some folders could not be read, or changed while being read. */
  incomplete: boolean;
  /** Connected Folders inside the folder searched, which this search leaves to their own. */
  connectedFoldersInside: string[];
  /** Asks for the next page; only while `stoppedEarly`. */
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

/** Why a page stopped, in words: "Search stopped after 5 seconds." */
export function stoppedEarlyText(stop: FolderSearchStop, scannedFiles: number): string {
  const files = `${scannedFiles.toLocaleString()} ${scannedFiles === 1 ? "file" : "files"}`;
  switch (stop) {
    case "time": return `Search stopped after a few seconds, having read ${files}.`;
    case "files": return `Search stopped after reading ${files}.`;
    case "bytes": return `Search stopped after reading ${files}, a lot of text at once.`;
    case "entries": return "Search stopped after looking through a great many items.";
    case "matches":
    case "results": return "Search stopped after finding many matches.";
  }
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
  const [state, setState] = useState<Omit<PlainFolderSearchState, "continueSearch">>({ results: [], status: "idle", error: null, stoppedEarly: null, scannedFiles: 0, incomplete: false, connectedFoldersInside: [] });
  const accumulated = useRef<{ names: FileManagerSearchResult[]; texts: FileManagerSearchResult[] }>({ names: [], texts: [] });
  const cursorRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const searchKey = `${placeKey(place)}\0${path}\0${includeHidden ? 1 : 0}\0${needle}`;
  const keyRef = useRef(searchKey);
  keyRef.current = searchKey;

  const fetchPage = useCallback(async (cursor: string | null, key: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => ({ ...current, status: "searching", error: null }));
    try {
      let page: FolderSearchPage;
      if (fixtureTree) page = fixturePage(fixtureTree, path, needle);
      else {
        const params = new URLSearchParams({ q: needle });
        if (path) params.set("path", path);
        if (includeHidden) params.set("includeHidden", "1");
        if (cursor) params.set("cursor", cursor);
        page = await api<FolderSearchPage>(`${placeApiBase(place)}/search?${params.toString()}`, { signal: controller.signal });
      }
      if (controller.signal.aborted || keyRef.current !== key) return;
      accumulated.current = mergeFolderSearchPage(place, accumulated.current, page, needle);
      cursorRef.current = page.nextCursor;
      setState((current) => ({
        results: [...accumulated.current.names, ...accumulated.current.texts],
        status: "done",
        error: null,
        stoppedEarly: page.nextCursor ? page.coverage.stoppedBy ?? "time" : null,
        scannedFiles: (cursor ? current.scannedFiles : 0) + page.scannedFiles,
        incomplete: !page.nextCursor && !page.coverage.complete,
        connectedFoldersInside: [...new Set([...(cursor ? current.connectedFoldersInside : []), ...page.connectedFolders.map((item) => item.connectedFolderId)])],
      }));
    } catch (caught) {
      if (controller.signal.aborted || keyRef.current !== key) return;
      setState((current) => ({ ...current, status: "error", error: errorText(caught), stoppedEarly: null }));
    }
  }, [fixtureTree, includeHidden, needle, path, place]);

  useEffect(() => {
    accumulated.current = { names: [], texts: [] };
    cursorRef.current = null;
    controllerRef.current?.abort();
    if (!enabled || !needle) {
      setState({ results: [], status: "idle", error: null, stoppedEarly: null, scannedFiles: 0, incomplete: false, connectedFoldersInside: [] });
      return;
    }
    setState({ results: [], status: "searching", error: null, stoppedEarly: null, scannedFiles: 0, incomplete: false, connectedFoldersInside: [] });
    const key = searchKey;
    const timer = window.setTimeout(() => void fetchPage(null, key), debounceMs);
    return () => { window.clearTimeout(timer); controllerRef.current?.abort(); };
  }, [enabled, searchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const continueSearch = useCallback(() => {
    const cursor = cursorRef.current;
    if (!cursor || !enabled) return;
    void fetchPage(cursor, keyRef.current);
  }, [enabled, fetchPage]);

  return { ...state, continueSearch };
}
