// The Fedora package repository that keeps an installed AmpleFile RPM up to
// date with the rest of the system (docs/linux-build.md, "Package
// repository"). Its address and names are decided here, once, from
// src/shared/product-identity.json, for the builder configuration
// (CommonJS), the build, the package verifier, and the publish step.
//
// Installing the RPM enrols the computer: the package carries the dnf
// repository entry and the public signing key. A build carries them exactly
// when the public key is committed at `committedPublicKey`; without it the RPM
// is built as before, with no repository entry at all. The entry always
// checks both the package and the repository metadata signatures; there is
// no unsigned or unchecked form.

const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

/** How a Linux prerelease tag names the version and, for a later build of it, the RPM release. */
const LINUX_PRERELEASE_TAG = /^linux-test-(\d+\.\d+\.\d+)(?:-([2-9]|[1-9]\d+))?$/;
/** The environment variable the build reads the RPM release from. */
const RPM_RELEASE_VARIABLE = "AMPLEFILE_LINUX_RPM_RELEASE";

function resolveLinuxPackageRepository(identity) {
  const id = text(identity.linuxPackageRepositoryId);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid linuxPackageRepositoryId ${JSON.stringify(id)}.`);
  const url = text(identity.linuxPackageRepositoryUrl);
  const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/([a-z0-9][a-z0-9/_-]*)\/\$basearch$/.exec(url);
  if (!match) {
    throw new Error(`linuxPackageRepositoryUrl must be https://raw.githubusercontent.com/OWNER/REPO/BRANCH/FOLDER/$basearch, not ${JSON.stringify(url)}.`);
  }
  const [, owner, repo, branch, folder] = match;
  if (owner !== identity.sourceRepositoryOwner || repo !== identity.sourceRepositoryName) {
    throw new Error(`The Linux package repository must live in ${identity.sourceRepositoryOwner}/${identity.sourceRepositoryName}, not ${owner}/${repo}.`);
  }
  return Object.freeze({
    id,
    name: `${identity.productName} Linux preview builds`,
    /** dnf's baseurl, with dnf's own `$basearch` left for dnf to fill in. */
    url,
    owner,
    repo,
    /** The branch of the source repository that holds only the generated repository files. */
    branch,
    /** The branch folder for one architecture, for example `rpm/x86_64`. */
    architectureFolder: (arch) => `${folder}/${arch}`,
    /** Where the RPM installs the dnf repository entry (a config file an upgrade keeps). */
    repositoryFile: `/etc/yum.repos.d/${id}.repo`,
    /** Where the RPM installs the public signing key. */
    publicKeyFile: `/etc/pki/rpm-gpg/RPM-GPG-KEY-${id}`,
    /** The committed public key, relative to the source checkout. Enrolment depends on it. */
    committedPublicKey: `desktop/linux/RPM-GPG-KEY-${id}`,
    /** Where the RPM for a release tag is downloaded: the GitHub Release asset folder. */
    releaseDownloadBase: (tag) => `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/`,
  });
}

/**
 * The dnf repository entry the RPM installs. Package and metadata signatures
 * are both checked against the key the same RPM installs. A repository that
 * cannot be reached is skipped, so a GitHub outage never stops the rest of a
 * system upgrade.
 */
function repositoryEntry(identity) {
  const repository = resolveLinuxPackageRepository(identity);
  return [
    `# ${identity.productName} for Fedora, installed by the ${identity.packageName} package.`,
    "# dnf checks this repository with the rest of the system's updates. Set",
    "# enabled=0 to stop; an upgrade keeps your change.",
    `[${repository.id}]`,
    `name=${repository.name}`,
    `baseurl=${repository.url}`,
    "type=rpm-md",
    "enabled=1",
    "gpgcheck=1",
    "repo_gpgcheck=1",
    `gpgkey=file://${repository.publicKeyFile}`,
    "skip_if_unavailable=True",
    "metadata_expire=6h",
    "",
  ].join("\n");
}

