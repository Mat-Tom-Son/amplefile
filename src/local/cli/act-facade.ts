/**
 * In-process authority the act-lane executor calls to apply commands. The
 * interactive local API implements this interface inside `startLocalApi`
 * (where the chat runtime state lives) and exposes it on `LocalApiHandle`;
 * the desktop CLI host receives it through a getter that answers null while
 * the interactive app is not running. Methods throw `AmpleFileCliError` so
 * exit codes map without translation.
 */

import type { AmpleFileCliActLegacySurface, AmpleFileCliActSurface } from "./act-receipts.js";
import type { AmpleFileOverviewSnapshot } from "../overview.js";
import type { AmpleFileAgentAttachmentDisposition, AmpleFileAgentAttachmentRef } from "../amplefile-agent-attachments.js";
import type {
  AmpleFileRequestAction,
  AmpleFileRequestKind,
  AmpleFileRequestLimitHit,
  AmpleFileRequestState,
  AmpleFileRequestSurface,
  AmpleFileRequestTurnState,
  AmpleFileRequestUsage,
  AmpleFileResultEnvelope,
  AmpleFileResultOutcome,
} from "../requests/request-records.js";
import type { ConnectedFolderChatMatch, ConnectedFolderFileMatch, ConnectedFolderSearchCoverage } from "../search.js";
import type { HistoryFileComparison, HistoryFileRead, HistoryFileReadOptions, HistoryPageOptions } from "../../shared/history-review.js";

export interface AmpleFileActConnectedFolderRef {
  id: string;
  name: string;
  connectedFolderRoot: string;
}

/** One Recently deleted item, as the act lane reports it: identifiers and paths only. */
export interface AmpleFileActRecentlyDeletedEntry {
  id: string;
  kind: "file" | "folder" | "connected-folder" | "skill" | "app-storage" | "app-retained" | "app-release" | "app-studio";
  reason:
    | "files.delete"
    | "agent.chat.delete"
    | "chats.delete"
    | "connected-folders.delete"
    | "skills.remove"
    | "apps.remove"
    | "apps.connected-folder.removed"
    | "apps.storage.clear"
    | "apps.retained.purge"
    | "apps.uninstall.purge"
    | "apps.release.delete";
  connectedFolderId: string;
  connectedFolderName?: string;
  /** skill only: the scope it goes back into. An Everywhere Skill names the AmpleFile agent's scope as its Connected Folder. */
  scope?: "everywhere" | "connected-folder";
  /** Connected Folder–relative path, a deleted Connected Folder's original folder path, a Skill's path inside its scope's skills folder, `<appId>/<namespace>`, `<projectId>/<releaseDigest>`, or an App Project id (App Studio history). */
  originalPath: string;
  name: string;
  sizeBytes: number;
  sizeApproximate?: true;
  deletedAt: string;
  restoreBy: string;
  receiptId: string | null;
  uncovered?: Array<{ path: string; reason: "too_large" | "unreadable" | "symbolic_link" | "excluded" }>;
  /** A tree holding records from the earlier Workspace product; AmpleFile never erases those. */
  held?: { reason: "legacy-metadata" | "unreadable"; noticedAt: string };
  /**
   * `in-place` goes back where it came from; `save-only` can only be written
   * out as a file with `--to` (app data whose app is gone); `blocked` cannot
   * be brought back right now, and `note` says why.
   */
  restorable: "in-place" | "save-only" | "blocked";
  note?: string;
}

/** The Recently deleted item a destroying verb produced. */
export interface AmpleFileActRecentlyDeletedRef {
  entryId: string;
  restoreBy: string;
}

export interface AmpleFileActConversationRef {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  snoozedUntil: string | null;
}

export type AmpleFileActChatState = "idle" | "running" | "compacting";

/**
 * Task-scoped view of one accepted agent turn. `unknown` means the id was
 * never accepted here or has aged out of the bounded durable turn journal;
 * transcripts remain the long-lived content authority.
 */
export type AmpleFileActTurnState = "running" | "succeeded" | "failed" | "aborted" | "unknown";

export interface AmpleFileActTurnStatus {
  taskId: string;
  state: AmpleFileActTurnState;
  conversationId: string | null;
  messageId: string | null;
  error: string | null;
  endedAt: string | null;
}

export interface AmpleFileActChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  interrupted?: true;
}

/**
 * Lifecycle position of a Chat before a lifecycle act ran. Receipts encode it
 * as the act's undo reference so the inverse verb (re-archive, re-snooze,
 * resume) can be chosen from the receipt alone.
 */
export interface AmpleFileActChatLifecycleState {
  archivedAt: string | null;
  snoozedUntil: string | null;
}

/**
 * Bounded projection of one History restore point. The act lane deliberately
 * returns manifest summaries here; explicit history read/diff commands select
 * bounded file content separately.
 */
export interface AmpleFileActCheckpointSummary {
  checkpointId: string;
  createdAt: string;
  label?: string;
  reason: string;
  scope: "full" | "targeted";
  fileCount: number;
  totalBytes: number;
  skippedFileCount: number;
}

/** One captured version of a Connected Folder file, addressable by content hash. */
export interface AmpleFileActFileVersionRef {
  path: string;
  hashSha256: string;
  sizeBytes: number;
  modifiedAt: string;
  capturedAt: string;
  checkpointId: string;
  checkpointLabel?: string;
}

/**
 * Phase of one request in the vocabulary `agent status` and the popover
 * speak. `working` is the request's own turn; `handed_off` means that turn
 * finished but a Worker turn it started is still running — "done" is
 * never claimed while downstream work continues. `needs_you` is an open
 * question, or a completed turn whose reply ends by asking the person one.
 * The durable record's full state (docs/collaboration-contract.md, F25)
 * travels beside it as `state`: `partial` reads here as `done` and `expired`
 * as `stopped`.
 */
export type AmpleFileActAgentRequestPhase =
  | "working"
  | "needs_you"
  | "handed_off"
  | "done"
  | "failed"
  | "stopped";

export interface AmpleFileActAgentChildStatus {
  taskId: string;
  connectedFolderId: string;
  connectedFolderName: string;
  conversationId: string;
  state: AmpleFileActTurnState;
  error: string | null;
  /** Visible files observed changing between this turn's History captures. */
  files?: string[];
}

/** One attachment's accounted outcome in a request view: `placed`, `registered`, or `unrecorded`. */
export interface AmpleFileActAttachmentDisposition {
  attachment: AmpleFileAgentAttachmentRef;
  status: AmpleFileAgentAttachmentDisposition["status"];
  connectedFolderId?: string;
  connectedFolderName?: string;
  copied?: string[];
  checkpointId?: string | null;
}

export interface AmpleFileActAgentRequest {
  /** The request's newest turn; a continued request names its latest turn here. */
  taskId: string;
  conversationId: string;
  phase: AmpleFileActAgentRequestPhase;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  content: string;
  attachments: AmpleFileAgentAttachmentRef[];
  dispositions: AmpleFileActAttachmentDisposition[];
  actions: AmpleFileRequestAction[];
  children: AmpleFileActAgentChildStatus[];
  reply: { messageId: string; content: string } | null;
  // --- the durable request record beneath the phase (F25), additive.
  requestId: string;
  kind: AmpleFileRequestKind;
  rootId: string;
  state: AmpleFileRequestState;
  deadline: string | null;
  limitHit: AmpleFileRequestLimitHit | null;
  /** Bounded: ids and states, never the question text. */
  questions: Array<{
    questionId: string;
    taskId: string;
    respondent: "person" | "parent";
    state: "open" | "answered" | "expired" | "cancelled";
    askedAt: string;
    answeredAt: string | null;
  }>;
  /** Bounded: ids, outcomes, and file counts, never the summary or data. */
  results: Array<{
    resultId: string;
    taskId: string;
    outcome: AmpleFileResultOutcome;
    recordedAt: string;
    fileCount: number;
  }>;
}

/**
 * F27/F28 (docs/collaboration-contract.md): the request graph as the act lane
 * shows it. A request ref is the compact form every collaboration verb returns
 * beside its own result; the summary and detail forms are what `requests
 * list|show` read. `--json` carries a result's summary and data whole; the
 * human renderer clamps them. Nothing here reaches a Connected Folder transcript.
 */
