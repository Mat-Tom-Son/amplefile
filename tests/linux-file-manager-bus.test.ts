import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  decodeMessage,
  DBusMessageType,
  encodeMessage,
  maxMessageBytes,
  messageLength,
  parseBusAddresses,
  SessionBusConnection,
  splitSignature,
  type SessionBusAddress,
} from "../desktop/src/linux-session-bus.js";
import {
  FileManagerService,
  fileManagerBusName,
  fileManagerObjectPath,
  type FileManagerRequest,
  type FileManagerServiceState,
} from "../desktop/src/linux-file-manager-service.js";
import { writeFileManagerServiceFile } from "../desktop/src/linux-file-manager-integration.js";

/**
 * The session-bus client and the FileManager1 service. The wire format is
 * checked directly; the live tests start a private dbus-daemon (skipped when
 * it is missing) and call the service with GLib's gdbus, so AmpleFile's
 * marshalling is checked against another implementation, not only itself.
 */

const run = promisify(execFile);
const hasProgram = (name: string) => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
const dbusDaemonAvailable = process.platform === "linux" && hasProgram("dbus-daemon");
const gdbusAvailable = hasProgram("gdbus");

test("a method call survives encoding and decoding, header and body", () => {
  const bytes = encodeMessage({
    type: DBusMessageType.MethodCall,
    flags: 0,
    destination: fileManagerBusName,
    path: fileManagerObjectPath,
    interface: "org.freedesktop.FileManager1",
    member: "ShowItems",
    signature: "assa{sv}(yb)",
    body: [["file:///tmp/a", "file:///tmp/b c"], "startup-1", [["key", { signature: "u", value: 7 }]], [255, true]],
  }, 42);
  assert.equal(messageLength(bytes), bytes.length);
  assert.equal(messageLength(bytes.subarray(0, 15)), null);
  const message = decodeMessage(bytes);
  assert.equal(message.serial, 42);
  assert.equal(message.member, "ShowItems");
  assert.equal(message.path, fileManagerObjectPath);
  assert.equal(message.destination, fileManagerBusName);
  assert.equal(message.signature, "assa{sv}(yb)");
  assert.deepEqual(message.body, [["file:///tmp/a", "file:///tmp/b c"], "startup-1", [["key", { signature: "u", value: 7 }]], [255, true]]);
});

test("a big-endian message decodes", () => {
  // Hand-built: METHOD_RETURN, serial 3, fields (5, <u 9>) (8, <g "u">), body u32 0x01020304.
  const bytes = Buffer.from([
    0x42, 2, 0, 1, 0, 0, 0, 4, 0, 0, 0, 3, 0, 0, 0, 15,
    5, 1, 0x75, 0, 0, 0, 0, 9,
    8, 1, 0x67, 0, 1, 0x75, 0,
    0, // pad the header to 8
    1, 2, 3, 4,
  ]);
  assert.equal(messageLength(bytes), bytes.length);
  const decoded = decodeMessage(bytes);
  assert.equal(decoded.type, DBusMessageType.MethodReturn);
  assert.equal(decoded.replySerial, 9);
  assert.deepEqual(decoded.body, [0x01020304]);
});

test("malformed messages and signatures are refused", () => {
  const good = encodeMessage({ type: DBusMessageType.MethodCall, flags: 0, path: "/", member: "M", signature: "s", body: ["x"] }, 1);
  assert.throws(() => decodeMessage(good.subarray(0, good.length - 1)));
  const badBool = encodeMessage({ type: DBusMessageType.MethodCall, flags: 0, path: "/", member: "M", signature: "b", body: [true] }, 1);
  badBool.writeUInt32LE(2, badBool.length - 4);
  assert.throws(() => decodeMessage(badBool), /boolean/);
  assert.throws(() => splitSignature("a"), /Truncated/);
  assert.throws(() => splitSignature("(s"), /Unclosed/);
  assert.throws(() => splitSignature("{sss}"), /Invalid/);
  assert.throws(() => splitSignature("z"), /Unknown/);
  assert.throws(() => encodeMessage({ type: DBusMessageType.MethodCall, flags: 0, path: "/", member: "M", signature: "s", body: ["a\0b"] }, 1), /NUL/);
  assert.throws(() => encodeMessage({ type: DBusMessageType.MethodCall, flags: 0, path: "/", member: "M", signature: "s", body: ["x".repeat(maxMessageBytes)] }, 1), /too large/);
});

