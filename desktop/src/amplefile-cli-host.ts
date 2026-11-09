import type { AmpleFileCliKernel } from "../../src/local/cli/protocol.js";
import { AMPLEFILE_CLI_REQUEST_MAX_AGE_MS, AmpleFileCliFileBroker } from "../../src/local/cli/broker.js";
import { executeAmpleFileCliRequest } from "../../src/local/cli/commands.js";
import {
  ampleFileCliActRunsOutsideQueue,
  executeAmpleFileCliActRequest,
  type AmpleFileCliActAuthority,
} from "../../src/local/cli/act-commands.js";
import { isAmpleFileCliActRequest } from "../../src/local/cli/act-protocol.js";
import { AmpleFileCliActReceipts } from "../../src/local/cli/act-receipts.js";
import { normalizeAmpleFileCliRequestId } from "../../src/local/cli/protocol.js";

const cliRequestArgument = "--amplefile-cli-request";

export interface AmpleFileCliInstanceData {
  kind: "amplefile-cli";
  requestId: string;
}

export interface AmpleFileDesktopCliHostOptions {
  stateRoot: string;
  kernel: AmpleFileCliKernel;
  version: string;
  productName?: string;
  /** How long an act may wait in the serial queue before it is refused; defaults to the broker freshness window. */
  maxQueuedMs?: number;
  /** Act-lane authority; null while the interactive local API is not running. */
  getActFacade?: () => AmpleFileCliActAuthority | null;
  /** Validates explicit management-turn lineage for act receipts. */
  resolveLineageParent?: (taskId: string) => { taskId: string } | null;
}

/**
 * Desktop-owned bridge between the stable request-file protocol and the
 * reusable AmpleFile kernel. Every request is claimed as soon as it arrives,
 * so the broker judges its freshness on arrival rather than after it waited
 * in line. Execution is then serialized so catalog discovery and task
 * snapshots never race one another inside a single desktop host. Act-lane
 * requests dispatch to the act executor, which only accepts the queue entry
 * itself — a long turn runs detached inside the interactive API, so it never
 * blocks later status polls. An act that reaches the front of the queue
 * after the broker's freshness window is refused without running, so a
 * caller that gave up never sees it land late. The few act verbs that
 * legitimately take minutes
 * (`ampleFileCliActRunsOutsideQueue`) run beside the queue instead of in it,
 * so one `jobs output --wait` or `chat compact` never stalls every other
 * `amplefile` command.
 */
export class AmpleFileDesktopCliHost {
  readonly broker: AmpleFileCliFileBroker;
  readonly receipts: AmpleFileCliActReceipts;
  readonly #kernel: AmpleFileCliKernel;
  readonly #version: string;
  readonly #productName: string;
  readonly #getActFacade: () => AmpleFileCliActAuthority | null;
  readonly #resolveLineageParent: (taskId: string) => { taskId: string } | null;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #pending = new Set<Promise<void>>();
  readonly #maxQueuedMs: number;

  constructor(options: AmpleFileDesktopCliHostOptions) {
    this.broker = new AmpleFileCliFileBroker({ stateRoot: options.stateRoot });
    this.receipts = new AmpleFileCliActReceipts({ stateRoot: options.stateRoot });
    this.#kernel = options.kernel;
    this.#version = options.version;
    this.#productName = options.productName ?? "AmpleFile";
    this.#getActFacade = options.getActFacade ?? (() => null);
    this.#resolveLineageParent = options.resolveLineageParent ?? (() => null);
    this.#maxQueuedMs = options.maxQueuedMs ?? AMPLEFILE_CLI_REQUEST_MAX_AGE_MS;
  }

  async initialize(): Promise<void> {
    await this.broker.initialize();
    await this.broker.cleanup();
  }

