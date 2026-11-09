/**
 * Durable request records: the types, closed-shape parsers, pure state rules,
 * and limit refusals behind durable requests (docs/collaboration-contract.md).
 *
 * A request is the machine-local record of one thing a person asked for and
 * everything the AmpleFile Agent, a Worker, an app, an automation, or an
 * outside harness on the CLI did about it: the accepted turns, the questions
 * they asked, the results they reported, and the child requests they started. It
 * is attribution and recovery machinery, never a gate — nothing here waits
 * for a click, and nothing here is ever replayed.
 *
 * This module is pure: no filesystem, no clock, no server imports. The store
 * (request-store.ts) owns persistence; the projections in the local API read
 * these shapes. Keeping the rules here means the eleven-step state ladder can
 * be driven directly in tests without a temporary directory.
 *
 * Payload boundary: a request record carries identifiers, counters, enums,
 * the assignment text, and the attachment references it was given. Result
 * envelopes — the part that can reach 288 KB — live in their own files and
 * are referenced from here by id, outcome, and file count only.
 */
import { Buffer } from "node:buffer";

import { ampleFileRequestLimits } from "../../shared/amplefile-limits.js";
import { maxAmpleFileAgentAttachments, type AmpleFileAgentAttachmentRef } from "../amplefile-agent-attachments.js";
import { containsReservedConnectedFolderPathSegment } from "../connected-folder-path-policy.js";

export const ampleFileRequestRecordSchema = "amplefile.request.v1" as const;
export const ampleFileQuestionRecordSchema = "amplefile.request-question.v1" as const;
export const ampleFileResultRecordSchema = "amplefile.request-result.v1" as const;

export const ampleFileRequestIdPattern = /^req-\d{14}-[0-9a-f]{8}$/;
const ampleFileJobRefIdPattern = /^job-\d{14}-[0-9a-f]{8}$/;
export const ampleFileQuestionIdPattern = /^q-\d{14}-[0-9a-f]{8}$/;
export const ampleFileResultIdPattern = /^res-\d{14}-[0-9a-f]{8}$/;

/** The one spelling every request refusal names, shared with the app-facing refusals. */
export const ampleFileRequestLimitsSection = "Settings → Automations → Limits";

const forbiddenTextPattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const maximumResultFilePathLength = 1_024;
const maximumErrorLength = 2_048;
const maximumStableIdLength = 160;
const stableIdPattern = /^[A-Za-z0-9._:-]+$/;

/**
 * `app` is read only: an earlier build recorded work a Connected Folder app
 * requested. Such a record still loads; nothing creates one now.
 */
export type AmpleFileRequestKind = "agent" | "connected-folder" | "app" | "automation" | "cli";

/** The kinds AmpleFile creates now. */
export type AmpleFileRequestCreatableKind = Exclude<AmpleFileRequestKind, "app">;

export type AmpleFileRequestState =
  | "working"
  | "waiting"
  | "handed_off"
  | "done"
  | "partial"
  | "failed"
  | "stopped"
  | "expired";

/** No outstanding work. Done/partial/failed may reopen through explicit continuation; stop and expiry do not. */
export const ampleFileRequestTerminalStates = ["done", "partial", "failed", "stopped", "expired"] as const;

export function isAmpleFileRequestTerminalState(state: AmpleFileRequestState): boolean {
  return (ampleFileRequestTerminalStates as readonly string[]).includes(state);
}

/**
 * Where the turn came from. `system` covers automations (and, in records
 * older builds wrote, app-started work).
 */
export type AmpleFileRequestSurface =
  | "cli"
  | "popover"
  | "main-window"
  | "renderer"
  | "system";

/** The turn-journal statuses a request aggregates. The journal stays the outcome authority. */
export type AmpleFileRequestTurnState =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "interrupted";

export type AmpleFileResultOutcome = "succeeded" | "partial" | "failed";

export interface AmpleFileRequestOwner {
  /** Absent exactly for the AmpleFile Agent scope; present for every Connected Folder–owned request. */
  connectedFolderId?: string;
  /** Display snapshot, so an unregistered Connected Folder still renders its name. */
  connectedFolderName?: string;
  conversationId: string;
}

/** Read only: the app older builds recorded on a request of kind `app`. */
export interface AmpleFileRequestAppRef {
  connectedFolderId: string;
  appId: string;
  featureInstallationId: string;
  digest: string;
}

/**
 * Rolled up from every settled turn of this request; attribution only.
 * `amountUsd` sums the costs that were actually reported, and
 * `amountUsdComplete` is false when at least one counted turn ran on a model
 * with no published rates — an unknown cost stays unknown rather than zero.
 */
export interface AmpleFileRequestUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  amountUsd?: number;
  amountUsdComplete: boolean;
}

/** One accepted turn belonging to this request, with its own settled outcome. */
export interface AmpleFileRequestTurnRef {
  taskId: string;
  acceptedAt: string;
  /** `continuation` marks a turn started by an answer or a settle batch. */
  role: "origin" | "continuation";
  state: AmpleFileRequestTurnState;
  settledAt: string | null;
  messageId: string | null;
  error: string | null;
}

/**
 * A background job one of this request's turns started (docs/background-jobs.md),
 * by reference. The job journal keeps the whole record and its output.
 * `running` covers a job from its journaled start until it settles.
 */
export type AmpleFileRequestJobState = "running" | "exited" | "stopped" | "timed_out" | "failed" | "interrupted";

export interface AmpleFileRequestJobRef {
  service?: boolean;
  jobId: string;
  /** The turn that started it. */
  taskId: string;
  name: string;
  state: AmpleFileRequestJobState;
  startedAt: string;
  settledAt: string | null;
  exitCode: number | null;
}

/** A recorded result, by reference. The envelope itself lives in its own file. */
export interface AmpleFileRequestResultRef {
  resultId: string;
  taskId: string;
  outcome: AmpleFileResultOutcome;
  recordedAt: string;
  receiptId: string;
  fileCount: number;
}

