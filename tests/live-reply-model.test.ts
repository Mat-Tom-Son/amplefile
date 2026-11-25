import assert from "node:assert/strict";
import test from "node:test";

import { emptyLiveReply, liveReplyReducer, type LiveReply } from "../web-local/src/components/chat/live-reply-model.js";
import type { ChatStreamEvent } from "../web-local/src/types.js";

/** Plays stream events into a reply the way a Chat surface does, at the given clock. */
function play(events: Array<Omit<ChatStreamEvent, "conversationId"> | "flush">, reply: LiveReply = emptyLiveReply, now = 1_000): LiveReply {
  return events.reduce((current, event) => event === "flush"
    ? liveReplyReducer(current, { type: "flush" })
    : liveReplyReducer(current, { type: "event", event: { conversationId: "chat", ...event }, now }), reply);
}

const visibleSteps = (reply: LiveReply) => reply.steps.map(({ id, kind, text, phase, durationMs }) => ({ id, kind, text, phase, durationMs }));

test("streamed text shows on the next frame, in order, and an empty delta changes nothing", () => {
  const streamed = play([
    { type: "assistant_delta", text: "Here is ", order: 2 },
    { type: "assistant_delta", text: "the plan.", order: 3 },
  ]);
  assert.equal(streamed.text, "", "a burst of deltas waits for one frame");
  const shown = play(["flush"], streamed);
  assert.equal(shown.text, "Here is the plan.");
  assert.equal(shown.pendingOrder, 3, "the latest delta places the text among the steps");
  assert.equal(play([{ type: "assistant_delta", text: "" }], shown), shown);
  assert.equal(play(["flush"], shown), shown, "a frame with nothing waiting changes nothing");
});

test("the whole message replaces streamed and still-waiting text", () => {
  const reply = play([
    { type: "assistant_delta", text: "Draft" },
    "flush",
    { type: "assistant_delta", text: " still waiting", order: 4 },
    { type: "assistant_message", text: "Final words.", assistantPresentation: { version: 1, segments: [{ start: 0, end: 12, kind: "final", order: 5 }], truncated: false } },
    "flush",
  ]);
  assert.equal(reply.text, "Final words.");
  assert.equal(reply.canonical.text, "Final words.");
  assert.equal(reply.canonical.metadata?.segments[0]?.kind, "final");
  assert.equal(reply.pendingOrder, undefined);
});

test("a tool step appears once and later events for it update that row", () => {
  const reply = play([
    { type: "tool", workTrailId: "tool:list", toolName: " bash ", message: " Running ", detail: " amplefile connected-folders list ", phase: "running", order: 1 },
    { type: "tool", workTrailId: "tool:list", toolName: "bash", message: "Ran", detail: "amplefile connected-folders list", phase: "complete", durationMs: 40, order: 1 },
    { type: "tool", toolCallId: " call-7 ", toolName: "read" },
    { type: "tool", toolCallId: "call-7", toolName: "read", phase: "complete" },
    { type: "tool", toolTitle: "Search the web" },
    { type: "tool" },
  ]);
  assert.deepEqual(visibleSteps(reply), [
    { id: "tool:list", kind: "tool", text: "Ran", phase: "complete", durationMs: 40 },
    { id: "tool-call-7", kind: "tool", text: "read", phase: "complete", durationMs: undefined },
    { id: "tool-1", kind: "tool", text: "Tool", phase: "running", durationMs: undefined },
    { id: "tool-2", kind: "tool", text: "Tool", phase: "running", durationMs: undefined },
  ]);
  assert.equal(reply.steps[0]!.toolName, "bash", "names are trimmed");
  assert.equal(reply.steps[0]!.detail, "amplefile connected-folders list");
  assert.equal(reply.steps[2]!.toolTitle, "Search the web");
});

test("a thinking block streams into one row and keeps its duration when it ends", () => {
  const timed = play([
    { type: "assistant_thinking", thinkingPhase: "start", workTrailId: "thinking:1", startedAt: 500, order: 0 },
    { type: "assistant_thinking", text: "Checking the folders", workTrailId: "thinking:1" },
    { type: "assistant_thinking", text: " first.", workTrailId: "thinking:1" },
  ]);
  assert.deepEqual(visibleSteps(timed), [{ id: "thinking:1", kind: "thinking", text: "Checking the folders first.", phase: "streaming", durationMs: undefined }]);
  const ended = play([{ type: "assistant_thinking", thinkingPhase: "end", workTrailId: "thinking:1", durationMs: 1_200 }], timed);
  assert.equal(ended.steps[0]!.phase, "complete");
  assert.equal(ended.steps[0]!.durationMs, 1_200, "the event's own duration wins");
  const hidden = play([{ type: "assistant_thinking", thinkingPhase: "end" }], timed, 3_500);
  assert.equal(hidden.steps[0]!.durationMs, 3_000, "without one, the time since it started");
});

