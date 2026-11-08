import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  AMPLEFILE_CLI_ACT_MAX_PAYLOAD_BYTES,
  AMPLEFILE_CLI_ACT_PROTOCOL_VERSION,
  AmpleFileCliError,
  createAmpleFileCliActRequest,
  executeAmpleFileCliActRequest,
  isAmpleFileCliActRequest,
  parseAmpleFileCliActArgv,
  parseAmpleFileCliActRequest,
  parseAmpleFileCliRequestEnvelope,
  type AmpleFileActFacade,
} from "../src/local/cli/index.js";

const cwd = resolve(tmpdir());
const token = "a".repeat(64);
const createdAt = new Date().toISOString();

test("act request parsing enforces exact keys, token shape, and payload bounds", () => {
  const id = randomUUID();
  const parsed = parseAmpleFileCliActRequest({
    protocolVersion: 3,
    lane: "act",
    id,
    argv: ["chat", "status", "--connected-folder", "connected-folder-1"],
    cwd,
    createdAt,
    actToken: token,
    payload: { messageFile: "hello" },
  });
  assert.equal(parsed.protocolVersion, AMPLEFILE_CLI_ACT_PROTOCOL_VERSION);
  assert.equal(parsed.id, id);
  assert.equal(parsed.payload?.messageFile, "hello");

  const base = { protocolVersion: 3, lane: "act", id: randomUUID(), argv: [], cwd, createdAt, actToken: token };
  assert.throws(() => parseAmpleFileCliActRequest({ ...base, extra: true }), /unsupported field: extra/);
  assert.throws(() => parseAmpleFileCliActRequest({ ...base, lane: "read" }), /lane/);
  assert.throws(() => parseAmpleFileCliActRequest({ ...base, actToken: "short" }), /token is malformed/);
  assert.throws(() => parseAmpleFileCliActRequest({ ...base, actToken: `${token}!` }), /token is malformed/);
  assert.throws(() => parseAmpleFileCliActRequest({ ...base, cwd: "relative/path" }), /absolute path/);
  assert.throws(() => parseAmpleFileCliActRequest({ ...base, createdAt: "not-a-date" }), /ISO timestamp/);
  assert.throws(() => parseAmpleFileCliActRequest({ ...base, payload: { other: 1 } }), /unsupported field: other/);
  assert.throws(
    () => parseAmpleFileCliActRequest({ ...base, payload: { messageFile: 42 } }),
    /messageFile must be text/,
  );

  const boundary = "y".repeat(AMPLEFILE_CLI_ACT_MAX_PAYLOAD_BYTES);
  assert.equal(
    parseAmpleFileCliActRequest({ ...base, id: randomUUID(), payload: { messageFile: boundary } }).payload?.messageFile,
    boundary,
  );
  assert.throws(
    () => parseAmpleFileCliActRequest({ ...base, payload: { messageFile: `${boundary}z` } }),
    /exceeds/,
  );
});

test("the request envelope dispatches versions to their lanes", () => {
  const v1 = parseAmpleFileCliRequestEnvelope({
    protocolVersion: 1,
    id: randomUUID(),
    argv: ["context"],
    cwd,
    createdAt,
  });
  assert.equal(v1.protocolVersion, 1);
  assert.equal(isAmpleFileCliActRequest(v1), false);

  const act = parseAmpleFileCliRequestEnvelope({
    protocolVersion: 3,
    lane: "act",
    id: randomUUID(),
    argv: ["chat", "create", "--connected-folder", "connected-folder-1"],
    cwd,
    createdAt,
    actToken: token,
  });
  assert.equal(isAmpleFileCliActRequest(act), true);

  assert.throws(
    () => parseAmpleFileCliRequestEnvelope({ protocolVersion: 4, id: randomUUID(), argv: [], cwd, createdAt }),
    /Unsupported CLI protocol version/,
  );
});

test("createAmpleFileCliActRequest validates and normalizes like the parser", () => {
  const id = randomUUID();
  const request = createAmpleFileCliActRequest({
    id: id.toUpperCase(),
    argv: ["connected-folders", "create", "--name", "Home"],
    cwd: join(cwd, "."),
    actToken: token,
  });
  assert.equal(request.id, id.toLowerCase());
  assert.equal(request.cwd, cwd);
  assert.equal(request.lane, "act");
});

test("act command parsing rejects misplaced repeatable and duplicate boolean flags", () => {
  assert.throws(
    () => parseAmpleFileCliActArgv(["agent", "list", "--from", "ignored.txt"]),
    /--from cannot be used with 'agent list'/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["chat", "send", "--connected-folder", "connected-folder-1", "--new", "--new", "--message", "hello"]),
    /--new may be provided only once/,
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["files", "add", "--connected-folder", "connected-folder-1", "--from", "one", "--from", "two"]),
    { name: "files.add", output: "human", connectedFolder: "connected-folder-1", fromPaths: ["one", "two"] },
  );
});

test("experimental Checks act commands require explicit Connected Folders and strict command-specific options", () => {
  assert.deepEqual(
    parseAmpleFileCliActArgv(["checks", "enable", "--connected-folder", "connected-folder-1", "--proposal", "proposals/tax.check.json"]),
    {
      name: "checks.enable",
      output: "human",
      connectedFolder: "connected-folder-1",
      proposalPath: "proposals/tax.check.json",
    },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["checks", "disable", "--connected-folder", "connected-folder-1", "--check", "check-tax"]),
    { name: "checks.disable", output: "human", connectedFolder: "connected-folder-1", check: "check-tax" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["checks", "run", "--connected-folder", "connected-folder-1"]),
    { name: "checks.run", output: "human", connectedFolder: "connected-folder-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["checks", "run", "--connected-folder", "connected-folder-1", "--check", "check-tax"]),
    { name: "checks.run", output: "human", connectedFolder: "connected-folder-1", check: "check-tax" },
  );
  for (const command of ["task", "result", "abort"] as const) {
    assert.deepEqual(
      parseAmpleFileCliActArgv(["checks", command, "--connected-folder", "connected-folder-1", "--task", "check-task-1"]),
      { name: `checks.${command}`, output: "human", connectedFolder: "connected-folder-1", task: "check-task-1" },
    );
  }
  assert.deepEqual(
    parseAmpleFileCliActArgv(["checks", "problems", "--connected-folder", "connected-folder-1", "--check", "check-tax", "--json"]),
    { name: "checks.problems", output: "json", connectedFolder: "connected-folder-1", check: "check-tax" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv([
      "checks",
      "decide",
      "--connected-folder",
      "connected-folder-1",
      "--finding",
      "finding-1",
      "--decision",
      "defer",
      "--until",
      "2026-08-03T10:30:00-04:00",
    ]),
    {
      name: "checks.decide",
      output: "human",
      connectedFolder: "connected-folder-1",
      finding: "finding-1",
      decision: "defer",
      until: "2026-08-03T14:30:00.000Z",
    },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv([
      "checks",
      "decide",
      "--connected-folder",
      "connected-folder-1",
      "--finding",
      "finding-1",
      "--decision",
      "resolve",
    ]),
    {
      name: "checks.decide",
      output: "human",
      connectedFolder: "connected-folder-1",
      finding: "finding-1",
      decision: "resolve",
    },
  );

  for (const argv of [
    ["checks", "enable", "--proposal", "proposal.json"],
    ["checks", "disable", "--check", "check-1"],
    ["checks", "run"],
    ["checks", "task", "--task", "task-1"],
    ["checks", "result", "--task", "task-1"],
    ["checks", "abort", "--task", "task-1"],
    ["checks", "problems"],
    ["checks", "decide", "--finding", "finding-1", "--decision", "accept"],
  ]) {
    assert.throws(() => parseAmpleFileCliActArgv(argv), /explicit --connected-folder/);
  }
  assert.throws(
    () => parseAmpleFileCliActArgv(["checks", "wait", "--connected-folder", "connected-folder-1", "--task", "task-1"]),
    /runs inside the AmpleFile shim/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["checks", "decide", "--connected-folder", "connected-folder-1", "--finding", "f", "--decision", "maybe"]),
    /must be accept, reject, resolve, or defer/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["checks", "decide", "--connected-folder", "connected-folder-1", "--finding", "f", "--decision", "defer"]),
    /requires --until/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["checks", "decide", "--connected-folder", "connected-folder-1", "--finding", "f", "--decision", "accept", "--until", createdAt]),
    /only with --decision defer/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["checks", "decide", "--connected-folder", "connected-folder-1", "--finding", "f", "--decision", "defer", "--until", "tomorrow"]),
    /must be an ISO timestamp/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["checks", "run", "--connected-folder", "connected-folder-1", "--proposal", "proposal.json"]),
    /--proposal cannot be used/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["connected-folders", "create", "--name", "Home", "--check", "check-1"]),
    /--check cannot be used/,
  );
});

test("Checks act execution bounds and terminal-scrubs structured and human output", async () => {
  const findings = Array.from({ length: 105 }, (_, index) => ({
    id: `finding-${index}`,
    fingerprint: `fingerprint-${index}`,
    checkId: "check-tax",
    declarationDigest: "d".repeat(64),
    sensorId: "path.exists",
    sensorRevision: 1,
    severity: "warning" as const,
    observedAt: createdAt,
    status: "active" as const,
    title: `Missing\u001b receipt ${index}`,
    targetPath: `receipts/${index}.pdf`,
    evidence: [{
      kind: "path-state" as const,
      path: `receipts/${index}.pdf`,
      expected: "file" as const,
      observed: "missing" as const,
      identity: { checkId: "check-tax", path: `receipts/${index}.pdf`, state: "missing" as const },
    }],
  }));
  const calls: unknown[] = [];
  const facade = {
    checksProblems: async (input: unknown) => {
      calls.push(input);
      return {
        connectedFolder: { id: "connected-folder-1", name: "Taxes", connectedFolderRoot: "/tmp/taxes" },
        checkId: "check-tax",
        findings,
        invalidated: 2,
        truncated: true,
        healthErrors: Array.from({ length: 22 }, (_, index) => `Health\u202e error ${index}`),
      };
    },
    checksTask: async (input: unknown) => {
      calls.push(input);
      return {
        connectedFolder: { id: "connected-folder-1", name: "Taxes", connectedFolderRoot: "/tmp/taxes" },
        task: {
          taskId: "check-task-1",
          runId: "check-run-1",
          state: "failed" as const,
          startedAt: createdAt,
          endedAt: createdAt,
          error: "Provider\u001b failed",
        },
      };
    },
  } as unknown as AmpleFileActFacade;
  const outcomes: string[] = [];
  const execute = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          outcomes.push(record.outcome);
          return true;
        },
      },
    },
  );

  const response = await execute(["checks", "problems", "--connected-folder", "connected-folder-1", "--check", "check-tax", "--json"]);
  assert.equal(response.exitCode, 0);
  const json = JSON.parse(response.stdout) as {
    data: {
      findings: Array<{ title: string }>;
      findingCount: number;
      findingsReturned: number;
      findingsTruncated: boolean;
      sourceTruncated: boolean;
      healthErrors: string[];
      healthErrorCount: number;
      healthErrorsTruncated: boolean;
    };
  };
  // Every finding and health error comes back; only the source's own flag says the store stopped early.
  assert.equal(json.data.findingCount, 105);
  assert.equal(json.data.findingsReturned, 105);
  assert.equal(json.data.findingsTruncated, true);
  assert.equal(json.data.sourceTruncated, true);
  assert.equal(json.data.healthErrorCount, 22);
  assert.equal(json.data.healthErrors.length, 22);
  assert.equal(json.data.healthErrorsTruncated, false);
  assert.equal(json.data.findings[0]?.title, "Missing� receipt 0");
  assert.equal(json.data.healthErrors[0], "Health� error 0");
  assert.deepEqual(calls[0], { connectedFolder: "connected-folder-1", checkId: "check-tax" });

  const human = await execute(["checks", "task", "--connected-folder", "connected-folder-1", "--task", "check-task-1"]);
  assert.match(human.stdout, /Provider� failed/);
  assert.doesNotMatch(human.stdout, /\u001b/);
  assert.deepEqual(calls[1], { connectedFolder: "connected-folder-1", taskId: "check-task-1" });
  assert.deepEqual(outcomes, ["accepted", "ok", "accepted", "ok"]);
});