export type AmpleFileRequestLimitName =
  | "childTasks"
  | "depth"
  | "concurrentChildren"
  | "continuations"
  | "providerBudget"
  | "questionLifetime"
  | "questionText"
  | "questionOptions"
  | "questionOptionText"
  | "answerText"
  | "checklistItems"
  | "checklistItemText"
  | "resultSummary"
  | "resultData"
  | "resultFiles"
  | "questionsPerRequest"
  | "resultsPerRequest"
  | "turnsPerRequest"
  | "actionsPerRequest";

export type AmpleFileChecklistItemStatus = "todo" | "doing" | "done";

export interface AmpleFileChecklistItem {
  text: string;
  status: AmpleFileChecklistItemStatus;
}

export interface AmpleFileChecklist {
  items: AmpleFileChecklistItem[];
  updatedAt: string;
  /** The turn that last changed it. */
  taskId: string;
}

export interface AmpleFileRequestLimitHit {
  limit: AmpleFileRequestLimitName;
  at: string;
}

/**
 * Every landed act-lane mutation verb (docs/act-ledger.md). One entry per
 * explicitly attributed act, so a request's story stays complete; consumers
 * render the commands they understand and fall back to the command token for
 * the rest. Act reads carry no lineage and are deliberately absent.
 */
export const ampleFileRequestActionCommands = [
  "connected-folders.worker.model",
  "connected-folders.worker.instructions",
  "chat.send",
  "chat.rename",
  "chat.snooze",
  "chat.archive",
  "chat.resume",
  "chat.compact",
  // The collaboration verbs: attributed like every other act, and
  // recorded by identifiers only — the report, question, and answer text
  // live in their own records, never in the action trail.
  "chat.report",
  "chat.ask",
  "chat.answer",
  "chat.handoff",
  "chat.steer",
  "chat.copy",
  "history.save",
  "history.restore",
  "history.restore-file",
  "files.add",
  "files.move",
  "files.rename",
  "files.delete",
  "files.mkdir",
  "files.create",
  "connected-folders.create",
  "connected-folders.register",
  "connected-folders.rename",
  "connected-folders.unregister",
  "connected-folders.delete",
  "connected-folders.appearance.apply",
  "connected-folders.appearance.reset",
  "connected-folders.appearance.undo",
  "tools.import-skill",
  "tools.install",
  "tools.update",
  "tools.enable",
  "tools.disable",
  "tools.remove",
  "automations.enable",
  // Background jobs (docs/background-jobs.md): the tools and the CLI record the same act.
  "jobs.start",
  "jobs.stop",
  "jobs.input",
  "worktrees.create",
  "worktrees.archive",
  "worktrees.restore",
  "recently-deleted.restore",
] as const;

export type AmpleFileRequestActionCommand = (typeof ampleFileRequestActionCommands)[number];

/**
 * Commands an earlier build recorded for verbs AmpleFile does not have: page
 * publishing and the Connected Folder app verbs. A record that names one still
 * loads; that action is skipped, so the rest of the request's story survives
 * instead of the whole record reading as damaged.
 */
const retiredAmpleFileRequestActionCommands: ReadonlySet<string> = new Set([
  "pages.publish", "pages.unpublish",
  "apps.proposals.dismiss", "apps.install-proposal", "apps.install-preview", "apps.remove", "apps.grant", "apps.revoke",
  "apps.connect", "apps.disconnect", "apps.automation.enable", "apps.automation.disable", "apps.automation.run",
  "apps.invoke", "apps.storage.clear", "apps.retained.purge", "apps.project.declare", "apps.release.prepare",
  "apps.release.publish", "apps.release.delete", "apps.install.prepare", "apps.update.prepare",
  "apps.operation.activate", "apps.operation.cancel", "apps.uninstall",
]);

function isRetiredAmpleFileRequestAction(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && retiredAmpleFileRequestActionCommands.has((value as { command?: unknown }).command as string);
}

export interface AmpleFileRequestAction {
  command: AmpleFileRequestActionCommand;
  at: string;
  /**
   * Absent exactly for Connected Folder–free acts: removing an Everywhere Skill or
   * Extension. Every Connected Folder–bound act names its Connected Folder.
   */
  connectedFolderId?: string;
  connectedFolderName?: string;
  /** Resolved absolute source paths for files.add; used to match dispositions. */
  sources?: string[];
  /** Connected Folder–relative destinations reported by files.add. */
  copied?: string[];
  /** How many `sources` the trail left out to stay inside its bound; absent when none. */
  sourcesOmitted?: number;
  /** How many `copied` destinations the trail left out to stay inside its bound; absent when none. */
  copiedOmitted?: number;
  checkpointId?: string | null;
  /** Registered or created Connected Folder root. */
  connectedFolderRoot?: string;
  conversationId?: string;
  taskId?: string;
}

export interface AmpleFileRequestRecord {
  schema: typeof ampleFileRequestRecordSchema;
  requestId: string;
  kind: AmpleFileRequestKind;
  /** Equal to `requestId` for a root. */
  rootId: string;
  parentRequestId: string | null;
  /** The exact parent task id the caller named, kept for attribution. */
  parentTaskId: string | null;
  /** 0 for a root. */
  depth: number;
  owner: AmpleFileRequestOwner;
  app?: AmpleFileRequestAppRef;
  surface: AmpleFileRequestSurface;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  /** Always `null`: a request never expires on a timer. The field keeps stored records' shape. */
  deadline: string | null;
  state: AmpleFileRequestState;
  /** `turns[0].role` is always `origin`. */
  turns: AmpleFileRequestTurnRef[];
  childRequestIds: string[];
  questionIds: string[];
  results: AmpleFileRequestResultRef[];
  usage: AmpleFileRequestUsage;
  continuationCount: number;
  /** Settled child turns already reserved for delivery, independent of timing. */
  deliveredChildTaskIds: string[];
  /** Background jobs this request's turns started; absent until the first one. */
  jobs?: AmpleFileRequestJobRef[];
  /** Finished jobs whose end already reached the Chat, by any path. */
  deliveredJobIds?: string[];
  /**
   * The checklist the agent keeps for this request: what it
   * plans to do and how far it got. The host keeps it, shows it to the
   * person, and hands it back to every later turn of the request.
   */
  checklist?: AmpleFileChecklist;
  continuationState: "pending" | "failed" | null;
  stopRequestedAt: string | null;
  limitHit: AmpleFileRequestLimitHit | null;
  /** Set when startup reconciliation settled this request, so no one continues it. */
  reconciledAt: string | null;
  /** Always `null`. The field keeps stored records' shape. */
  remote: null;
  /** The original assignment, retained when answers and follow-ups join. */
  assignment: string;
  /** The newest turn's message text, bounded. */
  content: string;
  attachments: AmpleFileAgentAttachmentRef[];
  actions: AmpleFileRequestAction[];
  continuedFromTaskId: string | null;
}

