import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChatMessage, ConversationSummary } from "../src/local/agent/chat-store.js";
import { AmpleFileCliActReceipts, type AmpleFileCliActReceipt } from "../src/local/cli/act-receipts.js";
import {
  composeAmpleFileOverview,
  createAmpleFileOverviewAutomationRunReader,
  ampleFileOverviewChatRecordFromMessages,
  ampleFileOverviewChangesPerKindCap,
  ampleFileOverviewChangesTotalCap,
  ampleFileOverviewNeedsYouCap,
  ampleFileOverviewRunningCap,
  type AmpleFileOverviewChatRecord,
  type AmpleFileOverviewSourceReaders,
  type AmpleFileOverviewConnectedFolderRef,
} from "../src/local/overview.js";
import { startLocalApi } from "../src/local/server.js";

const composedAtIso = "2026-08-10T12:00:00.000Z";
const alpha: AmpleFileOverviewConnectedFolderRef = { id: "connected-folder-a", name: "Alpha", connectedFolderRoot: "/connected-folders/alpha" };
const beta: AmpleFileOverviewConnectedFolderRef = { id: "connected-folder-b", name: "Beta", connectedFolderRoot: "/connected-folders/beta" };

test("composeAmpleFileGlance is deterministic and orders every section", async () => {
  const input = () => ({
    now: new Date(composedAtIso),
    connectedFolders: [beta, alpha],
    sources: fullFixtureSources(),
    seen: {
      "remote:grant-1": "2026-08-10T09:00:00.000Z/act-receipts:req-0",
      popover: "2026-08-10T10:00:00.000Z/act-receipts:req-0",
    },
  });
  const first = await composeAmpleFileOverview(input());
  const second = await composeAmpleFileOverview(input());
  assert.equal(
    JSON.stringify(first),
    JSON.stringify(second),
    "the same recorded state and clock reading must produce a byte-identical digest",
  );

  assert.equal(first.kind, "amplefile.overview.experimental");
  assert.equal(first.version, 0);
  assert.equal(first.composedAt, composedAtIso);
  assert.deepEqual(first.truncated, { running: false, needsYou: false, changes: false });
  assert.deepEqual(first.unavailable, []);

  // Running: longest-running first, one item per AmpleFile Agent request, the
  // request's own turn and its running child folded into the headline count.
  assert.deepEqual(first.running.map((item) => item.id), [
    "agent-requests:req-mgmt",
    "kernel-tasks:task-turn",
    "kernel-tasks:task-compact",
    "automation-runs:rr-1",
  ]);
  assert.equal(first.running[0].headline, "Handling your request — 1 Worker turn running");
  assert.deepEqual(first.running[0].ref, { taskId: "task-mgmt", conversationId: "mgmt-1", requestId: "req-mgmt" });
  assert.equal(first.running[1].connectedFolderName, "Alpha");
  assert.equal(first.running[1].kind, "assistant-turn", "a plain Connected Folder turn's own root never replaces its kernel task");
  assert.ok(!first.running.some((item) => item.id === "agent-requests:req-wait"), "a waiting request is not running");
  assert.equal(first.running[3].headline, 'Automation "Weekly handoff" running');

  // Needs you: questions and due snoozes only, newest first. Nothing here is
  // an approval (docs/act-ledger.md).
  assert.deepEqual(first.needsYou.map((item) => item.id), [
    "chats:chat-s:due-snooze:2026-08-10T11:30:00.000Z",
    "agent-requests:req-wait:question:q-person",
    "chats:chat-q:question",
    "agent-requests:req-ask",
  ]);
  assert.deepEqual(new Set(first.needsYou.map((item) => item.kind)), new Set(["due-snooze", "chat-question", "request-question"]));
  assert.equal(first.needsYou[1].headline, '"Beta" is waiting on your answer');
  assert.equal(first.needsYou[1].connectedFolderName, "Beta");
  assert.deepEqual(first.needsYou[1].ref, { taskId: "task-wait", conversationId: "chat-wait", requestId: "req-wait", questionId: "q-person" });
  assert.ok(!first.needsYou.some((item) => item.ref?.questionId === "q-parent"), "a question addressed to the parent request belongs to that agent, never to the person");
  assert.equal(first.needsYou[2].headline, '"Quarterly plan" is waiting on your reply');
  assert.equal(first.needsYou[2].connectedFolderName, "Alpha");
  assert.equal(first.needsYou[3].headline, "Your request is waiting on your answer");

  // Since you last looked: newest first.
  assert.deepEqual(first.changes.map((item) => item.id), [
    "act-receipts:req-1",
    "history-checkpoints:connected-folder-a:cp-1",
    "act-receipts:req-2",
    "automation-runs:rr-0",
    "agent-requests:req-done",
    "agent-requests:req-expired",
    "settled-turns:task-old",
    "history-checkpoints:connected-folder-a:cp-2",
    "chats:chat-s:msg-snooze",
    "chats:chat-x:msg-arch",
    "chats:chat-x:msg-ren",
  ]);
  assert.equal(first.changes[4].headline, "Request done");
  assert.equal(first.changes[5].headline, "Request ran out of time");
  assert.deepEqual(first.changes[5].ref, { taskId: "task-expired", conversationId: "mgmt-1", requestId: "req-expired" });
  assert.ok(!first.changes.some((item) => item.id === "agent-requests:req-plain-old"), "a plain Connected Folder turn's settle is its turn-settled item, not a second request item");
  assert.equal(first.cursor, "2026-08-10T10:50:00.000Z/act-receipts:req-1");
  const actItem = first.changes[0];
  assert.equal(actItem.headline, "Performed files.add — restore point saved");
  assert.equal(actItem.connectedFolderName, "connected-folder-gone (removed)", "an unregistered Connected Folder renders the id plus (removed)");
  assert.deepEqual(actItem.ref, { checkpointId: "cp-9", requestId: "req-1" });
  assert.equal(first.changes[2].headline, "chat.rename failed");
  assert.equal(first.changes[3].headline, 'Automation "Weekly handoff" failed — 1/3 steps completed');
  assert.equal(first.changes[8].headline, '"Waiting" snoozed until 2026-08-10T11:30:00.000Z');
  assert.equal("checks" in first, false, "AmpleFile has no Checks: the digest has no Check rows");

  // Seen markers pass through with sorted surface keys.
  assert.deepEqual(Object.keys(first.seen), ["popover", "remote:grant-1"]);
});

