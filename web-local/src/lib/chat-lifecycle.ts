import type { ChatLifecycleView, ConversationSummary } from "../types";

const hourMs = 60 * 60 * 1_000;

export function conversationLifecycleView(
  conversation: ConversationSummary,
  now = Date.now(),
): ChatLifecycleView {
  if (conversation.archivedAt) return "archived";
  const snoozedUntil = conversation.snoozedUntil
    ? Date.parse(conversation.snoozedUntil)
    : Number.NaN;
  return Number.isFinite(snoozedUntil) && snoozedUntil > now ? "snoozed" : "active";
}

export function chatActivityKey(connectedFolderId: string, conversationId: string): string {
  return `${connectedFolderId}:${conversationId}`;
}