export interface AmpleFileQuestionRecord {
  schema: typeof ampleFileQuestionRecordSchema;
  questionId: string;
  requestId: string;
  /** Denormalized so "any open question under this root" is one index hit. */
  rootId: string;
  /** The asking turn. */
  taskId: string;
  respondent: "person" | "parent";
  text: string;
  /**
   * Suggested answers, shown as choices the person can pick with one click.
   * Absent when the question offered none; any free-text answer is still
   * accepted either way.
   */
  options?: string[];
  asynchronous?: boolean;
  askedAt: string;
  updatedAt: string;
  /** A question lives exactly as long as its request. */
  expiresAt: string | null;
  state: "open" | "answered" | "expired" | "cancelled";
  answer: string | null;
  answeredAt: string | null;
  /** The single linked continuation turn an answer starts; set once, never twice. */
  continuationTaskId: string | null;
  /** Enforces the refusal of an answer from a Connected Folder that does not own the question. */
  answeredByConnectedFolderId: string | null;
}

export interface AmpleFileResultFileRef {
  /** Connected Folder–relative deliverable path. */
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface AmpleFileResultEnvelope {
  summary: string;
  data?: unknown;
  files?: AmpleFileResultFileRef[];
  outcome: AmpleFileResultOutcome;
}

export interface AmpleFileResultRecord {
  schema: typeof ampleFileResultRecordSchema;
  resultId: string;
  requestId: string;
  rootId: string;
  taskId: string;
  recordedAt: string;
  /** The act receipt id the reporting verb journaled. */
  receiptId: string;
  envelope: AmpleFileResultEnvelope;
}

/**
 * A bound was reached. The message always names the number and the Settings
 * section that shows it, because a bound a person cannot find is a gate in
 * disguise (docs/act-ledger.md).
 */
export class AmpleFileRequestLimitError extends Error {
  readonly limit: AmpleFileRequestLimitName;

  constructor(limit: AmpleFileRequestLimitName, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AmpleFileRequestLimitError";
    this.limit = limit;
  }
}

/** Something about the request graph itself is wrong; not a bound, so not a limit error. */
export class AmpleFileRequestLineageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AmpleFileRequestLineageError";
  }
}

