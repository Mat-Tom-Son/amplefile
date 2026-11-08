import assert from "node:assert/strict";
import test from "node:test";

import {
  PREPARED_ACT_KINDS,
  PreparedActError,
  PreparedActExecutor,
  prepareAct,
  type PreparedActFenceScope,
  type PreparedActKernelSeam,
} from "../src/local/prepared-acts.js";
import { AmpleFileKernel } from "../src/local/amplefile-kernel.js";

const deletion = () => prepareAct({
  kind: "connected-folder.delete-folder",
  parameters: { connectedFolderId: "connected-folder-1" },
  pins: { connectedFolderId: "connected-folder-1", connectedFolderRoot: "/connected-folders/one" },
});

test("prepareFoldAct refuses unknown kinds, unknown or malformed fields, and mismatched identities", () => {
  // The closed vocabulary: the six kinds behind every verb that installs
  // code, widens a power, or destroys data. There is no permanent file
  // deletion, desktop-served exposure, online page publishing, or Connected
  // Folder app act.
  assert.deepEqual([...PREPARED_ACT_KINDS].sort(), [
    "automation.enable",
    "capability.package.install",
    "capability.package.update",
    "capability.resource.enabled",
    "capability.skills.import",
    "connected-folder.delete-folder",
  ]);
  assert.equal((PREPARED_ACT_KINDS as readonly string[]).includes("files.destroy"), false);
  assert.equal((PREPARED_ACT_KINDS as readonly string[]).includes("publish.viewer.expose"), false);
  assert.equal((PREPARED_ACT_KINDS as readonly string[]).includes("page.publish"), false);
  assert.equal(PREPARED_ACT_KINDS.some((kind) => kind.startsWith("app.")), false);

  const refused = (input: Parameters<typeof prepareAct>[0], code: string, message: RegExp) =>
    assert.throws(
      () => prepareAct(input),
      (error: unknown) => error instanceof PreparedActError && error.code === code && message.test(error.message),
      `expected ${code} for ${JSON.stringify(input)}`,
    );
  refused({ kind: "files.destroy" as never, parameters: {}, pins: {} }, "KIND_UNKNOWN", /fail closed/);
  refused({ kind: "app.storage.clear" as never, parameters: {}, pins: {} }, "KIND_UNKNOWN", /fail closed/);
  refused(
    { kind: "connected-folder.delete-folder", parameters: { connectedFolderId: "connected-folder-1", extra: "x" }, pins: { connectedFolderId: "connected-folder-1", connectedFolderRoot: "/r" } },
    "INPUT_INVALID",
    /parameters\.extra is not a typed field/,
  );
  refused(
    { kind: "connected-folder.delete-folder", parameters: { connectedFolderId: "connected-folder-1" }, pins: { connectedFolderId: "connected-folder-1" } },
    "INPUT_INVALID",
    /pins\.connectedFolderRoot is required/,
  );
  refused(
    { kind: "connected-folder.delete-folder", parameters: { connectedFolderId: "connected-folder-1" }, pins: { connectedFolderId: "connected-folder-2", connectedFolderRoot: "/r" } },
    "INPUT_INVALID",
    /must name the same identity/,
  );
  refused(
    {
      kind: "capability.skills.import",
      parameters: { source: "/skills/pack", scope: "connected-folder", connectedFolderId: "connected-folder-1" },
      pins: { source: "/skills/pack", contentDigest: "d".repeat(64), skillNames: [] },
    },
    "INPUT_INVALID",
    /pins\.skillNames must list 1-256 entries/,
  );
  refused(
    { kind: "capability.package.install", parameters: { scope: "connected-folder" }, pins: { packageId: "p", version: "1", source: "npm:p", scope: "connected-folder", resourceSummary: "r" } },
    "INPUT_INVALID",
    /exactly one of source or catalogId/,
  );

  const act = deletion();
  assert.ok(Object.isFrozen(act) && Object.isFrozen(act.parameters) && Object.isFrozen(act.pins), "a prepared act is inert data");
  assert.deepEqual(act.pins, { connectedFolderId: "connected-folder-1", connectedFolderRoot: "/connected-folders/one" });
});

