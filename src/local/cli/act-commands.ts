import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { HistoryFileComparison, HistoryFileRead } from "../../shared/history-review.js";

import type {
  AmpleFileActChatLifecycleState,
  AmpleFileActChatMessage,
  AmpleFileActCheckpointSummary,
  AmpleFileActConversationRef,
  AmpleFileActFacade,
  AmpleFileActFileVersionRef,
} from "./act-facade.js";
import type { AmpleFileCliActRequest } from "./act-protocol.js";
import type { AmpleFileCliActReceipts, AmpleFileCliActUndoRef } from "./act-receipts.js";
import { maximumWorkerInstructionsLength } from "../agent/model-preferences.js";
// The collaboration bounds and their person-facing refusal text live with the
// request record that enforces them, so a parse-time refusal and a store-time
// refusal say the same words (docs/collaboration-contract.md).
import {
  parseAmpleFileQuestionOptions,
  ampleFileRequestLimitMessage,
  type AmpleFileResultOutcome,
} from "../requests/request-records.js";
import { ampleFileBackgroundJobLimits, ampleFileRequestLimits } from "../../shared/amplefile-limits.js";
import {
  AmpleFileCliError,
  AmpleFileCliExitCode,
  createAmpleFileCliResponse,
  type AmpleFileCliJson,
  type AmpleFileCliOutputMode,
  type AmpleFileCliResponseV1,
} from "./protocol.js";

export type AmpleFileCliActCommandName =
  | "chat.create"
  | "chat.send"
  | "chat.status"
  | "chat.result"
  | "chat.abort"
  | "chat.rename"
  | "chat.snooze"
  | "chat.archive"
  | "chat.resume"
  | "chat.compact"
  // The Connected Folder-scoped collaboration verbs (docs/collaboration-contract.md).
  // Delivery is host-side: no AmpleFile Agent turn moves a report, an answer,
  // or a handoff.
  | "chat.report"
  | "agent.ask"
  | "agent.answer"
  | "chat.ask"
  | "chat.answer"
  | "chat.handoff"
  | "chat.steer"
  | "chat.copy"
  | "chats.list"
  | "agent.send"
  | "agent.status"
  | "agent.result"
  | "agent.abort"
  | "agent.stop"
  | "agent.list"
  | "agent.overview"
  | "history.list"
  | "history.save"
  | "history.restore"
  | "history.versions"
  | "history.read"
  | "history.diff"
  | "history.restore-file"
  | "search"
  | "connected-folders.create"
  | "connected-folders.register"
  | "connected-folders.rename"
  | "connected-folders.unregister"
  | "connected-folders.delete"
  | "connected-folders.appearance.apply"
  | "connected-folders.appearance.reset"
  | "connected-folders.appearance.undo"
  | "connected-folders.worker.show"
  | "connected-folders.worker.model"
  | "connected-folders.worker.instructions"
  | "files.add"
  | "files.move"
  | "files.rename"
  | "files.delete"
  | "files.mkdir"
  | "files.create"
  | "tools.import-skill"
  | "tools.install"
  | "tools.update"
  | "tools.enable"
  | "tools.disable"
  | "tools.remove"
  | "automations.enable"
  | "automations.list"
  | "automations.models"
  | "automations.show"
  | "automations.run"
  | "automations.stop"
  | "automations.disable"
  | "automations.delete"
  | "automations.receipts"
  | "recently-deleted.list"
  | "recently-deleted.restore"
  // Reads of the request graph above all Connected Folders (docs/collaboration-contract.md):
  // one request, everything handed out under it, and what came back.
  | "requests.list"
  | "requests.show"
  // Background jobs (docs/background-jobs.md): the same records as the
  // job_start, job_output, and job_stop tools.
  | "jobs.start"
  | "jobs.list"
  | "jobs.show"
  | "jobs.output"
  | "jobs.stop"
  | "chat.children"
  | "jobs.input"
  | "worktrees.manage";

export interface AmpleFileCliActParsedCommand {
  name: AmpleFileCliActCommandName;
  output: AmpleFileCliOutputMode;
  connectedFolder?: string;
  conversation?: string;
  task?: string;
  /** Explicit AmpleFile Agent request lineage for downstream mutation commands. */
  parentTaskId?: string;
  newConversation?: boolean;
  message?: string;
  messageFromPayload?: boolean;
  messages?: number;
  connectedFolderName?: string;
  registerPath?: string;
  fromPaths?: string[];
  /** Raw --attach values for agent send: paths or http(s) links. */
  attachments?: string[];
  toDir?: string;
  proposalPath?: string;
  /** `connected-folders appearance apply` without a proposal: just these parts change. */
  appearanceParts?: { bannerImagePath?: string; icon?: string; color?: string };
  until?: string;
  /** New Chat title for chat.rename. */
  title?: string;
  provider?: string;
  model?: string;
  instructions?: string;
  clear?: boolean;
  /** Optional restore-point label for history.save. */
  label?: string;
  checkpoint?: string;
  fromCheckpoint?: string;
  toCheckpoint?: string;
  /** Single Connected Folder–relative entry path for file, History, Skills & Extensions, and search verbs. */
  path?: string;
  /** File-version hash for history.restore-file. */
  version?: string;
  query?: string;
  cursor?: string; limit?: number; offsetBytes?: number; lengthBytes?: number; expectedSha256?: string;
  searchScope?: "files" | "chats" | "all";
  /** New entry name for files.rename. */
  entryName?: string;
  toolsScope?: "everywhere" | "connected-folder";
  resourceKind?: "extensions" | "skills" | "prompts" | "themes";
  catalogId?: string;
  source?: string;
  /** An Automation id for `automations …`. */
  automation?: string;
  /** Recently deleted item id for recently-deleted.restore. */
  entry?: string;
  /** Result-envelope summary for chat.report (docs/collaboration-contract.md). */
  summary?: string;
  /** Inline `--data` JSON for chat.report; the host validates it against a declared schema. */
  resultData?: unknown;
  /** `--data @<path>`: a JSON file the host reads from the directory the command ran in. */
  resultDataPath?: string;
  /** Connected Folder–relative deliverables for chat.report, and the copies chat.handoff carries. */
  files?: string[];
  outcome?: AmpleFileResultOutcome;
  /** chat.ask question text. */
  question?: string;
  /** Who chat.ask is asking; `parent` on a root request is delivered to the person. */
  respondent?: "person" | "parent";
  /** connected-folders.worker.instructions `--append`: add `instructions` as one more line. */
  appendInstructions?: boolean;
  /** chat.ask and agent.ask suggested answers (`--option`, repeatable), shown as choices. */
  options?: string[];
  asynchronous?: boolean;
  /** chat.answer target. `--question` carries an id here and free text in chat.ask. */
  questionId?: string;
  /** chat.answer answer text. */
  answer?: string;
  /** chat.handoff destination Connected Folder selector. */
  toConnectedFolder?: string;
  /** chat.handoff `--to-conversation`: follow up in a Chat this Chat already handed work to. */
  toConversation?: string;
  /** requests.show target. */
  request?: string;
  /**
   * `--summary-file`, `--question-file`, `--answer-file`, `--instructions-file`:
   * UTF-8 text the host reads from the directory the command ran in, for text
   * longer than a shell argument comfortably carries. Resolved into the
   * matching inline field before the command runs.
   */
  textFiles?: Partial<Record<"summary" | "question" | "answer" | "instructions" | "command", string>>;
  /** jobs.*: the background job addressed. */
  job?: string;
  /** jobs.start: the shell command, or "" when `--command-file` supplies it. */
  jobCommand?: string;
  interactive?: boolean;
  service?: boolean;
  terminalText?: string;
  eof?: boolean;
  worktreeAction?: "create" | "list" | "archive" | "restore";
  worktreeId?: string;
  worktreeRef?: string;
  /** jobs.start: the label a person sees. */
  jobName?: string;
  /** jobs.start: folder to run in, relative to the Connected Folder or absolute. */
  jobCwd?: string;
  timeoutSeconds?: number;
  /** jobs.output: first line to read, and seconds to wait for the job to end or `until` to match. */
  offset?: number;
  waitSeconds?: number;
  /** jobs.list: only jobs still running. */
  running?: boolean;
}

/** The running interactive app's act authority: the facade plus this run's token. */
export interface AmpleFileCliActAuthority {
  facade: AmpleFileActFacade;
  token: string;
}

export interface AmpleFileCliActExecutorOptions {
  version: string;
  productName?: string;
  now?: () => Date;
  getActFacade: () => AmpleFileCliActAuthority | null;
  receipts: Pick<AmpleFileCliActReceipts, "append" | "hasAccepted">;
  /** Validates an explicitly named AmpleFile Agent parent while its turn is active. */
  resolveLineageParent?: (taskId: string) => { taskId: string } | null;
  /**
   * Refuse, without running it, a request created longer ago than this. The
   * desktop host sets it for acts that waited in its serial queue, so a
   * caller that gave up and retried never sees the first attempt land late.
   */
  maxQueuedMs?: number;
}

/**
 * The longest `jobs output --wait` one call holds; a longer `--wait` is
 * capped to it, and waiting longer is a repeat read, so no single CLI request outlives the shim's transport
 * timeout or keeps a broker response pending for an unbounded time.
 */
export const AMPLEFILE_CLI_JOBS_OUTPUT_MAX_WAIT_SECONDS = 600;

/**
 * Act verbs the desktop host runs beside its serial CLI queue rather than in
 * it. Each may legitimately take minutes — `jobs output` waits on a job, and
 * `chat compact` runs one model compaction — and both are already fenced by
 * their domain service exactly as when the window asks (the job service and
 * the Chat's compaction fence), so serializing them would only stall every
 * other `amplefile` command behind them. Replay protection does not depend on
 * the queue: the broker dedups an id in flight and claims it once, and the
 * receipts journal accepts an id at most once.
 */
const ampleFileCliActVerbsOutsideQueue: ReadonlySet<AmpleFileCliActParsedCommand["name"]> = new Set([
  "jobs.output",
  "chat.compact",
]);

/** True when the host may run this act request outside its serial queue. */
export function ampleFileCliActRunsOutsideQueue(argv: readonly string[]): boolean {
  try {
    return ampleFileCliActVerbsOutsideQueue.has(parseAmpleFileCliActArgv(argv).name);
  } catch {
    // An argv the parser refuses is answered quickly, so it stays in line.
    return false;
  }
}

export const ampleFileCliActUnavailableMessage =
  "Open AmpleFile to run this command. Act commands need the AmpleFile app running.";

const maxActResultMessages = 100_000;
const maxActPathLength = 4_096;
/** Mirrors `maxQueryLength` in src/local/search.ts so parse and service refuse together. */
const maxActSearchQueryLength = 64 * 1024;
const maxActIdLength = 256;

const cliControlCharacters = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Setup-only families (docs/act-ledger.md): authority and secret
 * surfaces the act lane can neither perform nor stage. They are refused at
 * parse time — before any journal entry — so an act that would amount to one
 * can never even be shaped, and the act lane never grows a verb for them.
 */
const ampleFileCliActSetupOnlyFamilies = new Map<string, string>([
  ["token", "Act-token machinery"],
  ["tokens", "Act-token machinery"],
  ["provider", "Provider credentials"],
  ["providers", "Provider credentials"],
  ["credentials", "Provider credentials"],
  ["settings", "Settings administration"],
]);

/**
 * Parses act-lane argv. Every command requires explicit selection — there is
 * deliberately no current-directory Connected Folder resolution for writes.
 */
