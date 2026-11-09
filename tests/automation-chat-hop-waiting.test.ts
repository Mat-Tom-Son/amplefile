import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ampleFileAutomationDigest,
  normalizeAmpleFileAutomationDeclaration,
} from "../src/local/automations/automation-declarations.js";
import { startLocalApi } from "../src/local/server.js";

/**
 * A Chat hop whose Worker asks a question ends the Automation at that hop
 * (docs/automations.md). Asking does not end the asking turn
 * (docs/collaboration-contract.md), so the hop settles only when that turn
 * has finished, never while it is still working in the Connected Folder.
 */
test("a Chat hop that asks a question settles only after its Worker's turn has ended", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-automation-waiting-hop-"));
  const released = join(sandbox, "released");
  const finished = join(sandbox, "finished");
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `import { existsSync, writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("hold", {
    description: "Hold a test turn until released",
    handler: async () => {
      while (!existsSync(${JSON.stringify(released)})) await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(${JSON.stringify(finished)}, "");
    },
  });
}\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
  });
  t.after(async () => {
    await writeFile(released, "").catch(() => undefined);
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  const connectedFolder = (await api.actFacade.createConnectedFolder({ name: "Asks first" })).connectedFolder;
  const declaration = {
    kind: "amplefile.automation",
    version: 1,
    id: "automation-asks-first",
    title: "Asks first",
    createdBy: "human",
    createdAt: "2026-08-01T00:00:00.000Z",
    trigger: { kind: "manual" },
    steps: [{ id: "review", kind: "chat", connectedFolder: connectedFolder.id, message: "/hold" }],
  };
  await api.automations.enable({
    declaration,
    expectedDigest: ampleFileAutomationDigest(normalizeAmpleFileAutomationDeclaration(declaration)),
    grant: { requestId: "request-automation-asks-first", surface: "main-window" },
  });
  let settled = false;
  const run = api.automations.runNow(declaration.id, { requestId: "req-run-asks-first" }).finally(() => { settled = true; });

  // The hop's turn is running; its Worker asks the person a question.
  let taskId = "";
  await waitFor(async () => {
    const request = api.requests.list({ connectedFolderId: connectedFolder.id }).find((item) => item.turns.some((turn) => turn.state === "running"));
    taskId = request?.turns.at(-1)?.taskId ?? "";
    return Boolean(taskId);
  });
  await api.actFacade.chatAsk({ connectedFolder: connectedFolder.id, taskId, question: "Which files?", respondent: "person" });
  assert.equal(api.requests.byTaskId(taskId)?.state, "waiting");

  // The request is waiting, but its turn is still working: the hop holds.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false, "the hop does not return while its Worker's turn is still running");

  await writeFile(released, "");
  const result = await run;
  assert.ok(existsSync(finished), "the turn finished before the hop returned");
  assert.equal(result.outcome, "failure", "a question ends the Automation at that hop");
  const receipts = (await readFile(join(sandbox, "state", "automations", "receipts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const hop = receipts.find((entry) => entry.scope === "hop" && entry.hopId === "review" && entry.outcome !== "accepted");
  assert.ok(hop, "the hop is receipted");
  assert.match(JSON.stringify(hop), /needs an answer/);
  assert.deepEqual((await api.kernel.getTasks({ kind: "system" })).tasks, [], "no turn is left running behind the settled hop");
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
