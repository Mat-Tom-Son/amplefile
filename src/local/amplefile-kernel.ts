import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
  loadAgentSkillCatalog,
  type PiCatalogSource,
  type PiResourceCatalog,
} from "./agent/skill-catalog.js";
import { folderParentIds } from "../shared/folder-nesting.js";
import type { PiSurfaceBlock } from "./agent/surface-manifest.js";
import {
  isPiProjectMutationTrusted,
  listPiPackages,
  type PiConfiguredPackage,
  type PiRuntimeProvider,
} from "./agent/pi-runtime-config.js";
import {
  getConnectedFolder,
  listConnectedFolders,
  type ConnectedFolderLocation,
  type ConnectedFolderSummary,
} from "./connected-folder.js";
import {
  composeAmpleFileOverview,
  type AmpleFileOverviewSnapshot,
  type AmpleFileOverviewSourceReaders,
  type AmpleFileOverviewTaskRecord,
} from "./overview.js";

export const ampleFileKernelSnapshotVersion = 1 as const;

export type AmpleFileActorKind = "human" | "assistant" | "cli" | "renderer" | "extension" | "app" | "system";

export interface AmpleFileActor {
  kind: AmpleFileActorKind;
  cwd?: string;
  connectedFolderId?: string;
  conversationId?: string;
}

export interface AmpleFileConnectedFolderSnapshot {
  id: string;
  name: string;
  connectedFolderRoot: string;
  location: ConnectedFolderLocation;
  createdAt: string;
  updatedAt: string;
  /**
   * The nearest registered Connected Folder whose folder contains this one (2026-10-01).
   * Present only in the connected-folders list and only for a nested Connected Folder; additive to
   * the v1 snapshot, so a top-level Connected Folder's shape is unchanged.
   */
  parentConnectedFolderId?: string;
}

export interface AmpleFileContextSnapshot {
  kind: "amplefile.context";
  version: typeof ampleFileKernelSnapshotVersion;
  actor: AmpleFileActor;
  resolution: "connected-folder_id" | "cwd" | "none";
  connectedFolder: AmpleFileConnectedFolderSnapshot | null;
}

export interface AmpleFileConnectedFoldersSnapshot {
  kind: "amplefile.connected-folders";
  version: typeof ampleFileKernelSnapshotVersion;
  actor: AmpleFileActor;
  connectedFolders: AmpleFileConnectedFolderSnapshot[];
}

export type AmpleFileTaskKind = "assistant_turn" | "compaction";

export interface AmpleFileTaskSnapshot {
  id: string;
  kind: AmpleFileTaskKind;
  status: "running";
  connectedFolderId: string;
  conversationId?: string;
  actor: AmpleFileActor;
  startedAt: string;
}

export interface AmpleFileTaskInput {
  id?: string;
  kind: AmpleFileTaskKind;
  connectedFolderId: string;
  conversationId?: string;
  actor: AmpleFileActor;
}

/**
 * Experimental internal task shape for one prepared-act execution: the
 * mutation a receipted verb that installs code, widens a power, or destroys
 * data performs through the prepared-act path (src/local/prepared-acts.ts,
 * docs/receipts-not-gates.md). It is deliberately separate from
 * AmpleFileTaskKind and must not enter the stable
 * `amplefile.tasks` v1 projection. A Connected Folder id is present only when the
 * execution mutates one Connected Folder; Everywhere-scope and machine-scope
 * executions carry none.
 */
export interface AmpleFileExperimentalPreparedActTaskInput {
  id?: string;
  connectedFolderId?: string;
  /** The journaled act request whose execution this task tracks. */
  requestId: string;
  /** The prepared-act kind being performed. */
  kind: string;
  actor: AmpleFileActor;
}

export interface AmpleFileExperimentalPreparedActTask {
  id: string;
  kind: "prepared_act";
  status: "running";
  connectedFolderId: string | null;
  requestId: string;
  actKind: string;
  actor: AmpleFileActor;
  startedAt: string;
}

/**
 * Experimental internal task shape for one automation run (docs/automations.md).
 * Like `prepared_act`, it is deliberately separate from
 * AmpleFileTaskKind and must not enter the stable `amplefile.tasks` v1
 * projection. An automation run is cross–Connected Folder glue, so it carries no
 * Connected Folder id; the overview
 * renders automation runs from their own receipts source, never from this task.
 */
export interface AmpleFileExperimentalAutomationRunTaskInput {
  id?: string;
  automationId: string;
  runId: string;
  actor: AmpleFileActor;
}

export interface AmpleFileExperimentalAutomationRunTask {
  id: string;
  kind: "automation_run";
  status: "running";
  automationId: string;
  runId: string;
  actor: AmpleFileActor;
  startedAt: string;
}

