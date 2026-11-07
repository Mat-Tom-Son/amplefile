import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AmpleFileCheckOperationConflictError, AmpleFileCheckService } from "../src/local/checks/check-service.js";
import { AmpleFileCheckStore } from "../src/local/checks/check-store.js";
import { AmpleFileKernel } from "../src/local/amplefile-kernel.js";

const proposal = {
  kind: "amplefile.check-proposal",
  version: 1,
  name: "Required handoff",
  createdBy: "human",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "The signed handoff exists",
    severity: "error",
    trigger: "manual",
    sensor: { id: "amplefile.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Delivery/signed.pdf" }],
  },
} as const;

test("optional Checks complete proposal, grant, task, evidence, decision, stale, and clear lifecycle", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-service-"));
  const root = join(sandbox, "connected-folder");
  const machine = join(sandbox, "machine");
  await mkdir(root);
  await mkdir(machine);
  const proposalPath = join(sandbox, "handoff.amplefile-check.json");
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);

  const kernel = new AmpleFileKernel({ createTaskId: () => "unexpected-generated-task" });
  let taskCounter = 0;
  let runCounter = 0;
  const service = new AmpleFileCheckService({
    kernel,
    createTaskId: () => `check-task-${++taskCounter}`,
    createRunId: () => `check-run-${++runCounter}`,
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(machine, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-delivery", root)],
  });
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-delivery", connectedFolderRoot: root };

  assert.deepEqual(await service.status(connectedFolder), {
    kind: "amplefile.checks.experimental",
    version: 1,
    connectedFolderId: connectedFolder.id,
    state: "not-configured",
    configured: 0,
    proposed: 0,
    enabled: 0,
    current: 0,
    neverRun: 0,
    stale: 0,
    blocked: 0,
    errors: 0,
    needsAttention: 0,
    running: 0,
    lastRunAt: null,
  });

  const enabled = await service.enable({ connectedFolder, proposalPath, actor: "human" });
  const enabledAgain = await service.enable({ connectedFolder, proposalPath, actor: "human" });
  assert.equal(enabledAgain.declaration.id, enabled.declaration.id, "re-enabling the same proposal is idempotent");
  assert.equal((await readdir(join(root, ".amplefile", "checks"))).filter((name) => name.endsWith(".json")).length, 1);
  const neverRun = await service.status(connectedFolder);
  assert.equal(neverRun.state, "stale", "enabled but never run is not clear");
  assert.equal(neverRun.neverRun, 1, "enabled Checks awaiting their first run remain explicit");
  assert.equal(neverRun.stale, 0, "never-run Checks are not miscounted as changed prior results");
  const declarations = JSON.parse(await readFile(join(root, ".amplefile", "checks", `${enabled.declaration.id}.json`), "utf8"));
  assert.equal(declarations.sensor.id, "amplefile.file-presence");
  assert.equal("enabled" in declarations, false, "portable data must not carry machine authority");

  const accepted = await service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "cli", connectedFolderId: connectedFolder.id } });
  const during = await kernel.getTasks({ kind: "cli" });
  assert.deepEqual(during.tasks, [], "experimental Check tasks stay out of amplefile.tasks v1");
  const first = await waitForTerminal(service, connectedFolder.id, accepted.taskId);
  assert.equal(first.state, "succeeded");
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0]?.evidence[0]?.kind, "path-state");
  assert.equal((await service.status(connectedFolder)).state, "needs-attention");

  const settledSummaries = await service.settledRuns(connectedFolder);
  assert.deepEqual(settledSummaries.map((run) => [run.runId, run.taskId, run.state, run.admittedCount]), [
    ["check-run-1", "check-task-1", "succeeded", 1],
  ], "settled-run summaries expose identifiers and counts for the overview");
  const summaryKeys = Object.keys(settledSummaries[0]!).sort();
  assert.deepEqual(
    summaryKeys,
    ["admittedCount", "endedAt", "runId", "startedAt", "state", "taskId"],
    "settled-run summaries stay content-free: no findings, evidence, inputs, or paths",
  );

  const problems = await service.problems(connectedFolder);
  assert.equal(problems.findings.length, 1);
  assert.deepEqual(await service.decorations(connectedFolder), {
    kind: "amplefile.checks.decorations",
    version: 1,
    connectedFolderId: connectedFolder.id,
    items: [{ path: "Delivery/signed.pdf", count: 1 }],
  });
  const rendererOverview = await service.overview(connectedFolder);
  assert.equal(rendererOverview.kind, "amplefile.checks.renderer");
  assert.equal(rendererOverview.status.state, "needs-attention");
  assert.equal(rendererOverview.checks.length, 1);
  assert.equal(rendererOverview.checks[0]?.authority, "enabled");
  assert.deepEqual(rendererOverview.checks[0]?.targets, proposal.check.targets);
  assert.equal(rendererOverview.findings[0]?.targetPath, "Delivery/signed.pdf");
  await assert.rejects(() => service.decide({
    connectedFolderId: connectedFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "defer",
    deferUntil: "2000-01-01T00:00:00.000Z",
    actor: "human",
  }), /future deferUntil/);
  await service.decide({
    connectedFolderId: connectedFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "resolve",
    actor: "human",
  });
  const decisionRevision = JSON.parse(await readFile(join(machine, `${connectedFolder.id}.json`), "utf8")).revision;
  await service.decide({
    connectedFolderId: connectedFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "resolve",
    actor: "human",
  });
  assert.equal(
    JSON.parse(await readFile(join(machine, `${connectedFolder.id}.json`), "utf8")).revision,
    decisionRevision,
    "an identical still-current decision does not rewrite machine state",
  );
  assert.equal((await service.problems(connectedFolder)).findings.length, 0);
  assert.equal((await service.status(connectedFolder)).state, "current-clear");

  await mkdir(join(root, "Delivery"));
  await writeFile(join(root, "Delivery", "signed.pdf"), "%PDF arbitrary bytes");
  assert.equal((await service.status(connectedFolder)).state, "stale");
  await assert.rejects(() => service.decide({
    connectedFolderId: connectedFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "resolve",
    actor: "human",
  }), (error: unknown) => error instanceof AmpleFileCheckOperationConflictError
    && /no longer current/.test(error.message));

  const rerun = await service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "cli", connectedFolderId: connectedFolder.id } });
  const clear = await waitForTerminal(service, connectedFolder.id, rerun.taskId);
  assert.equal(clear.state, "succeeded");
  assert.equal(clear.findings.length, 0);
  assert.equal((await service.status(connectedFolder)).state, "current-clear");
  await assert.rejects(() => service.decide({
    connectedFolderId: connectedFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "reject",
    actor: "human",
  }), (error: unknown) => error instanceof AmpleFileCheckOperationConflictError
    && /no longer active/.test(error.message));

  await unlink(join(root, "Delivery", "signed.pdf"));
  const recurrence = await service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "cli", connectedFolderId: connectedFolder.id } });
  const recurred = await waitForTerminal(service, connectedFolder.id, recurrence.taskId);
  assert.equal(recurred.findings.length, 1);
  assert.equal((await service.problems(connectedFolder)).findings.length, 1, "a fixed finding that later recurs must not inherit an old resolve decision");
  assert.equal((await service.status(connectedFolder)).state, "needs-attention");
  assert.deepEqual(
    (await service.settledRuns(connectedFolder)).map((run) => run.runId).sort(),
    ["check-run-1", "check-run-2", "check-run-3"],
    "every terminal run keeps a content-free summary",
  );
});

