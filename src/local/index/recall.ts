/**
 * Ranked search over one Connected Folder's index (docs/index-and-recall.md).
 *
 * Lexical candidates come from FTS5 (bm25) and semantic candidates from a
 * brute-force cosine scan of the folder's vectors; the two lists are merged by
 * reciprocal rank fusion with a small recency boost. Every hit is checked
 * against the disk when it is returned: a file whose size or modification
 * time no longer matches what was indexed is flagged `fresh: false` and
 * handed to `onStale` for re-indexing, never returned as current.
 *
 * `recallConnectedFolder` reads one folder's index and knows nothing of
 * other folders. Scores are rank-based, so a caller can run it over several
 * Connected Folders, tag each hit with its folder, and merge by score.
 */

import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";

import { conversationsDir } from "../agent/chat-store.js";
import { noEmbedder, normalizeVector, type ConnectedFolderIndexEmbedder } from "./embedder.js";
import { ConnectedFolderIndexStore, encodedVectorScorer, indexedFileStatuses, type ChunkLocation, type IndexedFileRow, type IndexedFileStatus } from "./store.js";

export type RecallKind = "files" | "chats";
export type RecallReason = "lexical" | "semantic";

export interface RecallOptions {
  /** Hits to return; default 10, at most 50. */
  limit?: number;
  /** Only files at or under this Connected Folder–relative path. */
  path?: string;
  /** Which sources to search; default both. */
  kinds?: readonly RecallKind[];
  /** A Connected Folder–relative file path: return its neighbours instead of matching a query. */
  similarTo?: string;
  embedder?: ConnectedFolderIndexEmbedder;
  signal?: AbortSignal;
  /** Told about each stale hit's path so the caller can queue it for re-indexing. */
  onStale?: (path: string) => void;
  /** The caller's knowledge of a sync in progress, reported in coverage. */
  running?: boolean;
}

interface RecallHitBase {
  /** Where to look inside the source. */
  location: ChunkLocation;
  /** A bounded excerpt of the matching chunk; read the original before relying on it. */
  excerpt: string;
  /** Fused rank score: comparable between hits of one result and across folders queried the same way. */
  score: number;
  reasons: RecallReason[];
  /** The content hash the excerpt was read from. */
  sha256: string;
  indexedAt: string | null;
  /** True when the source still matches what was indexed (checked at return). */
  fresh: boolean;
}

export interface RecallFileHit extends RecallHitBase {
  source: "file";
  path: string;
  /** The file's modification time as indexed. */
  modifiedAt?: string;
  /** Other paths holding exactly the same bytes. */
  duplicates?: string[];
}

export interface RecallChatHit extends RecallHitBase {
  source: "chat";
  conversationId: string;
  messageId: string;
  title: string;
  role: string;
  createdAt: string;
}

export type RecallHit = RecallFileHit | RecallChatHit;

export interface RecallCoverage {
  /** `not-indexed`: nothing is known yet; every count is then null, never zero. */
  state: "not-indexed" | "partial" | "complete";
  /** True when every indexable file and Chat was indexed and embedded and no bound left anything out. */
  complete: boolean;
  /** Files by status; null when the folder has never been indexed. */
  files: Record<IndexedFileStatus, number> | null;
  chatMessages: number | null;
  /**
   * Chunks, how many are prose and so embedded (`embeddable`; code and data
   * are ranked by words only), and how many of those the current embedder
   * has seen; null before the first sync.
   */
  chunks: { total: number; embedded: number; embeddable?: number } | null;
  /** The embedder whose vectors ranked this result, or `none`. */
  embedder: string;
  /**
   * `hybrid` when semantic candidates took part, `lexical` otherwise. In a
   * status read with no query, what a query would use now.
   */
  ranking: "hybrid" | "lexical";
  /** Why ranking was lexical only, when it was. */
  lexicalOnlyReason?: "embedder-unavailable" | "not-embedded-yet" | "no-query-vector";
  lastSyncAt: string | null;
  running: boolean;
  /** What the last walk left out and whether a bound stopped it; null before the first sync. */
  walk: { complete: boolean; stoppedBy: string | null; excluded: Record<string, number> } | null;
  /** Hits in this result that no longer match the disk. */
  staleHits: number;
}

