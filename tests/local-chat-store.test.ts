import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  appendMessage,
  conversationNeedsGeneratedTitle,
  conversationsDir,
  createConversation,
  listConversations,
  markConversationTitleAttempted,
  readConversation,
  renameConversation,
  setGeneratedConversationTitle,
  updateConversationLifecycle,
  type ChatMessage,
} from "../src/local/agent/chat-store.js";
import { configureAmpleFileStateRoot, connectedFolderStateDir } from "../src/local/state-paths.js";

const chatStateRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-state-"));
configureAmpleFileStateRoot(chatStateRoot);
after(async () => {
  configureAmpleFileStateRoot(undefined);
  await rm(chatStateRoot, { recursive: true, force: true });
});

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: "user",
    content,
    createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}Z`,
  };
}

test("chat store appends messages without rewriting the conversation log", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-append-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  await Promise.all(
    Array.from({ length: 20 }, (_, index) => appendMessage(connectedFolderRoot, "chat-concurrent", message(String(index), `message ${index}`))),
  );

  const messages = await readConversation(connectedFolderRoot, "chat-concurrent");
  assert.equal(messages.length, 20);
  assert.deepEqual(new Set(messages.map((item) => item.id)), new Set(Array.from({ length: 20 }, (_, index) => String(index))));
});

test("chat store rejects unsafe conversation ids", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-safe-id-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => appendMessage(connectedFolderRoot, "../outside", message("1", "escape attempt")),
    /Invalid conversation id/,
  );
  await assert.rejects(
    () => readConversation(connectedFolderRoot, "nested/chat"),
    /Invalid conversation id/,
  );
});

test("chat store skips malformed JSONL lines without deleting the transcript", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-malformed-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const dir = conversationsDir(connectedFolderRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "chat-malformed.jsonl");
  const systemLine = JSON.stringify({ id: "system", role: "system", content: "Project chat", createdAt: "2026-01-01T00:00:00Z" });
  const userLine = JSON.stringify(message("1", "valid user message"));
  const original = `${systemLine}\nnot json\n${userLine}\n{"id":"bad","role":"unknown","content":"bad","createdAt":"2026-01-01T00:00:02Z"}\n`;
  await writeFile(path, original, "utf8");

  assert.deepEqual(await readConversation(connectedFolderRoot, "chat-malformed"), [
    { id: "system", role: "system", content: "Project chat", createdAt: "2026-01-01T00:00:00Z" },
    message("1", "valid user message"),
  ]);

  const summaries = await listConversations(connectedFolderRoot);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.id, "chat-malformed");
  assert.equal(summaries[0]?.title, "New Chat");
  assert.equal(await readFile(path, "utf8"), original);
});

test("chat store keeps new appends readable after an unterminated malformed line", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-unterminated-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const dir = conversationsDir(connectedFolderRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "chat-unterminated.jsonl"), "truncated", "utf8");

  await appendMessage(connectedFolderRoot, "chat-unterminated", message("2", "after corruption"));

  assert.deepEqual(await readConversation(connectedFolderRoot, "chat-unterminated"), [
    message("2", "after corruption"),
  ]);
});

test("chat store preserves assistant landing metadata", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-landing-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const assistantMessage: ChatMessage = {
    id: "assistant-1",
    role: "assistant",
    content: "Completed the requested review.",
    createdAt: "2026-01-01T00:00:01Z",
    landing: {
      summary: "The agent completed the requested review.",
      nextActions: ["Review the draft output", "Confirm the open question"],
      followUpPrompt: "Show me the open question.",
      conversationTitle: "Draft Review Follow-up",
      generatedAt: "2026-01-01T00:00:02Z",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
  };

  await appendMessage(connectedFolderRoot, "chat-landing", assistantMessage);

  assert.deepEqual(await readConversation(connectedFolderRoot, "chat-landing"), [assistantMessage]);
});

test("chat store preserves interrupted assistant output and completed activity", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-interruption-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const assistantMessage: ChatMessage = {
    id: "assistant-interrupted-1",
    role: "assistant",
    content: "I inspected the manuscript and found",
    createdAt: "2026-01-01T00:00:01Z",
    interruption: {
      reason: "provider_error",
      message: "Provider returned an error while streaming.",
      retryAttempts: 3,
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      activities: [{
        message: "Read complete",
        detail: "manuscript/chapter-one.md",
        toolName: "read",
        phase: "complete",
      }],
    },
  };

  await appendMessage(connectedFolderRoot, "chat-interrupted", assistantMessage);

  assert.deepEqual(await readConversation(connectedFolderRoot, "chat-interrupted"), [assistantMessage]);
});

test("chat store preserves bounded thinking and tool trails on successful replies", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-work-trail-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const assistantMessage: ChatMessage = {
    id: "assistant-work-trail-1",
    role: "assistant",
    content: "The file is ready.",
    createdAt: "2026-01-01T00:00:01Z",
    workTrail: [
      { kind: "thinking", text: "I should inspect the requested file.", phase: "complete" },
      { kind: "tool", text: "Read complete", detail: "notes.md", toolName: "read", phase: "complete" },
    ],
  };

  await appendMessage(connectedFolderRoot, "chat-work-trail", assistantMessage);
  assert.deepEqual(await readConversation(connectedFolderRoot, "chat-work-trail"), [assistantMessage]);

  await appendMessage(connectedFolderRoot, "chat-invalid-work-trail", {
    ...assistantMessage,
    id: "assistant-invalid-work-trail",
    workTrail: [{ kind: "thinking", text: "x".repeat(32_001), phase: "complete" }],
  });
  const [sanitized] = await readConversation(connectedFolderRoot, "chat-invalid-work-trail");
  assert.equal(sanitized?.workTrail, undefined);

  // Reasoning a model keeps hidden has no text, so its duration is what the
  // trail keeps; without a duration the empty entry is not a trail at all.
  const timedTrail: ChatMessage["workTrail"] = [
    { kind: "thinking", text: "", phase: "complete", durationMs: 2_600 },
    { kind: "tool", text: "Read complete", detail: "notes.md", toolName: "read", phase: "complete" },
  ];
  await appendMessage(connectedFolderRoot, "chat-timed-work-trail", { ...assistantMessage, id: "assistant-timed-work-trail", workTrail: timedTrail });
  const [timed] = await readConversation(connectedFolderRoot, "chat-timed-work-trail");
  assert.deepEqual(timed?.workTrail, timedTrail);

  await appendMessage(connectedFolderRoot, "chat-untimed-hidden-thinking", {
    ...assistantMessage,
    id: "assistant-untimed-hidden-thinking",
    workTrail: [{ kind: "thinking", text: "", phase: "complete" }],
  });
  const [untimed] = await readConversation(connectedFolderRoot, "chat-untimed-hidden-thinking");
  assert.equal(untimed?.workTrail, undefined);
});

test("chat store prefers generated landing title in conversation summaries", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-title-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  await appendMessage(connectedFolderRoot, "chat-title", message("1", "Can you inspect the notes in this folder and summarize the open questions?"));
  await appendMessage(connectedFolderRoot, "chat-title", {
    id: "assistant-1",
    role: "assistant",
    content: "Completed the requested review.",
    createdAt: "2026-01-01T00:00:02Z",
    landing: {
      summary: "The agent completed the requested review.",
      nextActions: [],
      followUpPrompt: null,
      conversationTitle: "Folder Notes Review",
      generatedAt: "2026-01-01T00:00:03Z",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
  });

  const summaries = await listConversations(connectedFolderRoot);
  assert.equal(summaries[0]?.title, "Folder Notes Review");
});

test("new Chat placeholder does not override its generated landing title", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-created-title-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const created = await createConversation(connectedFolderRoot);
  await appendMessage(connectedFolderRoot, created.id, message("1", "Plan a garden event rain fallback."));
  await appendMessage(connectedFolderRoot, created.id, {
    id: "assistant-1",
    role: "assistant",
    content: "The rain plan is ready.",
    createdAt: "2026-01-01T00:00:02Z",
    landing: {
      summary: "The agent prepared a rain plan.",
      nextActions: [],
      followUpPrompt: null,
      conversationTitle: "Garden Event Rain Plan",
      generatedAt: "2026-01-01T00:00:03Z",
      provider: "openrouter",
      model: "z-ai/glm-5.2",
    },
  });

  const summaries = await listConversations(connectedFolderRoot);
  assert.equal(summaries[0]?.title, "Garden Event Rain Plan");
});

test("an intentional later rename to New Chat remains authoritative", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-new-chat-rename-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const created = await createConversation(connectedFolderRoot);
  await appendMessage(connectedFolderRoot, created.id, message("1", "Review this draft."));
  const renamed = await renameConversation(connectedFolderRoot, created.id, "New Chat");

  assert.equal(renamed.title, "New Chat");
});

test("generated title persists after the first successful turn without overriding later manual renames", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-generated-title-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const created = await createConversation(connectedFolderRoot);
  await appendMessage(connectedFolderRoot, created.id, message("1", "Review the launch checklist and identify missing owners."));
  const generated = await setGeneratedConversationTitle(connectedFolderRoot, created.id, "Review the launch checklist");
  assert.equal(generated.title, "Review the launch checklist");
  assert.equal(
    (await readConversation(connectedFolderRoot, created.id)).filter((item) => item.titleSource === "generated").length,
    1,
  );

  await setGeneratedConversationTitle(connectedFolderRoot, created.id, "A different generated title");
  const renamed = await renameConversation(connectedFolderRoot, created.id, "Launch owner review");
  await setGeneratedConversationTitle(connectedFolderRoot, created.id, "A third generated title");
  assert.equal(renamed.title, "Launch owner review");
  assert.equal((await listConversations(connectedFolderRoot))[0]?.title, "Launch owner review");
});

test("a failed first title request stays New Chat and is not repeated", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-title-attempt-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const created = await createConversation(connectedFolderRoot);
  await appendMessage(connectedFolderRoot, created.id, message("1", "Please give this conversation a useful title."));
  assert.equal(conversationNeedsGeneratedTitle(await readConversation(connectedFolderRoot, created.id)), true);

  const attempted = await markConversationTitleAttempted(connectedFolderRoot, created.id);
  assert.equal(attempted.title, "New Chat");
  const transcript = await readConversation(connectedFolderRoot, created.id);
  assert.equal(transcript.filter((item) => item.titleSource === "attempted").length, 1);
  assert.equal(conversationNeedsGeneratedTitle(transcript), false);

  await markConversationTitleAttempted(connectedFolderRoot, created.id);
  assert.equal((await readConversation(connectedFolderRoot, created.id)).filter((item) => item.titleSource === "attempted").length, 1);
});

test("a model title may legitimately match the first user message after the request is recorded", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-title-matches-request-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const created = await createConversation(connectedFolderRoot);
  const request = "Fix chat naming";
  await appendMessage(connectedFolderRoot, created.id, message("1", request));
  await markConversationTitleAttempted(connectedFolderRoot, created.id);

  const generated = await setGeneratedConversationTitle(connectedFolderRoot, created.id, request);
  assert.equal(generated.title, request);
  assert.equal(conversationNeedsGeneratedTitle(await readConversation(connectedFolderRoot, created.id)), false);
});

test("a generated first-message title remains visible and authoritative", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-first-message-title-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const created = await createConversation(connectedFolderRoot);
  const request = "hey, what's up what do you think of my game here in this space?";
  await appendMessage(connectedFolderRoot, created.id, message("1", request));
  await appendMessage(connectedFolderRoot, created.id, {
    id: "old-fallback",
    role: "system",
    kind: "conversation_title",
    titleSource: "generated",
    content: "hey, what's up what do you think of my game here in this...",
    createdAt: "2026-01-01T00:00:02Z",
  });

  assert.equal((await listConversations(connectedFolderRoot))[0]?.title, "hey, what's up what do you think of my game here in this...");
  assert.equal(conversationNeedsGeneratedTitle(await readConversation(connectedFolderRoot, created.id)), false);
  assert.equal((await setGeneratedConversationTitle(connectedFolderRoot, created.id, "Tic Tac Flow Game Review")).title, "hey, what's up what do you think of my game here in this...");
});

test("chat store manual conversation title overrides generated landing title", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-manual-title-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  await appendMessage(connectedFolderRoot, "chat-manual-title", message("1", "Review this document draft."));
  await appendMessage(connectedFolderRoot, "chat-manual-title", {
    id: "assistant-1",
    role: "assistant",
    content: "Completed the requested review.",
    createdAt: "2026-01-01T00:00:02Z",
    landing: {
      summary: "The agent completed the requested review.",
      nextActions: [],
      followUpPrompt: null,
      conversationTitle: "Generated Document Review",
      generatedAt: "2026-01-01T00:00:03Z",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
  });

  const renamed = await renameConversation(connectedFolderRoot, "chat-manual-title", "Manual Document Rename");
  assert.equal(renamed.title, "Manual Document Rename");

  const summaries = await listConversations(connectedFolderRoot);
  assert.equal(summaries[0]?.title, "Manual Document Rename");
  assert.ok((await readConversation(connectedFolderRoot, "chat-manual-title")).some((item) => item.kind === "conversation_title" && item.content === "Manual Document Rename"));
});

test("an app's request an older build logged loads as an ordinary message", async (t) => {
  // A Chat log an earlier build wrote may hold a user message a Connected
  // Folder app sent, marked `source: "app"`; it loads as an ordinary message,
  // and the marker is not carried.
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-app-source-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));
  const created = await createConversation(connectedFolderRoot, "Inbox · Compare quotes", "chat-app-source");
  const path = join(conversationsDir(connectedFolderRoot), `${created.id}.jsonl`);
  const lines = [
    { ...message("app", "App request: Compare quotes"), source: "app", appId: "connected-inbox", appTitle: "Inbox" },
    { ...message("bad-title", "Control characters"), source: "app", appTitle: "Inbox\u0000" },
    { id: "reply", role: "assistant", content: "Done.", createdAt: "2026-07-01T00:00:01.000Z", source: "app", appTitle: "Inbox" },
  ];
  await writeFile(path, `${await readFile(path, "utf8")}${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const messages = new Map((await readConversation(connectedFolderRoot, created.id)).map((item) => [item.id, item as unknown as Record<string, unknown>]));
  for (const id of ["app", "bad-title", "reply"]) {
    const item = messages.get(id);
    assert.ok(item, `${id} still loads`);
    assert.equal(item.source, undefined, `${id} carries no app marker`);
    assert.equal(item.appTitle, undefined);
    assert.equal(item.appId, undefined);
  }
  assert.equal(messages.get("app")?.content, "App request: Compare quotes");
  assert.equal(messages.get("app")?.role, "user");
});

