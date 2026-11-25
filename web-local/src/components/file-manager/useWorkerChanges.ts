import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api";
import { queueHistoryRequest } from "../../lib/history-queue";
import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";
import type { ConnectedFolderUiFixture } from "../../fixtures/connected-folder-fixture";
import type { ConnectedFolderCheckpoint, ConnectedFolderSummary } from "../../types";
import type { HistoryRestorePreview } from "../panes/connectedFolderPanes";

/**
 * What a Worker's last reply (or an Automation's Chat step) changed in a
 * Connected Folder: its "Before turn" restore point compared with its "After
 * turn" one, so nothing changed after the turn is counted.
 */
export interface WorkerChanges {
  /** The turn's "Before turn" restore point. */
  checkpointId: string;
  /** The turn's "After turn" restore point; absent only in the sample window. */
  afterCheckpointId?: string;
  createdAt: string;
  added: string[];
  moved: Array<{ from: string; to: string }>;
  changed: string[];
  /** Every path that now holds something the Worker added, moved, or changed. */
  paths: ReadonlySet<string>;
}

const dismissedKey = "amplefile.file-manager.worker-changes-done.v1";
const turnReasons = new Set(["pre_turn", "before_turn"]);
/** A receipt older than this is history, not news. */
const freshForMs = 24 * 60 * 60 * 1_000;

/**
 * Change markers and the Worker's receipt: after
 * a Worker reply or an Automation run, the files it added, moved, or changed
 * are marked in the list and summed up in Info, with Undo (History's restore)
 * and Done (the receipt and markers go away, and stay away for that reply).
 */
export function useWorkerChanges(connectedFolder: ConnectedFolderSummary | null, fixture: ConnectedFolderUiFixture | null, refreshKey: unknown) {
  const [changes, setChanges] = useState<WorkerChanges | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, string>>(() => readStoredJsonValue(dismissedKey, (value) => value && typeof value === "object" ? value as Record<string, string> : {}, {}));
  const connectedFolderId = connectedFolder?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    setChanges(null);
    if (!connectedFolderId) return;
    void (async () => {
      if (!fixture) {
        // History requests wait their turn: the host turns away a second one while the first runs.
        const body = await queueHistoryRequest(connectedFolderId, () => api<{ changes: WorkerTurnChanges | null }>(`/api/connected-folders/${encodeURIComponent(connectedFolderId)}/history/worker-changes`)).catch(() => ({ changes: null }));
        const turn = body.changes;
        if (cancelled || !turn || dismissed[connectedFolderId] === turn.beforeCheckpointId) return;
        if (Date.now() - Date.parse(turn.settledAt) > freshForMs) return;
        const summary = workerChangesFromTurn(turn);
        if (summary) setChanges(summary);
        return;
      }
      const turn = (fixture.checkpoints[connectedFolderId] ?? []).find((checkpoint) => turnReasons.has(checkpoint.reason) || checkpoint.label === "Before turn");
      if (!turn || dismissed[connectedFolderId] === turn.checkpointId) return;
      const preview = fixture.restorePoints[turn.checkpointId]?.preview ?? null;
      if (cancelled || !preview) return;
      const summary = workerChangesFrom(turn, preview);
      if (summary) setChanges(summary);
    })();
    return () => { cancelled = true; };
  }, [connectedFolderId, fixture, refreshKey, dismissed]); // eslint-disable-line react-hooks/exhaustive-deps

  const done = useCallback(() => {
    if (!connectedFolderId || !changes) return;
    const next = { ...dismissed, [connectedFolderId]: changes.checkpointId };
    setDismissed(next);
    writeStoredJsonValue(dismissedKey, next);
    setChanges(null);
  }, [changes, dismissed, connectedFolderId]);

  /** Undo puts back only what the turn changed and is still as it left; the host says what it kept. */
  const undo = useCallback(async (): Promise<WorkerChangesUndo> => {
    if (!connectedFolderId || !changes?.afterCheckpointId) throw new Error("There is nothing to undo.");
    const before = changes.checkpointId;
    const after = changes.afterCheckpointId;
    return queueHistoryRequest(connectedFolderId, () => api<WorkerChangesUndo>(`/api/connected-folders/${encodeURIComponent(connectedFolderId)}/history/worker-changes/undo`, { method: "POST", body: { beforeCheckpointId: before, afterCheckpointId: after } }));
  }, [changes, connectedFolderId]);

  return useMemo(() => ({ changes, done, undo }), [changes, done, undo]);
}

/** What the host says the last Worker turn here changed (src/local/history.ts, `compareConnectedFolderTurnCheckpoints`). */
export interface WorkerTurnChanges {
  beforeCheckpointId: string;
  afterCheckpointId: string;
  settledAt: string;
  added: string[];
  changed: string[];
  removed: string[];
  moved: Array<{ fromPath: string; toPath: string }>;
}

/** The Worker receipt's Undo: its own restore point (for redo), what it put back, and what it kept because it changed again. */
export interface WorkerChangesUndo {
  safetyCheckpointId: string;
  undone: string[];
  kept: string[];
}

/** The receipt for one turn: what it added, moved, and changed (a file it removed is listed as changed, as before). */
export function workerChangesFromTurn(turn: WorkerTurnChanges): WorkerChanges | null {
  const moved = turn.moved.map((move) => ({ from: move.fromPath, to: move.toPath }));
  const changed = [...turn.changed, ...turn.removed].sort((a, b) => a.localeCompare(b));
  if (!turn.added.length && !moved.length && !changed.length) return null;
  return {
    checkpointId: turn.beforeCheckpointId,
    afterCheckpointId: turn.afterCheckpointId,
    createdAt: turn.settledAt,
    added: turn.added,
    moved,
    changed,
    paths: new Set([...turn.added, ...moved.map((move) => move.to), ...turn.changed]),
  };
}

/** The receipt for one restore point's preview: what is here now that was not, or was elsewhere, or was different. */
export function workerChangesFrom(checkpoint: Pick<ConnectedFolderCheckpoint, "checkpointId" | "createdAt">, preview: Pick<HistoryRestorePreview, "restoreFiles" | "removePaths" | "moves">): WorkerChanges | null {
  const moved = preview.moves.map((move) => ({ from: move.toPath, to: move.fromPath }));
  const added = preview.removePaths.filter((path) => !moved.some((move) => move.to === path));
  const changed = preview.restoreFiles.filter((path) => !added.includes(path) && !moved.some((move) => move.to === path || move.from === path));
  if (!added.length && !moved.length && !changed.length) return null;
  return {
    checkpointId: checkpoint.checkpointId,
    createdAt: checkpoint.createdAt,
    added,
    moved,
    changed,
    paths: new Set([...added, ...moved.map((move) => move.to), ...changed]),
  };
}

/** A row is marked when it, or anything inside it, is one of the changed paths. */
export function isMarkedPath(path: string, changedPaths: ReadonlySet<string>): boolean {
  if (changedPaths.has(path)) return true;
  const prefix = `${path}/`;
  for (const changed of changedPaths) if (changed.startsWith(prefix)) return true;
  return false;
}

/** "3 added · 9 moved · 2 changed" */
export function workerChangesSummary(changes: Pick<WorkerChanges, "added" | "moved" | "changed">): string {
  return [
    changes.added.length ? `${changes.added.length} added` : "",
    changes.moved.length ? `${changes.moved.length} moved` : "",
    changes.changed.length ? `${changes.changed.length} changed` : "",
  ].filter(Boolean).join(" · ");
}