test("accepted and running Check work is pending rather than a content or infrastructure error", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-running-status-"));
  const root = join(sandbox, "connected-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  let enteredRun!: () => void;
  const running = new Promise<void>((resolve) => { enteredRun = resolve; });
  let releaseRun!: () => void;
  const release = new Promise<void>((resolve) => { releaseRun = resolve; });
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-running", root)],
    resolveSensor: (id, revision) => id === "amplefile.file-presence" && revision === 1 ? {
      id,
      revision,
      implementationDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      execution: "deterministic",
      validate() {},
      async run() {
        enteredRun();
        await release;
        return { candidates: [], skippedCount: 0 };
      },
    } : null,
  });
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-running", connectedFolderRoot: root };
  const enabled = await service.enable({ connectedFolder, proposalPath, actor: "human" });
  const accepted = await service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  await running;
  const status = await service.status(connectedFolder);
  assert.equal(status.running, 1);
  assert.equal(status.errors, 0);
  assert.notEqual(status.state, "check-error");
  releaseRun();
  await waitForTerminal(service, connectedFolder.id, accepted.taskId);
});

test("a rejected Check store creation is evicted so a repaired store can be retried", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-store-retry-"));
  const root = join(sandbox, "connected-folder");
  await mkdir(root);
  let attempts = 0;
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-retry", root)],
    storeFactory: async (connectedFolderId) => {
      attempts += 1;
      if (attempts === 1) throw new Error("damaged state");
      return AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, "repaired.json") });
    },
  });
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-retry", connectedFolderRoot: root };
  await assert.rejects(() => service.status(connectedFolder), /damaged state/);
  assert.equal((await service.status(connectedFolder)).state, "not-configured");
  assert.equal(attempts, 2);
});

