import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { declarationFromAmpleFileCheckProposal, normalizeAmpleFileCheckProposal } from "../src/shared/checks.js";
import { admitAmpleFileCheckCandidate, reverifyAmpleFileCheckFinding } from "../src/local/checks/check-admission.js";
import { ampleFileCheckDigest } from "../src/local/checks/check-integrity.js";
import { ampleFileFilePresenceSensorDigest } from "../src/local/checks/check-sensors.js";

const declaration = declarationFromAmpleFileCheckProposal(normalizeAmpleFileCheckProposal({
  kind: "amplefile.check-proposal",
  version: 1,
  name: "Required PDF",
  createdBy: "assistant",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "Signed PDF exists",
    severity: "error",
    trigger: "manual",
    sensor: { id: "amplefile.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Output/signed.pdf" }],
  },
}), "check-12345678");

test("the runner admits only host-reverified evidence and invalidates it after reality changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-check-admission-"));
  const digest = ampleFileCheckDigest(declaration);
  const finding = await admitAmpleFileCheckCandidate({
    root: root,
    declaration,
    declarationDigest: digest,
    sensorDigest: ampleFileFilePresenceSensorDigest,
    now: new Date("2026-08-01T00:00:00.000Z"),
    candidate: {
      title: "Expected file is missing",
      targetPath: "Output/signed.pdf",
      evidence: [{
        kind: "path-state",
        path: "Output/signed.pdf",
        expected: "file",
        observed: "missing",
        identity: { checkId: declaration.id, path: "Output/signed.pdf", state: "missing" },
      }],
    },
  });
  assert.ok(finding);
  assert.equal(await reverifyAmpleFileCheckFinding(root, declaration, finding), true);

  await mkdir(join(root, "Output"));
  await writeFile(join(root, "Output", "signed.pdf"), Buffer.from([0, 1, 2, 3]));
  assert.equal(await reverifyAmpleFileCheckFinding(root, declaration, finding), false);
});

test("fabricated, out-of-scope, and hostile candidate material is discarded", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-check-forged-"));
  const base = {
    root: root,
    declaration,
    declarationDigest: ampleFileCheckDigest(declaration),
    sensorDigest: ampleFileFilePresenceSensorDigest,
  };
  assert.equal(await admitAmpleFileCheckCandidate({
    ...base,
    candidate: {
      title: "Forged present state",
      targetPath: "Output/signed.pdf",
      evidence: [{
        kind: "path-state",
        path: "Output/signed.pdf",
        expected: "missing",
        observed: "file",
        identity: { checkId: declaration.id, path: "Output/signed.pdf", state: "file" },
      }],
    },
  }), null);
  assert.equal(await admitAmpleFileCheckCandidate({
    ...base,
    candidate: {
      title: "Outside",
      targetPath: "../outside.txt",
      evidence: [],
    },
  }), null);
  assert.equal(await admitAmpleFileCheckCandidate({
    ...base,
    candidate: {
      title: "Hostile\u001b]8;;https://example.com\u0007link",
      targetPath: "Output/signed.pdf",
      evidence: [{
        kind: "path-state",
        path: "Output/signed.pdf",
        expected: "file",
        observed: "missing",
        identity: { checkId: declaration.id, path: "Output/signed.pdf", state: "missing" },
      }],
    },
  }), null);
});

test("tree-scoped findings stay inside recursion and extension bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-check-tree-admission-"));
  await mkdir(join(root, "Drafts", "nested"), { recursive: true });
  await writeFile(join(root, "Drafts", "chapter.md"), "chapter");
  await writeFile(join(root, "Drafts", "notes.txt"), "notes");
  await writeFile(join(root, "Drafts", "nested", "appendix.md"), "appendix");
  const treeDeclaration = {
    ...declaration,
    targets: [{ kind: "tree" as const, role: "primary" as const, path: "Drafts", recursive: false, extensions: [".md"] }],
  };
  const candidate = (path: string) => ({
    title: "Unexpected file",
    targetPath: path,
    evidence: [{
      kind: "path-state" as const,
      path,
      expected: "missing" as const,
      observed: "file" as const,
      identity: { checkId: treeDeclaration.id, path, state: "file" as const },
    }],
  });
  const base = {
    root: root,
    declaration: treeDeclaration,
    declarationDigest: ampleFileCheckDigest(treeDeclaration),
    sensorDigest: ampleFileFilePresenceSensorDigest,
  };
  assert.ok(await admitAmpleFileCheckCandidate({ ...base, candidate: candidate("Drafts/chapter.md") }));
  assert.equal(await admitAmpleFileCheckCandidate({ ...base, candidate: candidate("Drafts/notes.txt") }), null);
  assert.equal(await admitAmpleFileCheckCandidate({ ...base, candidate: candidate("Drafts/nested/appendix.md") }), null);
});