export interface AmpleFileActRequestRef {
  id: string;
  rootId: string;
  kind: AmpleFileRequestKind;
  state: AmpleFileRequestState;
  /** 0 for a root. */
  depth: number;
  /** Null exactly for the AmpleFile agent scope. */
  connectedFolderId: string | null;
  connectedFolderName: string | null;
  conversationId: string;
  deadline: string | null;
  openQuestions: number;
  children: number;
  results: number;
}

export interface AmpleFileActQuestionRef {
  asynchronous?: boolean;
  questionId: string;
  requestId: string;
  /** The asking turn. */
  taskId: string;
  respondent: "person" | "parent";
  text: string;
  /** Suggested answers, when the question offered any. */
  options?: string[];
  state: "open" | "answered" | "expired" | "cancelled";
  askedAt: string;
  expiresAt: string | null;
  answer: string | null;
  answeredAt: string | null;
  /** The one linked follow-up turn an answer started, once it has. */
  continuationTaskId: string | null;
}

/**
 * F28: the followed task is waiting on an answer. Absent when nothing is
 * owed. This is a fact about the task's request, never a turn state — the
 * turn may still be running or may already have ended.
 */
export interface AmpleFileActWaitingRef {
  questionId: string;
  requestId: string;
  respondent: "person" | "parent";
  question: string;
  askedAt: string;
  expiresAt: string | null;
}

export interface AmpleFileActRequestSummary extends AmpleFileActRequestRef {
  surface: AmpleFileRequestSurface;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  /** The request's newest turn. */
  taskId: string;
  continuationCount: number;
  limitHit: AmpleFileRequestLimitHit | null;
}

export interface AmpleFileActRequestResult {
  resultId: string;
  taskId: string;
  recordedAt: string;
  receiptId: string;
  outcome: AmpleFileResultOutcome;
  fileCount: number;
  /** The whole envelope; null when its file could not be read back, with `damaged` saying why. */
  envelope: AmpleFileResultEnvelope | null;
  damaged?: string;
}

export interface AmpleFileActRequestDetail extends AmpleFileActRequestSummary {
  parentRequestId: string | null;
  parentTaskId: string | null;
  content: string;
  turns: Array<{
    taskId: string;
    role: "origin" | "continuation";
    state: AmpleFileRequestTurnState;
    acceptedAt: string;
    settledAt: string | null;
    error: string | null;
  }>;
  questions: AmpleFileActQuestionRef[];
  resultRecords: AmpleFileActRequestResult[];
  usage: AmpleFileRequestUsage;
  stopRequestedAt: string | null;
  reconciledAt: string | null;
  /** Background jobs this request's turns started (docs/background-jobs.md). */
  jobs: Array<{
    jobId: string;
    taskId: string;
    name: string;
    state: "running" | "exited" | "stopped" | "timed_out" | "failed" | "interrupted";
    startedAt: string;
    settledAt: string | null;
    exitCode: number | null;
  }>;
  /** Every request directly below this one, each with its own subtree. */
  childRequests: AmpleFileActRequestDetail[];
}

/**
 * One background job (docs/background-jobs.md, F31). The command and its
 * folder are the caller's own; output text arrives only from `jobs output`.
 */
export interface AmpleFileActJobRef {
  interactive?: boolean;
  service?: boolean;
  jobId: string;
  name: string;
  command: string;
  cwd: string;
  state: "accepted" | "running" | "exited" | "stopped" | "timed_out" | "failed" | "interrupted";
  /** The same plain sentence the tools and the follow-up turn use. */
  status: string;
  conversationId: string;
  taskId: string;
  requestId: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  stoppedBy: "agent" | "cli" | "request" | "quit" | "timeout" | null;
  error: string | null;
  timeoutSeconds: number | null;
  output: { bytes: number; lines: number; droppedBytes: number; droppedLines: number };
  history:
    | { status: "pending" }
    | { status: "captured"; checkpointId: string; fileCount: number; skippedFileCount: number; skippedByReason: Record<string, number> }
    | { status: "unavailable" | "not_applicable"; reason: string }
    | null;
  delivery: { at: string; by: "read" | "turn_context" | "follow_up"; taskId: string | null } | null;
}

export interface AmpleFileActJobOutput {
  text: string;
  fromLine: number;
  toLine: number;
  totalLines: number;
  totalBytes: number;
  droppedLines: number;
  truncated: boolean;
  nextOffset: number;
}

/** Registered Connected Folder storage kind, mirrored from the Connected Folder registry. */
export type AmpleFileActConnectedFolderStorage = "managed" | "linked";

/**
 * App Studio presentation values, exactly the pane's typed form: a title plus
 * optional description and icon id. The act verb reads them from a typed JSON
 * file resolved host-side, never from free-form argv.
 */
export interface AmpleFileActAppPresentation {
  title: string;
  description: string | null;
  icon: string | null;
}

/** Bounded projection of one immutable content-addressed App Release record. */
export interface AmpleFileActAppReleaseRef {
  releaseDigest: string;
  displayVersion: string;
  state: "prepared" | "published";
  preparedAt: string;
  publishedAt: string | null;
  featureCount: number;
}

/**
 * Bounded projection of one prepared App Studio operation. `fromReleaseDigest`
 * is present exactly for update plans, so a receipt can name the transition by
 * content identity instead of inferring an update-versus-rollback label the
 * service does not record.
 */
export interface AmpleFileActAppOperationRef {
  operationId: string;
  kind: "install" | "update";
  releaseDigest: string;
  runtimeInstanceId: string;
  targetConnectedFolderId: string;
  preparedAt: string;
  fromReleaseDigest?: string;
  continuityPolicy?: "eligible" | "reset";
}

/** Bounded projection of one release-backed App Instance. */
export interface AmpleFileActAppInstanceRef {
  runtimeInstanceId: string;
  connectedFolderId: string;
  releaseDigest: string;
  displayVersion: string;
}

/**
 * Bounded projection of one Chat-bound restricted-app proposal receipt. The
 * review's digest and package identity are the fields a staging or dismissal
 * needs; the full review (manifest, permissions, file counts) stays on the
 * desktop review dialog.
 */
export interface AmpleFileActAppProposalRef {
  id: string;
  status: "pending" | "installed" | "failed" | "dismissed" | "revision-changed";
  sourcePath: string;
  title: string;
  packageName: string;
  version: string;
  digest: string;
  createdAt: string;
  updatedAt: string;
}

/** One declared tool of an installed app, with the schemas a caller needs to invoke it. */
export interface AmpleFileActAppToolRef {
  name: string;
  description: string;
  action: string;
  inputSchema: unknown;
  resultSchema: unknown;
}

/**
 * What one installed app can do, as the AmpleFile agent sees it before acting: its
 * declared tools and Worker actions, the powers it holds, which
 * destinations have a saved connection, and its named automations.
 */
export interface AmpleFileActAppListing {
  appId: string;
  featureInstallationId: string;
  digest: string;
  title: string;
  description: string | null;
  version: string;
  kind: "preview" | "installed";
  tools: AmpleFileActAppToolRef[];
  assistantActions: Array<{ id: string; title: string }>;
  grants: {
    network: string[];
    files: Array<{ declarationId: string; root: string; access: string }>;
    notifications: string[];
    checks: Array<{ permissionId: string; checkId: string }>;
  };
  connections: Array<{ destinationId: string; kind: string | null; configured: boolean }>;
  automations: Array<{ id: string; title: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null }>;
}

/**
 * What an install turned on, and what still needs the person. F21 grants every
 * declared destination, folder permission, notification category, and
 * automation at install; a permission that names a single file, a Check slot
 * in a Connected Folder with several Checks, and a destination whose secret the person
 * types are the deliberate remainder. Both halves ride the result so the
 * AmpleFile agent can say them the way a Worker Chat does.
 */
