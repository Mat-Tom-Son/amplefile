import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeFolderTargetPath } from "../../shared/folder-target-path.js";
import { ampleFileAutomationDeclarationBounds } from "../../shared/amplefile-limits.js";
import { folderAutomationRoles, type FolderAutomationRole } from "../../shared/automation-presentation.js";
import { restrictedAppAutomationIntervalMinutes } from "../agent/restricted-app-manifest.js";
import { stableJsonDigest } from "./stable-json-digest.js";

/**
 * Automation declarations are closed, typed, machine-local data: a declared
 * trigger plus deterministic steps that move work
 * between Connected Folders. They carry no prompts beyond the literal chat- and
 * agent-step message plus a closed set of host-filled placeholders, no
 * instructions, no source code, no shell commands, no model names, no
 * credentials, no connection data, and no expressions — the closed field
 * vocabulary here is the enforcement. Parsing fails closed on unknown kinds,
 * versions, fields, placeholders, and every bound in the automations bounds
 * table; the automation store records an exact-digest enablement receipt over
 * whatever a parse produces.
 */
export const ampleFileAutomationProposalKind = "amplefile.automation-proposal" as const;
export const ampleFileAutomationDeclarationKind = "amplefile.automation" as const;
export const ampleFileAutomationContractVersion = 6 as const;
/**
 * Version 6 (2026-11-07) lets a folder-change trigger watch the Connected Folder's
 * own top level, `"path": ""` without recursion, for the file manager's
 * ready-made Automations (Organize New Files, docs/automations.md).
 */
export const ampleFileAutomationSupportedContractVersions = [1, 2, 3, 4, 5, ampleFileAutomationContractVersion] as const;
export type AmpleFileAutomationContractVersion = (typeof ampleFileAutomationSupportedContractVersions)[number];

/** Filename convention for inert automation proposals in the AmpleFile agent's working folder. */
export const ampleFileAutomationProposalFileSuffix = ".amplefile-automation.json" as const;

/**
 * Every declaration bound, enforced at parse and re-enforced by the executor.
 * The values are inherited from contracts this codebase already proves rather
 * than invented here: the interval reuses the restricted-app automation
 * cadence, exact source paths mirror the act lane's `files add` bound
 * (`maxActFromPaths` in src/local/cli/act-commands.ts), and created-files
 * handoffs may tighten but never widen the folder target resolver's hard
 * limits (src/local/automations/folder-targets.ts).
 */
export const ampleFileAutomationBounds = Object.freeze({
  ...ampleFileAutomationDeclarationBounds,
  minIntervalMinutes: restrictedAppAutomationIntervalMinutes.minimum,
  maxIntervalMinutes: restrictedAppAutomationIntervalMinutes.maximum,
  maxHandoffFiles: 100_000,
  maxHandoffTotalBytes: 64 * 1024 * 1024 * 1024,
});

/**
 * Automation-run settles an on-settled trigger may admit. `skipped` and
 * `cancelled` are never admissible — they are lifecycle artifacts of
 * non-overlap, suspension, and revocation, and chaining on them oscillates.
 */
export const ampleFileAutomationAppAutomationRunOutcomes = ["failure", "success"] as const;
export type AmpleFileAutomationAppAutomationRunOutcome = (typeof ampleFileAutomationAppAutomationRunOutcomes)[number];

export interface AmpleFileAutomationAppAutomationRunSettleSource {
  kind: "app-automation-run";
  connectedFolder: string;
  appId: string;
  appAutomationId: string;
  outcomes: AmpleFileAutomationAppAutomationRunOutcome[];
}

export type AmpleFileAutomationSettleSource = AmpleFileAutomationAppAutomationRunSettleSource;

/** Run-now only; every enabled automation additionally accepts manual run-now. */
export interface AmpleFileAutomationManualTrigger {
  kind: "manual";
}

export interface AmpleFileAutomationIntervalTrigger {
  kind: "interval";
  intervalMinutes: number;
}

export interface AmpleFileAutomationAtTrigger {
  kind: "at";
  /** Canonical absolute time; proposal input must name an explicit offset. */
  at: string;
  ifMissed: "run" | "skip";
}

export interface AmpleFileAutomationOnSettledTrigger {
  kind: "on-settled";
  source: AmpleFileAutomationSettleSource;
}

export interface AmpleFileAutomationFilesChangedTrigger {
  kind: "files-changed";
  connectedFolder: string;
  watch: AmpleFileAutomationTreeSource;
  debounceSeconds: number;
  cooldownMinutes: number;
  /**
   * Version 5. `"run"` keeps a machine-local metadata snapshot of the watched
   * files and, after AmpleFile was closed, asleep, turned off, or unable to
   * watch the folder, starts one run for the files added or changed in that
   * gap. Absent or `"skip"` keeps the original behavior: a fresh baseline
   * after every gap. Absent stays absent, so older declarations keep their
   * digests.
   */
  ifMissed?: "run" | "skip";
}

