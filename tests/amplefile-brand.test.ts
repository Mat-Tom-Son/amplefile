import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

const root = process.cwd();
const asset = (name: string) => join(root, "desktop", "assets", name);
const brandAsset = (name: string) => join(root, "desktop", "assets", "brand", name);
const read = (path: string) => readFile(join(root, path), "utf8");

async function assertBytesEqual(leftPath: string, rightPath: string, message: string) {
  const [left, right] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
  assert.ok(left.equals(right), message);
}

test("the Manila brand sources are flat, named vector masters plus the Icon Composer icon", async () => {
  for (const name of [
    "AmpleFile.icon/icon.json",
    "AmpleFile-macOS-1024.png",
    "AmpleFile.iconset/icon_16x16.png",
    "AmpleFile.iconset/icon_512x512@2x.png",
    "amplefile-share-1200x630.png",
    "source/OFL.txt",
  ]) {
    await access(brandAsset(name));
  }

  for (const name of ["amplefile-mark.svg", "amplefile-mark-small.svg", "amplefile-menubar.svg"]) {
    const svg = await readFile(brandAsset(name), "utf8");
    for (const id of ["folder-back", "folder-front", "dot"]) assert.match(svg, new RegExp(`id="${id}"`), `${name} keeps its ${id} shape`);
  }
  for (const name of ["amplefile-mark.svg", "amplefile-mark-small.svg", "amplefile-menubar.svg", "amplefile-wordmark.svg", "amplefile-lockup.svg"]) {
    const svg = await readFile(brandAsset(name), "utf8");
    assert.doesNotMatch(svg, /<(linearGradient|radialGradient|filter|image|text)\b/, `${name} must stay flat, outlined artwork`);
  }
  const mark = await readFile(brandAsset("amplefile-mark.svg"), "utf8");
  assert.match(mark, /fill="#EFCB7E"/);
  assert.match(mark, /fill="#D4A14F"/);
  assert.match(mark, /fill="#1F63D6"/);

  const icon = JSON.parse(await readFile(brandAsset("AmpleFile.icon/icon.json"), "utf8")) as { groups: Array<{ name: string }> };
  assert.deepEqual(icon.groups.map((group) => group.name).sort(), ["Background", "Dot", "Folder Back", "Folder Front"]);

  // Apple's 512 pt @2x export is the Default export itself.
  await assertBytesEqual(brandAsset("AmpleFile.iconset/icon_512x512@2x.png"), brandAsset("AmpleFile-macOS-1024.png"), "the iconset and the 1024 px export must come from the same .icon");

  // The folder-cube pack and its lockups must not linger as second sources.
  for (const retired of [
    brandAsset("pack"),
    brandAsset("lockup-horizontal-black.png"),
    brandAsset("lockup-horizontal-white.png"),
    join(root, "web-local", "src", "assets", "brand"),
    asset("icon-1024.png"),
    asset("icon-16.png"),
  ]) {
    await assert.rejects(access(retired));
  }
});

