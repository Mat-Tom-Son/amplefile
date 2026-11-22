import { useCallback, useEffect, useRef, useState } from "react";

import { api, createEventSource, errorText } from "../../lib/api";
import { eventPathTouchesFolder, findTreeEntry } from "../../lib/tree";
import type { TreeEntry, ConnectedFolderFileEvent } from "../../types";
import { placeApiBase, placeEventsUrl, placeKey, type FileManagerPlace } from "./file-manager-places";
import { folderListingMaxEntries, isHiddenName } from "./file-manager-layout";

export type FolderListingStatus = "loading" | "ready" | "error";

interface ListingState {
  key: string;
  entries: TreeEntry[];
  status: FolderListingStatus;
  truncated: boolean;
  error: string | null;
}

const refreshDelayMs = 200;

/**
 * One folder's contents, one level deep, as the file manager shows them: the
 * same `/tree` route Files uses, asked for a single level, for a Connected Folder
 * or a standard folder. File events keep it current; a refresh never blanks
 * rows already shown.
 *
 * Every listing asks for symbolic links (shown, never followed) and for the
 * host's largest one-level bound, so an ordinary large folder is complete.
 * Hidden entries come marked `hidden`: a Connected Folder's listing always
 * carries them, so it asks for the marker every time; a Standard Folder's
 * leaves them out unless `showHidden` asks, and so do its file events. The
 * window decides what to show from the marker.
 */
export function useFolderListing(place: FileManagerPlace, path: string, fixtureTree?: TreeEntry[], options: { showHidden?: boolean } = {}) {
  const key = `${placeKey(place)}\0${path}`;
  const apiBase = placeApiBase(place);
  const askHidden = place.kind === "connected-folder" || Boolean(options.showHidden);
  const eventsUrl = placeEventsUrl(place, path, { includeHidden: askHidden });
  const [state, setState] = useState<ListingState>(() => ({ key, entries: [], status: "loading", truncated: false, error: null }));
  const requestRef = useRef(0);
  // The answer shown last. An answer to an older request is dropped once this folder shows anything, but while it
  // still says Loading the first answer back is shown, and a later one replaces it.
  const shownRef = useRef<{ key: string; request: number } | null>(null);
  // A large folder takes a while to list; a refresh asked for meanwhile waits for it instead of racing it.
  const inFlightRef = useRef<{ key: string; request: number } | null>(null);
  const queuedRef = useRef(false);
  // Counts file changes anywhere in the place, so History can reload when a
  // change it records (a delete, a Worker's edit) happens outside this folder.
  const [changeCount, setChangeCount] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const requestKey = key;
    if (fixtureTree) {
      const folder = path ? findTreeEntry(fixtureTree, path) : null;
      const children = path ? folder?.children ?? [] : fixtureTree;
      // The preview's sample folders carry no marker; their names say what is hidden.
      setState({ key: requestKey, entries: children.map((entry) => markHiddenByName(withoutChildren(entry))), status: "ready", truncated: false, error: null });
      return;
    }
    inFlightRef.current = { key: requestKey, request };
    try {
      const query = new URLSearchParams({ maxDepth: "0", includeLinks: "1", maxEntries: String(folderListingMaxEntries) });
      if (askHidden) query.set("includeHidden", "1");
      if (path) query.set("path", path);
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(`${apiBase}/tree?${query.toString()}`);
      if (keyRef.current !== requestKey) return;
      const shown = shownRef.current;
      if (request !== requestRef.current && shown?.key === requestKey) return;
      if (shown?.key === requestKey && request < shown.request) return;
      shownRef.current = { key: requestKey, request };
      setState({ key: requestKey, entries: result.tree.map(withoutChildren), status: "ready", truncated: Boolean(result.truncated), error: null });
    } catch (caught) {
      if (request !== requestRef.current || keyRef.current !== requestKey) return;
      setState((current) => ({ ...current, key: requestKey, status: current.key === requestKey && current.status === "ready" ? "ready" : "error", error: errorText(caught) }));
    } finally {
      if (inFlightRef.current?.request === request) inFlightRef.current = null;
      // A file event or the watcher's ready came in while this was out: list once more, now that it is back.
      if (queuedRef.current && !inFlightRef.current && keyRef.current === requestKey) {
        queuedRef.current = false;
        void loadRef.current();
      }
    }
  }, [apiBase, askHidden, fixtureTree, key, path]);

  // The subscription lives as long as the place (a Connected Folder's events
  // cover all of it), not the folder shown: navigating inside it must not
  // rebuild the shared event connection. The handler reads the folder shown.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setState((current) => current.key === key ? current : { key, entries: [], status: "loading", truncated: false, error: null });
    queuedRef.current = false;
    if (shownRef.current?.key !== key) shownRef.current = null;
    void load();
  }, [key, load]);
  const pathRef = useRef(path);
  pathRef.current = path;

  // File watchers have no replay cursor, so every "ready" requeries too.
  useEffect(() => {
    if (fixtureTree) return;
    let timer: number | null = null;
    let changeTimer: number | null = null;
    const noteChange = () => {
      if (changeTimer !== null) window.clearTimeout(changeTimer);
      changeTimer = window.setTimeout(() => { changeTimer = null; setChangeCount((count) => count + 1); }, 400);
    };
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (inFlightRef.current?.key === keyRef.current) { queuedRef.current = true; return; }
        void loadRef.current();
      }, refreshDelayMs);
    };
    const source = createEventSource(eventsUrl);
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ConnectedFolderFileEvent;
        if (parsed.type === "ready") return schedule();
        if (parsed.type !== "file_event") return;
        noteChange();
        if (!parsed.path || eventPathTouchesFolder(parsed.path, pathRef.current)) schedule();
      } catch {
        schedule();
      }
    };
    return () => { source.close(); if (timer !== null) window.clearTimeout(timer); if (changeTimer !== null) window.clearTimeout(changeTimer); };
  }, [eventsUrl, fixtureTree]);

  const shown = state.key === key ? state : { key, entries: [], status: "loading" as const, truncated: false, error: null };

  /** Rows already handled here (a delete waiting on Undo) leave at once. */
  const removeLocally = useCallback((paths: ReadonlySet<string>) => {
    setState((current) => ({ ...current, entries: current.entries.filter((entry) => !paths.has(entry.path)) }));
  }, []);

  return { ...shown, changeCount, refresh: load, removeLocally };
}

function markHiddenByName(entry: TreeEntry): TreeEntry {
  return entry.hidden || !isHiddenName(entry.name) ? entry : { ...entry, hidden: true };
}

function withoutChildren(entry: TreeEntry): TreeEntry {
  if (!entry.children) return entry;
  const { children, ...rest } = entry;
  return { ...rest, hasChildren: rest.hasChildren ?? children.length > 0 };
}
