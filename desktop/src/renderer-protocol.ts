import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The internal scheme has one host; every page and asset lives under it. */
const rendererHost = "app";
/** The route for the one image the windows show from the desktop assets. */
const desktopAssetRoutePrefix = "/_desktop-assets/";
const desktopAssetFile = "icon-32.png";

export interface RendererRequestSources {
  /** The renderer build: see `rendererBuildDirectory`. */
  rendererRoot: string;
  /** The desktop assets directory that holds the window icon. */
  desktopAssets: string;
  /** Electron's `net.fetch`, given a `file:` URL. */
  fetchFile: (fileUrl: string) => Promise<Response>;
}

/**
 * The renderer build (the main window and the AmpleFile Agent popover) sits
 * at `dist/web-local` under the application root in every mode: the
 * repository for unpackaged Electron, and `app.asar` for a packaged app,
 * where Electron's ASAR integrity validation covers every file in it.
 */
export function rendererBuildDirectory(appRoot: string): string {
  return join(appRoot, "dist", "web-local");
}

/**
 * Answer one request to the internal scheme: a file of the renderer build,
 * or the one desktop icon, and nothing else.
 */
export function handleRendererRequest(request: { url: string; method: string }, sources: RendererRequestSources): Promise<Response> | Response {
  const url = new URL(request.url);
  if (url.hostname !== rendererHost) return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  let requestedPath: string;
  try {
    requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  } catch {
    // A malformed percent escape names no file.
    return new Response("Bad request", { status: 400 });
  }
  if (requestedPath.startsWith(desktopAssetRoutePrefix)) {
    if (requestedPath !== `${desktopAssetRoutePrefix}${desktopAssetFile}`) return new Response("Not found", { status: 404 });
    return serveProtocolFile(sources.desktopAssets, desktopAssetFile, request.method, sources.fetchFile);
  }
  return serveProtocolFile(sources.rendererRoot, requestedPath.replace(/^\/+/, ""), request.method, sources.fetchFile);
}

/**
 * Answer with one file from `rootDir` and nothing outside it. Electron's
 * file: loader and Node's `fs` both read through `app.asar`, so a packaged
 * renderer never leaves the archive.
 */
function serveProtocolFile(
  rootDir: string,
  requestedPath: string,
  method: string,
  fetchFile: (fileUrl: string) => Promise<Response>,
): Promise<Response> | Response {
  const candidate = resolve(rootDir, requestedPath);
  const relativeCandidate = relative(rootDir, candidate);
  if (/^\.\.(?:[\\/]|$)/.test(relativeCandidate) || isAbsolute(relativeCandidate)) return new Response("Not found", { status: 404 });
  // Only a file has bytes to answer with; a directory, like a missing path,
  // is not found rather than an error from the file: loader.
  if (!isFile(candidate)) return new Response("Not found", { status: 404 });
  if (method === "HEAD") return new Response(null, { status: 200 });
  return fetchFile(pathToFileURL(candidate).href);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
