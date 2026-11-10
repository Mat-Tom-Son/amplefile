import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import feedModule from "../scripts/mac-release-feed.cjs";
import {
  assertCheckedInFeedStage,
  assertFeedContinuity,
  compareReleaseVersions,
  planTargetPublication,
  bridgePauseMessage,
  nextPublicationTarget,
  releaseCreateArguments,
  releaseNotes,
} from "../scripts/mac-release-publication.mjs";
import { readPublicUpdateFeed } from "../scripts/verify-mac-feed.mjs";

const { MAC_UPDATE_FEED_STAGES, parseRepository, resolveMacReleaseFeed } = feedModule;
const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const identity = JSON.parse(read("src/shared/product-identity.json"));
const separateSlug = "Mat-Tom-Son/amplefile-mac-releases";
const sourceSlug = "Mat-Tom-Son/amplefile";
const separate = { owner: "Mat-Tom-Son", repo: "amplefile-mac-releases" };
const source = { owner: "Mat-Tom-Son", repo: "amplefile" };

function feedAt(stage: string) {
  return resolveMacReleaseFeed({ ...identity, macUpdateFeedStage: stage }, {});
}

// The one line that pins the checked-in stage. Change it in the commit that
// changes `macUpdateFeedStage`; the last test in this file then says which
// links, policy text, and statements of the stage have to follow.
const CHECKED_IN_STAGE = "source-repository";

test("the checked-in Mac update feed stage is the pinned one, with the feeds that stage means", () => {
  assert.equal(identity.macUpdateFeedStage, CHECKED_IN_STAGE);
  const expected = {
    // As 0.1.4 shipped: the app checks the separate repository and the release goes there alone.
    "separate-repository": { packaged: separateSlug, targets: [separateSlug], downloads: separateSlug },
    bridge: { packaged: sourceSlug, targets: [sourceSlug, separateSlug], downloads: separateSlug },
    "source-repository": { packaged: sourceSlug, targets: [sourceSlug], downloads: sourceSlug },
  }[CHECKED_IN_STAGE];
  const feed = resolveMacReleaseFeed(identity, {});
  assert.equal(feed.stage, CHECKED_IN_STAGE);
  assert.equal(feed.packaged.slug, expected.packaged, "the feed the packaged app checks");
  assert.deepEqual(feed.targets.map((target: { slug: string }) => target.slug), expected.targets, "where the release is published, in order");
  assert.equal(feed.downloads.slug, expected.downloads, "where download links point");
});

test("each feed stage decides the packaged feed and the publication targets separately", () => {
  assert.deepEqual([...MAC_UPDATE_FEED_STAGES], ["separate-repository", "bridge", "source-repository"]);

  const bridge = feedAt("bridge");
  assert.equal(bridge.packaged.slug, sourceSlug, "a bridge build checks the source repository");
  assert.deepEqual(
    bridge.targets.map((target: { slug: string }) => target.slug),
    [sourceSlug, separateSlug],
    "and is published to the feed nothing reads yet before the feed installed copies read",
  );
  assert.equal(bridge.downloads.slug, separateSlug, "download links stay on a feed that always has a latest Mac release");

  const steady = feedAt("source-repository");
  assert.equal(steady.packaged.slug, sourceSlug);
  assert.deepEqual(steady.targets.map((target: { slug: string }) => target.slug), [sourceSlug]);
  assert.equal(steady.downloads.slug, sourceSlug);
  assert.equal(steady.separate.slug, separateSlug, "the separate repository stays known so its bridge can be checked");
});

