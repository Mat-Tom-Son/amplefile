import { existsSync } from "node:fs";
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
 * Electron's ASAR integrity validation covers. That holds when both pages and
 * every script and stylesheet they name are archived in `app.asar` as regular
 * files, none of them is unpacked or a link, and no loose copy ships beside
 * the archive.
 * Returns the failures; an empty list means the renderer is covered.
 */
export function verifyPackagedRenderer({ asarPath, resourcesDir }) {
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
  for (const loose of [join(resourcesDir, "web-local"), join(resourcesDir, "app.asar.unpacked", "dist", "web-local")]) {
    if (existsSync(loose)) failures.push(`Renderer files must not ship outside app.asar: ${loose}.`);
  }
  return failures;
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
