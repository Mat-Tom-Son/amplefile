// End-to-end proof of the Fedora package repository lane (README.md beside
// this file). Builds two enrolling RPMs of one version from an existing
// unpacked Linux build, then installs, publishes, tampers with and upgrades
// them in a throwaway Fedora container with a throwaway signing key and a
// local stand-in for GitHub's hosts.
//
//   node scripts/linux-package-repository-proof/run.mjs [--unpacked DIR] [--image NAME] [--keep]
//
// The proof uses the committed source (HEAD), so commit before running it.
// The unpacked build must come from this source (it checks for the Linux
// package update code). Everything it makes lives in
// out/linux-package-repository-proof; without
// --keep only the logs and results stay there afterwards.
import { spawnSync } from "node:child_process";
import { cp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; };
const unpacked = resolve(option("--unpacked", join(root, "out/linux/linux-unpacked")));
const image = option("--image", "localhost/amplefile-wlroots-acceptance");
const keep = args.includes("--keep");
const work = join(root, "out/linux-package-repository-proof");
const source = join(work, "source");

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed (${result.status}).`);
  return result;
}

if (!existsSync(join(unpacked, "resources/app.asar"))) throw new Error(`${unpacked} is not an unpacked Linux build; make one with npm run desktop:make:linux -- --dir, or pass --unpacked.`);
// The app check drives this branch's update code, so the unpacked build must carry it.
{
  const archive = await open(join(unpacked, "resources/app.asar"));
  const prefix = Buffer.alloc(16);
  await archive.read(prefix, 0, 16, 0);
  const json = Buffer.alloc(prefix.readUInt32LE(12));
  await archive.read(json, 0, json.length, 16);
  await archive.close();
  const header = JSON.parse(json.toString("utf8"));
  if (!header.files?.dist?.files?.desktop?.files?.["system-package-updates.js"]) {
    throw new Error(`${unpacked} was built from source without the Linux package updates; build this checkout with npm run desktop:make:linux -- --dir, or pass --unpacked.`);
  }
}
const icons = join(root, "out/generated-assets/linux-icons");
if (!existsSync(icons)) throw new Error("Run npm run desktop:icons first: the RPM takes its hicolor icons from out/generated-assets/linux-icons.");
await rm(work, { recursive: true, force: true });
await mkdir(source, { recursive: true });

console.log("=== The committed source, with a throwaway signing key committed in it");
run("sh", ["-c", 'git -C "$1" archive HEAD | tar -x -C "$2"', "sh", root, source]);
await symlink(join(root, "node_modules"), join(source, "node_modules"));
await cp(icons, join(source, "out/generated-assets/linux-icons"), { recursive: true });
const gnupg = join(work, "gnupg");
await mkdir(gnupg, { mode: 0o700 });
const gpgEnv = { ...process.env, GNUPGHOME: gnupg };
run("gpg", ["--batch", "--quiet", "--passphrase", "", "--quick-gen-key", "AmpleFile package repository proof (throwaway) <proof@invalid>", "rsa4096", "sign", "never"], { env: gpgEnv });
const key = spawnSync("gpg", ["--batch", "--armor", "--export"], { env: gpgEnv, encoding: "utf8" }).stdout;
await writeFile(join(source, "desktop/linux/RPM-GPG-KEY-amplefile"), key);
spawnSync("gpgconf", ["--kill", "all"], { env: gpgEnv });

const identity = JSON.parse(await readFile(join(source, "src/shared/product-identity.json"), "utf8"));
const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const { writeGeneratedLinuxAssets } = await import(pathToFileURL(join(source, "scripts/linux-generated-assets.mjs")).href);
const { verifyLinuxPackages } = await import(pathToFileURL(join(source, "scripts/verify-linux-packages.mjs")).href);
const enrolment = await writeGeneratedLinuxAssets(source, identity);
if (!enrolment.enrolled) throw new Error("The proof source did not enrol its RPM.");

for (const release of ["1", "2"]) {
  console.log(`\n=== RPM release ${release}: the real builder configuration, packaging the unpacked build`);
  const copy = join(work, `unpacked-${release}`);
  run("cp", ["-a", "--reflink=auto", unpacked, copy]);
  const output = join(work, `build-${release}`);
  run(process.execPath, [join(source, "node_modules/electron-builder/cli.js"), "--projectDir", source, "--config", "electron-builder.desktop.cjs",
    // gzip rather than the release's multithreaded xz payload: the same
    // package otherwise, within a modest memory cap. Payload compression
    // does not touch the signature, the metadata, or the enrolment.
    "--linux", "rpm", "--x64", "--publish", "never", "--prepackaged", copy, "-c.rpm.compression=gzip"], {
    cwd: source,
    env: { ...process.env, AMPLEFILE_DESKTOP_RELEASE_PLATFORM: "linux", AMPLEFILE_DESKTOP_OUTPUT_DIR: output, AMPLEFILE_LINUX_RPM_RELEASE: release },
  });
  await rm(copy, { recursive: true, force: true });
  await verifyLinuxPackages(output, version, { rpmRelease: release, sourceRoot: source, formats: ["RPM"] });
  for (const name of await readdir(output)) if (!name.endsWith(".rpm")) await rm(join(output, name), { recursive: true, force: true });
}

console.log("\n=== The container");
const repository = enrolment.repository;
const hosts = ["raw.githubusercontent.com", "github.com", "release-assets.githubusercontent.com"].flatMap(host => ["--add-host", `${host}:127.0.0.1`]);
const node = realpathSync(process.execPath);
let failed = null;
try {
  run("podman", ["run", "--rm", "--init", "--memory=3g", "--shm-size=1g", "--security-opt", "label=disable", ...hosts,
    "-v", `${work}:/proof`, "-v", `${node}:/usr/local/bin/node:ro`,
    "-e", `VERSION=${version}`, "-e", `OWNER=${repository.owner}`, "-e", `REPO=${repository.repo}`, "-e", `BRANCH=${repository.branch}`,
    "-e", `PACKAGE=${identity.packageName}`, "-e", `REPOSITORY_ID=${repository.id}`, "-e", `PRODUCT=${identity.productName}`,
    image, "bash", "/proof/source/scripts/linux-package-repository-proof/in-container.sh"]);
} catch (error) {
  failed = error;
} finally {
  if (!keep) {
    for (const name of await readdir(work)) {
      if (!/\.(log|txt|jsonl)$/.test(name)) await rm(join(work, name), { recursive: true, force: true });
    }
  }
}
if (failed) {
  console.error(`The package repository proof failed: ${failed.message}`);
  process.exit(1);
}
console.log(`\nThe package repository proof passed. Results: ${join(work, "results.txt")}`);
