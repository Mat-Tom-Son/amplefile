import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createElement } from "react";
import { includedToolDefinitions } from "../src/shared/included-tools.js";
import { applicationAppearanceVariables, defaultApplicationAppearance } from "../src/shared/application-appearance.js";
import { createDomHarness } from "./support/dom.js";
import { findCssBrowser } from "./support/css-browser.js";

// Only Vite's graphics/CSS imports are replaced. Components, focus management,
// setup requests and responses all run normally.
const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:capability-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:capability-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(css|svg)(?:\?|$)/.test(url)) return { format: "module", source: "export default '';", shortCircuit: true };
    return next(url, context);
  },
});
const { CapabilitiesPane, CapabilityDetailsDialog } = await import("../web-local/src/components/panes/CapabilitiesPane.js");
assets.deregister();
type Item = Parameters<typeof CapabilityDetailsDialog>[0]["item"];
function included(id: string): Item {
  const tool = includedToolDefinitions.find((entry) => entry.id === id)!;
  return { id, kind: "extension", name: tool.title, description: tool.description, included: tool,
    path: `/Applications/AmpleFile.app/Contents/Resources/app.asar/node_modules/${tool.package}/resources/included-tools/extension-entry/index.ts`,
    scope: "global", origin: "top-level", source: tool.package, enabled: true, loaded: true, status: "loaded", diagnostics: [],
    tools: ["web_search", "fetch_content", "get_search_content", "code_search"], commands: [], flags: [] };
}

test("installed details keep metadata collapsed while setup, failures and controls remain actionable", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const writes: unknown[] = [];
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ status: { id: "web", state: "unknown", detail: "Brave Search key saved. The connection is verified when you search.", checkedAt: "2026-09-12T16:00:00.000Z" } });
    }
    return Response.json({ tools: [{ id: "web", state: "unknown", detail: "An obsolete explanation must not appear." }] });
  }) as typeof fetch;
  let toggles = 0;
  await dom.render(createElement(CapabilityDetailsDialog, { item: included("web"), connectedFolderId: "workshop", busy: false, onClose() {}, onToggle() { toggles++; } }));
  await dom.waitFor(() => dom.container.textContent!.includes("Not Checked"));
  const technical = dom.container.querySelector<HTMLDetailsElement>("details.capability-technical-details")!;
  assert.equal(technical.open, false);
  assert.match(technical.textContent!, /fetch_content/);
  assert.match(technical.textContent!, /app\.asar/);
  assert.doesNotMatch(dom.container.textContent!, /None registered|Flags|Commands|Executable capability|obsolete explanation/);
  const button = (name: string) => [...dom.container.querySelectorAll("button")].find((item) => item.textContent === name)!;
  await dom.act(() => button("Check").click());
  assert.deepEqual(writes, [{ connectedFolderId: "workshop", id: "web", action: "check" }], "before its status is known, Check stays available");
  assert.match(dom.container.textContent!, /Not Checked/);
  await dom.act(() => technical.querySelector("summary")!.click());
  assert.equal(technical.open, true);
  await dom.act(() => button("Turn Off").click());
  assert.equal(toggles, 1);
  await dom.render(createElement(CapabilityDetailsDialog, { item: { ...included("web"), diagnostics: [{ type: "error", message: "Search provider version mismatch" }] }, connectedFolderId: "workshop", busy: false, onClose() {} }));
  assert.match(dom.container.querySelector('.professional-diagnostics[role="status"]')!.textContent!, /Search provider version mismatch/);
});

test("ready included tools need no repeated setup copy and MCP keeps connection actions visible", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const operations: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("mcp-setup")) {
      const body = JSON.parse(String(init?.body)); operations.push(body.operation);
      return Response.json({ sessionId: "owned-session", servers: [{ name: "Calendar", scope: "global", transport: "http", endpoint: "https://example.invalid/mcp", auth: "none", credential: "not_checked", revision: "one" }], ...(body.operation === "check" ? { probe: { state: "ready", detail: "A redundant success explanation." } } : {}) });
    }
    return Response.json({ tools: includedToolDefinitions.map((tool) => ({ id: tool.id, state: "ready", detail: "A redundant success explanation." })) });
  }) as typeof fetch;
  for (const id of ["computer", "documents", "web"]) {
    await dom.render(createElement(CapabilityDetailsDialog, { key: id, item: included(id), connectedFolderId: "workshop", busy: false, onClose() {} }));
    await dom.waitFor(() => dom.container.textContent!.includes("Ready"));
    assert.doesNotMatch(dom.container.textContent!, /redundant success explanation|Set up permissions/);
  }
  await dom.render(createElement(CapabilityDetailsDialog, { key: "mcp", item: included("mcp"), connectedFolderId: "workshop", busy: false, onClose() {} }));
  await dom.waitFor(() => dom.container.textContent!.includes("No Sign-In Required"));
  const server = dom.container.querySelector(".included-mcp-list li")!;
  assert.equal(server.querySelector("details")!.open, false);
  assert.equal([...server.querySelectorAll("button")].some((button) => button.textContent === "Sign In"), false);
  const check = [...server.querySelectorAll("button")].find((button) => button.textContent === "Check")!;
  assert.equal(check.closest("details"), null);
  await dom.act(() => check.click());
  assert.match(dom.container.textContent!, /Connected/);
  assert.doesNotMatch(dom.container.textContent!, /redundant success explanation/);
  await dom.render(null);
  assert.deepEqual(operations, ["open", "check", "close"]);
});

