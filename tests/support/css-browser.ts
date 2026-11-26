import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Where the real-CSS tests look for a Chromium to lay out actual markup:
 * `AMPLEFILE_CSS_BROWSER` first, then Google Chrome on a Mac, then the usual
 * Linux names for Chrome and Chromium.
 */
export function cssBrowserCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.AMPLEFILE_CSS_BROWSER?.trim(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/** The first runnable Chromium, or undefined when this machine has none and the test should skip. */
export async function findCssBrowser(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const candidate of cssBrowserCandidates(env)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export interface CssFixtureOptions {
  /** A disposable profile folder inside the test's own temporary folder. */
  profile: string;
  /** How much page time Chromium runs before it dumps the page. */
  virtualTimeBudgetMs?: number;
  /** Further switches, such as `--force-prefers-reduced-motion`. */
  extraArgs?: readonly string[];
  /** How long to wait for the fixture's result before failing. */
  timeoutMs?: number;
}

/** A complete `<pre id="result">…</pre>` element in the dumped page. */
const completeResult = /<pre id="result">[^<]*<\/pre>/u;

/** How long a stopped browser gets to exit before it is killed outright. */
const stopGraceMs = 5_000;

/**
 * Lays out a fixture page in a disposable headless Chromium and returns the
 * page it dumps, at least through the fixture's `<pre id="result">` element.
 * Each test reads and judges that element itself; a dump that still says
 * "pending" comes back as it is.
 *
 * The page is what is under test, not the browser's own shutdown. So the
 * runner resolves as soon as a complete result element has arrived, whatever
 * Chromium does next: it may exit with an error after a complete dump (a
 * teardown watchdog on a busy machine), or a helper process may hold the
 * output pipe open. Then it stops Chromium and waits a few seconds for it
 * and its helpers to leave, so the test can remove the profile folder. It
 * rejects only when Chromium ends without a complete result, fails to
 * start, or runs past the timeout.
 */
export function dumpCssFixture(browser: string, fixturePath: string, options: CssFixtureOptions): Promise<string> {
  const { profile, virtualTimeBudgetMs = 1000, extraArgs = [], timeoutMs = 35_000 } = options;
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "--use-mock-keychain",
    "--password-store=basic",
    `--virtual-time-budget=${virtualTimeBudgetMs}`,
    "--disable-features=HangWatcher",
    ...extraArgs,
    `--user-data-dir=${profile}`,
    "--dump-dom",
    pathToFileURL(fixturePath).href,
  ];
  const name = basename(browser);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"] });
    let page = "";
    let said = "";
    let settled = false;
    // "close" comes once the process has exited and every process holding its
    // output pipes, helpers included, has let go of them.
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    const running = () => child.exitCode === null && child.signalCode === null;
    const finish = (outcome: { page: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (running()) child.kill();
      let grace: NodeJS.Timeout | undefined;
      const graceOver = new Promise<void>((done) => {
        grace = setTimeout(done, stopGraceMs);
      });
      void Promise.race([closed, graceOver]).then(() => {
        clearTimeout(grace);
        child.stdout.destroy();
        child.stderr.destroy();
        if (running()) child.kill("SIGKILL");
        if ("page" in outcome) resolve(outcome.page);
        else reject(outcome.error);
      });
    };
    const timer = setTimeout(() => {
      finish({ error: new Error(`${name} did not return the fixture's result within ${timeoutMs} ms.${saidTail(said)}`) });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      page += chunk;
      if (completeResult.test(page)) finish({ page });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      said = (said + chunk).slice(-4_000);
    });
    // A browser that cannot start reports here, then closes without exiting.
    child.on("error", (error) => finish({ error }));
    // Output can still be in the pipe when the process exits; "close" comes after all of it is read.
    child.once("close", (code, signal) => {
      if (completeResult.test(page)) finish({ page });
      else finish({ error: new Error(`${name} ended (${signal ? `signal ${signal}` : `exit code ${code}`}) before the fixture wrote its result.${saidTail(said)}`) });
    });
  });
}

function saidTail(said: string): string {
  const tail = said.trim();
  return tail ? `\nIt said:\n${tail}` : "";
}
