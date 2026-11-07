import { useEffect, useMemo, useState } from "react";

import { conversationLifecycleView } from "../../lib/chat-lifecycle";
import { api } from "../../lib/api";
import type { ChatLifecycleView, ConversationSummary, ConnectedFolderSummary } from "../../types";

export interface ChatContentMatch {
  conversationId: string;
  title: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  preview: string;
}

interface ChatSearchResponse {
  chats: ChatContentMatch[];
  truncated: boolean;
}

interface ChatSearchResult {
  byConnectedFolder: Record<string, ChatSearchResponse>;
  truncated: boolean;
  failedConnectedFolders: number;
}

const searchDebounceMs = 250;
const searchConcurrency = 3;
const visibleMatchLimit = 50;

export function ChatContentSearch({
  connectedFolders,
  conversations,
  query,
  now,
  onOpen,
}: {
  connectedFolders: ConnectedFolderSummary[];
  conversations: Record<string, ConversationSummary[]>;
  query: string;
  now: number;
  onOpen: (connectedFolder: ConnectedFolderSummary, conversation: ConversationSummary) => void;
}) {
  const [state, setState] = useState<{
    status: "idle" | "searching" | "ready" | "error";
    result: ChatSearchResult | null;
  }>({ status: "idle", result: null });
  const connectedFolderIds = connectedFolders.map((connectedFolder) => connectedFolder.id).join("|");

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setState({ status: "idle", result: null });
      return;
    }
    const controller = new AbortController();
    setState({ status: "searching", result: null });
    const timer = window.setTimeout(() => {
      void searchChatTranscripts(connectedFolders, trimmed, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setState({ status: "ready", result }); })
        .catch(() => { if (!controller.signal.aborted) setState({ status: "error", result: null }); });
    }, searchDebounceMs);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, connectedFolderIds]);

  const matches = useMemo(() => {
    if (!state.result) return [];
    const result: Array<{
      connectedFolder: ConnectedFolderSummary;
      conversation: ConversationSummary;
      match: ChatContentMatch;
    }> = [];
    for (const connectedFolder of connectedFolders) {
      const summaries = new Map((conversations[connectedFolder.id] ?? []).map((conversation) => [conversation.id, conversation]));
      for (const match of state.result.byConnectedFolder[connectedFolder.id]?.chats ?? []) {
        const conversation = summaries.get(match.conversationId);
        // Search covers every Chat; a snoozed or archived one says so on its row.
        if (!conversation) continue;
        result.push({ connectedFolder, conversation, match });
      }
    }
    return result;
  }, [state.result, connectedFolders, conversations]);

  if (state.status === "idle") return null;
  const visible = matches.slice(0, visibleMatchLimit);
  const truncated = Boolean(state.result?.truncated) || matches.length > visible.length;

  return (
    <section className="chat-content-search" aria-label="Matches in Chat transcripts">
      <h3>
        In Chat Transcripts
        <span aria-live="polite">
          {state.status === "searching"
            ? "Searching"
            : state.status === "error"
              ? "Unavailable"
              : `${matches.length}${truncated ? "+" : ""}`}
        </span>
      </h3>
      {state.status === "error"
        ? <p className="chat-content-search-note">Couldn&rsquo;t search Chat transcripts.</p>
        : visible.length === 0 && state.status === "ready"
          ? <p className="chat-content-search-note">No Chat transcripts match.</p>
          : (
            <ul>
              {visible.map(({ connectedFolder, conversation, match }, index) => (
                <li key={`${connectedFolder.id}:${match.conversationId}:${match.createdAt}:${index}`}>
                  <button type="button" onClick={() => onOpen(connectedFolder, conversation)}>
                    <span className="chat-content-search-title">{conversation.title}</span>
                    <span className="chat-content-search-meta">{[connectedFolder.name, lifecycleLabel(conversationLifecycleView(conversation, now)), chatRoleLabel(match.role)].filter(Boolean).join(" · ")}</span>
                    <span className="chat-content-search-preview">{match.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      {truncated
        ? <p className="chat-content-search-note">Showing the first {visible.length} matches.</p>
        : null}
      {state.result?.failedConnectedFolders
        ? <p className="chat-content-search-note">Some Connected Folders couldn&rsquo;t be searched.</p>
        : null}
    </section>
  );
}

function lifecycleLabel(view: ChatLifecycleView): string | null {
  return view === "snoozed" ? "Snoozed" : view === "archived" ? "Archived" : null;
}

function chatRoleLabel(role: ChatContentMatch["role"]): string {
  return `${role[0].toUpperCase()}${role.slice(1)}`;
}

async function searchChatTranscripts(
  connectedFolders: ConnectedFolderSummary[],
  query: string,
  signal: AbortSignal,
): Promise<ChatSearchResult> {
  const byConnectedFolder: Record<string, ChatSearchResponse> = {};
  let failedConnectedFolders = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(searchConcurrency, connectedFolders.length) }, async () => {
    while (next < connectedFolders.length) {
      const connectedFolder = connectedFolders[next++];
      if (!connectedFolder) continue;
      try {
        const result = await api<ChatSearchResponse>(
          `/api/connected-folders/${connectedFolder.id}/search?scope=chats&q=${encodeURIComponent(query)}`,
          { signal },
        );
        byConnectedFolder[connectedFolder.id] = result;
      } catch (error) {
        if (signal.aborted) throw error;
        failedConnectedFolders += 1;
      }
    }
  }));
  if (connectedFolders.length > 0 && failedConnectedFolders === connectedFolders.length) {
    throw new Error("No Chat transcripts could be searched.");
  }
  return {
    byConnectedFolder,
    truncated: Object.values(byConnectedFolder).some((result) => result.truncated),
    failedConnectedFolders,
  };
}
