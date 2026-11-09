import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import type { ChatStreamEvent, LocalEventStream } from "../web-local/src/types.js";

const conversationId = "agent-chat";
const request = {
  taskId: "task-1", conversationId, phase: "working", startedAt: new Date().toISOString(), endedAt: null, error: null,
  content: "Plan the week", attachments: [], dispositions: [], actions: [], children: [], reply: null,
};

async function agentHarness(t: TestContext, transcript: unknown[] = [{ id: "ask", role: "user", content: "Plan the week", createdAt: "2026-10-11T12:00:00Z" }], latestRequest: unknown = request) {
  const dom = await createDomHarness();
  const realApi = await import("../web-local/src/lib/api.js");
  const streams = new Map<string, LocalEventStream>();
  const api = async (path: string) => {
    if (path.startsWith("/api/amplefile-agent/summary")) return { available: true, conversation: { id: conversationId, title: "Plan the week" }, state: latestRequest ? "running" : "idle", latestRequest };
    if (path === "/api/amplefile-agent/conversations") return { conversations: [{ id: conversationId, title: "Plan the week", updatedAt: "2026-10-11T12:00:00Z", requestState: "working" }] };
    if (path === `/api/amplefile-agent/conversations/${conversationId}`) return { messages: transcript };
    if (path.endsWith("/runtime")) return { runtime: null };
    if (path.endsWith("/work")) return { work: null };
    if (path.startsWith("/api/agent/composer")) return { composer: null };
    if (path === "/api/connected-folders/outline") return { connectedFolders: [] };
    throw new Error(`Unexpected request: ${path}`);
  };
  const mocked = { ...realApi, api, createEventSource(path: string) {
    const stream: LocalEventStream = { onmessage: null, onopen: null, onerror: null, lastEventId: "", close() {} };
    streams.set(path, stream); return stream;
  } };
  const scope = globalThis as unknown as Record<string, unknown>; scope.__agentChatApi = mocked;
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@fluentui/react-icons") return { url: "test:agent-chat-icons", shortCircuit: true };
      const result = next(specifier, context);
      return result.url.endsWith("/web-local/src/lib/api.ts") ? { url: "test:agent-chat-api", shortCircuit: true } : result;
    },
    load(url, context, next) {
      if (url === "test:agent-chat-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (url === "test:agent-chat-api") return { format: "module", source: Object.keys(mocked).map((name) =>
        `export const ${name}=${name === "api" || name === "createEventSource" ? `(...args)=>globalThis.__agentChatApi.${name}(...args)` : `globalThis.__agentChatApi.${name}`};`).join("\n"), shortCircuit: true };
      if (/\.(?:png|svg)(?:\?|$)/u.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  t.after(async () => { await dom.cleanup(); hook.deregister(); delete scope.__agentChatApi; });
  const controls = document.createElement("div");
  document.body.append(controls);
  const { AmpleFileAgentChat } = await import("../web-local/src/popover/PopoverApp.js");
  await dom.render(createElement(AmpleFileAgentChat, { host: "panel", controlsTarget: controls, visible: true }));
  const path = `/api/amplefile-agent/conversations/${conversationId}/events`;
  await dom.waitFor(() => streams.has(path));
  const stream = streams.get(path)!;
  const emit = async (value: Omit<ChatStreamEvent, "conversationId">) => {
    await dom.act(async () => { stream.onmessage?.({ data: JSON.stringify({ conversationId, ...value }) }); await Promise.resolve(); });
    await dom.settle();
  };
  return { dom, emit, controls };
}

