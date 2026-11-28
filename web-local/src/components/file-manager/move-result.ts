/**
 * What a move between places left undone, from the file-transfer answer.
 *
 * - `notRemoved`: paths copied to the target that are also still in the
 *   source, whole (the move could not take them out).
 * - `failures`: every item that did not move, and why. One not in
 *   `notRemoved` is only in the source: its copy was taken back. `failed` is
 *   the first of them, as an answer with one failure gives it.
 * - `partlyRemoved`: items that moved, but part of whose original could not
 *   be removed and is still in the source.
 * - `recentlyDeleted`: items whose originals went to Recently Deleted
 *   because History could not keep all of them. It can also name an item a
 *   release across disks stopped partway on: the whole item is then kept
 *   there too, and that item's own reason already says so.
 * - `duplicateIdentities`: target paths of `.amplefile` folders the move could
 *   not drop from a copy whose original is still in the source, so the same
 *   Connected Folder identity is in both places.
 *
 * Anything that does not match this shape is ignored rather than guessed at.
 */
export interface MoveShortfall {
  notRemoved: string[];
  failed: { path: string; error: string } | null;
  failures: Array<{ path: string; error: string }>;
  partlyRemoved: Array<{ path: string; error: string }>;
  recentlyDeleted: Array<{ path: string; entryId: string; restoreBy: string }>;
  duplicateIdentities: string[];
}

function reasoned(value: unknown): Array<{ path: string; error: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = item as Record<string, unknown> | null;
    return entry && typeof entry === "object" && typeof entry.path === "string" && typeof entry.error === "string" ? [{ path: entry.path, error: entry.error }] : [];
  });
}

export function moveShortfall(result: unknown): MoveShortfall {
  const body = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const notRemoved = Array.isArray(body.notRemoved) ? body.notRemoved.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  const failed = reasoned([body.failed])[0] ?? null;
  const listed = reasoned(body.failures);
  const failures = listed.length ? listed : failed ? [failed] : [];
  const recentlyDeleted = Array.isArray(body.recentlyDeleted)
    ? body.recentlyDeleted.flatMap((item) => {
      const entry = item as Record<string, unknown> | null;
      return entry && typeof entry.path === "string" && typeof entry.entryId === "string" && typeof entry.restoreBy === "string"
        ? [{ path: entry.path, entryId: entry.entryId, restoreBy: entry.restoreBy }]
        : [];
    })
    : [];
  const duplicateIdentities = Array.isArray(body.duplicateIdentities)
    ? body.duplicateIdentities.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return { notRemoved, failed, failures, partlyRemoved: reasoned(body.partlyRemoved), recentlyDeleted, duplicateIdentities };
}

/**
 * The toast after a move: plain about anything that did not go as asked.
 * `sourceName` is the folder the items came from, as `targetName` is the
 * folder they went to. An item in both places is said to have been copied,
 * and only it: the items that did leave their folder are said to have moved.
 */
export function moveResultMessage(label: string, targetName: string, sourceName: string, result: unknown): { text: string; tone: "success" | "info" } {
  const { notRemoved, failures, partlyRemoved, recentlyDeleted, duplicateIdentities } = moveShortfall(result);
  if (!notRemoved.length && !failures.length && !partlyRemoved.length && !recentlyDeleted.length && !duplicateIdentities.length) return { text: `Moved ${label} to ${targetName}`, tone: "success" };
  const sentences: string[] = [];
  // In both places, and only in the source (a replacement that was not made).
  const inBoth = notRemoved;
  const onlyInSource = failures.map((failure) => failure.path).filter((path) => !notRemoved.includes(path));
  const written = (result as { written?: unknown } | null)?.written;
  const nothingArrived = Array.isArray(written) && written.length === 0;
  if (inBoth.length) {
    // What did leave its folder: the answer's own list of moves, or, from an
    // answer without one, how many more arrived than are in both places.
    const moved = movedItems(result);
    const movedCount = moved?.length ?? (Array.isArray(written) ? Math.max(0, written.length - inBoth.length) : 0);
    if (movedCount) sentences.push(`Moved ${moved?.length === 1 ? basename(moved[0]!) : `${movedCount} ${movedCount === 1 ? "item" : "items"}`} to ${targetName}.`);
    sentences.push(inBoth.length === 1
      ? `Copied ${basename(inBoth[0]!)} to ${targetName}; the original is still in ${sourceName}.`
      : `Copied ${inBoth.length} items to ${targetName}; the originals are still in ${sourceName}: ${names(inBoth)}.`);
  } else if (onlyInSource.length && nothingArrived) {
    sentences.push(`Nothing was moved to ${targetName}.`);
  } else {
    sentences.push(`Moved ${label} to ${targetName}.`);
  }
  if (onlyInSource.length) sentences.push(`${onlyInSource.length === 1 ? "1 item was" : `${onlyInSource.length} items were`} not moved and ${onlyInSource.length === 1 ? "is" : "are"} still in ${sourceName}: ${names(onlyInSource)}.`);
  // Why, for the first two; a reason that names its own item stands as it is.
  for (const failure of failures.slice(0, 2)) sentences.push(reasonSentence(failure, (name, error) => `Removing ${name} failed: ${error}.`));
  if (failures.length > 2) sentences.push(`${failures.length - 2} more could not be moved either.`);
  for (const left of partlyRemoved.slice(0, 2)) sentences.push(reasonSentence(left, (name, error) => `Part of ${name} could not be removed from ${sourceName} and is still there: ${error}.`));
  if (partlyRemoved.length > 2) sentences.push(`Part of ${partlyRemoved.length - 2} more could not be removed from ${sourceName} either.`);
  // An item named above that is also in Recently Deleted is one whose release
  // stopped partway; its reason already says the whole item is kept there.
  const told = new Set([...failures, ...partlyRemoved].map((item) => item.path));
  const setAside = recentlyDeleted.filter((item) => !told.has(item.path));
  if (setAside.length) sentences.push(`What History could not keep from ${sourceName} is in Recently Deleted: ${names(setAside.map((item) => item.path))}.`);
  if (duplicateIdentities.length) {
    const folders = duplicateIdentities.map((path) => path.replace(/\/?\.amplefile$/, "") || targetName);
    const shown = `${folders.slice(0, 3).join(", ")}${folders.length > 3 ? ` and ${folders.length - 3} more` : ""}`;
    sentences.push(`AmpleFile could not remove the Connected Folder identity from the ${folders.length === 1 ? "copy" : "copies"} in ${targetName} (${shown}), so it is also still in ${sourceName}. Connect only one of them.`);
  }
  return { text: sentences.join(" "), tone: failures.length || partlyRemoved.length || duplicateIdentities.length ? "info" : "success" };
}

/** The source paths the answer says left their folder, or null when it does not list them. */
function movedItems(result: unknown): string[] | null {
  const moves = (result as { moves?: unknown } | null)?.moves;
  if (!Array.isArray(moves)) return null;
  return moves.flatMap((item) => {
    const from = (item as { from?: unknown } | null)?.from;
    return typeof from === "string" && from ? [from] : [];
  });
}

/** A reason as a sentence: as it is when it names its own item (“name” …), else put after what it is about. */
function reasonSentence(item: { path: string; error: string }, about: (name: string, error: string) => string): string {
  const error = item.error.trim();
  if (error.includes(`“${basename(item.path)}”`)) return /[.!?]$/.test(error) ? error : `${error}.`;
  return about(basename(item.path), error.replace(/\.$/, ""));
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function names(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).map(basename).join(", ");
  return `${shown}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;
}
