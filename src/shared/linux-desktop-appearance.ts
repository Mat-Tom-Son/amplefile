/**
 * Pure readers for the Linux desktop's appearance: the XDG settings portal's
 * `org.freedesktop.appearance` keys (accent color, color scheme, contrast) and
 * the window-button layout, which GNOME publishes as
 * `org.gnome.desktop.wm.preferences button-layout` (also through the portal)
 * and KDE keeps in kwinrc. The process side lives in linux-desktop-settings.ts.
 */

export type WindowButton = "minimize" | "maximize" | "close";

/** Which window buttons the title bar draws, and on which side, in order. */
export interface WindowButtonLayout {
  left: WindowButton[];
  right: WindowButton[];
}

/**
 * What the window shows when the desktop publishes no layout: the three
 * buttons on the right, as Electron's own title-bar overlay drew them.
 */
export const fallbackWindowButtonLayout: WindowButtonLayout = Object.freeze({
  left: Object.freeze([]) as unknown as WindowButton[],
  right: Object.freeze(["minimize", "maximize", "close"]) as unknown as WindowButton[],
});

export type PortalColorScheme = "dark" | "light" | null;

export interface LinuxDesktopAppearance {
  /** `#rrggbb`, or null when the desktop sets no accent. */
  accentColor: string | null;
  /** The desktop's light/dark preference, or null for "no preference". */
  colorScheme: PortalColorScheme;
  highContrast: boolean;
  buttonLayout: WindowButtonLayout;
}

/** What the Linux main renderer's title bar needs from the desktop host. */
export interface LinuxWindowChromeState {
  buttonLayout: WindowButtonLayout;
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
  highContrast: boolean;
}

const windowButtons = new Set<WindowButton>(["minimize", "maximize", "close"]);

/** A chrome state from IPC, checked; anything malformed reads as null. */
export function parseLinuxWindowChromeState(value: unknown): LinuxWindowChromeState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const layout = record.buttonLayout as Record<string, unknown> | undefined;
  const side = (items: unknown) => Array.isArray(items) && items.length <= 3 && items.every((item) => windowButtons.has(item as WindowButton)) ? items as WindowButton[] : null;
  const left = side(layout?.left);
  const right = side(layout?.right);
  if (!left || !right) return null;
  return {
    buttonLayout: { left, right },
    maximized: record.maximized === true,
    fullScreen: record.fullScreen === true,
    focused: record.focused !== false,
    highContrast: record.highContrast === true,
  };
}

export const emptyLinuxDesktopAppearance: LinuxDesktopAppearance = Object.freeze({
  accentColor: null,
  colorScheme: null,
  highContrast: false,
  buttonLayout: fallbackWindowButtonLayout,
});

const gnomeButtons: Record<string, WindowButton> = { minimize: "minimize", maximize: "maximize", close: "close" };

/**
 * GNOME's `button-layout`, e.g. `appmenu:minimize,maximize,close`: left side,
 * a colon, right side. `appmenu`, `icon`, `spacer` and unknown names are left
 * out; duplicates keep their first place. A value without a colon is not a
 * layout GNOME would draw, so it is refused.
 */
export function parseGnomeButtonLayout(value: unknown): WindowButtonLayout | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const colon = value.indexOf(":");
  if (colon < 0) return null;
  const seen = new Set<WindowButton>();
  const side = (text: string) => text.split(",").map((name) => gnomeButtons[name.trim()]).filter((button): button is WindowButton => {
    if (!button || seen.has(button)) return false;
    seen.add(button);
    return true;
  });
  // A second colon is ignored by GNOME as part of the right side's names.
  const left = side(value.slice(0, colon));
  const right = side(value.slice(colon + 1));
  return { left, right };
}

const kdeButtons: Record<string, WindowButton> = { I: "minimize", A: "maximize", X: "close" };
const kdeDefaults = { left: "MS", right: "HIAX" };

/**
 * KDE Plasma's kwinrc `[org.kde.kdecoration2]` ButtonsOnLeft/ButtonsOnRight,
 * one letter per button (I minimize, A maximize, X close; the others are
 * menus and toggles AmpleFile does not draw). Missing keys use KDE's defaults.
 */
export function parseKdeButtonLayout(kwinrc: string): WindowButtonLayout {
  let group = "";
  const values: { left?: string; right?: string } = {};
  for (const raw of kwinrc.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) { group = header[1]!; continue; }
    if (group !== "org.kde.kdecoration2") continue;
    const entry = /^([^=\[]+)(?:\[[^\]]*\])?\s*=\s*(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1]!.trim();
    if (key === "ButtonsOnLeft") values.left = entry[2]!.trim();
    else if (key === "ButtonsOnRight") values.right = entry[2]!.trim();
  }
  const seen = new Set<WindowButton>();
  const side = (letters: string) => [...letters].map((letter) => kdeButtons[letter]).filter((button): button is WindowButton => {
    if (!button || seen.has(button)) return false;
    seen.add(button);
    return true;
  });
  return { left: side(values.left ?? kdeDefaults.left), right: side(values.right ?? kdeDefaults.right) };
}

