import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertAmpleFileAutomationAtAdmissionHorizon,
  declarationFromAmpleFileAutomationProposal,
  normalizeAmpleFileAutomationDeclaration,
  normalizeAmpleFileAutomationProposal,
  readAmpleFileAutomationProposal,
  ampleFileAutomationBounds,
  ampleFileAutomationDigest,
  ampleFileAutomationDocumentMaxBytes,
  ampleFileAutomationMessagePlaceholders,
  ampleFileAutomationProposalFileSuffix,
  ampleFileAutomationReferencedConnectedFolderIds,
  ampleFileAutomationRetiredFeature,
  ampleFileAutomationTriggerCatchesUp,
  contentAddressedAmpleFileAutomationDeclaration,
} from "../src/local/automations/automation-declarations.js";

const manuscriptConnectedFolder = "space-0123456789abcdef";
const publisherConnectedFolder = "space-fedcba9876543210";
const collectorConnectedFolder = "space-aaaaaaaaaaaaaaaa";

const proposalValue = {
  kind: "amplefile.automation-proposal",
  version: 1,
  name: "Weekly review handoff to Publisher",
  createdBy: "assistant",
  createdAt: "2026-08-10T17:00:00Z",
  automation: {
    title: "Move settled review notes to Publisher",
    trigger: { kind: "interval", intervalMinutes: 1440 },
    steps: [
      {
        id: "review",
        kind: "chat",
        connectedFolder: manuscriptConnectedFolder,
        message: "Review chapters/ for unresolved notes and write a summary to reports/weekly-review.md.",
      },
      {
        id: "handoff",
        kind: "files",
        fromConnectedFolder: manuscriptConnectedFolder,
        from: { kind: "step-created-files", step: "review", extensions: ["md"], maxFiles: 10, maxTotalBytes: 10485760 },
        toConnectedFolder: publisherConnectedFolder,
        to: "Incoming/Manuscript",
      },
      {
        id: "verify",
        kind: "chat",
        connectedFolder: publisherConnectedFolder,
        message: "Confirm the incoming notes read cleanly.",
      },
    ],
  },
};

function mutated(mutate: (value: any) => void): unknown {
  const clone = structuredClone(proposalValue) as any;
  mutate(clone);
  return clone;
}

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).reverse().map(([key, item]) => [key, reversedKeys(item)]),
    );
  }
  return value;
}

test("automation proposals canonicalize the documented example into an exact reviewable declaration", () => {
  const normalized = normalizeAmpleFileAutomationProposal(proposalValue);
  assert.equal(normalized.createdAt, "2026-08-10T17:00:00.000Z");
  assert.deepEqual(normalized.automation.trigger, { kind: "interval", intervalMinutes: 1440 });
  const handoff = normalized.automation.steps[1];
  assert.equal(handoff?.kind, "files");
  if (handoff?.kind !== "files" || handoff.from.kind !== "step-created-files") assert.fail("handoff shape");
  assert.deepEqual(handoff.from.extensions, [".md"], "bare extensions canonicalize to the dotted folder target form");

  const declaration = declarationFromAmpleFileAutomationProposal(normalized, "automation-12345678");
  assert.equal(declaration.kind, "amplefile.automation");
  assert.equal(declaration.id, "automation-12345678");
  assert.deepEqual(normalizeAmpleFileAutomationDeclaration(structuredClone(declaration)), declaration, "normalization is idempotent");
  assert.deepEqual(ampleFileAutomationReferencedConnectedFolderIds(declaration), [manuscriptConnectedFolder, publisherConnectedFolder].sort());

  const multiLine = normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "Line one.\nLine two.";
  }));
  const chat = multiLine.automation.steps[0];
  if (chat?.kind !== "chat") assert.fail("chat shape");
  assert.equal(chat.message, "Line one.\nLine two.", "newlines are ordinary message text");

  const manual = normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "manual" };
  }));
  assert.deepEqual(manual.automation.trigger, { kind: "manual" });
});