test("Documents setup guides the LibreOffice and Tesseract installs and ticks each off by itself", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const opened: string[] = [], copied: unknown[] = [], posts: unknown[] = [];
  Object.assign(window, { ampleFileDesktop: { api: {}, shell: { openExternal: async (url: string) => { opened.push(url); } }, clipboard: { write: async (content: unknown) => { copied.push(content); } } } });
  let installed = false;
  const status = () => ({ id: "documents", checkedAt: "2026-10-18T12:00:00.000Z",
    state: installed ? "ready" : "setup_required",
    detail: installed ? "Your Worker can make documents and check how they look and what their formulas calculate." : "Your Worker can make documents but can't check how Word and PowerPoint files look or what spreadsheet formulas calculate. Install LibreOffice to turn that on.",
    documentsSetup: { platform: "darwin", homebrew: true,
      libreoffice: installed ? { found: true, path: "/Applications/LibreOffice.app/Contents/MacOS/soffice", version: "LibreOffice 26.8.1.1" } : { found: false },
      tesseract: { found: false } } });
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
    return Response.json(init?.method === "POST" ? { status: status() } : { tools: [status()] });
  }) as typeof fetch;
  await dom.render(createElement(CapabilityDetailsDialog, { item: included("documents"), connectedFolderId: "workshop", busy: false, onClose() {} }));
  await dom.waitFor(() => dom.container.textContent!.includes("Setup Needed"));
  const text = () => dom.container.textContent!;
  assert.match(text(), /can't check how Word and PowerPoint files look/);
  const rows = () => [...dom.container.querySelectorAll<HTMLElement>(".documents-engines li")];
  assert.equal(rows().length, 2);
  assert.match(rows()[0]!.textContent!, /LibreOffice.*see Word and PowerPoint pages.*brew install --cask libreoffice/);
  assert.match(rows()[1]!.textContent!, /Tesseract \(optional\).*scanned pages.*brew install tesseract/);
  assert.match(text(), /open it once so macOS can approve it/);
  const button = (row: HTMLElement, name: string) => [...row.querySelectorAll("button")].find((item) => item.textContent === name)!;
  await dom.act(() => button(rows()[0]!, "Download").click());
  await dom.act(() => button(rows()[1]!, "Install Guide").click());
  assert.deepEqual(opened, ["https://www.libreoffice.org/download/download-libreoffice/", "https://tesseract-ocr.github.io/tessdoc/Installation.html"]);
  await dom.act(() => button(rows()[0]!, "Copy").click());
  assert.deepEqual(copied, [{ text: "brew install --cask libreoffice" }]);
  assert.equal(button(rows()[0]!, "Copied").textContent, "Copied");
  assert.deepEqual(posts, [], "guidance never asks the host to install anything");
  installed = true;
  await dom.act(() => window.dispatchEvent(new window.Event("focus")));
  await dom.waitFor(() => text().includes("Ready"));
  assert.equal(rows()[0]!.classList.contains("done"), true);
  assert.equal(rows()[0]!.querySelector(".setup-checklist-state")!.textContent, "Installed");
  assert.doesNotMatch(rows()[0]!.textContent!, /brew install/);
  assert.doesNotMatch(text(), /approve it/);
  assert.equal(rows()[0]!.querySelector(".setup-checklist-state")!.getAttribute("title"), "/Applications/LibreOffice.app/Contents/MacOS/soffice · LibreOffice 26.8.1.1", "where it is and its version stay supporting detail");
  Reflect.deleteProperty(window, "ampleFileDesktop");
});

