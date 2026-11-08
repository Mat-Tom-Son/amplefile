import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import {
  normalizeAmpleFileAutomationProposal,
  ampleFileAutomationMessagePlaceholders,
} from "../src/local/automations/automation-declarations.js";

import {
  AMPLEFILE_CLI_PROTOCOL_VERSION,
  AmpleFileCliError,
  AmpleFileCliExitCode,
  createAmpleFileCliRequest,
  createAmpleFileCliResponse,
  executeAmpleFileCliRequest,
  parseAmpleFileCliActArgv,
  parseAmpleFileCliArgv,
  parseAmpleFileCliRequest,
  parseAmpleFileCliResponse,
  ampleFileCliHelp,
  type AmpleFileCliActor,
  type AmpleFileCliKernel,
} from "../src/local/cli/index.js";
import {
  ampleFileQuestionIdPattern,
  ampleFileRequestIdPattern,
  ampleFileRequestLimitMessage,
} from "../src/local/requests/request-records.js";
import { ampleFileRequestLimits, ampleFileAutomationDeclarationBounds } from "../src/shared/amplefile-limits.js";

test("CLI request and response schemas preserve the locked protocol fields", () => {
  const id = randomUUID();
  const cwd = resolve(".");
  const request = createAmpleFileCliRequest({ id, argv: ["connected-folders", "list", "--json"], cwd, createdAt: "2026-07-11T12:00:00.000Z" });
  assert.deepEqual(request, {
    protocolVersion: 1,
    id,
    argv: ["connected-folders", "list", "--json"],
    cwd,
    createdAt: "2026-07-11T12:00:00.000Z",
  });

  const response = createAmpleFileCliResponse({ id, exitCode: 0, stdout: "ok\n", stderr: "" });
  assert.deepEqual(response, { protocolVersion: 1, id, exitCode: 0, stdout: "ok\n", stderr: "" });
  assert.deepEqual(parseAmpleFileCliResponse(JSON.parse(JSON.stringify(response))), response);
});

test("CLI protocol rejects unknown fields, bad versions, invalid ids, relative cwd, and invalid output", () => {
  const base = {
    protocolVersion: AMPLEFILE_CLI_PROTOCOL_VERSION,
    id: randomUUID(),
    argv: [],
    cwd: resolve("."),
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => parseAmpleFileCliRequest({ ...base, extra: true }), /unsupported field/);
  assert.throws(() => parseAmpleFileCliRequest({ ...base, protocolVersion: 2 }), /Unsupported CLI protocol version/);
  assert.throws(() => parseAmpleFileCliRequest({ ...base, id: "..\\escape" }), /UUID/);
  assert.throws(() => parseAmpleFileCliRequest({ ...base, cwd: "relative" }), /absolute path/);
  assert.throws(() => parseAmpleFileCliResponse({ protocolVersion: 1, id: base.id, exitCode: 99, stdout: "", stderr: "" }), /exitCode/);
  assert.throws(() => parseAmpleFileCliResponse({ protocolVersion: 1, id: base.id, exitCode: 0, stdout: "", stderr: "", result: { invalid: undefined } }), /JSON-serializable/);
});

test("CLI argv parser supports every foundation command with global flags in either position", () => {
  assert.deepEqual(parseAmpleFileCliArgv([]), { name: "help", output: "human" });
  assert.deepEqual(parseAmpleFileCliArgv(["--json", "context", "--connected-folder", "Everywhere"]), {
    name: "context",
    output: "json",
    connectedFolder: "Everywhere",
  });
  assert.deepEqual(parseAmpleFileCliArgv(["connected-folders", "list", "--connected-folder=space-1234567890abcdef", "--json"]), {
    name: "connected-folders.list",
    output: "json",
    connectedFolder: "space-1234567890abcdef",
  });
  assert.deepEqual(parseAmpleFileCliArgv(["tasks", "list"]), { name: "tasks.list", output: "human" });
  assert.deepEqual(parseAmpleFileCliArgv(["capabilities", "list", "--connected-folder", "space-aaaaaaaaaaaaaaaa"]), {
    name: "capabilities.list",
    output: "human",
    connectedFolder: "space-aaaaaaaaaaaaaaaa",
  });
  assert.deepEqual(parseAmpleFileCliArgv(["version", "--json"]), { name: "version", output: "json" });
  assert.deepEqual(parseAmpleFileCliArgv(["--version", "--json"]), { name: "version", output: "json" });
  assert.deepEqual(parseAmpleFileCliArgv(["help", "tasks", "--json"]), { name: "help", output: "json", topic: "tasks" });
  assert.deepEqual(parseAmpleFileCliArgv(["connected-folders", "--help"]), { name: "help", output: "human", topic: "connected-folders" });
});

