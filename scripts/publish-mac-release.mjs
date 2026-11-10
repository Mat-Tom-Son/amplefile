import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  assertFeedContinuity,
  planTargetPublication,
  releaseCreateArguments,
  releaseNotes,
  selectPublicationTargets,
} from "./mac-release-publication.mjs";

const { parseRepository, resolveMacReleaseFeed, sameRepository } = feedModule;

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
  const sourceEvidence = await verifyReleaseSource({ repo: sourceRepo, sha: sourceSha, tag });
  console.log(`[${identity.productName} macOS release] Exact source verified: ${JSON.stringify(sourceEvidence)}`);
  await assertBuildState(lockToken);
  for (const target of feed.targets) assertPublicFeed(target);

  const plans = feed.targets.map((target) => ({
    target,
    action: planTargetPublication({ target, tag, existing: readExistingRelease(target), publishesToSeveral: feed.targets.length > 1 }),
  }));

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
  if (!sameRepository(manifest.feed, feed.packaged)) {
    throw new Error(`The ${identity.productName} manifest feed does not match ${feed.packaged.slug}.`);
  }
  if (manifest.feedStage !== feed.stage || JSON.stringify((manifest.publishTargets ?? []).map(slugOf)) !== JSON.stringify(feed.targets.map(slugOf))) {
    throw new Error(`The ${identity.productName} manifest was built for a different Mac update feed stage than ${feed.stage}.`);
  }

  // A publication to both feeds can stop between them. A feed that already
  // serves these exact bytes is done; everything else is refused above.
  const alreadyPublished = plans.filter((plan) => plan.action === "verify-published").map((plan) => plan.target);
  for (const target of alreadyPublished) {
    verifyRemoteRelease(target, false);
    console.log(`[${identity.productName} macOS release] ${target.slug} already serves ${tag} with identical assets.`);
  }
  const publishOnly = stringValue(process.env.AMPLEFILE_MAC_PUBLISH_ONLY);
  const pending = selectPublicationTargets({ feed, plans, only: publishOnly ? parseRepository(publishOnly) : null });
  if (!pending.length) {
    throw new Error(`${tag} is already published to ${(publishOnly ? [publishOnly] : feed.targets.map(slugOf)).join(" and ")}.`);
  }

  assertFeedContinuity({
    feed,
    version,
    latest: { separate: readLatestRelease(feed.separate), source: readLatestRelease(feed.source) },
    replaceBridge: stringValue(process.env.AMPLEFILE_MAC_REPLACE_BRIDGE),
    alreadyPublished,
  });

  // Every draft is uploaded and verified before anything becomes public.
  for (const target of pending) {
    console.log(`[${identity.productName} macOS release] Uploading ${tag} to ${target.slug} as a draft.`);
    run(
      "gh",
      releaseCreateArguments({
        target,
        source: feed.source,
        tag,
        title: `${identity.productName} ${version} for macOS`,
        notes: releaseNotes({ feed, target, productName: identity.productName, version, arch, teamId }),
        assetPaths: requiredAssets.map((name) => join(builderDir, name)),
      }),
      `Could not create draft ${identity.productName} macOS release ${tag} in ${target.slug}`,
      45 * 60_000,
    );
    verifyRemoteRelease(target, true);
  }

  // Uploads take time. Recheck authority and bytes at the public effect boundary.
  if (assertSourceState() !== sourceSha) throw new Error("Release source changed during upload. The release remains a draft.");
  await verifyReleaseSource({ repo: sourceRepo, sha: sourceSha, tag, expectedTagObjectSha: sourceEvidence.tagObjectSha });
  await assertBuildState(lockToken);
  for (const target of pending) {
    run("gh", ["release", "edit", tag, "--repo", target.slug, "--draft=false", "--latest"], `Could not publish ${identity.productName} macOS release ${tag} in ${target.slug}`);
    const release = verifyRemoteRelease(target, false);
    assertServedAsLatest(target);
    if (sameRepository(target, feed.source)) {
      // The release attached to the annotated source tag; it must not have replaced it.
      await verifyReleaseSource({ repo: sourceRepo, sha: sourceSha, tag, expectedTagObjectSha: sourceEvidence.tagObjectSha });
    }
    console.log(`[${identity.productName} macOS release] Published ${release.url}`);
  }
  const remaining = plans.filter((plan) => plan.action === "publish" && !pending.includes(plan.target)).map((plan) => plan.target.slug);
  if (remaining.length) {
    console.log(`[${identity.productName} macOS release] Not yet published to ${remaining.join(", ")}. Run the publisher again without AMPLEFILE_MAC_PUBLISH_ONLY to finish.`);
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

function assertPublicFeed(target) {
  const info = JSON.parse(capture("gh", ["repo", "view", target.slug, "--json", "isPrivate,visibility,url"], `Mac release feed ${target.slug} was not found`));
  if (info.isPrivate || info.visibility !== "PUBLIC") {
    throw new Error(`${target.slug} must be public so installed ${identity.productName} apps can update without a GitHub token.`);
  }
}

/** The release already published or drafted under this tag, or null. A bare tag is not a release. */
function readExistingRelease(target) {
  const result = spawnSync("gh", ["release", "view", tag, "--repo", target.slug, "--json", "tagName,isDraft,url"], commandOptions());
  return result.status === 0 ? JSON.parse(result.stdout) : null;
}

/** What the repository serves as its latest release, and the feed that release's packaged app checks. */
function readLatestRelease(repository) {
  const result = spawnSync("gh", ["api", `repos/${repository.slug}/releases/latest`], commandOptions());
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/HTTP 404/.test(output)) return null;
    throw new Error(`Could not read the latest release in ${repository.slug}: ${compactText(result.error?.message || output)}`);
  }
  const release = JSON.parse(result.stdout);
  if (!(release.assets ?? []).some((asset) => asset.name === manifestName)) return { tag: release.tag_name, feed: null };
  const manifest = JSON.parse(capture(
    "gh",
    ["release", "download", release.tag_name, "--repo", repository.slug, "--pattern", manifestName, "--output", "-"],
    `Could not read the release manifest of ${release.tag_name} in ${repository.slug}`,
  ));
  const owner = stringValue(manifest.feed?.owner);
  const repo = stringValue(manifest.feed?.repo);
  return { tag: release.tag_name, feed: owner && repo ? { owner, repo } : null };
}

