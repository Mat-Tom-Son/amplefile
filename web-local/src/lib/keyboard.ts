import { desktopPlatform, type DesktopPlatform } from "./platform";

function desktopShortcutModifierKey(platform: DesktopPlatform = desktopPlatform()): string {
  return platform === "darwin" ? "Command" : "Ctrl";
}

const macKeyGlyphs: Record<string, string> = {
  Command: "⌘",
  Ctrl: "⌃",
  Option: "⌥",
  Shift: "⇧",
  Enter: "↩",
  Esc: "⎋",
  "Arrow left": "←",
  "Arrow right": "→",
  "Arrow up": "↑",
  "Arrow down": "↓",
  Backspace: "⌫",
};

function desktopShortcutKeyLabel(key: string, platform: DesktopPlatform = desktopPlatform()): string {
  if (platform !== "darwin") return key;
  return macKeyGlyphs[key] ?? key;
}

/** Modifier order in a written shortcut: the Mac's ⌃⌥⇧⌘, and Ctrl+Alt+Shift elsewhere. */
const macModifierOrder = ["Ctrl", "Option", "Shift", "Command"];
const otherModifierOrder = ["Ctrl", "Alt", "Option", "Shift"];

/**
 * A shortcut written inline, as in a tooltip or placeholder: "⇧⌘G" on the Mac,
 * "Ctrl+Shift+G" elsewhere. Keys use the shortcut list's names, with
 * `desktopShortcutModifierKey()` for the platform's command key.
 */
function desktopShortcutText(keys: readonly string[], platform: DesktopPlatform = desktopPlatform()): string {
  const order = platform === "darwin" ? macModifierOrder : otherModifierOrder;
  const rank = (key: string) => { const index = order.indexOf(key); return index < 0 ? order.length : index; };
  const sorted = [...keys].sort((a, b) => rank(a) - rank(b));
  return platform === "darwin" ? sorted.map((key) => desktopShortcutKeyLabel(key, platform)).join("") : sorted.join("+");
}

const spokenKeyNames: Record<string, string> = {
  Ctrl: "Control",
  Esc: "Escape",
};

/** Full-word key name for assistive technology, whatever the visible glyph. */
function desktopShortcutKeySpokenName(key: string): string {
  return spokenKeyNames[key] ?? key;
}

export { desktopShortcutKeyLabel, desktopShortcutKeySpokenName, desktopShortcutModifierKey, desktopShortcutText };