// Stored automations are re-verified against this digest on every load, so
// its canonical JSON and hash must never change. These are the values every
// stored automation was pinned with.
test("the automation digest is pinned to known values", () => {
  const proposal = normalizeAmpleFileAutomationProposal({
    kind: "amplefile.automation-proposal",
    version: 6,
    name: "Pinned digest",
    createdBy: "assistant",
    createdAt: "2026-11-07T12:00:00Z",
    automation: {
      title: "Sort new scans into Receipts",
      trigger: {
        kind: "files-changed",
        connectedFolder: "space-0123456789abcdef",
        watch: { kind: "tree", path: "", recursive: false, extensions: ["PDF", ".png"] },
        debounceSeconds: 30,
        cooldownMinutes: 5,
        ifMissed: "run",
      },
      steps: [
        { id: "sort", kind: "chat", connectedFolder: "space-0123456789abcdef", message: "Sort these:\n{{trigger.changedFiles}}", model: { provider: "anthropic", id: "claude-opus" } },
        {
          id: "copy",
          kind: "files",
          fromConnectedFolder: "space-0123456789abcdef",
          from: { kind: "step-created-files", step: "sort", extensions: ["md"], maxFiles: 10, maxTotalBytes: 1048576 },
          toConnectedFolder: "space-fedcba9876543210",
          to: "Incoming/Résumés",
        },
        { id: "tell", kind: "agent", message: "Done: {{trigger.summary}}" },
      ],
    },
  });
  assert.equal(ampleFileAutomationDigest(proposal), "04726ac4d5f8d63aac5b7f9cbeceea9a140a991c8b630e0039e3349100d8230f");
  const { declaration, digest } = contentAddressedAmpleFileAutomationDeclaration(proposal);
  assert.equal(declaration.id, "automation-04726ac4d5f8d63a");
  assert.equal(digest, "daa2e21fcc261281e434fbe94eb70dbfd52b67e02d439a84d117a54bf21bfdad");
  // Key order is locale-aware and undefined fields are left out.
  assert.equal(
    ampleFileAutomationDigest({ b: 1, B: [true, null, "é"], a: { Z1: 2.5, _x: "y", z: undefined }, "10": -0, "2": 1e21 }),
    "961750e3f24c03ede08f90902d7b87cd55a21fc50507e486b748cad868d22e9e",
  );
});

test("digests pin the exact declaration independent of field order", () => {
  const declaration = declarationFromAmpleFileAutomationProposal(normalizeAmpleFileAutomationProposal(proposalValue), "automation-12345678");
  assert.equal(ampleFileAutomationDigest(reversedKeys(declaration)), ampleFileAutomationDigest(declaration));
  const edited = structuredClone(declaration);
  const chat = edited.steps[0];
  if (chat?.kind !== "chat") assert.fail("chat shape");
  chat.message = `${chat.message} Also archive.`;
  assert.notEqual(ampleFileAutomationDigest(edited), ampleFileAutomationDigest(declaration), "any message edit changes the digest");
  const renamed = declarationFromAmpleFileAutomationProposal(normalizeAmpleFileAutomationProposal(proposalValue), "automation-87654321");
  assert.notEqual(ampleFileAutomationDigest(renamed), ampleFileAutomationDigest(declaration));
});

test("on-settled triggers are retired and refused by name", () => {
  // Their only sources were Check runs and Connected Folder app automation
  // runs, which AmpleFile does not have.
  const settled = (source: Record<string, unknown>) => mutated((value) => {
    value.automation.trigger = { kind: "on-settled", source };
  });
  assert.throws(() => normalizeAmpleFileAutomationProposal(settled({ kind: "check-run", connectedFolder: collectorConnectedFolder })), /on-settled is retired: it waits for a Check run/);
  assert.throws(
    () => normalizeAmpleFileAutomationProposal(settled({ kind: "app-automation-run", connectedFolder: collectorConnectedFolder, appId: "collector", appAutomationId: "collect" })),
    /on-settled is retired: it waits for a Connected Folder app's automation/,
  );
  assert.throws(() => normalizeAmpleFileAutomationProposal(settled({ kind: "assistant-turn", connectedFolder: collectorConnectedFolder })), /on-settled is retired/);
});