/** Installed copies are offered the release GitHub marks latest, so it must be this one. */
function assertServedAsLatest(target) {
  const latest = capture("gh", ["api", `repos/${target.slug}/releases/latest`, "--jq", ".tag_name"], `Could not read the latest release in ${target.slug}`);
  if (latest !== tag) {
    throw new Error(`${target.slug} serves ${latest || "no release"} as its latest release, not ${tag}. Installed copies will not be offered ${tag} until it is marked latest.`);
  }
}

function verifyRemoteRelease(target, expectDraft) {
  const release = JSON.parse(capture(
    "gh",
    ["release", "view", tag, "--repo", target.slug, "--json", "tagName,isDraft,isPrerelease,assets,url"],
    `Could not verify ${identity.productName} macOS release ${tag} in ${target.slug}`,
  ));
  if (release.tagName !== tag || release.isDraft !== expectDraft || release.isPrerelease) {
    throw new Error(`${identity.productName} Mac release ${tag} in ${target.slug} has unexpected draft or prerelease state.`);
  }
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const name of requiredAssets) {
    const remote = assets.get(name);
    if (!remote) throw new Error(`${identity.productName} Mac release ${tag} in ${target.slug} is missing ${name}.`);
    const localSize = statSync(join(builderDir, name)).size;
    if (remote.size !== localSize) throw new Error(`${name} is ${remote.size} bytes in ${target.slug} but ${localSize} bytes locally.`);
    const localDigest = createHash("sha256").update(readFileSync(join(builderDir, name))).digest("hex");
    if (remote.digest !== `sha256:${localDigest}`) {
      throw new Error(`${name} has remote digest ${remote.digest || "missing"} in ${target.slug}; expected sha256:${localDigest}.`);
    }
  }
  return release;
}

function slugOf(repository) {
  return `${repository?.owner}/${repository?.repo}`;
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