function kilobytes(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * The person-facing text for one bound. `cap` is the number actually
 * enforced, so a host that raises a default cannot leave a stale number in
 * the refusal.
 */
export function ampleFileRequestLimitMessage(limit: AmpleFileRequestLimitName, cap: number): string {
  const shows = `${ampleFileRequestLimitsSection} shows this number.`;
  switch (limit) {
    case "childTasks":
      return `This request has already started ${cap} Worker turns, the most one request may start. ${shows}`;
    case "depth":
      return `This request is already ${cap} levels deep, as deep as one request may go. ${shows}`;
    case "concurrentChildren":
      return `This request already has ${cap} Worker turns running at once, the most it may run together. ${shows}`;
    case "continuations":
      return `This request already got ${cap} follow-up turns, so AmpleFile recorded this result without starting another. ${shows}`;
    case "providerBudget":
      return `This request reached its model spending limit of $${cap}, so AmpleFile stopped it. ${shows}`;
    case "questionLifetime":
      return `This question's request passed its ${Math.round(cap / 3_600_000)}-hour window, so it can no longer be answered. ${shows}`;
    case "questionText":
      return `A question may be at most ${kilobytes(cap)} of text. ${shows}`;
    case "questionOptions":
      return `A question may offer at most ${cap} choices. ${shows}`;
    case "questionOptionText":
      return `Each choice may be at most ${kilobytes(cap)} of text. ${shows}`;
    case "answerText":
      return `An answer may be at most ${kilobytes(cap)} of text. ${shows}`;
    case "checklistItems":
      return `A checklist may hold at most ${cap} items. ${shows}`;
    case "checklistItemText":
      return `Each checklist item may be at most ${kilobytes(cap)} of text. ${shows}`;
    case "resultSummary":
      return `A result summary may be at most ${kilobytes(cap)} of text. ${shows}`;
    case "resultData":
      return `Result details may be at most ${kilobytes(cap)} of JSON. ${shows}`;
    case "resultFiles":
      return `A result may name at most ${cap} files. ${shows}`;
    case "questionsPerRequest":
      return `This request already holds ${cap} questions, the most one request may hold. ${shows}`;
    case "resultsPerRequest":
      return `This request already holds ${cap} results, the most one request may hold. ${shows}`;
    case "turnsPerRequest":
      return `This request already holds ${cap} turns, the most one request may hold. ${shows}`;
    case "actionsPerRequest":
      return `This request already recorded ${cap} actions, the most one request may record. ${shows}`;
  }
}

export function ampleFileRequestLimitError(limit: AmpleFileRequestLimitName, cap: number): AmpleFileRequestLimitError {
  return new AmpleFileRequestLimitError(limit, ampleFileRequestLimitMessage(limit, cap));
}

export interface AmpleFileRequestStateInput {
  stopRequestedAt: string | null;
  /** This request's own turns, in acceptance order. */
  turnStates: readonly AmpleFileRequestTurnState[];
  /** Open questions this request asked itself. */
  openQuestions: number;
  openBlockingQuestions?: number;
  /** Open questions anywhere below this request. */
  openDescendantQuestions: number;
  /** One entry per recorded child id; `null` when that id resolves to no record. */
  childStates: readonly (AmpleFileRequestState | null)[];
  resultOutcomes: readonly AmpleFileResultOutcome[];
  limitHit: AmpleFileRequestLimitHit | null;
  /** This request's background jobs. A running one is outstanding work. */
  jobStates?: readonly AmpleFileRequestJobState[];
}

/**
 * The one place a request's state is decided, in a fixed precedence so the
 * same facts always read the same way:
 *
 *  1. a stop was asked for                        → stopped
 *  2. one of this request's turns was stopped     → stopped
 *  3. the model spending bound was reached        → failed
 *  4. a question this request asked is open       → waiting
 *  5. one of this request's turns or background jobs is running → working
 *  6. a question below this request is open       → waiting
 *  7. a child is still working                    → handed_off
 *  8. a turn failed, a background job was interrupted, a child failed, or a
 *     child id resolves to nothing                → failed
 *  9. a child was stopped or ran out of time      → stopped
 * 10. a recorded result came back partial or failed → partial
 * 11. otherwise                                   → done
 *
 * Rules 1-3 dominate so a stop or a spending stop is never narrated as done.
 * Rule 4 above rule 5: asking puts the asking task in `waiting`, even while
 * its turn is still live, so the question reaches Needs you. Rule 5 above
 * rule 6: a parent is working while its own turn runs, and only once that
 * turn ends does a child's open question make the parent report `waiting`
 * rather than blocking on it. Rules 5-7 keep the promise that a request
 * never claims `done` while work it started is still running. Rule
 * 9 above rule 10 means a mixed set of stopped and finished children reads as
 * `stopped` rather than as partial success.
 */
export function computeAmpleFileRequestState(input: AmpleFileRequestStateInput): AmpleFileRequestState {
  if (input.stopRequestedAt !== null) return "stopped";
  if (input.turnStates.includes("aborted")) return "stopped";
  if (input.limitHit?.limit === "providerBudget") return "failed";

  const jobStates = input.jobStates ?? [];
  const running = input.turnStates.some((state) => state === "accepted" || state === "running")
    || jobStates.includes("running");

  if ((input.openBlockingQuestions ?? input.openQuestions) > 0) return "waiting";
  if (running) return "working";
  if (input.openQuestions > 0) return "waiting";
  if (input.openDescendantQuestions > 0) return "waiting";
  if (input.childStates.some((state) => state === "working" || state === "waiting" || state === "handed_off")) {
    return "handed_off";
  }
  if (input.turnStates.some((state) => state === "failed" || state === "interrupted")) return "failed";
  if (jobStates.includes("interrupted")) return "failed";
  if (input.childStates.some((state) => state === null || state === "failed")) return "failed";
  if (input.childStates.some((state) => state === "stopped" || state === "expired")) return "stopped";
  if (input.resultOutcomes.some((outcome) => outcome === "partial" || outcome === "failed")) return "partial";
  if (input.childStates.some((state) => state === "partial")) return "partial";
  return "done";
}

/**
 * The phase vocabulary `agent status` and the popover already speak. The
 * request's true state travels beside it, so those surfaces keep compiling
 * while the richer vocabulary reaches the ones that want it.
 */
export type AmpleFileRequestAgentPhase =
  | "working"
  | "needs_you"
  | "handed_off"
  | "done"
  | "failed"
  | "stopped";

export function ampleFileRequestStateToAgentPhase(state: AmpleFileRequestState): AmpleFileRequestAgentPhase {
  const phase = ((): AmpleFileRequestAgentPhase => {
    switch (state) {
      case "working":
        return "working";
      case "waiting":
        return "needs_you";
      case "handed_off":
        return "handed_off";
      case "done":
      case "partial":
        return "done";
      case "failed":
        return "failed";
      case "stopped":
      case "expired":
        return "stopped";
    }
  })();
  return phase;
}

// --- parsers -------------------------------------------------------------

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertClosedShape(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} has an unexpected field: ${unexpected}.`);
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length || value.length > maximumStableIdLength || !stableIdPattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value;
}

function nullableIsoDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return isoDate(value, label);
}

function boundedText(value: unknown, label: string, maxBytes: number, limit?: AmpleFileRequestLimitName): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    if (limit) throw ampleFileRequestLimitError(limit, maxBytes);
    throw new Error(`${label} is longer than ${maxBytes} bytes.`);
  }
  if (forbiddenTextPattern.test(value.replace(/[\n\r\t]/g, " "))) {
    throw new Error(`${label} contains unsupported control characters.`);
  }
  return value;
}

/**
 * Makes free text safe to store in a record that `boundedText` will re-read:
 * a vertical tab, form feed, or NEL (Word's soft line break among them)
 * becomes a line break, and every other C0/C1 or bidi control becomes U+FFFD,
 * the replacement act receipts use. The result is then cut to `maxBytes` on
 * a character boundary. Message text arrives from a person, so the store
 * scrubs it rather than refusing the turn that carries it.
 */
export function scrubAmpleFileRequestText(value: string, maxBytes: number): string {
  const scrubbed = value
    .replace(/[\u000b\u000c\u0085]/gu, "\n")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\u202a-\u202e\u2066-\u2069]/gu, "\uFFFD");
  const bytes = Buffer.from(scrubbed, "utf8");
  if (bytes.length <= maxBytes) return scrubbed;
  // Step back over UTF-8 continuation bytes so the cut never splits a
  // character, rather than storing a replacement glyph the person never wrote.
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${label} is invalid.`);
  return value as T;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function stringArray(value: unknown, label: string, maxItems?: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  if (maxItems !== undefined && value.length > maxItems) throw new Error(`${label} holds more than ${maxItems} entries.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.length || item.length > maximumResultFilePathLength) {
      throw new Error(`${label} entry ${index + 1} is invalid.`);
    }
    return item;
  });
}

export function parseAmpleFileAttachmentRef(value: unknown, label: string): AmpleFileAgentAttachmentRef {
  const record = objectValue(value, label);
  assertClosedShape(record, ["kind", "target", "name"], label);
  return {
    kind: enumValue(record.kind, ["file", "folder", "url"] as const, `${label} kind`),
    target: boundedText(record.target, `${label} target`, 4_096),
    name: boundedText(record.name, `${label} name`, 1_024),
  };
}

/** The most `sources` or `copied` entries one action keeps; the rest are counted, not listed. */
export const ampleFileRequestActionListMaxEntries = 256;

/** The longest path one `sources` or `copied` entry keeps. */
export const ampleFileRequestActionPathMaxLength = maximumResultFilePathLength;

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid.`);
  return value;
}

