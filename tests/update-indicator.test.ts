import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import type { AgentStatus, ConnectedFolderSummary, DesktopUpdateStatus } from "../web-local/src/types.js";
import { updateActionLabel, updateCallFor, updateIndicatorFor, updateIsBusy, type UpdatePhase } from "../web-local/src/lib/update-status.js";
import { buildFixtureUpdateStatus, fixtureAvailableVersion, fixtureUpdatePhaseFromQuery, fixtureUpdatePhases } from "../web-local/src/fixtures/settings-fixture.js";
import { createDomHarness } from "./support/dom.js";

// Settings includes brand artwork and Fluent icons; Node needs only inert stand-ins.
const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:update-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:update-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(png|svg)$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { DesktopSettingsModal: SettingsModal } = await import("../web-local/src/components/modals/DesktopSettingsModal.js");
const { UpdateIndicator } = await import("../web-local/src/components/file-manager/UpdateIndicator.js");
assets.deregister();
const { useApplicationAppearance } = await import("../web-local/src/hooks/useApplicationAppearance.js");
function DesktopSettingsModal(props: Omit<Parameters<typeof SettingsModal>[0], "appearance">) {
  const appearance = useApplicationAppearance({ fixtureMode: true });
  return createElement(SettingsModal, { ...props, appearance });
}