test("saved work trails keep an app tool's readable title and drop an unusable one alone", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-tool-title-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));
  const appTool = `app_${"1a2b3c4d".repeat(2)}_search`;
  await appendMessage(connectedFolderRoot, "chat-tool-title", {
    id: "reply", role: "assistant", content: "Found 3.", createdAt: "2026-10-11T12:00:00.000Z",
    workTrail: [
      { kind: "tool", text: "Inbox: Search finished", toolName: appTool, toolTitle: "Inbox: Search", phase: "complete" },
      { kind: "tool", text: "Read finished", toolName: "read", toolTitle: "x".repeat(201), detail: "notes.md", phase: "complete" },
    ],
  });
  const [reply] = await readConversation(connectedFolderRoot, "chat-tool-title");
  assert.equal(reply?.workTrail?.length, 2, "an unusable title never drops the trail");
  assert.equal(reply?.workTrail?.[0]?.toolTitle, "Inbox: Search");
  assert.equal(reply?.workTrail?.[0]?.toolName, appTool, "the registered name stays the identity");
  assert.equal(reply?.workTrail?.[1]?.toolTitle, undefined);
  assert.equal(reply?.workTrail?.[1]?.detail, "notes.md");
});

test("chat store persists archive and snooze state as append-only lifecycle events", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-lifecycle-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  await appendMessage(connectedFolderRoot, "chat-lifecycle", message("1", "Review the launch checklist."));
  const before = (await listConversations(connectedFolderRoot))[0]!;
  const archived = await updateConversationLifecycle(connectedFolderRoot, "chat-lifecycle", { archived: true });
  assert.ok(archived.archivedAt);
  assert.equal(archived.snoozedUntil, null);
  assert.equal(archived.updatedAt, before.updatedAt, "lifecycle bookkeeping must not make a Chat look newly active");

  const restored = await updateConversationLifecycle(connectedFolderRoot, "chat-lifecycle", { archived: false });
  assert.equal(restored.archivedAt, null);
  const snoozedUntil = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const snoozed = await updateConversationLifecycle(connectedFolderRoot, "chat-lifecycle", { snoozedUntil });
  assert.equal(snoozed.snoozedUntil, snoozedUntil);
  assert.equal(snoozed.updatedAt, before.updatedAt);

  const resumed = await updateConversationLifecycle(connectedFolderRoot, "chat-lifecycle", { snoozedUntil: null });
  assert.equal(resumed.snoozedUntil, null);
  const lifecycleEvents = (await readConversation(connectedFolderRoot, "chat-lifecycle"))
    .filter((item) => item.kind === "conversation_lifecycle");
  assert.deepEqual(lifecycleEvents.map((item) => item.lifecycle), [
    { archived: true, snoozedUntil: null },
    { archived: false },
    { snoozedUntil },
    { snoozedUntil: null },
  ]);
});

