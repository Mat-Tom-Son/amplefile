/**
 * Automation refs for the act lane and Settings, and the bounded projection
 * of Automation run receipts read from the act receipts journal.
 */

import { ampleFileAutomationFileObserverBounds } from "../automations/automation-file-observer.js";
import { automationCatchUpReasons, type AutomationCatchUpReason } from "../../shared/automation-presentation.js";
import { readFile } from "node:fs/promises";
import {
  ampleFileAutomationBounds,
  ampleFileAutomationReferencedConnectedFolderIds,
  type AmpleFileAutomationDeclaration,
} from "../automations/automation-declarations.js";
import type { AmpleFileAutomationProjection } from "../automations/automation-service.js";
import {
  ampleFileAutomationReceiptsFile,
  ampleFileAutomationReceiptsRotatedFile,
  type AmpleFileAutomationReceiptV1,
} from "../automations/automation-store.js";
import { AMPLEFILE_CLI_ACT_SURFACES } from "../cli/act-receipts.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import type { AmpleFileActAutomationReceipt, AmpleFileActAutomationSummary, AmpleFileActAutomationTriggerRef } from "../cli/act-facade.js";

export function toActAutomationTriggerRef(trigger: AmpleFileAutomationDeclaration["trigger"]): AmpleFileActAutomationTriggerRef {
  if (trigger.kind === "files-changed") {
    return {
      kind: trigger.kind,
      connectedFolderId: trigger.connectedFolder,
      watch: structuredClone(trigger.watch),
      debounceSeconds: trigger.debounceSeconds,
      cooldownMinutes: trigger.cooldownMinutes,
      ...(trigger.ifMissed !== undefined ? { ifMissed: trigger.ifMissed } : {}),
    };
  }
  if (trigger.kind === "interval") return { kind: "interval", intervalMinutes: trigger.intervalMinutes };
  if (trigger.kind === "at") return { kind: "at", at: trigger.at, ifMissed: trigger.ifMissed };
  return { kind: "manual" };
}

export function toActAutomationSummary(projection: AmpleFileAutomationProjection): AmpleFileActAutomationSummary {
  return {
    automationId: projection.declaration.id,
    title: projection.declaration.title,
    health: projection.health,
    digest: projection.digest,
    trigger: toActAutomationTriggerRef(projection.declaration.trigger),
    ...(projection.fileWatch ? { fileWatch: projection.fileWatch } : {}),
    stepCount: projection.declaration.steps.length,
    referencedConnectedFolderIds: ampleFileAutomationReferencedConnectedFolderIds(projection.declaration),
    ...(projection.health === "enabled" && projection.grants.length > 0
      ? { enabledAt: projection.grants[projection.grants.length - 1]!.enabledAt }
      : {}),
    ...(projection.disabledAt ? { disabledAt: projection.disabledAt } : {}),
    ...(projection.suspension
      ? {
        suspension: {
          at: projection.suspension.at,
          missingConnectedFolderIds: [...projection.suspension.missingConnectedFolderIds],
          reRegisteredConnectedFolderIds: [...projection.suspension.reRegisteredConnectedFolderIds],
        },
      }
      : {}),
    ...(projection.lastScheduledAt ? { lastScheduledAt: projection.lastScheduledAt } : {}),
    ...(projection.nextScheduledAt ? { nextScheduledAt: projection.nextScheduledAt } : {}),
    ...(projection.atOccurrence?.finishedAt
      ? { completedAt: projection.atOccurrence.finishedAt }
      : projection.atOccurrence?.consumedAt
        ? { completedAt: projection.atOccurrence.consumedAt }
        : {}),
  };
}

export function toActAutomationFilesSource(
  source: Extract<AmpleFileAutomationDeclaration["steps"][number], { kind: "files" }>["from"],
): { kind: "paths"; paths: string[] }
  | { kind: "tree"; path: string; recursive: boolean; extensions: string[] }
  | { kind: "step-created-files"; step: string; extensions?: string[]; maxFiles: number; maxTotalBytes: number } {
  if (source.kind === "paths") return { kind: "paths", paths: [...source.paths] };
  if (source.kind === "tree") return { kind: "tree", path: source.path, recursive: source.recursive, extensions: [...source.extensions] };
  return {
    kind: "step-created-files",
    step: source.step,
    ...(source.extensions ? { extensions: [...source.extensions] } : {}),
    maxFiles: source.maxFiles,
    maxTotalBytes: source.maxTotalBytes,
  };
}

const automationReceiptProjectionLimit = 500;
const automationReceiptTextLimit = 4_096;
const automationReceiptListLimit = 128;

