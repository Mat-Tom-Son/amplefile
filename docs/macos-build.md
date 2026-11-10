# macOS build and release lane

AmpleFile is one Electron, React, local API, Pi, and AmpleFile kernel codebase. Apple-silicon macOS is its only packaging and public distribution lane.

The ad hoc structural package uses its own name, `AmpleFile Local Smoke`, its
own bundle id, `com.amplefile.desktop.local-smoke`, and its own build channel
and application-data directory. Its runtime never starts the updater or
contacts the production feed.

## Toolchain

Use Node 24 and npm 11.16.0 or newer for contributor and release work. npm's
per-dependency script controls keep the included computer helper's upstream
installer from running; the checked-in packaging lane builds and signs it.
The application's Node runtime minimum is 22.19.0. The included computer
helper requires macOS 14 or later; other tools remain available on the app's
supported systems.

`desktop:prepare` builds the Computer app from reviewed source. The signing
hook signs it with the app's Developer ID before the outer bundle is sealed.
The Computer app retains its product icon and `com.amplefile.desktop.computer`
identity. After signing, a bounded packaging probe uses the archived
installation code to verify a standalone copy in a temporary private directory,
without launching it or requesting permissions.
Automatic startup may update an owned registration, but a removed or changed
registration requires explicit Connect to repair. No profile files are read.

```bash
npm ci
npm run check
npm test
npm run desktop:make:mac
```

Use the smallest lane that proves the behavior under test:

| Lane | Command | Purpose |
| --- | --- | --- |
| UI development | `npm run local:dev` | Live renderer and local API work without packaging or Apple services. |
| Desktop integration | `npm run desktop:smoke` | Prepared, unpackaged Electron behavior using development state. |
| Structural package | `npm run desktop:make:mac` | Ad hoc, separately identified DMG/ZIP package and verification; never install it as production. |
| Interactive release candidate | `npm run desktop:rc:mac` | Developer ID-signed and app-notarized production bundle without DMG/ZIP assembly, DMG notarization, updater artifacts, or publication. |
| Distribution candidate | `npm run desktop:make:mac:release` | Requires the exact-commit local-check receipt; produces the complete signed/notarized DMG and ZIP set plus strict verification. |
| Public release | `npm run desktop:release:mac` | Fresh distribution candidate followed by guarded draft-first publication. |

The app-only release-candidate lane is the normal packaged UI/desktop QA loop.
It produces `out/mac-rc/mac-arm64/AmpleFile.app`, verifies the Developer ID
signature, hardened runtime, notarization staple, Gatekeeper acceptance, and
packaged assets, and leaves the full updater/distribution proof to the slower
distribution lane. Electron Builder's unpacked `--dir` output has no updater
metadata, so it cannot prove update discovery or installation.

Keep the source tree unchanged while packaging. Before signing, the build
verifies every ASAR file and block hash against the assembled bytes, including
unpacked files. Packaged verification repeats those checks afterward, excluding
only unpacked Mach-O binaries whose signatures legitimately changed their bytes;
the existing code-signature checks verify those binaries. This catches source
size changes that otherwise leave a validly signed but unreadable archive.

The renderer build for the main window and the AmpleFile Agent popover is
archived at `dist/web-local` inside `app.asar`, beside the compiled main
process, so the ASAR integrity fuse covers the code both windows run. The
internal scheme serves it from the archive; nothing is copied to
`Contents/Resources/web-local`. Packaged-asset verification compares the
archive's `dist/web-local` with the tree's own `dist/web-local` build file
for file, by name and SHA-256, so a missing lazily loaded chunk, font, or
image and a stale file both fail; that is one more reason to verify a package
from the tree that built it. It also requires both pages to name their
scripts and stylesheets by path inside the build, and fails on a link, an
unpacked renderer file, or a loose copy beside the archive.