test("chat store rejects past snoozes and snoozing archived Chats", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-lifecycle-invalid-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  await appendMessage(connectedFolderRoot, "chat-lifecycle-invalid", message("1", "Keep this for later."));
  await assert.rejects(
    () => updateConversationLifecycle(connectedFolderRoot, "chat-lifecycle-invalid", { snoozedUntil: "2020-01-01T00:00:00.000Z" }),
    /future snooze time/,
  );
  await updateConversationLifecycle(connectedFolderRoot, "chat-lifecycle-invalid", { archived: true });
  await assert.rejects(
    () => updateConversationLifecycle(connectedFolderRoot, "chat-lifecycle-invalid", { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }),
    /Unarchive this Chat/,
  );
});

test("chat store keeps messages when landing metadata is malformed", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-bad-landing-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  const dir = conversationsDir(connectedFolderRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "chat-bad-landing.jsonl"), `${JSON.stringify({
    id: "assistant-1",
    role: "assistant",
    content: "Completed the requested review.",
    createdAt: "2026-01-01T00:00:01Z",
    landing: {
      summary: "The agent completed the requested review.",
      nextActions: "not an array",
      followUpPrompt: null,
      generatedAt: "2026-01-01T00:00:02Z",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
  })}\n`, "utf8");

  assert.deepEqual(await readConversation(connectedFolderRoot, "chat-bad-landing"), [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Completed the requested review.",
      createdAt: "2026-01-01T00:00:01Z",
    },
  ]);
});

