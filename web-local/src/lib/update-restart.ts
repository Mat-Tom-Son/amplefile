import type { ConfirmDialogOptions } from "../ui/feedback";
import type { ConnectedFolderSummary, DesktopUpdateStatus } from "../types";
import { updateCallFor, type UpdateCall } from "./update-status";

/**
 * Downloading or installing an update ends in AmpleFile quitting and opening
 * again on its own. Quitting stops every running turn—it settles as
 * interrupted and is never run again—and drops queued messages, so both
 * Settings → About and the sidebar's update indicator ask first, through
 * `runDesktopUpdateAction`, and name the work a restart would stop.
 */

/** What is running when the person clicks, from the endpoints the window already reads. */
export interface RunningWork {
  chats: Array<{ connectedFolderId: string; conversationId: string }>;
  ampleFileAgentWorking: boolean;
}

/** Reads what is running now; null when either read fails, so the question still warns. */
export async function readRunningWork(read: <T>(path: string) => Promise<T>): Promise<RunningWork | null> {
  try {
    const [activity, agent] = await Promise.all([
      read<{ running?: RunningWork["chats"] }>("/api/connected-folders/activity"),
      read<{ state?: string }>("/api/amplefile-agent/summary"),
    ]);
    return { chats: activity.running ?? [], ampleFileAgentWorking: agent.state === "running" || agent.state === "compacting" };
  } catch {
    return null;
  }
}

function countedChats(count: number) {
  return count === 1 ? "1 Worker Chat is working" : `${count} Worker Chats are working`;
}

/** The question asked before an updater call that ends in a restart. */
export function updateRestartConfirm(call: Exclude<UpdateCall, "check">, status: DesktopUpdateStatus | null, work: RunningWork | null, connectedFolders: readonly Pick<ConnectedFolderSummary, "id" | "name">[]): ConfirmDialogOptions {
  const version = status?.availableVersion ? `version ${status.availableVersion}` : "the update";
  const sentences = [call === "install"
    ? `AmpleFile quits and opens again on its own to install ${version}.`
    : `AmpleFile downloads ${version}, then quits and opens again on its own to install it.`];
  let running: boolean;
  if (!work) {
    running = true;
    sentences.push("AmpleFile could not check what is running. Any Worker Chat or AmpleFile Agent turn still running when it restarts is stopped and not run again, and queued messages are dropped.");
  } else {
    const parts: string[] = [];
    if (work.chats.length) {
      const names = [...new Set(work.chats.map((chat) => connectedFolders.find((item) => item.id === chat.connectedFolderId)?.name).filter((name): name is string => Boolean(name)))];
      parts.push(`${countedChats(work.chats.length)}${names.length ? ` (${names.join(", ")})` : ""}`);
    }
    if (work.ampleFileAgentWorking) parts.push(parts.length ? "the AmpleFile Agent is working" : "The AmpleFile Agent is working");
    running = parts.length > 0;
    if (running) sentences.push(`${parts.join(", and ")}. Restarting stops this work, and it is not run again. Queued messages are dropped.`);
    else if (call === "updateNow") sentences.push("Anything still running when it restarts is stopped and not run again.");
  }
  return { title: "Restart AmpleFile to Update?", body: sentences.join(" "), confirmLabel: "Update and Restart", tone: running ? "danger" : "default" };
}

/** The desktop bridge's updater calls; the preview's stand-ins resolve to null. */
export interface DesktopUpdateCalls {
  check: () => Promise<DesktopUpdateStatus | null>;
  updateNow: () => Promise<DesktopUpdateStatus | null>;
  install: () => Promise<DesktopUpdateStatus | null>;
}

/**
 * One click on Settings → About's update button or the sidebar's indicator:
 * the updater call for the status, asked first when it ends in a restart.
 * Returns the updater's new status, or null when nothing was called.
 */
export async function runDesktopUpdateAction({ status, updates, confirm, readWork, connectedFolders }: {
  status: DesktopUpdateStatus | null;
  updates: DesktopUpdateCalls;
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  readWork: () => Promise<RunningWork | null>;
  connectedFolders: readonly Pick<ConnectedFolderSummary, "id" | "name">[];
}): Promise<DesktopUpdateStatus | null> {
  const call = updateCallFor(status);
  if (!call) return null;
  if (call !== "check") {
    const work = await readWork();
    if (!(await confirm(updateRestartConfirm(call, status, work, connectedFolders)))) return null;
  }
  return updates[call]();
}
