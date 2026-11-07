import { loadCheckTextSnapshots, modelCheckLimits } from "./check-text.js";
import { modelReviewTextLimits } from "./model-review-sensor.js";
import { randomUUID } from "node:crypto";

import type { AmpleFileCheckDeclaration } from "../../shared/checks.js";
import { normalizeAmpleFileCheckTargetPath } from "../../shared/checks.js";
import { ampleFileCheckFingerprint } from "./check-integrity.js";
import type {
  AmpleFileCheckCandidateFinding,
  AmpleFileCheckEvidence,
  AmpleFileCheckFinding,
} from "./check-types.js";
import { resolveAmpleFileCheckTargets } from "./target-resolver.js";

export async function admitAmpleFileCheckCandidate(input: {
  root: string;
  declaration: AmpleFileCheckDeclaration;
  declarationDigest: string;
  sensorDigest: string;
  candidate: AmpleFileCheckCandidateFinding;
  now?: Date;
  signal?: AbortSignal;
}): Promise<AmpleFileCheckFinding | null> {
  if (input.signal?.aborted) throw new Error(String(input.signal.reason || "Check admission was aborted."));
  let targetPath: string;
  let title: string;
  let detail: string | undefined;
  let remediation: string | undefined;
  try {
    targetPath = normalizeAmpleFileCheckTargetPath(input.candidate.targetPath, "Finding target path");
    title = boundedDisplayText(input.candidate.title, "Finding title", 300);
    detail = input.candidate.detail ? boundedDisplayText(input.candidate.detail, "Finding detail", 2_000) : undefined;
    remediation = input.candidate.remediation ? boundedDisplayText(input.candidate.remediation, "Finding remediation", 2_000) : undefined;
  } catch {
    return null;
  }
  if (!declarationContainsPath(input.declaration, targetPath) || !input.declaration.targets.some((target) => target.role === "primary" && (target.path === targetPath || target.kind === "tree" && targetPath.startsWith(`${target.path}/`)))) return null;
  if (!Array.isArray(input.candidate.evidence) || input.candidate.evidence.length < 1 || input.candidate.evidence.length > 16) return null;
  for (const evidence of input.candidate.evidence) {
    if (input.signal?.aborted) throw new Error(String(input.signal.reason || "Check admission was aborted."));
    if (!await verifyAmpleFileCheckEvidence(input.root, evidence, input.declaration)) return null;
  }
  const evidence = structuredClone(input.candidate.evidence);
  const fingerprint = ampleFileCheckFingerprint({
    checkId: input.declaration.id,
    declarationDigest: input.declarationDigest,
    sensorId: input.declaration.sensor.id,
    sensorRevision: input.declaration.sensor.revision,
    sensorDigest: input.sensorDigest,
    targetPath,
    evidence: evidence.map(semanticEvidenceIdentity),
  });
  return {
    id: `finding-record-${randomUUID()}`,
    fingerprint,
    checkId: input.declaration.id,
    declarationDigest: input.declarationDigest,
    sensorId: input.declaration.sensor.id,
    sensorRevision: input.declaration.sensor.revision,
    sensorDigest: input.sensorDigest,
    severity: input.declaration.severity,
    title,
    ...(detail ? { detail } : {}),
    ...(remediation ? { remediation } : {}),
    targetPath,
    evidence,
    observedAt: (input.now ?? new Date()).toISOString(),
    status: "active",
  };
}

export async function reverifyAmpleFileCheckFinding(
  root: string,
  declaration: AmpleFileCheckDeclaration,
  finding: AmpleFileCheckFinding,
): Promise<boolean> {
  if (finding.status !== "active" || finding.checkId !== declaration.id) return false;
  if (finding.sensorId !== declaration.sensor.id || finding.sensorRevision !== declaration.sensor.revision) return false;
  if (!declarationContainsPath(declaration, finding.targetPath)) return false;
  for (const evidence of finding.evidence) {
    if (!await verifyAmpleFileCheckEvidence(root, evidence, declaration)) return false;
  }
  return ampleFileCheckFingerprint({
    checkId: declaration.id,
    declarationDigest: finding.declarationDigest,
    sensorId: declaration.sensor.id,
    sensorRevision: declaration.sensor.revision,
    sensorDigest: finding.sensorDigest,
    targetPath: finding.targetPath,
    evidence: finding.evidence.map(semanticEvidenceIdentity),
  }) === finding.fingerprint;
}

