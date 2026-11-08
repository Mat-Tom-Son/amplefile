import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTurnContextMessage, type PiConnectedFolderTurnContext } from "../src/local/agent/pi-client.js";
import { appendWorkerInstructions } from "../src/local/agent/pi-runtime-config.js";
import {
  appendConnectedFolderOperationsGuide,
  connectedFolderOperationsGuideForScope,
  ampleFileConnectedFolderOperationsGuide,
  ampleFileConnectedFolderOperationsGuideHeading,
} from "../src/local/agent/connected-folder-operations-guide.js";
import { buildConnectedFolderTurnContext, connectedFolderTurnAssignmentMaxBytes, connectedFolderTurnHistory, connectedFolderTurnParentHandle } from "../src/local/agent/connected-folder-turn-context.js";
import { startLocalApi } from "../src/local/server.js";
import { ampleFileAgentScopeId } from "../src/local/state-paths.js";

/**
 * Connected Folder turns get their own context (docs/collaboration-contract.md):
 * this Connected Folder's id, this turn's task id, its request id, and — when another
 * request delegated the work — an opaque handle plus the assignment. Never
 * another Connected Folder, the registry, the AmpleFile agent's conversation, or the parent's real
 * task id.
 */

const bannedWords = /\bstaged\b|\bapprove[sd]?\b|\bapproval\b|\bpolic(y|ies)\b|\bcard\b|\bmode\b|\bsandboxed\b|\bdigest\b/i;
const bannedNames = /\bReviewed\b|\bUnrestricted\b/;

