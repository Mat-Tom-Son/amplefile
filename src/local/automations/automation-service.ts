import type { AmpleFileResultEnvelope } from "../requests/request-records.js";
import {
  AmpleFileAutomationFileWatch,
  type AmpleFileAutomationCatchUpReason,
  type AmpleFileAutomationFileObserver,
  type AmpleFileAutomationFileSnapshot,
  type AmpleFileAutomationFileWatchStatus,
} from "./automation-file-observer.js";
import { AmpleFileAutomationFileSnapshots, ampleFileAutomationFileWatchKey } from "./automation-file-snapshots.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { automationCatchUpGap } from "../../shared/automation-presentation.js";

import { ampleFileAutomationMaxConcurrentRuns } from "../../shared/amplefile-limits.js";
import {
  AmpleFileSchedulerService,
  type AmpleFileSchedulerClock,
  type AmpleFileSchedulerJobKey,
  type AmpleFileSchedulerRunAdmission,
  type AmpleFileSchedulerRunContext,
  type AmpleFileSchedulerRunResult,
} from "../agent/amplefile-scheduler-service.js";
import {
  ampleFileAutomationBounds,
  normalizeAmpleFileAutomationDeclaration,
  scrubAmpleFileAutomationMessageText,
  ampleFileAutomationDigest,
  ampleFileAutomationMessagePlaceholders,
  ampleFileAutomationTriggerCatchesUp,
  type AmpleFileAutomationChatStep,
  type AmpleFileAutomationCheckStep,
  type AmpleFileAutomationDeclaration,
  type AmpleFileAutomationFilesChangedTrigger,
  type AmpleFileAutomationFilesStep,
  type AmpleFileAutomationAgentStep,
  type AmpleFileAutomationPlaceholder,
  type AmpleFileAutomationSettleSource,
  type AmpleFileAutomationStep,
  type AmpleFileAutomationStepCreatedFilesSource,
  type AmpleFileAutomationTrigger,
} from "./automation-declarations.js";
import {
  type AmpleFileAutomationEnableInput,
  type AmpleFileAutomationActionReceiptContext,
  type AmpleFileAutomationHealth,
  type AmpleFileAutomationReceipts,
  type AmpleFileAutomationReceiptPlaceholder,
  type AmpleFileAutomationReceiptV1,
  type AmpleFileAutomationRecord,
  type AmpleFileAutomationRunCause,
  type AmpleFileAutomationStore,
  ampleFileAutomationAtOccurrenceId,
} from "./automation-store.js";
import type {
  AmpleFileAutomationHopLineage,
  AmpleFileSettleRecord,
  AmpleFileSettleSignal,
} from "./settle-signal.js";

/**
 * The automation executor (docs/automations.md): deterministic app code that
 * evaluates triggers over settle signals and the bounded schedule, admits
 * runs through its own FIFO scheduler instance, executes at most sixteen
 * declared hops by default strictly in order, and writes journal-first
 * receipts for every run and hop. There is no model call anywhere in this
 * module: agentic work happens only inside a chat hop or an agent hop, run
 * by that Connected Folder's own Worker or by the AmpleFile agent through the
 * injected ports. The executor appends no ambient context to anything it
 * dispatches — the only text it adds is the closed placeholder set, filled in
 * host-side from the run's own cause and its earlier hops' host records.
 *
 * The service owns its own `AmpleFileSchedulerService` instance — the same
 * proven class the restricted-app scheduler uses, deliberately a separate
 * budget so one Connected Folder app's jobs can never starve cross–Connected Folder
 * glue (and vice versa), and a separate suspend/resume/close lifecycle so the
 * two authority domains stay uncoupled.
 */
export const ampleFileAutomationSchedulerOwnerId = "amplefile.automation";

/**
 * Machine-wide concurrent automation runs by default; FIFO beyond it. A generous
 * default, not a cap. The number lives in the shared limits contract so
 * Settings → Automations → Limits shows exactly what this executor enforces.
 */
export { ampleFileAutomationMaxConcurrentRuns };

export interface AmpleFileAutomationHopContext {
  automationId: string;
  /** The automation's title, so the Chat or AmpleFile agent turn it starts knows who sent it. */
  title: string;
  runId: string;
  hopId: string;
  /** Stamped onto every domain run a hop causes, so its settles never fire triggers. */
  lineage: AmpleFileAutomationHopLineage;
  signal: AbortSignal;
}

export interface AmpleFileAutomationChatHopResult {
  conversationId: string;
  turnTaskId: string;
  outcome: "succeeded" | "failed" | "aborted";
  /** Selected request result, never turn file-change evidence. Null while waiting. */
  result?: AmpleFileResultEnvelope | null;
  /**
   * The same result, present only when the turn filed it itself with
   * `chat report` rather than ending with just a reply. Its outcome decides
   * the step's (docs/automations.md, 2026-10-11).
   */
  reported?: AmpleFileResultEnvelope;
  error?: string;
  preCheckpointId?: string;
  postCheckpointId?: string;
}

/** An agent hop's own AmpleFile agent turn; it records no checkpoints and names no Connected Folder. */
export type AmpleFileAutomationAgentHopResult = Pick<
  AmpleFileAutomationChatHopResult,
  "conversationId" | "turnTaskId" | "outcome" | "error" | "result" | "reported"
>;

/** The active findings of a settled Check run, for `{{trigger.findings}}`. */
export interface AmpleFileAutomationCheckRunFindings {
  findings: Array<{ checkId: string; title: string; targetPath: string; severity: string }>;
}

export interface AmpleFileAutomationFilesHopResult {
  restorePointId?: string;
  /** Destination-relative placed paths, including collision renames. */
  copiedPaths: string[];
  fileCount: number;
  totalBytes: number;
}

export interface AmpleFileAutomationCheckHopResult {
  runId: string;
  taskId: string;
  state: "succeeded" | "failed" | "aborted" | "interrupted";
  checkIds: string[];
  findingCount: number;
  admittedCount: number;
  error?: string;
}

export interface AmpleFileAutomationCheckpointManifestEntry {
  path: string;
  hashSha256: string;
  sizeBytes: number;
}

/** The slice of a History checkpoint the created-files handoff diffs. */
export interface AmpleFileAutomationCheckpointManifest {
  files: AmpleFileAutomationCheckpointManifestEntry[];
  /** Paths the capture skipped (oversized, unreadable, links, excluded). */
  skippedFilePaths: string[];
}

/**
 * What the files port receives: the declared exact paths or tree selector
 * verbatim, or — for the created-files handoff — the exact path list the
 * executor resolved host-side from the chat hop's own checkpoint pair.
 */
export type AmpleFileAutomationResolvedFilesSource =
  | { kind: "paths"; paths: string[] }
  | { kind: "tree"; path: string; recursive: boolean; extensions: string[] };

/**
 * The hop ports are the seam to the same in-process route internals the act
 * facade uses (turn acceptance, `files add`, Check runs). They perform the
 * mutations and honor the abort signal through their own domain's abort
 * paths; a files port is not interruptible mid-copy — the copy either
 * completes with its restore point or fails as one unit. Ports return
 * evidence, never content: the executor journals identifiers, paths, counts,
 * and the bounded text it filled into a message itself.
 *
 * A message port receives the resolved message as an explicit argument: the
 * executor, never the port, fills placeholders, so every port sees exactly
 * what was sent.
 */
export interface AmpleFileAutomationHopPorts {
  chat(
    step: AmpleFileAutomationChatStep,
    message: string,
    context: AmpleFileAutomationHopContext,
  ): Promise<AmpleFileAutomationChatHopResult>;
  /** Starts a new AmpleFile agent chat and waits for its turn. */
  ampleFileAgent(
    step: AmpleFileAutomationAgentStep,
    message: string,
    context: AmpleFileAutomationHopContext,
  ): Promise<AmpleFileAutomationAgentHopResult>;
  /** The settled Check run's active findings; null when the run cannot be read. */
  checkRunFindings(connectedFolderId: string, taskId: string): Promise<AmpleFileAutomationCheckRunFindings | null>;
  files(
    step: AmpleFileAutomationFilesStep,
    source: AmpleFileAutomationResolvedFilesSource,
    context: AmpleFileAutomationHopContext,
  ): Promise<AmpleFileAutomationFilesHopResult>;
  check(step: AmpleFileAutomationCheckStep, context: AmpleFileAutomationHopContext): Promise<AmpleFileAutomationCheckHopResult>;
  /** Reads one checkpoint's manifest from the named Connected Folder's History; null when missing. */
  checkpointManifest(connectedFolderId: string, checkpointId: string): Promise<AmpleFileAutomationCheckpointManifest | null>;
  /**
   * Why a step's named model cannot run, in plain words, or null when it can:
   * it must exist and its provider must be connected. Checked when an
   * automation is enabled, so an unattended run never meets it first.
   */
  modelProblem?(
    model: { provider: string; id: string },
    scope: { connectedFolder: string } | { ampleFileAgent: true },
  ): Promise<string | null>;
}

/**
 * Optional seam to the kernel's experimental `automation_run` task kind (the
 * `check_run` precedent): observability only, deliberately excluded from
 * stable task projections, and a port failure never affects the run.
 */
export interface AmpleFileAutomationRunTaskPort {
  start(input: { automationId: string; runId: string }): { id: string };
  finish(taskId: string): void;
}

export type AmpleFileAutomationServiceErrorCode =
  | "SERVICE_DAMAGED"
  | "NOT_FOUND"
  | "HEALTH_INVALID"
  | "INPUT_INVALID";

export class AmpleFileAutomationServiceError extends Error {
  readonly code: AmpleFileAutomationServiceErrorCode;
  readonly health?: AmpleFileAutomationHealth;

