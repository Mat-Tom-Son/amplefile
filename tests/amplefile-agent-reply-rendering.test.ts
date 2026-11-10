import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import type { ChatStreamEvent, LocalEventStream } from "../web-local/src/types.js";

// A streamed frame re-renders the AmpleFile Agent's chat; saved replies must
// not be re-derived or re-parsed for it. Counts calls of the saved work-trail
// reader, which every saved reply's render runs.
test("streaming a reply does not re-render the saved replies above it", async (t) => {
  const dom = await createDomHarness();
  const conversationId = "agent-chat";
  const transcript = Array.from({ length: 8 }, (_, index) => [
    { id: `ask-${index}`, role: "user", content: `Question ${index}`, createdAt: "2026-10-11T12:00:00Z" },
    { id: `answer-${index}`, role: "assistant", content: `**Answer** ${index}`, createdAt: "2026-10-11T12:00:01Z" },
  ]).flat();
  const request = { taskId: "task-1", conversationId, phase: "working", startedAt: new Date().toISOString(), endedAt: null, error: null, content: "Next", attachments: [], dispositions: [], actions: [], children: [], reply: null };
  const realApi = await import("../web-local/src/lib/api.js");
  const streams = new Map<string, LocalEventStream>();
  const api = async (path: string) => {
    if (path.startsWith("/api/amplefile-agent/summary")) return { available: true, conversation: { id: conversationId, title: "Plans" }, state: "running", latestRequest: request };
    if (path === "/api/amplefile-agent/conversations") return { conversations: [{ id: conversationId, title: "Plans", updatedAt: "2026-10-11T12:00:00Z", requestState: "working" }] };
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
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.__replyRenderingApi = mocked; scope.__replyRenderingCalls = 0;
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@fluentui/react-icons") return { url: "test:reply-rendering-icons", shortCircuit: true };
      const result = next(specifier, context);
      if (result.url.endsWith("/web-local/src/lib/api.ts")) return { url: "test:reply-rendering-api", shortCircuit: true };
      if (result.url.endsWith("/web-local/src/lib/chat-work-trail.ts") && !context.parentURL?.startsWith("test:")) return { url: `test:reply-rendering-trail:${result.url}`, shortCircuit: true };
      return result;
    },
    load(url, context, next) {
      if (url === "test:reply-rendering-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (url === "test:reply-rendering-api") return { format: "module", source: Object.keys(mocked).map((name) =>
        `export const ${name}=${name === "api" || name === "createEventSource" ? `(...args)=>globalThis.__replyRenderingApi.${name}(...args)` : `globalThis.__replyRenderingApi.${name}`};`).join("\n"), shortCircuit: true };
      if (url.startsWith("test:reply-rendering-trail:")) {
        const real = JSON.stringify(url.slice("test:reply-rendering-trail:".length));
        return { format: "module", shortCircuit: true, source: `export * from ${real};\nimport * as real from ${real};\nexport const savedWorkTrailPreviews=(...args)=>{globalThis.__replyRenderingCalls++;return real.savedWorkTrailPreviews(...args);};` };
      }
      if (/\.(?:png|svg)(?:\?|$)/u.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  t.after(async () => { await dom.cleanup(); hook.deregister(); delete scope.__replyRenderingApi; delete scope.__replyRenderingCalls; });
  const controls = document.createElement("div"); document.body.append(controls);
  HTMLElement.prototype.scrollIntoView = () => {};
  const { AmpleFileAgentChat } = await import("../web-local/src/popover/PopoverApp.js");
  await dom.render(createElement(AmpleFileAgentChat, { host: "panel", controlsTarget: controls, visible: true }));
  const path = `/api/amplefile-agent/conversations/${conversationId}/events`;
  await dom.waitFor(() => streams.has(path) && /Answer 7/.test(dom.container.textContent ?? ""));
  const emit = async (value: Omit<ChatStreamEvent, "conversationId">) => {
    await dom.act(async () => { streams.get(path)!.onmessage?.({ data: JSON.stringify({ conversationId, ...value }) }); await Promise.resolve(); });
    await dom.settle();
  };
  await emit({ type: "turn_state", running: true, turnId: "turn-1" });
  const before = scope.__replyRenderingCalls as number;
  for (let frame = 0; frame < 5; frame++) await emit({ type: "assistant_delta", turnId: "turn-1", text: ` word${frame}`, order: frame });
  assert.match(dom.container.querySelector(".popover-message.streaming")?.textContent ?? "", /word4/);
  assert.equal((scope.__replyRenderingCalls as number) - before, 0, "saved replies are not re-derived per streamed frame");
});
