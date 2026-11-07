import {
  AmpleFileCliError,
  type AmpleFileCliActor,
  type AmpleFileCliCapabilitySummary,
  type AmpleFileCliCheckStatusSummary,
  type AmpleFileCliContextSnapshot,
  type AmpleFileCliKernel,
  type AmpleFileCliConnectedFolderSummary,
  type AmpleFileCliTaskSummary,
} from "./cli/protocol.js";
import {
  ampleFileCheckExperimentalSnapshotVersion,
  type AmpleFileCheckStatusSnapshot,
} from "./checks/check-types.js";
import {
  AmpleFileContextRequiredError,
  type AmpleFileActor,
  type AmpleFileCapabilityScope,
  type AmpleFileConnectedFolderSnapshot,
  AmpleFileKernel,
} from "./amplefile-kernel.js";
import { ampleFileAgentScopeId } from "./state-paths.js";

interface AmpleFileCliOptions {
  connectedFolder?: string;
}

export interface AmpleFileCliCheckStatusProviderInput {
  connectedFolderId: string;
  connectedFolderRoot: string;
}

export type AmpleFileCliCheckStatusProvider = (
  input: AmpleFileCliCheckStatusProviderInput,
) => Promise<AmpleFileCheckStatusSnapshot>;

export interface AmpleFileCliKernelAdapterOptions {
  checksStatusProvider?: AmpleFileCliCheckStatusProvider;
}

/**
 * Thin CLI projection over the shared AmpleFileKernel. The adapter owns CLI
 * selection rules and deliberately emits only compact, content-free summaries.
 */
export class AmpleFileCliKernelAdapter implements AmpleFileCliKernel {
  readonly #checksStatusProvider?: AmpleFileCliCheckStatusProvider;

  constructor(readonly kernel: AmpleFileKernel, options: AmpleFileCliKernelAdapterOptions = {}) {
    this.#checksStatusProvider = options.checksStatusProvider;
  }

  async getContext(
    actor: AmpleFileCliActor,
    options: AmpleFileCliOptions,
  ): Promise<AmpleFileCliContextSnapshot> {
    const selected = await this.#selectConnectedFolder(actor, options.connectedFolder);
    const context = selected
      ? await this.kernel.getContext(scopedActor(actor, selected.id))
      : await this.kernel.getContext(actor);

    return {
      cwd: actor.cwd,
      connectedFolder: context.connectedFolder ? summarizeConnectedFolder(context.connectedFolder, true) : null,
      selectedPath: null,
      activeSurface: null,
    };
  }

  async listConnectedFolders(
    actor: AmpleFileCliActor,
    options: AmpleFileCliOptions,
  ): Promise<AmpleFileCliConnectedFolderSummary[]> {
    const snapshot = await this.kernel.getConnectedFolders(actor);
    const selected = resolveAmpleFileCliConnectedFolderSelector(snapshot.connectedFolders, options.connectedFolder);
    const activeId = selected?.id ?? (await this.kernel.getContext(actor)).connectedFolder?.id;
    const connectedFolders = selected ? [selected] : snapshot.connectedFolders;
    return connectedFolders.map((connectedFolder) => summarizeConnectedFolder(connectedFolder, connectedFolder.id === activeId));
  }

  async listTasks(
    actor: AmpleFileCliActor,
    options: AmpleFileCliOptions,
  ): Promise<AmpleFileCliTaskSummary[]> {
    const selected = await this.#selectConnectedFolder(actor, options.connectedFolder);
    const snapshot = await this.kernel.getTasks(selected ? scopedActor(actor, selected.id) : actor);
    return snapshot.tasks.map((task) => ({
      id: task.id,
      label: task.kind !== "assistant_turn"
        ? "Chat compaction"
        : task.connectedFolderId === ampleFileAgentScopeId ? "AmpleFile agent turn" : "Worker turn",
      status: task.status,
      connectedFolderId: task.connectedFolderId,
      updatedAt: task.startedAt,
    }));
  }

