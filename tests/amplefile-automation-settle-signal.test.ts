import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RestrictedAppService } from "../src/local/agent/restricted-app-service.js";
import {
  AmpleFileSettleSignal,
  type AmpleFileAppAutomationRunSettleRecord,
  type AmpleFileAutomationHopLineage,
  type AmpleFileSettleRecord,
} from "../src/local/automations/settle-signal.js";

const firstAppAutomationRunRecord: AmpleFileAppAutomationRunSettleRecord = {
  kind: "app-automation-run",
  connectedFolderId: "connected-folder-shape",
  appId: "connected-inbox",
  appAutomationId: "file-mail",
  runId: "app-automation-run-0",
  outcome: "success",
  reason: "scheduled",
  scheduledAt: "2026-08-10T17:00:00.000Z",
  startedAt: "2026-08-10T17:00:00.100Z",
  finishedAt: "2026-08-10T17:00:01.000Z",
};

const appAutomationRunRecord: AmpleFileAppAutomationRunSettleRecord = {
  kind: "app-automation-run",
  connectedFolderId: "connected-folder-shape",
  appId: "connected-inbox",
  appAutomationId: "refresh-mail",
  runId: "app-automation-run-1",
  outcome: "success",
  reason: "scheduled",
  scheduledAt: "2026-08-10T17:00:00.000Z",
  startedAt: "2026-08-10T17:00:00.100Z",
  finishedAt: "2026-08-10T17:00:00.900Z",
};

const lineage: AmpleFileAutomationHopLineage = {
  kind: "automation-hop",
  automationId: "automation-1",
  automationRunId: "automation-run-1",
  hopId: "verify",
};

test("settle records reach listeners in publication order as isolated copies", () => {
  const signal = new AmpleFileSettleSignal();
  const deliveries: string[] = [];
  signal.subscribe((record) => {
    deliveries.push(`one:${record.runId}`);
    if (record.runId === "app-automation-run-0") {
      record.appAutomationId = "mutant";
      record.outcome = "failure";
    }
  });
  signal.subscribe((record) => {
    deliveries.push(`two:${record.runId}`);
    if (record.runId === "app-automation-run-0") {
      assert.equal(record.appAutomationId, "file-mail", "one listener's mutation must not reach another");
      assert.equal(record.outcome, "success");
      assert.deepEqual(record.lineage, lineage);
    }
  });

  const published = structuredClone(firstAppAutomationRunRecord);
  published.lineage = structuredClone(lineage);
  signal.publish(published);
  signal.publish(appAutomationRunRecord);

  assert.deepEqual(deliveries, [
    "one:app-automation-run-0",
    "two:app-automation-run-0",
    "one:app-automation-run-1",
    "two:app-automation-run-1",
  ]);
  assert.equal(published.appAutomationId, "file-mail", "listeners must not mutate the publisher's record");
  assert.equal("lineage" in appAutomationRunRecord, false, "publication must not decorate the caller's record");
  assert.deepEqual(signal.listListenerErrors(), []);
});

test("listener failures are bounded diagnostics, never a publisher error", async () => {
  const signal = new AmpleFileSettleSignal({
    now: () => new Date("2026-08-10T18:00:00.000Z"),
    maxListenerErrors: 2,
  });
  const received: string[] = [];
  signal.subscribe(() => {
    throw new Error(`sync listener bug ${"x".repeat(400)}`);
  });
  signal.subscribe(async () => {
    throw new Error("async listener bug");
  });
  signal.subscribe((record) => {
    received.push(record.runId);
  });

  signal.publish(firstAppAutomationRunRecord);
  await waitForCondition(() => signal.listListenerErrors().length === 2);
  assert.deepEqual(received, ["app-automation-run-0"], "a failing listener never blocks delivery to the rest");
  const [syncError, asyncError] = signal.listListenerErrors();
  assert.equal(syncError?.recordKind, "app-automation-run");
  assert.equal(syncError?.runId, "app-automation-run-0");
  assert.equal(syncError?.occurredAt, "2026-08-10T18:00:00.000Z");
  assert.equal(syncError?.error.length, 300, "listener error text is bounded");
  assert.equal(syncError?.error.endsWith("…"), true);
  assert.equal(asyncError?.error, "async listener bug");

  signal.publish(appAutomationRunRecord);
  await waitForCondition(() => {
    const errors = signal.listListenerErrors();
    return errors.length === 2 && errors.every((error) => error.runId === "app-automation-run-1");
  });
  assert.deepEqual(
    signal.listListenerErrors().map((error) => error.runId),
    ["app-automation-run-1", "app-automation-run-1"],
    "overflow drops the oldest diagnostics",
  );
});

