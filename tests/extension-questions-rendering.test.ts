import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import type { ExtensionUiRequest } from "../web-local/src/types.js";

const requests: ExtensionUiRequest[] = [
  { id: "input-one", method: "input", title: "Which account? <script>notCode()</script>" },
  { id: "select-two", method: "select", title: "Which colour?", options: ["Blue", "Green"] },
];

test("inline extension questions keep drafts and focus through refresh, retain failed answers, and bind submissions to the displayed question", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const { ExtensionQuestions } = await import("../web-local/src/components/chat/ExtensionQuestions.js");
  const sent: unknown[] = [];
  let finish!: () => void;
  const respond = async (request: ExtensionUiRequest, value: unknown) => {
    sent.push({ id: request.id, value });
    if (sent.length === 1) throw new Error("Connection lost; try again.");
    await new Promise<void>((resolve) => { finish = resolve; });
  };
  const render = (scope = "chat-one", prompts = requests) => dom.render(createElement(ExtensionQuestions, { requests: prompts, scope, respond }));
  await render();
  assert.equal(dom.container.querySelector('[role="dialog"]'), null);
  assert.equal(dom.container.querySelector("script"), null);
  assert.equal(dom.container.querySelectorAll(".extension-question").length, 2);
  let input = dom.container.querySelector("input")!;
  await dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "Work account");
    input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); input.setSelectionRange(1, 4);
  });
  await render("chat-one", [...requests]);
  assert.equal(document.activeElement, input); assert.equal(input.selectionStart, 1);
  const submit = () => dom.act(async () => { dom.container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await Promise.resolve(); });
  await submit();
  assert.match(dom.container.textContent!, /Connection lost/); assert.equal(input.value, "Work account");
  await render("chat-two", [{ ...requests[0], id: "other-input" }]);
  assert.equal(dom.container.querySelector("input")!.value, "");
  await render(); input = dom.container.querySelector("input")!;
  assert.equal(input.value, "Work account", "draft stays with its owning Chat");
  await submit(); await submit();
  assert.equal(sent.length, 2, "double submit is ignored while an answer is in flight");
  assert.deepEqual(sent[1], { id: "input-one", value: "Work account" });
  await dom.act(() => finish());
  await render("chat-one", [requests[1]]);
  assert.equal(dom.container.querySelector("input"), null);
  assert.match(dom.container.textContent!, /Which colour/);
});
