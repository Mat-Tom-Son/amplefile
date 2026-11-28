import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";
import type { ConnectedFolderIndexStatus } from "../src/local/index/indexer.js";
import type { RecallCoverage, RecallHit, RecallResult } from "../src/local/index/recall.js";

// Best Matches in Search, the index row and Related in Info, and the @ menu in
// the window's Chat, in the real file manager window (jsdom, a mocked local API).
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const inner = { id: "inner", name: "Inner", connectedFolderRoot: "/tmp/lab/inner", location: { storage: "linked" } } as ConnectedFolderSummary;
const other = { id: "other", name: "Garden", connectedFolderRoot: "/tmp/garden", location: { storage: "linked" } } as ConnectedFolderSummary;
const at = "2026-11-27T10:00:00.000Z";

const entry = (name: string) => ({ kind: "file", name, path: name });
const tree = [entry("a.md"), entry("b.md"), entry("c.md")];

function fileHit(path: string, location: RecallHit["location"], extra: Partial<RecallHit> = {}): RecallHit {
  return { source: "file", path, location, excerpt: `Text from ${path}`, score: 0.03, reasons: ["lexical"], sha256: "0".repeat(64), indexedAt: at, fresh: true, ...extra } as RecallHit;
}
const chatHit: RecallHit = { source: "chat", conversationId: "chat-9", messageId: "m1", title: "Tax questions", role: "assistant", createdAt: at, location: {}, excerpt: "We talked about the deduction.", score: 0.02, reasons: ["semantic"], sha256: "1".repeat(64), indexedAt: at, fresh: true };

function coverage(extra: Partial<RecallCoverage> = {}): RecallCoverage {
  return {
    state: "complete", complete: true, chatMessages: 12, chunks: { total: 10, embedded: 10 }, embedder: "mac-natural-language", ranking: "hybrid", lastSyncAt: at, running: false, walk: { complete: true, stoppedBy: null, excluded: {} }, staleHits: 0,
    files: { indexed: 3, pending: 0, "not-downloaded": 0, binary: 0, "too-large": 0, unsupported: 0, unreadable: 0 },
    ...extra,
  };
}

interface Backend {
  hits: RecallHit[];
  coverage: RecallCoverage;
  /** Leaves `ranked` out of a search, as a host that cannot rank does. */
  noRanked: boolean;
  status: ConnectedFolderIndexStatus | null;
  related: RecallHit[] | "refuse";
  searches: string[];
  similar: string[];
  indexReads: number;
}

const backend = (extra: Partial<Backend> = {}): Backend => ({ hits: [], coverage: coverage(), noRanked: false, status: null, related: [], searches: [], similar: [], indexReads: 0, ...extra });

function answerFor(state: Backend): ApiAnswer {
  return (path) => {
    const url = new URL(path, "http://local");
    if (url.pathname === "/api/connected-folders/lab/search") {
      if (url.searchParams.get("similarTo")) {
        state.similar.push(url.searchParams.get("similarTo")!);
        if (state.related === "refuse") throw new Error("That file is not indexed yet.");
        return { similarTo: url.searchParams.get("similarTo"), ranked: { query: "", hits: state.related, coverage: coverage() } };
      }
      state.searches.push(path);
      const ranked: RecallResult = { query: url.searchParams.get("q")!, hits: state.hits, coverage: state.coverage };
      return {
        names: [entry("tax-notes.md")], files: [{ path: "a.md", line: 1, preview: "tax report" }], truncated: false,
        coverage: { names: { visitedEntries: 2, complete: true }, textComplete: true, complete: true },
        ...(state.noRanked ? {} : { ranked }),
      };
    }
    if (url.pathname === "/api/connected-folders/lab/index") {
      state.indexReads += 1;
      if (!state.status) throw new Error("No index.");
      return { index: state.status };
    }
    if (url.pathname === "/api/connected-folders/outline") {
      return { connectedFolders: [
        { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", rolePurpose: "The lab’s notes." },
        { id: "inner", name: "Inner", connectedFolderRoot: "/tmp/lab/inner", rolePurpose: "Inner experiments." },
        { id: "other", name: "Garden", connectedFolderRoot: "/tmp/garden" },
      ] };
    }
    if (path === "/api/connected-folders/lab/role") return { role: null };
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true } };
    if (path.startsWith("/api/agent/composer")) return { composer: null };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path.includes("/tree")) return { tree };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations")) return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    if (path.includes("/file-info")) return { modifiedAt: at };
    return undefined;
  };
}

