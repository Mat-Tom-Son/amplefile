import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ampleFileOverviewAutomationReceiptsFile,
  ampleFileOverviewAutomationReceiptsRotatedFile,
} from "../src/local/overview.js";
import {
  normalizeAmpleFileAutomationDeclaration,
  ampleFileAutomationBounds,
  ampleFileAutomationDigest,
} from "../src/local/automations/automation-declarations.js";
import {
  AmpleFileAutomationReceipts,
  AmpleFileAutomationStore,
  AmpleFileAutomationStoreError,
  ampleFileAutomationReceiptsFile,
  ampleFileAutomationReceiptsRotatedFile,
  type AmpleFileAutomationEnableInput,
  type AmpleFileAutomationReceiptV1,
} from "../src/local/automations/automation-store.js";

const connectedFolderA = "space-aaaaaaaaaaaaaaaa";
const connectedFolderB = "space-bbbbbbbbbbbbbbbb";
const connectedFolderC = "space-cccccccccccccccc";
const fixedNow = new Date("2026-08-10T17:00:00.000Z");

function declarationInput(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "amplefile.automation",
    version: 1,
    id,
    title: `Automation ${id}`,
    createdBy: "assistant",
    createdAt: "2026-08-01T00:00:00.000Z",
    trigger: { kind: "interval", intervalMinutes: 60 },
    steps: [{ id: "notify", kind: "chat", connectedFolder: connectedFolderA, message: "Review the queue." }],
    ...overrides,
  };
}

function enableInput(raw: unknown, requestId: string): AmpleFileAutomationEnableInput {
  const declaration = normalizeAmpleFileAutomationDeclaration(raw);
  return {
    declaration,
    expectedDigest: ampleFileAutomationDigest(declaration),
    grant: { requestId, surface: "popover" },
  };
}

async function createSandbox(prefix: string): Promise<{
  sandbox: string;
  receipts: AmpleFileAutomationReceipts;
  store: AmpleFileAutomationStore;
  statePath: string;
  journalPath: string;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), prefix));
  const journalPath = join(sandbox, "automations", "receipts.jsonl");
  const statePath = join(sandbox, "automations", "automations.json");
  const receipts = new AmpleFileAutomationReceipts({ path: journalPath, now: () => fixedNow });
  const store = await AmpleFileAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });
  return { sandbox, receipts, store, statePath, journalPath };
}

async function readJournal(path: string): Promise<AmpleFileAutomationReceiptV1[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AmpleFileAutomationReceiptV1);
}

test("the receipts journal path is the exact contract the overview's tolerant reader consumes", () => {
  const root = join(tmpdir(), "automation-path-contract");
  assert.equal(ampleFileAutomationReceiptsFile(root), ampleFileOverviewAutomationReceiptsFile(root));
  assert.equal(ampleFileAutomationReceiptsRotatedFile(root), ampleFileOverviewAutomationReceiptsRotatedFile(root));
});

test("enable is journal-first exact-digest authority: declaration and enable receipt commit together", async (t) => {
  const { sandbox, store, statePath, journalPath } = await createSandbox("amplefile-automation-store-enable-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const record = await store.enable(enableInput(declarationInput("automation-weekly-handoff"), "request-1"));
  assert.equal(record.health, "enabled");
  assert.equal(record.digest, ampleFileAutomationDigest(record.declaration));
  assert.deepEqual(record.grants, [{
    digest: record.digest,
    requestId: "request-1",
    enabledAt: fixedNow.toISOString(),
    surface: "popover",
  }]);
  assert.equal(record.lastScheduledAt, fixedNow.toISOString(), "an interval enablement anchors its cadence at enable time");

  const journal = await readJournal(journalPath);
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.scope, "automation");
  assert.equal(journal[0]?.outcome, "enabled");
  assert.equal(journal[0]?.digest, record.digest);
  assert.equal(journal[0]?.requestId, "request-1");
  assert.equal(journal[0]?.surface, "popover");

  const reloaded = await AmpleFileAutomationStore.create({ path: statePath, now: () => fixedNow });
  assert.deepEqual(await reloaded.list(), [record], "the enablement round-trips through the durable state file");

  await assert.rejects(
    () => store.enable({ ...enableInput(declarationInput("automation-weekly-handoff"), "request-2"), expectedDigest: "0".repeat(64) }),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "DIGEST_MISMATCH",
    "a declaration that does not hash to the pinned digest is refused",
  );
  await assert.rejects(
    () => store.enable({
      ...enableInput(declarationInput("automation-weekly-handoff"), "request-3"),
      grant: { requestId: "request-3", surface: "elsewhere" as never },
    }),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "INPUT_INVALID"
      && /act surface/.test(error.message),
    "only an act surface enables an automation",
  );
  const again = await store.enable({
    ...enableInput(declarationInput("automation-weekly-handoff"), "request-5"),
    grant: { requestId: "request-5", surface: "cli" },
  });
  assert.equal(again.grants.length, 2, "re-enablement appends a fresh receipt instead of rewriting history");
  assert.deepEqual(again.grants[1], {
    digest: again.digest,
    requestId: "request-5",
    enabledAt: fixedNow.toISOString(),
    surface: "cli",
  });
});