export function parseAmpleFileCliActArgv(argv: readonly string[]): AmpleFileCliActParsedCommand {
  let output: AmpleFileCliOutputMode = "human";
  const flags = new Map<string, string | true>();
  const fromPaths: string[] = [];
  const attachValues: string[] = [];
  const pathValues: string[] = [];
  const fileValues: string[] = [];
  const optionValues: string[] = [];
  const positional: string[] = [];

  const valueFlags = new Set([
    "--connected-folder",
    "--conversation",
    "--task",
    "--parent-task",
    "--message",
    "--messages",
    "--name",
    "--path",
    "--from",
    "--attach",
    "--to",
    "--proposal",
    "--until",
    "--title",
    "--label",
    "--checkpoint",
    "--from-checkpoint",
    "--to-checkpoint",
    "--version",
    "--query",
    "--cursor", "--limit", "--offset-bytes", "--length-bytes", "--expected-sha256",
    "--scope",
    "--id",
    "--source",
    "--kind",
    "--automation",
    "--provider",
    "--model",
    "--instructions",
    "--entry",
    "--summary",
    "--summary-file",
    "--question-file",
    "--answer-file",
    "--instructions-file",
    "--data",
    "--outcome",
    "--question",
    "--answer",
    "--to-connected-folder",
    "--to-conversation",
    "--file",
    "--request",
    "--banner-image",
    "--icon",
    "--color",
    "--job",
    "--command",
    "--command-file",
    "--cwd",
    "--timeout",
    "--offset",
    "--wait",
    "--option",
    "--append",
    "--text",
    "--action",
    "--ref",
  ]);
  const booleanFlags = new Set(["--new", "--message-from-payload", "--clear", "--running", "--asynchronous", "--interactive", "--service", "--eof"]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--json") {
      output = "json";
      continue;
    }
    const equals = token.indexOf("=");
    const flagName = token.startsWith("--") && equals > 2 ? token.slice(0, equals) : token;
    if (valueFlags.has(flagName)) {
      let value: string | undefined;
      if (flagName !== token) {
        value = token.slice(equals + 1);
      } else {
        value = argv[index + 1];
        if (value === undefined || (value.startsWith("--") && value !== "--")) {
          throw usageError(`${flagName} requires a value.`);
        }
        index += 1;
      }
      if (flagName === "--from") {
        fromPaths.push(value);
        continue;
      }
      if (flagName === "--attach") {
        attachValues.push(value);
        continue;
      }
      if (flagName === "--path") {
        pathValues.push(value);
        continue;
      }
      if (flagName === "--file") {
        fileValues.push(value);
        continue;
      }
      if (flagName === "--option") {
        optionValues.push(value);
        continue;
      }
      if (flags.has(flagName)) throw usageError(`${flagName} may be provided only once.`);
      flags.set(flagName, value);
      continue;
    }
    if (booleanFlags.has(token)) {
      if (flags.has(token)) throw usageError(`${token} may be provided only once.`);
      flags.set(token, true);
      continue;
    }
    if (token.startsWith("-")) throw usageError(`Unknown option: ${token}`);
    if (!positional.length) {
      // Setup-only refusal happens here, at parse time: these families must
      // not even reach an unknown-command error, let alone a journal entry.
      const setupOnlyCategory = ampleFileCliActSetupOnlyFamilies.get(token);
      if (setupOnlyCategory !== undefined) {
        throw new AmpleFileCliError(
          "permissionDenied",
          `${setupOnlyCategory} is local setup only. The act lane cannot perform it.`,
        );
      }
    }
    positional.push(token);
  }

  const command = positional.join(" ");
  const fromCommands = new Set(["files add", "files move", "tools import-skill"]);
  if (!fromCommands.has(command) && fromPaths.length) {
    throw usageError(`--from cannot be used with '${command || "(none)"}'.`);
  }
  if (command !== "agent send" && attachValues.length) {
    throw usageError(`--attach cannot be used with '${command || "(none)"}'.`);
  }
  const pathCommands = new Set([
    "tools enable", "tools disable",
    "connected-folders register",
    "files rename",
    "files delete",
    "files mkdir",
    "files create",
    "history versions", "search",
    "history read",
    "history diff",
    "history restore-file",
  ]);
  if (!pathCommands.has(command) && pathValues.length) {
    throw usageError(`--path cannot be used with '${command || "(none)"}'.`);
  }
  // --file is repeatable and names deliverables to hand back or copies to
  // carry (docs/collaboration-contract.md); nothing else takes it.
  const fileCommands = new Set(["chat report", "chat handoff"]);
  if (!fileCommands.has(command) && fileValues.length) {
    throw usageError(`--file cannot be used with '${command || "(none)"}'.`);
  }
  // --option is repeatable and offers one suggested answer to a question.
  if (command !== "chat ask" && command !== "agent ask" && optionValues.length) {
    throw usageError(`--option cannot be used with '${command || "(none)"}'.`);
  }
  // The request graph sits above Connected Folders: every request names the Connected Folder
  // it belongs to, so neither read takes one.
  if (positional[0] === "requests" && flags.has("--connected-folder")) {
    throw usageError("The request graph sits above Connected Folders, so 'requests' takes no --connected-folder.");
  }
  const stringFlag = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const requireConnectedFolder = (): string => {
    const connectedFolder = stringFlag("--connected-folder")?.trim();
    if (!connectedFolder) throw usageError("Act commands require an explicit --connected-folder <id-or-name>.");
    return connectedFolder;
  };
  const requireConversation = (): string => {
    const conversation = stringFlag("--conversation")?.trim();
    if (!conversation) throw usageError("Provide --conversation <id>.");
    return conversation;
  };
  const requireConversationOrTask = (): { conversation?: string; task?: string } => {
    const conversation = stringFlag("--conversation")?.trim();
    const task = stringFlag("--task")?.trim();
    if (conversation && task) throw usageError("Use either --conversation <id> or --task <id>, not both.");
    if (!conversation && !task) throw usageError("Provide --conversation <id> or --task <id>.");
    return conversation ? { conversation } : { task };
  };
  const allowOnlyFlags = (...names: string[]) => {
    const allowed = new Set(names);
    for (const name of flags.keys()) {
      if (!allowed.has(name)) throw usageError(`${name} cannot be used with '${command}'.`);
    }
  };
  const requireBoundedFlag = (name: string, label: string, maximumLength = maxActIdLength): string => {
    const value = stringFlag(name)?.trim();
    if (!value) throw usageError(`Provide ${name} <${label}>.`);
    if (value.length > maximumLength) throw usageError(`${name} must be at most ${maximumLength} characters.`);
    if (cliControlCharacters.test(value)) {
      throw usageError(`${name} contains unsupported control characters.`);
    }
    return value;
  };
  const optionalBoundedFlag = (name: string, label: string, maximumLength = maxActIdLength): string | undefined =>
    stringFlag(name) === undefined ? undefined : requireBoundedFlag(name, label, maximumLength);
  const optionalInteger = (name: string, minimum: number, maximum: number): number | undefined => {
    const text = stringFlag(name); if (text === undefined) return undefined;
    const value = Number(text);
    if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw usageError(`${name} must be between ${minimum} and ${maximum}.`);
    return value;
  };
  const pageOptions = () => ({
    ...(stringFlag("--cursor") !== undefined ? { cursor: requireBoundedFlag("--cursor", "cursor", 128 * 1024) } : {}),
    ...(stringFlag("--limit") !== undefined ? { limit: optionalInteger("--limit", 1, 1000) } : {}),
  });
  const boundedActPath = (flag: string, raw: string, label: string): string => {
    const value = raw.trim();
    if (!value) throw usageError(`Provide ${flag} <${label}>.`);
    if (value.length > maxActPathLength) throw usageError(`${flag} must be at most ${maxActPathLength} characters.`);
    if (cliControlCharacters.test(value)) throw usageError(`${flag} contains unsupported control characters.`);
    return value;
  };
  /**
   * A report summary, a question, and an answer are prose: they may carry the
   * newlines `chat send --message` already allows, and the contract states
   * their bounds in KiB, so they are measured in bytes. The act lane's own
   * per-argument cap still bites first for very long text, which is what
   * `--message-file` and `--data @<path>` exist for.
   */
  const textFiles: NonNullable<AmpleFileCliActParsedCommand["textFiles"]> = {};
  /** `--<field>-file <path>` stands in for `--<field> <text>`; exactly one is allowed. */
  const textFileFlag = (name: string, field: keyof typeof textFiles): string | undefined => {
    const path = stringFlag(`${name}-file`);
    if (path === undefined) return undefined;
    if (stringFlag(name) !== undefined) throw usageError(`Use either ${name} <text> or ${name}-file <path>, not both.`);
    textFiles[field] = boundedActPath(`${name}-file`, path, "path");
    return "";
  };
  const requireCollaborationText = (
    name: string,
    label: string,
    limit: "questionText" | "answerText" | "resultSummary",
    maximumBytes: number,
  ): string => {
    const field = name === "--summary" ? "summary" : name === "--question" ? "question" : "answer";
    if (textFileFlag(name, field) !== undefined) return "";
    const value = stringFlag(name);
    if (value === undefined || !value.trim()) throw usageError(`Provide ${name} <${label}> or ${name}-file <path>.`);
    if (value.includes("\u0000")) throw usageError(`${name} contains unsupported control characters.`);
    if (Buffer.byteLength(value, "utf8") > maximumBytes) {
      throw usageError(ampleFileRequestLimitMessage(limit, maximumBytes));
    }
    return value;
  };
  const questionOptions = (): string[] => {
    try {
      return parseAmpleFileQuestionOptions(optionValues);
    } catch (error) {
      throw usageError(`--option: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const collaborationFiles = (): string[] => {
    const files = fileValues.map((value) => boundedActPath("--file", value, "connected-folder-path"));
    if (new Set(files).size !== files.length) throw usageError("--file names the same path twice.");
    return files;
  };
  /**
   * `--data` is either inline JSON or `@<path>`. The file form defers the
   * read to the host, which resolves it against the directory the command ran
   * in — the same shape as `automations enable --proposal`. It is not a
   * convenience: one act argument caps well below the envelope's own data
   * limit, so anything sizeable has to arrive as a file.
   */
  const resultDataFlag = (): { resultData?: unknown; resultDataPath?: string } => {
    const raw = stringFlag("--data");
    if (raw === undefined) return {};
    const value = raw.trim();
    if (!value) throw usageError("Provide --data <json> or --data @<path>.");
    if (value.startsWith("@")) return { resultDataPath: boundedActPath("--data", value.slice(1), "json-path") };
    if (Buffer.byteLength(value, "utf8") > ampleFileRequestLimits.maxResultDataBytes) {
      throw usageError(ampleFileRequestLimitMessage("resultData", ampleFileRequestLimits.maxResultDataBytes));
    }
    // Deliberately not requireBoundedFlag: pretty-printed JSON carries the
    // newlines that rule refuses, and the host validates the parsed value
    // against the schema the request declared, when it declared one.
    try {
      return { resultData: JSON.parse(value) };
    } catch {
      throw usageError("--data must be valid JSON, or @<path> naming a JSON file.");
    }
  };
  const requireSinglePath = (label: string): string => {
    if (pathValues.length > 1) throw usageError("--path may be provided only once.");
    if (!pathValues.length) throw usageError(`Provide --path <${label}>.`);
    return boundedActPath("--path", pathValues[0] ?? "", label);
  };
  const requireSingleFrom = (label: string): string => {
    if (fromPaths.length !== 1) throw usageError(`Provide exactly one --from <${label}>.`);
    return boundedActPath("--from", fromPaths[0] ?? "", label);
  };
  const requireIsoUntil = (): string => {
    const rawUntil = requireBoundedFlag("--until", "ISO-timestamp");
    if (!Number.isFinite(Date.parse(rawUntil))) throw usageError("--until must be an ISO timestamp.");
    return new Date(rawUntil).toISOString();
  };
  /**
   * Scope is authority (docs/act-ledger.md): `connected-folder` scope must name its
   * Connected Folder explicitly, and `everywhere` scope must not carry one.
   */
  const requireToolsScope = (): { toolsScope: "everywhere" | "connected-folder"; connectedFolder?: string } => {
    const rawScope = requireBoundedFlag("--scope", "everywhere|connected-folder");
    if (rawScope !== "everywhere" && rawScope !== "connected-folder") throw usageError("--scope must be everywhere or Connected Folder.");
    const connectedFolder = stringFlag("--connected-folder")?.trim();
    if (rawScope === "connected-folder" && !connectedFolder) throw usageError("--scope connected-folder requires an explicit --connected-folder <id-or-name>.");
    if (rawScope === "everywhere" && connectedFolder) throw usageError("--connected-folder cannot be used with --scope everywhere.");
    return { toolsScope: rawScope, ...(connectedFolder ? { connectedFolder } : {}) };
  };
  const rawParentTaskId = stringFlag("--parent-task");
  // Every mutation family accepts explicit AmpleFile Agent lineage; content-bearing
  // act reads (status, result, list, versions, search) deliberately do not.
  const lineageCommands = new Set([
    "chat send",
    "chat rename",
    "chat snooze",
    "chat archive",
    "chat resume",
    "chat compact",
    "chat report",
    "chat ask",
    "chat answer",
    "agent ask",
    "agent answer",
    "chat handoff",
    "chat steer",
    "chat copy",
    "history save",
    "history restore",
    "history restore-file",
    "files add",
    "files move",
    "files rename",
    "files delete",
    "files mkdir",
    "files create",
    "connected-folders create",
    "connected-folders register",
    "connected-folders rename",
    "connected-folders unregister",
    "connected-folders delete",
    "connected-folders appearance apply",
    "connected-folders appearance reset",
    "connected-folders appearance undo",
    "connected-folders worker model",
    "connected-folders worker instructions",
    "tools import-skill",
    "tools install",
    "tools update",
    "tools enable",
    "tools disable",
    "tools remove",
    "automations enable",
    "automations run",
    "automations stop",
    "automations disable",
    "automations delete",
    "recently-deleted restore",
    "jobs input",
    "worktrees manage",
    "jobs start",
    "jobs stop",
  ]);
  if (rawParentTaskId !== undefined && !lineageCommands.has(command)) {
    throw usageError(`--parent-task cannot be used with '${command || "(none)"}'.`);
  }
  const parentTaskId = rawParentTaskId === undefined
    ? undefined
    : requireBoundedFlag("--parent-task", "agent-task-id");

  switch (command) {
    case "chat create":
      allowOnlyFlags("--connected-folder");
      return { name: "chat.create", output, connectedFolder: requireConnectedFolder() };
    case "chat send": {
      allowOnlyFlags("--connected-folder", "--conversation", "--new", "--message", "--message-from-payload", "--parent-task");
      const connectedFolder = requireConnectedFolder();
      const newConversation = flags.get("--new") === true;
      const conversation = stringFlag("--conversation")?.trim();
      if (newConversation && conversation) throw usageError("Use either --conversation <id> or --new, not both.");
      if (!newConversation && !conversation) throw usageError("Provide --conversation <id> or --new.");
      const message = stringFlag("--message");
      const messageFromPayload = flags.get("--message-from-payload") === true;
      if (message !== undefined && messageFromPayload) {
        throw usageError("Use either --message <text> or --message-file <path>, not both.");
      }
      if (message === undefined && !messageFromPayload) {
        throw usageError("Provide --message <text> or --message-file <path>.");
      }
      return {
        name: "chat.send",
        output,
        connectedFolder,
        ...(conversation ? { conversation } : {}),
        ...(newConversation ? { newConversation } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(messageFromPayload ? { messageFromPayload } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "chat status": {
      allowOnlyFlags("--connected-folder", "--conversation", "--task");
      const selection = requireConversationOrTask();
      return { name: "chat.status", output, connectedFolder: requireConnectedFolder(), ...selection };
    }
    case "chat result": {
      allowOnlyFlags("--connected-folder", "--conversation", "--task", "--messages");
      const selection = requireConversationOrTask();
      const rawMessages = stringFlag("--messages");
      if (rawMessages !== undefined && selection.task) {
        throw usageError("--messages applies to --conversation results; a --task result is one message.");
      }
      let messages: number | undefined;
      if (rawMessages !== undefined) {
        messages = Number(rawMessages);
        if (!Number.isInteger(messages) || messages < 1 || messages > maxActResultMessages) {
          throw usageError(`--messages must be an integer between 1 and ${maxActResultMessages}.`);
        }
      }
      return {
        name: "chat.result",
        output,
        connectedFolder: requireConnectedFolder(),
        ...selection,
        ...(messages !== undefined ? { messages } : {}),
      };
    }
    case "chat abort":
      allowOnlyFlags("--connected-folder", "--conversation");
      return { name: "chat.abort", output, connectedFolder: requireConnectedFolder(), conversation: requireConversation() };
    case "chat rename":
      allowOnlyFlags("--connected-folder", "--conversation", "--title", "--parent-task");
      return {
        name: "chat.rename",
        output,
        connectedFolder: requireConnectedFolder(),
        conversation: requireConversation(),
        title: requireBoundedFlag("--title", "title"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat snooze":
      allowOnlyFlags("--connected-folder", "--conversation", "--until", "--parent-task");
      return {
        name: "chat.snooze",
        output,
        connectedFolder: requireConnectedFolder(),
        conversation: requireConversation(),
        until: requireIsoUntil(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat archive":
      allowOnlyFlags("--connected-folder", "--conversation", "--parent-task");
      return {
        name: "chat.archive",
        output,
        connectedFolder: requireConnectedFolder(),
        conversation: requireConversation(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat resume":
      allowOnlyFlags("--connected-folder", "--conversation", "--parent-task");
      return {
        name: "chat.resume",
        output,
        connectedFolder: requireConnectedFolder(),
        conversation: requireConversation(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat compact":
      allowOnlyFlags("--connected-folder", "--conversation", "--parent-task");
      return {
        name: "chat.compact",
        output,
        connectedFolder: requireConnectedFolder(),
        conversation: requireConversation(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat report": {
      // One result envelope attached to a task the caller owns. Parse
      // bounds only what argv can carry; the host resolves each --file inside
      // the Connected Folder, records its content hash and size, and applies the declared
      // schema to --data when the request declared one.
      allowOnlyFlags("--connected-folder", "--task", "--summary", "--summary-file", "--data", "--outcome", "--parent-task");
      const rawOutcome = stringFlag("--outcome")?.trim();
      if (rawOutcome !== undefined && rawOutcome !== "succeeded" && rawOutcome !== "partial" && rawOutcome !== "failed") {
        throw usageError("--outcome must be succeeded, partial, or failed.");
      }
      return {
        name: "chat.report",
        output,
        connectedFolder: requireConnectedFolder(),
        task: requireBoundedFlag("--task", "task-id"),
        summary: requireCollaborationText("--summary", "text", "resultSummary", ampleFileRequestLimits.maxResultSummaryBytes),
        ...(Object.keys(textFiles).length ? { textFiles } : {}),
        files: collaborationFiles(),
        outcome: (rawOutcome ?? "succeeded") as AmpleFileResultOutcome,
        ...resultDataFlag(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "agent ask":
    case "chat ask": {
      // Recording a question never suspends the asking turn. The turn
      // ends; the task's request is what waits.
      allowOnlyFlags(...(command === "agent ask" ? ["--task", "--question", "--question-file", "--parent-task", "--asynchronous"] : ["--connected-folder", "--task", "--question", "--question-file", "--to", "--parent-task", "--asynchronous"]));
      // --option is collected apart from flags and checked above.
      const rawRespondent = stringFlag("--to")?.trim();
      if (rawRespondent !== undefined && rawRespondent !== "person" && rawRespondent !== "parent") {
        throw usageError("--to must be person or parent.");
      }
      return {
        name: command === "agent ask" ? "agent.ask" : "chat.ask",
        output,
        ...(command === "chat ask" ? { connectedFolder: requireConnectedFolder() } : {}),
        task: requireBoundedFlag("--task", "task-id"),
        // Free text here; `chat answer --question` carries an id. That is the
        // contract's spelling, not an oversight.
        question: requireCollaborationText("--question", "text", "questionText", ampleFileRequestLimits.maxQuestionTextBytes),
        ...(Object.keys(textFiles).length ? { textFiles } : {}),
        // A root request has no parent, so the host delivers `parent` to the
        // person and says it did.
        respondent: (rawRespondent ?? "person") as "person" | "parent",
        ...(optionValues.length ? { options: questionOptions() } : {}),
        ...(flags.has("--asynchronous") ? { asynchronous: true } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "agent answer":
    case "chat answer":
      // --connected-folder names the Connected Folder that owns the question and in which the one
      // linked continuation runs; an answer from anywhere else is refused.
      allowOnlyFlags(...(command === "agent answer" ? ["--question", "--answer", "--answer-file", "--parent-task"] : ["--connected-folder", "--question", "--answer", "--answer-file", "--parent-task"]));
      return {
        name: command === "agent answer" ? "agent.answer" : "chat.answer",
        output,
        ...(command === "chat answer" ? { connectedFolder: requireConnectedFolder() } : {}),
        questionId: requireBoundedFlag("--question", "question-id"),
        answer: requireCollaborationText("--answer", "text", "answerText", ampleFileRequestLimits.maxAnswerTextBytes),
        ...(Object.keys(textFiles).length ? { textFiles } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "chat children":
      allowOnlyFlags("--connected-folder", "--task");
      return { name: "chat.children", output, connectedFolder: requireConnectedFolder(), task: requireBoundedFlag("--task", "task-id") };
    case "chat steer": {
      // One more message into a Chat's running turn, delivered after its
      // current step. --task names the caller's own running turn when a
      // Worker redirects work its Chat handed off.
      allowOnlyFlags("--connected-folder", "--conversation", "--task", "--message", "--message-from-payload", "--parent-task");
      const message = stringFlag("--message");
      const messageFromPayload = flags.get("--message-from-payload") === true;
      if (message !== undefined && messageFromPayload) throw usageError("Use either --message <text> or --message-file <path>, not both.");
      if (message === undefined && !messageFromPayload) throw usageError("Provide --message <text> or --message-file <path>.");
      const task = optionalBoundedFlag("--task", "task-id");
      return {
        name: "chat.steer",
        output,
        connectedFolder: requireConnectedFolder(),
        conversation: requireConversation(),
        ...(task ? { task } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(messageFromPayload ? { messageFromPayload } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "chat copy": {
      // A copy of a Chat as of its last finished turn, in the same
      // Connected Folder; --message starts work in the copy at once.
      allowOnlyFlags("--connected-folder", "--conversation", "--task", "--title", "--message", "--message-from-payload", "--parent-task");
      const message = stringFlag("--message");
      const messageFromPayload = flags.get("--message-from-payload") === true;
      if (message !== undefined && messageFromPayload) throw usageError("Use either --message <text> or --message-file <path>, not both.");
      const task = optionalBoundedFlag("--task", "task-id");
      if (task && message === undefined && !messageFromPayload) throw usageError("A copy made from your own turn needs --message <text> with its assignment.");
      const title = optionalBoundedFlag("--title", "title");
      return {
        name: "chat.copy",
        output,
        connectedFolder: requireConnectedFolder(),
        conversation: requireConversation(),
        ...(task ? { task } : {}),
        ...(title ? { title } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(messageFromPayload ? { messageFromPayload } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "chat handoff": {
      // The message either/or is exactly `chat send`'s, because a handoff
      // starts a Chat in the destination through that same acceptance path.
      allowOnlyFlags("--connected-folder", "--task", "--to-connected-folder", "--to-conversation", "--message", "--message-from-payload", "--parent-task");
      const toConversation = optionalBoundedFlag("--to-conversation", "conversation-id");
      const message = stringFlag("--message");
      const messageFromPayload = flags.get("--message-from-payload") === true;
      if (message !== undefined && messageFromPayload) {
        throw usageError("Use either --message <text> or --message-file <path>, not both.");
      }
      if (message === undefined && !messageFromPayload) {
        throw usageError("Provide --message <text> or --message-file <path>.");
      }
      return {
        name: "chat.handoff",
        output,
        connectedFolder: requireConnectedFolder(),
        task: requireBoundedFlag("--task", "task-id"),
        toConnectedFolder: requireBoundedFlag("--to-connected-folder", "id-or-name"),
        ...(toConversation ? { toConversation } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(messageFromPayload ? { messageFromPayload } : {}),
        // A handoff copies through the same additive, restore-pointed path an
        // automation files step uses, so it carries that step's own path bound.
        files: collaborationFiles(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "chat wait":
    case "agent wait":
      // The wait is a shim-side poll on purpose: a host-side blocking wait
      // would hold the broker request open past its timeout. The current
      // shim also settles when the task is waiting on an answer.
      throw usageError(`${command} runs inside the AmpleFile shim; update the installed AmpleFile CLI.`);
    case "agent send": {
      allowOnlyFlags("--conversation", "--new", "--message", "--message-from-payload");
      const newConversation = flags.get("--new") === true;
      const conversation = stringFlag("--conversation")?.trim();
      if (newConversation && conversation) throw usageError("Use either --conversation <id> or --new, not both.");
      const message = stringFlag("--message");
      const messageFromPayload = flags.get("--message-from-payload") === true;
      if (message !== undefined && messageFromPayload) {
        throw usageError("Use either --message <text> or --message-file <path>, not both.");
      }
      if (message === undefined && !messageFromPayload) {
        throw usageError("Provide --message <text> or --message-file <path>.");
      }
      return {
        name: "agent.send",
        output,
        ...(conversation ? { conversation } : {}),
        ...(newConversation ? { newConversation } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(messageFromPayload ? { messageFromPayload } : {}),
        ...(attachValues.length ? { attachments: [...attachValues] } : {}),
      };
    }
    case "agent stop": {
      allowOnlyFlags("--task");
      const task = stringFlag("--task")?.trim();
      if (!task) throw usageError("Provide --task <id>.");
      return { name: "agent.stop", output, task };
    }
    case "agent status": {
      allowOnlyFlags("--conversation", "--task");
      const conversation = stringFlag("--conversation")?.trim();
      const task = stringFlag("--task")?.trim();
      if (conversation && task) throw usageError("Use either --conversation <id> or --task <id>, not both.");
      return {
        name: "agent.status",
        output,
        ...(conversation ? { conversation } : {}),
        ...(task ? { task } : {}),
      };
    }
    case "agent result": {
      allowOnlyFlags("--conversation", "--task", "--messages");
      const conversation = stringFlag("--conversation")?.trim();
      const task = stringFlag("--task")?.trim();
      if (conversation && task) throw usageError("Use either --conversation <id> or --task <id>, not both.");
      const rawMessages = stringFlag("--messages");
      if (rawMessages !== undefined && task) {
        throw usageError("--messages applies to conversation results; a --task result is one message.");
      }
      let messages: number | undefined;
      if (rawMessages !== undefined) {
        messages = Number(rawMessages);
        if (!Number.isInteger(messages) || messages < 1 || messages > maxActResultMessages) {
          throw usageError(`--messages must be an integer between 1 and ${maxActResultMessages}.`);
        }
      }
      return {
        name: "agent.result",
        output,
        ...(conversation ? { conversation } : {}),
        ...(task ? { task } : {}),
        ...(messages !== undefined ? { messages } : {}),
      };
    }
    case "agent abort":
      allowOnlyFlags("--conversation");
      return {
        name: "agent.abort",
        output,
        ...(stringFlag("--conversation")?.trim() ? { conversation: stringFlag("--conversation")!.trim() } : {}),
      };
    case "agent list":
      allowOnlyFlags();
      return { name: "agent.list", output };
    case "agent overview":
      allowOnlyFlags();
      return { name: "agent.overview", output };
    case "chats list":
      allowOnlyFlags("--connected-folder");
      return { name: "chats.list", output, connectedFolder: requireConnectedFolder() };
    case "history list":
      allowOnlyFlags("--connected-folder", "--cursor", "--limit");
      return { name: "history.list", output, connectedFolder: requireConnectedFolder(), ...pageOptions() };
    case "history save": {
      allowOnlyFlags("--connected-folder", "--label", "--parent-task");
      const label = optionalBoundedFlag("--label", "label");
      return {
        name: "history.save",
        output,
        connectedFolder: requireConnectedFolder(),
        ...(label !== undefined ? { label } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "history restore":
      allowOnlyFlags("--connected-folder", "--checkpoint", "--parent-task");
      return {
        name: "history.restore",
        output,
        connectedFolder: requireConnectedFolder(),
        checkpoint: requireBoundedFlag("--checkpoint", "checkpoint-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "history versions":
      allowOnlyFlags("--connected-folder", "--cursor", "--limit");
      return {
        name: "history.versions", ...pageOptions(),
        output,
        connectedFolder: requireConnectedFolder(),
        path: requireSinglePath("connected-folder-path"),
      };
    case "history read":
      allowOnlyFlags("--connected-folder", "--checkpoint", "--offset-bytes", "--length-bytes", "--expected-sha256");
      return {
        name: "history.read", output, connectedFolder: requireConnectedFolder(),
        ...(stringFlag("--offset-bytes") !== undefined ? { offsetBytes: optionalInteger("--offset-bytes", 0, Number.MAX_SAFE_INTEGER) } : {}),
        ...(stringFlag("--length-bytes") !== undefined ? { lengthBytes: optionalInteger("--length-bytes", 4, 128 * 1024) } : {}),
        ...(stringFlag("--expected-sha256") !== undefined ? { expectedSha256: requireBoundedFlag("--expected-sha256", "sha256", 64) } : {}),
        path: requireSinglePath("connected-folder-path"),
        checkpoint: requireBoundedFlag("--checkpoint", "checkpoint-id"),
      };
    case "history diff": {
      allowOnlyFlags("--connected-folder", "--from-checkpoint", "--to-checkpoint");
      const toCheckpoint = optionalBoundedFlag("--to-checkpoint", "checkpoint-id");
      return {
        name: "history.diff", output, connectedFolder: requireConnectedFolder(),
        path: requireSinglePath("connected-folder-path"),
        fromCheckpoint: requireBoundedFlag("--from-checkpoint", "checkpoint-id"),
        ...(toCheckpoint ? { toCheckpoint } : {}),
      };
    }
    case "history restore-file":
      allowOnlyFlags("--connected-folder", "--version", "--parent-task");
      return {
        name: "history.restore-file",
        output,
        connectedFolder: requireConnectedFolder(),
        path: requireSinglePath("connected-folder-path"),
        version: requireBoundedFlag("--version", "sha256"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "search": {
      allowOnlyFlags("--connected-folder", "--query", "--scope", "--cursor", "--limit");
      const query = requireBoundedFlag("--query", "text", maxActSearchQueryLength);
      const rawScope = optionalBoundedFlag("--scope", "files|chats|all");
      if (rawScope !== undefined && rawScope !== "files" && rawScope !== "chats" && rawScope !== "all") {
        throw usageError("--scope must be files, chats, or all.");
      }
      return {
        name: "search", ...pageOptions(),
        ...(pathValues.length ? { path: requireSinglePath("connected-folder-path") } : {}),
        output,
        connectedFolder: requireConnectedFolder(),
        query,
        ...(rawScope !== undefined ? { searchScope: rawScope } : {}),
      };
    }
    case "connected-folders create": {
      allowOnlyFlags("--name", "--parent-task");
      const connectedFolderName = stringFlag("--name")?.trim();
      if (!connectedFolderName) throw usageError("Provide --name <connected-folder-name>.");
      return { name: "connected-folders.create", output, connectedFolderName, ...(parentTaskId ? { parentTaskId } : {}) };
    }
    case "connected-folders register": {
      allowOnlyFlags("--parent-task");
      if (pathValues.length > 1) throw usageError("--path may be provided only once.");
      const registerPath = pathValues[0]?.trim();
      if (!registerPath) throw usageError("Provide --path <absolute-folder-path>.");
      return { name: "connected-folders.register", output, registerPath, ...(parentTaskId ? { parentTaskId } : {}) };
    }
    case "connected-folders rename":
      allowOnlyFlags("--connected-folder", "--name", "--parent-task");
      return {
        name: "connected-folders.rename",
        output,
        connectedFolder: requireConnectedFolder(),
        connectedFolderName: requireBoundedFlag("--name", "connected-folder-name"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "connected-folders unregister":
      allowOnlyFlags("--connected-folder", "--parent-task");
      return {
        name: "connected-folders.unregister",
        output,
        connectedFolder: requireConnectedFolder(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "connected-folders delete":
      allowOnlyFlags("--connected-folder", "--parent-task");
      return {
        name: "connected-folders.delete",
        output,
        connectedFolder: requireConnectedFolder(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "connected-folders appearance apply": {
      // File-borne input: the typed proposal passes as a path resolved
      // host-side, the same pattern as `automations enable --proposal`. Or name
      // just the parts to change; the image is read and encoded host-side.
      allowOnlyFlags("--connected-folder", "--proposal", "--banner-image", "--icon", "--color", "--parent-task");
      const proposalPath = optionalBoundedFlag("--proposal", "proposal-path", maxActPathLength);
      const bannerImagePath = optionalBoundedFlag("--banner-image", "image-path", maxActPathLength);
      const icon = optionalBoundedFlag("--icon", "icon-name", 64);
      const color = optionalBoundedFlag("--color", "#rrggbb", 16);
      const parts = { ...(bannerImagePath ? { bannerImagePath } : {}), ...(icon ? { icon } : {}), ...(color ? { color } : {}) };
      if (proposalPath && Object.keys(parts).length) throw usageError("Use --proposal, or --banner-image/--icon/--color, not both.");
      if (!proposalPath && !Object.keys(parts).length) {
        throw usageError("Provide --proposal <path>, or at least one of --banner-image <path>, --icon <name>, --color <#rrggbb>.");
      }
      return {
        name: "connected-folders.appearance.apply",
        output,
        connectedFolder: requireConnectedFolder(),
        ...(proposalPath ? { proposalPath } : { appearanceParts: parts }),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "connected-folders appearance reset":
      allowOnlyFlags("--connected-folder", "--parent-task");
      return {
        name: "connected-folders.appearance.reset",
        output,
        connectedFolder: requireConnectedFolder(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "connected-folders appearance undo":
      allowOnlyFlags("--connected-folder", "--parent-task");
      return {
        name: "connected-folders.appearance.undo",
        output,
        connectedFolder: requireConnectedFolder(),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "connected-folders worker show":
      allowOnlyFlags("--connected-folder");
      return { name: "connected-folders.worker.show", output, connectedFolder: requireConnectedFolder() };
    case "connected-folders worker model":
      allowOnlyFlags("--connected-folder", "--provider", "--model", "--parent-task");
      return {
        name: "connected-folders.worker.model",
        output,
        connectedFolder: requireConnectedFolder(),
        provider: requireBoundedFlag("--provider", "provider-id"),
        model: requireBoundedFlag("--model", "model-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "connected-folders worker instructions": {
      allowOnlyFlags("--connected-folder", "--instructions", "--instructions-file", "--append", "--clear", "--parent-task");
      const clear = flags.get("--clear") === true;
      const rawInstructions = textFileFlag("--instructions", "instructions") ?? stringFlag("--instructions");
      // --append adds one remembered line to the current instructions instead
      // of replacing them, so a Worker can keep a lasting preference without
      // rewriting what the person or Set up for me already wrote.
      const append = stringFlag("--append");
      if ([clear, rawInstructions !== undefined, append !== undefined].filter(Boolean).length !== 1) {
        throw usageError("Provide exactly one of --instructions <text>, --instructions-file <path>, --append <text>, or --clear.");
      }
      if (append !== undefined && !append.trim()) throw usageError("Provide --append <text>.");
      const text = append ?? rawInstructions;
      if (text !== undefined && text.length > maximumWorkerInstructionsLength) {
        throw usageError(`${append !== undefined ? "--append" : "--instructions"} must be at most ${maximumWorkerInstructionsLength} characters.`);
      }
      return {
        name: "connected-folders.worker.instructions",
        output,
        connectedFolder: requireConnectedFolder(),
        instructions: clear ? "" : text!,
        ...(Object.keys(textFiles).length ? { textFiles } : {}),
        ...(clear ? { clear: true } : {}),
        ...(append !== undefined ? { appendInstructions: true } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "files add": {
      allowOnlyFlags("--connected-folder", "--to", "--parent-task");
      if (!fromPaths.length) throw usageError("Provide at least one --from <path>.");
      const toDir = stringFlag("--to");
      return {
        name: "files.add",
        output,
        connectedFolder: requireConnectedFolder(),
        fromPaths: [...fromPaths],
        ...(toDir !== undefined ? { toDir } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "files move":
      allowOnlyFlags("--connected-folder", "--to", "--parent-task");
      return {
        name: "files.move",
        output,
        connectedFolder: requireConnectedFolder(),
        fromPaths: [requireSingleFrom("connected-folder-path")],
        toDir: requireBoundedFlag("--to", "folder-in-connected-folder", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "files rename":
      allowOnlyFlags("--connected-folder", "--name", "--parent-task");
      return {
        name: "files.rename",
        output,
        connectedFolder: requireConnectedFolder(),
        path: requireSinglePath("connected-folder-path"),
        entryName: requireBoundedFlag("--name", "new-name"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "files delete":
      allowOnlyFlags("--connected-folder", "--parent-task");
      return {
        name: "files.delete",
        output,
        connectedFolder: requireConnectedFolder(),
        path: requireSinglePath("connected-folder-path"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "files mkdir":
      allowOnlyFlags("--connected-folder", "--parent-task");
      return {
        name: "files.mkdir",
        output,
        connectedFolder: requireConnectedFolder(),
        path: requireSinglePath("folder-in-connected-folder"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "files create":
      allowOnlyFlags("--connected-folder", "--parent-task");
      return {
        name: "files.create",
        output,
        connectedFolder: requireConnectedFolder(),
        path: requireSinglePath("connected-folder-path"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "tools import-skill":
      allowOnlyFlags("--scope", "--connected-folder", "--parent-task");
      return {
        name: "tools.import-skill",
        output,
        ...requireToolsScope(),
        fromPaths: [requireSingleFrom("skill-path")],
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "tools install": {
      allowOnlyFlags("--id", "--source", "--scope", "--connected-folder", "--parent-task");
      const catalogId = optionalBoundedFlag("--id", "catalog-id");
      const source = optionalBoundedFlag("--source", "package-source", maxActPathLength);
      if ((catalogId === undefined) === (source === undefined)) {
        throw usageError("Provide exactly one of --id <catalog-id> or --source <package-source>.");
      }
      return {
        name: "tools.install",
        output,
        ...requireToolsScope(),
        ...(catalogId !== undefined ? { catalogId } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "tools enable":
    case "tools disable": {
      allowOnlyFlags("--path", "--kind", "--scope", "--connected-folder", "--parent-task");
      const kind = requireBoundedFlag("--kind", "resource-kind");
      if (!["extensions", "skills", "prompts", "themes"].includes(kind)) throw usageError("--kind must be extensions, skills, prompts, or themes.");
      return { name: command === "tools enable" ? "tools.enable" : "tools.disable", output, ...requireToolsScope(), path: requireSinglePath("resource-path"), resourceKind: kind as AmpleFileCliActParsedCommand["resourceKind"], ...(parentTaskId ? { parentTaskId } : {}) };
    }
    case "tools update":
      allowOnlyFlags("--source", "--scope", "--connected-folder", "--parent-task");
      return {
        name: "tools.update",
        output,
        ...requireToolsScope(),
        source: requireBoundedFlag("--source", "package-source", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "tools remove":
      allowOnlyFlags("--source", "--scope", "--connected-folder", "--parent-task");
      return {
        name: "tools.remove",
        output,
        ...requireToolsScope(),
        source: requireBoundedFlag("--source", "package-source", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "automations enable":
      // Automations are above Connected Folders (docs/automations.md): no
      // --connected-folder, like the agent group. The inert typed proposal passes as
      // a path resolved host-side, the same pattern as `connected-folders appearance apply --proposal`.
      allowOnlyFlags("--proposal", "--parent-task");
      return {
        name: "automations.enable",
        output,
        proposalPath: requireBoundedFlag("--proposal", "proposal-path", maxActPathLength),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    // Recently deleted sits above Connected Folders (docs/act-ledger.md):
    // each item names the Connected Folder it came from, so neither verb takes
    // --connected-folder.
    case "recently-deleted list":
      allowOnlyFlags();
      return { name: "recently-deleted.list", output };
    case "recently-deleted restore":
      allowOnlyFlags("--entry", "--parent-task");
      return {
        name: "recently-deleted.restore",
        output,
        entry: requireBoundedFlag("--entry", "recently-deleted-id", 64),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    // Reads of the request graph (docs/collaboration-contract.md): what
    // was handed out under one request, what is still open, and what came
    // back. Reads take no lineage, matching the other act reads.
    case "requests list":
      allowOnlyFlags();
      return { name: "requests.list", output };
    case "requests show":
      allowOnlyFlags("--request");
      return { name: "requests.show", output, request: requireBoundedFlag("--request", "request-id") };
    case "automations list":
      allowOnlyFlags();
      return { name: "automations.list", output };
    case "automations models":
      allowOnlyFlags();
      return { name: "automations.models", output };
    case "automations show":
      allowOnlyFlags("--automation");
      return { name: "automations.show", output, automation: requireBoundedFlag("--automation", "automation-id") };
    case "automations run":
    case "automations stop":
    case "automations disable":
    case "automations delete":
      allowOnlyFlags("--automation", "--parent-task");
      return {
        name: command === "automations run"
          ? "automations.run"
          : command === "automations stop"
            ? "automations.stop"
            : command === "automations disable"
              ? "automations.disable"
              : "automations.delete",
        output,
        automation: requireBoundedFlag("--automation", "automation-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    case "automations receipts": {
      allowOnlyFlags("--automation");
      const automation = optionalBoundedFlag("--automation", "automation-id");
      return { name: "automations.receipts", output, ...(automation ? { automation } : {}) };
    }
    // Background jobs (docs/background-jobs.md). start needs the caller's own
    // running turn, as chat report does; every verb names the job's Connected Folder.
    case "jobs start": {
      allowOnlyFlags("--connected-folder", "--task", "--command", "--command-file", "--name", "--cwd", "--timeout", "--parent-task", "--interactive", "--service");
      const jobCommand = (() => {
        if (textFileFlag("--command", "command") !== undefined) return "";
        const value = stringFlag("--command");
        if (value === undefined || !value.trim()) throw usageError("Provide --command <shell-command> or --command-file <path>.");
        if (value.includes("\u0000")) throw usageError("--command contains unsupported control characters.");
        if (Buffer.byteLength(value, "utf8") > ampleFileBackgroundJobLimits.maxCommandBytes) {
          throw usageError(`--command can be at most ${ampleFileBackgroundJobLimits.maxCommandBytes / 1024} KiB.`);
        }
        return value;
      })();
      const rawTimeout = stringFlag("--timeout");
      const timeoutSeconds = rawTimeout === undefined ? undefined : Number(rawTimeout);
      if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
        throw usageError("--timeout must be a positive number of seconds.");
      }
      const jobName = optionalBoundedFlag("--name", "label", 200);
      const jobCwd = optionalBoundedFlag("--cwd", "folder", maxActPathLength);
      return {
        name: "jobs.start",
        output,
        connectedFolder: requireConnectedFolder(),
        task: requireBoundedFlag("--task", "task-id"),
        jobCommand,
        ...(flags.has("--interactive") ? { interactive: true } : {}),
        ...(flags.has("--service") ? { service: true } : {}),
        ...(Object.keys(textFiles).length ? { textFiles } : {}),
        ...(jobName ? { jobName } : {}),
        ...(jobCwd ? { jobCwd } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    }
    case "jobs list": {
      allowOnlyFlags("--connected-folder", "--conversation", "--running");
      const conversation = optionalBoundedFlag("--conversation", "conversation-id");
      return {
        name: "jobs.list",
        output,
        connectedFolder: requireConnectedFolder(),
        ...(conversation ? { conversation } : {}),
        ...(flags.get("--running") === true ? { running: true } : {}),
      };
    }
    case "jobs show":
      allowOnlyFlags("--connected-folder", "--job");
      return { name: "jobs.show", output, connectedFolder: requireConnectedFolder(), job: requireBoundedFlag("--job", "job-id") };
    case "jobs output": {
      allowOnlyFlags("--connected-folder", "--job", "--offset", "--limit", "--wait", "--until", "--task");
      const rawWait = stringFlag("--wait");
      const waitSeconds = rawWait === undefined ? undefined : Number(rawWait);
      if (waitSeconds !== undefined && (!Number.isFinite(waitSeconds) || waitSeconds < 0)) {
        throw usageError("--wait must be a number of seconds, 0 or more.");
      }

      const offset = optionalInteger("--offset", 1, Number.MAX_SAFE_INTEGER);
      const limit = optionalInteger("--limit", 1, Number.MAX_SAFE_INTEGER);
      const until = optionalBoundedFlag("--until", "pattern", 4_096);
      const task = optionalBoundedFlag("--task", "task-id");
      return {
        name: "jobs.output",
        output,
        connectedFolder: requireConnectedFolder(),
        job: requireBoundedFlag("--job", "job-id"),
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        // A longer wait is capped: a wait that runs out already answers
        // "still running", so the caller simply reads again.
        ...(waitSeconds !== undefined ? { waitSeconds: Math.min(waitSeconds, AMPLEFILE_CLI_JOBS_OUTPUT_MAX_WAIT_SECONDS) } : {}),
        ...(until ? { until } : {}),
        ...(task ? { task } : {}),
      };
    }
    case "worktrees manage": {
      allowOnlyFlags("--connected-folder", "--task", "--action", "--id", "--ref");
      const action = stringFlag("--action");
      if (action !== "create" && action !== "list" && action !== "archive" && action !== "restore") throw usageError("--action must be create, list, archive, or restore.");
      return { name: "worktrees.manage", output, connectedFolder: requireConnectedFolder(), task: requireBoundedFlag("--task", "task-id"), worktreeAction: action, ...(stringFlag("--id") ? { worktreeId: stringFlag("--id")! } : {}), ...(stringFlag("--ref") ? { worktreeRef: stringFlag("--ref")! } : {}) };
    }
    case "jobs input":
      allowOnlyFlags("--connected-folder", "--task", "--job", "--text", "--eof");
      if (stringFlag("--text") === undefined) throw usageError("--text is required (it may be empty).");
      return { name: "jobs.input", output, connectedFolder: requireConnectedFolder(), task: requireBoundedFlag("--task", "task-id"), job: requireBoundedFlag("--job", "job-id"), terminalText: stringFlag("--text")!, ...(flags.has("--eof") ? { eof: true } : {}) };
    case "jobs stop":
      allowOnlyFlags("--connected-folder", "--job", "--parent-task");
      return {
        name: "jobs.stop",
        output,
        connectedFolder: requireConnectedFolder(),
        job: requireBoundedFlag("--job", "job-id"),
        ...(parentTaskId ? { parentTaskId } : {}),
      };
    default:
      throw usageError(`Unknown command: ${command || "(none)"}`);
  }
}

export async function executeAmpleFileCliActRequest(
  request: AmpleFileCliActRequest,
  options: AmpleFileCliActExecutorOptions,
): Promise<AmpleFileCliResponseV1> {
  const completedAt = () => (options.now?.() ?? new Date()).toISOString();
  let command: AmpleFileCliActParsedCommand | undefined;
  let accepted = false;
  let receiptParentTaskId: string | undefined;
  let receiptLineage: { parentTaskId?: string } = {};
  try {
    command = parseAmpleFileCliActArgv(request.argv);
    const authority = options.getActFacade();
    if (!authority || !tokensMatch(authority.token, request.actToken)) {
      await options.receipts.append({
        requestId: request.id,
        command: command.name,
        outcome: "rejected",
        errorCode: "unavailable",
        surface: "cli",
      });
      throw new AmpleFileCliError("unavailable", ampleFileCliActUnavailableMessage);
    }
    if (options.maxQueuedMs !== undefined) {
      const waitedMs = (options.now?.() ?? new Date()).getTime() - Date.parse(request.createdAt);
      if (!(waitedMs <= options.maxQueuedMs)) {
        await options.receipts.append({
          requestId: request.id,
          command: command.name,
          outcome: "rejected",
          errorCode: "timeout",
          surface: "cli",
          detail: "waited too long behind other commands",
        });
        throw new AmpleFileCliError(
          "timeout",
          `AmpleFile was busy with other commands for more than ${Math.round(options.maxQueuedMs / 60_000)} minutes, so this command was not run. Run it again.`,
        );
      }
    }
    command = await resolveActTextFiles(command, request.cwd);
    // The broker's response-file dedup only covers a pending request; the
    // journal's accepted records are the durable at-most-once ledger.
    if (await options.receipts.hasAccepted(request.id)) {
      await options.receipts.append({
        requestId: request.id,
        command: command.name,
        outcome: "rejected",
        errorCode: "conflict",
        surface: "cli",
        detail: "duplicate act request id",
      });
      throw new AmpleFileCliError("conflict", "This act request id was already executed. Submit a new request instead of replaying it.");
    }
    // The accepted record lands before the mutation so a crash can never
    // leave an applied action without a journal trace; an unwritable journal
    // refuses the command entirely.
    const lineageParent = command.parentTaskId
      ? options.resolveLineageParent?.(command.parentTaskId) ?? null
      : null;
    if (command.parentTaskId && !lineageParent) {
      await options.receipts.append({
        requestId: request.id,
        command: command.name,
        outcome: "rejected",
        errorCode: "conflict",
        surface: "cli",
        parentTaskId: command.parentTaskId,
        detail: "inactive AmpleFile Agent parent",
      });
      throw new AmpleFileCliError("conflict", "The AmpleFile Agent request named by --parent-task is no longer active.");
    }
    receiptParentTaskId = lineageParent?.taskId;
    // Lineage on receipts: the AmpleFile Agent parent.
    const lineage = receiptParentTaskId ? { parentTaskId: receiptParentTaskId } : {};
    receiptLineage = lineage;
    const acceptedRecorded = await options.receipts.append({
      requestId: request.id,
      command: command.name,
      outcome: "accepted",
      surface: "cli",
      ...lineage,
      ...(command.connectedFolder ? { detail: `Connected Folder ${command.connectedFolder}` } : {}),
    });
    if (!acceptedRecorded) {
      throw new AmpleFileCliError("failure", "AmpleFile could not record the act receipt, so the command was not run.");
    }
    accepted = true;
    const data = await runActCommand(command, request, authority.facade);
    const outcomeRecorded = await options.receipts.append({
      requestId: request.id,
      command: command.name,
      outcome: "ok",
      surface: "cli",
      ...lineage,
      ...receiptDetails(command.name, data),
    });
    return createAmpleFileCliResponse({
      id: request.id,
      exitCode: AmpleFileCliExitCode.success,
      stdout: command.output === "json"
        ? `${JSON.stringify({ ok: true, command: command.name, data }, null, 2)}\n`
        : humanActOutput(command.name, data),
      stderr: outcomeRecorded ? "" : "AmpleFile: warning: the act outcome receipt could not be recorded.\n",
      result: data,
      completedAt: completedAt(),
    });
  } catch (error) {
    const normalized = normalizeActError(error);
    if (accepted && command) {
      await options.receipts.append({
        requestId: request.id,
        command: command.name,
        outcome: "error",
        errorCode: normalized.code,
        surface: "cli",
        ...receiptLineage,
      });
    }
    const json = command?.output === "json" || request.argv.includes("--json");
    return createAmpleFileCliResponse({
      id: request.id,
      exitCode: normalized.exitCode,
      stdout: "",
      stderr: json
        ? `${JSON.stringify({ ok: false, error: { code: normalized.code, message: terminalText(normalized.message) } }, null, 2)}\n`
        : `${humanActErrorMessage(normalized)}\n`,
      result: { ok: false, error: { code: normalized.code, message: terminalText(normalized.message) } },
      completedAt: completedAt(),
    });
  }
}

/**
 * Reads each `--<field>-file` into its inline field, relative to the directory
 * the command ran in, and applies the same bounds the inline flag would.
 */
async function resolveActTextFiles(
  command: AmpleFileCliActParsedCommand,
  cwd: string,
): Promise<AmpleFileCliActParsedCommand> {
  if (!command.textFiles) return command;
  const resolved: AmpleFileCliActParsedCommand = { ...command };
  delete resolved.textFiles;
  for (const [field, path] of Object.entries(command.textFiles) as Array<[keyof NonNullable<AmpleFileCliActParsedCommand["textFiles"]>, string]>) {
    const flag = `--${field}-file`;
    let text: string;
    try {
      text = await readFile(isAbsolute(path) ? resolve(path) : resolve(cwd, path), "utf8");
    } catch (error) {
      throw new AmpleFileCliError("notFound", `${flag} ${path}: the file could not be read.`, { cause: error });
    }
    if (text.includes("\u0000")) throw new AmpleFileCliError("usage", `${flag} ${path} contains unsupported control characters.`);
    if (field === "instructions") {
      if (text.length > maximumWorkerInstructionsLength) {
        throw new AmpleFileCliError("usage", `${flag} must be at most ${maximumWorkerInstructionsLength} characters.`);
      }
      resolved.instructions = text;
      continue;
    }
    if (field === "command") {
      if (!text.trim()) throw new AmpleFileCliError("usage", `${flag} ${path} is empty.`);
      if (Buffer.byteLength(text, "utf8") > ampleFileBackgroundJobLimits.maxCommandBytes) {
        throw new AmpleFileCliError("usage", `${flag} can be at most ${ampleFileBackgroundJobLimits.maxCommandBytes / 1024} KiB.`);
      }
      resolved.jobCommand = text;
      continue;
    }
    if (!text.trim()) throw new AmpleFileCliError("usage", `${flag} ${path} is empty.`);
    const [limit, maximumBytes] = field === "summary"
      ? ["resultSummary", ampleFileRequestLimits.maxResultSummaryBytes] as const
      : field === "question"
        ? ["questionText", ampleFileRequestLimits.maxQuestionTextBytes] as const
        : ["answerText", ampleFileRequestLimits.maxAnswerTextBytes] as const;
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new AmpleFileCliError("usage", ampleFileRequestLimitMessage(limit, maximumBytes));
    resolved[field] = text;
  }
  return resolved;
}

async function runActCommand(
  command: AmpleFileCliActParsedCommand,
  request: AmpleFileCliActRequest,
  facade: AmpleFileActFacade,
): Promise<AmpleFileCliJson> {
  switch (command.name) {
    case "connected-folders.worker.show":
      return toJson(await facade.workerShow({ connectedFolder: command.connectedFolder! }));
    case "connected-folders.worker.model":
      return toJson(await facade.workerSetModel({
        connectedFolder: command.connectedFolder!,
        provider: command.provider!,
        model: command.model!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "connected-folders.worker.instructions":
      return toJson(await facade.workerSetInstructions({
        connectedFolder: command.connectedFolder!,
        instructions: command.instructions ?? "",
        ...(command.appendInstructions ? { append: true } : {}),
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.create":
      return toJson(await facade.createConversation({ connectedFolder: command.connectedFolder! }));
    case "chat.send": {
      const content = command.messageFromPayload ? request.payload?.messageFile ?? "" : command.message ?? "";
      return toJson(await facade.sendMessage({
        connectedFolder: command.connectedFolder!,
        ...(command.conversation ? { conversationId: command.conversation } : {}),
        ...(command.newConversation ? { newConversation: true } : {}),
        content,
        requestId: request.id,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    }
    case "chat.status":
      return command.task
        ? toJson(await facade.turnStatus({ connectedFolder: command.connectedFolder!, taskId: command.task }))
        : toJson(await facade.conversationStatus({ connectedFolder: command.connectedFolder!, conversationId: command.conversation! }));
    case "chat.result":
      return command.task
        ? toTerminalSafeJson(await facade.turnResult({ connectedFolder: command.connectedFolder!, taskId: command.task }))
        : toJson(await facade.conversationResult({
            connectedFolder: command.connectedFolder!,
            conversationId: command.conversation!,
            ...(command.messages !== undefined ? { messages: command.messages } : {}),
          }));
    case "chat.abort":
      return toJson(await facade.abortTurn({ connectedFolder: command.connectedFolder!, conversationId: command.conversation! }));
    // The collaboration verbs (docs/collaboration-contract.md).
    // Their results carry person content — summaries, questions, answers —
    // so they pass through the same bounding sanitizer as the overview.
    case "chat.report":
      return toTerminalSafeJson(await facade.chatReport({
        connectedFolder: command.connectedFolder!,
        taskId: command.task!,
        summary: command.summary!,
        ...(command.resultData !== undefined ? { data: command.resultData } : {}),
        ...(command.resultDataPath ? { dataPath: command.resultDataPath, cwd: request.cwd } : {}),
        files: command.files ?? [],
        outcome: command.outcome ?? "succeeded",
        requestId: request.id,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "agent.ask":
      return toTerminalSafeJson(await facade.agentAsk({
        taskId: command.task!,
        question: command.question!,
        ...(command.options?.length ? { options: command.options } : {}),
        ...(command.asynchronous ? { asynchronous: true } : {}),
        requestId: request.id,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "agent.answer":
      return toTerminalSafeJson(await facade.agentAnswer({
        questionId: command.questionId!,
        answer: command.answer!,
        requestId: request.id,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.children":
      return toTerminalSafeJson(await facade.chatChildren({ connectedFolder: command.connectedFolder!, taskId: command.task! }));
    case "chat.ask":
      return toTerminalSafeJson(await facade.chatAsk({
        connectedFolder: command.connectedFolder!,
        taskId: command.task!,
        question: command.question!,
        respondent: command.respondent ?? "person",
        ...(command.options?.length ? { options: command.options } : {}),
        ...(command.asynchronous ? { asynchronous: true } : {}),
        requestId: request.id,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.answer":
      return toTerminalSafeJson(await facade.chatAnswer({
        connectedFolder: command.connectedFolder!,
        questionId: command.questionId!,
        answer: command.answer!,
        requestId: request.id,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.handoff": {
      const content = command.messageFromPayload ? request.payload?.messageFile ?? "" : command.message ?? "";
      return toTerminalSafeJson(await facade.chatHandoff({
        connectedFolder: command.connectedFolder!,
        taskId: command.task!,
        toConnectedFolder: command.toConnectedFolder!,
        ...(command.toConversation ? { toConversationId: command.toConversation } : {}),
        message: content,
        files: command.files ?? [],
        requestId: request.id,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    }
    case "chat.steer": {
      const content = command.messageFromPayload ? request.payload?.messageFile ?? "" : command.message ?? "";
      return toTerminalSafeJson(await facade.chatSteer({
        connectedFolder: command.connectedFolder!,
        conversationId: command.conversation!,
        message: content,
        ...(command.task ? { taskId: command.task } : {}),
        requestId: request.id,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    }
    case "chat.copy": {
      const content = command.messageFromPayload ? request.payload?.messageFile ?? "" : command.message;
      return toTerminalSafeJson(await facade.chatCopy({
        connectedFolder: command.connectedFolder!,
        conversationId: command.conversation!,
        ...(content !== undefined ? { message: content } : {}),
        ...(command.title ? { title: command.title } : {}),
        ...(command.task ? { taskId: command.task } : {}),
        requestId: request.id,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    }
    case "requests.list":
      return toTerminalSafeJson(await facade.requestsList({ cwd: request.cwd }));
    case "requests.show":
      return toTerminalSafeJson(await facade.requestsShow({ request: command.request!, cwd: request.cwd }));
    // Background jobs carry commands and output text: the content sanitizer applies.
    case "jobs.start":
      return toTerminalSafeJson(await facade.jobsStart({
        connectedFolder: command.connectedFolder!,
        taskId: command.task!,
        command: command.jobCommand ?? "",
        ...(command.interactive ? { interactive: true } : {}),
        ...(command.service ? { service: true } : {}),
        ...(command.jobName ? { name: command.jobName } : {}),
        ...(command.jobCwd ? { cwd: command.jobCwd } : {}),
        ...(command.timeoutSeconds !== undefined ? { timeoutSeconds: command.timeoutSeconds } : {}),
        requestId: request.id,
      }));
    case "jobs.list":
      return toTerminalSafeJson(await facade.jobsList({
        connectedFolder: command.connectedFolder!,
        ...(command.conversation ? { conversationId: command.conversation } : {}),
        ...(command.running ? { running: true } : {}),
      }));
    case "jobs.show":
      return toTerminalSafeJson(await facade.jobsShow({ connectedFolder: command.connectedFolder!, jobId: command.job! }));
    case "jobs.output":
      return toTerminalSafeJson(await facade.jobsOutput({
        connectedFolder: command.connectedFolder!,
        jobId: command.job!,
        ...(command.offset !== undefined ? { offset: command.offset } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.waitSeconds !== undefined ? { waitSeconds: command.waitSeconds } : {}),
        ...(command.until ? { until: command.until } : {}),
        ...(command.task ? { taskId: command.task } : {}),
      }));
    case "worktrees.manage":
      return toTerminalSafeJson(await facade.worktreesManage({ connectedFolder: command.connectedFolder!, taskId: command.task!, action: command.worktreeAction!, ...(command.worktreeId ? { id: command.worktreeId } : {}), ...(command.worktreeRef ? { ref: command.worktreeRef } : {}) }));
    case "jobs.input":
      return toTerminalSafeJson(await facade.jobsInput({ connectedFolder: command.connectedFolder!, taskId: command.task!, jobId: command.job!, text: command.terminalText!, ...(command.eof ? { eof: true } : {}) }));
    case "jobs.stop":
      return toTerminalSafeJson(await facade.jobsStop({
        connectedFolder: command.connectedFolder!,
        jobId: command.job!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "chats.list":
      return toJson(await facade.listConversations({ connectedFolder: command.connectedFolder! }));
    case "agent.send": {
      const content = command.messageFromPayload ? request.payload?.messageFile ?? "" : command.message ?? "";
      return toJson(await facade.agentSend({
        ...(command.conversation ? { conversationId: command.conversation } : {}),
        ...(command.newConversation ? { newConversation: true } : {}),
        content,
        requestId: request.id,
        ...(command.attachments?.length ? { attachments: command.attachments, cwd: request.cwd } : {}),
      }));
    }
    case "agent.stop":
      return toJson(await facade.agentStop({ taskId: command.task! }));
    case "agent.status":
      return command.task
        ? toJson(await facade.agentTurnStatus({ taskId: command.task }))
        : toJson(await facade.agentConversationStatus({
            ...(command.conversation ? { conversationId: command.conversation } : {}),
          }));
    case "agent.result":
      return command.task
        ? toTerminalSafeJson(await facade.agentTurnResult({ taskId: command.task }))
        : toJson(await facade.agentConversationResult({
            ...(command.conversation ? { conversationId: command.conversation } : {}),
            ...(command.messages !== undefined ? { messages: command.messages } : {}),
          }));
    case "agent.abort":
      return toJson(await facade.agentAbort({
        ...(command.conversation ? { conversationId: command.conversation } : {}),
      }));
    case "agent.list":
      return toJson(await facade.agentList());
    case "agent.overview":
      // The overview headlines carry person content (chat titles, labels), so
      // the snapshot passes through the terminal-safe sanitizer before it
      // reaches a terminal.
      return toTerminalSafeJson(await facade.agentOverview());
    case "connected-folders.create":
      return toJson(await facade.createConnectedFolder({
        name: command.connectedFolderName!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "connected-folders.register":
      return toJson(await facade.registerConnectedFolder({
        connectedFolderRoot: command.registerPath!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.add":
      return toJson(await facade.addFiles({
        connectedFolder: command.connectedFolder!,
        fromPaths: command.fromPaths ?? [],
        ...(command.toDir !== undefined ? { toDir: command.toDir } : {}),
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.rename":
      return toJson(await facade.chatRename({
        connectedFolder: command.connectedFolder!,
        conversationId: command.conversation!,
        title: command.title!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.snooze":
      return toJson(await facade.chatSnooze({
        connectedFolder: command.connectedFolder!,
        conversationId: command.conversation!,
        until: command.until!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.archive":
      return toJson(await facade.chatArchive({
        connectedFolder: command.connectedFolder!,
        conversationId: command.conversation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.resume":
      return toJson(await facade.chatResume({
        connectedFolder: command.connectedFolder!,
        conversationId: command.conversation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "chat.compact":
      return toJson(await facade.chatCompact({
        connectedFolder: command.connectedFolder!,
        conversationId: command.conversation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "history.list":
      return toJson(await facade.historyList({ connectedFolder: command.connectedFolder!, ...(command.cursor ? { cursor: command.cursor } : {}), ...(command.limit ? { limit: command.limit } : {}) }));
    case "history.save":
      return toJson(await facade.historySave({
        connectedFolder: command.connectedFolder!,
        ...(command.label !== undefined ? { label: command.label } : {}),
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "history.restore":
      return toJson(await facade.historyRestore({
        connectedFolder: command.connectedFolder!,
        checkpointId: command.checkpoint!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "history.versions":
      return toJson(await facade.historyVersions({ connectedFolder: command.connectedFolder!, path: command.path!, ...(command.cursor ? { cursor: command.cursor } : {}), ...(command.limit ? { limit: command.limit } : {}) }));
    case "history.read":
      return toJson(await facade.historyRead({ connectedFolder: command.connectedFolder!, path: command.path!, checkpointId: command.checkpoint!, ...(command.offsetBytes !== undefined ? { offsetBytes: command.offsetBytes } : {}), ...(command.lengthBytes !== undefined ? { lengthBytes: command.lengthBytes } : {}), ...(command.expectedSha256 ? { expectedSha256: command.expectedSha256 } : {}) }));
    case "history.diff":
      return toJson(await facade.historyDiff({
        connectedFolder: command.connectedFolder!, path: command.path!, fromCheckpointId: command.fromCheckpoint!,
        ...(command.toCheckpoint ? { toCheckpointId: command.toCheckpoint } : {}),
      }));
    case "history.restore-file":
      return toJson(await facade.historyRestoreFile({
        connectedFolder: command.connectedFolder!,
        path: command.path!,
        version: command.version!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.move":
      return toJson(await facade.filesMove({
        connectedFolder: command.connectedFolder!,
        fromPath: command.fromPaths![0]!,
        toDir: command.toDir!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.rename":
      return toJson(await facade.filesRename({
        connectedFolder: command.connectedFolder!,
        path: command.path!,
        newName: command.entryName!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.delete":
      return toJson(await facade.filesDelete({
        connectedFolder: command.connectedFolder!,
        path: command.path!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.mkdir":
      return toJson(await facade.filesMkdir({
        connectedFolder: command.connectedFolder!,
        path: command.path!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "files.create":
      return toJson(await facade.filesCreate({
        connectedFolder: command.connectedFolder!,
        path: command.path!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "search":
      return toJson(await facade.search({
        connectedFolder: command.connectedFolder!,
        query: command.query!,
        ...(command.path ? { path: command.path } : {}), ...(command.cursor ? { cursor: command.cursor } : {}), ...(command.limit ? { limit: command.limit } : {}),
        ...(command.searchScope ? { scope: command.searchScope } : {}),
      }));
    case "connected-folders.rename":
      return toJson(await facade.connectedFoldersRename({
        connectedFolder: command.connectedFolder!,
        name: command.connectedFolderName!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "connected-folders.unregister":
      return toJson(await facade.connectedFoldersUnregister({
        connectedFolder: command.connectedFolder!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "connected-folders.appearance.apply":
      return toJson(await facade.connectedFoldersAppearanceApply({
        connectedFolder: command.connectedFolder!,
        ...(command.proposalPath ? { proposalPath: command.proposalPath } : { parts: command.appearanceParts! }),
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "connected-folders.appearance.reset":
      return toJson(await facade.connectedFoldersAppearanceReset({
        connectedFolder: command.connectedFolder!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "connected-folders.appearance.undo":
      return toJson(await facade.connectedFoldersAppearanceUndo({
        connectedFolder: command.connectedFolder!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "tools.remove":
      return toJson(await facade.toolsRemove({
        scope: command.toolsScope!,
        ...(command.connectedFolder ? { connectedFolder: command.connectedFolder } : {}),
        source: command.source!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    // The verbs that install code, widen a power, or destroy data
    // (docs/act-ledger.md): each runs at
    // once through the prepared-act path and returns its effect. Results
    // pass the bounding sanitizer because they carry person content (paths,
    // titles, names). `request.id` is the journaled identity the act runs
    // under.
    case "connected-folders.delete":
      return toTerminalSafeJson(await facade.connectedFoldersDelete({
        connectedFolder: command.connectedFolder!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "tools.import-skill":
      return toTerminalSafeJson(await facade.toolsImportSkill({
        scope: command.toolsScope!,
        ...(command.connectedFolder ? { connectedFolder: command.connectedFolder } : {}),
        from: command.fromPaths![0]!,
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "tools.install":
      return toTerminalSafeJson(await facade.toolsInstall({
        scope: command.toolsScope!,
        ...(command.connectedFolder ? { connectedFolder: command.connectedFolder } : {}),
        ...(command.catalogId !== undefined ? { catalogId: command.catalogId } : {}),
        ...(command.source !== undefined ? { source: command.source } : {}),
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "tools.enable":
    case "tools.disable":
      return toTerminalSafeJson(await facade.toolsSetEnabled({
        scope: command.toolsScope!, ...(command.connectedFolder ? { connectedFolder: command.connectedFolder } : {}),
        path: command.path!, kind: command.resourceKind!, enabled: command.name === "tools.enable",
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}), requestId: request.id,
      }));
    case "tools.update":
      return toTerminalSafeJson(await facade.toolsUpdate({
        scope: command.toolsScope!,
        ...(command.connectedFolder ? { connectedFolder: command.connectedFolder } : {}),
        source: command.source!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "automations.enable":
      return toTerminalSafeJson(await facade.automationsEnable({
        proposalPath: command.proposalPath!,
        cwd: request.cwd,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    // Automation management verbs (docs/automations.md): above Connected Folders, all
    // content-bearing results pass the bounding sanitizer. Run-now carries the
    // act request id into the run's own journal as its trigger cause.
    case "recently-deleted.list":
      return toTerminalSafeJson(await facade.recentlyDeletedList());
    case "recently-deleted.restore":
      return toTerminalSafeJson(await facade.recentlyDeletedRestore({
        entry: command.entry!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "automations.list":
      return toTerminalSafeJson(await facade.automationsList());
    case "automations.models":
      return toTerminalSafeJson(await facade.automationsModels());
    case "automations.show":
      return toTerminalSafeJson(await facade.automationsShow({ automation: command.automation! }));
    case "automations.run":
      return toTerminalSafeJson(await facade.automationsRun({
        automation: command.automation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
        requestId: request.id,
      }));
    case "automations.stop":
      return toTerminalSafeJson(await facade.automationsStop({
        automation: command.automation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "automations.disable":
      return toTerminalSafeJson(await facade.automationsDisable({
        automation: command.automation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "automations.delete":
      return toTerminalSafeJson(await facade.automationsDelete({
        automation: command.automation!,
        ...(command.parentTaskId ? { parentTaskId: command.parentTaskId } : {}),
      }));
    case "automations.receipts":
      return toTerminalSafeJson(await facade.automationsReceipts({
        ...(command.automation ? { automation: command.automation } : {}),
      }));
  }
}

/**
 * The facade is trusted application code, but its values can contain file and
 * model content. Scrub terminal controls at this final adapter boundary so
 * both JSON and human projections are safe. Content is never shortened: the
 * agent reading a result gets all of it. The depth guard only stops a cyclic
 * or pathological structure from recursing without end.
 */
function toTerminalSafeJson(value: unknown, depth = 0): AmpleFileCliJson {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return terminalText(value);
  if (depth >= 256) return "[nested output omitted]";
  if (Array.isArray(value)) return value.map((item) => toTerminalSafeJson(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, AmpleFileCliJson> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      output[terminalText(key)] = toTerminalSafeJson(item, depth + 1);
    }
    return output;
  }
  return terminalText(value);
}

const agentRenderAliases: Partial<Record<AmpleFileCliActCommandName, AmpleFileCliActCommandName>> = {
  "agent.send": "chat.send",
  "agent.status": "chat.status",
  "agent.result": "chat.result",
  "agent.abort": "chat.abort",
  "agent.list": "chats.list",
};

function humanActOutput(name: AmpleFileCliActCommandName, data: AmpleFileCliJson): string {
  const record = data as Record<string, AmpleFileCliJson> & {
    connectedFolder?: { id?: string; name?: string; connectedFolderRoot?: string };
    conversation?: AmpleFileActConversationRef;
    conversations?: AmpleFileActConversationRef[];
    messages?: AmpleFileActChatMessage[];
    task?: { taskId?: string };
  };
  const connectedFolderLabel = record.connectedFolder ? `${terminalText(record.connectedFolder.name)} [${terminalText(record.connectedFolder.id)}]` : "";
  switch (agentRenderAliases[name] ?? name) {
    case "chat.create":
      return `Created Chat ${terminalText(record.conversation?.id)} in ${connectedFolderLabel}.\n`;
    case "chat.send":
      return `Accepted. Conversation ${terminalText(record.conversationId)}, task ${terminalText(record.taskId)}.\n`;
    case "chat.status": {
      const task = record.task as { taskId?: string; state?: string; conversationId?: string | null; error?: string | null } | undefined;
      if (task) {
        const error = typeof task.error === "string" && task.error ? `\n${terminalText(task.error)}` : "";
        const conversation = task.conversationId ? ` — Chat ${terminalText(task.conversationId)}` : "";
        // `agent status --task` carries the AmpleFile Agent projection (a phase
        // and delegated children); `chat status --task` carries the request
        // graph ref (a state and counts). Both render, each in its own shape.
        const request = record.request as {
          phase?: string;
          children?: Array<{ taskId?: string; connectedFolderName?: string; state?: string }> | number;
          id?: string;
          state?: string;
          openQuestions?: number;
        } | null | undefined;
        const requestLines = request && typeof request.phase === "string"
          ? [
              `Request phase: ${terminalText(request.phase)}`,
              ...(Array.isArray(request.children) ? request.children : []).map((child) =>
                `- delegated task ${terminalText(child.taskId)} in ${terminalText(child.connectedFolderName)} — ${terminalText(child.state)}`),
            ].join("\n")
          : request && typeof request.state === "string"
            ? `Request ${terminalText(request.id)} — ${terminalText(request.state)}, ${terminalText(request.children ?? 0)} handed out, ${terminalText(request.openQuestions ?? 0)} waiting`
            : "";
        // A task waiting on an answer says so first, and says how to
        // answer it. The turn state below stays exactly what it is.
        const waiting = record.waiting as {
          questionId?: string; respondent?: string; question?: string; askedAt?: string; expiresAt?: string | null;
        } | null | undefined;
        const waitingLines = waiting
          ? [
              `Task ${terminalText(task.taskId)} — waiting on ${waiting.respondent === "parent" ? "the request above it" : "you"} since ${terminalText(waiting.askedAt)}${waiting.expiresAt ? ` (until ${terminalText(waiting.expiresAt)})` : ""}`,
              `Question ${terminalText(waiting.questionId)}: ${clampLine(waiting.question)}`,
              ...(record.connectedFolder && typeof record.connectedFolder.id === "string"
                ? [`Answer it with: amplefile chat answer --connected-folder ${terminalText(record.connectedFolder.id)} --question ${terminalText(waiting.questionId)} --answer "<text>" --json`]
                : [`Answer it with: amplefile agent answer --question ${terminalText(waiting.questionId)} --answer "<text>" --json`]),
              "",
            ].join("\n")
          : "";
        return `${waitingLines}Task ${terminalText(task.taskId)} — ${terminalText(task.state)}${conversation}${error}${requestLines ? `\n${requestLines}` : ""}\n`;
      }
      const conversation = record.conversation;
      const lifecycle = conversation?.archivedAt ? " (archived)" : conversation?.snoozedUntil ? " (snoozed)" : "";
      return `Chat ${terminalText(conversation?.title)} [${terminalText(conversation?.id)}] — ${terminalText(record.state)}${lifecycle}\n`;
    }
    case "chat.result": {
      const task = record.task as { taskId?: string; state?: string } | undefined;
      const message = record.message as unknown as AmpleFileActChatMessage | undefined;
      if (task && message) {
        return `${terminalText(message.content)}\n\n[${terminalText(task.state)}] task ${terminalText(task.taskId)} in ${terminalText(record.conversationId)}\n`;
      }
      const last = typeof record.lastAssistant === "string" && record.lastAssistant.trim()
        ? terminalText(record.lastAssistant)
        : "(no assistant reply yet)";
      return `${last}\n\n[${terminalText(record.state)}] ${terminalText(record.total)} message${record.total === 1 ? "" : "s"} in ${terminalText(record.conversationId)}\n`;
    }
    case "chat.abort":
      return record.aborted ? "Aborted the active turn.\n" : "No active turn to abort.\n";
    case "chat.report": {
      const result = record.result as { outcome?: string; files?: Array<{ path?: string }> } | undefined;
      const request = record.request as { id?: string; state?: string } | undefined;
      const files = result?.files ?? [];
      const fileLine = files.length
        ? `\n${files.length} file${files.length === 1 ? "" : "s"}: ${files.map((file) => terminalText(file.path)).join(", ")}`
        : "";
      return `Reported ${terminalText(result?.outcome)} on task ${terminalText(record.taskId)} in ${connectedFolderLabel}.${fileLine}\nRequest ${terminalText(request?.id)} — ${terminalText(request?.state)}.\n`;
    }
    case "agent.ask":
    case "chat.ask": {
      const question = record.question as { questionId?: string; respondent?: string; expiresAt?: string | null } | undefined;
      const to = record.redirectedToPerson
        ? "you (this request has nothing above it, so the question came to you instead)"
        : question?.respondent === "parent" ? "the request above this one" : "you";
      return `Asked ${to}. Question ${terminalText(question?.questionId)}${question?.expiresAt ? `, open until ${terminalText(question.expiresAt)}` : ""}.\nTask ${terminalText(record.taskId)} is waiting.\n`;
    }
    case "agent.answer":
    case "chat.answer": {
      const question = record.question as { questionId?: string } | undefined;
      const continuation = record.continuation as { taskId?: string; conversationId?: string } | undefined;
      return `Answer recorded for question ${terminalText(question?.questionId)}.\nContinuing in Chat ${terminalText(continuation?.conversationId)} as task ${terminalText(continuation?.taskId)}.\n`;
    }
    case "chat.handoff": {
      const destination = record.toConnectedFolder as { id?: string; name?: string } | undefined;
      const copied = (Array.isArray(record.copied) ? record.copied : []) as unknown[];
      const copiedLine = copied.length
        ? `\nCopied ${copied.length} item${copied.length === 1 ? "" : "s"}: ${copied.map(terminalText).join(", ")}${record.checkpointId ? ` (restore point ${terminalText(record.checkpointId)})` : ""}`
        : "";
      const verb = record.followUp === true ? "Followed up with" : "Handed off to";
      return `${verb} ${terminalText(destination?.name)} [${terminalText(destination?.id)}]. Chat ${terminalText(record.conversationId)}, task ${terminalText(record.taskId)}.${copiedLine}\n`;
    }
    case "chat.steer":
      return `${record.replayed === true ? "Already delivered" : "Delivered"} to Chat ${terminalText(record.conversationId)}; it reaches running task ${terminalText(record.taskId)} after its current step.\n`;
    case "chat.copy": {
      const conversation = record.conversation as { id?: string; title?: string } | undefined;
      const started = typeof record.taskId === "string" ? ` Started task ${terminalText(record.taskId)} in it.` : "";
      return `Copied Chat ${terminalText(record.copiedFromConversationId)} (${terminalText(record.copiedMessages)} messages) into "${terminalText(conversation?.title)}" [${terminalText(conversation?.id)}].${started}\n`;
    }
    case "requests.list": {
      const requests = (Array.isArray(record.requests) ? record.requests : []) as Array<{
        id?: string; kind?: string; state?: string; connectedFolderName?: string | null; children?: number; openQuestions?: number; createdAt?: string;
      }>;
      if (!requests.length) return "No requests on record.\n";
      const lines = requests.map((request) =>
        `${terminalText(request.id)}  ${terminalText(request.kind)}  ${terminalText(request.state)}  ${request.connectedFolderName ? `${terminalText(request.connectedFolderName)}  ` : ""}${terminalText(request.children ?? 0)} handed out, ${terminalText(request.openQuestions ?? 0)} waiting  (${terminalText(request.createdAt)})`);
      return `${lines.join("\n")}${record.truncated ? "\n(more omitted)" : ""}\n`;
    }
    case "requests.show":
      return `${renderRequestDetail(record.request as Record<string, AmpleFileCliJson>, 0).join("\n")}\n`;
    case "jobs.start":
    case "jobs.show":
    case "jobs.stop": {
      const job = (record.job ?? {}) as Record<string, AmpleFileCliJson>;
      const verb = name === "jobs.start" ? "Started" : name === "jobs.stop" ? "Stopped" : "Background job";
      return `${verb} ${terminalText(job.jobId)} "${terminalText(job.name)}" in ${connectedFolderLabel}: ${terminalText(job.status)}.\n`;
    }
    case "jobs.list": {
      const jobs = Array.isArray(record.jobs) ? record.jobs as Array<Record<string, AmpleFileCliJson>> : [];
      if (!jobs.length) return `No background jobs in ${connectedFolderLabel}.\n`;
      return `${jobs.map((job) => `${terminalText(job.jobId)}  ${terminalText(job.name)} — ${terminalText(job.status)}`).join("\n")}\n`;
    }
    case "jobs.output": {
      const job = (record.job ?? {}) as Record<string, AmpleFileCliJson>;
      const output = (record.output ?? {}) as Record<string, AmpleFileCliJson>;
      const header = `${terminalText(job.jobId)} "${terminalText(job.name)}": ${terminalText(job.status)}. `
        + (output.totalLines ? `Lines ${terminalText(output.fromLine)}–${terminalText(output.toLine)} of ${terminalText(output.totalLines)}; next offset ${terminalText(output.nextOffset)}.` : "No output yet.");
      return `${header}\n${typeof output.text === "string" && output.text ? `${output.text}\n` : ""}`;
    }
    case "agent.overview": {
      const snapshot = data as {
        composedAt?: string;
        running?: Array<{ headline?: string; connectedFolderName?: string }>;
        needsYou?: Array<{ headline?: string; connectedFolderName?: string }>;
        changes?: Array<{ headline?: string; connectedFolderName?: string }>;
        truncated?: { running?: boolean; needsYou?: boolean; changes?: boolean };
        unavailable?: string[];
      };
      const item = (entry: { headline?: string; connectedFolderName?: string }): string =>
        `- ${terminalText(entry.headline)}${entry.connectedFolderName ? ` (${terminalText(entry.connectedFolderName)})` : ""}`;
      const section = (label: string, entries: Array<{ headline?: string; connectedFolderName?: string }> | undefined, truncated: boolean | undefined, quiet: string): string[] => {
        const list = entries ?? [];
        if (!list.length) return [`${label}: ${quiet}`];
        return [
          `${label}${truncated ? " (more omitted)" : ""}:`,
          ...list.map(item),
        ];
      };
      const lines = [
        `The overview at ${terminalText(snapshot.composedAt)}`,
        ...section("Running", snapshot.running, snapshot.truncated?.running, "nothing running"),
        ...section("Needs you", snapshot.needsYou, snapshot.truncated?.needsYou, "nothing waiting on you"),
        ...section("Since you last looked", snapshot.changes, snapshot.truncated?.changes, "no recorded changes"),
      ];
      const unavailable = snapshot.unavailable ?? [];
      if (unavailable.length) {
        lines.push(`Unavailable sources this composition: ${unavailable.map(terminalText).join(", ")}.`);
      }
      return `${lines.join("\n")}\n`;
    }
    case "agent.stop": {
      const children = (Array.isArray(record.children) ? record.children : []) as Array<{ taskId?: string; connectedFolderId?: string; aborted?: boolean }>;
      const ampleFileAgentLine = record.ampleFileAgentAborted
        ? "Stopped the AmpleFile Agent turn."
        : "The AmpleFile Agent turn was not running.";
      if (!children.length) return `${ampleFileAgentLine}\nNo delegated Connected Folder turns were running.\n`;
      const childLines = children.map((child) =>
        `- ${child.aborted ? "Stopped" : "Could not stop"} task ${terminalText(child.taskId)} in Connected Folder ${terminalText(child.connectedFolderId)}`);
      return `${ampleFileAgentLine}\n${childLines.join("\n")}\n`;
    }
    case "chats.list": {
      const conversations = record.conversations ?? [];
      if (!conversations.length) return "No Chats found.\n";
      return `${conversations.map((item) => {
        const lifecycle = item.archivedAt ? " (archived)" : item.snoozedUntil ? " (snoozed)" : "";
        return `- ${terminalText(item.title)} [${terminalText(item.id)}]${lifecycle}`;
      }).join("\n")}\n`;
    }
    case "connected-folders.create":
    case "connected-folders.register":
      return `Connected Folder ${connectedFolderLabel} — ${terminalText(record.connectedFolder?.connectedFolderRoot)}\n`;
    case "connected-folders.worker.show": {
      const model = record.model as { provider?: unknown; id?: unknown } | null | undefined;
      const availableModels = Array.isArray(record.availableModels)
        ? record.availableModels as Array<{ provider?: unknown; id?: unknown; name?: unknown }>
        : [];
      const instructions = typeof record.instructions === "string" && record.instructions
        ? record.instructions
        : "(none)";
      const choices = availableModels.length
        ? availableModels.map((item) => `- ${terminalText(item.name)} (${terminalText(item.provider)}/${terminalText(item.id)})`).join("\n")
        : "(none connected)";
      return `${connectedFolderLabel}\nDefault model for new Chats: ${model ? `${terminalText(model.provider)}/${terminalText(model.id)}` : "not selected"}\nAvailable connected models:\n${choices}\nWorker Instructions:\n${terminalText(instructions)}\n`;
    }
    case "connected-folders.worker.model": {
      const model = record.model as { provider?: unknown; id?: unknown } | null | undefined;
      return `Saved ${terminalText(model?.provider)}/${terminalText(model?.id)} as the default for new Chats in ${connectedFolderLabel}.\n`;
    }
    case "connected-folders.worker.instructions":
      return typeof record.instructions === "string" && record.instructions
        ? `Saved Worker Instructions for ${connectedFolderLabel}.\n`
        : `Cleared Worker Instructions for ${connectedFolderLabel}.\n`;
    case "files.add": {
      const copied = Array.isArray(record.copied) ? record.copied : [];
      const lines = copied.map((path) => `- ${terminalText(path)}`);
      const checkpoint = record.checkpointId ? `Restore point: ${terminalText(record.checkpointId)}\n` : "";
      return `Added ${copied.length} item${copied.length === 1 ? "" : "s"} to ${connectedFolderLabel}:\n${lines.join("\n")}\n${checkpoint}`;
    }
    case "chat.rename": {
      const conversation = record.conversation;
      return `Renamed Chat [${terminalText(conversation?.id)}] to "${terminalText(conversation?.title)}" in ${connectedFolderLabel} (was "${terminalText(record.priorTitle)}").\n`;
    }
    case "chat.snooze": {
      const conversation = record.conversation;
      return `Snoozed Chat "${terminalText(conversation?.title)}" [${terminalText(conversation?.id)}] until ${terminalText(conversation?.snoozedUntil)} in ${connectedFolderLabel}. Resume it with 'chat resume'.\n`;
    }
    case "chat.archive": {
      const conversation = record.conversation;
      return `Archived Chat "${terminalText(conversation?.title)}" [${terminalText(conversation?.id)}] in ${connectedFolderLabel}. Restore it with 'chat resume'.\n`;
    }
    case "chat.resume": {
      const conversation = record.conversation;
      const prior = record.priorLifecycle as Partial<AmpleFileActChatLifecycleState> | undefined;
      const was = prior?.archivedAt
        ? " (was archived)"
        : prior?.snoozedUntil ? ` (was snoozed until ${terminalText(prior.snoozedUntil)})` : "";
      return `Resumed Chat "${terminalText(conversation?.title)}" [${terminalText(conversation?.id)}] in ${connectedFolderLabel}${was}.\n`;
    }
    case "chat.compact":
      return `Compacted Chat [${terminalText(record.conversationId)}] in ${connectedFolderLabel} (task ${terminalText(record.taskId)}). `
        + `Compaction is additive summarization; nothing was deleted.\n`;
    case "history.list": {
      const continuation = record.nextCursor ? `Continue with --cursor ${terminalText(record.nextCursor)}\n` : "";
      const checkpoints = (Array.isArray(record.checkpoints) ? record.checkpoints : []) as Array<Partial<AmpleFileActCheckpointSummary>>;
      if (!checkpoints.length) return `No restore points saved in ${connectedFolderLabel}.\n`;
      const lines = checkpoints.map((checkpoint) =>
        `- ${terminalText(checkpoint.checkpointId)} — ${terminalText(checkpoint.createdAt)} — ${terminalText(checkpoint.label ?? checkpoint.reason)} (${terminalText(checkpoint.fileCount)} file${checkpoint.fileCount === 1 ? "" : "s"})`);
      return `${checkpoints.length} restore point${checkpoints.length === 1 ? "" : "s"} in ${connectedFolderLabel}${typeof record.total === "number" ? ` (${record.total} total)` : ""}:\n${lines.join("\n")}\n${continuation}`;
    }
    case "history.save": {
      const checkpoint = record.checkpoint as Partial<AmpleFileActCheckpointSummary> | undefined;
      if (record.created === false) {
        return `${connectedFolderLabel} already matches restore point ${terminalText(checkpoint?.checkpointId)}; no new restore point was created.\n`;
      }
      return `Saved restore point ${terminalText(checkpoint?.checkpointId)} (${terminalText(checkpoint?.fileCount)} file${checkpoint?.fileCount === 1 ? "" : "s"}) in ${connectedFolderLabel}.\n`;
    }
    case "history.restore": {
      const skipped = typeof record.skippedLargeFileCount === "number" && record.skippedLargeFileCount > 0
        ? `\nHistory skipped ${terminalText(record.skippedLargeFileCount)} oversized file${record.skippedLargeFileCount === 1 ? "" : "s"} recorded by that restore point.`
        : "";
      return `Restored ${connectedFolderLabel} to restore point ${terminalText(record.checkpointId)}.\n${terminalText(record.restoredFileCount)} file(s) restored; ${terminalText(record.deletedFileCount)} deleted; ${terminalText(record.movedEntryCount)} moved back; ${terminalText(record.unchangedFileCount)} unchanged.${skipped}\nSafety restore point: ${terminalText(record.safetyCheckpointId)}\n`;
    }
    case "history.versions": {
      const continuation = record.nextCursor ? `Continue with --cursor ${terminalText(record.nextCursor)}\n` : "";
      const versions = (Array.isArray(record.versions) ? record.versions : []) as Array<Partial<AmpleFileActFileVersionRef>>;
      if (!versions.length) return `No saved versions of ${terminalText(record.path)} in ${connectedFolderLabel}.\n`;
      const lines = versions.map((version) =>
        `- ${terminalText(version.hashSha256)} — captured ${terminalText(version.capturedAt)} (${terminalText(version.sizeBytes)} bytes)`);
      return `${versions.length} saved version${versions.length === 1 ? "" : "s"} of ${terminalText(record.path)} in ${connectedFolderLabel}${typeof record.total === "number" ? ` (${record.total} total)` : ""}:\n${lines.join("\n")}\n${continuation}`;
    }
    case "history.read": {
      const review = record.review as unknown as HistoryFileRead | undefined;
      const observation = review?.observation;
      if (review?.range) {
        const range = review.range;
        return `${terminalText(review.path)} — ${terminalText(range.status)}; bytes ${range.offsetBytes}–${range.offsetBytes + range.lengthBytes} of ${range.totalBytes}; hash verified: ${range.hashVerified}\n`
          + (range.text !== undefined ? `${terminalText(range.text)}\n` : `${terminalText(range.reason)}\n`)
          + (range.nextOffsetBytes !== null ? `Continue with --offset-bytes ${range.nextOffsetBytes} --expected-sha256 ${range.hashSha256}\n` : "");
      }
      return `${terminalText(review?.path)} — ${terminalText(observation?.status)} (${terminalText(observation?.checkpointId)})\n`
        + (typeof observation?.text === "string" ? `${terminalText(observation.text)}\n` : `${terminalText(observation?.reason ?? "No text available.")}\n`);
    }
    case "history.diff": {
      const comparison = record.comparison as unknown as HistoryFileComparison | undefined;
      const diff = comparison?.diff;
      const side = (label: string, value: HistoryFileComparison["before"] | undefined) =>
        `${label}: ${terminalText(value?.checkpointId ?? value?.observedAt ?? value?.source)} — ${terminalText(value?.status)}${value?.reason ? ` (${terminalText(value.reason)})` : ""}\n`;
      return `${terminalText(comparison?.path)} — ${terminalText(comparison?.change)}\n`
        + side("Before", comparison?.before) + side("After", comparison?.after)
        + (diff?.truncated ? "Incomplete text difference: output is limited; do not treat it as complete.\n" : "")
        + (diff?.reason ? `Comparison limit: ${terminalText(diff.reason)}\n` : "")
        + (typeof diff?.text === "string" ? `${terminalText(diff.text)}\n` : `${terminalText(diff?.status)}\n`);
    }
    case "history.restore-file":
      return `Restored ${terminalText(record.path)} to version ${terminalText(record.hashSha256)} in ${connectedFolderLabel}.\nSafety restore point: ${terminalText(record.safetyCheckpointId)}\n`;
    case "files.move":
      return `Moved ${terminalText(record.fromPath)} to ${terminalText(record.path)} in ${connectedFolderLabel}.\nSafety restore point: ${terminalText(record.safetyCheckpointId)}\n`;
    case "files.rename":
      return `Renamed ${terminalText(record.fromPath)} to ${terminalText(record.path)} in ${connectedFolderLabel}.\nSafety restore point: ${terminalText(record.safetyCheckpointId)}\n`;
    case "files.delete": {
      const kindLabel = record.kind === "folder" ? "folder" : "file";
      const recovery = (record.recovery ?? {}) as {
        kind?: unknown;
        entryId?: unknown;
        restoreBy?: unknown;
        uncovered?: Array<{ path?: unknown; reason?: unknown }>;
      };
      if (recovery.kind !== "recently-deleted") {
        return `Deleted ${kindLabel} ${terminalText(record.path)} in ${connectedFolderLabel}.\n`
          + `Safety restore point: ${terminalText(record.safetyCheckpointId)} — restore it with 'history restore' to undo this delete.\n`;
      }
      const uncovered = Array.isArray(recovery.uncovered) ? recovery.uncovered : [];
      const named = uncovered.slice(0, 5)
        .map((file) => `${terminalText(file.path)} (${recentlyDeletedUncoveredReasonLabel(file.reason)})`)
        .join("; ");
      const more = uncovered.length > 5 ? `; and ${uncovered.length - 5} more` : "";
      return `Deleted ${kindLabel} ${terminalText(record.path)} in ${connectedFolderLabel}.\n`
        + `It is in Recently deleted until ${terminalText(recovery.restoreBy)} because History could not keep a copy of `
        + `${uncovered.length} file${uncovered.length === 1 ? "" : "s"}: ${named}${more}.\n`
        + `Put it back with 'recently-deleted restore --entry ${terminalText(recovery.entryId)}', or in Settings → Recently deleted.\n`;
    }
    case "files.mkdir":
      return `Created folder ${terminalText(record.path)} in ${connectedFolderLabel}.\n`;
    case "files.create":
      return `Created empty file ${terminalText(record.path)} in ${connectedFolderLabel}.\n`;
    case "search": {
      const files = (Array.isArray(record.files) ? record.files : []) as Array<{ path?: unknown; line?: unknown; preview?: unknown }>;
      const chats = (Array.isArray(record.chats) ? record.chats : []) as Array<{ conversationId?: unknown; title?: unknown; role?: unknown; preview?: unknown }>;
      const total = files.length + chats.length;
      const scopeLabel = `scope ${terminalText(record.scope ?? "all")}`;
      // The service's bounds are part of the answer: a stopped search must
      // never read as a complete one.
      const boundNote = (record.truncated === true ? "\nCoverage is incomplete; consult coverage in --json for skipped entries." : "")
        + (record.nextCursor ? `\nContinue with the same selection and --cursor ${terminalText(record.nextCursor)}` : "");
      if (!total) return `No matches for "${terminalText(record.query)}" in ${connectedFolderLabel} (${scopeLabel}).${boundNote}\n`;
      const sections: string[] = [];
      if (files.length) {
        const shown = files.slice(0, 20);
        sections.push(`Files (${files.length}):`);
        sections.push(...shown.map((match) => `- ${terminalText(match.path)}:${terminalText(match.line)} — ${terminalText(match.preview)}`));
        if (files.length > shown.length) sections.push(`${files.length - shown.length} more file match(es) in the --json result.`);
      }
      if (chats.length) {
        const shown = chats.slice(0, 10);
        sections.push(`Chats (${chats.length}):`);
        sections.push(...shown.map((match) => `- ${terminalText(match.title)} [${terminalText(match.conversationId)}] (${terminalText(match.role)}) — ${terminalText(match.preview)}`));
        if (chats.length > shown.length) sections.push(`${chats.length - shown.length} more Chat match(es) in the --json result.`);
      }
      return `${total} match${total === 1 ? "" : "es"} for "${terminalText(record.query)}" in ${connectedFolderLabel} (${scopeLabel}):\n${sections.join("\n")}${boundNote}\n`;
    }
    case "connected-folders.rename":
      return `Renamed Connected Folder ${connectedFolderLabel} (was "${terminalText(record.priorName)}").\n`;
    case "connected-folders.unregister": {
      const cleanup = record.cleanupPending === true
        ? "\nSome cleanup is still pending; AmpleFile finishes it on the next start."
        : "";
      return `Unregistered ${terminalText(record.storage)} Connected Folder ${connectedFolderLabel}. `
        + `The folder remains at ${terminalText(record.connectedFolder?.connectedFolderRoot)} with its portable .amplefile identity; `
        + `register it again to restore it.${cleanup}\n`;
    }
    case "connected-folders.appearance.apply": {
      const prior = typeof record.priorAppearanceRef === "string"
        ? ` (was ${terminalText(record.priorAppearanceRef)})`
        : " (was the default appearance)";
      return `Applied appearance proposal "${terminalText(record.proposalName)}" to ${connectedFolderLabel}${prior}. `
        + `Undo it with 'connected-folders appearance undo'.\n`;
    }
    case "connected-folders.appearance.reset":
      return record.changed === false
        ? `${connectedFolderLabel} already uses the default appearance.\n`
        : `Reset ${connectedFolderLabel} to the default appearance (was ${terminalText(record.priorAppearanceRef)}). `
          + `Undo it with 'connected-folders appearance undo'.\n`;
    case "connected-folders.appearance.undo": {
      const restored = typeof record.restoredAppearanceRef === "string"
        ? terminalText(record.restoredAppearanceRef)
        : "the default appearance";
      return `Restored ${connectedFolderLabel} to ${restored}. Running 'connected-folders appearance undo' again swaps back.\n`;
    }
    case "tools.remove": {
      const where = record.scope === "connected-folder" ? `Connected Folder scope in ${connectedFolderLabel}` : "everywhere scope";
      return record.removed === true
        ? `Removed package ${terminalText(record.source)} (${where}). Reinstalling it is a fresh receipted act.\n`
        : `Package ${terminalText(record.source)} is not installed (${where}); nothing was removed.\n`;
    }
    case "connected-folders.delete": {
      const cleanup = record.cleanupPending === true ? " Final cleanup completes at the next start." : "";
      const recentlyDeleted = (record.recentlyDeleted ?? null) as { entryId?: unknown; restoreBy?: unknown } | null;
      if (!recentlyDeleted) return `Deleted the managed folder of ${connectedFolderLabel}.${cleanup}\n`;
      return `Deleted ${connectedFolderLabel}. Its folder is in Recently deleted until ${terminalText(recentlyDeleted.restoreBy)}; `
        + `put it back with 'recently-deleted restore --entry ${terminalText(recentlyDeleted.entryId)}'.${cleanup}\n`;
    }
    case "tools.import-skill":
      return `Imported ${skillNameList(record.skillNames)} (${terminalText(record.scope)} scope).\n`;
    case "tools.install":
      return Array.isArray(record.skillNames)
        ? `Imported ${skillNameList(record.skillNames)} (${terminalText(record.scope)} scope).\n`
        : `Installed ${terminalText(record.packageId)} ${terminalText(record.version)} (${terminalText(record.scope)} scope).\n`;
    case "tools.enable":
    case "tools.disable":
      return `Turned ${record.enabled ? "on" : "off"} ${terminalText(record.path)} (${terminalText(record.scope)} scope).\n`;
    case "tools.update":
      return `Updated ${terminalText(record.packageId)} to ${terminalText(record.version)} (${terminalText(record.scope)} scope).\n`;
    case "automations.enable":
      return record.alreadyEnabled === true
        ? `Automation "${terminalText(record.title)}" [${terminalText(record.automationId)}] is already on with this exact declaration; nothing changed.\n`
        : `Enabled automation "${terminalText(record.title)}" [${terminalText(record.automationId)}]. It now runs on its trigger; `
          + `'automations run --automation ${terminalText(record.automationId)}' starts a copy now and `
          + `'automations disable --automation ${terminalText(record.automationId)}' turns it off.`
          + `${typeof record.stoppedRunId === "string" ? ` The run ${terminalText(record.stoppedRunId)} that was executing the previous declaration was stopped.` : ""}\n`;
    case "recently-deleted.list": {
      const entries = (Array.isArray(record.entries) ? record.entries : []) as Array<{
        id?: unknown;
        kind?: unknown;
        name?: unknown;
        connectedFolderName?: unknown;
        connectedFolderId?: unknown;
        scope?: unknown;
        sizeBytes?: unknown;
        deletedAt?: unknown;
        restoreBy?: unknown;
        restorable?: unknown;
        note?: unknown;
        held?: unknown;
      }>;
      const days = terminalText(record.retentionDays);
      if (!entries.length) return `Nothing in Recently deleted (items are kept ${days} days).\n`;
      const lines = entries.slice(0, 50).map((entry) => {
        const where = entry.kind === "skill" && entry.scope === "everywhere"
          ? "from Everywhere"
          : typeof entry.connectedFolderName === "string" && entry.connectedFolderName
            ? `from ${terminalText(entry.connectedFolderName)} [${terminalText(entry.connectedFolderId)}]`
            : `from Connected Folder ${terminalText(entry.connectedFolderId)}`;
        const how = entry.restorable === "blocked"
          ? ` — can't be put back${typeof entry.note === "string" && entry.note ? `: ${terminalText(entry.note)}` : ""}`
          : "";
        const held = entry.held ? " — kept indefinitely; AmpleFile could not read all of it" : "";
        return `- ${terminalText(entry.id)} — ${recentlyDeletedKindLabel(entry.kind)} "${terminalText(entry.name)}" ${where}`
          + ` — ${terminalText(entry.sizeBytes)} bytes — deleted ${terminalText(entry.deletedAt)}`
          + ` — kept until ${terminalText(entry.restoreBy)}${how}${held}`;
      });
      const more = entries.length > lines.length ? `\n${entries.length - lines.length} more in the --json result.` : "";
      const damaged = Number(record.damagedCount) > 0
        ? `\n${terminalText(record.damagedCount)} item(s) could not be read; they are left alone.`
        : "";
      return `${entries.length} item(s) in Recently deleted (kept ${days} days):\n${lines.join("\n")}${more}${damaged}\n`;
    }
    case "recently-deleted.restore": {
      const restored = (record.restored ?? {}) as {
        kind?: unknown;
        path?: unknown;
        renamed?: unknown;
        connectedFolderRoot?: unknown;
        scope?: unknown;
        name?: unknown;
        safetyCheckpointId?: unknown;
        connectedFolder?: { name?: unknown; id?: unknown };
      };
      const where = typeof restored.connectedFolder?.name === "string"
        ? `${terminalText(restored.connectedFolder.name)} [${terminalText(restored.connectedFolder.id)}]`
        : "its Connected Folder";
      if (restored.kind === "connected-folder") {
        return `Restored Connected Folder ${where} to ${terminalText(restored.connectedFolderRoot)}`
          + `${restored.renamed === true ? " under a new folder name, because the old one was taken" : ""}.\n`;
      }
      if (restored.kind === "skill") {
        const scope = restored.scope === "everywhere" ? "Everywhere" : `to ${where}`;
        return `Restored Skill "${terminalText(restored.name)}" ${scope} at ${terminalText(restored.path)}; it loads with the next turn.\n`;
      }
      return `Restored ${restored.kind === "folder" ? "folder" : "file"} ${terminalText(restored.path)} to ${where}`
        + `${restored.renamed === true ? " under a new name, because the old one was taken" : ""}.\n`
        // The restore stands either way; a missing undo point is said plainly
        // rather than reported as a failure the person cannot retry.
        + `${restored.safetyCheckpointId === null ? "History could not record a restore point for this, so there is no undo point for it.\n" : ""}`;
    }
    case "automations.models": {
      const models = (Array.isArray(record.models) ? record.models : []) as Array<{ provider?: unknown; providerName?: unknown; id?: unknown; name?: unknown; seesImages?: unknown }>;
      if (!models.length) return "No connected models. Connect a provider in Settings → AI Models.\n";
      return models.map((model) => `- ${terminalText(model.name)} — "model": {"provider": "${terminalText(model.provider)}", "id": "${terminalText(model.id)}"} · ${model.seesImages === true ? "sees images" : "text only"}`).join("\n") + "\n";
    }
    case "automations.list": {
      const automations = (Array.isArray(record.automations) ? record.automations : []) as Array<{
        automationId?: unknown;
        title?: unknown;
        health?: unknown;
        trigger?: { kind?: unknown; intervalMinutes?: unknown; at?: unknown; ifMissed?: unknown };
        stepCount?: unknown;
        nextScheduledAt?: unknown;
        suspension?: { missingConnectedFolderIds?: unknown };
      }>;
      if (!automations.length) return "No automations on this machine.\n";
      const lines = automations.slice(0, 50).map((automation) => {
        const trigger = automation.trigger?.kind === "interval"
          ? `every ${terminalText(automation.trigger.intervalMinutes)} min`
          : automation.trigger?.kind === "at"
            ? `once at ${terminalText(automation.trigger.at)}`
          : terminalText(automation.trigger?.kind ?? "manual");
        const next = typeof automation.nextScheduledAt === "string" ? `; next ${terminalText(automation.nextScheduledAt)}` : "";
        const missing = Array.isArray(automation.suspension?.missingConnectedFolderIds) && automation.suspension.missingConnectedFolderIds.length
          ? `; missing Connected Folder ${automation.suspension.missingConnectedFolderIds.map(terminalText).join(", ")}`
          : "";
        return `- ${terminalText(automation.title)} [${terminalText(automation.automationId)}] — ${terminalText(automation.health)} — ${trigger}, ${terminalText(automation.stepCount)} step(s)${next}${missing}`;
      });
      return `${automations.length} automation${automations.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n`;
    }
    case "automations.show": {
      const automation = (record.automation ?? {}) as {
        automationId?: unknown;
        title?: unknown;
        health?: unknown;
        digest?: unknown;
        trigger?: { kind?: unknown; intervalMinutes?: unknown; at?: unknown; ifMissed?: unknown; connectedFolderId?: unknown; watch?: Record<string, unknown>; debounceSeconds?: unknown; cooldownMinutes?: unknown };
        steps?: unknown;
        grants?: unknown;
        enabledAt?: unknown;
        disabledAt?: unknown;
        suspension?: { at?: unknown; missingConnectedFolderIds?: unknown; reRegisteredConnectedFolderIds?: unknown };
        lastScheduledAt?: unknown;
        nextScheduledAt?: unknown;
      };
      const connectedFolderRef = (id: unknown, resolvedName: unknown): string =>
        typeof resolvedName === "string" ? `${terminalText(resolvedName)} [${terminalText(id)}]` : `[${terminalText(id)}] (not registered)`;
      const steps = (Array.isArray(automation.steps) ? automation.steps : []) as Array<Record<string, unknown>>;
      const stepLines = steps.map((step) => {
        if (step.kind === "chat") {
          return `- ${terminalText(step.id)}: chat in ${connectedFolderRef(step.connectedFolderId, step.connectedFolderName)}${stepModelText(step.model)} — message (verbatim, becomes portable transcript content): ${terminalText(step.message)}`;
        }
        if (step.kind === "files") {
          const source = (step.source ?? {}) as Record<string, unknown>;
          const sourceLabel = source.kind === "paths"
            ? `paths ${(Array.isArray(source.paths) ? source.paths : []).map(terminalText).join(", ")}`
            : source.kind === "tree"
              ? `tree ${terminalText(source.path)} (${source.recursive === true ? "recursive" : "one level"}; ${(Array.isArray(source.extensions) ? source.extensions : []).map(terminalText).join(", ") || "all extensions"})`
              : `files created by step ${terminalText(source.step)} (max ${terminalText(source.maxFiles)} files, ${terminalText(source.maxTotalBytes)} bytes)`;
          return `- ${terminalText(step.id)}: files from ${connectedFolderRef(step.fromConnectedFolderId, step.fromConnectedFolderName)} — ${sourceLabel} → ${connectedFolderRef(step.toConnectedFolderId, step.toConnectedFolderName)}:${terminalText(step.to)}`;
        }
        return `- ${terminalText(step.id)}: message to the AmpleFile Agent${stepModelText(step.model)} (verbatim, becomes AmpleFile Agent transcript content): ${terminalText(step.message)}`;
      });
      const trigger = automation.trigger?.kind === "interval"
        ? `interval, every ${terminalText(automation.trigger.intervalMinutes)} minutes`
        : automation.trigger?.kind === "at"
          ? `once at ${terminalText(automation.trigger.at)}; if missed: ${terminalText(automation.trigger.ifMissed)}`
        : automation.trigger?.kind === "files-changed"
          ? `folder changes in Connected Folder ${terminalText(automation.trigger.connectedFolderId)}: ${terminalText(automation.trigger.watch?.path)}; debounce ${terminalText(automation.trigger.debounceSeconds)}s; cooldown ${terminalText(automation.trigger.cooldownMinutes)} minutes${automation.trigger.ifMissed === "run" ? "; catches up once on files added or changed while AmpleFile was closed, the computer was asleep, or this automation was off" : ""}`
        : "manual (run-now only)";
      const grants = (Array.isArray(automation.grants) ? automation.grants : []) as Array<Record<string, unknown>>;
      const grantLines = grants.map((grant) =>
        `- enabled ${terminalText(grant.enabledAt)} via ${terminalText(grant.surface)} (request ${terminalText(grant.requestId)}) — digest ${terminalText(grant.digest)}`);
      const health = automation.health === "suspended" && automation.suspension
        ? `suspended since ${terminalText(automation.suspension.at)} (missing Connected Folder ${(Array.isArray(automation.suspension.missingConnectedFolderIds) ? automation.suspension.missingConnectedFolderIds : []).map(terminalText).join(", ")}${Array.isArray(automation.suspension.reRegisteredConnectedFolderIds) && automation.suspension.reRegisteredConnectedFolderIds.length ? "; re-registered with preserved identity — turn it on again after reading it through" : ""})`
        : automation.health === "disabled"
          ? `disabled${typeof automation.disabledAt === "string" ? ` since ${terminalText(automation.disabledAt)}` : ""}`
          : automation.health === "completed"
            ? "completed"
            : `enabled${typeof automation.enabledAt === "string" ? ` since ${terminalText(automation.enabledAt)}` : ""}`;
      // What stays true for as long as the automation is on (docs/automations.md).
      // These are residuals, stated plainly here rather than policed with
      // re-review machinery: a created-files handoff is a standing,
      // content-dependent channel between two Connected Folders, and a chat step runs
      // with whatever authority its Connected Folder's Worker holds at run time.
      const handoffs = steps.filter((step) => step.kind === "files"
        && ((step.source ?? {}) as Record<string, unknown>).kind === "step-created-files");
      const residuals = [
        ...handoffs.map((step) => {
          const source = (step.source ?? {}) as Record<string, unknown>;
          return `- Standing channel: whatever step ${terminalText(source.step)}'s turn writes is copied into `
            + `${connectedFolderRef(step.toConnectedFolderId, step.toConnectedFolderName)} on every run.`;
        }),
        ...(steps.some((step) => step.kind === "chat")
          ? ["- Each chat step's turn runs with whatever authority its Connected Folder's Worker holds at that moment, not the authority it held when this automation was turned on."]
          : []),
      ];
      const lines = [
        `Automation "${terminalText(automation.title)}" [${terminalText(automation.automationId)}]`,
        `Health: ${health}`,
        `Digest: ${terminalText(automation.digest)}`,
        `Trigger: ${trigger}${typeof automation.nextScheduledAt === "string" ? `; next run ${terminalText(automation.nextScheduledAt)}` : ""}`,
        "Steps:",
        ...stepLines,
        ...(residuals.length ? ["While this automation is on:", ...residuals] : []),
        ...(grantLines.length ? ["Enablement receipts:", ...grantLines] : []),
      ];
      return `${lines.join("\n")}\n`;
    }
    case "automations.run": {
      const run = record.run as { runId?: unknown; outcome?: unknown; error?: unknown } | undefined;
      const error = typeof run?.error === "string" && run.error ? `\n${terminalText(run.error)}` : "";
      return `Automation "${terminalText(record.title)}" [${terminalText(record.automationId)}] ran with outcome ${terminalText(run?.outcome)} (run ${terminalText(run?.runId)}). `
        + `Run-now never shifts the schedule; per-hop receipts are in 'automations receipts'.${error}\n`;
    }
    case "automations.stop":
      return `Stopped the active run ${terminalText(record.runId)} of automation [${terminalText(record.automationId)}]. `
        + `The current hop was aborted through its own domain, later hops are recorded skipped, and the run settles stopped.\n`;
    case "automations.disable": {
      const stopped = typeof record.stoppedRunId === "string"
        ? ` Its active run ${terminalText(record.stoppedRunId)} was stopped first — revocation stops stale work.`
        : "";
      return `Disabled automation [${terminalText(record.automationId)}].${stopped} `
        + `The declaration, grant history, and receipts are kept; re-enabling is a fresh receipted act.\n`;
    }
    case "automations.delete":
      return `Deleted automation [${terminalText(record.automationId)}] (was ${terminalText(record.finalHealth)}). `
        + `Its receipts journal is retained — audit records survive the object.\n`;
    case "automations.receipts": {
      const receipts = (Array.isArray(record.receipts) ? record.receipts : []) as Array<{
        at?: unknown;
        scope?: unknown;
        outcome?: unknown;
        automationId?: unknown;
        runId?: unknown;
        hopId?: unknown;
        hopKind?: unknown;
        placeholders?: unknown;
        detail?: unknown;
        partial?: unknown;
      }>;
      if (!receipts.length) return "No automation receipts recorded.\n";
      const shown = receipts.slice(-50);
      const lines = shown.map((entry) => {
        const kind = typeof entry.hopKind === "string" ? ` (${terminalText(entry.hopKind)})` : "";
        const scope = entry.scope === "hop"
          ? `hop ${terminalText(entry.hopId)}${kind} of run ${terminalText(entry.runId)}`
          : entry.scope === "run" ? `run ${terminalText(entry.runId)}` : "automation";
        const filled = Array.isArray(entry.placeholders) && entry.placeholders.length
          ? ` — filled in ${entry.placeholders
            .map((placeholder) => terminalText((placeholder as { name?: unknown }).name))
            .join(", ")} (see --json for the text)`
          : "";
        const detail = typeof entry.detail === "string" && entry.detail ? ` — ${terminalText(entry.detail)}` : "";
        const partly = entry.partial === true ? " (partly done)" : "";
        return `- ${terminalText(entry.at)} [${terminalText(entry.automationId)}] ${scope}: ${terminalText(entry.outcome)}${partly}${filled}${detail}`;
      });
      const omitted = receipts.length > shown.length ? `\n${receipts.length - shown.length} older receipt(s) in the --json result.` : "";
      const damaged = typeof record.damagedLineCount === "number" && record.damagedLineCount > 0
        ? `\n${terminalText(record.damagedLineCount)} journal line(s) could not be read and are omitted.`
        : "";
      const truncated = record.truncated === true ? "\nThe journal read stopped at its bound; older receipts were omitted." : "";
      return `${receipts.length} automation receipt${receipts.length === 1 ? "" : "s"}:\n${lines.join("\n")}${omitted}${truncated}${damaged}\n`;
    }
    default:
      return `${terminalText(name)} completed.\n`;
  }
}

