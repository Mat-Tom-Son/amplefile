import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDomHarness } from "./support/dom.js";
import { assistantTurnView } from "../web-local/src/lib/chat-work-trail.js";
import type { AssistantPresentation } from "../src/shared/chat-presentation.js";
import type { ChatMessage, RuntimePreviewEntry } from "../web-local/src/types.js";

const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const hook = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:presentation-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === "test:presentation-icons" ? { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true } : next(url, context); },
});
const { ChatMessageRow, MarkdownMessage, copyMarkdownToClipboard } = await import("../web-local/src/components/chat/messages.js");
const { RuntimeContextPreview } = await import("../web-local/src/components/chat/activity.js");
hook.deregister();

function text(...parts: Array<["progress" | "final" | "command", number, string]>) {
  let offset = 0;
  const presentation: AssistantPresentation = { version: 1, truncated: false, segments: parts.map(([kind, order, value]) => {
    const segment = { kind, order, start: offset, end: offset + value.length }; offset = segment.end + 2; return segment;
  }) };
  return { content: parts.map((part) => part[2]).join("\n\n"), presentation };
}
const tool: RuntimePreviewEntry = { id: "tool:edit", kind: "tool", toolName: "edit", text: "Edited", detail: "notes.txt", phase: "complete", order: 2,
  edit: { path: "notes.txt", diff: "-<script>old()</script>\n+New text", firstChangedLine: 4, truncated: true } };

test("Chat Copy keeps the full Markdown and safe rich formatting on the native clipboard route", async (t) => {
  const dom = await createDomHarness(); t.after(dom.cleanup);
  const copies: Array<{ text: string; html?: string }> = [];
  window.ampleFileDesktop = { clipboard: { write: async (content) => { copies.push(content); } } } as NonNullable<Window["ampleFileDesktop"]>;
  const input = "Checking the notes.\n\n## Final answer\n\n**Ready** <script>bad()</script> 🌍";
  await copyMarkdownToClipboard(input);
  assert.equal(copies.length, 1);
  assert.equal(copies[0]!.text, input);
  assert.match(copies[0]!.html!, /<h2>Final answer<\/h2>/);
  assert.match(copies[0]!.html!, /<strong>Ready<\/strong>/);
  assert.match(copies[0]!.html!, /&lt;script&gt;/);
  assert.doesNotMatch(copies[0]!.html!, /<script>/);
});

test("new presentation interleaves progress and tool evidence, keeping the full reply authoritative", () => {
  const input = text(["progress", 1, "Checking the notes."], ["progress", 3, "Checking the edit."], ["final", 5, "The notes are ready."]);
  const view = assistantTurnView(input.content, input.presentation, [tool, { id: "thinking:1", kind: "thinking", text: "", phase: "complete", durationMs: 2500, order: 0 }]);
  assert.deepEqual(view.steps.map((entry) => entry.order), [0, 1, 2, 3]);
  assert.equal(view.answer, "The notes are ready."); assert.equal(view.hasFinal, true);
  assert.equal(view.steps[2]?.edit?.diff, tool.edit?.diff);
  assert.equal(input.content, "Checking the notes.\n\nChecking the edit.\n\nThe notes are ready.");
});

test("legacy, incomplete and inconsistent metadata never hides or invents historical text", () => {
  const input = text(["progress", 1, "Progress."], ["final", 3, "Final."]);
  const legacy = { ...input.presentation, segments: input.presentation.segments.map(({ order: _order, ...segment }) => segment) };
  for (const metadata of [undefined, legacy, { ...input.presentation, truncated: true }, { ...input.presentation, segments: [{ ...input.presentation.segments[0]!, end: 999 }] }]) {
    const view = assistantTurnView(input.content, metadata, [tool]);
    assert.equal(view.answer, input.content); assert.equal(view.segmented, false); assert.deepEqual(view.steps, [tool]);
  }
  const duplicate = assistantTurnView(input.content, input.presentation, [{ ...tool, order: 1 }]);
  assert.equal(duplicate.answer, input.content);
});