/** One second apart from the start of the fixture day, so any cap fits before composition time. */
function overflowTime(index: number): string {
  return new Date(Date.parse("2026-08-10T00:00:00.000Z") + index * 1_000).toISOString();
}

test("running overflow drops the newest items and discloses truncation", async () => {
  const tasks = Array.from({ length: ampleFileOverviewRunningCap + 4 }, (_item, index) => ({
    id: `task-${String(index).padStart(4, "0")}`,
    kind: "assistant_turn" as const,
    connectedFolderId: alpha.id,
    startedAt: overflowTime(index),
  }));
  const snapshot = await composeAmpleFileOverview({
    now: new Date(composedAtIso),
    connectedFolders: [alpha],
    sources: { runningTasks: async () => tasks },
  });
  assert.equal(snapshot.running.length, ampleFileOverviewRunningCap);
  assert.equal(snapshot.truncated.running, true);
  assert.equal(snapshot.running[0].id, "kernel-tasks:task-0000", "the longest-running task must stay visible");
  assert.ok(
    !snapshot.running.some((item) => item.id === `kernel-tasks:task-${String(ampleFileOverviewRunningCap + 3).padStart(4, "0")}`),
    "overflow must drop the newest, never the oldest",
  );
});

test("needs-you overflow keeps the newest questions and states truncation", async () => {
  const chats: AmpleFileOverviewChatRecord[] = Array.from({ length: ampleFileOverviewNeedsYouCap + 2 }, (_item, index) => ({
    conversationId: `chat-${String(index).padStart(4, "0")}`,
    title: `Question ${index}`,
    archivedAt: null,
    snoozedUntil: null,
    newestMessage: { role: "assistant", createdAt: overflowTime(index), followUpPrompt: "Ready?" },
    lifecycleEvents: [],
    titleEvents: [],
  }));
  const snapshot = await composeAmpleFileOverview({
    now: new Date(composedAtIso),
    connectedFolders: [alpha],
    sources: { chats: async () => chats },
  });
  assert.equal(snapshot.needsYou.length, ampleFileOverviewNeedsYouCap);
  assert.equal(snapshot.truncated.needsYou, true);
  assert.ok(snapshot.needsYou.every((item) => item.kind === "chat-question"));
  assert.equal(snapshot.needsYou[0].id, `chats:chat-${String(ampleFileOverviewNeedsYouCap + 1).padStart(4, "0")}:question`, "the newest question comes first; overflow drops the oldest");
});

