import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { ConnectedFolderSummary, TreeEntry } from "../web-local/src/types.js";

// Space in the file list, mounted for real (jsdom, a mocked local API): on
// Linux the window draws its own Preview, which follows the selection; on the
// Mac Space still asks Quick Look and draws nothing.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const entry = (name: string, kind: "file" | "folder" = "file"): TreeEntry => ({ kind, path: name, name, updatedAt: "2026-09-27T12:00:00Z", sizeBytes: 10 } as TreeEntry);

function answers(previews: string[]): ApiAnswer {
  return (path) => {
    if (path.includes("/file-preview?")) {
      const file = new URL(path, "http://local").searchParams.get("path")!;
      previews.push(file);
      return { preview: { kind: "text", content: `contents of ${file}`, truncated: false, sizeBytes: 20 } };
    }
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true, provider: "test", model: "synthetic" } };
    if (path.startsWith("/api/agent/composer")) return { composer: { model: { provider: "test", id: "synthetic", name: "Synthetic" }, thinkingLevel: "off", thinkingLevels: ["off"] } };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path.includes("/tree")) return { tree: [entry("a.md"), entry("b.md"), entry("Inbox", "folder")] };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations")) return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    if (path.includes("/file-info")) return { modifiedAt: "2026-09-27T12:00:00Z" };
    return undefined;
  };
}

/** Just enough of the desktop bridge for the file list on one platform; `previewFile` records Quick Look requests. */
function desktop(platform: NodeJS.Platform, quickLooks: string[]) {
  const files = {
    openPath: async () => {}, revealFolder: async () => {}, startDrag: async () => true,
    previewFile: async (_id: string, path: string) => { quickLooks.push(path); return true; },
  };
  (window as unknown as { ampleFileDesktop: unknown }).ampleFileDesktop = { app: { platform }, connectedFolder: files };
}

async function mount(t: test.TestContext, platform: NodeJS.Platform) {
  const previews: string[] = [];
  const quickLooks: string[] = [];
  const harness = await createFileManagerHarness(t, answers(previews));
  desktop(platform, quickLooks);
  const { dom, module } = harness;
  await dom.render(createElement(module.FileManagerView, {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  }));
  await dom.waitFor(() => Boolean(dom.container.querySelector('[data-fm-path="a.md"]')));
  await dom.act(() => dom.container.querySelector<HTMLElement>('[data-fm-path="a.md"]')!.click());
  const grid = dom.container.querySelector<HTMLElement>('[role="grid"]')!;
  await dom.act(() => grid.focus());
  const preview = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label^="Preview of"]');
  return { dom, grid, preview, previews, quickLooks };
}

test("on Linux, Space opens the Preview, the arrow keys move it, and Space closes it", async (t) => {
  const { dom, grid, preview, previews, quickLooks } = await mount(t, "linux");
  await dom.press(" ");
  await dom.waitFor(() => preview()?.textContent?.includes("contents of a.md") === true);
  assert.equal(preview()!.getAttribute("aria-label"), "Preview of a.md");
  assert.equal(document.activeElement, grid, "the list keeps the keyboard");

  await dom.press("ArrowDown");
  await dom.waitFor(() => preview()?.textContent?.includes("contents of b.md") === true);
  assert.equal(grid.getAttribute("aria-activedescendant")?.includes("b.md") ?? false, true, "the selection moved with it");

  await dom.press("ArrowDown");
  await dom.waitFor(() => preview()?.getAttribute("aria-label") === "Preview of Inbox");
  assert.match(preview()!.textContent ?? "", /Folder/, "a folder shows its card");
  assert.deepEqual(previews, ["a.md", "b.md"], "a folder's contents are never read for the Preview");

  await dom.press(" ");
  assert.equal(preview(), null, "Space closes it");
  await dom.press(" ");
  assert.equal(preview(), null, "Space on a folder alone opens nothing");
  assert.deepEqual(quickLooks, [], "Linux never asks for Quick Look");
});

test("on Linux, Esc closes the Preview first and keeps the selection, then clears it", async (t) => {
  const { dom, grid, preview } = await mount(t, "linux");
  await dom.press(" ");
  await dom.waitFor(() => Boolean(preview()));
  await dom.press("Escape");
  assert.equal(preview(), null);
  assert.ok(grid.getAttribute("aria-activedescendant"), "the item is still selected");
  await dom.press("Escape");
  assert.equal(grid.getAttribute("aria-activedescendant"), null, "a second Esc clears the selection");

  await dom.act(() => dom.container.querySelector<HTMLElement>('[data-fm-path="b.md"]')!.click());
  await dom.act(() => grid.focus());
  await dom.press(" ");
  await dom.waitFor(() => Boolean(preview()));
  await dom.act(() => preview()!.querySelector<HTMLButtonElement>('button[aria-label="Close Preview"]')!.click());
  assert.equal(preview(), null, "Close puts it away");
  assert.equal(document.activeElement, grid, "and gives the keyboard back to the list");
});

test("on the Mac, Space asks Quick Look and the window draws no Preview", async (t) => {
  const { dom, preview, previews, quickLooks } = await mount(t, "darwin");
  await dom.press(" ");
  await dom.waitFor(() => quickLooks.length === 1);
  assert.deepEqual(quickLooks, ["a.md"]);
  assert.equal(preview(), null);
  assert.deepEqual(previews, []);
});
