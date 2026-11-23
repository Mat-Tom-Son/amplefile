/**
 * Draws the first page of a PDF as a small WebP picture for thumbnails.ts.
 *
 * It runs in its own worker thread because PDF.js parses and draws in
 * JavaScript: a large or hostile PDF would otherwise hold the desktop's main
 * process. The host bounds the input's size, its old-generation heap, and its
 * time, and ends the thread when a request goes away or runs too long.
 *
 * PDF.js is given the file's bytes only. In Node it never fetches anything
 * over a network: its fonts, character maps, and WebAssembly decoders are read
 * from its own package folder. It does not run a PDF's JavaScript (that needs
 * the viewer's scripting sandbox, which is not loaded; PDF.js 6 has no eval
 * path at all), ignores XFA forms, and leaves out embedded pictures above a
 * pixel bound.
 *
 * This file is loaded directly as a worker entry, so it imports nothing of the
 * app's own: only Node's modules and the bundled libraries.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parentPort } from "node:worker_threads";

interface PdfThumbnailJob {
  id: number;
  bytes: ArrayBuffer;
  size: number;
  maxImagePixels: number;
}

// PDF.js reports damaged files on the console; those reports are not the app's.
for (const method of ["log", "info", "warn", "error", "debug"] as const) console[method] = () => undefined;

const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const canvas = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

async function render(job: PdfThumbnailJob): Promise<{ webp: Uint8Array; width: number; height: number }> {
  const loading = pdfjs.getDocument({
    data: new Uint8Array(job.bytes),
    standardFontDataUrl: `${join(pdfRoot, "standard_fonts")}/`,
    cMapUrl: `${join(pdfRoot, "cmaps")}/`,
    cMapPacked: true,
    wasmUrl: `${join(pdfRoot, "wasm")}/`,
    useSystemFonts: false,
    useWorkerFetch: false,
    enableXfa: false,
    maxImageSize: job.maxImagePixels,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const document = await loading.promise;
    const page = await document.getPage(1);
    const unit = page.getViewport({ scale: 1 });
    const longest = Math.max(unit.width, unit.height);
    if (!(longest > 0)) throw new Error("The first page has no size.");
    const viewport = page.getViewport({ scale: job.size / longest });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const surface = canvas.createCanvas(width, height);
    const context = surface.getContext("2d");
    // Paper is white; a page draws only its marks.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await page.render({ canvas: null, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    page.cleanup();
    const webp = await surface.encode("webp", 80);
    return { webp, width, height };
  } finally {
    await loading.destroy();
  }
}

parentPort!.on("message", (job: PdfThumbnailJob) => {
  render(job).then(
    ({ webp, width, height }) => {
      const copy = new Uint8Array(webp);
      parentPort!.postMessage({ id: job.id, ok: true, webp: copy.buffer, width, height }, [copy.buffer]);
    },
    (error: unknown) => {
      const name = (error as { name?: unknown } | null)?.name;
      parentPort!.postMessage({ id: job.id, ok: false, reason: name === "PasswordException" ? "locked" : "damaged" });
    },
  );
});
parentPort!.postMessage({ ready: true });