test("changed portable declarations lose exact machine authority", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-digest-"));
  const root = join(sandbox, "connected-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  const kernel = new AmpleFileKernel();
  const service = new AmpleFileCheckService({
    kernel,
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-digest", root)],
  });
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-digest", connectedFolderRoot: root };
  const enabled = await service.enable({ connectedFolder, proposalPath, actor: "human" });
  const declarationPath = join(root, ".amplefile", "checks", `${enabled.declaration.id}.json`);
  const changed = JSON.parse(await readFile(declarationPath, "utf8"));
  changed.title = "Changed outside the enable act";
  await writeFile(declarationPath, JSON.stringify(changed));

  const status = await service.status(connectedFolder);
  assert.equal(status.enabled, 0);
  assert.equal(status.proposed, 1);
  await assert.rejects(() => service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } }), /Enabled Check not found/);
});

test("damaged declarations are health errors, never an unconfigured or clear state", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-damaged-declaration-"));
  const root = join(sandbox, "connected-folder");
  await mkdir(join(root, ".amplefile", "checks"), { recursive: true });
  await writeFile(join(root, ".amplefile", "checks", "damaged.json"), "{nope");
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-damaged", root)],
  });
  t.after(() => service.close());

  const status = await service.status({ id: "connected-folder-damaged", connectedFolderRoot: root });
  assert.equal(status.state, "check-error");
  assert.equal(status.errors, 1);
});

test("the service binds a stable Connected Folder id to its registered folder", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-connected-folder-binding-"));
  const root = join(sandbox, "connected-folder");
  const wrongRoot = join(sandbox, "Other");
  await mkdir(root);
  await mkdir(wrongRoot);
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-bound", root)],
  });
  t.after(() => service.close());

  await assert.rejects(
    () => service.status({ id: "connected-folder-bound", connectedFolderRoot: wrongRoot }),
    /does not match the registered Connected Folder's folder/,
  );

  const releaseRegistryMutation = service.tryReserveConnectedFolderRegistryMutation();
  assert.ok(releaseRegistryMutation);
  await assert.rejects(
    () => service.status({ id: "connected-folder-bound", connectedFolderRoot: root }),
    /current Check operation/,
    "evidence work cannot start while a Connected Folder registration may change target ownership",
  );
  releaseRegistryMutation();

  const releaseRemoval = service.tryReserveConnectedFolderRemoval("connected-folder-bound");
  assert.ok(releaseRemoval);
  await assert.rejects(
    () => service.status({ id: "connected-folder-bound", connectedFolderRoot: root }),
    /current Check operation/,
    "status cannot start after Check cleanup has been reserved for Connected Folder removal",
  );
  releaseRemoval();
});

