/**
 * An Extension's questions to a person in a Chat: routing a Pi Extension's UI
 * requests and events to that Chat's streams, the pending requests a window
 * shows, and a person's answer. Pending requests live in
 * `state.extensionRequests`.
 */

import {
  type PiExtensionUiEvent,
  type PiExtensionUiRequest,
  type PiExtensionUiScope,
  type PiExtensionUiResponse,
  validateExtensionUiResponse,
} from "../agent/extension-ui.js";
import type { AmpleFileRequestRecord } from "../requests/request-records.js";
import { ampleFileAgentRoot, ampleFileAgentScopeId } from "../state-paths.js";
import { getConnectedFolder } from "../connected-folder.js";
import { broadcast, maxChatStreamQueuedBytes, writeSseData } from "./event-streams.js";
import { badRequest, errorMessage, match, notFound, readJsonBody, sendJson } from "./http.js";
import { connectedFolderIdForRoot, connectedFolderRootKey, type LocalApiRequest, type LocalApiState, streamKey } from "./state.js";

/** An Extension's questions to a person in a Chat: the pending ones, and an answer. */
export async function handleExtensionUiRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  const extensionResponseMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/extension-ui(?:\/([^/]+))?$/);
  const ampleFileAgentExtensionMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/extension-ui(?:\/([^/]+))?$/);
  if ((extensionResponseMatch || ampleFileAgentExtensionMatch) && (method === "GET" || method === "POST")) {
    const scope: PiExtensionUiScope = extensionResponseMatch
      ? { connectedFolderRoot: (await getConnectedFolder(extensionResponseMatch[1])).connectedFolderRoot, conversationId: extensionResponseMatch[2] }
      : { connectedFolderRoot: ampleFileAgentRoot(), conversationId: ampleFileAgentExtensionMatch![1] };
    const id = extensionResponseMatch?.[3] ?? ampleFileAgentExtensionMatch?.[2];
    if (!id && method === "GET") {
      sendJson(res, { requests: extensionSnapshot(state, scope) });
      return true;
    }
    if (!id || method !== "POST") throw notFound("Extension request not found.");
    const body = await readJsonBody<{ value?: unknown; cancelled?: boolean }>(state, req);
    const accepted = answerExtensionRequest(state, scope, id, body);
    sendJson(res, { accepted });
    return true;
  }
  return false;
}

function extensionScopeId(state: LocalApiState, scope: PiExtensionUiScope): string | null {
  return connectedFolderRootKey(scope.connectedFolderRoot) === connectedFolderRootKey(ampleFileAgentRoot())
    ? ampleFileAgentScopeId : connectedFolderIdForRoot(state, scope.connectedFolderRoot);
}

function sameExtensionScope(left: PiExtensionUiScope, right: PiExtensionUiScope): boolean {
  return connectedFolderRootKey(left.connectedFolderRoot) === connectedFolderRootKey(right.connectedFolderRoot) && left.conversationId === right.conversationId;
}

function remoteExtensionRequests(state: LocalApiState, record: AmpleFileRequestRecord): Array<Record<string, unknown>> {
  const taskId = record.turns.at(-1)?.taskId;
  if (!taskId || record.owner.connectedFolderId || record.stopRequestedAt || record.state === "expired" || state.cancelledTurnTasks.has(taskId)
      || state.activeTurnIdsByKey.get(streamKey(ampleFileAgentScopeId, record.owner.conversationId)) !== taskId) return [];
  return [...state.extensionRequests.values()].filter((request) => request.taskId === taskId
    && sameExtensionScope(request, { connectedFolderRoot: ampleFileAgentRoot(), conversationId: record.owner.conversationId })
    && !(request.method === "input" && request.secret))
    .map((request) => ({ ...rendererExtensionRequest(request), taskId }));
}

function rendererExtensionRequest(request: PiExtensionUiRequest): Record<string, unknown> {
  return {
    id: request.id, method: request.method, title: request.title,
    ...(request.method === "confirm" ? { message: request.message } : {}),
    ...(request.method === "select" ? { options: request.options } : {}),
    ...(request.method === "input" && request.placeholder ? { placeholder: request.placeholder } : {}),
    ...(request.method === "input" && request.secret ? { secret: true } : {}),
    ...(request.method === "editor" && request.prefill ? { initialValue: request.prefill } : {}),
  };
}