test("version 2 admits explicit-offset one-time triggers and keeps their time-sensitive horizon out of stable parsing", () => {
  const oneTime = mutated((value) => {
    value.version = 2;
    value.automation.trigger = { kind: "at", at: "2026-08-10T14:30:00-04:00", ifMissed: "run" };
  });
  const normalized = normalizeAmpleFileAutomationProposal(oneTime);
  assert.equal(normalized.version, 2);
  assert.deepEqual(normalized.automation.trigger, {
    kind: "at",
    at: "2026-08-10T18:30:00.000Z",
    ifMissed: "run",
  });
  const atMs = Date.parse("2026-08-10T18:30:00.000Z");
  assert.doesNotThrow(() => assertAmpleFileAutomationAtAdmissionHorizon(
    normalized.automation,
    new Date(atMs - ampleFileAutomationBounds.minAtAdvanceMs),
  ));
  assert.throws(() => assertAmpleFileAutomationAtAdmissionHorizon(
    normalized.automation,
    new Date(atMs - ampleFileAutomationBounds.minAtAdvanceMs + 1),
  ), /in the future, and at most ten years ahead/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "at", at: "2026-08-10T18:30:00Z", ifMissed: "run" };
  })), /require contract version 2/);
  for (const at of ["2026-08-10T18:30:00", "not-a-time"]) {
    assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
      value.version = 2;
      value.automation.trigger = { kind: "at", at, ifMissed: "skip" };
    })), /explicit UTC offset/);
  }
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.version = 2;
    value.automation.trigger = { kind: "at", at: "2026-08-10T18:30:00Z", ifMissed: "later" };
  })), /ifMissed/);

  const farAt = "2036-08-11T00:00:00.000Z";
  const maximum = normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.version = 2;
    value.automation.trigger = { kind: "at", at: farAt, ifMissed: "skip" };
  }));
  const earliestNow = Date.parse(farAt) - ampleFileAutomationBounds.maxAtAdvanceMs;
  assert.doesNotThrow(() => assertAmpleFileAutomationAtAdmissionHorizon(
    maximum.automation,
    new Date(earliestNow),
  ));
  assert.throws(() => assertAmpleFileAutomationAtAdmissionHorizon(
    maximum.automation,
    new Date(earliestNow - 1),
  ), /in the future, and at most ten years ahead/);
});

test("automation declarations retain safety bounds without artificial count caps", () => {
  assert.doesNotThrow(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps = Array.from({ length: 17 }, (_, index) => ({
      id: `chat-${index}`,
      kind: "chat",
      connectedFolder: manuscriptConnectedFolder,
      message: "Go.",
    }));
  })));
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps = [];
  })), /at least one step/);
  for (const intervalMinutes of [ampleFileAutomationBounds.minIntervalMinutes - 1, ampleFileAutomationBounds.maxIntervalMinutes + 1, 60.5]) {
    assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
      value.automation.trigger = { kind: "interval", intervalMinutes };
    })), new RegExp(`integer between ${ampleFileAutomationBounds.minIntervalMinutes} and ${ampleFileAutomationBounds.maxIntervalMinutes}`));
  }
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "m".repeat(ampleFileAutomationBounds.maxChatMessageBytes + 1);
  })), /exceeds/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "   ";
  })), /empty/);
  assert.doesNotThrow(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = {
      kind: "paths",
      paths: Array.from({ length: 26 }, (_, index) => `reports/file-${index}.md`),
    };
  })));
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "paths", paths: ["reports/a.md", "reports/a.md"] };
  })), /repeat a path/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "tree", path: "reports", recursive: false, extensions: [] };
  })), /between 1 and 256 file extensions/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = {
      kind: "tree",
      path: "reports",
      recursive: false,
      extensions: Array.from({ length: 257 }, (_, index) => `.e${index}`),
    };
  })), /between 1 and 256 file extensions/);
  for (const maxFiles of [0, ampleFileAutomationBounds.maxHandoffFiles + 1]) {
    assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
      value.automation.steps[1].from.maxFiles = maxFiles;
    })), new RegExp(`maxFiles must be an integer between 1 and ${ampleFileAutomationBounds.maxHandoffFiles}`));
  }
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from.maxTotalBytes = ampleFileAutomationBounds.maxHandoffTotalBytes + 1;
  })), /maxTotalBytes must be an integer between/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    delete value.automation.steps[1].from.maxFiles;
  })), /missing required field: maxFiles/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.name = "n".repeat(121);
  })), /invalid or too long/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.title = "t".repeat(161);
  })), /invalid or too long/);
});

