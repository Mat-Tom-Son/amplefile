import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRpmFileFlags, repositoryEntryProblems, rpmEnrolmentProblems } from "../scripts/verify-linux-packages.mjs";
import {
  assertDownloadBaseAllowed,
  assertNewerThanListed,
  gitCommonDirectory,
  branchReadme,
  listedChecksum,
  missingTools,
  parseArguments,
  primaryFingerprint,
  primaryLocation,
  primaryPackages,
  signatureState,
  validSignatureKeys,
  withChecksum,
} from "../scripts/publish-linux-package-repository.mjs";

const require = createRequire(import.meta.url);
const repositoryLane = require("../scripts/linux-package-repository.cjs");
const identity = require("../src/shared/product-identity.json");
const builderPath = require.resolve("../electron-builder.desktop.cjs");
const publicKey = "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQINBGfake\n=abcd\n-----END PGP PUBLIC KEY BLOCK-----\n";

function loadBuilder(release?: string) {
  const previous = process.env.AMPLEFILE_LINUX_RPM_RELEASE;
  if (release === undefined) delete process.env.AMPLEFILE_LINUX_RPM_RELEASE;
  else process.env.AMPLEFILE_LINUX_RPM_RELEASE = release;
  delete require.cache[builderPath];
  try {
    return require(builderPath);
  } finally {
    if (previous === undefined) delete process.env.AMPLEFILE_LINUX_RPM_RELEASE;
    else process.env.AMPLEFILE_LINUX_RPM_RELEASE = previous;
    delete require.cache[builderPath];
  }
}

test("the package repository address lives once, in the product identity", () => {
  const repository = repositoryLane.resolveLinuxPackageRepository(identity);
  assert.equal(repository.url, "https://raw.githubusercontent.com/Mat-Tom-Son/amplefile/linux-package-repository/rpm/$basearch");
  assert.equal(repository.branch, "linux-package-repository");
  assert.equal(repository.architectureFolder("x86_64"), "rpm/x86_64");
  assert.equal(repository.repositoryFile, "/etc/yum.repos.d/amplefile.repo");
  assert.equal(repository.publicKeyFile, "/etc/pki/rpm-gpg/RPM-GPG-KEY-amplefile");
  assert.equal(repository.committedPublicKey, "desktop/linux/RPM-GPG-KEY-amplefile");
  assert.equal(repository.releaseDownloadBase("linux-test-0.1.8-2"), "https://github.com/Mat-Tom-Son/amplefile/releases/download/linux-test-0.1.8-2/");
  assert.throws(() => repositoryLane.resolveLinuxPackageRepository({ ...identity, linuxPackageRepositoryUrl: "https://example.com/rpm/$basearch" }), /raw\.githubusercontent\.com/);
  assert.throws(() => repositoryLane.resolveLinuxPackageRepository({ ...identity, linuxPackageRepositoryUrl: "https://raw.githubusercontent.com/someone/else/branch/rpm/$basearch" }), /must live in Mat-Tom-Son\/amplefile/);
});

test("the repository entry always checks package and metadata signatures", () => {
  const entry = repositoryLane.repositoryEntry(identity);
  assert.match(entry, /^\[amplefile\]$/m);
  assert.match(entry, /^baseurl=https:\/\/raw\.githubusercontent\.com\/Mat-Tom-Son\/amplefile\/linux-package-repository\/rpm\/\$basearch$/m);
  assert.match(entry, /^gpgcheck=1$/m);
  assert.match(entry, /^repo_gpgcheck=1$/m);
  assert.match(entry, /^gpgkey=file:\/\/\/etc\/pki\/rpm-gpg\/RPM-GPG-KEY-amplefile$/m);
  assert.match(entry, /^skip_if_unavailable=True$/m, "a GitHub outage never stops the rest of a system upgrade");
  assert.deepEqual(repositoryEntryProblems(entry), []);
  assert.ok(repositoryEntryProblems(entry.replace("repo_gpgcheck=1", "repo_gpgcheck=0")).some(problem => /repo_gpgcheck/.test(problem)));
  assert.ok(repositoryEntryProblems(entry.replace("gpgcheck=1\n", "")).some(problem => /\] gpgcheck is null/.test(problem)));
  assert.ok(repositoryEntryProblems(entry.replace(/^gpgkey=.*$/m, "gpgkey=https://example.com/key")).some(problem => /gpgkey/.test(problem)));
  assert.deepEqual(repositoryEntryProblems("# nothing\n"), ["has no repository section"]);
});

