const path = require("node:path");
const identity = require("./src/shared/product-identity.json");

const root = __dirname;
const macReleaseBuild = process.env.AMPLEFILE_MAC_RELEASE_BUILD === "1";
const unsignedMacBuild = process.env.AMPLEFILE_ALLOW_UNSIGNED_MAC_BUILD === "1";
const macSignIdentity = process.env.AMPLEFILE_MAC_SIGN_IDENTITY?.trim();
const electronBuilderMacIdentity = macSignIdentity?.replace(/^Developer ID Application:\s*/i, "");
const macReleaseOwner = process.env.AMPLEFILE_MAC_RELEASE_OWNER?.trim() || identity.sourceRepositoryOwner;
const macReleaseRepo = process.env.AMPLEFILE_MAC_RELEASE_REPO?.trim() || identity.macReleaseRepositoryName;
const outputDirectory = process.env.AMPLEFILE_DESKTOP_OUTPUT_DIR?.trim() || "out/builder";

module.exports = {
  appId: unsignedMacBuild ? identity.macSmokeAppId : identity.productionAppId,
  productName: unsignedMacBuild ? identity.macSmokeProductName : identity.productName,
  extraMetadata: {
    ampleFileBuildChannel: unsignedMacBuild ? "mac-local-smoke" : "production",
  },
  copyright: "Copyright © 2026 Mat-Tom-Son",
  artifactName: `${identity.productName}-\${version}-\${os}-\${arch}.\${ext}`,
  forceCodeSigning: macReleaseBuild || process.env.AMPLEFILE_REQUIRE_CODE_SIGNING === "1",
  electronUpdaterCompatibility: ">=2.16",
  generateUpdatesFilesForAllChannels: false,
  publish: [
    {
      provider: "github",
      owner: macReleaseOwner,
      repo: macReleaseRepo,
      releaseType: "release",
    },
  ],
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  directories: {
    output: outputDirectory,
    buildResources: "desktop/assets",
  },
  // The renderer build (the main window and the AmpleFile Agent popover) is
  // archived with the main process so ASAR integrity validation covers every
  // byte of code the windows run. Never list it under extraResources or
  // asarUnpack: both put it on disk as loose files the fuses do not check.
  files: ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "dist/desktop/**/*", "dist/web-local/**/*", "resources/included-tools/**/*"],
  extraFiles: [
    {
      from: "desktop/cli",
      to: "bin",
      filter: [identity.cliCommand, `${identity.cliCommand}-cli.jxa.js`],
    },
  ],
  extraResources: [
    {
      from: "desktop/assets",
      to: "assets",
      // The brand sources (desktop/assets/brand) build the icons; the app
      // itself never reads them.
      filter: ["**/*", "!brand/**"],
    },
  ],
  afterPack: require("./scripts/sign-computer-helper.cjs"),
  asar: true,
  // Node worker entrypoints and native canvas bindings must be real files.
  // PDF.js, its fonts and other JS libraries remain in the verified archive.
  // Electron Builder also unpacks, whole, every package that contains a
  // binary or an executable (docs/macos-build.md names them); unpacked files
  // are outside ASAR integrity and covered by the code signature only.
  asarUnpack: ["resources/included-tools/documents/worker.mjs", "node_modules/@napi-rs/**/*.node"],
  compression: "normal",
  npmRebuild: false,
  mac: {
    extraResources: [{ from: "out/included-tools/computer-helper", to: "computer-helper" }, { from: "out/included-tools/chrome-native-host", to: "chrome-native-host" }],
    // The afterPack hook signs this Swift app without Electron JIT entitlements.
    signIgnore: ["/computer-helper/", "/chrome-native-host/"],
    target: ["dmg", "zip"],
    icon: path.join(root, "desktop", "assets", "icon.icns"),
    category: "public.app-category.productivity",
    minimumSystemVersion: "12.0",
    darkModeSupport: true,
    executableName: unsignedMacBuild ? identity.macSmokeProductName : identity.productName,
    identity: macReleaseBuild ? electronBuilderMacIdentity : unsignedMacBuild ? "-" : undefined,
    hardenedRuntime: macReleaseBuild,
    notarize: macReleaseBuild,
    entitlements: path.join(root, "desktop", "entitlements.plist"),
    entitlementsInherit: path.join(root, "desktop", "entitlements.plist"),
    // What macOS shows when a site in the built-in browser asks for these
    // (docs/built-in-browser.md; the browser asks the person first), and when
    // the file manager first opens a standard folder.
    extendInfo: {
      NSCameraUsageDescription: "A website open in AmpleFile's browser wants to use your camera.",
      NSMicrophoneUsageDescription: "A website open in AmpleFile's browser wants to use your microphone.",
      NSLocationUsageDescription: "A website open in AmpleFile's browser wants to know your location.",
      NSLocationWhenInUseUsageDescription: "A website open in AmpleFile's browser wants to know your location.",
      // The File Manager's Standard Folders (docs/product-model.md).
      NSDesktopFolderUsageDescription: "AmpleFile shows your Desktop in its file manager.",
      NSDocumentsFolderUsageDescription: "AmpleFile shows your Documents folder in its file manager.",
      NSDownloadsFolderUsageDescription: "AmpleFile shows your Downloads folder in its file manager.",
    },
  },
  dmg: {
    artifactName: `${identity.productName}-\${version}-mac-\${arch}.\${ext}`,
    title: `${identity.productName} \${version}`,
    icon: path.join(root, "desktop", "assets", "icon.icns"),
    background: path.join(root, "out", "generated-assets", "dmg-background.png"),
    iconSize: 112,
    iconTextSize: 14,
    window: {
      width: 720,
      height: 440,
    },
    contents: [
      {
        x: 180,
        y: 260,
        type: "file",
      },
      {
        x: 540,
        y: 260,
        type: "link",
        path: "/Applications",
      },
    ],
  },
};
