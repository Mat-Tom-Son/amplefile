/**
 * Mac packages (docs/product-model.md, "Packages"): folders Finder shows as
 * one item, an app or a document, and opens in their app instead of going
 * inside. They are known here by their extension, the way Finder knows the
 * common ones; a framework is a plain folder, as it is in Finder. The host
 * marks a listed folder (or a link to one) with this on macOS only, and
 * everything that is not opening it (copy, move, Compress, drag, search,
 * size) treats it as the folder it is.
 */

/** Each package extension, lowercase, with the Kind the window shows for it. */
const packageKinds: ReadonlyMap<string, string> = new Map(Object.entries({
  // Apps and the bundles apps and macOS load.
  app: "Application",
  appex: "App extension",
  bundle: "Bundle",
  plugin: "Plug-in",
  kext: "Kernel extension",
  xpc: "XPC service",
  prefpane: "Settings pane",
  saver: "Screen saver",
  qlgenerator: "Quick Look plug-in",
  mdimporter: "Spotlight importer",
  component: "Audio Unit plug-in",
  vst: "VST plug-in",
  vst3: "VST3 plug-in",
  workflow: "Automator workflow",
  action: "Automator action",
  scptd: "Script bundle",
  // Installer packages stored as folders.
  pkg: "Installer package",
  mpkg: "Installer package",
  // Libraries and projects apps keep as one item.
  photoslibrary: "Photos library",
  photolibrary: "iPhoto library",
  musiclibrary: "Music library",
  tvlibrary: "TV library",
  imovielibrary: "iMovie library",
  fcpbundle: "Final Cut Pro library",
  logicx: "Logic Pro project",
  band: "GarageBand project",
  // Documents.
  key: "Keynote presentation",
  pages: "Pages document",
  numbers: "Numbers spreadsheet",
  rtfd: "Rich text document with attachments",
  xcodeproj: "Xcode project",
  xcworkspace: "Xcode workspace",
  playground: "Xcode playground",
  xcarchive: "Xcode archive",
  sparsebundle: "Sparse bundle disk image",
}));

/** The extension a name ends with, lowercase, or "" when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether a folder by this name is a package on a Mac. */
export function isMacPackageName(name: string): boolean {
  return packageKinds.has(extensionOf(name));
}

/** What a package is, for the Kind column: "Application", "Pages document", or "Package" for a name that is not one. */
export function macPackageKind(name: string): string {
  return packageKinds.get(extensionOf(name)) ?? "Package";
}
