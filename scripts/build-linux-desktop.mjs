import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeGeneratedLinuxAssets } from "./linux-generated-assets.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { RPM_RELEASE_VARIABLE, linuxRpmEnrolment, linuxRpmRelease, rpmArtifactName } = createRequire(import.meta.url)("./linux-package-repository.cjs");
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build Linux x64 candidates on Linux x64.");
const args = process.argv.slice(2);
// --rpm-release N: the Nth build of this version (tag linux-VERSION-N).
const releaseIndex = args.indexOf("--rpm-release");
const rpmRelease = linuxRpmRelease(releaseIndex === -1 ? process.env[RPM_RELEASE_VARIABLE] : args[releaseIndex + 1]);
const optionArguments = releaseIndex === -1 ? args : args.filter((_, index) => index !== releaseIndex && index !== releaseIndex + 1);
if (optionArguments.some(arg => arg !== "--dir") || (releaseIndex !== -1 && !args[releaseIndex + 1])) {
  throw new Error("Supported options: --dir (unpacked diagnostic build), --rpm-release N (default 1)");
}
// Background capture probes need a mapped X11 display. Give the build its own
// display rather than depend on the person's compositor or disturb their UI.
// Without their Wayland socket and session type, Electron selects that private
// X display itself, so the probes never open windows on the person's desktop.
if (process.env.AMPLEFILE_LINUX_BUILD_DISPLAY !== "1") {
  const env = { ...process.env, AMPLEFILE_LINUX_BUILD_DISPLAY: "1", XDG_SESSION_TYPE: "x11" };
  delete env.WAYLAND_DISPLAY;
  const result = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1920x1080x24", process.execPath, fileURLToPath(import.meta.url), ...args], {
    cwd: root, stdio: "inherit", env,
  });
  if (result.error) throw new Error("Linux packaging requires xvfb-run and xauth for the isolated desktop probes.", { cause: result.error });
  process.exit(result.status ?? 1);
}
const output = join(root, "out/linux");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const identity = JSON.parse(await readFile(join(root, "src/shared/product-identity.json"), "utf8"));
const { productName, packageName } = identity;
const env = { ...process.env, AMPLEFILE_DESKTOP_RELEASE_PLATFORM: "linux", AMPLEFILE_DESKTOP_OUTPUT_DIR: output, [RPM_RELEASE_VARIABLE]: rpmRelease };
const enrolment = linuxRpmEnrolment(root, identity);
await mkdir(output, { recursive: true });
const escapedVersion = version.replaceAll(".", "\\.");
const artifactPattern = new RegExp(`^${productName}-${escapedVersion}(-linux-(x64|amd64|x86_64)\\.(deb|AppImage)|-[1-9]\\d*-linux-x86_64\\.rpm)$`);
if (!args.includes("--dir") && (await readdir(output)).some(name => artifactPattern.test(name))) {
  throw new Error("Linux artifacts already exist. Preserve or move the previous candidate before building another.");
}
for (const name of ["linux-build.json", "SHA256SUMS"]) await rm(join(output, name), { force: true });
function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
run("npm", ["run", "desktop:prepare"]);
// Extend the builder's desktop and AppArmor setup instead of replacing it,
// and write the dnf repository entry an enrolling RPM installs.
await writeGeneratedLinuxAssets(root, identity);
console.log(enrolment.enrolled
  ? `The RPM (release ${rpmRelease}) enrols the computer in the ${enrolment.repository.name} repository: ${enrolment.repository.repositoryFile} and ${enrolment.repository.publicKeyFile}.`
  : `The RPM (release ${rpmRelease}) is NOT enrolled in the package repository: ${enrolment.reason}. It installs and runs as before, with no repository entry.`);
run(process.execPath, ["node_modules/electron-builder/cli.js", "--config", "electron-builder.desktop.cjs", "--linux", ...(args.includes("--dir") ? ["--dir"] : ["deb", "rpm", "AppImage"]), "--x64", "--publish", "never"]);
const executable = join(output, "linux-unpacked", packageName);
run(process.execPath, ["scripts/verify-packaged-app-assets.mjs", "--package-dir", join(output, "linux-unpacked"), "--platform", "linux"]);
run(process.execPath, ["scripts/linux-sandbox-smoke.mjs", executable]);
run(process.execPath, ["scripts/linux-installed-smoke.mjs", executable, "--expect-version", version]);
// The installers themselves, extracted without root or installation.
if (!args.includes("--dir")) run(process.execPath, ["scripts/verify-linux-packages.mjs", output, "--version", version, "--rpm-release", rpmRelease]);
const artifacts = [];
for (const name of (args.includes("--dir") ? [] : await readdir(output)).filter(name => artifactPattern.test(name)).sort()) {
  const bytes = await readFile(join(output, name));
  artifacts.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
if (!args.includes("--dir") && artifacts.length !== 3) throw new Error("Expected DEB, RPM and AppImage candidates.");
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
await writeFile(join(output, "linux-build.json"), JSON.stringify({
  version, platform: "linux", arch: "x64", distribution: "local-candidate", automaticUpdates: false,
  // The RPM's release and whether it enrols the computer in the package
  // repository. Signing (npm run desktop:linux:repository -- sign) records
  // the signing key here and replaces the RPM's digest.
  rpm: { name: rpmArtifactName(identity, version, rpmRelease), release: rpmRelease, packageRepository: enrolment.enrolled ? enrolment.repository.id : null, signedBy: null },
  sourceCommit: revision.stdout.trim(), sourceDirty: Boolean(status.stdout.trim()),
  createdAt: new Date().toISOString(), artifacts,
}, null, 2) + "\n");
await writeFile(join(output, "SHA256SUMS"), artifacts.map(item => `${item.sha256}  ${item.name}\n`).join(""));
console.log(`Verified local Linux candidate: ${output}`);
