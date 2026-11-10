import { createLocalEventSink } from "./local-event-stream.js";
import { prepareResourceEnable, resourceEnableAdapter } from "./agent/resource-enable-act.js";
import { shutdownIncludedToolHost } from "./agent/included-tool-setup.js";
import { ModelContextInspector } from "./agent/model-context-inspector.js";
import { observeAmpleFileAutomationFiles, ampleFileAutomationFileObserverBounds } from "./automations/automation-file-observer.js";
import { isConnectedFolderFileVisible } from "./connected-folder-file-visibility.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  automationCatchUpReasons,
  automationCatchUpSentence,
  automationTriggerSummary,
  type AutomationCatchUpReason,
  type FolderAutomationState,
  type FolderAutomationsResponse,
  type FolderAutomationView,
  type AutomationTriggerView,
} from "../shared/automation-presentation.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { automationTemplateAutomationId, isAutomationTemplateId } from "../shared/automation-templates.js";
import { automationTemplateDeclaration } from "./automations/automation-templates.js";
import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
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
import {
  classifyAmpleFileAgentAttachments,
  ampleFileAgentAttachmentDispositions,
  maxAmpleFileAgentAttachments,
  type AmpleFileAgentAttachmentRef,
} from "./amplefile-agent-attachments.js";
import {
  AmpleFileRequestLineageError,
  ampleFileRequestStateToAgentPhase,
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
  getConnectedFolderCheckpoint,
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
import { normalizeConversationTitle } from "../shared/chat-title.js";
import {
  hasConnectedFolderAppearanceCustomization,
  parseConnectedFolderAppearanceProposal,
  connectedFolderAppearanceBannerNames,
  type ConnectedFolderAppearanceCustomization,
  type ConnectedFolderAppearanceProposal,
} from "../shared/connected-folder-appearance.js";
import { resolveFolderTargets } from "./automations/folder-targets.js";
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
import {
  createAmpleFileOverviewAutomationRunReader,
  parseAmpleFileOverviewCursor,
  ampleFileOverviewChatRecordFromMessages,
  type AmpleFileOverviewAgentRequestRecord,
  type AmpleFileOverviewSettledTurnRecord,
  type AmpleFileOverviewSourceReaders,
} from "./overview.js";
import { AmpleFileOverviewSeenStore } from "./overview-seen-store.js";
import { ensureAmpleFileAgentInstructions } from "./amplefile-agent-instructions.js";
import {
  assertAmpleFileAutomationAtAdmissionHorizon,
  contentAddressedAmpleFileAutomationDeclaration,
  normalizeAmpleFileAutomationDeclaration,
  normalizeAmpleFileAutomationProposal,
  readAmpleFileAutomationDocument,
  ampleFileAutomationBounds,
  ampleFileAutomationDeclarationKind,
  ampleFileAutomationDigest,
  ampleFileAutomationProposalKind,
  ampleFileAutomationReferencedConnectedFolderIds,
  ampleFileAutomationConnectedFolderRoles,
  type AmpleFileAutomationDeclaration,
  type AmpleFileAutomationFilesStep,
} from "./automations/automation-declarations.js";
import { resolveAmpleFileAutomationProposalPath, scanAmpleFileAutomationProposals } from "./automations/automation-proposal-scan.js";
import {
  AmpleFileAutomationService,
  type AmpleFileAutomationHopPorts,
  type AmpleFileAutomationProjection,
  type AmpleFileAutomationServiceStatus,
} from "./automations/automation-service.js";
import {
  AmpleFileAutomationStore,
  ampleFileAutomationReceiptsFile,
  ampleFileAutomationReceiptsRotatedFile,
  type AmpleFileAutomationReceiptV1,
  type AmpleFileAutomationRecord,
} from "./automations/automation-store.js";
import {
  configureAmpleFileStateRoot,
  ampleFileAgentRoot,
  ampleFileAgentScopeId,
  ampleFileStateRoot,
  ampleFileRequestsRoot,
  ampleFileJobsRoot,
  ampleFileRecentlyDeletedRoot,
} from "./state-paths.js";
import {
  AmpleFileRecentlyDeletedStore,
  ampleFileRecentlyDeletedEntryIdPattern,
  type AmpleFileRecentlyDeletedEntry,
} from "./recently-deleted-store.js";
import { AmpleFileKernel } from "./amplefile-kernel.js";
import {
  AMPLEFILE_CLI_ACT_SURFACES,
  AmpleFileCliActReceipts,
  type AmpleFileCliActReceipt,
  type AmpleFileCliActSurface,
} from "./cli/act-receipts.js";
import { AmpleFileCliError } from "./cli/protocol.js";
import type {
  AmpleFileActChatLifecycleState,
  AmpleFileActCheckpointSummary,
  AmpleFileActConversationRef,
  AmpleFileActFacade,
  AmpleFileActFileVersionRef,
  AmpleFileActAgentRequest,
  AmpleFileActAutomationReceipt,
  AmpleFileActAutomationSummary,
  AmpleFileActAutomationTriggerRef,
  AmpleFileActConnectedFolderRef,
  AmpleFileActRecentlyDeletedEntry,
  AmpleFileActTurnState,
} from "./cli/act-facade.js";
import { resolveAmpleFileCliConnectedFolderSelector } from "./amplefile-cli-adapter.js";
import { createLocalDevelopmentApiOptions, loadLocalEnvironmentFile } from "./server-dev-options.js";
import {
  copyPathIntoConnectedFolder,
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
  withConnectedFolderHistoryOperations,
  withConnectedFolderTouchBatch,
  type ConnectedFolderRemovalResult,
  type ConnectedFolderSummary,
} from "./connected-folder.js";
import { handleAiModelRoutes, handleModelContextRoutes, saveWorkerInstructions } from "./api/ai-model-routes.js";
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
import { copyConversation, handleChatRoutes, normalizeAddressedConnectedFolderIds, runConversationMutation } from "./api/chat-routes.js";
import {
  createConnectedFolderInternal,
  handleConnectedFolderAppearanceRoutes,
  handleConnectedFolderRegistryRoutes,
  recoverPendingConnectedFolderRemovals,
  registerConnectedFolderInternal,
  removeConnectedFolderRegistrationInternal,
} from "./api/connected-folder-routes.js";
import { createWorktreeToolHost, getClient, refreshClientIfMarked } from "./api/conversation-clients.js";
import {
  broadcast,
  chatEventLog,
  flushAllTurnCheckpoints,
  handleEventStreamRoutes,
  openChatStream,
  publishControlHint,
} from "./api/event-streams.js";
import {
  extensionSnapshot,
  handleExtensionUiRoutes,
  publishExtensionSnapshot,
  routeExtensionEvent,
  routeExtensionRequest,
} from "./api/extension-ui.js";
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
  badRequest,
  boundedOptionalId,
  closeServer,
  errorMessage,
  httpError,
  listen,
  match,
  notFound,
  numberFromEnv,
  readJsonBody,
  sendError,
  sendJson,
  setCorsHeaders,
} from "./api/http.js";
import { forgetOpenLocalApi, handlePlaceRoutes, rememberOpenLocalApi } from "./api/place-routes.js";
import { handleSettingsRoutes, recentlyDeletedEntryView, restoreRecentlyDeletedEntry } from "./api/recently-deleted-routes.js";
import {
  assertCallerHandedWorkTo,
  assertCallerTurn,
  assertOwnTask,
  assertRequestsAboveConnectedFolders,
  collaborationRefusal,
  completedRequestEnvelope,
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
  turnReportedResult,
  turnResultForScope,
  turnStatusFor,
  waitForSettledRequest,
  waitingRefForTask,
} from "./api/request-records.js";
import {
  handleRequestRoutes,
  queueConversationRequestEvaluation,
  requestLimitStopMessage,
  requestPresentation,
  stopAmpleFileAgentRequest,
} from "./api/request-routes.js";
import {
  assertNoCapabilityMutationForTurn,
  checkpointAdditiveWritesOrUndo,
  requestHasUnsettledWork,
  reserveCapabilityMutation,
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
  type TurnCheckpointEvent,
} from "./api/state.js";
import { acceptConversationTurn, changeQueuedMessage, optionalTurnIdentity, steerConversationTurn } from "./api/turn-acceptance.js";
import { recoverDurableTurnState, yieldBackgroundCompaction } from "./api/turn-run.js";

export type {
  AmpleFileDeleteRecovery,
  AmpleFileDeleteResult,
  AmpleFileBatchDeleteResult,
  AmpleFileBatchMoveResult,
} from "./api/file-changes.js";
export { transferFileEntries } from "./api/place-routes.js";
export type { AmpleFileRecentlyDeletedEntryView, AmpleFileRecentlyDeletedRestoreResult } from "./api/recently-deleted-routes.js";
export type { LocalFolderGrantProvider, LocalApiOptions } from "./api/state.js";

export type AmpleFileAutomationSettingsOutcome =
  | "accepted"
  | "succeeded"
  | "failed"
  | "stopped"
  | "interrupted"
  | "skipped"
  | "lapsed";

export interface AmpleFileAutomationSettingsConnectedFolderRef {
  connectedFolderId: string;
  connectedFolderName?: string;
}

export interface AmpleFileAutomationSettingsRunView {
  runId: string;
  outcome: AmpleFileAutomationSettingsOutcome;
  startedAt: string;
  finishedAt?: string;
  cause?: string;
  detail?: string;
  /** Succeeded, but a step's Worker reported finishing only partly. */
  partial?: true;
  hops: Array<{
    hopId: string;
    kind: "chat" | "files" | "agent";
    outcome: AmpleFileAutomationSettingsOutcome;
    partial?: true;
    connectedFolderName?: string;
    detail?: string;
    evidence?: Array<{ label: string; value: string }>;
  }>;
}

export interface AmpleFileAutomationSettingsSummary {
  automationId: string;
  title: string;
  health: "enabled" | "disabled" | "suspended" | "completed";
  trigger: AmpleFileActAutomationTriggerRef;
  fileWatch?: import("./automations/automation-file-observer.js").AmpleFileAutomationFileWatchStatus;
  stepCount: number;
  /** Every Connected Folder the trigger or a step names, for the Settings Connected Folder filter. */
  connectedFolders: AmpleFileAutomationSettingsConnectedFolderRef[];
  nextScheduledAt?: string;
  lastScheduledAt?: string;
  activeRun?: { runId: string; startedAt: string };
  lastRun?: Omit<AmpleFileAutomationSettingsRunView, "hops" | "cause" | "detail">;
  /** The newest run that caught up on files changed while AmpleFile could not watch (`"ifMissed": "run"`). */
  lastCatchUp?: { runId: string; at: string; count: number; reason: AutomationCatchUpReason };
  suspension?: { at: string; reason?: string; missingConnectedFolders?: AmpleFileAutomationSettingsConnectedFolderRef[] };
}

/**
 * One `*.amplefile-automation.json` file at the top level of the AmpleFile
 * agent's working folder that is not already a stored automation
 * (docs/automations.md, "Where automations live in the product").
 */
export type AmpleFileAutomationSettingsProposalView =
  | {
    valid: true;
    path: string;
    fileName: string;
    automationId: string;
    digest: string;
    title: string;
    trigger: AmpleFileActAutomationTriggerRef;
  }
  | { valid: false; path: string; fileName: string; problem: string };

