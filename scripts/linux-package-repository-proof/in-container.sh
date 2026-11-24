#!/bin/bash
# The package repository proof's container half (README.md beside this file).
# Runs as root in a throwaway Fedora container with the proof folder at
# /proof: two RPM builds of one version in /proof/build-1 and /proof/build-2,
# the archived source with a throwaway public key committed in
# /proof/source, and that key's secret half in /proof/gnupg.
set -euo pipefail

P=/proof
S=$P/source
: "${VERSION:?}" "${OWNER:?}" "${REPO:?}" "${BRANCH:?}" "${PACKAGE:?}" "${REPOSITORY_ID:?}" "${PRODUCT:?}"
TAG_A=linux-test-$VERSION
TAG_B=linux-test-$VERSION-2
RPM_A=$P/build-1/$PRODUCT-$VERSION-1-linux-x86_64.rpm
RPM_B=$P/build-2/$PRODUCT-$VERSION-2-linux-x86_64.rpm
ENTRY=/etc/yum.repos.d/$REPOSITORY_ID.repo
KEY=/etc/pki/rpm-gpg/RPM-GPG-KEY-$REPOSITORY_ID
RAW=https://raw.githubusercontent.com/$OWNER/$REPO/$BRANCH
PUBLISH=(node "$S/scripts/publish-linux-package-repository.mjs")
UPDATES=$S/desktop/src/system-package-updates.ts
export GNUPGHOME=$P/gnupg
export GIT_AUTHOR_NAME="AmpleFile proof" GIT_AUTHOR_EMAIL=proof@invalid GIT_COMMITTER_NAME="AmpleFile proof" GIT_COMMITTER_EMAIL=proof@invalid

: > "$P/results.txt"
step() { printf '\n=== %s\n' "$*"; }
pass() { printf 'PASS %s\n' "$*" | tee -a "$P/results.txt"; }
fail() { printf 'FAIL %s\n' "$*" | tee -a "$P/results.txt"; exit 1; }
# Runs a command that must fail; its output is in $P/last.log.
refused() {
  local what=$1; shift
  if "$@" > "$P/last.log" 2>&1; then cat "$P/last.log"; fail "$what: it was not refused"; fi
  sed 's/^/    /' "$P/last.log" | tail -8
}
installed() { rpm -q --qf '%{VERSION}-%{RELEASE}' "$PACKAGE"; }
upgrade() { dnf -y --refresh --repo="$REPOSITORY_ID" upgrade "$PACKAGE"; }
upload() { # tag file...: the release's assets, and its SHA256SUMS over the RPMs
  local tag=$1; shift
  rm -rf "$P/releases/$tag"; mkdir -p "$P/releases/$tag"; cp "$@" "$P/releases/$tag/"
}
sums() { (cd "$P/releases/$1" && sha256sum -- *.rpm > SHA256SUMS); }
serve() { echo "$1" > "$P/serve-ref"; }
# A commit on the repository branch with one change, published under a proof-only ref.
tampered_commit() { # ref, then a command run inside a checkout of the branch
  local ref=$1; shift
  rm -rf "$P/tamper"; git -C "$P/pkgrepo" worktree prune
  git -C "$P/pkgrepo" worktree add -q --detach "$P/tamper" "refs/heads/$BRANCH"
  (cd "$P/tamper" && "$@" && git add -A && git commit -q -m "tampered")
  git -C "$P/pkgrepo" update-ref "$ref" "$(git -C "$P/tamper" rev-parse HEAD)"
}

step "Tools in the container"
dnf -y -q install createrepo_c rpm-sign git-core openssl > /dev/null
rpm -q rpm dnf5 createrepo_c rpm-sign gnupg2 | tee -a "$P/results.txt"

