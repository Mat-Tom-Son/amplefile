import assert from "node:assert/strict";
import test from "node:test";
import { configureLinuxPasswordStore } from "../desktop/src/linux-password-store.js";

function selected(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux", explicit?: string) {
  const switches = new Map<string, string>(explicit === undefined ? [] : [["password-store", explicit]]);
  configureLinuxPasswordStore({ hasSwitch: name => switches.has(name), appendSwitch: (name, value) => { switches.set(name, value); } }, platform, env);
  return switches.get("password-store");
}

test("niri and other non-KDE sessions select the real Secret Service backend", () => {
  for (const desktop of ["niri", "sway", "Hyprland", "GNOME", "ubuntu:GNOME", "XFCE", "", "future-desktop"]) {
    assert.equal(selected({ XDG_CURRENT_DESKTOP: desktop }), "gnome-libsecret", desktop);
  }
});
test("KDE and Plasma keep Chromium's native KWallet selection", () => {
  for (const env of [{ XDG_CURRENT_DESKTOP: "KDE" }, { XDG_CURRENT_DESKTOP: "KDE6" }, { XDG_CURRENT_DESKTOP: "KDE:Plasma" }, { DESKTOP_SESSION: "/usr/share/wayland-sessions/plasma" }, { KDE_FULL_SESSION: "true" }, { KDE_SESSION_VERSION: "6" }]) {
    assert.equal(selected(env), undefined);
  }
});
test("an explicit password-store choice is preserved", () => {
  for (const store of ["gnome-libsecret", "kwallet6", "basic", ""]) assert.equal(selected({ XDG_CURRENT_DESKTOP: "niri" }, "linux", store), store);
});
test("Mac and Windows startup is unchanged", () => {
  for (const platform of ["darwin", "win32"] as const) assert.equal(selected({}, platform), undefined);
});
