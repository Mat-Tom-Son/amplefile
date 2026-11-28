/**
 * `recall`: a Worker's ranked search over its Connected Folder's index
 * (docs/index-and-recall.md). It returns pointers, not content: where to look,
 * why it matched, how old it is, whether it still matches the disk, and a
 * short excerpt, plus one line on what the index does not cover yet.
 *
 * `scope: "tree"` also asks the indexes of the Connected Folders nested
 * inside this one, at any depth, and groups hits by the folder that owns
 * them with its id, name, path, and Role purpose. Nested Workers' Chats are
 * never searched; their files are, because they sit inside this folder.
 * Changing a nested folder's files still goes through a handoff.
 *
 * The result is bounded: at most 20 hits, each excerpt at most 240
 * characters, and at most 20 not-yet-indexed folders named.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { RecallAcrossFolderRef, RecallAcrossResult } from "../index/recall-across.js";
import type { RecallHit, RecallKind } from "../index/recall.js";
import type { ChunkLocation } from "../index/store.js";

export type RecallToolScope = "folder" | "tree";

export interface RecallToolInput {
  query: string;
  path?: string;
  kinds?: RecallKind[];
  limit: number;
  scope: RecallToolScope;
}

export interface RecallToolHost {
  /** Ranked search over this Connected Folder (and, for `tree`, its nested ones); the caller's own folder has path "". */
  recall(input: RecallToolInput, signal?: AbortSignal): Promise<RecallAcrossResult>;
}

export const recallToolName = "recall";
export const recallToolMaxLimit = 20;
export const recallToolDefaultLimit = 8;
const maxQueryCharacters = 1_000;
const maxExcerptCharacters = 240;
const maxNamedFolders = 20;

export const recallToolDescription = [
  "Find where something is in this Connected Folder's files and Chats, by words and by meaning, from the index AmpleFile keeps on this computer.",
  "It returns pointers, not content: a path relative to this Connected Folder (or a Chat), where inside it, why it matched, how old it is, whether it is still fresh, and a short excerpt, plus a coverage line.",
  "Read the original before relying on or quoting anything; an excerpt is only a pointer.",
  "A hit with fresh:false changed since it was indexed: read it again. A missing hit is not proof of absence: coverage says what is not indexed yet (still catching up, not downloaded, a kind the index does not read), so look again with grep or search when it matters.",
  "scope \"tree\" also searches the files of the Connected Folders nested inside this one, at any depth, and groups hits by the nested folder that owns them with its id, name, path and Role purpose: use it to find which nested Worker holds something. You may read a nested folder's file a hit names; changing it goes to that folder's Worker with chat_handoff. Nested Workers' Chats are never searched.",
].join(" ");

export const recallToolParameters = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: maxQueryCharacters, description: "What to look for, in words or as a description of the meaning." },
    path: { type: "string", description: "Only files at or under this path, relative to this Connected Folder." },
    kinds: { type: "array", items: { type: "string", enum: ["files", "chats"] }, uniqueItems: true, description: "Which sources to search; default both." },
    limit: { type: "integer", minimum: 1, maximum: recallToolMaxLimit, description: `How many hits; default ${recallToolDefaultLimit}, at most ${recallToolMaxLimit}.` },
    scope: { type: "string", enum: ["folder", "tree"], description: "folder (default): this Connected Folder. tree: also the Connected Folders nested inside it, grouped by owner." },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/** Validates the model's arguments into a bounded input; throws a plain message for the model to correct. */
export function parseRecallToolInput(params: unknown, allowed: readonly RecallToolScope[] = ["folder", "tree"]): RecallToolInput {
  const value = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const query = typeof value.query === "string" ? value.query.trim() : "";
  if (!query) throw new Error("recall needs a query.");
  if (query.length > maxQueryCharacters) throw new Error(`Keep the query under ${maxQueryCharacters} characters.`);
  const scope = value.scope === undefined || value.scope === null ? "folder" : value.scope;
  if (scope !== "folder" && scope !== "tree") throw new Error("scope must be folder or tree.");
  if (!allowed.includes(scope)) throw new Error(`scope ${scope} is not available here.`);
  let limit = recallToolDefaultLimit;
  if (value.limit !== undefined && value.limit !== null) {
    if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1) throw new Error(`limit must be a whole number from 1 to ${recallToolMaxLimit}.`);
    limit = Math.min(recallToolMaxLimit, value.limit);
  }
  let kinds: RecallKind[] | undefined;
  if (value.kinds !== undefined && value.kinds !== null) {
    if (!Array.isArray(value.kinds) || value.kinds.some((kind) => kind !== "files" && kind !== "chats")) throw new Error("kinds may hold files and chats.");
    kinds = [...new Set(value.kinds as RecallKind[])];
  }
  const path = typeof value.path === "string" && value.path.trim() ? value.path.trim() : undefined;
  return { query, limit, scope, ...(path ? { path } : {}), ...(kinds?.length ? { kinds } : {}) };
}

