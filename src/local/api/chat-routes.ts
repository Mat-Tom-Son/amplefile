import { stopComputerSharingForScope } from "./computer-sharing.js";
/**
 * A Connected Folder's Chat routes, and the Chat changes they share with the
 * act lane: deleting a Chat into Recently Deleted, Make a Copy, and the
 * wrapper that refuses to change a busy Chat.
 */

import { createLocalEventSink } from "../local-event-stream.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { copyPiConversationSession } from "../agent/pi-client.js";
import {
  appendMessage,
  conversationsDir,
  createConversation,
  listConversations,
  readConversation,
  readConversationSummary,
  renameConversation,
  updateConversationLifecycle,
  type ConversationSummary,
} from "../agent/chat-store.js";
import { previewConversationContextReference } from "../conversation-context.js";
import type { AmpleFileRecentlyDeletedEntry } from "../recently-deleted-store.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import {
  getConnectedFolder,
  resolveConnectedFolderPath,
  registeredConnectedFolderOutline,
  type ConnectedFolderSummary,
} from "../connected-folder.js";
import { getClient, refreshClientIfMarked } from "./conversation-clients.js";
import { broadcast, openChatStream, publishControlHint } from "./event-streams.js";
import { normalizeConnectedFolderRelativePath } from "./file-changes.js";
import { badRequest, errorMessage, httpError, match, notFound, readJsonBody, sendJson } from "./http.js";
import { runDesktopSettingsAct } from "./prepared-act-adapters.js";
import { queueConversationRequestEvaluation, stopAmpleFileAgentRequest } from "./request-routes.js";
import { assertNoCapabilityMutationForTurn, requestHasUnsettledWork } from "./reservations.js";
import { clientKey, type LocalApiRequest, type LocalApiState, rememberConnectedFolderRoot, streamKey } from "./state.js";
import {
  acceptConversationTurn,
  cancelQueuedMessage,
  changeQueuedMessage,
  optionalTurnIdentity,
  queueChatMessage,
  steerConversationTurn,
} from "./turn-acceptance.js";
import { yieldBackgroundCompaction } from "./turn-run.js";

