import assert from "node:assert/strict";
import test from "node:test";

import {
  ampleFileAutomationGuideExampleProposal,
  ampleFileAutomationGuideSampleConnectedFolder,
  ampleFileAutomationTriggerShapes,
  ampleFileAutomationVersionAdditions,
} from "../src/local/automations/automation-authoring-guide.js";
import {
  ampleFileAutomationContractVersion,
  ampleFileAutomationSupportedContractVersions,
  normalizeAmpleFileAutomationDeclaration,
  normalizeAmpleFileAutomationProposal,
  type AmpleFileAutomationContractVersion,
} from "../src/local/automations/automation-declarations.js";
import { ampleFileCliHelp } from "../src/local/cli/index.js";

function declarationWith(version: number, trigger: Record<string, unknown>): unknown {
  return {
    kind: "amplefile.automation",
    version,
    id: "automation-guide-check",
    title: "Guide check",
    createdBy: "human",
    createdAt: "2026-01-01T00:00:00.000Z",
    trigger,
    steps: [{ id: "look", kind: "chat", connectedFolder: ampleFileAutomationGuideSampleConnectedFolder, message: "Look at the new files." }],
  };
}

test("the authoring guide says what every supported version adds", () => {
  for (const version of ampleFileAutomationSupportedContractVersions) {
    assert.ok(ampleFileAutomationVersionAdditions[version]?.trim(), `version ${version} must say what it adds`);
  }
  assert.equal(
    Math.max(...ampleFileAutomationSupportedContractVersions),
    ampleFileAutomationContractVersion,
    "the newest supported version is the one the guide tells authors to write",
  );
});

test("every trigger shape in the guide is accepted from the version it names and refused before it", () => {
  const kinds = new Set<unknown>();
  for (const shape of ampleFileAutomationTriggerShapes) {
    kinds.add(shape.trigger.kind);
    assert.doesNotThrow(() => normalizeAmpleFileAutomationDeclaration(declarationWith(shape.since, shape.trigger)), shape.when);
    assert.doesNotThrow(
      () => normalizeAmpleFileAutomationDeclaration(declarationWith(ampleFileAutomationContractVersion, shape.trigger)),
      `the newest version accepts: ${shape.when}`,
    );
    if (shape.since > 1) {
      const earlier = (shape.since - 1) as AmpleFileAutomationContractVersion;
      assert.throws(
        () => normalizeAmpleFileAutomationDeclaration(declarationWith(earlier, shape.trigger)),
        new RegExp(`version ${shape.since}`),
        `version ${earlier} must refuse: ${shape.when}`,
      );
    }
  }
  // Every trigger kind the validator accepts has a shape an author can copy.
  assert.deepEqual([...kinds].sort(), ["at", "files-changed", "interval", "manual"]);
});

test("the guide's example proposal is valid at the newest version", () => {
  const proposal = normalizeAmpleFileAutomationProposal(structuredClone(ampleFileAutomationGuideExampleProposal));
  assert.equal(proposal.version, ampleFileAutomationContractVersion);
  assert.deepEqual(proposal.automation.steps.map((step) => step.kind).sort(), ["agent", "chat", "files"]);
});

test("help automations shows the guide as the validator defines it", () => {
  const help = ampleFileCliHelp("AmpleFile", "automations");
  assert.ok(help.includes(`Write "version": ${ampleFileAutomationContractVersion}, the newest.`));
  for (const version of ampleFileAutomationSupportedContractVersions) {
    assert.ok(help.includes(`  ${version}  ${ampleFileAutomationVersionAdditions[version]}`), `help lists version ${version}`);
  }
  for (const shape of ampleFileAutomationTriggerShapes) {
    assert.ok(help.includes(JSON.stringify(shape.trigger)), `help shows the trigger for: ${shape.when}`);
  }
  assert.ok(help.includes(JSON.stringify(ampleFileAutomationGuideExampleProposal)), "help shows the checked example");
  assert.doesNotMatch(help, /on-settled/);
});