step "A throwaway CA and the stand-in for GitHub's hosts"
mkdir -p "$P/tls" && cd "$P/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=AmpleFile proof CA" -keyout ca.key -out ca.pem 2> /dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=GitHub stand-in" -keyout host.key -out host.csr 2> /dev/null
printf 'subjectAltName=DNS:raw.githubusercontent.com,DNS:github.com,DNS:release-assets.githubusercontent.com\n' > host.ext
openssl x509 -req -in host.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile host.ext -out host.pem 2> /dev/null
cp ca.pem /etc/pki/ca-trust/source/anchors/amplefile-proof.pem && update-ca-trust
export NODE_EXTRA_CA_CERTS=$P/tls/ca.pem
cd "$P"
git init -q "$P/pkgrepo"
mkdir -p "$P/releases"
serve "refs/heads/$BRANCH"
python3 "$S/scripts/linux-package-repository-proof/server.py" tls/host.pem tls/host.key "$P/pkgrepo" "$P/serve-ref" "$P/releases" "$OWNER" "$REPO" "$BRANCH" > "$P/server.log" 2>&1 &
for _ in $(seq 50); do curl -s -o /dev/null https://github.com/ && break; sleep 0.2; done

step "The publish step's own checks"
"${PUBLISH[@]}" check
pass "check: tools present, and the secret key of the committed public key is in the keyring"

step "Sign build A ($TAG_A)"
"${PUBLISH[@]}" sign --tag "$TAG_A" --build-dir "$P/build-1"
{ rpmkeys -Kv "$RPM_A" || true; } | grep -qi 'signature.*NOKEY' && pass "A is signed; a computer without the key reports NOKEY" || fail "A is signed; a computer without the key reports NOKEY"

step "Prepare A before it is uploaded"
refused "prepare before upload" "${PUBLISH[@]}" prepare --tag "$TAG_A" --build-dir "$P/build-1" --git-dir "$P/pkgrepo" --no-fetch
grep -q 'answered 404' "$P/last.log" && pass "prepare refuses until the signed RPM is a release asset" || fail "prepare refuses until the signed RPM is a release asset"

step "Upload A and prepare the repository"
upload "$TAG_A" "$RPM_A"; sums "$TAG_A"
"${PUBLISH[@]}" prepare --tag "$TAG_A" --build-dir "$P/build-1" --git-dir "$P/pkgrepo" --no-fetch
git -C "$P/pkgrepo" ls-tree -r --name-only "refs/heads/$BRANCH" | tee "$P/branch-files.txt"
grep -qx README.md "$P/branch-files.txt" && grep -qx 'rpm/x86_64/repodata/repomd.xml.asc' "$P/branch-files.txt" && ! grep -q '\.rpm$' "$P/branch-files.txt" \
  && pass "the branch holds README.md and rpm/x86_64/repodata with repomd.xml.asc, and no RPM" || fail "the branch holds README.md and rpm/x86_64/repodata with repomd.xml.asc, and no RPM"
[ "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$RAW/rpm/x86_64/repodata/repomd.xml")" = "200 text/plain; charset=utf-8" ] \
  && [ "$(curl -s -o /dev/null -w '%{http_code}' "$RAW/rpm/x86_64/repodata/")" = 404 ] \
  && pass "the stand-in serves branch files as text/plain with no directory listing" || fail "the stand-in serves branch files as text/plain with no directory listing"

step "Install A from the RPM file"
dnf -y -q install "$RPM_A"
[ "$(installed)" = "$VERSION-1" ] || fail "A is not installed"
rpm -qc "$PACKAGE" | grep -qx "$ENTRY" || fail "$ENTRY is not a config file of $PACKAGE"
rpm -q --qf '[%{FILENAMES} %{FILEFLAGS:fflags}\n]' "$PACKAGE" | grep -E "^($ENTRY|$KEY) " | tee -a "$P/results.txt"
[ "$(sha256sum < "$KEY")" = "$(sha256sum < "$S/desktop/linux/RPM-GPG-KEY-$REPOSITORY_ID")" ] || fail "the installed key is not the committed key"
grep -qx gpgcheck=1 "$ENTRY" && grep -qx repo_gpgcheck=1 "$ENTRY" && grep -qx "baseurl=https://raw.githubusercontent.com/$OWNER/$REPO/$BRANCH/rpm/\$basearch" "$ENTRY" || fail "the entry is not the checked entry"
dnf repolist --enabled | grep -q "^$REPOSITORY_ID " || fail "dnf does not list the repository"
pass "installing A enrolled the computer: $ENTRY (%config(noreplace), gpgcheck=1, repo_gpgcheck=1) and $KEY"
node "$S/scripts/linux-package-repository-proof/watch.mjs" "$UPDATES" once | tee "$P/about-a.txt"
grep -q "updates arrive with your system's software updates" "$P/about-a.txt" && pass "Settings → About would say updates arrive with the system's software updates" || fail "Settings → About would say updates arrive with the system's software updates"
# The person's own change to the entry, which upgrades must keep.
sed -i 's/^metadata_expire=6h$/metadata_expire=1m/' "$ENTRY"

