import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import {
  chatContextBudgetTokens,
  estimateTokens,
  normalizeText,
  readableAttachmentText,
  type LoadedConversationContextAttachment,
} from "./conversation-context.js";
import { containsReservedConnectedFolderPathSegment } from "./connected-folder-path-policy.js";

/**
 * AmpleFile Agent attachments are references, not copies. A Worker Chat
 * stages dropped material inside the Connected Folder because its transcript is
 * portable data; the AmpleFile Agent transcript is deliberately machine-local,
 * so its attachments carry absolute local paths (or links) and the only copy
 * in the flow stays the restore-pointed `files add` into a destination
 * Connected Folder.
 */
export type AmpleFileAgentAttachmentKind = "file" | "folder" | "url";

export interface AmpleFileAgentAttachmentRef {
  kind: AmpleFileAgentAttachmentKind;
  /** Absolute local path for file/folder attachments, or the full http(s) link. */
  target: string;
  /** Short display name: the base name, or the link without its scheme. */
  name: string;
}

export const maxAmpleFileAgentAttachments = 1_000;
const maxAmpleFileAgentAttachmentTargetLength = 4_096;
const maxAmpleFileAgentAttachmentFileBytes = 32 * 1024 * 1024;

/**
 * Classifies raw `--attach` values (or popover drops) into typed references.
 * Relative paths resolve against the caller's working directory, links must be
 * http(s), and missing sources are rejected at send time — a clear refusal
 * beats accepting a turn about material that is not there.
 */
