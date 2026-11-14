import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeCargoNotices } from "./cargo-license-notices.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every build input of a crate's binary, for provenance: the manifest, the
 * lockfile, a build script, and each Rust file under src/, found rather than
 * listed so a new module cannot be left out. Examples are not build inputs.
 */
export async function crateSourcePaths(crate) {
  const paths = ["Cargo.toml", "Cargo.lock", ...(existsSync(join(crate, "build.rs")) ? ["build.rs"] : [])];
  const rust = (await readdir(join(crate, "src"), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".rs"))
    .map(entry => relative(crate, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
  return [...paths, ...rust];
}

async function crateSources(crate) {
  return Promise.all((await crateSourcePaths(crate)).map(async path => ({
    path, sha256: createHash("sha256").update(await readFile(join(crate, path))).digest("hex"),
  })));
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly && (process.env.AMPLEFILE_DESKTOP_RELEASE_PLATFORM || process.platform) === "linux") {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build Linux x64 packages on Linux x64.");
  const target = join(root, "out/linux-native-target");
  execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", join(root, "desktop/native/linux/Cargo.toml")], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target },
  });
  const cli = join(root, "out/included-tools/linux-cli");
  await mkdir(cli, { recursive: true });
  await writeCargoNotices(join(root, "desktop/native/linux/Cargo.toml"), join(cli, "THIRD-PARTY-LICENSES.txt"));
  await copyFile(join(target, "release/amplefile-cli"), join(cli, "amplefile-cli"));
  await chmod(join(cli, "amplefile-cli"), 0o755);
  const sources = await crateSources(join(root, "desktop/native/linux"));
  const provenance = {
    target: "x86_64-unknown-linux-gnu", sources,
    compiler: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  };
  await writeFile(join(cli, "source.json"), `${JSON.stringify({
    ...provenance, schema: "amplefile.linux-cli-source.v1", binarySha256: createHash("sha256").update(await readFile(join(cli, "amplefile-cli"))).digest("hex"),
  }, null, 2)}\n`);
  console.log("Built the Linux CLI.");
  const waylandManifest = join(root, "desktop/native/linux-wayland/Cargo.toml");
  const waylandTarget = join(root, "out/linux-wayland-target");
  execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", waylandManifest], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: waylandTarget },
  });
  const wayland = join(root, "out/included-tools/wayland-helper");
  await mkdir(wayland, { recursive: true });
  await copyFile(join(waylandTarget, "release/amplefile-wayland"), join(wayland, "amplefile-wayland"));
  await chmod(join(wayland, "amplefile-wayland"), 0o755);
  await writeCargoNotices(waylandManifest, join(wayland, "THIRD-PARTY-LICENSES.txt"));
  await writeFile(join(wayland, "source.json"), JSON.stringify({
    schema: "amplefile.wayland-helper-source.v1", protocolVersion: 1, target: "x86_64-unknown-linux-gnu",
    compiler: provenance.compiler,
    binarySha256: createHash("sha256").update(await readFile(join(wayland, "amplefile-wayland"))).digest("hex"),
    sources: await crateSources(join(root, "desktop/native/linux-wayland")),
    systemLibraries: Object.fromEntries(["gstreamer-1.0", "gstreamer-app-1.0", "gstreamer-video-1.0", "gstreamer-allocators-1.0", "libei-1.0", "xkbcommon"].map(name => [name,
      execFileSync("pkg-config", ["--modversion", name], { encoding: "utf8" }).trim()])),
  }, null, 2) + "\n");
  console.log("Built the Wayland portal/capture/input helper with source and dependency evidence.");
}
