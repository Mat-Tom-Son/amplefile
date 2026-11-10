/**
 * Settings → AI Models routes: model context inspection, the image model,
 * model lists, provider setup and sign-in, Worker instructions, and thinking
 * level.
 */

import type { PiRuntimeProvider } from "../agent/pi-client.js";
import { normalizeWorkerInstructions } from "../agent/model-preferences.js";
import {
  getPiComposerState,
  getPiWorkerInstructions,
  getPiSetupStatus,
  listPiModelCatalogs,
  listPiImageModels,
  listPiModels,
  loginPiProvider,
  removePiProviderAuth,
  refreshPiModelCatalog,
  savePiApiKey,
  resolvePiRuntime,
  ensurePiDefaultModel,
  setPiDefaultModel,
  setPiDefaultThinkingLevel,
  setPiWorkerInstructions,
  type PiSetupStatus,
} from "../agent/pi-runtime-config.js";
import { readOpenAiAccount } from "../agent/openai-account.js";
import { normalizeImageModelChoice } from "../agent/image-model-preference.js";
import { getFoundrySettings, saveFoundryConnection } from "../agent/foundry-connection.js";
import { AZURE_OPENAI_PROVIDER, foundryProvider, normalizeFoundryConnection, type FoundryConnection } from "../../shared/foundry.js";
import { ampleFileAgentRoot, ampleFileAgentScopeId } from "../state-paths.js";
import { getConnectedFolder } from "../connected-folder.js";
import { publishControlHint } from "./event-streams.js";
import { badRequest, errorMessage, httpError, match, notFound, readJsonBody, sendJson, unavailable } from "./http.js";
import { globalCapabilityMutationKey, runCapabilityMutation } from "./reservations.js";
import type { LocalApiRequest, LocalApiState } from "./state.js";

/** Model context inspection: trusted local diagnostics over retained snapshots. */
export async function handleModelContextRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
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
      return true;
    }
    if (id) throw badRequest("Context captures are read-only.");
    const body = await readJsonBody<{ enabled?: unknown; clear?: unknown }>(state, req);
    if (Object.keys(body).length !== 1) throw badRequest("Choose recording or clear captures.");
    if (typeof body.enabled === "boolean") state.modelContextInspector.setEnabled(body.enabled);
    else if (body.clear === true) state.modelContextInspector.clear();
    else throw badRequest("Specify enabled as a boolean or clear as true.");
    sendJson(res, state.modelContextInspector.inspect(filter));
    return true;
  }
  return false;
}

/** Settings → AI Models and a Worker's own settings: the image model, model lists, provider setup and sign-in, Worker instructions, and thinking level. */
export async function handleAiModelRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // Settings → AI Models → Image model: one choice for every Worker
  // and the AmpleFile Agent; null is Automatic. Credentials are machine-wide, so
  // the AmpleFile Agent's runtime lists what every scope can use.
  if (method === "GET" && url.pathname === "/api/agent/image-models") {
    sendJson(res, await imageModelSettings(state));
    return true;
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
    return true;
  }
  if (method === "GET" && url.pathname === "/api/agent/provider-account") {
    const provider = url.searchParams.get("provider");
    if (provider !== "openai" && provider !== "openai-codex") throw badRequest("Choose an OpenAI account connection.");
    const scope = await modelScope(url.searchParams.get("scope"), url.searchParams.get("connectedFolderId"));
    const runtime = await resolvePiRuntime(scope.connectedFolderRoot, state.runtimeProvider, { requestProjectTrust: false });
    const account = await readOpenAiAccount(runtime, provider);
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, { account });
    return true;
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
    return true;
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
    return true;
  }
  if (method === "GET" && url.pathname === "/api/agent/status") {
    const connectedFolderId = url.searchParams.get("connectedFolderId");
    const scope = await modelScope(url.searchParams.get("scope"), connectedFolderId);
    sendJson(res, { status: await safeAgentStatus(scope.connectedFolderRoot, state.runtimeProvider) });
    return true;
  }
  if (method === "GET" && url.pathname === "/api/agent/composer") {
    const connectedFolderId = url.searchParams.get("connectedFolderId");
    const scope = await modelScope(url.searchParams.get("scope"), connectedFolderId);
    sendJson(res, { composer: await getPiComposerState(scope.connectedFolderRoot, state.runtimeProvider) });
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
  }
  if (method === "GET" && url.pathname === "/api/agent/oauth/pending") {
    sendJson(res, { acceptsPaste: state.providerSignIns.acceptsPaste });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/agent/oauth/cancel") {
    sendJson(res, { cancelled: state.providerSignIns.cancel() });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/agent/oauth/paste") {
    const body = await readJsonBody<{ value?: string }>(state, req);
    const value = typeof body.value === "string" ? body.value.trim() : "";
    if (!value) throw badRequest("Paste the link your browser ended on.");
    if (value.length > 8192) throw badRequest("That link is too long to be a sign-in link.");
    if (!state.providerSignIns.paste(value)) throw httpError(409, "This sign-in finishes in your browser, so there is no link to paste.");
    sendJson(res, { accepted: true });
    return true;
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
    // Starting a sign-in cancels one left waiting, so it never holds the setup lock.
    const signIn = await state.providerSignIns.begin(state.piOAuthHooks);
    try {
      await runCapabilityMutation(state, scope, "global", async () => {
        await loginPiProvider(scope.connectedFolderRoot, body.provider!, authMethod, signIn.hooks, state.runtimeProvider);
        if (body.model) await setPiDefaultModel(scope.connectedFolderRoot, { provider: body.provider!, id: body.model }, state.runtimeProvider);
        else await ensurePiDefaultModel(scope.connectedFolderRoot, body.provider!, state.runtimeProvider);
      }, { requireProjectTrust: false });
    } catch (error) {
      if (signIn.cancelled()) throw httpError(409, "Sign-in cancelled.");
      throw error;
    } finally {
      signIn.finish();
    }
    const status = await getPiSetupStatus(scope.connectedFolderRoot, state.runtimeProvider);
    sendJson(res, {
      status: normalizeStatus(status), providers: providerSetupResponse(status, true),
      models: await listPiModels(scope.connectedFolderRoot, state.runtimeProvider),
    });
    return true;
  }
  return false;
}

/**
 * Worker instructions shape only later turns, so saving them never waits on or
 * interrupts work: idle Chats rebuild now, and a Chat that is mid-turn or
 * compacting (including the Worker that saved them, as Set up for me does)
 * rebuilds as soon as that work ends.
 */
export async function saveWorkerInstructions(
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

export function emptyAgentStatus(): Record<string, unknown> {
  return { ready: true, configured: false, provider: null, model: null, piVersion: null, projectTrusted: false, error: null };
}

export async function safeAgentStatus(connectedFolderRoot: string, provider: PiRuntimeProvider): Promise<Record<string, unknown>> {
  try {
    return normalizeStatus(await getPiSetupStatus(connectedFolderRoot, provider));
  } catch (error) {
    return { ...emptyAgentStatus(), ready: false, error: errorMessage(error) };
  }
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
