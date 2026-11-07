import {
  AMPLEFILE_CLI_PROTOCOL_VERSION,
  AmpleFileCliError,
  AmpleFileCliExitCode,
  createAmpleFileCliResponse,
  type AmpleFileCliActor,
  type AmpleFileCliCapabilitySummary,
  type AmpleFileCliCheckStatusSummary,
  type AmpleFileCliCommandName,
  type AmpleFileCliContextSnapshot,
  type AmpleFileCliJson,
  type AmpleFileCliKernel,
  type AmpleFileCliOutputMode,
  type AmpleFileCliParsedCommand,
  type AmpleFileCliRequestV1,
  type AmpleFileCliResponseV1,
  type AmpleFileCliConnectedFolderSummary,
  type AmpleFileCliTaskSummary,
} from "./protocol.js";
import { outsideAgentSkill } from "../../shared/outside-agent-skill.js";

export interface AmpleFileCliExecutorOptions {
  version: string;
  productName?: string;
  now?: () => Date;
}

export interface AmpleFileCliCommandResult {
  command: AmpleFileCliCommandName;
  data: AmpleFileCliJson;
}

const commandPatterns: Array<{ tokens: string[]; name: AmpleFileCliCommandName }> = [
  { tokens: ["context"], name: "context" },
  { tokens: ["connected-folders", "list"], name: "connected-folders.list" },
  { tokens: ["tasks", "list"], name: "tasks.list" },
  { tokens: ["capabilities", "list"], name: "capabilities.list" },
  { tokens: ["checks", "status"], name: "checks.status" },
];

export function parseAmpleFileCliArgv(argv: readonly string[]): AmpleFileCliParsedCommand {
  let output: AmpleFileCliOutputMode = "human";
  let connectedFolder: string | undefined;
  let help = false;
  let version = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--json") {
      output = "json";
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--version" || token === "-v") {
      version = true;
      continue;
    }
    if (token === "--connected-folder") {
      if (connectedFolder !== undefined) throw usageError("--connected-folder may be provided only once.");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw usageError("--connected-folder requires a Connected Folder id or name.");
      connectedFolder = normalizeConnectedFolderSelector(value);
      index += 1;
      continue;
    }
    if (token.startsWith("--connected-folder=")) {
      if (connectedFolder !== undefined) throw usageError("--connected-folder may be provided only once.");
      connectedFolder = normalizeConnectedFolderSelector(token.slice("--connected-folder=".length));
      continue;
    }
    if (token.startsWith("-")) throw usageError(`Unknown option: ${token}`);
    positional.push(token);
  }

  if (help) {
    return {
      name: "help",
      output,
      ...(positional.length ? { topic: positional.join(" ") } : {}),
    };
  }
  if (version) {
    if (positional.length || connectedFolder !== undefined) throw usageError("--version cannot be combined with a command or --connected-folder.");
    return { name: "version", output };
  }
  if (!positional.length) {
    if (connectedFolder !== undefined) throw usageError("--connected-folder must be used with context, connected-folders list, tasks list, capabilities list, or checks status.");
    return { name: "help", output };
  }
  if (positional[0] === "help") {
    return { name: "help", output, ...(positional.length > 1 ? { topic: positional.slice(1).join(" ") } : {}) };
  }
  if (positional[0] === "version") {
    if (positional.length !== 1 || connectedFolder !== undefined) throw usageError("version does not accept arguments or --connected-folder.");
    return { name: "version", output };
  }
  if (positional[0] === "skill") {
    if (positional.length !== 1 || connectedFolder !== undefined) throw usageError("skill does not accept arguments or --connected-folder.");
    return { name: "skill", output };
  }

  const matched = commandPatterns.find(({ tokens }) => tokens.length === positional.length && tokens.every((token, index) => positional[index] === token));
  if (!matched) throw usageError(`Unknown command: ${positional.join(" ")}`);
  return { name: matched.name, output, ...(connectedFolder ? { connectedFolder } : {}) };
}

export async function executeAmpleFileCliRequest(
  request: AmpleFileCliRequestV1,
  kernel: AmpleFileCliKernel,
  options: AmpleFileCliExecutorOptions,
): Promise<AmpleFileCliResponseV1> {
  const completedAt = () => (options.now?.() ?? new Date()).toISOString();
  let command: AmpleFileCliParsedCommand | undefined;
  try {
    command = parseAmpleFileCliArgv(request.argv);
    const actor: AmpleFileCliActor = { kind: "cli", cwd: request.cwd };
    const result = await runCommand(command, actor, kernel, options);
    return createAmpleFileCliResponse({
      id: request.id,
      exitCode: AmpleFileCliExitCode.success,
      stdout: command.output === "json" ? `${JSON.stringify({ ok: true, command: result.command, data: result.data }, null, 2)}\n` : humanOutput(result, options),
      stderr: "",
      result: result.data,
      completedAt: completedAt(),
    });
  } catch (error) {
    const normalized = normalizeCommandError(error);
    const json = command?.output === "json" || request.argv.includes("--json");
    return createAmpleFileCliResponse({
      id: request.id,
      exitCode: normalized.exitCode,
      stdout: "",
      stderr: json
        ? `${JSON.stringify({ ok: false, error: { code: normalized.code, message: normalized.message } }, null, 2)}\n`
        : `${humanErrorMessage(normalized)}\n`,
      result: { ok: false, error: { code: normalized.code, message: normalized.message } },
      completedAt: completedAt(),
    });
  }
}