export function parseAmpleFileRequestAction(value: unknown, label = "Request action"): AmpleFileRequestAction {
  const record = objectValue(value, label);
  assertClosedShape(
    record,
    ["command", "at", "connectedFolderId", "connectedFolderName", "sources", "copied", "sourcesOmitted", "copiedOmitted", "checkpointId", "connectedFolderRoot", "conversationId", "taskId"],
    label,
  );
  const action: AmpleFileRequestAction = {
    command: enumValue(record.command, ampleFileRequestActionCommands, `${label} command`),
    at: isoDate(record.at, `${label} time`),
  };
  if (record.connectedFolderId !== undefined) action.connectedFolderId = stableId(record.connectedFolderId, `${label} Connected Folder id`);
  if (record.connectedFolderName !== undefined) action.connectedFolderName = boundedText(record.connectedFolderName, `${label} Connected Folder name`, 1_024);
  if (record.sources !== undefined) action.sources = stringArray(record.sources, `${label} sources`, ampleFileRequestActionListMaxEntries);
  if (record.copied !== undefined) action.copied = stringArray(record.copied, `${label} destinations`, ampleFileRequestActionListMaxEntries);
  if (record.sourcesOmitted !== undefined) action.sourcesOmitted = positiveInteger(record.sourcesOmitted, `${label} omitted sources`);
  if (record.copiedOmitted !== undefined) action.copiedOmitted = positiveInteger(record.copiedOmitted, `${label} omitted destinations`);
  if (record.checkpointId !== undefined) {
    action.checkpointId = record.checkpointId === null ? null : stableId(record.checkpointId, `${label} restore point`);
  }
  if (record.connectedFolderRoot !== undefined) action.connectedFolderRoot = boundedText(record.connectedFolderRoot, `${label} Connected Folder root`, 4_096);
  if (record.conversationId !== undefined) action.conversationId = stableId(record.conversationId, `${label} conversation id`);
  if (record.taskId !== undefined) action.taskId = stableId(record.taskId, `${label} task id`);
  return action;
}

function parseTurnRef(value: unknown, index: number): AmpleFileRequestTurnRef {
  const label = `Request turn ${index + 1}`;
  const record = objectValue(value, label);
  assertClosedShape(record, ["taskId", "acceptedAt", "role", "state", "settledAt", "messageId", "error"], label);
  return {
    taskId: stableId(record.taskId, `${label} task id`),
    acceptedAt: isoDate(record.acceptedAt, `${label} acceptance time`),
    role: enumValue(record.role, ["origin", "continuation"] as const, `${label} role`),
    state: enumValue(
      record.state,
      ["accepted", "running", "succeeded", "failed", "aborted", "interrupted"] as const,
      `${label} state`,
    ),
    settledAt: nullableIsoDate(record.settledAt, `${label} settle time`),
    messageId: record.messageId === null || record.messageId === undefined
      ? null
      : stableId(record.messageId, `${label} reply id`),
    error: record.error === null || record.error === undefined
      ? null
      : boundedText(record.error, `${label} error`, maximumErrorLength),
  };
}

function parseJobRef(value: unknown, index: number): AmpleFileRequestJobRef {
  const label = `Request background job ${index + 1}`;
  const record = objectValue(value, label);
  assertClosedShape(record, ["jobId", "taskId", "name", "state", "startedAt", "settledAt", "exitCode", "service"], label);
  if (record.service !== undefined && typeof record.service !== "boolean") throw new Error(`${label} service must be boolean.`);
  const jobId = stableId(record.jobId, `${label} id`);
  if (!ampleFileJobRefIdPattern.test(jobId)) throw new Error(`${label} id is invalid.`);
  const exitCode = record.exitCode === null || record.exitCode === undefined ? null : record.exitCode;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))) throw new Error(`${label} exit code is invalid.`);
  return {
    jobId,
    ...(record.service === undefined ? {} : { service: record.service as boolean }),
    taskId: stableId(record.taskId, `${label} task id`),
    name: boundedText(record.name, `${label} name`, 512),
    state: enumValue(record.state, ["running", "exited", "stopped", "timed_out", "failed", "interrupted"] as const, `${label} state`),
    startedAt: isoDate(record.startedAt, `${label} start time`),
    settledAt: nullableIsoDate(record.settledAt, `${label} settle time`),
    exitCode: exitCode as number | null,
  };
}

function parseResultRef(value: unknown, index: number): AmpleFileRequestResultRef {
  const label = `Request result ${index + 1}`;
  const record = objectValue(value, label);
  assertClosedShape(record, ["resultId", "taskId", "outcome", "recordedAt", "receiptId", "fileCount"], label);
  const resultId = stableId(record.resultId, `${label} id`);
  if (!ampleFileResultIdPattern.test(resultId)) throw new Error(`${label} id is invalid.`);
  return {
    resultId,
    taskId: stableId(record.taskId, `${label} task id`),
    outcome: enumValue(record.outcome, ["succeeded", "partial", "failed"] as const, `${label} outcome`),
    recordedAt: isoDate(record.recordedAt, `${label} time`),
    receiptId: stableId(record.receiptId, `${label} receipt id`),
    fileCount: nonNegativeInteger(record.fileCount, `${label} file count`),
  };
}

