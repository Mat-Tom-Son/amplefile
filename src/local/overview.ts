import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChatMessage, ConversationSummary } from "./agent/chat-store.js";
import type { AmpleFileActAgentRequestPhase } from "./cli/act-facade.js";
import type { AmpleFileRequestKind, AmpleFileRequestState } from "./requests/request-records.js";
import type { AmpleFileCliActReceipt } from "./cli/act-receipts.js";
import type {
  AmpleFileCheckAggregateState,
  AmpleFileCheckStatusSnapshot,
} from "./checks/check-types.js";
import { ampleFileStateRoot } from "./state-paths.js";

/**
 * The overview: a deterministic digest composed by app code from state the
 * product already records. It is a projection, not a store — every item points
 * back at a record that exists for its own reasons, the digest can always be
 * recomputed, and it is never the authority for anything. No model composes
 * it and no watcher exists just to feed it. Source readers may re-verify
 * explicitly designated Check inputs locally; the digest contains only their
 * aggregate status, never those file bytes.
 *
 * The source inventory is closed: one typed reader per row of the inventory
 * table in docs/amplefile-agent-overview.md. An absent reader renders its
 * kinds as absent, never as empty-and-clear; a reader that fails is reported
 * in `unavailable`, never rendered as quiet. Composition is deterministic —
 * the same recorded state and the same clock reading produce a
 * byte-identical digest.
 */

export const ampleFileOverviewExperimentalSnapshotVersion = 0 as const;

export const AMPLEFILE_OVERVIEW_SOURCES = [
  "kernel-tasks",
  "settled-turns",
  "agent-requests",
  "chats",
  "history-checkpoints",
  "checks",
  "act-receipts",
  "app-automation-receipts",
  "app-automation-schedule",
  "automation-runs",
] as const;

export type AmpleFileOverviewSource = (typeof AMPLEFILE_OVERVIEW_SOURCES)[number];

export type AmpleFileOverviewItemKind =
  // Running now
  | "assistant-turn"
  | "compaction"
  | "agent-request"
  | "check-run"
  | "app-automation-run"
  | "automation-run"
  // Needs you: questions and due snoozes only (docs/receipts-not-gates.md,
  // F24). Nothing here is an approval.
  | "request-question"
  | "chat-question"
  | "due-snooze"
  // Since you last looked
  | "checkpoint-saved"
  | "turn-settled"
  | "request-settled"
  | "chat-lifecycle"
  | "chat-renamed"
  | "check-run-settled"
  | "act-performed"
  | "app-automation-run-settled"
  | "automation-run-settled";

export interface AmpleFileOverviewItemRef {
  taskId?: string;
  conversationId?: string;
  checkpointId?: string;
  /** An act receipt's request id, or a durable request's id (F25). */
  requestId?: string;
  /** The open question a needs-you item points at (F27). */
  questionId?: string;
  automationId?: string;
  runId?: string;
}

export interface AmpleFileOverviewItem {
  /** Stable `<source>:<recordId>` dedupe identity. */
  id: string;
  /** ISO time of the underlying record. */
  at: string;
  kind: AmpleFileOverviewItemKind;
  connectedFolderId?: string;
  /** Resolved at composition; an unregistered Connected Folder renders the id plus "(removed)". */
  connectedFolderName?: string;
  /** Deterministic template over typed record fields, never model output. */
  headline: string;
  ref?: AmpleFileOverviewItemRef;
}

export interface AmpleFileOverviewCheckRow {
  connectedFolderId: string;
  connectedFolderName: string;
  state: AmpleFileCheckAggregateState;
  needsAttention: number;
  neverRun: number;
  stale: number;
  blocked: number;
  errors: number;
  lastRunAt: string | null;
}

export interface AmpleFileOverviewSnapshot {
  kind: "amplefile.overview.experimental";
  version: typeof ampleFileOverviewExperimentalSnapshotVersion;
  /** The single clock reading used for every due-snooze and expiry comparison. */
  composedAt: string;
  /** `"<at>/<id>"` of the newest change item; empty while nothing has changed. */
  cursor: string;
  running: AmpleFileOverviewItem[];
  needsYou: AmpleFileOverviewItem[];
  changes: AmpleFileOverviewItem[];
  checks: AmpleFileOverviewCheckRow[];
  /** surfaceId -> acknowledged cursor, from the seen-marker store. */
  seen: Record<string, string>;
  truncated: { running: boolean; needsYou: boolean; changes: boolean; checks: boolean };
  /**
   * Sources that exist but could not be read this composition. Their kinds are
   * omitted, and the omission is disclosed instead of rendered as quiet.
   */
  unavailable: AmpleFileOverviewSource[];
}

// Section bounds. Bounds are disclosure, not curation: overflow sets the
// section's truncated flag instead of pretending completeness.
export const ampleFileOverviewRunningCap = 256;
export const ampleFileOverviewNeedsYouCap = 256;
export const ampleFileOverviewChangesPerKindCap = 128;
export const ampleFileOverviewChangesTotalCap = 512;
export const ampleFileOverviewChecksCap = 512;

const maxHeadlineLength = 200;
const maxTitleInHeadline = 80;
const maxSourceRecords = 2_048;
const maxStoreBytes = 4 * 1024 * 1024;
const maxStoreRecords = 512;
const maxRecordIdLength = 200;

/** Registered Connected Folder identity handed to the per–Connected Folder source readers. */
export interface AmpleFileOverviewConnectedFolderRef {
  id: string;
  name: string;
  connectedFolderRoot: string;
}

// --- Source record shapes (one row of the inventory table each) ---

export interface AmpleFileOverviewTaskRecord {
  id: string;
  kind: "assistant_turn" | "compaction" | "check_run";
  connectedFolderId: string;
  conversationId?: string;
  startedAt: string;
}

