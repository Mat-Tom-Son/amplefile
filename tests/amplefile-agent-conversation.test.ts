import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RegisteredConnectedFolderRuntimeProvider,
  RegisteredConnectedFolderTrustAuthority,
} from "../src/local/agent/registered-connected-folder-runtime.js";
import { loadAgentSkillCatalog } from "../src/local/agent/skill-catalog.js";
import { AmpleFileCliError } from "../src/local/cli/index.js";
import { startLocalApi } from "../src/local/server.js";
import { ampleFileAgentRoot, ampleFileAgentScopeId } from "../src/local/state-paths.js";

test("the AmpleFile agent runs above all Connected Folders on the shared turn machinery", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-agent-test-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;

    // Starting the API materializes the AmpleFile agent scope's app-owned Pi
    // configuration, and Pi's own loader picks both resources up: the
    // AGENTS.md context file stays in the session context, and the
    // manage-connected-folders Skill is a project-scope skill of the management
    // root — not of the person's everywhere scope.
    const ampleFileAgentRootPath = ampleFileAgentRoot();
    assert.equal(existsSync(join(ampleFileAgentRootPath, "AGENTS.md")), true);
    assert.equal(existsSync(join(ampleFileAgentRootPath, ".pi", "skills", "manage-connected-folders", "SKILL.md")), true);
    // Discovery uses the same trust wrapper the running API applies: the
    // management root is app-granted, so its project resources load.
    const catalog = await loadAgentSkillCatalog(ampleFileAgentRootPath, new RegisteredConnectedFolderRuntimeProvider(
      {
        async resolveRuntime() {
          return { agentDir: join(sandbox, "agent") };
        },
      },
      new RegisteredConnectedFolderTrustAuthority([ampleFileAgentRootPath]),
    ));
    const ampleFileAgentSkill = catalog.skills.find((skill) => skill.name === "manage-connected-folders");
    assert.equal(ampleFileAgentSkill?.source.scope, "project", "the management skill must load at project scope");
    assert.equal(
      catalog.contextFiles.some((file) => file.path.endsWith("AGENTS.md") && file.content.includes("AmpleFile agent")),
      true,
      "the management AGENTS.md must load as a Pi context file",
    );
    const ampleFileAgentContext = catalog.contextFiles.find((file) => file.path.endsWith("AGENTS.md"))?.content ?? "";
    // The identity line names the AmpleFile agent while keeping "AmpleFile agent"
    // as the contract phrase in the same sentence.
    assert.match(ampleFileAgentContext, /You are the AmpleFile agent — the agent above all Connected Folders in this computer's AmpleFile app\./);
    assert.match(ampleFileAgentContext, /Checks are optional, manual expectations/);
    assert.match(ampleFileAgentContext, /Never turn an ordinary request.*standing behavior/);
    assert.match(ampleFileAgentContext, /not-configured.*unknown, not clear/);
    assert.match(ampleFileAgentContext, /Only after an explicit enable instruction/);
    // The teaching pass (docs/act-ledger.md): the instructions name the
    // complete landed verb surface, family by family, with the ledger's
    // command shapes.
    assert.match(ampleFileAgentContext, /chat rename --connected-folder <id> --conversation <id> --title/);
    assert.match(ampleFileAgentContext, /chat snooze --connected-folder <id> --conversation <id> --until <ISO>/);
    assert.match(ampleFileAgentContext, /`chat compact`/);
    assert.match(ampleFileAgentContext, /history restore --connected-folder <id> --checkpoint <id>/);
    assert.match(ampleFileAgentContext, /history restore-file --connected-folder <id> --path "<p>" --version <sha256>/);
    assert.match(ampleFileAgentContext, /files move --connected-folder <id> --from "<connected-folder-path>" --to "<connected-folder-folder>"/);
    assert.match(ampleFileAgentContext, /files mkdir --connected-folder <id> --path/);
    assert.match(ampleFileAgentContext, /search --connected-folder <id> --query "<text>" \[--scope files\|chats\|all\]/);
    assert.match(ampleFileAgentContext, /connected-folders rename --connected-folder <id> --name/);
    assert.match(ampleFileAgentContext, /connected-folders unregister --connected-folder <id>/);
    assert.match(ampleFileAgentContext, /connected-folders appearance apply --connected-folder <id> --proposal/);
    assert.match(ampleFileAgentContext, /tools import-skill --scope everywhere\|connected-folder/);
    assert.match(ampleFileAgentContext, /apps release publish --connected-folder <id> --release <digest>/);
    assert.match(ampleFileAgentContext, /a local state transition — nothing is uploaded, hosted, or granted/);
    assert.match(ampleFileAgentContext, /apps uninstall --connected-folder <id> --instance <id> --retain-data\|--purge-data/);
    assert.match(ampleFileAgentContext, /The disposition flag is never defaulted/);
    // The AmpleFile agent is never taught the retired desktop-served sharing
    // verbs or a Shared pages surface.
    assert.doesNotMatch(ampleFileAgentContext, /\bpages (share|share-app|list|status|revoke|narrow|widen|snapshot-off)\b|help pages|Shared pages/);
    // Pages were removed on 2026-11-07: nothing teaches them.
    assert.doesNotMatch(ampleFileAgentContext, /page tab|page\.json|pages validate/i);
    assert.match(ampleFileAgentContext, /agent overview --json/);
    // Receipts, not gates (docs/receipts-not-gates.md, F19–F24): every verb
    // runs on the first call and returns a receipt, destruction is reversible
    // through History or Recently deleted, limits are named rather than
    // hidden, needs-you is a question, and the setup surfaces have no verb.
    assert.match(ampleFileAgentContext, /## Receipts, not gates/);
    assert.match(ampleFileAgentContext, /Every verb runs on the first call and returns a receipt\./);
    assert.match(ampleFileAgentContext, /Every destruction is reversible\./);
    assert.match(ampleFileAgentContext, /moves into Recently deleted/);
    assert.match(ampleFileAgentContext, /recently-deleted list --json/);
    assert.match(ampleFileAgentContext, /recently-deleted restore --entry <id>/);
    assert.match(ampleFileAgentContext, /30 days by default/);
    assert.match(ampleFileAgentContext, /no verb empties Recently deleted early/);
    assert.doesNotMatch(ampleFileAgentContext, /Limits are defaults, not gates\./);
    assert.match(ampleFileAgentContext, /Needs you means a question\./);
    assert.match(ampleFileAgentContext, /Setup stays with the person\./);
    assert.match(ampleFileAgentContext, /never gather, accept, or relay credentials/);
    // Reversible destruction reaches the file and Connected Folder verbs themselves.
    assert.match(ampleFileAgentContext, /Deletion refuses until the affected Connected Folder's work has settled/);
    assert.match(ampleFileAgentContext, /Never bypass that refusal with raw tools/);
    assert.match(ampleFileAgentContext, /moves its folder into Recently deleted/);
    // Apps come up able to work (F21) and are usable as tools (F22 lineage).
    assert.match(ampleFileAgentContext, /Connected Folder apps come up able to work\./);
    assert.match(ampleFileAgentContext, /grant each declared folder permission over the whole Connected Folder/);
    // What the installer actually does not grant: the AmpleFile agent must relay it
    // rather than report a Check slot or a chosen file as already granted.
    assert.match(ampleFileAgentContext, /a permission that names a single file/);
    assert.match(ampleFileAgentContext, /a Check-result slot when the Connected Folder has more than one Check/);
    assert.match(ampleFileAgentContext, /Relay that list; do not report those as granted\./);
    assert.match(ampleFileAgentContext, /apps list --connected-folder <id> --json/);
    assert.match(ampleFileAgentContext, /apps invoke --connected-folder <id> --app <id> --tool <name> --input/);
    assert.match(ampleFileAgentContext, /leave a copy in Recently deleted before removing live data/);
    // Help topics exist now, and the instructions cite them.
    assert.match(ampleFileAgentContext, /amplefile help <family>/);
    assert.match(ampleFileAgentContext, /help recently-deleted/);
    // Automations: inert proposals, direct receipted enablement, the closed
    // placeholder set and the agent step, one-time v2 deferral, and no
    // cross–Connected Folder execution inside a portable Connected Folder Chat.
    assert.match(ampleFileAgentContext, /Never run cross-connected-folder work through a Connected Folder Chat\./);
    assert.match(ampleFileAgentContext, /amplefile\.automation-proposal/);
    assert.match(ampleFileAgentContext, /Use version 1 for manual, interval, and on-settled triggers/);
    assert.match(ampleFileAgentContext, /Use version 3 for a folder-change trigger/);
    // The 2026-10-11 opt-in catch-up: version 5, one run, never a backlog.
    assert.match(ampleFileAgentContext, /use version 5 and add `"ifMissed":"run"` to the trigger/);
    assert.match(ampleFileAgentContext, /one run, never a backlog/);
    assert.match(ampleFileAgentContext, /<name>\.amplefile-automation\.json` directly in your own working folder/);
    assert.match(ampleFileAgentContext, /appears in Settings → Automations under \*\*Ready to turn on\*\*/);
    assert.match(ampleFileAgentContext, /do not enable it yourself unless they ask you to/);
    assert.match(ampleFileAgentContext, /Use version 2 for a one-time trigger shaped exactly/);
    assert.match(ampleFileAgentContext, /`ifMissed` is required/);
    assert.match(ampleFileAgentContext, /any future time up to ten years ahead/);
    assert.match(ampleFileAgentContext, /automations enable --proposal/);
    assert.match(ampleFileAgentContext, /enabling the same declaration again changes nothing/);
    assert.match(ampleFileAgentContext, /Use version 4 for placeholders or an agent step/);
    assert.match(ampleFileAgentContext, /[Oo]rdered steps use four kinds/);
    assert.match(ampleFileAgentContext, /\{\{trigger\.summary\}\}/);
    assert.match(ampleFileAgentContext, /a message into a new thread of your own/);
    assert.match(ampleFileAgentContext, /Anything else inside `\{\{ \}\}` is refused when you enable/);
    assert.match(ampleFileAgentContext, /automations show --automation <id>/);
    assert.match(ampleFileAgentContext, /automations receipts \[--automation <id>\]/);
    assert.match(ampleFileAgentContext, /automations sit above Connected Folders and take no `--connected-folder`/);
    assert.match(ampleFileAgentContext, /Up to 64 automation runs execute at once/);
    assert.match(ampleFileAgentContext, /A pure reminder performs no future Worker work/);
    assert.match(ampleFileAgentContext, /For deferred work, resolve an unambiguous absolute time/);
    assert.match(ampleFileAgentContext, /finish the current turn/);
    assert.match(ampleFileAgentContext, /Never busy-wait/);
    assert.match(ampleFileAgentContext, /An agent step is the only way you are ever scheduled/);
    assert.match(ampleFileAgentContext, /a thread an automation started must never enable or run automations itself/);
    assert.match(ampleFileAgentContext, /Run-now creates a copy without consuming the declared slot/);
    // The overview (docs/amplefile-agent-overview.md): narration on demand from the digest,
    // truncation disclosed, seen markers untouched, never self-scheduled.
    assert.match(ampleFileAgentContext, /never present a truncated section as complete/);
    assert.match(ampleFileAgentContext, /narration never advances a marker/);
    // Seen markers are per-surface — the popover and the main window — and
    // narration advances neither of them.
    assert.match(ampleFileAgentContext, /the popover and the main window separately/);
    assert.match(ampleFileAgentContext, /not the popover's, not the main window's\./);
    assert.doesNotMatch(ampleFileAgentContext, /remote:<grantId>/);
    assert.match(ampleFileAgentContext, /Narration is on demand only\./);
    // Needs-you is a question list, never work waiting to be let through (F24).
    assert.match(ampleFileAgentContext, /needs-you items \(questions, due snoozes, and requests waiting on the person's answer\)/);
    // Delegation under the collaboration contract (F25–F29): the AmpleFile agent reads
    // the request graph, a wait that comes back waiting is not a failure, a
    // waiting or running child never holds this turn open, the follow-up turn
    // is bounded and ordinary, a child's question is answered with one
    // `chat answer` or handed to the person, handoffs are host-routed, and a
    // Connected Folder Chat only ever receives its own work (F9 as amended).
    assert.match(ampleFileAgentContext, /requests list --json/);
    assert.match(ampleFileAgentContext, /requests show --request <id> --json/);
    assert.match(ampleFileAgentContext, /Both sit above Connected Folders and take no `--connected-folder`/);
    assert.match(ampleFileAgentContext, /when its task starts waiting on an answer, and says which/);
    assert.match(ampleFileAgentContext, /Waiting is not a failure and not a timeout/);
    assert.match(ampleFileAgentContext, /Never block on a waiting child\./);
    assert.match(ampleFileAgentContext, /Never busy-wait, sleep, or poll in a loop for one\./);
    assert.match(ampleFileAgentContext, /when its children settle it brings their reports back here once/);
    assert.doesNotMatch(ampleFileAgentContext, /bounded at 4 per request/);
    assert.match(ampleFileAgentContext, /turn them off in Settings → Automations → Limits/);
    assert.match(ampleFileAgentContext, /chat answer --connected-folder <id> --question <id> --answer "<text>" --parent-task <this-request-task-id> --json/);
    assert.match(ampleFileAgentContext, /A second answer, an answer after Stop/);
    assert.match(ampleFileAgentContext, /amplefile agent ask --task/);
    assert.match(ampleFileAgentContext, /Handoffs are host-routed\./);
    assert.match(ampleFileAgentContext, /A Connected Folder Chat receives only its own work\./);
    assert.match(ampleFileAgentContext, /its assignment, answers to its own questions, report summaries someone deliberately released to it, and copied files/);
    assert.match(ampleFileAgentContext, /Requests have no fixed lifetime, child-count, depth, concurrency, or continuation-count quota/);
    assert.match(ampleFileAgentContext, /help collaborate/);
    // The trap this teaching exists to prevent: a sentence a model obeys
    // literally by sitting on a child instead of finishing its turn.
    assert.doesNotMatch(
      ampleFileAgentContext,
      /\bpoll(ing)? (until|every)\b|\bsleep \d/i,
      "the fold is never taught to busy-wait",
    );
    // Report discipline reads receipts and restore paths without losing
    // attachment accounting or the question-on-final-line rule.
    assert.match(ampleFileAgentContext, /Read each receipt before reporting/);
    assert.match(ampleFileAgentContext, /never call a request done while any child is running, waiting, failed, lost, or stopped/);
    assert.match(ampleFileAgentContext, /When a child asked a question, quote the question/);
    assert.match(ampleFileAgentContext, /say whether History or Recently deleted holds it/);
    assert.match(ampleFileAgentContext, /Account for every attached item by name/);
    assert.match(ampleFileAgentContext, /record a question with `agent ask`/);
    // The AmpleFile agent is never taught a gate vocabulary (docs/receipts-not-gates.md
    // acceptance: no user-facing copy says staged, approve, policy, Reviewed,
    // or Unrestricted).
    assert.doesNotMatch(
      ampleFileAgentContext,
      /\bstaged\b|\bstaging\b|standing polic|\bpolic(y|ies)\b|\bReviewed\b|\bUnrestricted\b|approv|\bdenial\b|\bdenied\b|decision id|autoApproval|needs-you card|\bcards?\b/i,
      "the AmpleFile agent is never taught a gate vocabulary",
    );

    // The manage-connected-folders Skill teaches the same surface and etiquette.
    const skillContent = await readFile(join(ampleFileAgentRootPath, ".pi", "skills", "manage-connected-folders", "SKILL.md"), "utf8");
    assert.match(skillContent, /Every verb runs on the first call and returns a receipt/);
    assert.match(skillContent, /## Tools and apps/);
    assert.match(skillContent, /Connected Folder apps come up able to work/);
    assert.match(skillContent, /grant each declared folder permission over the whole Connected Folder/);
    assert.match(skillContent, /bind a Check-result slot when the Connected Folder has exactly one Check/);
    assert.match(skillContent, /still need the person in Settings → Apps/);
    assert.match(skillContent, /apps invoke --connected-folder <id> --app <id> --tool <name> --input <json>/);
    assert.match(skillContent, /leave a copy in Recently deleted first/);
    assert.match(skillContent, /recently-deleted restore --entry <id>/);
    assert.match(skillContent, /Setup-only \(no act verb\)/);
    assert.match(skillContent, /Never delegate cross-connected-folder work into a Connected Folder Chat/);
    assert.match(skillContent, /amplefile\.automation-proposal/);
    assert.match(skillContent, /one-time trigger requires version 2/);
    assert.match(skillContent, /`ifMissed` is required/);
    assert.match(skillContent, /any future time up to ten years ahead/);
    assert.match(skillContent, /automations enable --proposal/);
    assert.match(skillContent, /Version 4 adds the closed placeholder set and the `agent` step/);
    assert.match(skillContent, /`chat`, `files`, `check`, or `agent`/);
    assert.match(skillContent, /automations list\|show\|run\|stop\|disable\|delete\|receipts/);
    assert.match(skillContent, /A pure reminder does no future Worker work/);
    assert.match(skillContent, /Deferred work uses a version-2 `at` automation/);
    assert.match(skillContent, /finish the current turn/);
    assert.match(skillContent, /Never busy-wait/);
    assert.match(skillContent, /report the receipt/);
    assert.match(skillContent, /an automation's `agent` step is the only way you are ever scheduled/);
    assert.match(skillContent, /Run-now is a copy that does not consume the one-time slot/);
    assert.doesNotMatch(skillContent, /\bpages (share|share-app|list|status|revoke|narrow|widen|snapshot-off)\b|Shared pages/);
    assert.doesNotMatch(skillContent, /page tab|page\.json|pages validate/i);
    assert.match(skillContent, /agent overview --json/);
    assert.match(skillContent, /files move --connected-folder <id>/);
    assert.match(skillContent, /Read each receipt: executed is done, failed or refused is not/);
    // The Skill carries the same collaboration teaching in its shorter form.
    assert.match(skillContent, /requests list --json/);
    assert.match(skillContent, /requests show --request <id> --json/);
    assert.match(skillContent, /when its task starts waiting on an answer, and says which/);
    assert.match(skillContent, /Waiting is not a failure/);
    assert.match(skillContent, /Never block on a waiting or running child\./);
    assert.match(skillContent, /Never busy-wait, sleep, or poll in a loop\./);
    assert.match(skillContent, /the one follow-up turn it starts/);
    assert.match(skillContent, /A second answer, an answer after Stop, or a Connected Folder that does not own the question is refused/);
    assert.match(skillContent, /amplefile agent ask --task/);
    assert.match(skillContent, /asks for a handoff with `chat handoff`/);
    assert.doesNotMatch(skillContent, /bounded at 4 per request/);
    assert.match(skillContent, /Requests have no fixed lifetime, child-count, depth, concurrency, or continuation-count quota/);
    assert.match(skillContent, /A Connected Folder Chat receives only its assignment, answers to its own questions, released report summaries, and copied files/);
    assert.match(skillContent, /A request is not done while a child is running, waiting, failed, lost, or stopped/);
    assert.match(skillContent, /help collaborate/);
    assert.doesNotMatch(
      skillContent,
      /\bpoll(ing)? (until|every)\b|\bsleep \d/i,
      "the manage-connected-folders Skill is never taught to busy-wait",
    );
    // Needs-you, per-surface seen markers, and the help topics reach the
    // Skill too.
    assert.match(skillContent, /never work waiting to be let through/);
    assert.match(skillContent, /Seen markers are per surface\./);
    assert.match(skillContent, /amplefile help <family>/);
    assert.doesNotMatch(
      skillContent,
      /\bstaged\b|\bstaging\b|standing polic|\bpolic(y|ies)\b|\bReviewed\b|\bUnrestricted\b|approv|\bdenial\b|\bdenied\b|decision id|autoApproval|needs-you (card|flyout)|\bcards?\b/i,
      "the manage-connected-folders Skill is never taught a gate vocabulary",
    );

    // Before any send there is no conversation to inspect.
    await assert.rejects(
      () => facade.agentConversationStatus({}),
      (error: unknown) => error instanceof AmpleFileCliError && error.code === "notFound",
    );

    // The first send creates the default AmpleFile agent and runs a
    // real turn through the personal-scope /hold extension — proving the
    // management client loads personal Pi capabilities without any Connected Folder.
    const send = await facade.agentSend({ content: "/hold" });
    assert.ok(send.conversationId);
    assert.ok(send.taskId);
    const running = await api.kernel.getTasks({ kind: "system" });
    const ampleFileAgentTask = running.tasks.find((task) => task.id === send.taskId);
    assert.equal(ampleFileAgentTask?.connectedFolderId, ampleFileAgentScopeId, "AmpleFile agent turns must be tracked under the AmpleFile agent scope id");
    assert.equal(ampleFileAgentTask?.actor.kind, "cli");

    await waitForAsync(async () => (await facade.agentTurnStatus({ taskId: send.taskId })).task.state !== "running");
    const settled = await facade.agentTurnStatus({ taskId: send.taskId });
    assert.equal(settled.task.state, "succeeded");
    assert.equal(settled.task.conversationId, send.conversationId);

    const result = await facade.agentTurnResult({ taskId: send.taskId });
    assert.equal(result.message.content, "Command completed.");
    assert.equal(result.conversationId, send.conversationId);

    // The transcript is machine-local application state, not Connected Folder content.
    assert.equal(ampleFileAgentRootPath.startsWith(join(sandbox, "state")), true, "management records live under the app state root");
    const transcripts = await readdir(join(ampleFileAgentRootPath, ".amplefile", "conversations"));
    assert.equal(transcripts.some((file) => file === `${send.conversationId}.jsonl`), true);
    assert.equal(existsSync(join(sandbox, "content", "management")), false, "no Connected Folder is created for the AmpleFile agent scope");

    // Selector-free commands keep targeting the same default conversation.
    const second = await facade.agentSend({ content: "/hold" });
    assert.equal(second.conversationId, send.conversationId);
    await waitForAsync(async () => (await facade.agentTurnStatus({ taskId: second.taskId })).task.state !== "running");

    const status = await facade.agentConversationStatus({});
    assert.equal(status.conversation.id, send.conversationId);
    assert.equal(status.state, "idle");
    const tail = await facade.agentConversationResult({ messages: 10 });
    assert.equal(tail.lastAssistant, "Command completed.");
    assert.equal(tail.conversationId, send.conversationId);
    assert.equal((await facade.agentList()).conversations.length, 1);
    assert.equal((await facade.agentAbort({})).aborted, false);

    // --new starts a separate AmpleFile agent on request.
    const fresh = await facade.agentSend({ content: "/hold", newConversation: true });
    assert.notEqual(fresh.conversationId, send.conversationId);
    await waitForAsync(async () => (await facade.agentTurnStatus({ taskId: fresh.taskId })).task.state !== "running");
    assert.equal((await facade.agentList()).conversations.length, 2);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the AmpleFile agent fails closed when its required instructions cannot be prepared", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-agent-fail-closed-test-"));
  const stateBase = join(sandbox, "state");
  await mkdir(stateBase, { recursive: true });
  // Occupy the management root with a regular file. The rest of AmpleFile
  // must still start, but this full-trust scope must not run uninstructed.
  await writeFile(join(stateBase, "management"), "not a directory", "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase,
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    await assert.rejects(
      () => api.actFacade.agentList(),
      (error: unknown) => error instanceof AmpleFileCliError
        && error.code === "unavailable"
        && /required instructions/.test(error.message),
    );
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("AmpleFile agent transcripts saved with remote provenance still load as ordinary messages and are never rewritten", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-remote-legacy-read-test-"));
  const stateBase = join(sandbox, "state");
  const conversationId = "chat-f6e5b83-legacy";
  const transcriptDir = join(stateBase, "management", ".amplefile", "conversations");
  const transcriptPath = join(transcriptDir, `${conversationId}.jsonl`);
  await mkdir(transcriptDir, { recursive: true });
  const legacyMessage = {
    id: "message-from-0.2.2",
    role: "user",
    content: "legacy remote request",
    createdAt: "2026-08-01T12:00:00.000Z",
    source: "remote_web",
    remotePrincipalId: "browser-legacy",
    remoteGrantId: "grant-legacy",
    remoteRequestId: "request-before-grant-provenance",
  };
  const originalTranscript = `${JSON.stringify({
    id: "legacy-title",
    role: "system",
    kind: "conversation_title",
    titleSource: "placeholder",
    content: "New Chat",
    createdAt: "2026-08-01T11:59:59.000Z",
  })}\n${JSON.stringify(legacyMessage)}\n`;
  await writeFile(transcriptPath, originalTranscript, "utf8");

  const api = await startLocalApi({
    port: 0,
    stateBase,
    connectedFolderBase: join(sandbox, "content"),
    loadEnv: false,
  });
  try {
    const response = await fetch(new URL(`/api/amplefile-agent/conversations/${conversationId}`, api.origin));
    assert.equal(response.status, 200);
    const { messages } = await response.json() as { messages: Array<Record<string, unknown>> };
    const loaded = messages.find((message) => message.id === legacyMessage.id);
    assert.equal(loaded?.role, "user");
    assert.equal(loaded?.content, legacyMessage.content);
    for (const field of ["source", "remotePrincipalId", "remoteGrantId", "remoteRequestId"]) {
      assert.equal(field in loaded!, false, `${field} is dropped on read`);
    }
    assert.equal((await api.actFacade.agentList()).conversations.some((conversation) => conversation.id === conversationId), true);
    assert.equal(await readFile(transcriptPath, "utf8"), originalTranscript, "reading never rewrites the append-only log");
    assert.deepEqual(await readdir(transcriptDir), [`${conversationId}.jsonl`], "reading a legacy Chat does not leave another transcript");
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}
