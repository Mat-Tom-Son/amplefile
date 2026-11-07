import { useEffect, useMemo, useRef, useState } from "react";

import { pagesClient, type PageSummary } from "../lib/pages";
import { subscribeConnectedFolderFileChanges } from "../lib/connected-folder-file-events";

const noPages: ReadonlyMap<string, PageSummary> = new Map();

/**
 * The page folders in a Connected Folder, by path, for Files (docs/pages.md): a
 * folder holding page.json shows a page icon and opens its page tab. Reread
 * shortly after files change, since any folder can become a page.
 */
export function useConnectedFolderPages(connectedFolderId: string, fixtureMode: boolean): ReadonlyMap<string, PageSummary> {
  const [state, setState] = useState<{ connectedFolderId: string; pages: PageSummary[] }>({ connectedFolderId, pages: [] });
  const generationRef = useRef(0);

  useEffect(() => {
    const client = pagesClient(fixtureMode);
    let disposed = false;
    let timer: number | null = null;
    const read = () => {
      const generation = ++generationRef.current;
      void client.list(connectedFolderId).then((pages) => {
        if (disposed || generation !== generationRef.current) return;
        setState((current) => current.connectedFolderId === connectedFolderId && samePages(current.pages, pages) ? current : { connectedFolderId, pages });
      }).catch(() => {
        // An older local API without pages, or a passing hiccup: Files keeps
        // showing ordinary folders.
        if (!disposed && generation === generationRef.current) setState((current) => current.connectedFolderId === connectedFolderId ? current : { connectedFolderId, pages: [] });
      });
    };
    read();
    if (fixtureMode) return () => { disposed = true; };
    const unsubscribe = subscribeConnectedFolderFileChanges(connectedFolderId, (change) => {
      if (!pageListChange(change.path)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; read(); }, 700);
    });
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [fixtureMode, connectedFolderId]);

  return useMemo(() => state.connectedFolderId !== connectedFolderId || !state.pages.length
    ? noPages
    : new Map(state.pages.map((page) => [page.path, page])), [state, connectedFolderId]);
}

/**
 * Only page.json, or a folder appearing, moving, or going away, can change
 * which folders are pages; edits to a page's other files can't.
 */
export function pageListChange(path: string | null): boolean {
  if (path === null) return true;
  const name = path.split("/").pop() ?? "";
  return name === "page.json" || !/\.[^.]+$/.test(name);
}

function samePages(left: readonly PageSummary[], right: readonly PageSummary[]): boolean {
  return left.length === right.length && left.every((page, index) => {
    const other = right[index];
    return other && other.path === page.path && other.title === page.title && other.problemCount === page.problemCount;
  });
}
