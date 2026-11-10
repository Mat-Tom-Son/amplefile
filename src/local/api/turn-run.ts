/**
 * Running an accepted turn to its settled record: the Pi prompt, the
 * turn-boundary History checkpoints, failure text, the turn count, startup
 * recovery of turns a previous run left unfinished, and background compaction
 * of idle Chats.
 */

import { turnFileChanges } from "../agent/turn-file-changes.js";
import { randomUUID } from "node:crypto";
import { childFolderPaths } from "../../shared/folder-nesting.js";
import {
  PiConversationClient,
  isPiTurnTimeoutError,
  PiTurnFailure,
  PiTurnDrainingError,
  isPiTurnCancelledError,
} from "../agent/pi-client.js";
import { parseAssistantPresentation } from "../agent/turn-presentation.js";
import type { AmpleFileDurableTurnRecord } from "../agent/turn-store.js";
import {
  appendMessage,
  conversationNeedsGeneratedTitle,
  markConversationTitleAttempted,
  readConversation,
  setGeneratedConversationTitle,
  type ChatMessage,
} from "../agent/chat-store.js";
import { loadConversationContextReferencesForTurn } from "../conversation-context.js";
import {
  loadAmpleFileAgentAttachmentsForTurn,
  ampleFileAgentAttachmentLinks,
  type AmpleFileAgentAttachmentRef,
} from "../amplefile-agent-attachments.js";
import { buildConnectedFolderTurnContext, connectedFolderTurnHistory } from "../agent/connected-folder-turn-context.js";
import { createConnectedFolderCheckpoint } from "../history.js";
import { normalizeGeneratedConversationTitle } from "../../shared/chat-title.js";
import { ampleFileAgentRoot, ampleFileAgentScopeId } from "../state-paths.js";
import { getConnectedFolder, registeredConnectedFolderOutline } from "../connected-folder.js";
import { backgroundJobsForTurn } from "./background-jobs.js";
import { getClient, refreshClientIfMarked } from "./conversation-clients.js";
import { broadcast, flushTurnCheckpoint, publishControlHint, turnStateEvent } from "./event-streams.js";
import { errorMessage } from "./http.js";
import { composeContinuationMessage, queueRequestGraphSettle } from "./request-routes.js";
import { type BackgroundCompaction, clientKey, type LocalApiState, type SettledTurnRecord, streamKey } from "./state.js";
import { changeQueuedMessage, queuedMessageEvent, sendQueuedMessage } from "./turn-acceptance.js";

