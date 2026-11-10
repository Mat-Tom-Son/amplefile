/**
 * What the act facade shares with the routes: the operation wrapper that maps
 * errors to the CLI's typed vocabulary, action records under an AmpleFile
 * Agent parent, bounded file reads, and the refs the act lane returns.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import JSZip from "jszip";
import type { ConversationSummary } from "../agent/chat-store.js";
import { classifyAmpleFileAgentAttachments, type AmpleFileAgentAttachmentRef } from "../amplefile-agent-attachments.js";
import type { AmpleFileRequestActionCommand } from "../requests/request-records.js";
import { AmpleFileRequestStore } from "../requests/request-store.js";
import type { ConnectedFolderCheckpoint, ConnectedFolderFileVersion } from "../history.js";
import {
  parseConnectedFolderAppearanceProposal,
  type ConnectedFolderAppearanceCustomization,
  type ConnectedFolderAppearanceProposal,
} from "../../shared/connected-folder-appearance.js";
import { ampleFileAgentRoot } from "../state-paths.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import type {
  AmpleFileActChatLifecycleState,
  AmpleFileActCheckpointSummary,
  AmpleFileActConversationRef,
  AmpleFileActFileVersionRef,
  AmpleFileActConnectedFolderRef,
} from "../cli/act-facade.js";
import type { ConnectedFolderSummary } from "../connected-folder.js";
import { normalizeConnectedFolderRelativePath } from "./file-changes.js";
import { automationErrorStatus, errorMessage } from "./http.js";
import type { LocalApiState } from "./state.js";

export async function classifyActAmpleFileAgentAttachments(raw: string[], cwd: string | undefined): Promise<AmpleFileAgentAttachmentRef[]> {
  if (!raw.length) return [];
  try {
    return await classifyAmpleFileAgentAttachments(raw, cwd ?? ampleFileAgentRoot());
  } catch (error) {
    throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
  }
}

/**
 * Records an act whose effect has already landed. Attribution is the
 * receipt's story, not the act: if writing it fails, the act still succeeded,
 * and reporting an error would invite a retry that repeats the effect (a
 * second copy, a second turn). The failure is logged instead.
 */
export async function recordLandedAction(
  state: LocalApiState,
  parentTaskId: string | undefined,
  action: Parameters<AmpleFileRequestStore["recordAction"]>[1],
): Promise<void> {
  try {
    await state.requests.recordAction(parentTaskId, action);
  } catch (error) {
    console.warn(`AmpleFile could not record ${action.command} on its request; the act itself completed: ${errorMessage(error)}`);
  }
}

/**
 * Attributes one applied facade mutation to its explicitly named management
 * request, so the request's recorded story stays complete across every landed
 * verb. Connected Folder–free acts (Everywhere-scope tools) record
 * no Connected Folder fields. `chat.send` keeps its own inline recording because it also
 * threads child-task bookkeeping and post-acceptance cancellation.
 */
export async function recordFacadeAction(
  state: LocalApiState,
  parentTaskId: string | undefined,
  input: {
    command: AmpleFileRequestActionCommand;
    connectedFolder?: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">;
    conversationId?: string;
    checkpointId?: string | null;
    taskId?: string;
    copied?: string[];
  },
): Promise<void> {
  if (!parentTaskId) return;
  await recordLandedAction(state, parentTaskId, {
    command: input.command,
    at: new Date().toISOString(),
    ...(input.connectedFolder ? { connectedFolderId: input.connectedFolder.id, connectedFolderName: input.connectedFolder.name } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.copied ? { copied: input.copied } : {}),
  });
}

/**
 * Splits one Connected Folder–relative act path into the desktop create routes' parent
 * and name inputs, so `files mkdir`/`files create` run the exact same
 * `createConnectedFolderFolder`/`createConnectedFolderTextFile` internals as the renderer.
 */
