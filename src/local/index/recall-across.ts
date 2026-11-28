/**
 * Ranked search across several Connected Folders' indexes
 * (docs/index-and-recall.md): a Worker's `recall` with `scope: "tree"` and
 * `amplefile search --everywhere --ranked`.
 *
 * Each folder's own index answers for that folder alone; hit scores are
 * rank-based, so the hits of every folder are merged by score, the best
 * `limit` kept, and then grouped by the folder that owns them, best group
 * first. A folder whose index was never built is asked for a sync and
 * reported as not indexed yet, never as a folder with nothing in it. Managed
 * Git working copies are left out: each is another revision of its source's
 * files, so its hits would only repeat the source's.
 */

import type { ConnectedFolderIndexService } from "./indexer.js";
import type { RecallCoverage, RecallHit, RecallKind } from "./recall.js";
import { isManagedWorkingCopyRoot } from "../managed-worktrees.js";

export interface RecallAcrossFolder {
  id: string;
  name: string;
  connectedFolderRoot: string;
  /**
   * The folder's `/`-separated path relative to the caller's own Connected
   * Folder: "" for the caller's own, absent when there is no caller folder
   * (the AmpleFile Agent and the CLI's everywhere search).
   */
  path?: string;
  /** The folder's Role purpose, when it has one. */
  rolePurpose?: string;
}

export interface RecallAcrossFolderRef {
  id: string;
  name: string;
  connectedFolderRoot: string;
  path?: string;
  rolePurpose?: string;
}

export interface RecallAcrossGroup {
  connectedFolder: RecallAcrossFolderRef;
  /** This folder's hits among the merged best; paths are relative to this folder. */
  hits: RecallHit[];
  coverage: RecallCoverage;
}

export interface RecallAcrossResult {
  query: string;
  /** Folders holding at least one of the merged best hits, best first. */
  groups: RecallAcrossGroup[];
  /** Folders whose index has never been built. A sync was asked for; they are not empty. */
  notIndexed: RecallAcrossFolderRef[];
  /** Folders asked: those with hits, those without, and those not indexed yet. */
  searched: number;
  /** Folders searched with no hit among the merged best. */
  withoutHits: number;
  /** Folders whose index could not be read this time. */
  failed: RecallAcrossFolderRef[];
  leftOut: {
    /** Managed Git working copies, never searched across folders. */
    workingCopies: number;
    /** Folders past the bound on how many one search asks. */
    beyondLimit: number;
  };
  /** What the indexes asked cover together; unknown is never counted as zero. */
  coverage: RecallAcrossCoverage;
}

export interface RecallAcrossCoverage {
  /** True only when every folder asked answered with a complete index and nothing was left out by a bound. */
  complete: boolean;
  folders: { complete: number; partial: number; notIndexed: number; failed: number };
  /** Files by status, summed over the folders that answered. */
  files: Record<string, number>;
  /** `hybrid` when every answering folder ranked by meaning too, `lexical` when none did, `mixed` otherwise. */
  ranking: "hybrid" | "lexical" | "mixed";
  lexicalOnlyReason?: RecallCoverage["lexicalOnlyReason"];
  /** Hits that no longer match the disk; they were queued for indexing again. */
  staleHits: number;
  /** True while a sync of any folder asked is running or queued. */
  running: boolean;
}

export interface RecallAcrossOptions {
  /** Merged hits to keep; default 10, at most 50. */
  limit?: number;
  /** Which sources to search; default both. */
  kinds?: readonly RecallKind[];
  /** A path relative to the caller's own folder; only folders at or under it, or holding it, are asked. */
  path?: string;
  /**
   * Which folders' Chats are searched. `all` (the default) searches each
   * folder's Chats when the kinds ask for them; `own` only the caller's own
   * (path ""), so a parent's recall never reads its nested Workers' Chats.
   */
  chats?: "all" | "own";
  /** The caller's own folder (path "") syncs first, as a one-folder ranked search does. */
  waitMs?: number;
  /** At most this many folders are asked; default 200. */
  maxFolders?: number;
  /** Folders never searched across folders; default: managed Git working copies. */
  leaveOut?: (folder: RecallAcrossFolder) => boolean;
  signal?: AbortSignal;
}

export type RecallAcrossIndex = Pick<ConnectedFolderIndexService, "recall" | "status" | "schedule">;

const defaultMaxFolders = 200;
const concurrency = 4;

