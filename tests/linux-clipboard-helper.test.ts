import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  clipboardAccessFromResults,
  decodeClipboardResults,
  encodeClipboardRequest,
  linuxClipboardHelperUsable,
  LinuxClipboardOwner,
  linuxFileClipboardOffers,
  linuxFileClipboardReadTargets,
  verifiedClipboardHelper,
} from "../desktop/src/linux-clipboard-helper.js";
import { readLinuxClipboardFiles } from "../desktop/src/linux-file-clipboard.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const builtHelper = join(root, "out/included-tools/clipboard-helper/amplefile-clipboard");

const awkward = ["/tmp/My Files/report final.pdf", "/tmp/Café/naïve 日本語.txt", "/tmp/#1 50% done?.md", "/tmp/two\nlines.txt"];

test("a copy offers GNOME's list, the URI list and the paths as text", () => {
  const offers = linuxFileClipboardOffers(["/tmp/a b", "/tmp/#c%"]);
  assert.deepEqual(offers.map((offer) => offer.target), [
    "x-special/gnome-copied-files", "text/uri-list", "text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "TEXT", "STRING",
  ]);
  const byTarget = new Map(offers.map((offer) => [offer.target, offer.data.toString("utf8")]));
  assert.equal(byTarget.get("x-special/gnome-copied-files"), "copy\nfile:///tmp/a%20b\nfile:///tmp/%23c%25");
  assert.equal(byTarget.get("text/uri-list"), "file:///tmp/a%20b\r\nfile:///tmp/%23c%25\r\n");
  for (const target of ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "TEXT", "STRING"]) assert.equal(byTarget.get(target), "/tmp/a b\n/tmp/#c%");
  assert.ok(!offers.some((offer) => offer.target === "application/x-kde-cutselection"), "AmpleFile's Copy never says cut");
});

test("STRING is Latin-1, and left out when a name is not", () => {
  const latin = linuxFileClipboardOffers(["/tmp/Café"]).find((offer) => offer.target === "STRING");
  assert.deepEqual(latin?.data, Buffer.from([...Buffer.from("/tmp/Caf", "latin1"), 0xe9]));
  assert.equal(linuxFileClipboardOffers(["/tmp/日本語"]).find((offer) => offer.target === "STRING"), undefined);
  assert.equal(linuxFileClipboardOffers(["/tmp/日本語"]).find((offer) => offer.target === "UTF8_STRING")?.data.toString("utf8"), "/tmp/日本語");
  assert.throws(() => linuxFileClipboardOffers([]));
  assert.throws(() => linuxFileClipboardOffers(["relative"]));
});

test("requests and results use the helper's frames", () => {
  const request = encodeClipboardRequest([{ target: "TEXT", data: Buffer.from("é") }]);
  assert.deepEqual(request, Buffer.concat([
    Buffer.from("AFCLIP1\n"), Buffer.from([4, 0, 0, 0]), Buffer.from("TEXT"), Buffer.from([2, 0, 0, 0]), Buffer.from("é"), Buffer.from([0, 0, 0, 0]),
  ]));
  assert.throws(() => encodeClipboardRequest([{ target: "bad\nname", data: Buffer.alloc(0) }]));
  assert.throws(() => encodeClipboardRequest([{ target: "", data: Buffer.alloc(0) }]));
  const results = decodeClipboardResults(Buffer.concat([
    Buffer.from("AFCLIP1\n"), Buffer.from([1, 0, 0, 0]), Buffer.from("a"), Buffer.from([1, 0, 0, 0]), Buffer.from("x"),
    Buffer.from([1, 0, 0, 0]), Buffer.from("b"), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from([0, 0, 0, 0]),
  ]));
  assert.deepEqual([...results], [["a", Buffer.from("x")], ["b", null]]);
  assert.throws(() => decodeClipboardResults(Buffer.from("AFCLIP1\n\x05\0\0\0ab")));
  assert.throws(() => decodeClipboardResults(Buffer.from("nope")));
});

test("the helper serves only an X11 Chromium with a display", () => {
  assert.equal(linuxClipboardHelperUsable({ ozonePlatform: "x11", display: ":0" }), true);
  assert.equal(linuxClipboardHelperUsable({ ozonePlatform: "wayland", display: ":0" }), false);
  assert.equal(linuxClipboardHelperUsable({ ozonePlatform: "", display: ":0" }), false);
  assert.equal(linuxClipboardHelperUsable({ ozonePlatform: "x11", display: " " }), false);
  assert.equal(linuxClipboardHelperUsable({ ozonePlatform: "x11", display: undefined }), false);
});

