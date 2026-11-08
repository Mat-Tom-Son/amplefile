import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import test from "node:test";

import {
  ampleFileDesktopUserDataPath,
  ampleFileDesktopStateOverride,
  ampleFileDesktopUsesInstalledProductData,
} from "../desktop/src/user-data-path.js";

test("non-packaged desktop runs cannot default to installed AmpleFile state", () => {
  const appDataPath = "C:\\Users\\developer\\AppData\\Roaming";
  const development = ampleFileDesktopUserDataPath({
    appDataPath,
    productName: "AmpleFile",
    useInstalledProductData: false,
    platform: "win32",
    currentDirectory: "C:\\source\\amplefile",
  });
  const production = ampleFileDesktopUserDataPath({
    appDataPath,
    productName: "AmpleFile",
    useInstalledProductData: true,
    platform: "win32",
    currentDirectory: "C:\\source\\amplefile",
  });

  assert.equal(development, win32.join(appDataPath, "AmpleFile Development"));
  assert.equal(production, win32.join(appDataPath, "AmpleFile"));
  assert.notEqual(development.toLowerCase(), production.toLowerCase());
});

test("desktop user-data override remains explicit in development and production", () => {
  const common = {
    appDataPath: "/Users/developer/Library/Application Support",
    productName: "AmpleFile",
    override: "fixtures/desktop-state",
    platform: "darwin" as const,
    currentDirectory: "/source/amplefile",
  };
  assert.equal(
    ampleFileDesktopUserDataPath({ ...common, useInstalledProductData: false }),
    "/source/amplefile/fixtures/desktop-state",
  );
  assert.equal(
    ampleFileDesktopUserDataPath({ ...common, useInstalledProductData: true }),
    "/source/amplefile/fixtures/desktop-state",
  );
});

test("only the explicit AmpleFile desktop variable selects desktop state", () => {
  assert.equal(ampleFileDesktopStateOverride({}), undefined);
  assert.equal(ampleFileDesktopStateOverride({
    AMPLEFILE_DESKTOP_STATE_DIR: "C:\\fixtures\\explicit-desktop-state",
  }), "C:\\fixtures\\explicit-desktop-state");
});

test("only an installer-owned packaged Windows app selects installed product data", () => {
  const executablePath = "C:\\build\\win-unpacked\\AmpleFile.exe";
  const expectedUninstaller = "C:\\build\\win-unpacked\\Uninstall AmpleFile.exe";

  assert.equal(ampleFileDesktopUsesInstalledProductData({
    executablePath,
    productName: "AmpleFile",
    isPackaged: false,
    platform: "win32",
    fileExists: () => true,
  }), false, "source Electron stays isolated even if its directory happens to contain an uninstaller");
  assert.equal(ampleFileDesktopUsesInstalledProductData({
    executablePath,
    productName: "AmpleFile",
    isPackaged: true,
    platform: "win32",
    fileExists: (path) => path === expectedUninstaller,
  }), true);
  assert.equal(ampleFileDesktopUsesInstalledProductData({
    executablePath,
    productName: "AmpleFile",
    isPackaged: true,
    platform: "win32",
    fileExists: () => false,
  }), false, "both feed-less smoke output and feed-bearing release candidates stay isolated before installation");
});

test("packaged non-Windows identities retain their configured data directory", () => {
  assert.equal(ampleFileDesktopUsesInstalledProductData({
    executablePath: "/Applications/AmpleFile.app/Contents/MacOS/AmpleFile",
    productName: "AmpleFile",
    isPackaged: true,
    platform: "darwin",
    fileExists: () => false,
  }), true);
});

test("desktop startup delegates installed-state selection to the fail-safe classifier", () => {
  const main = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /ampleFileDesktopUsesInstalledProductData\(\{[\s\S]*?executablePath:\s*process\.execPath/);
  assert.match(main, /fileExists:\s*existsSync/);
  assert.match(main, /ampleFileDesktopUserDataPath\(\{[\s\S]*?useInstalledProductData/);
});
