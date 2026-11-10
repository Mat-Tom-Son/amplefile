/**
 * Accepting a turn: the one path a message takes from a window, the AmpleFile
 * Agent, the act lane, an Automation, a queued message, or a continuation; its
 * durable request record; mid-turn steering; and the one queued message a Chat
 * holds.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { PiConversationClient, isPiTurnNotRunningError } from "../agent/pi-client.js";
import { AmpleFileTurnReplayConflictError, type AmpleFileDurableTurnRecord } from "../agent/turn-store.js";
import {
  appendMessage,
  conversationsDir,
  readConversation,
  readConversationSummary,
  type ChatMessage,
  type ChatMessageAttachmentRef,
} from "../agent/chat-store.js";
import type { AmpleFileAgentAttachmentRef } from "../amplefile-agent-attachments.js";
import {
  AmpleFileRequestLimitError,
  AmpleFileRequestLineageError,
  scrubAmpleFileRequestText,
  type AmpleFileRequestCreatableKind,
  type AmpleFileRequestRecord,
  type AmpleFileRequestSurface,
} from "../requests/request-records.js";
import { ampleFileRequestLimits } from "../../shared/amplefile-limits.js";
import { ampleFileAgentScopeId } from "../state-paths.js";
import { resolveConnectedFolderPath } from "../connected-folder.js";
import { broadcast, publishControlHint, resetChatEventTurn, turnStateEvent } from "./event-streams.js";
import { badRequest, errorMessage, httpError, notFound } from "./http.js";
import { assertNoCapabilityMutationForTurn } from "./reservations.js";
import { clientKey, type LocalApiState, type QueuedChatMessage, streamKey } from "./state.js";
import { runAgentTurn, yieldBackgroundCompaction } from "./turn-run.js";

/**
 * Shared turn-acceptance path for the renderer route and the CLI act facade.
 * Owns the conflict checks, runningTurns bookkeeping, kernel task record, user
 * message persistence with rollback, and the detached Pi turn start, so every
 * caller obeys identical concurrency and persistence rules.
 */
/**
 * Request lineage for one accepted turn. Absent means "a Connected Folder turn with no
 * parent": the turn is its own root. `parentTaskId` makes it a child request
 * under the request that task belongs to; `joinRequestId` makes it a further
 * turn of an existing request (a reply to a question, a follow-up turn).
 */
interface AcceptedTurnRequestInput {
  kind?: AmpleFileRequestCreatableKind;
  surface?: AmpleFileRequestSurface;
  parentTaskId?: string;
  joinRequestId?: string;
  /** The assignment text when it differs from this turn's message (an answer continuation). */
  assignment?: string;
  /**
   * `chat answer`: the one question this turn answers, already flipped to
   * `answered` before acceptance. The free-text reply path then leaves every
   * other open question alone rather than answering it with the same text.
   */
  answeringQuestionId?: string;
}

export async function acceptConversationTurn(
  ...args: Parameters<typeof admitConversationTurn>
): ReturnType<typeof admitConversationTurn> {
  const [state] = args;
  if (!state.acceptingTurns) throw httpError(503, "AmpleFile is closing and cannot accept another turn.");
  // An acceptance already past this check finishes before close() drains
  // turns, so its turn is drained too rather than dispatched afterwards and
  // left running unseen.
  const acceptance = admitConversationTurn(...args);
  state.turnAcceptances.add(acceptance);
  try {
    return await acceptance;
  } finally {
    state.turnAcceptances.delete(acceptance);
  }
}

