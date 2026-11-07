import assert from "node:assert/strict";
import test from "node:test";

import { removeConnectedFolderConfirmText } from "../web-local/src/lib/connected-folder-ui.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";

const linkedConnectedFolder = {
  id: "connected-folder-source",
  name: "App source",
  location: { storage: "linked", providerHint: "local" },
} as ConnectedFolderSummary;

const managedSpace = {
  ...linkedConnectedFolder,
  id: "space-managed",
  name: "Managed work",
  location: { storage: "managed", providerHint: "local" },
} as ConnectedFolderSummary;

test("managed Connected Folder deletion names what moves and where it waits", () => {
  // Deleting a managed Connected Folder moves its folder to Recently deleted rather than
  // erasing it (docs/receipts-not-gates.md, F20), so the confirm names the
  // content classes that travel and where they can be brought back from,
  // instead of promising permanence it no longer delivers.
  const copy = removeConnectedFolderConfirmText(managedSpace);
  assert.match(copy, /every file and folder inside it/i);
  assert.match(copy, /Chats and History/i);
  assert.match(copy, /moves to Recently deleted/i);
  assert.match(copy, /Recently Deleted in Settings/);
  assert.match(copy, /put it back until its time runs out/i);
  assert.doesNotMatch(copy, /cannot be undone/i);
});

test("Connected Folder removal says where its App Studio history waits instead of promising an erase", () => {
  // Removing a Connected Folder keeps its App Studio history in Recently deleted
  // (docs/receipts-not-gates.md, F20), so the confirm names what moves, where
  // it waits, and what has to come back first — never "permanently".
  const copy = removeConnectedFolderConfirmText(linkedConnectedFolder, {
    project: { projectId: "project_fixture" },
    previews: [{}],
    releases: [{}, {}],
    operations: [{}],
  });
  assert.match(copy, /stops being a Connected Folder\. The folder and everything inside it stay where they are/i);
  assert.match(copy, /App Studio history on this computer/i);
  assert.match(copy, /1 Development preview, 2 Releases, 1 prepared operation, with their receipts/i);
  assert.match(copy, /moves to Recently Deleted too/);
  assert.match(copy, /Once the Connected Folder is back, you can put that back from there/);
  assert.doesNotMatch(copy, /permanent/i);
});

test("ordinary linked Connected Folder removal keeps the concise folder-preservation copy", () => {
  const copy = removeConnectedFolderConfirmText(linkedConnectedFolder, {
    project: null,
    previews: [],
    releases: [],
    operations: [],
    incomingPreparedOperationCount: 0,
  });
  assert.doesNotMatch(copy, /App Studio/i);
  assert.match(copy, /folder and everything inside it stay where they are/i);
});

test("target Connected Folder removal discloses incoming prepared App operations", () => {
  const copy = removeConnectedFolderConfirmText(linkedConnectedFolder, {
    project: null,
    previews: [],
    releases: [],
    operations: [],
    incomingPreparedOperationCount: 2,
  });
  assert.match(copy, /cancels 2 prepared App operations aimed at this Connected Folder; they wait in Recently Deleted until the Connected Folder is back/i);
});
