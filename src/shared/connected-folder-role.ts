/**
 * A Connected Folder's Role: what the folder is for, in the person's words
 * (docs/product-model.md, "Role"). Portable: it lives in the folder's own
 * `.amplefile/role.json`, apart from the identity manifest, so a moved or
 * copied folder keeps it. Pure and synchronous: the store that reads and
 * writes the file is `src/local/connected-folder-role.ts`.
 */

export const connectedFolderRoleVersion = 1 as const;
export const connectedFolderRoleFileName = "role.json";

export const connectedFolderRoleLimits = {
  /** Characters in the purpose. */
  purpose: 280,
  /** Entries in each list. */
  listEntries: 8,
  /** Characters in one list entry. */
  entry: 140,
  /** A role file larger than this is not ours; it reads as no role. */
  fileBytes: 32 * 1024,
} as const;

export const connectedFolderRoleListFields = ["askFor", "produces", "accepts"] as const;
export type ConnectedFolderRoleListField = typeof connectedFolderRoleListFields[number];

/** A Role as stored and served. Every field but `version` is optional; empty lists are omitted. */
export interface ConnectedFolderRole {
  version: typeof connectedFolderRoleVersion;
  /** What this folder is for, in one line. */
  purpose?: string;
  /** What to bring to this folder's Worker: the questions it answers. */
  askFor?: string[];
  /** What it makes: the things it hands back. */
  produces?: string[];
  /** What it takes in: the things that belong here. */
  accepts?: string[];
  updatedAt: string;
}

/** The fields a person, the window, or a verb can set; an omitted field is left as it was. */
export interface ConnectedFolderRoleInput {
  purpose?: string;
  askFor?: string[];
  produces?: string[];
  accepts?: string[];
}

export class ConnectedFolderRoleError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "newer-version" | "unavailable",
  ) {
    super(message);
    this.name = "ConnectedFolderRoleError";
  }
}

/** One line, single spaces, no control characters. */
export function normalizeConnectedFolderRoleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
}

const fieldLabels: Record<"purpose" | ConnectedFolderRoleListField, string> = {
  purpose: "The purpose",
  askFor: "Ask for",
  produces: "Produces",
  accepts: "Accepts",
};

/** Validates a purpose for a write: too long is refused, never cut. */
export function normalizeConnectedFolderRolePurpose(value: unknown): string {
  if (typeof value !== "string") throw new ConnectedFolderRoleError("The purpose must be text.", "invalid");
  const purpose = normalizeConnectedFolderRoleLine(value);
  if (purpose.length > connectedFolderRoleLimits.purpose) {
    throw new ConnectedFolderRoleError(`The purpose must be ${connectedFolderRoleLimits.purpose} characters or fewer.`, "invalid");
  }
  return purpose;
}

/** Validates one list for a write: blanks and repeats drop out; too many or too long is refused, never cut. */
export function normalizeConnectedFolderRoleList(field: ConnectedFolderRoleListField, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ConnectedFolderRoleError(`${fieldLabels[field]} must be a list of text entries.`, "invalid");
  }
  const entries: string[] = [];
  for (const raw of value as string[]) {
    const entry = normalizeConnectedFolderRoleLine(raw);
    if (!entry || entries.includes(entry)) continue;
    if (entry.length > connectedFolderRoleLimits.entry) {
      throw new ConnectedFolderRoleError(`Each ${fieldLabels[field].toLowerCase()} entry must be ${connectedFolderRoleLimits.entry} characters or fewer.`, "invalid");
    }
    entries.push(entry);
  }
  if (entries.length > connectedFolderRoleLimits.listEntries) {
    throw new ConnectedFolderRoleError(`${fieldLabels[field]} can hold at most ${connectedFolderRoleLimits.listEntries} entries.`, "invalid");
  }
  return entries;
}

/** The role with this input applied: a given field replaces the old one, an empty one clears it, an omitted one stays. */
export function applyConnectedFolderRoleInput(
  current: ConnectedFolderRole | null,
  input: ConnectedFolderRoleInput,
  updatedAt: string,
): ConnectedFolderRole | null {
  const purpose = input.purpose !== undefined ? normalizeConnectedFolderRolePurpose(input.purpose) : current?.purpose ?? "";
  const lists: Record<ConnectedFolderRoleListField, string[]> = {
    askFor: input.askFor !== undefined ? normalizeConnectedFolderRoleList("askFor", input.askFor) : current?.askFor ?? [],
    produces: input.produces !== undefined ? normalizeConnectedFolderRoleList("produces", input.produces) : current?.produces ?? [],
    accepts: input.accepts !== undefined ? normalizeConnectedFolderRoleList("accepts", input.accepts) : current?.accepts ?? [],
  };
  const role: ConnectedFolderRole = {
    version: connectedFolderRoleVersion,
    ...(purpose ? { purpose } : {}),
    ...(lists.askFor.length ? { askFor: lists.askFor } : {}),
    ...(lists.produces.length ? { produces: lists.produces } : {}),
    ...(lists.accepts.length ? { accepts: lists.accepts } : {}),
    updatedAt,
  };
  return isEmptyConnectedFolderRole(role) ? null : role;
}

