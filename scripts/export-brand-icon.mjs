import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Exports the macOS app icon from the Icon Composer source
// (desktop/assets/brand/AmpleFile.icon) with Apple's own renderer, so every
// size, including 16 px, is drawn by macOS rather than shrunk from 1024 px.
// The exports are committed; `npm run desktop:icons` builds icon.icns from
// them without needing Icon Composer. Run this after changing the .icon.

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const brandDir = join(rootDir, "desktop", "assets", "brand");
const iconSource = join(brandDir, "AmpleFile.icon");
const iconsetDir = join(brandDir, "AmpleFile.iconset");

const ictool = [
  "/Applications/Icon Composer.app/Contents/Executables/ictool",
  "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool",
].find((candidate) => existsSync(candidate));
if (!ictool) throw new Error("Icon Composer is not installed. Install it from developer.apple.com/icon-composer, or Xcode 26.");

function exportImage(output, points, scale) {
  execFileSync(ictool, [
    iconSource,
    "--export-image",
    "--output-file", output,
    "--platform", "macOS",
    "--rendition", "Default",
    "--width", String(points),
    "--height", String(points),
    "--scale", String(scale),
    "--design-generation", "26",
  ], { stdio: ["ignore", "ignore", "inherit"] });
}

await rm(iconsetDir, { recursive: true, force: true });
await mkdir(iconsetDir, { recursive: true });
for (const points of [16, 32, 128, 256, 512]) {
  exportImage(join(iconsetDir, `icon_${points}x${points}.png`), points, 1);
  exportImage(join(iconsetDir, `icon_${points}x${points}@2x.png`), points, 2);
}
exportImage(join(brandDir, "AmpleFile-macOS-1024.png"), 1024, 1);

console.log(`Exported the AmpleFile app icon from ${iconSource} with ${ictool}`);
