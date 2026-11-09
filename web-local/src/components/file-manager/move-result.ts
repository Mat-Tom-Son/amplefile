/**
 * What a move between places left undone, from the file-transfer answer.
 *
 * - `notRemoved`: paths copied to the target that are also still in the
 *   source (the move stopped removing them).
 * - `failed`: the item whose removal failed and why; it is also the first
 *   entry of `notRemoved`, so it is a reason, never a separate count.
 * - `recentlyDeleted`: what History could not keep from the source, set
 *   aside in Recently Deleted.
 *
 * Every item named in the answer is in the target. Anything that does not
 * match this shape is ignored rather than guessed at.
 */
export interface MoveShortfall {
  notRemoved: string[];
  failed: { path: string; error: string } | null;
  recentlyDeleted: Array<{ path: string; entryId: string; restoreBy: string }>;
}

export function moveShortfall(result: unknown): MoveShortfall {
  const body = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const notRemoved = Array.isArray(body.notRemoved) ? body.notRemoved.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  const failedValue = body.failed as Record<string, unknown> | undefined;
  const failed = failedValue && typeof failedValue === "object" && typeof failedValue.path === "string" && typeof failedValue.error === "string"
    ? { path: failedValue.path, error: failedValue.error }
    : null;
  const recentlyDeleted = Array.isArray(body.recentlyDeleted)
    ? body.recentlyDeleted.flatMap((item) => {
      const entry = item as Record<string, unknown> | null;
      return entry && typeof entry.path === "string" && typeof entry.entryId === "string" && typeof entry.restoreBy === "string"
        ? [{ path: entry.path, entryId: entry.entryId, restoreBy: entry.restoreBy }]
        : [];
    })
    : [];
  return { notRemoved, failed, recentlyDeleted };
}

/** The toast after a move: plain about anything that did not go as asked. */
export function moveResultMessage(label: string, targetName: string, sourceName: string, result: unknown): { text: string; tone: "success" | "info" } {
  const { notRemoved, failed, recentlyDeleted } = moveShortfall(result);
  if (!notRemoved.length && !failed && !recentlyDeleted.length) return { text: `Moved ${label} to ${targetName}`, tone: "success" };
  const sentences: string[] = [];
  const stillInSource = notRemoved.length ? notRemoved : failed ? [failed.path] : [];
  if (stillInSource.length) {
    const count = stillInSource.length === 1 ? "1 item is" : `${stillInSource.length} items are`;
    sentences.push(`Copied ${label} to ${targetName}, but ${count} also still in ${sourceName}: ${names(stillInSource)}.`);
    if (failed) sentences.push(`Removing ${basename(failed.path)} failed: ${failed.error.replace(/\.$/, "")}.`);
  } else {
    sentences.push(`Moved ${label} to ${targetName}.`);
  }
  if (recentlyDeleted.length) sentences.push(`What History could not keep from ${sourceName} is in Recently Deleted: ${names(recentlyDeleted.map((item) => item.path))}.`);
  return { text: sentences.join(" "), tone: stillInSource.length ? "info" : "success" };
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function names(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).map(basename).join(", ");
  return `${shown}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;
}
