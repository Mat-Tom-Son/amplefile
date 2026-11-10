/**
 * The act facade: the CLI act lane's in-process authority over the same
 * internals the routes use.
 */

import { prepareResourceEnable } from "../agent/resource-enable-act.js";
import { randomUUID } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  createConversation,
  listConversations,
  readConversation,
  readConversationSummary,
  renameConversation,
  updateConversationLifecycle,
  type ConversationSummary,
} from "../agent/chat-store.js";
import { piSkillBundleContentDigest, type PiSkillBundleImportResult } from "../agent/skill-import.js";
import { normalizeWorkerInstructions } from "../agent/model-preferences.js";
import {
  getPiWorkerInstructions,
  getPiSetupStatus,
  isPiProjectMutationTrusted,
  listPiModels,
  listPiPackages,
  removePiPackage,
  resolvePiRuntime,
  setPiDefaultModel,
} from "../agent/pi-runtime-config.js";
import { AmpleFileRequestLineageError, ampleFileAnswerMatchesRecorded, type AmpleFileQuestionRecord } from "../requests/request-records.js";
import { isAmpleFileJobTerminalState } from "../jobs/job-records.js";
import type { AmpleFileJobShell } from "../jobs/job-service.js";
import { parseUntilPattern } from "../agent/job-tools.js";
import {
  createConnectedFolderCheckpoint,
  createConnectedFolderMutationCheckpoint,
  listConnectedFolderCheckpoints,
  listConnectedFolderCheckpointPage,
  listFileVersionPage,
  restoreFileVersion,
  restoreConnectedFolderCheckpoint,
} from "../history.js";
import { compareHistoryFile, readHistoryFile } from "../history-review.js";
import { searchConnectedFolder } from "../search.js";
import {
  applyConnectedFolderAppearanceParts,
  resolveConnectedFolderAppearanceParts,
  connectedFolderAppearancePartsLabel,
  ConnectedFolderAppearancePartsError,
} from "../connected-folder-appearance-parts.js";
import {
  hasConnectedFolderAppearanceCustomization,
  type ConnectedFolderAppearanceCustomization,
} from "../../shared/connected-folder-appearance.js";
import { prepareAct, type PreparedActFields, type PreparedActKind } from "../prepared-acts.js";
import { ampleFileAutomationReferencedConnectedFolderIds } from "../automations/automation-declarations.js";
import { ampleFileAgentRoot, ampleFileAgentScopeId } from "../state-paths.js";
import { ampleFileRecentlyDeletedEntryIdPattern } from "../recently-deleted-store.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import type { AmpleFileActFacade, AmpleFileActRecentlyDeletedEntry } from "../cli/act-facade.js";
import { resolveAmpleFileCliConnectedFolderSelector } from "../amplefile-cli-adapter.js";
import {
  createConnectedFolderFolder,
  createConnectedFolderTextFile,
  getConnectedFolder,
  listConnectedFolders,
  moveConnectedFolderEntry,
  renameConnectedFolderEntry,
  renameConnectedFolder,
  resolveConnectedFolderPath,
  type ConnectedFolderRemovalResult,
  type ConnectedFolderSummary,
} from "../connected-folder.js";
import {
  appearanceCustomizationRef,
  appearanceCustomizationsEqual,
  capabilityResourceSummary,
  classifyActAmpleFileAgentAttachments,
  enumerateSkillBundleNames,
  npmSourceIdentity,
  readConnectedFolderAppearanceProposalFile,
  recordFacadeAction,
  recordLandedAction,
  runActOperation,
  splitActEntryPath,
  toActChatLifecycleState,
  toActCheckpointSummary,
  toActConnectedFolderRef,
  toActConversationRef,
  toActFileVersionRef,
} from "./act-support.js";
import { saveWorkerInstructions } from "./ai-model-routes.js";
import {
  ampleFileAgentRequestView,
  ampleFileAgentScope,
  ampleFileAgentScopeForRoutes,
  assertAmpleFileAgentInstructionsReady,
  assertAmpleFileAgentParentAccepting,
  resolveAmpleFileAgentConversation,
} from "./amplefile-agent-routes.js";
import { readAutomationReceiptProjection, toActAutomationFilesSource, toActAutomationSummary } from "./automation-receipts.js";
import { enableStoredAutomationDeclaration, readAutomationStagingFile } from "./automation-settings.js";
import {
  createBackgroundJobToolHost,
  deliverBackgroundJobs,
  ownedJob,
  runJobOperation,
  startBackgroundJob,
  stopBackgroundJob,
  toActJobRef,
} from "./background-jobs.js";
import { copyConversation, runConversationMutation } from "./chat-routes.js";
import {
  createConnectedFolderInternal,
  registerConnectedFolderInternal,
  removeConnectedFolderRegistrationInternal,
} from "./connected-folder-routes.js";
import { createWorktreeToolHost, getClient, refreshClientIfMarked } from "./conversation-clients.js";
import { broadcast, publishControlHint } from "./event-streams.js";
import { addExternalFilesInternal, deleteConnectedFolderEntryWithRecovery, normalizeConnectedFolderRelativePath } from "./file-changes.js";
import { errorMessage } from "./http.js";
import { type PreparedActOutcome, runPreparedActOperation } from "./prepared-act-adapters.js";
import { recentlyDeletedEntryView, restoreRecentlyDeletedEntry } from "./recently-deleted-routes.js";
import {
  assertCallerHandedWorkTo,
  assertCallerTurn,
  assertOwnTask,
  assertRequestsAboveConnectedFolders,
  collaborationRefusal,
  conversationResultForScope,
  readReportDataFile,
  requestDetailView,
  requestLimitRefusalMessage,
  requestSummaryView,
  resolveHandoffSource,
  resolveReportFiles,
  toActQuestionRef,
  toActRequestRef,
  toActRequestRefForConnectedFolder,
  turnResultForScope,
  turnStatusFor,
  waitingRefForTask,
} from "./request-records.js";
import { queueConversationRequestEvaluation, stopAmpleFileAgentRequest } from "./request-routes.js";
import { assertNoCapabilityMutationForTurn, runCapabilityMutation, runHistoryRestore, runWithHistorySafety } from "./reservations.js";
import { clientKey, conversationRuntimeState, type LocalApiState, streamKey } from "./state.js";
import { acceptConversationTurn, steerConversationTurn } from "./turn-acceptance.js";

/**
 * The act facade is the CLI act lane's in-process authority. Every method
 * reuses the same route internals as the renderer (turn acceptance, trust
 * grants, History-checkpointed additions), so a CLI-initiated action obeys
 * identical conflict, trust, and persistence rules. Registering a folder
 * through the act lane deliberately has no renderer folder-picker grant:
 * possession of the per-launch act token is that caller's authorization.
 */
