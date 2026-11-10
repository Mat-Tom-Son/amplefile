/**
 * Background jobs (docs/background-jobs.md): the host side of the job
 * service. What a job means for its request, the kernel, History, the Chat
 * that started it, and the one follow-up turn its end may start.
 */

import {
  AmpleFileRequestLimitError,
  AmpleFileRequestLineageError,
  type AmpleFileRequestJobState,
  type AmpleFileRequestRecord,
} from "../requests/request-records.js";
import {
  describeJobHistory,
  describeJobState,
  isAmpleFileJobTerminalState,
  AmpleFileJobLimitError,
  AmpleFileJobNotFoundError,
  type AmpleFileJobHistory,
  type AmpleFileJobRecord,
} from "../jobs/job-records.js";
import { describeJobOutputRead, fenceJobOutput } from "../jobs/job-output.js";
import { AmpleFileJobService, type AmpleFileJobShell } from "../jobs/job-service.js";
import { AmpleFileJobStore } from "../jobs/job-store.js";
import type { BackgroundJobToolHost } from "../agent/job-tools.js";
import { connectedFolderTurnHistory } from "../agent/connected-folder-turn-context.js";
import { createConnectedFolderCheckpoint } from "../history.js";
import { ampleFileAgentScopeId } from "../state-paths.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import type { AmpleFileActJobRef } from "../cli/act-facade.js";
import { getConnectedFolder, type ConnectedFolderSummary } from "../connected-folder.js";
import { errorMessage } from "./http.js";
import { clampUtf8, collaborationRefusal } from "./request-records.js";
import { evaluateRequestGraphSettle } from "./request-routes.js";
import type { LocalApiState } from "./state.js";

const maxJobsRememberedThisRun = 4_000;

export function createBackgroundJobService(state: LocalApiState, store: AmpleFileJobStore): AmpleFileJobService {
  return new AmpleFileJobService({
    store,
    ports: {
      // Journal-first in both records: the request knows about the job before
      // its process exists, and a stopped request refuses it.
      beforeSpawn: async (job) => {
        await state.requests.noteJobStarted({ taskId: job.taskId, jobId: job.jobId, name: job.name, startedAt: job.createdAt, ...(job.service ? { service: true } : {}) });
        state.kernel.startExperimentalJobTask({
          jobId: job.jobId,
          name: job.name,
          conversationId: job.conversationId,
          ...(job.connectedFolderId ? { connectedFolderId: job.connectedFolderId } : {}),
          actor: { kind: job.surface === "cli" ? "cli" : "assistant" },
        });
      },
      stopRequested: (job) => Boolean(state.requests.byJobId(job.jobId)?.stopRequestedAt),
      captureHistory: (job) => captureBackgroundJobHistory(job),
      afterSettle: (job) => {
        state.kernel.finishTask(job.jobId);
        if (!job.service) queueBackgroundJobSettle(state, job);
        else void settleBackgroundJobOnRequest(state, job);
      },
    },
  });
}

function requestJobState(jobState: AmpleFileJobRecord["state"]): Exclude<AmpleFileRequestJobState, "running"> {
  return jobState === "accepted" || jobState === "running" ? "interrupted" : jobState;
}

/** The turn's own checkpoint came before the job ended; this one covers its later writes. */
async function captureBackgroundJobHistory(job: AmpleFileJobRecord): Promise<AmpleFileJobHistory> {
  if (!job.connectedFolderId) return { status: "not_applicable", reason: "the AmpleFile Agent's working folder has no History." };
  let connectedFolder: ConnectedFolderSummary;
  try {
    connectedFolder = await getConnectedFolder(job.connectedFolderId);
  } catch {
    return { status: "unavailable", reason: "its Connected Folder is no longer registered." };
  }
  const checkpoint = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, {
    reason: "background_job",
    label: `After background job: ${job.name}`,
  });
  const summary = connectedFolderTurnHistory(checkpoint);
  return summary.status === "captured" ? summary : { status: "unavailable", reason: "History could not save a checkpoint." };
}

