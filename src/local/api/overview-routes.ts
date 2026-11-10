/**
 * The AmpleFile Agent's overview (docs/amplefile-agent-overview.md): its routes and the
 * source readers the kernel composes the digest from.
 */

import { readFile } from "node:fs/promises";
import { listConversations, readConversation } from "../agent/chat-store.js";
import { ampleFileRequestStateToAgentPhase } from "../requests/request-records.js";
import { listConnectedFolderCheckpoints } from "../history.js";
import {
  createAmpleFileOverviewAutomationRunReader,
  parseAmpleFileOverviewCursor,
  ampleFileOverviewChatRecordFromMessages,
  type AmpleFileOverviewAgentRequestRecord,
  type AmpleFileOverviewSettledTurnRecord,
  type AmpleFileOverviewSourceReaders,
} from "../overview.js";
import { ampleFileAgentScopeId } from "../state-paths.js";
import type { AmpleFileCliActReceipt } from "../cli/act-receipts.js";
import { badRequest, readJsonBody, sendJson } from "./http.js";
import type { LocalApiRequest, LocalApiState } from "./state.js";

/** The AmpleFile Agent's overview and what a person has seen of it. */
export async function handleOverviewRoutes({ state, req, res, url, method }: LocalApiRequest): Promise<boolean> {
  // The overview (docs/amplefile-agent-overview.md): the app-composed digest for the popover
  // and the main window, on the renderer session. Deliberately no
  // management-readiness gate — the digest reads recorded state, not the
  // management Pi session, so it stays available even when management
  // commands fail closed; only narration needs the conversation.
  if (url.pathname === "/api/amplefile-agent/overview" && method === "GET") {
    sendJson(res, { overview: await state.kernel.getOverview({ kind: "renderer" }) });
    return true;
  }
  if (url.pathname === "/api/amplefile-agent/overview/seen" && method === "POST") {
    const body = await readJsonBody<{ surface?: unknown; cursor?: unknown }>(state, req);
    // The renderer lane advances only the two desktop surfaces, so one
    // surface can never acknowledge for another.
    if (body.surface !== "popover" && body.surface !== "main-window") {
      throw badRequest("The overview surface must be popover or main-window.");
    }
    if (typeof body.cursor !== "string" || !parseAmpleFileOverviewCursor(body.cursor)) {
      throw badRequest("A rendered overview cursor is required to mark seen.");
    }
    // Monotonic by construction: fetching never advances a marker, a replayed
    // or backward advance is a no-op, and a failed write only leaves items
    // rendering as new.
    sendJson(res, await state.overviewSeen.advance(body.surface, body.cursor));
    return true;
  }
  return false;
}

const maxOverviewConversationsPerConnectedFolder = 2_048;
const maxOverviewCheckpointsPerConnectedFolder = 256;
const maxOverviewActReceiptLines = 8_192;

/**
 * The overview's live-registry source readers (docs/amplefile-agent-overview.md): recorded
 * state only — the settled-turn records, the durable request graph
 * (docs/collaboration-contract.md), the
 * chat store and History per registered Connected Folder, the act-receipts ledger, and the automation receipts
 * journal. The kernel's own task registry supplies running tasks.
 */
