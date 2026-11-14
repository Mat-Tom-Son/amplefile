import { homedir } from "node:os";
import { dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

import { linuxMenuIcons } from "./linux-menu-icons.js";
import { openWithDialogOptions, type OpenWithPickedApp } from "./open-with.js";
import {
  desktopAppFromFile,
  findExecutable,
  linuxOpenWithChoices,
  linuxOpenWithLaunchPlan,
  openWithMenuLabels,
  type LinuxDesktopApp,
} from "./open-with-linux.js";

const menuIconDeadlineMs = 400;

/**
 * Linux Open With: a native menu, shown at the pointer by the main process,
 * of the apps the desktop associates with the file's type (the default
 * first), then Other Application…, which opens a native file dialog. The
 * renderer supplies only the Connected Folder or Standard Folder file; the app
 * launched is always one this process enumerated or the person picked in the
 * native dialog.
 */
export async function pickLinuxOpenWithApp(window: BrowserWindow | null, filePath: string): Promise<string | OpenWithPickedApp | null> {
  // The menu needs its window; without one it could never report closing.
  if (!window || window.isDestroyed()) throw new Error("The AmpleFile window is not available.");
  const env = process.env;
  const home = homedir();
  const [choices, terminalExec] = await Promise.all([linuxOpenWithChoices(filePath, { env, home }), findExecutable("xdg-terminal-exec", env)]);
  const tools = { gio: choices.gio, terminalExec, env, home };
  const pickedApp = (app: LinuxDesktopApp): OpenWithPickedApp => ({
    appName: app.name,
    launchPlan: (path) => linuxOpenWithLaunchPlan(app, path, tools),
  });
  const labels = openWithMenuLabels(choices.apps);
  // Themed icons, SVG ones drawn offscreen; an icon not ready in time is left
  // out of this menu rather than delaying it, and is cached for the next one.
  const icons = await linuxMenuIcons(choices.apps.map((app) => app.icon), { env, home, deadlineMs: menuIconDeadlineMs });
  const choice = await popupMenu(window, [
    ...choices.apps.map((app, index): MenuItemConstructorOptions & { choice: LinuxDesktopApp } => ({
      choice: app,
      label: escapeMnemonic(`${labels.get(app.id) ?? app.name}${app.id === choices.defaultId ? " (Default)" : ""}`),
      ...(icons[index] ? { icon: icons[index] } : {}),
    })),
    ...(choices.apps.length ? [] : [{ label: "No Apps for This Type", enabled: false }]),
  ]);
  if (choice === null) return null;
  if (choice !== "other") return pickedApp(choice);

  const options = openWithDialogOptions("linux");
  const result = window.isDestroyed() ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
  // Only the path the dialog itself returned is ever launched.
  const picked = result.canceled ? null : result.filePaths[0] ?? null;
  if (!picked) return null;
  if (!picked.endsWith(".desktop")) return picked;
  const app = await desktopAppFromFile(picked, env);
  if (!app) throw new Error("That file isn't an app AmpleFile can start.");
  return pickedApp(app);
}

function escapeMnemonic(label: string): string {
  return label.replace(/&/g, "&&");
}

function popupMenu(
  window: BrowserWindow,
  items: Array<MenuItemConstructorOptions & { choice?: LinuxDesktopApp }>,
): Promise<LinuxDesktopApp | "other" | null> {
  return new Promise((resolveChoice) => {
    let settled = false;
    const finish = (value: LinuxDesktopApp | "other" | null) => {
      if (settled) return;
      settled = true;
      resolveChoice(value);
    };
    const template: MenuItemConstructorOptions[] = [
      ...items.map(({ choice, ...item }) => choice ? { ...item, click: () => finish(choice) } : item),
      { type: "separator" },
      { label: "Other Application…", click: () => finish("other") },
    ];
    Menu.buildFromTemplate(template).popup({
      window,
      // The menu can report closing before the chosen item's click runs.
      callback: () => setTimeout(() => finish(null), 0),
    });
  });
}
