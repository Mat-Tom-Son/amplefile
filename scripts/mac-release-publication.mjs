import feedModule from "./mac-release-feed.cjs";

const { sameRepository } = feedModule;

// The publisher's decisions, kept apart from the commands that carry them out
// so each guard can be tested without GitHub.

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
 * `alreadyPublished` lists the repositories that already hold this exact
 * release, from an interrupted publication to both feeds.
 */
export function assertFeedContinuity({ feed, version, latest, replaceBridge = "", alreadyPublished = [] }) {
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
