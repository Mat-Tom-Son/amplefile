import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { ConnectedFolderSummary, TreeEntry } from "../web-local/src/types.js";

// The folder list as a person uses it, in the real window (jsdom, a mocked
// local API): Show Hidden Files and the requests it makes, a large folder that
// draws only the rows in view, symbolic link rows, dragging a selection, and
// the selection rectangle. jsdom has no layout, so the scrolled contents are
// given a size here; the stylesheet is not loaded, so rows are the window's
// default 26px from the top of the list.
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const file = (name: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({ kind: "file", path: name, name, updatedAt: "2026-09-27T12:00:00Z", sizeBytes: 10, ...extra } as TreeEntry);
const folder = (name: string, extra: Partial<TreeEntry> = {}): TreeEntry => ({ kind: "folder", path: name, name, updatedAt: "2026-09-27T12:00:00Z", ...extra } as TreeEntry);
const internalDragType = "application/x-amplefile-items";

function answers(tree: (path: string) => TreeEntry[], extra: ApiAnswer = () => undefined): ApiAnswer {
  return (path, options) => {
    const value = extra(path, options);
    if (value !== undefined) return value;
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true, provider: "test", model: "synthetic" } };
    if (path.startsWith("/api/agent/composer")) return { composer: { model: { provider: "test", id: "synthetic", name: "Synthetic" }, thinkingLevel: "off", thinkingLevels: ["off"] } };
    if (path === "/api/standard-folders") return { folders: [{ id: "downloads", name: "Downloads", root: "/home/ana/Downloads", connectedFolderId: null }] };
    if (path.includes("/tree")) return { tree: tree(path) };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations")) return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    if (path.includes("/file-info")) return { modifiedAt: "2026-09-27T12:00:00Z" };
    return undefined;
  };
}

function view(module: Awaited<ReturnType<typeof createFileManagerHarness>>["module"]) {
  return createElement(module.FileManagerView, {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  });
}

/** The scrolled contents get a size and a scroll position jsdom does not lay out. */
function giveContentsASize(t: test.TestContext, size = { width: 800, height: 520 }) {
  const scrolls = new WeakMap<Element, number>();
  const restore: Array<() => void> = [];
  const define = (target: object, key: string, descriptor: PropertyDescriptor) => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restore.push(() => previous ? Object.defineProperty(target, key, previous) : delete (target as Record<string, unknown>)[key]);
  };
  const isContents = (element: Element) => element.classList.contains("fm-content");
  define(HTMLElement.prototype, "clientHeight", { get(this: HTMLElement) { return isContents(this) ? size.height : 0; } });
  define(HTMLElement.prototype, "clientWidth", { get(this: HTMLElement) { return isContents(this) ? size.width : this.classList.contains("fm-rows") || this.classList.contains("fm-grid") ? size.width : 0; } });
  define(Element.prototype, "scrollTop", { get(this: Element) { return scrolls.get(this) ?? 0; }, set(this: Element, value: number) { scrolls.set(this, Math.max(0, value)); } });
  t.after(() => { for (const undo of restore.reverse()) undo(); });
}

const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-fm-path]")];
const row = (container: HTMLElement, path: string) => container.querySelector<HTMLElement>(`[data-fm-path="${path}"]`);
const contents = (container: HTMLElement) => container.querySelector<HTMLElement>(".fm-content")!;
const treeRequests = (requests: Array<{ path: string }>) => requests.filter((request) => request.path.includes("/tree"));