test("needs-you carries questions, request questions, and due snoozes only", async () => {
  const snapshot = await composeAmpleFileOverview({
    now: new Date(composedAtIso),
    connectedFolders: [alpha],
    sources: fullFixtureSources(),
  });
  const kinds = new Set(snapshot.needsYou.map((item) => item.kind));
  assert.deepEqual(kinds, new Set(["request-question", "chat-question", "due-snooze"]));
  assert.ok(snapshot.needsYou.every((item) => item.ref?.conversationId || item.ref?.taskId), "every needs-you item points at the conversation or request that asked");
});

test("a question addressed to the parent agent never becomes a needs-you item", async () => {
  // `chat ask --to parent` puts the asking request in state `waiting`, and a
  // waiting state maps to phase `needs_you` — but that question belongs to
  // the parent's agent, not to the person: needs-you means the person's
  // questions only (docs/amplefile-agent-overview.md).
  // The root is waiting for the same reason and must stay quiet too.
  const snapshot = await composeAmpleFileOverview({
    now: new Date(composedAtIso),
    connectedFolders: [alpha],
    sources: {
      ampleFileAgentRequests: async () => [
        {
          requestId: "req-root", kind: "agent", state: "waiting", taskId: "task-root", conversationId: "mgmt-1",
          phase: "needs_you", startedAt: "2026-08-10T09:00:00.000Z", endedAt: null, childTaskIds: ["task-child"],
          openQuestions: [], questionCount: 0, resultCount: 0,
        },
        {
          requestId: "req-child", kind: "connected-folder", state: "waiting", taskId: "task-child", conversationId: "chat-child",
          connectedFolderId: alpha.id, phase: "needs_you", startedAt: "2026-08-10T09:05:00.000Z", endedAt: null, childTaskIds: [],
          openQuestions: [{ questionId: "q-parent", respondent: "parent", askedAt: "2026-08-10T09:06:00.000Z" }],
          questionCount: 1, resultCount: 0,
        },
      ],
    },
  });
  assert.deepEqual(snapshot.needsYou, [], "nothing here is the person's to answer");

  // The same shape with the question put to the person does produce exactly
  // one item, and it carries the question id a surface reads by.
  const personAsked = await composeAmpleFileOverview({
    now: new Date(composedAtIso),
    connectedFolders: [alpha],
    sources: {
      ampleFileAgentRequests: async () => [
        {
          requestId: "req-child", kind: "connected-folder", state: "waiting", taskId: "task-child", conversationId: "chat-child",
          connectedFolderId: alpha.id, phase: "needs_you", startedAt: "2026-08-10T09:05:00.000Z", endedAt: null, childTaskIds: [],
          openQuestions: [{ questionId: "q-person", respondent: "person", askedAt: "2026-08-10T09:06:00.000Z" }],
          questionCount: 1, resultCount: 0,
        },
      ],
    },
  });
  assert.equal(personAsked.needsYou.length, 1);
  assert.equal(personAsked.needsYou[0]!.ref?.questionId, "q-person");
});