  constructor(
    code: AmpleFileAutomationServiceErrorCode,
    message: string,
    options: { health?: AmpleFileAutomationHealth; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AmpleFileAutomationServiceError";
    this.code = code;
    if (options.health !== undefined) this.health = options.health;
  }
}

export interface AmpleFileAutomationServiceStatus {
  storeDamaged: boolean;
  storeDamageReason?: string;
  journalDamaged: boolean;
  journalDamageReason?: string;
  armedAutomationCount: number;
  activeRunCount: number;
  /** Runs found accepted-without-terminal at startup and recorded interrupted, never replayed. */
  recoveredInterruptedRunIds: string[];
}

export interface AmpleFileAutomationServiceOptions {
  store: AmpleFileAutomationStore;
  ports: AmpleFileAutomationHopPorts;
  settleSignal?: AmpleFileSettleSignal;
  tasks?: AmpleFileAutomationRunTaskPort;
  clock?: AmpleFileSchedulerClock;
  createRunId?: () => string;
  catchUpStagger?: (key: AmpleFileSchedulerJobKey) => number;
  maxConcurrency?: number;
  observeFiles?: AmpleFileAutomationFileObserver;
  /** Tests can drive observation explicitly. Production scans every two seconds. */
  filePollIntervalMs?: number;
  /**
   * Saved snapshots for folder-change triggers that declare `"ifMissed":
   * "run"`. Defaults to `folder-snapshots/` beside the automation store.
   */
  fileSnapshots?: AmpleFileAutomationFileSnapshots;
}

export interface AmpleFileAutomationProjection extends AmpleFileAutomationRecord {
  fileWatch?: AmpleFileAutomationFileWatchStatus;
  nextScheduledAt?: string;
  /** Present only while a hop-bearing run is genuinely active. */
  activeRunId?: string;
}

export interface AmpleFileAutomationRunAdmission extends AmpleFileSchedulerRunAdmission {}

interface ArmedAutomation {
  digest: string;
  title: string;
  trigger: AmpleFileAutomationTrigger;
}

interface ActiveRunState {
  automationId: string;
  runId: string;
  controller: AbortController;
  stopRequested: boolean;
  stoppedHopTaskIds: string[];
  stopReceipt?: AmpleFileAutomationActionReceiptContext;
}

type RunSummary =
  | { kind: "succeeded"; partial?: true }
  | { kind: "failed"; failedHopId: string; error: string }
  | { kind: "stopped" }
  | { kind: "interrupted"; detail: string };

/** A terminal skipped receipt was already written for a non-exceptional claim refusal. */
class PreHopClaimRefusal extends Error {}

const causeMapGuard = 256;

export class AmpleFileAutomationService {
  readonly #fileWatches = new Map<string, AmpleFileAutomationFileWatch>();
  readonly #observeFiles?: AmpleFileAutomationFileObserver;
  readonly #fileSnapshots: AmpleFileAutomationFileSnapshots;
  #filePollTimer?: ReturnType<typeof setInterval>;
  #filePollBusy = false;
  #fileEpoch = 0;
  #fileHoldChain: Promise<void> = Promise.resolve();
  readonly #fileLoads = new WeakMap<AmpleFileAutomationFileWatch, Promise<void>>();
  readonly #store: AmpleFileAutomationStore;
  readonly #receipts: AmpleFileAutomationReceipts;
  readonly #ports: AmpleFileAutomationHopPorts;
  readonly #tasks: AmpleFileAutomationRunTaskPort | null;
  readonly #automation: AmpleFileSchedulerService;
  readonly #now: () => Date;
  readonly #armed = new Map<string, ArmedAutomation>();
  readonly #causeByRunId = new Map<string, AmpleFileAutomationRunCause>();
  readonly #launchedRunIds = new Set<string>();
  readonly #activeRuns = new Map<string, ActiveRunState>();
  readonly #recoveredRunIds: string[] = [];
  #pendingCause: AmpleFileAutomationRunCause | null = null;
  #unsubscribeSettle: (() => void) | null = null;
  #journalDamageReason: string | null = null;
  #suspensionGeneration = 0;
  #suspensionDesired = false;
  #closed = false;

