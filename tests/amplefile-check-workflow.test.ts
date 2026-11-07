import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AmpleFileCheckService } from "../src/local/checks/check-service.js";
import { AmpleFileCheckStore } from "../src/local/checks/check-store.js";
import { AmpleFileKernel } from "../src/local/amplefile-kernel.js";
import { getConnectedFolderCheckpoint } from "../src/local/history.js";
import { normalizeCheckCorrection, writeCheckCorrection } from "../src/local/checks/check-corrections.js";
import { createHash } from "node:crypto";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "amplefile-check-workflow-"));
  const root = join(dir, "Review"); await mkdir(root);
  const priorState = process.env.AMPLEFILE_STATE_DIR;
  process.env.AMPLEFILE_STATE_DIR = join(dir, "profile");
  await writeFile(join(root, "draft.md"), "Always guaranteed.\n");
  await writeFile(join(root, "reference.md"), "Usually supported.\n");
  const connectedFolder = { id: "connected-folder-review", connectedFolderRoot: root };
  let clear = false, calls = 0;
  const store = await AmpleFileCheckStore.create(connectedFolder.id, { path: join(dir, "checks.json") });
  const service = new AmpleFileCheckService({ kernel: new AmpleFileKernel(),
    reviewModel: async () => { calls++; return { submission: { findings: clear ? [] : [{ path: "draft.md", quote: "Always guaranteed.", title: "Unqualified promise", detail: "The reference is qualified." }] } }; },
    listConnectedFolders: async () => [{ ...connectedFolder, name: "Review", location: { kind: "local", storage: "linked" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    storeFactory: async () => store,
  });
  t.after(async () => { await service.close(); if (priorState === undefined) delete process.env.AMPLEFILE_STATE_DIR; else process.env.AMPLEFILE_STATE_DIR = priorState; await rm(dir, { recursive: true, force: true }); });
  const proposal = { kind: "amplefile.check-proposal", version: 1, name: "Claims", createdBy: "assistant", createdAt: new Date().toISOString(), check: {
    title: "Claims match reference", severity: "warning", trigger: "manual", sensor: { id: "amplefile.text-review", revision: 1, parameters: { criteria: "Flag promises stronger than the reference." } },
    targets: [{ kind: "file", role: "primary", path: "draft.md" }, { kind: "file", role: "reference", path: "reference.md" }],
  } };
  const proposed = await service.enable({ connectedFolder, proposal, actor: "cli", proposeOnly: true });
  async function run(trial = false) {
    const accepted = await service.run({ connectedFolder, checkId: proposed.declaration.id, ...(trial ? { trialDigest: proposed.digest } : {}), actor: { kind: "renderer", connectedFolderId: connectedFolder.id } });
    for (let attempt = 0; attempt < 1000; attempt++) {
      const status = await service.taskStatus(connectedFolder.id, accepted.taskId);
      if (!["accepted", "running"].includes(status.state)) return service.taskResult(connectedFolder.id, accepted.taskId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Run did not settle");
  }
  async function enable() { await service.enable({ connectedFolder, checkId: proposed.declaration.id, expectedDigest: proposed.digest, actor: "human" }); }
  async function correction() {
    await enable(); const result = await run(); const finding = result.findings[0]!;
    return service.proposeCorrection({ connectedFolder, proposal: { kind: "amplefile.check-correction", version: 1, findingId: finding.id, fingerprint: finding.fingerprint, path: finding.targetPath, beforeHash: finding.evidence[0]!.identity.sha256, replacement: "Usually supported.\n" } });
  }
  return { dir, root, connectedFolder, store, service, proposed, run, enable, correction, clear: () => { clear = true; }, calls: () => calls };
}

test("proposal is inert; a trial records evidence without enabling, publishing live findings or settling automations", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.status(f.connectedFolder)).enabled, 0);
  assert.equal(f.calls(), 0);
  await assert.rejects(() => f.run(), /Enabled Check not found/);
  await assert.rejects(() => f.service.run({ connectedFolder: f.connectedFolder, checkId: f.proposed.declaration.id, trialDigest: "0".repeat(64), actor: { kind: "renderer" } }), /proposal changed/);
  const trial = await f.run(true);
  assert.equal(trial.state, "succeeded", trial.error);
  assert.equal(trial.trial, true); assert.equal(trial.findings.length, 1);
  assert.deepEqual(f.store.snapshot().authorizations, {});
  assert.equal((await f.service.problems(f.connectedFolder)).findings.length, 0);
  assert.deepEqual(await f.service.settledRuns(f.connectedFolder), []);
  assert.equal((await f.service.status(f.connectedFolder)).lastRunAt, null);
  await assert.rejects(() => f.service.decide({ connectedFolderId: f.connectedFolder.id, findingId: trial.findings[0]!.id, decision: "resolve", actor: "human" }), /not found/i);
  await f.enable(); await f.run();
  f.clear(); await f.run(true);
  assert.equal((await f.service.problems(f.connectedFolder)).findings.length, 1, "a clear trial must not supersede a live finding");
  assert.equal((await f.service.status(f.connectedFolder)).state, "needs-attention");
});

test("correction review is inert, apply preserves exact History bytes, and repeat apply is refused", async (t) => {
  const f = await fixture(t); const correction = await f.correction();
  assert.equal(await readFile(join(f.root, "draft.md"), "utf8"), "Always guaranteed.\n");
  const review = await f.service.reviewCorrection(f.connectedFolder, correction.id);
  assert.equal(review.before, "Always guaranteed.\n"); assert.equal(f.calls(), 1);
  const result = await f.service.applyCorrection(f.connectedFolder, correction.id);
  assert.equal(await readFile(join(f.root, "draft.md"), "utf8"), "Usually supported.\n");
  const checkpoint = await getConnectedFolderCheckpoint(f.root, result.correction.checkpointId!);
  assert.equal(checkpoint?.files[0]?.hashSha256, correction.proposal.beforeHash);
  assert.equal(result.correction.state, "applied");
  await assert.rejects(() => f.service.applyCorrection(f.connectedFolder, correction.id), /not applied again/);
  assert.equal((await f.service.status(f.connectedFolder)).state, "stale", "applying alone never claims the Check is clear");
  f.clear(); assert.equal((await f.run()).state, "succeeded");
  assert.equal((await f.service.status(f.connectedFolder)).state, "current-clear");
});

for (const path of ["draft.md", "reference.md"]) test(`changed ${path} prevents correction review and apply`, async (t) => {
  const f = await fixture(t); const correction = await f.correction();
  await writeFile(join(f.root, path), "Changed since review.\n");
  await assert.rejects(() => f.service.reviewCorrection(f.connectedFolder, correction.id), /changed/);
  await assert.rejects(() => f.service.applyCorrection(f.connectedFolder, correction.id), /changed/);
  assert.equal(f.store.snapshot().corrections?.[0]?.state, "pending");
});

test("correction writer rejects links, stale bytes, metadata targets and unknown fields", async (t) => {
  const f = await fixture(t); const correction = await f.correction();
  await assert.rejects(() => writeCheckCorrection(f.root, { ...correction.proposal, beforeHash: "0".repeat(64) }), /changed/);
  await link(join(f.root, "draft.md"), join(f.root, "hardlink.md"));
  await assert.rejects(() => writeCheckCorrection(f.root, correction.proposal), /unlinked/);
  await symlink(join(f.root, "reference.md"), join(f.root, "linked.md"));
  await assert.rejects(() => writeCheckCorrection(f.root, { ...correction.proposal, path: "linked.md" }));
  assert.throws(() => normalizeCheckCorrection({ ...correction.proposal, path: ".amplefile/connected-folder.json" }), /hidden/);
  assert.throws(() => normalizeCheckCorrection({ ...correction.proposal, command: "anything" }), /unknown/);
  assert.equal(createHash("sha256").update(await readFile(join(f.root, "draft.md"))).digest("hex"), correction.proposal.beforeHash);
});

test("interrupted correction is never retried and retains its History reference", async (t) => {
  const f = await fixture(t); const correction = await f.correction();
  await f.store.saveCorrection({ ...correction, state: "applying", checkpointId: "checkpoint-test" });
  const reloaded = await AmpleFileCheckStore.create(f.connectedFolder.id, { path: join(f.dir, "checks.json") });
  assert.equal(reloaded.snapshot().corrections?.[0]?.state, "failed");
  assert.equal(reloaded.snapshot().corrections?.[0]?.checkpointId, "checkpoint-test");
  assert.equal(await readFile(join(f.root, "draft.md"), "utf8"), "Always guaranteed.\n");
});