export async function runAgentTurn(
  state: LocalApiState,
  connectedFolderId: string,
  connectedFolderRoot: string,
  conversationId: string,
  content: string,
  contextPaths: string[],
  taskId: string,
  options: {
    ampleFileAgentAttachments?: AmpleFileAgentAttachmentRef[];
    /** The task that delegated this Connected Folder turn; decorates its context, never its acceptance. */
    parentTaskId?: string;
    /** The assignment when it differs from this turn's message. */
    assignment?: string;
    /** The question this turn's message answers, when it is a continuation. */
    answeredQuestionId?: string;
    /** Connected Folder Workers the person addressed with @ in this message. */
    addressedConnectedFolderIds?: string[];
    /** The automation that sent this message; nobody is watching the turn. */
    automation?: { title: string };
  } = {},
): Promise<void> {
  const { ampleFileAgentAttachments, answeredQuestionId } = options;
  const request = state.requests.byTaskId(taskId);
  const parentTaskId = request?.parentTaskId ?? options.parentTaskId;
  const assignment = request?.assignment ?? options.assignment;
  const key = clientKey(connectedFolderId, conversationId);
  let client: PiConversationClient | null = null;
  let promptStarted = false;
  let settledStatus: SettledTurnRecord["status"] = "succeeded";
  // Quitting mid-turn is recorded like a crash (interrupted), never as a Stop the person asked for.
  let closedByApp = false;
  let settledMessageId: string | undefined;
  let settledError: string | undefined;
  let capturedWorkTrail: ReturnType<PiConversationClient["getTurnWorkTrail"]> = [];
  let capturedPresentation: ReturnType<PiConversationClient["getTurnPresentation"]>;
  let beforeCheckpoint: import("../history.js").ConnectedFolderCheckpoint | null = null;
  let afterCheckpoint: import("../history.js").ConnectedFolderCheckpoint | null = null;
  changeTurnCount(state, 1);
  try {
    client = await getClient(state, connectedFolderId, connectedFolderRoot, conversationId);
    const loadContextAttachments = (budgetTokens: number) => ampleFileAgentAttachments
      ? loadAmpleFileAgentAttachmentsForTurn(ampleFileAgentAttachments, budgetTokens)
      : loadConversationContextReferencesForTurn(connectedFolderRoot, contextPaths, budgetTokens);
    const attachedLinks = ampleFileAgentAttachments ? ampleFileAgentAttachmentLinks(ampleFileAgentAttachments) : [];
    const ampleFileAgentRegistry = connectedFolderId === ampleFileAgentScopeId
      ? (await state.kernel.getConnectedFolders({ kind: "renderer" })).connectedFolders
      : null;
    // Connected Folder turns read nesting from the registry file only — never listConnectedFolders(),
    // which rewrites every Connected Folder's portable manifest — and a failed read just
    // leaves the nesting context out instead of failing the turn.
    const registeredConnectedFolders: Array<{ id: string; name: string; connectedFolderRoot: string }> = ampleFileAgentRegistry
      ?? await registeredConnectedFolderOutline().catch(() => []);
    const ampleFileAgentConnectedFolders = ampleFileAgentRegistry
      ? ampleFileAgentRegistry.map((connectedFolder) => ({
          id: connectedFolder.id,
          name: connectedFolder.name,
          connectedFolderRoot: connectedFolder.connectedFolderRoot,
          ...(connectedFolder.parentConnectedFolderId ? { parentConnectedFolderId: connectedFolder.parentConnectedFolderId } : {}),
        }))
      : undefined;
    // Connected Folders inside Connected Folders: the person's @ mentions resolve to
    // the ids handoff and send take, and a parent's Worker learns which of
    // its own subfolders belong to another Worker.
    const addressedFolders = (options.addressedConnectedFolderIds ?? []).flatMap((id) => {
      const connectedFolder = registeredConnectedFolders.find((item) => item.id === id);
      return connectedFolder ? [{ connectedFolderId: connectedFolder.id, name: connectedFolder.name }] : [];
    });
    // A Connected Folder turn's own identity: its ids, and when delegated, an
    // opaque handle for the request that asked. Never for the AmpleFile Agent
    // scope, which carries the registry snapshot instead.
    const connectedFolderTurn = connectedFolderId === ampleFileAgentScopeId
      ? undefined
      : buildConnectedFolderTurnContext({
        connectedFolderId,
        taskId,
        requestId: resolveTurnRequestId(state, taskId),
        handleSalt: state.connectedFolderTurnHandleSalt,
        ...(answeredQuestionId ? { answeredQuestionId } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
        ...(assignment !== undefined && assignment !== content ? { assignment } : {}),
        ...(parentTaskId && (assignment === undefined || assignment === content) ? { assignmentIsThisMessage: true } : {}),
      });
    if (connectedFolderTurn && request) {
      const children = state.requests.children(request.requestId).filter((child) => {
        const latest = child.turns.at(-1)!;
        return latest.settledAt !== null && !request.deliveredChildTaskIds.includes(latest.taskId);
      });
      if (children.length) {
        connectedFolderTurn.releasedChildResults = await composeContinuationMessage(state, request, children);
        await state.requests.noteChildDelivery(request.requestId, children.map((child) => child.turns.at(-1)!.taskId));
      }
    }
    const backgroundJobs = await backgroundJobsForTurn(state, connectedFolderId, conversationId, taskId);
    beforeCheckpoint = await captureTurnCheckpointSafe(state, connectedFolderId, connectedFolderRoot, conversationId, "pre_turn");
    if (connectedFolderTurn) connectedFolderTurn.history = connectedFolderTurnHistory(beforeCheckpoint);
    const ownConnectedFolder = registeredConnectedFolders.find((item) => item.id === connectedFolderId);
    if (connectedFolderTurn && ownConnectedFolder) {
      const nested = [...childFolderPaths(ownConnectedFolder, registeredConnectedFolders)].map(([path, child]) => ({ connectedFolderId: child.id, name: child.name, path }));
      if (nested.length) connectedFolderTurn.nestedFolders = nested;
    }
    await state.beforeAgentPrompt?.({
      connectedFolderId, conversationId, taskId,
      ...(connectedFolderTurn ? { connectedFolderTurn } : {}),
      ...(options.automation ? { automation: options.automation } : {}),
    });
    throwIfTurnCancelled(state, taskId);
    promptStarted = true;
    const finalText = await client.prompt(content, {
      loadContextAttachments,
      ...(connectedFolderId === ampleFileAgentScopeId ? { ampleFileAgentTaskId: taskId } : {}),
      ...(ampleFileAgentConnectedFolders ? { ampleFileAgentConnectedFolders } : {}),
      ...(connectedFolderTurn ? { connectedFolderTurn } : {}),
      ...(attachedLinks.length ? { attachedLinks } : {}),
      ...(addressedFolders.length ? { addressedFolders } : {}),
      ...(options.automation ? { automation: options.automation } : {}),
      ...(backgroundJobs.length ? { backgroundJobs } : {}),
      // A later turn of the same request picks up the checklist where it was left.
      ...(request?.checklist?.items.length ? { checklist: request.checklist.items } : {}),
    });
    // Capture synchronously with prompt completion. Shutdown may dispose the
    // client while the server awaits checkpoint persistence below.
    capturedPresentation = parseAssistantPresentation(client.getTurnPresentation(), finalText);
    capturedWorkTrail = client.getTurnWorkTrail();
    promptStarted = false;
    afterCheckpoint = await captureTurnCheckpointSafe(state, connectedFolderId, connectedFolderRoot, conversationId, "post_turn");
    await flushTurnCheckpoint(state, key, taskId);
    const durable = state.turnStore.get(taskId);
    const workTrail = capturedWorkTrail;
    const assistantMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: finalText,
      ...(capturedPresentation ? { assistantPresentation: capturedPresentation } : {}),
      createdAt: new Date().toISOString(),
      turnId: taskId,
      ...(durable?.requestId ? { requestId: durable.requestId } : {}),
      ...(workTrail.length ? { workTrail } : {}),
    };
    await appendMessage(connectedFolderRoot, conversationId, assistantMessage);
    settledMessageId = assistantMessage.id;
    try {
      const transcript = await readConversation(connectedFolderRoot, conversationId);
      if (conversationNeedsGeneratedTitle(transcript)) {
        // Record the one naming attempt before the isolated request. A crash or
        // provider failure must not turn every later Chat turn into another
        // hidden title request.
        await markConversationTitleAttempted(connectedFolderRoot, conversationId);
        const firstUserMessage = transcript.find((message) => message.role === "user")?.content;
        const modelTitle = firstUserMessage
          ? normalizeGeneratedConversationTitle(
            await client.generateConversationTitle(firstUserMessage, finalText),
          )
          : null;
        if (modelTitle) {
          const titledConversation = await setGeneratedConversationTitle(connectedFolderRoot, conversationId, modelTitle);
          client.setSessionName(titledConversation.title);
        }
      }
    } catch (error) {
      // Naming is deliberately best-effort: a title provider failure must not
      // turn a successfully persisted agent response into a failed turn.
      console.warn(`Could not persist a generated Chat title: ${errorMessage(error)}`);
    }
  } catch (error) {
    // A reused client still holds its previous turn until prompt resets it.
    // Pre-prompt cancellation/failure must never inherit that turn's evidence.
    if (promptStarted) {
      capturedPresentation ??= client?.getTurnPresentation();
      capturedWorkTrail = client?.getTurnWorkTrail() ?? [];
    }
    const cancelled = isPiTurnCancelledError(error);
    closedByApp = cancelled && !state.cancelledTurnTasks.has(taskId) && !state.acceptingTurns;
    if (promptStarted) {
      promptStarted = false;
      afterCheckpoint = await captureTurnCheckpointSafe(state, connectedFolderId, connectedFolderRoot, conversationId, "post_turn");
    }
    await flushTurnCheckpoint(state, key, taskId);
    const durable = state.turnStore.get(taskId);
    let failureResultPreserved = false;
    if (!cancelled) {
      console.warn(`Turn failed in ${connectedFolderId}/${conversationId}: ${providerCreditFailureDetail(error) ?? errorMessage(error)}`);
    }
    const publicDetail = closedByApp
      ? appClosedTurnDetail
      : cancelled
        ? "The agent was stopped before it completed this response."
        : assistantFailurePublicDetail(error);
    const workTrail = capturedWorkTrail;
    const interruptedContent = closedByApp
      ? durable?.assistantText.trim() || appClosedTurnDetail
      : assistantFailureTranscriptContent(error, durable?.assistantText ?? "", cancelled);
    const interruptedPresentation = parseAssistantPresentation(capturedPresentation, interruptedContent);
    const interruptedMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: interruptedContent,
      ...(interruptedPresentation ? { assistantPresentation: interruptedPresentation } : {}),
      createdAt: new Date().toISOString(),
      turnId: taskId,
      ...(durable?.requestId ? { requestId: durable.requestId } : {}),
      ...(workTrail.length ? { workTrail } : {}),
      interruption: {
        reason: closedByApp ? "app_interrupted" as const : cancelled ? "cancelled" as const : assistantFailureReason(error),
        message: publicDetail,
        retryAttempts: error instanceof PiTurnFailure ? error.retryAttempts : 0,
        provider: error instanceof PiTurnFailure ? error.provider : null,
        model: error instanceof PiTurnFailure ? error.model : null,
        activities: error instanceof PiTurnFailure ? error.activities : [],
      },
    };
    try {
      await appendMessage(connectedFolderRoot, conversationId, interruptedMessage);
      failureResultPreserved = true;
      settledMessageId = interruptedMessage.id;
    } catch (preservationError) {
      console.error(`Could not preserve an interrupted Worker result: ${errorMessage(preservationError)}`);
    }
    const message = closedByApp ? appClosedTurnDetail : assistantTurnFailureMessage(error, failureResultPreserved);
    settledStatus = cancelled && !closedByApp ? "aborted" : "failed";
    settledError = message;
    // A provider failure settles the Pi session cleanly after its bounded retry
    // path. Keep that live session so the next user message can continue from
    // completed tool results. Unexpected runtime failures still rebuild the
    // client from the durable Pi session on the next turn.
    if (!(error instanceof PiTurnFailure)) {
      await client?.stop().catch(() => undefined);
      state.clients.delete(key);
    }
  } finally {
    if (promptStarted) afterCheckpoint = await captureTurnCheckpointSafe(state, connectedFolderId, connectedFolderRoot, conversationId, "post_turn");
    await flushTurnCheckpoint(state, key, taskId);
    const durableText = state.turnStore.get(taskId)?.assistantText ?? "";
    // Attribution, recorded with the outcome: the model that actually ran this
    // turn and what Pi reported it used.
    const turnUsage = client?.getTurnUsage() ?? null;
    await state.turnStore.settle(taskId, {
      status: closedByApp ? "interrupted" : settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
      assistantText: durableText,
      fileChanges: turnFileChanges(beforeCheckpoint, afterCheckpoint),
      ...(turnUsage ? { usage: turnUsage } : {}),
      ...(client?.getTurnHelperRuns().length ? { helpers: client.getTurnHelperRuns() } : {}),
    }).catch((error) => {
      console.error(`Could not persist turn settlement: ${errorMessage(error)}`);
      return null;
    });
    // The request record settles with the same outcome and usage, before the
    // task-scoped record, so a waiter or the overview reads a current request
    // state on the next tick.
    await state.requests.settleTurn(taskId, {
      status: closedByApp ? "interrupted" : settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
      ...(turnUsage ? { usage: turnUsage } : {}),
      ...(client?.getTurnHelperRuns().length ? { helpers: client.getTurnHelperRuns() } : {}),
    }).catch((error: unknown) => {
      console.error(`Could not persist request settlement: ${errorMessage(error)}`);
      return null;
    });
    state.runningTurns.delete(key);
    state.cancelledTurnTasks.delete(taskId);
    state.activeTurnIdsByKey.delete(key);
    state.kernel.finishTask(taskId);
    // The Connected Folder's Worker instructions changed during this turn (Set up
    // for me). Rebuild this Chat's client so its next turn sees them.
    await refreshClientIfMarked(state, key);
    settleTurnTask(state, taskId, {
      connectedFolderId,
      conversationId,
      status: settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
    });
    broadcast(state, key, settledStatus === "succeeded"
      ? { type: "done", conversationId, turnId: taskId }
      : { type: "error", conversationId, turnId: taskId, message: settledError ?? "The turn did not finish." });
    broadcast(state, key, turnStateEvent(conversationId, false, taskId));
    changeTurnCount(state, -1);
    // A Stop, from any surface, holds the queued message: it stays for the
    // person to take back and no later turn's end sends it.
    const queued = state.queuedMessages.get(key);
    if (queued && settledStatus === "aborted") {
      if (!queued.held) {
        changeQueuedMessage(state, key, { ...queued, held: true });
        broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId));
      }
    } else if (queued && !queued.held) void sendQueuedMessage(state, connectedFolderId, connectedFolderRoot, conversationId, queued);
    else if (settledStatus === "succeeded") scheduleBackgroundCompaction(state, connectedFolderId, connectedFolderRoot, conversationId);
    // Once this turn's own settlement is fully visible, the request
    // graph above it may owe the AmpleFile Agent one continuation turn. Fire-and-forget
    // with its own catch, the way activeTurnPromises are: a settle never
    // fails because a continuation could not start.
    queueRequestGraphSettle(state, taskId);
  }
}