async function admitConversationTurn(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string; name?: string },
  conversationId: string,
  input: {
    content: string;
    contextPaths: string[];
    /** `system` marks turns app code dispatches (automation chat hops). */
    actorKind: "assistant" | "cli" | "renderer" | "system";
    /** Management-scope reference attachments; never used for Connected Folder Chats. */
    ampleFileAgentAttachments?: AmpleFileAgentAttachmentRef[];
    /** Previous needs-you request whose audit trail this reply continues. */
    continuedFromAmpleFileAgentTaskId?: string;
    /** An automation's chat or agent step: its turn learns that no one is watching and how to report. */
    automationSource?: { automationId: string; title: string };
    /** Stable caller identity. Replays with the same input return the original acceptance. */
    requestId?: string;
    /** Stable optimistic message identity supplied by renderer clients. */
    userMessageId?: string;
    /** Host-composed selected reports already present in this continuation message. */
    releasedChildTaskIds?: string[];
    /** Which durable request this turn creates or joins (docs/collaboration-contract.md). */
    request?: AcceptedTurnRequestInput;
    /** Connected Folder Workers the person addressed with @; registered ids, never this scope's own. */
    addressedConnectedFolderIds?: string[];
  },
): Promise<{ message: { id: string; role: "user"; content: string; createdAt: string; attachments?: ChatMessageAttachmentRef[] }; taskId: string; replayed: boolean }> {
  const turnKey = clientKey(connectedFolder.id, conversationId);
  await yieldBackgroundCompaction(state, turnKey);
  const fileAttachments = connectedFolder.id === ampleFileAgentScopeId ? [] : contextPathAttachments(connectedFolder.connectedFolderRoot, input.contextPaths);
  const attachmentFields = fileAttachments.length ? { attachments: fileAttachments } : {};
  const existing = await readConversationSummary(connectedFolder.connectedFolderRoot, conversationId);
  if (!existing) throw notFound("Conversation not found.");
  const requestId = turnIdentity(input.requestId ?? `request-${randomUUID()}`, "request id");
  const requestDigest = assistantTurnRequestDigest(input);
  const prior = state.turnStore.findRequest(connectedFolder.id, conversationId, requestId);
  let durable: AmpleFileDurableTurnRecord | null = null;
  if (prior) {
    if (prior.requestDigest !== requestDigest) throw httpError(409, "This turn request id was already used for different input.");
    if (!prior.userMessagePersisted) {
      if (state.runningTurns.has(turnKey)) throw httpError(409, "This turn is still being accepted.");
      durable = await state.turnStore.resumeUnpersisted(prior.turnId);
      if (!durable || durable.userMessagePersisted) throw httpError(409, "This turn can no longer be resumed safely.");
      state.settledTurns.delete(prior.turnId);
    } else {
      const messages = await readConversation(connectedFolder.connectedFolderRoot, conversationId);
      const persisted = messages.find((candidate) => candidate.id === prior.userMessageId && candidate.role === "user");
      return {
        message: persisted
          ? { id: persisted.id, role: "user", content: persisted.content, createdAt: persisted.createdAt, ...(persisted.attachments?.length ? { attachments: persisted.attachments } : {}) }
          : { id: prior.userMessageId, role: "user", content: input.content, createdAt: prior.userMessageCreatedAt, ...attachmentFields },
        taskId: prior.turnId,
        replayed: true,
      };
    }
  }
  if (existing.archivedAt) throw httpError(409, "Restore this Chat before sending another message.");
  if (existing.snoozedUntil && Date.parse(existing.snoozedUntil) > Date.now()) {
    throw httpError(409, "Resume this Chat before sending another message.");
  }
  assertNoCapabilityMutationForTurn(state, connectedFolder.id);
  if (state.compactingConversations.has(turnKey)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  if (state.runningTurns.has(turnKey)) throw httpError(409, "Wait for the current agent turn to finish.");
  if (input.request?.joinRequestId) {
    try { state.requests.assertCanContinue(input.request.joinRequestId); }
    catch (error) { throw requestRefusal(error); }
  }
  // A delegated child is refused by name before anything durable exists for
  // it: the parent must still be accepting, and every request bound is
  // checked here rather than after a turn was already accepted.
  if (input.request?.parentTaskId && !durable) {
    try {
      state.requests.assertCanAddChild(input.request.parentTaskId);
    } catch (error) {
      throw requestRefusal(error);
    }
  }
  // The summary read above can overlap a completed deletion. Recheck the
  // transcript synchronously at admission so accepting a stale send cannot
  // recreate the Chat after its recoverable copy has moved into Recently deleted.
  if (!existsSync(join(conversationsDir(connectedFolder.connectedFolderRoot), `${conversationId}.jsonl`))) {
    throw notFound("Conversation not found.");
  }
  state.runningTurns.add(turnKey);
  // Clear the settled turn's retained stream state in the same synchronous
  // admission step that marks this Chat running. A reconnect can never observe
  // `running: true` paired with the previous reply's text.
  resetChatEventTurn(state, turnKey);
  const userMessageId = turnIdentity(input.userMessageId ?? `message-${randomUUID()}`, "user message id");
  const userMessageCreatedAt = new Date().toISOString();
  try {
    if (durable) {
      // The durable reservation was reopened above after an explicit retry.
    } else {
      const accepted = await state.turnStore.accept({
        requestId,
        requestDigest,
        userMessageId,
        userMessageCreatedAt,
        connectedFolderId: connectedFolder.id,
        conversationId,
        actorKind: input.actorKind,
      });
      if (accepted.replayed) {
        state.runningTurns.delete(turnKey);
        return {
          message: { id: accepted.record.userMessageId, role: "user", content: input.content, createdAt: accepted.record.userMessageCreatedAt, ...attachmentFields },
          taskId: accepted.record.turnId,
          replayed: true,
        };
      }
      durable = accepted.record;
    }
  } catch (error) {
    state.runningTurns.delete(turnKey);
    if (error instanceof AmpleFileTurnReplayConflictError) throw httpError(409, error.message);
    throw error;
  }
  if (!durable) throw new Error("Turn reservation was not created.");
  const task = state.kernel.startTask({
    id: durable.turnId,
    kind: "assistant_turn",
    connectedFolderId: connectedFolder.id,
    conversationId,
    actor: { kind: input.actorKind, cwd: connectedFolder.connectedFolderRoot, connectedFolderId: connectedFolder.id, conversationId },
  });
  state.activeTurnTasks.set(task.id, { connectedFolderId: connectedFolder.id, conversationId });
  state.activeTurnIdsByKey.set(turnKey, task.id);
  publishControlHint(state, "activity");
  const ampleFileAgentAttachments = connectedFolder.id === ampleFileAgentScopeId
    ? input.ampleFileAgentAttachments ?? []
    : undefined;
  const message = {
    id: durable.userMessageId,
    role: "user" as const,
    content: input.content,
    ...(input.actorKind === "system" && input.request?.joinRequestId ? { kind: "assistant_continuation" as const } : {}),
    createdAt: durable.userMessageCreatedAt,
    turnId: task.id,
    requestId,
    ...(ampleFileAgentAttachments?.length
      ? { attachments: ampleFileAgentAttachments.map((ref) => ({ kind: ref.kind, target: ref.target, name: ref.name })) }
      : attachmentFields),
  };
  let answeredQuestionIds: string[] = [];
  try {
    // Every accepted turn belongs to exactly one request record. The
    // record is created before the user message lands so a refused child
    // never leaves a message behind; a failure here rolls back with the rest.
    const lineage = await recordAcceptedTurnRequest(state, connectedFolder, conversationId, task.id, input, ampleFileAgentAttachments);
    answeredQuestionIds = lineage.answers;
    await appendMessage(connectedFolder.connectedFolderRoot, conversationId, message);
    await state.turnStore.markRunning(task.id);
    await state.requests.markTurnRunning(task.id);
    // A person's free-text reply is a supported way to answer: once
    // the message is the transcript's, it answers each open question that
    // was waiting on the person and is that answer's one continuation.
    await answerPersonQuestionsWithReply(state, lineage.answers, task.id, input.content);
    if (input.request?.joinRequestId && input.releasedChildTaskIds?.length) {
      await state.requests.noteChildDelivery(input.request.joinRequestId, input.releasedChildTaskIds);
    }
  } catch (error) {
    state.runningTurns.delete(turnKey);
    state.activeTurnTasks.delete(task.id);
    state.cancelledTurnTasks.delete(task.id);
    state.activeTurnIdsByKey.delete(turnKey);
    state.kernel.finishTask(task.id);
    publishControlHint(state, "activity");
    const detail = error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError
      ? error.message
      : "The accepted user message could not be persisted.";
    await state.turnStore.settle(task.id, { status: "failed", error: detail }).catch(() => undefined);
    await state.requests.settleTurn(task.id, { status: "failed", error: detail }).catch(() => undefined);
    broadcast(state, turnKey, turnStateEvent(conversationId, false));
    throw requestRefusal(error);
  }
  const answeredQuestionId = input.request?.answeringQuestionId ?? answeredQuestionIds[0];
  // A live surface may re-read the transcript on this transition. Publish it
  // only after its accepted user message is durable, including answer turns.
  broadcast(state, turnKey, turnStateEvent(conversationId, true));
  const turn = runAgentTurn(
    state,
    connectedFolder.id,
    connectedFolder.connectedFolderRoot,
    conversationId,
    input.content,
    input.contextPaths,
    task.id,
    {
      ...(ampleFileAgentAttachments ? { ampleFileAgentAttachments } : {}),
      ...(input.request?.parentTaskId ? { parentTaskId: input.request.parentTaskId } : {}),
      ...(input.request?.assignment !== undefined ? { assignment: input.request.assignment } : {}),
      // The continuation's own link to the question it answers, built
      // by the host rather than read back out of the travelling transcript:
      // `chat answer` names the question, and a person's free-text reply
      // answers whichever of this request's questions were waiting on them.
      ...(answeredQuestionId ? { answeredQuestionId } : {}),
      ...(input.addressedConnectedFolderIds?.length ? { addressedConnectedFolderIds: input.addressedConnectedFolderIds } : {}),
      ...(input.automationSource ? { automation: { title: input.automationSource.title } } : {}),
    },
  );
  state.activeTurnPromises.add(turn);
  void turn.then(
    () => state.activeTurnPromises.delete(turn),
    (error) => {
      state.activeTurnPromises.delete(turn);
      console.error(`Accepted turn escaped its settlement path: ${errorMessage(error)}`);
    },
  );
  return { message, taskId: task.id, replayed: false };
}

/**
 * A request bound or lineage refusal reaches the caller verbatim as a
 * conflict, so the limit's own text — number and Settings section — is what
 * the person or agent reads. Anything else passes through unchanged.
 */
function requestRefusal(error: unknown): unknown {
  if (error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError) {
    return httpError(409, error.message);
  }
  return error;
}

/**
 * Creates or joins the durable request record for one accepted turn. Kind
 * and surface default from the scope and actor when the caller names none:
 *
 *   AmpleFile Agent scope, renderer                    → management / popover
 *   AmpleFile Agent scope, cli                         → management / cli
 *   AmpleFile Agent scope, system (automation agent hop)   → automation / system
 *   Connected Folder scope, system (automation chat hop)        → automation / system
 *   Connected Folder scope, cli                              → cli / cli
 *   Connected Folder scope, assistant (renderer Connected Folder Chat)  → Connected Folder / renderer
 *
 * A child of an explicit parent keeps the parent's root; a needs-you reply
 * joins its earlier request instead of copying its trail into a second one.
 */
async function recordAcceptedTurnRequest(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string; name?: string },
  conversationId: string,
  taskId: string,
  input: {
    content: string;
    actorKind: "assistant" | "cli" | "renderer" | "system";
    continuedFromAmpleFileAgentTaskId?: string;
    request?: AcceptedTurnRequestInput;
  },
  ampleFileAgentAttachments: AmpleFileAgentAttachmentRef[] | undefined,
): Promise<{ record: AmpleFileRequestRecord; answers: string[] }> {
  const isAmpleFileAgent = connectedFolder.id === ampleFileAgentScopeId;
  // This Chat's newest request is waiting on the person and no parent was
  // named: the reply joins that request rather than opening a second root,
  // whether the caller named the request it continues or not.
  const pending = input.request?.parentTaskId || input.request?.answeringQuestionId
    ? null
    : pendingPersonQuestions(state, conversationId, isAmpleFileAgent ? {} : { connectedFolderId: connectedFolder.id });
  const joinRequestId = input.request?.joinRequestId ?? pending?.requestId;
  const answers = pending && pending.requestId === joinRequestId ? pending.questionIds : [];
  const request: AcceptedTurnRequestInput | undefined = joinRequestId
    ? { ...input.request, joinRequestId }
    : input.request;
  input = { ...input, request };
  const owner = isAmpleFileAgent
    ? { conversationId }
    : { connectedFolderId: connectedFolder.id, ...(connectedFolder.name ? { connectedFolderName: connectedFolder.name } : {}), conversationId };
  const kind: AmpleFileRequestCreatableKind = input.request?.kind
    ?? (isAmpleFileAgent
      ? (input.actorKind === "system" ? "automation" : "agent")
      : input.actorKind === "system"
        ? "automation"
        : input.actorKind === "cli"
          ? "cli"
          : "connected-folder");
  const surface: AmpleFileRequestSurface = input.request?.surface
    ?? (input.actorKind === "system"
      ? "system"
      : input.actorKind === "cli"
        ? "cli"
        : isAmpleFileAgent
          ? "popover"
          : "renderer");
  const attachments = ampleFileAgentAttachments ?? [];
  const record = input.request?.joinRequestId
    ? await state.requests.joinTurn({
      requestId: input.request.joinRequestId,
      taskId,
      role: "continuation",
      content: input.content,
      attachments,
    })
    : input.request?.parentTaskId
      ? await state.requests.beginChild({
        parentTaskId: input.request.parentTaskId,
        kind,
        owner,
        surface,
        taskId,
        content: input.content,
        attachments,
      })
      : await state.requests.beginRoot({
        kind,
        owner,
        surface,
        taskId,
        content: input.content,
        attachments,
        ...(input.continuedFromAmpleFileAgentTaskId ? { continuedFromTaskId: input.continuedFromAmpleFileAgentTaskId } : {}),
      });
  // A retried acceptance whose earlier attempt could not persist its message
  // reopens the same turn: a task id belongs to exactly one request.
  const turn = record.turns.find((candidate) => candidate.taskId === taskId);
  if (turn && turn.state !== "accepted" && turn.state !== "running") {
    return { record: (await state.requests.reopenTurn(taskId)) ?? record, answers };
  }
  return { record, answers };
}

