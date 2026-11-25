import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";

import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { FolderSize } from "../web-local/src/components/file-manager/file-manager-folder-size.js";
import type { TreeEntry } from "../web-local/src/types.js";

// Thumbnails, folder sizes, plain-folder search, and the window with no
// Connected Folder (docs/product-model.md, "The file manager window").

const home = { kind: "standard" as const, id: "home" };
const at = "2026-09-27T12:00:00.000Z";
const file = (path: string, sizeBytes = 10): TreeEntry => ({ kind: "file", path, name: path.slice(path.lastIndexOf("/") + 1), updatedAt: at, sizeBytes } as TreeEntry);
const folder = (path: string): TreeEntry => ({ kind: "folder", path, name: path.slice(path.lastIndexOf("/") + 1), updatedAt: at } as TreeEntry);

const size = (overrides: Partial<FolderSize> = {}): FolderSize => ({ path: "Notes", bytes: 3 * 1024 ** 3, bytesOnDisk: null, items: 1234, files: 1200, folders: 34, links: 0, unreadable: 0, otherVolumes: 0, complete: true, stoppedBy: null, elapsedMs: 10, measuredAt: at, cached: false, ...overrides });

function answers(extra: ApiAnswer = () => undefined): ApiAnswer {
  return (path, options) => {
    const value = extra(path, options);
    if (value !== undefined) return value;
    if (path === "/api/standard-folders") return { folders: [{ id: "home", name: "ana", root: "/home/ana", connectedFolderId: null }, { id: "pictures", name: "Pictures", root: "/home/ana/Pictures", connectedFolderId: null }] };
    if (path === "/api/volumes") return { volumes: [{ id: "volume-1", name: "USB Stick", mountPath: "/run/media/ana/USB Stick", totalBytes: 100, freeBytes: 50, ejectable: true, fileSystem: "vfat" }] };
    if (path.startsWith("/api/volume-space")) return { totalBytes: 100 * 1024 ** 3, freeBytes: 40.2 * 1024 ** 3 };
    if (path.startsWith("/api/standard-folders/home/tree")) return { tree: [folder("Notes"), file("budget.txt")] };
    return undefined;
  };
}

function view(module: Awaited<ReturnType<typeof createFileManagerHarness>>["module"], props: Record<string, unknown> = {}) {
  return createElement(module.FileManagerView, {
    connectedFolder: null, connectedFolders: [], agent: { ready: true, configured: false } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
    ...props,
  });
}

/** Waits for something to be drawn, and returns it. */
async function find<T>(dom: { waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void> }, get: () => T | null | undefined): Promise<T> {
  await dom.waitFor(() => Boolean(get()));
  return get()!;
}

const buttons = (dom: { container: HTMLElement }) => [...dom.container.querySelectorAll("button")].map((button) => button.textContent?.trim());

test("with no Connected Folder the window is a file manager at the home folder, with Trash, Drives, and free space", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers());
  await dom.render(view(module));
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="budget.txt"]') !== null);
  assert.ok(requests.some((item) => item.path.startsWith("/api/standard-folders/home/tree")), "it lists the home folder");
  const sidebar = dom.container.querySelector(".fm-sidebar")!.textContent!;
  assert.match(sidebar, /Trash/);
  assert.match(sidebar, /Drives/);
  assert.match(sidebar, /USB Stick/);
  assert.ok(dom.container.querySelector('[aria-label="Eject USB Stick"]'), "an ejectable drive has Eject");
  await dom.waitFor(() => dom.container.querySelector(".fm-status")?.textContent === "2 items, 40.2 GB available");
  // Where a Chat would be: Connect This Folder, and Set Up AI since none is connected.
  assert.ok(buttons(dom).includes("Connect This Folder"));
  assert.ok(buttons(dom).includes("Set Up AI…"));
  assert.ok(!requests.some((item) => item.path.includes("/automations")), "no Connected Folder, no Automations read");
});

