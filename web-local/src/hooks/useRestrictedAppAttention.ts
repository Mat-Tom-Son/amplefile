import { useEffect, useState } from "react";

export function restrictedAppAttentionKey(connectedFolderId: string, appId: string, featureInstallationId: string): string {
  return `${connectedFolderId}\u0000${appId}\u0000${featureInstallationId}`;
}

/**
 * Which apps asked for a dot on their rail button, and how many new things
 * they named. The app sets and clears it; the desktop keeps the current set
 * so a reloaded window starts from it.
 */
export function useRestrictedAppAttention(): ReadonlyMap<string, number> {
  const [attention, setAttention] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    const bridge = window.ampleFileDesktop?.restrictedApps;
    if (!bridge?.onAttention) return;
    let disposed = false;
    const apply = (state: { connectedFolderId: string; appId: string; featureInstallationId: string; count: number }) => {
      setAttention((current) => {
        const key = restrictedAppAttentionKey(state.connectedFolderId, state.appId, state.featureInstallationId);
        if ((current.get(key) ?? 0) === state.count) return current;
        const next = new Map(current);
        if (state.count > 0) next.set(key, state.count);
        else next.delete(key);
        return next;
      });
    };
    const stop = bridge.onAttention(apply);
    void bridge.attentionStates?.().then((states) => {
      if (!disposed) for (const state of states) apply(state);
    }).catch(() => undefined);
    return () => { disposed = true; stop(); };
  }, []);
  return attention;
}