export async function readAutomationReceiptProjection(automationId?: string): Promise<{
  receipts: AmpleFileActAutomationReceipt[];
  truncated: boolean;
  damagedLineCount: number;
}> {
  const matching: AmpleFileActAutomationReceipt[] = [];
  const damagedLineCount = await visitAutomationReceipts((projected) => {
    if (automationId === undefined || projected.automationId === automationId) matching.push(projected);
  });
  return {
    receipts: matching.slice(-automationReceiptProjectionLimit).reverse(),
    truncated: matching.length > automationReceiptProjectionLimit,
    damagedLineCount,
  };
}

export async function readAutomationReceiptProjectionsByAutomation(): Promise<{
  receipts: AmpleFileActAutomationReceipt[];
  truncated: boolean;
  damagedLineCount: number;
}> {
  const matchingByAutomation = new Map<string, AmpleFileActAutomationReceipt[]>();
  let truncated = false;
  const damagedLineCount = await visitAutomationReceipts((projected) => {
    const bucket = matchingByAutomation.get(projected.automationId) ?? [];
    bucket.push(projected);
    if (bucket.length > automationReceiptProjectionLimit) {
      bucket.shift();
      truncated = true;
    }
    matchingByAutomation.set(projected.automationId, bucket);
  });
  return {
    receipts: [...matchingByAutomation.values()].flat().sort((left, right) => Date.parse(right.at) - Date.parse(left.at)),
    truncated,
    damagedLineCount,
  };
}

async function visitAutomationReceipts(visitor: (receipt: AmpleFileActAutomationReceipt) => void): Promise<number> {
  let damagedLineCount = 0;
  for (const path of [ampleFileAutomationReceiptsRotatedFile(), ampleFileAutomationReceiptsFile()]) {
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AmpleFileCliError("failure", "AmpleFile could not read the automation run history.", { cause: error });
    });
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        damagedLineCount += 1;
        continue;
      }
      const projected = projectAutomationReceipt(parsed);
      if (!projected) {
        damagedLineCount += 1;
        continue;
      }
      visitor(projected);
    }
  }
  return damagedLineCount;
}

function projectAutomationReceipt(value: unknown): AmpleFileActAutomationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Partial<AmpleFileAutomationReceiptV1>;
  const at = automationReceiptTimestamp(receipt.at);
  const automationId = automationReceiptText(receipt.automationId);
  const outcome = automationReceiptText(receipt.outcome);
  if (!at || !automationId || !outcome || (receipt.scope !== "automation" && receipt.scope !== "run" && receipt.scope !== "hop")) {
    return null;
  }
  const projected: AmpleFileActAutomationReceipt = { at, scope: receipt.scope, outcome, automationId };
  const addText = (key: keyof AmpleFileActAutomationReceipt, candidate: unknown) => {
    const text = automationReceiptText(candidate);
    if (text !== undefined) (projected as unknown as Record<string, unknown>)[key] = text;
  };
  addText("runId", receipt.runId);
  addText("hopId", receipt.hopId);
  // Lines an earlier build wrote may name a `check` hop; it is not projected.
  if (receipt.hopKind === "chat" || receipt.hopKind === "files" || receipt.hopKind === "agent") {
    projected.hopKind = receipt.hopKind;
  }
  addText("title", receipt.title);
  addText("digest", receipt.digest);
  addText("detail", receipt.detail);
  if (receipt.partial === true && outcome === "succeeded") projected.partial = true;
  const cause = projectAutomationReceiptCause(receipt.cause);
  if (cause !== undefined) projected.cause = cause;
  addText("connectedFolderId", receipt.connectedFolderId);
  addText("fromConnectedFolderId", receipt.fromConnectedFolderId);
  addText("toConnectedFolderId", receipt.toConnectedFolderId);
  addText("conversationId", receipt.conversationId);
  addText("taskId", receipt.taskId);
  addText("restorePointId", receipt.restorePointId);
  addText("failedHopId", receipt.failedHopId);
  addText("surface", receipt.surface);
  addText("requestId", receipt.requestId);
  addText("occurrenceId", receipt.occurrenceId);
  addText("scheduledRunId", receipt.scheduledRunId);
  const addList = (key: keyof AmpleFileActAutomationReceipt, candidate: unknown) => {
    const list = automationReceiptTextList(candidate);
    if (list !== undefined) (projected as unknown as Record<string, unknown>)[key] = list;
  };
  addList("checkpointIds", receipt.checkpointIds);
  addList("sourcePaths", receipt.sourcePaths);
  addList("copiedPaths", receipt.copiedPaths);
  addList("stoppedHopTaskIds", receipt.stoppedHopTaskIds);
  addList("missingConnectedFolderIds", receipt.missingConnectedFolderIds);
  const addCount = (key: keyof AmpleFileActAutomationReceipt, candidate: unknown) => {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      (projected as unknown as Record<string, unknown>)[key] = Math.floor(candidate);
    }
  };
  addCount("fileCount", receipt.fileCount);
  addCount("totalBytes", receipt.totalBytes);
  addCount("messageBytes", receipt.messageBytes);
  const placeholders = projectAutomationReceiptPlaceholders(receipt.placeholders);
  if (placeholders) projected.placeholders = placeholders;
  return projected;
}

