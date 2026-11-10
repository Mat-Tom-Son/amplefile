import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { leftoverChromeCleanupApplies, leftoverChromeExtensionOrigin, leftoverChromeHostName, removeLeftoverChromeRegistration } from "../desktop/src/chrome-registration-cleanup.js";

const helperName = `amplefile-chrome-host-${"0123456789abcdef01234567"}`;

/** An earlier AmpleFile's leftovers: its registration in Chrome's directory and its helper in its own data. */
async function leftovers(t: TestContext, manifest?: (helper: string) => unknown) {
  const root = await mkdtemp(join(tmpdir(), "amplefile-leftover-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "app-data", "assistant-tools");
  const chromeUserDataRoot = join(root, "chrome-user-data");
  const helperDirectory = join(stateRoot, "chrome", "native-host");
  const helper = join(helperDirectory, helperName);
  await mkdir(helperDirectory, { recursive: true });
  await writeFile(helper, "synthetic helper");
  await writeFile(join(helperDirectory, "registration.json"), "{}");
  await mkdir(join(stateRoot, "chrome-companion"), { recursive: true });
  await mkdir(join(stateRoot, "computer"), { recursive: true });
  await writeFile(join(stateRoot, "computer", "kept.json"), "{}");
  const hosts = join(chromeUserDataRoot, "NativeMessagingHosts");
  await mkdir(hosts, { recursive: true });
  const manifestPath = join(hosts, `${leftoverChromeHostName}.json`);
  const own = { name: leftoverChromeHostName, description: "Connect Chrome to AmpleFile", path: helper, type: "stdio", allowed_origins: [leftoverChromeExtensionOrigin] };
  const value = manifest ? manifest(helper) : own;
  if (value !== undefined) await writeFile(manifestPath, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  // Another product's host and a Chrome profile sit beside it and are never touched.
  const otherHost = join(hosts, "com.example.other.json");
  await writeFile(otherHost, JSON.stringify({ name: "com.example.other", path: helper, type: "stdio", allowed_origins: [leftoverChromeExtensionOrigin] }));
  const profile = join(chromeUserDataRoot, "Default");
  await mkdir(profile);
  await writeFile(join(profile, "Preferences"), "{}");
  return { stateRoot, chromeUserDataRoot, manifestPath, own, otherHost, profile };
}

const gone = (path: string) => assert.rejects(access(path), { code: "ENOENT" }, `${path} is removed`);

test("AmpleFile removes its own leftover Chrome registration and helper once, and nothing else", async (t) => {
  const fixture = await leftovers(t);
  assert.deepEqual(await removeLeftoverChromeRegistration(fixture), { registration: "removed", helper: "removed" });
  await gone(fixture.manifestPath);
  await gone(join(fixture.stateRoot, "chrome"));
  await gone(join(fixture.stateRoot, "chrome-companion"));
  await access(join(fixture.stateRoot, "computer", "kept.json"));
  await access(fixture.otherHost);
  assert.equal(await readFile(join(fixture.profile, "Preferences"), "utf8"), "{}");

  // With its own leftovers gone, a later launch never looks in Chrome's directory again.
  await writeFile(fixture.manifestPath, JSON.stringify(fixture.own));
  assert.deepEqual(await removeLeftoverChromeRegistration(fixture), { registration: "not-checked", helper: "absent" });
  assert.deepEqual(JSON.parse(await readFile(fixture.manifestPath, "utf8")), fixture.own);
});

test("a registration that is not provably this installation's stays as it is", async (t) => {
  const variants: Array<[string, (helper: string) => unknown]> = [
    ["another installation's helper", () => ({ name: leftoverChromeHostName, path: "/Applications/Other AmpleFile.app/host", type: "stdio", allowed_origins: [leftoverChromeExtensionOrigin] })],
    ["a helper beside, not inside, AmpleFile's folder", (helper) => ({ name: leftoverChromeHostName, path: join(helper, "..", "..", helperName), type: "stdio", allowed_origins: [leftoverChromeExtensionOrigin] })],
    ["an unexpected helper name", (helper) => ({ name: leftoverChromeHostName, path: join(helper, "..", "other-host"), type: "stdio", allowed_origins: [leftoverChromeExtensionOrigin] })],
    ["another extension's origin", (helper) => ({ name: leftoverChromeHostName, path: helper, type: "stdio", allowed_origins: [`chrome-extension://${"b".repeat(32)}/`] })],
    ["a second allowed origin", (helper) => ({ name: leftoverChromeHostName, path: helper, type: "stdio", allowed_origins: [leftoverChromeExtensionOrigin, `chrome-extension://${"b".repeat(32)}/`] })],
    ["another host name", (helper) => ({ name: "com.example.chrome", path: helper, type: "stdio", allowed_origins: [leftoverChromeExtensionOrigin] })],
    ["unreadable JSON", () => "{ not json"],
  ];
  for (const [label, manifest] of variants) {
    const fixture = await leftovers(t, manifest);
    const before = await readFile(fixture.manifestPath, "utf8");
    assert.deepEqual(await removeLeftoverChromeRegistration(fixture), { registration: "kept", helper: "removed" }, label);
    assert.equal(await readFile(fixture.manifestPath, "utf8"), before, label);
    await gone(join(fixture.stateRoot, "chrome"));
  }
});

test("a linked registration is never followed or removed, and a missing one is fine", async (t) => {
  const linked = await leftovers(t, () => undefined);
  const target = join(linked.stateRoot, "..", "linked-manifest.json");
  await writeFile(target, JSON.stringify({ name: leftoverChromeHostName, path: join(linked.stateRoot, "chrome", "native-host", helperName), type: "stdio", allowed_origins: [leftoverChromeExtensionOrigin] }));
  await symlink(target, linked.manifestPath);
  assert.deepEqual(await removeLeftoverChromeRegistration(linked), { registration: "kept", helper: "removed" });
  await access(linked.manifestPath);
  await access(target);

  const missing = await leftovers(t, () => undefined);
  assert.deepEqual(await removeLeftoverChromeRegistration(missing), { registration: "absent", helper: "removed" });
  await gone(join(missing.stateRoot, "chrome"));
});

test("a registration folder that cannot be read still lets AmpleFile remove its own leftovers, once", async (t) => {
  // NativeMessagingHosts is a file, so the manifest path runs through something that is not a folder.
  const notFolder = await leftovers(t, () => undefined);
  const hosts = join(notFolder.chromeUserDataRoot, "NativeMessagingHosts");
  await rm(hosts, { recursive: true });
  await writeFile(hosts, "not a folder");
  assert.deepEqual(await removeLeftoverChromeRegistration(notFolder), { registration: "absent", helper: "removed" });
  assert.equal(await readFile(hosts, "utf8"), "not a folder");
  await gone(join(notFolder.stateRoot, "chrome"));
  await gone(join(notFolder.stateRoot, "chrome-companion"));

  // A manifest that is a folder is not AmpleFile's plain JSON.
  const folder = await leftovers(t, () => undefined);
  await mkdir(folder.manifestPath);
  assert.deepEqual(await removeLeftoverChromeRegistration(folder), { registration: "kept", helper: "removed" });
  await access(folder.manifestPath);

  // Unreadable registrations are left as they are; AmpleFile's own folders go, so no later launch looks again.
  if (process.getuid?.() === 0) return;
  const lockedFolder = await leftovers(t);
  const lockedHosts = join(lockedFolder.chromeUserDataRoot, "NativeMessagingHosts");
  await chmod(lockedHosts, 0o000);
  try {
    assert.deepEqual(await removeLeftoverChromeRegistration(lockedFolder), { registration: "unreadable", helper: "removed" });
    await gone(join(lockedFolder.stateRoot, "chrome"));
    assert.deepEqual(await removeLeftoverChromeRegistration(lockedFolder), { registration: "not-checked", helper: "absent" });
  } finally { await chmod(lockedHosts, 0o700); }
  assert.deepEqual(JSON.parse(await readFile(lockedFolder.manifestPath, "utf8")), lockedFolder.own);

  const lockedFile = await leftovers(t);
  await chmod(lockedFile.manifestPath, 0o000);
  try {
    assert.deepEqual(await removeLeftoverChromeRegistration(lockedFile), { registration: "unreadable", helper: "removed" });
  } finally { await chmod(lockedFile.manifestPath, 0o600); }
  assert.deepEqual(JSON.parse(await readFile(lockedFile.manifestPath, "utf8")), lockedFile.own);
  await gone(join(lockedFile.stateRoot, "chrome"));
});

test("only the installed Mac app with its normal profile cleans up, and only at interactive startup", async () => {
  const installed = { platform: "darwin" as const, isPackaged: true, localSmokeBuild: false, environment: {} };
  assert.equal(leftoverChromeCleanupApplies(installed), true);
  assert.equal(leftoverChromeCleanupApplies({ ...installed, environment: { AMPLEFILE_DESKTOP_STATE_DIR: "  " } }), true, "a blank override chooses the normal profile");
  for (const [label, launch] of [
    ["Local Smoke", { ...installed, localSmokeBuild: true }],
    ["a state folder override", { ...installed, environment: { AMPLEFILE_DESKTOP_STATE_DIR: "/tmp/amplefile-state" } }],
    ["the unpackaged app", { ...installed, isPackaged: false }],
    ["Windows", { ...installed, platform: "win32" as const }],
    ["Linux", { ...installed, platform: "linux" as const }],
  ] as const) assert.equal(leftoverChromeCleanupApplies(launch), false, label);

  // A headless CLI host never reaches it: the one call sits in interactive startup, behind the gate.
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  assert.equal(main.match(/removeLeftoverChromeRegistrationOnce\(\);/g)?.length, 1);
  assert.equal(main.match(/removeLeftoverChromeRegistration\(/g)?.length, 1);
  const startup = main.slice(main.indexOf("async function startInteractiveApp()"), main.indexOf("function removeLeftoverChromeRegistrationOnce()"));
  assert.match(startup, /await ensureDesktopHost\(\);\n\s*removeLeftoverChromeRegistrationOnce\(\);/);
  const helper = main.slice(main.indexOf("function removeLeftoverChromeRegistrationOnce()"), main.indexOf("const headlessQuit = new HeadlessQuitSequence"));
  assert.match(helper, /if \(!leftoverChromeCleanupApplies\(\{ platform: process\.platform, isPackaged: app\.isPackaged, localSmokeBuild: localMacSmokeBuild, environment: process\.env \}\)\) return;/);
});