export type AmpleFileAutomationTrigger =
  | AmpleFileAutomationManualTrigger
  | AmpleFileAutomationIntervalTrigger
  | AmpleFileAutomationAtTrigger
  | AmpleFileAutomationOnSettledTrigger
  | AmpleFileAutomationFilesChangedTrigger;

/**
 * Starts a new conversation in the named Connected Folder with exactly this message,
 * sent with no ambient additions beyond the closed placeholder set.
 */
export interface AmpleFileAutomationChatStep {
  id: string;
  kind: "chat";
  connectedFolder: string;
  message: string;
  /** The model this step's new Chat uses, instead of the Connected Folder's own (version 4, 2026-10-11). */
  model?: AmpleFileAutomationStepModel;
}

/**
 * A model named by provider and id, as Settings → AI Models lists them. It
 * applies only to the Chat the step starts; nothing else's model changes.
 */
export interface AmpleFileAutomationStepModel {
  provider: string;
  id: string;
}

export interface AmpleFileAutomationExactPathsSource {
  kind: "paths";
  paths: string[];
}

/** The bounded tree selector, resolved by the folder target resolver (src/local/automations/folder-targets.ts). */
export interface AmpleFileAutomationTreeSource {
  kind: "tree";
  path: string;
  recursive: boolean;
  extensions: string[];
}

/**
 * The declared created-files handoff: the files an earlier chat step's turn
 * added or changed, resolved host-side from that turn's own History
 * checkpoint pair. Bounds are mandatory in the declaration.
 */
export interface AmpleFileAutomationStepCreatedFilesSource {
  kind: "step-created-files";
  step: string;
  extensions?: string[];
  maxFiles: number;
  maxTotalBytes: number;
}

export type AmpleFileAutomationFilesSource =
  | AmpleFileAutomationExactPathsSource
  | AmpleFileAutomationTreeSource
  | AmpleFileAutomationStepCreatedFilesSource;

/** Copies additively from one Connected Folder into another; an automation never moves, renames, or deletes. */
export interface AmpleFileAutomationFilesStep {
  id: string;
  kind: "files";
  fromConnectedFolder: string;
  from: AmpleFileAutomationFilesSource;
  toConnectedFolder: string;
  to: string;
}

/**
 * Starts a new AmpleFile agent chat with exactly this message, so a person
 * can put the AmpleFile agent on a cadence deliberately. It names no
 * Connected Folder: the AmpleFile agent sits above them. Version 4 only.
 */
export interface AmpleFileAutomationAgentStep {
  id: string;
  kind: "agent";
  message: string;
  /** The model this step's new AmpleFile agent chat uses, instead of the agent's own (2026-10-11). */
  model?: AmpleFileAutomationStepModel;
}

export type AmpleFileAutomationStep =
  | AmpleFileAutomationChatStep
  | AmpleFileAutomationFilesStep
  | AmpleFileAutomationAgentStep;

/** The closed set of trigger placeholders a version-4 message may carry. */
export const ampleFileAutomationTriggerPlaceholders = [
  "trigger.summary",
  "trigger.changedFiles",
] as const;
export type AmpleFileAutomationTriggerPlaceholder = (typeof ampleFileAutomationTriggerPlaceholders)[number];

/** One `{{…}}` occurrence: a trigger name, or an earlier chat step's created files. */
export interface AmpleFileAutomationPlaceholder {
  name: AmpleFileAutomationTriggerPlaceholder | string;
  /** Present only for `steps.<id>.createdFiles`. */
  step?: string;
}

const createdFilesPlaceholderPattern = /^steps\.([a-z0-9][a-z0-9-]{0,63})\.createdFiles$/;
const placeholderOccurrencePattern = /\{\{([^{}]*)\}\}/g;

/**
 * Every `{{…}}` occurrence in a version-4 chat- or agent-step message, in
 * message order and with duplicates kept. The set is closed: anything else
 * inside braces is a declaration error, so nothing an automation sends can ever
 * interpolate something the person did not read. Versions 1–3 never reach
 * here — their messages are literal text, braces included.
 */
export function ampleFileAutomationMessagePlaceholders(
  message: string,
  label = "This automation step",
): AmpleFileAutomationPlaceholder[] {
  const placeholders: AmpleFileAutomationPlaceholder[] = [];
  for (const match of message.matchAll(placeholderOccurrencePattern)) {
    const name = (match[1] ?? "").trim();
    if ((ampleFileAutomationTriggerPlaceholders as readonly string[]).includes(name)) {
      placeholders.push({ name });
      continue;
    }
    const created = createdFilesPlaceholderPattern.exec(name);
    if (created) {
      placeholders.push({ name, step: created[1]! });
      continue;
    }
    throw new Error(
      `${label} message uses an unknown placeholder ${match[0]}. The placeholders are `
        + "{{trigger.summary}}, {{trigger.changedFiles}}, and {{steps.<id>.createdFiles}}.",
    );
  }
  return placeholders;
}