test("an unwritable journal refuses enablement before any state changes", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-automation-store-journal-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await writeFile(join(sandbox, "blocker"), "a file where the journal directory must go", "utf8");
  const receipts = new AmpleFileAutomationReceipts({ path: join(sandbox, "blocker", "receipts.jsonl") });
  const statePath = join(sandbox, "automations.json");
  const store = await AmpleFileAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });

  await assert.rejects(
    () => store.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1")),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "JOURNAL_UNAVAILABLE",
  );
  assert.equal(await stat(statePath).catch(() => null), null, "a refused enablement leaves no authority state behind");
});

test("stores more than the former machine automation cap and reloads the saved declarations", async (t) => {
  const { sandbox, store } = await createSandbox("amplefile-automation-store-bound-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  for (let index = 0; index < 33; index += 1) {
    await store.enable(enableInput(declarationInput(`automation-bound-${String(index).padStart(4, "0")}`), `decision-${index}`));
  }
  assert.equal((await store.list()).length, 33);
  const reloaded = await AmpleFileAutomationStore.create({ path: join(sandbox, "automations", "automations.json"), now: () => fixedNow });
  assert.equal((await reloaded.list()).length, 33, "saved declarations beyond the former cap remain valid");
  const again = await store.enable(enableInput(declarationInput("automation-bound-0000"), "decision-again"));
  assert.equal(again.grants.length, 2, "re-enabling an existing automation never counts against the machine bound");
});

test("disable narrows and delete removes only inert automations; receipts survive the object", async (t) => {
  const { sandbox, store, journalPath } = await createSandbox("amplefile-automation-store-lifecycle-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const record = await store.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1"));
  await assert.rejects(
    () => store.delete("automation-weekly-handoff"),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "HEALTH_INVALID" && error.health === "enabled",
    "an enabled automation must be disabled before deletion so revocation stops stale work first",
  );

  const disabled = await store.disable("automation-weekly-handoff");
  assert.equal(disabled.health, "disabled");
  assert.equal(disabled.disabledAt, fixedNow.toISOString());
  assert.deepEqual(disabled.grants, record.grants, "disable never destroys the grant history");
  await assert.rejects(
    () => store.disable("automation-weekly-handoff"),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "HEALTH_INVALID" && error.health === "disabled",
  );

  const deleted = await store.delete("automation-weekly-handoff");
  assert.equal(deleted.declaration.id, "automation-weekly-handoff");
  assert.equal(await store.get("automation-weekly-handoff"), undefined);
  await assert.rejects(
    () => store.delete("automation-weekly-handoff"),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "NOT_FOUND",
  );

  const outcomes = (await readJournal(journalPath)).map((line) => `${line.scope}:${line.outcome}`);
  assert.deepEqual(outcomes, ["automation:enabled", "automation:disabled", "automation:deleted"], "audit records survive the object");
});

