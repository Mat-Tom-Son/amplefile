/**
 * The collaboration verbs' view of request records: the task ownership rules,
 * the refs and views the act lane returns, report and handoff files, and a
 * task's status and result.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { readConversation, type ChatMessage } from "../agent/chat-store.js";
import {
  AmpleFileRequestLimitError,
  AmpleFileRequestLineageError,
  isAmpleFileRequestTerminalState,
  ampleFileRequestLimitMessage,
  type AmpleFileRequestRecord,
  type AmpleFileQuestionRecord,
  type AmpleFileResultEnvelope,
} from "../requests/request-records.js";
import { ampleFileRequestLimits } from "../../shared/amplefile-limits.js";
import { connectedFolderTurnParentHandle } from "../agent/connected-folder-turn-context.js";
import { ampleFileAgentScopeId } from "../state-paths.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import type {
  AmpleFileActChatMessage,
  AmpleFileActChatState,
  AmpleFileActFacade,
  AmpleFileActQuestionRef,
  AmpleFileActRequestDetail,
  AmpleFileActRequestRef,
  AmpleFileActRequestResult,
  AmpleFileActRequestSummary,
  AmpleFileActWaitingRef,
  AmpleFileActTurnStatus,
} from "../cli/act-facade.js";
import { listConnectedFolders, resolveConnectedFolderPath, type ConnectedFolderSummary } from "../connected-folder.js";
import { runActOperation } from "../server.js";
import { normalizeConnectedFolderRelativePath, pathContainsPath } from "./file-changes.js";
import { errorMessage } from "./http.js";
import { stopAmpleFileAgentRequest } from "./request-routes.js";
import { conversationRuntimeState, type LocalApiState, type SettledTurnRecord } from "./state.js";

export async function turnResultForScope(
  state: LocalApiState,
  scopeId: string,
  rootPath: string,
  taskId: string,
): ReturnType<AmpleFileActFacade["agentTurnResult"]> {
  const request = state.requests.byTaskId(taskId);
  if (request && (request.owner.connectedFolderId ?? ampleFileAgentScopeId) === scopeId) {
    if (!isAmpleFileRequestTerminalState(request.state)) throw new AmpleFileCliError("conflict", "The request is still outstanding. Use chat wait or chat status --task.");
    taskId = request.turns.at(-1)!.taskId;
  }
  const task = turnStatusFor(state, scopeId, taskId);
  if (task.state === "running") {
    throw new AmpleFileCliError("conflict", "The turn is still running. Use chat wait or chat status --task.");
  }
  if (task.state === "unknown") {
    throw new AmpleFileCliError("notFound", "Task not found. Recent turn outcomes are kept in a bounded durable journal.");
  }
  if (task.state === "aborted") throw new AmpleFileCliError("conflict", "The turn was aborted before it finished.");
  if (task.state === "failed") throw new AmpleFileCliError("failure", task.error ?? "The turn failed.");
  const conversationId = task.conversationId!;
  const messages = await runActOperation(() => readConversation(rootPath, conversationId));
  const message = messages.find((item) => item.id === task.messageId);
  if (!message) throw new AmpleFileCliError("failure", "The turn's response message could not be found in the transcript.");
  const result = await completedRequestEnvelope(state, taskId);
  await noteResultReadByRunningParent(state, taskId);
  return {
    conversationId,
    task: { taskId, state: "succeeded" as const, endedAt: task.endedAt! },
    message: toActChatMessage(message),
    request: state.requests.byTaskId(taskId) ? toActRequestRefForConnectedFolder(state, state.requests.byTaskId(taskId)!) : null,
    result,
  };
}

/**
 * A parent that reads a child's settled result while its own turn is still
 * running has received it: `chat wait` and `agent wait` end with exactly this
 * read. Recording that delivery by the child's turn identity keeps the host
 * from starting a follow-up turn that repeats the same result. A later
 * child turn, such as an answer's continuation, is a new identity and is
 * still delivered.
 */
