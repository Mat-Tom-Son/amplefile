import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import feedModule from "../scripts/mac-release-feed.cjs";
import {
  assertTaggedFeedStage,
  createGitHubReleases,
  publishMacRelease,
  releaseManifestFeedFailures,
} from "../scripts/mac-release-publication.mjs";
import { assertCompatibleReleaseState } from "../scripts/mac-release-state.mjs";

// The publisher's whole GitHub sequence, driven against a stand-in for
// GitHub that answers the exact `gh` commands the publisher runs.

const { resolveMacReleaseFeed } = feedModule;
const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const sourceSlug = "Mat-Tom-Son/amplefile";
const separateSlug = "Mat-Tom-Son/amplefile-mac-releases";
const manifestName = "AmpleFile-mac-release-manifest.json";

type Stage = "separate-repository" | "bridge" | "source-repository";
type FakeAsset = { name: string; size: number; digest: string; content: string };
type FakeRelease = {
  tagName: string; isDraft: boolean; isPrerelease: boolean; title: string; notes: string;
  verifyTag: boolean; target: string | null; assets: FakeAsset[];
};
type FakeRepository = { isPrivate: boolean; tags: Set<string>; releases: FakeRelease[]; latest: string | null; keepsLatest: boolean };

function feedAt(stage: Stage) {
  return resolveMacReleaseFeed({ ...identity, macUpdateFeedStage: stage }, {});
}

class FakeGitHub {
  readonly repositories = new Map<string, FakeRepository>();
  readonly calls: string[][] = [];
  /** Return the error text a command should fail with, or null to let it run. */
  failure: (args: string[]) => string | null = () => null;

  constructor() {
    // The live state before the move: 0.1.4 in the separate repository, and
    // the source repository holding its tags and a Linux preview prerelease.
    this.add(separateSlug, ["v0.1.4"]);
    this.seedMacRelease(separateSlug, "v0.1.4", separateSlug);
    this.add(sourceSlug, ["v0.1.4", "linux-test-0.1.4"]);
    this.repository(sourceSlug).releases.push({
      tagName: "linux-test-0.1.4", isDraft: false, isPrerelease: true, title: "Linux Preview", notes: "", verifyTag: false, target: "main",
      assets: [asset("SHA256SUMS", "linux")],
    });
  }

  add(slug: string, tags: string[] = []): FakeRepository {
    const repository = { isPrivate: false, tags: new Set(tags), releases: [], latest: null, keepsLatest: false };
    this.repositories.set(slug, repository);
    return repository;
  }

  repository(slug: string): FakeRepository {
    const repository = this.repositories.get(slug);
    assert.ok(repository, `unknown repository ${slug}`);
    return repository;
  }

  /** A published Mac release whose manifest says which feed its packaged app checks. */
  seedMacRelease(slug: string, tag: string, feedSlug: string | null): void {
    const [owner, repo] = (feedSlug ?? "/").split("/");
    const repository = this.repository(slug);
    repository.tags.add(tag);
    repository.releases.push({
      tagName: tag, isDraft: false, isPrerelease: false, title: tag, notes: "", verifyTag: false, target: "main",
      assets: feedSlug ? [asset(manifestName, JSON.stringify({ feed: { owner, repo } }))] : [asset("notes.txt", "no manifest")],
    });
    repository.latest = tag;
  }

  release(slug: string, tag: string): FakeRelease | undefined {
    return this.repository(slug).releases.find((release) => release.tagName === tag);
  }

  deleteRelease(slug: string, tag: string): void {
    const repository = this.repository(slug);
    repository.releases = repository.releases.filter((release) => release.tagName !== tag);
  }

  /** The commands that change GitHub, as `<verb> <tag> <repository>`. */
  changes(): string[] {
    return this.calls
      .filter((args) => args[0] === "release" && (args[1] === "create" || args[1] === "edit"))
      .map((args) => `${args[1]} ${args[2]} ${option(args, "--repo")}`);
  }

  readonly run = (args: string[]): { status: number; stdout: string; stderr: string } => {
    this.calls.push(args);
    const failed = this.failure(args);
    if (failed) return { status: 1, stdout: "", stderr: failed };
    try {
      return { status: 0, stdout: this.answer(args), stderr: "" };
    } catch (error) {
      return { status: 1, stdout: "", stderr: (error as Error).message };
    }
  };

