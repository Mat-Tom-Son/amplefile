import { open } from "node:fs/promises";
import { BrowserWindow, nativeImage, session, type NativeImage, type Session } from "electron";

import {
  cachedDirectoryLister,
  currentIconThemeName,
  findIconFile,
  iconBaseDirs,
  iconThemeChain,
  loadIconThemes,
  type DirectoryLister,
  type IconTheme,
  type ResolvedIconFile,
} from "./linux-icon-theme.js";
import { findExecutable } from "./open-with-linux.js";

/**
 * Menu icons for Linux Open With: the desktop's themed icon at 16 px with a
 * 2x representation. PNGs are decoded by nativeImage; SVGs, which nativeImage
 * cannot decode, are drawn by Chromium in an offscreen window.
 *
 * Why Chromium and not `rsvg-convert` or a gdk-pixbuf helper: Chromium is
 * already shipped and sandboxed, while rsvg-convert is not installed on many
 * desktops (it is missing on the reference Fedora host) and a gdk-pixbuf
 * helper would need a new native build or an interpreter dependency. Icons
 * come from system data directories, but user, Flatpak and Snap export
 * directories are writable by other apps, so the SVG is untrusted. It is
 * drawn as an `<img>`, Chromium's "SVG as image" mode, which runs no script
 * and fetches nothing, inside a sandboxed renderer with JavaScript disabled,
 * a `default-src 'none'` policy, an in-memory session that cancels every
 * non-`data:` request and denies every permission, no preload, and no
 * navigation or new windows. Files are size-bounded before they are read.
 */

const menuIconSize = 16;
const scales = [1, 2] as const;
const maxPngBytes = 1024 * 1024;
const maxSvgBytes = 512 * 1024;
const maxBatchFiles = 12;
const maxBatchBytes = 3 * 1024 * 1024;
const rasterTimeoutMs = 3_000;
const themeLifetimeMs = 5 * 60 * 1000;
const maxCachedIcons = 256;
const rasterPartition = "amplefile-linux-icon-raster";

interface ThemeContext {
  name: string;
  chain: IconTheme[];
  baseDirs: string[];
  list: DirectoryLister;
}