test("Connected Folder removal suspends exactly the enabled automations that reference it, durably and cumulatively", async (t) => {
  const { sandbox, store, statePath } = await createSandbox("amplefile-automation-store-suspend-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const crossConnectedFolder = declarationInput("automation-cross-connected-folder", {
    steps: [
      { id: "review", kind: "chat", connectedFolder: connectedFolderA, message: "Review chapters for unresolved notes." },
      { id: "handoff", kind: "files", fromConnectedFolder: connectedFolderA, from: { kind: "paths", paths: ["reports/weekly.md"] }, toConnectedFolder: connectedFolderB, to: "Incoming" },
    ],
  });
  await store.enable(enableInput(crossConnectedFolder, "decision-1"));
  await store.enable(enableInput(declarationInput("automation-unrelated", {
    steps: [{ id: "notify", kind: "chat", connectedFolder: connectedFolderC, message: "Tidy the inbox." }],
  }), "decision-2"));
  await store.enable(enableInput(declarationInput("automation-disabled-ref"), "decision-3"));
  await store.disable("automation-disabled-ref");

  const first = await store.suspendForConnectedFolderRemoval(connectedFolderA, fixedNow);
  assert.deepEqual(first.suspended.map((record) => record.declaration.id), ["automation-cross-connected-folder"]);
  assert.deepEqual(first.noted, []);
  assert.deepEqual(first.suspended[0]?.suspension, {
    at: fixedNow.toISOString(),
    missingConnectedFolderIds: [connectedFolderA],
    reRegisteredConnectedFolderIds: [],
  });
  assert.equal(first.suspended[0]?.lastScheduledAt, undefined, "suspension revokes the cadence anchor with the grant");
  assert.equal((await store.get("automation-unrelated"))?.health, "enabled", "automations that never reference the Connected Folder are untouched");
  assert.equal((await store.get("automation-disabled-ref"))?.health, "disabled", "a disabled automation holds no grant to revoke");

  const second = await store.suspendForConnectedFolderRemoval(connectedFolderB, fixedNow);
  assert.deepEqual(second.suspended, []);
  assert.deepEqual(second.noted.map((record) => record.declaration.id), ["automation-cross-connected-folder"]);
  assert.deepEqual(second.noted[0]?.suspension?.missingConnectedFolderIds, [connectedFolderA, connectedFolderB]);

  const noted = await store.noteConnectedFolderReRegistered(connectedFolderA);
  assert.deepEqual(noted[0]?.suspension?.reRegisteredConnectedFolderIds, [connectedFolderA], "re-registration is copy-level detail");
  assert.equal(noted[0]?.health, "suspended", "registration never silently re-arms standing behavior");
  assert.deepEqual(await store.noteConnectedFolderReRegistered(connectedFolderA), [], "the note is recorded once");

  await assert.rejects(
    () => store.disable("automation-cross-connected-folder"),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "HEALTH_INVALID" && error.health === "suspended",
    "there is no enablement left to disable on a suspended automation",
  );

  const reloaded = await AmpleFileAutomationStore.create({ path: statePath, now: () => fixedNow });
  assert.equal((await reloaded.get("automation-cross-connected-folder"))?.health, "suspended", "suspension is durable across restarts");

  const reEnabled = await store.enable(enableInput(crossConnectedFolder, "decision-fresh"));
  assert.equal(reEnabled.health, "enabled");
  assert.equal(reEnabled.suspension, undefined, "leaving suspension is a fresh receipted enablement over the unchanged declaration");
  assert.equal(reEnabled.grants.length, 2);
});

test("the cadence anchor persists for enabled interval automations only", async (t) => {
  const { sandbox, store, statePath } = await createSandbox("amplefile-automation-store-cadence-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  await store.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1"));
  assert.equal(await store.recordCadence("automation-weekly-handoff", "2026-08-10T18:00:00.000Z"), true);
  const reloaded = await AmpleFileAutomationStore.create({ path: statePath, now: () => fixedNow });
  assert.equal((await reloaded.get("automation-weekly-handoff"))?.lastScheduledAt, "2026-08-10T18:00:00.000Z");

  assert.equal(await store.recordCadence("automation-missing", "2026-08-10T18:00:00.000Z"), false);
  await store.disable("automation-weekly-handoff");
  assert.equal(await store.recordCadence("automation-weekly-handoff", "2026-08-10T19:00:00.000Z"), false, "a disabled automation keeps no advancing cadence");
  await assert.rejects(
    () => store.recordCadence("automation-weekly-handoff", "not-a-time"),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "INPUT_INVALID",
  );
});