export interface AmpleFileAutomationDefinition {
  title: string;
  trigger: AmpleFileAutomationTrigger;
  steps: AmpleFileAutomationStep[];
}

export interface AmpleFileAutomationProposal {
  kind: typeof ampleFileAutomationProposalKind;
  version: AmpleFileAutomationContractVersion;
  name: string;
  createdBy: "human" | "assistant" | "codex" | "claude-code" | "other";
  createdAt: string;
  automation: AmpleFileAutomationDefinition;
}

export interface AmpleFileAutomationDeclaration extends AmpleFileAutomationDefinition {
  kind: typeof ampleFileAutomationDeclarationKind;
  version: AmpleFileAutomationContractVersion;
  id: string;
  createdBy: AmpleFileAutomationProposal["createdBy"];
  createdAt: string;
}

/** Room for the largest step messages a declaration may carry. */
export const ampleFileAutomationDocumentMaxBytes = 64 * 1024 * 1024;

// Mirrors isConnectedFolderId in src/local/connected-folder.ts: automations pin
// Connected Folders by stable registered Connected Folder id, never by name or path. The
// CLI may resolve an exact name for convenience, but the stored declaration
// records ids only.
const connectedFolderIdPattern = /^space-[a-f0-9]{16}$/;
const automationIdPattern = /^automation-[a-z0-9][a-z0-9-]{7,154}$/;
// Mirrors the restricted-app manifest id rule for app and automation ids.
const restrictedAppIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const stepIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const extensionPattern = /^\.[a-z0-9][a-z0-9._+-]*$/;
/**
 * Tabs and newlines are ordinary message text; other C0/C1 controls and
 * bidirectional overrides are never allowed in an automation message.
 *
 * The one character rule for anything that becomes an automation message. A
 * declared message is refused outright when it carries these; filled-in
 * placeholder text is host-supplied and cannot be refused at declaration
 * time, so the executor replaces the same characters before substitution
 * (src/local/automations/automation-service.ts). Both go through this class so the
 * hop receipt records exactly the text the destination received.
 */
export const ampleFileAutomationForbiddenMessageCharacters = "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069";
const forbiddenMessageCharacters = new RegExp(`[${ampleFileAutomationForbiddenMessageCharacters}]`);

/** Replaces every forbidden message character; the result is safe to substitute and to record. */
export function scrubAmpleFileAutomationMessageText(value: string): string {
  return value.replace(new RegExp(`[${ampleFileAutomationForbiddenMessageCharacters}]`, "gu"), "\uFFFD");
}

const inadmissibleOutcomeReasons = new Map<string, string>([
  ["interrupted", "it records a crashed run, not a result"],
  ["skipped", "it is a lifecycle artifact of non-overlap and suspension"],
  ["cancelled", "it is a lifecycle artifact of shutdown and revocation"],
]);

export function normalizeAmpleFileAutomationProposal(value: unknown): AmpleFileAutomationProposal {
  const record = objectRecord(value, "Automation proposal must be a JSON object.");
  assertKeys(record, ["kind", "version", "name", "createdBy", "createdAt", "automation"], [], "Automation proposal");
  if (record.kind !== ampleFileAutomationProposalKind) throw new Error(`Automation proposal kind must be ${ampleFileAutomationProposalKind}.`);
  const version = contractVersion(record.version, "Automation proposal");
  return {
    kind: ampleFileAutomationProposalKind,
    version,
    name: boundedText(record.name, "Automation proposal name", 120),
    createdBy: normalizeCreator(record.createdBy),
    createdAt: isoTimestamp(record.createdAt, "Automation proposal createdAt"),
    automation: normalizeAutomationDefinition(record.automation, version),
  };
}

export function normalizeAmpleFileAutomationDeclaration(value: unknown): AmpleFileAutomationDeclaration {
  const record = objectRecord(value, "Automation declaration must be a JSON object.");
  assertKeys(
    record,
    ["kind", "version", "id", "title", "trigger", "steps", "createdBy", "createdAt"],
    [],
    "Automation declaration",
  );
  if (record.kind !== ampleFileAutomationDeclarationKind) throw new Error(`Automation declaration kind must be ${ampleFileAutomationDeclarationKind}.`);
  const version = contractVersion(record.version, "Automation declaration");
  return {
    kind: ampleFileAutomationDeclarationKind,
    version,
    id: automationId(record.id),
    ...normalizeAutomationDefinition({ title: record.title, trigger: record.trigger, steps: record.steps }, version),
    createdBy: normalizeCreator(record.createdBy),
    createdAt: isoTimestamp(record.createdAt, "Automation declaration createdAt"),
  };
}

export function declarationFromAmpleFileAutomationProposal(
  proposal: AmpleFileAutomationProposal,
  id = `automation-${randomUUID()}`,
): AmpleFileAutomationDeclaration {
  return normalizeAmpleFileAutomationDeclaration({
    kind: ampleFileAutomationDeclarationKind,
    version: proposal.version,
    id,
    ...proposal.automation,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
  });
}

