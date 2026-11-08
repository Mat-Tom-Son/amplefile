import assert from "node:assert/strict";
import test from "node:test";

import { knownConnectedFolderIconOption, connectedFolderIconOptionFor, connectedFolderIconOptions } from "../web-local/src/connected-folder-icons.js";

/**
 * A name the Connected Folder icon catalog does not know finds no entry, so a
 * caller can keep its own generic glyph; it must not fall through to the
 * catalog's first entry, which is a folder. Connected Folder icons keep their
 * own folder fallback.
 */
test("an unknown icon name finds no catalog entry, while Connected Folder icons fall back to the folder", () => {
  // The lookup itself: known names and aliases resolve, anything else is null,
  // and the Connected Folder lookup still falls back to its first (folder) entry.
  assert.equal(knownConnectedFolderIconOption("mail")?.name, "mail");
  assert.equal(knownConnectedFolderIconOption("  MAIL ")?.name, "mail");
  assert.equal(knownConnectedFolderIconOption("archive-restore")?.name, "archive", "an alias is a known name");
  for (const guess of ["images", "photos", "screenshots"]) {
    assert.equal(knownConnectedFolderIconOption(guess)?.name, "image", `a Worker's natural guess "${guess}" finds the image icon`);
  }
  assert.equal(knownConnectedFolderIconOption("definitely-not-an-icon"), null);
  assert.equal(knownConnectedFolderIconOption(undefined), null);
  assert.equal(knownConnectedFolderIconOption(""), null);
  assert.equal(connectedFolderIconOptionFor("definitely-not-an-icon"), connectedFolderIconOptions[0]);
  assert.equal(connectedFolderIconOptions[0]!.name, "folder");
});