/** A Connected Folder's Chats: listing, creating, changing, and deleting them, their runtime, context attachments, event stream, queue, messages, Stop, Make a Copy, and compaction. */
export async function handleChatRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  const conversationsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations$/);
  if (conversationsMatch && method === "GET") {
    const connectedFolder = await getConnectedFolder(conversationsMatch[1]);
    sendJson(res, { conversations: await listConversations(connectedFolder.connectedFolderRoot) });
    return true;
  }
  if (conversationsMatch && method === "POST") {
    const connectedFolder = await getConnectedFolder(conversationsMatch[1]);
    const body = await readJsonBody<{ conversationId?: unknown }>(state, req);
    const conversationId = body.conversationId === undefined
      ? undefined
      : conversationIdentity(body.conversationId);
    const conversation = conversationId === undefined
      ? await createConversation(connectedFolder.connectedFolderRoot)
      : await runConversationMutation(state, connectedFolder.id, conversationId, () =>
        createConversation(connectedFolder.connectedFolderRoot, undefined, conversationId));
    sendJson(res, { conversation }, 201);
    return true;
  }

  const conversationMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)$/);
  if (conversationMatch && (method === "PUT" || method === "PATCH")) {
    const connectedFolder = await getConnectedFolder(conversationMatch[1]);
    const conversationId = conversationMatch[2];
    const body = await readJsonBody<{ title?: string; archived?: boolean; snoozedUntil?: string | null }>(state, req);
    const changes = [
      body.title !== undefined,
      body.archived !== undefined,
      body.snoozedUntil !== undefined,
    ].filter(Boolean).length;
    if (changes !== 1) throw badRequest("Change exactly one Chat title, archive state, or snooze time.");
    if (body.title !== undefined && typeof body.title !== "string") throw badRequest("Chat title must be text.");
    if (body.archived !== undefined && typeof body.archived !== "boolean") throw badRequest("Archived state must be true or false.");
    if (body.snoozedUntil !== undefined && body.snoozedUntil !== null) {
      if (typeof body.snoozedUntil !== "string" || !Number.isFinite(Date.parse(body.snoozedUntil))) {
        throw badRequest("Snooze time is invalid.");
      }
      if (Date.parse(body.snoozedUntil) <= Date.now()) throw badRequest("Choose a future snooze time.");
    }
    const conversation = await runConversationMutation(state, connectedFolder.id, conversationId, async () => {
      if (body.archived === true) await stopComputerSharingForScope(state, connectedFolder.connectedFolderRoot, connectedFolder.id, conversationId);
      const updated = body.title !== undefined
        ? await renameConversation(connectedFolder.connectedFolderRoot, conversationId, body.title)
        : await updateConversationLifecycle(connectedFolder.connectedFolderRoot, conversationId, {
            ...(body.archived !== undefined ? { archived: body.archived } : {}),
            ...(body.snoozedUntil !== undefined ? { snoozedUntil: body.snoozedUntil } : {}),
          });
      if (body.title !== undefined) state.clients.get(clientKey(connectedFolder.id, conversationId))?.setSessionName(updated.title);
      return updated;
    });
    sendJson(res, { conversation });
    return true;
  }
  if (conversationMatch && method === "DELETE") {
    const connectedFolder = await getConnectedFolder(conversationMatch[1]);
    const deleted = await runDesktopSettingsAct(state, "chats.delete", async (requestId) => {
      const value = await deleteConnectedFolderConversation(state, connectedFolder, conversationMatch[2], { receiptId: requestId });
      return { value, detail: `Connected Folder ${connectedFolder.id}; conversation ${value.conversationId}; trash ${value.recentlyDeleted.entryId}` };
    });
    sendJson(res, { deleted: deleted.value });
    return true;
  }

  const conversationRuntimeMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/runtime$/);
  if (conversationRuntimeMatch && method === "GET") {
    const connectedFolder = await getConnectedFolder(conversationRuntimeMatch[1]);
    const conversationId = conversationRuntimeMatch[2];
    if (!(await readConversation(connectedFolder.connectedFolderRoot, conversationId)).length) throw notFound("Conversation not found.");
    const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, conversationId);
    sendJson(res, { runtime: await client.getState() });
    return true;
  }

  const conversationThinkingMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/thinking$/);
  if (conversationThinkingMatch && method === "POST") {
    const connectedFolder = await getConnectedFolder(conversationThinkingMatch[1]);
    const conversationId = conversationThinkingMatch[2];
    if (!(await readConversation(connectedFolder.connectedFolderRoot, conversationId)).length) throw notFound("Conversation not found.");
    const body = await readJsonBody<{ level?: unknown }>(state, req);
    if (typeof body.level !== "string" || !body.level.trim()) throw badRequest("A thinking level is required.");
    const key = clientKey(connectedFolder.id, conversationId);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current agent turn to finish before changing the thinking level.");
    const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, conversationId);
    let result: { level: string; available: string[] };
    try {
      result = await client.setThinkingLevel(body.level);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    sendJson(res, { thinking: result, runtime: await client.getState() });
    return true;
  }

  const contextAttachmentMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/context-attachments$/);
  if (contextAttachmentMatch && method === "POST") {
    const connectedFolder = await getConnectedFolder(contextAttachmentMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("A file path is required.");
    sendJson(res, { attachment: await previewConversationContextReference(connectedFolder.connectedFolderRoot, { path: body.path }) }, 201);
    return true;
  }

  const eventsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/events$/);
  if (method === "GET" && eventsMatch) {
    const connectedFolder = await getConnectedFolder(eventsMatch[1]);
    rememberConnectedFolderRoot(state, connectedFolder.id, connectedFolder.connectedFolderRoot);
    openChatStream(state, createLocalEventSink(res), eventsMatch[1], eventsMatch[2], req.headers["last-event-id"]);
    return true;
  }
  const queueMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/queue$/);
  if (queueMatch && (method === "PUT" || method === "DELETE")) {
    const connectedFolder = await getConnectedFolder(queueMatch[1]);
    if (!(await readConversationSummary(connectedFolder.connectedFolderRoot, queueMatch[2]))) throw notFound("Conversation not found.");
    if (method === "DELETE") {
      sendJson(res, cancelQueuedMessage(state, connectedFolder.id, queueMatch[2]));
      return true;
    }
    const body = await readJsonBody<{ content?: string; contextPaths?: string[]; addressedConnectedFolderIds?: unknown }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    const contextPaths = normalizeContextPaths(connectedFolder.connectedFolderRoot, body.contextPaths);
    // Workers the message addresses with @ travel with it, as on the ordinary message route.
    const addressedConnectedFolderIds = await normalizeAddressedConnectedFolderIds(body.addressedConnectedFolderIds, connectedFolder.id);
    sendJson(res, queueChatMessage(state, connectedFolder.id, queueMatch[2], { content, contextPaths, addressedConnectedFolderIds }));
    return true;
  }
  const messagesPostMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/messages$/);
  if (method === "POST" && messagesPostMatch) {
    const connectedFolder = await getConnectedFolder(messagesPostMatch[1]);
    const conversationId = messagesPostMatch[2];
    const body = await readJsonBody<{
      content?: string;
      contextPaths?: string[];
      /** Ignored: the file selected in Files never reaches the Worker. */
      selectedPath?: unknown;
      requestId?: unknown;
      userMessageId?: unknown;
      delivery?: unknown;
      addressedConnectedFolderIds?: unknown;
    }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    if (body.delivery !== undefined && body.delivery !== "steer") throw badRequest("Message delivery must be \"steer\" when present.");
    if (body.delivery === "steer") {
      const steered = await steerConversationTurn(state, connectedFolder, conversationId, {
        content,
        requestId: optionalTurnIdentity(body.requestId, "requestId"),
        userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
      });
      sendJson(res, { accepted: true, delivery: "steer", message: steered.message, taskId: steered.taskId, replayed: steered.replayed }, 202);
      return true;
    }
    const contextPaths = normalizeContextPaths(connectedFolder.connectedFolderRoot, body.contextPaths);
    const addressedConnectedFolderIds = await normalizeAddressedConnectedFolderIds(body.addressedConnectedFolderIds, connectedFolder.id);
    const { message, taskId, replayed } = await acceptConversationTurn(state, connectedFolder, conversationId, {
      content,
      contextPaths,
      actorKind: "assistant",
      ...(addressedConnectedFolderIds.length ? { addressedConnectedFolderIds } : {}),
      requestId: optionalTurnIdentity(body.requestId, "requestId"),
      userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
    });
    sendJson(res, { accepted: true, message, taskId, replayed }, 202);
    return true;
  }
  const abortMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/abort$/);
  if (method === "POST" && abortMatch) {
    const connectedFolder = await getConnectedFolder(abortMatch[1]);
    const key = clientKey(connectedFolder.id, abortMatch[2]);
    const client = state.clients.get(key);
    const request = state.requests.latestForConversation(abortMatch[2], { connectedFolderId: connectedFolder.id });
    if (request) {
      const stopped = await stopAmpleFileAgentRequest(state, request.turns.at(-1)!.taskId);
      sendJson(res, { aborted: stopped.ampleFileAgentAborted || stopped.children.some((child) => child.aborted), stopped });
    } else sendJson(res, { aborted: client ? await client.abort() : false });
    return true;
  }

  // Make a Copy: a new Chat with this one's history as of its
  // last finished reply. The same copy the act lane's `chat copy` makes.
  const copyMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/copy$/);
  if (method === "POST" && copyMatch) {
    const connectedFolder = await getConnectedFolder(copyMatch[1]);
    const body = await readJsonBody<{ title?: unknown }>(state, req);
    const copied = await copyConversation(state, connectedFolder, copyMatch[2], typeof body.title === "string" ? body.title : undefined);
    publishControlHint(state, "connected-folders");
    sendJson(res, { conversation: copied.conversation, copiedMessages: copied.copiedMessages });
    return true;
  }

  const compactMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/compact$/);
  if (method === "POST" && compactMatch) {
    const connectedFolder = await getConnectedFolder(compactMatch[1]);
    if (!(await readConversation(connectedFolder.connectedFolderRoot, compactMatch[2])).length) throw notFound("Conversation not found.");
    const key = clientKey(connectedFolder.id, compactMatch[2]);
    const body = await readJsonBody<{ customInstructions?: string }>(state, req);
    await yieldBackgroundCompaction(state, key);
    assertNoCapabilityMutationForTurn(state, connectedFolder.id);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current agent turn to finish.");
    if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
    state.compactingConversations.add(key);
    const task = state.kernel.startTask({
      kind: "compaction",
      connectedFolderId: connectedFolder.id,
      conversationId: compactMatch[2],
      actor: { kind: "assistant", cwd: connectedFolder.connectedFolderRoot, connectedFolderId: connectedFolder.id, conversationId: compactMatch[2] },
    });
    try {
      const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, compactMatch[2]);
      await client.compact(body.customInstructions?.trim() || undefined);
      broadcast(state, streamKey(connectedFolder.id, compactMatch[2]), { type: "done", conversationId: compactMatch[2] });
    } finally {
      state.compactingConversations.delete(key);
      await refreshClientIfMarked(state, key);
      state.kernel.finishTask(task.id);
      queueConversationRequestEvaluation(state, connectedFolder.id, compactMatch[2]);
    }
    sendJson(res, { compacted: true });
    return true;
  }
  const messagesGetMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)$/);
  if (method === "GET" && messagesGetMatch) {
    const connectedFolder = await getConnectedFolder(messagesGetMatch[1]);
    sendJson(res, { messages: await readConversation(connectedFolder.connectedFolderRoot, messagesGetMatch[2]) });
    return true;
  }
  return false;
}

function conversationIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw badRequest("conversationId is invalid.");
  }
  return value;
}

/**
 * A Worker Chat's transcript is portable `.amplefile/` metadata, which History
 * never captures, so deletion moves the exact validated transcript into
 * Recently deleted. The Pi session stays in machine-local state, so a restored
 * Chat resumes where it was. It deliberately never accepts a path.
 */
async function deleteConnectedFolderConversation(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  conversationId: string,
  context: { receiptId: string | null },
): Promise<{ conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } }> {
  const key = clientKey(connectedFolder.id, conversationId);
  await yieldBackgroundCompaction(state, key);
  changeQueuedMessage(state, key, null);
  if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current turn to finish.");
  if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  // The same conflict fence compaction uses: a transcript move must not race
  // a new turn, rename, lifecycle change, or real compaction.
  state.compactingConversations.add(key);
  try {
    const summary = await readConversationSummary(connectedFolder.connectedFolderRoot, conversationId).catch((error) => {
      throw badRequest(errorMessage(error));
    });
    if (!summary) throw notFound("Conversation not found.");
    if (state.requests.list().some((request) =>
      request.owner.connectedFolderId === connectedFolder.id
      && request.owner.conversationId === conversationId
      && requestHasUnsettledWork(state, request))) {
      throw httpError(409, "Finish or stop this Chat's outstanding work before deleting it.");
    }
    await stopComputerSharingForScope(state, connectedFolder.connectedFolderRoot, connectedFolder.id, conversationId);
    await state.clients.get(key)?.stop();
    // `readConversationSummary` validated the id before this join.
    const relativePath = `.amplefile/conversations/${conversationId}.jsonl`;
    const sourcePath = join(conversationsDir(connectedFolder.connectedFolderRoot), `${conversationId}.jsonl`);
    let entry: AmpleFileRecentlyDeletedEntry;
    try {
      entry = await state.recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: "file",
        reason: "chats.delete",
        sourcePath,
        connectedFolderId: connectedFolder.id,
        connectedFolderName: connectedFolder.name,
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

/** Reserve every transcript mutation through its final write, including CLI writes and restores. */
export async function runConversationMutation<T>(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = clientKey(connectedFolderId, conversationId);
  if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current turn to finish.");
  if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  state.compactingConversations.add(key);
  try {
    return await operation();
  } finally {
    state.compactingConversations.delete(key);
  }
}

/**
 * Copies a Chat as of its last finished reply into a new Chat in the same
 * Connected Folder (`chat copy`): the visible transcript up to that
 * reply, and the Pi session along the same path, so the copy starts with the
 * same context. Copied messages get new ids and lose their turn and request
 * identities, which belong to the original Chat; the original is never
 * written. A turn still running in the original is left out.
 */
export async function copyConversation(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  sourceConversationId: string,
  title?: string,
): Promise<{ conversation: ConversationSummary; copiedMessages: number }> {
  await yieldBackgroundCompaction(state, clientKey(connectedFolder.id, sourceConversationId));
  const summary = await readConversationSummary(connectedFolder.connectedFolderRoot, sourceConversationId);
  if (!summary) throw new AmpleFileCliError("notFound", "Conversation not found.");
  if (state.compactingConversations.has(clientKey(connectedFolder.id, sourceConversationId))) {
    throw new AmpleFileCliError("conflict", "That Chat is being compacted. Copy it once that finishes.");
  }
  const messages = await readConversation(connectedFolder.connectedFolderRoot, sourceConversationId);
  const lastReply = messages.reduce((found, message, index) => message.role === "assistant" ? index : found, -1);
  const carried = messages.slice(0, lastReply + 1).filter((message) => message.role !== "system");
  const forkTitle = (title?.trim() || `${summary.title} (copy)`).slice(0, 200);
  const conversation = await createConversation(connectedFolder.connectedFolderRoot, forkTitle);
  for (const message of carried) {
    const { turnId: _turnId, requestId: _requestId, delivery: _delivery, ...content } = message;
    await appendMessage(connectedFolder.connectedFolderRoot, conversation.id, { ...content, id: randomUUID() });
  }
  if (carried.length) {
    await copyPiConversationSession({
      connectedFolderRoot: connectedFolder.connectedFolderRoot,
      runtimeProvider: state.runtimeProvider,
      sourceConversationId,
      targetConversationId: conversation.id,
    });
  }
  return { conversation: (await readConversationSummary(connectedFolder.connectedFolderRoot, conversation.id)) ?? conversation, copiedMessages: carried.length };
}

/**
 * The Connected Folder Workers a person addressed with @: at most eight
 * distinct registered Connected Folder ids in a stable order, never the sending scope's
 * own. An id that is no longer registered is dropped rather than refused, so a
 * retried send still replays after a Connected Folder was removed.
 */
export async function normalizeAddressedConnectedFolderIds(value: unknown, ownScopeId: string): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 512)) {
    throw badRequest("addressedConnectedFolderIds must be a list of Connected Folder ids.");
  }
  const ids = [...new Set((value as string[]).map((item) => item.trim()))].filter((id) => id !== ownScopeId);
  if (!ids.length) return [];
  const registered = new Set((await registeredConnectedFolderOutline()).map((connectedFolder) => connectedFolder.id));
  return ids.filter((id) => registered.has(id)).sort();
}

function normalizeContextPaths(connectedFolderRoot: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw badRequest("Chat context paths must be an array of strings.");
  const paths = [...new Set(value.map((item) => normalizeConnectedFolderRelativePath(item)).filter(Boolean))];
  for (const path of paths) {
    try { resolveConnectedFolderPath(connectedFolderRoot, path); } catch (error) { throw badRequest(errorMessage(error)); }
  }
  return paths;
}
