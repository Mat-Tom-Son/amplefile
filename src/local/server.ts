import { prepareResourceEnable, resourceEnableAdapter } from "./agent/resource-enable-act.js";
import { shutdownIncludedToolHost } from "./agent/included-tool-setup.js";
import { ModelContextInspector } from "./agent/model-context-inspector.js";
import { observeAmpleFileAutomationFiles } from "./automations/automation-file-observer.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type { PiRuntimeProvider } from "./agent/pi-client.js";
import { AmpleFileTurnStore } from "./agent/turn-store.js";
import { TurnCheckpointWriter } from "./agent/turn-checkpoint-writer.js";
import {
  RoutedPiExtensionUiBridge,
  type PiExtensionUiEvent,
  type PiExtensionUiRequest,
  type PiExtensionUiSettled,
} from "./agent/extension-ui.js";
import {
  createConversation,
  listConversations,
  readConversation,
  readConversationSummary,
  renameConversation,
  updateConversationLifecycle,
  type ConversationSummary,
} from "./agent/chat-store.js";
import { RemoteCapabilityRegistry } from "./agent/capability-registry.js";
import { importPiSkillBundleVerified, piSkillBundleContentDigest, type PiSkillBundleImportResult } from "./agent/skill-import.js";
import { normalizeWorkerInstructions } from "./agent/model-preferences.js";
import {
  RegisteredConnectedFolderRuntimeProvider,
  RegisteredConnectedFolderTrustAuthority,
} from "./agent/registered-connected-folder-runtime.js";
import {
  getPiWorkerInstructions,
  getPiSetupStatus,
  installPiPackage,
  isPiProjectMutationTrusted,
  listPiModels,
  listPiPackages,
  removePiPackage,
  resolvePiRuntime,
  setPiDefaultModel,
  updatePiPackages,
} from "./agent/pi-runtime-config.js";
import { ProviderSignIns } from "./agent/provider-sign-in.js";
import { ImageModelPreference, imageModelPreferencePath } from "./agent/image-model-preference.js";
import { GeneratedImageStore } from "./agent/generated-image-store.js";
import { classifyAmpleFileAgentAttachments, type AmpleFileAgentAttachmentRef } from "./amplefile-agent-attachments.js";
import {
  AmpleFileRequestLineageError,
  ampleFileAnswerMatchesRecorded,
  type AmpleFileRequestActionCommand,
  type AmpleFileQuestionRecord,
} from "./requests/request-records.js";
import { AmpleFileRequestStore } from "./requests/request-store.js";
import { isAmpleFileJobTerminalState } from "./jobs/job-records.js";
import { reapOrphanedJobProcesses, AmpleFileJobService, type AmpleFileJobShell } from "./jobs/job-service.js";
import { AmpleFileJobStore } from "./jobs/job-store.js";
import { parseUntilPattern } from "./agent/job-tools.js";
import {
  createConnectedFolderCheckpoint,
  createConnectedFolderMutationCheckpoint,
  listConnectedFolderCheckpoints,
  listConnectedFolderCheckpointPage,
  listFileVersionPage,
  restoreFileVersion,
  restoreConnectedFolderCheckpoint,
  type ConnectedFolderCheckpoint,
  type ConnectedFolderFileVersion,
} from "./history.js";
import { compareHistoryFile, readHistoryFile } from "./history-review.js";
import { searchConnectedFolder } from "./search.js";
import { ConnectedFolderAppearanceStore } from "./connected-folder-appearance-store.js";
import {
  applyConnectedFolderAppearanceParts,
  resolveConnectedFolderAppearanceParts,
  connectedFolderAppearancePartsLabel,
  ConnectedFolderAppearancePartsError,
} from "./connected-folder-appearance-parts.js";
import {
  hasConnectedFolderAppearanceCustomization,
  parseConnectedFolderAppearanceProposal,
  connectedFolderAppearanceBannerNames,
  type ConnectedFolderAppearanceCustomization,
  type ConnectedFolderAppearanceProposal,
} from "../shared/connected-folder-appearance.js";
import {
  PreparedActError,
  PreparedActExecutor,
  prepareAct,
  type PreparedActFence,
  type PreparedAct,
  type PreparedActAdapter,
  type PreparedActAdapters,
  type PreparedActFields,
  type PreparedActKind,
} from "./prepared-acts.js";
import { AmpleFileOverviewSeenStore } from "./overview-seen-store.js";
import { ensureAmpleFileAgentInstructions } from "./amplefile-agent-instructions.js";
import {
  ampleFileAutomationDigest,
  ampleFileAutomationReferencedConnectedFolderIds,
  type AmpleFileAutomationDeclaration,
  type AmpleFileAutomationFilesStep,
} from "./automations/automation-declarations.js";
import { AmpleFileAutomationService } from "./automations/automation-service.js";
import { AmpleFileAutomationStore, type AmpleFileAutomationRecord } from "./automations/automation-store.js";
import {
  configureAmpleFileStateRoot,
  ampleFileAgentRoot,
  ampleFileAgentScopeId,
  ampleFileStateRoot,
  ampleFileRequestsRoot,
  ampleFileJobsRoot,
  ampleFileRecentlyDeletedRoot,
} from "./state-paths.js";
import { AmpleFileRecentlyDeletedStore, ampleFileRecentlyDeletedEntryIdPattern } from "./recently-deleted-store.js";
import { AmpleFileKernel } from "./amplefile-kernel.js";
import { AmpleFileCliActReceipts, type AmpleFileCliActSurface } from "./cli/act-receipts.js";
import { AmpleFileCliError } from "./cli/protocol.js";
import type {
  AmpleFileActChatLifecycleState,
  AmpleFileActCheckpointSummary,
  AmpleFileActConversationRef,
  AmpleFileActFacade,
  AmpleFileActFileVersionRef,
  AmpleFileActConnectedFolderRef,
  AmpleFileActRecentlyDeletedEntry,
} from "./cli/act-facade.js";
import { resolveAmpleFileCliConnectedFolderSelector } from "./amplefile-cli-adapter.js";
import { createLocalDevelopmentApiOptions, loadLocalEnvironmentFile } from "./server-dev-options.js";
import {
  createConnectedFolderFolder,
  createConnectedFolderTextFile,
  getConnectedFolder,
  listConnectedFolders,
  listPendingConnectedFolderRemovals,
  managedConnectedFolderDeletionPinIssue,
  moveConnectedFolderEntry,
  renameConnectedFolderEntry,
  renameConnectedFolder,
  resolveConnectedFolderPath,
  type ConnectedFolderRemovalResult,
  type ConnectedFolderSummary,
} from "./connected-folder.js";
import { handleAiModelRoutes, handleModelContextRoutes, saveWorkerInstructions } from "./api/ai-model-routes.js";
import {
  ampleFileAgentRequestView,
  ampleFileAgentScope,
  ampleFileAgentScopeForRoutes,
  assertAmpleFileAgentInstructionsReady,
  assertAmpleFileAgentParentAccepting,
  handleAmpleFileAgentRoutes,
  resolveAmpleFileAgentConversation,
  resolveAmpleFileAgentLineageParent,
} from "./api/amplefile-agent-routes.js";
import { createAutomationHopPorts } from "./api/automation-hops.js";
import { readAutomationReceiptProjection, toActAutomationFilesSource, toActAutomationSummary } from "./api/automation-receipts.js";
import {
  type AmpleFileAutomationSettingsFacade,
  createAmpleFileAutomationSettingsFacade,
  enableStoredAutomationDeclaration,
  handleConnectedFolderAutomationRoutes,
  readAutomationStagingFile,
} from "./api/automation-settings.js";
import {
  createBackgroundJobService,
  createBackgroundJobToolHost,
  deliverBackgroundJobs,
  ownedJob,
  runJobOperation,
  settleBackgroundJobOnRequest,
  startBackgroundJob,
  stopBackgroundJob,
  toActJobRef,
} from "./api/background-jobs.js";
import { closeMcpSetups, handleCapabilityRoutes } from "./api/capability-routes.js";
import { copyConversation, handleChatRoutes, runConversationMutation } from "./api/chat-routes.js";
import {
  createConnectedFolderInternal,
  handleConnectedFolderAppearanceRoutes,
  handleConnectedFolderRegistryRoutes,
  recoverPendingConnectedFolderRemovals,
  registerConnectedFolderInternal,
  removeConnectedFolderRegistrationInternal,
} from "./api/connected-folder-routes.js";
import { createWorktreeToolHost, getClient, refreshClientIfMarked } from "./api/conversation-clients.js";
import { broadcast, chatEventLog, flushAllTurnCheckpoints, handleEventStreamRoutes, publishControlHint } from "./api/event-streams.js";
import { handleExtensionUiRoutes, publishExtensionSnapshot, routeExtensionEvent, routeExtensionRequest } from "./api/extension-ui.js";
import {
  addExternalFilesInternal,
  deleteConnectedFolderEntryWithRecovery,
  normalizeConnectedFolderRelativePath,
} from "./api/file-changes.js";
import { handleFileRoutes, handleSearchRoutes } from "./api/file-routes.js";
import { handleHistoryRoutes } from "./api/history-routes.js";
import {
  authorize,
  automationErrorStatus,
  closeServer,
  errorMessage,
  listen,
  notFound,
  numberFromEnv,
  sendError,
  setCorsHeaders,
} from "./api/http.js";
import { createServerOverviewSources, handleOverviewRoutes } from "./api/overview-routes.js";
import { forgetOpenLocalApi, handlePlaceRoutes, rememberOpenLocalApi } from "./api/place-routes.js";
import { handleSettingsRoutes, recentlyDeletedEntryView, restoreRecentlyDeletedEntry } from "./api/recently-deleted-routes.js";
import {
  assertCallerHandedWorkTo,
  assertCallerTurn,
  assertOwnTask,
  assertRequestsAboveConnectedFolders,
  collaborationRefusal,
  conversationResultForScope,
  readReportDataFile,
  requestDetailView,
  requestLimitRefusalMessage,
  requestSummaryView,
  resolveHandoffSource,
  resolveReportFiles,
  toActQuestionRef,
  toActRequestRef,
  toActRequestRefForConnectedFolder,
  turnResultForScope,
  turnStatusFor,
  waitingRefForTask,
} from "./api/request-records.js";
import { handleRequestRoutes, queueConversationRequestEvaluation, stopAmpleFileAgentRequest } from "./api/request-routes.js";
import {
  assertNoCapabilityMutationForTurn,
  runCapabilityMutation,
  runConnectedFolderMutation,
  runHistoryRestore,
  runWithHistorySafety,
} from "./api/reservations.js";
import {
  clientKey,
  conversationRuntimeState,
  type LocalApiOptions,
  type LocalApiRequest,
  type LocalApiState,
  streamKey,
} from "./api/state.js";
import { acceptConversationTurn, steerConversationTurn } from "./api/turn-acceptance.js";
import { recoverDurableTurnState, yieldBackgroundCompaction } from "./api/turn-run.js";

export type {
  AmpleFileAutomationSettingsOutcome,
  AmpleFileAutomationSettingsConnectedFolderRef,
  AmpleFileAutomationSettingsRunView,
  AmpleFileAutomationSettingsSummary,
  AmpleFileAutomationSettingsProposalView,
  AmpleFileAutomationSettingsFacade,
} from "./api/automation-settings.js";
export type {
  AmpleFileDeleteRecovery,
  AmpleFileDeleteResult,
  AmpleFileBatchDeleteResult,
  AmpleFileBatchMoveResult,
} from "./api/file-changes.js";
export { transferFileEntries } from "./api/place-routes.js";
export type { AmpleFileRecentlyDeletedEntryView, AmpleFileRecentlyDeletedRestoreResult } from "./api/recently-deleted-routes.js";
export type { LocalFolderGrantProvider, LocalApiOptions } from "./api/state.js";