/**
 * Experimental internal task shape for one running background job
 * (docs/background-jobs.md, F31). Like `prepared_act`, it is deliberately
 * separate from AmpleFileTaskKind and must not enter the stable
 * `amplefile.tasks` v1 projection; `jobs list` is its public read. The id is
 * the job id. A Connected Folder id is absent for the AmpleFile agent's own jobs.
 */
export interface AmpleFileExperimentalJobTaskInput {
  jobId: string;
  name: string;
  connectedFolderId?: string;
  conversationId: string;
  actor: AmpleFileActor;
}

export interface AmpleFileExperimentalJobTask {
  id: string;
  kind: "job";
  status: "running";
  name: string;
  connectedFolderId: string | null;
  conversationId: string;
  actor: AmpleFileActor;
  startedAt: string;
}

export interface AmpleFileTasksSnapshot {
  kind: "amplefile.tasks";
  version: typeof ampleFileKernelSnapshotVersion;
  actor: AmpleFileActor;
  connectedFolderId: string | null;
  tasks: AmpleFileTaskSnapshot[];
}

/**
 * Injected readers for the whole–Connected Folder History-restore fence
 * (docs/act-ledger.md, conflict rule 7). The kernel's own task registry
 * is the record of which automation runs are active; these readers resolve what
 * an active run means for one Connected Folder. Both follow the overview-source pattern:
 * the owning application host wires them over its live services.
 */
export interface AmpleFileHistoryRestoreFenceSources {
  /**
   * Connected Folder ids the automation's declared files hops copy into (`toConnectedFolder`), or
   * null when the automation's declaration cannot be found. Absent reader and
   * null/failed reads fail closed: an active automation run whose hops cannot
   * be verified blocks the restore rather than racing it.
   */
  automationRunFilesHopTargets?(automationId: string): Promise<string[] | null>;
  /**
   * Active (accepted, not yet settled) restricted-app automation runs whose
   * app holds a file grant into the named Connected Folder. The owning host wires it
   * over the restricted-app registry's machine-wide accessor
   * (`listActiveAutomationRuns` in
   * `src/local/agent/restricted-app-service.ts`); a run whose grants cannot
   * be resolved is included by that wiring rather than dropped, and a
   * configured reader that fails blocks the restore (fail closed). An absent
   * reader is absence of evidence, unlike an active automation-run task the
   * kernel can already see.
   */
  appAutomationRunsWithFileGrantInto?(connectedFolderId: string): Promise<Array<{
    appId: string;
    appAutomationId: string;
    runId: string;
  }>>;
}

export type AmpleFileCapabilityScope = "global" | "project" | "temporary";
export type AmpleFileCapabilityOrigin = "package" | "top-level";
export type AmpleFileCapabilityStatus = "loaded";

export interface AmpleFileCapabilityProvenance {
  label: string;
  source: string;
  path: string;
  scope: AmpleFileCapabilityScope;
  origin: AmpleFileCapabilityOrigin;
  baseDir?: string;
  packageSource?: string;
}

export interface AmpleFileCapabilityTrustSnapshot {
  required: boolean;
  trusted: boolean;
  savedDecision: boolean | null;
  mutationTrusted: boolean;
}

export interface AmpleFilePackageSnapshot {
  source: string;
  scope: "global" | "project";
  filtered: boolean;
  installedPath?: string;
  installed: boolean;
  loaded: boolean;
}

interface AmpleFileLoadedCapabilitySnapshot {
  source: string;
  scope: AmpleFileCapabilityScope;
  origin: AmpleFileCapabilityOrigin;
  packageSource?: string;
  sourceInfo: AmpleFileCapabilityProvenance;
  provenance: AmpleFileCapabilityProvenance;
  enabled: true;
  loaded: true;
  status: AmpleFileCapabilityStatus;
}

export interface AmpleFileSkillSnapshot extends AmpleFileLoadedCapabilitySnapshot {
  name: string;
  description: string;
  path: string;
  content?: string;
  disableModelInvocation?: true;
}

export interface AmpleFileExtensionSnapshot extends AmpleFileLoadedCapabilitySnapshot {
  id: string;
  name: string;
  path: string;
  commands: string[];
  tools: string[];
  flags: string[];
}

export interface AmpleFileExtensionSurfaceSnapshot extends AmpleFileLoadedCapabilitySnapshot {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  extensionPath: string;
  manifestPath: string;
  views: PiResourceCatalog["surfaces"][number]["views"];
}

export interface AmpleFileToolSnapshot extends AmpleFileLoadedCapabilitySnapshot {
  name: string;
  label: string;
  description: string;
  active: boolean;
  kind: "core" | "extension";
  core: boolean;
  configurable: false;
  configurationScope: "chat";
}

export interface AmpleFilePromptSnapshot extends AmpleFileLoadedCapabilitySnapshot {
  name: string;
  description: string;
  argumentHint?: string;
  path: string;
}

