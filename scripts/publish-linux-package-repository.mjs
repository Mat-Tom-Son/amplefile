// Signs a built AmpleFile RPM and prepares the Fedora package repository
// that lists it (docs/linux-build.md, "Package repository"). Nothing here
// pushes, tags, or edits a GitHub release: the owner uploads the signed RPM
// and pushes the prepared branch.
//
//   npm run desktop:linux:repository -- check
//   npm run desktop:linux:repository -- sign --tag linux-test-X.Y.Z[-N]
//   npm run desktop:linux:repository -- prepare --tag linux-test-X.Y.Z[-N]
//
// Order, which this script enforces:
//   1. sign     signs out/linux's RPM with the key whose public half is
//               committed (by its fingerprint), verifies the signature
//               against that committed key, and rewrites the RPM's digest in
//               out/linux/SHA256SUMS and linux-build.json. The signed RPM is
//               the file the release carries.
//   2. (owner)  makes the release folder and SHA256SUMS from those files and
//               uploads them to the prerelease for the tag.
//   3. prepare  refuses unless the RPM is newer than the one the branch
//               lists, and unless the release asset and the release's
//               SHA256SUMS match the local signed RPM byte for byte; then
//               builds the metadata with createrepo_c pointing at the release
//               asset, signs repomd.xml (detached, armored), verifies it, and
//               commits the branch's complete new content locally.
//   4. (owner)  pushes the branch: the command is printed.
//
// Options: --build-dir DIR (default out/linux), --git-dir DIR (the checkout
// whose linux-package-repository branch is written; default this one),
// --remote NAME (default origin), --no-fetch (do not fetch the published
// branch first), --download-base URL (stand-in for the GitHub Release
// download folder, for a local test server only; prepare refuses it unless
// --git-dir is a separate repository).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRpmFileFlags } from "./verify-linux-packages.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const {
  linuxPrereleaseTag,
  linuxRpmEnrolment,
  repositoryEntry,
  rpmArtifactName,
  rpmEvrCompare,
} = require("./linux-package-repository.cjs");

/** What the publish step needs on the computer, and the Fedora package that provides it. */
export const requiredTools = Object.freeze([
  { command: "rpm", package: "rpm" },
  { command: "rpmkeys", package: "rpm" },
  { command: "rpmsign", package: "rpm-sign" },
  { command: "createrepo_c", package: "createrepo_c" },
  { command: "gpg", package: "gnupg2" },
  { command: "git", package: "git" },
]);

/** The tools missing from this computer, as `{ command, package }`. */
export function missingTools(have) {
  return requiredTools.filter(tool => !have(tool.command));
}

/** The one primary key fingerprint in `gpg --show-keys --with-colons` output. */
export function primaryFingerprint(colons) {
  const lines = colons.split("\n");
  const fingerprints = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("pub:")) continue;
    const fpr = lines.slice(index + 1).find(line => line.startsWith("fpr:"));
    if (fpr) fingerprints.push(fpr.split(":")[9]);
  }
  if (fingerprints.length !== 1 || !/^[0-9A-F]{40}([0-9A-F]{24})?$/.test(fingerprints[0] ?? "")) {
    throw new Error(`The committed public key must hold exactly one primary key; found ${fingerprints.length}.`);
  }
  return fingerprints[0];
}

/**
 * Reads `rpmkeys -Kv` output against a database holding only the committed
 * key: "ours" when a signature verifies, "unsigned" when there is none,
 * "other" when a signature does not verify with it (another key, or damage).
 */
export function signatureState(output, status) {
  const signatures = output.split("\n").filter(line => /signature/i.test(line));
  const digestsBad = output.split("\n").some(line => /digest/i.test(line) && !/:\s*OK\s*$/.test(line));
  if (digestsBad) return "other";
  if (!signatures.length) return status === 0 ? "unsigned" : "other";
  if (signatures.every(line => /:\s*OK\s*$/.test(line)) && status === 0) return "ours";
  return "other";
}

/** The `VALIDSIG` primary-key fingerprints in `gpg --status-fd` output. */
export function validSignatureKeys(status) {
  // [GNUPG:] VALIDSIG fpr date timestamp expiry version reserved algorithm hash class primary-fpr
  return status.split("\n")
    .map(line => line.trim().split(" "))
    .filter(parts => parts[0] === "[GNUPG:]" && parts[1] === "VALIDSIG")
    .map(parts => parts[11] ?? parts[2]);
}