  private constructor(options: AmpleFileAutomationServiceOptions) {
    this.#observeFiles = options.observeFiles;
    this.#fileSnapshots = options.fileSnapshots
      ?? new AmpleFileAutomationFileSnapshots({ directory: join(dirname(options.store.path), "folder-snapshots") });
    this.#store = options.store;
    this.#receipts = options.store.receipts;
    this.#ports = options.ports;
    this.#tasks = options.tasks ?? null;
    this.#now = options.clock ? () => options.clock!.now() : () => new Date();
    const createRunId = options.createRunId ?? randomUUID;
    this.#automation = new AmpleFileSchedulerService({
      maxConcurrency: options.maxConcurrency ?? ampleFileAutomationMaxConcurrentRuns,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.catchUpStagger ? { catchUpStagger: options.catchUpStagger } : {}),
      // The scheduler mints exactly one run id per admission, synchronously
      // inside the admission call. Binding the pending trigger cause to that
      // id here — instead of to a per-automation slot — makes attribution exact
      // even when an admission waits in the FIFO queue behind a full budget.
      createRunId: () => {
        const runId = createRunId();
        const pending = this.#pendingCause;
        this.#pendingCause = null;
        if (pending) {
          if (this.#causeByRunId.size >= causeMapGuard) {
            const oldest = this.#causeByRunId.keys().next().value;
            if (oldest !== undefined) this.#causeByRunId.delete(oldest);
          }
          this.#causeByRunId.set(runId, pending);
        }
        return runId;
      },
      onResult: (result) => this.#onAutomationResult(result),
    });
  }

  static async create(options: AmpleFileAutomationServiceOptions): Promise<AmpleFileAutomationService> {
    const service = new AmpleFileAutomationService(options);
    await service.#initialize(options.settleSignal);
    if (options.observeFiles && options.filePollIntervalMs !== 0) {
      service.#filePollTimer = setInterval(() => { void service.pollFileChanges(); }, Math.max(2000, options.filePollIntervalMs ?? 2000));
      service.#filePollTimer.unref?.();
    }
    return service;
  }

  status(): AmpleFileAutomationServiceStatus {
    const store = this.#store.status();
    return {
      storeDamaged: store.damaged,
      ...(store.damageReason !== undefined ? { storeDamageReason: store.damageReason } : {}),
      journalDamaged: this.#journalDamageReason !== null,
      ...(this.#journalDamageReason !== null ? { journalDamageReason: this.#journalDamageReason } : {}),
      armedAutomationCount: this.#armed.size,
      activeRunCount: this.#activeRuns.size,
      recoveredInterruptedRunIds: [...this.#recoveredRunIds],
    };
  }

  async listAutomations(): Promise<AmpleFileAutomationProjection[]> {
    return (await this.#store.list()).map((record) => this.#project(record));
  }

  async getAutomation(automationId: string): Promise<AmpleFileAutomationProjection | undefined> {
    const record = await this.#store.get(automationId);
    return record ? this.#project(record) : undefined;
  }

  /**
   * Commits an enablement receipt and arms the automation. Enabling an
   * already-enabled identical declaration is a no-op: no fresh receipt, no
   * journal line, and the active run is left alone, so asking twice never
   * costs a person work in flight. Replacing an already-enabled automation with
   * a changed declaration is a fresh receipt that first stops any run still
   * executing under the prior digest: revocation stops stale work before the
   * authority change reads as complete.
   */
  async enable(input: AmpleFileAutomationEnableInput): Promise<AmpleFileAutomationRecord> {
    this.#assertOperational();
    const declaration = normalizeAmpleFileAutomationDeclaration(input.declaration);
    const digest = ampleFileAutomationDigest(declaration);
    const current = await this.#store.get(declaration.id);
    if (current?.health === "enabled" && current.digest === digest && input.expectedDigest === digest) {
      return current;
    }
    if (declaration.trigger.kind === "files-changed") {
      if (!this.#observeFiles) throw new Error("folder-change triggers are unavailable in this runtime.");
      await this.#observeFiles(declaration.trigger);
    }
    for (const step of declaration.steps) {
      if ((step.kind !== "chat" && step.kind !== "agent") || !step.model || !this.#ports.modelProblem) continue;
      const problem = await this.#ports.modelProblem(step.model, step.kind === "chat" ? { connectedFolder: step.connectedFolder } : { ampleFileAgent: true });
      if (problem) throw new Error(`Step "${step.id}": ${problem}`);
    }
    const record = await this.#store.enable(input);
    const automationId = record.declaration.id;
    const trigger = record.declaration.trigger;
    const previous = current?.declaration.trigger;
    // A declaration that no longer catches up stops keeping its folder
    // snapshot; a changed selector simply never matches the saved one.
    if (previous && ampleFileAutomationTriggerCatchesUp(previous) && !ampleFileAutomationTriggerCatchesUp(trigger)) {
      await this.#fileSnapshots.remove(automationId).catch(() => undefined);
    }
    // Replacing a declaration that is already on, over the same folder, keeps
    // watching without a gap: nothing was missed, so there is nothing to
    // catch up and no fresh baseline to take.
    const inherited = current?.health === "enabled"
      && previous?.kind === "files-changed"
      && trigger.kind === "files-changed"
      && ampleFileAutomationFileWatchKey(previous) === ampleFileAutomationFileWatchKey(trigger)
      ? this.#fileWatches.get(automationId)
      : undefined;
    this.stopRun(automationId);
    this.#disarm(automationId);
    this.#arm(record, "off", inherited);
    // Take the first look now, before the person can drop anything in: a
    // file that lands after Turn on is a change, never part of the baseline.
    if (trigger.kind === "files-changed" && !inherited) await this.pollFileChanges();
    return record;
  }

  /**
   * Disables an automation on the layered-authority order: the disabled intent
   * journals and persists first (startup refuses to arm it), then pending
   * admissions are cancelled and the active run, if any, is stopped through
   * the stop path — and the result reports what it stopped. Narrowing is
   * never blocked by journal damage or a closed executor.
   */
  async disable(
    automationId: string,
    receiptContext: AmpleFileAutomationActionReceiptContext = {},
  ): Promise<{ record: AmpleFileAutomationRecord; stoppedRunId: string | null }> {
    const record = await this.#store.disable(automationId, receiptContext);
    const stopped = this.stopRun(automationId, receiptContext);
    this.#disarm(automationId);
    return { record, stoppedRunId: stopped?.runId ?? null };
  }

  /** Deletes an inert automation; receipts are retained by the store. */
  async deleteAutomation(
    automationId: string,
    receiptContext: AmpleFileAutomationActionReceiptContext = {},
  ): Promise<AmpleFileAutomationRecord> {
    const current = await this.#store.get(automationId);
    const active = [...this.#activeRuns.values()].some((run) => run.automationId === automationId);
    const claimedButUnfinished = current?.health === "completed"
      && current.atOccurrence !== undefined
      && current.atOccurrence.finishedAt === undefined;
    if (active || claimedButUnfinished) {
      throw new AmpleFileAutomationServiceError(
        "HEALTH_INVALID",
        "Stop this automation's active run before deleting it.",
        { ...(current ? { health: current.health } : {}) },
      );
    }
    const record = await this.#store.delete(automationId, receiptContext);
    this.#disarm(automationId);
    if (ampleFileAutomationTriggerCatchesUp(record.declaration.trigger)) {
      await this.#fileSnapshots.remove(automationId).catch(() => undefined);
    }
    return record;
  }

  /**
   * Manual run-now for an enabled automation: receipted, never a schedule
   * mutation. A merely proposed automation is refused — the executor never runs
   * a merely proposed standing declaration, even once.
   */
  async runNow(
    automationId: string,
    options: AmpleFileAutomationActionReceiptContext = {},
  ): Promise<AmpleFileSchedulerRunResult> {
    return (await this.runNowAdmission(automationId, options)).result;
  }

  /** Validates authority and returns the scheduler admission before the run settles. */
  async runNowAdmission(
    automationId: string,
    options: AmpleFileAutomationActionReceiptContext = {},
  ): Promise<AmpleFileAutomationRunAdmission> {
    this.#assertOperational();
    const record = await this.#store.get(automationId);
    if (!record) {
      throw new AmpleFileAutomationServiceError(
        "NOT_FOUND",
        "No automation has this id. A proposal holds no authority; enabling pins the exact declaration before anything runs.",
      );
    }
    if (record.health !== "enabled") {
      throw new AmpleFileAutomationServiceError(
        "HEALTH_INVALID",
        record.health === "suspended"
          ? "This automation is suspended because a referenced Connected Folder was removed; enable it again to resume."
          : record.health === "completed"
            ? "This one-time automation is completed; its scheduled occurrence has already been consumed."
            : "This automation is off; enable it again to run it.",
        { health: record.health },
      );
    }
    const cause: AmpleFileAutomationRunCause = {
      kind: "run-now",
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      ...(options.surface !== undefined ? { surface: options.surface } : {}),
    };
    return this.#dispatchAdmission(automationId, cause);
  }

  /**
   * Stops this automation's active run by aborting the current hop through the
   * run's own controller; the hop's domain honors the signal on its own abort
   * path, later hops are recorded skipped, and the run settles `stopped`.
   * Returns null when no run is active — a settled run refuses stop with its
   * terminal state at the verb layer.
   */
  stopRun(
    automationId: string,
    receiptContext: AmpleFileAutomationActionReceiptContext = {},
  ): { runId: string } | null {
    const active = [...this.#activeRuns.values()].find((run) => run.automationId === automationId);
    if (!active) return null;
    active.stopRequested = true;
    active.stopReceipt = { ...receiptContext };
    active.controller.abort(new Error("Automation run was stopped."));
    return { runId: active.runId };
  }

  /**
   * connected-folder-removal revocation: every enabled automation referencing the removed
   * Connected Folder is suspended with the missing Connected Folder id recorded (durable, in the
   * store), its active run is stopped, and its schedule is disarmed. A
   * suspended automation never runs, never retargets, and never resumes
   * automatically; turning it on again is a fresh enablement. With a damaged
   * store this returns empty: damage already fails closed, because nothing
   * is armed and nothing can run.
   */
  async handleConnectedFolderRemoved(connectedFolderId: string): Promise<{ suspendedAutomationIds: string[]; stoppedRunIds: string[] }> {
    if (this.#store.status().damaged) return { suspendedAutomationIds: [], stoppedRunIds: [] };
    const { suspended } = await this.#store.suspendForConnectedFolderRemoval(connectedFolderId);
    const stoppedRunIds: string[] = [];
    for (const record of suspended) {
      const automationId = record.declaration.id;
      const stopped = this.stopRun(automationId);
      if (stopped) stoppedRunIds.push(stopped.runId);
      this.#disarm(automationId);
      // The saved snapshot describes a folder that is no longer registered;
      // leaving suspension starts from a fresh look.
      const trigger = record.declaration.trigger;
      if (ampleFileAutomationTriggerCatchesUp(trigger) && trigger.connectedFolder === connectedFolderId) {
        await this.#fileSnapshots.remove(automationId).catch(() => undefined);
      }
    }
    return { suspendedAutomationIds: suspended.map((record) => record.declaration.id), stoppedRunIds };
  }

  /**
   * Records that a missing Connected Folder's portable identity was re-registered. The
   * copy changes; the semantics deliberately do not: registration must never
   * silently re-arm standing behavior.
   */
  async handleConnectedFolderReRegistered(connectedFolderId: string): Promise<string[]> {
    if (this.#store.status().damaged) return [];
    const affected = await this.#store.noteConnectedFolderReRegistered(connectedFolderId);
    return affected.map((record) => record.declaration.id);
  }

  /** Diagnostic passthrough to the scheduler's bounded in-memory run history. */
  listAutomationResults(automationId?: string): AmpleFileSchedulerRunResult[] {
    return this.#automation.listRunResults(automationId ? this.#jobKey(automationId) : undefined);
  }

  /** Sleep/quit suspension: aborts active runs, which settle `interrupted`. */
  suspend(): void {
    this.#resetFileWatches(true, "asleep");
    this.#suspensionDesired = true;
    this.#suspensionGeneration += 1;
    this.#automation.suspend();
  }

  async resume(): Promise<void> {
    this.#suspensionDesired = false;
    const generation = ++this.#suspensionGeneration;
    await this.#completeMissedSkips(await this.#store.list());
    if (this.#closed || this.#suspensionDesired || generation !== this.#suspensionGeneration) return;
    this.#resetFileWatches();
    this.#automation.resume();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#filePollTimer) clearInterval(this.#filePollTimer);
    this.#resetFileWatches(true);
    this.#suspensionDesired = true;
    this.#suspensionGeneration += 1;
    this.#unsubscribeSettle?.();
    this.#unsubscribeSettle = null;
    this.#automation.close();
  }

  async #initialize(settleSignal?: AmpleFileSettleSignal): Promise<void> {
    if (!this.#store.status().damaged) {
      await this.#recoverInterruptedRuns();
      if (this.#journalDamageReason === null) {
        const records = await this.#store.list();
        await this.#finishRecoveredAtOccurrences(records);
        await this.#completeMissedSkips(await this.#store.list());
        for (const record of await this.#store.list()) {
          if (record.health !== "enabled") continue;
          this.#arm(record, "closed");
        }
      }
    }
    if (settleSignal) {
      this.#unsubscribeSettle = settleSignal.subscribe((record) => {
        this.#onSettle(record);
      });
    }
  }

  /**
   * Crash recovery on the Check runner's honesty rule: record, never replay.
   * A run with an `accepted` record and no terminal record gets a terminal
   * `interrupted` record (and so does its in-flight hop); the completed hops
   * keep their receipts, and the schedule then resumes from the durable
   * anchor. A journal that cannot be scanned or written fails the whole
   * executor closed instead of guessing.
   */
  async #recoverInterruptedRuns(): Promise<void> {
    let openRuns;
    try {
      openRuns = await this.#receipts.scanOpenRuns();
    } catch (error) {
      this.#journalDamageReason = error instanceof Error ? error.message : String(error);
      return;
    }
    for (const run of openRuns) {
      let completedAtOccurrence = false;
      if (run.cause && run.digest) {
        try {
          const record = await this.#store.get(run.automationId);
          if (record?.digest === run.digest) {
            if (record.health === "enabled" && record.declaration.trigger.kind === "interval") {
              await this.#store.recordCadence(run.automationId, run.cause.slotAt);
            } else if (record.health === "enabled" && record.declaration.trigger.kind === "at") {
              completedAtOccurrence = (await this.#store.claimAtOccurrence(
                run.automationId,
                run.cause.slotAt,
                run.runId,
                this.#now(),
              )) !== null;
            } else if (record.health === "completed" && record.atOccurrence?.runId === run.runId) {
              completedAtOccurrence = true;
            }
          }
        } catch (error) {
          this.#journalDamageReason = `AmpleFile could not reconcile the durable schedule claim for interrupted run ${run.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          return;
        }
      }
      for (const hopId of run.openHopIds) {
        await this.#receipts.append({
          scope: "hop",
          outcome: "interrupted",
          automationId: run.automationId,
          runId: run.runId,
          hopId,
          detail: "AmpleFile stopped while this hop was in flight; its effects resolve by that domain's own crash rule.",
        });
      }
      const recorded = await this.#receipts.append({
        scope: "run",
        outcome: "interrupted",
        automationId: run.automationId,
        runId: run.runId,
        ...(run.title !== undefined ? { title: run.title } : {}),
        detail: "AmpleFile stopped before this automation run recorded a terminal outcome. It was not replayed.",
      });
      if (!recorded) {
        this.#journalDamageReason =
          "The automation receipts journal is unwritable, so interrupted runs cannot be recorded honestly.";
        return;
      }
      this.#recoveredRunIds.push(run.runId);
      if (completedAtOccurrence) {
        await this.#store.finishAtOccurrence(run.automationId, run.runId, this.#now().toISOString());
      }
    }
  }

  #project(record: AmpleFileAutomationRecord): AmpleFileAutomationProjection {
    const next = this.#automation.nextScheduledAt(this.#jobKey(record.declaration.id));
    const active = [...this.#activeRuns.values()].find((run) => run.automationId === record.declaration.id);
    return {
      ...record,
      ...(this.#fileWatches.has(record.declaration.id) ? { fileWatch: this.#fileWatches.get(record.declaration.id)!.view() } : {}),
      ...(next !== undefined ? { nextScheduledAt: next } : {}),
      ...(active !== undefined ? { activeRunId: active.runId } : {}),
    };
  }

  #jobKey(automationId: string): AmpleFileSchedulerJobKey {
    return { ownerId: ampleFileAutomationSchedulerOwnerId, jobId: automationId };
  }

  /**
   * `gap` names why a catch-up comparison is due for a folder-change trigger
   * that declares `"ifMissed": "run"`: AmpleFile was closed (startup) or the
   * automation was off (enable). An inherited watch carries on without one.
   */
  #arm(
    record: AmpleFileAutomationRecord,
    gap: AmpleFileAutomationCatchUpReason = "closed",
    inherited?: AmpleFileAutomationFileWatch,
  ): void {
    const automationId = record.declaration.id;
    const trigger = record.declaration.trigger;
    if (trigger.kind === "files-changed") {
      const catchUp = ampleFileAutomationTriggerCatchesUp(trigger);
      const watch = inherited ?? new AmpleFileAutomationFileWatch(catchUp ? { catchUp: gap } : {});
      watch.catchUp = catchUp;
      if (!catchUp) watch.pendingComparison = undefined;
      this.#fileWatches.set(automationId, watch);
    }
    this.#armed.set(automationId, {
      digest: record.digest,
      title: record.declaration.title,
      trigger: structuredClone(trigger),
    });
    const scheduled = trigger.kind === "interval" || trigger.kind === "at" ? trigger : null;
    // Manual and on-settled automations register disabled: the job then never
    // fires on a cadence, while dispatch (always reason "manual" to the
    // scheduler) still flows through the same FIFO admission, per-automation
    // non-overlap, suspension, and abort machinery.
    this.#automation.register({
      key: this.#jobKey(automationId),
      schedule: scheduled?.kind === "at"
        ? { kind: "at", at: scheduled.at, ifMissed: scheduled.ifMissed }
        : {
            kind: "interval",
            intervalMinutes: scheduled?.kind === "interval"
              ? scheduled.intervalMinutes
              : ampleFileAutomationBounds.minIntervalMinutes,
            catchUp: scheduled?.kind === "interval" ? "latest" : "none",
          },
      enabled: scheduled !== null,
      ...(scheduled?.kind === "interval" && record.lastScheduledAt !== undefined
        ? { lastScheduledAt: record.lastScheduledAt }
        : {}),
      run: (context) => this.#executeRun(context),
    });
  }

  async #finishRecoveredAtOccurrences(records: AmpleFileAutomationRecord[]): Promise<void> {
    const finishedAt = this.#now().toISOString();
    for (const record of records) {
      if (record.health !== "completed" || !record.atOccurrence || record.atOccurrence.finishedAt !== undefined) continue;
      await this.#store.finishAtOccurrence(record.declaration.id, record.atOccurrence.runId, finishedAt);
    }
  }

  async #completeMissedSkips(records: AmpleFileAutomationRecord[]): Promise<void> {
    const now = this.#now();
    for (const record of records) {
      const trigger = record.declaration.trigger;
      if (
        record.health !== "enabled"
        || trigger.kind !== "at"
        || trigger.ifMissed !== "skip"
        || Date.parse(trigger.at) > now.getTime()
      ) continue;
      const runId = `missed-${record.declaration.id}-${Date.parse(trigger.at)}`;
      const claimed = await this.#store.claimAtOccurrence(record.declaration.id, trigger.at, runId, now);
      if (!claimed?.atOccurrence) continue;
      await this.#receipts.append({
        scope: "run",
        outcome: "skipped",
        automationId: record.declaration.id,
        runId,
        title: record.declaration.title,
        digest: record.digest,
        cause: { kind: "resume", slotAt: trigger.at },
        occurrenceId: claimed.atOccurrence.occurrenceId,
        detail: "The one-time occurrence passed while AmpleFile was unavailable, and this automation is declared to skip a missed slot.",
      });
      await this.#store.finishAtOccurrence(record.declaration.id, runId, now.toISOString());
      this.#disarm(record.declaration.id);
    }
  }

  #disarm(automationId: string): void {
    this.#armed.delete(automationId);
    this.#fileWatches.delete(automationId);
    this.#fileEpoch += 1;
    const key = this.#jobKey(automationId);
    if (this.#automation.has(key)) this.#automation.unregister(key);
  }

  #resetFileWatches(paused = false, gap?: AmpleFileAutomationCatchUpReason): void {
    this.#fileEpoch += 1;
    for (const watch of this.#fileWatches.values()) {
      watch.reset(paused);
      if (gap !== undefined) watch.expectGap(gap);
    }
  }

  async pollFileChanges(): Promise<void> {
    if (this.#closed || this.#suspensionDesired || this.#activeRuns.size || this.#filePollBusy || !this.#observeFiles) return;
    this.#filePollBusy = true;
    const epoch = this.#fileEpoch;
    const stale = () => epoch !== this.#fileEpoch || this.#closed || this.#suspensionDesired || this.#activeRuns.size > 0;
    try {
      for (const [automationId, watch] of this.#fileWatches) {
        const armed = this.#armed.get(automationId);
        if (armed?.trigger.kind !== "files-changed") continue;
        try {
          if (watch.catchUp && watch.pendingComparison !== undefined) {
            await this.#loadFileWatch(automationId, watch, armed.trigger);
            if (stale()) return;
          }
          const snapshot = await this.#observeFiles(armed.trigger);
          if (stale()) return;
          const observed = watch.observe(snapshot, this.#now().getTime(), armed.trigger);
          // Saving is queued before the admission, so a run this firing starts
          // marks the saved snapshot as running only after it is written.
          const saving = this.#saveFileWatch(automationId, watch, armed.trigger, watch.baseline);
          if (observed !== null) {
            const admission = this.#dispatchAdmission(automationId, {
              kind: "files-changed",
              connectedFolderId: armed.trigger.connectedFolder,
              snapshotDigest: snapshot.digest,
              changedCount: observed.changedCount,
              changedPaths: observed.changedPaths,
              ...(observed.catchUp ? { catchUp: observed.catchUp } : {}),
            });
            void admission.result.catch(() => undefined);
          }
          await saving;
        } catch (error) {
          if (epoch !== this.#fileEpoch) return;
          watch.fail(error);
        }
      }
    } finally { this.#filePollBusy = false; }
  }

  /** Reads the saved state once per watch; concurrent callers share the read. */
  async #loadFileWatch(
    automationId: string,
    watch: AmpleFileAutomationFileWatch,
    trigger: AmpleFileAutomationFilesChangedTrigger,
  ): Promise<void> {
    if (watch.saved !== undefined) return;
    let loading = this.#fileLoads.get(watch);
    if (!loading) {
      loading = this.#fileSnapshots.read(automationId, ampleFileAutomationFileWatchKey(trigger))
        .then((read) => { watch.load(read, this.#now().getTime()); })
        .finally(() => { this.#fileLoads.delete(watch); });
      this.#fileLoads.set(watch, loading);
    }
    await loading;
  }

  /**
   * Saves what an opted-in watch has accounted for whenever it differs from
   * the saved state, or clears the running marker once the post-run look
   * matches it. In-memory state follows the queue order, so the saved files
   * always end in the order these calls were made. A failed save is shown,
   * never fatal: the older saved state stays, and a running marker stays with
   * it.
   */
  #saveFileWatch(
    automationId: string,
    watch: AmpleFileAutomationFileWatch,
    trigger: AmpleFileAutomationFilesChangedTrigger,
    snapshot: AmpleFileAutomationFileSnapshot | undefined,
  ): Promise<void> {
    if (!watch.catchUp || !snapshot || this.#fileWatches.get(automationId) !== watch) return Promise.resolve();
    const desired = watch.stateToSave(snapshot, this.#now().getTime());
    const saved = watch.saved;
    const unchanged = saved !== undefined && saved !== null && sameSavedFileState(saved, desired);
    if (unchanged && !watch.dirty) return Promise.resolve();
    const operation = unchanged
      ? this.#fileSnapshots.clearRunning(automationId)
      : this.#fileSnapshots.save(automationId, ampleFileAutomationFileWatchKey(trigger), desired);
    if (!unchanged) watch.saved = desired;
    watch.dirty = false;
    return operation.catch((error: unknown) => {
      watch.status = {
        ...watch.status,
        notice: `AmpleFile could not save this folder's snapshot, so it may not catch up after AmpleFile is closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    });
  }

  /**
   * Runs as an automation run begins, after observation paused and before its
   * first step. A due catch-up comparison is made now, while the folder still
   * shows only what changed during the gap, and what it owes is saved to fire
   * after the run. Then every opted-in saved snapshot is marked running: until
   * the post-run look is saved, it may predate this run's own edits, so a
   * quit, sleep, or Turn off in between never compares against it.
   */
  async #holdFileWatchesForRun(): Promise<void> {
    const hold = this.#fileHoldChain.then(async () => {
      for (const [automationId, watch] of [...this.#fileWatches]) {
        const armed = this.#armed.get(automationId);
        if (!watch.catchUp || armed?.trigger.kind !== "files-changed") continue;
        const current = () => this.#fileWatches.get(automationId) === watch;
        if (watch.pendingComparison !== undefined && !watch.dirty && this.#observeFiles) {
          try {
            await this.#loadFileWatch(automationId, watch, armed.trigger);
            if (current() && watch.saved && !watch.dirty && watch.pendingComparison !== undefined) {
              const snapshot = await this.#observeFiles(armed.trigger);
              if (current()) {
                watch.compareBeforeRun(snapshot, this.#now().getTime());
                await this.#saveFileWatch(automationId, watch, armed.trigger, snapshot);
              }
            }
          } catch {
            // The folder could not be read: the comparison stays due and the
            // running mark below turns it into a fresh look after the run.
          }
        }
        if (!current() || watch.dirty) continue;
        watch.dirty = true;
        await this.#fileSnapshots.markRunning(automationId, this.#now().toISOString()).catch(() => undefined);
      }
    });
    this.#fileHoldChain = hold.catch(() => undefined);
    await hold;
  }

  #onSettle(record: AmpleFileSettleRecord): void {
    if (this.#closed) return;
    // Automation-caused settles never fire triggers: dropping lineage here is
    // what makes automation chains structurally impossible.
    if (record.lineage) return;
    for (const [automationId, armed] of this.#armed) {
      if (armed.trigger.kind !== "on-settled") continue;
      if (!settleMatchesSource(armed.trigger.source, record)) continue;
      void this.#dispatch(automationId, settleCause(record));
    }
  }

  #dispatch(automationId: string, cause: AmpleFileAutomationRunCause): Promise<AmpleFileSchedulerRunResult> {
    return this.#dispatchAdmission(automationId, cause).result;
  }

  #dispatchAdmission(automationId: string, cause: AmpleFileAutomationRunCause): AmpleFileSchedulerRunAdmission {
    this.#pendingCause = cause;
    try {
      return this.#automation.runNowAdmission(this.#jobKey(automationId));
    } finally {
      this.#pendingCause = null;
    }
  }

  #takeCause(context: AmpleFileSchedulerRunContext): AmpleFileAutomationRunCause {
    const registered = this.#causeByRunId.get(context.runId);
    if (registered) {
      this.#causeByRunId.delete(context.runId);
      return registered;
    }
    if (context.reason === "scheduled" || context.reason === "resume") {
      return { kind: context.reason, slotAt: context.scheduledAt };
    }
    return { kind: "run-now" };
  }

  async #executeRun(context: AmpleFileSchedulerRunContext): Promise<void> {
    const automationId = context.key.jobId;
    const runId = context.runId;
    this.#launchedRunIds.add(runId);
    const cause = this.#takeCause(context);

    // Authority is rechecked at the launch boundary, not assumed from the
    // admission: an automation disabled, suspended, or re-enabled at a different
    // digest while this admission waited in the queue must not run under
    // stale authority.
    let record: AmpleFileAutomationRecord | undefined;
    let refusal: string | null = null;
    try {
      record = await this.#store.get(automationId);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    const armed = this.#armed.get(automationId);
    if (refusal === null) {
      if (!record || !armed) refusal = "This automation's enablement was revoked before the run could start.";
      else if (record.digest !== armed.digest) {
        refusal = "This automation's declaration changed before the run could start; an edited automation never coasts on a stale enablement.";
      } else if (record.health !== "enabled") {
        refusal = `This automation is ${record.health}; the admission was skipped.`;
      }
    }
    if (refusal !== null || !record) {
      const detail = refusal ?? "This automation's enablement was revoked before the run could start.";
      await this.#receipts.append({ scope: "run", outcome: "skipped", automationId, runId, cause, detail });
      // The journal's skipped record is the authoritative receipt; throwing
      // keeps the scheduler's own run history from reading "success" for a
      // run that never held authority.
      throw new Error(detail);
    }

    // Journal-first: the accepted record lands before hop 1 executes, and an
    // unwritable journal refuses the run.
    const accepted = await this.#receipts.append({
      scope: "run",
      outcome: "accepted",
      automationId,
      runId,
      title: record.declaration.title,
      digest: record.digest,
      cause,
      ...runReceiptFields(cause, record),
    });
    if (!accepted) {
      throw new Error("AmpleFile could not journal this automation run, so it was refused before any hop executed.");
    }

    // The accepted receipt is the recoverable intent. Persist the exact
    // occurrence/cadence claim next, still before hop 1, so a process stop
    // cannot replay effects for a slot that already crossed this boundary.
    try {
      if (cause.kind === "scheduled" || cause.kind === "resume") {
        if (record.declaration.trigger.kind === "at") {
          const claimed = await this.#store.claimAtOccurrence(automationId, cause.slotAt, runId, new Date(context.startedAt));
          if (!claimed) {
            const detail = "This one-time automation occurrence was already consumed or no longer holds authority.";
            await this.#receipts.append({ scope: "run", outcome: "skipped", automationId, runId, cause, detail });
            throw new PreHopClaimRefusal(detail);
          }
          record = claimed;
        } else if (record.declaration.trigger.kind === "interval") {
          const claimed = await this.#store.recordCadence(automationId, cause.slotAt);
          if (!claimed) {
            const detail = "This interval automation lost authority before its scheduled slot could be claimed.";
            await this.#receipts.append({ scope: "run", outcome: "skipped", automationId, runId, cause, detail });
            throw new PreHopClaimRefusal(detail);
          }
        }
      }
    } catch (error) {
      if (error instanceof PreHopClaimRefusal) throw error;
      const detail = `The durable schedule claim failed before any hop executed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await this.#receipts.append({
        scope: "run",
        outcome: "failed",
        automationId,
        runId,
        title: record.declaration.title,
        digest: record.digest,
        cause,
        ...runReceiptFields(cause, record),
        detail,
      });
      throw new Error(detail, { cause: error });
    }

    const controller = new AbortController();
    const outerSignal = context.signal;
    const onOuterAbort = () => {
      controller.abort(outerSignal.reason ?? new Error("Automation scheduling aborted this run."));
    };
    let releaseOuterAbort = () => {};
    if (outerSignal.aborted) onOuterAbort();
    else {
      outerSignal.addEventListener("abort", onOuterAbort, { once: true });
      releaseOuterAbort = () => outerSignal.removeEventListener("abort", onOuterAbort);
    }

    let taskId: string | null = null;
    try {
      taskId = this.#tasks?.start({ automationId, runId }).id ?? null;
    } catch {
      taskId = null;
    }
    const active: ActiveRunState = { automationId, runId, controller, stopRequested: false, stoppedHopTaskIds: [] };
    this.#resetFileWatches(true);
    this.#activeRuns.set(runId, active);
    try {
      // Best-effort bookkeeping for folder catch-up; it never fails a run.
      await this.#holdFileWatchesForRun().catch(() => undefined);
      const summary = await this.#executeHops(record.declaration, active, cause);
      if (summary.kind === "succeeded") {
        await this.#receipts.append({
          scope: "run", outcome: "succeeded", automationId, runId, cause, ...runReceiptFields(cause, record),
          ...(summary.partial ? { partial: true as const } : {}),
        });
        return;
      }
      if (summary.kind === "failed") {
        await this.#receipts.append({
          scope: "run",
          outcome: "failed",
          automationId,
          runId,
          cause,
          failedHopId: summary.failedHopId,
          detail: summary.error,
          ...runReceiptFields(cause, record),
        });
        // There are no retries; the next trigger occurrence is the retry,
        // and the scheduler's run history records the failure too.
        throw new Error(`Automation hop "${summary.failedHopId}" failed: ${summary.error}`);
      }
      if (summary.kind === "stopped") {
        await this.#receipts.append({
          scope: "run",
          outcome: "stopped",
          automationId,
          runId,
          cause,
          ...(active.stoppedHopTaskIds.length ? { stoppedHopTaskIds: [...active.stoppedHopTaskIds] } : {}),
          ...runReceiptFields(cause, record),
          ...(active.stopReceipt ?? {}),
          detail: "The run was stopped; later hops were skipped.",
        });
        throw new Error("Automation run was stopped.");
      }
      await this.#receipts.append({
        scope: "run",
        outcome: "interrupted",
        automationId,
        runId,
        cause,
        ...runReceiptFields(cause, record),
        detail: summary.detail,
      });
    } finally {
      releaseOuterAbort();
      this.#activeRuns.delete(runId);
      this.#resetFileWatches(this.#activeRuns.size > 0 || this.#suspensionDesired);
      if (taskId !== null) {
        try {
          this.#tasks?.finish(taskId);
        } catch {
          // The kernel task is observability; its lifecycle never fails a run.
        }
      }
    }
  }

  async #executeHops(
    declaration: AmpleFileAutomationDeclaration,
    active: ActiveRunState,
    cause: AmpleFileAutomationRunCause,
  ): Promise<RunSummary> {
    const { automationId, runId, controller } = active;
    const chatResults = new Map<string, AmpleFileAutomationChatHopResult>();
    let failure: { hopId: string; error: string } | null = null;
    let halted: { kind: "stopped" } | { kind: "interrupted"; detail: string } | null = null;
    let partial = false;

    for (const step of declaration.steps) {
      if (failure) {
        await this.#receipts.append({
          scope: "hop",
          outcome: "skipped",
          automationId,
          runId,
          hopId: step.id,
          hopKind: step.kind,
          failedHopId: failure.hopId,
          detail: `Hop "${failure.hopId}" failed, so this hop did not run.`,
        });
        continue;
      }
      if (halted === null && controller.signal.aborted) {
        halted = active.stopRequested
          ? { kind: "stopped" }
          : { kind: "interrupted", detail: abortReasonText(controller.signal.reason) };
      }
      if (halted) {
        await this.#receipts.append({
          scope: "hop",
          outcome: "skipped",
          automationId,
          runId,
          hopId: step.id,
          hopKind: step.kind,
          detail: halted.kind === "stopped"
            ? "The run was stopped before this hop."
            : "The run was interrupted before this hop.",
        });
        continue;
      }

      const hopContext: AmpleFileAutomationHopContext = {
        automationId,
        title: declaration.title,
        runId,
        hopId: step.id,
        lineage: { kind: "automation-hop", automationId, automationRunId: runId, hopId: step.id },
        signal: controller.signal,
      };
      const acceptedHop = await this.#receipts.append({
        scope: "hop",
        outcome: "accepted",
        automationId,
        runId,
        hopId: step.id,
        hopKind: step.kind,
        ...hopConnectedFolderFields(step),
      });
      if (!acceptedHop) {
        failure = { hopId: step.id, error: "AmpleFile could not journal this hop, so it was refused before its mutation." };
        continue;
      }

      try {
        if (step.kind === "chat" || step.kind === "agent") {
          // Placeholders are filled in host-side, after this hop's accepted
          // receipt and before the port is called, from the run's own cause
          // and its earlier hops' host records. A resolution that cannot be
          // proven throws here and fails the hop closed.
          const resolved = await this.#resolveMessage(step, declaration, cause, chatResults);
          const filled: Partial<AmpleFileAutomationReceiptV1> = resolved.placeholders.length
            ? { placeholders: resolved.placeholders, messageBytes: resolved.bytes }
            : {};
          let result: AmpleFileAutomationChatHopResult | AmpleFileAutomationAgentHopResult;
          let evidence: Partial<AmpleFileAutomationReceiptV1>;
          if (step.kind === "chat") {
            const chat = await this.#ports.chat(step, resolved.message, hopContext);
            chatResults.set(step.id, chat);
            result = chat;
            evidence = {
              connectedFolderId: step.connectedFolder,
              conversationId: chat.conversationId,
              taskId: chat.turnTaskId,
              ...(chat.preCheckpointId !== undefined && chat.postCheckpointId !== undefined
                ? { checkpointIds: [chat.preCheckpointId, chat.postCheckpointId] }
                : {}),
            };
          } else {
            const agentTurn = await this.#ports.ampleFileAgent(step, resolved.message, hopContext);
            result = agentTurn;
            evidence = { conversationId: agentTurn.conversationId, taskId: agentTurn.turnTaskId };
          }
          // A finished turn's step takes the outcome its Worker reported (the
          // one result shape, docs/collaboration-contract.md): a Worker that
          // could not do the work fails the step in its own words, and one
          // that finished partly marks the step and the run partly done.
          const reported = result.outcome === "aborted" ? null : result.reported ?? null;
          if (reported?.outcome === "failed") {
            const error = reported.summary.trim() || (step.kind === "chat"
              ? "The Worker reported that it could not do this step."
              : "The AmpleFile agent reported that it could not do this step.");
            await this.#receipts.append({
              scope: "hop", outcome: "failed", automationId, runId, hopId: step.id, hopKind: step.kind, ...evidence, ...filled, detail: error,
            });
            failure = { hopId: step.id, error };
          } else if (result.outcome === "succeeded" || reported?.outcome === "partial") {
            if (reported?.outcome === "partial") partial = true;
            await this.#receipts.append({
              scope: "hop", outcome: "succeeded", automationId, runId, hopId: step.id, hopKind: step.kind, ...evidence, ...filled,
              ...(reported?.summary.trim() ? { detail: reported.summary.trim() } : {}),
              ...(reported?.outcome === "partial" ? { partial: true as const } : {}),
            });
          } else if (result.outcome === "aborted" && active.stopRequested) {
            active.stoppedHopTaskIds.push(result.turnTaskId);
            await this.#receipts.append({
              scope: "hop", outcome: "stopped", automationId, runId, hopId: step.id, hopKind: step.kind, ...evidence, ...filled,
            });
            halted = { kind: "stopped" };
          } else if (result.outcome === "aborted" && controller.signal.aborted) {
            await this.#receipts.append({
              scope: "hop", outcome: "interrupted", automationId, runId, hopId: step.id, hopKind: step.kind, ...evidence, ...filled,
            });
            halted = { kind: "interrupted", detail: abortReasonText(controller.signal.reason) };
          } else {
            const error = result.error ?? (step.kind === "chat"
              ? `The Worker turn settled ${result.outcome}.`
              : `The AmpleFile agent's turn settled ${result.outcome}.`);
            await this.#receipts.append({
              scope: "hop", outcome: "failed", automationId, runId, hopId: step.id, hopKind: step.kind, ...evidence, ...filled, detail: error,
            });
            failure = { hopId: step.id, error };
          }
        } else if (step.kind === "files") {
          const resolved = await this.#resolveFilesSource(step, chatResults);
          if (resolved.kind === "empty") {
            await this.#receipts.append({
              scope: "hop",
              outcome: "succeeded",
              automationId,
              runId,
              hopId: step.id,
              hopKind: step.kind,
              fromConnectedFolderId: step.fromConnectedFolder,
              toConnectedFolderId: step.toConnectedFolder,
              fileCount: 0,
              totalBytes: 0,
              copiedPaths: [],
              detail: resolved.detail,
            });
          } else {
            const result = await this.#ports.files(step, resolved.source, hopContext);
            await this.#receipts.append({
              scope: "hop",
              outcome: "succeeded",
              automationId,
              runId,
              hopId: step.id,
              hopKind: step.kind,
              fromConnectedFolderId: step.fromConnectedFolder,
              toConnectedFolderId: step.toConnectedFolder,
              ...(resolved.source.kind === "paths" ? { sourcePaths: [...resolved.source.paths] } : {}),
              copiedPaths: [...result.copiedPaths],
              fileCount: result.fileCount,
              totalBytes: result.totalBytes,
              ...(result.restorePointId !== undefined ? { restorePointId: result.restorePointId } : {}),
            });
          }
        } else {
          const result = await this.#ports.check(step, hopContext);
          const evidence = {
            connectedFolderId: step.connectedFolder,
            checkRunId: result.runId,
            taskId: result.taskId,
            checkIds: [...result.checkIds],
            findingCount: result.findingCount,
            admittedCount: result.admittedCount,
          };
          if (result.state === "succeeded") {
            // Findings are content state for the person; glue is not a gate.
            await this.#receipts.append({
              scope: "hop", outcome: "succeeded", automationId, runId, hopId: step.id, hopKind: step.kind, ...evidence,
            });
          } else if (result.state === "aborted" && active.stopRequested) {
            active.stoppedHopTaskIds.push(result.taskId);
            await this.#receipts.append({
              scope: "hop", outcome: "stopped", automationId, runId, hopId: step.id, hopKind: step.kind, ...evidence,
            });
            halted = { kind: "stopped" };
          } else {
            const error = result.error ?? `The Check run settled ${result.state}.`;
            await this.#receipts.append({
              scope: "hop", outcome: "failed", automationId, runId, hopId: step.id, hopKind: step.kind, ...evidence, detail: error,
            });
            failure = { hopId: step.id, error };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (controller.signal.aborted && active.stopRequested) {
          await this.#receipts.append({
            scope: "hop", outcome: "stopped", automationId, runId, hopId: step.id, hopKind: step.kind, ...hopConnectedFolderFields(step), detail: message,
          });
          halted = { kind: "stopped" };
        } else if (controller.signal.aborted) {
          await this.#receipts.append({
            scope: "hop", outcome: "interrupted", automationId, runId, hopId: step.id, hopKind: step.kind, ...hopConnectedFolderFields(step), detail: message,
          });
          halted = { kind: "interrupted", detail: message };
        } else {
          // Infrastructure refusals inside a hop — a capability mutation
          // fence, a Check reservation conflict — fail the hop with the
          // typed reason; they are glue health, never silently skipped work.
          await this.#receipts.append({
            scope: "hop", outcome: "failed", automationId, runId, hopId: step.id, hopKind: step.kind, ...hopConnectedFolderFields(step), detail: message,
          });
          failure = { hopId: step.id, error: message };
        }
      }
    }

    if (failure) return { kind: "failed", failedHopId: failure.hopId, error: failure.error };
    if (halted) return halted;
    return partial ? { kind: "succeeded", partial: true } : { kind: "succeeded" };
  }

  /**
   * Fills the closed placeholder set into one chat- or agent-step message.
   * Resolution is by the run's own cause, never by the declared trigger: a
   * run-now on a folder-change automation says so in plain words instead of
   * pretending files changed. Versions 1–3 are never scanned — their
   * messages are literal text, braces included.
   */
  async #resolveMessage(
    step: AmpleFileAutomationChatStep | AmpleFileAutomationAgentStep,
    declaration: AmpleFileAutomationDeclaration,
    cause: AmpleFileAutomationRunCause,
    chatResults: Map<string, AmpleFileAutomationChatHopResult>,
  ): Promise<{ message: string; bytes: number; placeholders: AmpleFileAutomationReceiptPlaceholder[] }> {
    const literal = () => ({
      message: step.message,
      bytes: Buffer.byteLength(step.message, "utf8"),
      placeholders: [] as AmpleFileAutomationReceiptPlaceholder[],
    });
    if (declaration.version < 4) return literal();
    const occurrences = ampleFileAutomationMessagePlaceholders(step.message, `Automation step "${step.id}"`);
    if (!occurrences.length) return literal();
    const texts = new Map<string, { text: string; truncated: boolean }>();
    for (const placeholder of occurrences) {
      if (texts.has(placeholder.name)) continue;
      texts.set(placeholder.name, await this.#placeholderText(placeholder, declaration, cause, chatResults));
    }
    const message = step.message.replace(
      /\{\{([^{}]*)\}\}/g,
      (match, inner: string) => texts.get(inner.trim())?.text ?? match,
    );
    const bytes = Buffer.byteLength(message, "utf8");
    if (bytes > ampleFileAutomationBounds.maxResolvedMessageBytes) {
      throw new Error(
        `The filled-in message would exceed the ${ampleFileAutomationBounds.maxResolvedMessageBytes / 1024} KiB limit for one step.`,
      );
    }
    return {
      message,
      bytes,
      placeholders: [...texts].map(([name, value]) => ({
        name,
        text: value.text,
        bytes: Buffer.byteLength(value.text, "utf8"),
        truncated: value.truncated,
      })),
    };
  }

  /**
   * One placeholder's text. Nothing here parses model output: the summary and
   * changed paths come from the run cause the host recorded, findings come
   * from the settled Check run's own record, and created files come from the
   * source chat hop's History checkpoint pair.
   */
  async #placeholderText(
    placeholder: AmpleFileAutomationPlaceholder,
    declaration: AmpleFileAutomationDeclaration,
    cause: AmpleFileAutomationRunCause,
    chatResults: Map<string, AmpleFileAutomationChatHopResult>,
  ): Promise<{ text: string; truncated: boolean }> {
    if (placeholder.name === "trigger.summary") {
      return { text: causeSummary(cause, declaration), truncated: false };
    }
    if (placeholder.name === "trigger.changedFiles") {
      if (cause.kind !== "files-changed") {
        return { text: `(no changed files: ${causeClause(cause)})`, truncated: false };
      }
      const paths = cause.changedPaths ?? [];
      return paths.length ? boundedPlaceholderList(paths) : { text: "(no changed files)", truncated: false };
    }
    if (placeholder.name === "trigger.findings") {
      if (cause.kind !== "on-settled" || cause.source.kind !== "check-run") {
        return { text: "(no findings: this run was not started by a Check run)", truncated: false };
      }
      const unreadable = "The Check run's findings could not be read, so {{trigger.findings}} cannot be filled in.";
      const taskId = cause.source.taskId;
      if (taskId === undefined) throw new Error(unreadable);
      let read: AmpleFileAutomationCheckRunFindings | null;
      try {
        read = await this.#ports.checkRunFindings(cause.source.connectedFolderId, taskId);
      } catch (error) {
        throw new Error(unreadable, { cause: error });
      }
      if (!read) throw new Error(unreadable);
      if (!read.findings.length) return { text: "(no findings)", truncated: false };
      return boundedPlaceholderList(read.findings.map(
        (finding) => `- [${finding.severity}] ${finding.title} — ${finding.targetPath} (${finding.checkId})`,
      ));
    }
    const sourceStepId = placeholder.step!;
    const source = declaration.steps.find((candidate) => candidate.id === sourceStepId);
    if (source?.kind !== "chat") {
      throw new Error(`Automation step "${sourceStepId}" is not a chat step, so its created files cannot be filled in.`);
    }
    const created = await this.#createdFiles(sourceStepId, source.connectedFolder, chatResults);
    return created.length
      ? boundedPlaceholderList(created.map((file) => file.path))
      : { text: "(no files created)", truncated: false };
  }

  async #resolveFilesSource(
    step: AmpleFileAutomationFilesStep,
    chatResults: Map<string, AmpleFileAutomationChatHopResult>,
  ): Promise<{ kind: "source"; source: AmpleFileAutomationResolvedFilesSource } | { kind: "empty"; detail: string }> {
    if (step.from.kind === "paths") {
      return { kind: "source", source: { kind: "paths", paths: [...step.from.paths] } };
    }
    if (step.from.kind === "tree") {
      return {
        kind: "source",
        source: { kind: "tree", path: step.from.path, recursive: step.from.recursive, extensions: [...step.from.extensions] },
      };
    }
    const paths = await this.#resolveCreatedFiles(step, step.from, chatResults);
    if (paths.length === 0) {
      return { kind: "empty", detail: "The source chat step's turn created or changed no files matching this handoff." };
    }
    return { kind: "source", source: { kind: "paths", paths } };
  }

  /**
   * The declared created-files handoff, resolved host-side and
   * deterministically: the manifest diff between the source chat hop's own
   * pre/post-turn History checkpoints, filtered by the declared bounds. No
   * model output is parsed — the file set comes from host-recorded
   * content-addressed identity — and every gap fails the hop closed: a
   * partial handoff is never silently delivered.
   */
  async #resolveCreatedFiles(
    step: AmpleFileAutomationFilesStep,
    source: AmpleFileAutomationStepCreatedFilesSource,
    chatResults: Map<string, AmpleFileAutomationChatHopResult>,
  ): Promise<string[]> {
    const created = await this.#createdFiles(source.step, step.fromConnectedFolder, chatResults, source.extensions);
    if (created.length > source.maxFiles) {
      throw new Error(
        `The turn created or changed ${created.length} matching files, more than this handoff's bound of ${source.maxFiles}.`,
      );
    }
    const totalBytes = created.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (totalBytes > source.maxTotalBytes) {
      throw new Error(
        `The turn's matching files total ${totalBytes} bytes, more than this handoff's bound of ${source.maxTotalBytes}.`,
      );
    }
    return created.map((file) => file.path);
  }

  /**
   * The manifest diff itself, shared by the declared files handoff and the
   * `{{steps.<id>.createdFiles}}` placeholder: sorted paths with their sizes,
   * fail-closed on every gap.
   */
  async #createdFiles(
    sourceStepId: string,
    connectedFolderId: string,
    chatResults: Map<string, AmpleFileAutomationChatHopResult>,
    extensions?: string[],
  ): Promise<AmpleFileAutomationCheckpointManifestEntry[]> {
    const chat = chatResults.get(sourceStepId);
    if (!chat || chat.outcome !== "succeeded") {
      throw new Error(`The created-files handoff needs chat hop "${sourceStepId}" to have succeeded in this run.`);
    }
    if (chat.preCheckpointId === undefined || chat.postCheckpointId === undefined) {
      throw new Error(
        `Chat hop "${sourceStepId}" did not record its pre/post-turn checkpoint pair, so the created files cannot be resolved.`,
      );
    }
    const pre = await this.#ports.checkpointManifest(connectedFolderId, chat.preCheckpointId);
    const post = await this.#ports.checkpointManifest(connectedFolderId, chat.postCheckpointId);
    if (!pre || !post) {
      const missing = !pre ? chat.preCheckpointId : chat.postCheckpointId;
      throw new Error(`Checkpoint ${missing} is missing from the source Connected Folder's History, so the created files cannot be resolved.`);
    }
    const matches = (path: string): boolean => {
      if (!extensions || extensions.length === 0) return true;
      const lowered = path.toLocaleLowerCase("en-US");
      return extensions.some((extension) => lowered.endsWith(extension));
    };
    for (const [label, manifest] of [["pre-turn", pre], ["post-turn", post]] as const) {
      const skipped = manifest.skippedFilePaths.filter(matches);
      if (skipped.length) {
        throw new Error(
          `The ${label} checkpoint skipped ${skipped.length} file(s) matching this handoff (first: ${skipped[0]}), `
            + "so the created files cannot be proven complete.",
        );
      }
    }
    const before = new Map(pre.files.map((file) => [file.path, file.hashSha256]));
    return post.files
      .filter((file) => matches(file.path) && before.get(file.path) !== file.hashSha256)
      .map((file) => ({ ...file }))
      .sort((left, right) => compareAutomationStrings(left.path, right.path));
  }

  async #onAutomationResult(result: AmpleFileSchedulerRunResult): Promise<void> {
    const automationId = result.key.jobId;
    const registeredCause = this.#causeByRunId.get(result.runId);
    this.#causeByRunId.delete(result.runId);
    const launched = this.#launchedRunIds.delete(result.runId);
    if (!launched) {
      // Admissions that never launched — per-automation non-overlap, suspension,
      // disable, unregistration, close — settle skipped and are receipted as
      // such, naming the cause that admitted them.
      const cause: AmpleFileAutomationRunCause = registeredCause
        ?? (result.reason === "scheduled" || result.reason === "resume"
          ? { kind: result.reason, slotAt: result.scheduledAt }
          : { kind: "run-now" });
      let occurrenceId: string | undefined;
      const armed = this.#armed.get(automationId);
      const record = await this.#store.get(automationId).catch(() => undefined);
      const catchUpSurvivesLifecyclePause = (
        result.notLaunchedReason === "suspended"
        || result.notLaunchedReason === "closed"
      ) && (cause.kind === "scheduled" || cause.kind === "resume") && (
        record?.declaration.trigger.kind === "interval"
        || (record?.declaration.trigger.kind === "at" && record.declaration.trigger.ifMissed === "run")
      );
      const oneTimeSlotSurvivesManualOverlap = result.notLaunchedReason === "overlap"
        && (cause.kind === "scheduled" || cause.kind === "resume")
        && record?.declaration.trigger.kind === "at";
      if (catchUpSurvivesLifecyclePause || oneTimeSlotSurvivesManualOverlap) {
        await this.#receipts.append({
          scope: "run",
          outcome: "skipped",
          automationId,
          runId: result.runId,
          cause,
          detail: oneTimeSlotSurvivesManualOverlap
            ? `${result.error ?? "The admission paused before launch."} The one-time slot remains pending until the manual copy settles.`
            : `${result.error ?? "The admission paused before launch."} Its durable schedule remains eligible for catch-up.`,
        });
        return;
      }
      if (
        armed
        && record?.health === "enabled"
        && record.digest === armed.digest
        && (cause.kind === "scheduled" || cause.kind === "resume")
        && (record.declaration.trigger.kind === "at" || record.declaration.trigger.kind === "interval")
      ) {
        const accepted = await this.#receipts.append({
          scope: "run",
          outcome: "accepted",
          automationId,
          runId: result.runId,
          title: record.declaration.title,
          digest: record.digest,
          cause,
        });
        if (accepted && record.declaration.trigger.kind === "at") {
          const claimed = await this.#store.claimAtOccurrence(automationId, cause.slotAt, result.runId, new Date(result.startedAt));
          occurrenceId = claimed?.atOccurrence?.occurrenceId;
        } else if (accepted) {
          await this.#store.recordCadence(automationId, cause.slotAt);
        }
      }
      await this.#receipts.append({
        scope: "run",
        outcome: "skipped",
        automationId,
        runId: result.runId,
        cause,
        ...(occurrenceId !== undefined ? { occurrenceId } : {}),
        detail: result.error ?? `The admission settled ${result.outcome} before launch.`,
      });
      if (occurrenceId !== undefined) {
        await this.#store.finishAtOccurrence(automationId, result.runId, result.finishedAt);
        this.#disarm(automationId);
      }
      return;
    }
    if (result.reason !== "manual") {
      const record = await this.#store.get(automationId).catch(() => undefined);
      if (record?.health === "completed" && record.atOccurrence?.runId === result.runId) {
        await this.#store.finishAtOccurrence(automationId, result.runId, result.finishedAt);
        this.#disarm(automationId);
      }
    }
  }

  #assertOperational(): void {
    if (this.#closed) {
      throw new AmpleFileAutomationServiceError("SERVICE_DAMAGED", "The automation executor is closed.");
    }
    if (this.#journalDamageReason !== null) {
      throw new AmpleFileAutomationServiceError(
        "SERVICE_DAMAGED",
        `AmpleFile cannot arm or run automations: ${this.#journalDamageReason} Disable, suspension, and deletion remain available.`,
      );
    }
  }
}

