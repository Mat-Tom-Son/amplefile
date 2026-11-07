import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  assertAmpleFileAutomationAtAdmissionHorizon,
  contentAddressedAmpleFileAutomationDeclaration,
  normalizeAmpleFileAutomationProposal,
  readAmpleFileAutomationDocument,
  ampleFileAutomationDocumentMaxBytes,
  ampleFileAutomationProposalFileSuffix,
  type AmpleFileAutomationDeclaration,
} from "./automation-declarations.js";

/**
 * Pending automation proposals (docs/automations.md, "Where automations live
 * in the product"): the AmpleFile agent writes inert
 * `*.amplefile-automation.json` files at the top level of its working
 * folder, and Settings → Automations lists them so a person can turn one on
 * without the terminal.
 * The scan reads only that one folder, never recurses, and is bounded in
 * both file count and per-file size. A scanned file carries no authority:
 * turning it on re-reads the exact file through the same enable path as the
 * CLI, which pins its digest at that moment.
 */
export const ampleFileAutomationProposalScanBounds = Object.freeze({
  maxFiles: 1_000,
  maxFileBytes: ampleFileAutomationDocumentMaxBytes,
});

export type AmpleFileAutomationProposalScanEntry =
  | {
    valid: true;
    path: string;
    fileName: string;
    declaration: AmpleFileAutomationDeclaration;
    digest: string;
  }
  | {
    valid: false;
    path: string;
    fileName: string;
    problem: string;
    /** Stable identity survives a time-sensitive admission refusal. */
    normalized?: { declaration: AmpleFileAutomationDeclaration; digest: string };
  };

export interface AmpleFileAutomationProposalScan {
  entries: AmpleFileAutomationProposalScanEntry[];
  /** More proposal files exist than the scan bound admits. */
  truncated: boolean;
}

export async function scanAmpleFileAutomationProposals(
  folder: string,
  options: { now?: Date } = {},
): Promise<AmpleFileAutomationProposalScan> {
  const root = resolve(folder);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => isProposalFileName(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], truncated: false };
    throw error;
  }
  const admitted = names.slice(0, ampleFileAutomationProposalScanBounds.maxFiles);
  const entries: AmpleFileAutomationProposalScanEntry[] = [];
  for (const fileName of admitted) {
    entries.push(await scanOne(join(root, fileName), fileName, options.now ?? new Date()));
  }
  return { entries, truncated: names.length > admitted.length };
}

/**
 * Admits only an absolute path naming a proposal file directly inside the
 * AmpleFile agent's working folder; anything else is refused before it is read.
 */
export function resolveAmpleFileAutomationProposalPath(folder: string, path: unknown): string {
  if (typeof path !== "string" || !path || !isAbsolute(path)) {
    throw new Error("An absolute automation file path is required.");
  }
  const resolved = resolve(path);
  if (dirname(resolved) !== resolve(folder) || !isProposalFileName(basename(resolved))) {
    throw new Error("Only automation files in the AmpleFile agent's folder can be turned on here.");
  }
  return resolved;
}

function isProposalFileName(name: string): boolean {
  return name.endsWith(ampleFileAutomationProposalFileSuffix) && name.length > ampleFileAutomationProposalFileSuffix.length;
}

async function scanOne(path: string, fileName: string, now: Date): Promise<AmpleFileAutomationProposalScanEntry> {
  const invalid = (problem: string): AmpleFileAutomationProposalScanEntry => ({ valid: false, path, fileName, problem });
  let text: string;
  try {
    text = await readAmpleFileAutomationDocument(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("ordinary file")) return invalid("Not a regular file.");
    if (message.includes("exceeds the")) return invalid(`Larger than ${ampleFileAutomationDocumentMaxBytes / (1024 * 1024)} MiB.`);
    return invalid("Could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("Not valid JSON.");
  }
  let normalized: { declaration: AmpleFileAutomationDeclaration; digest: string };
  try {
    normalized = contentAddressedAmpleFileAutomationDeclaration(normalizeAmpleFileAutomationProposal(parsed));
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  try {
    assertAmpleFileAutomationAtAdmissionHorizon(normalized.declaration, now);
    return { valid: true, path, fileName, ...normalized };
  } catch (error) {
    return { valid: false, path, fileName, problem: error instanceof Error ? error.message : String(error), normalized };
  }
}
