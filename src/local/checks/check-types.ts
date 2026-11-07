import type { CheckCorrectionRecord } from "./check-corrections.js";
import type { AmpleFileCheckSeverity, AmpleFileCheckTarget } from "../../shared/checks.js";

export const ampleFileCheckStateVersion = 3 as const;
export const ampleFileCheckExperimentalSnapshotVersion = 1 as const;

export type AmpleFileCheckAggregateState =
  | "not-configured"
  | "current-clear"
  | "needs-attention"
  | "stale"
  | "blocked"
  | "check-error";

export type AmpleFileCheckRunState = "accepted" | "running" | "succeeded" | "failed" | "aborted" | "interrupted";
export type AmpleFileCheckDecisionKind = "accept" | "reject" | "resolve" | "defer";

export interface AmpleFileCheckRunLimits {
  maximumFiles: number;
  maximumFileBytes: number;
  maximumTotalBytes: number;
  maximumFindings: number;
  timeoutMs: number;
}

export interface AmpleFileCheckFileIdentity {
  checkId: string;
  path: string;
  state: "file" | "missing";
  sha256?: string;
  size?: number;
  modifiedAt?: string;
}

export interface AmpleFileCheckPathStateEvidence {
  kind: "path-state";
  path: string;
  expected: "file" | "missing";
  observed: "file" | "missing";
  identity: AmpleFileCheckFileIdentity;
}

export interface AmpleFileCheckTextSpanEvidence {
  kind: "text-span";
  path: string;
  start: number;
  end: number;
  quote: string;
  identity: AmpleFileCheckFileIdentity;
  /** All reviewed inputs, including references, bind the judgment's context. */
  context: AmpleFileCheckFileIdentity[];
}

export type AmpleFileCheckEvidence = AmpleFileCheckPathStateEvidence | AmpleFileCheckTextSpanEvidence;

export interface AmpleFileCheckCandidateFinding {
  title: string;
  detail?: string;
  remediation?: string;
  targetPath: string;
  evidence: AmpleFileCheckEvidence[];
}

export interface AmpleFileCheckFinding extends AmpleFileCheckCandidateFinding {
  id: string;
  fingerprint: string;
  checkId: string;
  declarationDigest: string;
  sensorId: string;
  sensorRevision: number;
  sensorDigest: string;
  severity: AmpleFileCheckSeverity;
  observedAt: string;
  status: "active" | "invalidated" | "superseded";
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface AmpleFileCheckDecision {
  fingerprint: string;
  decision: AmpleFileCheckDecisionKind;
  decidedAt: string;
  actor: "human" | "assistant" | "cli" | "renderer";
  deferUntil?: string;
  note?: string;
}

export interface AmpleFileCheckAuthorization {
  checkId: string;
  declarationDigest: string;
  sensorId: string;
  sensorRevision: number;
  sensorDigest: string;
  enabledAt: string;
  enabledBy: "human" | "assistant" | "cli" | "renderer";
  execution: "deterministic" | "model";
  limits: AmpleFileCheckRunLimits;
}

export interface AmpleFileCheckRunRecord {
  /** One-time review, excluded from live findings, freshness, and automation triggers. */
  trial?: true;
  id: string;
  taskId: string;
  checkIds: string[];
  startedAt: string;
  endedAt?: string;
  state: AmpleFileCheckRunState;
  authorities: Array<{
    checkId: string;
    declarationDigest: string;
    sensorId: string;
    sensorRevision: number;
    sensorDigest: string;
  }>;
  limits: AmpleFileCheckRunLimits;
  inputs: AmpleFileCheckFileIdentity[];
  findings: AmpleFileCheckFinding[];
  admittedCount: number;
  discardedCount: number;
  skippedCount: number;
  error?: string;
  cost?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    amountUsd?: number;
  };
}

export interface AmpleFileCheckMachineState {
  version: typeof ampleFileCheckStateVersion;
  revision: number;
  authorizations: Record<string, AmpleFileCheckAuthorization>;
  decisions: Record<string, AmpleFileCheckDecision>;
  runs: AmpleFileCheckRunRecord[];
  corrections?: CheckCorrectionRecord[];
}

/** Experimental, content-free summary. Titles, paths, evidence, and decisions are excluded. */
export interface AmpleFileCheckStatusSnapshot {
  kind: "amplefile.checks.experimental";
  version: typeof ampleFileCheckExperimentalSnapshotVersion;
  connectedFolderId: string;
  state: AmpleFileCheckAggregateState;
  configured: number;
  proposed: number;
  enabled: number;
  current: number;
  neverRun: number;
  stale: number;
  blocked: number;
  errors: number;
  needsAttention: number;
  running: number;
  lastRunAt: string | null;
}

export type AmpleFileCheckRendererAuthorityState = "enabled" | "proposed" | "blocked";

/**
 * Content-bearing projection for the authenticated desktop renderer. This is
 * deliberately separate from the content-free CLI status snapshot: paths,
 * titles, evidence, and decisions must never leak into protocol v1.
 */
export interface AmpleFileCheckRendererOverview {
  kind: "amplefile.checks.renderer";
  version: typeof ampleFileCheckExperimentalSnapshotVersion;
  connectedFolderId: string;
  status: AmpleFileCheckStatusSnapshot;
  checks: Array<{
    id: string;
    digest?: string;
    title: string;
    severity: AmpleFileCheckSeverity;
    trigger: "manual";
    sensor: { id: string; revision: number };
    criteria?: string;
    execution?: "deterministic" | "model";
    targets: AmpleFileCheckTarget[];
    authority: AmpleFileCheckRendererAuthorityState;
  }>;
  findings: AmpleFileCheckFinding[];
  corrections?: CheckCorrectionRecord[];
  invalidated: number;
  healthErrors: string[];
  truncated: boolean;
}

/** Minimal file-path projection used only for quiet Files decorations. */
export interface AmpleFileCheckRendererDecorations {
  kind: "amplefile.checks.decorations";
  version: typeof ampleFileCheckExperimentalSnapshotVersion;
  connectedFolderId: string;
  items: Array<{ path: string; count: number }>;
}