export interface AmpleFileOverviewSettledTurnRecord {
  taskId: string;
  connectedFolderId?: string;
  conversationId?: string;
  outcome: "succeeded" | "failed" | "aborted";
  endedAt: string;
}

/**
 * One durable request (docs/collaboration-contract.md, F25) as the overview
 * reads it: its state, the vocabulary `agent status` speaks beside it, the
 * turns it started, and its open questions by id — never a question's text,
 * a result's summary, or any Connected Folder content.
 */
export interface AmpleFileOverviewAgentRequestRecord {
  /** Stable across continuations, unlike the task id; item ids key on it. */
  requestId: string;
  kind: AmpleFileRequestKind;
  state: AmpleFileRequestState;
  /** The request's newest turn. */
  taskId: string;
  conversationId: string;
  /** Absent exactly for the AmpleFile agent scope. */
  connectedFolderId?: string;
  phase: AmpleFileActAgentRequestPhase;
  startedAt: string;
  endedAt: string | null;
  /** Every turn under this request's descendants, for running-item folding. */
  childTaskIds: string[];
  /** Questions still open on this request, by id and respondent (needs you). */
  openQuestions: Array<{ questionId: string; respondent: "person" | "parent"; askedAt: string }>;
  questionCount: number;
  resultCount: number;
}

/**
 * Work above a single turn: the AmpleFile agent's own requests, and any
 * request that delegated, asked, or reported. A plain Worker turn is one
 * kernel task and one settled turn already; rendering its root request as
 * well would list the same work twice.
 */
function requestIsAboveSingleTurn(request: AmpleFileOverviewAgentRequestRecord): boolean {
  return request.kind === "agent"
    || request.childTaskIds.length > 0
    || request.questionCount > 0
    || request.resultCount > 0;
}

const requestSettledHeadlines: Record<AmpleFileRequestState, string | null> = {
  working: null,
  waiting: null,
  handed_off: null,
  done: "Request done",
  partial: "Request partly done",
  failed: "Request failed",
  stopped: "Request stopped",
  expired: "Request ran out of time",
};

export interface AmpleFileOverviewChatLifecycleEvent {
  messageId: string;
  createdAt: string;
  change: "archived" | "restored" | "snoozed" | "snooze-cleared";
  snoozedUntil?: string;
}

export interface AmpleFileOverviewChatTitleEvent {
  messageId: string;
  createdAt: string;
  title: string;
  source: "manual" | "generated";
}

export interface AmpleFileOverviewChatRecord {
  conversationId: string;
  title: string;
  archivedAt: string | null;
  snoozedUntil: string | null;
  /** Newest user/assistant message; lifecycle and title bookkeeping is skipped. */
  newestMessage: { role: "user" | "assistant"; createdAt: string; followUpPrompt: string | null } | null;
  lifecycleEvents: AmpleFileOverviewChatLifecycleEvent[];
  titleEvents: AmpleFileOverviewChatTitleEvent[];
}

export interface AmpleFileOverviewCheckpointRecord {
  checkpointId: string;
  createdAt: string;
  label?: string;
  reason: string;
  scope: "full" | "targeted";
}

export interface AmpleFileOverviewCheckRunRecord {
  runId: string;
  taskId?: string;
  state: "succeeded" | "failed" | "aborted" | "interrupted";
  startedAt: string;
  endedAt?: string;
  admittedCount: number;
}

export interface AmpleFileOverviewCheckSource {
  status: AmpleFileCheckStatusSnapshot;
  settledRuns: AmpleFileOverviewCheckRunRecord[];
}

export interface AmpleFileOverviewAppAutomationRunRecord {
  runId: string;
  appAutomationId: string;
  /** The app's and the automation's titles, when the installation still declares them. */
  appTitle?: string;
  automationTitle?: string;
  connectedFolderId?: string;
  startedAt: string;
}

export type AmpleFileOverviewAppAutomationOutcome =
  | "success"
  | "failure"
  | "skipped"
  | "cancelled"
  | "interrupted";

export interface AmpleFileOverviewAppAutomationReceiptRecord {
  receiptId: string;
  runId: string;
  appAutomationId: string;
  appTitle?: string;
  automationTitle?: string;
  connectedFolderId?: string;
  outcome: AmpleFileOverviewAppAutomationOutcome;
  finishedAt: string;
}

export type AmpleFileOverviewAutomationRunState =
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "interrupted"
  | "skipped";

export interface AmpleFileOverviewAutomationRunRecord {
  runId: string;
  automationId: string;
  title?: string;
  state: AmpleFileOverviewAutomationRunState;
  startedAt: string;
  endedAt?: string;
  hops: Array<{ id: string; state: string }>;
}

/**
 * The closed source-reader interface. Every method is optional: an absent
 * reader renders its item kinds as absent. A reader that throws marks its
 * source unavailable for this composition; its kinds are omitted and the
 * omission is disclosed. Readers read recorded state only — composing the
 * digest must never execute a sensor, run a model, or open Connected Folder content.
 */
export interface AmpleFileOverviewSourceReaders {
  runningTasks?(): Promise<AmpleFileOverviewTaskRecord[]>;
  settledTurns?(): Promise<AmpleFileOverviewSettledTurnRecord[]>;
  ampleFileAgentRequests?(): Promise<AmpleFileOverviewAgentRequestRecord[]>;
  chats?(connectedFolder: AmpleFileOverviewConnectedFolderRef): Promise<AmpleFileOverviewChatRecord[]>;
  checkpoints?(connectedFolder: AmpleFileOverviewConnectedFolderRef): Promise<AmpleFileOverviewCheckpointRecord[]>;
  checks?(connectedFolder: AmpleFileOverviewConnectedFolderRef): Promise<AmpleFileOverviewCheckSource | null>;
  actReceipts?(): Promise<AmpleFileCliActReceipt[]>;
  appAutomationRunReceipts?(): Promise<AmpleFileOverviewAppAutomationReceiptRecord[]>;
  appAutomationRuns?(): Promise<AmpleFileOverviewAppAutomationRunRecord[]>;
  automationRuns?(): Promise<AmpleFileOverviewAutomationRunRecord[]>;
}

