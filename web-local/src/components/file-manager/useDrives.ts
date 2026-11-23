import { useCallback, useEffect, useState } from "react";

import { api, createEventSource, errorText } from "../../lib/api";
import { parseVolumesEvent, volumeSpacePath, type VolumeSpace, type VolumeSummary } from "./file-manager-drives";
import type { FileManagerPlace } from "./file-manager-places";

/**
 * The mounted drives, kept current: the host's list, then its events, each
 * the whole list again, whenever a drive comes or goes. A host without drives
 * (an older local API) leaves the section with the computer's disk alone.
 */
export function useDrives(fixtureMode: boolean): { volumes: VolumeSummary[]; eject: (volume: VolumeSummary) => Promise<{ ok: true } | { ok: false; error: string }> } {
  const [volumes, setVolumes] = useState<VolumeSummary[]>([]);
  useEffect(() => {
    if (fixtureMode) return;
    let cancelled = false;
    void api<{ volumes: VolumeSummary[] }>("/api/volumes")
      .then((result) => { if (!cancelled && Array.isArray(result?.volumes)) setVolumes(result.volumes); })
      .catch(() => undefined);
    let source: ReturnType<typeof createEventSource> | null = null;
    try {
      source = createEventSource("/api/volumes/events");
      source.onmessage = (event) => {
        const next = parseVolumesEvent(event.data);
        if (next && !cancelled) setVolumes(next);
      };
    } catch {
      source = null;
    }
    return () => { cancelled = true; source?.close(); };
  }, [fixtureMode]);
  const eject = useCallback(async (volume: VolumeSummary) => {
    try {
      await api("/api/volumes/eject", { method: "POST", body: { volumeId: volume.id } });
      setVolumes((current) => current.filter((item) => item.id !== volume.id));
      return { ok: true as const };
    } catch (caught) {
      return { ok: false as const, error: errorText(caught) };
    }
  }, []);
  return { volumes, eject };
}

/**
 * Free space on the volume holding the folder shown, for the path bar's
 * status. Asked again when the folder changes or its files do (`refreshKey`),
 * a little after the change settles.
 */
export function useVolumeSpace(place: FileManagerPlace | null, path: string, refreshKey: number, fixtureMode: boolean): VolumeSpace | null {
  const [space, setSpace] = useState<VolumeSpace | null>(null);
  const query = place && !fixtureMode ? volumeSpacePath(place, path) : null;
  useEffect(() => { setSpace(null); }, [query]);
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<VolumeSpace>(query, { signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted && result && typeof result === "object") setSpace({ totalBytes: result.totalBytes ?? null, freeBytes: result.freeBytes ?? null }); })
        .catch(() => { if (!controller.signal.aborted) setSpace(null); });
    }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, refreshKey]);
  return space;
}
