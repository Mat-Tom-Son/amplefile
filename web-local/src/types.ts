import type { AccentIdentity, ConnectedFolderAppearanceState } from "../../src/shared/connected-folder-appearance";
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
  type: "status" | "turn_state" | "turn_snapshot" | "assistant_delta" | "assistant_message" | "assistant_thinking" | "tool" | "resources_changed" | "error" | "done" | "extension_ui_request" | "extension_ui_snapshot" | "editor" | "queued_message" | "runtime" | "context_compacted";
  conversationId: string;
  runtime?: ConversationRuntime;
  chatMessage?: ChatMessage;
  running?: boolean;
  turnId?: string | null;
  message?: string;
  text?: string;
  toolName?: string;
  /** Readable name for a tool whose registered name is not. */
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