function skillNameList(names: unknown): string {
  return Array.isArray(names) ? names.map((name) => terminalText(name)).join(", ") : terminalText(names);
}

/** Person-facing names for what is waiting in Recently deleted. */
function recentlyDeletedKindLabel(kind: unknown): string {
  switch (kind) {
    case "file": return "file";
    case "folder": return "folder";
    case "connected-folder": return "connected-folder";
    case "skill": return "Skill";
    // What an earlier build kept from a Connected Folder app.
    case "app-storage":
    case "app-retained":
    case "app-release":
    case "app-studio": return "old app item";
    default: return "item";
  }
}

/** Why History alone could not keep a copy of one path. */
function recentlyDeletedUncoveredReasonLabel(reason: unknown): string {
  switch (reason) {
    case "too_large": return "too large";
    case "unreadable": return "unreadable";
    case "symbolic_link": return "a link";
    case "excluded": return "kept out of History";
    default: return "not covered";
  }
}

/**
 * Verbs whose receipt's checkpoint column is the safety restore point the act
 * itself recorded (docs/act-ledger.md "receipt adds"). `files.mkdir` and
 * `files.create` are deliberately absent: creation is additive and destroys
 * nothing, so their receipts carry the created path instead of a restore-point
 * reference — the canonical inverse is `files delete`.
 */