test("the RPM release comes from the tag, defaults to 1, and is in the asset name", () => {
  assert.equal(repositoryLane.linuxRpmRelease(undefined), "1");
  assert.equal(repositoryLane.linuxRpmRelease(""), "1");
  assert.equal(repositoryLane.linuxRpmRelease("2"), "2");
  for (const bad of ["0", "01", "-1", "2a", "1.1"]) assert.throws(() => repositoryLane.linuxRpmRelease(bad), /whole number/);
  assert.deepEqual({ ...repositoryLane.linuxPrereleaseTag("linux-test-0.1.8") }, { tag: "linux-test-0.1.8", version: "0.1.8", release: "1" });
  assert.deepEqual({ ...repositoryLane.linuxPrereleaseTag("linux-test-0.1.8-2") }, { tag: "linux-test-0.1.8-2", version: "0.1.8", release: "2" });
  for (const bad of ["v0.1.8", "linux-test-0.1", "linux-test-0.1.8-1", "linux-test-0.1.8-x", "linux-test-0.1.8-0"]) {
    assert.throws(() => repositoryLane.linuxPrereleaseTag(bad), /linux-test-X\.Y\.Z/);
  }
  assert.equal(repositoryLane.rpmArtifactName(identity, "0.1.8", "2"), "AmpleFile-0.1.8-2-linux-x86_64.rpm");
});

test("the builder sets the RPM release and leaves the DEB and AppImage as they were", () => {
  const plain = loadBuilder();
  assert.equal(plain.rpm.artifactName, "AmpleFile-${version}-1-linux-x86_64.rpm");
  const iteration = plain.rpm.fpm.indexOf("--iteration");
  assert.equal(plain.rpm.fpm[iteration + 1], "1");
  assert.equal(plain.deb.artifactName, undefined);
  assert.ok(!plain.deb.fpm.includes("--iteration"));
  assert.equal(plain.artifactName, "AmpleFile-${version}-${os}-${arch}.${ext}");
  const second = loadBuilder("2");
  assert.equal(second.rpm.artifactName, "AmpleFile-${version}-2-linux-x86_64.rpm");
  assert.equal(second.rpm.fpm[second.rpm.fpm.indexOf("--iteration") + 1], "2");
  assert.throws(() => loadBuilder("two"), /AMPLEFILE_LINUX_RPM_RELEASE/);
  // This checkout has no committed key yet, so its RPM carries no entry.
  const committed = repositoryLane.linuxRpmEnrolment(join(import.meta.dirname, ".."), identity).enrolled;
  assert.equal(plain.rpm.fpm.includes("--config-files"), committed);
  assert.equal(plain.rpm.fpm.some((item: string) => item.endsWith("=/etc/yum.repos.d/amplefile.repo")), committed);
});

