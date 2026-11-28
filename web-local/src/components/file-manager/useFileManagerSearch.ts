import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import type { TreeEntry, ConnectedFolderSummary } from "../../types";
import type { FileManagerPlace } from "./file-manager-places";
import { searchResultsPerRun, type SearchPause } from "./file-manager-search-progress";

export type FileManagerSearchScope = "here" | "all";

/** One search result row: a name match first, then a line of text that matched. */
export interface FileManagerSearchResult {
  key: string;
  /** The Connected Folder it is in; empty for a result in a Standard Folder or the computer place, which names `place`. */
  connectedFolderId: string;
  /** Set for a Standard Folder or computer place result. */
  place?: FileManagerPlace;
  path: string;
  name: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt?: string;
  link?: TreeEntry["link"];
  match: { kind: "name" } | { kind: "content"; pre: string; hit: string; post: string };
}

const debounceMs = 250;
interface SearchPage {
  names: TreeEntry[];
  files: Array<{ path: string; line: number; preview: string }>;
  /** Set until the search reaches its end: the next page goes on from it. */
  nextCursor?: string | null;
  /** `complete` is false when something could not be read, or changed while being read. */
  coverage?: { complete?: boolean };
}

/** What one Connected Folder's search has found so far, and where its next page starts. */
export interface ConnectedFolderSearchPages {
  connectedFolderId: string;
  path: string;
  names: FileManagerSearchResult[];
  texts: FileManagerSearchResult[];
  /** Where the next page starts; null once this Connected Folder's search reached its end. */
  cursor: string | null;
  /** Something in it could not be searched. */
  incomplete: boolean;
}

/** Folds one page into a Connected Folder's results: name matches, then text matches for files not already listed. A page that could not be read ends that search, incomplete. */
export function mergeConnectedFolderSearchPage(pages: ConnectedFolderSearchPages, page: SearchPage | null, needle: string): ConnectedFolderSearchPages {
  const names = [...pages.names];
  const texts = [...pages.texts];
  const seen = new Set([...names, ...texts].map((result) => result.path));
  for (const entry of page?.names ?? []) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    names.push(resultFor(pages.connectedFolderId, entry, { kind: "name" }));
  }
  for (const match of page?.files ?? []) {
    if (seen.has(match.path)) continue;
    seen.add(match.path);
    const entry = { name: match.path.split("/").pop() ?? match.path, path: match.path, kind: "file" as const };
    texts.push(resultFor(pages.connectedFolderId, entry, { kind: "content", ...snippet(match.preview, needle) }));
  }
  const cursor = page?.nextCursor ?? null;
  return { ...pages, names, texts, cursor, incomplete: pages.incomplete || !page || (cursor === null && page.coverage?.complete === false) };
}

export interface FileManagerSearchState {
  results: FileManagerSearchResult[];
  status: "idle" | "searching" | "done";
  /** Set when the search stopped short of its end: Keep Searching goes on from there. */
  paused: SearchPause | null;
  /** Something could not be searched: unreadable, or changed while being read. */
  incomplete: boolean;
  /** Stops a running search where it is; the results so far stay. */
  stop: () => void;
  /** Goes on from where the search stopped; only while `paused`. */
  continueSearch: () => void;
}

/**
 * Search names and contents, as the design does: in the folder shown, or in
 * every Connected Folder. The host supplies both kinds of match through the
 * same search the CLI uses, a bounded page at a time, and the window asks
 * each Connected Folder for its next page itself until every search reaches
 * its end, so it finds everything, unless the person presses Stop or a run
 * gathers `searchResultsPerRun` results (file-manager-search-progress.ts).
 */
