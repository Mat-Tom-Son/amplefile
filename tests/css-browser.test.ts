import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { cssBrowserCandidates, dumpCssFixture, findCssBrowser } from "./support/css-browser.js";

// Each fake browser is a small shell script standing in for Chromium: it
// prints a page to standard output and then leaves the way a real one might.

async function scratchFolder(t: TestContext): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "amplefile-css-browser-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "fixture.html"), "<!doctype html><pre id=\"result\">pending</pre>");
  return folder;
}

async function fakeBrowser(folder: string, name: string, script: string): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

async function processGone(pid: number): Promise<boolean> {
  // A killed process may take a moment to be reaped after the runner settles.
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

const readPid = async (path: string) => Number((await readFile(path, "utf8")).trim());

test("a complete result resolves even when the browser then exits with an error", async (t) => {
  const folder = await scratchFolder(t);
  const browser = await fakeBrowser(folder, "watchdog", [
    `printf '<html><head></head><body><pre id="result">%s</pre></body></html>\\n' "$*"`,
    `echo "Teardown watchdog expired; recording dump and terminating." >&2`,
    "exit 2",
  ].join("\n"));
  const profile = join(folder, "profile");
  const fixture = join(folder, "fixture.html");
  const page = await dumpCssFixture(browser, fixture, { profile, virtualTimeBudgetMs: 2000, extraArgs: ["--force-prefers-reduced-motion"] });
  const args = /<pre id="result">([^<]*)<\/pre>/u.exec(page)?.[1];
  assert.ok(args, page);
  assert.match(args, /^--headless=new --disable-gpu /u);
  assert.ok(args.includes(" --virtual-time-budget=2000 --disable-features=HangWatcher --force-prefers-reduced-motion "), args);
  assert.ok(args.endsWith(` --user-data-dir=${profile} --dump-dom ${pathToFileURL(fixture).href}`), args);
});

test("the runner returns a result that still says pending, for the test to reject", async (t) => {
  const folder = await scratchFolder(t);
  const browser = await fakeBrowser(folder, "pending", `printf '<pre id="result">pending</pre>'`);
  const page = await dumpCssFixture(browser, join(folder, "fixture.html"), { profile: join(folder, "profile") });
  assert.equal(/<pre id="result">([^<]*)<\/pre>/u.exec(page)?.[1], "pending");
});

test("a browser still running after a complete result is asked to stop and has left when the runner resolves", async (t) => {
  const folder = await scratchFolder(t);
  const pidFile = join(folder, "browser.pid");
  const stoppedFile = join(folder, "stopped");
  const browser = await fakeBrowser(folder, "lingering", [
    `trap 'echo SIGTERM > "${stoppedFile}"; kill "$child" 2>/dev/null; exit 0' TERM`,
    `echo $$ > "${pidFile}"`,
    "sleep 60 >/dev/null 2>&1 &",
    "child=$!",
    `printf '<pre id="result">[1]</pre>'`,
    `wait "$child"`,
  ].join("\n"));
  const page = await dumpCssFixture(browser, join(folder, "fixture.html"), { profile: join(folder, "profile") });
  assert.match(page, /<pre id="result">\[1\]<\/pre>/u);
  assert.equal((await readFile(stoppedFile, "utf8")).trim(), "SIGTERM", "the browser was asked to stop, not killed after the grace period");
  assert.ok(await processGone(await readPid(pidFile)), "the browser has left");
});

test("a browser that ignores the request to stop is killed after the grace period", { timeout: 20_000 }, async (t) => {
  const folder = await scratchFolder(t);
  const pidFile = join(folder, "browser.pid");
  const browser = await fakeBrowser(folder, "stubborn", [
    "trap '' TERM",
    `echo $$ > "${pidFile}"`,
    `printf '<pre id="result">[1]</pre>'`,
    "exec sleep 60",
  ].join("\n"));
  const page = await dumpCssFixture(browser, join(folder, "fixture.html"), { profile: join(folder, "profile") });
  assert.match(page, /<pre id="result">\[1\]<\/pre>/u);
  assert.ok(await processGone(await readPid(pidFile)), "the browser has been killed");
});

test("a helper holding the output pipe after the browser exits does not hold up the result", { timeout: 20_000 }, async (t) => {
  const folder = await scratchFolder(t);
  const helperPidFile = join(folder, "helper.pid");
  t.after(async () => {
    try {
      process.kill(await readPid(helperPidFile));
    } catch {}
  });
  const browser = await fakeBrowser(folder, "helper", [
    `sleep 60 &`,
    `echo $! > "${helperPidFile}"`,
    `printf '<pre id="result">[1]</pre>'`,
    "exit 0",
  ].join("\n"));
  const page = await dumpCssFixture(browser, join(folder, "fixture.html"), { profile: join(folder, "profile") });
  assert.match(page, /<pre id="result">\[1\]<\/pre>/u);
});

test("a browser that ends without a complete result rejects with its exit code and what it said", async (t) => {
  const folder = await scratchFolder(t);
  const browser = await fakeBrowser(folder, "broken", [
    `printf '<html><body><pre id="result">pend'`,
    `echo "GPU process isn't usable. Goodbye." >&2`,
    "exit 3",
  ].join("\n"));
  await assert.rejects(
    dumpCssFixture(browser, join(folder, "fixture.html"), { profile: join(folder, "profile") }),
    (error: Error) => {
      assert.match(error.message, /^broken ended \(exit code 3\) before the fixture wrote its result\./u);
      assert.match(error.message, /GPU process isn't usable\. Goodbye\./u);
      return true;
    },
  );
});

test("a browser killed by a signal without a complete result rejects with the signal", async (t) => {
  const folder = await scratchFolder(t);
  const browser = await fakeBrowser(folder, "crashing", "kill -KILL $$");
  await assert.rejects(
    dumpCssFixture(browser, join(folder, "fixture.html"), { profile: join(folder, "profile") }),
    /^Error: crashing ended \(signal SIGKILL\) before the fixture wrote its result\.$/u,
  );
});

test("a browser that hangs past the timeout rejects and is stopped", async (t) => {
  const folder = await scratchFolder(t);
  const pidFile = join(folder, "browser.pid");
  const browser = await fakeBrowser(folder, "hanging", [
    `echo $$ > "${pidFile}"`,
    "exec sleep 60",
  ].join("\n"));
  // Whether the browser has said anything by the deadline is a race, so only
  // the exit test above checks the stderr tail.
  await assert.rejects(
    dumpCssFixture(browser, join(folder, "fixture.html"), { profile: join(folder, "profile"), timeoutMs: 300 }),
    /^Error: hanging did not return the fixture's result within 300 ms\./u,
  );
  assert.ok(await processGone(await readPid(pidFile)), "the hung browser has been stopped");
});

test("a browser that cannot start rejects at once", async (t) => {
  const folder = await scratchFolder(t);
  const started = Date.now();
  await assert.rejects(
    dumpCssFixture(join(folder, "missing-browser"), join(folder, "fixture.html"), { profile: join(folder, "profile") }),
    { code: "ENOENT" },
  );
  assert.ok(Date.now() - started < 4_000, "a missing browser is not given the 5 s grace period");
});

test("the browser comes from AMPLEFILE_CSS_BROWSER first, when it can run", async (t) => {
  const folder = await scratchFolder(t);
  const browser = await fakeBrowser(folder, "chosen", "exit 0");
  assert.equal(await findCssBrowser({ AMPLEFILE_CSS_BROWSER: `  ${browser}\n` }), browser);
  const notRunnable = join(folder, "not-runnable");
  await writeFile(notRunnable, "");
  assert.notEqual(await findCssBrowser({ AMPLEFILE_CSS_BROWSER: notRunnable }), notRunnable);
  const defaults = cssBrowserCandidates({});
  assert.deepEqual(cssBrowserCandidates({ AMPLEFILE_CSS_BROWSER: "  " }), defaults);
  assert.equal(defaults[0], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.deepEqual(cssBrowserCandidates({ AMPLEFILE_CSS_BROWSER: "/opt/chromium" }), ["/opt/chromium", ...defaults]);
});
