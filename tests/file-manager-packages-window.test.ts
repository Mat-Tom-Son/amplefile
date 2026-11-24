import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { ConnectedFolderSummary, TreeEntry } from "../web-local/src/types.js";

// Mac packages in the real window (jsdom, a mocked local API and desktop):
// opening one opens it in its app through the same native open path a file
// uses, and only Show Package Contents goes inside.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const at = "2026-09-27T12:00:00Z";
const top: TreeEntry[] = [
  { kind: "folder", name: "Sketch.app", path: "Sketch.app", updatedAt: at, package: true },
  { kind: "folder", name: "Safari.app", path: "Safari.app", updatedAt: at, package: true, link: { target: "folder", targetPath: "/System/Applications/Safari.app" } },
  { kind: "folder", name: "Plain", path: "Plain", updatedAt: at },
];

function answers(): ApiAnswer {
  return (path) => {
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true, provider: "test", model: "synthetic" } };
    if (path.startsWith("/api/agent/composer")) return { composer: { model: { provider: "test", id: "synthetic", name: "Synthetic" }, thinkingLevel: "off", thinkingLevels: ["off"] } };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path.includes("/tree")) {
      const inside = new URL(path, "http://local").searchParams.get("path") ?? "";
      return { tree: inside === "Sketch.app" ? [{ kind: "folder", name: "Contents", path: "Sketch.app/Contents", updatedAt: at }] : inside ? [] : top };
    }
    if (path.startsWith("/api/folder-location")) return { place: { kind: "standard", id: "computer" }, path: "System/Applications/Safari.app", select: null };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations")) return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    if (path.includes("/file-info")) return { modifiedAt: at };
    if (path.includes("/standard-folders/computer/")) return { tree: [] };
    return undefined;
  };
}

const row = (container: HTMLElement, path: string) => container.querySelector<HTMLElement>(`[data-fm-path="${path}"]`);
const treeReads = (requests: ReadonlyArray<{ path: string }>, inside: string) => requests.filter((request) => request.path.includes("/tree") && new URL(request.path, "http://local").searchParams.get("path") === inside).length;

test("double-clicking a package opens it in its app, never inside, and Show Package Contents goes inside", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers());
  const opened: Array<[string, string, string]> = [];
  const linked: Array<[unknown, string, string]> = [];
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = {
    connectedFolder: { openPath: async (id: string, path: string, action: string) => { opened.push([id, path, action]); } },
    placeLink: { open: async (place: unknown, path: string, action: string) => { linked.push([place, path, action]); } },
  };
  t.after(() => { delete scope.ampleFileDesktop; });
  await dom.render(createElement(module.FileManagerView, {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  }));
  await dom.waitFor(() => Boolean(row(dom.container, "Sketch.app")));
  assert.equal(row(dom.container, "Sketch.app")!.querySelector(".fm-col-kind")!.textContent, "Application");
  assert.equal(row(dom.container, "Safari.app")!.querySelector(".fm-col-kind")!.textContent, "Link to Application");

  await dom.act(() => { row(dom.container, "Sketch.app")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await dom.waitFor(() => opened.length === 1);
  assert.deepEqual(opened, [["lab", "Sketch.app", "open"]], "the same native open a file uses");
  await dom.settle();
  assert.equal(treeReads(requests, "Sketch.app"), 0, "the window did not go inside");

  // A link to a package, as /Applications/Safari.app is, opens the app it points to.
  await dom.act(() => { row(dom.container, "Safari.app")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await dom.waitFor(() => linked.length === 1);
  assert.deepEqual(linked, [[{ kind: "connected-folder", id: "lab" }, "Safari.app", "open"]]);
  assert.ok(!requests.some((request) => request.path.startsWith("/api/folder-location")), "nor did it go to where the link's folder is");

  // Show Package Contents, from the item menu, goes inside.
  await dom.act(() => { row(dom.container, "Sketch.app")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
  const items = [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-menu .fm-menu-i")];
  assert.deepEqual(items.slice(0, 2).map((item) => item.textContent), ["Open", "Show Package Contents"]);
  assert.ok(!items.some((item) => item.textContent === "Open in New Tab" || item.textContent === "New Folder Here…"));
  await dom.act(() => items.find((item) => item.textContent === "Show Package Contents")!.click());
  await dom.waitFor(() => Boolean(row(dom.container, "Sketch.app/Contents")));
  assert.equal(opened.length, 1, "Show Package Contents opens nothing");
});