test("step graphs refuse duplicate ids and cyclic, forward, non-chat, or cross-connected-folder handoffs", () => {
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[2].id = "review";
  })), /duplicate id "review"/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from.step = "handoff";
  })), /earlier step; self and forward references/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from.step = "verify";
  })), /earlier step; self and forward references/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from.step = "missing";
  })), /unknown source step "missing"/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    const handoff = value.automation.steps[1];
    value.automation.steps = [
      { ...handoff, id: "first", from: { kind: "paths", paths: ["Notes/a.md"] } },
      { ...handoff, from: { ...handoff.from, step: "first" } },
    ];
  })), /earlier chat step/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].fromConnectedFolder = publisherConnectedFolder;
  })), new RegExp(`must copy from Connected Folder ${manuscriptConnectedFolder}`));
});

test("unknown kinds, versions, fields, and unpinned references fail closed", () => {
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.kind = "amplefile.check-proposal";
  })), /kind must be amplefile\.automation-proposal/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.version = 7;
  })), /unsupported version 7/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.enabled = true;
  })), /unsupported field: enabled/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "cron", expression: "0 9 * * 1" };
  })), /manual or interval/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.trigger = { kind: "manual", intervalMinutes: 60 };
  })), /unsupported field: intervalMinutes/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[0] = { id: "run", kind: "shell", connectedFolder: manuscriptConnectedFolder, command: "rm -rf /" };
  })), /chat or files/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.version = 4;
    value.automation.steps[0] = { id: "run", kind: "shell", connectedFolder: manuscriptConnectedFolder, command: "rm -rf /" };
  })), /chat, files, or agent/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[2] = { id: "verify", kind: "check", connectedFolder: publisherConnectedFolder, check: "check-12345678" };
  })), /kind check is retired/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "glob", pattern: "**/*.md" };
  })), /paths, tree, or step-created-files/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[0].connectedFolder = "Manuscript";
  })), /stable registered Connected Folder id/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].to = "/tmp/out";
  })), /relative to the Connected Folder/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "paths", paths: ["../secrets.md"] };
  })), /normalized relative path/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[1].from = { kind: "paths", paths: [".amplefile/connected-folder.json"] };
  })), /hidden AmpleFile or Pi configuration/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "Review the \u202etfarcria plan.";
  })), /never allowed in an automation message/);

  const declaration = declarationFromAmpleFileAutomationProposal(normalizeAmpleFileAutomationProposal(proposalValue), "automation-12345678");
  assert.throws(() => normalizeAmpleFileAutomationDeclaration({ ...declaration, enabled: true }), /unsupported field: enabled/);
  assert.throws(() => normalizeAmpleFileAutomationDeclaration({ ...declaration, version: 7 }), /unsupported version 7/);
  assert.throws(() => normalizeAmpleFileAutomationDeclaration({ ...declaration, id: "check-12345678" }), /Automation id is invalid/);
});

test("proposal files read bounded and refuse damage", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-automation-declaration-"));
  const path = join(root, `weekly-review${ampleFileAutomationProposalFileSuffix}`);
  await writeFile(path, `${JSON.stringify(proposalValue)}\n`);
  assert.deepEqual(await readAmpleFileAutomationProposal(path), normalizeAmpleFileAutomationProposal(proposalValue));

  const oversized = join(root, `oversized${ampleFileAutomationProposalFileSuffix}`);
  await writeFile(oversized, Buffer.alloc(ampleFileAutomationDocumentMaxBytes + 1, "x"));
  await assert.rejects(() => readAmpleFileAutomationProposal(oversized), /exceeds/);

  await assert.rejects(() => readAmpleFileAutomationProposal(root), /ordinary file/);

  const damaged = join(root, `damaged${ampleFileAutomationProposalFileSuffix}`);
  await writeFile(damaged, "{not-json");
  await assert.rejects(() => readAmpleFileAutomationProposal(damaged));
});

