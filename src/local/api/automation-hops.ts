/**
 * What an Automation's steps do through the local API: the hop ports for
 * chat, files, and agent steps, resolving the files a step names, and
 * measuring them.
 */

import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConversation } from "../agent/chat-store.js";
import { listPiModels } from "../agent/pi-runtime-config.js";
import { getConnectedFolderCheckpoint } from "../history.js";
import { resolveFolderTargets } from "../automations/folder-targets.js";
import { ampleFileAutomationBounds } from "../automations/automation-declarations.js";
import type { AmpleFileAutomationHopPorts } from "../automations/automation-service.js";
import {
  copyPathIntoConnectedFolder,
  getConnectedFolder,
  resolveConnectedFolderPath,
  withConnectedFolderHistoryOperations,
  withConnectedFolderTouchBatch,
} from "../connected-folder.js";
import { ampleFileAgentScopeForRoutes } from "./amplefile-agent-routes.js";
import { getClient } from "./conversation-clients.js";
import { httpError } from "./http.js";
import { completedRequestEnvelope, turnReportedResult, waitForSettledRequest } from "./request-records.js";
import { checkpointAdditiveWritesOrUndo, reserveCapabilityMutation } from "./reservations.js";
import type { LocalApiState, TurnCheckpointEvent } from "./state.js";
import { acceptConversationTurn } from "./turn-acceptance.js";

/**
 * The automation executor's hop ports: the same in-process internals the act
 * facade uses — turn acceptance in a fresh Chat, a new thread of the
 * AmpleFile Agent, and the files-add copy with its restore point — honoring
 * aborts through each domain's own abort path,
 * and returning identifiers and counts only. The executor fills every
 * placeholder before it calls a message port, so `message` is exactly what
 * the hop sends.
 */