const actSafetyCheckpointCommands: ReadonlySet<AmpleFileCliActCommandName> = new Set([
  "history.restore-file",
  "files.move",
  "files.rename",
  "files.delete",
  // Restoring from Recently deleted is additive, and the restore point it
  // records is what undoes it.
  "recently-deleted.restore",
]);

function receiptDetails(name: AmpleFileCliActCommandName, data: AmpleFileCliJson): {
  connectedFolderId?: string;
  conversationId?: string;
  checkpointId?: string;
  taskId?: string;
  undoRef?: AmpleFileCliActUndoRef;
  detail?: string;
} {
  const record = data as {
    connectedFolder?: { id?: unknown };
    conversation?: { id?: unknown };
    conversationId?: unknown;
    checkpointId?: unknown;
    taskId?: unknown;
    task?: { taskId?: unknown };
    run?: { taskId?: unknown; runId?: unknown; outcome?: unknown };
    checkpoint?: { checkpointId?: unknown };
    created?: unknown;
    safetyCheckpointId?: unknown;
    scope?: unknown;
    path?: unknown;
    copied?: unknown;
    restored?: { connectedFolder?: { id?: unknown }; safetyCheckpointId?: unknown };
    toConnectedFolder?: { id?: unknown };
    continuation?: { taskId?: unknown };
  };
  // A handoff's effects — the copies, their restore point, the new Chat —
  // land in the destination, so its receipt names that Connected Folder.
  const connectedFolderId = name === "chat.handoff" && typeof record.toConnectedFolder?.id === "string"
    ? record.toConnectedFolder.id
    : typeof record.connectedFolder?.id === "string"
      ? record.connectedFolder.id
      : typeof record.restored?.connectedFolder?.id === "string" ? record.restored.connectedFolder.id : undefined;
  const conversationId = typeof record.conversationId === "string"
    ? record.conversationId
    : typeof record.conversation?.id === "string" ? record.conversation.id : undefined;
  const safetyCheckpointId = typeof record.safetyCheckpointId === "string"
    ? record.safetyCheckpointId
    : typeof record.restored?.safetyCheckpointId === "string" ? record.restored.safetyCheckpointId : undefined;
  // Per-family receipt growth from the ledger's "receipt adds" column:
  // history.save records the restore-point id plus the honest created flag,
  // and the restore and file-mutation verbs record the safety restore point
  // History created for them.
  const checkpointId = typeof record.checkpointId === "string"
    ? record.checkpointId
    : name === "history.save" && typeof record.checkpoint?.checkpointId === "string"
      ? record.checkpoint.checkpointId
      : actSafetyCheckpointCommands.has(name)
        ? safetyCheckpointId
        : undefined;
  const detail = actReceiptDetail(name, record);
  const undoRef = actUndoRef(name, data, safetyCheckpointId);
  return {
    ...(connectedFolderId ? { connectedFolderId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    ...(typeof record.taskId === "string"
      ? { taskId: record.taskId }
      : typeof record.task?.taskId === "string"
        ? { taskId: record.task.taskId }
        : typeof record.run?.taskId === "string"
          ? { taskId: record.run.taskId }
          : typeof record.continuation?.taskId === "string"
            ? { taskId: record.continuation.taskId }
            : {}),
    ...(undoRef ? { undoRef } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Per-family receipt detail from the ledger's "receipt adds" column. For
 * search this is deliberately the scope alone — receipts never record the
 * query text; appearance and presentation entries carry short content refs,
 * never the customization or presentation payloads.
 */
function actReceiptDetail(
  name: AmpleFileCliActCommandName,
  record: {
    enabled?: unknown;
    created?: unknown;
    scope?: unknown;
    path?: unknown;
    copied?: unknown;
    added?: unknown;
    storage?: unknown;
    changed?: unknown;
    appearanceRef?: unknown;
    restoredAppearanceRef?: unknown;
    removed?: unknown;
    source?: unknown;
    digest?: unknown;
    run?: { runId?: unknown; outcome?: unknown };
    automationId?: unknown;
    declarationDigest?: unknown;
    alreadyEnabled?: unknown;
    stoppedRunId?: unknown;
    runId?: unknown;
    finalHealth?: unknown;
    contentDigest?: unknown;
    version?: unknown;
    packageId?: unknown;
    model?: { provider?: unknown; id?: unknown } | null;
    instructions?: unknown;
    result?: unknown;
    recovery?: { kind?: unknown; entryId?: unknown };
    recentlyDeleted?: unknown;
    entry?: { id?: unknown; kind?: unknown };
    restored?: { kind?: unknown; path?: unknown; connectedFolderRoot?: unknown; connectedFolder?: { id?: unknown } };
    question?: { questionId?: unknown; respondent?: unknown };
    redirectedToPerson?: unknown;
    continuation?: { taskId?: unknown };
    toConnectedFolder?: { id?: unknown };
    taskId?: unknown;
    job?: unknown;
  },
): string | undefined {
  // The collaboration verbs record identifiers, outcomes, and counts only:
  // never a summary, a question, or an answer (docs/collaboration-contract.md).
  const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  switch (name) {
    case "chat.report": {
      const outcome = record.result && typeof record.result === "object" ? (record.result as { outcome?: unknown; files?: unknown }) : {};
      const files = countOf(outcome.files);
      return `report ${typeof outcome.outcome === "string" ? outcome.outcome : "unknown"}; ${files} file${files === 1 ? "" : "s"}`;
    }
    case "agent.ask":
    case "chat.ask":
      return typeof record.question?.questionId === "string"
        ? `question ${record.question.questionId} to ${record.redirectedToPerson ? "person (redirected from parent)" : typeof record.question.respondent === "string" ? record.question.respondent : "person"}`
        : undefined;
    case "agent.answer":
    case "chat.answer":
      return typeof record.question?.questionId === "string"
        ? `answered ${record.question.questionId}; continuation ${typeof record.continuation?.taskId === "string" ? record.continuation.taskId : "none"}`
        : undefined;
    case "chat.handoff": {
      const copied = countOf(record.copied);
      return `${(record as { followUp?: unknown }).followUp === true ? "follow-up" : "handoff"} to ${typeof record.toConnectedFolder?.id === "string" ? record.toConnectedFolder.id : "unknown"}; ${copied} file${copied === 1 ? "" : "s"}`;
    }
    case "chat.steer":
      return `steered running task ${typeof (record as { taskId?: unknown }).taskId === "string" ? (record as { taskId: string }).taskId : "unknown"}`;
    case "chat.copy": {
      const copy = record as { copiedFromConversationId?: unknown; copiedMessages?: unknown; taskId?: unknown };
      return `copy of ${typeof copy.copiedFromConversationId === "string" ? copy.copiedFromConversationId : "unknown"}; ${typeof copy.copiedMessages === "number" ? copy.copiedMessages : 0} messages${typeof copy.taskId === "string" ? `; task ${copy.taskId}` : ""}`;
    }
    // Ids and states only; a receipt never carries the command text.
    case "jobs.start":
    case "jobs.stop": {
      const job = record.job && typeof record.job === "object" ? record.job as { jobId?: unknown; state?: unknown; taskId?: unknown } : {};
      return typeof job.jobId === "string"
        ? `job ${job.jobId}; ${typeof job.state === "string" ? job.state : "unknown"}; started by task ${typeof job.taskId === "string" ? job.taskId : "unknown"}`
        : undefined;
    }
    default:
      break;
  }
  // The verbs that install code, widen a power, or destroy data share one
  // detail spine — the prepared-act kind — with the family's exact
  // identifiers appended per the ledger's "receipt adds" column. Identifiers
  // and digests only; receipts never grow titles, messages, or file contents.
  const recentlyDeletedRef = (value: unknown): string | null => {
    if (Array.isArray(value)) {
      const ids = value
        .map((item) => (item && typeof item === "object" ? (item as { entryId?: unknown }).entryId : undefined))
        .filter((id): id is string => typeof id === "string");
      return ids.length ? `recently-deleted ${ids.join(",")}` : null;
    }
    const entryId = value && typeof value === "object" ? (value as { entryId?: unknown }).entryId : undefined;
    return typeof entryId === "string" ? `recently-deleted ${entryId}` : null;
  };
  switch (name) {
    case "files.delete":
      return record.recovery?.kind === "recently-deleted" && typeof record.recovery.entryId === "string"
        ? `recently-deleted ${record.recovery.entryId}`
        : undefined;
    case "recently-deleted.list":
      return undefined;
    case "recently-deleted.restore":
      return `entry ${String(record.entry?.id ?? "")}; kind ${String(record.restored?.kind ?? "")}; `
        + `restored ${boundedReceiptText(String(
          record.restored?.path ?? record.restored?.connectedFolderRoot ?? record.restored?.connectedFolder?.id ?? "",
        ))}`;
    case "connected-folders.delete":
      return `connected-folder.delete-folder${recentlyDeletedRef(record.recentlyDeleted) ? `; ${recentlyDeletedRef(record.recentlyDeleted)}` : ""}`;
    case "tools.import-skill":
      return `capability.skills.import; scope ${String(record.scope)}; source ${boundedReceiptText(String(record.source))}; digest ${String(record.contentDigest)}`;
    case "tools.install":
      return typeof record.contentDigest === "string"
        ? `capability.skills.import; scope ${String(record.scope)}; source ${boundedReceiptText(String(record.source))}; digest ${record.contentDigest}`
        : `capability.package.install; scope ${String(record.scope)}; source ${boundedReceiptText(String(record.source))}; version ${String(record.version)}`;
    case "tools.enable":
    case "tools.disable":
      return `capability.resource.enabled; scope ${String(record.scope)}; enabled ${String(record.enabled)}; path ${boundedReceiptText(String(record.path))}`;
    case "tools.update":
      return `capability.package.update; scope ${String(record.scope)}; source ${boundedReceiptText(String(record.source))}; version ${String(record.version)}`;
    case "automations.enable":
      return `automation.enable; automation ${String(record.automationId)}; digest ${String(record.declarationDigest)}`
        + `${record.alreadyEnabled === true ? "; already enabled" : ""}`
        + `${typeof record.stoppedRunId === "string" ? `; stopped run ${String(record.stoppedRunId)}` : ""}`;
    default:
      break;
  }
  switch (name) {
    case "connected-folders.worker.model":
      return typeof record.model?.provider === "string" && typeof record.model?.id === "string"
        ? `provider ${record.model.provider}; model ${record.model.id}`
        : undefined;
    case "connected-folders.worker.instructions":
      return typeof record.instructions === "string"
        ? record.instructions ? `updated; ${record.instructions.length} character(s)` : "cleared"
        : undefined;
    case "history.save":
      return typeof record.created === "boolean"
        ? record.created ? "created restore point" : "already matches the latest restore point"
        : undefined;
    case "search":
      return typeof record.scope === "string" ? `scope ${record.scope}` : undefined;
    case "files.move":
      return typeof record.path === "string" ? `moved to ${record.path}` : undefined;
    case "connected-folders.unregister":
      return typeof record.storage === "string" ? `storage ${record.storage}` : undefined;
    case "connected-folders.appearance.apply":
      return typeof record.appearanceRef === "string" ? `applied ${record.appearanceRef}` : "applied default";
    case "connected-folders.appearance.reset":
      return record.changed === false ? "already default" : undefined;
    case "connected-folders.appearance.undo":
      return `restored ${typeof record.restoredAppearanceRef === "string" ? record.restoredAppearanceRef : "none"}`;
    case "tools.remove":
      return typeof record.scope === "string" && typeof record.source === "string"
        ? `scope ${record.scope}; source ${boundedReceiptText(record.source)}${record.removed === false ? " (not installed)" : ""}`
        : undefined;
    // Automation receipts carry identifiers and outcomes only, per the
    // automations five-questions table — the owning journal holds the per-hop
    // evidence.
    case "automations.run":
      return typeof record.automationId === "string" && typeof record.run?.runId === "string"
        ? `automation ${record.automationId}; run ${record.run.runId}; outcome ${String(record.run.outcome)}`
        : undefined;
    case "automations.stop":
      return typeof record.automationId === "string"
        ? `automation ${record.automationId}; stopped run ${String(record.runId)}`
        : undefined;
    case "automations.disable":
      return typeof record.automationId === "string"
        ? `automation ${record.automationId}${typeof record.stoppedRunId === "string" ? `; stopped run ${record.stoppedRunId}` : ""}`
        : undefined;
    case "automations.delete":
      return typeof record.automationId === "string"
        ? `automation ${record.automationId}; digest ${String(record.digest)}; final health ${String(record.finalHealth)}`
        : undefined;
    default:
      return undefined;
  }
}

/** Receipt details stay content-light; long identifiers are cut, never dropped. */
function boundedReceiptText(value: string, maximumLength = 200): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

/**
 * Typed undo reference stamped on ok receipts (docs/act-ledger.md,
 * receipt schema growth): identifiers, short prior values, and restore-point
 * ids only — enough for the inverse verb, never content.
 */
function actUndoRef(
  name: AmpleFileCliActCommandName,
  data: AmpleFileCliJson,
  safetyCheckpointId: string | undefined,
): AmpleFileCliActUndoRef | undefined {
  const record = data as {
    priorTitle?: unknown;
    priorLifecycle?: { archivedAt?: unknown; snoozedUntil?: unknown };
    priorName?: unknown;
    path?: unknown;
    connectedFolder?: { connectedFolderRoot?: unknown };
    recovery?: { kind?: unknown; entryId?: unknown };
    recentlyDeleted?: unknown;
    restored?: { kind?: unknown; connectedFolderRoot?: unknown };
    priorAppearanceRef?: unknown;
    displacedAppearanceRef?: unknown;
    automationId?: unknown;
    source?: unknown;
    bundlePath?: unknown;
    contentDigest?: unknown;
  };
  switch (name) {
    case "chat.rename":
      return typeof record.priorTitle === "string"
        ? { kind: "chat-title", value: record.priorTitle }
        : undefined;
    // A handoff's copies are undone from the destination's restore point. A
    // report, a question, and an answer are records, not mutations: they
    // have no undo, and the ledger says so rather than inventing one.
    case "chat.handoff":
      return typeof (record as { checkpointId?: unknown }).checkpointId === "string"
        ? { kind: "checkpoint", value: (record as { checkpointId: string }).checkpointId }
        : undefined;
    case "chat.snooze":
    case "chat.archive":
    case "chat.resume": {
      const prior = record.priorLifecycle;
      if (!prior || typeof prior !== "object") return undefined;
      const value = typeof prior.archivedAt === "string"
        ? "archived"
        : typeof prior.snoozedUntil === "string"
          ? `snoozed:${prior.snoozedUntil}`
          : "active";
      return { kind: "chat-lifecycle", value };
    }
    case "files.delete":
      // A delete History could not fully cover is undone by putting the
      // Recently deleted item back, not by the partial restore point.
      if (record.recovery?.kind === "recently-deleted" && typeof record.recovery.entryId === "string") {
        return { kind: "recently-deleted-entry", value: record.recovery.entryId };
      }
      return safetyCheckpointId ? { kind: "safety-checkpoint", value: safetyCheckpointId } : undefined;
    case "connected-folders.delete": {
      const first = Array.isArray(record.recentlyDeleted) ? record.recentlyDeleted[0] : record.recentlyDeleted;
      const entryId = first && typeof first === "object" ? (first as { entryId?: unknown }).entryId : undefined;
      return typeof entryId === "string" ? { kind: "recently-deleted-entry", value: entryId } : undefined;
    }
    case "recently-deleted.restore":
      // A file or folder restore is undone by its own restore point; a Connected Folder
      // restore's inverse is `connected-folders delete` of the root it came back to.
      if (record.restored?.kind === "connected-folder" && typeof record.restored.connectedFolderRoot === "string") {
        return { kind: "connected-folder-root", value: record.restored.connectedFolderRoot };
      }
      return safetyCheckpointId ? { kind: "safety-checkpoint", value: safetyCheckpointId } : undefined;
    case "history.restore":
    case "history.restore-file":
    case "files.move":
      return safetyCheckpointId ? { kind: "safety-checkpoint", value: safetyCheckpointId } : undefined;
    case "files.rename":
      return typeof record.priorName === "string" ? { kind: "entry-name", value: record.priorName } : undefined;
    case "files.mkdir":
    case "files.create":
      // Creation's inverse is `files delete` of the created path; there is
      // deliberately no restore-point reference (creation destroys nothing).
      return typeof record.path === "string" ? { kind: "created-path", value: record.path } : undefined;
    case "connected-folders.rename":
      return typeof record.priorName === "string" ? { kind: "connected-folder-name", value: record.priorName } : undefined;
    case "connected-folders.unregister":
      // Re-registering the folder is the inverse; the portable `.amplefile/`
      // identity persists at this root.
      return typeof record.connectedFolder?.connectedFolderRoot === "string"
        ? { kind: "connected-folder-root", value: record.connectedFolder.connectedFolderRoot }
        : undefined;
    case "connected-folders.appearance.apply":
    case "connected-folders.appearance.reset":
      return {
        kind: "appearance-ref",
        value: typeof record.priorAppearanceRef === "string" ? record.priorAppearanceRef : "none",
      };
    case "connected-folders.appearance.undo":
      // Undo is its own inverse: the displaced ref is what a second undo
      // would restore.
      return {
        kind: "appearance-ref",
        value: typeof record.displacedAppearanceRef === "string" ? record.displacedAppearanceRef : "none",
      };
    // Verbs that make code runnable or widen a power (docs/act-ledger.md):
    // each undo reference names the identifier its narrowing inverse takes —
    // `automations disable`, `tools remove`.
    case "automations.enable":
      return typeof record.automationId === "string" ? { kind: "automation-id", value: record.automationId } : undefined;
    case "tools.install":
    case "tools.update":
      // A catalog skill bundle installs as a skills import; its inverse is
      // removing the bundle path, not a package source.
      if (typeof record.contentDigest === "string" && typeof record.bundlePath === "string") {
        return { kind: "skill-bundle-path", value: record.bundlePath };
      }
      return typeof record.source === "string" ? { kind: "package-source", value: record.source } : undefined;
    case "tools.import-skill":
      return typeof record.bundlePath === "string" ? { kind: "skill-bundle-path", value: record.bundlePath } : undefined;
    default:
      return undefined;
  }
}

function tokensMatch(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.byteLength !== providedBytes.byteLength) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}

function toJson(value: unknown): AmpleFileCliJson {
  return JSON.parse(JSON.stringify(value)) as AmpleFileCliJson;
}

// Unlike the read lane's single-line values, act output legitimately spans
// lines (assistant replies, provider errors), so newlines and tabs survive.
function terminalText(value: unknown): string {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "\uFFFD");
}

/** One bounded line of person content for a human listing; `--json` carries the whole text. */
function clampLine(value: unknown, maximumLength = 200): string {
  const text = terminalText(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maximumLength ? text : `${text.slice(0, maximumLength - 1)}…`;
}

/**
 * `requests show`: the request, its turns, questions, results, and each child
 * request indented beneath it. Summaries and question text are clamped here;
 * the JSON form carries them whole.
 */
function renderRequestDetail(request: Record<string, AmpleFileCliJson> | null | undefined, depth: number): string[] {
  if (!request) return ["Request not found."];
  const pad = "  ".repeat(depth);
  const turns = (Array.isArray(request.turns) ? request.turns : []) as Array<{ taskId?: string; role?: string; state?: string }>;
  const questions = (Array.isArray(request.questions) ? request.questions : []) as Array<{
    questionId?: string; respondent?: string; state?: string; text?: string; answer?: string | null; continuationTaskId?: string | null;
  }>;
  const results = (Array.isArray(request.resultRecords) ? request.resultRecords : []) as Array<{
    resultId?: string; taskId?: string; outcome?: string; fileCount?: number; envelope?: { summary?: string } | null; damaged?: string;
  }>;
  const children = (Array.isArray(request.childRequests) ? request.childRequests : []) as Array<Record<string, AmpleFileCliJson>>;
  const where = request.connectedFolderName ? `${terminalText(request.connectedFolderName)} [${terminalText(request.connectedFolderId)}]` : "the AmpleFile Agent";
  const lines = [
    `${pad}Request ${terminalText(request.id)} — ${terminalText(request.kind)}, ${terminalText(request.state)} — ${where}, Chat ${terminalText(request.conversationId)}`,
    `${pad}  started ${terminalText(request.createdAt)}${request.deadline ? `, open until ${terminalText(request.deadline)}` : ""}${request.settledAt ? `, settled ${terminalText(request.settledAt)}` : ""}${request.stopRequestedAt ? `, stopped ${terminalText(request.stopRequestedAt)}` : ""}`,
    ...(typeof request.content === "string" && request.content.trim() ? [`${pad}  asked: ${clampLine(request.content)}`] : []),
    ...turns.map((turn) => `${pad}  turn ${terminalText(turn.taskId)} (${terminalText(turn.role)}) — ${terminalText(turn.state)}`),
    ...questions.map((question) =>
      `${pad}  question ${terminalText(question.questionId)} to ${question.respondent === "parent" ? "the request above" : "you"} — ${terminalText(question.state)}: ${clampLine(question.text)}`
      + (question.answer ? `\n${pad}    answer: ${clampLine(question.answer)}${question.continuationTaskId ? ` (continued as task ${terminalText(question.continuationTaskId)})` : ""}` : "")),
    ...results.map((result) =>
      `${pad}  result ${terminalText(result.resultId)} from task ${terminalText(result.taskId)} — ${terminalText(result.outcome)}, ${terminalText(result.fileCount ?? 0)} file${result.fileCount === 1 ? "" : "s"}: ${result.envelope ? clampLine(result.envelope.summary) : `(unreadable: ${terminalText(result.damaged)})`}`),
  ];
  for (const child of children) lines.push(...renderRequestDetail(child, depth + 1));
  return lines;
}

function humanActErrorMessage(error: AmpleFileCliError): string {
  const usageHint = "\nRun 'amplefile help' for usage.";
  if (error.code === "usage" && error.message.endsWith(usageHint)) {
    return `${terminalText(error.message.slice(0, -usageHint.length))}${usageHint}`;
  }
  return terminalText(error.message);
}

function usageError(message: string): AmpleFileCliError {
  return new AmpleFileCliError("usage", `${message}\nRun 'amplefile help' for usage.`);
}

function normalizeActError(error: unknown): AmpleFileCliError {
  if (error instanceof AmpleFileCliError) return error;
  return new AmpleFileCliError("failure", error instanceof Error ? error.message : String(error ?? "AmpleFile act command failed."), { cause: error });
}

/** " using <id> (<provider>)" when an automation step names its own model. */
function stepModelText(model: unknown): string {
  if (!model || typeof model !== "object") return "";
  const { provider, id } = model as Record<string, unknown>;
  return typeof provider === "string" && typeof id === "string" ? ` using ${terminalText(id)} (${terminalText(provider)})` : "";
}
