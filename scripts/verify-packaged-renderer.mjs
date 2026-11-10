import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFile, getRawHeader } from "@electron/asar";

const rendererRoot = "dist/web-local";
const pages = [
  ["index.html", "renderer index"],
  ["popover.html", "AmpleFile Agent popover renderer"],
];
// Resolves a page's relative references the way the internal scheme does.
// Only references without a scheme or host are resolved against it, so the
// origin itself never matches anything a page could name.
const pageOrigin = "https://app";

/** The main window and the AmpleFile Agent popover must run only code that
 * Electron's ASAR integrity validation covers, and all of the renderer that
 * was built. That holds when `dist/web-local` in `app.asar` is the local
 * renderer build file for file, every entry is a regular archived file
 * (not unpacked, not a link), both pages name their scripts and stylesheets
 * by path inside it, and no loose copy ships beside the archive.
 *
 * `rendererBuildDir` is the `dist/web-local` the package was built from. The
 * comparison covers what the pages never name: lazily loaded chunks, fonts
 * and images, and stale files the build did not produce.
 * Returns the failures; an empty list means the renderer is covered.
 */
export function verifyPackagedRenderer({ asarPath, resourcesDir, rendererBuildDir }) {
  const failures = [];
  const archived = new Map();
  collect(rendererDirectory(getRawHeader(asarPath).header), rendererRoot, false, archived);

  for (const [page, label] of pages) {
    const pagePath = `${rendererRoot}/${page}`;
    if (!archived.has(pagePath)) {
      failures.push(`app.asar is missing the ${label}: /${pagePath}.`);
      continue;
    }
    // A link is reported below; it has no bytes of its own to read here.
    if (archived.get(pagePath).link) continue;
    const html = extractFile(asarPath, pagePath).toString("utf8");
    for (const reference of loadedReferences(html)) {
      if (/^data:/i.test(reference)) continue;
      // In the app, only a path stays inside the internal scheme: a
      // reference with a scheme or a host goes somewhere else, whatever it
      // names.
      if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || /^[\\/]{2}/.test(reference)) {
        failures.push(`${page} loads ${reference} from outside the app.`);
        continue;
      }
      const url = new URL(reference, `${pageOrigin}/${page}`);
      const target = `${rendererRoot}${decodeURIComponent(url.pathname)}`;
      if (!archived.has(target)) failures.push(`${page} loads ${reference}, which is not inside app.asar.`);
    }
  }

  for (const [path, entry] of archived) {
    // A link can point at an unpacked file or outside the renderer build, so
    // the renderer holds regular archived files only.
    if (entry.link) failures.push(`Renderer file must be a regular file in app.asar, not a link: /${path}.`);
    else if (entry.unpacked) failures.push(`Renderer file must stay inside app.asar, not unpacked: /${path}.`);
  }
  compareWithBuild({ asarPath, archived, rendererBuildDir, failures });
  for (const loose of [join(resourcesDir, "web-local"), join(resourcesDir, "app.asar.unpacked", "dist", "web-local")]) {
    if (existsSync(loose)) failures.push(`Renderer files must not ship outside app.asar: ${loose}.`);
  }
  return failures;
}

/** The archive must hold exactly the files of the renderer build, byte for byte. */
function compareWithBuild({ asarPath, archived, rendererBuildDir, failures }) {
  if (!existsSync(join(rendererBuildDir, "index.html"))) {
    failures.push(`The renderer build to compare app.asar with was not found at ${rendererBuildDir}. Verify a package from the tree that built it.`);
    return;
  }
  const built = new Map();
  collectBuild(rendererBuildDir, rendererRoot, built, failures);
  for (const [path, file] of built) {
    const entry = archived.get(path);
    if (!entry) failures.push(`app.asar is missing a file of the renderer build: /${path}.`);
    // Links and unpacked files are reported on their own.
    else if (!entry.link && !entry.unpacked && sha256(extractFile(asarPath, path)) !== sha256(readFileSync(file))) {
      failures.push(`Renderer file in app.asar differs from the renderer build: /${path}.`);
    }
  }
  for (const path of archived.keys()) {
    if (!built.has(path)) failures.push(`app.asar holds a renderer file the renderer build does not: /${path}.`);
  }
}

function collectBuild(directory, prefix, built, failures) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Finder's folder metadata is not part of the build and is never packaged.
    if (entry.name === ".DS_Store") continue;
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) collectBuild(join(directory, entry.name), path, built, failures);
    else if (entry.isFile()) built.set(path, join(directory, entry.name));
    else failures.push(`The renderer build holds something other than a regular file: /${path}.`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rendererDirectory(header) {
  let directory = header;
  for (const segment of rendererRoot.split("/")) directory = directory?.files?.[segment];
  return directory;
}

function collect(directory, prefix, parentUnpacked, archived) {
  for (const [name, entry] of Object.entries(directory?.files ?? {})) {
    const path = `${prefix}/${name}`;
    const unpacked = parentUnpacked || entry.unpacked === true;
    if (entry.files) collect(entry, path, unpacked, archived);
    else archived.set(path, { unpacked, link: entry.link !== undefined });
  }
}

/** The `src` and `href` targets of a page's script and link elements. */
function loadedReferences(html) {
  const references = [];
  // Quoted attribute values are consumed whole, so a `>` or a `src=` inside
  // one is never read as markup.
  for (const element of html.matchAll(/<(?:script|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    for (const attribute of element[1].matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = attribute[1].toLowerCase();
      const value = (attribute[2] ?? attribute[3] ?? attribute[4] ?? "").trim();
      if ((name === "src" || name === "href") && value) references.push(value);
    }
  }
  return references;
}
