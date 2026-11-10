/**
 * Skills & Extensions routes: discovery, installs, the included tools and
 * their setup sessions, enabling resources, packages, Skills, and a Connected
 * Folder's catalog. Setup sessions are kept per `LocalApiState` in this
 * module.
 */

import { createIncludedMcpSetup } from "../agent/included-mcp-setup.js";
import { listIncludedToolStatus, setupIncludedTool, type IncludedSetupAction } from "../agent/included-tool-setup.js";
import { includedToolDefinitions, type IncludedToolId } from "../../shared/included-tools.js";
import type { NativeResourceKind } from "../agent/resource-lifecycle.js";
import { randomUUID } from "node:crypto";
import type { CapabilitySort, CapabilityType } from "../agent/capability-registry.js";
import { importPiSkillBundle, removePiSkill } from "../agent/skill-import.js";
import { installPiPackage, removePiPackage, resolvePiRuntime, updatePiPackages } from "../agent/pi-runtime-config.js";
import { ampleFileAgentRoot, ampleFileAgentScopeId } from "../state-paths.js";
import { AmpleFileRecentlyDeletedError } from "../recently-deleted-store.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import { getConnectedFolder, type ConnectedFolderSummary } from "../connected-folder.js";
import { createAmpleFileActFacade } from "./act-lane.js";
import { invalidateAllClients, invalidateAmpleFileClients } from "./conversation-clients.js";
import { badRequest, errorMessage, httpError, match, optionalBoundedInteger, readJsonBody, readMultipartBody, sendJson } from "./http.js";
import { runDesktopSettingsAct } from "./prepared-act-adapters.js";
import { type CapabilityScope, runCapabilityMutation } from "./reservations.js";
import type { LocalApiRequest, LocalApiState } from "./state.js";

/** Skills & Extensions: discovery, installs, the included tools and their setup, enabling resources, packages, Skills, and a Connected Folder's catalog. */
export async function handleCapabilityRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  if (method === "GET" && url.pathname === "/api/agent/capabilities/discover") {
    const result = await state.capabilityRegistry.search({
      query: url.searchParams.get("query") ?? undefined,
      type: capabilityRegistryType(url.searchParams.get("type")),
      sort: capabilityRegistrySort(url.searchParams.get("sort")),
      offset: optionalBoundedInteger(url.searchParams.get("offset"), "offset"),
      limit: optionalBoundedInteger(url.searchParams.get("limit"), "limit"),
    });
    sendJson(res, { ...result, catalogUrl: "https://pi.dev/packages" });
    return true;
  }
  if (method === "GET" && url.pathname === "/api/agent/capabilities/details") {
    const id = url.searchParams.get("id")?.trim();
    if (!id) throw badRequest("Capability id is required.");
    sendJson(res, { item: await state.capabilityRegistry.details(id) });
    return true;
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
    return true;
  }
  if (method === "POST" && url.pathname === "/api/agent/mcp-setup") {
    const body = await readJsonBody<{ connectedFolderId?: string; sessionId?: string; operation?: string; scope?: "global" | "project"; name?: string; definition?: unknown; token?: string; jobId?: string; expectedRevision?: string; enabled?: unknown }>(state, req);
    if (!body.connectedFolderId || !body.operation) throw badRequest("A Connected Folder and setup operation are required.");
    let sessions = mcpSetupSessions.get(state);
    if (!sessions) { sessions = new Map(); mcpSetupSessions.set(state, sessions); }
    if (body.operation === "close") {
      const entry = body.sessionId ? sessions.get(body.sessionId) : undefined;
      if (!entry || entry.connectedFolderId !== body.connectedFolderId) { sendJson(res, { closed: true }); return true; }
      clearTimeout(entry.timer); sessions.delete(body.sessionId!); await entry.service.dispose(); sendJson(res, { closed: true }); return true;
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
      return true;
    }
    const entry = body.sessionId ? sessions.get(body.sessionId) : undefined;
    if (!entry || entry.connectedFolderId !== connectedFolder.id) throw badRequest("This connection setup has closed. Open it again.");
    resetMcpSetupExpiry(state, body.sessionId!, entry);
    if (body.operation === "list") { sendJson(res, { servers: await entry.service.list({ inspectCredentials: true }) }); return true; }
    if (body.operation === "oauth-status") { sendJson(res, { job: entry.service.oauthStatus(body.jobId ?? "") }); return true; }
    if (body.operation === "oauth-cancel") { await entry.service.cancelOAuth(body.jobId ?? ""); sendJson(res, { cancelled: true }); return true; }
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
        return true;
      }
      case "save": await entry.service.saveServer({ ...selection, definition: body.definition as never }); break;
      case "enabled": {
        if (typeof body.enabled !== "boolean") throw badRequest("Choose whether the service is enabled.");
        await entry.service.setEnabled(selection, body.enabled); break;
      }
      case "remove": await entry.service.removeServer(selection); break;
      case "bearer": await entry.service.saveBearer({ ...selection, token: body.token! }); break;
      case "disconnect": await entry.service.disconnect(selection); break;
      case "oauth": sendJson(res, { job: await entry.service.startOAuth(selection) }); return true;
      default: throw badRequest("Unknown service setup operation.");
    }
    sendJson(res, { servers: await entry.service.list({ inspectCredentials: true }) }); return true;
  }
  if (method === "GET" && url.pathname === "/api/agent/included-tools") {
    // The included tools are machine-wide; first run sets them up before any Connected Folder exists.
    const connectedFolder = await includedToolScope(url.searchParams.get("connectedFolderId"));
    sendJson(res, { tools: await listIncludedToolStatus(connectedFolder.connectedFolderRoot, state.runtimeProvider) });
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
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
    return true;
  }

  const catalogMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/agent\/catalog$/);
  if (method === "GET" && catalogMatch) {
    const snapshot = await state.kernel.getCapabilities({ kind: "renderer", connectedFolderId: catalogMatch[1] });
    sendJson(res, snapshot.catalog);
    return true;
  }
  return false;
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

type McpSetupSession = { connectedFolderId: string; service: ReturnType<typeof createIncludedMcpSetup>; timer: ReturnType<typeof setTimeout> };
const mcpSetupSessions = new WeakMap<LocalApiState, Map<string, McpSetupSession>>();
function resetMcpSetupExpiry(state: LocalApiState, id: string, entry: McpSetupSession): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { mcpSetupSessions.get(state)?.delete(id); void entry.service.dispose().catch(() => undefined); }, 15 * 60_000);
  entry.timer.unref();
}
export async function closeMcpSetups(state: LocalApiState): Promise<void> {
  const entries = mcpSetupSessions.get(state); mcpSetupSessions.delete(state);
  await Promise.allSettled([...(entries?.values() ?? [])].map(async (entry) => { clearTimeout(entry.timer); await entry.service.dispose(); }));
}

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

function capabilityScope(value: unknown): CapabilityScope {
  if (value === undefined || value === null || value === "global") return "global";
  if (value === "project") return "project";
  throw badRequest("Capability scope must be global or project.");
}

/** A Connected Folder when one is named; otherwise the AmpleFile Agent's scope (first run, no Connected Folder yet). */
async function includedToolScope(connectedFolderId: string | null | undefined): Promise<{ id: string; connectedFolderRoot: string }> {
  if (connectedFolderId) return getConnectedFolder(connectedFolderId);
  return { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentRoot() };
}