export interface AmpleFileOverviewComposeInput {
  /** One clock reading, used for every timestamp comparison in this digest. */
  now: Date;
  connectedFolders: AmpleFileOverviewConnectedFolderRef[];
  sources: AmpleFileOverviewSourceReaders;
  seen?: Record<string, string>;
}

// --- Cursor helpers ---

export function ampleFileOverviewCursor(at: string, id: string): string {
  return `${at}/${id}`;
}

export function parseAmpleFileOverviewCursor(cursor: unknown): { at: string; id: string } | null {
  if (typeof cursor !== "string" || !cursor || cursor.length > 720) return null;
  if (/[\u0000-\u001f\u007f]/.test(cursor)) return null;
  const separator = cursor.indexOf("/");
  if (separator <= 0 || separator === cursor.length - 1) return null;
  return { at: cursor.slice(0, separator), id: cursor.slice(separator + 1) };
}

/** Total order over cursors: timestamp first, then item id. */
export function compareAmpleFileOverviewCursors(left: string, right: string): number {
  const parsedLeft = parseAmpleFileOverviewCursor(left);
  const parsedRight = parseAmpleFileOverviewCursor(right);
  if (!parsedLeft || !parsedRight) return compareStrings(left, right);
  return compareTimestamps(parsedLeft.at, parsedRight.at) || compareStrings(parsedLeft.id, parsedRight.id);
}

// --- Composition ---

export async function composeAmpleFileOverview(input: AmpleFileOverviewComposeInput): Promise<AmpleFileOverviewSnapshot> {
  const composedAt = input.now.toISOString();
  const composedAtMs = input.now.getTime();
  const connectedFolders = [...input.connectedFolders].sort((left, right) => compareStrings(left.id, right.id));
  const connectedFolderNames = new Map(connectedFolders.map((connectedFolder) => [connectedFolder.id, connectedFolder.name]));
  const unavailable = new Set<AmpleFileOverviewSource>();
  const sources = input.sources;

  const tasks = await readSource("kernel-tasks", sources.runningTasks, unavailable);
  const settledTurns = await readSource("settled-turns", sources.settledTurns, unavailable);
  const requests = await readSource("agent-requests", sources.ampleFileAgentRequests, unavailable);
  const chats = await readConnectedFolderSource("chats", connectedFolders, sources.chats, unavailable);
  const checkpoints = await readConnectedFolderSource("history-checkpoints", connectedFolders, sources.checkpoints, unavailable);
  const checks = await readConnectedFolderSource("checks", connectedFolders, sources.checks, unavailable);
  const actReceipts = await readSource("act-receipts", sources.actReceipts, unavailable);
  const appAutomationReceipts = await readSource("app-automation-receipts", sources.appAutomationRunReceipts, unavailable);
  const appAutomationRuns = await readSource("app-automation-schedule", sources.appAutomationRuns, unavailable);
  const automationRuns = await readSource("automation-runs", sources.automationRuns, unavailable);

  // A request in `waiting` is not running: what it waits on is in Needs you.
  const runningRequests = (requests ?? []).filter(
    (request) => requestIsAboveSingleTurn(request) && (request.state === "working" || request.state === "handed_off"),
  );
  // One item per request: the request's own turn task and its running child
  // turns fold into that item's headline count instead of listing twice.
  const foldedTaskIds = new Set<string>();
  for (const request of runningRequests) {
    foldedTaskIds.add(request.taskId);
    for (const childTaskId of request.childTaskIds) foldedTaskIds.add(childTaskId);
  }
  const runningTaskIds = new Set((tasks ?? []).map((task) => task.id));
  const runningConversationIds = new Set(
    (tasks ?? []).flatMap((task) => task.conversationId ? [task.conversationId] : []),
  );

  const running = composeRunning({
    tasks: tasks ?? [],
    runningRequests,
    foldedTaskIds,
    runningTaskIds,
    appAutomationRuns: appAutomationRuns ?? [],
    automationRuns: automationRuns ?? [],
    connectedFolderNames,
  });
  const needsYou = composeNeedsYou({
    composedAtMs,
    requests: requests ?? [],
    chats,
    runningConversationIds,
    connectedFolderNames,
  });
  const changes = composeChanges({
    composedAtMs,
    settledTurns: settledTurns ?? [],
    requests: requests ?? [],
    chats,
    checkpoints,
    checks,
    actReceipts: actReceipts ?? [],
    appAutomationReceipts: appAutomationReceipts ?? [],
    automationRuns: automationRuns ?? [],
    connectedFolderNames,
  });
  const checkRows = composeCheckRows(checks);

  const seen: Record<string, string> = {};
  const seenInput = input.seen ?? {};
  for (const key of Object.keys(seenInput).sort(compareStrings)) seen[key] = seenInput[key];

  const newestChange = changes.items[0];
  return {
    kind: "amplefile.overview.experimental",
    version: ampleFileOverviewExperimentalSnapshotVersion,
    composedAt,
    cursor: newestChange ? ampleFileOverviewCursor(newestChange.at, newestChange.id) : "",
    running: running.items,
    needsYou: needsYou.items,
    changes: changes.items,
    checks: checkRows.rows,
    seen,
    truncated: {
      running: running.truncated,
      needsYou: needsYou.truncated,
      changes: changes.truncated,
      checks: checkRows.truncated,
    },
    unavailable: [...unavailable].sort(compareStrings),
  };
}

