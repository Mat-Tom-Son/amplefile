import assert from "node:assert/strict";
import test from "node:test";

import { chatContextRequestForTab } from "../web-local/src/lib/chat-context-request.js";

const request = {
  id: 7,
  path: "budget.csv",
  connectedFolderId: "connected-folder-source",
  surfaceTabId: "chat:connected-folder-source:new:7",
};

test("a file attachment request reaches only its exact Connected Folder–bound Chat tab", () => {
  assert.equal(chatContextRequestForTab(request, "connected-folder-source", "chat:connected-folder-source:new:7"), request);
  assert.equal(chatContextRequestForTab(request, "connected-folder-target", "chat:connected-folder-source:new:7"), null);
  assert.equal(chatContextRequestForTab(request, "connected-folder-source", "chat:connected-folder-source:new:8"), null);
  assert.equal(chatContextRequestForTab(null, "connected-folder-source", "chat:connected-folder-source:new:7"), null);
});