/**
 * On the request settle chain: decide the follow-up first, then settle the
 * job on its request. A reserved follow-up keeps the request working, so it
 * never reads done between a job's end and the turn that reports it.
 */
function queueBackgroundJobSettle(state: LocalApiState, job: AmpleFileJobRecord): void {
  state.jobsSettledThisRun.add(job.jobId);
  while (state.jobsSettledThisRun.size > maxJobsRememberedThisRun) {
    const oldest = state.jobsSettledThisRun.values().next().value;
    if (oldest === undefined) break;
    state.jobsSettledThisRun.delete(oldest);
  }
  state.requestSettleChain = state.requestSettleChain
    .then(() => evaluateRequestGraphSettle(state, job.taskId))
    .catch((error: unknown) => {
      console.error(`A background job's follow-up could not be evaluated: ${errorMessage(error)}`);
    })
    .then(() => settleBackgroundJobOnRequest(state, job));
}

export async function settleBackgroundJobOnRequest(state: LocalApiState, job: AmpleFileJobRecord): Promise<void> {
  await state.requests.settleJob(job.jobId, {
    state: requestJobState(job.state),
    exitCode: job.exitCode,
    ...(job.settledAt ? { settledAt: job.settledAt } : {}),
  }).catch((error: unknown) => console.error(`A background job's end could not reach its request: ${errorMessage(error)}`));
}

/** Finished jobs of this request whose end has not reached its Chat, settled in this run only. */
export function undeliveredSettledJobs(state: LocalApiState, request: AmpleFileRequestRecord): AmpleFileJobRecord[] {
  const delivered = new Set(request.deliveredJobIds ?? []);
  // The job journal decides "ended"; the request's own reference settles
  // after this decision (queueBackgroundJobSettle).
  return (request.jobs ?? []).flatMap((ref) => {
    if (ref.service) return [];
    if (delivered.has(ref.jobId) || !state.jobsSettledThisRun.has(ref.jobId)) return [];
    const job = state.jobs.get(ref.jobId);
    return job && isAmpleFileJobTerminalState(job.state) && job.settledAt && !job.delivery ? [job] : [];
  });
}

/** One delivery per job's end, recorded in the job journal and on its request. */
export async function deliverBackgroundJobs(
  state: LocalApiState,
  jobs: readonly AmpleFileJobRecord[],
  by: "read" | "turn_context" | "follow_up",
  taskId: string | null,
): Promise<void> {
  for (const job of jobs) {
    await state.jobs.markDelivered(job.jobId, by, taskId).catch(() => null);
    await state.requests.noteJobDelivery(job.requestId, [job.jobId]).catch(() => undefined);
  }
}