test("the executor fences, rechecks pins, wraps execution in one fold_act task, and refuses unbound kinds", async () => {
  const started: Array<{ requestId: string; kind: string; connectedFolderId?: string }> = [];
  const finished: string[] = [];
  const kernel: PreparedActKernelSeam = {
    startExperimentalPreparedActTask(input) {
      started.push({ requestId: input.requestId, kind: input.kind, ...(input.connectedFolderId ? { connectedFolderId: input.connectedFolderId } : {}) });
      const id = `task-${started.length}`;
      return {
        id, kind: "prepared_act", status: "running", connectedFolderId: input.connectedFolderId ?? null,
        requestId: input.requestId, actKind: input.kind, actor: input.actor, startedAt: "2026-09-10T00:00:00.000Z",
      };
    },
    finishTask(taskId) {
      finished.push(taskId);
      return true;
    },
  };
  const scopes: PreparedActFenceScope[] = [];
  const executor = new PreparedActExecutor({
    kernel,
    fence: {
      async run(scope, operation) {
        scopes.push(scope);
        return await operation();
      },
    },
    adapters: {
      "connected-folder.delete-folder": {
        fenceScope: () => null,
        recheckPins: () => null,
        execute: async () => ({ detail: "deleted" }),
      },
      "capability.skills.import": {
        recheckPins: (_act, context) => (context as { mismatch?: string } | undefined)?.mismatch ?? null,
        execute: async (_act, context) => {
          (context as { ran?: boolean }).ran = true;
          return { detail: "imported" };
        },
      },
      "capability.package.install": {
        recheckPins: () => null,
        execute: async () => {
          throw new Error("boom");
        },
      },
    },
  });

  // A Connected Folder–scoped act reserves the Connected Folder fence by default, rechecks its
  // pins inside it, and runs inside one fold_act task that is finished on
  // the way out; the effect names the task.
  const skillsImport = prepareAct({
    kind: "capability.skills.import",
    parameters: { source: "/skills/pack", scope: "connected-folder", connectedFolderId: "connected-folder-1" },
    pins: { source: "/skills/pack", contentDigest: "d".repeat(64), skillNames: ["tidy-notes"] },
  });
  const context: { ran?: boolean } = {};
  const effect = await executor.run({ act: skillsImport, requestId: "req-1", context });
  assert.equal(effect.detail, "imported");
  assert.equal(effect.taskId, "task-1");
  assert.equal(context.ran, true);
  assert.deepEqual(scopes, [{ scope: "connected-folder", connectedFolderId: "connected-folder-1" }]);
  assert.deepEqual(started, [{ requestId: "req-1", kind: "capability.skills.import", connectedFolderId: "connected-folder-1" }]);
  assert.deepEqual(finished, ["task-1"]);

  // A pin mismatch refuses before execute and starts no task.
  const mismatch: { mismatch: string; ran?: boolean } = { mismatch: "the skill pack changed" };
  await assert.rejects(
    () => executor.run({ act: skillsImport, requestId: "req-2", context: mismatch }),
    (error: unknown) => error instanceof PreparedActError && error.code === "PIN_MISMATCH" && /skill pack changed/.test(error.message),
  );
  assert.equal(mismatch.ran, undefined);
  assert.equal(started.length, 1);
  assert.equal(scopes.length, 2, "the recheck happens inside the reserved fence");

  // A null fence scope means the execution reserves its own fence.
  await executor.run({ act: deletion(), requestId: "req-3" });
  assert.equal(scopes.length, 2);
  assert.deepEqual(started.at(-1), { requestId: "req-3", kind: "connected-folder.delete-folder", connectedFolderId: "connected-folder-1" });

  // A connected-folder-less act reserves the global fence, and a throwing execution
  // still finishes its task.
  const install = prepareAct({
    kind: "capability.package.install",
    parameters: { source: "npm:x", scope: "everywhere" },
    pins: { packageId: "x", version: "1.0.0", source: "npm:x", scope: "everywhere", resourceSummary: "1 skill(s)" },
  });
  await assert.rejects(() => executor.run({ act: install, requestId: "req-4" }), /boom/);
  assert.deepEqual(scopes.at(-1), { scope: "global" });
  assert.equal(finished.length, started.length, "every started task is finished, including after a throw");

  // An unbound kind refuses before anything runs.
  const enable = prepareAct({
    kind: "automation.enable",
    parameters: { automationId: "automation-weekly-handoff" },
    pins: { automationId: "automation-weekly-handoff", declarationDigest: "d".repeat(64) },
  });
  await assert.rejects(
    () => executor.run({ act: enable, requestId: "req-5" }),
    (error: unknown) => error instanceof PreparedActError && error.code === "EXECUTION_UNAVAILABLE",
  );
  assert.equal(started.length, 3);
  await assert.rejects(
    () => executor.run({ act: deletion(), requestId: "  " }),
    (error: unknown) => error instanceof PreparedActError && error.code === "INPUT_INVALID",
  );

  // The real kernel validates the task input and keeps the lifecycle
  // internal: a fold_act task never enters the stable connected-folder.tasks projection.
  const real = new AmpleFileKernel();
  assert.throws(() => real.startExperimentalPreparedActTask({ requestId: " ", kind: "connected-folder.delete-folder", actor: { kind: "system" } }), /request id/);
  assert.throws(() => real.startExperimentalPreparedActTask({ requestId: "req", kind: " ", actor: { kind: "system" } }), /kind/);
  const task = real.startExperimentalPreparedActTask({ requestId: "req-real", kind: "connected-folder.delete-folder", actor: { kind: "system" } });
  assert.equal(task.kind, "prepared_act");
  assert.equal(task.requestId, "req-real");
  assert.equal(task.actKind, "connected-folder.delete-folder");
  assert.deepEqual((await real.getTasks({ kind: "system" })).tasks, []);
  assert.equal(real.finishTask(task.id), true);
});
