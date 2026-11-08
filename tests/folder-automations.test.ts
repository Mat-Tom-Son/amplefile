import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ampleFileCliBrokerPaths } from "../src/local/cli/broker.js";
import type { AmpleFileCliActReceipt } from "../src/local/cli/act-receipts.js";
import {
  normalizeAmpleFileAutomationDeclaration,
  ampleFileAutomationDigest,
  ampleFileAutomationConnectedFolderRoles,
} from "../src/local/automations/automation-declarations.js";
import { startLocalApi } from "../src/local/server.js";
import { automationTriggerSummary, type FolderAutomationsResponse } from "../src/shared/automation-presentation.js";

const home = "space-0123456789abcdef";
const trip = "space-fedcba9876543210";
const other = "space-aaaaaaaaaaaaaaaa";

test("an automation's roles in a Connected Folder come from its trigger and the Connected Folder each step targets", () => {
  const declaration = normalizeAmpleFileAutomationDeclaration({
    kind: "amplefile.automation",
    version: 4,
    id: "automation-folder-roles",
    title: "Roles",
    createdBy: "human",
    createdAt: "2026-09-24T12:00:00.000Z",
    trigger: {
      kind: "files-changed",
      connectedFolder: home,
      watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] },
      debounceSeconds: 5,
      cooldownMinutes: 1,
    },
    steps: [
      { id: "adopt", kind: "chat", connectedFolder: trip, message: "Adopt the newest brief." },
      { id: "copy", kind: "files", fromConnectedFolder: home, from: { kind: "paths", paths: ["Ready/brief.md"] }, toConnectedFolder: trip, to: "Incoming" },
      { id: "report", kind: "agent", message: "Done." },
    ],
  });
  assert.deepEqual(ampleFileAutomationConnectedFolderRoles(declaration, home), ["watches", "copies-from"]);
  assert.deepEqual(ampleFileAutomationConnectedFolderRoles(declaration, trip), ["copies-to", "chats-here"]);
  assert.deepEqual(ampleFileAutomationConnectedFolderRoles(declaration, other), [], "an agent step names no Connected Folder");

  const settled = normalizeAmpleFileAutomationDeclaration({
    kind: "amplefile.automation",
    version: 1,
    id: "automation-after-an-app",
    title: "After an app automation",
    createdBy: "human",
    createdAt: "2026-09-24T12:00:00.000Z",
    trigger: { kind: "on-settled", source: { kind: "app-automation-run", connectedFolder: other, appId: "collector", appAutomationId: "collect" } },
    steps: [{ id: "tell", kind: "chat", connectedFolder: home, message: "The collector settled." }],
  });
  assert.deepEqual(ampleFileAutomationConnectedFolderRoles(settled, other), ["watches"]);
  assert.deepEqual(ampleFileAutomationConnectedFolderRoles(settled, home), ["chats-here"]);
});

test("the shared trigger summary is the one Settings and the Connected Folder view print", () => {
  assert.equal(automationTriggerSummary({ kind: "manual" }), "Manual only");
  assert.equal(automationTriggerSummary({ kind: "interval", intervalMinutes: 30 }), "Every 30 minutes");
  assert.equal(automationTriggerSummary({ kind: "interval", intervalMinutes: 120 }), "Every 2 hours");
  assert.equal(
    automationTriggerSummary({ kind: "on-settled", source: { kind: "app-automation-run", connectedFolderId: home, connectedFolderName: "Home projects", appId: "collector", appAutomationId: "collect" } }),
    "After collector · collect settles in Home projects",
  );
  const folderTrigger = {
    kind: "files-changed" as const,
    connectedFolderId: home,
    watch: { kind: "tree" as const, path: "Screenshots", recursive: false, extensions: [".png"] },
    debounceSeconds: 5,
    cooldownMinutes: 1,
  };
  assert.equal(automationTriggerSummary(folderTrigger), "When Screenshots changes · wait 5s · 1 minute cooldown");
  assert.equal(automationTriggerSummary({ ...folderTrigger, ifMissed: "skip" }), "When Screenshots changes · wait 5s · 1 minute cooldown");
  assert.equal(
    automationTriggerSummary({ ...folderTrigger, ifMissed: "run" }),
    "When Screenshots changes · wait 5s · 1 minute cooldown · catches up after AmpleFile was closed",
  );
});