step "dnf reads A's repository: key import, metadata signature, nothing to upgrade"
dnf -y --refresh --repo="$REPOSITORY_ID" check-upgrade 2>&1 | tee "$P/check-a.log"
rpm -q gpg-pubkey --qf '%{SUMMARY}\n' | tee -a "$P/results.txt"
pass "dnf imported the key from $KEY, verified repomd.xml.asc, and found A up to date"

step "Sign build B ($TAG_B) and refuse wrong uploads"
"${PUBLISH[@]}" sign --tag "$TAG_B" --build-dir "$P/build-2"
refused "prepare B before upload" "${PUBLISH[@]}" prepare --tag "$TAG_B" --build-dir "$P/build-2" --git-dir "$P/pkgrepo" --no-fetch
grep -q 'answered 404' "$P/last.log" && pass "prepare B refuses before upload" || fail "prepare B refuses before upload"
mkdir -p "$P/releases/$TAG_B"; cp "$RPM_A" "$P/releases/$TAG_B/$(basename "$RPM_B")"; sums "$TAG_B"
refused "prepare B with other bytes uploaded" "${PUBLISH[@]}" prepare --tag "$TAG_B" --build-dir "$P/build-2" --git-dir "$P/pkgrepo" --no-fetch
grep -q 'is not the local signed RPM' "$P/last.log" && pass "prepare refuses a release asset that is not the local signed RPM" || fail "prepare refuses a release asset that is not the local signed RPM"
cp "$RPM_B" "$P/releases/$TAG_B/"
refused "prepare B with a stale SHA256SUMS" "${PUBLISH[@]}" prepare --tag "$TAG_B" --build-dir "$P/build-2" --git-dir "$P/pkgrepo" --no-fetch
grep -q "SHA256SUMS lists" "$P/last.log" && pass "prepare refuses when the release's SHA256SUMS does not list the signed RPM" || fail "prepare refuses when the release's SHA256SUMS does not list the signed RPM"
sums "$TAG_B"
"${PUBLISH[@]}" prepare --tag "$TAG_B" --build-dir "$P/build-2" --git-dir "$P/pkgrepo" --no-fetch
[ "$(git -C "$P/pkgrepo" rev-list --count "refs/heads/$BRANCH")" = 2 ] && pass "B's repository content is a second commit on the branch" || fail "B's repository content is a second commit on the branch"
refused "prepare B again" "${PUBLISH[@]}" prepare --tag "$TAG_B" --build-dir "$P/build-2" --git-dir "$P/pkgrepo" --no-fetch
grep -q 'is not newer' "$P/last.log" || fail "B again was refused for another reason"
refused "prepare A after B" "${PUBLISH[@]}" prepare --tag "$TAG_A" --build-dir "$P/build-1" --git-dir "$P/pkgrepo" --no-fetch
grep -q "already lists $PACKAGE $VERSION-2; $VERSION-1 is not newer" "$P/last.log" && pass "prepare refuses a version-release that is not higher than the listed one" || fail "prepare refuses a version-release that is not higher than the listed one"

step "Tampered metadata: repomd.xml changed, its signature not"
tampered_commit refs/proof/tampered-metadata sed -i -E 's#<revision>([0-9]+)</revision>#<revision>1\1</revision>#' rpm/x86_64/repodata/repomd.xml
serve refs/proof/tampered-metadata
# skip_if_unavailable=True: dnf reports the bad signature and skips the
# repository rather than failing the rest of the upgrade.
upgrade > "$P/last.log" 2>&1 || true
sed 's/^/    /' "$P/last.log" | grep -Ei 'signature|amplefile' | tail -4
[ "$(installed)" = "$VERSION-1" ] && grep -Eiq 'repomd.xml GPG signature verification error' "$P/last.log" && pass "dnf rejects repository metadata whose signature does not verify and skips the repository; A stays installed" || fail "dnf rejects repository metadata whose signature does not verify and skips the repository; A stays installed"