export function createServerOverviewSources(state: LocalApiState): AmpleFileOverviewSourceReaders {
  const automationRunReader = createAmpleFileOverviewAutomationRunReader();
  return {
    settledTurns: async (): Promise<AmpleFileOverviewSettledTurnRecord[]> =>
      [...state.settledTurns.values()].map((turn) => ({
        taskId: turn.taskId,
        // The AmpleFile Agent scope is not a Connected Folder; its settled turns carry no
        // Connected Folder id instead of rendering as a removed Connected Folder.
        ...(turn.connectedFolderId === ampleFileAgentScopeId ? {} : { connectedFolderId: turn.connectedFolderId }),
        conversationId: turn.conversationId,
        outcome: turn.status,
        endedAt: turn.endedAt,
      })),
    ampleFileAgentRequests: () => overviewAmpleFileAgentRequestRecords(state),
    chats: async (connectedFolder) => {
      const summaries = await listConversations(connectedFolder.connectedFolderRoot);
      const records = [];
      for (const summary of summaries.slice(0, maxOverviewConversationsPerConnectedFolder)) {
        records.push(ampleFileOverviewChatRecordFromMessages(summary, await readConversation(connectedFolder.connectedFolderRoot, summary.id)));
      }
      return records;
    },
    checkpoints: async (connectedFolder) =>
      (await listConnectedFolderCheckpoints(connectedFolder.connectedFolderRoot, maxOverviewCheckpointsPerConnectedFolder)).map((checkpoint) => ({
        checkpointId: checkpoint.checkpointId,
        createdAt: checkpoint.createdAt,
        ...(checkpoint.label !== undefined ? { label: checkpoint.label } : {}),
        reason: checkpoint.reason,
        scope: checkpoint.scope,
      })),
    actReceipts: () => readActReceiptJournal(state),
    automationRuns: automationRunReader,
  };
}

/**
 * Request records for the overview, composed from the durable record alone.
 *
 * The overview recomposes on every call, from the popover and the main window,
 * so this path stays cheap: a record already carries its
 * state, its timestamps, its questions, and its results. Needs you is derived
 * from those records; rendering the overview never scans a transcript for a
 * question mark.
 */
async function overviewAmpleFileAgentRequestRecords(state: LocalApiState): Promise<AmpleFileOverviewAgentRequestRecord[]> {
  const records: AmpleFileOverviewAgentRequestRecord[] = [];
  for (const record of state.requests.list({ limit: maxOverviewRequestRecords })) {
    const newestTurn = record.turns.at(-1)!;
    const phase = ampleFileRequestStateToAgentPhase(record.state);
    const descendants = state.requests.subtree(record.requestId);
    const questions = state.requests.questions(record.requestId);
    records.push({
      requestId: record.requestId,
      kind: record.kind,
      state: record.state,
      taskId: newestTurn.taskId,
      conversationId: record.owner.conversationId,
      ...(record.owner.connectedFolderId ? { connectedFolderId: record.owner.connectedFolderId } : {}),
      phase,
      startedAt: record.createdAt,
      endedAt: phase === "working" || phase === "handed_off" ? null : (record.settledAt ?? newestTurn.settledAt),
      childTaskIds: descendants.flatMap((descendant) => descendant.turns.map((turn) => turn.taskId)),
      openQuestions: questions
        .filter((question) => question.state === "open")
        .map((question) => ({ questionId: question.questionId, respondent: question.respondent, askedAt: question.askedAt })),
      questionCount: questions.length,
      resultCount: record.results.length,
    });
  }
  return records;
}

const maxOverviewRequestRecords = 16_384;

/**
 * Tolerant bounded read of the act-receipts ledger for the overview: the same
 * live and rotated files the executor appends. A damaged line is omitted —
 * the overview is a projection, never the journal's authority.
 */
async function readActReceiptJournal(state: LocalApiState): Promise<AmpleFileCliActReceipt[]> {
  const receipts: AmpleFileCliActReceipt[] = [];
  for (const path of [state.actReceipts.rotatedPath, state.actReceipts.path]) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    const lines = text.split("\n").filter((line) => line.trim());
    for (const line of lines.slice(-maxOverviewActReceiptLines)) {
      try {
        const record = JSON.parse(line) as Partial<AmpleFileCliActReceipt>;
        // Version 3 is the version every act writes.
        if (record.v !== 3
          || typeof record.at !== "string"
          || typeof record.requestId !== "string"
          || typeof record.command !== "string"
          || typeof record.outcome !== "string") continue;
        receipts.push(record as AmpleFileCliActReceipt);
      } catch {
        // Omitted, never fatal.
      }
    }
  }
  return receipts.slice(-maxOverviewActReceiptLines);
}