test("thinking text without a start begins its own row, and later text without an id joins it", () => {
  const reply = play([
    { type: "assistant_thinking", text: "First thought." },
    { type: "assistant_thinking", text: " More." },
    { type: "assistant_thinking", thinkingPhase: "end" },
    { type: "assistant_thinking", text: "Second thought." },
  ], emptyLiveReply, 2_000);
  assert.deepEqual(visibleSteps(reply), [
    { id: "thinking-1", kind: "thinking", text: "First thought. More.", phase: "complete", durationMs: 0 },
    { id: "thinking-2", kind: "thinking", text: "Second thought.", phase: "streaming", durationMs: undefined },
  ]);
  assert.equal(reply.steps[0]!.startedAt, 2_000);
});

test("events out of order or for rows never started change nothing they cannot place", () => {
  const before = play([{ type: "tool", workTrailId: "tool:a", phase: "running" }]);
  assert.deepEqual(visibleSteps(play([{ type: "assistant_thinking", thinkingPhase: "end", workTrailId: "thinking:missing" }], before)), visibleSteps(before));
  assert.deepEqual(visibleSteps(play([{ type: "assistant_thinking", text: "orphan", workTrailId: "thinking:missing" }], before)), visibleSteps(before));
  const updatedFirst = play([{ type: "tool", workTrailId: "tool:b", phase: "complete" }], before);
  assert.deepEqual(updatedFirst.steps.map((step) => [step.id, step.phase]), [["tool:a", "running"], ["tool:b", "complete"]], "a completion seen first still shows its row");
  for (const type of ["status", "runtime", "editor", "queued_message", "context_compacted"] as const) {
    assert.equal(play([{ type, text: "ignored" }], before), before, `${type} is not part of the reply`);
  }
});

test("a reconnect snapshot replaces the reply at its cursor, and replaying it repeats nothing", () => {
  const before = play([
    { type: "assistant_delta", text: "Here" },
    "flush",
    { type: "tool", workTrailId: "tool:stale", phase: "running" },
  ]);
  const snapshot: Omit<ChatStreamEvent, "conversationId"> = {
    type: "turn_snapshot", running: true, text: "ignored when presentation is present",
    presentation: {
      text: "Here is the plan",
      truncated: true,
      workTrail: [
        { id: "tool:list", kind: "tool", text: "Ran", phase: "complete", order: 1 },
        { id: "thinking:2", kind: "thinking", text: "Comparing", phase: "streaming", startedAt: 400, order: 2 },
      ],
    },
  };
  const once = play([snapshot], before, 5_000);
  const twice = play([snapshot, snapshot], before, 9_000);
  assert.equal(once.text, "Here is the plan");
  assert.equal(once.truncated, true);
  assert.deepEqual(visibleSteps(once).map((step) => step.id), ["tool:list", "thinking:2"]);
  assert.deepEqual(visibleSteps(twice), visibleSteps(once), "a replay adds no row");
  assert.equal(twice.steps[1]!.startedAt, 400, "nor restarts the thinking timer");
  const continued = play([{ type: "assistant_thinking", text: " the quotes." }], once);
  assert.equal(continued.steps[1]!.text, "Comparing the quotes.", "the open thinking row keeps streaming");
});

test("a snapshot without a presentation replaces only the text; an idle one ends the reply instead", () => {
  const before = play([
    { type: "tool", workTrailId: "tool:a", phase: "running" },
    { type: "assistant_thinking", thinkingPhase: "start", workTrailId: "thinking:1", startedAt: 100 },
    { type: "assistant_delta", text: "waiting" },
  ]);
  const textOnly = play([{ type: "turn_snapshot", running: true, text: "From the cursor" }], before);
  assert.equal(textOnly.text, "From the cursor");
  assert.equal(textOnly.steps, before.steps);
  for (const type of ["turn_snapshot", "turn_state"] as const) {
    const idle = play([{ type, running: false, text: "older text" }], before, 600);
    assert.equal(idle.text, "waiting", `an idle ${type} shows the waiting text and replaces nothing`);
    assert.deepEqual(idle.steps.map((step) => [step.id, step.phase, step.durationMs]), [["tool:a", "running", undefined], ["thinking:1", "complete", 500]]);
  }
  assert.equal(play([{ type: "turn_state", running: true }], before), before, "a running state frame changes nothing by itself");
});

