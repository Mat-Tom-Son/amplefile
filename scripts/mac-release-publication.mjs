import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import feedModule from "./mac-release-feed.cjs";

const { sameRepository } = feedModule;

// How a release reaches its feeds. Every GitHub command goes through an
// injected `gh` runner, so the whole sequence, and each guard in it, can be
// tested against a stand-in for GitHub.

/**
 * Publish one built release to the next feed that does not serve it yet.
 *
 * `github` is `createGitHubReleases(...)`. `assets` lists the files to
 * upload as `{ name, path }`. `beforePublic` rechecks the source and the
 * build immediately before the draft becomes public; `afterSourcePublication`
 * confirms the annotated source tag is the one verified before upload.
 *
 * Returns the feed published to and, for the bridge's first run, the feed
 * still waiting for a later run.
 */
export async function publishMacRelease({
  feed,
  version,
  productName,
  arch,
  teamId,
  assets,
  github,
  replaceBridge = "",
  beforePublic,
  afterSourcePublication,
  log = () => {},
}) {
  const tag = `v${version}`;
  for (const target of feed.targets) github.assertPublic(target, productName);

  const plans = feed.targets.map((target) => ({
    target,
    action: planTargetPublication({ target, tag, existing: github.existingRelease(target, tag), publishesToSeveral: feed.targets.length > 1 }),
  }));
  const local = assets.map((asset) => ({
    ...asset,
    bytes: statSync(asset.path).size,
    sha256: createHash("sha256").update(readFileSync(asset.path)).digest("hex"),
  }));
  const remote = (repository, expectDraft) => assertRemoteRelease({
    release: github.release(repository, tag), repository, tag, productName, assets: local, expectDraft,
  });

  // The bridge is published to one feed per run. A feed that already serves
  // these exact bytes is done; any other release under this tag was refused.
  const alreadyPublished = plans.filter((plan) => plan.action === "verify-published").map((plan) => plan.target);
  for (const held of alreadyPublished) {
    remote(held, false);
    log(`${held.slug} already serves ${tag} with identical assets.`);
  }
  const target = nextPublicationTarget({ plans });
  if (!target) throw new Error(`${tag} is already published to ${feed.targets.map((entry) => entry.slug).join(" and ")}.`);

  assertFeedContinuity({
    feed,
    version,
    latest: { separate: github.latestRelease(feed.separate), source: github.latestRelease(feed.source) },
    separateReleases: feed.stage === "separate-repository" ? github.publishedReleases(feed.separate) : [],
    replaceBridge,
    alreadyPublished,
  });

  // The draft is uploaded and verified before anything becomes public.
  log(`Uploading ${tag} to ${target.slug} as a draft.`);
  github.createDraft(releaseCreateArguments({
    target,
    source: feed.source,
    tag,
    title: `${productName} ${version} for macOS`,
    notes: releaseNotes({ feed, target, productName, version, arch, teamId }),
    assetPaths: local.map((asset) => asset.path),
  }), `Could not create draft ${productName} macOS release ${tag} in ${target.slug}`);
  remote(target, true);

  // Uploads take time. Recheck authority and bytes at the public effect boundary.
  await beforePublic();
  github.publishDraft(target, tag, `Could not publish ${productName} macOS release ${tag} in ${target.slug}`);
  const release = remote(target, false);
  // Installed copies are offered the release GitHub marks latest, so it must be this one.
  const latest = github.latestTag(target);
  if (latest !== tag) {
    throw new Error(`${target.slug} serves ${latest || "no release"} as its latest release, not ${tag}. Installed copies will not be offered ${tag} until it is marked latest.`);
  }
  // In the source repository the release attached to the annotated tag; it must not have replaced it.
  if (sameRepository(target, feed.source)) await afterSourcePublication();
  log(`Published ${release.url}`);

  const remaining = plans.find((plan) => plan.action === "publish" && plan.target !== target)?.target ?? null;
  return { published: target, remaining, url: release.url };
}

/**
 * GitHub Releases as the publisher needs them, over `run(args, { timeoutMs })`,
 * which runs `gh` with those arguments and returns `{ status, stdout, stderr,
 * error }` as `spawnSync` does. `manifestName` is the release manifest asset.
 */