test("chat listing reuses cached summaries and rebuilds them when a transcript changes", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-index-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));
  await appendMessage(connectedFolderRoot, "chat-indexed", message("1", "Give this Chat a compact cache title."));
  await setGeneratedConversationTitle(connectedFolderRoot, "chat-indexed", "alpha");

  assert.equal((await listConversations(connectedFolderRoot))[0]?.title, "alpha");

  // Same size, same mtime, different bytes. The filesystem change identity
  // still moves, so an external rewrite must invalidate the derived cache.
  const transcript = join(conversationsDir(connectedFolderRoot), "chat-indexed.jsonl");
  const before = await stat(transcript);
  await writeFile(transcript, (await readFile(transcript, "utf8")).replace("alpha", "bravo"), "utf8");
  await utimes(transcript, before.atime, before.mtime);
  assert.equal((await stat(transcript)).size, before.size, "rewrite must preserve size for this assertion to mean anything");
  assert.equal((await listConversations(connectedFolderRoot))[0]?.title, "bravo", "a metadata-preserving rewrite invalidates the cached summary");

  // Appending moves both size and mtime, so the summary must be rebuilt.
  await appendMessage(connectedFolderRoot, "chat-indexed", message("2", "charlie"));
  assert.equal((await listConversations(connectedFolderRoot))[0]?.title, "bravo", "a later append keeps the updated title");
});

