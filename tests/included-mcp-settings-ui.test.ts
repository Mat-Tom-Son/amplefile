import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { createDomHarness } from "./support/dom.js";

test("MCP Turn off/on pins the displayed revision, preserves errors until refresh, and distinguishes sign-in from enablement", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  const { IncludedMcpSetup } = await import("../web-local/src/components/panes/IncludedMcpSetup.js");
  let server = { scope: "project", name: "Fixture service", revision: "a".repeat(64), disabled: false, transport: "http", endpoint: "https://example.invalid/mcp", exposure: "codemode", auth: "automatic", credential: "missing", environmentKeys: [], headerKeys: [] };
  const calls: any[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    assert.equal(body.connectedFolderId, "connected-folder-fixture");
    if (body.operation === "open") return Response.json({ sessionId: "setup-fixture", servers: [server] });
    assert.equal(body.sessionId, "setup-fixture");
    if (body.operation === "close") return Response.json({ closed: true });
    if (body.operation === "list") return Response.json({ servers: [server] });
    assert.equal(body.operation, "enabled"); assert.equal(body.scope, "project"); assert.equal(body.name, server.name);
    assert.equal(typeof body.enabled, "boolean");
    if (body.expectedRevision !== server.revision) return Response.json({ error: "This service changed. Refresh connections before continuing." }, { status: 409 });
    server = { ...server, disabled: !body.enabled, revision: (body.enabled ? "d" : "b").repeat(64) };
    return Response.json({ servers: [server] });
  };
  const button = (text: string) => { const found = [...dom.container.querySelectorAll("button")].find(item => item.textContent === text); assert.ok(found, `Missing ${text}`); return found; };
  await dom.render(createElement(IncludedMcpSetup, { connectedFolderId: "connected-folder-fixture", enabled: true }));
  await dom.waitFor(() => dom.container.textContent?.includes("Turn Off") === true);
  assert.match(dom.container.textContent!, /No Saved Sign-In/);
  assert.match(dom.container.textContent!, /This Connected Folder only/, "the scope uses the same words as Skills & Extensions");
  assert.doesNotMatch(dom.container.textContent!, /(?<!No )Sign[- ][Ii]n [Rr]equired/);
  await dom.act(() => button("Turn Off").click());
  await dom.waitFor(() => dom.container.textContent?.includes("Turned Off") === true);
  assert.equal(button("Check").disabled, true);
  assert.equal(button("Sign In").disabled, true);
  assert.deepEqual(calls.at(-1), { scope: "project", name: server.name, expectedRevision: "a".repeat(64), enabled: false, connectedFolderId: "connected-folder-fixture", sessionId: "setup-fixture", operation: "enabled" });
  server = { ...server, revision: "c".repeat(64) };
  await dom.act(() => button("Turn On").click());
  await dom.waitFor(() => !!dom.container.querySelector('[role="alert"]'));
  assert.match(dom.container.querySelector('[role="alert"]')!.textContent!, /service changed/);
  assert.equal(server.disabled, true);
  assert.equal(calls.at(-1).expectedRevision, "b".repeat(64));
  await dom.act(() => button("Refresh").click());
  await dom.waitFor(() => !dom.container.querySelector('[role="alert"]'));
  await dom.act(() => button("Turn On").click());
  await dom.waitFor(() => dom.container.textContent?.includes("Turn Off") === true);
  assert.equal(calls.at(-1).expectedRevision, "c".repeat(64)); assert.equal(calls.at(-1).enabled, true);
  assert.equal(button("Check").disabled, false);
  assert.match(dom.container.textContent!, /No Saved Sign-In/);
  await dom.render(createElement(IncludedMcpSetup, { connectedFolderId: "connected-folder-fixture", enabled: false }));
  assert.equal(button("Turn Off").disabled, true, "a disabled Extension cannot change its native connection");
});

