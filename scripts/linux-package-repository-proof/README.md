# Package repository proof

Runs the Fedora package repository lane ([Linux builds](../../docs/linux-build.md#package-repository))
end to end in a throwaway Fedora 44 container, with a throwaway signing key
and a local stand-in for GitHub's hosts. It needs podman, the local
`localhost/amplefile-wlroots-acceptance` image (or another Fedora 44 image,
`--image`), `gpg`, an unpacked Linux build (`npm run desktop:make:linux -- --dir`,
or `--unpacked DIR`), the icons from `npm run desktop:icons`, and the
packager's own prerequisites (on Fedora, `libxcrypt-compat` or a library path
that provides `libcrypt.so.1`). The container downloads `createrepo_c`,
`rpm-sign`, `git-core`, `openssl` and the RPM's dependencies from Fedora's
mirrors. It uses the committed source, so commit first.

```sh
systemd-run --user --scope --quiet -p MemoryMax=4G -p MemorySwapMax=0 \
  node scripts/linux-package-repository-proof/run.mjs
```

What it does:

1. Archives `HEAD` into `out/linux-package-repository-proof/source`, makes a
   throwaway RSA 4096 key in a `GNUPGHOME` there, and commits its public half
   at `desktop/linux/RPM-GPG-KEY-amplefile` in that copy, so the builder
   configuration enrols the RPM exactly as it would with the owner's key.
2. Packages the unpacked build twice with the real builder configuration
   (`--prepackaged`), as RPM release 1 and release 2 of one version, and checks
   both with `scripts/verify-linux-packages.mjs`. The only difference from a
   release build is gzip payload compression instead of multithreaded xz,
   which keeps the packager within the memory cap; compression does not touch
   the signature, the metadata, or the enrolment.
3. In the container, `server.py` answers HTTPS for `raw.githubusercontent.com`
   (the branch's files from `git show`, as `text/plain`, with no directory
   listing), `github.com` (a release download redirects) and
   `release-assets.githubusercontent.com` (the asset), with a throwaway CA the
   container trusts. The installed repository entry is not changed: dnf uses
   the real addresses.
4. `in-container.sh` then signs and publishes build A with
   `npm run desktop:linux:repository`'s script, installs A from the RPM file
   and checks the enrolment, then signs and publishes build B, checking each
   refusal on the way (no upload, other bytes uploaded, a stale `SHA256SUMS`,
   a build that is not newer). It serves tampered metadata (`repomd.xml`
   changed, its signature not) and a tampered RPM (bytes changed after
   signing, with metadata regenerated and signed to match), and expects dnf to
   refuse both with A still installed. Last, it upgrades to B through the
   repository with `gpgcheck=1` and `repo_gpgcheck=1`, while `watch.mjs` runs
   the app's own `desktop/src/system-package-updates.ts` against the installed
   files and must see the restart offer appear, and checks that a person's
   change to the entry, and `enabled=0`, survive.

`results.txt` lists every check. Without `--keep`, only the logs and results
stay in `out/linux-package-repository-proof` afterwards. It cannot prove dnf
against the real `raw.githubusercontent.com`, which needs the branch pushed.
