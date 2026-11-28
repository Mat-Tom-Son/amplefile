import type { ChatMessageInterruption } from "../../types";

/**
 * What an interrupted reply's card says: what happened, then only what the
 * saved record establishes was kept. A reply so far is mentioned only when
 * the host recorded that the saved text is the model's own
 * (`partialResponse`); a record without that mark, such as one an older
 * build wrote, never claims saved text. Steps are mentioned separately, only
 * when the message shows any.
 */
export function interruptionCopy(
  interruption: Pick<ChatMessageInterruption, "reason" | "retryAttempts" | "partialResponse">,
  shown: { steps: boolean; canContinue: boolean },
): { heading: string; text: string } {
  const kept = keptSentence(interruption.partialResponse === true, shown.steps);
  const sentences = (...parts: Array<string | null | false>) => parts.filter(Boolean).join(" ");
  switch (interruption.reason) {
    case "setup_error":
      return { heading: "Connect Your AI to Continue", text: "Sign in with ChatGPT, Claude, or OpenRouter, or paste an API key." };
    case "assistant_error":
      return { heading: "Request Stopped", text: sentences("The Worker stopped on an error before it finished.", kept, shown.canContinue && "Continue whenever you’re ready.") };
    case "cancelled":
      return { heading: "Response Stopped", text: sentences("You stopped the Worker before it finished.", kept) };
    case "app_interrupted":
      return { heading: "App Interrupted This Response", text: sentences("AmpleFile closed before the Worker finished.", kept, "It did not rerun the turn because tools may already have changed something.") };
    case "provider_error": {
      const retries = interruption.retryAttempts > 0
        ? interruption.retryAttempts === 1 ? "1 automatic retry was attempted." : `${interruption.retryAttempts} automatic retries were attempted.`
        : "The provider did not identify this as safely retryable.";
      return { heading: "Response Interrupted", text: sentences("The AI provider ended this request before the Worker finished.", kept, retries) };
    }
  }
}

function keptSentence(reply: boolean, steps: boolean): string | null {
  if (reply && steps) return "Its reply so far and the steps it took are kept above.";
  if (reply) return "Its reply so far is kept above.";
  if (steps) return "The steps it took are kept above.";
  return null;
}