  processRequest(requestId: string): Promise<void> {
    const id = normalizeAmpleFileCliRequestId(requestId);
    const operation = this.broker.processRequest(id, (request) => {
      if (isAmpleFileCliActRequest(request)) {
        const execute = (queued: boolean) => executeAmpleFileCliActRequest(request, {
          version: this.#version,
          productName: this.#productName,
          getActFacade: this.#getActFacade,
          receipts: this.receipts,
          resolveLineageParent: this.#resolveLineageParent,
          // A queued act that reaches the front after the broker's freshness
          // window is refused, as it was when it could not be claimed that
          // late: the shim (30 minutes by default) is still waiting, so the
          // caller learns the outcome instead of retrying into a double effect.
          ...(queued ? { maxQueuedMs: this.#maxQueuedMs } : {}),
        });
        return ampleFileCliActRunsOutsideQueue(request.argv) ? execute(false) : this.#serialize(() => execute(true));
      }
      return this.#serialize(() => executeAmpleFileCliRequest(request, this.#kernel, {
        version: this.#version,
        productName: this.#productName,
      }));
    }).then(() => undefined);
    this.#pending.add(operation);
    void operation.catch(() => undefined).finally(() => this.#pending.delete(operation));
    return operation;
  }

  /** Resolves only after every request observed so far has completed. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  #serialize<T>(execute: () => Promise<T>): Promise<T> {
    const operation = this.#queue.catch(() => undefined).then(execute);
    this.#queue = operation;
    return operation;
  }
}

export type AmpleFileSecondInstanceIntent =
  | { kind: "cli"; requestId: string }
  | { kind: "cli-invalid"; reason: string }
  | { kind: "inspect-context" }
  | { kind: "gui" };

/**
 * Classifies a second-instance launch by cause. Only a genuine interactive
 * relaunch may surface or focus the window — docs/product-model.md: a headless
 * CLI request must coexist with the running desktop app and avoid opening or
 * stealing focus from the interactive window. The shim relaunches this
 * executable for every request, so any launch that carries CLI shape —
 * instance data stamped "amplefile-cli", or the request argument in argv —
 * stays headless even when its request id is missing or mangled in transit.
 */
export function ampleFileSecondInstanceIntent(
  argv: readonly string[],
  additionalData: unknown,
): AmpleFileSecondInstanceIntent {
  try {
    const requestId = ampleFileCliRequestIdFromInstanceData(additionalData) ?? ampleFileCliRequestIdFromArgv(argv);
    if (requestId) return { kind: "cli", requestId };
  } catch (error) {
    return { kind: "cli-invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  if (isCliShapedLaunch(argv, additionalData)) {
    return { kind: "cli-invalid", reason: "The CLI launch carried no usable request id." };
  }
  if (ampleFileInspectContextFromArgv(argv) || (additionalData && typeof additionalData === "object"
    && (additionalData as Record<string, unknown>).kind === "amplefile-inspect-context")) {
    return { kind: "inspect-context" };
  }
  return { kind: "gui" };
}

export function ampleFileInspectContextFromArgv(argv: readonly string[]): boolean {
  return argv.includes("--amplefile-inspect-context");
}

function isCliShapedLaunch(argv: readonly string[], additionalData: unknown): boolean {
  if (additionalData && typeof additionalData === "object" && !Array.isArray(additionalData)
    && (additionalData as Record<string, unknown>).kind === "amplefile-cli") {
    return true;
  }
  return argv.some((argument) => argument === cliRequestArgument || argument.startsWith(`${cliRequestArgument}=`));
}

export function ampleFileCliRequestIdFromArgv(argv: readonly string[]): string | null {
  let requestId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    let candidate: string | null = null;
    if (argument === cliRequestArgument) {
      candidate = argv[index + 1] ?? "";
      index += 1;
    } else if (argument.startsWith(`${cliRequestArgument}=`)) {
      candidate = argument.slice(cliRequestArgument.length + 1);
    }
    if (candidate === null) continue;
    if (requestId !== null) throw new Error(`${cliRequestArgument} may be provided only once.`);
    requestId = normalizeAmpleFileCliRequestId(candidate);
  }
  return requestId;
}

export function ampleFileCliRequestIdFromInstanceData(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "amplefile-cli" || typeof record.requestId !== "string") return null;
  return normalizeAmpleFileCliRequestId(record.requestId);
}

export function ampleFileCliInstanceData(requestId: string | null, inspectContext = false): AmpleFileCliInstanceData | { kind: "amplefile-gui" | "amplefile-inspect-context" } {
  return requestId
    ? { kind: "amplefile-cli", requestId: normalizeAmpleFileCliRequestId(requestId) }
    : { kind: inspectContext ? "amplefile-inspect-context" : "amplefile-gui" };
}