export function createGitHubReleases({ run, manifestName }) {
  const attempt = (args, timeoutMs = 120_000) => {
    const result = run(args, { timeoutMs });
    const stdout = String(result.stdout ?? "");
    const output = `${stdout}\n${result.stderr ?? ""}`.trim();
    return { ok: !result.error && result.status === 0, stdout: stdout.trim(), output: result.error?.message || output || `exit code ${result.status ?? 1}` };
  };
  const gh = (args, label, timeoutMs) => {
    const result = attempt(args, timeoutMs);
    if (!result.ok) throw new Error(`${label}: ${compactText(result.output)}`);
    return result.stdout;
  };
  const manifestFeedOf = (repository, tag) => manifestFeed(JSON.parse(gh(
    ["release", "download", tag, "--repo", repository.slug, "--pattern", manifestName, "--output", "-"],
    `Could not read the release manifest of ${tag} in ${repository.slug}`,
  )));
  const hasManifest = (release) => (release.assets ?? []).some((asset) => asset.name === manifestName);
  const readLatest = (repository) => {
    const result = attempt(["api", `repos/${repository.slug}/releases/latest`]);
    if (result.ok) return JSON.parse(result.stdout);
    if (/HTTP 404/.test(result.output)) return null;
    throw new Error(`Could not read the latest release in ${repository.slug}: ${compactText(result.output)}`);
  };

  return {
    assertPublic(repository, productName) {
      const info = JSON.parse(gh(["repo", "view", repository.slug, "--json", "isPrivate,visibility,url"], `Mac release feed ${repository.slug} was not found`));
      if (info.isPrivate || info.visibility !== "PUBLIC") {
        throw new Error(`${repository.slug} must be public so installed ${productName} apps can update without a GitHub token.`);
      }
    },

    /**
     * The release already published or drafted under this tag, or null. A
     * bare tag is not a release. Only GitHub saying there is none counts as
     * none: a failed lookup must not read as a free tag.
     */
    existingRelease(repository, tag) {
      const result = attempt(["release", "view", tag, "--repo", repository.slug, "--json", "tagName,isDraft,url"]);
      if (result.ok) return JSON.parse(result.stdout);
      if (/release not found|HTTP 404/i.test(result.output)) return null;
      throw new Error(`Could not tell whether ${repository.slug} already has a release for ${tag}: ${compactText(result.output)}`);
    },

    /** The release under this tag with its assets' names, sizes, and digests. */
    release(repository, tag) {
      return JSON.parse(gh(
        ["release", "view", tag, "--repo", repository.slug, "--json", "tagName,isDraft,isPrerelease,assets,url"],
        `Could not verify macOS release ${tag} in ${repository.slug}`,
      ));
    },

    /**
     * What the repository serves as its latest release: `null` when it has
     * none, otherwise `{ tag, feed }`, where `feed` is the repository that
     * release's packaged app checks, from its release manifest, or `null`
     * when it carries no manifest.
     */
    latestRelease(repository) {
      const release = readLatest(repository);
      if (!release) return null;
      return { tag: release.tag_name, feed: hasManifest(release) ? manifestFeedOf(repository, release.tag_name) : null };
    },

    /** Every published release in the repository as `{ tag, feed }`, with `feed` as `latestRelease` gives it. */
    publishedReleases(repository) {
      const pages = JSON.parse(gh(
        ["api", `repos/${repository.slug}/releases?per_page=100`, "--paginate", "--slurp"],
        `Could not list the releases in ${repository.slug}`,
      ));
      return pages.flat().filter((release) => !release.draft).map((release) => ({
        tag: release.tag_name,
        feed: hasManifest(release) ? manifestFeedOf(repository, release.tag_name) : null,
      }));
    },

    /** The tag of the release GitHub marks latest, or "" when there is none. */
    latestTag(repository) {
      return String(readLatest(repository)?.tag_name ?? "");
    },

    createDraft(args, label) {
      return gh(args, label, 45 * 60_000);
    },

    publishDraft(repository, tag, label) {
      return gh(["release", "edit", tag, "--repo", repository.slug, "--draft=false", "--latest"], label);
    },
  };
}

