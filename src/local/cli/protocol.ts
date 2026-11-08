import { isAbsolute, resolve } from "node:path";

/**
 * Protocol v1 is intentionally a read-only, same-user control surface. The
 * platform application-data file exchange is not an authenticated caller boundary. Do not add
 * mutating commands to this version. Mutations live exclusively in the
 * separately versioned act lane (`act-protocol.ts`), which authenticates each
 * request with the per-launch act token the running desktop app mints.
 */
export const AMPLEFILE_CLI_PROTOCOL_VERSION = 1 as const;

/** Accepted shape for per-launch act tokens carried by act-lane requests. */
export const AMPLEFILE_CLI_ACT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
export const AMPLEFILE_CLI_MAX_ARG_COUNT = 16_384;
export const AMPLEFILE_CLI_MAX_ARG_LENGTH = 4 * 1024 * 1024;
export const AMPLEFILE_CLI_MAX_ARGV_LENGTH = 16 * 1024 * 1024;

export const AmpleFileCliExitCode = {
  success: 0,
  failure: 1,
  usage: 2,
  notFound: 3,
  permissionDenied: 4,
  conflict: 5,
  unavailable: 6,
  timeout: 7,
  protocolError: 8,
} as const;

export type AmpleFileCliExitCode = typeof AmpleFileCliExitCode[keyof typeof AmpleFileCliExitCode];
export type AmpleFileCliErrorCode = Exclude<keyof typeof AmpleFileCliExitCode, "success">;
export type AmpleFileCliOutputMode = "human" | "json";
export type AmpleFileCliCommandName = "help" | "version" | "skill" | "context" | "connected-folders.list" | "tasks.list" | "capabilities.list";

export type AmpleFileCliJson =
  | null
  | boolean
  | number
  | string
  | AmpleFileCliJson[]
  | { [key: string]: AmpleFileCliJson };

/** Stable on-disk request contract shared by platform shims and the desktop broker. */
export interface AmpleFileCliRequestV1 {
  protocolVersion: typeof AMPLEFILE_CLI_PROTOCOL_VERSION;
  id: string;
  argv: string[];
  cwd: string;
  createdAt: string;
}

/** Stable on-disk response contract shared by the desktop broker and platform shims. */
export interface AmpleFileCliResponseV1 {
  protocolVersion: typeof AMPLEFILE_CLI_PROTOCOL_VERSION;
  id: string;
  exitCode: AmpleFileCliExitCode;
  stdout: string;
  stderr: string;
  result?: AmpleFileCliJson;
  completedAt?: string;
}

export interface AmpleFileCliParsedCommand {
  name: AmpleFileCliCommandName;
  output: AmpleFileCliOutputMode;
  connectedFolder?: string;
  topic?: string;
}

export interface AmpleFileCliActor {
  kind: "cli";
  cwd: string;
}

export interface AmpleFileCliConnectedFolderSummary {
  id: string;
  name: string;
  connectedFolderRoot?: string;
  active?: boolean;
  /** The registered Connected Folder whose folder contains this one; absent for a top-level Connected Folder. */
  parentConnectedFolderId?: string;
}

export interface AmpleFileCliContextSnapshot {
  cwd: string;
  connectedFolder: AmpleFileCliConnectedFolderSummary | null;
  selectedPath?: string | null;
  activeSurface?: string | null;
}

export interface AmpleFileCliTaskSummary {
  id: string;
  label: string;
  status: string;
  connectedFolderId?: string;
  updatedAt?: string;
}

export interface AmpleFileCliCapabilitySummary {
  id: string;
  name: string;
  kind: "skill" | "extension" | "tool" | "package" | "other";
  scope: "everywhere" | "connected-folder" | string;
  status?: string;
  source?: string;
}

/**
 * The deliberately narrow adapter needed by the CLI executor. AmpleFileKernel
 * satisfies this interface through a compact projection without importing
 * desktop code into the reusable control plane.
 */
export interface AmpleFileCliKernel {
  getContext(actor: AmpleFileCliActor, options: { connectedFolder?: string }): Promise<AmpleFileCliContextSnapshot>;
  listConnectedFolders(actor: AmpleFileCliActor, options: { connectedFolder?: string }): Promise<AmpleFileCliConnectedFolderSummary[]>;
  listTasks(actor: AmpleFileCliActor, options: { connectedFolder?: string }): Promise<AmpleFileCliTaskSummary[]>;
  listCapabilities(actor: AmpleFileCliActor, options: { connectedFolder?: string }): Promise<AmpleFileCliCapabilitySummary[]>;
}

export class AmpleFileCliError extends Error {
  readonly exitCode: AmpleFileCliExitCode;

  constructor(
    readonly code: AmpleFileCliErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "AmpleFileCliError";
    this.exitCode = AmpleFileCliExitCode[code];
  }
}

export function normalizeAmpleFileCliRequestId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new AmpleFileCliError("protocolError", "CLI request id must be a UUID.");
  }
  return normalized;
}