test("ledger Chat, History, file, search, and Connected Folder commands parse with strict shapes", () => {
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "rename", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--title", "Weekly plan"]),
    { name: "chat.rename", output: "human", connectedFolder: "connected-folder-1", conversation: "conv-1", title: "Weekly plan" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "snooze", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--until", "2026-08-11T09:00:00-04:00"]),
    { name: "chat.snooze", output: "human", connectedFolder: "connected-folder-1", conversation: "conv-1", until: "2026-08-11T13:00:00.000Z" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "archive", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--parent-task", "task-9"]),
    { name: "chat.archive", output: "human", connectedFolder: "connected-folder-1", conversation: "conv-1", parentTaskId: "task-9" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "resume", "--connected-folder", "connected-folder-1", "--conversation", "conv-1"]),
    { name: "chat.resume", output: "human", connectedFolder: "connected-folder-1", conversation: "conv-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "compact", "--connected-folder", "connected-folder-1", "--conversation", "conv-1"]),
    { name: "chat.compact", output: "human", connectedFolder: "connected-folder-1", conversation: "conv-1" },
  );

  assert.deepEqual(
    parseAmpleFileCliActArgv(["history", "list", "--connected-folder", "connected-folder-1"]),
    { name: "history.list", output: "human", connectedFolder: "connected-folder-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["history", "save", "--connected-folder", "connected-folder-1", "--label", "before cleanup"]),
    { name: "history.save", output: "human", connectedFolder: "connected-folder-1", label: "before cleanup" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["history", "save", "--connected-folder", "connected-folder-1"]),
    { name: "history.save", output: "human", connectedFolder: "connected-folder-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["history", "restore", "--connected-folder", "connected-folder-1", "--checkpoint", "chk-1"]),
    { name: "history.restore", output: "human", connectedFolder: "connected-folder-1", checkpoint: "chk-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["history", "versions", "--connected-folder", "connected-folder-1", "--path", "docs/plan.md"]),
    { name: "history.versions", output: "human", connectedFolder: "connected-folder-1", path: "docs/plan.md" },
  );
  const versionHash = "b".repeat(64);
  assert.deepEqual(
    parseAmpleFileCliActArgv(["history", "restore-file", "--connected-folder", "connected-folder-1", "--path", "docs/plan.md", "--version", versionHash]),
    { name: "history.restore-file", output: "human", connectedFolder: "connected-folder-1", path: "docs/plan.md", version: versionHash },
  );

  assert.deepEqual(
    parseAmpleFileCliActArgv(["files", "move", "--connected-folder", "connected-folder-1", "--from", "docs/plan.md", "--to", "archive"]),
    { name: "files.move", output: "human", connectedFolder: "connected-folder-1", fromPaths: ["docs/plan.md"], toDir: "archive" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["files", "rename", "--connected-folder", "connected-folder-1", "--path", "docs/plan.md", "--name", "plan-2026.md"]),
    { name: "files.rename", output: "human", connectedFolder: "connected-folder-1", path: "docs/plan.md", entryName: "plan-2026.md" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["files", "delete", "--connected-folder", "connected-folder-1", "--path", "docs/old.md"]),
    { name: "files.delete", output: "human", connectedFolder: "connected-folder-1", path: "docs/old.md" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["files", "mkdir", "--connected-folder", "connected-folder-1", "--path", "notes"]),
    { name: "files.mkdir", output: "human", connectedFolder: "connected-folder-1", path: "notes" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["files", "create", "--connected-folder", "connected-folder-1", "--path", "notes/todo.md"]),
    { name: "files.create", output: "human", connectedFolder: "connected-folder-1", path: "notes/todo.md" },
  );

  assert.deepEqual(
    parseAmpleFileCliActArgv(["search", "--connected-folder", "connected-folder-1", "--query", "tax receipts", "--scope", "files", "--json"]),
    { name: "search", output: "json", connectedFolder: "connected-folder-1", query: "tax receipts", searchScope: "files" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["search", "--connected-folder", "connected-folder-1", "--query", "tax receipts"]),
    { name: "search", output: "human", connectedFolder: "connected-folder-1", query: "tax receipts" },
  );

  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "rename", "--connected-folder", "connected-folder-1", "--name", "Home files"]),
    { name: "connected-folders.rename", output: "human", connectedFolder: "connected-folder-1", connectedFolderName: "Home files" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "unregister", "--connected-folder", "connected-folder-1"]),
    { name: "connected-folders.unregister", output: "human", connectedFolder: "connected-folder-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "delete", "--connected-folder", "connected-folder-1"]),
    { name: "connected-folders.delete", output: "human", connectedFolder: "connected-folder-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "appearance", "apply", "--connected-folder", "connected-folder-1", "--proposal", "proposals/appearance.json"]),
    { name: "connected-folders.appearance.apply", output: "human", connectedFolder: "connected-folder-1", proposalPath: "proposals/appearance.json" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "appearance", "reset", "--connected-folder", "connected-folder-1"]),
    { name: "connected-folders.appearance.reset", output: "human", connectedFolder: "connected-folder-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "appearance", "undo", "--connected-folder", "connected-folder-1"]),
    { name: "connected-folders.appearance.undo", output: "human", connectedFolder: "connected-folder-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "worker", "show", "--connected-folder", "connected-folder-1"]),
    { name: "connected-folders.worker.show", output: "human", connectedFolder: "connected-folder-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "worker", "model", "--connected-folder", "connected-folder-1", "--provider", "openrouter", "--model", "example/model"]),
    { name: "connected-folders.worker.model", output: "human", connectedFolder: "connected-folder-1", provider: "openrouter", model: "example/model" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "worker", "instructions", "--connected-folder", "connected-folder-1", "--instructions", "Keep it concise.", "--parent-task", "task-9"]),
    { name: "connected-folders.worker.instructions", output: "human", connectedFolder: "connected-folder-1", instructions: "Keep it concise.", parentTaskId: "task-9" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "worker", "instructions", "--connected-folder", "connected-folder-1", "--clear"]),
    { name: "connected-folders.worker.instructions", output: "human", connectedFolder: "connected-folder-1", instructions: "", clear: true },
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["connected-folders", "worker", "instructions", "--connected-folder", "connected-folder-1", "--instructions", "x", "--clear"]),
    /exactly one of --instructions .* or --clear/,
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["connected-folders", "worker", "instructions", "--connected-folder", "connected-folder-1", "--append", "Dates are YYYY-MM-DD."]),
    { name: "connected-folders.worker.instructions", output: "human", connectedFolder: "connected-folder-1", instructions: "Dates are YYYY-MM-DD.", appendInstructions: true },
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["connected-folders", "worker", "instructions", "--connected-folder", "connected-folder-1", "--append", "x", "--instructions", "y"]),
    /exactly one of --instructions .* --append <text>, or --clear/,
  );
});

test("ledger tools and apps commands parse with strict shapes", () => {
  assert.deepEqual(
    parseAmpleFileCliActArgv(["tools", "import-skill", "--scope", "connected-folder", "--connected-folder", "connected-folder-1", "--from", "bundles/skill"]),
    { name: "tools.import-skill", output: "human", toolsScope: "connected-folder", connectedFolder: "connected-folder-1", fromPaths: ["bundles/skill"] },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["tools", "import-skill", "--scope", "everywhere", "--from", "bundles/skill"]),
    { name: "tools.import-skill", output: "human", toolsScope: "everywhere", fromPaths: ["bundles/skill"] },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["tools", "install", "--id", "catalog-1", "--scope", "everywhere"]),
    { name: "tools.install", output: "human", toolsScope: "everywhere", catalogId: "catalog-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["tools", "install", "--source", "npm:example-pkg", "--scope", "connected-folder", "--connected-folder", "connected-folder-1"]),
    { name: "tools.install", output: "human", toolsScope: "connected-folder", connectedFolder: "connected-folder-1", source: "npm:example-pkg" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["tools", "update", "--source", "npm:example-pkg", "--scope", "everywhere"]),
    { name: "tools.update", output: "human", toolsScope: "everywhere", source: "npm:example-pkg" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["tools", "remove", "--source", "npm:example-pkg", "--scope", "connected-folder", "--connected-folder", "connected-folder-1"]),
    { name: "tools.remove", output: "human", toolsScope: "connected-folder", connectedFolder: "connected-folder-1", source: "npm:example-pkg" },
  );

  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "list", "--connected-folder", "connected-folder-1"]),
    { name: "apps.list", output: "human", connectedFolder: "connected-folder-1" },
  );
  // --input carries JSON, so it deliberately escapes the control-character
  // rule every other bounded flag keeps; the app's runtime validates the value.
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "invoke", "--connected-folder", "connected-folder-1", "--app", "app-1", "--tool", "summarize", "--input", "{\n  \"text\": \"North\"\n}", "--parent-task", "task-1"]),
    { name: "apps.invoke", output: "human", connectedFolder: "connected-folder-1", app: "app-1", tool: "summarize", toolInput: { text: "North" }, parentTaskId: "task-1" },
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["apps", "invoke", "--connected-folder", "connected-folder-1", "--app", "app-1", "--tool", "summarize"]),
    /Provide --input <json>/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["apps", "invoke", "--connected-folder", "connected-folder-1", "--app", "app-1", "--tool", "summarize", "--input", "{not json"]),
    /--input must be valid JSON/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["apps", "invoke", "--connected-folder", "connected-folder-1", "--app", "app-1", "--tool", "summarize", "--input", JSON.stringify({ text: "x".repeat(16 * 1024 * 1024) })]),
    /--input must be at most 16777216 bytes/,
  );
  assert.throws(() => parseAmpleFileCliActArgv(["apps", "list", "--connected-folder", "connected-folder-1", "--app", "app-1"]), /--app/);
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "proposals", "list", "--connected-folder", "connected-folder-1", "--conversation", "conv-1"]),
    { name: "apps.proposals.list", output: "human", connectedFolder: "connected-folder-1", conversation: "conv-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "proposals", "dismiss", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--proposal", "proposal-1"]),
    { name: "apps.proposals.dismiss", output: "human", connectedFolder: "connected-folder-1", conversation: "conv-1", proposal: "proposal-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "install-proposal", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--proposal", "proposal-1"]),
    { name: "apps.install-proposal", output: "human", connectedFolder: "connected-folder-1", conversation: "conv-1", proposal: "proposal-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "install-preview", "--connected-folder", "connected-folder-1", "--package", "apps/preview"]),
    { name: "apps.install-preview", output: "human", connectedFolder: "connected-folder-1", packagePath: "apps/preview" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "remove", "--connected-folder", "connected-folder-1", "--app", "app-1"]),
    { name: "apps.remove", output: "human", connectedFolder: "connected-folder-1", app: "app-1" },
  );
  const digest = "c".repeat(64);
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "grant", "--connected-folder", "connected-folder-1", "--app", "app-1", "--digest", digest, "--kind", "network", "--declaration", "decl-1"]),
    { name: "apps.grant", output: "human", connectedFolder: "connected-folder-1", app: "app-1", digest, grantKind: "network", declaration: "decl-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "revoke", "--connected-folder", "connected-folder-1", "--app", "app-1", "--digest", digest, "--kind", "files", "--declaration", "decl-2"]),
    { name: "apps.revoke", output: "human", connectedFolder: "connected-folder-1", app: "app-1", digest, grantKind: "files", declaration: "decl-2" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "connect", "--connected-folder", "connected-folder-1", "--app", "app-1", "--destination", "dest-1"]),
    { name: "apps.connect", output: "human", connectedFolder: "connected-folder-1", app: "app-1", destination: "dest-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "disconnect", "--connected-folder", "connected-folder-1", "--app", "app-1", "--destination", "dest-1"]),
    { name: "apps.disconnect", output: "human", connectedFolder: "connected-folder-1", app: "app-1", destination: "dest-1" },
  );
  for (const [verb, name] of [
    ["enable", "apps.automation.enable"],
    ["disable", "apps.automation.disable"],
    ["run", "apps.automation.run"],
  ] as const) {
    assert.deepEqual(
      parseAmpleFileCliActArgv(["apps", "automation", verb, "--connected-folder", "connected-folder-1", "--app", "app-1", "--automation", "job-1"]),
      { name, output: "human", connectedFolder: "connected-folder-1", app: "app-1", automation: "job-1" },
    );
  }
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "storage", "clear", "--connected-folder", "connected-folder-1", "--app", "app-1"]),
    { name: "apps.storage.clear", output: "human", connectedFolder: "connected-folder-1", app: "app-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "retained", "purge", "--connected-folder", "connected-folder-1", "--retained", "retained-1"]),
    { name: "apps.retained.purge", output: "human", connectedFolder: "connected-folder-1", retained: "retained-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "project", "declare", "--connected-folder", "connected-folder-1", "--presentation", "studio/presentation.json"]),
    { name: "apps.project.declare", output: "human", connectedFolder: "connected-folder-1", presentationPath: "studio/presentation.json" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "release", "prepare", "--connected-folder", "connected-folder-1", "--version", "1.2"]),
    { name: "apps.release.prepare", output: "human", connectedFolder: "connected-folder-1", version: "1.2" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "release", "publish", "--connected-folder", "connected-folder-1", "--release", digest]),
    { name: "apps.release.publish", output: "human", connectedFolder: "connected-folder-1", release: digest },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "release", "delete", "--connected-folder", "connected-folder-1", "--release", digest]),
    { name: "apps.release.delete", output: "human", connectedFolder: "connected-folder-1", release: digest },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "install", "prepare", "--connected-folder", "connected-folder-1", "--release", digest, "--target-connected-folder", "connected-folder-2"]),
    { name: "apps.install.prepare", output: "human", connectedFolder: "connected-folder-1", release: digest, targetConnectedFolder: "connected-folder-2" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "update", "prepare", "--connected-folder", "connected-folder-1", "--instance", "instance-1", "--release", digest]),
    { name: "apps.update.prepare", output: "human", connectedFolder: "connected-folder-1", instance: "instance-1", release: digest },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "operation", "activate", "--connected-folder", "connected-folder-1", "--operation", "op-1"]),
    { name: "apps.operation.activate", output: "human", connectedFolder: "connected-folder-1", operation: "op-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "operation", "cancel", "--connected-folder", "connected-folder-1", "--operation", "op-1"]),
    { name: "apps.operation.cancel", output: "human", connectedFolder: "connected-folder-1", operation: "op-1" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "uninstall", "--connected-folder", "connected-folder-1", "--instance", "instance-1", "--retain-data"]),
    { name: "apps.uninstall", output: "human", connectedFolder: "connected-folder-1", instance: "instance-1", disposition: "retain-data" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["apps", "uninstall", "--connected-folder", "connected-folder-1", "--instance", "instance-1", "--purge-data"]),
    { name: "apps.uninstall", output: "human", connectedFolder: "connected-folder-1", instance: "instance-1", disposition: "purge-data" },
  );
});

