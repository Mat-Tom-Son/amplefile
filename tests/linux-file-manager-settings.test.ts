import assert from "node:assert/strict";
import test from "node:test";

import {
  isLinuxFileManagerStatus,
  linuxFileManagerSettingsView,
  type LinuxFileManagerStatus,
  type OpenFoldersByDefaultStatus,
  type ShowFilesFromOtherAppsStatus,
} from "../src/shared/linux-file-manager-settings.js";

/** Settings → File Manager: what each real system state shows. */

const show = (overrides: Partial<ShowFilesFromOtherAppsStatus>): ShowFilesFromOtherAppsStatus => ({ state: "off", reason: null, replaced: null, systemFileManager: "Files", ...overrides });
const open = (overrides: Partial<OpenFoldersByDefaultStatus>): OpenFoldersByDefaultStatus => ({ state: "off", current: "Files", previous: null, reason: null, ...overrides });
const view = (s: Partial<ShowFilesFromOtherAppsStatus>, o: Partial<OpenFoldersByDefaultStatus> = {}) => linuxFileManagerSettingsView({ showFilesFromOtherApps: show(s), openFoldersByDefault: open(o) });

test("Show Files from Other Apps: each state's switch position and words", () => {
  assert.deepEqual(view({}).showFilesFromOtherApps, { checked: false, disabled: false, detail: "Off: Files shows them.", tone: "normal" });
  assert.deepEqual(view({ systemFileManager: null }).showFilesFromOtherApps.detail, "Off.");
  assert.deepEqual(view({ state: "on" }).showFilesFromOtherApps, { checked: true, disabled: false, detail: "AmpleFile is answering. Turning this off gives them back to Files.", tone: "normal" });
  assert.equal(view({ state: "on", replaced: "thinkpad-files" }).showFilesFromOtherApps.detail, "AmpleFile is answering. Turning this off gives them back to thinkpad-files.");
  assert.deepEqual(view({ state: "waiting", reason: "nautilus is answering for now. AmpleFile takes over when it closes." }).showFilesFromOtherApps, { checked: true, disabled: false, detail: "nautilus is answering for now. AmpleFile takes over when it closes.", tone: "normal" });
  assert.deepEqual(view({ state: "unavailable", reason: "AmpleFile can't reach the desktop's session bus (no bus)." }).showFilesFromOtherApps, { checked: true, disabled: false, detail: "AmpleFile can't reach the desktop's session bus (no bus).", tone: "warning" });
  const elsewhere = view({ state: "elsewhere", reason: "Set up for another copy of AmpleFile (/a). Turn this on to use this copy." }).showFilesFromOtherApps;
  assert.equal(elsewhere.checked, false);
  assert.equal(elsewhere.tone, "warning");
});

test("Open Folders with AmpleFile: on names what comes back; unavailable can't be switched", () => {
  assert.deepEqual(view({}, { state: "on", current: "AmpleFile", previous: "Files" }).openFoldersByDefault, { checked: true, disabled: false, detail: "Turning this off gives folders back to Files.", tone: "normal" });
  assert.equal(view({}, { state: "on", current: "AmpleFile", previous: null }).openFoldersByDefault.detail, "Turning this off gives folders back to your desktop's default.");
  assert.deepEqual(view({}, {}).openFoldersByDefault, { checked: false, disabled: false, detail: "Folders open with Files now.", tone: "normal" });
  assert.equal(view({}, { current: null }).openFoldersByDefault.detail, "No app is set to open folders now.");
  assert.deepEqual(view({}, { state: "unavailable", reason: "No tools." }).openFoldersByDefault, { checked: false, disabled: true, detail: "No tools.", tone: "warning" });
});

test("the page accepts only a well-formed status", () => {
  const status: LinuxFileManagerStatus = { showFilesFromOtherApps: show({}), openFoldersByDefault: open({}) };
  assert.equal(isLinuxFileManagerStatus(status), true);
  assert.equal(isLinuxFileManagerStatus(null), false);
  assert.equal(isLinuxFileManagerStatus({ ...status, showFilesFromOtherApps: { ...status.showFilesFromOtherApps, state: "maybe" } }), false);
  assert.equal(isLinuxFileManagerStatus({ ...status, openFoldersByDefault: { ...status.openFoldersByDefault, current: 3 } }), false);
});
