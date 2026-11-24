import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ModelCatalogList, modelCatalogKey } from "./ModelCatalogList";
import { ImageModelSection, type ImageModelSettings } from "./ImageModelSection";
import { ProviderAccountDetails } from "./ProviderAccountDetails";
import { ConnectAi, featuredProviders } from "../onboarding/ConnectAi";
import { ProviderSignInWaiting } from "../onboarding/ProviderSignInWaiting";
import { RefreshCw } from "../chrome/icons";
import {
  Add16Regular,
  CheckmarkCircle16Filled,
  ChevronDown16Regular,
  ChevronLeft16Regular,
  ChevronUp16Regular,
  Eye20Regular,
  EyeOff20Regular,
  Folder20Filled,
  Folder20Regular,
  Sparkle20Filled,
  Sparkle20Regular,
} from "@fluentui/react-icons";
import { api, errorText } from "../../lib/api";
import { subscribeControlEvents } from "../../lib/control-events";
import { resolveModelSelection } from "../../lib/model-selection";
import type { AgentModel, AgentModelCatalog, AgentProvider, AgentStatus, ConnectedFolderSummary } from "../../types";
import { AZURE_OPENAI_PROVIDER, foundryProvider, normalizeFoundryConnection, parseAzureDeploymentNames, type FoundryConnection } from "../../../../src/shared/foundry";

const emptyAzureConnection: FoundryConnection = { baseUrl: "", deployments: [] };

export type ModelScope = "connected-folder" | "agent";

type AiModelsProps = {
  connectedFolder: ConnectedFolderSummary | null;
  status: AgentStatus;
  fixtureMode?: boolean;
  embedded?: boolean;
  active?: boolean;
  initialScope?: ModelScope;
  focusModelOnOpen?: boolean;
  focusInstructionsOnOpen?: boolean;
  onConfigured: (status: AgentStatus) => void;
  onModelChanged?: (scope: ModelScope, status: AgentStatus) => void;
};

type AiModelsMutation = { done: Promise<void>; release: () => void };
// Accepted writes outlive a Settings window. A reopened form must wait for
// them too; this holds no settings or credentials, only completion ownership.
let aiModelsMutation: AiModelsMutation | null = null;
const mutationListeners = new Set<() => void>();
function subscribeMutation(listener: () => void) { mutationListeners.add(listener); return () => { mutationListeners.delete(listener); }; }
function beginAiModelsMutation(): (() => void) | null {
  if (aiModelsMutation) return null;
  let resolve!: () => void;
  const operation = { done: new Promise<void>((done) => { resolve = done; }), release: () => {} };
  operation.release = () => {
    if (aiModelsMutation !== operation) return;
    aiModelsMutation = null;
    resolve();
    for (const listener of mutationListeners) listener();
  };
  aiModelsMutation = operation;
  for (const listener of mutationListeners) listener();
  return operation.release;
}

type AzureConnectionDraft = { baseUrl: string; deployments: string; modelIds?: Record<string, string> };
type FoundrySettings = { foundry?: Record<string, FoundryConnection>; foundryModels?: Record<string, Array<{ id: string; name: string }>>; foundryErrors?: Record<string, string> };
export type AiModelsDraft = { model?: { provider: string; model: string }; connectionProvider?: string; instructions?: string; azure?: AzureConnectionDraft; foundry?: Record<string, AzureConnectionDraft> };

export function AiModelsPane(props: AiModelsProps & {
  /** Unsaved edits per scope; a host that outlives this pane passes one so closing it keeps them. */
  drafts?: Map<string, AiModelsDraft>;
}) {
  const credentialsNeedReentry = useCredentialsNeedReentry();
  const { connectedFolder, embedded = false, initialScope, active = true, focusModelOnOpen = false, focusInstructionsOnOpen = false } = props;
  const identity = JSON.stringify([connectedFolder?.id ?? null, initialScope ?? null]);
  const defaultScope = initialScope === "agent" || !connectedFolder ? "agent" : "connected-folder";
  const [selection, setSelection] = useState<{ identity: string; scope: ModelScope }>({ identity, scope: defaultScope });
  // Resolve before effects so removing the last Connected Folder cannot issue an invalid
  // scope=connected-folder request while waiting for state to catch up.
  const scope = selection.identity === identity ? selection.scope : defaultScope;
  useEffect(() => { setSelection({ identity, scope: defaultScope }); }, [identity]);
  const currentConnectedFolderTarget = useRef<string | null>(null);
  currentConnectedFolderTarget.current = connectedFolder ? `connected-folder:${connectedFolder.id}` : null;
  const ownDrafts = useRef(new Map<string, AiModelsDraft>());
  const drafts = props.drafts ?? ownDrafts.current;
  for (const key of drafts.keys()) {
    if (key !== "agent" && key !== currentConnectedFolderTarget.current) drafts.delete(key);
  }
  const mutationBusy = useSyncExternalStore(subscribeMutation, () => aiModelsMutation !== null, () => false);
  const initialIdentity = useRef(identity);
  const focusRequest = useRef({ pending: (focusModelOnOpen || focusInstructionsOnOpen) && active, origin: null as Element | null });
  if (!active || identity !== initialIdentity.current) focusRequest.current.pending = false;
  useEffect(() => {
    let disposed = false;
    const yieldFocus = () => { focusRequest.current.pending = false; };
    // Parent modal effects establish the opening focus after child effects.
    // Capture that owned entry before the next user-input event can arrive.
    queueMicrotask(() => {
      if (disposed) return;
      focusRequest.current.origin = document.activeElement;
      document.addEventListener("focusin", yieldFocus);
      document.addEventListener("pointerdown", yieldFocus);
    });
    return () => { disposed = true; document.removeEventListener("focusin", yieldFocus); document.removeEventListener("pointerdown", yieldFocus); };
  }, []);

  function focusModelWhenReady(node: HTMLElement | null) {
    const request = focusRequest.current;
    if (!node || ("disabled" in node && node.disabled) || !request.pending || !active) return;
    request.pending = false;
    if (document.activeElement === request.origin) node.focus();
  }
  function changeScope(next: ModelScope) {
    focusRequest.current.pending = false;
    setSelection({ identity, scope: next });
  }
  function editDraftFor(draftTarget: string, edit: (draft: AiModelsDraft) => AiModelsDraft) {
    if (draftTarget !== "agent" && draftTarget !== currentConnectedFolderTarget.current) return;
    drafts.set(draftTarget, edit(drafts.get(draftTarget) ?? {}));
  }
  const target = scope === "connected-folder" ? `connected-folder:${connectedFolder!.id}` : "agent";
  // What each scope last showed. Switching scopes mounts from here at once and
  // refreshes quietly, instead of clearing the form behind a spinner; the
  // other scope is read ahead as soon as the visible one has loaded.
  const loaded = useRef(new Map<string, AiModelsSettingsResponse>());
  const [prefetchTick, setPrefetchTick] = useState(0);
  useEffect(() => {
    if (!connectedFolder || props.fixtureMode || prefetchTick === 0) return;
    const other: ModelScope = scope === "connected-folder" ? "agent" : "connected-folder";
    const otherTarget = other === "connected-folder" ? `connected-folder:${connectedFolder.id}` : "agent";
    if (loaded.current.has(otherTarget)) return;
    const controller = new AbortController();
    void (async () => {
      await (aiModelsMutation?.done ?? Promise.resolve());
      if (controller.signal.aborted) return;
      const result = await api<AiModelsSettingsResponse>(`/api/agent/models?${modelScopeParams(other, connectedFolder)}`, { signal: controller.signal });
      if (!controller.signal.aborted && !loaded.current.has(otherTarget)) loaded.current.set(otherTarget, result);
    })().catch(() => { /* the switch loads normally */ });
    return () => controller.abort();
  }, [prefetchTick, scope, connectedFolder?.id, props.fixtureMode]);

  return (
    <div className={embedded ? "assistant-settings-panel professional-setup" : "connected-folder-pane-content ai-models-pane professional-surface professional-setup"}>
      {credentialsNeedReentry ? <p className="ai-models-credentials-notice" role="status">
        Saved provider credentials could not be read. Connect your provider again.
      </p> : null}
      {connectedFolder ? <fieldset className="ai-models-scope-control">
        <legend className="sr-only">Model Scope</legend>
        <label className={scope === "connected-folder" ? "active" : ""}>
          <input type="radio" name="ai-model-scope" value="connected-folder" checked={scope === "connected-folder"} onChange={() => changeScope("connected-folder")} />
          <span className="ai-models-scope-icon" aria-hidden="true">
            {scope === "connected-folder" ? <Folder20Filled /> : <Folder20Regular />}
          </span>
          <span className="ai-models-scope-copy">
            <strong>This Worker</strong>
            <small title={connectedFolder.name}>{connectedFolder.name}</small>
          </span>
          <span className="ai-models-scope-check" aria-hidden="true">
            {scope === "connected-folder" ? <CheckmarkCircle16Filled /> : null}
          </span>
        </label>
        <label className={scope === "agent" ? "active" : ""}>
          <input type="radio" name="ai-model-scope" value="agent" checked={scope === "agent"} onChange={() => changeScope("agent")} />
          <span className="ai-models-scope-icon" aria-hidden="true">
            {scope === "agent" ? <Sparkle20Filled /> : <Sparkle20Regular />}
          </span>
          <span className="ai-models-scope-copy">
            <strong>AmpleFile Agent</strong>
            <small>All Connected Folders</small>
          </span>
          <span className="ai-models-scope-check" aria-hidden="true">
            {scope === "agent" ? <CheckmarkCircle16Filled /> : null}
          </span>
        </label>
      </fieldset> : <div className="ai-models-singleton-scope"><Sparkle20Filled aria-hidden="true" /><span>AmpleFile Agent</span></div>}
      <AiModelsScopeSettings
        {...props}
        key={JSON.stringify([scope, scope === "connected-folder" ? connectedFolder?.id : null])}
        scope={scope}
        mutationBusy={mutationBusy}
        beginMutation={beginAiModelsMutation}
        waitForMutation={() => aiModelsMutation?.done ?? Promise.resolve()}
        isMutating={() => aiModelsMutation !== null}
        readDraft={() => drafts.get(target) ?? {}}
        editDraft={(edit) => editDraftFor(target, edit)}
        focusModelWhenReady={focusModelWhenReady}
        initialResult={loaded.current.get(target)}
        onSnapshot={(result) => loaded.current.set(target, result)}
        onLoaded={() => setPrefetchTick((current) => current + 1)}
      />
    </div>
  );
}