export interface AmpleFileThemeSnapshot {
  name: string;
  path?: string;
  source?: string;
  scope?: AmpleFileCapabilityScope;
  origin?: AmpleFileCapabilityOrigin;
  packageSource?: string;
  sourceInfo?: AmpleFileCapabilityProvenance;
  provenance?: AmpleFileCapabilityProvenance;
  enabled: true;
  loaded: true;
  status: AmpleFileCapabilityStatus;
}

export interface AmpleFileCommandSnapshot {
  name: string;
  description?: string;
  kind: "builtin" | "extension" | "prompt" | "skill";
  source: string;
  scope?: AmpleFileCapabilityScope;
  origin?: AmpleFileCapabilityOrigin;
  packageSource?: string;
  sourceInfo?: AmpleFileCapabilityProvenance;
  provenance?: AmpleFileCapabilityProvenance;
  enabled: true;
  loaded: true;
  status: AmpleFileCapabilityStatus;
}

export interface AmpleFileCapabilityDiagnosticSnapshot {
  type: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface AmpleFileCapabilityCatalogSnapshot {
  resources?: PiResourceCatalog["resources"];
  projectTrust: AmpleFileCapabilityTrustSnapshot;
  trust: AmpleFileCapabilityTrustSnapshot;
  projectTrusted: boolean;
  packages: AmpleFilePackageSnapshot[];
  toolManagement: PiResourceCatalog["toolManagement"];
  skills: AmpleFileSkillSnapshot[];
  extensions: AmpleFileExtensionSnapshot[];
  surfaces: AmpleFileExtensionSurfaceSnapshot[];
  tools: AmpleFileToolSnapshot[];
  prompts: AmpleFilePromptSnapshot[];
  themes: AmpleFileThemeSnapshot[];
  commands: AmpleFileCommandSnapshot[];
  diagnostics: AmpleFileCapabilityDiagnosticSnapshot[];
}

export interface AmpleFileCapabilitiesSnapshot {
  kind: "amplefile.capabilities";
  version: typeof ampleFileKernelSnapshotVersion;
  actor: AmpleFileActor;
  connectedFolder: AmpleFileConnectedFolderSnapshot;
  catalog: AmpleFileCapabilityCatalogSnapshot;
}

export interface AmpleFileKernelOptions {
  runtimeProvider?: PiRuntimeProvider;
  listConnectedFolders?: () => Promise<ConnectedFolderSummary[]>;
  getConnectedFolder?: (connectedFolderId: string) => Promise<ConnectedFolderSummary>;
  loadCapabilityCatalog?: (connectedFolderRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<PiResourceCatalog>;
  listPackages?: (connectedFolderRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<PiConfiguredPackage[]>;
  isProjectMutationTrusted?: (connectedFolderRoot: string, runtimeProvider?: PiRuntimeProvider) => Promise<boolean>;
  /**
   * Injected overview source readers, exactly as `listConnectedFolders` and
   * `loadCapabilityCatalog` are today. The kernel always supplies its own task
   * registry as the running-task source; an absent reader renders its overview
   * kinds as absent.
   */
  overviewSources?: AmpleFileOverviewSourceReaders;
  /** Reads the per-surface seen markers. The kernel never writes them. */
  readOverviewSeen?: () => Promise<Record<string, string>>;
  /** Injected History-restore fence readers; see the interface's fail-closed rules. */
  historyRestoreFenceSources?: AmpleFileHistoryRestoreFenceSources;
  now?: () => Date;
  createTaskId?: () => string;
}

export class AmpleFileContextRequiredError extends Error {
  readonly code = "AMPLEFILE_CONTEXT_REQUIRED";

  constructor() {
    super("A Connected Folder must be selected explicitly or resolved from the actor's current directory.");
    this.name = "AmpleFileContextRequiredError";
  }
}

/**
 * Reusable in-process authority for the read-only Connected Folder control plane.
 * HTTP, CLI, and agent adapters consume the same typed snapshots while
 * mutation policy remains in the owning domain services.
 */
export class AmpleFileKernel {
  readonly #runtimeProvider?: PiRuntimeProvider;
  readonly #listConnectedFolders: () => Promise<ConnectedFolderSummary[]>;
  readonly #getConnectedFolder: (connectedFolderId: string) => Promise<ConnectedFolderSummary>;
  readonly #loadCapabilityCatalog: AmpleFileKernelOptions["loadCapabilityCatalog"] & {};
  readonly #listPackages: AmpleFileKernelOptions["listPackages"] & {};
  readonly #isProjectMutationTrusted: AmpleFileKernelOptions["isProjectMutationTrusted"] & {};
  #overviewSources: AmpleFileOverviewSourceReaders;
  #readOverviewSeen?: () => Promise<Record<string, string>>;
  #historyRestoreFenceSources: AmpleFileHistoryRestoreFenceSources;
  readonly #now: () => Date;
  readonly #createTaskId: () => string;
  readonly #tasks = new Map<
    string,
    | AmpleFileTaskSnapshot
    | AmpleFileExperimentalPreparedActTask
    | AmpleFileExperimentalAutomationRunTask
    | AmpleFileExperimentalJobTask
  >();

  constructor(options: AmpleFileKernelOptions = {}) {
    this.#runtimeProvider = options.runtimeProvider;
    this.#listConnectedFolders = options.listConnectedFolders ?? listConnectedFolders;
    this.#getConnectedFolder = options.getConnectedFolder ?? getConnectedFolder;
    this.#loadCapabilityCatalog = options.loadCapabilityCatalog ?? loadAgentSkillCatalog;
    this.#listPackages = options.listPackages ?? listPiPackages;
    this.#isProjectMutationTrusted = options.isProjectMutationTrusted ?? isPiProjectMutationTrusted;
    this.#overviewSources = options.overviewSources ?? {};
    this.#readOverviewSeen = options.readOverviewSeen;
    this.#historyRestoreFenceSources = options.historyRestoreFenceSources ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#createTaskId = options.createTaskId ?? (() => `task-${randomUUID()}`);
  }

  async getContext(actor: AmpleFileActor): Promise<AmpleFileContextSnapshot> {
    const normalizedActor = normalizeActor(actor);
    if (normalizedActor.connectedFolderId) {
      return {
        kind: "amplefile.context",
        version: ampleFileKernelSnapshotVersion,
        actor: normalizedActor,
        resolution: "connected-folder_id",
        connectedFolder: toConnectedFolderSnapshot(await this.#getConnectedFolder(normalizedActor.connectedFolderId)),
      };
    }

    if (normalizedActor.cwd) {
      const cwd = resolve(normalizedActor.cwd);
      const candidates = (await this.#listConnectedFolders())
        .filter((connectedFolder) => pathContains(connectedFolder.connectedFolderRoot, cwd))
        .sort((left, right) => resolve(right.connectedFolderRoot).length - resolve(left.connectedFolderRoot).length);
      if (candidates[0]) {
        return {
          kind: "amplefile.context",
          version: ampleFileKernelSnapshotVersion,
          actor: normalizedActor,
          resolution: "cwd",
          connectedFolder: toConnectedFolderSnapshot(candidates[0]),
        };
      }
    }

    return {
      kind: "amplefile.context",
      version: ampleFileKernelSnapshotVersion,
      actor: normalizedActor,
      resolution: "none",
      connectedFolder: null,
    };
  }

  async getConnectedFolders(actor: AmpleFileActor): Promise<AmpleFileConnectedFoldersSnapshot> {
    return {
      kind: "amplefile.connected-folders",
      version: ampleFileKernelSnapshotVersion,
      actor: normalizeActor(actor),
      connectedFolders: withParentConnectedFolderIds((await this.#listConnectedFolders()).map(toConnectedFolderSnapshot)),
    };
  }

  async getTasks(actor: AmpleFileActor): Promise<AmpleFileTasksSnapshot> {
    const normalizedActor = normalizeActor(actor);
    const scoped = Boolean(normalizedActor.connectedFolderId || normalizedActor.cwd);
    const context = scoped ? await this.getContext(normalizedActor) : null;
    const connectedFolderId = context?.connectedFolder?.id ?? null;
    const tasks = [...this.#tasks.values()]
      // Only the stable kinds enter the `work-fold.tasks` v1 projection; the
      // experimental prepared-act, automation-run, and job lifecycles stay internal.
      .filter((task): task is AmpleFileTaskSnapshot => task.kind === "assistant_turn" || task.kind === "compaction")
      .filter((task) => !scoped || task.connectedFolderId === connectedFolderId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id))
      .map(copyTask);
    return {
      kind: "amplefile.tasks",
      version: ampleFileKernelSnapshotVersion,
      actor: normalizedActor,
      connectedFolderId,
      tasks,
    };
  }

  async getCapabilities(actor: AmpleFileActor): Promise<AmpleFileCapabilitiesSnapshot> {
    const context = await this.getContext(actor);
    if (!context.connectedFolder) throw new AmpleFileContextRequiredError();
    const [catalog, packages, mutationTrusted] = await Promise.all([
      this.#loadCapabilityCatalog(context.connectedFolder.connectedFolderRoot, this.#runtimeProvider),
      this.#listPackages(context.connectedFolder.connectedFolderRoot, this.#runtimeProvider),
      this.#isProjectMutationTrusted(context.connectedFolder.connectedFolderRoot, this.#runtimeProvider),
    ]);
    return {
      kind: "amplefile.capabilities",
      version: ampleFileKernelSnapshotVersion,
      actor: context.actor,
      connectedFolder: context.connectedFolder,
      catalog: buildAmpleFileCapabilityCatalog(catalog, packages, mutationTrusted),
    };
  }

  /**
   * Composes the experimental overview digest (version 0) over the kernel's own
   * task registry, the registered Connected Folders, and the injected source readers,
   * with one clock reading. The digest sits above all Connected Folders: it never varies
   * by actor, and the actor is normalized only for interface consistency. The
   * experimental snapshot stays out of the stable `amplefile.tasks`/protocol
   * v1 projections like the experimental task kinds, and the kernel stays
   * read-only here — it reads seen markers and never writes one.
   */
  async getOverview(actor: AmpleFileActor): Promise<AmpleFileOverviewSnapshot> {
    normalizeActor(actor);
    const connectedFolders = (await this.#listConnectedFolders()).map(toConnectedFolderSnapshot);
    let seen: Record<string, string> = {};
    if (this.#readOverviewSeen) {
      try {
        seen = await this.#readOverviewSeen();
      } catch {
        // A lost seen table only renders more items as new — over-reporting
        // is the safe failure direction for markers.
        seen = {};
      }
    }
    return composeAmpleFileOverview({
      now: this.#now(),
      connectedFolders: connectedFolders.map((connectedFolder) => ({ id: connectedFolder.id, name: connectedFolder.name, connectedFolderRoot: connectedFolder.connectedFolderRoot })),
      sources: {
        ...this.#overviewSources,
        runningTasks: async () => this.#overviewTaskRecords(),
      },
      seen,
    });
  }

  /**
   * One-shot wiring seam for the owning application host: the local API
   * constructs its live-registry source readers and seen-marker reader only
   * after the kernel exists (the desktop builds the kernel first), so this
   * attaches them post-construction. It rewires reads only — the kernel stays
   * read-only over overview state, and its own task registry still always
   * supplies the running-task source.
   */
  configureOverview(input: {
    sources?: AmpleFileOverviewSourceReaders;
    readSeen?: () => Promise<Record<string, string>>;
  }): void {
    if (input.sources) this.#overviewSources = { ...input.sources };
    if (input.readSeen) this.#readOverviewSeen = input.readSeen;
  }

  /**
   * Post-construction wiring for the History-restore fence readers, exactly
   * like `configureOverview`: the owning host builds its automation executor after
   * the kernel exists, so the readers attach here. Reads only — the kernel
   * never mutates automation or app state through this seam.
   */
  configureHistoryRestoreFence(input: { sources: AmpleFileHistoryRestoreFenceSources }): void {
    this.#historyRestoreFenceSources = { ...input.sources };
  }

  /**
   * The whole–Connected Folder History-restore fence (docs/act-ledger.md, conflict
   * rule 7, item 4): person-readable blockers for restoring the named Connected Folder
   * right now, judged from the kernel's own task registry plus the injected
   * fence readers. Restore replaces the working set running work may be
   * writing into, so the rule is deliberate strengthening over the desktop's
   * confirm dialog:
   *
   * - An active `automation_run` task whose declaration includes a files hop
   *   into this Connected Folder blocks. A run whose hops cannot be verified — no
   *   reader, an unknown automation, a failed read — blocks too (fail closed):
   *   the registry proves work is running, so unverifiable hops must not
   *   race a restore.
   * - An active restricted-app automation run whose app holds a file grant
   *   into this Connected Folder blocks, through the injected reader; a configured
   *   reader that fails blocks (fail closed). While no reader is configured
   *   there is no recorded evidence of such runs anywhere in-process, and
   *   this half of the rule stays honestly inactive.
   *
   * The experimental method is not part of the stable snapshot surface, and
   * turn and compaction fencing stays with the act facade's own live route
   * state.
   */
  async listExperimentalHistoryRestoreBlockers(connectedFolderId: string): Promise<string[]> {
    const targetConnectedFolderId = connectedFolderId.trim();
    if (!targetConnectedFolderId) throw new Error("A Connected Folder id is required.");
    const blockers: string[] = [];
    // A running background job may be writing into this folder; a restore
    // would race it (docs/background-jobs.md, F31).
    for (const job of this.listExperimentalJobTasks(targetConnectedFolderId)) {
      blockers.push(`Stop or wait for the background job "${job.name}" (${job.id}) running in this Connected Folder first: it may still be writing here.`);
    }
    const automationRuns = [...this.#tasks.values()]
      .filter((task): task is AmpleFileExperimentalAutomationRunTask => task.kind === "automation_run");
    const readTargets = this.#historyRestoreFenceSources.automationRunFilesHopTargets;
    for (const run of automationRuns) {
      const label = `automation run ${run.runId} (automation ${run.automationId})`;
      if (!readTargets) {
        blockers.push(`Wait for the running ${label} to finish before restoring: its files-hop targets cannot be verified in this build.`);
        continue;
      }
      let targets: string[] | null;
      try {
        targets = await readTargets(run.automationId);
      } catch {
        targets = null;
      }
      if (targets === null) {
        blockers.push(`Wait for the running ${label} to finish before restoring: its files-hop targets could not be verified.`);
        continue;
      }
      if (targets.includes(targetConnectedFolderId)) {
        blockers.push(`Wait for the running ${label} to finish before restoring: it declares a files hop into this Connected Folder.`);
      }
    }
    const readAppAutomationRuns = this.#historyRestoreFenceSources.appAutomationRunsWithFileGrantInto;
    if (readAppAutomationRuns) {
      try {
        for (const run of await readAppAutomationRuns(targetConnectedFolderId)) {
          blockers.push(
            `Wait for the running app automation ${run.appAutomationId} of ${run.appId} (run ${run.runId}) to finish before restoring: the app holds a file grant into this Connected Folder.`,
          );
        }
      } catch {
        blockers.push("Wait before restoring: running app automations with file grants into this Connected Folder could not be verified.");
      }
    }
    return blockers;
  }

  #overviewTaskRecords(): AmpleFileOverviewTaskRecord[] {
    // The overview's running-task vocabulary is closed (assistant_turn,
    // compaction). A running fold_act execution is deliberately
    // not projected: the act's receipt reaches the overview through the
    // act-receipts source, and the execution itself is a short internal step
    // between the accepted and terminal lines. A routing_run task is likewise
    // excluded: automation runs reach the overview through their own receipts
    // source, and this internal task carries no Connected Folder id to render.
    return [...this.#tasks.values()]
      .filter((task): task is AmpleFileTaskSnapshot =>
        task.kind === "assistant_turn" || task.kind === "compaction")
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        connectedFolderId: task.connectedFolderId,
        ...(task.conversationId ? { conversationId: task.conversationId } : {}),
        startedAt: task.startedAt,
      }));
  }

  startTask(input: AmpleFileTaskInput): AmpleFileTaskSnapshot {
    const id = input.id?.trim() || this.#createTaskId();
    if (!id) throw new Error("A task id is required.");
    if (this.#tasks.has(id)) throw new Error(`A task with this id is already running: ${id}`);
    const connectedFolderId = input.connectedFolderId.trim();
    if (!connectedFolderId) throw new Error("A task needs a Connected Folder id.");
    const task: AmpleFileTaskSnapshot = {
      id,
      kind: input.kind,
      status: "running",
      connectedFolderId,
      ...(input.conversationId?.trim() ? { conversationId: input.conversationId.trim() } : {}),
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyTask(task);
  }

  /**
   * Starts one prepared-act execution in the shared internal lifecycle
   * without promoting the experimental kind into the stable `amplefile.tasks` v1
   * projection. The prepared-act executor (src/local/prepared-acts.ts)
   * starts one task per execution and finishes it on every outcome —
   * success, failure, and abort cleanup — so a capability mutation can be
   * fenced against it and no ghost task survives the execution.
   */
  startExperimentalPreparedActTask(input: AmpleFileExperimentalPreparedActTaskInput): AmpleFileExperimentalPreparedActTask {
    const id = input.id?.trim() || this.#createTaskId();
    if (this.#tasks.has(id)) throw new Error(`A task with this id is already running: ${id}`);
    const requestId = input.requestId.trim();
    if (!requestId) throw new Error("Fold act task request id is required.");
    const actKind = input.kind.trim();
    if (!actKind) throw new Error("Fold act task kind is required.");
    const connectedFolderId = input.connectedFolderId?.trim() || null;
    if (input.connectedFolderId !== undefined && !connectedFolderId) throw new Error("A task needs a Connected Folder id.");
    const task: AmpleFileExperimentalPreparedActTask = {
      id,
      kind: "prepared_act",
      status: "running",
      connectedFolderId,
      requestId,
      actKind,
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyExperimentalPreparedActTask(task);
  }

  /**
   * Starts one automation run in the shared internal lifecycle without promoting
   * the experimental kind into the stable `amplefile.tasks` v1 projection. The
   * automation executor (src/local/automations/automation-service.ts) starts one task
   * per launched run through its observability port and finishes it on every
   * outcome, so no ghost task survives a settled run.
   */
  startExperimentalAutomationRunTask(input: AmpleFileExperimentalAutomationRunTaskInput): AmpleFileExperimentalAutomationRunTask {
    const id = input.id?.trim() || this.#createTaskId();
    if (this.#tasks.has(id)) throw new Error(`A task with this id is already running: ${id}`);
    const automationId = input.automationId.trim();
    if (!automationId) throw new Error("Automation run task automation id is required.");
    const runId = input.runId.trim();
    if (!runId) throw new Error("Automation run task run id is required.");
    const task: AmpleFileExperimentalAutomationRunTask = {
      id,
      kind: "automation_run",
      status: "running",
      automationId,
      runId,
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return copyExperimentalAutomationRunTask(task);
  }

  /**
   * Starts one background job in the shared internal lifecycle without
   * promoting the experimental kind into the stable `amplefile.tasks` v1
   * projection. The job service's host finishes it when the job settles.
   */
  startExperimentalJobTask(input: AmpleFileExperimentalJobTaskInput): AmpleFileExperimentalJobTask {
    const id = input.jobId.trim();
    if (!id) throw new Error("A background job task needs its job id.");
    if (this.#tasks.has(id)) throw new Error(`A task with this id is already running: ${id}`);
    const task: AmpleFileExperimentalJobTask = {
      id,
      kind: "job",
      status: "running",
      name: input.name,
      connectedFolderId: input.connectedFolderId?.trim() || null,
      conversationId: input.conversationId,
      actor: normalizeActor(input.actor),
      startedAt: this.#now().toISOString(),
    };
    this.#tasks.set(task.id, task);
    return { ...task, actor: { ...task.actor } };
  }

  /** Running background jobs, optionally in one Connected Folder; the restore and removal fences read this. */
  listExperimentalJobTasks(connectedFolderId?: string): AmpleFileExperimentalJobTask[] {
    return [...this.#tasks.values()]
      .filter((task): task is AmpleFileExperimentalJobTask => task.kind === "job")
      .filter((task) => connectedFolderId === undefined || task.connectedFolderId === connectedFolderId)
      .map((task) => ({ ...task, actor: { ...task.actor } }));
  }

  finishTask(taskId: string): boolean {
    return this.#tasks.delete(taskId);
  }
}

export function buildAmpleFileCapabilityCatalog(
  catalog: PiResourceCatalog,
  packages: PiConfiguredPackage[],
  mutationTrusted: boolean,
): AmpleFileCapabilityCatalogSnapshot {
  const loadedPackageSources = new Set([
    ...catalog.skills.map((item) => item.source),
    ...catalog.extensions.map((item) => item.source),
    ...catalog.surfaces.map((item) => item.source),
    ...catalog.prompts.map((item) => item.source),
    ...catalog.themes.flatMap((item) => item.source ? [item.source] : []),
  ].filter((source) => source.origin === "package").map((source) => source.source));
  const projectTrust = { ...catalog.projectTrust, mutationTrusted };

  return {
    ...(catalog.resources ? { resources: catalog.resources } : {}),
    projectTrust: { ...projectTrust },
    trust: { ...projectTrust },
    // Compatibility for older renderers. A Connected Folder with no gated resources is
    // runtime-trusted even when it has no saved mutation decision.
    projectTrusted: catalog.projectTrust.trusted,
    packages: packages.map((item) => ({
      source: item.source,
      scope: item.scope === "project" ? "project" : "global",
      filtered: item.filtered,
      ...(item.installedPath ? { installedPath: item.installedPath } : {}),
      installed: Boolean(item.installedPath),
      loaded: loadedPackageSources.has(item.source),
    })),
    toolManagement: { ...catalog.toolManagement },
    skills: catalog.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      source: sourceLabel(skill.source),
      ...capabilitySourceFields(skill.source),
      enabled: true,
      loaded: true,
      status: "loaded",
      ...(skill.content !== undefined ? { content: skill.content } : {}),
      ...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
    })),
    extensions: catalog.extensions.map((extension) => ({
      id: extension.resolvedPath,
      name: extension.name ?? basename(extension.resolvedPath).replace(/\.[^.]+$/, ""),
      path: extension.path,
      source: sourceLabel(extension.source),
      ...capabilitySourceFields(extension.source),
      enabled: true,
      loaded: true,
      status: "loaded",
      commands: [...extension.commands],
      tools: [...extension.tools],
      flags: [...extension.flags],
    })),
    surfaces: catalog.surfaces.map((surface) => ({
      id: surface.id,
      title: surface.title,
      ...(surface.description ? { description: surface.description } : {}),
      ...(surface.icon ? { icon: surface.icon } : {}),
      extensionPath: surface.extensionPath,
      manifestPath: surface.manifestPath,
      views: surface.views.map((view) => ({
        id: view.id,
        title: view.title,
        ...(view.description ? { description: view.description } : {}),
        blocks: view.blocks.map(copySurfaceBlock),
      })),
      source: sourceLabel(surface.source),
      ...capabilitySourceFields(surface.source),
      enabled: true,
      loaded: true,
      status: "loaded",
    })),
    tools: catalog.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      source: sourceLabel(tool.source),
      ...capabilitySourceFields(tool.source),
      enabled: true,
      loaded: true,
      status: "loaded",
      active: tool.active,
      kind: tool.kind,
      core: tool.core,
      configurable: tool.configurable,
      configurationScope: tool.configurationScope,
    })),
    prompts: catalog.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
      path: prompt.path,
      source: sourceLabel(prompt.source),
      ...capabilitySourceFields(prompt.source),
      enabled: true,
      loaded: true,
      status: "loaded",
    })),
    themes: catalog.themes.map((theme) => ({
      name: theme.name,
      ...(theme.path ? { path: theme.path } : {}),
      ...(theme.source ? {
        source: sourceLabel(theme.source),
        ...capabilitySourceFields(theme.source),
      } : {}),
      enabled: true,
      loaded: true,
      status: "loaded",
    })),
    commands: catalog.commands.map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      kind: command.source,
      ...(command.sourceInfo ? {
        source: sourceLabel(command.sourceInfo),
        ...capabilitySourceFields(command.sourceInfo),
      } : { source: command.source }),
      enabled: true,
      loaded: true,
      status: "loaded",
    })),
    diagnostics: catalog.diagnostics.map((diagnostic) => ({
      type: diagnostic.type === "collision" ? "warning" : diagnostic.type,
      message: diagnostic.message,
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
    })),
  };
}

function copySurfaceBlock(block: PiSurfaceBlock): PiSurfaceBlock {
  if (block.type === "heading" || block.type === "text") return { ...block };
  if (block.type === "callout") return { ...block };
  if (block.type === "metrics") return { ...block, items: block.items.map((item) => ({ ...item })) };
  if (block.type === "table") return { ...block, columns: [...block.columns], rows: block.rows.map((row) => [...row]) };
  return { ...block, items: block.items.map((item) => ({ ...item })) };
}

function sourceLabel(source: PiCatalogSource): string {
  const scope = source.scope === "user" ? "Everywhere" : source.scope === "project" ? "This Connected Folder only" : "Temporary";
  const origin = source.origin === "package"
    ? source.source
    : source.source === "auto" ? "standard Pi location" : source.source;
  return [scope, origin].filter(Boolean).join(" · ");
}

function capabilitySourceFields(source: PiCatalogSource): {
  scope: AmpleFileCapabilityScope;
  origin: AmpleFileCapabilityOrigin;
  packageSource?: string;
  sourceInfo: AmpleFileCapabilityProvenance;
  provenance: AmpleFileCapabilityProvenance;
} {
  const scope: AmpleFileCapabilityScope = source.scope === "user" ? "global" : source.scope;
  const provenance: AmpleFileCapabilityProvenance = {
    label: sourceLabel(source),
    source: source.source,
    path: source.path,
    scope,
    origin: source.origin,
    ...(source.baseDir ? { baseDir: source.baseDir } : {}),
    ...(source.origin === "package" ? { packageSource: source.source } : {}),
  };
  return {
    scope,
    origin: source.origin,
    ...(source.origin === "package" ? { packageSource: source.source } : {}),
    sourceInfo: { ...provenance },
    provenance: { ...provenance },
  };
}

function normalizeActor(actor: AmpleFileActor): AmpleFileActor {
  return {
    kind: actor.kind,
    ...(actor.cwd?.trim() ? { cwd: resolve(actor.cwd.trim()) } : {}),
    ...(actor.connectedFolderId?.trim() ? { connectedFolderId: actor.connectedFolderId.trim() } : {}),
    ...(actor.conversationId?.trim() ? { conversationId: actor.conversationId.trim() } : {}),
  };
}

function toConnectedFolderSnapshot(connectedFolder: ConnectedFolderSummary): AmpleFileConnectedFolderSnapshot {
  return {
    id: connectedFolder.id,
    name: connectedFolder.name,
    connectedFolderRoot: resolve(connectedFolder.connectedFolderRoot),
    location: { ...connectedFolder.location },
    createdAt: connectedFolder.createdAt,
    updatedAt: connectedFolder.updatedAt,
  };
}

function withParentConnectedFolderIds(connectedFolders: AmpleFileConnectedFolderSnapshot[]): AmpleFileConnectedFolderSnapshot[] {
  const parents = folderParentIds(connectedFolders);
  return connectedFolders.map((connectedFolder) => {
    const parentConnectedFolderId = parents.get(connectedFolder.id);
    return parentConnectedFolderId ? { ...connectedFolder, parentConnectedFolderId } : connectedFolder;
  });
}

function copyTask(task: AmpleFileTaskSnapshot): AmpleFileTaskSnapshot {
  return { ...task, actor: { ...task.actor } };
}

function copyExperimentalPreparedActTask(task: AmpleFileExperimentalPreparedActTask): AmpleFileExperimentalPreparedActTask {
  return { ...task, actor: { ...task.actor } };
}

function copyExperimentalAutomationRunTask(task: AmpleFileExperimentalAutomationRunTask): AmpleFileExperimentalAutomationRunTask {
  return { ...task, actor: { ...task.actor } };
}

function pathContains(rootPath: string, candidatePath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
