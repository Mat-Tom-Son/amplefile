# AmpleFile Linux package repository

This branch is generated. It is not AmpleFile's source code, and
nothing on it is edited by hand.

It is the Fedora package repository for the AmpleFile Linux
preview RPM: the signed dnf metadata under `rpm/x86_64/`, which
dnf reads from

    https://raw.githubusercontent.com/Mat-Tom-Son/amplefile/linux-package-repository/rpm/$basearch

Installing the amplefile-desktop RPM enrols a computer: it adds
`/etc/yum.repos.d/amplefile.repo` and the public key
`/etc/pki/rpm-gpg/RPM-GPG-KEY-amplefile`, and dnf then checks this repository with
the rest of the system's updates. dnf checks both the package signature and
the signature on `repodata/repomd.xml` (`repomd.xml.asc`).

The RPM itself is not on this branch. It is an asset of the GitHub prerelease
for its tag, and the metadata points there.

The repository lists only the newest build:

- amplefile-desktop 0.2.2-1 (x86_64), from [linux-0.2.2](https://github.com/Mat-Tom-Son/amplefile/releases/tag/linux-0.2.2)
- `AmpleFile-0.2.2-1-linux-x86_64.rpm`, sha256 `e4c784a5b81830cbccf672a8e0f0e481fcabf1d0e63f30fda2c63daf5c3a31cf`
- signed with the key 315D9CFCD9A8B3E2338D06996457F0AAD7F8AAB1

`npm run desktop:linux:repository -- prepare` in the source repository
rewrites this whole branch for each build. See docs/linux-build.md there.