/**
 * The declaration a proposal enables as: a deterministic content-derived
 * automation id, so identical proposal content always names one automation. The
 * CLI's `automations enable --proposal` and Settings' pending-proposal scan both
 * go through this, so a scanned file's digest is exactly what enabling it pins.
 */
export function contentAddressedAmpleFileAutomationDeclaration(
  proposal: AmpleFileAutomationProposal,
): { declaration: AmpleFileAutomationDeclaration; digest: string } {
  const contentId = `automation-${ampleFileAutomationDigest(proposal).slice(0, 16)}`;
  const declaration = declarationFromAmpleFileAutomationProposal(proposal, contentId);
  return { declaration, digest: ampleFileAutomationDigest(declaration) };
}

/**
 * The digest that pins an automation: enablement records an exact-authority grant
 * over it, receipts carry it, and any edit changes it — an edited automation
 * never coasts on a stale approval. Canonicalization is stable JSON
 * (src/local/automations/stable-json-digest.ts), so field order can never
 * change authority. Stored automations are re-verified against it on load:
 * its output must never change.
 */
export function ampleFileAutomationDigest(value: unknown): string {
  return stableJsonDigest(value);
}

/**
 * Features a stored automation may still name from before they were removed
 * (Checks, 2026-11-07). The parser refuses them; the automation store drops a
 * stored automation that uses one on its own instead of treating the whole
 * store as damaged (src/local/automations/automation-store.ts).
 */
const retiredAutomationFeatureReasons = Object.freeze({
  checkStep: "it runs a Check, and AmpleFile no longer has Checks",
  checkRunTrigger: "it waits for a Check run, and AmpleFile no longer has Checks",
  findingsPlaceholder: "its message fills in {{trigger.findings}} from a Check run, and AmpleFile no longer has Checks",
});

/**
 * Why a stored declaration names a retired feature, or null. It reads the
 * raw stored JSON and validates nothing else, so a declaration that is
 * invalid for any other reason still reports as invalid. Versions 1–3 send
 * their messages as literal text, so only version 4 and later can carry the
 * retired placeholder.
 */
