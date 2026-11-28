import assert from "node:assert/strict";
import test from "node:test";

import { interruptionCopy } from "../web-local/src/components/chat/interruption-copy.js";

// An interrupted reply's card says what happened, and claims a saved reply
// only when the host marked the saved text as the model's own.

const base = { retryAttempts: 0 } as const;
const claimsReply = /reply so far|response produced|partial response|saved the response|preserved/i;

test("a Stop with no reply text and no steps says only that the Worker was stopped", () => {
  const copy = interruptionCopy({ ...base, reason: "cancelled" }, { steps: false, canContinue: false });
  assert.equal(copy.heading, "Response Stopped");
  assert.equal(copy.text, "You stopped the Worker before it finished.");
});

test("a Stop with steps but no reply text mentions the steps and not a reply", () => {
  const copy = interruptionCopy({ ...base, reason: "cancelled" }, { steps: true, canContinue: false });
  assert.match(copy.text, /steps it took are kept/);
  assert.doesNotMatch(copy.text, claimsReply);
});

test("a provider failure with reply text says the provider ended it, that the reply so far is kept, and how retries went", () => {
  const copy = interruptionCopy({ reason: "provider_error", retryAttempts: 2, partialResponse: true }, { steps: false, canContinue: true });
  assert.equal(copy.heading, "Response Interrupted");
  assert.equal(copy.text, "The AI provider ended this request before the Worker finished. Its reply so far is kept above. 2 automatic retries were attempted.");
  const both = interruptionCopy({ reason: "provider_error", retryAttempts: 0, partialResponse: true }, { steps: true, canContinue: true });
  assert.match(both.text, /Its reply so far and the steps it took are kept above\. The provider did not identify this as safely retryable\.$/);
});

test("a provider that rejected the request before any text claims no saved reply", () => {
  const copy = interruptionCopy({ ...base, reason: "provider_error" }, { steps: false, canContinue: true });
  assert.equal(copy.text, "The AI provider ended this request before the Worker finished. The provider did not identify this as safely retryable.");
});

test("a record an older build wrote, with no mark, never claims saved reply text", () => {
  for (const reason of ["cancelled", "provider_error", "app_interrupted", "assistant_error"] as const) {
    const copy = interruptionCopy({ ...base, reason }, { steps: false, canContinue: true });
    assert.doesNotMatch(copy.text, claimsReply, reason);
  }
  const closed = interruptionCopy({ ...base, reason: "app_interrupted" }, { steps: false, canContinue: true });
  assert.equal(closed.text, "AmpleFile closed before the Worker finished. It did not rerun the turn because tools may already have changed something.");
});
