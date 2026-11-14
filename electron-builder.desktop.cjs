const path = require("node:path");
const identity = require("./src/shared/product-identity.json");
const { resolveMacReleaseFeed } = require("./scripts/mac-release-feed.cjs");

const root = __dirname;
const macReleaseBuild = process.env.AMPLEFILE_MAC_RELEASE_BUILD === "1";
const unsignedMacBuild = process.env.AMPLEFILE_ALLOW_UNSIGNED_MAC_BUILD === "1";
const macSignIdentity = process.env.AMPLEFILE_MAC_SIGN_IDENTITY?.trim();
const electronBuilderMacIdentity = macSignIdentity?.replace(/^Developer ID Application:\s*/i, "");
// The feed the packaged app checks. Electron Builder writes this entry into
// Contents/Resources/app-update.yml; the build never uploads (--publish
// never), and scripts/publish-mac-release.mjs decides where the release goes.
const macUpdateFeed = resolveMacReleaseFeed(identity).packaged;
const outputDirectory = process.env.AMPLEFILE_DESKTOP_OUTPUT_DIR?.trim() || "out/builder";
// Written by npm run desktop:icons (scripts/generate-desktop-icons.mjs).
const linuxIconSet = path.join(root, "out", "generated-assets", "linux-icons");
// fpm source=destination mapping for the scalable hicolor icon.
const scalableIconMapping = `${path.join(linuxIconSet, "scalable", `${identity.packageName}.svg`)}=/usr/share/icons/hicolor/scalable/apps/${identity.packageName}.svg`;

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
      owner: macUpdateFeed.owner,
      repo: macUpdateFeed.repo,
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
  // This runtime works without the legacy libfuse2 package. Its default
  // launcher arguments are empty: no --no-sandbox, and no --ozone-platform,
  // which the app chooses itself at startup (desktop/src/linux-launch.ts).
  toolsets: { appimage: "1.0.3" },
  linux: {
    target: [{ target: "deb", arch: ["x64"] }, { target: "rpm", arch: ["x64"] }, { target: "AppImage", arch: ["x64"] }],
    executableName: identity.packageName,
    syncDesktopName: true,
    // A file manager first (docs/product-model.md), so the menu spec's
    // FileManager under Utility;FileTools rather than Office.
    category: "Utility;FileTools;FileManager",
    // "Open With" for folders. Declaring a type never makes AmpleFile the
    // default: nothing here or in the install scripts runs xdg-mime or edits
    // mimeapps.list. A folder opens only if it is already a Connected Folder.
    mimeTypes: ["inode/directory"],
    maintainer: identity.sourceRepositoryOwner,
    synopsis: "Work with AI in ordinary folders",
    // The desktop entry's Comment and the packages' description.
    description: "Browse ordinary folders and work in them with an AI Worker for each Connected Folder",
    // The hicolor PNG set from npm run desktop:icons; DEB/RPM add the SVG below.
    icon: linuxIconSet,
    publish: null,
    extraFiles: [{ from: "out/included-tools/linux-cli", to: "bin" }],
    extraResources: [{ from: "out/included-tools/computer-helper", to: "computer-helper", filter: ["linux-bridge", "source.json", "LICENSE.pi-computer-use", "THIRD-PARTY-LICENSES.txt"] },
      { from: "out/included-tools/wayland-helper", to: "wayland-helper" },
      { from: "out/included-tools/clipboard-helper", to: "clipboard-helper" }],
    desktop: { entry: { GenericName: "File Manager", StartupWMClass: "amplefile-desktop", Keywords: "AI;Assistant;Folders;Files;" } },
  },
  deb: {
    afterInstall: "out/generated-linux-assets/after-install.sh",
    afterRemove: "out/generated-linux-assets/after-remove.sh",
    // Ubuntu 24.04 and Debian 13 renamed some libraries for 64-bit time
    // (libasound2t64 and others). On amd64 the new packages also provide the
    // old names; the alternatives keep resolution independent of that.
    depends: ["libc6 (>= 2.39)", "libgtk-3-0 | libgtk-3-0t64", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libglib2.0-bin", "libatspi2.0-0 | libatspi2.0-0t64", "libsecret-1-0", "libuuid1", "libgbm1", "libasound2 | libasound2t64", "expect",
      "libei1 (>= 1.2)", "libxkbcommon0", "libgstreamer1.0-0", "libgstreamer-plugins-base1.0-0", "gstreamer1.0-plugins-base", "gstreamer1.0-pipewire", "xdg-desktop-portal"],
    recommends: ["gnome-keyring"],
    fpm: [scalableIconMapping],
  },
  rpm: {
    afterInstall: "out/generated-linux-assets/after-install.sh",
    afterRemove: "out/generated-linux-assets/after-remove.sh",
    depends: ["glibc >= 2.39", "gtk3", "libnotify", "nss", "libXScrnSaver", "libXtst", "xdg-utils", "glib2", "at-spi2-core", "libsecret", "libuuid", "mesa-libgbm", "alsa-lib", "expect",
      "libei >= 1.2", "libxkbcommon", "gstreamer1", "gstreamer1-plugins-base", "pipewire-gstreamer", "xdg-desktop-portal"],
    // Electron Builder has no RPM recommends option; fpm writes the weak
    // dependency into the spec, matching the DEB's keyring recommendation.
    fpm: ["--rpm-tag", "Recommends: gnome-keyring", scalableIconMapping],
  },
  mac: {
    extraResources: [{ from: "out/included-tools/computer-helper", to: "computer-helper" }],
    // The afterPack hook signs this Swift app without Electron JIT entitlements.
    signIgnore: ["/computer-helper/"],
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