test("ledger command flag validation refuses malformed and misplaced shapes", () => {
  assert.throws(
    () => parseAmpleFileCliActArgv(["chat", "snooze", "--connected-folder", "s", "--conversation", "c", "--until", "tomorrow"]),
    /--until must be an ISO timestamp/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["chat", "snooze", "--connected-folder", "s", "--conversation", "c"]),
    /Provide --until <ISO-timestamp>/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["search", "--connected-folder", "s", "--query", "q", "--scope", "everything"]),
    /--scope must be files, chats, or all/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["search", "--connected-folder", "s", "--query", "q".repeat(64 * 1024 + 1)]),
    /--query must be at most 65536 characters/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["files", "move", "--connected-folder", "s", "--from", "a", "--from", "b", "--to", "dir"]),
    /exactly one --from/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["files", "move", "--connected-folder", "s", "--from", "a"]),
    /Provide --to <folder-in-connected-folder>/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["files", "delete", "--connected-folder", "s", "--path", "a", "--path", "b"]),
    /--path may be provided only once/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["tools", "install", "--id", "cat-1", "--source", "npm:pkg", "--scope", "everywhere"]),
    /exactly one of --id <catalog-id> or --source <package-source>/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["tools", "install", "--scope", "everywhere"]),
    /exactly one of --id <catalog-id> or --source <package-source>/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["tools", "import-skill", "--scope", "connected-folder", "--from", "bundle"]),
    /--scope connected-folder requires an explicit --connected-folder/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["tools", "import-skill", "--scope", "everywhere", "--connected-folder", "s", "--from", "bundle"]),
    /--connected-folder cannot be used with --scope everywhere/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["tools", "update", "--source", "npm:pkg", "--scope", "global"]),
    /--scope must be everywhere or Connected Folder/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["apps", "grant", "--connected-folder", "s", "--app", "a", "--digest", "d", "--kind", "everything", "--declaration", "x"]),
    /--kind must be network, files, or notifications/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["apps", "uninstall", "--connected-folder", "s", "--instance", "i"]),
    /never defaulted/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["apps", "uninstall", "--connected-folder", "s", "--instance", "i", "--retain-data", "--purge-data"]),
    /never defaulted/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["connected-folders", "rename", "--connected-folder", "s", "--name", "bad\u0007name"]),
    /--name contains unsupported control characters/,
  );

  // New flags stay fenced off the shipped commands, and vice versa.
  assert.throws(
    () => parseAmpleFileCliActArgv(["chat", "create", "--connected-folder", "s", "--title", "x"]),
    /--title cannot be used with 'chat create'/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["connected-folders", "create", "--name", "Home", "--release", "digest"]),
    /--release cannot be used with 'connected-folders create'/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["chat", "rename", "--connected-folder", "s", "--conversation", "c", "--title", "t", "--check", "x"]),
    /--check cannot be used with 'chat rename'/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["files", "mkdir", "--connected-folder", "s", "--path", "dir", "--message", "x"]),
    /--message cannot be used with 'files mkdir'/,
  );

  // Content-bearing act reads carry no management lineage.
  assert.throws(
    () => parseAmpleFileCliActArgv(["history", "list", "--connected-folder", "s", "--parent-task", "task-1"]),
    /--parent-task cannot be used with 'history list'/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["search", "--connected-folder", "s", "--query", "q", "--parent-task", "task-1"]),
    /--parent-task cannot be used with 'search'/,
  );

  // Connected Folder–scoped writes still require explicit selection.
  for (const argv of [
    ["connected-folders", "delete"],
    ["history", "restore", "--checkpoint", "chk-1"],
    ["chat", "rename", "--conversation", "c", "--title", "t"],
  ]) {
    assert.throws(() => parseAmpleFileCliActArgv(argv), /explicit --connected-folder/);
  }
});

test("setup-only authority families are refused at parse time", () => {
  const refusals: Array<[string[], RegExp]> = [
    [["token", "mint"], /Act-token machinery/],
    [["tokens", "rotate"], /Act-token machinery/],
    [["provider", "set-key"], /Provider credentials/],
    [["providers", "remove"], /Provider credentials/],
    [["credentials", "remove"], /Provider credentials/],
    [["settings", "assistant"], /Settings administration/],
    [["--json", "token", "mint"], /Act-token machinery/],
  ];
  for (const [argv, category] of refusals) {
    assert.throws(
      () => parseAmpleFileCliActArgv(argv),
      (error: unknown) =>
        error instanceof AmpleFileCliError
        && error.code === "permissionDenied"
        && category.test(error.message)
        && /local setup only/.test(error.message)
        && /cannot perform it/.test(error.message),
      `expected setup-only refusal for '${argv.join(" ")}'`,
    );
  }

  // Web Access is gone: its former family words are ordinary unknown commands.
  for (const argv of [["remote", "disable"], ["browsers", "approve"], ["browser", "revoke"], ["pairing", "approve"]]) {
    assert.throws(
      () => parseAmpleFileCliActArgv(argv),
      (error: unknown) => error instanceof AmpleFileCliError && error.code !== "permissionDenied" && /Unknown command/.test(error.message),
      `expected an ordinary unknown command for '${argv.join(" ")}'`,
    );
  }

  // Setup-only family words remain usable as ordinary flag values.
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chats", "list", "--connected-folder", "settings"]),
    { name: "chats.list", output: "human", connectedFolder: "settings" },
  );
});

test("direct verbs parse with strict shapes", () => {
  assert.deepEqual(
    parseAmpleFileCliActArgv(["automations", "enable", "--proposal", "fold/weekly.amplefile-automation.json"]),
    { name: "automations.enable", output: "human", proposalPath: "fold/weekly.amplefile-automation.json" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["automations", "enable", "--proposal", "weekly.json", "--parent-task", "task-1"]),
    { name: "automations.enable", output: "human", proposalPath: "weekly.json", parentTaskId: "task-1" },
  );
  // Automations are above Connected Folders, like the manage group.
  assert.throws(
    () => parseAmpleFileCliActArgv(["automations", "enable", "--proposal", "weekly.json", "--connected-folder", "connected-folder-1"]),
    /--connected-folder cannot be used with 'automations enable'/,
  );

  // Recently deleted sits above Connected Folders too (docs/receipts-not-gates.md, F20):
  // each item names the Connected Folder it came from, so neither verb takes --connected-folder
  assert.deepEqual(parseAmpleFileCliActArgv(["recently-deleted", "list", "--json"]), { name: "recently-deleted.list", output: "json" });
  assert.deepEqual(
    parseAmpleFileCliActArgv(["recently-deleted", "restore", "--entry", "trash-20260910083000-53db781d"]),
    { name: "recently-deleted.restore", output: "human", entry: "trash-20260910083000-53db781d" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["recently-deleted", "restore", "--entry", "trash-20260910083000-53db781d", "--to", "/tmp/copy.json", "--parent-task", "task-4"]),
    {
      name: "recently-deleted.restore",
      output: "human",
      entry: "trash-20260910083000-53db781d",
      toPath: "/tmp/copy.json",
      parentTaskId: "task-4",
    },
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["recently-deleted", "list", "--connected-folder", "connected-folder-1"]),
    /--connected-folder cannot be used with 'recently-deleted list'/,
  );
  assert.throws(
    () => parseAmpleFileCliActArgv(["recently-deleted", "restore", "--connected-folder", "connected-folder-1", "--entry", "trash-20260910083000-53db781d"]),
    /--connected-folder cannot be used with 'recently-deleted restore'/,
  );
  assert.throws(() => parseAmpleFileCliActArgv(["recently-deleted", "restore"]), /--entry/);
  assert.throws(
    () => parseAmpleFileCliActArgv(["recently-deleted", "list", "--parent-task", "task-1"]),
    /--parent-task cannot be used with 'recently-deleted list'/,
  );

  // The pending-decision family, permanent deletion, the retired holding
  // spellings of the automation and outward-exposure verbs, the retired
  // desktop-served sharing verbs, and the pages family (removed 2026-11-07) are
  // gone from the vocabulary (docs/receipts-not-gates.md, F19/F20): unknown
  // commands, not refusals with a story.
  for (const argv of [
    ["staged", "list"], ["staged", "show"], ["staged", "cancel"],
    ["automations", "stage"], ["pages", "stage"],
    ["pages", "share"], ["pages", "share-app"], ["pages", "status"],
    ["pages", "revoke"], ["pages", "narrow"], ["pages", "widen"], ["pages", "snapshot-off"],
    ["pages", "validate"], ["pages", "publish"], ["pages", "unpublish"], ["pages", "list"],
  ]) {
    assert.throws(() => parseAmpleFileCliActArgv(argv), /Unknown command/, `expected an unknown command for '${argv.join(" ")}'`);
  }
  assert.throws(
    () => parseAmpleFileCliActArgv(["files", "destroy"]),
    /Unknown command: files destroy/,
  );
});