function parseUsage(value: unknown): AmpleFileRequestUsage {
  const record = objectValue(value, "Request usage");
  assertClosedShape(record, ["turns", "inputTokens", "outputTokens", "amountUsd", "amountUsdComplete"], "Request usage");
  if (typeof record.amountUsdComplete !== "boolean") throw new Error("Request usage completeness is invalid.");
  const usage: AmpleFileRequestUsage = {
    turns: nonNegativeInteger(record.turns, "Request usage turn count"),
    inputTokens: nonNegativeInteger(record.inputTokens, "Request usage input tokens"),
    outputTokens: nonNegativeInteger(record.outputTokens, "Request usage output tokens"),
    amountUsdComplete: record.amountUsdComplete,
  };
  if (record.amountUsd !== undefined) {
    if (typeof record.amountUsd !== "number" || !Number.isFinite(record.amountUsd) || record.amountUsd < 0) {
      throw new Error("Request usage cost is invalid.");
    }
    usage.amountUsd = record.amountUsd;
  }
  return usage;
}

export function parseAmpleFileRequestRecord(value: unknown): AmpleFileRequestRecord {
  const label = "Request record";
  const record = objectValue(value, label);
  if (record.schema !== ampleFileRequestRecordSchema) throw new Error(`${label} schema is unsupported.`);
  assertClosedShape(
    record,
    [
      "schema", "requestId", "kind", "rootId", "parentRequestId", "parentTaskId", "depth", "owner", "app", "surface",
      "createdAt", "updatedAt", "settledAt", "deadline", "state", "turns", "childRequestIds", "questionIds", "results",
      "usage", "continuationCount", "stopRequestedAt", "limitHit", "reconciledAt", "remote", "content", "attachments",
      "actions", "continuedFromTaskId", "assignment", "deliveredChildTaskIds", "continuationState",
      "jobs", "deliveredJobIds", "checklist",
    ],
    label,
  );
  const requestId = stableId(record.requestId, `${label} id`);
  if (!ampleFileRequestIdPattern.test(requestId)) throw new Error(`${label} id is invalid.`);
  const rootId = stableId(record.rootId, `${label} root id`);
  if (!ampleFileRequestIdPattern.test(rootId)) throw new Error(`${label} root id is invalid.`);

  const ownerRecord = objectValue(record.owner, `${label} owner`);
  assertClosedShape(ownerRecord, ["connectedFolderId", "connectedFolderName", "conversationId"], `${label} owner`);
  const owner: AmpleFileRequestOwner = { conversationId: stableId(ownerRecord.conversationId, `${label} conversation id`) };
  if (ownerRecord.connectedFolderId !== undefined) owner.connectedFolderId = stableId(ownerRecord.connectedFolderId, `${label} Connected Folder id`);
  if (ownerRecord.connectedFolderName !== undefined) owner.connectedFolderName = boundedText(ownerRecord.connectedFolderName, `${label} Connected Folder name`, 1_024);

  const turns = Array.isArray(record.turns) ? record.turns.map(parseTurnRef) : null;
  if (!turns || !turns.length) {
    throw new Error(`${label} turns are invalid.`);
  }
  if (turns[0]!.role !== "origin") throw new Error(`${label} does not start with its own turn.`);

  const parsed: AmpleFileRequestRecord = {
    schema: ampleFileRequestRecordSchema,
    requestId,
    kind: enumValue(record.kind, ["agent", "connected-folder", "app", "automation", "cli"] as const, `${label} kind`),
    rootId,
    parentRequestId: record.parentRequestId === null || record.parentRequestId === undefined
      ? null
      : stableId(record.parentRequestId, `${label} parent id`),
    parentTaskId: record.parentTaskId === null || record.parentTaskId === undefined
      ? null
      : stableId(record.parentTaskId, `${label} parent task id`),
    depth: nonNegativeInteger(record.depth, `${label} depth`),
    owner,
    surface: enumValue(
      record.surface,
      ["cli", "popover", "main-window", "renderer", "system"] as const,
      `${label} surface`,
    ),
    createdAt: isoDate(record.createdAt, `${label} creation time`),
    updatedAt: isoDate(record.updatedAt, `${label} update time`),
    settledAt: nullableIsoDate(record.settledAt, `${label} settle time`),
    deadline: nullableIsoDate(record.deadline, `${label} window`),
    state: enumValue(
      record.state,
      ["working", "waiting", "handed_off", "done", "partial", "failed", "stopped", "expired"] as const,
      `${label} state`,
    ),
    turns,
    childRequestIds: stringArray(record.childRequestIds, `${label} child ids`)
      .map((id) => {
        if (!ampleFileRequestIdPattern.test(id)) throw new Error(`${label} child id is invalid.`);
        return id;
      }),
    questionIds: stringArray(record.questionIds, `${label} question ids`)
      .map((id) => {
        if (!ampleFileQuestionIdPattern.test(id)) throw new Error(`${label} question id is invalid.`);
        return id;
      }),
    results: Array.isArray(record.results)
      ? record.results.map(parseResultRef)
      : (() => { throw new Error(`${label} results are invalid.`); })(),
    usage: parseUsage(record.usage),
    continuationCount: nonNegativeInteger(record.continuationCount, `${label} follow-up count`),
    deliveredChildTaskIds: stringArray(record.deliveredChildTaskIds ?? [], `${label} delivered children`),
    continuationState: record.continuationState === null || record.continuationState === undefined ? null
      : enumValue(record.continuationState, ["pending", "failed"] as const, `${label} continuation`),
    stopRequestedAt: nullableIsoDate(record.stopRequestedAt, `${label} stop time`),
    limitHit: record.limitHit === null || record.limitHit === undefined ? null : parseLimitHit(record.limitHit, label),
    reconciledAt: nullableIsoDate(record.reconciledAt, `${label} recovery time`),
    remote: nullField(record.remote, `${label} remote reference`),
    content: boundedText(record.content, `${label} message`, ampleFileRequestLimits.maxRequestContentBytes),
    assignment: boundedText(record.assignment ?? record.content, `${label} assignment`, ampleFileRequestLimits.maxRequestContentBytes),
    attachments: Array.isArray(record.attachments) && record.attachments.length <= maxAmpleFileAgentAttachments
      ? record.attachments.map((item, index) => parseAmpleFileAttachmentRef(item, `${label} attachment ${index + 1}`))
      : (() => { throw new Error(`${label} attachments are invalid.`); })(),
    actions: Array.isArray(record.actions)
      ? record.actions
        .filter((item) => !isRetiredAmpleFileRequestAction(item))
        .map((item, index) => parseAmpleFileRequestAction(item, `${label} action ${index + 1}`))
      : (() => { throw new Error(`${label} actions are invalid.`); })(),
    continuedFromTaskId: record.continuedFromTaskId === null || record.continuedFromTaskId === undefined
      ? null
      : stableId(record.continuedFromTaskId, `${label} earlier task id`),
  };
  if (record.jobs !== undefined) {
    if (!Array.isArray(record.jobs)) throw new Error(`${label} background jobs are invalid.`);
    parsed.jobs = record.jobs.map(parseJobRef);
  }
  if (record.checklist !== undefined) parsed.checklist = parseAmpleFileChecklist(record.checklist);
  if (record.deliveredJobIds !== undefined) {
    parsed.deliveredJobIds = stringArray(record.deliveredJobIds, `${label} delivered background jobs`).map((id) => {
      if (!ampleFileJobRefIdPattern.test(id)) throw new Error(`${label} delivered background job id is invalid.`);
      return id;
    });
  }
  if (record.app !== undefined) {
    const app = objectValue(record.app, `${label} app`);
    assertClosedShape(app, ["connectedFolderId", "appId", "featureInstallationId", "digest"], `${label} app`);
    parsed.app = {
      connectedFolderId: stableId(app.connectedFolderId, `${label} app Connected Folder id`),
      appId: stableId(app.appId, `${label} app id`),
      featureInstallationId: stableId(app.featureInstallationId, `${label} app installation id`),
      digest: stableId(app.digest, `${label} app fingerprint`),
    };
  }
  if (parsed.parentRequestId === null && parsed.rootId !== parsed.requestId) {
    throw new Error(`${label} claims a root it does not belong to.`);
  }
  return parsed;
}

