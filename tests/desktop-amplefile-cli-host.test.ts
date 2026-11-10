import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  AmpleFileDesktopCliHost,
  ampleFileCliInstanceData,
  ampleFileCliRequestIdFromArgv,
  ampleFileCliRequestIdFromInstanceData,
  ampleFileSecondInstanceIntent,
} from "../desktop/src/amplefile-cli-host.js";
import {
  createAmpleFileCliActRequest,
  createAmpleFileCliRequest,
  type AmpleFileActFacade,
  type AmpleFileCliKernel,
} from "../src/local/cli/index.js";

test("desktop CLI launch metadata accepts both Electron argument forms", () => {
  const id = randomUUID();
  assert.equal(ampleFileCliRequestIdFromArgv(["AmpleFile.exe", "--amplefile-cli-request", id]), id);
  assert.equal(ampleFileCliRequestIdFromArgv(["AmpleFile.exe", `--amplefile-cli-request=${id}`]), id);
  assert.equal(ampleFileCliRequestIdFromArgv(["AmpleFile.exe"]), null);
  assert.deepEqual(ampleFileCliInstanceData(id), { kind: "amplefile-cli", requestId: id });
  assert.deepEqual(ampleFileCliInstanceData(null), { kind: "amplefile-gui" });
  assert.equal(ampleFileCliRequestIdFromInstanceData({ kind: "amplefile-cli", requestId: id }), id);
  assert.equal(ampleFileCliRequestIdFromInstanceData({ kind: "amplefile-gui" }), null);
  assert.throws(() => ampleFileCliRequestIdFromArgv(["AmpleFile.exe", "--amplefile-cli-request", "../bad"]), /UUID/);
  assert.throws(() => ampleFileCliRequestIdFromArgv([
    "AmpleFile.exe",
    "--amplefile-cli-request",
    id,
    "--amplefile-cli-request",
    randomUUID(),
  ]), /only once/);
});

test("second-instance launches route by cause and CLI shape never reads as interactive", () => {
  const id = randomUUID();
  // Healthy CLI signals resolve from instance data or argv.
  assert.deepEqual(
    ampleFileSecondInstanceIntent(["AmpleFile.exe"], { kind: "amplefile-cli", requestId: id }),
    { kind: "cli", requestId: id },
  );
  assert.deepEqual(
    ampleFileSecondInstanceIntent(["AmpleFile.exe", `--amplefile-cli-request=${id}`], null),
    { kind: "cli", requestId: id },
  );
  // Genuine interactive relaunches are the only "gui" outcomes.
  assert.deepEqual(ampleFileSecondInstanceIntent(["AmpleFile.exe"], { kind: "amplefile-gui" }), { kind: "gui" });
  assert.deepEqual(ampleFileSecondInstanceIntent(["AmpleFile.exe"], null), { kind: "gui" });
  // A CLI-stamped launch whose request id was dropped in transit must stay
  // headless (docs/product-model.md: headless CLI requests never open or steal
  // focus from the interactive window) — it must never classify as "gui".
  assert.equal(ampleFileSecondInstanceIntent(["AmpleFile.exe"], { kind: "amplefile-cli" }).kind, "cli-invalid");
  assert.equal(ampleFileSecondInstanceIntent(["AmpleFile.exe"], { kind: "amplefile-cli", requestId: 7 }).kind, "cli-invalid");
  // Mangled ids from either channel reject without becoming interactive.
  assert.equal(
    ampleFileSecondInstanceIntent(["AmpleFile.exe"], { kind: "amplefile-cli", requestId: "../bad" }).kind,
    "cli-invalid",
  );
  assert.equal(ampleFileSecondInstanceIntent(["AmpleFile.exe", "--amplefile-cli-request", "nope"], null).kind, "cli-invalid");
  assert.equal(ampleFileSecondInstanceIntent(["AmpleFile.exe", "--amplefile-cli-request"], null).kind, "cli-invalid");
  assert.equal(ampleFileSecondInstanceIntent(["AmpleFile.exe", "--amplefile-cli-request="], null).kind, "cli-invalid");
});

