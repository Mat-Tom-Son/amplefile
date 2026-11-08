import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../lib/api";
import { chatActivityKey } from "../../lib/chat-lifecycle";
import { subscribeControlEvents } from "../../lib/control-events";
import { folderActivityStatuses, useChatActivity } from "../../hooks/useChatActivity";
import type { ChatActivityStatus, ConversationSummary, ConnectedFolderSummary } from "../../types";

/**
 * The file manager's activity dots, as the design draws them: a pulsing dot
 * on a Connected Folder while its Worker is running, and a green one when a Chat
 * has a reply nobody has read, from the host report and saved "new reply"
 * marks useChatActivity reads; a Chat open in the panel counts as read.
 */
export function useFileManagerActivity(connectedFolders: readonly ConnectedFolderSummary[], fixtureMode: boolean, watchedKey: string | null) {
  const activity = useChatActivity(fixtureMode);
  const [conversations, setConversations] = useState<Record<string, ConversationSummary[]>>({});
  const watchedRef = useRef<string | null>(watchedKey);
  watchedRef.current = watchedKey;
  const connectedFolderIds = connectedFolders.map((item) => item.id).join("|");

  const loadConversations = useCallback((connectedFolderId: string) => {
    void api<{ conversations: ConversationSummary[] }>(`/api/connected-folders/${encodeURIComponent(connectedFolderId)}/conversations`)
      .then(({ conversations: list }) => setConversations((current) => ({ ...current, [connectedFolderId]: list })))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (fixtureMode) return;
    for (const connectedFolder of connectedFolders) loadConversations(connectedFolder.id);
  }, [fixtureMode, loadConversations, connectedFolderIds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fixtureMode) return;
    let disposed = false;
    let timer: number | null = null;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void api<{ running: Array<{ connectedFolderId: string; conversationId: string }> }>("/api/connected-folders/activity").then(({ running }) => {
        if (disposed || request !== generation) return;
        const finished = activity.syncBackgroundRunning(
          new Set(running.map((item) => chatActivityKey(item.connectedFolderId, item.conversationId))),
          (key) => key === watchedRef.current,
        );
        const changed = new Set([...running.map((item) => item.connectedFolderId), ...finished.map((key) => key.slice(0, key.indexOf(":")))]);
        for (const connectedFolderId of changed) if (connectedFolderId) loadConversations(connectedFolderId);
      }).catch(() => undefined);
    };
    refresh();
    const unsubscribe = subscribeControlEvents((hint) => {
      if (hint !== "activity" && hint !== "reset") return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; refresh(); }, 120);
    });
    return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); unsubscribe(); };
  }, [activity.syncBackgroundRunning, fixtureMode, loadConversations]);

  // A Chat open in the panel has been read.
  useEffect(() => {
    if (watchedKey) activity.setAttention(watchedKey, false);
  }, [activity.setAttention, watchedKey]);

  const folderStatuses = useMemo(() => folderActivityStatuses(activity.statuses, conversations), [activity.statuses, conversations]);
  return {
    /** By Connected Folder id: running, or a reply waiting. */
    folderStatuses: folderStatuses as Readonly<Record<string, ChatActivityStatus>>,
    /** By chatActivityKey(Connected Folder, conversation). */
    chatStatuses: activity.statuses,
    setRunning: activity.setRunning,
    setAttention: activity.setAttention,
  };
}
