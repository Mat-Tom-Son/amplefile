import type { IncludedToolStatus } from "../../../src/shared/included-tools";

/** A loaded Pi Extension is not evidence that its external tools are ready. */
export function includedToolReadiness(status: IncludedToolStatus | undefined) {
  if (status?.id === "mcp" && status.facts?.connections !== undefined) return { label: status.facts.connections === "0" ? "No Connections" : "Configured", tone: "", setup: status.facts.connections === "0" };
  if (status?.stale && status.state === "ready") return { label: "Last Check Passed", tone: "", setup: false };
  switch (status?.state) {
    case "ready": return { label: "Ready", tone: "enabled", setup: false };
    case "setup_required": return { label: "Setup Needed", tone: "", setup: true };
    case "unavailable": return { label: "Unavailable", tone: "error", setup: true };
    // Computer Control can always be set up from here: Allow finishes at once when it is already allowed.
    default: return { label: "Not Checked", tone: "", setup: status?.id === "computer" };
  }
}