test("a drive opens in the computer place at its mount path, and Eject says the host's reason when it refuses", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path, options) => {
    if (path === "/api/volumes/eject") throw new Error("“USB Stick” is in use. Close the files and apps using it, then try again.");
    if (path.startsWith("/api/standard-folders/computer/tree")) return { tree: [file("run/media/ana/USB Stick/photo.jpg")] };
    return undefined;
  }));
  await dom.render(view(module));
  const usb = await find(dom, () => [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-drive .fm-sidebar-item")].find((button) => button.textContent === "USB Stick"));
  await dom.act(() => { usb!.click(); });
  await dom.waitFor(() => requests.some((item) => item.path.startsWith("/api/standard-folders/computer/tree") && item.path.includes("path=run%2Fmedia%2Fana%2FUSB+Stick")));
  await dom.waitFor(() => dom.container.querySelector('.fm-drive .is-current')?.textContent === "USB Stick");
  await dom.act(() => { dom.container.querySelector<HTMLButtonElement>('[aria-label="Eject USB Stick"]')!.click(); });
  await dom.waitFor(() => requests.some((item) => item.path === "/api/volumes/eject"));
  assert.deepEqual(requests.find((item) => item.path === "/api/volumes/eject")!.body, { volumeId: "volume-1" });
});

test("the Trash view lists the system Trash, and a permanent action sends nothing without a yes", async (t) => {
  const listing = { items: [{ id: "trash-1", name: "old.txt", originalPath: "/home/ana/old.txt", deletedAt: at, kind: "file", sizeBytes: 4, trash: "home", volumePath: null, canPutBack: true }], truncated: false, putBackAvailable: true };
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path) => path === "/api/trash" ? listing : undefined));
  await dom.render(view(module));
  const trash = await find(dom, () => [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((button) => button.textContent === "Trash"));
  await dom.act(() => { trash!.click(); });
  const row = await find(dom, () => dom.container.querySelector<HTMLElement>('[data-trash-id="trash-1"]'));
  assert.match(row!.textContent!, /old\.txt/);
  assert.match(row!.textContent!, /\/home\/ana/);
  assert.equal(dom.container.querySelector(".fm-title-text")?.textContent, "Trash");
  assert.match(dom.container.querySelector(".fm-trash-about")!.textContent!, /Recently Deleted in Settings/);
  await dom.act(() => { row!.click(); });
  const deleteButton = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete Immediately…")!;
  assert.equal(deleteButton.disabled, false);
  // No dialog is there to answer (the harness mounts none), which reads as no: nothing is deleted.
  await dom.act(async () => { deleteButton.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  const empty = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Empty Trash…")!;
  await dom.act(async () => { empty.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.ok(!requests.some((item) => item.path === "/api/trash/delete" || item.path === "/api/trash/empty"), "neither permanent action ran");
  // Leaving the Trash for a folder goes back to the folder's list.
  const home = [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((button) => button.textContent === "ana")!;
  await dom.act(() => { home.click(); });
  await dom.waitFor(() => !dom.container.querySelector(".fm-trash"));
});

test("Search in a plain folder asks the host's folder search, shows where each match is, and goes on when asked", async (t) => {
  let pages = 0;
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path) => {
    if (!path.startsWith("/api/standard-folders/home/search")) return undefined;
    pages += 1;
    return pages === 1
      ? { query: "lemon", names: [{ path: "Notes/lemon.txt", name: "lemon.txt", kind: "file" }], files: [], chats: [], connectedFolders: [], truncated: true, scannedFiles: 20000, nextCursor: "cursor-1", coverage: { stoppedBy: "time", complete: false, unreadable: 0, visitedEntries: 1, scannedBytes: 1 } }
      : { query: "lemon", names: [], files: [{ path: "budget.txt", line: 1, preview: "Lemon budget", sizeBytes: 9, updatedAt: at }], chats: [], connectedFolders: [], truncated: false, scannedFiles: 4, nextCursor: null, coverage: { stoppedBy: null, complete: true, unreadable: 0, visitedEntries: 1, scannedBytes: 1 } };
  }));
  await dom.render(view(module));
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="budget.txt"]') !== null);
  const field = dom.container.querySelector<HTMLInputElement>(".fm-search input")!;
  await dom.act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, "lemon");
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await dom.waitFor(() => dom.container.querySelector('[data-fm-result]') !== null);
  const first = requests.find((item) => item.path.startsWith("/api/standard-folders/home/search"))!;
  assert.equal(first.path, "/api/standard-folders/home/search?q=lemon", "hidden items only while Show Hidden Files is on");
  const rows = () => [...dom.container.querySelectorAll(".fm-content [data-fm-result]")].map((row) => row.textContent);
  assert.match(rows()[0]!, /lemon\.txt.*Name.*ana › Notes/);
  assert.match(dom.container.querySelector(".fm-search-note")!.textContent!, /stopped after a few seconds, having read 20,000 files/);
  assert.ok(!dom.container.querySelector(".fm-ask-row"), "a plain folder has no Worker to ask");
  assert.ok(!buttons(dom).includes("All Connected Folders"), "with none registered there is nothing else to search");
  const keepSearching = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Keep Searching")!;
  await dom.act(() => { keepSearching.click(); });
  await dom.waitFor(() => rows().length === 2);
  assert.ok(requests.some((item) => item.path === "/api/standard-folders/home/search?q=lemon&cursor=cursor-1"));
  assert.match(rows()[1]!, /budget\.txt.*Lemon budget/);
  assert.equal(dom.container.querySelector(".fm-search-note"), null, "the search reached the end");
});

