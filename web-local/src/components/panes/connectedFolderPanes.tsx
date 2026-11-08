
import type { ConnectedFolderCheckpoint } from "../../types";

export interface HistoryRestorePreview {
  checkpointId: string;
  scope: "full" | "targeted";
  restoreFiles: string[];
  removePaths: string[];
  moves: Array<{ fromPath: string; toPath: string }>;
  excludedPaths: string[];
  uncoveredPaths: string[];
  conflicts: string[];
}

// Saved labels predate the plain words; older ones still say "turn" or "Assistant".
const restorePointTitles: Record<string, string> = {
  "Before turn": "Before a Worker reply",
  "After turn": "After a Worker reply",
  "Before Assistant turn": "Before a Worker reply",
  "After Assistant turn": "After a Worker reply",
  "Manual Restore Point": "Saved by you",
};

/** A restore point's name in the words the rest of the app uses. */
export function restorePointTitle(item: Pick<ConnectedFolderCheckpoint, "label" | "reason">): string {
  const label = item.label?.trim() || item.reason;
  // The host names the safety point taken before a restore after the restore
  // point's id ("Before restoring cp-20261107013801-1a2b3c4d"); the id means nothing to a person.
  if (/^Before restoring cp-\d{14}-[0-9a-f]{8}$/u.test(label)) return "Before restoring";
  return restorePointTitles[label] ?? label;
}

export { AiModelsPane, type ModelScope } from "./AiModelsPane";