async function noteResultReadByRunningParent(state: LocalApiState, taskId: string): Promise<void> {
  const child = state.requests.byTaskId(taskId);
  if (!child?.parentRequestId || !isAmpleFileRequestTerminalState(child.state) || child.turns.at(-1)!.taskId !== taskId) return;
  const parent = state.requests.get(child.parentRequestId);
  const parentTurn = parent?.turns.at(-1);
  if (!parent || !parentTurn || (parentTurn.state !== "accepted" && parentTurn.state !== "running")) return;
  if (parent.deliveredChildTaskIds.includes(taskId)) return;
  await state.requests.noteChildDelivery(parent.requestId, [taskId]);
}

/** Only a request's selected report/final reply, never its transcript or graph. */
/** Whether the request's latest turn filed its own result with `chat report`, rather than ending with only a reply. */
export function turnReportedResult(state: LocalApiState, taskId: string): boolean {
  const request = state.requests.byTaskId(taskId);
  const latest = request?.turns.at(-1);
  return Boolean(request && latest && request.results.some((item) => item.taskId === latest.taskId));
}

export async function completedRequestEnvelope(state: LocalApiState, taskId: string): Promise<AmpleFileResultEnvelope | null> {
  const request = state.requests.byTaskId(taskId);
  if (!request || !isAmpleFileRequestTerminalState(request.state)) return null;
  const latest = request.turns.at(-1)!;
  const ref = [...request.results].reverse().find((item) => item.taskId === latest.taskId);
  if (ref) {
    const read = await state.requests.result(ref.resultId);
    if (read?.state !== "ok") throw new AmpleFileCliError("failure", "The selected result is unavailable; its receipt remains on record.");
    return { ...read.record.envelope,
      ...(request.state === "partial" && read.record.envelope.outcome === "succeeded" ? { outcome: "partial" as const } : {}) };
  }
  const turn = state.turnStore.get(latest.taskId);
  return {
    summary: clampUtf8(turn?.assistantText || latest.error || "The request ended without a reported result.", ampleFileRequestLimits.maxResultSummaryBytes),
    outcome: request.state === "done" ? "succeeded" : request.state === "partial" ? "partial" : "failed",
  };
}

export async function conversationResultForScope(
  state: LocalApiState,
  scopeId: string,
  rootPath: string,
  conversationId: string,
  messageLimit?: number,
): Promise<{
  conversationId: string;
  state: AmpleFileActChatState;
  total: number;
  lastAssistant: string | null;
  messages: AmpleFileActChatMessage[];
}> {
  const all = await runActOperation(() => readConversation(rootPath, conversationId));
  if (!all.length) throw new AmpleFileCliError("notFound", "Conversation not found.");
  const visible = all.filter((message) => message.role === "user" || message.role === "assistant");
  const limit = Math.max(Math.floor(messageLimit ?? 10), 1);
  const lastAssistant = [...visible].reverse().find((message) => message.role === "assistant")?.content ?? null;
  return {
    conversationId,
    state: conversationRuntimeState(state, scopeId, conversationId),
    total: visible.length,
    lastAssistant,
    messages: visible.slice(-limit).map(toActChatMessage),
  };
}

export function turnStatusFor(state: LocalApiState, connectedFolderId: string, taskId: string): AmpleFileActTurnStatus {
  const active = state.activeTurnTasks.get(taskId);
  if (active && active.connectedFolderId === connectedFolderId) {
    return { taskId, state: "running", conversationId: active.conversationId, messageId: null, error: null, endedAt: null };
  }
  const settled = state.settledTurns.get(taskId);
  if (settled && settled.connectedFolderId === connectedFolderId) {
    return {
      taskId,
      state: settled.status,
      conversationId: settled.conversationId,
      messageId: settled.messageId ?? null,
      error: settled.error ?? null,
      endedAt: settled.endedAt,
    };
  }
  // Older than the in-memory window: the durable turn journal still knows it.
  const durable = state.turnStore.get(taskId);
  if (durable && durable.connectedFolderId === connectedFolderId && durable.status !== "accepted" && durable.status !== "running") {
    return {
      taskId,
      state: durable.status === "interrupted" ? "failed" : durable.status,
      conversationId: durable.conversationId,
      messageId: durable.messageId ?? null,
      error: durable.error ?? null,
      endedAt: durable.updatedAt,
    };
  }
  return { taskId, state: "unknown", conversationId: null, messageId: null, error: null, endedAt: null };
}

