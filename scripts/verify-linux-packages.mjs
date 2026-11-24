// Verifies the built Linux installers themselves, not just linux-unpacked:
// extracts the DEB, RPM and AppImage into a temporary directory (no root, no
// installation) and checks what each one would put on a computer.
//
//   node scripts/verify-linux-packages.mjs [out/linux] [--version X.Y.Z] [--rpm-release N]
//
// A format is skipped, with a printed notice, only when the tools needed to
// extract it are missing. docs/linux-build.md describes the checks.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const { linuxRpmEnrolment, linuxRpmRelease, repositoryEntry, rpmArtifactName } = require("./linux-package-repository.cjs");

/** The hicolor sizes every package installs (scripts/generate-desktop-icons.mjs). */
export const linuxIconSizes = [16, 24, 32, 48, 64, 128, 256, 512];
export const expectedCategories = "Utility;FileTools;FileManager;";

/** Splits a Debian control file into fields, joining continuation lines. */
export function parseDebControl(text) {
  const fields = {};
  let current = null;
  for (const line of text.split("\n")) {
    if (/^[ \t]/.test(line) && current) fields[current] += `\n${line.trim()}`;
    else {
      const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (match) { current = match[1]; fields[current] = match[2]; }
    }
  }
  return fields;
}

/** A Debian relationship field as a list of normalized relations ("a | b"). */
export function parseDebRelations(value) {
  if (!value) return [];
  return value.split(",").map(relation => relation.split("|").map(item => item.trim().replace(/\s+/g, " ")).filter(Boolean).join(" | ")).filter(Boolean);
}

/** `rpm -qp --requires|--recommends` output: one normalized relation per line. */
export function parseRpmRelations(output) {
  return output.split("\n").map(line => line.trim().replace(/\s+/g, " ")).filter(line => line && !line.startsWith("rpmlib("));
}