/**
 * The portal's accent is an (ddd) sRGB triple in 0..1; any component outside
 * that range means the desktop has no accent set.
 */
export function portalAccentColor(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (!value.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 1)) return null;
  return `#${(value as number[]).map((part) => Math.round(part * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** `color-scheme`: 0 no preference, 1 prefer dark, 2 prefer light. */
export function portalColorScheme(value: unknown): PortalColorScheme {
  if (value === 1) return "dark";
  if (value === 2) return "light";
  return null;
}

/** `contrast`: 0 no preference, 1 higher contrast. */
export function portalHighContrast(value: unknown): boolean {
  return value === 1;
}

/**
 * What `nativeTheme.themeSource` should be. Electron on Linux takes its light
 * or dark from the GTK theme, not the portal, so a "system" choice follows the
 * portal's explicit preference when the desktop publishes one.
 */
export function linuxNativeThemeSource(rendererSource: "light" | "dark" | "system", portal: PortalColorScheme): "light" | "dark" | "system" {
  return rendererSource === "system" && portal ? portal : rendererSource;
}

export function sameButtonLayout(a: WindowButtonLayout, b: WindowButtonLayout): boolean {
  return a.left.join() === b.left.join() && a.right.join() === b.right.join();
}

/**
 * A small reader for the GVariant text format `gdbus` prints: tuples, arrays,
 * variants (unwrapped), strings, numbers with optional type words, booleans.
 * Anything else throws.
 */
export function parseGVariantText(text: string): unknown {
  let index = 0;
  const skip = () => { while (index < text.length && /\s/.test(text[index]!)) index += 1; };
  const expect = (char: string) => {
    skip();
    if (text[index] !== char) throw new Error(`Expected ${char} at ${index}.`);
    index += 1;
  };
  const sequence = (close: string): unknown[] => {
    const items: unknown[] = [];
    skip();
    if (text[index] === close) { index += 1; return items; }
    for (;;) {
      items.push(value());
      skip();
      if (text[index] === ",") {
        index += 1;
        skip();
        if (text[index] === close) { index += 1; return items; }
        continue;
      }
      expect(close);
      return items;
    }
  };
  const string = (quote: string): string => {
    index += 1;
    let out = "";
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\\") {
        const next = text[index + 1];
        if (next === undefined) break;
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        index += 2;
        continue;
      }
      if (char === quote) { index += 1; return out; }
      out += char;
      index += 1;
    }
    throw new Error("Unterminated string.");
  };
  const value = (): unknown => {
    skip();
    const char = text[index];
    if (char === undefined) throw new Error("Unexpected end of value.");
    if (char === "<") {
      index += 1;
      const inner = value();
      expect(">");
      return inner;
    }
    if (char === "(") { index += 1; return sequence(")"); }
    if (char === "[") { index += 1; return sequence("]"); }
    if (char === "'" || char === "\"") return string(char);
    if (char === "@") {
      // A type annotation such as `@as []`.
      while (index < text.length && !/\s/.test(text[index]!)) index += 1;
      return value();
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index))?.[0];
    if (word) {
      index += word.length;
      if (word === "true") return true;
      if (word === "false") return false;
      if (["byte", "int16", "uint16", "int32", "uint32", "int64", "uint64", "double", "handle", "objectpath", "signature"].includes(word)) return value();
      throw new Error(`Unknown word ${word}.`);
    }
    const number = /^[-+]?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|inf|nan)/.exec(text.slice(index))?.[0];
    if (number) {
      index += number.length;
      return Number(number);
    }
    throw new Error(`Unexpected ${char} at ${index}.`);
  };
  const result = value();
  skip();
  if (index !== text.length) throw new Error(`Trailing text at ${index}.`);
  return result;
}

/** The value from `gdbus call ... Settings.ReadOne` (or the older `Read`) output, e.g. `(<uint32 1>,)`. */
export function parsePortalReadOutput(stdout: string): unknown {
  const parsed = parseGVariantText(stdout.trim());
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("A portal read returns one value.");
  return parsed[0];
}

export interface PortalSettingChange {
  namespace: string;
  key: string;
  value: unknown;
}

const settingChangedPrefix = /^\S+: org\.freedesktop\.portal\.Settings\.SettingChanged\s+/;

/** One `gdbus monitor` line announcing a SettingChanged signal, or null for any other line. */
export function parseSettingChangedLine(line: string): PortalSettingChange | null {
  const match = settingChangedPrefix.exec(line);
  if (!match) return null;
  try {
    const parsed = parseGVariantText(line.slice(match[0].length).trim());
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    return { namespace: parsed[0], key: parsed[1], value: parsed[2] };
  } catch {
    return null;
  }
}

/** A `gdbus monitor` line saying the watched name gained an owner (the portal started or restarted). */
export function isPortalOwnerAppearedLine(line: string): boolean {
  return /^The name org\.freedesktop\.portal\.Desktop is owned by /.test(line.trim());
}

/** KDE Plasma sessions keep their own button layout in kwinrc. */
export function isKdeDesktop(currentDesktop: string | undefined): boolean {
  return (currentDesktop ?? "").split(":").some((name) => name.trim().toUpperCase() === "KDE");
}