function hopConnectedFolderFields(
  step: AmpleFileAutomationStep,
): { connectedFolderId: string } | { fromConnectedFolderId: string; toConnectedFolderId: string } | Record<string, never> {
  if (step.kind === "files") return { fromConnectedFolderId: step.fromConnectedFolder, toConnectedFolderId: step.toConnectedFolder };
  // An agent hop names no Connected Folder: the AmpleFile agent sits above them.
  return step.kind === "agent" ? {} : { connectedFolderId: step.connectedFolder };
}

function settleMatchesSource(source: AmpleFileAutomationSettleSource, record: AmpleFileSettleRecord): boolean {
  if (source.kind === "check-run") {
    return record.kind === "check-run"
      && record.connectedFolderId === source.connectedFolder
      && (source.check === undefined || record.checkIds.includes(source.check))
      && (source.outcomes as readonly string[]).includes(record.state);
  }
  return record.kind === "app-automation-run"
    && record.connectedFolderId === source.connectedFolder
    && record.appId === source.appId
    && record.appAutomationId === source.appAutomationId
    && (source.outcomes as readonly string[]).includes(record.outcome);
}

function settleCause(record: AmpleFileSettleRecord): AmpleFileAutomationRunCause {
  if (record.kind === "check-run") {
    return {
      kind: "on-settled",
      source: {
        kind: "check-run",
        connectedFolderId: record.connectedFolderId,
        runId: record.runId,
        state: record.state,
        checkIds: [...record.checkIds],
        // The Check task id is how `{{trigger.findings}}` reads the settled
        // run's own findings back from the host.
        taskId: record.taskId,
      },
    };
  }
  return {
    kind: "on-settled",
    source: {
      kind: "app-automation-run",
      connectedFolderId: record.connectedFolderId,
      appId: record.appId,
      appAutomationId: record.appAutomationId,
      runId: record.runId,
      outcome: record.outcome,
    },
  };
}