test("one-time enablement rechecks its admission horizon and a durable claim completes exactly one occurrence", async (t) => {
  const { sandbox, receipts, store, statePath, journalPath } = await createSandbox("amplefile-automation-store-at-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const atDeclaration = (id: string, at: string) => declarationInput(id, {
    version: 2,
    trigger: { kind: "at", at, ifMissed: "run" },
  });

  await assert.rejects(
    () => store.enable(enableInput(atDeclaration("automation-at-too-soon", new Date(fixedNow.getTime() + ampleFileAutomationBounds.minAtAdvanceMs - 1).toISOString()), "decision-too-soon")),
    /in the future, and at most ten years ahead/,
  );
  await assert.rejects(
    () => store.enable(enableInput(atDeclaration("automation-at-too-far", new Date(fixedNow.getTime() + ampleFileAutomationBounds.maxAtAdvanceMs + 1).toISOString()), "decision-too-far")),
    /in the future, and at most ten years ahead/,
  );

  const enabled = await store.enable(enableInput(
    atDeclaration("automation-at-once1", "2026-08-10T17:01:00.000Z"),
    "decision-at",
  ));
  assert.equal(enabled.health, "enabled");
  assert.equal(enabled.lastScheduledAt, undefined);
  const claimed = await store.claimAtOccurrence(
    "automation-at-once1",
    "2026-08-10T17:01:00.000Z",
    "run-at-1",
    new Date("2026-08-10T17:01:00.000Z"),
  );
  assert.equal(claimed?.health, "completed");
  assert.match(claimed?.atOccurrence?.occurrenceId ?? "", /^at-[a-f0-9]{32}$/);
  assert.equal(claimed?.atOccurrence?.runId, "run-at-1");
  assert.equal(await store.claimAtOccurrence(
    "automation-at-once1",
    "2026-08-10T17:01:00.000Z",
    "run-at-2",
  ), null, "the completed health transition is the single-fire gate");
  assert.equal(await store.finishAtOccurrence(
    "automation-at-once1",
    "run-at-1",
    "2026-08-10T17:01:05.000Z",
  ), true);

  const reloaded = await AmpleFileAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });
  const durable = await reloaded.get("automation-at-once1");
  assert.equal(durable?.health, "completed");
  assert.equal(durable?.atOccurrence?.finishedAt, "2026-08-10T17:01:05.000Z");
  await assert.rejects(
    () => reloaded.disable("automation-at-once1"),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError
      && error.code === "HEALTH_INVALID"
      && error.health === "completed",
  );
  await reloaded.delete("automation-at-once1", { requestId: "request-delete-at", surface: "main-window" });
  const deleted = (await readJournal(journalPath)).at(-1);
  assert.equal(deleted?.requestId, "request-delete-at");
  assert.equal(deleted?.surface, "main-window");
});