test("CLI argv parser produces stable usage errors", () => {
  for (const argv of [
    ["unknown"],
    ["connected-folders"],
    ["connected-folders", "list", "extra"],
    ["--wat"],
    ["context", "--connected-folder"],
    ["context", "--connected-folder", "one", "--connected-folder", "two"],
    ["version", "--connected-folder", "one"],
    ["checks", "status"],
  ]) {
    assert.throws(
      () => parseAmpleFileCliArgv(argv),
      (error) => error instanceof AmpleFileCliError && error.exitCode === AmpleFileCliExitCode.usage && /amplefile help/.test(error.message),
      argv.join(" "),
    );
  }
});

test("CLI help covers every landed act family and is honest about what it runs", () => {
  // The spelled verb inventory of docs/act-ledger.md plus the sibling
  // automations plan, as the act argv parser accepts them. Growing the
  // act table without growing help fails here on purpose.
  const families: Record<string, string[]> = {
    chat: [
      "create", "send", "status", "result", "wait", "abort", "rename", "snooze", "archive", "resume", "compact",
      "report", "ask", "answer", "handoff",
    ],
    chats: ["list"],
    agent: ["send", "status", "result", "wait", "stop", "abort", "list", "overview"],
    history: ["list", "save", "restore", "versions", "restore-file"],
    search: [""],
    files: ["add", "move", "rename", "delete", "mkdir", "create"],
    "connected-folders": [
      "list", "create", "register", "rename", "unregister", "delete",
      "appearance apply", "appearance reset", "appearance undo",
      "worker show", "worker model", "worker instructions",
    ],
    tools: ["import-skill", "install", "update", "remove"],
    apps: [
      "list", "invoke", "proposals list", "proposals dismiss", "install-proposal", "install-preview", "remove",
      "grant", "revoke", "connect", "disconnect", "automation enable", "automation disable",
      "automation run", "storage clear", "retained purge", "project declare", "release prepare",
      "release publish", "release delete", "install prepare", "update prepare",
      "operation activate", "operation cancel", "uninstall",
    ],
    automations: ["enable", "list", "show", "run", "stop", "disable", "delete", "receipts"],
    "recently-deleted": ["list", "restore"],
    requests: ["list", "show"],
    jobs: ["start", "list", "show", "output", "stop"],
    worktrees: ["manage"],
  };
  const overview = ampleFileCliHelp("AmpleFile");
  for (const [family, verbs] of Object.entries(families)) {
    const topic = ampleFileCliHelp("AmpleFile", family);
    assert.notEqual(topic, overview, `'${family}' needs a dedicated help topic`);
    assert.match(overview, new RegExp(`\\b${family}\\b`), `the overview must list ${family}`);
    for (const verb of verbs) {
      const spelled = verb ? `${family} ${verb}` : family;
      assert.ok(topic.includes(`amplefile ${spelled} `), `help ${family} must show usage for '${spelled}'`);
    }
  }
  // Every verb runs immediately and leaves a receipt (docs/receipts-not-gates.md):
  // no family topic promises a gate, and none of the retired vocabulary survives.
  // `collaborate` is a topic without a verb family of its own, so the loop
  // names it explicitly rather than picking it up from the table.
  for (const family of [...Object.keys(families), "collaborate"]) {
    const topic = ampleFileCliHelp("AmpleFile", family);
    assert.doesNotMatch(topic, /[Ss]taged|pending decision|decision card|needs-you card|approv|Reviewed mode|Unrestricted|polic/, `help ${family} must not describe a gate`);
  }
  assert.doesNotMatch(overview, /[Ss]taged|decision|approv|Reviewed|Unrestricted|polic/);
  // Pages were removed on 2026-11-07: no family, no topic.
  assert.doesNotMatch(overview, /pages validate/);
  assert.equal(ampleFileCliHelp("AmpleFile", "pages"), overview);
  assert.match(ampleFileCliHelp("AmpleFile", "tools"), /immediately with a receipt/);
  assert.match(ampleFileCliHelp("AmpleFile", "apps"), /--purge-data/);
  // A single-file permission is granted by naming its file; a folder
  // permission covers the whole Connected Folder (docs/receipts-not-gates.md, F21).
  assert.match(ampleFileCliHelp("AmpleFile", "apps"), /--kind <network\|files\|notifications> --declaration <id> \[--path <connected-folder-path>\]/);
  assert.match(ampleFileCliHelp("AmpleFile", "apps"), /names a single file needs\n?.*--path <connected-folder-path>/);
  // Recently deleted is where a delete History could not fully cover goes
  // (docs/receipts-not-gates.md, F20), and nothing empties it early.
  const recentlyDeletedTopic = ampleFileCliHelp("AmpleFile", "recently-deleted");
  assert.match(recentlyDeletedTopic, /Recently deleted holds what a delete could not leave to History/);
  assert.match(recentlyDeletedTopic, /30 days by default/);
  assert.match(recentlyDeletedTopic, /Nothing empties Recently deleted early/);
  assert.match(overview, /recently-deleted list\|restore\s+Bring back what was deleted/);
  assert.match(ampleFileCliHelp("AmpleFile", "files"), /moves to Recently deleted instead/);
  assert.match(ampleFileCliHelp("AmpleFile", "connected-folders"), /moves\na managed Connected Folder to Recently deleted/);
  assert.doesNotMatch(overview, /files destroy|\bdestroy\b/);
  // The setup-only boundary stays visible where an agent looks first.
  assert.match(overview, /local setup/);
  assert.match(overview, /runs immediately and leaves a receipt/);
});