async function mountWindow(t: Parameters<typeof createFileManagerHarness>[0], state: Backend, folders: ConnectedFolderSummary[] = [lab]) {
  const harness = await createFileManagerHarness(t, answerFor(state));
  const opened: unknown[][] = [];
  const scope = window as unknown as { ampleFileDesktop?: unknown };
  scope.ampleFileDesktop = { connectedFolder: { openPath: async (...args: unknown[]) => { opened.push(args); } } };
  t.after(() => { delete scope.ampleFileDesktop; });
  await harness.dom.render(createElement(harness.module.FileManagerView, {
    connectedFolder: lab, connectedFolders: folders, agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  }));
  const { container } = harness.dom;
  await harness.dom.waitFor(() => Boolean(container.querySelector('[data-fm-path="a.md"]')));
  const field = container.querySelector<HTMLInputElement>(".fm-search input")!;
  const searchFor = (query: string) => harness.dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, query);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const row = (path: string) => container.querySelector<HTMLElement>(`[data-fm-path="${path}"]`)!;
  const click = (element: Element) => harness.dom.act(() => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  return { ...harness, container, opened, searchFor, row, click, best: () => container.querySelector<HTMLElement>(".fm-best") };
}

const hitsOf = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".fm-best-hit")];

test("Search shows Best Matches above the name and text results, each with its place, location, and excerpt", async (t) => {
  const state = backend({ hits: [
    fileHit("Taxes/2025/Return.pdf", { page: 3 }, { excerpt: "# The **deduction** for home office use" }),
    fileHit("Notes.md", { lines: { start: 12, end: 18 }, headings: ["Receipts", "Missing"] }),
    fileHit("Budget.xlsx", { sheet: "Budget", rows: { start: 2, end: 40 } }),
    chatHit,
  ] });
  const view = await mountWindow(t, state);
  await view.searchFor("tax");
  await view.dom.waitFor(() => hitsOf(view.container).length === 4);
  const best = view.best()!;
  assert.equal(best.querySelector("h2")?.textContent, "Best Matches");
  const hits = hitsOf(view.container);
  assert.deepEqual(hits.map((hit) => hit.querySelector(".fm-best-name")?.textContent), ["Return.pdf", "Notes.md", "Budget.xlsx", "Tax questions"]);
  assert.equal(hits[0]!.querySelector(".fm-best-where")?.textContent, "Taxes › 2025");
  assert.equal(hits[0]!.querySelector(".fm-best-meta")?.textContent, "Page 3");
  assert.equal(hits[0]!.querySelector(".fm-best-excerpt")?.textContent, "The deduction for home office use", "Markdown marks are left out of the excerpt");
  assert.equal(hits[1]!.querySelector(".fm-best-meta")?.textContent, "Lines 12–18 · “Missing”");
  assert.equal(hits[2]!.querySelector(".fm-best-meta")?.textContent, "Sheet “Budget”, rows 2–40");
  assert.equal(hits[3]!.querySelector(".fm-best-where")?.textContent, "Chat");
  // Above the existing results, which are as they were.
  assert.ok(best.compareDocumentPosition(view.container.querySelector(".fm-list-head")!) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.deepEqual([...view.container.querySelectorAll("[data-fm-result] .fm-row-name")].map((item) => item.textContent), ["tax-notes.md", "a.md"]);
  assert.equal(view.container.querySelector("[data-fm-result] .fm-col-match mark")?.textContent, "tax");
  assert.ok(view.container.querySelector(".fm-ask-row"), "Ask the Worker is still there");
  // Nothing says the index is catching up, or how it ranked.
  assert.equal(best.querySelector(".fm-best-note"), null);
  assert.doesNotMatch(best.textContent ?? "", /indexing|lexical|words/i);
});

test("typing asks once, after the debounce, and the ranked search rides on the same request", async (t) => {
  const state = backend({ hits: [fileHit("Notes.md", { lines: { start: 1, end: 1 } })] });
  const view = await mountWindow(t, state);
  for (const text of ["t", "ta", "tax"]) await view.searchFor(text);
  await view.dom.waitFor(() => hitsOf(view.container).length === 1);
  assert.equal(state.searches.length, 1, "one request for the three keystrokes");
  const url = new URL(state.searches[0]!, "http://local");
  assert.equal(url.searchParams.get("q"), "tax");
  assert.equal(url.searchParams.get("ranked"), "1");
  assert.ok(Number(url.searchParams.get("rankedLimit")) >= 1);
  assert.equal(url.searchParams.get("scope"), "files", "the live search stays on files");
  assert.equal(url.searchParams.get("rankedScope"), "all", "the ranked part also covers Chats at the top of the Connected Folder");
});

test("opening a Best Match does what opening the same file or Chat does elsewhere", async (t) => {
  const state = backend({ hits: [fileHit("Taxes/Return.pdf", { page: 3 }), chatHit] });
  const view = await mountWindow(t, state);
  await view.searchFor("tax");
  await view.dom.waitFor(() => hitsOf(view.container).length === 2);
  await view.click(hitsOf(view.container)[0]!);
  await view.dom.waitFor(() => view.opened.length === 1);
  assert.deepEqual(view.opened, [["lab", "Taxes/Return.pdf", "open"]], "the same native open as a double-clicked result");
  await view.click(hitsOf(view.container)[1]!);
  await view.dom.waitFor(() => view.container.querySelector(".fm-ph-t")?.textContent === "Tax questions");
  assert.equal(view.container.querySelector("aside.fm-panel")?.classList.contains("is-chat"), true, "the Chat opens in the panel");
});

test("a hit that changed since it was indexed is still shown, marked quietly", async (t) => {
  const state = backend({ hits: [fileHit("Old.md", { lines: { start: 1, end: 2 } }, { fresh: false }), fileHit("New.md", { lines: { start: 1, end: 2 } })] });
  const view = await mountWindow(t, state);
  await view.searchFor("tax");
  await view.dom.waitFor(() => hitsOf(view.container).length === 2);
  const [old, fresh] = hitsOf(view.container);
  assert.equal(old!.querySelector(".fm-best-stale")?.textContent, "Changed since indexed");
  assert.match(old!.querySelector(".fm-best-meta")?.textContent ?? "", /Lines 1–2/);
  assert.equal(fresh!.querySelector(".fm-best-stale"), null);
});

test("while the index is still running or incomplete one quiet line says so, with the real counts", async (t) => {
  const running = coverage({ state: "partial", complete: false, running: true, files: { indexed: 1204, pending: 56, "not-downloaded": 0, binary: 0, "too-large": 0, unsupported: 0, unreadable: 0 } });
  const state = backend({ hits: [fileHit("Notes.md", { lines: { start: 1, end: 1 } })], coverage: running });
  const view = await mountWindow(t, state);
  await view.searchFor("tax");
  await view.dom.waitFor(() => Boolean(view.container.querySelector(".fm-best-note")));
  assert.equal(view.container.querySelector(".fm-best-note")?.textContent, "Still indexing (1,204 of 1,260 files); results may be incomplete.");
  assert.equal(hitsOf(view.container).length, 1, "hits still show");

  // Never indexed: no counts to speak of, and none shown as zero.
  state.coverage = coverage({ state: "not-indexed", complete: false, files: null, chatMessages: null, chunks: null, walk: null });
  state.hits = [];
  await view.searchFor("tax notes");
  await view.dom.waitFor(() => view.container.querySelector(".fm-best-note")?.textContent === "Still indexing; results may be incomplete.");
  assert.equal(view.container.querySelector(".fm-best-h"), null, "no hits, no Best Matches heading");
  assert.ok(view.container.querySelector("[data-fm-result]"), "the existing results are still listed");

  // Done syncing but not everything read (a walk bound): a different, still quiet, line.
  state.coverage = coverage({ complete: false, state: "partial" });
  await view.searchFor("tax notes more");
  await view.dom.waitFor(() => /^Not every file is in the index/.test(view.container.querySelector(".fm-best-note")?.textContent ?? ""));

  // Complete: nothing to say.
  state.coverage = coverage();
  state.hits = [fileHit("Notes.md", { lines: { start: 1, end: 1 } })];
  await view.searchFor("tax notes more still");
  await view.dom.waitFor(() => hitsOf(view.container).length === 1);
  assert.equal(view.container.querySelector(".fm-best-note"), null);
});

test("lexical-only ranking is not announced, and a host that cannot rank leaves Search exactly as it was", async (t) => {
  const state = backend({ hits: [fileHit("Notes.md", { lines: { start: 1, end: 1 } })], coverage: coverage({ ranking: "lexical", embedder: "none", lexicalOnlyReason: "embedder-unavailable" }) });
  const view = await mountWindow(t, state);
  await view.searchFor("tax");
  await view.dom.waitFor(() => hitsOf(view.container).length === 1);
  assert.equal(view.container.querySelector(".fm-best-note"), null);
  assert.doesNotMatch(view.best()!.textContent ?? "", /lexical|embedder|meaning/i);

  state.noRanked = true;
  await view.searchFor("tax notes");
  await view.dom.waitFor(() => !view.best());
  assert.deepEqual([...view.container.querySelectorAll("[data-fm-result] .fm-row-name")].map((item) => item.textContent), ["tax-notes.md", "a.md"]);
});

test("Info's index row: never indexed, indexing, and complete with the reasons for the rest", async (t) => {
  const never = backend({ status: { connectedFolderId: "lab", ...coverage({ state: "not-indexed", complete: false, files: null, chatMessages: null, chunks: null, walk: null }) } });
  const first = await mountWindow(t, never);
  await first.dom.waitFor(() => Boolean(first.container.querySelector(".fm-index")));
  assert.equal(first.container.querySelector(".fm-index-text")?.textContent, "Not indexed yet");
  assert.equal(first.container.querySelector(".fm-index button"), null, "nothing to expand");
  assert.doesNotMatch(first.container.querySelector(".fm-index")!.textContent ?? "", /\b0\b/, "an unknown count is not shown as zero");
});

test("Info's index row shows Indexing… while a sync runs, and reads again until it stops", async (t) => {
  const state = backend({ status: { connectedFolderId: "lab", ...coverage({ state: "partial", complete: false, running: true, files: { indexed: 40, pending: 20, "not-downloaded": 0, binary: 0, "too-large": 0, unsupported: 0, unreadable: 0 } }) } });
  const view = await mountWindow(t, state);
  await view.dom.waitFor(() => view.container.querySelector(".fm-index-text")?.textContent === "Indexing… 40 of 60 files indexed");
  const reads = state.indexReads;
  state.status = { connectedFolderId: "lab", ...coverage({ files: { indexed: 60, pending: 0, "not-downloaded": 0, binary: 0, "too-large": 0, unsupported: 0, unreadable: 0 } }) };
  await view.dom.waitFor(() => view.container.querySelector(".fm-index-text")?.textContent === "60 of 60 files indexed", 6_000);
  assert.ok(state.indexReads > reads);
  const settled = state.indexReads;
  await view.dom.act(() => new Promise((resolve) => setTimeout(resolve, 3_300)));
  assert.equal(state.indexReads, settled, "a finished sync is not polled");
});

test("Info's index row gives the reasons for the files left out on expansion and on hover", async (t) => {
  const files = { indexed: 1204, pending: 0, "not-downloaded": 12, binary: 0, "too-large": 20, unsupported: 24, unreadable: 0 };
  const state = backend({ status: { connectedFolderId: "lab", ...coverage({ state: "partial", complete: false, files }) } });
  const view = await mountWindow(t, state);
  await view.dom.waitFor(() => Boolean(view.container.querySelector(".fm-index")));
  assert.equal(view.container.querySelector(".fm-index-text")?.textContent, "1,204 of 1,260 files indexed");
  assert.equal(view.container.querySelector(".fm-index-reasons"), null);
  assert.match(view.container.querySelector(".fm-index-row")!.getAttribute("title") ?? "", /12 not downloaded\n20 too large\n24 of a kind that can’t be read/);
  const toggle = view.container.querySelector<HTMLButtonElement>(".fm-index button")!;
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  await view.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.deepEqual([...view.container.querySelectorAll(".fm-index-reasons li")].map((item) => item.textContent), ["12 not downloaded", "20 too large", "24 of a kind that can’t be read", "12 Chat messages indexed"]);
  // It is Info's top level only: a selected file shows Related or nothing, not the index row.
  await view.click(view.row("a.md"));
  assert.equal(view.container.querySelector(".fm-index"), null);
});

test("with no answer from the host Info shows no index row at all", async (t) => {
  const view = await mountWindow(t, backend({ status: null }));
  await view.dom.waitFor(() => Boolean(view.container.querySelector(".fm-role-empty, .fm-role")));
  await view.dom.act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(view.container.querySelector(".fm-index"), null);
});

test("Related lists up to five neighbours of the selected file, and a click shows one in the list", async (t) => {
  const state = backend({ related: ["b.md", "a.md", "c.md", "d.md", "e.md", "f.md", "g.md"].map((path) => fileHit(path, {})) });
  const view = await mountWindow(t, state);
  await view.click(view.row("a.md"));
  await view.dom.waitFor(() => Boolean(view.container.querySelector(".fm-related")));
  const rows = [...view.container.querySelectorAll<HTMLElement>(".fm-related-row")];
  assert.equal(view.container.querySelector(".fm-related h2")?.textContent, "Related");
  assert.deepEqual(rows.map((item) => item.querySelector(".fm-crow-t > span")?.textContent), ["b.md", "c.md", "d.md", "e.md", "f.md"], "five, and never the file itself");
  assert.deepEqual(state.similar, ["a.md"]);
  await view.click(rows[1]!);
  await view.dom.waitFor(() => view.row("c.md").getAttribute("aria-selected") === "true");
  assert.equal(view.row("a.md").getAttribute("aria-selected"), "false");
});

test("Related is fetched when the selection settles, not on every move, and is hidden when there is nothing", async (t) => {
  const state = backend({ related: [fileHit("c.md", {})] });
  const view = await mountWindow(t, state);
  // Three quick moves through the list ask once, for where it ended.
  await view.click(view.row("a.md"));
  await view.click(view.row("b.md"));
  await view.click(view.row("c.md"));
  await view.dom.act(() => new Promise((resolve) => setTimeout(resolve, 450)));
  assert.deepEqual(state.similar, ["c.md"]);
  assert.equal(view.container.querySelector(".fm-related"), null, "its only neighbour is itself");

  state.related = [];
  await view.click(view.row("a.md"));
  await view.dom.act(() => new Promise((resolve) => setTimeout(resolve, 450)));
  assert.equal(view.container.querySelector(".fm-related"), null, "no neighbours, no section");

  // A file the index has nothing for refuses; Info shows nothing and no error.
  state.related = "refuse";
  await view.click(view.row("b.md"));
  await view.dom.act(() => new Promise((resolve) => setTimeout(resolve, 450)));
  assert.equal(view.container.querySelector(".fm-related"), null);
  assert.ok(view.container.querySelector(".fm-hd"), "Info is still showing the file");
  assert.deepEqual(state.similar, ["c.md", "a.md", "b.md"]);
});

test("typing @ in the window's Chat offers Workers, nested ones first, each with its Role purpose", async (t) => {
  const state = backend({ hits: [chatHit] });
  const view = await mountWindow(t, state, [lab, inner, other]);
  await view.searchFor("tax");
  await view.dom.waitFor(() => hitsOf(view.container).length === 1);
  await view.click(hitsOf(view.container)[0]!);
  await view.dom.waitFor(() => Boolean(view.container.querySelector(".fm-chat textarea")));
  const box = view.container.querySelector<HTMLTextAreaElement>(".fm-chat textarea")!;
  await view.dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "ask @");
    box.setSelectionRange(5, 5);
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await view.dom.waitFor(() => Boolean(view.container.querySelector('[role="listbox"][aria-label="Workers"]')));
  const options = [...view.container.querySelectorAll('[role="option"]')];
  assert.deepEqual(options.map((item) => item.querySelector(".composer-mention-name")?.textContent), ["Inner", "Garden"], "the folder inside first, then the others; never the folder itself");
  assert.equal(options[0]!.querySelector(".composer-mention-purpose")?.textContent, "Inner experiments.");
  assert.equal(options[1]!.querySelector(".composer-mention-purpose"), null);
});