  async listCapabilities(
    actor: AmpleFileCliActor,
    options: AmpleFileCliOptions,
  ): Promise<AmpleFileCliCapabilitySummary[]> {
    const selected = await this.#selectConnectedFolder(actor, options.connectedFolder);
    try {
      const snapshot = await this.kernel.getCapabilities(selected ? scopedActor(actor, selected.id) : actor);
      const { catalog } = snapshot;
      return [
        ...catalog.skills.map((skill): AmpleFileCliCapabilitySummary => ({
          id: `skill:${skill.scope}:${skill.path}`,
          name: skill.name,
          kind: "skill",
          scope: cliScope(skill.scope),
          status: skill.status,
          source: skill.source,
        })),
        ...catalog.extensions.map((extension): AmpleFileCliCapabilitySummary => ({
          id: `extension:${extension.scope}:${extension.id}`,
          name: extension.name,
          kind: "extension",
          scope: cliScope(extension.scope),
          status: extension.status,
          source: extension.source,
        })),
        ...catalog.tools.map((tool): AmpleFileCliCapabilitySummary => ({
          id: `tool:${tool.scope}:${tool.name}`,
          name: tool.label || tool.name,
          kind: "tool",
          scope: cliScope(tool.scope),
          status: tool.active ? tool.status : "inactive",
          source: tool.source,
        })),
        ...catalog.packages.map((item): AmpleFileCliCapabilitySummary => ({
          id: `package:${item.scope}:${item.source}`,
          name: item.source,
          kind: "package",
          scope: cliScope(item.scope),
          status: item.loaded ? "loaded" : item.installed ? "installed" : "missing",
          source: item.source,
        })),
        ...catalog.prompts.map((prompt): AmpleFileCliCapabilitySummary => ({
          id: `prompt:${prompt.scope}:${prompt.path}`,
          name: prompt.name,
          kind: "other",
          scope: cliScope(prompt.scope),
          status: prompt.status,
          source: prompt.source,
        })),
        ...catalog.themes.map((theme): AmpleFileCliCapabilitySummary => ({
          id: `theme:${theme.scope ?? "global"}:${theme.path ?? theme.name}`,
          name: theme.name,
          kind: "other",
          scope: cliScope(theme.scope),
          status: theme.status,
          ...(theme.source ? { source: theme.source } : {}),
        })),
        ...catalog.commands.map((command): AmpleFileCliCapabilitySummary => ({
          id: `command:${command.scope ?? "global"}:${command.name}`,
          name: command.name,
          kind: "other",
          scope: cliScope(command.scope),
          status: command.status,
          source: command.source,
        })),
      ].sort(compareCapabilitySummaries);
    } catch (error) {
      if (error instanceof AmpleFileContextRequiredError) {
        throw new AmpleFileCliError(
          "notFound",
          "No Connected Folder contains the current working directory. Select one with --connected-folder <id-or-name>.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async getChecksStatus(
    actor: AmpleFileCliActor,
    options: AmpleFileCliOptions,
  ): Promise<AmpleFileCliCheckStatusSummary> {
    const selected = await this.#selectConnectedFolder(actor, options.connectedFolder);
    const context = await this.kernel.getContext(selected ? scopedActor(actor, selected.id) : actor);
    if (!context.connectedFolder) {
      throw new AmpleFileCliError(
        "notFound",
        "No Connected Folder contains the current working directory. Select one with --connected-folder <id-or-name>.",
      );
    }
    const unavailable = unavailableChecksStatus(context.connectedFolder.id);
    if (!this.#checksStatusProvider) return unavailable;
    try {
      const snapshot = await this.#checksStatusProvider({
        connectedFolderId: context.connectedFolder.id,
        connectedFolderRoot: context.connectedFolder.connectedFolderRoot,
      });
      return projectChecksStatus(snapshot, context.connectedFolder.id) ?? unavailable;
    } catch {
      // Provider failures may contain file paths or Check error details. The
      // read lane exposes only the fact that aggregate status is unavailable.
      return unavailable;
    }
  }

  async #selectConnectedFolder(actor: AmpleFileCliActor, selector: string | undefined): Promise<AmpleFileConnectedFolderSnapshot | undefined> {
    if (selector === undefined) return undefined;
    return resolveAmpleFileCliConnectedFolderSelector((await this.kernel.getConnectedFolders(actor)).connectedFolders, selector);
  }
}

const checkStates = new Set([
  "not-configured",
  "current-clear",
  "needs-attention",
  "stale",
  "blocked",
  "check-error",
]);

function projectChecksStatus(snapshot: AmpleFileCheckStatusSnapshot, connectedFolderId: string): AmpleFileCliCheckStatusSummary | null {
  if (!snapshot || snapshot.kind !== "amplefile.checks.experimental" || snapshot.version !== ampleFileCheckExperimentalSnapshotVersion) return null;
  if (snapshot.connectedFolderId !== connectedFolderId || !checkStates.has(snapshot.state)) return null;
  const counts = [
    snapshot.configured,
    snapshot.proposed,
    snapshot.enabled,
    snapshot.current,
    snapshot.neverRun,
    snapshot.stale,
    snapshot.blocked,
    snapshot.errors,
    snapshot.needsAttention,
    snapshot.running,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  if (snapshot.current + snapshot.neverRun + snapshot.stale > snapshot.enabled) return null;
  if (snapshot.proposed + snapshot.enabled + snapshot.blocked > snapshot.configured) return null;
  if (snapshot.lastRunAt !== null && (typeof snapshot.lastRunAt !== "string" || !Number.isFinite(Date.parse(snapshot.lastRunAt)))) return null;
  return {
    kind: "amplefile.checks.experimental",
    version: ampleFileCheckExperimentalSnapshotVersion,
    available: true,
    connectedFolderId,
    state: snapshot.state,
    configured: snapshot.configured,
    proposed: snapshot.proposed,
    enabled: snapshot.enabled,
    current: snapshot.current,
    neverRun: snapshot.neverRun,
    stale: snapshot.stale,
    blocked: snapshot.blocked,
    errors: snapshot.errors,
    needsAttention: snapshot.needsAttention,
    running: snapshot.running,
    lastRunAt: snapshot.lastRunAt === null ? null : new Date(snapshot.lastRunAt).toISOString(),
  };
}

function unavailableChecksStatus(connectedFolderId: string): AmpleFileCliCheckStatusSummary {
  return {
    kind: "amplefile.checks.experimental",
    version: ampleFileCheckExperimentalSnapshotVersion,
    available: false,
    connectedFolderId,
    state: "unavailable",
    configured: 0,
    proposed: 0,
    enabled: 0,
    current: 0,
    neverRun: 0,
    stale: 0,
    blocked: 0,
    errors: 0,
    needsAttention: 0,
    running: 0,
    lastRunAt: null,
  };
}

/**
 * Shared "--connected-folder <id-or-exact-name>" selection: an id match wins, a unique
 * case-folded name match is accepted, and duplicates are rejected as
 * ambiguous. The act facade reuses this so both CLI lanes select identically.
 */
export function resolveAmpleFileCliConnectedFolderSelector<T extends { id: string; name: string }>(
  connectedFolders: T[],
  selector: string | undefined,
): T | undefined {
  if (selector === undefined) return undefined;
  const normalized = selector.trim();
  const idMatch = connectedFolders.find((connectedFolder) => connectedFolder.id === normalized);
  if (idMatch) return idMatch;

  const folded = normalized.toLocaleLowerCase("en-US");
  const nameMatches = connectedFolders.filter((connectedFolder) => connectedFolder.name.toLocaleLowerCase("en-US") === folded);
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new AmpleFileCliError(
      "conflict",
      `Connected Folder name is ambiguous: ${normalized || "(empty)"}. Use an exact Connected Folder id.`,
    );
  }
  throw new AmpleFileCliError("notFound", `Connected Folder not found: ${normalized || "(empty)"}.`);
}

function scopedActor(actor: AmpleFileCliActor, connectedFolderId: string): AmpleFileActor {
  return { ...actor, connectedFolderId };
}

function summarizeConnectedFolder(connectedFolder: AmpleFileConnectedFolderSnapshot, active: boolean): AmpleFileCliConnectedFolderSummary {
  return {
    id: connectedFolder.id,
    name: connectedFolder.name,
    connectedFolderRoot: connectedFolder.connectedFolderRoot,
    active,
    ...(connectedFolder.parentConnectedFolderId ? { parentConnectedFolderId: connectedFolder.parentConnectedFolderId } : {}),
  };
}

function cliScope(scope: AmpleFileCapabilityScope | "global" | "project" | undefined): string {
  if (scope === "global" || scope === undefined) return "everywhere";
  if (scope === "project") return "connected-folder";
  return scope;
}

function compareCapabilitySummaries(
  left: AmpleFileCliCapabilitySummary,
  right: AmpleFileCliCapabilitySummary,
): number {
  const order: Record<AmpleFileCliCapabilitySummary["kind"], number> = {
    skill: 0,
    extension: 1,
    tool: 2,
    package: 3,
    other: 4,
  };
  return order[left.kind] - order[right.kind]
    || left.name.localeCompare(right.name, "en-US", { sensitivity: "base" })
    || left.id.localeCompare(right.id, "en-US");
}
