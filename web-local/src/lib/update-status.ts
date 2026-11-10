import type { DesktopUpdateStatus } from "../types";

/**
 * What a person's click does in each update phase, and how the two places
 * that offer it—Settings → About and the indicator at the foot of the
 * sidebar—name it. Both read these helpers so they cannot disagree.
 */

export type UpdatePhase = DesktopUpdateStatus["phase"];

/** The desktop updater call one click makes; null while the updater is already busy. */
export type UpdateCall = "check" | "updateNow" | "install";

export function updateCallForPhase(phase: UpdatePhase): UpdateCall | null {
  switch (phase) {
    case "ready": return "install";
    // A download that failed is retried the same way it was started.
    case "available":
    case "error": return "updateNow";
    case "checking":
    case "downloading":
    case "installing": return null;
    case "unsupported":
    case "idle":
    case "not_available": return "check";
  }
}

/** True while the updater is working and a click must not start anything. */
export function updateIsBusy(phase: UpdatePhase): boolean {
  return updateCallForPhase(phase) === null;
}

function percentText(status: DesktopUpdateStatus): string | null {
  return status.progressPercent === null ? null : `${Math.round(status.progressPercent)}%`;
}

/** The label of Settings → About's update button. */
export function updateActionLabel(status: DesktopUpdateStatus): string {
  switch (status.phase) {
    case "available": return "Update and Restart";
    case "ready": return "Restart and Install";
    case "error": return "Retry";
    case "checking": return "Checking";
    case "downloading": return percentText(status) ?? "Downloading";
    case "installing": return "Restarting";
    case "unsupported":
    case "idle":
    case "not_available": return "Check for Updates";
  }
}

/**
 * The sidebar indicator for a status, or null when the status needs nothing
 * from the person and the indicator takes no space. `click` is what one click
 * does: run the same updater call Settings would, open Settings → About, or
 * nothing while AmpleFile is already restarting.
 */
export interface UpdateIndicatorModel {
  tone: "available" | "downloading" | "ready" | "installing" | "error";
  label: string;
  /** Quiet trailing text: the version, or the download's progress. */
  detail: string | null;
  progressPercent: number | null;
  accessibleName: string;
  tooltip: string;
  click: "update" | "open-about" | null;
}

export function updateIndicatorFor(status: DesktopUpdateStatus | null): UpdateIndicatorModel | null {
  if (!status?.supported) return null;
  const version = status.availableVersion;
  const named = version ? `AmpleFile ${version}` : "The update";
  switch (status.phase) {
    case "available": return {
      tone: "available",
      label: "Update Available",
      detail: version,
      progressPercent: null,
      accessibleName: version ? `Update Available: AmpleFile ${version}` : "Update Available",
      tooltip: `Download ${version ? `AmpleFile ${version}` : "the update"} and restart to install it. AmpleFile asks first and names any work the restart would stop.`,
      click: "update",
    };
    case "downloading": {
      const percent = percentText(status);
      return {
        tone: "downloading",
        label: "Downloading",
        detail: percent,
        progressPercent: status.progressPercent,
        accessibleName: percent ? `Downloading Update, ${percent}` : "Downloading Update",
        tooltip: `${named} is downloading. AmpleFile restarts when it finishes. Open Settings → About for details.`,
        click: "open-about",
      };
    }
    case "ready": return {
      tone: "ready",
      label: "Restart to Update",
      detail: version,
      progressPercent: null,
      accessibleName: version ? `Restart to Update: AmpleFile ${version}` : "Restart to Update",
      tooltip: `${named} is ready. AmpleFile asks, then quits and opens again to install it.`,
      click: "update",
    };
    case "installing": return {
      tone: "installing",
      label: "Restarting to Update",
      detail: null,
      progressPercent: null,
      accessibleName: "Restarting to Update",
      tooltip: `AmpleFile is restarting to install ${version ? `version ${version}` : "the update"}.`,
      click: null,
    };
    case "error": return {
      tone: "error",
      label: "Update Failed",
      detail: null,
      progressPercent: null,
      accessibleName: "Update Failed: Show Details in Settings",
      tooltip: "The update did not finish. Open Settings → About for the details and to try again.",
      click: "open-about",
    };
    case "unsupported":
    case "idle":
    case "checking":
    case "not_available": return null;
  }
}