function sameSavedFileState(
  left: { snapshot: { digest: string }; lastTriggeredAt?: string; owed?: { reason: string; paths: string[] } },
  right: { snapshot: { digest: string }; lastTriggeredAt?: string; owed?: { reason: string; paths: string[] } },
): boolean {
  if (left.snapshot.digest !== right.snapshot.digest || left.lastTriggeredAt !== right.lastTriggeredAt) return false;
  if (!left.owed || !right.owed) return !left.owed && !right.owed;
  return left.owed.reason === right.owed.reason
    && left.owed.paths.length === right.owed.paths.length
    && left.owed.paths.every((path, index) => path === right.owed!.paths[index]);
}

function compareAutomationStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Room for the "… and n more" marker inside the per-placeholder byte bound. */
const placeholderMarkerAllowanceBytes = 96;

/**
 * One filled-in list placeholder, cut at a line boundary. Every cut names the
 * limit that actually bit, so a person reading the message knows the list is
 * short because AmpleFile stopped, not because the work did.
 */
function boundedPlaceholderList(rawLines: string[]): { text: string; truncated: boolean } {
  const maxItems = ampleFileAutomationBounds.maxPlaceholderListItems;
  const maxBytes = ampleFileAutomationBounds.maxPlaceholderTextBytes;
  // Placeholder text is host-supplied, not declared: a pre-existing file named
  // with a direction override would otherwise carry a character the
  // declaration contract forbids into the message the destination receives —
  // and the hop receipt, which replaces the same class, would then disagree
  // with what was actually sent. Filtering here keeps the two identical.
  const lines = rawLines.map((line) => scrubAmpleFileAutomationMessageText(line));
  const kept: string[] = [];
  let bytes = 0;
  let byteLimited = false;
  for (const line of lines.slice(0, maxItems)) {
    const cost = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (bytes + cost > maxBytes - placeholderMarkerAllowanceBytes) {
      byteLimited = true;
      break;
    }
    kept.push(line);
    bytes += cost;
  }
  const omitted = lines.length - kept.length;
  if (omitted <= 0) return { text: kept.join("\n"), truncated: false };
  const limit = byteLimited ? `${maxBytes / 1024} KiB` : `${maxItems}-item`;
  return {
    text: [...kept, `… and ${omitted} more (${limit} limit for one filled-in placeholder)`].join("\n"),
    truncated: true,
  };
}

