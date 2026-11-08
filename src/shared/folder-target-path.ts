/**
 * The folder-target contract Automations use to name files and folders inside
 * a Connected Folder: exact files and bounded trees, each relative to the
 * Connected Folder root. Stored automation declarations are digested in this
 * normalized form, so its behavior must never change.
 */
export type FolderTargetRole = "primary" | "reference";

export interface FolderFileTarget {
  kind: "file";
  role: FolderTargetRole;
  path: string;
}

export interface FolderTreeTarget {
  kind: "tree";
  role: FolderTargetRole;
  path: string;
  recursive: boolean;
  extensions: string[];
}

export type FolderTarget = FolderFileTarget | FolderTreeTarget;

export function normalizeFolderTargetPath(value: unknown, label = "Folder target path"): string {
  if (typeof value !== "string" || value !== value.trim()) throw new Error(`${label} cannot have leading or trailing whitespace.`);
  const path = boundedText(value, label, 512).replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) throw new Error(`${label} must be relative to the Connected Folder.`);
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a normalized relative path.`);
  }
  if (segments.some((segment) => {
    const normalized = segment.toLocaleLowerCase("en-US");
    return normalized === ".amplefile" || normalized === ".pi";
  })) {
    throw new Error(`${label} cannot select hidden AmpleFile or Pi configuration.`);
  }
  if (segments.some(isUnsafeWindowsPathSegment)) {
    throw new Error(`${label} contains a Windows-reserved or ambiguous path segment.`);
  }
  return segments.join("/");
}

function isUnsafeWindowsPathSegment(segment: string): boolean {
  if (segment.includes(":") || /[. ]$/.test(segment)) return true;
  const stem = segment.split(".", 1)[0]!.toLocaleLowerCase("en-US");
  return stem === "con" || stem === "prn" || stem === "aux" || stem === "nul"
    || /^com[1-9]$/.test(stem) || /^lpt[1-9]$/.test(stem);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid or too long.`);
  }
  return normalized;
}
