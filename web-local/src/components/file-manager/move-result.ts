/**
 * What a move between places left undone, read from the file-transfer
 * answer. The fields are optional and their exact shapes may vary (an array
 * of items, one item, a count), so every reading is defensive and lives here.
 */
export interface MoveShortfall {
  /** Items that were not moved. */
  failed: string[] | number;
  /** Items copied to the target but not removed from where they were. */
  notRemoved: string[] | number;
  /** Items (or what History could not keep of them) set aside in Recently Deleted. */
  recentlyDeleted: string[] | number;
}

export function moveShortfall(result: unknown): MoveShortfall {
  const body = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return { failed: itemsOf(body.failed), notRemoved: itemsOf(body.notRemoved), recentlyDeleted: itemsOf(body.recentlyDeleted) };
}

/** The toast after a move: plain about anything that did not go as asked. */
export function moveResultMessage(label: string, targetName: string, result: unknown): { text: string; tone: "success" | "info" } {
  const { failed, notRemoved, recentlyDeleted } = moveShortfall(result);
  const notes: string[] = [];
  if (count(failed)) notes.push(`${phrase(failed, "was", "were")} not moved${names(failed)}.`);
  if (count(notRemoved)) notes.push(`${phrase(notRemoved, "was", "were")} copied but not removed from where ${count(notRemoved) === 1 ? "it was" : "they were"}${names(notRemoved)}.`);
  if (count(recentlyDeleted)) notes.push(`What History could not keep from the original place is in Recently Deleted${names(recentlyDeleted)}.`);
  if (!notes.length) return { text: `Moved ${label} to ${targetName}`, tone: "success" };
  const opening = count(failed) || count(notRemoved) ? `Moved what it could of ${label} to ${targetName}.` : `Moved ${label} to ${targetName}.`;
  return { text: [opening, ...notes].join(" "), tone: count(failed) || count(notRemoved) ? "info" : "success" };
}

function itemsOf(value: unknown): string[] | number {
  if (value === undefined || value === null || value === false) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  if (Array.isArray(value)) {
    const named = value.map(itemName);
    return named.every((name): name is string => name !== null) ? named : value.length;
  }
  const name = itemName(value);
  if (name !== null) return [name];
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["count", "uncoveredCount"]) {
      if (typeof record[key] === "number" && (record[key] as number) > 0) return Math.floor(record[key] as number);
    }
  }
  return value === true || typeof value === "object" ? 1 : 0;
}

function itemName(item: unknown): string | null {
  if (typeof item === "string" && item) return basename(item);
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (typeof record.name === "string" && record.name) return record.name;
  for (const key of ["path", "from", "fromPath"]) if (typeof record[key] === "string" && record[key]) return basename(record[key] as string);
  return null;
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function count(items: string[] | number): number {
  return typeof items === "number" ? items : items.length;
}

function phrase(items: string[] | number, one: string, many: string): string {
  const total = count(items);
  return total === 1 ? `1 item ${one}` : `${total} items ${many}`;
}

function names(items: string[] | number): string {
  if (typeof items === "number" || !items.length) return "";
  const shown = items.slice(0, 3).join(", ");
  return `: ${shown}${items.length > 3 ? ` and ${items.length - 3} more` : ""}`;
}
