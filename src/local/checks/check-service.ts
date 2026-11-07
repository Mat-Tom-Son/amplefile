import { correctionId, normalizeCheckCorrection, readCheckCorrectionProposal, writeCheckCorrection, type CheckCorrectionProposal, type CheckCorrectionRecord } from "./check-corrections.js";
import { restrictedAppCheckLimits, type RestrictedAppCheckResult } from "../../shared/restricted-app-checks.js";
import { readCheckTextSnapshot } from "./check-text.js";
import { createConnectedFolderMutationCheckpoint } from "../history.js";
import { withConnectedFolderHistoryOperation } from "../connected-folder.js";
import { normalizeAmpleFileCheckProposal } from "../../shared/checks.js";
import { createModelReviewSensor, type AmpleFileModelCheckReviewer } from "./model-review-sensor.js";
import { loadCheckTextSnapshots, modelCheckLimits, type AmpleFileCheckTextSnapshot } from "./check-text.js";
import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";

import type { AmpleFileCheckDeclaration, AmpleFileCheckProposal } from "../../shared/checks.js";
import type { AmpleFileSettleLineage, AmpleFileSettleSignal } from "../automations/settle-signal.js";
import type { AmpleFileActor, AmpleFileKernel } from "../amplefile-kernel.js";
import { listConnectedFolders, type ConnectedFolderSummary } from "../connected-folder.js";
import {
  discoverAmpleFileCheckDeclarations,
  readAmpleFileCheckProposal,
  writeAmpleFileCheckDeclaration,
  type AmpleFileCheckDeclarationDiscovery,
  type AmpleFileCheckDeclarationRecord,
} from "./check-declarations.js";
import { admitAmpleFileCheckCandidate, reverifyAmpleFileCheckFinding } from "./check-admission.js";
import { ampleFileCheckDigest } from "./check-integrity.js";
import { resolveAmpleFileCheckSensor, type AmpleFileCheckSensor } from "./check-sensors.js";
import { AmpleFileCheckStore, purgeAmpleFileCheckState } from "./check-store.js";
import type {
  AmpleFileCheckAggregateState,
  AmpleFileCheckAuthorization,
  AmpleFileCheckDecision,
  AmpleFileCheckDecisionKind,
  AmpleFileCheckFinding,
  AmpleFileCheckMachineState,
  AmpleFileCheckRendererAuthorityState,
  AmpleFileCheckRendererDecorations,
  AmpleFileCheckRendererOverview,
  AmpleFileCheckRunLimits,
  AmpleFileCheckRunRecord,
  AmpleFileCheckStatusSnapshot,
} from "./check-types.js";
import { ampleFileCheckExperimentalSnapshotVersion } from "./check-types.js";
import { resolveAmpleFileCheckTargets, type AmpleFileCheckTargetResolution } from "./target-resolver.js";

const defaultRunLimits: AmpleFileCheckRunLimits = Object.freeze({
  maximumFiles: 100_000,
  maximumFileBytes: 1024 * 1024 * 1024,
  maximumTotalBytes: 16 * 1024 * 1024 * 1024,
  maximumFindings: 100_000,
  timeoutMs: 30 * 60_000,
});

export interface AmpleFileCheckConnectedFolderRef {
  id: string;
  connectedFolderRoot: string;
}

export interface AmpleFileCheckServiceOptions {
  kernel: AmpleFileKernel;
  now?: () => Date;
  createRunId?: () => string;
  createTaskId?: () => string;
  storeFactory?: (connectedFolderId: string) => Promise<AmpleFileCheckStore>;
  listConnectedFolders?: () => Promise<ConnectedFolderSummary[]>;
  reviewModel?: AmpleFileModelCheckReviewer;
  resolveSensor?: (id: string, revision: number) => AmpleFileCheckSensor | null;
  /** Automation-trigger seam; terminal runs are published only after they are durable. */
  settleSignal?: AmpleFileSettleSignal;
  /**
   * A selected Check's result may have changed, so a host can tell an app view
   * that reads it to re-read (docs/collaboration-contract.md, F30). Deliberately
   * separate from `settleSignal`, which keeps exactly one consumer: the automation
   * service. Carries ids only, and a listener that throws never fails the Check
   * operation that produced it.
   */
  onResultChanged?: (event: { connectedFolderId: string; checkIds: string[] }) => void;
}

interface ActiveCheckRun {
  connectedFolderId: string;
  runId: string;
  checkIds: string[];
  controller: AbortController;
  promise: Promise<void>;
}

export interface AmpleFileCheckTaskStatus {
  taskId: string;
  runId: string | null;
  state: AmpleFileCheckRunRecord["state"] | "unknown";
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

/**
 * Content-free projection of one settled Check run for cross-surface digests
 * (the overview's check reader). Identifiers, terminal state, timestamps, and
 * the admitted count only.
 */
export interface AmpleFileCheckSettledRunSummary {
  runId: string;
  taskId: string;
  state: Exclude<AmpleFileCheckRunRecord["state"], "accepted" | "running">;
  startedAt: string;
  endedAt?: string;
  admittedCount: number;
}

interface AmpleFileCheckProblemsResult {
  findings: AmpleFileCheckFinding[];
  invalidated: number;
  healthErrors: string[];
  truncated: boolean;
}

export class AmpleFileCheckOperationConflictError extends Error {
  constructor(message = "Wait for the current Check operation in this Connected Folder to finish.") {
    super(message);
    this.name = "AmpleFileCheckOperationConflictError";
  }
}

export class AmpleFileCheckService {
  readonly #kernel: AmpleFileKernel;
  readonly #now: () => Date;
  readonly #createRunId: () => string;
  readonly #createTaskId: () => string;
  readonly #storeFactory: (connectedFolderId: string) => Promise<AmpleFileCheckStore>;
  readonly #listConnectedFolders: () => Promise<ConnectedFolderSummary[]>;
  readonly #resolveSensor: (id: string, revision: number) => AmpleFileCheckSensor | null;
  readonly #settleSignal: AmpleFileSettleSignal | null;
  readonly #onResultChanged: AmpleFileCheckServiceOptions["onResultChanged"];
  readonly #stores = new Map<string, Promise<AmpleFileCheckStore>>();
  readonly #active = new Map<string, ActiveCheckRun>();
  readonly #runReservations = new Set<string>();
  readonly #operationReservations = new Set<string>();
  readonly #connectedFolderRemovalReservations = new Set<string>();
  #connectedFolderRegistryMutationReserved = false;
  readonly #terminalRecovery = new Map<string, {
    connectedFolderId: string;
    store: AmpleFileCheckStore;
    run: AmpleFileCheckRunRecord;
    lineage?: AmpleFileSettleLineage;
  }>();

  constructor(options: AmpleFileCheckServiceOptions) {
    this.#kernel = options.kernel;
    this.#now = options.now ?? (() => new Date());
    this.#createRunId = options.createRunId ?? (() => `check-run-${randomUUID()}`);
    this.#createTaskId = options.createTaskId ?? (() => `check-task-${randomUUID()}`);
    this.#storeFactory = options.storeFactory ?? ((connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId));
    this.#listConnectedFolders = options.listConnectedFolders ?? listConnectedFolders;
    const modelSensor = createModelReviewSensor(options.reviewModel);
    this.#resolveSensor = options.resolveSensor ?? ((id, revision) => id === modelSensor.id && revision === modelSensor.revision ? modelSensor : resolveAmpleFileCheckSensor(id, revision));
    this.#settleSignal = options.settleSignal ?? null;
    this.#onResultChanged = options.onResultChanged;
  }

