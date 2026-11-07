import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { loadedTreeRefreshConcurrency, connectedFolderFileRefreshDelayMs } from "../constants";
import { api, createEventSource, errorText } from "../lib/api";
import {
  collectFolderPaths,
  collectLoadedFolderPaths,
  collectOpenFolderPaths,
  findTreeEntry,
  groupTreePathsByDepth,
  keepLoadedChildren,
  removeTreeEntries,
  searchFileTree,
  setTreeEntryChildren,
  treeContainsUnloadedFolders,
  treeEntryNeedsLazyChildren,
  connectedFolderTreePathMissing,
} from "../lib/tree";
import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import { treeSelectionRange } from "../lib/tree-selection";
import type { TreeEntry, ConnectedFolderFileEvent, ConnectedFolderSummary } from "../types";

const noPaths: ReadonlySet<string> = new Set();

export function useConnectedFolderTree(connectedFolder: ConnectedFolderSummary, onError: (message: string | null) => void, fixtureTree?: TreeEntry[]) {
  const [tree, setTreeState] = useState<TreeEntry[]>(fixtureTree ?? []);
  const [status, setStatus] = useState<"loading" | "refreshing" | "ready" | "error">(fixtureTree ? "ready" : "loading");
  const [selectedPath, setSelectedPathState] = useState<string | null>(() => readTreeState(connectedFolder.id).selectedPath);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => readTreeState(connectedFolder.id).collapsedPaths);
  const [loadingFolderPaths, setLoadingFolderPaths] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [searchHydrating, setSearchHydrating] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(false);
  // Several rows selected together; empty while one row (selectedPath) or none is.
  const [multiSelection, setMultiSelection] = useState<ReadonlySet<string>>(noPaths);
  const [movingTreePaths, setMovingTreePaths] = useState<ReadonlySet<string>>(noPaths);
  const [dropTargetFolderPath, setDropTargetFolderPath] = useState<string | null>(null);
  const requestRef = useRef(0);
  const activeConnectedFolderIdRef = useRef(connectedFolder.id);
  const treeCacheRef = useRef(new Map<string, TreeEntry[]>());
  const searchHydratedConnectedFolderIdsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<number | null>(null);
  const eventPathsRef = useRef(new Set<string>());
  const needsFullRefreshRef = useRef(false);
  // Folders a search loaded while they were closed. Search must not change
  // the ordinary view, so they stay closed afterwards, as if never loaded.
  // Kept per Connected Folder in memory only; opening one removes it.
  const searchClosedPathsRef = useRef(new Map<string, ReadonlySet<string>>());
  const [searchClosedPaths, setSearchClosedPathsState] = useState<ReadonlySet<string>>(() => new Set());
  const shownCollapsedPaths = useMemo(
    () => searchClosedPaths.size ? new Set([...collapsedPaths, ...searchClosedPaths]) : collapsedPaths,
    [collapsedPaths, searchClosedPaths],
  );
  const treeRef = useRef(tree);
  const collapsedPathsRef = useRef(collapsedPaths);
  const shownCollapsedPathsRef = useRef(shownCollapsedPaths);
  const selectedPathRef = useRef(selectedPath);
  const selectedPaths = useMemo(
    () => multiSelection.size > 1 ? multiSelection : selectedPath ? new Set([selectedPath]) : noPaths,
    [multiSelection, selectedPath],
  );
  const selectedPathsRef = useRef(selectedPaths);
  // Shift-click selects from here: the row last clicked without Shift.
  const selectionAnchorRef = useRef<string | null>(selectedPath);
  treeRef.current = tree;
  collapsedPathsRef.current = collapsedPaths;
  shownCollapsedPathsRef.current = shownCollapsedPaths;
  selectedPathRef.current = selectedPath;
  selectedPathsRef.current = selectedPaths;
  activeConnectedFolderIdRef.current = connectedFolder.id;

  function setSearchClosedPaths(connectedFolderId: string, paths: ReadonlySet<string>) {
    searchClosedPathsRef.current.set(connectedFolderId, paths);
    if (activeConnectedFolderIdRef.current === connectedFolderId) setSearchClosedPathsState(paths);
  }

  const setTree: Dispatch<SetStateAction<TreeEntry[]>> = (update) => {
    setTreeState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      treeCacheRef.current.set(connectedFolder.id, next);
      return next;
    });
  };

  // A layout effect: the previous Connected Folder's files must never paint under the
  // new Connected Folder's header, even for one frame.
  useLayoutEffect(() => {
    activeConnectedFolderIdRef.current = connectedFolder.id;
    const saved = fixtureTree ? { selectedPath: null, collapsedPaths: new Set<string>() } : readTreeState(connectedFolder.id);
    requestRef.current += 1;
    setSelectedPathState(saved.selectedPath);
    setMultiSelection(noPaths);
    selectionAnchorRef.current = saved.selectedPath;
    setCollapsedPaths(saved.collapsedPaths);
    setSearchClosedPathsState(searchClosedPathsRef.current.get(connectedFolder.id) ?? new Set());
    setLoadingFolderPaths(new Set());
    setMovingTreePaths(noPaths);
    setDropTargetFolderPath(null);
    setQuery("");
    setSearchHydrating(false);
    setTreeTruncated(false);
    clearScheduledRefresh();
    if (fixtureTree) {
      treeCacheRef.current.set(connectedFolder.id, fixtureTree);
      setTreeState(fixtureTree);
      setStatus("ready");
      return;
    }
    const cached = treeCacheRef.current.get(connectedFolder.id);
    setTreeState(cached ?? []);
    setStatus(cached?.length ? "refreshing" : "loading");
    // Never fall back to the previous Connected Folder's tree: a first visit would show it
    // as "refreshing" and reopen its expanded folders under this Connected Folder.
    void refresh(false, { baseTree: cached ?? [] });
    return () => {
      requestRef.current += 1;
      activeConnectedFolderIdRef.current = "";
      clearScheduledRefresh();
    };
  }, [connectedFolder.id, fixtureTree]);

  useEffect(() => {
    if (fixtureTree) return;
    const source = createEventSource(`/api/connected-folders/${connectedFolder.id}/file-events`);
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ConnectedFolderFileEvent;
        // File watchers have no replay cursor. Requery after every ready,
        // including the first, to cover writes during opening or reconnect.
        if (parsed.type === "ready") { scheduleRefresh(); return; }
        if (parsed.type === "error") return onError(parsed.message || "File monitoring paused. Refresh this Connected Folder to resume.");
        scheduleRefresh(parsed.path ? [parsed.path] : undefined);
      } catch (caught) { onError(errorText(caught)); }
    };
    return () => { source.close(); clearScheduledRefresh(); };
  }, [connectedFolder.id, fixtureTree]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || fixtureTree || searchHydratedConnectedFolderIdsRef.current.has(connectedFolder.id)) return;
    const timer = window.setTimeout(() => void hydrateForSearch(), 260);
    return () => window.clearTimeout(timer);
  }, [fixtureTree, query, connectedFolder.id]);

  // Leaving a search shows the tree as it was, except that a file picked from
  // the results is revealed in place.
  const searching = Boolean(query.trim());
  const searchStartRef = useRef<{ connectedFolderId: string; selectedPath: string | null } | null>(null);
  useEffect(() => {
    if (searching) {
      searchStartRef.current ??= { connectedFolderId: connectedFolder.id, selectedPath: selectedPathRef.current };
      return;
    }
    const start = searchStartRef.current;
    searchStartRef.current = null;
    const picked = selectedPathRef.current;
    if (!start || start.connectedFolderId !== connectedFolder.id || !picked || picked === start.selectedPath) return;
    const ancestors = new Set(picked.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/")));
    if (!ancestors.size) return;
    const closed = searchClosedPathsRef.current.get(connectedFolder.id) ?? new Set<string>();
    if ([...ancestors].some((path) => closed.has(path))) setSearchClosedPaths(connectedFolder.id, new Set([...closed].filter((path) => !ancestors.has(path))));
    if ([...ancestors].some((path) => collapsedPathsRef.current.has(path))) {
      setCollapsedPaths((current) => {
        const next = new Set([...current].filter((path) => !ancestors.has(path)));
        writeTreeState(connectedFolder.id, { selectedPath: picked, collapsedPaths: [...next] });
        return next;
      });
    }
  }, [searching, connectedFolder.id]);

  useEffect(() => {
    if (!tree.length || treeContainsUnloadedFolders(tree)) return;
    const folderPaths = new Set(collectFolderPaths(tree));
    setCollapsedPaths((current) => {
      const next = new Set([...current].filter((path) => folderPaths.has(path)));
      if (next.size !== current.size) writeTreeState(connectedFolder.id, { selectedPath, collapsedPaths: [...next] });
      return next;
    });
    if (selectedPath && !findTreeEntry(tree, selectedPath)) setSelectedPath(null);
  }, [tree, connectedFolder.id]);

  async function refresh(clearError = true, options: { eventPaths?: string[]; baseTree?: TreeEntry[] } = {}) {
    if (fixtureTree) return;
    const request = ++requestRef.current;
    const connectedFolderId = connectedFolder.id;
    const existing = options.baseTree ?? treeRef.current;
    if (clearError) onError(null);
    setStatus(existing.length ? "refreshing" : "loading");
    searchHydratedConnectedFolderIdsRef.current.delete(connectedFolderId);
    try {
      const root = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(connectedFolderId, "", 0));
      if (request !== requestRef.current || activeConnectedFolderIdRef.current !== connectedFolderId) return;
      const refreshed = existing.length
        ? await refreshLoadedChildren(connectedFolderId, root.tree, existing, collapsedPathsRef.current, options.eventPaths)
        : { tree: root.tree, truncated: false };
      const next = refreshed.tree;
      setTreeTruncated(Boolean(root.truncated) || refreshed.truncated);
      if (request !== requestRef.current || activeConnectedFolderIdRef.current !== connectedFolderId) return;
      treeCacheRef.current.set(connectedFolderId, next);
      setTreeState(next);
      setStatus("ready");
    } catch (caught) {
      if (request !== requestRef.current || activeConnectedFolderIdRef.current !== connectedFolderId) return;
      setStatus("error"); onError(errorText(caught));
    }
  }

  async function loadFolderChildren(path: string) {
    if (fixtureTree || loadingFolderPaths.has(path)) return;
    const connectedFolderId = connectedFolder.id;
    setLoadingFolderPaths((current) => new Set(current).add(path));
    try {
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(connectedFolderId, path, 0));
      if (activeConnectedFolderIdRef.current !== connectedFolderId) return;
      setTree((current) => setTreeEntryChildren(current, path, result.tree));
      if (result.truncated) setTreeTruncated(true);
    } catch (caught) {
      if (activeConnectedFolderIdRef.current !== connectedFolderId) return;
      const message = errorText(caught);
      if (connectedFolderTreePathMissing(message)) {
        setTree((current) => removeTreeEntries(current, new Set([path])));
        onError(`That folder is no longer available: ${path}`);
      } else onError(message);
    } finally {
      if (activeConnectedFolderIdRef.current === connectedFolderId) setLoadingFolderPaths((current) => { const next = new Set(current); next.delete(path); return next; });
    }
  }

  async function hydrateForSearch() {
    if (fixtureTree || searchHydratedConnectedFolderIdsRef.current.has(connectedFolder.id)) return;
    const connectedFolderId = connectedFolder.id;
    setSearchHydrating(true);
    try {
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(connectedFolderId, "", 6));
      if (activeConnectedFolderIdRef.current !== connectedFolderId) return;
      const openBefore = collectOpenFolderPaths(treeRef.current, shownCollapsedPathsRef.current);
      setSearchClosedPaths(connectedFolderId, new Set(collectFolderPaths(result.tree).filter((path) => !openBefore.has(path))));
      searchHydratedConnectedFolderIdsRef.current.add(connectedFolderId);
      treeCacheRef.current.set(connectedFolderId, result.tree);
      setTreeState(result.tree);
      setTreeTruncated(Boolean(result.truncated));
    } catch (caught) { if (activeConnectedFolderIdRef.current === connectedFolderId) onError(errorText(caught)); }
    finally { if (activeConnectedFolderIdRef.current === connectedFolderId) setSearchHydrating(false); }
  }

  function scheduleRefresh(paths?: string[]) {
    if (paths) {
      if (!needsFullRefreshRef.current) paths.forEach((path) => eventPathsRef.current.add(path));
    } else {
      needsFullRefreshRef.current = true; eventPathsRef.current.clear();
    }
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      const eventPaths = needsFullRefreshRef.current ? undefined : [...eventPathsRef.current];
      needsFullRefreshRef.current = false; eventPathsRef.current.clear();
      void refresh(false, { eventPaths });
    }, connectedFolderFileRefreshDelayMs);
  }

  function clearScheduledRefresh() {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null; needsFullRefreshRef.current = false; eventPathsRef.current.clear();
  }

  function writeSelectedPath(path: string | null) {
    setSelectedPathState(path);
    selectedPathRef.current = path;
    writeTreeState(connectedFolder.id, { selectedPath: path, collapsedPaths: [...collapsedPathsRef.current] });
  }

  /** Selects just this row, or nothing: a plain click, a keyboard move, a file tab coming to the front. */
  function setSelectedPath(path: string | null) {
    writeSelectedPath(path);
    setMultiSelection(noPaths);
    selectedPathsRef.current = path ? new Set([path]) : noPaths;
    selectionAnchorRef.current = path;
  }

  /** Selects these rows; `focus` is the one last clicked, which keeps Files' single-row behavior. */
  function selectPaths(paths: Iterable<string>, focus: string | null = null) {
    const next = new Set(paths);
    if (next.size <= 1) {
      const only = next.values().next().value ?? null;
      writeSelectedPath(only);
      setMultiSelection(noPaths);
      selectedPathsRef.current = only ? new Set([only]) : noPaths;
      return;
    }
    writeSelectedPath(focus && next.has(focus) ? focus : [...next].at(-1)!);
    setMultiSelection(next);
    selectedPathsRef.current = next;
  }

  /** ⌘-click: adds the row to the selection, or takes it out. */
  function toggleSelectedPath(path: string) {
    const next = new Set(selectedPathsRef.current);
    if (next.has(path)) next.delete(path); else next.add(path);
    selectionAnchorRef.current = path;
    selectPaths(next, next.has(path) ? path : selectedPathRef.current);
  }

  /** Shift-click: the shown rows from the last clicked row to this one; with ⌘ as well, added to the selection. */
  function selectPathRange(path: string, order: readonly string[], additive = false) {
    const anchor = [selectionAnchorRef.current, selectedPathRef.current].find((candidate): candidate is string => Boolean(candidate && order.includes(candidate))) ?? path;
    const range = treeSelectionRange(order, anchor, path);
    if (!range.length) return;
    selectionAnchorRef.current = anchor;
    selectPaths(additive ? [...selectedPathsRef.current, ...range] : range, path);
  }

  /** A row that stops showing (its folder closed, a search hid it, it was deleted) leaves the selection. */
  function keepSelectionWithin(shownPaths: readonly string[]) {
    const current = selectedPathsRef.current;
    if (current.size < 2) return;
    const shown = new Set(shownPaths);
    const kept = [...current].filter((path) => shown.has(path));
    if (kept.length === current.size) return;
    if (kept.length) selectPaths(kept, selectedPathRef.current);
    else { setMultiSelection(noPaths); selectedPathsRef.current = selectedPathRef.current ? new Set([selectedPathRef.current]) : noPaths; }
  }

  function toggleFolder(path: string, expanded?: boolean) {
    const entry = findTreeEntry(treeRef.current, path);
    if (!entry || entry.kind !== "folder") return;
    const opening = expanded ?? (shownCollapsedPathsRef.current.has(path) || treeEntryNeedsLazyChildren(entry));
    const searchClosed = searchClosedPathsRef.current.get(connectedFolder.id);
    if (opening && searchClosed?.has(path)) setSearchClosedPaths(connectedFolder.id, new Set([...searchClosed].filter((item) => item !== path)));
    setCollapsedPaths((current) => {
      const next = new Set(current); if (opening) next.delete(path); else next.add(path);
      writeTreeState(connectedFolder.id, { selectedPath, collapsedPaths: [...next] }); return next;
    });
    if (opening && treeEntryNeedsLazyChildren(entry)) void loadFolderChildren(path);
  }

  const search = useMemo(() => query.trim() ? searchFileTree(tree, query) : { entries: tree, matchCount: 0 }, [query, tree]);
  return {
    tree, setTree, status, refresh, selectedPath, setSelectedPath, collapsedPaths: shownCollapsedPaths,
    selectedPaths, selectPaths, toggleSelectedPath, selectPathRange, keepSelectionWithin,
    loadingFolderPaths, query, setQuery, visibleEntries: search.entries, matchCount: search.matchCount,
    searchHydrating, treeTruncated, toggleFolder, movingTreePaths, setMovingTreePaths, dropTargetFolderPath, setDropTargetFolderPath,
  };
}