export interface AmpleFileAutomationSettingsFacade {
  list(): Promise<{ automations: AmpleFileAutomationSettingsSummary[]; status: AmpleFileAutomationServiceStatus }>;
  proposals(): Promise<{ proposals: AmpleFileAutomationSettingsProposalView[]; truncated: boolean }>;
  /** Turns on one pending proposal by its absolute path, through the CLI's enable path. */
  enableProposal(path: string): Promise<{
    automationId: string;
    requestId: string;
    enabled: true;
    alreadyEnabled: boolean;
    automation: AmpleFileAutomationSettingsSummary;
  }>;
  show(automationId: string): Promise<{
    automation: AmpleFileAutomationSettingsSummary & {
      createdAt: string;
      connectedFolders: AmpleFileAutomationSettingsConnectedFolderRef[];
      steps: Array<
        | { id: string; kind: "chat"; connectedFolder: AmpleFileAutomationSettingsConnectedFolderRef; message: string; model?: { provider: string; id: string } }
        | {
          id: string;
          kind: "files";
          fromConnectedFolder: AmpleFileAutomationSettingsConnectedFolderRef;
          toConnectedFolder: AmpleFileAutomationSettingsConnectedFolderRef;
          to: string;
          source: ReturnType<typeof toActAutomationFilesSource>;
        }
        | { id: string; kind: "agent"; message: string; model?: { provider: string; id: string } }
      >;
      completedAt?: string;
    };
  }>;
  history(automationId: string): Promise<{ runs: AmpleFileAutomationSettingsRunView[]; truncated: boolean; damagedLineCount: number }>;
  enable(automationId: string): Promise<{ automationId: string; requestId: string; enabled: true; alreadyEnabled: boolean }>;
  /**
   * Turns on a ready-made Automation for one Connected Folder (the file manager's
   * Info panel): the stored one when it was on before, else a new
   * declaration built by the host, through the same receipted enable path.
   */
  enableTemplate(connectedFolderId: string, templateId: string): Promise<{ automationId: string; requestId: string; enabled: true; alreadyEnabled: boolean }>;
  run(automationId: string): Promise<{ automationId: string; requestId: string; runId: string; accepted: true }>;
  stop(automationId: string): Promise<{ automationId: string; requestId: string; runId: string; stopped: true }>;
  disable(automationId: string): Promise<{ automationId: string; requestId: string; disabled: true; stoppedRunId: string | null }>;
  delete(automationId: string): Promise<{ automationId: string; requestId: string; deleted: true }>;
  /**
   * The Connected Folder–owned Automations view (docs/automations.md): the
   * automations whose trigger or any step names this Connected Folder, with
   * what each does there. Served at `GET /api/connected-folders/:id/automations`.
   */
  forConnectedFolder(connectedFolderId: string): Promise<FolderAutomationsResponse>;
  /** Refuses with notFound unless the automation names this Connected Folder; the gate for the Connected Folder view's actions. */
  requireConnectedFolderAutomation(connectedFolderId: string, automationId: string): Promise<void>;
}

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

/** The Automations that name one Connected Folder, and their enable, disable, and run acts. */
async function handleConnectedFolderAutomationRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // The Connected Folder–owned Automations view (docs/automations.md): a read
  // of the automations that name this Connected Folder, and the same
  // Settings enable/disable/run acts — same facade, same receipts — refused
  // for an automation that does not name it.
  const spaceAutomationsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/automations$/);
  if (spaceAutomationsMatch && method === "GET") {
    const connectedFolder = await getConnectedFolder(spaceAutomationsMatch[1]);
    sendJson(res, await createAmpleFileAutomationSettingsFacade(state).forConnectedFolder(connectedFolder.id));
    return true;
  }
  const spaceAutomationActMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/automations\/([^/]+)\/(enable|disable|run)$/);
  if (spaceAutomationActMatch && method === "POST") {
    const connectedFolder = await getConnectedFolder(spaceAutomationActMatch[1]);
    await readJsonBody<Record<string, never>>(state, req);
    const automationId = spaceAutomationActMatch[2];
    const facade = createAmpleFileAutomationSettingsFacade(state);
    await facade.requireConnectedFolderAutomation(connectedFolder.id, automationId);
    const action = spaceAutomationActMatch[3];
    sendJson(res, action === "enable"
      ? await facade.enable(automationId)
      : action === "disable"
        ? await facade.disable(automationId)
        : await facade.run(automationId));
    return true;
  }
  return false;
}