test("subscription capacity is bounded and unsubscribe is idempotent", () => {
  const signal = new AmpleFileSettleSignal({ maxListeners: 1 });
  const received: string[] = [];
  const listener = (record: AmpleFileSettleRecord) => {
    received.push(record.runId);
  };
  const unsubscribe = signal.subscribe(listener);
  assert.equal(signal.listenerCount, 1);
  assert.throws(() => signal.subscribe(listener), /already subscribed/);
  assert.throws(() => signal.subscribe(() => undefined), /capacity exhausted/);

  unsubscribe();
  unsubscribe();
  assert.equal(signal.listenerCount, 0);
  signal.publish(firstAppAutomationRunRecord);
  assert.deepEqual(received, [], "an unsubscribed listener receives nothing");
  const replacement = signal.subscribe(() => undefined);
  assert.equal(signal.listenerCount, 1, "released capacity is reusable");
  replacement();
});

test("automation settles publish once after the durable receipt and never fail the run", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-settle-app-automation-"));
  const connectedFolderRoot = join(sandbox, "connected-folder");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const connectedFolderId = "ws-1111111111111111";
  const signal = new AmpleFileSettleSignal();
  const received: AmpleFileSettleRecord[] = [];
  const durableAtPublication: boolean[] = [];
  signal.subscribe(() => {
    throw new Error("automation listener bug");
  });
  signal.subscribe((record) => {
    if (record.kind !== "app-automation-run") return;
    const registry = JSON.parse(readFileSync(join(rootPath, "registry.json"), "utf8")) as {
      historicalAppAutomationRuns: Array<{ runId: string }>;
    };
    durableAtPublication.push(registry.historicalAppAutomationRuns.some((run) => run.runId === record.runId));
    received.push(record);
  });
  try {
    await writeAppAutomationPackage(join(connectedFolderRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: {
        invoke: async () => ({}),
        runAppAutomation: async () => {},
        stop: async () => {},
        close: async () => {},
      },
      deferAppAutomationStart: false,
      settleSignal: signal,
    });
    try {
      const review = await service.inspect({ connectedFolderId, connectedFolderRoot, sourcePath: "apps/inbox" });
      await service.install({ connectedFolderId, connectedFolderRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
      await service.setAppAutomationEnabled({
        connectedFolderId,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        appAutomationId: "refresh-mail",
        enabled: true,
      });
      const persisted = await service.runAppAutomationNow({
        connectedFolderId,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        appAutomationId: "refresh-mail",
      });
      assert.equal(persisted.run.outcome, "success", "a listener bug must never fail the automation run");
      assert.equal(received.length, 1, "the manual-run duplicate record path never publishes twice");
      assert.deepEqual(received, [{
        kind: "app-automation-run",
        connectedFolderId,
        appId: "connected-inbox",
        appAutomationId: "refresh-mail",
        runId: persisted.run.runId,
        outcome: "success",
        reason: "manual",
        scheduledAt: persisted.run.scheduledAt,
        startedAt: persisted.run.startedAt,
        finishedAt: persisted.run.finishedAt,
      }]);
      assert.equal("lineage" in received[0]!, false, "app automation settles carry no automation lineage today");
      assert.deepEqual(durableAtPublication, [true], "publication happens only after the receipt is durable");
      assert.equal(signal.listListenerErrors().length, 1, "the failing listener is isolated into diagnostics");
      assert.deepEqual(
        await service.listAppAutomationRuns(connectedFolderId, "connected-inbox", review.digest, "refresh-mail"),
        [persisted.run],
        "the durable receipt is unaffected by listener failures",
      );
    } finally {
      await service.close();
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function writeAppAutomationPackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "connected-inbox",
    version: "0.1.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: "connected-inbox",
    title: "Connected inbox",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "mail" },
    tools: [{
      name: "inbox_search",
      description: "Search the connected inbox.",
      action: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 500 } },
        required: ["query"],
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    }],
    automations: [{
      id: "refresh-mail",
      title: "Refresh inbox",
      description: "Check for newly arrived messages.",
      handler: "refresh-inbox",
      trigger: { kind: "interval", intervalMinutes: 30 },
      permissions: { network: ["mail-api"], files: [], notifications: ["new-mail"] },
      catchUp: "latest",
      overlap: "skip",
    }],
    permissions: {
      files: [],
      notifications: [{ id: "new-mail", title: "New mail", description: "New messages are ready." }],
      network: [{
        id: "mail-api",
        target: { kind: "public-https", origin: "https://mail.example.com" },
        methods: ["GET"],
        auth: [{ kind: "api-key", header: "x-api-key" }],
      }],
    },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
  await writeFile(
    join(root, "worker.js"),
    "// This code must remain inert during review and installation.\nexport async function handleAction() { return { count: 0 }; }\nexport async function handleAutomation() {}\n",
    "utf8",
  );
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