test("a stored automation that uses a retired Check or Connected Folder app feature is left out on its own; the rest of the store loads", async (t) => {
  const { sandbox, store, statePath, receipts } = await createSandbox("amplefile-automation-store-retired-");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await store.enable(enableInput(declarationInput("automation-keeps-working"), "request-valid"));
  // A version 1-3 message is literal text, braces included, so this one stays valid.
  await store.enable(enableInput(declarationInput("automation-literal-braces", {
    steps: [{ id: "notify", kind: "chat", connectedFolder: connectedFolderA, message: "Mention {{trigger.findings}} literally." }],
  }), "request-literal"));
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
    schemaVersion: number;
    automations: Array<Record<string, unknown> & { grants: Array<Record<string, unknown>> }>;
  };
  // Exactly what a build with Checks or Connected Folder apps stored:
  // digest-pinned, enabled records whose declarations the current parser refuses.
  const retired = (declaration: Record<string, unknown>) => {
    const digest = ampleFileAutomationDigest(declaration);
    return {
      declaration,
      digest,
      health: "enabled",
      grants: [{ digest, requestId: `request-${String(declaration.id)}`, enabledAt: fixedNow.toISOString(), surface: "popover" }],
    };
  };
  persisted.automations.unshift(retired(declarationInput("automation-runs-a-check", {
    steps: [
      { id: "notify", kind: "chat", connectedFolder: connectedFolderA, message: "Review the queue." },
      { id: "verify", kind: "check", connectedFolder: connectedFolderA, check: "check-12345678" },
    ],
  }) as Record<string, unknown>));
  persisted.automations.push(retired(declarationInput("automation-after-a-check", {
    trigger: { kind: "on-settled", source: { kind: "check-run", connectedFolder: connectedFolderA, outcomes: ["succeeded"] } },
  }) as Record<string, unknown>));
  persisted.automations.push(retired(declarationInput("automation-reads-findings", {
    version: 4,
    trigger: { kind: "manual" },
    steps: [{ id: "tell", kind: "agent", message: "New findings:\n{{ trigger.findings }}" }],
  }) as Record<string, unknown>));
  persisted.automations.push(retired(declarationInput("automation-after-an-app", {
    trigger: {
      kind: "on-settled",
      source: { kind: "app-automation-run", connectedFolder: connectedFolderA, appId: "collector", appAutomationId: "collect" },
    },
  }) as Record<string, unknown>));
  // A settled-run source this build never knew is still a retired trigger, not damage.
  persisted.automations.push(retired(declarationInput("automation-after-something-else", {
    trigger: { kind: "on-settled", source: { kind: "something-else", connectedFolder: connectedFolderA } },
  }) as Record<string, unknown>));
  await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  const reloaded = await AmpleFileAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });
  const status = reloaded.status();
  assert.equal(status.damaged, false, "one retired record never marks the whole store damaged");
  assert.equal(status.automationCount, 2);
  assert.equal(status.enabledCount, 2);
  assert.deepEqual(status.retiredAutomations?.map((automation) => automation.id), [
    "automation-runs-a-check",
    "automation-after-a-check",
    "automation-reads-findings",
    "automation-after-an-app",
    "automation-after-something-else",
  ]);
  assert.equal(status.retiredAutomations?.[0]?.title, "Automation automation-runs-a-check");
  assert.match(status.retiredAutomations?.[0]?.reason ?? "", /runs a Check/);
  assert.match(status.retiredAutomations?.[1]?.reason ?? "", /waits for a Check run/);
  assert.match(status.retiredAutomations?.[2]?.reason ?? "", /\{\{trigger\.findings\}\}/);
  assert.equal(status.retiredAutomations?.[3]?.title, "Automation automation-after-an-app");
  assert.match(status.retiredAutomations?.[3]?.reason ?? "", /Connected Folder app's automation/);
  assert.match(status.retiredAutomations?.[4]?.reason ?? "", /waits for other work to settle/);
  assert.deepEqual((await reloaded.list()).map((record) => record.declaration.id), [
    "automation-keeps-working",
    "automation-literal-braces",
  ]);

  // The next write leaves the retired records out of the file; the valid ones keep their grants.
  await reloaded.disable("automation-literal-braces");
  const rewritten = JSON.parse(await readFile(statePath, "utf8")) as { automations: Array<{ declaration: { id: string }; health: string }> };
  assert.deepEqual(rewritten.automations.map((record) => [record.declaration.id, record.health]), [
    ["automation-keeps-working", "enabled"],
    ["automation-literal-braces", "disabled"],
  ]);
  const again = await AmpleFileAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });
  assert.equal(again.status().retiredAutomations, undefined);
});

test("damaged or tampered state disables the store and is never overwritten", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-automation-store-damage-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const receipts = new AmpleFileAutomationReceipts({ path: join(sandbox, "receipts.jsonl") });

  const unreadablePath = join(sandbox, "unreadable.json");
  await writeFile(unreadablePath, "{not json", "utf8");
  const unreadable = await AmpleFileAutomationStore.create({ path: unreadablePath, receipts });
  assert.equal(unreadable.status().damaged, true);
  await assert.rejects(
    () => unreadable.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1")),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "STORE_DAMAGED",
  );
  await assert.rejects(
    () => unreadable.list(),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "STORE_DAMAGED",
  );
  assert.equal(await readFile(unreadablePath, "utf8"), "{not json", "damaged state is preserved for inspection, never overwritten");

  const futurePath = join(sandbox, "future.json");
  await writeFile(futurePath, JSON.stringify({ schemaVersion: 99, automations: [] }), "utf8");
  const future = await AmpleFileAutomationStore.create({ path: futurePath, receipts });
  assert.match(future.status().damageReason ?? "", /newer AmpleFile/);

  const goodPath = join(sandbox, "good.json");
  const goodReceipts = new AmpleFileAutomationReceipts({ path: join(sandbox, "good-receipts.jsonl") });
  const good = await AmpleFileAutomationStore.create({ path: goodPath, receipts: goodReceipts, now: () => fixedNow });
  await good.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1"));
  const persisted = JSON.parse(await readFile(goodPath, "utf8")) as { automations: Array<{ digest: string }> };
  persisted.automations[0]!.digest = "f".repeat(64);
  await writeFile(goodPath, JSON.stringify(persisted), "utf8");
  const tampered = await AmpleFileAutomationStore.create({ path: goodPath, receipts: goodReceipts });
  assert.equal(tampered.status().damaged, true, "digest-mismatched authority never loads");
  assert.match(tampered.status().damageReason ?? "", /digest does not match/);
});