  enable(input: {
    connectedFolder: AmpleFileCheckConnectedFolderRef;
    proposalPath?: string;
    proposal?: unknown;
    checkId?: string;
    expectedDigest?: string;
    actor: AmpleFileCheckAuthorization["enabledBy"];
    /** Materialize an inert proposal without granting run authority. */
    proposeOnly?: boolean;
  }): Promise<{ declaration: AmpleFileCheckDeclaration; digest: string }> {
    return this.#withOperationReservation(input.connectedFolder.id, async () => {
      const connectedFolder = await this.#registeredConnectedFolder(input.connectedFolder);
      if ([input.proposalPath, input.proposal, input.checkId].filter((value) => value !== undefined).length !== 1) throw new Error("Provide exactly one Check proposal or existing Check.");
      let proposal: AmpleFileCheckProposal;
      if (input.checkId !== undefined) {
        const existing = (await discoverAmpleFileCheckDeclarations(connectedFolder.connectedFolderRoot)).declarations.find((item) => item.declaration.id === input.checkId);
        if (!existing || existing.digest !== input.expectedDigest) throw new AmpleFileCheckOperationConflictError("This Check changed since review. Refresh and inspect it again.");
        const { title, severity, trigger, sensor, targets, createdAt, createdBy } = existing.declaration;
        proposal = normalizeAmpleFileCheckProposal({ kind: "amplefile.check-proposal", version: 1, name: title.slice(0, 120), createdAt, createdBy, check: { title, severity, trigger, sensor, targets } });
      } else proposal = input.proposalPath !== undefined ? await readAmpleFileCheckProposal(input.proposalPath) : normalizeAmpleFileCheckProposal(input.proposal);
      const sensor = this.#resolveSensor(proposal.check.sensor.id, proposal.check.sensor.revision);
      if (!sensor) throw new Error("The proposed Check requires a sensor revision that is not installed.");
      const preview: AmpleFileCheckDeclaration = {
        kind: "amplefile.check",
        version: 1,
        id: "check-preview0",
        ...proposal.check,
        createdBy: proposal.createdBy,
        createdAt: proposal.createdAt,
      };
      sensor.validate(preview);
      await this.#assertNoNestedConnectedFolderTargets(connectedFolder, preview);
      const limits = sensor.execution === "model" ? modelCheckLimits : defaultRunLimits;
      await resolveAmpleFileCheckTargets(connectedFolder.connectedFolderRoot, preview.targets, {
        limits: {
          maxFiles: limits.maximumFiles,
          maxFileBytes: limits.maximumFileBytes,
          maxTotalBytes: limits.maximumTotalBytes,
        },
      });
      const discovery = await discoverAmpleFileCheckDeclarations(connectedFolder.connectedFolderRoot);
      const identity = proposalDeclarationIdentity(proposal);
      const written = discovery.declarations.find((record) => declarationIdentity(record.declaration) === identity)
        ?? await writeAmpleFileCheckDeclaration(connectedFolder.connectedFolderRoot, proposal);
      sensor.validate(written.declaration);
      if (input.proposeOnly) return { declaration: written.declaration, digest: written.digest };
      const store = await this.#store(connectedFolder.id);
      const existingAuthorization = exactAuthorization(store.snapshot().authorizations[written.declaration.id], written);
      if (existingAuthorization
        && existingAuthorization.sensorDigest === sensor.implementationDigest
        && existingAuthorization.execution === sensor.execution) {
        return { declaration: written.declaration, digest: written.digest };
      }
      await store.authorize(
        written.declaration,
        written.digest,
        input.actor,
        sensor.implementationDigest,
        this.#now(),
        sensor.execution,
        limits,
      );
      return { declaration: written.declaration, digest: written.digest };
    });
  }

  proposeCorrection(input: { connectedFolder: AmpleFileCheckConnectedFolderRef; proposal?: unknown; proposalPath?: string }): Promise<CheckCorrectionRecord> {
    return this.#withOperationReservation(input.connectedFolder.id, async () => {
      const connectedFolder = await this.#registeredConnectedFolder(input.connectedFolder);
      const proposal = input.proposalPath !== undefined ? await readCheckCorrectionProposal(input.proposalPath) : normalizeCheckCorrection(input.proposal);
      await this.#reviewCorrection(connectedFolder, proposal);
      const store = await this.#store(connectedFolder.id);
      const id = correctionId(proposal);
      const existing = store.snapshot().corrections?.find((item) => item.id === id);
      if (existing) return existing;
      const correction: CheckCorrectionRecord = { id, proposal, createdAt: this.#now().toISOString(), state: "pending" };
      await store.saveCorrection(correction);
      return correction;
    });
  }

  reviewCorrection(connectedFolder: AmpleFileCheckConnectedFolderRef, id: string): Promise<{ correction: CheckCorrectionRecord; before: string }> {
    return this.#withOperationReservation(connectedFolder.id, async () => {
      const registered = await this.#registeredConnectedFolder(connectedFolder);
      const correction = (await this.#store(connectedFolder.id)).snapshot().corrections?.find((item) => item.id === id);
      if (!correction || correction.state !== "pending") throw new AmpleFileCheckOperationConflictError("This correction is no longer pending.");
      const { before } = await this.#reviewCorrection(registered, correction.proposal);
      return { correction, before };
    });
  }

  dismissCorrection(connectedFolder: AmpleFileCheckConnectedFolderRef, id: string): Promise<void> {
    return this.#withOperationReservation(connectedFolder.id, async () => {
      await this.#registeredConnectedFolder(connectedFolder);
      const store = await this.#store(connectedFolder.id);
      const correction = store.snapshot().corrections?.find((item) => item.id === id);
      if (!correction || correction.state !== "pending") throw new AmpleFileCheckOperationConflictError("This correction is no longer pending.");
      await store.saveCorrection({ ...correction, state: "dismissed" });
    });
  }

  /** Caller also reserves app/Worker mutation authority. All content writes
   * retain their History checkpoint even after partial failure. No retry occurs. */
  applyCorrection(connectedFolder: AmpleFileCheckConnectedFolderRef, id: string): Promise<{ correction: CheckCorrectionRecord; checkId: string }> {
    return this.#withOperationReservation(connectedFolder.id, () => withConnectedFolderHistoryOperation(connectedFolder.connectedFolderRoot, async () => {
      const registered = await this.#registeredConnectedFolder(connectedFolder);
      if (this.#runReservations.has(connectedFolder.id) || [...this.#active.values()].some((run) => run.connectedFolderId === connectedFolder.id)) throw new AmpleFileCheckOperationConflictError("Wait for the Check run to finish before applying a correction.");
      const store = await this.#store(connectedFolder.id);
      const correction = store.snapshot().corrections?.find((item) => item.id === id);
      if (!correction || correction.state !== "pending") throw new AmpleFileCheckOperationConflictError("This correction is no longer pending. It was not applied again.");
      const reviewed = await this.#reviewCorrection(registered, correction.proposal);
      const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, { paths: [correction.proposal.path], reason: "check_correction", label: `Before Check correction: ${correction.proposal.path}` });
      if (!safety.files.some((file) => file.path === correction.proposal.path && file.hashSha256 === correction.proposal.beforeHash)) throw new Error("History could not preserve the exact file being corrected. Nothing was changed.");
      const applying = { ...correction, state: "applying" as const, checkpointId: safety.checkpointId };
      await store.saveCorrection(applying);
      try {
        await this.#reviewCorrection(registered, correction.proposal);
        await writeCheckCorrection(connectedFolder.connectedFolderRoot, correction.proposal);
        const applied = { ...applying, state: "applied" as const };
        await store.saveCorrection(applied);
        // The corrected file is the Check's own evidence, so an app reading
        // that selection is now holding an older answer.
        this.#publishResultChanged(connectedFolder.id, [reviewed.finding.checkId]);
        return { correction: applied, checkId: reviewed.finding.checkId };
      } catch (error) {
        await store.saveCorrection({ ...applying, state: "failed", error: errorMessage(error).slice(0, 2000) });
        throw new Error(`Correction did not finish. Inspect the file and History checkpoint ${safety.checkpointId}. ${errorMessage(error)}`);
      }
    }));
  }

  async #reviewCorrection(connectedFolder: AmpleFileCheckConnectedFolderRef, proposal: CheckCorrectionProposal): Promise<{ finding: AmpleFileCheckFinding; before: string }> {
    const problems = await this.#problems(connectedFolder, false);
    const finding = problems.findings.find((item) => item.id === proposal.findingId && item.fingerprint === proposal.fingerprint && item.targetPath === proposal.path);
    if (!finding || !finding.evidence.some((evidence) => evidence.kind === "text-span" && evidence.identity.sha256 === proposal.beforeHash)) throw new AmpleFileCheckOperationConflictError("The finding or its inputs changed. Run the Check and prepare a fresh correction.");
    const snapshot = await readCheckTextSnapshot(connectedFolder.connectedFolderRoot, proposal.path, ["primary"]);
    if (snapshot.sha256 !== proposal.beforeHash) throw new AmpleFileCheckOperationConflictError("The file changed since the correction was prepared.");
    if (snapshot.text === proposal.replacement) throw new Error("The proposed correction does not change the file.");
    return { finding, before: snapshot.text };
  }

  disable(connectedFolder: AmpleFileCheckConnectedFolderRef, checkId: string): Promise<boolean> {
    return this.#withOperationReservation(connectedFolder.id, async () => {
      const registered = await this.#registeredConnectedFolder(connectedFolder);
      const active = [...this.#active.values()].find((run) => run.connectedFolderId === registered.id && run.checkIds.includes(checkId));
      if (active) active.controller.abort("Check disabled.");
      const removed = await (await this.#store(registered.id)).disable(checkId);
      // An app holding this selection now reads a Check that is gone; it should
      // learn that from a hint rather than from its next stale render.
      if (removed) this.#publishResultChanged(registered.id, [checkId]);
      return removed;
    });
  }

  tryReserveConnectedFolderRemoval(connectedFolderId: string): (() => void) | null {
    if (this.#connectedFolderRegistryMutationReserved
      || this.#connectedFolderRemovalReservations.has(connectedFolderId)
      || this.#runReservations.has(connectedFolderId)
      || this.#operationReservations.has(connectedFolderId)
      || [...this.#active.values()].some((run) => run.connectedFolderId === connectedFolderId)) return null;
    this.#connectedFolderRemovalReservations.add(connectedFolderId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#connectedFolderRemovalReservations.delete(connectedFolderId);
    };
  }

  tryReserveConnectedFolderRegistryMutation(): (() => void) | null {
    if (this.#connectedFolderRegistryMutationReserved || this.hasActiveRun()) return null;
    this.#connectedFolderRegistryMutationReserved = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#connectedFolderRegistryMutationReserved = false;
    };
  }

  async removeConnectedFolder(connectedFolderId: string): Promise<void> {
    let releaseOwnReservation: (() => void) | null = null;
    if (!this.#connectedFolderRemovalReservations.has(connectedFolderId)) {
      releaseOwnReservation = this.tryReserveConnectedFolderRemoval(connectedFolderId);
      if (!releaseOwnReservation) throw new AmpleFileCheckOperationConflictError("Wait for the current Check operation before removing this Connected Folder.");
    }
    try {
      const active = [...this.#active.entries()].filter(([, run]) => run.connectedFolderId === connectedFolderId);
      for (const [, run] of active) run.controller.abort("Connected Folder removed.");
      await Promise.allSettled(active.map(([, run]) => run.promise));
      const cachedStore = this.#stores.get(connectedFolderId);
      if (cachedStore) {
        try {
          await (await cachedStore).purge();
        } catch {
          await purgeAmpleFileCheckState(connectedFolderId);
        }
      } else {
        await purgeAmpleFileCheckState(connectedFolderId);
      }
      for (const [taskId] of active) {
        this.#terminalRecovery.delete(taskId);
        this.#finishActiveTask(taskId);
      }
      this.#stores.delete(connectedFolderId);
    } finally {
      releaseOwnReservation?.();
    }
  }

  status(connectedFolder: AmpleFileCheckConnectedFolderRef): Promise<AmpleFileCheckStatusSnapshot> {
    return this.#withOperationReservation(connectedFolder.id, async () => this.#status(await this.#registeredConnectedFolder(connectedFolder)));
  }

  /**
   * Content-free summaries of this Connected Folder's settled Check runs, for the
   * overview (docs/amplefile-agent-overview.md): identifiers, terminal state,
   * timestamps, and the admitted count only — never findings, evidence, paths,
   * or inputs. This is
   * a plain read over the store's persisted run records, deliberately outside
   * the per–Connected Folder operation reservation so composing the overview never
   * conflicts with (or blocks) running Check work.
   */
  async settledRuns(connectedFolder: AmpleFileCheckConnectedFolderRef): Promise<AmpleFileCheckSettledRunSummary[]> {
    const registered = await this.#registeredConnectedFolder(connectedFolder);
    const runs = (await this.#store(registered.id)).snapshot().runs;
    return runs
      .filter((run) => !run.trial && run.state !== "accepted" && run.state !== "running")
      .map((run) => ({
        runId: run.id,
        taskId: run.taskId,
        state: run.state as AmpleFileCheckSettledRunSummary["state"],
        startedAt: run.startedAt,
        ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
        admittedCount: run.admittedCount,
      }));
  }

  decorations(connectedFolder: AmpleFileCheckConnectedFolderRef): Promise<AmpleFileCheckRendererDecorations> {
    return this.#withOperationReservation(connectedFolder.id, async () => {
      const registered = await this.#registeredConnectedFolder(connectedFolder);
      const problems = await this.#problems(registered, false);
      const counts = new Map<string, number>();
      for (const finding of problems.findings) {
        counts.set(finding.targetPath, (counts.get(finding.targetPath) ?? 0) + 1);
      }
      return {
        kind: "amplefile.checks.decorations",
        version: ampleFileCheckExperimentalSnapshotVersion,
        connectedFolderId: registered.id,
        items: [...counts.entries()]
          .sort(([left], [right]) => left.localeCompare(right, "en-US"))
          .map(([path, count]) => ({ path, count })),
      };
    });
  }

  overview(connectedFolder: AmpleFileCheckConnectedFolderRef): Promise<AmpleFileCheckRendererOverview> {
    return this.#withOperationReservation(connectedFolder.id, async () => {
      const registered = await this.#registeredConnectedFolder(connectedFolder);
      const discovery = await discoverAmpleFileCheckDeclarations(registered.connectedFolderRoot);
      const problems = await this.#problems(registered, true, undefined, discovery);
      const state = (await this.#store(registered.id)).snapshot();
      const status = await this.#status(registered, problems, { discovery, state });
      const checks = [];
      for (const record of discovery.declarations) {
        checks.push({
          id: record.declaration.id,
          digest: record.digest,
          title: record.declaration.title,
          severity: record.declaration.severity,
          trigger: record.declaration.trigger,
          sensor: {
            id: record.declaration.sensor.id,
            revision: record.declaration.sensor.revision,
          },
          targets: structuredClone(record.declaration.targets),
          execution: this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision)?.execution,
          ...(typeof record.declaration.sensor.parameters.criteria === "string" ? { criteria: record.declaration.sensor.parameters.criteria } : {}),
          authority: await this.#rendererAuthorityState(registered, record, state.authorizations[record.declaration.id]),
        });
      }
      return {
        kind: "amplefile.checks.renderer",
        version: ampleFileCheckExperimentalSnapshotVersion,
        connectedFolderId: registered.id,
        status,
        checks,
        corrections: state.corrections ?? [],
        ...problems,
      };
    });
  }

  /** Re-verifies only the selected Check's targets. Never runs a sensor. */
  selectedResult(connectedFolder: AmpleFileCheckConnectedFolderRef, checkId: string, declarationDigest: string): Promise<RestrictedAppCheckResult> {
    return this.#withOperationReservation(connectedFolder.id, async () => {
      const registered = await this.#registeredConnectedFolder(connectedFolder);
      const discovered = await discoverAmpleFileCheckDeclarations(registered.connectedFolderRoot);
      const record = discovered.declarations.find((item) => item.declaration.id === checkId && item.digest === declarationDigest);
      if (!record) throw new AmpleFileCheckOperationConflictError("The selected Check changed or is unavailable. Choose it again in Apps.");
      const discovery = { declarations: [record], errors: [] };
      const state = (await this.#store(registered.id)).snapshot();
      const problems = await this.#problems(registered, true, checkId, discovery);
      const status = await this.#status(registered, problems, { discovery, state });
      const running = [...this.#active.values()].some((run) => run.connectedFolderId === registered.id && run.checkIds.includes(checkId));
      const result: RestrictedAppCheckResult = {
        checkId, declarationDigest, title: record.declaration.title,
        state: !status.enabled || status.blocked ? "blocked"
          : running ? "running"
          : status.errors || problems.healthErrors.length ? "check-error"
          : status.neverRun ? "never-run"
          : status.stale || !status.current ? "stale"
          : status.needsAttention ? "needs-attention" : "current-clear",
        lastRunAt: status.lastRunAt,
        findings: [],
        truncated: problems.truncated,
      };
      // Health failures cannot leave apparently current cached evidence visible.
      if (result.state === "current-clear" || result.state === "needs-attention") {
        for (const finding of problems.findings) {
          if (result.findings.length >= restrictedAppCheckLimits.findings) { result.truncated = true; break; }
          result.findings.push({
            id: finding.id, fingerprint: finding.fingerprint, title: finding.title,
            ...(finding.detail ? { detail: finding.detail } : {}),
            ...(finding.remediation ? { suggestion: finding.remediation } : {}),
            path: finding.targetPath, severity: finding.severity, observedAt: finding.observedAt,
            quotes: finding.evidence.flatMap((evidence) => evidence.kind === "text-span" ? [evidence.quote] : []),
          });
          if (Buffer.byteLength(JSON.stringify(result), "utf8") > restrictedAppCheckLimits.resultBytes - 32) {
            result.findings.pop(); result.truncated = true; break;
          }
        }
      }
      return result;
    });
  }

  async #status(
    registered: AmpleFileCheckConnectedFolderRef,
    knownProblems?: AmpleFileCheckProblemsResult,
    knownSnapshot?: { discovery: AmpleFileCheckDeclarationDiscovery; state: AmpleFileCheckMachineState },
  ): Promise<AmpleFileCheckStatusSnapshot> {
    const discovery = knownSnapshot?.discovery ?? await discoverAmpleFileCheckDeclarations(registered.connectedFolderRoot);
    const state = knownSnapshot?.state ?? (await this.#store(registered.id)).snapshot();
    let proposed = 0;
    let enabled = 0;
    let current = 0;
    let neverRun = 0;
    let stale = 0;
    let blocked = 0;
    let errors = discovery.errors.length;
    let needsAttention = 0;
    let lastRunAt: string | null = null;

    for (const record of discovery.declarations) {
      const authorization = exactAuthorization(state.authorizations[record.declaration.id], record);
      if (!authorization) {
        proposed += 1;
        continue;
      }
      const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
      if (!sensor || sensor.execution !== authorization.execution) {
        blocked += 1;
        continue;
      }
      if (sensor.implementationDigest !== authorization.sensorDigest) {
        blocked += 1;
        continue;
      }
      try {
        sensor.validate(record.declaration);
        await this.#assertNoNestedConnectedFolderTargets(registered, record.declaration);
      } catch {
        blocked += 1;
        continue;
      }
      enabled += 1;
      const run = latestRunForCheck(state.runs, record.declaration.id);
      if (!run) {
        neverRun += 1;
        continue;
      }
      lastRunAt = maxTimestamp(lastRunAt, run.endedAt ?? run.startedAt);
      if (run.state === "accepted" || run.state === "running") continue;
      if (run.state !== "succeeded") {
        errors += 1;
        continue;
      }
      try {
        const inputs = await resolveCurrentInputs(record, authorization, registered.connectedFolderRoot);
        if (sameSemanticInputs(inputs, run.inputs.filter((item) => item.checkId === record.declaration.id))) current += 1;
        else stale += 1;
      } catch {
        blocked += 1;
      }
    }

    try {
      needsAttention = (knownProblems ?? await this.#problems(registered, false)).findings.length;
    } catch {
      errors += 1;
    }
    const running = [...this.#active.values()].filter((run) => run.connectedFolderId === registered.id).length;
    const aggregate = aggregateState({
      configured: discovery.declarations.length,
      enabled,
      current,
      neverRun,
      stale,
      blocked,
      errors,
      needsAttention,
    });
    return {
      kind: "amplefile.checks.experimental",
      version: ampleFileCheckExperimentalSnapshotVersion,
      connectedFolderId: registered.id,
      state: aggregate,
      configured: discovery.declarations.length,
      proposed,
      enabled,
      current,
      neverRun,
      stale,
      blocked,
      errors,
      needsAttention,
      running,
      lastRunAt,
    };
  }

  async run(input: {
    connectedFolder: AmpleFileCheckConnectedFolderRef;
    checkId?: string;
    /** One explicitly reviewed run; never a standing grant or a live result. */
    trialDigest?: string;
    actor: AmpleFileActor;
    /** Stamped on the settle record so automation-caused runs never fire triggers. */
    lineage?: AmpleFileSettleLineage;
  }): Promise<{ taskId: string; runId: string; checkIds: string[] }> {
    if (this.#runReservations.has(input.connectedFolder.id) || this.hasActiveRun(input.connectedFolder.id)) {
      throw new AmpleFileCheckOperationConflictError("Wait for the current Check run in this Connected Folder to finish.");
    }
    this.#runReservations.add(input.connectedFolder.id);
    try {
    const connectedFolder = await this.#registeredConnectedFolder(input.connectedFolder);
    const trial = input.trialDigest !== undefined;
    const records = trial
      ? (await discoverAmpleFileCheckDeclarations(connectedFolder.connectedFolderRoot)).declarations.filter((record) => record.declaration.id === input.checkId && record.digest === input.trialDigest)
      : await this.#enabledRecords(connectedFolder, input.checkId);
    if (trial && records.length !== 1) throw new AmpleFileCheckOperationConflictError("This proposal changed. Refresh and review it before trying it.");
    if (!records.length) throw new Error(input.checkId ? "Enabled Check not found." : "This Connected Folder has no enabled Checks.");
    const checkIds = records.map((record) => record.declaration.id).sort();
    const state = (await this.#store(connectedFolder.id)).snapshot();
    const runGrants = records.map((record): AmpleFileCheckAuthorization => {
      if (!trial) return state.authorizations[record.declaration.id]!;
      const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
      if (!sensor) throw new Error("The proposed Check sensor is unavailable.");
      sensor.validate(record.declaration);
      return { checkId: record.declaration.id, declarationDigest: record.digest, sensorId: sensor.id,
        sensorRevision: sensor.revision, sensorDigest: sensor.implementationDigest, execution: sensor.execution,
        limits: sensor.execution === "model" ? modelCheckLimits : defaultRunLimits,
        enabledAt: this.#now().toISOString(), enabledBy: "human" };
    });
    const authorities = runGrants.map((authorization) => ({
      checkId: authorization.checkId,
      declarationDigest: authorization.declarationDigest,
      sensorId: authorization.sensorId,
      sensorRevision: authorization.sensorRevision,
      sensorDigest: authorization.sensorDigest,
    }));
    const limits = intersectLimits(runGrants.map((grant) => grant.limits));
    const taskId = this.#createTaskId();
    const runId = this.#createRunId();
    const accepted: AmpleFileCheckRunRecord = {
      id: runId,
      ...(trial ? { trial: true as const } : {}),
      taskId,
      checkIds,
      authorities,
      limits,
      startedAt: this.#now().toISOString(),
      state: "accepted",
      inputs: [],
      findings: [],
      admittedCount: 0,
      discardedCount: 0,
      skippedCount: 0,
    };
    const store = await this.#store(connectedFolder.id);
    await store.acceptRun(accepted);
    try {
      this.#kernel.startExperimentalCheckRunTask({ id: taskId, connectedFolderId: connectedFolder.id, actor: input.actor });
      await store.markRunRunning(runId);
    } catch (error) {
      this.#kernel.finishTask(taskId);
      const terminal: AmpleFileCheckRunRecord = {
        ...accepted,
        state: "failed",
        endedAt: this.#now().toISOString(),
        error: errorMessage(error),
      };
      await store.finishRun(terminal);
      this.#publishRunSettle(connectedFolder.id, terminal, input.lineage);
      throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("Check run exceeded its approved duration."), limits.timeoutMs);
    timeout.unref?.();
    const active: ActiveCheckRun = {
      connectedFolderId: connectedFolder.id,
      runId,
      checkIds,
      controller,
      promise: Promise.resolve(),
    };
    this.#active.set(taskId, active);
    active.promise = this.#execute(connectedFolder, records, accepted, controller.signal, input.lineage)
      .finally(() => {
        clearTimeout(timeout);
        if (!this.#terminalRecovery.has(taskId)) this.#finishActiveTask(taskId);
      });
    return { taskId, runId, checkIds };
    } finally {
      this.#runReservations.delete(input.connectedFolder.id);
    }
  }

  taskStatus(connectedFolderId: string, taskId: string): Promise<AmpleFileCheckTaskStatus> {
    return this.#withOperationReservation(connectedFolderId, () => this.#taskStatus(connectedFolderId, taskId));
  }

  taskResult(connectedFolderId: string, taskId: string): Promise<AmpleFileCheckRunRecord> {
    return this.#withOperationReservation(connectedFolderId, () => this.#taskResult(connectedFolderId, taskId));
  }

  async #taskResult(connectedFolderId: string, taskId: string): Promise<AmpleFileCheckRunRecord> {
    await this.#registeredConnectedFolderId(connectedFolderId);
    await this.#retryTerminalRecovery(taskId, connectedFolderId);
    const active = this.#active.get(taskId);
    if (active?.connectedFolderId === connectedFolderId) throw new Error("The Check run is still running.");
    const run = (await this.#store(connectedFolderId)).snapshot().runs.find((item) => item.taskId === taskId);
    if (!run) throw new Error("Check task not found.");
    if (run.state === "accepted" || run.state === "running") throw new Error("The Check run is still running.");
    return run;
  }

  abort(connectedFolderId: string, taskId: string): Promise<boolean> {
    return this.#withOperationReservation(connectedFolderId, () => this.#abort(connectedFolderId, taskId));
  }

  async #abort(connectedFolderId: string, taskId: string): Promise<boolean> {
    await this.#registeredConnectedFolderId(connectedFolderId);
    const active = this.#active.get(taskId);
    if (!active || active.connectedFolderId !== connectedFolderId) return false;
    active.controller.abort("Check run aborted.");
    await active.promise;
    await this.#retryTerminalRecovery(taskId, connectedFolderId);
    return true;
  }

  problems(connectedFolder: AmpleFileCheckConnectedFolderRef, checkId?: string): Promise<{
    findings: AmpleFileCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }> {
    return this.#withOperationReservation(connectedFolder.id, async () => this.#problems(await this.#registeredConnectedFolder(connectedFolder), true, checkId));
  }

  decide(input: {
    connectedFolderId: string;
    findingId: string;
    decision: AmpleFileCheckDecisionKind;
    actor: AmpleFileCheckDecision["actor"];
    deferUntil?: string;
    note?: string;
  }): Promise<AmpleFileCheckDecision> {
    return this.#withOperationReservation(input.connectedFolderId, async () => {
      const connectedFolder = await this.#registeredConnectedFolderById(input.connectedFolderId);
      const store = await this.#store(input.connectedFolderId);
      const finding = store.snapshot().runs.filter((run) => !run.trial).flatMap((run) => run.findings).find((item) => item.id === input.findingId);
      if (!finding) throw new Error("Finding not found.");
      if (finding.status !== "active") {
        throw new AmpleFileCheckOperationConflictError("This finding is no longer active. Refresh Checks and try again.");
      }
      const now = this.#now();
      if (input.decision === "defer") {
        const deferredUntil = input.deferUntil ? Date.parse(input.deferUntil) : Number.NaN;
        if (!Number.isFinite(deferredUntil) || deferredUntil <= now.getTime()) {
          throw new Error("A deferred finding requires a future deferUntil timestamp.");
        }
      }
      const discovery = await discoverAmpleFileCheckDeclarations(connectedFolder.connectedFolderRoot);
      const record = discovery.declarations.find((item) => item.declaration.id === finding.checkId);
      const state = store.snapshot();
      const authorization = record ? exactAuthorization(state.authorizations[finding.checkId], record) : null;
      const sensor = record
        ? this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision)
        : null;
      if (!record || record.digest !== finding.declarationDigest || !authorization
        || !sensor || sensor.execution !== authorization.execution
        || sensor.implementationDigest !== authorization.sensorDigest
        || finding.sensorDigest !== authorization.sensorDigest) {
        throw new AmpleFileCheckOperationConflictError("This finding is no longer current. Refresh Checks and try again.");
      }
      try {
        sensor.validate(record.declaration);
        await this.#assertNoNestedConnectedFolderTargets(connectedFolder, record.declaration);
        if (!await reverifyAmpleFileCheckFinding(connectedFolder.connectedFolderRoot, record.declaration, finding)) {
          await store.invalidateFinding(
            finding.fingerprint,
            "The designated evidence changed or no longer proves this finding.",
            now,
          );
          throw new AmpleFileCheckOperationConflictError("This finding is no longer current. Refresh Checks and try again.");
        }
      } catch (error) {
        if (error instanceof AmpleFileCheckOperationConflictError) throw error;
        throw new AmpleFileCheckOperationConflictError("This finding could not be re-verified. Refresh Checks and try again.");
      }
      try {
        return await store.decide({
          fingerprint: finding.fingerprint,
          findingId: finding.id,
          decision: input.decision,
          actor: input.actor,
          ...(input.deferUntil ? { deferUntil: input.deferUntil } : {}),
          ...(input.note ? { note: input.note } : {}),
          now,
        });
      } catch (error) {
        if (/no longer active/.test(errorMessage(error))) {
          throw new AmpleFileCheckOperationConflictError("This finding is no longer current. Refresh Checks and try again.");
        }
        throw error;
      }
    });
  }

  hasActiveRun(connectedFolderId?: string): boolean {
    return this.#connectedFolderRegistryMutationReserved
      || [...this.#active.values()].some((run) => connectedFolderId === undefined || run.connectedFolderId === connectedFolderId)
      || [...this.#runReservations].some((id) => connectedFolderId === undefined || id === connectedFolderId)
      || [...this.#operationReservations].some((id) => connectedFolderId === undefined || id === connectedFolderId)
      || [...this.#connectedFolderRemovalReservations].some((id) => connectedFolderId === undefined || id === connectedFolderId);
  }

  async close(): Promise<void> {
    for (const active of this.#active.values()) active.controller.abort("AmpleFile is closing.");
    await Promise.allSettled([...this.#active.values()].map((active) => active.promise));
    await Promise.allSettled([...this.#terminalRecovery.keys()].map((taskId) => this.#retryTerminalRecovery(taskId)));
    await Promise.allSettled([...this.#stores.values()].map(async (store) => (await store).flush()));
  }

  async #execute(
    connectedFolder: AmpleFileCheckConnectedFolderRef,
    records: AmpleFileCheckDeclarationRecord[],
    accepted: AmpleFileCheckRunRecord,
    signal: AbortSignal,
    lineage?: AmpleFileSettleLineage,
  ): Promise<void> {
    const store = await this.#store(connectedFolder.id);
    const findings: AmpleFileCheckFinding[] = [];
    const inputs: AmpleFileCheckRunRecord["inputs"] = [];
    let discardedCount = 0;
    let skippedCount = 0;
    let usedFiles = 0;
    let usedBytes = 0;
    let cost: AmpleFileCheckRunRecord["cost"];
    let terminal: AmpleFileCheckRunRecord;
    try {
      const currentRecords = new Map(
        (await discoverAmpleFileCheckDeclarations(connectedFolder.connectedFolderRoot)).declarations
          .map((record) => [record.declaration.id, record]),
      );
      for (const record of records) {
        throwIfAborted(signal);
        const current = currentRecords.get(record.declaration.id);
        if (!current || current.digest !== record.digest) throw new Error("Check authority changed before the run started.");
        const state = store.snapshot();
        const authorization = accepted.trial
          ? accepted.authorities.find((authority) => authority.checkId === record.declaration.id && authority.declarationDigest === record.digest)
          : exactAuthorization(state.authorizations[record.declaration.id], record);
        if (!authorization) throw new Error("Check authority changed before the run started.");
        const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
        if (!sensor || ("execution" in authorization && sensor.execution !== authorization.execution) || sensor.implementationDigest !== authorization.sensorDigest) {
          throw new Error("The exact enabled sensor implementation is unavailable.");
        }
        sensor.validate(record.declaration);
        await this.#assertNoNestedConnectedFolderTargets(connectedFolder, record.declaration);
        const remainingFiles = accepted.limits.maximumFiles - usedFiles;
        const remainingBytes = accepted.limits.maximumTotalBytes - usedBytes;
        if (remainingFiles < 1 || remainingBytes < 0) throw new Error("Check run exhausted its approved input budget.");
        const resolution = await resolveAmpleFileCheckTargets(connectedFolder.connectedFolderRoot, record.declaration.targets, {
          limits: {
            maxFiles: remainingFiles,
            maxFileBytes: accepted.limits.maximumFileBytes,
            maxTotalBytes: Math.max(1, remainingBytes),
          },
          signal,
        });
        const resolvedCount = resolution.files.length + resolution.missingExactTargets.length;
        if (resolvedCount > remainingFiles) throw new Error("Check run exceeded its approved input count.");
        if (resolution.totalBytes > remainingBytes) throw new Error("Check run exceeded its approved total-byte budget.");
        usedFiles += resolvedCount;
        usedBytes += resolution.totalBytes;
        const snapshots = sensor.execution === "model" ? await loadCheckTextSnapshots(connectedFolder.connectedFolderRoot, resolution, signal) : undefined;
        const runnerInputs = runnerOwnedInputs(record.declaration.id, resolution, snapshots);
        inputs.push(...runnerInputs);
        throwIfAborted(signal);
        const result = await withAbort(sensor.run({
          declaration: record.declaration,
          inputs: { ...closedSensorInputs(resolution), ...(snapshots ? { snapshots } : {}) },
          signal,
        }), signal);
        if (result.cost) cost = { model: result.cost.model, inputTokens: (cost?.inputTokens ?? 0) + (result.cost.inputTokens ?? 0), outputTokens: (cost?.outputTokens ?? 0) + (result.cost.outputTokens ?? 0), amountUsd: (cost?.amountUsd ?? 0) + (result.cost.amountUsd ?? 0) };
        if (snapshots && !sameSemanticInputs(runnerInputs, await resolveCurrentInputs(record, { ...authorization, execution: sensor.execution, limits: accepted.limits }, connectedFolder.connectedFolderRoot))) throw new Error("Review inputs changed during the model request. Run the Check again.");
        skippedCount += result.skippedCount;
        if (skippedCount > 0) throw new Error("Check sensor skipped designated input; the run is incomplete.");
        const remainingFindings = accepted.limits.maximumFindings - findings.length;
        if (result.candidates.length > remainingFindings) throw new Error("Check sensor exceeded the accepted run finding limit.");
        for (const candidate of result.candidates) {
          throwIfAborted(signal);
          const finding = await admitAmpleFileCheckCandidate({
            root: connectedFolder.connectedFolderRoot,
            declaration: record.declaration,
            declarationDigest: record.digest,
            sensorDigest: authorization.sensorDigest,
            candidate,
            now: this.#now(),
            signal,
          });
          if (finding) findings.push(finding);
          else {
            discardedCount += 1;
            throw new Error("Check evidence could not be independently re-verified; the run is incomplete.");
          }
        }
      }
      throwIfAborted(signal);
      terminal = {
        ...accepted,
        state: "succeeded",
        endedAt: this.#now().toISOString(),
        inputs,
        ...(cost ? { cost } : {}),
        findings,
        admittedCount: findings.length,
        discardedCount,
        skippedCount,
      };
    } catch (error) {
      const aborted = signal.aborted;
      terminal = {
        ...accepted,
        state: aborted ? "aborted" : "failed",
        endedAt: this.#now().toISOString(),
        inputs,
        ...(cost ? { cost } : {}),
        findings: [],
        admittedCount: 0,
        discardedCount,
        skippedCount,
        error: aborted ? String(signal.reason || "Check run aborted.") : errorMessage(error),
      };
    }
    try {
      await store.finishRun(terminal);
    } catch {
      // Fail closed: retain the internal task and capability lock until the
      // exact terminal record can be made durable or process restart marks the
      // run interrupted. Polling/result calls retry this write, and the settle
      // signal waits with it — a settle is published only once its terminal
      // record is durable.
      this.#terminalRecovery.set(accepted.taskId, {
        connectedFolderId: connectedFolder.id,
        store,
        run: terminal,
        ...(lineage ? { lineage } : {}),
      });
      return;
    }
    this.#publishRunSettle(connectedFolder.id, terminal, lineage);
  }

  async #enabledRecords(connectedFolder: AmpleFileCheckConnectedFolderRef, checkId?: string): Promise<AmpleFileCheckDeclarationRecord[]> {
    const discovery = await discoverAmpleFileCheckDeclarations(connectedFolder.connectedFolderRoot);
    const store = await this.#store(connectedFolder.id);
    const state = store.snapshot();
    return discovery.declarations.filter((record) => {
      if (checkId && record.declaration.id !== checkId) return false;
      const authorization = exactAuthorization(state.authorizations[record.declaration.id], record);
      if (!authorization) return false;
      const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
      if (!sensor || sensor.execution !== authorization.execution || sensor.implementationDigest !== authorization.sensorDigest) return false;
      sensor.validate(record.declaration);
      return true;
    });
  }

  async #problems(
    connectedFolder: AmpleFileCheckConnectedFolderRef,
    persistInvalidation: boolean,
    checkId?: string,
    knownDiscovery?: AmpleFileCheckDeclarationDiscovery,
  ): Promise<{
    findings: AmpleFileCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }> {
    const discovery = knownDiscovery ?? await discoverAmpleFileCheckDeclarations(connectedFolder.connectedFolderRoot);
    const declarations = new Map(discovery.declarations.map((record) => [record.declaration.id, record]));
    const store = await this.#store(connectedFolder.id);
    const state = store.snapshot();
    const decisions = state.decisions;
    const seen = new Set<string>();
    const findings: AmpleFileCheckFinding[] = [];
    const healthErrors: string[] = discovery.errors.map(() => "A Check declaration could not be read.");
    const nestedConnectedFolderBlocked = new Set<string>();
    for (const record of discovery.declarations) {
      try {
        await this.#assertNoNestedConnectedFolderTargets(connectedFolder, record.declaration);
      } catch {
        nestedConnectedFolderBlocked.add(record.declaration.id);
        healthErrors.push("A Check target now overlaps another registered Connected Folder.");
      }
    }
    let invalidated = 0;
    let truncated = false;
    for (const finding of state.runs.filter((run) => !run.trial).flatMap((run) => run.findings)) {
      if (checkId && finding.checkId !== checkId) continue;
      if (finding.status !== "active" || seen.has(finding.fingerprint)) continue;
      seen.add(finding.fingerprint);
      const record = declarations.get(finding.checkId);
      if (nestedConnectedFolderBlocked.has(finding.checkId)) continue;
      if (!record || record.digest !== finding.declarationDigest || !exactAuthorization(state.authorizations[finding.checkId], record)) continue;
      const authorization = state.authorizations[finding.checkId]!;
      const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
      if (!sensor || sensor.implementationDigest !== authorization.sensorDigest || finding.sensorDigest !== authorization.sensorDigest) continue;
      let current = false;
      try {
        current = await reverifyAmpleFileCheckFinding(connectedFolder.connectedFolderRoot, record.declaration, finding);
      } catch {
        healthErrors.push("A finding could not be re-verified against its designated target.");
        continue;
      }
      if (!current) {
        invalidated += 1;
        if (persistInvalidation) await store.invalidateFinding(finding.fingerprint, "The designated evidence changed or no longer proves this finding.", this.#now());
        continue;
      }
      const decision = decisions[finding.fingerprint];
      if (decision?.decision === "reject" || decision?.decision === "resolve") continue;
      if (decision?.decision === "defer" && decision.deferUntil && Date.parse(decision.deferUntil) > this.#now().getTime()) continue;
      findings.push(finding);
    }
    return { findings, invalidated, healthErrors, truncated };
  }

  async #rendererAuthorityState(
    connectedFolder: AmpleFileCheckConnectedFolderRef,
    record: AmpleFileCheckDeclarationRecord,
    savedAuthorization: AmpleFileCheckAuthorization | undefined,
  ): Promise<AmpleFileCheckRendererAuthorityState> {
    if (!savedAuthorization) return "proposed";
    const authorization = exactAuthorization(savedAuthorization, record);
    if (!authorization) return "blocked";
    const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
    if (!sensor
      || sensor.execution !== authorization.execution
      || sensor.implementationDigest !== authorization.sensorDigest) {
      return "blocked";
    }
    try {
      sensor.validate(record.declaration);
      await this.#assertNoNestedConnectedFolderTargets(connectedFolder, record.declaration);
      return "enabled";
    } catch {
      return "blocked";
    }
  }

  async #taskStatus(connectedFolderId: string, taskId: string): Promise<AmpleFileCheckTaskStatus> {
    await this.#registeredConnectedFolderId(connectedFolderId);
    await this.#retryTerminalRecovery(taskId, connectedFolderId);
    const run = (await this.#store(connectedFolderId)).snapshot().runs.find((item) => item.taskId === taskId);
    if (!run) return { taskId, runId: null, state: "unknown", startedAt: null, endedAt: null, error: null };
    return {
      taskId,
      runId: run.id,
      state: this.#active.has(taskId) ? "running" : run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      error: run.error ?? null,
    };
  }

  #store(connectedFolderId: string): Promise<AmpleFileCheckStore> {
    const existing = this.#stores.get(connectedFolderId);
    if (existing) return existing;
    const created = this.#storeFactory(connectedFolderId);
    this.#stores.set(connectedFolderId, created);
    void created.catch(() => {
      if (this.#stores.get(connectedFolderId) === created) this.#stores.delete(connectedFolderId);
    });
    return created;
  }

  async #withOperationReservation<T>(connectedFolderId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#connectedFolderRegistryMutationReserved
      || this.#connectedFolderRemovalReservations.has(connectedFolderId)
      || this.#operationReservations.has(connectedFolderId)) {
      throw new AmpleFileCheckOperationConflictError();
    }
    this.#operationReservations.add(connectedFolderId);
    try {
      return await operation();
    } finally {
      this.#operationReservations.delete(connectedFolderId);
    }
  }

  async #registeredConnectedFolder(input: AmpleFileCheckConnectedFolderRef): Promise<AmpleFileCheckConnectedFolderRef> {
    const match = (await this.#listConnectedFolders()).find((connectedFolder) => connectedFolder.id === input.id);
    if (!match) throw new Error("Registered Connected Folder not found.");
    if (resolve(match.connectedFolderRoot) !== resolve(input.connectedFolderRoot)) {
      throw new Error("The Check request does not match the registered Connected Folder's folder.");
    }
    return { id: match.id, connectedFolderRoot: match.connectedFolderRoot };
  }

  async #registeredConnectedFolderId(connectedFolderId: string): Promise<void> {
    await this.#registeredConnectedFolderById(connectedFolderId);
  }

  async #registeredConnectedFolderById(connectedFolderId: string): Promise<AmpleFileCheckConnectedFolderRef> {
    const connectedFolder = (await this.#listConnectedFolders()).find((item) => item.id === connectedFolderId);
    if (!connectedFolder) throw new Error("Registered Connected Folder not found.");
    return { id: connectedFolder.id, connectedFolderRoot: connectedFolder.connectedFolderRoot };
  }

  async #retryTerminalRecovery(taskId: string, connectedFolderId?: string): Promise<boolean> {
    const recovery = this.#terminalRecovery.get(taskId);
    if (!recovery) return true;
    if (connectedFolderId && recovery.connectedFolderId !== connectedFolderId) return false;
    try {
      await recovery.store.finishRun(recovery.run);
    } catch {
      return false;
    }
    this.#terminalRecovery.delete(taskId);
    this.#finishActiveTask(taskId);
    this.#publishRunSettle(recovery.connectedFolderId, recovery.run, recovery.lineage);
    return true;
  }

  /**
   * The host notification behind `bridge.checks.onChanged`. Ids only, and the
   * listener's failure is contained here the way the settle signal contains
   * its own: publishing a change can never fail the Check operation that
   * produced it.
   */
  #publishResultChanged(connectedFolderId: string, checkIds: readonly string[]): void {
    if (!this.#onResultChanged || !checkIds.length) return;
    try { this.#onResultChanged({ connectedFolderId, checkIds: [...new Set(checkIds)] }); }
    catch { /* a host listener never fails a Check operation */ }
  }

  #finishActiveTask(taskId: string): void {
    if (!this.#active.delete(taskId)) return;
    this.#kernel.finishTask(taskId);
  }

  /**
   * Terminal-persistence funnel exit for the automation-trigger seam: called only
   * after the exact terminal run record is durable, exactly once per run. The
   * signal owns listener failure isolation, so publication can never fail a
   * Check run; a malformed non-terminal record is dropped rather than
   * published.
   */
  #publishRunSettle(connectedFolderId: string, run: AmpleFileCheckRunRecord, lineage?: AmpleFileSettleLineage): void {
    if (run.trial) return;
    // A settled run is the moment a selected result changes, so the app hint
    // leaves from the same funnel. It is published before the automation seam so
    // a slow automation consumer cannot delay a view's re-read, and independently
    // of whether a settle signal is configured at all.
    if (run.state !== "accepted" && run.state !== "running" && run.endedAt) {
      this.#publishResultChanged(connectedFolderId, run.checkIds);
    }
    if (!this.#settleSignal) return;
    if (run.state === "accepted" || run.state === "running" || !run.endedAt) return;
    this.#settleSignal.publish({
      kind: "check-run",
      connectedFolderId,
      runId: run.id,
      taskId: run.taskId,
      checkIds: [...run.checkIds],
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      ...(lineage ? { lineage } : {}),
    });
  }

  async #assertNoNestedConnectedFolderTargets(connectedFolder: AmpleFileCheckConnectedFolderRef, declaration: AmpleFileCheckDeclaration): Promise<void> {
    const root = resolve(connectedFolder.connectedFolderRoot);
    const nestedRoots = (await this.#listConnectedFolders())
      .filter((item) => item.id !== connectedFolder.id)
      .map((item) => relative(root, resolve(item.connectedFolderRoot)))
      .filter((path) => path && path !== ".." && !path.startsWith(`..${sep}`))
      .map((path) => path.split(sep).join("/"));
    for (const target of declaration.targets) {
      const overlaps = nestedRoots.some((nested) => target.kind === "file"
        ? target.path === nested || target.path.startsWith(`${nested}/`)
        : target.path === nested || target.path.startsWith(`${nested}/`) || nested.startsWith(`${target.path}/`));
      if (overlaps) throw new Error("A Check target cannot enter another registered Connected Folder.");
    }
  }
}

function exactAuthorization(
  authorization: AmpleFileCheckAuthorization | undefined,
  record: AmpleFileCheckDeclarationRecord,
): AmpleFileCheckAuthorization | null {
  if (!authorization) return null;
  return authorization.declarationDigest === record.digest
    && authorization.sensorId === record.declaration.sensor.id
    && authorization.sensorRevision === record.declaration.sensor.revision
    ? authorization
    : null;
}

function proposalDeclarationIdentity(proposal: AmpleFileCheckProposal): string {
  return ampleFileCheckDigest({
    ...proposal.check,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
  });
}

function declarationIdentity(declaration: AmpleFileCheckDeclaration): string {
  return ampleFileCheckDigest({
    title: declaration.title,
    severity: declaration.severity,
    trigger: declaration.trigger,
    sensor: declaration.sensor,
    targets: declaration.targets,
    createdBy: declaration.createdBy,
    createdAt: declaration.createdAt,
  });
}

async function resolveCurrentInputs(
  record: AmpleFileCheckDeclarationRecord,
  authorization: Pick<AmpleFileCheckAuthorization, "limits" | "execution">,
  root: string,
): Promise<AmpleFileCheckRunRecord["inputs"]> {
  const resolution = await resolveAmpleFileCheckTargets(root, record.declaration.targets, {
    limits: {
      maxFiles: authorization.limits.maximumFiles,
      maxFileBytes: authorization.limits.maximumFileBytes,
      maxTotalBytes: authorization.limits.maximumTotalBytes,
    },
  });
  const snapshots = authorization.execution === "model" ? await loadCheckTextSnapshots(root, resolution) : undefined;
  return runnerOwnedInputs(record.declaration.id, resolution, snapshots);
}

function runnerOwnedInputs(checkId: string, resolution: AmpleFileCheckTargetResolution, snapshots?: AmpleFileCheckTextSnapshot[]): AmpleFileCheckRunRecord["inputs"] {
  return [
    ...resolution.files.map((file) => ({ checkId, path: file.path, state: "file" as const, size: file.sizeBytes, ...(snapshots ? { sha256: snapshots.find((snapshot) => snapshot.path === file.path)!.sha256 } : {}) })),
    ...resolution.missingExactTargets.map((target) => ({ checkId, path: target.path, state: "missing" as const })),
  ].sort((left, right) => left.path.localeCompare(right.path, "en-US"));
}

function closedSensorInputs(resolution: AmpleFileCheckTargetResolution) {
  return {
    files: resolution.files.map(({ path, sizeBytes }) => ({ path, sizeBytes })),
    missingExactTargets: resolution.missingExactTargets.map(({ path }) => ({ path })),
  };
}

function sameSemanticInputs(
  left: AmpleFileCheckRunRecord["inputs"],
  right: AmpleFileCheckRunRecord["inputs"],
): boolean {
  const normalize = (values: AmpleFileCheckRunRecord["inputs"]) => values
    .map(({ checkId, path, state, sha256 }) => ({ checkId, path, state, sha256: sha256 ?? null }))
    .sort((a, b) => a.checkId.localeCompare(b.checkId) || a.path.localeCompare(b.path));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function latestRunForCheck(runs: AmpleFileCheckRunRecord[], checkId: string): AmpleFileCheckRunRecord | null {
  return runs.find((run) => !run.trial && run.checkIds.includes(checkId)) ?? null;
}

function intersectLimits(values: AmpleFileCheckRunLimits[]): AmpleFileCheckRunLimits {
  if (!values.length) return structuredClone(defaultRunLimits);
  return {
    maximumFiles: Math.min(...values.map((item) => item.maximumFiles)),
    maximumFileBytes: Math.min(...values.map((item) => item.maximumFileBytes)),
    maximumTotalBytes: Math.min(...values.map((item) => item.maximumTotalBytes)),
    maximumFindings: Math.min(...values.map((item) => item.maximumFindings)),
    timeoutMs: Math.min(...values.map((item) => item.timeoutMs)),
  };
}

function aggregateState(input: {
  configured: number;
  enabled: number;
  current: number;
  neverRun: number;
  stale: number;
  blocked: number;
  errors: number;
  needsAttention: number;
}): AmpleFileCheckAggregateState {
  if (input.errors) return "check-error";
  if (input.blocked) return "blocked";
  if (!input.configured || !input.enabled) return "not-configured";
  if (input.needsAttention) return "needs-attention";
  if (input.neverRun || input.stale || input.current < input.enabled) return "stale";
  return "current-clear";
}

function maxTimestamp(left: string | null, right: string): string {
  return !left || right > left ? right : left;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(String(signal.reason || "Check run aborted."));
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Error(String(signal.reason || "Check run aborted.")));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Check run failed.");
}
