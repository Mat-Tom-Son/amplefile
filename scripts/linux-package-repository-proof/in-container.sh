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

step "The installed app runs while dnf upgrades it to B"
serve "refs/heads/$BRANCH"
# A person's session: their own user, a display and a session bus that
# outlive any one AmpleFile process, so a relaunch has somewhere to open.
useradd -m -u 1000 proof
APP=/home/proof/amplefile-proof
runuser -u proof -- mkdir -p "$APP/state" "$APP/agent" "$APP/runtime"
chmod 700 "$APP/runtime"
Xvfb :77 -screen 0 1600x1000x24 -nolisten tcp > "$P/xvfb.log" 2>&1 &
BUS=$(runuser -u proof -- dbus-daemon --session --fork --nopidfile --print-address=1)
APP_ENV=(HOME=/home/proof PATH=/usr/bin:/bin DISPLAY=:77 "DBUS_SESSION_BUS_ADDRESS=$BUS" "XDG_RUNTIME_DIR=$APP/runtime" XDG_SESSION_TYPE=x11
  "AMPLEFILE_STATE_DIR=$APP/state" "AMPLEFILE_DESKTOP_STATE_DIR=$APP/state" "AMPLEFILE_CLI_STATE_DIR=$APP/state"
  "AMPLEFILE_AGENT_DIR=$APP/agent" "PI_CODING_AGENT_DIR=$APP/agent" AMPLEFILE_DISABLE_LOGIN_SHELL_ENV=1)
TOKEN=$APP/state/cli/act-token.json
drive() { node "$S/scripts/linux-package-repository-proof/app-driver.mjs" 9222 "$@"; }
# The main AmpleFile processes: the executable without Chromium's --type=.
main_pids() { ps -u proof -o pid=,args= | awk '$2 == "/opt/AmpleFile/amplefile-desktop" && $0 !~ /--type=/ { print $1 }'; }
field() { node -e 'const s = JSON.parse(process.argv[1]); console.log(String(s[process.argv[2]]))' "$1" "$2"; }
for _ in $(seq 30); do [ -e /tmp/.X11-unix/X77 ] && break; sleep 0.2; done
runuser -u proof -- env -i "${APP_ENV[@]}" setsid /opt/AmpleFile/amplefile-desktop --remote-debugging-port=9222 >> "$P/app.log" 2>&1 < /dev/null &
BEFORE=$(drive status 120) || { tail -40 "$P/app.log"; fail "the installed app did not open a window"; }
echo "    before: $BEFORE" | tee -a "$P/results.txt"
OLD_PID=$(main_pids)
[ "$(echo "$OLD_PID" | wc -w)" = 1 ] || fail "expected one AmpleFile main process, found: $OLD_PID"
[ "$(field "$BEFORE" phase)" = unsupported ] && [ "$(field "$BEFORE" supported)" = false ] && [ "$(field "$BEFORE" updatesFrom)" = system ] \
  && [ "$(field "$BEFORE" message)" = "AmpleFile updates arrive with your system's software updates." ] \
  && pass "the running app (pid $OLD_PID) says its updates arrive with the system's software updates, with no update button or indicator" \
  || fail "the running app's status before the upgrade"

upgrade 2>&1 | tee "$P/upgrade.log"
[ "$(installed)" = "$VERSION-2" ] || fail "B was not installed"
pass "dnf upgraded A to B from the repository with gpgcheck=1 and repo_gpgcheck=1, while AmpleFile ran"
grep -qx metadata_expire=1m "$ENTRY" && pass "the upgrade kept the person's change to $ENTRY" || fail "the upgrade kept the person's change to $ENTRY"
echo "    old process's archive: $(ls -l "/proc/$OLD_PID/fd" 2> /dev/null | grep -o '/opt/AmpleFile/resources/app.asar.*' | sort -u | head -1)" | tee -a "$P/results.txt"
FIRST=$(drive check) || fail "the status check after the upgrade did not answer"
READY=$(drive check) || fail "the second status check after the upgrade did not answer"
echo "    first look: $FIRST" | tee -a "$P/results.txt"
echo "    second look: $READY" | tee -a "$P/results.txt"
[ "$(field "$FIRST" phase)" = unsupported ] || fail "the first look after the upgrade already offered the restart"
[ "$(field "$READY" phase)" = ready ] && [ "$(field "$READY" supported)" = true ] && [ "$(field "$READY" updatesFrom)" = system ] \
  && { [ "$(field "$READY" message)" = "AmpleFile was updated. Restart AmpleFile to use the update." ] || [ "$(field "$READY" message)" = "AmpleFile $(field "$READY" availableVersion) was installed. Restart AmpleFile to use it." ]; } \
  && pass "after the upgrade, the second look makes the real app offer the restart (ready, updatesFrom system)" \
  || fail "the real app's status after the upgrade and two looks"
