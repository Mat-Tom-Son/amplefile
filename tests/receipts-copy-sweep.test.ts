import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = async (relativePath: string) => await readFile(join(repositoryRoot, relativePath), "utf8");

/**
 * docs/receipts-not-gates.md acceptance, last bullet: no user-facing copy
 * contains "staged", "approve", "policy", "Reviewed", or "Unrestricted"
 * outside history notes. This sweep pins the surfaces that speak to a person:
 * the public documents, the AmpleFile agent's materialized instructions, and the
 * desktop's copy contract.
 *
 * "Reviewed" and "Unrestricted" are matched case-sensitively because they are
 * the retired authority-setting names; an ordinary sentence about a person
 * reviewing something is still allowed. Protocol identifiers that legitimately
 * survive — the pairing certificate fields and the stored grant status — are
 * neutralized by exact token so a newly written person-facing "approve" cannot
 * hide behind them. Browser app actions run on request, so no approve
 * operation survives there.
 */
const retiredGateWords = /\bstaged\b|\bstaging\b|\bapprove[sd]?\b|\bapproval\b|\bapprovals\b|\bapproving\b|\bpolic(y|ies)\b|\bconsecrat/i;
const retiredAuthorityNames = /\bReviewed\b|\bUnrestricted\b|authority mode|decision card|needs-you card/;

const surviving: Array<[string, string]> = [
  ["approvalCertificate", "pairingRecord"],
  ["approvalSignature", "pairingSignature"],
  ["acceptApproval", "acceptPairing"],
  ['"approved"', '"paired"'],
  // A real sample input in the landing demo, not a product approval control.
  ['"approved-order.md"', '"order-brief.md"'],
];

function speakableSource(text: string): string {
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return surviving.reduce((value, [identifier, stand]) => value.replaceAll(identifier, stand), withoutComments);
}

test("public documents promise receipts and undo instead of gates", async () => {
  for (const document of ["README.md", "SECURITY.md", "PRIVACY.md", "CONTRIBUTING.md"]) {
    const text = await read(document);
    assert.doesNotMatch(text, retiredGateWords, `${document} still carries gate vocabulary`);
    assert.doesNotMatch(text, retiredAuthorityNames, `${document} still names a retired authority setting`);
  }

  // The promises the rewrite has to make, not just the words it drops.
  const readme = await read("README.md");
  assert.match(readme, /leaves a record you can read in the app/);
  assert.match(readme, /\*\*Recently deleted\*\* for 30 days/);

  const security = await read("SECURITY.md");
  assert.match(security, /\*\*Receipts, not gates\.\*\*/);
  assert.match(security, /Destruction is reversible\./);
  assert.match(security, /`amplefile recently-deleted list\|restore`/);
  assert.match(security, /The only human-only surface establishes secrets/);

  const privacy = await read("PRIVACY.md");
  assert.match(privacy, /Recently deleted items under the application-data `recently-deleted\/` directory/);
  assert.match(privacy, /runs at once and leaves a receipt; nothing waits for a further click/);
});

test("shared Skills and the AmpleFile agent's materialized instructions stay gate-free", async () => {
  for (const skill of [".agents/skills/ship-macos-release/SKILL.md"]) {
    const text = await read(skill);
    assert.doesNotMatch(text, retiredGateWords, `${skill} still carries gate vocabulary`);
    assert.doesNotMatch(text, retiredAuthorityNames, `${skill} still names a retired authority setting`);
  }

  // Both materialized resources live in this one module.
  const instructions = speakableSource(await read("src/local/amplefile-agent-instructions.ts"));
  assert.doesNotMatch(instructions, retiredGateWords);
  assert.doesNotMatch(instructions, retiredAuthorityNames);
  assert.match(instructions, /## Receipts, not gates/);
  // Delegation teaching says what waiting is, and never tells a turn to sit
  // on a child (docs/collaboration-contract.md, F28).
  assert.match(instructions, /Waiting is not a failure/);
  assert.match(instructions, /Never busy-wait, sleep, or poll in a loop/);
  assert.doesNotMatch(instructions, /\bpoll(ing)? (until|every)\b|\bsleep \d/i);

  // The Worker's operations guide (F26) is taught text too.
  const guide = speakableSource(await read("src/local/agent/connected-folder-operations-guide.ts"));
  assert.doesNotMatch(guide, retiredGateWords);
  assert.doesNotMatch(guide, retiredAuthorityNames);
});

test("the desktop copy contract never says approve or staged", async () => {
  for (const source of [
    "web-local/src/ui-contract.ts",
  ]) {
    const text = speakableSource(await read(source));
    assert.doesNotMatch(text, retiredGateWords, `${source} still carries gate vocabulary`);
    assert.doesNotMatch(text, retiredAuthorityNames, `${source} still names a retired authority setting`);
    assert.doesNotMatch(text, /access stays off until you allow it/i, `${source} still describes the retired installation defaults`);
  }
});
