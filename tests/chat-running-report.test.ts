import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import type { LocalEventStream, ConnectedFolderSummary } from "../web-local/src/types.js";

// A Chat reports its turn as running to the file manager's activity dots. Its
// report must end when the Chat stops showing that conversation; otherwise a
// Connected Folder keeps pulsing after the person leaves a running Chat.
test("a running Chat withdraws its running report when it unmounts or shows another Chat", async (t) => {
  const dom = await createDomHarness();
  const realApi = await import("../web-local/src/lib/api.js");
  const streams = new Map<string, LocalEventStream>();
  const stamp = "2026-09-27T12:00:00Z";
  const api = async (path: string) => {
    if (path === "/api/connected-folders/folder/conversations") return { conversations: [{ id: "first", title: "First", updatedAt: stamp }, { id: "second", title: "Second", updatedAt: stamp }] };
    if (/\/conversations\/(first|second)$/.test(path)) return { messages: [] };
    if (path.endsWith("/runtime")) return { runtime: null };
    if (path.endsWith("/work")) return { work: null };
    if (path.includes("/agent/catalog")) return { commands: [] };
    if (path.includes("/agent/status")) return { status: { ready: true, configured: true } };
    if (path.includes("/agent/composer")) return { composer: null };
    if (path.includes("/paths-exist")) return { existing: [] };
    throw new Error(`Unexpected UI request: ${path}`);
  };
  const mocked = { ...realApi, api, createEventSource(path: string) {
    const stream: LocalEventStream = { onmessage: null, onopen: null, onerror: null, lastEventId: "", close() {} };
    streams.set(path, stream); return stream;
  } };
  const scope = globalThis as unknown as Record<string, unknown>; scope.__runningReportApi = mocked;
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@fluentui/react-icons") return { url: "test:running-report-icons", shortCircuit: true };
      const result = next(specifier, context);
      return result.url.endsWith("/web-local/src/lib/api.ts") ? { url: "test:running-report-api", shortCircuit: true } : result;
    },
    load(url, context, next) {
      if (url === "test:running-report-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (url === "test:running-report-api") return { format: "module", source: Object.keys(mocked).map((name) =>
        `export const ${name}=${name === "api" || name === "createEventSource" ? `(...args)=>globalThis.__runningReportApi.${name}(...args)` : `globalThis.__runningReportApi.${name}`};`).join("\n"), shortCircuit: true };
      if (/\.(?:png|svg)(?:\?|$)/u.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  t.after(async () => { await dom.cleanup(); hook.deregister(); delete scope.__runningReportApi; });
  HTMLElement.prototype.scrollIntoView = () => {};
  HTMLElement.prototype.scrollTo = () => {};
  const { ChatPanel } = await import("../web-local/src/components/chat/ChatPanel.js");

  const running = new Map<string, boolean>();
  const render = (target: string | null) => dom.render(target === null ? null : createElement(ChatPanel, {
    surfaceTabId: "chat-tab", connectedFolder: { id: "folder", name: "Notes", connectedFolderRoot: "/folder" } as ConnectedFolderSummary,
    connectedFolderCustomizations: {}, targetConversationId: target, contextPathRequest: null, onAgentFinished() {},
    onRunningChange: (conversationId: string, value: boolean) => { running.set(conversationId, value); },
  }));
  const startTurn = async (conversationId: string) => {
    const path = `/api/connected-folders/folder/conversations/${conversationId}/events`;
    await dom.waitFor(() => streams.has(path));
    await dom.act(async () => { streams.get(path)!.onmessage?.({ data: JSON.stringify({ conversationId, type: "turn_state", running: true, turnId: `${conversationId}-turn` }) }); await Promise.resolve(); });
    await dom.waitFor(() => running.get(conversationId) === true);
  };

  await render("first");
  await startTurn("first");
  assert.equal(dom.container.querySelector(".turn-announcer")?.textContent, "The Worker is working.", "the Chat announces a turn once, in its own live region");
  assert.equal(dom.container.querySelector(".turn-announcer")?.getAttribute("aria-live"), "polite");
  await render("second");
  await dom.waitFor(() => running.get("first") === false);
  await startTurn("second");
  await render(null);
  assert.equal(running.get("second"), false, "unmounting a running Chat withdraws its report");
});