export function ampleFileAutomationRetiredFeature(value: unknown): string | null {
  if (!isJsonObject(value)) return null;
  const trigger = value.trigger;
  if (isJsonObject(trigger) && trigger.kind === "on-settled" && isJsonObject(trigger.source) && trigger.source.kind === "check-run") {
    return retiredAutomationFeatureReasons.checkRunTrigger;
  }
  const steps = Array.isArray(value.steps) ? value.steps.filter(isJsonObject) : [];
  if (steps.some((step) => step.kind === "check")) return retiredAutomationFeatureReasons.checkStep;
  if (typeof value.version !== "number" || value.version < 4) return null;
  for (const step of steps) {
    if ((step.kind !== "chat" && step.kind !== "agent") || typeof step.message !== "string") continue;
    for (const match of step.message.matchAll(placeholderOccurrencePattern)) {
      if ((match[1] ?? "").trim() === "trigger.findings") return retiredAutomationFeatureReasons.findingsPlaceholder;
    }
  }
  return null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every Connected Folder an automation names, across its trigger source and all steps,
 * sorted and deduplicated. Removing any of them revokes the enablement grant
 * and suspends the automation.
 */
/** True when a folder-change trigger declares the version-5 catch-up. */
export function ampleFileAutomationTriggerCatchesUp(
  trigger: AmpleFileAutomationTrigger,
): trigger is AmpleFileAutomationFilesChangedTrigger & { ifMissed: "run" } {
  return trigger.kind === "files-changed" && trigger.ifMissed === "run";
}

export function ampleFileAutomationReferencedConnectedFolderIds(definition: AmpleFileAutomationDefinition): string[] {
  const ids = new Set<string>();
  if (definition.trigger.kind === "files-changed") ids.add(definition.trigger.connectedFolder);
  if (definition.trigger.kind === "on-settled") ids.add(definition.trigger.source.connectedFolder);
  for (const step of definition.steps) {
    if (step.kind === "files") {
      ids.add(step.fromConnectedFolder);
      ids.add(step.toConnectedFolder);
    } else if (step.kind === "chat") {
      ids.add(step.connectedFolder);
    }
    // An agent step names no work-folder: the work-fold agent sits above them.
  }
  return [...ids].sort();
}

/**
 * What this automation does in one Connected Folder, derived from the declaration alone:
 * the trigger watches it (a folder change, or an app automation settling
 * there), a files step copies into or out of it, a chat step starts a
 * conversation there. Empty exactly when
 * `ampleFileAutomationReferencedConnectedFolderIds` does not name the Connected Folder.
 */
export function ampleFileAutomationConnectedFolderRoles(definition: AmpleFileAutomationDefinition, connectedFolderId: string): FolderAutomationRole[] {
  const roles = new Set<FolderAutomationRole>();
  if (definition.trigger.kind === "files-changed" && definition.trigger.connectedFolder === connectedFolderId) roles.add("watches");
  if (definition.trigger.kind === "on-settled" && definition.trigger.source.connectedFolder === connectedFolderId) roles.add("watches");
  for (const step of definition.steps) {
    if (step.kind === "files") {
      if (step.toConnectedFolder === connectedFolderId) roles.add("copies-to");
      if (step.fromConnectedFolder === connectedFolderId) roles.add("copies-from");
    } else if (step.kind === "chat" && step.connectedFolder === connectedFolderId) {
      roles.add("chats-here");
    }
  }
  return folderAutomationRoles.filter((role) => roles.has(role));
}

/**
 * Rechecks the time-sensitive one-time horizon when the automation is enabled.
 * The declaration parser validates only the stable shape because a stored
 * inert proposal must not become syntactically damaged merely as time passes.
 */
export function assertAmpleFileAutomationAtAdmissionHorizon(
  definition: Pick<AmpleFileAutomationDefinition, "trigger">,
  now: Date,
): void {
  if (definition.trigger.kind !== "at") return;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Automation admission time is invalid.");
  const advanceMs = Date.parse(definition.trigger.at) - nowMs;
  if (advanceMs < ampleFileAutomationBounds.minAtAdvanceMs || advanceMs > ampleFileAutomationBounds.maxAtAdvanceMs) {
    throw new Error("Automation one-time trigger must be in the future, and at most ten years ahead, when it is enabled.");
  }
}

export async function readAmpleFileAutomationProposal(path: string): Promise<AmpleFileAutomationProposal> {
  const resolved = resolve(path);
  return normalizeAmpleFileAutomationProposal(JSON.parse(await readAmpleFileAutomationDocument(resolved)));
}

function normalizeAutomationDefinition(value: unknown, version: AmpleFileAutomationContractVersion): AmpleFileAutomationDefinition {
  const record = objectRecord(value, "Automation definition must be a JSON object.");
  assertKeys(record, ["title", "trigger", "steps"], [], "Automation definition");
  if (!Array.isArray(record.steps) || record.steps.length < 1) {
    throw new Error("Automation steps must contain at least one step.");
  }
  const trigger = normalizeTrigger(record.trigger, version);
  const steps = record.steps.map((step, index) => normalizeStep(step, index, version));
  const positions = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (positions.has(step.id)) throw new Error(`Automation steps contain duplicate id "${step.id}".`);
    positions.set(step.id, index);
  }
  for (const [index, step] of steps.entries()) {
    if (step.kind !== "files" || step.from.kind !== "step-created-files") continue;
    const label = `Automation step "${step.id}"`;
    const sourceIndex = positions.get(step.from.step);
    if (sourceIndex === undefined) throw new Error(`${label} names unknown source step "${step.from.step}".`);
    if (sourceIndex >= index) {
      throw new Error(`${label} must take created files from an earlier step; self and forward references would make the automation cyclic.`);
    }
    const source = steps[sourceIndex]!;
    if (source.kind !== "chat") throw new Error(`${label} must take created files from an earlier chat step.`);
    if (source.connectedFolder !== step.fromConnectedFolder) {
      throw new Error(`${label} must copy from Connected Folder ${source.connectedFolder}, where its source chat step runs.`);
    }
  }
  if (version >= 4) assertPlaceholdersResolvable(steps, positions, trigger);
  return {
    title: boundedText(record.title, "Automation title", 160),
    trigger,
    steps,
  };
}

/**
 * A placeholder that could never be filled in for the declared trigger — or
 * that names a step whose created files no run can know — is a declaration
 * error, refused when the automation is enabled rather than discovered as an
 * empty sentence in a message a Worker already received.
 */
function assertPlaceholdersResolvable(
  steps: AmpleFileAutomationStep[],
  positions: Map<string, number>,
  trigger: AmpleFileAutomationTrigger,
): void {
  for (const [index, step] of steps.entries()) {
    if (step.kind !== "chat" && step.kind !== "agent") continue;
    const label = `Automation step "${step.id}"`;
    for (const placeholder of ampleFileAutomationMessagePlaceholders(step.message, label)) {
      if (placeholder.name === "trigger.changedFiles" && trigger.kind !== "files-changed") {
        throw new Error(`${label} uses {{trigger.changedFiles}}, but the trigger is not a folder-change trigger.`);
      }
      if (placeholder.step === undefined) continue;
      const sourceIndex = positions.get(placeholder.step);
      const source = sourceIndex === undefined ? undefined : steps[sourceIndex];
      if (sourceIndex === undefined || sourceIndex >= index || source?.kind !== "chat") {
        throw new Error(
          `${label} uses {{steps.${placeholder.step}.createdFiles}}, but "${placeholder.step}" `
            + "is not an earlier chat step in this automation.",
        );
      }
    }
  }
}