/**
 * What AmpleFile filled into a hop's message, bounded exactly as the executor
 * bounded it. Text keeps its newlines — it is a list — so it is length-bounded
 * rather than run through the single-line text projector.
 */
function projectAutomationReceiptPlaceholders(
  value: unknown,
): Array<{ name: string; text: string; bytes: number; truncated: boolean }> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const projected: Array<{ name: string; text: string; bytes: number; truncated: boolean }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const placeholder = entry as Record<string, unknown>;
    const name = automationReceiptText(placeholder.name);
    if (!name || name.length > 128) return undefined;
    if (typeof placeholder.text !== "string" || placeholder.text.length > ampleFileAutomationBounds.maxPlaceholderTextBytes) {
      return undefined;
    }
    if (!Number.isSafeInteger(placeholder.bytes) || (placeholder.bytes as number) < 0) return undefined;
    if (typeof placeholder.truncated !== "boolean") return undefined;
    projected.push({
      name,
      text: placeholder.text,
      bytes: placeholder.bytes as number,
      truncated: placeholder.truncated,
    });
  }
  return projected;
}

function projectAutomationReceiptCause(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cause = value as Record<string, unknown>;
  if ((cause.kind === "scheduled" || cause.kind === "resume") && automationReceiptTimestamp(cause.slotAt)) {
    return { kind: cause.kind, slotAt: automationReceiptTimestamp(cause.slotAt)! };
  }
  // A live change and a catch-up both list at most the observer's files on
  // each side of the comparison, so the true count never exceeds twice that.
  if (cause.kind === "files-changed" && typeof cause.snapshotDigest === "string" && /^[a-f0-9]{64}$/.test(cause.snapshotDigest) && Number.isSafeInteger(cause.changedCount) && (cause.changedCount as number) > 0 && (cause.changedCount as number) <= 2 * ampleFileAutomationFileObserverBounds.maxFiles && automationReceiptText(cause.connectedFolderId)) {
    const changedPaths = automationReceiptTextList(cause.changedPaths);
    const catchUp = automationReceiptCatchUp(cause.catchUp, cause.changedCount as number);
    return {
      kind: cause.kind,
      connectedFolderId: automationReceiptText(cause.connectedFolderId),
      snapshotDigest: cause.snapshotDigest,
      changedCount: cause.changedCount,
      ...(changedPaths?.length ? { changedPaths } : {}),
      ...(catchUp ? { catchUp } : {}),
    };
  }
  if (cause.kind === "run-now") {
    const surface = typeof cause.surface === "string" && AMPLEFILE_CLI_ACT_SURFACES.includes(cause.surface as never)
      ? cause.surface
      : undefined;
    return {
      kind: "run-now",
      ...(automationReceiptText(cause.requestId) ? { requestId: automationReceiptText(cause.requestId) } : {}),
      ...(surface ? { surface } : {}),
    };
  }
  // An `on-settled` cause older builds wrote (a Check run or a Connected
  // Folder app's automation settling) is not projected.
  return undefined;
}

function automationReceiptText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > automationReceiptTextLimit) return undefined;
  if (/\p{Cc}|\p{Cf}/u.test(value)) return undefined;
  return value;
}

function automationReceiptTimestamp(value: unknown): string | undefined {
  const text = automationReceiptText(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : undefined;
}

/** A recorded catch-up, or undefined when the field is absent or not the closed shape. */
export function automationReceiptCatchUp(value: unknown, changedCount: number): { reason: AutomationCatchUpReason; count: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { reason, count } = value as Record<string, unknown>;
  if (typeof reason !== "string" || !(automationCatchUpReasons as readonly string[]).includes(reason)) return undefined;
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > changedCount) return undefined;
  return { reason: reason as AutomationCatchUpReason, count: count as number };
}

function automationReceiptTextList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > automationReceiptListLimit) return undefined;
  const values = value.map(automationReceiptText);
  return values.every((item): item is string => item !== undefined) ? values : undefined;
}
