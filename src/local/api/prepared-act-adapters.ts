/**
 * Prepared acts (docs/act-ledger.md) as the local API runs them: the Settings
 * act wrapper, error translation into the CLI's typed vocabulary, the fence
 * over the reservations, and the adapters for Skill import, capability
 * packages, Automation enable, and managed Connected Folder deletion.
 */

import { resourceEnableAdapter } from "../agent/resource-enable-act.js";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { importPiSkillBundleVerified, piSkillBundleContentDigest, type PiSkillBundleImportResult } from "../agent/skill-import.js";
import { installPiPackage, isPiProjectMutationTrusted, updatePiPackages } from "../agent/pi-runtime-config.js";
import {
  PreparedActError,
  type PreparedActFence,
  type PreparedAct,
  type PreparedActAdapter,
  type PreparedActAdapters,
} from "../prepared-acts.js";
import {
  ampleFileAutomationDigest,
  ampleFileAutomationReferencedConnectedFolderIds,
  type AmpleFileAutomationDeclaration,
} from "../automations/automation-declarations.js";
import type { AmpleFileAutomationRecord } from "../automations/automation-store.js";
import { ampleFileAgentRoot, ampleFileAgentScopeId } from "../state-paths.js";
import type { AmpleFileCliActSurface } from "../cli/act-receipts.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import {
  getConnectedFolder,
  managedConnectedFolderDeletionPinIssue,
  type ConnectedFolderRemovalResult,
  type ConnectedFolderSummary,
} from "../connected-folder.js";
import { removeConnectedFolderRegistrationInternal } from "./connected-folder-routes.js";
import { errorMessage } from "./http.js";
import { runCapabilityMutation, runConnectedFolderMutation } from "./reservations.js";
import type { LocalApiState } from "./state.js";

/**
 * Journal-first wrapper for a mutation initiated from trusted desktop
 * Settings. Automation-domain receipts remain the effect evidence; this global
 * pair records the product verb and the main-window surface exactly as the
 * act lane would. The returned promise lets callers separate durable command
 * acceptance from their own terminal domain result when needed.
 */
async function beginDesktopSettingsAct<T>(
  state: LocalApiState,
  command: string,
  operation: (requestId: string) => Promise<{ value: T; detail: string }>,
): Promise<{ requestId: string; result: Promise<T> }> {
  const requestId = `settings:${randomUUID()}`;
  const base = { requestId, command, surface: "main-window" as const };
  if (!await state.actReceipts.append({ ...base, outcome: "accepted" })) {
    throw new AmpleFileCliError(
      "failure",
      "AmpleFile could not journal this Settings action, so nothing was changed.",
    );
  }
  const result = (async () => {
    try {
      const applied = await operation(requestId);
      await state.actReceipts.append({ ...base, outcome: "ok", detail: applied.detail }).catch(() => false);
      return applied.value;
    } catch (error) {
      await state.actReceipts.append({
        ...base,
        outcome: "error",
        ...(error instanceof AmpleFileCliError ? { errorCode: error.code } : {}),
        detail: errorMessage(error),
      }).catch(() => false);
      throw error;
    }
  })();
  return { requestId, result };
}

export async function runDesktopSettingsAct<T>(
  state: LocalApiState,
  command: string,
  operation: (requestId: string) => Promise<{ value: T; detail: string }>,
): Promise<{ requestId: string; value: T }> {
  const started = await beginDesktopSettingsAct(state, command, operation);
  return { requestId: started.requestId, value: await started.result };
}

/** The neutral app-owned root global capability mutations resolve against. */
function capabilityGlobalMutationScope(): { id: string; connectedFolderRoot: string } {
  return { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentRoot() };
}

/** Attribution the prepared-act verbs thread into automation grants: the initiating surface (docs/act-ledger.md). */
export function preparedActAttribution(surface: AmpleFileCliActSurface): PreparedActAttribution {
  return { surface };
}

function mapPreparedActError(error: PreparedActError): AmpleFileCliError {
  switch (error.code) {
    case "KIND_UNKNOWN":
    case "INPUT_INVALID":
      return new AmpleFileCliError("usage", error.message, { cause: error });
    case "PIN_MISMATCH":
      return new AmpleFileCliError("conflict", error.message, { cause: error });
    default:
      return new AmpleFileCliError("unavailable", error.message, { cause: error });
  }
}