test("Installed separates cold readiness from native loading and keeps a newer setup result through late summary reads", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const summaryReads: Array<(value: Response) => void> = [];
  const writes: unknown[] = [];
  let failingCheck = false;
  const tools = [included("web"), included("computer"), { ...included("documents"), enabled: false, status: "disabled" as const }];
  const nativeBuiltins = ["codemode", "tool_search"];
  const catalog = {
    diagnostics: [], packages: [], skills: [],
    tools: nativeBuiltins.map((name) => ({ name, label: name, description: "Native Pi tool", core: true, active: true, source: "builtin" })),
    extensions: [
      ...tools.map((item) => ({ ...item, included: undefined, source: { scope: "user", origin: "top-level", source: "builtin" } })),
      ...nativeBuiltins.map((name) => ({ name: `builtin:${name}`, path: `builtin:${name}`, tools: [name], commands: [], flags: [], source: { scope: "user", origin: "top-level", source: "builtin" } })),
      { name: "builtin:tool_input_feedback", path: "builtin:tool_input_feedback", tools: [], commands: [], flags: [], source: { scope: "user", origin: "top-level", source: "builtin" } },
    ],
    resources: tools.map((item) => ({ kind: "extensions", path: item.path, enabled: item.enabled, included: item.included, metadata: { scope: "user", origin: "top-level", source: "builtin" } })),
  };
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      if (failingCheck) return Response.json({ error: "Search probe failed" }, { status: 503 });
      return Response.json({ status: { id: "web", state: "ready", checkedAt: "2026-09-12T15:01:00.000Z", detail: "Search responded." } });
    }
    if (String(input).includes("included-tools")) return failingCheck
      ? Response.json({ tools: [{ id: "web", state: "unknown", checkedAt: "2026-09-12T15:03:00.000Z", detail: "No current evidence" }] })
      : new Promise<Response>((resolve) => summaryReads.push(resolve));
    return Response.json(catalog);
  }) as typeof fetch;
  const props: Parameters<typeof CapabilitiesPane>[0] = {
    connectedFolder: { id: "first", name: "Workshop" } as never, status: { configured: true } as never,
    view: "installed", onError(message) { assert.fail(message ?? "Unexpected catalog error"); }, onViewChange() {},
  };
  await dom.render(createElement(CapabilitiesPane, props));
  // Included tools sit in the strip, each with one status word and a Set up button only when a person can act.
  const card = (name: string) => [...dom.container.querySelectorAll<HTMLElement>(".capabilities-included-tile")].find((item) => item.querySelector("strong")?.textContent === name)!;
  await dom.waitFor(() => Boolean(card("Web")));
  const status = (name: string) => card(name).querySelector(".capabilities-included-status")!.textContent;
  const setup = (name: string) => card(name).querySelector<HTMLButtonElement>(".capabilities-included-setup");
  assert.equal(dom.container.querySelector(".capabilities-included-tile .professional-status-badge"), null, "tiles carry a word, not a badge");
  assert.equal(dom.container.querySelector(".capabilities-health"), null, "no tool-count or attention line");
  assert.equal(dom.container.querySelector(".capabilities-scope-heading .capabilities-hierarchy-glyph"), null);
  assert.equal(dom.container.querySelector(".scope-global .capabilities-resource-card"), null, "included tools are not repeated under Everywhere");
  const scopeGroups = [...dom.container.querySelectorAll(".capabilities-scope-group")];
  assert.equal(scopeGroups.length, 2, "Everywhere and This Connected Folder only are both shown");
  assert.doesNotMatch(scopeGroups.map((group) => group.textContent).join("\n"), /builtin:|0 tools/);
  assert.equal(dom.container.querySelectorAll(".capabilities-core-tool-row").length, 2, "native built-ins remain discoverable once in Core Tools");
  for (const name of ["Web", "Computer Control", "Documents"]) {
    assert.equal(setup(name), null, `${name} is unchecked or off, so it never asks for setup`);
  }
  assert.equal(status("Web"), "Not Checked");
  assert.equal(status("Documents"), "Turned Off");
  assert.doesNotMatch(card("Web").textContent!, /Loaded|Ready/);
  assert.deepEqual(writes, [], "catalog inspection must not check, launch, or configure an included tool");

  await dom.act(() => card("Web").click());
  await dom.waitFor(() => summaryReads.length === 2);
  assert.doesNotMatch(dom.container.querySelector(".capability-details-dialog .modal-title")!.textContent!, /Loaded/);
  assert.match(dom.container.querySelector(".capability-technical-details")!.textContent!, /ExtensionLoadedEnabledYes/);
  const check = [...dom.container.querySelectorAll<HTMLButtonElement>(".included-tool-setup button")].find((button) => button.textContent === "Check")!;
  await dom.act(() => { check.click(); check.click(); });
  await dom.waitFor(() => dom.container.querySelector('.included-tool-status [role="status"]')?.textContent === "Ready");
  assert.deepEqual(writes, [{ connectedFolderId: "first", id: "web", action: "check" }]);
  await dom.act(() => {
    for (const complete of summaryReads) complete(Response.json({ tools: [{ id: "web", state: "unknown", checkedAt: "2026-09-12T15:02:00.000Z", detail: "A snapshot taken while the earlier-started explicit probe was running" }] }));
  });
  await dom.settle();
  assert.equal(status("Web"), "Ready", "a newer setup result outlives a late, older summary read");
  assert.equal(setup("Web"), null);
  assert.equal(dom.container.querySelector('.included-tool-status [role="status"]')!.textContent, "Ready");
  failingCheck = true;
  await dom.act(() => check.click());
  await dom.waitFor(() => dom.container.textContent!.includes("Search probe failed"));
  await dom.settle();
  assert.equal(status("Web"), "Not Checked");
  assert.equal(setup("Web"), null);
  assert.equal(dom.container.querySelector('.included-tool-status [role="status"]')!.textContent, "Not Checked");
  await dom.act(() => [...dom.container.querySelectorAll<HTMLButtonElement>(".capability-dialog-footer button")].find((button) => button.textContent === "Done")!.click());
  assert.equal(status("Web"), "Not Checked", "closing details must not restore an earlier result");
  assert.equal(setup("Web"), null);
});