/** `{{trigger.summary}}`: what actually started this run, in one sentence. */
function causeSummary(cause: AmpleFileAutomationRunCause, declaration: AmpleFileAutomationDeclaration): string {
  switch (cause.kind) {
    case "run-now":
      return "Started by hand.";
    case "scheduled":
      return `Scheduled run for ${cause.slotAt}.`;
    case "resume":
      return `Caught-up run for the ${cause.slotAt} slot.`;
    case "files-changed": {
      const watched = declaration.trigger.kind === "files-changed" ? declaration.trigger.watch.path : "the watched folder";
      if (cause.catchUp) {
        const { count, reason } = cause.catchUp;
        const more = cause.changedCount - count;
        return `Caught up on ${count} ${count === 1 ? "file" : "files"} ${watched ? `under "${watched}"` : "at the top level"} in Connected Folder ${cause.connectedFolderId}`
          + ` that changed ${automationCatchUpGap(reason)}.`
          + (more > 0 ? ` ${more} more ${more === 1 ? "file" : "files"} changed after that.` : "");
      }
      return `${cause.changedCount} file(s) changed ${watched ? `under "${watched}"` : "at the top level"} in Connected Folder ${cause.connectedFolderId}.`;
    }
    default:
      return cause.source.kind === "check-run"
        ? `Check run ${cause.source.runId} in Connected Folder ${cause.source.connectedFolderId} settled ${cause.source.state}`
          + ` (Checks: ${cause.source.checkIds.join(", ")}).`
        : `App automation ${cause.source.appId}/${cause.source.appAutomationId} in Connected Folder ${cause.source.connectedFolderId}`
          + ` settled ${cause.source.outcome}.`;
  }
}