export async function runPreparedActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PreparedActError) throw mapPreparedActError(error);
    throw error;
  }
}

/**
 * The prepared-act fence over the exact reservation state the desktop routes
 * use: a Connected Folder scope reserves with runConnectedFolderMutation semantics, the
 * global scope with runCapabilityMutation's global branch. A busy scope
 * refuses with the routes' own conflict, which the act facade translates into
 * the CLI's typed vocabulary. Project trust checks stay with the calling
 * verbs and the per-kind adapters, mirroring the routes each kind reuses.
 */
export function createPreparedActFence(state: LocalApiState): PreparedActFence {
  return {
    run(scope, operation) {
      return scope.scope === "connected-folder"
        ? runConnectedFolderMutation(state, scope.connectedFolderId, operation)
        : runCapabilityMutation(state, capabilityGlobalMutationScope(), "global", operation);
    },
  };
}

/** Attribution a prepared act threads into automation grants. */
interface PreparedActAttribution {
  surface: AmpleFileCliActSurface;
}

/**
 * The execution outcome slot a calling verb reads back after a prepared act
 * ran: the imported Skill, the removal result. It travels in the executor's
 * `context`, never in a receipt.
 */
export interface PreparedActOutcome<T> {
  outcome?: T;
  /** Stamped by `runPreparedAct`: the journaled request id the act runs under. */
  requestId?: string;
}

export interface AutomationEnableContext extends PreparedActOutcome<AmpleFileAutomationRecord> {
  declaration: AmpleFileAutomationDeclaration;
  requestId: string;
  attribution: PreparedActAttribution;
}

/**
 * Per-kind execution adapters for the prepared-act path: each binds one kind
 * to the same domain internals the equivalent desktop action uses. Every
 * admitted kind has an adapter. Each re-observes its pinned identities
 * immediately before executing.
 */
export function createPreparedActAdapters(state: LocalApiState): PreparedActAdapters {
  return {
    "capability.skills.import": createSkillImportAdapter(state),
    "capability.package.install": createCapabilityPackageAdapter(state, "install"),
    "capability.package.update": createCapabilityPackageAdapter(state, "update"),
    "capability.resource.enabled": resourceEnableAdapter(async (act) => act.parameters.scope === "connected-folder" ? (await getConnectedFolder(String(act.parameters.connectedFolderId))).connectedFolderRoot : ampleFileAgentRoot(), state.runtimeProvider),
    "automation.enable": createAutomationEnableAdapter(state),
    "connected-folder.delete-folder": createManagedConnectedFolderDeletionAdapter(state),
  };
}

/**
 * `capability.skills.import` — the existing import path, digest-verified: the
 * pinned content digest names the exact inspected bytes, and the enumerated
 * skill names are derived from those bytes, so digest equality is the whole
 * identity recheck. Connected Folder scope resolves the Connected Folder's folder; Everywhere scope
 * has no Connected Folder, so it names the same app-owned neutral root the act facade's
 * Everywhere-scope tools verbs resolve against.
 */
function createSkillImportAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<PiSkillBundleImportResult> | undefined> {
  const loadVerified = async (act: PreparedAct): Promise<
    { bundle: { fileName: string; bytes: Uint8Array } } | { issue: string }
  > => {
    let bundle: { fileName: string; bytes: Uint8Array };
    try {
      bundle = await loadSkillBundleForAct(state, act);
    } catch (caught) {
      return { issue: `The skill bundle could not be re-read: ${errorMessage(caught)}` };
    }
    if (piSkillBundleContentDigest(bundle.bytes) !== act.pins.contentDigest) {
      return { issue: "The skill bundle's content no longer matches the pinned digest; the source changed after it was inspected." };
    }
    return { bundle };
  };
  return {
    async recheckPins(act) {
      const loaded = await loadVerified(act);
      return "issue" in loaded ? loaded.issue : null;
    },
    async execute(act, context) {
      const loaded = await loadVerified(act);
      if ("issue" in loaded) throw new Error(loaded.issue);
      const root = act.parameters.scope === "connected-folder"
        ? (await getConnectedFolder(String(act.parameters.connectedFolderId))).connectedFolderRoot
        : ampleFileAgentRoot();
      const result = await importPiSkillBundleVerified(root, {
        fileName: loaded.bundle.fileName,
        bytes: loaded.bundle.bytes,
        scope: act.parameters.scope === "connected-folder" ? "project" : "user",
        expectedContentDigest: String(act.pins.contentDigest),
      }, state.runtimeProvider);
      if (context) context.outcome = result;
      const names = result.skills.map((skill) => skill.name).join(", ");
      return {
        detail: `Imported ${result.skills.length === 1 ? "skill" : "skills"} ${names} at ${result.scope === "user" ? "Everywhere" : "This Connected Folder"} scope.`,
        undoRef: { kind: "skill-bundle-path", value: result.bundlePath },
      };
    },
  };
}

