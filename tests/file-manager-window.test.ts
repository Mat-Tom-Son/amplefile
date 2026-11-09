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