test("chat listing ignores cache records that do not describe their own transcript", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-index-invalid-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));
  await appendMessage(connectedFolderRoot, "chat-guarded", message("1", "genuine"));
  await listConversations(connectedFolderRoot);

  const indexFile = join(connectedFolderStateDir(connectedFolderRoot), "conversation-index.json");
  const transcript = await stat(join(conversationsDir(connectedFolderRoot), "chat-guarded.jsonl"));
  await writeFile(indexFile, `${JSON.stringify({
    version: 5,
    entries: {
      "chat-guarded": {
        sizeBytes: transcript.size,
        modifiedAt: transcript.mtime.toISOString(),
        changedAt: transcript.ctime.toISOString(),
        device: String(transcript.dev),
        inode: String(transcript.ino),
        // Claims to summarize a different conversation than its own key.
        summary: { id: "chat-other", title: "injected", createdAt: "x", updatedAt: "x", archivedAt: null, snoozedUntil: null },
      },
    },
  })}\n`, "utf8");

  assert.equal((await listConversations(connectedFolderRoot))[0]?.title, "New Chat", "a self-inconsistent cache record is discarded");
});

test("chat listing rebuilds a previous-version cache after title semantics change", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-index-version-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));
  const created = await createConversation(connectedFolderRoot);
  await appendMessage(connectedFolderRoot, created.id, message("1", "Name this completed conversation"));
  const transcript = await stat(join(conversationsDir(connectedFolderRoot), `${created.id}.jsonl`));

  const indexFile = join(connectedFolderStateDir(connectedFolderRoot), "conversation-index.json");
  await mkdir(connectedFolderStateDir(connectedFolderRoot), { recursive: true });
  await writeFile(indexFile, `${JSON.stringify({
    version: 4,
    entries: {
      [created.id]: {
        sizeBytes: transcript.size,
        modifiedAt: transcript.mtime.toISOString(),
        changedAt: transcript.ctime.toISOString(),
        device: String(transcript.dev),
        inode: String(transcript.ino),
        summary: {
          id: created.id,
          title: "New Chat",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:01Z",
          archivedAt: null,
          snoozedUntil: null,
        },
      },
    },
  })}\n`, "utf8");

  assert.equal((await listConversations(connectedFolderRoot))[0]?.title, "New Chat");
  assert.equal(JSON.parse(await readFile(indexFile, "utf8")).version, 5);
});

