import { desktopShortcutKeyLabel, desktopShortcutKeySpokenName, desktopShortcutModifierKey } from "../../lib/keyboard";
import { desktopPlatform, isMacOS, systemFileManagerName, type DesktopPlatform } from "../../lib/platform";
import type { ShortcutGroup } from "../../types";

/**
 * The file manager layout's keys (docs/product-model.md, the file
 * manager window): Finder's keys for the list and search, and the menu bar's
 * AmpleFile commands, and the Browser pane's keys in the desktop app. It has
 * no command palette or agent panel, so their keys are not listed.
 * Space previews with Quick Look on the Mac (the plain browser points to the
 * Mac app for it); on another desktop it opens the window's own Preview, which
 * Space or Esc closes.
 */
export function fileManagerShortcutGroups(platform: DesktopPlatform, desktop: boolean): ShortcutGroup[] {
  const macOS = isMacOS(platform);
  const modifier = desktopShortcutModifierKey(platform);
  const fileManager = systemFileManagerName(platform);
  const quickLook = macOS || !platform;
  const space = quickLook ? "Quick Look the selected item." : "Preview the selected item. Space or Esc closes it.";
  return [
    {
      title: "Files",
      rows: [
        { keys: ["Arrow up"], action: "Select the item above." },
        { keys: ["Arrow down"], action: "Select the item below." },
        { keys: ["Shift", "Arrow down"], action: "Add the next item to the selection." },
        { keys: [modifier, "A"], action: "Select every item." },
        { keys: ["Space"], action: space },
        { keys: [modifier, "Arrow down"], action: "Open the selected item." },
        { keys: [modifier, "Arrow up"], action: "Go to the enclosing folder." },
        { keys: [modifier, "["], action: "Go back." },
        { keys: [modifier, "]"], action: "Go forward." },
        { keys: [modifier, "Shift", "G"], action: "Go to a folder by its path." },
        { keys: [modifier, "C"], action: `Copy the selected items (${fileManager} can paste them too).` },
        { keys: [modifier, "V"], action: `Paste items copied here or in ${fileManager}.` },
        { keys: [macOS ? "Option" : "Alt", modifier, "V"], action: "Move the items copied here into this folder." },
        { keys: [modifier, "D"], action: "Duplicate the selected items." },
        { keys: [modifier, "Z"], action: "Undo the last file change." },
        { keys: [modifier, "Shift", "Z"], action: "Redo it." },
        { keys: ["Enter"], action: "Rename the selected item." },
        { keys: [modifier, "Backspace"], action: macOS || platform === "linux" ? "Delete. Undo it from History, or from the Trash in a Standard Folder." : "Delete. Undo it from History." },
        { keys: ["Esc"], action: "Clear the selection." },
      ],
    },
    {
      title: "Search",
      rows: [
        { keys: [modifier, "F"], action: "Search names and contents." },
        { keys: ["Arrow down"], action: "Choose the next result." },
        { keys: ["Enter"], action: "Open the chosen result." },
        { keys: ["Esc"], action: "Clear the search." },
      ],
    },
    {
      title: "Chat",
      rows: [
        ...(desktop ? [{ keys: [modifier, "Shift", "N"], action: "Start a new Chat in this Connected Folder." }] : []),
        { keys: [modifier, "."], action: "Stop the Worker's reply." },
      ],
    },
    ...(desktop ? [{
      // These act while the Browser pane or a page in it has the keyboard; elsewhere the same keys keep their own meaning.
      title: "Browser, While It Has the Keyboard",
      rows: [
        { keys: [modifier, "T"], action: "Open a new browser tab." },
        { keys: [modifier, "Shift", "T"], action: "Reopen the browser tab closed last." },
        { keys: [modifier, "W"], action: "Close the browser tab in front." },
        { keys: [modifier, "L"], action: "Go to the address field." },
        { keys: [modifier, "F"], action: "Find in the page." },
        { keys: [modifier, "R"], action: "Reload the page, from the page itself." },
        { keys: ["Control", "Tab"], action: "Show the next browser tab." },
        { keys: [modifier, "1"], action: "Show the first browser tab; 2 to 8 the next ones, and 9 the last." },
      ],
    }] : []),
    ...(desktop ? [{
      title: "AmpleFile",
      rows: [
        { keys: [modifier, "N"], action: "Create a new Connected Folder." },
        { keys: [modifier, "O"], action: "Use an existing folder." },
        { keys: [modifier, "R"], action: "Refresh the folder." },
        { keys: [modifier, "Shift", "S"], action: "Open Skills & Extensions." },
        { keys: [modifier, ","], action: "Open Settings." },
        { keys: [modifier, "/"], action: "Open Shortcut Keys." },
      ],
    }] : []),
  ];
}

export function KeyboardShortcutsPane() {
  return <ShortcutGroups groups={fileManagerShortcutGroups(desktopPlatform(), Boolean(window.ampleFileDesktop))} />;
}

function ShortcutGroups({ groups: shortcutGroups }: { groups: ShortcutGroup[] }) {
  return (
    <section className="keyboard-shortcuts-pane">
      <h2 className="sr-only">Shortcut Keys</h2>
        <div className="keyboard-shortcuts-grid">
          {shortcutGroups.map((group) => (
            <section className="keyboard-shortcuts-group" key={group.title}>
              <h3>{group.title}</h3>
              <div className="keyboard-shortcuts-list">
                {group.rows.map((row) => (
                  <div className="keyboard-shortcut-row" key={`${group.title}:${row.keys.join("+")}:${row.action}`}>
                    <span className="keyboard-shortcut-keys" aria-label={row.keys.map(desktopShortcutKeySpokenName).join(" plus ")}>
                      {row.keys.map((key) => <kbd key={key}>{desktopShortcutKeyLabel(key)}</kbd>)}
                    </span>
                    <span>{row.action}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
    </section>
  );
}