test("helper results read like Electron's clipboard", () => {
  const access = clipboardAccessFromResults(new Map([["text/uri-list", Buffer.from("file:///tmp/a%20b\r\n")], ["x-special/gnome-copied-files", null]]));
  assert.deepEqual(readLinuxClipboardFiles(access), { operation: null, paths: ["/tmp/a b"] });
  assert.deepEqual([...linuxFileClipboardReadTargets], ["x-special/gnome-copied-files", "text/uri-list", "application/x-kde-cutselection"]);
});

function encodeResults(entries: Array<[string, string | null]>): Buffer {
  const parts = [Buffer.from("AFCLIP1\n")];
  for (const [name, value] of entries) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(value === null ? 0xffff_ffff : Buffer.byteLength(value));
    const nameLength = Buffer.alloc(4);
    nameLength.writeUInt32LE(name.length);
    parts.push(nameLength, Buffer.from(name), length, Buffer.from(value ?? ""));
  }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts);
}

test("a paste reads files through the helper, then marked text, and reports a failed read", async () => {
  const answer = (results: Record<string, string | null>, code = 0) => fakeSpawner((child, args) => {
    child.stdout.once("end", () => {
      child.exitCode = code;
      child.emit("close", code);
    });
    child.stdout.end(encodeResults(args.slice(1).map((target) => [target, results[target] ?? null])));
  });
  const reading = (spawnFake: ReturnType<typeof fakeSpawner>["spawn"]) => new LinuxClipboardOwner({ helperPath: "/helper", spawn: spawnFake }).readFiles();
  assert.deepEqual(await reading(answer({ "x-special/gnome-copied-files": "cut\nfile:///tmp/a", "text/uri-list": "file:///tmp/b\r\n" }).spawn), { operation: "cut", paths: ["/tmp/a"] });
  const marked = answer({ UTF8_STRING: "x-special/nautilus-clipboard\ncopy\nfile:///tmp/old\n" });
  assert.deepEqual(await reading(marked.spawn), { operation: "copy", paths: ["/tmp/old"] });
  assert.equal(marked.children.length, 2, "text is asked for only after the file formats held nothing");
  assert.deepEqual(await reading(answer({ UTF8_STRING: "/tmp/just text" }).spawn), { operation: null, paths: [] });
  assert.equal(await reading(answer({}, 3).spawn), null, "a helper that fails leaves the read to Electron");
});

