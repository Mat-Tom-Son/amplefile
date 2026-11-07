import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeAmpleFileCheckProposal } from "../src/shared/checks.js";
import {
  discoverAmpleFileCheckDeclarations,
  readAmpleFileCheckProposal,
  writeAmpleFileCheckDeclaration,
} from "../src/local/checks/check-declarations.js";
import { AmpleFileCheckStore } from "../src/local/checks/check-store.js";
import { ampleFileFilePresenceSensorDigest } from "../src/local/checks/check-sensors.js";

const proposalValue = {
  kind: "amplefile.check-proposal",
  version: 1,
  name: "Required delivery",
  createdBy: "assistant",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "The signed delivery exists",
    severity: "error",
    trigger: "manual",
    sensor: { id: "amplefile.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Deliverables/signed.pdf" }],
  },
} as const;

test("portable declarations remain inert until exact machine-local authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-check-declaration-"));
  const proposalPath = join(root, "proposal.amplefile-check.json");
  await writeFile(proposalPath, `${JSON.stringify(proposalValue)}\n`);
  const proposal = await readAmpleFileCheckProposal(proposalPath);
  const written = await writeAmpleFileCheckDeclaration(root, proposal);

  const discovery = await discoverAmpleFileCheckDeclarations(root);
  assert.equal(discovery.errors.length, 0);
  assert.equal(discovery.declarations.length, 1);
  assert.equal(discovery.declarations[0]?.digest, written.digest);
  assert.deepEqual(discovery.declarations[0]?.declaration, written.declaration);
  assert.match(await readFile(written.path, "utf8"), /amplefile\.file-presence/);

  const statePath = join(root, "machine-state.json");
  const store = await AmpleFileCheckStore.create("connected-folder-delivery", { path: statePath });
  assert.deepEqual(store.snapshot().authorizations, {}, "discovery must not grant authority");
  await store.authorize(written.declaration, written.digest, "human", ampleFileFilePresenceSensorDigest);
  assert.equal(store.snapshot().authorizations[written.declaration.id]?.declarationDigest, written.digest);
});

test("declaration discovery isolates malformed and mismatched records without enabling them", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-check-malformed-"));
  const directory = join(root, ".amplefile", "checks");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "broken.json"), "{not-json");
  await writeFile(join(directory, "wrong-name.json"), JSON.stringify({
    kind: "amplefile.check",
    version: 1,
    id: "check-12345678",
    ...proposalValue.check,
    createdBy: "assistant",
    createdAt: "2026-08-01T00:00:00.000Z",
  }));
  const discovery = await discoverAmpleFileCheckDeclarations(root);
  assert.equal(discovery.declarations.length, 0);
  assert.equal(discovery.errors.length, 2);
  assert.match(discovery.errors.map((item) => item.message).join("\n"), /filename|JSON/i);
});

test("proposal parsing rejects declarations that try to carry execution authority", () => {
  assert.throws(() => normalizeAmpleFileCheckProposal({
    ...proposalValue,
    check: {
      ...proposalValue.check,
      sensor: { ...proposalValue.check.sensor, parameters: { expect: "present", command: "find ." } },
    },
  }), /not allowed/);
  assert.throws(() => normalizeAmpleFileCheckProposal({ ...proposalValue, enabled: true }), /unsupported field/);
});
