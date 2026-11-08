import type { RestrictedAppCheckGrant, RestrictedAppCheckPermission } from "../../src/shared/restricted-app-checks";
import type { AccentIdentity, ConnectedFolderAppearanceState } from "../../src/shared/connected-folder-appearance";
import type { AmpleFileCheckRendererOverview } from "../../src/local/checks/check-types";
export type AppTheme = "light" | "dark";
export type AppThemePreference = AppTheme | "system";
export type AppTypographyFont = "default" | "stable" | "verdana" | "aptos";

import type { ConnectedFolderSummary } from "../../src/shared/connected-folder-summary";
export type { ConnectedFolderLocation, ConnectedFolderSummary } from "../../src/shared/connected-folder-summary";

export interface ConnectedFolderCustomization {
  schema?: 1 | 2;
  color?: string;
  color2?: string;
  primary?: AccentIdentity;
  secondary?: AccentIdentity;
  iconName?: string;
  bannerName?: string;
  bannerImage?: string | null;
  bannerImagePosition?: ConnectedFolderBannerImagePosition;
  bannerPreset?: import("../../src/shared/connected-folder-appearance").ConnectedFolderAppearanceBannerPresetId;
  bannerFraming?: import("../../src/shared/connected-folder-appearance").ConnectedFolderAppearanceBannerFraming;
  bannerLayout?: import("../../src/shared/connected-folder-appearance").ConnectedFolderAppearanceBannerLayout;
  bannerIconStyle?: import("../../src/shared/connected-folder-appearance").ConnectedFolderAppearanceBannerIconStyle;
  bannerTitleFill?: import("../../src/shared/connected-folder-appearance").ConnectedFolderAppearanceBannerTitleFill;
}

export type ConnectedFolderCustomizationMap = Record<string, ConnectedFolderCustomization>;
export type ConnectedFolderCustomizationPatch = ConnectedFolderCustomization;
export interface ConnectedFolderColorOption { label: string; color: string; soft: string; border: string }
export interface ConnectedFolderBannerOption { name: string; label: string }
export type ConnectedFolderBannerImagePosition = "top" | "center" | "bottom";

export interface TreeEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt?: string;
  hasChildren?: boolean;
  ignored?: boolean;
  descendantIgnoredCount?: number;
  children?: TreeEntry[];
  /** Its own registered Connected Folder: Files shows it as a door, not a subtree. */
  nestedFolder?: true;
}

export interface FileContextMenuState {
  entry: TreeEntry;
  /** Set when the row is one of several selected together: the menu acts on all of them. */
  selection?: TreeEntry[];
  x: number;
  y: number;
  returnFocusTarget?: HTMLElement | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  archivedAt?: string | null;
  snoozedUntil?: string | null;
}

export interface ChatMessageLanding {
  title?: string;
  summary: string;
  nextActions: string[];
  followUpPrompt: string | null;
  conversationTitle?: string;
  generatedAt: string;
  provider: string;
  model: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  kind?: "conversation_title" | "conversation_lifecycle" | "assistant_continuation" | "context_compaction";
  titleSource?: "placeholder" | "generated" | "attempted" | "manual";
  lifecycle?: { archived?: boolean; snoozedUntil?: string | null };
  landing?: ChatMessageLanding;
  workTrail?: ChatMessageWorkTrailEntry[];
  assistantPresentation?: import("../../src/shared/chat-presentation").AssistantPresentation;
  interruption?: ChatMessageInterruption;
  /** Files sent with a user message, as Connected Folder–relative paths. */
  attachments?: { kind: "file" | "folder" | "url"; target: string; name: string }[];
  turnId?: string;
  requestId?: string;
  /** Sent into an already-running turn; the agent saw it after its current step. */
  delivery?: "steer";
  /** `app`: an installed app asked for this (`assistant.request`), not the person. */
  source?: "app";
  appId?: string;
  appTitle?: string;
}

export interface ChatMessageInterruption {
  reason: "provider_error" | "setup_error" | "assistant_error" | "cancelled" | "app_interrupted";
  message: string;
  retryAttempts: number;
  provider: string | null;
  model: string | null;
  activities: ChatMessageInterruptionActivity[];
}

export interface ChatMessageInterruptionActivity {
  message: string;
  detail?: string;
  toolName?: string;
  toolTitle?: string;
  phase?: AgentActivityPhase;
}