test("CLI executor passes actor cwd and Connected Folder scope through the narrow kernel", async () => {
  const calls: Array<{ method: string; actor: AmpleFileCliActor; connectedFolder?: string }> = [];
  const kernel = fixtureKernel(calls);
  const cwd = resolve("test-connected-folder");
  const commands = [
    ["context", "--connected-folder", "space-aaaaaaaaaaaaaaaa"],
    ["connected-folders", "list", "--connected-folder", "space-aaaaaaaaaaaaaaaa"],
    ["tasks", "list", "--connected-folder", "space-aaaaaaaaaaaaaaaa"],
    ["capabilities", "list", "--connected-folder", "space-aaaaaaaaaaaaaaaa"],
  ];
  for (const argv of commands) {
    const response = await executeAmpleFileCliRequest(
      createAmpleFileCliRequest({ id: randomUUID(), argv, cwd }),
      kernel,
      { version: "1.2.3", now: () => new Date("2026-07-11T12:00:00.000Z") },
    );
    assert.equal(response.exitCode, AmpleFileCliExitCode.success);
    assert.equal(response.stderr, "");
    assert.equal(response.completedAt, "2026-07-11T12:00:00.000Z");
  }
  assert.deepEqual(calls.map(({ method, actor, connectedFolder }) => ({ method, actor, connectedFolder })), [
    { method: "context", actor: { kind: "cli", cwd }, connectedFolder: "space-aaaaaaaaaaaaaaaa" },
    { method: "connected-folders", actor: { kind: "cli", cwd }, connectedFolder: "space-aaaaaaaaaaaaaaaa" },
    { method: "tasks", actor: { kind: "cli", cwd }, connectedFolder: "space-aaaaaaaaaaaaaaaa" },
    { method: "capabilities", actor: { kind: "cli", cwd }, connectedFolder: "space-aaaaaaaaaaaaaaaa" },
  ]);
});