test("GET /api/connected-folders/:id/automations lists only automations naming the Connected Folder; its acts are the Settings acts and refuse unrelated automations", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-folder-automations-"));
  const stateRoot = join(sandbox, "state");
  const api = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    connectedFolderBase: join(sandbox, "connected-folders"),
    sessionToken: "folder-automations-session",
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const headers = { "content-type": "application/json", "x-amplefile-session": "folder-automations-session" };
  const get = async (connectedFolderId: string) => {
    const response = await fetch(`${api.origin}/api/connected-folders/${connectedFolderId}/automations`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as FolderAutomationsResponse;
  };
  const post = (connectedFolderId: string, automationId: string, action: string) =>
    fetch(`${api.origin}/api/connected-folders/${connectedFolderId}/automations/${automationId}/${action}`, { method: "POST", headers });

  const a = (await api.actFacade.createConnectedFolder({ name: "Folder A" })).connectedFolder;
  const b = (await api.actFacade.createConnectedFolder({ name: "Folder B" })).connectedFolder;
  const c = (await api.actFacade.createConnectedFolder({ name: "Folder C" })).connectedFolder;
  const d = (await api.actFacade.createConnectedFolder({ name: "Folder D" })).connectedFolder;
  await writeFile(join(a.connectedFolderRoot, "notes.txt"), "folder handoff", "utf8");

  const declarations = [
    {
      kind: "amplefile.automation", version: 1, id: "automation-a-to-b-handoff", title: "A to B",
      createdBy: "human", createdAt: "2026-09-24T12:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [{ id: "handoff", kind: "files", fromConnectedFolder: a.id, from: { kind: "paths", paths: ["notes.txt"] }, toConnectedFolder: b.id, to: "Incoming" }],
    },
    {
      kind: "amplefile.automation", version: 1, id: "automation-chat-in-c", title: "Chat in C",
      createdBy: "human", createdAt: "2026-09-24T12:00:00.000Z",
      trigger: { kind: "manual" },
      steps: [{ id: "ask", kind: "chat", connectedFolder: c.id, message: "Summarize the week." }],
    },
    {
      kind: "amplefile.automation", version: 1, id: "automation-after-b-app", title: "After an app in B",
      createdBy: "human", createdAt: "2026-09-24T12:00:00.000Z",
      trigger: { kind: "on-settled", source: { kind: "app-automation-run", connectedFolder: b.id, appId: "collector", appAutomationId: "collect" } },
      steps: [{ id: "forward", kind: "files", fromConnectedFolder: b.id, from: { kind: "paths", paths: ["Incoming/notes.txt"] }, toConnectedFolder: c.id, to: "From B" }],
    },
  ].map((value) => normalizeAmpleFileAutomationDeclaration(value));
  for (const declaration of declarations) {
    await api.automations.enable({
      declaration,
      expectedDigest: ampleFileAutomationDigest(declaration),
      grant: { requestId: `request-${declaration.id}`, surface: "main-window" },
    });
  }

  assert.deepEqual(await get(a.id), {
    automations: [{
      automationId: "automation-a-to-b-handoff",
      title: "A to B",
      state: "on",
      triggerSummary: "Manual only",
      nextRunAt: null,
      lastRun: null,
      roles: ["copies-from"],
    }],
  });
  const inB = await get(b.id);
  assert.deepEqual(inB.automations.map((item) => [item.automationId, item.roles]).sort(), [
    ["automation-a-to-b-handoff", ["copies-to"]],
    ["automation-after-b-app", ["watches", "copies-from"]],
  ]);
  assert.equal(
    inB.automations.find((item) => item.automationId === "automation-after-b-app")?.triggerSummary,
    "After collector · collect settles in Folder B",
    "the settled source is named by its Connected Folder name",
  );
  const inC = await get(c.id);
  assert.deepEqual(inC.automations.map((item) => [item.automationId, item.roles]).sort(), [
    ["automation-after-b-app", ["copies-to"]],
    ["automation-chat-in-c", ["chats-here"]],
  ]);
  assert.deepEqual(await get(d.id), { automations: [] }, "an untouched Connected Folder gets an empty list");

  // An automation that does not name the Connected Folder is refused and left unchanged.
  for (const action of ["disable", "enable", "run"]) {
    const refused = await post(a.id, "automation-chat-in-c", action);
    assert.equal(refused.status, 404, action);
    assert.match((await refused.json() as { error: string }).error, /does not touch this folder/);
  }
  assert.equal((await api.automations.getAutomation("automation-chat-in-c"))?.health, "enabled");
  assert.equal((await post(a.id, "automation-missing-one", "run")).status, 404);
  const unauthenticated = await fetch(`${api.origin}/api/connected-folders/${a.id}/automations`);
  assert.equal(unauthenticated.status, 401);

  const disabled = await post(c.id, "automation-chat-in-c", "disable");
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal((await disabled.json() as { disabled: boolean }).disabled, true);
  assert.equal((await get(c.id)).automations.find((item) => item.automationId === "automation-chat-in-c")?.state, "off");
  const enabled = await post(c.id, "automation-chat-in-c", "enable");
  assert.equal(enabled.status, 200, await enabled.clone().text());
  const enabledBody = await enabled.json() as { enabled: boolean; requestId: string };
  assert.equal(enabledBody.enabled, true);
  assert.match(enabledBody.requestId, /^settings:/);
  assert.equal((await api.automations.getAutomation("automation-chat-in-c"))?.grants.at(-1)?.surface, "main-window");
  assert.equal((await post(c.id, "automation-chat-in-c", "enable")).status, 409, "the Settings conflict carries through");

  const run = await post(b.id, "automation-a-to-b-handoff", "run");
  assert.equal(run.status, 200, await run.clone().text());
  const runBody = await run.json() as { accepted: boolean; requestId: string; runId: string };
  assert.equal(runBody.accepted, true);
  assert.match(runBody.requestId, /^settings:/);
  await waitFor(async () => {
    const text = await readFile(join(b.connectedFolderRoot, "Incoming", "notes.txt"), "utf8").catch(() => null);
    return text === "folder handoff";
  }, "the connected-folder-view run to copy the file");
  await waitFor(async () => (await get(a.id)).automations[0]?.lastRun?.outcome === "succeeded", "the last run to settle");

  const actPath = join(ampleFileCliBrokerPaths(stateRoot).root, "receipts", "act.jsonl");
  await waitFor(async () => (await jsonLines<AmpleFileCliActReceipt>(actPath))
    .some((entry) => entry.command === "automations.run" && entry.outcome === "ok"), "the run's terminal act receipt");
  const acts = (await jsonLines<AmpleFileCliActReceipt>(actPath)).filter((entry) => entry.command.startsWith("automations."));
  assert.ok(acts.every((entry) => entry.surface === "main-window" && entry.requestId.startsWith("settings:")),
    "the Connected Folder view writes exactly the receipts Settings writes");
  for (const command of ["automations.disable", "automations.enable", "automations.run"]) {
    assert.ok(acts.some((entry) => entry.command === command && entry.outcome === "accepted"), `${command} accepted`);
    assert.ok(acts.some((entry) => entry.command === command && entry.outcome === "ok"), `${command} ok`);
  }
});

async function jsonLines<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}