export type ChatMessageWorkTrailEntry = import("../../src/shared/chat-presentation").ChatWorkTrailEntry;

export type AgentActivityPhase = "queued" | "running" | "streaming" | "complete" | "error";
export interface RuntimePreviewEntry extends Omit<import("../../src/shared/chat-presentation").ChatLiveWorkTrailEntry, "kind"> {
  kind: "thinking" | "tool" | "progress" | "command";
}

export type ChatActivityStatus = "running" | "attention";
export type ChatLifecycleView = "active" | "snoozed" | "archived";

export type ContextAttachmentMode = "full_original_text" | "full_extracted_text" | "image" | "path_only_reference";
export interface ContextAttachment {
  sourcePath: string;
  /** A folder reference ("Work on this folder" in the file manager). */
  sourceKind?: "folder";
  sourceFileName: string;
  sourceSizeBytes: number;
  mode: ContextAttachmentMode;
  includedInPrompt: boolean;
  reason: string | null;
  estimatedTokens: number;
  budgetTokens: number;
  budgetStatus?: "preview";
  provenance: string[];
  warnings: string[];
  userLabel: string;
  detail: string;
}
export interface ChatContextPathRequest {
  id: number;
  /** One file, or several attached together from Files. */
  paths: readonly string[];
  connectedFolderId: string;
  surfaceTabId: string;
}
/**
 * Sends a message at once with these Connected Folder paths as references: the
 * file manager's message box (2026-11-06) hands its words and selection to
 * the Chat it opens in the panel.
 */
export interface ChatSendRequest {
  id: number;
  text: string;
  paths: readonly string[];
}
/** Seeds a Chat composer with starter text; the person finishes the sentence and sends. */
export interface ChatDraftRequest {
  id: number;
  text: string;
  connectedFolderId: string;
  surfaceTabId: string;
}
export interface PendingChatSend {
  conversation: ConversationSummary;
  content: string;
  requestId: string;
  userMessageId: string;
  localUserMessage: ChatMessage;
  contextPaths: string[];
  transientConversation: boolean;
  draftStorageKey: string;
  /** Connected Folder Workers the message @-mentions (2026-10-01). */
  addressedConnectedFolderIds?: string[];
}
export interface ConnectedFolderFixtureConversation extends ConversationSummary {
  messages: ChatMessage[];
  runtimePreviews?: RuntimePreviewEntry[];
  running?: boolean;
  streamingAssistant?: string;
  contextAttachments?: ContextAttachment[];
}

export type SkillsExtensionsView = "installed" | "discover";
export type ChecksOverview = AmpleFileCheckRendererOverview;

export interface AgentStatus {
  ready: boolean;
  configured: boolean;
  provider: string | null;
  model: string | null;
  piVersion: string | null;
  projectTrusted?: boolean;
  error: string | null;
}

export interface AgentModel {
  provider: string;
  providerName?: string;
  id: string;
  name: string;
  authConfigured: boolean;
  authSource?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  authLabel?: string;
  authType?: "api_key" | "oauth";
  oauthSupported: boolean;
  contextWindow?: number;
}

/** Non-secret connection metadata from Pi's complete provider catalog. */
export interface AgentProvider {
  id: string;
  name: string;
  configured: boolean;
  authSource?: AgentModel["authSource"];
  authLabel?: string;
  authType?: "api_key" | "oauth";
  apiKey: boolean;
  apiKeyLabel?: string;
  oauth: boolean;
  oauthLabel?: string;
  oauthAvailable: boolean;
  guidedSetup: boolean;
  modelCount: number;
}

export interface AgentModelCatalog {
  provider: string;
  refreshable: boolean;
  source: "built_in" | "live";
  refreshedAt?: string;
  modelCount?: number;
}

export interface ComposerState {
  model?: { provider: string; id: string; name: string };
  thinkingLevel: string;
  thinkingLevels: string[];
}

export interface AgentCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill";
}

export interface ConversationRuntime {
  sessionId: string;
  model?: { provider: string; id: string; name: string };
  usage: {
    contextTokens: number | null;
    contextWindow: number | null;
    contextPercent: number | null;
    totalTokens: number;
    cost: number;
  };
  thinkingLevel: string;
  /** Levels the current model supports, in Pi's ascending order. */
  thinkingLevels?: string[];
  activeTools: string[];
  isStreaming: boolean;
  isCompacting: boolean;
}