const maxSettledTurnRecords = 10_000;

/**
 * The request id a Connected Folder turn names in its context: the durable request
 * record's id when the store holds one, otherwise the turn journal's own
 * acceptance identity — for an undelegated Connected Folder turn that is its own root —
 * and finally the task id for a turn accepted before either existed. Nothing
 * here invents a request id.
 */
function resolveTurnRequestId(state: LocalApiState, taskId: string): string {
  return state.requests.byTaskId(taskId)?.requestId
    ?? state.turnStore.get(taskId)?.requestId
    ?? taskId;
}

/** How long a Chat stays idle after a reply before it is summarized ahead of time. */
function backgroundCompactionIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.AMPLEFILE_PI_BACKGROUND_COMPACTION_IDLE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000;
}

/**
 * Summarizes an idle Chat in the background once it nears Pi's own automatic
 * compaction point, so the next turn does not wait on that summary. It runs
 * as its own kernel compaction task, only on a client that already exists,
 * and only after the Chat has been quiet for a moment; anything that needs the Chat first calls
 * yieldBackgroundCompaction. A failed or cancelled summary changes nothing:
 * Pi still compacts mid-turn when it must.
 */
function scheduleBackgroundCompaction(state: LocalApiState, connectedFolderId: string, connectedFolderRoot: string, conversationId: string): void {
  const key = clientKey(connectedFolderId, conversationId);
  const pending = state.backgroundCompactions.get(key);
  if (pending?.run) return;
  if (pending?.timer) clearTimeout(pending.timer);
  const entry: BackgroundCompaction = { timer: null, run: null, yielded: false };
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const client = state.clients.get(key);
    if (!client || !state.acceptingTurns || state.runningTurns.has(key) || state.compactingConversations.has(key)
      || state.capabilityMutations.size > 0 || !client.backgroundCompactionDue()) {
      if (state.backgroundCompactions.get(key) === entry) state.backgroundCompactions.delete(key);
      return;
    }
    const task = state.kernel.startTask({
      kind: "compaction",
      connectedFolderId,
      conversationId,
      actor: { kind: "system", cwd: connectedFolderRoot, connectedFolderId, conversationId },
    });
    const done = client.compact(undefined, { quiet: true })
      .catch((error: unknown) => {
        if (!entry.yielded) console.warn(`A background Chat summary did not finish: ${errorMessage(error)}`);
      })
      .finally(() => {
        state.kernel.finishTask(task.id);
        if (state.backgroundCompactions.get(key) === entry) state.backgroundCompactions.delete(key);
      });
    entry.run = { client, done };
  }, backgroundCompactionIdleMs());
  entry.timer.unref?.();
  state.backgroundCompactions.set(key, entry);
}