test("admission failure makes the run and status unhealthy, and status never executes a sensor", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-admission-health-"));
  const root = join(sandbox, "connected-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  let executions = 0;
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-health", root)],
    resolveSensor: (id, revision) => id === "amplefile.file-presence" && revision === 1 ? {
      id,
      revision,
      implementationDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      execution: "deterministic",
      validate() {},
      async run({ declaration }) {
        executions += 1;
        const path = declaration.targets[0]!.path;
        return {
          skippedCount: 0,
          candidates: [{
            title: "Fabricated observation",
            targetPath: path,
            evidence: [{
              kind: "path-state",
              path,
              expected: "missing",
              observed: "file",
              identity: { checkId: declaration.id, path, state: "file" },
            }],
          }],
        };
      },
    } : null,
  });
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-health", connectedFolderRoot: root };
  const enabled = await service.enable({ connectedFolder, proposalPath, actor: "human" });
  assert.equal(executions, 0);
  await service.status(connectedFolder);
  assert.equal(executions, 0, "content-free status cannot execute provider logic");

  const accepted = await service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  const run = await waitForTerminal(service, connectedFolder.id, accepted.taskId);
  assert.equal(run.state, "failed");
  assert.equal(run.discardedCount, 1);
  assert.equal((await service.status(connectedFolder)).state, "check-error");
  assert.equal(executions, 1, "status freshness remains runner-owned after the run");
});

test("terminal persistence failure retains the task fence until task polling repairs it", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-terminal-recovery-"));
  const root = join(sandbox, "connected-folder");
  const otherRoot = join(sandbox, "Other Connected Folder");
  await mkdir(root);
  await mkdir(otherRoot);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify({
    ...proposal,
    check: { ...proposal.check, sensor: { ...proposal.check.sensor, parameters: { expect: "absent" } } },
  }));
  const store = await AmpleFileCheckStore.create("connected-folder-recovery", { path: join(sandbox, "state.json") });
  const otherStore = await AmpleFileCheckStore.create("connected-folder-other", { path: join(sandbox, "other-state.json") });
  const finishRun = store.finishRun.bind(store);
  let injectedFailures = 0;
  store.finishRun = async (run) => {
    if (run.state === "succeeded" && injectedFailures++ === 0) throw new Error("injected terminal write failure");
    return finishRun(run);
  };
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    storeFactory: async (connectedFolderId) => connectedFolderId === "connected-folder-recovery" ? store : otherStore,
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-recovery", root), connectedFolderSummary("connected-folder-other", otherRoot)],
  });
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-recovery", connectedFolderRoot: root };
  const enabled = await service.enable({ connectedFolder, proposalPath, actor: "human" });
  const accepted = await service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  await waitForCondition(() => injectedFailures > 0);
  assert.equal(service.hasActiveRun(connectedFolder.id), true, "the capability fence remains while terminal state is not durable");

  const wrongConnectedFolderStatus = await service.taskStatus("connected-folder-other", accepted.taskId);
  assert.equal(wrongConnectedFolderStatus.state, "unknown");
  assert.equal(service.hasActiveRun(connectedFolder.id), true, "another Connected Folder cannot terminalize or release this recovery task");

  const status = await service.taskStatus(connectedFolder.id, accepted.taskId);
  assert.equal(status.state, "succeeded");
  assert.equal(service.hasActiveRun(connectedFolder.id), false);
});

test("run-all supports the full declaration authority ceiling", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-many-run-"));
  const root = join(sandbox, "connected-folder");
  await mkdir(root);
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-many", root)],
  });
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-many", connectedFolderRoot: root };
  for (let index = 0; index < 65; index += 1) {
    const proposalPath = join(sandbox, `proposal-${index}.json`);
    await writeFile(proposalPath, JSON.stringify({
      ...proposal,
      name: `Optional file ${index}`,
      check: {
        ...proposal.check,
        title: `Optional file ${index} stays absent`,
        sensor: { ...proposal.check.sensor, parameters: { expect: "absent" } },
        targets: [{ kind: "file", role: "primary", path: `Files/item-${index}.txt` }],
      },
    }));
    await service.enable({ connectedFolder, proposalPath, actor: "human" });
  }

  const accepted = await service.run({ connectedFolder, actor: { kind: "renderer", connectedFolderId: connectedFolder.id } });
  assert.equal(accepted.checkIds.length, 65);
  assert.equal((await waitForTerminal(service, connectedFolder.id, accepted.taskId)).state, "succeeded");
});

