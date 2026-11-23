import { statfs } from "node:fs/promises";

/**
 * The guard that replaces Compress's and Extract's size limits: they refuse
 * to start when the disk lacks room for what they will write, and stop while
 * writing when the disk's free space falls below a reserve, so a large or
 * hostile archive fills a disk no further than that.
 */

/** Free space a Compress or Extract always leaves on the disk. */
export const diskSpaceReserveBytes = 256 * 1024 * 1024;

/** How often, in bytes written, a running Compress or Extract checks the disk again. */
export const diskSpaceCheckEveryBytes = 64 * 1024 * 1024;

type Probe = (path: string) => Promise<number | null>;

const defaultProbe: Probe = async (path) => {
  try {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    // A disk that cannot say how full it is is not refused for it.
    return null;
  }
};

let probe: Probe = defaultProbe;
let reserve = diskSpaceReserveBytes;
let checkEvery = diskSpaceCheckEveryBytes;

/** Tests only: how free space is read, the reserve kept, and how often a running operation checks. */
export function setDiskSpaceProbeForTests(next: Probe | null, nextReserve?: number, nextCheckEvery?: number): void {
  probe = next ?? defaultProbe;
  reserve = nextReserve ?? diskSpaceReserveBytes;
  checkEvery = nextCheckEvery ?? diskSpaceCheckEveryBytes;
}

export async function freeDiskBytes(path: string): Promise<number | null> {
  return probe(path);
}

/**
 * Refuses (507) when `folder`'s disk has less than `bytes` plus the reserve
 * free. `doing` completes "There isn’t enough space on the disk to …".
 */
export async function assertDiskSpace(folder: string, bytes: number, doing: string): Promise<void> {
  const free = await probe(folder);
  if (free === null || free - bytes >= reserve) return;
  throw notEnoughSpace(`There isn’t enough space on the disk to ${doing}${bytes > 0 ? ` (it needs about ${describeBytes(bytes)}; ${describeBytes(Math.max(0, free))} is free)` : ""}.`);
}

/** Checks the disk again every so many bytes written, refusing once less than the reserve is left. */
export function watchDiskSpace(folder: string, doing: string): (bytes: number) => Promise<void> {
  let sinceCheck = 0;
  return async (bytes) => {
    sinceCheck += bytes;
    if (sinceCheck < checkEvery) return;
    sinceCheck = 0;
    const free = await probe(folder);
    if (free !== null && free < reserve) throw notEnoughSpace(`The disk is almost full, so AmpleFile stopped before it could ${doing}.`);
  };
}

export function describeBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function notEnoughSpace(message: string): Error {
  return Object.assign(new Error(message), { status: 507, statusCode: 507 });
}
