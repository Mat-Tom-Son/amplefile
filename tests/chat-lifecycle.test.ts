import assert from "node:assert/strict";
import test from "node:test";

import { chatActivityKey, conversationLifecycleView } from "../web-local/src/lib/chat-lifecycle.js";
import { normalizeChatAttentionKeys } from "../web-local/src/hooks/useChatActivity.js";

test("conversation lifecycle prioritizes archive and automatically resurfaces due snoozes", () => {
  const now = Date.parse("2026-07-25T16:00:00.000Z");
  const base = { id: "chat-1", title: "Launch notes", updatedAt: "2026-07-25T12:00:00.000Z" };

  assert.equal(conversationLifecycleView(base, now), "active");
  assert.equal(conversationLifecycleView({ ...base, snoozedUntil: "2026-07-25T17:00:00.000Z" }, now), "snoozed");
  assert.equal(conversationLifecycleView({ ...base, snoozedUntil: "2026-07-25T15:00:00.000Z" }, now), "active");
  assert.equal(conversationLifecycleView({
    ...base,
    archivedAt: "2026-07-25T14:00:00.000Z",
    snoozedUntil: "2026-07-25T17:00:00.000Z",
  }, now), "archived");
});

test("chat activity keys remain scoped to a Connected Folder and conversation", () => {
  assert.equal(chatActivityKey("connected-folder-a", "chat-1"), "connected-folder-a:chat-1");
  assert.notEqual(chatActivityKey("connected-folder-a", "chat-1"), chatActivityKey("connected-folder-b", "chat-1"));
});

test("persisted attention state keeps only bounded scoped keys", () => {
  assert.deepEqual(
    [...normalizeChatAttentionKeys(["connected-folder-a:chat-1", "connected-folder-a:chat-1", "", 3, "unscoped"])],
    ["connected-folder-a:chat-1"],
  );
  assert.deepEqual([...normalizeChatAttentionKeys({ key: "connected-folder-a:chat-1" })], []);
});