export function useFileManagerSearch(input: {
  query: string;
  scope: FileManagerSearchScope;
  here: { connectedFolder: ConnectedFolderSummary; path: string } | null;
  connectedFolders: readonly ConnectedFolderSummary[];
  enabled: boolean;
  /** The browser preview's sample trees and file text, searched in place of the host. */
  fixture?: { trees: Record<string, TreeEntry[]>; fileContents: Record<string, Record<string, string>> } | null;
}): FileManagerSearchState {
  const { query, scope, here, connectedFolders, enabled, fixture } = input;
  const idle: Omit<FileManagerSearchState, "stop" | "continueSearch"> = { results: [], status: "idle", paused: null, incomplete: false };
  const [state, setState] = useState(idle);
  const needle = query.trim();
  const targets = scope === "here" && here ? [here] : connectedFolders.map((connectedFolder) => ({ connectedFolder, path: "" }));
  const targetKey = targets.map((target) => `${target.connectedFolder.id}\0${target.path}`).join("|");
  const searchKey = `${needle}\0${targetKey}`;
  const keyRef = useRef(searchKey);
  keyRef.current = searchKey;
  /** Each Connected Folder's results and next page; null before the first pages arrive. */
  const pagesRef = useRef<ConnectedFolderSearchPages[] | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  /** The first page waits for typing to pause; Stop in that moment cancels it. */
  const startTimerRef = useRef<number | null>(null);
  const fixtureRef = useRef(fixture);
  fixtureRef.current = fixture;

  /** Asks every Connected Folder whose search has more for its next page, round after round, until all end, the person stops, or a run's worth is gathered. */
  const run = useCallback(async (key: string, start: ConnectedFolderSearchPages[]) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const count = (pages: readonly ConnectedFolderSearchPages[]) => pages.reduce((sum, item) => sum + item.names.length + item.texts.length, 0);
    const until = (pagesRef.current ? count(pagesRef.current) : 0) + searchResultsPerRun;
    let pages = pagesRef.current ?? start;
    let first = pagesRef.current === null;
    setState((current) => ({ ...current, status: "searching", paused: null }));
    for (;;) {
      const asked = pages;
      pages = await Promise.all(asked.map(async (item) => {
        if (!first && item.cursor === null) return item;
        const sample = fixtureRef.current;
        if (sample) return mergeConnectedFolderSearchPage(item, searchFixture(sample, item.connectedFolderId, item.path, needle), needle);
        const params = new URLSearchParams({ q: needle, scope: "files" });
        if (item.path) params.set("path", item.path);
        if (item.cursor) params.set("cursor", item.cursor);
        const page = await api<SearchPage>(`/api/connected-folders/${encodeURIComponent(item.connectedFolderId)}/search?${params}`, { signal: controller.signal }).catch(() => null);
        return mergeConnectedFolderSearchPage(item, page, needle);
      }));
      if (controller.signal.aborted || keyRef.current !== key) return;
      first = false;
      pagesRef.current = pages;
      const more = pages.some((item) => item.cursor !== null);
      const limited = more && count(pages) >= until;
      // Every name match first, then every text match, as the design lists them.
      setState({
        results: [...pages.flatMap((item) => item.names), ...pages.flatMap((item) => item.texts)],
        status: more && !limited ? "searching" : "done",
        paused: limited ? "limit" : null,
        incomplete: pages.some((item) => item.incomplete),
      });
      if (!more || limited) return;
    }
  }, [needle]);

  useEffect(() => {
    controllerRef.current?.abort();
    pagesRef.current = null;
    if (!enabled || !needle) { setState(idle); return; }
    // A new search shows only its own results: a Stop before its first page must not leave another query's behind.
    setState({ ...idle, status: "searching" });
    const key = searchKey;
    const start = targets.map(({ connectedFolder, path }) => ({ connectedFolderId: connectedFolder.id, path, names: [], texts: [], cursor: null, incomplete: false }));
    const timer = startTimerRef.current = window.setTimeout(() => void run(key, start), debounceMs);
    return () => { window.clearTimeout(timer); controllerRef.current?.abort(); };
  }, [enabled, searchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useCallback(() => {
    if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
    startTimerRef.current = null;
    controllerRef.current?.abort();
    setState((current) => current.status === "searching" ? { ...current, status: "done", paused: "stopped" } : current);
  }, []);

  const continueSearch = useCallback(() => {
    if (!enabled) return;
    const pages = pagesRef.current;
    if (pages && !pages.some((item) => item.cursor !== null)) return;
    const start = targets.map(({ connectedFolder, path }) => ({ connectedFolderId: connectedFolder.id, path, names: [], texts: [], cursor: null, incomplete: false }));
    void run(keyRef.current, start);
  }, [enabled, run, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, stop, continueSearch };
}

function resultFor(connectedFolderId: string, entry: TreeEntry, match: FileManagerSearchResult["match"]): FileManagerSearchResult {
  return {
    key: `${connectedFolderId}\0${entry.path}`,
    connectedFolderId,
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    ...(entry.link ? { link: entry.link } : {}),
    match,
  };
}

function searchFixture(fixture: { trees: Record<string, TreeEntry[]>; fileContents: Record<string, Record<string, string>> }, id: string, path: string, needle: string): SearchPage {
  const lower = needle.toLocaleLowerCase();
  const entries = flattenTree(fixture.trees[id] ?? []).filter((entry) =>
    !entry.nestedFolder && (!path || entry.path.startsWith(`${path}/`)));
  const names = entries.filter((entry) => entry.name.toLocaleLowerCase().includes(lower));
  const files = entries.flatMap((entry) => {
    const lines = fixture.fileContents[id]?.[entry.path]?.split("\n") ?? [];
    const index = lines.findIndex((line) => line.toLocaleLowerCase().includes(lower));
    return index < 0 ? [] : [{ path: entry.path, line: index + 1, preview: lines[index]! }];
  });
  return { names, files };
}

function flattenTree(entries: readonly TreeEntry[]): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (items: readonly TreeEntry[]) => {
    for (const item of items) {
      out.push(item);
      if (item.children && !item.nestedFolder) walk(item.children);
    }
  };
  walk(entries);
  return out;
}

/**
 * A matched line as a person reads it: Markdown's list marks, heading marks,
 * emphasis, code ticks, and link targets left out ("- **Fixed-price quote:**"
 * reads "Fixed-price quote:").
 */
export function readableLine(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]\s+\[[ xX]\]\s+|[-*+>]\s+|\d+[.)]\s+|#{1,6}\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words around a match, trimmed to whole words, as the design shows them. */
export function snippet(text: string, needle: string): { pre: string; hit: string; post: string } {
  const line = readableLine(text);
  const index = line.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0) return { pre: line.slice(0, 80), hit: "", post: line.length > 80 ? "…" : "" };
  let start = Math.max(0, index - 34);
  if (start > 0) {
    const space = line.indexOf(" ", start);
    if (space > 0 && space < index) start = space + 1;
  }
  const end = Math.min(line.length, index + needle.length + 46);
  return {
    pre: `${start > 0 ? "…" : ""}${line.slice(start, index)}`,
    hit: line.slice(index, index + needle.length),
    post: `${line.slice(index + needle.length, end)}${end < line.length ? "…" : ""}`,
  };
}
