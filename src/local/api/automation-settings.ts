/**
 * Settings → Automations (docs/automations.md): the facade the desktop
 * surfaces and the Connected Folder–owned Automations routes use, its
 * summaries and run history, and the receipted enable of a stored
 * declaration.
 */

import { randomUUID } from "node:crypto";
import {
  automationCatchUpSentence,
  automationTriggerSummary,
  type AutomationCatchUpReason,
  type FolderAutomationState,
  type FolderAutomationsResponse,
  type FolderAutomationView,
  type AutomationTriggerView,
} from "../../shared/automation-presentation.js";
import { automationTemplateAutomationId, isAutomationTemplateId } from "../../shared/automation-templates.js";
import { automationTemplateDeclaration } from "../automations/automation-templates.js";
import { basename, isAbsolute, resolve } from "node:path";
import { prepareAct } from "../prepared-acts.js";
import {
  assertAmpleFileAutomationAtAdmissionHorizon,
  contentAddressedAmpleFileAutomationDeclaration,
  normalizeAmpleFileAutomationDeclaration,
  normalizeAmpleFileAutomationProposal,
  readAmpleFileAutomationDocument,
  ampleFileAutomationDeclarationKind,
  ampleFileAutomationDigest,
  ampleFileAutomationProposalKind,
  ampleFileAutomationReferencedConnectedFolderIds,
  ampleFileAutomationConnectedFolderRoles,
  type AmpleFileAutomationDeclaration,
} from "../automations/automation-declarations.js";
import { resolveAmpleFileAutomationProposalPath, scanAmpleFileAutomationProposals } from "../automations/automation-proposal-scan.js";
import type { AmpleFileAutomationProjection, AmpleFileAutomationServiceStatus } from "../automations/automation-service.js";
import { ampleFileAgentRoot } from "../state-paths.js";
import type { AmpleFileCliActSurface } from "../cli/act-receipts.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import type { AmpleFileActAutomationReceipt, AmpleFileActAutomationTriggerRef } from "../cli/act-facade.js";
import { getConnectedFolder } from "../connected-folder.js";
import { runActOperation } from "./act-support.js";
import {
  automationReceiptCatchUp,
  readAutomationReceiptProjection,
  readAutomationReceiptProjectionsByAutomation,
  toActAutomationFilesSource,
  toActAutomationTriggerRef,
} from "./automation-receipts.js";
import { errorMessage, match, readJsonBody, sendJson } from "./http.js";
import {
  type AutomationEnableContext,
  preparedActAttribution,
  runDesktopSettingsAct,
  runPreparedActOperation,
} from "./prepared-act-adapters.js";
import type { LocalApiRequest, LocalApiState } from "./state.js";

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
  fileWatch?: import("../automations/automation-file-observer.js").AmpleFileAutomationFileWatchStatus;
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

/** The Automations that name one Connected Folder, and their enable, disable, and run acts. */
export async function handleConnectedFolderAutomationRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // The Connected Folder–owned Automations view (docs/automations.md): a read
  // of the automations that name this Connected Folder, and the same
  // Settings enable/disable/run acts — same facade, same receipts — refused
  // for an automation that does not name it.
  const spaceAutomationsMatch = match(url.pathname, /^\/api\/connected-folders\/([^/]+)\/automations$/);
  if (spaceAutomationsMatch && method === "GET") {
    const connectedFolder = await getConnectedFolder(spaceAutomationsMatch[1]);
    sendJson(res, await createAmpleFileAutomationSettingsFacade(state).forConnectedFolder(connectedFolder.id));
    return true;
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
    return true;
  }
  return false;
}

export function createAmpleFileAutomationSettingsFacade(state: LocalApiState): AmpleFileAutomationSettingsFacade {
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

/**
 * The shared automation enablement door for the act lane and trusted desktop
 * Settings (docs/automations.md): normalize the declaration, check the
 * one-time horizon, verify the pinned digest and that every referenced
 * Connected Folder is registered, then run the `automation.enable` prepared act with the
 * normalized declaration as execution context. Keeping this outside the
 * act-facade closure prevents Settings from growing a second, subtly
 * different enablement path.
 */
export async function enableStoredAutomationDeclaration(
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
export async function readAutomationStagingFile(
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