/** Reads a file only when it is a regular file no larger than `limit`. */
async function readBounded(path: string, limit: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return null;
    const buffer = await handle.readFile();
    return buffer.length <= limit ? buffer : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function resizedPng(image: NativeImage, pixels: number): Buffer | null {
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const sized = width === pixels && height === pixels ? image : image.resize({ width: pixels, height: pixels, quality: "best" });
  return sized.isEmpty() ? null : sized.toPNG();
}

function fullyTransparent(image: NativeImage): boolean {
  const bitmap = image.toBitmap();
  for (let index = 3; index < bitmap.length; index += 4) if (bitmap[index] !== 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// SVG rasterizing in an offscreen, script-free Chromium renderer

interface SvgJob {
  svg: Buffer;
  resolve: (images: Map<number, Buffer> | null) => void;
}

let rasterSession: Session | null = null;

function lockedDownSession(): Session {
  if (rasterSession) return rasterSession;
  const locked = session.fromPartition(rasterPartition, { cache: false });
  locked.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
  locked.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  locked.setPermissionCheckHandler(() => false);
  rasterSession = locked;
  return locked;
}

/** A page with one row per SVG: the icon at 16 px, then at 32 px. */
export function svgRasterPageHtml(svgs: Buffer[]): string {
  const rowHeight = menuIconSize * 2;
  const cells = svgs.map((svg, row) => {
    const source = `data:image/svg+xml;base64,${svg.toString("base64")}`;
    let left = 0;
    return scales.map((scale) => {
      const pixels = menuIconSize * scale;
      const cell = `<img alt="" src="${source}" style="position:absolute;left:${left}px;top:${row * rowHeight}px;width:${pixels}px;height:${pixels}px">`;
      left += pixels;
      return cell;
    }).join("");
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"></head><body style="margin:0;background:transparent;overflow:hidden">${cells}</body></html>`;
}

async function renderSvgBatch(jobs: SvgJob[]): Promise<void> {
  const width = scales.reduce((sum, scale) => sum + menuIconSize * scale, 0);
  const rowHeight = menuIconSize * 2;
  const height = rowHeight * jobs.length;
  let window: BrowserWindow | null = null;
  try {
    window = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      skipTaskbar: true,
      webPreferences: {
        offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
        session: lockedDownSession(),
        javascript: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webgl: false,
        spellcheck: false,
        devTools: false,
        backgroundThrottling: false,
      },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    const frame = await new Promise<NativeImage>((resolveFrame, rejectFrame) => {
      const timer = setTimeout(() => rejectFrame(new Error("The icon renderer timed out.")), rasterTimeoutMs);
      let loaded = false;
      contents.on("paint", (_event, _dirty, image) => {
        // Only a frame painted after load has every data: image decoded.
        if (!loaded || image.isEmpty()) return;
        clearTimeout(timer);
        resolveFrame(image);
      });
      contents.loadURL(`data:text/html;base64,${Buffer.from(svgRasterPageHtml(jobs.map((job) => job.svg))).toString("base64")}`)
        .then(() => { loaded = true; contents.invalidate(); })
        .catch((error: unknown) => { clearTimeout(timer); rejectFrame(error); });
    });
    // The frame is normally in DIPs; scale the cells if Chromium painted at another factor.
    const ratio = frame.getSize().width / width;
    jobs.forEach((job, row) => {
      const images = new Map<number, Buffer>();
      let left = 0;
      for (const scale of scales) {
        const pixels = menuIconSize * scale;
        const cell = frame.crop({ x: Math.round(left * ratio), y: Math.round(row * rowHeight * ratio), width: Math.round(pixels * ratio), height: Math.round(pixels * ratio) });
        left += pixels;
        const png = cell.isEmpty() || fullyTransparent(cell) ? null : resizedPng(cell, pixels);
        if (png) images.set(scale, png);
      }
      job.resolve(images.size ? images : null);
    });
  } catch {
    for (const job of jobs) job.resolve(null);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
  }
}

let svgQueue: SvgJob[] = [];
let svgFlushScheduled = false;

/** Rasterizes one SVG at 16 and 32 px; requests made together share one renderer. */
function rasterizeSvg(svg: Buffer): Promise<Map<number, Buffer> | null> {
  return new Promise((resolveImages) => {
    svgQueue.push({ svg, resolve: resolveImages });
    if (svgFlushScheduled) return;
    svgFlushScheduled = true;
    setTimeout(() => {
      svgFlushScheduled = false;
      const queued = svgQueue;
      svgQueue = [];
      let batch: SvgJob[] = [];
      let bytes = 0;
      const batches: SvgJob[][] = [];
      for (const job of queued) {
        if (batch.length && (batch.length >= maxBatchFiles || bytes + job.svg.length > maxBatchBytes)) {
          batches.push(batch);
          batch = [];
          bytes = 0;
        }
        batch.push(job);
        bytes += job.svg.length;
      }
      if (batch.length) batches.push(batch);
      void batches.reduce((previous, next) => previous.then(() => renderSvgBatch(next)), Promise.resolve());
    }, 0);
  });
}

// ---------------------------------------------------------------------------
// Theme context and the icon cache

let themeContext: { promise: Promise<ThemeContext>; startedAt: number } | null = null;
const fileImages = new Map<string, Promise<Map<number, Buffer> | null>>();
const iconImages = new Map<string, Promise<NativeImage | null>>();

async function loadThemeContext(env: NodeJS.ProcessEnv, home: string): Promise<ThemeContext> {
  const name = await currentIconThemeName({ env, home, findTool: (tool) => findExecutable(tool, env) });
  const baseDirs = iconBaseDirs(env, home);
  const themes = await loadIconThemes(name, baseDirs);
  return { name, chain: iconThemeChain(name, themes), baseDirs, list: cachedDirectoryLister() };
}

function currentThemeContext(env: NodeJS.ProcessEnv, home: string): Promise<ThemeContext> {
  if (themeContext && Date.now() - themeContext.startedAt < themeLifetimeMs) return themeContext.promise;
  // A reread theme (changed, or with newly installed icons) replaces what was drawn before.
  fileImages.clear();
  iconImages.clear();
  const promise = loadThemeContext(env, home);
  themeContext = { promise, startedAt: Date.now() };
  promise.catch(() => { if (themeContext?.promise === promise) themeContext = null; });
  return promise;
}

function imagesForFile(file: ResolvedIconFile): Promise<Map<number, Buffer> | null> {
  const key = `${file.format}\0${file.path}`;
  let images = fileImages.get(key);
  if (!images) {
    images = (async () => {
      if (file.format === "png") {
        const bytes = await readBounded(file.path, maxPngBytes);
        if (!bytes) return null;
        const image = nativeImage.createFromBuffer(bytes);
        const result = new Map<number, Buffer>();
        for (const scale of scales) {
          const png = resizedPng(image, menuIconSize * scale);
          if (png) result.set(scale, png);
        }
        return result.size ? result : null;
      }
      const svg = await readBounded(file.path, maxSvgBytes);
      return svg ? rasterizeSvg(svg) : null;
    })().catch(() => null);
    fileImages.set(key, images);
  }
  return images;
}

async function buildMenuIcon(icon: string, context: ThemeContext): Promise<NativeImage | null> {
  const files = await Promise.all(scales.map((scale) => findIconFile({ icon, size: menuIconSize, scale, chain: context.chain, baseDirs: context.baseDirs, list: context.list })));
  const image = nativeImage.createEmpty();
  let any = false;
  for (const [index, scale] of scales.entries()) {
    // A 2x file that cannot be drawn falls back to the 1x file, and vice versa.
    const candidates = [files[index], ...files.filter((file, other) => other !== index)].filter((file): file is ResolvedIconFile => Boolean(file));
    for (const file of candidates) {
      const png = (await imagesForFile(file))?.get(scale);
      if (!png) continue;
      image.addRepresentation({ scaleFactor: scale, width: menuIconSize * scale, height: menuIconSize * scale, buffer: png });
      any = true;
      break;
    }
  }
  return any && !image.isEmpty() ? image : null;
}

/**
 * Menu icons for desktop entry `Icon=` values, in order. Each icon that is
 * not ready within `deadlineMs` is returned as null so the menu never waits
 * on it; its drawing continues and is cached for the next menu.
 */
export async function linuxMenuIcons(icons: Array<string | null>, input: { env: NodeJS.ProcessEnv; home: string; deadlineMs: number }): Promise<Array<NativeImage | null>> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"late">((resolveLate) => { timer = setTimeout(() => resolveLate("late"), input.deadlineMs); });
  try {
    const context = currentThemeContext(input.env, input.home);
    const pending = icons.map((icon) => {
      if (!icon) return Promise.resolve(null);
      return context.then((ready) => {
        const key = icon;
        let image = iconImages.get(key);
        if (!image) {
          if (iconImages.size >= maxCachedIcons) iconImages.delete(iconImages.keys().next().value!);
          image = buildMenuIcon(icon, ready).catch(() => null);
          iconImages.set(key, image);
        }
        return image;
      }).catch(() => null);
    });
    return await Promise.all(pending.map((image) => Promise.race([image, deadline]).then((value) => value === "late" ? null : value)));
  } finally {
    clearTimeout(timer);
  }
}
