/**
 * Request routes and the host side of the request graph
 * (docs/collaboration-contract.md): what a request has under way, a person's
 * answer, Stop, or Continue, the request-level stop, and the settle evaluation
 * that starts at most one follow-up turn.
 */

import { randomUUID } from "node:crypto";
import { workRequestLabel, type WorkRequestView } from "../../shared/request-presentation.js";
import {
  isAmpleFileRequestTerminalState,
  ampleFileRequestLimitsSection,
  ampleFileAnswerMatchesRecorded,
  type AmpleFileRequestLimitName,
  type AmpleFileRequestRecord,
} from "../requests/request-records.js";
import type { AmpleFileJobRecord } from "../jobs/job-records.js";
import { ampleFileRequestLimits, ampleFileAutomationDeclarationBounds } from "../../shared/amplefile-limits.js";
import { ampleFileAgentScopeId } from "../state-paths.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import { getConnectedFolder } from "../connected-folder.js";
import { createAmpleFileActFacade } from "../server.js";
import { ampleFileAgentScope } from "./amplefile-agent-routes.js";
import { composeBackgroundJobLines, deliverBackgroundJobs, undeliveredSettledJobs } from "./background-jobs.js";
import { publishControlHint } from "./event-streams.js";
import { badRequest, errorMessage, httpError, match, notFound, readJsonBody, sendJson } from "./http.js";
import { clampUtf8, turnStatusFor } from "./request-records.js";
import { clientKey, type LocalApiRequest, type LocalApiState } from "./state.js";
import { acceptConversationTurn } from "./turn-acceptance.js";

/** The work a request has under way, and a person's answer, Stop, or Continue on it. */
export async function handleRequestRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  const connectedFolderWorkMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/work$/);
  const ampleFileAgentWorkMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/work$/);
  const taskWorkMatch = match(url.pathname, /^\/api\/tasks\/([^/]+)\/work$/);
  if (method === "GET" && (connectedFolderWorkMatch || ampleFileAgentWorkMatch || taskWorkMatch)) {
    if (connectedFolderWorkMatch) await getConnectedFolder(connectedFolderWorkMatch[1]);
    const record = taskWorkMatch ? state.requests.byTaskId(taskWorkMatch[1])
      : state.requests.latestForConversation(connectedFolderWorkMatch?.[2] ?? ampleFileAgentWorkMatch![1],
        connectedFolderWorkMatch ? { connectedFolderId: connectedFolderWorkMatch[1] } : {});
    sendJson(res, { work: record ? await requestPresentation(state, record) : null });
    return true;
  }
  const workActionMatch = match(url.pathname, /^\/api\/requests\/([^/]+)\/(answer|stop|continue)$/);
  if (method === "POST" && workActionMatch) {
    const record = state.requests.get(workActionMatch[1]);
    if (!record) throw notFound("This work is no longer on record.");
    const input = await readJsonBody<Record<string, unknown>>(state, req);
    await performWorkAction(state, record, workActionMatch[2], input);
    sendJson(res, { work: await requestPresentation(state, state.requests.get(record.requestId)!) });
    return true;
  }
  return false;
}

/** The person-facing sentence for a bound a request stopped at; it names the Settings section like every refusal. */
export function requestLimitStopMessage(limit: AmpleFileRequestLimitName): string {
  const shows = `${ampleFileRequestLimitsSection} shows this number.`;
  switch (limit) {
    case "providerBudget":
      return `This request reached its model spending limit, so AmpleFile stopped it. ${shows}`;
    default:
      return `This request reached one of its limits, so AmpleFile stopped it. ${shows}`;
  }
}

/**
 * Request-level stop. Aborting the request's own turn does not implicitly
 * stop a review already running in a Connected Folder — only turns recorded under this
 * request are aborted, each explicitly, and the result names every turn it
 * touched. The stop cascades through the whole owned graph: every descendant
 * request is marked, its open questions are withdrawn, and its running turn
 * is cancelled (docs/collaboration-contract.md).
 */