test("run admission is synchronously reserved for every adapter", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-run-reservation-"));
  const root = join(sandbox, "connected-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify({
    ...proposal,
    check: { ...proposal.check, sensor: { ...proposal.check.sensor, parameters: { expect: "absent" } } },
  }));
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-reservation", root)],
  });
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-reservation", connectedFolderRoot: root };
  const enabled = await service.enable({ connectedFolder, proposalPath, actor: "human" });
  const first = service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  await assert.rejects(
    () => service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "renderer" } }),
    (error: unknown) => error instanceof AmpleFileCheckOperationConflictError
      && /current Check run/.test(error.message),
  );
  await assert.rejects(
    () => service.removeConnectedFolder(connectedFolder.id),
    (error: unknown) => error instanceof AmpleFileCheckOperationConflictError
      && /current Check operation/.test(error.message),
    "a direct adapter cannot remove the Connected Folder during run admission",
  );
  const accepted = await first;
  await waitForTerminal(service, connectedFolder.id, accepted.taskId);
});

test("recorded findings cannot cross into a folder that later becomes another Connected Folder", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-late-nested-connected-folder-"));
  const root = join(sandbox, "Parent");
  const childRoot = join(root, "Child");
  await mkdir(root);
  const proposalPath = join(sandbox, "nested-target.json");
  await writeFile(proposalPath, JSON.stringify({
    ...proposal,
    check: {
      ...proposal.check,
      targets: [{ kind: "file", role: "primary", path: "Child/report.pdf" }],
    },
  }));
  const connectedFolders = [connectedFolderSummary("connected-folder-parent", root)];
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => connectedFolders,
  });
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-parent", connectedFolderRoot: root };
  const enabled = await service.enable({ connectedFolder, proposalPath, actor: "human" });
  const accepted = await service.run({ connectedFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  const run = await waitForTerminal(service, connectedFolder.id, accepted.taskId);
  assert.equal(run.findings.length, 1);

  await mkdir(childRoot);
  connectedFolders.push(connectedFolderSummary("connected-folder-child", childRoot));
  const problems = await service.problems(connectedFolder);
  assert.deepEqual(problems.findings, [], "old evidence must not be read or surfaced across the new Connected Folder boundary");
  assert.deepEqual(problems.healthErrors, ["A Check target now overlaps another registered Connected Folder."]);
  const status = await service.status(connectedFolder);
  assert.equal(status.blocked, 1);
  assert.equal(status.needsAttention, 0);
});

test("Connected Folder removal purges local Check authority so re-registration cannot revive it", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-removal-"));
  const root = join(sandbox, "connected-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  const statePath = join(sandbox, "state.json");
  const options = {
    kernel: new AmpleFileKernel(),
    storeFactory: (connectedFolderId: string) => AmpleFileCheckStore.create(connectedFolderId, { path: statePath }),
    listConnectedFolders: async () => [connectedFolderSummary("connected-folder-removal", root)],
  };
  const service = new AmpleFileCheckService(options);
  t.after(() => service.close());
  const connectedFolder = { id: "connected-folder-removal", connectedFolderRoot: root };
  const enabling = service.enable({ connectedFolder, proposalPath, actor: "human" });
  assert.equal(
    service.tryReserveConnectedFolderRegistryMutation(),
    null,
    "Connected Folder registration cannot race target validation or declaration enablement",
  );
  await assert.rejects(
    () => service.removeConnectedFolder(connectedFolder.id),
    /current Check operation/,
    "a direct adapter cannot remove the Connected Folder while enablement is materializing authority",
  );
  await enabling;
  assert.equal((await service.status(connectedFolder)).enabled, 1);
  await service.removeConnectedFolder(connectedFolder.id);

  const reRegistered = new AmpleFileCheckService({ ...options, kernel: new AmpleFileKernel() });
  t.after(() => reRegistered.close());
  const status = await reRegistered.status(connectedFolder);
  assert.equal(status.enabled, 0);
  assert.equal(status.proposed, 1, "the portable declaration is discoverable but inert again");
});