export interface AmpleFileActAppInstallOutcome {
  granted: {
    destinations: number;
    wholeConnectedFolderFolders: number;
    notifications: number;
    checks: number;
    automations: number;
  };
  needs: {
    /** Destinations whose declared credential the person still enters in Settings → Apps. */
    connections: string[];
    /** Permissions that name a single file the person still chooses. */
    files: string[];
    /** Check-result slots not bound to a Check. */
    checks: string[];
  };
}

/** Bounded projection of one named-automation run receipt. */
export interface AmpleFileActAppAutomationRunRef {
  runId: string;
  outcome: "success" | "failure" | "skipped" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt: string;
  error?: string;
}

/** Bounded projection of an automation's reviewed trigger (docs/automations.md). */
export interface AmpleFileActAutomationTriggerRef {
  kind: "manual" | "interval" | "at" | "on-settled" | "files-changed";
  connectedFolderId?: string;
  watch?: { kind: "tree"; path: string; recursive: boolean; extensions: string[] };
  debounceSeconds?: number;
  cooldownMinutes?: number;
  intervalMinutes?: number;
  at?: string;
  ifMissed?: "run" | "skip";
  source?: {
    kind: "app-automation-run";
    connectedFolderId: string;
    appId?: string;
    appAutomationId?: string;
    outcomes: string[];
  };
}

/**
 * One enablement receipt in an automation's history; `requestId` is the enabling
 * act's request id. A legacy surface appears only on grants an older build
 * recorded.
 */
export interface AmpleFileActAutomationGrantRef {
  digest: string;
  requestId: string;
  enabledAt: string;
  surface: AmpleFileCliActSurface | AmpleFileCliActLegacySurface;
  browserId?: string;
}

/**
 * One-line projection of an automation for `automations list`. Content-bearing by
 * design (titles, Connected Folder ids) and therefore act-lane only: the
 * content-free read lane stays aggregate.
 */
export interface AmpleFileActAutomationSummary {
  automationId: string;
  title: string;
  health: "enabled" | "disabled" | "suspended" | "completed";
  digest: string;
  trigger: AmpleFileActAutomationTriggerRef;
  stepCount: number;
  referencedConnectedFolderIds: string[];
  /** When the live enablement receipt was written; absent unless enabled. */
  enabledAt?: string;
  disabledAt?: string;
  suspension?: { at: string; missingConnectedFolderIds: string[]; reRegisteredConnectedFolderIds: string[] };
  lastScheduledAt?: string;
  nextScheduledAt?: string;
  completedAt?: string;
}

/**
 * An automation step as declared: ids resolved to current Connected Folder names
 * where the Connected Folder is still registered, the chat- and agent-step message verbatim (with
 * its placeholders unfilled — AmpleFile fills them when a run starts), and
 * the files source exactly as declared.
 */
export type AmpleFileActAutomationStepView =
  | { id: string; kind: "chat"; connectedFolderId: string; connectedFolderName?: string; message: string; model?: { provider: string; id: string } }
  | {
    id: string;
    kind: "files";
    fromConnectedFolderId: string;
    fromConnectedFolderName?: string;
    source:
      | { kind: "paths"; paths: string[] }
      | { kind: "tree"; path: string; recursive: boolean; extensions: string[] }
      | { kind: "step-created-files"; step: string; extensions?: string[]; maxFiles: number; maxTotalBytes: number };
    toConnectedFolderId: string;
    toConnectedFolderName?: string;
    to: string;
  }
  | { id: string; kind: "agent"; message: string; model?: { provider: string; id: string } };

export interface AmpleFileActAutomationModel {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  seesImages: boolean;
}

/** The full review projection for `automations show`. */
export interface AmpleFileActAutomationDetail extends AmpleFileActAutomationSummary {
  steps: AmpleFileActAutomationStepView[];
  grants: AmpleFileActAutomationGrantRef[];
}

/**
 * Bounded projection of one automation receipts-journal line. Identifiers,
 * digests, paths, and counts, plus the bounded text AmpleFile itself filled
 * into a chat- or agent-step message — never file contents, and this
 * projection adds nothing to the journal.
 */
export interface AmpleFileActAutomationReceipt {
  at: string;
  scope: "automation" | "run" | "hop";
  outcome: string;
  automationId: string;
  runId?: string;
  hopId?: string;
  hopKind?: "chat" | "files" | "agent";
  title?: string;
  digest?: string;
  detail?: string;
  /** A succeeded hop or run whose Worker reported finishing only partly. */
  partial?: true;
  cause?: unknown;
  connectedFolderId?: string;
  fromConnectedFolderId?: string;
  toConnectedFolderId?: string;
  conversationId?: string;
  taskId?: string;
  checkpointIds?: string[];
  restorePointId?: string;
  sourcePaths?: string[];
  copiedPaths?: string[];
  fileCount?: number;
  totalBytes?: number;
  failedHopId?: string;
  stoppedHopTaskIds?: string[];
  /** What AmpleFile filled into this hop's message. */
  placeholders?: Array<{ name: string; text: string; bytes: number; truncated: boolean }>;
  messageBytes?: number;
  surface?: string;
  /** Legacy field on receipts an older build wrote; never written now. */
  decisionId?: string;
  missingConnectedFolderIds?: string[];
  requestId?: string;
  occurrenceId?: string;
  scheduledRunId?: string;
}

/** The exact installation an install verb produced. Never resolved by display name. */
export interface AmpleFileActInstalledAppRef {
  connectedFolderId: string;
  appId: string;
  featureInstallationId: string;
  digest: string;
  title: string;
  version: string;
}