What stays outside the archive is not window code, but some of it is code.
`app.asar.unpacked` holds the document worker entrypoint and, because
Electron Builder unpacks any package that contains a binary or an executable
as a whole, these packages with all their JavaScript: `@earendil-works/pi-tui`,
`@injaneity/pi-computer-use`, `jszip`, `esbuild` with `@esbuild/darwin-arm64`,
`quickjs-wasi`, and the `@napi-rs/canvas` native binding. Electron reads
unpacked files straight from disk, so the ASAR integrity fuse does not cover
them at run time; the build-time hash checks above and the bundle's code
signature do. The same holds for the icons under `Contents/Resources/assets`,
the Computer helper, and the CLI shims under
`Contents/bin`. List `app.asar.unpacked` in a built candidate to see the
current set.

Before signing or contacting Apple, the macOS packager also runs a bounded
native-tool smoke against an isolated clone of the complete built archive.
Development Electron loads that archive's compiled Chat runtime and its own Pi
and Jiti dependencies, checks all four included tools in two Chats, invokes a
local synthetic MCP service, and creates and renders documents through native
tool calls. No model or credentials are used. Poisoned ancestor packages and
reported library origins prove document runtime dependencies stay in the app;
the smoke never launches the production app or changes the candidate bytes.

The signed candidate uses the normal AmpleFile name, bundle identity, and
application-data profile even outside `/Applications`. It looks like the
installed app and shares its single-instance lock. Quit it before opening the
Applications copy for updater testing. Only the ad hoc Local Smoke lane has
an isolated identity by default; a signed candidate needs an explicit
`AMPLEFILE_DESKTOP_STATE_DIR` override for separate app data, which still does
not isolate Keychain. Check the running executable path, installed bundle
version, and published feed version independently when reporting release state.

`desktop:make:mac` is the unsigned/ad hoc structural smoke lane. It performs desktop preparation, Pi smoke checks, Electron Builder DMG/ZIP assembly, packaged-asset and fuse verification, updater-manifest verification, mounted-DMG inspection, checksum generation, and release-manifest generation. Installer-only DMG artwork is generated under ignored `out/generated-assets` so image encoders cannot rewrite tracked source bytes or make the guarded publisher reject its own build. The smoke build is not distributable and must not be renamed or installed over the production app.

Expected Apple silicon outputs:

- `out/builder/mac-arm64/AmpleFile Local Smoke.app`
- `out/builder/AmpleFile-<version>-mac-arm64.dmg`
- `out/builder/AmpleFile-<version>-mac-arm64.zip`
- matching `.blockmap` files
- `out/builder/latest-mac.yml`
- `out/builder/SHA256SUMS-mac.txt`
- `out/builder/AmpleFile-mac-release-manifest.json`
- `out/builder/AmpleFile-mac-release-manifest.txt`

Use `-- --arch x64` after a build command when an Intel candidate is required. An Intel artifact is not releasable until it receives a real Intel launch and updater smoke.

## Interactive packaged smoke

Do not interactively launch an ad hoc candidate under a normal macOS account. An ad hoc app using the production identity can invalidate Keychain access control and cause password prompts even when `AMPLEFILE_DESKTOP_STATE_DIR` points at `/tmp`; the profile override does not isolate Keychain. The checked-in smoke lane's distinct name and bundle id prevent it from impersonating production, but routine ad hoc verification remains non-interactive.

Use a Developer ID-signed candidate for interactive checks on the release workstation:

```bash
AMPLEFILE_DESKTOP_STATE_DIR=/tmp/amplefile-macos-smoke \
  out/mac-rc/mac-arm64/AmpleFile.app/Contents/MacOS/AmpleFile
```

That app-only path exists after `npm run desktop:rc:mac`; the complete distribution candidate remains at `out/builder/mac-arm64/AmpleFile.app`. The ad hoc executable is `out/builder/mac-arm64/AmpleFile Local Smoke.app/Contents/MacOS/AmpleFile Local Smoke`. Exercise first run, connecting and creating Connected Folders, the file manager's sidebar and contents, the Worker panel (Info, History, and its Chats), the Skills & Extensions dialog, Settings, native file actions, menus, window close and reopen, and sleep/wake continuity. The profile override isolates CLI requests, app files, and preferences, but it is not a Keychain boundary. A separate disposable macOS account is the alternative for interactive ad hoc testing.