/** A desktop entry's groups and keys; comments and blank lines are ignored. */
export function parseDesktopEntry(text) {
  const groups = {};
  let group = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { group = header[1]; groups[group] ??= {}; continue; }
    const separator = line.indexOf("=");
    if (group && separator > 0) groups[group][line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return groups;
}

/** Problems with a packaged desktop entry; `exec` is the exact expected Exec. */
export function desktopEntryProblems(text, { exec, icon }) {
  const entry = parseDesktopEntry(text)["Desktop Entry"];
  if (!entry) return ["has no [Desktop Entry] group"];
  const problems = [];
  const expect = (key, value) => { if (entry[key] !== value) problems.push(`${key} is ${JSON.stringify(entry[key] ?? null)}, expected ${JSON.stringify(value)}`); };
  expect("Type", "Application");
  expect("Exec", exec);
  expect("Icon", icon);
  expect("Categories", expectedCategories);
  for (const key of ["Name", "GenericName", "Comment"]) if (!entry[key]) problems.push(`${key} is missing`);
  const mimeTypes = (entry.MimeType ?? "").split(";").filter(Boolean);
  if (!mimeTypes.includes("inode/directory")) problems.push("MimeType does not declare inode/directory");
  if (/--ozone-platform|--no-sandbox/.test(entry.Exec ?? "")) problems.push("Exec hard-codes a platform or sandbox switch");
  return problems;
}

/** Declared relations missing from a package; alternatives must match exactly. */
export function missingRelations(declared, actual) {
  const normalized = new Set(actual.map(item => item.replace(/\s+/g, " ")));
  return declared.map(item => item.replace(/\s+/g, " ")).filter(item => !normalized.has(item));
}

/** Width and height from a PNG's IHDR chunk, or null for anything else. */
export function pngSize(bytes) {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Problems with a maintainer script: it must keep the CLI link and never claim a default handler. */
export function maintainerScriptProblems(name, text) {
  const problems = [];
  if (!text.trim()) return [`${name} is empty`];
  if (/xdg-mime\s+default|mimeapps\.list/.test(text)) problems.push(`${name} changes default applications`);
  return problems;
}

/**
 * Problems with a dnf repository entry an RPM installs: it must check both
 * package and metadata signatures against a local key, for every repository.
 */
export function repositoryEntryProblems(text) {
  const problems = [];
  const sections = parseDesktopEntry(text);
  const names = Object.keys(sections);
  if (!names.length) problems.push("has no repository section");
  for (const name of names) {
    const entry = sections[name];
    for (const key of ["gpgcheck", "repo_gpgcheck"]) {
      if (entry[key] !== "1") problems.push(`[${name}] ${key} is ${JSON.stringify(entry[key] ?? null)}, expected "1"`);
    }
    if (!/^file:\/\/\/etc\/pki\/rpm-gpg\/\S+$/.test(entry.gpgkey ?? "")) problems.push(`[${name}] gpgkey is not a local key under /etc/pki/rpm-gpg`);
    if (!/^https:\/\//.test(entry.baseurl ?? "")) problems.push(`[${name}] baseurl is not an https address`);
  }
  return problems;
}

/** The files an RPM lists with their flags (`rpm -qp --qf '[%{FILENAMES}\t%{FILEFLAGS:fflags}\n]'`). */
export function parseRpmFileFlags(output) {
  const files = new Map();
  for (const line of output.split("\n")) {
    const separator = line.lastIndexOf("\t");
    if (separator > 0) files.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return files;
}

/**
 * Problems with an RPM's package repository enrolment. An enrolling RPM
 * carries the exact entry as a config file an upgrade keeps (%config
 * noreplace) and the committed key; an RPM built without the key carries
 * neither.
 */
export function rpmEnrolmentProblems({ enrolled, repository, fileFlags, readInstalled, expectedEntry, expectedKey }) {
  const problems = [];
  const entryFlags = fileFlags.get(repository.repositoryFile);
  const keyFlags = fileFlags.get(repository.publicKeyFile);
  if (!enrolled) {
    if (entryFlags !== undefined) problems.push(`carries ${repository.repositoryFile} although no public key is committed`);
    if (keyFlags !== undefined) problems.push(`carries ${repository.publicKeyFile} although no public key is committed`);
    return problems;
  }
  if (entryFlags === undefined) problems.push(`does not carry the repository entry ${repository.repositoryFile}`);
  else {
    if (!entryFlags.includes("c") || !entryFlags.includes("n")) problems.push(`${repository.repositoryFile} is not %config(noreplace) (flags ${JSON.stringify(entryFlags)})`);
    const entry = readInstalled(repository.repositoryFile);
    if (entry === null) problems.push(`${repository.repositoryFile} is missing from the payload`);
    else {
      problems.push(...repositoryEntryProblems(entry).map(problem => `${repository.repositoryFile} ${problem}`));
      if (entry !== expectedEntry) problems.push(`${repository.repositoryFile} differs from the generated entry`);
    }
  }
  if (keyFlags === undefined) problems.push(`does not carry the public key ${repository.publicKeyFile}`);
  else {
    if (keyFlags.includes("c")) problems.push(`${repository.publicKeyFile} is a config file; a later build must be able to replace the key`);
    const key = readInstalled(repository.publicKeyFile);
    if (key !== expectedKey) problems.push(`${repository.publicKeyFile} is not the committed public key`);
  }
  return problems;
}

function have(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}

async function isExecutableFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch { return false; }
}

/** Checks one extracted payload: the app under `appRoot`, desktop data under `shareRoot`. */
async function payloadProblems({ appRoot, shareRoot, desktopFile, exec, scalable }, identity) {
  const problems = [];
  const executable = identity.packageName;
  for (const [path, label] of [
    [executable, "the application executable"],
    ["chrome-sandbox", "the Chromium sandbox helper"],
    [`bin/${identity.cliCommand}`, "the CLI shim under bin/"],
    [`bin/${identity.cliCommand}-cli`, "the native CLI under bin/"],
    ["resources/computer-helper/linux-bridge", "the Linux Computer Control helper"],
    ["resources/wayland-helper/amplefile-wayland", "the Wayland portal/input helper"],
    ["resources/clipboard-helper/amplefile-clipboard", "the X11 clipboard helper"],
  ]) {
    if (!(await isExecutableFile(join(appRoot, path)))) problems.push(`missing ${label} (${path}) or it is not executable`);
  }
  for (const path of ["resources/app.asar", "resources/computer-helper/source.json", "resources/wayland-helper/source.json",
    "resources/clipboard-helper/source.json", "resources/clipboard-helper/THIRD-PARTY-LICENSES.txt", "resources/assets/icon.png"]) {
    try { await stat(join(appRoot, path)); } catch { problems.push(`missing ${path}`); }
  }
  try {
    problems.push(...desktopEntryProblems(await readFile(desktopFile, "utf8"), { exec, icon: executable }).map(problem => `desktop entry: ${problem}`));
  } catch { problems.push(`missing desktop entry ${desktopFile}`); }
  for (const size of linuxIconSizes) {
    const path = join(shareRoot, "icons/hicolor", `${size}x${size}`, "apps", `${executable}.png`);
    try {
      const dimensions = pngSize(await readFile(path));
      if (!dimensions || dimensions.width !== size || dimensions.height !== size) problems.push(`icon ${size}x${size} is not a ${size}px PNG`);
    } catch { problems.push(`missing ${size}x${size} hicolor icon`); }
  }
  if (scalable) {
    try {
      if (!(await readFile(join(shareRoot, "icons/hicolor/scalable/apps", `${executable}.svg`), "utf8")).includes("<svg")) problems.push("scalable icon is not an SVG");
    } catch { problems.push("missing scalable hicolor icon"); }
  }
  return problems;
}

async function verifyDeb(file, work, config, identity) {
  const extract = join(work, "deb");
  await mkdir(join(extract, "data"), { recursive: true });
  await mkdir(join(extract, "control"), { recursive: true });
  if (have("dpkg-deb")) {
    run("dpkg-deb", ["-x", file, join(extract, "data")]);
    run("dpkg-deb", ["-e", file, join(extract, "control")]);
  } else {
    run("ar", ["x", file], { cwd: extract });
    const members = await readdir(extract);
    const data = members.find(name => name.startsWith("data.tar"));
    const controlArchive = members.find(name => name.startsWith("control.tar"));
    if (!data || !controlArchive) return ["is not a DEB archive with control and data members"];
    run("tar", ["-xf", join(extract, data), "-C", join(extract, "data")]);
    run("tar", ["-xf", join(extract, controlArchive), "-C", join(extract, "control")]);
  }
  const control = parseDebControl(await readFile(join(extract, "control/control"), "utf8"));
  const problems = [];
  for (const [field, declared] of [["Depends", config.deb.depends], ["Recommends", config.deb.recommends]]) {
    const missing = missingRelations(declared, parseDebRelations(control[field]));
    if (missing.length) problems.push(`${field} lacks ${missing.join(", ")}`);
  }
  for (const script of ["postinst", "postrm"]) {
    try { problems.push(...maintainerScriptProblems(script, await readFile(join(extract, "control", script), "utf8"))); }
    catch { problems.push(`missing maintainer script ${script}`); }
  }
  const data = join(extract, "data");
  problems.push(...await payloadProblems({
    appRoot: join(data, "opt", identity.productName), shareRoot: join(data, "usr/share"),
    desktopFile: join(data, "usr/share/applications", `${identity.packageName}.desktop`),
    exec: `/opt/${identity.productName}/${identity.packageName} %U`, scalable: true,
  }, identity));
  return problems;
}

async function verifyRpm(file, work, config, identity, { release, sourceRoot }) {
  const extract = join(work, "rpm");
  await mkdir(extract, { recursive: true });
  const cpio = spawnSync("sh", ["-c", 'rpm2cpio "$1" | cpio -idm --quiet --no-absolute-filenames', "sh", file], { cwd: extract, encoding: "utf8" });
  if (cpio.status !== 0) return [`could not be extracted: ${cpio.stderr}`];
  const problems = [];
  const actualRelease = run("rpm", ["-qp", "--qf", "%{RELEASE}", file]).trim();
  if (actualRelease !== release) problems.push(`release is ${JSON.stringify(actualRelease)}, expected ${JSON.stringify(release)}`);
  const enrolment = linuxRpmEnrolment(sourceRoot, identity);
  const readInstalled = (path) => { try { return readFileSync(join(extract, `.${path}`), "utf8"); } catch { return null; } };
  problems.push(...rpmEnrolmentProblems({
    enrolled: enrolment.enrolled,
    repository: enrolment.repository,
    fileFlags: parseRpmFileFlags(run("rpm", ["-qp", "--qf", "[%{FILENAMES}\t%{FILEFLAGS:fflags}\n]", file])),
    readInstalled,
    expectedEntry: repositoryEntry(identity),
    expectedKey: enrolment.enrolled ? readFileSync(enrolment.keyPath, "utf8") : null,
  }));
  for (const [query, declared] of [["--requires", config.rpm.depends], ["--recommends", ["gnome-keyring"]]]) {
    const missing = missingRelations(declared, parseRpmRelations(run("rpm", ["-qp", query, file])));
    if (missing.length) problems.push(`${query.slice(2)} lacks ${missing.join(", ")}`);
  }
  const scripts = run("rpm", ["-qp", "--scripts", file]);
  for (const scriptlet of ["postinstall", "postuninstall"]) {
    const match = new RegExp(`^${scriptlet} scriptlet[^\\n]*\\n([\\s\\S]*?)(?=^\\w+ scriptlet|(?![\\s\\S]))`, "m").exec(scripts);
    if (!match) problems.push(`missing ${scriptlet} scriptlet`);
    else problems.push(...maintainerScriptProblems(scriptlet, match[1]));
  }
  problems.push(...await payloadProblems({
    appRoot: join(extract, "opt", identity.productName), shareRoot: join(extract, "usr/share"),
    desktopFile: join(extract, "usr/share/applications", `${identity.packageName}.desktop`),
    exec: `/opt/${identity.productName}/${identity.packageName} %U`, scalable: true,
  }, identity));
  return problems;
}

async function verifyAppImage(file, work, _config, identity) {
  const extract = join(work, "appimage");
  await mkdir(extract, { recursive: true });
  // Our own build output; the runtime extracts without FUSE or installation.
  const copy = join(extract, "candidate.AppImage");
  await copyFile(file, copy);
  await chmod(copy, 0o755);
  run(copy, ["--appimage-extract"], { cwd: extract, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "" } });
  const squashfs = join(extract, "squashfs-root");
  return payloadProblems({
    appRoot: squashfs, shareRoot: join(squashfs, "usr/share"),
    desktopFile: join(squashfs, `${identity.packageName}.desktop`),
    exec: "AppRun %U", scalable: false,
  }, identity);
}

/**
 * `sourceRoot` is the checkout the packages were built from (its committed
 * key decides whether the RPM must enrol); `formats` limits the check to some
 * of DEB, RPM and AppImage.
 */
export async function verifyLinuxPackages(directory, version, { rpmRelease, sourceRoot = root, formats: only } = {}) {
  const release = linuxRpmRelease(rpmRelease);
  const identity = JSON.parse(await readFile(join(sourceRoot, "src/shared/product-identity.json"), "utf8"));
  const config = require(join(sourceRoot, "electron-builder.desktop.cjs"));
  const formats = [
    { name: "DEB", suffix: "linux-amd64.deb", tools: [["dpkg-deb"], ["ar", "tar"]], verify: verifyDeb },
    { name: "RPM", file: rpmArtifactName(identity, version, release), tools: [["rpm", "rpm2cpio", "cpio"]], verify: verifyRpm },
    { name: "AppImage", suffix: "linux-x86_64.AppImage", tools: [[]], verify: verifyAppImage },
  ];
  const failures = [];
  const work = await mkdtemp(join(tmpdir(), "amplefile-package-verify-"));
  try {
    for (const format of formats.filter(item => !only || only.includes(item.name))) {
      const file = join(directory, format.file ?? `${identity.productName}-${version}-${format.suffix}`);
      try { await stat(file); } catch { failures.push(`${format.name}: ${file} does not exist`); continue; }
      if (!format.tools.some(set => set.every(have))) {
        console.log(`NOTICE ${format.name} contents not verified: none of ${format.tools.map(set => set.join("+")).join(" or ")} is available on this host.`);
        continue;
      }
      const problems = await format.verify(file, work, config, identity, { release, sourceRoot });
      if (problems.length) failures.push(...problems.map(problem => `${format.name}: ${problem}`));
      else console.log(`PASS ${format.name} ${file}: executable, CLI, helpers, desktop entry, hicolor icons${format.name === "AppImage" ? "" : ", declared dependencies and maintainer scripts"}${format.name === "RPM" ? `, release ${release}, ${linuxRpmEnrolment(sourceRoot, identity).enrolled ? "package repository entry and public key" : "no package repository entry (no public key committed)"}` : ""}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (failures.length) throw new Error(`Linux package verification failed:\n- ${failures.join("\n- ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const valueOf = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
  const valueIndexes = new Set(["--version", "--rpm-release"].map(name => args.indexOf(name)).filter(index => index !== -1).map(index => index + 1));
  const version = valueOf("--version") ?? JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !valueIndexes.has(index));
  const unknown = args.filter(arg => arg.startsWith("--") && arg !== "--version" && arg !== "--rpm-release");
  if (!version || positional.length > 1 || unknown.length) throw new Error("Usage: node scripts/verify-linux-packages.mjs [directory] [--version X.Y.Z] [--rpm-release N]");
  try {
    await verifyLinuxPackages(resolve(positional[0] ?? join(root, "out/linux")), version, { rpmRelease: valueOf("--rpm-release") });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
