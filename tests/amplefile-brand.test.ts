import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

const root = process.cwd();
const asset = (name: string) => join(root, "desktop", "assets", name);
const brandAsset = (name: string) => join(root, "desktop", "assets", "brand", name);
const packAsset = (name: string) => join(root, "desktop", "assets", "brand", "pack", name);
const rendererAsset = (name: string) => join(root, "web-local", "src", "assets", "brand", name);
const read = (path: string) => readFile(join(root, path), "utf8");

async function assertBytesEqual(leftPath: string, rightPath: string, message: string) {
  const [left, right] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
  assert.ok(left.equals(right), message);
}

test("the canonical brand sources are the designer icon pack and lockups", async () => {
  for (const name of [
    "macOS/AmpleFile.icns",
    "macOS/AmpleFile-macOS-1024.png",
    "Windows/AmpleFile.ico",
    "web/favicon.ico",
    "master/amplefile-icon.svg",
    "master/amplefile-icon-small.svg",
    "monochrome/macOS-template/AmpleFileTemplate-source.png",
    "monochrome/macOS-template/AmpleFileTemplate.png",
    "monochrome/macOS-template/AmpleFileTemplate@2x.png",
    "png/transparent/amplefile-icon-512.png",
  ]) {
    await access(packAsset(name));
  }

  // The provided horizontal lockups: black carries light themes, white dark;
  // both stay monochrome and keep the wide lockup geometry.
  for (const tone of ["black", "white"] as const) {
    const summary = await pixelSummary(brandAsset(`lockup-horizontal-${tone}.png`));
    assert.equal(summary.colored, 0, `the ${tone} lockup must stay monochrome`);
    assert.ok(summary.width > summary.height * 2.4, `the ${tone} lockup must keep its horizontal geometry`);
  }

  const generator = await read("scripts/generate-desktop-icons.mjs");
  assert.match(generator, /AmpleFile\.icns/);
  assert.match(generator, /AmpleFile\.ico/);
  assert.match(generator, /AmpleFileTemplate-source\.png/);

  // Neither redrawn marks nor the pre-pack raster cuts may linger as second
  // sources of truth.
  for (const retired of [
    brandAsset("mark-flat.svg"),
    brandAsset("mark-template.svg"),
    brandAsset("mark-color-1024.png"),
    brandAsset("wordmark-color.png"),
    brandAsset("lockup-stacked-color.png"),
    asset("amplefile-icon-source.svg"),
  ]) {
    await assert.rejects(access(retired));
  }
});

test("installed desktop icons are byte-for-byte pack exports", async () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const metadata = await sharp(asset(`icon-${size}.png`)).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
  }

  for (const [installed, packSource] of [
    ["icon.icns", "macOS/AmpleFile.icns"],
    ["icon.ico", "Windows/AmpleFile.ico"],
    ["icon.png", "macOS/AmpleFile-macOS-1024.png"],
    ["icon-512.png", "macOS/AmpleFile.iconset/icon_512x512.png"],
    ["icon-16.png", "Windows/png/AmpleFile-16.png"],
    ["icon-256.png", "Windows/png/AmpleFile-256.png"],
    ["iconTemplate.png", "monochrome/macOS-template/AmpleFileTemplate.png"],
    ["iconTemplate@2x.png", "monochrome/macOS-template/AmpleFileTemplate@2x.png"],
  ] as const) {
    await assertBytesEqual(asset(installed), packAsset(packSource), `${installed} must be the pack export exactly`);
  }

  const icns = await readFile(asset("icon.icns"));
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length, "the ICNS header must cover the complete file");
  const chunkTypes: string[] = [];
  for (let offset = 8; offset < icns.length;) {
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= icns.length, "every ICNS chunk must be bounded");
    chunkTypes.push(icns.subarray(offset, offset + 4).toString("ascii"));
    offset += length;
  }
  assert.deepEqual(chunkTypes, ["icp4", "ic11", "icp5", "ic12", "icp6", "ic07", "ic13", "ic08", "ic14", "ic09", "ic10"]);

  for (const [name, size] of [["iconTemplate.png", 18], ["iconTemplate@2x.png", 36]] as const) {
    const summary = await pixelSummary(asset(name));
    assert.equal(summary.width, size);
    assert.equal(summary.height, size);
    assert.equal(summary.colored, 0, `${name} must remain black-plus-alpha for native template recoloring`);
    const components = await opaqueComponentSizes(asset(name));
    assert.equal(components.length, 3, `${name} must keep all three fold faces visually separated`);
    assert.ok(components.every((componentSize) => componentSize >= (size === 18 ? 30 : 120)), `${name} must not contain stray opaque fragments`);
  }
});