/** The AmpleFile Agent's conversation surface: the same acceptance path, task records, and event stream as Connected Folder Chats, under the AmpleFile Agent scope id. */
async function handleAmpleFileAgentRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // Management conversation surface: the same acceptance path, task records,
  // and event stream as Connected Folder Chats, exposed for renderer clients (the
  // menu-bar popover) under the AmpleFile Agent scope id instead of a Connected Folder id.
  if (url.pathname === "/api/amplefile-agent/summary" && method === "GET") {
    if (state.ampleFileAgentInstructionsError) {
      sendJson(res, { available: false, reason: state.ampleFileAgentInstructionsError, conversation: null, state: "idle", latestRequest: null });
      return true;
    }
    const selectedId = url.searchParams.get("conversationId");
    const conversation = selectedId
      ? (await listConversations(ampleFileAgentRoot())).find((item) => item.id === selectedId)
      : await resolveAmpleFileAgentConversation(false).catch(() => null);
    if (selectedId && !conversation) throw notFound("This AmpleFile Agent chat is no longer available.");
    // The selected transcript and its request must describe the same work,
    // even when another surface has started a newer AmpleFile Agent.
    const latest = conversation ? state.requests.latestForConversation(conversation.id) : null;
    sendJson(res, {
      available: true,
      conversation: conversation ? toActConversationRef(conversation) : null,
      state: conversation ? conversationRuntimeState(state, ampleFileAgentScopeId, conversation.id) : "idle",
      latestRequest: latest ? await ampleFileAgentRequestView(state, latest.turns.at(-1)!.taskId) : null,
    });
    return true;
  }
  if (url.pathname === "/api/amplefile-agent/conversations" && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversations = await listConversations(ampleFileAgentRoot());
    sendJson(res, { conversations: await Promise.all(conversations.map(async (conversation) => ({
      ...toActConversationRef(conversation),
      ...await ampleFileAgentConversationAttention(state, conversation.id),
    }))) });
    return true;
  }
  if (url.pathname === "/api/amplefile-agent/messages" && method === "POST") {
    assertAmpleFileAgentReadyForRoutes(state);
    const body = await readJsonBody<{
      content?: string;
      attachments?: unknown;
      conversationId?: unknown;
      newConversation?: unknown;
      continuationTaskId?: unknown;
      requestId?: unknown;
      userMessageId?: unknown;
      addressedConnectedFolderIds?: unknown;
      delivery?: unknown;
    }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    if (body.delivery !== undefined && body.delivery !== "steer") throw badRequest("Message delivery must be \"steer\" when present.");
    if (body.delivery === "steer") {
      // The menu-bar panel and the agent panel reach a running turn the way a Connected Folder Chat does.
      const steerConversationId = boundedOptionalId(body.conversationId, "conversationId");
      if (!steerConversationId) throw badRequest("Steering needs the conversationId of the running Chat.");
      if (Array.isArray(body.attachments) && body.attachments.length) throw badRequest("Attachments cannot be added to a running turn.");
      const scope = ampleFileAgentScopeForRoutes(state);
      const steered = await steerConversationTurn(state, { id: scope.id, connectedFolderRoot: scope.rootPath }, steerConversationId, {
        content,
        requestId: optionalTurnIdentity(body.requestId, "requestId"),
        userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
      });
      sendJson(res, { accepted: true, delivery: "steer", conversationId: steerConversationId, message: steered.message, taskId: steered.taskId, replayed: steered.replayed }, 202);
      return true;
    }
    const addressedConnectedFolderIds = await normalizeAddressedConnectedFolderIds(body.addressedConnectedFolderIds, ampleFileAgentScopeId);
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (rawAttachments.length > maxAmpleFileAgentAttachments) {
      throw badRequest(`At most ${maxAmpleFileAgentAttachments} attachments are allowed per request.`);
    }
    if (rawAttachments.some((item) => typeof item !== "string")) {
      throw badRequest("Attachments must be absolute paths or http(s) links.");
    }
    const conversationIdInput = boundedOptionalId(body.conversationId, "conversationId");
    const continuationTaskId = boundedOptionalId(body.continuationTaskId, "continuationTaskId");
    const requestId = optionalTurnIdentity(body.requestId, "requestId");
    const userMessageId = optionalTurnIdentity(body.userMessageId, "userMessageId");
    if (body.newConversation !== undefined && typeof body.newConversation !== "boolean") {
      throw badRequest("newConversation must be a boolean.");
    }
    if (body.newConversation === true && conversationIdInput) {
      throw badRequest("Use either conversationId or newConversation, not both.");
    }
    if (continuationTaskId && (!conversationIdInput || body.newConversation === true)) {
      throw badRequest("A continuation requires the existing conversationId.");
    }
    let attachments: AmpleFileAgentAttachmentRef[];
    try {
      attachments = await classifyAmpleFileAgentAttachments(rawAttachments as string[], ampleFileAgentRoot());
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    const scope = ampleFileAgentScopeForRoutes(state);
    const priorAcceptance = requestId ? state.turnStore.findScopeRequest(scope.id, requestId) : null;
    if (priorAcceptance && conversationIdInput && priorAcceptance.conversationId !== conversationIdInput) {
      throw httpError(409, "This turn request id was already accepted in another AmpleFile Agent Chat.");
    }
    const conversationId = priorAcceptance?.conversationId
      ?? (body.newConversation === true
        ? (await createConversation(scope.rootPath)).id
        : conversationIdInput ?? (await resolveAmpleFileAgentConversation(true)).id);
    if (continuationTaskId) {
      const previous = await ampleFileAgentRequestView(state, continuationTaskId);
      if (!previous || previous.conversationId !== conversationId || previous.phase !== "needs_you") {
        throw httpError(409, "That AmpleFile Agent request is no longer waiting for a reply.");
      }
      const combinedAttachmentCount = new Set(
        [...previous.attachments, ...attachments].map((attachment) => `${attachment.kind}:${attachment.target}`),
      ).size;
      if (combinedAttachmentCount > maxAmpleFileAgentAttachments) {
        throw badRequest(`A continued request can reference at most ${maxAmpleFileAgentAttachments} attachments in total.`);
      }
    }
    // A reply to a waiting request joins that request: one record, one
    // story, a further turn — never a second record copying the trail.
    const continuedRequestId = continuationTaskId ? state.requests.byTaskId(continuationTaskId)?.requestId : undefined;
    const { message, taskId } = await acceptConversationTurn(state, { id: scope.id, connectedFolderRoot: scope.rootPath }, conversationId, {
      content,
      contextPaths: [],
      actorKind: "renderer",
      ampleFileAgentAttachments: attachments,
      ...(addressedConnectedFolderIds.length ? { addressedConnectedFolderIds } : {}),
      ...(continuationTaskId ? { continuedFromAmpleFileAgentTaskId: continuationTaskId } : {}),
      ...(continuedRequestId ? { request: { joinRequestId: continuedRequestId } } : {}),
      requestId,
      userMessageId,
    });
    sendJson(res, { accepted: true, conversationId, message, taskId, attachments }, 202);
    return true;
  }
  const ampleFileAgentRequestMatch = match(url.pathname, /^\/api\/amplefile-agent\/requests\/([^/]+)$/);
  if (ampleFileAgentRequestMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    const request = await ampleFileAgentRequestView(state, ampleFileAgentRequestMatch[1]);
    if (!request) throw notFound(`Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
    sendJson(res, { request });
    return true;
  }
  const ampleFileAgentStopMatch = match(url.pathname, /^\/api\/amplefile-agent\/requests\/([^/]+)\/stop$/);
  if (ampleFileAgentStopMatch && method === "POST") {
    assertAmpleFileAgentReadyForRoutes(state);
    await readJsonBody<Record<string, never>>(state, req);
    try {
      sendJson(res, { stopped: await stopAmpleFileAgentRequest(state, ampleFileAgentStopMatch[1]) });
    } catch (error) {
      if (error instanceof AmpleFileCliError && error.code === "notFound") throw notFound(error.message);
      throw error;
    }
    return true;
  }
  const ampleFileAgentConversationMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)$/);
  if (ampleFileAgentConversationMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    sendJson(res, { messages: await readConversation(ampleFileAgentRoot(), ampleFileAgentConversationMatch[1]) });
    return true;
  }
  const ampleFileAgentConversationTitleMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/title$/);
  if (ampleFileAgentConversationTitleMatch && method === "POST") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversationId = ampleFileAgentConversationTitleMatch[1];
    const body = await readJsonBody<{ title?: unknown }>(state, req);
    if (typeof body.title !== "string") throw badRequest("Chat title must be text.");
    const title = normalizeConversationTitle(body.title);
    if (!title) throw badRequest("Enter a Chat title.");
    const conversation = await renameAmpleFileAgentConversation(state, conversationId, title);
    state.clients.get(clientKey(ampleFileAgentScopeId, conversationId))?.setSessionName(conversation.title);
    sendJson(res, {
      conversation: toActConversationRef(conversation),
      state: conversationRuntimeState(state, ampleFileAgentScopeId, conversationId),
    });
    return true;
  }
  if (ampleFileAgentConversationMatch && method === "DELETE") {
    assertAmpleFileAgentReadyForRoutes(state);
    const deleted = await deleteAmpleFileAgentConversation(state, ampleFileAgentConversationMatch[1], { receiptId: null });
    sendJson(res, { deleted });
    return true;
  }
  const ampleFileAgentRuntimeMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/runtime$/);
  if (ampleFileAgentRuntimeMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversationId = ampleFileAgentRuntimeMatch[1];
    if (!(await readConversation(ampleFileAgentRoot(), conversationId)).length) throw notFound("Conversation not found.");
    const client = await getClient(state, ampleFileAgentScopeId, ampleFileAgentRoot(), conversationId);
    sendJson(res, { runtime: await client.getState() });
    return true;
  }
  const ampleFileAgentThinkingMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/thinking$/);
  if (ampleFileAgentThinkingMatch && method === "POST") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversationId = ampleFileAgentThinkingMatch[1];
    if (!(await readConversation(ampleFileAgentRoot(), conversationId)).length) throw notFound("Conversation not found.");
    const body = await readJsonBody<{ level?: unknown }>(state, req);
    if (typeof body.level !== "string" || !body.level.trim()) throw badRequest("A thinking level is required.");
    const key = clientKey(ampleFileAgentScopeId, conversationId);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current AmpleFile Agent turn to finish before changing the thinking level.");
    const client = await getClient(state, ampleFileAgentScopeId, ampleFileAgentRoot(), conversationId);
    let result: { level: string; available: string[] };
    try {
      result = await client.setThinkingLevel(body.level);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    sendJson(res, { thinking: result, runtime: await client.getState() });
    return true;
  }
  const ampleFileAgentEventsMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/events$/);
  if (ampleFileAgentEventsMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    openChatStream(state, createLocalEventSink(res), ampleFileAgentScopeId, ampleFileAgentEventsMatch[1], req.headers["last-event-id"]);
    return true;
  }
  return false;
}

/** The AmpleFile Agent's overview and what a person has seen of it. */
async function handleOverviewRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // The overview (docs/amplefile-agent-overview.md): the app-composed digest for the popover
  // and the main window, on the renderer session. Deliberately no
  // management-readiness gate — the digest reads recorded state, not the
  // management Pi session, so it stays available even when management
  // commands fail closed; only narration needs the conversation.
  if (url.pathname === "/api/amplefile-agent/overview" && method === "GET") {
    sendJson(res, { overview: await state.kernel.getOverview({ kind: "renderer" }) });
    return true;
  }
  if (url.pathname === "/api/amplefile-agent/overview/seen" && method === "POST") {
    const body = await readJsonBody<{ surface?: unknown; cursor?: unknown }>(state, req);
    // The renderer lane advances only the two desktop surfaces, so one
    // surface can never acknowledge for another.
    if (body.surface !== "popover" && body.surface !== "main-window") {
      throw badRequest("The overview surface must be popover or main-window.");
    }
    if (typeof body.cursor !== "string" || !parseAmpleFileOverviewCursor(body.cursor)) {
      throw badRequest("A rendered overview cursor is required to mark seen.");
    }
    // Monotonic by construction: fetching never advances a marker, a replayed
    // or backward advance is a no-op, and a failed write only leaves items
    // rendering as new.
    sendJson(res, await state.overviewSeen.advance(body.surface, body.cursor));
    return true;
  }
  return false;
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

/** The AmpleFile Agent scope shaped like the Connected Folder refs the turn internals take. */
export function ampleFileAgentScope(state?: LocalApiState): { id: string; rootPath: string } {
  if (state) assertAmpleFileAgentInstructionsReady(state);
  return { id: ampleFileAgentScopeId, rootPath: ampleFileAgentRoot() };
}

export function assertAmpleFileAgentInstructionsReady(state: LocalApiState): void {
  if (!state.ampleFileAgentInstructionsError) return;
  throw new AmpleFileCliError(
    "unavailable",
    "The AmpleFile Agent is unavailable because AmpleFile could not prepare its required instructions. Restart AmpleFile; if this continues, check the app-data AmpleFile Agent folder.",
  );
}

/** HTTP mirror of the fail-closed instructions gate: 503 instead of a CLI error. */
export function assertAmpleFileAgentReadyForRoutes(state: LocalApiState): void {
  if (!state.ampleFileAgentInstructionsError) return;
  throw httpError(503, "The AmpleFile Agent is unavailable because Connected Folder could not prepare its required instructions. Restart Connected Folder; if this continues, check the app-data AmpleFile Agent folder.");
}

function ampleFileAgentScopeForRoutes(state: LocalApiState): { id: string; rootPath: string } {
  assertAmpleFileAgentReadyForRoutes(state);
  return { id: ampleFileAgentScopeId, rootPath: ampleFileAgentRoot() };
}

/**
 * The default AmpleFile Agent is the most recent active one; the
 * AmpleFile Agent surface is "one conversation" unless the caller asks for more.
 */
async function resolveAmpleFileAgentConversation(create: boolean): Promise<ConversationSummary> {
  const scope = ampleFileAgentScope();
  const conversations = await listConversations(scope.rootPath);
  const active = conversations.find((item) =>
    !item.archivedAt && (!item.snoozedUntil || Date.parse(item.snoozedUntil) <= Date.now()));
  if (active) return active;
  if (!create) throw new AmpleFileCliError("notFound", "No AmpleFile Agent exists yet. Send a message to start one.");
  return createConversation(scope.rootPath);
}

/**
 * The AmpleFile Agent transcript lives outside every Connected Folder, so it has no History
 * checkpoint to hold it. Its only deletion path moves the exact validated
 * transcript into Recently deleted. It deliberately never accepts a path.
 */
async function deleteAmpleFileAgentConversation(
  state: LocalApiState,
  conversationId: string,
  context: { receiptId: string | null },
): Promise<{ conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } }> {
  const root = ampleFileAgentRoot();
  const key = clientKey(ampleFileAgentScopeId, conversationId);
  await yieldBackgroundCompaction(state, key);
  changeQueuedMessage(state, key, null);
  assertAmpleFileAgentConversationMutable(state, conversationId);
  // This reservation uses the same conflict fence as compaction because a
  // transcript move must not race a new turn, rename, or real compaction.
  state.compactingConversations.add(key);
  try {
    const summary = await readConversationSummary(root, conversationId).catch((error) => {
      throw badRequest(errorMessage(error));
    });
    if (!summary) throw notFound("Conversation not found.");
    if (state.requests.list().some((request) =>
      request.owner.connectedFolderId === undefined
      && request.owner.conversationId === conversationId
      && requestHasUnsettledWork(state, request))) {
      throw httpError(409, "Finish or stop this Chat's outstanding work before deleting it.");
    }
    // An idle client can still hold the Pi session and extension callbacks.
    // Stop disposes that session before its transcript leaves the live root.
    await state.clients.get(key)?.stop();
    // `readConversationSummary` validated the id before this join. The source
    // remains a single known transcript below the app-owned management root.
    const relativePath = `.amplefile/conversations/${conversationId}.jsonl`;
    const sourcePath = join(root, relativePath);
    let entry: AmpleFileRecentlyDeletedEntry;
    try {
      entry = await state.recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: "file",
        reason: "agent.chat.delete",
        sourcePath,
        connectedFolderId: ampleFileAgentScopeId,
        connectedFolderName: "AmpleFile Agent",
        displayName: summary.title,
        originalPath: relativePath,
        receiptId: context.receiptId,
      });
    } catch (error) {
      throw new AmpleFileCliError(
        "failure",
        `AmpleFile could not move this Chat to Recently deleted: ${errorMessage(error)}. Nothing was deleted.`,
        { cause: error },
      );
    }
    state.clients.delete(key);
    return { conversationId, recentlyDeleted: { entryId: entry.id, restoreBy: entry.restoreBy } };
  } finally {
    state.compactingConversations.delete(key);
  }
}

function assertAmpleFileAgentConversationMutable(state: LocalApiState, conversationId: string): void {
  const key = clientKey(ampleFileAgentScopeId, conversationId);
  if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current turn to finish.");
  if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
}

async function renameAmpleFileAgentConversation(
  state: LocalApiState,
  conversationId: string,
  title: string,
): Promise<ConversationSummary> {
  const key = clientKey(ampleFileAgentScopeId, conversationId);
  assertAmpleFileAgentConversationMutable(state, conversationId);
  // Renaming appends a transcript event, so reserve the same fence deletion
  // and compaction use before awaiting that write.
  state.compactingConversations.add(key);
  try {
    return await renameConversation(ampleFileAgentRoot(), conversationId, title);
  } finally {
    state.compactingConversations.delete(key);
  }
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
 * Rich, honest view of one request, keyed by any of its task ids. The phase
 * is the durable record's state mapped onto the vocabulary `agent status`
 * and the popover already speak (docs/collaboration-contract.md): `done`
 * is claimed only when the request's own turn succeeded AND no child it
 * started is still running; downstream work keeps it in `handed_off`, and an
 * open question puts it in `needs_you`. A reply whose final non-empty line
 * asks a question also surfaces as `needs_you` — the agent is taught to
 * put its question on its own closing line, and a missed detection degrades
 * to `done` with the question still fully visible in the reply.
 *
 * The view names the newest turn of the request, so a task id whose request
 * was continued resolves to the continued story rather than a stale copy.
 */
async function ampleFileAgentRequestView(
  state: LocalApiState,
  taskId: string,
): Promise<AmpleFileActAgentRequest | null> {
  const record = state.requests.byTaskId(taskId);
  if (!record) return null;
  const scopeId = record.owner.connectedFolderId ?? ampleFileAgentScopeId;
  const newestTurn = record.turns.at(-1)!;
  const turn = turnStatusFor(state, scopeId, newestTurn.taskId);
  const children = state.requests.children(record.requestId).map((child): {
    taskId: string;
    connectedFolderId: string;
    connectedFolderName: string;
    conversationId: string;
    state: AmpleFileActTurnState;
    error: string | null;
    files: string[];
  } => {
    const childTurn = child.turns.at(-1)!;
    const live = child.owner.connectedFolderId ? turnStatusFor(state, child.owner.connectedFolderId, childTurn.taskId) : null;
    // A live turn's own status is sharper than the record's; a settled one
    // reads the record, which the turn journal already reconciled.
    const childState: AmpleFileActTurnState = live && live.state !== "unknown"
      ? live.state
      : childTurn.state === "accepted" || childTurn.state === "running"
        ? "running"
        : childTurn.state === "interrupted"
          ? "failed"
          : childTurn.state;
    return {
      taskId: childTurn.taskId,
      connectedFolderId: child.owner.connectedFolderId ?? ampleFileAgentScopeId,
      connectedFolderName: child.owner.connectedFolderName ?? child.owner.connectedFolderId ?? "the AmpleFile Agent",
      conversationId: child.owner.conversationId,
      state: childState,
      error: live?.error ?? childTurn.error,
      files: [],
    };
  });
  // Every changed file the children recorded, checked for visibility. No
  // prose parsing or folder scan; every candidate comes from the child's journal.
  const candidates = children.flatMap((child) => {
    const durable = state.turnStore.get(child.taskId);
    if (child.state === "running" || !durable || durable.connectedFolderId !== child.connectedFolderId || durable.conversationId !== child.conversationId) return [];
    return (durable.fileChanges?.files ?? []).map((file) => ({ child, path: file.path }));
  });
  const visible = await Promise.all(candidates.map(async (item) => await isConnectedFolderFileVisible(item.child.connectedFolderId, item.path) ? item : null));
  for (const item of visible.filter((item) => item !== null)) item.child.files.push(item.path);
  const actions = record.actions;
  let reply: { messageId: string; content: string } | null = null;
  const replyMessageId = turn.state === "succeeded" || turn.state === "failed"
    ? turn.messageId
    : turn.state === "unknown" && (newestTurn.state === "succeeded" || newestTurn.state === "failed")
      ? newestTurn.messageId
      : null;
  if (replyMessageId) {
    const transcriptRoot = record.owner.connectedFolderId
      ? await getConnectedFolder(record.owner.connectedFolderId).then((connectedFolder) => connectedFolder.connectedFolderRoot).catch(() => null)
      : ampleFileAgentRoot();
    const messages = transcriptRoot ? await readConversation(transcriptRoot, record.owner.conversationId).catch(() => []) : [];
    const message = messages.find((item) => item.id === replyMessageId);
    if (message) reply = { messageId: message.id, content: message.content };
  }
  const failedChild = children.find((child) => child.state === "failed" || child.state === "unknown");
  // The durable record already knows whether a child is still live; the
  // in-memory task view only sharpens what a live turn reports.
  const phase = ampleFileRequestStateToAgentPhase(record.state);
  const settledAt = record.settledAt ?? newestTurn.settledAt ?? turn.endedAt;
  const questions = state.requests.questions(record.requestId).map((question) => ({
    questionId: question.questionId,
    taskId: question.taskId,
    respondent: question.respondent,
    state: question.state,
    askedAt: question.askedAt,
    answeredAt: question.answeredAt,
  }));
  return {
    taskId: newestTurn.taskId,
    conversationId: record.owner.conversationId,
    phase,
    startedAt: record.createdAt,
    endedAt: phase === "working" || phase === "handed_off" ? null : settledAt,
    error: turn.error ?? newestTurn.error ?? failedChild?.error ?? (failedChild?.state === "unknown"
      ? `Connected Folder lost track of work started in ${failedChild.connectedFolderName}.`
      : record.limitHit ? requestLimitStopMessage(record.limitHit.limit) : null),
    content: record.content,
    attachments: record.attachments,
    dispositions: ampleFileAgentAttachmentDispositions({ attachments: record.attachments, actions: record.actions }),
    actions,
    children: children.map(({ files, ...child }) => files.length ? { ...child, files } : child),
    reply,
    requestId: record.requestId,
    kind: record.kind,
    rootId: record.rootId,
    state: record.state,
    deadline: record.deadline,
    limitHit: record.limitHit,
    questions,
    results: record.results.map((result) => ({
      resultId: result.resultId,
      taskId: result.taskId,
      outcome: result.outcome,
      recordedAt: result.recordedAt,
      fileCount: result.fileCount,
    })),
  };
}

function assertAmpleFileAgentParentAccepting(state: LocalApiState, parentTaskId: string | undefined): void {
  if (!parentTaskId) return;
  if (!state.requests.isAccepting(parentTaskId)) {
    throw new AmpleFileCliError("conflict", "The AmpleFile Agent request is stopping or has already finished.");
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

function toActAutomationTriggerRef(trigger: AmpleFileAutomationDeclaration["trigger"]): AmpleFileActAutomationTriggerRef {
  if (trigger.kind === "files-changed") {
    return {
      kind: trigger.kind,
      connectedFolderId: trigger.connectedFolder,
      watch: structuredClone(trigger.watch),
      debounceSeconds: trigger.debounceSeconds,
      cooldownMinutes: trigger.cooldownMinutes,
      ...(trigger.ifMissed !== undefined ? { ifMissed: trigger.ifMissed } : {}),
    };
  }
  if (trigger.kind === "interval") return { kind: "interval", intervalMinutes: trigger.intervalMinutes };
  if (trigger.kind === "at") return { kind: "at", at: trigger.at, ifMissed: trigger.ifMissed };
  return { kind: "manual" };
}

function toActAutomationSummary(projection: AmpleFileAutomationProjection): AmpleFileActAutomationSummary {
  return {
    automationId: projection.declaration.id,
    title: projection.declaration.title,
    health: projection.health,
    digest: projection.digest,
    trigger: toActAutomationTriggerRef(projection.declaration.trigger),
    ...(projection.fileWatch ? { fileWatch: projection.fileWatch } : {}),
    stepCount: projection.declaration.steps.length,
    referencedConnectedFolderIds: ampleFileAutomationReferencedConnectedFolderIds(projection.declaration),
    ...(projection.health === "enabled" && projection.grants.length > 0
      ? { enabledAt: projection.grants[projection.grants.length - 1]!.enabledAt }
      : {}),
    ...(projection.disabledAt ? { disabledAt: projection.disabledAt } : {}),
    ...(projection.suspension
      ? {
        suspension: {
          at: projection.suspension.at,
          missingConnectedFolderIds: [...projection.suspension.missingConnectedFolderIds],
          reRegisteredConnectedFolderIds: [...projection.suspension.reRegisteredConnectedFolderIds],
        },
      }
      : {}),
    ...(projection.lastScheduledAt ? { lastScheduledAt: projection.lastScheduledAt } : {}),
    ...(projection.nextScheduledAt ? { nextScheduledAt: projection.nextScheduledAt } : {}),
    ...(projection.atOccurrence?.finishedAt
      ? { completedAt: projection.atOccurrence.finishedAt }
      : projection.atOccurrence?.consumedAt
        ? { completedAt: projection.atOccurrence.consumedAt }
        : {}),
  };
}

function toActAutomationFilesSource(
  source: Extract<AmpleFileAutomationDeclaration["steps"][number], { kind: "files" }>["from"],
): { kind: "paths"; paths: string[] }
  | { kind: "tree"; path: string; recursive: boolean; extensions: string[] }
  | { kind: "step-created-files"; step: string; extensions?: string[]; maxFiles: number; maxTotalBytes: number } {
  if (source.kind === "paths") return { kind: "paths", paths: [...source.paths] };
  if (source.kind === "tree") return { kind: "tree", path: source.path, recursive: source.recursive, extensions: [...source.extensions] };
  return {
    kind: "step-created-files",
    step: source.step,
    ...(source.extensions ? { extensions: [...source.extensions] } : {}),
    maxFiles: source.maxFiles,
    maxTotalBytes: source.maxTotalBytes,
  };
}

const automationReceiptProjectionLimit = 500;
const automationReceiptTextLimit = 4_096;
const automationReceiptListLimit = 128;

async function readAutomationReceiptProjection(automationId?: string): Promise<{
  receipts: AmpleFileActAutomationReceipt[];
  truncated: boolean;
  damagedLineCount: number;
}> {
  const matching: AmpleFileActAutomationReceipt[] = [];
  const damagedLineCount = await visitAutomationReceipts((projected) => {
    if (automationId === undefined || projected.automationId === automationId) matching.push(projected);
  });
  return {
    receipts: matching.slice(-automationReceiptProjectionLimit).reverse(),
    truncated: matching.length > automationReceiptProjectionLimit,
    damagedLineCount,
  };
}

async function readAutomationReceiptProjectionsByAutomation(): Promise<{
  receipts: AmpleFileActAutomationReceipt[];
  truncated: boolean;
  damagedLineCount: number;
}> {
  const matchingByAutomation = new Map<string, AmpleFileActAutomationReceipt[]>();
  let truncated = false;
  const damagedLineCount = await visitAutomationReceipts((projected) => {
    const bucket = matchingByAutomation.get(projected.automationId) ?? [];
    bucket.push(projected);
    if (bucket.length > automationReceiptProjectionLimit) {
      bucket.shift();
      truncated = true;
    }
    matchingByAutomation.set(projected.automationId, bucket);
  });
  return {
    receipts: [...matchingByAutomation.values()].flat().sort((left, right) => Date.parse(right.at) - Date.parse(left.at)),
    truncated,
    damagedLineCount,
  };
}

async function visitAutomationReceipts(visitor: (receipt: AmpleFileActAutomationReceipt) => void): Promise<number> {
  let damagedLineCount = 0;
  for (const path of [ampleFileAutomationReceiptsRotatedFile(), ampleFileAutomationReceiptsFile()]) {
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AmpleFileCliError("failure", "AmpleFile could not read the automation run history.", { cause: error });
    });
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        damagedLineCount += 1;
        continue;
      }
      const projected = projectAutomationReceipt(parsed);
      if (!projected) {
        damagedLineCount += 1;
        continue;
      }
      visitor(projected);
    }
  }
  return damagedLineCount;
}

function projectAutomationReceipt(value: unknown): AmpleFileActAutomationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Partial<AmpleFileAutomationReceiptV1>;
  const at = automationReceiptTimestamp(receipt.at);
  const automationId = automationReceiptText(receipt.automationId);
  const outcome = automationReceiptText(receipt.outcome);
  if (!at || !automationId || !outcome || (receipt.scope !== "automation" && receipt.scope !== "run" && receipt.scope !== "hop")) {
    return null;
  }
  const projected: AmpleFileActAutomationReceipt = { at, scope: receipt.scope, outcome, automationId };
  const addText = (key: keyof AmpleFileActAutomationReceipt, candidate: unknown) => {
    const text = automationReceiptText(candidate);
    if (text !== undefined) (projected as unknown as Record<string, unknown>)[key] = text;
  };
  addText("runId", receipt.runId);
  addText("hopId", receipt.hopId);
  // Lines an earlier build wrote may name a `check` hop; it is not projected.
  if (receipt.hopKind === "chat" || receipt.hopKind === "files" || receipt.hopKind === "agent") {
    projected.hopKind = receipt.hopKind;
  }
  addText("title", receipt.title);
  addText("digest", receipt.digest);
  addText("detail", receipt.detail);
  if (receipt.partial === true && outcome === "succeeded") projected.partial = true;
  const cause = projectAutomationReceiptCause(receipt.cause);
  if (cause !== undefined) projected.cause = cause;
  addText("connectedFolderId", receipt.connectedFolderId);
  addText("fromConnectedFolderId", receipt.fromConnectedFolderId);
  addText("toConnectedFolderId", receipt.toConnectedFolderId);
  addText("conversationId", receipt.conversationId);
  addText("taskId", receipt.taskId);
  addText("restorePointId", receipt.restorePointId);
  addText("failedHopId", receipt.failedHopId);
  addText("surface", receipt.surface);
  addText("requestId", receipt.requestId);
  addText("occurrenceId", receipt.occurrenceId);
  addText("scheduledRunId", receipt.scheduledRunId);
  const addList = (key: keyof AmpleFileActAutomationReceipt, candidate: unknown) => {
    const list = automationReceiptTextList(candidate);
    if (list !== undefined) (projected as unknown as Record<string, unknown>)[key] = list;
  };
  addList("checkpointIds", receipt.checkpointIds);
  addList("sourcePaths", receipt.sourcePaths);
  addList("copiedPaths", receipt.copiedPaths);
  addList("stoppedHopTaskIds", receipt.stoppedHopTaskIds);
  addList("missingConnectedFolderIds", receipt.missingConnectedFolderIds);
  const addCount = (key: keyof AmpleFileActAutomationReceipt, candidate: unknown) => {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      (projected as unknown as Record<string, unknown>)[key] = Math.floor(candidate);
    }
  };
  addCount("fileCount", receipt.fileCount);
  addCount("totalBytes", receipt.totalBytes);
  addCount("messageBytes", receipt.messageBytes);
  const placeholders = projectAutomationReceiptPlaceholders(receipt.placeholders);
  if (placeholders) projected.placeholders = placeholders;
  return projected;
}

/**
 * What AmpleFile filled into a hop's message, bounded exactly as the executor
 * bounded it. Text keeps its newlines — it is a list — so it is length-bounded
 * rather than run through the single-line text projector.
 */
function projectAutomationReceiptPlaceholders(
  value: unknown,
): Array<{ name: string; text: string; bytes: number; truncated: boolean }> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const projected: Array<{ name: string; text: string; bytes: number; truncated: boolean }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const placeholder = entry as Record<string, unknown>;
    const name = automationReceiptText(placeholder.name);
    if (!name || name.length > 128) return undefined;
    if (typeof placeholder.text !== "string" || placeholder.text.length > ampleFileAutomationBounds.maxPlaceholderTextBytes) {
      return undefined;
    }
    if (!Number.isSafeInteger(placeholder.bytes) || (placeholder.bytes as number) < 0) return undefined;
    if (typeof placeholder.truncated !== "boolean") return undefined;
    projected.push({
      name,
      text: placeholder.text,
      bytes: placeholder.bytes as number,
      truncated: placeholder.truncated,
    });
  }
  return projected;
}

function projectAutomationReceiptCause(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cause = value as Record<string, unknown>;
  if ((cause.kind === "scheduled" || cause.kind === "resume") && automationReceiptTimestamp(cause.slotAt)) {
    return { kind: cause.kind, slotAt: automationReceiptTimestamp(cause.slotAt)! };
  }
  // A live change and a catch-up both list at most the observer's files on
  // each side of the comparison, so the true count never exceeds twice that.
  if (cause.kind === "files-changed" && typeof cause.snapshotDigest === "string" && /^[a-f0-9]{64}$/.test(cause.snapshotDigest) && Number.isSafeInteger(cause.changedCount) && (cause.changedCount as number) > 0 && (cause.changedCount as number) <= 2 * ampleFileAutomationFileObserverBounds.maxFiles && automationReceiptText(cause.connectedFolderId)) {
    const changedPaths = automationReceiptTextList(cause.changedPaths);
    const catchUp = automationReceiptCatchUp(cause.catchUp, cause.changedCount as number);
    return {
      kind: cause.kind,
      connectedFolderId: automationReceiptText(cause.connectedFolderId),
      snapshotDigest: cause.snapshotDigest,
      changedCount: cause.changedCount,
      ...(changedPaths?.length ? { changedPaths } : {}),
      ...(catchUp ? { catchUp } : {}),
    };
  }
  if (cause.kind === "run-now") {
    const surface = typeof cause.surface === "string" && AMPLEFILE_CLI_ACT_SURFACES.includes(cause.surface as never)
      ? cause.surface
      : undefined;
    return {
      kind: "run-now",
      ...(automationReceiptText(cause.requestId) ? { requestId: automationReceiptText(cause.requestId) } : {}),
      ...(surface ? { surface } : {}),
    };
  }
  // An `on-settled` cause older builds wrote (a Check run or a Connected
  // Folder app's automation settling) is not projected.
  return undefined;
}

function automationReceiptText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > automationReceiptTextLimit) return undefined;
  if (/\p{Cc}|\p{Cf}/u.test(value)) return undefined;
  return value;
}

function automationReceiptTimestamp(value: unknown): string | undefined {
  const text = automationReceiptText(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined;
}

/** A recorded catch-up, or undefined when the field is absent or not the closed shape. */
function automationReceiptCatchUp(value: unknown, changedCount: number): { reason: AutomationCatchUpReason; count: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { reason, count } = value as Record<string, unknown>;
  if (typeof reason !== "string" || !(automationCatchUpReasons as readonly string[]).includes(reason)) return undefined;
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > changedCount) return undefined;
  return { reason: reason as AutomationCatchUpReason, count: count as number };
}

function automationReceiptTextList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > automationReceiptListLimit) return undefined;
  const values = value.map(automationReceiptText);
  return values.every((item): item is string => item !== undefined) ? values : undefined;
}

function createAmpleFileAutomationSettingsFacade(state: LocalApiState): AmpleFileAutomationSettingsFacade {
  return {
    async list() {
      const projections = await runActOperation(() => state.automations.listAutomations());
      const receiptProjection = await readAutomationReceiptProjectionsByAutomation();
      const historyByAutomation = new Map<string, AmpleFileAutomationSettingsHistory>();
      for (const projection of projections) {
        const history = await automationSettingsHistoryFromProjection(
          projection.declaration.id,
          receiptProjection,
        );
        historyByAutomation.set(projection.declaration.id, history);
      }
      return {
        automations: await Promise.all(projections.map(async (projection) =>
          await automationSettingsSummary(projection, historyByAutomation.get(projection.declaration.id) ?? { runs: [] }))),
        status: state.automations.status(),
      };
    },
    async proposals() {
      const scan = await scanAmpleFileAutomationProposals(ampleFileAgentRoot());
      // A proposal already stored at the same digest shows once, in the main
      // list, whatever its health.
      const stored = new Set((await runActOperation(() => state.automations.listAutomations()))
        .map((projection) => `${projection.declaration.id}\n${projection.digest}`));
      const proposals: AmpleFileAutomationSettingsProposalView[] = [];
      for (const entry of scan.entries) {
        const normalized = entry.valid ? entry : entry.normalized;
        if (normalized && stored.has(`${normalized.declaration.id}\n${normalized.digest}`)) continue;
        if (!entry.valid) {
          proposals.push({ valid: false, path: entry.path, fileName: entry.fileName, problem: entry.problem });
          continue;
        }
        const missing: string[] = [];
        for (const connectedFolderId of ampleFileAutomationReferencedConnectedFolderIds(entry.declaration)) {
          if (!await getConnectedFolder(connectedFolderId).catch(() => null)) missing.push(connectedFolderId);
        }
        if (missing.length) {
          proposals.push({
            valid: false,
            path: entry.path,
            fileName: entry.fileName,
            problem: `Names a Connected Folder that is not on this computer (${missing.join(", ")}).`,
          });
          continue;
        }
        proposals.push({
          valid: true,
          path: entry.path,
          fileName: entry.fileName,
          automationId: entry.declaration.id,
          digest: entry.digest,
          title: entry.declaration.title,
          trigger: toActAutomationTriggerRef(entry.declaration.trigger),
        });
      }
      return { proposals, truncated: scan.truncated };
    },
    async enableProposal(path) {
      let proposalPath: string;
      try {
        proposalPath = resolveAmpleFileAutomationProposalPath(ampleFileAgentRoot(), path);
      } catch (error) {
        throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
      }
      // The exact CLI enable path: read and digest the file now, then the
      // journaled prepared-act enablement pinned to that digest.
      const result = await runDesktopSettingsAct(state, "automations.enable", async (requestId) => {
        const { declaration, digest } = await readAutomationStagingFile(proposalPath, ampleFileAgentRoot());
        const enabled = await enableStoredAutomationDeclaration(state, declaration, digest, {
          requestId,
          surface: "main-window",
        });
        return { value: enabled, detail: `Enabled automation ${enabled.automationId} from ${basename(proposalPath)}.` };
      });
      const projection = await requireSettingsAutomation(state, result.value.automationId);
      const history = await automationSettingsHistory(projection.declaration.id);
      return {
        automationId: result.value.automationId,
        requestId: result.requestId,
        enabled: true as const,
        alreadyEnabled: result.value.alreadyEnabled,
        automation: await automationSettingsSummary(projection, history),
      };
    },
    async show(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      const history = await automationSettingsHistory(projection.declaration.id);
      const summary = await automationSettingsSummary(projection, history);
      const connectedFolders = summary.connectedFolders;
      const byId = new Map(connectedFolders.map((connectedFolder) => [connectedFolder.connectedFolderId, connectedFolder]));
      const named = (connectedFolderId: string): AmpleFileAutomationSettingsConnectedFolderRef => byId.get(connectedFolderId) ?? { connectedFolderId };
      return {
        automation: {
          ...summary,
          createdAt: projection.declaration.createdAt,
          connectedFolders,
          steps: projection.declaration.steps.map((step) => step.kind === "chat"
            ? { id: step.id, kind: "chat" as const, connectedFolder: named(step.connectedFolder), message: step.message, ...(step.model ? { model: step.model } : {}) }
            : step.kind === "files"
              ? {
                id: step.id,
                kind: "files" as const,
                fromConnectedFolder: named(step.fromConnectedFolder),
                toConnectedFolder: named(step.toConnectedFolder),
                to: step.to,
                source: toActAutomationFilesSource(step.from),
              }
              : { id: step.id, kind: "agent" as const, message: step.message, ...(step.model ? { model: step.model } : {}) }),
          ...(projection.atOccurrence?.finishedAt
            ? { completedAt: projection.atOccurrence.finishedAt }
            : projection.atOccurrence?.consumedAt
              ? { completedAt: projection.atOccurrence.consumedAt }
              : {}),
        },
      };
    },
    async history(automationId) {
      await requireSettingsAutomation(state, automationId);
      return await automationSettingsHistory(automationId);
    },
    async enable(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      if (projection.health === "enabled") {
        throw new AmpleFileCliError("conflict", "This automation is already on.");
      }
      if (projection.health === "completed") {
        throw new AmpleFileCliError(
          "conflict",
          "This one-time automation is complete. Ask the AmpleFile Agent to set up a new automation for another time.",
        );
      }
      const result = await runDesktopSettingsAct(state, "automations.enable", async (requestId) => {
        const enabled = await enableStoredAutomationDeclaration(state, projection.declaration, projection.digest, {
          requestId,
          surface: "main-window",
        });
        return {
          value: {
            automationId: enabled.automationId,
            requestId,
            enabled: true as const,
            alreadyEnabled: enabled.alreadyEnabled,
          },
          detail: `Enabled automation ${enabled.automationId}.`,
        };
      });
      return result.value;
    },
    async enableTemplate(connectedFolderId, templateId) {
      if (!isAutomationTemplateId(templateId)) throw new AmpleFileCliError("usage", "That ready-made Automation doesn't exist.");
      const connectedFolder = await getConnectedFolder(connectedFolderId);
      const automationId = automationTemplateAutomationId(templateId, connectedFolder.id);
      const stored = await runActOperation(() => state.automations.getAutomation(automationId));
      if (stored?.health === "enabled") return { automationId, requestId: "", enabled: true as const, alreadyEnabled: true };
      // A ready-made Automation turned off earlier keeps its declaration, so Turn on is the same Automation.
      const { declaration, digest } = stored && stored.health !== "completed"
        ? { declaration: stored.declaration, digest: stored.digest }
        : automationTemplateDeclaration(templateId, connectedFolder.id);
      const result = await runDesktopSettingsAct(state, "automations.enable", async (requestId) => {
        const enabled = await enableStoredAutomationDeclaration(state, declaration, digest, { requestId, surface: "main-window" });
        return {
          value: { automationId: enabled.automationId, requestId, enabled: true as const, alreadyEnabled: enabled.alreadyEnabled },
          detail: `Enabled the ready-made automation ${enabled.automationId} in ${connectedFolder.name}.`,
        };
      });
      return result.value;
    },
    async run(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      if (projection.health !== "enabled") throw automationHealthConflict(projection.health);
      const requestId = `settings:${randomUUID()}`;
      const receipt = { requestId, command: "automations.run", surface: "main-window" as const };
      if (!await state.actReceipts.append({ ...receipt, outcome: "accepted" })) {
        throw new AmpleFileCliError(
          "failure",
          "AmpleFile could not journal this Settings action, so nothing was changed.",
        );
      }
      let admission;
      try {
        admission = await runActOperation(() => state.automations.runNowAdmission(projection.declaration.id, {
          requestId,
          surface: "main-window",
        }));
      } catch (error) {
        await state.actReceipts.append({
          ...receipt,
          outcome: "error",
          ...(error instanceof AmpleFileCliError ? { errorCode: error.code } : {}),
          detail: errorMessage(error),
        }).catch(() => false);
        throw error;
      }
      void admission.result.then(async (result) => {
        await state.actReceipts.append({
          ...receipt,
          outcome: "ok",
          detail: `Automation ${projection.declaration.id} settled ${result.outcome} as run ${result.runId}.`,
        }).catch(() => false);
      });
      return {
        automationId: projection.declaration.id,
        requestId,
        runId: admission.runId,
        accepted: true,
      };
    },
    async stop(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      const result = await runDesktopSettingsAct(state, "automations.stop", async (requestId) => {
        const stopped = state.automations.stopRun(projection.declaration.id, { requestId, surface: "main-window" });
        if (!stopped) throw new AmpleFileCliError("conflict", "This automation has no active run.");
        return {
          value: stopped,
          detail: `Stopped automation ${projection.declaration.id} run ${stopped.runId}.`,
        };
      });
      return {
        automationId: projection.declaration.id,
        requestId: result.requestId,
        runId: result.value.runId,
        stopped: true,
      };
    },
    async disable(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      const result = await runDesktopSettingsAct(state, "automations.disable", async (requestId) => {
        const disabled = await runActOperation(() => state.automations.disable(projection.declaration.id, {
          requestId,
          surface: "main-window",
        }));
        return {
          value: disabled,
          detail: `Disabled automation ${projection.declaration.id}.`,
        };
      });
      return {
        automationId: projection.declaration.id,
        requestId: result.requestId,
        disabled: true,
        stoppedRunId: result.value.stoppedRunId,
      };
    },
    async delete(automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      if (projection.health === "enabled") {
        throw new AmpleFileCliError("conflict", "Turn this automation off before deleting it.");
      }
      if (projection.activeRunId) {
        throw new AmpleFileCliError("conflict", "Stop this automation's active run before deleting it.");
      }
      const result = await runDesktopSettingsAct(state, "automations.delete", async (requestId) => {
        await runActOperation(() => state.automations.deleteAutomation(projection.declaration.id, {
          requestId,
          surface: "main-window",
        }));
        return { value: true, detail: `Deleted automation ${projection.declaration.id}; its run history was retained.` };
      });
      return { automationId: projection.declaration.id, requestId: result.requestId, deleted: true };
    },
    async forConnectedFolder(connectedFolderId) {
      const projections = (await runActOperation(() => state.automations.listAutomations()))
        .filter((projection) => ampleFileAutomationReferencedConnectedFolderIds(projection.declaration).includes(connectedFolderId));
      if (!projections.length) return { automations: [] };
      const receiptProjection = await readAutomationReceiptProjectionsByAutomation();
      const automations: FolderAutomationView[] = [];
      for (const projection of projections) {
        const history = await automationSettingsHistoryFromProjection(projection.declaration.id, receiptProjection);
        const summary = await automationSettingsSummary(projection, history);
        automations.push(folderAutomationView(projection, summary, connectedFolderId));
      }
      return { automations };
    },
    async requireConnectedFolderAutomation(connectedFolderId, automationId) {
      const projection = await requireSettingsAutomation(state, automationId);
      if (!ampleFileAutomationReferencedConnectedFolderIds(projection.declaration).includes(connectedFolderId)) {
        throw new AmpleFileCliError("notFound", "This automation does not touch this folder.");
      }
    },
  };
}

function folderAutomationView(
  projection: AmpleFileAutomationProjection,
  summary: AmpleFileAutomationSettingsSummary,
  connectedFolderId: string,
): FolderAutomationView {
  // The act-lane trigger ref is the loose superset of the discriminated view
  // Settings already renders over IPC.
  const trigger = summary.trigger as AutomationTriggerView;
  const state: FolderAutomationState = summary.activeRun
    ? "running"
    : ({ enabled: "on", disabled: "off", suspended: "suspended", completed: "completed" } as const)[summary.health];
  return {
    automationId: summary.automationId,
    title: summary.title,
    state,
    triggerSummary: automationTriggerSummary(trigger),
    nextRunAt: summary.nextScheduledAt ?? null,
    lastRun: summary.lastRun
      ? { at: summary.lastRun.startedAt, outcome: summary.lastRun.outcome, ...(summary.lastRun.partial ? { partial: true as const } : {}) }
      : null,
    roles: ampleFileAutomationConnectedFolderRoles(projection.declaration, connectedFolderId),
  };
}

async function requireSettingsAutomation(state: LocalApiState, automationId: string): Promise<AmpleFileAutomationProjection> {
  const id = automationId.trim();
  if (!id) throw new AmpleFileCliError("usage", "An automation id is required.");
  const projection = await runActOperation(() => state.automations.getAutomation(id));
  if (!projection) throw new AmpleFileCliError("notFound", "No automation has this id on this machine.");
  return projection;
}

function automationHealthConflict(health: AmpleFileAutomationProjection["health"]): AmpleFileCliError {
  return new AmpleFileCliError(
    "conflict",
    health === "completed"
      ? "This one-time automation is complete."
      : health === "suspended"
        ? "This automation is suspended because a referenced Connected Folder was removed."
        : "This automation is off.",
  );
}

async function automationSettingsConnectedFolderRefs(connectedFolderIds: string[]): Promise<AmpleFileAutomationSettingsConnectedFolderRef[]> {
  return await Promise.all(connectedFolderIds.map(async (connectedFolderId) => {
    const connectedFolder = await getConnectedFolder(connectedFolderId).catch(() => null);
    return { connectedFolderId, ...(connectedFolder ? { connectedFolderName: connectedFolder.name } : {}) };
  }));
}

async function automationSettingsSummary(
  projection: AmpleFileAutomationProjection,
  history: Pick<AmpleFileAutomationSettingsHistory, "runs" | "lastCatchUp">,
): Promise<AmpleFileAutomationSettingsSummary> {
  const runs = history.runs;
  const lastRun = runs[0];
  const active = projection.activeRunId ? runs.find((run) => run.runId === projection.activeRunId) : undefined;
  const missingConnectedFolders = projection.suspension
    ? await automationSettingsConnectedFolderRefs(projection.suspension.missingConnectedFolderIds)
    : undefined;
  return {
    automationId: projection.declaration.id,
    title: projection.declaration.title,
    health: projection.health,
    trigger: toActAutomationTriggerRef(projection.declaration.trigger),
    ...(projection.fileWatch ? { fileWatch: projection.fileWatch } : {}),
    stepCount: projection.declaration.steps.length,
    connectedFolders: await automationSettingsConnectedFolderRefs(ampleFileAutomationReferencedConnectedFolderIds(projection.declaration)),
    ...(projection.nextScheduledAt ? { nextScheduledAt: projection.nextScheduledAt } : {}),
    ...(projection.lastScheduledAt ? { lastScheduledAt: projection.lastScheduledAt } : {}),
    ...(projection.activeRunId && active ? { activeRun: { runId: projection.activeRunId, startedAt: active.startedAt } } : {}),
    ...(lastRun
      ? {
        lastRun: {
          runId: lastRun.runId,
          outcome: lastRun.outcome,
          startedAt: lastRun.startedAt,
          ...(lastRun.finishedAt ? { finishedAt: lastRun.finishedAt } : {}),
          ...(lastRun.partial ? { partial: true as const } : {}),
        },
      }
      : {}),
    ...(history.lastCatchUp ? { lastCatchUp: history.lastCatchUp } : {}),
    ...(projection.suspension
      ? {
        suspension: {
          at: projection.suspension.at,
          reason: "A referenced Connected Folder was removed. Review the automation before turning it on again.",
          ...(missingConnectedFolders?.length ? { missingConnectedFolders } : {}),
        },
      }
      : {}),
  };
}

type AmpleFileAutomationSettingsHistory = {
  runs: AmpleFileAutomationSettingsRunView[];
  truncated: boolean;
  damagedLineCount: number;
  lastCatchUp?: AmpleFileAutomationSettingsSummary["lastCatchUp"];
};

async function automationSettingsHistory(automationId: string): Promise<AmpleFileAutomationSettingsHistory> {
  const projected = await readAutomationReceiptProjection(automationId);
  return await automationSettingsHistoryFromProjection(automationId, projected);
}

async function automationSettingsHistoryFromProjection(
  automationId: string,
  projection: Awaited<ReturnType<typeof readAutomationReceiptProjection>>,
): Promise<AmpleFileAutomationSettingsHistory> {
  const projected = {
    ...projection,
    receipts: projection.receipts.filter((receipt) => receipt.automationId === automationId),
  };
  const connectedFolderIds = new Set<string>();
  for (const receipt of projected.receipts) {
    if (receipt.connectedFolderId) connectedFolderIds.add(receipt.connectedFolderId);
    if (receipt.fromConnectedFolderId) connectedFolderIds.add(receipt.fromConnectedFolderId);
    if (receipt.toConnectedFolderId) connectedFolderIds.add(receipt.toConnectedFolderId);
  }
  const connectedFolders = await automationSettingsConnectedFolderRefs([...connectedFolderIds]);
  const connectedFolderNames = new Map(connectedFolders.filter((connectedFolder) => connectedFolder.connectedFolderName).map((connectedFolder) => [connectedFolder.connectedFolderId, connectedFolder.connectedFolderName!]));
  const runs = new Map<string, AmpleFileAutomationSettingsRunView & { hopsById: Map<string, AmpleFileAutomationSettingsRunView["hops"][number]> }>();
  let lastCatchUp: AmpleFileAutomationSettingsHistory["lastCatchUp"];
  for (const receipt of [...projected.receipts].reverse()) {
    if (!receipt.runId || (receipt.scope !== "run" && receipt.scope !== "hop")) continue;
    if (receipt.scope === "run" && receipt.outcome === "accepted") {
      const caughtUp = automationSettingsCatchUp(receipt.cause);
      if (caughtUp && (!lastCatchUp || Date.parse(receipt.at) > Date.parse(lastCatchUp.at))) {
        lastCatchUp = { runId: receipt.runId, at: receipt.at, ...caughtUp };
      }
    }
    let run = runs.get(receipt.runId);
    if (!run) {
      run = {
        runId: receipt.runId,
        outcome: "accepted",
        startedAt: receipt.at,
        hops: [],
        hopsById: new Map(),
      };
      runs.set(receipt.runId, run);
    }
    if (receipt.scope === "run") {
      if (receipt.outcome === "accepted") {
        run.startedAt = receipt.at;
        const cause = automationSettingsCause(receipt.cause);
        if (cause) run.cause = cause;
      } else if (isAutomationSettingsOutcome(receipt.outcome)) {
        run.outcome = receipt.outcome;
        run.finishedAt = receipt.at;
        if (receipt.detail) run.detail = receipt.detail;
        if (receipt.partial) run.partial = true;
      }
      continue;
    }
    if (!receipt.hopId || !receipt.hopKind) continue;
    let hop = run.hopsById.get(receipt.hopId);
    if (!hop) {
      hop = { hopId: receipt.hopId, kind: receipt.hopKind, outcome: "accepted" };
      run.hopsById.set(receipt.hopId, hop);
      run.hops.push(hop);
    }
    if (isAutomationSettingsOutcome(receipt.outcome)) hop.outcome = receipt.outcome;
    if (receipt.partial) hop.partial = true;
    const connectedFolderId = receipt.connectedFolderId ?? receipt.toConnectedFolderId ?? receipt.fromConnectedFolderId;
    if (connectedFolderId && connectedFolderNames.has(connectedFolderId)) hop.connectedFolderName = connectedFolderNames.get(connectedFolderId);
    if (receipt.detail) hop.detail = receipt.detail;
    const evidence = automationSettingsEvidence(receipt);
    if (evidence.length) hop.evidence = evidence;
  }
  return {
    runs: [...runs.values()]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, 50)
      .map(({ hopsById: _hopsById, ...run }) => run),
    truncated: projected.truncated || runs.size > 50,
    damagedLineCount: projected.damagedLineCount,
    ...(lastCatchUp ? { lastCatchUp } : {}),
  };
}

function automationSettingsCatchUp(value: unknown): { count: number; reason: AutomationCatchUpReason } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cause = value as Record<string, unknown>;
  return cause.kind === "files-changed" ? automationReceiptCatchUp(cause.catchUp, Number(cause.changedCount)) : undefined;
}

function isAutomationSettingsOutcome(value: string): value is AmpleFileAutomationSettingsOutcome {
  return value === "accepted"
    || value === "succeeded"
    || value === "failed"
    || value === "stopped"
    || value === "interrupted"
    || value === "skipped"
    || value === "lapsed";
}

function automationSettingsCause(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cause = value as Record<string, unknown>;
  if (cause.kind === "files-changed") {
    const catchUp = automationReceiptCatchUp(cause.catchUp, Number(cause.changedCount));
    return catchUp ? automationCatchUpSentence(catchUp.count, catchUp.reason) : `Folder changed · ${cause.changedCount} file(s)`;
  }
  if (cause.kind === "run-now") return "Run Now";
  if ((cause.kind === "scheduled" || cause.kind === "resume") && typeof cause.slotAt === "string") {
    return cause.kind === "resume" ? `Caught up from ${cause.slotAt}` : `Scheduled for ${cause.slotAt}`;
  }
  return undefined;
}

function automationSettingsEvidence(receipt: AmpleFileActAutomationReceipt): Array<{ label: string; value: string }> {
  const evidence: Array<{ label: string; value: string }> = [];
  if (receipt.conversationId) evidence.push({ label: "Chat", value: receipt.conversationId });
  if (receipt.taskId) evidence.push({ label: "Task", value: receipt.taskId });
  if (receipt.checkpointIds?.length) evidence.push({ label: "History", value: receipt.checkpointIds.join(", ") });
  if (receipt.restorePointId) evidence.push({ label: "Restore point", value: receipt.restorePointId });
  if (receipt.fileCount !== undefined) evidence.push({ label: "Files", value: String(receipt.fileCount) });
  if (receipt.totalBytes !== undefined) evidence.push({ label: "Bytes", value: String(receipt.totalBytes) });
  if (receipt.placeholders?.length) {
    evidence.push({ label: "Filled in", value: receipt.placeholders.map((placeholder) => placeholder.name).join(", ") });
  }
  return evidence;
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

/** Person-facing work is scoped to one request and its deliberately linked work. */
async function ampleFileAgentConversationAttention(state: LocalApiState, conversationId: string) {
  const record = state.requests.latestForConversation(conversationId);
  const work = record?.state === "waiting" ? await requestPresentation(state, record) : null;
  return { requestState: record?.state ?? null, needsAnswer: (work?.questionCount ?? 0) > 0
    || extensionSnapshot(state, { connectedFolderRoot: ampleFileAgentRoot(), conversationId }).length > 0 };
}

export function toActConnectedFolderRef(connectedFolder: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">): AmpleFileActConnectedFolderRef {
  return { id: connectedFolder.id, name: connectedFolder.name, connectedFolderRoot: connectedFolder.connectedFolderRoot };
}

function toActConversationRef(conversation: ConversationSummary): AmpleFileActConversationRef {
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
function preparedActAttribution(surface: AmpleFileCliActSurface): PreparedActAttribution {
  return { surface };
}

/** The act executor's lineage resolution: an explicitly named management parent is valid while its turn is active. */
function resolveAmpleFileAgentLineageParent(
  state: LocalApiState,
  taskId: string,
): { taskId: string } | null {
  return state.requests.isAccepting(taskId) ? { taskId } : null;
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

async function runPreparedActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PreparedActError) throw mapPreparedActError(error);
    throw error;
  }
}

/**
 * The shared automation enablement door for the act lane and trusted desktop
 * Settings (docs/automations.md): normalize the declaration, check the
 * one-time horizon, verify the pinned digest and that every referenced
 * Connected Folder is registered, then run the `automation.enable` prepared act with the
 * normalized declaration as execution context. Keeping this outside the
 * act-facade closure prevents Settings from growing a second, subtly
 * different enablement path.
 */
async function enableStoredAutomationDeclaration(
  state: LocalApiState,
  declaration: AmpleFileAutomationDeclaration,
  digest: string,
  context: {
    surface: AmpleFileCliActSurface;
    parentTaskId?: string;
    requestId?: string;
  },
): Promise<{
  automationId: string;
  declarationDigest: string;
  title: string;
  referencedConnectedFolderIds: string[];
  health: "enabled";
  enabledAt: string;
  /** True when this exact declaration was already on, so nothing changed. */
  alreadyEnabled: boolean;
  /** A run that was executing the previous declaration and was stopped. */
  stoppedRunId: string | null;
}> {
  const normalized = normalizeAmpleFileAutomationDeclaration(declaration);
  try {
    assertAmpleFileAutomationAtAdmissionHorizon(normalized, new Date());
  } catch (error) {
    throw new AmpleFileCliError("conflict", errorMessage(error), { cause: error });
  }
  const actualDigest = ampleFileAutomationDigest(normalized);
  if (actualDigest !== digest) {
    throw new AmpleFileCliError(
      "conflict",
      "The automation declaration no longer matches its digest; nothing was enabled.",
    );
  }
  const referencedConnectedFolderIds = ampleFileAutomationReferencedConnectedFolderIds(normalized);
  for (const connectedFolderId of referencedConnectedFolderIds) {
    const registered = await getConnectedFolder(connectedFolderId).catch(() => null);
    if (!registered) {
      throw new AmpleFileCliError(
        "conflict",
        `The Automation references a Connected Folder that is not registered on this machine (${connectedFolderId}).`,
      );
    }
  }
  const requestId = context.requestId?.trim() || randomUUID();
  const before = await runActOperation(() => state.automations.getAutomation(normalized.id));
  const alreadyEnabled = before?.health === "enabled" && before.digest === digest;
  const automationContext: AutomationEnableContext = {
    declaration: normalized,
    requestId,
    attribution: preparedActAttribution(context.surface),
  };
  await runActOperation(() => runPreparedActOperation(async () => {
    const act = prepareAct({
      kind: "automation.enable",
      parameters: { automationId: normalized.id },
      pins: { automationId: normalized.id, declarationDigest: digest },
    });
    await state.preparedActs.run({ act, requestId, context: automationContext });
  }));
  const record = automationContext.outcome;
  return {
    automationId: normalized.id,
    declarationDigest: digest,
    title: normalized.title,
    referencedConnectedFolderIds,
    health: "enabled",
    enabledAt: record?.grants[record.grants.length - 1]?.enabledAt ?? new Date().toISOString(),
    alreadyEnabled,
    // Enabling a changed declaration stops the run still executing the prior
    // one: revocation stops stale work before the change reads as complete.
    stoppedRunId: !alreadyEnabled && before?.activeRunId !== undefined ? before.activeRunId : null,
  };
}

/**
 * Reads one inert typed automation file — a proposal or a full declaration —
 * and normalizes it into the declaration enablement will verify. A proposal
 * gains a deterministic content-derived automation id, so identical content
 * always names one automation.
 */
async function readAutomationStagingFile(
  proposalPath: string,
  cwd: string,
): Promise<{ declaration: AmpleFileAutomationDeclaration; digest: string }> {
  const path = isAbsolute(proposalPath) ? resolve(proposalPath) : resolve(cwd, proposalPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readAmpleFileAutomationDocument(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || errorMessage(error).includes("ordinary file")) {
      throw new AmpleFileCliError("notFound", "The automation proposal must be a regular file on this machine.", { cause: error });
    }
    throw new AmpleFileCliError("usage", `The automation proposal is not readable JSON: ${errorMessage(error)}`, { cause: error });
  }
  const kind = (parsed as { kind?: unknown } | null)?.kind;
  try {
    if (kind === ampleFileAutomationProposalKind) {
      return contentAddressedAmpleFileAutomationDeclaration(normalizeAmpleFileAutomationProposal(parsed));
    }
    if (kind === ampleFileAutomationDeclarationKind) {
      const declaration = normalizeAmpleFileAutomationDeclaration(parsed);
      return { declaration, digest: ampleFileAutomationDigest(declaration) };
    }
  } catch (error) {
    throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
  }
  throw new AmpleFileCliError(
    "usage",
    `The file is not a typed automation proposal (${ampleFileAutomationProposalKind}) or declaration (${ampleFileAutomationDeclarationKind}); nothing else is accepted.`,
  );
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

interface AutomationEnableContext extends PreparedActOutcome<AmpleFileAutomationRecord> {
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

/**
 * The automation executor's hop ports: the same in-process internals the act
 * facade uses — turn acceptance in a fresh Chat, a new thread of the
 * AmpleFile Agent, and the files-add copy with its restore point — honoring
 * aborts through each domain's own abort path,
 * and returning identifiers and counts only. The executor fills every
 * placeholder before it calls a message port, so `message` is exactly what
 * the hop sends.
 */
function createAutomationHopPorts(state: LocalApiState): AmpleFileAutomationHopPorts {
  return {
    async chat(step, message, context) {
      const connectedFolder = await getConnectedFolder(step.connectedFolder);
      const conversation = await createConversation(connectedFolder.connectedFolderRoot);
      // A step's own model applies to this new Chat only: Pi records it in the
      // session without touching the Connected Folder's or anyone's defaults.
      if (step.model) await (await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, conversation.id)).setModel(step.model.provider, step.model.id);
      const checkpoints: { pre?: string; post?: string } = {};
      const observer = (event: TurnCheckpointEvent): void => {
        if (event.connectedFolderId !== connectedFolder.id || event.conversationId !== conversation.id) return;
        if (event.reason === "pre_turn") checkpoints.pre ??= event.checkpointId;
        else checkpoints.post = event.checkpointId;
      };
      state.turnCheckpointListeners.add(observer);
      try {
        const { taskId } = await acceptConversationTurn(state, connectedFolder, conversation.id, {
          content: message,
          contextPaths: [],
          actorKind: "system",
          automationSource: { automationId: context.automationId, title: context.title },
        });
        const settled = await waitForSettledRequest(state, connectedFolder.id, conversation.id, taskId, context.signal);
        const result = await completedRequestEnvelope(state, taskId);
        return {
          conversationId: conversation.id,
          turnTaskId: taskId,
          outcome: settled.status,
          result,
          ...(result && turnReportedResult(state, taskId) ? { reported: result } : {}),
          ...(settled.error !== undefined ? { error: settled.error } : {}),
          ...(checkpoints.pre !== undefined ? { preCheckpointId: checkpoints.pre } : {}),
          ...(checkpoints.post !== undefined ? { postCheckpointId: checkpoints.post } : {}),
        };
      } finally {
        state.turnCheckpointListeners.delete(observer);
      }
    },
    // An agent hop always opens a *new* thread, never the person's live
    // management thread: standing behavior must not entangle a conversation
    // someone is in the middle of, and turn-conflict rejection stays exact.
    // The acceptance shape is byte-for-byte the one `agent send` uses.
    async ampleFileAgent(step, message, context) {
      if (state.ampleFileAgentInstructionsError) {
        throw new Error("The AmpleFile Agent is unavailable because AmpleFile could not prepare its instructions.");
      }
      const scope = ampleFileAgentScopeForRoutes(state);
      const conversation = await createConversation(scope.rootPath);
      if (step.model) await (await getClient(state, scope.id, scope.rootPath, conversation.id)).setModel(step.model.provider, step.model.id);
      const { taskId } = await acceptConversationTurn(state, { id: scope.id, connectedFolderRoot: scope.rootPath }, conversation.id, {
        content: message,
        contextPaths: [],
        actorKind: "system",
        ampleFileAgentAttachments: [],
        automationSource: { automationId: context.automationId, title: context.title },
      });
      const settled = await waitForSettledRequest(state, scope.id, conversation.id, taskId, context.signal);
      return {
        conversationId: conversation.id,
        turnTaskId: taskId,
        outcome: settled.status,
        result: await completedRequestEnvelope(state, taskId),
        ...(settled.error !== undefined ? { error: settled.error } : {}),
      };
    },
    async modelProblem(model, scope) {
      const root = "connectedFolder" in scope ? (await getConnectedFolder(scope.connectedFolder)).connectedFolderRoot : ampleFileAgentScopeForRoutes(state).rootPath;
      const known = (await listPiModels(root, state.runtimeProvider)).find((item) => item.provider === model.provider && item.id === model.id);
      if (!known) return `AmpleFile does not know the model ${model.id} from ${model.provider}. Choose one Settings → AI Models lists.`;
      if (!known.configured) return `${known.name} needs ${known.providerName} connected in Settings → AI Models first.`;
      return null;
    },
    async files(step, source, context) {
      // Both folders' History is claimed at once before either is reserved,
      // so a hop waiting for History holds no turns off in either folder.
      const claimed = await Promise.all([getConnectedFolder(step.fromConnectedFolder), getConnectedFolder(step.toConnectedFolder)]);
      return withConnectedFolderHistoryOperations(claimed.map((connectedFolder) => connectedFolder.connectedFolderRoot), async () => {
        const reserved: string[] = [];
        try {
          for (const id of [...new Set([step.fromConnectedFolder, step.toConnectedFolder])].sort()) {
            reserveCapabilityMutation(state, id, "project", id);
            reserved.push(id);
          }
          // A files hop is deliberately not interruptible mid-copy: it completes
          // with its restore point or fails as one unit, so the signal is only a
          // pre-flight refusal here.
          if (context.signal.aborted) throw new Error("The run was aborted before this hop copied anything.");
          const from = await getConnectedFolder(step.fromConnectedFolder);
          const to = await getConnectedFolder(step.toConnectedFolder);
          if (from.connectedFolderRoot !== claimed[0]!.connectedFolderRoot || to.connectedFolderRoot !== claimed[1]!.connectedFolderRoot) {
            throw httpError(409, "A Connected Folder in this hop moved while it waited. Try again in a moment.");
          }
          const absoluteSources = await resolveAutomationFilesSources(from.connectedFolderRoot, source);
          const copied: string[] = [];
          try {
            await withConnectedFolderTouchBatch(async () => {
              for (const sourcePath of absoluteSources) {
                copied.push(await copyPathIntoConnectedFolder(sourcePath, to.connectedFolderRoot, step.to));
              }
            });
          } catch (error) {
            // A mid-batch failure must not strand earlier copies without a
            // restore point: undo them best-effort, then surface the failure.
            await Promise.all(copied.map((path) =>
              rm(resolveConnectedFolderPath(to.connectedFolderRoot, path), { recursive: true, force: true }).catch(() => undefined)));
            throw error;
          }
          const safety = await checkpointAdditiveWritesOrUndo(to.connectedFolderRoot, copied, {
            reason: "pre_add",
            label: `Before automation hop ${step.id} added ${copied.length} item${copied.length === 1 ? "" : "s"}`,
          });
          const measured = await measureConnectedFolderEntries(to.connectedFolderRoot, copied);
          return {
            ...(safety ? { restorePointId: safety.checkpointId } : {}),
            copiedPaths: copied,
            fileCount: measured.fileCount,
            totalBytes: measured.totalBytes,
          };
        } finally { for (const id of reserved) state.capabilityMutations.delete(id); }
      });
    },
    async checkpointManifest(connectedFolderId, checkpointId) {
      const connectedFolder = await getConnectedFolder(connectedFolderId).catch(() => null);
      if (!connectedFolder) return null;
      const checkpoint = await getConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, checkpointId);
      if (!checkpoint) return null;
      return {
        files: checkpoint.files.map((file) => ({
          path: file.path,
          hashSha256: file.hashSha256,
          sizeBytes: file.sizeBytes,
        })),
        skippedFilePaths: checkpoint.skippedFiles.map((file) => file.path),
      };
    },
  };
}

/**
 * Resolves an automation files hop's source selection inside the source Connected Folder:
 * exact paths under the ordinary Connected Folder path policy (no symbolic links, no
 * reserved segments), or the bounded tree selector through the folder target
 * resolver's discipline and the automation handoff bounds.
 */
async function resolveAutomationFilesSources(
  fromConnectedFolderRoot: string,
  source: Parameters<AmpleFileAutomationHopPorts["files"]>[1],
): Promise<string[]> {
  if (source.kind === "paths") {
    if (source.paths.length === 0) throw new Error("The files hop resolved no source paths.");
    if (source.paths.length > ampleFileAutomationBounds.maxHandoffFiles) {
      throw new Error(`The files hop names ${source.paths.length} paths, more than the ${ampleFileAutomationBounds.maxHandoffFiles}-file bound.`);
    }
    const absolute: string[] = [];
    for (const raw of source.paths) {
      const path = resolveConnectedFolderPath(fromConnectedFolderRoot, raw);
      const info = await lstat(path).catch(() => null);
      if (!info) throw new Error(`Source not found in the source Connected Folder: ${raw}.`);
      if (info.isSymbolicLink()) throw new Error(`Symbolic-link sources cannot be copied: ${raw}.`);
      if (!info.isFile() && !info.isDirectory()) throw new Error(`Only files and folders can be copied: ${raw}.`);
      absolute.push(path);
    }
    return absolute;
  }
  const resolution = await resolveFolderTargets(fromConnectedFolderRoot, [{
    kind: "tree",
    role: "primary",
    path: source.path,
    recursive: source.recursive,
    extensions: [...source.extensions],
  }], {
    limits: {
      maxFiles: ampleFileAutomationBounds.maxHandoffFiles,
      maxTotalBytes: ampleFileAutomationBounds.maxHandoffTotalBytes,
    },
  });
  return resolution.files.map((file) => file.absolutePath);
}

const maxAutomationMeasureEntries = 10_000;

/** Bounded evidence measurement of copied destinations: files and bytes. */
async function measureConnectedFolderEntries(
  connectedFolderRoot: string,
  relativePaths: string[],
): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  let visited = 0;
  const visit = async (path: string): Promise<void> => {
    if (visited >= maxAutomationMeasureEntries) return;
    visited += 1;
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) {
      fileCount += 1;
      totalBytes += info.size;
      return;
    }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(path).catch(() => [] as string[])) {
      await visit(join(path, entry));
    }
  };
  for (const relativePath of relativePaths) {
    await visit(resolveConnectedFolderPath(connectedFolderRoot, relativePath));
  }
  return { fileCount, totalBytes };
}

const maxOverviewConversationsPerConnectedFolder = 2_048;
const maxOverviewCheckpointsPerConnectedFolder = 256;
const maxOverviewActReceiptLines = 8_192;

/**
 * The overview's live-registry source readers (docs/amplefile-agent-overview.md): recorded
 * state only — the settled-turn records, the durable request graph
 * (docs/collaboration-contract.md), the
 * chat store and History per registered Connected Folder, the act-receipts ledger, and the automation receipts
 * journal. The kernel's own task registry supplies running tasks.
 */
function createServerOverviewSources(state: LocalApiState): AmpleFileOverviewSourceReaders {
  const automationRunReader = createAmpleFileOverviewAutomationRunReader();
  return {
    settledTurns: async (): Promise<AmpleFileOverviewSettledTurnRecord[]> =>
      [...state.settledTurns.values()].map((turn) => ({
        taskId: turn.taskId,
        // The AmpleFile Agent scope is not a Connected Folder; its settled turns carry no
        // Connected Folder id instead of rendering as a removed Connected Folder.
        ...(turn.connectedFolderId === ampleFileAgentScopeId ? {} : { connectedFolderId: turn.connectedFolderId }),
        conversationId: turn.conversationId,
        outcome: turn.status,
        endedAt: turn.endedAt,
      })),
    ampleFileAgentRequests: () => overviewAmpleFileAgentRequestRecords(state),
    chats: async (connectedFolder) => {
      const summaries = await listConversations(connectedFolder.connectedFolderRoot);
      const records = [];
      for (const summary of summaries.slice(0, maxOverviewConversationsPerConnectedFolder)) {
        records.push(ampleFileOverviewChatRecordFromMessages(summary, await readConversation(connectedFolder.connectedFolderRoot, summary.id)));
      }
      return records;
    },
    checkpoints: async (connectedFolder) =>
      (await listConnectedFolderCheckpoints(connectedFolder.connectedFolderRoot, maxOverviewCheckpointsPerConnectedFolder)).map((checkpoint) => ({
        checkpointId: checkpoint.checkpointId,
        createdAt: checkpoint.createdAt,
        ...(checkpoint.label !== undefined ? { label: checkpoint.label } : {}),
        reason: checkpoint.reason,
        scope: checkpoint.scope,
      })),
    actReceipts: () => readActReceiptJournal(state),
    automationRuns: automationRunReader,
  };
}

/**
 * Request records for the overview, composed from the durable record alone.
 *
 * The overview recomposes on every call, from the popover and the main window,
 * so this path stays cheap: a record already carries its
 * state, its timestamps, its questions, and its results. Needs you is derived
 * from those records; rendering the overview never scans a transcript for a
 * question mark.
 */
async function overviewAmpleFileAgentRequestRecords(state: LocalApiState): Promise<AmpleFileOverviewAgentRequestRecord[]> {
  const records: AmpleFileOverviewAgentRequestRecord[] = [];
  for (const record of state.requests.list({ limit: maxOverviewRequestRecords })) {
    const newestTurn = record.turns.at(-1)!;
    const phase = ampleFileRequestStateToAgentPhase(record.state);
    const descendants = state.requests.subtree(record.requestId);
    const questions = state.requests.questions(record.requestId);
    records.push({
      requestId: record.requestId,
      kind: record.kind,
      state: record.state,
      taskId: newestTurn.taskId,
      conversationId: record.owner.conversationId,
      ...(record.owner.connectedFolderId ? { connectedFolderId: record.owner.connectedFolderId } : {}),
      phase,
      startedAt: record.createdAt,
      endedAt: phase === "working" || phase === "handed_off" ? null : (record.settledAt ?? newestTurn.settledAt),
      childTaskIds: descendants.flatMap((descendant) => descendant.turns.map((turn) => turn.taskId)),
      openQuestions: questions
        .filter((question) => question.state === "open")
        .map((question) => ({ questionId: question.questionId, respondent: question.respondent, askedAt: question.askedAt })),
      questionCount: questions.length,
      resultCount: record.results.length,
    });
  }
  return records;
}

const maxOverviewRequestRecords = 16_384;

/**
 * Tolerant bounded read of the act-receipts ledger for the overview: the same
 * live and rotated files the executor appends. A damaged line is omitted —
 * the overview is a projection, never the journal's authority.
 */
async function readActReceiptJournal(state: LocalApiState): Promise<AmpleFileCliActReceipt[]> {
  const receipts: AmpleFileCliActReceipt[] = [];
  for (const path of [state.actReceipts.rotatedPath, state.actReceipts.path]) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    const lines = text.split("\n").filter((line) => line.trim());
    for (const line of lines.slice(-maxOverviewActReceiptLines)) {
      try {
        const record = JSON.parse(line) as Partial<AmpleFileCliActReceipt>;
        // Version 3 is the version every act writes.
        if (record.v !== 3
          || typeof record.at !== "string"
          || typeof record.requestId !== "string"
          || typeof record.command !== "string"
          || typeof record.outcome !== "string") continue;
        receipts.push(record as AmpleFileCliActReceipt);
      } catch {
        // Omitted, never fatal.
      }
    }
  }
  return receipts.slice(-maxOverviewActReceiptLines);
}