async function waitForTerminal(service: AmpleFileCheckService, connectedFolderId: string, taskId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await service.taskStatus(connectedFolderId, taskId);
    if (status.state !== "accepted" && status.state !== "running") return service.taskResult(connectedFolderId, taskId);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Check task.");
}

function connectedFolderSummary(id: string, connectedFolderRoot: string) {
  return {
    id,
    name: id,
    connectedFolderRoot,
    location: { kind: "local" as const, storage: "linked" as const },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

test("selected Check results reverify one pinned declaration without running sensors or disclosing sibling Checks", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-selected-check-"));
  const root = join(sandbox, "connected-folder");
  await mkdir(root);
  const connectedFolder = { id: "connected-folder-selected", connectedFolderRoot: root };
  const service = new AmpleFileCheckService({
    kernel: new AmpleFileKernel(),
    storeFactory: (connectedFolderId) => AmpleFileCheckStore.create(connectedFolderId, { path: join(sandbox, `${connectedFolderId}.json`) }),
    listConnectedFolders: async () => [connectedFolderSummary(connectedFolder.id, root)],
  });
  t.after(() => service.close());
  const path = join(sandbox, "proposal.json");
  await writeFile(path, JSON.stringify(proposal));
  const selected = await service.enable({ connectedFolder, proposalPath: path, actor: "human" });
  await writeFile(path, JSON.stringify({ ...proposal, name: "Private unrelated", check: { ...proposal.check, title: "Secret unrelated title", targets: [{ kind: "file", role: "primary", path: "secret.txt" }] } }));
  const sibling = await service.enable({ connectedFolder, proposalPath: path, actor: "human" });
  const read = () => service.selectedResult(connectedFolder, selected.declaration.id, selected.digest);
  assert.equal((await read()).state, "never-run");
  assert.equal((await service.settledRuns(connectedFolder)).length, 0);
  const run = await service.run({ connectedFolder, actor: { kind: "cli", connectedFolderId: connectedFolder.id } });
  await waitForTerminal(service, connectedFolder.id, run.taskId);
  const result = await read();
  assert.equal(result.state, "needs-attention");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.path, "Delivery/signed.pdf");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes(sibling.declaration.id), false);
  assert.equal("connectedFolderRoot" in result, false);
  assert.equal("inputs" in result, false);
  await mkdir(join(root, "Delivery"));
  await writeFile(join(root, "Delivery", "signed.pdf"), "signed");
  const stale = await read();
  assert.equal(stale.state, "stale");
  assert.deepEqual(stale.findings, []);
  const rerun = await service.run({ connectedFolder, checkId: selected.declaration.id, actor: { kind: "cli", connectedFolderId: connectedFolder.id } });
  await waitForTerminal(service, connectedFolder.id, rerun.taskId);
  assert.equal((await read()).state, "current-clear");
  await service.disable(connectedFolder, selected.declaration.id);
  assert.equal((await read()).state, "blocked");
  await assert.rejects(service.selectedResult({ ...connectedFolder, connectedFolderRoot: sandbox }, selected.declaration.id, selected.digest));
  await assert.rejects(service.selectedResult(connectedFolder, selected.declaration.id, "0".repeat(64)), /changed or is unavailable/);
  const declarationPath = join(root, ".amplefile", "checks", `${selected.declaration.id}.json`);
  const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
  declaration.title = "Changed rubric identity";
  await writeFile(declarationPath, JSON.stringify(declaration));
  await assert.rejects(read(), /changed or is unavailable/);
  assert.equal((await service.settledRuns(connectedFolder)).length, 2, "reads never launch runs");
});