function normalizeTrigger(value: unknown, version: AmpleFileAutomationContractVersion): AmpleFileAutomationTrigger {
  const record = objectRecord(value, "Automation trigger must be a JSON object.");
  if (record.kind === "manual") {
    assertKeys(record, ["kind"], [], "Automation manual trigger");
    return { kind: "manual" };
  }
  if (record.kind === "interval") {
    assertKeys(record, ["kind", "intervalMinutes"], [], "Automation interval trigger");
    return {
      kind: "interval",
      intervalMinutes: boundedInteger(
        record.intervalMinutes,
        "Automation interval minutes",
        ampleFileAutomationBounds.minIntervalMinutes,
        ampleFileAutomationBounds.maxIntervalMinutes,
      ),
    };
  }
  if (record.kind === "at") {
    if (version < 2) throw new Error("Automation one-time triggers require contract version 2.");
    assertKeys(record, ["kind", "at", "ifMissed"], [], "Automation one-time trigger");
    if (record.ifMissed !== "run" && record.ifMissed !== "skip") {
      throw new Error('Automation one-time trigger ifMissed must be "run" or "skip".');
    }
    return {
      kind: "at",
      at: explicitOffsetTimestamp(record.at, "Automation one-time trigger at"),
      ifMissed: record.ifMissed,
    };
  }
  if (record.kind === "files-changed") {
    if (version < 3) throw new Error("folder-change triggers require contract version 3.");
    assertKeys(record, ["kind", "connectedFolder", "watch", "debounceSeconds", "cooldownMinutes"], ["ifMissed"], "folder-change trigger");
    if (record.ifMissed !== undefined) {
      if (version < 5) throw new Error("A folder-change trigger's ifMissed requires contract version 5.");
      if (record.ifMissed !== "run" && record.ifMissed !== "skip") {
        throw new Error('folder-change trigger ifMissed must be "run" or "skip".');
      }
    }
    const watch = normalizeWatchedFolder(record.watch, version);
    if (watch.kind !== "tree") throw new Error("A folder-change trigger requires one bounded folder selector.");
    return { kind: "files-changed", connectedFolder: connectedFolderId(record.connectedFolder, "Watched Connected Folder"), watch,
      debounceSeconds: boundedInteger(record.debounceSeconds, "folder-change debounce seconds", 1, 3_600),
      cooldownMinutes: boundedInteger(record.cooldownMinutes, "folder-change cooldown minutes", 0, 10_080),
      ...(record.ifMissed !== undefined ? { ifMissed: record.ifMissed as "run" | "skip" } : {}) };
  }
  if (record.kind === "on-settled") {
    assertKeys(record, ["kind", "source"], [], "Automation on-settled trigger");
    return { kind: "on-settled", source: normalizeSettleSource(record.source) };
  }
  throw new Error(version >= 3 ? "Automation trigger kind must be manual, interval, at, on-settled, or files-changed." : version >= 2
    ? "Automation trigger kind must be manual, interval, at, or on-settled."
    : "Automation trigger kind must be manual, interval, or on-settled.");
}

function normalizeSettleSource(value: unknown): AmpleFileAutomationSettleSource {
  const record = objectRecord(value, "Automation trigger source must be a JSON object.");
  if (record.kind === "check-run") {
    throw new Error(`Automation trigger source kind check-run is retired: ${retiredAutomationFeatureReasons.checkRunTrigger}.`);
  }
  if (record.kind === "app-automation-run") {
    assertKeys(record, ["kind", "connectedFolder", "appId", "appAutomationId"], ["outcomes"], "Automation app-automation-run trigger source");
    return {
      kind: "app-automation-run",
      connectedFolder: connectedFolderId(record.connectedFolder, "Automation app-automation-run trigger source Connected Folder"),
      appId: restrictedAppId(record.appId, "Automation app-automation-run trigger source appId"),
      appAutomationId: restrictedAppId(record.appAutomationId, "Automation app-automation-run trigger source automationId"),
      outcomes: normalizeOutcomes(record.outcomes, "Automation app-automation-run trigger source", ampleFileAutomationAppAutomationRunOutcomes, ["success"]),
    };
  }
  throw new Error("Automation trigger source kind must be app-automation-run.");
}