function parseLimitHit(value: unknown, label: string): AmpleFileRequestLimitHit {
  const record = objectValue(value, `${label} limit`);
  assertClosedShape(record, ["limit", "at"], `${label} limit`);
  return {
    limit: enumValue(
      record.limit,
      [
        "childTasks", "depth", "concurrentChildren", "continuations", "providerBudget", "questionLifetime",
        "questionText", "answerText", "resultSummary", "resultData", "resultFiles", "questionsPerRequest",
        "resultsPerRequest", "turnsPerRequest", "actionsPerRequest",
      ] as const,
      `${label} limit name`,
    ),
    at: isoDate(record.at, `${label} limit time`),
  };
}

function nullField(value: unknown, label: string): null {
  if (value !== null && value !== undefined) throw new Error(`${label} must be null.`);
  return null;
}

export function parseAmpleFileQuestionRecord(value: unknown): AmpleFileQuestionRecord {
  const label = "Question record";
  const record = objectValue(value, label);
  if (record.asynchronous !== undefined && typeof record.asynchronous !== "boolean") throw new Error("Question asynchronous must be a boolean.");
  if (record.schema !== ampleFileQuestionRecordSchema) throw new Error(`${label} schema is unsupported.`);
  assertClosedShape(
    record,
    [
      "schema", "questionId", "requestId", "rootId", "taskId", "respondent", "text", "options", "askedAt", "updatedAt",
      "expiresAt", "state", "answer", "answeredAt", "continuationTaskId", "answeredByConnectedFolderId", "asynchronous",
    ],
    label,
  );
  const questionId = stableId(record.questionId, `${label} id`);
  if (!ampleFileQuestionIdPattern.test(questionId)) throw new Error(`${label} id is invalid.`);
  const requestId = stableId(record.requestId, `${label} request id`);
  if (!ampleFileRequestIdPattern.test(requestId)) throw new Error(`${label} request id is invalid.`);
  const rootId = stableId(record.rootId, `${label} root id`);
  if (!ampleFileRequestIdPattern.test(rootId)) throw new Error(`${label} root id is invalid.`);
  return {
    schema: ampleFileQuestionRecordSchema,
    questionId,
    requestId,
    rootId,
    taskId: stableId(record.taskId, `${label} task id`),
    respondent: enumValue(record.respondent, ["person", "parent"] as const, `${label} respondent`),
    text: boundedText(record.text, `${label} text`, ampleFileRequestLimits.maxQuestionTextBytes, "questionText"),
    ...(record.options === undefined || record.options === null ? {} : { options: parseAmpleFileQuestionOptions(record.options) }),
    ...(record.asynchronous === undefined ? {} : { asynchronous: record.asynchronous as boolean }),
    askedAt: isoDate(record.askedAt, `${label} time`),
    updatedAt: isoDate(record.updatedAt, `${label} update time`),
    expiresAt: nullableIsoDate(record.expiresAt, `${label} window`),
    state: enumValue(record.state, ["open", "answered", "expired", "cancelled"] as const, `${label} state`),
    answer: record.answer === null || record.answer === undefined
      ? null
      : boundedText(record.answer, `${label} answer`, ampleFileRequestLimits.maxAnswerTextBytes, "answerText"),
    answeredAt: nullableIsoDate(record.answeredAt, `${label} answer time`),
    continuationTaskId: record.continuationTaskId === null || record.continuationTaskId === undefined
      ? null
      : stableId(record.continuationTaskId, `${label} follow-up task id`),
    answeredByConnectedFolderId: record.answeredByConnectedFolderId === null || record.answeredByConnectedFolderId === undefined
      ? null
      : stableId(record.answeredByConnectedFolderId, `${label} answering Connected Folder id`),
  };
}