/** Cancels a Chat's pending or running background summary and waits for it to stop. */
export async function yieldBackgroundCompaction(state: LocalApiState, key: string): Promise<void> {
  const entry = state.backgroundCompactions.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (!entry.run) {
    state.backgroundCompactions.delete(key);
    return;
  }
  entry.yielded = true;
  entry.run.client.abortCompaction();
  await entry.run.done;
}

const appClosedTurnDetail = "AmpleFile closed before this turn finished. It was not run again because completed tools may already have changed something.";

export async function recoverDurableTurnState(state: LocalApiState): Promise<void> {
  const records = state.turnStore.list().sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  for (const record of records.filter((candidate) => candidate.status !== "accepted" && candidate.status !== "running").slice(-maxSettledTurnRecords)) {
    rememberDurableSettledTurn(state, record);
  }
  for (const record of records.filter((candidate) => candidate.status === "accepted" || candidate.status === "running")) {
    const rootPath = record.connectedFolderId === ampleFileAgentScopeId
      ? ampleFileAgentRoot()
      : await getConnectedFolder(record.connectedFolderId).then((connectedFolder) => connectedFolder.connectedFolderRoot).catch(() => null);
    if (!rootPath) {
      const settled = await state.turnStore.settle(record.turnId, {
        status: "interrupted",
        error: "The app closed before this turn finished, and its Connected Folder is no longer registered.",
      });
      if (settled) rememberDurableSettledTurn(state, settled);
      continue;
    }
    const messages = await readConversation(rootPath, record.conversationId).catch(() => []);
    const existingResponse = messages.find((message) => message.role === "assistant" && message.turnId === record.turnId);
    if (existingResponse) {
      const status = existingResponse.interruption?.reason === "cancelled"
        ? "aborted" as const
        : existingResponse.interruption ? "failed" as const : "succeeded" as const;
      const settled = await state.turnStore.settle(record.turnId, {
        status,
        messageId: existingResponse.id,
        ...(existingResponse.interruption ? { error: existingResponse.interruption.message } : {}),
      });
      if (settled) rememberDurableSettledTurn(state, settled);
      continue;
    }
    const userMessage = messages.find((message) => message.role === "user" && message.id === record.userMessageId);
    if (!userMessage) {
      const settled = await state.turnStore.settle(record.turnId, {
        status: "interrupted",
        error: "Turn acceptance was interrupted before the user message was saved.",
      });
      if (settled) rememberDurableSettledTurn(state, settled);
      continue;
    }
    const detail = appClosedTurnDetail;
    const recoveredMessage: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: record.assistantText.trim() || detail,
      createdAt: new Date().toISOString(),
      turnId: record.turnId,
      requestId: record.requestId,
      interruption: {
        reason: "app_interrupted",
        message: detail,
        retryAttempts: 0,
        provider: null,
        model: null,
        activities: [],
      },
    };
    let messageId: string | undefined;
    try {
      await appendMessage(rootPath, record.conversationId, recoveredMessage);
      messageId = recoveredMessage.id;
    } catch (error) {
      console.error(`Could not append an interrupted Worker result during startup recovery: ${errorMessage(error)}`);
    }
    const settled = await state.turnStore.settle(record.turnId, {
      status: "interrupted",
      ...(messageId ? { messageId } : {}),
      error: detail,
    });
    if (settled) rememberDurableSettledTurn(state, settled);
  }
}

