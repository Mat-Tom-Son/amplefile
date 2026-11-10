import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import feedModule from "./mac-release-feed.cjs";

const { parseRepository, resolveMacReleaseFeed } = feedModule;

/**
 * Read a public feed the way an installed copy does: anonymously, through
 * github.com rather than the API, in the order electron-updater's GitHub
 * provider uses when prereleases are not allowed.
 *
 * 1. `releases.atom` must list at least one entry. It lists tags as well as
 *    releases, so this only fails for a repository with neither.
 * 2. `releases/latest`, asked for JSON, names the release GitHub marks
 *    latest. A repository whose releases are all prereleases or drafts has
 *    none, and the updater reports that no version is published.
 * 3. `latest-mac.yml` is downloaded from that release. A latest release
 *    without it (one that is not a Mac release) is an update-check error.
 */
export async function readPublicUpdateFeed({ feed, fetch = globalThis.fetch }) {
  const base = `https://github.com/${feed.owner}/${feed.repo}/releases`;
  const atom = await request(fetch, `${base}.atom`, "application/xml, application/atom+xml, text/xml, */*");
  if (!/<entry[\s>]/.test(atom)) throw new Error(`${feed.slug} has no releases or tags: an installed copy reports that no version is published.`);

  let tag;
  try {
    tag = JSON.parse(await request(fetch, `${base}/latest`, "application/json")).tag_name;
  } catch {
    tag = undefined;
  }
  if (typeof tag !== "string" || !tag) {
    throw new Error(
      `${feed.slug} has no latest release (prereleases and drafts do not count): an installed copy reports that no version is published.`,
    );
  }

  let metadata;
  try {
    metadata = await request(fetch, `${base}/download/${tag}/latest-mac.yml`, "*/*");
  } catch (error) {
    throw new Error(`${feed.slug} serves ${tag} as its latest release, and it has no latest-mac.yml: an installed copy fails its update check. ${error.message}`);
  }
  const version = scalar(metadata, "version");
  const path = scalar(metadata, "path");
  if (!version || !path) throw new Error(`latest-mac.yml in ${feed.slug} ${tag} names no version or update archive.`);
  return { feed: feed.slug, tag, version, path, downloadUrl: `${base}/download/${tag}/${path.replace(/ /g, "-")}` };
}

async function request(fetch, url, accept) {
  const response = await fetch(url, { headers: { Accept: accept }, redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.text();
}

function scalar(source, key) {
  const match = source.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.replace(/^['"]|['"]$/g, "") ?? "";
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const filename of [".env", ".env.macos.local"]) {
    const path = join(rootDir, filename);
    if (existsSync(path)) loadEnvFile(path);
  }
  const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
  const feed = argument("--feed") ? parseRepository(argument("--feed")) : resolveMacReleaseFeed(identity).packaged;
  const expectedVersion = argument("--version");
  try {
    const served = await readPublicUpdateFeed({ feed });
    if (expectedVersion && served.version !== expectedVersion) {
      throw new Error(`${served.feed} offers ${served.version} (${served.tag}); expected ${expectedVersion}.`);
    }
    console.log(`${served.feed} offers ${identity.productName} ${served.version} from ${served.tag}.`);
    console.log(`Update archive: ${served.downloadUrl}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : String(process.argv[index + 1] ?? "").trim();
}