test("Show Hidden Files: hidden items appear dimmed on the system's key, and a Standard Folder asks for them", async (t) => {
  const { dom, module, requests, streams } = await createFileManagerHarness(t, answers((path) => path.startsWith("/api/standard-folders/downloads")
    ? [file("invoice.pdf"), ...(path.includes("includeHidden=1") ? [file(".partial", { hidden: true })] : [])]
    : [file("a.md"), file(".env", { hidden: true }), folder(".config", { hidden: true })]));
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(row(dom.container, "a.md")));

  // Every listing asks for links and the whole bound; a Connected Folder's always carries the hidden marker.
  const first = treeRequests(requests).at(-1)!.path;
  assert.match(first, /includeLinks=1/);
  assert.match(first, /maxEntries=200000/);
  assert.match(first, /includeHidden=1/);
  assert.equal(row(dom.container, ".env"), null, "hidden items stay out while the toggle is off");

  contents(dom.container).focus();
  await dom.press("h", { ctrlKey: true, code: "KeyH" });
  await dom.waitFor(() => Boolean(row(dom.container, ".env")));
  assert.ok(row(dom.container, ".env")!.classList.contains("is-hidden"), "a hidden item is drawn dimmed");
  assert.ok(row(dom.container, ".config")!.classList.contains("is-hidden"));
  assert.equal(row(dom.container, "a.md")!.classList.contains("is-hidden"), false);
  await dom.press("h", { ctrlKey: true, code: "KeyH" });
  await dom.waitFor(() => !row(dom.container, ".env"));

  // A Standard Folder leaves hidden entries out of its listing and its events unless asked.
  const downloads = [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((item) => item.textContent?.includes("Downloads"))!;
  await dom.act(() => downloads.click());
  await dom.waitFor(() => Boolean(row(dom.container, "invoice.pdf")));
  const plain = treeRequests(requests).filter((request) => request.path.startsWith("/api/standard-folders/downloads")).at(-1)!.path;
  assert.doesNotMatch(plain, /includeHidden/);
  assert.match(plain, /includeLinks=1/);
  assert.ok(streams.has("/api/standard-folders/downloads/events"));

  contents(dom.container).focus();
  await dom.press("h", { ctrlKey: true, code: "KeyH" });
  await dom.waitFor(() => Boolean(row(dom.container, ".partial")));
  assert.match(treeRequests(requests).at(-1)!.path, /^\/api\/standard-folders\/downloads\/tree\?.*includeHidden=1/);
  assert.ok(streams.has("/api/standard-folders/downloads/events?includeHidden=1"), "its file events include hidden entries too");
  assert.ok(row(dom.container, ".partial")!.classList.contains("is-hidden"));
});

test("Show Hidden Files follows the View menu's command and keeps its check mark current", async (t) => {
  const states: unknown[] = [];
  const { dom, module } = await createFileManagerHarness(t, answers(() => [file("a.md"), file(".env", { hidden: true })]));
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = { menu: { setState: (state: unknown) => states.push(state) } };
  t.after(() => { delete scope.ampleFileDesktop; });
  let action = { id: 1, command: "noop" };
  const render = () => dom.render(createElement(module.FileManagerView, {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null, desktopAction: action,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  }));
  await render();
  await dom.waitFor(() => Boolean(row(dom.container, "a.md")));
  assert.deepEqual(states.at(-1), { showHiddenFiles: false });
  action = { id: 2, command: "toggle-hidden-files" };
  await render();
  await dom.waitFor(() => Boolean(row(dom.container, ".env")));
  assert.deepEqual(states.at(-1), { showHiddenFiles: true });
});

