/**
 * Settings → File Manager (Linux only): the state the host reads from the
 * system and the words the page shows for it. Both parts are read from the
 * system each time, never from a remembered flag.
 */

export type ShowFilesFromOtherAppsState =
  /** No AmpleFile service file: the system's file manager answers. */
  | "off"
  /** AmpleFile's service file points at this copy, and AmpleFile holds the name. */
  | "on"
  /** AmpleFile's service file points at this copy; another program holds the name for now. */
  | "waiting"
  /** AmpleFile's service file points at this copy, but this copy can't answer (no bus, policy). */
  | "unavailable"
  /** An AmpleFile service file points at another copy of AmpleFile (a moved AppImage, a development build). */
  | "elsewhere";

export interface ShowFilesFromOtherAppsStatus {
  state: ShowFilesFromOtherAppsState;
  /** Plain words for "waiting", "unavailable" and "elsewhere". */
  reason: string | null;
  /** The program the person's own earlier service file started, which turning this off puts back. */
  replaced: string | null;
  /** The program the system's service file starts (nautilus, dolphin), if any. */
  systemFileManager: string | null;
}

export type OpenFoldersByDefaultState = "on" | "off" | "unavailable";

export interface OpenFoldersByDefaultStatus {
  state: OpenFoldersByDefaultState;
  /** The app folders open with now, by name (Files, Dolphin), or null when none is set. */
  current: string | null;
  /** What turning this off gives folders back to, by name, or null for the desktop's own default. */
  previous: string | null;
  reason: string | null;
}

export interface LinuxFileManagerStatus {
  showFilesFromOtherApps: ShowFilesFromOtherAppsStatus;
  openFoldersByDefault: OpenFoldersByDefaultStatus;
}

export interface FileManagerSettingRowView {
  checked: boolean;
  disabled: boolean;
  /** One line under the description: what is true now, or why it can't change. */
  detail: string;
  tone: "normal" | "warning";
}

export interface LinuxFileManagerSettingsView {
  showFilesFromOtherApps: FileManagerSettingRowView;
  openFoldersByDefault: FileManagerSettingRowView;
}

export const fileManagerSettingsCopy = {
  page: "File Manager",
  intro: "Let other apps use AmpleFile as your file manager. Each choice changes only your own settings and turns off here.",
  showFilesFromOtherApps: {
    label: "Show Files from Other Apps",
    description: "When an app, such as your browser's downloads list, asks to show a file in its folder, AmpleFile opens the folder with the file selected, starting if it isn't running.",
  },
  openFoldersByDefault: {
    label: "Open Folders with AmpleFile",
    description: "Folders you open from the desktop and other apps open in AmpleFile.",
  },
} as const;

function showFilesView(status: ShowFilesFromOtherAppsStatus): FileManagerSettingRowView {
  const other = status.replaced ?? status.systemFileManager;
  const giveBack = other ? ` Turning this off gives them back to ${other}.` : "";
  switch (status.state) {
    case "on":
      return { checked: true, disabled: false, detail: `AmpleFile is answering.${giveBack}`, tone: "normal" };
    case "waiting":
      return { checked: true, disabled: false, detail: status.reason ?? "Another file manager is answering for now. AmpleFile takes over when it closes.", tone: "normal" };
    case "unavailable":
      return { checked: true, disabled: false, detail: status.reason ?? "AmpleFile can't answer right now.", tone: "warning" };
    case "elsewhere":
      return { checked: false, disabled: false, detail: status.reason ?? "Set up for another copy of AmpleFile. Turn this on to use this copy.", tone: "warning" };
    case "off":
      return { checked: false, disabled: false, detail: other ? `Off: ${other} shows them.` : "Off.", tone: "normal" };
  }
}

function openFoldersView(status: OpenFoldersByDefaultStatus): FileManagerSettingRowView {
  switch (status.state) {
    case "on":
      return { checked: true, disabled: false, detail: `Turning this off gives folders back to ${status.previous ?? "your desktop's default"}.`, tone: "normal" };
    case "off":
      return { checked: false, disabled: false, detail: status.current ? `Folders open with ${status.current} now.` : "No app is set to open folders now.", tone: "normal" };
    case "unavailable":
      return { checked: false, disabled: true, detail: status.reason ?? "This desktop doesn't let AmpleFile change how folders open.", tone: "warning" };
  }
}

export function linuxFileManagerSettingsView(status: LinuxFileManagerStatus): LinuxFileManagerSettingsView {
  return {
    showFilesFromOtherApps: showFilesView(status.showFilesFromOtherApps),
    openFoldersByDefault: openFoldersView(status.openFoldersByDefault),
  };
}

const showStates = new Set<ShowFilesFromOtherAppsState>(["off", "on", "waiting", "unavailable", "elsewhere"]);
const openStates = new Set<OpenFoldersByDefaultState>(["on", "off", "unavailable"]);
const optionalText = (value: unknown) => value === null || typeof value === "string";

/** Guards the host's answer before the page uses it. */
export function isLinuxFileManagerStatus(value: unknown): value is LinuxFileManagerStatus {
  if (!value || typeof value !== "object") return false;
  const { showFilesFromOtherApps: show, openFoldersByDefault: open } = value as Partial<LinuxFileManagerStatus>;
  return Boolean(show && open && showStates.has(show.state) && optionalText(show.reason) && optionalText(show.replaced) && optionalText(show.systemFileManager)
    && openStates.has(open.state) && optionalText(open.current) && optionalText(open.previous) && optionalText(open.reason));
}