/** The primary metadata's location in repomd.xml. */
export function primaryLocation(repomd) {
  const match = /<data type="primary">[\s\S]*?<location href="([^"]+)"/.exec(repomd);
  if (!match) throw new Error("repomd.xml lists no primary metadata.");
  return match[1];
}

function unescapeXml(value) {
  return value.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The packages in primary.xml: name, arch, epoch, version, release, sha256, location. */
export function primaryPackages(xml) {
  const packages = [];
  for (const [block] of xml.matchAll(/<package type="rpm">[\s\S]*?<\/package>/g)) {
    const name = /<name>([^<]*)<\/name>/.exec(block)?.[1];
    const arch = /<arch>([^<]*)<\/arch>/.exec(block)?.[1];
    const evr = /<version epoch="([^"]*)" ver="([^"]*)" rel="([^"]*)"\/>/.exec(block);
    const checksum = /<checksum type="sha256" pkgid="YES">([0-9a-f]{64})<\/checksum>/.exec(block)?.[1];
    const location = /<location(?: xml:base="([^"]*)")? href="([^"]*)"\/>/.exec(block);
    if (!name || !arch || !evr || !location) throw new Error("primary.xml has a package entry this script cannot read.");
    packages.push({
      name: unescapeXml(name), arch, epoch: evr[1] || "0", version: unescapeXml(evr[2]), release: unescapeXml(evr[3]),
      sha256: checksum ?? null, base: location[1] ? unescapeXml(location[1]) : null, href: unescapeXml(location[2]),
    });
  }
  return packages;
}

/** Refuses unless `candidate` is newer than every listed build of the same package. */
export function assertNewerThanListed(candidate, listed) {
  for (const item of listed.filter(entry => entry.name === candidate.name)) {
    if (rpmEvrCompare(candidate, item) <= 0) {
      throw new Error(`The repository already lists ${item.name} ${item.version}-${item.release}; ${candidate.version}-${candidate.release} is not newer. Every published build needs a higher version or release (tag linux-test-VERSION-N for a later build of one version).`);
    }
  }
}

/**
 * `--download-base` points the metadata at a stand-in for GitHub's release
 * downloads, for a local test server. Metadata with that address must never
 * land on this checkout's own linux-package-repository branch, one push away
 * from every enrolled computer, so it needs a `--git-dir` that is a different
 * repository. Worktrees share one repository: they are compared by their
 * common git directory, as `commonDirectory` resolves it.
 */
export function assertDownloadBaseAllowed({ downloadBase, gitDir, sourceRoot, commonDirectory }) {
  if (!downloadBase) return;
  const target = commonDirectory(gitDir);
  if (!target) throw new Error(`--download-base ${downloadBase} is for a local test server only, so --git-dir must name a separate scratch repository; ${gitDir} is not a git repository.`);
  if (target === commonDirectory(sourceRoot)) {
    throw new Error(`--download-base ${downloadBase} is for a local test server only, and --git-dir ${gitDir} is this checkout's repository: its linux-package-repository branch would list packages at that address, one push away from every enrolled computer. Pass --git-dir naming a separate scratch repository, or drop --download-base to use the GitHub Release for the tag.`);
  }
}

/** The absolute common git directory of the repository holding `directory`, or null. */
export function gitCommonDirectory(directory) {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  try { return realpathSync(result.stdout.trim()); } catch { return result.stdout.trim(); }
}

/** SHA256SUMS with `name`'s line set to `sha256`, added when missing. */
export function withChecksum(sums, name, sha256) {
  const lines = sums.split("\n").filter(Boolean).filter(line => !line.endsWith(`  ${name}`));
  lines.push(`${sha256}  ${name}`);
  return lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).map(line => `${line}\n`).join("");
}

/** The digest SHA256SUMS lists for `name`, or null. */
export function listedChecksum(sums, name) {
  const line = sums.split("\n").find(entry => entry.endsWith(`  ${name}`) || entry.endsWith(` *${name}`));
  return line ? line.slice(0, 64).toLowerCase() : null;
}