function composeRunning(input: {
  tasks: AmpleFileOverviewTaskRecord[];
  runningRequests: AmpleFileOverviewAgentRequestRecord[];
  foldedTaskIds: Set<string>;
  runningTaskIds: Set<string>;
  appAutomationRuns: AmpleFileOverviewAppAutomationRunRecord[];
  automationRuns: AmpleFileOverviewAutomationRunRecord[];
  connectedFolderNames: Map<string, string>;
}): { items: AmpleFileOverviewItem[]; truncated: boolean } {
  const items: AmpleFileOverviewItem[] = [];
  for (const request of input.runningRequests.slice(0, maxSourceRecords)) {
    const runningChildren = request.childTaskIds.filter((taskId) => input.runningTaskIds.has(taskId)).length;
    const base = request.state === "handed_off" ? "Handed off" : "Handling your request";
    const suffix = runningChildren > 0
      ? ` — ${runningChildren} Worker turn${runningChildren === 1 ? "" : "s"} running`
      : "";
    items.push(overviewItem({
      id: `agent-requests:${request.requestId}`,
      at: request.startedAt,
      kind: "agent-request",
      ...(request.connectedFolderId ? { connectedFolderId: request.connectedFolderId, connectedFolderNames: input.connectedFolderNames } : {}),
      headline: `${base}${suffix}`,
      ref: { taskId: request.taskId, conversationId: request.conversationId, requestId: request.requestId },
    }));
  }
  for (const task of input.tasks.slice(0, maxSourceRecords)) {
    if (input.foldedTaskIds.has(task.id)) continue;
    const kind = task.kind === "assistant_turn"
      ? "assistant-turn" as const
      : task.kind === "compaction"
        ? "compaction" as const
        : task.kind === "check_run"
          ? "check-run" as const
          : null;
    if (!kind) continue;
    const headline = kind === "assistant-turn"
      ? "Worker turn running"
      : kind === "compaction"
        ? "Chat compaction running"
        : "Check run in progress";
    items.push(overviewItem({
      id: `kernel-tasks:${task.id}`,
      at: task.startedAt,
      kind,
      connectedFolderId: task.connectedFolderId,
      connectedFolderNames: input.connectedFolderNames,
      headline,
      ref: { taskId: task.id, ...(task.conversationId ? { conversationId: task.conversationId } : {}) },
    }));
  }
  for (const run of input.appAutomationRuns.slice(0, maxSourceRecords)) {
    items.push(overviewItem({
      id: `app-automation-schedule:${run.runId}`,
      at: run.startedAt,
      kind: "app-automation-run",
      ...(run.connectedFolderId ? { connectedFolderId: run.connectedFolderId, connectedFolderNames: input.connectedFolderNames } : {}),
      headline: `${appAutomationSubject(run)} running`,
      ref: { runId: run.runId },
    }));
  }
  for (const run of input.automationRuns.slice(0, maxSourceRecords)) {
    if (run.state !== "running") continue;
    items.push(overviewItem({
      id: `automation-runs:${run.runId}`,
      at: run.startedAt,
      kind: "automation-run",
      headline: run.title
        ? `Automation "${clampText(run.title, maxTitleInHeadline)}" running`
        : "Automation run in progress",
      ref: { automationId: run.automationId, runId: run.runId },
    }));
  }
  // Longest-running first; overflow drops the newest, never the oldest — a
  // long-running turn must not be hidden by churn.
  items.sort((left, right) => compareTimestamps(left.at, right.at) || compareStrings(left.id, right.id));
  return {
    items: items.slice(0, ampleFileOverviewRunningCap),
    truncated: items.length > ampleFileOverviewRunningCap,
  };
}

/**
 * Needs you means questions (docs/receipts-not-gates.md, F24): an AmpleFile
 * agent request waiting on the person's answer, a Worker Chat whose newest
 * message is a question from the Worker, and a due snooze. Newest first;
 * overflow keeps the newest and states truncation. Nothing here is an
 * approval.
 */