test("enrolment follows the committed public key exactly, and refuses anything secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-package-repository-"));
  try {
    const keyPath = join(root, "desktop/linux/RPM-GPG-KEY-amplefile");
    const absent = repositoryLane.linuxRpmEnrolment(root, identity);
    assert.equal(absent.enrolled, false);
    assert.match(absent.reason, /no public key at desktop\/linux\/RPM-GPG-KEY-amplefile/);
    await mkdir(join(root, "desktop/linux"), { recursive: true });
    await writeFile(keyPath, publicKey);
    assert.equal(repositoryLane.linuxRpmEnrolment(root, identity).enrolled, true);
    await writeFile(keyPath, `${publicKey}-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----\n`);
    assert.throws(() => repositoryLane.linuxRpmEnrolment(root, identity), /private key/);
    await writeFile(keyPath, `${publicKey}${publicKey}`);
    assert.throws(() => repositoryLane.linuxRpmEnrolment(root, identity), /exactly one armored public key block, found 2/);
    await writeFile(keyPath, "not a key");
    assert.throws(() => repositoryLane.linuxRpmEnrolment(root, identity), /found 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the package verifier checks an enrolling RPM's entry and key, and an unenrolled RPM's absence of both", () => {
  const repository = repositoryLane.resolveLinuxPackageRepository(identity);
  const entry = repositoryLane.repositoryEntry(identity);
  const flags = parseRpmFileFlags(`/opt/AmpleFile/amplefile-desktop\t\n${repository.repositoryFile}\tcn\n${repository.publicKeyFile}\t\n`);
  assert.equal(flags.get(repository.repositoryFile), "cn");
  const files: Record<string, string> = { [repository.repositoryFile]: entry, [repository.publicKeyFile]: publicKey };
  const base = { enrolled: true, repository, fileFlags: flags, readInstalled: (path: string) => files[path] ?? null, expectedEntry: entry, expectedKey: publicKey };
  assert.deepEqual(rpmEnrolmentProblems(base), []);
  assert.match(rpmEnrolmentProblems({ ...base, fileFlags: new Map([...flags, [repository.repositoryFile, "c"]]) }).join(), /not %config\(noreplace\)/);
  assert.match(rpmEnrolmentProblems({ ...base, fileFlags: new Map([...flags, [repository.publicKeyFile, "c"]]) }).join(), /must be able to replace the key/);
  assert.match(rpmEnrolmentProblems({ ...base, expectedKey: "other" }).join(), /not the committed public key/);
  assert.match(rpmEnrolmentProblems({ ...base, readInstalled: (path: string) => path === repository.repositoryFile ? entry.replace("repo_gpgcheck=1", "repo_gpgcheck=0") : publicKey }).join(), /repo_gpgcheck/);
  assert.match(rpmEnrolmentProblems({ ...base, fileFlags: new Map() }).join(), /does not carry the repository entry/);
  assert.deepEqual(rpmEnrolmentProblems({ ...base, enrolled: false, fileFlags: new Map() }), []);
  assert.match(rpmEnrolmentProblems({ ...base, enrolled: false }).join(), /although no public key is committed/);
});

test("RPM versions compare the way rpm does", () => {
  const { rpmVersionCompare, rpmEvrCompare } = repositoryLane;
  assert.equal(rpmVersionCompare("0.2.1", "0.2.1"), 0);
  assert.equal(rpmVersionCompare("0.2.10", "0.2.9"), 1);
  assert.equal(rpmVersionCompare("0.2.9", "0.2.10"), -1);
  assert.equal(rpmVersionCompare("1.0", "1.0.1"), -1);
  assert.equal(rpmVersionCompare("1.01", "1.1"), 0);
  assert.equal(rpmVersionCompare("1.0a", "1.0"), 1);
  assert.equal(rpmVersionCompare("2", "10"), -1);
  assert.equal(rpmEvrCompare({ version: "0.1.8", release: "2" }, { version: "0.1.8", release: "1" }), 1);
  assert.equal(rpmEvrCompare({ version: "0.1.9", release: "1" }, { version: "0.1.8", release: "3" }), 1);
  assert.equal(rpmEvrCompare({ version: "0.1.8", release: "1" }, { version: "0.1.8", release: "1" }), 0);
  assert.equal(rpmEvrCompare({ epoch: "1", version: "0.1", release: "1" }, { version: "9.9", release: "9" }), 1);
});

const primaryXml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://linux.duke.edu/metadata/common" packages="1">
<package type="rpm">
  <name>amplefile-desktop</name>
  <arch>x86_64</arch>
  <version epoch="0" ver="0.1.8" rel="2"/>
  <checksum type="sha256" pkgid="YES">${"a".repeat(64)}</checksum>
  <location xml:base="https://github.com/Mat-Tom-Son/amplefile/releases/download/linux-test-0.1.8-2/" href="AmpleFile-0.1.8-2-linux-x86_64.rpm"/>