function normalizeStep(value: unknown, index: number, version: AmpleFileAutomationContractVersion): AmpleFileAutomationStep {
  const label = `Automation step ${index + 1}`;
  const record = objectRecord(value, `${label} must be a JSON object.`);
  if (record.kind === "chat") {
    assertKeys(record, ["id", "kind", "connectedFolder", "message"], ["model"], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "chat",
      connectedFolder: connectedFolderId(record.connectedFolder, `${label} Connected Folder`),
      message: boundedMessage(record.message, `${label} message`),
      ...(record.model !== undefined ? { model: stepModel(record.model, `${label} model`) } : {}),
    };
  }
  if (record.kind === "files") {
    assertKeys(record, ["id", "kind", "fromConnectedFolder", "from", "toConnectedFolder", "to"], [], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "files",
      fromConnectedFolder: connectedFolderId(record.fromConnectedFolder, `${label} fromConnectedFolder`),
      from: normalizeFilesSource(record.from, label),
      toConnectedFolder: connectedFolderId(record.toConnectedFolder, `${label} toConnectedFolder`),
      to: normalizeFolderTargetPath(record.to, `${label} destination`),
    };
  }
  if (record.kind === "check") {
    throw new Error(`${label} kind check is retired: ${retiredAutomationFeatureReasons.checkStep}.`);
  }
  if (record.kind === "agent") {
    if (version < 4) throw new Error("Agent steps require contract version 4.");
    assertKeys(record, ["id", "kind", "message"], ["model"], label);
    return {
      id: stepId(record.id, `${label} id`),
      kind: "agent",
      message: boundedMessage(record.message, `${label} message`),
      ...(record.model !== undefined ? { model: stepModel(record.model, `${label} model`) } : {}),
    };
  }
  throw new Error(version >= 4
    ? `${label} kind must be chat, files, or agent.`
    : `${label} kind must be chat or files.`);
}

function stepModel(value: unknown, label: string): AmpleFileAutomationStepModel {
  const record = objectRecord(value, `${label} must be a JSON object with provider and id.`);
  assertKeys(record, ["provider", "id"], [], label);
  const part = (raw: unknown, name: string): string => {
    if (typeof raw !== "string" || !raw.trim() || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw)) {
      throw new Error(`${label} ${name} must be the ${name === "id" ? "model id" : "provider id"} Settings → AI Models shows.`);
    }
    return raw.trim();
  };
  return { provider: part(record.provider, "provider"), id: part(record.id, "id") };
}

/**
 * The folder a folder-change trigger watches. Version 6 adds the Connected Folder's
 * own top level (`"path": ""`), only without recursion: the files directly in
 * it, never a subfolder, so a nested Connected Folder is never read.
 */
function normalizeWatchedFolder(value: unknown, version: AmpleFileAutomationContractVersion): AmpleFileAutomationFilesSource {
  const record = objectRecord(value, "Watched folder source must be a JSON object.");
  if (record.kind === "tree" && record.path === "") {
    if (version < 6) throw new Error("Watching a Connected Folder's top level requires contract version 6.");
    assertKeys(record, ["kind", "path", "recursive", "extensions"], [], "Watched folder source");
    if (record.recursive !== false) throw new Error("A Connected Folder's top level can be watched only without recursion.");
    return { kind: "tree", path: "", recursive: false, extensions: normalizeExtensions(record.extensions, "Watched folder source") };
  }
  return normalizeFilesSource(value, "Watched folder");
}

function normalizeFilesSource(value: unknown, stepLabel: string): AmpleFileAutomationFilesSource {
  const label = `${stepLabel} source`;
  const record = objectRecord(value, `${label} must be a JSON object.`);
  if (record.kind === "paths") {
    assertKeys(record, ["kind", "paths"], [], label);
    if (!Array.isArray(record.paths) || record.paths.length < 1) {
      throw new Error(`${label} paths must contain at least one exact file path.`);
    }
    const paths = record.paths.map((path, pathIndex) => normalizeFolderTargetPath(path, `${label} path ${pathIndex + 1}`));
    if (new Set(paths).size !== paths.length) throw new Error(`${label} paths repeat a path.`);
    return { kind: "paths", paths };
  }
  if (record.kind === "tree") {
    assertKeys(record, ["kind", "path", "recursive", "extensions"], [], label);
    if (record.recursive !== true && record.recursive !== false) throw new Error(`${label} recursive must be a boolean.`);
    return {
      kind: "tree",
      path: normalizeFolderTargetPath(record.path, `${label} path`),
      recursive: record.recursive,
      extensions: normalizeExtensions(record.extensions, label),
    };
  }
  if (record.kind === "step-created-files") {
    assertKeys(record, ["kind", "step", "maxFiles", "maxTotalBytes"], ["extensions"], label);
    return {
      kind: "step-created-files",
      step: stepId(record.step, `${label} step`),
      ...(record.extensions !== undefined ? { extensions: normalizeExtensions(record.extensions, label) } : {}),
      maxFiles: boundedInteger(record.maxFiles, `${label} maxFiles`, 1, ampleFileAutomationBounds.maxHandoffFiles),
      maxTotalBytes: boundedInteger(record.maxTotalBytes, `${label} maxTotalBytes`, 1, ampleFileAutomationBounds.maxHandoffTotalBytes),
    };
  }
  throw new Error(`${label} kind must be paths, tree, or step-created-files.`);
}