/** An empty role is the same as none. */
export function isEmptyConnectedFolderRole(role: ConnectedFolderRole | null | undefined): boolean {
  return !role || (!role.purpose && !role.askFor?.length && !role.produces?.length && !role.accepts?.length);
}

/** True when two roles say the same thing (the time they were saved does not count). */
export function connectedFolderRolesEqual(left: ConnectedFolderRole | null, right: ConnectedFolderRole | null): boolean {
  return JSON.stringify(roleContent(left)) === JSON.stringify(roleContent(right));
}

function roleContent(role: ConnectedFolderRole | null) {
  return role ? { purpose: role.purpose ?? "", askFor: role.askFor ?? [], produces: role.produces ?? [], accepts: role.accepts ?? [] } : null;
}

export type ParsedConnectedFolderRole =
  | { kind: "role"; role: ConnectedFolderRole }
  /** Valid JSON of the current version with nothing in it. */
  | { kind: "empty" }
  /** Written by a newer AmpleFile: reads as no role and is never overwritten by a read. */
  | { kind: "newer-version" }
  | { kind: "malformed" };

/**
 * Reads a role file's text. A malformed or newer-version file reads as no
 * role. A hand-edited file that runs past a bound is kept, cut to the bound,
 * so the prompt stays bounded without losing what the person wrote.
 */
export function parseConnectedFolderRoleFile(text: string): ParsedConnectedFolderRole {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed" };
  const record = parsed as Record<string, unknown>;
  if (typeof record.version !== "number" || !Number.isInteger(record.version) || record.version < 1) return { kind: "malformed" };
  if (record.version > connectedFolderRoleVersion) return { kind: "newer-version" };
  const purposeValue = record.purpose;
  if (purposeValue !== undefined && typeof purposeValue !== "string") return { kind: "malformed" };
  const purpose = purposeValue === undefined ? "" : normalizeConnectedFolderRoleLine(purposeValue).slice(0, connectedFolderRoleLimits.purpose).trim();
  const lists = {} as Record<ConnectedFolderRoleListField, string[]>;
  for (const field of connectedFolderRoleListFields) {
    const value = record[field];
    if (value === undefined) {
      lists[field] = [];
      continue;
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return { kind: "malformed" };
    const entries: string[] = [];
    for (const raw of value as string[]) {
      const entry = normalizeConnectedFolderRoleLine(raw).slice(0, connectedFolderRoleLimits.entry).trim();
      if (entry && !entries.includes(entry)) entries.push(entry);
    }
    lists[field] = entries.slice(0, connectedFolderRoleLimits.listEntries);
  }
  const updatedAt = typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt))
    ? record.updatedAt
    : new Date(0).toISOString();
  const role: ConnectedFolderRole = {
    version: connectedFolderRoleVersion,
    ...(purpose ? { purpose } : {}),
    ...(lists.askFor.length ? { askFor: lists.askFor } : {}),
    ...(lists.produces.length ? { produces: lists.produces } : {}),
    ...(lists.accepts.length ? { accepts: lists.accepts } : {}),
    updatedAt,
  };
  return isEmptyConnectedFolderRole(role) ? { kind: "empty" } : { kind: "role", role };
}

/** The file's text: stable key order, a trailing newline. */
export function serializeConnectedFolderRole(role: ConnectedFolderRole): string {
  return `${JSON.stringify(role, null, 2)}\n`;
}

/**
 * A role as a hidden-context block a model reads: short labelled lines, never
 * JSON a model could mistake for an instruction envelope.
 */
export function describeConnectedFolderRole(role: ConnectedFolderRole): string {
  const lines: string[] = [];
  if (role.purpose) lines.push(`Purpose: ${role.purpose}`);
  if (role.askFor?.length) lines.push(`Ask it for: ${role.askFor.join("; ")}`);
  if (role.produces?.length) lines.push(`It produces: ${role.produces.join("; ")}`);
  if (role.accepts?.length) lines.push(`It accepts: ${role.accepts.join("; ")}`);
  return lines.join("\n");
}