The packaged CLI can be tested directly:

```bash
AMPLEFILE_DESKTOP_STATE_DIR=/tmp/amplefile-macos-smoke \
AMPLEFILE_CLI_STATE_DIR=/tmp/amplefile-macos-smoke \
AMPLEFILE_CLI_APP="$PWD/out/mac-rc/mac-arm64/AmpleFile.app/Contents/MacOS/AmpleFile" \
  out/mac-rc/mac-arm64/AmpleFile.app/Contents/bin/amplefile context --json
```

The app adds `Contents/bin` to child-process `PATH`. A DMG must not edit a person's shell profile. Making `amplefile` available in other Terminal sessions is an explicit action: **Settings → Command Line → Add to Terminal**.

## Signing configuration

The ignored `.env.macos.local` file is the normal workstation configuration:

```dotenv
AMPLEFILE_MAC_SIGN_IDENTITY="Developer ID Application: James Thompson (464JD5K8DC)"
APPLE_KEYCHAIN_PROFILE="kai-workspace-notary"
AMPLEFILE_MAC_RELEASE_OWNER="Mat-Tom-Son"
AMPLEFILE_MAC_RELEASE_REPO="amplefile-mac-releases"
AMPLEFILE_MAC_TEAM_ID="464JD5K8DC"
```

