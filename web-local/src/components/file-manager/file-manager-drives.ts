import { formatBytes } from "../../lib/format";
import { computerPlace, isComputerPlace, type FileManagerLocation, type FileManagerPlace } from "./file-manager-places";

/**
 * Drives in the file manager window (docs/product-model.md, "The file
 * manager window"): the sidebar's Drives section lists the computer's own disk
 * and every mounted drive the host reports. Each opens in the computer place
 * at its mount path, so it follows the Standard Folder rules.
 */

/** One mounted drive, as `GET /api/volumes` reports it (the startup disk is never one). */
export interface VolumeSummary {
  id: string;
  name: string;
  mountPath: string;
  totalBytes: number | null;
  freeBytes: number | null;
  ejectable: boolean;
  fileSystem: string | null;
}

/** Space on the volume holding a folder, from `GET /api/volume-space`. */
export interface VolumeSpace { totalBytes: number | null; freeBytes: number | null }

/** One row of the sidebar's Drives section. */
export interface DriveRow {
  key: string;
  name: string;
  location: FileManagerLocation;
  /** Set for a mounted drive; the computer's own disk has none and is never ejected. */
  volume: VolumeSummary | null;
  ejectable: boolean;
  /** "12.4 GB free of 64 GB", when the host could measure it. */
  detail: string | null;
}

/** The computer place's path for an absolute mount path: the computer place's top is the disk, so it is the path without its leading slash. */
export function driveLocation(mountPath: string): FileManagerLocation {
  return { place: computerPlace, path: mountPath.replace(/^\/+/, "").replace(/\/+$/, "") };
}

/** The computer's own disk first (the top of the file system, one click away), then every mounted drive by name. */
export function driveRows(volumes: readonly VolumeSummary[], diskName: string): DriveRow[] {
  const sorted = [...volumes].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }));
  return [
    { key: "computer", name: diskName, location: { place: computerPlace, path: "" }, volume: null, ejectable: false, detail: null },
    ...sorted.map((volume) => ({
      key: volume.id,
      name: volume.name,
      location: driveLocation(volume.mountPath),
      volume,
      ejectable: volume.ejectable,
      detail: spaceDetail(volume),
    })),
  ];
}

/**
 * The Drives row that holds the location shown: the drive whose mount path is
 * the deepest one containing it, else the computer's disk for anything else in
 * the computer place. Null in a Connected Folder or Standard Folder, which have
 * their own rows.
 */
export function currentDriveKey(rows: readonly DriveRow[], location: FileManagerLocation): string | null {
  if (!isComputerPlace(location.place)) return null;
  let best: DriveRow | null = null;
  for (const row of rows) {
    if (!row.volume) continue;
    const mount = row.location.path;
    if (location.path === mount || location.path.startsWith(`${mount}/`)) {
      if (!best || mount.length > best.location.path.length) best = row;
    }
  }
  if (best) return best.key;
  return location.path === "" ? "computer" : null;
}

/** Whether a location is on a drive (its mount path or below), for leaving it after Eject. */
export function locationIsOnDrive(location: FileManagerLocation, volume: VolumeSummary): boolean {
  if (!isComputerPlace(location.place)) return false;
  const mount = driveLocation(volume.mountPath).path;
  return location.path === mount || location.path.startsWith(`${mount}/`);
}

/** Byte counts as people read a disk's: KB and MB like a file's, then GB and TB. */
export function formatCapacity(bytes: number): string {
  const gib = 1024 ** 3;
  if (bytes < gib) return formatBytes(Math.max(0, Math.round(bytes)));
  const tib = 1024 ** 4;
  if (bytes < tib) return `${trimDecimal(bytes / gib)} GB`;
  return `${trimDecimal(bytes / tib)} TB`;
}

function trimDecimal(value: number): string {
  return (value < 100 ? value.toFixed(1) : value.toFixed(0)).replace(/\.0$/, "");
}

function spaceDetail(volume: VolumeSummary): string | null {
  if (volume.freeBytes === null) return null;
  return volume.totalBytes === null ? `${formatCapacity(volume.freeBytes)} free` : `${formatCapacity(volume.freeBytes)} free of ${formatCapacity(volume.totalBytes)}`;
}

/** The path bar's free space, after the item count: "40.2 GB available". */
export function freeSpaceText(space: VolumeSpace | null): string | null {
  if (!space || space.freeBytes === null) return null;
  return `${formatCapacity(space.freeBytes)} available`;
}

/** The path bar's status line with free space added, as Finder's reads ("12 items, 40.2 GB available"). */
export function statusWithSpace(status: string, space: VolumeSpace | null): string {
  const free = freeSpaceText(space);
  if (!free) return status;
  return status ? `${status}, ${free}` : free;
}

/** The volume-space route's query for a place and a folder inside it. */
export function volumeSpacePath(place: FileManagerPlace, path: string): string {
  const query = new URLSearchParams({ placeKind: place.kind, placeId: place.id, path });
  return `/api/volume-space?${query.toString()}`;
}

/** What the window says after Eject: done, or the host's own plain reason. */
export function ejectMessage(name: string, outcome: { ok: true } | { ok: false; error: string }): { text: string; tone: "success" | "error" } {
  if (outcome.ok) return { text: `“${name}” was ejected. You can disconnect it now.`, tone: "success" };
  return { text: outcome.error || `“${name}” couldn’t be ejected.`, tone: "error" };
}

/** Reads an events-stream frame: the whole list of drives, or null for anything else. */
export function parseVolumesEvent(data: string): VolumeSummary[] | null {
  try {
    const event = JSON.parse(data) as { type?: unknown; volumes?: unknown };
    if (event.type !== "volumes" || !Array.isArray(event.volumes)) return null;
    return event.volumes.filter(isVolumeSummary);
  } catch {
    return null;
  }
}

function isVolumeSummary(value: unknown): value is VolumeSummary {
  if (!value || typeof value !== "object") return false;
  const volume = value as Partial<VolumeSummary>;
  return typeof volume.id === "string" && typeof volume.name === "string" && typeof volume.mountPath === "string" && typeof volume.ejectable === "boolean";
}