/** A request's checklist items: non-empty one-line text with a status. An empty list clears it. */
export function parseAmpleFileChecklistItems(value: unknown): AmpleFileChecklistItem[] {
  if (!Array.isArray(value)) throw new Error("A checklist must be a list of items.");
  if (value.length > ampleFileRequestLimits.maxChecklistItems) throw ampleFileRequestLimitError("checklistItems", ampleFileRequestLimits.maxChecklistItems);
  return value.map((raw) => {
    const item = objectValue(raw, "A checklist item");
    assertClosedShape(item, ["text", "status"], "A checklist item");
    const text = boundedText(item.text, "A checklist item", ampleFileRequestLimits.maxChecklistItemBytes, "checklistItemText").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("A checklist item cannot be empty.");
    return { text, status: enumValue(item.status, ["todo", "doing", "done"] as const, "A checklist item's status") };
  });
}

function parseAmpleFileChecklist(value: unknown): AmpleFileChecklist {
  const checklist = objectValue(value, "Request checklist");
  assertClosedShape(checklist, ["items", "updatedAt", "taskId"], "Request checklist");
  return {
    items: parseAmpleFileChecklistItems(checklist.items),
    updatedAt: isoDate(checklist.updatedAt, "Request checklist time"),
    taskId: stableId(checklist.taskId, "Request checklist task id"),
  };
}

/**
 * A question's suggested answers: each is non-empty single-line text, none
 * repeats, and an empty list is the same as offering none.
 */
export function parseAmpleFileQuestionOptions(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Question choices must be a list of text.");
  if (value.length > ampleFileRequestLimits.maxQuestionOptions) throw ampleFileRequestLimitError("questionOptions", ampleFileRequestLimits.maxQuestionOptions);
  const options = value.map((item) => {
    const text = boundedText(item, "A question choice", ampleFileRequestLimits.maxQuestionOptionBytes, "questionOptionText").trim();
    if (!text) throw new Error("A question choice cannot be empty.");
    if (/[\n\r]/.test(text)) throw new Error("A question choice must be one line.");
    return text;
  });
  if (new Set(options).size !== options.length) throw new Error("A question offers the same choice twice.");
  return options;
}

/**
 * The one result shape (docs/collaboration-contract.md). Sizes are bounds, so
 * a refusal here is a `AmpleFileRequestLimitError` that names its number;
 * anything else about the shape is an ordinary error.
 */
export function parseAmpleFileResultEnvelope(value: unknown): AmpleFileResultEnvelope {
  const label = "Result";
  const record = objectValue(value, label);
  assertClosedShape(record, ["summary", "data", "files", "outcome"], label);
  const summary = boundedText(record.summary, `${label} summary`, ampleFileRequestLimits.maxResultSummaryBytes, "resultSummary");
  if (!summary.trim()) throw new Error(`${label} summary cannot be empty.`);
  const envelope: AmpleFileResultEnvelope = {
    summary,
    outcome: enumValue(record.outcome, ["succeeded", "partial", "failed"] as const, `${label} outcome`),
  };
  if (record.data !== undefined) {
    const serialized = JSON.stringify(record.data);
    if (serialized === undefined) throw new Error(`${label} details must be JSON.`);
    if (Buffer.byteLength(serialized, "utf8") > ampleFileRequestLimits.maxResultDataBytes) {
      throw ampleFileRequestLimitError("resultData", ampleFileRequestLimits.maxResultDataBytes);
    }
    envelope.data = JSON.parse(serialized) as unknown;
  }
  if (record.files !== undefined) {
    if (!Array.isArray(record.files)) throw new Error(`${label} files must be a list.`);
    envelope.files = record.files.map((item, index) => parseResultFileRef(item, `${label} file ${index + 1}`));
  }
  return envelope;
}

function parseResultFileRef(value: unknown, label: string): AmpleFileResultFileRef {
  const record = objectValue(value, label);
  assertClosedShape(record, ["path", "sha256", "sizeBytes"], label);
  const path = boundedText(record.path, `${label} path`, maximumResultFilePathLength);
  assertConnectedFolderRelativeResultPath(path, label);
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`${label} fingerprint is invalid.`);
  return { path, sha256: record.sha256, sizeBytes: nonNegativeInteger(record.sizeBytes, `${label} size`) };
}

/**
 * A deliverable is named relative to the Connected Folder that produced it. Absolute
 * paths, parent traversal, and the reserved `.amplefile/`, `.work-fold/`, and
 * `.pi/` folders are never valid endpoints (AGENTS.md, portable identity).
 */
export function assertConnectedFolderRelativeResultPath(path: string, label = "Result file"): void {
  if (!path.length) throw new Error(`${label} path cannot be empty.`);
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`${label} path must be relative to the Connected Folder.`);
  }
  const segments = path.split(/[\\/]+/u);
  if (segments.some((segment) => segment === ".." || segment === "." || !segment.length)) {
    throw new Error(`${label} path must be relative to the Connected Folder.`);
  }
  if (containsReservedConnectedFolderPathSegment(path)) {
    throw new Error(`${label} path names reserved .amplefile, .work-fold, or .pi metadata.`);
  }
}

export function parseAmpleFileResultRecord(value: unknown): AmpleFileResultRecord {
  const label = "Result record";
  const record = objectValue(value, label);
  if (record.schema !== ampleFileResultRecordSchema) throw new Error(`${label} schema is unsupported.`);
  assertClosedShape(record, ["schema", "resultId", "requestId", "rootId", "taskId", "recordedAt", "receiptId", "envelope"], label);
  const resultId = stableId(record.resultId, `${label} id`);
  if (!ampleFileResultIdPattern.test(resultId)) throw new Error(`${label} id is invalid.`);
  const requestId = stableId(record.requestId, `${label} request id`);
  if (!ampleFileRequestIdPattern.test(requestId)) throw new Error(`${label} request id is invalid.`);
  const rootId = stableId(record.rootId, `${label} root id`);
  if (!ampleFileRequestIdPattern.test(rootId)) throw new Error(`${label} root id is invalid.`);
  return {
    schema: ampleFileResultRecordSchema,
    resultId,
    requestId,
    rootId,
    taskId: stableId(record.taskId, `${label} task id`),
    recordedAt: isoDate(record.recordedAt, `${label} time`),
    receiptId: stableId(record.receiptId, `${label} receipt id`),
    envelope: parseAmpleFileResultEnvelope(record.envelope),
  };
}
