import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import { computerPlace, enclosingNativeFolder, isComputerPlace, placeApiBase, placeNativePath } from "../web-local/src/components/file-manager/file-manager-places.js";
import type { ConnectedFolderSummary, TreeEntry } from "../web-local/src/types.js";

// Any folder on the computer in the file manager window (docs/product-model.md,
// "Other folders"): the computer place has no sidebar row, Command-Up and the
// path bar leave a place's top, and a folder handed to AmpleFile opens there.

const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const entry = (path: string, kind: "file" | "folder" = "file"): TreeEntry => ({ kind, path, name: path.slice(path.lastIndexOf("/") + 1), updatedAt: "2026-09-27T12:00:00Z", ...(kind === "file" ? { sizeBytes: 10 } : {}) } as TreeEntry);
const computer = { kind: "standard", id: "computer" };

test("the computer place's paths are the disk's, and only the disk has nothing above it", () => {
  assert.deepEqual(computerPlace, computer);
  assert.equal(isComputerPlace(computerPlace), true);
  assert.equal(isComputerPlace({ kind: "standard", id: "home" }), false);
  assert.equal(placeApiBase(computerPlace), "/api/standard-folders/computer");
  assert.equal(placeNativePath("/", "srv/shared"), "/srv/shared");
  assert.equal(placeNativePath("/", ""), "/");
  assert.equal(placeNativePath("/home/ana/", "Notes"), "/home/ana/Notes");
  assert.equal(enclosingNativeFolder("/home/ana/Projects"), "/home/ana");
  assert.equal(enclosingNativeFolder("/home"), "/");
  assert.equal(enclosingNativeFolder("/"), null);
});

function answers(extra: ApiAnswer = () => undefined): ApiAnswer {
  return (path, options) => {
    const value = extra(path, options);
    if (value !== undefined) return value;
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true, provider: "test", model: "synthetic" } };
    if (path.startsWith("/api/agent/composer")) return { composer: { model: { provider: "test", id: "synthetic", name: "Synthetic" }, thinkingLevel: "off", thinkingLevels: ["off"] } };
    if (path === "/api/standard-folders") return { folders: [{ id: "home", name: "ana", root: "/home/ana", connectedFolderId: null }] };
    if (path.startsWith("/api/standard-folders/computer/tree")) {
      const shown = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("path") ?? "";
      if (shown === "srv/shared") return { tree: [entry("srv/shared/Scans", "folder"), entry("srv/shared/report.pdf")] };
      if (shown === "srv") return { tree: [entry("srv/shared", "folder")] };
      if (shown === "home") return { tree: [entry("home/ana", "folder")] };
      if (shown === "tmp") return { tree: [entry("tmp/lab", "folder")] };
      return { tree: [entry("home", "folder"), entry("srv", "folder"), entry("tmp", "folder")] };
    }
    if (path.includes("/tree")) return { tree: [entry("a.md")] };
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

const treeReads = (requests: Array<{ path: string }>, shown: string) => requests.filter((item) => item.path.startsWith("/api/standard-folders/computer/tree")
  && (new URLSearchParams(item.path.slice(item.path.indexOf("?") + 1)).get("path") ?? "") === shown).length;

test("a folder handed to AmpleFile opens in the computer place with its file selected, and no sidebar row is current", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers());
  const opened: number[] = [];
  await dom.render(view(module, {
    openLocationRequest: { id: 7, location: { place: computer, path: "srv/shared" }, select: "srv/shared/report.pdf" },
    onOpenedLocation: (id: number) => opened.push(id),
  }));
  await dom.waitFor(() => treeReads(requests, "srv/shared") > 0);
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="srv/shared/report.pdf"][aria-selected="true"]') !== null);
  assert.deepEqual(opened, [7]);
  assert.equal(dom.container.querySelector(".fm-title-text")?.textContent, "shared", "the toolbar names the folder shown");
  assert.equal(dom.container.querySelector('.fm-sidebar [aria-current="page"]'), null, "the location belongs to no sidebar row");
  const crumbs = [...dom.container.querySelectorAll(".fm-crumb")].map((crumb) => crumb.textContent);
  assert.deepEqual(crumbs.slice(-3), ["srv", "shared", "report.pdf"]);
  assert.equal(dom.container.querySelector(".fm-status")?.textContent, "1 of 2 selected", "the item count counts the folder shown");
  // The folder stands on its own, so with nothing selected the panel offers to connect it.
  await dom.act(() => { dom.container.querySelector<HTMLElement>('[role="grid"]')!.click(); });
  await dom.waitFor(() => [...dom.container.querySelectorAll("button")].some((button) => button.textContent === "Connect This Folder"));
  assert.ok([...dom.container.querySelectorAll("button")].some((button) => button.textContent === "Connect This Folder"));
});

test("Command-Up climbs out of a place's top to the disk, and Back returns", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path) => path.startsWith("/api/folder-location")
    ? { location: { place: computer, path: "tmp", select: "tmp/lab" } }
    : undefined));
  await dom.render(view(module));
  const list = () => dom.container.querySelector<HTMLElement>('[role="grid"]')!;
  const commandUp = () => dom.act(() => { list().dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", ctrlKey: true, bubbles: true, cancelable: true })); });
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="a.md"]') !== null);

  // At Lab's top, the host says where the folder above lives and Lab is selected there.
  await commandUp();
  await dom.waitFor(() => requests.some((item) => item.path === "/api/folder-location?path=%2Ftmp%2Flab&reveal=1"));
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="tmp/lab"][aria-selected="true"]') !== null);
  // Inside the computer place it is a plain step up, all the way to the disk.
  await commandUp();
  await dom.waitFor(() => treeReads(requests, "") > 0 && dom.container.querySelector('[data-fm-path="tmp"][aria-selected="true"]') !== null);
  const locationReads = requests.filter((item) => item.path.startsWith("/api/folder-location")).length;
  await commandUp();
  assert.equal(requests.filter((item) => item.path.startsWith("/api/folder-location")).length, locationReads, "the disk has nothing above it");

  await dom.act(() => { list().dispatchEvent(new window.KeyboardEvent("keydown", { key: "[", ctrlKey: true, bubbles: true, cancelable: true })); });
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="tmp/lab"]') !== null);
});

test("double-clicking a path bar folder above the place's top opens it where it lives", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path) => path === "/api/folder-location?path=%2Ftmp"
    ? { location: { place: computer, path: "tmp", select: null } }
    : undefined));
  await dom.render(view(module));
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="a.md"]') !== null);
  const tmp = [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-crumb")].find((crumb) => crumb.textContent === "tmp")!;
  await dom.act(() => { tmp.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  await dom.waitFor(() => treeReads(requests, "tmp") > 0);
  await dom.waitFor(() => dom.container.querySelector(".fm-title-text")?.textContent === "tmp");
});

test("opening a folder that is a Standard Folder goes to that Standard Folder", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers());
  await dom.render(view(module, { openLocationRequest: { id: 1, location: { place: computer, path: "home" }, select: null } }));
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="home/ana"]') !== null);
  const row = dom.container.querySelector<HTMLElement>('[data-fm-path="home/ana"]')!;
  await dom.act(() => { row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  await dom.waitFor(() => requests.some((item) => item.path.startsWith("/api/standard-folders/home/tree")));
  await dom.waitFor(() => dom.container.querySelector('.fm-sidebar [aria-current="page"]')?.textContent?.includes("ana") === true);
});