export function parseAmpleFileCliRequest(value: unknown): AmpleFileCliRequestV1 {
  const record = objectRecord(value, "CLI request must be a JSON object.");
  assertExactKeys(record, ["protocolVersion", "id", "argv", "cwd", "createdAt"], "CLI request");
  if (record.protocolVersion !== AMPLEFILE_CLI_PROTOCOL_VERSION) {
    throw new AmpleFileCliError(
      "protocolError",
      `Unsupported CLI protocol version: ${String(record.protocolVersion)}. Expected ${AMPLEFILE_CLI_PROTOCOL_VERSION}.`,
    );
  }
  if (typeof record.id !== "string") throw new AmpleFileCliError("protocolError", "CLI request id must be a string.");
  const id = normalizeAmpleFileCliRequestId(record.id);
  const argv = parseArgv(record.argv);
  if (typeof record.cwd !== "string" || !record.cwd.trim() || !isAbsolute(record.cwd)) {
    throw new AmpleFileCliError("protocolError", "CLI request cwd must be an absolute path.");
  }
  if (record.cwd.includes("\u0000")) throw new AmpleFileCliError("protocolError", "CLI request cwd contains an invalid character.");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new AmpleFileCliError("protocolError", "CLI request createdAt must be an ISO timestamp.");
  }
  return {
    protocolVersion: AMPLEFILE_CLI_PROTOCOL_VERSION,
    id,
    argv,
    cwd: resolve(record.cwd),
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

export function parseAmpleFileCliResponse(value: unknown): AmpleFileCliResponseV1 {
  const record = objectRecord(value, "CLI response must be a JSON object.");
  assertExactKeys(record, ["protocolVersion", "id", "exitCode", "stdout", "stderr", "result", "completedAt"], "CLI response", true);
  if (record.protocolVersion !== AMPLEFILE_CLI_PROTOCOL_VERSION) {
    throw new AmpleFileCliError("protocolError", `Unsupported CLI response protocol version: ${String(record.protocolVersion)}.`);
  }
  if (typeof record.id !== "string") throw new AmpleFileCliError("protocolError", "CLI response id must be a string.");
  const id = normalizeAmpleFileCliRequestId(record.id);
  if (!isAmpleFileCliExitCode(record.exitCode)) throw new AmpleFileCliError("protocolError", "CLI response exitCode is invalid.");
  if (typeof record.stdout !== "string" || typeof record.stderr !== "string") {
    throw new AmpleFileCliError("protocolError", "CLI response output must be text.");
  }
  if (record.completedAt !== undefined && (typeof record.completedAt !== "string" || !Number.isFinite(Date.parse(record.completedAt)))) {
    throw new AmpleFileCliError("protocolError", "CLI response completedAt must be an ISO timestamp.");
  }
  if (record.result !== undefined && !isAmpleFileCliJson(record.result)) {
    throw new AmpleFileCliError("protocolError", "CLI response result must be JSON-serializable.");
  }
  return {
    protocolVersion: AMPLEFILE_CLI_PROTOCOL_VERSION,
    id,
    exitCode: record.exitCode,
    stdout: record.stdout,
    stderr: record.stderr,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: new Date(record.completedAt).toISOString() } : {}),
  };
}

export function createAmpleFileCliRequest(input: {
  id: string;
  argv: string[];
  cwd: string;
  createdAt?: string;
}): AmpleFileCliRequestV1 {
  return parseAmpleFileCliRequest({
    protocolVersion: AMPLEFILE_CLI_PROTOCOL_VERSION,
    id: input.id,
    argv: input.argv,
    cwd: input.cwd,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function createAmpleFileCliResponse(input: Omit<AmpleFileCliResponseV1, "protocolVersion">): AmpleFileCliResponseV1 {
  return parseAmpleFileCliResponse({ protocolVersion: AMPLEFILE_CLI_PROTOCOL_VERSION, ...input });
}

/** Shared bounded argv validation for both protocol lanes. */
export function parseBoundedCliArgv(value: unknown): string[] {
  return parseArgv(value);
}

function parseArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AmpleFileCliError("protocolError", "CLI request argv must be an array of strings.");
  }
  if (value.length > AMPLEFILE_CLI_MAX_ARG_COUNT) {
    throw new AmpleFileCliError("protocolError", `CLI request has more than ${AMPLEFILE_CLI_MAX_ARG_COUNT} arguments.`);
  }
  const argv = value as string[];
  let total = 0;
  for (const argument of argv) {
    if (argument.includes("\u0000")) throw new AmpleFileCliError("protocolError", "CLI argument contains an invalid character.");
    if (argument.length > AMPLEFILE_CLI_MAX_ARG_LENGTH) {
      throw new AmpleFileCliError("protocolError", `CLI argument exceeds ${AMPLEFILE_CLI_MAX_ARG_LENGTH} characters.`);
    }
    total += argument.length;
  }
  if (total > AMPLEFILE_CLI_MAX_ARGV_LENGTH) {
    throw new AmpleFileCliError("protocolError", `CLI arguments exceed ${AMPLEFILE_CLI_MAX_ARGV_LENGTH} characters in total.`);
  }
  return [...argv];
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AmpleFileCliError("protocolError", message);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: string[],
  label: string,
  optional = false,
): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new AmpleFileCliError("protocolError", `${label} contains unsupported field: ${unexpected[0]}.`);
  if (optional) return;
  const missing = keys.filter((key) => !(key in record));
  if (missing.length) throw new AmpleFileCliError("protocolError", `${label} is missing required field: ${missing[0]}.`);
}

function isAmpleFileCliExitCode(value: unknown): value is AmpleFileCliExitCode {
  return typeof value === "number" && Object.values(AmpleFileCliExitCode).includes(value as AmpleFileCliExitCode);
}

function isAmpleFileCliJson(value: unknown): value is AmpleFileCliJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isAmpleFileCliJson);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((item) => item !== undefined && isAmpleFileCliJson(item));
}
