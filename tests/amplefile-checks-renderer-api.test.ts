import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { createDesktopCheckService } from "../desktop/src/desktop-checks.js";
import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { AmpleFileSettleSignal } from "../src/local/automations/settle-signal.js";
import type { AmpleFileModelCheckRequest } from "../src/local/checks/model-review-sensor.js";
import { AmpleFileCheckService, type AmpleFileCheckTaskStatus } from "../src/local/checks/check-service.js";
import type {
  AmpleFileCheckRendererDecorations,
  AmpleFileCheckRendererOverview,
  AmpleFileCheckStatusSnapshot,
} from "../src/local/checks/check-types.js";
import { AmpleFileKernel } from "../src/local/amplefile-kernel.js";

const proposal = {
  kind: "amplefile.check-proposal",
  version: 1,
  name: "Required signed delivery",
  createdBy: "human",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "The signed delivery exists",
    severity: "error",
    trigger: "manual",
    sensor: { id: "amplefile.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Delivery/signed.pdf" }],
  },
} as const;

test("renderer Checks API stays explicit, Connected Folder–scoped, and task-backed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-checks-renderer-api-"));
  const kernel = new AmpleFileKernel();
  const checkService = new AmpleFileCheckService({ kernel });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    kernel,
    checkService,
  });
  try {
    const created = await request<{ connectedFolder: { id: string; connectedFolderRoot: string } }>(api.origin, "/api/connected-folders", {
      method: "POST",
      body: { name: "Checks UI Connected Folder" },
    }, 201);
    const connectedFolderId = created.connectedFolder.id;
    const proposalPath = join(sandbox, "signed-delivery.amplefile-check.json");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    await api.actFacade.checksEnable({ connectedFolder: connectedFolderId, proposalPath, cwd: sandbox });

    const releaseRegistryMutation = checkService.tryReserveConnectedFolderRegistryMutation();
    assert.ok(releaseRegistryMutation);
    const conflictedStatus = await fetch(`${api.origin}/api/connected-folders/${connectedFolderId}/checks/status`);
    assert.equal(conflictedStatus.status, 409, await conflictedStatus.text());
    releaseRegistryMutation();

    const awaitingRun = await request<{ status: AmpleFileCheckStatusSnapshot }>(
      api.origin,
      `/api/connected-folders/${connectedFolderId}/checks/status`,
    );
    assert.equal(awaitingRun.status.state, "stale");
    assert.equal(awaitingRun.status.neverRun, 1);
    assert.equal(awaitingRun.status.stale, 0);

    const beforeRun = await request<{ decorations: AmpleFileCheckRendererDecorations }>(
      api.origin,
      `/api/connected-folders/${connectedFolderId}/checks/decorations`,
    );
    assert.deepEqual(beforeRun.decorations.items, []);

    const invalidRun = await fetch(`${api.origin}/api/connected-folders/${connectedFolderId}/checks/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkId: 42 }),
    });
    assert.equal(invalidRun.status, 400);

    const accepted = await request<{ task: { taskId: string } }>(
      api.origin,
      `/api/connected-folders/${connectedFolderId}/checks/run`,
      { method: "POST", body: {} },
      202,
    );
    const terminal = await waitForTerminal(api.origin, connectedFolderId, accepted.task.taskId);
    assert.equal(terminal.state, "succeeded");
    const settledAbort = await request<{ aborted: boolean }>(
      api.origin,
      `/api/connected-folders/${connectedFolderId}/checks/tasks/${accepted.task.taskId}/abort`,
      { method: "POST", body: {} },
    );
    assert.equal(settledAbort.aborted, false);

    const decorations = await request<{ decorations: AmpleFileCheckRendererDecorations }>(
      api.origin,
      `/api/connected-folders/${connectedFolderId}/checks/decorations`,
    );
    assert.deepEqual(decorations.decorations.items, [{ path: "Delivery/signed.pdf", count: 1 }]);

    const overview = await request<{ overview: AmpleFileCheckRendererOverview }>(
      api.origin,
      `/api/connected-folders/${connectedFolderId}/checks/overview`,
      { method: "POST", body: {} },
    );
    assert.equal(overview.overview.status.state, "needs-attention");
    assert.equal(overview.overview.checks[0]?.authority, "enabled");
    assert.equal(overview.overview.findings[0]?.targetPath, "Delivery/signed.pdf");

    const findingId = overview.overview.findings[0]!.id;
    await request(api.origin, `/api/connected-folders/${connectedFolderId}/checks/findings/${findingId}/decision`, {
      method: "POST",
      body: { decision: "resolve" },
    });
    const resolved = await request<{ overview: AmpleFileCheckRendererOverview }>(
      api.origin,
      `/api/connected-folders/${connectedFolderId}/checks/overview`,
      { method: "POST", body: {} },
    );
    assert.equal(resolved.overview.findings.length, 0);
    assert.equal(resolved.overview.status.needsAttention, 0);

    await mkdir(join(created.connectedFolder.connectedFolderRoot, "Delivery"), { recursive: true });
    await writeFile(join(created.connectedFolder.connectedFolderRoot, "Delivery", "signed.pdf"), "%PDF current");
    const clearRun = await request<{ task: { taskId: string } }>(
      api.origin,
      `/api/connected-folders/${connectedFolderId}/checks/run`,
      { method: "POST", body: {} },
      202,
    );
    assert.equal((await waitForTerminal(api.origin, connectedFolderId, clearRun.task.taskId)).state, "succeeded");
    const staleDecision = await fetch(`${api.origin}/api/connected-folders/${connectedFolderId}/checks/findings/${findingId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    assert.equal(staleDecision.status, 409, await staleDecision.text());

    const invalidDecision = await fetch(`${api.origin}/api/connected-folders/${connectedFolderId}/checks/findings/${findingId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "silence-forever" }),
    });
    assert.equal(invalidDecision.status, 400);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function waitForTerminal(origin: string, connectedFolderId: string, taskId: string): Promise<AmpleFileCheckTaskStatus> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await request<{ task: AmpleFileCheckTaskStatus }>(
      origin,
      `/api/connected-folders/${connectedFolderId}/checks/tasks/${taskId}`,
    );
    if (response.task.state !== "accepted" && response.task.state !== "running") return response.task;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the renderer Check task.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function request<T = unknown>(
  origin: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text) as T;
}

test("desktop text Check setup is inert, re-enable pins review, and provider removal cannot interrupt a run", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-text-check-api-"));
  const kernel = new AmpleFileKernel();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  const service = new AmpleFileCheckService({ kernel, reviewModel: async () => { requests++; await hold; return { submission: { findings: [] } }; } });
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false, kernel, checkService: service });
  try {
    const { connectedFolder } = await request<{ connectedFolder: { id: string; connectedFolderRoot: string } }>(api.origin, "/api/connected-folders", { method: "POST", body: { name: "Text review" } }, 201);
    await writeFile(join(connectedFolder.connectedFolderRoot, "draft.md"), "An ordinary paragraph.");
    const configured = await request<{ declaration: { id: string }; digest: string }>(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/configure`, { method: "POST", body: { proposal: { ...proposal, check: { ...proposal.check, sensor: { id: "amplefile.text-review", revision: 1, parameters: { criteria: "Flag unclear prose." } }, targets: [{ kind: "file", role: "primary", path: "draft.md" }] } } } });
    assert.equal(requests, 0);
    await request(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/${configured.declaration.id}/disable`, { method: "POST", body: {} });
    const stale = await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}/checks/${configured.declaration.id}/enable`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedDigest: "0".repeat(64) }) });
    assert.equal(stale.status, 409);
    const enabled = await request<{ declaration: { id: string } }>(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/${configured.declaration.id}/enable`, { method: "POST", body: { expectedDigest: configured.digest } });
    assert.equal(enabled.declaration.id, configured.declaration.id);
    const accepted = await request<{ task: { taskId: string } }>(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/run`, { method: "POST", body: {} }, 202);
    const removal = await fetch(`${api.origin}/api/agent/auth`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectedFolderId: connectedFolder.id, provider: "test" }) });
    assert.equal(removal.status, 409, await removal.text());
    release();
    assert.equal((await waitForTerminal(api.origin, connectedFolder.id, accepted.task.taskId)).state, "succeeded");
    assert.equal(requests, 1);
  } finally { release(); await api.close(); await rm(sandbox, { recursive: true, force: true }); }
});

