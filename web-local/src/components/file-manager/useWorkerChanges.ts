import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api";
import { queueHistoryRequest } from "../../lib/history-queue";
import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";
import type { ConnectedFolderUiFixture } from "../../fixtures/connected-folder-fixture";
import type { ConnectedFolderCheckpoint, ConnectedFolderSummary } from "../../types";
import type { HistoryRestorePreview } from "../panes/connectedFolderPanes";

/** What a Worker's last reply (or an Automation's run) changed in a Connected Folder, from its "Before turn" restore point. */
export interface WorkerChanges {
  checkpointId: string;
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
 * Change markers and the Worker's receipt (owner request, 2026-11-07): after
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
      const checkpoints = fixture
        ? fixture.checkpoints[connectedFolderId] ?? []
        // History requests wait their turn: the host turns away a second one while the first runs.
        : (await queueHistoryRequest(connectedFolderId, () => api<{ checkpoints: ConnectedFolderCheckpoint[] }>(`/api/connected-folders/${encodeURIComponent(connectedFolderId)}/history/checkpoints?limit=12`)).catch(() => ({ checkpoints: [] as ConnectedFolderCheckpoint[] }))).checkpoints;
      const turn = checkpoints.find((checkpoint) => turnReasons.has(checkpoint.reason) || checkpoint.label === "Before turn");
      if (!turn || dismissed[connectedFolderId] === turn.checkpointId) return;
      if (!fixture && Date.now() - Date.parse(turn.createdAt) > freshForMs) return;
      const preview = fixture
        ? fixture.restorePoints[turn.checkpointId]?.preview ?? null
        : await queueHistoryRequest(connectedFolderId, () => api<{ preview: HistoryRestorePreview }>(`/api/connected-folders/${encodeURIComponent(connectedFolderId)}/history/checkpoints/${encodeURIComponent(turn.checkpointId)}/preview`)).then((body) => body.preview).catch(() => null);
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

  return useMemo(() => ({ changes, done }), [changes, done]);
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
