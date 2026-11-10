# macOS release runbook

This runbook publishes the Apple-silicon AmpleFile desktop release. Releases are published to the separate public feed at [`Mat-Tom-Son/amplefile-mac-releases`](https://github.com/Mat-Tom-Son/amplefile-mac-releases), which is also the feed every installed copy checks. Source and release tags live in [`Mat-Tom-Son/amplefile`](https://github.com/Mat-Tom-Son/amplefile).

The release tooling can also move the feed to GitHub Releases in the source repository. That move has not started; [Update feed](#update-feed) describes the stages and [Moving the feed to the source repository](#moving-the-feed-to-the-source-repository) is the procedure.

## One-time workstation setup

1. Install the `Developer ID Application: James Thompson (464JD5K8DC)` certificate and private key in the login Keychain.
2. Store notarization credentials with `xcrun notarytool store-credentials`. The release workstation's profile is `kai-workspace-notary`; a profile name is only a local label.
3. Create ignored `.env.macos.local` using the non-secret variable template in [macOS build and release lane](macos-build.md).
4. Confirm `gh auth status` uses the `Mat-Tom-Son` account and that the Mac feed repository is public.

Do not export or commit the certificate, private key, app-specific password, or notary credentials.

## Update feed

An installed copy checks one GitHub repository for updates: the one named in
its own `Contents/Resources/app-update.yml`. Electron Builder writes that file
when it packages the app, from the single `publish` entry in
`electron-builder.desktop.cjs`. Nothing overrides it at run time:
`desktop/src/updater.ts` never sets a feed. The build uploads nothing
(`--publish never`); `scripts/publish-mac-release.mjs` uploads the finished
artifacts with `gh`. So the feed a version checks is fixed when it is built,
and where a release is published is a separate decision.

`scripts/mac-release-feed.cjs` makes both decisions, for the builder
configuration and every release script, from the feed stage:
`macUpdateFeedStage` in `src/shared/product-identity.json`.

| Stage | The packaged app checks | The release is published to |
| --- | --- | --- |
| `separate-repository` | `Mat-Tom-Son/amplefile-mac-releases` | `Mat-Tom-Son/amplefile-mac-releases` |
| `bridge` | `Mat-Tom-Son/amplefile` | `Mat-Tom-Son/amplefile`, then `Mat-Tom-Son/amplefile-mac-releases` |
| `source-repository` | `Mat-Tom-Son/amplefile` | `Mat-Tom-Son/amplefile` |

**The checked-in stage is `separate-repository`.** Every published version,
0.1.0 through 0.1.4, checks `Mat-Tom-Son/amplefile-mac-releases`, and a
release cut from this source is published there alone.

`AMPLEFILE_MAC_RELEASE_OWNER` and `AMPLEFILE_MAC_RELEASE_REPO` name the
separate release repository in every stage; they never select the source
repository. `AMPLEFILE_MAC_UPDATE_FEED_STAGE` overrides the stage for a
candidate build, for example to inspect a bridge's `app-update.yml` from the
ad hoc lane. The publisher refuses an overridden stage: a public release uses
the stage its tagged source records. The build checkpoint and the release
manifest record the stage, the packaged feed (`feed`), and the publication
targets (`publishTargets`), so a candidate built in one stage cannot be
published in another.

### How an installed copy reads a feed

The updater runs with prereleases off. On each check it asks github.com,
anonymously, for the repository's `releases.atom`, then for
`releases/latest`, and downloads `latest-mac.yml` from the release GitHub
marks latest. It offers that version when it is higher than its own.

- Drafts, prereleases, and tags without a release are never offered.
- A repository with no latest release is an error, not "up to date": the
  check ends with "Update check failed." The source repository is in that
  state: its `v<version>` tags have no releases, and its `linux-test-*`
  releases are prereleases.
- Whatever is marked latest is what every copy is offered. A latest release
  without `latest-mac.yml` fails every check. Once copies check the source
  repository, every other release there has to be a prerelease, never the
  latest release: see [Release ownership](#release-ownership).

`npm run desktop:verify:feed:mac` reads a feed the same way and prints the
version an installed copy would be offered. It reads the feed the checkout
packages; `-- --feed <owner>/<repo>` names another, and `-- --version
<version>` fails unless that version is offered.

### What the publisher checks about the feed

Besides the source, receipt, and artifact checks in
[Release procedure](#release-procedure), the publisher refuses a publication
that would leave installed copies on a feed that gets no further release. It
reads the latest release of both repositories and, from that release's
manifest, the feed its copies check.

- In every stage, the version must be higher than the latest release of each
  feed it is published to, each of those feeds must be public, and after
  publication each must serve this release as its latest.
- `separate-repository`: the separate repository's latest release must check
  the separate repository. Once a bridge is published, nothing more is
  published this way: the publisher refuses when any release in the
  separate repository names the source repository, latest or not, and when
  the source repository already serves a Mac release that checks it.
- `bridge`: the separate repository must have a release to bridge from. A
  run publishes to one feed. The first run publishes to the source
  repository, which nothing reads until a bridged copy is installed, and
  stops, saying what to check. Only a later run, which finds the identical
  release already served there, publishes to the separate repository; until
  then nothing, not even a draft, is created in it. That later run also
  requires the source repository to serve the bridge as its latest release,
  before the upload and again immediately before publication: if another
  release took "latest" during the pause, it refuses and says to mark the
  bridge latest again. A second bridge needs
  `AMPLEFILE_MAC_REPLACE_BRIDGE=v<bridge version>`, naming the bridge it
  replaces.
- `source-repository`: the separate repository's latest release must already
  check the source repository, and the source repository must already serve
  a Mac release. A release that skips the bridge is refused.
- In the source repository, the release attaches to the annotated
  `v<version>` tag that already exists: the draft is created with
  `--verify-tag` and no target, so GitHub cannot create a tag, and the
  publisher confirms afterwards that the annotated tag object is the one it
  verified before upload. The separate release repository has no source
  history; GitHub creates a lightweight `v<version>` tag on its `main` when
  the draft is published.
- A feed that already serves the identical assets is verified and skipped.
  A draft left behind by an interrupted run is refused until it is deleted,
  in either repository.

## Release workflow and checkpoints

Use `npm run desktop:rc:mac` for ordinary packaged interaction testing. It
Developer ID-signs and notarizes only the app under `out/mac-rc`, avoiding DMG
and ZIP compression, the second Apple notarization wait, and publication. It is
not updater evidence because unpacked Electron Builder output does not contain
the release updater metadata.

The full distribution lane records these timed stages under ignored `out/`:

1. desktop preparation;
2. app packaging, Developer ID signing, app notarization, DMG/ZIP creation;
3. packaged-asset verification;
4. DMG signing, notarization, stapling, and updater-metadata refresh;
5. release-manifest generation;
6. strict application, DMG, updater, manifest, and checksum verification.

The build checkpoint is a recovery aid. Resume validates its source/configuration
fingerprint, non-secret release environment, signed app, and artifact receipts.
The separate local verification receipt records a successful full check of the
exact release SHA. Publication requires both, along with canonical pushed
`main` and its matching annotated source tag, before upload and again immediately
before publishing the draft. It independently runs strict artifact verification.
These requirements also apply to direct publisher invocation. Never commit or
hand-edit either receipt.

For a routine release, finish review, fixes, versioning, and release notes,
merge to `main`, and run local verification on the final exact commit before
building. An identical tree at a different SHA does not inherit the local
check receipt. Do not edit source or run dependency installs during packaging.
The full signed build requires successful local verification before starting.
Only a compatible `:resume` checkpoint from after the current receipt completed
may preserve signing and notarization. A fresh check reinstalls dependencies
and requires a subsequent fresh distribution build. The same Node/npm versions
and dependency state must remain in place; hidden lockfile hashes detect
ordinary dependency changes. A shared per-worktree lock serializes local
checks, all macOS builds, and publication to prevent preparation or installs
from racing packaging. The app-only RC lane needs no receipt, but holds the same lock for preparation.
This is a record from a trusted release workstation, not a tamper-resistant
attestation: hidden lockfiles detect ordinary npm installation drift, not manual
edits to installed package files. Do not edit installed dependencies between
verification and packaging.
GitHub Actions is off in the source repository; publication uses the local
receipt and checks source identity directly. Release-tooling-only changes need
focused regression tests and normal local checks, not a version bump or an
Apple submission.

## Release record

- **0.1.0**, the first public AmpleFile release, was published to
  `Mat-Tom-Son/amplefile-mac-releases` on November 7, 2026, from the
  annotated source tag `v0.1.0` (commit `7ea62a0`). It is an arm64 DMG and ZIP
  with blockmaps, `latest-mac.yml`, checksums, and both manifests.
- The signed app uses `com.amplefile.desktop`, the `AmpleFile`
  application-data profile, and only the `Mat-Tom-Son/amplefile-mac-releases`
  feed. A new install starts with an empty profile and is installed from its
  DMG.
- **0.1.1** was published to `Mat-Tom-Son/amplefile-mac-releases` on
  November 8, 2026, from the annotated source tag `v0.1.1` (commit
  `bd8f4e1`). It is the fresh-start release: the file manager is the only
  window layout, and the earlier apps, pages, Checks, Windows lanes, and
  older-product compatibility are gone. It carries the same assets as 0.1.0.
- The first in-place update, installed `0.1.0` to `0.1.1`, passed on
  November 8, 2026. See [Updater evidence](#updater-evidence).
- **0.1.2** was published to `Mat-Tom-Son/amplefile-mac-releases` on
  November 8, 2026, from the annotated source tag `v0.1.2` (commit
  `999292f`): the AmpleFile Agent name and the redrawn menu-bar chat.
- **0.1.3** was published to `Mat-Tom-Son/amplefile-mac-releases` on
  November 8, 2026, from the annotated source tag `v0.1.3` (commit
  `10cd011`): the G app icon, provider sign-in finished in the app, and a
  first run without Chrome.
- **0.1.4** was published to `Mat-Tom-Son/amplefile-mac-releases` on
  November 9, 2026, from the annotated source tag `v0.1.4` (commit
  `16eae93`): the renderer inside `app.asar`, the redrawn Chat, and an
  update staged before the app shuts down to install it.

## Release procedure

1. Complete review, fixes, versioning, and release notes, then merge and push
   the final release commit to canonical `main` in `Mat-Tom-Son/amplefile`.
   Check both local and remote tags before selecting a version: a checkout can
   hold tags the remote does not have. Never push an existing tag merely
   because creation failed; choose a higher version unused locally and
   remotely.
2. On an Apple-silicon Mac with Node 24, supported npm, and Google Chrome
   installed for real CSS tests, run the complete local release check from that
   clean committed checkout:

   ```bash
   npm run desktop:release:mac:check
   ```

   It executes these stages in order:

   - `npm ci`;
   - `npm run check`;
   - the complete unsharded `npm test`;
   - `npm run desktop:prepare`.

   Success writes ignored `out/release-checks/local-verification.json` with the
   exact SHA, tree, build-input fingerprint, Node/npm versions, dependency
   lockfile hashes, and every successful stage. The install stages explicitly
   use `--ignore-scripts=false --dry-run=false --include=dev` with `/bin/sh`;
   test-filter environment flags are cleared so the full suite runs. Starting
   a new run invalidates any old receipt; failure or a source change during
   the checks cannot leave valid success evidence. A local
   failure before tagging means fix the cause, commit, and rerun the check;
   it does not by itself consume a version. Inspect a saved receipt read-only:

   ```bash
   npm run desktop:release:mac:check -- --status
   ```

   Run local verification again after any commit change, including a merge
   whose tree is identical. Do not copy or hand-edit a receipt to qualify a
   different commit. GitHub Actions results are not substitutes for this
   receipt and are not a publication dependency.
3. After the check succeeds, build the complete signed/notarized distribution
   candidate under the same Node/npm toolchain, keeping source and dependencies
   unchanged during packaging:

   ```bash
   npm run desktop:make:mac:release
   ```

   Exercise the candidate's required native QA. If fixes change the source,
   commit them, run local verification again, and build a fresh candidate
   before tagging. Review dependency audit results separately with
   `npm audit --audit-level=high` as part of release review.
4. Create and push the annotated source tag for the checked release commit.
   Nothing else may be merged to `main` from the push of the release commit
   until publication has finished: the tag is made from the local checkout,
   and the publisher requires `origin/main` to be the tagged commit. The
   first line refuses to tag when `main` has moved:

   ```bash
   git fetch origin main &&
     test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" &&
     git tag -a v<version> -m "amplefile <version>" &&
     git push origin refs/tags/v<version>:refs/tags/v<version>
   ```

   GitHub Actions is off, so pushing the tag starts no remote workflow.
   Publication verifies the package version, annotated tag, and canonical source
   identity directly. `npm run desktop:release:mac:ci` is an optional
   diagnostic for the dormant workflows.
5. Confirm the build checkpoint and local receipt still match, and that the
   status command names the feed stage, packaged feed, and publication
   targets you expect. Then publish through the resume lane without
   repeating completed Apple work:

   ```bash
   npm run desktop:release:mac:status
   npm run desktop:release:mac:check -- --status
   npm run desktop:release:mac:resume
   ```

   For a fresh build-and-publish after local verification and tagging, use
   `npm run desktop:release:mac` instead. If a build or pre-publication check is
   interrupted, inspect status before retrying. Changed source, version,
   architecture, Node runtime, signing identity, feed, or artifact bytes require
   a fresh build. Changed source, Node/npm, or dependencies also requires
   fresh local verification. Every
   fresh local check requires a subsequent fresh build. A draft already
   created on GitHub is intentionally not overwritten by resume; apply the
   failed-draft recovery rule below before retrying publication.
6. Confirm the command reports a public, non-draft `v<version>` release with
   the DMG, ZIP, both blockmaps, `latest-mac.yml`, checksums, and both
   manifests, in each repository the stage publishes to. Then read the feed
   as an installed copy does:

   ```bash
   npm run desktop:verify:feed:mac -- --version <version>
   ```
7. When installation is authorized, install or update the app and verify it:

   ```bash
   npm run desktop:verify:installed:mac
   ```

8. Open AmpleFile normally and check **Settings > About** and
   **AmpleFile > Check for Updates...**. If the person reserved the update
   click, verify the installed lower version offers the new version and leave
   installation to them; do not report the new version as installed.

The publisher refuses a dirty/unpushed source tree, a mismatched annotated
source tag, a private source repository or Mac feed, an existing release for
the tag in a feed it publishes to, a feed stage the source does not record,
a publication that breaks [feed continuity](#what-the-publisher-checks-about-the-feed),
missing or stale local verification, changed Node/npm or dependency state, an
incompatible signed artifact checkpoint or one begun before local checks passed,
an unsigned manifest, a missing asset, or any remote size/digest mismatch.
It does not inspect or require GitHub Actions status. In the
`separate-repository` stage it creates no GitHub Release in the source
repository. Installer-only artwork is generated under
ignored `out/` build output so the release build cannot dirty its own checkout.
The publisher uploads a draft first and verifies every asset's GitHub SHA-256
against the local file. Immediately before making it public, it rechecks the
local receipt, canonical source identity, and signed artifact evidence. Direct
publisher invocation has the same checks.

## Moving the feed to the source repository

Every copy installed so far carries an `app-update.yml` that names
`Mat-Tom-Son/amplefile-mac-releases`, and that cannot be changed from
outside. Those copies reach the source repository only by updating, through
the separate repository, to a version that names it. The move is therefore
two releases:

1. **The bridge release** is built in the `bridge` stage and published to
   both repositories. Copies on the separate feed update to it as to any
   release, and from then on check the source repository, where the same
   release is already the latest: they report that they are up to date
   rather than failing their check.
2. **Every later release** is built in the `source-repository` stage and
   published to the source repository alone, attached to its annotated
   `v<version>` tag. The separate repository keeps the bridge as its last
   release, permanently, so a copy that was never updated can still step
   through it.

Download links follow the stage. They stay on the separate repository
through the bridge, whose latest release is then the bridge itself, and move
to the source repository in the `source-repository` stage, when it already
serves a Mac release as its latest.

### Changing the stage

A stage change is part of the release commit for the version that ships it:

1. Set `macUpdateFeedStage` in `src/shared/product-identity.json`.
2. Update the test that pins the stage, the first one in
   `tests/mac-release-feed.test.ts`. The last test in that file then fails
   until the README download links, the built site (`npm run site:build`),
   `PRIVACY.md`, and `SECURITY.md` name the feeds of the new stage.
3. Update what this runbook, [the build lanes](macos-build.md),
   [the website guide](website.md), and `AGENTS.md` say the current stage
   is, and add the release to the [Release record](#release-record).

### The bridge release: 0.1.5

The owner has chosen 0.1.5 as the bridge and 0.1.6 as the first release in
the source repository. Every feed check below names its feed, because the
feed the plain command reads changes with the stage.

1. Confirm the starting state. The separate feed offers 0.1.4, the source
   repository has no latest release (the second command is expected to fail
   with "has no latest release"), its other releases are all prereleases,
   and the installed 0.1.4 checks the separate feed:

   ```bash
   npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son/amplefile-mac-releases --version 0.1.4
   npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son/amplefile
   gh release list --repo Mat-Tom-Son/amplefile
   npm run desktop:verify:installed:mac -- --version 0.1.4 --feed Mat-Tom-Son/amplefile-mac-releases
   ```

2. Make the 0.1.5 release commit: the version, the `bridge` stage, and what
   [Changing the stage](#changing-the-stage) lists. **Freeze `main` when
   that commit is pushed.** From then until step 7 has finished, nothing
   may be merged or pushed to `main`, by anyone or any session; say so
   before pushing. The check, the signed build, and notarization take a
   long time, the tag is made from the local checkout, and every publisher
   run requires `origin/main` to be the tagged release commit. The bridge
   takes two runs with a manual check between them. A merge anywhere in
   that span cannot be worked around: before the tag it means a new release
   commit, check, and build; after the tag the remaining runs are refused
   for good, a bridge already public in the source repository stays there
   alone, and finishing the move needs a higher bridge version with a new
   tag, build, and notarization. No installed copy is harmed by that, since
   copies stay on the separate feed at their version, but 0.1.5 is spent.

   Merge and push the commit to `main`, then check and build:

   ```bash
   npm run check
   npm test
   npm run desktop:release:mac:check
   npm run desktop:make:mac:release
   npm run desktop:release:mac:status
   ```

   The status must name the `bridge` stage, `Mat-Tom-Son/amplefile` as the
   feed the packaged app checks, and both repositories as publication
   targets. The strict verifier has already failed the build unless the
   packaged `app-update.yml` names `Mat-Tom-Son/amplefile`.
3. Confirm `main` is still the release commit, then tag. The first line
   refuses to tag when `main` has moved since step 2:

   ```bash
   git fetch origin main &&
     test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" &&
     git tag -a v0.1.5 -m "amplefile 0.1.5" &&
     git push origin refs/tags/v0.1.5:refs/tags/v0.1.5
   ```

4. Publish, first run. In the `bridge` stage it publishes to the source
   repository only and stops, printing the checks in steps 5 and 6. Nothing
   installed reads that feed yet, so this changes no installed copy:

   ```bash
   npm run desktop:release:mac:resume
   ```

5. Read both feeds as an installed copy does. The source repository offers
   0.1.5; the separate repository still offers 0.1.4:

   ```bash
   npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son/amplefile --version 0.1.5
   npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son/amplefile-mac-releases --version 0.1.4
   ```

6. Check the built bridge against the source repository before any
   installed copy is offered it. Quit the installed AmpleFile, open a copy
   of the signed candidate with a disposable profile, and choose
   **AmpleFile > Check for Updates...**:

   ```bash
   ditto out/builder/mac-arm64/AmpleFile.app /tmp/amplefile-bridge-check/AmpleFile.app
   AMPLEFILE_DESKTOP_STATE_DIR=/tmp/amplefile-bridge-check/profile \
     /tmp/amplefile-bridge-check/AmpleFile.app/Contents/MacOS/AmpleFile
   ```

   It must report that 0.1.5 is up to date. "Update check failed." means
   the bridge cannot read the source repository: stop, and see
   [If the bridge is bad](#if-the-bridge-is-bad). The copy keeps the
   checkpointed candidate untouched; the profile override does not isolate
   Keychain.
7. Publish, second run: the same command. It finds 0.1.5 already served by
   the source repository, with identical assets, and publishes to the
   separate repository. This is the step that cannot be taken back: running
   copies check within four hours, and each one that updates checks the
   source repository from then on.

   ```bash
   npm run desktop:release:mac:resume
   npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son/amplefile-mac-releases --version 0.1.5
   npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son/amplefile --version 0.1.5
   ```

   The freeze on `main` ends when both feed checks pass.
8. Record the first proof in [Updater evidence](#updater-evidence). The
   installed 0.1.4 is offered 0.1.5 and installs it; then:

   ```bash
   npm run desktop:verify:installed:mac -- --version 0.1.5 --feed Mat-Tom-Son/amplefile
   ```

   and **Check for Updates...** in the installed 0.1.5 reports it is up to
   date.

If a run stops after it has uploaded a draft, the next run refuses that
draft. Confirm it is still a draft, delete it, and run again. In the
separate repository a draft has no tag yet; in the source repository never
add `--cleanup-tag`:

```bash
gh release view v0.1.5 --repo <owner>/<repo> --json isDraft
gh release delete v0.1.5 --repo <owner>/<repo> --yes
```

### The first release in the source repository: 0.1.6

1. Make the 0.1.6 release commit: the version, the `source-repository`
   stage, and what [Changing the stage](#changing-the-stage) lists,
   including the README download links and `npm run site:build`. Merge and
   push it to `main`, then check and build:

   ```bash
   npm run check
   npm test
   npm run desktop:release:mac:check
   npm run desktop:make:mac:release
   npm run desktop:release:mac:status
   ```

   The status must name the `source-repository` stage and
   `Mat-Tom-Son/amplefile` as both the packaged feed and the only
   publication target.
2. Tag and publish. `main` stays frozen from the push in step 1 until this
   step has finished, and the first line refuses to tag when it has moved.
   One run publishes to the source repository, attached to the annotated
   tag. The publisher refuses unless the separate repository's latest
   release is the bridge and the source repository already serves it:

   ```bash
   git fetch origin main &&
     test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" &&
     git tag -a v0.1.6 -m "amplefile 0.1.6" &&
     git push origin refs/tags/v0.1.6:refs/tags/v0.1.6
   npm run desktop:release:mac:resume
   ```

3. Read both feeds. The source repository offers 0.1.6, and the separate
   repository still offers the bridge:

   ```bash
   npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son/amplefile --version 0.1.6
   npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son/amplefile-mac-releases --version 0.1.5
   ```

4. Record the second proof: the installed 0.1.5 is offered 0.1.6 from the
   source repository and installs it.

   ```bash
   npm run desktop:verify:installed:mac -- --version 0.1.5 --feed Mat-Tom-Son/amplefile
   npm run desktop:verify:installed:mac -- --version 0.1.6 --feed Mat-Tom-Son/amplefile
   ```

5. Deploy the website ([Website](website.md#deploy)) so its Download links
   use the source repository. Until then they download the bridge, which
   updates itself.

### What each step makes permanent

| Step | What it fixes |
| --- | --- |
| Committing a stage | Nothing, until the commit is tagged. |
| Pushing `v<version>` | The version and its tag. A failed candidate's tag is never moved, reused, or deleted. |
| Publishing the bridge to the source repository (first run) | A public release there. No installed copy reads that feed yet. `main` must not move until the second run. |
| Publishing the bridge to the separate repository (second run) | The move itself. Copies that take the bridge check the source repository from then on and cannot be sent back. |
| The first `source-repository` release | Nothing further; the separate repository is already closed. |

After the bridge is in the separate repository, three things must stay true
for as long as any copy could still be on an older version:

- `Mat-Tom-Son/amplefile-mac-releases` stays public, under its name, with a
  bridge as its latest release. Archiving it keeps its releases
  downloadable and can be undone; deleting it, renaming it, or making it
  private strands every copy that has not updated yet.
- `Mat-Tom-Son/amplefile` always serves a Mac release as its latest release.
  Any other release there is a prerelease
  ([Release ownership](#release-ownership)).
- A release in the source repository is deleted, if ever, without
  `--cleanup-tag`: that option deletes the source tag.

### If the bridge is bad

- **Before it reaches the separate repository** (a failed build, a failed
  check in step 5 or 6, a failed upload, a merge to `main` during the
  freeze), no installed copy has changed. Fix the cause and publish a
  higher version as the bridge. A bridge already public
  in the source repository stays there; the next bridge supersedes it as
  latest. The stage can go back to `separate-repository` only while no
  bridge is public in either repository: after that the publisher refuses a
  release to the separate repository alone, because a copy installed from
  the source repository's bridge would never see it.
- **An ordinary defect in a published bridge**, one that leaves launching
  and updating intact, is fixed by the next release in the
  `source-repository` stage. Copies on the bridge take it from the source
  repository; older copies take the bridge first and then the fix.
- **A published bridge that cannot update from the source repository**
  strands only the copies that already took it, and only if it cannot
  update at all. Publish a replacement bridge at once: a higher version in
  the `bridge` stage with `AMPLEFILE_MAC_REPLACE_BRIDGE=v<bad bridge
  version>`. It becomes the latest release in both repositories, so copies
  still on an older version skip the bad bridge, and copies on the bad
  bridge take it if their updater works at all. A copy whose updater cannot
  run is repaired by installing the replacement's DMG over it, which keeps
  its profile; no arrangement of feeds can reach it. Steps 5 and 6 of the
  bridge release exist to catch this before step 7.
- The stage never goes back to `separate-repository` once a bridge is
  public. The publisher refuses it, because bridged copies would never see
  the release.

## Updater evidence

Repeat a lower-version-to-current installed update whenever updater code, Electron, Electron Builder, signing identity, bundle id, feed, artifact names, or Squirrel.Mac behavior changes.

The accepted proof must show:

- the lower app is Developer ID-signed, notarized, stapled, and installed under `/Applications`;
- `Contents/Resources/app-update.yml` in the lower app names the feed that version was built to check, `Mat-Tom-Son/amplefile-mac-releases` for every version through 0.1.4;
- the lower app's **AmpleFile > Check for Updates...** command offers the expected higher version and the Settings update surface reports the same state;
- the cached ZIP SHA-256 equals the published GitHub asset digest;
- AmpleFile shuts down, replaces the app, and relaunches at the higher version;
- `npm run desktop:verify:installed:mac` passes;
- a full quit and reopen does not ask for repeated Keychain passwords.

Record each proof here as it passes, with the two versions and the date.

A feed change needs two proofs, because two different feeds each have to
deliver an update:

1. **Separate feed to bridge.** A copy of the last version that checks
   `Mat-Tom-Son/amplefile-mac-releases` is offered the bridge there and
   installs it. Before the update, verify the lower app against the feed it
   was built for; afterwards, the bridge against the source repository:

   ```bash
   npm run desktop:verify:installed:mac -- --version <lower version> --feed Mat-Tom-Son/amplefile-mac-releases
   npm run desktop:verify:installed:mac -- --version <bridge version> --feed Mat-Tom-Son/amplefile
   ```

   Also record that the installed bridge's **Check for Updates...** reports
   it is up to date, which is its first read of the source repository.
2. **Bridge to the first release in the source repository.** The installed
   bridge is offered that release from `Mat-Tom-Son/amplefile` and installs
   it. This is also the first update the bridge's own updater performs.

For each, record what the list above requires, and add the feed the lower
app named, the feed the higher app names, and the output of
`npm run desktop:verify:feed:mac` for the feed that delivered the update.

**0.1.0 → 0.1.1, November 8, 2026**

- The installed `0.1.0` was Developer ID-signed for team `464JD5K8DC`,
  stapled, installed under `/Applications`, and its `app-update.yml` named
  `Mat-Tom-Son/amplefile-mac-releases`.
- The anonymous feed served `latest-mac.yml` at version `0.1.1` from a public,
  non-draft release with all eight assets.
- **AmpleFile > Check for Updates...** in the installed `0.1.0` offered
  `0.1.1`, and the owner accepted it.
- Both the cached `pending/AmpleFile-0.1.1-mac-arm64.zip` and `update.zip`
  hashed to SHA-256 `17b398cd2e621ed4c02257875c738ce8488ab9e8070a366a4c51f3a85c26a253`,
  the published asset digest.
- ShipIt logged `Installation completed successfully` and relaunched
  `/Applications/AmpleFile.app`, which reported `0.1.1`. The existing profile
  and its registered Connected Folder were kept.
- `npm run desktop:verify:installed:mac` passed without requesting Keychain
  secret data.
- Not observed in this proof: the Settings update surface during the update,
  and a later full quit and reopen.

## Recovery rules

- Never replace assets in a published release. Correct a bad release with a higher shared version.
- Never move, reuse, or delete a failed candidate's pushed source tag. It is immutable evidence even when no Mac-feed draft or public release exists; a correction to tagged source requires a higher version, release commit, and tag. Before tagging, fix an ordinary local-check failure, commit, and rerun verification without consuming a version. GitHub Actions status does not determine publication eligibility.
- A failed draft may be deleted only after confirming it was never published or consumed by an installed app. In the source repository, delete a draft or release without `--cleanup-tag`, which would delete the source tag.
- A feed move that goes wrong is recovered as [If the bridge is bad](#if-the-bridge-is-bad) describes, never by publishing to the separate repository in the `separate-repository` stage again.
- Inspect `npm run desktop:release:mac:check -- --status` for the exact-commit local receipt and `npm run desktop:release:mac:status` for the build before retrying. If its checkpoint is compatible, use the matching `:resume` build/release command instead of rebuilding the app and repeating notarization.
- If a build fails inside DMG finalization before its checkpoint is written, the resumable lane reruns the finalizer. It detects an already valid signed/stapled DMG and refreshes only updater metadata.
- Never rename or install `AmpleFile Local Smoke.app` over the production app. A user-data override does not isolate Keychain; use the signed candidate or a disposable macOS account for interactive testing.
- If repeated Keychain prompts occur after replacing an old ad hoc build, quit AmpleFile and run `npm run desktop:reset:mac-safe-storage -- --yes --reopen`. Do not read the secret with `security ... -g`.
- The current public lane is arm64 only. Do not publish x64 until an Intel Mac passes launch and updater smoke.

## Release ownership

The source repository owns code, exact release tags, issues, and documentation. `amplefile-mac-releases` is the active desktop artifact feed only. Do not develop or hand-edit release metadata in the feed repository, and do not add a competing tag publisher.

The source repository's GitHub Releases hold `linux-test-*` prereleases and no Mac release. Once the feed moves there, its latest release is what every installed Mac copy is offered, so two rules hold for anything else published in it:

- A Linux preview is published as a prerelease and never as the latest release. `gh release create` marks a release latest unless it is given `--prerelease` or `--latest=false`. If one does take latest, every Mac copy's update check fails until it is undone: mark the last Mac release latest again with `gh release edit v<version> --repo Mat-Tom-Son/amplefile --latest`, or make the other release a prerelease with `gh release edit <tag> --repo Mat-Tom-Son/amplefile --prerelease`. Then confirm with `npm run desktop:verify:feed:mac -- --feed Mat-Tom-Son/amplefile`. The Mac publisher refuses to publish while a release that is not a Mac release is latest there, and checks after publishing that its own release is.
- The updater reads only the latest release. If Linux ever gets an updater feed of its own in this repository, both platforms have to ship in the same release for each version, with `latest-mac.yml` and the Linux update metadata as assets of that one release.
