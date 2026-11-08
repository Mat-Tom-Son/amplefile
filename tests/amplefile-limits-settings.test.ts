import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";

import {
  ampleFileRequestLimitMessage,
  type AmpleFileRequestLimitName,
} from "../src/local/requests/request-records.js";
import {
  ampleFileBackgroundJobLimits,
  ampleFileExtensionUiLimits,
  ampleFileRequestLimits,
  ampleFileAutomationDeclarationBounds,
  ampleFileAutomationMaxConcurrentRuns,
} from "../src/shared/amplefile-limits.js";
import { AmpleFileLimitsPane } from "../web-local/src/components/modals/AmpleFileLimitsPane.js";
import { createDomHarness } from "./support/dom.js";

/**
 * Settings → Automations → Limits (docs/act-ledger.md).
 * Bounds are defaults, not gates, and they are visible in Settings. Every
 * request, job, and Extension refusal names "Settings → Automations → Limits", so this suite pins
 * that the section exists, that it is read-only, and that the numbers it shows
 * are the frozen constants the host enforces rather than retyped copies.
 */

const [settingsSource, paneSource, extensionUiSource] = await Promise.all([
  readFile(new URL("../web-local/src/components/modals/DesktopSettingsModal.tsx", import.meta.url), "utf8"),
  readFile(new URL("../web-local/src/components/modals/AmpleFileLimitsPane.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/local/agent/extension-ui.ts", import.meta.url), "utf8"),
]);

/** The pane's own rendering: KB below one MB, MB from there. */
function sizeText(bytes: number): string {
  const kibibytes = bytes / 1024;
  const value = kibibytes >= 1024 ? kibibytes / 1024 : kibibytes;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${kibibytes >= 1024 ? "MB" : "KB"}`;
}

test("the surface every limit message names is a real fold Settings section", () => {
  // The phrase the refusals interpolate.
  assert.match(extensionUiSource, /Settings → Automations → Limits/, "Extension question refusals name the Limits section");
  assert.match(ampleFileRequestLimitMessage("resultSummary", 1), /Settings → Automations → Limits/, "request refusals name the Limits section");
  assert.match(settingsSource, /type SettingsSection = [^;]*\| "limits";/);
  assert.match(settingsSource, /id: "automations", label: "Automations"/);
  assert.match(settingsSource, /page === "automations" \? \(\s*<div[^>]*>\s*<AutomationsPane fixtureMode=\{fixtureMode\} \/>\s*<AmpleFileLimitsPane onOpenRecentlyDeleted=\{\(\) => setPage\("recently-deleted"\)\} fixtureMode=\{fixtureMode\} \/>/);
});

test("the Limits pane reads the frozen contracts instead of retyping them", () => {
  for (const contract of [
    "ampleFileExtensionUiLimits",
    "ampleFileRequestLimits",
    "ampleFileAutomationDeclarationBounds",
    "ampleFileAutomationMaxConcurrentRuns",
    "ampleFileBackgroundJobLimits",
  ]) {
    assert.ok(paneSource.includes(contract), `the pane sources ${contract}`);
  }
  // Nothing here changes a bound, and nothing here is a gate. The one control
  // is the switch for bringing finished handed-out work back to the AmpleFile
  // agent as a continuation turn (docs/collaboration-contract.md); it is the
  // only input and the only API call the pane makes, and turning it off
  // records everything just the same.
  const inputs = paneSource.match(/<input\b/g) ?? [];
  assert.equal(inputs.length, 1, "the pane has exactly one control: the continuation switch");
  assert.match(paneSource, /type="checkbox"/);
  const apiCalls = paneSource.match(/\bapi</g) ?? [];
  assert.equal(apiCalls.length, 2, "one read and one save of the continuation setting, nothing else");
  assert.match(paneSource, /\/api\/settings\/requests\/continuations/);
  assert.doesNotMatch(paneSource, /staged|approve|policy|Reviewed|Unrestricted|\bcard\b|\bmode\b/i);
});

test("the Limits pane shows the request, job, Extension, and automation numbers a refusal can name", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  await dom.render(createElement(AmpleFileLimitsPane));
  const text = dom.container.textContent ?? "";

  assert.doesNotMatch(text, /How long one request stays open|Steps in one automation|Follow-up turns after work settles|Worker turns running together/);
  // No app limits: Worker requests, short answers, and named automations from apps.
  assert.doesNotMatch(text, /Worker Requests|Short answer|per app|App Automations|returned to the app/);
  assert.ok(text.includes(`Automation runs at once${ampleFileAutomationMaxConcurrentRuns}`), "the raised run-slot default is shown");
  assert.ok(text.includes(`Message a step sends${sizeText(ampleFileAutomationDeclarationBounds.maxChatMessageBytes)}`), "the step message bound is shown");

  // The request bounds every collaboration refusal names (docs/collaboration-contract.md).
  assert.ok(text.includes("Model spending for one requestNo limit"), "no spending cap is shipped");
  assert.ok(text.includes(`A result summary${sizeText(ampleFileRequestLimits.maxResultSummaryBytes)}`), "the summary bound is shown");
  assert.ok(text.includes(`Result Details${sizeText(ampleFileRequestLimits.maxResultDataBytes)}`), "the data bound is shown");
  assert.ok(text.includes(`Pending Extension questions per Chat${ampleFileExtensionUiLimits.pendingPerChat}`));
  // Background jobs (docs/background-jobs.md): the running bound a refused start names.
  assert.ok(text.includes(`Background jobs running on this computer${ampleFileBackgroundJobLimits.runningMachineWide}`));
  assert.ok(text.includes("How long a job runsNo limit unless the job sets one"));
  assert.ok(text.includes("Output kept for one job1 GB, the newest part"));
  assert.ok(text.includes(`An Extension answer or editor text${sizeText(ampleFileExtensionUiLimits.answerBytes)}`));
});

/**
 * Current request transport bounds and the optional spending cap point at
 * Settings → Automations → Limits. Historical quota names remain readable in
 * durable records but must not reappear as current limits in this pane.
 */
test("current request transport bounds and the optional budget have rows in Limits", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  await dom.render(createElement(AmpleFileLimitsPane));
  const text = dom.container.textContent ?? "";

  const limits = ampleFileRequestLimits;
  const rows: Partial<Record<AmpleFileRequestLimitName, string>> = {
    providerBudget: "Model spending for one requestNo limit",
    questionText: `A question a Worker or the AmpleFile Agent asks${sizeText(limits.maxQuestionTextBytes)}`,
    answerText: `An answer you give${sizeText(limits.maxAnswerTextBytes)}`,
    resultSummary: `A result summary${sizeText(limits.maxResultSummaryBytes)}`,
    resultData: `Result Details${sizeText(limits.maxResultDataBytes)}`,
  };

  for (const [name, row] of Object.entries(rows) as Array<[AmpleFileRequestLimitName, string]>) {
    assert.match(
      ampleFileRequestLimitMessage(name, 1),
      /Settings → Automations → Limits shows this number\.$/,
      `the ${name} refusal points at the Limits pane`,
    );
    assert.ok(text.includes(row), `the ${name} bound has a row reading "${row}"`);
  }
});

test("the Limits pane links to Recently deleted rather than setting retention itself", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  let opened = 0;
  await dom.render(createElement(AmpleFileLimitsPane, { onOpenRecentlyDeleted: () => { opened += 1; } }));
  const link = [...dom.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Open Recently Deleted");
  assert.ok(link, "the pane offers a way into Recently deleted");
  await dom.act(() => { link?.click(); });
  assert.equal(opened, 1);
});
