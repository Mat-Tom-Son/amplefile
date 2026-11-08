import { boundedLiveTurnPresentation } from "./agent/turn-live-presentation.js";
import { createLocalEventSink, createLocalEventChannel, localEventTarget, parseLocalEventSubscriptions, type LocalEventSink } from "./local-event-stream.js";
import { localEventStreamLimits, type LocalEventEnvelope } from "../shared/local-event-stream.js";
import { createIncludedMcpSetup } from "./agent/included-mcp-setup.js";
import { prepareResourceEnable, resourceEnableAdapter } from "./agent/resource-enable-act.js";
import { listIncludedToolStatus, setupIncludedTool, shutdownIncludedToolHost, type IncludedSetupAction } from "./agent/included-tool-setup.js";
import { includedToolDefinitions, type IncludedToolId } from "../shared/included-tools.js";
import type { BrowserToolHost } from "../shared/browser.js";
import { ModelContextInspector } from "./agent/model-context-inspector.js";
import { type NativeResourceKind } from "./agent/resource-lifecycle.js";
import { observeAmpleFileAutomationFiles, ampleFileAutomationFileObserverBounds } from "./automations/automation-file-observer.js";
import { isConnectedFolderFileVisible } from "./connected-folder-file-visibility.js";
import { turnFileChanges } from "./agent/turn-file-changes.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { workRequestLabel, type WorkRequestView } from "../shared/request-presentation.js";
import { childFolderPaths } from "../shared/folder-nesting.js";
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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { automationTemplateAutomationId, isAutomationTemplateId } from "../shared/automation-templates.js";
import { automationTemplateDeclaration } from "./automations/automation-templates.js";
import {
  accessError as standardFolderAccessError,
  assertStandardFolderPathUnowned,
  createStandardFolderFolder,
  isShownStandardEntry,
  isStandardFolderId,
  listStandardFolders,
  removeSidebarFolder,
  renameStandardFolderEntry,
  resolveStandardFolderPath,
  scanStandardFolder,
  standardFolderEntryInfo,
  standardFolderRegistrationTarget,
  standardFolderRoot,
  type StandardFolderId,
} from "./standard-folders.js";
import { goToFolder } from "./go-to-folder.js";
import { compressInto, copyInto, isInside, moveInto, relativeTo } from "./file-transfer.js";
import { homedir as userHomedir } from "node:os";
import { lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

import {
  PiConversationClient,
  copyPiConversationSession,
  isPiTurnNotRunningError,
  isPiTurnTimeoutError,
  PiTurnFailure,
  PiTurnDrainingError,
  isPiTurnCancelledError,
  type PiChatEvent,
  type PiRuntimeProvider,
} from "./agent/pi-client.js";
import { parseAssistantPresentation } from "./agent/turn-presentation.js";
import {
  maxDurableTurnTextChars,
  AmpleFileTurnReplayConflictError,
  AmpleFileTurnStore,
  type AmpleFileDurableTurnRecord,
} from "./agent/turn-store.js";
import { TurnCheckpointWriter } from "./agent/turn-checkpoint-writer.js";
import {
  RoutedPiExtensionUiBridge,
  type PiExtensionUiEvent,
  type PiExtensionUiRequest,
  type PiExtensionUiSettled,
  type PiExtensionUiScope,
  type PiExtensionUiResponse,
  validateExtensionUiResponse,
} from "./agent/extension-ui.js";
import {
  appendMessage,
  conversationNeedsGeneratedTitle,
  conversationsDir,
  createConversation,
  listConversations,
  markConversationTitleAttempted,
  readConversation,
  readConversationSummary,
  renameConversation,
  setGeneratedConversationTitle,
  updateConversationLifecycle,
  type ChatMessage,
  type ChatMessageAttachmentRef,
  type ConversationSummary,
} from "./agent/chat-store.js";
import {
  RemoteCapabilityRegistry,
  type CapabilityRegistryService,
  type CapabilitySort,
  type CapabilityType,
} from "./agent/capability-registry.js";
import {
  importPiSkillBundle,
  importPiSkillBundleVerified,
  piSkillBundleContentDigest,
  PiSkillRestoreConflictError,
  removePiSkill,
  restorePiSkill,
  type PiSkillBundleImportResult,
} from "./agent/skill-import.js";
import { normalizeWorkerInstructions } from "./agent/model-preferences.js";
import {
  RegisteredConnectedFolderRuntimeProvider,
  RegisteredConnectedFolderTrustAuthority,
} from "./agent/registered-connected-folder-runtime.js";
import {
  getPiComposerState,
  getPiWorkerInstructions,
  getPiSetupStatus,
  installPiPackage,
  isPiProjectMutationTrusted,
  listPiModelCatalogs,
  listPiImageModels,
  listPiModels,
  listPiPackages,
  loginPiProvider,
  removePiProviderAuth,
  removePiPackage,
  refreshPiModelCatalog,
  savePiApiKey,
  resolvePiRuntime,
  ensurePiDefaultModel,
  setPiDefaultModel,
  setPiDefaultThinkingLevel,
  setPiWorkerInstructions,
  updatePiPackages,
  type PiOAuthHooks,
  type PiSetupStatus,
} from "./agent/pi-runtime-config.js";
import { readOpenAiAccount } from "./agent/openai-account.js";
import { ImageModelPreference, imageModelPreferencePath, normalizeImageModelChoice } from "./agent/image-model-preference.js";
import { GeneratedImageStore, isGeneratedImageId } from "./agent/generated-image-store.js";
import { getFoundrySettings, saveFoundryConnection } from "./agent/foundry-connection.js";
import { AZURE_OPENAI_PROVIDER, foundryProvider, normalizeFoundryConnection, type FoundryConnection } from "../shared/foundry.js";
import { loadConversationContextReferencesForTurn, previewConversationContextReference } from "./conversation-context.js";
import {
  classifyAmpleFileAgentAttachments,
  loadAmpleFileAgentAttachmentsForTurn,
  ampleFileAgentAttachmentDispositions,
  ampleFileAgentAttachmentLinks,
  maxAmpleFileAgentAttachments,
  type AmpleFileAgentAttachmentRef,
} from "./amplefile-agent-attachments.js";
import {
  AmpleFileRequestLimitError,
  AmpleFileRequestLineageError,
  isAmpleFileRequestTerminalState,
  ampleFileRequestLimitMessage,
  ampleFileRequestLimitsSection,
  ampleFileRequestStateToAgentPhase,
  type AmpleFileRequestActionCommand,
  type AmpleFileRequestJobState,
  type AmpleFileRequestCreatableKind,
  type AmpleFileRequestLimitName,
  type AmpleFileRequestRecord,
  type AmpleFileRequestSurface,
  type AmpleFileQuestionRecord,
  type AmpleFileResultEnvelope,
} from "./requests/request-records.js";
import { AmpleFileRequestStore } from "./requests/request-store.js";
import {
  describeJobHistory,
  describeJobState,
  isAmpleFileJobTerminalState,
  AmpleFileJobLimitError,
  AmpleFileJobNotFoundError,
  type AmpleFileJobHistory,
  type AmpleFileJobRecord,
} from "./jobs/job-records.js";
import { describeJobOutputRead, fenceJobOutput } from "./jobs/job-output.js";
import { reapOrphanedJobProcesses, AmpleFileJobService, type AmpleFileJobShell } from "./jobs/job-service.js";
import { AmpleFileJobStore } from "./jobs/job-store.js";
import { parseUntilPattern, type BackgroundJobToolHost } from "./agent/job-tools.js";
import { ampleFileRequestLimits, ampleFileAutomationDeclarationBounds } from "../shared/amplefile-limits.js";
import { connectedFolderOperationsGuideForScope } from "./agent/connected-folder-operations-guide.js";
import { buildConnectedFolderTurnContext, connectedFolderTurnHistory, connectedFolderTurnParentHandle, type PiConnectedFolderTurnContext } from "./agent/connected-folder-turn-context.js";
import {
  createConnectedFolderCheckpoint,
  createConnectedFolderMutationCheckpoint,
  discardConnectedFolderCheckpoint,
  getConnectedFolderCheckpoint,
  listConnectedFolderCheckpoints,
  listConnectedFolderCheckpointPage,
  listFileVersionPage,
  restoreFileVersion,
  restoreConnectedFolderCheckpoint,
  previewConnectedFolderCheckpointRestore,
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
import { normalizeConversationTitle, normalizeGeneratedConversationTitle } from "../shared/chat-title.js";
import {
  accentIdentityFromHex,
  defaultConnectedFolderAccent,
  hasConnectedFolderAppearanceCustomization,
  parseConnectedFolderAppearanceProposal,
  primaryAccentIdentity,
  startingConnectedFolderAccentHex,
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
import {
  resolveAmpleFileAutomationProposalPath,
  scanAmpleFileAutomationProposals,
} from "./automations/automation-proposal-scan.js";
import {
  AmpleFileAutomationService,
  AmpleFileAutomationServiceError,
  type AmpleFileAutomationHopPorts,
  type AmpleFileAutomationProjection,
  type AmpleFileAutomationServiceStatus,
} from "./automations/automation-service.js";
import {
  AmpleFileAutomationStore,
  AmpleFileAutomationStoreError,
  ampleFileAutomationReceiptsFile,
  ampleFileAutomationReceiptsRotatedFile,
  type AmpleFileAutomationReceiptV1,
  type AmpleFileAutomationRecord,
} from "./automations/automation-store.js";
import {
  configureAmpleFileStateRoot,
  connectedFolderStateDir,
  ampleFileAgentRoot,
  ampleFileAgentScopeId,
  ampleFileStateRoot,
  ampleFileRequestsRoot,
  ampleFileJobsRoot,
  ampleFileRecentlyDeletedRoot,
} from "./state-paths.js";
import {
  AmpleFileRecentlyDeletedError,
  AmpleFileRecentlyDeletedStore,
  ampleFileRecentlyDeletedEntryIdPattern,
  type AmpleFileRecentlyDeletedEntry,
  type AmpleFileRecentlyDeletedKind,
  type AmpleFileRecentlyDeletedReason,
  type AmpleFileRecentlyDeletedUncoveredPath,
} from "./recently-deleted-store.js";
import { AmpleFileKernel } from "./amplefile-kernel.js";
import { ManagedWorktrees } from "./managed-worktrees.js";
import {
  AMPLEFILE_CLI_ACT_SURFACES,
  AmpleFileCliActReceipts,
  type AmpleFileCliActReceipt,
  type AmpleFileCliActSurface,
} from "./cli/act-receipts.js";
import { AmpleFileCliError } from "./cli/protocol.js";
import type {
  AmpleFileActChatLifecycleState,
  AmpleFileActChatMessage,
  AmpleFileActChatState,
  AmpleFileActCheckpointSummary,
  AmpleFileActConversationRef,
  AmpleFileActFacade,
  AmpleFileActFileVersionRef,
  AmpleFileActAgentRequest,
  AmpleFileActQuestionRef,
  AmpleFileActRequestDetail,
  AmpleFileActJobRef,
  AmpleFileActRequestRef,
  AmpleFileActRequestResult,
  AmpleFileActRequestSummary,
  AmpleFileActWaitingRef,
  AmpleFileActAutomationReceipt,
  AmpleFileActAutomationSummary,
  AmpleFileActAutomationTriggerRef,
  AmpleFileActConnectedFolderRef,
  AmpleFileActRecentlyDeletedEntry,
  AmpleFileActTurnState,
  AmpleFileActTurnStatus,
} from "./cli/act-facade.js";
import { resolveAmpleFileCliConnectedFolderSelector } from "./amplefile-cli-adapter.js";
import {
  createLocalDevelopmentApiOptions,
  loadLocalEnvironmentFile,
} from "./server-dev-options.js";
import { isAlwaysHiddenConnectedFolderEntry, isConnectedFolderIgnored, readConnectedFolderIgnoreState, setConnectedFolderIgnoreState } from "./connected-folder-ignore.js";
import { canonicalConnectedFolderWatchRoot } from "./connected-folder-watch.js";
import {
  beginConnectedFolderRemoval,
  copyPathIntoConnectedFolder,
  createManagedConnectedFolder,
  checkConnectedFolderMoves,
  createConnectedFolderFolder,
  createConnectedFolderTextFile,
  deleteConnectedFolderEntry,
  ensureSafeConnectedFolderRoot,
  finalizeConnectedFolderRemoval,
  findExistingConnectedFolderFilePaths,
  getConnectedFolder,
  getConnectedFolderEntryInfo,
  getConnectedFolderFilePreview,
  listConnectedFolders,
  listPendingConnectedFolderRemovals,
  managedConnectedFolderDeletionPinIssue,
  moveConnectedFolderEntry,
  outermostConnectedFolderPaths,
  readConnectedFolderTextFile,
  renameConnectedFolderEntry,
  registerLinkedConnectedFolder,
  registerManagedConnectedFolder,
  renameConnectedFolder,
  resolveConnectedFolderDeleteTarget,
  resolveConnectedFolderPath,
  scanConnectedFolderTree,
  nestedRegisteredConnectedFolderPaths,
  registeredConnectedFolderOutline,
  resolveNestableFolderPath,
  connectedFolderRemovalPendingResult,
  touchConnectedFolderRoot,
  withConnectedFolderHistoryOperation,
  writeConnectedFolderTextFile,
  writeUploadedFiles,
  type ConnectedFolderMovedEntry,
  type ConnectedFolderRemovalIo,
  type ConnectedFolderRemovalResult,
  type TreeEntry,
  type ConnectedFolderSummary,
} from "./connected-folder.js";

export interface LocalFolderGrantProvider {
  consumeLocalFolderGrant(input: { connectedFolderRoot: string; grantId: string }): boolean | Promise<boolean>;
}

export interface LocalApiOptions {
  host?: "127.0.0.1";
  port?: number;
  appMode?: "dev" | "desktop";
  /** Root used only for managed Connected Folder content. */
  connectedFolderBase?: string;
  /** AmpleFile app data: registry, chats, Pi sessions, resources, history. */
  stateBase?: string;
  allowedOrigins?: string[];
  sessionToken?: string;
  piRuntimeProvider?: PiRuntimeProvider;
  extensionUiBridge?: RoutedPiExtensionUiBridge;
  piOAuthHooks?: PiOAuthHooks;
  capabilityRegistry?: CapabilityRegistryService;
  /** Machine-local Connected Folder appearance state, shared by the renderer and test harnesses. */
  appearanceStore?: ConnectedFolderAppearanceStore;
  /** A supplied kernel must use a provider wrapped by the same spaceTrustAuthority. */
  kernel?: AmpleFileKernel;
  /**
   * The act lane's durable receipts journal (the AmpleFile Agent's one ledger). Supply
   * the desktop CLI host's instance so decisions, Settings acts, and CLI acts
   * share one file and one at-most-once gate; when absent, the API constructs
   * one over the same state-root path the host uses.
   */
  actReceipts?: AmpleFileCliActReceipts;
  /** Test seam for the machine-local durable agent-turn journal. */
  turnStore?: AmpleFileTurnStore;
  /** Test seam for the durable request graph (docs/collaboration-contract.md). */
  requestStore?: AmpleFileRequestStore;
  /** Test seam for the background job journal (docs/background-jobs.md). */
  jobStore?: AmpleFileJobStore;
  /** Shared with the desktop kernel so registry trust changes apply everywhere. */
  connectedFolderTrustAuthority?: RegisteredConnectedFolderTrustAuthority;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  /** Failure-injection seam for the durable connected-folder-removal coordinator. */
  connectedFolderRemovalIo?: Partial<ConnectedFolderRemovalIo>;
  /** Test seam for the machine-local trash behind Recently deleted (docs/act-ledger.md). */
  recentlyDeletedStore?: AmpleFileRecentlyDeletedStore;
  /**
   * The desktop's built-in browser (docs/built-in-browser.md). With it, every
   * Worker and the AmpleFile Agent carry the browser_* tools; a development API
   * without Electron has none.
   */
  browser?: BrowserToolHost;
  /** Failure-injection seam that runs immediately before mandatory post-reservation Connected Folder validation. */
  beforeConnectedFolderMutationRevalidation?: (connectedFolderId: string) => Promise<void>;
  maxBodyBytes?: number;
  loadEnv?: boolean;
  onAgentTurnActivity?: (activeTurns: number) => void;
  /**
   * Failure-injection seam immediately before a Pi prompt starts. A Connected Folder
   * turn's event carries the host-composed turn context so a test can
   * observe it without a second option.
   */
  beforeAgentPrompt?: (event: {
    connectedFolderId: string;
    conversationId: string;
    taskId: string;
    connectedFolderTurn?: PiConnectedFolderTurnContext;
    automation?: { title: string };
  }) => Promise<void>;
  /**
   * Failure-injection seam between the parent check and child acceptance of
   * a delegated `chat send`. The child is not accepted yet when it runs, so
   * a parent stop inside it refuses the child at acceptance.
   */
  beforeAmpleFileAgentActionRecord?: (event: { parentTaskId: string; command: "chat.send"; taskId: string }) => Promise<void>;
  onHistoryCheckpoint?: (event: {
    connectedFolderId: string;
    conversationId: string;
    reason: "pre_turn" | "post_turn";
    checkpointId: string;
    skippedLargeFiles: string[];
  }) => void;
}

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

interface LocalApiState {
  appMode: "dev" | "desktop";
  connectedFolderBase?: string;
  allowedOrigins: string[];
  sessionToken?: string;
  maxBodyBytes: number;
  runtimeProvider: PiRuntimeProvider;
  extensionUi: RoutedPiExtensionUiBridge;
  modelContextInspector: ModelContextInspector;
  piOAuthHooks?: PiOAuthHooks;
  capabilityRegistry: CapabilityRegistryService;
  appearance: ConnectedFolderAppearanceStore;
  kernel: AmpleFileKernel;
  actReceipts: AmpleFileCliActReceipts;
  turnStore: AmpleFileTurnStore;
  overviewSeen: AmpleFileOverviewSeenStore;
  /**
   * Constructed in a second phase after the state object exists, because the
   * prepared-act fence, adapters, and automation hop ports close over this
   * state. Both are assigned before the server accepts a request.
   */
  preparedActs: PreparedActExecutor;
  automations: AmpleFileAutomationService;
  connectedFolderTrustAuthority: RegisteredConnectedFolderTrustAuthority;
  ampleFileAgentInstructionsError: string | null;
  localFolderGrantProvider?: LocalFolderGrantProvider;
  connectedFolderRemovalIo: Partial<ConnectedFolderRemovalIo>;
  /** Recently deleted (docs/act-ledger.md). */
  recentlyDeleted: AmpleFileRecentlyDeletedStore;
  beforeConnectedFolderMutationRevalidation?: (connectedFolderId: string) => Promise<void>;
  /** Every accepted turn's request record (docs/collaboration-contract.md). */
  requests: AmpleFileRequestStore;
  /**
   * Turns that settled in this app run, as opposed to ones startup recovery
   * settled from the journal. A root continuation narrates only settles
   * from this set, which is what makes "a restart never starts a
   * continuation" hold without a second durable marker. Bounded.
   */
  turnsSettledThisRun: Set<string>;
  /** Serializes request-graph settle evaluations so two settles never race one continuation. */
  requestSettleChain: Promise<void>;
  /**
   * Background jobs (docs/background-jobs.md). Constructed in the second
   * phase with the prepared-act executor: its ports close over this state.
   */
  jobs: AmpleFileJobService;
  /** Jobs that settled in this app run; like turnsSettledThisRun, only these can wake a Chat. Bounded. */
  jobsSettledThisRun: Set<string>;
  /** Per-launch salt behind the opaque parent handle a delegated Connected Folder turn sees. */
  connectedFolderTurnHandleSalt: string;
  chatStreams: Map<string, Set<LocalEventSink>>;
  controlStreams: Set<LocalEventSink>;
  localEventStreams: Set<LocalEventSink>;
  /** In-process subscribers riding the same publish point as the SSE streams. */
  chatEventListeners: Map<string, Set<(event: unknown) => void>>;
  chatEventLogs: Map<string, ChatEventLog>;
  activeTurnIdsByKey: Map<string, string>;
  /** Mid-turn steering messages already appended, keyed by client key + request id, for idempotent retries. */
  steeredMessages: Map<string, ChatMessage>;
  /** A steer still being delivered, so a concurrent retry with its request id waits for it instead of steering twice. */
  steeringInFlight: Map<string, Promise<ChatMessage>>;
  turnCheckpointWriter: TurnCheckpointWriter;
  clients: Map<string, PiConversationClient>;
  runningTurns: Set<string>;
  activeTurnPromises: Set<Promise<void>>;
  /** Acceptances past the closing check whose turns are not yet in activeTurnPromises; close() waits for them. */
  turnAcceptances: Set<Promise<unknown>>;
  activeTurnTasks: Map<string, { connectedFolderId: string; conversationId: string }>;
  cancelledTurnTasks: Set<string>;
  settledTurns: Map<string, SettledTurnRecord>;
  compactingConversations: Set<string>;
  /**
   * Idle Chats being summarized ahead of time. Deliberately not in
   * `compactingConversations`: a background summary never refuses the person.
   * Anything that needs the Chat's Pi session cancels it first.
   */
  backgroundCompactions: Map<string, BackgroundCompaction>;
  /**
   * One queued message per Chat, held by the app rather than a window, so
   * every window shows it and it outlives the window that queued it. It is
   * sent when the running turn ends, unless that turn was stopped. It lives
   * in the running app only: quitting drops it.
   */
  queuedMessages: Map<string, QueuedChatMessage>;
  /**
   * Each queue change gets a higher number, kept per Chat after the message
   * leaves, so a window can tell a stale echo from the newest change.
   */
  queueRevisions: Map<string, number>;
  lastQueueRevision: number;
  capabilityMutations: Set<string>;
  /** Turn clients whose Connected Folder changed under them; rebuilt when their turn settles. */
  clientsToRefresh: Set<string>;
  /** Settings → AI Models → Image model: one machine-wide choice, absent for Automatic. */
  imageModelPreference: ImageModelPreference;
  /** Pictures generate_image made, kept outside every Connected Folder for Chats to show. */
  generatedImages: GeneratedImageStore;
  /** The desktop's built-in browser, shared by every Worker and the AmpleFile Agent. */
  browser?: BrowserToolHost;
  connectedFolderIdsByRoot: Map<string, string>;
  extensionRequests: Map<string, PiExtensionUiRequest>;
  fileStreams: Map<() => void, string>;
  /** In-process observers of turn-boundary History checkpoints (automation chat hops). */
  turnCheckpointListeners: Set<(event: TurnCheckpointEvent) => void>;
  activeTurns: number;
  acceptingTurns: boolean;
  onAgentTurnActivity?: (activeTurns: number) => void;
  beforeAgentPrompt?: LocalApiOptions["beforeAgentPrompt"];
  beforeAmpleFileAgentActionRecord?: LocalApiOptions["beforeAmpleFileAgentActionRecord"];
  onHistoryCheckpoint?: LocalApiOptions["onHistoryCheckpoint"];
}

/**
 * Terminal outcome of one accepted turn, kept (bounded, in memory)
 * so the CLI act lane's task-scoped wait/result can distinguish this turn's
 * outcome from whatever happens to be the newest transcript message. Records
 * live for the app run; the portable transcript remains the durable record.
 */
interface SettledTurnRecord {
  taskId: string;
  connectedFolderId: string;
  conversationId: string;
  status: "succeeded" | "failed" | "aborted";
  endedAt: string;
  messageId?: string;
  error?: string;
}

interface ChatEventLogEntry {
  id: number;
  data: unknown;
  bytes: number;
}

interface ChatEventLog {
  nextId: number;
  turnId?: string;
  events: ChatEventLogEntry[];
  bytes: number;
  assistantText: string;
}

interface TurnCheckpointEvent {
  connectedFolderId: string;
  conversationId: string;
  reason: "pre_turn" | "post_turn";
  checkpointId: string;
}

interface MultipartFile {
  fieldName: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

interface MultipartBody {
  fields: Map<string, string>;
  files: MultipartFile[];
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
    sessionToken: options.sessionToken,
    maxBodyBytes: options.maxBodyBytes ?? numberFromEnv("AMPLEFILE_LOCAL_MAX_BODY_BYTES", 100 * 1024 * 1024),
    runtimeProvider,
    extensionUi,
    modelContextInspector,
    piOAuthHooks: options.piOAuthHooks,
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

  // Trusted local diagnostics only. These routes read retained snapshots and
  // never create clients/sessions or enter the CLI facade.
  const contextInspectionMatch = match(url.pathname, /^\/api\/model-context(?:\/([^/]+))?$/);
  if (contextInspectionMatch && (method === "GET" || method === "POST")) {
    const connectedFolderId = url.searchParams.get("connectedFolderId");
    const conversationId = url.searchParams.get("conversationId");
    if (conversationId && !connectedFolderId) throw badRequest("Choose the Chat's Connected Folder when inspecting its context.");
    const filter = connectedFolderId ? {
      connectedFolderRoot: connectedFolderId === ampleFileAgentScopeId ? ampleFileAgentRoot() : (await getConnectedFolder(connectedFolderId)).connectedFolderRoot,
      ...(conversationId ? { conversationId } : {}),
    } : undefined;
    const id = contextInspectionMatch[1];
    if (method === "GET") {
      if (id) {
        const record = state.modelContextInspector.get(id, filter);
        if (!record) throw notFound("This context capture is unavailable. It may have expired, been cleared, or belong to another Chat.");
        sendJson(res, { record });
      } else {
        sendJson(res, state.modelContextInspector.inspect(filter));
      }
      return;
    }
    if (id) throw badRequest("Context captures are read-only.");
    const body = await readJsonBody<{ enabled?: unknown; clear?: unknown }>(state, req);
    if (Object.keys(body).length !== 1) throw badRequest("Choose recording or clear captures.");
    if (typeof body.enabled === "boolean") state.modelContextInspector.setEnabled(body.enabled);
    else if (body.clear === true) state.modelContextInspector.clear();
    else throw badRequest("Specify enabled as a boolean or clear as true.");
    sendJson(res, state.modelContextInspector.inspect(filter));
    return;
  }

  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(res, { ok: true, app: "amplefile", mode: state.appMode });
    return;
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const connectedFolders = (await state.kernel.getConnectedFolders({ kind: "renderer" })).connectedFolders;
    const agent = connectedFolders[0] ? await safeAgentStatus(connectedFolders[0].connectedFolderRoot, state.runtimeProvider) : emptyAgentStatus();
    sendJson(res, { connectedFolders, agent, appearance: state.appearance.snapshot() });
    return;
  }

  // Which Connected Folder Workers are mid-turn right now, including turns no Chat tab
  // is showing (a handoff into a nested Connected Folder). Content-free: ids only. The
  // renderer requeries on the "activity" control hint.
  // The registered Connected Folders' ids, names, and roots for the @ menus: read from
  // the registry alone, with no manifest writes or setup checks, so a
  // popover can ask on every show.
  if (method === "GET" && url.pathname === "/api/connected-folders/outline") {
    const connectedFolders = (await registeredConnectedFolderOutline()).filter((connectedFolder) => existsSync(connectedFolder.connectedFolderRoot));
    sendJson(res, { connectedFolders });
    return;
  }

  if (method === "GET" && url.pathname === "/api/connected-folders/activity") {
    const running = [...state.activeTurnTasks.values()]
      .filter((task) => task.connectedFolderId !== ampleFileAgentScopeId)
      .map((task) => ({ connectedFolderId: task.connectedFolderId, conversationId: task.conversationId }));
    sendJson(res, { running });
    return;
  }

  if (method === "GET" && url.pathname === "/api/appearance") {
    sendJson(res, { appearance: state.appearance.snapshot() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/connected-folders") {
    const body = await readJsonBody<{ name?: string }>(state, req);
    const connectedFolder = await createConnectedFolderInternal(state, body.name ?? "Personal Connected Folder");
    sendJson(res, { connectedFolder }, 201);
    return;
  }

  if (method === "POST" && url.pathname === "/api/connected-folders/local-folder") {
  const body = await readJsonBody<{ connectedFolderRoot?: string; folderGrantId?: string; providerHint?: "google-drive" }>(state, req);
    if (!body.connectedFolderRoot?.trim()) throw badRequest("Choose a local folder to turn into a Connected Folder.");
    if (state.localFolderGrantProvider) {
      if (!body.folderGrantId || !await state.localFolderGrantProvider.consumeLocalFolderGrant({ connectedFolderRoot: body.connectedFolderRoot, grantId: body.folderGrantId })) {
        throw forbidden("The folder selection expired. Choose the folder again to add it.");
      }
    } else if (state.appMode === "desktop") {
      throw forbidden("A folder must be selected in the desktop app before it can become a Connected Folder.");
    }
    const connectedFolder = await registerConnectedFolderInternal(state, body.connectedFolderRoot!, body.providerHint);
    sendJson(res, { connectedFolder }, 201);
    return;
  }

  // "Connect This Folder": a person registers a folder inside
  // a Connected Folder they already registered, from Files. The parent's registration
  // is the trust root for the path, so no fresh folder picker grant is asked
  // for; the explicit click is this Connected Folder's registration act, exactly as
  // choosing a folder in the picker is.
  const nestedFolderMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/nested-folders$/);
  if (method === "POST" && nestedFolderMatch) {
    const parent = await getConnectedFolder(nestedFolderMatch[1]);
    const body = await readJsonBody<{ path?: unknown }>(state, req);
    if (typeof body.path !== "string" || !body.path.trim()) throw badRequest("Choose a folder inside this Connected Folder.");
    const target = await resolveNestableFolderPath(parent.connectedFolderRoot, body.path);
    const connectedFolder = await registerConnectedFolderInternal(state, target);
    sendJson(res, { connectedFolder }, 201);
    return;
  }

  const connectedFolderMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)$/);
  if (connectedFolderMatch && (method === "PUT" || method === "PATCH")) {
    const body = await readJsonBody<{ name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A Connected Folder name is required.");
    sendJson(res, { connectedFolder: await renameConnectedFolder(connectedFolderMatch[1], body.name) });
    publishControlHint(state, "connected-folders");
    return;
  }
  if (connectedFolderMatch && method === "DELETE") {
    const connectedFolder = await getConnectedFolder(connectedFolderMatch[1]);
    // Every deletion the desktop performs leaves a receipt
    // (docs/act-ledger.md): the same journal the act lane writes,
    // stamped with the main-window surface. Removing a linked registration
    // destroys nothing, so it is journaled as the unregister it is.
    const command = connectedFolder.location.storage === "managed" ? "connected-folders.delete" : "connected-folders.unregister";
    const removal = await runDesktopSettingsAct(state, command, async (requestId) => {
      const value = await removeConnectedFolderRegistrationInternal(state, connectedFolder, { receiptId: requestId });
      return {
        value,
        detail: `Connected Folder ${connectedFolder.id}${value.recentlyDeleted ? `; trash ${value.recentlyDeleted.entryId}` : ""}`,
      };
    });
    sendJson(res, removal.value);
    return;
  }

  // The Connected Folder–owned Automations view (docs/automations.md): a read
  // of the automations that name this Connected Folder, and the same
  // Settings enable/disable/run acts — same facade, same receipts — refused
  // for an automation that does not name it.
  const spaceAutomationsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/automations$/);
  if (spaceAutomationsMatch && method === "GET") {
    const connectedFolder = await getConnectedFolder(spaceAutomationsMatch[1]);
    sendJson(res, await createAmpleFileAutomationSettingsFacade(state).forConnectedFolder(connectedFolder.id));
    return;
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
    return;
  }

  const connectedFolderAppearanceMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/appearance$/);
  if (connectedFolderAppearanceMatch && method === "PUT") {
    const connectedFolder = await getConnectedFolder(connectedFolderAppearanceMatch[1]);
    const body = await readJsonBody<{ customization?: unknown }>(state, req);
    if (!body.customization || typeof body.customization !== "object" || Array.isArray(body.customization)) {
      throw badRequest("A Connected Folder appearance object is required.");
    }
    const appearance = await state.appearance.replaceConnectedFolder(
      connectedFolder.id,
      body.customization,
    );
    sendJson(res, { appearance });
    return;
  }
  if (connectedFolderAppearanceMatch && method === "DELETE") {
    const connectedFolder = await getConnectedFolder(connectedFolderAppearanceMatch[1]);
    sendJson(res, { appearance: await state.appearance.removeConnectedFolder(connectedFolder.id) });
    return;
  }

  const searchMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/search$/);
  if (method === "GET" && searchMatch) {
    const connectedFolder = await getConnectedFolder(searchMatch[1]);
    const scope = url.searchParams.get("scope") ?? "all";
    if (scope !== "all" && scope !== "files" && scope !== "chats") throw badRequest("Search scope is unsupported.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const result = await searchConnectedFolder(connectedFolder.connectedFolderRoot, url.searchParams.get("q") ?? "", {
        includeFiles: scope !== "chats",
        includeChats: scope !== "files",
        signal: controller.signal,
        path: url.searchParams.get("path") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        maxMatches: optionalBoundedInteger(url.searchParams.get("limit"), "limit"),
      });
      if (!controller.signal.aborted && !res.destroyed) sendJson(res, result);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
    return;
  }

  // Standard Folders (docs/product-model.md, "The file manager window"):
  // Desktop, Documents, and Downloads for the file manager's sidebar. The host
  // resolves each from the home folder; nothing here writes `.amplefile/` data.
  if (method === "GET" && url.pathname === "/api/standard-folders") {
    sendJson(res, { folders: await listStandardFolders(await listConnectedFolders()) });
    return;
  }
  // Copy, paste, duplicate, and move across the file manager's places.
  if (method === "POST" && url.pathname === "/api/file-transfer") {
    const body = await readJsonBody<{ mode?: unknown; sources?: unknown; target?: unknown }>(state, req);
    sendJson(res, await transferFileEntries(body));
    return;
  }
  // Compress: one item becomes "name.zip" beside it, several become "Archive.zip".
  if (method === "POST" && url.pathname === "/api/file-transfer/compress") {
    const body = await readJsonBody<{ place?: unknown; paths?: unknown }>(state, req);
    sendJson(res, await compressEntries(body), 201);
    return;
  }
  // Recents: what changed lately across the Connected Folders and the top of Desktop, Documents, and Downloads.
  if (method === "GET" && url.pathname === "/api/recents") {
    sendJson(res, { recents: await recentFiles(await listConnectedFolders()) });
    return;
  }
  // Go to Folder (⇧⌘G): a typed path opens the Connected Folder or Standard Folder holding it, with completions.
  if (method === "GET" && url.pathname === "/api/go-to-folder") {
    sendJson(res, await goToFolder(url.searchParams.get("path") ?? "", await listConnectedFolders()));
    return;
  }
  // Remove from Sidebar: a folder the person added with + leaves the list; the folder stays as it is.
  const sidebarFolderMatch = match(url.pathname, /^\/api\/standard-folders\/(added-[0-9a-f]{16})$/);
  if (method === "DELETE" && sidebarFolderMatch) {
    removeSidebarFolder(sidebarFolderMatch[1]);
    sendJson(res, { removed: true });
    return;
  }
  const standardFolderMatch = match(url.pathname, /^\/api\/standard-folders\/([^/]+)\/(tree|file-info|raw-file|events|rename-local-entry|folders|connected-folders)$/);
  if (standardFolderMatch) {
    const standardFolderId = standardFolderMatch[1];
    if (!isStandardFolderId(standardFolderId)) throw notFound("That standard folder isn’t on this computer.");
    const route = standardFolderMatch[2];
    const path = url.searchParams.get("path") ?? "";
    if (method === "GET" && route === "tree") {
      sendJson(res, await scanStandardFolder(standardFolderId, path));
      return;
    }
    if (method === "GET" && route === "file-info") {
      if (!path) throw badRequest("A path inside the folder is required.");
      sendJson(res, await standardFolderEntryInfo(standardFolderId, path));
      return;
    }
    if (method === "GET" && route === "raw-file") {
      if (!path) throw badRequest("File path is required.");
      await sendConnectedFolderRawFile(res, standardFolderRoot(standardFolderId), path);
      return;
    }
    if (method === "GET" && route === "events") {
      await openStandardFolderFileStream(state, createLocalEventSink(res), standardFolderId, path);
      return;
    }
    if (method === "POST" && route === "rename-local-entry") {
      const body = await readJsonBody<{ path?: unknown; newName?: unknown }>(state, req);
      if (typeof body.path !== "string" || typeof body.newName !== "string") throw badRequest("An item and a new name are required.");
      sendJson(res, await renameStandardFolderEntry(standardFolderId, body.path, body.newName));
      return;
    }
    if (method === "POST" && route === "folders") {
      const body = await readJsonBody<{ parentPath?: unknown; name?: unknown }>(state, req);
      if (typeof body.name !== "string") throw badRequest("Enter a name.");
      if (body.parentPath !== undefined && typeof body.parentPath !== "string") throw badRequest("Choose where the folder goes.");
      sendJson(res, await createStandardFolderFolder(standardFolderId, body.parentPath ?? "", body.name), 201);
      return;
    }
    // "Connect This Folder": the click is the registration act, as choosing
    // a folder in the picker is; the host resolved the standard folder itself.
    if (method === "POST" && route === "connected-folders") {
      const body = await readJsonBody<{ path?: unknown }>(state, req);
      if (body.path !== undefined && typeof body.path !== "string") throw badRequest("Choose a folder.");
      const target = await standardFolderRegistrationTarget(standardFolderId, body.path ?? "");
      const connectedFolder = await registerConnectedFolderInternal(state, target);
      sendJson(res, { connectedFolder }, 201);
      return;
    }
  }

  // Suggested messages written from the folder: one bounded model call on the
  // Connected Folder's model over its names and recent Chat titles, kept until the folder or its Chats change.
  const suggestionsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/suggestions$/);
  if (method === "GET" && suggestionsMatch) {
    const connectedFolder = await getConnectedFolder(suggestionsMatch[1]);
    sendJson(res, { suggestions: await folderSuggestions(state, connectedFolder, url.searchParams.get("path") ?? "") });
    return;
  }

  const treeMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/tree$/);
  if (method === "GET" && treeMatch) {
    const connectedFolder = await getConnectedFolder(treeMatch[1]);
    const maxDepthValue = Number(url.searchParams.get("maxDepth") ?? 20);
    const maxDepth = Number.isFinite(maxDepthValue) ? Math.min(Math.max(Math.floor(maxDepthValue), 0), 50) : 20;
    const scan = await scanConnectedFolderTree(
      connectedFolder.connectedFolderRoot,
      maxDepth,
      url.searchParams.get("path") ?? "",
      { includeIgnored: url.searchParams.get("includeIgnored") !== "0", nestedFolderPaths: await nestedRegisteredConnectedFolderPaths(connectedFolder.connectedFolderRoot) },
    );
    sendJson(res, { tree: scan.entries, truncated: scan.truncated });
    return;
  }

  const fileMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/file$/);
  if (method === "GET" && fileMatch) {
    const connectedFolder = await getConnectedFolder(fileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    sendJson(res, await readConnectedFolderTextFile(connectedFolder.connectedFolderRoot, path));
    return;
  }
  if (method === "PUT" && fileMatch) {
    const connectedFolder = await getConnectedFolder(fileMatch[1]);
    const body = await readJsonBody<{ path?: string; text?: string }>(state, req);
    if (!body.path?.trim() || typeof body.text !== "string") throw badRequest("A file path and text are required.");
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      paths: [body.path],
      reason: "pre_edit",
      label: `Before editing ${body.path}`,
    });
    const file = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => writeConnectedFolderTextFile(connectedFolder.connectedFolderRoot, body.path!, body.text!));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const fileInfoMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/file-info$/);
  if (method === "GET" && fileInfoMatch) {
    const connectedFolder = await getConnectedFolder(fileInfoMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("Connected Folder item path is required.");
    sendJson(res, await getConnectedFolderEntryInfo(connectedFolder.connectedFolderRoot, path));
    return;
  }

  const filePreviewMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/file-preview$/);
  if (method === "GET" && filePreviewMatch) {
    const connectedFolder = await getConnectedFolder(filePreviewMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("Connected Folder item path is required.");
    sendJson(res, { preview: await getConnectedFolderFilePreview(connectedFolder.connectedFolderRoot, path) });
    return;
  }

  const pathsExistMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/paths-exist$/);
  if (method === "POST" && pathsExistMatch) {
    const connectedFolder = await getConnectedFolder(pathsExistMatch[1]);
    const body = await readJsonBody<{ paths?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string")) {
      throw badRequest("Connected Folder paths must be an array of strings.");
    }
    sendJson(res, { existing: await findExistingConnectedFolderFilePaths(connectedFolder.connectedFolderRoot, body.paths) });
    return;
  }

  // Pictures generate_image made: their bytes for a Chat to show,
  // what the Chat needs to offer Add to folder or Show in Files, and Add to folder.
  const generatedImageMatch = match(url.pathname, /^\/api\/generated-images\/([^/]+)$/);
  if (method === "GET" && generatedImageMatch) {
    const found = isGeneratedImageId(generatedImageMatch[1]) ? await state.generatedImages.read(generatedImageMatch[1]) : null;
    if (!found) throw notFound("This picture is not on this computer.");
    res.writeHead(200, {
      "content-type": found.record.mimeType,
      "content-length": found.bytes.length,
      "content-disposition": "inline",
      "cache-control": "private, max-age=31536000, immutable",
    });
    res.end(found.bytes);
    return;
  }
  const connectedFolderImageMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/generated-images\/([^/]+)(\/add)?$/);
  if (connectedFolderImageMatch && (method === "GET" || (method === "POST" && connectedFolderImageMatch[3]))) {
    const connectedFolder = await getConnectedFolder(connectedFolderImageMatch[1]);
    const imageId = connectedFolderImageMatch[2]!;
    const record = isGeneratedImageId(imageId) ? await state.generatedImages.get(imageId) : null;
    if (!record) throw notFound("This picture is not on this computer.");
    const addedPath = record.added?.[connectedFolder.id];
    const stillThere = addedPath ? await state.generatedImages.matches(record, resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, addedPath)).catch(() => false) : false;
    if (method === "GET") {
      sendJson(res, { name: record.name, mimeType: record.mimeType, ...(stillThere ? { addedPath } : {}) });
      return;
    }
    // Add to folder: the same additive write and restore point as an upload.
    if (stillThere) { sendJson(res, { path: addedPath, added: false }); return; }
    const found = await state.generatedImages.read(imageId);
    if (!found) throw notFound("This picture is not on this computer.");
    const [written] = await writeUploadedFiles(connectedFolder.connectedFolderRoot, "", [{ fileName: record.name, data: found.bytes }]);
    await checkpointAdditiveWritesOrUndo(connectedFolder.connectedFolderRoot, [written!.path], {
      reason: "pre_upload",
      label: `Before adding ${record.name}`,
    });
    await state.generatedImages.noteAdded(imageId, connectedFolder.id, written!.path);
    sendJson(res, { path: written!.path, added: true }, 201);
    return;
  }

  const rawFileMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/raw-file$/);
  if (method === "GET" && rawFileMatch) {
    const connectedFolder = await getConnectedFolder(rawFileMatch[1]);
    const path = url.searchParams.get("path") ?? "";
    if (!path) throw badRequest("File path is required.");
    await sendConnectedFolderRawFile(res, connectedFolder.connectedFolderRoot, path);
    return;
  }

  const moveMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/move-local-entry$/);
  if (method === "POST" && moveMatch) {
    const connectedFolder = await getConnectedFolder(moveMatch[1]);
    const body = await readJsonBody<{ sourcePath?: string; targetFolderPath?: string }>(state, req);
    if (!body.sourcePath?.trim()) throw badRequest("Select a file or folder to move.");
    const moveSource = normalizeConnectedFolderRelativePath(body.sourcePath);
    const moveTargetFolder = normalizeConnectedFolderRelativePath(body.targetFolderPath ?? "");
    const moveDestination = [moveTargetFolder, basename(moveSource)].filter(Boolean).join("/");
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      movesOnRestore: [{ fromPath: moveDestination, toPath: moveSource }],
      reason: "pre_move",
      label: `Before moving ${body.sourcePath}`,
    });
    const moved = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => moveConnectedFolderEntry(connectedFolder.connectedFolderRoot, {
      sourcePath: moveSource,
      targetFolderPath: body.targetFolderPath ?? "",
    }));
    sendJson(res, { moved, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  // Several Files rows into one folder under one restore point.
  const moveManyMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/move-local-entries$/);
  if (method === "POST" && moveManyMatch) {
    const connectedFolder = await getConnectedFolder(moveManyMatch[1]);
    const body = await readJsonBody<{ sourcePaths?: unknown; targetFolderPath?: unknown }>(state, req);
    const sourcePaths = connectedFolderPathList(body.sourcePaths, "Select files or folders to move.");
    if (body.targetFolderPath !== undefined && typeof body.targetFolderPath !== "string") throw badRequest("Choose a folder to move them into.");
    const result = await moveConnectedFolderEntriesWithHistory(connectedFolder, sourcePaths, body.targetFolderPath ?? "");
    sendJson(res, result);
    return;
  }

  const renameMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/rename-local-entry$/);
  if (method === "POST" && renameMatch) {
    const connectedFolder = await getConnectedFolder(renameMatch[1]);
    const body = await readJsonBody<{ path?: string; newName?: string }>(state, req);
    if (!body.path?.trim() || !body.newName?.trim()) throw badRequest("A Connected Folder item and new name are required.");
    const renameSource = normalizeConnectedFolderRelativePath(body.path);
    const renameParent = renameSource.includes("/") ? renameSource.slice(0, renameSource.lastIndexOf("/")) : "";
    const renameDestination = [renameParent, body.newName].filter(Boolean).join("/");
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      movesOnRestore: [{ fromPath: renameDestination, toPath: renameSource }],
      reason: "pre_rename",
      label: `Before renaming ${body.path}`,
    });
    const renamed = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => renameConnectedFolderEntry(connectedFolder.connectedFolderRoot, { path: body.path!, newName: body.newName! }));
    sendJson(res, { renamed, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles });
    return;
  }

  const foldersMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/folders$/);
  if (method === "POST" && foldersMatch) {
    const connectedFolder = await getConnectedFolder(foldersMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A folder name is required.");
    const folderTarget = [normalizeConnectedFolderRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      deleteOnRestore: [folderTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const folder = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => createConnectedFolderFolder(connectedFolder.connectedFolderRoot, body.parentPath ?? "", body.name!));
    sendJson(res, { folder, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return;
  }

  const filesMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/files$/);
  if (method === "POST" && filesMatch) {
    const connectedFolder = await getConnectedFolder(filesMatch[1]);
    const body = await readJsonBody<{ parentPath?: string; name?: string; text?: string }>(state, req);
    if (!body.name?.trim()) throw badRequest("A file name is required.");
    const fileTarget = [normalizeConnectedFolderRelativePath(body.parentPath ?? ""), body.name].filter(Boolean).join("/");
    const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
      deleteOnRestore: [fileTarget],
      reason: "pre_create",
      label: `Before creating ${body.name}`,
    });
    const file = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => createConnectedFolderTextFile(connectedFolder.connectedFolderRoot, body.parentPath ?? "", body.name!, body.text ?? ""));
    sendJson(res, { file, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles }, 201);
    return;
  }

  const deleteMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/local-file$/);
  if (method === "DELETE" && deleteMatch) {
    const connectedFolder = await getConnectedFolder(deleteMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("Select a file or folder to delete.");
    // Every deletion the desktop performs leaves a receipt, and a delete
    // History cannot fully keep a copy of lands in Recently deleted rather
    // than being refused (docs/act-ledger.md).
    const removal = await runDesktopSettingsAct(state, "files.delete", async (requestId) => {
      const value = await deleteConnectedFolderEntryWithRecovery(state, connectedFolder, body.path!, { receiptId: requestId });
      return {
        value,
        detail: value.recovery.kind === "recently-deleted"
          ? `Connected Folder ${connectedFolder.id}; trash ${value.recovery.entryId}`
          : `Connected Folder ${connectedFolder.id}; checkpoint ${value.safetyCheckpointId}`,
      };
    });
    const { recovery, ...deleted } = removal.value;
    sendJson(res, {
      ...deleted,
      historySkippedPaths: recovery.kind === "recently-deleted" ? recovery.uncovered.map((file) => file.path) : [],
      ...(recovery.kind === "recently-deleted"
        ? { recentlyDeleted: { entryId: recovery.entryId, restoreBy: recovery.restoreBy, uncoveredCount: recovery.uncovered.length } }
        : {}),
    });
    return;
  }

  // Several Files rows under one restore point: each row still
  // gets its own receipt and its own History or Recently deleted recovery.
  const deleteManyMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/local-files$/);
  if (method === "DELETE" && deleteManyMatch) {
    const connectedFolder = await getConnectedFolder(deleteManyMatch[1]);
    const body = await readJsonBody<{ paths?: unknown }>(state, req);
    const paths = connectedFolderPathList(body.paths, "Select files or folders to delete.");
    const result = await deleteConnectedFolderEntriesWithRecovery(state, connectedFolder, paths);
    sendJson(res, {
      deleted: result.deleted.map(({ recovery, ...row }) => ({
        ...row,
        ...(recovery.kind === "recently-deleted"
          ? { recentlyDeleted: { entryId: recovery.entryId, restoreBy: recovery.restoreBy, uncoveredCount: recovery.uncovered.length } }
          : {}),
      })),
      safetyCheckpointId: result.safetyCheckpointId,
      historySkippedPaths: result.deleted.flatMap((row) => row.recovery.kind === "recently-deleted" ? row.recovery.uncovered.map((file) => file.path) : []),
      ...(result.failed ? { failed: result.failed, notDeleted: result.notDeleted } : {}),
    });
    return;
  }

  const ignoreMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/ignore-paths$/);
  if (method === "GET" && ignoreMatch) {
    const connectedFolder = await getConnectedFolder(ignoreMatch[1]);
    sendJson(res, await readConnectedFolderIgnoreState(connectedFolder.connectedFolderRoot));
    return;
  }
  if (method === "POST" && ignoreMatch) {
    const connectedFolder = await getConnectedFolder(ignoreMatch[1]);
    const body = await readJsonBody<{ paths?: unknown; ignored?: unknown }>(state, req);
    if (!Array.isArray(body.paths) || body.paths.some((path) => typeof path !== "string") || typeof body.ignored !== "boolean") {
      throw badRequest("Connected Folder paths and an ignore decision are required.");
    }
    sendJson(res, await setConnectedFolderIgnoreState(connectedFolder.connectedFolderRoot, body.paths, body.ignored));
    return;
  }

  const fileEventsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/file-events$/);
  if (method === "GET" && fileEventsMatch) {
    const connectedFolder = await getConnectedFolder(fileEventsMatch[1]);
    await openConnectedFolderFileStream(state, createLocalEventSink(res), connectedFolder.connectedFolderRoot, fileEventsMatch[1]);
    return;
  }

  const uploadMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/upload-local-files$/);
  if (method === "POST" && uploadMatch) {
    const connectedFolder = await getConnectedFolder(uploadMatch[1]);
    const multipart = await readMultipartBody(state, req);
    const relativePaths = parseRelativePaths(multipart.fields.get("relativePaths"), multipart.files.length);
    const uploaded = await writeUploadedFiles(
      connectedFolder.connectedFolderRoot,
      multipart.fields.get("targetFolderPath") ?? "",
      multipart.files.map((file, index) => ({ fileName: file.fileName, relativePath: relativePaths[index], data: file.data })),
    );
    const safety = await checkpointAdditiveWritesOrUndo(connectedFolder.connectedFolderRoot, uploaded.map((file) => file.path), {
      reason: "pre_upload",
      label: `Before uploading ${uploaded.length} file${uploaded.length === 1 ? "" : "s"}`,
    });
    sendJson(res, { uploaded, safetyCheckpointId: safety?.checkpointId ?? null, historySkippedPaths: safety?.skippedLargeFiles ?? [] }, 201);
    return;
  }

  const checkpointCollectionMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/checkpoints$/);
  if (checkpointCollectionMatch && method === "GET") {
    const connectedFolder = await getConnectedFolder(checkpointCollectionMatch[1]);
    sendJson(res, await listConnectedFolderCheckpointPage(connectedFolder.connectedFolderRoot, { cursor: url.searchParams.get("cursor") ?? undefined, limit: optionalBoundedInteger(url.searchParams.get("limit"), "limit") }));
    return;
  }
  if (checkpointCollectionMatch && method === "POST") {
    const connectedFolder = await getConnectedFolder(checkpointCollectionMatch[1]);
    const body = await readJsonBody<{ label?: string }>(state, req);
    const existingIds = new Set((await listConnectedFolderCheckpoints(connectedFolder.connectedFolderRoot, 1000)).map((checkpoint) => checkpoint.checkpointId));
    const checkpoint = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, { label: body.label, reason: "manual" });
    const created = !existingIds.has(checkpoint.checkpointId);
    sendJson(res, { checkpoint, created }, created ? 201 : 200);
    return;
  }
  const checkpointRestoreMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/checkpoints\/([^/]+)\/restore$/);
  if (method === "POST" && checkpointRestoreMatch) {
    const connectedFolder = await getConnectedFolder(checkpointRestoreMatch[1]);
    sendJson(res, await runHistoryRestore(state, connectedFolder.id, () => restoreConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, checkpointRestoreMatch[2])));
    return;
  }

  const checkpointPreviewMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/checkpoints\/([^/]+)\/preview$/);
  if (method === "GET" && checkpointPreviewMatch) {
    const connectedFolder = await getConnectedFolder(checkpointPreviewMatch[1]);
    sendJson(res, { preview: await previewConnectedFolderCheckpointRestore(connectedFolder.connectedFolderRoot, checkpointPreviewMatch[2]) });
    return;
  }

  const historyReviewMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/(read|diff)$/);
  if (method === "GET" && historyReviewMatch) {
    const connectedFolder = await getConnectedFolder(historyReviewMatch[1]);
    const path = url.searchParams.get("path")?.trim();
    if (!path) throw badRequest("A Connected Folder–relative file path is required.");
    if (historyReviewMatch[2] === "read") {
      const checkpointId = url.searchParams.get("checkpointId")?.trim();
      if (!checkpointId) throw badRequest("A checkpointId is required.");
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once("aborted", abort); res.once("close", abort);
      try {
        const review = await readHistoryFile(connectedFolder.connectedFolderRoot, {
          path, checkpointId, signal: controller.signal,
          offsetBytes: optionalBoundedInteger(url.searchParams.get("offsetBytes"), "offsetBytes"),
          lengthBytes: optionalBoundedInteger(url.searchParams.get("lengthBytes"), "lengthBytes"),
          expectedSha256: url.searchParams.get("expectedSha256") ?? undefined,
        });
        if (!controller.signal.aborted && !res.destroyed) sendJson(res, { review });
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { req.off("aborted", abort); res.off("close", abort); }
    } else {
      const fromCheckpointId = url.searchParams.get("fromCheckpointId")?.trim();
      if (!fromCheckpointId) throw badRequest("A fromCheckpointId is required.");
      const toCheckpointId = url.searchParams.get("toCheckpointId")?.trim();
      sendJson(res, { comparison: await compareHistoryFile(connectedFolder.connectedFolderRoot, {
        path, fromCheckpointId, ...(toCheckpointId ? { toCheckpointId } : {}),
      }) });
    }
    return;
  }

  const fileVersionsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/history\/file-versions$/);
  if (method === "GET" && fileVersionsMatch) {
    const connectedFolder = await getConnectedFolder(fileVersionsMatch[1]);
    const path = url.searchParams.get("path")?.trim();
    if (!path) throw badRequest("A Connected Folder–relative file path is required.");
    sendJson(res, { path, ...await listFileVersionPage(connectedFolder.connectedFolderRoot, path, { cursor: url.searchParams.get("cursor") ?? undefined, limit: optionalBoundedInteger(url.searchParams.get("limit"), "limit") }) });
    return;
  }
  if (method === "POST" && fileVersionsMatch) {
    const connectedFolder = await getConnectedFolder(fileVersionsMatch[1]);
    const body = await readJsonBody<{ path?: string; hashSha256?: string }>(state, req);
    if (!body.path?.trim() || !body.hashSha256?.trim()) throw badRequest("A file path and version hash are required.");
    sendJson(res, { result: await runHistoryRestore(state, connectedFolder.id, () => restoreFileVersion(connectedFolder.connectedFolderRoot, body.path!, body.hashSha256!)) });
    return;
  }

  // Settings → AI Models → Image model: one choice for every Worker
  // and the AmpleFile Agent; null is Automatic. Credentials are machine-wide, so
  // the AmpleFile Agent's runtime lists what every scope can use.
  if (method === "GET" && url.pathname === "/api/agent/image-models") {
    sendJson(res, await imageModelSettings(state));
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/image-model") {
    const body = await readJsonBody<{ model?: unknown }>(state, req);
    if (body.model === null) {
      await state.imageModelPreference.set(null);
    } else {
      const model = normalizeImageModelChoice(body.model);
      if (!model) throw badRequest("Choose an image model, or null for Automatic.");
      const { models } = await listPiImageModels(ampleFileAgentRoot(), state.runtimeProvider);
      if (!models.some((item) => item.provider === model.provider && item.id === model.id)) {
        throw badRequest("That image model is not connected. Connect its provider first, or choose another.");
      }
      await state.imageModelPreference.set(model);
    }
    sendJson(res, await imageModelSettings(state));
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/provider-account") {
    const provider = url.searchParams.get("provider");
    if (provider !== "openai" && provider !== "openai-codex") throw badRequest("Choose an OpenAI account connection.");
    const scope = await modelScope(url.searchParams.get("scope"), url.searchParams.get("connectedFolderId"));
    const runtime = await resolvePiRuntime(scope.connectedFolderRoot, state.runtimeProvider, { requestProjectTrust: false });
    const account = await readOpenAiAccount(runtime, provider);
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, { account });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/models") {
    const connectedFolderId = url.searchParams.get("connectedFolderId");
    const scope = await modelScope(url.searchParams.get("scope"), connectedFolderId);
    const models = await listPiModels(scope.connectedFolderRoot, state.runtimeProvider);
    const status = await getPiSetupStatus(scope.connectedFolderRoot, state.runtimeProvider);
    sendJson(res, {
      models: models.map((model) => ({
        ...model,
        oauthSupported: model.oauthSupported && Boolean(state.piOAuthHooks),
      })),
      status: normalizeStatus(status),
      providers: providerSetupResponse(status, Boolean(state.piOAuthHooks)),
      catalogs: await listPiModelCatalogs(state.runtimeProvider),
      ...(await getFoundrySettings(scope.connectedFolderRoot, state.runtimeProvider)),
      instructions: scope.id === ampleFileAgentScopeId
        ? null
        : await getPiWorkerInstructions(scope.connectedFolderRoot, state.runtimeProvider),
      // The Image model section rides this load, so opening Settings costs no extra request.
      ...(await imageModelSettings(state).then((imageModels) => ({ imageModels }), () => ({}))),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/models/refresh") {
    const body = await readJsonBody<{ connectedFolderId?: string; scope?: string; provider?: string }>(state, req);
    const scope = await modelScope(body.scope, body.connectedFolderId);
    if (!body.provider?.trim()) throw badRequest("A provider is required.");
    const refresh = await refreshPiModelCatalog(body.provider, state.runtimeProvider);
    sendJson(res, {
      refresh,
      models: await listPiModels(scope.connectedFolderRoot, state.runtimeProvider),
      status: normalizeStatus(await getPiSetupStatus(scope.connectedFolderRoot, state.runtimeProvider)),
      catalogs: await listPiModelCatalogs(state.runtimeProvider),
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/status") {
    const connectedFolderId = url.searchParams.get("connectedFolderId");
    const scope = await modelScope(url.searchParams.get("scope"), connectedFolderId);
    sendJson(res, { status: await safeAgentStatus(scope.connectedFolderRoot, state.runtimeProvider) });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/composer") {
    const connectedFolderId = url.searchParams.get("connectedFolderId");
    const scope = await modelScope(url.searchParams.get("scope"), connectedFolderId);
    sendJson(res, { composer: await getPiComposerState(scope.connectedFolderRoot, state.runtimeProvider) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/instructions") {
    const body = await readJsonBody<{ connectedFolderId?: string; scope?: string; instructions?: unknown }>(state, req);
    const scope = await modelScope(body.scope, body.connectedFolderId);
    if (scope.id === ampleFileAgentScopeId) throw badRequest("Worker instructions require a Connected Folder.");
    if (typeof body.instructions !== "string") throw badRequest("Worker instructions must be text.");
    let instructions: string;
    try {
      instructions = normalizeWorkerInstructions(body.instructions);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    await saveWorkerInstructions(state, scope, instructions);
    sendJson(res, { instructions });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/thinking") {
    const body = await readJsonBody<{ connectedFolderId?: string; scope?: string; level?: unknown }>(state, req);
    const scope = await modelScope(body.scope, body.connectedFolderId);
    if (typeof body.level !== "string" || !body.level.trim()) throw badRequest("A thinking level is required.");
    try {
      sendJson(res, { composer: await setPiDefaultThinkingLevel(scope.connectedFolderRoot, body.level, state.runtimeProvider) });
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/configure") {
    const body = await readJsonBody<{ connectedFolderId?: string; scope?: string; provider?: string; model?: string; apiKey?: string; azure?: unknown; foundry?: unknown }>(state, req);
    const scope = await modelScope(body.scope, body.connectedFolderId);
    if (!body.provider?.trim()) throw badRequest("A provider is required.");
    if (!body.model?.trim() && !body.apiKey?.trim() && body.azure === undefined && body.foundry === undefined) throw badRequest("A model or API key is required.");
    if (body.azure !== undefined && body.foundry !== undefined) throw badRequest("Submit one Foundry connection at a time.");
    let azure: FoundryConnection | undefined;
    if (body.azure !== undefined) {
      if (body.provider !== AZURE_OPENAI_PROVIDER) throw badRequest("Azure settings require the Azure OpenAI provider.");
      try { azure = normalizeFoundryConnection(body.azure); } catch (error) { throw badRequest(errorMessage(error)); }
    }
    if (body.foundry !== undefined) {
      if (!foundryProvider(body.provider)) throw badRequest("Foundry settings require a Microsoft Foundry provider.");
      try { azure = normalizeFoundryConnection(body.foundry, body.provider); } catch (error) { throw badRequest(errorMessage(error)); }
    }
    const available = await listPiModels(scope.connectedFolderRoot, state.runtimeProvider);
    const selected = available.find((model) => model.provider === body.provider && model.id === body.model);
    if (azure) {
      if (body.model && !azure.deployments.includes(body.model)) throw badRequest("Choose one of the Azure deployment names you entered.");
    } else if (body.model && !selected) throw badRequest(`The selected Pi model is not available for ${scope.label}.`);
    const providerAuth = azure
      ? (await getPiSetupStatus(scope.connectedFolderRoot, state.runtimeProvider)).providers.some((item) => item.id === body.provider && item.configured)
      : selected?.authConfigured;
    if (!body.apiKey?.trim() && !providerAuth) {
      throw badRequest(`Enter an API key for ${selected?.providerName ?? foundryProvider(body.provider)?.name ?? body.provider}.`);
    }
    await runCapabilityMutation(state, scope, "global", async () => {
      if (azure) {
        await saveFoundryConnection(scope.connectedFolderRoot, azure, body.apiKey, state.runtimeProvider, body.provider!);
      } else if (body.apiKey?.trim()) {
        await savePiApiKey(scope.connectedFolderRoot, body.provider!, body.apiKey, { runtimeProvider: state.runtimeProvider });
        // A first connection also gives every Worker a model to start on.
        if (!body.model) await ensurePiDefaultModel(scope.connectedFolderRoot, body.provider!, state.runtimeProvider);
      }
      if (body.model) await setPiDefaultModel(scope.connectedFolderRoot, { provider: body.provider!, id: body.model }, state.runtimeProvider);
    }, { requireProjectTrust: false });
    const status = await getPiSetupStatus(scope.connectedFolderRoot, state.runtimeProvider);
    sendJson(res, {
      status: normalizeStatus(status),
      providers: providerSetupResponse(status, Boolean(state.piOAuthHooks)),
      models: (await listPiModels(scope.connectedFolderRoot, state.runtimeProvider)).map((model) => ({
        ...model, oauthSupported: model.oauthSupported && Boolean(state.piOAuthHooks),
      })),
      ...(azure ? await getFoundrySettings(scope.connectedFolderRoot, state.runtimeProvider) : {}),
    });
    return;
  }
  if (method === "DELETE" && url.pathname === "/api/agent/auth") {
    const body = await readJsonBody<{ connectedFolderId?: string; scope?: string; provider?: string }>(state, req);
    const scope = await modelScope(body.scope, body.connectedFolderId);
    if (!body.provider?.trim()) throw badRequest("A provider is required.");
    await runCapabilityMutation(state, scope, "global", async () => {
      await removePiProviderAuth(scope.connectedFolderRoot, body.provider!, state.runtimeProvider);
    }, { requireProjectTrust: false });
    const status = await getPiSetupStatus(scope.connectedFolderRoot, state.runtimeProvider);
    sendJson(res, {
      models: await listPiModels(scope.connectedFolderRoot, state.runtimeProvider),
      status: normalizeStatus(status),
      providers: providerSetupResponse(status, Boolean(state.piOAuthHooks)),
      ...(foundryProvider(body.provider) ? await getFoundrySettings(scope.connectedFolderRoot, state.runtimeProvider) : {}),
    });
    return;
  }
  if (method === "POST" && ["/api/agent/oauth", "/api/agent/login"].includes(url.pathname)) {
    if (!state.piOAuthHooks) throw unavailable("Guided provider setup requires the AmpleFile desktop app.");
    const body = await readJsonBody<{ connectedFolderId?: string; scope?: string; provider?: string; model?: string; method?: string }>(state, req);
    const scope = await modelScope(body.scope, body.connectedFolderId);
    if (!body.provider?.trim()) throw badRequest("A provider is required.");
    const authMethod = url.pathname === "/api/agent/oauth" ? "oauth" : body.method;
    if (authMethod !== "oauth" && authMethod !== "api_key") throw badRequest("Choose account sign-in or API-key setup.");
    if (body.model && !(await listPiModels(scope.connectedFolderRoot, state.runtimeProvider)).some((item) => item.provider === body.provider && item.id === body.model)) {
      throw badRequest(`The selected Pi model is not available for ${scope.label}.`);
    }
    await runCapabilityMutation(state, scope, "global", async () => {
      await loginPiProvider(scope.connectedFolderRoot, body.provider!, authMethod, state.piOAuthHooks!, state.runtimeProvider);
      if (body.model) await setPiDefaultModel(scope.connectedFolderRoot, { provider: body.provider!, id: body.model }, state.runtimeProvider);
      else await ensurePiDefaultModel(scope.connectedFolderRoot, body.provider!, state.runtimeProvider);
    }, { requireProjectTrust: false });
    const status = await getPiSetupStatus(scope.connectedFolderRoot, state.runtimeProvider);
    sendJson(res, {
      status: normalizeStatus(status), providers: providerSetupResponse(status, true),
      models: await listPiModels(scope.connectedFolderRoot, state.runtimeProvider),
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/capabilities/discover") {
    const result = await state.capabilityRegistry.search({
      query: url.searchParams.get("query") ?? undefined,
      type: capabilityRegistryType(url.searchParams.get("type")),
      sort: capabilityRegistrySort(url.searchParams.get("sort")),
      offset: optionalBoundedInteger(url.searchParams.get("offset"), "offset"),
      limit: optionalBoundedInteger(url.searchParams.get("limit"), "limit"),
    });
    sendJson(res, { ...result, catalogUrl: "https://pi.dev/packages" });
    return;
  }
  if (method === "GET" && url.pathname === "/api/agent/capabilities/details") {
    const id = url.searchParams.get("id")?.trim();
    if (!id) throw badRequest("Capability id is required.");
    sendJson(res, { item: await state.capabilityRegistry.details(id) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/capabilities/install") {
    const body = await readJsonBody<{ connectedFolderId?: string; id?: string; scope?: "global" | "project" }>(state, req);
    if (!body.connectedFolderId || !body.id?.trim()) throw badRequest("A Connected Folder and capability are required.");
    const connectedFolder = await getConnectedFolder(body.connectedFolderId);
    const scope = capabilityScope(body.scope);
    // Remote inspection is read-only and can take several seconds. Complete it
    // before reserving the mutation so discovery never blocks an unrelated turn.
    const item = await state.capabilityRegistry.details(body.id);
    const bundle = item.sourceKind === "bundle"
      ? await state.capabilityRegistry.buildOfficialSkillBundle(item.id)
      : null;
    const installSource = item.installSource;
    if (!bundle && !installSource) throw badRequest("This capability is a reference and cannot be installed directly.");
    const installed = await runCapabilityMutation(state, connectedFolder, scope, async () => {
      if (bundle) {
        const imported = await importPiSkillBundle(connectedFolder.connectedFolderRoot, {
          fileName: bundle.fileName,
          bytes: bundle.bytes,
          scope: scope === "project" ? "project" : "user",
        }, state.runtimeProvider);
        return { kind: "skill" as const, item, imported };
      }
      await installPiPackage(connectedFolder.connectedFolderRoot, installSource!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
      return { kind: "package" as const, item, source: installSource! };
    });
    sendJson(res, { installed }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/mcp-setup") {
    const body = await readJsonBody<{ connectedFolderId?: string; sessionId?: string; operation?: string; scope?: "global" | "project"; name?: string; definition?: unknown; token?: string; jobId?: string; expectedRevision?: string; enabled?: unknown }>(state, req);
    if (!body.connectedFolderId || !body.operation) throw badRequest("A Connected Folder and setup operation are required.");
    let sessions = mcpSetupSessions.get(state);
    if (!sessions) { sessions = new Map(); mcpSetupSessions.set(state, sessions); }
    if (body.operation === "close") {
      const entry = body.sessionId ? sessions.get(body.sessionId) : undefined;
      if (!entry || entry.connectedFolderId !== body.connectedFolderId) { sendJson(res, { closed: true }); return; }
      clearTimeout(entry.timer); sessions.delete(body.sessionId!); await entry.service.dispose(); sendJson(res, { closed: true }); return;
    }
    const connectedFolder = await getConnectedFolder(body.connectedFolderId);
    if (body.operation === "open") {
      const runtime = await resolvePiRuntime(connectedFolder.connectedFolderRoot, state.runtimeProvider, { requestProjectTrust: false });
      if (!runtime.config.includedTools) throw badRequest("Included service connections are unavailable in this host.");
      if (sessions.size >= 16) throw httpError(409, "Close another service setup before opening one.");
      const id = randomUUID();
      const assertCurrentOwner = async () => {
        const current = await getConnectedFolder(connectedFolder.id);
        if (current.connectedFolderRoot !== connectedFolder.connectedFolderRoot) throw badRequest("This Connected Folder moved. Open connection setup again.");
        const currentRuntime = await resolvePiRuntime(current.connectedFolderRoot, state.runtimeProvider, { requestProjectTrust: false });
        if (currentRuntime.agentDir !== runtime.agentDir || !currentRuntime.projectTrust.trusted) throw badRequest("The agent resource scope changed. Open connection setup again.");
      };
      const service = createIncludedMcpSetup({ agentDir: runtime.agentDir, mcpCredentialBackend: runtime.config.mcpCredentialBackend, credentials: runtime.credentials, providerToken: async (id) => (await runtime.modelRuntime.getAuth(id))?.auth.apiKey, ...(runtime.projectTrust.trusted ? { cwd: connectedFolder.connectedFolderRoot } : {}),
        openAuthorizationUrl: async (url) => {
          await assertCurrentOwner();
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw badRequest("This service returned an unsupported authorization URL.");
          if (!state.piOAuthHooks) throw badRequest("Open this setup in the desktop app to sign in.");
          await state.piOAuthHooks.openUrl({ url });
        },
        withMutation: async (selection, operation) => {
          const mutation = await runDesktopSettingsAct(state, "tools.connection.configure", async () => ({
            value: await runCapabilityMutation(state, connectedFolder, selection.scope, async () => {
              await assertCurrentOwner();
              // Drain and revoke native session credentials before changing standing auth.
              if (selection.scope === "global") await invalidateAllClients(state);
              else await invalidateAmpleFileClients(state, connectedFolder.id);
              return operation();
            }), detail: `Updated service connection ${selection.name} (${selection.scope}).`,
          }));
          return mutation.value;
        },
      });
      const entry = { connectedFolderId: connectedFolder.id, service, timer: setTimeout(() => undefined, 0) };
      sessions.set(id, entry); resetMcpSetupExpiry(state, id, entry);
      try { sendJson(res, { sessionId: id, servers: await service.list() }); }
      catch (error) { clearTimeout(entry.timer); sessions.delete(id); await service.dispose().catch(() => undefined); throw error; }
      return;
    }
    const entry = body.sessionId ? sessions.get(body.sessionId) : undefined;
    if (!entry || entry.connectedFolderId !== connectedFolder.id) throw badRequest("This connection setup has closed. Open it again.");
    resetMcpSetupExpiry(state, body.sessionId!, entry);
    if (body.operation === "list") { sendJson(res, { servers: await entry.service.list({ inspectCredentials: true }) }); return; }
    if (body.operation === "oauth-status") { sendJson(res, { job: entry.service.oauthStatus(body.jobId ?? "") }); return; }
    if (body.operation === "oauth-cancel") { await entry.service.cancelOAuth(body.jobId ?? ""); sendJson(res, { cancelled: true }); return; }
    if (!body.name || !["global", "project"].includes(body.scope ?? "")) throw badRequest("Choose a service and scope.");
    if (["check", "remove", "enabled", "bearer", "disconnect", "oauth"].includes(body.operation) && !body.expectedRevision) throw badRequest("Refresh service setup before changing this connection.");
    if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedRevision))) throw badRequest("Invalid service configuration revision.");
    const selection = { name: body.name, scope: body.scope!, ...(body.expectedRevision ? { expectedRevision: body.expectedRevision } : {}) };
    switch (body.operation) {
      case "check": {
        const controller = new AbortController();
        const close = () => { if (!res.writableEnded) controller.abort(); };
        res.once("close", close);
        try { sendJson(res, { probe: await entry.service.probe(selection, { signal: controller.signal }) }); }
        finally { res.off("close", close); }
        return;
      }
      case "save": await entry.service.saveServer({ ...selection, definition: body.definition as never }); break;
      case "enabled": {
        if (typeof body.enabled !== "boolean") throw badRequest("Choose whether the service is enabled.");
        await entry.service.setEnabled(selection, body.enabled); break;
      }
      case "remove": await entry.service.removeServer(selection); break;
      case "bearer": await entry.service.saveBearer({ ...selection, token: body.token! }); break;
      case "disconnect": await entry.service.disconnect(selection); break;
      case "oauth": sendJson(res, { job: await entry.service.startOAuth(selection) }); return;
      default: throw badRequest("Unknown service setup operation.");
    }
    sendJson(res, { servers: await entry.service.list({ inspectCredentials: true }) }); return;
  }
  if (method === "GET" && url.pathname === "/api/agent/included-tools") {
    // The included tools are machine-wide; first run sets them up before any Connected Folder exists.
    const connectedFolder = await includedToolScope(url.searchParams.get("connectedFolderId"));
    sendJson(res, { tools: await listIncludedToolStatus(connectedFolder.connectedFolderRoot, state.runtimeProvider) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/included-tools/setup") {
    const body = await readJsonBody<{ connectedFolderId?: string; id?: IncludedToolId; action?: IncludedSetupAction; secret?: string }>(state, req);
    if (!includedToolDefinitions.some((item) => item.id === body.id) || typeof body.action !== "string") throw badRequest("An included tool and setup action are required.");
    if (body.secret !== undefined && typeof body.secret !== "string") throw badRequest("The connection key must be text.");
    const connectedFolder = await includedToolScope(body.connectedFolderId);
    const signal = new AbortController();
    const closed = () => { if (!res.writableEnded) signal.abort(); };
    res.once("close", closed);
    try {
      const operation = () => setupIncludedTool(connectedFolder.connectedFolderRoot, body.id!, body.action!, { secret: body.secret }, state.runtimeProvider, signal.signal);
      // Observation and deliberate start never repair or dispose peer Chats.
      // Repair/permission setup keeps the mutation fence and idle-client reset.
      const result = body.action === "check" || body.id === "computer" && body.action === "start-check" ? await operation() : await runCapabilityMutation(state, connectedFolder, "global", operation);
      sendJson(res, result);
    } finally { res.off("close", closed); }
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/resources/enabled") {
    const body = await readJsonBody<{ connectedFolderId?: string; path?: string; kind?: NativeResourceKind; enabled?: boolean; scope?: "global" | "project" }>(state, req);
    if (!body.connectedFolderId || !body.path || !body.kind || !["extensions", "skills", "prompts", "themes"].includes(body.kind)
      || typeof body.enabled !== "boolean" || !["global", "project"].includes(body.scope ?? "")) {
      throw badRequest("A Connected Folder, resource, kind, enabled state, and scope are required.");
    }
    const connectedFolder = await getConnectedFolder(body.connectedFolderId);
    const scope = capabilityScope(body.scope);
    const result = await runDesktopSettingsAct(state, "tools.enabled", async (requestId) => {
      const value = await createAmpleFileActFacade(state).toolsSetEnabled({
        path: body.path!, kind: body.kind!, enabled: body.enabled!, scope: scope === "project" ? "connected-folder" : "everywhere",
        ...(scope === "project" ? { connectedFolder: connectedFolder.id } : {}), requestId,
      });
      return { value, detail: `Turned ${body.enabled ? "on" : "off"} ${body.kind} resource ${body.path}.` };
    });
    sendJson(res, { ...result.value, requestId: result.requestId });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/install") {
    const body = await readJsonBody<{ connectedFolderId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.connectedFolderId || !body.source?.trim()) throw badRequest("A Connected Folder and package source are required.");
    const connectedFolder = await getConnectedFolder(body.connectedFolderId);
    const scope = capabilityScope(body.scope);
    await runCapabilityMutation(state, connectedFolder, scope, async () => {
      await installPiPackage(connectedFolder.connectedFolderRoot, body.source!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
    });
    sendJson(res, { installed: true }, 201);
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/update") {
    const body = await readJsonBody<{ connectedFolderId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.connectedFolderId || !body.source?.trim() || !body.scope) {
      throw badRequest("A Connected Folder, package source, and scope are required.");
    }
    const connectedFolder = await getConnectedFolder(body.connectedFolderId);
    const scope = capabilityScope(body.scope);
    await runCapabilityMutation(state, connectedFolder, scope, async () => {
      await updatePiPackages(connectedFolder.connectedFolderRoot, body.source, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      });
    });
    sendJson(res, { updated: true });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/packages/remove") {
    const body = await readJsonBody<{ connectedFolderId?: string; source?: string; scope?: "global" | "project" }>(state, req);
    if (!body.connectedFolderId || !body.source?.trim() || !body.scope) {
      throw badRequest("A Connected Folder, package source, and scope are required.");
    }
    const connectedFolder = await getConnectedFolder(body.connectedFolderId);
    const scope = capabilityScope(body.scope);
    const removed = await runCapabilityMutation(state, connectedFolder, scope, async () =>
      await removePiPackage(connectedFolder.connectedFolderRoot, body.source!, {
        scope: scope === "project" ? "project" : "user",
        runtimeProvider: state.runtimeProvider,
      }));
    sendJson(res, { removed });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/skills/remove") {
    const body = await readJsonBody<{ connectedFolderId?: string; path?: string; scope?: "global" | "project" }>(state, req);
    if (!body.connectedFolderId || !body.path?.trim()) throw badRequest("A Connected Folder and Skill path are required.");
    const connectedFolder = await getConnectedFolder(body.connectedFolderId);
    const scope = capabilityScope(body.scope);
    const removed = await runDesktopSettingsAct(state, "skills.remove", async (requestId) => {
      const value = await removeImportedSkill(state, connectedFolder, scope, body.path!, { receiptId: requestId });
      return { value, detail: `${scope === "project" ? `Connected Folder ${connectedFolder.id}` : "everywhere"}; skill ${value.skillName}; trash ${value.recentlyDeleted.entryId}` };
    });
    sendJson(res, { removed: true, path: removed.value.removedPath, recentlyDeleted: removed.value.recentlyDeleted });
    return;
  }
  if (method === "POST" && url.pathname === "/api/agent/skills/import") {
    const multipart = await readMultipartBody(state, req);
    const connectedFolderId = multipart.fields.get("connectedFolderId");
    if (!connectedFolderId || !multipart.files.length) throw badRequest("A Connected Folder and Skill files are required.");
    const connectedFolder = await getConnectedFolder(connectedFolderId);
    const scope = multipart.fields.get("scope") === "project" ? "project" : "user";
    const imported = await runCapabilityMutation(
      state,
      connectedFolder,
      scope === "project" ? "project" : "global",
      async () => {
        const results = [];
        for (const file of multipart.files) {
          results.push(await importPiSkillBundle(connectedFolder.connectedFolderRoot, { fileName: file.fileName, bytes: file.data, scope }, state.runtimeProvider));
        }
        return results;
      },
    );
    sendJson(res, { imported }, 201);
    return;
  }

  const catalogMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/agent\/catalog$/);
  if (method === "GET" && catalogMatch) {
    const snapshot = await state.kernel.getCapabilities({ kind: "renderer", connectedFolderId: catalogMatch[1] });
    sendJson(res, snapshot.catalog);
    return;
  }
  const conversationsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations$/);
  if (conversationsMatch && method === "GET") {
    const connectedFolder = await getConnectedFolder(conversationsMatch[1]);
    sendJson(res, { conversations: await listConversations(connectedFolder.connectedFolderRoot) });
    return;
  }
  if (conversationsMatch && method === "POST") {
    const connectedFolder = await getConnectedFolder(conversationsMatch[1]);
    const body = await readJsonBody<{ conversationId?: unknown }>(state, req);
    const conversationId = body.conversationId === undefined
      ? undefined
      : conversationIdentity(body.conversationId);
    const conversation = conversationId === undefined
      ? await createConversation(connectedFolder.connectedFolderRoot)
      : await runConversationMutation(state, connectedFolder.id, conversationId, () =>
        createConversation(connectedFolder.connectedFolderRoot, undefined, conversationId));
    sendJson(res, { conversation }, 201);
    return;
  }

  const conversationMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)$/);
  if (conversationMatch && (method === "PUT" || method === "PATCH")) {
    const connectedFolder = await getConnectedFolder(conversationMatch[1]);
    const conversationId = conversationMatch[2];
    const body = await readJsonBody<{ title?: string; archived?: boolean; snoozedUntil?: string | null }>(state, req);
    const changes = [
      body.title !== undefined,
      body.archived !== undefined,
      body.snoozedUntil !== undefined,
    ].filter(Boolean).length;
    if (changes !== 1) throw badRequest("Change exactly one Chat title, archive state, or snooze time.");
    if (body.title !== undefined && typeof body.title !== "string") throw badRequest("Chat title must be text.");
    if (body.archived !== undefined && typeof body.archived !== "boolean") throw badRequest("Archived state must be true or false.");
    if (body.snoozedUntil !== undefined && body.snoozedUntil !== null) {
      if (typeof body.snoozedUntil !== "string" || !Number.isFinite(Date.parse(body.snoozedUntil))) {
        throw badRequest("Snooze time is invalid.");
      }
      if (Date.parse(body.snoozedUntil) <= Date.now()) throw badRequest("Choose a future snooze time.");
    }
    const conversation = await runConversationMutation(state, connectedFolder.id, conversationId, async () => {
      const updated = body.title !== undefined
        ? await renameConversation(connectedFolder.connectedFolderRoot, conversationId, body.title)
        : await updateConversationLifecycle(connectedFolder.connectedFolderRoot, conversationId, {
            ...(body.archived !== undefined ? { archived: body.archived } : {}),
            ...(body.snoozedUntil !== undefined ? { snoozedUntil: body.snoozedUntil } : {}),
          });
      if (body.title !== undefined) state.clients.get(clientKey(connectedFolder.id, conversationId))?.setSessionName(updated.title);
      return updated;
    });
    sendJson(res, { conversation });
    return;
  }
  if (conversationMatch && method === "DELETE") {
    const connectedFolder = await getConnectedFolder(conversationMatch[1]);
    const deleted = await runDesktopSettingsAct(state, "chats.delete", async (requestId) => {
      const value = await deleteConnectedFolderConversation(state, connectedFolder, conversationMatch[2], { receiptId: requestId });
      return { value, detail: `Connected Folder ${connectedFolder.id}; conversation ${value.conversationId}; trash ${value.recentlyDeleted.entryId}` };
    });
    sendJson(res, { deleted: deleted.value });
    return;
  }

  const conversationRuntimeMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/runtime$/);
  if (conversationRuntimeMatch && method === "GET") {
    const connectedFolder = await getConnectedFolder(conversationRuntimeMatch[1]);
    const conversationId = conversationRuntimeMatch[2];
    if (!(await readConversation(connectedFolder.connectedFolderRoot, conversationId)).length) throw notFound("Conversation not found.");
    const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, conversationId);
    sendJson(res, { runtime: await client.getState() });
    return;
  }

  const conversationThinkingMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/thinking$/);
  if (conversationThinkingMatch && method === "POST") {
    const connectedFolder = await getConnectedFolder(conversationThinkingMatch[1]);
    const conversationId = conversationThinkingMatch[2];
    if (!(await readConversation(connectedFolder.connectedFolderRoot, conversationId)).length) throw notFound("Conversation not found.");
    const body = await readJsonBody<{ level?: unknown }>(state, req);
    if (typeof body.level !== "string" || !body.level.trim()) throw badRequest("A thinking level is required.");
    const key = clientKey(connectedFolder.id, conversationId);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current agent turn to finish before changing the thinking level.");
    const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, conversationId);
    let result: { level: string; available: string[] };
    try {
      result = await client.setThinkingLevel(body.level);
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    sendJson(res, { thinking: result, runtime: await client.getState() });
    return;
  }

  const contextAttachmentMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/context-attachments$/);
  if (contextAttachmentMatch && method === "POST") {
    const connectedFolder = await getConnectedFolder(contextAttachmentMatch[1]);
    const body = await readJsonBody<{ path?: string }>(state, req);
    if (!body.path?.trim()) throw badRequest("A file path is required.");
    sendJson(res, { attachment: await previewConversationContextReference(connectedFolder.connectedFolderRoot, { path: body.path }) }, 201);
    return;
  }

  const eventsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/events$/);
  if (method === "GET" && eventsMatch) {
    const connectedFolder = await getConnectedFolder(eventsMatch[1]);
    rememberConnectedFolderRoot(state, connectedFolder.id, connectedFolder.connectedFolderRoot);
    openChatStream(state, createLocalEventSink(res), eventsMatch[1], eventsMatch[2], req.headers["last-event-id"]);
    return;
  }
  const queueMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/queue$/);
  if (queueMatch && (method === "PUT" || method === "DELETE")) {
    const connectedFolder = await getConnectedFolder(queueMatch[1]);
    if (!(await readConversationSummary(connectedFolder.connectedFolderRoot, queueMatch[2]))) throw notFound("Conversation not found.");
    if (method === "DELETE") {
      sendJson(res, cancelQueuedMessage(state, connectedFolder.id, queueMatch[2]));
      return;
    }
    const body = await readJsonBody<{ content?: string; contextPaths?: string[]; addressedConnectedFolderIds?: unknown }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    const contextPaths = normalizeContextPaths(connectedFolder.connectedFolderRoot, body.contextPaths);
    // Workers the message addresses with @ travel with it, as on the ordinary message route.
    const addressedConnectedFolderIds = await normalizeAddressedConnectedFolderIds(body.addressedConnectedFolderIds, connectedFolder.id);
    sendJson(res, queueChatMessage(state, connectedFolder.id, queueMatch[2], { content, contextPaths, addressedConnectedFolderIds }));
    return;
  }
  const messagesPostMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/messages$/);
  if (method === "POST" && messagesPostMatch) {
    const connectedFolder = await getConnectedFolder(messagesPostMatch[1]);
    const conversationId = messagesPostMatch[2];
    const body = await readJsonBody<{
      content?: string;
      contextPaths?: string[];
      /** Ignored: the file selected in Files never reaches the Worker. */
      selectedPath?: unknown;
      requestId?: unknown;
      userMessageId?: unknown;
      delivery?: unknown;
      addressedConnectedFolderIds?: unknown;
    }>(state, req);
    const content = body.content?.trim();
    if (!content) throw badRequest("Message content is required.");
    if (body.delivery !== undefined && body.delivery !== "steer") throw badRequest("Message delivery must be \"steer\" when present.");
    if (body.delivery === "steer") {
      const steered = await steerConversationTurn(state, connectedFolder, conversationId, {
        content,
        requestId: optionalTurnIdentity(body.requestId, "requestId"),
        userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
      });
      sendJson(res, { accepted: true, delivery: "steer", message: steered.message, taskId: steered.taskId, replayed: steered.replayed }, 202);
      return;
    }
    const contextPaths = normalizeContextPaths(connectedFolder.connectedFolderRoot, body.contextPaths);
    const addressedConnectedFolderIds = await normalizeAddressedConnectedFolderIds(body.addressedConnectedFolderIds, connectedFolder.id);
    const { message, taskId, replayed } = await acceptConversationTurn(state, connectedFolder, conversationId, {
      content,
      contextPaths,
      actorKind: "assistant",
      ...(addressedConnectedFolderIds.length ? { addressedConnectedFolderIds } : {}),
      requestId: optionalTurnIdentity(body.requestId, "requestId"),
      userMessageId: optionalTurnIdentity(body.userMessageId, "userMessageId"),
    });
    sendJson(res, { accepted: true, message, taskId, replayed }, 202);
    return;
  }
  const abortMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/abort$/);
  if (method === "POST" && abortMatch) {
    const connectedFolder = await getConnectedFolder(abortMatch[1]);
    const key = clientKey(connectedFolder.id, abortMatch[2]);
    const client = state.clients.get(key);
    const request = state.requests.latestForConversation(abortMatch[2], { connectedFolderId: connectedFolder.id });
    if (request) {
      const stopped = await stopAmpleFileAgentRequest(state, request.turns.at(-1)!.taskId);
      sendJson(res, { aborted: stopped.ampleFileAgentAborted || stopped.children.some((child) => child.aborted), stopped });
    } else sendJson(res, { aborted: client ? await client.abort() : false });
    return;
  }

  // Make a Copy: a new Chat with this one's history as of its
  // last finished reply. The same copy the act lane's `chat copy` makes.
  const copyMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/copy$/);
  if (method === "POST" && copyMatch) {
    const connectedFolder = await getConnectedFolder(copyMatch[1]);
    const body = await readJsonBody<{ title?: unknown }>(state, req);
    const copied = await copyConversation(state, connectedFolder, copyMatch[2], typeof body.title === "string" ? body.title : undefined);
    publishControlHint(state, "connected-folders");
    sendJson(res, { conversation: copied.conversation, copiedMessages: copied.copiedMessages });
    return;
  }

  const compactMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/compact$/);
  if (method === "POST" && compactMatch) {
    const connectedFolder = await getConnectedFolder(compactMatch[1]);
    if (!(await readConversation(connectedFolder.connectedFolderRoot, compactMatch[2])).length) throw notFound("Conversation not found.");
    const key = clientKey(connectedFolder.id, compactMatch[2]);
    const body = await readJsonBody<{ customInstructions?: string }>(state, req);
    await yieldBackgroundCompaction(state, key);
    assertNoCapabilityMutationForTurn(state, connectedFolder.id);
    if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current agent turn to finish.");
    if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
    state.compactingConversations.add(key);
    const task = state.kernel.startTask({
      kind: "compaction",
      connectedFolderId: connectedFolder.id,
      conversationId: compactMatch[2],
      actor: { kind: "assistant", cwd: connectedFolder.connectedFolderRoot, connectedFolderId: connectedFolder.id, conversationId: compactMatch[2] },
    });
    try {
      const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, compactMatch[2]);
      await client.compact(body.customInstructions?.trim() || undefined);
      broadcast(state, streamKey(connectedFolder.id, compactMatch[2]), { type: "done", conversationId: compactMatch[2] });
    } finally {
      state.compactingConversations.delete(key);
      await refreshClientIfMarked(state, key);
      state.kernel.finishTask(task.id);
      queueConversationRequestEvaluation(state, connectedFolder.id, compactMatch[2]);
    }
    sendJson(res, { compacted: true });
    return;
  }
  const messagesGetMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)$/);
  if (method === "GET" && messagesGetMatch) {
    const connectedFolder = await getConnectedFolder(messagesGetMatch[1]);
    sendJson(res, { messages: await readConversation(connectedFolder.connectedFolderRoot, messagesGetMatch[2]) });
    return;
  }
  // Management conversation surface: the same acceptance path, task records,
  // and event stream as Connected Folder Chats, exposed for renderer clients (the
  // menu-bar popover) under the AmpleFile Agent scope id instead of a Connected Folder id.
  if (url.pathname === "/api/amplefile-agent/summary" && method === "GET") {
    if (state.ampleFileAgentInstructionsError) {
      sendJson(res, { available: false, reason: state.ampleFileAgentInstructionsError, conversation: null, state: "idle", latestRequest: null });
      return;
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
    return;
  }
  if (url.pathname === "/api/amplefile-agent/conversations" && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversations = await listConversations(ampleFileAgentRoot());
    sendJson(res, { conversations: await Promise.all(conversations.map(async (conversation) => ({
      ...toActConversationRef(conversation),
      ...await ampleFileAgentConversationAttention(state, conversation.id),
    }))) });
    return;
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
      return;
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
    return;
  }
  const ampleFileAgentRequestMatch = match(url.pathname, /^\/api\/amplefile-agent\/requests\/([^/]+)$/);
  if (ampleFileAgentRequestMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    const request = await ampleFileAgentRequestView(state, ampleFileAgentRequestMatch[1]);
    if (!request) throw notFound(`Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
    sendJson(res, { request });
    return;
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
    return;
  }
  const ampleFileAgentConversationMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)$/);
  if (ampleFileAgentConversationMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    sendJson(res, { messages: await readConversation(ampleFileAgentRoot(), ampleFileAgentConversationMatch[1]) });
    return;
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
    return;
  }
  if (ampleFileAgentConversationMatch && method === "DELETE") {
    assertAmpleFileAgentReadyForRoutes(state);
    const deleted = await deleteAmpleFileAgentConversation(state, ampleFileAgentConversationMatch[1], { receiptId: null });
    sendJson(res, { deleted });
    return;
  }
  const ampleFileAgentRuntimeMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/runtime$/);
  if (ampleFileAgentRuntimeMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    const conversationId = ampleFileAgentRuntimeMatch[1];
    if (!(await readConversation(ampleFileAgentRoot(), conversationId)).length) throw notFound("Conversation not found.");
    const client = await getClient(state, ampleFileAgentScopeId, ampleFileAgentRoot(), conversationId);
    sendJson(res, { runtime: await client.getState() });
    return;
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
    return;
  }
  const ampleFileAgentEventsMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/events$/);
  if (ampleFileAgentEventsMatch && method === "GET") {
    assertAmpleFileAgentReadyForRoutes(state);
    openChatStream(state, createLocalEventSink(res), ampleFileAgentScopeId, ampleFileAgentEventsMatch[1], req.headers["last-event-id"]);
    return;
  }

  const connectedFolderWorkMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/work$/);
  const ampleFileAgentWorkMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/work$/);
  const taskWorkMatch = match(url.pathname, /^\/api\/tasks\/([^/]+)\/work$/);
  if (method === "GET" && (connectedFolderWorkMatch || ampleFileAgentWorkMatch || taskWorkMatch)) {
    if (connectedFolderWorkMatch) await getConnectedFolder(connectedFolderWorkMatch[1]);
    const record = taskWorkMatch ? state.requests.byTaskId(taskWorkMatch[1])
      : state.requests.latestForConversation(connectedFolderWorkMatch?.[2] ?? ampleFileAgentWorkMatch![1],
        connectedFolderWorkMatch ? { connectedFolderId: connectedFolderWorkMatch[1] } : {});
    sendJson(res, { work: record ? await requestPresentation(state, record) : null });
    return;
  }
  const workActionMatch = match(url.pathname, /^\/api\/requests\/([^/]+)\/(answer|stop|continue)$/);
  if (method === "POST" && workActionMatch) {
    const record = state.requests.get(workActionMatch[1]);
    if (!record) throw notFound("This work is no longer on record.");
    const input = await readJsonBody<Record<string, unknown>>(state, req);
    await performWorkAction(state, record, workActionMatch[2], input);
    sendJson(res, { work: await requestPresentation(state, state.requests.get(record.requestId)!) });
    return;
  }

  // One renderer connection carries only its explicitly subscribed read streams.
  // The same local session/origin authorization above protects this endpoint.
  if (url.pathname === "/api/events" && method === "POST") {
    if (state.localEventStreams.size >= 64) throw httpError(429, "Too many local event connections.");
    const input = await readJsonBody<unknown>(state, req, localEventStreamLimits.bodyBytes);
    let subscriptions: ReturnType<typeof parseLocalEventSubscriptions>;
    try { subscriptions = parseLocalEventSubscriptions(input); }
    catch (error) { throw badRequest(errorMessage(error)); }
    if (state.localEventStreams.size >= 64) throw httpError(429, "Too many local event connections.");
    const connection = createLocalEventSink(res);
    state.localEventStreams.add(connection);
    const heartbeat = setInterval(() => connection.heartbeat(), 15_000);
    heartbeat.unref();
    connection.onClose(() => { clearInterval(heartbeat); state.localEventStreams.delete(connection); });
    await Promise.all(subscriptions.map(async (subscription) => {
      const channel = createLocalEventChannel(connection, subscription.id);
      try {
        const target = localEventTarget(subscription.path)!;
        if (target.kind === "control") {
          if (state.controlStreams.size >= 64) throw httpError(429, "Too many control event connections.");
          openControlEventStream(state, channel);
        } else if (target.kind === "agent") {
          assertAmpleFileAgentReadyForRoutes(state);
          if (!await readConversationSummary(ampleFileAgentRoot(), target.conversationId)) throw notFound("Conversation not found.");
          if (channel.closed) return;
          openChatStream(state, channel, ampleFileAgentScopeId, target.conversationId, subscription.lastEventId);
        } else {
          const connectedFolder = await getConnectedFolder(target.connectedFolderId);
          if (channel.closed) return;
          if (target.kind === "files") await openConnectedFolderFileStream(state, channel, connectedFolder.connectedFolderRoot, target.connectedFolderId);
          else {
            if (!await readConversationSummary(connectedFolder.connectedFolderRoot, target.conversationId)) throw notFound("Conversation not found.");
            const registered = await getConnectedFolder(target.connectedFolderId);
            if (registered.connectedFolderRoot !== connectedFolder.connectedFolderRoot) throw notFound("Connected Folder changed while opening this Chat.");
            if (channel.closed) return;
            rememberConnectedFolderRoot(state, registered.id, registered.connectedFolderRoot);
            openChatStream(state, channel, target.connectedFolderId, target.conversationId, subscription.lastEventId);
          }
        }
        if (!channel.closed) connection.send({ subscriptionId: subscription.id, ready: true } satisfies LocalEventEnvelope);
      } catch (error) {
        const code = (error as { statusCode?: unknown })?.statusCode;
        const status = typeof code === "number" && code >= 400 && code <= 599 ? code : 500;
        if (!channel.closed) connection.send({ subscriptionId: subscription.id, error: {
          status, message: status < 500 ? errorMessage(error) : "This local event stream is unavailable. Refresh to reconnect.",
        } } satisfies LocalEventEnvelope);
        channel.close();
      }
    }));
    return;
  }

  // Content-free control hints for the renderer: which registry changed, so
  // the surfaces requery instead of accumulating an event queue.
  if (url.pathname === "/api/amplefile-agent/control-events" && method === "GET") {
    if (state.controlStreams.size >= 64) throw httpError(429, "Too many control event connections.");
    openControlEventStream(state, createLocalEventSink(res));
    return;
  }
  // The overview (docs/amplefile-agent-overview.md): the app-composed digest for the popover
  // and the main window, on the renderer session. Deliberately no
  // management-readiness gate — the digest reads recorded state, not the
  // management Pi session, so it stays available even when management
  // commands fail closed; only narration needs the conversation.
  if (url.pathname === "/api/amplefile-agent/overview" && method === "GET") {
    sendJson(res, { overview: await state.kernel.getOverview({ kind: "renderer" }) });
    return;
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
    return;
  }

  // Settings → Recently deleted (docs/act-ledger.md).
  // Listing is a plain read; restoring, removing one item, and changing how
  // long items are kept are journaled acts with the main-window surface, like
  // every other trusted-Settings mutation. Nothing here empties the store.
  if (url.pathname === "/api/settings/recently-deleted" && method === "GET") {
    const listing = await state.recentlyDeleted.list();
    const registered = new Set((await listConnectedFolders()).map((connectedFolder) => connectedFolder.id));
    const entries = [];
    for (const entry of listing.entries) entries.push(await recentlyDeletedEntryView(entry, registered));
    sendJson(res, { entries, damaged: listing.damaged, retentionDays: listing.retentionDays });
    return;
  }
  if (url.pathname === "/api/settings/recently-deleted/retention" && method === "PUT") {
    const body = await readJsonBody<{ retentionDays?: unknown }>(state, req);
    const days = Number(body.retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw badRequest("Keep deleted items for between 1 and 365 days.");
    }
    const updated = await runDesktopSettingsAct(state, "recently-deleted.retention", async () => {
      await state.recentlyDeleted.setRetentionDays(days);
      return { value: { retentionDays: state.recentlyDeleted.retentionDays() }, detail: `days ${days}` };
    });
    sendJson(res, updated.value);
    return;
  }
  // Settings → Automations → Limits: the one adjustable request setting.
  // Turning follow-up turns off changes nothing about what is recorded; it
  // only stops the host from bringing the results back as a turn.
  if (url.pathname === "/api/settings/requests" && method === "GET") {
    sendJson(res, { continuationsEnabled: state.requests.continuationsEnabled() });
    return;
  }
  if (url.pathname === "/api/settings/requests/continuations" && method === "PUT") {
    const body = await readJsonBody<{ enabled?: unknown }>(state, req);
    if (typeof body.enabled !== "boolean") throw badRequest("Say whether follow-up turns are on or off.");
    const enabled = body.enabled;
    const updated = await runDesktopSettingsAct(state, "requests.continuations", async () => {
      await state.requests.setContinuationsEnabled(enabled);
      return { value: { continuationsEnabled: state.requests.continuationsEnabled() }, detail: enabled ? "on" : "off" };
    });
    sendJson(res, updated.value);
    return;
  }
  const recentlyDeletedEntryMatch = match(url.pathname, /^\/api\/settings\/recently-deleted\/([^/]+)$/);
  if (recentlyDeletedEntryMatch && method === "DELETE") {
    const entryId = recentlyDeletedEntryMatch[1];
    if (!ampleFileRecentlyDeletedEntryIdPattern.test(entryId)) throw notFound("That item is no longer in Recently deleted.");
    try {
      const removed = await runDesktopSettingsAct(state, "recently-deleted.delete-now", async () => ({
        value: await state.recentlyDeleted.remove(entryId),
        detail: `entry ${entryId}`,
      }));
      sendJson(res, removed.value);
    } catch (error) {
      if (error instanceof AmpleFileRecentlyDeletedError && error.code === "HELD") {
        sendJson(res, { error: error.message }, 409);
        return;
      }
      throw error;
    }
    return;
  }
  const recentlyDeletedRestoreMatch = match(url.pathname, /^\/api\/settings\/recently-deleted\/([^/]+)\/restore$/);
  if (recentlyDeletedRestoreMatch && method === "POST") {
    await readJsonBody<Record<string, never>>(state, req);
    const restored = await runDesktopSettingsAct(state, "recently-deleted.restore", async (requestId) => {
      const value = await restoreRecentlyDeletedEntry(state, recentlyDeletedRestoreMatch[1], { receiptId: requestId });
      return { value, detail: `entry ${recentlyDeletedRestoreMatch[1]}; kind ${value.kind}` };
    });
    sendJson(res, { restored: restored.value });
    return;
  }
  const extensionResponseMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/conversations\/([^/]+)\/extension-ui(?:\/([^/]+))?$/);
  const ampleFileAgentExtensionMatch = match(url.pathname, /^\/api\/amplefile-agent\/conversations\/([^/]+)\/extension-ui(?:\/([^/]+))?$/);
  if ((extensionResponseMatch || ampleFileAgentExtensionMatch) && (method === "GET" || method === "POST")) {
    const scope: PiExtensionUiScope = extensionResponseMatch
      ? { connectedFolderRoot: (await getConnectedFolder(extensionResponseMatch[1])).connectedFolderRoot, conversationId: extensionResponseMatch[2] }
      : { connectedFolderRoot: ampleFileAgentRoot(), conversationId: ampleFileAgentExtensionMatch![1] };
    const id = extensionResponseMatch?.[3] ?? ampleFileAgentExtensionMatch?.[2];
    if (!id && method === "GET") {
      sendJson(res, { requests: extensionSnapshot(state, scope) });
      return;
    }
    if (!id || method !== "POST") throw notFound("Extension request not found.");
    const body = await readJsonBody<{ value?: unknown; cancelled?: boolean }>(state, req);
    const accepted = answerExtensionRequest(state, scope, id, body);
    sendJson(res, { accepted });
    return;
  }

  throw notFound("Not found.");
}

/**
 * Shared turn-acceptance path for the renderer route and the CLI act facade.
 * Owns the conflict checks, runningTurns bookkeeping, kernel task record, user
 * message persistence with rollback, and the detached Pi turn start, so every
 * caller obeys identical concurrency and persistence rules.
 */
/**
 * Request lineage for one accepted turn. Absent means "a Connected Folder turn with no
 * parent": the turn is its own root. `parentTaskId` makes it a child request
 * under the request that task belongs to; `joinRequestId` makes it a further
 * turn of an existing request (a reply to a question, a follow-up turn).
 */
interface AcceptedTurnRequestInput {
  kind?: AmpleFileRequestCreatableKind;
  surface?: AmpleFileRequestSurface;
  parentTaskId?: string;
  joinRequestId?: string;
  /** The assignment text when it differs from this turn's message (an answer continuation). */
  assignment?: string;
  /**
   * `chat answer`: the one question this turn answers, already flipped to
   * `answered` before acceptance. The free-text reply path then leaves every
   * other open question alone rather than answering it with the same text.
   */
  answeringQuestionId?: string;
}

async function acceptConversationTurn(
  ...args: Parameters<typeof admitConversationTurn>
): ReturnType<typeof admitConversationTurn> {
  const [state] = args;
  if (!state.acceptingTurns) throw httpError(503, "AmpleFile is closing and cannot accept another turn.");
  // An acceptance already past this check finishes before close() drains
  // turns, so its turn is drained too rather than dispatched afterwards and
  // left running unseen.
  const acceptance = admitConversationTurn(...args);
  state.turnAcceptances.add(acceptance);
  try {
    return await acceptance;
  } finally {
    state.turnAcceptances.delete(acceptance);
  }
}

async function admitConversationTurn(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string; name?: string },
  conversationId: string,
  input: {
    content: string;
    contextPaths: string[];
    /** `system` marks turns app code dispatches (automation chat hops). */
    actorKind: "assistant" | "cli" | "renderer" | "system";
    /** Management-scope reference attachments; never used for Connected Folder Chats. */
    ampleFileAgentAttachments?: AmpleFileAgentAttachmentRef[];
    /** Previous needs-you request whose audit trail this reply continues. */
    continuedFromAmpleFileAgentTaskId?: string;
    /** An automation's chat or agent step: its turn learns that no one is watching and how to report. */
    automationSource?: { automationId: string; title: string };
    /** Stable caller identity. Replays with the same input return the original acceptance. */
    requestId?: string;
    /** Stable optimistic message identity supplied by renderer clients. */
    userMessageId?: string;
    /** Host-composed selected reports already present in this continuation message. */
    releasedChildTaskIds?: string[];
    /** Which durable request this turn creates or joins (docs/collaboration-contract.md). */
    request?: AcceptedTurnRequestInput;
    /** Connected Folder Workers the person addressed with @; registered ids, never this scope's own. */
    addressedConnectedFolderIds?: string[];
  },
): Promise<{ message: { id: string; role: "user"; content: string; createdAt: string; attachments?: ChatMessageAttachmentRef[] }; taskId: string; replayed: boolean }> {
  const turnKey = clientKey(connectedFolder.id, conversationId);
  await yieldBackgroundCompaction(state, turnKey);
  const fileAttachments = connectedFolder.id === ampleFileAgentScopeId ? [] : contextPathAttachments(connectedFolder.connectedFolderRoot, input.contextPaths);
  const attachmentFields = fileAttachments.length ? { attachments: fileAttachments } : {};
  const existing = await readConversationSummary(connectedFolder.connectedFolderRoot, conversationId);
  if (!existing) throw notFound("Conversation not found.");
  const requestId = turnIdentity(input.requestId ?? `request-${randomUUID()}`, "request id");
  const requestDigest = assistantTurnRequestDigest(input);
  const prior = state.turnStore.findRequest(connectedFolder.id, conversationId, requestId);
  let durable: AmpleFileDurableTurnRecord | null = null;
  if (prior) {
    if (prior.requestDigest !== requestDigest) throw httpError(409, "This turn request id was already used for different input.");
    if (!prior.userMessagePersisted) {
      if (state.runningTurns.has(turnKey)) throw httpError(409, "This turn is still being accepted.");
      durable = await state.turnStore.resumeUnpersisted(prior.turnId);
      if (!durable || durable.userMessagePersisted) throw httpError(409, "This turn can no longer be resumed safely.");
      state.settledTurns.delete(prior.turnId);
    } else {
      const messages = await readConversation(connectedFolder.connectedFolderRoot, conversationId);
      const persisted = messages.find((candidate) => candidate.id === prior.userMessageId && candidate.role === "user");
      return {
        message: persisted
          ? { id: persisted.id, role: "user", content: persisted.content, createdAt: persisted.createdAt, ...(persisted.attachments?.length ? { attachments: persisted.attachments } : {}) }
          : { id: prior.userMessageId, role: "user", content: input.content, createdAt: prior.userMessageCreatedAt, ...attachmentFields },
        taskId: prior.turnId,
        replayed: true,
      };
    }
  }
  if (existing.archivedAt) throw httpError(409, "Restore this Chat before sending another message.");
  if (existing.snoozedUntil && Date.parse(existing.snoozedUntil) > Date.now()) {
    throw httpError(409, "Resume this Chat before sending another message.");
  }
  assertNoCapabilityMutationForTurn(state, connectedFolder.id);
  if (state.compactingConversations.has(turnKey)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  if (state.runningTurns.has(turnKey)) throw httpError(409, "Wait for the current agent turn to finish.");
  if (input.request?.joinRequestId) {
    try { state.requests.assertCanContinue(input.request.joinRequestId); }
    catch (error) { throw requestRefusal(error); }
  }
  // A delegated child is refused by name before anything durable exists for
  // it: the parent must still be accepting, and every request bound is
  // checked here rather than after a turn was already accepted.
  if (input.request?.parentTaskId && !durable) {
    try {
      state.requests.assertCanAddChild(input.request.parentTaskId);
    } catch (error) {
      throw requestRefusal(error);
    }
  }
  // The summary read above can overlap a completed deletion. Recheck the
  // transcript synchronously at admission so accepting a stale send cannot
  // recreate the Chat after its recoverable copy has moved into Recently deleted.
  if (!existsSync(join(conversationsDir(connectedFolder.connectedFolderRoot), `${conversationId}.jsonl`))) {
    throw notFound("Conversation not found.");
  }
  state.runningTurns.add(turnKey);
  // Clear the settled turn's retained stream state in the same synchronous
  // admission step that marks this Chat running. A reconnect can never observe
  // `running: true` paired with the previous reply's text.
  resetChatEventTurn(state, turnKey);
  const userMessageId = turnIdentity(input.userMessageId ?? `message-${randomUUID()}`, "user message id");
  const userMessageCreatedAt = new Date().toISOString();
  try {
    if (durable) {
      // The durable reservation was reopened above after an explicit retry.
    } else {
      const accepted = await state.turnStore.accept({
        requestId,
        requestDigest,
        userMessageId,
        userMessageCreatedAt,
        connectedFolderId: connectedFolder.id,
        conversationId,
        actorKind: input.actorKind,
      });
      if (accepted.replayed) {
        state.runningTurns.delete(turnKey);
        return {
          message: { id: accepted.record.userMessageId, role: "user", content: input.content, createdAt: accepted.record.userMessageCreatedAt, ...attachmentFields },
          taskId: accepted.record.turnId,
          replayed: true,
        };
      }
      durable = accepted.record;
    }
  } catch (error) {
    state.runningTurns.delete(turnKey);
    if (error instanceof AmpleFileTurnReplayConflictError) throw httpError(409, error.message);
    throw error;
  }
  if (!durable) throw new Error("Turn reservation was not created.");
  const task = state.kernel.startTask({
    id: durable.turnId,
    kind: "assistant_turn",
    connectedFolderId: connectedFolder.id,
    conversationId,
    actor: { kind: input.actorKind, cwd: connectedFolder.connectedFolderRoot, connectedFolderId: connectedFolder.id, conversationId },
  });
  state.activeTurnTasks.set(task.id, { connectedFolderId: connectedFolder.id, conversationId });
  state.activeTurnIdsByKey.set(turnKey, task.id);
  publishControlHint(state, "activity");
  const ampleFileAgentAttachments = connectedFolder.id === ampleFileAgentScopeId
    ? input.ampleFileAgentAttachments ?? []
    : undefined;
  const message = {
    id: durable.userMessageId,
    role: "user" as const,
    content: input.content,
    ...(input.actorKind === "system" && input.request?.joinRequestId ? { kind: "assistant_continuation" as const } : {}),
    createdAt: durable.userMessageCreatedAt,
    turnId: task.id,
    requestId,
    ...(ampleFileAgentAttachments?.length
      ? { attachments: ampleFileAgentAttachments.map((ref) => ({ kind: ref.kind, target: ref.target, name: ref.name })) }
      : attachmentFields),
  };
  let answeredQuestionIds: string[] = [];
  try {
    // Every accepted turn belongs to exactly one request record. The
    // record is created before the user message lands so a refused child
    // never leaves a message behind; a failure here rolls back with the rest.
    const lineage = await recordAcceptedTurnRequest(state, connectedFolder, conversationId, task.id, input, ampleFileAgentAttachments);
    answeredQuestionIds = lineage.answers;
    await appendMessage(connectedFolder.connectedFolderRoot, conversationId, message);
    await state.turnStore.markRunning(task.id);
    await state.requests.markTurnRunning(task.id);
    // A person's free-text reply is a supported way to answer: once
    // the message is the transcript's, it answers each open question that
    // was waiting on the person and is that answer's one continuation.
    await answerPersonQuestionsWithReply(state, lineage.answers, task.id, input.content);
    if (input.request?.joinRequestId && input.releasedChildTaskIds?.length) {
      await state.requests.noteChildDelivery(input.request.joinRequestId, input.releasedChildTaskIds);
    }
  } catch (error) {
    state.runningTurns.delete(turnKey);
    state.activeTurnTasks.delete(task.id);
    state.cancelledTurnTasks.delete(task.id);
    state.activeTurnIdsByKey.delete(turnKey);
    state.kernel.finishTask(task.id);
    publishControlHint(state, "activity");
    const detail = error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError
      ? error.message
      : "The accepted user message could not be persisted.";
    await state.turnStore.settle(task.id, { status: "failed", error: detail }).catch(() => undefined);
    await state.requests.settleTurn(task.id, { status: "failed", error: detail }).catch(() => undefined);
    broadcast(state, turnKey, turnStateEvent(conversationId, false));
    throw requestRefusal(error);
  }
  const answeredQuestionId = input.request?.answeringQuestionId ?? answeredQuestionIds[0];
  // A live surface may re-read the transcript on this transition. Publish it
  // only after its accepted user message is durable, including answer turns.
  broadcast(state, turnKey, turnStateEvent(conversationId, true));
  const turn = runAgentTurn(
    state,
    connectedFolder.id,
    connectedFolder.connectedFolderRoot,
    conversationId,
    input.content,
    input.contextPaths,
    task.id,
    {
      ...(ampleFileAgentAttachments ? { ampleFileAgentAttachments } : {}),
      ...(input.request?.parentTaskId ? { parentTaskId: input.request.parentTaskId } : {}),
      ...(input.request?.assignment !== undefined ? { assignment: input.request.assignment } : {}),
      // The continuation's own link to the question it answers, built
      // by the host rather than read back out of the travelling transcript:
      // `chat answer` names the question, and a person's free-text reply
      // answers whichever of this request's questions were waiting on them.
      ...(answeredQuestionId ? { answeredQuestionId } : {}),
      ...(input.addressedConnectedFolderIds?.length ? { addressedConnectedFolderIds: input.addressedConnectedFolderIds } : {}),
      ...(input.automationSource ? { automation: { title: input.automationSource.title } } : {}),
    },
  );
  state.activeTurnPromises.add(turn);
  void turn.then(
    () => state.activeTurnPromises.delete(turn),
    (error) => {
      state.activeTurnPromises.delete(turn);
      console.error(`Accepted turn escaped its settlement path: ${errorMessage(error)}`);
    },
  );
  return { message, taskId: task.id, replayed: false };
}

/**
 * A request bound or lineage refusal reaches the caller verbatim as a
 * conflict, so the limit's own text — number and Settings section — is what
 * the person or agent reads. Anything else passes through unchanged.
 */
function requestRefusal(error: unknown): unknown {
  if (error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError) {
    return httpError(409, error.message);
  }
  return error;
}

/**
 * Creates or joins the durable request record for one accepted turn. Kind
 * and surface default from the scope and actor when the caller names none:
 *
 *   AmpleFile Agent scope, renderer                    → management / popover
 *   AmpleFile Agent scope, cli                         → management / cli
 *   AmpleFile Agent scope, system (automation agent hop)   → automation / system
 *   Connected Folder scope, system (automation chat hop)        → automation / system
 *   Connected Folder scope, cli                              → cli / cli
 *   Connected Folder scope, assistant (renderer Connected Folder Chat)  → Connected Folder / renderer
 *
 * A child of an explicit parent keeps the parent's root; a needs-you reply
 * joins its earlier request instead of copying its trail into a second one.
 */
async function recordAcceptedTurnRequest(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string; name?: string },
  conversationId: string,
  taskId: string,
  input: {
    content: string;
    actorKind: "assistant" | "cli" | "renderer" | "system";
    continuedFromAmpleFileAgentTaskId?: string;
    request?: AcceptedTurnRequestInput;
  },
  ampleFileAgentAttachments: AmpleFileAgentAttachmentRef[] | undefined,
): Promise<{ record: AmpleFileRequestRecord; answers: string[] }> {
  const isAmpleFileAgent = connectedFolder.id === ampleFileAgentScopeId;
  // This Chat's newest request is waiting on the person and no parent was
  // named: the reply joins that request rather than opening a second root,
  // whether the caller named the request it continues or not.
  const pending = input.request?.parentTaskId || input.request?.answeringQuestionId
    ? null
    : pendingPersonQuestions(state, conversationId, isAmpleFileAgent ? {} : { connectedFolderId: connectedFolder.id });
  const joinRequestId = input.request?.joinRequestId ?? pending?.requestId;
  const answers = pending && pending.requestId === joinRequestId ? pending.questionIds : [];
  const request: AcceptedTurnRequestInput | undefined = joinRequestId
    ? { ...input.request, joinRequestId }
    : input.request;
  input = { ...input, request };
  const owner = isAmpleFileAgent
    ? { conversationId }
    : { connectedFolderId: connectedFolder.id, ...(connectedFolder.name ? { connectedFolderName: connectedFolder.name } : {}), conversationId };
  const kind: AmpleFileRequestCreatableKind = input.request?.kind
    ?? (isAmpleFileAgent
      ? (input.actorKind === "system" ? "automation" : "agent")
      : input.actorKind === "system"
        ? "automation"
        : input.actorKind === "cli"
          ? "cli"
          : "connected-folder");
  const surface: AmpleFileRequestSurface = input.request?.surface
    ?? (input.actorKind === "system"
      ? "system"
      : input.actorKind === "cli"
        ? "cli"
        : isAmpleFileAgent
          ? "popover"
          : "renderer");
  const attachments = ampleFileAgentAttachments ?? [];
  const record = input.request?.joinRequestId
    ? await state.requests.joinTurn({
      requestId: input.request.joinRequestId,
      taskId,
      role: "continuation",
      content: input.content,
      attachments,
    })
    : input.request?.parentTaskId
      ? await state.requests.beginChild({
        parentTaskId: input.request.parentTaskId,
        kind,
        owner,
        surface,
        taskId,
        content: input.content,
        attachments,
      })
      : await state.requests.beginRoot({
        kind,
        owner,
        surface,
        taskId,
        content: input.content,
        attachments,
        ...(input.continuedFromAmpleFileAgentTaskId ? { continuedFromTaskId: input.continuedFromAmpleFileAgentTaskId } : {}),
      });
  // A retried acceptance whose earlier attempt could not persist its message
  // reopens the same turn: a task id belongs to exactly one request.
  const turn = record.turns.find((candidate) => candidate.taskId === taskId);
  if (turn && turn.state !== "accepted" && turn.state !== "running") {
    return { record: (await state.requests.reopenTurn(taskId)) ?? record, answers };
  }
  return { record, answers };
}

/**
 * The open questions addressed to the person on this Chat's newest request,
 * if it is waiting on them. Scoped to the owner: a conversation id lives in
 * the Connected Folder's folder and travels with it, so two registered Connected Folders can hold the
 * same id and a reply must never join the other one's request.
 */
function pendingPersonQuestions(
  state: LocalApiState,
  conversationId: string,
  owner: { connectedFolderId?: string },
): { requestId: string; questionIds: string[] } | null {
  const latest = state.requests.latestForConversation(conversationId, owner);
  if (!latest || latest.state !== "waiting") return null;
  const open = state.requests.questions(latest.requestId)
    .filter((question) => question.state === "open" && question.respondent === "person");
  return open.length ? { requestId: latest.requestId, questionIds: open.map((question) => question.questionId) } : null;
}

/**
 * Records the person's reply as the one answer to each question it was
 * waiting on and links this turn as that answer's continuation. Attribution
 * only: a question that can no longer take an answer (expired, withdrawn,
 * answered meanwhile) is left as it is, and the turn still runs.
 */
async function answerPersonQuestionsWithReply(state: LocalApiState, questionIds: string[], taskId: string, content: string): Promise<void> {
  const answer = Buffer.byteLength(content, "utf8") > ampleFileRequestLimits.maxAnswerTextBytes
    ? Buffer.from(content, "utf8").subarray(0, ampleFileRequestLimits.maxAnswerTextBytes).toString("utf8").replace(/\uFFFD+$/u, "")
    : content;
  for (const questionId of questionIds) {
    try {
      await state.requests.answer({ questionId, answer });
      await state.requests.linkContinuation(questionId, taskId);
    } catch (error) {
      console.warn(`A reply could not be recorded as the answer to question ${questionId}: ${errorMessage(error)}`);
    }
  }
}

/**
 * Delivers a message into the Chat's running turn through Pi's steering queue
 * and records it in the transcript as part of that turn. When no turn is
 * running (or it settles first) the caller receives 409 and sends normally;
 * nothing is appended in that case.
 */
async function steerConversationTurn(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  conversationId: string,
  input: { content: string; requestId?: string; userMessageId?: string },
): Promise<{ message: ChatMessage; taskId: string; replayed: boolean }> {
  const key = clientKey(connectedFolder.id, conversationId);
  const taskId = state.activeTurnIdsByKey.get(key);
  const client = state.clients.get(key);
  if (!taskId || !client || !state.runningTurns.has(key)) {
    throw httpError(409, "No turn is running in this Chat; send the message normally.");
  }
  const requestId = turnIdentity(input.requestId ?? `steer-${randomUUID()}`, "request id");
  const replayKey = `${key}\u0000${requestId}`;
  const prior = state.steeredMessages.get(replayKey);
  if (prior) return { message: prior, taskId, replayed: true };
  const inFlight = state.steeringInFlight.get(replayKey);
  if (inFlight) return { message: await inFlight, taskId, replayed: true };
  const delivery = deliverSteer(state, connectedFolder, conversationId, client, taskId, requestId, replayKey, input);
  state.steeringInFlight.set(replayKey, delivery);
  try {
    return { message: await delivery, taskId, replayed: false };
  } finally {
    state.steeringInFlight.delete(replayKey);
  }
}

async function deliverSteer(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  conversationId: string,
  client: PiConversationClient,
  taskId: string,
  requestId: string,
  replayKey: string,
  input: { content: string; userMessageId?: string },
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: turnIdentity(input.userMessageId ?? `message-${randomUUID()}`, "user message id"),
    role: "user",
    content: input.content,
    createdAt: new Date().toISOString(),
    turnId: taskId,
    requestId,
    delivery: "steer",
  };
  try {
    await client.steer(input.content);
  } catch (error) {
    if (isPiTurnNotRunningError(error)) throw httpError(409, errorMessage(error));
    throw error;
  }
  await appendMessage(connectedFolder.connectedFolderRoot, conversationId, message);
  state.steeredMessages.set(replayKey, message);
  if (state.steeredMessages.size > maxRememberedSteeredMessages) {
    const oldest = state.steeredMessages.keys().next().value;
    if (oldest !== undefined) state.steeredMessages.delete(oldest);
  }
  broadcast(state, streamKey(connectedFolder.id, conversationId), {
    type: "status",
    conversationId,
    message: "Your message will reach the agent after its current step.",
  });
  return message;
}

const maxRememberedSteeredMessages = 500;

function assistantTurnRequestDigest(input: {
  content: string;
  contextPaths: string[];
  ampleFileAgentAttachments?: AmpleFileAgentAttachmentRef[];
  actorKind?: string;
  continuedFromAmpleFileAgentTaskId?: string;
}): string {
  // Addressed Workers are deliberately outside the digest: they are a hint for
  // this turn's context, and a retry must replay even if one of them was
  // removed in between.
  return createHash("sha256").update(JSON.stringify({
    content: input.content,
    contextPaths: input.contextPaths,
    // Kept constant so digests from before the selected path was dropped still match.
    selectedPath: null,
    actorKind: input.actorKind ?? null,
    continuedFromAmpleFileAgentTaskId: input.continuedFromAmpleFileAgentTaskId ?? null,
    ampleFileAgentAttachments: (input.ampleFileAgentAttachments ?? []).map((attachment) => ({
      kind: attachment.kind,
      target: attachment.target,
      name: attachment.name,
    })),
  })).digest("hex");
}

function optionalTurnIdentity(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : turnIdentity(value, label);
}

function turnIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw badRequest(`${label} is invalid.`);
  }
  return value;
}

function conversationIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw badRequest("conversationId is invalid.");
  }
  return value;
}

async function createConnectedFolderInternal(state: LocalApiState, name: string): Promise<ConnectedFolderSummary> {
  const connectedFolder = await createManagedConnectedFolder(name, state.connectedFolderBase);
  state.connectedFolderTrustAuthority.grant(connectedFolder.connectedFolderRoot);
  await giveStartingColor(state, connectedFolder.id);
  publishControlHint(state, "connected-folders");
  return connectedFolder;
}

async function registerConnectedFolderInternal(state: LocalApiState, rootPath: string, providerHint?: "google-drive"): Promise<ConnectedFolderSummary> {
  const known = new Set((await registeredConnectedFolderOutline()).map((item) => item.id));
  const connectedFolder = await registerLinkedConnectedFolder(rootPath, providerHint);
  state.connectedFolderTrustAuthority.grant(connectedFolder.connectedFolderRoot);
  // A folder that already carried a Connected Folder identity keeps the color it had.
  if (!known.has(connectedFolder.id) && connectedFolder.createdAt === connectedFolder.updatedAt) await giveStartingColor(state, connectedFolder.id);
  // Copy-level note when a suspended automation's missing Connected Folder returns with its
  // portable identity; the automation stays suspended — registration never
  // silently re-arms standing behavior — so a failure to note it is tolerable.
  await state.automations.handleConnectedFolderReRegistered(connectedFolder.id).catch(() => undefined);
  publishControlHint(state, "connected-folders");
  return connectedFolder;
}

/**
 * A new Connected Folder starts in the color the fewest others use, so two rarely
 * share one. Nothing is saved when that is already the color its
 * id picks, and a saved choice always wins. The color is a nicety: failing to
 * save it never fails the creation.
 */
async function giveStartingColor(state: LocalApiState, connectedFolderId: string): Promise<void> {
  try {
    const { customizations } = state.appearance.snapshot();
    if (customizations[connectedFolderId]) return;
    const others = (await registeredConnectedFolderOutline())
      .filter((item) => item.id !== connectedFolderId)
      .map((item) => primaryAccentIdentity(customizations[item.id], defaultConnectedFolderAccent(item.id).hex).referenceHex);
    const hex = startingConnectedFolderAccentHex(connectedFolderId, others);
    if (hex === defaultConnectedFolderAccent(connectedFolderId).hex) return;
    await state.appearance.replaceConnectedFolder(connectedFolderId, { primary: accentIdentityFromHex(hex) });
  } catch {
    // The Connected Folder keeps the color its id picks.
  }
}

/** What a Recently deleted entry can still do, and why when it cannot go back. */
export interface AmpleFileRecentlyDeletedEntryView {
  id: string;
  kind: AmpleFileRecentlyDeletedKind;
  reason: AmpleFileRecentlyDeletedReason;
  connectedFolderId: string;
  connectedFolderName?: string;
  /** skill only: the scope it goes back into. */
  scope?: "everywhere" | "connected-folder";
  originalPath: string;
  name: string;
  sizeBytes: number;
  sizeApproximate?: true;
  deletedAt: string;
  restoreBy: string;
  receiptId: string | null;
  uncovered?: AmpleFileRecentlyDeletedUncoveredPath[];
  held?: { reason: "unreadable"; noticedAt: string };
  /**
   * `in-place` goes back where it came from; `blocked` cannot be brought back
   * right now (or ever, for what older builds kept for Connected Folder
   * apps), and `note` says why.
   */
  restorable: "in-place" | "blocked";
  note?: string;
}

export type AmpleFileRecentlyDeletedRestoreResult =
  /**
   * `safetyCheckpointId` is null when History could not record the restore
   * point. The content is back either way, and the entry is already gone, so
   * reporting the restore as a failure would be a lie that also removes the
   * thing the person would retry from.
   */
  | { kind: "file" | "folder"; entryId: string; connectedFolder: AmpleFileActConnectedFolderRef; path: string; renamed: boolean; safetyCheckpointId: string | null }
  | { kind: "connected-folder"; entryId: string; connectedFolder: AmpleFileActConnectedFolderRef; connectedFolderRoot: string; renamed: boolean }
  /** `workFolder` names the Connected Folder for that scope only; `path` is the restored Skill folder. */
  | { kind: "skill"; entryId: string; scope: "everywhere" | "connected-folder"; connectedFolder?: AmpleFileActConnectedFolderRef; name: string; path: string };

/**
 * Whether an entry can go back where it came from, and the plain reason when
 * it cannot. What older builds kept for Connected Folder apps never goes back:
 * AmpleFile has no apps, so those entries only wait to expire.
 */
async function recentlyDeletedEntryView(
  entry: AmpleFileRecentlyDeletedEntry,
  registered?: ReadonlySet<string>,
): Promise<AmpleFileRecentlyDeletedEntryView> {
  const base: AmpleFileRecentlyDeletedEntryView = {
    id: entry.id,
    kind: entry.kind,
    reason: entry.reason,
    connectedFolderId: entry.connectedFolderId,
    ...(entry.connectedFolderName === undefined ? {} : { connectedFolderName: entry.connectedFolderName }),
    ...(entry.payload.kind === "skill" ? { scope: entry.payload.scope } : {}),
    originalPath: entry.originalPath,
    name: entry.displayName ?? (entry.payload.kind === "tree"
      ? entry.payload.name
      : entry.payload.kind === "skill"
        ? entry.payload.skillName
      : entry.payload.kind === "app-release"
        ? `Release ${entry.payload.displayVersion}`
        : entry.payload.kind === "app-studio" ? "App Studio history" : entry.payload.appId),
    sizeBytes: entry.sizeBytes,
    ...(entry.sizeApproximate ? { sizeApproximate: true as const } : {}),
    deletedAt: entry.deletedAt,
    restoreBy: entry.restoreBy,
    receiptId: entry.receiptId,
    ...(entry.uncovered ? { uncovered: entry.uncovered } : {}),
    ...(entry.held ? { held: entry.held } : {}),
    restorable: "in-place",
  };
  if (entry.kind === "file" || entry.kind === "folder") {
    if (isAmpleFileAgentConversationRecentlyDeletedEntry(entry)) return base;
    const present = registered ? registered.has(entry.connectedFolderId) : Boolean(await getConnectedFolder(entry.connectedFolderId).catch(() => null));
    // A file or folder goes back into its own Connected Folder or nowhere: AmpleFile
    // never guesses another Connected Folder for someone's content.
    return present
      ? base
      : { ...base, restorable: "blocked", note: "The Connected Folder this came from is no longer registered." };
  }
  if (entry.kind === "connected-folder") return base;
  if (entry.kind === "skill") {
    // A Connected Folder Skill goes back only into its own Connected Folder's .pi/skills.
    if (entry.payload.kind !== "skill") return { ...base, restorable: "blocked" };
    if (entry.payload.scope === "everywhere") return base;
    const present = registered ? registered.has(entry.connectedFolderId) : Boolean(await getConnectedFolder(entry.connectedFolderId).catch(() => null));
    return present
      ? base
      : { ...base, restorable: "blocked", note: "The Connected Folder this Skill came from is no longer registered." };
  }
  // Data, Releases, and App Studio history older builds kept for Connected
  // Folder apps: listed until they expire, never restored.
  return { ...base, restorable: "blocked", note: retiredAppEntryNote };
}

/** Why an entry an older build kept for a Connected Folder app cannot come back. */
const retiredAppEntryNote = "AmpleFile no longer has Connected Folder apps, so this cannot be restored. It is deleted when it expires.";

/**
 * Brings one Recently deleted entry back (docs/act-ledger.md).
 * A file or folder returns to its Connected Folder at its original path, renamed when
 * something else took the name, and the restore itself is History-undoable.
 * A Connected Folder's folder returns to the managed base and is re-registered with its
 * portable identity, so its Chats and History come with it. What older
 * builds kept for Connected Folder apps never comes back.
 */
async function restoreRecentlyDeletedEntry(
  state: LocalApiState,
  id: string,
  context: { receiptId: string | null },
): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  if (!ampleFileRecentlyDeletedEntryIdPattern.test(id)) {
    throw new AmpleFileCliError("usage", "That is not a Recently deleted item id.");
  }
  const entry = await state.recentlyDeleted.get(id).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  if (!entry) throw new AmpleFileCliError("notFound", "That item is no longer in Recently deleted.");
  if (entry.kind === "app-storage" || entry.kind === "app-retained" || entry.kind === "app-release" || entry.kind === "app-studio") {
    throw new AmpleFileCliError("conflict", retiredAppEntryNote);
  }
  if (entry.kind === "skill") return restoreRecentlyDeletedSkill(state, entry);
  if (entry.kind === "connected-folder") return restoreRecentlyDeletedConnectedFolder(state, entry);
  if (isAmpleFileAgentConversationRecentlyDeletedEntry(entry)) return restoreAmpleFileAgentConversationRecentlyDeletedEntry(state, entry);
  if (isConnectedFolderConversationRecentlyDeletedEntry(entry)) return restoreConnectedFolderConversationRecentlyDeletedEntry(state, entry);
  const connectedFolder = await getConnectedFolder(entry.connectedFolderId).catch(() => null);
  if (!connectedFolder) {
    throw new AmpleFileCliError(
      "conflict",
      "The Connected Folder this came from is no longer registered, so there is nowhere to put it back. Register that Connected Folder again first.",
    );
  }
  const destination = resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, entry.originalPath);
  const restored = await state.recentlyDeleted.restoreTree(id, { absolutePath: destination }).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  const relativePath = normalizeConnectedFolderRelativePath(relative(connectedFolder.connectedFolderRoot, restored.restoredPath));
  // Restoring is additive, so its own undo is a restore point that removes
  // what came back — the same shape `files add` records. The tree is already
  // back and the entry is already gone by now, so a History failure here is
  // reported as a missing undo point, never as a failed restore: the
  // additive-write rollback helper is the wrong shape, because its rollback
  // would delete exactly the content just restored.
  const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
    deleteOnRestore: [relativePath],
    reason: "post_restore",
    label: `Before restoring ${basename(restored.restoredPath)} from Recently deleted`,
  }).catch(() => null);
  await touchConnectedFolderRoot(connectedFolder.connectedFolderRoot).catch(() => undefined);
  publishControlHint(state, "connected-folders");
  return {
    kind: entry.kind,
    entryId: entry.id,
    connectedFolder: toActConnectedFolderRef(connectedFolder),
    path: relativePath,
    renamed: restored.renamed,
    safetyCheckpointId: safety?.checkpointId ?? null,
  };
}

function isAmpleFileAgentConversationRecentlyDeletedEntry(entry: AmpleFileRecentlyDeletedEntry): boolean {
  return entry.kind === "file"
    && entry.reason === "agent.chat.delete"
    && entry.connectedFolderId === ampleFileAgentScopeId
    && /^\.amplefile\/conversations\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.jsonl$/.test(entry.originalPath);
}

function isConnectedFolderConversationRecentlyDeletedEntry(entry: AmpleFileRecentlyDeletedEntry): boolean {
  return entry.kind === "file"
    && entry.reason === "chats.delete"
    && entry.connectedFolderId !== ampleFileAgentScopeId
    && /^\.amplefile\/conversations\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.jsonl$/.test(entry.originalPath);
}

/**
 * A Worker Chat goes back into its own Connected Folder's `.amplefile/conversations/`
 * under the same transcript name, or nowhere: AmpleFile never guesses another
 * Connected Folder, and never collision-renames a transcript into a different identity.
 */
async function restoreConnectedFolderConversationRecentlyDeletedEntry(
  state: LocalApiState,
  entry: AmpleFileRecentlyDeletedEntry,
): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  const connectedFolder = await getConnectedFolder(entry.connectedFolderId).catch(() => null);
  if (!connectedFolder) {
    throw new AmpleFileCliError(
      "conflict",
      "The folder this Chat came from is no longer registered, so there is nowhere to put it back. Add that folder again first.",
    );
  }
  const conversationId = basename(entry.originalPath, ".jsonl");
  return runActOperation(() => runConversationMutation(state, connectedFolder.id, conversationId, async () => {
    const destination = resolve(connectedFolder.connectedFolderRoot, entry.originalPath);
    if (!pathContainsPath(conversationsDir(connectedFolder.connectedFolderRoot), destination)) {
      throw new AmpleFileCliError("failure", "This Chat recovery item has an invalid destination.");
    }
    if (existsSync(destination)) {
      throw new AmpleFileCliError("conflict", "A Chat with this identity already exists. Remove that Chat before restoring this one.");
    }
    await mkdir(conversationsDir(connectedFolder.connectedFolderRoot), { recursive: true });
    const restored = await state.recentlyDeleted.restoreTree(entry.id, { absolutePath: destination, onConflict: "error" }).catch((error: unknown) => {
      throw recentlyDeletedCliError(error);
    });
    publishControlHint(state, "connected-folders");
    return {
      kind: "file",
      entryId: entry.id,
      connectedFolder: toActConnectedFolderRef(connectedFolder),
      path: `.amplefile/conversations/${basename(restored.restoredPath)}`,
      renamed: restored.renamed,
      // `.amplefile/` is excluded from History capture, so there is no restore point.
      safetyCheckpointId: null,
    };
  }));
}

async function restoreAmpleFileAgentConversationRecentlyDeletedEntry(
  state: LocalApiState,
  entry: AmpleFileRecentlyDeletedEntry,
): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  const root = ampleFileAgentRoot();
  const destination = resolve(root, entry.originalPath);
  if (!pathContainsPath(root, destination)) {
    throw new AmpleFileCliError("failure", "This AmpleFile Agent Chat recovery item has an invalid destination.");
  }
  // A transcript filename is the Chat identity. Unlike ordinary Connected Folder files,
  // collision-renaming it would create an invalid or different conversation,
  // so leave the recovery item intact until the current Chat is removed.
  if (existsSync(destination)) {
    throw new AmpleFileCliError("conflict", "A Chat with this identity already exists. Remove that Chat before restoring this one.");
  }
  const restored = await state.recentlyDeleted.restoreTree(entry.id, { absolutePath: destination, onConflict: "error" }).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  return {
    kind: "file",
    entryId: entry.id,
    connectedFolder: { id: ampleFileAgentScopeId, name: "AmpleFile Agent", connectedFolderRoot: root },
    path: `.amplefile/conversations/${basename(restored.restoredPath)}`,
    renamed: restored.renamed,
    // Management Chats are machine-local and never belong to Connected Folder History.
    safetyCheckpointId: null,
  };
}

/**
 * Removes one imported Skill into Recently deleted (docs/act-ledger.md).
 * `.pi/` and Pi's own folder are outside History, so the whole Skill
 * folder moves there with its scope and its path inside that scope's skills
 * folder, under the same capability fence and client reload as an install.
 * An Everywhere Skill belongs to no Connected Folder; its entry is kept under the
 * AmpleFile Agent's scope id, like that agent's Chats.
 */
async function removeImportedSkill(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  scope: CapabilityScope,
  skillPath: string,
  context: { receiptId: string | null },
): Promise<{ removedPath: string; skillName: string; recentlyDeleted: { entryId: string; restoreBy: string } }> {
  const removed = await runCapabilityMutation(state, connectedFolder, scope, async () =>
    await removePiSkill(connectedFolder.connectedFolderRoot, {
      skillPath,
      scope: scope === "project" ? "project" : "user",
      keep: async (skill) => {
        try {
          return await state.recentlyDeleted.moveTreeToRecentlyDeleted({
            kind: "skill",
            reason: "skills.remove",
            sourcePath: skill.skillDir,
            ...(skill.scope === "project"
              ? { connectedFolderId: connectedFolder.id, connectedFolderName: connectedFolder.name }
              : { connectedFolderId: ampleFileAgentScopeId, connectedFolderName: "Everywhere" }),
            displayName: skill.skillName,
            originalPath: skill.relativePath,
            receiptId: context.receiptId,
            skill: { scope: skill.scope === "project" ? "connected-folder" : "everywhere", skillName: skill.skillName },
          });
        } catch (error) {
          // An error naming an entry means a complete copy already landed there.
          const landed = error instanceof AmpleFileRecentlyDeletedError && error.entryId !== undefined;
          throw new AmpleFileCliError(
            "failure",
            `AmpleFile could not move this Skill to Recently deleted: ${errorMessage(error)}${landed ? "" : " Nothing was removed."}`,
            { cause: error },
          );
        }
      },
    }, state.runtimeProvider));
  return {
    removedPath: removed.removedPath,
    skillName: removed.skillName,
    recentlyDeleted: { entryId: removed.kept.id, restoreBy: removed.kept.restoreBy },
  };
}

/**
 * A removed Skill goes back into the same scope's skills folder at the same
 * path, under the same capability fence and client reload as an install, so
 * the next turn loads it. It never lands beside a Skill Pi already loads under
 * the same name, or over an existing folder: the item stays in Recently
 * deleted until that one is removed.
 */
async function restoreRecentlyDeletedSkill(
  state: LocalApiState,
  entry: AmpleFileRecentlyDeletedEntry,
): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  const payload = entry.payload;
  if (payload.kind !== "skill") throw new AmpleFileCliError("failure", "This Skill recovery item is damaged.");
  let target: { id: string; connectedFolderRoot: string };
  let connectedFolder: ConnectedFolderSummary | null = null;
  if (payload.scope === "connected-folder") {
    connectedFolder = await getConnectedFolder(entry.connectedFolderId).catch(() => null);
    if (!connectedFolder) {
      throw new AmpleFileCliError(
        "conflict",
        "The Connected Folder this Skill came from is no longer registered, so there is nowhere to put it back. Register that Connected Folder again first.",
      );
    }
    target = connectedFolder;
  } else {
    // The same resolution context `tools remove --scope everywhere` uses.
    target = { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentRoot() };
  }
  const restored = await runActOperation(() => runCapabilityMutation(state, target, payload.scope === "connected-folder" ? "project" : "global", async () => {
    try {
      return await restorePiSkill(target.connectedFolderRoot, {
        scope: payload.scope === "connected-folder" ? "project" : "user",
        relativePath: entry.originalPath,
        skillName: payload.skillName,
        putBack: (destination) => state.recentlyDeleted.restoreTree(entry.id, { absolutePath: destination, onConflict: "error" }),
      }, state.runtimeProvider);
    } catch (error) {
      if (error instanceof PiSkillRestoreConflictError) throw new AmpleFileCliError("conflict", error.message, { cause: error });
      if (error instanceof AmpleFileRecentlyDeletedError) throw recentlyDeletedCliError(error);
      throw error;
    }
  }));
  return {
    kind: "skill",
    entryId: entry.id,
    scope: payload.scope,
    ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
    name: payload.skillName,
    path: restored.restored.restoredPath,
  };
}

async function restoreRecentlyDeletedConnectedFolder(state: LocalApiState, entry: AmpleFileRecentlyDeletedEntry): Promise<AmpleFileRecentlyDeletedRestoreResult> {
  // A portable identity that is registered somewhere else is a real conflict:
  // AmpleFile never adopts one Connected Folder's records into another folder.
  if ((await listConnectedFolders()).some((connectedFolder) => connectedFolder.id === entry.connectedFolderId)) {
    throw new AmpleFileCliError(
      "conflict",
      `A Connected Folder with this identity is already registered. Remove that registration before restoring "${entry.connectedFolderName ?? entry.originalPath}".`,
    );
  }
  const restored = await state.recentlyDeleted.restoreTree(entry.id, {
    absolutePath: entry.originalPath,
    stateDirFor: (finalPath) => connectedFolderStateDir(finalPath),
  }).catch((error: unknown) => {
    throw recentlyDeletedCliError(error);
  });
  let connectedFolder: ConnectedFolderSummary;
  try {
    connectedFolder = await registerManagedConnectedFolder(
      restored.restoredPath,
      entry.connectedFolderName ?? basename(restored.restoredPath),
      state.connectedFolderBase,
    );
  } catch (error) {
    // The folder is back on disk with its portable identity; only the
    // registration failed, so say where it is instead of implying it is lost.
    throw new AmpleFileCliError(
      "conflict",
      `The folder is back at ${restored.restoredPath}, but AmpleFile could not register it as a Connected Folder: ${errorMessage(error)} `
        + "Connect Folder in Manage Connected Folders to finish bringing it back.",
      { cause: error },
    );
  }
  state.connectedFolderTrustAuthority.grant(connectedFolder.connectedFolderRoot);
  await state.automations.handleConnectedFolderReRegistered(connectedFolder.id).catch(() => undefined);
  publishControlHint(state, "connected-folders");
  return {
    kind: "connected-folder",
    entryId: entry.id,
    connectedFolder: toActConnectedFolderRef(connectedFolder),
    connectedFolderRoot: connectedFolder.connectedFolderRoot,
    renamed: restored.renamed,
  };
}

/** Store failures become the act lane's typed errors; nothing leaks a stack. */
function recentlyDeletedCliError(error: unknown): AmpleFileCliError {
  if (!(error instanceof AmpleFileRecentlyDeletedError)) {
    return new AmpleFileCliError("failure", errorMessage(error), { cause: error });
  }
  const code = error.code === "NOT_FOUND"
    ? "notFound"
    : error.code === "INPUT_INVALID"
      ? "usage"
      : error.code === "HELD"
        ? "conflict"
        : "failure";
  return new AmpleFileCliError(code, error.message, { cause: error });
}

/**
 * The one connected-folder-removal path, shared by the desktop DELETE route, the
 * `connected-folder.delete-folder` prepared act behind `connected-folders delete`, and the act
 * facade's `connected-folders unregister`:
 * automation suspension, the durable removal intent, runtime-authorization
 * revocation with the crash-safe pending result, and finalization. A linked registration removal always leaves the
 * folder and its portable `.amplefile/` identity in place; a managed Connected Folder
 * deletes its folder tree unless the caller passes the preserve disposition
 * (the act lane's `connected-folders unregister`), which records an intent that provably
 * holds no deletion authority.
 */
/**
 * The managed-deletion seam of docs/act-ledger.md: the folder the
 * removal machinery has already claimed by exact identity is *moved* into
 * Recently deleted with the Connected Folder's machine-local History state, never
 * erased. Everything about the claim-verified removal above it is unchanged —
 * this only replaces the final erase.
 *
 * An injected `removeClaimedManagedRoot`/`removeConnectedFolderState` still wins, so
 * the removal-atomicity failure-injection seams keep working, and a preserve
 * removal (`connected-folders unregister`) never reaches the claim path at all: its
 * state directory is removed exactly as before.
 */
function managedConnectedFolderRemovalIo(
  recentlyDeleted: AmpleFileRecentlyDeletedStore,
  overrides: Partial<ConnectedFolderRemovalIo>,
  context: { connectedFolderId: string; connectedFolderRoot: string; connectedFolderName?: string; receiptId: string | null; managedDeletion: boolean },
): { io: Partial<ConnectedFolderRemovalIo>; entry: () => AmpleFileRecentlyDeletedEntry | null } {
  let entry: AmpleFileRecentlyDeletedEntry | null = null;
  const io: Partial<ConnectedFolderRemovalIo> = {
    ...overrides,
    removeClaimedManagedRoot: overrides.removeClaimedManagedRoot ?? (async (claimPath) => {
      const connectedFolderName = context.connectedFolderName ?? await claimedConnectedFolderName(claimPath) ?? basename(context.connectedFolderRoot);
      entry = await recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: "connected-folder",
        reason: "connected-folders.delete",
        sourcePath: claimPath,
        connectedFolderId: context.connectedFolderId,
        connectedFolderName,
        originalPath: context.connectedFolderRoot,
        receiptId: context.receiptId,
        stateDirPath: connectedFolderStateDir(context.connectedFolderRoot),
      });
    }),
    removeConnectedFolderState: async (connectedFolderRoot) => {
      // The folder's move already carried the History state into the entry.
      if (entry) return;
      if (overrides.removeConnectedFolderState) return overrides.removeConnectedFolderState(connectedFolderRoot);
      // On restart the claimed folder may already have reached Recently
      // deleted while its History directory is still at the old state path.
      // Recover that second move before committing removal; never erase the
      // remaining History when its destination cannot be proved.
      if (context.managedDeletion && !overrides.removeClaimedManagedRoot && existsSync(connectedFolderStateDir(connectedFolderRoot))) {
        const listing = await recentlyDeleted.list();
        const matching = listing.entries.filter((item) => item.kind === "connected-folder"
          && item.reason === "connected-folders.delete"
          && item.connectedFolderId === context.connectedFolderId
          && connectedFolderRootKey(item.originalPath) === connectedFolderRootKey(context.connectedFolderRoot));
        if (matching.length !== 1 || listing.damaged.length) {
          throw new Error("The deleted Connected Folder's History could not be matched to one intact Recently deleted entry. It was kept at its original state path.");
        }
        entry = await recentlyDeleted.attachConnectedFolderState(matching[0]!.id, connectedFolderStateDir(connectedFolderRoot));
        return;
      }
      await rm(connectedFolderStateDir(connectedFolderRoot), { recursive: true, force: true });
    },
  };
  return { io, entry: () => entry };
}

/** Best-effort display name for a folder already claimed for removal. */
async function claimedConnectedFolderName(claimPath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(claimPath, ".amplefile", "connected-folder.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

async function removeConnectedFolderRegistrationInternal(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  options: { managedFolderDisposition?: "delete" | "preserve"; receiptId?: string | null } = {},
): Promise<ConnectedFolderRemovalResult & {
  recentlyDeleted: { entryId: string; restoreBy: string } | null;
}> {
  // A preserve removal keeps the folder, so it keeps the plain state-directory
  // removal; a delete removal sends the claimed folder to Recently deleted.
  const removal = options.managedFolderDisposition === "preserve"
    ? { io: state.connectedFolderRemovalIo, entry: () => null as AmpleFileRecentlyDeletedEntry | null }
    : managedConnectedFolderRemovalIo(state.recentlyDeleted, state.connectedFolderRemovalIo, {
      connectedFolderId: connectedFolder.id,
      connectedFolderRoot: connectedFolder.connectedFolderRoot,
      connectedFolderName: connectedFolder.name,
      receiptId: options.receiptId ?? null,
      managedDeletion: connectedFolder.location.storage === "managed",
    });
  const withRecentlyDeleted = <T extends ConnectedFolderRemovalResult>(result: T): T & {
    recentlyDeleted: { entryId: string; restoreBy: string } | null;
  } => {
    const entry = removal.entry();
    return {
      ...result,
      recentlyDeleted: entry ? { entryId: entry.id, restoreBy: entry.restoreBy } : null,
    };
  };
  return runConnectedFolderMutations(state, [connectedFolder.id], () => runSettledConnectedFolderDeletion(state, connectedFolder.id, async () => {
    try {
      const intent = await beginConnectedFolderRemoval(connectedFolder.id, state.connectedFolderBase, removal.io, {
        ...(options.managedFolderDisposition ? { folderDisposition: options.managedFolderDisposition } : {}),
      });
      state.connectedFolderTrustAuthority.revoke(connectedFolder.connectedFolderRoot);
      state.connectedFolderIdsByRoot.delete(connectedFolderRootKey(connectedFolder.connectedFolderRoot));
      await invalidateAmpleFileClients(state, connectedFolder.id);
      closeConnectedFolderStreams(state, connectedFolder.id);
      for (const request of [...state.extensionRequests.values()]) {
        if (request.connectedFolderRoot !== connectedFolder.connectedFolderRoot) continue;
        state.extensionUi.cancel(request.id);
        state.extensionRequests.delete(request.id);
      }
      // Enabled automations referencing this Connected Folder suspend (their
      // active runs stop) at the same revocation moment. Suspension
      // failing leaves the durable intent pending — startup retries the
      // cascade.
      try {
        await state.automations.handleConnectedFolderRemoved(connectedFolder.id);
      } catch {
        return withRecentlyDeleted(await connectedFolderRemovalPendingResult(intent));
      }
      const result = await finalizeConnectedFolderRemoval(intent.connectedFolderId, removal.io);
      if (!result.cleanupPending) await state.appearance.removeConnectedFolder(connectedFolder.id);
      return withRecentlyDeleted(result);
    } finally {
      publishControlHint(state, "connected-folders");
    }
  }), { requiredConnectedFolderIds: [connectedFolder.id] });
}

/**
 * The per–Connected Folder client that carries bounded inference (the file
 * manager's folder suggestions). It is streamed, never prompted, so no Chat is
 * created and no transcript exists; the name only keeps it separate from the
 * Connected Folder's real conversations.
 */
const ampleFileInferenceConversationId = "amplefile.inference";

/**
 * The act facade is the CLI act lane's in-process authority. Every method
 * reuses the same route internals as the renderer (turn acceptance, trust
 * grants, History-checkpointed additions), so a CLI-initiated action obeys
 * identical conflict, trust, and persistence rules. Registering a folder
 * through the act lane deliberately has no renderer folder-picker grant:
 * possession of the per-launch act token is that caller's authorization.
 */
function createAmpleFileActFacade(state: LocalApiState): AmpleFileActFacade {
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
      if (resuming && question.asynchronous && question.answer !== answer) throw new AmpleFileCliError("conflict", "That question already has a different recorded answer. Retry the same answer to continue it.");
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
        await state.requests.recordAction(input.parentTaskId, {
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
      const result = await runActOperation(() => runHistoryRestore(state, connectedFolder.id, () => restoreConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, input.checkpointId)));
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
        const result = await runHistoryRestore(state, connectedFolder.id, () => restoreFileVersion(connectedFolder.connectedFolderRoot, input.path, input.version.trim()));
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
      await state.requests.recordAction(input.parentTaskId, {
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
      await state.requests.recordAction(input.parentTaskId, {
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
      await state.requests.recordAction(input.parentTaskId, {
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
function ampleFileAgentScope(state?: LocalApiState): { id: string; rootPath: string } {
  if (state) assertAmpleFileAgentInstructionsReady(state);
  return { id: ampleFileAgentScopeId, rootPath: ampleFileAgentRoot() };
}

function assertAmpleFileAgentInstructionsReady(state: LocalApiState): void {
  if (!state.ampleFileAgentInstructionsError) return;
  throw new AmpleFileCliError(
    "unavailable",
    "The AmpleFile Agent is unavailable because AmpleFile could not prepare its required instructions. Restart AmpleFile; if this continues, check the app-data AmpleFile Agent folder.",
  );
}

/** HTTP mirror of the fail-closed instructions gate: 503 instead of a CLI error. */
function assertAmpleFileAgentReadyForRoutes(state: LocalApiState): void {
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

/**
 * A Worker Chat's transcript is portable `.amplefile/` metadata, which History
 * never captures, so deletion moves the exact validated transcript into
 * Recently deleted. The Pi session stays in machine-local state, so a restored
 * Chat resumes where it was. It deliberately never accepts a path.
 */
async function deleteConnectedFolderConversation(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  conversationId: string,
  context: { receiptId: string | null },
): Promise<{ conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } }> {
  const key = clientKey(connectedFolder.id, conversationId);
  await yieldBackgroundCompaction(state, key);
  changeQueuedMessage(state, key, null);
  if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current turn to finish.");
  if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  // The same conflict fence compaction uses: a transcript move must not race
  // a new turn, rename, lifecycle change, or real compaction.
  state.compactingConversations.add(key);
  try {
    const summary = await readConversationSummary(connectedFolder.connectedFolderRoot, conversationId).catch((error) => {
      throw badRequest(errorMessage(error));
    });
    if (!summary) throw notFound("Conversation not found.");
    if (state.requests.list().some((request) =>
      request.owner.connectedFolderId === connectedFolder.id
      && request.owner.conversationId === conversationId
      && requestHasUnsettledWork(state, request))) {
      throw httpError(409, "Finish or stop this Chat's outstanding work before deleting it.");
    }
    await state.clients.get(key)?.stop();
    // `readConversationSummary` validated the id before this join.
    const relativePath = `.amplefile/conversations/${conversationId}.jsonl`;
    const sourcePath = join(conversationsDir(connectedFolder.connectedFolderRoot), `${conversationId}.jsonl`);
    let entry: AmpleFileRecentlyDeletedEntry;
    try {
      entry = await state.recentlyDeleted.moveTreeToRecentlyDeleted({
        kind: "file",
        reason: "chats.delete",
        sourcePath,
        connectedFolderId: connectedFolder.id,
        connectedFolderName: connectedFolder.name,
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

/** Reserve every transcript mutation through its final write, including CLI writes and restores. */
async function runConversationMutation<T>(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = clientKey(connectedFolderId, conversationId);
  if (state.runningTurns.has(key)) throw httpError(409, "Wait for the current turn to finish.");
  if (state.compactingConversations.has(key)) throw httpError(409, "Wait for the current Chat compaction to finish.");
  state.compactingConversations.add(key);
  try {
    return await operation();
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

/** The person-facing sentence for a bound a request stopped at; it names the Settings section like every refusal. */
function requestLimitStopMessage(limit: AmpleFileRequestLimitName): string {
  const shows = `${ampleFileRequestLimitsSection} shows this number.`;
  switch (limit) {
    case "providerBudget":
      return `This request reached its model spending limit, so AmpleFile stopped it. ${shows}`;
    default:
      return `This request reached one of its limits, so AmpleFile stopped it. ${shows}`;
  }
}



/**
 * Request-level stop. Aborting the request's own turn does not implicitly
 * stop a review already running in a Connected Folder — only turns recorded under this
 * request are aborted, each explicitly, and the result names every turn it
 * touched. The stop cascades through the whole owned graph: every descendant
 * request is marked, its open questions are withdrawn, and its running turn
 * is cancelled (docs/collaboration-contract.md).
 */
async function stopAmpleFileAgentRequest(
  state: LocalApiState,
  taskId: string,
): Promise<{ taskId: string; ampleFileAgentAborted: boolean; children: Array<{ taskId: string; conversationId: string; connectedFolderId: string; aborted: boolean }> }> {
  const record = state.requests.byTaskId(taskId);
  if (!record) {
    throw new AmpleFileCliError("notFound", `Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
  }
  const scopeId = record.owner.connectedFolderId ?? ampleFileAgentScopeId;
  const ownTurn = record.turns.at(-1)!;
  const ampleFileAgentWasRunning = turnStatusFor(state, scopeId, ownTurn.taskId).state === "running";
  // The whole graph below this request, not only a root's: `agent stop`
  // takes any task id, so a mid-graph request must still close everything it
  // handed on (docs/collaboration-contract.md).
  const descendants = state.requests.subtree(record.requestId);
  const runningChildren = descendants.flatMap((descendant) => {
    if (descendant.owner.connectedFolderId === undefined) return [];
    const turn = descendant.turns.at(-1)!;
    return turnStatusFor(state, descendant.owner.connectedFolderId, turn.taskId).state === "running"
      ? [{ taskId: turn.taskId, conversationId: descendant.owner.conversationId, connectedFolderId: descendant.owner.connectedFolderId, requestId: descendant.requestId }]
      : [];
  });
  // A stop reaches everything still open under this request, not only the
  // turns running this instant: a child whose turn ended while waiting on an
  // answer is closed too, so a late `chat answer` is refused and no
  // continuation turn can follow (docs/collaboration-contract.md).
  const openBelow = !isAmpleFileRequestTerminalState(record.state)
    || descendants.some((descendant) => !isAmpleFileRequestTerminalState(descendant.state));
  if (ampleFileAgentWasRunning || runningChildren.length || openBelow) {
    await state.requests.markStopRequested(record.requestId);
    await state.requests.cancelQuestions(record.requestId, "stopped");
    for (const descendant of descendants) {
      await state.requests.markStopRequested(descendant.requestId);
      await state.requests.cancelQuestions(descendant.requestId, "stopped");
    }
  }
  // Stop reaches every background job of this request and the graph below
  // it: SIGTERM to each process group, then SIGKILL (docs/background-jobs.md).
  // Deletion waits for them through requestHasUnsettledWork.
  const runningJobIds = [record, ...descendants].flatMap((item) =>
    (item.jobs ?? []).filter((job) => job.state === "running").map((job) => job.jobId));
  if (runningJobIds.length) {
    void state.jobs.stopMany(runningJobIds, "request").catch((error: unknown) => {
      console.error(`Background jobs could not all be stopped: ${errorMessage(error)}`);
    });
  }
  let ampleFileAgentAborted = false;
  if (ampleFileAgentWasRunning) {
    ampleFileAgentAborted = await cancelAcceptedTurn(state, scopeId, record.owner.conversationId, ownTurn.taskId);
  }
  const children: Array<{ taskId: string; conversationId: string; connectedFolderId: string; aborted: boolean }> = [];
  for (const child of runningChildren) {
    const aborted = await cancelAcceptedTurn(state, child.connectedFolderId, child.conversationId, child.taskId);
    children.push({
      taskId: child.taskId,
      conversationId: child.conversationId,
      connectedFolderId: child.connectedFolderId,
      aborted,
    });
  }
  return { taskId, ampleFileAgentAborted, children };
}

function assertAmpleFileAgentParentAccepting(state: LocalApiState, parentTaskId: string | undefined): void {
  if (!parentTaskId) return;
  if (!state.requests.isAccepting(parentTaskId)) {
    throw new AmpleFileCliError("conflict", "The AmpleFile Agent request is stopping or has already finished.");
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
  await state.requests.recordAction(parentTaskId, {
    command: input.command,
    at: new Date().toISOString(),
    ...(input.connectedFolder ? { connectedFolderId: input.connectedFolder.id, connectedFolderName: input.connectedFolder.name } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.copied ? { copied: input.copied } : {}),
  });
}

async function cancelAcceptedTurn(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  taskId: string,
): Promise<boolean> {
  if (turnStatusFor(state, connectedFolderId, taskId).state !== "running") return false;
  state.cancelledTurnTasks.add(taskId);
  const client = state.clients.get(clientKey(connectedFolderId, conversationId));
  await client?.abort().catch(() => false);
  return true;
}

async function turnResultForScope(
  state: LocalApiState,
  scopeId: string,
  rootPath: string,
  taskId: string,
): ReturnType<AmpleFileActFacade["agentTurnResult"]> {
  const request = state.requests.byTaskId(taskId);
  if (request && (request.owner.connectedFolderId ?? ampleFileAgentScopeId) === scopeId) {
    if (!isAmpleFileRequestTerminalState(request.state)) throw new AmpleFileCliError("conflict", "The request is still outstanding. Use chat wait or chat status --task.");
    taskId = request.turns.at(-1)!.taskId;
  }
  const task = turnStatusFor(state, scopeId, taskId);
  if (task.state === "running") {
    throw new AmpleFileCliError("conflict", "The turn is still running. Use chat wait or chat status --task.");
  }
  if (task.state === "unknown") {
    throw new AmpleFileCliError("notFound", "Task not found. Recent turn outcomes are kept in a bounded durable journal.");
  }
  if (task.state === "aborted") throw new AmpleFileCliError("conflict", "The turn was aborted before it finished.");
  if (task.state === "failed") throw new AmpleFileCliError("failure", task.error ?? "The turn failed.");
  const conversationId = task.conversationId!;
  const messages = await runActOperation(() => readConversation(rootPath, conversationId));
  const message = messages.find((item) => item.id === task.messageId);
  if (!message) throw new AmpleFileCliError("failure", "The turn's response message could not be found in the transcript.");
  const result = await completedRequestEnvelope(state, taskId);
  await noteResultReadByRunningParent(state, taskId);
  return {
    conversationId,
    task: { taskId, state: "succeeded" as const, endedAt: task.endedAt! },
    message: toActChatMessage(message),
    request: state.requests.byTaskId(taskId) ? toActRequestRefForConnectedFolder(state, state.requests.byTaskId(taskId)!) : null,
    result,
  };
}

/**
 * A parent that reads a child's settled result while its own turn is still
 * running has received it: `chat wait` and `agent wait` end with exactly this
 * read. Recording that delivery by the child's turn identity keeps the host
 * from starting a follow-up turn that repeats the same result. A later
 * child turn, such as an answer's continuation, is a new identity and is
 * still delivered.
 */
async function noteResultReadByRunningParent(state: LocalApiState, taskId: string): Promise<void> {
  const child = state.requests.byTaskId(taskId);
  if (!child?.parentRequestId || !isAmpleFileRequestTerminalState(child.state) || child.turns.at(-1)!.taskId !== taskId) return;
  const parent = state.requests.get(child.parentRequestId);
  const parentTurn = parent?.turns.at(-1);
  if (!parent || !parentTurn || (parentTurn.state !== "accepted" && parentTurn.state !== "running")) return;
  if (parent.deliveredChildTaskIds.includes(taskId)) return;
  await state.requests.noteChildDelivery(parent.requestId, [taskId]);
}

/** Only a request's selected report/final reply, never its transcript or graph. */
/** Whether the request's latest turn filed its own result with `chat report`, rather than ending with only a reply. */
function turnReportedResult(state: LocalApiState, taskId: string): boolean {
  const request = state.requests.byTaskId(taskId);
  const latest = request?.turns.at(-1);
  return Boolean(request && latest && request.results.some((item) => item.taskId === latest.taskId));
}

async function completedRequestEnvelope(state: LocalApiState, taskId: string): Promise<AmpleFileResultEnvelope | null> {
  const request = state.requests.byTaskId(taskId);
  if (!request || !isAmpleFileRequestTerminalState(request.state)) return null;
  const latest = request.turns.at(-1)!;
  const ref = [...request.results].reverse().find((item) => item.taskId === latest.taskId);
  if (ref) {
    const read = await state.requests.result(ref.resultId);
    if (read?.state !== "ok") throw new AmpleFileCliError("failure", "The selected result is unavailable; its receipt remains on record.");
    return { ...read.record.envelope,
      ...(request.state === "partial" && read.record.envelope.outcome === "succeeded" ? { outcome: "partial" as const } : {}) };
  }
  const turn = state.turnStore.get(latest.taskId);
  return {
    summary: clampUtf8(turn?.assistantText || latest.error || "The request ended without a reported result.", ampleFileRequestLimits.maxResultSummaryBytes),
    outcome: request.state === "done" ? "succeeded" : request.state === "partial" ? "partial" : "failed",
  };
}

async function conversationResultForScope(
  state: LocalApiState,
  scopeId: string,
  rootPath: string,
  conversationId: string,
  messageLimit?: number,
): Promise<{
  conversationId: string;
  state: AmpleFileActChatState;
  total: number;
  lastAssistant: string | null;
  messages: AmpleFileActChatMessage[];
}> {
  const all = await runActOperation(() => readConversation(rootPath, conversationId));
  if (!all.length) throw new AmpleFileCliError("notFound", "Conversation not found.");
  const visible = all.filter((message) => message.role === "user" || message.role === "assistant");
  const limit = Math.max(Math.floor(messageLimit ?? 10), 1);
  const lastAssistant = [...visible].reverse().find((message) => message.role === "assistant")?.content ?? null;
  return {
    conversationId,
    state: conversationRuntimeState(state, scopeId, conversationId),
    total: visible.length,
    lastAssistant,
    messages: visible.slice(-limit).map(toActChatMessage),
  };
}

async function addExternalFilesInternal(
  connectedFolder: ConnectedFolderSummary,
  input: { fromPaths: string[]; toDir?: string; cwd: string },
): Promise<{ copied: string[]; checkpointId: string | null }> {
  if (!input.fromPaths.length) throw new AmpleFileCliError("usage", "Provide at least one --from <path> to add.");
  const toDir = normalizeConnectedFolderRelativePath(input.toDir ?? "");
  const sources: string[] = [];
  for (const raw of input.fromPaths) {
    const trimmed = raw.trim();
    if (!trimmed) throw new AmpleFileCliError("usage", "Source paths cannot be empty.");
    const source = isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
    const info = await lstat(source).catch(() => null);
    if (!info) throw new AmpleFileCliError("notFound", `Source not found: ${trimmed}.`);
    if (info.isSymbolicLink()) throw new AmpleFileCliError("usage", `Symbolic-link sources cannot be added: ${trimmed}.`);
    if (!info.isFile() && !info.isDirectory()) {
      throw new AmpleFileCliError("usage", `Only files and folders can be added: ${trimmed}.`);
    }
    if (pathContainsPath(connectedFolder.connectedFolderRoot, source)) {
      throw new AmpleFileCliError("usage", `Source is already inside this Connected Folder: ${trimmed}. Move it in Files instead.`);
    }
    if (pathContainsPath(source, connectedFolder.connectedFolderRoot)) {
      throw new AmpleFileCliError("usage", `Source contains this Connected Folder and cannot be copied into it: ${trimmed}.`);
    }
    sources.push(source);
  }
  const copied: string[] = [];
  try {
    for (const source of sources) copied.push(await copyPathIntoConnectedFolder(source, connectedFolder.connectedFolderRoot, toDir));
  } catch (error) {
    // A mid-batch failure must not strand earlier copies without a restore
    // point: undo them best-effort, then surface the failure.
    await Promise.all(copied.map((path) =>
      rm(resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, path), { recursive: true, force: true }).catch(() => undefined)));
    throw error;
  }
  const safety = await checkpointAdditiveWritesOrUndo(connectedFolder.connectedFolderRoot, copied, {
    reason: "pre_add",
    label: `Before adding ${copied.length} item${copied.length === 1 ? "" : "s"}`,
  });
  return { copied, checkpointId: safety?.checkpointId ?? null };
}

export type AmpleFileDeleteRecovery =
  | { kind: "history" }
  | { kind: "recently-deleted"; entryId: string; restoreBy: string; uncovered: AmpleFileRecentlyDeletedUncoveredPath[] };

export interface AmpleFileDeleteResult {
  deleted: true;
  path: string;
  kind: "file" | "folder";
  safetyCheckpointId: string;
  recovery: AmpleFileDeleteRecovery;
}

/**
 * The one delete both the desktop route and `files delete` run
 * (docs/act-ledger.md). A delete never refuses for lack of
 * coverage: History keeps what it can, and when the restore point could not
 * cover every matched file the selected entry is *moved* into Recently
 * deleted instead of erased, so one delete keeps one undo reference.
 *
 * `.amplefile/`, `.work-fold/`, and `.pi/` remain invalid endpoints, and the
 * Connected Folder root still cannot be deleted: the path policy runs first, unchanged.
 */
async function deleteConnectedFolderEntryWithRecovery(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  target: string,
  context: { receiptId: string | null },
): Promise<AmpleFileDeleteResult> {
  reserveCapabilityMutation(state, connectedFolder.id, "project", connectedFolder.id);
  try {
    return await runSettledConnectedFolderDeletion(state, connectedFolder.id, () => deleteSettledConnectedFolderEntryWithRecovery(state, connectedFolder, target, context));
  } finally {
    state.capabilityMutations.delete(connectedFolder.id);
  }
}

async function deleteSettledConnectedFolderEntryWithRecovery(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  target: string,
  context: { receiptId: string | null },
): Promise<AmpleFileDeleteResult> {
  const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
    paths: [target],
    reason: "pre_delete",
    label: `Before deleting ${target}`,
  });
  return runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => applyConnectedFolderDelete(
    state,
    connectedFolder,
    target,
    safety.skippedFiles.map((file) => ({ path: file.path, reason: file.reason })),
    safety.checkpointId,
    context,
  ));
}

/**
 * One delete under a restore point already taken: erased when History kept a
 * copy of all of it, else moved whole into Recently deleted with the files
 * History could not keep. One row and each row of a several-row delete run it.
 */
async function applyConnectedFolderDelete(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  target: string,
  uncovered: AmpleFileRecentlyDeletedUncoveredPath[],
  safetyCheckpointId: string,
  context: { receiptId: string | null },
): Promise<AmpleFileDeleteResult> {
  if (!uncovered.length) {
    const deleted = await deleteConnectedFolderEntry(connectedFolder.connectedFolderRoot, target);
    return { ...deleted, safetyCheckpointId, recovery: { kind: "history" as const } };
  }
  const entry = await resolveConnectedFolderDeleteTarget(connectedFolder.connectedFolderRoot, target);
  let trashed: AmpleFileRecentlyDeletedEntry;
  try {
    trashed = await state.recentlyDeleted.moveTreeToRecentlyDeleted({
      kind: entry.kind,
      reason: "files.delete",
      sourcePath: entry.absolutePath,
      connectedFolderId: connectedFolder.id,
      connectedFolderName: connectedFolder.name,
      originalPath: entry.path,
      receiptId: context.receiptId,
      uncovered,
    });
  } catch (error) {
    throw new AmpleFileCliError(
      "failure",
      `AmpleFile could not move ${entry.path} to Recently deleted: ${errorMessage(error)}. Nothing was deleted.`,
      { cause: error },
    );
  }
  await touchConnectedFolderRoot(connectedFolder.connectedFolderRoot).catch(() => undefined);
  return {
    deleted: true as const,
    path: entry.path,
    kind: entry.kind,
    safetyCheckpointId,
    recovery: { kind: "recently-deleted" as const, entryId: trashed.id, restoreBy: trashed.restoreBy, uncovered },
  };
}

/** A JSON list of Connected Folder paths from a request body. */
function connectedFolderPathList(value: unknown, emptyMessage: string): string[] {
  if (!Array.isArray(value) || !value.length) throw badRequest(emptyMessage);
  if (value.some((path) => typeof path !== "string" || !path.trim())) throw badRequest("Each item must be a Connected Folder path.");
  return value as string[];
}

export interface AmpleFileBatchDeleteResult {
  deleted: Array<AmpleFileDeleteResult & { receiptId: string }>;
  safetyCheckpointId: string;
  /** Set when a row failed after earlier rows were deleted; the restore point still covers every row. */
  failed?: { path: string; error: string };
  notDeleted?: string[];
}

/**
 * Several rows deleted under one History restore point. Each row
 * keeps what one delete has: the busy refusal and the shared active-work
 * reservation held through every effect, the same path checks, its own
 * receipt, and History or Recently deleted for whatever History cannot keep.
 *
 * Every row is checked before anything is deleted. If a row still fails
 * partway, the rows already deleted stay deleted, the rest are left alone, and
 * the one restore point, which covers every row, brings back what was
 * deleted. When the first row fails, nothing was deleted and the restore point
 * is discarded, exactly as for one row. A row inside another row is deleted
 * with it.
 */
async function deleteConnectedFolderEntriesWithRecovery(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  targets: readonly string[],
): Promise<AmpleFileBatchDeleteResult> {
  reserveCapabilityMutation(state, connectedFolder.id, "project", connectedFolder.id);
  try {
    return await runSettledConnectedFolderDeletion(state, connectedFolder.id, () => deleteSettledConnectedFolderEntries(state, connectedFolder, targets));
  } finally {
    state.capabilityMutations.delete(connectedFolder.id);
  }
}

async function deleteSettledConnectedFolderEntries(
  state: LocalApiState,
  connectedFolder: ConnectedFolderSummary,
  targets: readonly string[],
): Promise<AmpleFileBatchDeleteResult> {
  const root = connectedFolder.connectedFolderRoot;
  const paths = outermostConnectedFolderPaths(targets);
  if (!paths.length) throw badRequest("Select files or folders to delete.");
  const entries: Array<{ absolutePath: string; path: string; kind: "file" | "folder" }> = [];
  for (const path of paths) entries.push(await resolveConnectedFolderDeleteTarget(root, path));
  const safety = await createConnectedFolderMutationCheckpoint(root, {
    paths: entries.map((entry) => entry.path),
    reason: "pre_delete",
    label: entries.length === 1 ? `Before deleting ${entries[0]!.path}` : `Before deleting ${entries.length} items`,
  });
  // History names the files it could not keep the way it names its capture
  // roots; each one belongs to exactly one row.
  const historyRoot = ensureSafeConnectedFolderRoot(root);
  const capturedAs = entries.map((entry) => relative(historyRoot, entry.absolutePath).split(sep).join("/"));
  const uncovered = entries.map((): AmpleFileRecentlyDeletedUncoveredPath[] => []);
  for (const file of safety.skippedFiles) {
    const row = capturedAs.findIndex((path) => file.path === path || file.path.startsWith(`${path}/`));
    if (row < 0) {
      await discardConnectedFolderCheckpoint(root, safety.checkpointId).catch(() => undefined);
      throw new AmpleFileCliError("failure", `AmpleFile could not tell which item ${file.path} belongs to. Nothing was deleted.`);
    }
    uncovered[row]!.push({ path: file.path, reason: file.reason });
  }
  const deleted: AmpleFileBatchDeleteResult["deleted"] = [];
  for (const [index, entry] of entries.entries()) {
    try {
      const row = await runDesktopSettingsAct(state, "files.delete", async (requestId) => {
        const value = await applyConnectedFolderDelete(state, connectedFolder, entry.path, uncovered[index]!, safety.checkpointId, { receiptId: requestId });
        return {
          value,
          detail: value.recovery.kind === "recently-deleted"
            ? `Connected Folder ${connectedFolder.id}; trash ${value.recovery.entryId}`
            : `Connected Folder ${connectedFolder.id}; checkpoint ${value.safetyCheckpointId}`,
        };
      });
      deleted.push({ ...row.value, receiptId: row.requestId });
    } catch (error) {
      if (!deleted.length) {
        await discardConnectedFolderCheckpoint(root, safety.checkpointId).catch(() => undefined);
        throw error;
      }
      return {
        deleted,
        safetyCheckpointId: safety.checkpointId,
        failed: { path: entry.path, error: errorMessage(error) },
        notDeleted: entries.slice(index + 1).map((item) => item.path),
      };
    }
  }
  return { deleted, safetyCheckpointId: safety.checkpointId };
}

export interface AmpleFileBatchMoveResult {
  moved: ConnectedFolderMovedEntry[];
  safetyCheckpointId: string;
  historySkippedPaths: string[];
  /** Set when an item failed after others had moved; the restore point then names exactly the moves that happened. */
  failed?: { path: string; error: string };
  notMoved?: string[];
}

/**
 * Several items moved into one folder under one History restore point.
 * Every item passes every check one move makes before any of
 * them moves, then each runs through `moveConnectedFolderEntry`, the move one item
 * takes. If one still fails partway, the items already moved stay moved, the
 * rest stay put, and the restore point is replaced by one that names exactly
 * the moves that happened, so restoring it undoes them. When the first item
 * fails, nothing moved and the restore point is discarded, as for one item.
 * An item inside another item moves with it.
 */
async function moveConnectedFolderEntriesWithHistory(
  connectedFolder: ConnectedFolderSummary,
  sourcePaths: readonly string[],
  targetFolderPath: string,
): Promise<AmpleFileBatchMoveResult> {
  const root = connectedFolder.connectedFolderRoot;
  const sources = outermostConnectedFolderPaths(sourcePaths);
  if (!sources.length) throw badRequest("Select files or folders to move.");
  const plans = await checkConnectedFolderMoves(root, sources, targetFolderPath);
  const label = plans.length === 1 ? `Before moving ${plans[0]!.fromPath}` : `Before moving ${plans.length} items`;
  const safety = await createConnectedFolderMutationCheckpoint(root, {
    movesOnRestore: plans.map((plan) => ({ fromPath: plan.toPath, toPath: plan.fromPath })),
    reason: "pre_move",
    label,
  });
  const moved: ConnectedFolderMovedEntry[] = [];
  for (const [index, plan] of plans.entries()) {
    try {
      moved.push(await moveConnectedFolderEntry(root, { sourcePath: plan.fromPath, targetFolderPath }));
    } catch (error) {
      if (!moved.length) {
        await discardConnectedFolderCheckpoint(root, safety.checkpointId).catch(() => undefined);
        throw error;
      }
      const kept = await restorePointForMoves(root, moved, label, safety.checkpointId, error);
      return {
        moved,
        safetyCheckpointId: kept.checkpointId,
        historySkippedPaths: kept.skippedLargeFiles,
        failed: { path: plan.fromPath, error: errorMessage(error) },
        notMoved: plans.slice(index + 1).map((item) => item.fromPath),
      };
    }
  }
  return { moved, safetyCheckpointId: safety.checkpointId, historySkippedPaths: safety.skippedLargeFiles };
}

/**
 * The restore point for a several-item move that stopped partway: it names
 * only the moves that happened, because History will not undo a move whose
 * item is not where the move put it. If that record cannot be written, the
 * moves are put back so nothing is left moved without a restore point.
 */
async function restorePointForMoves(
  root: string,
  moved: readonly ConnectedFolderMovedEntry[],
  label: string,
  plannedCheckpointId: string,
  cause: unknown,
): Promise<Awaited<ReturnType<typeof createConnectedFolderMutationCheckpoint>>> {
  try {
    const kept = await createConnectedFolderMutationCheckpoint(root, {
      movesOnRestore: moved.map((item) => ({ fromPath: item.path, toPath: item.fromPath })),
      reason: "pre_move",
      label,
    });
    await discardConnectedFolderCheckpoint(root, plannedCheckpointId).catch(() => undefined);
    return kept;
  } catch (recordError) {
    for (const item of [...moved].reverse()) {
      const parent = item.fromPath.includes("/") ? item.fromPath.slice(0, item.fromPath.lastIndexOf("/")) : "";
      await moveConnectedFolderEntry(root, { sourcePath: item.path, targetFolderPath: parent });
    }
    await discardConnectedFolderCheckpoint(root, plannedCheckpointId).catch(() => undefined);
    throw new AmpleFileCliError("failure", `${errorMessage(cause)} History could not record the moves (${errorMessage(recordError)}), so they were put back.`, { cause });
  }
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

async function runActOperation<T>(operation: () => Promise<T>): Promise<T> {
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

type McpSetupSession = { connectedFolderId: string; service: ReturnType<typeof createIncludedMcpSetup>; timer: ReturnType<typeof setTimeout> };
const mcpSetupSessions = new WeakMap<LocalApiState, Map<string, McpSetupSession>>();
function resetMcpSetupExpiry(state: LocalApiState, id: string, entry: McpSetupSession): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { mcpSetupSessions.get(state)?.delete(id); void entry.service.dispose().catch(() => undefined); }, 15 * 60_000);
  entry.timer.unref();
}
async function closeMcpSetups(state: LocalApiState): Promise<void> {
  const entries = mcpSetupSessions.get(state); mcpSetupSessions.delete(state);
  await Promise.allSettled([...(entries?.values() ?? [])].map(async (entry) => { clearTimeout(entry.timer); await entry.service.dispose(); }));
}

async function runDesktopSettingsAct<T>(
  state: LocalApiState,
  command: string,
  operation: (requestId: string) => Promise<{ value: T; detail: string }>,
): Promise<{ requestId: string; value: T }> {
  const started = await beginDesktopSettingsAct(state, command, operation);
  return { requestId: started.requestId, value: await started.result };
}

function turnStatusFor(state: LocalApiState, connectedFolderId: string, taskId: string): AmpleFileActTurnStatus {
  const active = state.activeTurnTasks.get(taskId);
  if (active && active.connectedFolderId === connectedFolderId) {
    return { taskId, state: "running", conversationId: active.conversationId, messageId: null, error: null, endedAt: null };
  }
  const settled = state.settledTurns.get(taskId);
  if (settled && settled.connectedFolderId === connectedFolderId) {
    return {
      taskId,
      state: settled.status,
      conversationId: settled.conversationId,
      messageId: settled.messageId ?? null,
      error: settled.error ?? null,
      endedAt: settled.endedAt,
    };
  }
  // Older than the in-memory window: the durable turn journal still knows it.
  const durable = state.turnStore.get(taskId);
  if (durable && durable.connectedFolderId === connectedFolderId && durable.status !== "accepted" && durable.status !== "running") {
    return {
      taskId,
      state: durable.status === "interrupted" ? "failed" : durable.status,
      conversationId: durable.conversationId,
      messageId: durable.messageId ?? null,
      error: durable.error ?? null,
      endedAt: durable.updatedAt,
    };
  }
  return { taskId, state: "unknown", conversationId: null, messageId: null, error: null, endedAt: null };
}

// --- the collaboration verbs and the request graph ------------------------

const maxTurnsRememberedThisRun = 4_000;

/**
 * The `--task` rule for `chat report`, `chat ask`, and `chat handoff`: the
 * id must name the caller's own turn — the newest, still-running turn of a
 * request the named Connected Folder owns — checked exactly as `--parent-task` is. The
 * store's lineage refusal reaches the caller as a conflict by name.
 */
function assertOwnTask(state: LocalApiState, connectedFolderId: string, taskId: string): AmpleFileRequestRecord {
  try {
    return state.requests.assertOwnAcceptingTurn(taskId, connectedFolderId === ampleFileAgentScopeId ? {} : { connectedFolderId });
  } catch (error) {
    throw collaborationRefusal(error);
  }
}

/** The caller's own turn, in whichever scope it runs, while it is still running. */
function assertCallerTurn(state: LocalApiState, callerTaskId: string): AmpleFileRequestRecord {
  const record = state.requests.byTaskId(callerTaskId);
  return assertOwnTask(state, record?.owner.connectedFolderId ?? ampleFileAgentScopeId, callerTaskId);
}

/**
 * Whether a Chat is one the caller's own Chat handed work to: some request in
 * that Chat has a parent request owned by the caller's Chat, in any of its
 * turns. A Worker may follow up with, redirect, or copy only such work, never
 * an unrelated Chat (docs/collaboration-contract.md). The caller's task must be
 * its own turn that is still running.
 */
function assertCallerHandedWorkTo(state: LocalApiState, callerTaskId: string, target: { connectedFolderId: string; conversationId: string }): AmpleFileRequestRecord {
  const caller = assertCallerTurn(state, callerTaskId);
  const callerScope = caller.owner.connectedFolderId ?? ampleFileAgentScopeId;
  const handedTo = state.requests.list().some((record) => {
    if ((record.owner.connectedFolderId ?? ampleFileAgentScopeId) !== target.connectedFolderId || record.owner.conversationId !== target.conversationId) return false;
    const parent = record.parentRequestId ? state.requests.get(record.parentRequestId) : null;
    return parent !== null && parent !== undefined
      && (parent.owner.connectedFolderId ?? ampleFileAgentScopeId) === callerScope
      && parent.owner.conversationId === caller.owner.conversationId;
  });
  if (!handedTo) {
    throw new AmpleFileCliError("conflict", "That Chat is not one this Chat handed work to. Hand off new work with chat handoff instead.");
  }
  return caller;
}

/**
 * Copies a Chat as of its last finished reply into a new Chat in the same
 * Connected Folder (`chat copy`): the visible transcript up to that
 * reply, and the Pi session along the same path, so the copy starts with the
 * same context. Copied messages get new ids and lose their turn and request
 * identities, which belong to the original Chat; the original is never
 * written. A turn still running in the original is left out.
 */
async function copyConversation(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  sourceConversationId: string,
  title?: string,
): Promise<{ conversation: ConversationSummary; copiedMessages: number }> {
  await yieldBackgroundCompaction(state, clientKey(connectedFolder.id, sourceConversationId));
  const summary = await readConversationSummary(connectedFolder.connectedFolderRoot, sourceConversationId);
  if (!summary) throw new AmpleFileCliError("notFound", "Conversation not found.");
  if (state.compactingConversations.has(clientKey(connectedFolder.id, sourceConversationId))) {
    throw new AmpleFileCliError("conflict", "That Chat is being compacted. Copy it once that finishes.");
  }
  const messages = await readConversation(connectedFolder.connectedFolderRoot, sourceConversationId);
  const lastReply = messages.reduce((found, message, index) => message.role === "assistant" ? index : found, -1);
  const carried = messages.slice(0, lastReply + 1).filter((message) => message.role !== "system");
  const forkTitle = (title?.trim() || `${summary.title} (copy)`).slice(0, 200);
  const conversation = await createConversation(connectedFolder.connectedFolderRoot, forkTitle);
  for (const message of carried) {
    const { turnId: _turnId, requestId: _requestId, delivery: _delivery, ...content } = message;
    await appendMessage(connectedFolder.connectedFolderRoot, conversation.id, { ...content, id: randomUUID() });
  }
  if (carried.length) {
    await copyPiConversationSession({
      connectedFolderRoot: connectedFolder.connectedFolderRoot,
      runtimeProvider: state.runtimeProvider,
      sourceConversationId,
      targetConversationId: conversation.id,
    });
  }
  return { conversation: (await readConversationSummary(connectedFolder.connectedFolderRoot, conversation.id)) ?? conversation, copiedMessages: carried.length };
}

/** A request bound or lineage refusal is a conflict that carries the store's own sentence; anything else passes through. */
function collaborationRefusal(error: unknown): unknown {
  if (error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError) {
    return new AmpleFileCliError("conflict", error.message, { cause: error });
  }
  return error;
}

function requestLimitRefusalMessage(limit: "questionLifetime"): string {
  return "This request has expired.";
}

/**
 * The `waiting` field: the oldest open question this task itself asked,
 * or null. A question past its window by wall-clock is never reported live
 * even before the store's sweep marks it expired.
 */
function waitingRefForTask(state: LocalApiState, taskId: string): AmpleFileActWaitingRef | null {
  const record = state.requests.byTaskId(taskId);
  if (!record) return null;
  const now = Date.now();
  const open = state.requests.questions(record.requestId)
    .filter((question) => (question.state === "open" || (question.state === "answered" && question.continuationTaskId === null)) && (question.expiresAt === null || now < Date.parse(question.expiresAt)))
    .sort((left, right) => left.askedAt.localeCompare(right.askedAt));
  const question = open[0];
  if (!question) return null;
  return {
    questionId: question.questionId,
    requestId: question.requestId,
    respondent: question.respondent,
    question: question.text,
    askedAt: question.askedAt,
    expiresAt: question.expiresAt,
  };
}

/**
 * The request reference a Connected Folder–scoped verb hands back to the caller.
 *
 * Identical to `toActRequestRef` except for one field: a delegated Connected Folder
 * request's `rootId` is usually the AmpleFile Agent's root request id, and
 * `requests show` reads a request by id. Handing that id into a Connected Folder turn
 * would put the AmpleFile Agent's own content and other Connected Folders' results one taught
 * command away — the same leak `connected-folder-turn-context.ts` withholds the parent
 * request id to avoid — so it is projected through the same opaque handle no
 * verb accepts. A Connected Folder's own root still names itself.
 */
function toActRequestRefForConnectedFolder(state: LocalApiState, record: AmpleFileRequestRecord): AmpleFileActRequestRef {
  const ref = toActRequestRef(state, record);
  if (record.owner.connectedFolderId === undefined || record.rootId === record.requestId) return ref;
  return { ...ref, rootId: connectedFolderTurnParentHandle(record.rootId, state.connectedFolderTurnHandleSalt) };
}

function toActRequestRef(state: LocalApiState, record: AmpleFileRequestRecord): AmpleFileActRequestRef {
  return {
    id: record.requestId,
    rootId: record.rootId,
    kind: record.kind,
    state: record.state,
    depth: record.depth,
    connectedFolderId: record.owner.connectedFolderId ?? null,
    connectedFolderName: record.owner.connectedFolderName ?? null,
    conversationId: record.owner.conversationId,
    deadline: record.deadline,
    openQuestions: state.requests.questions(record.requestId).filter((question) => question.state === "open").length,
    children: record.childRequestIds.length,
    results: record.results.length,
  };
}

function toActQuestionRef(question: AmpleFileQuestionRecord): AmpleFileActQuestionRef {
  return {
    questionId: question.questionId,
    requestId: question.requestId,
    taskId: question.taskId,
    respondent: question.respondent,
    text: question.text,
    ...(question.asynchronous ? { asynchronous: true } : {}),
    ...(question.options?.length ? { options: [...question.options] } : {}),
    state: question.state,
    askedAt: question.askedAt,
    expiresAt: question.expiresAt,
    answer: question.answer,
    answeredAt: question.answeredAt,
    continuationTaskId: question.continuationTaskId,
  };
}

function requestSummaryView(state: LocalApiState, record: AmpleFileRequestRecord): AmpleFileActRequestSummary {
  return {
    ...toActRequestRef(state, record),
    surface: record.surface,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    settledAt: record.settledAt,
    taskId: record.turns.at(-1)!.taskId,
    continuationCount: record.continuationCount,
    limitHit: record.limitHit,
  };
}

/**
 * `requests list` and `requests show` are management-scope reads: the whole
 * graph, including the AmpleFile Agent's own assignment text and every Connected Folder's result
 * envelope. A caller working inside a registered Connected Folder is inside that Connected Folder's
 * scope, and what may reach a Connected Folder is its assignment, answers to its own
 * questions, and payloads released to it — never the graph
 * (docs/collaboration-contract.md). The caller's directory resolves its scope
 * exactly as `context` does, and the refusal names the boundary and the verbs
 * that do belong to a Connected Folder.
 */
async function assertRequestsAboveConnectedFolders(cwd: string | undefined): Promise<void> {
  const candidate = cwd?.trim();
  if (!candidate) return;
  const resolved = resolve(candidate);
  const containing = (await listConnectedFolders())
    .filter((connectedFolder) => pathContainsPath(connectedFolder.connectedFolderRoot, resolved))
    .sort((left, right) => resolve(right.connectedFolderRoot).length - resolve(left.connectedFolderRoot).length)[0];
  if (!containing) return;
  throw new AmpleFileCliError(
    "permissionDenied",
    `The request record sits above Connected Folders, and this ran inside "${containing.name}". Follow your own work with 'chat status' and 'chat wait', and report with 'chat report'.`,
  );
}

/** `requests show`: the complete subtree, rejecting damaged cycles. */
async function requestDetailView(state: LocalApiState, record: AmpleFileRequestRecord, ancestors = new Set<string>()): Promise<AmpleFileActRequestDetail> {
  if (ancestors.has(record.requestId)) throw new Error("Request graph contains a cycle.");
  const path = new Set(ancestors).add(record.requestId);
  const reads = await state.requests.results(record.requestId);
  const resultRecords: AmpleFileActRequestResult[] = record.results.map((ref) => {
    const read = reads.find((candidate) => (candidate.state === "ok" ? candidate.record.resultId : candidate.resultId) === ref.resultId);
    return {
      resultId: ref.resultId,
      taskId: ref.taskId,
      recordedAt: ref.recordedAt,
      receiptId: ref.receiptId,
      outcome: ref.outcome,
      fileCount: ref.fileCount,
      envelope: read?.state === "ok" ? read.record.envelope : null,
      ...(read?.state === "damaged" ? { damaged: read.error } : {}),
    };
  });
  const childRequests: AmpleFileActRequestDetail[] = [];
  if (state.requests.children(record.requestId).length) {
    for (const child of state.requests.children(record.requestId)) {
      childRequests.push(await requestDetailView(state, child, path));
    }
  }
  return {
    ...requestSummaryView(state, record),
    parentRequestId: record.parentRequestId,
    parentTaskId: record.parentTaskId,
    content: record.content,
    turns: record.turns.map((turn) => ({
      taskId: turn.taskId,
      role: turn.role,
      state: turn.state,
      acceptedAt: turn.acceptedAt,
      settledAt: turn.settledAt,
      error: turn.error,
    })),
    questions: state.requests.questions(record.requestId).map(toActQuestionRef),
    resultRecords,
    usage: record.usage,
    stopRequestedAt: record.stopRequestedAt,
    reconciledAt: record.reconciledAt,
    jobs: (record.jobs ?? []).map((job) => ({ ...job })),
    childRequests,
  };
}

/**
 * A report's deliverables: each named path must be a file inside the Connected Folder,
 * outside the reserved folders, and is recorded by content hash and size so
 * the envelope says exactly which bytes were meant.
 */
async function resolveReportFiles(
  connectedFolder: ConnectedFolderSummary,
  files: string[],
): Promise<Array<{ path: string; sha256: string; sizeBytes: number }>> {
  const resolved: Array<{ path: string; sha256: string; sizeBytes: number }> = [];
  for (const raw of files) {
    const relativePath = normalizeConnectedFolderRelativePath(raw);
    let absolute: string;
    try {
      absolute = resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, relativePath);
    } catch (error) {
      throw new AmpleFileCliError("usage", `--file ${raw}: ${errorMessage(error)}`, { cause: error });
    }
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new AmpleFileCliError("notFound", `--file ${raw}: not found in ${connectedFolder.name}.`);
    if (!info.isFile()) throw new AmpleFileCliError("usage", `--file ${raw}: a result names files, not folders.`);
    const hash = createHash("sha256");
    await new Promise<void>((resolveHash, reject) => {
      createReadStream(absolute)
        .on("data", (chunk) => hash.update(chunk))
        .on("error", reject)
        .on("end", () => resolveHash());
    });
    resolved.push({ path: relativePath, sha256: hash.digest("hex"), sizeBytes: info.size });
  }
  return resolved;
}

/** `--data @<path>`: read host-side against the directory the command ran in, bounded by the envelope's own data limit. */
async function readReportDataFile(dataPath: string, cwd: string): Promise<unknown> {
  const absolute = isAbsolute(dataPath) ? resolve(dataPath) : resolve(cwd, dataPath);
  const info = await stat(absolute).catch(() => null);
  if (!info || !info.isFile()) throw new AmpleFileCliError("notFound", `--data @${dataPath}: file not found.`);
  if (info.size > ampleFileRequestLimits.maxResultDataBytes) {
    throw new AmpleFileCliError("usage", ampleFileRequestLimitMessage("resultData", ampleFileRequestLimits.maxResultDataBytes));
  }
  const text = await readFile(absolute, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AmpleFileCliError("usage", `--data @${dataPath}: the file is not valid JSON.`, { cause: error });
  }
}

/** A handoff source is a Connected Folder–relative path resolved inside the caller's own Connected Folder. */
function resolveHandoffSource(connectedFolder: ConnectedFolderSummary, raw: string): string {
  try {
    return resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, normalizeConnectedFolderRelativePath(raw));
  } catch (error) {
    throw new AmpleFileCliError("usage", `--file ${raw}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Every settle in this app run passes through here, serialized, so two
 * children settling in the same tick can never start two continuations.
 * Failures are logged; a settle never fails because of a continuation.
 */
function queueRequestGraphSettle(state: LocalApiState, taskId: string): void {
  state.turnsSettledThisRun.add(taskId);
  while (state.turnsSettledThisRun.size > maxTurnsRememberedThisRun) {
    const oldest = state.turnsSettledThisRun.values().next().value;
    if (oldest === undefined) break;
    state.turnsSettledThisRun.delete(oldest);
  }
  state.requestSettleChain = state.requestSettleChain
    .then(() => evaluateRequestGraphSettle(state, taskId))
    .catch((error: unknown) => {
      console.error(`A request continuation could not be evaluated: ${errorMessage(error)}`);
    });
}

/** Releasing compaction makes pending deliveries eligible without inventing a new turn settlement. */
function queueConversationRequestEvaluation(state: LocalApiState, connectedFolderId: string, conversationId: string): void {
  state.requestSettleChain = state.requestSettleChain
    .then(async () => {
      for (const request of state.requests.list({ connectedFolderId })) {
        if (request.owner.conversationId === conversationId) {
          await evaluateRequestGraphSettle(state, request.turns.at(-1)!.taskId);
        }
      }
    })
    .catch((error: unknown) => {
      console.error(`A request continuation could not be evaluated after compaction: ${errorMessage(error)}`);
    });
}

async function evaluateRequestGraphSettle(state: LocalApiState, taskId: string): Promise<void> {
  const record = state.requests.byTaskId(taskId);
  if (!record) return;
  const candidates = new Map<string, AmpleFileRequestRecord>();
  let current: AmpleFileRequestRecord | null = record;
  while (current) {
    candidates.set(current.requestId, current);
    current = current.parentRequestId ? state.requests.get(current.parentRequestId) : null;
  }
  // Finishing any turn frees its Chat, including one that was occupied by a
  // newer request when this request's children finished.
  for (const other of state.requests.list()) {
    if (other.owner.connectedFolderId === record.owner.connectedFolderId && other.owner.conversationId === record.owner.conversationId) {
      candidates.set(other.requestId, other);
    }
  }
  for (const candidate of [...candidates.values()].sort((a, b) => b.depth - a.depth)) {
    const key = clientKey(candidate.owner.connectedFolderId ?? ampleFileAgentScopeId, candidate.owner.conversationId);
    if (!state.runningTurns.has(key) && !state.compactingConversations.has(key)) {
      const answered = state.requests.questions(candidate.requestId).find(question => question.asynchronous && question.state === "answered" && question.continuationTaskId === null);
      if (answered && candidate.stopRequestedAt === null) {
        const facade = createAmpleFileActFacade(state);
        if (candidate.owner.connectedFolderId) await facade.chatAnswer({ connectedFolder: candidate.owner.connectedFolderId, questionId: answered.questionId, answer: answered.answer! });
        else await facade.agentAnswer({ questionId: answered.questionId, answer: answered.answer! });
        continue;
      }
    }
    await maybeStartRequestContinuation(state, candidate.requestId);
  }
}

/** Person-facing work is scoped to one request and its deliberately linked work. */
async function ampleFileAgentConversationAttention(state: LocalApiState, conversationId: string) {
  const record = state.requests.latestForConversation(conversationId);
  const work = record?.state === "waiting" ? await requestPresentation(state, record) : null;
  return { requestState: record?.state ?? null, needsAnswer: (work?.questionCount ?? 0) > 0
    || extensionSnapshot(state, { connectedFolderRoot: ampleFileAgentRoot(), conversationId }).length > 0 };
}

async function requestPresentation(state: LocalApiState, record: AmpleFileRequestRecord): Promise<WorkRequestView> {
  const family = [record, ...state.requests.subtree(record.requestId)];
  const latest = record.turns.at(-1)!;
  const outstanding = family.some((item) => !isAmpleFileRequestTerminalState(item.state));
  const questions: WorkRequestView["questions"] = [];
  let questionCount = 0;
  let savedAnswerCount = 0;
  for (const item of family) {
    for (const question of state.requests.questions(item.requestId)) {
      if (question.respondent !== "person" || !(question.state === "open" || (question.state === "answered" && !question.continuationTaskId))) continue;
      if ((question.expiresAt !== null && Date.now() >= Date.parse(question.expiresAt))) continue;
      questionCount++;
      if (question.state === "answered") savedAnswerCount++;
      // A page of exact questions, not truncated question text. After an
      // answer the next question becomes visible. The digest retains all ids.
      if (questions.length >= ampleFileRequestLimits.questionsPerPresentation) continue;
      let reason: string | undefined;
      try { state.requests.assertCanContinue(item.requestId); } catch (error) { reason = errorMessage(error); }
      const key = clientKey(item.owner.connectedFolderId ?? ampleFileAgentScopeId, item.owner.conversationId);
      if (!question.asynchronous && (state.runningTurns.has(key) || state.compactingConversations.has(key))) reason = "The agent is finishing its current turn. You can write your answer now.";
      questions.push({ id: question.questionId, requestId: item.requestId, text: question.text,
        from: item.owner.connectedFolderName ?? (item.owner.connectedFolderId ? "Worker" : "AmpleFile"),
        state: question.state === "answered" ? "recorded" : "open",
        ...(question.options?.length && question.state !== "answered" ? { options: [...question.options] } : {}),
        ...(question.state === "answered" && question.answer ? { answer: question.answer } : {}),
        canAnswer: !reason, ...(reason ? { reason } : {}) });
    }
  }
  let detail: string | null = null;
  let canContinue = false;
  if (record.continuationState === "failed") {
    detail = "The follow-up did not start. Your saved results are still available.";
  }
  const readyResults = state.requests.children(record.requestId).some((child) => {
    const turn = child.turns.at(-1)!;
    return turn.settledAt && !record.deliveredChildTaskIds.includes(turn.taskId);
  });
  if (!outstanding && !questionCount && (record.continuationState === "failed" || readyResults)) {
    try {
      state.requests.assertCanContinue(record.requestId);
      const key = clientKey(record.owner.connectedFolderId ?? ampleFileAgentScopeId, record.owner.conversationId);
      canContinue = !state.runningTurns.has(key) && !state.compactingConversations.has(key);
      if (!detail) detail = "The delegated work is ready. Continue to bring its results together.";
    } catch { canContinue = false; }
  }
  // A request whose only outstanding work is background jobs says so, and
  // keeps Stop available between turns (docs/background-jobs.md).
  const runningJobs = family.flatMap((item) => (item.jobs ?? []).filter((job) => job.state === "running"));
  const turnLive = family.some((item) => item.turns.some((turn) => turn.state === "accepted" || turn.state === "running"));
  const inBackground = record.state === "working" && !turnLive && runningJobs.length > 0;
  if (inBackground && !detail) {
    const now = Date.now();
    const named = runningJobs.slice(0, 3).map((job) => `${job.name} · ${formatRunningFor(now - Date.parse(job.startedAt))}`);
    detail = `${named.join("; ")}${runningJobs.length > 3 ? `; and ${runningJobs.length - 3} more` : ""}`;
  }
  if (record.limitHit) detail = requestLimitStopMessage(record.limitHit.limit);
  else if (record.state === "expired") detail = "This request’s time window ended. Its saved work remains; start a new message to pick it up.";
  else if (latest.state === "interrupted") detail = "Work was interrupted when the app closed. Saved work remains; nothing was restarted automatically.";
  else if (record.state === "failed" && (record.jobs ?? []).some((job) => job.state === "interrupted")) {
    detail = "A background job was interrupted when AmpleFile closed. Saved work remains; nothing was restarted automatically.";
  }
  else if (record.state === "failed" && !detail) detail = latest.error ?? "The agent could not finish. Its saved work remains in the Chat.";
  let result: WorkRequestView["result"] = null;
  if (isAmpleFileRequestTerminalState(record.state) && record.state !== "stopped" && record.state !== "expired") {
    const selected = [...record.results].reverse().find((item) => item.taskId === latest.taskId);
    if (selected) {
      const read = await state.requests.result(selected.resultId);
      if (read?.state === "ok") {
        const envelope = read.record.envelope;
        const files: NonNullable<WorkRequestView["result"]>["files"] = [];
        if (record.owner.connectedFolderId) for (const file of envelope.files ?? []) {
          files.push({ ...file, connectedFolderId: record.owner.connectedFolderId, connectedFolderName: record.owner.connectedFolderName ?? "Connected Folder" });
        }
        result = { summary: envelope.summary, outcome: record.state === "partial" ? "partial" : envelope.outcome, files };
      } else detail = "The selected result could not be read. Its receipt remains; try again or open the Chat.";
    }
  }
  // Direct-child reports are deliberately released deliverables. AmpleFile Agent
  // requests have no Connected Folder file root of their own; retain each file's origin.
  if (isAmpleFileRequestTerminalState(record.state) && record.state !== "stopped" && record.state !== "expired") {
    const files = result?.files ?? [];
    const seen = new Set(files.map((file) => `${file.connectedFolderId}:${file.path}`));
    for (const child of state.requests.children(record.requestId)) {
      const childTurn = child.turns.at(-1)!;
      const selected = [...child.results].reverse().find((item) => item.taskId === childTurn.taskId);
      if (!selected || !child.owner.connectedFolderId) continue;
      const read = await state.requests.result(selected.resultId);
      if (read?.state !== "ok") continue;
      for (const file of read.record.envelope.files ?? []) {
        const key = `${child.owner.connectedFolderId}:${file.path}`;
        if (seen.has(key)) continue;
        seen.add(key); files.push({ ...file, connectedFolderId: child.owner.connectedFolderId, connectedFolderName: child.owner.connectedFolderName ?? "Connected Folder" });
      }
    }
    if (files.length && !result) result = { summary: "Files from the completed work.", outcome: record.state === "done" ? "succeeded" : record.state === "partial" ? "partial" : "failed", files };
  }
  return { version: 1, requestId: record.requestId, taskId: latest.taskId, owner: record.owner,
    state: record.state, label: inBackground ? "Running in the background" : workRequestLabel(record.state, questionCount - savedAnswerCount, savedAnswerCount), detail,
    canStop: outstanding && !record.stopRequestedAt, canContinue, questions, questionCount,
    hadQuestions: family.some((item) => item.questionIds.length > 0), result,
    ...(record.checklist?.items.length ? { checklist: record.checklist.items.map((item) => ({ ...item })) } : {}),
    children: state.requests.children(record.requestId).map((child) => ({ requestId: child.requestId,
      title: child.owner.connectedFolderName ?? "AmpleFile", state: child.state,
      label: workRequestLabel(child.state,
        state.requests.questions(child.requestId).filter((q) => q.respondent === "person" && q.state === "open").length,
        state.requests.questions(child.requestId).filter((q) => q.respondent === "person" && q.state === "answered" && !q.continuationTaskId).length) })) };
}

/** "running for 4 min" on the work line; whole minutes past the first. */
function formatRunningFor(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `running for ${minutes} min`;
  return `running for ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

async function performWorkAction(state: LocalApiState, record: AmpleFileRequestRecord, action: string, input: Record<string, unknown>): Promise<void> {
  const receipt = { requestId: `work-ui:${randomUUID()}`, command: action === "answer" ? "chat.answer" : action === "stop" ? "agent.stop" : "chat.send",
    surface: input.surface === "popover" ? "popover" as const : "main-window" as const };
  if (!await state.actReceipts.append({ ...receipt, outcome: "accepted" })) throw httpError(503, "Could not record this action. Please try again.");
  try {
    if (action === "stop") await stopAmpleFileAgentRequest(state, record.turns.at(-1)!.taskId);
    else if (action === "answer") {
      if (typeof input.questionId !== "string" || typeof input.answer !== "string" || !input.answer.trim()) throw badRequest("Write an answer before sending.");
      const question = state.requests.question(input.questionId);
      const family = [record, ...state.requests.subtree(record.requestId)];
      const owner = question && family.find((item) => item.requestId === question.requestId);
      if (!question || !owner || question.respondent !== "person") throw notFound("That question does not belong to this work.");
      // A retry after a lost response acknowledges the existing delivery.
      if (question.state === "answered" && question.continuationTaskId && question.answer === input.answer.trim()) {
        await state.actReceipts.append({ ...receipt, outcome: "ok", detail: `request ${record.requestId}; answer already delivered` });
        return;
      }
      const facade = createAmpleFileActFacade(state);
      if (owner.owner.connectedFolderId) await facade.chatAnswer({ connectedFolder: owner.owner.connectedFolderId, questionId: question.questionId, answer: input.answer });
      else await facade.agentAnswer({ questionId: question.questionId, answer: input.answer });
    } else if (action === "continue") {
      const deliveryId = workDeliveryId(input.deliveryId);
      const view = await requestPresentation(state, record);
      const replay = record.turns.some((turn) => state.turnStore.get(turn.taskId)?.requestId === deliveryId);
      if (!view.canContinue && !replay) throw httpError(409, "This work cannot continue here. Open the Chat for its current state.");
      const connectedFolder = record.owner.connectedFolderId ? await getConnectedFolder(record.owner.connectedFolderId) : ampleFileAgentScope(state);
      await acceptConversationTurn(state, { id: record.owner.connectedFolderId ?? ampleFileAgentScopeId, connectedFolderRoot: "connectedFolderRoot" in connectedFolder ? connectedFolder.connectedFolderRoot : connectedFolder.rootPath }, record.owner.conversationId, {
        content: await composeContinuationMessage(state, record, state.requests.children(record.requestId)), contextPaths: [],
        releasedChildTaskIds: state.requests.children(record.requestId).map((child) => child.turns.at(-1)!.taskId),
        actorKind: "system", requestId: deliveryId, request: { joinRequestId: record.requestId },
      });
    } else throw badRequest("Unknown work action.");
    await state.actReceipts.append({ ...receipt, outcome: "ok", detail: `request ${record.requestId}` });
  } catch (error) {
    await state.actReceipts.append({ ...receipt, outcome: "error", detail: errorMessage(error) }).catch(() => false);
    throw error;
  } finally { publishControlHint(state, "connected-folders"); }
}

/** The id a Continue click carries, so a retried click starts its turn once. */
function workDeliveryId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw badRequest("A valid delivery id is required.");
  }
  return value;
}

/** Bounded, addressed delivery for every owner; never replayed on startup. */
async function maybeStartRequestContinuation(state: LocalApiState, requestId: string): Promise<void> {
  if (!state.requests.continuationsEnabled() || !state.acceptingTurns) return;
  const request = state.requests.get(requestId);
  if (!request || request.stopRequestedAt || request.state === "stopped" || request.state === "expired" || request.limitHit) return;
  const scopeId = request.owner.connectedFolderId ?? ampleFileAgentScopeId;
  if (scopeId === ampleFileAgentScopeId && state.ampleFileAgentInstructionsError) return;
  const own = request.turns.at(-1)!;
  if (own.state === "accepted" || own.state === "running" || own.state === "aborted") return;
  if (state.requests.questions(requestId).some((q) => q.state === "open" || (q.state === "answered" && q.continuationTaskId === null))) return;
  const key = clientKey(scopeId, request.owner.conversationId);
  if (state.runningTurns.has(key) || state.compactingConversations.has(key)) return;
  // Nested owners synthesize before their parent wakes, so delegated results
  // wait for the whole branch. A finished background job is this request's
  // own work and does not wait for delegated children (docs/background-jobs.md).
  const childrenBusy = state.requests.subtree(requestId).some((child) => child.continuationState === "pending"
    || child.turns.some((turn) => turn.state === "accepted" || turn.state === "running"));
  const batch = childrenBusy ? [] : state.requests.children(requestId).filter((child) => {
    const turn = child.turns.at(-1)!;
    return turn.settledAt !== null && state.turnsSettledThisRun.has(turn.taskId)
      && !request.deliveredChildTaskIds.includes(turn.taskId);
  });
  const jobs = undeliveredSettledJobs(state, request);
  if (!batch.length && !jobs.length) return;
  // Compose before claiming: a read failure has not accepted a delivery.
  const content = await composeContinuationMessage(state, request, batch, jobs);
  const connectedFolder = request.owner.connectedFolderId ? await getConnectedFolder(request.owner.connectedFolderId)
    : { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentScope(state).rootPath };
  const note = await state.requests.noteContinuation(requestId, batch.map((child) => child.turns.at(-1)!.taskId), jobs.map((job) => job.jobId));
  if (!note.allowed) return;
  let followUpTaskId: string | null = null;
  try {
    const accepted = await acceptConversationTurn(state, connectedFolder, request.owner.conversationId, {
      content, contextPaths: [], actorKind: "system",
      ...(request.owner.connectedFolderId ? {} : { ampleFileAgentAttachments: [] }),
      requestId: `continuation-${requestId}-${note.count}`,
      request: { joinRequestId: requestId },
    });
    followUpTaskId = accepted.taskId;
  } catch (error) {
    await state.requests.failContinuation(requestId);
    console.error(`Request ${requestId} could not start its follow-up turn: ${errorMessage(error)}`);
  }
  // Reserved above whether or not the turn started: an end is delivered at
  // most once, and a follow-up that could not start is not retried.
  await deliverBackgroundJobs(state, jobs, "follow_up", followUpTaskId);
}

/**
 * The continuation's message: deterministic, bounded, no model call. It
 * names each settled child, its reported outcome or failure, the files it
 * named, and any question still open beneath it, then points at the record.
 */
async function composeContinuationMessage(
  state: LocalApiState,
  root: AmpleFileRequestRecord,
  batch: AmpleFileRequestRecord[],
  jobs: AmpleFileJobRecord[] = [],
): Promise<string> {
  const jobsFinished = jobs.length === 1 ? "a background job this Chat started has finished" : `${jobs.length} background jobs this Chat started have finished`;
  const lines: string[] = [
    !jobs.length
      ? `AmpleFile is continuing request ${root.requestId}: selected results or questions from work it handed out are ready. Nobody typed this message.`
      : !batch.length
        ? `AmpleFile is continuing request ${root.requestId}: ${jobsFinished}. Nobody typed this message.`
        : `AmpleFile is continuing request ${root.requestId}: ${jobsFinished}, and selected results or questions from work it handed out are ready. Nobody typed this message.`,
    "",
  ];
  for (const child of batch) {
    const turn = child.turns.at(-1)!;
    const where = `${child.owner.connectedFolderName ?? child.owner.connectedFolderId ?? "a Connected Folder"} [${child.owner.connectedFolderId ?? ""}]`;
    const ref = [...child.results].reverse().find((result) => result.taskId === turn.taskId);
    const newest = ref ? await state.requests.result(ref.resultId) : null;
    if (ref && newest?.state !== "ok") throw new Error("The selected child result is unavailable; its receipt remains on record.");
    const unsuccessful = turn.state === "failed" || turn.state === "aborted"
      || child.state === "failed" || child.state === "stopped" || child.state === "expired";
    const outcome = unsuccessful
      ? `${child.state === "waiting" ? turn.state : child.state}${turn.error ? `: ${turn.error}` : ""}`
      : newest?.state === "ok"
      ? `${child.state === "partial" ? "partial" : newest.record.envelope.outcome}: ${newest.record.envelope.summary}`
      : turn.state === "succeeded"
        ? "finished without a report"
        : `${turn.state}${turn.error ? `: ${turn.error}` : ""}`;
    lines.push(`- ${where} — Chat ${child.owner.conversationId}, task ${turn.taskId} — ${outcome}`);
    const files = newest?.state === "ok" ? newest.record.envelope.files ?? [] : [];
    if (files.length) {
      lines.push(`  files: ${files.map((file) => file.path).join(", ")}`);
    }
    for (const question of state.requests.questions(child.requestId).filter((candidate) => candidate.state === "open")) {
      const to = question.respondent === "person"
        ? "the person"
        : child.parentRequestId === root.requestId
          ? "you"
          : "the request above it";
      lines.push(`  waiting on ${to}: question ${question.questionId} — ${question.text}`);
      if (to === "you" && child.owner.connectedFolderId) {
        lines.push(`    answer it with: amplefile chat answer --connected-folder ${child.owner.connectedFolderId} --question ${question.questionId} --answer "<text>" --parent-task <this-request-task-id> --json`);
      }
    }
  }
  if (jobs.length) {
    if (batch.length) lines.push("");
    lines.push(...await composeBackgroundJobLines(state, jobs));
  }
  const jobsClosing = "Read more of a job's output with job_output if you need it.";
  lines.push(
    "",
    batch.length
      ? `${root.owner.connectedFolderId
        ? "Bring these selected results together for your assignment. Answer questions addressed to you. Submit any needed chat report before your final reply, then give the complete useful answer in that reply. Child files remain in their source Connected Folder until explicitly copied."
        : `The whole record: amplefile requests show --request ${root.requestId} --json. Bring these results together for the person; answer what is yours to answer; if the request is finished, say so and end your turn.`}${jobs.length ? ` ${jobsClosing}` : ""}`
      : root.owner.connectedFolderId
        ? `Carry on with the work ${jobs.length === 1 ? "this job was" : "these jobs were"} part of. ${jobsClosing} Submit any needed chat report before your final reply, then give the complete useful answer in that reply.`
        : `Carry on with the work ${jobs.length === 1 ? "this job was" : "these jobs were"} part of. ${jobsClosing} Tell the person how it went; if the request is finished, say so and end your turn.`,
  );
  return clampUtf8(lines.join("\n"), ampleFileAutomationDeclarationBounds.maxResolvedMessageBytes);
}

// ---------------------------------------------------------------------------
// Background jobs (docs/background-jobs.md): the host side of the job
// service — what a job means for its request, the kernel, History, the Chat
// that started it, and the one follow-up turn its end may start.
// ---------------------------------------------------------------------------

const maxJobsRememberedThisRun = 4_000;

function createBackgroundJobService(state: LocalApiState, store: AmpleFileJobStore): AmpleFileJobService {
  return new AmpleFileJobService({
    store,
    ports: {
      // Journal-first in both records: the request knows about the job before
      // its process exists, and a stopped request refuses it.
      beforeSpawn: async (job) => {
        await state.requests.noteJobStarted({ taskId: job.taskId, jobId: job.jobId, name: job.name, startedAt: job.createdAt, ...(job.service ? { service: true } : {}) });
        state.kernel.startExperimentalJobTask({
          jobId: job.jobId,
          name: job.name,
          conversationId: job.conversationId,
          ...(job.connectedFolderId ? { connectedFolderId: job.connectedFolderId } : {}),
          actor: { kind: job.surface === "cli" ? "cli" : "assistant" },
        });
      },
      stopRequested: (job) => Boolean(state.requests.byJobId(job.jobId)?.stopRequestedAt),
      captureHistory: (job) => captureBackgroundJobHistory(job),
      afterSettle: (job) => {
        state.kernel.finishTask(job.jobId);
        if (!job.service) queueBackgroundJobSettle(state, job);
        else void settleBackgroundJobOnRequest(state, job);
      },
    },
  });
}

function requestJobState(jobState: AmpleFileJobRecord["state"]): Exclude<AmpleFileRequestJobState, "running"> {
  return jobState === "accepted" || jobState === "running" ? "interrupted" : jobState;
}

/** The turn's own checkpoint came before the job ended; this one covers its later writes. */
async function captureBackgroundJobHistory(job: AmpleFileJobRecord): Promise<AmpleFileJobHistory> {
  if (!job.connectedFolderId) return { status: "not_applicable", reason: "the AmpleFile Agent's working folder has no History." };
  let connectedFolder: ConnectedFolderSummary;
  try {
    connectedFolder = await getConnectedFolder(job.connectedFolderId);
  } catch {
    return { status: "unavailable", reason: "its Connected Folder is no longer registered." };
  }
  const checkpoint = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, {
    reason: "background_job",
    label: `After background job: ${job.name}`,
  });
  const summary = connectedFolderTurnHistory(checkpoint);
  return summary.status === "captured" ? summary : { status: "unavailable", reason: "History could not save a checkpoint." };
}

/**
 * On the request settle chain: decide the follow-up first, then settle the
 * job on its request. A reserved follow-up keeps the request working, so it
 * never reads done between a job's end and the turn that reports it.
 */
function queueBackgroundJobSettle(state: LocalApiState, job: AmpleFileJobRecord): void {
  state.jobsSettledThisRun.add(job.jobId);
  while (state.jobsSettledThisRun.size > maxJobsRememberedThisRun) {
    const oldest = state.jobsSettledThisRun.values().next().value;
    if (oldest === undefined) break;
    state.jobsSettledThisRun.delete(oldest);
  }
  state.requestSettleChain = state.requestSettleChain
    .then(() => evaluateRequestGraphSettle(state, job.taskId))
    .catch((error: unknown) => {
      console.error(`A background job's follow-up could not be evaluated: ${errorMessage(error)}`);
    })
    .then(() => settleBackgroundJobOnRequest(state, job));
}

async function settleBackgroundJobOnRequest(state: LocalApiState, job: AmpleFileJobRecord): Promise<void> {
  await state.requests.settleJob(job.jobId, {
    state: requestJobState(job.state),
    exitCode: job.exitCode,
    ...(job.settledAt ? { settledAt: job.settledAt } : {}),
  }).catch((error: unknown) => console.error(`A background job's end could not reach its request: ${errorMessage(error)}`));
}

/** Finished jobs of this request whose end has not reached its Chat, settled in this run only. */
function undeliveredSettledJobs(state: LocalApiState, request: AmpleFileRequestRecord): AmpleFileJobRecord[] {
  const delivered = new Set(request.deliveredJobIds ?? []);
  // The job journal decides "ended"; the request's own reference settles
  // after this decision (queueBackgroundJobSettle).
  return (request.jobs ?? []).flatMap((ref) => {
    if (ref.service) return [];
    if (delivered.has(ref.jobId) || !state.jobsSettledThisRun.has(ref.jobId)) return [];
    const job = state.jobs.get(ref.jobId);
    return job && isAmpleFileJobTerminalState(job.state) && job.settledAt && !job.delivery ? [job] : [];
  });
}

/** One delivery per job's end, recorded in the job journal and on its request. */
async function deliverBackgroundJobs(
  state: LocalApiState,
  jobs: readonly AmpleFileJobRecord[],
  by: "read" | "turn_context" | "follow_up",
  taskId: string | null,
): Promise<void> {
  for (const job of jobs) {
    await state.jobs.markDelivered(job.jobId, by, taskId).catch(() => null);
    await state.requests.noteJobDelivery(job.requestId, [job.jobId]).catch(() => undefined);
  }
}

/** Each finished job's state, History, and the end of its output, for a follow-up message. */
async function composeBackgroundJobLines(state: LocalApiState, jobs: readonly AmpleFileJobRecord[]): Promise<string[]> {
  const lines: string[] = [];
  const now = new Date();
  for (const job of jobs) {
    const { output } = await state.jobs.read(job.jobId);
    const command = job.command.split("\n", 1)[0]!;
    lines.push(
      `- Background job ${job.jobId} ${JSON.stringify(job.name)} — ${describeJobState(job, now)}`,
      `  command: ${clampUtf8(command, 2_000)}${job.command.includes("\n") ? " …" : ""}`,
      `  ${describeJobHistory(job.history)}`,
      `  ${describeJobOutputRead(output)}${output.text && output.truncated ? " The end follows." : ""}`,
    );
    if (output.text) lines.push("", fenceJobOutput(output.text), "");
  }
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The jobs a new turn's context names: this Chat's running jobs, and ones
 * that finished in this run without reaching the Chat yet, which this turn
 * now delivers. Delivery reserved by a follow-up is respected.
 */
async function backgroundJobsForTurn(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  taskId: string,
): Promise<NonNullable<import("./agent/pi-client.js").PiTurnContext["backgroundJobs"]>> {
  const jobs = state.jobs.list({ connectedFolderId: connectedFolderId === ampleFileAgentScopeId ? null : connectedFolderId, conversationId });
  if (!jobs.length) return [];
  const now = new Date();
  const ending = jobs.filter((job) => !isAmpleFileJobTerminalState(job.state) || job.settledAt === null);
  const finished = jobs.filter((job) => isAmpleFileJobTerminalState(job.state) && job.settledAt !== null && !job.delivery
    && state.jobsSettledThisRun.has(job.jobId)
    && !(state.requests.get(job.requestId)?.deliveredJobIds ?? []).includes(job.jobId));
  await deliverBackgroundJobs(state, finished, "turn_context", taskId);
  return [
    ...ending.map((job) => ({ jobId: job.jobId, name: job.name, status: describeJobState(job, now), finished: false })),
    ...finished.map((job) => ({ jobId: job.jobId, name: job.name, status: describeJobState(job, now), finished: true })),
  ];
}

/**
 * Starts a job for a running turn, through the tools or the CLI, and
 * attributes the act to that turn's request. Both surfaces end up here.
 */
async function startBackgroundJob(state: LocalApiState, input: {
  interactive?: boolean;
  service?: boolean;
  taskId: string;
  command: string;
  name?: string;
  cwd: string;
  timeoutSeconds?: number;
  surface: "tool" | "cli";
  shell?: AmpleFileJobShell;
}): Promise<AmpleFileJobRecord> {
  const request = state.requests.byTaskId(input.taskId);
  if (!request || !state.requests.isAccepting(input.taskId)) {
    throw new AmpleFileRequestLineageError("A background job starts only from a running turn of its own request.");
  }
  const job = await state.jobs.start({
    owner: {
      conversationId: request.owner.conversationId,
      ...(request.owner.connectedFolderId ? { connectedFolderId: request.owner.connectedFolderId } : {}),
      ...(request.owner.connectedFolderName ? { connectedFolderName: request.owner.connectedFolderName } : {}),
    },
    taskId: input.taskId,
    requestId: request.requestId,
    command: input.command,
    ...(input.interactive ? { interactive: true } : {}),
    ...(input.service ? { service: true } : {}),
    ...(input.name ? { name: input.name } : {}),
    cwd: input.cwd,
    ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
    surface: input.surface,
    ...(input.shell ? { shell: input.shell } : {}),
  });
  await state.requests.recordAction(input.taskId, {
    command: "jobs.start",
    at: new Date().toISOString(),
    ...(request.owner.connectedFolderId ? { connectedFolderId: request.owner.connectedFolderId } : {}),
    ...(request.owner.connectedFolderName ? { connectedFolderName: request.owner.connectedFolderName } : {}),
    conversationId: request.owner.conversationId,
    taskId: input.taskId,
  }).catch(() => null);
  return job;
}

/** Stops one job and attributes the stop to the turn that asked, when one did. */
async function stopBackgroundJob(state: LocalApiState, jobId: string, cause: "agent" | "cli", taskId?: string): Promise<AmpleFileJobRecord> {
  const job = await state.jobs.stop(jobId, cause);
  if (taskId) {
    await state.requests.recordAction(taskId, {
      command: "jobs.stop",
      at: new Date().toISOString(),
      ...(job.connectedFolderId ? { connectedFolderId: job.connectedFolderId } : {}),
      ...(job.connectedFolderName ? { connectedFolderName: job.connectedFolderName } : {}),
      conversationId: job.conversationId,
      taskId: job.taskId,
    }).catch(() => null);
  }
  return job;
}

/** A job addressed through a Connected Folder must belong to it. */
function ownedJob(state: LocalApiState, connectedFolderId: string, jobId: string): AmpleFileJobRecord {
  const job = state.jobs.get(jobId.trim());
  if (!job || job.connectedFolderId !== connectedFolderId) {
    throw new AmpleFileCliError("notFound", `That background job is not on record in this Connected Folder. Finished jobs are kept for ${state.requests.retentionDays()} days.`);
  }
  return job;
}

/** Job refusals keep their own sentences: a bound is a conflict, an unknown job is not found. */
async function runJobOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AmpleFileCliError) throw error;
    if (error instanceof AmpleFileJobLimitError) throw new AmpleFileCliError("conflict", error.message, { cause: error });
    if (error instanceof AmpleFileJobNotFoundError) throw new AmpleFileCliError("notFound", error.message, { cause: error });
    if (error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError) throw collaborationRefusal(error);
    const message = errorMessage(error);
    if (/needs a command|does not exist|timeout must|command can be at most|NUL character/.test(message)) {
      throw new AmpleFileCliError("usage", message, { cause: error });
    }
    throw new AmpleFileCliError("failure", message, { cause: error });
  }
}

function toActJobRef(job: AmpleFileJobRecord): AmpleFileActJobRef {
  return {
    jobId: job.jobId,
    name: job.name,
    command: job.command,
    ...(job.interactive ? { interactive: true } : {}),
    ...(job.service ? { service: true } : {}),
    cwd: job.cwd,
    state: job.state,
    status: describeJobState(job, new Date()),
    conversationId: job.conversationId,
    taskId: job.taskId,
    requestId: job.requestId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    stoppedBy: job.stoppedBy,
    error: job.error,
    timeoutSeconds: job.timeoutSeconds,
    output: { ...job.output },
    history: job.history ? structuredClone(job.history) : null,
    delivery: job.delivery ? { ...job.delivery } : null,
  };
}

/** job_start, job_output, and job_stop for one Chat: jobs of this scope only. */
function createBackgroundJobToolHost(state: LocalApiState, scopeId: string, conversationId: string): BackgroundJobToolHost {
  const connectedFolderId = scopeId === ampleFileAgentScopeId ? undefined : scopeId;
  const owned = (jobId: string): AmpleFileJobRecord => {
    const job = state.jobs.get(jobId);
    if (!job || (job.connectedFolderId ?? null) !== (connectedFolderId ?? null)) {
      throw new AmpleFileJobNotFoundError(connectedFolderId
        ? "That background job is not on record in this Connected Folder."
        : "That background job is not one of the AmpleFile Agent's.");
    }
    return job;
  };
  return {
    start: (input) => startBackgroundJob(state, { ...input, surface: "tool" }),
    input: async ({ taskId, jobId, text, eof }) => {
      owned(jobId);
      if (!state.requests.isAccepting(taskId)) throw new Error("Terminal input requires your own running turn.");
      await state.requests.recordAction(taskId, { command: "jobs.input", at: new Date().toISOString(), ...(connectedFolderId ? { connectedFolderId } : {}), conversationId, taskId });
      return state.jobs.input(jobId, text, eof);
    },
    list: () => ({
      here: state.jobs.list({ connectedFolderId: connectedFolderId ?? null, conversationId }),
      elsewhere: state.jobs.list({ connectedFolderId: connectedFolderId ?? null, running: true }).filter((job) => job.conversationId !== conversationId),
    }),
    read: async ({ taskId, jobId, offset, limit }) => {
      owned(jobId);
      const result = await state.jobs.read(jobId, { ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) });
      // Reading a finished job in its own Chat is its delivery; no follow-up repeats it.
      if (result.job.conversationId === conversationId && isAmpleFileJobTerminalState(result.job.state) && result.job.settledAt) {
        await deliverBackgroundJobs(state, [result.job], "read", taskId);
      }
      return result;
    },
    wait: ({ jobId, ...rest }) => {
      owned(jobId);
      return state.jobs.wait(jobId, rest);
    },
    stop: async ({ taskId, jobId }) => {
      owned(jobId);
      return await stopBackgroundJob(state, jobId, "agent", taskId);
    },
  };
}

/** Cuts on a byte bound and drops a trailing partial character rather than storing a replacement glyph. */
function clampUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes - Buffer.byteLength("…"))).toString("utf8").replace(/�+$/u, "")}…`;
}

function conversationRuntimeState(state: LocalApiState, connectedFolderId: string, conversationId: string): AmpleFileActChatState {
  const key = clientKey(connectedFolderId, conversationId);
  if (state.runningTurns.has(key)) return "running";
  if (state.compactingConversations.has(key)) return "compacting";
  return "idle";
}

function toActConnectedFolderRef(connectedFolder: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">): AmpleFileActConnectedFolderRef {
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

function toActChatMessage(message: ChatMessage): AmpleFileActChatMessage {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    createdAt: message.createdAt,
    ...(message.interruption ? { interrupted: true } : {}),
  };
}

function pathContainsPath(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function runAgentTurn(
  state: LocalApiState,
  connectedFolderId: string,
  connectedFolderRoot: string,
  conversationId: string,
  content: string,
  contextPaths: string[],
  taskId: string,
  options: {
    ampleFileAgentAttachments?: AmpleFileAgentAttachmentRef[];
    /** The task that delegated this Connected Folder turn; decorates its context, never its acceptance. */
    parentTaskId?: string;
    /** The assignment when it differs from this turn's message. */
    assignment?: string;
    /** The question this turn's message answers, when it is a continuation. */
    answeredQuestionId?: string;
    /** Connected Folder Workers the person addressed with @ in this message. */
    addressedConnectedFolderIds?: string[];
    /** The automation that sent this message; nobody is watching the turn. */
    automation?: { title: string };
  } = {},
): Promise<void> {
  const { ampleFileAgentAttachments, answeredQuestionId } = options;
  const request = state.requests.byTaskId(taskId);
  const parentTaskId = request?.parentTaskId ?? options.parentTaskId;
  const assignment = request?.assignment ?? options.assignment;
  const key = clientKey(connectedFolderId, conversationId);
  let client: PiConversationClient | null = null;
  let promptStarted = false;
  let settledStatus: SettledTurnRecord["status"] = "succeeded";
  // Quitting mid-turn is recorded like a crash (interrupted), never as a Stop the person asked for.
  let closedByApp = false;
  let settledMessageId: string | undefined;
  let settledError: string | undefined;
  let capturedWorkTrail: ReturnType<PiConversationClient["getTurnWorkTrail"]> = [];
  let capturedPresentation: ReturnType<PiConversationClient["getTurnPresentation"]>;
  let beforeCheckpoint: import("./history.js").ConnectedFolderCheckpoint | null = null;
  let afterCheckpoint: import("./history.js").ConnectedFolderCheckpoint | null = null;
  changeTurnCount(state, 1);
  try {
    client = await getClient(state, connectedFolderId, connectedFolderRoot, conversationId);
    const loadContextAttachments = (budgetTokens: number) => ampleFileAgentAttachments
      ? loadAmpleFileAgentAttachmentsForTurn(ampleFileAgentAttachments, budgetTokens)
      : loadConversationContextReferencesForTurn(connectedFolderRoot, contextPaths, budgetTokens);
    const attachedLinks = ampleFileAgentAttachments ? ampleFileAgentAttachmentLinks(ampleFileAgentAttachments) : [];
    const ampleFileAgentRegistry = connectedFolderId === ampleFileAgentScopeId
      ? (await state.kernel.getConnectedFolders({ kind: "renderer" })).connectedFolders
      : null;
    // Connected Folder turns read nesting from the registry file only — never listConnectedFolders(),
    // which rewrites every Connected Folder's portable manifest — and a failed read just
    // leaves the nesting context out instead of failing the turn.
    const registeredConnectedFolders: Array<{ id: string; name: string; connectedFolderRoot: string }> = ampleFileAgentRegistry
      ?? await registeredConnectedFolderOutline().catch(() => []);
    const ampleFileAgentConnectedFolders = ampleFileAgentRegistry
      ? ampleFileAgentRegistry.map((connectedFolder) => ({
          id: connectedFolder.id,
          name: connectedFolder.name,
          connectedFolderRoot: connectedFolder.connectedFolderRoot,
          ...(connectedFolder.parentConnectedFolderId ? { parentConnectedFolderId: connectedFolder.parentConnectedFolderId } : {}),
        }))
      : undefined;
    // Connected Folders inside Connected Folders: the person's @ mentions resolve to
    // the ids handoff and send take, and a parent's Worker learns which of
    // its own subfolders belong to another Worker.
    const addressedFolders = (options.addressedConnectedFolderIds ?? []).flatMap((id) => {
      const connectedFolder = registeredConnectedFolders.find((item) => item.id === id);
      return connectedFolder ? [{ connectedFolderId: connectedFolder.id, name: connectedFolder.name }] : [];
    });
    // A Connected Folder turn's own identity: its ids, and when delegated, an
    // opaque handle for the request that asked. Never for the AmpleFile Agent
    // scope, which carries the registry snapshot instead.
    const connectedFolderTurn = connectedFolderId === ampleFileAgentScopeId
      ? undefined
      : buildConnectedFolderTurnContext({
        connectedFolderId,
        taskId,
        requestId: resolveTurnRequestId(state, taskId),
        handleSalt: state.connectedFolderTurnHandleSalt,
        ...(answeredQuestionId ? { answeredQuestionId } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
        ...(assignment !== undefined && assignment !== content ? { assignment } : {}),
        ...(parentTaskId && (assignment === undefined || assignment === content) ? { assignmentIsThisMessage: true } : {}),
      });
    if (connectedFolderTurn && request) {
      const children = state.requests.children(request.requestId).filter((child) => {
        const latest = child.turns.at(-1)!;
        return latest.settledAt !== null && !request.deliveredChildTaskIds.includes(latest.taskId);
      });
      if (children.length) {
        connectedFolderTurn.releasedChildResults = await composeContinuationMessage(state, request, children);
        await state.requests.noteChildDelivery(request.requestId, children.map((child) => child.turns.at(-1)!.taskId));
      }
    }
    const backgroundJobs = await backgroundJobsForTurn(state, connectedFolderId, conversationId, taskId);
    beforeCheckpoint = await captureTurnCheckpointSafe(state, connectedFolderId, connectedFolderRoot, conversationId, "pre_turn");
    if (connectedFolderTurn) connectedFolderTurn.history = connectedFolderTurnHistory(beforeCheckpoint);
    const ownConnectedFolder = registeredConnectedFolders.find((item) => item.id === connectedFolderId);
    if (connectedFolderTurn && ownConnectedFolder) {
      const nested = [...childFolderPaths(ownConnectedFolder, registeredConnectedFolders)].map(([path, child]) => ({ connectedFolderId: child.id, name: child.name, path }));
      if (nested.length) connectedFolderTurn.nestedFolders = nested;
    }
    await state.beforeAgentPrompt?.({
      connectedFolderId, conversationId, taskId,
      ...(connectedFolderTurn ? { connectedFolderTurn } : {}),
      ...(options.automation ? { automation: options.automation } : {}),
    });
    throwIfTurnCancelled(state, taskId);
    promptStarted = true;
    const finalText = await client.prompt(content, {
      loadContextAttachments,
      ...(connectedFolderId === ampleFileAgentScopeId ? { ampleFileAgentTaskId: taskId } : {}),
      ...(ampleFileAgentConnectedFolders ? { ampleFileAgentConnectedFolders } : {}),
      ...(connectedFolderTurn ? { connectedFolderTurn } : {}),
      ...(attachedLinks.length ? { attachedLinks } : {}),
      ...(addressedFolders.length ? { addressedFolders } : {}),
      ...(options.automation ? { automation: options.automation } : {}),
      ...(backgroundJobs.length ? { backgroundJobs } : {}),
      // A later turn of the same request picks up the checklist where it was left.
      ...(request?.checklist?.items.length ? { checklist: request.checklist.items } : {}),
    });
    // Capture synchronously with prompt completion. Shutdown may dispose the
    // client while the server awaits checkpoint persistence below.
    capturedPresentation = parseAssistantPresentation(client.getTurnPresentation(), finalText);
    capturedWorkTrail = client.getTurnWorkTrail();
    promptStarted = false;
    afterCheckpoint = await captureTurnCheckpointSafe(state, connectedFolderId, connectedFolderRoot, conversationId, "post_turn");
    await flushTurnCheckpoint(state, key, taskId);
    const durable = state.turnStore.get(taskId);
    const workTrail = capturedWorkTrail;
    const assistantMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: finalText,
      ...(capturedPresentation ? { assistantPresentation: capturedPresentation } : {}),
      createdAt: new Date().toISOString(),
      turnId: taskId,
      ...(durable?.requestId ? { requestId: durable.requestId } : {}),
      ...(workTrail.length ? { workTrail } : {}),
    };
    await appendMessage(connectedFolderRoot, conversationId, assistantMessage);
    settledMessageId = assistantMessage.id;
    try {
      const transcript = await readConversation(connectedFolderRoot, conversationId);
      if (conversationNeedsGeneratedTitle(transcript)) {
        // Record the one naming attempt before the isolated request. A crash or
        // provider failure must not turn every later Chat turn into another
        // hidden title request.
        await markConversationTitleAttempted(connectedFolderRoot, conversationId);
        const firstUserMessage = transcript.find((message) => message.role === "user")?.content;
        const modelTitle = firstUserMessage
          ? normalizeGeneratedConversationTitle(
            await client.generateConversationTitle(firstUserMessage, finalText),
          )
          : null;
        if (modelTitle) {
          const titledConversation = await setGeneratedConversationTitle(connectedFolderRoot, conversationId, modelTitle);
          client.setSessionName(titledConversation.title);
        }
      }
    } catch (error) {
      // Naming is deliberately best-effort: a title provider failure must not
      // turn a successfully persisted agent response into a failed turn.
      console.warn(`Could not persist a generated Chat title: ${errorMessage(error)}`);
    }
  } catch (error) {
    // A reused client still holds its previous turn until prompt resets it.
    // Pre-prompt cancellation/failure must never inherit that turn's evidence.
    if (promptStarted) {
      capturedPresentation ??= client?.getTurnPresentation();
      capturedWorkTrail = client?.getTurnWorkTrail() ?? [];
    }
    const cancelled = isPiTurnCancelledError(error);
    closedByApp = cancelled && !state.cancelledTurnTasks.has(taskId) && !state.acceptingTurns;
    if (promptStarted) {
      promptStarted = false;
      afterCheckpoint = await captureTurnCheckpointSafe(state, connectedFolderId, connectedFolderRoot, conversationId, "post_turn");
    }
    await flushTurnCheckpoint(state, key, taskId);
    const durable = state.turnStore.get(taskId);
    let failureResultPreserved = false;
    if (!cancelled) {
      console.warn(`Turn failed in ${connectedFolderId}/${conversationId}: ${providerCreditFailureDetail(error) ?? errorMessage(error)}`);
    }
    const publicDetail = closedByApp
      ? appClosedTurnDetail
      : cancelled
        ? "The agent was stopped before it completed this response."
        : assistantFailurePublicDetail(error);
    const workTrail = capturedWorkTrail;
    const interruptedContent = closedByApp
      ? durable?.assistantText.trim() || appClosedTurnDetail
      : assistantFailureTranscriptContent(error, durable?.assistantText ?? "", cancelled);
    const interruptedPresentation = parseAssistantPresentation(capturedPresentation, interruptedContent);
    const interruptedMessage = {
      id: randomUUID(),
      role: "assistant" as const,
      content: interruptedContent,
      ...(interruptedPresentation ? { assistantPresentation: interruptedPresentation } : {}),
      createdAt: new Date().toISOString(),
      turnId: taskId,
      ...(durable?.requestId ? { requestId: durable.requestId } : {}),
      ...(workTrail.length ? { workTrail } : {}),
      interruption: {
        reason: closedByApp ? "app_interrupted" as const : cancelled ? "cancelled" as const : assistantFailureReason(error),
        message: publicDetail,
        retryAttempts: error instanceof PiTurnFailure ? error.retryAttempts : 0,
        provider: error instanceof PiTurnFailure ? error.provider : null,
        model: error instanceof PiTurnFailure ? error.model : null,
        activities: error instanceof PiTurnFailure ? error.activities : [],
      },
    };
    try {
      await appendMessage(connectedFolderRoot, conversationId, interruptedMessage);
      failureResultPreserved = true;
      settledMessageId = interruptedMessage.id;
    } catch (preservationError) {
      console.error(`Could not preserve an interrupted Worker result: ${errorMessage(preservationError)}`);
    }
    const message = closedByApp ? appClosedTurnDetail : assistantTurnFailureMessage(error, failureResultPreserved);
    settledStatus = cancelled && !closedByApp ? "aborted" : "failed";
    settledError = message;
    // A provider failure settles the Pi session cleanly after its bounded retry
    // path. Keep that live session so the next user message can continue from
    // completed tool results. Unexpected runtime failures still rebuild the
    // client from the durable Pi session on the next turn.
    if (!(error instanceof PiTurnFailure)) {
      await client?.stop().catch(() => undefined);
      state.clients.delete(key);
    }
  } finally {
    if (promptStarted) afterCheckpoint = await captureTurnCheckpointSafe(state, connectedFolderId, connectedFolderRoot, conversationId, "post_turn");
    await flushTurnCheckpoint(state, key, taskId);
    const durableText = state.turnStore.get(taskId)?.assistantText ?? "";
    // Attribution, recorded with the outcome: the model that actually ran this
    // turn and what Pi reported it used.
    const turnUsage = client?.getTurnUsage() ?? null;
    await state.turnStore.settle(taskId, {
      status: closedByApp ? "interrupted" : settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
      assistantText: durableText,
      fileChanges: turnFileChanges(beforeCheckpoint, afterCheckpoint),
      ...(turnUsage ? { usage: turnUsage } : {}),
      ...(client?.getTurnHelperRuns().length ? { helpers: client.getTurnHelperRuns() } : {}),
    }).catch((error) => {
      console.error(`Could not persist turn settlement: ${errorMessage(error)}`);
      return null;
    });
    // The request record settles with the same outcome and usage, before the
    // task-scoped record, so a waiter or the overview reads a current request
    // state on the next tick.
    await state.requests.settleTurn(taskId, {
      status: closedByApp ? "interrupted" : settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
      ...(turnUsage ? { usage: turnUsage } : {}),
      ...(client?.getTurnHelperRuns().length ? { helpers: client.getTurnHelperRuns() } : {}),
    }).catch((error: unknown) => {
      console.error(`Could not persist request settlement: ${errorMessage(error)}`);
      return null;
    });
    state.runningTurns.delete(key);
    state.cancelledTurnTasks.delete(taskId);
    state.activeTurnIdsByKey.delete(key);
    state.kernel.finishTask(taskId);
    // The Connected Folder's Worker instructions changed during this turn (Set up
    // for me). Rebuild this Chat's client so its next turn sees them.
    await refreshClientIfMarked(state, key);
    settleTurnTask(state, taskId, {
      connectedFolderId,
      conversationId,
      status: settledStatus,
      ...(settledMessageId ? { messageId: settledMessageId } : {}),
      ...(settledError ? { error: settledError } : {}),
    });
    broadcast(state, key, settledStatus === "succeeded"
      ? { type: "done", conversationId, turnId: taskId }
      : { type: "error", conversationId, turnId: taskId, message: settledError ?? "The turn did not finish." });
    broadcast(state, key, turnStateEvent(conversationId, false, taskId));
    changeTurnCount(state, -1);
    // A Stop, from any surface, holds the queued message: it stays for the
    // person to take back and no later turn's end sends it.
    const queued = state.queuedMessages.get(key);
    if (queued && settledStatus === "aborted") {
      if (!queued.held) {
        changeQueuedMessage(state, key, { ...queued, held: true });
        broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId));
      }
    } else if (queued && !queued.held) void sendQueuedMessage(state, connectedFolderId, connectedFolderRoot, conversationId, queued);
    else if (settledStatus === "succeeded") scheduleBackgroundCompaction(state, connectedFolderId, connectedFolderRoot, conversationId);
    // Once this turn's own settlement is fully visible, the request
    // graph above it may owe the AmpleFile Agent one continuation turn. Fire-and-forget
    // with its own catch, the way activeTurnPromises are: a settle never
    // fails because a continuation could not start.
    queueRequestGraphSettle(state, taskId);
  }
}

const maxSettledTurnRecords = 10_000;

/**
 * The request id a Connected Folder turn names in its context: the durable request
 * record's id when the store holds one, otherwise the turn journal's own
 * acceptance identity — for an undelegated Connected Folder turn that is its own root —
 * and finally the task id for a turn accepted before either existed. Nothing
 * here invents a request id.
 */
function resolveTurnRequestId(state: LocalApiState, taskId: string): string {
  return state.requests.byTaskId(taskId)?.requestId
    ?? state.turnStore.get(taskId)?.requestId
    ?? taskId;
}

interface QueuedChatMessage {
  content: string;
  /** Files attached in the composer, for a Connected Folder Chat. */
  contextPaths: string[];
  /** Workers the message addresses with @. */
  addressedConnectedFolderIds: string[];
  updatedAt: string;
  /** Set by a Stop: kept for the person to take back, never sent. A new queue write arms it again. */
  held?: true;
}

/** Every change to a Chat's queued message goes through here and gets the next number. */
function changeQueuedMessage(state: LocalApiState, key: string, next: QueuedChatMessage | null): number {
  state.lastQueueRevision += 1;
  state.queueRevisions.set(key, state.lastQueueRevision);
  if (next) state.queuedMessages.set(key, next);
  else state.queuedMessages.delete(key);
  return state.lastQueueRevision;
}

function queuedMessageEvent(state: LocalApiState, connectedFolderId: string, conversationId: string, sent?: QueuedChatMessage) {
  const key = clientKey(connectedFolderId, conversationId);
  const queued = state.queuedMessages.get(key);
  return {
    type: "queued_message" as const,
    conversationId,
    revision: state.queueRevisions.get(key) ?? 0,
    queued: queued ? { content: queued.content, updatedAt: queued.updatedAt, ...(queued.held ? { held: true } : {}) } : null,
    // The files that went out with a sent queued message, so windows unstage them.
    ...(sent ? { sentContextPaths: sent.contextPaths } : {}),
  };
}

/**
 * Replaces a Chat's queued message while its turn runs. A Chat with no running
 * turn is refused (409) so the caller sends the message now instead.
 */
function queueChatMessage(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  input: { content: string; contextPaths: string[]; addressedConnectedFolderIds: string[] },
): { queued: { content: string; updatedAt: string }; revision: number } {
  const key = clientKey(connectedFolderId, conversationId);
  if (!state.runningTurns.has(key)) throw httpError(409, "No turn is running in this Chat; send the message now.");
  const queued: QueuedChatMessage = { ...input, updatedAt: new Date().toISOString() };
  const revision = changeQueuedMessage(state, key, queued);
  broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId));
  return { queued: { content: queued.content, updatedAt: queued.updatedAt }, revision };
}

/** Removes a Chat's queued message and returns it, so it can go back to a composer. */
function cancelQueuedMessage(state: LocalApiState, connectedFolderId: string, conversationId: string): { queued: { content: string; updatedAt: string } | null; revision: number } {
  const key = clientKey(connectedFolderId, conversationId);
  const queued = state.queuedMessages.get(key);
  if (!queued) return { queued: null, revision: state.queueRevisions.get(key) ?? 0 };
  const revision = changeQueuedMessage(state, key, null);
  broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId));
  return { queued: { content: queued.content, updatedAt: queued.updatedAt }, revision };
}

/**
 * Sends a Chat's queued message as an ordinary new turn once the turn it
 * waited on has ended. If the Chat cannot take it yet (another turn started
 * first), it stays queued for the next turn's end.
 */
async function sendQueuedMessage(state: LocalApiState, connectedFolderId: string, connectedFolderRoot: string, conversationId: string, queued: QueuedChatMessage): Promise<void> {
  const key = clientKey(connectedFolderId, conversationId);
  if (!state.acceptingTurns || state.queuedMessages.get(key) !== queued) return;
  // Leaves the queue as it becomes the Chat's message, so no window shows both.
  changeQueuedMessage(state, key, null);
  broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId, queued));
  try {
    const agentScope = connectedFolderId === ampleFileAgentScopeId;
    await acceptConversationTurn(state, { id: connectedFolderId, connectedFolderRoot }, conversationId, {
      content: queued.content,
      contextPaths: agentScope ? [] : queued.contextPaths,
      actorKind: agentScope ? "renderer" : "assistant",
      ...(agentScope ? { ampleFileAgentAttachments: [] } : {}),
      ...(queued.addressedConnectedFolderIds.length ? { addressedConnectedFolderIds: queued.addressedConnectedFolderIds } : {}),
    });
  } catch (error) {
    console.warn(`A queued message stays queued: ${errorMessage(error)}`);
    if (!state.queuedMessages.has(key)) {
      changeQueuedMessage(state, key, queued);
      broadcast(state, streamKey(connectedFolderId, conversationId), queuedMessageEvent(state, connectedFolderId, conversationId));
    }
  }
}

interface BackgroundCompaction {
  timer: NodeJS.Timeout | null;
  /** Present while the summary is being written. */
  run: { client: PiConversationClient; done: Promise<void> } | null;
  /** Set when something that needs the Chat cancelled it; that is not a failure. */
  yielded: boolean;
}

/** How long a Chat stays idle after a reply before it is summarized ahead of time. */
function backgroundCompactionIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.AMPLEFILE_PI_BACKGROUND_COMPACTION_IDLE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000;
}

/**
 * Summarizes an idle Chat in the background once it nears Pi's own automatic
 * compaction point, so the next turn does not wait on that summary. It runs
 * as its own kernel compaction task, only on a client that already exists,
 * and only after the Chat has been quiet for a moment; anything that needs the Chat first calls
 * yieldBackgroundCompaction. A failed or cancelled summary changes nothing:
 * Pi still compacts mid-turn when it must.
 */
function scheduleBackgroundCompaction(state: LocalApiState, connectedFolderId: string, connectedFolderRoot: string, conversationId: string): void {
  const key = clientKey(connectedFolderId, conversationId);
  const pending = state.backgroundCompactions.get(key);
  if (pending?.run) return;
  if (pending?.timer) clearTimeout(pending.timer);
  const entry: BackgroundCompaction = { timer: null, run: null, yielded: false };
  entry.timer = setTimeout(() => {
    entry.timer = null;
    const client = state.clients.get(key);
    if (!client || !state.acceptingTurns || state.runningTurns.has(key) || state.compactingConversations.has(key)
      || state.capabilityMutations.size > 0 || !client.backgroundCompactionDue()) {
      if (state.backgroundCompactions.get(key) === entry) state.backgroundCompactions.delete(key);
      return;
    }
    const task = state.kernel.startTask({
      kind: "compaction",
      connectedFolderId,
      conversationId,
      actor: { kind: "system", cwd: connectedFolderRoot, connectedFolderId, conversationId },
    });
    const done = client.compact(undefined, { quiet: true })
      .catch((error: unknown) => {
        if (!entry.yielded) console.warn(`A background Chat summary did not finish: ${errorMessage(error)}`);
      })
      .finally(() => {
        state.kernel.finishTask(task.id);
        if (state.backgroundCompactions.get(key) === entry) state.backgroundCompactions.delete(key);
      });
    entry.run = { client, done };
  }, backgroundCompactionIdleMs());
  entry.timer.unref?.();
  state.backgroundCompactions.set(key, entry);
}

/** Cancels a Chat's pending or running background summary and waits for it to stop. */
async function yieldBackgroundCompaction(state: LocalApiState, key: string): Promise<void> {
  const entry = state.backgroundCompactions.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (!entry.run) {
    state.backgroundCompactions.delete(key);
    return;
  }
  entry.yielded = true;
  entry.run.client.abortCompaction();
  await entry.run.done;
}

const appClosedTurnDetail = "AmpleFile closed before this turn finished. It was not run again because completed tools may already have changed something.";

async function recoverDurableTurnState(state: LocalApiState): Promise<void> {
  const records = state.turnStore.list().sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  for (const record of records.filter((candidate) => candidate.status !== "accepted" && candidate.status !== "running").slice(-maxSettledTurnRecords)) {
    rememberDurableSettledTurn(state, record);
  }
  for (const record of records.filter((candidate) => candidate.status === "accepted" || candidate.status === "running")) {
    const rootPath = record.connectedFolderId === ampleFileAgentScopeId
      ? ampleFileAgentRoot()
      : await getConnectedFolder(record.connectedFolderId).then((connectedFolder) => connectedFolder.connectedFolderRoot).catch(() => null);
    if (!rootPath) {
      const settled = await state.turnStore.settle(record.turnId, {
        status: "interrupted",
        error: "The app closed before this turn finished, and its Connected Folder is no longer registered.",
      });
      if (settled) rememberDurableSettledTurn(state, settled);
      continue;
    }
    const messages = await readConversation(rootPath, record.conversationId).catch(() => []);
    const existingResponse = messages.find((message) => message.role === "assistant" && message.turnId === record.turnId);
    if (existingResponse) {
      const status = existingResponse.interruption?.reason === "cancelled"
        ? "aborted" as const
        : existingResponse.interruption ? "failed" as const : "succeeded" as const;
      const settled = await state.turnStore.settle(record.turnId, {
        status,
        messageId: existingResponse.id,
        ...(existingResponse.interruption ? { error: existingResponse.interruption.message } : {}),
      });
      if (settled) rememberDurableSettledTurn(state, settled);
      continue;
    }
    const userMessage = messages.find((message) => message.role === "user" && message.id === record.userMessageId);
    if (!userMessage) {
      const settled = await state.turnStore.settle(record.turnId, {
        status: "interrupted",
        error: "Turn acceptance was interrupted before the user message was saved.",
      });
      if (settled) rememberDurableSettledTurn(state, settled);
      continue;
    }
    const detail = appClosedTurnDetail;
    const recoveredMessage: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content: record.assistantText.trim() || detail,
      createdAt: new Date().toISOString(),
      turnId: record.turnId,
      requestId: record.requestId,
      interruption: {
        reason: "app_interrupted",
        message: detail,
        retryAttempts: 0,
        provider: null,
        model: null,
        activities: [],
      },
    };
    let messageId: string | undefined;
    try {
      await appendMessage(rootPath, record.conversationId, recoveredMessage);
      messageId = recoveredMessage.id;
    } catch (error) {
      console.error(`Could not append an interrupted Worker result during startup recovery: ${errorMessage(error)}`);
    }
    const settled = await state.turnStore.settle(record.turnId, {
      status: "interrupted",
      ...(messageId ? { messageId } : {}),
      error: detail,
    });
    if (settled) rememberDurableSettledTurn(state, settled);
  }
}

function rememberDurableSettledTurn(state: LocalApiState, record: AmpleFileDurableTurnRecord): void {
  const status: SettledTurnRecord["status"] = record.status === "succeeded"
    ? "succeeded"
    : record.status === "aborted" ? "aborted" : "failed";
  state.settledTurns.set(record.turnId, {
    taskId: record.turnId,
    connectedFolderId: record.connectedFolderId,
    conversationId: record.conversationId,
    status,
    endedAt: record.updatedAt,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.error ? { error: record.error } : {}),
  });
  while (state.settledTurns.size > maxSettledTurnRecords) {
    const oldest = state.settledTurns.keys().next().value;
    if (oldest === undefined) break;
    state.settledTurns.delete(oldest);
  }
}

function settleTurnTask(
  state: LocalApiState,
  taskId: string,
  record: Omit<SettledTurnRecord, "taskId" | "endedAt">,
): void {
  state.activeTurnTasks.delete(taskId);
  state.cancelledTurnTasks.delete(taskId);
  state.settledTurns.set(taskId, { taskId, endedAt: new Date().toISOString(), ...record });
  publishControlHint(state, "activity");
  while (state.settledTurns.size > maxSettledTurnRecords) {
    const oldest = state.settledTurns.keys().next().value;
    if (oldest === undefined) break;
    state.settledTurns.delete(oldest);
  }
}

function throwIfTurnCancelled(state: LocalApiState, taskId: string): void {
  // Closing stops a turn that has not prompted yet too. Stopping clients
  // reaches only a prompt already in flight; this turn would otherwise start a
  // fresh provider request on its stopped client, and close() would wait on it.
  const reason = state.cancelledTurnTasks.has(taskId)
    ? "Agent turn cancelled by the user."
    : state.acceptingTurns ? null : "The turn stopped because AmpleFile is closing.";
  if (!reason) return;
  const error = new Error(reason);
  error.name = "PiTurnCancelledError";
  throw error;
}

function assistantTurnFailureMessage(error: unknown, partialResponsePreserved: boolean): string {
  if (isPiTurnCancelledError(error)) return "Turn cancelled.";
  if (!(error instanceof PiTurnFailure)) return assistantFailurePublicDetail(error);
  const creditFailure = providerCreditFailureDetail(error);
  if (creditFailure) return partialResponsePreserved
    ? `${creditFailure} AmpleFile saved the partial response and completed activity below.`
    : `${creditFailure} AmpleFile could not save the partial response.`;
  const retrySummary = error.retryAttempts > 0
    ? ` after ${error.retryAttempts} automatic ${error.retryAttempts === 1 ? "retry" : "retries"}`
    : "";
  return partialResponsePreserved
    ? `The model stopped responding${retrySummary}. AmpleFile saved the partial response and completed activity below.`
    : `The model stopped responding${retrySummary}, and AmpleFile could not save the partial response.`;
}

function assistantFailureReason(error: unknown): "provider_error" | "setup_error" | "assistant_error" {
  if (error instanceof PiTurnFailure) return "provider_error";
  return isModelSetupError(error) ? "setup_error" : "assistant_error";
}

function assistantFailureTranscriptContent(error: unknown, checkpointText = "", cancelled = false): string {
  const checkpoint = checkpointText.trim();
  if (error instanceof PiTurnFailure) {
    return error.partialText || checkpoint || providerCreditFailureDetail(error) || "The model stopped responding before it could finish a response.";
  }
  if (checkpoint) return checkpoint;
  if (cancelled) return "The agent was stopped before it completed a response.";
  return assistantFailurePublicDetail(error);
}

function assistantFailurePublicDetail(error: unknown): string {
  if (error instanceof PiTurnDrainingError) return error.message;
  const creditFailure = providerCreditFailureDetail(error);
  if (creditFailure) return creditFailure;
  if (error instanceof PiTurnFailure) {
    const retrySummary = error.retryAttempts > 0
      ? ` after ${error.retryAttempts} automatic ${error.retryAttempts === 1 ? "retry" : "retries"}`
      : "";
    return `The model stopped responding${retrySummary}.`;
  }
  if (isModelSetupError(error)) {
    return "The Worker couldn’t reach an AI model. Connect an AI provider, or check the one in Settings → AI Models, then try again.";
  }
  if (isPiTurnTimeoutError(error)) {
    return `${errorMessage(error)} Raise or clear that limit to let long turns finish.`;
  }
  if (/timed?\s*out|timeout/i.test(errorMessage(error))) {
    return "The agent took too long to respond. Try again when you’re ready.";
  }
  return "The agent couldn’t complete this request. Try again. If it keeps happening, check Settings → AI Models.";
}

/** Preserve the actionable provider status without echoing its raw body, URLs or account data. */
function providerCreditFailureDetail(error: unknown): string | null {
  const message = errorMessage(error);
  const paymentRequired = /^\s*(?:HTTP(?:\/[\d.]+)?\s+)?402\b/i.test(message)
    || /"(?:code|status|statusCode)"\s*:\s*402\b/.test(message);
  if (!paymentRequired) return null;
  return "The model provider reported a credit or billing limit (HTTP 402). Check its available credit or reduce the maximum response length before trying again.";
}

function isModelSetupError(error: unknown): boolean {
  return /api[- ]?key|credential|auth(?:entication|orization)?|no (?:available |configured )?models?|model (?:was )?not (?:found|available|configured)|select (?:a )?model|choose (?:a )?(?:provider|model)|provider .{0,40}(?:not configured|unavailable)/i
    .test(errorMessage(error));
}

const managedWorktreeServices = new WeakMap<LocalApiState, ManagedWorktrees>();
function createWorktreeToolHost(state: LocalApiState, connectedFolderId: string): import("./agent/worktree-tool.js").WorktreeToolHost {
  let service = managedWorktreeServices.get(state);
  if (!service) { service = new ManagedWorktrees(join(ampleFileStateRoot(), "worktrees"), `${ampleFileStateRoot()}-working-copies`); managedWorktreeServices.set(state, service); }
  const facade = createAmpleFileActFacade(state);
  return { async invoke(taskId, input) {
    assertOwnTask(state, connectedFolderId, taskId);
    const ports = {
      register: async (path: string) => (await facade.registerConnectedFolder({ connectedFolderRoot: path })).connectedFolder.id,
      unregister: async (id: string, path: string) => {
        if (resolve((await getConnectedFolder(id)).connectedFolderRoot) !== resolve(path)) throw new Error("The managed Connected Folder registration changed.");
        await facade.connectedFoldersUnregister({ connectedFolder: id });
      },
    };
    if (input.action === "list") return service!.list(connectedFolderId);
    await state.requests.recordAction(taskId, { command: `worktrees.${input.action}`, at: new Date().toISOString(), connectedFolderId, taskId });
    if (input.action === "create") return service!.create(connectedFolderId, (await getConnectedFolder(connectedFolderId)).connectedFolderRoot, input.ref ?? "HEAD", ports.register);
    if (!input.id) throw new Error("id is required for archive and restore.");
    return service!.change(connectedFolderId, input.id, input.action, ports);
  } };
}

function createCollaborationToolHost(state: LocalApiState, connectedFolderId: string, conversationId: string): import("./agent/collaboration-tools.js").CollaborationToolHost {
  const facade = createAmpleFileActFacade(state);
  return { async invoke(operation, taskId, input, signal) {
    assertOwnTask(state, connectedFolderId, taskId);
    const target = typeof input.connectedFolder === "string" ? input.connectedFolder : connectedFolderId;
    const required = (name: string): string => {
      const value = input[name];
      if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
      return value;
    };
    const files = Array.isArray(input.files) ? input.files as string[] : [];
    switch (operation) {
      case "children": return facade.chatChildren({ connectedFolder: connectedFolderId, taskId });
      case "handoff": return facade.chatHandoff({ connectedFolder: connectedFolderId, taskId, toConnectedFolder: target, message: required("message"), files, ...(typeof input.conversation === "string" ? { toConversationId: input.conversation } : {}) });
      case "steer": return facade.chatSteer({ connectedFolder: target, taskId, conversationId: required("conversation"), message: required("message") });
      case "copy": return facade.chatCopy({ connectedFolder: target, taskId, conversationId: typeof input.conversation === "string" ? input.conversation : conversationId, ...(typeof input.message === "string" ? { message: input.message } : {}), ...(typeof input.title === "string" ? { title: input.title } : {}) });
      case "stop": {
        const destination = resolveAmpleFileCliConnectedFolderSelector(await listConnectedFolders(), target)!;
        assertCallerHandedWorkTo(state, taskId, { connectedFolderId: destination.id, conversationId: required("conversation") });
        return facade.abortTurn({ connectedFolder: destination.id, conversationId: required("conversation") });
      }
      case "report": return facade.chatReport({ connectedFolder: connectedFolderId, taskId, summary: required("summary"), files, outcome: input.outcome as "succeeded" | "partial" | "failed", ...(input.data !== undefined ? { data: input.data } : {}) });
      case "ask": return facade.chatAsk({ connectedFolder: connectedFolderId, taskId, question: required("question"), respondent: input.to === "parent" ? "parent" : "person", ...(Array.isArray(input.options) ? { options: input.options as string[] } : {}), ...(input.asynchronous === true ? { asynchronous: true } : {}) });
      case "answer": return facade.chatAnswer({ connectedFolder: target, questionId: required("question"), answer: required("answer") });
      case "wait": {
        const followed = state.requests.byTaskId(required("task"));
        if (!followed?.owner.connectedFolderId) throw new Error("That delegated task is not on record.");
        assertCallerHandedWorkTo(state, taskId, { connectedFolderId: followed.owner.connectedFolderId, conversationId: followed.owner.conversationId });
        const seconds = input.seconds === undefined ? 30 : Number(input.seconds);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) throw new Error("seconds must be between 0 and 120.");
        const deadline = Date.now() + seconds * 1000;
        for (;;) {
          signal?.throwIfAborted();
          const status = await facade.turnStatus({ connectedFolder: followed.owner.connectedFolderId, taskId: required("task") });
          if (status.waiting || status.task.state !== "running" || Date.now() >= deadline) {
            return status.task.state === "succeeded" ? facade.turnResult({ connectedFolder: followed.owner.connectedFolderId, taskId: required("task") }) : status;
          }
          await new Promise(done => setTimeout(done, 100));
        }
      }
    }
  } };
}

async function getClient(
  state: LocalApiState,
  connectedFolderId: string,
  connectedFolderRoot: string,
  conversationId: string,
): Promise<PiConversationClient> {
  if (connectedFolderId === ampleFileAgentScopeId) assertAmpleFileAgentInstructionsReady(state);
  const key = clientKey(connectedFolderId, conversationId);
  rememberConnectedFolderRoot(state, connectedFolderId, connectedFolderRoot);
  const existing = state.clients.get(key);
  if (existing) return existing;
  // The AmpleFile Agent scope loads personal Pi capabilities and its two app-owned
  // project instructions. It belongs to no Connected Folder.
  const hostCapabilities = connectedFolderId === ampleFileAgentScopeId
    ? undefined
    : { connectedFolderId };
  // Connected Folder scopes carry the compact operations guide after their own Connected Folder
  // instructions; the AmpleFile Agent scope has its own taught text.
  const operationsGuide = connectedFolderOperationsGuideForScope(connectedFolderId);
  const client = new PiConversationClient(conversationId, connectedFolderRoot, state.runtimeProvider, hostCapabilities, {
    role: connectedFolderId === ampleFileAgentScopeId ? "amplefile-agent" : "worker",
    async onContextCompacted() {
      const chatMessage: ChatMessage = {
        id: randomUUID(), role: "system", kind: "context_compaction",
        content: "Conversation context compacted. Earlier messages were summarized to make room; your chat history is still available.",
        createdAt: new Date().toISOString(),
      };
      await appendMessage(connectedFolderRoot, conversationId, chatMessage);
      broadcast(state, streamKey(connectedFolderId, conversationId), { type: "context_compacted", conversationId, chatMessage });
    },
    ...(operationsGuide ? { operationsGuide } : {}),
    imageModel: () => state.imageModelPreference.get(),
    // A Worker Chat shows its pictures inline; the AmpleFile Agent's panel does not yet.
    ...(connectedFolderId === ampleFileAgentScopeId ? {} : { imageStore: state.generatedImages }),
    backgroundJobs: createBackgroundJobToolHost(state, connectedFolderId, conversationId),
    ...(state.browser ? { browser: state.browser, browserOwner: `${connectedFolderId}/${conversationId}` } : {}),
    ...(connectedFolderId === ampleFileAgentScopeId ? {} : { collaboration: createCollaborationToolHost(state, connectedFolderId, conversationId) }),
    helperTool: connectedFolderId !== ampleFileAgentScopeId,
    recoveryScope: taskId => {
      const request = state.requests.byTaskId(taskId);
      if (!request || request.owner.conversationId !== conversationId
        || (request.owner.connectedFolderId ?? ampleFileAgentScopeId) !== connectedFolderId
        || !request.turns.some(turn => turn.taskId === taskId && turn.state === "running")) return null;
      return { requestId: request.requestId, taskIds: request.turns.map(turn => turn.taskId) };
    },
    ...(connectedFolderId === ampleFileAgentScopeId ? {} : { worktrees: createWorktreeToolHost(state, connectedFolderId) }),
    checklist: {
      async set({ taskId, items }) {
        try {
          const saved = await state.requests.setChecklist(taskId, items);
          // The Chat's work view re-reads the request and shows the new list.
          publishControlHint(state, "connected-folders");
          return saved;
        } catch (error) {
          if (error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError) throw new Error(error.message);
          throw error;
        }
      },
    },
  });
  client.on("event", (event: PiChatEvent) => {
    broadcast(state, streamKey(connectedFolderId, conversationId), assistantEventForRenderer(event));
  });
  state.clients.set(key, client);
  return client;
}

function assistantEventForRenderer(event: PiChatEvent): Omit<PiChatEvent, "raw"> {
  const { raw: _raw, ...safeEvent } = event;
  if (!safeEvent.message) return safeEvent;
  if (safeEvent.type === "error") {
    return { ...safeEvent, message: assistantFailurePublicDetail(new Error(safeEvent.message)) };
  }
  if (safeEvent.type === "status" && isModelSetupError(safeEvent.message)) {
    return { ...safeEvent, message: "agent setup is needed. Open Settings → AI Models." };
  }
  return safeEvent;
}

async function invalidateAmpleFileClients(state: LocalApiState, connectedFolderId: string): Promise<void> {
  for (const [key, client] of [...state.clients]) {
    if (!key.startsWith(`${connectedFolderId}:`)) continue;
    await client.stop().catch(() => undefined);
    state.clients.delete(key);
  }
}

async function invalidateAllClients(state: LocalApiState): Promise<void> {
  for (const [key, client] of [...state.clients]) {
    await client.stop().catch(() => undefined);
    state.clients.delete(key);
  }
}

type CapabilityScope = "global" | "project";
const globalCapabilityMutationKey = "*";

function capabilityRegistryType(value: string | null): "all" | CapabilityType | undefined {
  if (!value) return undefined;
  if (value === "all" || value === "skill" || value === "extension") return value;
  throw badRequest("Capability type must be all, skill, or extension.");
}

function capabilityRegistrySort(value: string | null): CapabilitySort | undefined {
  if (!value) return undefined;
  if (value === "official" || value === "downloads" || value === "recent" || value === "name") return value;
  throw badRequest("Capability sort must be official, downloads, recent, or name.");
}

function optionalBoundedInteger(value: string | null, label: "offset" | "limit" | "offsetBytes" | "lengthBytes"): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  const minimum = label === "limit" ? 1 : 0;
  if (!Number.isInteger(parsed) || parsed < minimum) throw badRequest(`${label} is invalid.`);
  return parsed;
}

function capabilityScope(value: unknown): CapabilityScope {
  if (value === undefined || value === null || value === "global") return "global";
  if (value === "project") return "project";
  throw badRequest("Capability scope must be global or project.");
}

async function runHistoryRestore<T>(state: LocalApiState, connectedFolderId: string, operation: () => Promise<T>): Promise<T> {
  reserveCapabilityMutation(state, connectedFolderId, "project", connectedFolderId);
  try {
    const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(connectedFolderId);
    if (blockers.length) throw httpError(409, blockers[0]!);
    await getConnectedFolder(connectedFolderId);
    return await operation();
  } finally { state.capabilityMutations.delete(connectedFolderId); }
}

/** Stop is not settled until its accepted turns have actually drained. */
function requestHasUnsettledWork(state: LocalApiState, request: AmpleFileRequestRecord): boolean {
  return [request, ...state.requests.subtree(request.requestId)].some((record) =>
    !isAmpleFileRequestTerminalState(record.state)
    || record.continuationState === "pending"
    || record.turns.some((turn) => turn.state === "accepted" || turn.state === "running")
    // A job a Stop is still ending keeps its request unsettled until it has.
    || (record.jobs ?? []).some((job) => job.state === "running"));
}

/** Called with the Connected Folder's mutation fence held; deletion refuses instead of interrupting work. */
async function runSettledConnectedFolderDeletion<T>(state: LocalApiState, connectedFolderId: string, operation: () => Promise<T>): Promise<T> {
  const assertSettled = () => {
    if (state.requests.list({ connectedFolderId }).some((request) => requestHasUnsettledWork(state, request))) {
      throw httpError(409, "Finish or stop this Connected Folder's outstanding work before deleting.");
    }
  };
  assertSettled();
  const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(connectedFolderId);
  if (blockers.length) throw httpError(409, blockers[0]!);
  await getConnectedFolder(connectedFolderId);
  assertSettled();
  return operation();
}

/**
 * Worker instructions shape only later turns, so saving them never waits on or
 * interrupts work: idle Chats rebuild now, and a Chat that is mid-turn or
 * compacting (including the Worker that saved them, as Set up for me does)
 * rebuilds as soon as that work ends.
 */
async function saveWorkerInstructions(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  instructions: string,
): Promise<void> {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(connectedFolder.id)) {
    throw httpError(409, "Wait for the current capability change to finish.");
  }
  await setPiWorkerInstructions(connectedFolder.connectedFolderRoot, instructions, state.runtimeProvider);
  for (const [key, client] of [...state.clients]) {
    if (!key.startsWith(`${connectedFolder.id}:`)) continue;
    if (state.runningTurns.has(key) || state.compactingConversations.has(key)) {
      state.clientsToRefresh.add(key);
      continue;
    }
    await client.stop().catch(() => undefined);
    state.clients.delete(key);
  }
  publishControlHint(state, "models");
}

async function imageModelSettings(state: LocalApiState) {
  const { models, automatic } = await listPiImageModels(ampleFileAgentRoot(), state.runtimeProvider);
  const selected = await state.imageModelPreference.get();
  return {
    selected: selected ?? null,
    // A saved model whose provider was disconnected falls back to Automatic until it returns.
    selectedAvailable: selected ? models.some((item) => item.provider === selected.provider && item.id === selected.id) : true,
    automatic,
    models,
  };
}

/** Rebuilds a Chat's client that was marked while it was busy. */
async function refreshClientIfMarked(state: LocalApiState, key: string): Promise<void> {
  if (!state.clientsToRefresh.delete(key)) return;
  const stale = state.clients.get(key);
  if (!stale) return;
  await stale.stop().catch(() => undefined);
  state.clients.delete(key);
}

async function runCapabilityMutation<T>(
  state: LocalApiState,
  connectedFolder: { id: string; connectedFolderRoot: string },
  scope: CapabilityScope,
  operation: () => Promise<T>,
  options: { requireProjectTrust?: boolean } = {},
): Promise<T> {
  const key = scope === "global" ? globalCapabilityMutationKey : connectedFolder.id;
  reserveCapabilityMutation(state, connectedFolder.id, scope, key);
  try {
    if (
      scope === "project"
      && options.requireProjectTrust !== false
      && !await isPiProjectMutationTrusted(connectedFolder.connectedFolderRoot, state.runtimeProvider)
    ) {
      throw forbidden("Trust this Connected Folder before changing Connected Folder–scoped capabilities.");
    }
    const result = await operation();
    if (scope === "global") await invalidateAllClients(state);
    else await invalidateAmpleFileClients(state, connectedFolder.id);
    publishControlHint(state, "models");
    return result;
  } finally {
    state.capabilityMutations.delete(key);
  }
}

async function runConnectedFolderMutation<T>(
  state: LocalApiState,
  connectedFolderId: string,
  operation: () => Promise<T>,
): Promise<T> {
  reserveCapabilityMutation(state, connectedFolderId, "project", connectedFolderId);
  try {
    await revalidateMutatedConnectedFolder(state, connectedFolderId);
    const result = await operation();
    await invalidateAmpleFileClients(state, connectedFolderId);
    return result;
  } finally {
    state.capabilityMutations.delete(connectedFolderId);
  }
}

async function recoverPendingConnectedFolderRemovals(
  io: Partial<ConnectedFolderRemovalIo>,
  recentlyDeleted: AmpleFileRecentlyDeletedStore,
): Promise<{ connectedFolderRoots: string[]; connectedFolderIds: string[] }> {
  const pendingRemovals = await listPendingConnectedFolderRemovals();
  for (const pending of pendingRemovals) {
    try {
      const intent = pending;
      // An interrupted managed deletion finishes into Recently deleted, not
      // into an erase: the folder this start finds claimed is still the
      // person's (docs/act-ledger.md).
      const removalIo = managedConnectedFolderRemovalIo(recentlyDeleted, io, {
        connectedFolderId: intent.connectedFolderId,
        connectedFolderRoot: intent.connectedFolderRoot,
        receiptId: null,
        managedDeletion: intent.storage === "managed" && intent.folderDisposition !== "preserve",
      });
      await finalizeConnectedFolderRemoval(intent.connectedFolderId, removalIo.io);
    } catch {
      // The durable intent keeps this Connected Folder hidden and untrusted. Recovery of
      // other Connected Folders and normal startup can proceed; a later startup retries it.
    }
  }
  return {
    connectedFolderRoots: pendingRemovals.map((intent) => intent.connectedFolderRoot),
    connectedFolderIds: pendingRemovals.map((intent) => intent.connectedFolderId),
  };
}

async function runConnectedFolderMutations<T>(
  state: LocalApiState,
  connectedFolderIds: readonly string[],
  operation: () => Promise<T>,
  options: { requiredConnectedFolderIds?: readonly string[] } = {},
): Promise<T> {
  const ids = [...new Set(connectedFolderIds)].sort();
  if (ids.length === 0) throw badRequest("A Connected Folder is required for this change.");
  const requiredConnectedFolderIds = [...new Set(options.requiredConnectedFolderIds ?? ids)].sort();
  if (requiredConnectedFolderIds.length === 0 || requiredConnectedFolderIds.some((connectedFolderId) => !ids.includes(connectedFolderId))) {
    throw new Error("Connected Folder mutation validation must name one or more reserved Connected Folders.");
  }
  if (state.capabilityMutations.has(globalCapabilityMutationKey)
    || ids.some((connectedFolderId) => state.capabilityMutations.has(connectedFolderId))) {
    throw httpError(409, "Wait for the current capability change to finish.");
  }
  if (ids.some((connectedFolderId) => hasActiveCapabilityWorkForConnectedFolder(state, connectedFolderId))) {
    throw httpError(409, "Wait for affected work to finish before changing capabilities.");
  }
  for (const connectedFolderId of ids) state.capabilityMutations.add(connectedFolderId);
  try {
    for (const connectedFolderId of requiredConnectedFolderIds) {
      await revalidateMutatedConnectedFolder(state, connectedFolderId);
    }
    const result = await operation();
    await Promise.all(ids.map((connectedFolderId) => invalidateAmpleFileClients(state, connectedFolderId)));
    return result;
  } finally {
    for (const connectedFolderId of ids) state.capabilityMutations.delete(connectedFolderId);
  }
}

async function revalidateMutatedConnectedFolder(state: LocalApiState, connectedFolderId: string): Promise<void> {
  await state.beforeConnectedFolderMutationRevalidation?.(connectedFolderId);
  await getConnectedFolder(connectedFolderId);
}

function reserveCapabilityMutation(
  state: LocalApiState,
  connectedFolderId: string,
  scope: CapabilityScope,
  key: string,
): void {
  const mutationConflict = scope === "global"
    ? state.capabilityMutations.size > 0
    : state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(connectedFolderId);
  if (mutationConflict) throw httpError(409, "Wait for the current capability change to finish.");

  const runningConflict = scope === "global"
    ? state.runningTurns.size > 0 || state.compactingConversations.size > 0
    : hasActiveCapabilityWorkForConnectedFolder(state, connectedFolderId);
  if (runningConflict) {
    throw httpError(409, "Wait for affected agent work to finish before changing capabilities.");
  }
  state.capabilityMutations.add(key);
}

function assertNoCapabilityMutationForTurn(state: LocalApiState, connectedFolderId: string): void {
  if (state.capabilityMutations.has(globalCapabilityMutationKey) || state.capabilityMutations.has(connectedFolderId)) {
    throw httpError(409, "Wait for the current capability change to finish before starting a turn.");
  }
}

function hasActiveCapabilityWorkForConnectedFolder(state: LocalApiState, connectedFolderId: string, exceptTurnKey?: string): boolean {
  const prefix = `${connectedFolderId}:`;
  return [...state.runningTurns, ...state.compactingConversations].some((key) => key.startsWith(prefix) && key !== exceptTurnKey);
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
        const absoluteSources = await resolveAutomationFilesSources(from.connectedFolderRoot, source);
        const copied: string[] = [];
        try {
          for (const sourcePath of absoluteSources) {
            copied.push(await copyPathIntoConnectedFolder(sourcePath, to.connectedFolderRoot, step.to));
          }
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

/**
 * Follows one accepted turn to its settled record, honoring the automation
 * run's abort signal through the same cancellation path `agent stop` uses.
 * The accepted turn always settles (its runner records an outcome in a
 * finally block), so the wait terminates; a record evicted by the bounded
 * settled-turn history reports honestly as lost.
 */
async function waitForSettledRequest(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  taskId: string,
  signal: AbortSignal,
): Promise<SettledTurnRecord> {
  const requestAbort = (): void => { void stopAmpleFileAgentRequest(state, taskId).catch(() => undefined); };
  if (signal.aborted) requestAbort();
  signal.addEventListener("abort", requestAbort, { once: true });
  try {
    for (;;) {
      // A settle may reserve a synthesis turn. Observe that decision before
      // admitting the next automation hop.
      await state.requestSettleChain;
      const request = state.requests.byTaskId(taskId);
      // A stop fences the graph before native abort cleanup finishes. A
      // automation's terminal receipt must wait for that cleanup, so its next
      // observer cannot see completed automation work with live kernel tasks.
      if (request && request.state !== "waiting" && isAmpleFileRequestTerminalState(request.state)
        && [request, ...state.requests.subtree(request.requestId)].some((item) => item.turns.some((turn) => state.activeTurnTasks.has(turn.taskId)))) {
        await settleDelay(25);
        continue;
      }
      if (request && (request.state === "waiting" || isAmpleFileRequestTerminalState(request.state))) {
        const latest = request.turns.at(-1)!;
        const settled = state.settledTurns.get(latest.taskId);
        return {
          ...(settled ?? { taskId: latest.taskId, connectedFolderId, conversationId, endedAt: new Date().toISOString() }),
          status: request.state === "done" ? "succeeded" : request.state === "stopped" ? "aborted" : "failed",
          ...(request.state === "done" ? {} : { error: request.state === "waiting"
            ? "The Worker request needs an answer in its Chat. This automation ended here; answering does not replay later hops."
            : `The Worker request ended ${request.state}.` }),
        };
      }
      if (!request && !state.activeTurnTasks.has(taskId)) {
        return { taskId, connectedFolderId, conversationId, status: "failed", endedAt: new Date().toISOString(), error: "AmpleFile lost track of this request." };
      }
      await settleDelay(25);
    }
  } finally { signal.removeEventListener("abort", requestAbort); }
}

function settleDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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

function closeConnectedFolderStreams(state: LocalApiState, connectedFolderId: string): void {
  for (const [close, owner] of [...state.fileStreams]) if (owner === connectedFolderId) close();
  const prefix = `${connectedFolderId}:`;
  for (const [key, streams] of [...state.chatStreams]) {
    if (!key.startsWith(prefix)) continue;
    for (const response of streams) response.close();
    state.chatStreams.delete(key);
  }
}

function extensionScopeId(state: LocalApiState, scope: PiExtensionUiScope): string | null {
  return connectedFolderRootKey(scope.connectedFolderRoot) === connectedFolderRootKey(ampleFileAgentRoot())
    ? ampleFileAgentScopeId : connectedFolderIdForRoot(state, scope.connectedFolderRoot);
}

function sameExtensionScope(left: PiExtensionUiScope, right: PiExtensionUiScope): boolean {
  return connectedFolderRootKey(left.connectedFolderRoot) === connectedFolderRootKey(right.connectedFolderRoot) && left.conversationId === right.conversationId;
}

function remoteExtensionRequests(state: LocalApiState, record: AmpleFileRequestRecord): Array<Record<string, unknown>> {
  const taskId = record.turns.at(-1)?.taskId;
  if (!taskId || record.owner.connectedFolderId || record.stopRequestedAt || record.state === "expired" || state.cancelledTurnTasks.has(taskId)
      || state.activeTurnIdsByKey.get(streamKey(ampleFileAgentScopeId, record.owner.conversationId)) !== taskId) return [];
  return [...state.extensionRequests.values()].filter((request) => request.taskId === taskId
    && sameExtensionScope(request, { connectedFolderRoot: ampleFileAgentRoot(), conversationId: record.owner.conversationId })
    && !(request.method === "input" && request.secret))
    .map((request) => ({ ...rendererExtensionRequest(request), taskId }));
}

function rendererExtensionRequest(request: PiExtensionUiRequest): Record<string, unknown> {
  return {
    id: request.id, method: request.method, title: request.title,
    ...(request.method === "confirm" ? { message: request.message } : {}),
    ...(request.method === "select" ? { options: request.options } : {}),
    ...(request.method === "input" && request.placeholder ? { placeholder: request.placeholder } : {}),
    ...(request.method === "input" && request.secret ? { secret: true } : {}),
    ...(request.method === "editor" && request.prefill ? { initialValue: request.prefill } : {}),
  };
}

function extensionSnapshot(state: LocalApiState, scope: PiExtensionUiScope): Array<Record<string, unknown>> {
  return [...state.extensionRequests.values()].filter((request) => sameExtensionScope(request, scope)).map(rendererExtensionRequest);
}

/** Transient interactions never enter the replay log or portable transcript. */
function publishExtensionSnapshot(state: LocalApiState, scope: PiExtensionUiScope): void {
  publishTransientExtensionEvent(state, scope, { type: "extension_ui_snapshot", conversationId: scope.conversationId, requests: extensionSnapshot(state, scope) });
}

/** Desktop UI only: no durable log and no in-process listeners. */
function publishTransientExtensionEvent(state: LocalApiState, scope: PiExtensionUiScope, event: unknown): void {
  const scopeId = extensionScopeId(state, scope);
  if (!scopeId) return;
  const streams = state.chatStreams.get(streamKey(scopeId, scope.conversationId));
  for (const response of [...streams ?? []]) {
    try {
      if (response.closed || response.queuedBytes > maxChatStreamQueuedBytes) {
        response.close(); streams?.delete(response);
      } else writeSseData(response, event);
    } catch { streams?.delete(response); }
  }
}

function routeExtensionRequest(state: LocalApiState, request: PiExtensionUiRequest): void {
  const scopeId = extensionScopeId(state, request);
  if (!scopeId) {
    state.extensionUi.cancel(request.id);
    return;
  }
  if (request.taskId && state.activeTurnIdsByKey.get(streamKey(scopeId, request.conversationId)) !== request.taskId) {
    state.extensionUi.cancel(request.id);
    return;
  }
  state.extensionRequests.set(request.id, request);
  publishExtensionSnapshot(state, request);
}

function answerExtensionRequest(state: LocalApiState, scope: PiExtensionUiScope, id: string, body: { value?: unknown; cancelled?: unknown }): boolean {
  const request = state.extensionRequests.get(id);
  if (!request || !sameExtensionScope(request, scope)) throw notFound("Extension question has ended or belongs to another Chat.");
  if (body.cancelled !== undefined && typeof body.cancelled !== "boolean") throw badRequest("cancelled must be a boolean.");
  const response: PiExtensionUiResponse = body.cancelled === true ? { cancelled: true }
    : request.method === "confirm" ? { confirmed: body.value as boolean } : { value: body.value as string };
  try { validateExtensionUiResponse(request, response); }
  catch (error) { throw badRequest(errorMessage(error)); }
  return state.extensionUi.respond(request.id, response);
}

function routeExtensionEvent(state: LocalApiState, event: PiExtensionUiEvent): void {
  const connectedFolderId = extensionScopeId(state, event);
  if (!connectedFolderId) return;
  if (event.method === "oauthDeviceCode" || event.method === "openExternal") {
    publishTransientExtensionEvent(state, event, { type: "status", conversationId: event.conversationId, message: extensionEventMessage(event) });
    return;
  }
  if (event.method === "notify") {
    broadcast(state, streamKey(connectedFolderId, event.conversationId), {
      type: "extension_ui_request",
      conversationId: event.conversationId,
      request: { id: event.id, method: "notify", message: event.message },
    });
    return;
  }
  if (event.method === "setEditorText" || event.method === "pasteToEditor") {
    broadcast(state, streamKey(connectedFolderId, event.conversationId), {
      type: "editor",
      conversationId: event.conversationId,
      editorMode: event.method === "setEditorText" ? "replace" : "append",
      text: event.text,
    });
    return;
  }
  const message = extensionEventMessage(event);
  if (message) broadcast(state, streamKey(connectedFolderId, event.conversationId), { type: "status", conversationId: event.conversationId, message });
}

function extensionEventMessage(event: PiExtensionUiEvent): string | null {
  if (event.method === "setStatus") return event.text ?? null;
  if (event.method === "setWorkingMessage") return event.message ?? null;
  if (event.method === "setWorkingVisible") return event.visible ? "Extension is working…" : null;
  if (event.method === "setWorkingIndicator") return event.options ? "Extension is working…" : null;
  if (event.method === "setTitle") return event.title;
  if (event.method === "openExternal") return `Extension requested: ${event.url}`;
  if (event.method === "oauthDeviceCode") return `Open ${event.verificationUri} and enter ${event.userCode}.`;
  if (event.method === "unsupported") return `Extension UI feature is not available here: ${event.feature}`;
  return null;
}

function normalizeStatus(status: PiSetupStatus): Record<string, unknown> {
  return {
    ready: status.ready,
    configured: status.configured,
    provider: status.provider ?? null,
    model: status.model ?? null,
    piVersion: status.piVersion,
    projectTrusted: status.projectTrusted,
    error: status.error,
  };
}

function providerSetupResponse(status: PiSetupStatus, desktopSetup: boolean) {
  return status.providers.map((provider) => ({
    ...provider,
    oauthAvailable: provider.oauth && desktopSetup,
    guidedSetup: provider.apiKey && desktopSetup,
  }));
}

function emptyAgentStatus(): Record<string, unknown> {
  return { ready: true, configured: false, provider: null, model: null, piVersion: null, projectTrusted: false, error: null };
}

async function safeAgentStatus(connectedFolderRoot: string, provider: PiRuntimeProvider): Promise<Record<string, unknown>> {
  try {
    return normalizeStatus(await getPiSetupStatus(connectedFolderRoot, provider));
  } catch (error) {
    return { ...emptyAgentStatus(), ready: false, error: errorMessage(error) };
  }
}

/** A Connected Folder when one is named; otherwise the AmpleFile Agent's scope (first run, no Connected Folder yet). */
async function includedToolScope(connectedFolderId: string | null | undefined): Promise<{ id: string; connectedFolderRoot: string }> {
  if (connectedFolderId) return getConnectedFolder(connectedFolderId);
  return { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentRoot() };
}

interface ModelScope {
  id: string;
  connectedFolderRoot: string;
  label: string;
}

async function modelScope(scope: string | null | undefined, connectedFolderId?: string | null): Promise<ModelScope> {
  if (scope === "agent") {
    return { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentRoot(), label: "the AmpleFile Agent" };
  }
  if (scope && scope !== "connected-folder") throw badRequest("agent scope must be Connected Folder or management.");
  if (!connectedFolderId) throw badRequest("Connected Folder id is required.");
  const connectedFolder = await getConnectedFolder(connectedFolderId);
  return { id: connectedFolder.id, connectedFolderRoot: connectedFolder.connectedFolderRoot, label: "this Connected Folder" };
}

function openControlEventStream(state: LocalApiState, sink: LocalEventSink): void {
  if (sink.closed) return;
  state.controlStreams.add(sink);
  sink.send({ type: "reset" });
  const heartbeat = setInterval(() => sink.heartbeat(), 15_000);
  heartbeat.unref();
  sink.onClose(() => { clearInterval(heartbeat); state.controlStreams.delete(sink); });
}

function openChatStream(
  state: LocalApiState,
  res: LocalEventSink,
  connectedFolderId: string,
  conversationId: string,
  _lastEventId?: string | string[],
): void {
  if (res.closed) return;
  const key = streamKey(connectedFolderId, conversationId);
  writeSseData(res, { type: "status", conversationId, message: "Connected." });
  const log = chatEventLog(state, key);
  // The conflict reservation precedes persistence. A new subscriber must not
  // mistake that reservation for a readable accepted message/answer.
  const turnId = state.activeTurnIdsByKey.get(key);
  const running = state.runningTurns.has(key) && Boolean(turnId && state.turnStore.get(turnId)?.userMessagePersisted);
  // A reconnect reads current state. Replaying deltas would repeat local
  // timers/rows and an old process's numeric cursor could match a new log.
  // No model or tool execution is restarted by this read-only projection.
  const presentation = (running && turnId ? state.clients.get(key)?.getTurnLivePresentation(turnId) : undefined)
    ?? boundedLiveTurnPresentation({ text: log.assistantText, workTrail: [], truncated: false });
  const snapshotId = log.nextId - 1;
  writeSseData(res, {
    type: "turn_snapshot", conversationId, running,
    turnId: turnId ?? log.turnId ?? null,
    text: presentation.text, presentation,
  }, snapshotId > 0 ? snapshotId : undefined);
  // Older consumers retain their original handshake alongside the richer view.
  writeSseData(res, turnStateEvent(conversationId, running, turnId ?? log.turnId ?? null), snapshotId > 0 ? snapshotId : undefined);
  // Current state, like turn_state: it carries the snapshot's cursor.
  writeSseData(res, queuedMessageEvent(state, connectedFolderId, conversationId), snapshotId > 0 ? snapshotId : undefined);
  const streams = state.chatStreams.get(key) ?? new Set<LocalEventSink>();
  streams.add(res);
  state.chatStreams.set(key, streams);
  const extensionScope = { conversationId, connectedFolderRoot: connectedFolderId === ampleFileAgentScopeId
    ? ampleFileAgentRoot() : [...state.connectedFolderIdsByRoot].find(([, id]) => id === connectedFolderId)?.[0] ?? "" };
  writeSseData(res, { type: "extension_ui_snapshot", conversationId, requests: extensionSnapshot(state, extensionScope) });
  const heartbeat = setInterval(() => {
    try {
      res.heartbeat();
    } catch { /* disconnected */ }
  }, 15_000);
  res.onClose(() => {
    clearInterval(heartbeat);
    streams.delete(res);
    if (!streams.size) state.chatStreams.delete(key);
  });
}

/** How long one file-event stream reuses its read of the ignore rules. */
const fileEventIgnoreStateReuseMs = 1_000;

async function openConnectedFolderFileStream(
  state: LocalApiState,
  res: LocalEventSink,
  connectedFolderRoot: string,
  connectedFolderId: string,
): Promise<void> {
  let recursive = true;
  let watcher: ReturnType<typeof watch>;
  const sendEvent = (event: unknown) => {
    res.send(event);
  };
  // A build or a Git command can report thousands of changes a second. They
  // share one read of the ignore rules for a moment instead of each reading
  // the rules file again; a failed read is not reused.
  let ignoreRead: { at: number; state: ReturnType<typeof readConnectedFolderIgnoreState> } | null = null;
  const currentIgnoreState = () => {
    const now = Date.now();
    if (!ignoreRead || now - ignoreRead.at > fileEventIgnoreStateReuseMs) {
      const read = { at: now, state: readConnectedFolderIgnoreState(connectedFolderRoot) };
      read.state.catch(() => { if (ignoreRead === read) ignoreRead = null; });
      ignoreRead = read;
    }
    return ignoreRead.state;
  };
  const onChange = (eventType: string, fileName: string | Buffer | null) => {
    const rawName = Buffer.isBuffer(fileName) ? fileName.toString("utf8") : fileName ?? "";
    if (!rawName) {
      sendEvent({ type: "file_event", eventType, path: null });
      return;
    }
    const path = rawName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || isAlwaysHiddenConnectedFolderEntry(basename(path))) return;
    void currentIgnoreState().then((ignoreState) => {
      if (res.closed) return;
      if (isConnectedFolderIgnored(path, ignoreState.patterns)) return;
      try { resolveConnectedFolderPath(connectedFolderRoot, path); } catch { return; }
      sendEvent({ type: "file_event", eventType, path });
    }).catch(() => { if (!res.closed) sendEvent({ type: "error", message: "File monitoring is unavailable. Refresh this Connected Folder to reconnect." }); });
  };
  const watchRoot = await canonicalConnectedFolderWatchRoot(connectedFolderRoot);
  if (res.closed) return;
  const registered = await getConnectedFolder(connectedFolderId);
  if (registered.connectedFolderRoot !== connectedFolderRoot) throw notFound("Connected Folder changed while opening file monitoring.");
  if (res.closed) return;
  try {
    watcher = watch(watchRoot, { recursive: true }, onChange);
  } catch {
    recursive = false;
    watcher = watch(watchRoot, onChange);
  }
  sendEvent({ type: "ready", recursive });
  const heartbeat = setInterval(() => {
    res.heartbeat();
  }, 15_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    watcher.close();
    if (!res.closed) res.close();
    state.fileStreams.delete(close);
  };
  state.fileStreams.set(close, connectedFolderId);
  watcher.on("error", (error) => sendEvent({ type: "error", message: errorMessage(error) }));
  res.onClose(close);
}

/** Live refresh for the one standard folder level on screen; a folder level is not watched recursively. */
async function openStandardFolderFileStream(state: LocalApiState, res: LocalEventSink, standardFolderId: StandardFolderId, relativePath: string): Promise<void> {
  const directory = resolveStandardFolderPath(standardFolderId, relativePath);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw notFound("That folder isn’t there anymore.");
  if (res.closed) return;
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(directory, (eventType, fileName) => {
      const name = Buffer.isBuffer(fileName) ? fileName.toString("utf8") : fileName ?? "";
      if (name && !isShownStandardEntry(basename(name))) return;
      res.send({ type: "file_event", eventType, path: name ? [relativePath, name].filter(Boolean).join("/") : null });
    });
  } catch (error) {
    throw standardFolderAccessError(error, standardFolderId);
  }
  res.send({ type: "ready", recursive: false });
  const heartbeat = setInterval(() => res.heartbeat(), 15_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    watcher.close();
    if (!res.closed) res.close();
    state.fileStreams.delete(close);
  };
  state.fileStreams.set(close, `standard:${standardFolderId}`);
  watcher.on("error", (error) => res.send({ type: "error", message: errorMessage(error) }));
  res.onClose(close);
}

async function sendConnectedFolderRawFile(res: ServerResponse, connectedFolderRoot: string, relativePath: string): Promise<void> {
  const path = resolveConnectedFolderPath(connectedFolderRoot, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  res.writeHead(200, {
    "content-type": contentTypeForPath(path),
    "content-length": info.size,
    "content-disposition": "inline",
  });
  if (!info.size) {
    res.end();
    return;
  }
  // A preview that changes aborts its fetch. pipeline() destroys the read
  // stream when the response closes, so an abandoned read never keeps the file
  // open, and the read stops at the length already promised to the client.
  await pipeline(createReadStream(path, { end: info.size - 1 }), res);
}

/**
 * The Connected Folder Workers a person addressed with @: at most eight
 * distinct registered Connected Folder ids in a stable order, never the sending scope's
 * own. An id that is no longer registered is dropped rather than refused, so a
 * retried send still replays after a Connected Folder was removed.
 */
async function normalizeAddressedConnectedFolderIds(value: unknown, ownScopeId: string): Promise<string[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 512)) {
    throw badRequest("addressedConnectedFolderIds must be a list of Connected Folder ids.");
  }
  const ids = [...new Set((value as string[]).map((item) => item.trim()))].filter((id) => id !== ownScopeId);
  if (!ids.length) return [];
  const registered = new Set((await registeredConnectedFolderOutline()).map((connectedFolder) => connectedFolder.id));
  return ids.filter((id) => registered.has(id)).sort();
}

/** A Connected Folder Chat's attached files and folders, kept on its message so the Chat shows what was sent. */
function contextPathAttachments(connectedFolderRoot: string, contextPaths: string[]): ChatMessageAttachmentRef[] {
  return contextPaths.slice(0, 32).map((path) => {
    let folder = false;
    try { folder = statSync(resolveConnectedFolderPath(connectedFolderRoot, path)).isDirectory(); } catch { /* a missing path stays a file reference */ }
    return { kind: folder ? "folder" : "file", target: path, name: path.slice(path.lastIndexOf("/") + 1) || path };
  });
}

function normalizeContextPaths(connectedFolderRoot: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw badRequest("Chat context paths must be an array of strings.");
  const paths = [...new Set(value.map((item) => normalizeConnectedFolderRelativePath(item)).filter(Boolean))];
  for (const path of paths) {
    try { resolveConnectedFolderPath(connectedFolderRoot, path); } catch (error) { throw badRequest(errorMessage(error)); }
  }
  return paths;
}

async function captureTurnCheckpointSafe(
  state: LocalApiState,
  connectedFolderId: string,
  connectedFolderRoot: string,
  conversationId: string,
  reason: "pre_turn" | "post_turn",
): Promise<import("./history.js").ConnectedFolderCheckpoint | null> {
  // History is a Connected Folder concept. The AmpleFile Agent scope's root holds only
  // conversation records in app state, so turn checkpoints do not apply.
  if (connectedFolderId === ampleFileAgentScopeId) return null;
  try {
    const checkpoint = await createConnectedFolderCheckpoint(connectedFolderRoot, {
      reason,
      label: reason === "pre_turn" ? "Before turn" : "After turn",
    });
    state.onHistoryCheckpoint?.({
      connectedFolderId,
      conversationId,
      reason,
      checkpointId: checkpoint.checkpointId,
      skippedLargeFiles: checkpoint.skippedLargeFiles,
    });
    for (const listener of [...state.turnCheckpointListeners]) {
      try {
        listener({ connectedFolderId, conversationId, reason, checkpointId: checkpoint.checkpointId });
      } catch {
        // Observers never affect the turn.
      }
    }
    if (checkpoint.skippedLargeFiles.length) {
      broadcast(state, streamKey(connectedFolderId, conversationId), {
        type: "status",
        conversationId,
        message: `History skipped ${checkpoint.skippedLargeFiles.length} oversized file${checkpoint.skippedLargeFiles.length === 1 ? "" : "s"}.`,
      });
    }
    return checkpoint;
  } catch (error) {
    broadcast(state, streamKey(connectedFolderId, conversationId), {
      type: "status",
      conversationId,
      message: `History checkpoint warning: ${errorMessage(error)}`,
    });
    return null;
  }
}

async function runWithHistorySafety<T>(connectedFolderRoot: string, checkpointId: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await discardConnectedFolderCheckpoint(connectedFolderRoot, checkpointId).catch(() => undefined);
    throw error;
  }
}

/**
 * Uploads and copy-ins only add files, so restoring to the pre-mutation state
 * means deleting exactly the written paths. The checkpoint is created after
 * the write so deleteOnRestore can name collision-renamed destinations
 * instead of intended paths that may belong to pre-existing files. Placement
 * and its restore record succeed or fail together: when the checkpoint cannot
 * be recorded, the written paths are removed again and the operation fails.
 */
async function checkpointAdditiveWritesOrUndo(
  connectedFolderRoot: string,
  writtenPaths: string[],
  options: { reason: string; label: string },
): Promise<ConnectedFolderCheckpoint | null> {
  if (!writtenPaths.length) return null;
  try {
    return await createConnectedFolderMutationCheckpoint(connectedFolderRoot, { deleteOnRestore: writtenPaths, ...options });
  } catch (error) {
    await Promise.all(writtenPaths.map((path) =>
      rm(resolveConnectedFolderPath(connectedFolderRoot, path), { recursive: true, force: true }).catch(() => undefined)));
    throw httpError(500, `The added files were removed because Connected Folder could not record a restore point: ${errorMessage(error)}`);
  }
}

function normalizeConnectedFolderRelativePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "");
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".txt": return "text/plain; charset=utf-8";
    case ".md": case ".markdown": return "text/markdown; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".html": case ".htm": return "text/html; charset=utf-8";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

const maxChatEventEntries = 512;
const maxChatEventBytes = 1024 * 1024;
const maxIdleChatEventLogs = 200;
const maxChatStreamQueuedBytes = 512 * 1024;

function resetChatEventTurn(state: LocalApiState, key: string): void {
  const log = chatEventLog(state, key);
  log.events = [];
  log.bytes = 0;
  log.assistantText = "";
  delete log.turnId;
}

function chatEventLog(state: LocalApiState, key: string): ChatEventLog {
  let log = state.chatEventLogs.get(key);
  if (log) {
    state.chatEventLogs.delete(key);
    state.chatEventLogs.set(key, log);
    return log;
  }
  while (state.chatEventLogs.size >= maxIdleChatEventLogs) {
    const removable = [...state.chatEventLogs.keys()].find((candidate) =>
      !state.runningTurns.has(candidate) && !state.chatStreams.has(candidate));
    if (!removable) break;
    state.chatEventLogs.delete(removable);
  }
  log = { nextId: 1, events: [], bytes: 0, assistantText: "" };
  state.chatEventLogs.set(key, log);
  return log;
}

function appendChatEvent(state: LocalApiState, key: string, data: unknown): ChatEventLogEntry {
  const log = chatEventLog(state, key);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const event = data as { type?: unknown; text?: unknown; turnId?: unknown };
    if (typeof event.turnId === "string" && event.turnId) log.turnId = event.turnId;
    if (event.type === "assistant_delta" && typeof event.text === "string") {
      const remaining = maxDurableTurnTextChars - log.assistantText.length;
      if (remaining > 0) log.assistantText += event.text.slice(0, remaining);
    }
    if (event.type === "assistant_message" && typeof event.text === "string") {
      log.assistantText = event.text.slice(0, maxDurableTurnTextChars);
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(data));
  const entry = { id: log.nextId++, data, bytes };
  log.events.push(entry);
  log.bytes += bytes;
  while (log.events.length > maxChatEventEntries || log.bytes > maxChatEventBytes) {
    const removed = log.events.shift();
    if (!removed) break;
    log.bytes -= removed.bytes;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const type = (data as { type?: unknown }).type;
    if (type === "assistant_delta" || type === "assistant_message") scheduleTurnCheckpoint(state, key);
  }
  return entry;
}

function scheduleTurnCheckpoint(state: LocalApiState, key: string): void {
  state.turnCheckpointWriter.schedule(key);
}

async function flushTurnCheckpoint(state: LocalApiState, key: string, taskId: string): Promise<void> {
  await state.turnCheckpointWriter.flush(key, taskId);
}

async function flushAllTurnCheckpoints(state: LocalApiState): Promise<void> {
  await state.turnCheckpointWriter.close();
}


function writeSseEntry(response: LocalEventSink, entry: ChatEventLogEntry): void {
  writeSseData(response, entry.data, entry.id);
}

function writeSseData(response: LocalEventSink, data: unknown, id?: number): void {
  response.send(data, id);
}

function broadcast(state: LocalApiState, key: string, event: unknown): void {
  if (event && typeof event === "object" && !Array.isArray(event)) {
    const activeTurnId = state.activeTurnIdsByKey.get(key);
    const supplied = (event as { turnId?: unknown }).turnId;
    // Native callbacks from a draining earlier turn cannot alter a newer view.
    if (typeof supplied === "string" && activeTurnId && supplied !== activeTurnId) return;
    if (supplied === undefined || supplied === null) event = { ...event, turnId: activeTurnId ?? chatEventLog(state, key).turnId ?? null };
  }
  const entry = appendChatEvent(state, key, event);
  const listeners = state.chatEventListeners.get(key);
  if (listeners) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { listeners.delete(listener); }
    }
  }
  const streams = state.chatStreams.get(key);
  if (!streams) return;
  for (const response of [...streams]) {
    try {
      if (response.closed || response.queuedBytes > maxChatStreamQueuedBytes) {
        response.close();
        streams.delete(response);
        continue;
      }
      writeSseEntry(response, entry);
    } catch {
      streams.delete(response);
    }
  }
  if (!streams.size) state.chatStreams.delete(key);
}

async function readJsonBody<T>(
  state: LocalApiState,
  req: IncomingMessage,
  maximumBytes?: number,
): Promise<T> {
  const bytes = await readBody(state, req, maximumBytes);
  if (!bytes.length) return {} as T;
  try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw badRequest("Request body must be valid JSON."); }
}

async function readMultipartBody(state: LocalApiState, req: IncomingMessage): Promise<MultipartBody> {
  const contentType = req.headers["content-type"] ?? "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean)?.trim();
  if (!boundary) throw badRequest("File upload must use multipart/form-data.");
  const body = await readBody(state, req);
  const encoded = body.toString("latin1");
  const fields = new Map<string, string>();
  const files: MultipartFile[] = [];
  for (const rawPart of encoded.split(`--${boundary}`).slice(1)) {
    if (rawPart.startsWith("--")) break;
    const part = rawPart.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const data = Buffer.from(part.slice(headerEnd + 4), "latin1");
    const disposition = /^content-disposition:\s*form-data;([^\r\n]+)$/im.exec(headers)?.[1] ?? "";
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1];
    if (!name) continue;
    const fileName = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1];
    if (fileName !== undefined) {
      files.push({
        fieldName: name,
        fileName: basename(fileName.replace(/\\/g, "/")),
        contentType: /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim() ?? "application/octet-stream",
        data,
      });
    } else {
      fields.set(name, data.toString("utf8"));
    }
  }
  return { fields, files };
}

/** A route's own bound applies under the general body cap. */
async function readBody(
  state: LocalApiState,
  req: IncomingMessage,
  maximumBytes = state.maxBodyBytes,
): Promise<Buffer> {
  const limit = Math.min(maximumBytes, state.maxBodyBytes);
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge("Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw tooLarge("Request body is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function parseRelativePaths(value: string | undefined, fileCount: number): Array<string | undefined> {
  if (!value) return Array.from({ length: fileCount }, () => undefined);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error();
    return Array.from({ length: fileCount }, (_, index) => parsed[index] as string | undefined);
  } catch {
    throw badRequest("Upload relative paths are invalid.");
  }
}

function authorize(state: LocalApiState, req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin && !state.allowedOrigins.includes(origin)) throw forbidden("Origin is not allowed.");
  if (state.sessionToken && req.headers["x-amplefile-session"] !== state.sessionToken) throw unauthorized("Unauthorized.");
}

function setCorsHeaders(state: LocalApiState, req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && state.allowedOrigins.includes(origin)) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,last-event-id,x-amplefile-session");
  res.setHeader("vary", "Origin");
  res.setHeader("x-content-type-options", "nosniff");
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** Content-free hints only. Reconnect always sends reset; no events are replayed. */
function publishControlHint(state: LocalApiState, type: "connected-folders" | "models" | "activity"): void {
  for (const response of state.controlStreams) {
    if (response.closed) continue;
    // A slow renderer must reconnect and requery instead of accumulating a queue.
    try { if (!response.send({ type })) response.close(); }
    catch { response.close(); }
  }
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.end(); return; }
  const explicit = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : null;
  const status = explicit
    ?? ampleFileCliErrorStatus(error)
    ?? automationErrorStatus(error)
    ?? 500;
  sendJson(res, {
    error: errorMessage(error),
    ...((error instanceof AmpleFileAutomationServiceError || error instanceof AmpleFileAutomationStoreError) ? { code: error.code } : {}),
  }, status);
}

function ampleFileCliErrorStatus(error: unknown): number | null {
  if (!(error instanceof AmpleFileCliError)) return null;
  switch (error.code) {
    case "usage":
    case "protocolError": return 400;
    case "permissionDenied": return 403;
    case "notFound": return 404;
    case "conflict": return 409;
    case "unavailable": return 503;
    case "timeout": return 504;
    case "failure": return 500;
  }
}

function automationErrorStatus(error: unknown): number | null {
  if (error instanceof AmpleFileAutomationServiceError) {
    switch (error.code) {
      case "INPUT_INVALID": return 400;
      case "NOT_FOUND": return 404;
      case "HEALTH_INVALID": return 409;
      case "SERVICE_DAMAGED": return 503;
    }
  }
  if (error instanceof AmpleFileAutomationStoreError) {
    switch (error.code) {
      case "INPUT_INVALID": return 400;
      case "NOT_FOUND": return 404;
      case "BOUND_EXCEEDED":
      case "HEALTH_INVALID":
      case "DIGEST_MISMATCH": return 409;
      case "STORE_DAMAGED":
      case "JOURNAL_UNAVAILABLE":
      case "JOURNAL_DAMAGED": return 503;
    }
  }
  return null;
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}
function boundedOptionalId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${name} must be a string.`);
  const id = value.trim();
  if (!id || id.length > 256) throw badRequest(`${name} must be between 1 and 256 characters.`);
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(id)) {
    throw badRequest(`${name} contains unsupported control characters.`);
  }
  return id;
}

function badRequest(message: string): Error { return httpError(400, message); }
function unauthorized(message: string): Error { return httpError(401, message); }
function forbidden(message: string): Error { return httpError(403, message); }
function notFound(message: string): Error { return httpError(404, message); }
function tooLarge(message: string): Error { return httpError(413, message); }
function unavailable(message: string): Error { return httpError(503, message); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function match(path: string, pattern: RegExp): string[] | null {
  const result = pattern.exec(path);
  return result ? result.map((value) => value === undefined ? "" : decodeURIComponent(value)) : null;
}

function streamKey(connectedFolderId: string, conversationId: string): string { return `${connectedFolderId}:${conversationId}`; }
function clientKey(connectedFolderId: string, conversationId: string): string { return streamKey(connectedFolderId, conversationId); }

function rememberConnectedFolderRoot(state: LocalApiState, connectedFolderId: string, rootPath: string): void {
  state.connectedFolderIdsByRoot.set(connectedFolderRootKey(rootPath), connectedFolderId);
}

function connectedFolderIdForRoot(state: LocalApiState, rootPath: string): string | null {
  return state.connectedFolderIdsByRoot.get(connectedFolderRootKey(rootPath)) ?? null;
}

function connectedFolderRootKey(rootPath: string): string {
  const normalized = resolve(rootPath);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function changeTurnCount(state: LocalApiState, delta: number): void {
  state.activeTurns = Math.max(0, state.activeTurns + delta);
  try {
    state.onAgentTurnActivity?.(state.activeTurns);
  } catch {
    // Desktop power/tray integration must never be able to strand a turn in
    // the server's running set if its observer fails.
  }
}

function turnStateEvent(conversationId: string, running: boolean, turnId?: string | null): { type: "turn_state"; conversationId: string; running: boolean; turnId?: string | null } {
  return { type: "turn_state", conversationId, running, ...(turnId === undefined ? {} : { turnId }) };
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolvePromise(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

// ---------------------------------------------------------------------------
// The file manager's file operations, Recents, and folder suggestions
// (docs/product-model.md, "The file manager window").

type TransferPlaceRef = { kind: "connected-folder" | "standard"; id: string };
type TransferRestorePoint = { connectedFolderId: string; checkpointId: string };

interface ResolvedTransferItem {
  abs: string;
  place: TransferPlaceRef | null;
  connectedFolder: ConnectedFolderSummary | null;
  relativePath: string;
}

function transferPlace(value: unknown): TransferPlaceRef {
  const record = value as { kind?: unknown; id?: unknown } | null;
  if (!record || (record.kind !== "connected-folder" && record.kind !== "standard") || typeof record.id !== "string" || !record.id) throw badRequest("Choose where the items are.");
  return { kind: record.kind, id: record.id };
}

async function resolveTransferItem(place: TransferPlaceRef, path: string, purpose: "read" | "change" | "target"): Promise<ResolvedTransferItem> {
  if (place.kind === "connected-folder") {
    const connectedFolder = await getConnectedFolder(place.id);
    return { abs: resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, path), place, connectedFolder, relativePath: normalizeConnectedFolderRelativePath(path) };
  }
  if (!isStandardFolderId(place.id)) throw notFound("That folder isn’t in the sidebar anymore.");
  const abs = purpose === "read"
    ? resolveStandardFolderPath(place.id, path)
    : await assertStandardFolderPathUnowned(place.id, path, userHomedir(), { allowContaining: purpose === "target" });
  return { abs, place, connectedFolder: null, relativePath: normalizeConnectedFolderRelativePath(path) };
}

/**
 * Copy (and Duplicate) adds to the target and keeps a restore point there; a
 * move inside one Connected Folder is History's own move; a move between two
 * Connected Folders keeps a restore point on each side; a move inside one Standard
 * Folder is a plain move, as Finder's. Any other move copies, leaving the
 * original where it is, and says so. Items from outside the places (a Finder
 * paste or drop) can only be copied in.
 */
export async function transferFileEntries(body: { mode?: unknown; sources?: unknown; target?: unknown }) {
  const mode = body.mode === "move" || body.mode === "duplicate" ? body.mode : body.mode === "copy" ? "copy" : null;
  if (!mode) throw badRequest("Choose copy, duplicate, or move.");
  if (!Array.isArray(body.sources) || !body.sources.length || body.sources.length > 5_000) throw badRequest("Choose items to copy or move.");
  const targetRecord = body.target as { place?: unknown; path?: unknown } | null;
  const target = await resolveTransferItem(transferPlace(targetRecord?.place), typeof targetRecord?.path === "string" ? targetRecord.path : "", "target");
  const targetInfo = await stat(target.abs).catch(() => null);
  if (!targetInfo?.isDirectory()) throw badRequest("Choose a folder to put them in.");

  const sources: ResolvedTransferItem[] = [];
  for (const raw of body.sources as unknown[]) {
    const record = raw as { nativePath?: unknown; place?: unknown; path?: unknown } | null;
    if (typeof record?.nativePath === "string") {
      if (mode === "move") throw badRequest("Items from Finder are copied in, not moved.");
      const abs = resolve(record.nativePath);
      if (!(await lstat(abs).catch(() => null))) throw badRequest(`“${basename(abs)}” isn’t there anymore.`);
      sources.push({ abs, place: null, connectedFolder: null, relativePath: "" });
      continue;
    }
    if (typeof record?.path !== "string" || !record.path.trim()) throw badRequest("Choose items to copy or move.");
    sources.push(await resolveTransferItem(transferPlace(record.place), record.path, mode === "move" ? "change" : "read"));
  }
  for (const source of sources) {
    if (isInside(source.abs, target.abs)) throw badRequest(`“${basename(source.abs)}” can’t go inside itself.`);
  }

  const sameConnectedFolder = (item: ResolvedTransferItem) => Boolean(item.connectedFolder && target.connectedFolder && item.connectedFolder.id === target.connectedFolder.id);
  const placeKey = (item: ResolvedTransferItem) => item.place ? `${item.place.kind}:${item.place.id}` : "";

  if (mode === "move" && sources.every(sameConnectedFolder)) {
    const moved = await moveConnectedFolderEntriesWithHistory(target.connectedFolder!, sources.map((item) => item.relativePath), target.relativePath);
    return {
      mode,
      written: moved.moved.map((item) => item.path),
      restorePoints: [{ connectedFolderId: target.connectedFolder!.id, checkpointId: moved.safetyCheckpointId }],
      ...(moved.failed ? { failed: moved.failed } : {}),
    };
  }
  if (mode === "move" && target.place?.kind === "standard" && sources.every((item) => placeKey(item) === placeKey(target))) {
    const moves: Array<{ from: string; to: string }> = [];
    for (const source of sources) {
      const destination = await moveInto(source.abs, target.abs);
      moves.push({ from: source.relativePath, to: relativeTo(standardFolderRoot(target.place.id as StandardFolderId), destination) });
    }
    return { mode, written: moves.map((item) => item.to), moves, restorePoints: [] };
  }
  const sourceConnectedFolder = sources[0]?.connectedFolder ?? null;
  const crossConnectedFolderMove = mode === "move" && Boolean(target.connectedFolder) && Boolean(sourceConnectedFolder)
    && sources.every((item) => item.connectedFolder?.id === sourceConnectedFolder!.id);
  const copiedInstead = mode === "move" && !crossConnectedFolderMove;
  const label = (verb: string) => `Before ${verb} ${sources.length === 1 ? basename(sources[0]!.abs) : `${sources.length} items`}`;

  // A move between Connected Folders first records everything it will take from the source.
  const sourceSafety = crossConnectedFolderMove
    ? await createConnectedFolderMutationCheckpoint(sourceConnectedFolder!.connectedFolderRoot, {
      paths: sources.map((item) => item.relativePath),
      reason: "pre_move",
      label: `${label("moving")} to ${target.connectedFolder!.name}`,
    })
    : null;
  const written: string[] = [];
  try {
    for (const source of sources) {
      const sameFolder = dirname(source.abs) === target.abs;
      written.push(await copyInto(source.abs, target.abs, { duplicate: mode === "duplicate" || sameFolder }));
    }
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
    if (sourceSafety) await discardConnectedFolderCheckpoint(sourceConnectedFolder!.connectedFolderRoot, sourceSafety.checkpointId).catch(() => undefined);
    throw error;
  }
  const targetRoot = target.connectedFolder?.connectedFolderRoot ?? (target.place?.kind === "standard" ? standardFolderRoot(target.place.id as StandardFolderId) : target.abs);
  const writtenPaths = written.map((path) => relativeTo(targetRoot, path));
  const restorePoints: TransferRestorePoint[] = [];
  if (target.connectedFolder) {
    const verb = mode === "duplicate" ? "duplicating" : crossConnectedFolderMove ? "moving" : "pasting";
    const targetSafety = await checkpointAdditiveWritesOrUndo(target.connectedFolder.connectedFolderRoot, writtenPaths, { reason: crossConnectedFolderMove ? "pre_move" : "pre_copy", label: label(verb) });
    if (targetSafety) restorePoints.push({ connectedFolderId: target.connectedFolder.id, checkpointId: targetSafety.checkpointId });
  }
  if (crossConnectedFolderMove) {
    await Promise.all(sources.map((source) => rm(source.abs, { recursive: true, force: true })));
    restorePoints.push({ connectedFolderId: sourceConnectedFolder!.id, checkpointId: sourceSafety!.checkpointId });
  }
  return { mode: copiedInstead ? "copy" : mode, written: writtenPaths, restorePoints, ...(copiedInstead ? { copiedInstead: true } : {}) };
}

async function compressEntries(body: { place?: unknown; paths?: unknown }) {
  const place = transferPlace(body.place);
  if (!Array.isArray(body.paths) || !body.paths.length || body.paths.some((path) => typeof path !== "string" || !path.trim())) throw badRequest("Choose items to compress.");
  const items = await Promise.all((body.paths as string[]).map((path) => resolveTransferItem(place, path, "read")));
  const folder = dirname(items[0]!.abs);
  const folderRelative = items[0]!.relativePath.includes("/") ? items[0]!.relativePath.slice(0, items[0]!.relativePath.lastIndexOf("/")) : "";
  const target = await resolveTransferItem(place, folderRelative, "target");
  const archive = await compressInto(items.map((item) => item.abs), folder);
  const root = target.connectedFolder?.connectedFolderRoot ?? standardFolderRoot(place.id as StandardFolderId);
  const path = relativeTo(root, archive);
  const safety = target.connectedFolder
    ? await checkpointAdditiveWritesOrUndo(target.connectedFolder.connectedFolderRoot, [path], { reason: "pre_compress", label: `Before compressing ${items.length === 1 ? basename(items[0]!.abs) : `${items.length} items`}` })
    : null;
  return { path, restorePoints: safety ? [{ connectedFolderId: target.connectedFolder!.id, checkpointId: safety.checkpointId }] : [] };
}

/**
 * Recents: files changed in the last 30 days, newest first: everything in the
 * Connected Folders (as their own rules show them) and the files at the top of
 * Desktop, Documents, and Downloads.
 */
async function recentFiles(connectedFolders: readonly ConnectedFolderSummary[]) {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  const found: Array<{ place: TransferPlaceRef; path: string; name: string; kind: "file"; sizeBytes?: number; updatedAt: string; where: string }> = [];
  const collect = (place: TransferPlaceRef, where: string, entries: readonly TreeEntry[]) => {
    for (const entry of entries) {
      if (entry.nestedFolder) continue;
      if (entry.children) collect(place, where, entry.children);
      if (entry.kind !== "file" || !entry.updatedAt || Date.parse(entry.updatedAt) < since) continue;
      found.push({ place, path: entry.path, name: entry.name, kind: "file", ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}), updatedAt: entry.updatedAt, where });
    }
  };
  for (const connectedFolder of connectedFolders) {
    const scan = await scanConnectedFolderTree(connectedFolder.connectedFolderRoot, 20, "", { includeIgnored: false, nestedFolderPaths: await nestedRegisteredConnectedFolderPaths(connectedFolder.connectedFolderRoot) }).catch(() => null);
    if (scan) collect({ kind: "connected-folder", id: connectedFolder.id }, connectedFolder.name, scan.entries);
  }
  const standard = await listStandardFolders(connectedFolders).catch(() => []);
  for (const folder of standard) {
    if (folder.connectedFolderId || !["desktop", "documents", "downloads"].includes(folder.id)) continue;
    const scan = await scanStandardFolder(folder.id, "").catch(() => null);
    if (scan) collect({ kind: "standard", id: folder.id }, folder.name, scan.tree);
  }
  return found.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 200);
}

const folderSuggestionCache = new Map<string, { key: string; at: number; suggestions: string[] }>();
const folderSuggestionLifetimeMs = 30 * 60 * 1_000;

/**
 * Up to four short messages a person might send next, written by the
 * Connected Folder's own model from the folder's names (and the folder shown inside
 * it) and its recent Chat titles. Kept while those stay the same; an empty
 * list means "use the plain ones" (no model, or the call failed).
 */
async function folderSuggestions(state: LocalApiState, connectedFolder: ConnectedFolderSummary, path: string): Promise<string[]> {
  const relativePath = normalizeConnectedFolderRelativePath(path);
  const scan = await scanConnectedFolderTree(connectedFolder.connectedFolderRoot, 0, relativePath, { includeIgnored: false, nestedFolderPaths: await nestedRegisteredConnectedFolderPaths(connectedFolder.connectedFolderRoot) }).catch(() => null);
  const entries = (scan?.entries ?? []).slice(0, 80).map((entry) => `${entry.kind === "folder" ? "folder" : "file"}: ${entry.name}${entry.updatedAt ? ` (changed ${entry.updatedAt.slice(0, 10)})` : ""}`);
  const chats = (await listConversations(connectedFolder.connectedFolderRoot).catch(() => [])).slice(0, 8).map((chat) => chat.title).filter(Boolean);
  const key = JSON.stringify([relativePath, entries, chats]);
  const cacheKey = `${connectedFolder.id}\0${relativePath}`;
  const cached = folderSuggestionCache.get(cacheKey);
  if (cached && cached.key === key && Date.now() - cached.at < folderSuggestionLifetimeMs) return cached.suggestions;
  try {
    const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, ampleFileInferenceConversationId);
    const outcome = await client.infer({
      instructions: [
        "Suggest up to four short messages this person might send next to the assistant that works in this folder.",
        "Each is an instruction or question in their own words, 2 to 6 words, plain and specific to what is actually here (name real files or folders when it helps).",
        "No numbering, quotes, or emoji. Prefer useful work: tidy, summarize, find, compare, plan, draft. Don't suggest anything that deletes files.",
      ].join(" "),
      input: JSON.stringify({ folder: relativePath ? `${connectedFolder.name}/${relativePath}` : connectedFolder.name, items: entries, recentChats: chats }),
      outputSchema: {
        type: "object",
        properties: { suggestions: { type: "array", items: { type: "string", maxLength: 48 }, maxItems: 4 } },
        required: ["suggestions"],
        additionalProperties: false,
      } as never,
      maxOutputBytes: 2_048,
    });
    const suggestions = outcome.kind === "json"
      ? ((outcome.json as { suggestions?: unknown }).suggestions as unknown[] ?? []).filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().replace(/[.]$/, "")).slice(0, 4)
      : [];
    folderSuggestionCache.set(cacheKey, { key, at: Date.now(), suggestions });
    return suggestions;
  } catch {
    return [];
  }
}