// Version 4 (docs/act-ledger.md): the closed, host-filled
// placeholder set and the `agent` step. Everything else inside `{{ }}` is a
// declaration error, and a placeholder that could never be filled in for the
// declared trigger is refused at parse — so it is refused when enabling,
// rather than discovered as an empty sentence in a message already sent.
const version4Proposal = {
  kind: "amplefile.automation-proposal",
  version: 4,
  name: "Brief handoff",
  createdBy: "assistant",
  createdAt: "2026-08-10T17:00:00Z",
  automation: {
    title: "Brief handoff",
    trigger: {
      kind: "files-changed",
      connectedFolder: manuscriptConnectedFolder,
      watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] },
      debounceSeconds: 5,
      cooldownMinutes: 1,
    },
    steps: [
      {
        id: "adopt",
        kind: "chat",
        connectedFolder: publisherConnectedFolder,
        message: "{{trigger.summary}} Adopt the newest brief.\nChanged files:\n{{ trigger.changedFiles }}",
      },
      { id: "report", kind: "agent", message: "Files the adopt step created:\n{{steps.adopt.createdFiles}}" },
    ],
  },
};

function version4(mutate: (value: any) => void): unknown {
  const clone = structuredClone(version4Proposal) as any;
  mutate(clone);
  return clone;
}

test("version 4 admits the closed placeholder set and the agent step, and refuses everything else at parse", () => {
  const normalized = normalizeAmpleFileAutomationProposal(version4Proposal);
  assert.equal(normalized.version, 4);
  assert.deepEqual(normalized.automation.steps[1], {
    id: "report",
    kind: "agent",
    message: "Files the adopt step created:\n{{steps.adopt.createdFiles}}",
  });
  // Whitespace inside the braces is tolerated and the name is normalized.
  assert.deepEqual(
    ampleFileAutomationMessagePlaceholders((normalized.automation.steps[0] as { message: string }).message).map((entry) => entry.name),
    ["trigger.summary", "trigger.changedFiles"],
  );
  assert.deepEqual(
    ampleFileAutomationMessagePlaceholders((normalized.automation.steps[1] as { message: string }).message),
    [{ name: "steps.adopt.createdFiles", step: "adopt" }],
  );
  // A agent step names no Connected Folder; the AmpleFile Agent sits above them.
  assert.deepEqual(ampleFileAutomationReferencedConnectedFolderIds(normalized.automation), [manuscriptConnectedFolder, publisherConnectedFolder].sort());

  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.automation.steps[0].message = "Do the {{foo}} thing.";
  })), /unknown placeholder \{\{foo\}\}\. The placeholders are/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.automation.steps[0].message = "{{trigger.findings}}";
  })), /unknown placeholder \{\{trigger\.findings\}\}/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.automation.trigger = { kind: "interval", intervalMinutes: 60 };
  })), /is not a folder-change trigger/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.automation.steps[0].message = "{{steps.report.createdFiles}}";
  })), /"report" is not an earlier chat step/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.automation.steps[1].message = "{{steps.report.createdFiles}}";
  })), /"report" is not an earlier chat step/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.automation.steps.splice(1, 0, {
      id: "verify",
      kind: "files",
      fromConnectedFolder: publisherConnectedFolder,
      from: { kind: "paths", paths: ["Ready/brief.md"] },
      toConnectedFolder: manuscriptConnectedFolder,
      to: "Incoming",
    });
    value.automation.steps[2].message = "{{steps.verify.createdFiles}}";
  })), /"verify" is not an earlier chat step/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.version = 3;
  })), /Agent steps require contract version 4/);

  // Versions 1-3 never scan: their messages are literal text, braces included.
  const literal = normalizeAmpleFileAutomationProposal(mutated((value) => {
    value.automation.steps[0].message = "Say {{trigger.summary}} and {{whatever}} verbatim.";
  })) as { automation: { steps: Array<{ message?: string }> } };
  assert.equal(literal.automation.steps[0]!.message, "Say {{trigger.summary}} and {{whatever}} verbatim.");
});

