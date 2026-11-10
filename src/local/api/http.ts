/**
 * HTTP plumbing for the local API: authorizing a request (Host, origin, and
 * session token), CORS headers, reading JSON and multipart bodies within the
 * body limit, JSON and error responses, and the status-carrying errors the
 * routes throw.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { basename } from "node:path";
import { AmpleFileAutomationServiceError } from "../automations/automation-service.js";
import { AmpleFileAutomationStoreError } from "../automations/automation-store.js";
import { AmpleFileCliError } from "../cli/protocol.js";
import type { LocalApiState } from "./state.js";

interface MultipartFile {
  fieldName: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

interface MultipartBody {
  fields: Map<string, string>;
  files: MultipartFile[];
}

export function optionalBoundedInteger(value: string | null, label: "offset" | "limit" | "offsetBytes" | "lengthBytes"): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  const minimum = label === "limit" ? 1 : 0;
  if (!Number.isInteger(parsed) || parsed < minimum) throw badRequest(`${label} is invalid.`);
  return parsed;
}

export async function readJsonBody<T>(
  state: LocalApiState,
  req: IncomingMessage,
  maximumBytes?: number,
): Promise<T> {
  const bytes = await readBody(state, req, maximumBytes);
  if (!bytes.length) return {} as T;
  try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw badRequest("Request body must be valid JSON."); }
}

export async function readMultipartBody(state: LocalApiState, req: IncomingMessage): Promise<MultipartBody> {
  const contentType = req.headers["content-type"] ?? "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean)?.trim();
  if (!boundary) throw badRequest("File upload must use multipart/form-data.");
  const body = await readBody(state, req);
  const encoded = body.toString("latin1");
  const fields = new Map<string, string>();
  const files: MultipartFile[] = [];
  for (const rawPart of encoded.split(`--${boundary}`).slice(1)) {
    if (rawPart.startsWith("--")) break;
    const part = rawPart.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    const data = Buffer.from(part.slice(headerEnd + 4), "latin1");
    const disposition = /^content-disposition:\s*form-data;([^\r\n]+)$/im.exec(headers)?.[1] ?? "";
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1];
    if (!name) continue;
    const fileName = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1];
    if (fileName !== undefined) {
      files.push({
        fieldName: name,
        fileName: basename(fileName.replace(/\\/g, "/")),
        contentType: /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim() ?? "application/octet-stream",
        data,
      });
    } else {
      fields.set(name, data.toString("utf8"));
    }
  }
  return { fields, files };
}

/** A route's own bound applies under the general body cap. */
async function readBody(
  state: LocalApiState,
  req: IncomingMessage,
  maximumBytes = state.maxBodyBytes,
): Promise<Buffer> {
  const limit = Math.min(maximumBytes, state.maxBodyBytes);
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge("Request body is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw tooLarge("Request body is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function parseRelativePaths(value: string | undefined, fileCount: number): Array<string | undefined> {
  if (!value) return Array.from({ length: fileCount }, () => undefined);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error();
    return Array.from({ length: fileCount }, (_, index) => parsed[index] as string | undefined);
  } catch {
    throw badRequest("Upload relative paths are invalid.");
  }
}

export function authorize(state: LocalApiState, req: IncomingMessage): void {
  if (!hostAllowed(state, req)) throw forbidden("Host is not allowed.");
  const origin = req.headers.origin;
  if (origin && !state.allowedOrigins.includes(origin)) throw forbidden("Origin is not allowed.");
  if (state.sessionToken && req.headers["x-amplefile-session"] !== state.sessionToken) throw unauthorized("Unauthorized.");
}

const loopbackHostNames = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Refuses DNS rebinding: a page on another site whose name has been pointed
 * at this computer reaches the API with that site's name in Host, and sends
 * no Origin on a simple same-origin read. A request must name this computer
 * (a loopback name or the address the API listens on) on the port it arrived
 * at, which is what `local:dev`'s Vite proxy and the packaged app send, or be
 * the host of an allowed origin, for a proxy that keeps the page's own Host.
 */
function hostAllowed(state: LocalApiState, req: IncomingMessage): boolean {
  const host = req.headers.host?.trim().toLowerCase();
  if (!host) return false;
  const portSeparator = host.lastIndexOf(":");
  const hasPort = portSeparator > host.lastIndexOf("]");
  const name = hasPort ? host.slice(0, portSeparator) : host;
  const port = hasPort ? host.slice(portSeparator + 1) : "";
  const listenName = state.listenHost.includes(":") ? `[${state.listenHost.toLowerCase()}]` : state.listenHost.toLowerCase();
  const thisComputer = loopbackHostNames.has(name) || (name === listenName && !["0.0.0.0", "[::]"].includes(listenName));
  if (thisComputer && req.socket.localPort !== undefined && port === String(req.socket.localPort)) return true;
  return state.allowedOrigins.some((origin) => {
    try {
      const url = new URL(origin);
      return (url.protocol === "http:" || url.protocol === "https:") && url.host === host;
    } catch {
      return false;
    }
  });
}

export function setCorsHeaders(state: LocalApiState, req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && state.allowedOrigins.includes(origin)) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,last-event-id,x-amplefile-session");
  res.setHeader("vary", "Origin");
  res.setHeader("x-content-type-options", "nosniff");
}