/** The remote release must be in the expected state and hold exactly these bytes for every asset. */
export function assertRemoteRelease({ release, repository, tag, productName, assets, expectDraft }) {
  if (release.tagName !== tag || release.isDraft !== expectDraft || release.isPrerelease) {
    throw new Error(`${productName} Mac release ${tag} in ${repository.slug} has unexpected draft or prerelease state.`);
  }
  const remote = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
  for (const asset of assets) {
    const found = remote.get(asset.name);
    if (!found) throw new Error(`${productName} Mac release ${tag} in ${repository.slug} is missing ${asset.name}.`);
    if (found.size !== asset.bytes) throw new Error(`${asset.name} is ${found.size} bytes in ${repository.slug} but ${asset.bytes} bytes locally.`);
    if (found.digest !== `sha256:${asset.sha256}`) {
      throw new Error(`${asset.name} has remote digest ${found.digest || "missing"} in ${repository.slug}; expected sha256:${asset.sha256}.`);
    }
  }
  return release;
}

/**
 * How a release manifest disagrees with the feed this checkout resolves:
 * the feed the packaged app checks, the stage, and the publication targets.
 * A manifest written before the stage existed has neither of the last two.
 */
export function releaseManifestFeedFailures(manifest, feed) {
  const failures = [];
  if (!sameRepository(manifestFeed(manifest), feed.packaged)) failures.push("Release manifest feed does not match the embedded Mac feed.");
  if (manifest?.feedStage !== feed.stage) failures.push(`Release manifest feed stage ${manifest?.feedStage || "missing"} does not match ${feed.stage}.`);
  const targets = (manifest?.publishTargets ?? []).map((target) => `${target?.owner}/${target?.repo}`);
  const expected = feed.targets.map((target) => target.slug);
  if (JSON.stringify(targets) !== JSON.stringify(expected)) {
    failures.push(`Release manifest publication targets ${targets.join(", ") || "missing"} do not match ${expected.join(", ")}.`);
  }
  return failures;
}

/**
 * The stage in use must be the one the tagged source records.
 * `taggedIdentity` is product-identity.json as the release tag holds it.
 */
export function assertTaggedFeedStage({ feed, tag, taggedIdentity }) {
  const tagged = typeof taggedIdentity?.macUpdateFeedStage === "string" ? taggedIdentity.macUpdateFeedStage : "";
  if (tagged !== feed.stage) {
    throw new Error(
      `Source tag ${tag} records the Mac update feed stage ${tagged || "(none)"}, but this publication uses ${feed.stage}. `
      + "A stage change belongs in the release commit, before the tag.",
    );
  }
}

function manifestFeed(manifest) {
  const owner = typeof manifest?.feed?.owner === "string" ? manifest.feed.owner.trim() : "";
  const repo = typeof manifest?.feed?.repo === "string" ? manifest.feed.repo.trim() : "";
  return owner && repo ? { owner, repo } : null;
}

function compactText(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 1800);
}

/** A public release records its feed stage in the tagged source, not in a workstation's environment. */
export function assertCheckedInFeedStage(feed) {
  if (feed.stage !== feed.checkedInStage) {
    throw new Error(
      `This build uses the Mac update feed stage ${feed.stage}, but the release source records ${feed.checkedInStage}. `
      + "AMPLEFILE_MAC_UPDATE_FEED_STAGE is for candidate builds; commit macUpdateFeedStage in src/shared/product-identity.json to publish.",
    );
  }
}

/**
 * Refuse a publication that would leave installed copies checking a feed
 * that never receives another release.
 *
 * `latest.separate` and `latest.source` describe the release each repository
 * serves as its latest (what an installed copy is offered): `null` when it
 * has none, otherwise `{ tag, feed }`, where `feed` is the repository that
 * release's packaged app checks, read from its release manifest, or `null`
 * when the release carries no AmpleFile Mac manifest.
 *
 * `separateReleases` lists every published release in the separate
 * repository as `{ tag, feed }`; it is read in the `separate-repository`
 * stage, where a bridge anywhere in that history closes the feed.
 *
 * `alreadyPublished` lists the repositories that already hold this exact
 * release, from the bridge's earlier run.
 */
