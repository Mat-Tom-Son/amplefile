/**
 * Telling a running automation run's own files apart (docs/automations.md):
 * what its steps' verbs and Pi's write and edit tools placed, moved away, or
 * removed, recorded by device and inode. This is bookkeeping only. Nothing
 * here may change an act's outcome, so every entry point swallows its own
 * failures, synchronous or not, and reserved metadata (`.amplefile/`, `.pi/`)
 * is never content.
 */

import type { PiFileToolWrite } from "../agent/pi-client.js";
import { ampleFileAutomationPlacedFileIds } from "../automations/automation-file-observer.js";
import { resolveConnectedFolderPath } from "../connected-folder.js";
import type { LocalApiState } from "./state.js";

/** Who acted: the Connected Folder the act names, and the turn it names as `--parent-task`. */
export interface AutomationRunAct {
  connectedFolderId?: string;
  parentTaskId?: string;
}

function runAct(act: AutomationRunAct): { connectedFolderId?: string; taskId?: string } {
  return {
    ...(act.connectedFolderId ? { connectedFolderId: act.connectedFolderId } : {}),
    ...(act.parentTaskId ? { taskId: act.parentTaskId } : {}),
  };
}

/** Whether a running automation run counts this act as its own work; false on any failure. */
export function isAutomationRunWork(state: LocalApiState, act: AutomationRunAct): boolean {
  try {
    return (state.automations as LocalApiState["automations"] | undefined)?.countsAsRunWork(runAct(act)) ?? false;
  } catch {
    return false;
  }
}

/**
 * The device and inode of each file at these Connected Folder–relative
 * paths, and inside folders among them. Reserved metadata and anything that
 * cannot be read are left out; it never throws.
 */
export async function connectedFolderFileIds(root: string, paths: readonly string[]): Promise<string[]> {
  try {
    const absolute: string[] = [];
    for (const path of paths) {
      try {
        absolute.push(resolveConnectedFolderPath(root, path));
      } catch {
        // Reserved metadata, or not a Connected Folder path: not content.
      }
    }
    return absolute.length ? await ampleFileAutomationPlacedFileIds(absolute) : [];
  } catch {
    return [];
  }
}

/**
 * Records files an act placed — `placed`, or `moved` here from elsewhere,
 * which also vacated the name they left — and files it removed
 * (`removedIds`, measured before the act), when a running automation run
 * counts the act as its own. It never throws.
 */
export async function noteAutomationRunFiles(
  state: LocalApiState,
  act: AutomationRunAct,
  files: { root: string; placed?: readonly string[]; moved?: readonly string[]; removedIds?: readonly string[] },
): Promise<void> {
  try {
    const hasFiles = Boolean(files.placed?.length || files.moved?.length || files.removedIds?.length);
    if (!hasFiles || !isAutomationRunWork(state, act)) return;
    const placed = files.placed?.length ? await connectedFolderFileIds(files.root, files.placed) : [];
    const moved = files.moved?.length ? await connectedFolderFileIds(files.root, files.moved) : [];
    state.automations.notePlacedFiles({
      ...runAct(act),
      fileIds: [...placed, ...moved],
      vacatedFileIds: [...moved, ...(files.removedIds ?? [])],
    });
  } catch {
    // Bookkeeping never fails an act.
  }
}

/** A file Pi's own write or edit tool touched, in a turn that is a running step's work. It never throws. */
export async function notePiFileToolWrite(state: LocalApiState, event: PiFileToolWrite): Promise<void> {
  try {
    if (!event.taskId || !isAutomationRunWork(state, { parentTaskId: event.taskId })) return;
    const fileIds = await ampleFileAutomationPlacedFileIds([event.path]);
    if (fileIds.length) state.automations.notePlacedFiles({ taskId: event.taskId, fileIds });
  } catch {
    // Bookkeeping never fails a turn.
  }
}