test("a folder of thousands draws only the rows in view, and selection, keys, and screen-reader counts cover all of them", async (t) => {
  const big = Array.from({ length: 5_000 }, (_, index) => file(`item-${String(index).padStart(5, "0")}.txt`));
  const { dom, module } = await createFileManagerHarness(t, answers(() => big));
  giveContentsASize(t);
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(row(dom.container, "item-00000.txt")));
  await dom.settle();
  const grid = contents(dom.container);
  assert.ok(rows(dom.container).length < 60, `drew ${rows(dom.container).length} rows of 5,000`);
  assert.equal(grid.getAttribute("aria-rowcount"), "5001", "the headings and every row");
  assert.equal(row(dom.container, "item-00002.txt")!.getAttribute("aria-rowindex"), "4");
  assert.equal(dom.container.querySelector<HTMLElement>(".fm-rows")!.style.height, `${5_000 * 26}px`, "the list is as tall as every row");

  grid.focus();
  await dom.press("a", { ctrlKey: true });
  assert.equal(dom.container.querySelector(".fm-status")!.textContent, "5000 of 5000 selected");
  await dom.press("Escape");

  // Arrow up with nothing selected goes to the last item: the list scrolls there and draws it.
  await dom.press("ArrowUp");
  await dom.settle();
  assert.equal(grid.scrollTop, 5_000 * 26 - 520, "the last row's bottom at the view's bottom");
  await dom.act(() => { grid.dispatchEvent(new Event("scroll")); });
  await dom.settle();
  await dom.waitFor(() => Boolean(row(dom.container, "item-04999.txt")));
  assert.equal(row(dom.container, "item-04999.txt")!.getAttribute("aria-selected"), "true");
  assert.ok(document.getElementById(grid.getAttribute("aria-activedescendant")!), "the active row exists");
  assert.equal(row(dom.container, "item-00000.txt"), null, "rows scrolled away are not drawn");

  // Typing a name jumps to it wherever it is.
  for (const key of "item-02500") await dom.press(key);
  await dom.settle();
  await dom.act(() => { grid.dispatchEvent(new Event("scroll")); });
  await dom.settle();
  await dom.waitFor(() => row(dom.container, "item-02500.txt")?.getAttribute("aria-selected") === "true");
  // Shift-Arrow extends from there.
  await dom.press("ArrowDown", { shiftKey: true });
  await dom.press("ArrowDown", { shiftKey: true });
  assert.equal(dom.container.querySelector(".fm-status")!.textContent, "3 of 5000 selected");

  // Icon view draws rows of tiles the same way, and its arrows step a row of tiles.
  const icons = dom.container.querySelector<HTMLButtonElement>('button[aria-label="Icons"]')!;
  await dom.act(() => icons.click());
  await dom.settle();
  const columns = Number(grid.getAttribute("aria-colcount"));
  assert.ok(columns > 1, `${columns} tiles to a row`);
  assert.equal(grid.getAttribute("aria-rowcount"), String(Math.ceil(5_000 / columns)));
  assert.ok(rows(dom.container).length < 5_000 / 4, `drew ${rows(dom.container).length} tiles of 5,000`);
  await dom.press("Escape");
  await dom.press("ArrowDown");
  await dom.press("ArrowDown");
  assert.equal(dom.container.querySelector(".fm-status")!.textContent, "1 of 5000 selected");
  await dom.settle();
  assert.equal(document.getElementById(grid.getAttribute("aria-activedescendant")!)?.dataset.fmPath, `item-${String(columns).padStart(5, "0")}.txt`);
});

