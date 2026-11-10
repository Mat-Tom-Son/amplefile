import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
 * Answer one internal-scheme request from `rootDir` and nothing outside it.
 * `fetchFile` is Electron's `net.fetch`; its file: loader and Node's `fs`
 * both read through `app.asar`, so a packaged renderer never leaves the
 * archive.
 */
export function serveProtocolFile(
  rootDir: string,
  requestedPath: string,
  method: string,
  fetchFile: (fileUrl: string) => Promise<Response>,
): Promise<Response> | Response {
  const candidate = resolve(rootDir, requestedPath);
  const relativeCandidate = relative(rootDir, candidate);
  if (/^\.\.(?:[\\/]|$)/.test(relativeCandidate) || isAbsolute(relativeCandidate)) return new Response("Not found", { status: 404 });
  if (!existsSync(candidate)) return new Response("Not found", { status: 404 });
  if (method === "HEAD") return new Response(null, { status: 200 });
  return fetchFile(pathToFileURL(candidate).href);
}
