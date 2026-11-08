import { useEffect, useState } from "react";

import {
  ampleFileBackgroundJobLimits,
  ampleFileExtensionUiLimits,
  ampleFileRequestContinuationsDefaultEnabled,
  ampleFileRequestLimits,
  ampleFileAutomationDeclarationBounds,
  ampleFileAutomationMaxConcurrentRuns,
  ampleFileRecentlyDeletedDefaultRetentionDays,
} from "../../../../src/shared/amplefile-limits";
import { api, errorText } from "../../lib/api";
import { showToast } from "../../ui/feedback";
import { ampleFileLimitsSettings } from "../../ui-contract";

/**
 * Settings → Automations → Limits (docs/act-ledger.md:
 * bounds are visible and named). Every request, job, and automation refusal
 * names this section, so this pane is where those phrases resolve.
 *
 * The bounds are frozen constants. The one adjustable number — how long
 * Recently Deleted keeps an item — is set in its own pane, which this one
 * links to, and the one switch — whether finished handed-out work is brought
 * back to its owner as a turn (docs/collaboration-contract.md) — lives
 * here. Every shown value is read from the frozen contract the host enforces
 * (`ampleFileExtensionUiLimits`, `ampleFileRequestLimits`,
 * `ampleFileAutomationDeclarationBounds`, `ampleFileAutomationMaxConcurrentRuns`,
 * `ampleFileBackgroundJobLimits`),
 * so the shown number cannot drift from the enforced one.
 */

interface RequestSettingsResponse {
  continuationsEnabled: boolean;
}

/**
 * The continuations switch. It loads from the running app and saves through a journaled
 * Settings act; without the app it shows the shipped default, disabled, and
 * says why. Turning it off changes nothing about what is recorded.
 */