export function assertFeedContinuity({ feed, version, latest, separateReleases = [], replaceBridge = "", alreadyPublished = [] }) {
  const { stage, source, separate } = feed;
  const tag = `v${version}`;
  const held = (repository) => alreadyPublished.some((entry) => sameRepository(entry, repository));
  const separateLatest = held(separate) ? null : latest.separate;
  const sourceLatest = held(source) ? null : latest.source;

  if (stage === "separate-repository") {
    if (separateLatest) {
      assertMacRelease(separate, separateLatest);
      if (!sameRepository(separateLatest.feed, separate)) {
        throw new Error(
          `${separate.slug} ends with the bridge release ${separateLatest.tag}: copies installed from it check ${describe(separateLatest.feed)} `
          + `and would never see ${tag}. Publish with the source-repository stage.`,
        );
      }
    }
    // The latest release is not the whole story: an older release can be
    // marked latest again, and a bridge can be public in the source
    // repository without having reached the separate one.
    const bridge = separateReleases.find((release) => release.feed && !sameRepository(release.feed, separate));
    if (bridge) {
      throw new Error(
        `${separate.slug} holds the bridge release ${bridge.tag}, although it is not its latest release: copies installed from it check `
        + `${describe(bridge.feed)} and would never see ${tag}. Mark ${bridge.tag} latest again and publish with the source-repository stage.`,
      );
    }
    if (latest.source?.feed && sameRepository(latest.source.feed, source)) {
      throw new Error(
        `${source.slug} already serves the Mac release ${latest.source.tag}, and copies installed from it check ${source.slug}: `
        + `they would never see ${tag} in ${separate.slug}. Finish the move with the bridge stage.`,
      );
    }
  } else if (stage === "bridge") {
    if (!latest.separate) {
      throw new Error(`${separate.slug} has no release, so there is nothing to bridge from. Publish with the source-repository stage.`);
    }
    if (separateLatest) {
      assertMacRelease(separate, separateLatest);
      if (sameRepository(separateLatest.feed, source)) {
        if (replaceBridge !== separateLatest.tag) {
          throw new Error(
            `${separate.slug} already ends with the bridge release ${separateLatest.tag}. Later releases belong in ${source.slug} alone. `
            + `To replace a bridge that cannot update from ${source.slug}, set AMPLEFILE_MAC_REPLACE_BRIDGE=${separateLatest.tag}.`,
          );
        }
      } else if (!sameRepository(separateLatest.feed, separate)) {
        throw new Error(`${separate.slug}'s latest release ${separateLatest.tag} checks ${describe(separateLatest.feed)}, which this bridge does not publish to.`);
      } else if (replaceBridge) {
        throw new Error(`AMPLEFILE_MAC_REPLACE_BRIDGE names ${replaceBridge}, but ${separate.slug}'s latest release ${separateLatest.tag} is not a bridge.`);
      }
    }
    if (sourceLatest) assertSourceFeedRelease(source, sourceLatest);
  } else {
    if (latest.separate) {
      assertMacRelease(separate, latest.separate);
      if (sameRepository(latest.separate.feed, separate)) {
        throw new Error(
          `Copies installed from ${separate.slug} still check it: its latest release ${latest.separate.tag} does not name ${source.slug}, `
          + `so they would never see ${tag}. Publish the bridge release first.`,
        );
      }
      if (!sameRepository(latest.separate.feed, source)) {
        throw new Error(`${separate.slug}'s latest release ${latest.separate.tag} checks ${describe(latest.separate.feed)}, not ${source.slug}.`);
      }
      if (!latest.source) {
        throw new Error(`${source.slug} has no Mac release, although ${separate.slug} sends its copies there. Publish the bridge release to both first.`);
      }
    }
    if (sourceLatest) assertSourceFeedRelease(source, sourceLatest);
  }

  // An installed copy is only offered a higher version, and the published
  // release becomes the one the feed serves as latest.
  for (const [repository, current] of [[separate, separateLatest], [source, sourceLatest]]) {
    if (!current || !feed.targets.some((target) => sameRepository(target, repository))) continue;
    if (compareReleaseVersions(version, current.tag) <= 0) {
      throw new Error(`${tag} is not higher than ${current.tag}, the latest release in ${repository.slug}. Installed copies would not be offered it.`);
    }
  }
}

/**
 * What to do with one publication target. `existing` is the release already
 * there under this tag, or `null`.
 */