function composeNeedsYou(input: {
  composedAtMs: number;
  requests: AmpleFileOverviewAgentRequestRecord[];
  chats: Array<{ connectedFolder: AmpleFileOverviewConnectedFolderRef; records: AmpleFileOverviewChatRecord[] }>;
  runningConversationIds: Set<string>;
  connectedFolderNames: Map<string, string>;
}): { items: AmpleFileOverviewItem[]; truncated: boolean } {
  const others: AmpleFileOverviewItem[] = [];
  for (const request of input.requests.slice(0, maxSourceRecords)) {
    // One item per open question addressed to the person
    // (docs/amplefile-agent-overview.md). A question addressed to the parent
    // request belongs to that request's agent, never to the person. The
    // question's text is model output and stays out of the digest; the ref
    // carries the ids a surface reads by.
    const personQuestions = request.openQuestions.filter((question) => question.respondent === "person");
    const connectedFolderName = request.connectedFolderId ? input.connectedFolderNames.get(request.connectedFolderId) ?? `${request.connectedFolderId} (removed)` : null;
    const headline = connectedFolderName
      ? `"${clampText(connectedFolderName, maxTitleInHeadline)}" is waiting on your answer`
      : "Your request is waiting on your answer";
    for (const question of personQuestions.slice(0, maxSourceRecords)) {
      others.push(overviewItem({
        id: `agent-requests:${request.requestId}:question:${question.questionId}`,
        at: question.askedAt,
        kind: "request-question",
        ...(request.connectedFolderId ? { connectedFolderId: request.connectedFolderId, connectedFolderNames: input.connectedFolderNames } : {}),
        headline,
        ref: { taskId: request.taskId, conversationId: request.conversationId, requestId: request.requestId, questionId: question.questionId },
      }));
    }
    // The closing-question heuristic on a FINISHED AmpleFile agent reply, and
    // nothing else. Only an AmpleFile agent request's phase comes from that
    // heuristic; every other kind derives `needs_you` straight from state
    // `waiting`, which a request also reaches on a question addressed to its
    // parent agent — a question that belongs to that parent and never to the
    // person (docs/amplefile-agent-overview.md, F24/F27). A request that is
    // still waiting has a recorded question somewhere, and that question's own
    // record carries the item with its question id, so the generic form would
    // only double-list it.
    if (personQuestions.length
      || request.kind !== "agent"
      || request.state === "waiting"
      || request.phase !== "needs_you") continue;
    others.push(overviewItem({
      id: `agent-requests:${request.requestId}`,
      at: request.endedAt ?? request.startedAt,
      kind: "request-question",
      ...(request.connectedFolderId ? { connectedFolderId: request.connectedFolderId, connectedFolderNames: input.connectedFolderNames } : {}),
      headline,
      ref: { taskId: request.taskId, conversationId: request.conversationId, requestId: request.requestId },
    }));
  }
  for (const { connectedFolder, records } of input.chats) {
    for (const chat of records.slice(0, maxSourceRecords)) {
      if (chat.archivedAt !== null) continue;
      if (chat.snoozedUntil !== null) {
        if (isAtOrBefore(chat.snoozedUntil, input.composedAtMs)) {
          others.push(overviewItem({
            id: `chats:${chat.conversationId}:due-snooze:${chat.snoozedUntil}`,
            at: chat.snoozedUntil,
            kind: "due-snooze",
            connectedFolderId: connectedFolder.id,
            connectedFolderNames: input.connectedFolderNames,
            headline: `"${clampText(chat.title, maxTitleInHeadline)}" snooze is due`,
            ref: { conversationId: chat.conversationId },
          }));
        }
        continue;
      }
      const newest = chat.newestMessage;
      if (!newest || newest.role !== "assistant" || !newest.followUpPrompt) continue;
      if (input.runningConversationIds.has(chat.conversationId)) continue;
      others.push(overviewItem({
        id: `chats:${chat.conversationId}:question`,
        at: newest.createdAt,
        kind: "chat-question",
        connectedFolderId: connectedFolder.id,
        connectedFolderNames: input.connectedFolderNames,
        headline: `"${clampText(chat.title, maxTitleInHeadline)}" is waiting on your reply`,
        ref: { conversationId: chat.conversationId },
      }));
    }
  }
  others.sort(newestFirst);
  return {
    items: others.slice(0, ampleFileOverviewNeedsYouCap),
    truncated: others.length > ampleFileOverviewNeedsYouCap,
  };
}