test("raw progress stays open until canonical final classification; stopped progress is still accessible", () => {
  const initial = assistantTurnView("Checking", undefined, [], { canonicalText: "", pendingOrder: 1 });
  assert.equal(initial.hasFinal, false); assert.equal(initial.answer, ""); assert.equal(initial.steps[0]?.text, "Checking");
  const input = text(["progress", 1, "Checking."]);
  const continued = assistantTurnView(input.content + "\n\nNext step", input.presentation, [tool], { canonicalText: input.content, pendingOrder: 3 });
  assert.deepEqual(continued.steps.map((entry) => entry.order), [1, 2, 3]); assert.equal(continued.hasFinal, false);
  const html = renderToStaticMarkup(createElement(RuntimeContextPreview, { entries: continued.steps, running: true, replyStarted: continued.hasFinal }));
  assert.match(html, /work-steps running open/); assert.doesNotMatch(html, /work-steps-summary/);
  const stopped = assistantTurnView(input.content, input.presentation, [tool]);
  assert.equal(stopped.steps[0]?.text, "Checking."); assert.equal(stopped.hasFinal, false);
  const currentOnly = renderToStaticMarkup(createElement(RuntimeContextPreview, { entries: continued.steps, running: true, runningView: "current-step" }));
  assert.match(currentOnly, /Next step/); assert.doesNotMatch(currentOnly, /Checking\./);
  const whitespace = assistantTurnView("  Checking.\n\nNext", input.presentation, [tool], { canonicalText: input.content, pendingOrder: 3 });
  assert.equal(whitespace.answer, "  Checking.\n\nNext"); assert.equal(whitespace.segmented, false, "mismatched canonical whitespace never hides pending text");
});

test("saved rows expose captured edit text safely, and Copy retains progress plus the final reply", async (t) => {
  const dom = await createDomHarness(); t.after(dom.cleanup);
  const input = text(["progress", 1, "Checking [the notes](notes.txt)."], ["final", 3, "The notes are ready."]);
  const message: ChatMessage = { id: "reply", role: "assistant", createdAt: "2026-09-27T12:00:00Z", content: input.content,
    assistantPresentation: input.presentation, workTrail: [{ ...tool, kind: "tool" }] };
  const copies: string[] = [];
  const opened: string[] = [];
  await dom.render(createElement(ChatMessageRow, { message, copied: false, showLanding: true, suppressEnterAnimation: true,
    showRuntimePreview: false, runtimePreviews: [], connectedFolderId: "folder", connectedFolderRoot: "/folder", onCopyMessage: (_id, value) => { copies.push(value); },
    onOpenConnectedFolderFile: (path) => { opened.push(path); }, resolveConnectedFolderPathLinks: async () => new Map([["notes.txt", "notes.txt"]]) }));
  assert.equal(dom.container.querySelector(".message-surface > .message-body")?.textContent, "The notes are ready.");
  const summary = dom.container.querySelector<HTMLButtonElement>(".work-steps-summary")!;
  await dom.act(() => summary.click()); assert.equal(summary.getAttribute("aria-expanded"), "true");
  const details = dom.container.querySelector<HTMLDetailsElement>(".work-step-edit")!;
  assert.ok(details.querySelector("summary")?.textContent?.includes("Line 4"));
  assert.match(details.textContent!, /preview is incomplete/);
  assert.match(details.querySelector("pre")!.textContent!, /<script>old\(\)<\/script>/);
  assert.equal(dom.container.querySelector("script"), null);
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>(".work-step-progress .connected-folder-file-link")!.click());
  assert.deepEqual(opened, ["notes.txt"], "progress keeps ordinary Connected Folder file links");
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>('[aria-label="Copy Message"]')!.click());
  assert.deepEqual(copies, [input.content]);
});

test("a command step opens to its recorded command, which is not offered to copy, and an opened thought drops its preview", async (t) => {
  const dom = await createDomHarness(); t.after(dom.cleanup);
  const command = "python3 -c \"import openpyxl; print(sum(c.value or 0 for c in openpyxl.load_workbook('budget.xlsx').active['C'][1:]))\"";
  await dom.render(createElement(RuntimeContextPreview, { running: true, entries: [
    { id: "t1", kind: "thinking", text: "Checking the budget. The cabinetry line is the whole difference.", phase: "complete" },
    { id: "b1", kind: "tool", toolName: "bash", text: "Bash finished", detail: command, phase: "complete" },
  ] }));
  const [thought, ran] = [...dom.container.querySelectorAll<HTMLButtonElement>(".work-step-toggle")];
  assert.equal(thought!.textContent, "ThoughtChecking the budget.");
  assert.equal(ran!.querySelector(".work-step-target.command")!.textContent, command, "the closed row keeps the command on its one line");
  assert.equal(dom.container.querySelector(".work-step-command"), null);

  await dom.act(() => thought!.click());
  assert.equal(thought!.getAttribute("aria-expanded"), "true");
  assert.equal(thought!.textContent, "Thought", "the preview does not repeat beside the open thought");
  assert.match(dom.container.querySelector(".work-step-thought")!.textContent!, /The cabinetry line is the whole difference\./);

  await dom.act(() => ran!.click());
  assert.equal(ran!.getAttribute("aria-expanded"), "true");
  assert.equal(ran!.textContent, "Ran");
  assert.equal(dom.container.querySelector(".work-step-command pre")!.textContent, command);
  assert.equal(dom.container.querySelector(".work-step-command-bar")!.textContent, "Recorded Command");
  // A step keeps a shortened, one-line record, so the row never offers it as something to paste and run.
  assert.equal(dom.container.querySelector(".work-step-command button"), null);

  await dom.act(() => ran!.click());
  assert.equal(dom.container.querySelector(".work-step-command"), null);
  assert.equal(ran!.querySelector(".work-step-target.command")!.textContent, command);
});

