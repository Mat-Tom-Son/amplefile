/**
 * One description of why a turn ended without an answer, written for the
 * agents that read it (a parent's follow-up turn, `chat wait`, an
 * Automation's receipts) and for the person reading the Chat.
 *
 * A provider's own error text can carry account ids, billing details, URLs,
 * or request bodies, and a Chat's transcript travels with its Connected
 * Folder, so that text is never copied. Instead the failure is sorted into a
 * closed set of causes from its HTTP status and a few well-known phrases, and
 * each cause gets a fixed sentence that says what happened and what helps:
 * an agent told "the model stopped responding" retries the same model, while
 * one told "this account cannot use that model" chooses another.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";

import type { PiTurnFailureKind } from "./pi-client.js";

export type TurnFailureCause =
  | "billing"
  | "credentials"
  | "model_access"
  | "rate_limit"
  | "image_input"
  | "context_overflow"
  | "response_length"
  | "invalid_request"
  | "provider_unavailable"
  | "provider_error";

export interface TurnFailureDescription {
  cause: TurnFailureCause;
  /** HTTP status the provider answered with, when its error carried one. */
  status?: number;
  /** A fixed sentence naming the cause and what helps. Never provider text. */
  text: string;
}

export interface ProviderFailureInput {
  /** The provider's or Pi's error text. Read to classify, never echoed. */
  message: string;
  kind?: PiTurnFailureKind;
  provider?: string | null;
  model?: string | null;
  retryAttempts?: number;
}

/** The HTTP status a provider error carries in the shapes Pi's providers format, if any. */
export function providerHttpStatus(message: string): number | undefined {
  const patterns = [
    /^\s*(?:HTTP(?:\/[\d.]+)?\s+)?([1-5]\d\d)\b/i,
    /\bAPI error \(([1-5]\d\d)\)/i,
    /\b([1-5]\d\d) status code\b/i,
    /"(?:code|status|statusCode)"\s*:\s*"?([1-5]\d\d)\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match) {
      const status = Number(match[1]);
      if (status >= 400 && status <= 599) return status;
    }
  }
  return undefined;
}

function modelName(input: ProviderFailureInput): string {
  return input.model ? `the model "${input.model}"` : "this model";
}

function retries(count = 0): string {
  return count > 0 ? ` after ${count} automatic ${count === 1 ? "retry" : "retries"}` : "";
}

/** Sorts a failed turn's provider or Pi error into a fixed cause and sentence. */
export function describeProviderFailure(input: ProviderFailureInput): TurnFailureDescription {
  const message = input.message;
  if (input.kind === "length") {
    return {
      cause: "response_length",
      text: "The model reached its response length limit before finishing. Its partial response and completed tool effects were kept; continue this Chat to finish the request.",
    };
  }
  const overflow = input.kind === "context_overflow" || isContextOverflow({
    role: "assistant",
    stopReason: "error",
    errorMessage: message,
    provider: input.provider ?? "",
  } as unknown as AssistantMessage);
  if (overflow) {
    return {
      cause: "context_overflow",
      text: "The conversation is too long for this model's context window, even after AmpleFile compacted it once. Start a new Chat with a short summary of the work, or choose a model with a larger context window.",
    };
  }
  const status = providerHttpStatus(message);
  const at = status !== undefined ? ` (HTTP ${status})` : "";
  const withStatus = status !== undefined ? { status } : {};
  if (status === 402) {
    return {
      cause: "billing",
      status,
      text: "The model provider reported a credit or billing limit (HTTP 402). Check its available credit or reduce the maximum response length before trying again.",
    };
  }
  if (status === 401) {
    return {
      cause: "credentials",
      status,
      text: "The model provider did not accept AmpleFile's API key or sign-in (HTTP 401). Check the provider in Settings → AI Models; trying again will fail the same way.",
    };
  }
  if (status === 404 || /model[_ ]not[_ ]found|model\b.{0,120}\b(?:does not exist|not found|not available)/i.test(message)) {
    return {
      cause: "model_access",
      ...withStatus,
      text: `The model provider says ${modelName(input)} does not exist or this account cannot use it${at}. Choose another model in Settings → AI Models, or give the step its own model; trying again with the same model will fail the same way.`,
    };
  }
  if (status === 403) {
    return {
      cause: "model_access",
      status,
      text: `The model provider refused this request for this account${at}; the account or key may not have access to ${modelName(input)}. Choose another model, or check the account's access with the provider.`,
    };
  }
  if (status === 429 || /rate[_ -]?limit|too many requests|quota/i.test(message)) {
    return {
      cause: "rate_limit",
      ...withStatus,
      text: `The model provider is limiting requests for this account or its usage quota is used up${at}${retries(input.retryAttempts)}. Wait before trying again, or choose a model from another provider.`,
    };
  }
  if ((status === 400 || status === 413 || status === 415 || status === 422) && /\bimages?\b|image_url|vision|multimodal/i.test(message)) {
    return {
      cause: "image_input",
      status,
      text: `The model provider rejected an image in this request for ${modelName(input)}${at}. If the work needs to look at pictures, choose a model that accepts images (\`amplefile automations models\` and Settings → AI Models say which do); otherwise leave images out.`,
    };
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return {
      cause: "invalid_request",
      status,
      text: `The model provider rejected the request as invalid${at} for ${modelName(input)}. Sending the same request again will fail the same way; a different model, or a shorter or simpler request, may succeed.`,
    };
  }
  if ((status !== undefined && (status >= 500 || status === 408))
    || /overloaded|unavailable|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket hang up|stream (?:ended|closed)/i.test(message)) {
    return {
      cause: "provider_unavailable",
      ...withStatus,
      text: `The model provider failed or could not be reached${at}${retries(input.retryAttempts)}. This is usually temporary: try again later, or choose a model from another provider.`,
    };
  }
  return {
    cause: "provider_error",
    ...withStatus,
    text: `The model provider returned an error AmpleFile does not recognize${at}${retries(input.retryAttempts)}. Trying again may work; if it fails the same way, choose another model.`,
  };
}