test("desktop CLI host processes an atomic request through the executor", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "amplefile-desktop-cli-"));
  try {
    const host = new AmpleFileDesktopCliHost({
      stateRoot,
      kernel: fixtureKernel(),
      version: "9.8.7",
    });
    await host.initialize();
    const request = createAmpleFileCliRequest({
      id: randomUUID(),
      argv: ["version", "--json"],
      cwd: resolve("."),
    });
    await host.broker.writeRequest(request);
    await host.processRequest(request.id);
    const response = await host.broker.readResponse(request.id);
    assert.equal(response.exitCode, 0);
    assert.equal(response.stderr, "");
    assert.match(response.stdout, /"version": "9\.8\.7"/);
    assert.deepEqual(response.result, {
      name: "AmpleFile",
      version: "9.8.7",
      protocolVersion: 1,
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("desktop CLI host serializes overlapping requests and exposes an idle drain", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "amplefile-desktop-cli-queue-"));
  let active = 0;
  let maxActive = 0;
  const kernel = fixtureKernel();
  kernel.listConnectedFolders = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 15));
    active -= 1;
    return [];
  };
  try {
    const host = new AmpleFileDesktopCliHost({ stateRoot, kernel, version: "1.0.0" });
    await host.initialize();
    const requests = [randomUUID(), randomUUID()].map((id) => createAmpleFileCliRequest({
      id,
      argv: ["connected-folders", "list", "--json"],
      cwd: resolve("."),
    }));
    await Promise.all(requests.map((request) => host.broker.writeRequest(request)));
    const processing = requests.map((request) => host.processRequest(request.id));
    await host.whenIdle();
    await Promise.all(processing);
    assert.equal(maxActive, 1);
    assert.deepEqual(
      await Promise.all(requests.map(async (request) => (await host.broker.readResponse(request.id)).exitCode)),
      [0, 0],
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a long act verb runs beside the serial queue and never stalls other commands", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "amplefile-desktop-cli-long-"));
  const token = "f".repeat(64);
  const { access, readFile } = await import("node:fs/promises");
  const exists = (path: string) => access(path).then(() => true, () => false);
  const waitFor = async (condition: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 10_000;
    while (!await condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 5));
    }
  };
  let host: AmpleFileDesktopCliHost | null = null;
  let releaseAll = () => {};
  try {
    let releaseWait!: () => void;
    const waitHeld = new Promise<void>((resolveWait) => { releaseWait = resolveWait; });
    let releaseCreate!: () => void;
    const createHeld = new Promise<void>((resolveCreate) => { releaseCreate = resolveCreate; });
    releaseAll = () => { releaseWait(); releaseCreate(); };
    const order: string[] = [];
    const connectedFolder = { id: "connected-folder-1", name: "Act Connected Folder", connectedFolderRoot: join(stateRoot, "connected-folder") };
    const facade = {
      async jobsOutput() {
        order.push("jobs.output:start");
        await waitHeld;
        order.push("jobs.output:end");
        return { connectedFolder, job: { jobId: "job-20260731000000-00000000", state: "running" }, output: { text: "" }, wait: { outcome: "timed_out" } };
      },
      async createConversation() {
        order.push("chat.create:start");
        await createHeld;
        order.push("chat.create:end");
        return {
          connectedFolder,
          conversation: { id: "chat-1", title: "New Chat", createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z", archivedAt: null, snoozedUntil: null },
        };
      },
    } as unknown as AmpleFileActFacade;
    host = new AmpleFileDesktopCliHost({
      stateRoot,
      kernel: fixtureKernel(),
      version: "1.0.0",
      getActFacade: () => ({ facade, token }),
    });
    await host.initialize();
    const waitRequest = createAmpleFileCliActRequest({
      id: randomUUID(),
      argv: ["jobs", "output", "--connected-folder", "connected-folder-1", "--job", "job-20260731000000-00000000", "--wait", "600", "--json"],
      cwd: resolve("."),
      actToken: token,
    });
    await host.broker.writeActRequest(waitRequest);
    const waiting = host.processRequest(waitRequest.id);
    await waitFor(() => order.includes("jobs.output:start"), "the held wait");
    assert.deepEqual(order, ["jobs.output:start"]);

    // A read and an ordinary act still complete while the wait is held.
    const read = createAmpleFileCliRequest({ id: randomUUID(), argv: ["version", "--json"], cwd: resolve(".") });
    await host.broker.writeRequest(read);
    await host.processRequest(read.id);
    assert.equal((await host.broker.readResponse(read.id)).exitCode, 0);

    // Ordinary acts stay serialized, and a request behind one is claimed on
    // arrival, so its freshness is judged then rather than after the wait.
    const create = createAmpleFileCliActRequest({
      id: randomUUID(),
      argv: ["chat", "create", "--connected-folder", "connected-folder-1", "--json"],
      cwd: resolve("."),
      actToken: token,
    });
    const behind = createAmpleFileCliRequest({ id: randomUUID(), argv: ["version", "--json"], cwd: resolve(".") });
    await host.broker.writeActRequest(create);
    await host.broker.writeRequest(behind);
    const creating = host.processRequest(create.id);
    await waitFor(() => order.includes("chat.create:start"), "the held act");
    const queuedBehind = host.processRequest(behind.id);
    const behindPaths = host.broker.requestPaths(behind.id);
    await waitFor(async () => !await exists(behindPaths.request), "the queued request's claim");
    assert.equal(await exists(behindPaths.claim), true, "the queued request is already claimed");
    assert.equal(await exists(behindPaths.response), false, "and still waits its turn in line");
    releaseCreate();
    await creating;
    await queuedBehind;
    assert.equal((await host.broker.readResponse(create.id)).exitCode, 0);
    assert.equal((await host.broker.readResponse(behind.id)).exitCode, 0);
    assert.deepEqual(order, ["jobs.output:start", "chat.create:start", "chat.create:end"]);

    let idle = false;
    const draining = host.whenIdle().then(() => { idle = true; });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    assert.equal(idle, false, "the idle drain waits for the long verb too");
    releaseWait();
    await waiting;
    await draining;
    const waitResponse = await host.broker.readResponse(waitRequest.id);
    assert.equal(waitResponse.exitCode, 0, waitResponse.stderr);

    const receipts = (await readFile(host.receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const id of [waitRequest.id, create.id]) {
      assert.deepEqual(receipts.filter((line) => line.requestId === id).map((line) => line.outcome), ["accepted", "ok"]);
    }
  } finally {
    // Release anything a failed assertion left held, and let it drain, so
    // cleanup never races a request still writing its response.
    releaseAll();
    await host?.whenIdle();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("an act that waited in the queue past its bound is refused, never run late", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "amplefile-desktop-cli-late-"));
  const token = "a".repeat(64);
  let host: AmpleFileDesktopCliHost | null = null;
  let releaseFirst = () => {};
  try {
    const held = new Promise<void>((resolveHeld) => { releaseFirst = resolveHeld; });
    const created: string[] = [];
    let firstStarted = false;
    const facade = {
      async createConversation(input: { connectedFolder: string }) {
        if (!created.length && !firstStarted) {
          firstStarted = true;
          await held;
        }
        created.push(input.connectedFolder);
        return {
          connectedFolder: { id: input.connectedFolder, name: "Act Connected Folder", connectedFolderRoot: join(stateRoot, "connected-folder") },
          conversation: { id: `chat-${created.length}`, title: "New Chat", createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z", archivedAt: null, snoozedUntil: null },
        };
      },
    } as unknown as AmpleFileActFacade;
    // The executor's clock is the test's: it stands still until the test
    // moves it, so how long the machine takes never decides the outcome.
    const [first, late] = ["connected-folder-1", "connected-folder-2"].map((connectedFolder) => createAmpleFileCliActRequest({
      id: randomUUID(),
      argv: ["chat", "create", "--connected-folder", connectedFolder, "--json"],
      cwd: resolve("."),
      actToken: token,
    }));
    let clock = Date.parse(first!.createdAt);
    host = new AmpleFileDesktopCliHost({
      stateRoot,
      kernel: fixtureKernel(),
      version: "1.0.0",
      getActFacade: () => ({ facade, token }),
      maxQueuedMs: 60_000,
      now: () => new Date(clock),
    });
    await host.initialize();
    await host.broker.writeActRequest(first!);
    await host.broker.writeActRequest(late!);
    const running = host.processRequest(first!.id);
    const deadline = Date.now() + 10_000;
    while (!firstStarted) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the first act to start.");
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 5));
    }
    const queued = host.processRequest(late!.id);
    // The second act waits behind the first for longer than its bound,
    // measured from its own creation time.
    clock = Date.parse(late!.createdAt) + 60_001;
    releaseFirst();
    await Promise.all([running, queued]);

    assert.equal((await host.broker.readResponse(first!.id)).exitCode, 0);
    const refused = await host.broker.readResponse(late!.id);
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.stderr, /busy with other commands/);
    assert.deepEqual(created, ["connected-folder-1"], "the late act never reaches the facade");
    const { readFile } = await import("node:fs/promises");
    const receipts = (await readFile(host.receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(receipts.filter((line) => line.requestId === late!.id).map((line) => [line.outcome, line.errorCode]), [["rejected", "timeout"]]);
  } finally {
    releaseFirst();
    await host?.whenIdle();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("desktop CLI host gates act requests on the per-launch authority and records receipts", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "amplefile-desktop-cli-act-"));
  const token = "d".repeat(64);
  try {
    let authority: { facade: AmpleFileActFacade; token: string } | null = null;
    const chatCreates: string[] = [];
    const facade = {
      async createConversation(input: { connectedFolder: string }) {
        chatCreates.push(input.connectedFolder);
        return {
          connectedFolder: { id: "connected-folder-1", name: "Act Connected Folder", connectedFolderRoot: join(stateRoot, "connected-folder") },
          conversation: {
            id: "chat-1",
            title: "New Chat",
            createdAt: "2026-07-31T00:00:00.000Z",
            updatedAt: "2026-07-31T00:00:00.000Z",
            archivedAt: null,
            snoozedUntil: null,
          },
        };
      },
    } as unknown as AmpleFileActFacade;
    const host = new AmpleFileDesktopCliHost({
      stateRoot,
      kernel: fixtureKernel(),
      version: "1.0.0",
      getActFacade: () => authority,
    });
    await host.initialize();

    // Without the interactive app, act commands answer unavailable while v1
    // reads in the same queue keep working.
    const offline = createAmpleFileCliActRequest({
      id: randomUUID(),
      argv: ["chat", "create", "--connected-folder", "connected-folder-1", "--json"],
      cwd: resolve("."),
      actToken: token,
    });
    const read = createAmpleFileCliRequest({ id: randomUUID(), argv: ["version", "--json"], cwd: resolve(".") });
    await host.broker.writeActRequest(offline);
    await host.broker.writeRequest(read);
    await host.processRequest(offline.id);
    await host.processRequest(read.id);
    const offlineResponse = await host.broker.readResponse(offline.id);
    assert.equal(offlineResponse.exitCode, 6);
    assert.match(offlineResponse.stderr, /Open AmpleFile/);
    assert.equal((await host.broker.readResponse(read.id)).exitCode, 0);
    assert.equal(chatCreates.length, 0);

    // A stale or wrong token is rejected identically.
    authority = { facade, token };
    const wrongToken = createAmpleFileCliActRequest({
      id: randomUUID(),
      argv: ["chat", "create", "--connected-folder", "connected-folder-1", "--json"],
      cwd: resolve("."),
      actToken: "e".repeat(64),
    });
    await host.broker.writeActRequest(wrongToken);
    await host.processRequest(wrongToken.id);
    assert.equal((await host.broker.readResponse(wrongToken.id)).exitCode, 6);
    assert.equal(chatCreates.length, 0);

    // With the matching per-launch token the facade is reached and the journal
    // records accepted-then-ok around the mutation.
    const accepted = createAmpleFileCliActRequest({
      id: randomUUID(),
      argv: ["chat", "create", "--connected-folder", "connected-folder-1", "--json"],
      cwd: resolve("."),
      actToken: token,
    });
    await host.broker.writeActRequest(accepted);
    await host.processRequest(accepted.id);
    const acceptedResponse = await host.broker.readResponse(accepted.id);
    assert.equal(acceptedResponse.exitCode, 0, acceptedResponse.stderr);
    assert.match(acceptedResponse.stdout, /"chat\.create"/);
    assert.deepEqual(chatCreates, ["connected-folder-1"]);

    // Replaying the same request id after the shim has cleaned up its request
    // and response files must be refused, not re-executed.
    const { readFile, rm: removeFile } = await import("node:fs/promises");
    await removeFile(host.broker.requestPaths(accepted.id).response, { force: true });
    await host.broker.writeActRequest(accepted);
    await host.processRequest(accepted.id);
    const replayResponse = await host.broker.readResponse(accepted.id);
    assert.equal(replayResponse.exitCode, 5, replayResponse.stderr);
    assert.match(replayResponse.stderr, /already executed/);
    assert.deepEqual(chatCreates, ["connected-folder-1"], "a replayed act request must not re-run its mutation");

    const receiptLines = (await readFile(host.receipts.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      receiptLines.map((line) => line.outcome),
      ["rejected", "rejected", "accepted", "ok", "rejected"],
    );
    assert.equal(receiptLines[3]?.command, "chat.create");
    assert.equal(receiptLines[3]?.connectedFolderId, "connected-folder-1");
    assert.equal(receiptLines[3]?.conversationId, "chat-1");
    assert.equal(receiptLines[4]?.errorCode, "conflict");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("desktop main wires one receipts ledger and automation sleep/wake beside the app lifecycle", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");

  const hostStart = main.indexOf("async function ensureDesktopHost");
  assert.ok(hostStart >= 0);
  const hostBody = main.slice(hostStart, main.indexOf("\nasync function processAmpleFileCliRequest", hostStart));
  // The desktop host creates no Check service.
  assert.doesNotMatch(hostBody, /CheckService|createDesktopCheckService/);
  // No Connected Folder apps, so no settle seam for their automation runs:
  // no restricted-app service and no settle signal in the desktop host.
  assert.doesNotMatch(hostBody, /RestrictedAppService|AmpleFileSettleSignal|settleSignal/);
  // Inspect the returned value, not property order: adding another host service
  // must not weaken the assertion that the CLI host is the one exposed.
  const { default: ts } = await import("typescript");
  const source = ts.createSourceFile("desktop-host.ts", hostBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const returnedHosts: import("typescript").ObjectLiteralExpression[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)
      && node.expression.properties.some(property => ts.isShorthandPropertyAssignment(property) && property.name.text === "runtimeProvider")) returnedHosts.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(returnedHosts.length, 1, "one desktop host value exposes the runtime and services");
  const cliProperty = returnedHosts[0]!.properties.find(property => property.name && ts.isIdentifier(property.name) && property.name.text === "cli");
  assert.ok(cliProperty && ts.isShorthandPropertyAssignment(cliProperty), "the returned host carries the one CLI host");

  const apiStart = main.indexOf("function ensureInteractiveLocalApi");
  const apiEnd = main.indexOf("\nasync function createMainWindow", apiStart);
  assert.ok(apiStart !== -1 && apiEnd !== -1, "the interactive local API setup is found");
  const apiBody = main.slice(apiStart, apiEnd);
  assert.doesNotMatch(apiBody, /settleSignal/, "the local API takes no settle signal");
  assert.match(apiBody, /actReceipts: host\.cli\.receipts,/, "Settings acts and CLI acts share the CLI host's one ledger");
  assert.doesNotMatch(apiBody, /publication/i, "the local API no longer takes publication keys or a bridge slot lane");
  assert.match(apiBody, /automationPowerLifecycle = api\.automations;/);

  // Sleep suspends the automation scheduler; wake resumes it. Automation runs
  // abort on suspension and settle `interrupted` (docs/automations.md).
  const powerStart = main.indexOf("function configurePowerMonitor");
  const powerBody = main.slice(powerStart, main.indexOf("\nfunction configureAccentColorMonitor", powerStart));
  const suspendBody = powerBody.slice(powerBody.indexOf('powerMonitor.on("suspend"'), powerBody.indexOf('powerMonitor.on("resume"'));
  assert.doesNotMatch(suspendBody, /suspendAppAutomations/);
  assert.match(suspendBody, /automationPowerLifecycle\?\.suspend\(\);/);
  const resumeBody = powerBody.slice(powerBody.indexOf('powerMonitor.on("resume"'), powerBody.indexOf('powerMonitor.on("shutdown"'));
  assert.doesNotMatch(resumeBody, /resumeAppAutomations/);
  assert.match(resumeBody, /automationPowerLifecycle\?\.resume\(\)\.catch\(\(error\) =>/);
  assert.match(resumeBody, /could not resume Automations after wake/);

  // Web Access is gone: no paired-browser client or bridge in the desktop host.
  assert.doesNotMatch(main, /ensureRemoteAccessClient|AMPLEFILE_REMOTE_BRIDGE_URL/);
});

function fixtureKernel(): AmpleFileCliKernel {
  return {
    async getContext(actor) {
      return { cwd: actor.cwd, connectedFolder: null };
    },
    async listConnectedFolders() {
      return [];
    },
    async listTasks() {
      return [];
    },
    async listCapabilities() {
      return [];
    },
  };
}