export interface AgentSkill {
  id?: string;
  name: string;
  description: string;
  path: string;
  source: string | AgentCapabilitySource;
  sourceInfo?: AgentCapabilitySource;
  scope?: AgentCapabilityScope | "user";
  origin?: AgentCapabilityOrigin;
  packageSource?: string;
  enabled?: boolean;
  loaded?: boolean;
  status?: AgentCapabilityStatus;
  disableModelInvocation?: boolean;
  content?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentExtension {
  id: string;
  name: string;
  path: string;
  source: string | AgentCapabilitySource;
  sourceInfo?: AgentCapabilitySource;
  scope?: AgentCapabilityScope | "user";
  origin?: AgentCapabilityOrigin;
  packageSource?: string;
  enabled?: boolean;
  loaded?: boolean;
  status?: AgentCapabilityStatus;
  commands: string[];
  tools: string[];
  flags?: string[];
  diagnostics?: AgentDiagnostic[];
}

export type AgentCapabilityScope = "global" | "project";
export type AgentCapabilityOrigin = "package" | "top-level";
export type AgentCapabilityStatus = "loaded" | "available" | "disabled" | "error" | "blocked" | "missing";
export interface AgentCapabilitySource {
  label?: string;
  path?: string;
  source: string;
  scope: "user" | "project" | "temporary" | AgentCapabilityScope;
  origin: AgentCapabilityOrigin;
  baseDir?: string;
  packageSource?: string;
}
export interface AgentProjectTrust {
  required: boolean;
  trusted: boolean;
  savedDecision: boolean | null;
  mutationTrusted?: boolean;
}
export interface AgentPackage {
  source: string;
  scope: AgentCapabilityScope;
  enabled?: boolean;
  installed?: boolean;
  loaded?: boolean;
  filtered?: boolean;
  installedPath?: string;
  updateAvailable?: boolean;
  displayName?: string;
  types?: Array<"skill" | "extension" | "prompt" | "theme">;
}
export interface AgentTool {
  name: string;
  label?: string;
  description: string;
  source: string;
  active: boolean;
  kind?: "core" | "extension";
  core?: boolean;
  configurable?: false;
  configurationScope?: "chat";
}
export interface AgentToolManagement {
  mode: "session-only";
  persisted: false;
  mutable: false;
  scope: "chat";
  reason: string;
}
export interface AgentDiagnostic { type: "info" | "warning" | "error"; message: string; path?: string }
export type AgentSurfaceBlock =
  | { type: "heading"; text: string; level: 1 | 2 | 3 }
  | { type: "text"; text: string }
  | { type: "callout"; tone: "info" | "success" | "warning"; title?: string; text: string }
  | { type: "metrics"; items: Array<{ label: string; value: string; detail?: string }> }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "list"; items: Array<{ title: string; detail?: string; badge?: string }> };
export interface AgentExtensionSurfaceView {
  id: string;
  title: string;
  description?: string;
  blocks: AgentSurfaceBlock[];
}
export interface AgentExtensionSurface {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  extensionPath: string;
  manifestPath: string;
  source: string | AgentCapabilitySource;
  sourceInfo?: AgentCapabilitySource;
  scope?: AgentCapabilityScope | "user" | "temporary";
  origin?: AgentCapabilityOrigin;
  packageSource?: string;
  enabled?: boolean;
  loaded?: boolean;
  status?: AgentCapabilityStatus;
  views: AgentExtensionSurfaceView[];
}

export type RestrictedAppOAuthDiscoveryKind =
  | "oauth-authorization-server"
  | "openid-configuration"
  | "pinned";

export interface RestrictedAppOAuthPkceDeclaration {
  kind: "oauth2-pkce";
  issuer: string;
  clientId: string;
  scopes: string[];
  discovery?: RestrictedAppOAuthDiscoveryKind;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  authorizationParameters?: Array<{ name: string; value: string }>;
}

export type RestrictedAppAuthDeclaration =
  | { kind: "api-key"; header: string }
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "basic" }
  | RestrictedAppOAuthPkceDeclaration;

export interface RestrictedAppJsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, RestrictedAppJsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: RestrictedAppJsonSchema;
  enum?: Array<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface RestrictedAppTool {
  name: string;
  description: string;
  action: string;
  inputSchema: RestrictedAppJsonSchema;
  resultSchema: RestrictedAppJsonSchema;
}