test("the empty-folder actions, loading, About, and the popover loading state keep product identity intentional", async () => {
  const [brand, brandCss, onboarding, app, settings, popover, indexHtml, popoverHtml, foundation, popoverCss, mainEntry, constants] = await Promise.all([
    read("web-local/src/components/brand/AmpleFileBrand.tsx"),
    read("web-local/src/brand.css"),
    read("web-local/src/components/onboarding/OnboardingFlow.tsx"),
    read("web-local/src/App.tsx"),
    read("web-local/src/components/modals/DesktopSettingsModal.tsx"),
    read("web-local/src/popover/PopoverApp.tsx"),
    read("web-local/index.html"),
    read("web-local/popover.html"),
    read("web-local/src/styles.css"),
    read("web-local/src/popover/popover.css"),
    read("web-local/src/main.tsx"),
    read("web-local/src/constants.ts"),
  ]);

  // Lockups are the provided horizontal artwork as single images; nothing is
  // stitched or redrawn.
  assert.match(brand, /amplefile-lockup-black\.png/);
  assert.match(brand, /amplefile-lockup-white\.png/);
  assert.match(brand, /data-animated=/);
  assert.doesNotMatch(brand, /wordmark|mark-shell|flat/i);
  assert.match(brandCss, /\.amplefile-lockup-art-white/);
  assert.match(brandCss, /--amplefile-navy:\s*#0e386c/i);
  assert.match(brandCss, /--amplefile-accent:\s*#0b6fd6/i);
  assert.match(brandCss, /--amplefile-gold:\s*#f6b516/i);
  assert.match(brandCss, /@keyframes amplefile-lockup-in/);
  assert.match(brandCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/);
  assert.match(foundation, /--ui-accent:\s*#0b6fd6/i);
  assert.match(foundation, /:root\[data-theme="dark"\][\s\S]*?--ui-accent:\s*#1ea0ff/i);
  assert.match(foundation, /--amplefile-font-display:\s*var\(--amplefile-ui-font\)/);
  assert.match(popoverCss, /--pop-accent:\s*#0b6fd6/i);
  assert.match(popoverCss, /--pop-accent:\s*#1ea0ff/i);

  // The old terracotta-and-paper palette must not resurface in token files.
  for (const [name, css] of [["brand.css", brandCss], ["styles.css", foundation], ["popover.css", popoverCss]] as const) {
    assert.doesNotMatch(css, /#(c84f30|d95735|f08363|f3f0e9|252321|1b1a18)/i, `${name} still carries the pre-rebrand palette`);
  }

  assert.match(onboarding, /Connect Folder/);
  assert.match(onboarding, /New Connected Folder/);
  assert.match(app, /<AmpleFileLoadingState message=/);
  assert.match(settings, /<AmpleFileLockup className="about-amplefile-brand"/);
  assert.match(popover, /<AmpleFileLockup className="popover-loading-brand" animated/);
  assert.doesNotMatch(popover, /<AmpleFileLockup className="popover-brand"/);
  assert.match(popover, /<h1 className="popover-chat-title">\{chatTitle\}<\/h1>/);

  // Brand fonts ship with the renderer bundle.
  assert.match(mainEntry, /@fontsource-variable\/inter/);
  assert.match(mainEntry, /@fontsource\/poppins\/600\.css/);
  assert.match(constants, /detail: "Inter"/);

  assert.match(indexHtml, /<title>AmpleFile<\/title>/);
  assert.match(popoverHtml, /<title>AmpleFile agent<\/title>/);
  for (const html of [indexHtml, popoverHtml]) {
    assert.match(html, /data:image\/png;base64,/, "the favicon must be the pack's 32px export as a data URI");
    assert.doesNotMatch(html, /data:image\/svg/, "no redrawn vector favicons");
  }
  assert.doesNotMatch(`${indexHtml}\n${popoverHtml}`, /Workspace/);
});

test("the AmpleFile agent names the popover surface, tray entry, and two-state capture button", async () => {
  const [popover, desktopMain] = await Promise.all([
    read("web-local/src/popover/PopoverApp.tsx"),
    read("desktop/src/main.ts"),
  ]);

  assert.match(popover, /The AmpleFile agent is unavailable\./);
  assert.match(popover, /aria-label="AmpleFile agent chat"/);
  assert.match(popover, /aria-label=\{requestRunning \? \(stopping \? "Stopping" : "Stop"\)/);
  // AmpleFile stays the actor: imperative composer copy keeps the product as addressee.
  assert.match(popover, /Tell AmpleFile what to do/);
  assert.match(popover, /Reply to AmpleFile/);

  assert.match(desktopMain, /\{ label: "AmpleFile agent", click: \(\) => \{ void toggleAmpleFileAgentPopover\(\); \} \}/);
  assert.match(desktopMain, /label: `Open \$\{productName\}`/);
  assert.match(desktopMain, /label: `Quit \$\{productName\}`/);

  // Native chrome carries the rebrand's neutral fields.
  assert.match(desktopMain, /light: \{ color: "#f2f4ef", symbolColor: "#1c2530" \}/);
  assert.match(desktopMain, /dark: \{ color: "#0f1622", symbolColor: "#e9eef7" \}/);
});

async function pixelSummary(path: string) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let colored = 0;
  for (let index = 0; index < info.width * info.height; index += 1) {
    const offset = index * 4;
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const alpha = data[offset + 3] ?? 0;
    if (alpha > 20 && (red !== green || green !== blue)) colored += 1;
  }
  return { width: info.width, height: info.height, colored };
}

async function opaqueComponentSizes(path: string, threshold = 80) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;
  const seen = new Uint8Array(pixelCount);
  const sizes: number[] = [];

  for (let start = 0; start < pixelCount; start += 1) {
    if (seen[start] || (data[(start * 4) + 3] ?? 0) < threshold) continue;
    const queue = [start];
    seen[start] = 1;
    let size = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor] ?? 0;
      const x = index % info.width;
      const y = Math.floor(index / info.width);
      size += 1;
      for (const neighbor of [
        x > 0 ? index - 1 : -1,
        x + 1 < info.width ? index + 1 : -1,
        y > 0 ? index - info.width : -1,
        y + 1 < info.height ? index + info.width : -1,
      ]) {
        if (neighbor < 0 || seen[neighbor] || (data[(neighbor * 4) + 3] ?? 0) < threshold) continue;
        seen[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    sizes.push(size);
  }

  return sizes.sort((left, right) => right - left);
}
