import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { IpcMainInvokeEvent } from "electron";

import { registerCommandLineIpc } from "../desktop/src/command-line-host.js";
import type { CommandLineEnvironment } from "../desktop/src/command-line-install.js";
import type { DesktopIpcMain } from "../desktop/src/desktop-ipc-main.js";
import { outsideAgentSkill } from "../src/shared/outside-agent-skill.js";

/**
 * Settings → Command Line's IPC group, registered by desktop/src/command-line-host.ts
 * with its dependencies passed in: what a renderer that asks gets, and what one
 * the sender check refuses gets.
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function host(t: test.TestContext, home: string, trusted: (event: IpcMainInvokeEvent) => boolean = () => true) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      assert.ok(!handlers.has(channel), `${channel} is registered once`);
      handlers.set(channel, handler);
    },
    on: () => { throw new Error("The Command Line group sends no messages."); },
  } as unknown as DesktopIpcMain;
  const checked: IpcMainInvokeEvent[] = [];
  const environment: CommandLineEnvironment = {
    platform: "linux",
    isPackaged: true,
    executablePath: join(home, "app", "amplefile"),
    home,
    pathsDirectory: join(home, "paths.d"),
    runAsAdministrator: async () => { throw new Error("Not asked for on Linux."); },
  };
  registerCommandLineIpc({
    ipcMain,
    assertTrusted: (event) => {
      checked.push(event);
      if (!trusted(event)) throw new Error("This request requires the main AmpleFile renderer.");
    },
    isPackaged: true,
    environment: () => environment,
  });
  const ask = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} has a handler`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, checked, ask };
}

async function temporaryHome(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "command-line-host-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("the Command Line group answers each of its channels, and only them", async (t) => {
  const { handlers } = host(t, await temporaryHome(t));
  assert.deepEqual([...handlers.keys()].sort(), [
    "amplefile:command-line:install-path",
    "amplefile:command-line:install-skill",
    "amplefile:command-line:remove-path",
    "amplefile:command-line:remove-skill",
    "amplefile:command-line:skill",
    "amplefile:command-line:status",
  ]);
});

test("a renderer the sender check refuses gets nothing from any Command Line channel, and nothing changes", async (t) => {
  const home = await temporaryHome(t);
  const { handlers, checked, ask } = host(t, home, () => false);
  for (const channel of handlers.keys()) {
    await assert.rejects(Promise.resolve().then(() => ask(channel, "claude")), /main AmpleFile renderer/, channel);
  }
  assert.equal(checked.length, handlers.size, "every handler starts with the sender check");
  await assert.rejects(readFile(join(home, ".claude", "skills"), "utf8"), { code: "ENOENT" });
});

test("Settings → Command Line reads the status, installs and removes a skill, and shows the skill's text", async (t) => {
  const home = await temporaryHome(t);
  const { ask } = host(t, home);
  const before = await ask("amplefile:command-line:status") as Awaited<ReturnType<typeof import("../desktop/src/command-line-install.js").commandLineStatus>>;
  assert.equal(before.skills.claude.installed, "none");
  assert.equal(before.path.supported, false, "a Linux package adds the command itself");

  const installed = await ask("amplefile:command-line:install-skill", "claude") as typeof before;
  assert.equal(installed.skills.claude.installed, "current");
  assert.equal(await readFile(installed.skills.claude.path, "utf8"), outsideAgentSkill());
  assert.equal(installed.skills.codex.installed, "none");

  const removed = await ask("amplefile:command-line:remove-skill", "claude") as typeof before;
  assert.equal(removed.skills.claude.installed, "none");

  assert.equal(await ask("amplefile:command-line:skill"), outsideAgentSkill());
});

test("a skill target other than Claude Code or Codex is refused before anything is written", async (t) => {
  const home = await temporaryHome(t);
  const { ask } = host(t, home);
  for (const target of ["cursor", "", undefined, { target: "claude" }, "../claude"]) {
    await assert.rejects(Promise.resolve().then(() => ask("amplefile:command-line:install-skill", target)), /Choose Claude Code or Codex/);
    await assert.rejects(Promise.resolve().then(() => ask("amplefile:command-line:remove-skill", target)), /Choose Claude Code or Codex/);
  }
  await assert.rejects(readFile(join(home, ".claude"), "utf8"), { code: "ENOENT" });
});
