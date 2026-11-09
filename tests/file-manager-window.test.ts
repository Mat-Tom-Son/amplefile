import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { ConnectedFolderSummary, TreeEntry } from "../web-local/src/types.js";

// The file manager window mounted for real (jsdom, a mocked local API), so
// these tests observe what a person would: requests made, focus, ARIA.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const file = (name: string): TreeEntry => ({ kind: "file", path: name, name, updatedAt: "2026-09-27T12:00:00Z", sizeBytes: 10 } as TreeEntry);

function answers(extra: ApiAnswer = () => undefined, tree: TreeEntry[] = [file("a.md"), file("b.md")]): ApiAnswer {
  return (path, options) => {
    const value = extra(path, options);
    if (value !== undefined) return value;
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true, provider: "test", model: "synthetic" } };
    if (path.startsWith("/api/agent/composer")) return { composer: { model: { provider: "test", id: "synthetic", name: "Synthetic" }, thinkingLevel: "off", thinkingLevels: ["off"] } };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path.includes("/tree")) return { tree };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations")) return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    return undefined;
  };
}

function view(module: Awaited<ReturnType<typeof createFileManagerHarness>>["module"], props: Record<string, unknown> = {}) {
  return createElement(module.FileManagerView, {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
    ...props,
  });
}

test("a model change made in Settings re-reads the Worker's model row", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers());
  const statusReads = () => requests.filter((item) => item.path.startsWith("/api/agent/status")).length;
  await dom.render(view(module, { modelConfigurationRevision: 0 }));
  await dom.waitFor(() => statusReads() === 1);
  await dom.render(view(module, { modelConfigurationRevision: 1 }));
  await dom.waitFor(() => statusReads() === 2);
});

test("folder suggestions are asked for only while Info shows them, once the folder has stayed shown", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path) => path.includes("/suggestions") ? { suggestions: ["Summarize the notes"] } : undefined));
  const suggestionReads = () => requests.filter((item) => item.path.includes("/suggestions")).length;
  await dom.render(view(module));
  const historyTab = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.includes("History"))!;
  await dom.act(() => historyTab.click());
  await dom.act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
  assert.equal(suggestionReads(), 0, "History hides the suggestions, so no model call is made");
  const infoTab = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Info")!;
  await dom.act(() => infoTab.click());
  assert.equal(suggestionReads(), 0, "the call waits for the folder to stay shown");
  await dom.waitFor(() => suggestionReads() === 1);
  await dom.waitFor(() => dom.container.textContent?.includes("Summarize the notes") === true);
});

test("moving to another folder abandons the previous folder's suggestion request", async (t) => {
  const asked: Array<{ path: string; signal: AbortSignal }> = [];
  const { dom } = await createFileManagerHarness(t, (path, options) => {
    asked.push({ path: new URL(path, "http://local").searchParams.get("path") ?? "", signal: options.signal! });
    return new Promise(() => {});
  });
  const { useFolderSuggestions } = await import("../web-local/src/components/file-manager/useFolderSuggestions.js");
  function Probe({ path }: { path: string }) { useFolderSuggestions("abandon", path, true); return null; }
  await dom.render(createElement(Probe, { path: "One" }));
  await dom.render(createElement(Probe, { path: "Two" }));
  await dom.render(createElement(Probe, { path: "Three" }));
  await dom.waitFor(() => asked.length >= 1, 2_000);
  await dom.act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.path, "Three", "folders passed through quickly are never asked for");
  await dom.render(createElement(Probe, { path: "Four" }));
  assert.equal(asked[0]!.signal.aborted, true);
});