export interface RestrictedAppNetworkDestination {
  id: string;
  target:
    | { kind: "public-https"; origin: string }
    | { kind: "loopback-http"; host: "127.0.0.1" | "::1"; port: number };
  methods: Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">;
  auth: RestrictedAppAuthDeclaration[];
}

export interface RestrictedAppFilePermission {
  id: string;
  target: "file" | "directory";
  access: "read" | "read-write";
}

export interface RestrictedAppFileGrant {
  id: string;
  declarationId: string;
  root: string;
  access: "read" | "read-write";
}

export interface RestrictedAppNotificationPermission {
  id: string;
  title: string;
  description: string;
}

export interface RestrictedAppAutomation {
  id: string;
  title: string;
  description?: string;
  handler: string;
  trigger: { kind: "interval"; intervalMinutes: number };
  permissions: {
    network: string[];
    files: string[];
    notifications: string[];
  };
  catchUp: "none" | "latest";
  overlap: "skip";
}

export interface RestrictedAppManifest {
  version: 2;
  id: string;
  title: string;
  description?: string;
  runtime: { kind: "sandboxed-web"; entry: string; worker?: string };
  ui: { icon?: string; cornerRadius?: number };
  tools: RestrictedAppTool[];
  assistantActions?: { id: string; title: string; instructions: string; inputSchema: RestrictedAppJsonSchema }[];
  automations: RestrictedAppAutomation[];
  permissions: {
    network: RestrictedAppNetworkDestination[];
    files: RestrictedAppFilePermission[];
    checks?: RestrictedAppCheckPermission[];
    notifications: RestrictedAppNotificationPermission[];
  };
}

export interface RestrictedAppReview {
  packageName: string;
  version: string;
  digest: string;
  artifactDigest: string;
  manifest: RestrictedAppManifest;
  fileCount: number;
  totalBytes: number;
}

export interface RestrictedAppInstalled extends RestrictedAppReview {
  connectedFolderId: string;
  sourceConnectedFolderId: string;
  projectId: string;
  tenantId: string;
  principalId: string;
  runtimeInstanceId: string;
  runtimeInstanceKind: "development" | "app";
  releaseDigest: string | null;
  featureInstallationId: string;
  dataNamespaceId: string;
  authority: AppPlatformAuthorityStamp;
  networkGrants: string[];
  fileGrants: RestrictedAppFileGrant[];
  checkGrants?: RestrictedAppCheckGrant[];
  notificationGrants: string[];
  automations: RestrictedAppAutomationState[];
  installedAt: string;
  updatedAt: string;
}

export interface LocalAppPresentation {
  title: string;
  description: string | null;
  icon: string | null;
}