/** The README that marks the branch as the generated package repository. */
export function branchReadme({ identity, repository, tag, rpm, sha256, fingerprint }) {
  return `# ${identity.productName} Linux package repository

This branch is generated. It is not ${identity.productName}'s source code, and
nothing on it is edited by hand.

It is the Fedora package repository for the ${identity.productName} Linux
preview RPM: the signed dnf metadata under \`${repository.architectureFolder("x86_64")}/\`, which
dnf reads from

    ${repository.url}

Installing the ${identity.packageName} RPM enrols a computer: it adds
\`${repository.repositoryFile}\` and the public key
\`${repository.publicKeyFile}\`, and dnf then checks this repository with
the rest of the system's updates. dnf checks both the package signature and
the signature on \`repodata/repomd.xml\` (\`repomd.xml.asc\`).

The RPM itself is not on this branch. It is an asset of the GitHub prerelease
for its tag, and the metadata points there.

The repository lists only the newest build:

- ${identity.packageName} ${rpm.version}-${rpm.release} (${rpm.arch}), from [${tag}](https://github.com/${repository.owner}/${repository.repo}/releases/tag/${encodeURIComponent(tag)})
- \`${rpmArtifactName(identity, rpm.version, rpm.release)}\`, sha256 \`${sha256}\`
- signed with the key ${fingerprint}

\`npm run desktop:linux:repository -- prepare\` in the source repository
rewrites this whole branch for each build. See docs/linux-build.md there.
`;
}