test("an installed card offers Set up only for a known state that needs it", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const tools = [included("computer"), included("documents"), included("web")];
  const catalog = {
    diagnostics: [], packages: [], skills: [], tools: [],
    extensions: tools.map((item) => ({ ...item, included: undefined, source: { scope: "user", origin: "top-level", source: "builtin" } })),
    resources: tools.map((item) => ({ kind: "extensions", path: item.path, enabled: item.enabled, included: item.included, metadata: { scope: "user", origin: "top-level", source: "builtin" } })),
  };
  globalThis.fetch = (async (input) => {
    if (String(input).includes("included-tools")) return Response.json({ tools: [
      { id: "computer", state: "setup_required", checkedAt: "2026-09-12T15:02:00.000Z" },
      { id: "documents", state: "ready", checkedAt: "2026-09-12T15:02:00.000Z" },
      { id: "web", state: "unknown", checkedAt: "2026-09-12T15:02:00.000Z" },
    ] });
    return Response.json(catalog);
  }) as typeof fetch;
  await dom.render(createElement(CapabilitiesPane, {
    connectedFolder: { id: "first", name: "Workshop" } as never, status: { configured: true } as never,
    view: "installed", onError(message) { assert.fail(message ?? "Unexpected catalog error"); }, onViewChange() {},
  }));
  const tile = (name: string) => [...dom.container.querySelectorAll<HTMLElement>(".capabilities-included-tile")].find((item) => item.querySelector("strong")?.textContent === name);
  const setup = (name: string) => tile(name)?.querySelector<HTMLButtonElement>(".capabilities-included-setup");
  const status = (name: string) => tile(name)?.querySelector(".capabilities-included-status")?.textContent;
  await dom.waitFor(() => setup("Computer Control")?.textContent === "Set Up");
  assert.equal(setup("Computer Control")!.textContent, "Set Up");
  assert.equal(status("Computer Control"), "Setup Needed");
  assert.equal(setup("Documents"), null);
  assert.equal(status("Documents"), "Ready");
  assert.equal(setup(tools[2]!.name), null, "an unchecked tool never asks for setup");
  assert.equal(status(tools[2]!.name), "Not Checked");
  assert.equal(dom.container.querySelector(".capabilities-included-tile .professional-status-badge"), null);
});

test("returning to Installed refreshes readiness without a manual check, and old successful checks stay explicit", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let state = "setup_required";
  let reads = 0, failRead = false;
  const items = [included("web"), included("computer")];
  const catalog = { diagnostics: [], packages: [], skills: [], tools: [],
    extensions: items.map((item) => ({ ...item, included: undefined, source: { scope: "user", origin: "top-level", source: "builtin" } })),
    resources: items.map((item) => ({ kind: "extensions", path: item.path, enabled: true, included: item.included, metadata: { scope: "user", origin: "top-level", source: "builtin" } })),
  };
  globalThis.fetch = (async (input, init) => {
    assert.notEqual(init?.method, "POST", "automatic status reads never check or launch a tool");
    if (!String(input).includes("included-tools")) return Response.json(catalog);
    reads++;
    if (failRead) throw new Error("Synthetic read interruption");
    return Response.json({ tools: [{ id: "web", state, checkedAt: new Date().toISOString() },
      { id: "computer", state: "ready", stale: true, checkedAt: "2026-10-01T12:00:00.000Z", detail: "Permissions verified earlier" }] });
  }) as typeof fetch;
  await dom.render(createElement(CapabilitiesPane, { connectedFolder: { id: "first", name: "Workshop" } as never, status: { configured: true } as never, view: "installed", onError() {}, onViewChange() {} }));
  const tile = (name: string) => [...dom.container.querySelectorAll<HTMLElement>(".capabilities-included-tile")].find((item) => item.querySelector("strong")?.textContent === name)!;
  await dom.waitFor(() => tile("Web")?.textContent?.includes("Setup Needed") === true);
  assert.match(tile("Computer Control").textContent!, /Last Check Passed/);
  assert.equal(tile("Computer Control").classList.contains("tone-enabled"), false, "old success never claims a live green connection");
  state = "ready";
  await dom.act(() => window.dispatchEvent(new window.Event("focus")));
  await dom.waitFor(() => tile("Web").textContent?.includes("Ready") === true);
  assert.equal(tile("Web").classList.contains("tone-enabled"), true);
  failRead = true;
  await dom.act(() => window.dispatchEvent(new window.Event("focus")));
  await dom.waitFor(() => tile("Web").textContent?.includes("Last Check Passed") === true);
  assert.equal(tile("Web").classList.contains("tone-enabled"), false, "a failed status read retains only historical evidence");
  failRead = false;
  state = "setup_required";
  await dom.act(() => window.dispatchEvent(new window.Event("focus")));
  await dom.waitFor(() => tile("Web").textContent?.includes("Setup Needed") === true);
  assert.equal(reads, 4);
});