test("a symbolic link says what it is, opens where it points, and offers only Open, Show, and Copy Path", async (t) => {
  const tree = [
    folder("Docs"),
    folder("Docs link", { link: { target: "folder", targetPath: "/tmp/lab/Docs" }, hasChildren: false }),
    file("notes link", { link: { target: "file", targetPath: "/elsewhere/notes.txt" } }),
    file("gone link", { link: { target: "missing", targetPath: "/tmp/lab/gone.txt" } }),
  ];
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path) => path.includes("path=Docs") ? [file("inside.md")] : tree, (path) => path.startsWith("/api/folder-location")
    ? { location: { place: { kind: "connected-folder", id: "lab" }, path: "Docs", select: null } }
    : undefined));
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(row(dom.container, "Docs link")));
  const kind = (path: string) => row(dom.container, path)!.querySelector(".fm-col-kind")!.textContent;
  assert.equal(kind("Docs link"), "Link to Folder");
  assert.equal(kind("notes link"), "Link to Plain text");
  assert.equal(kind("gone link"), "Broken Link");
  assert.ok(row(dom.container, "notes link")!.querySelector(".fm-link-badge"), "a link carries the link badge");
  assert.equal(row(dom.container, "notes link")!.getAttribute("draggable"), "false");
  assert.equal(row(dom.container, "Docs")!.getAttribute("draggable"), "true", "a folder drags as a file does");

  const menuFor = async (path: string) => {
    await dom.act(() => { row(dom.container, path)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    const items = [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-menu .fm-menu-i")].map((item) => item.textContent);
    await dom.act(() => { dom.container.querySelector<HTMLElement>(".fm-menu-back")?.click(); });
    return items;
  };
  assert.deepEqual(await menuFor("Docs link"), ["Open Folder", "Show in File Manager", "Copy Link Path"]);
  assert.deepEqual(await menuFor("notes link"), ["Open", "Show in File Manager", "Copy Link Path"]);
  assert.deepEqual(await menuFor("gone link"), ["Show in File Manager", "Copy Link Path"]);

  // Return does not rename a link, and Command-Delete does not delete one.
  await dom.act(() => row(dom.container, "notes link")!.click());
  contents(dom.container).focus();
  await dom.press("Enter");
  assert.equal(document.querySelector('[role="dialog"]'), null);
  const before = requests.length;
  await dom.press("Backspace", { ctrlKey: true });
  await dom.settle();
  assert.equal(requests.slice(before).some((request) => request.method !== "GET"), false);

  // A linked folder opens where it really is: the host resolves the link again.
  await dom.act(() => { row(dom.container, "Docs link")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await dom.waitFor(() => Boolean(row(dom.container, "Docs/inside.md") ?? row(dom.container, "inside.md")));
  assert.ok(requests.some((request) => request.path === `/api/folder-location?path=${encodeURIComponent("/tmp/lab/Docs link").replace(/%20/g, "+")}`), "asked where the link's folder is");
});

/** A drag event with a data transfer jsdom does not have. */
function dragEvent(type: string, data: Record<string, string> = {}, files: Array<{ name: string }> = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const stored = { ...data };
  Object.defineProperty(event, "dataTransfer", { value: {
    get types() { return Object.keys(stored); },
    files,
    effectAllowed: "all",
    dropEffect: "none",
    setData(kind: string, value: string) { stored[kind] = value; },
    getData(kind: string) { return stored[kind] ?? ""; },
    stored,
  } });
  return event as Event & { dataTransfer: { stored: Record<string, string> } };
}

test("dragging a selected item carries the whole selection onto a folder row; an unselected one goes alone", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers(() => [file("a.md"), file("b.md"), file("c.md"), folder("Reports"), folder("Archive")], (path, options) => path === "/api/file-transfer" && options.method === "POST"
    ? { mode: "move", written: (options.body as { sources: Array<{ path: string }> }).sources.map((source) => `Archive/${source.path}`), restorePoints: [] }
    : undefined));
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(row(dom.container, "Archive")));
  await dom.act(() => row(dom.container, "a.md")!.click());
  await dom.act(() => { row(dom.container, "Reports")!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); });

  const start = dragEvent("dragstart");
  await dom.act(() => { row(dom.container, "Reports")!.querySelector(".fm-row-name")!.dispatchEvent(start); });
  const carried = JSON.parse(start.dataTransfer.stored[internalDragType]!) as { place: unknown; paths: string[] };
  assert.deepEqual(carried, { place: { kind: "connected-folder", id: "lab" }, paths: ["a.md", "Reports"] });
  assert.equal(start.dataTransfer.stored["text/plain"], "/tmp/lab/a.md\n/tmp/lab/Reports");

  // Over a folder row that is one of the items dragged, the drop goes nowhere; over another folder, there.
  const over = dragEvent("dragover", start.dataTransfer.stored);
  await dom.act(() => { row(dom.container, "Reports")!.dispatchEvent(over); });
  assert.equal(row(dom.container, "Reports")!.classList.contains("is-drop-target"), false);
  await dom.act(() => { row(dom.container, "Archive")!.dispatchEvent(dragEvent("dragover", start.dataTransfer.stored)); });
  assert.ok(row(dom.container, "Archive")!.classList.contains("is-drop-target"));
  await dom.act(() => { row(dom.container, "Archive")!.dispatchEvent(dragEvent("drop", start.dataTransfer.stored)); });
  await dom.waitFor(() => requests.some((request) => request.path === "/api/file-transfer"));
  const transfer = requests.find((request) => request.path === "/api/file-transfer")!;
  assert.deepEqual(transfer.body, {
    mode: "move",
    sources: [{ place: { kind: "connected-folder", id: "lab" }, path: "a.md" }, { place: { kind: "connected-folder", id: "lab" }, path: "Reports" }],
    target: { place: { kind: "connected-folder", id: "lab" }, path: "Archive" },
  });

  // An unselected item drags alone, and becomes the selection.
  const alone = dragEvent("dragstart");
  await dom.act(() => { row(dom.container, "c.md")!.querySelector(".fm-row-name")!.dispatchEvent(alone); });
  assert.deepEqual((JSON.parse(alone.dataTransfer.stored[internalDragType]!) as { paths: string[] }).paths, ["c.md"]);
  assert.equal(row(dom.container, "c.md")!.getAttribute("aria-selected"), "true");
  assert.equal(row(dom.container, "a.md")!.getAttribute("aria-selected"), "false");
});