/**
 * The open questions addressed to the person on this Chat's newest request,
 * if it is waiting on them. Scoped to the owner: a conversation id lives in
 * the Connected Folder's folder and travels with it, so two registered Connected Folders can hold the
 * same id and a reply must never join the other one's request.
 */
function pendingPersonQuestions(
  state: LocalApiState,
  conversationId: string,
  owner: { connectedFolderId?: string },
): { requestId: string; questionIds: string[] } | null {
  const latest = state.requests.latestForConversation(conversationId, owner);
  if (!latest || latest.state !== "waiting") return null;
  const open = state.requests.questions(latest.requestId)
    .filter((question) => question.state === "open" && question.respondent === "person");
  return open.length ? { requestId: latest.requestId, questionIds: open.map((question) => question.questionId) } : null;
}

/**
 * Records the person's reply as the one answer to each question it was
 * waiting on and links this turn as that answer's continuation. Attribution
 * only: a question that can no longer take an answer (expired, withdrawn,
 * answered meanwhile) is left as it is, and the turn still runs.
 */
async function answerPersonQuestionsWithReply(state: LocalApiState, questionIds: string[], taskId: string, content: string): Promise<void> {
  // Cleaned before the cut: cleaning can grow the text (a control byte
  // becomes a three-byte U+FFFD), so cutting first could leave a reply the
  // store refuses as too long.
  const answer = scrubAmpleFileRequestText(content, ampleFileRequestLimits.maxAnswerTextBytes);
  for (const questionId of questionIds) {
    try {
      await state.requests.answer({ questionId, answer });
      await state.requests.linkContinuation(questionId, taskId);
    } catch (error) {
      console.warn(`A reply could not be recorded as the answer to question ${questionId}: ${errorMessage(error)}`);
    }
  }
}