test("late readiness responses cannot cross Connected Folders or survive a closed setup owner", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let completeOld: ((value: Response) => void) | undefined;
  let completeCheck: ((value: Response) => void) | undefined;
  const delivered: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "POST") return new Promise<Response>((resolve) => { completeCheck = resolve; });
    if (String(input).includes("connectedFolderId=first")) return new Promise<Response>((resolve) => { completeOld = resolve; });
    return Response.json({ tools: [{ id: "web", state: "setup_required", checkedAt: "2026-09-12T15:02:00.000Z" }] });
  }) as typeof fetch;
  const props = { item: included("web"), busy: false, onClose() {}, onReadinessChange: (status: { state: string } | null) => { if (status) delivered.push(status.state); } };
  await dom.render(createElement(CapabilityDetailsDialog, { ...props, connectedFolderId: "first" }));
  await dom.act(() => [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Check")!.click());
  await dom.render(createElement(CapabilityDetailsDialog, { ...props, connectedFolderId: "second" }));
  await dom.waitFor(() => delivered.length === 1);
  await dom.act(() => {
    completeOld!(Response.json({ tools: [{ id: "web", state: "ready", checkedAt: "2026-09-12T15:03:00.000Z" }] }));
    completeCheck!(Response.json({ status: { id: "web", state: "ready", checkedAt: "2026-09-12T15:03:00.000Z" } }));
  });
  await dom.settle();
  assert.deepEqual(delivered, ["setup_required"]);
  assert.equal(dom.container.querySelector('.included-tool-status [role="status"]')!.textContent, "Setup Needed");
});