export interface LocalApiHandle {
  origin: string;
  port: number;
  kernel: AmpleFileKernel;
  /** In-process authority for CLI act-lane commands; see cli/act-facade.ts. */
  actFacade: AmpleFileActFacade;
  /** Validates an explicitly named AmpleFile Agent parent while its turn is active. */
  resolveAmpleFileAgentLineageParent: (taskId: string) => { taskId: string } | null;
  /** The durable request graph every accepted turn belongs to (docs/collaboration-contract.md). */
  requests: AmpleFileRequestStore;
  /** Background jobs Workers and the AmpleFile Agent started (docs/background-jobs.md). */
  jobs: AmpleFileJobService;
  /** The automation executor (docs/automations.md), for the desktop surfaces and lifecycle wiring. */
  automations: AmpleFileAutomationService;
  /**
   * Main-window Settings capability. The local HTTP API serves only its Connected Folder–scoped subset — `forConnectedFolder` and the
   * enable, disable, and run of an automation that names that Connected Folder — at
   * `/api/connected-folders/:id/automations` (docs/automations.md).
   */
  automationSettings: AmpleFileAutomationSettingsFacade;
  /** Recently deleted: the machine-local trash every destructive verb writes to first. */
  recentlyDeleted: AmpleFileRecentlyDeletedStore;
  close: () => Promise<void>;
}

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function startLocalApi(options: LocalApiOptions = {}): Promise<LocalApiHandle> {
  if (options.loadEnv !== false) loadLocalEnvironmentFile(join(repoRoot, ".env"));
  const appMode = options.appMode ?? "dev";
  const developmentDefaults = appMode === "dev"
    && (options.stateBase === undefined || options.port === undefined)
    ? createLocalDevelopmentApiOptions()
    : null;
  configureAmpleFileStateRoot(options.stateBase ?? developmentDefaults?.stateBase);
  // Recently deleted opens before anything can destroy: an interrupted Connected Folder
  // deletion finished by startup recovery below must reach Recently deleted rather
  // than an erase (docs/act-ledger.md).
  const recentlyDeleted = options.recentlyDeletedStore ?? await AmpleFileRecentlyDeletedStore.open({ rootPath: ampleFileRecentlyDeletedRoot() });
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? developmentDefaults?.port ?? numberFromEnv("AMPLEFILE_LOCAL_API_PORT", 4327);
  const extensionUi = options.extensionUiBridge ?? new RoutedPiExtensionUiBridge();
  const modelContextInspector = new ModelContextInspector();
  const extensionRuntimeProvider: PiRuntimeProvider = {
    async resolveRuntime(connectedFolderRoot) {
      const runtime = await options.piRuntimeProvider?.resolveRuntime(connectedFolderRoot) ?? {};
      return {
        ...runtime,
        extensionUi,
        modelContextInspector,
      };
    },
    ...(options.piRuntimeProvider?.setPreferredModel ? {
      setPreferredModel: (connectedFolderRoot, model) => options.piRuntimeProvider!.setPreferredModel!(connectedFolderRoot, model),
    } : {}),
    ...(options.piRuntimeProvider?.getWorkerInstructions ? {
      getWorkerInstructions: (connectedFolderRoot) => options.piRuntimeProvider!.getWorkerInstructions!(connectedFolderRoot),
    } : {}),
    ...(options.piRuntimeProvider?.setWorkerInstructions ? {
      setWorkerInstructions: (connectedFolderRoot, instructions) => options.piRuntimeProvider!.setWorkerInstructions!(connectedFolderRoot, instructions),
    } : {}),
    ...(options.piRuntimeProvider?.refreshModelCatalog ? {
      refreshModelCatalog: (providerId) => options.piRuntimeProvider!.refreshModelCatalog!(providerId),
    } : {}),
    ...(options.piRuntimeProvider?.listModelCatalogs ? {
      listModelCatalogs: () => options.piRuntimeProvider!.listModelCatalogs!(),
    } : {}),
  };
  const recoveredRemovals = await recoverPendingConnectedFolderRemovals(
    options.connectedFolderRemovalIo ?? {},
    recentlyDeleted,
  );
  const recoveredConnectedFolderRoots = recoveredRemovals.connectedFolderRoots;
  const pendingConnectedFolderIds = (await listPendingConnectedFolderRemovals()).map((intent) => intent.connectedFolderId);
  const appearance = options.appearanceStore ?? await ConnectedFolderAppearanceStore.create({
    normalize: { allowedBannerNames: new Set(connectedFolderAppearanceBannerNames) },
  });
  const connectedFolderTrustAuthority = options.connectedFolderTrustAuthority
    ?? new RegisteredConnectedFolderTrustAuthority((await listConnectedFolders()).map((connectedFolder) => connectedFolder.connectedFolderRoot));
  for (const rootPath of recoveredConnectedFolderRoots) connectedFolderTrustAuthority.revoke(rootPath);
  // The AmpleFile Agent scope's root is app-owned state, so authorizing its
  // runtime is an application decision rather than a registration ceremony.
  // The only project configuration under it is what AmpleFile itself
  // materializes here: the AmpleFile Agent's AGENTS.md context file and the
  // manage-connected-folders Skill.
  connectedFolderTrustAuthority.grant(ampleFileAgentRoot());
  let ampleFileAgentInstructionsError: string | null = null;
  try {
    await ensureAmpleFileAgentInstructions();
  } catch (error) {
    ampleFileAgentInstructionsError = errorMessage(error);
    console.warn(`AmpleFile could not materialize the AmpleFile Agent instructions; the AmpleFile Agent is unavailable: ${ampleFileAgentInstructionsError}`);
  }
  const runtimeProvider = new RegisteredConnectedFolderRuntimeProvider(extensionRuntimeProvider, connectedFolderTrustAuthority);
  const kernel = options.kernel ?? new AmpleFileKernel({ runtimeProvider });
  // The AmpleFile Agent's one ledger: the same act-receipts journal the desktop CLI host
  // appends. Both instances write the identical state-root path, so prepared
  // acts land in the journal the act lane already audits.
  const actReceipts = options.actReceipts ?? new AmpleFileCliActReceipts({ stateRoot: ampleFileStateRoot() });
  const turnStore = options.turnStore ?? await AmpleFileTurnStore.create({ stateRoot: ampleFileStateRoot() });
  // The durable request graph beside the turn journal it aggregates. It is
  // reconciled against that journal after startup recovery below.
  const requestStore = options.requestStore ?? await AmpleFileRequestStore.open({ rootPath: ampleFileRequestsRoot() });
  // Background jobs and their output live beside the requests they belong to.
  const jobStore = options.jobStore ?? await AmpleFileJobStore.open({ rootPath: ampleFileJobsRoot() });
  const automationStore = await AmpleFileAutomationStore.create();
  const overviewSeen = new AmpleFileOverviewSeenStore();
  const state: LocalApiState = {
    appMode,
    ...(options.browser ? { browser: options.browser } : {}),
    connectedFolderBase: options.connectedFolderBase ? resolve(options.connectedFolderBase) : undefined,
    allowedOrigins: options.allowedOrigins ?? ["http://127.0.0.1:5173", "http://localhost:5173"],
    listenHost: host,
    sessionToken: options.sessionToken,
    maxBodyBytes: options.maxBodyBytes ?? numberFromEnv("AMPLEFILE_LOCAL_MAX_BODY_BYTES", 100 * 1024 * 1024),
    runtimeProvider,
    extensionUi,
    modelContextInspector,
    piOAuthHooks: options.piOAuthHooks,
    providerSignIns: new ProviderSignIns(),
    capabilityRegistry: options.capabilityRegistry ?? new RemoteCapabilityRegistry(),
    appearance,
    kernel,
    actReceipts,
    turnStore,
    overviewSeen,
    // Assigned in the second construction phase below, before the server
    // listens; their fences and hop ports close over this state object.
    preparedActs: undefined as unknown as PreparedActExecutor,
    automations: undefined as unknown as AmpleFileAutomationService,
    connectedFolderTrustAuthority,
    ampleFileAgentInstructionsError,
    localFolderGrantProvider: options.localFolderGrantProvider,
    connectedFolderRemovalIo: options.connectedFolderRemovalIo ?? {},
    recentlyDeleted,
    beforeConnectedFolderMutationRevalidation: options.beforeConnectedFolderMutationRevalidation,
    requests: requestStore,
    turnsSettledThisRun: new Set(),
    requestSettleChain: Promise.resolve(),
    jobs: undefined as unknown as AmpleFileJobService,
    jobsSettledThisRun: new Set(),
    connectedFolderTurnHandleSalt: randomBytes(16).toString("hex"),
    chatStreams: new Map(),
    controlStreams: new Set(),
    localEventStreams: new Set(),
    chatEventListeners: new Map(),
    chatEventLogs: new Map(),
    activeTurnIdsByKey: new Map(),
    steeredMessages: new Map(),
    steeringInFlight: new Map(),
    turnCheckpointWriter: new TurnCheckpointWriter({
      activeTask: (key) => state.activeTurnIdsByKey.get(key),
      activeTasks: () => state.activeTurnIdsByKey,
      currentText: (key) => chatEventLog(state, key).assistantText,
      writeCheckpoint: (taskId, text) => turnStore.checkpoint(taskId, text),
      reportFailure: (error, operation) => {
        console.error(`Could not ${operation === "checkpoint" ? "persist" : "flush"} agent stream checkpoint: ${errorMessage(error)}`);
      },
    }),
    clients: new Map(),
    runningTurns: new Set(),
    activeTurnPromises: new Set(),
    turnAcceptances: new Set(),
    activeTurnTasks: new Map(),
    cancelledTurnTasks: new Set(),
    settledTurns: new Map(),
    compactingConversations: new Set(),
    backgroundCompactions: new Map(),
    queuedMessages: new Map(),
    queueRevisions: new Map(),
    lastQueueRevision: 0,
    capabilityMutations: new Set(),
    clientsToRefresh: new Set(),
    imageModelPreference: new ImageModelPreference(imageModelPreferencePath(ampleFileStateRoot())),
    generatedImages: new GeneratedImageStore(join(ampleFileStateRoot(), "generated-images")),
    connectedFolderIdsByRoot: new Map(),
    extensionRequests: new Map(),
    fileStreams: new Map(),
    turnCheckpointListeners: new Set(),
    activeTurns: 0,
    acceptingTurns: true,
    onAgentTurnActivity: options.onAgentTurnActivity,
    beforeAgentPrompt: options.beforeAgentPrompt,
    beforeAmpleFileAgentActionRecord: options.beforeAmpleFileAgentActionRecord,
    onHistoryCheckpoint: options.onHistoryCheckpoint,
  };

  // Second construction phase: the prepared-act executor and the automation
  // executor close over the shared state (capability-mutation fences, live
  // route internals), so they are built once it exists and before the
  // server listens.
  state.preparedActs = new PreparedActExecutor({
    adapters: createPreparedActAdapters(state),
    fence: createPreparedActFence(state),
    kernel,
  });
  state.automations = await AmpleFileAutomationService.create({
    store: automationStore,
    ports: createAutomationHopPorts(state),
    observeFiles: observeAmpleFileAutomationFiles,
    tasks: {
      start: ({ automationId, runId }) =>
        kernel.startExperimentalAutomationRunTask({ automationId, runId, actor: { kind: "system" } }),
      finish: (taskId) => {
        kernel.finishTask(taskId);
      },
    },
  });
  // Connected Folder removals that finalized (or remain pending) while the app was not
  // running still revoke standing authority: suspend automations referencing the
  // removed Connected Folders, best-effort — the store already fails closed on damage.
  for (const connectedFolderId of new Set([...recoveredRemovals.connectedFolderIds, ...pendingConnectedFolderIds])) {
    await state.automations.handleConnectedFolderRemoved(connectedFolderId).catch(() => undefined);
  }
  kernel.configureOverview({
    sources: createServerOverviewSources(state),
    readSeen: () => overviewSeen.seenCursors(),
  });
  // History-restore fence readers (docs/act-ledger.md, conflict rule 7):
  // the kernel's routing_run tasks come from this API's own task port, and
  // this reader resolves each active run's declared files-hop targets from
  // the automation store.
  kernel.configureHistoryRestoreFence({
    sources: {
      automationRunFilesHopTargets: async (automationId) => {
        const automation = await state.automations.getAutomation(automationId);
        if (!automation) return null;
        return automation.declaration.steps
          .filter((step): step is AmpleFileAutomationFilesStep => step.kind === "files")
          .map((step) => step.toConnectedFolder);
      },
    },
  });
  await recoverDurableTurnState(state);
  // Nothing runs across a restart: a job a previous run left running is
  // recorded interrupted and never re-run, and its process is stopped only
  // when it is provably the same process (docs/background-jobs.md).
  const interruptedJobs = await jobStore.reconcile("AmpleFile closed before this job finished.");
  if (interruptedJobs.length) {
    const reaped = await reapOrphanedJobProcesses(interruptedJobs);
    console.info(`AmpleFile recorded ${interruptedJobs.length} background job${interruptedJobs.length === 1 ? "" : "s"} as interrupted${reaped ? ` and stopped ${reaped} left running` : ""}.`);
  }
  state.jobs = createBackgroundJobService(state, jobStore);
  // A crash can land between a job's end and its request hearing of it; the
  // job journal is the authority, so its recorded end reaches the request.
  for (const job of jobStore.list()) {
    if (isAmpleFileJobTerminalState(job.state) && state.requests.byJobId(job.jobId)?.jobs?.some((ref) => ref.jobId === job.jobId && ref.state === "running")) {
      await settleBackgroundJobOnRequest(state, job);
    }
  }
  // Strictly after turn recovery: reconciliation consumes the journal's
  // already-repaired outcomes. It settles requests; it never dispatches one.
  const reconciled = await state.requests.reconcile({ turns: state.turnStore.list() });
  if (reconciled.settled || reconciled.expired) {
    console.info(`AmpleFile reconciled ${reconciled.settled} request turn${reconciled.settled === 1 ? "" : "s"} against the turn journal (${reconciled.expired} ran out of time).`);
  }
  // Retention is background work, as for Recently deleted: nothing a task
  // needs sits behind it, and it never runs twice in one day.
  const retentionTasks = new Set<Promise<unknown>>();
  const trackRetention = (operation: Promise<unknown>, failure: string): void => {
    const task = operation.catch((error: unknown) => {
      console.warn(`${failure}: ${errorMessage(error)}`);
    });
    retentionTasks.add(task);
    void task.then(() => retentionTasks.delete(task));
  };
  const drainRetention = () => Promise.allSettled([...retentionTasks]);
  // Start only once shutdown and listen-failure cleanup can own this work.
  // A large expired tree must not delay the port becoming available.
  trackRetention(recentlyDeleted.purgeExpired(), "AmpleFile could not clean Recently deleted at startup");
  trackRetention(state.requests.purgeExpiredIfDue(), "AmpleFile could not tidy its request records at startup");

  const requestListener = (request: PiExtensionUiRequest) => routeExtensionRequest(state, request);
  const eventListener = (event: PiExtensionUiEvent) => routeExtensionEvent(state, event);
  const settledListener = (event: PiExtensionUiSettled) => {
    const request = state.extensionRequests.get(event.id);
    state.extensionRequests.delete(event.id);
    if (request) publishExtensionSnapshot(state, request);
  };

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(state, request, response);
    } catch (error) {
      sendError(response, error);
    }
  });
  try {
    await listen(server, requestedPort, host);
  } catch (error) {
    await drainRetention();
    throw error;
  }
  const retentionTimer = setInterval(() => {
    // Retention runs "daily while awake": the store compares its own durable
    // lastPurgeAt, so sleeping past a deadline purges within the hour and
    // never twice in one day.
    trackRetention(state.recentlyDeleted.purgeExpiredIfDue(), "AmpleFile could not clean Recently deleted");
    // Settled request graphs older than the retention window leave on the
    // same cadence.
    trackRetention(state.requests.purgeExpiredIfDue(), "AmpleFile could not tidy its request records");
    trackRetention(state.jobs.store.purgeExpired(), "AmpleFile could not tidy its background job records");
  }, 60 * 60 * 1_000);
  retentionTimer.unref();
  extensionUi.on("request", requestListener);
  extensionUi.on("event", eventListener);
  extensionUi.on("settled", settledListener);
  const address = server.address() as AddressInfo;
  rememberOpenLocalApi(state);
  return {
    origin: `http://${host}:${address.port}`,
    port: address.port,
    kernel,
    actFacade: createAmpleFileActFacade(state),
    resolveAmpleFileAgentLineageParent: (taskId) => resolveAmpleFileAgentLineageParent(state, taskId),
    requests: state.requests,
    jobs: state.jobs,
    automations: state.automations,
    automationSettings: createAmpleFileAutomationSettingsFacade(state),
    recentlyDeleted,
    close: async () => {
      state.acceptingTurns = false;
      forgetOpenLocalApi(state);
      // Withdraw the cadence before any await; already-admitted filesystem
      // cleanup remains owned until the close promise settles below.
      clearInterval(retentionTimer);
      state.modelContextInspector.setEnabled(false);
      await closeMcpSetups(state);
      for (const response of state.localEventStreams) response.close();
      for (const response of state.controlStreams) response.close();
      extensionUi.off("request", requestListener);
      extensionUi.off("event", eventListener);
      extensionUi.off("settled", settledListener);
      extensionUi.cancelAll();
      // Stop the automation executor first: it aborts active runs (they settle
      // with honest interrupted/stopped receipts through their own domains),
      // and the drained turn promises below carry any aborted chat hops to
      // their settled records.
      state.automations.close();
      // Quitting stops every background job and records it interrupted; only
      // an explicit stop or quit ends one (docs/background-jobs.md).
      await state.jobs.close().catch((error: unknown) => console.warn("Background jobs could not all stop:", errorMessage(error)));
      for (const streams of state.chatStreams.values()) for (const response of streams) response.close();
      for (const close of [...state.fileStreams.keys()]) close();
      // A settle evaluation in flight may be accepting a continuation
      // turn this instant; let it finish so that turn is in the drained set
      // below or was refused by the flag above, never left running unseen.
      await state.requestSettleChain.catch(() => undefined);
      // So may any other acceptance already past the flag (acceptConversationTurn).
      await Promise.allSettled([...state.turnAcceptances]);
      await Promise.allSettled([...state.backgroundCompactions.keys()].map((key) => yieldBackgroundCompaction(state, key)));
      await Promise.allSettled([...state.clients.values()].map((client) => client.stop()));
      await Promise.allSettled([...state.activeTurnPromises]);
      await shutdownIncludedToolHost(ampleFileAgentRoot(), state.runtimeProvider).catch((error) => console.warn("Computer helper shutdown:", errorMessage(error)));
      await state.requestSettleChain.catch(() => undefined);
      await flushAllTurnCheckpoints(state);
      await state.turnStore.flush();
      await state.appearance.flush();
      await closeServer(server);
      // In particular, startup retention may still be writing its
      // durable lastPurgeAt even when no turn has ever run.
      await drainRetention();
    },
  };
}