function rememberDurableSettledTurn(state: LocalApiState, record: AmpleFileDurableTurnRecord): void {
  const status: SettledTurnRecord["status"] = record.status === "succeeded"
    ? "succeeded"
    : record.status === "aborted" ? "aborted" : "failed";
  state.settledTurns.set(record.turnId, {
    taskId: record.turnId,
    connectedFolderId: record.connectedFolderId,
    conversationId: record.conversationId,
    status,
    endedAt: record.updatedAt,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.error ? { error: record.error } : {}),
  });
  while (state.settledTurns.size > maxSettledTurnRecords) {
    const oldest = state.settledTurns.keys().next().value;
    if (oldest === undefined) break;
    state.settledTurns.delete(oldest);
  }
}

function settleTurnTask(
  state: LocalApiState,
  taskId: string,
  record: Omit<SettledTurnRecord, "taskId" | "endedAt">,
): void {
  state.activeTurnTasks.delete(taskId);
  state.cancelledTurnTasks.delete(taskId);
  state.settledTurns.set(taskId, { taskId, endedAt: new Date().toISOString(), ...record });
  publishControlHint(state, "activity");
  while (state.settledTurns.size > maxSettledTurnRecords) {
    const oldest = state.settledTurns.keys().next().value;
    if (oldest === undefined) break;
    state.settledTurns.delete(oldest);
  }
}

