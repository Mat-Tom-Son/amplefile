// Which GitHub repository the packaged app checks for updates, and which
// repositories a release is published to. They are decided here, once, for
// the builder configuration (CommonJS), the build and publish scripts, the
// verifiers, and the website.
//
// A stage names one of the three arrangements that leave no installed copy
// behind:
//
//   separate-repository  the app checks the separate release repository, and
//                        releases are published there;
//   bridge               the app checks the source repository, and the
//                        release is published to both, so every copy that
//                        still checks the separate repository updates to a
//                        version that checks the source repository;
//   source-repository    the app checks the source repository, and releases
//                        are published there.
//
// The checked-in stage is `macUpdateFeedStage` in product-identity.json.
// AMPLEFILE_MAC_UPDATE_FEED_STAGE overrides it for a candidate build only:
// the publisher refuses a stage the tagged source does not record.

const MAC_UPDATE_FEED_STAGES = Object.freeze(["separate-repository", "bridge", "source-repository"]);

function resolveMacReleaseFeed(identity, env = process.env) {
  const checkedInStage = text(identity.macUpdateFeedStage);
  const stage = text(env.AMPLEFILE_MAC_UPDATE_FEED_STAGE) || checkedInStage;
  if (!MAC_UPDATE_FEED_STAGES.includes(stage)) {
    throw new Error(`Unknown Mac update feed stage ${JSON.stringify(stage)}. Use one of: ${MAC_UPDATE_FEED_STAGES.join(", ")}.`);
  }
  const source = repository(identity.sourceRepositoryOwner, identity.sourceRepositoryName);
  const separate = repository(
    text(env.AMPLEFILE_MAC_RELEASE_OWNER) || identity.sourceRepositoryOwner,
    text(env.AMPLEFILE_MAC_RELEASE_REPO) || identity.macReleaseRepositoryName,
  );
  if (sameRepository(separate, source)) {
    throw new Error(
      `AMPLEFILE_MAC_RELEASE_OWNER and AMPLEFILE_MAC_RELEASE_REPO name the separate release repository, not ${source.slug}. `
      + "Choose where releases go with the Mac update feed stage instead.",
    );
  }
  const packaged = stage === "separate-repository" ? separate : source;
  // The feed the packaged app checks comes first: nothing reads it until a
  // copy carrying it is installed, so publishing there first is harmless.
  const targets = stage === "bridge" ? [source, separate] : [packaged];
  return Object.freeze({
    stage,
    checkedInStage,
    source,
    separate,
    /** The feed written into the packaged app's app-update.yml. */
    packaged,
    /** Where the publisher uploads this release, in publication order. */
    targets: Object.freeze(targets),
    /** Where download links point: always a feed whose latest release is a Mac release. */
    downloads: stage === "source-repository" ? source : separate,
  });
}

function repository(owner, repo) {
  const value = { owner: text(owner), repo: text(repo) };
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.owner) || !/^[A-Za-z0-9._-]+$/.test(value.repo)) {
    throw new Error(`Invalid GitHub repository ${JSON.stringify(`${value.owner}/${value.repo}`)}.`);
  }
  return Object.freeze({ ...value, slug: `${value.owner}/${value.repo}` });
}

/** Parse `owner/repo`, as a command-line argument gives it. */
function parseRepository(slug) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(text(slug));
  if (!match) throw new Error(`Expected a GitHub repository as owner/repo, not ${JSON.stringify(slug)}.`);
  return repository(match[1], match[2]);
}

function sameRepository(left, right) {
  return Boolean(left && right)
    && text(left.owner).toLowerCase() === text(right.owner).toLowerCase()
    && text(left.repo).toLowerCase() === text(right.repo).toLowerCase();
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { MAC_UPDATE_FEED_STAGES, resolveMacReleaseFeed, parseRepository, sameRepository };
