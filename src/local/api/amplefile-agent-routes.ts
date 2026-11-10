import { stopComputerSharingForScope } from "./computer-sharing.js";
/**
 * The AmpleFile Agent's routes and scope: its readiness gate, conversations,
 * the request view its popover shows, and the check on an explicitly named
 * parent task.
 */

import { createLocalEventSink } from "../local-event-stream.js";
import { isConnectedFolderFileVisible } from "../connected-folder-file-visibility.js";
import { join } from "node:path";
import {
  createConversation,
  listConversations,
  readConversation,
  readConversationSummary,
  renameConversation,
  type ConversationSummary,
} from "../agent/chat-store.js";
import {
  classifyAmpleFileAgentAttachments,
  ampleFileAgentAttachmentDispositions,
  maxAmpleFileAgentAttachments,
  type AmpleFileAgentAttachmentRef,
} from "../amplefile-agent-attachments.js";
import { ampleFileRequestStateToAgentPhase } from "../requests/request-records.js";
import { normalizeConversationTitle } from "../../shared/chat-title.js";
import { ampleFileAgentRoot, ampleFileAgentScopeId } from "../state-paths.js";
import type { AmpleFileRecentlyDeletedEntry } from "../recently-deleted-store.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import type { AmpleFileActAgentRequest, AmpleFileActTurnState } from "../cli/act-facade.js";
import { getConnectedFolder } from "../connected-folder.js";
import { toActConversationRef } from "./act-support.js";
import { normalizeAddressedConnectedFolderIds } from "./chat-routes.js";
import { getClient } from "./conversation-clients.js";
import { openChatStream } from "./event-streams.js";
import { extensionSnapshot } from "./extension-ui.js";
import { badRequest, boundedOptionalId, errorMessage, httpError, match, notFound, readJsonBody, sendJson } from "./http.js";
import { turnStatusFor } from "./request-records.js";
import { requestLimitStopMessage, requestPresentation, stopAmpleFileAgentRequest } from "./request-routes.js";
import { requestHasUnsettledWork } from "./reservations.js";
import { clientKey, conversationRuntimeState, type LocalApiRequest, type LocalApiState } from "./state.js";
import { acceptConversationTurn, changeQueuedMessage, optionalTurnIdentity, steerConversationTurn } from "./turn-acceptance.js";
import { yieldBackgroundCompaction } from "./turn-run.js";