function throwIfTurnCancelled(state: LocalApiState, taskId: string): void {
  // Closing stops a turn that has not prompted yet too. Stopping clients
  // reaches only a prompt already in flight; this turn would otherwise start a
  // fresh provider request on its stopped client, and close() would wait on it.
  const reason = state.cancelledTurnTasks.has(taskId)
    ? "Agent turn cancelled by the user."
    : state.acceptingTurns ? null : "The turn stopped because AmpleFile is closing.";
  if (!reason) return;
  const error = new Error(reason);
  error.name = "PiTurnCancelledError";
  throw error;
}

function assistantTurnFailureMessage(error: unknown, partialResponsePreserved: boolean): string {
  if (isPiTurnCancelledError(error)) return "Turn cancelled.";
  if (!(error instanceof PiTurnFailure)) return assistantFailurePublicDetail(error);
  const creditFailure = providerCreditFailureDetail(error);
  if (creditFailure) return partialResponsePreserved
    ? `${creditFailure} AmpleFile saved the partial response and completed activity below.`
    : `${creditFailure} AmpleFile could not save the partial response.`;
  const retrySummary = error.retryAttempts > 0
    ? ` after ${error.retryAttempts} automatic ${error.retryAttempts === 1 ? "retry" : "retries"}`
    : "";
  return partialResponsePreserved
    ? `The model stopped responding${retrySummary}. AmpleFile saved the partial response and completed activity below.`
    : `The model stopped responding${retrySummary}, and AmpleFile could not save the partial response.`;
}