test("changes are bounded per kind and in total, newest first", async () => {
  const stamp = (index: number): string => `2026-08-10T10:${String(index).padStart(2, "0")}:00.000Z`;
  const perSource = ampleFileOverviewChangesPerKindCap + 1;
  const indexes = Array.from({ length: perSource }, (_item, index) => index);
  const snapshot = await composeAmpleFileOverview({
    now: new Date(composedAtIso),
    connectedFolders: [alpha],
    sources: {
      checkpoints: async () => indexes.map((index) => ({
        checkpointId: `cp-${index}`,
        createdAt: stamp(index),
        reason: "manual",
        scope: "full" as const,
      })),
      settledTurns: async () => indexes.map((index) => ({
        taskId: `task-${index}`,
        connectedFolderId: alpha.id,
        outcome: "succeeded" as const,
        endedAt: stamp(index),
      })),
      actReceipts: async () => indexes.map((index) => ({
        v: 3 as const,
        at: stamp(index),
        requestId: `req-${index}`,
        command: "chat.send",
        outcome: "ok" as const,
      })),
      chats: async () => [{
        conversationId: "chat-renamed-often",
        title: "Renamed often",
        archivedAt: null,
        snoozedUntil: null,
        newestMessage: null,
        lifecycleEvents: [],
        titleEvents: indexes.map((index) => ({
          messageId: `msg-${index}`,
          createdAt: stamp(index),
          title: `Title ${index}`,
          source: "manual" as const,
        })),
      }],
      automationRuns: async () => indexes.map((index) => ({
        runId: `rr-${index}`,
        automationId: "automation-1",
        state: "succeeded" as const,
        startedAt: stamp(index),
        endedAt: stamp(index),
        hops: [],
      })),
    },
  });
  assert.equal(snapshot.changes.length, ampleFileOverviewChangesTotalCap);
  assert.equal(snapshot.truncated.changes, true);
  const counts = new Map<string, number>();
  for (const item of snapshot.changes) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  for (const [kind, count] of counts) {
    assert.ok(count <= ampleFileOverviewChangesPerKindCap, `${kind} must respect the per-kind cap`);
  }
  for (let index = 1; index < snapshot.changes.length; index += 1) {
    assert.ok(
      snapshot.changes[index - 1].at >= snapshot.changes[index].at,
      "changes must render newest first",
    );
  }
  assert.ok(
    !snapshot.changes.some((item) => item.at === stamp(0)),
    "the per-kind cut drops the oldest records",
  );
});

test("restart honesty: absent readers render their kinds absent, not unavailable", async () => {
  const snapshot = await composeAmpleFileOverview({
    now: new Date(composedAtIso),
    connectedFolders: [alpha],
    sources: {
      checkpoints: async () => [{
        checkpointId: "cp-1",
        createdAt: "2026-08-10T10:00:00.000Z",
        reason: "manual",
        scope: "full" as const,
      }],
    },
  });
  assert.deepEqual(snapshot.running, []);
  assert.deepEqual(snapshot.needsYou, []);
  assert.deepEqual(snapshot.changes.map((item) => item.kind), ["checkpoint-saved"]);
  assert.deepEqual(snapshot.unavailable, [], "an absent reader is absence, never a read failure");
  assert.deepEqual(snapshot.seen, {});
  assert.equal(snapshot.cursor, "2026-08-10T10:00:00.000Z/history-checkpoints:connected-folder-a:cp-1");
});

test("a failing reader is disclosed as unavailable, never rendered as quiet", async () => {
  const snapshot = await composeAmpleFileOverview({
    now: new Date(composedAtIso),
    connectedFolders: [alpha, beta],
    sources: {
      actReceipts: async () => { throw new Error("journal damaged"); },
      checkpoints: async (connectedFolder) => {
        if (connectedFolder.id === alpha.id) throw new Error("store damaged");
        return [{
          checkpointId: "cp-b",
          createdAt: "2026-08-10T10:00:00.000Z",
          reason: "manual",
          scope: "full" as const,
        }];
      },
    },
  });
  assert.deepEqual(snapshot.unavailable, ["act-receipts", "history-checkpoints"]);
  assert.deepEqual(
    snapshot.changes.map((item) => item.id),
    ["history-checkpoints:connected-folder-b:cp-b"],
    "Connected Folders that could be read stay rendered while the failure is disclosed",
  );
});