test("the helper is used only when it matches its source record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "amplefile-clipboard-helper-"));
  try {
    const helper = join(directory, "amplefile-clipboard");
    await writeFile(helper, "binary");
    await chmod(helper, 0o755);
    const record = { schema: "amplefile.clipboard-helper-source.v1", protocolVersion: 1, target: "x86_64-unknown-linux-gnu", binarySha256: createHash("sha256").update("binary").digest("hex") };
    await writeFile(join(directory, "source.json"), JSON.stringify(record));
    assert.equal(await verifiedClipboardHelper(helper), true);
    await writeFile(helper, "changed");
    assert.equal(await verifiedClipboardHelper(helper), false);
    await writeFile(helper, "binary");
    await chmod(helper, 0o644);
    assert.equal(await verifiedClipboardHelper(helper), false);
    assert.equal(await verifiedClipboardHelper(join(directory, "missing")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  received: Buffer[] = [];
  kills: string[] = [];
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.received.push(chunk));
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.kills.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function fakeSpawner(answer: (child: FakeChild, args: readonly string[]) => void) {
  const children: FakeChild[] = [];
  const spawnFake = (_command: string, args: readonly string[]) => {
    const child = new FakeChild();
    children.push(child);
    setImmediate(() => answer(child, args));
    return child as unknown as ChildProcess;
  };
  return { children, spawn: spawnFake };
}

test("the owner keeps the newest helper and stops the one it replaced", async () => {
  const { children, spawn: spawnFake } = fakeSpawner((child) => child.stdout.write("owned\n"));
  const owner = new LinuxClipboardOwner({ helperPath: "/helper", spawn: spawnFake, maxSeconds: 60 });
  assert.equal(await owner.offer(linuxFileClipboardOffers(["/tmp/a"])), true);
  assert.equal(children[0]?.stdin.writableEnded, false, "stdin stays open so the helper notices when the app is gone");
  assert.deepEqual(Buffer.concat(children[0]!.received), encodeClipboardRequest(linuxFileClipboardOffers(["/tmp/a"])));
  assert.equal(await owner.offer(linuxFileClipboardOffers(["/tmp/b"])), true);
  assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
  assert.deepEqual(children[1]?.kills, []);
  owner.release();
  assert.deepEqual(children[1]?.kills, ["SIGTERM"]);
});

test("copies are offered in order, so an older copy never lands over a newer one", async () => {
  const order: string[] = [];
  const { children, spawn: spawnFake } = fakeSpawner(() => {});
  const owner = new LinuxClipboardOwner({ helperPath: "/helper", spawn: spawnFake });
  const first = owner.offer(linuxFileClipboardOffers(["/tmp/first"])).then((owned) => order.push(`first ${owned}`));
  const second = owner.offer(linuxFileClipboardOffers(["/tmp/second"])).then((owned) => order.push(`second ${owned}`));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children.length, 1, "the second helper starts only after the first has answered");
  children[0]!.stdout.write("owned\n");
  await first;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children.length, 2);
  children[1]!.stdout.write("owned\n");
  await second;
  assert.deepEqual(order, ["first true", "second true"]);
  assert.deepEqual(children[0]?.kills, ["SIGTERM"]);
});

test("the owner reports a helper that cannot own the clipboard, so the caller falls back", async () => {
  const unavailable = fakeSpawner((child) => child.stdout.write("unavailable no X display\n"));
  const logs: string[] = [];
  const owner = new LinuxClipboardOwner({ helperPath: "/helper", spawn: unavailable.spawn, log: (message) => logs.push(message) });
  assert.equal(await owner.offer(linuxFileClipboardOffers(["/tmp/a"])), false);
  assert.match(logs[0] ?? "", /no X display/);
  const exited = fakeSpawner((child) => { child.exitCode = 1; child.emit("exit", 1, null); });
  assert.equal(await new LinuxClipboardOwner({ helperPath: "/helper", spawn: exited.spawn }).offer(linuxFileClipboardOffers(["/tmp/a"])), false);
  const silent = fakeSpawner(() => {});
  assert.equal(await new LinuxClipboardOwner({ helperPath: "/helper", spawn: silent.spawn, readyTimeoutMs: 20 }).offer(linuxFileClipboardOffers(["/tmp/a"])), false);
  assert.deepEqual(silent.children[0]?.kills, ["SIGTERM"]);
  const throwing = new LinuxClipboardOwner({ helperPath: "/helper", spawn: () => { throw new Error("ENOENT"); } });
  assert.equal(await throwing.offer(linuxFileClipboardOffers(["/tmp/a"])), false);
});

// The real helper on a private X server: every target, large selections, and each way it ends.
const xvfbAvailable = process.platform === "linux" && existsSync(builtHelper) && ["/usr/bin/Xvfb", "/usr/local/bin/Xvfb"].some((path) => existsSync(path));

async function withPrivateDisplay(run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const server = spawn("Xvfb", ["-displayfd", "3", "-nolisten", "tcp", "-screen", "0", "320x240x24"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  try {
    const display = await new Promise<string>((resolve, reject) => {
      let text = "";
      (server.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (text.includes("\n")) resolve(`:${text.trim()}`);
      });
      server.once("exit", () => reject(new Error("Xvfb exited")));
      setTimeout(() => reject(new Error("Xvfb did not start")), 10_000);
    });
    const env = { ...process.env, DISPLAY: display };
    delete env.WAYLAND_DISPLAY;
    await run(env);
  } finally {
    server.kill("SIGTERM");
  }
}

function envSpawner(env: NodeJS.ProcessEnv) {
  const children: ChildProcess[] = [];
  return {
    children,
    spawn: (command: string, args: readonly string[], options: { stdio: ["pipe", "pipe", "pipe"] }) => {
      const child = spawn(command, args, { ...options, env });
      if (args[0] === "serve") children.push(child);
      return child;
    },
  };
}

const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
  else child.once("exit", (code) => resolve(code));
});