test("on the desktop, a drag hands every selected item to the system drag, files and folders alike", async (t) => {
  // a.md, then Shift-click Reports: the range in shown order is a.md, b.md, Reports.
  const dragged: Array<{ id: string; paths: string[] }> = [];
  const { dom, module } = await createFileManagerHarness(t, answers(() => [file("a.md"), folder("Reports"), file("b.md")]));
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = { connectedFolder: { startDrag: async (id: string, paths: string[]) => { dragged.push({ id, paths }); return true; } } };
  t.after(() => { delete scope.ampleFileDesktop; });
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(row(dom.container, "Reports")));
  await dom.act(() => row(dom.container, "a.md")!.click());
  await dom.act(() => { row(dom.container, "Reports")!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); });
  const start = dragEvent("dragstart");
  await dom.act(() => { row(dom.container, "a.md")!.querySelector(".fm-row-name")!.dispatchEvent(start); });
  assert.equal(start.defaultPrevented, true, "the system drag replaces the page's own");
  assert.deepEqual(dragged, [{ id: "lab", paths: ["a.md", "b.md", "Reports"] }]);
});

test("dragging from empty space draws a rectangle that selects the rows it touches; Command or Shift adds to the selection", async (t) => {
  const tree = Array.from({ length: 12 }, (_, index) => file(`file-${String(index).padStart(2, "0")}.md`));
  const { dom, module } = await createFileManagerHarness(t, answers(() => tree));
  giveContentsASize(t);
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(row(dom.container, "file-11.md")));
  await dom.settle();
  const grid = contents(dom.container);
  const selectedPaths = () => rows(dom.container).filter((item) => item.getAttribute("aria-selected") === "true").map((item) => item.dataset.fmPath);
  const band = async (from: { x: number; y: number }, to: { x: number; y: number }, init: MouseEventInit = {}) => {
    await dom.act(() => { grid.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: from.x, clientY: from.y, ...init })); });
    await dom.act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 })); });
    await dom.act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: to.x, clientY: to.y })); });
    await dom.act(() => { window.dispatchEvent(new MouseEvent("mouseup", { clientX: to.x, clientY: to.y })); });
    // The click that ends the drag does not clear what it selected.
    await dom.act(() => { grid.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: to.x, clientY: to.y })); });
  };
  // Rows are 26px tall from the top of the list here: rows 2 to 5.
  await band({ x: 400, y: 26 * 2 + 5 }, { x: 600, y: 26 * 5 + 5 });
  assert.deepEqual(selectedPaths(), ["file-02.md", "file-03.md", "file-04.md", "file-05.md"]);
  assert.equal(dom.container.querySelector<HTMLElement>(".fm-band")!.style.display, "none", "the rectangle goes away");
  // With Ctrl (Command on a Mac), rows 8 and 9 join them.
  await band({ x: 400, y: 26 * 9 + 5 }, { x: 600, y: 26 * 8 + 5 }, { ctrlKey: true });
  assert.deepEqual(selectedPaths(), ["file-02.md", "file-03.md", "file-04.md", "file-05.md", "file-08.md", "file-09.md"]);
  // Without, a new rectangle starts over.
  await band({ x: 400, y: 26 * 11 + 5 }, { x: 600, y: 26 * 10 + 5 });
  assert.deepEqual(selectedPaths(), ["file-10.md", "file-11.md"]);
  // A press that does not move is a click: on empty space it clears the selection.
  await dom.act(() => { grid.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 400, clientY: 26 * 20 })); });
  await dom.act(() => { window.dispatchEvent(new MouseEvent("mouseup", { clientX: 400, clientY: 26 * 20 })); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await dom.act(() => { grid.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 400, clientY: 26 * 20 })); });
  assert.deepEqual(selectedPaths(), []);
});