/** Why a placeholder has nothing to fill in for this run, in the same sentence. */
function causeClause(cause: AmpleFileAutomationRunCause): string {
  switch (cause.kind) {
    case "run-now":
      return "this run was started by hand";
    case "scheduled":
      return "this was a scheduled run";
    case "resume":
      return "this was a caught-up run";
    case "files-changed":
      return "this run was started by a folder change";
    default:
      return "this run was started by a settled run";
  }
}

function abortReasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "The run was aborted.";
}

function runReceiptFields(
  cause: AmpleFileAutomationRunCause,
  record: AmpleFileAutomationRecord,
): Pick<AmpleFileAutomationActionReceiptContext, "requestId" | "surface"> & { occurrenceId?: string } {
  return {
    ...(cause.kind === "run-now" && cause.requestId !== undefined ? { requestId: cause.requestId } : {}),
    ...(cause.kind === "run-now" && cause.surface !== undefined ? { surface: cause.surface } : {}),
    ...(record.atOccurrence?.runId !== undefined
      ? { occurrenceId: record.atOccurrence.occurrenceId }
      : record.declaration.trigger.kind === "at" && (cause.kind === "scheduled" || cause.kind === "resume")
        ? {
          occurrenceId: ampleFileAutomationAtOccurrenceId(
            record.declaration.id,
            record.digest,
            cause.slotAt,
          ),
        }
        : {}),
  };
}
