/**
 * The local API's entry. `startLocalApi` builds the shared `LocalApiState`,
 * constructs the services that close over it, and serves requests;
 * `handleRequest` authorizes each request and hands it to the route groups
 * in `./api/`, which hold the routes and their domain code.
 */

import { shutdownIncludedToolHost } from "./agent/included-tool-setup.js";
import { ModelContextInspector } from "./agent/model-context-inspector.js";
import { observeAmpleFileAutomationFiles } from "./automations/automation-file-observer.js";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiRuntimeProvider } from "./agent/pi-client.js";
import { AmpleFileTurnStore } from "./agent/turn-store.js";
import { TurnCheckpointWriter } from "./agent/turn-checkpoint-writer.js";
import {
  RoutedPiExtensionUiBridge,
  type PiExtensionUiEvent,
  type PiExtensionUiRequest,
  type PiExtensionUiSettled,
} from "./agent/extension-ui.js";
import { RemoteCapabilityRegistry } from "./agent/capability-registry.js";
import {
  RegisteredConnectedFolderRuntimeProvider,
  RegisteredConnectedFolderTrustAuthority,
} from "./agent/registered-connected-folder-runtime.js";
import { ProviderSignIns } from "./agent/provider-sign-in.js";
import { ImageModelPreference, imageModelPreferencePath } from "./agent/image-model-preference.js";
import { GeneratedImageStore } from "./agent/generated-image-store.js";
import { AmpleFileRequestStore } from "./requests/request-store.js";
import { isAmpleFileJobTerminalState } from "./jobs/job-records.js";
import { reapOrphanedJobProcesses, AmpleFileJobService } from "./jobs/job-service.js";
import { AmpleFileJobStore } from "./jobs/job-store.js";
import { ConnectedFolderAppearanceStore } from "./connected-folder-appearance-store.js";
import { connectedFolderAppearanceBannerNames } from "../shared/connected-folder-appearance.js";
import { PreparedActExecutor } from "./prepared-acts.js";
import { AmpleFileOverviewSeenStore } from "./overview-seen-store.js";
import { ensureAmpleFileAgentInstructions } from "./amplefile-agent-instructions.js";
import type { AmpleFileAutomationFilesStep } from "./automations/automation-declarations.js";
import { AmpleFileAutomationService } from "./automations/automation-service.js";
import { AmpleFileAutomationStore } from "./automations/automation-store.js";
import {
  configureAmpleFileStateRoot,
  ampleFileAgentRoot,
  ampleFileStateRoot,
  ampleFileRequestsRoot,
  ampleFileJobsRoot,
  ampleFileRecentlyDeletedRoot,
} from "./state-paths.js";
import { AmpleFileRecentlyDeletedStore } from "./recently-deleted-store.js";
import { AmpleFileKernel } from "./amplefile-kernel.js";
import { AmpleFileCliActReceipts } from "./cli/act-receipts.js";
import type { AmpleFileActFacade } from "./cli/act-facade.js";
import { createLocalDevelopmentApiOptions, loadLocalEnvironmentFile } from "./server-dev-options.js";
import { listConnectedFolders, listPendingConnectedFolderRemovals } from "./connected-folder.js";
import { createAmpleFileActFacade } from "./api/act-lane.js";
import { handleAiModelRoutes, handleModelContextRoutes } from "./api/ai-model-routes.js";
import { handleAmpleFileAgentRoutes, resolveAmpleFileAgentLineageParent } from "./api/amplefile-agent-routes.js";
import { createAutomationHopPorts } from "./api/automation-hops.js";
import {
  type AmpleFileAutomationSettingsFacade,
  createAmpleFileAutomationSettingsFacade,
  handleConnectedFolderAutomationRoutes,
} from "./api/automation-settings.js";
import { createBackgroundJobService, settleBackgroundJobOnRequest } from "./api/background-jobs.js";
import { closeMcpSetups, handleCapabilityRoutes } from "./api/capability-routes.js";
import { handleChatRoutes } from "./api/chat-routes.js";
import {
  handleConnectedFolderAppearanceRoutes,
  handleConnectedFolderRegistryRoutes,
  recoverPendingConnectedFolderRemovals,
} from "./api/connected-folder-routes.js";
import { chatEventLog, flushAllTurnCheckpoints, handleEventStreamRoutes } from "./api/event-streams.js";
import { handleExtensionUiRoutes, publishExtensionSnapshot, routeExtensionEvent, routeExtensionRequest } from "./api/extension-ui.js";
import { handleFileRoutes, handleSearchRoutes } from "./api/file-routes.js";
import { handleHistoryRoutes } from "./api/history-routes.js";
import { authorize, closeServer, errorMessage, listen, notFound, numberFromEnv, sendError, setCorsHeaders } from "./api/http.js";
import { createServerOverviewSources, handleOverviewRoutes } from "./api/overview-routes.js";
import { forgetOpenLocalApi, handlePlaceRoutes, rememberOpenLocalApi } from "./api/place-routes.js";
import { createPreparedActAdapters, createPreparedActFence } from "./api/prepared-act-adapters.js";
import { handleSettingsRoutes } from "./api/recently-deleted-routes.js";
import { handleRequestRoutes } from "./api/request-routes.js";
import type { LocalApiOptions, LocalApiRequest, LocalApiState } from "./api/state.js";
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