export function splitActEntryPath(rawPath: string, missingMessage: string): { target: string; parentPath: string; name: string } {
  const target = normalizeConnectedFolderRelativePath(rawPath);
  if (!target) throw new AmpleFileCliError("usage", missingMessage);
  const lastSlash = target.lastIndexOf("/");
  return {
    target,
    parentPath: lastSlash === -1 ? "" : target.slice(0, lastSlash),
    name: lastSlash === -1 ? target : target.slice(lastSlash + 1),
  };
}

/** Banner-image data URLs dominate a proposal's size; anything past this bound is not a typed proposal. */
const maxActAppearanceProposalBytes = 1_048_576;

/**
 * Reads and validates one typed `connected-folder-appearance` proposal file, resolved
 * host-side against the caller's working directory — the same file-borne
 * input pattern as `automations enable --proposal`. Nothing but the typed proposal
 * is accepted: no free-form argv colors, no other JSON shapes.
 */
export async function readConnectedFolderAppearanceProposalFile(rawPath: string, cwd: string): Promise<ConnectedFolderAppearanceProposal> {
  const parsed = await readBoundedActJsonFile(rawPath, cwd, maxActAppearanceProposalBytes, "appearance proposal");
  try {
    return parseConnectedFolderAppearanceProposal(parsed);
  } catch (error) {
    throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
  }
}

async function readBoundedActJsonFile(
  rawPath: string,
  cwd: string,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new AmpleFileCliError("usage", `A ${label} file path is required.`);
  const path = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) throw new AmpleFileCliError("notFound", `The ${label} file was not found: ${trimmed}.`);
  if (info.size > maximumBytes) {
    throw new AmpleFileCliError("usage", `The ${label} file is larger than ${maximumBytes} bytes and cannot be a typed AmpleFile file.`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new AmpleFileCliError("usage", `The ${label} file is not valid JSON.`, { cause: error });
  }
}

/**
 * Short content digest used as a receipt-safe reference: receipts and act
 * output carry identifiers and digests, never customization or presentation
 * payloads. Store-normalized values serialize deterministically, so equal
 * content yields equal refs.
 */
function shortContentRef(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;
}

export function appearanceCustomizationRef(customization: ConnectedFolderAppearanceCustomization | null): string | null {
  return customization === null ? null : shortContentRef(customization);
}

export function appearanceCustomizationsEqual(
  left: ConnectedFolderAppearanceCustomization | null,
  right: ConnectedFolderAppearanceCustomization | null,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export async function runActOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AmpleFileCliError) throw error;
    // Exactly the HTTP boundary's status translation (sendError), so a
    // route error means the same thing on both surfaces.
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : automationErrorStatus(error);
    const message = error instanceof Error ? error.message : String(error ?? "Connected Folder act command failed.");
    if (statusCode === 400) throw new AmpleFileCliError("usage", message, { cause: error });
    if (statusCode === 403) throw new AmpleFileCliError("permissionDenied", message, { cause: error });
    if (statusCode === 404) throw new AmpleFileCliError("notFound", message, { cause: error });
    if (statusCode === 409) throw new AmpleFileCliError("conflict", message, { cause: error });
    throw new AmpleFileCliError("failure", message, { cause: error });
  }
}

export function toActConnectedFolderRef(connectedFolder: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">): AmpleFileActConnectedFolderRef {
  return { id: connectedFolder.id, name: connectedFolder.name, connectedFolderRoot: connectedFolder.connectedFolderRoot };
}

export function toActConversationRef(conversation: ConversationSummary): AmpleFileActConversationRef {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    archivedAt: conversation.archivedAt ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
  };
}

export function toActChatLifecycleState(conversation: ConversationSummary): AmpleFileActChatLifecycleState {
  return {
    archivedAt: conversation.archivedAt ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
  };
}

/** Manifest-summary projection: counts and identifiers, never per-file listings. */
export function toActCheckpointSummary(checkpoint: ConnectedFolderCheckpoint): AmpleFileActCheckpointSummary {
  return {
    checkpointId: checkpoint.checkpointId,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.label ? { label: checkpoint.label } : {}),
    reason: checkpoint.reason,
    scope: checkpoint.scope,
    fileCount: checkpoint.fileCount,
    totalBytes: checkpoint.totalBytes,
    skippedFileCount: checkpoint.skippedFiles.length,
  };
}