export async function stopAmpleFileAgentRequest(
  state: LocalApiState,
  taskId: string,
): Promise<{ taskId: string; ampleFileAgentAborted: boolean; children: Array<{ taskId: string; conversationId: string; connectedFolderId: string; aborted: boolean }> }> {
  const record = state.requests.byTaskId(taskId);
  if (!record) {
    throw new AmpleFileCliError("notFound", `Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
  }
  const scopeId = record.owner.connectedFolderId ?? ampleFileAgentScopeId;
  const ownTurn = record.turns.at(-1)!;
  const ampleFileAgentWasRunning = turnStatusFor(state, scopeId, ownTurn.taskId).state === "running";
  // The whole graph below this request, not only a root's: `agent stop`
  // takes any task id, so a mid-graph request must still close everything it
  // handed on (docs/collaboration-contract.md).
  const descendants = state.requests.subtree(record.requestId);
  const runningChildren = descendants.flatMap((descendant) => {
    if (descendant.owner.connectedFolderId === undefined) return [];
    const turn = descendant.turns.at(-1)!;
    return turnStatusFor(state, descendant.owner.connectedFolderId, turn.taskId).state === "running"
      ? [{ taskId: turn.taskId, conversationId: descendant.owner.conversationId, connectedFolderId: descendant.owner.connectedFolderId, requestId: descendant.requestId }]
      : [];
  });
  // A stop reaches everything still open under this request, not only the
  // turns running this instant: a child whose turn ended while waiting on an
  // answer is closed too, so a late `chat answer` is refused and no
  // continuation turn can follow (docs/collaboration-contract.md).
  const openBelow = !isAmpleFileRequestTerminalState(record.state)
    || descendants.some((descendant) => !isAmpleFileRequestTerminalState(descendant.state));
  if (ampleFileAgentWasRunning || runningChildren.length || openBelow) {
    await state.requests.markStopRequested(record.requestId);
    await state.requests.cancelQuestions(record.requestId, "stopped");
    for (const descendant of descendants) {
      await state.requests.markStopRequested(descendant.requestId);
      await state.requests.cancelQuestions(descendant.requestId, "stopped");
    }
  }
  // Stop reaches every background job of this request and the graph below
  // it: SIGTERM to each process group, then SIGKILL (docs/background-jobs.md).
  // Deletion waits for them through requestHasUnsettledWork.
  const runningJobIds = [record, ...descendants].flatMap((item) =>
    (item.jobs ?? []).filter((job) => job.state === "running").map((job) => job.jobId));
  if (runningJobIds.length) {
    void state.jobs.stopMany(runningJobIds, "request").catch((error: unknown) => {
      console.error(`Background jobs could not all be stopped: ${errorMessage(error)}`);
    });
  }
  let ampleFileAgentAborted = false;
  if (ampleFileAgentWasRunning) {
    ampleFileAgentAborted = await cancelAcceptedTurn(state, scopeId, record.owner.conversationId, ownTurn.taskId);
  }
  const children: Array<{ taskId: string; conversationId: string; connectedFolderId: string; aborted: boolean }> = [];
  for (const child of runningChildren) {
    const aborted = await cancelAcceptedTurn(state, child.connectedFolderId, child.conversationId, child.taskId);
    children.push({
      taskId: child.taskId,
      conversationId: child.conversationId,
      connectedFolderId: child.connectedFolderId,
      aborted,
    });
  }
  return { taskId, ampleFileAgentAborted, children };
}

async function cancelAcceptedTurn(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  taskId: string,
): Promise<boolean> {
  if (turnStatusFor(state, connectedFolderId, taskId).state !== "running") return false;
  state.cancelledTurnTasks.add(taskId);
  const client = state.clients.get(clientKey(connectedFolderId, conversationId));
  await client?.abort().catch(() => false);
  return true;
}

const maxTurnsRememberedThisRun = 4_000;

/**
 * Every settle in this app run passes through here, serialized, so two
 * children settling in the same tick can never start two continuations.
 * Failures are logged; a settle never fails because of a continuation.
 */
export function queueRequestGraphSettle(state: LocalApiState, taskId: string): void {
  state.turnsSettledThisRun.add(taskId);
  while (state.turnsSettledThisRun.size > maxTurnsRememberedThisRun) {
    const oldest = state.turnsSettledThisRun.values().next().value;
    if (oldest === undefined) break;
    state.turnsSettledThisRun.delete(oldest);
  }
  state.requestSettleChain = state.requestSettleChain
    .then(() => evaluateRequestGraphSettle(state, taskId))
    .catch((error: unknown) => {
      console.error(`A request continuation could not be evaluated: ${errorMessage(error)}`);
    });
}

/** Releasing compaction makes pending deliveries eligible without inventing a new turn settlement. */
export function queueConversationRequestEvaluation(state: LocalApiState, connectedFolderId: string, conversationId: string): void {
  state.requestSettleChain = state.requestSettleChain
    .then(async () => {
      for (const request of state.requests.list({ connectedFolderId })) {
        if (request.owner.conversationId === conversationId) {
          await evaluateRequestGraphSettle(state, request.turns.at(-1)!.taskId);
        }
      }
    })
    .catch((error: unknown) => {
      console.error(`A request continuation could not be evaluated after compaction: ${errorMessage(error)}`);
    });
}

export async function evaluateRequestGraphSettle(state: LocalApiState, taskId: string): Promise<void> {
  const record = state.requests.byTaskId(taskId);
  if (!record) return;
  const candidates = new Map<string, AmpleFileRequestRecord>();
  let current: AmpleFileRequestRecord | null = record;
  while (current) {
    candidates.set(current.requestId, current);
    current = current.parentRequestId ? state.requests.get(current.parentRequestId) : null;
  }
  // Finishing any turn frees its Chat, including one that was occupied by a
  // newer request when this request's children finished.
  for (const other of state.requests.list()) {
    if (other.owner.connectedFolderId === record.owner.connectedFolderId && other.owner.conversationId === record.owner.conversationId) {
      candidates.set(other.requestId, other);
    }
  }
  for (const candidate of [...candidates.values()].sort((a, b) => b.depth - a.depth)) {
    const key = clientKey(candidate.owner.connectedFolderId ?? ampleFileAgentScopeId, candidate.owner.conversationId);
    if (!state.runningTurns.has(key) && !state.compactingConversations.has(key)) {
      const answered = state.requests.questions(candidate.requestId).find(question => question.asynchronous && question.state === "answered" && question.continuationTaskId === null);
      if (answered && candidate.stopRequestedAt === null) {
        const facade = createAmpleFileActFacade(state);
        if (candidate.owner.connectedFolderId) await facade.chatAnswer({ connectedFolder: candidate.owner.connectedFolderId, questionId: answered.questionId, answer: answered.answer! });
        else await facade.agentAnswer({ questionId: answered.questionId, answer: answered.answer! });
        continue;
      }
    }
    await maybeStartRequestContinuation(state, candidate.requestId);
  }
}

export async function requestPresentation(state: LocalApiState, record: AmpleFileRequestRecord): Promise<WorkRequestView> {
  const family = [record, ...state.requests.subtree(record.requestId)];
  const latest = record.turns.at(-1)!;
  const outstanding = family.some((item) => !isAmpleFileRequestTerminalState(item.state));
  const questions: WorkRequestView["questions"] = [];
  let questionCount = 0;
  let savedAnswerCount = 0;
  for (const item of family) {
    for (const question of state.requests.questions(item.requestId)) {
      if (question.respondent !== "person" || !(question.state === "open" || (question.state === "answered" && !question.continuationTaskId))) continue;
      if ((question.expiresAt !== null && Date.now() >= Date.parse(question.expiresAt))) continue;
      questionCount++;
      if (question.state === "answered") savedAnswerCount++;
      // A page of exact questions, not truncated question text. After an
      // answer the next question becomes visible. The digest retains all ids.
      if (questions.length >= ampleFileRequestLimits.questionsPerPresentation) continue;
      let reason: string | undefined;
      try { state.requests.assertCanContinue(item.requestId); } catch (error) { reason = errorMessage(error); }
      const key = clientKey(item.owner.connectedFolderId ?? ampleFileAgentScopeId, item.owner.conversationId);
      if (!question.asynchronous && (state.runningTurns.has(key) || state.compactingConversations.has(key))) reason = "The agent is finishing its current turn. You can write your answer now.";
      questions.push({ id: question.questionId, requestId: item.requestId, text: question.text,
        from: item.owner.connectedFolderName ?? (item.owner.connectedFolderId ? "Worker" : "AmpleFile"),
        state: question.state === "answered" ? "recorded" : "open",
        ...(question.options?.length && question.state !== "answered" ? { options: [...question.options] } : {}),
        ...(question.state === "answered" && question.answer ? { answer: question.answer } : {}),
        canAnswer: !reason, ...(reason ? { reason } : {}) });
    }
  }
  let detail: string | null = null;
  let canContinue = false;
  if (record.continuationState === "failed") {
    detail = "The follow-up did not start. Your saved results are still available.";
  }
  const readyResults = state.requests.children(record.requestId).some((child) => {
    const turn = child.turns.at(-1)!;
    return turn.settledAt && !record.deliveredChildTaskIds.includes(turn.taskId);
  });
  if (!outstanding && !questionCount && (record.continuationState === "failed" || readyResults)) {
    try {
      state.requests.assertCanContinue(record.requestId);
      const key = clientKey(record.owner.connectedFolderId ?? ampleFileAgentScopeId, record.owner.conversationId);
      canContinue = !state.runningTurns.has(key) && !state.compactingConversations.has(key);
      if (!detail) detail = "The delegated work is ready. Continue to bring its results together.";
    } catch { canContinue = false; }
  }
  // A request whose only outstanding work is background jobs says so, and
  // keeps Stop available between turns (docs/background-jobs.md).
  const runningJobs = family.flatMap((item) => (item.jobs ?? []).filter((job) => job.state === "running"));
  const turnLive = family.some((item) => item.turns.some((turn) => turn.state === "accepted" || turn.state === "running"));
  const inBackground = record.state === "working" && !turnLive && runningJobs.length > 0;
  if (inBackground && !detail) {
    const now = Date.now();
    const named = runningJobs.slice(0, 3).map((job) => `${job.name} · ${formatRunningFor(now - Date.parse(job.startedAt))}`);
    detail = `${named.join("; ")}${runningJobs.length > 3 ? `; and ${runningJobs.length - 3} more` : ""}`;
  }
  if (record.limitHit) detail = requestLimitStopMessage(record.limitHit.limit);
  else if (record.state === "expired") detail = "This request’s time window ended. Its saved work remains; start a new message to pick it up.";
  else if (latest.state === "interrupted") detail = "Work was interrupted when the app closed. Saved work remains; nothing was restarted automatically.";
  else if (record.state === "failed" && (record.jobs ?? []).some((job) => job.state === "interrupted")) {
    detail = "A background job was interrupted when AmpleFile closed. Saved work remains; nothing was restarted automatically.";
  }
  else if (record.state === "failed" && !detail) detail = latest.error ?? "The agent could not finish. Its saved work remains in the Chat.";
  let result: WorkRequestView["result"] = null;
  if (isAmpleFileRequestTerminalState(record.state) && record.state !== "stopped" && record.state !== "expired") {
    const selected = [...record.results].reverse().find((item) => item.taskId === latest.taskId);
    if (selected) {
      const read = await state.requests.result(selected.resultId);
      if (read?.state === "ok") {
        const envelope = read.record.envelope;
        const files: NonNullable<WorkRequestView["result"]>["files"] = [];
        if (record.owner.connectedFolderId) for (const file of envelope.files ?? []) {
          files.push({ ...file, connectedFolderId: record.owner.connectedFolderId, connectedFolderName: record.owner.connectedFolderName ?? "Connected Folder" });
        }
        result = { summary: envelope.summary, outcome: record.state === "partial" ? "partial" : envelope.outcome, files };
      } else detail = "The selected result could not be read. Its receipt remains; try again or open the Chat.";
    }
  }
  // Direct-child reports are deliberately released deliverables. AmpleFile Agent
  // requests have no Connected Folder file root of their own; retain each file's origin.
  if (isAmpleFileRequestTerminalState(record.state) && record.state !== "stopped" && record.state !== "expired") {
    const files = result?.files ?? [];
    const seen = new Set(files.map((file) => `${file.connectedFolderId}:${file.path}`));
    for (const child of state.requests.children(record.requestId)) {
      const childTurn = child.turns.at(-1)!;
      const selected = [...child.results].reverse().find((item) => item.taskId === childTurn.taskId);
      if (!selected || !child.owner.connectedFolderId) continue;
      const read = await state.requests.result(selected.resultId);
      if (read?.state !== "ok") continue;
      for (const file of read.record.envelope.files ?? []) {
        const key = `${child.owner.connectedFolderId}:${file.path}`;
        if (seen.has(key)) continue;
        seen.add(key); files.push({ ...file, connectedFolderId: child.owner.connectedFolderId, connectedFolderName: child.owner.connectedFolderName ?? "Connected Folder" });
      }
    }
    if (files.length && !result) result = { summary: "Files from the completed work.", outcome: record.state === "done" ? "succeeded" : record.state === "partial" ? "partial" : "failed", files };
  }
  return { version: 1, requestId: record.requestId, taskId: latest.taskId, owner: record.owner,
    state: record.state, label: inBackground ? "Running in the background" : workRequestLabel(record.state, questionCount - savedAnswerCount, savedAnswerCount), detail,
    canStop: outstanding && !record.stopRequestedAt, canContinue, questions, questionCount,
    hadQuestions: family.some((item) => item.questionIds.length > 0), result,
    ...(record.checklist?.items.length ? { checklist: record.checklist.items.map((item) => ({ ...item })) } : {}),
    children: state.requests.children(record.requestId).map((child) => ({ requestId: child.requestId,
      title: child.owner.connectedFolderName ?? "AmpleFile", state: child.state,
      label: workRequestLabel(child.state,
        state.requests.questions(child.requestId).filter((q) => q.respondent === "person" && q.state === "open").length,
        state.requests.questions(child.requestId).filter((q) => q.respondent === "person" && q.state === "answered" && !q.continuationTaskId).length) })) };
}

/** "running for 4 min" on the work line; whole minutes past the first. */
function formatRunningFor(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `running for ${minutes} min`;
  return `running for ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

async function performWorkAction(state: LocalApiState, record: AmpleFileRequestRecord, action: string, input: Record<string, unknown>): Promise<void> {
  const receipt = { requestId: `work-ui:${randomUUID()}`, command: action === "answer" ? "chat.answer" : action === "stop" ? "agent.stop" : "chat.send",
    surface: input.surface === "popover" ? "popover" as const : "main-window" as const };
  if (!await state.actReceipts.append({ ...receipt, outcome: "accepted" })) throw httpError(503, "Could not record this action. Please try again.");
  try {
    if (action === "stop") await stopAmpleFileAgentRequest(state, record.turns.at(-1)!.taskId);
    else if (action === "answer") {
      if (typeof input.questionId !== "string" || typeof input.answer !== "string" || !input.answer.trim()) throw badRequest("Write an answer before sending.");
      const question = state.requests.question(input.questionId);
      const family = [record, ...state.requests.subtree(record.requestId)];
      const owner = question && family.find((item) => item.requestId === question.requestId);
      if (!question || !owner || question.respondent !== "person") throw notFound("That question does not belong to this work.");
      // A retry after a lost response acknowledges the existing delivery.
      if (question.state === "answered" && question.continuationTaskId && ampleFileAnswerMatchesRecorded(question, input.answer.trim())) {
        await state.actReceipts.append({ ...receipt, outcome: "ok", detail: `request ${record.requestId}; answer already delivered` });
        return;
      }
      const facade = createAmpleFileActFacade(state);
      if (owner.owner.connectedFolderId) await facade.chatAnswer({ connectedFolder: owner.owner.connectedFolderId, questionId: question.questionId, answer: input.answer });
      else await facade.agentAnswer({ questionId: question.questionId, answer: input.answer });
    } else if (action === "continue") {
      const deliveryId = workDeliveryId(input.deliveryId);
      const view = await requestPresentation(state, record);
      const replay = record.turns.some((turn) => state.turnStore.get(turn.taskId)?.requestId === deliveryId);
      if (!view.canContinue && !replay) throw httpError(409, "This work cannot continue here. Open the Chat for its current state.");
      const connectedFolder = record.owner.connectedFolderId ? await getConnectedFolder(record.owner.connectedFolderId) : ampleFileAgentScope(state);
      await acceptConversationTurn(state, { id: record.owner.connectedFolderId ?? ampleFileAgentScopeId, connectedFolderRoot: "connectedFolderRoot" in connectedFolder ? connectedFolder.connectedFolderRoot : connectedFolder.rootPath }, record.owner.conversationId, {
        content: await composeContinuationMessage(state, record, state.requests.children(record.requestId)), contextPaths: [],
        releasedChildTaskIds: state.requests.children(record.requestId).map((child) => child.turns.at(-1)!.taskId),
        actorKind: "system", requestId: deliveryId, request: { joinRequestId: record.requestId },
      });
    } else throw badRequest("Unknown work action.");
    await state.actReceipts.append({ ...receipt, outcome: "ok", detail: `request ${record.requestId}` });
  } catch (error) {
    await state.actReceipts.append({ ...receipt, outcome: "error", detail: errorMessage(error) }).catch(() => false);
    throw error;
  } finally { publishControlHint(state, "connected-folders"); }
}

/** The id a Continue click carries, so a retried click starts its turn once. */
function workDeliveryId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw badRequest("A valid delivery id is required.");
  }
  return value;
}

/** Bounded, addressed delivery for every owner; never replayed on startup. */
async function maybeStartRequestContinuation(state: LocalApiState, requestId: string): Promise<void> {
  if (!state.requests.continuationsEnabled() || !state.acceptingTurns) return;
  const request = state.requests.get(requestId);
  if (!request || request.stopRequestedAt || request.state === "stopped" || request.state === "expired" || request.limitHit) return;
  const scopeId = request.owner.connectedFolderId ?? ampleFileAgentScopeId;
  if (scopeId === ampleFileAgentScopeId && state.ampleFileAgentInstructionsError) return;
  const own = request.turns.at(-1)!;
  if (own.state === "accepted" || own.state === "running" || own.state === "aborted") return;
  if (state.requests.questions(requestId).some((q) => q.state === "open" || (q.state === "answered" && q.continuationTaskId === null))) return;
  const key = clientKey(scopeId, request.owner.conversationId);
  if (state.runningTurns.has(key) || state.compactingConversations.has(key)) return;
  // Nested owners synthesize before their parent wakes, so delegated results
  // wait for the whole branch. A finished background job is this request's
  // own work and does not wait for delegated children (docs/background-jobs.md).
  const childrenBusy = state.requests.subtree(requestId).some((child) => child.continuationState === "pending"
    || child.turns.some((turn) => turn.state === "accepted" || turn.state === "running"));
  const batch = childrenBusy ? [] : state.requests.children(requestId).filter((child) => {
    const turn = child.turns.at(-1)!;
    return turn.settledAt !== null && state.turnsSettledThisRun.has(turn.taskId)
      && !request.deliveredChildTaskIds.includes(turn.taskId);
  });
  const jobs = undeliveredSettledJobs(state, request);
  if (!batch.length && !jobs.length) return;
  // Compose before claiming: a read failure has not accepted a delivery.
  const content = await composeContinuationMessage(state, request, batch, jobs);
  const connectedFolder = request.owner.connectedFolderId ? await getConnectedFolder(request.owner.connectedFolderId)
    : { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentScope(state).rootPath };
  const note = await state.requests.noteContinuation(requestId, batch.map((child) => child.turns.at(-1)!.taskId), jobs.map((job) => job.jobId));
  if (!note.allowed) return;
  let followUpTaskId: string | null = null;
  try {
    const accepted = await acceptConversationTurn(state, connectedFolder, request.owner.conversationId, {
      content, contextPaths: [], actorKind: "system",
      ...(request.owner.connectedFolderId ? {} : { ampleFileAgentAttachments: [] }),
      requestId: `continuation-${requestId}-${note.count}`,
      request: { joinRequestId: requestId },
    });
    followUpTaskId = accepted.taskId;
  } catch (error) {
    await state.requests.failContinuation(requestId);
    console.error(`Request ${requestId} could not start its follow-up turn: ${errorMessage(error)}`);
  }
  // Reserved above whether or not the turn started: an end is delivered at
  // most once, and a follow-up that could not start is not retried.
  await deliverBackgroundJobs(state, jobs, "follow_up", followUpTaskId);
}

/**
 * The continuation's message: deterministic, bounded, no model call. It
 * names each settled child, its reported outcome or failure, the files it
 * named, and any question still open beneath it, then points at the record.
 */
export async function composeContinuationMessage(
  state: LocalApiState,
  root: AmpleFileRequestRecord,
  batch: AmpleFileRequestRecord[],
  jobs: AmpleFileJobRecord[] = [],
): Promise<string> {
  const jobsFinished = jobs.length === 1 ? "a background job this Chat started has finished" : `${jobs.length} background jobs this Chat started have finished`;
  const lines: string[] = [
    !jobs.length
      ? `AmpleFile is continuing request ${root.requestId}: selected results or questions from work it handed out are ready. Nobody typed this message.`
      : !batch.length
        ? `AmpleFile is continuing request ${root.requestId}: ${jobsFinished}. Nobody typed this message.`
        : `AmpleFile is continuing request ${root.requestId}: ${jobsFinished}, and selected results or questions from work it handed out are ready. Nobody typed this message.`,
    "",
  ];
  for (const child of batch) {
    const turn = child.turns.at(-1)!;
    const where = `${child.owner.connectedFolderName ?? child.owner.connectedFolderId ?? "a Connected Folder"} [${child.owner.connectedFolderId ?? ""}]`;
    const ref = [...child.results].reverse().find((result) => result.taskId === turn.taskId);
    const newest = ref ? await state.requests.result(ref.resultId) : null;
    if (ref && newest?.state !== "ok") throw new Error("The selected child result is unavailable; its receipt remains on record.");
    const unsuccessful = turn.state === "failed" || turn.state === "aborted"
      || child.state === "failed" || child.state === "stopped" || child.state === "expired";
    const outcome = unsuccessful
      ? `${child.state === "waiting" ? turn.state : child.state}${turn.error ? `: ${turn.error}` : ""}`
      : newest?.state === "ok"
      ? `${child.state === "partial" ? "partial" : newest.record.envelope.outcome}: ${newest.record.envelope.summary}`
      : turn.state === "succeeded"
        ? "finished without a report"
        : `${turn.state}${turn.error ? `: ${turn.error}` : ""}`;
    lines.push(`- ${where} — Chat ${child.owner.conversationId}, task ${turn.taskId} — ${outcome}`);
    const files = newest?.state === "ok" ? newest.record.envelope.files ?? [] : [];
    if (files.length) {
      lines.push(`  files: ${files.map((file) => file.path).join(", ")}`);
    }
    for (const question of state.requests.questions(child.requestId).filter((candidate) => candidate.state === "open")) {
      const to = question.respondent === "person"
        ? "the person"
        : child.parentRequestId === root.requestId
          ? "you"
          : "the request above it";
      lines.push(`  waiting on ${to}: question ${question.questionId} — ${question.text}`);
      if (to === "you" && child.owner.connectedFolderId) {
        lines.push(`    answer it with: amplefile chat answer --connected-folder ${child.owner.connectedFolderId} --question ${question.questionId} --answer "<text>" --parent-task <this-request-task-id> --json`);
      }
    }
  }
  if (jobs.length) {
    if (batch.length) lines.push("");
    lines.push(...await composeBackgroundJobLines(state, jobs));
  }
  const jobsClosing = "Read more of a job's output with job_output if you need it.";
  lines.push(
    "",
    batch.length
      ? `${root.owner.connectedFolderId
        ? "Bring these selected results together for your assignment. Answer questions addressed to you. Submit any needed chat report before your final reply, then give the complete useful answer in that reply. Child files remain in their source Connected Folder until explicitly copied."
        : `The whole record: amplefile requests show --request ${root.requestId} --json. Bring these results together for the person; answer what is yours to answer; if the request is finished, say so and end your turn.`}${jobs.length ? ` ${jobsClosing}` : ""}`
      : root.owner.connectedFolderId
        ? `Carry on with the work ${jobs.length === 1 ? "this job was" : "these jobs were"} part of. ${jobsClosing} Submit any needed chat report before your final reply, then give the complete useful answer in that reply.`
        : `Carry on with the work ${jobs.length === 1 ? "this job was" : "these jobs were"} part of. ${jobsClosing} Tell the person how it went; if the request is finished, say so and end your turn.`,
  );
  return clampUtf8(lines.join("\n"), ampleFileAutomationDeclarationBounds.maxResolvedMessageBytes);
}
