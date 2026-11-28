import { useEffect, useId, useState } from "react";
import { Chat16Regular } from "@fluentui/react-icons";

import { api } from "../../lib/api";
import type { ConnectedFolderIndexStatus } from "../../../../src/local/index/indexer";
import type { RecallCoverage, RecallFileHit, RecallHit, RecallResult } from "../../../../src/local/index/recall";
import { EntryIcon } from "./FileEntries";
import { parentPath } from "./file-manager-model";
import { readableLine } from "./useFileManagerSearch";
import "./file-manager-index.css";

/**
 * What the window shows of a Connected Folder's index (docs/index-and-recall.md,
 * "The window"): Best Matches in Search, a status row in Info, and Related for a
 * selected file. The host ranks and counts; this file only words and draws it.
 * Unknown is never shown as zero, and a lexical-only ranking is never announced.
 */

/** One ranked hit and the Connected Folder it came from. */
export interface BestMatch { connectedFolderId: string; hit: RecallHit }

const number = new Intl.NumberFormat("en-US");
const count = (value: number) => number.format(value);

/** A hit's place in its source in plain words: "Page 3", "Lines 12–18", a sheet, a heading. */
export function recallLocationText(hit: Pick<RecallHit, "location">): string {
  const { location } = hit;
  const range = (start: number, end: number, one: string, many: string) => start === end ? `${one} ${start}` : `${many} ${start}–${end}`;
  const place = location.page !== undefined ? `Page ${location.page}`
    : location.slide !== undefined ? `Slide ${location.slide}`
    : location.sheet !== undefined ? `Sheet “${location.sheet}”${location.rows ? `, ${range(location.rows.start, location.rows.end, "row", "rows")}` : ""}`
    : location.lines ? range(location.lines.start, location.lines.end, "Line", "Lines")
    : location.paragraphs ? range(location.paragraphs.start, location.paragraphs.end, "Paragraph", "Paragraphs")
    : location.part !== undefined ? `Part ${location.part}`
    : "";
  const heading = location.headings?.length ? `“${location.headings[location.headings.length - 1]}”` : "";
  return [place, heading].filter(Boolean).join(" · ");
}

/** The coverage of every folder a search asked, as the one quiet line under Best Matches; null when nothing needs saying. */
export function rankedNoteText(coverages: readonly RecallCoverage[]): string | null {
  if (!coverages.length || coverages.every((coverage) => coverage.complete && !coverage.running)) return null;
  const known = coverages.every((coverage) => coverage.files);
  const total = known ? coverages.reduce((sum, coverage) => sum + filesTotal(coverage.files!), 0) : 0;
  const indexed = known ? coverages.reduce((sum, coverage) => sum + coverage.files!.indexed, 0) : 0;
  const catchingUp = coverages.some((coverage) => coverage.running || coverage.state === "not-indexed" || (coverage.files?.pending ?? 0) > 0);
  if (!catchingUp) return "Not every file is in the index, so results may be incomplete.";
  return known && total > 0 ? `Still indexing (${count(indexed)} of ${count(total)} files); results may be incomplete.` : "Still indexing; results may be incomplete.";
}

function filesTotal(files: NonNullable<RecallCoverage["files"]>): number {
  return Object.values(files).reduce((sum, value) => sum + value, 0);
}

function hitName(hit: RecallHit): string {
  return hit.source === "chat" ? hit.title || "Chat" : hit.path.split("/").pop() || hit.path;
}