function composeChanges(input: {
  composedAtMs: number;
  settledTurns: AmpleFileOverviewSettledTurnRecord[];
  requests: AmpleFileOverviewAgentRequestRecord[];
  chats: Array<{ connectedFolder: AmpleFileOverviewConnectedFolderRef; records: AmpleFileOverviewChatRecord[] }>;
  checkpoints: Array<{ connectedFolder: AmpleFileOverviewConnectedFolderRef; records: AmpleFileOverviewCheckpointRecord[] }>;
  checks: Array<{ connectedFolder: AmpleFileOverviewConnectedFolderRef; records: AmpleFileOverviewCheckSource | null }>;
  actReceipts: AmpleFileCliActReceipt[];
  appAutomationReceipts: AmpleFileOverviewAppAutomationReceiptRecord[];
  automationRuns: AmpleFileOverviewAutomationRunRecord[];
  connectedFolderNames: Map<string, string>;
}): { items: AmpleFileOverviewItem[]; truncated: boolean } {
  const byKind = new Map<AmpleFileOverviewItemKind, AmpleFileOverviewItem[]>();
  const add = (item: AmpleFileOverviewItem): void => {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  };

  for (const { connectedFolder, records } of input.checkpoints) {
    for (const checkpoint of records.slice(0, maxSourceRecords)) {
      add(overviewItem({
        id: `history-checkpoints:${connectedFolder.id}:${checkpoint.checkpointId}`,
        at: checkpoint.createdAt,
        kind: "checkpoint-saved",
        connectedFolderId: connectedFolder.id,
        connectedFolderNames: input.connectedFolderNames,
        headline: `Restore point saved — ${clampText(checkpoint.label ?? checkpoint.reason, maxTitleInHeadline)}`,
        ref: { checkpointId: checkpoint.checkpointId },
      }));
    }
  }
  for (const turn of input.settledTurns.slice(0, maxSourceRecords)) {
    add(overviewItem({
      id: `settled-turns:${turn.taskId}`,
      at: turn.endedAt,
      kind: "turn-settled",
      ...(turn.connectedFolderId ? { connectedFolderId: turn.connectedFolderId, connectedFolderNames: input.connectedFolderNames } : {}),
      headline: `Worker turn ${turn.outcome}`,
      ref: { taskId: turn.taskId, ...(turn.conversationId ? { conversationId: turn.conversationId } : {}) },
    }));
  }
  for (const request of input.requests.slice(0, maxSourceRecords)) {
    // Every terminal state names its outcome honestly; the ref carries the
    // request id so a surface reads what came back through `requests show`.
    // A finished request whose reply still asks the person something is in
    // Needs you, not here, exactly as before the durable store.
    const headline = requestSettledHeadlines[request.state];
    if (!headline || request.phase === "needs_you" || !requestIsAboveSingleTurn(request)) continue;
    add(overviewItem({
      id: `agent-requests:${request.requestId}`,
      at: request.endedAt ?? request.startedAt,
      kind: "request-settled",
      ...(request.connectedFolderId ? { connectedFolderId: request.connectedFolderId, connectedFolderNames: input.connectedFolderNames } : {}),
      headline,
      ref: { taskId: request.taskId, conversationId: request.conversationId, requestId: request.requestId },
    }));
  }
  for (const { connectedFolder, records } of input.chats) {
    for (const chat of records.slice(0, maxSourceRecords)) {
      const title = clampText(chat.title, maxTitleInHeadline);
      for (const event of chat.lifecycleEvents.slice(0, maxSourceRecords)) {
        add(overviewItem({
          id: `chats:${chat.conversationId}:${event.messageId}`,
          at: event.createdAt,
          kind: "chat-lifecycle",
          connectedFolderId: connectedFolder.id,
          connectedFolderNames: input.connectedFolderNames,
          headline: chatLifecycleHeadline(title, event),
          ref: { conversationId: chat.conversationId },
        }));
      }
      for (const event of chat.titleEvents.slice(0, maxSourceRecords)) {
        add(overviewItem({
          id: `chats:${chat.conversationId}:${event.messageId}`,
          at: event.createdAt,
          kind: "chat-renamed",
          connectedFolderId: connectedFolder.id,
          connectedFolderNames: input.connectedFolderNames,
          headline: `Chat renamed to "${clampText(event.title, maxTitleInHeadline)}"`,
          ref: { conversationId: chat.conversationId },
        }));
      }
    }
  }
  for (const { connectedFolder, records } of input.checks) {
    if (!records) continue;
    for (const run of records.settledRuns.slice(0, maxSourceRecords)) {
      add(overviewItem({
        id: `checks:${connectedFolder.id}:${run.runId}`,
        at: run.endedAt ?? run.startedAt,
        kind: "check-run-settled",
        connectedFolderId: connectedFolder.id,
        connectedFolderNames: input.connectedFolderNames,
        headline: `Check run ${run.state} — ${run.admittedCount} finding${run.admittedCount === 1 ? "" : "s"} admitted`,
        ref: { ...(run.taskId ? { taskId: run.taskId } : {}), runId: run.runId },
      }));
    }
  }
  for (const receipt of input.actReceipts.slice(0, maxSourceRecords)) {
    // Terminal records only: `accepted` without a terminal line is the honest
    // interrupted signal, and `rejected` refusals never performed anything.
    if (receipt.outcome !== "ok" && receipt.outcome !== "error") continue;
    const headline = receipt.outcome === "ok"
      ? `Performed ${clampText(receipt.command, maxTitleInHeadline)}${receipt.checkpointId ? " — restore point saved" : ""}`
      : `${clampText(receipt.command, maxTitleInHeadline)} failed`;
    add(overviewItem({
      id: `act-receipts:${receipt.requestId}`,
      at: receipt.at,
      kind: "act-performed",
      ...(receipt.connectedFolderId ? { connectedFolderId: receipt.connectedFolderId, connectedFolderNames: input.connectedFolderNames } : {}),
      headline,
      ref: {
        ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
        ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}),
        ...(receipt.checkpointId ? { checkpointId: receipt.checkpointId } : {}),
        requestId: receipt.requestId,
      },
    }));
  }
  for (const receipt of input.appAutomationReceipts.slice(0, maxSourceRecords)) {
    add(overviewItem({
      id: `app-automation-receipts:${receipt.receiptId}`,
      at: receipt.finishedAt,
      kind: "app-automation-run-settled",
      ...(receipt.connectedFolderId ? { connectedFolderId: receipt.connectedFolderId, connectedFolderNames: input.connectedFolderNames } : {}),
      headline: `${appAutomationSubject(receipt)} ${appAutomationOutcomeLabel(receipt.outcome)}`,
      ref: { runId: receipt.runId },
    }));
  }
  for (const run of input.automationRuns.slice(0, maxSourceRecords)) {
    if (run.state === "running") continue;
    const subject = run.title ? `Automation "${clampText(run.title, maxTitleInHeadline)}"` : "Automation run";
    const completed = run.hops.filter((hop) => hop.state === "succeeded").length;
    const hopSummary = run.hops.length > 0 ? ` — ${completed}/${run.hops.length} steps completed` : "";
    add(overviewItem({
      id: `automation-runs:${run.runId}`,
      at: run.endedAt ?? run.startedAt,
      kind: "automation-run-settled",
      headline: `${subject} ${run.state}${hopSummary}`,
      ref: { automationId: run.automationId, runId: run.runId },
    }));
  }

  // Bounded twice: per kind first so one chatty source cannot evict every
  // other kind, then in total, newest first.
  let truncated = false;
  const merged: AmpleFileOverviewItem[] = [];
  for (const list of byKind.values()) {
    list.sort(newestFirst);
    if (list.length > ampleFileOverviewChangesPerKindCap) truncated = true;
    merged.push(...list.slice(0, ampleFileOverviewChangesPerKindCap));
  }
  merged.sort(newestFirst);
  if (merged.length > ampleFileOverviewChangesTotalCap) truncated = true;
  return { items: merged.slice(0, ampleFileOverviewChangesTotalCap), truncated };
}

function composeCheckRows(
  checks: Array<{ connectedFolder: AmpleFileOverviewConnectedFolderRef; records: AmpleFileOverviewCheckSource | null }>,
): { rows: AmpleFileOverviewCheckRow[]; truncated: boolean } {
  const rows: AmpleFileOverviewCheckRow[] = [];
  for (const { connectedFolder, records } of checks) {
    if (!records) continue;
    const status = records.status;
    // Unconfigured means unknown: a Connected Folder with no configured Checks is absent,
    // never implied healthy.
    if (status.state === "not-configured") continue;
    rows.push({
      connectedFolderId: connectedFolder.id,
      connectedFolderName: connectedFolder.name,
      state: status.state,
      needsAttention: status.needsAttention,
      neverRun: status.neverRun,
      stale: status.stale,
      blocked: status.blocked,
      errors: status.errors,
      lastRunAt: status.lastRunAt,
    });
  }
  rows.sort((left, right) =>
    checkStatePriority(left.state) - checkStatePriority(right.state)
    || compareStrings(left.connectedFolderName, right.connectedFolderName)
    || compareStrings(left.connectedFolderId, right.connectedFolderId));
  return {
    rows: rows.slice(0, ampleFileOverviewChecksCap),
    truncated: rows.length > ampleFileOverviewChecksCap,
  };
}

