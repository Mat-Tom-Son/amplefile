# macOS release runbook

This runbook publishes the Apple-silicon AmpleFile desktop release to the separate public feed at [`Mat-Tom-Son/amplefile-mac-releases`](https://github.com/Mat-Tom-Son/amplefile-mac-releases). Source and release tags live in [`Mat-Tom-Son/amplefile`](https://github.com/Mat-Tom-Son/amplefile).

## One-time workstation setup

1. Install the `Developer ID Application: James Thompson (464JD5K8DC)` certificate and private key in the login Keychain.
2. Store notarization credentials with `xcrun notarytool store-credentials`. The release workstation's profile is `kai-workspace-notary`; a profile name is only a local label.
3. Create ignored `.env.macos.local` using the non-secret variable template in [macOS build and release lane](macos-build.md).
4. Confirm `gh auth status` uses the `Mat-Tom-Son` account and that the Mac feed repository is public.

Do not export or commit the certificate, private key, app-specific password, or notary credentials.

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
- The first in-place update to prove is from an installed `0.1.0` to the next
  release. Record it under [Updater evidence](#updater-evidence) when it
  passes.

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
4. Create and push the annotated source tag for the checked release commit:

   ```bash
   git tag -a v<version> -m "amplefile <version>" &&
     git push origin refs/tags/v<version>:refs/tags/v<version>
   ```

   GitHub Actions is off, so pushing the tag starts no remote workflow.
   Publication verifies the package version, annotated tag, and canonical source
   identity directly. `npm run desktop:release:mac:ci` is an optional
   diagnostic for the dormant workflows.
5. Confirm the build checkpoint and local receipt still match, then publish
   through the resume lane without repeating completed Apple work:

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
   the DMG, ZIP, both blockmaps, `latest-mac.yml`, checksums, and both manifests.
7. When installation is authorized, install or update the app and verify it:

   ```bash
   npm run desktop:verify:installed:mac
   ```

8. Open AmpleFile normally and check **Settings > About** and
   **AmpleFile > Check for Updates...**. If the person reserved the update
   click, verify the installed lower version offers the new version and leave
   installation to them; do not report the new version as installed.

The publisher refuses a dirty/unpushed source tree, a mismatched annotated
source tag, a private source repository or Mac feed, an existing Mac tag,
missing or stale local verification, changed Node/npm or dependency state, an
incompatible signed artifact checkpoint or one begun before local checks passed,
an unsigned manifest, a missing asset, or any remote size/digest mismatch.
It does not inspect or require GitHub Actions status or a
source-repository GitHub Release. Installer-only artwork is generated under
ignored `out/` build output so the release build cannot dirty its own checkout.
The publisher uploads a draft first and verifies every asset's GitHub SHA-256
against the local file. Immediately before making it public, it rechecks the
local receipt, canonical source identity, and signed artifact evidence. Direct
publisher invocation has the same checks.

## Updater evidence

Repeat a lower-version-to-current installed update whenever updater code, Electron, Electron Builder, signing identity, bundle id, feed, artifact names, or Squirrel.Mac behavior changes.

The accepted proof must show:

- the lower app is Developer ID-signed, notarized, stapled, and installed under `/Applications`;
- `Contents/Resources/app-update.yml` names `Mat-Tom-Son/amplefile-mac-releases`;
- the lower app's **AmpleFile > Check for Updates...** command offers the expected higher version and the Settings update surface reports the same state;
- the cached ZIP SHA-256 equals the published GitHub asset digest;
- AmpleFile shuts down, replaces the app, and relaunches at the higher version;
- `npm run desktop:verify:installed:mac` passes;
- a full quit and reopen does not ask for repeated Keychain passwords.

No in-place AmpleFile update has been proven yet; record each proof here as it
passes, with the two versions and the date.

## Recovery rules

- Never replace assets in a published release. Correct a bad release with a higher shared version.
- Never move, reuse, or delete a failed candidate's pushed source tag. It is immutable evidence even when no Mac-feed draft or public release exists; a correction to tagged source requires a higher version, release commit, and tag. Before tagging, fix an ordinary local-check failure, commit, and rerun verification without consuming a version. GitHub Actions status does not determine publication eligibility.
- A failed draft may be deleted only after confirming it was never published or consumed by an installed app.
- Inspect `npm run desktop:release:mac:check -- --status` for the exact-commit local receipt and `npm run desktop:release:mac:status` for the build before retrying. If its checkpoint is compatible, use the matching `:resume` build/release command instead of rebuilding the app and repeating notarization.
- If a build fails inside DMG finalization before its checkpoint is written, the resumable lane reruns the finalizer. It detects an already valid signed/stapled DMG and refreshes only updater metadata.
- Never rename or install `AmpleFile Local Smoke.app` over the production app. A user-data override does not isolate Keychain; use the signed candidate or a disposable macOS account for interactive testing.
- If repeated Keychain prompts occur after replacing an old ad hoc build, quit AmpleFile and run `npm run desktop:reset:mac-safe-storage -- --yes --reopen`. Do not read the secret with `security ... -g`.
- The current public lane is arm64 only. Do not publish x64 until an Intel Mac passes launch and updater smoke.

## Release ownership

The source repository owns code, exact release tags, issues, and documentation. `amplefile-mac-releases` is the active desktop artifact feed only. Do not develop or hand-edit release metadata in the feed repository, and do not add a competing tag publisher.