test("real detail CSS keeps long paths above tool lists and preserves scrolling at narrow and short sizes", { timeout: 60_000 }, async (t) => {
  const browser = await findCssBrowser();
  if (!browser) { t.skip("A Chromium binary is needed for actual layout verification."); return; }
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const scratch = await mkdtemp(join(tmpdir(), "amplefile-capability-css-"));
  try {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const markup = renderToStaticMarkup(createElement(CapabilityDetailsDialog, { item: included("web"), connectedFolderId: "workshop", busy: false, onClose() {}, onToggle() {} })).replace('<details class="capability-technical-details"', '<details open class="capability-technical-details"');
    const css = (await Promise.all(["brand.css", "styles.css", "application-appearance.css", "components/panes/included-tool-setup.css"].map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const variables = applicationAppearanceVariables({ ...defaultApplicationAppearance, textSize: "large" }, "dark");
    const payload = JSON.stringify({ markup, css, variables }).replace(/</g, "\\u003c");
    const html = `<!doctype html><pre id="result">pending</pre><script>
      const p=${payload}, results=[];
      for (const [width,height] of [[360,640],[800,400],[1200,900]]) {
        const f=document.createElement('iframe'); f.style.cssText='width:'+width+'px;height:'+height+'px'; document.body.append(f);
        const d=f.contentDocument; d.open(); d.write('<!doctype html><html data-theme="dark"><head><style>'+p.css+'</style></head><body><div class="app-shell" data-theme="dark">'+p.markup+'</div></body></html>');d.close();
        for (const [key,value] of Object.entries(p.variables)) d.documentElement.style.setProperty(key,value);
        const rect=s=>{const n=d.querySelector(s),r=n.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right,client:n.clientHeight,scroll:n.scrollHeight}};
        const b=d.querySelector('.capability-dialog-body'); b.scrollTop=b.scrollHeight;
        results.push({width,height,body:rect('.capability-dialog-body'),facts:rect('.capability-review-facts'),tools:rect('.capability-string-list'),header:rect('.modal-title'),close:rect('.modal-title button'),footer:rect('.capability-dialog-footer'),dialog:rect('.capability-dialog'),scrollTop:b.scrollTop,pageWidth:d.documentElement.scrollWidth}); f.remove();
      }
      document.getElementById('result').textContent=JSON.stringify(results);
    </script>`;
    const path = join(scratch, "fixture.html"); await writeFile(path, html);
    const { stdout } = await promisify(execFile)(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 35_000, maxBuffer: 2_000_000 });
    const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(serialized && serialized !== "pending");
    const results = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(results.length, 3);
    for (const item of results) {
      assert.ok(item.facts.bottom <= item.tools.top, "long path must end before Tools begins");
      assert.ok(item.dialog.top >= 0 && item.dialog.bottom <= item.height, "dialog stays inside the viewport");
      assert.ok(item.pageWidth <= item.width, "no horizontal overflow");
      assert.ok(item.footer.top >= item.body.bottom - 1, "actions do not overlap scrolling body");
      assert.ok(item.close.right > item.width / 2, "close control stays beside the title at narrow widths");
      if (item.width <= 800) assert.ok(item.scrollTop > 0, "all expanded metadata remains reachable by scrolling");
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("actual catalog markup keeps one header row, one toolbar row, and openable rows in the window's style", { timeout: 60_000 }, async (t) => {
  const browser = await findCssBrowser();
  if (!browser) { t.skip("Chromium is needed for actual catalog layout verification."); return; }
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  await dom.render(createElement(CapabilitiesPane, { connectedFolder: { id: "catalog", name: "Workshop" } as never, status: { configured: true } as never, view: "discover", fixtureMode: true, onError() {}, onViewChange() {}, headerEnd: createElement("button", { className: "ui-control ui-control--icon skills-extensions-close", type: "button", "aria-label": "Close Skills & Extensions" }) }));
  await dom.waitFor(() => dom.container.querySelectorAll(".capabilities-discover-card").length === 5);
  assert.equal(dom.container.querySelector('input[type="search"]')?.getAttribute("aria-label"), "Search the catalog");
  assert.equal(dom.container.querySelectorAll(".capabilities-discover-card .capabilities-kind-chip").length >= 5, true, "catalog rows name their kinds with the shared chip");
  assert.equal(dom.container.querySelectorAll(".capabilities-discover-open").length, 4, "every installable row has one control that opens its details");
  assert.match(dom.container.querySelector(".capabilities-discover-card:not(.openable)")!.textContent!, /Reference Only/);
  const scratch = await mkdtemp(join(tmpdir(), "amplefile-catalog-css-"));
  try {
    const css = (await Promise.all(["brand.css", "styles.css", "application-appearance.css", "components/file-manager/file-manager-tokens.css", "components/file-manager/file-manager-dialogs.css"].map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const scenarios = ([["light", "standard"], ["dark", "large"]] as const).map(([mode, textSize]) => ({ mode, textSize, variables: applicationAppearanceVariables({ ...defaultApplicationAppearance, textSize }, mode) }));
    const payload = JSON.stringify({ markup: dom.container.innerHTML, css, scenarios }).replace(/</g, "\\u003c");
    const html = `<!doctype html><pre id="result">pending</pre><script>
      const p=${payload}, results=[];
      for(const scenario of p.scenarios) for(const [width,height] of [[520,600],[1100,760],[1280,820]]) {
        const f=document.createElement('iframe');f.style.cssText='width:'+width+'px;height:'+height+'px';document.body.append(f);
        const d=f.contentDocument;d.open();d.write('<!doctype html><html data-theme="'+scenario.mode+'" data-amplefile-text-size="'+scenario.textSize+'"><head><style>'+p.css+'body{margin:0}</style></head><body><div class="app-shell layout-file-manager"><div class="modal-backdrop"><section class="skills-extensions-modal">'+p.markup+'</section></div></div></body></html>');d.close();
        for(const [key,value] of Object.entries(scenario.variables))d.documentElement.style.setProperty(key,value);
        const rect=s=>{const r=d.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height}};
        const body=d.querySelector('.skills-extensions-body');
        const all=s=>[...d.querySelectorAll(s)];
        const clipped=all('.capabilities-resource-title strong, .capabilities-resource-meta > span, .capabilities-kind-chip, .capabilities-view-tabs button, .capabilities-type-chips button, .capabilities-add-trigger').filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>n.textContent);
        const before=rect('.skills-extensions-header'); body.scrollTop=body.scrollHeight;
        results.push({width,mode:scenario.mode,header:before,headerAfterScroll:rect('.skills-extensions-header'),title:rect('.skills-extensions-header h1'),tabs:rect('.capabilities-view-tabs'),add:rect('.capabilities-add-trigger'),close:rect('.skills-extensions-close'),search:rect('.capabilities-search'),filters:rect('.capabilities-type-chips'),sort:rect('.capabilities-sort select'),list:rect('.capabilities-discover-list'),firstRow:rect('.capabilities-discover-card'),copy:rect('.capabilities-discover-card .capabilities-resource-copy'),scrolled:body.scrollTop,bodyTop:rect('.skills-extensions-body').top,clipped,pageWidth:d.documentElement.scrollWidth,bodyWidth:body.clientWidth,bodyScrollWidth:body.scrollWidth,listBackground:getComputedStyle(d.querySelector('.capabilities-discover-list')).backgroundColor,segmentBackground:[getComputedStyle(d.querySelector('.capabilities-view-tabs')).backgroundColor,getComputedStyle(d.querySelector('.capabilities-type-chips')).backgroundColor]});f.remove();
      }
      document.getElementById('result').textContent=JSON.stringify(results);
    </script>`;
    const path = join(scratch,"fixture.html"); await writeFile(path,html);
    const {stdout} = await promisify(execFile)(browser,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-extensions","--use-mock-keychain","--password-store=basic","--virtual-time-budget=1000","--disable-features=HangWatcher",`--user-data-dir=${join(scratch,"profile")}`,"--dump-dom",pathToFileURL(path).href],{timeout:35_000,maxBuffer:4_000_000});
    const serialized=/<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1]; assert.ok(serialized && serialized!=="pending");
    const results=JSON.parse(serialized.replaceAll("&quot;",'"').replaceAll("&amp;","&")); assert.equal(results.length,6);
    assert.ok(results.filter((item: { scrolled: number }) => item.scrolled > 0).length >= 2, "the short sizes really scroll the body");
    for(const item of results) {
      const where = `${item.mode} at ${item.width}px`;
      assert.deepEqual(item.clipped, [], `nothing is cut off without a wrap (${where})`);
      assert.ok(item.pageWidth<=item.width && item.bodyScrollWidth<=item.bodyWidth,`no horizontal overflow (${where})`);
      assert.ok(Math.abs(item.headerAfterScroll.top-item.header.top)<1,`the header stays put while the body scrolls (${where})`);
      assert.ok(item.close.right<=item.width && item.add.right<=item.close.left,`Add Custom sits before Close, never under it (${where})`);
      assert.equal(item.segmentBackground[0], item.segmentBackground[1], `one segmented control style (${where})`);
      assert.notEqual(item.listBackground, "rgba(0, 0, 0, 0)", `results sit on a card (${where})`);
      assert.ok(Math.abs(item.search.left-item.list.left)<1,`toolbar and results share one gutter (${where})`);
      assert.ok(item.copy.left>=item.list.left+20,`row text is inset from the card edge (${where})`);
      assert.ok(item.sort.top>=item.search.bottom,`sorting sits with the results, not in the search row (${where})`);
      if(item.width>=1000) {
        assert.ok(Math.abs((item.title.top+item.title.height/2)-(item.tabs.top+item.tabs.height/2))<2 && Math.abs((item.tabs.top+item.tabs.height/2)-(item.add.top+item.add.height/2))<2,`title, switch, Add Custom and Close share one row (${where})`);
        assert.ok(Math.abs(item.list.right-item.filters.right)<1,`the type filter ends on the results' right edge (${where})`);
        assert.ok(Math.abs(item.search.top-item.filters.top)<2 && Math.abs(item.search.height-item.filters.height)<1,`search and the type filter share one row and height (${where})`);
      } else assert.ok(item.filters.top>=item.search.bottom,`narrow toolbar wraps cleanly below search (${where})`);
    }
  } finally { await rm(scratch,{recursive:true,force:true}); }
});

test("Discover looks like loading until results arrive, says when the catalog fails, and opens a row's details from the row", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const item = { id: "pi-web-tools", name: "Pi web tools", description: "Browser tools.", types: ["extension"], sourceKind: "npm", installSource: "npm:@pi/web-tools", official: false, author: "Pi community", downloads: 12, repositoryUrl: "https://github.com/example/web-tools" };
  const reference = { id: "reference", name: "Reference prompts", description: "Read on GitHub.", types: ["skill"], sourceKind: "git", official: true, repositoryUrl: "https://github.com/example/reference" };
  const pendingSearches: Array<(response: Response) => void> = [];
  const searches: string[] = [];
  let failNext = false;
  let completeDetails: (() => void) | undefined;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/capabilities/discover")) {
      searches.push(new URL(url, "http://local").searchParams.get("query") ?? "");
      if (failNext) { failNext = false; return Response.json({ error: "The catalog server did not answer." }, { status: 502 }); }
      return new Promise<Response>((resolve) => pendingSearches.push(resolve));
    }
    if (url.includes("/capabilities/details")) return new Promise<Response>((resolve) => { completeDetails = () => resolve(Response.json({ item: { ...item, skills: [], extensions: ["extensions/web.ts"], prompts: [], themes: [] } })); });
    return Response.json({ diagnostics: [], packages: [], skills: [], extensions: [], resources: [], tools: [] });
  }) as typeof fetch;
  const text = () => dom.container.querySelector(".capabilities-discover-stack")?.textContent ?? "";
  const summary = () => dom.container.querySelector("#capabilities-catalog-title + p")?.textContent;
  const results = (items: unknown[]) => Response.json({ items, total: items.length, offset: 0, limit: 24, catalogUrl: "https://pi.dev/packages" });
  await dom.render(createElement(CapabilitiesPane, { connectedFolder: { id: "first", name: "Workshop" } as never, status: { configured: true } as never, view: "discover", onError(message) { assert.fail(message ?? "Unexpected error"); }, onViewChange() {} }));

  // Before the debounced request, and while it runs, the results area is loading, never empty.
  assert.match(text(), /Loading the Pi catalog/);
  assert.doesNotMatch(text(), /No Catalog Matches/);
  assert.equal(summary(), "Loading…");
  await dom.waitFor(() => pendingSearches.length === 1);
  assert.match(text(), /Loading the Pi catalog/);
  await dom.act(() => pendingSearches.shift()!(results([item, reference])));
  await dom.waitFor(() => dom.container.querySelectorAll(".capabilities-discover-card").length === 2);
  assert.equal(summary(), "2 results");

  // A new search keeps the old rows but marks them as not yet answering it.
  const search = dom.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  const type = async (value: string) => dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, value);
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  failNext = true;
  await type("web");
  assert.ok(dom.container.querySelector(".capabilities-discover-list.pending"), "rows from the previous search are marked as stale");
  assert.equal(summary(), "Loading…");
  await dom.waitFor(() => Boolean(dom.container.querySelector('[role="alert"]')));
  assert.match(dom.container.querySelector('[role="alert"]')!.textContent!, /Couldn’t Load the Pi Catalog.*did not answer/);
  assert.equal(dom.container.querySelectorAll(".capabilities-discover-card").length, 0, "a failed search never shows the previous search's results");
  assert.doesNotMatch(text(), /No Catalog Matches/);

  const tryAgain = [...dom.container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find((button) => button.textContent === "Try Again")!;
  await dom.act(() => tryAgain.click());
  await dom.waitFor(() => pendingSearches.length === 1);
  assert.equal(searches.at(-1), "web", "Try Again repeats the current search");
  assert.match(text(), /Loading the Pi catalog/);
  await dom.act(() => pendingSearches.shift()!(results([])));
  await dom.waitFor(() => text().includes("No Catalog Matches"));
  assert.match(text(), /Try other words, or show All\./);
  assert.equal(summary(), "0 results");

  await type("");
  await dom.waitFor(() => pendingSearches.length === 1);
  await dom.act(() => pendingSearches.shift()!(results([item, reference])));
  await dom.waitFor(() => dom.container.querySelectorAll(".capabilities-discover-card").length === 2);
  const referenceRow = [...dom.container.querySelectorAll(".capabilities-discover-card")].find((row) => row.textContent!.includes("Reference prompts"))!;
  assert.equal(referenceRow.querySelector("button"), null, "a reference-only row has nothing to open");
  assert.ok(referenceRow.querySelector('a[href="https://github.com/example/reference"]'), "View Source stays reachable on every row");
  const open = dom.container.querySelector<HTMLButtonElement>(".capabilities-discover-open")!;
  assert.equal(open.textContent, "Pi web tools");
  await dom.act(() => { open.focus(); open.click(); });
  await dom.waitFor(() => Boolean(completeDetails));
  assert.equal(open.getAttribute("aria-disabled"), "true", "rows wait while one row's details load");
  assert.ok(document.activeElement === open, "loading the details never takes focus from the row, as disabling it would");
  await dom.act(() => completeDetails!());
  await dom.waitFor(() => Boolean(dom.container.querySelector(".capability-review-dialog")));
  const byline = dom.container.querySelector(".capability-review-byline")!;
  assert.deepEqual([...byline.querySelectorAll(".capabilities-kind-chip")].map((chip) => chip.textContent), ["Extension"]);
  assert.match(byline.textContent!, /Pi community/);
  await dom.act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(dom.container.querySelector(".capability-review-dialog"), null);
  await dom.waitFor(() => document.activeElement === open);
  assert.equal(open.getAttribute("aria-disabled"), null, "while details loaded the row stayed focusable, so focus returns to it");
});

test("Installed says when its catalog cannot load and offers Try Again instead of loading forever", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let fail = true;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("included-tools")) return Response.json({ tools: [] });
    if (fail) return Response.json({ error: "Pi did not start." }, { status: 500 });
    return Response.json({ diagnostics: [], packages: [], skills: [], extensions: [], resources: [], tools: [] });
  }) as typeof fetch;
  await dom.render(createElement(CapabilitiesPane, { connectedFolder: { id: "first", name: "Workshop" } as never, status: { configured: true } as never, view: "installed", onError(message) { assert.fail(message ?? "A first load reports in place"); }, onViewChange() {} }));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".capabilities-state-card.error")));
  assert.match(dom.container.textContent!, /Couldn’t Load Skills & Extensions/);
  assert.doesNotMatch(dom.container.textContent!, /Loading Skills & Extensions/);
  fail = false;
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>(".capabilities-state-card.error button")!.click());
  await dom.waitFor(() => dom.container.querySelectorAll(".capabilities-scope-group").length === 2);
  assert.equal(dom.container.querySelector(".capabilities-state-card.error"), null);
});

