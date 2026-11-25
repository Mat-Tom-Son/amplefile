import type { AutomationCatchUpReason, AutomationOutcome, AutomationTriggerView } from "./automation-presentation.js";

/**
 * Settings → Automations as the host serves it over the desktop bridge
 * (src/shared/desktop-ipc.ts): the host resolves Connected Folder names, safe
 * details, run groups, and evidence identifiers before they reach the window.
 * The in-process facade (src/local/api/automation-settings.ts) returns these
 * shapes; the desktop main process's typed handlers check that it does.
 */

export type AutomationHealthState = "enabled" | "disabled" | "suspended" | "completed";

export interface AutomationConnectedFolderRef {
  connectedFolderId: string;
  connectedFolderName?: string;
}

export type AutomationStepView =
  | {
    id: string;
    kind: "chat";
    connectedFolder: AutomationConnectedFolderRef;
    message: string;
    model?: { provider: string; id: string };
  }
  | {
    id: string;
    kind: "files";
    fromConnectedFolder: AutomationConnectedFolderRef;
    toConnectedFolder: AutomationConnectedFolderRef;
    to: string;
    source:
      | { kind: "paths"; paths: string[] }
      | { kind: "tree"; path: string; recursive: boolean; extensions: string[] }
      | { kind: "step-created-files"; step: string; extensions?: string[]; maxFiles: number; maxTotalBytes: number };
  }
  | {
    id: string;
    kind: "agent";
    message: string;
    model?: { provider: string; id: string };
  };

export interface AutomationSummaryView {
  automationId: string;
  title: string;
  health: AutomationHealthState;
  trigger: AutomationTriggerView;
  fileWatch?: {
    state: "starting" | "watching" | "paused" | "error";
    detail?: string;
    lastObservedAt?: string;
    lastTriggeredAt?: string;
    /** A catch-up found and waiting for the folder to settle, its cooldown, or other automation work. */
    catchingUp?: { reason: AutomationCatchUpReason; count: number };
    lastCatchUpAt?: string;
    notice?: string;
  };
  stepCount: number;
  /** Every Connected Folder the trigger or a step names; drives the Connected Folder filter. */
  connectedFolders?: AutomationConnectedFolderRef[];
  nextScheduledAt?: string;
  lastScheduledAt?: string;
  activeRun?: { runId: string; startedAt: string };
  lastRun?: {
    runId: string;
    outcome: AutomationOutcome;
    startedAt: string;
    finishedAt?: string;
    partial?: true;
  };
  /** The newest run that caught up on files changed while AmpleFile could not watch. */
  lastCatchUp?: { runId: string; at: string; count: number; reason: AutomationCatchUpReason };
  suspension?: {
    at: string;
    reason?: string;
    missingConnectedFolders?: AutomationConnectedFolderRef[];
  };
}

export interface AutomationDetailView extends AutomationSummaryView {
  createdAt: string;
  createdBy?: string;
  connectedFolders: AutomationConnectedFolderRef[];
  steps: AutomationStepView[];
  completedAt?: string;
}

export interface AutomationHistoryHopView {
  hopId: string;
  kind: "chat" | "files" | "agent";
  outcome: AutomationOutcome;
  partial?: true;
  connectedFolderName?: string;
  detail?: string;
  evidence?: Array<{ label: string; value: string }>;
}

export interface AutomationHistoryRunView {
  runId: string;
  outcome: AutomationOutcome;
  startedAt: string;
  finishedAt?: string;
  cause?: string;
  detail?: string;
  partial?: true;
  hops: AutomationHistoryHopView[];
}

export interface AutomationsResponse {
  automations: AutomationSummaryView[];
  status: {
    storeDamaged: boolean;
    storeDamageReason?: string;
    journalDamaged: boolean;
    journalDamageReason?: string;
    activeRunCount: number;
  };
}

export interface AutomationDetailResponse {
  automation: AutomationDetailView;
}

export interface AutomationHistoryResponse {
  runs: AutomationHistoryRunView[];
  truncated: boolean;
  damagedLineCount: number;
}

/** A `*.amplefile-automation.json` file the AmpleFile Agent wrote that is not stored yet. */
export type AutomationProposalView =
  | {
    valid: true;
    path: string;
    fileName: string;
    automationId: string;
    digest: string;
    title: string;
    trigger: AutomationTriggerView;
  }
  | { valid: false; path: string; fileName: string; problem: string };

export interface AutomationProposalsResponse {
  proposals: AutomationProposalView[];
  truncated: boolean;
}

/** Turning one Automation on, from Settings or a ready-made one in the Info panel. */
export interface AutomationEnableResponse {
  automationId: string;
  requestId: string;
  enabled: true;
  alreadyEnabled: boolean;
}

/** Turning on a pending `*.amplefile-automation.json` file: the same enable, with the stored Automation. */
export interface AutomationEnableProposalResponse extends AutomationEnableResponse {
  automation: AutomationSummaryView;
}

export interface AutomationRunResponse {
  automationId: string;
  requestId: string;
  runId: string;
  accepted: true;
}

export interface AutomationStopResponse {
  automationId: string;
  requestId: string;
  runId: string;
  stopped: true;
}

export interface AutomationDisableResponse {
  automationId: string;
  requestId: string;
  disabled: true;
  stoppedRunId: string | null;
}

export interface AutomationDeleteResponse {
  automationId: string;
  requestId: string;
  deleted: true;
}