function have(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function run(command, args, options = {}) {
  const result = capture(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const fileDigestAlgorithms = { 1: "md5", 2: "sha1", 8: "sha256", 9: "sha384", 10: "sha512", 11: "sha224" };

function rpmQuery(file) {
  const [name, epoch, version, release, arch] = run("rpm", ["-qp", "--qf", "%{NAME}\\t%{EPOCHNUM}\\t%{VERSION}\\t%{RELEASE}\\t%{ARCH}", file]).split("\t");
  return { name, epoch, version, release, arch };
}

/** Problems with the enrolment an RPM carries: the exact entry as %config(noreplace), and the committed key. */
function carriedEnrolmentProblems(file, identity, enrolment, committedKey) {
  const repository = enrolment.repository;
  const flags = parseRpmFileFlags(run("rpm", ["-qp", "--qf", "[%{FILENAMES}\\t%{FILEFLAGS:fflags}\\n]", file]));
  const digests = parseRpmFileFlags(run("rpm", ["-qp", "--qf", "[%{FILENAMES}\\t%{FILEDIGESTS}\\n]", file]));
  const algorithm = fileDigestAlgorithms[run("rpm", ["-qp", "--qf", "%{FILEDIGESTALGO}", file]).trim()] ?? "md5";
  const digest = (text) => createHash(algorithm).update(text).digest("hex");
  const problems = [];
  if (!flags.has(repository.repositoryFile)) problems.push(`it does not carry ${repository.repositoryFile}: build it with the public key committed`);
  else {
    if (!/c/.test(flags.get(repository.repositoryFile)) || !/n/.test(flags.get(repository.repositoryFile))) problems.push(`${repository.repositoryFile} is not %config(noreplace)`);
    if (digests.get(repository.repositoryFile) !== digest(repositoryEntry(identity))) problems.push(`${repository.repositoryFile} is not the entry this checkout generates`);
  }
  if (!flags.has(repository.publicKeyFile)) problems.push(`it does not carry ${repository.publicKeyFile}`);
  else if (digests.get(repository.publicKeyFile) !== digest(committedKey)) problems.push(`${repository.publicKeyFile} is not the committed public key`);
  return problems;
}

class Workspace {
  constructor(path) { this.path = path; this.homes = []; }
  static async create(parent) {
    await mkdir(parent, { recursive: true });
    return new Workspace(await mkdtemp(join(parent, "work-")));
  }
  /** A throwaway GnuPG home holding only the committed public key. */
  async keyHome(keyPath) {
    const home = join(this.path, `gnupg-${this.homes.length}`);
    await mkdir(home, { mode: 0o700 });
    this.homes.push(home);
    run("gpg", ["--homedir", home, "--batch", "--quiet", "--import", keyPath]);
    return home;
  }
  /** A throwaway rpm database holding only the committed public key. */
  async rpmKeyDatabase(keyPath) {
    const database = join(this.path, `rpmdb-${this.homes.length}-${Date.now()}`);
    await mkdir(database, { recursive: true });
    run("rpmkeys", ["--dbpath", database, "--import", keyPath]);
    return database;
  }
  async dispose() {
    for (const home of this.homes) capture("gpgconf", ["--homedir", home, "--kill", "all"]);
    await rm(this.path, { recursive: true, force: true });
  }
}

function rpmSignature(file, database) {
  const result = capture("rpmkeys", ["--dbpath", database, "-Kv", file]);
  return { state: signatureState(`${result.stdout}${result.stderr}`, result.status), output: `${result.stdout}${result.stderr}`.trim() };
}

/** Everything both stages need, checked up front: tools, the committed key, the secret key, the RPM. */
async function preflight(options) {
  const missing = missingTools(have);
  const problems = [];
  if (missing.length) {
    const packages = [...new Set(missing.map(tool => tool.package))];
    problems.push(`Missing ${missing.map(tool => tool.command).join(", ")}. On Fedora: sudo dnf install ${packages.join(" ")}`);
  }
  const identity = JSON.parse(await readFile(join(root, "src/shared/product-identity.json"), "utf8"));
  let enrolment;
  try {
    enrolment = linuxRpmEnrolment(root, identity);
    if (!enrolment.enrolled) problems.push(`No public signing key is committed at ${enrolment.repository.committedPublicKey}. Create the key and commit its public half first (docs/linux-build.md, "Package repository signing key").`);
  } catch (error) {
    problems.push(error.message);
  }
  if (problems.length) throw new Error(`Cannot publish to the Linux package repository yet:\n- ${problems.join("\n- ")}`);
  const workspace = await Workspace.create(join(options.buildDir, "package-repository"));
  try {
    const showHome = join(workspace.path, "show");
    await mkdir(showHome, { mode: 0o700 });
    workspace.homes.push(showHome);
    const fingerprint = primaryFingerprint(run("gpg", ["--homedir", showHome, "--batch", "--with-colons", "--show-keys", enrolment.keyPath]));
    const secret = capture("gpg", ["--batch", "--with-colons", "--list-secret-keys", fingerprint]);
    if (secret.status !== 0 || !/^sec:/m.test(secret.stdout)) {
      throw new Error(`The signing key ${fingerprint} (the committed public key) has no secret key in this GnuPG keyring${process.env.GNUPGHOME ? ` (GNUPGHOME=${process.env.GNUPGHOME})` : ""}. Sign on the computer that holds it.`);
    }
    return { identity, enrolment, fingerprint, workspace, committedKey: await readFile(enrolment.keyPath, "utf8") };
  } catch (error) {
    await workspace.dispose();
    throw error;
  }
}

function describeRpm(options, context) {
  const { version, release } = linuxPrereleaseTag(options.tag);
  const name = rpmArtifactName(context.identity, version, release);
  const file = join(options.buildDir, name);
  if (!existsSync(file)) throw new Error(`${relative(process.cwd(), file) || file} does not exist. Build it with npm run desktop:make:linux${release === "1" ? "" : ` -- --rpm-release ${release}`}.`);
  const query = rpmQuery(file);
  const expected = { name: context.identity.packageName, version, release, arch: "x86_64" };
  for (const [key, value] of Object.entries(expected)) {
    if (query[key] !== value) throw new Error(`${name} has ${key} ${JSON.stringify(query[key])}; tag ${options.tag} needs ${JSON.stringify(value)}.`);
  }
  const problems = carriedEnrolmentProblems(file, context.identity, context.enrolment, context.committedKey);
  if (problems.length) throw new Error(`${name} cannot go in the package repository: ${problems.join("; ")}. An RPM without the entry would unenrol every computer that upgrades to it.`);
  return { file, name, query };
}

async function sign(options) {
  const context = await preflight(options);
  try {
    const rpm = describeRpm(options, context);
    const database = await context.workspace.rpmKeyDatabase(context.enrolment.keyPath);
    let signature = rpmSignature(rpm.file, database);
    if (signature.state === "other") throw new Error(`${rpm.name} carries a signature the committed key does not verify:\n${signature.output}`);
    const alreadySigned = signature.state === "ours";
    if (!alreadySigned) {
      const result = capture("rpmsign", ["--define", `_gpg_name ${context.fingerprint}`, "--addsign", rpm.file], { stdio: ["inherit", "pipe", "pipe"] });
      if (result.status !== 0) throw new Error(`rpmsign could not sign ${rpm.name} (${result.status}): ${(result.stderr || result.stdout).trim()}`);
      signature = rpmSignature(rpm.file, database);
      if (signature.state !== "ours") throw new Error(`${rpm.name} was signed, but the committed public key does not verify it:\n${signature.output}`);
    }
    const sha256 = await sha256File(rpm.file);
    const bytes = (await readFile(rpm.file)).length;
    const sumsPath = join(options.buildDir, "SHA256SUMS");
    if (existsSync(sumsPath)) await writeFile(sumsPath, withChecksum(await readFile(sumsPath, "utf8"), rpm.name, sha256));
    const buildPath = join(options.buildDir, "linux-build.json");
    if (existsSync(buildPath)) {
      const build = JSON.parse(await readFile(buildPath, "utf8"));
      build.artifacts = (build.artifacts ?? []).map(item => item.name === rpm.name ? { ...item, bytes, sha256 } : item);
      build.rpm = { ...(build.rpm ?? {}), name: rpm.name, release: rpm.query.release, signedBy: context.fingerprint };
      await writeFile(buildPath, `${JSON.stringify(build, null, 2)}\n`);
    }
    console.log(`${alreadySigned ? "Already signed" : "Signed"} ${rpm.file}
  ${rpm.query.name} ${rpm.query.version}-${rpm.query.release} (${rpm.query.arch}), key ${context.fingerprint}
  ${signature.output.split("\n").filter(line => /signature/i.test(line)).map(line => line.trim()).join("\n  ")}
  sha256 ${sha256}${existsSync(sumsPath) ? `\n  Updated ${sumsPath}${existsSync(buildPath) ? " and linux-build.json" : ""}.` : ""}

This signed RPM is the file the prerelease carries. Next:
  1. Make the release folder and its SHA256SUMS from these files, and upload them to ${options.tag}.
  2. npm run desktop:linux:repository -- prepare --tag ${options.tag}`);
  } finally {
    await context.workspace.dispose();
  }
}

/** Streams a download and returns its sha256, following redirects as dnf does. */
async function downloadDigest(url) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "amplefile-linux-package-repository" } });
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}${response.status === 404 ? ": upload the signed file to the prerelease first" : ""}.`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadText(url) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "amplefile-linux-package-repository" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}${response.status === 404 ? ": upload the release's SHA256SUMS first" : ""}.`);
  return response.text();
}