/**
 * Re-reads the exact bundle bytes for `capability.skills.import`. Loading is
 * identity, not trust: the adapter's content-digest recheck decides whether
 * these are the inspected bytes. An absolute path is a file-borne bundle; any
 * other source is an official catalog bundle id, rebuilt through the same
 * registry path the desktop install uses and then digest-checked like every
 * other reload.
 */
async function loadSkillBundleForAct(
  state: LocalApiState,
  act: PreparedAct,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const source = String(act.pins.source ?? act.parameters.source ?? "").trim();
  if (!source) throw new Error("the bundle source is missing");
  if (!isAbsolute(source)) {
    const bundle = await state.capabilityRegistry.buildOfficialSkillBundle(source);
    return { fileName: bundle.fileName, bytes: bundle.bytes };
  }
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("the bundle source must be a regular file");
  }
  return { fileName: basename(source), bytes: await readFile(source) };
}

/**
 * `capability.package.install|update` — the same capability-mutation
 * internals as the desktop package routes, executed inside the fence's
 * reservation (Connected Folder scope for a Connected Folder–scoped package, global for Everywhere
 * scope) instead of reserving twice. Project trust is rechecked at effect
 * time so an untrusted Connected Folder refuses instead of loading code.
 */
function createCapabilityPackageAdapter(
  state: LocalApiState,
  operation: "install" | "update",
): PreparedActAdapter {
  const scopeOf = (act: PreparedAct): "everywhere" | "connected-folder" =>
    (act.pins.scope ?? act.parameters.scope) === "connected-folder" ? "connected-folder" : "everywhere";
  const connectedFolderOf = async (act: PreparedAct): Promise<ConnectedFolderSummary | null> => {
    const connectedFolderId = act.parameters.connectedFolderId;
    if (typeof connectedFolderId !== "string") return null;
    try {
      return await getConnectedFolder(connectedFolderId);
    } catch {
      return null;
    }
  };
  return {
    async recheckPins(act) {
      if (scopeOf(act) !== "connected-folder") return null;
      const connectedFolder = await connectedFolderOf(act);
      if (!connectedFolder) return "The Connected Folder is no longer registered.";
      return await isPiProjectMutationTrusted(connectedFolder.connectedFolderRoot, state.runtimeProvider)
        ? null
        : "Trust this Connected Folder before changing Connected Folder–scoped capabilities.";
    },
    async execute(act) {
      const scope = scopeOf(act);
      const connectedFolder = scope === "connected-folder" ? await connectedFolderOf(act) : null;
      if (scope === "connected-folder" && !connectedFolder) throw new Error("The Connected Folder is no longer registered.");
      const root = connectedFolder?.connectedFolderRoot ?? ampleFileAgentRoot();
      const source = String(act.pins.source);
      const piScope = scope === "connected-folder" ? "project" as const : "user" as const;
      if (operation === "install") {
        await installPiPackage(root, source, { scope: piScope, runtimeProvider: state.runtimeProvider });
      } else {
        await updatePiPackages(root, source, { scope: piScope, runtimeProvider: state.runtimeProvider });
      }
      return {
        detail: `${operation === "install" ? "Installed" : "Updated"} ${String(act.pins.packageId)}@${String(act.pins.version)} `
          + `from ${source} at ${piScope === "user" ? "Everywhere" : "This Connected Folder"} scope.`,
        undoRef: { kind: "package-source", value: source },
      };
    },
  };
}

/**
 * `automation.enable` — the enablement receipt of docs/automations.md. The
 * normalized declaration arrives as execution context from the calling verb,
 * is re-verified against the pinned digest and automation id, and every
 * referenced Connected Folder must still be registered. Execution commits the
 * declaration and the exact-authority grant through the automation service with
 * the act's request id as the grant identity; the store itself re-refuses a
 * declaration that no longer hashes to the pinned digest, and enabling an
 * identical already-enabled declaration changes nothing.
 */
