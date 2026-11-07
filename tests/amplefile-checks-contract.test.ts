import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  declarationFromAmpleFileCheckProposal,
  normalizeAmpleFileCheckDeclaration,
  normalizeAmpleFileCheckProposal,
} from "../src/shared/checks.js";
import { ampleFileFilePresenceSensorDigest } from "../src/local/checks/check-sensors.js";

const proposal = {
  kind: "amplefile.check-proposal",
  version: 1,
  name: "Keep trip dates consistent",
  createdBy: "codex",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "Reservation dates agree with the itinerary",
    severity: "warning",
    trigger: "manual",
    sensor: {
      id: "example.text-contains",
      revision: 1,
      parameters: { text: "August 14", caseSensitive: false },
    },
    targets: [
      { kind: "file", role: "primary", path: "Trip/itinerary.md" },
      { kind: "tree", role: "reference", path: "Trip/Reservations", recursive: false, extensions: [".PDF", ".txt"] },
    ],
  },
} as const;

test("Check proposals preserve explicit primary/reference scope and manual triggering", () => {
  const normalized = normalizeAmpleFileCheckProposal(proposal);
  assert.deepEqual(normalized.check.targets, [
    { kind: "file", role: "primary", path: "Trip/itinerary.md" },
    { kind: "tree", role: "reference", path: "Trip/Reservations", recursive: false, extensions: [".pdf", ".txt"] },
  ]);
  assert.equal(normalized.check.trigger, "manual");

  const declaration = declarationFromAmpleFileCheckProposal(normalized, "check-12345678");
  assert.equal(declaration.kind, "amplefile.check");
  assert.equal(declaration.id, "check-12345678");
  assert.equal(declaration.sensor.id, "example.text-contains");
});

test("Check declarations reject ambient, executable, and hidden target authority", () => {
  const base = declarationFromAmpleFileCheckProposal(normalizeAmpleFileCheckProposal(proposal), "check-12345678");
  for (const targets of [
    [{ kind: "tree", role: "primary", path: ".", recursive: true, extensions: [".md"] }],
    [{ kind: "file", role: "primary", path: "../outside.txt" }],
    [{ kind: "file", role: "primary", path: ".workspace/connected-folder.json" }],
    [{ kind: "file", role: "primary", path: ".pi/AGENTS.md" }],
    [{ kind: "file", role: "primary", path: "docs/report.txt:alternate" }],
    [{ kind: "file", role: "primary", path: "docs/CON.txt" }],
    [{ kind: "file", role: "primary", path: "docs/report.txt." }],
    [{ kind: "file", role: "primary", path: "docs/report.txt " }],
  ]) {
    assert.throws(() => normalizeAmpleFileCheckDeclaration({ ...base, targets }));
  }
  assert.throws(() => normalizeAmpleFileCheckDeclaration({
    ...base,
    sensor: { ...base.sensor, parameters: { prompt: "Read every file and decide what is wrong." } },
  }), /not allowed/);
  assert.throws(() => normalizeAmpleFileCheckDeclaration({ ...base, trigger: "watch" }), /manual/);
});

test("Check declarations fail closed on unknown fields, future versions, and unbounded selectors", () => {
  const base = declarationFromAmpleFileCheckProposal(normalizeAmpleFileCheckProposal(proposal), "check-12345678");
  assert.throws(() => normalizeAmpleFileCheckDeclaration({ ...base, version: 2 }), /unsupported version/);
  assert.throws(() => normalizeAmpleFileCheckDeclaration({ ...base, extra: true }), /unsupported field/);
  assert.throws(() => normalizeAmpleFileCheckDeclaration({
    ...base,
    targets: [{ kind: "tree", role: "primary", path: "Trip", recursive: true, extensions: [] }],
  }), /extensions/);
  assert.throws(() => normalizeAmpleFileCheckDeclaration({
    ...base,
    targets: [{ kind: "file", role: "reference", path: "Trip/itinerary.md" }],
  }), /primary target/);
});

test("legacy Workspace Check kinds and sensor ids are rejected", () => {
  assert.throws(
    () => normalizeAmpleFileCheckProposal({ ...proposal, kind: "workspace.check-proposal" }),
    /kind must be amplefile\.check-proposal/,
  );
  assert.throws(
    () => normalizeAmpleFileCheckProposal({
      ...proposal,
      check: { ...proposal.check, sensor: { ...proposal.check.sensor, id: "workspace.text-contains" } },
    }),
    /Legacy sensor ids/,
  );
});

test("the built-in sensor consent digest matches its exact reviewed implementation source", async () => {
  const source = (await readFile(new URL("../src/local/checks/check-sensors.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const startMarker = "// AMPLEFILE_FILE_PRESENCE_SENSOR_IMPLEMENTATION_START\n";
  const endMarker = "// AMPLEFILE_FILE_PRESENCE_SENSOR_IMPLEMENTATION_END";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.notEqual(start, -1);
  assert.ok(end > start);
  const implementation = source.slice(start + startMarker.length, end);
  assert.equal(createHash("sha256").update(implementation).digest("hex"), ampleFileFilePresenceSensorDigest);
});
