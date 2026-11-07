import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { PiResourceCatalog } from "../src/local/agent/skill-catalog.js";
import {
  AmpleFileContextRequiredError,
  AmpleFileKernel,
} from "../src/local/amplefile-kernel.js";
import type { ConnectedFolderSummary } from "../src/local/connected-folder.js";

test("AmpleFileKernel resolves explicit and cwd Connected Folder context with deepest-root precedence", async () => {
  const root = join(process.cwd(), "kernel-fixtures", "root");
  const nestedRoot = join(root, "nested");
  const rootId = "space-1111111111111111";
  const nestedId = "space-2222222222222222";
  const connectedFolders = [
    connectedFolder(rootId, "Root", root, "2026-01-02T00:00:00.000Z"),
    connectedFolder(nestedId, "Nested", nestedRoot, "2026-01-03T00:00:00.000Z"),
  ];
  const kernel = kernelForConnectedFolders(connectedFolders);

  const explicit = await kernel.getContext({
    kind: "cli",
    connectedFolderId: rootId,
    cwd: join(nestedRoot, "documents"),
  });
  assert.equal(explicit.kind, "amplefile.context");
  assert.equal(explicit.version, 1);
  assert.equal(explicit.resolution, "connected-folder_id");
  assert.equal(explicit.connectedFolder?.id, rootId, "an explicit id must win over cwd inference");

  const inferred = await kernel.getContext({ kind: "cli", cwd: join(nestedRoot, "documents") });
  assert.equal(inferred.resolution, "cwd");
  assert.equal(inferred.connectedFolder?.id, nestedId, "the deepest containing Connected Folder must win");

  const outside = await kernel.getContext({ kind: "cli", cwd: join(process.cwd(), "somewhere-else") });
  assert.equal(outside.resolution, "none");
  assert.equal(outside.connectedFolder, null);

  const listed = await kernel.getConnectedFolders({ kind: "renderer" });
  assert.equal(listed.kind, "amplefile.connected-folders");
  assert.equal(listed.version, 1);
  assert.deepEqual(listed.connectedFolders.map((item) => item.id), [rootId, nestedId]);
  assert.equal(listed.connectedFolders[0].parentConnectedFolderId, undefined, "a top-level Connected Folder keeps its v1 shape");
  assert.equal(listed.connectedFolders[1].parentConnectedFolderId, rootId, "a nested Connected Folder names the Connected Folder that contains it");
  assert.notEqual(listed.connectedFolders[0].location, connectedFolders[0].location, "snapshots must not expose mutable registry objects");
});

test("AmpleFileKernel tracks and scopes running Worker tasks", async () => {
  const root = join(process.cwd(), "kernel-tasks", "root");
  const otherRoot = join(process.cwd(), "kernel-tasks", "other");
  const rootId = "space-3333333333333333";
  const otherId = "space-4444444444444444";
  const connectedFolders = [
    connectedFolder(rootId, "Root", root),
    connectedFolder(otherId, "Other", otherRoot),
  ];
  const timestamps = [new Date("2026-07-11T10:00:00.000Z"), new Date("2026-07-11T10:00:01.000Z")];
  const taskIds = ["task-turn", "task-compact"];
  const kernel = new AmpleFileKernel({
    ...connectedFolderDependencies(connectedFolders),
    now: () => timestamps.shift() ?? new Date("2026-07-11T10:00:02.000Z"),
    createTaskId: () => taskIds.shift() ?? "task-extra",
  });

  const turn = kernel.startTask({
    kind: "assistant_turn",
    connectedFolderId: rootId,
    conversationId: "chat-one",
    actor: { kind: "assistant", connectedFolderId: rootId, conversationId: "chat-one", cwd: root },
  });
  kernel.startTask({
    kind: "compaction",
    connectedFolderId: otherId,
    conversationId: "chat-two",
    actor: { kind: "assistant", connectedFolderId: otherId, conversationId: "chat-two", cwd: otherRoot },
  });

  const all = await kernel.getTasks({ kind: "system" });
  assert.equal(all.kind, "amplefile.tasks");
  assert.equal(all.version, 1);
  assert.equal(all.connectedFolderId, null);
  assert.deepEqual(all.tasks.map((task) => task.id), ["task-turn", "task-compact"]);
  assert.equal(all.tasks[0].status, "running");

  const scoped = await kernel.getTasks({ kind: "cli", cwd: join(root, "notes") });
  assert.equal(scoped.connectedFolderId, rootId);
  assert.deepEqual(scoped.tasks.map((task) => task.id), ["task-turn"]);

  const unmatched = await kernel.getTasks({ kind: "cli", cwd: join(process.cwd(), "outside-all-connected-folders") });
  assert.deepEqual(unmatched.tasks, [], "an unmatched scoped actor must not fall back to all tasks");
  assert.equal(kernel.finishTask(turn.id), true);
  assert.equal(kernel.finishTask(turn.id), false);
  assert.deepEqual((await kernel.getTasks({ kind: "cli", connectedFolderId: rootId })).tasks, []);
});

