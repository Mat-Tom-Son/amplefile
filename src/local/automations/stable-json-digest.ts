import { createHash } from "node:crypto";

/**
 * SHA-256 over a stable JSON form: object keys sorted, `undefined` fields
 * left out, non-finite numbers refused. Automation enablement pins this
 * digest and stored automations are re-verified against it on every load, so
 * its output must never change. (Moved from the retired Checks integrity
 * module on 2026-11-07, byte for byte.)
 */
export function stableJsonDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Digest input contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Digest input is not JSON-compatible.");
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