test("journal rotation waits for open runs, and the recovery scan fails closed on damage", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-automation-receipts-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const path = join(sandbox, "receipts.jsonl");
  const rotatedPath = join(sandbox, "receipts.1.jsonl");
  const receipts = new AmpleFileAutomationReceipts({ path, rotatedPath, maxBytes: 600, now: () => fixedNow });

  assert.equal(await receipts.append({ scope: "run", outcome: "accepted", automationId: "automation-weekly-handoff", runId: "run-1" }), true);
  assert.equal(await receipts.append({ scope: "hop", outcome: "accepted", automationId: "automation-weekly-handoff", runId: "run-1", hopId: "notify" }), true);
  for (let index = 0; index < 6; index += 1) {
    await receipts.append({ scope: "automation", outcome: "enabled", automationId: `automation-filler-${String(index).padStart(4, "0")}` });
  }
  assert.equal(await stat(rotatedPath).catch(() => null), null, "rotation waits while run-1 is still open");
  assert.deepEqual(await receipts.scanOpenRuns(), [
    { automationId: "automation-weekly-handoff", runId: "run-1", openHopIds: ["notify"] },
  ]);

  await receipts.append({ scope: "hop", outcome: "succeeded", automationId: "automation-weekly-handoff", runId: "run-1", hopId: "notify" });
  await receipts.append({ scope: "run", outcome: "succeeded", automationId: "automation-weekly-handoff", runId: "run-1" });
  await receipts.append({ scope: "automation", outcome: "enabled", automationId: "automation-after-close" });
  assert.notEqual(await stat(rotatedPath).catch(() => null), null, "a closed journal over the size bound rotates");
  assert.deepEqual(await receipts.scanOpenRuns(), [], "the scan reads the rotated and live files together");

  await writeFile(path, `${await readFile(path, "utf8")}not-json\n`, "utf8");
  await assert.rejects(
    () => receipts.scanOpenRuns(),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "JOURNAL_DAMAGED",
    "an unreadable journal line refuses recovery instead of guessing",
  );
});

test("suspension persists even when its journal line cannot be written: revocation is never blocked", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-automation-store-narrow-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const journalPath = join(sandbox, "receipts.jsonl");
  const receipts = new AmpleFileAutomationReceipts({ path: journalPath, now: () => fixedNow });
  const statePath = join(sandbox, "automations.json");
  const store = await AmpleFileAutomationStore.create({ path: statePath, receipts, now: () => fixedNow });
  await store.enable(enableInput(declarationInput("automation-weekly-handoff"), "decision-1"));

  // Replace the journal with a directory so every further append fails.
  await rm(journalPath, { force: true });
  await mkdir(journalPath);

  const { suspended } = await store.suspendForConnectedFolderRemoval(connectedFolderA, fixedNow);
  assert.deepEqual(suspended.map((record) => record.declaration.id), ["automation-weekly-handoff"]);
  const reloaded = await AmpleFileAutomationStore.create({ path: statePath, now: () => fixedNow });
  assert.equal((await reloaded.get("automation-weekly-handoff"))?.health, "suspended", "narrowing persisted without its receipt line");

  await assert.rejects(
    () => store.delete("automation-weekly-handoff"),
    (error: unknown) => error instanceof AmpleFileAutomationStoreError && error.code === "JOURNAL_UNAVAILABLE",
    "deletion destroys the audit anchor, so it stays strictly journal-first",
  );
  assert.equal((await store.get("automation-weekly-handoff"))?.health, "suspended");
});