export function createAutomationHopPorts(state: LocalApiState): AmpleFileAutomationHopPorts {
  return {
    async chat(step, message, context) {
      const connectedFolder = await getConnectedFolder(step.connectedFolder);
      const conversation = await createConversation(connectedFolder.connectedFolderRoot);
      // A step's own model applies to this new Chat only: Pi records it in the
      // session without touching the Connected Folder's or anyone's defaults.
      if (step.model) await (await getClient(state, connectedFolder.id, connectedFolder.connectedFolderRoot, conversation.id)).setModel(step.model.provider, step.model.id);
      const checkpoints: { pre?: string; post?: string } = {};
      const observer = (event: TurnCheckpointEvent): void => {
        if (event.connectedFolderId !== connectedFolder.id || event.conversationId !== conversation.id) return;
        if (event.reason === "pre_turn") checkpoints.pre ??= event.checkpointId;
        else checkpoints.post = event.checkpointId;
      };
      state.turnCheckpointListeners.add(observer);
      try {
        const { taskId } = await acceptConversationTurn(state, connectedFolder, conversation.id, {
          content: message,
          contextPaths: [],
          actorKind: "system",
          automationSource: { automationId: context.automationId, title: context.title },
        });
        const settled = await waitForSettledRequest(state, connectedFolder.id, conversation.id, taskId, context.signal);
        const result = await completedRequestEnvelope(state, taskId);
        return {
          conversationId: conversation.id,
          turnTaskId: taskId,
          outcome: settled.status,
          result,
          ...(result && turnReportedResult(state, taskId) ? { reported: result } : {}),
          ...(settled.error !== undefined ? { error: settled.error } : {}),
          ...(checkpoints.pre !== undefined ? { preCheckpointId: checkpoints.pre } : {}),
          ...(checkpoints.post !== undefined ? { postCheckpointId: checkpoints.post } : {}),
        };
      } finally {
        state.turnCheckpointListeners.delete(observer);
      }
    },
    // An agent hop always opens a *new* thread, never the person's live
    // management thread: standing behavior must not entangle a conversation
    // someone is in the middle of, and turn-conflict rejection stays exact.
    // The acceptance shape is byte-for-byte the one `agent send` uses.
    async ampleFileAgent(step, message, context) {
      if (state.ampleFileAgentInstructionsError) {
        throw new Error("The AmpleFile Agent is unavailable because AmpleFile could not prepare its instructions.");
      }
      const scope = ampleFileAgentScopeForRoutes(state);
      const conversation = await createConversation(scope.rootPath);
      if (step.model) await (await getClient(state, scope.id, scope.rootPath, conversation.id)).setModel(step.model.provider, step.model.id);
      const { taskId } = await acceptConversationTurn(state, { id: scope.id, connectedFolderRoot: scope.rootPath }, conversation.id, {
        content: message,
        contextPaths: [],
        actorKind: "system",
        ampleFileAgentAttachments: [],
        automationSource: { automationId: context.automationId, title: context.title },
      });
      const settled = await waitForSettledRequest(state, scope.id, conversation.id, taskId, context.signal);
      return {
        conversationId: conversation.id,
        turnTaskId: taskId,
        outcome: settled.status,
        result: await completedRequestEnvelope(state, taskId),
        ...(settled.error !== undefined ? { error: settled.error } : {}),
      };
    },
    async modelProblem(model, scope) {
      const root = "connectedFolder" in scope ? (await getConnectedFolder(scope.connectedFolder)).connectedFolderRoot : ampleFileAgentScopeForRoutes(state).rootPath;
      const known = (await listPiModels(root, state.runtimeProvider)).find((item) => item.provider === model.provider && item.id === model.id);
      if (!known) return `AmpleFile does not know the model ${model.id} from ${model.provider}. Choose one Settings → AI Models lists.`;
      if (!known.configured) return `${known.name} needs ${known.providerName} connected in Settings → AI Models first.`;
      return null;
    },
    async files(step, source, context) {
      // Both folders' History is claimed at once before either is reserved,
      // so a hop waiting for History holds no turns off in either folder.
      const claimed = await Promise.all([getConnectedFolder(step.fromConnectedFolder), getConnectedFolder(step.toConnectedFolder)]);
      return withConnectedFolderHistoryOperations(claimed.map((connectedFolder) => connectedFolder.connectedFolderRoot), async () => {
        const reserved: string[] = [];
        try {
          for (const id of [...new Set([step.fromConnectedFolder, step.toConnectedFolder])].sort()) {
            reserveCapabilityMutation(state, id, "project", id);
            reserved.push(id);
          }
          // A files hop is deliberately not interruptible mid-copy: it completes
          // with its restore point or fails as one unit, so the signal is only a
          // pre-flight refusal here.
          if (context.signal.aborted) throw new Error("The run was aborted before this hop copied anything.");
          const from = await getConnectedFolder(step.fromConnectedFolder);
          const to = await getConnectedFolder(step.toConnectedFolder);
          if (from.connectedFolderRoot !== claimed[0]!.connectedFolderRoot || to.connectedFolderRoot !== claimed[1]!.connectedFolderRoot) {
            throw httpError(409, "A Connected Folder in this hop moved while it waited. Try again in a moment.");
          }
          const absoluteSources = await resolveAutomationFilesSources(from.connectedFolderRoot, source);
          const copied: string[] = [];
          try {
            await withConnectedFolderTouchBatch(async () => {
              for (const sourcePath of absoluteSources) {
                copied.push(await copyPathIntoConnectedFolder(sourcePath, to.connectedFolderRoot, step.to));
              }
            });
          } catch (error) {
            // A mid-batch failure must not strand earlier copies without a
            // restore point: undo them best-effort, then surface the failure.
            await Promise.all(copied.map((path) =>
              rm(resolveConnectedFolderPath(to.connectedFolderRoot, path), { recursive: true, force: true }).catch(() => undefined)));
            throw error;
          }
          const safety = await checkpointAdditiveWritesOrUndo(to.connectedFolderRoot, copied, {
            reason: "pre_add",
            label: `Before automation hop ${step.id} added ${copied.length} item${copied.length === 1 ? "" : "s"}`,
          });
          const measured = await measureConnectedFolderEntries(to.connectedFolderRoot, copied);
          return {
            ...(safety ? { restorePointId: safety.checkpointId } : {}),
            copiedPaths: copied,
            fileCount: measured.fileCount,
            totalBytes: measured.totalBytes,
          };
        } finally { for (const id of reserved) state.capabilityMutations.delete(id); }
      });
    },
    async checkpointManifest(connectedFolderId, checkpointId) {
      const connectedFolder = await getConnectedFolder(connectedFolderId).catch(() => null);
      if (!connectedFolder) return null;
      const checkpoint = await getConnectedFolderCheckpoint(connectedFolder.connectedFolderRoot, checkpointId);
      if (!checkpoint) return null;
      return {
        files: checkpoint.files.map((file) => ({
          path: file.path,
          hashSha256: file.hashSha256,
          sizeBytes: file.sizeBytes,
        })),
        skippedFilePaths: checkpoint.skippedFiles.map((file) => file.path),
      };
    },
  };
}