/** Each finished job's state, History, and the end of its output, for a follow-up message. */
export async function composeBackgroundJobLines(state: LocalApiState, jobs: readonly AmpleFileJobRecord[]): Promise<string[]> {
  const lines: string[] = [];
  const now = new Date();
  for (const job of jobs) {
    const { output } = await state.jobs.read(job.jobId);
    const command = job.command.split("\n", 1)[0]!;
    lines.push(
      `- Background job ${job.jobId} ${JSON.stringify(job.name)} — ${describeJobState(job, now)}`,
      `  command: ${clampUtf8(command, 2_000)}${job.command.includes("\n") ? " …" : ""}`,
      `  ${describeJobHistory(job.history)}`,
      `  ${describeJobOutputRead(output)}${output.text && output.truncated ? " The end follows." : ""}`,
    );
    if (output.text) lines.push("", fenceJobOutput(output.text), "");
  }
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The jobs a new turn's context names: this Chat's running jobs, and ones
 * that finished in this run without reaching the Chat yet, which this turn
 * now delivers. Delivery reserved by a follow-up is respected.
 */
export async function backgroundJobsForTurn(
  state: LocalApiState,
  connectedFolderId: string,
  conversationId: string,
  taskId: string,
): Promise<NonNullable<import("../agent/pi-client.js").PiTurnContext["backgroundJobs"]>> {
  const jobs = state.jobs.list({ connectedFolderId: connectedFolderId === ampleFileAgentScopeId ? null : connectedFolderId, conversationId });
  if (!jobs.length) return [];
  const now = new Date();
  const ending = jobs.filter((job) => !isAmpleFileJobTerminalState(job.state) || job.settledAt === null);
  const finished = jobs.filter((job) => isAmpleFileJobTerminalState(job.state) && job.settledAt !== null && !job.delivery
    && state.jobsSettledThisRun.has(job.jobId)
    && !(state.requests.get(job.requestId)?.deliveredJobIds ?? []).includes(job.jobId));
  await deliverBackgroundJobs(state, finished, "turn_context", taskId);
  return [
    ...ending.map((job) => ({ jobId: job.jobId, name: job.name, status: describeJobState(job, now), finished: false })),
    ...finished.map((job) => ({ jobId: job.jobId, name: job.name, status: describeJobState(job, now), finished: true })),
  ];
}

/**
 * Starts a job for a running turn, through the tools or the CLI, and
 * attributes the act to that turn's request. Both surfaces end up here.
 */
export async function startBackgroundJob(state: LocalApiState, input: {
  interactive?: boolean;
  service?: boolean;
  taskId: string;
  command: string;
  name?: string;
  cwd: string;
  timeoutSeconds?: number;
  surface: "tool" | "cli";
  shell?: AmpleFileJobShell;
}): Promise<AmpleFileJobRecord> {
  const request = state.requests.byTaskId(input.taskId);
  if (!request || !state.requests.isAccepting(input.taskId)) {
    throw new AmpleFileRequestLineageError("A background job starts only from a running turn of its own request.");
  }
  const job = await state.jobs.start({
    owner: {
      conversationId: request.owner.conversationId,
      ...(request.owner.connectedFolderId ? { connectedFolderId: request.owner.connectedFolderId } : {}),
      ...(request.owner.connectedFolderName ? { connectedFolderName: request.owner.connectedFolderName } : {}),
    },
    taskId: input.taskId,
    requestId: request.requestId,
    command: input.command,
    ...(input.interactive ? { interactive: true } : {}),
    ...(input.service ? { service: true } : {}),
    ...(input.name ? { name: input.name } : {}),
    cwd: input.cwd,
    ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
    surface: input.surface,
    ...(input.shell ? { shell: input.shell } : {}),
  });
  await state.requests.recordAction(input.taskId, {
    command: "jobs.start",
    at: new Date().toISOString(),
    ...(request.owner.connectedFolderId ? { connectedFolderId: request.owner.connectedFolderId } : {}),
    ...(request.owner.connectedFolderName ? { connectedFolderName: request.owner.connectedFolderName } : {}),
    conversationId: request.owner.conversationId,
    taskId: input.taskId,
  }).catch(() => null);
  return job;
}

/** Stops one job and attributes the stop to the turn that asked, when one did. */
export async function stopBackgroundJob(state: LocalApiState, jobId: string, cause: "agent" | "cli", taskId?: string): Promise<AmpleFileJobRecord> {
  const job = await state.jobs.stop(jobId, cause);
  if (taskId) {
    await state.requests.recordAction(taskId, {
      command: "jobs.stop",
      at: new Date().toISOString(),
      ...(job.connectedFolderId ? { connectedFolderId: job.connectedFolderId } : {}),
      ...(job.connectedFolderName ? { connectedFolderName: job.connectedFolderName } : {}),
      conversationId: job.conversationId,
      taskId: job.taskId,
    }).catch(() => null);
  }
  return job;
}

/** A job addressed through a Connected Folder must belong to it. */
export function ownedJob(state: LocalApiState, connectedFolderId: string, jobId: string): AmpleFileJobRecord {
  const job = state.jobs.get(jobId.trim());
  if (!job || job.connectedFolderId !== connectedFolderId) {
    throw new AmpleFileCliError("notFound", `That background job is not on record in this Connected Folder. Finished jobs are kept for ${state.requests.retentionDays()} days.`);
  }
  return job;
}

/** Job refusals keep their own sentences: a bound is a conflict, an unknown job is not found. */
export async function runJobOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AmpleFileCliError) throw error;
    if (error instanceof AmpleFileJobLimitError) throw new AmpleFileCliError("conflict", error.message, { cause: error });
    if (error instanceof AmpleFileJobNotFoundError) throw new AmpleFileCliError("notFound", error.message, { cause: error });
    if (error instanceof AmpleFileRequestLimitError || error instanceof AmpleFileRequestLineageError) throw collaborationRefusal(error);
    const message = errorMessage(error);
    if (/needs a command|does not exist|timeout must|command can be at most|NUL character/.test(message)) {
      throw new AmpleFileCliError("usage", message, { cause: error });
    }
    throw new AmpleFileCliError("failure", message, { cause: error });
  }
}