[ "$(main_pids)" = "$OLD_PID" ] && pass "offering the restart restarted nothing on its own" || fail "AmpleFile restarted without being asked"

step "Restart into B, as the person's confirmed click does"
drive install || fail "the install call did not reach the app"
for _ in $(seq 120); do kill -0 "$OLD_PID" 2> /dev/null || break; sleep 0.5; done
kill -0 "$OLD_PID" 2> /dev/null && { tail -40 "$P/app.log"; fail "the old AmpleFile process did not exit"; }
pass "the old AmpleFile process ($OLD_PID) exited"
NEW_PID=
for _ in $(seq 120); do NEW_PID=$(main_pids); [ -n "$NEW_PID" ] && break; sleep 0.5; done
[ "$(echo "$NEW_PID" | wc -w)" = 1 ] || { tail -40 "$P/app.log"; fail "expected one relaunched AmpleFile process, found: '$NEW_PID'"; }
AFTER=$(drive status 120) || { tail -40 "$P/app.log"; fail "the relaunched app did not open a window"; }
EXE=$(readlink "/proc/$NEW_PID/exe" || true)
ARCHIVE=$(ls -l "/proc/$NEW_PID/fd" 2> /dev/null | grep -o '/opt/AmpleFile/resources/app.asar.*' | sort -u | head -1 || true)
echo "    relaunched pid $NEW_PID: exe $EXE, archive $ARCHIVE" | tee -a "$P/results.txt"
echo "    after: $AFTER" | tee -a "$P/results.txt"
[ "$EXE" = /opt/AmpleFile/amplefile-desktop ] && { [ -z "$ARCHIVE" ] || [ "$ARCHIVE" = /opt/AmpleFile/resources/app.asar ]; } \
  && pass "a new AmpleFile process ($NEW_PID) started from the installed B files" || fail "the relaunched process does not run the installed files"
LOOK1=$(drive check) || fail "the relaunched app's status check did not answer"
LOOK2=$(drive check) || fail "the relaunched app's second status check did not answer"
echo "    relaunched, two looks later: $LOOK2" | tee -a "$P/results.txt"
[ "$(field "$AFTER" phase)" = unsupported ] && [ "$(field "$LOOK1" phase)" = unsupported ] && [ "$(field "$LOOK2" phase)" = unsupported ] \
  && pass "the relaunched app says updates arrive with the system's again: no second ready status" || fail "the relaunched app offers a restart again"
sleep 15
[ "$(main_pids)" = "$NEW_PID" ] && pass "no restart loop: the same single process 15 seconds later" || fail "AmpleFile restarted again: $(main_pids)"

step "An ordinary quit, with a restart offered but not chosen"
# The person turns the repository off; dnf reinstalls B, replacing the files again.
sed -i 's/^enabled=1$/enabled=0/' "$ENTRY"
dnf -y -q reinstall "$RPM_B"
grep -qx enabled=0 "$ENTRY" && ! dnf repolist --enabled | grep -q "^$REPOSITORY_ID " && pass "a reinstall keeps enabled=0, and dnf no longer checks the repository" || fail "a reinstall keeps enabled=0, and dnf no longer checks the repository"
drive check > /dev/null || fail "the status check after the reinstall did not answer"
OFFERED=$(drive check) || fail "the second status check after the reinstall did not answer"
echo "    after the reinstall: $OFFERED" | tee -a "$P/results.txt"
[ "$(field "$OFFERED" phase)" = ready ] || fail "the reinstall did not offer the restart"
[ -e "$TOKEN" ] && echo "    act token present before the quit" | tee -a "$P/results.txt"
kill -TERM "$NEW_PID"
for _ in $(seq 120); do kill -0 "$NEW_PID" 2> /dev/null || break; sleep 0.5; done
kill -0 "$NEW_PID" 2> /dev/null && fail "AmpleFile did not quit"
sleep 10
[ -z "$(main_pids)" ] && pass "an ordinary quit (SIGTERM, as at logout) ends AmpleFile and opens nothing again" || fail "AmpleFile opened again after an ordinary quit: $(main_pids)"
[ ! -e "$TOKEN" ] && pass "the quit ran AmpleFile's own shutdown (the CLI act token is gone)" || fail "the quit skipped AmpleFile's shutdown: $TOKEN remains"
node "$S/scripts/linux-package-repository-proof/watch.mjs" "$UPDATES" once | tee "$P/about-off.txt"
grep -q '"installation":null' "$P/about-off.txt" && pass "with the repository off, AmpleFile keeps the wording of a build without updates" || fail "with the repository off, AmpleFile keeps the wording of a build without updates"

step "Done"
cat "$P/results.txt"