test("bus addresses: unix path, abstract, runtime, escapes; other transports are skipped", () => {
  assert.deepEqual(parseBusAddresses("unix:path=/run/user/1000/bus"), [{ kind: "path", path: "/run/user/1000/bus" }]);
  assert.deepEqual(parseBusAddresses("tcp:host=localhost,port=1;unix:abstract=/tmp/dbus-X,guid=abc"), [{ kind: "abstract", name: "/tmp/dbus-X" }]);
  assert.deepEqual(parseBusAddresses("unix:path=/tmp/a%20b"), [{ kind: "path", path: "/tmp/a b" }]);
  assert.deepEqual(parseBusAddresses("unix:runtime=yes", { XDG_RUNTIME_DIR: "/run/user/7" }), [{ kind: "path", path: "/run/user/7/bus" }]);
  assert.deepEqual(parseBusAddresses("launchd:env=X"), []);
  assert.deepEqual(parseBusAddresses(undefined), []);
});

// ---------------------------------------------------------------------------
// A private bus

interface PrivateBus {
  address: string;
  addresses: SessionBusAddress[];
  env: NodeJS.ProcessEnv;
  root: string;
}

async function privateBus(t: test.TestContext, configure?: (root: string) => Promise<void>): Promise<PrivateBus> {
  const root = await mkdtemp(join(tmpdir(), "amplefile-bus-"));
  await mkdir(join(root, "run"), { recursive: true });
  await configure?.(root);
  const config = join(root, "session.conf");
  await writeFile(config, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir=${root}</listen><standard_session_servicedirs/>
<policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>
`);
  const env = { ...process.env, XDG_DATA_HOME: join(root, "home-data"), XDG_DATA_DIRS: join(root, "system-data"), XDG_RUNTIME_DIR: join(root, "run") };
  const daemon = spawn("dbus-daemon", [`--config-file=${config}`, "--nofork", "--print-address=1"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const address = await new Promise<string>((resolve, reject) => {
    let output = "";
    daemon.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split("\n")[0];
      if (output.includes("\n") && line) resolve(line.trim());
    });
    daemon.once("error", reject);
    daemon.once("exit", (code) => reject(new Error(`dbus-daemon exited (${code})`)));
  });
  t.after(async () => {
    daemon.kill();
    await rm(root, { recursive: true, force: true });
  });
  return { address, addresses: parseBusAddresses(address), env: { ...env, DBUS_SESSION_BUS_ADDRESS: address }, root };
}

function waitFor<T>(read: () => T | null | undefined, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = read();
      if (value !== null && value !== undefined) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test("the service owns FileManager1 and answers gdbus's ShowItems, ShowFolders and Introspect", { skip: !dbusDaemonAvailable || !gdbusAvailable }, async (t) => {
  const bus = await privateBus(t);
  const requests: FileManagerRequest[] = [];
  const service = new FileManagerService({ onRequest: (request) => requests.push(request), bus: { addresses: bus.addresses } });
  t.after(() => service.stop());
  assert.deepEqual(await service.start(), { kind: "owner" });

  const call = (method: string, ...args: string[]) => run("gdbus", ["call", "--address", bus.address, "--dest", fileManagerBusName, "--object-path", fileManagerObjectPath, "--method", `org.freedesktop.FileManager1.${method}`, ...args]);
  assert.equal((await call("ShowItems", "['file:///tmp/a%20b/c.txt', 'https://example.invalid/x', 'file:///tmp/a%20b/c.txt']", "startup-7")).stdout.trim(), "()");
  await call("ShowFolders", "['file:///home/somebody/Downloads/']", "");
  await waitFor(() => requests.length === 2 ? true : null);
  assert.deepEqual(requests, [
    { method: "ShowItems", paths: ["/tmp/a b/c.txt"], startupId: "startup-7" },
    { method: "ShowFolders", paths: ["/home/somebody/Downloads"], startupId: null },
  ]);

  // Nothing usable: answered, nothing opened.
  await call("ShowItemProperties", "['relative/path', 'file://otherhost/x']", "");
  const introspection = (await run("gdbus", ["introspect", "--address", bus.address, "--dest", fileManagerBusName, "--object-path", fileManagerObjectPath])).stdout;
  assert.match(introspection, /ShowItemProperties/);
  assert.match((await run("gdbus", ["introspect", "--address", bus.address, "--dest", fileManagerBusName, "--object-path", "/org/freedesktop"])).stdout, /node FileManager1/);
  await assert.rejects(call("Unknown", "['file:///tmp']", ""), /UnknownMethod/);
  // gdbus checks argument types against the introspection itself, so a wrong one is sent directly.
  const caller = await SessionBusConnection.open({ addresses: bus.addresses });
  t.after(() => caller.close());
  await assert.rejects(caller.call({ destination: fileManagerBusName, path: fileManagerObjectPath, interface: "org.freedesktop.FileManager1", member: "ShowItems", signature: "ss", body: ["file:///tmp", ""] }), /takes \(as URIs/);
  await assert.rejects(caller.call({ destination: fileManagerBusName, path: "/elsewhere", interface: "org.freedesktop.FileManager1", member: "ShowItems", signature: "", body: [] }), /No object/);
  assert.equal((await caller.call({ destination: fileManagerBusName, path: "/", interface: "org.freedesktop.DBus.Peer", member: "Ping" })).body.length, 0);
  assert.equal(requests.length, 2);
});

test("a second owner waits in line, names who answers now, and takes over when the first lets go", { skip: !dbusDaemonAvailable }, async (t) => {
  const bus = await privateBus(t);
  const first = new FileManagerService({ onRequest: () => {}, bus: { addresses: bus.addresses } });
  const states: FileManagerServiceState[] = [];
  const second = new FileManagerService({
    onRequest: () => {},
    bus: { addresses: bus.addresses },
    onStateChange: (state) => states.push(state),
    processName: async (pid) => pid === process.pid ? "first-manager" : null,
  });
  t.after(async () => { await first.stop(); await second.stop(); });
  assert.equal((await first.start()).kind, "owner");
  assert.deepEqual(await second.start(), { kind: "queued", currentOwner: "first-manager" });
  await first.stop();
  await waitFor(() => second.current().kind === "owner" ? true : null);
  assert.equal(states.at(-1)?.kind, "owner");
});

test("too many requests in a short time are answered and ignored", { skip: !dbusDaemonAvailable }, async (t) => {
  const bus = await privateBus(t);
  const requests: FileManagerRequest[] = [];
  const service = new FileManagerService({ onRequest: (request) => requests.push(request), bus: { addresses: bus.addresses }, maxRequestsPerWindow: 2, now: () => 1_000 });
  t.after(() => service.stop());
  await service.start();
  const caller = await SessionBusConnection.open({ addresses: bus.addresses });
  t.after(() => caller.close());
  for (let index = 0; index < 4; index += 1) {
    await caller.call({ destination: fileManagerBusName, path: fileManagerObjectPath, interface: "org.freedesktop.FileManager1", member: "ShowItems", signature: "ass", body: [[`file:///tmp/${index}`], ""] });
  }
  assert.deepEqual(requests.map((request) => request.paths[0]), ["/tmp/0", "/tmp/1"]);
});

