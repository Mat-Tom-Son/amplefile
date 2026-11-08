/**
 * Bounded inference: one model call on a Connected Folder's configured model
 * with no tools, no transcript, and an optional schema-validated JSON result.
 * The host uses it for small internal answers, such as the file manager's
 * folder suggestions. This file carries no runtime code and imports nothing
 * from `src/local`.
 */

/** Closed error vocabulary; every message names the bound or state it reports. */
export type BoundedInferenceErrorCode =
  | "INFER_INVALID"
  | "INFER_INPUT_TOO_LARGE"
  | "INFER_MODEL_UNAVAILABLE"
  | "INFER_BUSY"
  | "INFER_OUTPUT_TOO_LARGE"
  | "INFER_OUTPUT_INVALID"
  | "INFER_INTERRUPTED"
  | "INFER_FAILED"
  | "INFER_UNAVAILABLE";

export interface BoundedInferenceModelRef {
  provider: string;
  id: string;
}

export interface BoundedInferenceUsage {
  inputTokens: number;
  outputTokens: number;
}
