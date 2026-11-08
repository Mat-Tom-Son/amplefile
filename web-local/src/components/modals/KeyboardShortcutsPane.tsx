import { desktopShortcutKeyLabel, desktopShortcutKeySpokenName, desktopShortcutModifierKey } from "../../lib/keyboard";
import { isMacOS } from "../../lib/platform";
import type { ShortcutGroup } from "../../types";

/**
 * The file manager layout's keys (docs/product-model.md, 2026-11-06 file
 * manager layout): Finder's keys for the list and search, and the menu bar's
 * AmpleFile commands. It has no tabs, command palette, or agent panel, so
 * their keys are not listed.
 */
export function fileManagerShortcutGroups(modifier: string, macOS: boolean, desktop: boolean): ShortcutGroup[] {
  return [
    {
      title: "Files",
      rows: [
        { keys: ["Arrow up"], action: "Select the item above." },
        { keys: ["Arrow down"], action: "Select the item below." },
        { keys: ["Shift", "Arrow down"], action: "Add the next item to the selection." },
        { keys: [modifier, "A"], action: "Select every item." },
        { keys: ["Space"], action: "Quick Look the selected item." },
        { keys: [modifier, "Arrow down"], action: "Open the selected item." },
        { keys: [modifier, "Arrow up"], action: "Go to the enclosing folder." },
        { keys: [modifier, "["], action: "Go back." },
        { keys: [modifier, "]"], action: "Go forward." },
        { keys: [modifier, "Shift", "G"], action: "Go to a folder by its path." },
        { keys: [modifier, "C"], action: "Copy the selected items (Finder can paste them too)." },
        { keys: [modifier, "V"], action: "Paste items copied here or in Finder." },
        { keys: [macOS ? "Option" : "Alt", modifier, "V"], action: "Move the items copied here into this folder." },
        { keys: [modifier, "D"], action: "Duplicate the selected items." },
        { keys: [modifier, "Z"], action: "Undo the last file change." },
        { keys: [modifier, "Shift", "Z"], action: "Redo it." },
        { keys: ["Enter"], action: "Rename the selected item." },
        { keys: [modifier, "Backspace"], action: macOS ? "Delete. Undo it from History, or from the Trash in a Standard Folder." : "Delete. Undo it from History." },
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
  return <ShortcutGroups groups={fileManagerShortcutGroups(desktopShortcutModifierKey(), isMacOS(), Boolean(window.ampleFileDesktop))} />;
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