/** Best Matches above the name and text results: each hit's name and place, where in it, and the excerpt. */
export function BestMatches({ matches, note, folderName, onOpen }: {
  matches: readonly BestMatch[];
  note: string | null;
  /** Names the Connected Folder of each hit; given only when more than one Connected Folder was searched. */
  folderName?: (connectedFolderId: string) => string;
  onOpen: (match: BestMatch) => void;
}) {
  const headingId = useId();
  if (!matches.length && !note) return null;
  return <section className="fm-best" aria-labelledby={headingId}>
    {matches.length ? <h2 className="fm-best-h" id={headingId}>Best Matches</h2> : null}
    {matches.length ? <ul className="fm-best-list">
      {matches.map((match, index) => {
        const { hit } = match;
        const place = hit.source === "chat"
          ? ["Chat", ...(folderName ? [folderName(match.connectedFolderId)] : [])].join(" · ")
          : [...(folderName ? [folderName(match.connectedFolderId)] : []), ...parentPath(hit.path).split("/").filter(Boolean)].join(" › ");
        const location = recallLocationText(hit);
        const excerpt = readableLine(hit.excerpt);
        return <li key={`${match.connectedFolderId}\0${hit.source === "chat" ? `${hit.conversationId}\0${hit.messageId}` : hit.path}\0${index}`}>
          <button type="button" className="fm-best-hit" onClick={() => onOpen(match)}>
            <span className="fm-best-icon" aria-hidden="true">{hit.source === "chat" ? <Chat16Regular /> : <EntryIcon entry={{ name: hitName(hit), path: hit.path, kind: "file" }} />}</span>
            <span className="fm-best-text">
              <span className="fm-best-title">
                <span className="fm-best-name">{hitName(hit)}</span>
                {place ? <span className="fm-best-where">{place}</span> : null}
              </span>
              {location || !hit.fresh ? <span className="fm-best-meta">
                {location ? <span>{location}</span> : null}
                {!hit.fresh ? <span className="fm-best-stale" title="This file has changed since it was indexed. Open it to see what it says now.">Changed since indexed</span> : null}
              </span> : null}
              {excerpt ? <span className="fm-best-excerpt">{excerpt}</span> : null}
            </span>
          </button>
        </li>;
      })}
    </ul> : null}
    {note ? <p className="fm-best-note" role="status">{note}</p> : null}
  </section>;
}

/** The reasons a file is not in the index, in the order Info lists them. */
const skippedReasons: ReadonlyArray<[keyof NonNullable<RecallCoverage["files"]>, (n: number) => string]> = [
  ["pending", (n) => `${count(n)} waiting to be indexed`],
  ["not-downloaded", (n) => `${count(n)} not downloaded`],
  ["too-large", (n) => `${count(n)} too large`],
  ["unsupported", (n) => `${count(n)} of a kind that can’t be read`],
  ["binary", (n) => `${count(n)} not text`],
  ["unreadable", (n) => `${count(n)} couldn’t be read`],
];

/** The text of Info's index row, and the reasons behind it; null while nothing is known. */
export function indexStatusText(status: Pick<RecallCoverage, "state" | "files" | "running" | "walk" | "chatMessages">): { summary: string; reasons: string[] } | null {
  const reasons: string[] = [];
  if (status.files) {
    for (const [key, say] of skippedReasons) if (status.files[key] > 0) reasons.push(say(status.files[key]));
    if (status.walk && !status.walk.complete) reasons.push("The folder is larger than the index reads, so some files were not seen");
  }
  if (status.chatMessages) reasons.push(`${count(status.chatMessages)} Chat ${status.chatMessages === 1 ? "message" : "messages"} indexed`);
  if (status.state === "not-indexed" || !status.files) return { summary: status.running ? "Indexing…" : "Not indexed yet", reasons: [] };
  const total = filesTotal(status.files);
  const indexed = status.files.indexed;
  if (!total) return { summary: status.running ? "Indexing…" : "No files to index", reasons };
  const counts = `${count(indexed)} of ${count(total)} ${total === 1 ? "file" : "files"} indexed`;
  return { summary: status.running ? `Indexing… ${counts}` : counts, reasons };
}

const pollMs = 3000;