test("the helper serves every target with the right bytes on a real X server", { skip: !xvfbAvailable && "needs the built helper and Xvfb" }, async () => {
  await withPrivateDisplay(async (env) => {
    const { children, spawn: spawnWithDisplay } = envSpawner(env);
    const owner = new LinuxClipboardOwner({ helperPath: builtHelper, spawn: spawnWithDisplay });
    const offers = linuxFileClipboardOffers(awkward);
    assert.equal(await owner.offer(offers), true);
    const targets = ["TARGETS", ...offers.map((offer) => offer.target), "application/x-kde-cutselection"];
    const results = await owner.read(targets);
    assert.ok(results);
    assert.deepEqual(results.get("TARGETS")?.toString("utf8").split("\n"), ["TARGETS", "TIMESTAMP", "MULTIPLE", ...offers.map((offer) => offer.target)]);
    for (const offer of offers) assert.deepEqual(results.get(offer.target), offer.data, offer.target);
    assert.equal(results.get("application/x-kde-cutselection"), null);
    assert.deepEqual(readLinuxClipboardFiles(clipboardAccessFromResults(results)), { operation: "copy", paths: awkward });
    assert.deepEqual(await owner.readFiles(), { operation: "copy", paths: awkward }, "a paste in AmpleFile recognises its own copy");

    // Thousands of files go through ICCCM's incremental transfer.
    const many = Array.from({ length: 5000 }, (_, index) => `/tmp/a folder with a long name/${index} café #${index} 50%.txt`);
    assert.equal(await owner.offer(linuxFileClipboardOffers(many)), true);
    assert.equal(await exited(children[0]!), 0, "the replaced helper leaves");
    const large = await owner.read(["x-special/gnome-copied-files", "text/uri-list"]);
    assert.ok((large?.get("text/uri-list")?.length ?? 0) > 256 * 1024);
    assert.deepEqual(readLinuxClipboardFiles(clipboardAccessFromResults(large!)).paths, many);
    assert.deepEqual((await owner.readFiles())?.paths, many);

    // Closing its input (the app quit or crashed) ends it; so does another owner and the time bound.
    children[1]!.stdin!.end();
    assert.equal(await exited(children[1]!), 0);
    assert.equal((await owner.read(["TARGETS"]))?.get("TARGETS"), null, "the clipboard has no owner once it left");
    const bounded = new LinuxClipboardOwner({ helperPath: builtHelper, spawn: spawnWithDisplay, maxSeconds: 1 });
    assert.equal(await bounded.offer(linuxFileClipboardOffers(["/tmp/a"])), true);
    assert.equal(await exited(children.at(-1)!), 0);
  });
});

test("the helper refuses bad requests and needs a display", { skip: !(process.platform === "linux" && existsSync(builtHelper)) && "needs the built helper" }, async () => {
  const env = { ...process.env, DISPLAY: ":987654" };
  const { spawn: spawnNoDisplay } = envSpawner(env);
  const logs: string[] = [];
  const owner = new LinuxClipboardOwner({ helperPath: builtHelper, spawn: spawnNoDisplay, log: (message) => logs.push(message) });
  assert.equal(await owner.offer(linuxFileClipboardOffers(["/tmp/a"])), false);
  assert.match(logs.join("\n"), /no X display/);
  const garbage = spawn(builtHelper, ["serve"], { env, stdio: ["pipe", "pipe", "pipe"] });
  garbage.stdin.end("not a request");
  assert.equal(await exited(garbage), 1);
  const usage = spawn(builtHelper, [], { env });
  assert.equal(await exited(usage), 64);
});

test("the packaged helper ships with its provenance and licenses", async () => {
  const builder = await readFile(join(root, "electron-builder.desktop.cjs"), "utf8");
  assert.match(builder, /from: "out\/included-tools\/clipboard-helper", to: "clipboard-helper"/);
  const build = await readFile(join(root, "scripts/build-linux-native-hosts.mjs"), "utf8");
  assert.match(build, /desktop\/native\/linux-clipboard\/Cargo\.toml/);
  assert.match(build, /amplefile\.clipboard-helper-source\.v1/);
  const verify = await readFile(join(root, "scripts/verify-linux-packages.mjs"), "utf8");
  assert.match(verify, /resources\/clipboard-helper\/amplefile-clipboard/);
  const main = await readFile(join(root, "desktop/src/main.ts"), "utf8");
  assert.match(main, /owner && await owner\.offer\(linuxFileClipboardOffers\(paths\)\)\) return;\n\s*writeLinuxClipboardFiles\(clipboard, paths\);/);
});
