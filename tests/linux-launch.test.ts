import assert from "node:assert/strict";
import test from "node:test";
import {
  explicitOzonePlatform,
  linuxX11RelaunchArguments,
  openPathArguments,
  x11DisplayAvailable,
} from "../desktop/src/linux-launch.js";

const exe = "/opt/AmpleFile/amplefile-desktop";
const sockets = (...present: string[]) => (path: string) => present.includes(path);

test("an X display is available only when a local display has its socket", () => {
  assert.equal(x11DisplayAvailable(undefined, sockets()), false);
  assert.equal(x11DisplayAvailable("  ", sockets()), false);
  assert.equal(x11DisplayAvailable(":0", sockets("/tmp/.X11-unix/X0")), true);
  assert.equal(x11DisplayAvailable(":1.0", sockets("/tmp/.X11-unix/X1")), true);
  assert.equal(x11DisplayAvailable("unix:2", sockets("/tmp/.X11-unix/X2")), true);
  assert.equal(x11DisplayAvailable(":0", sockets("/tmp/.X11-unix/X1")), false, "a stale DISPLAY with no server");
  assert.equal(x11DisplayAvailable("remote-host:10.0", sockets()), true, "remote displays cannot be checked cheaply");
});

test("Linux launches restart under X11 only when Chromium chose otherwise and X is reachable", () => {
  const base = { platform: "linux" as const, display: ":0", argv: [exe], selectedOzonePlatform: "wayland", socketExists: sockets("/tmp/.X11-unix/X0") };
  assert.deepEqual(linuxX11RelaunchArguments(base), ["--ozone-platform=x11"]);
  assert.deepEqual(linuxX11RelaunchArguments({ ...base, argv: [exe, "file:///home/me/Quotes", "--enable-logging"] }),
    ["--ozone-platform=x11", "file:///home/me/Quotes", "--enable-logging"], "launch arguments are preserved");
  assert.equal(linuxX11RelaunchArguments({ ...base, selectedOzonePlatform: "x11" }), null, "already X11");
  assert.equal(linuxX11RelaunchArguments({ ...base, display: undefined }), null, "Wayland-only sessions stay native Wayland");
  assert.equal(linuxX11RelaunchArguments({ ...base, socketExists: sockets() }), null, "an unreachable X display is not chosen");
  assert.equal(linuxX11RelaunchArguments({ ...base, argv: [exe, "--ozone-platform=wayland"] }), null, "an explicit choice is respected");
  assert.equal(linuxX11RelaunchArguments({ ...base, argv: [exe, "--ozone-platform=x11"] }), null, "the restarted launch never loops");
  assert.equal(linuxX11RelaunchArguments({ ...base, platform: "darwin" }), null);
});

test("an Ozone switch after the argument terminator is not the person's choice", () => {
  assert.equal(explicitOzonePlatform([exe, "--", "--ozone-platform=wayland"]), false);
  assert.equal(explicitOzonePlatform([exe, "--ozone-platform", "wayland"]), true);
  assert.equal(explicitOzonePlatform(["--ozone-platform=x11"]), false, "argv[0] is the executable");
});

test("desktop launcher arguments yield absolute folder candidates", () => {
  const options = { defaultApp: false, workingDirectory: "/home/me" };
  assert.deepEqual(openPathArguments([exe], options), []);
  assert.deepEqual(openPathArguments([exe, "file:///home/me/Vendor%20Quotes"], options), ["/home/me/Vendor Quotes"]);
  assert.deepEqual(openPathArguments([exe, "file://localhost/srv/Shared/"], options), ["/srv/Shared/"]);
  assert.deepEqual(openPathArguments([exe, "/home/me/Projects/../Notes"], options), ["/home/me/Notes"]);
  assert.deepEqual(openPathArguments([exe, "Documents"], options), ["/home/me/Documents"], "relative to the launching directory");
  assert.deepEqual(openPathArguments([exe, "Documents"], { defaultApp: false }), [], "no directory, no relative paths");
  assert.deepEqual(openPathArguments([exe, "Documents"], { defaultApp: false, workingDirectory: "relative" }), []);
});

test("switches, other schemes, remote file URIs and CLI request ids are ignored", () => {
  const options = { defaultApp: false, workingDirectory: "/home/me" };
  assert.deepEqual(openPathArguments([exe, "--ozone-platform=x11", "--enable-features=Foo", "-v"], options), []);
  assert.deepEqual(openPathArguments([exe, "https://example.com/", "mailto:me@example.com", "x-scheme-handler:foo"], options), []);
  assert.deepEqual(openPathArguments([exe, "file://fileserver/share"], options), []);
  assert.deepEqual(openPathArguments([exe, "--amplefile-cli-request", "1234-abcd"], options), []);
  assert.deepEqual(openPathArguments([exe, "--amplefile-cli-request=1234-abcd"], options), []);
  assert.deepEqual(openPathArguments([exe, "/tmp/a\0b"], options), []);
  assert.deepEqual(openPathArguments([exe, "--", "--odd folder"], options), ["/home/me/--odd folder"], "after -- everything is positional");
  assert.deepEqual(openPathArguments([exe, "/a", "file:///a", "/a/"], options), ["/a", "/a/"], "duplicates collapse");
  assert.equal(openPathArguments([exe, ...Array.from({ length: 40 }, (_, index) => `/f${index}`)], options).length, 16, "bounded");
});

test("a development launch skips Electron's app path", () => {
  const electron = "/repo/node_modules/electron/dist/electron";
  assert.deepEqual(openPathArguments([electron, "--ozone-platform=x11", "/repo", "/home/me/Quotes"], { defaultApp: true, workingDirectory: "/repo" }), ["/home/me/Quotes"]);
  assert.deepEqual(openPathArguments([electron, "/repo", "--amplefile-cli-request", "id"], { defaultApp: true, workingDirectory: "/repo" }), []);
});