test("listing a Connected Folder never deletes a Chat that is still being started", async (t) => {
  const connectedFolderRoot = await mkdtemp(join(tmpdir(), "amplefile-chat-store-new-chat-survives-"));
  t.after(() => rm(connectedFolderRoot, { recursive: true, force: true }));

  // A Chat exists from the moment it is created; its first user message lands
  // a moment later, once the turn is reserved. Whoever lists Chats in that
  // window — the rail, an automation chat hop's sibling Connected Folder, a handoff into
  // another Connected Folder — must not make that turn fail as "Conversation not found."
  const created = await createConversation(connectedFolderRoot);
  const transcript = join(conversationsDir(connectedFolderRoot), `${created.id}.jsonl`);
  assert.deepEqual(await listConversations(connectedFolderRoot), [], "a Chat with no message yet is not listed");
  assert.ok((await stat(transcript).catch(() => null)), "listing left the started Chat in place");

  await appendMessage(connectedFolderRoot, created.id, message("1", "Review the rain plan."));
  const listed = await listConversations(connectedFolderRoot);
  assert.deepEqual(listed.map((entry) => entry.id), [created.id], "the Chat is listed once it carries a message");

  // Housekeeping still reclaims a Chat somebody opened and walked away from.
  const abandoned = await createConversation(connectedFolderRoot);
  const abandonedTranscript = join(conversationsDir(connectedFolderRoot), `${abandoned.id}.jsonl`);
  const longAgo = new Date(Date.now() - 10 * 60_000);
  await utimes(abandonedTranscript, longAgo, longAgo);
  assert.deepEqual(
    (await listConversations(connectedFolderRoot)).map((entry) => entry.id),
    [created.id],
    "an abandoned Chat is never listed",
  );
  assert.equal(await stat(abandonedTranscript).catch(() => null), null, "an abandoned Chat is reclaimed");
});
