import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";
import { buildConnectedFolderTurnContext } from "../src/local/agent/connected-folder-turn-context.js";
import { startLocalApi } from "../src/local/server.js";

test("an Automation's turn is told nobody is watching and how to report; a person's turn is not", () => {
  const connectedFolderTurn = buildConnectedFolderTurnContext({ connectedFolderId: "connected-folder-1", taskId: "task-1", requestId: "req-1", handleSalt: "salt" });
  const worker = buildTurnContextMessage({ connectedFolderTurn, automation: { title: "Sort screenshots" } });
  assert.match(worker, /The Automation "Sort screenshots" sent the message in this turn\. Nobody is watching while it runs/);
  assert.match(worker, /do the work yourself with your tools instead of asking for help/);
  assert.match(worker, /read tool shows you images/);
  assert.match(worker, /report with chat report: --summary saying what you did, --file for each file you made or changed, and --outcome succeeded, partial, or failed/);
  assert.match(worker, /If you cannot do the work, report failed and say why/);

  const agent = buildTurnContextMessage({ ampleFileAgentTaskId: "agent-task-1", automation: { title: "Weekly digest" } });
  assert.match(agent, /The Automation "Weekly digest" sent the message in this turn/);
  assert.match(agent, /Your final reply is this step's record in the Automation's run history/);
  assert.doesNotMatch(agent, /chat report/, "the AmpleFile agent has no report verb; its final reply is the record");

  assert.doesNotMatch(buildTurnContextMessage({ connectedFolderTurn }), /Nobody is watching/, "a person's own turn is unchanged");
});

test("an Automation's chat step names itself to its turn, and the Worker's report sets the step's outcome", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-automation-step-report-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  // A Pi extension command answers the turn without a model call.
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "sort.ts"), `export default function (pi) {
    pi.registerCommand("sort", { description: "Stand in for the Worker", handler: async () => {} });
  }\n`, "utf8");
  const prompts: Array<{ taskId: string; connectedFolderId: string; automation?: { title: string } }> = [];
  let report: { outcome: "succeeded" | "partial" | "failed"; summary: string } | null = null;
  let api: Awaited<ReturnType<typeof startLocalApi>>;
  api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    async beforeAgentPrompt(event) {
      prompts.push(event);
      // What a Worker does with `amplefile chat report` while its turn runs.
      if (report) await api.actFacade.chatReport({ connectedFolder: event.connectedFolderId, taskId: event.taskId, summary: report.summary, outcome: report.outcome, files: [] });
    },
  });
  try {
    const { connectedFolder } = await api.actFacade.createConnectedFolder({ name: "Screenshot inbox" });
    const proposalPath = join(sandbox, "sort.amplefile-automation.json");
    await writeFile(proposalPath, JSON.stringify({
      kind: "amplefile.automation-proposal",
      version: 2,
      name: "Sort screenshots",
      createdBy: "assistant",
      createdAt: new Date().toISOString(),
      automation: {
        title: "Sort screenshots",
        trigger: { kind: "at", at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), ifMissed: "run" },
        steps: [{ id: "sort", kind: "chat", connectedFolder: connectedFolder.id, message: "/sort" }],
      },
    }), "utf8");
    const { automationId } = await api.actFacade.automationsEnable({ proposalPath, cwd: sandbox, requestId: "req-enable" });
    const hops = async () => ((await api.actFacade.automationsReceipts({ automation: automationId })).receipts as Array<Record<string, unknown>>)
      .filter((receipt) => receipt.scope === "hop" && receipt.outcome !== "accepted");
    const runs = async () => ((await api.actFacade.automationsReceipts({ automation: automationId })).receipts as Array<Record<string, unknown>>)
      .filter((receipt) => receipt.scope === "run" && receipt.outcome !== "accepted");

    report = { outcome: "partial", summary: "Sorted two of three screenshots; one would not open." };
    assert.equal((await api.automations.runNow(automationId, { requestId: "req-run-1" })).outcome, "success");
    assert.equal(prompts.at(-1)?.automation?.title, "Sort screenshots", "the turn knows which Automation sent it");
    assert.equal(prompts.at(-1)?.connectedFolderId, connectedFolder.id);
    let hop = (await hops()).at(-1)!;
    assert.equal(hop.outcome, "succeeded");
    assert.equal(hop.partial, true);
    assert.equal(hop.detail, "Sorted two of three screenshots; one would not open.");
    assert.equal((await runs()).at(-1)!.partial, true);
    const history = await api.automationSettings.history(automationId);
    assert.equal(history.runs[0]?.partial, true, "Settings shows the run as partly done");
    assert.equal(history.runs[0]?.hops[0]?.partial, true);
    assert.equal(history.runs[0]?.hops[0]?.detail, "Sorted two of three screenshots; one would not open.");
    assert.equal((await api.automationSettings.show(automationId)).automation.lastRun?.partial, true, "and its last run");

    report = { outcome: "failed", summary: "The Screenshots folder was empty." };
    assert.equal((await api.automations.runNow(automationId, { requestId: "req-run-2" })).outcome, "failure");
    hop = (await hops()).at(-1)!;
    assert.equal(hop.outcome, "failed");
    assert.equal(hop.detail, "The Screenshots folder was empty.");

    report = null;
    assert.equal((await api.automations.runNow(automationId, { requestId: "req-run-3" })).outcome, "success", "a reply without a report keeps the turn's own outcome");
    hop = (await hops()).at(-1)!;
    assert.equal(hop.outcome, "succeeded");
    assert.equal(hop.partial, undefined);
  } finally {
    await api.close();
  }
});
