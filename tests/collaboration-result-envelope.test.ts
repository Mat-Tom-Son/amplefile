import assert from "node:assert/strict";
import test from "node:test";

import {
  AmpleFileRequestLimitError,
  assertConnectedFolderRelativeResultPath,
  parseAmpleFileResultEnvelope,
  ampleFileRequestLimitsSection,
} from "../src/local/requests/request-records.js";
import { ampleFileRequestLimits } from "../src/shared/amplefile-limits.js";
import { parseRestrictedAppJsonSchema } from "../src/local/agent/restricted-app-manifest.js";

/**
 * The one result shape (docs/collaboration-contract.md, F29). `chat report`,
 * an app-requested Worker task, a handoff outcome, and an automation chat hop
 * all produce this envelope, so what it accepts and what it refuses is a
 * contract several callers depend on.
 */

const sha256 = "a".repeat(64);
const otherSha256 = "b".repeat(64);

test("one result envelope carries a summary, an outcome, and nothing undeclared", () => {
  assert.deepEqual(
    parseAmpleFileResultEnvelope({ summary: "Drafted the note.", outcome: "succeeded" }),
    { summary: "Drafted the note.", outcome: "succeeded" },
  );
  assert.deepEqual(
    parseAmpleFileResultEnvelope({
      summary: "Drafted the note.\nTwo files.",
      data: { words: 812, sections: ["intro", "detail"], draft: null },
      files: [
        { path: "drafts/q3-note.md", sha256, sizeBytes: 4_096 },
        { path: "drafts/figures.csv", sha256: otherSha256, sizeBytes: 0 },
      ],
      outcome: "partial",
    }),
    {
      summary: "Drafted the note.\nTwo files.",
      data: { words: 812, sections: ["intro", "detail"], draft: null },
      files: [
        { path: "drafts/q3-note.md", sha256, sizeBytes: 4_096 },
        { path: "drafts/figures.csv", sha256: otherSha256, sizeBytes: 0 },
      ],
      outcome: "partial",
    },
  );
  for (const outcome of ["succeeded", "partial", "failed"]) {
    assert.equal(parseAmpleFileResultEnvelope({ summary: "Done.", outcome }).outcome, outcome);
  }
  // Failing closed: a field F29 does not define is refused rather than
  // silently carried into a record that outlives this build.
  assert.throws(
    () => parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded", nextSteps: "later" }),
    /Result has an unexpected field: nextSteps\./,
  );
  // data and files are absent rather than empty when nothing was given.
  const minimal = parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded" });
  assert.equal("data" in minimal, false);
  assert.equal("files" in minimal, false);
});

test("an envelope without a usable summary or outcome is refused", () => {
  for (const value of [null, "Done.", ["Done."], 7]) {
    assert.throws(() => parseAmpleFileResultEnvelope(value), /Result must be an object\./);
  }
  assert.throws(() => parseAmpleFileResultEnvelope({ outcome: "succeeded" }), /Result summary must be text\./);
  for (const summary of ["", "   ", "\n"]) {
    assert.throws(
      () => parseAmpleFileResultEnvelope({ summary, outcome: "succeeded" }),
      /Result summary cannot be empty\./,
      JSON.stringify(summary),
    );
  }
  for (const outcome of [undefined, "ok", "SUCCEEDED", true]) {
    assert.throws(
      () => parseAmpleFileResultEnvelope({ summary: "Done.", ...(outcome === undefined ? {} : { outcome }) }),
      /Result outcome/,
      String(outcome),
    );
  }
});