/**
 * The `--task` rule for `chat report`, `chat ask`, and `chat handoff`: the
 * id must name the caller's own turn — the newest, still-running turn of a
 * request the named Connected Folder owns — checked exactly as `--parent-task` is. The
 * store's lineage refusal reaches the caller as a conflict by name.
 */
export function assertOwnTask(state: LocalApiState, connectedFolderId: string, taskId: string): AmpleFileRequestRecord {
  try {
    return state.requests.assertOwnAcceptingTurn(taskId, connectedFolderId === ampleFileAgentScopeId ? {} : { connectedFolderId });
  } catch (error) {
    throw collaborationRefusal(error);
  }
}

/** The caller's own turn, in whichever scope it runs, while it is still running. */
export function assertCallerTurn(state: LocalApiState, callerTaskId: string): AmpleFileRequestRecord {
  const record = state.requests.byTaskId(callerTaskId);
  return assertOwnTask(state, record?.owner.connectedFolderId ?? ampleFileAgentScopeId, callerTaskId);
}

/**
 * Whether a Chat is one the caller's own Chat handed work to: some request in
 * that Chat has a parent request owned by the caller's Chat, in any of its
 * turns. A Worker may follow up with, redirect, or copy only such work, never
 * an unrelated Chat (docs/collaboration-contract.md). The caller's task must be
 * its own turn that is still running.
 */
export function assertCallerHandedWorkTo(state: LocalApiState, callerTaskId: string, target: { connectedFolderId: string; conversationId: string }): AmpleFileRequestRecord {
  const caller = assertCallerTurn(state, callerTaskId);
  const callerScope = caller.owner.connectedFolderId ?? ampleFileAgentScopeId;
  const handedTo = state.requests.list().some((record) => {
    if ((record.owner.connectedFolderId ?? ampleFileAgentScopeId) !== target.connectedFolderId || record.owner.conversationId !== target.conversationId) return false;
    const parent = record.parentRequestId ? state.requests.get(record.parentRequestId) : null;
    return parent !== null && parent !== undefined
      && (parent.owner.connectedFolderId ?? ampleFileAgentScopeId) === callerScope
      && parent.owner.conversationId === caller.owner.conversationId;
  });
  if (!handedTo) {
    throw new AmpleFileCliError("conflict", "That Chat is not one this Chat handed work to. Hand off new work with chat handoff instead.");
  }
  return caller;
}

/** A request bound or lineage refusal is a conflict that carries the store's own sentence; anything else passes through. */
export function collaborationRefusal(error: unknown): unknown {
  if (error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError) {
    return new AmpleFileCliError("conflict", error.message, { cause: error });
  }
  return error;
}

export function requestLimitRefusalMessage(limit: "questionLifetime"): string {
  return "This request has expired.";
}

/**
 * The `waiting` field: the oldest open question this task itself asked,
 * or null. A question past its window by wall-clock is never reported live
 * even before the store's sweep marks it expired.
 */
export function waitingRefForTask(state: LocalApiState, taskId: string): AmpleFileActWaitingRef | null {
  const record = state.requests.byTaskId(taskId);
  if (!record) return null;
  const now = Date.now();
  const open = state.requests.questions(record.requestId)
    .filter((question) => (question.state === "open" || (question.state === "answered" && question.continuationTaskId === null)) && (question.expiresAt === null || now < Date.parse(question.expiresAt)))
    .sort((left, right) => left.askedAt.localeCompare(right.askedAt));
  const question = open[0];
  if (!question) return null;
  return {
    questionId: question.questionId,
    requestId: question.requestId,
    respondent: question.respondent,
    question: question.text,
    askedAt: question.askedAt,
    expiresAt: question.expiresAt,
  };
}

