import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { verifyReleaseSource } from "./release-source.mjs";
import { assertPublishableMacState } from "./mac-publication-state.mjs";
import { assertLocalReleaseVerification, assertVerifiedBuildOrder, withReleaseVerificationLock } from "./local-release-verification.mjs";
import feedModule from "./mac-release-feed.cjs";
import {
  assertCheckedInFeedStage,
  assertTaggedFeedStage,
  bridgePauseMessage,
  createGitHubReleases,
  publishMacRelease,
  releaseManifestFeedFailures,
} from "./mac-release-publication.mjs";

const { resolveMacReleaseFeed } = feedModule;

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadLocalReleaseEnvironment();
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const version = String(packageJson.version ?? "").trim();
const arch = stringValue(process.env.AMPLEFILE_DESKTOP_RELEASE_ARCH) || (process.arch === "x64" ? "x64" : "arm64");
// Where the packaged app looks for updates and where this release goes. They
// differ only for the bridge release, which is published to both feeds.
const feed = resolveMacReleaseFeed(identity);
const sourceRepo = feed.source.slug;
const teamId = stringValue(process.env.AMPLEFILE_MAC_TEAM_ID) || "464JD5K8DC";
const tag = `v${version}`;
const builderDir = join(rootDir, "out", "builder");
const stem = `${identity.productName}-${version}-mac-${arch}`;
const manifestName = `${identity.productName}-mac-release-manifest.json`;
const requiredAssets = [
  `${stem}.dmg`,
  `${stem}.dmg.blockmap`,
  `${stem}.zip`,
  `${stem}.zip.blockmap`,
  "latest-mac.yml",
  "SHA256SUMS-mac.txt",
  manifestName,
  `${identity.productName}-mac-release-manifest.txt`,
];

if (process.platform !== "darwin") throw new Error(`${identity.productName} macOS releases must be published from a Mac host.`);
if (!version) throw new Error("package.json does not declare a release version.");
if (process.env.AMPLEFILE_SOURCE_RELEASE_REPO && process.env.AMPLEFILE_SOURCE_RELEASE_REPO !== sourceRepo) {
  throw new Error(`Release evidence must come from the canonical source repository ${sourceRepo}.`);
}

await withReleaseVerificationLock(rootDir, "publication", async (lockToken) => {
  assertCheckedInFeedStage(feed);
  const sourceSha = assertSourceState();
  run("gh", ["auth", "status"], "GitHub CLI authentication is required");
  assertSourceTagPublished();
  assertTaggedFeedStage({
    feed,
    tag,
    taggedIdentity: JSON.parse(capture("git", ["show", `${tag}:src/shared/product-identity.json`], `Could not read the product identity at ${tag}`)),
  });
  const sourceEvidence = await verifyReleaseSource({ repo: sourceRepo, sha: sourceSha, tag });
  console.log(`[${identity.productName} macOS release] Exact source verified: ${JSON.stringify(sourceEvidence)}`);
  await assertBuildState(lockToken);

  for (const name of requiredAssets) {
    const path = join(builderDir, name);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
      throw new Error(`Missing ${identity.productName} release asset ${path}. Run npm run desktop:make:mac:release first.`);
    }
  }

  runNpmScript("desktop:verify:release:mac");
  const manifest = JSON.parse(readFileSync(join(builderDir, manifestName), "utf8"));
  if (manifest.version !== version || manifest.platform !== "darwin" || manifest.arch !== arch || manifest.unsignedSmokeBuild !== false) {
    throw new Error(`The ${identity.productName} macOS manifest is not a signed release for the current version and architecture.`);
  }
  const manifestFailures = releaseManifestFeedFailures(manifest, feed);
  if (manifestFailures.length) {
    throw new Error(`The ${identity.productName} manifest was not built for the ${feed.stage} stage. ${manifestFailures.join(" ")}`);
  }

  const { remaining, published } = await publishMacRelease({
    feed,
    version,
    productName: identity.productName,
    arch,
    teamId,
    assets: requiredAssets.map((name) => ({ name, path: join(builderDir, name) })),
    github: createGitHubReleases({
      manifestName,
      run: (args, { timeoutMs = 120_000 } = {}) => spawnSync("gh", args, { ...commandOptions(), timeout: timeoutMs }),
    }),
    replaceBridge: stringValue(process.env.AMPLEFILE_MAC_REPLACE_BRIDGE),
    beforePublic: async () => {
      if (assertSourceState() !== sourceSha) throw new Error("Release source changed during upload. The release remains a draft.");
      await verifyReleaseSource({ repo: sourceRepo, sha: sourceSha, tag, expectedTagObjectSha: sourceEvidence.tagObjectSha });
      await assertBuildState(lockToken);
    },
    afterSourcePublication: () => verifyReleaseSource({ repo: sourceRepo, sha: sourceSha, tag, expectedTagObjectSha: sourceEvidence.tagObjectSha }),
    log: (message) => console.log(`[${identity.productName} macOS release] ${message}`),
  });
  if (remaining) {
    console.log(`\n${bridgePauseMessage({ feed, version, productName: identity.productName, published, remaining })}`);
  }
});