function AiModelsScopeSettings({ connectedFolder, status, scope, fixtureMode = false, active = true, onConfigured, onModelChanged, mutationBusy, beginMutation, waitForMutation, isMutating, readDraft, editDraft, focusModelWhenReady, focusInstructionsOnOpen, initialResult, onSnapshot, onLoaded }: AiModelsProps & {
  scope: ModelScope;
  mutationBusy: boolean;
  beginMutation: () => (() => void) | null;
  waitForMutation: () => Promise<void>;
  isMutating: () => boolean;
  readDraft: () => AiModelsDraft;
  editDraft: (edit: (draft: AiModelsDraft) => AiModelsDraft) => void;
  focusModelWhenReady: (node: HTMLElement | null) => void;
  /** The last saved settings this scope showed, applied at once while a fresh read runs quietly. */
  initialResult?: AiModelsSettingsResponse;
  /** The saved settings this scope currently shows, kept for its next mount. */
  onSnapshot?: (result: AiModelsSettingsResponse) => void;
  /** Called once this scope's first read has finished. */
  onLoaded?: () => void;
}) {
  const [scopeStatus, setScopeStatus] = useState(status);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [providerCatalog, setProviderCatalog] = useState<AgentProvider[]>([]);
  const [catalogs, setCatalogs] = useState<AgentModelCatalog[]>([]);
  const [provider, setProvider] = useState("");
  const [addingProvider, setAddingProvider] = useState(false);
  const [providerQuery, setProviderQuery] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const apiKeyField = useRef<HTMLInputElement>(null);
  const [azure, setAzure] = useState<AzureConnectionDraft>(() => azureConnectionDraft(emptyAzureConnection));
  const [savedFoundry, setSavedFoundry] = useState<Record<string, FoundryConnection>>({});
  const [foundryModels, setFoundryModels] = useState<NonNullable<FoundrySettings["foundryModels"]>>({});
  const [foundryErrors, setFoundryErrors] = useState<Record<string, string>>({});
  const savedAzure = savedFoundry[provider] ?? emptyAzureConnection;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const initialResultRef = useRef(initialResult);
  const instructionsField = useRef<HTMLTextAreaElement>(null);
  const [instructions, setInstructions] = useState("");
  const [savedInstructions, setSavedInstructions] = useState("");
  // Settings → AI Models → Image model: machine-wide, so the same in either scope.
  const [imageModels, setImageModels] = useState<ImageModelSettings | undefined>(undefined);
  const [loading, setLoading] = useState(!initialResult);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [externalChange, setExternalChange] = useState(false);
  const [modelFeedback, setModelFeedback] = useState<AiModelsFeedback | null>(null);
  const [connectionFeedback, setConnectionFeedback] = useState<AiModelsFeedback | null>(null);
  const [instructionsFeedback, setInstructionsFeedback] = useState<AiModelsFeedback | null>(null);
  const [saving, setSaving] = useState<"model" | "connection" | "remove" | null>(null);
  /** Whose browser sign-in is under way here, and whether its Cancel was chosen. */
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const signInCancelled = useRef(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(false);
  const providerRevision = useRef(0);
  const refresh = useRef<AbortController | null>(null);
  const localRevision = useRef(0);
  const modelSelect = useRef<HTMLElement>(null);
  const currentForm = useRef({ dirty: false, loading: true, snapshot: "" });

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; refresh.current?.abort(); };
  }, []);
  // What this scope last showed is on screen before the first paint.
  useLayoutEffect(() => {
    const cached = initialResultRef.current;
    if (cached) applyLoadedSettings(cached, true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const revision = localRevision.current;
    const cached = loadAttempt === 0 ? initialResultRef.current : undefined;
    if (!cached) setLoading(true);
    setLoadError(null);
    async function load() {
      await waitForMutation();
      if (controller.signal.aborted || revision !== localRevision.current || isMutating()) return;
      const result = fixtureMode ? {
        models: [
          ...[
            ["deepseek/deepseek-v4.1-flash", "DeepSeek: DeepSeek V4.1 Flash — Fast reasoning and general tasks"],
            ["deepseek/deepseek-v4.1", "DeepSeek: DeepSeek V4.1"],
            ["anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5"],
            ["anthropic/claude-opus-4.1", "Anthropic: Claude Opus 4.1"],
            ["openai/gpt-5", "OpenAI: GPT-5"],
            ["openai/gpt-5-mini", "OpenAI: GPT-5 Mini"],
            ["google/gemini-2.5-pro", "Google: Gemini 2.5 Pro"],
            ["google/gemini-2.5-flash", "Google: Gemini 2.5 Flash"],
            ["meta-llama/llama-4-maverick", "Meta: Llama 4 Maverick"],
            ["qwen/qwen3-coder", "Qwen: Qwen3 Coder"],
            ["mistralai/mistral-medium-3.1", "Mistral: Mistral Medium 3.1"],
          ].map(([id, name]) => ({ provider: "openrouter", providerName: "OpenRouter", id, name, authConfigured: true, authSource: "stored" as const, authType: "api_key" as const, oauthSupported: false })),
          { provider: "anthropic", providerName: "Anthropic", id: "claude-sonnet-4", name: "Claude Sonnet", authConfigured: false, oauthSupported: false },
          { provider: "openai-chatgpt", providerName: "ChatGPT", id: "gpt-5", name: "GPT-5", authConfigured: true, authSource: "stored" as const, authType: "oauth" as const, oauthSupported: true },
        ],
        catalogs: [{ provider: "openrouter", refreshable: true, source: "live" as const, refreshedAt: new Date().toISOString(), modelCount: 11 }],
        status: { ...status, configured: true, provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
        instructions: scope === "connected-folder" ? "Keep answers concise and test changes in this Connected Folder." : null,
      } : await api<AiModelsSettingsResponse>(`/api/agent/models?${modelScopeParams(scope, connectedFolder)}`, { signal: controller.signal });
      if (controller.signal.aborted || revision !== localRevision.current || isMutating()) return;
      if (cached) {
        if (settingsSnapshot(result) === currentForm.current.snapshot) return;
        if (currentForm.current.dirty) { setExternalChange(true); return; }
      }
      applyLoadedSettings(result, true);
    }
    void load().catch((caught) => {
      if (!controller.signal.aborted && revision === localRevision.current && !isMutating()) setLoadError(errorText(caught));
    }).finally(() => { if (!controller.signal.aborted) { setLoading(false); onLoadedRef.current?.(); } });
    return () => controller.abort();
  }, [fixtureMode, loadAttempt]);

  const connectedProviders = providerCatalog.filter((item) => item.configured && !foundryErrors[item.id]);
  const availableProviders = providerCatalog.filter((item) => !(item.configured && !foundryErrors[item.id]));
  const selectedProvider = providerCatalog.find((item) => item.id === provider);
  const providerModels = models.filter((item) => item.provider === provider);
  const connectedModels = models.filter((item) => item.authConfigured);
  const providerAuth = selectedProvider ? { ...selectedProvider, authConfigured: selectedProvider.configured } : providerModels.find((item) => item.authConfigured);
  const authConfigured = Boolean(providerAuth?.authConfigured);
  const removableAuth = providerAuth?.authSource === "stored";
  const apiKeySupported = Boolean(selectedProvider?.apiKey);
  const isOAuthAuth = providerAuth?.authType === "oauth";
  const replaceableApiKey = apiKeySupported && removableAuth;
  const oauthSupported = Boolean(selectedProvider?.oauthAvailable);
  const accountOnly = !apiKeySupported && Boolean(selectedProvider?.oauth);
  const foundrySpec = foundryProvider(provider);
  const isAzure = Boolean(foundrySpec);
  const azureChanged = isAzure && JSON.stringify(azure) !== JSON.stringify(azureConnectionDraft(savedAzure));
  const unavailableDeployments = savedAzure.deployments.filter((id) => savedAzure.modelIds && Object.hasOwn(savedAzure.modelIds, id)
    && !models.some((item) => item.provider === provider && item.id === id));
  const catalog = catalogs.find((item) => item.provider === provider);
  const providerName = selectedProvider ? providerDisplayName(selectedProvider) : provider;
  const instructionsChanged = instructions.trim() !== savedInstructions;
  const operationBusy = mutationBusy || refreshing;
  const providerIsConnected = Boolean(selectedProvider && selectedProvider.configured && !foundryErrors[selectedProvider.id]);
  currentForm.current = {
    dirty: instructionsChanged || editingApiKey || Boolean(apiKey) || azureChanged,
    loading: loading || Boolean(loadError),
    snapshot: settingsSnapshot({ models, providers: providerCatalog, catalogs, status: scopeStatus, instructions: savedInstructions, azure: savedFoundry.azure, foundry: savedFoundry, foundryModels, foundryErrors }),
  };

  useEffect(() => {
    if (loading || loadError) return;
    onSnapshotRef.current?.({ models, providers: providerCatalog, catalogs, status: scopeStatus, instructions: savedInstructions, azure: savedFoundry.azure, foundry: savedFoundry, foundryModels, foundryErrors });
  }, [loading, loadError, models, providerCatalog, catalogs, scopeStatus, savedInstructions, savedFoundry, foundryModels, foundryErrors]);

  useEffect(() => {
    if (editingApiKey && active) apiKeyField.current?.focus();
  }, [editingApiKey, active]);

  function applyLoadedSettings(result: AiModelsSettingsResponse, restoreDraft = false) {
    const draft = restoreDraft ? readDraft() : {};
    if (result.imageModels) setImageModels(result.imageModels);
    setModels(result.models);
    const connections = connectionProviders(result);
    setProviderCatalog(connections);
    setCatalogs(result.catalogs);
    setScopeStatus(result.status);
    setInstructions(draft.instructions ?? result.instructions ?? "");
    setSavedInstructions(result.instructions ?? "");
    const nextFoundry = loadedFoundry(result);
    setSavedFoundry(nextFoundry);
    const nextFoundryErrors = result.foundryErrors ?? {};
    setFoundryModels(result.foundryModels ?? {});
    setFoundryErrors(nextFoundryErrors);
    const first = result.models.find((item) => item.provider === result.status.provider && item.id === result.status.model)
      ?? result.models.find((item) => item.authConfigured);
    const nextModelProvider = first?.provider ?? "";
    const nextConnection = draft.connectionProvider ?? provider;
    const erroredConnection = connections.find((item) => Boolean(nextFoundryErrors[item.id]))?.id;
    const selectedConnection = connections.some((item) => item.id === nextConnection) ? nextConnection
      : erroredConnection
        ?? connections.find((item) => item.id === result.status.provider && item.configured)?.id
        ?? connections.find((item) => item.configured)?.id
        ?? featuredProviders.map((item) => connections.find((connection) => connection.id === item.provider)).find(Boolean)?.id
        ?? connections[0]?.id ?? "";
    const selectedEntry = connections.find((item) => item.id === selectedConnection);
    const selectedIsAvailable = Boolean(selectedEntry && !(selectedEntry.configured && !nextFoundryErrors[selectedEntry.id]));
    setProvider(selectedConnection);
    setAddingProvider(Boolean(selectedConnection && selectedIsAvailable));
    setAzure(draft.foundry?.[selectedConnection] ?? (selectedConnection === AZURE_OPENAI_PROVIDER ? draft.azure : undefined)
      ?? azureConnectionDraft(nextFoundry[selectedConnection] ?? emptyAzureConnection));
    setModelProvider(nextModelProvider);
    setModel(resolveModelSelection(result.models, nextModelProvider, result.status.model ?? ""));
    editDraft((current) => ({
      ...current,
      model: undefined,
      ...(current.instructions?.trim() === (result.instructions ?? "") ? { instructions: undefined } : {}),
    }));
    setApiKey("");
    setEditingApiKey(false);
    setShowApiKey(false);
    setExternalChange(false);
    setModelFeedback(null);
    setConnectionFeedback(null);
    setInstructionsFeedback(null);
  }

  useEffect(() => {
    if (fixtureMode) return;
    let disposed = false;
    let controller: AbortController | null = null;
    const unsubscribe = subscribeControlEvents((hint) => {
      if ((hint !== "models" && hint !== "reset") || isMutating()) return;
      if (currentForm.current.loading) { setLoadAttempt((current) => current + 1); return; }
      controller?.abort();
      const read = new AbortController();
      controller = read;
      const revision = localRevision.current;
      void api<AiModelsSettingsResponse>(`/api/agent/models?${modelScopeParams(scope, connectedFolder)}`, { signal: read.signal })
        .then((result) => {
          if (disposed || read.signal.aborted || revision !== localRevision.current || isMutating()) return;
          if (settingsSnapshot(result) === currentForm.current.snapshot) return;
          if (currentForm.current.dirty || refresh.current) setExternalChange(true);
          else {
            localRevision.current += 1;
            applyLoadedSettings(result);
          }
        }).catch(() => {
          if (!disposed && !read.signal.aborted && revision === localRevision.current) setExternalChange(true);
        });
    });
    return () => { disposed = true; controller?.abort(); unsubscribe(); };
  }, [fixtureMode]);

  useEffect(() => {
    if (!loading && active) focusModelWhenReady(focusInstructionsOnOpen ? instructionsField.current : modelSelect.current);
  }, [loading, active]);

  function reportConfigured(next: AgentStatus) {
    setScopeStatus(next);
    if (scope === "connected-folder") onConfigured(next);
    onModelChanged?.(scope, next);
  }

  function selectProvider(next: string, options: { toggle?: boolean; openAdd?: boolean } = {}) {
    if (isMutating()) return;
    providerRevision.current += 1;
    refresh.current?.abort();
    const targetEntry = providerCatalog.find((item) => item.id === next);
    const targetConnected = Boolean(targetEntry && targetEntry.configured && !foundryErrors[targetEntry.id]);
    if (options.toggle && provider === next && !addingProvider) {
      setProvider("");
      editDraft((draft) => ({ ...draft, connectionProvider: undefined }));
    } else {
      setProvider(next);
      setAddingProvider(options.openAdd ?? !targetConnected);
      setAzure(readDraft().foundry?.[next] ?? azureConnectionDraft(savedFoundry[next] ?? emptyAzureConnection));
      editDraft((draft) => ({ ...draft, connectionProvider: next }));
    }
    setApiKey("");
    setEditingApiKey(false);
    setShowApiKey(false);
    setConnectionFeedback(null);
  }

  function editFoundry(next: AzureConnectionDraft) {
    const canonical = canonicalFoundryDraft(next);
    setAzure(canonical);
    editDraft((draft) => ({ ...draft, azure: undefined, foundry: { ...draft.foundry, [provider]: canonical } }));
    setConnectionFeedback(null);
  }

  async function saveModelSelection(nextProvider: string, nextModel: string) {
    if (loading || !nextProvider || !nextModel) return;
    if (nextProvider === scopeStatus.provider && nextModel === scopeStatus.model) return;
    const chosen = models.find((item) => item.provider === nextProvider && item.id === nextModel);
    if (!chosen?.authConfigured) return;
    const release = beginMutation();
    if (!release) return;
    localRevision.current += 1;
    const previousProvider = modelProvider;
    const previousModel = model;
    setModelProvider(nextProvider);
    setModel(nextModel);
    setSaving("model");
    setModelFeedback(null);
    try {
      const result = fixtureMode
        ? { status: { ...scopeStatus, configured: true, provider: nextProvider, model: nextModel } }
        : await api<{ status: AgentStatus }>("/api/agent/configure", {
          method: "POST",
          body: { ...modelScopeBody(scope, connectedFolder), provider: nextProvider, model: nextModel },
        });
      if (!live.current) return;
      reportConfigured(result.status);
      setModelFeedback({ text: "Saved" });
    } catch (caught) {
      if (live.current) {
        setModelProvider(previousProvider);
        setModel(previousModel);
        setModelFeedback({ error: true, text: errorText(caught) });
      }
    } finally {
      if (live.current) setSaving(null);
      release();
    }
  }

  async function configureConnection(kind: "key" | "oauth" | "setup") {
    if (loading || refresh.current || !provider
      || (kind === "key" && (isAzure ? !authConfigured && !apiKey.trim() : (authConfigured && !(replaceableApiKey && editingApiKey)) || !apiKey.trim()))) return;
    let submittedAzure: FoundryConnection | undefined;
    if (kind === "key" && isAzure) {
      try { submittedAzure = serializeAzureConnection(azure, provider); }
      catch (caught) { setConnectionFeedback({ error: true, text: errorText(caught) }); return; }
    }
    const release = beginMutation();
    if (!release) return;
    localRevision.current += 1;
    setSaving("connection");
    setConnectionFeedback(null);
    signInCancelled.current = false;
    if (kind === "oauth" && !fixtureMode) setSigningIn(selectedProvider?.name ?? provider);
    const submittedApiKey = kind === "key" ? apiKey.trim() : "";
    try {
      const result = fixtureMode ? { status: scopeStatus, foundry: submittedAzure ? { ...savedFoundry, [provider]: submittedAzure } : undefined, models: undefined }
        : await api<FoundrySettings & { status: AgentStatus; azure?: FoundryConnection; models?: AgentModel[]; providers?: AgentProvider[] }>(kind === "setup" ? "/api/agent/login" : kind === "oauth" ? "/api/agent/oauth" : "/api/agent/configure", {
          method: "POST",
          body: { ...modelScopeBody(scope, connectedFolder), provider, ...(kind === "setup" ? { method: "api_key" } : {}), ...(submittedApiKey ? { apiKey: submittedApiKey } : {}), ...(submittedAzure ? { [provider === AZURE_OPENAI_PROVIDER ? "azure" : "foundry"]: submittedAzure } : {}) },
        });
      editDraft((draft) => ({
        ...draft,
        ...(submittedAzure ? { azure: undefined, foundry: Object.fromEntries(Object.entries(draft.foundry ?? {}).filter(([id]) => id !== provider)) } : {}),
      }));
      if (!live.current) return;
      if (result.foundry || ("azure" in result && result.azure)) {
        const settings = loadedFoundry(result);
        setSavedFoundry((current) => ({ ...current, ...settings }));
        if (settings[provider]) setAzure(azureConnectionDraft(settings[provider]!));
      }
      if ("foundryModels" in result && result.foundryModels) setFoundryModels(result.foundryModels);
      const nextErrors = "foundryErrors" in result && result.foundryErrors ? result.foundryErrors : foundryErrors;
      if ("foundryErrors" in result && result.foundryErrors) setFoundryErrors(result.foundryErrors);
      if (result.models) setModels(result.models);
      else setModels((current) => current.map((item) => item.provider === provider ? {
        ...item, authConfigured: true, authSource: "stored", authType: kind === "oauth" ? "oauth" : "api_key",
      } : item));
      if ("providers" in result && result.providers) setProviderCatalog(result.providers);
      else setProviderCatalog((current) => current.map((item) => item.id === provider ? {
        ...item, configured: true, authSource: "stored", authType: kind === "oauth" ? "oauth" : "api_key",
      } : item));
      if (!nextErrors[provider]) setAddingProvider(false);
      setApiKey("");
      setEditingApiKey(false);
      setShowApiKey(false);
      reportConfigured(result.status);
      setConnectionFeedback({ text: submittedAzure ? "Settings saved" : "Connected" });
    } catch (caught) { if (live.current && !(kind === "oauth" && signInCancelled.current)) setConnectionFeedback({ error: true, text: errorText(caught) }); }
    finally { if (live.current) { setSaving(null); setSigningIn(null); } release(); }
  }

  async function removeCredential() {
    if (!removableAuth || refresh.current) return;
    const release = beginMutation();
    if (!release) return;
    localRevision.current += 1;
    setSaving("remove");
    setConnectionFeedback(null);
    try {
      const result = fixtureMode ? {
        models: models.map((item) => item.provider === provider ? { ...item, authConfigured: false } : item),
        status: { ...scopeStatus, configured: false },
        foundry: isAzure ? { ...savedFoundry, [provider]: emptyAzureConnection } : undefined,
      } : await api<FoundrySettings & { models: AgentModel[]; status: AgentStatus; azure?: FoundryConnection; providers?: AgentProvider[] }>("/api/agent/auth", {
        method: "DELETE", body: { ...modelScopeBody(scope, connectedFolder), provider },
      });
      if (!live.current) return;
      setModels(result.models);
      const nextErrors = "foundryErrors" in result && result.foundryErrors ? result.foundryErrors : foundryErrors;
      if ("foundryErrors" in result && result.foundryErrors) setFoundryErrors(result.foundryErrors);
      const nextProviders = connectionProviders(result);
      setProviderCatalog(nextProviders);
      if (result.foundry || ("azure" in result && result.azure)) {
        const settings = loadedFoundry(result);
        setSavedFoundry((current) => ({ ...current, ...settings }));
        if (!azureChanged && settings[provider]) {
          setAzure(azureConnectionDraft(settings[provider]!));
          editDraft((draft) => ({ ...draft, azure: undefined, foundry: Object.fromEntries(Object.entries(draft.foundry ?? {}).filter(([id]) => id !== provider)) }));
        }
      }
      const stillConnected = nextProviders.some((item) => item.id === provider && item.configured && !nextErrors[item.id]);
      setAddingProvider(!stillConnected);
      setApiKey("");
      setEditingApiKey(false);
      setShowApiKey(false);
      reportConfigured(result.status);
      setModelFeedback(null);
      setConnectionFeedback({ text: isOAuthAuth ? "Disconnected" : "API key removed" });
    } catch (caught) { if (live.current) setConnectionFeedback({ error: true, text: errorText(caught) }); }
    finally { if (live.current) setSaving(null); release(); }
  }

  async function refreshModels() {
    if (isMutating() || refresh.current || !catalog?.refreshable || !authConfigured) return;
    const controller = new AbortController();
    localRevision.current += 1;
    const revision = providerRevision.current;
    refresh.current = controller;
    setRefreshing(true);
    setConnectionFeedback(null);
    try {
      const result = fixtureMode ? { models, catalogs, refresh: { modelCount: models.length } }
        : await api<{ models: AgentModel[]; catalogs: AgentModelCatalog[]; refresh: { modelCount: number } }>("/api/agent/models/refresh", {
          method: "POST", body: { ...modelScopeBody(scope, connectedFolder), provider }, signal: controller.signal,
        });
      if (!live.current || controller.signal.aborted || revision !== providerRevision.current) return;
      setModels(result.models);
      setCatalogs(result.catalogs);
      setConnectionFeedback({ text: `${result.refresh.modelCount} models updated` });
    } catch (caught) {
      if (live.current && !controller.signal.aborted && revision === providerRevision.current) setConnectionFeedback({ error: true, text: errorText(caught) });
    } finally {
      if (refresh.current === controller) refresh.current = null;
      if (live.current) setRefreshing(false);
    }
  }

  async function saveInstructions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (scope !== "connected-folder" || !connectedFolder || !instructionsChanged || loading) return;
    const release = beginMutation();
    if (!release) return;
    localRevision.current += 1;
    const submitted = instructions;
    setSavingInstructions(true);
    setInstructionsFeedback(null);
    try {
      const result = fixtureMode ? { instructions: submitted.trim() }
        : await api<{ instructions: string }>("/api/agent/instructions", {
          method: "POST", body: { scope: "connected-folder", connectedFolderId: connectedFolder.id, instructions: submitted },
        });
      editDraft((draft) => ({ ...draft, instructions: draft.instructions?.trim() === result.instructions ? undefined : draft.instructions }));
      if (!live.current) return;
      setSavedInstructions(result.instructions);
      setInstructions((current) => current === submitted ? result.instructions : current);
      setInstructionsFeedback({ text: "Saved" });
    } catch (caught) { if (live.current) setInstructionsFeedback({ error: true, text: errorText(caught) }); }
    finally { if (live.current) setSavingInstructions(false); release(); }
  }

  function renderKeyForm(mode: "connect" | "replace" | "foundry") {
    return (
      <form id="ai-models-key-form" className={`ai-models-key-connection${mode === "foundry" ? " ai-models-azure-connection" : ""}`} onSubmit={(event) => { event.preventDefault(); void configureConnection("key"); }}>
        {mode === "foundry" ? <>
          {foundryErrors[provider] ? <p className="ai-models-row-note error" role="alert">{foundryErrors[provider]}</p> : null}
          <label className="professional-field"><span className="professional-field-label">Endpoint</span><input id="ai-models-azure-endpoint" type="url" value={azure.baseUrl} maxLength={2048} placeholder={foundrySpec?.api === "anthropic-messages" ? "https://your-resource.services.ai.azure.com/anthropic" : "https://your-resource.services.ai.azure.com/openai/v1"} spellCheck={false} autoComplete="off" disabled={mutationBusy} onChange={(event) => editFoundry({ ...azure, baseUrl: event.target.value })} /></label>
          <label className="professional-field"><span className="professional-field-label">Deployments</span><textarea id="ai-models-azure-deployments" value={azure.deployments} maxLength={25800} rows={2} placeholder="Comma or newline separated" spellCheck={false} autoComplete="off" disabled={mutationBusy} onChange={(event) => editFoundry({ ...azure, deployments: event.target.value })} /></label>
          {unavailableDeployments.length ? <p className="ai-models-row-note" role="status">Choose a base model for: {unavailableDeployments.join(", ")}.</p> : null}
          {parseAzureDeploymentNames(azure.deployments).length > 0 && foundryModels[provider]?.length ? <details className="ai-models-foundry-models" open={unavailableDeployments.length ? true : undefined}><summary>Deployment Model Details</summary>
            {parseAzureDeploymentNames(azure.deployments).map((id, index) => <label className="professional-field" key={id}><span className="professional-field-label">{id}</span>
              <select id={`ai-models-foundry-base-${index}`} disabled={mutationBusy} value={azure.modelIds?.[id] ?? ""} onChange={(event) => {
                const modelIds = Object.fromEntries(Object.entries(azure.modelIds ?? {}).filter(([name]) => name !== id));
                if (event.target.value) Object.defineProperty(modelIds, id, { value: event.target.value, enumerable: true });
                editFoundry({ ...azure, modelIds });
              }}><option value="">{foundryModels[provider]!.some((item) => item.id === id) ? "Automatic" : "Default Limits"}</option>{azure.modelIds?.[id] && !foundryModels[provider]!.some((item) => item.id === azure.modelIds?.[id]) ? <option value={azure.modelIds[id]}>{azure.modelIds[id]} (unavailable)</option> : null}{foundryModels[provider]!.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}</select>
            </label>)}
          </details> : null}
        </> : null}
        <label className="professional-field"><span className="professional-field-label">{mode === "foundry" && authConfigured ? "Replace API Key" : mode === "replace" ? "New API Key" : "API Key"}</span>
          <span className="ai-models-key-input"><input ref={apiKeyField} id="ai-models-api-key" type={showApiKey ? "text" : "password"} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setConnectionFeedback(null); }} placeholder={mode === "foundry" && authConfigured ? "Leave blank to keep current key" : `Paste ${providerName} API key`} autoComplete="off" spellCheck={false} disabled={mutationBusy} />
            <button className="ai-models-key-visibility" type="button" aria-label={showApiKey ? "Hide API Key" : "Show API Key"} aria-pressed={showApiKey} disabled={mutationBusy} onClick={() => setShowApiKey((current) => !current)}>{showApiKey ? <EyeOff20Regular aria-hidden="true" /> : <Eye20Regular aria-hidden="true" />}</button>
          </span>
        </label>
        <div className="ai-models-drawer-bar">
          <div className="ai-models-drawer-links">
            {mode === "foundry" && removableAuth ? <button className="ui-control danger ai-models-remove-credential" type="button" disabled={operationBusy} onClick={() => void removeCredential()}>{saving === "remove" ? "Removing…" : "Remove"}</button> : null}
            {mode === "connect" && oauthSupported ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => void configureConnection("oauth")}>{selectedProvider?.oauthLabel ?? "Sign In"}</button> : null}
            {mode === "connect" && selectedProvider?.guidedSetup ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => void configureConnection("setup")}>Guided Setup</button> : null}
          </div>
          <div className="ai-models-drawer-actions">
            {mode === "replace" ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => { setEditingApiKey(false); setApiKey(""); setShowApiKey(false); setConnectionFeedback(null); }}>Cancel</button> : null}
            <button className="ui-control ui-control--primary" type="submit" disabled={operationBusy || (mode === "foundry" ? !parseAzureDeploymentNames(azure.deployments).length || !azure.baseUrl.trim() || (!authConfigured && !apiKey.trim()) || (authConfigured && !azureChanged && !apiKey.trim()) : !apiKey.trim())}>{saving === "connection" ? "Saving…" : mode === "foundry" ? "Save Settings" : mode === "replace" ? "Save Key" : "Connect"}</button>
          </div>
        </div>
      </form>
    );
  }

  function renderConnectedDrawer(item: AgentProvider) {
    const showOpenAiAccount = authConfigured && isOAuthAuth && (item.id === "openai" || item.id === "openai-codex");
    const hasMoreOptions = (isOAuthAuth && apiKeySupported && !isAzure) || (!isOAuthAuth && oauthSupported) || Boolean(item.guidedSetup);

    return (
      <div className="ai-models-provider-drawer">
        {isAzure ? renderKeyForm("foundry") : showOpenAiAccount ? (
          <ProviderAccountDetails
            key={item.id}
            provider={item.id}
            scope={scope}
            connectedFolderId={connectedFolder?.id}
            revision={providerCatalog}
            active={active}
            fixtureMode={fixtureMode}
            busy={operationBusy}
            onReconnect={oauthSupported ? () => void configureConnection("oauth") : undefined}
            onSelectCodex={providerCatalog.some((entry) => entry.id === "openai-codex" && entry.oauth) ? () => selectProvider("openai-codex") : undefined}
            actions={<>
              {oauthSupported ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => void configureConnection("oauth")}>{saving === "connection" ? "Connecting…" : "Reconnect"}</button> : null}
              {removableAuth ? <button className="ui-control danger ai-models-remove-credential" type="button" disabled={operationBusy} onClick={() => void removeCredential()}>{saving === "remove" ? "Removing…" : "Disconnect"}</button> : null}
            </>}
          />
        ) : editingApiKey ? (
          renderKeyForm("replace")
        ) : (
          <div className="ai-models-drawer-bar">
            <span className="ai-models-quiet-note">{providerCredentialSummary(providerAuth)}</span>
            <div className="ai-models-drawer-actions">
              {catalog?.refreshable ? <button className="ui-control ai-models-refresh" type="button" disabled={operationBusy || !authConfigured} title={catalog.refreshedAt ? `Updated ${formatCatalogDate(catalog.refreshedAt)}` : `Refresh ${providerName} models`} onClick={() => void refreshModels()}><RefreshCw className={refreshing ? "spin" : undefined} />{refreshing ? "Refreshing…" : "Refresh"}</button> : null}
              {isOAuthAuth && oauthSupported ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => void configureConnection("oauth")}>{saving === "connection" ? "Connecting…" : "Reconnect"}</button> : null}
              {!isOAuthAuth && replaceableApiKey ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => { setEditingApiKey(true); setApiKey(""); setShowApiKey(false); setConnectionFeedback(null); }}>Change Key</button> : null}
              {removableAuth ? <button className="ui-control danger ai-models-remove-credential" type="button" disabled={operationBusy} onClick={() => void removeCredential()}>{saving === "remove" ? "Removing…" : isOAuthAuth ? "Disconnect" : "Remove"}</button> : null}
            </div>
          </div>
        )}
        {showOpenAiAccount && editingApiKey ? renderKeyForm("replace") : null}
        {hasMoreOptions && !editingApiKey && !isAzure ? (
          <details className="ai-models-more-options">
            <summary>More options</summary>
            <div className="ai-models-more-options-body">
              {isOAuthAuth && replaceableApiKey ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => { setEditingApiKey(true); setApiKey(""); setShowApiKey(false); setConnectionFeedback(null); }}>Use API Key</button> : null}
              {!isOAuthAuth && oauthSupported ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => void configureConnection("oauth")}>{item.oauthLabel ?? "Sign In"}</button> : null}
              {item.guidedSetup ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => void configureConnection("setup")}>Guided Setup</button> : null}
            </div>
          </details>
        ) : null}
        {signingIn ? <ProviderSignInWaiting providerName={signingIn} onCancelRequested={() => { signInCancelled.current = true; }} /> : null}
        {connectionFeedback ? <AiModelsOperationStatus feedback={connectionFeedback} /> : null}
      </div>
    );
  }

  function renderAvailableSetup() {
    if (!selectedProvider || providerIsConnected) {
      const needle = providerQuery.trim().toLowerCase();
      const filtered = availableProviders.filter((item) => !needle || providerDisplayName(item).toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle));
      return (
        <div className="ai-models-available-picker">
          {availableProviders.length > 6 ? (
            <input
              type="search"
              className="ai-models-provider-search"
              value={providerQuery}
              placeholder="Search providers…"
              aria-label="Search providers"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setProviderQuery(event.target.value)}
            />
          ) : null}
          <div className="ai-models-available-list">
            {filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                className="ai-models-available-row"
                disabled={mutationBusy}
                data-provider-id={item.id}
                onClick={() => selectProvider(item.id, { openAdd: true })}
              >
                <span className="ai-models-provider-name">{providerDisplayName(item)}</span>
                <span className="ai-models-available-method">{foundryErrors[item.id] ? "Needs Setup" : item.oauthAvailable ? "Sign In" : foundryProvider(item.id) ? "Configure" : item.apiKey ? "API Key" : "External"}</span>
              </button>
            ))}
            {!filtered.length ? <p className="ai-models-quiet-note">No matching providers.</p> : null}
          </div>
        </div>
      );
    }

    return (
      <div className="ai-models-provider-drawer ai-models-available-setup">
        <div className="ai-models-available-header">
          {availableProviders.length > 1 ? (
            <button type="button" className="ai-models-text-action ai-models-back-link" disabled={mutationBusy} onClick={() => { setProvider(""); setApiKey(""); setConnectionFeedback(null); }}>
              <ChevronLeft16Regular aria-hidden="true" />All Providers
            </button>
          ) : null}
          <strong>{providerName}</strong>
        </div>
        {isAzure ? renderKeyForm("foundry") : apiKeySupported ? renderKeyForm("connect") : (
          <div className="ai-models-drawer-bar">
            {accountOnly && !oauthSupported ? <span className="ai-models-quiet-note">Sign-in requires the desktop app.</span>
              : !apiKeySupported && !selectedProvider.oauth ? <span className="ai-models-quiet-note">Configured outside AmpleFile.</span>
              : <span className="ai-models-quiet-note">Not connected</span>}
            <div className="ai-models-drawer-actions">
              {oauthSupported ? <button className="ui-control ui-control--primary" type="button" disabled={operationBusy} onClick={() => void configureConnection("oauth")}>{saving === "connection" ? "Connecting…" : selectedProvider.oauthLabel ?? "Connect Account"}</button> : null}
              {selectedProvider.guidedSetup ? <button className="ui-control" type="button" disabled={operationBusy} onClick={() => void configureConnection("setup")}>Guided Setup</button> : null}
            </div>
          </div>
        )}
        {signingIn ? <ProviderSignInWaiting providerName={signingIn} onCancelRequested={() => { signInCancelled.current = true; }} /> : null}
        {connectionFeedback ? <AiModelsOperationStatus feedback={connectionFeedback} /> : null}
      </div>
    );
  }

  if (loading) return <div className="professional-loading-row" role="status"><RefreshCw className="spin" />Loading AI Models…</div>;
  if (loadError) return <div className="ai-models-settings-section"><AiModelsOperationStatus feedback={{ error: true, text: loadError }} /><button className="ui-control" type="button" onClick={() => { localRevision.current += 1; setLoadAttempt((current) => current + 1); }}>Try Again</button></div>;

  const showScopedCard = connectedModels.length > 0 || !providerCatalog.length || scope === "connected-folder";

  return <>
    {externalChange ? <div className="ai-models-external-change"><span>Saved settings changed.</span><button className="ui-control ai-models-refresh" type="button" disabled={operationBusy} onClick={() => { localRevision.current += 1; editDraft(() => ({})); setExternalChange(false); setLoading(true); setLoadAttempt((current) => current + 1); }}>Reload</button></div> : null}
    {!connectedModels.length && providerCatalog.length ? <section className="ai-models-settings-section ai-models-connect" aria-labelledby="ai-models-connect-heading">
      <div className="ai-models-section-heading"><h3 id="ai-models-connect-heading">Connect Your AI</h3></div>
      <ConnectAi providers={providerCatalog} fixtureMode={fixtureMode} onConnected={() => { localRevision.current += 1; setLoadAttempt((current) => current + 1); }} />
    </section> : null}
    {showScopedCard ? <section className="ai-models-settings-section ai-models-scope-card" aria-labelledby="ai-model-heading">
      <span className="sr-only" id="ai-model-heading">Model</span>
      {connectedModels.length || !providerCatalog.length ? (
        <div className="ai-models-row ai-models-model-row">
          <div className="ai-models-row-heading">
            <span className="ai-models-row-title" id="ai-model-label">Model</span>
            {saving === "model" ? <span className="ai-models-inline-status" role="status">Saving…</span>
              : modelFeedback ? <AiModelsOperationStatus feedback={modelFeedback} /> : null}
          </div>
          <div className="ai-models-model-picker">
            <ModelCatalogList id="ai-model" labelledBy="ai-model-label" models={connectedModels} value={modelCatalogKey({ provider: modelProvider, id: model })} groupByProvider disabled={mutationBusy || !connectedModels.length} onChange={(next) => {
              if (isMutating()) return;
              const selected = connectedModels.find((item) => modelCatalogKey(item) === next);
              if (!selected) return;
              void saveModelSelection(selected.provider, selected.id);
            }} controlRef={modelSelect} />
          </div>
        </div>
      ) : null}
      {scope === "connected-folder" ? (
        <div className="ai-models-instructions-block" aria-labelledby="worker-instructions-heading">
          <form onSubmit={(event) => void saveInstructions(event)}>
            <div className="ai-models-instructions-header">
              <h3 id="worker-instructions-heading">Worker Instructions</h3>
              <div className="ai-models-instructions-controls">
                <AiModelsOperationStatus feedback={instructionsFeedback?.error || !instructionsChanged ? instructionsFeedback : null} hint={instructionsChanged ? "Unsaved" : undefined} />
                <button className="ui-control ui-control--primary" type="submit" disabled={mutationBusy || !instructionsChanged}>{savingInstructions ? "Saving…" : "Save"}</button>
              </div>
            </div>
            <label className="professional-field worker-instructions-field">
              <span className="sr-only">Worker Instructions</span>
              <textarea
                ref={instructionsField}
                value={instructions}
                rows={4}
                placeholder={`Preferences for ${connectedFolder?.name ?? "this folder"}’s Worker…`}
                onChange={(event) => {
                  setInstructions(event.target.value);
                  editDraft((draft) => ({ ...draft, instructions: event.target.value.trim() === savedInstructions ? undefined : event.target.value }));
                  setInstructionsFeedback(null);
                }}
              />
            </label>
          </form>
        </div>
      ) : null}
    </section> : null}
    <section className="ai-models-settings-section ai-models-connection-section" aria-labelledby="ai-models-connection-heading">
      <div className="ai-models-connection-panel">
        <div className="ai-models-section-heading">
          <h3 id="ai-models-connection-heading">Provider Connections</h3>
          <span className="ai-models-section-meta">Shared</span>
        </div>
        {connectedProviders.length ? (
          <div className="ai-models-provider-list">
            {connectedProviders.map((item) => {
              const isOpen = !addingProvider && provider === item.id;
              return (
                <div className="ai-models-provider-item" key={item.id}>
                  <button
                    type="button"
                    className={isOpen ? "ai-models-provider-row open" : "ai-models-provider-row"}
                    aria-expanded={isOpen}
                    data-provider-id={item.id}
                    disabled={mutationBusy}
                    onClick={() => selectProvider(item.id, { toggle: true, openAdd: false })}
                  >
                    <span className="ai-models-provider-row-main">
                      <span className="ai-models-status-dot connected" aria-hidden="true" />
                      <span className="ai-models-provider-name">{providerDisplayName(item)}</span>
                      <span className="ai-models-auth-badge">{providerAuthBadge(item)}</span>
                    </span>
                    <span className="ai-models-provider-chevron" aria-hidden="true">
                      {isOpen ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
                    </span>
                  </button>
                  {isOpen ? renderConnectedDrawer(item) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {availableProviders.length ? (
          <div className="ai-models-add-provider">
            <button
              type="button"
              className="ai-models-add-provider-toggle"
              aria-expanded={addingProvider}
              disabled={mutationBusy}
              onClick={() => {
                if (addingProvider) {
                  setAddingProvider(false);
                  setProviderQuery("");
                  setApiKey("");
                  setConnectionFeedback(null);
                  if (!providerIsConnected) setProvider(connectedProviders[0]?.id ?? "");
                } else {
                  setAddingProvider(true);
                  setProviderQuery("");
                  setApiKey("");
                  setConnectionFeedback(null);
                  if (providerIsConnected) setProvider("");
                }
              }}
            >
              <span className="ai-models-add-provider-label"><Add16Regular aria-hidden="true" />{addingProvider ? "Close" : "Connect Provider"}</span>
              <span className="ai-models-provider-chevron" aria-hidden="true">{addingProvider ? <ChevronUp16Regular /> : <ChevronDown16Regular />}</span>
            </button>
            {addingProvider ? renderAvailableSetup() : null}
          </div>
        ) : null}
      </div>
    </section>
    {imageModels ? <ImageModelSection settings={imageModels} onChange={setImageModels} /> : null}
  </>;
}

function providerDisplayName(item: Pick<AgentProvider, "id" | "name">): string {
  return item.id === "openai-codex" ? "OpenAI (Codex)" : item.name;
}

function providerAuthBadge(item: Pick<AgentProvider, "authSource" | "authType">): string {
  if (item.authSource === "environment") return "Environment";
  if (item.authSource === "models_json_key" || item.authSource === "models_json_command") return "Pi Config";
  if (item.authSource && item.authSource !== "stored") return "External";
  return item.authType === "oauth" ? "Account" : "API Key";
}

function providerCredentialSummary(model: Pick<AgentModel, "authConfigured" | "authSource" | "authType" | "authLabel"> | undefined): string {
  if (!model?.authConfigured) return model?.authSource === "stored" ? "Setup needed" : "Not connected";
  if (model.authSource === "stored") return model.authType === "oauth" ? "Connected" : "API key saved";
  if (model.authSource === "environment") return `From ${model.authLabel || "environment"}`;
  if (model.authSource === "models_json_key" || model.authSource === "models_json_command") return "From Pi settings";
  return "Configured externally";
}

function azureConnectionDraft(connection: FoundryConnection): AzureConnectionDraft {
  return canonicalFoundryDraft({ baseUrl: connection.baseUrl, deployments: connection.deployments.join(", "), modelIds: connection.modelIds });
}

function canonicalFoundryDraft(draft: AzureConnectionDraft): AzureConnectionDraft {
  const entries = Object.entries(draft.modelIds ?? {}).filter(([, id]) => Boolean(id)).sort(([a], [b]) => a.localeCompare(b));
  return { baseUrl: draft.baseUrl, deployments: draft.deployments, ...(entries.length ? { modelIds: Object.fromEntries(entries) } : {}) };
}

function serializeAzureConnection(draft: AzureConnectionDraft, providerId: string): FoundryConnection {
  const deployments = parseAzureDeploymentNames(draft.deployments);
  const modelIds = Object.fromEntries(Object.entries(draft.modelIds ?? {}).filter(([id]) => deployments.includes(id)));
  return normalizeFoundryConnection({ baseUrl: draft.baseUrl, deployments, ...(Object.keys(modelIds).length ? { modelIds } : {}) }, providerId);
}

type AiModelsSettingsResponse = FoundrySettings & { models: AgentModel[]; providers?: AgentProvider[]; status: AgentStatus; catalogs: AgentModelCatalog[]; instructions: string | null; azure?: FoundryConnection; imageModels?: ImageModelSettings };
function loadedFoundry(result: FoundrySettings & { azure?: FoundryConnection }): Record<string, FoundryConnection> {
  return { ...result.foundry, [AZURE_OPENAI_PROVIDER]: result.azure ?? result.foundry?.[AZURE_OPENAI_PROVIDER] ?? emptyAzureConnection };
}
function settingsSnapshot(result: AiModelsSettingsResponse): string {
  return JSON.stringify([result.status.provider, result.status.model, result.status.configured, result.models, connectionProviders(result), result.catalogs, result.instructions ?? "", loadedFoundry(result), result.foundryModels ?? {}, result.foundryErrors ?? {}]);
}

type AiModelsFeedback = { text: string; error?: boolean };
function AiModelsOperationStatus({ feedback, hint }: { feedback: AiModelsFeedback | null; hint?: string }) {
  if (!feedback?.text && !hint) return null;
  return <span className={feedback?.error ? "ai-models-operation-status error" : "ai-models-operation-status"} role={feedback?.error ? "alert" : "status"}>{feedback?.text ?? hint}</span>;
}

function unique<T>(items: T[]) { return [...new Set(items)]; }
function connectionProviders(result: { models: AgentModel[]; providers?: AgentProvider[] }): AgentProvider[] {
  return result.providers ?? unique(result.models.map((model) => model.provider)).map((id) => {
    const models = result.models.filter((model) => model.provider === id);
    const auth = models.find((model) => model.authConfigured);
    return {
      id, name: models[0]?.providerName ?? id, configured: Boolean(auth), authSource: auth?.authSource,
      authLabel: auth?.authLabel, authType: auth?.authType, apiKey: true, oauth: models.some((model) => model.oauthSupported),
      oauthAvailable: models.some((model) => model.oauthSupported), guidedSetup: false, modelCount: models.length,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}
function modelScopeParams(scope: ModelScope, connectedFolder: ConnectedFolderSummary | null) {
  const params = new URLSearchParams({ scope });
  if (scope === "connected-folder" && connectedFolder) params.set("connectedFolderId", connectedFolder.id);
  return params.toString();
}
function modelScopeBody(scope: ModelScope, connectedFolder: ConnectedFolderSummary | null) {
  return scope === "agent" ? { scope } : { scope, connectedFolderId: connectedFolder?.id };
}
function formatCatalogDate(value: string) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * True while the desktop app reports that saved provider credentials could
 * not be decrypted and were set aside. Re-read on model changes and when the
 * window regains focus, so it clears once the person connects again.
 */
function useCredentialsNeedReentry(): boolean {
  const [needed, setNeeded] = useState(false);
  useEffect(() => {
    const getStatus = window.ampleFileDesktop?.settings?.getStatus;
    if (!getStatus) return;
    let disposed = false;
    const read = () => { void getStatus().then((status) => { if (!disposed) setNeeded(status?.credentialsNeedReentry === true); }).catch(() => undefined); };
    read();
    const unsubscribe = subscribeControlEvents((hint) => { if (hint === "models" || hint === "reset") read(); });
    window.addEventListener("focus", read);
    return () => { disposed = true; unsubscribe(); window.removeEventListener("focus", read); };
  }, []);
  return needed;
}
