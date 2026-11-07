import type { AppTheme } from "../types";

/**
 * The shell's own tokens, read where the app sits, so they carry the theme,
 * the Connected Folder's accent, and the person's appearance choices. Each app
 * token takes the first source the shell defines.
 */
const appearanceSources: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["--af-canvas", ["--ui-canvas"]],
  ["--af-surface", ["--ui-surface"]],
  ["--af-surface-subtle", ["--ui-surface-subtle"]],
  ["--af-surface-hover", ["--ui-surface-hover"]],
  ["--af-text", ["--ui-text"]],
  ["--af-text-muted", ["--ui-text-muted"]],
  ["--af-text-subtle", ["--ui-text-subtle"]],
  ["--af-border", ["--ui-border"]],
  ["--af-border-strong", ["--ui-border-strong"]],
  ["--af-accent", ["--connected-folder-accent-solid", "--ui-accent"]],
  ["--af-on-accent", ["--connected-folder-on-accent-solid", "--ui-on-accent"]],
  ["--af-accent-soft", ["--connected-folder-accent-soft-fill", "--ui-accent-soft"]],
  ["--af-accent-text", ["--connected-folder-accent-text-ui", "--ui-accent"]],
  ["--af-focus", ["--connected-folder-accent-focus-ring", "--ui-focus", "--ui-accent"]],
  ["--af-success", ["--ui-success"]],
  ["--af-danger", ["--ui-danger"]],
  ["--af-attention", ["--ui-attention"]],
  ["--af-radius-sm", ["--ui-radius-sm"]],
  ["--af-radius-md", ["--ui-radius-md"]],
  ["--af-radius-lg", ["--ui-radius-lg"]],
  ["--af-shadow", ["--ui-shadow-menu"]],
];

export function currentAppearance(element: HTMLElement, theme: AppTheme): Record<string, string> {
  const style = getComputedStyle(element);
  const appearance: Record<string, string> = {};
  for (const [token, sources] of appearanceSources) {
    for (const source of sources) {
      const value = style.getPropertyValue(source).trim();
      if (value) { appearance[token] = resolveLightDark(value, theme); break; }
    }
  }
  // Apps load Inter from their own origin under this name.
  if (style.fontFamily) appearance["--af-font"] = style.fontFamily.replace(/"Inter Variable"|'Inter Variable'/g, '"AmpleFile Inter"');
  if (style.fontSize) appearance["--af-font-size"] = style.fontSize;
  return appearance;
}

/**
 * The shell writes some colors as light-dark(a, b), which resolves by the
 * document's color scheme. An app sets its own (or none), so the pair is
 * settled here, for the theme the shell is actually showing.
 */
export function resolveLightDark(value: string, theme: AppTheme): string {
  let result = value;
  for (let start = result.indexOf("light-dark("); start >= 0; start = result.indexOf("light-dark(")) {
    let depth = 0;
    let comma = -1;
    let end = -1;
    for (let index = start + "light-dark(".length; index < result.length; index += 1) {
      const character = result[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        if (depth === 0) { end = index; break; }
        depth -= 1;
      } else if (character === "," && depth === 0 && comma < 0) comma = index;
    }
    if (end < 0 || comma < 0) return value;
    const chosen = theme === "dark" ? result.slice(comma + 1, end) : result.slice(start + "light-dark(".length, comma);
    result = result.slice(0, start) + chosen.trim() + result.slice(end + 1);
  }
  return result;
}