test("done and error show the waiting text and close the open thinking row", () => {
  for (const type of ["done", "error"] as const) {
    const ended = play([
      { type: "assistant_thinking", thinkingPhase: "start", startedAt: 100 },
      { type: "assistant_delta", text: "Last words" },
      { type },
    ], emptyLiveReply, 1_100);
    assert.equal(ended.text, "Last words");
    assert.deepEqual(visibleSteps(ended), [{ id: "thinking-1", kind: "thinking", text: "", phase: "complete", durationMs: 1_000 }]);
    const again = play([{ type }], ended, 9_000);
    assert.equal(again.steps[0]!.durationMs, 1_000, "a second ending changes no finished row");
  }
});

test("clearing the reply, its text, or its steps keeps the rest", () => {
  const reply = play([
    { type: "turn_snapshot", running: true, text: "Shown", presentation: { text: "Shown", truncated: true, workTrail: [{ id: "tool:a", kind: "tool", text: "Ran" }] } },
    { type: "assistant_delta", text: " waiting", order: 3 },
  ]);
  const textCleared = liveReplyReducer(reply, { type: "clearText" });
  assert.equal(textCleared.text, "");
  assert.equal(liveReplyReducer(textCleared, { type: "flush" }).text, "", "cleared text cannot come back on the next frame");
  assert.equal(textCleared.steps, reply.steps);
  const stepsCleared = liveReplyReducer(reply, { type: "clearSteps" });
  assert.equal(stepsCleared.text, "Shown");
  assert.deepEqual(stepsCleared.steps, []);
  assert.equal(stepsCleared.truncated, false);
  assert.equal(stepsCleared.canonical.text, "");
  assert.equal(stepsCleared.pendingOrder, undefined);
  const cleared = liveReplyReducer(play([{ type: "tool" }], reply), { type: "clear" });
  assert.deepEqual({ text: cleared.text, steps: cleared.steps, truncated: cleared.truncated }, { text: "", steps: [], truncated: false });
  assert.equal(play([{ type: "tool" }], cleared).steps[0]!.id, "tool-2", "a new turn's unnamed rows never reuse an earlier row's id");
});

test("a sample Chat shows its reply and steps as given", () => {
  const steps = [{ id: "saved", kind: "tool" as const, text: "Read", phase: "complete" as const }];
  const shown = liveReplyReducer(play([{ type: "assistant_delta", text: "waiting" }]), { type: "show", text: "Sample reply", steps });
  assert.equal(shown.text, "Sample reply");
  assert.equal(liveReplyReducer(shown, { type: "flush" }).text, "Sample reply");
  assert.equal(shown.steps, steps);
  assert.equal(liveReplyReducer(shown, { type: "show", steps: [] }).text, "Sample reply", "showing steps alone keeps the text");
});

test("a closed stream drops its waiting text and its open thinking row's claim on later thinking", () => {
  const open = play([
    { type: "assistant_delta", text: "Shown" },
    "flush",
    { type: "assistant_thinking", thinkingPhase: "start", workTrailId: "thinking:old" },
    { type: "assistant_delta", text: " never shown" },
  ]);
  const closed = liveReplyReducer(open, { type: "streamClosed" });
  assert.equal(liveReplyReducer(closed, { type: "flush" }).text, "Shown", "a frame after the close shows nothing from that stream");
  assert.equal(closed.steps, open.steps, "what is on screen stays");
  const next = play([{ type: "assistant_thinking", text: "A new thought." }], closed);
  assert.deepEqual(next.steps.map((step) => [step.id, step.text]), [["thinking:old", ""], ["thinking-1", "A new thought."]], "the next stream's thinking starts its own row");
  assert.equal(liveReplyReducer(closed, { type: "streamClosed" }), closed, "closing twice changes nothing");
});

test("showing other steps takes the open thinking row from those steps", () => {
  const open = play([{ type: "assistant_thinking", thinkingPhase: "start", workTrailId: "thinking:old" }]);
  const replaced = liveReplyReducer(open, { type: "show", steps: [{ id: "saved", kind: "tool", text: "Read", phase: "complete" }] });
  const next = play([{ type: "assistant_thinking", text: "Fresh." }], replaced);
  assert.deepEqual(next.steps.map((step) => [step.id, step.text]), [["saved", "Read"], ["thinking-1", "Fresh."]], "thinking text is not lost on a row that is gone");
  const live = liveReplyReducer(emptyLiveReply, { type: "show", steps: [
    { id: "thinking:done", kind: "thinking", text: "Earlier", phase: "complete" },
    { id: "thinking:live", kind: "thinking", text: "Still", phase: "streaming" },
  ] });
  assert.equal(play([{ type: "assistant_thinking", text: " going." }], live).steps[1]!.text, "Still going.", "a shown row that is still thinking keeps streaming");
  const textOnly = liveReplyReducer(open, { type: "show", text: "Sample" });
  assert.equal(play([{ type: "assistant_thinking", text: " more" }], textOnly).steps[0]!.text, " more", "showing text alone leaves the steps and their open row");
});