test("the environment names the separate repository and may override the stage for a candidate", () => {
  const overridden = resolveMacReleaseFeed({ ...identity, macUpdateFeedStage: "separate-repository" }, {
    AMPLEFILE_MAC_RELEASE_OWNER: " Example ",
    AMPLEFILE_MAC_RELEASE_REPO: "example-mac-releases",
    AMPLEFILE_MAC_UPDATE_FEED_STAGE: "bridge",
  });
  assert.equal(overridden.stage, "bridge");
  assert.equal(overridden.checkedInStage, "separate-repository");
  assert.equal(overridden.separate.slug, "Example/example-mac-releases");
  assert.equal(overridden.packaged.slug, sourceSlug, "the source repository is never taken from the environment");

  assert.throws(() => resolveMacReleaseFeed(identity, { AMPLEFILE_MAC_UPDATE_FEED_STAGE: "both" }), /Unknown Mac update feed stage "both"/);
  assert.throws(() => resolveMacReleaseFeed({ ...identity, macUpdateFeedStage: undefined }, {}), /Unknown Mac update feed stage/);
  assert.throws(
    () => resolveMacReleaseFeed(identity, { AMPLEFILE_MAC_RELEASE_REPO: "AmpleFile" }),
    /name the separate release repository, not Mat-Tom-Son\/amplefile/,
    "pointing the old variables at the source repository would skip the bridge",
  );
  assert.throws(() => resolveMacReleaseFeed(identity, { AMPLEFILE_MAC_RELEASE_REPO: "bad repo" }), /Invalid GitHub repository/);
  assert.equal(parseRepository("Mat-Tom-Son/amplefile").slug, sourceSlug);
  assert.throws(() => parseRepository("amplefile"), /owner\/repo/);
});

test("the builder writes the packaged feed, not the publication targets, into the app", () => {
  const require = createRequire(import.meta.url);
  const builderPath = join(rootDir, "electron-builder.desktop.cjs");
  const names = ["AMPLEFILE_MAC_UPDATE_FEED_STAGE", "AMPLEFILE_MAC_RELEASE_OWNER", "AMPLEFILE_MAC_RELEASE_REPO"];
  const previous = names.map((name) => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    const publishAt = (stage?: string) => {
      if (stage) process.env.AMPLEFILE_MAC_UPDATE_FEED_STAGE = stage;
      else delete process.env.AMPLEFILE_MAC_UPDATE_FEED_STAGE;
      delete require.cache[require.resolve(builderPath)];
      return require(builderPath).publish;
    };
    const entry = (repo: string) => [{ provider: "github", owner: "Mat-Tom-Son", repo, releaseType: "release" }];
    assert.deepEqual(publishAt(), entry(resolveMacReleaseFeed(identity, {}).packaged.repo), "with no override, the checked-in stage");
    assert.deepEqual(publishAt("separate-repository"), entry("amplefile-mac-releases"));
    assert.deepEqual(publishAt("bridge"), entry("amplefile"), "one feed entry: electron-builder packages the first");
    assert.deepEqual(publishAt("source-repository"), entry("amplefile"));
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    delete require.cache[require.resolve(builderPath)];
  }
});

