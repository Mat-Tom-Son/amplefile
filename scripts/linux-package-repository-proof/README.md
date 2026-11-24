# Package repository proof

Runs the Fedora package repository lane ([Linux builds](../../docs/linux-build.md#package-repository))
end to end in a throwaway Fedora 44 container, with a throwaway signing key
and a local stand-in for GitHub's hosts. It needs podman, the local
`localhost/amplefile-wlroots-acceptance` image (or another Fedora 44 image,
`--image`), `gpg`, an unpacked Linux build of the same source (`npm run desktop:make:linux -- --dir`,
or `--unpacked DIR`; the app check refuses one without the Linux package update code), the icons from `npm run desktop:icons`, and the
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
   changed, its signature not), which dnf must reject and skip the repository
   for, and a tampered RPM (bytes changed after signing, with metadata
   regenerated and signed to match), which dnf must refuse to install; A stays
   installed both times.
5. Last, it runs the installed app itself as a person would: as an ordinary
   user, on a display and session bus that outlive any one AmpleFile process,
   with a disposable profile (`AMPLEFILE_STATE_DIR`, `AMPLEFILE_DESKTOP_STATE_DIR`,
   `AMPLEFILE_CLI_STATE_DIR`, `AMPLEFILE_AGENT_DIR`, `PI_CODING_AGENT_DIR`,
   `AMPLEFILE_DISABLE_LOGIN_SHELL_ENV=1`) and `--remote-debugging-port`.
   `app-driver.mjs` calls `window.ampleFileDesktop.updates` in its window, as
   Settings → About and the sidebar do. Before the upgrade the status must
   say updates arrive with the system's software updates. dnf then upgrades
   A to B through the repository with `gpgcheck=1` and `repo_gpgcheck=1`
   while it runs; the status check (which looks at the installed files, in
   place of the minute-long timer) must leave it waiting on the first look
   and offer the restart (`ready`, `updatesFrom: "system"`) on the second,
   without restarting anything. `install`, the call the confirmed click
   makes, must end the old process and start one new process from the
   installed files, which says updates arrive with the system's again (no
   second `ready`) and is still the only process 15 seconds later. Then the
   person turns the repository off (`enabled=0`), dnf reinstalls B under the
   running app, the restart is offered and not chosen, and an ordinary quit
   (SIGTERM, as at logout) must run AmpleFile's own shutdown and open
   nothing again. `enabled=0` and an earlier change to the entry must
   survive.

`watch.mjs` reads what Settings → About would say for the install without
starting the app.

`results.txt` lists every check. Without `--keep`, only the logs and results
stay in `out/linux-package-repository-proof` afterwards. It cannot prove dnf
against the real `raw.githubusercontent.com`, which needs the branch pushed.
