import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Builds every installed icon from the committed Manila brand sources in
// desktop/assets/brand/ (see its README). Nothing here redraws the mark:
// - icon.icns packs Apple's own Icon Composer exports (AmpleFile.iconset,
//   refreshed by `npm run brand:icon`); icon.png is the 1024 px Default.
// - The flat mark PNGs (favicons, Windows, drag images) render the SVG
//   masters: the optically redrawn small master up to 32 px, the full master
//   above that.
// - The menu-bar template pair renders amplefile-menubar.svg at 18 and 36 px,
//   plus the frames of the pulse the dot makes while the AmpleFile Agent works.
// - The dark-theme lockup is the Ink lockup with light lettering.

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const brandDir = join(rootDir, "desktop", "assets", "brand");
const outDir = join(rootDir, "desktop", "assets");
const pngDir = join(brandDir, "png");
const iconsetDir = join(brandDir, "AmpleFile.iconset");
const macIconSource = join(brandDir, "AmpleFile-macOS-1024.png");
const markSvg = join(brandDir, "amplefile-mark.svg");
const smallMarkSvg = join(brandDir, "amplefile-mark-small.svg");
const menuBarSvg = join(brandDir, "amplefile-menubar.svg");
const lockupSvg = join(brandDir, "amplefile-lockup.svg");
const darkLockupSvg = join(brandDir, "amplefile-lockup-dark.svg");

const brandColors = Object.freeze({
  manila: "#EFCB7E",
  manilaDeep: "#D4A14F",
  ink: "#16202B",
  signal: "#1F63D6",
  light: "#F4F5F6",
});

/** The flat mark sizes; sizes up to 32 px come from the small master. */
const markSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
/** Dot opacity for each frame of the working pulse; frame 0 is the resting icon. */
const workingPulse = [1, 0.8, 0.45, 0.25, 0.45, 0.8];

// Modern ICNS stores PNG payloads in typed chunks. The paired chunk types are
// intentional: macOS asks for both the point-size and Retina representation.
const icnsChunks = [
  ["icp4", "icon_16x16.png", 16],
  ["ic11", "icon_16x16@2x.png", 32],
  ["icp5", "icon_32x32.png", 32],
  ["ic12", "icon_32x32@2x.png", 64],
  ["icp6", "icon_32x32@2x.png", 64],
  ["ic07", "icon_128x128.png", 128],
  ["ic13", "icon_128x128@2x.png", 256],
  ["ic08", "icon_256x256.png", 256],
  ["ic14", "icon_256x256@2x.png", 512],
  ["ic09", "icon_512x512.png", 512],
  ["ic10", "icon_512x512@2x.png", 1024],
];

async function assertSize(path, expected) {
  const { width, height } = await sharp(path).metadata();
  if (width !== expected || height !== expected) throw new Error(`${path} is ${width}x${height}; expected ${expected}x${expected}`);
}

async function buildIcns() {
  const chunks = [];
  for (const [type, name, expectedSize] of icnsChunks) {
    const path = join(iconsetDir, name);
    if (!existsSync(path)) throw new Error(`Native icon export not found: ${path}. Run npm run brand:icon.`);
    await assertSize(path, expectedSize);
    const png = await readFile(path);
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    chunks.push(chunk);
  }
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  await writeFile(join(outDir, "icon.icns"), Buffer.concat([header, ...chunks]));
}

/** Rasterizes an SVG directly at the target size so edges stay vector-sharp. */
async function renderSvg(svg, width, height = width) {
  const metadata = await sharp(svg).metadata();
  const density = (72 * width) / (metadata.width ?? width);
  return sharp(svg, { density })
    .resize(width, height, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function renderMarks() {
  await rm(pngDir, { recursive: true, force: true });
  await mkdir(pngDir, { recursive: true });
  const [small, full] = await Promise.all([readFile(smallMarkSvg), readFile(markSvg)]);
  const rendered = new Map();
  for (const size of markSizes) {
    const png = await renderSvg(size <= 32 ? small : full, size);
    rendered.set(size, png);
    await writeFile(join(pngDir, `amplefile-mark-${size}.png`), png);
  }
  return rendered;
}

// A PNG-backed ICO (Windows Vista and later) carrying the flat mark.
async function buildIco(marks) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => marks.get(size));
  const header = Buffer.alloc(6 + (16 * sizes.length));
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + (16 * index);
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  await writeFile(join(outDir, "icon.ico"), Buffer.concat([header, ...images]));
}

// Template images are black plus alpha so macOS can recolor them for light
// and dark menu bars. The dot stays its own shape, which lets it pulse.
async function renderMenuTemplate(size, dotOpacity) {
  const source = (await readFile(menuBarSvg, "utf8"))
    .replace(/(<circle id="dot"[^>]*?)(\s*\/>)/, `$1 fill-opacity="${dotOpacity}"$2`);
  const rendered = await sharp(Buffer.from(source), { density: (72 * size) / 18 })
    .resize(size, size)
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .joinChannel(rendered, { raw: { width: size, height: size, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function renderMenuTemplates() {
  for (const [frame, opacity] of workingPulse.entries()) {
    const name = frame === 0 ? "iconTemplate" : `iconTemplateWorking${frame}`;
    await writeFile(join(outDir, `${name}.png`), await renderMenuTemplate(18, opacity));
    await writeFile(join(outDir, `${name}@2x.png`), await renderMenuTemplate(36, opacity));
  }
}

async function writeDarkLockup() {
  const lockup = await readFile(lockupSvg, "utf8");
  const letters = `<g fill="${brandColors.ink}"`;
  if (!lockup.includes(letters)) throw new Error("The lockup's Ink lettering group was not found.");
  const dark = lockup
    .replace(letters, `<g fill="${brandColors.light}"`)
    .replace('aria-label="AmpleFile horizontal lockup"', 'aria-label="AmpleFile horizontal lockup, light lettering for dark backgrounds"');
  await writeFile(darkLockupSvg, dark);
}

// The renderer's favicon is the 32 px flat mark as a data URI, so the
// window and the AmpleFile Agent popover load no separate icon file.
async function writeFavicons(marks) {
  const dataUri = `data:image/png;base64,${marks.get(32).toString("base64")}`;
  for (const page of ["index.html", "popover.html"]) {
    const path = join(rootDir, "web-local", page);
    const html = await readFile(path, "utf8");
    const updated = html.replace(/<link rel="icon" href="data:image\/png;base64,[^"]*"/, `<link rel="icon" href="${dataUri}"`);
    if (!updated.includes(dataUri)) throw new Error(`${page} has no PNG data-URI favicon to replace.`);
    await writeFile(path, updated);
  }
}

await mkdir(outDir, { recursive: true });
for (const source of [macIconSource, markSvg, smallMarkSvg, menuBarSvg, lockupSvg]) {
  if (!existsSync(source)) throw new Error(`Brand source not found: ${source}`);
}
await assertSize(macIconSource, 1024);
await buildIcns();
await copyFile(macIconSource, join(outDir, "icon.png"));
const marks = await renderMarks();
await writeFile(join(outDir, "icon-32.png"), marks.get(32));
await writeFile(join(outDir, "icon-512.png"), marks.get(512));
await buildIco(marks);
await renderMenuTemplates();
await writeDarkLockup();
await writeFavicons(marks);

console.log(`Installed the AmpleFile icons from ${brandDir} into ${outDir}`);