/**
 * The request reference a Connected Folder–scoped verb hands back to the caller.
 *
 * Identical to `toActRequestRef` except for one field: a delegated Connected Folder
 * request's `rootId` is usually the AmpleFile Agent's root request id, and
 * `requests show` reads a request by id. Handing that id into a Connected Folder turn
 * would put the AmpleFile Agent's own content and other Connected Folders' results one taught
 * command away — the same leak `connected-folder-turn-context.ts` withholds the parent
 * request id to avoid — so it is projected through the same opaque handle no
 * verb accepts. A Connected Folder's own root still names itself.
 */
export function toActRequestRefForConnectedFolder(state: LocalApiState, record: AmpleFileRequestRecord): AmpleFileActRequestRef {
  const ref = toActRequestRef(state, record);
  if (record.owner.connectedFolderId === undefined || record.rootId === record.requestId) return ref;
  return { ...ref, rootId: connectedFolderTurnParentHandle(record.rootId, state.connectedFolderTurnHandleSalt) };
}

export function toActRequestRef(state: LocalApiState, record: AmpleFileRequestRecord): AmpleFileActRequestRef {
  return {
    id: record.requestId,
    rootId: record.rootId,
    kind: record.kind,
    state: record.state,
    depth: record.depth,
    connectedFolderId: record.owner.connectedFolderId ?? null,
    connectedFolderName: record.owner.connectedFolderName ?? null,
    conversationId: record.owner.conversationId,
    deadline: record.deadline,
    openQuestions: state.requests.questions(record.requestId).filter((question) => question.state === "open").length,
    children: record.childRequestIds.length,
    results: record.results.length,
  };
}

export function toActQuestionRef(question: AmpleFileQuestionRecord): AmpleFileActQuestionRef {
  return {
    questionId: question.questionId,
    requestId: question.requestId,
    taskId: question.taskId,
    respondent: question.respondent,
    text: question.text,
    ...(question.asynchronous ? { asynchronous: true } : {}),
    ...(question.options?.length ? { options: [...question.options] } : {}),
    state: question.state,
    askedAt: question.askedAt,
    expiresAt: question.expiresAt,
    answer: question.answer,
    answeredAt: question.answeredAt,
    continuationTaskId: question.continuationTaskId,
  };
}

export function requestSummaryView(state: LocalApiState, record: AmpleFileRequestRecord): AmpleFileActRequestSummary {
  return {
    ...toActRequestRef(state, record),
    surface: record.surface,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    settledAt: record.settledAt,
    taskId: record.turns.at(-1)!.taskId,
    continuationCount: record.continuationCount,
    limitHit: record.limitHit,
  };
}

/**
 * `requests list` and `requests show` are management-scope reads: the whole
 * graph, including the AmpleFile Agent's own assignment text and every Connected Folder's result
 * envelope. A caller working inside a registered Connected Folder is inside that Connected Folder's
 * scope, and what may reach a Connected Folder is its assignment, answers to its own
 * questions, and payloads released to it — never the graph
 * (docs/collaboration-contract.md). The caller's directory resolves its scope
 * exactly as `context` does, and the refusal names the boundary and the verbs
 * that do belong to a Connected Folder.
 */
export async function assertRequestsAboveConnectedFolders(cwd: string | undefined): Promise<void> {
  const candidate = cwd?.trim();
  if (!candidate) return;
  const resolved = resolve(candidate);
  const containing = (await listConnectedFolders())
    .filter((connectedFolder) => pathContainsPath(connectedFolder.connectedFolderRoot, resolved))
    .sort((left, right) => resolve(right.connectedFolderRoot).length - resolve(left.connectedFolderRoot).length)[0];
  if (!containing) return;
  throw new AmpleFileCliError(
    "permissionDenied",
    `The request record sits above Connected Folders, and this ran inside "${containing.name}". Follow your own work with 'chat status' and 'chat wait', and report with 'chat report'.`,
  );
}