/**
 * Delivers a message into the Chat's running turn through Pi's steering queue
 * and records it in the transcript as part of that turn. When no turn is
 * running (or it settles first) the caller receives 409 and sends normally;
 * nothing is appended in that case.
 */
export async function steerConversationTurn(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  conversationId: string,
  input: { content: string; requestId?: string; userMessageId?: string },
): Promise<{ message: ChatMessage; taskId: string; replayed: boolean }> {
  const key = clientKey(connectedFolder.id, conversationId);
  const taskId = state.activeTurnIdsByKey.get(key);
  const client = state.clients.get(key);
  if (!taskId || !client || !state.runningTurns.has(key)) {
    throw httpError(409, "No turn is running in this Chat; send the message normally.");
  }
  const requestId = turnIdentity(input.requestId ?? `steer-${randomUUID()}`, "request id");
  const replayKey = `${key}\u0000${requestId}`;
  const prior = state.steeredMessages.get(replayKey);
  if (prior) return { message: prior, taskId, replayed: true };
  const inFlight = state.steeringInFlight.get(replayKey);
  if (inFlight) return { message: await inFlight, taskId, replayed: true };
  const delivery = deliverSteer(state, connectedFolder, conversationId, client, taskId, requestId, replayKey, input);
  state.steeringInFlight.set(replayKey, delivery);
  try {
    return { message: await delivery, taskId, replayed: false };
  } finally {
    state.steeringInFlight.delete(replayKey);
  }
}

