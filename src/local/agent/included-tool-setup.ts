import { join } from "node:path";
import { createJiti } from "jiti";
import { resolvePiRuntime, type PiRuntimeProvider } from "./pi-runtime-config.js";
import { includedToolDefinitions, type IncludedToolId, type IncludedToolStatus } from "../../shared/included-tools.js";
import { checkDocumentEngines, discoverDocumentEngines, includedComputerStatus, includedDocumentsStatus } from "../../../resources/included-tools/readiness.js";
import { beginIncludedToolObservation, includedToolObservation } from "./included-tool-observations.js";
import { loadIncludedMcpConfig } from "./included-mcp-setup.js";

const jiti = createJiti(import.meta.url, { moduleCache: true });

/** Catalog inspection never starts a helper or an MCP server. */
export async function listIncludedToolStatus(cwd: string, provider?: PiRuntimeProvider): Promise<IncludedToolStatus[]> {
  const runtime = await resolvePiRuntime(cwd, provider, { requestProjectTrust: false });
  if (!runtime.config.includedTools) return [];
  let mcp: IncludedToolStatus;
  try {
    const config = await loadIncludedMcpConfig({ agentDir: runtime.agentDir, ...(runtime.projectTrust.trusted ? { cwd } : {}) });
    const count = config.servers.filter((server) => server.config.enabled !== false).length;
    mcp = { id: "mcp", state: count ? "unknown" : "setup_required", checkedAt: new Date().toISOString(),
      detail: count ? "Service connections are configured. Each connection is verified when you use it or choose Check in its details." : "No service connections are configured. Add a connection to use its tools.", facts: { connections: String(count) } };
  } catch {
    mcp = { id: "mcp", state: "unavailable", checkedAt: new Date().toISOString(), detail: "Service connection configuration could not be read. Open its settings to check the configuration." };
  }
  const braveCredential = await runtime.credentials.read("amplefile:web:brave");
  // File checks only, so a person who just installed LibreOffice sees it on the next refresh.
  const documentEngines = await discoverDocumentEngines(runtime.config.includedTools.documentEngineSearch);
  return includedToolDefinitions.map(({ id }) => {
    if (id === "mcp") return mcp;
    const now = new Date().toISOString();
    if (id === "web") return braveCredential?.type === "api_key"
      ? { id, state: "unknown", detail: "Brave Search key saved. The connection is verified when you search. Public page reading is available.", checkedAt: now }
      : { id, state: "ready", detail: "DuckDuckGo search and public page reading are available without setup.", checkedAt: now };
    const checked = includedToolObservation(runtime, id);
    if (id === "documents") return includedDocumentsStatus(checked, documentEngines);
    return checked ? checked
      : { id, state: "unknown", detail: "Check setup to verify this tool on your computer.", checkedAt: now };
  });
}

export type IncludedSetupAction = "check" | "start-check" | "request-permissions" | "accessibility" | "screen-recording" | "recheck" | "connect-brave" | "disconnect-brave";
export interface IncludedSetupResult { status: IncludedToolStatus }

/** Trusted local setup only. Secrets and permission prompts never enter a turn. */
export async function setupIncludedTool(cwd: string, id: IncludedToolId, action: IncludedSetupAction, input: { secret?: string }, provider?: PiRuntimeProvider, signal?: AbortSignal): Promise<IncludedSetupResult> {
  const runtime = await resolvePiRuntime(cwd, provider, { requestProjectTrust: false });
  const config = runtime.config.includedTools;
  if (!config) throw new Error("Included tools are unavailable in this host.");
  if (!includedToolDefinitions.some((definition) => definition.id === id)) throw new Error("Unknown included tool.");
  // Starting an explicit recheck invalidates earlier evidence even if this
  // attempt throws before it can produce a new structured result.
  const finishObservation = beginIncludedToolObservation(runtime, id, true);
  let status: IncludedToolStatus = { id, state: "unknown", detail: "Setup has not been checked.", checkedAt: new Date().toISOString() };
  if (id === "web") {
    if (action === "connect-brave") {
      const secret = input.secret?.trim();
      if (!secret || secret.length > 4096) throw new Error("Enter a valid Brave Search API key.");
      await runtime.credentials.modify("amplefile:web:brave", async () => ({ type: "api_key", key: secret }));
      await runtime.flushCredentials();
    } else if (action === "disconnect-brave") {
      await runtime.credentials.delete("amplefile:web:brave");
      await runtime.flushCredentials();
    } else if (action !== "check") throw new Error("Unknown web setup action.");
    status = (await listIncludedToolStatus(cwd, provider)).find((item) => item.id === id)!;
  } else if (id === "computer") {
    const computer = await jiti.import<{
      probeIncludedComputer(config: unknown, options: unknown): Promise<Record<string, any>>;
      setupIncludedComputer(config: unknown, action: string, signal?: AbortSignal): Promise<Record<string, any>>;
    }>(join(config.rootPath, "computer", "index.ts"));
    if (!["check", "start-check", "request-permissions", "accessibility", "screen-recording", "recheck"].includes(action)) throw new Error("Unknown computer setup action.");
    const result = ["check", "start-check"].includes(action) ? await computer.probeIncludedComputer(config, { launch: action === "start-check", signal }) : await computer.setupIncludedComputer(config, action, signal);
    status = includedComputerStatus(result);
  } else if (id === "documents") {
    if (action !== "check") throw new Error("Unknown document setup action.");
    const documents = await jiti.import<{ probeIncludedDocuments(options?: { signal?: AbortSignal }): Promise<{ state: "ready" | "unavailable"; reason: string; versions: Record<string, string>; runtime: string }> }>(join(config.rootPath, "documents", "runtime.mjs"));
    const [result, engines] = await Promise.all([documents.probeIncludedDocuments({ signal }), checkDocumentEngines(config.documentEngineSearch, signal)]);
    signal?.throwIfAborted();
    // The observation keeps the libraries' own result and what Check learned about each engine;
    // the status word is recombined with the engines found at each read.
    const observed = finishObservation({ ...status, state: result.state, detail: result.reason, facts: result.versions, documentsSetup: engines });
    return { status: includedDocumentsStatus(observed, await discoverDocumentEngines(config.documentEngineSearch)) };
  } else throw new Error("Use service connection setup to configure MCP.");
  return { status: finishObservation(status) };
}

/** Host shutdown follows session disposal, so one Chat never stops a peer's helper. */
export async function shutdownIncludedToolHost(cwd: string, provider?: PiRuntimeProvider): Promise<void> {
  const runtime = await resolvePiRuntime(cwd, provider, { requestProjectTrust: false });
  const config = runtime.config.includedTools;
  if (!config?.helperAppPath) return;
  const computer = await jiti.import<{ shutdownIncludedComputer(config: unknown): Promise<void> }>(join(config.rootPath, "computer", "index.ts"));
  await computer.shutdownIncludedComputer(config);
}
