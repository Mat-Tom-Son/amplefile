import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { ModelPreferenceStore } from "../src/local/agent/model-preferences.js";
import { OpenRouterModelCatalog, parseOpenRouterModels } from "../src/local/agent/openrouter-model-catalog.js";
import { appendWorkerInstructions, type PiPreferredModel, type PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";
import { startLocalApi } from "../src/local/server.js";

test("Model preferences follow portable Connected Folder ids and keep the AmpleFile Agent separate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-model-preferences-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstConnectedFolderRoot = join(root, "first-location");
  const movedConnectedFolderRoot = join(root, "moved-location");
  const ampleFileAgentTestRoot = join(root, "management");
  for (const connectedFolderRoot of [firstConnectedFolderRoot, movedConnectedFolderRoot]) {
    await mkdir(join(connectedFolderRoot, ".amplefile"), { recursive: true });
    await writeFile(join(connectedFolderRoot, ".amplefile", "connected-folder.json"), JSON.stringify({ id: "portable-connected-folder-id" }));
  }
  await mkdir(ampleFileAgentTestRoot, { recursive: true });
  const store = new ModelPreferenceStore({
    filePath: join(root, "model-preferences.json"),
    ampleFileAgentRootPath: ampleFileAgentTestRoot,
  });

  await store.set(firstConnectedFolderRoot, { provider: "openrouter", id: "connected-folder-model" });
  await store.setInstructions(firstConnectedFolderRoot, "Prefer focused tests.\r\nKeep the answer concise.");
  await store.set(ampleFileAgentTestRoot, { provider: "openai-codex", id: "agent-model" });

  assert.deepEqual(await store.get(movedConnectedFolderRoot), { provider: "openrouter", id: "connected-folder-model" });
  assert.equal(await store.getInstructions(movedConnectedFolderRoot), "Prefer focused tests.\nKeep the answer concise.");
  assert.deepEqual(await store.get(ampleFileAgentTestRoot), { provider: "openai-codex", id: "agent-model" });
  assert.equal(await store.getInstructions(ampleFileAgentTestRoot), "");

  await store.setInstructions(movedConnectedFolderRoot, "");
  assert.deepEqual(await store.get(firstConnectedFolderRoot), { provider: "openrouter", id: "connected-folder-model" });
  assert.equal(await store.getInstructions(firstConnectedFolderRoot), "");
});

test("Connected Folder instructions append after the app-owned prompt and leave other scopes untouched", () => {
  assert.deepEqual(appendWorkerInstructions(["Base prompt"], ""), ["Base prompt"]);
  assert.deepEqual(appendWorkerInstructions(["Base prompt"], "Use the Connected Folder glossary."), [
    "Base prompt",
    "## Worker instructions\n\nUse the Connected Folder glossary.",
  ]);
});

test("OpenRouter live catalog normalizes tool-capable text models and persists the last good refresh", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-openrouter-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = JSON.stringify({
    data: [{
      id: "example/reasoning-model",
      name: "Example: Reasoning Model",
      context_length: 131_072,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.000002", completion: "0.000008" },
      supported_parameters: ["tools", "reasoning"],
      top_provider: { max_completion_tokens: 16_384 },
    }, {
      id: "example/audio-only",
      name: "Audio only",
      context_length: 4096,
      architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    }],
  });
  const parsed = parseOpenRouterModels(payload);
  assert.equal(parsed.length, 1);
  const reasoningModel = parsed[0];
  assert.deepEqual(reasoningModel?.input, ["text", "image"]);
  // No listed cache rate: cached prompt tokens are priced like the prompt, never as free.
  assert.deepEqual(reasoningModel?.cost, { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 });
  assert.equal(reasoningModel?.reasoning, true);

  const requests: Array<{ authorization: string | null }> = [];
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ authorization: headers.get("authorization") });
    return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const cachePath = join(root, "model-catalogs", "openrouter.json");
  const catalog = new OpenRouterModelCatalog({ cachePath, fetch: fakeFetch });
  const refreshed = await catalog.refresh("secret-openrouter-key");
  assert.equal(refreshed.modelCount, 1);
  assert.deepEqual(requests, [{ authorization: "Bearer secret-openrouter-key" }]);
  assert.equal((await catalog.status()).source, "live");

  const reopened = new OpenRouterModelCatalog({ cachePath, fetch: fakeFetch });
  const cached = await reopened.load();
  assert.equal(cached?.provider, "openrouter");
  assert.equal(cached?.liveModelCount, 1);
  assert.equal(cached?.config.models?.[0]?.id, "example/reasoning-model");
});