/** The RPM release for a build: a positive whole number, 1 when unset. */
function linuxRpmRelease(value) {
  const release = text(value) || "1";
  if (!/^[1-9]\d{0,5}$/.test(release)) throw new Error(`${RPM_RELEASE_VARIABLE} must be a whole number from 1, not ${JSON.stringify(value)}.`);
  return release;
}

/** `linux-test-0.1.8` is 0.1.8 release 1; `linux-test-0.1.8-2` is 0.1.8 release 2. */
function linuxPrereleaseTag(tag) {
  const match = LINUX_PRERELEASE_TAG.exec(text(tag));
  if (!match) throw new Error(`A Linux prerelease tag is linux-test-X.Y.Z or linux-test-X.Y.Z-N (N from 2), not ${JSON.stringify(tag)}.`);
  return Object.freeze({ tag: match[0], version: match[1], release: match[2] ?? "1" });
}

/** The RPM asset's file name. It carries the release, so two builds of one version never share a name. */
function rpmArtifactName(identity, version, release) {
  return `${identity.productName}-${version}-${linuxRpmRelease(release)}-linux-x86_64.rpm`;
}

/** Problems with the committed public key file; it must hold one armored public key block and nothing secret. */
function publicKeyProblems(content) {
  const problems = [];
  if (/PRIVATE KEY/.test(content)) problems.push("contains a private key; commit only the public key (gpg --export --armor)");
  const blocks = content.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/g) ?? [];
  if (blocks.length !== 1) problems.push(`must hold exactly one armored public key block, found ${blocks.length}`);
  return problems;
}

/**
 * Whether this checkout builds an enrolling RPM: true exactly when the public
 * key is committed. A key file that is present but wrong stops the build.
 */
function linuxRpmEnrolment(root, identity, { fileExists = existsSync, readText = (file) => readFileSync(file, "utf8") } = {}) {
  const repository = resolveLinuxPackageRepository(identity);
  const keyPath = path.join(root, repository.committedPublicKey);
  if (!fileExists(keyPath)) {
    return Object.freeze({ enrolled: false, keyPath, repository, reason: `no public key at ${repository.committedPublicKey}` });
  }
  const problems = publicKeyProblems(readText(keyPath));
  if (problems.length) throw new Error(`${repository.committedPublicKey} ${problems.join("; ")}.`);
  return Object.freeze({ enrolled: true, keyPath, repository, reason: null });
}

/**
 * Compares two RPM version or release strings the way rpm's rpmvercmp does
 * (without tilde and caret, which AmpleFile versions never use): returns -1,
 * 0, or 1.
 */
function rpmVersionCompare(left, right) {
  if (left === right) return 0;
  const segments = (value) => text(value).match(/[0-9]+|[A-Za-z]+/g) ?? [];
  const a = segments(left);
  const b = segments(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    const xNumeric = /^\d/.test(x);
    const yNumeric = /^\d/.test(y);
    // A numeric segment is newer than an alphabetic one.
    if (xNumeric !== yNumeric) return xNumeric ? 1 : -1;
    if (xNumeric) {
      const xs = x.replace(/^0+/, "");
      const ys = y.replace(/^0+/, "");
      if (xs.length !== ys.length) return xs.length > ys.length ? 1 : -1;
      if (xs !== ys) return xs > ys ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length > b.length ? 1 : -1;
}

/** Compares epoch:version-release triples; a missing epoch is 0. */
function rpmEvrCompare(left, right) {
  const epoch = Math.sign(Number(left.epoch ?? 0) - Number(right.epoch ?? 0));
  if (epoch) return epoch;
  return rpmVersionCompare(left.version, right.version) || rpmVersionCompare(left.release, right.release);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  LINUX_PRERELEASE_TAG,
  RPM_RELEASE_VARIABLE,
  linuxPrereleaseTag,
  linuxRpmEnrolment,
  linuxRpmRelease,
  publicKeyProblems,
  repositoryEntry,
  resolveLinuxPackageRepository,
  rpmArtifactName,
  rpmEvrCompare,
  rpmVersionCompare,
};
