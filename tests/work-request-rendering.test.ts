import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkRequestView } from "../src/shared/request-presentation.js";
import { WorkRequest } from "../web-local/src/components/chat/WorkRequest.js";

function view(): WorkRequestView {
  return { version: 1, requestId: "request-one", taskId: "task-one", owner: { conversationId: "chat-one" }, state: "waiting", label: "Needs Your Answer", detail: null, canStop: true, canContinue: false,
    questions: [{ id: "question-one", requestId: "child-one", text: "Which currency? <script>doNotRun()</script>", from: "Supplier quotes", state: "open", canAnswer: true }], questionCount: 1,
    children: [{ requestId: "child-one", title: "Supplier quotes", state: "waiting", label: "Needs Your Answer" }], result: null };
}

test("the desktop work presentation shows the question, origin, whole-work Stop and selected deliverables", () => {
  const html = renderToStaticMarkup(React.createElement(WorkRequest, { work: view(), error: null, busy: false, act: async () => true, refresh: async () => {} }));
  assert.match(html, /Supplier quotes asks/);
  assert.match(html, /Send Answer/);
  assert.match(html, />Stop</);
  assert.doesNotMatch(html, /<script>/);
  const completed = { ...view(), state: "partial" as const, label: "Partly Finished", canStop: false, questions: [], questionCount: 0,
    result: { outcome: "partial" as const, summary: "One quote is still missing.", files: [{ workFolderId: "quotes", workFolderName: "Supplier quotes", path: "comparison.md", sizeBytes: 42 }] } };
  const result = renderToStaticMarkup(React.createElement(WorkRequest, { work: completed, error: null, busy: false, act: async () => true, refresh: async () => {}, showResultSummary: true }));
  assert.match(result, /Partly Finished/); assert.match(result, /One quote is still missing/); assert.match(result, /comparison.md/); assert.match(result, /Open File/);
  assert.doesNotMatch(result, />Stop</);
  const saved = view();
  saved.questions[0] = { ...saved.questions[0], state: "recorded", answer: "Canadian dollars, including installation." };
  const recovery = renderToStaticMarkup(React.createElement(WorkRequest, { work: saved, error: null, busy: false, act: async () => true, refresh: async () => {} }));
  assert.match(recovery, /Canadian dollars, including installation/);
  assert.match(recovery, /Continue with Saved Answer/);
});

test("a question's choices render as buttons on the desktop", async () => {
  const withChoices = view();
  withChoices.questions[0] = { ...withChoices.questions[0], options: ["US dollars", "Canadian <b>dollars</b>"] };
  const html = renderToStaticMarkup(React.createElement(WorkRequest, { work: withChoices, error: null, busy: false, act: async () => true, refresh: async () => {} }));
  assert.match(html, /role="group" aria-label="Choices"/);
  assert.match(html, /<button type="button" class="work-choice-button"[^>]*>US dollars<\/button>/);
  assert.match(html, /Canadian &lt;b&gt;dollars&lt;\/b&gt;/, "a choice is text, never markup");
  assert.match(html, /Or write your own answer/);
  const plain = renderToStaticMarkup(React.createElement(WorkRequest, { work: view(), error: null, busy: false, act: async () => true, refresh: async () => {} }));
  assert.doesNotMatch(plain, /work-choice-button/);
});

test("the checklist an agent keeps shows on the desktop", () => {
  const working = { ...view(), state: "working" as const, label: "Working", questions: [], questionCount: 0, children: [],
    checklist: [{ text: "Read the quotes", status: "done" as const }, { text: "Compare <totals>", status: "doing" as const }, { text: "Write the summary", status: "todo" as const }] };
  const html = renderToStaticMarkup(React.createElement(WorkRequest, { work: working, error: null, busy: false, act: async () => true, refresh: async () => {} }));
  assert.match(html, /aria-label="Checklist, 1 of 3 done"/);
  assert.match(html, /class="work-checklist-item is-done"/);
  assert.match(html, /Compare &lt;totals&gt;/);
  assert.match(html, /\(in progress\)/);
});