function assistantFailureReason(error: unknown): "provider_error" | "setup_error" | "assistant_error" {
  if (error instanceof PiTurnFailure) return "provider_error";
  return isModelSetupError(error) ? "setup_error" : "assistant_error";
}

function assistantFailureTranscriptContent(error: unknown, checkpointText = "", cancelled = false): string {
  const checkpoint = checkpointText.trim();
  if (error instanceof PiTurnFailure) {
    return error.partialText || checkpoint || providerCreditFailureDetail(error) || "The model stopped responding before it could finish a response.";
  }
  if (checkpoint) return checkpoint;
  if (cancelled) return "The agent was stopped before it completed a response.";
  return assistantFailurePublicDetail(error);
}

export function assistantFailurePublicDetail(error: unknown): string {
  if (error instanceof PiTurnDrainingError) return error.message;
  const creditFailure = providerCreditFailureDetail(error);
  if (creditFailure) return creditFailure;
  if (error instanceof PiTurnFailure) {
    const retrySummary = error.retryAttempts > 0
      ? ` after ${error.retryAttempts} automatic ${error.retryAttempts === 1 ? "retry" : "retries"}`
      : "";
    return `The model stopped responding${retrySummary}.`;
  }
  if (isModelSetupError(error)) {
    return "The Worker couldn’t reach an AI model. Connect an AI provider, or check the one in Settings → AI Models, then try again.";
  }
  if (isPiTurnTimeoutError(error)) {
    return `${errorMessage(error)} Raise or clear that limit to let long turns finish.`;
  }
  if (/timed?\s*out|timeout/i.test(errorMessage(error))) {
    return "The agent took too long to respond. Try again when you’re ready.";
  }
  return "The agent couldn’t complete this request. Try again. If it keeps happening, check Settings → AI Models.";
}