async function deliverSteer(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  conversationId: string,
  client: PiConversationClient,
  taskId: string,
  requestId: string,
  replayKey: string,
  input: { content: string; userMessageId?: string },
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: turnIdentity(input.userMessageId ?? `message-${randomUUID()}`, "user message id"),
    role: "user",
    content: input.content,
    createdAt: new Date().toISOString(),
    turnId: taskId,
    requestId,
    delivery: "steer",
  };
  try {
    await client.steer(input.content);
  } catch (error) {
    if (isPiTurnNotRunningError(error)) throw httpError(409, errorMessage(error));
    throw error;
  }
  await appendMessage(connectedFolder.connectedFolderRoot, conversationId, message);
  state.steeredMessages.set(replayKey, message);
  if (state.steeredMessages.size > maxRememberedSteeredMessages) {
    const oldest = state.steeredMessages.keys().next().value;
    if (oldest !== undefined) state.steeredMessages.delete(oldest);
  }
  broadcast(state, streamKey(connectedFolder.id, conversationId), {
    type: "status",
    conversationId,
    message: "Your message will reach the agent after its current step.",
  });
  return message;
}

const maxRememberedSteeredMessages = 500;

function assistantTurnRequestDigest(input: {
  content: string;
  contextPaths: string[];
  ampleFileAgentAttachments?: AmpleFileAgentAttachmentRef[];
  actorKind?: string;
  continuedFromAmpleFileAgentTaskId?: string;
}): string {
  // Addressed Workers are deliberately outside the digest: they are a hint for
  // this turn's context, and a retry must replay even if one of them was
  // removed in between.
  return createHash("sha256").update(JSON.stringify({
    content: input.content,
    contextPaths: input.contextPaths,
    // Kept constant so digests from before the selected path was dropped still match.
    selectedPath: null,
    actorKind: input.actorKind ?? null,
    continuedFromAmpleFileAgentTaskId: input.continuedFromAmpleFileAgentTaskId ?? null,
    ampleFileAgentAttachments: (input.ampleFileAgentAttachments ?? []).map((attachment) => ({
      kind: attachment.kind,
      target: attachment.target,
      name: attachment.name,
    })),
  })).digest("hex");
}