// --- Chat record derivation ---

/**
 * Derives the overview's typed chat record from a transcript's already-parsed
 * messages plus the summary the Chat list already computes. This is overview
 * semantics over recorded state — which appended events count as lifecycle
 * changes and renames, and which message is "newest" for the question rule
 * (bookkeeping system messages never answer a question, so they are skipped).
 */
export function ampleFileOverviewChatRecordFromMessages(
  summary: ConversationSummary,
  messages: ChatMessage[],
): AmpleFileOverviewChatRecord {
  let newestMessage: AmpleFileOverviewChatRecord["newestMessage"] = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" && message.role !== "assistant") continue;
    newestMessage = {
      role: message.role,
      createdAt: message.createdAt,
      followUpPrompt: message.landing?.followUpPrompt ?? null,
    };
    break;
  }
  const lifecycleEvents: AmpleFileOverviewChatLifecycleEvent[] = [];
  const titleEvents: AmpleFileOverviewChatTitleEvent[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.kind === "conversation_lifecycle" && message.lifecycle) {
      const patch = message.lifecycle;
      if (patch.archived !== undefined) {
        lifecycleEvents.push({
          messageId: message.id,
          createdAt: message.createdAt,
          change: patch.archived ? "archived" : "restored",
        });
      } else if (patch.snoozedUntil !== undefined) {
        lifecycleEvents.push({
          messageId: message.id,
          createdAt: message.createdAt,
          change: patch.snoozedUntil === null ? "snooze-cleared" : "snoozed",
          ...(patch.snoozedUntil === null ? {} : { snoozedUntil: patch.snoozedUntil }),
        });
      }
      continue;
    }
    // The seed title at creation is not a rename; only later appended manual
    // or generated title events are.
    if (index === 0 || message.kind !== "conversation_title") continue;
    if (message.titleSource !== "manual" && message.titleSource !== "generated") continue;
    titleEvents.push({
      messageId: message.id,
      createdAt: message.createdAt,
      title: message.content,
      source: message.titleSource,
    });
  }
  return {
    conversationId: summary.id,
    title: summary.title,
    archivedAt: summary.archivedAt,
    snoozedUntil: summary.snoozedUntil,
    newestMessage,
    lifecycleEvents,
    titleEvents,
  };
}

// --- Tolerant readers over recorded stores ---
//
// The automation receipts journal is read from its documented machine-local
// location. These readers tolerate a missing file, a damaged file, or an
// unknown version by omission, never by error: while a store does not exist,
// its kinds are simply absent from the digest. The
// local-API wiring may replace a file reader with a service-backed one.

export interface AmpleFileOverviewStoreReaderOptions {
  stateRoot?: string;
}

export function ampleFileOverviewAutomationReceiptsFile(stateRoot = ampleFileStateRoot()): string {
  return join(stateRoot, "automations", "receipts.jsonl");
}

export function ampleFileOverviewAutomationReceiptsRotatedFile(stateRoot = ampleFileStateRoot()): string {
  return join(stateRoot, "automations", "receipts.1.jsonl");
}

export function createAmpleFileOverviewAutomationRunReader(
  options: AmpleFileOverviewStoreReaderOptions = {},
): () => Promise<AmpleFileOverviewAutomationRunRecord[]> {
  const rotatedPath = ampleFileOverviewAutomationReceiptsRotatedFile(options.stateRoot);
  const livePath = ampleFileOverviewAutomationReceiptsFile(options.stateRoot);
  return async () => {
    const runs = new Map<string, AmpleFileOverviewAutomationRunRecord>();
    for (const path of [rotatedPath, livePath]) {
      const text = await readStoreText(path);
      if (text === null) continue;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        applyAutomationReceiptLine(runs, line);
        // Bound the working set: the journal is rotation-bounded, but a
        // damaged file must not grow an unbounded map here.
        if (runs.size > maxStoreRecords) {
          const oldest = runs.keys().next().value;
          if (oldest !== undefined) runs.delete(oldest);
        }
      }
    }
    return [...runs.values()];
  };
}

// --- Internal helpers ---

async function readSource<T>(
  source: AmpleFileOverviewSource,
  reader: (() => Promise<T[]>) | undefined,
  unavailable: Set<AmpleFileOverviewSource>,
): Promise<T[] | null> {
  if (!reader) return null;
  try {
    return (await reader()).slice(0, maxSourceRecords);
  } catch {
    unavailable.add(source);
    return null;
  }
}

async function readConnectedFolderSource<T>(
  source: AmpleFileOverviewSource,
  connectedFolders: AmpleFileOverviewConnectedFolderRef[],
  reader: ((connectedFolder: AmpleFileOverviewConnectedFolderRef) => Promise<T>) | undefined,
  unavailable: Set<AmpleFileOverviewSource>,
): Promise<Array<{ connectedFolder: AmpleFileOverviewConnectedFolderRef; records: T }>> {
  if (!reader) return [];
  const results: Array<{ connectedFolder: AmpleFileOverviewConnectedFolderRef; records: T }> = [];
  for (const connectedFolder of connectedFolders) {
    try {
      results.push({ connectedFolder, records: await reader(connectedFolder) });
    } catch {
      // Keep the Connected Folders that could be read and disclose the failure instead
      // of rendering the whole source as quiet.
      unavailable.add(source);
    }
  }
  return results;
}