function assertSourceState() {
  const status = run("git", ["status", "--short"], `Could not inspect the ${identity.productName} source worktree`);
  if (status) throw new Error("Working tree is dirty. Commit and push the exact release source before publishing.");
  run("git", ["fetch", "--quiet", "origin", "main"], "Could not refresh origin/main before publishing");
  const head = run("git", ["rev-parse", "HEAD"], "Could not read local HEAD");
  const remoteHead = run("git", ["rev-parse", "origin/main"], "Could not read origin/main");
  if (head !== remoteHead) throw new Error(`Local HEAD ${head} does not match origin/main ${remoteHead}. Push the release commit first.`);
  return head;
}

async function assertBuildState(lockToken) {
  const verification = await assertLocalReleaseVerification(rootDir, { lockToken });
  const state = await assertPublishableMacState(rootDir, {
    productName: identity.productName,
    version,
    arch,
    mode: "release",
    nodeVersion: process.version,
    signIdentity: stringValue(process.env.AMPLEFILE_MAC_SIGN_IDENTITY || process.env.CSC_NAME),
    teamId: stringValue(process.env.AMPLEFILE_MAC_TEAM_ID || process.env.APPLE_TEAM_ID),
    feedOwner: feed.packaged.owner,
    feedRepo: feed.packaged.repo,
    feedStage: feed.stage,
  }, requiredAssets);
  assertVerifiedBuildOrder(state, verification);
}

function assertSourceTagPublished() {
  run("git", ["fetch", "--quiet", "origin", "tag", tag], `Could not refresh source tag ${tag}`);
  const head = run("git", ["rev-parse", "HEAD"], "Could not read local HEAD");
  const taggedCommit = run("git", ["rev-parse", `${tag}^{commit}`], `Could not resolve source tag ${tag}`);
  if (taggedCommit !== head) {
    throw new Error(`Source tag ${tag} points to ${taggedCommit}, not the exact release commit ${head}.`);
  }

  const sourceInfo = JSON.parse(run(
    "gh",
    ["repo", "view", sourceRepo, "--json", "isPrivate,visibility,url"],
    `Source repository ${sourceRepo} was not found`,
  ));
  if (sourceInfo.isPrivate || sourceInfo.visibility !== "PUBLIC") {
    throw new Error(`${sourceRepo} must be public before its tagged Mac release can be published.`);
  }
  console.log(`[${identity.productName} macOS release] Source tag ${tag} and public repository are verified at ${head}.`);
}

function runNpmScript(name) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    run(process.execPath, [npmExecPath, "run", name], `${name} failed`, 15 * 60_000);
    return;
  }
  run("npm", ["run", name], `${name} failed`, 15 * 60_000);
}

function run(command, args, label, timeout = 120_000) {
  return capture(command, args, label, timeout, true);
}

/** Run a command and return its standard output; `echo` also prints it, as the release log expects. */
function capture(command, args, label, timeout = 120_000, echo = false) {
  const result = spawnSync(command, args, { ...commandOptions(), timeout });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(`${label}: ${compactText(result.error?.message || output || `exit code ${result.status ?? 1}`)}`);
  }
  if (echo && output) console.log(output);
  return String(result.stdout || "").trim();
}

function commandOptions() {
  return {
    cwd: rootDir,
    env: {
      ...process.env,
      AMPLEFILE_DESKTOP_RELEASE_PLATFORM: "darwin",
      AMPLEFILE_DESKTOP_RELEASE_ARCH: arch,
      AMPLEFILE_MAC_RELEASE_BUILD: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactText(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 1800);
}

function loadLocalReleaseEnvironment() {
  for (const filename of [".env", ".env.macos.local"]) {
    const path = join(rootDir, filename);
    if (existsSync(path)) loadEnvFile(path);
  }
}