test("AmpleFileKernel tracks experimental Check runs internally without changing amplefile.tasks v1", async () => {
  const root = join(process.cwd(), "kernel-check-tasks", "root");
  const connectedFolderSummary = connectedFolder("space-5555555555555555", "Root", root);
  const kernel = new AmpleFileKernel({
    ...connectedFolderDependencies([connectedFolderSummary]),
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    createTaskId: () => "task-generated",
  });
  const actor = { kind: "system" as const, connectedFolderId: connectedFolderSummary.id };
  const before = JSON.stringify(await kernel.getTasks(actor));

  const task = kernel.startExperimentalCheckRunTask({
    id: "task-check-run",
    connectedFolderId: connectedFolderSummary.id,
    actor,
  });
  assert.deepEqual(task, {
    id: "task-check-run",
    kind: "check_run",
    status: "running",
    connectedFolderId: connectedFolderSummary.id,
    actor,
    startedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(
    JSON.stringify(await kernel.getTasks(actor)),
    before,
    "an internal check_run must be byte-invisible to the stable amplefile.tasks v1 snapshot",
  );
  assert.throws(
    () => kernel.startTask({
      id: task.id,
      kind: "assistant_turn",
      connectedFolderId: connectedFolderSummary.id,
      actor: { kind: "assistant", connectedFolderId: connectedFolderSummary.id },
    }),
    /already running/,
    "experimental and stable tasks must share lifecycle id ownership",
  );
  assert.equal(kernel.finishTask(task.id), true);
  assert.equal(kernel.finishTask(task.id), false);
  assert.equal(JSON.stringify(await kernel.getTasks(actor)), before);
});

test("AmpleFileKernel capability queries expose the shared stable catalog snapshot", async () => {
  const root = join(process.cwd(), "kernel-capabilities", "root");
  const connectedFolderSummary = connectedFolder("space-6666666666666666", "Capabilities", root);
  const packageSource = "npm:@demo/research@1.2.3";
  const catalog: PiResourceCatalog = {
    projectTrust: { required: true, trusted: true, savedDecision: true },
    packages: [],
    toolManagement: {
      mode: "session-only",
      persisted: false,
      mutable: false,
      scope: "chat",
      reason: "Tools belong to the Chat.",
    },
    tools: [{
      name: "read",
      label: "read",
      description: "Read a file",
      active: true,
      kind: "core",
      core: true,
      configurable: false,
      configurationScope: "chat",
      source: { path: "builtin:read", source: "builtin", scope: "user", origin: "top-level" },
    }],
    skills: [{
      name: "research",
      description: "Research carefully",
      path: join(root, ".pi", "npm", "research", "SKILL.md"),
      baseDir: root,
      disableModelInvocation: false,
      content: "# Research",
      source: { path: "skills/research/SKILL.md", source: packageSource, scope: "project", origin: "package", baseDir: root },
    }],
    extensions: [],
    surfaces: [{
      id: "research-pulse",
      title: "Research pulse",
      description: "Connected research status",
      icon: "pulse",
      extensionPath: join(root, ".pi", "npm", "research", "index.ts"),
      manifestPath: join(root, ".pi", "npm", "research", "surface.json"),
      source: { path: "index.ts", source: packageSource, scope: "project", origin: "package", baseDir: root },
      views: [{
        id: "overview",
        title: "Overview",
        blocks: [{ type: "metrics", items: [{ label: "Sources", value: "12" }] }],
      }],
    }],
    prompts: [],
    themes: [],
    contextFiles: [],
    commands: [{ name: "trust", description: "Show Connected Folder trust status", source: "builtin" }],
    diagnostics: [{ type: "collision", message: "A lower-precedence Skill was hidden." }],
  };
  const kernel = new AmpleFileKernel({
    ...connectedFolderDependencies([connectedFolderSummary]),
    async loadCapabilityCatalog() { return catalog; },
    async listPackages() {
      return [{ source: packageSource, scope: "project", filtered: false, installedPath: join(root, ".pi", "npm", "research") }];
    },
    async isProjectMutationTrusted() { return true; },
  });

  const result = await kernel.getCapabilities({ kind: "cli", connectedFolderId: connectedFolderSummary.id });
  assert.equal(result.kind, "amplefile.capabilities");
  assert.equal(result.version, 1);
  assert.equal(result.connectedFolder.id, connectedFolderSummary.id);
  assert.deepEqual(result.catalog.projectTrust, { required: true, trusted: true, savedDecision: true, mutationTrusted: true });
  assert.equal(result.catalog.packages[0].loaded, true);
  assert.equal(result.catalog.skills[0].scope, "project");
  assert.equal(result.catalog.skills[0].packageSource, packageSource);
  assert.equal(result.catalog.skills[0].sourceInfo.label, `This Connected Folder only · ${packageSource}`);
  assert.equal(result.catalog.surfaces[0].scope, "project");
  assert.equal(result.catalog.surfaces[0].views[0].blocks[0].type, "metrics");
  assert.equal(result.catalog.tools[0].scope, "global");
  assert.deepEqual(result.catalog.diagnostics, [{ type: "warning", message: "A lower-precedence Skill was hidden." }]);

  await assert.rejects(
    kernel.getCapabilities({ kind: "cli", cwd: join(process.cwd(), "not-a-connected-folder") }),
    (error: unknown) => error instanceof AmpleFileContextRequiredError && error.code === "AMPLEFILE_CONTEXT_REQUIRED",
  );
});

test("AmpleFileKernel getGlance composes the actor-independent experimental digest", async () => {
  const root = join(process.cwd(), "kernel-overview", "root");
  const connectedFolderSummary = connectedFolder("space-7777777777777777", "Glance", root);
  const taskClock = [new Date("2026-08-10T11:00:00.000Z"), new Date("2026-08-10T11:05:00.000Z")];
  const kernel = new AmpleFileKernel({
    ...connectedFolderDependencies([connectedFolderSummary]),
    now: () => taskClock.shift() ?? new Date("2026-08-10T12:00:00.000Z"),
    overviewSources: {
      // The kernel is the running-task registry: an injected reader for that
      // row must not displace it.
      runningTasks: async () => [{
        id: "task-imposter",
        kind: "assistant_turn",
        connectedFolderId: connectedFolderSummary.id,
        startedAt: "2026-08-10T11:59:00.000Z",
      }],
      settledTurns: async () => [{
        taskId: "task-old",
        connectedFolderId: connectedFolderSummary.id,
        conversationId: "chat-old",
        outcome: "succeeded",
        endedAt: "2026-08-10T09:00:00.000Z",
      }],
      checkpoints: async (connectedFolderRef) => connectedFolderRef.id === connectedFolderSummary.id
        ? [{
          checkpointId: "cp-1",
          createdAt: "2026-08-10T10:00:00.000Z",
          label: "Before cleanup",
          reason: "manual",
          scope: "full" as const,
        }]
        : [],
    },
    readOverviewSeen: async () => ({ popover: "2026-08-10T09:30:00.000Z/settled-turns:task-old" }),
  });
  kernel.startTask({
    id: "task-turn",
    kind: "assistant_turn",
    connectedFolderId: connectedFolderSummary.id,
    conversationId: "chat-live",
    actor: { kind: "assistant", connectedFolderId: connectedFolderSummary.id, conversationId: "chat-live" },
  });
  kernel.startExperimentalCheckRunTask({
    id: "task-check",
    connectedFolderId: connectedFolderSummary.id,
    actor: { kind: "system", connectedFolderId: connectedFolderSummary.id },
  });
  const tasksBefore = JSON.stringify(await kernel.getTasks({ kind: "system" }));

  const overview = await kernel.getOverview({ kind: "cli", connectedFolderId: `  ${connectedFolderSummary.id}  `, cwd: "  .  " });
  assert.equal(overview.kind, "amplefile.overview.experimental");
  assert.equal(overview.version, 0);
  assert.equal(overview.composedAt, "2026-08-10T12:00:00.000Z");
  assert.deepEqual(
    overview.running.map((item) => [item.id, item.kind]),
    [["kernel-tasks:task-turn", "assistant-turn"], ["kernel-tasks:task-check", "check-run"]],
    "the kernel's own registry feeds Running now, including the experimental check_run kind",
  );
  assert.equal(overview.running[0].connectedFolderName, "Glance");
  assert.deepEqual(overview.changes.map((item) => item.id), [
    "history-checkpoints:space-7777777777777777:cp-1",
    "settled-turns:task-old",
  ]);
  assert.equal(overview.cursor, "2026-08-10T10:00:00.000Z/history-checkpoints:space-7777777777777777:cp-1");
  assert.deepEqual(overview.seen, { popover: "2026-08-10T09:30:00.000Z/settled-turns:task-old" });
  assert.deepEqual(overview.unavailable, []);

  const unscoped = await kernel.getOverview({ kind: "renderer" });
  assert.equal(
    JSON.stringify(unscoped),
    JSON.stringify(overview),
    "the digest is management-scoped: a normalized Connected Folder–scoped actor must not change one byte",
  );

  assert.equal(
    JSON.stringify(await kernel.getTasks({ kind: "system" })),
    tasksBefore,
    "composing the experimental overview must be byte-invisible to stable amplefile.tasks v1",
  );

  kernel.finishTask("task-turn");
  kernel.finishTask("task-check");
  const settled = await kernel.getOverview({ kind: "system" });
  assert.deepEqual(settled.running, [], "finished tasks leave Running now");
});

test("AmpleFileKernel tracks experimental automation runs internally, outside v1 tasks and the overview's running section", async () => {
  const root = join(process.cwd(), "kernel-automation-tasks", "root");
  const connectedFolderSummary = connectedFolder("space-9999999999999999", "automation", root);
  const kernel = new AmpleFileKernel({
    ...connectedFolderDependencies([connectedFolderSummary]),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    createTaskId: () => "task-generated-automation",
  });
  const before = JSON.stringify(await kernel.getTasks({ kind: "system" }));

  const task = kernel.startExperimentalAutomationRunTask({
    automationId: "automation-digest",
    runId: "run-1",
    actor: { kind: "system" },
  });
  assert.deepEqual(task, {
    id: "task-generated-automation",
    kind: "automation_run",
    status: "running",
    automationId: "automation-digest",
    runId: "run-1",
    actor: { kind: "system" },
    startedAt: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(
    JSON.stringify(await kernel.getTasks({ kind: "system" })),
    before,
    "an internal routing_run must be byte-invisible to the stable amplefile.tasks v1 snapshot",
  );
  const overview = await kernel.getOverview({ kind: "system" });
  assert.deepEqual(
    overview.running,
    [],
    "automation runs reach the overview through their receipts source, never as a kernel task item",
  );
  assert.throws(
    () => kernel.startExperimentalAutomationRunTask({ id: task.id, automationId: "other", runId: "run-2", actor: { kind: "system" } }),
    /already running/,
    "experimental and stable tasks must share lifecycle id ownership",
  );
  assert.throws(
    () => kernel.startExperimentalAutomationRunTask({ id: "task-blank-automation", automationId: "  ", runId: "run-3", actor: { kind: "system" } }),
    /automation id is required/,
  );
  assert.equal(kernel.finishTask(task.id), true);
  assert.equal(kernel.finishTask(task.id), false);
  assert.equal(JSON.stringify(await kernel.getTasks({ kind: "system" })), before);
});

test("AmpleFileKernel configureGlance attaches live readers post-construction without touching the task registry source", async () => {
  const root = join(process.cwd(), "kernel-overview-configure", "root");
  const connectedFolderSummary = connectedFolder("space-aaaaaaaaaaaaaaaa", "Late wiring", root);
  const kernel = new AmpleFileKernel({
    ...connectedFolderDependencies([connectedFolderSummary]),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  const bare = await kernel.getOverview({ kind: "system" });
  assert.deepEqual(bare.changes, [], "before wiring, injected kinds are absent");
  assert.deepEqual(bare.seen, {});

  kernel.configureOverview({
    sources: {
      settledTurns: async () => [{
        taskId: "task-late",
        connectedFolderId: connectedFolderSummary.id,
        conversationId: "chat-late",
        outcome: "succeeded" as const,
        endedAt: "2026-08-10T11:00:00.000Z",
      }],
      // The kernel's own registry must still win the running-tasks row.
      runningTasks: async () => [{
        id: "task-imposter",
        kind: "assistant_turn" as const,
        connectedFolderId: connectedFolderSummary.id,
        startedAt: "2026-08-10T11:59:00.000Z",
      }],
    },
    readSeen: async () => ({ popover: "2026-08-10T10:00:00.000Z/settled-turns:task-late" }),
  });
  const wired = await kernel.getOverview({ kind: "system" });
  assert.deepEqual(wired.changes.map((item) => item.id), ["settled-turns:task-late"]);
  assert.deepEqual(wired.seen, { popover: "2026-08-10T10:00:00.000Z/settled-turns:task-late" });
  assert.deepEqual(wired.running, [], "an injected running-tasks reader never displaces the kernel registry");
});

test("AmpleFileKernel getGlance treats a failed seen read as no markers", async () => {
  const root = join(process.cwd(), "kernel-overview-seen", "root");
  const connectedFolderSummary = connectedFolder("space-8888888888888888", "Seenless", root);
  const kernel = new AmpleFileKernel({
    ...connectedFolderDependencies([connectedFolderSummary]),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    readOverviewSeen: async () => { throw new Error("marker store unreadable"); },
  });
  const overview = await kernel.getOverview({ kind: "renderer" });
  assert.deepEqual(overview.seen, {}, "losing markers only over-reports newness");
  assert.deepEqual(overview.unavailable, [], "the seen table is preference, not a digest source");
});

test("the experimental History-restore fence judges automation runs from the task registry and fails closed", async () => {
  const targetId = "space-9999999999999999";
  const otherId = "space-aaaaaaaaaaaaaaaa";
  const root = join(process.cwd(), "kernel-restore-fence", "root");
  const kernel = new AmpleFileKernel(connectedFolderDependencies([connectedFolder(targetId, "Target", root)]));
  const blockers = () => kernel.listExperimentalHistoryRestoreBlockers(targetId);

  // A quiet registry restores freely; a blank Connected Folder id is a caller bug.
  assert.deepEqual(await blockers(), []);
  await assert.rejects(() => kernel.listExperimentalHistoryRestoreBlockers("  "), /Connected Folder id/);

  // An active automation run with no configured reader fails closed: the
  // registry proves work is running, so unverifiable hops must not race a
  // restore.
  const run = kernel.startExperimentalAutomationRunTask({
    automationId: "automation-glue",
    runId: "run-1",
    actor: { kind: "system" },
  });
  let judged = await blockers();
  assert.equal(judged.length, 1);
  assert.match(judged[0]!, /automation run run-1 \(automation automation-glue\)/);
  assert.match(judged[0]!, /cannot be verified in this build/);

  // A reader that resolves the declared files-hop targets narrows the rule:
  // hops into other Connected Folders never block, a hop into this Connected Folder blocks.
  kernel.configureHistoryRestoreFence({ sources: { automationRunFilesHopTargets: async () => [otherId] } });
  assert.deepEqual(await blockers(), []);
  kernel.configureHistoryRestoreFence({ sources: { automationRunFilesHopTargets: async () => [otherId, targetId] } });
  judged = await blockers();
  assert.equal(judged.length, 1);
  assert.match(judged[0]!, /declares a files hop into this Connected Folder/);

  // An unknown automation and a failing reader both fail closed.
  kernel.configureHistoryRestoreFence({ sources: { automationRunFilesHopTargets: async () => null } });
  assert.match((await blockers())[0]!, /files-hop targets could not be verified/);
  kernel.configureHistoryRestoreFence({
    sources: { automationRunFilesHopTargets: async () => { throw new Error("store damaged"); } },
  });
  assert.match((await blockers())[0]!, /files-hop targets could not be verified/);

  // A settled run clears its half of the fence, and no ghost blocker survives.
  kernel.finishTask(run.id);
  assert.deepEqual(await blockers(), []);

  // The automation reader blocks on runs whose app holds a file grant into
  // this Connected Folder, and a configured reader that fails blocks too (fail closed).
  kernel.configureHistoryRestoreFence({
    sources: {
      appAutomationRunsWithFileGrantInto: async (connectedFolderId) => connectedFolderId === targetId
        ? [{ appId: "connected-inbox", appAutomationId: "daily-sync", runId: "run-9" }]
        : [],
    },
  });
  judged = await blockers();
  assert.equal(judged.length, 1);
  assert.match(judged[0]!, /app automation daily-sync of connected-inbox \(run run-9\)/);
  assert.match(judged[0]!, /file grant into this Connected Folder/);
  kernel.configureHistoryRestoreFence({
    sources: { appAutomationRunsWithFileGrantInto: async () => { throw new Error("no machine-wide accessor"); } },
  });
  assert.match((await blockers())[0]!, /could not be verified/);

  // Agent-turn and compaction fencing stays with the act facade's live
  // route state; those task kinds alone never trip the kernel fence.
  kernel.configureHistoryRestoreFence({ sources: {} });
  kernel.startTask({
    kind: "assistant_turn",
    connectedFolderId: targetId,
    conversationId: "chat-one",
    actor: { kind: "assistant", connectedFolderId: targetId, conversationId: "chat-one", cwd: root },
  });
  assert.deepEqual(await blockers(), []);
});

function kernelForConnectedFolders(connectedFolders: ConnectedFolderSummary[]): AmpleFileKernel {
  return new AmpleFileKernel(connectedFolderDependencies(connectedFolders));
}

function connectedFolderDependencies(connectedFolders: ConnectedFolderSummary[]) {
  return {
    async listConnectedFolders() { return connectedFolders; },
    async getConnectedFolder(connectedFolderId: string) {
      const connectedFolderSummary = connectedFolders.find((item) => item.id === connectedFolderId);
      if (!connectedFolderSummary) throw new Error(`Unknown Connected Folder: ${connectedFolderId}`);
      return connectedFolderSummary;
    },
  };
}

function connectedFolder(
  id: string,
  name: string,
  connectedFolderRoot: string,
  updatedAt = "2026-01-01T00:00:00.000Z",
): ConnectedFolderSummary {
  return {
    id,
    name,
    connectedFolderRoot,
    location: { kind: "local", storage: "linked" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}
