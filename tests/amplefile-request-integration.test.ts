import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";

import { appendMessage } from "../src/local/agent/chat-store.js";
import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { AmpleFileTurnStore } from "../src/local/agent/turn-store.js";
import { AmpleFileRequestStore } from "../src/local/requests/request-store.js";
import { startLocalApi } from "../src/local/server.js";
import { ampleFileAgentScopeId } from "../src/local/state-paths.js";

/**
 * Durable requests through the local API (docs/collaboration-contract.md,
 * F25): every accepted turn creates or joins a request record, a Connected Folder turn
 * with no parent is its own root, a delegated send is a child under the
 * AmpleFile agent request, a person's reply joins the request that was waiting on
 * it, and the records survive a restart — reconciled against the turn
 * journal, never replayed.
 */

async function sandboxApi(t: { after: (fn: () => unknown) => void }, stateBase?: string) {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-request-integration-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 200)),
    });
  }\n`, "utf8");
  const provider = { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } };
  const open = (gate?: (event: { connectedFolderId: string; taskId: string }) => Promise<void>) => startLocalApi({
    port: 0,
    stateBase: stateBase ?? join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: provider,
    ...(gate ? { beforeAgentPrompt: gate } : {}),
  });
  return { sandbox, open };
}

test("every accepted turn creates or joins a request record, and a Connected Folder turn with no parent is its own root", async (t) => {
  const { open } = await sandboxApi(t);
  const api = await open();
  try {
    const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Roots" });
    const chat = await api.actFacade.createConversation({ connectedFolder: connectedFolder.id });

    // The renderer's Connected Folder Chat route: kind `connected-folder`, its own root.
    const rendererResponse = await fetch(new URL(`/api/connected-folders/${connectedFolder.id}/conversations/${chat.conversation.id}/messages`, api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/hold", contextPaths: [], selectedPath: null }),
    });
    assert.equal(rendererResponse.status, 202);
    const renderer = await rendererResponse.json() as { taskId: string };
    const connectedFolderRoot = api.requests.byTaskId(renderer.taskId);
    assert.ok(connectedFolderRoot, "a renderer Connected Folder turn has a request record");
    assert.equal(connectedFolderRoot!.kind, "connected-folder");
    assert.equal(connectedFolderRoot!.surface, "renderer");
    assert.equal(connectedFolderRoot!.rootId, connectedFolderRoot!.requestId);
    assert.equal(connectedFolderRoot!.depth, 0);
    assert.equal(connectedFolderRoot!.parentTaskId, null);
    assert.deepEqual(connectedFolderRoot!.owner, { connectedFolderId: connectedFolder.id, connectedFolderName: "Roots", conversationId: chat.conversation.id });
    assert.equal(connectedFolderRoot!.turns[0]!.role, "origin");
    await waitFor(async () => (await api.actFacade.turnStatus({ connectedFolder: connectedFolder.id, taskId: renderer.taskId })).task.state !== "running");
    const settledRoot = api.requests.byTaskId(renderer.taskId)!;
    assert.equal(settledRoot.state, "done");
    assert.equal(settledRoot.turns[0]!.state, "succeeded");
    assert.equal(settledRoot.usage.turns, 0, "an extension command runs no model, so nothing was spent and nothing is invented");
    assert.ok(settledRoot.settledAt);

    // `agent send` from the CLI: kind `agent`, surface `cli`.
    const agent = await api.actFacade.agentSend({ content: "/hold" });
    const ampleFileAgentRootPath = api.requests.byTaskId(agent.taskId)!;
    assert.equal(ampleFileAgentRootPath.kind, "agent");
    assert.equal(ampleFileAgentRootPath.surface, "cli");
    assert.deepEqual(ampleFileAgentRootPath.owner, { conversationId: agent.conversationId });

    // The popover route: kind `agent`, surface `popover`.
    const popoverResponse = await fetch(new URL("/api/amplefile-agent/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/hold", newConversation: true }),
    });
    assert.equal(popoverResponse.status, 202);
    const popover = await popoverResponse.json() as { taskId: string };
    assert.equal(api.requests.byTaskId(popover.taskId)!.surface, "popover");

    // `chat send` without a parent: kind `cli`, its own root.
    const plain = await api.actFacade.sendMessage({ connectedFolder: connectedFolder.id, newConversation: true, content: "/hold" });
    const cliRoot = api.requests.byTaskId(plain.taskId)!;
    assert.equal(cliRoot.kind, "cli");
    assert.equal(cliRoot.surface, "cli");
    assert.equal(cliRoot.rootId, cliRoot.requestId);

    // `chat send --parent-task`: a child under the AmpleFile agent request's root.
    await waitFor(async () => (await api.actFacade.agentTurnStatus({ taskId: agent.taskId })).task.state !== "running");
    const held = await api.actFacade.agentSend({ content: "/hold", newConversation: true });
    const child = await api.actFacade.sendMessage({ connectedFolder: connectedFolder.id, newConversation: true, content: "/hold", parentTaskId: held.taskId });
    const childRecord = api.requests.byTaskId(child.taskId)!;
    const parentRecord = api.requests.byTaskId(held.taskId)!;
    assert.equal(childRecord.rootId, parentRecord.requestId);
    assert.equal(childRecord.parentRequestId, parentRecord.requestId);
    assert.equal(childRecord.parentTaskId, held.taskId);
    assert.equal(childRecord.depth, 1);
    assert.deepEqual(api.requests.get(parentRecord.requestId)!.childRequestIds, [childRecord.requestId]);
    assert.equal((await api.actFacade.agentTurnStatus({ taskId: held.taskId })).request!.children[0]!.taskId, child.taskId);

    // The overview reads the same records: the AmpleFile agent's request is running work.
    const overview = await api.kernel.getOverview({ kind: "system" });
    assert.ok(overview.running.some((item) => item.id === `agent-requests:${parentRecord.requestId}`), "an AmpleFile agent request is one running item");
    assert.ok(!overview.running.some((item) => item.id === `agent-requests:${cliRoot.requestId}`), "a plain Connected Folder turn's root is not a second running item");
    await waitFor(async () => (await api.actFacade.agentTurnStatus({ taskId: held.taskId })).request!.children.every((item) => item.state !== "running"));
  } finally {
    await api.close();
  }
});

test("a person's reply joins the request that was waiting on it and answers its question", async (t) => {
  const { open } = await sandboxApi(t);
  let releaseAmpleFileAgentTurn!: () => void;
  const ampleFileAgentTurnGate = new Promise<void>((resolve) => { releaseAmpleFileAgentTurn = resolve; });
  const api = await open(async (event) => {
    if (event.connectedFolderId === ampleFileAgentScopeId) await ampleFileAgentTurnGate;
  });
  try {
    const first = await api.actFacade.agentSend({ content: "/hold" });
    const record = api.requests.byTaskId(first.taskId)!;
    // The agent asks the person while its turn is live (F27); the turn
    // then ends and the request waits on the answer.
    const question = await api.requests.ask({ requestId: record.requestId, taskId: first.taskId, respondent: "person", text: "Which quarter?" });
    releaseAmpleFileAgentTurn();
    await waitFor(async () => (await api.actFacade.agentTurnStatus({ taskId: first.taskId })).task.state !== "running");
    const waiting = (await api.actFacade.agentTurnStatus({ taskId: first.taskId })).request!;
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.phase, "needs_you");
    assert.equal(waiting.questions[0]!.questionId, question.questionId);
    const overview = await api.kernel.getOverview({ kind: "system" });
    assert.ok(overview.needsYou.some((item) => item.ref?.questionId === question.questionId), "the open question is in Needs you");
    assert.ok(!overview.running.some((item) => item.id === `agent-requests:${record.requestId}`), "a waiting request is not running");

    // The reply through the popover route joins the same record — one story,
    // two turns — and is the question's one answer.
    const reply = await fetch(new URL("/api/amplefile-agent/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The reply is an extension command so the continuation turn needs no model here.
      body: JSON.stringify({ content: "/hold", conversationId: first.conversationId, continuationTaskId: first.taskId }),
    });
    assert.equal(reply.status, 202);
    const continued = await reply.json() as { taskId: string };
    const joined = api.requests.byTaskId(continued.taskId)!;
    assert.equal(joined.requestId, record.requestId, "the reply joined the waiting request");
    assert.equal(joined.turns.length, 2);
    assert.equal(joined.turns[1]!.role, "continuation");
    assert.equal(joined.continuedFromTaskId, first.taskId);
    assert.equal(api.requests.list({ kind: "agent" }).length, 1, "no second record");
    const answered = api.requests.question(question.questionId)!;
    assert.equal(answered.state, "answered");
    assert.equal(answered.answer, "/hold", "the reply's text is the recorded answer");
    assert.equal(answered.continuationTaskId, continued.taskId);
    // Either task id resolves to the one request, whose view names its newest turn.
    const viaOld = await fetch(new URL(`/api/amplefile-agent/requests/${first.taskId}`, api.origin));
    assert.equal(viaOld.status, 200);
    const view = (await viaOld.json() as { request: { taskId: string; requestId: string } }).request;
    assert.equal(view.requestId, record.requestId);
    assert.equal(view.taskId, continued.taskId);
    await waitFor(async () => (await api.actFacade.agentTurnStatus({ taskId: continued.taskId })).task.state !== "running");
    assert.equal(api.requests.get(record.requestId)!.state, "done");
  } finally {
    releaseAmpleFileAgentTurn();
    await api.close();
  }
});

test("parent synthesis preserves a partial child graph despite its latest succeeded report", async (t) => {
  const { open } = await sandboxApi(t);
  const pending = new Map<string, () => void>();
  let draining = false;
  const api = await open(async ({ taskId }) => {
    if (!draining) await new Promise<void>((resolve) => pending.set(taskId, resolve));
  });
  const originalPrompt = PiConversationClient.prototype.prompt;
  // Generated follow-ups still use the real turn path, but the fixture's
  // extension command lets them complete without a provider connection.
  PiConversationClient.prototype.prompt = function (_message, context) {
    return originalPrompt.call(this, "/hold", context);
  };
  const release = async (taskId: string) => {
    await waitFor(async () => pending.has(taskId));
    pending.get(taskId)!();
    pending.delete(taskId);
  };
  const settleConnectedFolderTurn = async (connectedFolderId: string, taskId: string) => {
    await waitFor(async () => (await api.actFacade.turnStatus({ connectedFolder: connectedFolderId, taskId })).task.state !== "running");
  };
  try {
    const { connectedFolder: coordinator } = await api.actFacade.createConnectedFolder({ name: "Coordinator" });
    const { connectedFolder: reviewer } = await api.actFacade.createConnectedFolder({ name: "Reviewer" });
    const root = await api.actFacade.agentSend({ content: "/hold" });
    const child = await api.actFacade.sendMessage({ connectedFolder: coordinator.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    const grandchild = await api.actFacade.sendMessage({ connectedFolder: reviewer.id, newConversation: true, content: "/hold", parentTaskId: child.taskId });
    await api.actFacade.chatReport({ connectedFolder: reviewer.id, taskId: grandchild.taskId, summary: "Some review items remain", outcome: "partial", files: [] });
    await release(grandchild.taskId);
    await settleConnectedFolderTurn(reviewer.id, grandchild.taskId);
    await release(child.taskId);
    await settleConnectedFolderTurn(coordinator.id, child.taskId);

    const childRequestId = api.requests.byTaskId(child.taskId)!.requestId;
    await waitFor(async () => api.requests.get(childRequestId)!.turns.length === 2);
    const childFollowup = api.requests.get(childRequestId)!.turns.at(-1)!.taskId;
    await api.actFacade.chatReport({ connectedFolder: coordinator.id, taskId: childFollowup, summary: "Coordinator finished its own work", outcome: "succeeded", files: [] });
    await release(childFollowup);
    await settleConnectedFolderTurn(coordinator.id, childFollowup);
    const partialChild = api.requests.get(childRequestId)!;
    assert.equal(partialChild.state, "partial", "the descendant's incomplete work remains part of the child result");
    assert.equal(partialChild.results.at(-1)!.outcome, "succeeded");

    await release(root.taskId);
    await waitFor(async () => (await api.actFacade.agentTurnStatus({ taskId: root.taskId })).task.state !== "running");
    const rootRequestId = api.requests.byTaskId(root.taskId)!.requestId;
    await waitFor(async () => api.requests.get(rootRequestId)!.turns.length === 2);
    const parentFollowup = api.requests.get(rootRequestId)!;
    assert.match(parentFollowup.content, /partial: Coordinator finished its own work/);
    assert.doesNotMatch(parentFollowup.content, /succeeded: Coordinator finished its own work/);
    assert.deepEqual(parentFollowup.deliveredChildTaskIds, [childFollowup]);
    // Read after the follow-up, so the read itself is not the delivery.
    assert.equal((await api.actFacade.turnResult({ connectedFolder: coordinator.id, taskId: childFollowup })).result?.outcome, "partial");
  } finally {
    draining = true;
    for (const resolve of pending.values()) resolve();
    pending.clear();
    try {
      await api.close();
    } finally {
      PiConversationClient.prototype.prompt = originalPrompt;
    }
  }
});

test("requests survive a restart: settled ones keep their projection and an orphaned one reconciles without rerunning", async (t) => {
  const { sandbox, open } = await sandboxApi(t);
  const stateRoot = join(sandbox, "state");
  const first = await open();
  let connectedFolderId: string;
  let conversationId: string;
  let connectedFolderRoot: string;
  let doneTaskId: string;
  let doneRequestId: string;
  try {
    const created = await first.actFacade.createConnectedFolder({ name: "Recovery" });
    connectedFolderId = created.connectedFolder.id;
    connectedFolderRoot = created.connectedFolder.connectedFolderRoot;
    conversationId = (await first.actFacade.createConversation({ connectedFolder: connectedFolderId })).conversation.id;
    const agent = await first.actFacade.agentSend({ content: "/hold" });
    doneTaskId = agent.taskId;
    doneRequestId = first.requests.byTaskId(agent.taskId)!.requestId;
    await waitFor(async () => (await first.actFacade.agentTurnStatus({ taskId: agent.taskId })).task.state !== "running");
  } finally {
    await first.close();
  }

  // A Connected Folder root request whose turn was running when the app closed: the
  // turn journal says running, the transcript has the user message, and
  // nothing ever produced a reply.
  const turnStore = await AmpleFileTurnStore.create({ stateRoot });
  const accepted = await turnStore.accept({
    requestId: "request-orphan",
    requestDigest: createHash("sha256").update("orphan").digest("hex"),
    userMessageId: "message-orphan",
    userMessageCreatedAt: "2026-09-11T12:00:00.000Z",
    connectedFolderId,
    conversationId,
    actorKind: "assistant",
  });
  await appendMessage(connectedFolderRoot, conversationId, {
    id: "message-orphan",
    role: "user",
    content: "Do not run this twice.",
    createdAt: "2026-09-11T12:00:00.000Z",
    turnId: accepted.record.turnId,
    requestId: "request-orphan",
  });
  await turnStore.markRunning(accepted.record.turnId);
  const requestStore = await AmpleFileRequestStore.open({ rootPath: join(stateRoot, "requests") });
  const orphan = await requestStore.beginRoot({
    kind: "connected-folder",
    owner: { connectedFolderId, connectedFolderName: "Recovery", conversationId },
    surface: "renderer",
    taskId: accepted.record.turnId,
    content: "Do not run this twice.",
  });
  await requestStore.markTurnRunning(accepted.record.turnId);
  await requestStore.flush();

  const restarted = await open();
  try {
    // The settled AmpleFile agent request is still there, with the same id and projection.
    const status = await restarted.actFacade.agentTurnStatus({ taskId: doneTaskId });
    assert.equal(status.task.state, "succeeded");
    assert.equal(status.request?.requestId, doneRequestId);
    assert.equal(status.request?.phase, "done");
    assert.equal(status.request?.state, "done");
    assert.equal(status.request?.reply?.content, "Command completed.");

    // The orphan reconciled from the turn journal: failed, marked as
    // recovered at startup, and never dispatched again.
    const reconciled = restarted.requests.get(orphan.requestId)!;
    assert.equal(reconciled.state, "failed");
    assert.equal(reconciled.turns[0]!.state, "interrupted", "the turn journal's own outcome is copied, never overridden");
    assert.ok(reconciled.reconciledAt, "a request settled at startup says so, so nothing continues it");
    assert.match(reconciled.turns[0]!.error ?? "", /closed before this turn finished/);
    const transcript = await fetch(new URL(`/api/connected-folders/${connectedFolderId}/conversations/${conversationId}`, restarted.origin));
    const messages = (await transcript.json() as { messages: Array<{ role: string; turnId?: string; interruption?: { reason: string } }> }).messages;
    const replies = messages.filter((message) => message.role === "assistant" && message.turnId === accepted.record.turnId);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.interruption?.reason, "app_interrupted");
    const tasks = await restarted.kernel.getTasks({ kind: "system" });
    assert.equal(tasks.tasks.some((task) => task.id === accepted.record.turnId), false, "the orphan is not running again");
    assert.ok(
      (await restarted.kernel.getOverview({ kind: "system" })).running.every((item) => item.ref?.taskId !== accepted.record.turnId),
      "the overview shows no running work for the recovered turn",
    );
  } finally {
    await restarted.close();
  }
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