test("every release script takes the feed from the one resolver", () => {
  for (const script of [
    "electron-builder.desktop.cjs",
    "scripts/build-mac-desktop.mjs",
    "scripts/mac-release-status.mjs",
    "scripts/write-mac-release-manifest.mjs",
    "scripts/verify-mac-release.mjs",
    "scripts/verify-installed-mac-app.mjs",
    "scripts/verify-mac-feed.mjs",
    "scripts/publish-mac-release.mjs",
    "site/build.mjs",
  ]) {
    const text = read(script);
    assert.match(text, /resolveMacReleaseFeed\(/, `${script} resolves the feed`);
    assert.doesNotMatch(text, /AMPLEFILE_MAC_RELEASE_(?:OWNER|REPO)|macReleaseRepositoryName/, `${script} does not decide the feed itself`);
  }
  const manifest = read("scripts/write-mac-release-manifest.mjs");
  assert.match(manifest, /feed: \{ owner: feed\.packaged\.owner, repo: feed\.packaged\.repo \}/);
  assert.match(manifest, /publishTargets: feed\.targets\.map/);
});

test("a public release must use the feed stage its tagged source records", () => {
  assertCheckedInFeedStage(resolveMacReleaseFeed(identity, {}));
  const recorded = { ...identity, macUpdateFeedStage: "separate-repository" };
  assertCheckedInFeedStage(resolveMacReleaseFeed(recorded, { AMPLEFILE_MAC_UPDATE_FEED_STAGE: "separate-repository" }));
  assert.throws(
    () => assertCheckedInFeedStage(resolveMacReleaseFeed(recorded, { AMPLEFILE_MAC_UPDATE_FEED_STAGE: "bridge" })),
    /uses the Mac update feed stage bridge, but the release source records separate-repository/,
  );
  assert.match(read("scripts/publish-mac-release.mjs"), /async \(lockToken\) => \{\n  assertCheckedInFeedStage\(feed\);/);
});

test("the separate feed accepts ordinary releases until a bridge closes it", () => {
  const feed = feedAt("separate-repository");
  assertFeedContinuity({ feed, version: "0.1.5", latest: { separate: { tag: "v0.1.4", feed: separate }, source: null } });
  assertFeedContinuity({ feed, version: "0.1.0", latest: { separate: null, source: null } });
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.6", latest: { separate: { tag: "v0.1.5", feed: source }, source: { tag: "v0.1.5", feed: source } } }),
    /ends with the bridge release v0\.1\.5: copies installed from it check Mat-Tom-Son\/amplefile and would never see v0\.1\.6/,
  );
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.5", latest: { separate: { tag: "v0.1.4", feed: null }, source: null } }),
    /carries no AmpleFile Mac release manifest/,
  );
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.4", latest: { separate: { tag: "v0.1.4", feed: separate }, source: null } }),
    /v0\.1\.4 is not higher than v0\.1\.4, the latest release in Mat-Tom-Son\/amplefile-mac-releases/,
  );
});

test("a bridge needs installed copies to move and is published once", () => {
  const feed = feedAt("bridge");
  const before = { separate: { tag: "v0.1.4", feed: separate }, source: null };
  assertFeedContinuity({ feed, version: "0.1.5", latest: before });
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.5", latest: { separate: null, source: null } }),
    /has no release, so there is nothing to bridge from/,
  );
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.3", latest: before }),
    /v0\.1\.3 is not higher than v0\.1\.4/,
  );
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.5", latest: before, replaceBridge: "v0.1.4" }),
    /AMPLEFILE_MAC_REPLACE_BRIDGE names v0\.1\.4, but .* is not a bridge/,
    "a replacement left set in the environment does not pass silently",
  );
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.5", latest: { separate: { tag: "v0.1.4", feed: { owner: "Other", repo: "feed" } }, source: null } }),
    /checks Other\/feed, which this bridge does not publish to/,
  );

  // The source repository holds prereleases for another platform. One marked
  // latest would be offered to every bridged copy.
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.5", latest: { separate: before.separate, source: { tag: "linux-test-0.1.4", feed: null } } }),
    /serves linux-test-0\.1\.4 as its latest release, and it is not an AmpleFile Mac release that checks Mat-Tom-Son\/amplefile/,
  );

  // Once bridged, a second bridge needs the first one named.
  const bridged = { separate: { tag: "v0.1.5", feed: source }, source: { tag: "v0.1.5", feed: source } };
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.6", latest: bridged }),
    /already ends with the bridge release v0\.1\.5\. Later releases belong in Mat-Tom-Son\/amplefile alone\. .*AMPLEFILE_MAC_REPLACE_BRIDGE=v0\.1\.5/,
  );
  assert.throws(() => assertFeedContinuity({ feed, version: "0.1.6", latest: bridged, replaceBridge: "v0.1.4" }), /AMPLEFILE_MAC_REPLACE_BRIDGE=v0\.1\.5/);
  assertFeedContinuity({ feed, version: "0.1.6", latest: bridged, replaceBridge: "v0.1.5" });
  assert.throws(() => assertFeedContinuity({ feed, version: "0.1.5", latest: bridged, replaceBridge: "v0.1.5" }), /v0\.1\.5 is not higher than v0\.1\.5/);
});