/** Preserve the actionable provider status without echoing its raw body, URLs or account data. */
function providerCreditFailureDetail(error: unknown): string | null {
  const message = errorMessage(error);
  const paymentRequired = /^\s*(?:HTTP(?:\/[\d.]+)?\s+)?402\b/i.test(message)
    || /"(?:code|status|statusCode)"\s*:\s*402\b/.test(message);
  if (!paymentRequired) return null;
  return "The model provider reported a credit or billing limit (HTTP 402). Check its available credit or reduce the maximum response length before trying again.";
}

export function isModelSetupError(error: unknown): boolean {
  return /api[- ]?key|credential|auth(?:entication|orization)?|no (?:available |configured )?models?|model (?:was )?not (?:found|available|configured)|select (?:a )?model|choose (?:a )?(?:provider|model)|provider .{0,40}(?:not configured|unavailable)/i
    .test(errorMessage(error));
}

async function captureTurnCheckpointSafe(
  state: LocalApiState,
  connectedFolderId: string,
  connectedFolderRoot: string,
  conversationId: string,
  reason: "pre_turn" | "post_turn",
): Promise<import("../history.js").ConnectedFolderCheckpoint | null> {
  // History is a Connected Folder concept. The AmpleFile Agent scope's root holds only
  // conversation records in app state, so turn checkpoints do not apply.
  if (connectedFolderId === ampleFileAgentScopeId) return null;
  try {
    const checkpoint = await createConnectedFolderCheckpoint(connectedFolderRoot, {
      reason,
      label: reason === "pre_turn" ? "Before turn" : "After turn",
    });
    state.onHistoryCheckpoint?.({
      connectedFolderId,
      conversationId,
      reason,
      checkpointId: checkpoint.checkpointId,
      skippedLargeFiles: checkpoint.skippedLargeFiles,
    });
    for (const listener of [...state.turnCheckpointListeners]) {
      try {
        listener({ connectedFolderId, conversationId, reason, checkpointId: checkpoint.checkpointId });
      } catch {
        // Observers never affect the turn.
      }
    }
    if (checkpoint.skippedLargeFiles.length) {
      broadcast(state, streamKey(connectedFolderId, conversationId), {
        type: "status",
        conversationId,
        message: `History skipped ${checkpoint.skippedLargeFiles.length} oversized file${checkpoint.skippedLargeFiles.length === 1 ? "" : "s"}.`,
      });
    }
    return checkpoint;
  } catch (error) {
    broadcast(state, streamKey(connectedFolderId, conversationId), {
      type: "status",
      conversationId,
      message: `History checkpoint warning: ${errorMessage(error)}`,
    });
    return null;
  }
}

function changeTurnCount(state: LocalApiState, delta: number): void {
  state.activeTurns = Math.max(0, state.activeTurns + delta);
  try {
    state.onAgentTurnActivity?.(state.activeTurns);
  } catch {
    // Desktop power/tray integration must never be able to strand a turn in
    // the server's running set if its observer fails.
  }
}