  private answer(args: string[]): string {
    const [command, verb] = args;
    if (command === "repo" && verb === "view") {
      const repository = this.repositories.get(args[2]!);
      if (!repository) throw new Error("GraphQL: Could not resolve to a Repository");
      return JSON.stringify({ isPrivate: repository.isPrivate, visibility: repository.isPrivate ? "PRIVATE" : "PUBLIC", url: `https://github.com/${args[2]}` });
    }
    if (command === "api") {
      const list = /^repos\/(.+)\/releases\?per_page=100$/.exec(verb!);
      if (list) {
        assert.deepEqual(args.slice(2), ["--paginate", "--slurp"]);
        // One page per two releases, as --slurp returns them.
        const releases = this.repository(list[1]!).releases.map((release) => ({
          tag_name: release.tagName, draft: release.isDraft, prerelease: release.isPrerelease, assets: release.assets.map(({ name }) => ({ name })),
        }));
        return JSON.stringify([releases.slice(0, 2), releases.slice(2)]);
      }
      const match = /^repos\/(.+)\/releases\/latest$/.exec(verb!);
      assert.ok(match, `unexpected api call ${verb}`);
      const repository = this.repository(match[1]!);
      const latest = repository.releases.find((release) => release.tagName === repository.latest && !release.isDraft && !release.isPrerelease);
      if (!latest) throw new Error("gh: Not Found (HTTP 404)");
      return JSON.stringify({ tag_name: latest.tagName, assets: latest.assets.map(({ name }) => ({ name })) });
    }
    assert.equal(command, "release", `unexpected gh command ${args.join(" ")}`);
    const tag = args[2]!;
    const slug = option(args, "--repo");
    const repository = this.repository(slug);
    const existing = repository.releases.find((release) => release.tagName === tag);
    if (verb === "view") {
      if (!existing) throw new Error("release not found");
      return JSON.stringify({
        tagName: existing.tagName, isDraft: existing.isDraft, isPrerelease: existing.isPrerelease,
        url: `https://github.com/${slug}/releases/tag/${tag}`,
        assets: existing.assets.map(({ name, size, digest }) => ({ name, size, digest })),
      });
    }
    if (verb === "download") {
      const found = existing?.assets.find(({ name }) => name === option(args, "--pattern"));
      if (!found) throw new Error("no assets match the file pattern");
      return found.content;
    }
    if (verb === "create") {
      const verifyTag = args.includes("--verify-tag");
      if (verifyTag && !repository.tags.has(tag)) throw new Error(`tag ${tag} doesn't exist in the repo ${slug}, aborting due to --verify-tag flag`);
      if (existing) throw new Error("a release with the same tag name already exists");
      assert.ok(args.includes("--draft"), "the publisher only ever creates drafts");
      repository.releases.push({
        tagName: tag, isDraft: true, isPrerelease: false, title: option(args, "--title"), notes: option(args, "--notes"),
        verifyTag, target: args.includes("--target") ? option(args, "--target") : null,
        assets: args.slice(args.indexOf("--draft") + 1).map((path) => asset(path.split("/").pop()!, readFileSync(path, "utf8"))),
      });
      return `https://github.com/${slug}/releases/tag/untagged-draft`;
    }
    if (verb === "edit") {
      assert.deepEqual(args.slice(5), ["--draft=false", "--latest"]);
      if (!existing) throw new Error("release not found");
      existing.isDraft = false;
      // Publishing creates a lightweight tag only where none exists.
      repository.tags.add(tag);
      if (!repository.keepsLatest) repository.latest = tag;
      return "";
    }
    throw new Error(`unexpected gh command ${args.join(" ")}`);
  }
}

function asset(name: string, content: string): FakeAsset {
  return { name, content, size: Buffer.byteLength(content), digest: `sha256:${createHash("sha256").update(content).digest("hex")}` };
}

function option(args: string[], name: string): string {
  return args[args.indexOf(name) + 1]!;
}