test("desktop-injected Checks reach the AmpleFile agent model through trial, live review and correction recheck", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-check-workflow-api-"));
  const kernel = new AmpleFileKernel();
  let calls = 0;
  t.mock.method(PiConversationClient.prototype, "reviewCheck", async (input: AmpleFileModelCheckRequest) => {
    calls++;
    assert.equal(input.criteria, "Avoid unqualified promises.");
    assert.equal(input.files.length, 1);
    assert.equal(input.files[0]!.path, "draft.md");
    return { submission: { findings: input.files[0]!.text.includes("Always") ? [{ path: "draft.md", quote: "Always guaranteed.", title: "Unqualified promise", detail: "Qualify the claim." }] : [] } };
  });
  const settleSignal = new AmpleFileSettleSignal();
  let api!: LocalApiHandle;
  const service = createDesktopCheckService({ kernel, settleSignal, getLocalApi: async () => api });
  api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false, kernel, checkService: service, settleSignal });
  try {
    const { connectedFolder } = await request<{ connectedFolder: { id: string; connectedFolderRoot: string } }>(api.origin, "/api/connected-folders", { method: "POST", body: { name: "Check workflow" } }, 201);
    await writeFile(join(connectedFolder.connectedFolderRoot, "draft.md"), "Always guaranteed.\n");
    const proposed = await request<{ declaration: { id: string }; digest: string }>(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/configure`, { method: "POST", body: { proposal: { ...proposal, check: { ...proposal.check, sensor: { id: "amplefile.text-review", revision: 1, parameters: { criteria: "Avoid unqualified promises." } }, targets: [{ kind: "file", role: "primary", path: "draft.md" }] } } } });
    assert.equal((await service.status(connectedFolder)).enabled, 0);
    const trial = await request<{ task: { taskId: string } }>(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/${proposed.declaration.id}/try`, { method: "POST", body: { expectedDigest: proposed.digest } }, 202);
    const trialStatus = await waitForTerminal(api.origin, connectedFolder.id, trial.task.taskId);
    assert.equal(trialStatus.state, "succeeded", trialStatus.error ?? "trial failed");
    assert.equal((await service.problems(connectedFolder)).findings.length, 0);
    await request(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/${proposed.declaration.id}/enable`, { method: "POST", body: { expectedDigest: proposed.digest } });
    const run = await request<{ task: { taskId: string } }>(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/run`, { method: "POST", body: {} }, 202);
    const liveStatus = await waitForTerminal(api.origin, connectedFolder.id, run.task.taskId);
    assert.equal(liveStatus.state, "succeeded", liveStatus.error ?? "live run failed");
    const finding = (await service.problems(connectedFolder)).findings[0]!;
    const { draft } = await request<{ draft: string }>(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/findings/${finding.id}/help`, { method: "POST", body: { fingerprint: finding.fingerprint } });
    assert.match(draft, /correction for review in Checks/); assert.ok(draft.includes(finding.id)); assert.equal(calls, 2, "opening a help draft starts no model");
    assert.ok(draft.includes("amplefile help checks"));
    assert.ok(draft.includes(`checks problems --connected-folder ${connectedFolder.id} --json`));
    assert.ok(draft.includes(`checks propose-fix --connected-folder ${connectedFolder.id}`));
    const path = join(sandbox, "fix.json");
    await writeFile(path, JSON.stringify({ kind: "amplefile.check-correction", version: 1, findingId: finding.id, fingerprint: finding.fingerprint, path: finding.targetPath, beforeHash: finding.evidence[0]!.identity.sha256, replacement: "Usually supported.\n" }));
    const { correction } = await api.actFacade.checksProposeFix({ connectedFolder: connectedFolder.id, proposalPath: path, cwd: sandbox });
    const review = await request<{ before: string }>(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/corrections/${correction.id}/review`, { method: "POST", body: {} });
    assert.equal(review.before, "Always guaranteed.\n"); assert.equal(calls, 2);
    const applied = await request<{ task: { taskId: string }; correction: { state: string } }>(api.origin, `/api/connected-folders/${connectedFolder.id}/checks/corrections/${correction.id}/apply`, { method: "POST", body: {} });
    assert.equal(applied.correction.state, "applied");
    assert.equal((await waitForTerminal(api.origin, connectedFolder.id, applied.task.taskId)).state, "succeeded");
    assert.equal((await service.status(connectedFolder)).state, "current-clear");
    const repeat = await fetch(`${api.origin}/api/connected-folders/${connectedFolder.id}/checks/corrections/${correction.id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(repeat.status, 409);
  } finally { await api.close(); await rm(sandbox, { recursive: true, force: true }); }
});
