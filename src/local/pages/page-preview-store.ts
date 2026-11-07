/**
 * Test entries (docs/pages.md, "Preview and test entries"): one preview
 * database per page under the state root, at
 * `pages/preview/<connectedFolderId>/<key>.sqlite`, keyed by the page folder's
 * Connected Folder–relative path. Never in the Connected Folder, never online.
 * Renaming the page folder starts a fresh test database.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { PageDeclaration, PageEngineEnvironment, PageSchemaStatus, PageSqlDatabase } from "../../shared/pages/index.js";
import {
  applyPageSchema,
  createPageVisitorId,
  ensurePageMetaTable,
  isValidPageVisitorId,
  purgeDeletedPageRows,
  readPageMeta,
  writePageMeta,
} from "../../shared/pages/index.js";
import { ampleFileStateRoot } from "../state-paths.js";
import { PageFolderError } from "./page-folder-files.js";
import { openPageSqliteDatabase } from "./page-sqlite.js";

const connectedFolderIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

export function pagePreviewRoot(): string {
  return join(ampleFileStateRoot(), "pages", "preview");
}

/** A truncated SHA-256 of the page folder's Connected Folder–relative path. */
export function pagePreviewKey(pagePath: string): string {
  return createHash("sha256").update(pagePath, "utf8").digest("hex").slice(0, 32);
}

export function pagePreviewDatabasePath(connectedFolderId: string, pagePath: string): string {
  if (!connectedFolderIdPattern.test(connectedFolderId)) throw new PageFolderError(400, "That Connected Folder id isn't valid.");
  return join(pagePreviewRoot(), connectedFolderId, `${pagePreviewKey(pagePath)}.sqlite`);
}

export interface PagePreviewDatabase {
  db: PageSqlDatabase;
  /** Null while page.json has problems: the stored tables stay as they were. */
  schema: PageSchemaStatus | null;
}

/**
 * Opens a page's preview database, brings it in line with the declaration
 * (additively), purges rows deleted more than 30 days ago, runs `operation`,
 * and closes it. Every step inside `operation` is synchronous.
 */
export async function withPagePreviewDatabase<T>(
  connectedFolderId: string,
  pagePath: string,
  declaration: PageDeclaration | null,
  operation: (preview: PagePreviewDatabase) => T,
  environment: PageEngineEnvironment = {},
): Promise<T> {
  const path = pagePreviewDatabasePath(connectedFolderId, pagePath);
  await mkdir(join(pagePreviewRoot(), connectedFolderId), { recursive: true });
  const db = openPageSqliteDatabase(path);
  try {
    ensurePageMetaTable(db);
    if (readPageMeta(db, "pagePath") !== pagePath) writePageMeta(db, "pagePath", pagePath);
    if (readPageMeta(db, "connectedFolderId") !== connectedFolderId) writePageMeta(db, "connectedFolderId", connectedFolderId);
    const schema = declaration ? applyPageSchema(db, declaration, environment.now?.() ?? new Date()) : null;
    purgeDeletedPageRows(db, environment);
    return operation({ db, schema });
  } finally {
    db.close();
  }
}

/** The page's current preview visitor, or a fresh one that becomes current. */
export function currentPreviewVisitor(db: PageSqlDatabase, fresh: boolean): string {
  const current = readPageMeta(db, "previewVisitor");
  if (!fresh && isValidPageVisitorId(current)) return current;
  const visitor = createPageVisitorId();
  writePageMeta(db, "previewVisitor", visitor);
  return visitor;
}