/** A built release on disk, and one publisher run against the stand-in. */
function candidate(stage: Stage, version: string) {
  const feed = feedAt(stage);
  const directory = mkdtempSync(join(tmpdir(), "amplefile-publisher-"));
  const files: Record<string, string> = {
    [`AmpleFile-${version}-mac-arm64.zip`]: `zip ${version}`,
    "latest-mac.yml": `version: ${version}\npath: AmpleFile-${version}-mac-arm64.zip\n`,
    [manifestName]: JSON.stringify({
      version,
      feed: { owner: feed.packaged.owner, repo: feed.packaged.repo },
      feedStage: feed.stage,
      publishTargets: feed.targets.map(({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo })),
    }),
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
  const events: string[] = [];
  return {
    feed,
    events,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    publish: (github: FakeGitHub, overrides: Record<string, unknown> = {}) => publishMacRelease({
      feed,
      version,
      productName: "AmpleFile",
      arch: "arm64",
      teamId: "464JD5K8DC",
      assets: Object.keys(files).map((name) => ({ name, path: join(directory, name) })),
      github: createGitHubReleases({ run: github.run, manifestName }),
      beforePublic: async () => { events.push(`recheck before ${github.changes().at(-1)}`); },
      afterSourcePublication: async () => { events.push("source tag rechecked"); },
      log: (message: string) => { events.push(message); },
      ...overrides,
    }),
  };
}

test("at the checked-in stage a release goes to the separate repository alone, as 0.1.4 did", async () => {
  const github = new FakeGitHub();
  const release = candidate("separate-repository", "0.1.5");
  try {
    const result = await release.publish(github);
    assert.equal(result.published.slug, separateSlug);
    assert.equal(result.remaining, null);
    assert.deepEqual(github.changes(), [`create v0.1.5 ${separateSlug}`, `edit v0.1.5 ${separateSlug}`], "the source repository is only read");
    const create = github.calls.find((args) => args[1] === "create")!;
    assert.deepEqual(create.slice(0, 12), [
      "release", "create", "v0.1.5", "--repo", separateSlug, "--target", "main",
      "--title", "AmpleFile 0.1.5 for macOS",
      "--notes", [
        "AmpleFile 0.1.5 for macOS",
        "",
        "Signed with Apple Team ID 464JD5K8DC, notarized by Apple, and published for arm64.",
        "Use the DMG for a first install. Existing updater-capable Mac installs consume the ZIP and latest-mac.yml assets.",
      ].join("\n"),
      "--draft",
    ]);
    assert.deepEqual(github.calls.find((args) => args[1] === "edit"), ["release", "edit", "v0.1.5", "--repo", separateSlug, "--draft=false", "--latest"]);
    assert.ok(release.events.includes(`recheck before create v0.1.5 ${separateSlug}`), "source and build are rechecked after upload, before the draft is public");
    assert.ok(!release.events.includes("source tag rechecked"));
    assert.equal(github.repository(separateSlug).latest, "v0.1.5");
    assert.equal(github.release(sourceSlug, "v0.1.5"), undefined);
  } finally {
    release.cleanup();
  }
});

test("the bridge's first run publishes to the source repository and stops; the second publishes to the separate one", async () => {
  const github = new FakeGitHub();
  github.repository(sourceSlug).tags.add("v0.1.5");
  const tagsBefore = [...github.repository(sourceSlug).tags];
  const release = candidate("bridge", "0.1.5");
  try {
    const first = await release.publish(github);
    assert.equal(first.published.slug, sourceSlug);
    assert.equal(first.remaining.slug, separateSlug, "the caller is told a feed is still waiting");
    assert.deepEqual(github.changes(), [`create v0.1.5 ${sourceSlug}`, `edit v0.1.5 ${sourceSlug}`]);
    assert.equal(github.release(separateSlug, "v0.1.5"), undefined, "not even a draft reaches the separate repository");
    assert.equal(github.repository(separateSlug).latest, "v0.1.4", "installed copies are offered nothing new");
    const inSource = github.release(sourceSlug, "v0.1.5")!;
    assert.equal(inSource.verifyTag, true, "the release attached to the existing annotated tag");
    assert.equal(inSource.target, null);
    assert.deepEqual([...github.repository(sourceSlug).tags], tagsBefore, "no tag was created in the source repository");
    assert.equal(github.repository(sourceSlug).latest, "v0.1.5", "the Linux prerelease does not hold latest");
    assert.deepEqual(
      release.events.filter((event) => /recheck|Published/.test(event)),
      [`recheck before create v0.1.5 ${sourceSlug}`, "source tag rechecked", `Published https://github.com/${sourceSlug}/releases/tag/v0.1.5`],
      "the annotated tag is checked again once the release is public",
    );

    release.events.length = 0;
    const second = await release.publish(github);
    assert.equal(second.published.slug, separateSlug);
    assert.equal(second.remaining, null);
    assert.deepEqual(github.changes().slice(2), [`create v0.1.5 ${separateSlug}`, `edit v0.1.5 ${separateSlug}`], "the source repository is not touched again");
    assert.ok(release.events.includes(`${sourceSlug} already serves v0.1.5 with identical assets.`));
    assert.ok(!release.events.includes("source tag rechecked"));
    const inSeparate = github.release(separateSlug, "v0.1.5")!;
    assert.equal(inSeparate.target, "main");
    assert.match(inSeparate.notes, /This is the last release published here\./);
    assert.doesNotMatch(inSource.notes, /last release/);
    assert.equal(github.repository(separateSlug).latest, "v0.1.5");

    await assert.rejects(release.publish(github), /v0\.1\.5 is already published to Mat-Tom-Son\/amplefile and Mat-Tom-Son\/amplefile-mac-releases/);
    assert.equal(github.changes().length, 4);
  } finally {
    release.cleanup();
  }
});

test("the second run refuses unless the source repository still serves the bridge as latest", async () => {
  const github = new FakeGitHub();
  github.repository(sourceSlug).tags.add("v0.1.5");
  const release = candidate("bridge", "0.1.5");
  const remedy = /Mark v0\.1\.5 latest again in Mat-Tom-Son\/amplefile \(gh release edit v0\.1\.5 --repo Mat-Tom-Son\/amplefile --latest\), then run the publisher again/;
  try {
    await release.publish(github);
    const afterFirstRun = github.changes().length;

    // Another release took "latest" during the pause.
    github.seedMacRelease(sourceSlug, "linux-1.0.0", null);
    await assert.rejects(
      release.publish(github),
      /Mat-Tom-Son\/amplefile serves linux-1\.0\.0 as its latest release, not v0\.1\.5\. Copies that take v0\.1\.5 from Mat-Tom-Son\/amplefile-mac-releases check Mat-Tom-Son\/amplefile and would fail their update check/,
    );
    await assert.rejects(release.publish(github), remedy);

    // No release is latest at all: the bridge was unmarked, or made a prerelease and back.
    github.repository(sourceSlug).latest = null;
    await assert.rejects(release.publish(github), /Mat-Tom-Son\/amplefile serves no release as its latest release, not v0\.1\.5/);

    // An older Mac release marked latest again is no better.
    github.seedMacRelease(sourceSlug, "v0.1.3", sourceSlug);
    await assert.rejects(release.publish(github), /serves v0\.1\.3 as its latest release, not v0\.1\.5/);

    assert.equal(github.changes().length, afterFirstRun, "nothing was drafted or published in the separate repository");
    assert.equal(github.release(separateSlug, "v0.1.5"), undefined);
    assert.equal(github.repository(separateSlug).latest, "v0.1.4");

    // Marked latest again, the second run goes through.
    github.repository(sourceSlug).latest = "v0.1.5";
    assert.equal((await release.publish(github)).published.slug, separateSlug);
  } finally {
    release.cleanup();
  }
});

test("the bridge is not made public in the separate repository if latest moved during the upload", async () => {
  const github = new FakeGitHub();
  github.repository(sourceSlug).tags.add("v0.1.5");
  const release = candidate("bridge", "0.1.5");
  try {
    await release.publish(github);
    // The stand-in loses "latest" in the source repository while the separate repository's draft uploads.
    github.failure = (args) => {
      if (args[1] === "create" && option(args, "--repo") === separateSlug) github.repository(sourceSlug).latest = null;
      return null;
    };
    await assert.rejects(release.publish(github), /Mat-Tom-Son\/amplefile serves no release as its latest release, not v0\.1\.5/);
    assert.equal(github.release(separateSlug, "v0.1.5")!.isDraft, true, "the upload stays a draft");
    assert.equal(github.repository(separateSlug).latest, "v0.1.4");
    assert.ok(!github.changes().includes(`edit v0.1.5 ${separateSlug}`));
  } finally {
    release.cleanup();
  }
});

test("a run stopped between drafting and publishing leaves a draft the rerun refuses until it is deleted", async () => {
  const github = new FakeGitHub();
  github.repository(sourceSlug).tags.add("v0.1.5");
  const release = candidate("bridge", "0.1.5");
  const stopAtPublish = (slug: string) => (args: string[]) => args[1] === "edit" && option(args, "--repo") === slug ? "HTTP 502: Bad Gateway" : null;
  try {
    // First run, source repository.
    github.failure = stopAtPublish(sourceSlug);
    await assert.rejects(release.publish(github), /Could not publish AmpleFile macOS release v0\.1\.5 in Mat-Tom-Son\/amplefile: HTTP 502/);
    assert.equal(github.release(sourceSlug, "v0.1.5")!.isDraft, true);
    assert.equal(github.release(separateSlug, "v0.1.5"), undefined, "no draft in the separate repository before the source repository is published");
    github.failure = () => null;
    await assert.rejects(release.publish(github), /Mat-Tom-Son\/amplefile already contains v0\.1\.5 as a draft\. Delete only a failed draft/);
    github.deleteRelease(sourceSlug, "v0.1.5");
    assert.equal((await release.publish(github)).published.slug, sourceSlug);

    // Second run, separate repository.
    github.failure = stopAtPublish(separateSlug);
    await assert.rejects(release.publish(github), /Could not publish AmpleFile macOS release v0\.1\.5 in Mat-Tom-Son\/amplefile-mac-releases/);
    assert.equal(github.release(separateSlug, "v0.1.5")!.isDraft, true);
    assert.equal(github.repository(separateSlug).latest, "v0.1.4", "a draft is offered to no one");
    github.failure = () => null;
    await assert.rejects(release.publish(github), /Mat-Tom-Son\/amplefile-mac-releases already contains v0\.1\.5 as a draft/);
    github.deleteRelease(separateSlug, "v0.1.5");
    const finished = await release.publish(github);
    assert.equal(finished.published.slug, separateSlug);
    assert.equal(finished.remaining, null);
  } finally {
    release.cleanup();
  }
});

test("nothing becomes public when the source or build changed during upload", async () => {
  const github = new FakeGitHub();
  github.repository(sourceSlug).tags.add("v0.1.5");
  const release = candidate("bridge", "0.1.5");
  try {
    await assert.rejects(
      release.publish(github, { beforePublic: async () => { throw new Error("Release source changed during upload. The release remains a draft."); } }),
      /The release remains a draft/,
    );
    assert.deepEqual(github.changes(), [`create v0.1.5 ${sourceSlug}`]);
    assert.equal(github.release(sourceSlug, "v0.1.5")!.isDraft, true);
    assert.equal(github.repository(sourceSlug).latest, null);
  } finally {
    release.cleanup();
  }
});

test("a feed counts as serving the release only when it holds these exact bytes", async () => {
  const github = new FakeGitHub();
  github.repository(sourceSlug).tags.add("v0.1.5");
  const release = candidate("bridge", "0.1.5");
  try {
    await release.publish(github);
    const zip = github.release(sourceSlug, "v0.1.5")!.assets.find(({ name }) => name.endsWith(".zip"))!;
    const digest = zip.digest;
    zip.digest = `sha256:${"0".repeat(64)}`;
    await assert.rejects(release.publish(github), /AmpleFile-0\.1\.5-mac-arm64\.zip has remote digest sha256:0+ in Mat-Tom-Son\/amplefile; expected sha256:/);
    zip.digest = digest;
    zip.size += 1;
    await assert.rejects(release.publish(github), /is \d+ bytes in Mat-Tom-Son\/amplefile but \d+ bytes locally/);
    zip.size -= 1;
    github.release(sourceSlug, "v0.1.5")!.assets.pop();
    await assert.rejects(release.publish(github), /in Mat-Tom-Son\/amplefile is missing AmpleFile-mac-release-manifest\.json/);
    assert.equal(github.release(separateSlug, "v0.1.5"), undefined);
    assert.equal(github.changes().length, 2, "nothing was created or published after the first run");
  } finally {
    release.cleanup();
  }
});

test("the source repository must already hold the tag, and a private feed is refused", async () => {
  const github = new FakeGitHub();
  const release = candidate("bridge", "0.1.5");
  try {
    await assert.rejects(release.publish(github), /Could not create draft AmpleFile macOS release v0\.1\.5 in Mat-Tom-Son\/amplefile: tag v0\.1\.5 doesn't exist/);
    assert.equal(github.release(sourceSlug, "v0.1.5"), undefined);
    assert.ok(!github.repository(sourceSlug).tags.has("v0.1.5"), "the publisher does not create the source tag");

    github.repository(separateSlug).isPrivate = true;
    await assert.rejects(release.publish(github), /Mat-Tom-Son\/amplefile-mac-releases must be public so installed AmpleFile apps can update/);
    github.repositories.delete(separateSlug);
    await assert.rejects(release.publish(github), /Mac release feed Mat-Tom-Son\/amplefile-mac-releases was not found/);
  } finally {
    release.cleanup();
  }
});

test("a release GitHub does not serve as latest fails the run that published it", async () => {
  const github = new FakeGitHub();
  github.repository(sourceSlug).tags.add("v0.1.5");
  github.repository(sourceSlug).keepsLatest = true;
  const release = candidate("bridge", "0.1.5");
  try {
    await assert.rejects(
      release.publish(github),
      /Mat-Tom-Son\/amplefile serves no release as its latest release, not v0\.1\.5\. Installed copies will not be offered v0\.1\.5 until it is marked latest \(gh release edit v0\.1\.5 --repo Mat-Tom-Son\/amplefile --latest\)/,
    );
  } finally {
    release.cleanup();
  }
});

test("after the bridge, releases go to the source repository alone, and never before it", async () => {
  const github = new FakeGitHub();
  github.repository(sourceSlug).tags.add("v0.1.5").add("v0.1.6");
  const next = candidate("source-repository", "0.1.6");
  const bridge = candidate("bridge", "0.1.5");
  try {
    await assert.rejects(next.publish(github), /Copies installed from Mat-Tom-Son\/amplefile-mac-releases still check it.*Publish the bridge release first/);
    await bridge.publish(github);
    await assert.rejects(next.publish(github), /still check it: its latest release v0\.1\.4/, "the bridge is not finished until the separate repository serves it");
    await bridge.publish(github);
    assert.deepEqual(github.changes().filter((change) => change.includes("v0.1.6")), [], "the refusals changed nothing");

    const result = await next.publish(github);
    assert.equal(result.published.slug, sourceSlug);
    assert.equal(result.remaining, null);
    assert.deepEqual(github.changes().slice(4), [`create v0.1.6 ${sourceSlug}`, `edit v0.1.6 ${sourceSlug}`]);
    assert.equal(github.repository(sourceSlug).latest, "v0.1.6");
    assert.equal(github.repository(separateSlug).latest, "v0.1.5", "the separate repository keeps the bridge as its last release");

    // Back at the first stage, the bridge in the separate repository closes it.
    const stale = candidate("separate-repository", "0.1.7");
    try {
      await assert.rejects(stale.publish(github), /ends with the bridge release v0\.1\.5/);
    } finally {
      stale.cleanup();
    }
  } finally {
    next.cleanup();
    bridge.cleanup();
  }
});

test("a failed lookup of the existing release stops the run before anything is uploaded", async () => {
  const github = new FakeGitHub();
  github.repository(sourceSlug).tags.add("v0.1.5");
  github.failure = (args) => args[0] === "release" && args[1] === "view" ? "HTTP 503: Service Unavailable" : null;
  const release = candidate("bridge", "0.1.5");
  try {
    await assert.rejects(release.publish(github), /Could not tell whether Mat-Tom-Son\/amplefile already has a release for v0\.1\.5: HTTP 503/);
    assert.deepEqual(github.changes(), []);
  } finally {
    release.cleanup();
  }
});

test("the separate repository stays closed when its bridge is no longer latest or reached only the source repository", async () => {
  // Someone marked 0.1.4 latest again after the bridge.
  const reverted = new FakeGitHub();
  reverted.seedMacRelease(separateSlug, "v0.1.5", sourceSlug);
  reverted.seedMacRelease(sourceSlug, "v0.1.5", sourceSlug);
  reverted.repository(separateSlug).latest = "v0.1.4";
  reverted.repository(sourceSlug).latest = null;
  const release = candidate("separate-repository", "0.1.6");
  try {
    await assert.rejects(
      release.publish(reverted),
      /Mat-Tom-Son\/amplefile-mac-releases holds the bridge release v0\.1\.5, although it is not its latest release: copies installed from it check Mat-Tom-Son\/amplefile and would never see v0\.1\.6/,
    );
    assert.deepEqual(reverted.changes(), []);

    // The bridge is public in the source repository and was abandoned before its second run.
    const abandoned = new FakeGitHub();
    abandoned.seedMacRelease(sourceSlug, "v0.1.5", sourceSlug);
    await assert.rejects(
      release.publish(abandoned),
      /Mat-Tom-Son\/amplefile already serves the Mac release v0\.1\.5, and copies installed from it check Mat-Tom-Son\/amplefile: they would never see v0\.1\.6 in Mat-Tom-Son\/amplefile-mac-releases\. Finish the move with the bridge stage/,
    );
    assert.deepEqual(abandoned.changes(), []);

    // A latest release there that is not a Mac release is no bridge.
    const linux = new FakeGitHub();
    linux.seedMacRelease(sourceSlug, "linux-0.1.5", null);
    assert.equal((await release.publish(linux)).published.slug, separateSlug);
  } finally {
    release.cleanup();
  }
});

test("every published release in a repository is listed with the feed its copies check", () => {
  const github = new FakeGitHub();
  for (const tag of ["v0.1.1", "v0.1.2", "v0.1.3"]) github.seedMacRelease(separateSlug, tag, separateSlug);
  github.seedMacRelease(separateSlug, "v0.1.5", sourceSlug);
  github.repository(separateSlug).releases.push({
    tagName: "v0.1.6", isDraft: true, isPrerelease: false, title: "", notes: "", verifyTag: false, target: "main", assets: [],
  });
  const client = createGitHubReleases({ run: github.run, manifestName });
  const separateFeed = { owner: "Mat-Tom-Son", repo: "amplefile-mac-releases" };
  assert.deepEqual(client.publishedReleases(feedAt("bridge").separate), [
    { tag: "v0.1.4", feed: separateFeed },
    { tag: "v0.1.1", feed: separateFeed },
    { tag: "v0.1.2", feed: separateFeed },
    { tag: "v0.1.3", feed: separateFeed },
    { tag: "v0.1.5", feed: { owner: "Mat-Tom-Son", repo: "amplefile" } },
  ], "across pages, without the draft");
  assert.deepEqual(client.publishedReleases(feedAt("bridge").source), [{ tag: "linux-test-0.1.4", feed: null }]);
});

test("the latest release and its feed are read from GitHub, not assumed", () => {
  const github = new FakeGitHub();
  const client = createGitHubReleases({ run: github.run, manifestName });
  const feed = feedAt("bridge");
  assert.equal(client.latestRelease(feed.source), null, "a repository with only prereleases has no latest release");
  assert.equal(client.latestTag(feed.source), "");
  assert.deepEqual(client.latestRelease(feed.separate), { tag: "v0.1.4", feed: { owner: "Mat-Tom-Son", repo: "amplefile-mac-releases" } });
  assert.equal(client.latestTag(feed.separate), "v0.1.4");

  github.seedMacRelease(sourceSlug, "linux-0.1.5", null);
  assert.deepEqual(client.latestRelease(feed.source), { tag: "linux-0.1.5", feed: null }, "a latest release without the Mac manifest names no feed");

  github.failure = (args) => args[0] === "api" ? "error connecting to api.github.com" : null;
  assert.throws(() => client.latestRelease(feed.separate), /Could not read the latest release in Mat-Tom-Son\/amplefile-mac-releases: error connecting/);

  github.failure = () => null;
  assert.equal(client.existingRelease(feed.source, "v0.1.4"), null, "a bare tag is not a release");
  github.failure = (args) => args[0] === "release" && args[1] === "view" ? "gh: Not Found (HTTP 404)" : null;
  assert.equal(client.existingRelease(feed.separate, "v0.1.4"), null);
  github.failure = (args) => args[0] === "release" && args[1] === "view" ? "error connecting to api.github.com" : null;
  assert.throws(
    () => client.existingRelease(feed.separate, "v0.1.4"),
    /Could not tell whether Mat-Tom-Son\/amplefile-mac-releases already has a release for v0\.1\.4: error connecting/,
    "a failed lookup is not an unused tag",
  );
  github.failure = () => null;
  const existing = client.existingRelease(feed.separate, "v0.1.4");
  assert.deepEqual([existing.tagName, existing.isDraft], ["v0.1.4", false]);
});

test("the strict verifier and the publisher refuse a manifest built for another stage", () => {
  const separate = feedAt("separate-repository");
  const bridge = feedAt("bridge");
  const manifestFor = (feed: ReturnType<typeof feedAt>) => ({
    feed: { owner: feed.packaged.owner, repo: feed.packaged.repo },
    feedStage: feed.stage,
    publishTargets: feed.targets.map(({ owner, repo }: { owner: string; repo: string }) => ({ owner, repo })),
  });
  assert.deepEqual(releaseManifestFeedFailures(manifestFor(separate), separate), []);
  assert.deepEqual(releaseManifestFeedFailures(manifestFor(bridge), bridge), []);

  // 0.1.4's manifest: the feed, and neither stage field.
  assert.deepEqual(releaseManifestFeedFailures({ feed: { owner: "Mat-Tom-Son", repo: "amplefile-mac-releases" } }, separate), [
    "Release manifest feed stage missing does not match separate-repository.",
    "Release manifest publication targets missing do not match Mat-Tom-Son/amplefile-mac-releases.",
  ]);
  assert.deepEqual(releaseManifestFeedFailures(manifestFor(bridge), separate), [
    "Release manifest feed does not match the embedded Mac feed.",
    "Release manifest feed stage bridge does not match separate-repository.",
    "Release manifest publication targets Mat-Tom-Son/amplefile, Mat-Tom-Son/amplefile-mac-releases do not match Mat-Tom-Son/amplefile-mac-releases.",
  ]);
  // Same packaged feed, different stage: a bridge candidate is not a source-repository release.
  assert.deepEqual(releaseManifestFeedFailures(manifestFor(bridge), feedAt("source-repository")), [
    "Release manifest feed stage bridge does not match source-repository.",
    "Release manifest publication targets Mat-Tom-Son/amplefile, Mat-Tom-Son/amplefile-mac-releases do not match Mat-Tom-Son/amplefile.",
  ]);
  assert.equal(releaseManifestFeedFailures({}, separate).length, 3);
  assert.match(readFileSync(join(rootDir, "scripts", "verify-mac-release.mjs"), "utf8"), /failures\.push\(\.\.\.releaseManifestFeedFailures\(manifest, feed\)\);/);
});

test("the stage in use must be the one the release tag records", () => {
  const bridge = feedAt("bridge");
  assertTaggedFeedStage({ feed: bridge, tag: "v0.1.5", taggedIdentity: { macUpdateFeedStage: "bridge" } });
  assert.throws(
    () => assertTaggedFeedStage({ feed: bridge, tag: "v0.1.5", taggedIdentity: { macUpdateFeedStage: "separate-repository" } }),
    /Source tag v0\.1\.5 records the Mac update feed stage separate-repository, but this publication uses bridge/,
  );
  assert.throws(
    () => assertTaggedFeedStage({ feed: bridge, tag: "v0.1.4", taggedIdentity: { productName: "AmpleFile" } }),
    /records the Mac update feed stage \(none\)/,
    "a tag from before the stage existed",
  );
  const publisher = readFileSync(join(rootDir, "scripts", "publish-mac-release.mjs"), "utf8");
  assert.match(publisher, /"show", `\$\{tag\}:src\/shared\/product-identity\.json`/, "read from the tag, not from the working tree");
});

test("a checkpoint built in one stage cannot be resumed or published in another", () => {
  const descriptor = (feed: ReturnType<typeof feedAt>) => ({
    productName: "AmpleFile", version: "0.1.5", arch: "arm64", mode: "release", nodeVersion: "v24.0.0",
    signIdentity: "Developer ID Application: Example (TEAMID)", teamId: "TEAMID",
    feedOwner: feed.packaged.owner, feedRepo: feed.packaged.repo, feedStage: feed.stage,
  });
  const fingerprint = "a".repeat(64);
  const bridge = descriptor(feedAt("bridge"));
  const saved = { descriptor: bridge, fingerprint };
  assertCompatibleReleaseState(saved, bridge, fingerprint);
  // The packaged feed is the same in these two stages; only the stage differs.
  assert.throws(
    () => assertCompatibleReleaseState(saved, descriptor(feedAt("source-repository")), fingerprint),
    /belongs to release 0\.1\.5 arm64 checking Mat-Tom-Son\/amplefile at the bridge stage, not release 0\.1\.5 arm64 checking Mat-Tom-Son\/amplefile at the source-repository stage \(it differs in feedStage\)\. Run a fresh release build/,
  );
  assert.throws(
    () => assertCompatibleReleaseState(saved, descriptor(feedAt("separate-repository")), fingerprint),
    /at the bridge stage, not release 0\.1\.5 arm64 checking Mat-Tom-Son\/amplefile-mac-releases at the separate-repository stage \(it differs in feedRepo, feedStage\)/,
  );
  // A checkpoint from before the stage existed.
  const { feedStage: _feedStage, ...before } = descriptor(feedAt("separate-repository"));
  assert.throws(
    () => assertCompatibleReleaseState({ descriptor: before, fingerprint }, descriptor(feedAt("separate-repository")), fingerprint),
    /checking Mat-Tom-Son\/amplefile-mac-releases at the unrecorded stage, not .* at the separate-repository stage \(it differs in feedStage\)/,
  );
  assert.throws(
    () => assertCompatibleReleaseState(saved, { ...bridge, nodeVersion: "v24.1.0" }, fingerprint),
    /\(it differs in nodeVersion\)/,
    "two descriptions that read the same still say what differs",
  );
});

test("a signed build refuses an overridden stage before it signs anything", { skip: process.platform !== "darwin" }, () => {
  // An unsupported architecture stops the script right after the stage
  // check, so neither half of this test can reach a build.
  const build = (stage: string) => spawnSync(process.execPath, [join(rootDir, "scripts", "build-mac-desktop.mjs"), "--release", "--arch", "bogus"], {
    cwd: rootDir,
    env: { ...process.env, AMPLEFILE_MAC_UPDATE_FEED_STAGE: stage },
    encoding: "utf8",
    timeout: 60_000,
  });
  const other = identity.macUpdateFeedStage === "bridge" ? "source-repository" : "bridge";
  const overridden = build(other);
  assert.notEqual(overridden.status, 0);
  assert.match(overridden.stderr, new RegExp(`uses the Mac update feed stage ${other}, but the release source records ${identity.macUpdateFeedStage}`));
  const checkedIn = build(identity.macUpdateFeedStage);
  assert.notEqual(checkedIn.status, 0);
  assert.match(checkedIn.stderr, /Unsupported macOS architecture: bogus/, "the checked-in stage passes the check");

  // The ad hoc lane keeps the override, for inspecting a candidate's packaged feed.
  const smoke = spawnSync(process.execPath, [join(rootDir, "scripts", "build-mac-desktop.mjs"), "--unsigned-smoke", "--arch", "bogus"], {
    cwd: rootDir, env: { ...process.env, AMPLEFILE_MAC_UPDATE_FEED_STAGE: other }, encoding: "utf8", timeout: 60_000,
  });
  assert.match(smoke.stderr, /Unsupported macOS architecture: bogus/);
});