/** Info's index row for a Connected Folder at its top level: how much of it the index holds, and why not the rest. */
export function IndexStatusRow({ connectedFolderId, fixtureMode, fixtureStatus = null }: {
  connectedFolderId: string;
  fixtureMode: boolean;
  fixtureStatus?: ConnectedFolderIndexStatus | null;
}) {
  const [loaded, setLoaded] = useState<{ id: string; status: ConnectedFolderIndexStatus } | null>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const status = fixtureMode ? fixtureStatus : loaded?.id === connectedFolderId ? loaded.status : null;

  useEffect(() => { setOpen(false); }, [connectedFolderId]);
  useEffect(() => {
    if (fixtureMode) return;
    let cancelled = false;
    let timer: number | undefined;
    const read = () => {
      void api<{ index: ConnectedFolderIndexStatus }>(`/api/connected-folders/${encodeURIComponent(connectedFolderId)}/index`)
        .then(({ index }) => {
          if (cancelled) return;
          setLoaded({ id: connectedFolderId, status: index });
          // While a sync runs the counts move; read again until it stops.
          if (index.running) timer = window.setTimeout(read, pollMs);
        })
        .catch(() => undefined);
    };
    read();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connectedFolderId, fixtureMode]);

  if (!status) return null;
  const text = indexStatusText(status);
  if (!text) return null;
  const title = text.reasons.length ? text.reasons.join("\n") : undefined;
  return <section className="fm-sec fm-index" aria-label="Index">
    <div className="fm-card">
      <div className="fm-crow fm-index-row" title={title}>
        <span className="fm-crow-n fm-index-text" aria-live="polite">{text.summary}</span>
        {text.reasons.length ? <button type="button" className="fm-text-button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>{open ? "Hide Details" : "Details"}</button> : null}
      </div>
      {open && text.reasons.length ? <ul className="fm-index-reasons" id={listId}>{text.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
    </div>
  </section>;
}

const settleMs = 300;
const relatedLimit = 5;

/** The files that read most like the selected one, from the index; hidden when there are none. */
export function RelatedFiles({ connectedFolderId, path, fixtureMode, fixtureRelated, onShow }: {
  connectedFolderId: string;
  path: string;
  fixtureMode: boolean;
  fixtureRelated?: Record<string, RecallFileHit[]>;
  onShow: (path: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ key: string; hits: RecallFileHit[] } | null>(null);
  const key = `${connectedFolderId}\0${path}`;
  useEffect(() => {
    // Fetched once the selection settles, not on every arrow-key move.
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const done = (hits: RecallHit[]) => {
        if (controller.signal.aborted) return;
        const seen = new Set([path]);
        const files = hits.flatMap((hit) => hit.source === "file" && !seen.has(hit.path) ? (seen.add(hit.path), [hit]) : []);
        setLoaded({ key, hits: files.slice(0, relatedLimit) });
      };
      if (fixtureMode) { done(fixtureRelated?.[path] ?? []); return; }
      void api<{ ranked?: RecallResult }>(`/api/connected-folders/${encodeURIComponent(connectedFolderId)}/search?similarTo=${encodeURIComponent(path)}&rankedLimit=${relatedLimit + 3}`, { signal: controller.signal })
        .then((result) => done(result.ranked?.hits ?? []))
        .catch(() => { if (!controller.signal.aborted) setLoaded({ key, hits: [] }); });
    }, settleMs);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [connectedFolderId, path, fixtureMode, fixtureRelated, key]);

  const hits = loaded?.key === key ? loaded.hits : [];
  if (!hits.length) return null;
  return <section className="fm-sec fm-related" aria-label="Related">
    <h2 className="fm-sec-h">Related</h2>
    <div className="fm-card">
      {hits.map((hit) => {
        const dir = parentPath(hit.path);
        return <button type="button" className="fm-crow fm-related-row" key={hit.path} title={hit.path} onClick={() => onShow(hit.path)}>
          <span className="fm-related-icon" aria-hidden="true"><EntryIcon entry={{ name: hitName(hit), path: hit.path, kind: "file" }} /></span>
          <span className="fm-crow-t">
            <span>{hitName(hit)}</span>
            {dir ? <span className="fm-crow-s">{dir.split("/").join(" › ")}</span> : null}
          </span>
        </button>;
      })}
    </div>
  </section>;
}