function overviewItem(input: {
  id: string;
  at: string;
  kind: AmpleFileOverviewItemKind;
  connectedFolderId?: string;
  connectedFolderNames?: Map<string, string>;
  headline: string;
  ref?: AmpleFileOverviewItemRef;
}): AmpleFileOverviewItem {
  const ref = input.ref ? pruneRef(input.ref) : undefined;
  return {
    id: input.id,
    at: input.at,
    kind: input.kind,
    ...(input.connectedFolderId
      ? {
        connectedFolderId: input.connectedFolderId,
        connectedFolderName: input.connectedFolderNames?.get(input.connectedFolderId) ?? `${input.connectedFolderId} (removed)`,
      }
      : {}),
    headline: clampText(input.headline, maxHeadlineLength),
    ...(ref ? { ref } : {}),
  };
}

function pruneRef(ref: AmpleFileOverviewItemRef): AmpleFileOverviewItemRef | undefined {
  const pruned: AmpleFileOverviewItemRef = {
    ...(ref.taskId ? { taskId: ref.taskId } : {}),
    ...(ref.conversationId ? { conversationId: ref.conversationId } : {}),
    ...(ref.checkpointId ? { checkpointId: ref.checkpointId } : {}),
    ...(ref.requestId ? { requestId: ref.requestId } : {}),
    ...(ref.questionId ? { questionId: ref.questionId } : {}),
    ...(ref.automationId ? { automationId: ref.automationId } : {}),
    ...(ref.runId ? { runId: ref.runId } : {}),
  };
  return Object.keys(pruned).length ? pruned : undefined;
}

function newestFirst(left: AmpleFileOverviewItem, right: AmpleFileOverviewItem): number {
  return compareTimestamps(right.at, left.at) || compareStrings(left.id, right.id);
}

function chatLifecycleHeadline(title: string, event: AmpleFileOverviewChatLifecycleEvent): string {
  if (event.change === "archived") return `"${title}" archived`;
  if (event.change === "restored") return `"${title}" restored`;
  if (event.change === "snoozed") return `"${title}" snoozed${event.snoozedUntil ? ` until ${event.snoozedUntil}` : ""}`;
  return `"${title}" snooze cleared`;
}

/**
 * An app's named automation by the app's and the automation's titles
 * (`Inbox automation "Refresh inbox"`), so it reads apart from AmpleFile's
 * own Automations. A run whose app is gone keeps its declared id.
 */
function appAutomationSubject(record: { appAutomationId: string; appTitle?: string; automationTitle?: string }): string {
  const automation = clampText(record.automationTitle?.trim() || record.appAutomationId, maxTitleInHeadline);
  const app = record.appTitle?.trim();
  return app ? `${clampText(app, maxTitleInHeadline)} automation "${automation}"` : `App automation "${automation}"`;
}

function appAutomationOutcomeLabel(outcome: AmpleFileOverviewAppAutomationOutcome): string {
  if (outcome === "success") return "succeeded";
  if (outcome === "failure") return "failed";
  return outcome;
}

function checkStatePriority(state: AmpleFileCheckAggregateState): number {
  if (state === "needs-attention") return 0;
  if (state === "check-error") return 1;
  if (state === "blocked") return 2;
  if (state === "stale") return 3;
  if (state === "current-clear") return 4;
  return 5;
}

function isAtOrBefore(timestamp: string, referenceMs: number): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed <= referenceMs;
}

function compareTimestamps(left: string, right: string): number {
  const parsedLeft = Date.parse(left);
  const parsedRight = Date.parse(right);
  if (Number.isFinite(parsedLeft) && Number.isFinite(parsedRight)) {
    return parsedLeft < parsedRight ? -1 : parsedLeft > parsedRight ? 1 : 0;
  }
  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clampText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

async function readStoreText(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    return text.length > maxStoreBytes ? null : text;
  } catch {
    return null;
  }
}

const automationRunTerminalOutcomes = new Map<string, AmpleFileOverviewAutomationRunState>([
  ["ok", "succeeded"],
  ["succeeded", "succeeded"],
  ["error", "failed"],
  ["failed", "failed"],
  ["stopped", "stopped"],
  ["interrupted", "interrupted"],
  ["skipped", "skipped"],
]);

function applyAutomationReceiptLine(runs: Map<string, AmpleFileOverviewAutomationRunRecord>, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as {
    v?: unknown;
    at?: unknown;
    runId?: unknown;
    automationId?: unknown;
    scope?: unknown;
    outcome?: unknown;
    hopId?: unknown;
    title?: unknown;
  };
  if (record.v !== 1) return;
  if (!isIsoTimestamp(record.at) || !isRecordId(record.runId) || !isRecordId(record.automationId)) return;
  if (typeof record.outcome !== "string") return;
  const title = typeof record.title === "string" && record.title.length <= 512 ? { title: record.title } : {};
  const existing = runs.get(record.runId);
  if (record.scope === "run") {
    if (record.outcome === "accepted") {
      runs.set(record.runId, {
        runId: record.runId,
        automationId: record.automationId,
        ...title,
        state: "running",
        startedAt: record.at,
        hops: existing?.hops ?? [],
      });
      return;
    }
    const terminal = automationRunTerminalOutcomes.get(record.outcome);
    if (!terminal) return;
    runs.set(record.runId, {
      runId: record.runId,
      automationId: record.automationId,
      ...(existing?.title ? { title: existing.title } : title),
      state: terminal,
      startedAt: existing?.startedAt ?? record.at,
      endedAt: record.at,
      hops: existing?.hops ?? [],
    });
    return;
  }
  if (record.scope !== "hop" || !isRecordId(record.hopId)) return;
  const hopState = record.outcome === "accepted"
    ? "running"
    : automationRunTerminalOutcomes.get(record.outcome);
  if (!hopState || !existing) return;
  const hops = existing.hops.filter((hop) => hop.id !== record.hopId);
  hops.push({ id: record.hopId, state: hopState });
  runs.set(record.runId, { ...existing, hops });
}

function isRecordId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxRecordIdLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64
    && Number.isFinite(Date.parse(value));
}