const allPhases: UpdatePhase[] = ["unsupported", "idle", "checking", "available", "not_available", "downloading", "ready", "installing", "error"];
const status = (phase: UpdatePhase, changes: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus => ({
  supported: true, phase, currentVersion: "0.1.4", availableVersion: "0.1.5", progressPercent: null, checkedAt: null, message: "", error: null, ...changes,
});

test("each update phase maps to one updater call, Settings label, and indicator", () => {
  const expected: Record<UpdatePhase, { call: ReturnType<typeof updateCallFor>; settings: string; indicator: string | null; click: string | null }> = {
    unsupported: { call: "check", settings: "Check for Updates", indicator: null, click: null },
    idle: { call: "check", settings: "Check for Updates", indicator: null, click: null },
    checking: { call: null, settings: "Checking", indicator: null, click: null },
    not_available: { call: "check", settings: "Check for Updates", indicator: null, click: null },
    available: { call: "updateNow", settings: "Update and Restart", indicator: "Update Available", click: "update" },
    downloading: { call: null, settings: "Downloading", indicator: "Downloading", click: "open-about" },
    ready: { call: "install", settings: "Restart and Install", indicator: "Restart to Update", click: "update" },
    installing: { call: null, settings: "Restarting", indicator: "Restarting to Update", click: null },
    error: { call: "updateNow", settings: "Retry", indicator: "Update Failed", click: "open-about" },
  };
  for (const phase of allPhases) {
    const want = expected[phase];
    assert.equal(updateCallFor(status(phase)), want.call, `${phase} call`);
    assert.equal(updateIsBusy(phase), want.call === null, `${phase} busy`);
    assert.equal(updateActionLabel(status(phase)), want.settings, `${phase} Settings label`);
    const model = updateIndicatorFor(status(phase));
    assert.equal(model?.label ?? null, want.indicator, `${phase} indicator label`);
    assert.equal(model?.click ?? null, want.click, `${phase} indicator click`);
    // The indicator only offers the updater call where Settings' button is live.
    if (model?.click === "update") assert.notEqual(updateCallFor(status(phase)), null, `${phase} offers a call Settings would make`);
  }
});

test("a failed check draws nothing in the sidebar and retrying it only checks again", () => {
  const failedCheck = status("error", { availableVersion: null, message: "Update check failed.", error: "No published versions." });
  assert.equal(updateIndicatorFor(failedCheck), null, "no Update Failed in the sidebar when nothing was being updated");
  assert.equal(updateCallFor(failedCheck), "check", "Retry after a failed check cannot end in a restart");
  assert.equal(updateActionLabel(failedCheck), "Check Again");
  const failedDownload = status("error", { message: "Update download failed.", error: "The network connection was lost." });
  assert.equal(updateIndicatorFor(failedDownload)?.label, "Update Failed");
  assert.equal(updateCallFor(failedDownload), "updateNow");
  assert.equal(updateActionLabel(failedDownload), "Retry");
  assert.equal(updateCallFor(null), "check");
});

test("an unknown phase or a missing percent never draws an empty button or NaN", () => {
  const unknown = status("verifying" as UpdatePhase);
  assert.equal(updateIndicatorFor(unknown), null);
  assert.equal(updateCallFor(unknown), "check");
  assert.equal(updateActionLabel(unknown), "Check for Updates", "Settings never shows an empty, enabled button");
  for (const progressPercent of [undefined, Number.NaN, "42" as unknown]) {
    const downloading = status("downloading", { progressPercent: progressPercent as number | null });
    assert.equal(updateIndicatorFor(downloading)!.detail, null);
    assert.equal(updateIndicatorFor(downloading)!.progressPercent, null);
    assert.equal(updateIndicatorFor(downloading)!.accessibleName, "Downloading Update");
    assert.equal(updateActionLabel(downloading), "Downloading");
  }
  assert.equal(updateIndicatorFor(status("downloading", { progressPercent: 140 }))!.detail, "100%");
});

test("the indicator names the version and progress the status carries, and hides off the desktop", () => {
  assert.equal(updateIndicatorFor(null), null);
  assert.equal(updateIndicatorFor(status("available", { supported: false })), null, "an unsupported updater shows nothing");
  const available = updateIndicatorFor(status("available"))!;
  assert.equal(available.detail, "0.1.5");
  assert.match(available.accessibleName, /^Update Available/);
  assert.match(available.accessibleName, /0\.1\.5/);
  assert.match(available.tooltip, /restart to install/, "the tooltip says the app restarts to install");
  assert.match(available.tooltip, /asks first/, "and that it asks before restarting");
  assert.equal(updateIndicatorFor(status("available", { availableVersion: null }))!.detail, null);
  assert.equal(updateIndicatorFor(status("available", { availableVersion: null }))!.accessibleName, "Update Available");
  assert.deepEqual(["available", "downloading", "ready", "installing", "error"].map((phase) => updateIndicatorFor(status(phase as UpdatePhase))!.shortLabel), ["Update", "Downloading", "Restart", "Restarting", "Failed"]);
  const downloading = updateIndicatorFor(status("downloading", { progressPercent: 41.6 }))!;
  assert.equal(downloading.detail, "42%");
  assert.equal(downloading.progressPercent, 41.6);
  assert.equal(downloading.accessibleName, "Downloading Update, 42%");
  assert.equal(updateIndicatorFor(status("downloading"))!.detail, null, "no progress yet shows no number");
  assert.equal(updateActionLabel(status("downloading", { progressPercent: 41.6 })), "42%");
  assert.match(updateIndicatorFor(status("ready"))!.accessibleName, /^Restart to Update: AmpleFile 0\.1\.5$/);
  assert.match(updateIndicatorFor(status("error"))!.accessibleName, /^Update Failed/);
});

test("the preview's &update= parameter gives a sample status for each phase", () => {
  assert.equal(fixtureUpdatePhaseFromQuery("?fixture=connected-folder&update=ready"), "ready");
  assert.equal(fixtureUpdatePhaseFromQuery("?fixture=connected-folder&update=nonsense"), null);
  assert.equal(fixtureUpdatePhaseFromQuery("?fixture=connected-folder"), null);
  for (const phase of fixtureUpdatePhases) {
    const sample = buildFixtureUpdateStatus(phase);
    assert.equal(sample.phase, phase);
    assert.equal(sample.supported, true);
    assert.equal(Boolean(updateIndicatorFor(sample)), phase !== "not_available", `${phase} indicator presence`);
  }
  assert.equal(buildFixtureUpdateStatus().phase, "not_available", "Settings' default preview stays up to date");
  assert.equal(buildFixtureUpdateStatus("available").availableVersion, fixtureAvailableVersion);
  assert.equal(buildFixtureUpdateStatus("downloading").progressPercent, 42);
  assert.ok(buildFixtureUpdateStatus("error").error);
});

test("the indicator shows, hides, and runs the right action in each phase", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  let updates = 0;
  let abouts = 0;
  const render = (value: DesktopUpdateStatus | null) => dom.render(createElement(UpdateIndicator, { status: value, onUpdateAction: () => { updates += 1; }, onOpenAbout: () => { abouts += 1; } }));
  const button = () => dom.container.querySelector<HTMLButtonElement>("button.fm-update-button");
  const click = async () => dom.act(() => button()!.click());

  for (const phase of ["unsupported", "idle", "checking", "not_available"] as const) {
    await render(status(phase));
    assert.equal(dom.container.querySelector(".fm-update"), null, `${phase} draws nothing`);
    assert.equal(dom.container.querySelector('[role="status"]')!.textContent, "", `${phase} announces nothing`);
  }
  await render(null);
  assert.equal(dom.container.querySelector(".fm-update"), null);

  await render(status("available"));
  assert.equal(button()!.type, "button");
  assert.equal(button()!.getAttribute("aria-label"), "Update Available: AmpleFile 0.1.5");
  assert.ok(button()!.title);
  assert.equal(button()!.hasAttribute("aria-disabled"), false);
  assert.equal(button()!.querySelector(".fm-update-label-full")!.textContent, "Update Available");
  assert.equal(button()!.querySelector(".fm-update-detail")!.textContent, "0.1.5");
  await click();
  assert.deepEqual({ updates, abouts }, { updates: 1, abouts: 0 });

  await render(status("downloading", { progressPercent: 42 }));
  assert.equal(button()!.getAttribute("aria-label"), "Downloading Update, 42%");
  assert.equal(button()!.querySelector<HTMLElement>(".fm-update-dot")!.style.getPropertyValue("--fm-update-progress"), "42%");
  await click();
  assert.deepEqual({ updates, abouts }, { updates: 1, abouts: 1 }, "a click while downloading opens About and never restarts the download");

  await render(status("ready"));
  assert.equal(button()!.querySelector(".fm-update-label-full")!.textContent, "Restart to Update");
  await click();
  assert.deepEqual({ updates, abouts }, { updates: 2, abouts: 1 }, "ready installs through the shared update action");

  await render(status("installing"));
  assert.equal(button()!.getAttribute("aria-disabled"), "true");
  await click();
  assert.deepEqual({ updates, abouts }, { updates: 2, abouts: 1 }, "restarting does nothing on a click");

  await render(status("available"));
  await render(status("checking"));
  assert.equal(button()!.querySelector(".fm-update-label-full")!.textContent, "Update Available", "a check does not make the indicator vanish");
  assert.equal(button()!.getAttribute("aria-disabled"), "true", "its update waits for the check");
  await click();
  assert.deepEqual({ updates, abouts }, { updates: 2, abouts: 1 });
  await render(status("not_available", { availableVersion: null }));
  await render(status("checking"));
  assert.equal(dom.container.querySelector(".fm-update"), null, "a check from up to date still draws nothing");

  await render(status("error", { error: "The network connection was lost." }));
  assert.ok(button()!.classList.contains("is-error"));
  await click();
  assert.deepEqual({ updates, abouts }, { updates: 2, abouts: 2 }, "a failure opens Settings → About, where retry lives");
});