export interface RecallResult {
  query: string;
  similarTo?: string;
  hits: RecallHit[];
  coverage: RecallCoverage;
}

const candidateCount = 200;
const rrfConstant = 60;
/** Cosine similarity below this is not a semantic match for NLEmbedding sentence vectors. */
const semanticFloor = 0.3;
/** The longest the vector scan runs before yielding to the event loop. */
const scanSliceMs = 12;
const maxExcerptCharacters = 320;

export async function recallConnectedFolder(connectedFolderRoot: string, rawQuery: string, options: RecallOptions = {}): Promise<RecallResult> {
  const query = rawQuery.trim();
  const similarTo = options.similarTo ? normalizeConnectedFolderPath(options.similarTo) : undefined;
  if (!query && !similarTo) throw Object.assign(new Error("Enter something to search for."), { statusCode: 400 });
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 10)));
  const kinds = new Set<RecallKind>(options.kinds?.length ? options.kinds : ["files", "chats"]);
  const prefix = options.path ? normalizeConnectedFolderPath(options.path) : "";
  const embedder = options.embedder ?? noEmbedder;
  aborted(options.signal);
  const store = ConnectedFolderIndexStore.open(connectedFolderRoot, { create: false });
  if (!store) {
    return { query, ...(similarTo ? { similarTo } : {}), hits: [], coverage: emptyCoverage(embedder, options.running ?? false) };
  }
  try {
    const coverage = readCoverage(store, embedder, options.running ?? false);
    // Lexical candidates.
    let lexicalTerms = query ? queryTerms(query) : [];
    let similarSha: string | null = null;
    let similarVectors: Array<{ language: string; vector: Float32Array }> = [];
    if (similarTo) {
      const row = store.getFile(similarTo);
      if (!row?.sha256 || row.status !== "indexed") {
        throw Object.assign(new Error("That file is not indexed yet."), { statusCode: 409 });
      }
      similarSha = row.sha256;
      if (!lexicalTerms.length) lexicalTerms = salientTerms(store.chunkTextsForSha(row.sha256, 3).join(" "));
      similarVectors = meanVectorsByLanguage(store.vectorsForSha(row.sha256, embedder.id));
    }
    const lexical = lexicalTerms.length
      ? store.lexical(lexicalTerms.map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" OR "), candidateCount)
      : [];
    // Semantic candidates.
    let semantic: Array<{ chunkId: number; score: number }> = [];
    const languages = store.vectorLanguages(embedder.id);
    if (embedder.available() && languages.length) {
      const queryVectors = similarTo
        ? similarVectors
        : (await embedder.embed(languages.map((language) => ({ text: query, language })), options.signal))
          .filter((vector): vector is NonNullable<typeof vector> => vector !== null);
      aborted(options.signal);
      if (queryVectors.length) {
        // A chunk matches by its best passage. The scan gives the event loop
        // back every few milliseconds, so a large folder never blocks the host.
        const bestByChunk = new Map<number, number>();
        let sliceStart = performance.now();
        for (const { language, vector } of queryVectors) {
          const score = encodedVectorScorer(vector);
          let rows = 0;
          for (const candidate of store.iterateEncodedVectors(embedder.id, language)) {
            const value = score(candidate.encoded);
            if (value >= semanticFloor && value > (bestByChunk.get(candidate.chunkId) ?? -1)) bestByChunk.set(candidate.chunkId, value);
            if (++rows % 1024 === 0 && performance.now() - sliceStart > scanSliceMs) {
              await new Promise((resolve) => setImmediate(resolve));
              aborted(options.signal);
              sliceStart = performance.now();
            }
          }
        }
        semantic = [...bestByChunk.entries()].map(([chunkId, score]) => ({ chunkId, score })).sort((a, b) => b.score - a.score).slice(0, candidateCount);
        coverage.ranking = "hybrid";
        delete coverage.lexicalOnlyReason;
      } else {
        coverage.ranking = "lexical";
        coverage.lexicalOnlyReason = "no-query-vector";
      }
    }
    // Fusion.
    const fused = new Map<number, { score: number; reasons: Set<RecallReason> }>();
    const add = (list: Array<{ chunkId: number }>, reason: RecallReason) => list.forEach((item, rank) => {
      const entry = fused.get(item.chunkId) ?? { score: 0, reasons: new Set<RecallReason>() };
      entry.score += 1 / (rrfConstant + rank + 1);
      entry.reasons.add(reason);
      fused.set(item.chunkId, entry);
    });
    add(lexical, "lexical");
    add(semantic, "semantic");
    // Resolve chunks to their sources, keeping each source's best chunk.
    const now = Date.now();
    const best = new Map<string, { hit: RecallHit; mtimeMs?: number; createdAt?: string; row?: IndexedFileRow }>();
    for (const [chunkId, entry] of [...fused.entries()].sort((a, b) => b[1].score - a[1].score)) {
      aborted(options.signal);
      const chunk = store.chunk(chunkId);
      if (!chunk || chunk.sha256 === similarSha) continue;
      const base = {
        location: chunk.location,
        excerpt: excerpt(chunk.text, lexicalTerms),
        reasons: [...entry.reasons].sort() as RecallReason[],
        sha256: chunk.sha256,
      };
      if (kinds.has("files")) {
        const files = store.filesWithSha(chunk.sha256).filter((file) => !prefix || file.path === prefix || file.path.startsWith(`${prefix}/`));
        if (files.length) {
          const [first, ...rest] = files;
          const key = `file:${chunk.sha256}`;
          const score = entry.score * recencyFactor(now - first!.mtimeMs);
          if (!best.has(key) || best.get(key)!.hit.score < score) {
            best.set(key, {
              hit: { source: "file", path: first!.path, ...(Number.isFinite(first!.mtimeMs) ? { modifiedAt: new Date(first!.mtimeMs).toISOString() } : {}), ...(rest.length ? { duplicates: rest.map((file) => file.path) } : {}), ...base, score, indexedAt: first!.indexedAt, fresh: true },
              row: first!,
            });
          }
        }
      }
      if (kinds.has("chats") && !prefix) {
        for (const message of store.chatMessagesWithSha(chunk.sha256)) {
          const key = `chat:${message.conversationId}:${message.messageId}`;
          const created = Date.parse(message.createdAt);
          const score = entry.score * recencyFactor(Number.isFinite(created) ? now - created : Number.POSITIVE_INFINITY);
          if (!best.has(key) || best.get(key)!.hit.score < score) {
            best.set(key, {
              hit: { source: "chat", conversationId: message.conversationId, messageId: message.messageId, title: message.title, role: message.role, createdAt: message.createdAt, ...base, score, indexedAt: null, fresh: true },
            });
          }
        }
      }
      if (best.size >= limit * 3) break;
    }
    const ranked = [...best.values()].sort((a, b) => b.hit.score - a.hit.score).slice(0, limit);
    // Freshness at return.
    for (const item of ranked) {
      if (item.hit.source === "file" && item.row) {
        const info = await lstat(join(connectedFolderRoot, item.hit.path)).catch(() => null);
        item.hit.fresh = Boolean(info?.isFile() && info.size === item.row.size && info.mtimeMs === item.row.mtimeMs);
        if (!item.hit.fresh) { coverage.staleHits++; options.onStale?.(item.hit.path); }
      } else if (item.hit.source === "chat") {
        const info = await stat(join(conversationsDir(connectedFolderRoot), `${item.hit.conversationId}.jsonl`)).catch(() => null);
        item.hit.fresh = Boolean(info?.isFile());
        if (!item.hit.fresh) coverage.staleHits++;
      }
    }
    return { query, ...(similarTo ? { similarTo } : {}), hits: ranked.map((item) => ({ ...item.hit, score: round(item.hit.score) })), coverage };
  } finally {
    store.close();
  }
}