export function toActJobRef(job: AmpleFileJobRecord): AmpleFileActJobRef {
  return {
    jobId: job.jobId,
    name: job.name,
    command: job.command,
    ...(job.interactive ? { interactive: true } : {}),
    ...(job.service ? { service: true } : {}),
    cwd: job.cwd,
    state: job.state,
    status: describeJobState(job, new Date()),
    conversationId: job.conversationId,
    taskId: job.taskId,
    requestId: job.requestId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    stoppedBy: job.stoppedBy,
    error: job.error,
    timeoutSeconds: job.timeoutSeconds,
    output: { ...job.output },
    history: job.history ? structuredClone(job.history) : null,
    delivery: job.delivery ? { ...job.delivery } : null,
  };
}

/** job_start, job_output, and job_stop for one Chat: jobs of this scope only. */
export function createBackgroundJobToolHost(state: LocalApiState, scopeId: string, conversationId: string): BackgroundJobToolHost {
  const connectedFolderId = scopeId === ampleFileAgentScopeId ? undefined : scopeId;
  const owned = (jobId: string): AmpleFileJobRecord => {
    const job = state.jobs.get(jobId);
    if (!job || (job.connectedFolderId ?? null) !== (connectedFolderId ?? null)) {
      throw new AmpleFileJobNotFoundError(connectedFolderId
        ? "That background job is not on record in this Connected Folder."
        : "That background job is not one of the AmpleFile Agent's.");
    }
    return job;
  };
  return {
    start: (input) => startBackgroundJob(state, { ...input, surface: "tool" }),
    input: async ({ taskId, jobId, text, eof }) => {
      owned(jobId);
      if (!state.requests.isAccepting(taskId)) throw new Error("Terminal input requires your own running turn.");
      await state.requests.recordAction(taskId, { command: "jobs.input", at: new Date().toISOString(), ...(connectedFolderId ? { connectedFolderId } : {}), conversationId, taskId });
      return state.jobs.input(jobId, text, eof);
    },
    list: () => ({
      here: state.jobs.list({ connectedFolderId: connectedFolderId ?? null, conversationId }),
      elsewhere: state.jobs.list({ connectedFolderId: connectedFolderId ?? null, running: true }).filter((job) => job.conversationId !== conversationId),
    }),
    read: async ({ taskId, jobId, offset, limit }) => {
      owned(jobId);
      const result = await state.jobs.read(jobId, { ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) });
      // Reading a finished job in its own Chat is its delivery; no follow-up repeats it.
      if (result.job.conversationId === conversationId && isAmpleFileJobTerminalState(result.job.state) && result.job.settledAt) {
        await deliverBackgroundJobs(state, [result.job], "read", taskId);
      }
      return result;
    },
    wait: ({ jobId, ...rest }) => {
      owned(jobId);
      return state.jobs.wait(jobId, rest);
    },
    stop: async ({ taskId, jobId }) => {
      owned(jobId);
      return await stopBackgroundJob(state, jobId, "agent", taskId);
    },
  };
}