test("holding a rectangle at the list's bottom edge scrolls on, selecting rows that were never drawn", async (t) => {
  const tree = Array.from({ length: 2_000 }, (_, index) => file(`row-${String(index).padStart(4, "0")}.md`));
  const { dom, module } = await createFileManagerHarness(t, answers(() => tree));
  giveContentsASize(t);
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(row(dom.container, "row-0000.md")));
  await dom.settle();
  const grid = contents(dom.container);
  await dom.act(() => { grid.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 400, clientY: 26 * 3 + 5 })); });
  // 515px is inside the bottom 28px of the 520px view.
  await dom.act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, clientY: 515 })); });
  const status = () => Number(/^(\d+) of/.exec(dom.container.querySelector(".fm-status")!.textContent ?? "")?.[1] ?? 0);
  // jsdom's frames run slowly while other suites run alongside; wait for a few dozen rows of scrolling.
  await dom.waitFor(() => grid.scrollTop > 26 * 30 && status() > 40, 20_000);
  await dom.act(() => { window.dispatchEvent(new MouseEvent("mouseup", { clientX: 400, clientY: 515 })); });
  const scrolled = grid.scrollTop;
  const selected = status();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(grid.scrollTop, scrolled, "letting go stops the scrolling");
  // Everything from row 3 to the row under the pointer, by the layout: rows that were never drawn included.
  assert.equal(selected, Math.floor((scrolled + 515) / 26) - 3 + 1);
});

test("in a Standard Folder, items from another app are copied into the folder or the row they land on, and items dragged inside move", async (t) => {
  const { dom, module, requests } = await createFileManagerHarness(t, answers((path) => path.startsWith("/api/standard-folders/downloads")
    ? [file("invoice.pdf"), file("receipt.pdf"), folder("Taxes")]
    : [file("a.md")], (path, options) => path === "/api/file-transfer" && options.method === "POST" ? { mode: (options.body as { mode: string }).mode, written: ["Taxes/x"], restorePoints: [] } : undefined));
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = { agent: { getPathForFile: (dropped: { name: string }) => `/home/ana/Desktop/${dropped.name}` } };
  t.after(() => { delete scope.ampleFileDesktop; });
  await dom.render(view(module));
  await dom.waitFor(() => Boolean(row(dom.container, "a.md")));
  const downloads = [...dom.container.querySelectorAll<HTMLButtonElement>(".fm-sidebar-item")].find((item) => item.textContent?.includes("Downloads"))!;
  await dom.act(() => downloads.click());
  await dom.waitFor(() => Boolean(row(dom.container, "Taxes")));
  const place = { kind: "standard", id: "downloads" };
  const transfers = () => requests.filter((request) => request.path === "/api/file-transfer").map((request) => request.body);

  // From another app, onto the empty list: copied into the folder shown, and the list takes the drop.
  const over = dragEvent("dragover", { Files: "" }, [{ name: "scan.png" }]);
  await dom.act(() => { contents(dom.container).dispatchEvent(over); });
  assert.equal(over.defaultPrevented, true, "the list accepts the drop");
  assert.equal((over as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect, "copy");
  await dom.act(() => { contents(dom.container).dispatchEvent(dragEvent("drop", { Files: "" }, [{ name: "scan.png" }])); });
  // Onto a folder row: copied into that folder.
  await dom.act(() => { row(dom.container, "Taxes")!.dispatchEvent(dragEvent("drop", { Files: "" }, [{ name: "w2.pdf" }])); });
  await dom.waitFor(() => transfers().length === 2);
  assert.deepEqual(transfers(), [
    { mode: "copy", sources: [{ nativePath: "/home/ana/Desktop/scan.png" }], target: { place, path: "" } },
    { mode: "copy", sources: [{ nativePath: "/home/ana/Desktop/w2.pdf" }], target: { place, path: "Taxes" } },
  ]);

  // Dragged inside the window onto a folder row: moved there.
  scope.ampleFileDesktop = { agent: {} };
  await dom.act(() => row(dom.container, "invoice.pdf")!.click());
  await dom.act(() => { row(dom.container, "receipt.pdf")!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); });
  const start = dragEvent("dragstart");
  await dom.act(() => { row(dom.container, "invoice.pdf")!.querySelector(".fm-row-name")!.dispatchEvent(start); });
  await dom.act(() => { row(dom.container, "Taxes")!.dispatchEvent(dragEvent("drop", start.dataTransfer.stored)); });
  await dom.waitFor(() => transfers().length === 3);
  assert.deepEqual(transfers()[2], { mode: "move", sources: [{ place, path: "invoice.pdf" }, { place, path: "receipt.pdf" }], target: { place, path: "Taxes" } });
});