test("the AmpleFile Agent shows its thinking and tool steps as they stream, then folds them under the reply", async (t) => {
  const { dom, emit } = await agentHarness(t);
  await emit({ type: "turn_state", running: true, turnId: "turn-1" });
  await emit({ type: "assistant_thinking", turnId: "turn-1", thinkingPhase: "start", workTrailId: "thinking:1", order: 0 });
  await emit({ type: "assistant_thinking", turnId: "turn-1", text: "Checking the folders first.", workTrailId: "thinking:1", order: 0 });
  await emit({ type: "tool", turnId: "turn-1", workTrailId: "tool:list", toolName: "bash", message: "Running", detail: "amplefile connected-folders list", phase: "running", order: 1 });
  assert.ok(dom.container.querySelector(".work-steps.running.open"), "the steps stay open while the turn works");
  assert.equal(dom.container.querySelectorAll(".work-step.thinking").length, 1);
  assert.equal(dom.container.querySelectorAll(".work-step.tool").length, 1);

  await emit({ type: "tool", turnId: "turn-1", workTrailId: "tool:list", toolName: "bash", message: "Ran", detail: "amplefile connected-folders list", phase: "complete", order: 1 });
  assert.equal(dom.container.querySelectorAll(".work-step.tool").length, 1, "an update replaces its row");
  assert.ok(dom.container.querySelector(".work-step.tool.complete"));

  await emit({ type: "assistant_delta", turnId: "turn-1", text: "Here is the plan.", order: 2 });
  assert.match(dom.container.querySelector(".popover-message.streaming")?.textContent ?? "", /Here is the plan\./);
  assert.ok(dom.container.querySelector(".work-steps.settled"), "reply text folds the steps into one summary line");
});

test("a saved reply keeps its steps folded above it", async (t) => {
  const { dom } = await agentHarness(t, [
    { id: "ask", role: "user", content: "Plan the week", createdAt: "2026-10-11T12:00:00Z" },
    { id: "reply", role: "assistant", content: "Here is the plan.", createdAt: "2026-10-11T12:01:00Z",
      workTrail: [{ kind: "tool", toolName: "read", text: "Read", detail: "notes.md", phase: "complete" }] },
  ], null);
  await dom.waitFor(() => Boolean(dom.container.querySelector(".work-steps-summary")));
  assert.ok(dom.container.querySelector(".popover-message.assistant .work-steps.settled"));
});

