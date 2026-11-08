import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// The installer window (720 x 440 points; electron-builder.desktop.cjs puts
// the app at x 180 and Applications at x 540, both at y 260). The lockup is
// the outlined brand artwork, so the window needs no installed font for it.
// A @2x file beside the 1x one becomes a Retina TIFF in the DMG.

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const assetsDir = join(rootDir, "desktop", "assets");
const outDir = join(rootDir, "out", "generated-assets");
const lockupPath = join(assetsDir, "brand", "amplefile-lockup.svg");

const light = "#F4F5F6";
const signal = "#1F63D6";
const muted = "#5B6472";
const lockupWidth = 232;

await mkdir(outDir, { recursive: true });
const lockupSvg = await readFile(lockupPath);

async function renderBackground(scale) {
  const lockupMeta = await sharp(lockupSvg).metadata();
  const lockup = await sharp(lockupSvg, { density: (72 * lockupWidth * scale) / (lockupMeta.width ?? lockupWidth) })
    .resize({ width: lockupWidth * scale })
    .png()
    .toBuffer();
  const lockupHeight = (await sharp(lockup).metadata()).height ?? 0;
  const field = Buffer.from(`
<svg width="${720 * scale}" height="${440 * scale}" viewBox="0 0 720 440" xmlns="http://www.w3.org/2000/svg">
  <rect width="720" height="440" fill="${light}"/>
  <text x="360" y="136" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif" font-size="14" fill="${muted}">Drag AmpleFile to Applications</text>
  <path d="M292 260 H420" fill="none" stroke="${signal}" stroke-width="4" stroke-linecap="round"/>
  <path d="M407 248 L423 260 L407 272" fill="none" stroke="${signal}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);
  return sharp(field)
    .composite([{ input: lockup, left: Math.round(((720 - lockupWidth) / 2) * scale), top: Math.round(96 * scale - lockupHeight) }])
    .png()
    .toBuffer();
}

const backgroundBytes = await renderBackground(1);
const retinaBytes = await renderBackground(2);

await Promise.all([
  writeFile(join(outDir, "dmg-background.png"), backgroundBytes),
  writeFile(join(outDir, "dmg-background@2x.png"), retinaBytes),
  writeFile(join(assetsDir, "dmg-background.png"), backgroundBytes),
]);

console.log(`Generated AmpleFile DMG background at ${join(outDir, "dmg-background.png")}`);