test("an agent-step-only automation names only the Connected Folder its trigger watches", () => {
  const ampleFileAgentStepOnly = normalizeAmpleFileAutomationProposal({
    ...version4Proposal,
    automation: {
      title: "Nightly digest",
      trigger: { kind: "files-changed", connectedFolder: collectorConnectedFolder, watch: { kind: "tree", path: "inbox", recursive: true, extensions: [".md"] }, debounceSeconds: 30, cooldownMinutes: 5 },
      steps: [{ id: "digest", kind: "agent", message: "{{trigger.summary}}" }],
    },
  });
  assert.deepEqual(ampleFileAutomationReferencedConnectedFolderIds(ampleFileAgentStepOnly.automation), [collectorConnectedFolder]);
  assert.equal(ampleFileAgentStepOnly.automation.steps.length, 1);
});

test("a stored declaration that names a retired Check or app feature is recognized without parsing anything else", () => {
  const stored = (overrides: Record<string, unknown>) => ({
    kind: "amplefile.automation",
    version: 1,
    id: "automation-12345678",
    title: "Stored",
    createdBy: "assistant",
    createdAt: "2026-08-10T17:00:00.000Z",
    trigger: { kind: "manual" },
    steps: [{ id: "notify", kind: "chat", connectedFolder: manuscriptConnectedFolder, message: "Mention {{trigger.findings}} literally." }],
    ...overrides,
  });
  assert.equal(ampleFileAutomationRetiredFeature(stored({})), null, "versions 1-3 send messages as literal text");
  assert.equal(ampleFileAutomationRetiredFeature(stored({ version: 3, steps: "damaged" })), null, "other damage is not mistaken for a retired feature");
  assert.match(ampleFileAutomationRetiredFeature(stored({
    steps: [{ id: "verify", kind: "check", connectedFolder: manuscriptConnectedFolder }],
  })) ?? "", /runs a Check/);
  assert.match(ampleFileAutomationRetiredFeature(stored({
    trigger: { kind: "on-settled", source: { kind: "check-run", connectedFolder: manuscriptConnectedFolder } },
  })) ?? "", /waits for a Check run/);
  assert.match(ampleFileAutomationRetiredFeature(stored({
    trigger: { kind: "on-settled", source: { kind: "app-automation-run", connectedFolder: manuscriptConnectedFolder, appId: "collector", appAutomationId: "collect" } },
  })) ?? "", /Connected Folder app's automation/);
  assert.match(ampleFileAutomationRetiredFeature(stored({
    trigger: { kind: "on-settled", source: "damaged" },
  })) ?? "", /no longer has that trigger/);
  assert.match(ampleFileAutomationRetiredFeature(stored({
    version: 4,
    steps: [{ id: "tell", kind: "agent", message: "{{ trigger.findings }}" }],
  })) ?? "", /trigger\.findings/);
  assert.equal(ampleFileAutomationRetiredFeature(null), null);
});

// Version 5 (docs/automations.md): a folder-change
// trigger may opt into one catch-up with `"ifMissed": "run"`. The field is
// optional and never defaulted, so every older declaration normalizes to
// exactly the shape — and the digest — it had before.
test("version 5 lets a folder-change trigger catch up, and older versions keep their exact shape", () => {
  const caughtUp = normalizeAmpleFileAutomationProposal(version4((value) => {
    value.version = 5;
    value.automation.trigger.ifMissed = "run";
  }));
  assert.equal(caughtUp.version, 5);
  assert.deepEqual(caughtUp.automation.trigger, {
    kind: "files-changed",
    connectedFolder: manuscriptConnectedFolder,
    watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] },
    debounceSeconds: 5,
    cooldownMinutes: 1,
    ifMissed: "run",
  });
  assert.equal(ampleFileAutomationTriggerCatchesUp(caughtUp.automation.trigger), true);
  // Everything version 4 admits still parses in version 5.
  assert.deepEqual(
    ampleFileAutomationMessagePlaceholders((caughtUp.automation.steps[0] as { message: string }).message).map((entry) => entry.name),
    ["trigger.summary", "trigger.changedFiles"],
  );

  const skipped = normalizeAmpleFileAutomationProposal(version4((value) => {
    value.version = 5;
    value.automation.trigger.ifMissed = "skip";
  }));
  assert.equal((skipped.automation.trigger as { ifMissed?: string }).ifMissed, "skip", "an explicit choice is kept as declared");
  assert.equal(ampleFileAutomationTriggerCatchesUp(skipped.automation.trigger), false);

  const unset = normalizeAmpleFileAutomationProposal(version4((value) => { value.version = 5; }));
  assert.equal("ifMissed" in unset.automation.trigger, false, "leaving it out keeps the fresh-baseline default");
  assert.equal(ampleFileAutomationTriggerCatchesUp(unset.automation.trigger), false);

  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.automation.trigger.ifMissed = "run";
  })), /ifMissed requires contract version 5/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.version = 3;
    value.automation.trigger.ifMissed = "skip";
  })), /ifMissed requires contract version 5/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.version = 5;
    value.automation.trigger.ifMissed = "replay";
  })), /ifMissed must be "run" or "skip"/);
  assert.throws(() => normalizeAmpleFileAutomationProposal(version4((value) => {
    value.version = 5;
    value.automation.trigger = { kind: "interval", intervalMinutes: 60, ifMissed: "run" };
    value.automation.steps = [{ id: "adopt", kind: "chat", connectedFolder: publisherConnectedFolder, message: "Adopt the brief." }];
  })), /unsupported field: ifMissed/);

  // Older versions stay valid, and a stored declaration keeps its digest:
  // nothing new appears in what they normalize to.
  const version4Declaration = declarationFromAmpleFileAutomationProposal(
    normalizeAmpleFileAutomationProposal(version4Proposal),
    "automation-version4-brief",
  );
  assert.equal("ifMissed" in version4Declaration.trigger, false);
  const reparsed = normalizeAmpleFileAutomationDeclaration(JSON.parse(JSON.stringify(version4Declaration)));
  assert.equal(ampleFileAutomationDigest(reparsed), ampleFileAutomationDigest(version4Declaration));
  const version3 = normalizeAmpleFileAutomationProposal(version4((value) => {
    value.version = 3;
    value.automation.steps = [{ id: "adopt", kind: "chat", connectedFolder: publisherConnectedFolder, message: "Adopt the brief." }];
  }));
  assert.equal(version3.version, 3);
  assert.equal("ifMissed" in version3.automation.trigger, false);
});

