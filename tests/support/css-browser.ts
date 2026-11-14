import { access, constants } from "node:fs/promises";

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