export interface LocalAppProject {
  connectedFolderId: string;
  projectId: string;
  presentation: LocalAppPresentation;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAppRelease {
  projectId: string;
  sourceConnectedFolderId: string;
  releaseDigest: string;
  displayVersion: string;
  presentation: LocalAppPresentation;
  featureIds: string[];
  state: "prepared" | "published";
  preparedAt: string;
  publishedAt: string | null;
}

export interface LocalAppReleaseDeletionResult {
  deleted: boolean;
  cleanupPending: boolean;
  /** Where the deleted Release waits to be restored (docs/receipts-not-gates.md, F20). */
  recentlyDeleted?: { entryId: string; restoreBy: string } | null;
}

export interface LocalAppInstance {
  runtimeInstanceId: string;
  projectId: string;
  connectedFolderId: string;
  releaseDigest: string;
  displayVersion: string;
  presentation: LocalAppPresentation;
  featureIds: string[];
  installedAt: string;
  updatedAt: string;
}

export interface LocalAppInstallOperation {
  operationId: string;
  kind: "install";
  projectId: string;
  targetConnectedFolderId: string;
  releaseDigest: string;
  runtimeInstanceId: string;
  features: Array<{ featureId: string; featureInstallationId: string; dataNamespaceId: string }>;
  preparedAt: string;
}

export interface LocalAppUpdateOperation {
  operationId: string;
  kind: "update";
  projectId: string;
  targetConnectedFolderId: string;
  releaseDigest: string;
  runtimeInstanceId: string;
  continuityPolicy: "eligible" | "reset";
  plan: {
    planDigest: string;
    fromReleaseDigest: string;
    toReleaseDigest: string;
    canCommit: boolean;
    blockedReasons: string[];
    transitions: Array<{
      featureId: string;
      action: "add" | "keep" | "update" | "remove";
      data: "create" | "retain" | "migrate" | "retain-disabled";
      continuity: { grants: string[]; connections: string[]; enabledJobs: string[] };
      resets: Array<"grants" | "connections" | "jobs">;
      blockedReason?: string;
    }>;
  };
  preparedAt: string;
}

export type LocalAppOperation = LocalAppInstallOperation | LocalAppUpdateOperation;

export interface LocalAppRetainedData {
  retainedDataId: string;
  projectId: string;
  runtimeInstanceId: string;
  featureId: string;
  featureInstallationId: string;
  dataNamespaceId: string;
  releaseDigest: string;
  removedAt: string;
}

export interface LocalAppStudioSnapshot {
  project: LocalAppProject | null;
  previews: RestrictedAppInstalled[];
  releases: LocalAppRelease[];
  instances: LocalAppInstance[];
  operations: LocalAppOperation[];
  retainedData: LocalAppRetainedData[];
}

export interface LocalAppConnectedFolderRemovalImpact {
  activeSourceInstanceCount: number;
  activeTargetInstanceCount: number;
  retainedDataCount: number;
  incomingPreparedOperationCount: number;
}

export interface RestrictedAppAutomationState {
  id: string;
  enabled: boolean;
  lastRunAt?: string;
  lastError?: string;
  nextRunAt?: string;
}

export interface RestrictedAppAutomationRunReceipt {
  receiptId: string;
  verification: "captured";
  runId: string;
  appAutomationId: string;
  reason: "scheduled" | "manual" | "resume";
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
  outcome: "success" | "failure" | "skipped" | "cancelled" | "interrupted";
  error?: string;
  kind?: "job";
  tenantId?: string;
  runtimeInstanceId?: string;
  featureInstallationId?: string;
  featureRevisionDigest?: string;
  dataNamespaceId?: string;
  effectivePrincipal?: AppPlatformEffectivePrincipal;
  authority?: AppPlatformAuthorityStamp;
  acceptedAt?: string;
  state?: "succeeded" | "failed" | "skipped" | "cancelled" | "expired";
  occurrenceId?: string;
  attemptId?: string;
}

export interface AppPlatformEffectivePrincipal {
  principalId: string;
  kind: "human" | "agent" | "service" | "system";
  realm: "local" | "cloud";
}

export interface AppPlatformAuthorityStamp {
  runtimeInstanceGeneration: string;
  featureInstallationGeneration: string;
  grantGeneration: string;
  connectionGeneration: string;
  jobGeneration: string;
  principalGeneration: string;
  dataGeneration: string;
}

export interface RestrictedAppProposal {
  id: string;
  connectedFolderId: string;
  conversationId: string;
  sourcePath: string;
  review: RestrictedAppReview;
  status: "pending" | "installed" | "failed" | "dismissed" | "revision-changed";
  createdAt: string;
  updatedAt: string;
  installedApp?: RestrictedAppInstalled;
  /** Bounded plain text from a failed install. */
  error?: string;
  /** What still needs a person after the install. */
  needs?: { connections: string[]; files: string[]; checks: string[] };
}

export interface RestrictedAppConnectionStatus {
  destinationId: string;
  owner: "instance" | "principal";
  kind: "api-key" | "bearer" | "basic" | "oauth2-pkce" | "none" | null;
  configured: boolean;
  diagnostics?: Array<{
    code: "METADATA_RESPONSE_TYPE_UNDECLARED" | "METADATA_PKCE_UNDECLARED" | "METADATA_PUBLIC_CLIENT_UNDECLARED";
    issuer: string;
    message: string;
  }>;
}

export interface RestrictedAppStorageUsage {
  revision: number;
  usageBytes: number;
  quotaBytes: number;
  keyCount: number;
  keyLimit: number;
}

export interface RestrictedAppDataRecovery {
  id: string;
  createdAt: string;
  available: boolean;
}

export type RestrictedAppCredential =
  | { kind: "api-key"; value: string }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string };
export interface AgentCatalog {
  resources?: import("../../src/local/agent/resource-lifecycle").NativeResource[];
  skills: AgentSkill[];
  extensions: AgentExtension[];
  packages: AgentPackage[];
  tools: AgentTool[];
  commands?: AgentCommand[];
  toolManagement?: AgentToolManagement;
  diagnostics: AgentDiagnostic[];
  surfaces?: AgentExtensionSurface[];
  trust?: AgentProjectTrust;
  projectTrusted?: boolean;
}

