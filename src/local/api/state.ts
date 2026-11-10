/**
 * The local API's shared state and the request context its route groups take.
 *
 * `startLocalApi` builds one `LocalApiState`, and every route group, facade,
 * and helper in this folder takes it as an argument. `LocalApiRequest` is that
 * state plus the request being answered. The keys here name a Chat's stream
 * and client and a Connected Folder's root inside that state.
 */

import type { LocalEventSink } from "../local-event-stream.js";
import type { BrowserToolHost } from "../../shared/browser.js";
import { ModelContextInspector } from "../agent/model-context-inspector.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { PiConversationClient, type PiRuntimeProvider } from "../agent/pi-client.js";
import { AmpleFileTurnStore } from "../agent/turn-store.js";
import { TurnCheckpointWriter } from "../agent/turn-checkpoint-writer.js";
import { RoutedPiExtensionUiBridge, type PiExtensionUiRequest } from "../agent/extension-ui.js";
import type { ChatMessage } from "../agent/chat-store.js";
import type { CapabilityRegistryService } from "../agent/capability-registry.js";
import { RegisteredConnectedFolderTrustAuthority } from "../agent/registered-connected-folder-runtime.js";
import type { PiOAuthHooks } from "../agent/pi-runtime-config.js";
import { ProviderSignIns } from "../agent/provider-sign-in.js";
import { ImageModelPreference } from "../agent/image-model-preference.js";
import { GeneratedImageStore } from "../agent/generated-image-store.js";
import { AmpleFileRequestStore } from "../requests/request-store.js";
import { AmpleFileJobService } from "../jobs/job-service.js";
import { AmpleFileJobStore } from "../jobs/job-store.js";
import type { PiConnectedFolderTurnContext } from "../agent/connected-folder-turn-context.js";
import { ConnectedFolderAppearanceStore } from "../connected-folder-appearance-store.js";
import { PreparedActExecutor } from "../prepared-acts.js";
import { AmpleFileOverviewSeenStore } from "../overview-seen-store.js";
import { AmpleFileAutomationService } from "../automations/automation-service.js";
import { AmpleFileRecentlyDeletedStore } from "../recently-deleted-store.js";
import { AmpleFileKernel } from "../amplefile-kernel.js";
import { AmpleFileCliActReceipts } from "../cli/act-receipts.js";
import type { AmpleFileActChatState } from "../cli/act-facade.js";
import type { ConnectedFolderRemovalIo } from "../connected-folder.js";

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

export interface LocalApiState {
  appMode: "dev" | "desktop";
  connectedFolderBase?: string;
  allowedOrigins: string[];
  /** The address the API listens on, accepted in a request's Host alongside this computer's loopback names. */
  listenHost: string;
  sessionToken?: string;
  maxBodyBytes: number;
  runtimeProvider: PiRuntimeProvider;
  extensionUi: RoutedPiExtensionUiBridge;
  modelContextInspector: ModelContextInspector;
  piOAuthHooks?: PiOAuthHooks;
  /** The provider sign-in a window may cancel or finish with a pasted link. */
  providerSignIns: ProviderSignIns;
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
export interface SettledTurnRecord {
  taskId: string;
  connectedFolderId: string;
  conversationId: string;
  status: "succeeded" | "failed" | "aborted";
  endedAt: string;
  messageId?: string;
  error?: string;
}

export interface ChatEventLogEntry {
  id: number;
  data: unknown;
  bytes: number;
}

export interface ChatEventLog {
  nextId: number;
  turnId?: string;
  events: ChatEventLogEntry[];
  bytes: number;
  assistantText: string;
}

export interface TurnCheckpointEvent {
  connectedFolderId: string;
  conversationId: string;
  reason: "pre_turn" | "post_turn";
  checkpointId: string;
}

/**
 * One authorized request as a route group sees it: the API's shared state and
 * the request being answered. A route group answers the request and returns
 * true, or returns false when the request is not one of its routes.
 */
export interface LocalApiRequest {
  state: LocalApiState;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
}

export function conversationRuntimeState(state: LocalApiState, connectedFolderId: string, conversationId: string): AmpleFileActChatState {
  const key = clientKey(connectedFolderId, conversationId);
  if (state.runningTurns.has(key)) return "running";
  if (state.compactingConversations.has(key)) return "compacting";
  return "idle";
}

export interface QueuedChatMessage {
  content: string;
  /** Files attached in the composer, for a Connected Folder Chat. */
  contextPaths: string[];
  /** Workers the message addresses with @. */
  addressedConnectedFolderIds: string[];
  updatedAt: string;
  /** Set by a Stop: kept for the person to take back, never sent. A new queue write arms it again. */
  held?: true;
}

export interface BackgroundCompaction {
  timer: NodeJS.Timeout | null;
  /** Present while the summary is being written. */
  run: { client: PiConversationClient; done: Promise<void> } | null;
  /** Set when something that needs the Chat cancelled it; that is not a failure. */
  yielded: boolean;
}

export function streamKey(connectedFolderId: string, conversationId: string): string { return `${connectedFolderId}:${conversationId}`; }
export function clientKey(connectedFolderId: string, conversationId: string): string { return streamKey(connectedFolderId, conversationId); }

export function rememberConnectedFolderRoot(state: LocalApiState, connectedFolderId: string, rootPath: string): void {
  state.connectedFolderIdsByRoot.set(connectedFolderRootKey(rootPath), connectedFolderId);
}

export function connectedFolderIdForRoot(state: LocalApiState, rootPath: string): string | null {
  return state.connectedFolderIdsByRoot.get(connectedFolderRootKey(rootPath)) ?? null;
}

export function connectedFolderRootKey(rootPath: string): string {
  const normalized = resolve(rootPath);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}