test("a person's own message has the footer a reply has, and a failed reply's notice names its button", () => {
  const row = (message: ChatMessage, onContinue?: () => void) => renderToStaticMarkup(createElement(ChatMessageRow, { message, copied: false, showLanding: false,
    suppressEnterAnimation: true, showRuntimePreview: false, runtimePreviews: [], connectedFolderId: "folder", connectedFolderRoot: "/folder",
    onCopyMessage: () => undefined, onContinue }));
  const own = row({ id: "u", role: "user", createdAt: "2026-10-11T12:00:00Z", content: "Compare the quotes." });
  assert.match(own, /<footer class="message-footer">[\s\S]*?aria-label="Copy Message"[\s\S]*?<time class="message-time" dateTime="2026-10-11T12:00:00Z"/);

  const failed: ChatMessage = { id: "a", role: "assistant", createdAt: "2026-10-11T12:00:00Z", content: "Partial.",
    interruption: { reason: "assistant_error", message: "Failed.", retryAttempts: 0, provider: null, model: null, activities: [] } };
  const last = row(failed, () => undefined);
  assert.match(last, /Continue whenever you’re ready\.<\/span><button[^>]*>Continue<\/button>/);
  assert.doesNotMatch(last, /try again/i);
  const earlier = row(failed);
  assert.match(earlier, /AmpleFile saved this result with your Chat\.<\/span>/);
  assert.doesNotMatch(earlier, /Continue/, "without the button the notice does not point at one");
});

test("a table sits in its sideways scroller, which marks a side only while columns are out of view", async (t) => {
  const dom = await createDomHarness(); t.after(dom.cleanup);
  await dom.render(createElement(MarkdownMessage, { content: "| Option | Best for |\n| --- | --- |\n| Fixed-price quote | Cost certainty |" }));
  const scroller = dom.container.querySelector<HTMLElement>(".message-table-scroll")!;
  assert.equal(scroller.firstElementChild?.tagName, "TABLE");
  assert.equal(scroller.hasAttribute("data-more"), false, "a table that fits has no faded edge");

  // jsdom lays nothing out, so the scroller's measurements are supplied.
  const measure = (scrollLeft: number) => {
    for (const [key, value] of Object.entries({ scrollLeft, clientWidth: 250, scrollWidth: 426 })) Object.defineProperty(scroller, key, { value, configurable: true });
  };
  measure(0);
  await dom.act(() => { scroller.dispatchEvent(new window.Event("scroll")); });
  assert.equal(scroller.getAttribute("data-more"), "end");
  measure(60);
  await dom.act(() => { scroller.dispatchEvent(new window.Event("scroll")); });
  assert.equal(scroller.getAttribute("data-more"), "both");
  measure(176);
  await dom.act(() => { scroller.dispatchEvent(new window.Event("scroll")); });
  assert.equal(scroller.getAttribute("data-more"), "start");
});

test("a request a removed app made in an older Chat renders as an ordinary message", () => {
  const row = (message: ChatMessage) => renderToStaticMarkup(createElement(ChatMessageRow, { message, copied: false, showLanding: false,
    suppressEnterAnimation: true, showRuntimePreview: false, runtimePreviews: [], connectedFolderId: "folder", connectedFolderRoot: "/folder",
    onCopyMessage: () => undefined }));
  const base: ChatMessage = { id: "m", role: "user", createdAt: "2026-10-11T12:00:00Z", content: "App request: Compare quotes" };
  // A log an earlier build wrote can carry a Connected Folder app's marker.
  const fromApp = row({ ...base, source: "app", appId: "quote-board", appTitle: "Quote board" } as ChatMessage);
  assert.match(fromApp, /<article class="message user settled">/);
  assert.doesNotMatch(fromApp, /app-request|message-sender|Quote board/);
  assert.match(fromApp, /App request: Compare quotes/);
  assert.equal(fromApp, row(base), "it renders exactly as the person's own message");
});

test("a Markdown hard line break is one line, not a break plus a blank line", () => {
  // Chat paragraphs keep newlines visible, so the newline that follows each
  // `<br>` must not draw a second, empty line under every quoted line.
  const html = renderToStaticMarkup(createElement(MarkdownMessage, { content: "> “Peter.”  \n> “Where ARE you?”  \n> “Here.”\n\nAfter.\nSoft break." }));
  assert.match(html, /<blockquote>\s*<p>“Peter\.”<br\/>“Where ARE you\?”<br\/>“Here\.”<\/p>\s*<\/blockquote>/);
  assert.match(html, /<p>After\.\nSoft break\.<\/p>/, "a soft break keeps its newline");
});