export function ampleFileCliHelp(productName = "AmpleFile", topic?: string): string {
  const executable = "amplefile";
  const normalizedTopic = topic?.trim().toLocaleLowerCase();
  const header = `${terminalText(productName)} CLI`;
  if (normalizedTopic === "context") return `${header}\n\nUsage: ${executable} context [--connected-folder <id-or-name>] [--json]\n\nShow the resolved Connected Folder and host context for this working directory.\n`;
  if (normalizedTopic === "tasks" || normalizedTopic === "tasks list") return `${header}\n\nUsage: ${executable} tasks list [--connected-folder <id-or-name>] [--json]\n\nList host-managed tasks, optionally for one Connected Folder.\n`;
  if (normalizedTopic === "capabilities" || normalizedTopic === "capabilities list") return `${header}\n\nUsage: ${executable} capabilities list [--connected-folder <id-or-name>] [--json]\n\nList Skills & Extensions, everywhere and for one Connected Folder.\n`;
  if (normalizedTopic === "checks" || normalizedTopic?.startsWith("checks ")) {
    return [
      header,
      "",
      `Usage: ${executable} checks status [--connected-folder <id-or-name>] [--json]`,
      `       ${executable} checks propose --connected-folder <id-or-name> --proposal <path> [--json]`,
      `       ${executable} checks enable --connected-folder <id-or-name> --proposal <path> [--json]`,
      `       ${executable} checks propose-fix --connected-folder <id-or-name> --proposal <path> [--json]`,
      `       ${executable} checks disable --connected-folder <id-or-name> --check <id> [--json]`,
      `       ${executable} checks run --connected-folder <id-or-name> [--check <id>] [--json]`,
      `       ${executable} checks task --connected-folder <id-or-name> --task <id> [--json]`,
      `       ${executable} checks result --connected-folder <id-or-name> --task <id> [--json]`,
      `       ${executable} checks wait --connected-folder <id-or-name> --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} checks abort --connected-folder <id-or-name> --task <id> [--json]`,
      `       ${executable} checks problems --connected-folder <id-or-name> [--check <id>] [--json]`,
      `       ${executable} checks decide --connected-folder <id-or-name> --finding <id> --decision <accept|reject|resolve|defer> [--until <ISO-time>] [--json]`,
      "",
      "Checks are optional expectations over explicitly designated files or",
      "bounded file sets. Status is content-free. Every mutation, run, and",
      "contentful result uses the authenticated act lane and an explicit Connected Folder.",
      "Nothing watches a Connected Folder or enables a portable declaration automatically.",
      "",
      "To prepare a correction, read checks problems for the current finding and",
      "its evidence. Save this JSON in a temporary file and pass it to propose-fix:",
      '{"kind":"amplefile.check-correction","version":1,"findingId":"<finding id>","fingerprint":"<finding fingerprint>","path":"<primary file>","beforeHash":"<evidence SHA-256>","replacement":"<complete corrected UTF-8 text>"}',
      "The beforeHash must match the primary file's current evidence and bytes.",
      "One correction covers one existing primary file, at most 128 KiB.",
      "Leave the original unchanged. Submission creates a pending review; the",
      "person applies it in Checks, with History preservation and a fresh recheck.",
      "Do not write Check findings or correction records directly into .amplefile.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "chat" || normalizedTopic?.startsWith("chat ")) {
    return [
      header,
      "",
      `Usage: ${executable} chat create --connected-folder <id-or-name> [--json]`,
      `       ${executable} chat send --connected-folder <id-or-name> (--conversation <id> | --new) (--message <text> | --message-file <path>) [--json]`,
      `       ${executable} chat status --connected-folder <id-or-name> (--conversation <id> | --task <id>) [--json]`,
      `       ${executable} chat result --connected-folder <id-or-name> (--conversation <id> [--messages <n>] | --task <id>) [--json]`,
      `       ${executable} chat wait --connected-folder <id-or-name> --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} chat abort --connected-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat rename --connected-folder <id-or-name> --conversation <id> --title <title> [--json]`,
      `       ${executable} chat snooze --connected-folder <id-or-name> --conversation <id> --until <ISO-time> [--json]`,
      `       ${executable} chat archive --connected-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat resume --connected-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat compact --connected-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} chat children --connected-folder <id> --task <own-task-id> --json`,
      `       ${executable} chat steer --connected-folder <id-or-name> --conversation <id> [--task <own-task-id>] (--message <text> | --message-file <path>) [--json]`,
      `       ${executable} chat copy --connected-folder <id-or-name> --conversation <id> [--title <title>] [--task <own-task-id>] [--message <text> | --message-file <path>] [--json]`,
      `       ${executable} chat report --connected-folder <id-or-name> --task <id> (--summary <text> | --summary-file <path>) [--data <json-or-@path>] [--file <connected-folder-path>]... [--outcome <succeeded|partial|failed>] [--json]`,
      `       ${executable} chat ask --connected-folder <id-or-name> --task <id> (--question <text> | --question-file <path>) [--option <choice>]... [--asynchronous] [--to <person|parent>] [--json]`,
      `       ${executable} chat answer --connected-folder <id-or-name> --question <id> (--answer <text> | --answer-file <path>) [--json]`,
      `       ${executable} chat handoff --connected-folder <id-or-name> --task <id> --to-connected-folder <id-or-name> [--to-conversation <id>] (--message <text> | --message-file <path>) [--file <connected-folder-path>]... [--json]`,
      "",
      "Start, continue, await, inspect, curate, or abort a Worker Chat. These",
      "act commands need the AmpleFile app running and require an explicit",
      "--connected-folder. chat send returns a task id; wait and result take it to",
      "follow exactly that turn's outcome instead of whatever message is newest.",
      "wait settles when that turn ends or when the task is waiting on an",
      "answer, and says which; it never sits on a question.",
      "rename, snooze, archive, and resume are the receipted lifecycle verbs;",
      "compact condenses an idle Chat's context and is refused while a turn is",
      "running. steer adds one message to a Chat's running turn, delivered",
      "after its current step. copy makes a new Chat in the same Connected Folder",
      "with this one's history as of its last finished reply, so a different",
      "direction starts with the same context; --message starts work in it.",
      "",
      "report, ask, answer, and handoff move results, questions, and work",
      "between Connected Folders without an AmpleFile agent turn in the middle. Run",
      `'${executable} help collaborate' for what each one does and a worked example.`,
      "",
    ].join("\n");
  }
  if (normalizedTopic === "collaborate" || normalizedTopic === "collaboration") {
    return [
      header,
      "",
      `Usage: ${executable} chat report --connected-folder <id-or-name> --task <own-task-id> (--summary <text> | --summary-file <path>) [--data <json-or-@path>] [--file <connected-folder-path>]... [--outcome <succeeded|partial|failed>] [--json]`,
      `       ${executable} chat ask --connected-folder <id-or-name> --task <own-task-id> (--question <text> | --question-file <path>) [--option <choice>]... [--asynchronous] [--to <person|parent>] [--json]`,
      `       ${executable} chat answer --connected-folder <id-or-name> --question <id> (--answer <text> | --answer-file <path>) [--json]`,
      `       ${executable} chat handoff --connected-folder <id-or-name> --task <own-task-id> --to-connected-folder <id-or-name> [--to-conversation <id>] (--message <text> | --message-file <path>) [--file <connected-folder-path>]... [--json]`,
      `       ${executable} chat wait --connected-folder <id-or-name> --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} chat steer --connected-folder <id-or-name> --conversation <id> --task <own-task-id> (--message <text> | --message-file <path>) [--json]`,
      `       ${executable} chat copy --connected-folder <id-or-name> --conversation <id> --task <own-task-id> (--message <text> | --message-file <path>) [--title <title>] [--json]`,
      `       ${executable} agent ask --task <own-task-id> (--question <text> | --question-file <path>) [--option <choice>]... [--asynchronous] [--json]`,
      `       ${executable} agent answer --question <id> (--answer <text> | --answer-file <path>) [--json]`,
      `       ${executable} agent wait --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} requests list [--json]`,
      `       ${executable} requests show --request <id> [--json]`,
      "",
      "How a Worker, an app, the AmpleFile agent, and an outside agent hand work",
      "to each other. Every verb here runs immediately and leaves a receipt.",
      "Nothing waits on someone clicking something.",
      "",
      "report attaches one result to a task you own: a summary of at most",
      "4 MiB, optional --data JSON of at most 16 MiB, any deliverables you",
      "name with --file, and an outcome of succeeded, partial, or failed.",
      "--data takes inline JSON or @<path> to a JSON file. --summary-file,",
      "--question-file, and --answer-file take the text from a file instead;",
      "every file is read from the directory you ran in. A file is the",
      "practical form for anything long.",
      "When the request that gave you the task declared a shape for --data,",
      "AmpleFile checks it and names the property that does not fit.",
      "",
      "ask records one question against your task and lets your turn end. The",
      "task is then waiting; you are not blocked, and neither is whoever gave",
      "you the work. --to person is the default; --to parent puts it to the",
      "request above you, and on a request with no parent it reaches the",
      "person instead and says so. --asynchronous lets independent work continue;",
      "answers queue until the Chat is idle. Each --option offers one suggested",
      "answer the person can pick with one click; they can still write",
      "their own. Offer options when the likely answers are a short, known",
      "set, and leave them off for an open question.",
      "",
      "answer delivers exactly one answer to one question and continues that",
      "Chat once, in the Connected Folder that owns the question. A second answer,",
      "an answer after Stop, and an answer sent from another Connected Folder are",
      "all refused. A person typing a reply in the Chat answers it too.",
      "",
      "handoff asks for a new Chat in another Connected Folder with your message and",
      "copies of the files you name. Copies are additive and land with a",
      "History restore point, exactly as 'files add' does; the new Chat is",
      "recorded under the same request as yours, so what it reports comes back",
      "to the same place. Handing off to your own Connected Folder is allowed and",
      "just means a fresh Chat there; the files are already in place, so --file",
      "is left off. --to-conversation follows up in a Chat yours already handed",
      "work to, so that Worker keeps everything it learned; it is refused while",
      "that Chat is still working.",
      "",
      "steer redirects a Chat yours handed work to while it is still running:",
      "your message reaches it after its current step, as if the person typed",
      "it. With --task, only such a Chat can be steered.",
      "",
      "copy starts a new Chat with a Chat's history as of its last finished",
      "reply: your own Chat, to try a different direction with everything you",
      "know so far, or one yours handed work to. With --task and --message, the",
      "copy's work is recorded under your request and its report comes back",
      "to you like a handoff's.",
      "",
      "wait follows one task and comes back when that turn ends or when the",
      "task is waiting on an answer, and tells you which happened. When it",
      "comes back waiting, answer it if the answer is yours to give, or put",
      "the question in your own final line and finish. Never loop on wait.",
      "",
      "requests list and requests show read the record: what was handed out,",
      "what is still open, and what came back. Both sit above Connected Folders and",
      "take no --connected-folder, and both are refused when they are run from inside",
      "a registered Connected Folder, because the record carries every Connected Folder's",
      "results.",
      "",
      "A worked example. The AmpleFile agent hands a draft to a Worker, the",
      "Worker asks one question and stops, the answer continues it, and the",
      "finished work comes back. The AmpleFile agent runs every line but the",
      "report, which the Worker runs during its own turn. chat answer returns",
      "the continuation's own task id: wait on that one and report from it,",
      "not the task that asked.",
      "Ids here are examples; use the ones each command returns.",
      "",
      `  $ ${executable} chat send --connected-folder space-0000000000000002 --new --message "Draft the Q3 note from Incoming/brief.md and report back." --parent-task task-root --json`,
      `  $ ${executable} chat wait --connected-folder space-0000000000000002 --task task-child --json`,
      `  $ ${executable} chat answer --connected-folder space-0000000000000002 --question q-20260911120000-a1b2c3d4 --answer "Use the November figures." --json`,
      `  $ ${executable} chat report --connected-folder space-0000000000000002 --task task-continuation --summary "Drafted drafts/q3-note.md from the brief." --file drafts/q3-note.md --outcome succeeded --json`,
      `  $ ${executable} chat wait --connected-folder space-0000000000000002 --task task-continuation --json`,
      `  $ ${executable} requests show --request req-20260911115900-0f1e2d3c --json`,
      "",
      "Requests have no fixed lifetime, child-count, depth, or continuation-count",
      "quota. Concurrent child work and transport fields remain bounded, and",
      "every refusal names the bound it hit. See Settings → Automations → Limits.",
      "Stop ends a request explicitly.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "requests" || normalizedTopic?.startsWith("requests ")) {
    return [
      header,
      "",
      `Usage: ${executable} requests list [--json]`,
      `       ${executable} requests show --request <id> [--json]`,
      "",
      "A request is the machine-local record of one piece of work and",
      "everything handed out under it: the turns it started, the questions",
      "still open, the results that came back, and what it spent. Requests sit",
      "above Connected Folders, so neither verb takes --connected-folder; both are reads —",
      "nothing here starts or stops work — and both are refused when they run",
      "from inside a registered Connected Folder, because the record carries every",
      "Connected Folder's results. list shows recent roots, newest first; show",
      "prints one request with its children, its questions, and each result.",
      "Worker Chats stay portable and carry none of this.",
      `Run '${executable} help collaborate' for the verbs that fill it in.`,
      "Needs the AmpleFile app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "worktrees" || normalizedTopic?.startsWith("worktrees ")) {
    return ["Managed Git working copies", "", `Usage: ${executable} worktrees manage --connected-folder <source-id> --task <own-task-id> --action create|list|archive|restore [--ref <committed-ref>] [--id <copy-id>] --json`, "", "Creation pins a committed revision and registers an isolated Connected Folder. Archive retains every file and Git history; restore re-registers the same copy. Active work refuses archive. Changes are never automatically merged."].join("\n");
  }
  if (normalizedTopic === "jobs" || normalizedTopic?.startsWith("jobs ")) {
    return [
      header,
      "",
      `Usage: ${executable} jobs start --connected-folder <id-or-name> --task <own-task-id> (--command <shell-command> | --command-file <path>) [--interactive] [--service] [--name <label>] [--cwd <folder>] [--timeout <seconds>] [--json]`,
      `       ${executable} jobs list --connected-folder <id-or-name> [--conversation <id>] [--running] [--json]`,
      `       ${executable} jobs show --connected-folder <id-or-name> --job <id> [--json]`,
      `       ${executable} jobs output --connected-folder <id-or-name> --job <id> [--offset <line>] [--limit <lines>] [--wait <seconds>] [--until <pattern>] [--task <own-task-id>] [--json]`,
      `       ${executable} jobs input --connected-folder <id> --task <own-task-id> --job <id> --text <text> [--eof] --json`,
      `       ${executable} jobs stop --connected-folder <id-or-name> --job <id> [--json]`,
      "",
      "A background job is a shell command that keeps running after the turn",
      "that started it ends. Use one for anything that may take more than a",
      "couple of minutes, or whose partial output decides the next step;",
      "inside a Chat, the job_start, job_output, and job_stop tools do the",
      "same thing without flags. When a job ends, AmpleFile brings its exit",
      "status, History coverage, and the end of its output back to the Chat",
      "that started it, once: to that Chat's running turn if it reads the job,",
      "to its next turn, or in one follow-up turn. Never poll in a loop.",
      "",
      "start runs the command for your own running turn (--task, the id in",
      "your turn context) in the Connected Folder's folder, or --cwd relative to",
      "it; --command-file reads the command from a file in the directory you",
      "ran in. A job has no time limit unless you give --timeout.",
      "output prints the end of the output (at most 2,000 lines or 50 KB), or",
      "a page from --offset; nextOffset reads on from there. --wait waits up",
      "to that many seconds for the job to end, and --until returns as soon as",
      "a line matches the pattern (a JavaScript regular expression).",
      "stop sends SIGTERM to the job's whole process group, then SIGKILL after",
      "5 seconds. Stopping the request a job belongs to stops it too, and",
      "quitting AmpleFile stops every job; a job is never re-run.",
      "",
      "Output stays machine-local and is kept for 30 days after a job ends.",
      "While a job runs, its Chat and Connected Folder cannot be deleted or",
      "restored from History. Needs the AmpleFile app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "chats" || normalizedTopic === "chats list") return `${header}\n\nUsage: ${executable} chats list --connected-folder <id-or-name> [--json]\n\nList a Connected Folder's Chats. Needs the AmpleFile app running.\n`;
  if (normalizedTopic === "agent" || normalizedTopic?.startsWith("manage ")) {
    return [
      header,
      "",
      `Usage: ${executable} agent send [--conversation <id> | --new] (--message <text> | --message-file <path>) [--attach <path-or-link> ...] [--json]`,
      `       ${executable} agent ask --task <own-task-id> (--question <text> | --question-file <path>) [--option <choice>]... [--asynchronous] [--json]`,
      `       ${executable} agent answer --question <id> (--answer <text> | --answer-file <path>) [--json]`,
      `       ${executable} agent status [--conversation <id> | --task <id>] [--json]`,
      `       ${executable} agent result [--conversation <id> [--messages <n>] | --task <id>] [--json]`,
      `       ${executable} agent wait --task <id> [--timeout <seconds>] [--json]`,
      `       ${executable} agent stop --task <id> [--json]`,
      `       ${executable} agent abort [--conversation <id>] [--json]`,
      `       ${executable} agent list [--json]`,
      `       ${executable} agent overview [--json]`,
      "",
      "Talk to the AmpleFile agent that sits above all Connected Folders. It runs",
      "on the same runtime as Worker Chats but belongs to no Connected Folder: its",
      "transcript is machine-local application state, and it acts across",
      "Connected Folders through these same AmpleFile commands. Without a selector,",
      "commands target the most recent active AmpleFile agent chat, starting",
      "one on first send. --attach adds reference attachments (file or folder",
      "paths, or http(s) links); nothing is copied until the AmpleFile agent",
      "places material with a restore point. agent status --task reports the",
      "request's attachments, actions, delegated turns, and phase, and agent",
      "stop --task stops the request plus every recorded delegated turn still",
      "running. agent overview prints the deterministic digest of recorded",
      "state — running work, needs-you items, what changed, and Check rows —",
      "composed by app code, never by the model. Needs the AmpleFile app",
      "running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "connected-folders" || normalizedTopic?.startsWith("connected-folders ")) {
    return [
      header,
      "",
      `Usage: ${executable} connected-folders list [--connected-folder <id-or-name>] [--json]`,
      `       ${executable} connected-folders create --name <connected-folder-name> [--json]`,
      `       ${executable} connected-folders register --path <absolute-folder-path> [--json]`,
      `       ${executable} connected-folders rename --connected-folder <id-or-name> --name <connected-folder-name> [--json]`,
      `       ${executable} connected-folders unregister --connected-folder <id-or-name> [--json]`,
      `       ${executable} connected-folders delete --connected-folder <id-or-name> [--json]`,
      `       ${executable} connected-folders appearance apply --connected-folder <id-or-name> --proposal <path> [--json]`,
      `       ${executable} connected-folders appearance apply --connected-folder <id-or-name> [--banner-image <path>] [--icon <name>] [--color <#rrggbb>] [--json]`,
      `       ${executable} connected-folders appearance reset --connected-folder <id-or-name> [--json]`,
      `       ${executable} connected-folders appearance undo --connected-folder <id-or-name> [--json]`,
      `       ${executable} connected-folders worker show --connected-folder <id-or-name> [--json]`,
      `       ${executable} connected-folders worker model --connected-folder <id-or-name> --provider <id> --model <id> [--json]`,
      `       ${executable} connected-folders worker instructions --connected-folder <id-or-name> (--instructions <text> | --instructions-file <path> | --append <line> | --clear) [--json]`,
      "",
      "connected-folders list is a content-free read; every other Connected Folders",
      "command needs the AmpleFile app running. register never moves, copies,",
      "or renames the folder's files, and unregister removes only the",
      "registration while the folder stays in place. connected-folders delete moves",
      "a managed Connected Folder to Recently deleted and records a receipt.",
      "appearance apply imports a typed proposal file, or changes just the",
      "banner image, icon, or color you name; reset and undo step the",
      "appearance back. worker show reports the connected model choices and",
      "the Worker Instructions; worker model saves the default for new Chats,",
      "while worker instructions affect subsequent turns; --append adds one",
      "line after the current instructions and skips an exact repeat.",
      "Provider connections",
      "and credentials stay in Settings → AI Models.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "files" || normalizedTopic?.startsWith("files ")) {
    return [
      header,
      "",
      `Usage: ${executable} files add --connected-folder <id-or-name> --from <path> [--from <path>...] [--to <folder-in-connected-folder>] [--json]`,
      `       ${executable} files move --connected-folder <id-or-name> --from <connected-folder-path> --to <folder-in-connected-folder> [--json]`,
      `       ${executable} files rename --connected-folder <id-or-name> --path <connected-folder-path> --name <new-name> [--json]`,
      `       ${executable} files delete --connected-folder <id-or-name> --path <connected-folder-path> [--json]`,
      `       ${executable} files mkdir --connected-folder <id-or-name> --path <folder-in-connected-folder> [--json]`,
      `       ${executable} files create --connected-folder <id-or-name> --path <connected-folder-path> [--json]`,
      "",
      "Work with files inside one Connected Folder. add copies outside material in,",
      "and move, rename, and delete take a History restore point first so they",
      "stay undoable. delete always goes through: whatever History cannot keep",
      "a copy of moves to Recently deleted instead",
      `(see '${executable} help recently-deleted'). Needs the AmpleFile app running.`,
      "",
    ].join("\n");
  }
  if (normalizedTopic === "history" || normalizedTopic?.startsWith("history ")) {
    return [
      header,
      "",
      `Usage: ${executable} history list --connected-folder <id-or-name> [--limit <n>] [--cursor <cursor>] [--json]`,
      `       ${executable} history save --connected-folder <id-or-name> [--label <label>] [--json]`,
      `       ${executable} history restore --connected-folder <id-or-name> --checkpoint <id> [--json]`,
      `       ${executable} history versions --connected-folder <id-or-name> --path <connected-folder-path> [--limit <n>] [--cursor <cursor>] [--json]`,
      `       ${executable} history read --connected-folder <id-or-name> --path <connected-folder-path> --checkpoint <id> [--offset-bytes <n>] [--length-bytes <n>] [--expected-sha256 <hash>] [--json]`,
      `       ${executable} history diff --connected-folder <id-or-name> --path <connected-folder-path> --from-checkpoint <id> [--to-checkpoint <id>] [--json]`,
      `       ${executable} history restore-file --connected-folder <id-or-name> --path <connected-folder-path> --version <sha256> [--json]`,
      "",
      "list/versions return total and nextCursor. Keep the same selection and pass",
      "--cursor to continue; a changed ledger requires starting again.",
      "For large saved text use read --offset-bytes 0 --length-bytes 65536.",
      "Continue with range.nextOffsetBytes and --expected-sha256 range.hashSha256",
      "until nextOffsetBytes is null. Every page verifies the whole saved blob.",
      "read returns bounded saved text and coverage; diff compares saved versions",
      "or the current file when --to-checkpoint is omitted. Neither restores or",
      "changes files. Binary, oversized and uncaptured content is reported explicitly.",
      "These content-bearing reads require the running app's authenticated act lane.",
      "List a Connected Folder's History checkpoints, save a restore point, restore the",
      "Connected Folder to a checkpoint, or restore one file to a captured version",
      "(restore-file takes the hash shown by history versions). Every restore",
      "records a safety checkpoint first. history restore is refused while",
      "the Connected Folder has active work; finish or stop it first. Needs the",
      "AmpleFile app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "search") {
    return [
      header,
      "",
      `Usage: ${executable} search --connected-folder <id-or-name> --query <text> [--scope <files|chats|all>] [--path <file-or-folder>] [--limit <n>] [--cursor <cursor>] [--json]`,
      "",
      "Narrow files with --path; ordinary text has no per-file size ceiling.",
      "Repeat the same query/scope/path with --cursor nextCursor until it is null.",
      "Pages may contain no matches while advancing through large files. Coverage",
      "names skipped categories; incomplete coverage is never a complete no-match.",
      "Cursors expire on restart or changed source/selection; start again then.",
      "Search one Connected Folder's files and Chats with the same in-app search the",
      "desktop uses. The results carry content, so this rides the act lane",
      "and needs the AmpleFile app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "tools" || normalizedTopic?.startsWith("tools ")) {
    return [
      header,
      "",
      `Usage: ${executable} tools import-skill --scope <everywhere|connected-folder> [--connected-folder <id-or-name>] --from <skill-path> [--json]`,
      `       ${executable} tools install --scope <everywhere|connected-folder> [--connected-folder <id-or-name>] (--id <catalog-id> | --source <package-source>) [--json]`,
      `       ${executable} tools enable|disable --scope <everywhere|connected-folder> [--connected-folder <id-or-name>] --kind <extensions|skills|prompts|themes> --path <resource-path> [--json]`,
      `       ${executable} tools update --scope <everywhere|connected-folder> [--connected-folder <id-or-name>] --source <package-source> [--json]`,
      `       ${executable} tools remove --scope <everywhere|connected-folder> [--connected-folder <id-or-name>] --source <package-source> [--json]`,
      "",
      "Manage Skills & Extensions. --scope everywhere puts them in every",
      "Connected Folder and the AmpleFile agent (Everywhere) and forbids",
      "--connected-folder; --scope connected-folder keeps them in one Connected Folder (This",
      "Connected Folder only) and requires an explicit --connected-folder. import-skill",
      "copies in a Skill; install adds a package by catalog id or source;",
      "enable and disable turn one installed extension, skill, prompt, or",
      "theme on or off by its path without removing it; update refreshes a",
      "package; remove uninstalls one.",
      "Every verb runs immediately with a receipt. Needs the AmpleFile app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "apps" || normalizedTopic?.startsWith("apps ")) {
    return [
      header,
      "",
      `Usage: ${executable} apps list --connected-folder <id-or-name> [--json]`,
      `       ${executable} apps invoke --connected-folder <id-or-name> --app <id> --tool <name> --input <json> [--json]`,
      `       ${executable} apps proposals list --connected-folder <id-or-name> --conversation <id> [--json]`,
      `       ${executable} apps proposals dismiss --connected-folder <id-or-name> --conversation <id> --proposal <id> [--json]`,
      `       ${executable} apps install-proposal --connected-folder <id-or-name> --conversation <id> --proposal <id> [--json]`,
      `       ${executable} apps install-preview --connected-folder <id-or-name> --package <connected-folder-path> [--json]`,
      `       ${executable} apps remove --connected-folder <id-or-name> --app <id> [--json]`,
      `       ${executable} apps grant --connected-folder <id-or-name> --app <id> --digest <sha256> --kind <network|files|notifications> --declaration <id> [--path <connected-folder-path>] [--json]`,
      `       ${executable} apps revoke --connected-folder <id-or-name> --app <id> --digest <sha256> --kind <network|files|notifications> --declaration <id> [--json]`,
      `       ${executable} apps connect --connected-folder <id-or-name> --app <id> --destination <id> [--json]`,
      `       ${executable} apps disconnect --connected-folder <id-or-name> --app <id> --destination <id> [--json]`,
      `       ${executable} apps automation enable --connected-folder <id-or-name> --app <id> --automation <id> [--json]`,
      `       ${executable} apps automation disable --connected-folder <id-or-name> --app <id> --automation <id> [--json]`,
      `       ${executable} apps automation run --connected-folder <id-or-name> --app <id> --automation <id> [--json]`,
      `       ${executable} apps storage clear --connected-folder <id-or-name> --app <id> [--json]`,
      `       ${executable} apps retained purge --connected-folder <id-or-name> --retained <id> [--json]`,
      `       ${executable} apps project declare --connected-folder <id-or-name> --presentation <json-path> [--json]`,
      `       ${executable} apps release prepare --connected-folder <id-or-name> --version <display-version> [--json]`,
      `       ${executable} apps release publish --connected-folder <id-or-name> --release <digest> [--json]`,
      `       ${executable} apps release delete --connected-folder <id-or-name> --release <digest> [--json]`,
      `       ${executable} apps install prepare --connected-folder <id-or-name> --release <digest> --target-connected-folder <id-or-name> [--json]`,
      `       ${executable} apps update prepare --connected-folder <id-or-name> --instance <id> --release <digest> [--json]`,
      `       ${executable} apps operation activate --connected-folder <id-or-name> --operation <id> [--json]`,
      `       ${executable} apps operation cancel --connected-folder <id-or-name> --operation <id> [--json]`,
      `       ${executable} apps uninstall --connected-folder <id-or-name> --instance <id> (--retain-data | --purge-data) [--json]`,
      "",
      "Operate restricted apps and App Studio. Every apps verb runs",
      "immediately and leaves a receipt: install-proposal, install-preview,",
      "grant, connect, automation enable, storage clear, retained purge, and",
      "uninstall --purge-data widen or narrow what an app may do, and remove,",
      "revoke, disconnect, and automation disable narrow it, as do the App",
      "Studio verbs (project declare, release prepare/publish/delete, install",
      "prepare, update prepare, operation activate/cancel, uninstall",
      "--retain-data). Credentials never ride this lane: apps connect opens",
      "the browser sign-in flow; a destination that takes a typed secret is",
      "connected from Settings → Apps. A --kind files permission that covers a",
      "folder covers the whole Connected Folder; one that names a single file needs",
      "--path <connected-folder-path> to say which file it covers. list shows each",
      "installed app with its tools and their schemas, named Worker actions,",
      "powers, connections, and automations; invoke runs one declared tool",
      "through the app's own runtime and returns its result with a receipt.",
      "Needs the AmpleFile app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "automations" || normalizedTopic?.startsWith("automations ")) {
    return [
      header,
      "",
      `Usage: ${executable} automations enable --proposal <path> [--json]`,
      `       ${executable} automations list [--json]`,
      `       ${executable} automations show --automation <id> [--json]`,
      `       ${executable} automations models [--json]`,
      `       ${executable} automations run --automation <id> [--json]`,
      `       ${executable} automations stop --automation <id> [--json]`,
      `       ${executable} automations disable --automation <id> [--json]`,
      `       ${executable} automations delete --automation <id> [--json]`,
      `       ${executable} automations receipts [--automation <id>] [--json]`,
      "",
      "Automations are declared, machine-local cross-connected-folder glue: a trigger",
      "plus bounded deterministic steps executed by app code, never by an open",
      "conversation. They sit above Connected Folders, so none takes --connected-folder.",
      "enable reads an inert typed proposal, checks that every Connected Folder it",
      "names is registered, and turns it on at once — the receipt pins the",
      "exact declaration, and enabling the same declaration again changes",
      "nothing. run starts one bounded run now; stop, disable, and delete only",
      "narrow standing behavior and run immediately. receipts lists per-run",
      "receipts. Needs the AmpleFile app running.",
      "",
      "folder-change proposal example (replace the sample Connected Folder and Check",
      "ids, paths, messages, and timestamp with your own values):",
      JSON.stringify({
        kind: "amplefile.automation-proposal", version: 5, name: "Brief handoff",
        createdBy: "assistant", createdAt: "2026-01-01T00:00:00.000Z",
        automation: {
          title: "Brief handoff",
          trigger: { kind: "files-changed", connectedFolder: "space-0000000000000001", watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] }, debounceSeconds: 5, cooldownMinutes: 1, ifMissed: "run" },
          steps: [
            { id: "copy", kind: "files", fromConnectedFolder: "space-0000000000000001", from: { kind: "paths", paths: ["Ready/brief.md"] }, toConnectedFolder: "space-0000000000000002", to: "Incoming" },
            { id: "adopt", kind: "chat", connectedFolder: "space-0000000000000002", message: "Adopt the newest Incoming/brief*.md copy into reference/brief.md. Preserve the draft and other files. Changed files this run:\n{{trigger.changedFiles}}" },
            { id: "review", kind: "check", connectedFolder: "space-0000000000000002", check: "check-example1" },
            { id: "report", kind: "agent", message: "{{trigger.summary}} The brief handoff finished. Files the adopt step created:\n{{steps.adopt.createdFiles}}" },
          ],
        },
      }),
      "Keep title, trigger, and steps inside the automation object. Copies are",
      "additive and collision-renamed; a Check step completing does not mean its",
      "findings are clear. Observers pause during automation runs and take a",
      "fresh baseline afterward, so a run's own edits never start another run.",
      "Without ifMissed, a folder trigger also starts fresh after a restart,",
      "wake, or Turn on. \"ifMissed\": \"run\" (version 5, as above) catches up",
      "instead: files added or changed while AmpleFile was closed, the computer",
      "was asleep, or the automation was off start one run, listed in",
      "{{trigger.changedFiles}} — never a backlog of missed events.",
      "",
      "Messages in chat and agent steps may use {{trigger.summary}},",
      "{{trigger.changedFiles}} (folder-change triggers), {{trigger.findings}}",
      "(Check-run triggers), and {{steps.<id>.createdFiles}} (an earlier chat",
      "step). AmpleFile fills them in when the run starts, keeps each under",
      "1 MiB, and records what it filled in on the hop receipt; anything else",
      "inside {{ }} is refused when you enable. An agent step starts a new",
      "AmpleFile agent chat.",
      "",
      "A chat or agent step may name its own model with",
      '"model": {"provider": "<provider>", "id": "<model id>"}; it applies only',
      "to the chat that step starts. models lists the connected models and",
      "whether each can see images; a step that looks at screenshots, photos,",
      "or scans needs one that does. enable refuses a model whose provider is",
      "not connected.",
      "Debounce: 1–3600 seconds. Cooldown: 0–10080 minutes. Up to 64 runs may",
      "execute at once; declarations have no step-count quota.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "pages" || normalizedTopic?.startsWith("pages ")) {
    return [
      header,
      "",
      `Usage: ${executable} pages validate --connected-folder <id-or-name> --page <page-folder-path> [--json]`,
      "",
      "A page is a folder in a Connected Folder that contains page.json. validate",
      "checks one page folder the way its page tab does: page.json, the entry",
      "file, every file the page refers to (nothing may load from the",
      "internet), file and size limits (500 files, 10 MiB each, 25 MiB in",
      "all), and page folders nested inside it. It lists each problem with",
      "its file and a plain message, then a summary: title, entry, tables,",
      "files, and bytes. It changes nothing and exits 0 whenever it could",
      "check the page; with --json, read `valid`.",
      "",
      "Needs the AmpleFile app running.",
      "",
    ].join("\n");
  }
  if (normalizedTopic === "recently-deleted" || normalizedTopic?.startsWith("trash ")) {
    return [
      header,
      "",
      `Usage: ${executable} recently-deleted list [--json]`,
      `       ${executable} recently-deleted restore --entry <id> [--to <absolute-path>] [--json]`,
      "",
      "Recently deleted holds what a delete could not leave to History: files",
      "and folders History could not keep a copy of, deleted managed",
      "Connected Folders, removed imported Skills, and app data that was cleared or",
      "purged. list shows what is waiting and when it will be removed",
      "(30 days by default; change that in Settings → Recently deleted).",
      "restore puts an item back where it came from, renaming it if something",
      "else now has that name; a Skill goes back to its own scope and path, and",
      "waits while a Skill of the same name is installed there. App data whose",
      "app is gone can only be saved as a file, which is what --to does.",
      "Nothing empties Recently deleted early. Needs the AmpleFile app running.",
      "",
    ].join("\n");
  }
  return [
    header,
    "",
    `Usage: ${executable} [--json] <command> [--connected-folder <id-or-name>]`,
    "",
    "Read commands:",
    "  context             Show the resolved Connected Folder and host context",
    "  connected-folders list",
    "                      List Connected Folders",
    "  tasks list          List host-managed tasks",
    "  capabilities list   List Skills & Extensions, everywhere and per Connected Folder",
    "  checks status       Show aggregate Check status for one Connected Folder",
    "  version             Show the installed AmpleFile version",
    "  skill               Print the skill file that teaches another AI agent this command",
    "  help [command]      Show command help",
    "",
    "Act commands (need the AmpleFile app running; Connected Folder commands take --connected-folder):",
    "  chat create|send|status|result|wait|abort|rename|snooze|archive|resume|compact",
    "                      Start, continue, follow, curate, or compact a Worker Chat",
    "  chat report|ask|answer|handoff",
    "                      Hand results, questions, answers, and work between Connected Folders",
    "  chats list          List a Connected Folder's Chats",
    "  agent send|ask|answer|status|result|wait|stop|abort|list|overview",
    "                      Talk to the AmpleFile agent above all Connected Folders",
    "  checks propose|propose-fix|enable|disable|run|task|result|wait|abort|problems|decide",
    "                      Operate optional, explicitly scoped Connected Folder Checks",
    "  history list|save|restore|versions|read|diff|restore-file",
    "                      Save and restore Connected Folder History",
    "  search              Search one Connected Folder's files and Chats (--query)",
    "  files add|move|rename|delete|mkdir|create",
    "                      Work with files inside a Connected Folder",
    "  connected-folders create|register|rename|unregister|delete",
    "  connected-folders appearance apply|reset|undo",
    "  connected-folders worker show|model|instructions",
    "                      Create, manage, restyle, or configure Connected Folders and their Workers",
    "  tools import-skill|install|enable|disable|update|remove",
    "                      Manage Skills & Extensions",
    `  apps <verb>         Restricted apps and App Studio (see '${executable} help apps')`,
    "  automations enable|list|show|run|stop|disable|delete|receipts",
    "                      Declared steps that run across Connected Folders on a trigger",
    "  pages validate",
    "                      Check a page folder",
    "  recently-deleted list|restore",
    "                      Bring back what was deleted",
    `  requests list|show  Follow one piece of work across Connected Folders (see '${executable} help collaborate')`,
    "  jobs start|list|show|output|input|stop",
    "                      Run long commands in the background; their end wakes the Chat",
    "  worktrees manage    Create, archive, or restore managed Git working copies",
    "",
    "Every act verb runs immediately and leaves a receipt in the act",
    "journal. Mutating act verbs accept --parent-task <id> to record which",
    "AmpleFile agent request they belong to. Act tokens and provider",
    "credentials are local setup: this CLI refuses them.",
    "",
    "Options:",
    "  --connected-folder <value>",
    "                      Select a Connected Folder by id or exact name",
    "  --json              Emit stable JSON output",
    "  -h, --help          Show help",
    "  -v, --version       Show the version",
    "",
  ].join("\n");
}

async function runCommand(
  command: AmpleFileCliParsedCommand,
  actor: AmpleFileCliActor,
  kernel: AmpleFileCliKernel,
  options: AmpleFileCliExecutorOptions,
): Promise<AmpleFileCliCommandResult> {
  switch (command.name) {
    case "help":
      return {
        command: command.name,
        data: {
          product: options.productName ?? "AmpleFile",
          protocolVersion: AMPLEFILE_CLI_PROTOCOL_VERSION,
          topic: command.topic ?? null,
          text: ampleFileCliHelp(options.productName, command.topic),
        },
      };
    case "version":
      return {
        command: command.name,
        data: {
          name: options.productName ?? "AmpleFile",
          version: options.version,
          protocolVersion: AMPLEFILE_CLI_PROTOCOL_VERSION,
        },
      };
    case "skill":
      // The SKILL.md another AI agent uses to drive this command (docs/amplefile-agent-and-cli.md).
      return { command: command.name, data: { text: outsideAgentSkill() } };
    case "context":
      return { command: command.name, data: contextJson(await kernel.getContext(actor, { connectedFolder: command.connectedFolder })) };
    case "connected-folders.list":
      return { command: command.name, data: connectedFoldersJson(await kernel.listConnectedFolders(actor, { connectedFolder: command.connectedFolder })) };
    case "tasks.list":
      return { command: command.name, data: tasksJson(await kernel.listTasks(actor, { connectedFolder: command.connectedFolder })) };
    case "capabilities.list":
      return { command: command.name, data: capabilitiesJson(await kernel.listCapabilities(actor, { connectedFolder: command.connectedFolder })) };
    case "checks.status": {
      if (!kernel.getChecksStatus) throw new AmpleFileCliError("unavailable", "Checks status is unavailable in this AmpleFile host.");
      return { command: command.name, data: checksStatusJson(await kernel.getChecksStatus(actor, { connectedFolder: command.connectedFolder })) };
    }
  }
}

function humanOutput(result: AmpleFileCliCommandResult, options: AmpleFileCliExecutorOptions): string {
  switch (result.command) {
    case "help":
      return `${String((result.data as { text: string }).text).trimEnd()}\n`;
    case "version": {
      const data = result.data as { name: string; version: string };
      return `${terminalText(data.name)} ${terminalText(data.version)}\n`;
    }
    case "skill":
      return String((result.data as { text: string }).text);
    case "context":
      return humanContext(result.data as unknown as AmpleFileCliContextSnapshot);
    case "connected-folders.list":
      return humanConnectedFolders((result.data as unknown as { connectedFolders: AmpleFileCliConnectedFolderSummary[] }).connectedFolders);
    case "tasks.list":
      return humanTasks((result.data as unknown as { tasks: AmpleFileCliTaskSummary[] }).tasks);
    case "capabilities.list":
      return humanCapabilities((result.data as unknown as { capabilities: AmpleFileCliCapabilitySummary[] }).capabilities);
    case "checks.status":
      return humanChecksStatus(result.data as unknown as AmpleFileCliCheckStatusSummary);
    default:
      return `${options.productName ?? "AmpleFile"}\n`;
  }
}

function contextJson(value: AmpleFileCliContextSnapshot): AmpleFileCliJson {
  return {
    cwd: value.cwd,
    connectedFolder: value.connectedFolder ? connectedFolderJson(value.connectedFolder) : null,
    selectedPath: value.selectedPath ?? null,
    activeSurface: value.activeSurface ?? null,
  };
}

function connectedFoldersJson(values: AmpleFileCliConnectedFolderSummary[]): AmpleFileCliJson {
  return { connectedFolders: values.map(connectedFolderJson), total: values.length };
}

function tasksJson(values: AmpleFileCliTaskSummary[]): AmpleFileCliJson {
  return {
    tasks: values.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      connectedFolderId: item.connectedFolderId ?? null,
      updatedAt: item.updatedAt ?? null,
    })),
    total: values.length,
  };
}

function capabilitiesJson(values: AmpleFileCliCapabilitySummary[]): AmpleFileCliJson {
  return {
    capabilities: values.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      scope: item.scope,
      status: item.status ?? null,
      source: item.source ?? null,
    })),
    total: values.length,
  };
}

function checksStatusJson(value: AmpleFileCliCheckStatusSummary): AmpleFileCliJson {
  return {
    kind: value.kind,
    version: value.version,
    available: value.available,
    connectedFolderId: value.connectedFolderId,
    state: value.state,
    configured: value.configured,
    proposed: value.proposed,
    enabled: value.enabled,
    current: value.current,
    neverRun: value.neverRun,
    stale: value.stale,
    blocked: value.blocked,
    errors: value.errors,
    needsAttention: value.needsAttention,
    running: value.running,
    lastRunAt: value.lastRunAt,
  };
}

function connectedFolderJson(value: AmpleFileCliConnectedFolderSummary): AmpleFileCliJson {
  return {
    id: value.id,
    name: value.name,
    connectedFolderRoot: value.connectedFolderRoot ?? null,
    active: value.active ?? false,
    ...(value.parentConnectedFolderId ? { parentConnectedFolderId: value.parentConnectedFolderId } : {}),
  };
}

function humanContext(value: AmpleFileCliContextSnapshot): string {
  const lines = [`Working directory: ${terminalText(value.cwd)}`];
  if (value.connectedFolder) {
    lines.push(`Connected Folder: ${terminalText(value.connectedFolder.name)} [${terminalText(value.connectedFolder.id)}]`);
    if (value.connectedFolder.connectedFolderRoot) lines.push(`Root: ${terminalText(value.connectedFolder.connectedFolderRoot)}`);
  } else {
    lines.push("Connected Folder: none");
  }
  if (value.selectedPath) lines.push(`Selected: ${terminalText(value.selectedPath)}`);
  if (value.activeSurface) lines.push(`Surface: ${terminalText(value.activeSurface)}`);
  return `${lines.join("\n")}\n`;
}

function humanConnectedFolders(values: AmpleFileCliConnectedFolderSummary[]): string {
  if (!values.length) return "No Connected Folders found.\n";
  return `${values.map((item) => `- ${terminalText(item.name)} [${terminalText(item.id)}]${item.connectedFolderRoot ? ` — ${terminalText(item.connectedFolderRoot)}` : ""}${item.active ? " (active)" : ""}`).join("\n")}\n`;
}

function humanTasks(values: AmpleFileCliTaskSummary[]): string {
  if (!values.length) return "No tasks found.\n";
  return `${values.map((item) => `- ${terminalText(item.label)} [${terminalText(item.status)}] (${terminalText(item.id)})${item.connectedFolderId ? ` — Connected Folder ${terminalText(item.connectedFolderId)}` : ""}`).join("\n")}\n`;
}

function humanCapabilities(values: AmpleFileCliCapabilitySummary[]): string {
  if (!values.length) return "No capabilities found.\n";
  return `${values.map((item) => `- ${terminalText(item.name)} [${terminalText(item.kind)}, ${terminalText(item.scope)}${item.status ? `, ${terminalText(item.status)}` : ""}]${item.source ? ` — ${terminalText(item.source)}` : ""}`).join("\n")}\n`;
}

function humanChecksStatus(value: AmpleFileCliCheckStatusSummary): string {
  if (!value.available) return `Checks: unavailable\nConnected Folder: ${terminalText(value.connectedFolderId)}\n`;
  const labels: Record<Exclude<AmpleFileCliCheckStatusSummary["state"], "unavailable">, string> = {
    "not-configured": "not configured",
    "current-clear": "current, no findings",
    "needs-attention": "needs attention",
    stale: "stale",
    blocked: "blocked",
    "check-error": "check error",
  };
  const state = value.state === "unavailable" ? "unavailable" : labels[value.state];
  return [
    `Checks: ${state}`,
    `Connected Folder: ${terminalText(value.connectedFolderId)}`,
    `Configured: ${value.configured} (${value.enabled} enabled, ${value.proposed} proposed)`,
    `Current: ${value.current}`,
    `Never run: ${value.neverRun}`,
    `Needs attention: ${value.needsAttention}`,
    `Stale: ${value.stale}`,
    `Blocked: ${value.blocked}`,
    `Errors: ${value.errors}`,
    `Running: ${value.running}`,
    `Last run: ${value.lastRunAt ? terminalText(value.lastRunAt) : "never"}`,
    "",
  ].join("\n");
}

function terminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�");
}

function humanErrorMessage(error: AmpleFileCliError): string {
  const usageHint = "\nRun 'amplefile help' for usage.";
  if (error.code === "usage" && error.message.endsWith(usageHint)) {
    return `${terminalText(error.message.slice(0, -usageHint.length))}${usageHint}`;
  }
  return terminalText(error.message);
}

function normalizeConnectedFolderSelector(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw usageError("--connected-folder requires a valid Connected Folder id or name.");
  }
  return normalized;
}

function usageError(message: string): AmpleFileCliError {
  return new AmpleFileCliError("usage", `${message}\nRun 'amplefile help' for usage.`);
}

function normalizeCommandError(error: unknown): AmpleFileCliError {
  if (error instanceof AmpleFileCliError) return error;
  return new AmpleFileCliError("failure", error instanceof Error ? error.message : String(error ?? "AmpleFile command failed."), { cause: error });
}
