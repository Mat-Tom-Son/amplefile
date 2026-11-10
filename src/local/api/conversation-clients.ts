/**
 * A Chat's Pi client: building one with its tool hosts (managed worktrees,
 * collaboration, background jobs, the built-in browser), reusing it from
 * `state.clients`, and stopping clients when a Connected Folder's
 * configuration changes under them.
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { PiConversationClient, type PiChatEvent } from "../agent/pi-client.js";
import { appendMessage, type ChatMessage } from "../agent/chat-store.js";
import { AmpleFileRequestLimitError, AmpleFileRequestLineageError } from "../requests/request-records.js";
import { connectedFolderOperationsGuideForScope } from "../agent/connected-folder-operations-guide.js";
import { ampleFileAgentScopeId, ampleFileStateRoot } from "../state-paths.js";
import { ManagedWorktrees } from "../managed-worktrees.js";
import { resolveAmpleFileCliConnectedFolderSelector } from "../amplefile-cli-adapter.js";
import { getConnectedFolder, listConnectedFolders } from "../connected-folder.js";
import { createAmpleFileActFacade } from "./act-lane.js";
import { assertAmpleFileAgentInstructionsReady } from "./amplefile-agent-routes.js";
import { createBackgroundJobToolHost } from "./background-jobs.js";
import { broadcast, publishControlHint } from "./event-streams.js";
import { assertCallerHandedWorkTo, assertOwnTask } from "./request-records.js";
import { clientKey, type LocalApiState, rememberConnectedFolderRoot, streamKey } from "./state.js";
import { assistantFailurePublicDetail, isModelSetupError } from "./turn-run.js";

const managedWorktreeServices = new WeakMap<LocalApiState, ManagedWorktrees>();
export function createWorktreeToolHost(state: LocalApiState, connectedFolderId: string): import("../agent/worktree-tool.js").WorktreeToolHost {
  let service = managedWorktreeServices.get(state);
  if (!service) { service = new ManagedWorktrees(join(ampleFileStateRoot(), "worktrees"), `${ampleFileStateRoot()}-working-copies`); managedWorktreeServices.set(state, service); }
  const facade = createAmpleFileActFacade(state);
  return { async invoke(taskId, input) {
    assertOwnTask(state, connectedFolderId, taskId);
    const ports = {
      register: async (path: string) => (await facade.registerConnectedFolder({ connectedFolderRoot: path })).connectedFolder.id,
      unregister: async (id: string, path: string) => {
        if (resolve((await getConnectedFolder(id)).connectedFolderRoot) !== resolve(path)) throw new Error("The managed Connected Folder registration changed.");
        await facade.connectedFoldersUnregister({ connectedFolder: id });
      },
    };
    if (input.action === "list") return service!.list(connectedFolderId);
    await state.requests.recordAction(taskId, { command: `worktrees.${input.action}`, at: new Date().toISOString(), connectedFolderId, taskId });
    if (input.action === "create") return service!.create(connectedFolderId, (await getConnectedFolder(connectedFolderId)).connectedFolderRoot, input.ref ?? "HEAD", ports.register);
    if (!input.id) throw new Error("id is required for archive and restore.");
    return service!.change(connectedFolderId, input.id, input.action, ports);
  } };
}

function createCollaborationToolHost(state: LocalApiState, connectedFolderId: string, conversationId: string): import("../agent/collaboration-tools.js").CollaborationToolHost {
  const facade = createAmpleFileActFacade(state);
  return { async invoke(operation, taskId, input, signal) {
    assertOwnTask(state, connectedFolderId, taskId);
    const target = typeof input.connectedFolder === "string" ? input.connectedFolder : connectedFolderId;
    const required = (name: string): string => {
      const value = input[name];
      if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
      return value;
    };
    const files = Array.isArray(input.files) ? input.files as string[] : [];
    switch (operation) {
      case "children": return facade.chatChildren({ connectedFolder: connectedFolderId, taskId });
      case "handoff": return facade.chatHandoff({ connectedFolder: connectedFolderId, taskId, toConnectedFolder: target, message: required("message"), files, ...(typeof input.conversation === "string" ? { toConversationId: input.conversation } : {}) });
      case "steer": return facade.chatSteer({ connectedFolder: target, taskId, conversationId: required("conversation"), message: required("message") });
      case "copy": return facade.chatCopy({ connectedFolder: target, taskId, conversationId: typeof input.conversation === "string" ? input.conversation : conversationId, ...(typeof input.message === "string" ? { message: input.message } : {}), ...(typeof input.title === "string" ? { title: input.title } : {}) });
      case "stop": {
        const destination = resolveAmpleFileCliConnectedFolderSelector(await listConnectedFolders(), target)!;
        assertCallerHandedWorkTo(state, taskId, { connectedFolderId: destination.id, conversationId: required("conversation") });
        return facade.abortTurn({ connectedFolder: destination.id, conversationId: required("conversation") });
      }
      case "report": return facade.chatReport({ connectedFolder: connectedFolderId, taskId, summary: required("summary"), files, outcome: input.outcome as "succeeded" | "partial" | "failed", ...(input.data !== undefined ? { data: input.data } : {}) });
      case "ask": return facade.chatAsk({ connectedFolder: connectedFolderId, taskId, question: required("question"), respondent: input.to === "parent" ? "parent" : "person", ...(Array.isArray(input.options) ? { options: input.options as string[] } : {}), ...(input.asynchronous === true ? { asynchronous: true } : {}) });
      case "answer": return facade.chatAnswer({ connectedFolder: target, questionId: required("question"), answer: required("answer") });
      case "wait": {
        const followed = state.requests.byTaskId(required("task"));
        if (!followed?.owner.connectedFolderId) throw new Error("That delegated task is not on record.");
        assertCallerHandedWorkTo(state, taskId, { connectedFolderId: followed.owner.connectedFolderId, conversationId: followed.owner.conversationId });
        const seconds = input.seconds === undefined ? 30 : Number(input.seconds);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) throw new Error("seconds must be between 0 and 120.");
        const deadline = Date.now() + seconds * 1000;
        for (;;) {
          signal?.throwIfAborted();
          const status = await facade.turnStatus({ connectedFolder: followed.owner.connectedFolderId, taskId: required("task") });
          if (status.waiting || status.task.state !== "running" || Date.now() >= deadline) {
            return status.task.state === "succeeded" ? facade.turnResult({ connectedFolder: followed.owner.connectedFolderId, taskId: required("task") }) : status;
          }
          await new Promise(done => setTimeout(done, 100));
        }
      }
    }
  } };
}

export async function getClient(
  state: LocalApiState,
  connectedFolderId: string,
  connectedFolderRoot: string,
  conversationId: string,
): Promise<PiConversationClient> {
  if (connectedFolderId === ampleFileAgentScopeId) assertAmpleFileAgentInstructionsReady(state);
  const key = clientKey(connectedFolderId, conversationId);
  rememberConnectedFolderRoot(state, connectedFolderId, connectedFolderRoot);
  const existing = state.clients.get(key);
  if (existing) return existing;
  // The AmpleFile Agent scope loads personal Pi capabilities and its two app-owned
  // project instructions. It belongs to no Connected Folder.
  const hostCapabilities = connectedFolderId === ampleFileAgentScopeId
    ? undefined
    : { connectedFolderId };
  // Connected Folder scopes carry the compact operations guide after their own Connected Folder
  // instructions; the AmpleFile Agent scope has its own taught text.
  const operationsGuide = connectedFolderOperationsGuideForScope(connectedFolderId);
  const client = new PiConversationClient(conversationId, connectedFolderRoot, state.runtimeProvider, hostCapabilities, {
    role: connectedFolderId === ampleFileAgentScopeId ? "amplefile-agent" : "worker",
    async onContextCompacted() {
      const chatMessage: ChatMessage = {
        id: randomUUID(), role: "system", kind: "context_compaction",
        content: "Conversation context compacted. Earlier messages were summarized to make room; your chat history is still available.",
        createdAt: new Date().toISOString(),
      };
      await appendMessage(connectedFolderRoot, conversationId, chatMessage);
      broadcast(state, streamKey(connectedFolderId, conversationId), { type: "context_compacted", conversationId, chatMessage });
    },
    ...(operationsGuide ? { operationsGuide } : {}),
    imageModel: () => state.imageModelPreference.get(),
    // A Worker Chat shows its pictures inline; the AmpleFile Agent's panel does not yet.
    ...(connectedFolderId === ampleFileAgentScopeId ? {} : { imageStore: state.generatedImages }),
    backgroundJobs: createBackgroundJobToolHost(state, connectedFolderId, conversationId),
    ...(state.browser ? { browser: state.browser, browserOwner: `${connectedFolderId}/${conversationId}` } : {}),
    ...(connectedFolderId === ampleFileAgentScopeId ? {} : { collaboration: createCollaborationToolHost(state, connectedFolderId, conversationId) }),
    helperTool: connectedFolderId !== ampleFileAgentScopeId,
    recoveryScope: taskId => {
      const request = state.requests.byTaskId(taskId);
      if (!request || request.owner.conversationId !== conversationId
        || (request.owner.connectedFolderId ?? ampleFileAgentScopeId) !== connectedFolderId
        || !request.turns.some(turn => turn.taskId === taskId && turn.state === "running")) return null;
      return { requestId: request.requestId, taskIds: request.turns.map(turn => turn.taskId) };
    },
    ...(connectedFolderId === ampleFileAgentScopeId ? {} : { worktrees: createWorktreeToolHost(state, connectedFolderId) }),
    checklist: {
      async set({ taskId, items }) {
        try {
          const saved = await state.requests.setChecklist(taskId, items);
          // The Chat's work view re-reads the request and shows the new list.
          publishControlHint(state, "connected-folders");
          return saved;
        } catch (error) {
          if (error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError) throw new Error(error.message);
          throw error;
        }
      },
    },
  });
  client.on("event", (event: PiChatEvent) => {
    broadcast(state, streamKey(connectedFolderId, conversationId), assistantEventForRenderer(event));
  });
  state.clients.set(key, client);
  return client;
}

function assistantEventForRenderer(event: PiChatEvent): Omit<PiChatEvent, "raw"> {
  const { raw: _raw, ...safeEvent } = event;
  if (!safeEvent.message) return safeEvent;
  if (safeEvent.type === "error") {
    return { ...safeEvent, message: assistantFailurePublicDetail(new Error(safeEvent.message)) };
  }
  if (safeEvent.type === "status" && isModelSetupError(safeEvent.message)) {
    return { ...safeEvent, message: "agent setup is needed. Open Settings → AI Models." };
  }
  return safeEvent;
}

export async function invalidateAmpleFileClients(state: LocalApiState, connectedFolderId: string): Promise<void> {
  for (const [key, client] of [...state.clients]) {
    if (!key.startsWith(`${connectedFolderId}:`)) continue;
    await client.stop().catch(() => undefined);
    state.clients.delete(key);
  }
}

export async function invalidateAllClients(state: LocalApiState): Promise<void> {
  for (const [key, client] of [...state.clients]) {
    await client.stop().catch(() => undefined);
    state.clients.delete(key);
  }
}

/** Rebuilds a Chat's client that was marked while it was busy. */
export async function refreshClientIfMarked(state: LocalApiState, key: string): Promise<void> {
  if (!state.clientsToRefresh.delete(key)) return;
  const stale = state.clients.get(key);
  if (!stale) return;
  await stale.stop().catch(() => undefined);
  state.clients.delete(key);
}