/** The index's status without a query: the same coverage a ranked search reports. */
export function readConnectedFolderIndexCoverage(connectedFolderRoot: string, embedder: ConnectedFolderIndexEmbedder, running: boolean): RecallCoverage {
  const store = ConnectedFolderIndexStore.open(connectedFolderRoot, { create: false });
  if (!store) return emptyCoverage(embedder, running);
  try { return readCoverage(store, embedder, running); } finally { store.close(); }
}

function emptyCoverage(embedder: ConnectedFolderIndexEmbedder, running: boolean): RecallCoverage {
  return {
    state: "not-indexed", complete: false, files: null, chatMessages: null, chunks: null,
    embedder: embedder.available() ? embedder.id : "none", ranking: "lexical",
    lexicalOnlyReason: embedder.available() ? "not-embedded-yet" : "embedder-unavailable",
    lastSyncAt: null, running, walk: null, staleHits: 0,
  };
}

function readCoverage(store: ConnectedFolderIndexStore, embedder: ConnectedFolderIndexEmbedder, running: boolean): RecallCoverage {
  const lastSyncAt = store.getMeta("lastSyncAt");
  // Counts are known once a walk has been recorded, even before a pass finishes.
  if (!lastSyncAt && !store.getMeta("walk")) return emptyCoverage(embedder, running);
  const files = store.countFilesByStatus();
  const total = store.countChunks();
  const available = embedder.available();
  const embedded = available ? store.countEmbedded(embedder.id) : 0;
  const embeddable = store.countEmbeddableChunks();
  const vectors = available ? store.countVectors(embedder.id) : 0;
  let walk: RecallCoverage["walk"] = null;
  try { walk = JSON.parse(store.getMeta("walk") ?? "null") as RecallCoverage["walk"]; } catch { walk = null; }
  const chatsComplete = store.getMeta("chatsComplete") === "true";
  const complete = Boolean(walk?.complete) && files.pending === 0 && chatsComplete && (!available || embedded >= embeddable);
  return {
    state: complete ? "complete" : "partial",
    complete,
    files,
    chatMessages: store.countChatMessages(),
    chunks: { total, embedded, embeddable },
    embedder: available ? embedder.id : "none",
    // What a query would do now: the same rule `recallConnectedFolder` follows.
    ...(available && vectors > 0
      ? { ranking: "hybrid" as const }
      : { ranking: "lexical" as const, lexicalOnlyReason: available ? "not-embedded-yet" as const : "embedder-unavailable" as const }),
    lastSyncAt,
    running,
    walk,
    staleHits: 0,
  };
}