export async function recallAcrossConnectedFolders(
  index: RecallAcrossIndex,
  folders: readonly RecallAcrossFolder[],
  rawQuery: string,
  options: RecallAcrossOptions = {},
): Promise<RecallAcrossResult> {
  const query = rawQuery.trim();
  if (!query) throw Object.assign(new Error("Enter something to search for."), { statusCode: 400 });
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 10)));
  const kinds: RecallKind[] = options.kinds?.length ? [...new Set(options.kinds)] : ["files", "chats"];
  const leaveOut = options.leaveOut ?? ((folder: RecallAcrossFolder) => isManagedWorkingCopyRoot(folder.connectedFolderRoot));
  const maxFolders = Math.max(1, options.maxFolders ?? defaultMaxFolders);
  if (options.path !== undefined && options.path.replace(/\\/g, "/").split("/").includes("..")) {
    throw Object.assign(new Error("A search path must stay inside the Connected Folder."), { statusCode: 400 });
  }
  const callerPath = options.path === undefined ? undefined : slashPath(options.path);

  let workingCopies = 0;
  const asked: Array<{ folder: RecallAcrossFolder; prefix: string }> = [];
  for (const folder of folders) {
    // The caller's own folder is always asked, even when it is a working copy itself.
    if (folder.path !== "" && leaveOut(folder)) { workingCopies++; continue; }
    const prefix = callerPath === undefined ? "" : folderPrefix(folder.path ?? "", callerPath);
    if (prefix === null) continue;
    asked.push({ folder, prefix });
  }
  // The caller's own folder first, then nearer folders before deeper ones.
  asked.sort((left, right) => depth(left.folder.path) - depth(right.folder.path));
  const beyondLimit = Math.max(0, asked.length - maxFolders);
  const queued = asked.slice(0, maxFolders);

  const answers: Array<{ ref: RecallAcrossFolderRef; hits: RecallHit[]; coverage: RecallCoverage } | { ref: RecallAcrossFolderRef; state: "not-indexed" | "failed" }> = [];
  let next = 0;
  const worker = async () => {
    while (next < queued.length) {
      const { folder, prefix } = queued[next++]!;
      throwIfAborted(options.signal);
      const ref = folderRef(folder);
      const target = { id: folder.id, connectedFolderRoot: folder.connectedFolderRoot };
      const own = folder.path === "";
      try {
        if (!own && index.status(target).state === "not-indexed") {
          index.schedule(target, "query");
          answers.push({ ref, state: "not-indexed" });
          continue;
        }
        const folderKinds = kinds.filter((kind) => kind !== "chats" || options.chats !== "own" || own);
        if (!folderKinds.length) continue;
        const result = await index.recall(target, query, {
          limit,
          kinds: folderKinds,
          ...(prefix ? { path: prefix } : {}),
          ...(own ? { waitMs: options.waitMs ?? 1_500 } : { refresh: "background" as const }),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (own && result.coverage.state === "not-indexed") {
          answers.push({ ref, state: "not-indexed" });
          continue;
        }
        answers.push({ ref, hits: result.hits, coverage: result.coverage });
      } catch (error) {
        if ((error as Error).name === "AbortError") throw error;
        answers.push({ ref, state: "failed" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queued.length) }, worker));

  // Merge by score, keep the best `limit`, then group by owning folder.
  const merged: Array<{ hit: RecallHit; folderId: string }> = [];
  for (const answer of answers) if ("hits" in answer) for (const hit of answer.hits) merged.push({ hit, folderId: answer.ref.id });
  merged.sort((left, right) => right.hit.score - left.hit.score);
  const kept = merged.slice(0, limit);
  const groups: RecallAcrossGroup[] = [];
  for (const { hit, folderId } of kept) {
    let group = groups.find((item) => item.connectedFolder.id === folderId);
    if (!group) {
      const answer = answers.find((item) => item.ref.id === folderId && "hits" in item) as { ref: RecallAcrossFolderRef; coverage: RecallCoverage };
      group = { connectedFolder: answer.ref, hits: [], coverage: answer.coverage };
      groups.push(group);
    }
    group.hits.push(hit);
  }
  const answered = answers.filter((answer): answer is { ref: RecallAcrossFolderRef; hits: RecallHit[]; coverage: RecallCoverage } => "hits" in answer);
  const notIndexed = answers.filter((answer) => "state" in answer && answer.state === "not-indexed").map((answer) => answer.ref);
  const failed = answers.filter((answer) => "state" in answer && answer.state === "failed").map((answer) => answer.ref);
  const files: Record<string, number> = {};
  let hybrid = 0;
  let lexicalOnlyReason: RecallCoverage["lexicalOnlyReason"];
  for (const { coverage } of answered) {
    for (const [status, count] of Object.entries(coverage.files ?? {})) files[status] = (files[status] ?? 0) + count;
    if (coverage.ranking === "hybrid") hybrid++;
    else lexicalOnlyReason ??= coverage.lexicalOnlyReason;
  }
  const completeFolders = answered.filter(({ coverage }) => coverage.complete).length;
  return {
    query,
    groups,
    notIndexed,
    searched: answers.length,
    withoutHits: answered.length - groups.length,
    failed,
    leftOut: { workingCopies, beyondLimit },
    coverage: {
      complete: completeFolders === answers.length && beyondLimit === 0,
      folders: { complete: completeFolders, partial: answered.length - completeFolders, notIndexed: notIndexed.length, failed: failed.length },
      files,
      ranking: !answered.length || hybrid === 0 ? "lexical" : hybrid === answered.length ? "hybrid" : "mixed",
      ...(lexicalOnlyReason && hybrid < answered.length ? { lexicalOnlyReason } : {}),
      staleHits: answered.reduce((sum, { coverage }) => sum + coverage.staleHits, 0),
      running: answered.some(({ coverage }) => coverage.running) || notIndexed.length > 0,
    },
  };
}

/**
 * The path prefix to ask a folder for, given a caller-relative `path`: the
 * part of `path` inside that folder, "" for the whole folder, or null when
 * the folder neither holds `path` nor sits under it.
 */
export function folderPrefix(folderPath: string, callerPath: string): string | null {
  const folder = slashPath(folderPath);
  const wanted = slashPath(callerPath);
  if (!wanted) return "";
  if (!folder) return wanted;
  if (wanted === folder) return "";
  if (wanted.startsWith(`${folder}/`)) return wanted.slice(folder.length + 1);
  if (folder.startsWith(`${wanted}/`)) return "";
  return null;
}

function folderRef(folder: RecallAcrossFolder): RecallAcrossFolderRef {
  return {
    id: folder.id,
    name: folder.name,
    connectedFolderRoot: folder.connectedFolderRoot,
    ...(folder.path !== undefined ? { path: folder.path } : {}),
    ...(folder.rolePurpose ? { rolePurpose: folder.rolePurpose } : {}),
  };
}

function slashPath(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".").join("/");
}

function depth(path: string | undefined): number {
  return path ? path.split("/").length : 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Search cancelled."), { name: "AbortError" });
}