test("formerly gated verbs execute through the facade and receipt without a decision id", async () => {
  const connectedFolderRef = { id: "connected-folder-1", name: "Fold Connected Folder", connectedFolderRoot: "/tmp/fold" };
  const appRef = { connectedFolderId: "connected-folder-1", appId: "quote-board", featureInstallationId: "feature-installation-1", digest: "f".repeat(64), title: "Quote board", version: "0.9.0" };
  const calls: Array<{ method: string; input?: unknown }> = [];
  let automationsEnableAlready = false;
  const facade = {
    connectedFoldersDelete: async (input: unknown) => {
      calls.push({ method: "connectedFoldersDelete", input });
      return { connectedFolder: connectedFolderRef, storage: "managed", removed: true, cleanupPending: true };
    },
    toolsInstall: async (input: unknown) => {
      calls.push({ method: "toolsInstall", input });
      return {
        scope: "everywhere",
        source: "npm:@demo/toolkit@1.2.3",
        packageId: "npm:@demo/toolkit",
        version: "1.2.3",
        resourceSummary: "1 skill(s), 1 extension(s) — executable Pi capability",
        installed: true,
      };
    },
    toolsImportSkill: async (input: unknown) => {
      calls.push({ method: "toolsImportSkill", input });
      return { scope: "connected-folder", connectedFolder: connectedFolderRef, source: "/tmp/notes.skill", contentDigest: "c".repeat(64), skillNames: ["notes", "todo"], bundlePath: "/tmp/fold/.pi/skills/notes.skill" };
    },
    appsUninstallPurge: async (input: unknown) => {
      calls.push({ method: "appsUninstallPurge", input });
      return { connectedFolder: connectedFolderRef, runtimeInstanceId: "runtime-instance_1", purgedNamespaceIds: ["data-namespace_1"], removed: true, cleanupPending: false };
    },
    appsGrant: async (input: unknown) => {
      calls.push({ method: "appsGrant", input });
      return { connectedFolder: connectedFolderRef, appId: "quote-board", grantKind: "files", declaration: "exports", granted: true, root: "." };
    },
    appsStorageClear: async (input: unknown) => {
      calls.push({ method: "appsStorageClear", input });
      return { connectedFolder: connectedFolderRef, appId: "quote-board", clearedBytes: 2048, remainingBytes: 0 };
    },
    automationsEnable: async (input: unknown) => {
      calls.push({ method: "automationsEnable", input });
      return {
        automationId: "automation-weekly",
        declarationDigest: "e".repeat(64),
        title: "Weekly glue",
        referencedConnectedFolderIds: ["connected-folder-1"],
        health: "enabled",
        enabledAt: "2026-09-01T12:00:00.000Z",
        alreadyEnabled: automationsEnableAlready,
        stoppedRunId: null,
      };
    },
    appsInstallPreview: async (input: unknown) => {
      calls.push({ method: "appsInstallPreview", input });
      return {
        connectedFolder: connectedFolderRef,
        proposalId: "proposal-1",
        digest: "f".repeat(64),
        title: "Quote board",
        packageName: "quote-board",
        version: "0.9.0",
        replacesInstalled: true,
        app: appRef,
        granted: { destinations: 2, wholeConnectedFolderFolders: 1, notifications: 0, checks: 0, automations: 1 },
        needs: { connections: ["crm"], files: ["ledger"], checks: ["review"] },
      };
    },
  } as unknown as AmpleFileActFacade;
  const records: Array<Record<string, unknown>> = [];
  const execute = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({ ...record });
          return true;
        },
      },
    },
  );
  const lastOk = () => records.filter((record) => record.outcome === "ok").at(-1)!;

  // Every verb executes on the first call and returns its effect: no pending
  // decision, no decision id anywhere in the result or the receipts.
  const deleted = await execute(["connected-folders", "delete", "--connected-folder", "connected-folder-1", "--json"]);
  assert.equal(deleted.exitCode, 0);
  const deletedJson = JSON.parse(deleted.stdout) as { ok: boolean; data: Record<string, unknown> };
  assert.equal(deletedJson.ok, true);
  assert.equal(deletedJson.data.removed, true);
  assert.equal("staged" in deletedJson.data, false);
  assert.equal("decisionId" in deletedJson.data, false);
  const connectedFoldersDeleteInput = calls.at(-1)!.input as { connectedFolder: string; requestId?: string };
  assert.equal(connectedFoldersDeleteInput.connectedFolder, "connected-folder-1");
  assert.ok(connectedFoldersDeleteInput.requestId, "the act request's journal id rides into the facade");
  assert.deepEqual(records.map((record) => record.outcome), ["accepted", "ok"]);
  assert.equal(lastOk().decisionId, undefined, "receipts carry no decision id");
  assert.equal(lastOk().detail, "connected-folder.delete-folder");
  const deletedHuman = await execute(["connected-folders", "delete", "--connected-folder", "connected-folder-1"]);
  assert.match(deletedHuman.stdout, /^Deleted the managed folder of Fold Connected Folder \[connected-folder-1\]\. Final cleanup completes at the next start\.\n$/);

  const install = await execute(["tools", "install", "--source", "npm:@demo/toolkit", "--scope", "everywhere"]);
  assert.equal(install.exitCode, 0);
  assert.match(install.stdout, /^Installed npm:@demo\/toolkit 1\.2\.3 \(everywhere scope\)\.\n$/);
  assert.doesNotMatch(install.stdout, /staged|approv|decision/i);
  assert.equal(lastOk().detail, "capability.package.install; scope everywhere; source npm:@demo/toolkit@1.2.3; version 1.2.3");
  assert.deepEqual(lastOk().undoRef, { kind: "package-source", value: "npm:@demo/toolkit@1.2.3" });

  const imported = await execute(["tools", "import-skill", "--scope", "connected-folder", "--connected-folder", "connected-folder-1", "--from", "notes.skill"]);
  assert.equal(imported.exitCode, 0);
  assert.match(imported.stdout, /^Imported notes, todo \(connected-folder scope\)\.\n$/);
  assert.equal(lastOk().detail, `capability.skills.import; scope connected-folder; source /tmp/notes.skill; digest ${"c".repeat(64)}`);
  assert.deepEqual(lastOk().undoRef, { kind: "skill-bundle-path", value: "/tmp/fold/.pi/skills/notes.skill" });

  const purge = await execute(["apps", "uninstall", "--connected-folder", "connected-folder-1", "--instance", "runtime-instance_1", "--purge-data"]);
  assert.equal(purge.exitCode, 0);
  assert.match(purge.stdout, /^Uninstalled instance runtime-instance_1 from Fold Connected Folder \[connected-folder-1\] and purged its data\.\n$/);
  assert.equal(calls.at(-1)?.method, "appsUninstallPurge");
  assert.equal(lastOk().detail, "app.data.purge; instance runtime-instance_1");

  const grant = await execute(["apps", "grant", "--connected-folder", "connected-folder-1", "--app", "quote-board", "--digest", "f".repeat(64), "--kind", "files", "--declaration", "exports"]);
  assert.equal(grant.exitCode, 0);
  assert.match(grant.stdout, /^Granted files exports to quote-board in Fold Connected Folder \[connected-folder-1\]\. It covers the whole Connected Folder\.\n$/);
  assert.equal(lastOk().detail, "app.grant.files; app quote-board; declaration exports; root .");
  assert.deepEqual(lastOk().undoRef, { kind: "declaration", value: "exports" });

  const cleared = await execute(["apps", "storage", "clear", "--connected-folder", "connected-folder-1", "--app", "quote-board"]);
  assert.match(cleared.stdout, /^Cleared 2048 bytes of live storage of quote-board in Fold Connected Folder \[connected-folder-1\]; 0 bytes remain\.\n$/);
  assert.equal(lastOk().detail, "app.storage.clear; app quote-board; bytes 2048");

  const automation = await execute(["automations", "enable", "--proposal", "fold/weekly.json"]);
  assert.equal(automation.exitCode, 0);
  assert.match(automation.stdout, /^Enabled automation "Weekly glue" \[automation-weekly\]\. It now runs on its trigger; /);
  assert.match(automation.stdout, /'automations disable --automation automation-weekly' turns it off\.\n$/);
  assert.equal(calls.at(-1)?.method, "automationsEnable");
  assert.equal((calls.at(-1)?.input as { proposalPath: string }).proposalPath, "fold/weekly.json");
  assert.equal((calls.at(-1)?.input as { cwd: string }).cwd, cwd);
  assert.equal(lastOk().detail, `automation.enable; automation automation-weekly; digest ${"e".repeat(64)}`);
  assert.deepEqual(lastOk().undoRef, { kind: "automation-id", value: "automation-weekly" });

  // Enabling the same declaration again changes nothing, and says so.
  automationsEnableAlready = true;
  const again = await execute(["automations", "enable", "--proposal", "fold/weekly.json"]);
  assert.equal(again.exitCode, 0);
  assert.match(again.stdout, /^Automation "Weekly glue" \[automation-weekly\] is already on with this exact declaration; nothing changed\.\n$/);
  assert.equal(lastOk().detail, `automation.enable; automation automation-weekly; digest ${"e".repeat(64)}; already enabled`);
  automationsEnableAlready = false;

  // The host creates the review itself and installs it at once through the
  // same digest-checked path a Chat proposal uses.
  records.length = 0;
  const preview = await execute(["apps", "install-preview", "--connected-folder", "connected-folder-1", "--package", "apps/preview"]);
  assert.equal(preview.exitCode, 0);
  // Both halves, the way the Chat path reports them: what came on, and what
  // deliberately still needs the person (docs/receipts-not-gates.md, F21).
  assert.match(preview.stdout, /^Installed Quote board 0\.9\.0 in Fold Connected Folder \[connected-folder-1\]\. It replaced the previous installation\.\n/);
  assert.match(preview.stdout, /On now: 2 destinations, 1 folder permission over the whole Connected Folder, 0 notifications, 0 Check slots, 1 automation\.\n/);
  assert.match(
    preview.stdout,
    /Still needs the person, in Settings → Apps: connect crm; choose a file for ledger; choose a Check for review\.\n$/,
  );
  const previewInput = calls.at(-1)?.input as { connectedFolder: string; packagePath: string; requestId?: string };
  assert.equal(previewInput.connectedFolder, "connected-folder-1");
  assert.equal(previewInput.packagePath, "apps/preview");
  assert.ok(previewInput.requestId, "the act request's journal id rides into the facade");
  assert.deepEqual(records.map((record) => record.outcome), ["accepted", "ok"]);
  assert.equal(
    lastOk().detail,
    `app.review.install; proposal proposal-1; digest ${"f".repeat(64)}; replaced installed preview; 3 still needs the person`,
  );

  // A setup-only refusal happens at parse time: no journal entry at all.
  records.length = 0;
  const neverList = await execute(["provider", "set-key"]);
  assert.equal(neverList.exitCode, 4);
  assert.match(neverList.stderr, /Provider credentials is local setup only/);
  assert.deepEqual(records, []);
});

test("agent overview parses strictly, dispatches to the facade, journals, and renders the digest", async () => {
  assert.deepEqual(parseAmpleFileCliActArgv(["agent", "overview"]), { name: "agent.overview", output: "human" });
  assert.deepEqual(parseAmpleFileCliActArgv(["agent", "overview", "--json"]), { name: "agent.overview", output: "json" });
  assert.throws(
    () => parseAmpleFileCliActArgv(["agent", "overview", "--connected-folder", "connected-folder-1"]),
    /--connected-folder cannot be used with 'agent overview'/,
  );

  const snapshot = {
    kind: "amplefile.overview.experimental",
    version: 1,
    composedAt: "2026-08-10T12:00:00.000Z",
    cursor: "2026-08-10T11:00:00.000Z/settled-turns:task-1",
    running: [{ id: "kernel-tasks:task-2", at: createdAt, kind: "assistant-turn", connectedFolderName: "Fold Connected Folder", headline: "Turn running" }],
    needsYou: [{ id: "chats:chat-3:question", at: createdAt, kind: "chat-question", connectedFolderName: "Fold Connected Folder", headline: "\"Quarterly plan\" is waiting on your reply" }],
    changes: [{ id: "settled-turns:task-1", at: createdAt, kind: "turn-settled", connectedFolderName: "Fold Connected Folder", headline: "Turn succeeded" }],
    checks: [{ connectedFolderId: "connected-folder-1", connectedFolderName: "Fold Connected Folder", state: "needs-attention", needsAttention: 2, neverRun: 0, stale: 0, blocked: 0, errors: 0, lastRunAt: createdAt }],
    seen: {},
    truncated: { running: false, needsYou: false, changes: true, checks: false },
    unavailable: ["automation-runs"],
  };
  const calls: string[] = [];
  const records: Array<{ command: string; outcome: string }> = [];
  const facade = {
    agentOverview: async () => {
      calls.push("agentOverview");
      return snapshot;
    },
  } as unknown as AmpleFileActFacade;
  const execute = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({ command: record.command, outcome: record.outcome });
          return true;
        },
      },
    },
  );

  const json = await execute(["agent", "overview", "--json"]);
  assert.equal(json.exitCode, 0);
  const parsed = JSON.parse(json.stdout) as { ok: boolean; command: string; data: typeof snapshot };
  assert.equal(parsed.command, "agent.overview");
  assert.equal(parsed.data.kind, "amplefile.overview.experimental");
  assert.equal(parsed.data.needsYou[0]?.kind, "chat-question");

  const human = await execute(["agent", "overview"]);
  assert.match(human.stdout, /Running:\n- Turn running \(Fold Connected Folder\)/);
  assert.match(human.stdout, /Needs you:\n- .*"Quarterly plan" is waiting on your reply/);
  assert.match(human.stdout, /Since you last looked \(more omitted\):/);
  assert.match(human.stdout, /- Fold Connected Folder: needs-attention — 2 findings need attention/);
  assert.match(human.stdout, /Unavailable sources this composition: automation-runs\./);

  assert.equal(calls.length, 2);
  assert.deepEqual(records, [
    { command: "agent.overview", outcome: "accepted" },
    { command: "agent.overview", outcome: "ok" },
    { command: "agent.overview", outcome: "accepted" },
    { command: "agent.overview", outcome: "ok" },
  ], "the shared journal-first executor covers the overview with no special casing");
});

test("automation receipt JSON stays chronological and human output shows its newest bounded tail", async () => {
  const receipts = Array.from({ length: 60 }, (_, index) => ({
    at: new Date(Date.parse("2026-09-01T12:00:00.000Z") + index * 1_000).toISOString(),
    scope: "automation" as const,
    outcome: "enabled" as const,
    automationId: `automation-${String(index).padStart(2, "0")}`,
  }));
  const facade = {
    automationsReceipts: async () => ({ receipts, truncated: false, damagedLineCount: 0 }),
  } as unknown as AmpleFileActFacade;
  const execute = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: { hasAccepted: async () => false, append: async () => true },
    },
  );

  const json = await execute(["automations", "receipts", "--json"]);
  assert.equal(json.exitCode, 0);
  const parsed = JSON.parse(json.stdout) as { data: { receipts: typeof receipts } };
  assert.equal(parsed.data.receipts[0]?.automationId, "automation-00");
  assert.equal(parsed.data.receipts.at(-1)?.automationId, "automation-59");

  const human = await execute(["automations", "receipts"]);
  assert.match(human.stdout, /10 older receipt\(s\) in the --json result\./);
  assert.doesNotMatch(human.stdout, /\[automation-09\]/);
  assert.ok(human.stdout.indexOf("[automation-10]") < human.stdout.indexOf("[automation-59]"));
});