test("agent API saves independent Connected Folder and fold models", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-scoped-model-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const authStorage = FileCredentialStore.inMemory({ scoped: { type: "api_key", key: "test-key" } });
  const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
  modelRuntime.registerProvider("scoped", {
    name: "Scoped Provider",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "$AMPLEFILE_SCOPED_TEST_KEY",
    models: ["connected-folder-model", "agent-model"].map((id) => ({
      id,
      name: id === "connected-folder-model" ? "Connected Folder Model" : "Fold Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    })),
  });
  const preferences = new Map<string, PiPreferredModel>();
  const instructions = new Map<string, string>();
  const provider: PiRuntimeProvider = {
    async resolveRuntime(connectedFolderRoot) {
      return {
        agentDir,
        credentials: authStorage,
        modelRuntime,
        settingsManager: SettingsManager.inMemory(),
        ...(preferences.get(connectedFolderRoot) ? { preferredModel: preferences.get(connectedFolderRoot) } : {}),
        ...(instructions.get(connectedFolderRoot) ? { workerInstructions: instructions.get(connectedFolderRoot) } : {}),
      };
    },
    async setPreferredModel(connectedFolderRoot, model) {
      preferences.set(connectedFolderRoot, model);
    },
    async getWorkerInstructions(connectedFolderRoot) {
      return instructions.get(connectedFolderRoot) ?? "";
    },
    async setWorkerInstructions(connectedFolderRoot, value) {
      instructions.set(connectedFolderRoot, value);
    },
  };
  const api = await startLocalApi({
    port: 0,
    stateBase: join(root, "state"),
    connectedFolderBase: join(root, "content"),
    loadEnv: false,
    piRuntimeProvider: provider,
  });
  t.after(() => api.close());
  const created = await requestJson(`${api.origin}/api/connected-folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Scoped Connected Folder" }),
  }) as { connectedFolder: { id: string } };

  await requestJson(`${api.origin}/api/agent/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "connected-folder", connectedFolderId: created.connectedFolder.id, provider: "scoped", model: "connected-folder-model" }),
  });
  await requestJson(`${api.origin}/api/agent/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "agent", provider: "scoped", model: "agent-model" }),
  });

  const saved = await requestJson(`${api.origin}/api/agent/instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "connected-folder", connectedFolderId: created.connectedFolder.id, instructions: "Use this Connected Folder's glossary." }),
  }) as { instructions: string };
  assert.equal(saved.instructions, "Use this Connected Folder's glossary.");

  const connectedFolderModels = await requestJson(`${api.origin}/api/agent/models?scope=connected-folder&connectedFolderId=${created.connectedFolder.id}`) as { status: { model: string }; instructions: string };
  const ampleFileAgentModels = await requestJson(`${api.origin}/api/agent/models?scope=agent`) as { status: { model: string }; instructions: null };
  assert.equal(connectedFolderModels.status.model, "connected-folder-model");
  assert.equal(connectedFolderModels.instructions, "Use this Connected Folder's glossary.");
  assert.equal(ampleFileAgentModels.status.model, "agent-model");
  assert.equal(ampleFileAgentModels.instructions, null);

  const streamAbort = new AbortController();
  const streamTimeout = setTimeout(() => streamAbort.abort(), 10_000);
  try {
    const stream = await fetch(`${api.origin}/api/amplefile-agent/control-events`, { signal: streamAbort.signal });
    const reader = stream.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"reset"}\n\n');
    await api.actFacade.workerSetModel({ connectedFolder: created.connectedFolder.id, provider: "scoped", model: "agent-model" });
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"models"}\n\n');
    const composer = await requestJson(`${api.origin}/api/agent/composer?scope=connected-folder&connectedFolderId=${created.connectedFolder.id}`) as { composer: { model: { id: string } } };
    assert.equal(composer.composer.model.id, "agent-model");
    await requestJson(`${api.origin}/api/agent/configure`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "connected-folder", connectedFolderId: created.connectedFolder.id, provider: "scoped", model: "connected-folder-model" }),
    });
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"models"}\n\n');
  } finally { clearTimeout(streamTimeout); streamAbort.abort(); }

  const invalid = await fetch(`${api.origin}/api/agent/instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "connected-folder", connectedFolderId: created.connectedFolder.id, instructions: "bad\u0001control" }),
  });
  assert.equal(invalid.status, 400);

  const management = await fetch(`${api.origin}/api/agent/instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "agent", instructions: "Do not allow this." }),
  });
  assert.equal(management.status, 400);
});

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return text ? JSON.parse(text) : null;
}

test("OpenRouter's listed cache rates price cached prompt tokens", () => {
  const [model] = parseOpenRouterModels(JSON.stringify({ data: [{
    id: "example/cached-model",
    name: "Example: Cached Model",
    context_length: 200_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375" },
    supported_parameters: ["tools"],
  }] }));
  assert.equal(model?.cost.input, 3);
  assert.ok(Math.abs(model!.cost.cacheRead - 0.3) < 1e-9);
  assert.ok(Math.abs(model!.cost.cacheWrite - 3.75) < 1e-9);
});

test("a model list saved before cache rates were read prices cached prompt tokens like the prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-openrouter-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cachePath = join(root, "openrouter.json");
  await writeFile(cachePath, JSON.stringify({
    version: 1,
    provider: "openrouter",
    refreshedAt: "2026-10-01T00:00:00.000Z",
    models: [{ id: "example/old", name: "Old", reasoning: false, input: ["text"], cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }],
  }), "utf8");
  const loaded = await new OpenRouterModelCatalog({ cachePath }).load();
  assert.deepEqual(loaded?.config.models?.[0]?.cost, { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 });
});