test("CLI executor emits useful human output and a stable JSON envelope", async () => {
  const kernel = fixtureKernel([]);
  const cwd = resolve(".");
  const human = await executeAmpleFileCliRequest(
    createAmpleFileCliRequest({ id: randomUUID(), argv: ["connected-folders", "list"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /Everywhere \[space-aaaaaaaaaaaaaaaa\].*test-connected-folder/);
  assert.equal(human.stderr, "");

  const json = await executeAmpleFileCliRequest(
    createAmpleFileCliRequest({ id: randomUUID(), argv: ["capabilities", "list", "--json"], cwd }),
    kernel,
    { version: "1.2.3" },
  );
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: true,
    command: "capabilities.list",
    data: {
      capabilities: [{ id: "skill-a", name: "Example Skill", kind: "skill", scope: "connected-folder", status: "loaded", source: ".pi/skills/example" }],
      total: 1,
    },
  });
  assert.deepEqual(json.result, JSON.parse(json.stdout).data);
});

test("CLI human output neutralizes terminal control sequences from host metadata and errors", async () => {
  const hostile = "before\u001b]8;;https://example.invalid\u0007click\u001b]8;;\u0007\u009b31m\u202eafter";
  const kernel: AmpleFileCliKernel = {
    async getContext() {
      return { cwd: hostile, connectedFolder: { id: hostile, name: hostile, connectedFolderRoot: hostile }, selectedPath: hostile, activeSurface: hostile };
    },
    async listConnectedFolders() {
      return [{ id: hostile, name: hostile, connectedFolderRoot: hostile }];
    },
    async listTasks() {
      return [{ id: hostile, label: hostile, status: hostile, connectedFolderId: hostile }];
    },
    async listCapabilities() {
      return [{ id: hostile, name: hostile, kind: "other", scope: hostile, status: hostile, source: hostile }];
    },
  };
  const cwd = resolve(".");
  for (const argv of [["context"], ["connected-folders", "list"], ["tasks", "list"], ["capabilities", "list"]]) {
    const response = await executeAmpleFileCliRequest(createAmpleFileCliRequest({ id: randomUUID(), argv, cwd }), kernel, { version: "1.2.3" });
    assert.equal(response.exitCode, 0);
    assert.doesNotMatch(response.stdout, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  }

  const failingKernel: AmpleFileCliKernel = {
    ...kernel,
    async getContext() { throw new Error(hostile); },
  };
  const failure = await executeAmpleFileCliRequest(
    createAmpleFileCliRequest({ id: randomUUID(), argv: ["context"], cwd }),
    failingKernel,
    { version: "1.2.3" },
  );
  assert.doesNotMatch(failure.stderr, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
});

test("Automation help's complete authoring example passes the real proposal validator", () => {
  const example = ampleFileCliHelp("AmpleFile", "automations").split("\n").find((line) => line.startsWith('{"kind":"amplefile.automation-proposal"'));
  assert.ok(example);
  const proposal = normalizeAmpleFileAutomationProposal(JSON.parse(example));
  assert.equal(proposal.version, 5);
  assert.equal(proposal.automation.trigger.kind, "files-changed");
  // The example teaches the version-5 catch-up (docs/automations.md, 2026-10-11).
  assert.equal(proposal.automation.trigger.kind === "files-changed" && proposal.automation.trigger.ifMissed, "run");
  assert.deepEqual(proposal.automation.steps.map((step) => step.kind), ["files", "chat", "agent"]);
  // The example teaches the closed placeholder set, so it must itself be
  // something the parser accepts and the executor can fill in.
  const adopt = proposal.automation.steps[1] as { message: string };
  assert.deepEqual(
    ampleFileAutomationMessagePlaceholders(adopt.message).map((entry) => entry.name),
    ["trigger.changedFiles"],
  );
  const report = proposal.automation.steps[2] as { message: string };
  assert.deepEqual(
    ampleFileAutomationMessagePlaceholders(report.message).map((entry) => entry.name),
    ["trigger.summary", "steps.adopt.createdFiles"],
  );
  const help = ampleFileCliHelp("AmpleFile", "automations");
  assert.match(help, /never a backlog of missed events/);
  assert.match(help, /Debounce: 1–3600 seconds\. Cooldown: 0–10080 minutes\. Up to 64 runs may/);
  assert.doesNotMatch(help, /Up to 16 steps/);
  assert.doesNotMatch(help, /staged|approve|policy|Reviewed|Unrestricted|\bcard\b|\bmode\b/i);
});

test("help collaborate's worked example parses through the real act parser", () => {
  const help = ampleFileCliHelp("AmpleFile", "collaborate");
  const example = help.split("\n").filter((line) => line.startsWith("  $ amplefile "));
  // send -> wait -> answer -> report -> wait -> requests show: the whole F27
  // round trip, so a flag spelled one way in help and another in the parser
  // fails here instead of in someone's terminal.
  assert.equal(example.length, 6);
  const argvs = example.map((line) => exampleArgv(line.slice("  $ amplefile ".length)));
  const parsed = argvs.map((argv) => {
    if (argv[0] === "chat" && argv[1] === "wait") {
      // The wait loop runs inside the installed shim, not the host, so the
      // host parser refuses it on purpose and says where it lives.
      assert.throws(() => parseAmpleFileCliActArgv(argv), /runs inside the AmpleFile shim/);
      return "chat.wait";
    }
    return parseAmpleFileCliActArgv(argv).name;
  });
  assert.deepEqual(parsed, ["chat.send", "chat.wait", "chat.answer", "chat.report", "chat.wait", "requests.show"]);
  // The lineage has to be runnable, not only parseable. An answer starts a
  // NEW turn, so the report and the wait that follow it must not reuse the
  // task id from the wait that came before it: the host refuses an older
  // turn's id ("use the turn that is running now").
  const taskOf = (argv: string[]): string | undefined => argv[argv.indexOf("--task") + 1];
  const askedTask = taskOf(argvs[1]!);
  assert.ok(askedTask);
  for (const index of [3, 4]) {
    assert.notEqual(taskOf(argvs[index]!), askedTask, "the continuation is its own turn, with its own task id");
  }
  assert.equal(taskOf(argvs[3]!), taskOf(argvs[4]!), "the report and the wait after it follow the same continuation");
  // The example ids are the shapes the host actually mints, so an agent
  // copying the shape does not build ids every verb rejects.
  assert.match(argvs[2]![argvs[2]!.indexOf("--question") + 1]!, ampleFileQuestionIdPattern);
  assert.match(argvs[5]![argvs[5]!.indexOf("--request") + 1]!, ampleFileRequestIdPattern);
  // The topic documents every verb the contract lists, in the contract's own
  // spelling, so an agent reading help sees the shape the parser accepts.
  for (const spelled of [
    "chat report", "chat ask", "chat answer", "chat handoff", "chat wait", "agent wait", "requests list", "requests show",
  ]) {
    assert.ok(help.includes(`amplefile ${spelled} `), `help collaborate must show usage for '${spelled}'`);
  }
  // Bounds are visible where a person can change them, and a refusal names
  // the same place (docs/receipts-not-gates.md, principle 6).
  assert.match(help, /Settings → (?:Automations|Recently deleted)/);
  assert.match(help, /Nothing waits on someone clicking something\./);
  assert.doesNotMatch(help, /\bcard\b|\bmode\b|sandboxed/i);
});

test("the act parser accepts the four collaboration verbs and the request reads", () => {
  assert.deepEqual(
    parseAmpleFileCliActArgv([
      "chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1",
      "--summary", "Drafted the note.", "--file", "drafts/q3.md", "--file", "drafts/q3-data.csv",
      "--data", '{"words":812}', "--outcome", "partial", "--json",
    ]),
    {
      name: "chat.report", output: "json", connectedFolder: "connected-folder-1", task: "task-1",
      summary: "Drafted the note.", files: ["drafts/q3.md", "drafts/q3-data.csv"],
      outcome: "partial", resultData: { words: 812 },
    },
  );
  // An outcome is succeeded unless the reporter says otherwise, and a report
  // that names no file carries an empty list rather than a missing field.
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary", "Done."]),
    { name: "chat.report", output: "human", connectedFolder: "connected-folder-1", task: "task-1", summary: "Done.", files: [], outcome: "succeeded" },
  );
  // `--data @<path>` defers the read to the host, which resolves it against
  // the directory the command ran in; argv could not carry 256 KiB anyway.
  assert.deepEqual(
    parseAmpleFileCliActArgv([
      "chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary", "Done.", "--data", "@out/result.json",
    ]),
    {
      name: "chat.report", output: "human", connectedFolder: "connected-folder-1", task: "task-1",
      summary: "Done.", files: [], outcome: "succeeded", resultDataPath: "out/result.json",
    },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1", "--question", "Which quarter?"]),
    { name: "chat.ask", output: "human", connectedFolder: "connected-folder-1", task: "task-1", question: "Which quarter?", respondent: "person" },
  );
  assert.equal(
    parseAmpleFileCliActArgv([
      "chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1", "--question", "Which quarter?", "--to", "parent",
    ]).respondent,
    "parent",
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv([
      "chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1", "--question", "Which quarter?", "--option", "Q3", "--option", " Q4 ",
    ]).options,
    ["Q3", "Q4"],
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["agent", "ask", "--task", "task-1", "--question", "Ship it?", "--option", "Yes", "--option", "Not yet"]).options,
    ["Yes", "Not yet"],
  );
  // --question carries free text for ask and an id for answer. That is the
  // contract's spelling (docs/collaboration-contract.md), not a slip.
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "answer", "--connected-folder", "connected-folder-1", "--question", "question-1", "--answer", "November."]),
    { name: "chat.answer", output: "human", connectedFolder: "connected-folder-1", questionId: "question-1", answer: "November." },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv([
      "chat", "handoff", "--connected-folder", "connected-folder-1", "--task", "task-1", "--to-connected-folder", "connected-folder-2",
      "--message", "Take this on.", "--file", "drafts/q3.md",
    ]),
    {
      name: "chat.handoff", output: "human", connectedFolder: "connected-folder-1", task: "task-1", toConnectedFolder: "connected-folder-2",
      message: "Take this on.", files: ["drafts/q3.md"],
    },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv([
      "chat", "handoff", "--connected-folder", "connected-folder-1", "--task", "task-1", "--to-connected-folder", "connected-folder-2", "--message-from-payload",
    ]),
    {
      name: "chat.handoff", output: "human", connectedFolder: "connected-folder-1", task: "task-1", toConnectedFolder: "connected-folder-2",
      messageFromPayload: true, files: [],
    },
  );
  assert.equal(
    parseAmpleFileCliActArgv([
      "chat", "handoff", "--connected-folder", "connected-folder-1", "--task", "task-1", "--to-connected-folder", "connected-folder-2", "--to-conversation", "chat-7", "--message", "One more thing.",
    ]).toConversation,
    "chat-7",
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "steer", "--connected-folder", "connected-folder-2", "--conversation", "chat-7", "--task", "task-1", "--message", "Also check Q4."]),
    { name: "chat.steer", output: "human", connectedFolder: "connected-folder-2", conversation: "chat-7", task: "task-1", message: "Also check Q4." },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "copy", "--connected-folder", "connected-folder-1", "--conversation", "chat-7", "--title", "Plan B"]),
    { name: "chat.copy", output: "human", connectedFolder: "connected-folder-1", conversation: "chat-7", title: "Plan B" },
  );
  assert.deepEqual(
    parseAmpleFileCliActArgv(["chat", "copy", "--connected-folder", "connected-folder-1", "--conversation", "chat-7", "--task", "task-1", "--message", "Try it as a table."]),
    { name: "chat.copy", output: "human", connectedFolder: "connected-folder-1", conversation: "chat-7", task: "task-1", message: "Try it as a table." },
  );
  assert.deepEqual(parseAmpleFileCliActArgv(["requests", "list", "--json"]), { name: "requests.list", output: "json" });
  assert.deepEqual(
    parseAmpleFileCliActArgv(["requests", "show", "--request", "request-1"]),
    { name: "requests.show", output: "human", request: "request-1" },
  );
  // All four are mutations, so all four record management lineage; the two
  // request reads deliberately do not.
  for (const argv of [
    ["chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary", "Done."],
    ["chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1", "--question", "Which?"],
    ["chat", "answer", "--connected-folder", "connected-folder-1", "--question", "question-1", "--answer", "November."],
    ["chat", "handoff", "--connected-folder", "connected-folder-1", "--task", "task-1", "--to-connected-folder", "connected-folder-2", "--message", "Go."],
  ]) {
    assert.equal(parseAmpleFileCliActArgv([...argv, "--parent-task", "task-root"]).parentTaskId, "task-root", argv.join(" "));
  }
});