test("installed desktop icons are built from the brand sources", async () => {
  await assertBytesEqual(asset("icon.png"), brandAsset("AmpleFile-macOS-1024.png"), "icon.png must be the Icon Composer Default export");
  await assertBytesEqual(asset("icon-32.png"), brandAsset("png/amplefile-mark-32.png"), "icon-32.png must be the flat 32 px mark");
  for (const size of [16, 32, 48, 128, 256, 512, 1024]) {
    const metadata = await sharp(brandAsset(`png/amplefile-mark-${size}.png`)).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
  }

  const icns = await readFile(asset("icon.icns"));
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length, "the ICNS header must cover the complete file");
  const chunks = new Map<string, Buffer>();
  for (let offset = 8; offset < icns.length;) {
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= icns.length, "every ICNS chunk must be bounded");
    chunks.set(icns.subarray(offset, offset + 4).toString("ascii"), icns.subarray(offset + 8, offset + length));
    offset += length;
  }
  assert.deepEqual([...chunks.keys()], ["icp4", "ic11", "icp5", "ic12", "icp6", "ic07", "ic13", "ic08", "ic14", "ic09", "ic10"]);
  assert.ok(chunks.get("icp4")!.equals(await readFile(brandAsset("AmpleFile.iconset/icon_16x16.png"))), "16 px is Apple's own rendering");
  assert.ok(chunks.get("ic10")!.equals(await readFile(brandAsset("AmpleFile-macOS-1024.png"))));

  const ico = await readFile(asset("icon.ico"));
  assert.equal(ico.readUInt16LE(2), 1, "icon.ico must be an icon file");
  assert.equal(ico.readUInt16LE(4), 7, "icon.ico carries 16 through 256 px");
  const firstOffset = ico.readUInt32LE(6 + 12);
  assert.equal(ico.subarray(firstOffset, firstOffset + 4).toString("latin1"), "\x89PNG");

  const lockup = await readFile(brandAsset("amplefile-lockup.svg"), "utf8");
  const darkLockup = await readFile(brandAsset("amplefile-lockup-dark.svg"), "utf8");
  assert.match(darkLockup, /<g fill="#F4F5F6"/, "the dark lockup has light lettering");
  assert.equal(darkLockup.replace('<g fill="#F4F5F6"', '<g fill="#16202B"').replace(/ aria-label="[^"]*"/, ""), lockup.replace(/ aria-label="[^"]*"/, ""), "the dark lockup changes only the lettering color");

  const resting = new Map<number, number>();
  for (const [name, size] of [["iconTemplate.png", 18], ["iconTemplate@2x.png", 36]] as const) {
    const summary = await pixelSummary(asset(name));
    assert.equal(summary.width, size);
    assert.equal(summary.height, size);
    assert.equal(summary.colored, 0, `${name} must remain black-plus-alpha for native template recoloring`);
    const components = await opaqueComponentSizes(asset(name));
    assert.equal(components.length, 2, `${name} keeps the folder outline and the dot apart`);
    resting.set(size, await dotAlpha(asset(name), size));
  }
  // The working pulse: the same outline, with the dot fading and returning.
  for (let frame = 1; frame <= 5; frame += 1) {
    for (const [suffix, size] of [["", 18], ["@2x", 36]] as const) {
      const path = asset(`iconTemplateWorking${frame}${suffix}.png`);
      assert.equal((await pixelSummary(path)).colored, 0);
      assert.ok(await dotAlpha(path, size) < resting.get(size)!, `frame ${frame} dims the dot`);
    }
  }
  await assert.rejects(access(asset("iconTemplateWorking6.png")));

  const favicon = `data:image/png;base64,${(await readFile(brandAsset("png/amplefile-mark-32.png"))).toString("base64")}`;
  for (const page of ["web-local/index.html", "web-local/popover.html"]) {
    assert.ok((await read(page)).includes(`<link rel="icon" href="${favicon}"`), `${page} uses the 32 px mark as its favicon`);
  }

  const builder = await read("electron-builder.desktop.cjs");
  assert.match(builder, /from: "desktop\/assets",\s+to: "assets",[\s\S]*?filter: \["\*\*\/\*", "!brand\/\*\*"\]/, "the app does not ship the brand sources");
});