export interface AmpleFileActFacade {
  workerShow(input: { connectedFolder: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    model: { provider: string; id: string } | null;
    availableModels: Array<{ provider: string; id: string; name: string; reasoning: boolean }>;
    instructions: string;
  }>;
  workerSetModel(input: { connectedFolder: string; provider: string; model: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    model: { provider: string; id: string };
  }>;
  workerSetInstructions(input: {
    connectedFolder: string;
    instructions: string;
    /** Add `instructions` as one more line after the current ones instead of replacing them. */
    append?: boolean;
    parentTaskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    instructions: string;
    /** With `append`: false when that exact line was already there, so nothing changed. */
    appended?: boolean;
  }>;
  createConversation(input: { connectedFolder: string }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef; conversation: AmpleFileActConversationRef }>;
  listConversations(input: { connectedFolder: string }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef; conversations: AmpleFileActConversationRef[] }>;
  sendMessage(input: {
    connectedFolder: string;
    conversationId?: string;
    newConversation?: boolean;
    content: string;
    /** Act-envelope request id reused as the durable turn identity. */
    requestId?: string;
    /** Explicit active AmpleFile agent request that initiated this action. */
    parentTaskId?: string;
  }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef; conversationId: string; messageId: string; taskId: string }>;
  conversationStatus(input: { connectedFolder: string; conversationId: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversation: AmpleFileActConversationRef;
    state: AmpleFileActChatState;
  }>;
  conversationResult(input: { connectedFolder: string; conversationId: string; messages?: number }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversationId: string;
    state: AmpleFileActChatState;
    total: number;
    lastAssistant: string | null;
    messages: AmpleFileActChatMessage[];
  }>;
  abortTurn(input: { connectedFolder: string; conversationId: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversationId: string;
    aborted: boolean;
  }>;
  turnStatus(input: { connectedFolder: string; taskId: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    task: AmpleFileActTurnStatus;
    /** F28: set while this task's request waits on an answer to a question this task asked. */
    waiting: AmpleFileActWaitingRef | null;
    request: AmpleFileActRequestRef | null;
  }>;
  turnResult(input: { connectedFolder: string; taskId: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversationId: string;
    task: { taskId: string; state: "succeeded"; endedAt: string };
    message: AmpleFileActChatMessage;
    request: AmpleFileActRequestRef | null;
    result: AmpleFileResultEnvelope | null;
  }>;

  /**
   * The collaboration verbs (docs/collaboration-contract.md, F27). Each is
   * journal-first and receipted; delivery is host-side, so none of them
   * needs an AmpleFile agent turn. `--task` must name the caller's own turn —
   * the newest, still-running turn of a request the named Connected Folder owns — checked
   * the way `--parent-task` is checked.
   */
  chatReport(input: {
    connectedFolder: string;
    taskId: string;
    summary: string;
    /** Inline JSON already parsed by the CLI. */
    data?: unknown;
    /** `--data @<path>`: resolved host-side against `cwd`, bounded, parsed here. */
    dataPath?: string;
    cwd?: string;
    /** Connected Folder–relative deliverables; each is fingerprinted and measured inside the Connected Folder. */
    files: string[];
    outcome: AmpleFileResultOutcome;
    /** Act-envelope request id, recorded as the result's receipt id. */
    requestId?: string;
    parentTaskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    taskId: string;
    resultId: string;
    result: AmpleFileResultEnvelope;
    request: AmpleFileActRequestRef;
  }>;
  chatChildren(input: { connectedFolder: string; taskId: string }): Promise<{ children: Array<{ taskId: string; conversationId: string; connectedFolderId?: string; state: string; resultAvailable: boolean }> }>;
  chatAsk(input: {
    connectedFolder: string;
    taskId: string;
    question: string;
    respondent: "person" | "parent";
    /** Suggested answers shown as choices; the person can still write their own. */
    options?: string[];
    asynchronous?: boolean;
    requestId?: string;
    parentTaskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    taskId: string;
    question: AmpleFileActQuestionRef;
    request: AmpleFileActRequestRef;
    /** True when --to parent named a root with no parent, so the question went to the person. */
    redirectedToPerson: boolean;
  }>;
  /**
   * Exactly one answer, exactly one linked continuation turn in the same
   * Chat. Refuses a second answer, an answer past the request's window, an
   * answer from a Connected Folder that does not own the question, and an answer while
   * that Chat's turn or compaction is still running (the question stays open
   * and can be answered once the Chat is idle).
   */
  chatAnswer(input: {
    connectedFolder: string;
    questionId: string;
    answer: string;
    requestId?: string;
    parentTaskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    question: AmpleFileActQuestionRef;
    continuation: { taskId: string; messageId: string; conversationId: string } | null;
    queued?: boolean;
    request: AmpleFileActRequestRef;
  }>;
  /**
   * Copies the named files into the destination through the same additive,
   * restore-pointed path as `files add`, then starts a new Chat there through
   * ordinary acceptance as a child of the caller's request. The copy runs
   * first so a refused copy never leaves a started Chat behind.
   */
  chatHandoff(input: {
    connectedFolder: string;
    taskId: string;
    toConnectedFolder: string;
    /**
     * Follow up in a Chat this Chat already handed work to, instead of
     * starting a new one (2026-10-18). That Chat keeps its context.
     */
    toConversationId?: string;
    message: string;
    files: string[];
    requestId?: string;
    parentTaskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    toConnectedFolder: AmpleFileActConnectedFolderRef;
    conversationId: string;
    messageId: string;
    taskId: string;
    copied: string[];
    checkpointId: string | null;
    request: AmpleFileActRequestRef;
    /** True when the message went into an existing Chat rather than a new one. */
    followUp?: boolean;
  }>;
  /**
   * Redirects a Chat's running turn with one more message, delivered after
   * its current step, exactly like typing into it on the desktop. With
   * `taskId`, the caller is a Worker's own running turn and may redirect only
   * a Chat its own Chat handed work to.
   */
  chatSteer(input: {
    connectedFolder: string;
    conversationId: string;
    message: string;
    taskId?: string;
    requestId?: string;
    parentTaskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversationId: string;
    /** The running turn the message joined. */
    taskId: string;
    messageId: string;
    replayed: boolean;
  }>;
  /**
   * Copies a Chat as of its last finished turn into a new Chat in the same
   * Connected Folder, so a different direction can start with the same context.
   * With `message`, the copy starts that work at once; with `taskId` (a
   * Worker's own running turn) it becomes a child of that request and its
   * result comes back like a handoff's.
   */
  chatCopy(input: {
    connectedFolder: string;
    conversationId: string;
    message?: string;
    title?: string;
    taskId?: string;
    requestId?: string;
    parentTaskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversation: AmpleFileActConversationRef;
    copiedFromConversationId: string;
    /** Visible messages carried into the copy. */
    copiedMessages: number;
    /** The copy's first turn, when `message` started one. */
    taskId?: string;
    request?: AmpleFileActRequestRef;
  }>;
  /**
   * Reads of the request graph above all Connected Folders: recent roots, newest first.
   * `cwd` is the caller's directory, which resolves its scope the way
   * `context` does; a caller inside a registered Connected Folder is refused by name,
   * because the graph carries other Connected Folders' results and the AmpleFile agent's own
   * assignment text (docs/collaboration-contract.md, F26).
   */
  requestsList(input?: { cwd?: string }): Promise<{ requests: AmpleFileActRequestSummary[]; truncated: boolean }>;
  requestsShow(input: { request: string; cwd?: string }): Promise<{ request: AmpleFileActRequestDetail }>;

  /**
   * Background jobs (docs/background-jobs.md). `jobsStart` runs a command
   * for the caller's own running turn (`--task`, checked like `chat report`)
   * and returns once it is running; its end wakes that turn's Chat once.
   * Reads and stop name the job's Connected Folder. A read with `taskId` naming a
   * running turn in the job's own Chat counts as its delivery.
   */
  jobsStart(input: {
    interactive?: boolean;
    service?: boolean;
    connectedFolder: string;
    taskId: string;
    command: string;
    name?: string;
    /** Relative to the Connected Folder, or absolute; the Connected Folder by default. Never the caller's directory. */
    cwd?: string;
    timeoutSeconds?: number;
    requestId?: string;
  }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef; job: AmpleFileActJobRef }>;
  jobsList(input: { connectedFolder: string; conversationId?: string; running?: boolean }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef; jobs: AmpleFileActJobRef[] }>;
  jobsShow(input: { connectedFolder: string; jobId: string }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef; job: AmpleFileActJobRef }>;
  jobsOutput(input: {
    connectedFolder: string;
    jobId: string;
    offset?: number;
    limit?: number;
    waitSeconds?: number;
    until?: string;
    taskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    job: AmpleFileActJobRef;
    output: AmpleFileActJobOutput;
    wait: { outcome: "ended" | "matched" | "timed_out" | "aborted"; line?: number; text?: string } | null;
  }>;
  jobsStop(input: { connectedFolder: string; jobId: string; parentTaskId?: string; requestId?: string }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef; job: AmpleFileActJobRef }>;
  jobsInput(input: { connectedFolder: string; taskId: string; jobId: string; text: string; eof?: boolean }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef; job: AmpleFileActJobRef }>;
  worktreesManage(input: { connectedFolder: string; taskId: string; action: "create" | "list" | "archive" | "restore"; id?: string; ref?: string }): Promise<unknown>;

  /**
   * Chat lifecycle verbs (docs/act-ledger.md). Each performs exactly one
   * lifecycle change through the same conversation internals as the desktop
   * PATCH route — append-only lifecycle records in the Chat's portable log,
   * refused while that Chat's turn or compaction runs — and returns
   * the prior state so the act receipt can carry a typed undo reference.
   */
  chatRename(input: { connectedFolder: string; conversationId: string; title: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversation: AmpleFileActConversationRef;
    priorTitle: string;
  }>;
  chatSnooze(input: { connectedFolder: string; conversationId: string; until: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversation: AmpleFileActConversationRef;
    priorLifecycle: AmpleFileActChatLifecycleState;
  }>;
  chatArchive(input: { connectedFolder: string; conversationId: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversation: AmpleFileActConversationRef;
    priorLifecycle: AmpleFileActChatLifecycleState;
  }>;
  chatResume(input: { connectedFolder: string; conversationId: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversation: AmpleFileActConversationRef;
    priorLifecycle: AmpleFileActChatLifecycleState;
  }>;
  /**
   * Compacts one Chat through the same internals as the composer's `/compact`:
   * additive summarization, never deletion. It is refused while that Chat's
   * turn or compaction runs and while a capability mutation is active, and it
   * registers the same kernel `compaction` task as the renderer — started
   * before the compaction and finished on every outcome — whose id is the
   * receipt's task reference.
   */
  chatCompact(input: { connectedFolder: string; conversationId: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversationId: string;
    compacted: true;
    taskId: string;
  }>;

  /**
   * History verbs (docs/act-ledger.md). Saving is additive and honestly
   * reports when the Connected Folder already matches its latest restore point; both
   * restore verbs record the safety restore point History itself created, so
   * every History act is recoverable through History. Whole–Connected Folder restore is
   * refused while Worker or compaction work is active in the
   * Connected Folder, while a restricted-app automation run whose app holds a file
   * grant into the Connected Folder is active, and while an automation run with a files hop
   * targeting the Connected Folder is active (the kernel-checked rule) — a deliberate
   * strengthening over the desktop's confirm dialog.
   */
  historyList(input: { connectedFolder: string } & HistoryPageOptions): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    checkpoints: AmpleFileActCheckpointSummary[];
    total?: number; nextCursor?: string | null; sourceVersion?: string;
  }>;
  historySave(input: { connectedFolder: string; label?: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    checkpoint: AmpleFileActCheckpointSummary;
    created: boolean;
  }>;
  historyRestore(input: { connectedFolder: string; checkpointId: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    restored: true;
    checkpointId: string;
    safetyCheckpointId: string;
    restoredFileCount: number;
    deletedFileCount: number;
    movedEntryCount: number;
    unchangedFileCount: number;
    skippedLargeFileCount: number;
  }>;
  historyVersions(input: { connectedFolder: string; path: string } & HistoryPageOptions): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    path: string;
    versions: AmpleFileActFileVersionRef[];
    total?: number; nextCursor?: string | null; sourceVersion?: string;
  }>;
  /** Content-bearing, read-only review through the authenticated act lane. */
  historyRead(input: { connectedFolder: string } & HistoryFileReadOptions): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    review: HistoryFileRead;
  }>;
  historyDiff(input: { connectedFolder: string; path: string; fromCheckpointId: string; toCheckpointId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    comparison: HistoryFileComparison;
  }>;
  historyRestoreFile(input: { connectedFolder: string; path: string; version: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    restored: true;
    path: string;
    hashSha256: string;
    previousHashSha256: string | null;
    safetyCheckpointId: string;
  }>;

  /**
   * In–Connected Folder file verbs (docs/act-ledger.md): the same local-entry
   * mutations as the desktop routes — same path policy (`.amplefile/`,
   * `.pi/`, and `.workspace/` are never valid endpoints), same safety restore
   * points. `filesDelete` never refuses for lack of coverage
   * (docs/receipts-not-gates.md, F20): when the restore point could not keep
   * a copy of every matched file (oversized, unreadable, a symbolic link, or
   * History-excluded), the selected entry is moved into Recently deleted
   * instead of erased and `recovery` names the Recently deleted entry. Creation verbs
   * record the same pre-create restore point as the desktop routes, but their
   * receipts carry the created path as the undo reference — the canonical
   * inverse of creating is `files delete`, and creation destroys nothing.
   */
  filesMove(input: { connectedFolder: string; fromPath: string; toDir: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    fromPath: string;
    path: string;
    kind: "file" | "folder";
    safetyCheckpointId: string;
  }>;
  filesRename(input: { connectedFolder: string; path: string; newName: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    fromPath: string;
    path: string;
    priorName: string;
    kind: "file" | "folder";
    safetyCheckpointId: string;
  }>;
  filesDelete(input: { connectedFolder: string; path: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    deleted: true;
    path: string;
    kind: "file" | "folder";
    safetyCheckpointId: string;
    /**
     * Where this delete can be undone from: History's restore point, or the
     * Recently deleted entry the whole selected entry moved into because the
     * restore point could not keep a copy of every matched file.
     */
    recovery:
      | { kind: "history" }
      | {
        kind: "recently-deleted";
        entryId: string;
        restoreBy: string;
        uncovered: Array<{ path: string; reason: "too_large" | "unreadable" | "symbolic_link" | "excluded" }>;
      };
  }>;
  filesMkdir(input: { connectedFolder: string; path: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    created: true;
    path: string;
    kind: "folder";
    safetyCheckpointId: string;
  }>;
  filesCreate(input: { connectedFolder: string; path: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    created: true;
    path: string;
    kind: "file";
    safetyCheckpointId: string;
  }>;

  /**
   * Content search over one Connected Folder's files and Chats — the same service as
   * `/api/connected-folders/:id/search`. It honours the person's ignore rules, skips
   * binary files, and reports when a bound stopped the search
   * rather than implying completeness. The act receipt records the scope
   * only, never the query text.
   */
  search(input: { connectedFolder: string; query: string; scope?: "files" | "chats" | "all"; path?: string; cursor?: string; limit?: number }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    scope: "files" | "chats" | "all";
    query: string;
    files: ConnectedFolderFileMatch[];
    chats: ConnectedFolderChatMatch[];
    truncated: boolean;
    scannedFiles: number;
    nextCursor?: string | null; coverage?: ConnectedFolderSearchCoverage;
  }>;

  createConnectedFolder(input: { name: string; parentTaskId?: string }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef }>;
  registerConnectedFolder(input: { connectedFolderRoot: string; parentTaskId?: string }): Promise<{ connectedFolder: AmpleFileActConnectedFolderRef }>;
  addFiles(input: { connectedFolder: string; fromPaths: string[]; toDir?: string; cwd: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    copied: string[];
    checkpointId: string | null;
  }>;

  /**
   * Connected Folder lifecycle verbs (docs/act-ledger.md). Renaming refuses a name
   * another registered Connected Folder already uses under the CLI selector's
   * case-insensitive match — a duplicate exact name would make `--connected-folder`
   * selection ambiguous. Unregistering removes the registration and revokes
   * AmpleFile's project-runtime authorization while the folder and its
   * portable `.amplefile/` identity remain — for both storage kinds: a
   * managed Connected Folder's registration removal records a preserve-disposition
   * intent that provably holds no deletion authority. It runs the same App
   * Studio impact checks and automation revocation cascades as the desktop
   * removal path. Deleting a managed folder is
   * `connectedFoldersDelete`, a direct receipted verb on the prepared-act path.
   */
  connectedFoldersRename(input: { connectedFolder: string; name: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    priorName: string;
  }>;
  connectedFoldersUnregister(input: { connectedFolder: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    storage: AmpleFileActConnectedFolderStorage;
    removed: true;
    cleanupPending: boolean;
    /** One recoverable copy per preview app in the Connected Folder that held local data. */
    appRecentlyDeletedEntries: Array<{ entryId: string; restoreBy: string }>;
    /** The Connected Folder's App Studio history, kept in Recently deleted; null when it had none. */
    appStudioRecentlyDeleted: { entryId: string; restoreBy: string } | null;
  }>;

  /**
   * Connected Folder appearance verbs. Apply accepts only the typed `connected-folder-appearance`
   * proposal file (the same validation as Customize Connected Folder; nothing else is
   * accepted), and every mutation records the displaced customization so undo
   * is one act. Refs are short content digests — identifiers for receipts,
   * never the customization payload. Undo is refused with a typed error when
   * no receipted appearance act recorded a prior customization for the Connected Folder
   * in this app run, or when the current appearance was last changed outside
   * the act lane (for example on the desktop), because the recorded prior
   * state then no longer describes what would be displaced.
   */
  connectedFoldersAppearanceApply(input: {
    connectedFolder: string;
    /** A typed proposal that replaces the whole appearance… */
    proposalPath?: string;
    /** …or just these parts, keeping the rest. The image path resolves against `cwd`. */
    parts?: { bannerImagePath?: string; icon?: string; color?: string };
    cwd: string;
    parentTaskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    applied: true;
    proposalName: string;
    appearanceRef: string | null;
    priorAppearanceRef: string | null;
  }>;
  connectedFoldersAppearanceReset(input: { connectedFolder: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    reset: true;
    changed: boolean;
    priorAppearanceRef: string | null;
  }>;
  connectedFoldersAppearanceUndo(input: { connectedFolder: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    restored: true;
    restoredAppearanceRef: string | null;
    displacedAppearanceRef: string | null;
  }>;

  /**
   * Skills & Extensions removal. Installs, updates, and skill imports make
   * bytes runnable and run through the prepared-act path (`toolsInstall`,
   * `toolsUpdate`, `toolsImportSkill`). Everywhere scope mutates the same
   * personal Pi settings every Connected Folder runtime loads (resolved through the
   * app-owned AmpleFile agent root, exactly like the AmpleFile agent's own
   * runtime) and is fenced against all running work; Connected Folder scope
   * requires the explicit Connected Folder and its project trust. Both reuse the desktop's capability-mutation
   * fencing unchanged. A source that is not installed reports `removed:
   * false` honestly.
   */
  toolsRemove(input: { scope: "everywhere" | "connected-folder"; connectedFolder?: string; source: string; parentTaskId?: string }): Promise<{
    scope: "everywhere" | "connected-folder";
    connectedFolder?: AmpleFileActConnectedFolderRef;
    source: string;
    removed: boolean;
  }>;

  /**
   * connected-folder-app authority direct verbs (docs/act-ledger.md): the
   * narrowing and neutral side of restricted-app authority, reusing the
   * exact desktop route internals with their capability fencing. Widening —
   * installs, grants, connections, automation enablement — runs through the
   * prepared-act methods below. Verbs that name an app
   * without a digest resolve the installed revision host-side and pin it for
   * the mutation, so a revision change between lookup and act fails instead
   * of acting on different bytes.
   */
  /**
   * Act read: what is installed in one Connected Folder and what each app can do —
   * tools with their schemas, named Worker actions, grants, connection
   * state, and automations (docs/receipts-not-gates.md, Connected Folder apps). Reads
   * carry no lineage and write no action record.
   */
  appsList(input: { connectedFolder: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    apps: AmpleFileActAppListing[];
    truncated: boolean;
  }>;
  /**
   * Runs one declared tool through the app's own runtime, with the installed
   * revision pinned at lookup so a code change between lookup and call fails
   * instead of running different bytes. The tool's own effects are the app's,
   * bounded by the powers it holds; the receipt names the app and the tool.
   */
  appsInvoke(input: { connectedFolder: string; app: string; tool: string; input: unknown; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    featureInstallationId: string;
    digest: string;
    tool: string;
    action: string;
    result: unknown;
  }>;
  appsProposalsList(input: { connectedFolder: string; conversationId: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    conversationId: string;
    proposals: AmpleFileActAppProposalRef[];
  }>;
  /** Dismissal is not denial-of-review: nothing runnable existed, and the Worker may propose again. */
  appsProposalsDismiss(input: { connectedFolder: string; conversationId: string; proposal: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    proposalId: string;
    dismissed: boolean;
  }>;
  /** Removes a reviewed development app; release-backed Instances take `appsUninstall`. Reinstalling is a fresh receipted act. */
  appsRemove(input: { connectedFolder: string; app: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    digest: string;
    removed: boolean;
    /** A removed preview takes its data with it, so a copy lands in Recently deleted first. */
    recentlyDeleted: AmpleFileActRecentlyDeletedRef | null;
  }>;
  /**
   * Revokes one granted declaration on the exact reviewed digest. Revocation
   * stops stale launches before the authority change reads as complete
   * (service-side), and `revoked: false` honestly reports a declaration that
   * was not granted. Re-granting is a fresh receipted act.
   */
  appsRevoke(input: {
    connectedFolder: string;
    app: string;
    digest: string;
    kind: "network" | "files" | "notifications";
    declaration: string;
    parentTaskId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    grantKind: "network" | "files" | "notifications";
    declaration: string;
    revoked: boolean;
  }>;
  /**
   * Removes one saved connection's local record. Deleting the local record
   * does not revoke the credential at its provider — the receipt says so.
   */
  appsDisconnect(input: { connectedFolder: string; app: string; destination: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    destination: string;
    disconnected: boolean;
  }>;
  appsAutomationDisable(input: { connectedFolder: string; app: string; automation: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    appAutomationId: string;
    disabled: true;
    wasEnabled: boolean;
  }>;
  /**
   * Run-now for an enabled named automation, under the machine-wide
   * scheduler's admission rules (32 slots by default, same-job non-overlap). The run's
   * durable, authority-captured receipt is the result; a run the scheduler
   * skipped reports its skipped outcome honestly.
   */
  appsAutomationRun(input: { connectedFolder: string; app: string; automation: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    appAutomationId: string;
    run: AmpleFileActAppAutomationRunRef;
  }>;

  /**
   * App Studio's authority-neutral spine (docs/act-ledger.md): these
   * verbs change which local records exist, never what may run with which
   * powers — powers arrive through the receipted grant verbs. Every method
   * reuses the exact desktop route internals, including the App Studio
   * guards: referenced Releases cannot be deleted, prepared operations
   * recheck at activation, digest identity beats display versions, and
   * install activation turns on every declared power (docs/receipts-not-gates.md, F21).
   */
  appsProjectDeclare(input: { connectedFolder: string; presentationPath: string; cwd: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    project: { projectId: string; presentation: AmpleFileActAppPresentation };
    priorPresentation: AmpleFileActAppPresentation | null;
    priorPresentationRef: string | null;
  }>;
  appsReleasePrepare(input: { connectedFolder: string; version: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    release: AmpleFileActAppReleaseRef;
  }>;
  appsReleasePublish(input: { connectedFolder: string; release: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    release: AmpleFileActAppReleaseRef;
  }>;
  /**
   * Deletes one unused Release. Its record and verified envelope go to
   * Recently deleted first (docs/receipts-not-gates.md, F20), so
   * `recently-deleted restore` puts it back in the state it was deleted in.
   */
  appsReleaseDelete(input: { connectedFolder: string; release: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    releaseDigest: string;
    deleted: boolean;
    cleanupPending: boolean;
    /** The Recently deleted item holding the Release; null when nothing was deleted. */
    recentlyDeleted: AmpleFileActRecentlyDeletedRef | null;
  }>;
  appsInstallPrepare(input: { connectedFolder: string; release: string; targetConnectedFolder: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    targetConnectedFolder: AmpleFileActConnectedFolderRef;
    operation: AmpleFileActAppOperationRef;
  }>;
  appsUpdatePrepare(input: { connectedFolder: string; instance: string; release: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    targetConnectedFolder: AmpleFileActConnectedFolderRef;
    operation: AmpleFileActAppOperationRef;
  }>;
  appsOperationActivate(input: { connectedFolder: string; operation: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    operationId: string;
    operationKind: "install" | "update";
    instance: AmpleFileActAppInstanceRef;
  }>;
  appsOperationCancel(input: { connectedFolder: string; operation: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    operationId: string;
    cancelled: boolean;
  }>;
  /**
   * Uninstall with the retain-data disposition only; `--purge-data` is
   * `appsUninstallPurge`, which runs through the prepared-act path. Retained
   * namespaces do not remain runnable, and reinstalling creates a new
   * Instance.
   */
  appsUninstall(input: { connectedFolder: string; instance: string; parentTaskId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    runtimeInstanceId: string;
    removed: boolean;
    retainedNamespaceIds: string[];
    cleanupPending: boolean;
  }>;

  /**
   * The verbs that install code, widen a power, or destroy data
   * (docs/act-ledger.md; docs/receipts-not-gates.md, F19). Each method
   * composes the act's typed parameters and pins from live state — never
   * from model prose — and runs it at once through the prepared-act path:
   * pin recheck inside the capability fence, one internal kernel task, the
   * same domain internals the desktop uses. The result is the effect the
   * verb produced; the receipt is in the act journal under `requestId`, the
   * act request's journal id. Nothing waits on a person.
   */
  /**
   * Moves a managed Connected Folder's folder into Recently deleted and unregisters it,
   * after the same impact checks as unregister. `recentlyDeleted` names the entry that
   * puts the folder — and the Connected Folder's Chats and History — back.
   */
  connectedFoldersDelete(input: { connectedFolder: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    storage: "managed";
    removed: true;
    cleanupPending: boolean;
    recentlyDeleted: { entryId: string; restoreBy: string } | null;
    /** One recoverable copy per preview app in the Connected Folder that held local data. */
    appRecentlyDeletedEntries: Array<{ entryId: string; restoreBy: string }>;
    /** The Connected Folder's App Studio history, kept in Recently deleted; null when it had none. */
    appStudioRecentlyDeleted: { entryId: string; restoreBy: string } | null;
  }>;
  /** Imports one skill bundle, pinning the exact inspected bytes. */
  toolsImportSkill(input: {
    scope: "everywhere" | "connected-folder";
    connectedFolder?: string;
    from: string;
    cwd: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    scope: "everywhere" | "connected-folder";
    connectedFolder?: AmpleFileActConnectedFolderRef;
    source: string;
    contentDigest: string;
    skillNames: string[];
    bundlePath: string;
  }>;
  /**
   * Installs one Pi package or Extension (or an official catalog skill
   * bundle, which runs as a skills import). Pins the package id, the exact
   * inspected version, and the inspected resource summary; a source whose
   * exact version cannot be pinned is refused honestly.
   */
  toolsInstall(input: {
    scope: "everywhere" | "connected-folder";
    connectedFolder?: string;
    catalogId?: string;
    source?: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    scope: "everywhere" | "connected-folder";
    connectedFolder?: AmpleFileActConnectedFolderRef;
    source: string;
    packageId?: string;
    version?: string;
    resourceSummary?: string;
    installed?: true;
    contentDigest?: string;
    skillNames?: string[];
    bundlePath?: string;
  }>;
  toolsSetEnabled(input: {
    scope: "everywhere" | "connected-folder"; connectedFolder?: string; path: string;
    kind: "extensions" | "skills" | "prompts" | "themes"; enabled: boolean;
    parentTaskId?: string; requestId?: string;
  }): Promise<{ scope: "everywhere" | "connected-folder"; connectedFolder?: AmpleFileActConnectedFolderRef; path: string; enabled: boolean }>;
  /** Updates a Pi package to the exact inspected next version. */
  toolsUpdate(input: {
    scope: "everywhere" | "connected-folder";
    connectedFolder?: string;
    source: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    scope: "everywhere" | "connected-folder";
    connectedFolder?: AmpleFileActConnectedFolderRef;
    source: string;
    packageId: string;
    version: string;
    resourceSummary: string;
    updated: true;
  }>;
  /** Installs one pending Chat app review at its reviewed digest. */
  appsInstallProposal(input: {
    connectedFolder: string;
    conversationId: string;
    proposal: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<AmpleFileActAppInstallOutcome & {
    connectedFolder: AmpleFileActConnectedFolderRef;
    proposalId: string;
    digest: string;
    app: AmpleFileActInstalledAppRef;
  }>;
  /**
   * The ledger's "Add / update local preview" row: the host inspects the
   * named Connected Folder–relative package folder, records the same host-owned review
   * the Chat proposal path produces — AmpleFile owning every review field
   * and the digest — and installs it through the same digest-checked path.
   */
  appsInstallPreview(input: {
    connectedFolder: string;
    packagePath: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<AmpleFileActAppInstallOutcome & {
    connectedFolder: AmpleFileActConnectedFolderRef;
    proposalId: string;
    digest: string;
    title: string;
    packageName: string;
    version: string;
    /**
     * True when a Local preview of the same app id at a different revision was
     * already in the Connected Folder: the install replaced it, carrying forward
     * grants and automation states by declaration id, run receipts, and
     * connections whose destination declaration is byte-identical
     * (`carryForwardInstallation`). Re-adding the installed revision is false.
     */
    replacesInstalled: boolean;
    app: AmpleFileActInstalledAppRef;
  }>;
  /**
   * Grants one exact reviewed declaration on the exact installed digest. A
   * folder permission covers the whole Connected Folder; a permission that names a
   * single file binds to the Connected Folder–relative file given as `path`, which must
   * already exist inside the Connected Folder and outside its reserved metadata.
   */
  appsGrant(input: {
    connectedFolder: string;
    app: string;
    digest: string;
    kind: "network" | "files" | "notifications";
    declaration: string;
    path?: string;
    parentTaskId?: string;
    requestId?: string;
  }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    grantKind: "network" | "files" | "notifications";
    declaration: string;
    granted: true;
    root?: string;
  }>;
  /** Connects through the browser sign-in flow; a destination that takes a typed secret is refused and connected from Settings → Apps. */
  appsConnect(input: { connectedFolder: string; app: string; destination: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    destination: string;
    target: string;
    adapterKind: string;
    connection: { destinationId: string; kind: string | null; configured: boolean };
  }>;
  /** Enables one reviewed named job, pinning its digest and schedule summary. */
  appsAutomationEnable(input: { connectedFolder: string; app: string; automation: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    appAutomationId: string;
    scheduleSummary: string;
    enabled: true;
  }>;
  /**
   * Clears one installed app's live storage; the observed byte count is
   * pinned and a change before the effect is a conflict. A complete copy of
   * the data lands in Recently deleted first, unless the app held nothing
   * (docs/receipts-not-gates.md, F20).
   */
  appsStorageClear(input: { connectedFolder: string; app: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    appId: string;
    clearedBytes: number;
    remainingBytes: number;
    recentlyDeleted: AmpleFileActRecentlyDeletedRef | null;
  }>;
  /** Purges one retained App data record, after a copy of it lands in Recently deleted. */
  appsRetainedPurge(input: { connectedFolder: string; retained: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    retainedDataId: string;
    dataNamespaceIds: string[];
    purged: true;
    cleanupPending: boolean;
    recentlyDeleted: AmpleFileActRecentlyDeletedRef[];
  }>;
  /** The purge disposition of `apps uninstall --purge-data`; every affected namespace is copied into Recently deleted first. */
  appsUninstallPurge(input: { connectedFolder: string; instance: string; parentTaskId?: string; requestId?: string }): Promise<{
    connectedFolder: AmpleFileActConnectedFolderRef;
    runtimeInstanceId: string;
    purgedNamespaceIds: string[];
    removed: true;
    cleanupPending: boolean;
    recentlyDeleted: AmpleFileActRecentlyDeletedRef[];
  }>;
  /**
   * Recently deleted (docs/receipts-not-gates.md, F20). It sits above
   * Connected Folders, like automations, so neither verb takes
   * `--connected-folder`; each entry names the Connected Folder it came from. Listing is content-free: ids, kinds,
   * paths, sizes, and dates, never file contents. Nothing empties the store —
   * only its retention window does, and that lives in Settings.
   */
  recentlyDeletedList(): Promise<{
    entries: AmpleFileActRecentlyDeletedEntry[];
    retentionDays: number;
    damagedCount: number;
  }>;
  /**
   * Puts one item back. A file or folder returns to its Connected Folder at its original
   * path, renamed when something else took the name; a deleted Connected Folder's
   * folder returns and is re-registered with its portable identity; a removed
   * Skill returns to the same scope and path and loads with the next turn,
   * unless a Skill of the same name is installed there now; app data goes back into
   * the same installation at the same revision; a Release goes back into the
   * App Project it came from; a removed Connected Folder's App Studio history goes
   * back once that Connected Folder is registered again, bringing its previews'
   * data along. App data whose app is gone can only be saved as a file, which
   * is what `--to` does.
   */
  recentlyDeletedRestore(input: { entry: string; toPath?: string; parentTaskId?: string; requestId?: string }): Promise<{
    entry: AmpleFileActRecentlyDeletedEntry | null;
    restored:
      /** `safetyCheckpointId` is null when the restore succeeded but History could not record an undo point for it. */
      | { kind: "file" | "folder"; connectedFolder: AmpleFileActConnectedFolderRef; path: string; renamed: boolean; safetyCheckpointId: string | null }
      | { kind: "connected-folder"; connectedFolder: AmpleFileActConnectedFolderRef; connectedFolderRoot: string; renamed: boolean }
      /** `workFolder` only for the work-folder scope; `path` is the restored Skill folder. */
      | { kind: "skill"; scope: "everywhere" | "connected-folder"; connectedFolder?: AmpleFileActConnectedFolderRef; name: string; path: string }
      | { kind: "app-storage"; connectedFolder: AmpleFileActConnectedFolderRef; appId: string; usage: { revision: number; usageBytes: number } }
      | { kind: "app-release"; connectedFolder: AmpleFileActConnectedFolderRef; releaseDigest: string; displayVersion: string }
      | {
        kind: "app-studio";
        connectedFolder: AmpleFileActConnectedFolderRef;
        projectTitle: string | null;
        previewCount: number;
        releaseCount: number;
        operationCount: number;
        /** Prepared operations whose Release, target, or App Instance changed since the removal. */
        droppedOperationCount: number;
        /** The Recently deleted items holding the previews' data that went back with them. */
        appDataEntryIds: string[];
      }
      | { kind: "saved-copy"; path: string };
  }>;
  /**
   * Enables one declared automation from its inert typed proposal file, or a
   * full declaration (docs/automations.md): direct, receipted, and
   * digest-pinned. Every referenced Connected Folder must be registered, a one-time
   * trigger must be in the future (at most ten years ahead), and enabling an identical
   * already-enabled declaration is a no-op that leaves any active run alone.
   * Automations are above Connected Folders: no `--connected-folder` exists on this verb.
   */
  automationsEnable(input: { proposalPath: string; cwd: string; parentTaskId?: string; requestId?: string }): Promise<{
    automationId: string;
    declarationDigest: string;
    title: string;
    referencedConnectedFolderIds: string[];
    health: "enabled";
    enabledAt: string;
    alreadyEnabled: boolean;
    stoppedRunId: string | null;
  }>;

  /**
   * Automation management verbs (docs/automations.md). Automations are above
   * Connected Folders: none of these takes a Connected Folder, like the agent group. Listing,
   * showing, and receipts are content-bearing act reads (titles, Connected Folder names,
   * the chat message a person reviewed); run-now is a direct verb on an
   * enabled automation only; stop and disable are narrowing and never need a
   * click; delete removes a disabled, suspended, or completed declaration while the
   * receipts journal is retained — audit records survive the object.
   * Enabling is `automationsEnable`, a direct receipted verb.
   */
  automationsList(): Promise<{ automations: AmpleFileActAutomationSummary[] }>;
  /**
   * The models a chat or agent step may name in its `model` field: only
   * models whose provider is connected, each with whether it accepts images,
   * so an automation that looks at pictures can pick one that sees them.
   */
  automationsModels(): Promise<{ models: AmpleFileActAutomationModel[] }>;
  automationsShow(input: { automation: string }): Promise<{ automation: AmpleFileActAutomationDetail }>;
  /**
   * Manual run-now for an enabled automation: receipted, never a schedule
   * mutation, refused for proposed/disabled/suspended health. The result is
   * the settled scheduler run — the executor's own journal keeps the per-hop
   * evidence, inspectable through `automationsReceipts`.
   */
  automationsRun(input: { automation: string; parentTaskId?: string; requestId?: string }): Promise<{
    automationId: string;
    title: string;
    run: AmpleFileActAppAutomationRunRef;
  }>;
  /** Stops this automation's active run; an automation with no active run refuses with its settled truth. */
  automationsStop(input: { automation: string; parentTaskId?: string }): Promise<{
    automationId: string;
    stopped: true;
    runId: string;
  }>;
  /**
   * Disable narrows standing behavior on the layered-authority order: the
   * disabled intent persists first, pending admissions are cancelled, and the
   * active run (if any) is stopped — the result names what it stopped.
   * Re-enabling is a fresh receipted act.
   */
  automationsDisable(input: { automation: string; parentTaskId?: string }): Promise<{
    automationId: string;
    disabled: true;
    digest: string;
    stoppedRunId: string | null;
  }>;
  /** Deletes a disabled, suspended, or completed automation; an enabled one must be disabled first so revocation stops stale work. */
  automationsDelete(input: { automation: string; parentTaskId?: string }): Promise<{
    automationId: string;
    deleted: true;
    digest: string;
    finalHealth: "disabled" | "suspended" | "completed";
  }>;
  /** Bounded read of the automation receipts journal, optionally scoped to one automation id. */
  automationsReceipts(input: { automation?: string }): Promise<{
    receipts: AmpleFileActAutomationReceipt[];
    truncated: boolean;
    damagedLineCount: number;
  }>;

  /**
   * The AmpleFile agent: the conversation above all Connected Folders. It reuses
   * the same turn orchestration and Pi runtime as Worker Chats, but its
   * transcript is machine-local application state, it carries no user
   * Connected Folder's project configuration (only AmpleFile's two app-owned
   * AmpleFile agent resources), and its cross–Connected Folder hands are these same
   * act commands. Omitting conversationId targets the default (most recent
   * active) AmpleFile agent chat, creating it on first send.
   */
  agentList(): Promise<{ conversations: AmpleFileActConversationRef[] }>;
  agentAsk(input: Omit<Parameters<AmpleFileActFacade["chatAsk"]>[0], "connectedFolder" | "respondent">): Promise<Omit<Awaited<ReturnType<AmpleFileActFacade["chatAsk"]>>, "connectedFolder">>;
  agentAnswer(input: Omit<Parameters<AmpleFileActFacade["chatAnswer"]>[0], "connectedFolder">): Promise<Omit<Awaited<ReturnType<AmpleFileActFacade["chatAnswer"]>>, "connectedFolder">>;
  agentSend(input: {
    conversationId?: string;
    newConversation?: boolean;
    content: string;
    /** Act-envelope request id reused as the durable turn identity. */
    requestId?: string;
    /** Raw --attach values: absolute or cwd-relative paths, or http(s) links. */
    attachments?: string[];
    cwd?: string;
  }): Promise<{
    conversationId: string;
    messageId: string;
    taskId: string;
    attachments: AmpleFileAgentAttachmentRef[];
  }>;
  agentConversationStatus(input: { conversationId?: string }): Promise<{
    conversation: AmpleFileActConversationRef;
    state: AmpleFileActChatState;
  }>;
  agentTurnStatus(input: { taskId: string }): Promise<{
    task: AmpleFileActTurnStatus;
    /** The shipped attachment-and-actions projection (`agent status` keeps it, F25). */
    request: AmpleFileActAgentRequest | null;
    /** F28: set while this task's request waits on an answer to a question this task asked. */
    waiting: AmpleFileActWaitingRef | null;
    /**
     * The F25 graph ref, named apart from `request` so the shipped field keeps
     * its shape for the popover and the human renderer.
     */
    requestGraph: AmpleFileActRequestRef | null;
  }>;
  /** Request-level stop: aborts the AmpleFile agent turn and every recorded child turn still running. */
  agentStop(input: { taskId: string }): Promise<{
    taskId: string;
    ampleFileAgentAborted: boolean;
    children: Array<{ taskId: string; conversationId: string; connectedFolderId: string; aborted: boolean }>;
  }>;
  agentConversationResult(input: { conversationId?: string; messages?: number }): Promise<{
    conversationId: string;
    state: AmpleFileActChatState;
    total: number;
    lastAssistant: string | null;
    messages: AmpleFileActChatMessage[];
  }>;
  agentTurnResult(input: { taskId: string }): Promise<{
    conversationId: string;
    task: { taskId: string; state: "succeeded"; endedAt: string };
    message: AmpleFileActChatMessage;
    request: AmpleFileActRequestRef | null;
    result: AmpleFileResultEnvelope | null;
  }>;
  agentAbort(input: { conversationId?: string }): Promise<{ conversationId: string; aborted: boolean }>;
  /**
   * The overview (docs/amplefile-agent-overview.md): the kernel's
   * deterministic digest of recorded state above all Connected Folders — running
   * work, needs-you items, and changes, with the
   * per-surface seen markers included as data. Read-only: the act lane renders
   * markers, it never advances one, and this method deliberately does not
   * require the AmpleFile agent to be ready — the digest reads recorded
   * state, not the model.
   */
  agentOverview(): Promise<AmpleFileOverviewSnapshot>;
}