test("every envelope bound refuses as a named limit, not as a generic failure", () => {
  // Bounds are generous defaults a person can see and raise
  // (docs/receipts-not-gates.md, principle 6), so a refusal carries the limit
  // it hit and points at the place that shows the number.
  const overSummary = () => parseAmpleFileResultEnvelope({
    summary: "x".repeat(ampleFileRequestLimits.maxResultSummaryBytes + 1),
    outcome: "succeeded",
  });
  assert.throws(overSummary, (error: unknown) =>
    error instanceof AmpleFileRequestLimitError
    && error.limit === "resultSummary"
    && error.message.includes(ampleFileRequestLimitsSection));

  // Bytes, not characters: the contract states these limits in KiB.
  const multiByte = "é".repeat(ampleFileRequestLimits.maxResultSummaryBytes / 2);
  assert.equal(parseAmpleFileResultEnvelope({ summary: multiByte, outcome: "succeeded" }).summary, multiByte);
  assert.throws(
    () => parseAmpleFileResultEnvelope({ summary: `${multiByte}x`, outcome: "succeeded" }),
    (error: unknown) => error instanceof AmpleFileRequestLimitError && error.limit === "resultSummary",
  );

  assert.throws(
    () => parseAmpleFileResultEnvelope({
      summary: "Done.",
      outcome: "succeeded",
      data: { text: "x".repeat(ampleFileRequestLimits.maxResultDataBytes) },
    }),
    (error: unknown) => error instanceof AmpleFileRequestLimitError
      && error.limit === "resultData"
      && error.message.includes(ampleFileRequestLimitsSection),
  );

  const manyFiles = Array.from(
    { length: 100 },
    (_, index) => ({ path: `drafts/${index}.md`, sha256, sizeBytes: 1 }),
  );
  assert.equal(parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded", files: manyFiles }).files?.length, 100);
});

test("deliverables are Connected Folder–relative paths with a real content hash and size", () => {
  const envelope = (files: unknown) => () => parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded", files });
  assert.throws(envelope("drafts/q3.md"), /Result files must be a list\./);
  assert.throws(envelope(["drafts/q3.md"]), /Result file 1 must be an object\./);
  assert.throws(
    envelope([{ path: "drafts/q3.md", sha256, sizeBytes: 1, note: "mine" }]),
    /Result file 1 has an unexpected field: note\./,
  );
  // Portable Connected Folder metadata and executable Pi configuration are never
  // deliverables, and no spelling of a path may reach outside the Connected Folder
  // (AGENTS.md, portable identity).
  for (const path of ["/etc/passwd", "C:\\notes.md", "../outside.md", "drafts/../../outside.md", "./drafts/q3.md", "."]) {
    assert.throws(() => assertConnectedFolderRelativeResultPath(path), /must be relative to the Connected Folder\./, path);
    assert.throws(envelope([{ path, sha256, sizeBytes: 1 }]), /must be relative to the Connected Folder\./, path);
  }
  for (const path of [".amplefile/connected-folder.json", ".pi/skills/x.md", "docs/.WORKSPACE/old.json", "notes/.AmpleFile/x"]) {
    assert.throws(() => assertConnectedFolderRelativeResultPath(path), /reserved AmpleFile, Pi, or legacy product metadata\./, path);
    assert.throws(envelope([{ path, sha256, sizeBytes: 1 }]), /reserved AmpleFile, Pi, or legacy product metadata\./, path);
  }
  assert.throws(envelope([{ path: "", sha256, sizeBytes: 1 }]), /Result file 1 path cannot be empty\./);
  // Ordinary names with spaces stay ordinary.
  assert.doesNotThrow(() => assertConnectedFolderRelativeResultPath("drafts/q3 note.md"));

  for (const bad of [undefined, "", `sha256:${sha256}`, "A".repeat(64), "a".repeat(63)]) {
    assert.throws(
      envelope([{ path: "drafts/q3.md", ...(bad === undefined ? {} : { sha256: bad }), sizeBytes: 1 }]),
      /Result file 1 fingerprint is invalid\./,
      String(bad),
    );
  }
  for (const sizeBytes of [undefined, -1, 1.5, "4096"]) {
    assert.throws(
      envelope([{ path: "drafts/q3.md", sha256, ...(sizeBytes === undefined ? {} : { sizeBytes }) }]),
      /Result file 1 size/,
      String(sizeBytes),
    );
  }
});

test("a declared result shape is applied by the app manifest validator, not a second one", () => {
  // The closed subset already shipped for app tools is the single
  // implementation; the envelope hands `data` to it rather than reimplementing
  // schema validation.
  const schema = parseRestrictedAppJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: { words: { type: "integer" }, title: { type: "string" } },
    required: ["words"],
  }, "Result data schema");

  assert.deepEqual(
    parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded", data: { words: 812 } }, { schema }).data,
    { words: 812 },
  );
  // A visible validation failure that names the property, never silently
  // accepted prose in the shape of a result.
  assert.throws(
    () => parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded", data: { words: "many" } }, { schema }),
    /Result details\.words must have type integer\./,
  );
  assert.throws(
    () => parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded", data: { title: "Q3" } }, { schema }),
    /Result details is missing required property words\./,
  );
  assert.throws(
    () => parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded", data: { words: 1, extra: true } }, { schema }),
    /Result details contains undeclared property extra\./,
  );
  // A free-text result is the common case and needs no schema at all.
  assert.equal(parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded" }, { schema }).data, undefined);
  assert.throws(
    () => parseAmpleFileResultEnvelope({ summary: "Done.", outcome: "succeeded", data: "free text" }, { schema }),
    /Result details must have type object\./,
  );
});
