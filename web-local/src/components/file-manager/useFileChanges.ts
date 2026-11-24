import { useRef, type Dispatch, type SetStateAction } from "react";

import { api, errorText } from "../../lib/api";
import { formatItemCount } from "../../lib/format";
import { deleteLocalFileRequest, deleteLocalFilesRequest, type PendingDelete } from "../../lib/pending-deletes";
import { deleteFolderConfirm, deleteSelectionConfirm } from "../../ui-contract";
import { requestConfirm, showToast } from "../../ui/feedback";
import { fileSelectionLabel } from "../../../../src/shared/file-selection";
import { isExtractableArchive } from "../../../../src/shared/file-menu";
import type { TreeEntry } from "../../types";
import { parentPath } from "./file-manager-model";
import { samePlace, type FileManagerLocation, type FileManagerPlace } from "./file-manager-places";
import { trashChangedEvent } from "./file-manager-trash";
import { copiesLeftMessage, operationTitle, replacedMessage, stoppedMessage, undoCovers, type ConflictPolicy, type FileOperationKind, type TransferAnswer } from "./file-operations-model";
import { historyTurn, isBusyRefusal, isPartialUndo, moveBackPlan, movesUndo, pushUndo, transferConnectedFolderIds, transferLabel, type FileUndo, type MoveBackHost, type PartialUndo, type TransferBody } from "./file-manager-undo";
import { desktopErrorText, hiddenKey } from "./file-manager-view-helpers";
import { OperationStoppedBeforeStart, type OperationHandle, type useFileOperations } from "./useFileOperations";
import type { useConflictQuestion } from "./ConflictDialog";

type TransferResult = TransferAnswer;

/** What the window's file changes need from the folder shown. */
export interface FileChangesContext {
  fixtureMode: boolean;
  place: FileManagerPlace;
  location: FileManagerLocation;
  /** The local API base for the place shown (`/api/connected-folders/…` or `/api/standard-folders/…`). */
  apiBase: string | null;
  selection: readonly string[];
  byPath: ReadonlyMap<string, TreeEntry>;
  listing: { refresh: () => Promise<unknown> };
  standard: { refresh: () => Promise<unknown> };
  fileOperations: ReturnType<typeof useFileOperations>;
  conflictQuestion: ReturnType<typeof useConflictQuestion>;
  select: (paths: string[]) => void;
  setSelection: Dispatch<SetStateAction<string[]>>;
  setHiddenPaths: Dispatch<SetStateAction<ReadonlySet<string>>>;
  nameOfPlace: (place: FileManagerPlace) => string;
  requestRename: (entry: TreeEntry | undefined) => void;
  onError: (message: string | null) => void;
}

/**
 * The window's file changes: copies, moves, Duplicate, Compress, Extract,
 * New Folder with Selection, delete, and rename, each with progress and Stop
 * where it takes a moment, the name-clash question, and ⌘Z and ⇧⌘Z. The
 * undo stacks belong to the window, whichever folder it shows.
 */