export function toActFileVersionRef(version: ConnectedFolderFileVersion): AmpleFileActFileVersionRef {
  return {
    path: version.path,
    hashSha256: version.hashSha256,
    sizeBytes: version.sizeBytes,
    modifiedAt: version.modifiedAt,
    capturedAt: version.capturedAt,
    checkpointId: version.checkpointId,
    ...(version.checkpointLabel ? { checkpointLabel: version.checkpointLabel } : {}),
  };
}

/**
 * Enumerates a skill bundle's SKILL.md names for the act's result and
 * receipt without installing anything, on the import path's own bounds.
 * Digest equality remains the whole identity recheck at effect time; these
 * names are derived from the exact inspected bytes.
 */
export async function enumerateSkillBundleNames(fileName: string, bytes: Uint8Array): Promise<string[]> {
  const extension = extname(fileName).toLowerCase();
  if (extension === ".md") {
    const markdown = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1] ?? "";
    const rawName = /^name\s*:\s*(.+?)\s*$/im.exec(frontmatter)?.[1]?.trim();
    const unquoted = rawName?.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, d, s) => (d ?? s ?? "")).trim();
    if (!unquoted) throw new AmpleFileCliError("usage", "SKILL.md must declare a name in YAML frontmatter.");
    return [unquoted];
  }
  if (extension !== ".zip" && extension !== ".skill") {
    throw new AmpleFileCliError("usage", "Skills must be a SKILL.md file or use a .zip or .skill bundle.");
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new AmpleFileCliError("usage", `Could not read the skill bundle: ${errorMessage(error)}`, { cause: error });
  }
  const bundleStem = basename(fileName, extname(fileName));
  const names = Object.values(archive.files)
    .filter((entry) => !entry.dir && basename(entry.name.replace(/\\/g, "/")).toLowerCase() === "skill.md")
    .map((entry) => {
      const parent = entry.name.replace(/\\/g, "/").replace(/\/?skill\.md$/i, "").replace(/\/$/, "");
      const segments = parent.split("/").filter((segment) => segment && segment !== ".");
      return segments.length ? segments[segments.length - 1]! : bundleStem;
    })
    .slice(0, 256);
  if (!names.length) throw new AmpleFileCliError("usage", "The bundle does not contain a SKILL.md file.");
  return [...new Set(names)].sort();
}

/** Parses an npm package source into its identity; null for non-npm sources. */
export function npmSourceIdentity(source: string): { packageName: string; pinnedVersion?: string } | null {
  if (!source.startsWith("npm:")) return null;
  const rest = source.slice("npm:".length);
  const at = rest.indexOf("@", rest.startsWith("@") ? 1 : 0);
  if (at === -1) return { packageName: rest };
  const packageName = rest.slice(0, at);
  const pinnedVersion = rest.slice(at + 1);
  return pinnedVersion ? { packageName, pinnedVersion } : { packageName };
}

/**
 * The inspected resource summary a package install or update pins and
 * reports. Extensions and install scripts are named for what they are —
 * code that runs as you — exactly as the desktop review does.
 */
export function capabilityResourceSummary(details: {
  skills?: string[];
  extensions?: string[];
  prompts?: string[];
  themes?: string[];
  installScripts?: Array<{ name: string }>;
  dependencyCount?: number;
}): string {
  const parts = [
    `${details.skills?.length ?? 0} skill(s)`,
    `${details.extensions?.length ?? 0} extension(s)${(details.extensions?.length ?? 0) > 0 ? " — executable Pi capability" : ""}`,
  ];
  if (details.prompts?.length) parts.push(`${details.prompts.length} prompt(s)`);
  if (details.themes?.length) parts.push(`${details.themes.length} theme(s)`);
  if (details.installScripts?.length) {
    parts.push(`${details.installScripts.length} install script(s) — runs code at install (${details.installScripts.map((script) => script.name).join(", ")})`);
  }
  if (details.dependencyCount) parts.push(`${details.dependencyCount} runtime dependencies`);
  return parts.join(", ").slice(0, 2000);
}