test("a chat or agent step may name its own model, and only as a provider and id", () => {
  const base = { kind: "amplefile.automation", version: 4, id: "automation-step-models", title: "Sort screenshots", createdBy: "assistant", createdAt: "2026-07-01T00:00:00.000Z", trigger: { kind: "manual" } };
  const parsed = normalizeAmpleFileAutomationDeclaration({ ...base, steps: [
    { id: "sort", kind: "chat", connectedFolder: "space-0000000000000001", message: "Sort.", model: { provider: " anthropic ", id: "claude-sonnet-4-5" } },
    { id: "tell", kind: "agent", message: "Done.", model: { provider: "openai", id: "gpt-5" } },
    { id: "plain", kind: "chat", connectedFolder: "space-0000000000000001", message: "Plain." },
  ] });
  assert.deepEqual(parsed.steps.map((step) => "model" in step ? step.model : undefined), [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai", id: "gpt-5" },
    undefined,
  ]);
  const withModel = (model: unknown) => normalizeAmpleFileAutomationDeclaration({ ...base, steps: [{ id: "sort", kind: "chat", connectedFolder: "space-0000000000000001", message: "Sort.", model }] });
  assert.throws(() => withModel("claude"), /model must be a JSON object/);
  assert.throws(() => withModel({ provider: "anthropic" }), /model/);
  assert.throws(() => withModel({ provider: "anthropic", id: "x", thinking: "high" }), /unsupported field: thinking/);
  assert.throws(() => withModel({ provider: "", id: "x" }), /provider/);
  assert.throws(() => withModel({ provider: "anthropic", id: "x\ny" }), /model id/);
  // An older folder-change declaration may name a model too.
  const v3 = normalizeAmpleFileAutomationDeclaration({ ...base, version: 3, steps: [{ id: "sort", kind: "chat", connectedFolder: "space-0000000000000001", message: "Sort.", model: { provider: "anthropic", id: "claude-sonnet-4-5" } }] });
  assert.deepEqual((v3.steps[0] as { model?: unknown }).model, { provider: "anthropic", id: "claude-sonnet-4-5" });
});