function normalizeOutcomes<Outcome extends string>(
  value: unknown,
  label: string,
  admissible: readonly Outcome[],
  fallback: readonly Outcome[],
): Outcome[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length < 1) throw new Error(`${label} outcomes must name at least one outcome.`);
  const outcomes = new Set<Outcome>();
  for (const item of value) {
    if (typeof item === "string" && (admissible as readonly string[]).includes(item)) {
      outcomes.add(item as Outcome);
      continue;
    }
    const reason = typeof item === "string" ? inadmissibleOutcomeReasons.get(item) : undefined;
    if (reason) throw new Error(`${label} cannot admit outcome "${item}": ${reason}.`);
    throw new Error(`${label} outcomes must be among: ${admissible.join(", ")}.`);
  }
  if (outcomes.size !== value.length) throw new Error(`${label} outcomes repeat an outcome.`);
  return [...outcomes].sort();
}

function normalizeExtensions(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    throw new Error(`${label} extensions must contain between 1 and 256 file extensions.`);
  }
  const extensions = value.map((item) => {
    const raw = boundedText(item, `${label} extension`, 24).toLocaleLowerCase("en-US");
    // Canonicalize to the dotted folder target form: a bare "md" filter would
    // otherwise match any suffix ending in those letters at resolution time.
    const extension = raw.startsWith(".") ? raw : `.${raw}`;
    if (!extensionPattern.test(extension)) throw new Error(`${label} contains an invalid extension.`);
    return extension;
  });
  return [...new Set(extensions)].sort();
}

function boundedMessage(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const message = value.trim();
  if (!message) throw new Error(`${label} cannot be empty.`);
  if (Buffer.byteLength(message, "utf8") > ampleFileAutomationBounds.maxChatMessageBytes) {
    throw new Error(`${label} exceeds ${ampleFileAutomationBounds.maxChatMessageBytes} bytes.`);
  }
  if (forbiddenMessageCharacters.test(message)) {
    throw new Error(`${label} contains control or direction-override characters, which are never allowed in an automation message.`);
  }
  return message;
}

function connectedFolderId(value: unknown, label: string): string {
  if (typeof value !== "string" || !connectedFolderIdPattern.test(value)) {
    throw new Error(`${label} must be a stable registered Connected Folder id, not a name or path.`);
  }
  return value;
}

function automationId(value: unknown): string {
  const id = boundedText(value, "Automation id", 160).toLocaleLowerCase("en-US");
  if (!automationIdPattern.test(id)) throw new Error("Automation id is invalid.");
  return id;
}

function restrictedAppId(value: unknown, label: string): string {
  const id = boundedText(value, label, 64).toLocaleLowerCase("en-US");
  if (!restrictedAppIdPattern.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function stepId(value: unknown, label: string): string {
  const id = boundedText(value, label, 64).toLocaleLowerCase("en-US");
  if (!stepIdPattern.test(id)) throw new Error(`${label} must be a short lowercase id of letters, digits, and hyphens.`);
  return id;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function normalizeCreator(value: unknown): AmpleFileAutomationProposal["createdBy"] {
  if (value === "human" || value === "assistant" || value === "codex" || value === "claude-code" || value === "other") return value;
  throw new Error("Automation proposal createdBy is invalid.");
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function explicitOffsetTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be an ISO timestamp with an explicit UTC offset.`);
  }
  return new Date(value).toISOString();
}

function contractVersion(value: unknown, label: string): AmpleFileAutomationContractVersion {
  if (!(ampleFileAutomationSupportedContractVersions as readonly unknown[]).includes(value)) {
    throw new Error(`${label} uses unsupported version ${String(value)}.`);
  }
  return value as AmpleFileAutomationContractVersion;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid or too long.`);
  }
  return normalized;
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function assertKeys(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported field: ${unexpected[0]}.`);
  const missing = required.filter((key) => !(key in record));
  if (missing.length) throw new Error(`${label} is missing required field: ${missing[0]}.`);
}

/** The shared bounded, no-follow reader for proposal scans and enablement. */
export async function readAmpleFileAutomationDocument(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Automation document must be an ordinary file, not a link or special file.");
  if (info.size > ampleFileAutomationDocumentMaxBytes) throw new Error("Automation document exceeds the 64 MiB bound.");
  // A raced FIFO must not block the app; a raced symlink must not redirect it.
  const handle = await open(path, constants.O_RDONLY | noFollowFlag() | (constants.O_NONBLOCK ?? 0));
  try {
    const afterOpen = await handle.stat();
    if (!sameAutomationFile(info, afterOpen)) throw new Error("Automation document changed while it was opened.");
    // Read the admitted size only: readFile() could allocate without a bound
    // if another process grew the file after stat. The final metadata checks
    // also refuse a changed/truncated document instead of parsing mixed bytes.
    const bytes = Buffer.alloc(afterOpen.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Automation document changed while it was read.");
      offset += read.bytesRead;
    }
    if (!sameAutomationFile(afterOpen, await handle.stat()) || !sameAutomationFile(afterOpen, await lstat(path))) {
      throw new Error("Automation document changed while it was read.");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

function sameAutomationFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}