async function refreshLoadedChildren(connectedFolderId: string, root: TreeEntry[], cached: TreeEntry[], collapsed: Set<string>, eventPaths?: string[]) {
  const loaded = collectLoadedFolderPaths(cached, collapsed, eventPaths);
  // Folders the refresh does not reload keep the rows they already had; an
  // event-scoped refresh reloads only the folders its paths touch.
  let next = keepLoadedChildren(root, cached);
  let truncated = false;
  for (const paths of groupTreePathsByDepth(loaded)) {
    const refreshable = paths.filter((path) => findTreeEntry(next, path));
    const batch = await refreshFolderBatch(connectedFolderId, refreshable);
    truncated ||= batch.truncated;
    for (const result of batch.results) if (result && findTreeEntry(next, result.path)) next = setTreeEntryChildren(next, result.path, keepLoadedChildren(result.children, cached));
  }
  return { tree: next, truncated };
}

async function refreshFolderBatch(connectedFolderId: string, paths: string[]) {
  const results = new Array<{ path: string; children: TreeEntry[] } | null>(paths.length).fill(null);
  let truncated = false;
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(loadedTreeRefreshConcurrency, paths.length) }, async () => {
    while (index < paths.length) {
      const current = index++; const path = paths[current]; if (!path) continue;
      try {
        const response = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(connectedFolderId, path, 0));
        results[current] = { path, children: response.tree };
        truncated ||= Boolean(response.truncated);
      }
      catch (caught) { if (!connectedFolderTreePathMissing(errorText(caught))) throw caught; }
    }
  }));
  return { results, truncated };
}

function treeApiPath(connectedFolderId: string, path: string, maxDepth: number) {
  const params = new URLSearchParams({ maxDepth: String(maxDepth), includeIgnored: "1" }); if (path) params.set("path", path);
  return `/api/connected-folders/${connectedFolderId}/tree?${params}`;
}

interface TreeState { selectedPath: string | null; collapsedPaths: Set<string> }
function treeStateKey(connectedFolderId: string) { return `amplefile.connected-folder.tree-ui:${connectedFolderId}`; }
function readTreeState(connectedFolderId: string): TreeState {
  return readStoredJsonValue(treeStateKey(connectedFolderId), (value) => {
    const record = (value && typeof value === "object" ? value : {}) as { selectedPath?: unknown; collapsedPaths?: unknown };
    return { selectedPath: typeof record.selectedPath === "string" ? record.selectedPath : null, collapsedPaths: new Set(Array.isArray(record.collapsedPaths) ? record.collapsedPaths.filter((path): path is string => typeof path === "string") : []) };
  }, { selectedPath: null, collapsedPaths: new Set<string>() });
}
function writeTreeState(connectedFolderId: string, state: { selectedPath: string | null; collapsedPaths: string[] }) { writeStoredJsonValue(treeStateKey(connectedFolderId), state); }