export interface CapabilityDiscoverItem {
  id: string;
  name: string;
  description: string;
  types: Array<"skill" | "extension">;
  sourceKind: string;
  installSource?: string;
  official: boolean;
  author?: string;
  version?: string;
  downloads?: number;
  publishedAt?: string;
  repositoryUrl?: string;
  homepageUrl?: string;
  npmUrl?: string;
  license?: string;
}

export interface CapabilityDiscoverResponse {
  items: CapabilityDiscoverItem[];
  total: number;
  offset: number;
  limit: number;
  catalogUrl: string;
  truncated?: boolean;
  diagnostics?: string[];
}

export interface CapabilityDiscoverDetailsItem extends CapabilityDiscoverItem {
  skills?: string[];
  extensions?: string[];
  prompts?: string[];
  themes?: string[];
  installScripts?: Array<{ name: "preinstall" | "install" | "postinstall"; command: string }>;
  dependencyCount?: number;
}

export interface CapabilityDiscoverDetailsResponse {
  item: CapabilityDiscoverDetailsItem;
}

export interface ConnectedFolderCheckpoint {
  checkpointId: string;
  createdAt: string;
  label?: string;
  reason: string;
  fileCount: number;
}

export interface FileVersionEntry {
  path: string;
  hashSha256: string;
  sizeBytes: number;
  modifiedAt: string;
  capturedAt: string;
  checkpointId: string;
  checkpointLabel?: string;
  source?: "checkpoint" | "edit";
}
export interface FileVersionRestoreOutcome {
  restored: boolean;
  path: string;
  hashSha256: string;
  previousHashSha256: string | null;
  safetyCheckpointId: string;
}

export interface LocalEventStream {
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  lastEventId?: string;
  close: () => void;
}

export type ConnectedFolderFileEvent =
  | { type: "ready"; recursive: boolean }
  | { type: "file_event"; eventType: string; path: string | null }
  | { type: "error"; message: string };

export interface ExtensionUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  initialValue?: string;
  secret?: boolean;
}

export interface ChatStreamEvent {
  type: "status" | "turn_state" | "turn_snapshot" | "assistant_delta" | "assistant_message" | "assistant_thinking" | "tool" | "resources_changed" | "error" | "done" | "extension_ui_request" | "extension_ui_snapshot" | "restricted_app_proposal" | "restricted_app_proposal_settled" | "editor" | "queued_message" | "runtime" | "context_compacted";
  conversationId: string;
  runtime?: ConversationRuntime;
  chatMessage?: ChatMessage;
  running?: boolean;
  turnId?: string | null;
  message?: string;
  text?: string;
  toolName?: string;
  /** Readable name for a tool whose registered name is not, such as an app's. */
  toolTitle?: string;
  toolCallId?: string;
  phase?: AgentActivityPhase;
  thinkingPhase?: "start" | "delta" | "end";
  detail?: string;
  workTrailId?: string;
  order?: number;
  startedAt?: number;
  durationMs?: number;
  edit?: import("../../src/shared/chat-presentation").ChatToolEdit;
  assistantPresentation?: import("../../src/shared/chat-presentation").AssistantPresentation;
  presentation?: import("../../src/shared/chat-presentation").ChatLiveTurnPresentation;
  request?: ExtensionUiRequest;
  requests?: ExtensionUiRequest[];
  proposal?: RestrictedAppProposal;
  editorMode?: "replace" | "append";
  /** The Chat's queued message, held by the app for every window (2026-10-27). */
  queued?: { content: string; updatedAt: string; held?: boolean } | null;
  /** The app's number for this queue change; a higher one is newer. */
  revision?: number;
  /** Files that went out with a sent queued message. */
  sentContextPaths?: string[];
}

export interface BootstrapResponse { connectedFolders: ConnectedFolderSummary[]; agent: AgentStatus; appearance?: ConnectedFolderAppearanceState }
export interface DesktopUpdateStatus {
  supported: boolean;
  phase: "unsupported" | "idle" | "checking" | "available" | "not_available" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  checkedAt: string | null;
  message: string;
  error: string | null;
}
export interface ShortcutRow { keys: string[]; action: string }
export interface ShortcutGroup { title: string; rows: ShortcutRow[] }