test("an interrupted bridge publication finishes the feed that is still missing", () => {
  const feed = feedAt("bridge");
  // The source repository already serves 0.1.5; the separate one is still at 0.1.4.
  const latest = { separate: { tag: "v0.1.4", feed: separate }, source: { tag: "v0.1.5", feed: source } };
  assert.throws(() => assertFeedContinuity({ feed, version: "0.1.5", latest }), /v0\.1\.5 is not higher than v0\.1\.5, the latest release in Mat-Tom-Son\/amplefile\./);
  assertFeedContinuity({ feed, version: "0.1.5", latest, alreadyPublished: [feed.source] });

  // Holding the release is not enough: the source repository must offer it.
  const held = (sourceLatest: { tag: string; feed: unknown } | null) => () => assertFeedContinuity({
    feed, version: "0.1.5", latest: { separate: latest.separate, source: sourceLatest }, alreadyPublished: [feed.source],
  });
  assert.throws(held(null), /serves no release as its latest release, not v0\.1\.5.*Mark v0\.1\.5 latest again in Mat-Tom-Son\/amplefile/);
  assert.throws(held({ tag: "linux-test-0.1.5", feed: null }), /serves linux-test-0\.1\.5 as its latest release, not v0\.1\.5/);
  assert.throws(held({ tag: "v0.1.4", feed: source }), /serves v0\.1\.4 as its latest release, not v0\.1\.5/);
  assert.throws(held({ tag: "v0.1.6", feed: separate }), /serves v0\.1\.6 as its latest release/, "a later release that checks another feed");
  held({ tag: "v0.1.6", feed: source })();
});

test("the source feed refuses a release that skips the bridge", () => {
  const feed = feedAt("source-repository");
  const bridged = { separate: { tag: "v0.1.5", feed: source }, source: { tag: "v0.1.5", feed: source } };
  assertFeedContinuity({ feed, version: "0.1.6", latest: bridged });
  assertFeedContinuity({ feed, version: "0.1.0", latest: { separate: null, source: null } });
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.5", latest: { separate: { tag: "v0.1.4", feed: separate }, source: null } }),
    /Copies installed from Mat-Tom-Son\/amplefile-mac-releases still check it: its latest release v0\.1\.4 does not name Mat-Tom-Son\/amplefile, so they would never see v0\.1\.5\. Publish the bridge release first/,
  );
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.6", latest: { separate: bridged.separate, source: null } }),
    /has no Mac release, although Mat-Tom-Son\/amplefile-mac-releases sends its copies there/,
  );
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.6", latest: { separate: bridged.separate, source: { tag: "linux-test-0.1.5", feed: null } } }),
    /serves linux-test-0\.1\.5 as its latest release.*mark it latest again \(gh release edit v<version> --repo Mat-Tom-Son\/amplefile --latest\); otherwise make linux-test-0\.1\.5 a prerelease \(gh release edit linux-test-0\.1\.5 --repo Mat-Tom-Son\/amplefile --prerelease\)/,
    "the remedy has to work on a release that is already published",
  );
  assert.throws(
    () => assertFeedContinuity({ feed, version: "0.1.6", latest: { separate: { tag: "v0.1.5", feed: null }, source: bridged.source } }),
    /carries no AmpleFile Mac release manifest/,
  );
  assert.throws(() => assertFeedContinuity({ feed, version: "0.1.5", latest: bridged }), /v0\.1\.5 is not higher than v0\.1\.5/);
});