export function planTargetPublication({ target, tag, existing, publishesToSeveral }) {
  if (!existing) return "publish";
  if (existing.isDraft) {
    throw new Error(`${target.slug} already contains ${tag} as a draft. Delete only a failed draft before retrying. ${existing.url ?? ""}`.trim());
  }
  // Publishing to two repositories can stop between them. A repository that
  // already serves these exact bytes is done; the caller verifies them.
  if (publishesToSeveral) return "verify-published";
  throw new Error(`${target.slug} already contains ${tag}. Bump the shared version: a published release is never replaced. ${existing.url ?? ""}`.trim());
}

/**
 * The one feed this run publishes to: the first, in publication order, that
 * does not serve the release yet, or `null` when every feed does. `plans`
 * pairs every target with its `planTargetPublication` action.
 *
 * A run never publishes to two feeds. The bridge goes to the source
 * repository in one run and to the separate repository in a later one, so
 * the built bridge can be checked against the source repository before any
 * installed copy is offered it, and so nothing, not even a draft, reaches
 * the separate repository until the source repository serves the release.
 */
export function nextPublicationTarget({ plans }) {
  return plans.find((plan) => plan.action === "publish")?.target ?? null;
}

/**
 * What to do after a run that published the bridge to the source repository
 * and left the separate repository for the next run.
 */
export function bridgePauseMessage({ feed, version, productName, published, remaining }) {
  return [
    `${productName} ${version} is published in ${published.slug} only. No installed copy reads that feed yet.`,
    `Publishing to ${remaining.slug} is the step that cannot be taken back, so check first:`,
    `  1. npm run desktop:verify:feed:mac -- --feed ${published.slug} --version ${version}`,
    `  2. Open a copy of the signed candidate and confirm that Check for Updates... reports ${version} is up to date`,
    `     (docs/macos-release.md, "The bridge release").`,
    `Merge nothing to main until the next run has finished: publication requires origin/main to be the tagged commit.`,
    `Then publish to ${remaining.slug} with: npm run desktop:release:mac:resume`,
  ].join("\n");
}

/**
 * `gh release create` arguments for a draft. In the source repository the
 * annotated `v<version>` tag already exists and the release attaches to it:
 * `--verify-tag` refuses to create a tag, and no `--target` is given, so a
 * tag is never created or moved there. The separate release repository has
 * no source history, and GitHub tags its `main` when the draft is published.
 */
export function releaseCreateArguments({ target, source, tag, title, notes, assetPaths }) {
  return [
    "release", "create", tag,
    "--repo", target.slug,
    ...(sameRepository(target, source) ? ["--verify-tag"] : ["--target", "main"]),
    "--title", title,
    "--notes", notes,
    "--draft",
    ...assetPaths,
  ];
}

export function releaseNotes({ feed, target, productName, version, arch, teamId }) {
  const lines = [
    `${productName} ${version} for macOS`,
    "",
    `Signed with Apple Team ID ${teamId}, notarized by Apple, and published for ${arch}.`,
    "Use the DMG for a first install. Existing updater-capable Mac installs consume the ZIP and latest-mac.yml assets.",
  ];
  if (feed.stage === "bridge" && sameRepository(target, feed.separate)) {
    lines.push(
      "",
      `This is the last release published here. ${productName} ${version} checks https://github.com/${feed.source.slug}/releases for updates, and later releases are published there.`,
    );
  }
  return lines.join("\n");
}

/** Compare two release versions (`0.1.5` or `v0.1.5`); a prerelease sorts below its release. */
export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function parseReleaseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? "").trim());
  if (!match) throw new Error(`${JSON.stringify(value)} is not a release version.`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? "" };
}

function assertMacRelease(repository, release) {
  if (!release.feed) {
    throw new Error(
      `${repository.slug} serves ${release.tag} as its latest release, and it carries no AmpleFile Mac release manifest, `
      + "so the feed its installed copies check is unknown.",
    );
  }
}

function assertSourceFeedRelease(source, release) {
  if (!release.feed || !sameRepository(release.feed, source)) {
    throw new Error(
      `${source.slug} serves ${release.tag} as its latest release, and it is not an AmpleFile Mac release that checks ${source.slug}. `
      + "Installed copies are offered whatever is marked latest there: make that release a prerelease, or publish it with --latest=false.",
    );
  }
}

function describe(repository) {
  return repository?.owner && repository?.repo ? `${repository.owner}/${repository.repo}` : "an unknown feed";
}