export function extensionSnapshot(state: LocalApiState, scope: PiExtensionUiScope): Array<Record<string, unknown>> {
  return [...state.extensionRequests.values()].filter((request) => sameExtensionScope(request, scope)).map(rendererExtensionRequest);
}

/** Transient interactions never enter the replay log or portable transcript. */
export function publishExtensionSnapshot(state: LocalApiState, scope: PiExtensionUiScope): void {
  publishTransientExtensionEvent(state, scope, { type: "extension_ui_snapshot", conversationId: scope.conversationId, requests: extensionSnapshot(state, scope) });
}

/** Desktop UI only: no durable log and no in-process listeners. */
function publishTransientExtensionEvent(state: LocalApiState, scope: PiExtensionUiScope, event: unknown): void {
  const scopeId = extensionScopeId(state, scope);
  if (!scopeId) return;
  const streams = state.chatStreams.get(streamKey(scopeId, scope.conversationId));
  for (const response of [...streams ?? []]) {
    try {
      if (response.closed || response.queuedBytes > maxChatStreamQueuedBytes) {
        response.close(); streams?.delete(response);
      } else writeSseData(response, event);
    } catch { streams?.delete(response); }
  }
}

export function routeExtensionRequest(state: LocalApiState, request: PiExtensionUiRequest): void {
  const scopeId = extensionScopeId(state, request);
  if (!scopeId) {
    state.extensionUi.cancel(request.id);
    return;
  }
  if (request.taskId && state.activeTurnIdsByKey.get(streamKey(scopeId, request.conversationId)) !== request.taskId) {
    state.extensionUi.cancel(request.id);
    return;
  }
  state.extensionRequests.set(request.id, request);
  publishExtensionSnapshot(state, request);
}

function answerExtensionRequest(state: LocalApiState, scope: PiExtensionUiScope, id: string, body: { value?: unknown; cancelled?: unknown }): boolean {
  const request = state.extensionRequests.get(id);
  if (!request || !sameExtensionScope(request, scope)) throw notFound("Extension question has ended or belongs to another Chat.");
  if (body.cancelled !== undefined && typeof body.cancelled !== "boolean") throw badRequest("cancelled must be a boolean.");
  const response: PiExtensionUiResponse = body.cancelled === true ? { cancelled: true }
    : request.method === "confirm" ? { confirmed: body.value as boolean } : { value: body.value as string };
  try { validateExtensionUiResponse(request, response); }
  catch (error) { throw badRequest(errorMessage(error)); }
  return state.extensionUi.respond(request.id, response);
}

export function routeExtensionEvent(state: LocalApiState, event: PiExtensionUiEvent): void {
  const connectedFolderId = extensionScopeId(state, event);
  if (!connectedFolderId) return;
  if (event.method === "oauthDeviceCode" || event.method === "openExternal") {
    publishTransientExtensionEvent(state, event, { type: "status", conversationId: event.conversationId, message: extensionEventMessage(event) });
    return;
  }
  if (event.method === "notify") {
    broadcast(state, streamKey(connectedFolderId, event.conversationId), {
      type: "extension_ui_request",
      conversationId: event.conversationId,
      request: { id: event.id, method: "notify", message: event.message },
    });
    return;
  }
  if (event.method === "setEditorText" || event.method === "pasteToEditor") {
    broadcast(state, streamKey(connectedFolderId, event.conversationId), {
      type: "editor",
      conversationId: event.conversationId,
      editorMode: event.method === "setEditorText" ? "replace" : "append",
      text: event.text,
    });
    return;
  }
  const message = extensionEventMessage(event);
  if (message) broadcast(state, streamKey(connectedFolderId, event.conversationId), { type: "status", conversationId: event.conversationId, message });
}

function extensionEventMessage(event: PiExtensionUiEvent): string | null {
  if (event.method === "setStatus") return event.text ?? null;
  if (event.method === "setWorkingMessage") return event.message ?? null;
  if (event.method === "setWorkingVisible") return event.visible ? "Extension is working…" : null;
  if (event.method === "setWorkingIndicator") return event.options ? "Extension is working…" : null;
  if (event.method === "setTitle") return event.title;
  if (event.method === "openExternal") return `Extension requested: ${event.url}`;
  if (event.method === "oauthDeviceCode") return `Open ${event.verificationUri} and enter ${event.userCode}.`;
  if (event.method === "unsupported") return `Extension UI feature is not available here: ${event.feature}`;
  return null;
}