export function optionalTurnIdentity(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : turnIdentity(value, label);
}

function turnIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw badRequest(`${label} is invalid.`);
  }
  return value;
}

/** Every change to a Chat's queued message goes through here and gets the next number. */
export function changeQueuedMessage(state: LocalApiState, key: string, next: QueuedChatMessage | null): number {
  state.lastQueueRevision += 1;
  state.queueRevisions.set(key, state.lastQueueRevision);
  if (next) state.queuedMessages.set(key, next);
  else state.queuedMessages.delete(key);
  return state.lastQueueRevision;
}

export function queuedMessageEvent(state: LocalApiState, connectedFolderId: string, conversationId: string, sent?: QueuedChatMessage) {
  const key = clientKey(connectedFolderId, conversationId);
  const queued = state.queuedMessages.get(key);
  return {
    type: "queued_message" as const,
    conversationId,
    revision: state.queueRevisions.get(key) ?? 0,
    queued: queued ? { content: queued.content, updatedAt: queued.updatedAt, ...(queued.held ? { held: true } : {}) } : null,
    // The files that went out with a sent queued message, so windows unstage them.
    ...(sent ? { sentContextPaths: sent.contextPaths } : {}),
  };
}

/**
 * Replaces a Chat's queued message while its turn runs. A Chat with no running
 * turn is refused (409) so the caller sends the message now instead.
 */
