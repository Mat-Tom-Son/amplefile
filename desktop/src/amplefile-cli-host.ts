import type { AmpleFileCliKernel } from "../../src/local/cli/protocol.js";
import { AMPLEFILE_CLI_REQUEST_MAX_AGE_MS, AmpleFileCliFileBroker } from "../../src/local/cli/broker.js";
import { executeAmpleFileCliRequest } from "../../src/local/cli/commands.js";
import {
  ampleFileCliActRequestIdOf,
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
  /** The act executor's clock, which judges that wait; replaceable in tests. */
  now?: () => Date;
  /** Act-lane authority; null while the interactive local API is not running. */
  getActFacade?: () => AmpleFileCliActAuthority | null;
  /** Validates explicit management-turn lineage for act receipts. */
  resolveLineageParent?: (taskId: string) => { taskId: string } | null;
  /**
   * How old an answer nobody read may get before the host removes it;
   * defaults to the broker freshness window. A shim removes its own answer
   * as soon as it reads it, so this only catches the answer of a command
   * that was stopped while it waited.
   */
  unreadAnswerMaxAgeMs?: number;
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
 * `amplefile` command; so does `receipts show`, which a caller that stopped
 * waiting asks about an act that may still be in line.
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
  readonly #unreadAnswerMaxAgeMs: number;
  readonly #now: (() => Date) | undefined;

  constructor(options: AmpleFileDesktopCliHostOptions) {
    this.broker = new AmpleFileCliFileBroker({ stateRoot: options.stateRoot });
    this.receipts = new AmpleFileCliActReceipts({ stateRoot: options.stateRoot });
    this.#kernel = options.kernel;
    this.#version = options.version;
    this.#productName = options.productName ?? "AmpleFile";
    this.#getActFacade = options.getActFacade ?? (() => null);
    this.#resolveLineageParent = options.resolveLineageParent ?? (() => null);
    this.#maxQueuedMs = options.maxQueuedMs ?? AMPLEFILE_CLI_REQUEST_MAX_AGE_MS;
    this.#unreadAnswerMaxAgeMs = options.unreadAnswerMaxAgeMs ?? AMPLEFILE_CLI_REQUEST_MAX_AGE_MS;
    this.#now = options.now;
  }

  async initialize(): Promise<void> {
    await this.broker.initialize();
    // Unread answers an earlier run of the app left behind go now, once they
    // are past the age a live command could still be about to read them.
    await this.broker.cleanup({ answersOlderThanMs: this.#unreadAnswerMaxAgeMs });
    // An answer still younger than that at start (a quick restart, such as
    // an update's) goes once it reaches that age in this run, not at some
    // later start.
    const later = setTimeout(() => {
      void this.broker.cleanup({ answersOlderThanMs: this.#unreadAnswerMaxAgeMs }).catch(() => undefined);
    }, this.#unreadAnswerMaxAgeMs + 1_000);
    later.unref?.();
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
          pendingRequest: (id) => this.pendingRequest(id),
          resolveLineageParent: this.#resolveLineageParent,
          ...(this.#now ? { now: this.#now } : {}),
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
    }).then(() => {
      // The waiting shim reads its answer and removes it within moments. One
      // that was stopped first never will, so the answer goes once it is old
      // enough that no live command could still be about to read it.
      const removal = setTimeout(() => {
        void this.broker.removeAnswer(id, this.#unreadAnswerMaxAgeMs).catch(() => undefined);
      }, this.#unreadAnswerMaxAgeMs + 1_000);
      removal.unref?.();
    });
    this.#pending.add(operation);
    void operation.catch(() => undefined).finally(() => this.#pending.delete(operation));
    return operation;
  }

  /**
   * The tries of one act this host holds and has not answered, for
   * `receipts show`: requests whose act id (their --request-id, else their
   * own id) is `actId`, waiting to be claimed or taken up and perhaps still
   * in line. By `decideBy` every one of them has run or been refused,
   * whichever window applies — the broker's for a request not yet claimed,
   * the queue's for one waiting in line.
   */
  async pendingRequest(actId: string): Promise<{ processing: boolean; decideBy: string } | null> {
    const tries = (await this.broker.heldRequests())
      .filter((held) => (ampleFileCliActRequestIdOf(held.argv) ?? held.id) === actId);
    if (!tries.length) return null;
    const windowMs = Math.max(this.broker.maxRequestAgeMs, this.#maxQueuedMs);
    const latest = Math.max(...tries.map((held) => held.writtenAt.getTime()));
    return { processing: tries.some((held) => held.processing), decideBy: new Date(latest + windowMs).toISOString() };
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