export async function classifyAmpleFileAgentAttachments(
  raw: readonly string[],
  cwd: string,
): Promise<AmpleFileAgentAttachmentRef[]> {
  if (raw.length > maxAmpleFileAgentAttachments) {
    throw new Error(`At most ${maxAmpleFileAgentAttachments} attachments are allowed per request.`);
  }
  const refs: AmpleFileAgentAttachmentRef[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Attachment values cannot be empty.");
    if (trimmed.length > maxAmpleFileAgentAttachmentTargetLength) {
      throw new Error(`Attachment values must be at most ${maxAmpleFileAgentAttachmentTargetLength} characters.`);
    }
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(trimmed)) {
      throw new Error("Attachment values contain unsupported control characters.");
    }
    if (/^https?:\/\//i.test(trimmed)) {
      if (/\s/.test(trimmed)) throw new Error(`Links cannot contain spaces: ${trimmed}`);
      let url: URL;
      try {
        url = new URL(trimmed);
      } catch {
        throw new Error(`Invalid link: ${trimmed}`);
      }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
        throw new Error(`Only http(s) links can be attached: ${trimmed}`);
      }
      if (url.username || url.password) {
        throw new Error("Links containing embedded credentials cannot be attached.");
      }
      const ref: AmpleFileAgentAttachmentRef = {
        kind: "url",
        target: url.toString(),
        name: url.toString().replace(/^https?:\/\//i, "").replace(/\/+$/, "").slice(0, 120),
      };
      if (!seen.has(ref.target)) refs.push(ref);
      seen.add(ref.target);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      throw new Error(`Only http(s) links can be attached: ${trimmed}`);
    }
    const path = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
    if (containsReservedConnectedFolderPathSegment(path)) {
      throw new Error("Reserved .amplefile, .work-fold, and .pi metadata cannot be attached.");
    }
    const info = await lstat(path).catch(() => null);
    if (!info) throw new Error(`Attachment not found: ${trimmed}`);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links cannot be attached: ${trimmed}`);
    if (!info.isFile() && !info.isDirectory()) throw new Error(`Only files, folders, and links can be attached: ${trimmed}`);
    const ref: AmpleFileAgentAttachmentRef = {
      kind: info.isDirectory() ? "folder" : "file",
      target: path,
      name: basename(path) || path,
    };
    if (!seen.has(ref.target)) refs.push(ref);
    seen.add(ref.target);
  }
  return refs;
}

export type AmpleFileAgentAttachmentDispositionStatus = "placed" | "registered" | "unrecorded";

export interface AmpleFileAgentAttachmentDisposition {
  attachment: AmpleFileAgentAttachmentRef;
  status: AmpleFileAgentAttachmentDispositionStatus;
  connectedFolderId?: string;
  connectedFolderName?: string;
  copied?: string[];
  checkpointId?: string | null;
}

/**
 * The slice of a recorded request action that disposition accounting reads.
 * Structural on purpose: the durable request record owns the full action
 * shape, and this module must not depend on it.
 */
export interface AmpleFileAgentAttachmentActionRef {
  command: string;
  connectedFolderId?: string;
  connectedFolderName?: string;
  sources?: string[];
  copied?: string[];
  checkpointId?: string | null;
  connectedFolderRoot?: string;
}

/**
 * Accounts for every attachment against the recorded actions. Nothing may
 * silently disappear from the story: an attachment with no mechanically
 * matched action is reported as `unrecorded`, and the AmpleFile Agent's own
 * report remains the narrative for it.
 */
export function ampleFileAgentAttachmentDispositions(input: {
  attachments: readonly AmpleFileAgentAttachmentRef[];
  actions: readonly AmpleFileAgentAttachmentActionRef[];
}): AmpleFileAgentAttachmentDisposition[] {
  return input.attachments.map((attachment) => {
    if (attachment.kind !== "url") {
      const placed = input.actions.find((action) =>
        action.command === "files.add" && action.sources?.includes(attachment.target));
      if (placed) {
        return {
          attachment,
          status: "placed" as const,
          connectedFolderId: placed.connectedFolderId,
          connectedFolderName: placed.connectedFolderName,
          copied: placed.copied ?? [],
          checkpointId: placed.checkpointId ?? null,
        };
      }
      const registered = input.actions.find((action) =>
        action.command === "connected-folders.register" && action.connectedFolderRoot === attachment.target);
      if (registered) {
        return {
          attachment,
          status: "registered" as const,
          connectedFolderId: registered.connectedFolderId,
          connectedFolderName: registered.connectedFolderName,
        };
      }
    }
    return { attachment, status: "unrecorded" as const };
  });
}

/** Links are handed to the turn as a separate typed list, never as fake files. */
export function ampleFileAgentAttachmentLinks(refs: readonly AmpleFileAgentAttachmentRef[]): string[] {
  return refs.filter((ref) => ref.kind === "url").map((ref) => ref.target);
}

/**
 * Loads file and folder references for one turn with the same degrade ladder
 * as Worker Chat context: readable files inline within the shared token
 * budget, folders and unreadable or oversized files stay honest path-only
 * references the AmpleFile Agent inspects with its own tools.
 */
export async function loadAmpleFileAgentAttachmentsForTurn(
  refs: readonly AmpleFileAgentAttachmentRef[],
  availableTokens?: number,
): Promise<LoadedConversationContextAttachment[]> {
  const budgetTokens = chatContextBudgetTokens(availableTokens);
  let remaining = budgetTokens;
  const loaded: LoadedConversationContextAttachment[] = [];
  for (const ref of refs) {
    if (ref.kind === "url") continue;
    if (ref.kind === "folder") {
      loaded.push(pathOnlyAmpleFileAgentAttachment(ref, budgetTokens, "Folders are attached by path; inventory the folder with file tools before making claims about its contents."));
      continue;
    }
    loaded.push(await loadAmpleFileAgentFileAttachment(ref, remaining, budgetTokens));
    const last = loaded.at(-1)!;
    if (last.includedInPrompt) remaining -= last.estimatedTokens;
  }
  return loaded;
}

async function loadAmpleFileAgentFileAttachment(
  ref: AmpleFileAgentAttachmentRef,
  remaining: number,
  budgetTokens: number,
): Promise<LoadedConversationContextAttachment> {
  try {
    const info = await lstat(ref.target);
    if (!info.isFile()) throw new Error("The attached path is no longer an ordinary file.");
    if (remaining <= 0) throw new Error("No inline attachment capacity remains for this model and conversation. Read the file with tools.");
    if (info.size > maxAmpleFileAgentAttachmentFileBytes) {
      throw new Error("The file exceeds the 32 MB inline extraction budget. It remains available by path; inspect it with tools in the ranges needed.");
    }
    const bytes = await readFile(ref.target);
    const extracted = await readableAttachmentText(ref.name, bytes);
    const text = normalizeText(extracted.text);
    const estimatedTokens = estimateTokens(text);
    if (estimatedTokens > remaining) {
      return pathOnlyAmpleFileAgentAttachment(
        ref,
        budgetTokens,
        `The readable text is about ${estimatedTokens.toLocaleString()} tokens, which does not fit the remaining ${remaining.toLocaleString()} tokens of the context budget.`,
        info.size,
        estimatedTokens,
        extracted.provenance,
        extracted.warnings,
      );
    }
    return {
      sourcePath: ref.target,
      sourceFileName: ref.name,
      sourceSizeBytes: info.size,
      mode: extracted.mode,
      includedInPrompt: true,
      reason: null,
      estimatedTokens,
      budgetTokens,
      provenance: extracted.provenance,
      warnings: extracted.warnings,
      userLabel: extracted.mode === "full_original_text" ? "Full text" : "Extracted text",
      detail: `Attached from its original location (about ${estimatedTokens.toLocaleString()} tokens). The file was not copied anywhere; place it with \`amplefile files add\` when it belongs in a Connected Folder.`,
      text,
    };
  } catch (error) {
    return pathOnlyAmpleFileAgentAttachment(
      ref,
      budgetTokens,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function pathOnlyAmpleFileAgentAttachment(
  ref: AmpleFileAgentAttachmentRef,
  budgetTokens: number,
  reason: string,
  sourceSizeBytes = 0,
  estimatedTokens = 0,
  provenance: string[] = [],
  warnings: string[] = [],
): LoadedConversationContextAttachment {
  return {
    sourcePath: ref.target,
    sourceFileName: ref.name,
    sourceSizeBytes,
    mode: "path_only_reference",
    includedInPrompt: false,
    reason,
    estimatedTokens,
    budgetTokens,
    provenance,
    warnings,
    userLabel: "Path only",
    detail: `The absolute path is attached. Inspect it with file tools. Reason: ${reason}`,
    text: null,
  };
}
