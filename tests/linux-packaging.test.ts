import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
  desktopEntryProblems,
  maintainerScriptProblems,
  missingRelations,
  parseDebControl,
  parseDebRelations,
  parseDesktopEntry,
  parseRpmRelations,
  pngSize,
} from "../scripts/verify-linux-packages.mjs";
import { crateSourcePaths } from "../scripts/build-linux-native-hosts.mjs";

const config = createRequire(import.meta.url)("../electron-builder.desktop.cjs");
const exec = "/opt/AmpleFile/amplefile-desktop %U";
const goodEntry = `[Desktop Entry]
Name=AmpleFile
Exec=${exec}
Terminal=false
Type=Application
Icon=amplefile-desktop
GenericName=File Manager
Comment=Browse ordinary folders
MimeType=inode/directory;
Categories=Utility;FileTools;FileManager;
`;

test("the Linux launchers carry no platform switch and declare folders", () => {
  assert.equal(config.linux.executableArgs, undefined);
  assert.equal(config.appImage, undefined, "AppImage's default launcher arguments are empty for the pinned toolset");
  assert.deepEqual(config.linux.mimeTypes, ["inode/directory"]);
  assert.equal(config.linux.category, "Utility;FileTools;FileManager");
  assert.ok(config.rpm.fpm.includes("Recommends: gnome-keyring"));
  assert.ok(config.deb.depends.includes("libasound2 | libasound2t64"));
});

test("desktop entries are parsed and checked against the packaged contract", () => {
  assert.equal(parseDesktopEntry(goodEntry)["Desktop Entry"]?.GenericName, "File Manager");
  assert.deepEqual(desktopEntryProblems(goodEntry, { exec, icon: "amplefile-desktop" }), []);
  const flagged = goodEntry.replace(exec, "/opt/AmpleFile/amplefile-desktop --ozone-platform=x11 %U");
  assert.ok(desktopEntryProblems(flagged, { exec, icon: "amplefile-desktop" }).some(problem => /hard-codes/.test(problem)));
  const old = goodEntry.replace("Categories=Utility;FileTools;FileManager;", "Categories=Office;").replace("MimeType=inode/directory;\n", "").replace("GenericName=File Manager\n", "");
  const problems = desktopEntryProblems(old, { exec, icon: "amplefile-desktop" });
  assert.ok(problems.some(problem => problem.startsWith("Categories")));
  assert.ok(problems.some(problem => problem.includes("inode/directory")));
  assert.ok(problems.includes("GenericName is missing"));
  assert.deepEqual(desktopEntryProblems("Name=x\n", { exec, icon: "x" }), ["has no [Desktop Entry] group"]);
  assert.equal(parseDesktopEntry("[Desktop Entry]\n# Exec=wrong\nExec=a=b\n")["Desktop Entry"]?.Exec, "a=b");
});

test("Debian control relations keep alternatives and continuation lines", () => {
  const control = parseDebControl("Package: amplefile-desktop\nDepends: libc6 (>= 2.39), libasound2 | libasound2t64,\n libei1 (>= 1.2)\nRecommends: gnome-keyring\n");
  assert.deepEqual(parseDebRelations(control.Depends), ["libc6 (>= 2.39)", "libasound2 | libasound2t64", "libei1 (>= 1.2)"]);
  assert.deepEqual(missingRelations(["libasound2 | libasound2t64", "libgbm1"], parseDebRelations(control.Depends)), ["libgbm1"]);
  assert.deepEqual(parseDebRelations(undefined), []);
});

test("RPM relation output ignores rpmlib capabilities", () => {
  const relations = parseRpmRelations("/bin/sh\nglibc >= 2.39\nrpmlib(PayloadIsXz) <= 5.2-1\n\nlibei >= 1.2\n");
  assert.deepEqual(relations, ["/bin/sh", "glibc >= 2.39", "libei >= 1.2"]);
  assert.deepEqual(missingRelations(["glibc >= 2.39", "nss"], relations), ["nss"]);
});

test("PNG sizes come from the IHDR chunk and other bytes are refused", () => {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(48, 16);
  png.writeUInt32BE(48, 20);
  assert.deepEqual(pngSize(png), { width: 48, height: 48 });
  assert.equal(pngSize(Buffer.from("<svg/>")), null);
});

test("maintainer scripts may not make AmpleFile a default application", () => {
  assert.deepEqual(maintainerScriptProblems("postinst", "update-desktop-database /usr/share/applications || true\n"), []);
  assert.deepEqual(maintainerScriptProblems("postinst", "xdg-mime default amplefile-desktop.desktop inode/directory\n"), ["postinst changes default applications"]);
  assert.deepEqual(maintainerScriptProblems("postrm", "  \n"), ["postrm is empty"]);
});

test("native helper provenance enumerates every Rust source of the crate", async t => {
  const crate = await mkdtemp(join(tmpdir(), "amplefile-crate-"));
  t.after(() => rm(crate, { recursive: true, force: true }));
  await mkdir(join(crate, "src/platform"), { recursive: true });
  await mkdir(join(crate, "examples"));
  for (const path of ["Cargo.toml", "Cargo.lock", "src/main.rs", "src/new_module.rs", "src/platform/mod.rs", "src/notes.txt", "examples/probe.rs"]) {
    await writeFile(join(crate, path), "");
  }
  assert.deepEqual(await crateSourcePaths(crate), ["Cargo.toml", "Cargo.lock", "src/main.rs", "src/new_module.rs", "src/platform/mod.rs"]);
  await writeFile(join(crate, "build.rs"), "");
  assert.deepEqual((await crateSourcePaths(crate)).slice(0, 3), ["Cargo.toml", "Cargo.lock", "build.rs"]);
});