test("chat records derive question, snooze, lifecycle, and rename semantics", async () => {
  const summary: ConversationSummary = {
    id: "chat-1",
    title: "Planning",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T10:30:00.000Z",
    archivedAt: null,
    snoozedUntil: null,
  };
  const messages: ChatMessage[] = [
    {
      id: "msg-seed",
      role: "system",
      kind: "conversation_title",
      titleSource: "placeholder",
      content: "New Chat",
      createdAt: "2026-08-10T08:00:00.000Z",
    },
    { id: "msg-user", role: "user", content: "Plan the week", createdAt: "2026-08-10T08:01:00.000Z" },
    {
      id: "msg-assistant",
      role: "assistant",
      content: "Draft ready.",
      createdAt: "2026-08-10T10:30:00.000Z",
      landing: {
        summary: "Drafted the plan.",
        nextActions: [],
        followUpPrompt: "Should I file it under reports/?",
        generatedAt: "2026-08-10T10:30:00.000Z",
        provider: "anthropic",
        model: "test-model",
      },
    },
    {
      id: "msg-snooze",
      role: "system",
      kind: "conversation_lifecycle",
      content: "Chat snoozed until 2026-08-12T09:00:00.000Z.",
      lifecycle: { snoozedUntil: "2026-08-12T09:00:00.000Z" },
      createdAt: "2026-08-10T10:40:00.000Z",
    },
    {
      id: "msg-rename",
      role: "system",
      kind: "conversation_title",
      titleSource: "manual",
      content: "Weekly planning",
      createdAt: "2026-08-10T10:45:00.000Z",
    },
  ];
  const record = ampleFileOverviewChatRecordFromMessages(summary, messages);
  assert.deepEqual(record.newestMessage, {
    role: "assistant",
    createdAt: "2026-08-10T10:30:00.000Z",
    followUpPrompt: "Should I file it under reports/?",
  }, "bookkeeping system messages never hide the newest real message");
  assert.deepEqual(record.lifecycleEvents, [{
    messageId: "msg-snooze",
    createdAt: "2026-08-10T10:40:00.000Z",
    change: "snoozed",
    snoozedUntil: "2026-08-12T09:00:00.000Z",
  }]);
  assert.deepEqual(record.titleEvents, [{
    messageId: "msg-rename",
    createdAt: "2026-08-10T10:45:00.000Z",
    title: "Weekly planning",
    source: "manual",
  }], "the creation seed title is not a rename");

  const compose = (chat: AmpleFileOverviewChatRecord, sources: AmpleFileOverviewSourceReaders = {}) =>
    composeAmpleFileOverview({
      now: new Date(composedAtIso),
      connectedFolders: [alpha],
      sources: { chats: async () => [chat], ...sources },
    });

  const active = await compose({ ...record, snoozedUntil: null });
  assert.deepEqual(active.needsYou.map((item) => item.kind), ["chat-question"]);

  const running = await compose({ ...record, snoozedUntil: null }, {
    runningTasks: async () => [{
      id: "task-1",
      kind: "assistant_turn",
      connectedFolderId: alpha.id,
      conversationId: "chat-1",
      startedAt: "2026-08-10T11:59:00.000Z",
    }],
  });
  assert.ok(
    !running.needsYou.some((item) => item.kind === "chat-question"),
    "a running Chat is not waiting on the person",
  );

  const replied = await compose({
    ...record,
    snoozedUntil: null,
    newestMessage: { role: "user", createdAt: "2026-08-10T11:00:00.000Z", followUpPrompt: null },
  });
  assert.ok(
    !replied.needsYou.some((item) => item.kind === "chat-question"),
    "the item clears when the person replies",
  );

  const archived = await compose({ ...record, archivedAt: "2026-08-10T11:00:00.000Z", snoozedUntil: null });
  assert.ok(
    !archived.needsYou.some((item) => item.kind === "chat-question" || item.kind === "due-snooze"),
    "archived Chats are structurally not waiting on the person",
  );

  const dueSnooze = await compose({ ...record, snoozedUntil: "2026-08-10T11:30:00.000Z" });
  assert.deepEqual(dueSnooze.needsYou.map((item) => item.kind), ["due-snooze"]);
  const futureSnooze = await compose({ ...record, snoozedUntil: "2026-08-11T11:30:00.000Z" });
  assert.deepEqual(futureSnooze.needsYou, [], "a future snooze is quiet by design");
});