test("the act parser refuses malformed collaboration arguments with stable usage errors", () => {
  const refusals: Array<[string[], RegExp]> = [
    [["chat", "send", "--connected-folder", "connected-folder-1", "--new", "--message", "hi", "--file", "notes.md"], /--file cannot be used with 'chat send'\./],
    [["requests", "list", "--connected-folder", "connected-folder-1"], /sits above Connected Folders, so 'requests' takes no --connected-folder\./],
    [["requests", "show"], /Provide --request <request-id>\./],
    [["requests", "list", "--parent-task", "task-1"], /--parent-task cannot be used with 'requests list'\./],
    [["chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1", "--question", "Which?", "--to", "someone"], /--to must be person or parent\./],
    [["chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1", "--question", "Which?", "--option", "A", "--option", "A"], /--option: A question offers the same choice twice\./],
    [["chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1", "--question", "Which?", "--option", "  "], /--option: A question choice cannot be empty\./],
    [["chat", "send", "--connected-folder", "connected-folder-1", "--new", "--message", "hi", "--option", "A"], /--option cannot be used with 'chat send'\./],
    [["chat", "steer", "--connected-folder", "connected-folder-1", "--conversation", "chat-1"], /Provide --message <text> or --message-file <path>\./],
    [["chat", "copy", "--connected-folder", "connected-folder-1", "--conversation", "chat-1", "--task", "task-1"], /needs --message <text> with its assignment/],
    [["chat", "copy", "--connected-folder", "connected-folder-1"], /--conversation/],
    [["chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary", "Done.", "--outcome", "great"], /--outcome must be succeeded, partial, or failed\./],
    [["chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary", "Done.", "--data", "not json"], /--data must be valid JSON, or @<path> naming a JSON file\./],
    [["chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1"], /Provide --summary <text> or --summary-file <path>\./],
    [["chat", "report", "--task", "task-1", "--summary", "Done."], /explicit --connected-folder/],
    [
      ["chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary", "Done.", "--file", "q3.md", "--file", "q3.md"],
      /--file names the same path twice\./,
    ],
    [["chat", "handoff", "--connected-folder", "connected-folder-1", "--task", "task-1", "--to-connected-folder", "connected-folder-2"], /Provide --message <text> or --message-file <path>\./],
    [["chat", "answer", "--connected-folder", "connected-folder-1", "--question", "question-1"], /Provide --answer <text> or --answer-file <path>\./],
    [["chat", "answer", "--connected-folder", "connected-folder-1", "--question", "question-1", "--answer", "November.", "--task", "task-1"], /--task cannot be used with 'chat answer'\./],
  ];
  for (const [argv, message] of refusals) {
    assert.throws(
      () => parseAmpleFileCliActArgv(argv),
      (error) => error instanceof AmpleFileCliError && error.exitCode === AmpleFileCliExitCode.usage && message.test(error.message),
      argv.join(" "),
    );
  }
  // A bound refused at parse time says exactly what the same bound says when
  // the request record refuses it (docs/receipts-not-gates.md, principle 6).
  const overLongQuestion = () => parseAmpleFileCliActArgv([
    "chat", "ask", "--connected-folder", "connected-folder-1", "--task", "task-1",
    "--question", "x".repeat(ampleFileRequestLimits.maxQuestionTextBytes + 1),
  ]);
  assert.throws(overLongQuestion, (error) => error instanceof AmpleFileCliError
    && error.exitCode === AmpleFileCliExitCode.usage
    && error.message.startsWith(ampleFileRequestLimitMessage("questionText", ampleFileRequestLimits.maxQuestionTextBytes)));
  const manyHandoffFiles = Array.from({ length: 100 }, (_, index) => ["--file", `notes/${index}.md`]).flat();
  assert.doesNotThrow(() => parseAmpleFileCliActArgv([
    "chat", "handoff", "--connected-folder", "connected-folder-1", "--task", "task-1", "--to-connected-folder", "connected-folder-2", "--message", "Take this.", ...manyHandoffFiles,
  ]));
  const manyDeliverables = Array.from(
    { length: 100 },
    (_, index) => ["--file", `drafts/${index}.md`],
  ).flat();
  assert.doesNotThrow(() => parseAmpleFileCliActArgv([
    "chat", "report", "--connected-folder", "connected-folder-1", "--task", "task-1", "--summary", "Done.", ...manyDeliverables,
  ]));
});