/** `requests show`: the complete subtree, rejecting damaged cycles. */
export async function requestDetailView(state: LocalApiState, record: AmpleFileRequestRecord, ancestors = new Set<string>()): Promise<AmpleFileActRequestDetail> {
  if (ancestors.has(record.requestId)) throw new Error("Request graph contains a cycle.");
  const path = new Set(ancestors).add(record.requestId);
  const reads = await state.requests.results(record.requestId);
  const resultRecords: AmpleFileActRequestResult[] = record.results.map((ref) => {
    const read = reads.find((candidate) => (candidate.state === "ok" ? candidate.record.resultId : candidate.resultId) === ref.resultId);
    return {
      resultId: ref.resultId,
      taskId: ref.taskId,
      recordedAt: ref.recordedAt,
      receiptId: ref.receiptId,
      outcome: ref.outcome,
      fileCount: ref.fileCount,
      envelope: read?.state === "ok" ? read.record.envelope : null,
      ...(read?.state === "damaged" ? { damaged: read.error } : {}),
    };
  });
  const childRequests: AmpleFileActRequestDetail[] = [];
  if (state.requests.children(record.requestId).length) {
    for (const child of state.requests.children(record.requestId)) {
      childRequests.push(await requestDetailView(state, child, path));
    }
  }
  return {
    ...requestSummaryView(state, record),
    parentRequestId: record.parentRequestId,
    parentTaskId: record.parentTaskId,
    content: record.content,
    turns: record.turns.map((turn) => ({
      taskId: turn.taskId,
      role: turn.role,
      state: turn.state,
      acceptedAt: turn.acceptedAt,
      settledAt: turn.settledAt,
      error: turn.error,
    })),
    questions: state.requests.questions(record.requestId).map(toActQuestionRef),
    resultRecords,
    usage: record.usage,
    stopRequestedAt: record.stopRequestedAt,
    reconciledAt: record.reconciledAt,
    jobs: (record.jobs ?? []).map((job) => ({ ...job })),
    childRequests,
  };
}

/**
 * A report's deliverables: each named path must be a file inside the Connected Folder,
 * outside the reserved folders, and is recorded by content hash and size so
 * the envelope says exactly which bytes were meant.
 */
export async function resolveReportFiles(
  connectedFolder: ConnectedFolderSummary,
  files: string[],
): Promise<Array<{ path: string; sha256: string; sizeBytes: number }>> {
  const resolved: Array<{ path: string; sha256: string; sizeBytes: number }> = [];
  for (const raw of files) {
    const relativePath = normalizeConnectedFolderRelativePath(raw);
    let absolute: string;
    try {
      absolute = resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, relativePath);
    } catch (error) {
      throw new AmpleFileCliError("usage", `--file ${raw}: ${errorMessage(error)}`, { cause: error });
    }
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new AmpleFileCliError("notFound", `--file ${raw}: not found in ${connectedFolder.name}.`);
    if (!info.isFile()) throw new AmpleFileCliError("usage", `--file ${raw}: a result names files, not folders.`);
    const hash = createHash("sha256");
    await new Promise<void>((resolveHash, reject) => {
      createReadStream(absolute)
        .on("data", (chunk) => hash.update(chunk))
        .on("error", reject)
        .on("end", () => resolveHash());
    });
    resolved.push({ path: relativePath, sha256: hash.digest("hex"), sizeBytes: info.size });
  }
  return resolved;
}