test("the empty-folder actions, loading, About, and the popover loading state keep product identity intentional", async () => {
  const [brand, brandCss, onboarding, app, settings, popover, indexHtml, popoverHtml, foundation, popoverCss, mainEntry, constants] = await Promise.all([
    read("web-local/src/components/brand/AmpleFileBrand.tsx"),
    read("web-local/src/brand.css"),
    read("web-local/src/components/file-manager/FileManagerWelcome.tsx"),
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

  // Lockups are the outlined brand lockup as single images; nothing is
  // stitched or redrawn.
  assert.match(brand, /desktop\/assets\/brand\/amplefile-lockup\.svg/);
  assert.match(brand, /desktop\/assets\/brand\/amplefile-lockup-dark\.svg/);
  assert.match(brand, /data-animated=/);
  assert.doesNotMatch(brand, /wordmark|mark-shell|\.png/i);
  assert.match(brandCss, /\.amplefile-lockup-art-on-dark/);
  assert.match(brandCss, /--amplefile-lockup-height:/);
  assert.match(brandCss, /--amplefile-manila:\s*#efcb7e/i);
  assert.match(brandCss, /--amplefile-manila-deep:\s*#d4a14f/i);
  assert.match(brandCss, /--amplefile-signal:\s*#1f63d6/i);
  assert.match(brandCss, /--amplefile-accent:\s*#0b6fd6/i);
  // The folder-cube palette is gone.
  assert.doesNotMatch(brandCss, /#(0e386c|22cfc6|f6b516)/i);
  assert.match(brandCss, /@keyframes amplefile-lockup-in/);
  assert.match(brandCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/);
  assert.match(foundation, /--ui-accent:\s*#0b6fd6/i);
  assert.match(foundation, /:root\[data-theme="dark"\][\s\S]*?--ui-accent:\s*#1ea0ff/i);
  assert.match(foundation, /--amplefile-font-display:\s*var\(--amplefile-ui-font\)/);
  assert.match(popoverCss, /--pop-accent:\s*#0b6fd6/i);
  assert.match(popoverCss, /--pop-accent:\s*#1ea0ff/i);

  // The terracotta-and-paper palette must not appear in token files.
  for (const [name, css] of [["brand.css", brandCss], ["styles.css", foundation], ["popover.css", popoverCss]] as const) {
    assert.doesNotMatch(css, /#(c84f30|d95735|f08363|f3f0e9|252321|1b1a18)/i, `${name} still carries the pre-rebrand palette`);
  }

  assert.match(onboarding, /Connect Folder/);
  assert.match(onboarding, /New Connected Folder/);
  assert.match(app, /<AmpleFileLoadingState message=/);
  assert.match(settings, /<AmpleFileLockup className="about-amplefile-brand"/);
  assert.match(popover, /<AmpleFileLockup className="popover-loading-brand" animated/);
  assert.doesNotMatch(popover, /<AmpleFileLockup className="popover-brand"/);
  assert.match(popover, /<h1 className="popover-chat-title" title=\{historyOpen \? undefined : chatTitle\}>\{historyOpen \? "Chats" : chatTitle\}<\/h1>/);

  // Brand fonts ship with the renderer bundle.
  assert.match(mainEntry, /@fontsource-variable\/inter/);
  assert.match(mainEntry, /@fontsource\/poppins\/600\.css/);
  assert.match(constants, /detail: "Inter"/);

  assert.match(indexHtml, /<title>AmpleFile<\/title>/);
  assert.match(popoverHtml, /<title>AmpleFile Agent<\/title>/);
  for (const html of [indexHtml, popoverHtml]) {
    assert.match(html, /data:image\/png;base64,/, "the favicon must be the 32 px mark as a data URI");
    assert.doesNotMatch(html, /data:image\/svg/, "no redrawn vector favicons");
  }
});

test("the AmpleFile Agent names the popover surface, tray entry, and two-state capture button", async () => {
  const [popover, desktopMain] = await Promise.all([
    read("web-local/src/popover/PopoverApp.tsx"),
    read("desktop/src/main.ts"),
  ]);

  assert.match(popover, /The AmpleFile Agent is unavailable\./);
  assert.match(popover, /aria-label="AmpleFile Agent chat"/);
  assert.match(popover, /aria-label=\{requestRunning \? \(stopping \? "Stopping" : "Stop"\)/);
  // AmpleFile stays the actor: imperative composer copy keeps the product as addressee.
  assert.match(popover, /Tell AmpleFile what to do/);
  assert.match(popover, /Reply to AmpleFile/);

  assert.match(desktopMain, /\{ label: "AmpleFile Agent", click: \(\) => \{ void toggleAmpleFileAgentPopover\(\); \} \}/);
  assert.match(desktopMain, /label: `Open \$\{productName\}`/);
  assert.match(desktopMain, /label: `Quit \$\{productName\}`/);

  // Native chrome carries the rebrand's neutral fields.
  assert.match(desktopMain, /light: \{ color: "#f2f4ef", symbolColor: "#1c2530" \}/);
  assert.match(desktopMain, /dark: \{ color: "#0f1622", symbolColor: "#e9eef7" \}/);
});

/** The total alpha in the dot's quarter of the menu-bar template. */
async function dotAlpha(path: string, size: number) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = size / 18;
  let total = 0;
  for (let y = Math.floor(9.5 * scale); y < Math.ceil(13 * scale); y += 1) {
    for (let x = Math.floor(10.75 * scale); x < Math.ceil(14.25 * scale); x += 1) total += data[((y * info.width) + x) * 4 + 3] ?? 0;
  }
  return total;
}

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