test("CLI help/version avoid kernel work and kernel failures map to stable exit codes", async () => {
  let called = false;
  const kernel: AmpleFileCliKernel = {
    async getContext() { called = true; throw new AmpleFileCliError("permissionDenied", "Not allowed."); },
    async listConnectedFolders() { called = true; return []; },
    async listTasks() { called = true; return []; },
    async listCapabilities() { called = true; return []; },
  };
  const cwd = resolve(".");
  const version = await executeAmpleFileCliRequest(createAmpleFileCliRequest({ id: randomUUID(), argv: ["--version"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(version.stdout, "AmpleFile 1.2.3\n");
  const help = await executeAmpleFileCliRequest(createAmpleFileCliRequest({ id: randomUUID(), argv: ["help", "context"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(help.stdout, ampleFileCliHelp("AmpleFile", "context"));
  assert.equal(called, false);

  const usage = await executeAmpleFileCliRequest(createAmpleFileCliRequest({ id: randomUUID(), argv: ["unknown"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(usage.stderr, "Unknown command: unknown\nRun 'amplefile help' for usage.\n");

  const denied = await executeAmpleFileCliRequest(createAmpleFileCliRequest({ id: randomUUID(), argv: ["context", "--json"], cwd }), kernel, { version: "1.2.3" });
  assert.equal(denied.exitCode, AmpleFileCliExitCode.permissionDenied);
  assert.equal(JSON.parse(denied.stderr).error.code, "permissionDenied");
});

/** Splits one documented example line the way a shell would: quoted text is one argument. */
function exampleArgv(line: string): string[] {
  const argv: string[] = [];
  const tokens = /"([^"]*)"|(\S+)/g;
  for (let match = tokens.exec(line); match; match = tokens.exec(line)) {
    argv.push(match[1] ?? match[2] ?? "");
  }
  return argv;
}

function fixtureKernel(calls: Array<{ method: string; actor: AmpleFileCliActor; connectedFolder?: string }>): AmpleFileCliKernel {
  return {
    async getContext(actor, options) {
      calls.push({ method: "context", actor, connectedFolder: options.connectedFolder });
      return { cwd: actor.cwd, connectedFolder: { id: "space-aaaaaaaaaaaaaaaa", name: "Everywhere", connectedFolderRoot: resolve("test-connected-folder"), active: true }, selectedPath: "notes.md", activeSurface: "Files" };
    },
    async listConnectedFolders(actor, options) {
      calls.push({ method: "connected-folders", actor, connectedFolder: options.connectedFolder });
      return [{ id: "space-aaaaaaaaaaaaaaaa", name: "Everywhere", connectedFolderRoot: resolve("test-connected-folder"), active: true }];
    },
    async listTasks(actor, options) {
      calls.push({ method: "tasks", actor, connectedFolder: options.connectedFolder });
      return [{ id: "task-a", label: "Index files", status: "running", connectedFolderId: "space-aaaaaaaaaaaaaaaa", updatedAt: "2026-07-11T12:00:00.000Z" }];
    },
    async listCapabilities(actor, options) {
      calls.push({ method: "capabilities", actor, connectedFolder: options.connectedFolder });
      return [{ id: "skill-a", name: "Example Skill", kind: "skill", scope: "connected-folder", status: "loaded", source: ".pi/skills/example" }];
    },
  };
}