test("a Connected Folder turn's identity block names exactly its own ids and the stay-inside rule", () => {
  const context = buildTurnContextMessage({
    connectedFolderTurn: buildConnectedFolderTurnContext({ connectedFolderId: "connected-folder-1", taskId: "task-1", requestId: "req-1", handleSalt: "salt" }),
  });
  assert.match(context, /This turn's AmpleFile identity/);
  assert.match(context, /"connectedFolderId": "connected-folder-1"/);
  assert.match(context, /"taskId": "task-1"/);
  assert.match(context, /"requestId": "req-1"/);
  assert.match(context, /A task id is accepted only while that exact turn is yours and running/);
  assert.match(context, /Work only in this Connected Folder/);
  assert.doesNotMatch(context, /"connected-folders":/, "no registry array");
  assert.doesNotMatch(context, /delegated this work/, "an undelegated turn has no parent block");
  assert.doesNotMatch(context, bannedWords);
  assert.doesNotMatch(context, bannedNames);
});

test("a delegated turn sees an opaque handle and its assignment, never the parent's task id", () => {
  const delegated = buildConnectedFolderTurnContext({
    connectedFolderId: "connected-folder-1",
    taskId: "task-1",
    requestId: "req-1",
    parentTaskId: "task-parent",
    handleSalt: "salt",
  });
  assert.match(delegated.delegated!.parentHandle, /^parent-[0-9a-f]{16}$/);
  assert.equal(delegated.delegated!.assignmentIsThisMessage, true, "the assignment defaults to this turn's own message");
  const rendered = buildTurnContextMessage({ connectedFolderTurn: delegated });
  assert.doesNotMatch(rendered, /task-parent/);
  assert.match(rendered, /Refer to it as parent-[0-9a-f]{16}; that handle is all you get, and no command takes it/);
  assert.match(rendered, /Your assignment is the message in this turn/);
  assert.match(rendered, /chat ask --to parent/);
  assert.match(rendered, /report back with chat report before your final reply, then give the complete useful answer in that reply/);

  const explicit = buildConnectedFolderTurnContext({
    connectedFolderId: "connected-folder-1",
    taskId: "task-1",
    requestId: "req-1",
    parentTaskId: "task-parent",
    assignment: "Adopt the brief and list its gaps.",
    handleSalt: "salt",
  });
  assert.equal(explicit.delegated!.assignment, "Adopt the brief and list its gaps.");
  assert.equal(explicit.delegated!.assignmentIsThisMessage, undefined);
  assert.match(buildTurnContextMessage({ connectedFolderTurn: explicit }), /Your assignment from that request:\nAdopt the brief and list its gaps\./);

  const long = buildConnectedFolderTurnContext({
    connectedFolderId: "connected-folder-1",
    taskId: "task-1",
    requestId: "req-1",
    parentTaskId: "task-parent",
    assignment: "x".repeat(connectedFolderTurnAssignmentMaxBytes + 1024),
    handleSalt: "salt",
  });
  assert.equal(Buffer.byteLength(long.delegated!.assignment!, "utf8"), connectedFolderTurnAssignmentMaxBytes, "the assignment is cut at the request record bound");
  assert.equal(long.delegated!.assignmentTruncated, true);
  assert.match(buildTurnContextMessage({ connectedFolderTurn: long }), /\[The assignment was cut at 1 MB; the full text is the first message of this Chat\.\]/);
});

test("parent handles are stable per salt, differ across salts, and refuse an empty salt", () => {
  assert.equal(connectedFolderTurnParentHandle("task-parent", "salt-a"), connectedFolderTurnParentHandle("task-parent", "salt-a"));
  assert.notEqual(connectedFolderTurnParentHandle("task-parent", "salt-a"), connectedFolderTurnParentHandle("task-parent", "salt-b"));
  assert.notEqual(connectedFolderTurnParentHandle("task-parent", "salt-a"), connectedFolderTurnParentHandle("task-other", "salt-a"));
  assert.throws(() => connectedFolderTurnParentHandle("task-parent", "   "), /non-empty salt/);
  assert.throws(() => buildConnectedFolderTurnContext({ connectedFolderId: " ", taskId: "task-1", requestId: "req-1", handleSalt: "salt" }), /Connected Folder id/);
  // The builder emits no registry field under any input.
  const keys = Object.keys(buildConnectedFolderTurnContext({ connectedFolderId: "connected-folder-1", taskId: "task-1", requestId: "req-1", parentTaskId: "p", handleSalt: "s" }));
  assert.deepEqual(keys.sort(), ["connectedFolderId", "delegated", "requestId", "taskId"]);
});

test("History turn context reports actual capture coverage and an unavailable capture honestly", () => {
  const context = buildConnectedFolderTurnContext({ connectedFolderId: "connected-folder-1", taskId: "task-1", requestId: "req-1", handleSalt: "salt" });
  context.history = connectedFolderTurnHistory({ checkpointId: "cp-test", fileCount: 4,
    skippedFiles: [{ reason: "excluded" }, { reason: "too_large" }, { reason: "excluded" }] });
  assert.deepEqual(context.history, { status: "captured", checkpointId: "cp-test", fileCount: 4,
    skippedFileCount: 3, skippedByReason: { excluded: 2, too_large: 1 } });
  const rendered = buildTurnContextMessage({ connectedFolderTurn: context });
  assert.match(rendered, /cp-test/);
  assert.match(rendered, /skipped entries are not backed up/);
  assert.deepEqual(connectedFolderTurnHistory(null), { status: "unavailable" });
  context.history = connectedFolderTurnHistory(null);
  assert.match(buildTurnContextMessage({ connectedFolderTurn: context }), /"status":"unavailable"/);
});

test("the operations guide names the verbs and the rules, stays bounded, and follows Connected Folder instructions", () => {
  const guide = ampleFileConnectedFolderOperationsGuide();
  assert.ok(guide.startsWith(ampleFileConnectedFolderOperationsGuideHeading));
  for (const verb of [
    "chat report", "chat ask", "chat answer", "chat handoff", "chat wait",
    "files delete", "history list|save|restore", "search", "help collaborate",
  ]) {
    assert.ok(guide.includes(verb), `the guide names ${verb}`);
  }
  assert.doesNotMatch(guide, /\bapps (list|invoke)\b/, "AmpleFile has no Connected Folder apps");
  assert.match(guide, /accepts a task id only while that exact turn is your own and running/);
  assert.match(guide, /not yours to read.*hand it off, or ask/s);
  assert.match(guide, /Never write cross-connected-folder context into this Chat/);
  assert.match(guide, /Direct Chat answers need no `chat report`; replies are saved/);
  assert.match(guide, /Report delegated work, requested reports, or structured data and deliverables/);
  assert.match(guide, /After all tools, including any chat report, give the complete answer as your final reply/);
  assert.match(guide, /repeat essential earlier findings/);
  assert.doesNotMatch(guide, bannedWords);
  assert.doesNotMatch(guide, bannedNames);

  const appended = appendConnectedFolderOperationsGuide(appendWorkerInstructions([], "Prefer short answers."), guide);
  assert.equal(appended.length, 3);
  assert.match(appended[0]!, /^## Worker instructions/);
  assert.equal(appended[1], guide);
  assert.match(appended[2]!, /## Worker working files/);
  assert.deepEqual(appendConnectedFolderOperationsGuide([], undefined), [], "management receives no Connected Folder scratch appendix");
  assert.equal(connectedFolderOperationsGuideForScope("connected-folder-1"), guide);
  assert.equal(connectedFolderOperationsGuideForScope(ampleFileAgentScopeId), undefined);
  assert.equal(ampleFileConnectedFolderOperationsGuide("wf").includes("`wf help collaborate`"), true, "the executable name substitutes");
});

test("the local API composes a Connected Folder turn's context from acceptance, never from the AmpleFile agent's registry", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-connected-folder-turn-context-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const events: Array<{ connectedFolderId: string; conversationId: string; taskId: string; connectedFolderTurn?: PiConnectedFolderTurnContext }> = [];
  let releaseAmpleFileAgent!: () => void;
  const ampleFileAgentGate = new Promise<void>((resolve) => { releaseAmpleFileAgent = resolve; });
  // Connected Folder turns are held only while a case needs to act inside a running one.
  const heldConnectedFolderTurns: Array<{ taskId: string; release: () => void }> = [];
  let holdConnectedFolderTurns = false;
  const releaseConnectedFolderTurn = async (taskId: string): Promise<void> => {
    await waitFor(() => heldConnectedFolderTurns.some((turn) => turn.taskId === taskId));
    heldConnectedFolderTurns.splice(heldConnectedFolderTurns.findIndex((turn) => turn.taskId === taskId), 1)[0]!.release();
  };
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    async beforeAgentPrompt(event) {
      events.push(event);
      if (event.connectedFolderId === ampleFileAgentScopeId) { await ampleFileAgentGate; return; }
      if (holdConnectedFolderTurns) await new Promise<void>((release) => heldConnectedFolderTurns.push({ taskId: event.taskId, release }));
    },
  });
  try {
    const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Brief" });
    const other = (await api.actFacade.createConnectedFolder({ name: "Elsewhere" })).connectedFolder;
    const parent = await api.actFacade.agentSend({ content: "/hold" });
    await waitFor(() => events.some((event) => event.taskId === parent.taskId));

    const delegated = await api.actFacade.sendMessage({ connectedFolder: connectedFolder.id, newConversation: true, content: "Adopt the brief.", parentTaskId: parent.taskId });
    await waitFor(() => events.some((event) => event.taskId === delegated.taskId));
    const delegatedEvent = events.find((event) => event.taskId === delegated.taskId)!;
    assert.ok(delegatedEvent.connectedFolderTurn, "a Connected Folder turn carries its identity");
    assert.equal(delegatedEvent.connectedFolderTurn!.connectedFolderId, connectedFolder.id);
    assert.equal(delegatedEvent.connectedFolderTurn!.history?.status, "captured", "actual capture reaches the prompt hook");
    const history = delegatedEvent.connectedFolderTurn!.history;
    if (history?.status === "captured") {
      // The prompt hook can precede the post-turn capture. Read History only
      // once this fixture's turn has released that operation's fence.
      await waitFor(() => !["accepted", "running"].includes(api.requests.byTaskId(delegated.taskId)!.turns[0]!.state));
      const checkpoints = await api.actFacade.historyList({ connectedFolder: connectedFolder.id });
      assert.ok(checkpoints.checkpoints.some((checkpoint) => checkpoint.checkpointId === history.checkpointId));
    }
    assert.equal(delegatedEvent.connectedFolderTurn!.taskId, delegated.taskId);
    assert.equal(delegatedEvent.connectedFolderTurn!.requestId, api.requests.byTaskId(delegated.taskId)!.requestId, "the request id is the durable record's, never invented");
    assert.match(delegatedEvent.connectedFolderTurn!.delegated!.parentHandle, /^parent-[0-9a-f]{16}$/);
    assert.notEqual(delegatedEvent.connectedFolderTurn!.delegated!.parentHandle, parent.taskId);
    assert.equal(delegatedEvent.connectedFolderTurn!.delegated!.assignmentIsThisMessage, true);
    const serialized = JSON.stringify(delegatedEvent.connectedFolderTurn);
    assert.equal(serialized.includes(other.id), false, "no other Connected Folder's id");
    assert.equal(serialized.includes(other.connectedFolderRoot), false, "no other Connected Folder's folder");
    assert.equal(serialized.includes(parent.taskId), false, "never the parent's real task id");

    const undelegated = await api.actFacade.sendMessage({ connectedFolder: connectedFolder.id, newConversation: true, content: "Just this Connected Folder." });
    await waitFor(() => events.some((event) => event.taskId === undelegated.taskId));
    const undelegatedEvent = events.find((event) => event.taskId === undelegated.taskId)!;
    assert.equal(undelegatedEvent.connectedFolderTurn!.delegated, undefined);
    assert.equal(undelegatedEvent.connectedFolderTurn!.requestId, api.requests.byTaskId(undelegated.taskId)!.requestId);

    // A continuation names the question it answers in host-built context. The
    // answer itself is an ordinary message, and a request may hold several
    // open questions, so nothing else in the turn says which one this is
    // (docs/collaboration-contract.md).
    holdConnectedFolderTurns = true;
    const asking = await api.actFacade.sendMessage({ connectedFolder: connectedFolder.id, newConversation: true, content: "/hold" });
    const asked = await api.actFacade.chatAsk({ connectedFolder: connectedFolder.id, taskId: asking.taskId, question: "Which brief?", respondent: "person" });
    await releaseConnectedFolderTurn(asking.taskId);
    await waitFor(() => api.requests.byTaskId(asking.taskId)!.turns[0]!.state !== "accepted"
      && api.requests.byTaskId(asking.taskId)!.turns[0]!.state !== "running");
    holdConnectedFolderTurns = false;
    const answered = await api.actFacade.chatAnswer({
      connectedFolder: connectedFolder.id,
      questionId: asked.question.questionId,
      answer: "The 2026 one.",
    });
    await waitFor(() => events.some((event) => event.taskId === answered.continuation.taskId));
    const continuation = events.find((event) => event.taskId === answered.continuation.taskId)!;
    assert.equal(continuation.connectedFolderTurn!.answeredQuestionId, asked.question.questionId);
    assert.equal(continuation.connectedFolderTurn!.requestId, api.requests.byTaskId(asking.taskId)!.requestId);
    assert.equal(undelegatedEvent.connectedFolderTurn!.answeredQuestionId, undefined, "an ordinary turn answers nothing");

    const ampleFileAgentEvent = events.find((event) => event.taskId === parent.taskId)!;
    assert.equal(ampleFileAgentEvent.connectedFolderTurn, undefined, "the AmpleFile agent's own turn carries no Connected Folder identity block");
  } finally {
    holdConnectedFolderTurns = false;
    for (const turn of heldConnectedFolderTurns.splice(0)) turn.release();
    releaseAmpleFileAgent();
    await api.close();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
