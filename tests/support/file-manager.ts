import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness, type DomHarness } from "./dom.js";

/**
 * Mounts the real file manager window in jsdom. The renderer's API module is
 * replaced by `api` (a request the test does not answer throws), and Vite-only
 * imports (CSS, images, the Fluent icon CommonJS build) load as inert modules.
 * Each test file runs in its own process, so a module graph loaded here stays
 * bound to this file's mock.
 */
export interface FileManagerHarness {
  dom: DomHarness;
  module: typeof import("../../web-local/src/components/file-manager/FileManagerView.js");
  requests: Array<{ path: string; method: string; body?: unknown }>;
}

export type ApiAnswer = (path: string, options: { method?: string; body?: unknown; signal?: AbortSignal }) => unknown;

export async function createFileManagerHarness(t: { after: (cleanup: () => void | Promise<void>) => void }, answer: ApiAnswer = () => undefined): Promise<FileManagerHarness> {
  const dom = await createDomHarness();
  const realApi = await import("../../web-local/src/lib/api.js");
  const requests: FileManagerHarness["requests"] = [];
  const api = async (path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}) => {
    requests.push({ path, method: options.method ?? "GET", ...(options.body !== undefined ? { body: options.body } : {}) });
    const value = await answer(path, options);
    if (value === undefined) throw new Error(`Unexpected UI request: ${path}`);
    return value;
  };
  const createEventSource = () => ({ onmessage: null, onopen: null, onerror: null, lastEventId: "", close() {} });
  const mocked = { ...realApi, api, createEventSource };
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.__fileManagerApi = mocked;
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@fluentui/react-icons") return { url: "test:file-manager-icons", shortCircuit: true };
      if (/\.css(?:\?|$)/u.test(specifier)) return { url: "test:file-manager-css", shortCircuit: true };
      const result = next(specifier, context);
      return result.url.endsWith("/web-local/src/lib/api.ts") ? { url: "test:file-manager-api", shortCircuit: true } : result;
    },
    load(url, context, next) {
      if (url === "test:file-manager-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (url === "test:file-manager-css") return { format: "module", source: "export default '';", shortCircuit: true };
      if (url === "test:file-manager-api") return { format: "module", source: Object.keys(mocked).map((name) =>
        `export const ${name}=${typeof (mocked as Record<string, unknown>)[name] === "function" ? `(...args)=>globalThis.__fileManagerApi.${name}(...args)` : `globalThis.__fileManagerApi.${name}`};`).join("\n"), shortCircuit: true };
      if (/\.(?:png|svg|jpe?g|webp)(?:\?|$)/u.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  t.after(async () => { await dom.cleanup(); hook.deregister(); delete scope.__fileManagerApi; });
  HTMLElement.prototype.scrollIntoView = () => {};
  HTMLElement.prototype.scrollTo = () => {};
  const module = await import("../../web-local/src/components/file-manager/FileManagerView.js");
  return { dom, module, requests };
}

export { createElement };