export function createRecallTool(host: RecallToolHost): ToolDefinition<any> {
  return {
    name: recallToolName,
    label: "Recall",
    description: recallToolDescription,
    promptSnippet: "Find where something is in this Connected Folder (and nested ones) by words and meaning",
    promptGuidelines: [
      "Use recall to find where to look before reading: it points at files and Chats, then read the original before relying on or quoting it. A stale hit means read it again; coverage says what the index has not read.",
      "Use recall with scope tree to find which nested Connected Folder's Worker holds something; hand changes to that Worker with chat_handoff.",
    ],
    parameters: recallToolParameters as any,
    executionMode: "parallel",
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const input = parseRecallToolInput(params);
      const result = await host.recall(input, signal);
      const presented = presentRecallResult(input, result);
      return { content: [{ type: "text" as const, text: JSON.stringify(presented, null, 1) }], details: { scope: input.scope, hits: countHits(result), folders: result.searched } };
    },
  } as ToolDefinition<any>;
}

/** The pointer a model reads for one hit; paths are relative to the caller's own folder. */
export interface RecallPointer {
  path?: string;
  chat?: string;
  conversationId?: string;
  messageId?: string;
  role?: string;
  at?: string;
  matched: string;
  modified?: string;
  written?: string;
  fresh: boolean;
  excerpt: string;
  sameBytesAlsoAt?: string[];
}

export interface RecallPresentation {
  query: string;
  scope?: "tree";
  hits?: RecallPointer[];
  folders?: Array<{ connectedFolder: string; name: string; path: string; role?: string; hits: RecallPointer[] }>;
  notIndexed?: Array<{ connectedFolder: string; name: string; path: string; role?: string }>;
  coverage: string;
}

/** The bounded, model-facing shape of a recall result. */
export function presentRecallResult(input: Pick<RecallToolInput, "scope">, result: RecallAcrossResult, now = Date.now()): RecallPresentation {
  if (input.scope === "folder") {
    const hits = result.groups.flatMap((group) => group.hits.map((hit) => pointer(hit, group.connectedFolder.path ?? "", now)));
    return { query: result.query, hits, coverage: coverageLine(input.scope, result) };
  }
  const named = result.notIndexed.slice(0, maxNamedFolders).map((folder) => ({ ...folderFields(folder) }));
  return {
    query: result.query,
    scope: "tree",
    folders: result.groups.map((group) => ({
      ...folderFields(group.connectedFolder),
      hits: group.hits.map((hit) => pointer(hit, group.connectedFolder.path ?? "", now)),
    })),
    ...(named.length ? { notIndexed: named } : {}),
    coverage: coverageLine(input.scope, result),
  };
}

function folderFields(folder: RecallAcrossFolderRef): { connectedFolder: string; name: string; path: string; role?: string } {
  return { connectedFolder: folder.id, name: folder.name, path: folder.path ? folder.path : ".", ...(folder.rolePurpose ? { role: folder.rolePurpose } : {}) };
}

function pointer(hit: RecallHit, folderPath: string, now: number): RecallPointer {
  const at = describeLocation(hit.location);
  const matched = hit.reasons.length === 2 ? "words and meaning" : hit.reasons[0] === "semantic" ? "meaning" : "words";
  const excerpt = bounded(hit.excerpt, maxExcerptCharacters);
  if (hit.source === "chat") {
    return {
      chat: bounded(hit.title || "Untitled Chat", 120), conversationId: hit.conversationId, messageId: hit.messageId, role: hit.role,
      ...(at ? { at } : {}), matched, written: age(hit.createdAt, now), fresh: hit.fresh, excerpt,
    };
  }
  const join = (path: string) => (folderPath ? `${folderPath}/${path}` : path);
  return {
    path: join(hit.path),
    ...(at ? { at } : {}),
    matched,
    ...(hit.modifiedAt ? { modified: age(hit.modifiedAt, now) } : hit.indexedAt ? { modified: `indexed ${age(hit.indexedAt, now)}` } : {}),
    fresh: hit.fresh,
    excerpt,
    ...(hit.duplicates?.length ? { sameBytesAlsoAt: hit.duplicates.slice(0, 3).map(join) } : {}),
  };
}