function ContinuationsSwitch({ fixtureMode = false }: { fixtureMode?: boolean }) {
  // The browser preview shows the shipped default as the saved value and changes nothing.
  const [enabled, setEnabled] = useState<boolean | null>(fixtureMode ? ampleFileRequestContinuationsDefaultEnabled : null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fixtureMode) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await api<RequestSettingsResponse>("/api/settings/requests");
        if (!cancelled) setEnabled(response.continuationsEnabled);
      } catch {
        if (!cancelled) setError(ampleFileLimitsSettings.continuationsUnavailable);
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [fixtureMode]);

  async function save(next: boolean): Promise<void> {
    if (fixtureMode) {
      showToast({ text: ampleFileLimitsSettings.previewDisabled, tone: "info" });
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await api<RequestSettingsResponse>("/api/settings/requests/continuations", { method: "PUT", body: { enabled: next } });
      setEnabled(response.continuationsEnabled);
      setNotice(ampleFileLimitsSettings.continuationsSaved);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  const checked = enabled ?? ampleFileRequestContinuationsDefaultEnabled;
  return (
    <>
      <h4 id="amplefile-limits-continuations-title">{ampleFileLimitsSettings.continuationsHeading}</h4>
      <div className="settings-actions">
        <label htmlFor="amplefile-limits-continuations">
          <input
            id="amplefile-limits-continuations"
            type="checkbox"
            checked={checked}
            disabled={enabled === null || busy}
            onChange={(event) => { void save(event.target.checked); }}
          />
          {" "}
          {ampleFileLimitsSettings.continuationsLabel}
        </label>
        {notice ? <span className="settings-save-status" role="status">{notice}</span> : null}
        {error ? <span className="settings-inline-error" role="alert">{error}</span> : null}
      </div>
    </>
  );
}

function kib(bytes: number): string {
  const kibibytes = bytes / 1024;
  if (kibibytes >= 1024 * 1024) return `${formatNumber(kibibytes / (1024 * 1024))} GB`;
  if (kibibytes >= 1024) return `${formatNumber(kibibytes / 1024)} MB`;
  return `${formatNumber(kibibytes)} KB`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function LimitRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="context-meta-grid">
      {rows.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

export function AmpleFileLimitsPane({ onOpenRecentlyDeleted, fixtureMode = false }: { onOpenRecentlyDeleted?: () => void; fixtureMode?: boolean }) {
  const automation = ampleFileAutomationDeclarationBounds;
  const requests = ampleFileRequestLimits;
  const jobs = ampleFileBackgroundJobLimits;

  return (
    <details className="settings-section settings-limits">
      <summary className="settings-section-heading settings-limits-summary"><h3 id="amplefile-limits-title">{ampleFileLimitsSettings.heading}</h3></summary>
      {ampleFileLimitsSettings.frozenNote ? <span className="settings-section-note">{ampleFileLimitsSettings.frozenNote}</span> : null}

      <h4>Live Extension Questions</h4>
      <LimitRows rows={[
        ["Pending Extension questions per Chat", String(ampleFileExtensionUiLimits.pendingPerChat)],
        ["Pending Extension questions on this computer", String(ampleFileExtensionUiLimits.pendingTotal)],
        ["Choices in an Extension question", String(ampleFileExtensionUiLimits.options)],
        ["An Extension question", kib(ampleFileExtensionUiLimits.requestBytes)],
        ["An Extension answer or editor text", kib(ampleFileExtensionUiLimits.answerBytes)],
      ]} />

      <h4 id="amplefile-limits-requests-title">{ampleFileLimitsSettings.requestsHeading}</h4>
      <LimitRows
        rows={[
          ["Model spending for one request", requests.providerBudgetUsd === null ? "No limit" : `$${formatNumber(requests.providerBudgetUsd)}`],
          ["A question a Worker or the AmpleFile agent asks", kib(requests.maxQuestionTextBytes)],
          ["An answer you give", kib(requests.maxAnswerTextBytes)],
          ["A result summary", kib(requests.maxResultSummaryBytes)],
          ["Result Details", kib(requests.maxResultDataBytes)],
          ["Kept for", `${requests.retentionDays} days`],
        ]}
      />
      <ContinuationsSwitch fixtureMode={fixtureMode} />

      <h4 id="amplefile-limits-jobs-title">{ampleFileLimitsSettings.jobsHeading}</h4>
      <LimitRows
        rows={[
          ["How long a job runs", "No limit unless the job sets one"],
          ["Background jobs running on this computer", String(jobs.runningMachineWide)],
          ["A job's command", kib(jobs.maxCommandBytes)],
          ["Output kept for one job", `${kib(jobs.outputSegmentBytes * jobs.outputSegmentsKept)}, the newest part`],
          ["Output a Worker reads at once", `${jobs.readMaxLines.toLocaleString("en-US")} lines or ${kib(jobs.readMaxBytes)}`],
          ["Kept for", `${requests.retentionDays} days after a job ends`],
        ]}
      />

      <h4 id="amplefile-limits-automations-title">{ampleFileLimitsSettings.automationsHeading}</h4>
      <LimitRows
        rows={[
          ["Automation runs at once", String(ampleFileAutomationMaxConcurrentRuns)],
          ["Message a step sends", kib(automation.maxChatMessageBytes)],
          ["Message after filled-in details", kib(automation.maxResolvedMessageBytes)],
          ["One filled-in detail", `${kib(automation.maxPlaceholderTextBytes)}, up to ${automation.maxPlaceholderListItems} items`],
        ]}
      />

      <h4 id="amplefile-limits-deleted-title">{ampleFileLimitsSettings.deletedHeading}</h4>
      <LimitRows rows={[["Kept for", `${ampleFileRecentlyDeletedDefaultRetentionDays} days unless you change it`]]} />
      {onOpenRecentlyDeleted ? (
        <div className="settings-actions">
          <button className="ui-control" type="button" onClick={onOpenRecentlyDeleted}>
            {ampleFileLimitsSettings.deletedLink}
          </button>
        </div>
      ) : null}
    </details>
  );
}