`AMPLEFILE_MAC_RELEASE_OWNER` and `AMPLEFILE_MAC_RELEASE_REPO` name the separate release repository and default to it, so they are optional. They do not choose where a release is published or which feed the packaged app checks: the checked-in feed stage does ([Update feed](macos-release.md#update-feed)).

The notary profile name is local and arbitrary; `kai-workspace-notary` is the profile on the release workstation. Never commit Apple passwords, API keys, certificate private keys, or exported identities. `APPLE_KEYCHAIN_PROFILE` may be replaced by a complete App Store Connect API-key or Apple-ID environment set when needed.

Build the fast app-only candidate for interactive QA:

```bash
npm run desktop:rc:mac
```

After the final commit is locally verified, build the complete distribution
candidate without publishing:

```bash
npm run desktop:release:mac:check
npm run desktop:make:mac:release
```

The release lane signs/notarizes the app, signs/notarizes/staples the final DMG, then regenerates the DMG blockmap and `latest-mac.yml` checksum after those byte-changing operations. Strict verification requires the expected Developer ID team, hardened runtime, stapling, Gatekeeper acceptance, feed, manifest, CLI, DMG layout, and exact artifact hashes.

## Timings and resumable release work

Every macOS candidate stage reports elapsed time. A complete signed distribution
build writes an ignored checkpoint at
`out/builder/AmpleFile-mac-release-state.json`. The checkpoint binds completed
stages to the package version, architecture, Node version, signing identity,
update feed stage and packaged feed, source/configuration fingerprint, signed
app, and exact artifact hashes. It contains no signing or notarization
credentials. The status command also prints the feed stage, the feed the
packaged app checks, and where a release would be published.

Inspect a checkpoint without changing it:

```bash
npm run desktop:release:mac:status
npm run desktop:release:mac:status -- --json
```

Resume an interrupted local distribution build:

```bash
npm run desktop:make:mac:release:resume
```

Resume the build and continue into guarded publication:

```bash
npm run desktop:release:mac:resume
```

Resume never means “trust whatever is in `out/`.” The command verifies the
saved fingerprint, exact file receipts, app signature, notarization staple, and
Gatekeeper result before skipping work. It fails closed if inputs, environment,
or artifacts changed; run a fresh `desktop:make:mac:release` in that case. Do
not hand-edit the state file. The full verifier still runs before publication.

Finish review, versioning, and release notes, merge to `main`, and run the local
release check on that exact commit before building. Do not change source or run
dependency installs during packaging. The local-check receipt pins the final
SHA and cannot carry across a merge even when its tree matches. A full signed
build requires that receipt before starting, and publication requires the build
to have started after the receipt completed. A fresh local check reinstalls
dependencies, so an older build must be replaced with a subsequent fresh build.
Only a compatible checkpoint from after the current check may reuse completed
Apple work. A shared per-worktree lock serializes checks, all macOS builds,
and publication to prevent dependency installation or preparation from racing
packaging. The app-only RC lane needs no receipt, but holds the same lock for preparation.
Changes only to release tooling or documentation need local verification, not
a new version or an Apple submission.

## Public releases

The public release is the signed, notarized Apple-silicon Mac build. The
source repository, `Mat-Tom-Son/amplefile`, carries the exact source tag
and the release itself: its GitHub Releases are the feed the packaged app
checks. The separate feed, `Mat-Tom-Son/amplefile-mac-releases`, is the one
versions through 0.1.4 check; its last release is 0.1.5, the bridge.

Which feed the packaged app checks and where a release is published both
follow the feed stage, `macUpdateFeedStage` in
`src/shared/product-identity.json`. The checked-in stage is
`source-repository`: the app checks the source repository and releases are
published there alone. The `bridge` stage, which published 0.1.5 to both
repositories, is used again only to replace a bridge. See
[Update feed](macos-release.md#update-feed) and
[Moving the feed to the source repository](macos-release.md#moving-the-feed-to-the-source-repository).

```bash
npm run desktop:release:mac
```

Publication requires a successful local check of the exact release commit on
an Apple-silicon Mac with Node 24, supported npm, and Google Chrome installed
for the real CSS tests:

```bash
npm run desktop:release:mac:check
npm run desktop:release:mac:check -- --status
```

The first command runs a fresh `npm ci`, `npm run check`, the complete
`npm test`, and `npm run desktop:prepare`. Fresh installs
explicitly enable permitted scripts and development dependencies, reject dry-run
behavior, and use `/bin/sh`; the check also clears test-filter environment flags.
Only success writes `out/release-checks/local-verification.json`, binding the
SHA, tree, build-input fingerprint, Node/npm versions, dependency lockfile hashes, and each
completed stage. Publication requires that same toolchain and dependency state.
A new run removes old evidence before starting; a failure or source change cannot leave a valid
success receipt. The status command is read-only. Run the checks after the
final merge; an identical tree at another commit does not inherit the receipt.

GitHub Actions is off in the source repository. Pushes, PRs, and release tags
start no remote checks; the checked-in workflows are dormant diagnostics. The
local release check is the required verification lane, and the publisher
checks canonical source identity directly. `npm run desktop:release:mac:ci` is
an optional diagnostic for those dormant workflows.

The publisher validates the local receipt, current canonical `main`, annotated
source tag, and source-bound signed artifact checkpoint begun after that
check completed, before upload and immediately before publication. It requires a clean pushed source tree, public
source and feed repositories, no release yet for `v<version>` in a feed it
publishes to, the feed stage the source records, and a version higher than
each feed's latest release. Direct
publisher invocation has the same requirements. It verifies the local release,
uploads all assets as a draft, checks remote names, sizes, and GitHub digests,
publishes as latest, and confirms the feed then serves that release as its
latest. In the `separate-repository` stage it creates no GitHub Release in
the source repository. Never hand-edit the local receipt or build checkpoint.

A failure before tagging is corrected by fixing, committing, and rerunning the
local checks. Once pushed, a candidate tag is immutable: retain a failed tag and
fix forward with a higher unique version, commit, and tag.

See [macOS release runbook](macos-release.md) for the exact repeatable procedure and recovery rules.

## Keychain behavior

Provider credentials use Electron `safeStorage`, backed by Keychain. Stable Developer ID signing gives macOS one durable requester identity. An ad hoc app that used the production name can leave a Safe Storage access-control entry that repeatedly asks for a password. Local smoke builds use `AmpleFile Local Smoke`, a separate bundle id and application-data directory, and never start the production updater; do not rename them to `AmpleFile.app`.

Only when repeated prompts are observed, quit AmpleFile and run:

```bash
npm run desktop:reset:mac-safe-storage -- --yes --reopen
```

The helper deletes only the `AmpleFile Safe Storage` key and encrypted provider credential blobs. Connected Folders, chats, History, preferences, and ordinary app data remain. Users may need to enter provider credentials again.

Do not diagnose this with `security find-generic-password ... -g`: `-g` requests the secret and can itself trigger a password prompt. The installed-app verifier deliberately reads no Keychain secret data.

## Code map

- `electron-builder.desktop.cjs`: targets, the update feed written into the packaged app, Mac identity, entitlements, icon, DMG layout, and what is archived in `app.asar`.
- `scripts/mac-release-feed.cjs`: the feed stage, the feed the packaged app checks, and the repositories a release is published to, for the builder configuration, every release script, and the website.
- `desktop/src/renderer-protocol.ts`: where the renderer build lives and how the internal scheme serves it.
- `scripts/verify-packaged-app-assets.mjs`: packaged layout, fuses, and ASAR integrity; `scripts/verify-packaged-renderer.mjs` is its check that the archive holds the renderer build.
- `scripts/generate-dmg-background.mjs`: installer-only DMG artwork under ignored build output.
- `scripts/build-mac-release-candidate.mjs`: app-only signed/notarized interactive release candidate.
- `scripts/verify-mac-release-candidate.mjs`: signature, hardened-runtime, staple, Gatekeeper, identity, version, and architecture verification for the app-only candidate.
- `scripts/build-mac-desktop.mjs`: unsigned-smoke and checkpointed signed-distribution orchestrator.
- `scripts/mac-release-state.mjs`: source fingerprints, artifact receipts, atomic checkpoints, and timing summaries.
- `scripts/mac-release-status.mjs`: read-only human/JSON checkpoint inspection.
- `.agents/skills/ship-macos-release/SKILL.md`: standard project Skill that selects and executes these same documented lanes.
- `scripts/finalize-mac-release-artifacts.mjs`: final DMG signing, notarization, stapling, and post-signing metadata refresh.
- `scripts/write-mac-release-manifest.mjs`: release evidence and artifact hashes.
- `scripts/check-local-release.mjs`: full local release check and read-only receipt status.
- `scripts/local-release-verification.mjs`: exact-source receipts, dependency evidence, and shared release-work lock.
- `scripts/release-source.mjs`: canonical main and annotated source-tag identity checks.
- `scripts/verify-release-ci.mjs`: optional diagnostics for the dormant GitHub workflows, and the source-tag workflow's entrypoint.
- `.github/workflows/release-tag.yml`: dependency-free source-tag verification.
- `scripts/publish-mac-release.mjs`: guarded draft-first public publisher.
- `scripts/mac-release-publication.mjs`: the publisher's feed decisions: continuity between feeds, publication order, resuming a two-feed publication, and attaching to the source tag.
- `scripts/verify-mac-feed.mjs`: reads a public feed as an installed copy does and reports the version it offers.
- `scripts/verify-mac-release.mjs`: bundle, signature, updater, manifest, checksum, and mounted-DMG verification.
- `scripts/verify-installed-mac-app.mjs`: installed version/feed/signature/notarization verification without Keychain reads.
- `scripts/reset-mac-safe-storage.mjs`: narrow ad hoc-to-Developer-ID credential recovery helper.
- `desktop/src/updater.ts`: the update state machine over Squirrel.Mac.
- `desktop/cli/amplefile-cli.jxa.js`: macOS protocol-v1 CLI helper.