export function describeLocation(location: ChunkLocation): string {
  const range = (name: string, value: { start: number; end: number }) => value.start === value.end ? `${name} ${value.start}` : `${name}s ${value.start}–${value.end}`;
  const parts: string[] = [];
  if (location.lines) parts.push(range("line", location.lines));
  if (location.paragraphs) parts.push(range("paragraph", location.paragraphs));
  if (location.page !== undefined) parts.push(`page ${location.page}`);
  if (location.slide !== undefined) parts.push(`slide ${location.slide}`);
  if (location.sheet !== undefined) parts.push(`sheet ${bounded(location.sheet, 60)}`);
  if (location.rows) parts.push(range("row", location.rows));
  if (location.part !== undefined) parts.push(`part ${location.part}`);
  if (location.headings?.length) parts.push(`under ${bounded(location.headings.join(" › "), 120)}`);
  return parts.join(", ");
}

/** "2026-11-20, 7 days ago". */
export function age(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "unknown";
  const date = new Date(time).toISOString().slice(0, 10);
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  const relative = minutes < 60 ? (minutes <= 1 ? "just now" : plural(minutes, "minute"))
    : minutes < 48 * 60 ? plural(Math.round(minutes / 60), "hour")
    : minutes < 60 * 24 * 60 ? plural(Math.round(minutes / (24 * 60)), "day")
    : minutes < 2 * 365 * 24 * 60 ? plural(Math.round(minutes / (30 * 24 * 60)), "month")
    : plural(Math.round(minutes / (365 * 24 * 60)), "year");
  return `${date}, ${relative}`;
}

/** One line on what the hits can and cannot be trusted to cover. */
export function coverageLine(scope: RecallToolScope, result: RecallAcrossResult): string {
  const sentences: string[] = [];
  const { coverage } = result;
  const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
  if (scope === "tree") {
    const nested = Math.max(0, result.searched - 1);
    sentences.push(`Searched this Connected Folder and ${count(nested, "nested Connected Folder")}; nested Workers' Chats are not searched.`);
    if (result.notIndexed.length) {
      const names = result.notIndexed.slice(0, 5).map((folder) => folder.name).join(", ");
      sentences.push(`${count(result.notIndexed.length, "folder")} not indexed yet (${names}${result.notIndexed.length > 5 ? ", …" : ""}): indexing has started; this is not the same as empty, so search again shortly or grep there.`);
    }
  } else if (result.notIndexed.length) {
    sentences.push("This Connected Folder has not been indexed yet; indexing has started, so nothing here means unknown, not absent. Use grep or search now.");
  }
  if (result.failed.length) sentences.push(`${count(result.failed.length, "index")} could not be read this time (${result.failed.slice(0, 5).map((folder) => folder.name).join(", ")}).`);
  if (result.leftOut.workingCopies) sentences.push(`${count(result.leftOut.workingCopies, "managed working copy")} left out.`);
  if (result.leftOut.beyondLimit) sentences.push(`${count(result.leftOut.beyondLimit, "folder")} left out by the bound on folders per search.`);
  const files = coverage.files;
  const answered = coverage.folders.complete + coverage.folders.partial;
  if (answered) {
    if (coverage.complete) sentences.push(`Index complete: ${count(files.indexed ?? 0, "file")} indexed.`);
    else {
      const gaps: string[] = [];
      if (files.pending) gaps.push(`${files.pending} still being read`);
      if (files["not-downloaded"]) gaps.push(`${files["not-downloaded"]} not downloaded from a sync service (never read)`);
      const unread = (files.unsupported ?? 0) + (files.binary ?? 0);
      if (unread) gaps.push(`${unread} of a kind the index does not read`);
      if (files["too-large"]) gaps.push(`${files["too-large"]} too large`);
      if (files.unreadable) gaps.push(`${files.unreadable} unreadable`);
      sentences.push(`Index partial: ${count(files.indexed ?? 0, "file")} indexed${gaps.length ? `; ${gaps.join(", ")}` : ""}${coverage.running ? "; catching up now" : ""}.`);
    }
    sentences.push(coverage.ranking === "hybrid" ? "Ranked by words and meaning."
      : coverage.lexicalOnlyReason === "embedder-unavailable" ? "Ranked by words only: ranking by meaning is unavailable on this computer."
      : coverage.ranking === "mixed" ? "Ranked by words and meaning where meaning is ready, by words elsewhere."
      : "Ranked by words only for now; meaning is still being prepared.");
  }
  if (coverage.staleHits) sentences.push(`${count(coverage.staleHits, "hit")} changed since indexed (fresh:false): read ${coverage.staleHits === 1 ? "it" : "them"} again.`);
  if (!countHits(result)) sentences.push("No hits: that does not prove it is not here. Try other words, a wider path, or grep.");
  return sentences.join(" ");
}

function countHits(result: RecallAcrossResult): number {
  return result.groups.reduce((sum, group) => sum + group.hits.length, 0);
}

function bounded(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