export function useFileChanges(context: FileChangesContext) {
  const { fixtureMode, place, location, apiBase, selection, byPath, listing, standard, fileOperations, conflictQuestion, select, setSelection, setHiddenPaths, nameOfPlace, requestRename, onError } = context;
  // ⌘Z and ⇧⌘Z for file changes: each entry undoes one change and returns the entry that redoes it.
  const undoStackRef = useRef<FileUndo[]>([]);
  const redoStackRef = useRef<FileUndo[]>([]);

  function transfer(body: TransferBody & { operationId?: string; conflicts?: ConflictPolicy }, beforeSend?: () => void): Promise<TransferResult> {
    return historyTurn(transferConnectedFolderIds(body), () => { beforeSend?.(); return api<TransferResult>("/api/file-transfer", { method: "POST", body }); });
  }

  /**
   * One operation with progress and Stop (useFileOperations): it carries an
   * `operationId`, shows in the operations area once it takes a moment, and
   * a Stop that comes while it still waits its turn means it never starts.
   */
  async function runOperation(kind: FileOperationKind, title: string, work: (handle: OperationHandle) => Promise<TransferResult>): Promise<TransferResult> {
    try {
      return await fileOperations.run(kind, title, work);
    } catch (caught) {
      if (caught instanceof OperationStoppedBeforeStart) return { written: [], restorePoints: [], cancelled: true, notDone: [] };
      throw caught;
    }
  }

  /**
   * Asks about taken names first (the engine's conflicts-first answer: nothing
   * is written), then runs with the person's choices. Null when they chose Stop.
   */
  /** `verb` may follow the check's answer: a paste learns there whether it moves (a Cut from any window) or copies. */
  async function withConflictChoices(check: () => Promise<TransferResult>, verb: string | ((asked: TransferResult) => string), where: string): Promise<{ policy: ConflictPolicy | undefined } | null> {
    const asked = await check();
    if (asked.nothing) return { policy: undefined };
    if (!asked.conflicts?.length) return { policy: undefined };
    const policy = await conflictQuestion.ask(asked.conflicts, typeof verb === "function" ? verb(asked) : verb, where);
    return policy ? { policy } : null;
  }

  /** A copy, move, or Duplicate with progress, Stop, and (except Duplicate, which keeps both) the name-clash question. */
  async function startTransfer(body: TransferBody, where: string, what: string): Promise<TransferResult | null> {
    const kind: FileOperationKind = body.mode;
    if (body.mode !== "duplicate") {
      const verb = body.mode === "move" ? "Moving" : "Copying";
      const choices = await withConflictChoices(() => api<TransferResult>("/api/file-transfer", { method: "POST", body: { ...body, conflicts: { check: true } } }), verb, where);
      if (!choices) return null;
      return runOperation(kind, operationTitle(kind, what, where), (handle) => transfer({ ...body, operationId: handle.operationId, ...(choices.policy ? { conflicts: choices.policy } : {}) }, handle.beforeSend));
    }
    return runOperation(kind, operationTitle(kind, what, null), (handle) => transfer({ ...body, operationId: handle.operationId }, handle.beforeSend));
  }

  /** What the window says after an operation: what Stop left undone, and where anything replaced went. */
  function reportOutcome(kind: FileOperationKind, result: TransferResult): boolean {
    if (result.cancelled) { showToast({ text: stoppedMessage(kind, result), tone: "info" }); return true; }
    const replaced = replacedMessage(result);
    if (replaced) showToast({ text: replaced, tone: "info", durationMs: 9000 });
    return Boolean(replaced);
  }

  /** Where a folder in a place is, by name, for messages. */
  function folderLabel(target: { place: FileManagerPlace; path: string }): string {
    return target.path ? target.path.slice(target.path.lastIndexOf("/") + 1) : nameOfPlace(target.place);
  }

  /**
   * After any transfer: its undo, a fresh listing, and the new items selected
   * when they are in the folder shown. When a Replace sent something to the
   * Trash, or it is gone, ⌘Z says plainly what it cannot bring back. A move
   * between places, or between plain folders, is undone by moving the items
   * back (file-manager-undo.ts, `moveBackPlan`); everything else through
   * History's restore points.
   */
  async function afterTransfer(result: TransferResult, target: { place: FileManagerPlace; path: string }, label: string, selectWritten: boolean) {
    const covers = undoCovers(result);
    const copiesLeft = target.place.kind === "standard" ? copiesLeftMessage(result, folderLabel(target)) : null;
    const moveBack = moveBackPlan(result, target);
    if (!covers.covered) recordUndo({ label, cannot: covers.why!, run: async () => null });
    else if (moveBack) recordUndo(movesUndo(label, moveBack, moveBackHost));
    // Nothing moved, and copies stayed in a plain folder, which has no History to take them back.
    else if (copiesLeft) recordUndo({ label, cannot: copiesLeft, run: async () => null });
    else if (result.restorePoints.length) recordUndo(restorePointsUndo(label, result.restorePoints));
    await Promise.all([listing.refresh(), standard.refresh()]);
    if (selectWritten && samePlace(target.place, place) && target.path === location.path && result.written.length) select(result.written);
  }

  function recordUndo(entry: FileUndo) {
    undoStackRef.current = pushUndo(undoStackRef.current, entry);
    redoStackRef.current = [];
  }

  /** A change undone outside the stack (the Worker's receipt): ⇧⌘Z redoes it. */
  function recordRedo(entry: FileUndo) {
    redoStackRef.current = pushUndo(redoStackRef.current, entry);
  }

  /** Undo through History: restore each point in turn; the safety points those restores leave are the redo. */
  function restorePointsUndo(label: string, points: Array<{ connectedFolderId: string; checkpointId: string }>): FileUndo {
    return {
      label,
      run: async () => {
        const redo: Array<{ connectedFolderId: string; checkpointId: string }> = [];
        for (const point of points) {
          const restored = await historyTurn([point.connectedFolderId], () => api<{ safetyCheckpointId: string }>(`/api/connected-folders/${encodeURIComponent(point.connectedFolderId)}/history/checkpoints/${encodeURIComponent(point.checkpointId)}/restore`, { method: "POST", body: {} }));
          redo.unshift({ connectedFolderId: point.connectedFolderId, checkpointId: restored.safetyCheckpointId });
        }
        return restorePointsUndo(label, redo);
      },
    };
  }

  /** What undoing a move by moving its items back asks of this window (file-manager-undo.ts, `movesUndo`). */
  const moveBackHost: MoveBackHost = {
    nameOf: folderLabel,
    copiesChanged: async (copies) => (await api<{ changed: number[] }>("/api/file-transfer/copies-changed", { method: "POST", body: { copies } })).changed,
    transfer: (body) => transfer(body),
    restore: (point) => historyTurn([point.connectedFolderId], () => api(`/api/connected-folders/${encodeURIComponent(point.connectedFolderId)}/history/checkpoints/${encodeURIComponent(point.checkpointId)}/restore`, { method: "POST", body: {} })),
  };

  async function undoFileChange(redo = false) {
    const stack = redo ? redoStackRef : undoStackRef;
    const entry = stack.current.at(-1);
    if (!entry) { showToast({ text: redo ? "Nothing to redo" : "Nothing to undo", tone: "info" }); return; }
    stack.current = stack.current.slice(0, -1);
    // A change History cannot put back (an item a Replace sent to the Trash) says so instead of half-undoing.
    if (entry.cannot) { showToast({ text: entry.cannot, tone: "info", durationMs: 9000 }); return; }
    let outcome: FileUndo | PartialUndo | null;
    try {
      outcome = await entry.run();
    } catch (caught) {
      // A step that keeps its place stays where it was only when it was refused because work is still
      // going on: it is run again once that is over. Any other failure ends it, so it never blocks the stack.
      if (entry.resumes && isBusyRefusal(caught)) stack.current = pushUndo(stack.current, entry);
      onError(errorText(caught));
      // What it did before it was refused shows.
      await Promise.all([listing.refresh(), standard.refresh()]).catch(() => undefined);
      return;
    }
    // A step that put back only part of the change says what it did not, in place of "Undid …".
    const partial = isPartialUndo(outcome) ? outcome : null;
    const reverse = partial ? partial.reverse : outcome as FileUndo | null;
    try {
      if (reverse) {
        if (redo) undoStackRef.current = pushUndo(undoStackRef.current, reverse);
        else redoStackRef.current = pushUndo(redoStackRef.current, reverse);
      }
      await Promise.all([listing.refresh(), standard.refresh()]);
      showToast(partial ? { text: partial.said, tone: "info", durationMs: 12000 } : { text: `${redo ? "Redid" : "Undid"} ${entry.label}`, tone: "success" });
    } catch (caught) {
      // The step's own words are not lost to a listing that would not refresh.
      if (partial) showToast({ text: partial.said, tone: "info", durationMs: 12000 });
      onError(errorText(caught));
    }
  }

  /** The selected items Copy, Cut, Duplicate, Compress, and the rest act on: a link as itself, never a nested Connected Folder. */
  function selectedEntries(): TreeEntry[] {
    return selection.map((path) => byPath.get(path)).filter((entry): entry is TreeEntry => Boolean(entry) && !entry!.nestedFolder);
  }

  async function duplicateSelection(entries = selectedEntries()) {
    if (!entries.length) return;
    if (fixtureMode) { showToast({ text: "Duplicating is disabled in the preview", tone: "info" }); return; }
    const target = { place, path: parentPath(entries[0]!.path) };
    try {
      const paths = entries.map((entry) => entry.path);
      const result = await startTransfer({ mode: "duplicate", sources: paths.map((path) => ({ place, path })), target }, folderLabel(target), transferLabel(paths));
      if (!result) return;
      await afterTransfer(result, target, `Duplicate ${transferLabel(paths)}`, true);
      reportOutcome("duplicate", result);
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  async function compressSelection(entries = selectedEntries()) {
    if (!entries.length) return;
    if (fixtureMode) { showToast({ text: "Compressing is disabled in the preview", tone: "info" }); return; }
    const paths = entries.map((entry) => entry.path);
    const at = place;
    try {
      const result = await runOperation("compress", operationTitle("compress", transferLabel(paths), null), (handle) => historyTurn(at.kind === "connected-folder" ? [at.id] : [], () => {
        handle.beforeSend();
        return api<TransferResult>("/api/file-transfer/compress", { method: "POST", body: { place: at, paths, operationId: handle.operationId } });
      }));
      if (reportOutcome("compress", result) && result.cancelled) return;
      if (result.restorePoints.length) recordUndo(restorePointsUndo(`Compress ${transferLabel(paths)}`, result.restorePoints));
      await listing.refresh();
      if (result.path && samePlace(at, place)) select([result.path]);
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /** Empty Trash and Delete Immediately (TrashView): a "delete" operation, with progress and Stop in the operations area. */
  function runTrashDeletion<T>(title: string, request: (operationId: string | null) => Promise<T>): Promise<T> {
    return fileOperations.run("delete", title, (handle) => { handle.beforeSend(); return request(handle.operationId); });
  }

  /**
   * Extract: a `.zip`, `.tar`, `.tar.gz`, or `.tgz` gives its one file or
   * folder beside it, or a new folder named after it holding its several
   * items, with progress, Stop, and the name-clash question when that name is
   * taken; what was made is selected when done.
   */
  async function extractArchive(entry: TreeEntry) {
    if (entry.kind !== "file" || entry.link || !isExtractableArchive(entry.name)) return;
    if (fixtureMode) { showToast({ text: "Extracting is disabled in the preview", tone: "info" }); return; }
    const at = place;
    const where = folderLabel({ place: at, path: parentPath(entry.path) });
    try {
      const choices = await withConflictChoices(() => api<TransferResult>("/api/file-transfer/extract", { method: "POST", body: { place: at, path: entry.path, conflicts: { check: true } } }), "Extracting", where);
      if (!choices) return;
      const result = await runOperation("extract", operationTitle("extract", entry.name, null), (handle) => historyTurn(at.kind === "connected-folder" ? [at.id] : [], () => {
        handle.beforeSend();
        return api<TransferResult>("/api/file-transfer/extract", { method: "POST", body: { place: at, path: entry.path, operationId: handle.operationId, ...(choices.policy ? { conflicts: choices.policy } : {}) } });
      }));
      if (result.cancelled) { reportOutcome("extract", result); return; }
      const label = `Extract ${entry.name}`;
      const covers = undoCovers(result);
      if (!covers.covered) recordUndo({ label, cannot: covers.why!, run: async () => null });
      else if (result.restorePoints.length) recordUndo(restorePointsUndo(label, result.restorePoints));
      await listing.refresh();
      reportOutcome("extract", result);
      if (result.path && samePlace(at, place)) select([result.path]);
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  /** New Folder with Selection: a folder beside the items, the items moved into it, and its name ready to type. */
  async function groupSelection(entries = selectedEntries()) {
    if (entries.length < 1) return;
    if (fixtureMode) { showToast({ text: "Making folders is disabled in the preview", tone: "info" }); return; }
    const parent = parentPath(entries[0]!.path);
    try {
      const created = place.kind === "connected-folder"
        ? (await historyTurn([place.id], () => api<{ folder: { path: string; name: string }; safetyCheckpointId: string }>(`/api/connected-folders/${encodeURIComponent(place.id)}/folders`, { method: "POST", body: { parentPath: parent, name: "New Folder With Items" } })))
        : { folder: await api<{ path: string }>(`/api/standard-folders/${encodeURIComponent(place.id)}/folders`, { method: "POST", body: { parentPath: parent, name: "New Folder With Items" } }), safetyCheckpointId: null };
      const folderPath = created.folder.path;
      const result = await transfer({ mode: "move", sources: entries.map((entry) => ({ place, path: entry.path })), target: { place, path: folderPath } });
      if (place.kind === "connected-folder") {
        const points = [...result.restorePoints, ...(created.safetyCheckpointId ? [{ connectedFolderId: place.id, checkpointId: created.safetyCheckpointId }] : [])];
        recordUndo(restorePointsUndo("New Folder with Selection", points));
      }
      await listing.refresh();
      select([folderPath]);
      requestRename({ name: folderPath.slice(folderPath.lastIndexOf("/") + 1), path: folderPath, kind: "folder" });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  async function deletePaths(paths: readonly string[]) {
    // A link is deleted as itself (Move to Trash in a plain folder; in a Connected Folder it waits in Recently Deleted, since History keeps no copy of a link).
    const entriesToDelete = paths.map((path) => byPath.get(path)).filter((entry): entry is TreeEntry => Boolean(entry) && !entry!.nestedFolder);
    if (!entriesToDelete.length) return;
    if (fixtureMode) { showToast({ text: "Deleting is disabled in the preview", tone: "info" }); return; }
    const trash = place.kind === "standard" ? window.ampleFileDesktop?.standardFolder?.trash : null;
    if (place.kind === "standard" && !trash) { showToast({ text: "Move to Trash is available in the Mac app", tone: "info" }); return; }
    const files = entriesToDelete.filter((entry) => entry.kind === "file").length;
    if (place.kind === "connected-folder" && entriesToDelete.some((entry) => entry.kind === "folder")) {
      const confirmed = entriesToDelete.length === 1
        ? await requestConfirm({ title: deleteFolderConfirm.title(entriesToDelete[0]!.name), body: deleteFolderConfirm.body, confirmLabel: deleteFolderConfirm.confirmLabel, tone: "danger" })
        : await requestConfirm({ title: deleteSelectionConfirm.title(fileSelectionLabel(files, entriesToDelete.length - files)), body: deleteSelectionConfirm.body, confirmLabel: deleteSelectionConfirm.confirmLabel(fileSelectionLabel(files, entriesToDelete.length - files)), tone: "danger" });
      if (!confirmed) return;
    }
    const target = place;
    const keys = entriesToDelete.map((entry) => hiddenKey(target, entry.path));
    setHiddenPaths((current) => new Set([...current, ...keys]));
    setSelection((current) => current.filter((path) => !paths.includes(path)));
    let cancelled = false;
    const unhide = () => { cancelled = true; setHiddenPaths((current) => new Set([...current].filter((key) => !keys.includes(key)))); };
    // ⌘Z while the notice is still up cancels the delete, as the notice's Undo does.
    recordUndo({ label: `Delete ${entriesToDelete.length === 1 ? entriesToDelete[0]!.name : `${entriesToDelete.length} items`}`, run: async () => { unhide(); return null; } });
    const commit = async () => {
      if (cancelled) return;
      try {
        if (target.kind === "standard") {
          const result = await trash!(target.id, entriesToDelete.map((entry) => entry.path));
          if (result.failed) onError(result.failed.error);
          window.dispatchEvent(new Event(trashChangedEvent));
        } else if (target.kind === "connected-folder" && entriesToDelete.length === 1) {
          const pending: PendingDelete = { connectedFolderId: target.id, path: entriesToDelete[0]!.path, name: entriesToDelete[0]!.name, selectedPath: null, deletedTabPaths: new Set() };
          const result = await deleteLocalFileRequest(pending) as { safetyCheckpointId?: string; recentlyDeleted?: { entryId: string } };
          // Once it has happened, ⌘Z brings it back through History, and from Recently Deleted what History could not keep (a link, a large file).
          replaceDeleteUndo(entriesToDelete[0]!.name, target.id, result.safetyCheckpointId, result.recentlyDeleted ? [result.recentlyDeleted.entryId] : []);
        } else if (target.kind === "connected-folder") {
          const result = await deleteLocalFilesRequest(target.id, entriesToDelete.map((entry) => entry.path));
          if (result.failed) onError(result.failed.error);
          replaceDeleteUndo(`${entriesToDelete.length} items`, target.id, result.safetyCheckpointId, result.deleted.flatMap((row) => row.recentlyDeleted ? [row.recentlyDeleted.entryId] : []));
        }
      } catch (caught) {
        onError(desktopErrorText(errorText(caught)));
      } finally {
        await listing.refresh();
        unhide();
      }
    };
    const label = entriesToDelete.length === 1 ? entriesToDelete[0]!.name : formatItemCount(entriesToDelete.length, "item");
    showToast({
      text: target.kind === "standard" ? `Moved ${label} to the Trash` : `Removed ${label}`,
      tone: "success",
      actionLabel: "Undo",
      durationMs: 6500,
      onAction: unhide,
      onClose: (reason) => { if (reason !== "action") void commit(); },
    });
  }

  /**
   * The pending delete's undo, swapped for the real one once the delete has
   * happened: items History could not keep (a link, a large file) come back
   * from Recently Deleted first, then History's restore point puts back the rest.
   */
  function replaceDeleteUndo(name: string, connectedFolderId: string, checkpointId: string | undefined, recentlyDeletedIds: readonly string[] = []) {
    const label = `Delete ${name}`;
    undoStackRef.current = undoStackRef.current.filter((entry) => entry.label !== label);
    const history = checkpointId ? restorePointsUndo(label, [{ connectedFolderId, checkpointId }]) : null;
    if (!recentlyDeletedIds.length) {
      if (history) undoStackRef.current = pushUndo(undoStackRef.current, history);
      return;
    }
    undoStackRef.current = pushUndo(undoStackRef.current, {
      label,
      run: async () => {
        for (const entryId of recentlyDeletedIds) await api(`/api/settings/recently-deleted/${encodeURIComponent(entryId)}/restore`, { method: "POST", body: {} });
        // What came back from Recently Deleted is redone with a new delete, not a restore point.
        if (history) await history.run();
        return null;
      },
    });
  }

  async function renameEntry(entry: TreeEntry, name: string) {
    if (name === entry.name || !apiBase) return;
    const result = await historyTurn(place.kind === "connected-folder" ? [place.id] : [], () => api<{ safetyCheckpointId?: string; path?: string }>(`${apiBase}/rename-local-entry`, { method: "POST", body: { path: entry.path, newName: name } }));
    await listing.refresh();
    const renamed = [parentPath(entry.path), name].filter(Boolean).join("/");
    if (place.kind === "connected-folder" && result.safetyCheckpointId) recordUndo(restorePointsUndo(`Rename ${entry.name}`, [{ connectedFolderId: place.id, checkpointId: result.safetyCheckpointId }]));
    else if (place.kind === "standard") recordUndo(standardRenameUndo(`Rename ${entry.name}`, apiBase, renamed, entry.name, entry.path));
    select([renamed]);
    showToast({ text: `Renamed ${entry.name}`, tone: "success" });
  }

  /** A Standard Folder rename is undone by renaming back. */
  function standardRenameUndo(label: string, base: string, currentPath: string, previousName: string, previousPath: string): FileUndo {
    return {
      label,
      run: async () => {
        await api(`${base}/rename-local-entry`, { method: "POST", body: { path: currentPath, newName: previousName } });
        return standardRenameUndo(label, base, previousPath, currentPath.slice(currentPath.lastIndexOf("/") + 1), currentPath);
      },
    };
  }

  return {
    transfer,
    runOperation,
    withConflictChoices,
    startTransfer,
    reportOutcome,
    folderLabel,
    afterTransfer,
    recordUndo,
    recordRedo,
    restorePointsUndo,
    undoFileChange,
    selectedEntries,
    duplicateSelection,
    compressSelection,
    runTrashDeletion,
    extractArchive,
    groupSelection,
    deletePaths,
    renameEntry,
  };
}

export type FileChanges = ReturnType<typeof useFileChanges>;