test("without a bus the service is off with a plain reason", async () => {
  const service = new FileManagerService({ onRequest: () => {}, bus: { addresses: [{ kind: "path", path: join(tmpdir(), "amplefile-no-such-bus") }] } });
  const state = await service.start();
  assert.equal(state.kind, "unavailable");
  assert.match(state.kind === "unavailable" ? state.reason : "", /can't reach the desktop's session bus/);
  await service.stop();
  const none = new FileManagerService({ onRequest: () => {}, bus: { env: {} } });
  const noneState = await none.start();
  assert.match(noneState.kind === "unavailable" ? noneState.reason : "", /No session bus/);
});

test("the written service file makes the bus start this AmpleFile instead of the system file manager", { skip: !dbusDaemonAvailable || !gdbusAvailable }, async (t) => {
  let markerScript = "";
  const bus = await privateBus(t, async (root) => {
    // A launcher path with a space, as an AppImage in "My Apps" would have.
    markerScript = join(root, "My Apps", "amplefile-desktop");
    await mkdir(join(root, "My Apps"), { recursive: true });
    await writeFile(markerScript, `#!/bin/sh\necho "amplefile $*" >> "${join(root, "marks")}"\nexit 1\n`);
    await chmod(markerScript, 0o755);
    const system = join(root, "system-data", "dbus-1", "services");
    await mkdir(system, { recursive: true });
    const systemScript = join(root, "nautilus");
    await writeFile(systemScript, `#!/bin/sh\necho system >> "${join(root, "marks")}"\nexit 1\n`);
    await chmod(systemScript, 0o755);
    // A different file name, as KDE's org.kde.dolphin.FileManager1.service has.
    await writeFile(join(system, "org.kde.dolphin.FileManager1.service"), `[D-BUS Service]\nName=${fileManagerBusName}\nExec=${systemScript} --daemon\n`);
  });
  const environment = { env: bus.env, home: join(bus.root, "home"), launchCommand: [markerScript, "/app path"] };
  const activate = () => run("gdbus", ["call", "--address", bus.address, "--timeout", "5", "--dest", fileManagerBusName, "--object-path", fileManagerObjectPath, "--method", "org.freedesktop.FileManager1.ShowItems", "['file:///tmp']", ""]).catch((error: unknown) => error);
  const reload = () => run("gdbus", ["call", "--address", bus.address, "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.ReloadConfig"]);

  await activate();
  assert.match(await readFile(join(bus.root, "marks"), "utf8"), /^system$/m);
  await rm(join(bus.root, "marks"));
  await writeFileManagerServiceFile(environment);
  await reload();
  await activate();
  const marks = await readFile(join(bus.root, "marks"), "utf8");
  assert.match(marks, /^amplefile \/app path$/m);
  assert.doesNotMatch(marks, /system/);
});