/** Words of the query as FTS5 terms, each quoted so no query text is read as FTS syntax. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const match of query.toLocaleLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (seen.size >= 24) break;
    seen.add(match[0]);
  }
  return [...seen];
}

const stopWords = new Set("about after also been before being between both could does each from have here into just like more most much must only other over same should some such than that their them then there these they this those through very what when where which while will with would your".split(" "));

function salientTerms(text: string): string[] {
  const counts = new Map<string, number>();
  for (const match of text.toLocaleLowerCase().matchAll(/[\p{L}][\p{L}\p{N}]{3,}/gu)) {
    if (!stopWords.has(match[0])) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 12).map(([word]) => word);
}

function meanVectorsByLanguage(vectors: Array<{ language: string; vector: Float32Array }>): Array<{ language: string; vector: Float32Array }> {
  const sums = new Map<string, Float32Array>();
  for (const { language, vector } of vectors) {
    const sum = sums.get(language) ?? new Float32Array(vector.length);
    for (let index = 0; index < vector.length; index++) sum[index]! += vector[index]!;
    sums.set(language, sum);
  }
  return [...sums.entries()].flatMap(([language, sum]) => {
    const vector = normalizeVector(sum);
    return vector ? [{ language, vector }] : [];
  });
}

/** Up to 10% more for something changed today, fading over a few months. */
function recencyFactor(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 1;
  return 1 + 0.1 * Math.exp(-ageMs / (90 * 24 * 60 * 60 * 1000));
}

function excerpt(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= maxExcerptCharacters) return flat;
  const lower = flat.toLocaleLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = at < 0 ? 0 : Math.max(0, at - 100);
  const body = flat.slice(start, start + maxExcerptCharacters).trim();
  return `${start ? "…" : ""}${body}${start + maxExcerptCharacters < flat.length ? "…" : ""}`;
}

/** A Connected Folder–relative path as the index stores it: `/`-separated, no leading or trailing slash. */
function normalizeConnectedFolderPath(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".");
  if (segments.includes("..")) throw Object.assign(new Error("A search path must stay inside the Connected Folder."), { statusCode: 400 });
  return segments.join("/");
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Search cancelled."), { name: "AbortError" });
}

export { indexedFileStatuses };