</package>
</metadata>`;

test("prepare refuses a build that is not newer than the one the branch lists", () => {
  const listed = primaryPackages(primaryXml);
  assert.deepEqual(listed, [{
    name: "amplefile-desktop", arch: "x86_64", epoch: "0", version: "0.1.8", release: "2", sha256: "a".repeat(64),
    base: "https://github.com/Mat-Tom-Son/amplefile/releases/download/linux-test-0.1.8-2/", href: "AmpleFile-0.1.8-2-linux-x86_64.rpm",
  }]);
  const candidate = (version: string, release: string) => ({ name: "amplefile-desktop", epoch: "0", version, release });
  assert.throws(() => assertNewerThanListed(candidate("0.1.8", "2"), listed), /already lists amplefile-desktop 0\.1\.8-2; 0\.1\.8-2 is not newer/);
  assert.throws(() => assertNewerThanListed(candidate("0.1.8", "1"), listed), /is not newer/);
  assert.throws(() => assertNewerThanListed(candidate("0.1.7", "9"), listed), /is not newer/);
  assert.doesNotThrow(() => assertNewerThanListed(candidate("0.1.8", "3"), listed));
  assert.doesNotThrow(() => assertNewerThanListed(candidate("0.1.9", "1"), listed));
  assert.doesNotThrow(() => assertNewerThanListed(candidate("0.1.8", "1"), []), "an empty branch takes any build");
  assert.equal(primaryLocation('<repomd><data type="other"><location href="repodata/o.xml.gz"/></data><data type="primary">\n<location href="repodata/p.xml.gz"/></data></repomd>'), "repodata/p.xml.gz");
  assert.throws(() => primaryLocation("<repomd/>"), /no primary/);
});

test("signature checks accept only the committed key's verified signature", () => {
  const rpm6 = "x.rpm:\n    Header OpenPGP V4 RSA/SHA512 signature, key fingerprint: 087ac3c2: OK\n    Header SHA256 digest: OK\n    Payload SHA256 digest: OK\n";
  const rpm4 = "x.rpm:\n    Header V4 RSA/SHA256 Signature, key ID 0fbc35d2: OK\n    Header SHA256 digest: OK\n    Payload SHA256 digest: OK\n";
  assert.equal(signatureState(rpm6, 0), "ours");
  assert.equal(signatureState(rpm4, 0), "ours");
  assert.equal(signatureState("x.rpm:\n    Header SHA256 digest: OK\n    Payload SHA256 digest: OK\n", 0), "unsigned");
  assert.equal(signatureState(rpm6.replace(": OK\n    Header SHA256", ": NOKEY\n    Header SHA256"), 1), "other");
  assert.equal(signatureState(rpm6.replace("Payload SHA256 digest: OK", "Payload SHA256 digest: BAD (Expected abc != def)"), 1), "other");
  assert.equal(signatureState(rpm6, 1), "other");
  const fpr = "A".repeat(40);
  assert.deepEqual(validSignatureKeys(`[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG ${"B".repeat(40)} 2026-11-24 1795551157 0 4 0 1 10 00 ${fpr}\n`), [fpr]);
  assert.deepEqual(validSignatureKeys("[GNUPG:] BADSIG 0FBC35D2 x\n"), []);
  const colons = `pub:-:4096:1:E61A4D4F0FBC35D2:1795551157:::-:::scSC::::::23::0:\nfpr:::::::::${fpr}:\nuid:-::::1795551157::x::AmpleFile:::::::::0:\nsub:-:4096:1:1111:1795551157::::::e::::::23:\nfpr:::::::::${"C".repeat(40)}:\n`;
  assert.equal(primaryFingerprint(colons), fpr);
  assert.throws(() => primaryFingerprint(`${colons}${colons}`), /exactly one primary key; found 2/);
  assert.throws(() => primaryFingerprint(""), /found 0/);
});

test("the publish step names missing tools and their Fedora packages up front", () => {
  assert.deepEqual(missingTools(() => true), []);
  assert.deepEqual(missingTools((command: string) => !["rpmsign", "createrepo_c"].includes(command)), [
    { command: "rpmsign", package: "rpm-sign" },
    { command: "createrepo_c", package: "createrepo_c" },
  ]);
});

test("SHA256SUMS follows the signed RPM, and the branch README marks the branch as generated", () => {
  const name = "AmpleFile-0.1.8-2-linux-x86_64.rpm";
  const sums = `${"1".repeat(64)}  AmpleFile-0.1.8-linux-amd64.deb\n${"2".repeat(64)}  ${name}\n`;
  const signed = withChecksum(sums, name, "3".repeat(64));
  assert.equal(listedChecksum(signed, name), "3".repeat(64));
  assert.equal(listedChecksum(signed, "AmpleFile-0.1.8-linux-amd64.deb"), "1".repeat(64));
  assert.equal(signed.split("\n").filter(Boolean).length, 2);
  assert.equal(listedChecksum(withChecksum("", name, "4".repeat(64)), name), "4".repeat(64));
  assert.equal(listedChecksum(sums, "missing.rpm"), null);
  const repository = repositoryLane.resolveLinuxPackageRepository(identity);
  const readme = branchReadme({ identity, repository, tag: "linux-test-0.1.8-2", rpm: { version: "0.1.8", release: "2", arch: "x86_64" }, sha256: "3".repeat(64), fingerprint: "A".repeat(40) });
  assert.match(readme, /^# AmpleFile Linux package repository\n\nThis branch is generated\. It is not AmpleFile's source code/);
  assert.match(readme, /lists only the newest build/);
  assert.match(readme, /amplefile-desktop 0\.1\.8-2 \(x86_64\), from \[linux-test-0\.1\.8-2\]/);
  assert.match(readme, /The RPM itself is not on this branch/);
});

test("the publish step's arguments", () => {
  const prepare = parseArguments(["prepare", "--tag", "linux-test-0.1.8-2", "--no-fetch", "--download-base", "http://127.0.0.1:8080/x/"]);
  assert.equal(prepare.stage, "prepare");
  assert.equal(prepare.tag, "linux-test-0.1.8-2");
  assert.equal(prepare.fetch, false);
  assert.equal(prepare.remote, "origin");
  assert.equal(prepare.downloadBase, "http://127.0.0.1:8080/x/");
  assert.equal(parseArguments(["check"]).tag, null);
  assert.throws(() => parseArguments(["sign"]), /needs --tag/);
  assert.throws(() => parseArguments(["push", "--tag", "linux-test-0.1.8"]), /Usage/);
  assert.throws(() => parseArguments(["sign", "--tag", "v0.1.8"]), /linux-test-X\.Y\.Z/);
  assert.throws(() => parseArguments(["prepare", "--tag", "linux-test-0.1.8", "--download-base", "http://x"]), /ending in \//);
  assert.throws(() => parseArguments(["prepare", "--tag", "linux-test-0.1.8", "--force"]), /Unknown option/);
});

test("prepare refuses a stand-in download address unless it writes to a separate repository", async () => {
  const folder = await mkdtemp(join(tmpdir(), "amplefile-download-base-"));
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@invalid" } });
  try {
    const source = join(folder, "source");
    const scratch = join(folder, "scratch");
    const worktree = join(folder, "worktree");
    const plain = join(folder, "plain");
    git("init", "-q", source);
    git("-C", source, "commit", "-q", "--allow-empty", "-m", "first");
    git("-C", source, "worktree", "add", "-q", "--detach", worktree);
    git("init", "-q", scratch);
    await mkdir(plain);
    const check = (gitDir: string, downloadBase: string | null = "http://127.0.0.1:8080/x/") => () => assertDownloadBaseAllowed({ downloadBase, gitDir, sourceRoot: source, commonDirectory: gitCommonDirectory });
    assert.throws(check(source), /is for a local test server only, and --git-dir .* is this checkout's repository: its linux-package-repository branch would list packages at that address, one push away from every enrolled computer/);
    assert.throws(check(join(source, ".")), /one push away/, "the same folder by another spelling");
    assert.throws(check(worktree), /one push away/, "a worktree shares this checkout's branches");
    assert.throws(check(plain), /must name a separate scratch repository; .* is not a git repository/);
    assert.doesNotThrow(check(scratch));
    assert.doesNotThrow(check(source, null), "without --download-base the GitHub Release is used, and this checkout is the target");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
