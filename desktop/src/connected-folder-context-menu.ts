/**
 * The native right-click menu for the Connected Folder header (macOS), with the
 * same actions as the in-app menu other platforms show.
 */
export type NativeConnectedFolderMenuCommand = "new-chat" | "customize" | "set-up" | "look" | "reveal" | "manage" | "skills" | "settings"
  | "put-to-work" | "remove-from-sidebar" | "create-connected-folder" | "use-existing-folder" | "remove-connected-folder";

export interface NativeConnectedFolderMenuRequest {
  /**
   * Which of the header's actions this Connected Folder offers. Manage Connected Folders
   * is there unless `manage` is false. The file manager's Action menu
   * adds Skills & Extensions and Settings and leaves out Manage,
   * since its sidebar lists the Connected Folders; older renderers omit all three.
   */
  actions: {
    newChat: boolean; customize: boolean; setUp: boolean; reveal: boolean; skills?: boolean; settings?: boolean; manage?: boolean;
    /** The file manager's Standard Folders: register the folder, or take an added one off the sidebar. */
    putToWork?: boolean; removeFromSidebar?: boolean;
    /** The file manager's + beside Connected Folders. */
    createConnectedFolder?: boolean; useExistingFolder?: boolean;
    /**
     * The file manager's Connected Folder menus: Disconnect… a linked folder
     * (its files stay), or, with `removeDeletes`, Delete Connected Folder… a
     * managed one (it moves to Recently Deleted).
     */
    remove?: boolean; removeDeletes?: boolean;
  };
  point: { x: number; y: number };
}

export type NativeConnectedFolderMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; command: NativeConnectedFolderMenuCommand };

const requestKeys = new Set(["actions", "point"]);
const actionKeys = new Set(["newChat", "customize", "setUp", "reveal"]);
const optionalActionKeys = new Set(["skills", "settings", "manage", "putToWork", "removeFromSidebar", "createConnectedFolder", "useExistingFolder", "remove", "removeDeletes"]);
const pointKeys = new Set(["x", "y"]);

export function parseNativeConnectedFolderMenuRequest(value: unknown): NativeConnectedFolderMenuRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) throw new Error("The Connected Folder menu request is invalid.");
  const { actions, point } = value;
  if (!isRecord(actions) || !hasOnlyKeys(actions, new Set([...actionKeys, ...optionalActionKeys]))
    || ![...actionKeys].every((key) => typeof actions[key] === "boolean")
    || ![...optionalActionKeys].every((key) => actions[key] === undefined || typeof actions[key] === "boolean")) {
    throw new Error("The Connected Folder menu request is invalid.");
  }
  if (!isRecord(point) || !hasOnlyKeys(point, pointKeys) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("The Connected Folder menu position is invalid.");
  }
  return {
    actions: {
      newChat: actions.newChat as boolean,
      customize: actions.customize as boolean,
      setUp: actions.setUp as boolean,
      reveal: actions.reveal as boolean,
      ...(actions.skills === true ? { skills: true } : {}),
      ...(actions.settings === true ? { settings: true } : {}),
      ...(actions.manage === false ? { manage: false } : {}),
      ...(actions.putToWork === true ? { putToWork: true } : {}),
      ...(actions.removeFromSidebar === true ? { removeFromSidebar: true } : {}),
      ...(actions.createConnectedFolder === true ? { createConnectedFolder: true } : {}),
      ...(actions.useExistingFolder === true ? { useExistingFolder: true } : {}),
      ...(actions.remove === true ? { remove: true } : {}),
      ...(actions.removeDeletes === true ? { removeDeletes: true } : {}),
    },
    point: {
      x: Math.max(0, Math.min(1_000_000, Math.round(point.x as number))),
      y: Math.max(0, Math.min(1_000_000, Math.round(point.y as number))),
    },
  };
}

export function nativeConnectedFolderMenuItems(request: NativeConnectedFolderMenuRequest, platform: NodeJS.Platform = "darwin"): NativeConnectedFolderMenuItem[] {
  const { actions } = request;
  const items: NativeConnectedFolderMenuItem[] = [];
  if (actions.createConnectedFolder) items.push({ type: "item", label: "New Connected Folder…", command: "create-connected-folder" });
  if (actions.useExistingFolder) items.push({ type: "item", label: "Connect Folder…", command: "use-existing-folder" });
  if (actions.newChat) items.push({ type: "item", label: "New Chat", command: "new-chat" });
  if (actions.customize) items.push({ type: "item", label: "Customize Connected Folder", command: "customize" });
  if (actions.setUp) {
    items.push(
      { type: "item", label: "Set Up for Me", command: "set-up" },
      { type: "item", label: "Just the Look", command: "look" },
    );
  }
  if (actions.reveal) items.push({ type: "item", label: platform === "darwin" ? "Show in Finder" : platform === "win32" ? "Show in File Explorer" : "Show in File Manager", command: "reveal" });
  if (actions.putToWork) items.push({ type: "item", label: "Connect This Folder", command: "put-to-work" });
  if (actions.skills) items.push({ type: "item", label: "Skills & Extensions…", command: "skills" });
  const tail: NativeConnectedFolderMenuItem[] = [];
  if (actions.removeFromSidebar) tail.push({ type: "item", label: "Remove from Sidebar", command: "remove-from-sidebar" });
  if (actions.remove) tail.push({ type: "item", label: actions.removeDeletes ? "Delete Connected Folder…" : "Disconnect…", command: "remove-connected-folder" });
  if (actions.manage !== false) tail.push({ type: "item", label: "Manage Connected Folders", command: "manage" });
  if (actions.settings) tail.push({ type: "item", label: "Settings…", command: "settings" });
  if (items.length && tail.length) items.push({ type: "separator" });
  items.push(...tail);
  return items;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