/**
 * Resolves an automation files hop's source selection inside the source Connected Folder:
 * exact paths under the ordinary Connected Folder path policy (no symbolic links, no
 * reserved segments), or the bounded tree selector through the folder target
 * resolver's discipline and the automation handoff bounds.
 */
async function resolveAutomationFilesSources(
  fromConnectedFolderRoot: string,
  source: Parameters<AmpleFileAutomationHopPorts["files"]>[1],
): Promise<string[]> {
  if (source.kind === "paths") {
    if (source.paths.length === 0) throw new Error("The files hop resolved no source paths.");
    if (source.paths.length > ampleFileAutomationBounds.maxHandoffFiles) {
      throw new Error(`The files hop names ${source.paths.length} paths, more than the ${ampleFileAutomationBounds.maxHandoffFiles}-file bound.`);
    }
    const absolute: string[] = [];
    for (const raw of source.paths) {
      const path = resolveConnectedFolderPath(fromConnectedFolderRoot, raw);
      const info = await lstat(path).catch(() => null);
      if (!info) throw new Error(`Source not found in the source Connected Folder: ${raw}.`);
      if (info.isSymbolicLink()) throw new Error(`Symbolic-link sources cannot be copied: ${raw}.`);
      if (!info.isFile() && !info.isDirectory()) throw new Error(`Only files and folders can be copied: ${raw}.`);
      absolute.push(path);
    }
    return absolute;
  }
  const resolution = await resolveFolderTargets(fromConnectedFolderRoot, [{
    kind: "tree",
    role: "primary",
    path: source.path,
    recursive: source.recursive,
    extensions: [...source.extensions],
  }], {
    limits: {
      maxFiles: ampleFileAutomationBounds.maxHandoffFiles,
      maxTotalBytes: ampleFileAutomationBounds.maxHandoffTotalBytes,
    },
  });
  return resolution.files.map((file) => file.absolutePath);
}

const maxAutomationMeasureEntries = 10_000;

/** Bounded evidence measurement of copied destinations: files and bytes. */
async function measureConnectedFolderEntries(
  connectedFolderRoot: string,
  relativePaths: string[],
): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  let visited = 0;
  const visit = async (path: string): Promise<void> => {
    if (visited >= maxAutomationMeasureEntries) return;
    visited += 1;
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) {
      fileCount += 1;
      totalBytes += info.size;
      return;
    }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(path).catch(() => [] as string[])) {
      await visit(join(path, entry));
    }
  };
  for (const relativePath of relativePaths) {
    await visit(resolveConnectedFolderPath(connectedFolderRoot, relativePath));
  }
  return { fileCount, totalBytes };
}