test("a published release is never replaced, and only a two-feed publication resumes", () => {
  const target = feedAt("bridge").separate;
  const published = { tagName: "v0.1.5", isDraft: false, url: "https://example.test/release" };
  assert.equal(planTargetPublication({ target, tag: "v0.1.5", existing: null, publishesToSeveral: false }), "publish");
  assert.throws(
    () => planTargetPublication({ target, tag: "v0.1.5", existing: published, publishesToSeveral: false }),
    /already contains v0\.1\.5\. Bump the shared version: a published release is never replaced/,
  );
  assert.equal(
    planTargetPublication({ target, tag: "v0.1.5", existing: published, publishesToSeveral: true }),
    "verify-published",
    "the caller then proves the remote bytes are these bytes",
  );
  for (const publishesToSeveral of [false, true]) {
    assert.throws(
      () => planTargetPublication({ target, tag: "v0.1.5", existing: { ...published, isDraft: true }, publishesToSeveral }),
      /already contains v0\.1\.5 as a draft/,
    );
  }
});

test("a run publishes to one feed, and the separate repository only after the source repository", () => {
  const feed = feedAt("bridge");
  const fresh = [{ target: feed.source, action: "publish" }, { target: feed.separate, action: "publish" }];
  const half = [{ target: feed.source, action: "verify-published" }, { target: feed.separate, action: "publish" }];
  const done = [{ target: feed.source, action: "verify-published" }, { target: feed.separate, action: "verify-published" }];
  assert.equal(nextPublicationTarget({ plans: fresh }), feed.source, "the first run stops after the feed nothing reads yet");
  assert.equal(nextPublicationTarget({ plans: half }), feed.separate, "only a later run reaches the feed installed copies read");
  assert.equal(nextPublicationTarget({ plans: done }), null, "nothing left; the publisher says so");
  const steady = feedAt("source-repository");
  assert.equal(nextPublicationTarget({ plans: [{ target: steady.source, action: "publish" }] }), steady.source);

  const message = bridgePauseMessage({ feed, version: "0.1.5", productName: "AmpleFile", published: feed.source, remaining: feed.separate });
  assert.match(message, /AmpleFile 0\.1\.5 is published in Mat-Tom-Son\/amplefile only\. No installed copy reads that feed yet\./);
  assert.match(message, /npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son\/amplefile --version 0\.1\.5/);
  assert.match(message, /Check for Updates\.\.\. reports 0\.1\.5 is up to date/);
  assert.match(message, /Merge nothing to main until the next run has finished/);
  assert.match(message, /Then publish to Mat-Tom-Son\/amplefile-mac-releases with: npm run desktop:release:mac:resume/);
  assert.doesNotMatch(read("scripts/publish-mac-release.mjs"), /AMPLEFILE_MAC_PUBLISH_ONLY/, "the pause is not optional");
});

