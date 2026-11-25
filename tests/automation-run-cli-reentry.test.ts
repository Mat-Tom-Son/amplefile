import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AmpleFileDesktopCliHost } from "../desktop/src/amplefile-cli-host.js";
import { AmpleFileCliKernelAdapter } from "../src/local/amplefile-cli-adapter.js";
import { ampleFileAutomationContractVersion } from "../src/local/automations/automation-declarations.js";
import { AmpleFileCliExitCode, createAmpleFileCliActRequest } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";

const exists = (path: string) => access(path).then(() => true, () => false);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves false after `ms` unless `work` finishes first, and leaves no timer behind. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The rule this guards is general: no `amplefile` command may hold the CLI
 * host while it waits on agent work, because that work uses the same
 * command. Here a run started from the CLI has a step whose turn renames a
 * file with `amplefile files rename` through the same host, as a Worker
 * would. The rename must finish while the run is still going.
 */
test("a run started from the CLI never holds up its own steps' amplefile commands", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-run-cli-reentry-"));
  // A Pi extension command ends the step's turn without a model call.
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "tidy.ts"), `export default function (pi) {
    pi.registerCommand("tidy", { description: "Stand in for the Worker", handler: async () => {} });
  }\n`, "utf8");

  const token = "c".repeat(64);
  let host: AmpleFileDesktopCliHost | null = null;
  const cli = async (argv: string[], withinMs = 20_000) => {
    const request = createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token });
    await host!.broker.writeActRequest(request);
    if (!await within(host!.processRequest(request.id), withinMs)) return null;
    return host!.broker.readResponse(request.id);
  };

  let stepRename: Awaited<ReturnType<typeof cli>> | undefined;
  let runSettledBeforeRename = false;
  let followedRun: { automationId: string; runId: string } | null = null;
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    async beforeAgentPrompt(event) {
      if (!event.automation) return;
      // What a Worker does with `amplefile files rename` while its turn runs.
      stepRename = await cli([
        "files", "rename", "--connected-folder", event.connectedFolderId,
        "--path", "Screenshot 1.png", "--name", "Renamed.png", "--json",
      ]);
      if (followedRun) {
        runSettledBeforeRename = api.automations.runStatus(followedRun.automationId, followedRun.runId)?.state === "settled";
      }
    },
  });
  host = new AmpleFileDesktopCliHost({
    stateRoot: join(sandbox, "cli-state"),
    kernel: new AmpleFileCliKernelAdapter(api.kernel),
    version: "1.0.0",
    getActFacade: () => ({ facade: api.actFacade, token }),
  });
  await host.initialize();
  t.after(async () => {
    // A regression leaves the step's rename stuck behind the run; never let
    // cleanup wait on it forever.
    await within(host?.whenIdle() ?? Promise.resolve(), 5_000);
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Screenshot inbox" });
  await writeFile(join(connectedFolder.connectedFolderRoot, "Screenshot 1.png"), "not really a picture", "utf8");
  const proposalPath = join(sandbox, "tidy.amplefile-automation.json");
  await writeFile(proposalPath, JSON.stringify({
    kind: "amplefile.automation-proposal",
    version: ampleFileAutomationContractVersion,
    name: "Tidy screenshots",
    createdBy: "assistant",
    createdAt: new Date().toISOString(),
    automation: {
      title: "Tidy screenshots",
      trigger: { kind: "manual" },
      steps: [{ id: "tidy", kind: "chat", connectedFolder: connectedFolder.id, message: "/tidy" }],
    },
  }), "utf8");
  const { automationId } = await api.actFacade.automationsEnable({ proposalPath, cwd: sandbox, requestId: "req-enable" });

  // run answers as soon as the run is admitted; it never waits for the step.
  const started = await cli(["automations", "run", "--automation", automationId, "--json"]);
  assert.ok(started, "automations run must answer without waiting for the run it started");
  assert.equal(started.exitCode, 0, started.stderr);
  const run = (JSON.parse(started.stdout) as { data: { run: { runId: string; state: string } } }).data.run;
  assert.ok(["queued", "running"].includes(run.state), `a run just started is queued or running, not ${run.state}`);
  followedRun = { automationId, runId: run.runId };

  // What `automations wait` does in the shim: poll the quick status read.
  let status: { state: string; outcome?: string; error?: string } = run;
  const deadline = Date.now() + 60_000;
  while (status.state !== "settled") {
    assert.ok(Date.now() < deadline, "the run settles");
    await pause(50);
    const read = await cli(["automations", "status", "--automation", automationId, "--run", run.runId, "--json"]);
    assert.ok(read, "automations status answers while the run is going");
    assert.equal(read.exitCode, 0, read.stderr);
    status = (JSON.parse(read.stdout) as { data: { run: typeof status } }).data.run;
  }

  assert.ok(stepRename, "the step's own amplefile command must not wait behind the run that started it");
  assert.equal(stepRename.exitCode, 0, stepRename.stderr);
  assert.equal(runSettledBeforeRename, false, "the rename finished while the run was still going");
  assert.equal(status.outcome, "success", status.error);
  assert.equal(await exists(join(connectedFolder.connectedFolderRoot, "Renamed.png")), true);
  assert.equal(await exists(join(connectedFolder.connectedFolderRoot, "Screenshot 1.png")), false);

  // A run the app does not know is not found, never a run that waits forever.
  const unknown = await cli(["automations", "status", "--automation", automationId, "--run", "run-unknown", "--json"]);
  assert.equal(unknown?.exitCode, AmpleFileCliExitCode.notFound, unknown?.stderr);
  // Waiting is the shim's: the host refuses to hold a request open for it.
  const hostWait = await cli(["automations", "wait", "--automation", automationId, "--run", run.runId, "--json"]);
  assert.equal(hostWait?.exitCode, AmpleFileCliExitCode.usage);
  assert.match(hostWait?.stderr ?? "", /runs inside the AmpleFile shim/);
});
