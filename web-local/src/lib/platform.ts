import type { AppTypographyFont } from "../types";

type DesktopPlatform = NodeJS.Platform | undefined;

function desktopPlatform(): DesktopPlatform {
  if (typeof window === "undefined") return undefined;
  return window.ampleFileDesktop?.app?.platform ?? previewPlatform();
}

/**
 * The inert UI previews (`/?fixture=connected-folder`, `/popover.html?fixture=agent`)
 * draw the Mac app, the active desktop lane: Mac words, key glyphs, and window
 * chrome. `&platform=linux` draws the Linux app's words and keys instead, and
 * `&platform=browser` the plain browser rendering.
 */
function previewPlatform(): DesktopPlatform {
  if (typeof window === "undefined" || window.ampleFileDesktop) return undefined;
  const params = new URLSearchParams(window.location.search);
  const fixture = params.get("fixture");
  if (fixture !== "connected-folder" && fixture !== "agent") return undefined;
  const requested = params.get("platform");
  if (requested === "browser") return undefined;
  if (requested === "linux") return "linux";
  return "darwin";
}

function isMacOS(platform: DesktopPlatform = desktopPlatform()): boolean {
  return platform === "darwin";
}

/** What the person's computer is called in a sentence: "Mac" on the Mac, "computer" everywhere else. */
function computerNoun(platform: DesktopPlatform = desktopPlatform()): string {
  return isMacOS(platform) ? "Mac" : "computer";
}

/** The system's own file manager in a sentence: Finder, File Explorer, or, on Linux, whichever one the desktop uses. */
function systemFileManagerName(platform: DesktopPlatform = desktopPlatform()): string {
  if (platform === "darwin") return "Finder";
  if (platform === "win32") return "File Explorer";
  return "your file manager";
}

function typographyFontForPlatform(font: AppTypographyFont, platform: DesktopPlatform = desktopPlatform()): AppTypographyFont {
  return isMacOS(platform) && font === "stable" ? "default" : font;
}

function connectedFolderEntryNativePath(rootPath: string, relativePath: string, platform: DesktopPlatform = desktopPlatform()): string {
  if (!relativePath) return rootPath;
  const separator = platform === "win32" ? "\\" : "/";
  const root = rootPath.replace(/[\\/]+$/, "");
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  return [root, ...segments].join(separator);
}

export { computerNoun, desktopPlatform, isMacOS, previewPlatform, systemFileManagerName, typographyFontForPlatform, connectedFolderEntryNativePath };
export type { DesktopPlatform };
