import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import type { TreeEntry, ConnectedFolderSummary } from "../../types";
import type { RecallCoverage, RecallResult } from "../../../../src/local/index/recall";
import type { FileManagerPlace } from "./file-manager-places";
import type { BestMatch } from "./ConnectedFolderIndex";

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
/** Best Matches shown at most, across every Connected Folder searched. */
const bestMatchLimit = 8;
interface SearchPage {
  names: TreeEntry[];
  files: Array<{ path: string; line: number; preview: string }>;
  /** The index's ranked hits, when the Connected Folder could answer. */
  ranked?: RecallResult;
}

/** Ranked hits for the search, merged by score across folders, with the coverage of each folder that answered. */
export interface BestMatches { matches: BestMatch[]; coverages: RecallCoverage[] }

/**
 * Search names and contents, as the design does: in the folder shown, or in
 * every Connected Folder. The host supplies both kinds of match through the
 * same search the CLI uses.
 */
export function useFileManagerSearch(input: {
  query: string;
  scope: FileManagerSearchScope;
  here: { connectedFolder: ConnectedFolderSummary; path: string } | null;
  connectedFolders: readonly ConnectedFolderSummary[];
  enabled: boolean;
  /** The browser preview's sample trees and file text, searched in place of the host. */
  fixture?: { trees: Record<string, TreeEntry[]>; fileContents: Record<string, Record<string, string>>; recall?: { rankedFor: (id: string, needle: string) => RecallResult } } | null;
}) {
  const { query, scope, here, connectedFolders, enabled, fixture } = input;
  const [results, setResults] = useState<FileManagerSearchResult[]>([]);
  const [best, setBest] = useState<BestMatches | null>(null);
  const [status, setStatus] = useState<"idle" | "searching" | "done">("idle");
  const needle = query.trim();
  const targets = scope === "here" && here ? [here] : connectedFolders.map((connectedFolder) => ({ connectedFolder, path: "" }));
  const targetKey = targets.map((target) => `${target.connectedFolder.id}\0${target.path}`).join("|");

  useEffect(() => {
    if (!enabled || !needle) { setResults([]); setBest(null); setStatus("idle"); return; }
    const controller = new AbortController();
    setStatus("searching");
    const timer = window.setTimeout(() => {
      void Promise.all(targets.map(async ({ connectedFolder, path }) => {
        const base = `/api/connected-folders/${encodeURIComponent(connectedFolder.id)}`;
        // The ranked search rides on the same request. The live search stays on files; the ranked part also covers
        // Chats at a folder's top (Chats are not under a path, so inside a subfolder it asks for files alone).
        const query = new URLSearchParams({ q: needle, scope: "files", ranked: "1", rankedScope: path ? "files" : "all", rankedLimit: String(bestMatchLimit) });
        if (path) query.set("path", path);
        const page = fixture
          ? { ...searchFixture(fixture, connectedFolder.id, path, needle), ...(fixture.recall ? { ranked: fixture.recall.rankedFor(connectedFolder.id, needle) } : {}) }
          : await api<SearchPage>(`${base}/search?${query}`, { signal: controller.signal }).catch(() => null);
        if (controller.signal.aborted) return null;
        const names = (page?.names ?? []).map((entry) => resultFor(connectedFolder.id, entry, { kind: "name" }));
        const named = new Set(names.map((result) => result.path));
        const seen = new Set<string>();
        const texts: FileManagerSearchResult[] = [];
        for (const match of page?.files ?? []) {
          if (named.has(match.path) || seen.has(match.path)) continue;
          seen.add(match.path);
          const entry = { name: match.path.split("/").pop() ?? match.path, path: match.path, kind: "file" as const };
          texts.push(resultFor(connectedFolder.id, entry, { kind: "content", ...snippet(match.preview, needle) }));
        }
        return { names, texts, ranked: page?.ranked ? { connectedFolderId: connectedFolder.id, ranked: page.ranked } : null };
      })).then((perConnectedFolder) => {
        if (controller.signal.aborted) return;
        // Every name match first, then every text match, as the design lists them.
        setResults([...perConnectedFolder.flatMap((item) => item?.names ?? []), ...perConnectedFolder.flatMap((item) => item?.texts ?? [])]);
        const answered = perConnectedFolder.flatMap((item) => item?.ranked ? [item.ranked] : []);
        setBest(answered.length ? {
          // Scores are rank-based and comparable across folders asked the same way.
          matches: answered.flatMap(({ connectedFolderId, ranked }) => ranked.hits.map((hit) => ({ connectedFolderId, hit })))
            .sort((left, right) => right.hit.score - left.hit.score).slice(0, bestMatchLimit),
          coverages: answered.map(({ ranked }) => ranked.coverage),
        } : null);
        setStatus("done");
      });
    }, debounceMs);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [enabled, needle, targetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { results, status, best };
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