test("a release in the source repository attaches to its annotated tag and never creates one", () => {
  const feed = feedAt("bridge");
  const common = { source: feed.source, tag: "v0.1.5", title: "AmpleFile 0.1.5 for macOS", notes: "notes", assetPaths: ["/out/a.dmg", "/out/latest-mac.yml"] };
  const inSource = releaseCreateArguments({ ...common, target: feed.source });
  assert.deepEqual(inSource, [
    "release", "create", "v0.1.5", "--repo", sourceSlug, "--verify-tag",
    "--title", "AmpleFile 0.1.5 for macOS", "--notes", "notes", "--draft", "/out/a.dmg", "/out/latest-mac.yml",
  ]);
  assert.ok(!inSource.includes("--target"), "a target would let GitHub create the tag");
  const inSeparate = releaseCreateArguments({ ...common, target: feed.separate });
  assert.deepEqual(inSeparate.slice(0, 7), ["release", "create", "v0.1.5", "--repo", separateSlug, "--target", "main"]);
  assert.ok(!inSeparate.includes("--verify-tag"));
  assert.ok(inSeparate.includes("--draft") && inSource.includes("--draft"), "nothing is public until its draft is verified");

  for (const script of ["scripts/publish-mac-release.mjs", "scripts/mac-release-publication.mjs"]) {
    assert.doesNotMatch(read(script), /cleanup-tag|release", "delete|"tag", "-d|push.*--force/, `${script} never deletes or moves a tag`);
  }
});

test("the bridge's notes in the separate repository say where later releases are", () => {
  const feed = feedAt("bridge");
  const base = { feed, productName: "AmpleFile", version: "0.1.5", arch: "arm64", teamId: "464JD5K8DC" };
  const closing = releaseNotes({ ...base, target: feed.separate });
  assert.match(closing, /This is the last release published here\. AmpleFile 0\.1\.5 checks https:\/\/github\.com\/Mat-Tom-Son\/amplefile\/releases for updates/);
  assert.doesNotMatch(releaseNotes({ ...base, target: feed.source }), /last release/);
  const ordinary = feedAt("separate-repository");
  assert.equal(
    releaseNotes({ ...base, feed: ordinary, version: "0.1.4", target: ordinary.separate }),
    [
      "AmpleFile 0.1.4 for macOS",
      "",
      "Signed with Apple Team ID 464JD5K8DC, notarized by Apple, and published for arm64.",
      "Use the DMG for a first install. Existing updater-capable Mac installs consume the ZIP and latest-mac.yml assets.",
    ].join("\n"),
    "an ordinary release reads as 0.1.4 did",
  );
});

test("release versions compare by number, and a prerelease is below its release", () => {
  assert.equal(compareReleaseVersions("0.1.10", "v0.1.9"), 1);
  assert.equal(compareReleaseVersions("v0.2.0", "0.10.0"), -1);
  assert.equal(compareReleaseVersions("1.0.0", "v1.0.0"), 0);
  assert.equal(compareReleaseVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareReleaseVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.throws(() => compareReleaseVersions("0.1.5", "linux-test-0.1.4"), /is not a release version/);
});

test("the installed-app verifier checks the packaged feed unless a proof names another", () => {
  const verifier = read("scripts/verify-installed-mac-app.mjs");
  assert.match(verifier, /argumentValue\("--feed"\)\n  \? feedModule\.parseRepository\(argumentValue\("--feed"\)\)\n  : feedModule\.resolveMacReleaseFeed\(identity\)\.packaged;/);
  assert.match(read("scripts/verify-mac-release.mjs"), /const expectedFeedOwner = feed\.packaged\.owner;/);
});

test("the public feed is read the way an installed copy reads it", async () => {
  const feed = parseRepository(sourceSlug);
  const base = `https://github.com/${sourceSlug}/releases`;
  const pages = (overrides: Record<string, string | number>) => {
    const answers: Record<string, string | number> = {
      [`${base}.atom`]: "<feed><entry><title>v0.1.5</title></entry></feed>",
      [`${base}/latest`]: JSON.stringify({ tag_name: "v0.1.5" }),
      [`${base}/download/v0.1.5/latest-mac.yml`]: "version: 0.1.5\nfiles:\n  - url: AmpleFile-0.1.5-mac-arm64.zip\npath: AmpleFile-0.1.5-mac-arm64.zip\nsha512: abc\n",
      ...overrides,
    };
    const requests: Array<{ url: string; accept: string }> = [];
    const fetch = async (url: string, init: { headers: { Accept: string } }) => {
      requests.push({ url, accept: init.headers.Accept });
      const answer = answers[url];
      return typeof answer === "string"
        ? { ok: true, status: 200, text: async () => answer }
        : { ok: false, status: answer ?? 404, text: async () => "" };
    };
    return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
  };

  const served = pages({});
  assert.deepEqual(await readPublicUpdateFeed({ feed, fetch: served.fetch }), {
    feed: sourceSlug,
    tag: "v0.1.5",
    version: "0.1.5",
    path: "AmpleFile-0.1.5-mac-arm64.zip",
    downloadUrl: `${base}/download/v0.1.5/AmpleFile-0.1.5-mac-arm64.zip`,
  });
  assert.deepEqual(served.requests.map((request) => request.url), [`${base}.atom`, `${base}/latest`, `${base}/download/v0.1.5/latest-mac.yml`]);
  assert.equal(served.requests[1]!.accept, "application/json", "the updater asks github.com, not the API, for the latest tag");

  // A repository with only prereleases answers the latest request with its
  // releases page, which names no tag: the source repository before the bridge.
  await assert.rejects(
    readPublicUpdateFeed({ feed, fetch: pages({ [`${base}/latest`]: JSON.stringify({ payload: { releasesIndexRoute: {} } }) }).fetch }),
    /has no latest release \(prereleases and drafts do not count\)/,
  );
  await assert.rejects(readPublicUpdateFeed({ feed, fetch: pages({ [`${base}/latest`]: "<html>" }).fetch }), /has no latest release/);
  await assert.rejects(readPublicUpdateFeed({ feed, fetch: pages({ [`${base}.atom`]: "<feed></feed>" }).fetch }), /has no releases or tags/);
  await assert.rejects(
    readPublicUpdateFeed({ feed, fetch: pages({ [`${base}/latest`]: JSON.stringify({ tag_name: "linux-test-0.1.5" }) }).fetch }),
    /serves linux-test-0\.1\.5 as its latest release, and it has no latest-mac\.yml/,
  );
  await assert.rejects(
    readPublicUpdateFeed({ feed, fetch: pages({ [`${base}/download/v0.1.5/latest-mac.yml`]: "files: []\n" }).fetch }),
    /names no version or update archive/,
  );
});

test("the updater takes its feed from the packaged app and ignores prereleases", () => {
  const updater = read("desktop/src/updater.ts");
  assert.doesNotMatch(updater, /setFeedURL|amplefile-mac-releases|Mat-Tom-Son/, "nothing at run time names a feed");
  assert.match(updater, /this\.updater\.allowPrerelease = false;/, "so prereleases in the source repository are never offered");
  assert.match(updater, /this\.updater\.allowDowngrade = false;/);
});

test("download links and policy text name the feeds of the checked-in stage", () => {
  const feed = resolveMacReleaseFeed(identity, {});
  const other = feed.downloads.slug === sourceSlug ? separateSlug : sourceSlug;
  const latest = (slug: string) => `https://github.com/${slug}/releases/latest`;

  const readme = read("README.md");
  assert.ok(readme.includes(latest(feed.downloads.slug)), "README download links open the download feed's latest release");
  assert.ok(!readme.includes(latest(other)), "and not the other repository's");

  const page = read("site/public/index.html");
  assert.ok(page.includes(latest(feed.downloads.slug)), "the built site was rebuilt for this stage (npm run site:build)");
  assert.ok(page.includes(`https://api.github.com/repos/${feed.downloads.slug}/releases/latest`));
  assert.ok(!page.includes(latest(other)) && !page.includes(`api.github.com/repos/${other}/releases`));

  // What an installed copy contacts, and where public releases are published.
  assert.ok(read("PRIVACY.md").includes(`\`${feed.packaged.slug}\` feed`), "PRIVACY.md names the feed installed copies check");
  const security = read("SECURITY.md");
  for (const target of feed.targets) assert.ok(security.includes(`\`${target.slug}\``), `SECURITY.md names ${target.slug} as a release feed`);

  // Every place that states the checked-in stage.
  const stated = new RegExp(`checked-in stage is\\s+\`${feed.stage}\``);
  for (const document of ["docs/macos-release.md", "docs/macos-build.md", "AGENTS.md", ".agents/skills/ship-macos-release/SKILL.md"]) {
    const text = read(document);
    assert.match(text, stated, `${document} states the checked-in stage`);
    for (const stage of MAC_UPDATE_FEED_STAGES) {
      if (stage !== feed.stage) assert.doesNotMatch(text, new RegExp(`checked-in stage is\\s+\`${stage}\``), `${document} does not also state ${stage}`);
    }
  }
  assert.match(
    read("docs/website.md"),
    new RegExp(`Download links open the latest release in\\s+\`${feed.downloads.slug}\``),
    "docs/website.md names the repository download links open",
  );
});

function read(path: string): string {
  return readFileSync(join(rootDir, path), "utf8");
}