test("Settings → About's update button reads the same shared label and busy state", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  HTMLElement.prototype.scrollIntoView = () => {};
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const agentStatus: AgentStatus = { configured: true, ready: true, provider: "openrouter", model: "fixture/model", error: null, piVersion: "fixture" };
  const connectedFolder = { id: "update-test", name: "Workshop", connectedFolderRoot: "/synthetic/workshop" } as ConnectedFolderSummary;
  let actions = 0;
  const render = (value: DesktopUpdateStatus) => dom.render(createElement(DesktopSettingsModal, {
    connectedFolder, agentStatus, initialPage: "about", updateStatus: value,
    onUpdateAction: () => { actions += 1; }, onAgentConfigured: () => {}, onClose: () => {},
  }));
  const updateButton = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-labelledby="desktop-update-settings-title"] button, #settings-panel-about button')]
    .find((item) => item.textContent === updateActionLabel(currentStatus));
  let currentStatus = status("ready");
  await render(currentStatus);
  await dom.waitFor(() => Boolean(updateButton()));
  assert.equal(updateButton()!.disabled, false);
  await dom.act(() => updateButton()!.click());
  assert.equal(actions, 1);
  currentStatus = status("downloading", { progressPercent: 42 });
  await render(currentStatus);
  await dom.waitFor(() => Boolean(updateButton()));
  assert.equal(updateButton()!.textContent, "42%");
  assert.equal(updateButton()!.disabled, true, "Settings disables its button in the same phases the indicator will not act");
});

test("a screen reader hears the moves into available, ready, and failed, and no progress ticks", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const render = (value: DesktopUpdateStatus | null) => dom.render(createElement(UpdateIndicator, { status: value, onUpdateAction() {}, onOpenAbout() {} }));
  const live = () => dom.container.querySelector('[role="status"]')!;
  const said = async (value: DesktopUpdateStatus | null) => { await render(value); await dom.settle(); return live().textContent; };
  assert.equal(await said(status("not_available", { availableVersion: null })), "");
  assert.match(await said(status("available")), /^AmpleFile 0\.1\.5 is available\./);
  assert.ok(!live().contains(dom.container.querySelector("button")), "the live region sits beside the button, not around it");
  assert.equal(document.activeElement, document.body, "an announcement never takes focus");
  assert.equal(await said(status("downloading", { progressPercent: 10 })), "");
  assert.equal(await said(status("downloading", { progressPercent: 60 })), "", "progress is never announced");
  assert.match(await said(status("ready")), /is ready to install/);
  assert.match(await said(status("checking")), /is ready to install/, "a check neither clears nor repeats it");
  assert.match(await said(status("ready")), /is ready to install/);
  assert.equal(await said(status("installing")), "");
  assert.match(await said(status("error")), /^The update did not finish/);
});