export function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.end(); return; }
  const explicit = typeof (error as { statusCode?: unknown })?.statusCode === "number" ? (error as { statusCode: number }).statusCode : null;
  const status = explicit
    ?? ampleFileCliErrorStatus(error)
    ?? automationErrorStatus(error)
    ?? 500;
  sendJson(res, {
    error: errorMessage(error),
    ...((error instanceof AmpleFileAutomationServiceError || error instanceof AmpleFileAutomationStoreError) ? { code: error.code } : {}),
  }, status);
}

function ampleFileCliErrorStatus(error: unknown): number | null {
  if (!(error instanceof AmpleFileCliError)) return null;
  switch (error.code) {
    case "usage":
    case "protocolError": return 400;
    case "permissionDenied": return 403;
    case "notFound": return 404;
    case "conflict": return 409;
    case "unavailable": return 503;
    case "timeout": return 504;
    case "failure": return 500;
  }
}

export function automationErrorStatus(error: unknown): number | null {
  if (error instanceof AmpleFileAutomationServiceError) {
    switch (error.code) {
      case "INPUT_INVALID": return 400;
      case "NOT_FOUND": return 404;
      case "HEALTH_INVALID": return 409;
      case "SERVICE_DAMAGED": return 503;
    }
  }
  if (error instanceof AmpleFileAutomationStoreError) {
    switch (error.code) {
      case "INPUT_INVALID": return 400;
      case "NOT_FOUND": return 404;
      case "BOUND_EXCEEDED":
      case "HEALTH_INVALID":
      case "DIGEST_MISMATCH": return 409;
      case "STORE_DAMAGED":
      case "JOURNAL_UNAVAILABLE":
      case "JOURNAL_DAMAGED": return 503;
    }
  }
  return null;
}

export function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}
export function boundedOptionalId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${name} must be a string.`);
  const id = value.trim();
  if (!id || id.length > 256) throw badRequest(`${name} must be between 1 and 256 characters.`);
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(id)) {
    throw badRequest(`${name} contains unsupported control characters.`);
  }
  return id;
}

export function badRequest(message: string): Error { return httpError(400, message); }
function unauthorized(message: string): Error { return httpError(401, message); }
export function forbidden(message: string): Error { return httpError(403, message); }
export function notFound(message: string): Error { return httpError(404, message); }
function tooLarge(message: string): Error { return httpError(413, message); }
export function unavailable(message: string): Error { return httpError(503, message); }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function match(path: string, pattern: RegExp): string[] | null {
  const result = pattern.exec(path);
  return result ? result.map((value) => value === undefined ? "" : decodeURIComponent(value)) : null;
}

export function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolvePromise(); });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
