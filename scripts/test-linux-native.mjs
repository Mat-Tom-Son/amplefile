import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "linux") {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliTarget = join(root, "out/linux-native-target");
  const cliManifest = join(root, "desktop/native/linux/Cargo.toml");
  const cliBuild = { cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: cliTarget } };
  execFileSync("cargo", ["test", "--release", "--locked", "--manifest-path", cliManifest], cliBuild);
  execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", cliManifest], cliBuild);
  execFileSync(process.execPath, ["scripts/run-tests.mjs", "tests/desktop-cli-request-id.test.ts", "tests/desktop-cli-automation-wait.test.ts", "tests/desktop-cli-json-errors.test.ts"], {
    cwd: root, stdio: "inherit", env: { ...process.env, AMPLEFILE_TEST_LINUX_CLI: join(cliTarget, "release/amplefile-cli") },
  });
  execFileSync("cargo", ["test", "--release", "--locked", "--manifest-path", join(root, "node_modules/@injaneity/pi-computer-use/native/linux/bridge-rs/Cargo.toml")], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: join(root, "out/linux-computer-target") },
  });
  execFileSync("cargo", ["test", "--release", "--locked", "--manifest-path", join(root, "desktop/native/linux-wayland/Cargo.toml")], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: join(root, "out/linux-wayland-target") },
  });
  execFileSync("cargo", ["test", "--release", "--locked", "--manifest-path", join(root, "desktop/native/linux-clipboard/Cargo.toml")], {
    cwd: root, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: join(root, "out/linux-clipboard-target") },
  });
}