export function createAmpleFileActFacade(state: LocalApiState): AmpleFileActFacade {
  const resolveConnectedFolder = async (selector: string): Promise<ConnectedFolderSummary> => {
    const resolved = resolveAmpleFileCliConnectedFolderSelector(await listConnectedFolders(), selector.trim() || undefined);
    if (!resolved) throw new AmpleFileCliError("usage", "Act commands require an explicit --connected-folder <id-or-name>.");
    return resolved;
  };
  /**
   * Per–Connected Folder appearance undo slot for this app run: the customization a
   * receipted appearance act displaced and the customization it left in
   * place. `connected-folders appearance undo` swaps them; a desktop-side change makes
   * the recorded slot stale, which the equality check below turns into a
   * typed refusal instead of restoring a state the receipt never described.
   */
  const appearanceUndoSlots = new Map<string, {
    displaced: ConnectedFolderAppearanceCustomization | null;
    result: ConnectedFolderAppearanceCustomization | null;
  }>();
  const currentAppearanceCustomization = (connectedFolderId: string): ConnectedFolderAppearanceCustomization | null =>
    state.appearance.snapshot().customizations[connectedFolderId] ?? null;
  /** The conversation PATCH route's 409s, mapped to CLI conflict errors. */
  const assertChatMutable = (connectedFolderId: string, conversationId: string): void => {
    const key = clientKey(connectedFolderId, conversationId);
    if (state.runningTurns.has(key)) {
      throw new AmpleFileCliError("conflict", "Wait for the current turn to finish.");
    }
    if (state.compactingConversations.has(key)) {
      throw new AmpleFileCliError("conflict", "Wait for the current Chat compaction to finish.");
    }
  };
  const requireConversationSummary = async (
    connectedFolderRoot: string,
    conversationId: string,
  ): Promise<ConversationSummary> => {
    const summary = await runActOperation(() => readConversationSummary(connectedFolderRoot, conversationId));
    if (!summary) throw new AmpleFileCliError("notFound", "Conversation not found.");
    return summary;
  };
  const chatAsk = async (connectedFolder: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">, input: Omit<Parameters<AmpleFileActFacade["chatAsk"]>[0], "connectedFolder">) => {
    assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
    const taskId = input.taskId.trim();
    if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <own-task-id>.");
    return runActOperation(async () => {
      const record = assertOwnTask(state, connectedFolder.id, taskId);
      // A root has nothing above it, so `parent` reaches the person and the
      // result says so (contract bullet 2). The asking turn is never
      // suspended: the turn goes on or ends as it likes; the request waits.
      const redirectedToPerson = input.respondent === "parent" && record.parentRequestId === null;
      const respondent = redirectedToPerson ? "person" : input.respondent;
      let question: AmpleFileQuestionRecord;
      try {
        question = await state.requests.ask({ requestId: record.requestId, taskId, respondent, text: input.question, ...(input.options?.length ? { options: input.options } : {}), ...(input.asynchronous ? { asynchronous: true } : {}) });
      } catch (error) {
        throw collaborationRefusal(error);
      }
      await recordFacadeAction(state, input.parentTaskId, { command: "chat.ask", connectedFolder, taskId });
      publishControlHint(state, "connected-folders");
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        taskId,
        question: toActQuestionRef(question),
        request: toActRequestRefForConnectedFolder(state, state.requests.get(record.requestId) ?? record),
        redirectedToPerson,
      };
    });
  };
  const chatAnswer = async (connectedFolder: Pick<ConnectedFolderSummary, "id" | "name" | "connectedFolderRoot">, input: Omit<Parameters<AmpleFileActFacade["chatAnswer"]>[0], "connectedFolder">) => {
    assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
    const questionId = input.questionId.trim();
    if (!questionId) throw new AmpleFileCliError("usage", "Provide --question <id>.");
    const answer = input.answer.trim();
    if (!answer) throw new AmpleFileCliError("usage", "Provide --answer <text>.");
    return runActOperation(async () => {
      const question = state.requests.question(questionId);
      if (!question) {
        throw new AmpleFileCliError("notFound", `Question not found. Requests are kept for ${state.requests.retentionDays()} days.`);
      }
      const record = state.requests.get(question.requestId);
      if (!record) throw new AmpleFileCliError("notFound", "The request that asked this question is no longer on record.");
      // An answer is recorded before its continuation starts. Every fence
      // acceptance applies is checked first, but a turn can still start in
      // that Chat between the two, and a crash can land between them, so
      // "answered with no follow-up" is a reachable state. Sending the same
      // answer again resumes from exactly there — the recorded answer
      // stands and its one continuation starts now — rather than refusing
      // and leaving the answer with nowhere to go (one accepted answer starts
      // exactly one linked continuation).
      const resuming = question.state === "answered" && question.continuationTaskId === null;
      if (resuming && question.asynchronous && !ampleFileAnswerMatchesRecorded(question, answer)) throw new AmpleFileCliError("conflict", "That question already has a different recorded answer. Retry the same answer to continue it.");
      // Every other refusal is named before anything changes: a second
      // answer, an expired question, a closed request, the wrong Connected Folder, a
      // busy Chat.
      if (question.state === "answered" && !resuming) {
        throw new AmpleFileCliError("conflict", "That question already has an answer.");
      }
      if (question.state === "cancelled") throw new AmpleFileCliError("conflict", "That request was stopped, so its question is closed.");
      if (!resuming && (question.state === "expired" || (question.expiresAt !== null && Date.now() >= Date.parse(question.expiresAt)))) {
        throw new AmpleFileCliError("conflict", requestLimitRefusalMessage("questionLifetime"));
      }
      if ((record.owner.connectedFolderId ?? ampleFileAgentScopeId) !== connectedFolder.id) {
        const owner = record.owner.connectedFolderName ?? record.owner.connectedFolderId ?? "the AmpleFile Agent";
        throw new AmpleFileCliError("conflict", `Question ${questionId} belongs to ${owner}; answer it there.`);
      }
      const root = state.requests.get(record.rootId) ?? record;
      if (root.stopRequestedAt !== null || record.stopRequestedAt !== null) {
        throw new AmpleFileCliError("conflict", "That request was stopped, so its question is closed.");
      }
      if (root.state === "expired" || record.state === "expired") {
        throw new AmpleFileCliError("conflict", requestLimitRefusalMessage("questionLifetime"));
      }
      // Every fence acceptance would apply is checked before the question
      // flips, so a refusal leaves it open and answerable later: a busy
      // Chat, a capability change in flight, an archived or snoozed Chat.
      const answerKey = clientKey(connectedFolder.id, record.owner.conversationId);
      const queued = question.asynchronous === true && (state.runningTurns.has(answerKey) || state.compactingConversations.has(answerKey));
      if (!queued) assertChatMutable(connectedFolder.id, record.owner.conversationId);
      assertNoCapabilityMutationForTurn(state, connectedFolder.id);
      const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, record.owner.conversationId);
      if (summary.archivedAt) throw new AmpleFileCliError("conflict", "Restore this Chat before answering its question.");
      if (summary.snoozedUntil && Date.parse(summary.snoozedUntil) > Date.now()) {
        throw new AmpleFileCliError("conflict", "Resume this Chat before answering its question.");
      }
      let answered: AmpleFileQuestionRecord = question;
      if (!resuming) {
        try {
          answered = await state.requests.answer({ questionId, answer, ...(connectedFolder.id === ampleFileAgentScopeId ? {} : { answeredByConnectedFolderId: connectedFolder.id }) });
        } catch (error) {
          throw collaborationRefusal(error);
        }
      }
      if (queued) {
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.answer", connectedFolder, conversationId: record.owner.conversationId });
        publishControlHint(state, "connected-folders");
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), question: toActQuestionRef(answered), continuation: null, queued: true, request: toActRequestRefForConnectedFolder(state, state.requests.get(record.requestId) ?? record) };
      }
      // Journal-first: the question is answered; now exactly one linked
      // continuation turn, deduplicated by the turn store under a request
      // id derived from the question so a replay returns the same turn.
      // The transcript gets an ordinary user message — the question id
      // stays in machine-local records. A resumed answer carries
      // the text already on record, so the Chat and the record say the same
      // thing. Should acceptance still fail here, the answer stays recorded
      // and sending it again picks up exactly where this left off.
      const delivered = resuming ? answered.answer ?? answer : answer;
      let accepted: Awaited<ReturnType<typeof acceptConversationTurn>>;
      try {
        accepted = await acceptConversationTurn(state, connectedFolder, record.owner.conversationId, {
          content: delivered,
          contextPaths: [],
          actorKind: "cli",
          requestId: `answer-${questionId}`,
          request: { joinRequestId: record.requestId, answeringQuestionId: questionId },
        });
      } catch (error) {
        throw new AmpleFileCliError(
          "failure",
          `The answer to question ${questionId} is recorded, but the Chat could not continue: ${errorMessage(error)}. Send the same answer again to continue it.`,
          { cause: error },
        );
      }
      const { message, taskId } = accepted;
      let linked = answered;
      try {
        linked = await state.requests.linkContinuation(questionId, taskId);
      } catch (error) {
        // The turn store already returned the one continuation for this
        // answer; a second link attempt (a replayed answer) is a no-op.
        if (!(error instanceof AmpleFileRequestLineageError)) throw error;
        linked = state.requests.question(questionId) ?? answered;
      }
      await recordFacadeAction(state, input.parentTaskId, {
        command: "chat.answer",
        connectedFolder,
        conversationId: record.owner.conversationId,
        taskId,
      });
      publishControlHint(state, "connected-folders");
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        question: toActQuestionRef(linked),
        continuation: { taskId, messageId: message.id, conversationId: record.owner.conversationId },
        request: toActRequestRefForConnectedFolder(state, state.requests.get(record.requestId) ?? record),
      };
    });
  };

  /**
   * The one door for every verb that installs code, widens a power, or
   * destroys data (docs/act-ledger.md): typed parameters and
   * pins composed by the calling method from live state, then the prepared-
   * act path — pin recheck inside the capability fence, one internal kernel
   * task, the same domain internals the desktop uses — run at once under the
   * act request's journaled id. The act executor wrote the accepted receipt
   * before this method was reached and writes the terminal line after;
   * nothing here waits on a person. Returns the request id the act ran under.
   */
  const runPreparedAct = async (input: {
    kind: PreparedActKind;
    parameters: PreparedActFields;
    pins: PreparedActFields;
    requestId?: string;
    context?: unknown;
  }): Promise<string> => {
    const requestId = input.requestId?.trim() || randomUUID();
    // The journaled request id is the receipt id a Recently deleted entry records
    // (docs/act-ledger.md), so the destroying adapters can read
    // it back off the same context slot they report their outcome through.
    if (input.context && typeof input.context === "object") {
      (input.context as { requestId?: string }).requestId ??= requestId;
    }
    await runActOperation(() => runPreparedActOperation(async () => {
      const act = prepareAct({ kind: input.kind, parameters: input.parameters, pins: input.pins });
      await state.preparedActs.run({ act, requestId, context: input.context });
    }));
    return requestId;
  };
  /** Connected Folder–scoped capability changes require the Connected Folder's project trust, exactly as the desktop routes do. */
  const assertConnectedFolderCapabilityTrust = async (connectedFolder: ConnectedFolderSummary): Promise<void> => {
    if (!await isPiProjectMutationTrusted(connectedFolder.connectedFolderRoot, state.runtimeProvider)) {
      throw new AmpleFileCliError("permissionDenied", "Trust this Connected Folder before changing Connected Folder–scoped capabilities.");
    }
  };
  /**
   * Whole–Connected Folder restore replaces the working set running work may be reading,
   * so the act lane refuses concurrency the desktop still leaves to a confirm
   * dialog (docs/act-ledger.md, conflict rule 7). The live route state
   * covers turns and compactions; the kernel's
   * experimental fence covers active automation runs with files hops into the
   * Connected Folder and running background jobs there (the ledger's item 4).
   */
  const assertConnectedFolderQuietForHistoryRestore = async (connectedFolderId: string): Promise<void> => {
    const prefix = `${connectedFolderId}:`;
    if ([...state.runningTurns].some((key) => key.startsWith(prefix))) {
      throw new AmpleFileCliError("conflict", "Wait for the running turn in this Connected Folder to finish before restoring.");
    }
    if ([...state.compactingConversations].some((key) => key.startsWith(prefix))) {
      throw new AmpleFileCliError("conflict", "Wait for the running Chat compaction in this Connected Folder to finish before restoring.");
    }
    const blockers = await state.kernel.listExperimentalHistoryRestoreBlockers(connectedFolderId);
    if (blockers.length) throw new AmpleFileCliError("conflict", blockers[0]!);
  };
  return {
    async workerShow(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const [status, instructions, models] = await Promise.all([
        runActOperation(() => getPiSetupStatus(connectedFolder.connectedFolderRoot, state.runtimeProvider)),
        runActOperation(() => getPiWorkerInstructions(connectedFolder.connectedFolderRoot, state.runtimeProvider)),
        runActOperation(() => listPiModels(connectedFolder.connectedFolderRoot, state.runtimeProvider)),
      ]);
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        model: status.provider && status.model ? { provider: status.provider, id: status.model } : null,
        availableModels: models
          .filter((model) => model.authConfigured)
          .map((model) => ({ provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning })),
        instructions,
      };
    },
    async workerSetModel(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const selected = await runActOperation(() => runCapabilityMutation(state, connectedFolder, "project", async () => {
        const match = (await listPiModels(connectedFolder.connectedFolderRoot, state.runtimeProvider))
          .find((model) => model.provider === input.provider.trim() && model.id === input.model.trim());
        if (!match) throw new AmpleFileCliError("usage", "The selected model is not available in this Connected Folder.");
        if (!match.authConfigured) {
          throw new AmpleFileCliError("permissionDenied", "Connect this provider in Settings → AI Models before assigning its model.");
        }
        await setPiDefaultModel(
          connectedFolder.connectedFolderRoot,
          { provider: match.provider, id: match.id },
          state.runtimeProvider,
        );
        return match;
      }, { requireProjectTrust: false }));
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.worker.model", connectedFolder });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), model: { provider: selected.provider, id: selected.id } };
    },
    async workerSetInstructions(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      let instructions: string;
      let appended: boolean | undefined;
      const saved = input.append ? await runActOperation(() => getPiWorkerInstructions(connectedFolder.connectedFolderRoot, state.runtimeProvider)) : "";
      try {
        if (input.append) {
          const line = normalizeWorkerInstructions(input.instructions);
          if (!line) throw new Error("Provide the line to add.");
          const current = normalizeWorkerInstructions(saved);
          // The same remembered line twice adds nothing.
          appended = !current.split("\n").some((existing) => existing.trim() === line);
          instructions = appended ? normalizeWorkerInstructions(current ? `${current}\n${line}` : line) : current;
        } else {
          instructions = normalizeWorkerInstructions(input.instructions);
        }
      } catch (error) {
        throw new AmpleFileCliError("usage", errorMessage(error));
      }
      if (appended !== false) await runActOperation(() => saveWorkerInstructions(state, connectedFolder, instructions));
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.worker.instructions", connectedFolder });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), instructions, ...(appended !== undefined ? { appended } : {}) };
    },
    async createConversation(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const conversation = await runActOperation(() => createConversation(connectedFolder.connectedFolderRoot));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), conversation: toActConversationRef(conversation) };
    },
    async listConversations(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const conversations = await runActOperation(() => listConversations(connectedFolder.connectedFolderRoot));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), conversations: conversations.map(toActConversationRef) };
    },
    async sendMessage(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const content = input.content.trim();
      if (!content) throw new AmpleFileCliError("usage", "Message content is required.");
      if (!input.conversationId && !input.newConversation) {
        throw new AmpleFileCliError("usage", "Provide --conversation <id> or --new.");
      }
      return runActOperation(async () => {
        assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
        if (input.parentTaskId) {
          await state.beforeAmpleFileAgentActionRecord?.({ parentTaskId: input.parentTaskId, command: "chat.send", taskId: "" });
        }
        const conversationId = input.newConversation
          ? (await createConversation(connectedFolder.connectedFolderRoot)).id
          : input.conversationId!;
        // A delegated send is a child request under the named parent.
        // The parent check and every request bound run inside acceptance,
        // before the user message lands, so a refused child is never
        // accepted and then cancelled.
        const { message, taskId } = await acceptConversationTurn(state, connectedFolder, conversationId, {
          content,
          contextPaths: [],
          actorKind: "cli",
          requestId: input.requestId,
          ...(input.parentTaskId ? { request: { parentTaskId: input.parentTaskId } } : {}),
        });
        await recordLandedAction(state, input.parentTaskId, {
          command: "chat.send",
          at: new Date().toISOString(),
          connectedFolderId: connectedFolder.id,
          connectedFolderName: connectedFolder.name,
          conversationId,
          taskId,
        });
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), conversationId, messageId: message.id, taskId };
      });
    },
    async conversationStatus(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const summary = await runActOperation(() => readConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId));
      if (!summary) throw new AmpleFileCliError("notFound", "Conversation not found.");
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        conversation: toActConversationRef(summary),
        state: conversationRuntimeState(state, connectedFolder.id, input.conversationId),
      };
    },
    async conversationResult(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const result = await conversationResultForScope(state, connectedFolder.id, connectedFolder.connectedFolderRoot, input.conversationId, input.messages);
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...result };
    },
    async abortTurn(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const client = state.clients.get(clientKey(connectedFolder.id, input.conversationId));
      const request = state.requests.latestForConversation(input.conversationId, { connectedFolderId: connectedFolder.id });
      const stopped = request ? await stopAmpleFileAgentRequest(state, request.turns.at(-1)!.taskId) : null;
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        conversationId: input.conversationId,
        aborted: stopped ? stopped.ampleFileAgentAborted || stopped.children.some(child => child.aborted) : client ? await client.abort() : false,
      };
    },
    async turnStatus(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      const task = turnStatusFor(state, connectedFolder.id, taskId);
      const record = state.requests.byTaskId(taskId);
      // Both fields are scoped to the named Connected Folder: a task id is easy to come
      // by, and a question another Connected Folder's agent asked is that Connected Folder's
      // content, never this caller's (docs/collaboration-contract.md).
      const owned = record !== null && record.owner.connectedFolderId === connectedFolder.id;
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        task,
        waiting: owned ? waitingRefForTask(state, taskId) : null,
        request: owned ? toActRequestRefForConnectedFolder(state, record) : null,
      };
    },
    async turnResult(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      const result = await turnResultForScope(state, connectedFolder.id, connectedFolder.connectedFolderRoot, taskId);
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...result };
    },
    // --- the collaboration verbs (docs/collaboration-contract.md) ---
    async chatReport(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <own-task-id>.");
      return runActOperation(async () => {
        const record = assertOwnTask(state, connectedFolder.id, taskId);
        const data = input.dataPath !== undefined
          ? await readReportDataFile(input.dataPath, input.cwd ?? connectedFolder.connectedFolderRoot)
          : input.data;
        const files = await resolveReportFiles(connectedFolder, input.files);
        let result;
        try {
          result = await state.requests.recordResult({
            requestId: record.requestId,
            taskId,
            receiptId: input.requestId ?? `direct-${randomUUID()}`,
            envelope: {
              summary: input.summary,
              ...(data !== undefined ? { data } : {}),
              ...(files.length ? { files } : {}),
              outcome: input.outcome,
            },
          });
        } catch (error) {
          const refusal = collaborationRefusal(error);
          if (refusal !== error) throw refusal;
          // A report the envelope rules refuse is the agent's to correct, so
          // it reads as a usage refusal naming the field, not a failure.
          throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
        }
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.report", connectedFolder, taskId });
        publishControlHint(state, "connected-folders");
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          taskId,
          resultId: result.resultId,
          result: result.envelope,
          request: toActRequestRefForConnectedFolder(state, state.requests.get(record.requestId) ?? record),
        };
      });
    },
    async chatChildren(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const own = assertOwnTask(state, connectedFolder.id, input.taskId);
      return { children: state.requests.children(own.requestId).map(child => ({ taskId: child.turns.at(-1)!.taskId, conversationId: child.owner.conversationId, ...(child.owner.connectedFolderId ? { connectedFolderId: child.owner.connectedFolderId } : {}), state: child.state, resultAvailable: child.results.length > 0 })) };
    },
    async chatAsk(input) { return chatAsk(await resolveConnectedFolder(input.connectedFolder), input); },
    async chatAnswer(input) { return chatAnswer(await resolveConnectedFolder(input.connectedFolder), input); },
    async agentAsk(input) {
      const scope = ampleFileAgentScope(state);
      const { connectedFolder: _connectedFolder, ...result } = await chatAsk({ id: scope.id, connectedFolderRoot: scope.rootPath, name: "AmpleFile Agent" }, { ...input, respondent: "person" });
      return result;
    },
    async agentAnswer(input) {
      const scope = ampleFileAgentScope(state);
      const { connectedFolder: _connectedFolder, ...result } = await chatAnswer({ id: scope.id, connectedFolderRoot: scope.rootPath, name: "AmpleFile Agent" }, input);
      return result;
    },
    async chatHandoff(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const destination = await resolveConnectedFolder(input.toConnectedFolder);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <own-task-id>.");
      const content = input.message.trim();
      if (!content) throw new AmpleFileCliError("usage", "Message content is required.");
      return runActOperation(async () => {
        const record = assertOwnTask(state, connectedFolder.id, taskId);
        // Every bound that could refuse the child is checked before a single
        // byte is copied, naming the limit.
        try {
          state.requests.assertCanAddChild(taskId);
        } catch (error) {
          throw collaborationRefusal(error);
        }
        if (destination.id === connectedFolder.id && input.files.length) {
          throw new AmpleFileCliError(
            "usage",
            "A handoff to the same Connected Folder needs no copies: the files are already there, so leave --file off.",
          );
        }
        const sources = input.files.map((file) => resolveHandoffSource(connectedFolder, file));
        // A follow-up goes into a Chat this Chat already handed work to, so
        // that Worker keeps everything it learned.
        const followUpId = input.toConversationId?.trim();
        if (followUpId) {
          if (!(await readConversationSummary(destination.connectedFolderRoot, followUpId))) throw new AmpleFileCliError("notFound", "Conversation not found.");
          assertCallerHandedWorkTo(state, taskId, { connectedFolderId: destination.id, conversationId: followUpId });
          const key = clientKey(destination.id, followUpId);
          if (state.runningTurns.has(key) || state.compactingConversations.has(key)) {
            throw new AmpleFileCliError("conflict", "That Chat is still working. Redirect it with chat steer, or wait for it and follow up.");
          }
        }
        // Copy first, through the same additive, restore-pointed path as
        // `files add`, so a refused copy never leaves a started Chat behind.
        const copy = sources.length
          ? await addExternalFilesInternal(destination, { fromPaths: sources, cwd: destination.connectedFolderRoot })
          : { copied: [], checkpointId: null };
        const conversation = followUpId ? { id: followUpId } : await createConversation(destination.connectedFolderRoot);
        const { message, taskId: childTaskId } = await acceptConversationTurn(state, destination, conversation.id, {
          content,
          contextPaths: [],
          actorKind: "cli",
          requestId: input.requestId,
          request: { parentTaskId: taskId, kind: "connected-folder" },
        });
        await recordFacadeAction(state, input.parentTaskId, {
          command: "chat.handoff",
          connectedFolder: destination,
          conversationId: conversation.id,
          taskId: childTaskId,
          checkpointId: copy.checkpointId,
          copied: copy.copied,
        });
        publishControlHint(state, "connected-folders");
        const child = state.requests.byTaskId(childTaskId);
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          toConnectedFolder: toActConnectedFolderRef(destination),
          conversationId: conversation.id,
          messageId: message.id,
          taskId: childTaskId,
          copied: copy.copied,
          checkpointId: copy.checkpointId,
          request: toActRequestRefForConnectedFolder(state, child ?? record),
          ...(followUpId ? { followUp: true } : {}),
        };
      });
    },
    async chatSteer(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const conversationId = input.conversationId.trim();
      const content = input.message.trim();
      if (!content) throw new AmpleFileCliError("usage", "Message content is required.");
      return runActOperation(async () => {
        if (!(await readConversationSummary(connectedFolder.connectedFolderRoot, conversationId))) throw new AmpleFileCliError("notFound", "Conversation not found.");
        const callerTaskId = input.taskId?.trim();
        if (callerTaskId) assertCallerHandedWorkTo(state, callerTaskId, { connectedFolderId: connectedFolder.id, conversationId });
        const running = state.runningTurns.has(clientKey(connectedFolder.id, conversationId));
        let steered: Awaited<ReturnType<typeof steerConversationTurn>>;
        try {
          steered = await steerConversationTurn(state, connectedFolder, conversationId, { content, ...(input.requestId ? { requestId: input.requestId } : {}) });
        } catch (error) {
          if ((error as { statusCode?: unknown })?.statusCode === 409) {
            throw new AmpleFileCliError("conflict", running
              ? "That Chat's turn is starting or finishing and cannot take a message right now. Try again in a moment, or follow up once it ends."
              : "That Chat has no turn running. Follow up with chat handoff --to-conversation, or chat send.");
          }
          throw error;
        }
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.steer", connectedFolder, conversationId, taskId: steered.taskId });
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), conversationId, taskId: steered.taskId, messageId: steered.message.id, replayed: steered.replayed };
      });
    },
    async chatCopy(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const sourceId = input.conversationId.trim();
      const content = input.message?.trim();
      if (input.message !== undefined && !content) throw new AmpleFileCliError("usage", "Message content is required.");
      return runActOperation(async () => {
        const callerTaskId = input.taskId?.trim();
        if (callerTaskId) {
          // A Worker copies its own Chat, or one its Chat handed work to.
          const caller = assertCallerTurn(state, callerTaskId);
          const ownChat = (caller.owner.connectedFolderId ?? ampleFileAgentScopeId) === connectedFolder.id && caller.owner.conversationId === sourceId;
          if (!ownChat) assertCallerHandedWorkTo(state, callerTaskId, { connectedFolderId: connectedFolder.id, conversationId: sourceId });
          try {
            state.requests.assertCanAddChild(callerTaskId);
          } catch (error) {
            throw collaborationRefusal(error);
          }
        }
        const copied = await copyConversation(state, connectedFolder, sourceId, input.title);
        let started: { taskId: string } | null = null;
        if (content) {
          started = await acceptConversationTurn(state, connectedFolder, copied.conversation.id, {
            content,
            contextPaths: [],
            actorKind: "cli",
            requestId: input.requestId,
            ...(callerTaskId ? { request: { parentTaskId: callerTaskId, kind: "connected-folder" as const } }
              : input.parentTaskId ? { request: { parentTaskId: input.parentTaskId } } : {}),
          });
        }
        await recordFacadeAction(state, input.parentTaskId, {
          command: "chat.copy", connectedFolder, conversationId: copied.conversation.id, ...(started ? { taskId: started.taskId } : {}),
        });
        publishControlHint(state, "connected-folders");
        const child = started ? state.requests.byTaskId(started.taskId) : null;
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(copied.conversation),
          copiedFromConversationId: sourceId,
          copiedMessages: copied.copiedMessages,
          ...(started ? { taskId: started.taskId } : {}),
          ...(child ? { request: toActRequestRefForConnectedFolder(state, child) } : {}),
        };
      });
    },
    async requestsList(input) {
      await assertRequestsAboveConnectedFolders(input?.cwd);
      const roots = state.requests.list()
        .filter((record) => record.requestId === record.rootId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return {
        requests: roots.map((record) => requestSummaryView(state, record)),
        truncated: false,
      };
    },
    async requestsShow(input) {
      await assertRequestsAboveConnectedFolders(input.cwd);
      const requestId = input.request.trim();
      const record = requestId ? state.requests.get(requestId) : null;
      if (!record) {
        throw new AmpleFileCliError("notFound", `Request not found. Requests are kept for ${state.requests.retentionDays()} days.`);
      }
      return { request: await requestDetailView(state, record) };
    },
    // Background jobs (docs/background-jobs.md): the same service and records
    // as job_start, job_output, and job_stop.
    async jobsStart(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      assertOwnTask(state, connectedFolder.id, input.taskId);
      const cwd = input.cwd?.trim()
        ? (isAbsolute(input.cwd.trim()) ? resolve(input.cwd.trim()) : resolve(connectedFolder.connectedFolderRoot, input.cwd.trim()))
        : connectedFolder.connectedFolderRoot;
      // The Connected Folder's own Pi shell settings, so a job runs the way its bash would.
      const runtime = await resolvePiRuntime(connectedFolder.connectedFolderRoot, state.runtimeProvider, { requestProjectTrust: false }).catch(() => null);
      const shell: AmpleFileJobShell | undefined = runtime ? {
        ...(runtime.settingsManager.getShellPath() ? { shellPath: runtime.settingsManager.getShellPath() } : {}),
        ...(runtime.settingsManager.getShellCommandPrefix() ? { commandPrefix: runtime.settingsManager.getShellCommandPrefix() } : {}),
        binDir: join(runtime.agentDir, "bin"),
      } : undefined;
      const job = await runJobOperation(() => startBackgroundJob(state, {
        taskId: input.taskId,
        command: input.command,
        ...(input.interactive ? { interactive: true } : {}),
        ...(input.service ? { service: true } : {}),
        ...(input.name ? { name: input.name } : {}),
        cwd,
        ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
        surface: "cli",
        ...(shell ? { shell } : {}),
      }));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), job: toActJobRef(job) };
    },
    async jobsInput(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const record = assertOwnTask(state, connectedFolder.id, input.taskId);
      const host = createBackgroundJobToolHost(state, connectedFolder.id, record.owner.conversationId);
      const job = await host.input!({ taskId: input.taskId, jobId: input.jobId, text: input.text, ...(input.eof ? { eof: true } : {}) });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), job: toActJobRef(job) };
    },
    async worktreesManage(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return createWorktreeToolHost(state, connectedFolder.id).invoke(input.taskId, input);
    },
    async jobsList(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const jobs = state.jobs.list({
        connectedFolderId: connectedFolder.id,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.running ? { running: true } : {}),
      });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), jobs: jobs.map(toActJobRef) };
    },
    async jobsShow(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), job: toActJobRef(ownedJob(state, connectedFolder.id, input.jobId)) };
    },
    async jobsOutput(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const owned = ownedJob(state, connectedFolder.id, input.jobId);
      let until: RegExp | undefined;
      try {
        until = parseUntilPattern(input.until);
      } catch (error) {
        throw new AmpleFileCliError("usage", errorMessage(error), { cause: error });
      }
      const waited = (input.waitSeconds ?? 0) > 0 || until
        ? await state.jobs.wait(owned.jobId, {
          seconds: input.waitSeconds ?? 0,
          ...(until ? { until } : {}),
          ...(input.offset !== undefined ? { fromLine: input.offset } : {}),
        })
        : null;
      const { job, output } = await state.jobs.read(owned.jobId, {
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      // A read from a running turn in the job's own Chat is its delivery.
      if (input.taskId && isAmpleFileJobTerminalState(job.state) && job.settledAt && state.requests.isAccepting(input.taskId)
        && state.requests.byTaskId(input.taskId)?.owner.conversationId === job.conversationId
        && (state.requests.byTaskId(input.taskId)?.owner.connectedFolderId ?? null) === (job.connectedFolderId ?? null)) {
        await deliverBackgroundJobs(state, [job], "read", input.taskId);
      }
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        job: toActJobRef(state.jobs.get(job.jobId) ?? job),
        output,
        wait: waited ? {
          outcome: waited.outcome,
          ...(waited.outcome === "matched" ? { line: waited.line, text: waited.text } : {}),
        } : null,
      };
    },
    async jobsStop(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const owned = ownedJob(state, connectedFolder.id, input.jobId);
      const job = await runJobOperation(() => stopBackgroundJob(state, owned.jobId, "cli", input.parentTaskId));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), job: toActJobRef(job) };
    },
    async chatRename(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const title = input.title.trim();
      if (!title) throw new AmpleFileCliError("usage", "Chat title is required.");
      return runActOperation(() => runConversationMutation(state, connectedFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId);
        const conversation = await runActOperation(() => renameConversation(connectedFolder.connectedFolderRoot, input.conversationId, title));
        state.clients.get(clientKey(connectedFolder.id, input.conversationId))?.setSessionName(conversation.title);
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.rename", connectedFolder, conversationId: conversation.id });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(conversation),
          priorTitle: summary.title,
        };
      }));
    },
    async chatSnooze(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const until = input.until.trim();
      if (!Number.isFinite(Date.parse(until))) throw new AmpleFileCliError("usage", "Snooze time is invalid.");
      if (Date.parse(until) <= Date.now()) throw new AmpleFileCliError("usage", "Choose a future snooze time.");
      return runActOperation(() => runConversationMutation(state, connectedFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId);
        if (summary.archivedAt) throw new AmpleFileCliError("conflict", "Unarchive this Chat before snoozing it.");
        const conversation = await runActOperation(() =>
          updateConversationLifecycle(connectedFolder.connectedFolderRoot, input.conversationId, { snoozedUntil: until }));
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.snooze", connectedFolder, conversationId: conversation.id });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(conversation),
          priorLifecycle: toActChatLifecycleState(summary),
        };
      }));
    },
    async chatArchive(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(() => runConversationMutation(state, connectedFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId);
        if (summary.archivedAt) throw new AmpleFileCliError("conflict", "This Chat is already archived.");
        const conversation = await runActOperation(() =>
          updateConversationLifecycle(connectedFolder.connectedFolderRoot, input.conversationId, { archived: true }));
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.archive", connectedFolder, conversationId: conversation.id });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(conversation),
          priorLifecycle: toActChatLifecycleState(summary),
        };
      }));
    },
    async chatResume(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(() => runConversationMutation(state, connectedFolder.id, input.conversationId, async () => {
        const summary = await requireConversationSummary(connectedFolder.connectedFolderRoot, input.conversationId);
        if (!summary.archivedAt && !summary.snoozedUntil) {
          throw new AmpleFileCliError("conflict", "This Chat is already active.");
        }
        // One lifecycle change per act, mirroring the renderer: an archived Chat
        // restores to Active; a snoozed (or snooze-expired) Chat clears its snooze.
        const conversation = await runActOperation(() =>
          updateConversationLifecycle(
            connectedFolder.connectedFolderRoot,
            input.conversationId,
            summary.archivedAt ? { archived: false } : { snoozedUntil: null },
          ));
        await recordFacadeAction(state, input.parentTaskId, { command: "chat.resume", connectedFolder, conversationId: conversation.id });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversation: toActConversationRef(conversation),
          priorLifecycle: toActChatLifecycleState(summary),
        };
      }));
    },
    async chatCompact(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(async () => {
        // Exactly the composer's /compact route: same not-found check, same
        // capability-mutation fence, same 409s, and the same kernel
        // `compaction` task lifecycle — started before the compaction and
        // finished on every outcome, so no ghost task survives a failure.
        if (!(await readConversation(connectedFolder.connectedFolderRoot, input.conversationId)).length) {
          throw new AmpleFileCliError("notFound", "Conversation not found.");
        }
        const key = clientKey(connectedFolder.id, input.conversationId);
        assertNoCapabilityMutationForTurn(state, connectedFolder.id);
        assertChatMutable(connectedFolder.id, input.conversationId);
        state.compactingConversations.add(key);
        const task = state.kernel.startTask({
          kind: "compaction",
          connectedFolderId: connectedFolder.id,
          conversationId: input.conversationId,
          actor: { kind: "cli", cwd: connectedFolder.connectedFolderRoot, connectedFolderId: connectedFolder.id, conversationId: input.conversationId },
        });
        try {
          const client = await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, input.conversationId);
          await client.compact();
          broadcast(state, streamKey(connectedFolder.id, input.conversationId), { type: "done", conversationId: input.conversationId });
        } finally {
          state.compactingConversations.delete(key);
          await refreshClientIfMarked(state, key);
          state.kernel.finishTask(task.id);
          queueConversationRequestEvaluation(state, connectedFolder.id, input.conversationId);
        }
        await recordFacadeAction(state, input.parentTaskId, {
          command: "chat.compact",
          connectedFolder,
          conversationId: input.conversationId,
          taskId: task.id,
        });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          conversationId: input.conversationId,
          compacted: true as const,
          taskId: task.id,
        };
      });
    },
    async historyList(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const page = await runActOperation(() => listConnectedFolderCheckpointPage(connectedFolder.connectedFolderRoot, input));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...page, checkpoints: page.checkpoints.map(toActCheckpointSummary) };
    },
    async historySave(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(async () => {
        // Same internals as the History pane's save route: an unchanged Connected Folder
        // returns the latest matching restore point instead of a duplicate.
        const existingIds = new Set(
          (await listConnectedFolderCheckpoints(connectedFolder.connectedFolderRoot, 1000)).map((checkpoint) => checkpoint.checkpointId),
        );
        const checkpoint = await createConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, {
          ...(input.label !== undefined ? { label: input.label } : {}),
          reason: "manual",
        });
        await recordFacadeAction(state, input.parentTaskId, {
          command: "history.save",
          connectedFolder,
          checkpointId: checkpoint.checkpointId,
        });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          checkpoint: toActCheckpointSummary(checkpoint),
          created: !existingIds.has(checkpoint.checkpointId),
        };
      });
    },
    async historyRestore(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      await assertConnectedFolderQuietForHistoryRestore(connectedFolder.id);
      const result = await runActOperation(() => runHistoryRestore(state, connectedFolder, () => restoreConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, input.checkpointId)));
      await recordFacadeAction(state, input.parentTaskId, {
        command: "history.restore",
        connectedFolder,
        checkpointId: result.safetyCheckpointId,
      });
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        restored: true,
        checkpointId: result.checkpointId,
        safetyCheckpointId: result.safetyCheckpointId,
        restoredFileCount: result.restoredFiles.length,
        deletedFileCount: result.deletedFiles.length,
        movedEntryCount: result.movedEntries.length,
        unchangedFileCount: result.unchangedFiles,
        skippedLargeFileCount: result.skippedLargeFiles.length,
      };
    },
    async historyVersions(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const path = input.path.trim();
      if (!path) throw new AmpleFileCliError("usage", "A Connected Folder–relative file path is required.");
      const page = await runActOperation(() => listFileVersionPage(connectedFolder.connectedFolderRoot, path, input));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), path, ...page, versions: page.versions.map(toActFileVersionRef) };
    },
    async historyRead(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const review = await runActOperation(() => readHistoryFile(connectedFolder.connectedFolderRoot, input));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), review };
    },
    async historyDiff(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const comparison = await runActOperation(() => compareHistoryFile(connectedFolder.connectedFolderRoot, input));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), comparison };
    },
    async historyRestoreFile(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      if (!/^[a-f0-9]{64}$/i.test(input.version.trim())) {
        throw new AmpleFileCliError("usage", "Provide --version as the 64-character SHA-256 hash shown by 'history versions'.");
      }
      return runActOperation(async () => {
        const target = await stat(resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, input.path)).catch(() => null);
        if (target && !target.isFile()) {
          throw new AmpleFileCliError("conflict", "The selected path is currently a folder.");
        }
        const result = await runHistoryRestore(state, connectedFolder, () => restoreFileVersion(connectedFolder.connectedFolderRoot, input.path, input.version.trim()));
        await recordFacadeAction(state, input.parentTaskId, {
          command: "history.restore-file",
          connectedFolder,
          checkpointId: result.safetyCheckpointId,
        });
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...result };
      });
    },
    async filesMove(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const sourceRaw = input.fromPath.trim();
      if (!sourceRaw) throw new AmpleFileCliError("usage", "Select a file or folder to move.");
      return runActOperation(async () => {
        // Exactly the desktop move route: a targeted restore point that undoes
        // the move, then the mutation, with the unused restore point discarded
        // when the mutation fails.
        const moveSource = normalizeConnectedFolderRelativePath(sourceRaw);
        const moveTargetFolder = normalizeConnectedFolderRelativePath(input.toDir);
        const moveDestination = [moveTargetFolder, basename(moveSource)].filter(Boolean).join("/");
        const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
          movesOnRestore: [{ fromPath: moveDestination, toPath: moveSource }],
          reason: "pre_move",
          label: `Before moving ${sourceRaw}`,
        });
        const moved = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => moveConnectedFolderEntry(connectedFolder.connectedFolderRoot, {
          sourcePath: moveSource,
          targetFolderPath: input.toDir,
        }));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.move", connectedFolder, checkpointId: safety.checkpointId });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          fromPath: moved.fromPath,
          path: moved.path,
          kind: moved.kind,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesRename(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const sourceRaw = input.path.trim();
      const newName = input.newName.trim();
      if (!sourceRaw || !newName) throw new AmpleFileCliError("usage", "A Connected Folder item and new name are required.");
      return runActOperation(async () => {
        const renameSource = normalizeConnectedFolderRelativePath(sourceRaw);
        const renameParent = renameSource.includes("/") ? renameSource.slice(0, renameSource.lastIndexOf("/")) : "";
        const renameDestination = [renameParent, newName].filter(Boolean).join("/");
        const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
          movesOnRestore: [{ fromPath: renameDestination, toPath: renameSource }],
          reason: "pre_rename",
          label: `Before renaming ${sourceRaw}`,
        });
        const renamed = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => renameConnectedFolderEntry(connectedFolder.connectedFolderRoot, { path: sourceRaw, newName }));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.rename", connectedFolder, checkpointId: safety.checkpointId });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          fromPath: renamed.fromPath,
          path: renamed.path,
          priorName: basename(renameSource),
          kind: renamed.kind,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesDelete(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const target = input.path.trim();
      if (!target) throw new AmpleFileCliError("usage", "Select a file or folder to delete.");
      return runActOperation(async () => {
        const deleted = await deleteConnectedFolderEntryWithRecovery(state, connectedFolder, target, {
          receiptId: input.requestId ?? null,
        });
        await recordFacadeAction(state, input.parentTaskId, {
          command: "files.delete",
          connectedFolder,
          checkpointId: deleted.safetyCheckpointId,
        });
        return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...deleted };
      });
    },
    async filesMkdir(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const { target, parentPath, name } = splitActEntryPath(input.path, "A folder path is required.");
      return runActOperation(async () => {
        const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
          deleteOnRestore: [target],
          reason: "pre_create",
          label: `Before creating ${name}`,
        });
        const folder = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => createConnectedFolderFolder(connectedFolder.connectedFolderRoot, parentPath, name));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.mkdir", connectedFolder, checkpointId: safety.checkpointId });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          created: true as const,
          path: folder.path,
          kind: "folder" as const,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async filesCreate(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const { target, parentPath, name } = splitActEntryPath(input.path, "A file path is required.");
      return runActOperation(async () => {
        const safety = await createConnectedFolderMutationCheckpoint(connectedFolder.connectedFolderRoot, {
          deleteOnRestore: [target],
          reason: "pre_create",
          label: `Before creating ${name}`,
        });
        const file = await runWithHistorySafety(connectedFolder.connectedFolderRoot, safety.checkpointId, () => createConnectedFolderTextFile(connectedFolder.connectedFolderRoot, parentPath, name, ""));
        await recordFacadeAction(state, input.parentTaskId, { command: "files.create", connectedFolder, checkpointId: safety.checkpointId });
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          created: true as const,
          path: file.path,
          kind: "file" as const,
          safetyCheckpointId: safety.checkpointId,
        };
      });
    },
    async search(input) {
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const query = input.query.trim();
      if (!query) throw new AmpleFileCliError("usage", "Enter something to search for.");
      const scope = input.scope ?? "all";
      const result = await runActOperation(() => searchConnectedFolder(connectedFolder.connectedFolderRoot, query, {
        includeFiles: scope !== "chats",
        includeChats: scope !== "files",
        path: input.path, cursor: input.cursor, maxMatches: input.limit,
      }));
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), scope, ...result };
    },
    async createConnectedFolder(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const name = input.name.trim();
      if (!name) throw new AmpleFileCliError("usage", "A Connected Folder name is required.");
      const connectedFolder = await runActOperation(() => createConnectedFolderInternal(state, name));
      await recordLandedAction(state, input.parentTaskId, {
        command: "connected-folders.create",
        at: new Date().toISOString(),
        connectedFolderId: connectedFolder.id,
        connectedFolderName: connectedFolder.name,
        connectedFolderRoot: connectedFolder.connectedFolderRoot,
      });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder) };
    },
    async registerConnectedFolder(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const rootPath = input.connectedFolderRoot.trim();
      if (!rootPath || !isAbsolute(rootPath)) {
        throw new AmpleFileCliError("usage", "Provide an absolute folder path to register.");
      }
      const connectedFolder = await runActOperation(() => registerConnectedFolderInternal(state, rootPath));
      await recordLandedAction(state, input.parentTaskId, {
        command: "connected-folders.register",
        at: new Date().toISOString(),
        connectedFolderId: connectedFolder.id,
        connectedFolderName: connectedFolder.name,
        connectedFolderRoot: connectedFolder.connectedFolderRoot,
      });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder) };
    },
    async addFiles(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const result = await runActOperation(() => addExternalFilesInternal(connectedFolder, input));
      await recordLandedAction(state, input.parentTaskId, {
        command: "files.add",
        at: new Date().toISOString(),
        connectedFolderId: connectedFolder.id,
        connectedFolderName: connectedFolder.name,
        sources: input.fromPaths.map((raw) => {
          const trimmed = raw.trim();
          return isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
        }),
        copied: result.copied,
        checkpointId: result.checkpointId,
      });
      return { connectedFolder: toActConnectedFolderRef(connectedFolder), ...result };
    },
    async connectedFoldersRename(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const name = input.name.trim();
      if (!name) throw new AmpleFileCliError("usage", "A Connected Folder name is required.");
      // The ledger's ambiguous-making rule: a duplicate exact name under the
      // CLI selector's case-insensitive match would break `--connected-folder` selection
      // by name, so it is refused here. The comparison folds the same way the
      // selector does; renaming a Connected Folder to a case variant of itself stays
      // allowed.
      const folded = name.replace(/\s+/g, " ").slice(0, 80).toLocaleLowerCase("en-US");
      const collision = (await listConnectedFolders()).find((item) =>
        item.id !== connectedFolder.id && item.name.toLocaleLowerCase("en-US") === folded);
      if (collision) {
        throw new AmpleFileCliError(
          "conflict",
          `Another Connected Folder is already named ${collision.name} [${collision.id}]; a duplicate exact name would make --connected-folder selection ambiguous.`,
        );
      }
      const renamed = await runActOperation(() => renameConnectedFolder(connectedFolder.id, name));
      publishControlHint(state, "connected-folders");
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.rename", connectedFolder: renamed });
      return { connectedFolder: toActConnectedFolderRef(renamed), priorName: connectedFolder.name };
    },
    async connectedFoldersUnregister(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const storage = connectedFolder.location.storage;
      // Both storage kinds run the same removal orchestration — automation
      // suspension and a durable intent. A managed Connected Folder records a
      // preserve-disposition intent that provably holds no deletion
      // authority, so the folder and its portable `.amplefile/` identity
      // remain exactly as they do for a linked registration; deleting the
      // managed folder is `connected-folders delete`, a receipted act of its own.
      const removal = await runActOperation(() =>
        removeConnectedFolderRegistrationInternal(state, connectedFolder, {
          managedFolderDisposition: "preserve",
          receiptId: input.requestId ?? null,
        }));
      appearanceUndoSlots.delete(connectedFolder.id);
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.unregister", connectedFolder });
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        storage,
        removed: true as const,
        cleanupPending: removal.cleanupPending,
      };
    },
    async connectedFoldersAppearanceApply(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const proposal = input.proposalPath !== undefined ? await readConnectedFolderAppearanceProposalFile(input.proposalPath, input.cwd) : null;
      // Named parts are read and encoded first, so an unusable image refuses before anything changes.
      const parts = proposal ? null : await resolveConnectedFolderAppearanceParts(input.parts ?? {}, input.cwd).catch((error: unknown) => {
        if (error instanceof ConnectedFolderAppearancePartsError) throw new AmpleFileCliError(error.code, error.message, { cause: error });
        throw error;
      });
      if (!proposal && (!parts || !connectedFolderAppearancePartsLabel(parts))) {
        throw new AmpleFileCliError("usage", "Provide a proposal, or a banner image, icon, or color to change.");
      }
      if (proposal?.target?.connectedFolderId && proposal.target.connectedFolderId !== connectedFolder.id) {
        throw new AmpleFileCliError(
          "conflict",
          `This appearance proposal targets a different Connected Folder (${proposal.target.connectedFolderId}). Apply it with that --connected-folder, or use a proposal authored for this one.`,
        );
      }
      return runActOperation(async () => {
        const displaced = currentAppearanceCustomization(connectedFolder.id);
        // Exactly the Customize Connected Folder import route's mutation: the store
        // normalizes and persists the typed customization atomically. Named
        // parts change only themselves on top of the current appearance.
        const applied = await state.appearance.replaceConnectedFolder(
          connectedFolder.id,
          proposal ? proposal.customization : applyConnectedFolderAppearanceParts(displaced, parts!),
        );
        const result = applied.customizations[connectedFolder.id] ?? null;
        appearanceUndoSlots.set(connectedFolder.id, { displaced, result });
        await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.appearance.apply", connectedFolder });
        // An open window re-reads its startup state and shows the new look now.
        publishControlHint(state, "connected-folders");
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          applied: true as const,
          proposalName: proposal ? proposal.name : connectedFolderAppearancePartsLabel(parts!),
          appearanceRef: appearanceCustomizationRef(result),
          priorAppearanceRef: appearanceCustomizationRef(displaced),
        };
      });
    },
    async connectedFoldersAppearanceReset(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      return runActOperation(async () => {
        const displaced = currentAppearanceCustomization(connectedFolder.id);
        if (displaced === null) {
          // An already-default Connected Folder is an honest no-op that arms no undo.
          return {
            connectedFolder: toActConnectedFolderRef(connectedFolder),
            reset: true as const,
            changed: false,
            priorAppearanceRef: null,
          };
        }
        await state.appearance.removeConnectedFolder(connectedFolder.id);
        appearanceUndoSlots.set(connectedFolder.id, { displaced, result: null });
        await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.appearance.reset", connectedFolder });
        // An open window re-reads its startup state and shows the new look now.
        publishControlHint(state, "connected-folders");
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          reset: true as const,
          changed: true,
          priorAppearanceRef: appearanceCustomizationRef(displaced),
        };
      });
    },
    async connectedFoldersAppearanceUndo(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      const slot = appearanceUndoSlots.get(connectedFolder.id);
      if (!slot) {
        throw new AmpleFileCliError(
          "conflict",
          "No receipted appearance act recorded a prior customization for this Connected Folder in this app run, so there is nothing to undo. Apply a proposal or reset explicitly instead.",
        );
      }
      if (!appearanceCustomizationsEqual(currentAppearanceCustomization(connectedFolder.id), slot.result)) {
        throw new AmpleFileCliError(
          "conflict",
          "This Connected Folder's appearance was changed outside the act lane (for example on the desktop) since the last receipted appearance act, so the recorded prior customization no longer describes what an undo would displace. Apply a proposal or reset explicitly instead.",
        );
      }
      return runActOperation(async () => {
        const next = slot.displaced;
        const stateAfter = next !== null && hasConnectedFolderAppearanceCustomization(next)
          ? await state.appearance.replaceConnectedFolder(connectedFolder.id, next)
          : await state.appearance.removeConnectedFolder(connectedFolder.id);
        const restored = stateAfter.customizations[connectedFolder.id] ?? null;
        // Undo is its own inverse: the displaced and restored refs swap.
        appearanceUndoSlots.set(connectedFolder.id, { displaced: slot.result, result: restored });
        await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.appearance.undo", connectedFolder });
        // An open window re-reads its startup state and shows the new look now.
        publishControlHint(state, "connected-folders");
        return {
          connectedFolder: toActConnectedFolderRef(connectedFolder),
          restored: true as const,
          restoredAppearanceRef: appearanceCustomizationRef(restored),
          displacedAppearanceRef: appearanceCustomizationRef(slot.result),
        };
      });
    },
    async toolsRemove(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const source = input.source.trim();
      if (!source) throw new AmpleFileCliError("usage", "A package source is required.");
      if (input.scope === "connected-folder") {
        const connectedFolder = await resolveConnectedFolder(input.connectedFolder ?? "");
        // Exactly the desktop packages/remove route: project scope requires
        // the Connected Folder's Pi project trust and the per–Connected Folder capability fence.
        const removed = await runActOperation(() => runCapabilityMutation(state, connectedFolder, "project", () =>
          removePiPackage(connectedFolder.connectedFolderRoot, source, {
            scope: "project",
            runtimeProvider: state.runtimeProvider,
          })));
        await recordFacadeAction(state, input.parentTaskId, { command: "tools.remove", connectedFolder });
        return { scope: "connected-folder" as const, connectedFolder: toActConnectedFolderRef(connectedFolder), source, removed };
      }
      // Everywhere scope mutates the user-scope Pi settings every
      // Connected Folder runtime loads. The app-owned management root is the resolution
      // context — the same root the AmpleFile Agent's own runtime
      // uses — and the global capability fence refuses while any agent
      // or compaction work is active anywhere.
      const ampleFileAgentRootScope = { id: ampleFileAgentScopeId, connectedFolderRoot: ampleFileAgentRoot() };
      const removed = await runActOperation(() => runCapabilityMutation(state, ampleFileAgentRootScope, "global", () =>
        removePiPackage(ampleFileAgentRootScope.connectedFolderRoot, source, {
          scope: "user",
          runtimeProvider: state.runtimeProvider,
        })));
      await recordFacadeAction(state, input.parentTaskId, { command: "tools.remove" });
      return { scope: "everywhere" as const, source, removed };
    },
    async connectedFoldersDelete(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = await resolveConnectedFolder(input.connectedFolder);
      if (connectedFolder.location.storage !== "managed") {
        throw new AmpleFileCliError(
          "conflict",
          "Only a managed Connected Folder's folder can be deleted. Removing a linked registration is 'connected-folders unregister'; the folder is yours either way.",
        );
      }
      const context: PreparedActOutcome<ConnectedFolderRemovalResult & {
        recentlyDeleted: { entryId: string; restoreBy: string } | null;
      }> = {};
      await runPreparedAct({
        kind: "connected-folder.delete-folder",
        parameters: { connectedFolderId: connectedFolder.id },
        pins: { connectedFolderId: connectedFolder.id, connectedFolderRoot: connectedFolder.connectedFolderRoot },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "connected-folders.delete", connectedFolder });
      return {
        connectedFolder: toActConnectedFolderRef(connectedFolder),
        storage: "managed" as const,
        removed: true as const,
        cleanupPending: context.outcome?.cleanupPending ?? false,
        recentlyDeleted: context.outcome?.recentlyDeleted ?? null,
      };
    },
    async toolsImportSkill(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = input.scope === "connected-folder" ? await resolveConnectedFolder(input.connectedFolder ?? "") : undefined;
      const source = isAbsolute(input.from) ? resolve(input.from) : resolve(input.cwd, input.from);
      const info = await lstat(source).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile()) {
        throw new AmpleFileCliError("notFound", "The skill bundle must be a regular file on this machine.");
      }
      if (info.size > 100 * 1024 * 1024) {
        throw new AmpleFileCliError("usage", "The skill bundle exceeds the 100 MB archive limit.");
      }
      const bytes = await readFile(source);
      const contentDigest = piSkillBundleContentDigest(bytes);
      const skillNames = await enumerateSkillBundleNames(basename(source), bytes);
      if (connectedFolder) await assertConnectedFolderCapabilityTrust(connectedFolder);
      const scopedConnectedFolder: PreparedActFields = connectedFolder ? { connectedFolderId: connectedFolder.id } : {};
      const context: PreparedActOutcome<PiSkillBundleImportResult> = {};
      await runPreparedAct({
        kind: "capability.skills.import",
        parameters: { source, scope: input.scope, ...scopedConnectedFolder },
        pins: { source, contentDigest, skillNames },
        requestId: input.requestId,
        context,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "tools.import-skill", ...(connectedFolder ? { connectedFolder } : {}) });
      return {
        scope: input.scope,
        ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
        source,
        contentDigest,
        skillNames,
        bundlePath: context.outcome?.bundlePath ?? "",
      };
    },
    async toolsInstall(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = input.scope === "connected-folder" ? await resolveConnectedFolder(input.connectedFolder ?? "") : undefined;
      if (connectedFolder) await assertConnectedFolderCapabilityTrust(connectedFolder);
      const scopedConnectedFolder: PreparedActFields = connectedFolder ? { connectedFolderId: connectedFolder.id } : {};
      const record = async (): Promise<void> => {
        await recordFacadeAction(state, input.parentTaskId, { command: "tools.install", ...(connectedFolder ? { connectedFolder } : {}) });
      };
      const installBundle = async (source: string, contentDigest: string, skillNames: string[]) => {
        const context: PreparedActOutcome<PiSkillBundleImportResult> = {};
        await runPreparedAct({
          kind: "capability.skills.import",
          parameters: { source, scope: input.scope, ...scopedConnectedFolder },
          pins: { source, contentDigest, skillNames },
          requestId: input.requestId,
          context,
        });
        await record();
        return {
          scope: input.scope,
          ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
          source,
          contentDigest,
          skillNames,
          bundlePath: context.outcome?.bundlePath ?? "",
        };
      };
      const installPackage = async (
        parameters: PreparedActFields,
        details: { id: string; version: string; installSource: string },
        resourceSummary: string,
      ) => {
        await runPreparedAct({
          kind: "capability.package.install",
          parameters,
          pins: {
            packageId: details.id,
            version: details.version,
            source: details.installSource,
            scope: input.scope,
            resourceSummary,
          },
          requestId: input.requestId,
        });
        await record();
        return {
          scope: input.scope,
          ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
          source: details.installSource,
          packageId: details.id,
          version: details.version,
          resourceSummary,
          installed: true as const,
        };
      };
      if (input.catalogId !== undefined) {
        // Remote inspection is read-only and can take seconds; it completes
        // before anything is pinned, exactly as the desktop review does.
        const details = await runActOperation(() => state.capabilityRegistry.details(input.catalogId!));
        if (details.sourceKind === "reference") {
          throw new AmpleFileCliError("usage", "This capability is a reference and cannot be installed directly.");
        }
        if (details.sourceKind === "bundle") {
          // An official catalog skill bundle makes bytes runnable as a skill
          // import: the exact built bytes are digest-pinned, and execution
          // rebuilds and re-verifies them.
          const bundle = await runActOperation(() => state.capabilityRegistry.buildOfficialSkillBundle(input.catalogId!));
          const contentDigest = piSkillBundleContentDigest(bundle.bytes);
          const skillNames = details.skills?.length
            ? [...details.skills].sort()
            : await enumerateSkillBundleNames(bundle.fileName, bundle.bytes);
          return installBundle(input.catalogId, contentDigest, skillNames);
        }
        if (!details.installSource || !details.version) {
          throw new AmpleFileCliError(
            "unavailable",
            "AmpleFile cannot pin an exact version for this package source yet, so it cannot install it from here. Install it from Skills & Extensions on the desktop.",
          );
        }
        return installPackage(
          { catalogId: input.catalogId, scope: input.scope, ...scopedConnectedFolder },
          { id: details.id, version: details.version, installSource: details.installSource },
          capabilityResourceSummary(details),
        );
      }
      const identity = npmSourceIdentity(input.source ?? "");
      if (!identity) {
        throw new AmpleFileCliError(
          "unavailable",
          "AmpleFile can pin an exact version only for npm package sources yet, so it cannot install this source from here. Install it from Skills & Extensions on the desktop.",
        );
      }
      const details = await runActOperation(() => state.capabilityRegistry.details(`npm:${identity.packageName}`));
      if (!details.installSource || !details.version) {
        throw new AmpleFileCliError("unavailable", "npm did not report an exact installable version for this package.");
      }
      if (identity.pinnedVersion !== undefined && identity.pinnedVersion !== details.version) {
        throw new AmpleFileCliError(
          "conflict",
          `AmpleFile inspects the latest published version (${details.version}) and installs only that exact version; `
            + `the source pins ${identity.pinnedVersion}. Install without a version pin, or use the inspected version.`,
        );
      }
      return installPackage(
        { source: details.installSource, scope: input.scope, ...scopedConnectedFolder },
        { id: details.id, version: details.version, installSource: details.installSource },
        capabilityResourceSummary(details),
      );
    },
    async toolsSetEnabled(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = input.scope === "connected-folder" ? await resolveConnectedFolder(input.connectedFolder ?? "") : undefined;
      const root = connectedFolder?.connectedFolderRoot ?? ampleFileAgentRoot();
      if (connectedFolder) await assertConnectedFolderCapabilityTrust(connectedFolder);
      const act = await prepareResourceEnable(root, { path: input.path, kind: input.kind, enabled: input.enabled, scope: input.scope, ...(connectedFolder ? { connectedFolderId: connectedFolder.id } : {}) }, state.runtimeProvider);
      await runPreparedAct({ ...act, requestId: input.requestId });
      await recordFacadeAction(state, input.parentTaskId, { command: input.enabled ? "tools.enable" : "tools.disable", ...(connectedFolder ? { connectedFolder } : {}) });
      return { scope: input.scope, ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}), path: String(act.parameters.path), enabled: input.enabled };
    },
    async toolsUpdate(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const connectedFolder = input.scope === "connected-folder" ? await resolveConnectedFolder(input.connectedFolder ?? "") : undefined;
      const source = input.source.trim();
      const identity = npmSourceIdentity(source);
      if (!identity) {
        throw new AmpleFileCliError(
          "unavailable",
          "AmpleFile can pin an exact version only for npm package sources yet, so it cannot update this source from here. Update it from Skills & Extensions on the desktop.",
        );
      }
      // Mirror the update path's configured-scope requirement early so the
      // refusal is honest; the capability fence is not needed for this read.
      const root = connectedFolder ? connectedFolder.connectedFolderRoot : ampleFileAgentRoot();
      const piScope = connectedFolder ? "project" : "user";
      const configured = (await runActOperation(() => listPiPackages(root, state.runtimeProvider)))
        .find((item) => item.source === source && item.scope === piScope);
      if (!configured) {
        throw new AmpleFileCliError("notFound", `Package is not configured in the requested scope: ${source}`);
      }
      if (connectedFolder) await assertConnectedFolderCapabilityTrust(connectedFolder);
      const details = await runActOperation(() => state.capabilityRegistry.details(`npm:${identity.packageName}`));
      if (!details.version) {
        throw new AmpleFileCliError("unavailable", "npm did not report an exact version for this package.");
      }
      const resourceSummary = capabilityResourceSummary(details);
      const scopedConnectedFolder: PreparedActFields = connectedFolder ? { connectedFolderId: connectedFolder.id } : {};
      await runPreparedAct({
        kind: "capability.package.update",
        parameters: { source, scope: input.scope, ...scopedConnectedFolder },
        pins: {
          packageId: details.id,
          version: details.version,
          source,
          scope: input.scope,
          resourceSummary,
        },
        requestId: input.requestId,
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "tools.update", ...(connectedFolder ? { connectedFolder } : {}) });
      return {
        scope: input.scope,
        ...(connectedFolder ? { connectedFolder: toActConnectedFolderRef(connectedFolder) } : {}),
        source,
        packageId: details.id,
        version: details.version,
        resourceSummary,
        updated: true as const,
      };
    },
    async automationsEnable(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const { declaration, digest } = await readAutomationStagingFile(input.proposalPath, input.cwd);
      const enabled = await enableStoredAutomationDeclaration(state, declaration, digest, {
        surface: "cli",
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      await recordFacadeAction(state, input.parentTaskId, { command: "automations.enable" });
      return enabled;
    },
    async recentlyDeletedList() {
      const listing = await runActOperation(() => state.recentlyDeleted.list());
      const registered = new Set((await listConnectedFolders()).map((connectedFolder) => connectedFolder.id));
      const entries: AmpleFileActRecentlyDeletedEntry[] = [];
      for (const entry of listing.entries) entries.push(await recentlyDeletedEntryView(entry, registered));
      return { entries, retentionDays: listing.retentionDays, damagedCount: listing.damaged.length };
    },
    async recentlyDeletedRestore(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const entryId = input.entry.trim();
      if (!ampleFileRecentlyDeletedEntryIdPattern.test(entryId)) {
        throw new AmpleFileCliError("usage", "'--entry' takes a Recently deleted item id from 'recently-deleted list'.");
      }
      const before = await runActOperation(() => state.recentlyDeleted.get(entryId).catch(() => null));
      const restored = await runActOperation(() => restoreRecentlyDeletedEntry(state, entryId, {
        receiptId: input.requestId ?? null,
      }));
      const connectedFolder = "connectedFolder" in restored && restored.connectedFolder ? await getConnectedFolder(restored.connectedFolder.id).catch(() => null) : null;
      await recordFacadeAction(state, input.parentTaskId, {
        command: "recently-deleted.restore",
        ...(connectedFolder ? { connectedFolder } : {}),
      });
      // The entry id is the request's own input; the result reports what came
      // back, with the entry it came from alongside.
      const effect = restored.kind === "connected-folder"
        ? { kind: restored.kind, connectedFolder: restored.connectedFolder, connectedFolderRoot: restored.connectedFolderRoot, renamed: restored.renamed }
        : restored.kind === "skill"
          ? {
            kind: restored.kind,
            scope: restored.scope,
            ...(restored.connectedFolder ? { connectedFolder: restored.connectedFolder } : {}),
            name: restored.name,
            path: restored.path,
          }
          : {
            kind: restored.kind,
            connectedFolder: restored.connectedFolder,
            path: restored.path,
            renamed: restored.renamed,
            safetyCheckpointId: restored.safetyCheckpointId,
          };
      return {
        entry: before ? await recentlyDeletedEntryView(before) : null,
        restored: effect,
      };
    },
    async automationsList() {
      const projections = await runActOperation(() => state.automations.listAutomations());
      return { automations: projections.map(toActAutomationSummary) };
    },
    async automationsModels() {
      const models = await listPiModels(ampleFileAgentScopeForRoutes(state).rootPath, state.runtimeProvider);
      return {
        models: models.filter((model) => model.configured)
          .map((model) => ({ provider: model.provider, providerName: model.providerName, id: model.id, name: model.name, seesImages: model.input.includes("image") }))
          .sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name)),
      };
    },
    async automationsShow(input) {
      const automationId = input.automation.trim();
      const projection = await runActOperation(() => state.automations.getAutomation(automationId));
      if (!projection) throw new AmpleFileCliError("notFound", "No automation has this id on this machine.");
      const connectedFolderNames = new Map<string, string>();
      for (const connectedFolderId of ampleFileAutomationReferencedConnectedFolderIds(projection.declaration)) {
        const registered = await getConnectedFolder(connectedFolderId).catch(() => null);
        if (registered) connectedFolderNames.set(connectedFolderId, registered.name);
      }
      const named = (connectedFolderId: string) => (connectedFolderNames.has(connectedFolderId) ? { connectedFolderName: connectedFolderNames.get(connectedFolderId)! } : {});
      return {
        automation: {
          ...toActAutomationSummary(projection),
          steps: projection.declaration.steps.map((step) => step.kind === "chat"
            ? { id: step.id, kind: "chat" as const, connectedFolderId: step.connectedFolder, ...named(step.connectedFolder), message: step.message, ...(step.model ? { model: step.model } : {}) }
            : step.kind === "files"
              ? {
                id: step.id,
                kind: "files" as const,
                fromConnectedFolderId: step.fromConnectedFolder,
                ...(connectedFolderNames.has(step.fromConnectedFolder) ? { fromConnectedFolderName: connectedFolderNames.get(step.fromConnectedFolder)! } : {}),
                source: toActAutomationFilesSource(step.from),
                toConnectedFolderId: step.toConnectedFolder,
                ...(connectedFolderNames.has(step.toConnectedFolder) ? { toConnectedFolderName: connectedFolderNames.get(step.toConnectedFolder)! } : {}),
                to: step.to,
              }
              : { id: step.id, kind: "agent" as const, message: step.message, ...(step.model ? { model: step.model } : {}) }),
          grants: projection.grants.map((grant) => ({
            digest: grant.digest,
            requestId: grant.requestId,
            enabledAt: grant.enabledAt,
            surface: grant.surface,
          })),
        },
      };
    },
    async automationsRun(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const projection = await runActOperation(() => state.automations.getAutomation(automationId));
      if (!projection) throw new AmpleFileCliError("notFound", "No automation has this id on this machine.");
      const run = await runActOperation(() => state.automations.runNow(automationId, {
        ...(input.requestId ? { requestId: input.requestId } : {}),
      }));
      return {
        automationId,
        title: projection.declaration.title,
        run: {
          runId: run.runId,
          outcome: run.outcome,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          ...(run.error !== undefined ? { error: run.error } : {}),
        },
      };
    },
    async automationsStop(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const stopped = state.automations.stopRun(automationId);
      if (!stopped) {
        throw new AmpleFileCliError("conflict", "This automation has no active run; its settled state already stands.");
      }
      return { automationId, stopped: true as const, runId: stopped.runId };
    },
    async automationsDisable(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const result = await runActOperation(() => state.automations.disable(automationId));
      return {
        automationId,
        disabled: true as const,
        digest: result.record.digest,
        stoppedRunId: result.stoppedRunId,
      };
    },
    async automationsDelete(input) {
      assertAmpleFileAgentParentAccepting(state, input.parentTaskId);
      const automationId = input.automation.trim();
      const record = await runActOperation(() => state.automations.deleteAutomation(automationId));
      if (record.health !== "disabled" && record.health !== "suspended" && record.health !== "completed") {
        throw new AmpleFileCliError("failure", "The automation was deleted in an unexpected health state.");
      }
      return { automationId, deleted: true as const, digest: record.digest, finalHealth: record.health };
    },
    async automationsReceipts(input) {
      const projection = await readAutomationReceiptProjection(input.automation?.trim());
      return { ...projection, receipts: [...projection.receipts].reverse() };
    },
    async agentList() {
      const scope = ampleFileAgentScope(state);
      const conversations = await runActOperation(() => listConversations(scope.rootPath));
      return { conversations: conversations.map(toActConversationRef) };
    },
    async agentSend(input) {
      const content = input.content.trim();
      if (!content) throw new AmpleFileCliError("usage", "Message content is required.");
      const scope = ampleFileAgentScope(state);
      const attachments = await classifyActAmpleFileAgentAttachments(input.attachments ?? [], input.cwd);
      return runActOperation(async () => {
        const conversationId = input.newConversation
          ? (await createConversation(scope.rootPath)).id
          : input.conversationId ?? (await resolveAmpleFileAgentConversation(true)).id;
        const { message, taskId } = await acceptConversationTurn(state, { id: scope.id, connectedFolderRoot: scope.rootPath }, conversationId, {
          content,
          contextPaths: [],
          actorKind: "cli",
          ampleFileAgentAttachments: attachments,
          requestId: input.requestId,
        });
        return { conversationId, messageId: message.id, taskId, attachments };
      });
    },
    async agentConversationStatus(input) {
      const scope = ampleFileAgentScope(state);
      const conversation = input.conversationId
        ? await runActOperation(() => readConversationSummary(scope.rootPath, input.conversationId!))
        : await runActOperation(() => resolveAmpleFileAgentConversation(false).catch(() => null));
      if (!conversation) {
        throw new AmpleFileCliError(
          "notFound",
          input.conversationId ? "Conversation not found." : "No AmpleFile Agent exists yet. Send a message to start one.",
        );
      }
      return {
        conversation: toActConversationRef(conversation),
        state: conversationRuntimeState(state, scope.id, conversation.id),
      };
    },
    async agentTurnStatus(input) {
      assertAmpleFileAgentInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      const record = state.requests.byTaskId(taskId);
      return {
        task: turnStatusFor(state, ampleFileAgentScopeId, taskId),
        request: await ampleFileAgentRequestView(state, taskId),
        waiting: waitingRefForTask(state, taskId),
        requestGraph: record ? toActRequestRef(state, record) : null,
      };
    },
    async agentStop(input) {
      assertAmpleFileAgentInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      return stopAmpleFileAgentRequest(state, taskId);
    },
    async agentConversationResult(input) {
      const scope = ampleFileAgentScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveAmpleFileAgentConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new AmpleFileCliError("notFound", "No AmpleFile Agent exists yet. Send a message to start one.");
      }
      return conversationResultForScope(state, scope.id, scope.rootPath, conversationId, input.messages);
    },
    async agentTurnResult(input) {
      assertAmpleFileAgentInstructionsReady(state);
      const taskId = input.taskId.trim();
      if (!taskId) throw new AmpleFileCliError("usage", "Provide --task <id>.");
      const scope = ampleFileAgentScope(state);
      return turnResultForScope(state, scope.id, scope.rootPath, taskId);
    },
    async agentAbort(input) {
      const scope = ampleFileAgentScope(state);
      const conversationId = input.conversationId
        ?? (await runActOperation(() => resolveAmpleFileAgentConversation(false).catch(() => null)))?.id;
      if (!conversationId) {
        throw new AmpleFileCliError("notFound", "No AmpleFile Agent exists yet. Send a message to start one.");
      }
      const client = state.clients.get(clientKey(scope.id, conversationId));
      return { conversationId, aborted: client ? await client.abort() : false };
    },
    async agentOverview() {
      // Deliberately no management-readiness gate: the overview reads recorded
      // state through the kernel, never the agent, and stays available
      // while the AmpleFile Agent is not.
      return runActOperation(() => state.kernel.getOverview({ kind: "cli" }));
    },
  };
}