/** The AmpleFile Agent's conversation surface: the same acceptance path, task records, and event stream as Connected Folder Chats, under the AmpleFile Agent scope id. */
export async function handleAmpleFileAgentRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // Management conversation surface: the same acceptance path, task records,
  // and event stream as Connected Folder Chats, exposed for renderer clients (the
  // menu-bar popover) under the AmpleFile Agent scope id instead of a Connected Folder id.
  if (url.pathname === "/api/amplefile-agent/summary" && method === "GET") {
    if (state.ampleFileAgentInstructionsError) {
      sendJson(res, { available: false, reason: state.ampleFileAgentInstructionsError, conversation: null, state: "idle", latestRequest: null });
      return true;
    }
    const selectedId = url.searchParams.get("conversationId");
    const conversation = selectedId
      ? (await listConversations(ampleFileAgentRoot())).find((item) => item.id === selectedId)
      : await resolveAmpleFileAgentConversation(false).catch(() => null);
    if (selectedId && !conversation) throw notFound("This AmpleFile Agent chat is no longer available.");
    // The selected transcript and its request must describe the same work,
    // even when another surface has started a newer AmpleFile Agent.
    const latest = conversation ? state.requests.latestForConversation(conversation.id) : null;
    sendJson(res, {
      available: true,
      conversation: conversation ? toActConversationRef(conversation) : null,
      state: conversation ? conversationRuntimeState(state, ampleFileAgentScopeId, conversation.id) : "idle",
      latestRequest: latest ? await ampleFileAgentRequestView(state, latest.turns.at(-1)!.taskId) : null,
    });
    return true;
  }
  if (url.pathname === "/api/amplefile-agent/conversations" && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversations = await listConversations(ampleFileAgentRoot());
    sendJson(res, { conversations: await Promise.all(conversations.map(async (conversation) => ({
      ...toActConversationRef(conversation),
      ...await ampleFileAgentConversationAttention(state, conversation.id),
    }))) });
    return true;
  }
  if (url.pathname === "/api/amplefile-agent/messages" && method === "POST") {
    assertAmpleFileAgentReadyForRoutes(state);
    const body = await readJsonBody<{
      content?: string;
      attachments?: unknown;
      conversationId?: unknown;
      newConversation?: unknown;
      continuationTaskId?: unknown;
      requestId?: unknown;
      userMessageId?: unknown;
      addressedConnectedFolderIds?: unknown;
      delivery?: unknown;
    }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    if (body.delivery !== undefined && body.delivery !== "steer") throw badRequest("Message delivery must be \"steer\" when present.");
    if (body.delivery === "steer") {
      // The menu-bar panel and the agent panel reach a running turn the way a Connected Folder Chat does.
      const steerConversationId = boundedOptionalId(body.conversationId, "conversationId");
      if (!steerConversationId) throw badRequest("Steering needs the conversationId of the running Chat.");
      if (Array.isArray(body.attachments) && body.attachments.length) throw badRequest("Attachments cannot be added to a running turn.");
      const scope = ampleFileAgentScopeForRoutes(state);
      const steered = await steerConversationTurn(state, { id: scope.id, connectedFolderRoot: scope.rootPath }, steerConversationId, {
        content,
        requestId: optionalTurnIdentity(body.requestId, "requestId"),
        userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
      });
      sendJson(res, { accepted: true, delivery: "steer", conversationId: steerConversationId, message: steered.message, taskId: steered.taskId, replayed: steered.replayed }, 202);
      return true;
    }
    const addressedConnectedFolderIds = await normalizeAddressedConnectedFolderIds(body.addressedConnectedFolderIds, ampleFileAgentScopeId);
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (rawAttachments.length > maxAmpleFileAgentAttachments) {
      throw badRequest(`At most ${maxAmpleFileAgentAttachments} attachments are allowed per request.`);
    }
    if (rawAttachments.some((item) => typeof item !== "string")) {
      throw badRequest("Attachments must be absolute paths or http(s) links.");
    }
    const conversationIdInput = boundedOptionalId(body.conversationId, "conversationId");
    const continuationTaskId = boundedOptionalId(body.continuationTaskId, "continuationTaskId");
    const requestId = optionalTurnIdentity(body.requestId, "requestId");
    const userMessageId = optionalTurnIdentity(body.userMessageId, "userMessageId");
    if (body.newConversation !== undefined && typeof body.newConversation !== "boolean") {
      throw badRequest("newConversation must be a boolean.");
    }
    if (body.newConversation === true && conversationIdInput) {
      throw badRequest("Use either conversationId or newConversation, not both.");
    }
    if (continuationTaskId && (!conversationIdInput || body.newConversation === true)) {
      throw badRequest("A continuation requires the existing conversationId.");
    }
    let attachments: AmpleFileAgentAttachmentRef[];
    try {
      attachments = await classifyAmpleFileAgentAttachments(rawAttachments as string[], ampleFileAgentRoot());
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    const scope = ampleFileAgentScopeForRoutes(state);
    const priorAcceptance = requestId ? state.turnStore.findScopeRequest(scope.id, requestId) : null;
    if (priorAcceptance && conversationIdInput && priorAcceptance.conversationId !== conversationIdInput) {
      throw httpError(409, "This turn request id was already accepted in another AmpleFile Agent Chat.");
    }
    const conversationId = priorAcceptance?.conversationId
      ?? (body.newConversation === true
        ? (await createConversation(scope.rootPath)).id
        : conversationIdInput ?? (await resolveAmpleFileAgentConversation(true)).id);
    if (continuationTaskId) {
      const previous = await ampleFileAgentRequestView(state, continuationTaskId);
      if (!previous || previous.conversationId !== conversationId || previous.phase !== "needs_you") {
        throw httpError(409, "That AmpleFile Agent request is no longer waiting for a reply.");
      }
      const combinedAttachmentCount = new Set(
        [...previous.attachments, ...attachments].map((attachment) => `${attachment.kind}:${attachment.target}`),
      ).size;
      if (combinedAttachmentCount > maxAmpleFileAgentAttachments) {
        throw badRequest(`A continued request can reference at most ${maxAmpleFileAgentAttachments} attachments in total.`);
      }
    }
    // A reply to a waiting request joins that request: one record, one
    // story, a further turn — never a second record copying the trail.
    const continuedRequestId = continuationTaskId ? state.requests.byTaskId(continuationTaskId)?.requestId : undefined;
    const { message, taskId } = await acceptConversationTurn(state, { id: scope.id, connectedFolderRoot: scope.rootPath }, conversationId, {
      content,
      contextPaths: [],
      actorKind: "renderer",
      ampleFileAgentAttachments: attachments,
      ...(addressedConnectedFolderIds.length ? { addressedConnectedFolderIds } : {}),
      ...(continuationTaskId ? { continuedFromAmpleFileAgentTaskId: continuationTaskId } : {}),
      ...(continuedRequestId ? { request: { joinRequestId: continuedRequestId } } : {}),
      requestId,
      userMessageId,
    });
    sendJson(res, { accepted: true, conversationId, message, taskId, attachments }, 202);
    return true;
  }
  const ampleFileAgentRequestMatch = match(url.pathname, /^\/api\/amplefile-agent\/requests\/([^/]+)$/);
  if (ampleFileAgentRequestMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    const request = await ampleFileAgentRequestView(state, ampleFileAgentRequestMatch[1]);
    if (!request) throw notFound(`Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
    sendJson(res, { request });
    return true;
  }
  const ampleFileAgentStopMatch = match(url.pathname, /^\/api\/amplefile-agent\/requests\/([^/]+)\/stop$/);
  if (ampleFileAgentStopMatch && method === "POST") {
    assertAmpleFileAgentReadyForRoutes(state);
    await readJsonBody<Record<string, never>>(state, req);
    try {
      sendJson(res, { stopped: await stopAmpleFileAgentRequest(state, ampleFileAgentStopMatch[1]) });
    } catch (error) {
      if (error instanceof AmpleFileCliError && error.code === "notFound") throw notFound(error.message);
      throw error;
    }
    return true;
  }
  const ampleFileAgentConversationMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)$/);
  if (ampleFileAgentConversationMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    sendJson(res, { messages: await readConversation(ampleFileAgentRoot(), ampleFileAgentConversationMatch[1]) });
    return true;
  }
  const ampleFileAgentConversationTitleMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/title$/);
  if (ampleFileAgentConversationTitleMatch && method === "POST") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversationId = ampleFileAgentConversationTitleMatch[1];
    const body = await readJsonBody<{ title?: unknown }>(state, req);
    if (typeof body.title !== "string") throw badRequest("Chat title must be text.");
    const title = normalizeConversationTitle(body.title);
    if (!title) throw badRequest("Enter a Chat title.");
    const conversation = await renameAmpleFileAgentConversation(state, conversationId, title);
    state.clients.get(clientKey(ampleFileAgentScopeId, conversationId))?.setSessionName(conversation.title);
    sendJson(res, {
      conversation: toActConversationRef(conversation),
      state: conversationRuntimeState(state, ampleFileAgentScopeId, conversationId),
    });
    return true;
  }
  if (ampleFileAgentConversationMatch && method === "DELETE") {
    assertAmpleFileAgentReadyForRoutes(state);
    const deleted = await deleteAmpleFileAgentConversation(state, ampleFileAgentConversationMatch[1], { receiptId: null });
    sendJson(res, { deleted });
    return true;
  }
  const ampleFileAgentRuntimeMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/runtime$/);
  if (ampleFileAgentRuntimeMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversationId = ampleFileAgentRuntimeMatch[1];
    if (!(await readConversation(ampleFileAgentRoot(), conversationId)).length) throw notFound("Conversation not found.");
    const client = await getClient(state, ampleFileAgentScopeId, ampleFileAgentRoot(), conversationId);
    sendJson(res, { runtime: await client.getState() });
    return true;
  }
  const ampleFileAgentThinkingMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/thinking$/);
  if (ampleFileAgentThinkingMatch && method === "POST") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversationId = ampleFileAgentThinkingMatch[1];
    if (!(await readConversation(ampleFileAgentRoot(), conversationId)).length) throw notFound("Conversation not found.");
    const body = await readJsonBody<{ level?: unknown }>(state, req);
    if (typeof body.level !== "string" || !body.level.trim()) throw badRequest("A thinking level is required.");
    const key = clientKey(ampleFileAgentScopeId, conversationId);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current AmpleFile Agent turn to finish before changing the thinking level.");
    const client = await getClient(state, ampleFileAgentScopeId, ampleFileAgentRoot(), conversationId);
    let result: { level: string; available: string[] };
    try {
      result = await client.setThinkingLevel(body.level);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    sendJson(res, { thinking: result, runtime: await client.getState() });
    return true;
  }
  const ampleFileAgentEventsMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/events$/);
  if (ampleFileAgentEventsMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    openChatStream(state, createLocalEventSink(res), ampleFileAgentScopeId, ampleFileAgentEventsMatch[1], req.headers["last-event-id"]);
    return true;
  }
  return false;
}

/** The AmpleFile Agent scope shaped like the Connected Folder refs the turn internals take. */
export function ampleFileAgentScope(state?: LocalApiState): { id: string; rootPath: string } {
  if (state) assertAmpleFileAgentInstructionsReady(state);
  return { id: ampleFileAgentScopeId, rootPath: ampleFileAgentRoot() };
}

export function assertAmpleFileAgentInstructionsReady(state: LocalApiState): void {
  if (!state.ampleFileAgentInstructionsError) return;
  throw new AmpleFileCliError(
    "unavailable",
    "The AmpleFile Agent is unavailable because AmpleFile could not prepare its required instructions. Restart AmpleFile; if this continues, check the app-data AmpleFile Agent folder.",
  );
}

/** HTTP mirror of the fail-closed instructions gate: 503 instead of a CLI error. */
export function assertAmpleFileAgentReadyForRoutes(state: LocalApiState): void {
  if (!state.ampleFileAgentInstructionsError) return;
  throw httpError(503, "The AmpleFile Agent is unavailable because Connected Folder could not prepare its required instructions. Restart Connected Folder; if this continues, check the app-data AmpleFile Agent folder.");
}

export function ampleFileAgentScopeForRoutes(state: LocalApiState): { id: string; rootPath: string } {
  assertAmpleFileAgentReadyForRoutes(state);
  return { id: ampleFileAgentScopeId, rootPath: ampleFileAgentRoot() };
}

/**
 * The default AmpleFile Agent is the most recent active one; the
 * AmpleFile Agent surface is "one conversation" unless the caller asks for more.
 */
export async function resolveAmpleFileAgentConversation(create: boolean): Promise<ConversationSummary> {
  const scope = ampleFileAgentScope();
  const conversations = await listConversations(scope.rootPath);
  const active = conversations.find((item) =>
    !item.archivedAt && (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= Date.now()));
  if (active) return active;
  if (!create) throw new AmpleFileCliError("notFound", "No AmpleFile Agent exists yet. Send a message to start one.");
  return createConversation(scope.rootPath);
}

/**
 * The AmpleFile Agent transcript lives outside every Connected Folder, so it has no History
 * checkpoint to hold it. Its only deletion path moves the exact validated
 * transcript into Recently deleted. It deliberately never accepts a path.
 */
async function deleteAmpleFileAgentConversation(
  state: LocalApiState,
  conversationId: string,
  context: { receiptId: string | null },
): Promise<{ conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } }> {
  const root = ampleFileAgentRoot();
  const key = clientKey(ampleFileAgentScopeId, conversationId);
  await yieldBackgroundCompaction(state, key);
  changeQueuedMessage(state, key, null);
  assertAmpleFileAgentConversationMutable(state, conversationId);
  // This reservation uses the same conflict fence as compaction because a
  // transcript move must not race a new turn, rename, or real compaction.
  state.compactingConversations.add(key);
  try {
    const summary = await readConversationSummary(root, conversationId).catch((error) => {
      throw badRequest(errorMessage(error));
    });
    if (!summary) throw notFound("Conversation not found.");
    if (state.requests.list().some((request) =>
      request.owner.connectedFolderId === undefined
      && request.owner.conversationId === conversationId
      && requestHasUnsettledWork(state, request))) {
      throw httpError(409, "Finish or stop this Chat's outstanding work before deleting it.");
    }
    // An idle client can still hold the Pi session and extension callbacks.
    // Stop disposes that session before its transcript leaves the live root.
    await stopComputerSharingForScope(state, root, ampleFileAgentScopeId, conversationId);
    await state.clients.get(key)?.stop();
    // `readConversationSummary` validated the id before this join. The source
    // remains a single known transcript below the app-owned management root.
    const relativePath = `.amplefile/conversations/${conversationId}.jsonl`;
    const sourcePath = join(root, relativePath);
    let entry: AmpleFileRecentlyDeletedEntry;
    try {
      entry = await state.recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: "file",
        reason: "agent.chat.delete",
        sourcePath,
        connectedFolderId: ampleFileAgentScopeId,
        connectedFolderName: "AmpleFile Agent",
        displayName: summary.title,
        originalPath: relativePath,
        receiptId: context.receiptId,
      });
    } catch (error) {
      throw new AmpleFileCliError(
        "failure",
        `AmpleFile could not move this Chat to Recently deleted: ${errorMessage(error)}. Nothing was deleted.`,
        { cause: error },
      );
    }
    state.clients.delete(key);
    return { conversationId, recentlyDeleted: { entryId: entry.id, restoreBy: entry.restoreBy } };
  } finally {
    state.compactingConversations.delete(key);
  }
}

function assertAmpleFileAgentConversationMutable(state: LocalApiState, conversationId: string): void {
  const key = clientKey(ampleFileAgentScopeId, conversationId);
  if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current turn to finish.");
  if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
}

async function renameAmpleFileAgentConversation(
  state: LocalApiState,
  conversationId: string,
  title: string,
): Promise<ConversationSummary> {
  const key = clientKey(ampleFileAgentScopeId, conversationId);
  assertAmpleFileAgentConversationMutable(state, conversationId);
  // Renaming appends a transcript event, so reserve the same fence deletion
  // and compaction use before awaiting that write.
  state.compactingConversations.add(key);
  try {
    return await renameConversation(ampleFileAgentRoot(), conversationId, title);
  } finally {
    state.compactingConversations.delete(key);
  }
}

/**
 * Rich, honest view of one request, keyed by any of its task ids. The phase
 * is the durable record's state mapped onto the vocabulary `agent status`
 * and the popover already speak (docs/collaboration-contract.md): `done`
 * is claimed only when the request's own turn succeeded AND no child it
 * started is still running; downstream work keeps it in `handed_off`, and an
 * open question puts it in `needs_you`. A reply whose final non-empty line
 * asks a question also surfaces as `needs_you` — the agent is taught to
 * put its question on its own closing line, and a missed detection degrades
 * to `done` with the question still fully visible in the reply.
 *
 * The view names the newest turn of the request, so a task id whose request
 * was continued resolves to the continued story rather than a stale copy.
 */
export async function ampleFileAgentRequestView(
  state: LocalApiState,
  taskId: string,
): Promise<AmpleFileActAgentRequest | null> {
  const record = state.requests.byTaskId(taskId);
  if (!record) return null;
  const scopeId = record.owner.connectedFolderId ?? ampleFileAgentScopeId;
  const newestTurn = record.turns.at(-1)!;
  const turn = turnStatusFor(state, scopeId, newestTurn.taskId);
  const children = state.requests.children(record.requestId).map((child): {
    taskId: string;
    connectedFolderId: string;
    connectedFolderName: string;
    conversationId: string;
    state: AmpleFileActTurnState;
    error: string | null;
    files: string[];
  } => {
    const childTurn = child.turns.at(-1)!;
    const live = child.owner.connectedFolderId ? turnStatusFor(state, child.owner.connectedFolderId, childTurn.taskId) : null;
    // A live turn's own status is sharper than the record's; a settled one
    // reads the record, which the turn journal already reconciled.
    const childState: AmpleFileActTurnState = live && live.state !== "unknown"
      ? live.state
      : childTurn.state === "accepted" || childTurn.state === "running"
        ? "running"
        : childTurn.state === "interrupted"
          ? "failed"
          : childTurn.state;
    return {
      taskId: childTurn.taskId,
      connectedFolderId: child.owner.connectedFolderId ?? ampleFileAgentScopeId,
      connectedFolderName: child.owner.connectedFolderName ?? child.owner.connectedFolderId ?? "the AmpleFile Agent",
      conversationId: child.owner.conversationId,
      state: childState,
      error: live?.error ?? childTurn.error,
      files: [],
    };
  });
  // Every changed file the children recorded, checked for visibility. No
  // prose parsing or folder scan; every candidate comes from the child's journal.
  const candidates = children.flatMap((child) => {
    const durable = state.turnStore.get(child.taskId);
    if (child.state === "running" || !durable || durable.connectedFolderId !== child.connectedFolderId || durable.conversationId !== child.conversationId) return [];
    return (durable.fileChanges?.files ?? []).map((file) => ({ child, path: file.path }));
  });
  const visible = await Promise.all(candidates.map(async (item) => await isConnectedFolderFileVisible(item.child.connectedFolderId, item.path) ? item : null));
  for (const item of visible.filter((item) => item !== null)) item.child.files.push(item.path);
  const actions = record.actions;
  let reply: { messageId: string; content: string } | null = null;
  const replyMessageId = turn.state === "succeeded" || turn.state === "failed"
    ? turn.messageId
    : turn.state === "unknown" && (newestTurn.state === "succeeded" || newestTurn.state === "failed")
      ? newestTurn.messageId
      : null;
  if (replyMessageId) {
    const transcriptRoot = record.owner.connectedFolderId
      ? await getConnectedFolder(record.owner.connectedFolderId).then((connectedFolder) => connectedFolder.connectedFolderRoot).catch(() => null)
      : ampleFileAgentRoot();
    const messages = transcriptRoot ? await readConversation(transcriptRoot, record.owner.conversationId).catch(() => []) : [];
    const message = messages.find((item) => item.id === replyMessageId);
    if (message) reply = { messageId: message.id, content: message.content };
  }
  const failedChild = children.find((child) => child.state === "failed" || child.state === "unknown");
  // The durable record already knows whether a child is still live; the
  // in-memory task view only sharpens what a live turn reports.
  const phase = ampleFileRequestStateToAgentPhase(record.state);
  const settledAt = record.settledAt ?? newestTurn.settledAt ?? turn.endedAt;
  const questions = state.requests.questions(record.requestId).map((question) => ({
    questionId: question.questionId,
    taskId: question.taskId,
    respondent: question.respondent,
    state: question.state,
    askedAt: question.askedAt,
    answeredAt: question.answeredAt,
  }));
  return {
    taskId: newestTurn.taskId,
    conversationId: record.owner.conversationId,
    phase,
    startedAt: record.createdAt,
    endedAt: phase === "working" || phase === "handed_off" ? null : settledAt,
    error: turn.error ?? newestTurn.error ?? failedChild?.error ?? (failedChild?.state === "unknown"
      ? `Connected Folder lost track of work started in ${failedChild.connectedFolderName}.`
      : record.limitHit ? requestLimitStopMessage(record.limitHit.limit) : null),
    content: record.content,
    attachments: record.attachments,
    dispositions: ampleFileAgentAttachmentDispositions({ attachments: record.attachments, actions: record.actions }),
    actions,
    children: children.map(({ files, ...child }) => files.length ? { ...child, files } : child),
    reply,
    requestId: record.requestId,
    kind: record.kind,
    rootId: record.rootId,
    state: record.state,
    deadline: record.deadline,
    limitHit: record.limitHit,
    questions,
    results: record.results.map((result) => ({
      resultId: result.resultId,
      taskId: result.taskId,
      outcome: result.outcome,
      recordedAt: result.recordedAt,
      fileCount: result.fileCount,
    })),
  };
}

export function assertAmpleFileAgentParentAccepting(state: LocalApiState, parentTaskId: string | undefined): void {
  if (!parentTaskId) return;
  if (!state.requests.isAccepting(parentTaskId)) {
    throw new AmpleFileCliError("conflict", "The AmpleFile Agent request is stopping or has already finished.");
  }
}

/** Person-facing work is scoped to one request and its deliberately linked work. */
async function ampleFileAgentConversationAttention(state: LocalApiState, conversationId: string) {
  const record = state.requests.latestForConversation(conversationId);
  const work = record?.state === "waiting" ? await requestPresentation(state, record) : null;
  return { requestState: record?.state ?? null, needsAnswer: (work?.questionCount ?? 0) > 0
    || extensionSnapshot(state, { connectedFolderRoot: ampleFileAgentRoot(), conversationId }).length > 0 };
}

/** The act executor's lineage resolution: an explicitly named management parent is valid while its turn is active. */
export function resolveAmpleFileAgentLineageParent(
  state: LocalApiState,
  taskId: string,
): { taskId: string } | null {
  return state.requests.isAccepting(taskId) ? { taskId } : null;
}