/** `--data @<path>`: read host-side against the directory the command ran in, bounded by the envelope's own data limit. */
export async function readReportDataFile(dataPath: string, cwd: string): Promise<unknown> {
  const absolute = isAbsolute(dataPath) ? resolve(dataPath) : resolve(cwd, dataPath);
  const info = await stat(absolute).catch(() => null);
  if (!info || !info.isFile()) throw new AmpleFileCliError("notFound", `--data @${dataPath}: file not found.`);
  if (info.size > ampleFileRequestLimits.maxResultDataBytes) {
    throw new AmpleFileCliError("usage", ampleFileRequestLimitMessage("resultData", ampleFileRequestLimits.maxResultDataBytes));
  }
  const text = await readFile(absolute, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AmpleFileCliError("usage", `--data @${dataPath}: the file is not valid JSON.`, { cause: error });
  }
}

/** A handoff source is a Connected Folder–relative path resolved inside the caller's own Connected Folder. */
export function resolveHandoffSource(connectedFolder: ConnectedFolderSummary, raw: string): string {
  try {
    return resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, normalizeConnectedFolderRelativePath(raw));
  } catch (error) {
    throw new AmpleFileCliError("usage", `--file ${raw}: ${errorMessage(error)}`, { cause: error });
  }
}

/** Cuts on a byte bound and drops a trailing partial character rather than storing a replacement glyph. */
export function clampUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - Buffer.byteLength("…"))).toString("utf8").replace(/�+$/u, "")}…`;
}

function toActChatMessage(message: ChatMessage): AmpleFileActChatMessage {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    createdAt: message.createdAt,
    ...(message.interruption ? { interrupted: true } : {}),
  };
}

/**
 * Follows one accepted turn to its settled record, honoring the automation
 * run's abort signal through the same cancellation path `agent stop` uses.
 * The accepted turn always settles (its runner records an outcome in a
 * finally block), so the wait terminates; a record evicted by the bounded
 * settled-turn history reports honestly as lost.
 */
export async function waitForSettledRequest(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  taskId: string,
  signal: AbortSignal,
): Promise<SettledTurnRecord> {
  const requestAbort = (): void => { void stopAmpleFileAgentRequest(state, taskId).catch(() => undefined); };
  if (signal.aborted) requestAbort();
  signal.addEventListener("abort", requestAbort, { once: true });
  try {
    for (;;) {
      // A settle may reserve a synthesis turn. Observe that decision before
      // admitting the next automation hop.
      await state.requestSettleChain;
      const request = state.requests.byTaskId(taskId);
      // A stop fences the graph before native abort cleanup finishes. A
      // automation's terminal receipt must wait for that cleanup, so its next
      // observer cannot see completed automation work with live kernel tasks.
      // Asking a question puts the request in `waiting` without ending the
      // asking turn (docs/collaboration-contract.md), so a waiting hop also
      // returns only once no turn in its graph is still running.
      if (request && (request.state === "waiting" || isAmpleFileRequestTerminalState(request.state))
        && [request, ...state.requests.subtree(request.requestId)].some((item) => item.turns.some((turn) => state.activeTurnTasks.has(turn.taskId)))) {
        await settleDelay(25);
        continue;
      }
      if (request && (request.state === "waiting" || isAmpleFileRequestTerminalState(request.state))) {
        const latest = request.turns.at(-1)!;
        const settled = state.settledTurns.get(latest.taskId);
        return {
          ...(settled ?? { taskId: latest.taskId, connectedFolderId, conversationId, endedAt: new Date().toISOString() }),
          status: request.state === "done" ? "succeeded" : request.state === "stopped" ? "aborted" : "failed",
          ...(request.state === "done" ? {} : { error: request.state === "waiting"
            ? "The Worker request needs an answer in its Chat. This automation ended here; answering does not replay later hops."
            : `The Worker request ended ${request.state}.` }),
        };
      }
      if (!request && !state.activeTurnTasks.has(taskId)) {
        return { taskId, connectedFolderId, conversationId, status: "failed", endedAt: new Date().toISOString(), error: "AmpleFile lost track of this request." };
      }
      await settleDelay(25);
    }
  } finally { signal.removeEventListener("abort", requestAbort); }
}

function settleDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