async function handleRequest(state: LocalApiState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(state, req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  authorize(state, req);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  const request: LocalApiRequest = { state, req, res, url, method };

  // Route groups are tried in this order; the first one that owns the request answers it.
  if (await handleModelContextRoutes(request)) return;
  if (await handleConnectedFolderRegistryRoutes(request)) return;
  if (await handleConnectedFolderAutomationRoutes(request)) return;
  if (await handleConnectedFolderAppearanceRoutes(request)) return;
  if (await handleSearchRoutes(request)) return;
  if (await handlePlaceRoutes(request)) return;
  if (await handleFileRoutes(request)) return;
  if (await handleHistoryRoutes(request)) return;
  if (await handleAiModelRoutes(request)) return;
  if (await handleCapabilityRoutes(request)) return;
  if (await handleChatRoutes(request)) return;
  if (await handleAmpleFileAgentRoutes(request)) return;
  if (await handleRequestRoutes(request)) return;
  if (await handleEventStreamRoutes(request)) return;
  if (await handleOverviewRoutes(request)) return;
  if (await handleSettingsRoutes(request)) return;
  if (await handleExtensionUiRoutes(request)) return;

  throw notFound("Not found.");
}

/**
 * The act facade is the CLI act lane's in-process authority. Every method
 * reuses the same route internals as the renderer (turn acceptance, trust
 * grants, History-checkpointed additions), so a CLI-initiated action obeys
 * identical conflict, trust, and persistence rules. Registering a folder
 * through the act lane deliberately has no renderer folder-picker grant:
 * possession of the per-launch act token is that caller's authorization.
 */
export function createAmpleFileActFacade(state: LocalApiState): AmpleFileActFacade {
  const resolveConnectedFolder = async (selector: string): Promise<ConnectedFolderSummary> => {
    const resolved = resolveAmpleFileCliConnectedFolderSelector(await listConnectedFolders(), selector.trim() || undefined);
    if (!resolved) throw new AmpleFileCliError("usage", "Act commands require an explicit --connected-folder <id-or-name>.");
    return resolved;
  };
  /**
   * Per–Connected Folder appearance undo slot for this app run: the customization a
   * receipted appearance act displaced and the customization it left in
   * place. `connected-folders appearance undo` swaps them; a desktop-side change makes
   * the recorded slot stale, which the equality check below turns into a
   * typed refusal instead of restoring a state the receipt never described.
   */
  const appearanceUndoSlots = new Map<string, {
    displaced: ConnectedFolderAppearanceCustomization | null;
    result: ConnectedFolderAppearanceCustomization | null;
  }>();
  const currentAppearanceCustomization = (connectedFolderId: string): ConnectedFolderAppearanceCustomization | null =>
    state.appearance.snapshot().customizations[connectedFolderId] ?? null;
  /** The conversation PATCH route's 409s, mapped to CLI conflict errors. */
  const assertChatMutable = (connectedFolderId: string, conversationId: string): void => {
    const key = clientKey(connectedFolderId, conversationId);
    if (state.runningTurns.has(key)) {
      throw new AmpleFileCliError("conflict", "Wait for the current turn to finish.");
    }
    if (state.compactingConversations.has(key)) {
      throw new AmpleFileCliError("conflict", "Wait for the current Chat compaction to finish.");
    }
  };
  const requireConversationSummary = async (
    connectedFolderRoot: string,
    conversationId: string,
  ): Promise<ConversationSummary> => {
    const summary = await runActOperation(() => readConversationSummary(connectedFolderRoot, conversationId));
    if (!summary) throw new AmpleFileCliError("notFound", "Conversation not found.");
    return summary;
  };
  const chatAsk = async (connectedFolder: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">, input: Omit<Parameters<AmpleFileActFacade["chatAsk"]>[0], "connectedFolder">) => {
    assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
    const taskId = input.taskId.trim();
    if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <own-task-id>.");
    return runActOperation(async () => {
      const record = assertOwnTask(state, connectedFolder.id, taskId);
      // A root has nothing above it, so `parent` reaches the person and the
      // result says so (contract bullet 2). The asking turn is never
      // suspended: the turn goes on or ends as it likes; the request waits.
      const redirectedToPerson = input.respondent === "parent" && record.parentRequestId === null;
      const respondent = redirectedToPerson ? "person" : input.respondent;
      let question: AmpleFileQuestionRecord;
      try {
        question = await state.requests.ask({ requestId: record.requestId, taskId, respondent, text: input.question, ...(input.options?.length ? { options: input.options } : {}), ...(input.asynchronous ? { asynchronous: true } : {}) });
      } catch (error) {
        throw collaborationRefusal(error);
      }
      await recordFacadeAction(state, input.parentTaskId, { command: "chat.ask", connectedFolder, taskId });
      publishControlHint(state, "connected-folders");
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        taskId,
        question: toActQuestionRef(question),
        request: toActRequestRefForConnectedFolder(state, state.requests.get(record.requestId) ?? record),
        redirectedToPerson,
      };
    });
  };
  const chatAnswer = async (connectedFolder: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">, input: Omit<Parameters<AmpleFileActFacade["chatAnswer"]>[0], "connectedFolder">) => {
    assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
    const questionId = input.questionId.trim();
    if (!questionId) throw new AmpleFileCliError("usage", "Provide --question <id>.");
    const answer = input.answer.trim();
    if (!answer) throw new AmpleFileCliError("usage", "Provide --answer <text>.");
    return runActOperation(async () => {
      const question = state.requests.question(questionId);
      if (!question) {
        throw new AmpleFileCliError("notFound", `Question not found. Requests are kept for ${state.requests.retentionDays()} days.`);
      }
      const record = state.requests.get(question.requestId);
      if (!record) throw new AmpleFileCliError("notFound", "The request that asked this question is no longer on record.");
      // An answer is recorded before its continuation starts. Every fence
      // acceptance applies is checked first, but a turn can still start in
      // that Chat between the two, and a crash can land between them, so
      // "answered with no follow-up" is a reachable state. Sending the same
      // answer again resumes from exactly there — the recorded answer
      // stands and its one continuation starts now — rather than refusing
      // and leaving the answer with nowhere to go (one accepted answer starts
      // exactly one linked continuation).
      const resuming = question.state === "answered" && question.continuationTaskId === null;
      if (resuming && question.asynchronous && !ampleFileAnswerMatchesRecorded(question, answer)) throw new AmpleFileCliError("conflict", "That question already has a different recorded answer. Retry the same answer to continue it.");
      // Every other refusal is named before anything changes: a second
      // answer, an expired question, a closed request, the wrong Connected Folder, a
      // busy Chat.
      if (question.state === "answered" && !resuming) {
        throw new AmpleFileCliError("conflict", "That question already has an answer.");
      }
      if (question.state === "cancelled") throw new AmpleFileCliError("conflict", "That request was stopped, so its question is closed.");
      if (!resuming && (question.state === "expired" || (question.expiresAt !== null && Date.now() >= Date.parse(question.expiresAt)))) {
        throw new AmpleFileCliError("conflict", requestLimitRefusalMessage("questionLifetime"));
      }
      if ((record.owner.connectedFolderId ?? ampleFileAgentScopeId) !== connectedFolder.id) {
        const owner = record.owner.connectedFolderName ?? record.owner.connectedFolderId ?? "the AmpleFile Agent";
        throw new AmpleFileCliError("conflict", `Question ${questionId} belongs to ${owner}; answer it there.`);
      }
      const root = state.requests.get(record.rootId) ?? record;
      if (root.stopRequestedAt !== null || record.stopRequestedAt !== null) {
        throw new AmpleFileCliError("conflict", "That request was stopped, so its question is closed.");
      }
      if (root.state === "expired" || record.state === "expired") {
        throw new AmpleFileCliError("conflict", requestLimitRefusalMessage("questionLifetime"));
      }
      // Every fence acceptance would apply is checked before the question
      // flips, so a refusal leaves it open and answerable later: a busy
      // Chat, a capability change in flight, an archived or snoozed Chat.
      const answerKey = clientKey(connectedFolder.id, record.owner.conversationId);
      const queued = question.asynchronous === true && (state.runningTurns.has(answerKey) || state.compactingConversations.has(answerKey));
      if (!queued) assertChatMutable(connectedFolder.id, record.owner.conversationId);
      assertNoCapabilityMutationForTurn(state, connectedFolder.id);
      const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, record.owner.conversationId);
      if (summary.archivedAt) throw new AmpleFileCliError("conflict", "Restore this Chat before answering its question.");
      if (summary.snoozedUntil && Date.parse(summary.snoozedUntil) > Date.now()) {
        throw new AmpleFileCliError("conflict", "Resume this Chat before answering its question.");
      }
      let answered: AmpleFileQuestionRecord = question;
      if (!resuming) {
        try {
          answered = await state.requests.answer({ questionId, answer, ...(connectedFolder.id === ampleFileAgentScopeId ? {} : { answeredByConnectedFolderId: connectedFolder.id }) });
        } catch (error) {
          throw collaborationRefusal(error);
        }
      }
      if (queued) {
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.answer", connectedFolder, conversationId: record.owner.conversationId });
        publishControlHint(state, "connected-folders");
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), question: toActQuestionRef(answered), continuation: null, queued: true, request: toActRequestRefForConnectedFolder(state, state.requests.get(record.requestId) ?? record) };
      }
      // Journal-first: the question is answered; now exactly one linked
      // continuation turn, deduplicated by the turn store under a request
      // id derived from the question so a replay returns the same turn.
      // The transcript gets an ordinary user message — the question id
      // stays in machine-local records. A resumed answer carries
      // the text already on record, so the Chat and the record say the same
      // thing. Should acceptance still fail here, the answer stays recorded
      // and sending it again picks up exactly where this left off.
      const delivered = resuming ? answered.answer ?? answer : answer;
      let accepted: Awaited<ReturnType<typeof acceptConversationTurn>>;
      try {
        accepted = await acceptConversationTurn(state, connectedFolder, record.owner.conversationId, {
          content: delivered,
          contextPaths: [],
          actorKind: "cli",
          requestId: `answer-${questionId}`,
          request: { joinRequestId: record.requestId, answeringQuestionId: questionId },
        });
      } catch (error) {
        throw new AmpleFileCliError(
          "failure",
          `The answer to question ${questionId} is recorded, but the Chat could not continue: ${errorMessage(error)}. Send the same answer again to continue it.`,
          { cause: error },
        );
      }
      const { message, taskId } = accepted;
      let linked = answered;
      try {
        linked = await state.requests.linkContinuation(questionId, taskId);
      } catch (error) {
        // The turn store already returned the one continuation for this
        // answer; a second link attempt (a replayed answer) is a no-op.
        if (!(error instanceof AmpleFileRequestLineageError)) throw error;
        linked = state.requests.question(questionId) ?? answered;
      }
      await recordFacadeAction(state, input.parentTaskId, {
        command: "chat.answer",
        connectedFolder,
        conversationId: record.owner.conversationId,
        taskId,
      });
      publishControlHint(state, "connected-folders");
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        question: toActQuestionRef(linked),
        continuation: { taskId, messageId: message.id, conversationId: record.owner.conversationId },
        request: toActRequestRefForConnectedFolder(state, state.requests.get(record.requestId) ?? record),
      };
    });
  };

  /**
   * The one door for every verb that installs code, widens a power, or
   * destroys data (docs/act-ledger.md): typed parameters and
   * pins composed by the calling method from live state, then the prepared-
   * act path — pin recheck inside the capability fence, one internal kernel
   * task, the same domain internals the desktop uses — run at once under the
   * act request's journaled id. The act executor wrote the accepted receipt
   * before this method was reached and writes the terminal line after;
   * nothing here waits on a person. Returns the request id the act ran under.
   */
  const runPreparedAct = async (input: {
    kind: PreparedActKind;
    parameters: PreparedActFields;
    pins: PreparedActFields;
    requestId?: string;
    context?: unknown;
  }): Promise<string> => {
    const requestId = input.requestId?.trim() || randomUUID();
    // The journaled request id is the receipt id a Recently deleted entry records
    // (docs/act-ledger.md), so the destroying adapters can read
    // it back off the same context slot they report their outcome through.
    if (input.context && typeof input.context === "object") {
      (input.context as { requestId?: string }).requestId ??= requestId;
    }
    await runActOperation(() => runPreparedActOperation(async () => {
      const act = prepareAct({ kind: input.kind, parameters: input.parameters, pins: input.pins });
      await state.preparedActs.run({ act, requestId, context: input.context });
    }));
    return requestId;
  };
  /** Connected Folder–scoped capability changes require the Connected Folder's project trust, exactly as the desktop routes do. */
  const assertConnectedFolderCapabilityTrust = async (connectedFolder: ConnectedFolderSummary): Promise<void> => {
    if (!await isPiProjectMutationTrusted(connectedFolder.connectedFolderRoot, state.runtimeProvider)) {
      throw new AmpleFileCliError("permissionDenied", "Trust this Connected Folder before changing Connected Folder–scoped capabilities.");
    }
  };
  /**
   * Whole–Connected Folder restore replaces the working set running work may be reading,
   * so the act lane refuses concurrency the desktop still leaves to a confirm
   * dialog (docs/act-ledger.md, conflict rule 7). The live route state
   * covers turns and compactions; the kernel's
   * experimental fence covers active automation runs with files hops into the
   * Connected Folder and running background jobs there (the ledger's item 4).
   */
  const assertConnectedFolderQuietForHistoryRestore = async (connectedFolderId: string): Promise<void> => {
    const prefix = `${connectedFolderId}:`;
    if ([...state.runningTurns].some((key) => key.startsWith(prefix))) {
      throw new AmpleFileCliError("conflict", "Wait for the running turn in this Connected Folder to finish before restoring.");
    }
    if ([...state.compactingConversations].some((key) => key.startsWith(prefix))) {
      throw new AmpleFileCliError("conflict", "Wait for the running Chat compaction in this Connected Folder to finish before restoring.");
    }
    const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(connectedFolderId);
    if (blockers.length) throw new AmpleFileCliError("conflict", blockers[0]!);
  };
  return {
    async workerShow(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const [status, instructions, models] = await Promise.all([
        runActOperation(() => getPiSetupStatus(connectedFolder.connectedFolderRoot, state.runtimeProvider)),
        runActOperation(() => getPiWorkerInstructions(connectedFolder.connectedFolderRoot, state.runtimeProvider)),
        runActOperation(() => listPiModels(connectedFolder.connectedFolderRoot, state.runtimeProvider)),
      ]);
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        model: status.provider && status.model ? { provider: status.provider, id: status.model } : null,
        availableModels: models
          .filter((model) => model.authConfigured)
          .map((model) => ({ provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning })),
        instructions,
      };
    },
    async workerSetModel(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const selected = await runActOperation(() => runCapabilityMutation(state, connectedFolder, "project", async () => {
        const match = (await listPiModels(connectedFolder.connectedFolderRoot, state.runtimeProvider))
          .find((model) => model.provider === input.provider.trim() && model.id === input.model.trim());
        if (!match) throw new AmpleFileCliError("usage", "The selected model is not available in this Connected Folder.");
        if (!match.authConfigured) {
          throw new AmpleFileCliError("permissionDenied", "Connect this provider in Settings → AI Models before assigning its model.");
        }
        await setPiDefaultModel(
          connectedFolder.connectedFolderRoot,
          { provider: match.provider, id: match.id },
          state.runtimeProvider,
        );
        return match;
      }, { requireProjectTrust: false }));
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.worker.model", connectedFolder });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), model: { provider: selected.provider, id: selected.id } };
    },
    async workerSetInstructions(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      let instructions: string;
      let appended: boolean | undefined;
      const saved = input.append ? await runActOperation(() => getPiWorkerInstructions(connectedFolder.connectedFolderRoot, state.runtimeProvider)) : "";
      try {
        if (input.append) {
          const line = normalizeWorkerInstructions(input.instructions);
          if (!line) throw new Error("Provide the line to add.");
          const current = normalizeWorkerInstructions(saved);
          // The same remembered line twice adds nothing.
          appended = !current.split("\n").some((existing) => existing.trim() === line);
          instructions = appended ? normalizeWorkerInstructions(current ? `${current}\n${line}` : line) : current;
        } else {
          instructions = normalizeWorkerInstructions(input.instructions);
        }
      } catch (error) {
        throw new AmpleFileCliError("usage", errorMessage(error));
      }
      if (appended !== false) await runActOperation(() => saveWorkerInstructions(state, connectedFolder, instructions));
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.worker.instructions", connectedFolder });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), instructions, ...(appended !== undefined ? { appended } : {}) };
    },
    async createConversation(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const conversation = await runActOperation(() => createConversation(connectedFolder.connectedFolderRoot));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), conversation: toActConversationRef(conversation) };
    },
    async listConversations(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const conversations = await runActOperation(() => listConversations(connectedFolder.connectedFolderRoot));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), conversations: conversations.map(toActConversationRef) };
    },
    async sendMessage(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const content = input.content.trim();
      if (!content) throw new AmpleFileCliError("usage", "Message content is required.");
      if (!input.conversationId && !input.newConversation) {
        throw new AmpleFileCliError("usage", "Provide --conversation <id> or --new.");
      }
      return runActOperation(async () => {
        assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
        if (input.parentTaskId) {
          await state.beforeAmpleFileAgentActionRecord?.({ parentTaskId: input.parentTaskId, command: "chat.send", taskId: "" });
        }
        const conversationId = input.newConversation
          ? (await createConversation(connectedFolder.connectedFolderRoot)).id
          : input.conversationId!;
        // A delegated send is a child request under the named parent.
        // The parent check and every request bound run inside acceptance,
        // before the user message lands, so a refused child is never
        // accepted and then cancelled.
        const { message, taskId } = await acceptConversationTurn(state, connectedFolder, conversationId, {
          content,
          contextPaths: [],
          actorKind: "cli",
          requestId: input.requestId,
          ...(input.parentTaskId ? { request: { parentTaskId: input.parentTaskId } } : {}),
        });
        await recordLandedAction(state, input.parentTaskId, {
          command: "chat.send",
          at: new Date().toISOString(),
          connectedFolderId: connectedFolder.id,
          connectedFolderName: connectedFolder.name,
          conversationId,
          taskId,
        });
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), conversationId, messageId: message.id, taskId };
      });
    },
    async conversationStatus(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const summary = await runActOperation(() => readConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId));
      if (!summary) throw new AmpleFileCliError("notFound", "Conversation not found.");
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        conversation: toActConversationRef(summary),
        state: conversationRuntimeState(state, connectedFolder.id, input.conversationId),
      };
    },
    async conversationResult(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const result = await conversationResultForScope(state, connectedFolder.id, connectedFolder.connectedFolderRoot, input.conversationId, input.messages);
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...result };
    },
    async abortTurn(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const client = state.clients.get(clientKey(connectedFolder.id, input.conversationId));
      const request = state.requests.latestForConversation(input.conversationId, { connectedFolderId: connectedFolder.id });
      const stopped = request ? await stopAmpleFileAgentRequest(state, request.turns.at(-1)!.taskId) : null;
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        conversationId: input.conversationId,
        aborted: stopped ? stopped.ampleFileAgentAborted || stopped.children.some(child => child.aborted) : client ? await client.abort() : false,
      };
    },
    async turnStatus(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      const task = turnStatusFor(state, connectedFolder.id, taskId);
      const record = state.requests.byTaskId(taskId);
      // Both fields are scoped to the named Connected Folder: a task id is easy to come
      // by, and a question another Connected Folder's agent asked is that Connected Folder's
      // content, never this caller's (docs/collaboration-contract.md).
      const owned = record !== null && record.owner.connectedFolderId === connectedFolder.id;
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        task,
        waiting: owned ? waitingRefForTask(state, taskId) : null,
        request: owned ? toActRequestRefForConnectedFolder(state, record) : null,
      };
    },
    async turnResult(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      const result = await turnResultForScope(state, connectedFolder.id, connectedFolder.connectedFolderRoot, taskId);
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...result };
    },
    // --- the collaboration verbs (docs/collaboration-contract.md) ---
    async chatReport(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <own-task-id>.");
      return runActOperation(async () => {
        const record = assertOwnTask(state, connectedFolder.id, taskId);
        const data = input.dataPath !== undefined
          ? await readReportDataFile(input.dataPath, input.cwd ?? connectedFolder.connectedFolderRoot)
          : input.data;
        const files = await resolveReportFiles(connectedFolder, input.files);
        let result;
        try {
          result = await state.requests.recordResult({
            requestId: record.requestId,
            taskId,
            receiptId: input.requestId ?? `direct-${randomUUID()}`,
            envelope: {
              summary: input.summary,
              ...(data !== undefined ? { data } : {}),
              ...(files.length ? { files } : {}),
              outcome: input.outcome,
            },
          });
        } catch (error) {
          const refusal = collaborationRefusal(error);
          if (refusal !== error) throw refusal;
          // A report the envelope rules refuse is the agent's to correct, so
          // it reads as a usage refusal naming the field, not a failure.
          throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
        }
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.report", connectedFolder, taskId });
        publishControlHint(state, "connected-folders");
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          taskId,
          resultId: result.resultId,
          result: result.envelope,
          request: toActRequestRefForConnectedFolder(state, state.requests.get(record.requestId) ?? record),
        };
      });
    },
    async chatChildren(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const own = assertOwnTask(state, connectedFolder.id, input.taskId);
      return { children: state.requests.children(own.requestId).map(child => ({ taskId: child.turns.at(-1)!.taskId, conversationId: child.owner.conversationId, ...(child.owner.connectedFolderId ? { connectedFolderId: child.owner.connectedFolderId } : {}), state: child.state, resultAvailable: child.results.length > 0 })) };
    },
    async chatAsk(input) { return chatAsk(await resolveConnectedFolder(input.connectedFolder), input); },
    async chatAnswer(input) { return chatAnswer(await resolveConnectedFolder(input.connectedFolder), input); },
    async agentAsk(input) {
      const scope = ampleFileAgentScope(state);
      const { connectedFolder: _connectedFolder, ...result } = await chatAsk({ id: scope.id, connectedFolderRoot: scope.rootPath, name: "AmpleFile Agent" }, { ...input, respondent: "person" });
      return result;
    },
    async agentAnswer(input) {
      const scope = ampleFileAgentScope(state);
      const { connectedFolder: _connectedFolder, ...result } = await chatAnswer({ id: scope.id, connectedFolderRoot: scope.rootPath, name: "AmpleFile Agent" }, input);
      return result;
    },
    async chatHandoff(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const destination = await resolveConnectedFolder(input.toConnectedFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <own-task-id>.");
      const content = input.message.trim();
      if (!content) throw new AmpleFileCliError("usage", "Message content is required.");
      return runActOperation(async () => {
        const record = assertOwnTask(state, connectedFolder.id, taskId);
        // Every bound that could refuse the child is checked before a single
        // byte is copied, naming the limit.
        try {
          state.requests.assertCanAddChild(taskId);
        } catch (error) {
          throw collaborationRefusal(error);
        }
        if (destination.id === connectedFolder.id && input.files.length) {
          throw new AmpleFileCliError(
            "usage",
            "A handoff to the same Connected Folder needs no copies: the files are already there, so leave --file off.",
          );
        }
        const sources = input.files.map((file) => resolveHandoffSource(connectedFolder, file));
        // A follow-up goes into a Chat this Chat already handed work to, so
        // that Worker keeps everything it learned.
        const followUpId = input.toConversationId?.trim();
        if (followUpId) {
          if (!(await readConversationSummary(destination.connectedFolderRoot, followUpId))) throw new AmpleFileCliError("notFound", "Conversation not found.");
          assertCallerHandedWorkTo(state, taskId, { connectedFolderId: destination.id, conversationId: followUpId });
          const key = clientKey(destination.id, followUpId);
          if (state.runningTurns.has(key) || state.compactingConversations.has(key)) {
            throw new AmpleFileCliError("conflict", "That Chat is still working. Redirect it with chat steer, or wait for it and follow up.");
          }
        }
        // Copy first, through the same additive, restore-pointed path as
        // `files add`, so a refused copy never leaves a started Chat behind.
        const copy = sources.length
          ? await addExternalFilesInternal(destination, { fromPaths: sources, cwd: destination.connectedFolderRoot })
          : { copied: [], checkpointId: null };
        const conversation = followUpId ? { id: followUpId } : await createConversation(destination.connectedFolderRoot);
        const { message, taskId: childTaskId } = await acceptConversationTurn(state, destination, conversation.id, {
          content,
          contextPaths: [],
          actorKind: "cli",
          requestId: input.requestId,
          request: { parentTaskId: taskId, kind: "connected-folder" },
        });
        await recordFacadeAction(state, input.parentTaskId, {
          command: "chat.handoff",
          connectedFolder: destination,
          conversationId: conversation.id,
          taskId: childTaskId,
          checkpointId: copy.checkpointId,
          copied: copy.copied,
        });
        publishControlHint(state, "connected-folders");
        const child = state.requests.byTaskId(childTaskId);
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          toConnectedFolder: toActConnectedFolderRef(destination),
          conversationId: conversation.id,
          messageId: message.id,
          taskId: childTaskId,
          copied: copy.copied,
          checkpointId: copy.checkpointId,
          request: toActRequestRefForConnectedFolder(state, child ?? record),
          ...(followUpId ? { followUp: true } : {}),
        };
      });
    },
    async chatSteer(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const conversationId = input.conversationId.trim();
      const content = input.message.trim();
      if (!content) throw new AmpleFileCliError("usage", "Message content is required.");
      return runActOperation(async () => {
        if (!(await readConversationSummary(connectedFolder.connectedFolderRoot, conversationId))) throw new AmpleFileCliError("notFound", "Conversation not found.");
        const callerTaskId = input.taskId?.trim();
        if (callerTaskId) assertCallerHandedWorkTo(state, callerTaskId, { connectedFolderId: connectedFolder.id, conversationId });
        const running = state.runningTurns.has(clientKey(connectedFolder.id, conversationId));
        let steered: Awaited<ReturnType<typeof steerConversationTurn>>;
        try {
          steered = await steerConversationTurn(state, connectedFolder, conversationId, { content, ...(input.requestId ? { requestId: input.requestId } : {}) });
        } catch (error) {
          if ((error as { statusCode?: unknown })?.statusCode === 409) {
            throw new AmpleFileCliError("conflict", running
              ? "That Chat's turn is starting or finishing and cannot take a message right now. Try again in a moment, or follow up once it ends."
              : "That Chat has no turn running. Follow up with chat handoff --to-conversation, or chat send.");
          }
          throw error;
        }
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.steer", connectedFolder, conversationId, taskId: steered.taskId });
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), conversationId, taskId: steered.taskId, messageId: steered.message.id, replayed: steered.replayed };
      });
    },
    async chatCopy(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const sourceId = input.conversationId.trim();
      const content = input.message?.trim();
      if (input.message !== undefined && !content) throw new AmpleFileCliError("usage", "Message content is required.");
      return runActOperation(async () => {
        const callerTaskId = input.taskId?.trim();
        if (callerTaskId) {
          // A Worker copies its own Chat, or one its Chat handed work to.
          const caller = assertCallerTurn(state, callerTaskId);
          const ownChat = (caller.owner.connectedFolderId ?? ampleFileAgentScopeId) === connectedFolder.id && caller.owner.conversationId === sourceId;
          if (!ownChat) assertCallerHandedWorkTo(state, callerTaskId, { connectedFolderId: connectedFolder.id, conversationId: sourceId });
          try {
            state.requests.assertCanAddChild(callerTaskId);
          } catch (error) {
            throw collaborationRefusal(error);
          }
        }
        const copied = await copyConversation(state, connectedFolder, sourceId, input.title);
        let started: { taskId: string } | null = null;
        if (content) {
          started = await acceptConversationTurn(state, connectedFolder, copied.conversation.id, {
            content,
            contextPaths: [],
            actorKind: "cli",
            requestId: input.requestId,
            ...(callerTaskId ? { request: { parentTaskId: callerTaskId, kind: "connected-folder" as const } }
              : input.parentTaskId ? { request: { parentTaskId: input.parentTaskId } } : {}),
          });
        }
        await recordFacadeAction(state, input.parentTaskId, {
          command: "chat.copy", connectedFolder, conversationId: copied.conversation.id, ...(started ? { taskId: started.taskId } : {}),
        });
        publishControlHint(state, "connected-folders");
        const child = started ? state.requests.byTaskId(started.taskId) : null;
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(copied.conversation),
          copiedFromConversationId: sourceId,
          copiedMessages: copied.copiedMessages,
          ...(started ? { taskId: started.taskId } : {}),
          ...(child ? { request: toActRequestRefForConnectedFolder(state, child) } : {}),
        };
      });
    },
    async requestsList(input) {
      await assertRequestsAboveConnectedFolders(input?.cwd);
      const roots = state.requests.list()
        .filter((record) => record.requestId === record.rootId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        requests: roots.map((record) => requestSummaryView(state, record)),
        truncated: false,
      };
    },
    async requestsShow(input) {
      await assertRequestsAboveConnectedFolders(input.cwd);
      const requestId = input.request.trim();
      const record = requestId ? state.requests.get(requestId) : null;
      if (!record) {
        throw new AmpleFileCliError("notFound", `Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
      }
      return { request: await requestDetailView(state, record) };
    },
    // Background jobs (docs/background-jobs.md): the same service and records
    // as job_start, job_output, and job_stop.
    async jobsStart(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      assertOwnTask(state, connectedFolder.id, input.taskId);
      const cwd = input.cwd?.trim()
        ? (isAbsolute(input.cwd.trim()) ? resolve(input.cwd.trim()) : resolve(connectedFolder.connectedFolderRoot, input.cwd.trim()))
        : connectedFolder.connectedFolderRoot;
      // The Connected Folder's own Pi shell settings, so a job runs the way its bash would.
      const runtime = await resolvePiRuntime(connectedFolder.connectedFolderRoot, state.runtimeProvider, { requestProjectTrust: false }).catch(() => null);
      const shell: AmpleFileJobShell | undefined = runtime ? {
        ...(runtime.settingsManager.getShellPath() ? { shellPath: runtime.settingsManager.getShellPath() } : {}),
        ...(runtime.settingsManager.getShellCommandPrefix() ? { commandPrefix: runtime.settingsManager.getShellCommandPrefix() } : {}),
        binDir: join(runtime.agentDir, "bin"),
      } : undefined;
      const job = await runJobOperation(() => startBackgroundJob(state, {
        taskId: input.taskId,
        command: input.command,
        ...(input.interactive ? { interactive: true } : {}),
        ...(input.service ? { service: true } : {}),
        ...(input.name ? { name: input.name } : {}),
        cwd,
        ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
        surface: "cli",
        ...(shell ? { shell } : {}),
      }));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), job: toActJobRef(job) };
    },
    async jobsInput(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const record = assertOwnTask(state, connectedFolder.id, input.taskId);
      const host = createBackgroundJobToolHost(state, connectedFolder.id, record.owner.conversationId);
      const job = await host.input!({ taskId: input.taskId, jobId: input.jobId, text: input.text, ...(input.eof ? { eof: true } : {}) });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), job: toActJobRef(job) };
    },
    async worktreesManage(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return createWorktreeToolHost(state, connectedFolder.id).invoke(input.taskId, input);
    },
    async jobsList(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const jobs = state.jobs.list({
        connectedFolderId: connectedFolder.id,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.running ? { running: true } : {}),
      });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), jobs: jobs.map(toActJobRef) };
    },
    async jobsShow(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), job: toActJobRef(ownedJob(state, connectedFolder.id, input.jobId)) };
    },
    async jobsOutput(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const owned = ownedJob(state, connectedFolder.id, input.jobId);
      let until: RegExp | undefined;
      try {
        until = parseUntilPattern(input.until);
      } catch (error) {
        throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
      }
      const waited = (input.waitSeconds ?? 0) > 0 || until
        ? await state.jobs.wait(owned.jobId, {
          seconds: input.waitSeconds ?? 0,
          ...(until ? { until } : {}),
          ...(input.offset !== undefined ? { fromLine: input.offset } : {}),
        })
        : null;
      const { job, output } = await state.jobs.read(owned.jobId, {
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      // A read from a running turn in the job's own Chat is its delivery.
      if (input.taskId && isAmpleFileJobTerminalState(job.state) && job.settledAt && state.requests.isAccepting(input.taskId)
        && state.requests.byTaskId(input.taskId)?.owner.conversationId === job.conversationId
        && (state.requests.byTaskId(input.taskId)?.owner.connectedFolderId ?? null) === (job.connectedFolderId ?? null)) {
        await deliverBackgroundJobs(state, [job], "read", input.taskId);
      }
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        job: toActJobRef(state.jobs.get(job.jobId) ?? job),
        output,
        wait: waited ? {
          outcome: waited.outcome,
          ...(waited.outcome === "matched" ? { line: waited.line, text: waited.text } : {}),
        } : null,
      };
    },
    async jobsStop(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const owned = ownedJob(state, connectedFolder.id, input.jobId);
      const job = await runJobOperation(() => stopBackgroundJob(state, owned.jobId, "cli", input.parentTaskId));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), job: toActJobRef(job) };
    },
    async chatRename(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const title = input.title.trim();
      if (!title) throw new AmpleFileCliError("usage", "Chat title is required.");
      return runActOperation(() => runConversationMutation(state, connectedFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId);
        const conversation = await runActOperation(() => renameConversation(connectedFolder.connectedFolderRoot, input.conversationId, title));
        state.clients.get(clientKey(connectedFolder.id, input.conversationId))?.setSessionName(conversation.title);
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.rename", connectedFolder, conversationId: conversation.id });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(conversation),
          priorTitle: summary.title,
        };
      }));
    },
    async chatSnooze(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const until = input.until.trim();
      if (!Number.isFinite(Date.parse(until))) throw new AmpleFileCliError("usage", "Snooze time is invalid.");
      if (Date.parse(until) <= Date.now()) throw new AmpleFileCliError("usage", "Choose a future snooze time.");
      return runActOperation(() => runConversationMutation(state, connectedFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId);
        if (summary.archivedAt) throw new AmpleFileCliError("conflict", "Unarchive this Chat before snoozing it.");
        const conversation = await runActOperation(() =>
          updateConversationLifecycle(connectedFolder.connectedFolderRoot, input.conversationId, { snoozedUntil: until }));
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.snooze", connectedFolder, conversationId: conversation.id });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(conversation),
          priorLifecycle: toActChatLifecycleState(summary),
        };
      }));
    },
    async chatArchive(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(() => runConversationMutation(state, connectedFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId);
        if (summary.archivedAt) throw new AmpleFileCliError("conflict", "This Chat is already archived.");
        const conversation = await runActOperation(() =>
          updateConversationLifecycle(connectedFolder.connectedFolderRoot, input.conversationId, { archived: true }));
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.archive", connectedFolder, conversationId: conversation.id });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(conversation),
          priorLifecycle: toActChatLifecycleState(summary),
        };
      }));
    },
    async chatResume(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(() => runConversationMutation(state, connectedFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId);
        if (!summary.archivedAt && !summary.snoozedUntil) {
          throw new AmpleFileCliError("conflict", "This Chat is already active.");
        }
        // One lifecycle change per act, mirroring the renderer: an archived Chat
        // restores to Active; a snoozed (or snooze-expired) Chat clears its snooze.
        const conversation = await runActOperation(() =>
          updateConversationLifecycle(
            connectedFolder.connectedFolderRoot,
            input.conversationId,
            summary.archivedAt ? { archived: false } : { snoozedUntil: null },
          ));
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.resume", connectedFolder, conversationId: conversation.id });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(conversation),
          priorLifecycle: toActChatLifecycleState(summary),
        };
      }));
    },
    async chatCompact(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(async () => {
        // Exactly the composer's /compact route: same not-found check, same
        // capability-mutation fence, same 409s, and the same kernel
        // `compaction` task lifecycle — started before the compaction and
        // finished on every outcome, so no ghost task survives a failure.
        if (!(await readConversation(connectedFolder.connectedFolderRoot, input.conversationId)).length) {
          throw new AmpleFileCliError("notFound", "Conversation not found.");
        }
        const key = clientKey(connectedFolder.id, input.conversationId);
        assertNoCapabilityMutationForTurn(state, connectedFolder.id);
        assertChatMutable(connectedFolder.id, input.conversationId);
        state.compactingConversations.add(key);
        const task = state.kernel.startTask({
          kind: "compaction",
          connectedFolderId: connectedFolder.id,
          conversationId: input.conversationId,
          actor: { kind: "cli", cwd: connectedFolder.connectedFolderRoot, connectedFolderId: connectedFolder.id, conversationId: input.conversationId },
        });
        try {
          const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, input.conversationId);
          await client.compact();
          broadcast(state, streamKey(connectedFolder.id, input.conversationId), { type: "done", conversationId: input.conversationId });
        } finally {
          state.compactingConversations.delete(key);
          await refreshClientIfMarked(state, key);
          state.kernel.finishTask(task.id);
          queueConversationRequestEvaluation(state, connectedFolder.id, input.conversationId);
        }
        await recordFacadeAction(state, input.parentTaskId, {
          command: "chat.compact",
          connectedFolder,
          conversationId: input.conversationId,
          taskId: task.id,
        });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversationId: input.conversationId,
          compacted: true as const,
          taskId: task.id,
        };
      });
    },
    async historyList(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const page = await runActOperation(() => listConnectedFolderCheckpointPage(connectedFolder.connectedFolderRoot, input));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...page, checkpoints: page.checkpoints.map(toActCheckpointSummary) };
    },
    async historySave(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(async () => {
        // Same internals as the History pane's save route: an unchanged Connected Folder
        // returns the latest matching restore point instead of a duplicate.
        const existingIds = new Set(
          (await listConnectedFolderCheckpoints(connectedFolder.connectedFolderRoot, 1000)).map((checkpoint) => checkpoint.checkpointId),
        );
        const checkpoint = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, {
          ...(input.label !== undefined ? { label: input.label } : {}),
          reason: "manual",
        });
        await recordFacadeAction(state, input.parentTaskId, {
          command: "history.save",
          connectedFolder,
          checkpointId: checkpoint.checkpointId,
        });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          checkpoint: toActCheckpointSummary(checkpoint),
          created: !existingIds.has(checkpoint.checkpointId),
        };
      });
    },
    async historyRestore(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      await assertConnectedFolderQuietForHistoryRestore(connectedFolder.id);
      const result = await runActOperation(() => runHistoryRestore(state, connectedFolder, () => restoreConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, input.checkpointId)));
      await recordFacadeAction(state, input.parentTaskId, {
        command: "history.restore",
        connectedFolder,
        checkpointId: result.safetyCheckpointId,
      });
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        restored: true,
        checkpointId: result.checkpointId,
        safetyCheckpointId: result.safetyCheckpointId,
        restoredFileCount: result.restoredFiles.length,
        deletedFileCount: result.deletedFiles.length,
        movedEntryCount: result.movedEntries.length,
        unchangedFileCount: result.unchangedFiles,
        skippedLargeFileCount: result.skippedLargeFiles.length,
      };
    },
    async historyVersions(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const path = input.path.trim();
      if (!path) throw new AmpleFileCliError("usage", "A Connected Folder–relative file path is required.");
      const page = await runActOperation(() => listFileVersionPage(connectedFolder.connectedFolderRoot, path, input));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), path, ...page, versions: page.versions.map(toActFileVersionRef) };
    },
    async historyRead(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const review = await runActOperation(() => readHistoryFile(connectedFolder.connectedFolderRoot, input));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), review };
    },
    async historyDiff(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const comparison = await runActOperation(() => compareHistoryFile(connectedFolder.connectedFolderRoot, input));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), comparison };
    },
    async historyRestoreFile(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      if (!/^[a-f0-9]{64}$/i.test(input.version.trim())) {
        throw new AmpleFileCliError("usage", "Provide --version as the 64-character SHA-256 hash shown by 'history versions'.");
      }
      return runActOperation(async () => {
        const target = await stat(resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, input.path)).catch(() => null);
        if (target && !target.isFile()) {
          throw new AmpleFileCliError("conflict", "The selected path is currently a folder.");
        }
        const result = await runHistoryRestore(state, connectedFolder, () => restoreFileVersion(connectedFolder.connectedFolderRoot, input.path, input.version.trim()));
        await recordFacadeAction(state, input.parentTaskId, {
          command: "history.restore-file",
          connectedFolder,
          checkpointId: result.safetyCheckpointId,
        });
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...result };
      });
    },
    async filesMove(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const sourceRaw = input.fromPath.trim();
      if (!sourceRaw) throw new AmpleFileCliError("usage", "Select a file or folder to move.");
      return runActOperation(async () => {
        // Exactly the desktop move route: a targeted restore point that undoes
        // the move, then the mutation, with the unused restore point discarded
        // when the mutation fails.
        const moveSource = normalizeConnectedFolderRelativePath(sourceRaw);
        const moveTargetFolder = normalizeConnectedFolderRelativePath(input.toDir);
        const moveDestination = [moveTargetFolder, basename(moveSource)].filter(Boolean).join("/");
        const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
          movesOnRestore: [{ fromPath: moveDestination, toPath: moveSource }],
          reason: "pre_move",
          label: `Before moving ${sourceRaw}`,
        });
        const moved = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => moveConnectedFolderEntry(connectedFolder.connectedFolderRoot, {
          sourcePath: moveSource,
          targetFolderPath: input.toDir,
        }));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.move", connectedFolder, checkpointId: safety.checkpointId });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          fromPath: moved.fromPath,
          path: moved.path,
          kind: moved.kind,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesRename(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const sourceRaw = input.path.trim();
      const newName = input.newName.trim();
      if (!sourceRaw || !newName) throw new AmpleFileCliError("usage", "A Connected Folder item and new name are required.");
      return runActOperation(async () => {
        const renameSource = normalizeConnectedFolderRelativePath(sourceRaw);
        const renameParent = renameSource.includes("/") ? renameSource.slice(0, renameSource.lastIndexOf("/")) : "";
        const renameDestination = [renameParent, newName].filter(Boolean).join("/");
        const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
          movesOnRestore: [{ fromPath: renameDestination, toPath: renameSource }],
          reason: "pre_rename",
          label: `Before renaming ${sourceRaw}`,
        });
        const renamed = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => renameConnectedFolderEntry(connectedFolder.connectedFolderRoot, { path: sourceRaw, newName }));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.rename", connectedFolder, checkpointId: safety.checkpointId });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          fromPath: renamed.fromPath,
          path: renamed.path,
          priorName: basename(renameSource),
          kind: renamed.kind,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesDelete(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const target = input.path.trim();
      if (!target) throw new AmpleFileCliError("usage", "Select a file or folder to delete.");
      return runActOperation(async () => {
        const deleted = await deleteConnectedFolderEntryWithRecovery(state, connectedFolder, target, {
          receiptId: input.requestId ?? null,
        });
        await recordFacadeAction(state, input.parentTaskId, {
          command: "files.delete",
          connectedFolder,
          checkpointId: deleted.safetyCheckpointId,
        });
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...deleted };
      });
    },
    async filesMkdir(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const { target, parentPath, name } = splitActEntryPath(input.path, "A folder path is required.");
      return runActOperation(async () => {
        const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
          deleteOnRestore: [target],
          reason: "pre_create",
          label: `Before creating ${name}`,
        });
        const folder = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => createConnectedFolderFolder(connectedFolder.connectedFolderRoot, parentPath, name));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.mkdir", connectedFolder, checkpointId: safety.checkpointId });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          created: true as const,
          path: folder.path,
          kind: "folder" as const,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesCreate(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const { target, parentPath, name } = splitActEntryPath(input.path, "A file path is required.");
      return runActOperation(async () => {
        const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
          deleteOnRestore: [target],
          reason: "pre_create",
          label: `Before creating ${name}`,
        });
        const file = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => createConnectedFolderTextFile(connectedFolder.connectedFolderRoot, parentPath, name, ""));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.create", connectedFolder, checkpointId: safety.checkpointId });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          created: true as const,
          path: file.path,
          kind: "file" as const,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async search(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const query = input.query.trim();
      if (!query) throw new AmpleFileCliError("usage", "Enter something to search for.");
      const scope = input.scope ?? "all";
      const result = await runActOperation(() => searchConnectedFolder(connectedFolder.connectedFolderRoot, query, {
        includeFiles: scope !== "chats",
        includeChats: scope !== "files",
        path: input.path, cursor: input.cursor, maxMatches: input.limit,
      }));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), scope, ...result };
    },
    async createConnectedFolder(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const name = input.name.trim();
      if (!name) throw new AmpleFileCliError("usage", "A Connected Folder name is required.");
      const connectedFolder = await runActOperation(() => createConnectedFolderInternal(state, name));
      await recordLandedAction(state, input.parentTaskId, {
        command: "connected-folders.create",
        at: new Date().toISOString(),
        connectedFolderId: connectedFolder.id,
        connectedFolderName: connectedFolder.name,
        connectedFolderRoot: connectedFolder.connectedFolderRoot,
      });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder) };
    },
    async registerConnectedFolder(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const rootPath = input.connectedFolderRoot.trim();
      if (!rootPath || !isAbsolute(rootPath)) {
        throw new AmpleFileCliError("usage", "Provide an absolute folder path to register.");
      }
      const connectedFolder = await runActOperation(() => registerConnectedFolderInternal(state, rootPath));
      await recordLandedAction(state, input.parentTaskId, {
        command: "connected-folders.register",
        at: new Date().toISOString(),
        connectedFolderId: connectedFolder.id,
        connectedFolderName: connectedFolder.name,
        connectedFolderRoot: connectedFolder.connectedFolderRoot,
      });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder) };
    },
    async addFiles(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const result = await runActOperation(() => addExternalFilesInternal(connectedFolder, input));
      await recordLandedAction(state, input.parentTaskId, {
        command: "files.add",
        at: new Date().toISOString(),
        connectedFolderId: connectedFolder.id,
        connectedFolderName: connectedFolder.name,
        sources: input.fromPaths.map((raw) => {
          const trimmed = raw.trim();
          return isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
        }),
        copied: result.copied,
        checkpointId: result.checkpointId,
      });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...result };
    },
    async connectedFoldersRename(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const name = input.name.trim();
      if (!name) throw new AmpleFileCliError("usage", "A Connected Folder name is required.");
      // The ledger's ambiguous-making rule: a duplicate exact name under the
      // CLI selector's case-insensitive match would break `--connected-folder` selection
      // by name, so it is refused here. The comparison folds the same way the
      // selector does; renaming a Connected Folder to a case variant of itself stays
      // allowed.
      const folded = name.replace(/\s+/g, " ").slice(0, 80).toLocaleLowerCase("en-US");
      const collision = (await listConnectedFolders()).find((item) =>
        item.id !== connectedFolder.id && item.name.toLocaleLowerCase("en-US") === folded);
      if (collision) {
        throw new AmpleFileCliError(
          "conflict",
          `Another Connected Folder is already named ${collision.name} [${collision.id}]; a duplicate exact name would make --connected-folder selection ambiguous.`,
        );
      }
      const renamed = await runActOperation(() => renameConnectedFolder(connectedFolder.id, name));
      publishControlHint(state, "connected-folders");
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.rename", connectedFolder: renamed });
      return { connectedFolder: toActConnectedFolderRef(renamed), priorName: connectedFolder.name };
    },
    async connectedFoldersUnregister(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const storage = connectedFolder.location.storage;
      // Both storage kinds run the same removal orchestration — automation
      // suspension and a durable intent. A managed Connected Folder records a
      // preserve-disposition intent that provably holds no deletion
      // authority, so the folder and its portable `.amplefile/` identity
      // remain exactly as they do for a linked registration; deleting the
      // managed folder is `connected-folders delete`, a receipted act of its own.
      const removal = await runActOperation(() =>
        removeConnectedFolderRegistrationInternal(state, connectedFolder, {
          managedFolderDisposition: "preserve",
          receiptId: input.requestId ?? null,
        }));
      appearanceUndoSlots.delete(connectedFolder.id);
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.unregister", connectedFolder });
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        storage,
        removed: true as const,
        cleanupPending: removal.cleanupPending,
      };
    },
    async connectedFoldersAppearanceApply(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const proposal = input.proposalPath !== undefined ? await readConnectedFolderAppearanceProposalFile(input.proposalPath, input.cwd) : null;
      // Named parts are read and encoded first, so an unusable image refuses before anything changes.
      const parts = proposal ? null : await resolveConnectedFolderAppearanceParts(input.parts ?? {}, input.cwd).catch((error: unknown) => {
        if (error instanceof ConnectedFolderAppearancePartsError) throw new AmpleFileCliError(error.code, error.message, { cause: error });
        throw error;
      });
      if (!proposal && (!parts || !connectedFolderAppearancePartsLabel(parts))) {
        throw new AmpleFileCliError("usage", "Provide a proposal, or a banner image, icon, or color to change.");
      }
      if (proposal?.target?.connectedFolderId && proposal.target.connectedFolderId !== connectedFolder.id) {
        throw new AmpleFileCliError(
          "conflict",
          `This appearance proposal targets a different Connected Folder (${proposal.target.connectedFolderId}). Apply it with that --connected-folder, or use a proposal authored for this one.`,
        );
      }
      return runActOperation(async () => {
        const displaced = currentAppearanceCustomization(connectedFolder.id);
        // Exactly the Customize Connected Folder import route's mutation: the store
        // normalizes and persists the typed customization atomically. Named
        // parts change only themselves on top of the current appearance.
        const applied = await state.appearance.replaceConnectedFolder(
          connectedFolder.id,
          proposal ? proposal.customization : applyConnectedFolderAppearanceParts(displaced, parts!),
        );
        const result = applied.customizations[connectedFolder.id] ?? null;
        appearanceUndoSlots.set(connectedFolder.id, { displaced, result });
        await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.appearance.apply", connectedFolder });
        // An open window re-reads its startup state and shows the new look now.
        publishControlHint(state, "connected-folders");
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          applied: true as const,
          proposalName: proposal ? proposal.name : connectedFolderAppearancePartsLabel(parts!),
          appearanceRef: appearanceCustomizationRef(result),
          priorAppearanceRef: appearanceCustomizationRef(displaced),
        };
      });
    },
    async connectedFoldersAppearanceReset(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(async () => {
        const displaced = currentAppearanceCustomization(connectedFolder.id);
        if (displaced === null) {
          // An already-default Connected Folder is an honest no-op that arms no undo.
          return {
            connectedFolder: toActConnectedFolderRef(connectedFolder),
            reset: true as const,
            changed: false,
            priorAppearanceRef: null,
          };
        }
        await state.appearance.removeConnectedFolder(connectedFolder.id);
        appearanceUndoSlots.set(connectedFolder.id, { displaced, result: null });
        await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.appearance.reset", connectedFolder });
        // An open window re-reads its startup state and shows the new look now.
        publishControlHint(state, "connected-folders");
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          reset: true as const,
          changed: true,
          priorAppearanceRef: appearanceCustomizationRef(displaced),
        };
      });
    },
    async connectedFoldersAppearanceUndo(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const slot = appearanceUndoSlots.get(connectedFolder.id);
      if (!slot) {
        throw new AmpleFileCliError(
          "conflict",
          "No receipted appearance act recorded a prior customization for this Connected Folder in this app run, so there is nothing to undo. Apply a proposal or reset explicitly instead.",
        );
      }
      if (!appearanceCustomizationsEqual(currentAppearanceCustomization(connectedFolder.id), slot.result)) {
        throw new AmpleFileCliError(
          "conflict",
          "This Connected Folder's appearance was changed outside the act lane (for example on the desktop) since the last receipted appearance act, so the recorded prior customization no longer describes what an undo would displace. Apply a proposal or reset explicitly instead.",
        );
      }
      return runActOperation(async () => {
        const next = slot.displaced;
        const stateAfter = next !== null && hasConnectedFolderAppearanceCustomization(next)
          ? await state.appearance.replaceConnectedFolder(connectedFolder.id, next)
          : await state.appearance.removeConnectedFolder(connectedFolder.id);
        const restored = stateAfter.customizations[connectedFolder.id] ?? null;
        // Undo is its own inverse: the displaced and restored refs swap.
        appearanceUndoSlots.set(connectedFolder.id, { displaced: slot.result, result: restored });
        await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.appearance.undo", connectedFolder });
        // An open window re-reads its startup state and shows the new look now.
        publishControlHint(state, "connected-folders");
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          restored: true as const,
          restoredAppearanceRef: appearanceCustomizationRef(restored),
          displacedAppearanceRef: appearanceCustomizationRef(slot.result),
        };
      });
    },
    async toolsRemove(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const source = input.source.trim();
      if (!source) throw new AmpleFileCliError("usage", "A package source is required.");
      if (input.scope === "connected-folder") {
        const connectedFolder = await resolveConnectedFolder(input.connectedFolder ?? "");
        // Exactly the desktop packages/remove route: project scope requires
        // the Connected Folder's Pi project trust and the per–Connected Folder capability fence.
        const removed = await runActOperation(() => runCapabilityMutation(state, connectedFolder, "project", () =>
          removePiPackage(connectedFolder.connectedFolderRoot, source, {
            scope: "project",
            runtimeProvider: state.runtimeProvider,
          })));
        await recordFacadeAction(state, input.parentTaskId, { command: "tools.remove", connectedFolder });
        return { scope: "connected-folder" as const, connectedFolder: toActConnectedFolderRef(connectedFolder), source, removed };
      }
      // Everywhere scope mutates the user-scope Pi settings every
      // Connected Folder runtime loads. The app-owned management root is the resolution
      // context — the same root the AmpleFile Agent's own runtime
      // uses — and the global capability fence refuses while any agent
      // or compaction work is active anywhere.
      const ampleFileAgentRootScope = { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentRoot() };
      const removed = await runActOperation(() => runCapabilityMutation(state, ampleFileAgentRootScope, "global", () =>
        removePiPackage(ampleFileAgentRootScope.connectedFolderRoot, source, {
          scope: "user",
          runtimeProvider: state.runtimeProvider,
        })));
      await recordFacadeAction(state, input.parentTaskId, { command: "tools.remove" });
      return { scope: "everywhere" as const, source, removed };
    },
    async connectedFoldersDelete(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      if (connectedFolder.location.storage !== "managed") {
        throw new AmpleFileCliError(
          "conflict",
          "Only a managed Connected Folder's folder can be deleted. Removing a linked registration is 'connected-folders unregister'; the folder is yours either way.",
        );
      }
      const context: PreparedActOutcome<ConnectedFolderRemovalResult & {
        recentlyDeleted: { entryId: string; restoreBy: string } | null;
      }> = {};
      await runPreparedAct({
        kind: "connected-folder.delete-folder",
        parameters: { connectedFolderId: connectedFolder.id },
        pins: { connectedFolderId: connectedFolder.id, connectedFolderRoot: connectedFolder.connectedFolderRoot },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.delete", connectedFolder });
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        storage: "managed" as const,
        removed: true as const,
        cleanupPending: context.outcome?.cleanupPending ?? false,
        recentlyDeleted: context.outcome?.recentlyDeleted ?? null,
      };
    },
    async toolsImportSkill(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = input.scope === "connected-folder" ? await resolveConnectedFolder(input.connectedFolder ?? "") : undefined;
      const source = isAbsolute(input.from) ? resolve(input.from) : resolve(input.cwd, input.from);
      const info = await lstat(source).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile()) {
        throw new AmpleFileCliError("notFound", "The skill bundle must be a regular file on this machine.");
      }
      if (info.size > 100 * 1024 * 1024) {
        throw new AmpleFileCliError("usage", "The skill bundle exceeds the 100 MB archive limit.");
      }
      const bytes = await readFile(source);
      const contentDigest = piSkillBundleContentDigest(bytes);
      const skillNames = await enumerateSkillBundleNames(basename(source), bytes);
      if (connectedFolder) await assertConnectedFolderCapabilityTrust(connectedFolder);
      const scopedConnectedFolder: PreparedActFields = connectedFolder ? { connectedFolderId: connectedFolder.id } : {};
      const context: PreparedActOutcome<PiSkillBundleImportResult> = {};
      await runPreparedAct({
        kind: "capability.skills.import",
        parameters: { source, scope: input.scope, ...scopedConnectedFolder },
        pins: { source, contentDigest, skillNames },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "tools.import-skill", ...(connectedFolder ? { connectedFolder } : {}) });
      return {
        scope: input.scope,
        ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
        source,
        contentDigest,
        skillNames,
        bundlePath: context.outcome?.bundlePath ?? "",
      };
    },
    async toolsInstall(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = input.scope === "connected-folder" ? await resolveConnectedFolder(input.connectedFolder ?? "") : undefined;
      if (connectedFolder) await assertConnectedFolderCapabilityTrust(connectedFolder);
      const scopedConnectedFolder: PreparedActFields = connectedFolder ? { connectedFolderId: connectedFolder.id } : {};
      const record = async (): Promise<void> => {
        await recordFacadeAction(state, input.parentTaskId, { command: "tools.install", ...(connectedFolder ? { connectedFolder } : {}) });
      };
      const installBundle = async (source: string, contentDigest: string, skillNames: string[]) => {
        const context: PreparedActOutcome<PiSkillBundleImportResult> = {};
        await runPreparedAct({
          kind: "capability.skills.import",
          parameters: { source, scope: input.scope, ...scopedConnectedFolder },
          pins: { source, contentDigest, skillNames },
          requestId: input.requestId,
          context,
        });
        await record();
        return {
          scope: input.scope,
          ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
          source,
          contentDigest,
          skillNames,
          bundlePath: context.outcome?.bundlePath ?? "",
        };
      };
      const installPackage = async (
        parameters: PreparedActFields,
        details: { id: string; version: string; installSource: string },
        resourceSummary: string,
      ) => {
        await runPreparedAct({
          kind: "capability.package.install",
          parameters,
          pins: {
            packageId: details.id,
            version: details.version,
            source: details.installSource,
            scope: input.scope,
            resourceSummary,
          },
          requestId: input.requestId,
        });
        await record();
        return {
          scope: input.scope,
          ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
          source: details.installSource,
          packageId: details.id,
          version: details.version,
          resourceSummary,
          installed: true as const,
        };
      };
      if (input.catalogId !== undefined) {
        // Remote inspection is read-only and can take seconds; it completes
        // before anything is pinned, exactly as the desktop review does.
        const details = await runActOperation(() => state.capabilityRegistry.details(input.catalogId!));
        if (details.sourceKind === "reference") {
          throw new AmpleFileCliError("usage", "This capability is a reference and cannot be installed directly.");
        }
        if (details.sourceKind === "bundle") {
          // An official catalog skill bundle makes bytes runnable as a skill
          // import: the exact built bytes are digest-pinned, and execution
          // rebuilds and re-verifies them.
          const bundle = await runActOperation(() => state.capabilityRegistry.buildOfficialSkillBundle(input.catalogId!));
          const contentDigest = piSkillBundleContentDigest(bundle.bytes);
          const skillNames = details.skills?.length
            ? [...details.skills].sort()
            : await enumerateSkillBundleNames(bundle.fileName, bundle.bytes);
          return installBundle(input.catalogId, contentDigest, skillNames);
        }
        if (!details.installSource || !details.version) {
          throw new AmpleFileCliError(
            "unavailable",
            "AmpleFile cannot pin an exact version for this package source yet, so it cannot install it from here. Install it from Skills & Extensions on the desktop.",
          );
        }
        return installPackage(
          { catalogId: input.catalogId, scope: input.scope, ...scopedConnectedFolder },
          { id: details.id, version: details.version, installSource: details.installSource },
          capabilityResourceSummary(details),
        );
      }
      const identity = npmSourceIdentity(input.source ?? "");
      if (!identity) {
        throw new AmpleFileCliError(
          "unavailable",
          "AmpleFile can pin an exact version only for npm package sources yet, so it cannot install this source from here. Install it from Skills & Extensions on the desktop.",
        );
      }
      const details = await runActOperation(() => state.capabilityRegistry.details(`npm:${identity.packageName}`));
      if (!details.installSource || !details.version) {
        throw new AmpleFileCliError("unavailable", "npm did not report an exact installable version for this package.");
      }
      if (identity.pinnedVersion !== undefined && identity.pinnedVersion !== details.version) {
        throw new AmpleFileCliError(
          "conflict",
          `AmpleFile inspects the latest published version (${details.version}) and installs only that exact version; `
            + `the source pins ${identity.pinnedVersion}. Install without a version pin, or use the inspected version.`,
        );
      }
      return installPackage(
        { source: details.installSource, scope: input.scope, ...scopedConnectedFolder },
        { id: details.id, version: details.version, installSource: details.installSource },
        capabilityResourceSummary(details),
      );
    },
    async toolsSetEnabled(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = input.scope === "connected-folder" ? await resolveConnectedFolder(input.connectedFolder ?? "") : undefined;
      const root = connectedFolder?.connectedFolderRoot ?? ampleFileAgentRoot();
      if (connectedFolder) await assertConnectedFolderCapabilityTrust(connectedFolder);
      const act = await prepareResourceEnable(root, { path: input.path, kind: input.kind, enabled: input.enabled, scope: input.scope, ...(connectedFolder ? { connectedFolderId: connectedFolder.id } : {}) }, state.runtimeProvider);
      await runPreparedAct({ ...act, requestId: input.requestId });
      await recordFacadeAction(state, input.parentTaskId, { command: input.enabled ? "tools.enable" : "tools.disable", ...(connectedFolder ? { connectedFolder } : {}) });
      return { scope: input.scope, ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}), path: String(act.parameters.path), enabled: input.enabled };
    },
    async toolsUpdate(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = input.scope === "connected-folder" ? await resolveConnectedFolder(input.connectedFolder ?? "") : undefined;
      const source = input.source.trim();
      const identity = npmSourceIdentity(source);
      if (!identity) {
        throw new AmpleFileCliError(
          "unavailable",
          "AmpleFile can pin an exact version only for npm package sources yet, so it cannot update this source from here. Update it from Skills & Extensions on the desktop.",
        );
      }
      // Mirror the update path's configured-scope requirement early so the
      // refusal is honest; the capability fence is not needed for this read.
      const root = connectedFolder ? connectedFolder.connectedFolderRoot : ampleFileAgentRoot();
      const piScope = connectedFolder ? "project" : "user";
      const configured = (await runActOperation(() => listPiPackages(root, state.runtimeProvider)))
        .find((item) => item.source === source && item.scope === piScope);
      if (!configured) {
        throw new AmpleFileCliError("notFound", `Package is not configured in the requested scope: ${source}`);
      }
      if (connectedFolder) await assertConnectedFolderCapabilityTrust(connectedFolder);
      const details = await runActOperation(() => state.capabilityRegistry.details(`npm:${identity.packageName}`));
      if (!details.version) {
        throw new AmpleFileCliError("unavailable", "npm did not report an exact version for this package.");
      }
      const resourceSummary = capabilityResourceSummary(details);
      const scopedConnectedFolder: PreparedActFields = connectedFolder ? { connectedFolderId: connectedFolder.id } : {};
      await runPreparedAct({
        kind: "capability.package.update",
        parameters: { source, scope: input.scope, ...scopedConnectedFolder },
        pins: {
          packageId: details.id,
          version: details.version,
          source,
          scope: input.scope,
          resourceSummary,
        },
        requestId: input.requestId,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "tools.update", ...(connectedFolder ? { connectedFolder } : {}) });
      return {
        scope: input.scope,
        ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
        source,
        packageId: details.id,
        version: details.version,
        resourceSummary,
        updated: true as const,
      };
    },
    async automationsEnable(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const { declaration, digest } = await readAutomationStagingFile(input.proposalPath, input.cwd);
      const enabled = await enableStoredAutomationDeclaration(state, declaration, digest, {
        surface: "cli",
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "automations.enable" });
      return enabled;
    },
    async recentlyDeletedList() {
      const listing = await runActOperation(() => state.recentlyDeleted.list());
      const registered = new Set((await listConnectedFolders()).map((connectedFolder) => connectedFolder.id));
      const entries: AmpleFileActRecentlyDeletedEntry[] = [];
      for (const entry of listing.entries) entries.push(await recentlyDeletedEntryView(entry, registered));
      return { entries, retentionDays: listing.retentionDays, damagedCount: listing.damaged.length };
    },
    async recentlyDeletedRestore(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const entryId = input.entry.trim();
      if (!ampleFileRecentlyDeletedEntryIdPattern.test(entryId)) {
        throw new AmpleFileCliError("usage", "'--entry' takes a Recently deleted item id from 'recently-deleted list'.");
      }
      const before = await runActOperation(() => state.recentlyDeleted.get(entryId).catch(() => null));
      const restored = await runActOperation(() => restoreRecentlyDeletedEntry(state, entryId, {
        receiptId: input.requestId ?? null,
      }));
      const connectedFolder = "connectedFolder" in restored && restored.connectedFolder ? await getConnectedFolder(restored.connectedFolder.id).catch(() => null) : null;
      await recordFacadeAction(state, input.parentTaskId, {
        command: "recently-deleted.restore",
        ...(connectedFolder ? { connectedFolder } : {}),
      });
      // The entry id is the request's own input; the result reports what came
      // back, with the entry it came from alongside.
      const effect = restored.kind === "connected-folder"
        ? { kind: restored.kind, connectedFolder: restored.connectedFolder, connectedFolderRoot: restored.connectedFolderRoot, renamed: restored.renamed }
        : restored.kind === "skill"
          ? {
            kind: restored.kind,
            scope: restored.scope,
            ...(restored.connectedFolder ? { connectedFolder: restored.connectedFolder } : {}),
            name: restored.name,
            path: restored.path,
          }
          : {
            kind: restored.kind,
            connectedFolder: restored.connectedFolder,
            path: restored.path,
            renamed: restored.renamed,
            safetyCheckpointId: restored.safetyCheckpointId,
          };
      return {
        entry: before ? await recentlyDeletedEntryView(before) : null,
        restored: effect,
      };
    },
    async automationsList() {
      const projections = await runActOperation(() => state.automations.listAutomations());
      return { automations: projections.map(toActAutomationSummary) };
    },
    async automationsModels() {
      const models = await listPiModels(ampleFileAgentScopeForRoutes(state).rootPath, state.runtimeProvider);
      return {
        models: models.filter((model) => model.configured)
          .map((model) => ({ provider: model.provider, providerName: model.providerName, id: model.id, name: model.name, seesImages: model.input.includes("image") }))
          .sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name)),
      };
    },
    async automationsShow(input) {
      const automationId = input.automation.trim();
      const projection = await runActOperation(() => state.automations.getAutomation(automationId));
      if (!projection) throw new AmpleFileCliError("notFound", "No automation has this id on this machine.");
      const connectedFolderNames = new Map<string, string>();
      for (const connectedFolderId of ampleFileAutomationReferencedConnectedFolderIds(projection.declaration)) {
        const registered = await getConnectedFolder(connectedFolderId).catch(() => null);
        if (registered) connectedFolderNames.set(connectedFolderId, registered.name);
      }
      const named = (connectedFolderId: string) => (connectedFolderNames.has(connectedFolderId) ? { connectedFolderName: connectedFolderNames.get(connectedFolderId)! } : {});
      return {
        automation: {
          ...toActAutomationSummary(projection),
          steps: projection.declaration.steps.map((step) => step.kind === "chat"
            ? { id: step.id, kind: "chat" as const, connectedFolderId: step.connectedFolder, ...named(step.connectedFolder), message: step.message, ...(step.model ? { model: step.model } : {}) }
            : step.kind === "files"
              ? {
                id: step.id,
                kind: "files" as const,
                fromConnectedFolderId: step.fromConnectedFolder,
                ...(connectedFolderNames.has(step.fromConnectedFolder) ? { fromConnectedFolderName: connectedFolderNames.get(step.fromConnectedFolder)! } : {}),
                source: toActAutomationFilesSource(step.from),
                toConnectedFolderId: step.toConnectedFolder,
                ...(connectedFolderNames.has(step.toConnectedFolder) ? { toConnectedFolderName: connectedFolderNames.get(step.toConnectedFolder)! } : {}),
                to: step.to,
              }
              : { id: step.id, kind: "agent" as const, message: step.message, ...(step.model ? { model: step.model } : {}) }),
          grants: projection.grants.map((grant) => ({
            digest: grant.digest,
            requestId: grant.requestId,
            enabledAt: grant.enabledAt,
            surface: grant.surface,
          })),
        },
      };
    },
    async automationsRun(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const projection = await runActOperation(() => state.automations.getAutomation(automationId));
      if (!projection) throw new AmpleFileCliError("notFound", "No automation has this id on this machine.");
      const run = await runActOperation(() => state.automations.runNow(automationId, {
        ...(input.requestId ? { requestId: input.requestId } : {}),
      }));
      return {
        automationId,
        title: projection.declaration.title,
        run: {
          runId: run.runId,
          outcome: run.outcome,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          ...(run.error !== undefined ? { error: run.error } : {}),
        },
      };
    },
    async automationsStop(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const stopped = state.automations.stopRun(automationId);
      if (!stopped) {
        throw new AmpleFileCliError("conflict", "This automation has no active run; its settled state already stands.");
      }
      return { automationId, stopped: true as const, runId: stopped.runId };
    },
    async automationsDisable(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const result = await runActOperation(() => state.automations.disable(automationId));
      return {
        automationId,
        disabled: true as const,
        digest: result.record.digest,
        stoppedRunId: result.stoppedRunId,
      };
    },
    async automationsDelete(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const record = await runActOperation(() => state.automations.deleteAutomation(automationId));
      if (record.health !== "disabled" && record.health !== "suspended" && record.health !== "completed") {
        throw new AmpleFileCliError("failure", "The automation was deleted in an unexpected health state.");
      }
      return { automationId, deleted: true as const, digest: record.digest, finalHealth: record.health };
    },
    async automationsReceipts(input) {
      const projection = await readAutomationReceiptProjection(input.automation?.trim());
      return { ...projection, receipts: [...projection.receipts].reverse() };
    },
    async agentList() {
      const scope = ampleFileAgentScope(state);
      const conversations = await runActOperation(() => listConversations(scope.rootPath));
      return { conversations: conversations.map(toActConversationRef) };
    },
    async agentSend(input) {
      const content = input.content.trim();
      if (!content) throw new AmpleFileCliError("usage", "Message content is required.");
      const scope = ampleFileAgentScope(state);
      const attachments = await classifyActAmpleFileAgentAttachments(input.attachments ?? [], input.cwd);
      return runActOperation(async () => {
        const conversationId = input.newConversation
          ? (await createConversation(scope.rootPath)).id
          : input.conversationId ?? (await resolveAmpleFileAgentConversation(true)).id;
        const { message, taskId } = await acceptConversationTurn(state, { id: scope.id, connectedFolderRoot: scope.rootPath }, conversationId, {
          content,
          contextPaths: [],
          actorKind: "cli",
          ampleFileAgentAttachments: attachments,
          requestId: input.requestId,
        });
        return { conversationId, messageId: message.id, taskId, attachments };
      });
    },
    async agentConversationStatus(input) {
      const scope = ampleFileAgentScope(state);
      const conversation = input.conversationId
        ? await runActOperation(() => readConversationSummary(scope.rootPath, input.conversationId!))
        : await runActOperation(() => resolveAmpleFileAgentConversation(false).catch(() => null));
      if (!conversation) {
        throw new AmpleFileCliError(
          "notFound",
          input.conversationId ? "Conversation not found." : "No AmpleFile Agent exists yet. Send a message to start one.",
        );
      }
      return {
        conversation: toActConversationRef(conversation),
        state: conversationRuntimeState(state, scope.id, conversation.id),
      };
    },
    async agentTurnStatus(input) {
      assertAmpleFileAgentInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      const record = state.requests.byTaskId(taskId);
      return {
        task: turnStatusFor(state, ampleFileAgentScopeId, taskId),
        request: await ampleFileAgentRequestView(state, taskId),
        waiting: waitingRefForTask(state, taskId),
        requestGraph: record ? toActRequestRef(state, record) : null,
      };
    },
    async agentStop(input) {
      assertAmpleFileAgentInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      return stopAmpleFileAgentRequest(state, taskId);
    },
    async agentConversationResult(input) {
      const scope = ampleFileAgentScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveAmpleFileAgentConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new AmpleFileCliError("notFound", "No AmpleFile Agent exists yet. Send a message to start one.");
      }
      return conversationResultForScope(state, scope.id, scope.rootPath, conversationId, input.messages);
    },
    async agentTurnResult(input) {
      assertAmpleFileAgentInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      const scope = ampleFileAgentScope(state);
      return turnResultForScope(state, scope.id, scope.rootPath, taskId);
    },
    async agentAbort(input) {
      const scope = ampleFileAgentScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveAmpleFileAgentConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new AmpleFileCliError("notFound", "No AmpleFile Agent exists yet. Send a message to start one.");
      }
      const client = state.clients.get(clientKey(scope.id, conversationId));
      return { conversationId, aborted: client ? await client.abort() : false };
    },
    async agentOverview() {
      // Deliberately no management-readiness gate: the overview reads recorded
      // state through the kernel, never the agent, and stays available
      // while the AmpleFile Agent is not.
      return runActOperation(() => state.kernel.getOverview({ kind: "cli" }));
    },
  };
}

async function classifyActAmpleFileAgentAttachments(raw: string[], cwd: string | undefined): Promise<AmpleFileAgentAttachmentRef[]> {
  if (!raw.length) return [];
  try {
    return await classifyAmpleFileAgentAttachments(raw, cwd ?? ampleFileAgentRoot());
  } catch (error) {
    throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
  }
}

/**
 * Records an act whose effect has already landed. Attribution is the
 * receipt's story, not the act: if writing it fails, the act still succeeded,
 * and reporting an error would invite a retry that repeats the effect (a
 * second copy, a second turn). The failure is logged instead.
 */
async function recordLandedAction(
  state: LocalApiState,
  parentTaskId: string | undefined,
  action: Parameters<AmpleFileRequestStore["recordAction"]>[1],
): Promise<void> {
  try {
    await state.requests.recordAction(parentTaskId, action);
  } catch (error) {
    console.warn(`AmpleFile could not record ${action.command} on its request; the act itself completed: ${errorMessage(error)}`);
  }
}

/**
 * Attributes one applied facade mutation to its explicitly named management
 * request, so the request's recorded story stays complete across every landed
 * verb. Connected Folder–free acts (Everywhere-scope tools) record
 * no Connected Folder fields. `chat.send` keeps its own inline recording because it also
 * threads child-task bookkeeping and post-acceptance cancellation.
 */
async function recordFacadeAction(
  state: LocalApiState,
  parentTaskId: string | undefined,
  input: {
    command: AmpleFileRequestActionCommand;
    connectedFolder?: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">;
    conversationId?: string;
    checkpointId?: string | null;
    taskId?: string;
    copied?: string[];
  },
): Promise<void> {
  if (!parentTaskId) return;
  await recordLandedAction(state, parentTaskId, {
    command: input.command,
    at: new Date().toISOString(),
    ...(input.connectedFolder ? { connectedFolderId: input.connectedFolder.id, connectedFolderName: input.connectedFolder.name } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.copied ? { copied: input.copied } : {}),
  });
}

/**
 * Splits one Connected Folder–relative act path into the desktop create routes' parent
 * and name inputs, so `files mkdir`/`files create` run the exact same
 * `createConnectedFolderFolder`/`createConnectedFolderTextFile` internals as the renderer.
 */
function splitActEntryPath(rawPath: string, missingMessage: string): { target: string; parentPath: string; name: string } {
  const target = normalizeConnectedFolderRelativePath(rawPath);
  if (!target) throw new AmpleFileCliError("usage", missingMessage);
  const lastSlash = target.lastIndexOf("/");
  return {
    target,
    parentPath: lastSlash === -1 ? "" : target.slice(0, lastSlash),
    name: lastSlash === -1 ? target : target.slice(lastSlash + 1),
  };
}

/** Banner-image data URLs dominate a proposal's size; anything past this bound is not a typed proposal. */
const maxActAppearanceProposalBytes = 1_048_576;

/**
 * Reads and validates one typed `connected-folder-appearance` proposal file, resolved
 * host-side against the caller's working directory — the same file-borne
 * input pattern as `automations enable --proposal`. Nothing but the typed proposal
 * is accepted: no free-form argv colors, no other JSON shapes.
 */
async function readConnectedFolderAppearanceProposalFile(rawPath: string, cwd: string): Promise<ConnectedFolderAppearanceProposal> {
  const parsed = await readBoundedActJsonFile(rawPath, cwd, maxActAppearanceProposalBytes, "appearance proposal");
  try {
    return parseConnectedFolderAppearanceProposal(parsed);
  } catch (error) {
    throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
  }
}

async function readBoundedActJsonFile(
  rawPath: string,
  cwd: string,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new AmpleFileCliError("usage", `A ${label} file path is required.`);
  const path = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) throw new AmpleFileCliError("notFound", `The ${label} file was not found: ${trimmed}.`);
  if (info.size > maximumBytes) {
    throw new AmpleFileCliError("usage", `The ${label} file is larger than ${maximumBytes} bytes and cannot be a typed AmpleFile file.`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new AmpleFileCliError("usage", `The ${label} file is not valid JSON.`, { cause: error });
  }
}

/**
 * Short content digest used as a receipt-safe reference: receipts and act
 * output carry identifiers and digests, never customization or presentation
 * payloads. Store-normalized values serialize deterministically, so equal
 * content yields equal refs.
 */
function shortContentRef(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

function appearanceCustomizationRef(customization: ConnectedFolderAppearanceCustomization | null): string | null {
  return customization === null ? null : shortContentRef(customization);
}

function appearanceCustomizationsEqual(
  left: ConnectedFolderAppearanceCustomization | null,
  right: ConnectedFolderAppearanceCustomization | null,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export async function runActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AmpleFileCliError) throw error;
    // Exactly the HTTP boundary's status translation (sendError), so a
    // route error means the same thing on both surfaces.
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : automationErrorStatus(error);
    const message = error instanceof Error ? error.message : String(error ?? "Connected Folder act command failed.");
    if (statusCode === 400) throw new AmpleFileCliError("usage", message, { cause: error });
    if (statusCode === 403) throw new AmpleFileCliError("permissionDenied", message, { cause: error });
    if (statusCode === 404) throw new AmpleFileCliError("notFound", message, { cause: error });
    if (statusCode === 409) throw new AmpleFileCliError("conflict", message, { cause: error });
    throw new AmpleFileCliError("failure", message, { cause: error });
  }
}

/**
 * Journal-first wrapper for a mutation initiated from trusted desktop
 * Settings. Automation-domain receipts remain the effect evidence; this global
 * pair records the product verb and the main-window surface exactly as the
 * act lane would. The returned promise lets callers separate durable command
 * acceptance from their own terminal domain result when needed.
 */
async function beginDesktopSettingsAct<T>(
  state: LocalApiState,
  command: string,
  operation: (requestId: string) => Promise<{ value: T; detail: string }>,
): Promise<{ requestId: string; result: Promise<T> }> {
  const requestId = `settings:${randomUUID()}`;
  const base = { requestId, command, surface: "main-window" as const };
  if (!await state.actReceipts.append({ ...base, outcome: "accepted" })) {
    throw new AmpleFileCliError(
      "failure",
      "AmpleFile could not journal this Settings action, so nothing was changed.",
    );
  }
  const result = (async () => {
    try {
      const applied = await operation(requestId);
      await state.actReceipts.append({ ...base, outcome: "ok", detail: applied.detail }).catch(() => false);
      return applied.value;
    } catch (error) {
      await state.actReceipts.append({
        ...base,
        outcome: "error",
        ...(error instanceof AmpleFileCliError ? { errorCode: error.code } : {}),
        detail: errorMessage(error),
      }).catch(() => false);
      throw error;
    }
  })();
  return { requestId, result };
}

export async function runDesktopSettingsAct<T>(
  state: LocalApiState,
  command: string,
  operation: (requestId: string) => Promise<{ value: T; detail: string }>,
): Promise<{ requestId: string; value: T }> {
  const started = await beginDesktopSettingsAct(state, command, operation);
  return { requestId: started.requestId, value: await started.result };
}

export function toActConnectedFolderRef(connectedFolder: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">): AmpleFileActConnectedFolderRef {
  return { id: connectedFolder.id, name: connectedFolder.name, connectedFolderRoot: connectedFolder.connectedFolderRoot };
}

export function toActConversationRef(conversation: ConversationSummary): AmpleFileActConversationRef {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    archivedAt: conversation.archivedAt ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
  };
}

function toActChatLifecycleState(conversation: ConversationSummary): AmpleFileActChatLifecycleState {
  return {
    archivedAt: conversation.archivedAt ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
  };
}

/** Manifest-summary projection: counts and identifiers, never per-file listings. */
function toActCheckpointSummary(checkpoint: ConnectedFolderCheckpoint): AmpleFileActCheckpointSummary {
  return {
    checkpointId: checkpoint.checkpointId,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.label ? { label: checkpoint.label } : {}),
    reason: checkpoint.reason,
    scope: checkpoint.scope,
    fileCount: checkpoint.fileCount,
    totalBytes: checkpoint.totalBytes,
    skippedFileCount: checkpoint.skippedFiles.length,
  };
}

function toActFileVersionRef(version: ConnectedFolderFileVersion): AmpleFileActFileVersionRef {
  return {
    path: version.path,
    hashSha256: version.hashSha256,
    sizeBytes: version.sizeBytes,
    modifiedAt: version.modifiedAt,
    capturedAt: version.capturedAt,
    checkpointId: version.checkpointId,
    ...(version.checkpointLabel ? { checkpointLabel: version.checkpointLabel } : {}),
  };
}

// ---------------------------------------------------------------------------
// AmpleFile Agent wiring: the prepared-act fence and adapters, the automation executor's
// hop ports, and the overview's live-registry source readers. All of it is
// constructed by startLocalApi over the same shared state (and the same
// fences) the HTTP routes and the act facade use.
// ---------------------------------------------------------------------------

/** The neutral app-owned root global capability mutations resolve against. */
function capabilityGlobalMutationScope(): { id: string; connectedFolderRoot: string } {
  return { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentRoot() };
}

// ---------------------------------------------------------------------------
// Prepared acts (docs/act-ledger.md). The facade composes each act's typed parameters
// and pins from live state and runs it at once through the prepared-act
// executor. The helpers below are the shared plumbing: error translation
// into the CLI's typed vocabulary, attribution from the validated management
// lineage, and the automation enablement path Settings and the act lane share.
// ---------------------------------------------------------------------------

/** Attribution the prepared-act verbs thread into automation grants: the initiating surface (docs/act-ledger.md). */
export function preparedActAttribution(surface: AmpleFileCliActSurface): PreparedActAttribution {
  return { surface };
}

function mapPreparedActError(error: PreparedActError): AmpleFileCliError {
  switch (error.code) {
    case "KIND_UNKNOWN":
    case "INPUT_INVALID":
      return new AmpleFileCliError("usage", error.message, { cause: error });
    case "PIN_MISMATCH":
      return new AmpleFileCliError("conflict", error.message, { cause: error });
    default:
      return new AmpleFileCliError("unavailable", error.message, { cause: error });
  }
}

export async function runPreparedActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PreparedActError) throw mapPreparedActError(error);
    throw error;
  }
}

/**
 * Enumerates a skill bundle's SKILL.md names for the act's result and
 * receipt without installing anything, on the import path's own bounds.
 * Digest equality remains the whole identity recheck at effect time; these
 * names are derived from the exact inspected bytes.
 */
async function enumerateSkillBundleNames(fileName: string, bytes: Uint8Array): Promise<string[]> {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".md") {
    const markdown = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1] ?? "";
    const rawName = /^name\s*:\s*(.+?)\s*$/im.exec(frontmatter)?.[1]?.trim();
    const unquoted = rawName?.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, d, s) => (d ?? s ?? "")).trim();
    if (!unquoted) throw new AmpleFileCliError("usage", "SKILL.md must declare a name in YAML frontmatter.");
    return [unquoted];
  }
  if (extension !== ".zip" && extension !== ".skill") {
    throw new AmpleFileCliError("usage", "Skills must be a SKILL.md file or use a .zip or .skill bundle.");
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new AmpleFileCliError("usage", `Could not read the skill bundle: ${errorMessage(error)}`, { cause: error });
  }
  const bundleStem = basename(fileName, extname(fileName));
  const names = Object.values(archive.files)
    .filter((entry) => !entry.dir && basename(entry.name.replace(/\\/g, "/")).toLowerCase() === "skill.md")
    .map((entry) => {
      const parent = entry.name.replace(/\\/g, "/").replace(/\/?skill\.md$/i, "").replace(/\/$/, "");
      const segments = parent.split("/").filter((segment) => segment && segment !== ".");
      return segments.length ? segments[segments.length - 1]! : bundleStem;
    })
    .slice(0, 256);
  if (!names.length) throw new AmpleFileCliError("usage", "The bundle does not contain a SKILL.md file.");
  return [...new Set(names)].sort();
}

/** Parses an npm package source into its identity; null for non-npm sources. */
function npmSourceIdentity(source: string): { packageName: string; pinnedVersion?: string } | null {
  if (!source.startsWith("npm:")) return null;
  const rest = source.slice("npm:".length);
  const at = rest.indexOf("@", rest.startsWith("@") ? 1 : 0);
  if (at === -1) return { packageName: rest };
  const packageName = rest.slice(0, at);
  const pinnedVersion = rest.slice(at + 1);
  return pinnedVersion ? { packageName, pinnedVersion } : { packageName };
}

/**
 * The inspected resource summary a package install or update pins and
 * reports. Extensions and install scripts are named for what they are —
 * code that runs as you — exactly as the desktop review does.
 */
function capabilityResourceSummary(details: {
  skills?: string[];
  extensions?: string[];
  prompts?: string[];
  themes?: string[];
  installScripts?: Array<{ name: string }>;
  dependencyCount?: number;
}): string {
  const parts = [
    `${details.skills?.length ?? 0} skill(s)`,
    `${details.extensions?.length ?? 0} extension(s)${(details.extensions?.length ?? 0) > 0 ? " — executable Pi capability" : ""}`,
  ];
  if (details.prompts?.length) parts.push(`${details.prompts.length} prompt(s)`);
  if (details.themes?.length) parts.push(`${details.themes.length} theme(s)`);
  if (details.installScripts?.length) {
    parts.push(`${details.installScripts.length} install script(s) — runs code at install (${details.installScripts.map((script) => script.name).join(", ")})`);
  }
  if (details.dependencyCount) parts.push(`${details.dependencyCount} runtime dependencies`);
  return parts.join(", ").slice(0, 2000);
}

/**
 * The prepared-act fence over the exact reservation state the desktop routes
 * use: a Connected Folder scope reserves with runConnectedFolderMutation semantics, the
 * global scope with runCapabilityMutation's global branch. A busy scope
 * refuses with the routes' own conflict, which the act facade translates into
 * the CLI's typed vocabulary. Project trust checks stay with the calling
 * verbs and the per-kind adapters, mirroring the routes each kind reuses.
 */
function createPreparedActFence(state: LocalApiState): PreparedActFence {
  return {
    run(scope, operation) {
      return scope.scope === "connected-folder"
        ? runConnectedFolderMutation(state, scope.connectedFolderId, operation)
        : runCapabilityMutation(state, capabilityGlobalMutationScope(), "global", operation);
    },
  };
}

/** Attribution a prepared act threads into automation grants. */
interface PreparedActAttribution {
  surface: AmpleFileCliActSurface;
}

/**
 * The execution outcome slot a calling verb reads back after a prepared act
 * ran: the imported Skill, the removal result. It travels in the executor's
 * `context`, never in a receipt.
 */
interface PreparedActOutcome<T> {
  outcome?: T;
  /** Stamped by `runPreparedAct`: the journaled request id the act runs under. */
  requestId?: string;
}

export interface AutomationEnableContext extends PreparedActOutcome<AmpleFileAutomationRecord> {
  declaration: AmpleFileAutomationDeclaration;
  requestId: string;
  attribution: PreparedActAttribution;
}

/**
 * Per-kind execution adapters for the prepared-act path: each binds one kind
 * to the same domain internals the equivalent desktop action uses. Every
 * admitted kind has an adapter. Each re-observes its pinned identities
 * immediately before executing.
 */
function createPreparedActAdapters(state: LocalApiState): PreparedActAdapters {
  return {
    "capability.skills.import": createSkillImportAdapter(state),
    "capability.package.install": createCapabilityPackageAdapter(state, "install"),
    "capability.package.update": createCapabilityPackageAdapter(state, "update"),
    "capability.resource.enabled": resourceEnableAdapter(async (act) => act.parameters.scope === "connected-folder" ? (await getConnectedFolder(String(act.parameters.connectedFolderId))).connectedFolderRoot : ampleFileAgentRoot(), state.runtimeProvider),
    "automation.enable": createAutomationEnableAdapter(state),
    "connected-folder.delete-folder": createManagedConnectedFolderDeletionAdapter(state),
  };
}

/**
 * `capability.skills.import` — the existing import path, digest-verified: the
 * pinned content digest names the exact inspected bytes, and the enumerated
 * skill names are derived from those bytes, so digest equality is the whole
 * identity recheck. Connected Folder scope resolves the Connected Folder's folder; Everywhere scope
 * has no Connected Folder, so it names the same app-owned neutral root the act facade's
 * Everywhere-scope tools verbs resolve against.
 */
function createSkillImportAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<PiSkillBundleImportResult> | undefined> {
  const loadVerified = async (act: PreparedAct): Promise<
    { bundle: { fileName: string; bytes: Uint8Array } } | { issue: string }
  > => {
    let bundle: { fileName: string; bytes: Uint8Array };
    try {
      bundle = await loadSkillBundleForAct(state, act);
    } catch (caught) {
      return { issue: `The skill bundle could not be re-read: ${errorMessage(caught)}` };
    }
    if (piSkillBundleContentDigest(bundle.bytes) !== act.pins.contentDigest) {
      return { issue: "The skill bundle's content no longer matches the pinned digest; the source changed after it was inspected." };
    }
    return { bundle };
  };
  return {
    async recheckPins(act) {
      const loaded = await loadVerified(act);
      return "issue" in loaded ? loaded.issue : null;
    },
    async execute(act, context) {
      const loaded = await loadVerified(act);
      if ("issue" in loaded) throw new Error(loaded.issue);
      const root = act.parameters.scope === "connected-folder"
        ? (await getConnectedFolder(String(act.parameters.connectedFolderId))).connectedFolderRoot
        : ampleFileAgentRoot();
      const result = await importPiSkillBundleVerified(root, {
        fileName: loaded.bundle.fileName,
        bytes: loaded.bundle.bytes,
        scope: act.parameters.scope === "connected-folder" ? "project" : "user",
        expectedContentDigest: String(act.pins.contentDigest),
      }, state.runtimeProvider);
      if (context) context.outcome = result;
      const names = result.skills.map((skill) => skill.name).join(", ");
      return {
        detail: `Imported ${result.skills.length === 1 ? "skill" : "skills"} ${names} at ${result.scope === "user" ? "Everywhere" : "This Connected Folder"} scope.`,
        undoRef: { kind: "skill-bundle-path", value: result.bundlePath },
      };
    },
  };
}

/**
 * Re-reads the exact bundle bytes for `capability.skills.import`. Loading is
 * identity, not trust: the adapter's content-digest recheck decides whether
 * these are the inspected bytes. An absolute path is a file-borne bundle; any
 * other source is an official catalog bundle id, rebuilt through the same
 * registry path the desktop install uses and then digest-checked like every
 * other reload.
 */
async function loadSkillBundleForAct(
  state: LocalApiState,
  act: PreparedAct,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const source = String(act.pins.source ?? act.parameters.source ?? "").trim();
  if (!source) throw new Error("the bundle source is missing");
  if (!isAbsolute(source)) {
    const bundle = await state.capabilityRegistry.buildOfficialSkillBundle(source);
    return { fileName: bundle.fileName, bytes: bundle.bytes };
  }
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("the bundle source must be a regular file");
  }
  return { fileName: basename(source), bytes: await readFile(source) };
}

/**
 * `capability.package.install|update` — the same capability-mutation
 * internals as the desktop package routes, executed inside the fence's
 * reservation (Connected Folder scope for a Connected Folder–scoped package, global for Everywhere
 * scope) instead of reserving twice. Project trust is rechecked at effect
 * time so an untrusted Connected Folder refuses instead of loading code.
 */
function createCapabilityPackageAdapter(
  state: LocalApiState,
  operation: "install" | "update",
): PreparedActAdapter {
  const scopeOf = (act: PreparedAct): "everywhere" | "connected-folder" =>
    (act.pins.scope ?? act.parameters.scope) === "connected-folder" ? "connected-folder" : "everywhere";
  const connectedFolderOf = async (act: PreparedAct): Promise<ConnectedFolderSummary | null> => {
    const connectedFolderId = act.parameters.connectedFolderId;
    if (typeof connectedFolderId !== "string") return null;
    try {
      return await getConnectedFolder(connectedFolderId);
    } catch {
      return null;
    }
  };
  return {
    async recheckPins(act) {
      if (scopeOf(act) !== "connected-folder") return null;
      const connectedFolder = await connectedFolderOf(act);
      if (!connectedFolder) return "The Connected Folder is no longer registered.";
      return await isPiProjectMutationTrusted(connectedFolder.connectedFolderRoot, state.runtimeProvider)
        ? null
        : "Trust this Connected Folder before changing Connected Folder–scoped capabilities.";
    },
    async execute(act) {
      const scope = scopeOf(act);
      const connectedFolder = scope === "connected-folder" ? await connectedFolderOf(act) : null;
      if (scope === "connected-folder" && !connectedFolder) throw new Error("The Connected Folder is no longer registered.");
      const root = connectedFolder?.connectedFolderRoot ?? ampleFileAgentRoot();
      const source = String(act.pins.source);
      const piScope = scope === "connected-folder" ? "project" as const : "user" as const;
      if (operation === "install") {
        await installPiPackage(root, source, { scope: piScope, runtimeProvider: state.runtimeProvider });
      } else {
        await updatePiPackages(root, source, { scope: piScope, runtimeProvider: state.runtimeProvider });
      }
      return {
        detail: `${operation === "install" ? "Installed" : "Updated"} ${String(act.pins.packageId)}@${String(act.pins.version)} `
          + `from ${source} at ${piScope === "user" ? "Everywhere" : "This Connected Folder"} scope.`,
        undoRef: { kind: "package-source", value: source },
      };
    },
  };
}

/**
 * `automation.enable` — the enablement receipt of docs/automations.md. The
 * normalized declaration arrives as execution context from the calling verb,
 * is re-verified against the pinned digest and automation id, and every
 * referenced Connected Folder must still be registered. Execution commits the
 * declaration and the exact-authority grant through the automation service with
 * the act's request id as the grant identity; the store itself re-refuses a
 * declaration that no longer hashes to the pinned digest, and enabling an
 * identical already-enabled declaration changes nothing.
 */
function createAutomationEnableAdapter(state: LocalApiState): PreparedActAdapter<AutomationEnableContext | undefined> {
  const verify = async (act: PreparedAct, context: AutomationEnableContext | undefined): Promise<string | null> => {
    const declaration = context?.declaration;
    if (!declaration) return "The automation declaration to enable was not supplied.";
    if (ampleFileAutomationDigest(declaration) !== act.pins.declarationDigest) {
      return "The automation declaration no longer hashes to the digest this act pinned.";
    }
    if (declaration.id !== act.pins.automationId) return "The declaration names a different automation than this act pinned.";
    for (const connectedFolderId of ampleFileAutomationReferencedConnectedFolderIds(declaration)) {
      const registered = await getConnectedFolder(connectedFolderId).catch(() => null);
      if (!registered) return `The automation references a Connected Folder that is no longer registered (${connectedFolderId}).`;
    }
    return null;
  };
  return {
    // Enablement is an automation-store commit under its own serialization; it
    // mutates no capability state, so it reserves no capability fence.
    fenceScope: () => null,
    recheckPins: verify,
    async execute(act, context) {
      const issue = await verify(act, context);
      if (issue || !context) throw new Error(issue ?? "The automation declaration to enable was not supplied.");
      const { attribution } = context;
      const record = await state.automations.enable({
        declaration: context.declaration,
        expectedDigest: String(act.pins.declarationDigest),
        grant: {
          requestId: context.requestId,
          surface: attribution.surface,
        },
      });
      context.outcome = record;
      // The service returns the untouched record when this exact declaration
      // was already on. Nothing changed, so the receipt says so and offers no
      // undo reference for a state this call did not create.
      if (record.grants[record.grants.length - 1]?.requestId !== context.requestId) {
        return {
          detail: `Automation "${record.declaration.title}" (${record.declaration.id}) was already on at digest ${record.digest}; nothing changed.`,
        };
      }
      return {
        detail: `Enabled automation "${record.declaration.title}" (${record.declaration.id}) at digest ${record.digest}.`,
        undoRef: { kind: "automation-id", value: record.declaration.id },
      };
    },
  };
}

/** The prepared-act pin as bounded text, tolerating the parameter mirror. */
function stringPinValue(act: PreparedAct, name: string): string {
  const value = act.pins[name] ?? act.parameters[name];
  return typeof value === "string" ? value : "";
}

/**
 * `connected-folder.delete-folder` — the managed removal path. Pin recheck re-verifies
 * the registered identity and canonical root; managed-root identity claims
 * are re-checked by the removal machinery itself at execution. The complete desktop removal orchestration
 * — automation revocation and claim-verified managed deletion — is shared with DELETE /api/connected-folders/:id and `connected-folders
 * unregister`. It reserves its own capability fences across every affected
 * Connected Folder, so the adapter's null fenceScope keeps the executor from reserving
 * twice.
 */
function createManagedConnectedFolderDeletionAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<ConnectedFolderRemovalResult & {
  recentlyDeleted: { entryId: string; restoreBy: string } | null;
}> | undefined> {
  return {
    fenceScope: () => null,
    recheckPins(act) {
      return managedConnectedFolderDeletionPinIssue({
        connectedFolderId: stringPinValue(act, "connectedFolderId"),
        connectedFolderRoot: stringPinValue(act, "connectedFolderRoot"),
      });
    },
    async execute(act, context) {
      const connectedFolder = await getConnectedFolder(String(act.pins.connectedFolderId ?? act.parameters.connectedFolderId));
      const result = await removeConnectedFolderRegistrationInternal(state, connectedFolder, { receiptId: context?.requestId ?? null });
      if (context) context.outcome = result;
      const trashed = result.recentlyDeleted ? `; trash ${result.recentlyDeleted.entryId}` : "";
      return {
        detail: result.cleanupPending
          ? `Moved the managed Connected Folder's folder ${connectedFolder.connectedFolderRoot} to Recently deleted${trashed}; final cleanup completes at the next start.`
          : `Moved the managed Connected Folder's folder ${connectedFolder.connectedFolderRoot} to Recently deleted${trashed}.`,
        ...(result.recentlyDeleted ? { undoRef: { kind: "recently-deleted-entry", value: result.recentlyDeleted.entryId } } : {}),
      };
    },
  };
}