test("Info measures a selected folder, saying Calculating… first, and the list's Size column fills in", async (t) => {
  let release: (() => void) | null = null;
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path) => {
    if (path.startsWith("/api/standard-folders/home/folder-size")) {
      return new Promise((resolve) => { release = () => resolve({ folderSize: size({ path: "Notes", bytes: 2048, items: 3, stoppedBy: "item-limit", complete: false }) }); });
    }
    if (path.startsWith("/api/standard-folders/home/file-info")) return { modifiedAt: at };
    return undefined;
  }));
  await dom.render(view(module));
  const notes = await find(dom, () => dom.container.querySelector<HTMLElement>('[data-fm-path="Notes"]'));
  assert.equal(notes!.querySelector(".fm-col-size")!.textContent, "--", "nothing measures a folder the list merely shows");
  assert.ok(!requests.some((item) => item.path.includes("/folder-size")));
  await dom.act(() => { notes!.click(); });
  await dom.waitFor(() => (dom.container.querySelector(".fm-panel")?.textContent ?? "").includes("Calculating…"));
  await dom.waitFor(() => requests.some((item) => item.path === "/api/standard-folders/home/folder-size?path=Notes"));
  await dom.act(() => { release!(); });
  await dom.waitFor(() => (dom.container.querySelector(".fm-panel")?.textContent ?? "").includes("At least 2.0 KB"));
  assert.match(dom.container.querySelector(".fm-panel")!.textContent!, /More than 3 items/);
  // Why the figure is a minimum is on the Size row for anyone who points at it, never loose text under the list.
  assert.doesNotMatch(dom.container.querySelector(".fm-panel")!.textContent!, /counting stopped/i);
  assert.match([...dom.container.querySelectorAll<HTMLElement>(".fm-panel .fm-crow-v")].find((value) => value.textContent === "At least 2.0 KB")?.title ?? "", /counting stopped after 3 items, so the size is a minimum/);
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="Notes"] .fm-col-size')?.textContent === "≥ 2.0 KB");
});

test("icon view asks for thumbnails only for the tiles it draws, never for every item in a large folder", async (t) => {
  const many = Array.from({ length: 3000 }, (_, index) => file(`photo-${String(index).padStart(4, "0")}.png`, 100 + index));
  const { dom, module } = await createFileManagerHarness(t, answers((path) => path.startsWith("/api/standard-folders/home/tree") ? { tree: many } : undefined));
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(null, { status: 415 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  await dom.render(view(module));
  await dom.waitFor(() => dom.container.querySelector('[data-fm-path="photo-0000.png"]') !== null);
  assert.equal(asked.length, 0, "the list view asks for none");
  await dom.act(() => { dom.container.querySelector<HTMLButtonElement>('[aria-label="Icons"]')!.click(); });
  await dom.waitFor(() => asked.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const drawn = dom.container.querySelectorAll(".fm-tile").length;
  assert.ok(drawn < 400, `only tiles near the view are drawn (${drawn})`);
  assert.ok(asked.length <= drawn, `thumbnails asked (${asked.length}) for drawn tiles only (${drawn})`);
  assert.ok(asked.every((url) => url.includes("/api/standard-folders/home/thumbnail?") && /[?&]v=\d+-\d+/.test(url)));
  assert.ok(dom.container.querySelector('[data-fm-path="photo-0000.png"] .fm-ic'), "a refused thumbnail keeps the icon");
});