step "Tampered RPM: bytes changed after signing, metadata regenerated and signed to match"
mkdir -p "$P/tampered/x86_64" "$P/releases/tampered" "$P/build-tampered"
cp "$RPM_B" "$P/tampered/x86_64/"
TAMPERED=$P/tampered/x86_64/$(basename "$RPM_B")
python3 -c 'import sys; p=sys.argv[1]; b=bytearray(open(p,"rb").read()); i=len(b)*3//5; b[i]^=0xFF; open(p,"wb").write(b)' "$TAMPERED"
cp "$TAMPERED" "$P/build-tampered/"
refused "signing a tampered RPM" "${PUBLISH[@]}" sign --tag "$TAG_B" --build-dir "$P/build-tampered"
pass "the publish step refuses an RPM whose signature the committed key does not verify"
cp "$TAMPERED" "$P/releases/tampered/"
createrepo_c --quiet --baseurl "https://github.com/$OWNER/$REPO/releases/download/tampered/" --general-compress-type=gz --no-database "$P/tampered/x86_64"
rm "$TAMPERED"
FINGERPRINT=$(gpg --with-colons --list-secret-keys | awk -F: '/^fpr/{print $10; exit}')
gpg --batch --yes --local-user "$FINGERPRINT" --armor --detach-sign "$P/tampered/x86_64/repodata/repomd.xml"
tampered_commit refs/proof/tampered-rpm sh -c "rm -rf rpm/x86_64/repodata && cp -r '$P/tampered/x86_64/repodata' rpm/x86_64/repodata"
serve refs/proof/tampered-rpm
refused "upgrade to a tampered RPM" upgrade
[ "$(installed)" = "$VERSION-1" ] && grep -Eiq 'signature|digest|gpg|pgp' "$P/last.log" && pass "dnf refuses a package whose signature does not verify, though the signed metadata lists it; A stays installed" || fail "dnf refuses a package whose signature does not verify, though the signed metadata lists it; A stays installed"

step "Upgrade to B through the repository, with AmpleFile 'running'"
serve "refs/heads/$BRANCH"
node "$S/scripts/linux-package-repository-proof/watch.mjs" "$UPDATES" watch "$P/statuses.jsonl" 120 &
WATCHER=$!
sleep 2
upgrade 2>&1 | tee "$P/upgrade.log"
[ "$(installed)" = "$VERSION-2" ] || fail "B was not installed"
rpm -qi "$PACKAGE" | grep -i '^Signature' | tee -a "$P/results.txt"
pass "dnf upgraded A to B from the repository with gpgcheck=1 and repo_gpgcheck=1"
grep -qx metadata_expire=1m "$ENTRY" && pass "the upgrade kept the person's change to $ENTRY" || fail "the upgrade kept the person's change to $ENTRY"
for _ in $(seq 20); do grep -q '"phase":"ready"' "$P/statuses.jsonl" 2> /dev/null && break; sleep 0.5; done
kill "$WATCHER" 2> /dev/null || true
tail -1 "$P/statuses.jsonl" | tee -a "$P/results.txt"
tail -1 "$P/statuses.jsonl" | grep -q '"phase":"ready"' && pass "the running app's watcher saw its installed files replaced and offers the restart" || fail "the running app's watcher saw its installed files replaced and offers the restart"

step "A person who turns the repository off keeps that choice"
sed -i 's/^enabled=1$/enabled=0/' "$ENTRY"
dnf -y -q reinstall "$RPM_B"
grep -qx enabled=0 "$ENTRY" && ! dnf repolist --enabled | grep -q "^$REPOSITORY_ID " && pass "a reinstall keeps enabled=0, and dnf no longer checks the repository" || fail "a reinstall keeps enabled=0, and dnf no longer checks the repository"
node "$S/scripts/linux-package-repository-proof/watch.mjs" "$UPDATES" once | tee "$P/about-off.txt"
grep -q '"installation":null' "$P/about-off.txt" && pass "with the repository off, AmpleFile keeps the wording of a build without updates" || fail "with the repository off, AmpleFile keeps the wording of a build without updates"

step "Done"
cat "$P/results.txt"