test("tolerant automation-run reader derives runs and hop outcomes from the journal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-overview-stores-"));
  try {
    const reader = createAmpleFileOverviewAutomationRunReader({ stateRoot: sandbox });
    assert.deepEqual(await reader(), [], "a missing journal renders absent");

    await mkdir(join(sandbox, "automations"), { recursive: true });
    await writeFile(join(sandbox, "automations", "receipts.1.jsonl"), [
      JSON.stringify({ v: 1, at: "2026-08-10T09:00:00.000Z", runId: "run-old", automationId: "automation-1", scope: "run", outcome: "accepted", title: "Weekly handoff" }),
    ].join("\n"), "utf8");
    await writeFile(join(sandbox, "automations", "receipts.jsonl"), [
      JSON.stringify({ v: 1, at: "2026-08-10T09:10:00.000Z", runId: "run-old", automationId: "automation-1", scope: "run", outcome: "ok" }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:00:00.000Z", runId: "run-new", automationId: "automation-1", scope: "run", outcome: "accepted" }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:01:00.000Z", runId: "run-new", automationId: "automation-1", scope: "hop", hopId: "review", outcome: "accepted" }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:05:00.000Z", runId: "run-new", automationId: "automation-1", scope: "hop", hopId: "review", outcome: "ok" }),
      "this line is damaged",
      JSON.stringify({ v: 9, at: "2026-08-10T11:06:00.000Z", runId: "run-vnext", automationId: "automation-1", scope: "run", outcome: "accepted" }),
    ].join("\n"), "utf8");

    const runs = await reader();
    assert.deepEqual(runs, [
      {
        runId: "run-old",
        automationId: "automation-1",
        title: "Weekly handoff",
        state: "succeeded",
        startedAt: "2026-08-10T09:00:00.000Z",
        endedAt: "2026-08-10T09:10:00.000Z",
        hops: [],
      },
      {
        runId: "run-new",
        automationId: "automation-1",
        state: "running",
        startedAt: "2026-08-10T11:00:00.000Z",
        hops: [{ id: "review", state: "succeeded" }],
      },
    ], "rotated and live lines merge; damaged and unknown-version lines are skipped");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

function fullFixtureSources(): AmpleFileOverviewSourceReaders {
  return {
    runningTasks: async () => [
      { id: "task-turn", kind: "assistant_turn", connectedFolderId: "connected-folder-a", conversationId: "chat-busy", startedAt: "2026-08-10T11:00:00.000Z" },
      { id: "task-compact", kind: "compaction", connectedFolderId: "connected-folder-b", conversationId: "chat-c2", startedAt: "2026-08-10T11:05:00.000Z" },
      { id: "task-child", kind: "assistant_turn", connectedFolderId: "connected-folder-b", conversationId: "chat-child", startedAt: "2026-08-10T11:15:00.000Z" },
      { id: "task-mgmt", kind: "assistant_turn", connectedFolderId: "amplefile-agent", conversationId: "mgmt-1", startedAt: "2026-08-10T10:59:00.000Z" },
    ],
    settledTurns: async () => [
      { taskId: "task-old", connectedFolderId: "connected-folder-a", conversationId: "chat-q", outcome: "succeeded", endedAt: "2026-08-10T07:00:00.000Z" },
    ],
    // Durable requests: the AmpleFile Agent's own requests plus Connected Folder–owned ones.
    // A request is keyed by its id, which is stable across continuations.
    ampleFileAgentRequests: async () => [
      { requestId: "req-mgmt", kind: "agent", state: "working", taskId: "task-mgmt", conversationId: "mgmt-1", phase: "working", startedAt: "2026-08-10T10:59:00.000Z", endedAt: null, childTaskIds: ["task-child"], openQuestions: [], questionCount: 0, resultCount: 0 },
      { requestId: "req-ask", kind: "agent", state: "done", taskId: "task-ask", conversationId: "mgmt-1", phase: "needs_you", startedAt: "2026-08-10T09:00:00.000Z", endedAt: "2026-08-10T09:05:00.000Z", childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
      { requestId: "req-done", kind: "agent", state: "done", taskId: "task-done", conversationId: "mgmt-1", phase: "done", startedAt: "2026-08-10T08:00:00.000Z", endedAt: "2026-08-10T08:30:00.000Z", childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
      // A Connected Folder–owned request waiting on the person: one needs-you item per
      // open question addressed to the person, none for the one addressed
      // to its parent, and nothing in Running.
      {
        requestId: "req-wait", kind: "connected-folder", state: "waiting", taskId: "task-wait", conversationId: "chat-wait", connectedFolderId: "connected-folder-b", phase: "needs_you",
        startedAt: "2026-08-10T10:40:00.000Z", endedAt: null, childTaskIds: [],
        openQuestions: [
          { questionId: "q-person", respondent: "person", askedAt: "2026-08-10T10:45:00.000Z" },
          { questionId: "q-parent", respondent: "parent", askedAt: "2026-08-10T10:46:00.000Z" },
        ],
        questionCount: 2, resultCount: 0,
      },
      // A request that ran out of time settles into Since you last looked.
      { requestId: "req-expired", kind: "agent", state: "expired", taskId: "task-expired", conversationId: "mgmt-1", phase: "stopped", startedAt: "2026-08-09T07:00:00.000Z", endedAt: "2026-08-10T07:30:00.000Z", childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
      // A plain Connected Folder turn's own root: one kernel task and one settled turn
      // already describe it, so it is never listed a second time as a request.
      { requestId: "req-plain", kind: "connected-folder", state: "working", taskId: "task-turn", conversationId: "chat-busy", connectedFolderId: "connected-folder-a", phase: "working", startedAt: "2026-08-10T11:00:00.000Z", endedAt: null, childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
      { requestId: "req-plain-old", kind: "cli", state: "done", taskId: "task-old", conversationId: "chat-q", connectedFolderId: "connected-folder-a", phase: "done", startedAt: "2026-08-10T06:50:00.000Z", endedAt: "2026-08-10T07:00:00.000Z", childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
    ],
    chats: async (connectedFolder) => connectedFolder.id === "connected-folder-a" ? [
      {
        conversationId: "chat-q",
        title: "Quarterly plan",
        archivedAt: null,
        snoozedUntil: null,
        newestMessage: { role: "assistant", createdAt: "2026-08-10T10:30:00.000Z", followUpPrompt: "Ship it?" },
        lifecycleEvents: [],
        titleEvents: [],
      },
      {
        conversationId: "chat-s",
        title: "Waiting",
        archivedAt: null,
        snoozedUntil: "2026-08-10T11:30:00.000Z",
        newestMessage: { role: "user", createdAt: "2026-08-10T05:59:00.000Z", followUpPrompt: null },
        lifecycleEvents: [
          { messageId: "msg-snooze", createdAt: "2026-08-10T06:00:00.000Z", change: "snoozed", snoozedUntil: "2026-08-10T11:30:00.000Z" },
        ],
        titleEvents: [],
      },
      {
        conversationId: "chat-x",
        title: "Old",
        archivedAt: "2026-08-10T05:00:00.000Z",
        snoozedUntil: null,
        newestMessage: { role: "assistant", createdAt: "2026-08-10T04:30:00.000Z", followUpPrompt: "Still there?" },
        lifecycleEvents: [
          { messageId: "msg-arch", createdAt: "2026-08-10T05:00:00.000Z", change: "archived" },
        ],
        titleEvents: [
          { messageId: "msg-ren", createdAt: "2026-08-10T04:00:00.000Z", title: "Old", source: "manual" },
        ],
      },
    ] : [],
    checkpoints: async (connectedFolder) => connectedFolder.id === "connected-folder-a" ? [
      { checkpointId: "cp-1", createdAt: "2026-08-10T10:45:00.000Z", label: "Before cleanup", reason: "manual", scope: "full" },
      { checkpointId: "cp-2", createdAt: "2026-08-10T06:30:00.000Z", reason: "mutation", scope: "targeted" },
    ] : [],
    actReceipts: async (): Promise<AmpleFileCliActReceipt[]> => [
      { v: 3, at: "2026-08-10T10:50:00.000Z", requestId: "req-1", command: "files.add", connectedFolderId: "connected-folder-gone", outcome: "ok", checkpointId: "cp-9" },
      { v: 3, at: "2026-08-10T10:20:00.000Z", requestId: "req-2", command: "chat.rename", connectedFolderId: "connected-folder-a", outcome: "error", errorCode: "conflict" },
      { v: 3, at: "2026-08-10T10:55:00.000Z", requestId: "req-3", command: "chat.send", outcome: "accepted" },
    ],
    automationRuns: async () => [
      { runId: "rr-1", automationId: "automation-1", title: "Weekly handoff", state: "running", startedAt: "2026-08-10T11:25:00.000Z", hops: [] },
      {
        runId: "rr-0",
        automationId: "automation-1",
        title: "Weekly handoff",
        state: "failed",
        startedAt: "2026-08-10T09:00:00.000Z",
        endedAt: "2026-08-10T09:10:00.000Z",
        hops: [
          { id: "review", state: "succeeded" },
          { id: "handoff", state: "failed" },
          { id: "verify", state: "skipped" },
        ],
      },
    ],
  };
}

test("the local API wires the overview's live-registry readers end to end", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-overview-server-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 150)),
    });
  }\n`, "utf8");
  // State an older build left behind when desktop-served sharing existed: its
  // publication store and the receipts of a share. Both stay inert; the
  // receipts are ordinary ledger history.
  const stateRoot = join(sandbox, "state");
  await mkdir(join(stateRoot, "shared-pages"), { recursive: true });
  await writeFile(join(stateRoot, "shared-pages", "publications.json"), JSON.stringify({
    version: 1,
    publications: [{ publicationId: "pub-old", connectedFolderId: "connected-folder-old", title: "Old page", createdAt: "2026-08-10T10:00:00.000Z", state: "active" }],
  }), "utf8");
  const oldReceipts = new AmpleFileCliActReceipts({ stateRoot });
  await oldReceipts.append({ requestId: "req-old-share", command: "pages.share", outcome: "accepted" });
  await oldReceipts.append({
    requestId: "req-old-share",
    command: "pages.share",
    outcome: "ok",
    surface: "cli",
    detail: "publish.viewer.expose; source notes.md; publication pub-old",
    undoRef: { kind: "publicationId", value: "pub-old" },
  });
  // Likewise what an earlier build with Checks left behind: its machine-local
  // Check state stays on disk unread, and its act receipts are ordinary
  // ledger history.
  const oldCheckState = join(stateRoot, "checks", "connected-folders", "space-old-0123456789abcdef.json");
  await mkdir(join(stateRoot, "checks", "connected-folders"), { recursive: true });
  await writeFile(oldCheckState, "{\"schemaVersion\":1,\"declarations\":[]}", "utf8");
  await oldReceipts.append({ requestId: "req-old-check", command: "checks.run", outcome: "accepted" });
  await oldReceipts.append({ requestId: "req-old-check", command: "checks.run", outcome: "ok", surface: "cli", detail: "check run accepted" });
  const api = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;
    const connectedFolder = await facade.createConnectedFolder({ name: "Glanced" });

    // Recorded chat activity: a settled turn, a rename, an archive.
    const chat = await facade.createConversation({ connectedFolder: connectedFolder.connectedFolder.id });
    const turn = await facade.sendMessage({ connectedFolder: connectedFolder.connectedFolder.id, conversationId: chat.conversation.id, content: "/hold" });
    await waitForCondition(async () =>
      (await facade.turnStatus({ connectedFolder: connectedFolder.connectedFolder.id, taskId: turn.taskId })).task.state !== "running");
    await facade.chatRename({ connectedFolder: connectedFolder.connectedFolder.id, conversationId: chat.conversation.id, title: "Renamed by hand" });
    await facade.chatArchive({ connectedFolder: connectedFolder.connectedFolder.id, conversationId: chat.conversation.id });

    // History leaves recorded state behind.
    const saved = await facade.historySave({ connectedFolder: connectedFolder.connectedFolder.id, label: "Milestone" });
    const pending = await api.kernel.getOverview({ kind: "system" });
    assert.equal(pending.kind, "amplefile.overview.experimental");
    assert.deepEqual(pending.unavailable, [], "every wired source reads cleanly");
    assert.ok(
      pending.needsYou.every((item) => item.kind === "request-question" || item.kind === "chat-question" || item.kind === "due-snooze"),
      "needs-you carries questions and due snoozes only",
    );
    const changeKinds = new Set(pending.changes.map((item) => item.kind));
    for (const expected of [
      "checkpoint-saved",
      "turn-settled",
      "chat-renamed",
      "chat-lifecycle",
      "act-performed",
    ] as const) {
      assert.ok(changeKinds.has(expected), `changes include ${expected}`);
    }
    const checkpointItem = pending.changes.find((item) =>
      item.kind === "checkpoint-saved" && item.ref?.checkpointId === saved.checkpoint.checkpointId);
    assert.equal(checkpointItem?.connectedFolderName, "Glanced", "Connected Folder names resolve on per-connected-folder items");

    // The act-receipts ledger reader surfaces the older build's share
    // receipt as ordinary history; its leftover publication store adds nothing.
    assert.ok(
      pending.changes.some((item) => item.kind === "act-performed" && item.ref?.requestId === "req-old-share"),
      "a receipt for a removed verb still reads as a performed act",
    );
    assert.ok(
      pending.changes.some((item) => item.kind === "act-performed" && item.ref?.requestId === "req-old-check"),
      "a receipt for a removed Check verb still reads as a performed act",
    );
    assert.ok(
      !pending.changes.some((item) => item.id.startsWith("viewer-grants:")),
      "a leftover publication store is never read",
    );
    assert.ok(pending.cursor, "recorded changes produce a cursor for seen markers");
  } finally {
    await api.close();
    assert.equal(await readFile(oldCheckState, "utf8"), "{\"schemaVersion\":1,\"declarations\":[]}", "old Check state is left on disk untouched");
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function waitForCondition(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}