export async function verifyAmpleFileCheckEvidence(
  root: string,
  evidence: AmpleFileCheckEvidence,
  declaration: AmpleFileCheckDeclaration,
): Promise<boolean> {
  if (evidence.kind === "text-span") {
    if (declaration.sensor.id !== "amplefile.text-review" || evidence.identity.checkId !== declaration.id
      || evidence.identity.path !== evidence.path || !Number.isSafeInteger(evidence.start) || evidence.start < 0
      || !Number.isSafeInteger(evidence.end) || typeof evidence.quote !== "string" || !evidence.quote.trim()
      || evidence.quote.length > modelReviewTextLimits.quote || evidence.end - evidence.start !== evidence.quote.length
      || !Array.isArray(evidence.context)) return false;
    try {
      const resolution = await resolveAmpleFileCheckTargets(root, declaration.targets, {
        limits: {
          maxFiles: modelCheckLimits.maximumFiles,
          maxFileBytes: modelCheckLimits.maximumFileBytes,
          maxTotalBytes: modelCheckLimits.maximumTotalBytes,
        },
      });
      const snapshots = await loadCheckTextSnapshots(root, resolution);
      if (snapshots.length !== evidence.context.length || new Set(evidence.context.map((input) => input.path)).size !== snapshots.length) return false;
      for (const snapshot of snapshots) {
        const identity = evidence.context.find((item) => item.path === snapshot.path);
        if (!identity || identity.checkId !== declaration.id || identity.state !== "file" || identity.sha256 !== snapshot.sha256) return false;
      }
      const target = snapshots.find((file) => file.path === evidence.path && file.roles.includes("primary"));
      return !!target && target.sha256 === evidence.identity.sha256 && target.text.slice(evidence.start, evidence.end) === evidence.quote;
    } catch { return false; }
  }
  if (evidence.kind !== "path-state") return false;
  let path: string;
  try {
    path = normalizeAmpleFileCheckTargetPath(evidence.path, "Evidence path");
  } catch {
    return false;
  }
  if (evidence.identity.path !== path || !declarationContainsPath(declaration, path)) return false;
  if (evidence.expected === evidence.observed || evidence.identity.state !== evidence.observed) return false;
  const resolution = await resolveAmpleFileCheckTargets(root, [{ kind: "file", role: "primary", path }]);
  const observed = resolution.files.some((file) => file.path === path) ? "file" : "missing";
  return observed === evidence.observed;
}

function semanticEvidenceIdentity(evidence: AmpleFileCheckEvidence): unknown {
  if (evidence.kind === "text-span") return { kind: evidence.kind, path: evidence.path, start: evidence.start, end: evidence.end, quote: evidence.quote, sha256: evidence.identity.sha256, context: evidence.context.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)) };
  return {
    kind: evidence.kind,
    path: evidence.path,
    expected: evidence.expected,
    observed: evidence.observed,
  };
}

function declarationContainsPath(declaration: AmpleFileCheckDeclaration, path: string): boolean {
  return declaration.targets.some((target) => {
    if (target.kind === "file") return target.path === path;
    if (!path.startsWith(`${target.path}/`)) return false;
    const relativePath = path.slice(target.path.length + 1);
    if (!target.recursive && relativePath.includes("/")) return false;
    const normalizedPath = path.toLocaleLowerCase("en-US");
    return target.extensions.some((extension) => normalizedPath.endsWith(extension));
  });
}

function boundedDisplayText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(normalized)) {
    throw new Error(`${label} is invalid or too long.`);
  }
  return normalized;
}