test("a connection check's sign-in evidence shows on its row, also after the setup is closed and opened again, until the definition or its sign-in changes", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  const { IncludedMcpSetup } = await import("../web-local/src/components/panes/IncludedMcpSetup.js");
  type Row = { scope: string; name: string; revision: string; disabled: boolean; transport: string; endpoint: string; exposure: string; auth: string; credential: string; environmentKeys: string[]; headerKeys: string[]; lastCheck?: { state: string; signIn: string | null; checkedAt: string } };
  let server: Row = { scope: "project", name: "Open service", revision: "a".repeat(64), disabled: false, transport: "http", endpoint: "http://127.0.0.1/mcp", exposure: "codemode", auth: "automatic", credential: "not_checked", environmentKeys: [], headerKeys: [] };
  // The host keeps each connection's last check (src/local/agent/included-mcp-setup.ts); this stands in for it.
  let kept: (Row["lastCheck"] & { revision: string }) | null = null;
  const row = (): Row => { const { lastCheck: _old, ...rest } = server; return kept && kept.revision === server.revision ? { ...rest, lastCheck: { state: kept.state, signIn: kept.signIn, checkedAt: kept.checkedAt } } : rest; };
  let signIn: string | null = "not_needed";
  const opened: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.operation === "open") { opened.push(body.connectedFolderId); return Response.json({ sessionId: `setup-${opened.length}`, servers: [row()] }); }
    if (body.operation === "close") return Response.json({ closed: true });
    if (body.operation === "list") return Response.json({ servers: [row()] });
    if (body.operation === "check") {
      const probe = signIn === "required"
        ? { state: "setup_required", detail: "The service needs you to sign in before it can be used.", checkedAt: "t", tools: 0, resources: 0, prompts: 0, signIn }
        : { state: "ready", detail: "ok", checkedAt: "t", tools: 1, resources: 0, prompts: 0, signIn };
      kept = { state: probe.state, signIn: probe.signIn, checkedAt: probe.checkedAt, revision: body.expectedRevision };
      return Response.json({ probe, lastCheck: { state: kept.state, signIn: kept.signIn, checkedAt: kept.checkedAt } });
    }
    if (body.operation === "disconnect") { kept = null; server = { ...server, credential: "missing" }; return Response.json({ servers: [row()] }); }
    throw new Error(`unexpected ${body.operation}`);
  };
  const button = (text: string) => [...dom.container.querySelectorAll("button")].find((item) => item.textContent === text);
  // The row's status, after its scope ("This Connected Folder only · …").
  const status = () => dom.container.querySelector(".included-mcp-list small")!.textContent!.split(" · ").slice(1).join(" · ");
  const waitFor = async (label: string, predicate: () => boolean) => {
    try { await dom.waitFor(predicate); } catch { throw new Error(`${label}: ${dom.container.textContent}`); }
  };
  await dom.render(createElement(IncludedMcpSetup, { connectedFolderId: "connected-folder-check", enabled: true }));
  await waitFor("setup opens", () => Boolean(button("Check")));
  assert.match(status(), /Sign-In Unknown Until Checked/, "before a check the row does not guess whether sign-in is needed");
  assert.doesNotMatch(status(), /Sign-In Not Checked/);
  assert.ok(button("Sign In"));

  await dom.act(() => button("Check")!.click());
  await waitFor("check shows on the row", () => status().includes("Connected"));
  assert.match(status(), /Connected · No Sign-In Needed/);
  assert.equal(button("Sign In"), undefined, "a service the check found needs no sign-in offers none");

  // The review's sequence: close the details and open them again.
  await dom.render(createElement("div"));
  await dom.render(createElement(IncludedMcpSetup, { connectedFolderId: "connected-folder-check", enabled: true }));
  await waitFor("setup opens again", () => opened.length === 2 && Boolean(button("Check")));
  assert.match(status(), /Connected · No Sign-In Needed/, "the check stays with the connection, not with the dialog that ran it");
  assert.equal(button("Sign In"), undefined);

  await dom.act(() => button("Refresh")!.click());
  await waitFor("refresh clears the check line", () => !dom.container.querySelector('p[role="status"]'));
  assert.match(status(), /Connected · No Sign-In Needed/, "the row's evidence stands while its definition is unchanged");

  server = { ...server, revision: "b".repeat(64) };
  await dom.act(() => button("Refresh")!.click());
  await waitFor("new revision retires the check", () => !status().includes("Connected"));
  assert.match(status(), /Sign-In Unknown Until Checked/, "a changed definition retires the old check");

  signIn = "required";
  await dom.act(() => button("Check")!.click());
  await waitFor("refused check shows Needs Sign-In", () => status().includes("Needs Sign-In"));
  assert.ok(button("Sign In"));

  signIn = "saved";
  await dom.act(() => button("Check")!.click());
  await waitFor("saved sign-in shows Signed In", () => status().includes("Connected · Signed In"));

  await dom.act(() => button("Disconnect")!.click());
  await waitFor("a sign-in change retires the check", () => !status().includes("Connected"));
  assert.match(status(), /No Saved Sign-In/);
});