test("Chat lifecycle and History acts dispatch to the facade, stamp undo references, and render bespoke output", async () => {
  const connectedFolderRef = { id: "connected-folder-1", name: "Fold Connected Folder", connectedFolderRoot: "/tmp/fold" };
  const conversationRef = (over: Record<string, unknown> = {}) => ({
    id: "conv-1",
    title: "Weekly plan",
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    snoozedUntil: null,
    ...over,
  });
  const checkpointSummary = {
    checkpointId: "cp-20260810120000-aaaaaaaa",
    createdAt,
    label: "draft one",
    reason: "manual",
    scope: "full" as const,
    fileCount: 3,
    totalBytes: 42,
    skippedFileCount: 0,
  };
  const calls: Array<{ method: string; input: unknown }> = [];
  let saveCreated = true;
  const facade = {
    chatRename: async (input: unknown) => {
      calls.push({ method: "chatRename", input });
      return { connectedFolder: connectedFolderRef, conversation: conversationRef(), priorTitle: "New Chat" };
    },
    chatSnooze: async (input: unknown) => {
      calls.push({ method: "chatSnooze", input });
      return {
        connectedFolder: connectedFolderRef,
        conversation: conversationRef({ snoozedUntil: "2026-08-11T13:00:00.000Z" }),
        priorLifecycle: { archivedAt: null, snoozedUntil: null },
      };
    },
    chatArchive: async (input: unknown) => {
      calls.push({ method: "chatArchive", input });
      return {
        connectedFolder: connectedFolderRef,
        conversation: conversationRef({ archivedAt: createdAt }),
        priorLifecycle: { archivedAt: null, snoozedUntil: "2026-08-11T13:00:00.000Z" },
      };
    },
    chatResume: async (input: unknown) => {
      calls.push({ method: "chatResume", input });
      return {
        connectedFolder: connectedFolderRef,
        conversation: conversationRef(),
        priorLifecycle: { archivedAt: createdAt, snoozedUntil: null },
      };
    },
    historyList: async (input: unknown) => {
      calls.push({ method: "historyList", input });
      return { connectedFolder: connectedFolderRef, checkpoints: [] };
    },
    historySave: async (input: unknown) => {
      calls.push({ method: "historySave", input });
      return { connectedFolder: connectedFolderRef, checkpoint: checkpointSummary, created: saveCreated };
    },
    historyRestore: async (input: unknown) => {
      calls.push({ method: "historyRestore", input });
      return {
        connectedFolder: connectedFolderRef,
        restored: true,
        checkpointId: "cp-20260810120000-aaaaaaaa",
        safetyCheckpointId: "cp-20260810120100-bbbbbbbb",
        restoredFileCount: 2,
        deletedFileCount: 1,
        movedEntryCount: 0,
        unchangedFileCount: 4,
        skippedLargeFileCount: 1,
      };
    },
    historyVersions: async (input: unknown) => {
      calls.push({ method: "historyVersions", input });
      return {
        connectedFolder: connectedFolderRef,
        path: "docs/plan.md",
        versions: [{
          path: "docs/plan.md",
          hashSha256: "e".repeat(64),
          sizeBytes: 12,
          modifiedAt: createdAt,
          capturedAt: createdAt,
          checkpointId: checkpointSummary.checkpointId,
        }],
      };
    },
    historyRestoreFile: async (input: unknown) => {
      calls.push({ method: "historyRestoreFile", input });
      return {
        connectedFolder: connectedFolderRef,
        restored: true,
        path: "docs/plan.md",
        hashSha256: "e".repeat(64),
        previousHashSha256: "f".repeat(64),
        safetyCheckpointId: "cp-20260810120200-cccccccc",
      };
    },
    chatCompact: async (input: unknown) => {
      calls.push({ method: "chatCompact", input });
      return { connectedFolder: connectedFolderRef, conversationId: "conv-1", compacted: true, taskId: "task-compact-1" };
    },
  } as unknown as AmpleFileActFacade;
  const records: Array<{
    outcome: string;
    command: string;
    conversationId?: string;
    checkpointId?: string;
    taskId?: string;
    parentTaskId?: string;
    detail?: string;
    undoRef?: { kind: string; value: string };
  }> = [];
  const execute = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      resolveLineageParent: (taskId) => (taskId === "task-9" ? { taskId } : null),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({
            outcome: record.outcome,
            command: record.command,
            ...(record.conversationId ? { conversationId: record.conversationId } : {}),
            ...(record.checkpointId ? { checkpointId: record.checkpointId } : {}),
            ...(record.taskId ? { taskId: record.taskId } : {}),
            ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
            ...(record.detail ? { detail: record.detail } : {}),
            ...(record.undoRef ? { undoRef: record.undoRef } : {}),
          });
          return true;
        },
      },
    },
  );
  const lastOk = () => records.filter((record) => record.outcome === "ok").at(-1)!;

  const renamed = await execute(["chat", "rename", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--title", "Weekly plan"]);
  assert.equal(renamed.exitCode, 0);
  assert.match(renamed.stdout, /Renamed Chat \[conv-1\] to "Weekly plan" in Fold Connected Folder \[connected-folder-1\] \(was "New Chat"\)\./);
  assert.deepEqual(calls.at(-1), {
    method: "chatRename",
    input: { connectedFolder: "connected-folder-1", conversationId: "conv-1", title: "Weekly plan" },
  });
  assert.equal(lastOk().conversationId, "conv-1");
  assert.deepEqual(lastOk().undoRef, { kind: "chat-title", value: "New Chat" });

  const snoozed = await execute(["chat", "snooze", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--until", "2026-08-11T13:00:00.000Z"]);
  assert.match(snoozed.stdout, /Snoozed Chat "Weekly plan" \[conv-1\] until 2026-08-11T13:00:00\.000Z/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", conversationId: "conv-1", until: "2026-08-11T13:00:00.000Z" });
  assert.deepEqual(lastOk().undoRef, { kind: "chat-lifecycle", value: "active" });

  const archived = await execute(["chat", "archive", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--parent-task", "task-9"]);
  assert.match(archived.stdout, /Archived Chat "Weekly plan" \[conv-1\]/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", conversationId: "conv-1", parentTaskId: "task-9" });
  assert.equal(lastOk().parentTaskId, "task-9");
  assert.deepEqual(lastOk().undoRef, { kind: "chat-lifecycle", value: "snoozed:2026-08-11T13:00:00.000Z" });

  const resumed = await execute(["chat", "resume", "--connected-folder", "connected-folder-1", "--conversation", "conv-1"]);
  assert.match(resumed.stdout, /Resumed Chat "Weekly plan" \[conv-1\] in Fold Connected Folder \[connected-folder-1\] \(was archived\)\./);
  assert.deepEqual(lastOk().undoRef, { kind: "chat-lifecycle", value: "archived" });

  const emptyList = await execute(["history", "list", "--connected-folder", "connected-folder-1"]);
  assert.match(emptyList.stdout, /No restore points saved in Fold Connected Folder \[connected-folder-1\]\./);
  assert.equal(lastOk().undoRef, undefined);

  const saved = await execute(["history", "save", "--connected-folder", "connected-folder-1", "--label", "draft one"]);
  assert.match(saved.stdout, /Saved restore point cp-20260810120000-aaaaaaaa \(3 files\) in Fold Connected Folder \[connected-folder-1\]\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", label: "draft one" });
  assert.equal(lastOk().checkpointId, "cp-20260810120000-aaaaaaaa");
  assert.equal(lastOk().detail, "created restore point");

  saveCreated = false;
  const unchanged = await execute(["history", "save", "--connected-folder", "connected-folder-1"]);
  assert.match(unchanged.stdout, /already matches restore point cp-20260810120000-aaaaaaaa; no new restore point was created\./);
  assert.equal(lastOk().detail, "already matches the latest restore point");

  const restored = await execute(["history", "restore", "--connected-folder", "connected-folder-1", "--checkpoint", "cp-20260810120000-aaaaaaaa"]);
  assert.match(restored.stdout, /Restored Fold Connected Folder \[connected-folder-1\] to restore point cp-20260810120000-aaaaaaaa\./);
  assert.match(restored.stdout, /2 file\(s\) restored; 1 deleted; 0 moved back; 4 unchanged\./);
  assert.match(restored.stdout, /History skipped 1 oversized file recorded by that restore point\./);
  assert.match(restored.stdout, /Safety restore point: cp-20260810120100-bbbbbbbb/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", checkpointId: "cp-20260810120000-aaaaaaaa" });
  assert.equal(lastOk().checkpointId, "cp-20260810120000-aaaaaaaa");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260810120100-bbbbbbbb" });

  const versions = await execute(["history", "versions", "--connected-folder", "connected-folder-1", "--path", "docs/plan.md"]);
  assert.match(versions.stdout, /1 saved version of docs\/plan\.md in Fold Connected Folder \[connected-folder-1\]:/);
  assert.match(versions.stdout, new RegExp(`- ${"e".repeat(64)} — captured`));
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", path: "docs/plan.md" });

  const restoredFile = await execute([
    "history", "restore-file", "--connected-folder", "connected-folder-1", "--path", "docs/plan.md", "--version", "e".repeat(64),
  ]);
  assert.match(restoredFile.stdout, new RegExp(`Restored docs/plan\\.md to version ${"e".repeat(64)}`));
  assert.match(restoredFile.stdout, /Safety restore point: cp-20260810120200-cccccccc/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", path: "docs/plan.md", version: "e".repeat(64) });
  assert.equal(lastOk().checkpointId, "cp-20260810120200-cccccccc");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260810120200-cccccccc" });

  // chat compact dispatches with the kernel-task discipline: the receipt
  // carries the compaction task id and no undo reference — compaction is
  // additive summarization, not deletion.
  const compact = await execute(["chat", "compact", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--parent-task", "task-9"]);
  assert.equal(compact.exitCode, 0);
  assert.match(compact.stdout, /Compacted Chat \[conv-1\] in Fold Connected Folder \[connected-folder-1\] \(task task-compact-1\)\./);
  assert.match(compact.stdout, /additive summarization; nothing was deleted\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", conversationId: "conv-1", parentTaskId: "task-9" });
  assert.equal(lastOk().taskId, "task-compact-1");
  assert.equal(lastOk().conversationId, "conv-1");
  assert.equal(lastOk().undoRef, undefined);
});

test("file and search acts dispatch to the facade, stamp receipts, and render bespoke output", async () => {
  const connectedFolderRef = { id: "connected-folder-1", name: "Fold Connected Folder", connectedFolderRoot: "/tmp/fold" };
  const calls: Array<{ method: string; input?: unknown }> = [];
  let searchResult: Record<string, unknown> = {};
  /** Swapped per case: a delete History covered, then one it could not. */
  let deleteRecovery: Record<string, unknown> = { kind: "history" as const };
  const facade = {
    filesMove: async (input: unknown) => {
      calls.push({ method: "filesMove", input });
      return {
        connectedFolder: connectedFolderRef,
        fromPath: "docs/plan.md",
        path: "archive/plan.md",
        kind: "file" as const,
        safetyCheckpointId: "cp-20260810130000-aaaaaaaa",
      };
    },
    filesRename: async (input: unknown) => {
      calls.push({ method: "filesRename", input });
      return {
        connectedFolder: connectedFolderRef,
        fromPath: "docs/plan.md",
        path: "docs/plan-2026.md",
        priorName: "plan.md",
        kind: "file" as const,
        safetyCheckpointId: "cp-20260810130100-bbbbbbbb",
      };
    },
    filesDelete: async (input: unknown) => {
      calls.push({ method: "filesDelete", input });
      return {
        connectedFolder: connectedFolderRef,
        deleted: true,
        path: "docs/old.md",
        kind: "file" as const,
        safetyCheckpointId: "cp-20260810130200-cccccccc",
        recovery: deleteRecovery,
      };
    },
    recentlyDeletedList: async () => {
      calls.push({ method: "recentlyDeletedList" });
      return {
        entries: [{
          id: "trash-20260910083000-53db781d",
          kind: "folder" as const,
          reason: "files.delete" as const,
          connectedFolderId: "connected-folder-1",
          connectedFolderName: "Fold Connected Folder",
          originalPath: "Drafts",
          name: "Drafts",
          sizeBytes: 12_400,
          deletedAt: "2026-09-10T08:30:00.000Z",
          restoreBy: "2026-10-10T08:30:00.000Z",
          receiptId: "req-1",
          restorable: "in-place" as const,
        }],
        retentionDays: 30,
        damagedCount: 0,
      };
    },
    recentlyDeletedRestore: async (input: unknown) => {
      calls.push({ method: "recentlyDeletedRestore", input });
      return {
        entry: {
          id: "trash-20260910083000-53db781d",
          kind: "folder" as const,
          reason: "files.delete" as const,
          connectedFolderId: "connected-folder-1",
          connectedFolderName: "Fold Connected Folder",
          originalPath: "Drafts",
          name: "Drafts",
          sizeBytes: 12_400,
          deletedAt: "2026-09-10T08:30:00.000Z",
          restoreBy: "2026-10-10T08:30:00.000Z",
          receiptId: "req-1",
          restorable: "in-place" as const,
        },
        restored: {
          kind: "folder" as const,
          connectedFolder: connectedFolderRef,
          path: "Drafts-2",
          renamed: true,
          safetyCheckpointId: "cp-20260910083100-aaaabbbb",
        },
      };
    },
    filesMkdir: async (input: unknown) => {
      calls.push({ method: "filesMkdir", input });
      return {
        connectedFolder: connectedFolderRef,
        created: true,
        path: "notes",
        kind: "folder" as const,
        safetyCheckpointId: "cp-20260810130300-dddddddd",
      };
    },
    filesCreate: async (input: unknown) => {
      calls.push({ method: "filesCreate", input });
      return {
        connectedFolder: connectedFolderRef,
        created: true,
        path: "notes/todo.md",
        kind: "file" as const,
        safetyCheckpointId: "cp-20260810130400-eeeeeeee",
      };
    },
    search: async (input: unknown) => {
      calls.push({ method: "search", input });
      return searchResult;
    },
  } as unknown as AmpleFileActFacade;
  const records: Array<Record<string, unknown>> = [];
  const execute = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      resolveLineageParent: (taskId) => (taskId === "task-9" ? { taskId } : null),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({ ...record });
          return true;
        },
      },
    },
  );
  const lastOk = () => records.filter((record) => record.outcome === "ok").at(-1)!;

  const moved = await execute(["files", "move", "--connected-folder", "connected-folder-1", "--from", "docs/plan.md", "--to", "archive"]);
  assert.equal(moved.exitCode, 0);
  assert.match(moved.stdout, /Moved docs\/plan\.md to archive\/plan\.md in Fold Connected Folder \[connected-folder-1\]\./);
  assert.match(moved.stdout, /Safety restore point: cp-20260810130000-aaaaaaaa/);
  assert.deepEqual(calls.at(-1), { method: "filesMove", input: { connectedFolder: "connected-folder-1", fromPath: "docs/plan.md", toDir: "archive" } });
  assert.equal(lastOk().checkpointId, "cp-20260810130000-aaaaaaaa");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260810130000-aaaaaaaa" });
  assert.equal(lastOk().detail, "moved to archive/plan.md");

  const renamed = await execute(["files", "rename", "--connected-folder", "connected-folder-1", "--path", "docs/plan.md", "--name", "plan-2026.md", "--parent-task", "task-9"]);
  assert.match(renamed.stdout, /Renamed docs\/plan\.md to docs\/plan-2026\.md in Fold Connected Folder \[connected-folder-1\]\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", path: "docs/plan.md", newName: "plan-2026.md", parentTaskId: "task-9" });
  assert.equal(lastOk().parentTaskId, "task-9");
  assert.equal(lastOk().checkpointId, "cp-20260810130100-bbbbbbbb");
  assert.deepEqual(lastOk().undoRef, { kind: "entry-name", value: "plan.md" });

  const deleted = await execute(["files", "delete", "--connected-folder", "connected-folder-1", "--path", "docs/old.md"]);
  assert.match(deleted.stdout, /Deleted file docs\/old\.md in Fold Connected Folder \[connected-folder-1\]\./);
  assert.match(deleted.stdout, /Safety restore point: cp-20260810130200-cccccccc — restore it with 'history restore' to undo this delete\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", path: "docs/old.md" });
  assert.equal(lastOk().checkpointId, "cp-20260810130200-cccccccc");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260810130200-cccccccc" });

  // F20: when History could not keep a copy of every matched file, the delete
  // still goes through, names why, and its undo reference is the Recently
  // deleted item rather than the partial restore point.
  deleteRecovery = {
    kind: "recently-deleted" as const,
    entryId: "trash-20260910083000-53db781d",
    restoreBy: "2026-10-10T08:30:00.000Z",
    uncovered: [
      { path: "docs/big.iso", reason: "too_large" as const },
      { path: "docs/link.md", reason: "symbolic_link" as const },
    ],
  };
  const movedToRecentlyDeleted = await execute(["files", "delete", "--connected-folder", "connected-folder-1", "--path", "docs/old.md"]);
  assert.match(movedToRecentlyDeleted.stdout, /It is in Recently deleted until 2026-10-10T08:30:00\.000Z because History could not keep a copy of 2 files: docs\/big\.iso \(too large\); docs\/link\.md \(a link\)\./);
  assert.match(movedToRecentlyDeleted.stdout, /Put it back with 'recently-deleted restore --entry trash-20260910083000-53db781d'/);
  assert.equal(lastOk().detail, "recently-deleted trash-20260910083000-53db781d");
  assert.deepEqual(lastOk().undoRef, { kind: "recently-deleted-entry", value: "trash-20260910083000-53db781d" });
  assert.equal(lastOk().checkpointId, "cp-20260810130200-cccccccc", "the restore point still covered what it could");
  deleteRecovery = { kind: "history" as const };

  // Recently deleted's own verbs: a content-free listing and a restore whose
  // undo is the additive restore point it recorded.
  const recentlyDeletedListed = await execute(["recently-deleted", "list"]);
  assert.match(recentlyDeletedListed.stdout, /1 item\(s\) in Recently deleted \(kept 30 days\):/);
  assert.match(recentlyDeletedListed.stdout, /- trash-20260910083000-53db781d — folder "Drafts" from Fold Connected Folder \[connected-folder-1\] — 12400 bytes/);
  assert.match(recentlyDeletedListed.stdout, /kept until 2026-10-10T08:30:00\.000Z/);
  assert.deepEqual(calls.at(-1), { method: "recentlyDeletedList" });

  const recentlyDeletedRestored = await execute(["recently-deleted", "restore", "--entry", "trash-20260910083000-53db781d"]);
  assert.match(recentlyDeletedRestored.stdout, /Restored folder Drafts-2 to Fold Connected Folder \[connected-folder-1\] under a new name, because the old one was taken\./);
  assert.equal((calls.at(-1) as { input: { entry: string } }).input.entry, "trash-20260910083000-53db781d");
  assert.equal(lastOk().connectedFolderId, "connected-folder-1");
  assert.equal(lastOk().detail, "entry trash-20260910083000-53db781d; kind folder; restored Drafts-2");
  assert.deepEqual(lastOk().undoRef, { kind: "safety-checkpoint", value: "cp-20260910083100-aaaabbbb" });

  const madeFolder = await execute(["files", "mkdir", "--connected-folder", "connected-folder-1", "--path", "notes"]);
  assert.match(madeFolder.stdout, /Created folder notes in Fold Connected Folder \[connected-folder-1\]\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", path: "notes" });
  assert.equal(lastOk().checkpointId, undefined, "creation receipts deliberately carry no restore-point reference");
  assert.deepEqual(lastOk().undoRef, { kind: "created-path", value: "notes" });

  const createdFile = await execute(["files", "create", "--connected-folder", "connected-folder-1", "--path", "notes/todo.md"]);
  assert.match(createdFile.stdout, /Created empty file notes\/todo\.md in Fold Connected Folder \[connected-folder-1\]\./);
  assert.equal(lastOk().checkpointId, undefined);
  assert.deepEqual(lastOk().undoRef, { kind: "created-path", value: "notes/todo.md" });

  // Search renders bounded matches, discloses a stopped bound, and its
  // receipt records the scope but never the query text.
  searchResult = {
    connectedFolder: connectedFolderRef,
    scope: "files",
    query: "quarterly budget",
    files: [{ path: "notes/plan.md", line: 2, preview: "the Quarterly budget is due" }],
    chats: [],
    truncated: true,
    scannedFiles: 41,
  };
  const searched = await execute(["search", "--connected-folder", "connected-folder-1", "--query", "quarterly budget", "--scope", "files"]);
  assert.match(searched.stdout, /1 match for "quarterly budget" in Fold Connected Folder \[connected-folder-1\] \(scope files\):/);
  assert.match(searched.stdout, /- notes\/plan\.md:2 — the Quarterly budget is due/);
  assert.match(searched.stdout, /Coverage is incomplete/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", query: "quarterly budget", scope: "files" });
  assert.equal(lastOk().detail, "scope files");
  assert.doesNotMatch(JSON.stringify(records), /quarterly/, "receipts never record the query text");

  searchResult = { connectedFolder: connectedFolderRef, scope: "all", query: "nothing here", files: [], chats: [], truncated: false, scannedFiles: 3 };
  const emptySearch = await execute(["search", "--connected-folder", "connected-folder-1", "--query", "nothing here"]);
  assert.match(emptySearch.stdout, /No matches for "nothing here" in Fold Connected Folder \[connected-folder-1\] \(scope all\)\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", query: "nothing here" });

  // Permanent deletion left the vocabulary (docs/receipts-not-gates.md, F20).
  assert.throws(
    () => parseAmpleFileCliActArgv(["files", "destroy"]),
    /Unknown command: files destroy/,
  );
});

test("Connected Folder, appearance, tools, and App Studio acts dispatch to the facade, stamp receipts, and render bespoke output", async () => {
  const connectedFolderRef = { id: "connected-folder-1", name: "Fold Connected Folder", connectedFolderRoot: "/tmp/fold" };
  const targetRef = { id: "connected-folder-2", name: "Target Connected Folder", connectedFolderRoot: "/tmp/target" };
  const releaseDigest = `sha256:${"a".repeat(64)}`;
  const priorDigest = `sha256:${"b".repeat(64)}`;
  const calls: Array<{ method: string; input?: unknown }> = [];
  let toolsRemoved = true;
  const facade = {
    workerShow: async (input: unknown) => {
      calls.push({ method: "workerShow", input });
      return {
        connectedFolder: connectedFolderRef,
        model: { provider: "openrouter", id: "example/model" },
        availableModels: [{ provider: "openrouter", id: "example/model", name: "Example Model", reasoning: true }],
        instructions: "Keep it concise.",
      };
    },
    workerSetModel: async (input: unknown) => {
      calls.push({ method: "workerSetModel", input });
      return { connectedFolder: connectedFolderRef, model: { provider: "openrouter", id: "example/model" } };
    },
    workerSetInstructions: async (input: unknown) => {
      calls.push({ method: "workerSetInstructions", input });
      return { connectedFolder: connectedFolderRef, instructions: (input as { instructions: string }).instructions };
    },
    connectedFoldersRename: async (input: unknown) => {
      calls.push({ method: "connectedFoldersRename", input });
      return { connectedFolder: { ...connectedFolderRef, name: "Fold Prime" }, priorName: "Fold Connected Folder" };
    },
    connectedFoldersUnregister: async (input: unknown) => {
      calls.push({ method: "connectedFoldersUnregister", input });
      return {
        connectedFolder: connectedFolderRef,
        storage: "linked" as const,
        removed: true,
        cleanupPending: false,
        appRecentlyDeletedEntries: [],
        appStudioRecentlyDeleted: { entryId: "trash-20261011120000-abcdef12", restoreBy: "2026-11-10T12:00:00.000Z" },
      };
    },
    connectedFoldersAppearanceApply: async (input: unknown) => {
      calls.push({ method: "connectedFoldersAppearanceApply", input });
      return {
        connectedFolder: connectedFolderRef,
        applied: true,
        proposalName: "Calm blue",
        appearanceRef: "sha256:1111111111111111",
        priorAppearanceRef: null,
      };
    },
    connectedFoldersAppearanceReset: async (input: unknown) => {
      calls.push({ method: "connectedFoldersAppearanceReset", input });
      return {
        connectedFolder: connectedFolderRef,
        reset: true,
        changed: true,
        priorAppearanceRef: "sha256:1111111111111111",
      };
    },
    connectedFoldersAppearanceUndo: async (input: unknown) => {
      calls.push({ method: "connectedFoldersAppearanceUndo", input });
      return {
        connectedFolder: connectedFolderRef,
        restored: true,
        restoredAppearanceRef: "sha256:1111111111111111",
        displacedAppearanceRef: null,
      };
    },
    toolsRemove: async (input: unknown) => {
      calls.push({ method: "toolsRemove", input });
      const scoped = (input as { scope: "everywhere" | "connected-folder"; connectedFolder?: string; source: string });
      return {
        scope: scoped.scope,
        ...(scoped.scope === "connected-folder" ? { connectedFolder: connectedFolderRef } : {}),
        source: scoped.source,
        removed: toolsRemoved,
      };
    },
    appsProjectDeclare: async (input: unknown) => {
      calls.push({ method: "appsProjectDeclare", input });
      return {
        connectedFolder: connectedFolderRef,
        project: { projectId: "project_1", presentation: { title: "Connected Inbox", description: null, icon: "mail" } },
        priorPresentation: null,
        priorPresentationRef: null,
      };
    },
    appsReleasePrepare: async (input: unknown) => {
      calls.push({ method: "appsReleasePrepare", input });
      return {
        connectedFolder: connectedFolderRef,
        release: {
          releaseDigest,
          displayVersion: "1.0.0",
          state: "prepared" as const,
          preparedAt: createdAt,
          publishedAt: null,
          featureCount: 1,
        },
      };
    },
    appsReleasePublish: async (input: unknown) => {
      calls.push({ method: "appsReleasePublish", input });
      return {
        connectedFolder: connectedFolderRef,
        release: {
          releaseDigest,
          displayVersion: "1.0.0",
          state: "published" as const,
          preparedAt: createdAt,
          publishedAt: createdAt,
          featureCount: 1,
        },
      };
    },
    appsReleaseDelete: async (input: unknown) => {
      calls.push({ method: "appsReleaseDelete", input });
      return { connectedFolder: connectedFolderRef, releaseDigest, deleted: true, cleanupPending: false };
    },
    appsInstallPrepare: async (input: unknown) => {
      calls.push({ method: "appsInstallPrepare", input });
      return {
        connectedFolder: connectedFolderRef,
        targetConnectedFolder: targetRef,
        operation: {
          operationId: "operation_1",
          kind: "install" as const,
          releaseDigest,
          runtimeInstanceId: "runtime-instance_1",
          targetConnectedFolderId: targetRef.id,
          preparedAt: createdAt,
        },
      };
    },
    appsUpdatePrepare: async (input: unknown) => {
      calls.push({ method: "appsUpdatePrepare", input });
      return {
        connectedFolder: connectedFolderRef,
        targetConnectedFolder: targetRef,
        operation: {
          operationId: "operation_2",
          kind: "update" as const,
          releaseDigest,
          runtimeInstanceId: "runtime-instance_1",
          targetConnectedFolderId: targetRef.id,
          preparedAt: createdAt,
          fromReleaseDigest: priorDigest,
          continuityPolicy: "eligible" as const,
        },
      };
    },
    appsOperationActivate: async (input: unknown) => {
      calls.push({ method: "appsOperationActivate", input });
      return {
        connectedFolder: connectedFolderRef,
        operationId: "operation_1",
        operationKind: "install" as const,
        instance: {
          runtimeInstanceId: "runtime-instance_1",
          connectedFolderId: targetRef.id,
          releaseDigest,
          displayVersion: "1.0.0",
        },
      };
    },
    appsOperationCancel: async (input: unknown) => {
      calls.push({ method: "appsOperationCancel", input });
      return { connectedFolder: connectedFolderRef, operationId: "operation_2", cancelled: true };
    },
    appsUninstall: async (input: unknown) => {
      calls.push({ method: "appsUninstall", input });
      return {
        connectedFolder: connectedFolderRef,
        runtimeInstanceId: "runtime-instance_1",
        removed: true,
        retainedNamespaceIds: ["data-namespace_1"],
        cleanupPending: false,
      };
    },
    appsUninstallPurge: async (input: unknown) => {
      calls.push({ method: "appsUninstallPurge", input });
      return { connectedFolder: connectedFolderRef, runtimeInstanceId: "runtime-instance_1", purgedNamespaceIds: ["data-namespace_1"], removed: true, cleanupPending: true };
    },
    appsList: async (input: unknown) => {
      calls.push({ method: "appsList", input });
      return {
        connectedFolder: connectedFolderRef,
        apps: [{
          appId: "connected-inbox",
          featureInstallationId: "feature-installation_1",
          digest: "d".repeat(64),
          title: "Connected inbox",
          description: "Reads the shared inbox.",
          version: "0.1.0",
          kind: "preview" as const,
          tools: [{
            name: "summarize",
            description: "Summarize the inbox.",
            action: "summarize",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
            resultSchema: { type: "string" },
          }],
          assistantActions: [{ id: "compare", title: "Compare quotes" }],
          grants: { network: ["crm"], files: [{ declarationId: "connected-folder-notes", root: ".", access: "read-write" }], notifications: [], checks: [] },
          connections: [{ destinationId: "crm", kind: null, configured: false }],
          automations: [{ id: "daily-sync", title: "Daily sync", enabled: true, nextRunAt: createdAt, lastRunAt: null }],
        }],
        truncated: false,
      };
    },
    appsInvoke: async (input: unknown) => {
      calls.push({ method: "appsInvoke", input });
      return {
        connectedFolder: connectedFolderRef,
        appId: "connected-inbox",
        featureInstallationId: "feature-installation_1",
        digest: "d".repeat(64),
        tool: "summarize",
        action: "summarize",
        result: { summary: "Two quotes, North is cheaper." },
      };
    },
    appsProposalsList: async (input: unknown) => {
      calls.push({ method: "appsProposalsList", input });
      return {
        connectedFolder: connectedFolderRef,
        conversationId: "conv-1",
        proposals: [{
          id: "proposal-1",
          status: "pending" as const,
          sourcePath: "apps/inbox",
          title: "Connected inbox",
          packageName: "connected-inbox",
          version: "0.1.0",
          digest: "d".repeat(64),
          createdAt,
          updatedAt: createdAt,
        }],
      };
    },
    appsProposalsDismiss: async (input: unknown) => {
      calls.push({ method: "appsProposalsDismiss", input });
      return { connectedFolder: connectedFolderRef, proposalId: "proposal-1", dismissed: true };
    },
    appsRemove: async (input: unknown) => {
      calls.push({ method: "appsRemove", input });
      return {
        connectedFolder: connectedFolderRef,
        appId: "connected-inbox",
        digest: "d".repeat(64),
        removed: true,
        recentlyDeleted: { entryId: "trash-app-1", restoreBy: "2026-10-10T00:00:00.000Z" },
      };
    },
    appsRevoke: async (input: unknown) => {
      calls.push({ method: "appsRevoke", input });
      const scoped = input as { kind: "network" | "files" | "notifications"; declaration: string };
      return {
        connectedFolder: connectedFolderRef,
        appId: "connected-inbox",
        grantKind: scoped.kind,
        declaration: scoped.declaration,
        revoked: scoped.declaration !== "never-granted",
      };
    },
    appsDisconnect: async (input: unknown) => {
      calls.push({ method: "appsDisconnect", input });
      return { connectedFolder: connectedFolderRef, appId: "connected-inbox", destination: "crm", disconnected: true };
    },
    appsAutomationDisable: async (input: unknown) => {
      calls.push({ method: "appsAutomationDisable", input });
      return { connectedFolder: connectedFolderRef, appId: "connected-inbox", appAutomationId: "daily-sync", disabled: true, wasEnabled: true };
    },
    appsAutomationRun: async (input: unknown) => {
      calls.push({ method: "appsAutomationRun", input });
      return {
        connectedFolder: connectedFolderRef,
        appId: "connected-inbox",
        appAutomationId: "daily-sync",
        run: { runId: "run-77", outcome: "success" as const, startedAt: createdAt, finishedAt: createdAt },
      };
    },
  } as unknown as AmpleFileActFacade;
  const records: Array<Record<string, unknown>> = [];
  const execute = (argv: string[]) => executeAmpleFileCliActRequest(
    createAmpleFileCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      resolveLineageParent: (taskId) => (taskId === "task-9" ? { taskId } : null),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push({ ...record });
          return true;
        },
      },
    },
  );
  const lastOk = () => records.filter((record) => record.outcome === "ok").at(-1)!;

  const renamed = await execute(["connected-folders", "rename", "--connected-folder", "connected-folder-1", "--name", "Fold Prime"]);
  assert.equal(renamed.exitCode, 0);
  assert.match(renamed.stdout, /Renamed Connected Folder Fold Prime \[connected-folder-1\] \(was "Fold Connected Folder"\)\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", name: "Fold Prime" });
  assert.equal(lastOk().connectedFolderId, "connected-folder-1");
  assert.deepEqual(lastOk().undoRef, { kind: "connected-folder-name", value: "Fold Connected Folder" });

  const unregistered = await execute(["connected-folders", "unregister", "--connected-folder", "connected-folder-1", "--parent-task", "task-9"]);
  assert.match(unregistered.stdout, /Unregistered linked Connected Folder Fold Connected Folder \[connected-folder-1\]\./);
  assert.match(unregistered.stdout, /The folder remains at \/tmp\/fold with its portable \.amplefile identity/);
  // The Connected Folder's App Studio history waits in Recently deleted, and the receipt names it.
  assert.match(unregistered.stdout, /Its App Studio history is in Recently deleted too \[trash-20261011120000-abcdef12\]/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", parentTaskId: "task-9", requestId: lastOk().requestId });
  assert.equal(lastOk().parentTaskId, "task-9");
  assert.equal(lastOk().detail, "storage linked; App Studio trash-20261011120000-abcdef12");
  assert.deepEqual(lastOk().undoRef, { kind: "connected-folder-root", value: "/tmp/fold" });

  const assistant = await execute(["connected-folders", "worker", "show", "--connected-folder", "connected-folder-1"]);
  assert.match(assistant.stdout, /Default model for new Chats: openrouter\/example\/model/);
  assert.match(assistant.stdout, /Example Model \(openrouter\/example\/model\)/);
  assert.match(assistant.stdout, /Keep it concise\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1" });

  const assigned = await execute(["connected-folders", "worker", "model", "--connected-folder", "connected-folder-1", "--provider", "openrouter", "--model", "example/model", "--parent-task", "task-9"]);
  assert.match(assigned.stdout, /default for new Chats/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", provider: "openrouter", model: "example/model", parentTaskId: "task-9" });
  assert.equal(lastOk().detail, "provider openrouter; model example/model");

  const instructed = await execute(["connected-folders", "worker", "instructions", "--connected-folder", "connected-folder-1", "--instructions", "Use the glossary.", "--parent-task", "task-9"]);
  assert.match(instructed.stdout, /Saved Worker Instructions/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", instructions: "Use the glossary.", parentTaskId: "task-9" });
  assert.equal(lastOk().detail, "updated; 17 character(s)");
  assert.doesNotMatch(JSON.stringify(records), /Use the glossary\./, "receipts never record Connected Folder instruction content");

  const applied = await execute(["connected-folders", "appearance", "apply", "--connected-folder", "connected-folder-1", "--proposal", "calm.amplefile-appearance.json"]);
  assert.match(applied.stdout, /Applied appearance proposal "Calm blue" to Fold Connected Folder \[connected-folder-1\] \(was the default appearance\)\./);
  assert.match(applied.stdout, /Undo it with 'connected-folders appearance undo'\./);
  assert.deepEqual(calls.at(-1)?.input, {
    connectedFolder: "connected-folder-1",
    proposalPath: "calm.amplefile-appearance.json",
    cwd,
  });
  assert.equal(lastOk().detail, "applied sha256:1111111111111111");
  assert.deepEqual(lastOk().undoRef, { kind: "appearance-ref", value: "none" });

  const resetOutcome = await execute(["connected-folders", "appearance", "reset", "--connected-folder", "connected-folder-1"]);
  assert.match(resetOutcome.stdout, /Reset Fold Connected Folder \[connected-folder-1\] to the default appearance \(was sha256:1111111111111111\)\./);
  assert.deepEqual(lastOk().undoRef, { kind: "appearance-ref", value: "sha256:1111111111111111" });

  const undone = await execute(["connected-folders", "appearance", "undo", "--connected-folder", "connected-folder-1"]);
  assert.match(undone.stdout, /Restored Fold Connected Folder \[connected-folder-1\] to sha256:1111111111111111\. Running 'connected-folders appearance undo' again swaps back\./);
  assert.equal(lastOk().detail, "restored sha256:1111111111111111");
  assert.deepEqual(lastOk().undoRef, { kind: "appearance-ref", value: "none" });

  const removedEverywhere = await execute(["tools", "remove", "--scope", "everywhere", "--source", "@example/pkg"]);
  assert.match(removedEverywhere.stdout, /Removed package @example\/pkg \(everywhere scope\)\. Reinstalling it is a fresh receipted act/);
  assert.deepEqual(calls.at(-1)?.input, { scope: "everywhere", source: "@example/pkg" });
  assert.equal(lastOk().detail, "scope everywhere; source @example/pkg");
  assert.equal(lastOk().connectedFolderId, undefined);

  toolsRemoved = false;
  const removedConnectedFolder = await execute(["tools", "remove", "--scope", "connected-folder", "--connected-folder", "connected-folder-1", "--source", "./tools/pkg"]);
  assert.match(removedConnectedFolder.stdout, /Package \.\/tools\/pkg is not installed \(Connected Folder scope in Fold Connected Folder \[connected-folder-1\]\); nothing was removed\./);
  assert.deepEqual(calls.at(-1)?.input, { scope: "connected-folder", connectedFolder: "connected-folder-1", source: "./tools/pkg" });
  assert.equal(lastOk().detail, "scope connected-folder; source ./tools/pkg (not installed)");
  assert.equal(lastOk().connectedFolderId, "connected-folder-1");

  const declared = await execute(["apps", "project", "declare", "--connected-folder", "connected-folder-1", "--presentation", "presentation.json"]);
  assert.match(declared.stdout, /Declared App Project presentation "Connected Inbox" \[project_1\] in Fold Connected Folder \[connected-folder-1\]\. This is the Project's first declared presentation\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", presentationPath: "presentation.json", cwd });
  assert.deepEqual(lastOk().undoRef, { kind: "app-presentation-ref", value: "none" });

  const prepared = await execute(["apps", "release", "prepare", "--connected-folder", "connected-folder-1", "--version", "1.0.0"]);
  assert.match(prepared.stdout, /Prepared Release 1\.0\.0 \[sha256:a+\] in Fold Connected Folder \[connected-folder-1\] \(1 Feature\)\./);
  assert.match(prepared.stdout, /Later source edits cannot alter its bytes/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", version: "1.0.0" });
  assert.equal(lastOk().detail, `release ${releaseDigest}`);
  assert.deepEqual(lastOk().undoRef, { kind: "release-digest", value: releaseDigest });

  const published = await execute(["apps", "release", "publish", "--connected-folder", "connected-folder-1", "--release", releaseDigest]);
  assert.match(published.stdout, /Published Release 1\.0\.0 \[sha256:a+\] in Fold Connected Folder \[connected-folder-1\]\./);
  assert.match(published.stdout, /local state transition — nothing is uploaded, hosted, listed, or granted\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", release: releaseDigest });

  const installPrepared = await execute(["apps", "install", "prepare", "--connected-folder", "connected-folder-1", "--release", releaseDigest, "--target-connected-folder", "connected-folder-2"]);
  assert.match(installPrepared.stdout, /Prepared install of Release \[sha256:a+\] into Target Connected Folder \[connected-folder-2\] — operation operation_1\./);
  assert.match(installPrepared.stdout, /every power starts off\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", release: releaseDigest, targetConnectedFolder: "connected-folder-2" });
  assert.equal(lastOk().detail, "operation operation_1");
  assert.deepEqual(lastOk().undoRef, { kind: "operation-id", value: "operation_1" });

  const activated = await execute(["apps", "operation", "activate", "--connected-folder", "connected-folder-1", "--operation", "operation_1"]);
  assert.match(activated.stdout, /Activated install operation operation_1: instance runtime-instance_1 now runs Release 1\.0\.0 \[sha256:a+\]\. Every power starts off\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", operation: "operation_1" });
  assert.equal(lastOk().detail, `operation operation_1; release ${releaseDigest}`);

  const updatePrepared = await execute(["apps", "update", "prepare", "--connected-folder", "connected-folder-1", "--instance", "runtime-instance_1", "--release", releaseDigest]);
  assert.match(updatePrepared.stdout, /Prepared update of instance runtime-instance_1 from Release \[sha256:b+\] to \[sha256:a+\] — operation operation_2\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", instance: "runtime-instance_1", release: releaseDigest });
  assert.equal(lastOk().detail, `operation operation_2; from ${priorDigest}; to ${releaseDigest}`);
  assert.deepEqual(lastOk().undoRef, { kind: "operation-id", value: "operation_2" });

  const cancelled = await execute(["apps", "operation", "cancel", "--connected-folder", "connected-folder-1", "--operation", "operation_2"]);
  assert.match(cancelled.stdout, /Cancelled prepared operation operation_2\. Prepare it again when needed\./);
  assert.equal(lastOk().detail, "operation operation_2");

  const uninstalled = await execute(["apps", "uninstall", "--connected-folder", "connected-folder-1", "--instance", "runtime-instance_1", "--retain-data"]);
  assert.match(uninstalled.stdout, /Uninstalled instance runtime-instance_1 from Fold Connected Folder \[connected-folder-1\], retaining 1 data namespace\./);
  assert.match(uninstalled.stdout, /Retained data does not remain runnable, and reinstalling creates a new instance\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", instance: "runtime-instance_1" });
  assert.equal(lastOk().detail, "instance runtime-instance_1; retained data-namespace_1");

  const deletedRelease = await execute(["apps", "release", "delete", "--connected-folder", "connected-folder-1", "--release", releaseDigest]);
  assert.match(deletedRelease.stdout, /Deleted unused Release \[sha256:a+\] in Fold Connected Folder \[connected-folder-1\]\./);
  assert.equal(lastOk().detail, `release ${releaseDigest}`);
  assert.equal(lastOk().undoRef, undefined);

  // The AmpleFile agent reads what an app can do, then runs one of its declared tools.
  const listedApps = await execute(["apps", "list", "--connected-folder", "connected-folder-1"]);
  assert.match(listedApps.stdout, /1 app in Fold Connected Folder \[connected-folder-1\]:/);
  assert.match(listedApps.stdout, /- Connected inbox 0\.1\.0 \[connected-inbox\] \(preview\)/);
  assert.match(listedApps.stdout, /tools: summarize/);
  assert.match(listedApps.stdout, /automations: daily-sync on/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1" });
  assert.equal(lastOk().detail, "apps 1");
  const listedJson = JSON.parse((await execute(["apps", "list", "--connected-folder", "connected-folder-1", "--json"])).stdout);
  assert.equal(listedJson.data.apps[0].tools[0].inputSchema.type, "object", "a caller can build --input from the listing alone");
  assert.deepEqual(listedJson.data.apps[0].assistantActions, [{ id: "compare", title: "Compare quotes" }]);

  const invoked = await execute(["apps", "invoke", "--connected-folder", "connected-folder-1", "--app", "connected-inbox", "--tool", "summarize", "--input", "{\"text\":\"North $42\"}", "--parent-task", "task-9"]);
  assert.match(invoked.stdout, /Ran summarize of connected-inbox in Fold Connected Folder \[connected-folder-1\]\./);
  assert.match(invoked.stdout, /Two quotes, North is cheaper\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", app: "connected-inbox", tool: "summarize", input: { text: "North $42" }, parentTaskId: "task-9" });
  assert.equal(lastOk().parentTaskId, "task-9");
  assert.match(String(lastOk().detail), /^app connected-inbox; tool summarize; result \d+ bytes$/);

  // The connected-folder-app authority direct verbs: narrowing, neutral, and widening
  // alike, with honest receipt details. Under F21 `apps grant` is a direct
  // receipted verb too; nothing here waits on a second act.
  const proposals = await execute(["apps", "proposals", "list", "--connected-folder", "connected-folder-1", "--conversation", "conv-1"]);
  assert.match(proposals.stdout, /1 app proposal in Chat \[conv-1\] of Fold Connected Folder \[connected-folder-1\]:/);
  assert.match(proposals.stdout, /- Connected inbox 0\.1\.0 \[proposal-1\] — pending — digest d+/);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", conversationId: "conv-1" });

  const dismissed = await execute(["apps", "proposals", "dismiss", "--connected-folder", "connected-folder-1", "--conversation", "conv-1", "--proposal", "proposal-1"]);
  assert.match(dismissed.stdout, /Dismissed app proposal proposal-1 in Fold Connected Folder \[connected-folder-1\]\. Nothing runnable existed; the Worker may propose again\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", conversationId: "conv-1", proposal: "proposal-1" });
  assert.equal(lastOk().detail, "proposal proposal-1");

  const removedApp = await execute(["apps", "remove", "--connected-folder", "connected-folder-1", "--app", "connected-inbox"]);
  assert.match(removedApp.stdout, /Removed app connected-inbox \[digest d+\] from Fold Connected Folder \[connected-folder-1\]\. Reinstalling it is a fresh receipted act/);
  // Removing a preview takes its data with it, so the removal names the
  // recoverable copy it left behind (docs/receipts-not-gates.md, F20).
  assert.match(removedApp.stdout, /Its data is in Recently deleted until 2026-10-10T00:00:00\.000Z — save it with 'recently-deleted restore --entry trash-app-1 --to <path>'\./);
  assert.deepEqual(calls.at(-1)?.input, { connectedFolder: "connected-folder-1", app: "connected-inbox", requestId: lastOk().requestId });
  assert.equal(lastOk().detail, `app connected-inbox; digest ${"d".repeat(64)}; recently-deleted trash-app-1`);

  const revoked = await execute(["apps", "revoke", "--connected-folder", "connected-folder-1", "--app", "connected-inbox", "--digest", "d".repeat(64), "--kind", "files", "--declaration", "connected-folder-notes"]);
  assert.match(revoked.stdout, /Revoked the files grant connected-folder-notes from connected-inbox in Fold Connected Folder \[connected-folder-1\]\. Re-granting it is a fresh receipted act/);
  assert.deepEqual(calls.at(-1)?.input, {
    connectedFolder: "connected-folder-1",
    app: "connected-inbox",
    digest: "d".repeat(64),
    kind: "files",
    declaration: "connected-folder-notes",
  });
  assert.equal(lastOk().detail, "app connected-inbox; kind files; declaration connected-folder-notes");

  const revokeMiss = await execute(["apps", "revoke", "--connected-folder", "connected-folder-1", "--app", "connected-inbox", "--digest", "d".repeat(64), "--kind", "network", "--declaration", "never-granted"]);
  assert.match(revokeMiss.stdout, /was not granted in Fold Connected Folder \[connected-folder-1\]; authority is unchanged\./);
  assert.equal(lastOk().detail, "app connected-inbox; kind network; declaration never-granted (was not granted)");

  const disconnected = await execute(["apps", "disconnect", "--connected-folder", "connected-folder-1", "--app", "connected-inbox", "--destination", "crm"]);
  assert.match(disconnected.stdout, /Removed the saved connection to crm from connected-inbox in Fold Connected Folder \[connected-folder-1\]\./);
  assert.match(disconnected.stdout, /Deleting the local record does not revoke the credential at its provider\./);
  assert.equal(lastOk().detail, "app connected-inbox; destination crm; local record only — provider credential not revoked");

  const disabledAppAutomation = await execute(["apps", "automation", "disable", "--connected-folder", "connected-folder-1", "--app", "connected-inbox", "--automation", "daily-sync"]);
  assert.match(disabledAppAutomation.stdout, /Disabled automation daily-sync of connected-inbox in Fold Connected Folder \[connected-folder-1\]\. Re-enabling it is a fresh receipted act/);
  assert.equal(lastOk().detail, "app connected-inbox; automation daily-sync");

  const ranAppAutomation = await execute(["apps", "automation", "run", "--connected-folder", "connected-folder-1", "--app", "connected-inbox", "--automation", "daily-sync"]);
  assert.match(ranAppAutomation.stdout, /Automation daily-sync of connected-inbox ran with outcome success \(run run-77\)\./);
  assert.equal(lastOk().detail, "app connected-inbox; automation daily-sync; run run-77; outcome success");

  // The uninstall disposition executes immediately: the executor routes
  // `--purge-data` to the purge method, never to the retain-only uninstall.
  records.length = 0;
  const purge = await execute(["apps", "uninstall", "--connected-folder", "connected-folder-1", "--instance", "runtime-instance_1", "--purge-data"]);
  assert.equal(purge.exitCode, 0);
  assert.match(purge.stdout, /^Uninstalled instance runtime-instance_1 from Fold Connected Folder \[connected-folder-1\] and purged its data\.\nSome app cleanup is still pending; AmpleFile finishes it on the next start\.\n$/);
  assert.equal(calls.at(-1)?.method, "appsUninstallPurge");
  assert.deepEqual(records.map((record) => record.outcome), ["accepted", "ok"]);
  assert.equal(lastOk().decisionId, undefined);
  assert.equal(lastOk().detail, "app.data.purge; instance runtime-instance_1");
});

test("the ledger families ride the act protocol v3 envelope", () => {
  assert.equal(AMPLEFILE_CLI_ACT_PROTOCOL_VERSION, 3);
  const id = randomUUID();
  const argv = ["connected-folders", "delete", "--connected-folder", "connected-folder-1"];
  const request = createAmpleFileCliActRequest({ id, argv, cwd, actToken: token });
  assert.deepEqual(
    Object.keys(request).sort(),
    ["actToken", "argv", "createdAt", "cwd", "id", "lane", "protocolVersion"],
  );
  assert.equal(request.protocolVersion, 3);
  assert.equal(request.lane, "act");
  assert.deepEqual(request.argv, argv);

  // The envelope gains no decision fields; unknown keys still fail closed.
  assert.throws(
    () => parseAmpleFileCliActRequest({
      protocolVersion: 3,
      lane: "act",
      id: randomUUID(),
      argv: ["connected-folders", "delete", "--connected-folder", "connected-folder-1"],
      cwd,
      createdAt,
      actToken: token,
      decisionId: "decision-1",
    }),
    /unsupported field: decisionId/,
  );
});

test("Check and correction proposals use explicit inert act verbs", () => {
  for (const verb of ["propose", "propose-fix"]) {
    assert.deepEqual(parseAmpleFileCliActArgv(["checks", verb, "--connected-folder", "connected-folder-1", "--proposal", "review.json", "--json"]), {
      name: `checks.${verb}`, connectedFolder: "connected-folder-1", proposalPath: "review.json", output: "json",
    });
    assert.throws(() => parseAmpleFileCliActArgv(["checks", verb, "--proposal", "review.json"]), /connected-folder/i);
    assert.throws(() => parseAmpleFileCliActArgv(["checks", verb, "--connected-folder", "connected-folder-1", "--proposal", "review.json", "--enable"]), /flag|option/i);
  }
});


test("resource enablement verbs require exact scope, kind and path", () => {
  const args = ["--scope", "everywhere", "--kind", "extensions", "--path", "/tools/example.ts"];
  assert.equal(parseAmpleFileCliActArgv(["tools", "enable", ...args]).name, "tools.enable");
  assert.equal(parseAmpleFileCliActArgv(["tools", "disable", ...args]).name, "tools.disable");
  assert.throws(() => parseAmpleFileCliActArgv(["tools", "enable", "--scope", "connected-folder", "--kind", "extensions", "--path", "/tools/example.ts"]), /connected-folder/i);
  assert.throws(() => parseAmpleFileCliActArgv(["tools", "enable", "--scope", "everywhere", "--kind", "made-up", "--path", "/tools/example.ts"]), /kind/);
});

test("--summary-file, --question-file, --answer-file, and --instructions-file carry text longer than one argument", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "amplefile-act-text-files-"));
  try {
    // Larger than the 8 KiB argument cap these flags replace, and multi-line.
    const long = (label: string) => `${label}\n${"line of text\n".repeat(4_000)}`;
    await writeFile(join(directory, "summary.md"), long("summary"));
    await writeFile(join(directory, "question.md"), long("question"));
    await writeFile(join(directory, "answer.md"), long("answer"));
    await writeFile(join(directory, "instructions.md"), long("instructions"));
    await writeFile(join(directory, "empty.md"), "   \n");
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const record = (method: string) => async (input: Record<string, unknown>) => {
      calls.push({ method, input });
      return { ok: true };
    };
    const facade = {
      chatReport: record("chatReport"),
      chatAsk: record("chatAsk"),
      chatAnswer: record("chatAnswer"),
      workerSetInstructions: record("workerSetInstructions"),
    } as unknown as AmpleFileActFacade;
    const execute = (argv: string[]) => executeAmpleFileCliActRequest(
      createAmpleFileCliActRequest({ id: randomUUID(), argv: [...argv, "--json"], cwd: directory, actToken: token }),
      { version: "test", getActFacade: () => ({ facade, token }), receipts: { hasAccepted: async () => false, append: async () => true } },
    );

    for (const [argv, method, field, file] of [
      [["chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary-file", "summary.md"], "chatReport", "summary", "summary.md"],
      [["chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1", "--question-file", "question.md"], "chatAsk", "question", "question.md"],
      [["chat", "answer", "--connected-folder", "connected-folder-1", "--question", "q-1", "--answer-file", join(directory, "answer.md")], "chatAnswer", "answer", "answer.md"],
      [["connected-folders", "worker", "instructions", "--connected-folder", "connected-folder-1", "--instructions-file", "instructions.md"], "workerSetInstructions", "instructions", "instructions.md"],
    ] as const) {
      const response = await execute([...argv]);
      assert.equal(response.exitCode, 0, response.stderr);
      const call = calls.at(-1)!;
      assert.equal(call.method, method);
      assert.equal(call.input[field], long(file.replace(".md", "")), `${method} received the whole file`);
    }

    const both = await execute(["chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary", "x", "--summary-file", "summary.md"]);
    assert.match(both.stderr, /Use either --summary <text> or --summary-file <path>, not both\./);
    const missing = await execute(["chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary-file", "absent.md"]);
    assert.match(missing.stderr, /--summary-file absent\.md: the file could not be read\./);
    const empty = await execute(["chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1", "--question-file", "empty.md"]);
    assert.match(empty.stderr, /--question-file empty\.md is empty\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