function createAutomationEnableAdapter(state: LocalApiState): PreparedActAdapter<AutomationEnableContext | undefined> {
  const verify = async (act: PreparedAct, context: AutomationEnableContext | undefined): Promise<string | null> => {
    const declaration = context?.declaration;
    if (!declaration) return "The automation declaration to enable was not supplied.";
    if (ampleFileAutomationDigest(declaration) !== act.pins.declarationDigest) {
      return "The automation declaration no longer hashes to the digest this act pinned.";
    }
    if (declaration.id !== act.pins.automationId) return "The declaration names a different automation than this act pinned.";
    for (const connectedFolderId of ampleFileAutomationReferencedConnectedFolderIds(declaration)) {
      const registered = await getConnectedFolder(connectedFolderId).catch(() => null);
      if (!registered) return `The automation references a Connected Folder that is no longer registered (${connectedFolderId}).`;
    }
    return null;
  };
  return {
    // Enablement is an automation-store commit under its own serialization; it
    // mutates no capability state, so it reserves no capability fence.
    fenceScope: () => null,
    recheckPins: verify,
    async execute(act, context) {
      const issue = await verify(act, context);
      if (issue || !context) throw new Error(issue ?? "The automation declaration to enable was not supplied.");
      const { attribution } = context;
      const record = await state.automations.enable({
        declaration: context.declaration,
        expectedDigest: String(act.pins.declarationDigest),
        grant: {
          requestId: context.requestId,
          surface: attribution.surface,
        },
      });
      context.outcome = record;
      // The service returns the untouched record when this exact declaration
      // was already on. Nothing changed, so the receipt says so and offers no
      // undo reference for a state this call did not create.
      if (record.grants[record.grants.length - 1]?.requestId !== context.requestId) {
        return {
          detail: `Automation "${record.declaration.title}" (${record.declaration.id}) was already on at digest ${record.digest}; nothing changed.`,
        };
      }
      return {
        detail: `Enabled automation "${record.declaration.title}" (${record.declaration.id}) at digest ${record.digest}.`,
        undoRef: { kind: "automation-id", value: record.declaration.id },
      };
    },
  };
}

/** The prepared-act pin as bounded text, tolerating the parameter mirror. */
function stringPinValue(act: PreparedAct, name: string): string {
  const value = act.pins[name] ?? act.parameters[name];
  return typeof value === "string" ? value : "";
}

/**
 * `connected-folder.delete-folder` — the managed removal path. Pin recheck re-verifies
 * the registered identity and canonical root; managed-root identity claims
 * are re-checked by the removal machinery itself at execution. The complete desktop removal orchestration
 * — automation revocation and claim-verified managed deletion — is shared with DELETE /api/connected-folders/:id and `connected-folders
 * unregister`. It reserves its own capability fences across every affected
 * Connected Folder, so the adapter's null fenceScope keeps the executor from reserving
 * twice.
 */
function createManagedConnectedFolderDeletionAdapter(
  state: LocalApiState,
): PreparedActAdapter<PreparedActOutcome<ConnectedFolderRemovalResult & {
  recentlyDeleted: { entryId: string; restoreBy: string } | null;
}> | undefined> {
  return {
    fenceScope: () => null,
    recheckPins(act) {
      return managedConnectedFolderDeletionPinIssue({
        connectedFolderId: stringPinValue(act, "connectedFolderId"),
        connectedFolderRoot: stringPinValue(act, "connectedFolderRoot"),
      });
    },
    async execute(act, context) {
      const connectedFolder = await getConnectedFolder(String(act.pins.connectedFolderId ?? act.parameters.connectedFolderId));
      const result = await removeConnectedFolderRegistrationInternal(state, connectedFolder, { receiptId: context?.requestId ?? null });
      if (context) context.outcome = result;
      const trashed = result.recentlyDeleted ? `; trash ${result.recentlyDeleted.entryId}` : "";
      return {
        detail: result.cleanupPending
          ? `Moved the managed Connected Folder's folder ${connectedFolder.connectedFolderRoot} to Recently deleted${trashed}; final cleanup completes at the next start.`
          : `Moved the managed Connected Folder's folder ${connectedFolder.connectedFolderRoot} to Recently deleted${trashed}.`,
        ...(result.recentlyDeleted ? { undoRef: { kind: "recently-deleted-entry", value: result.recentlyDeleted.entryId } } : {}),
      };
    },
  };
}
