import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness } from "./support/file-manager.js";
import type { ConnectedFolderSummary, TreeEntry } from "../web-local/src/types.js";

// Its own file (and process): the counted module must be loaded through the
// harness before anything else imports the file manager.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const tree: TreeEntry[] = Array.from({ length: 60 }, (_, index) => ({ kind: "file", path: `file-${String(index).padStart(2, "0")}.md`, name: `file-${String(index).padStart(2, "0")}.md`, updatedAt: "2026-09-27T12:00:00Z", sizeBytes: 10 } as TreeEntry));

test("changing the selection re-renders only the rows whose selection changed", async (t) => {
  const { dom, module, calls } = await createFileManagerHarness(t, (path) => {
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true } };
    if (path.startsWith("/api/agent/composer")) return { composer: null };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path.includes("/tree")) return { tree };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations")) return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    return undefined;
  }, { "file-manager-model.ts": ["formatFileManagerDate"] });
  await dom.render(createElement(module.FileManagerView, {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  }));
  await dom.waitFor(() => dom.container.querySelectorAll("[data-fm-path]").length === tree.length);
  await dom.settle();
  const row = (path: string) => dom.container.querySelector<HTMLElement>(`[data-fm-path="${path}"]`)!;
  await dom.act(() => row("file-10.md").click());
  await dom.settle();
  const before = calls.formatFileManagerDate ?? 0;
  assert.ok(before >= tree.length, "the counted date formatter draws every row");
  await dom.act(() => row("file-11.md").click());
  await dom.settle();
  const redrawn = (calls.formatFileManagerDate ?? 0) - before;
  assert.ok(redrawn <= 4, `one selection change redrew ${redrawn} rows of ${tree.length}`);
  assert.equal(row("file-11.md").getAttribute("aria-selected"), "true");
  assert.equal(row("file-10.md").getAttribute("aria-selected"), "false");
});
