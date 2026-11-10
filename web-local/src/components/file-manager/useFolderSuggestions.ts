import { useEffect, useState } from "react";

import { api } from "../../lib/api";

/** How long a folder must stay shown before its suggestions are asked for. */
export const suggestionsDelayMs = 600;

/** Suggestions already written this session, by Connected Folder and folder; the host keeps them longer. */
const written = new Map<string, string[]>();

/**
 * The suggested messages above the message box, written by the Connected Folder's
 * own model from what is in the folder shown and its recent Chats. Until they
 * arrive, or with no AI connected, or if the call fails, the list is empty and
 * the plain suggestions show instead.
 */
export function useFolderSuggestions(connectedFolderId: string | null, path: string, enabled: boolean): string[] {
  const key = connectedFolderId ? `${connectedFolderId}\0${path}` : "";
  const [suggestions, setSuggestions] = useState<string[]>(() => written.get(key) ?? []);
  useEffect(() => {
    setSuggestions(written.get(key) ?? []);
    if (!enabled || !connectedFolderId || written.has(key)) return;
    // Each request is a model call: wait until the person settles on a folder,
    // and abandon the request when they move on or the suggestions hide.
    const controller = new AbortController();
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    const timer = window.setTimeout(() => {
      void api<{ suggestions: string[] }>(`/api/connected-folders/${encodeURIComponent(connectedFolderId)}/suggestions${query}`, { signal: controller.signal })
        .then((body) => {
          const list = body.suggestions.filter(Boolean).slice(0, 4);
          written.set(key, list);
          if (!controller.signal.aborted) setSuggestions(list);
        })
        .catch(() => undefined);
    }, suggestionsDelayMs);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return suggestions;
}