function git(options, args, extra = {}) {
  return run("git", ["-C", options.gitDir, ...args], extra);
}

function gitRef(options, ref) {
  const result = capture("git", ["-C", options.gitDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/** The commit the new branch content goes on, after fetching what is published. */
function branchParent(options, branch) {
  const remoteRef = `refs/remotes/${options.remote}/${branch}`;
  if (options.fetch) {
    const result = capture("git", ["-C", options.gitDir, "fetch", "--no-tags", options.remote, `+refs/heads/${branch}:${remoteRef}`]);
    if (result.status !== 0 && !/couldn't find remote ref/i.test(result.stderr)) {
      throw new Error(`Could not fetch ${branch} from ${options.remote} to see what is published: ${result.stderr.trim()} (--no-fetch skips this, and checks only the local branch).`);
    }
  }
  const local = gitRef(options, `refs/heads/${branch}`);
  const remote = gitRef(options, remoteRef);
  if (local && remote && local !== remote && capture("git", ["-C", options.gitDir, "merge-base", "--is-ancestor", remote, local]).status !== 0) {
    throw new Error(`The local ${branch} branch does not contain the published ${options.remote}/${branch}. Reset it to the published branch (git branch -f ${branch} ${options.remote}/${branch}) before preparing a new build.`);
  }
  return local ?? remote;
}

function listedPackages(options, parent, folder) {
  if (!parent) return [];
  const repomd = capture("git", ["-C", options.gitDir, "show", `${parent}:${folder}/repodata/repomd.xml`]);
  if (repomd.status !== 0) return [];
  const primary = spawnSync("git", ["-C", options.gitDir, "show", `${parent}:${folder}/${primaryLocation(repomd.stdout)}`], { maxBuffer: 64 * 1024 * 1024 });
  if (primary.status !== 0) throw new Error(`The ${parent.slice(0, 12)} branch commit lists primary metadata it does not hold.`);
  return primaryPackages(gunzipSync(primary.stdout).toString("utf8"));
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

/** The identity a generated commit is made with: git's own, or the source checkout's last author. */
function commitEnvironment(options) {
  if (capture("git", ["-C", options.gitDir, "var", "GIT_COMMITTER_IDENT"]).status === 0) return process.env;
  const author = capture("git", ["-C", root, "log", "-1", "--format=%an%x00%ae", "HEAD"]);
  const [name, email] = author.stdout.trim().split("\0");
  if (author.status !== 0 || !name || !email) throw new Error("git has no user identity here; set user.name and user.email.");
  return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

async function prepare(options) {
  assertDownloadBaseAllowed({ downloadBase: options.downloadBase, gitDir: options.gitDir, sourceRoot: root, commonDirectory: gitCommonDirectory });
  const context = await preflight(options);
  try {
    const { identity, enrolment, fingerprint, workspace } = context;
    const repository = enrolment.repository;
    const rpm = describeRpm(options, context);
    const database = await workspace.rpmKeyDatabase(enrolment.keyPath);
    const signature = rpmSignature(rpm.file, database);
    if (signature.state !== "ours") {
      throw new Error(`${rpm.name} is not signed with the committed key; run npm run desktop:linux:repository -- sign --tag ${options.tag} first, then upload that file.\n${signature.output}`);
    }
    const sha256 = await sha256File(rpm.file);
    const folder = repository.architectureFolder(rpm.query.arch);

    // Only a newer build may replace what the branch lists.
    const parent = branchParent(options, repository.branch);
    const listed = listedPackages(options, parent, folder);
    assertNewerThanListed(rpm.query, listed);

    // The release must carry exactly this signed file, and list it.
    const base = options.downloadBase ?? repository.releaseDownloadBase(options.tag);
    const assetUrl = `${base}${encodeURIComponent(rpm.name)}`;
    console.log(`Checking ${assetUrl} against the local signed RPM...`);
    const remote = await downloadDigest(assetUrl);
    if (remote !== sha256) {
      throw new Error(`The release asset ${rpm.name} (sha256 ${remote}) is not the local signed RPM (sha256 ${sha256}). Upload the signed file, replacing the asset, then run prepare again.`);
    }
    const sums = listedChecksum(await downloadText(`${base}SHA256SUMS`), rpm.name);
    if (sums !== sha256) {
      throw new Error(`The release's SHA256SUMS lists ${sums ?? "no digest"} for ${rpm.name}, not the signed RPM's ${sha256}. Rebuild SHA256SUMS after signing and upload it.`);
    }

    // Metadata pointing at the release asset, from a copy of the RPM.
    const output = join(workspace.path, "repository");
    const architecture = join(output, folder);
    await mkdir(architecture, { recursive: true });
    const copy = join(architecture, rpm.name);
    await copyFile(rpm.file, copy, fsConstants.COPYFILE_FICLONE);
    run("createrepo_c", ["--quiet", "--baseurl", base, "--general-compress-type=gz", "--checksum=sha256", "--no-database", architecture]);
    await rm(copy);
    const repomdPath = join(architecture, "repodata", "repomd.xml");
    const packages = primaryPackages(gunzipSync(await readFile(join(architecture, primaryLocation(await readFile(repomdPath, "utf8"))))).toString("utf8"));
    const entry = packages[0];
    if (packages.length !== 1 || entry.name !== rpm.query.name || entry.version !== rpm.query.version || entry.release !== rpm.query.release
      || entry.sha256 !== sha256 || entry.href !== rpm.name || entry.base !== base) {
      throw new Error(`createrepo_c's metadata does not describe exactly the signed release asset: ${JSON.stringify(packages)}`);
    }

    // Detached, armored signature on repomd.xml, checked against the committed key.
    const signaturePath = `${repomdPath}.asc`;
    const signed = capture("gpg", ["--yes", "--local-user", fingerprint, "--armor", "--detach-sign", "--output", signaturePath, repomdPath], { stdio: ["inherit", "pipe", "pipe"] });
    if (signed.status !== 0) throw new Error(`gpg could not sign repomd.xml (${signed.status}): ${signed.stderr.trim()}`);
    const verifyHome = await workspace.keyHome(enrolment.keyPath);
    const verified = capture("gpg", ["--homedir", verifyHome, "--batch", "--status-fd", "1", "--verify", signaturePath, repomdPath]);
    if (verified.status !== 0 || !validSignatureKeys(verified.stdout).includes(fingerprint)) {
      throw new Error(`The committed public key does not verify repomd.xml.asc:\n${verified.stdout}${verified.stderr}`);
    }

    // The branch's complete new content, committed locally.
    await writeFile(join(output, "README.md"), branchReadme({ identity, repository, tag: options.tag, rpm: rpm.query, sha256, fingerprint }));
    const index = join(workspace.path, "index");
    const env = { ...commitEnvironment(options), GIT_INDEX_FILE: index };
    git(options, ["read-tree", "--empty"], { env });
    for (const file of (await filesUnder(output)).sort()) {
      const object = git(options, ["hash-object", "-w", "--", file]).trim();
      git(options, ["update-index", "--add", "--cacheinfo", `100644,${object},${relative(output, file)}`], { env });
    }
    const tree = git(options, ["write-tree"], { env }).trim();
    const message = `Publish ${identity.packageName} ${rpm.query.version}-${rpm.query.release} to the Linux package repository\n\nGenerated by npm run desktop:linux:repository -- prepare --tag ${options.tag}.\nRPM ${rpm.name}, sha256 ${sha256}, signed with ${fingerprint}.\n`;
    const commit = git(options, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { env }).trim();
    git(options, ["update-ref", `refs/heads/${repository.branch}`, commit, gitRef(options, `refs/heads/${repository.branch}`) ?? ""]);

    console.log(`Prepared the Linux package repository locally. Nothing was pushed.
  Branch ${repository.branch} is now ${commit.slice(0, 12)}${parent ? `, on ${parent.slice(0, 12)}` : " (its first commit)"}.
  It lists ${rpm.query.name} ${rpm.query.version}-${rpm.query.release} at ${assetUrl}
  sha256 ${sha256}; the release asset and the release's SHA256SUMS match it.
  repomd.xml is signed by ${fingerprint}${listed.length ? `; it replaces ${listed.map(item => `${item.version}-${item.release}`).join(", ")}` : ""}.

To publish it, which every enrolled computer's dnf then sees:
  git -C ${resolve(options.gitDir)} push ${options.remote} ${repository.branch}`);
  } finally {
    await context.workspace.dispose();
  }
}

async function check(options) {
  const context = await preflight(options);
  try {
    console.log(`Ready: ${requiredTools.map(tool => tool.command).join(", ")} are installed, and the secret key for the committed public key ${context.fingerprint} is in this keyring.`);
  } finally {
    await context.workspace.dispose();
  }
}

export function parseArguments(argv) {
  const [stage, ...rest] = argv;
  if (!["check", "sign", "prepare"].includes(stage)) throw new Error("Usage: npm run desktop:linux:repository -- check | sign --tag TAG | prepare --tag TAG [--build-dir DIR] [--git-dir DIR] [--remote NAME] [--no-fetch] [--download-base URL]");
  const options = { stage, buildDir: join(root, "out/linux"), gitDir: root, remote: "origin", fetch: true, downloadBase: null, tag: null };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = () => {
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
      index += 1;
      return next;
    };
    if (flag === "--tag") options.tag = linuxPrereleaseTag(value()).tag;
    else if (flag === "--build-dir") options.buildDir = resolve(value());
    else if (flag === "--git-dir") options.gitDir = resolve(value());
    else if (flag === "--remote") options.remote = value();
    else if (flag === "--no-fetch") options.fetch = false;
    else if (flag === "--download-base") {
      const base = value();
      if (!/^https?:\/\/.+\/$/.test(base)) throw new Error("--download-base must be an http(s) address ending in /.");
      options.downloadBase = base;
    } else throw new Error(`Unknown option ${flag}.`);
  }
  if (stage !== "check" && !options.tag) throw new Error(`${stage} needs --tag linux-test-X.Y.Z[-N].`);
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (process.platform !== "linux") throw new Error("Sign and prepare the Linux package repository on Linux.");
    await ({ check, sign, prepare })[options.stage](options);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

