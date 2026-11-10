import type { DesktopUpdateStatus } from "../types";

/**
 * What a person's click does in each update phase, and how the two places
 * that offer it—Settings → About and the indicator at the foot of the
 * sidebar—name it. Both read these helpers so they cannot disagree.
 */

export type UpdatePhase = DesktopUpdateStatus["phase"];

/** The desktop updater call one click makes; null while the updater is already busy. */
export type UpdateCall = "check" | "updateNow" | "install";

/**
 * An error with a version is a download, staging, or install that failed;
 * one without is a check that failed, with nothing being updated.
 */
export function updateFailedWithVersion(status: Pick<DesktopUpdateStatus, "phase" | "availableVersion">): boolean {
  return status.phase === "error" && status.availableVersion !== null;
}

export function updateCallFor(status: Pick<DesktopUpdateStatus, "phase" | "availableVersion"> | null): UpdateCall | null {
  switch (status?.phase ?? "idle") {
    case "ready": return "install";
    case "available": return "updateNow";
    // A failed download is retried the way it was started; a failed check only
    // checks again, so retrying it never ends in a restart.
    case "error": return updateFailedWithVersion(status!) ? "updateNow" : "check";
    case "checking":
    case "downloading":
    case "installing": return null;
    case "unsupported":
    case "idle":
    case "not_available": return "check";
    // A phase this renderer does not know (a newer desktop): a check is harmless.
    default: return "check";
  }
}

/** True while the updater is working and a click must not start anything. */
export function updateIsBusy(phase: UpdatePhase): boolean {
  return updateCallFor({ phase, availableVersion: null }) === null;
}

/** The download's progress as a number from 0 to 100, or null when the status carries none. */
function progressOf(status: DesktopUpdateStatus): number | null {
  const percent: unknown = status.progressPercent;
  return typeof percent === "number" && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

function percentText(status: DesktopUpdateStatus): string | null {
  const percent = progressOf(status);
  return percent === null ? null : `${Math.round(percent)}%`;
}

/** The label of Settings → About's update button. */
export function updateActionLabel(status: DesktopUpdateStatus): string {
  switch (status.phase) {
    case "available": return "Update and Restart";
    case "ready": return "Restart and Install";
    case "error": return updateFailedWithVersion(status) ? "Retry" : "Check Again";
    case "checking": return "Checking";
    case "downloading": return percentText(status) ?? "Downloading";
    case "installing": return "Restarting";
    case "unsupported":
    case "idle":
    case "not_available": return "Check for Updates";
    default: return "Check for Updates";
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
  /** The label when the sidebar is too narrow for `label`; the accessible name keeps the whole one. */
  shortLabel: string;
  /** Quiet trailing text: the version, or the download's progress. */
  detail: string | null;
  progressPercent: number | null;
  accessibleName: string;
  tooltip: string;
  click: "update" | "open-about" | null;
  /** What a screen reader hears when the indicator moves into this state; null when it stays quiet. */
  announcement: string | null;
}

export function updateIndicatorFor(status: DesktopUpdateStatus | null): UpdateIndicatorModel | null {
  if (!status?.supported) return null;
  const version = status.availableVersion;
  const named = version ? `AmpleFile ${version}` : "The update";
  switch (status.phase) {
    case "available": return {
      tone: "available",
      label: "Update Available",
      shortLabel: "Update",
      detail: version,
      progressPercent: null,
      accessibleName: version ? `Update Available: AmpleFile ${version}` : "Update Available",
      tooltip: `Download ${version ? `AmpleFile ${version}` : "the update"} and restart to install it. AmpleFile asks first and names any work the restart would stop.`,
      click: "update",
      announcement: `${named} is available. Update Available is at the bottom of the sidebar.`,
    };
    case "downloading": {
      const percent = percentText(status);
      return {
        tone: "downloading",
        label: "Downloading",
      shortLabel: "Downloading",
        detail: percent,
        progressPercent: progressOf(status),
        accessibleName: percent ? `Downloading Update, ${percent}` : "Downloading Update",
        tooltip: `${named} is downloading. AmpleFile restarts when it finishes. Open Settings → About for details.`,
        click: "open-about",
        announcement: null,
      };
    }
    case "ready": return {
      tone: "ready",
      label: "Restart to Update",
      shortLabel: "Restart",
      detail: version,
      progressPercent: null,
      accessibleName: version ? `Restart to Update: AmpleFile ${version}` : "Restart to Update",
      tooltip: `${named} is ready. AmpleFile asks, then quits and opens again to install it.`,
      click: "update",
      announcement: `${named} is ready to install. Restart to Update is at the bottom of the sidebar.`,
    };
    case "installing": return {
      tone: "installing",
      label: "Restarting to Update",
      shortLabel: "Restarting",
      detail: null,
      progressPercent: null,
      accessibleName: "Restarting to Update",
      tooltip: `AmpleFile is restarting to install ${version ? `version ${version}` : "the update"}.`,
      click: null,
      announcement: null,
    };
    // A failed check is left to Settings → About: nothing was being updated.
    case "error": return !updateFailedWithVersion(status) ? null : {
      tone: "error",
      label: "Update Failed",
      shortLabel: "Failed",
      detail: null,
      progressPercent: null,
      accessibleName: "Update Failed: Show Details in Settings",
      tooltip: "The update did not finish. Open Settings → About for the details and to try again.",
      click: "open-about",
      announcement: "The update did not finish. Settings → About has the details.",
    };
    case "unsupported":
    case "idle":
    case "checking":
    case "not_available": return null;
    default: return null;
  }
}

/**
 * The indicator while the updater checks again: the one shown before the
 * check, so it does not vanish and come back. Its updater action waits for
 * the check (the updater ignores it meanwhile); opening About still works.
 */
export function updateIndicatorDuringCheck(previous: UpdateIndicatorModel | null): UpdateIndicatorModel | null {
  if (!previous) return null;
  return previous.click === "update" ? { ...previous, click: null } : previous;
}