export function queueChatMessage(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  input: { content: string; contextPaths: string[]; addressedConnectedFolderIds: string[] },
): { queued: { content: string; updatedAt: string }; revision: number } {
  const key = clientKey(connectedFolderId, conversationId);
  if (!state.runningTurns.has(key)) throw httpError(409, "No turn is running in this Chat; send the message now.");
  const queued: QueuedChatMessage = { ...input, updatedAt: new Date().toISOString() };
  const revision = changeQueuedMessage(state, key, queued);
  broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId));
  return { queued: { content: queued.content, updatedAt: queued.updatedAt }, revision };
}

/** Removes a Chat's queued message and returns it, so it can go back to a composer. */
export function cancelQueuedMessage(state: LocalApiState, connectedFolderId: string, conversationId: string): { queued: { content: string; updatedAt: string } | null; revision: number } {
  const key = clientKey(connectedFolderId, conversationId);
  const queued = state.queuedMessages.get(key);
  if (!queued) return { queued: null, revision: state.queueRevisions.get(key) ?? 0 };
  const revision = changeQueuedMessage(state, key, null);
  broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId));
  return { queued: { content: queued.content, updatedAt: queued.updatedAt }, revision };
}

/**
 * Sends a Chat's queued message as an ordinary new turn once the turn it
 * waited on has ended. If the Chat cannot take it yet (another turn started
 * first), it stays queued for the next turn's end.
 */
export async function sendQueuedMessage(state: LocalApiState, connectedFolderId: string, connectedFolderRoot: string, conversationId: string, queued: QueuedChatMessage): Promise<void> {
  const key = clientKey(connectedFolderId, conversationId);
  if (!state.acceptingTurns || state.queuedMessages.get(key) !== queued) return;
  // Leaves the queue as it becomes the Chat's message, so no window shows both.
  changeQueuedMessage(state, key, null);
  broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId, queued));
  try {
    const agentScope = connectedFolderId === ampleFileAgentScopeId;
    await acceptConversationTurn(state, { id: connectedFolderId, connectedFolderRoot }, conversationId, {
      content: queued.content,
      contextPaths: agentScope ? [] : queued.contextPaths,
      actorKind: agentScope ? "renderer" : "assistant",
      ...(agentScope ? { ampleFileAgentAttachments: [] } : {}),
      ...(queued.addressedConnectedFolderIds.length ? { addressedConnectedFolderIds: queued.addressedConnectedFolderIds } : {}),
    });
  } catch (error) {
    console.warn(`A queued message stays queued: ${errorMessage(error)}`);
    if (!state.queuedMessages.has(key)) {
      changeQueuedMessage(state, key, queued);
      broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId));
    }
  }
}

/** A Connected Folder Chat's attached files and folders, kept on its message so the Chat shows what was sent. */
function contextPathAttachments(connectedFolderRoot: string, contextPaths: string[]): ChatMessageAttachmentRef[] {
  return contextPaths.slice(0, 32).map((path) => {
    let folder = false;
    try { folder = statSync(resolveConnectedFolderPath(connectedFolderRoot, path)).isDirectory(); } catch { /* a missing path stays a file reference */ }
    return { kind: folder ? "folder" : "file", target: path, name: path.slice(path.lastIndexOf("/") + 1) || path };
  });
}