test("Load More waits for a new search, and a Connected Folder switch reports its own failed load in place", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const row = { id: "one", name: "First result", description: "One of many.", types: ["skill"], sourceKind: "npm", installSource: "npm:first", official: false };
  const offsets: string[] = [];
  let failCatalogFor = "";
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("/capabilities/discover")) {
      offsets.push(new URL(url, "http://local").searchParams.get("offset") ?? "");
      return Response.json({ items: [row], total: 30, offset: 0, limit: 24, catalogUrl: "" });
    }
    if (url.includes("included-tools")) return Response.json({ tools: [] });
    if (failCatalogFor && url.includes(`/connected-folders/${failCatalogFor}/`)) return Response.json({ error: "Pi did not start." }, { status: 500 });
    return Response.json({ diagnostics: [], packages: [], skills: [], extensions: [], resources: [], tools: [] });
  }) as typeof fetch;
  const loadMore = () => [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Load More");
  const props = { status: { configured: true } as never, onError(message: string | null) { assert.fail(message ?? "A first load reports in place"); }, onViewChange() {} };
  await dom.render(createElement(CapabilitiesPane, { ...props, connectedFolder: { id: "first", name: "Workshop" } as never, view: "discover" }));
  await dom.waitFor(() => Boolean(loadMore()));
  const search = dom.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, "x");
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(loadMore(), undefined, "Load More is gone while the rows answer an older search");
  await dom.waitFor(() => offsets.length === 2 && Boolean(loadMore()));
  assert.deepEqual(offsets, ["0", "0"], "only fresh searches were requested");

  // The pane's catalog belongs to "first"; a failed first load for "second" still reports in place.
  await dom.render(createElement(CapabilitiesPane, { ...props, connectedFolder: { id: "first", name: "Workshop" } as never, view: "installed" }));
  await dom.waitFor(() => dom.container.querySelectorAll(".capabilities-scope-group").length === 2);
  failCatalogFor = "second";
  await dom.render(createElement(CapabilitiesPane, { ...props, connectedFolder: { id: "second", name: "Garden" } as never, view: "installed" }));
  await dom.waitFor(() => Boolean(dom.container.querySelector(".capabilities-state-card.error")));
  assert.match(dom.container.textContent!, /Couldn’t Load Skills & Extensions/);
});
