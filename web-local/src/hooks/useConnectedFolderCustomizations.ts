import { useEffect, useRef, useState } from "react";

import {
  accentIdentityFromHex,
  normalizeConnectedFolderAppearanceCustomization,
  upgradeConnectedFolderAppearanceCustomization,
  type ConnectedFolderAppearanceState,
} from "../../../src/shared/connected-folder-appearance";
import { api, errorText } from "../lib/api";
import { normalizeConnectedFolderCustomizations } from "../lib/connected-folder-customization";
import type { ConnectedFolderCustomization, ConnectedFolderCustomizationMap, ConnectedFolderCustomizationPatch } from "../types";
import { showToast } from "../ui/feedback";
import { connectedFolderIconOptions } from "../connected-folder-icons";

export const supportedConnectedFolderIconNames = new Set(connectedFolderIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])]));

/**
 * Each Connected Folder's name, colors, icon, and banner as this window shows and
 * saves them: Customize Connected Folder edits them in either layout, with an undo
 * history per Connected Folder, and every change is saved on this computer through
 * the local API (a failed save keeps the change for this session and says so).
 */
export function useConnectedFolderCustomizations({ fixtureCustomizations, appearance, connectedFolderIds }: {
  /** The browser preview's sample appearance, which is never saved. */
  fixtureCustomizations: ConnectedFolderCustomizationMap | null;
  appearance?: ConnectedFolderAppearanceState;
  /** Every registered Connected Folder id, joined; a change renormalizes. */
  connectedFolderIds: string;
}) {
  const fixture = fixtureCustomizations !== null;
  const [customizations, setCustomizations] = useState<ConnectedFolderCustomizationMap>(() => fixtureCustomizations
    ?? normalizeConnectedFolderCustomizations(appearance?.customizations ?? {}, undefined, supportedConnectedFolderIconNames));
  const customizationsRef = useRef(customizations);
  const storageWarningShownRef = useRef(false);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const historyRef = useRef(new Map<string, ConnectedFolderCustomization[]>());
  const [, setHistoryVersion] = useState(0);
  customizationsRef.current = customizations;
  // The host's appearance revision this window last matched, its own queued
  // writes, and the Connected Folders whose last save failed (kept for this
  // session only). A newer host copy is adopted only while nothing is queued,
  // so a look applied by the Worker or the CLI shows here, and Customize
  // edits that look rather than a stale copy.
  const hostRevisionRef = useRef(appearance?.revision ?? 0);
  const pendingWritesRef = useRef(0);
  const unsavedRef = useRef(new Set<string>());
  const latestAppearanceRef = useRef(appearance);
  latestAppearanceRef.current = appearance;

  function setAll(next: ConnectedFolderCustomizationMap) {
    customizationsRef.current = next;
    setCustomizations(next);
  }

  useEffect(() => {
    // A temporarily missing or moved folder is not the same thing as an
    // explicit Connected Folder removal. Keep appearance keyed by the portable Connected Folder id
    // so relinking that folder restores its identity on this computer.
    const next = normalizeConnectedFolderCustomizations(customizationsRef.current, undefined, supportedConnectedFolderIconNames);
    if (JSON.stringify(next) !== JSON.stringify(customizationsRef.current)) setAll(next);
  }, [connectedFolderIds]);

  function adoptHostAppearance(saved: ConnectedFolderAppearanceState | undefined) {
    if (fixture || !saved || pendingWritesRef.current > 0 || saved.revision <= hostRevisionRef.current) return;
    hostRevisionRef.current = saved.revision;
    const merged = { ...saved.customizations } as ConnectedFolderCustomizationMap;
    for (const id of unsavedRef.current) {
      const local = customizationsRef.current[id];
      if (local) merged[id] = local;
      else delete merged[id];
    }
    const next = normalizeConnectedFolderCustomizations(merged, undefined, supportedConnectedFolderIconNames);
    if (JSON.stringify(next) !== JSON.stringify(customizationsRef.current)) setAll(next);
  }

  // A newer saved appearance (a Connected Folder created with a starting
  // color, a look the Worker or the CLI applied) replaces this window's copy.
  useEffect(() => { adoptHostAppearance(appearance); }, [appearance?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  function remember(connectedFolderId: string) {
    const history = historyRef.current.get(connectedFolderId) ?? [];
    history.push(structuredClone(customizationsRef.current[connectedFolderId] ?? {}));
    if (history.length > 20) history.shift();
    historyRef.current.set(connectedFolderId, history);
    setHistoryVersion((current) => current + 1);
  }

  function persist(connectedFolderId: string, customization: ConnectedFolderCustomization | undefined, options: { remember?: boolean } = {}) {
    if (options.remember !== false) remember(connectedFolderId);
    const next = { ...customizationsRef.current };
    if (customization && Object.keys(customization).length) next[connectedFolderId] = customization;
    else delete next[connectedFolderId];
    setAll(next);
    if (fixture) return;
    pendingWritesRef.current++;
    writeQueueRef.current = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = customization && Object.keys(customization).length
          ? await api<{ appearance: ConnectedFolderAppearanceState }>(`/api/connected-folders/${connectedFolderId}/appearance`, { method: "PUT", body: { customization } })
          : await api<{ appearance: ConnectedFolderAppearanceState }>(`/api/connected-folders/${connectedFolderId}/appearance`, { method: "DELETE" });
        unsavedRef.current.delete(connectedFolderId);
        const revision = saved?.appearance?.revision;
        if (typeof revision === "number") hostRevisionRef.current = Math.max(hostRevisionRef.current, revision);
      })
      .catch((caught) => {
        unsavedRef.current.add(connectedFolderId);
        if (storageWarningShownRef.current) return;
        storageWarningShownRef.current = true;
        showToast({ text: `This appearance works for this session, but AmpleFile could not save it on this computer. ${errorText(caught)}`, tone: "info" });
      })
      .finally(() => {
        pendingWritesRef.current--;
        // A newer host copy that arrived while this window was saving.
        if (pendingWritesRef.current === 0) adoptHostAppearance(latestAppearanceRef.current);
      });
  }

  function customize(connectedFolderId: string, patch: ConnectedFolderCustomizationPatch) {
    const current = upgradeConnectedFolderAppearanceCustomization(customizationsRef.current[connectedFolderId] ?? {});
    const merged: ConnectedFolderCustomization = { ...current, ...patch, schema: 2 };
    if (Object.prototype.hasOwnProperty.call(patch, "color")) {
      delete merged.color;
      if (patch.color) merged.primary = accentIdentityFromHex(patch.color);
      else delete merged.primary;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "color2")) {
      delete merged.color2;
      if (patch.color2) merged.secondary = accentIdentityFromHex(patch.color2);
      else delete merged.secondary;
    }
    const normalized = normalizeConnectedFolderCustomizations(
      { [connectedFolderId]: normalizeConnectedFolderAppearanceCustomization(merged) },
      new Set([connectedFolderId]),
      supportedConnectedFolderIconNames,
    )[connectedFolderId];
    persist(connectedFolderId, normalized);
  }

  function replace(connectedFolderId: string, customization: ConnectedFolderCustomization) {
    const normalized = normalizeConnectedFolderCustomizations(
      { [connectedFolderId]: upgradeConnectedFolderAppearanceCustomization(customization) },
      new Set([connectedFolderId]),
      supportedConnectedFolderIconNames,
    )[connectedFolderId];
    persist(connectedFolderId, normalized);
    showToast({ text: "Appearance proposal applied to this Connected Folder.", tone: "success" });
  }

  function undo(connectedFolderId: string) {
    const history = historyRef.current.get(connectedFolderId) ?? [];
    const previous = history.pop();
    historyRef.current.set(connectedFolderId, history);
    setHistoryVersion((current) => current + 1);
    if (!previous) return;
    persist(connectedFolderId, Object.keys(previous).length ? previous : undefined, { remember: false });
    showToast({ text: "Undid the last appearance change.", tone: "success" });
  }

  function reset(connectedFolderId: string) {
    persist(connectedFolderId, undefined);
    showToast({ text: "Connected Folder appearance reset to defaults.", tone: "success" });
  }

  /** A removed Connected Folder's appearance leaves this window (the host deletes its saved copy). */
  function forget(connectedFolderId: string) {
    const next = { ...customizationsRef.current };
    delete next[connectedFolderId];
    setAll(next);
  }

  return {
    customizations,
    customize,
    replace,
    undo,
    reset,
    forget,
    canUndo: (connectedFolderId: string) => (historyRef.current.get(connectedFolderId)?.length ?? 0) > 0,
  };
}