test("the panel puts its chat controls in the window's top strip, icon only", async (t) => {
  const { controls } = await agentHarness(t);
  const labels = [...controls.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
  assert.deepEqual(labels, ["Chats", "New Chat"]);
  assert.ok([...controls.querySelectorAll("button")].every((button) => !button.textContent?.trim()), "no text labels in the strip");
});

test("the transcript keeps following the newest entry when a picture loads or a step opens", async (t) => {
  // The live chat first renders "Connecting…", so the transcript mounts after
  // the availability read; its observers must attach to that later element.
  const { dom } = await agentHarness(t);
  const transcript = dom.container.querySelector<HTMLElement>(".popover-transcript")!;
  const writes: number[] = [];
  Object.defineProperty(transcript, "scrollHeight", { configurable: true, get: () => 640 });
  Object.defineProperty(transcript, "scrollTop", { configurable: true, get: () => 0, set: (value: number) => { writes.push(value); } });
  await dom.settle();
  writes.length = 0;
  const inner = transcript.querySelector("*") ?? transcript;
  await dom.act(() => { inner.dispatchEvent(new Event("load")); });
  await dom.settle();
  assert.deepEqual(writes, [640], "a loaded picture keeps the pinned transcript at the bottom");
  writes.length = 0;
  await dom.act(() => { inner.dispatchEvent(new Event("toggle")); });
  await dom.settle();
  assert.deepEqual(writes, [640], "so does an opened step");
});

test("a relative link in an AmpleFile Agent reply is plain text, so a click cannot navigate the popover away", async (t) => {
  const { dom } = await agentHarness(t, [
    { id: "ask", role: "user", content: "Where are the notes?", createdAt: "2026-10-11T12:00:00Z" },
    { id: "answer", role: "assistant", content: "They are in [notes.md](notes.md); background at [the site](https://example.com/guide).", createdAt: "2026-10-11T12:00:01Z" },
  ], null);
  await dom.waitFor(() => /They are in/.test(dom.container.textContent ?? ""));
  const anchors = [...dom.container.querySelectorAll<HTMLAnchorElement>(".popover-message a")];
  assert.deepEqual(anchors.map((anchor) => anchor.getAttribute("href")), ["https://example.com/guide"]);
  assert.equal(anchors[0]!.target, "_blank");
  assert.match(dom.container.querySelector(".popover-message.assistant")?.textContent ?? "", /notes\.md/);
});

test("the popover announces a turn's start and end, not every streamed frame or timer tick", async (t) => {
  const { dom, emit } = await agentHarness(t);
  await emit({ type: "turn_state", running: true, turnId: "turn-1" });
  await emit({ type: "assistant_delta", turnId: "turn-1", text: "Streaming text", order: 0 });
  const transcript = dom.container.querySelector(".popover-transcript")!;
  assert.equal(transcript.getAttribute("aria-live"), null, "the transcript is not re-read as it streams");
  for (const line of dom.container.querySelectorAll(".working-line")) {
    if (line.querySelector(".working-elapsed")) assert.notEqual(line.getAttribute("role"), "status", "the elapsed timer is not a live region");
  }
  const live = [...dom.container.querySelectorAll('[aria-live="polite"], [role="status"]')].filter((node) => !node.closest("[hidden]"));
  assert.ok(live.every((node) => !node.textContent?.includes("Streaming text")));

  const { TurnAnnouncer, chatTurnStatus } = await import("../web-local/src/components/chat/TurnAnnouncer.js");
  const host = document.createElement("div"); document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const say = async (conversationKey: string, status: Parameters<typeof TurnAnnouncer>[0]["status"]) => {
    await dom.act(() => root.render(createElement(TurnAnnouncer, { conversationKey, status, who: "The AmpleFile Agent" })));
    return host.textContent;
  };
  assert.equal(await say("one", "replied"), "", "what a conversation shows when it opens is not news");
  assert.equal(await say("one", "working"), "The AmpleFile Agent is working.");
  assert.equal(await say("one", "handed_off"), "The AmpleFile Agent handed work to Connected Folders and is waiting on it.");
  assert.equal(await say("one", "question"), "The AmpleFile Agent has a question for you.");
  assert.equal(await say("one", "working"), "The AmpleFile Agent is working.");
  assert.equal(await say("one", "failed"), "The AmpleFile Agent could not finish.");
  assert.equal(await say("one", "working"), "The AmpleFile Agent is working.");
  assert.equal(await say("two", "replied"), "", "opening another conversation resets without speaking");
  assert.equal(await say("two", "stopped"), "The AmpleFile Agent stopped.");
  // A Worker Chat reads its outcome from the durable request, then the last reply.
  assert.equal(chatTurnStatus(true, "done", undefined), "working");
  assert.equal(chatTurnStatus(false, "waiting", undefined), "question");
  assert.equal(chatTurnStatus(false, "partial", undefined), "partial");
  assert.equal(chatTurnStatus(false, null, { id: "r", role: "assistant", content: "", createdAt: "", interruption: { reason: "cancelled", message: "", retryAttempts: 0, provider: null, model: null, activities: [] } }), "stopped");
  assert.equal(chatTurnStatus(false, null, { id: "r", role: "assistant", content: "", createdAt: "", interruption: { reason: "provider_error", message: "", retryAttempts: 0, provider: null, model: null, activities: [] } }), "failed");
  assert.equal(chatTurnStatus(false, null, { id: "r", role: "assistant", content: "Done", createdAt: "" }), "replied");
  await dom.act(() => root.unmount());
});

test("AmpleFile Agent replies render GitHub tables and one line per hard break, like Worker replies", async (t) => {
  const { dom } = await agentHarness(t, [
    { id: "ask", role: "user", content: "Compare them", createdAt: "2026-10-11T12:00:00Z" },
    { id: "answer", role: "assistant", content: "| Quote | Total |\n|---|---|\n| North | 4,200 |\n\nFirst line  \nSecond line", createdAt: "2026-10-11T12:00:01Z" },
  ], null);
  await dom.waitFor(() => Boolean(dom.container.querySelector(".popover-message.assistant table")));
  assert.equal(dom.container.querySelector(".popover-message.assistant td")?.textContent, "North");
  const paragraph = [...dom.container.querySelectorAll(".popover-message.assistant p")].find((item) => item.querySelector("br"))!;
  assert.ok(paragraph, "a hard break is a <br>");
  assert.equal(paragraph.innerHTML, "First line<br>Second line", "no newline is left after the break to draw a blank line");
});
