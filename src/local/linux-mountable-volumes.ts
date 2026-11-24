import { basename } from "node:path";

export interface MountableVolumeSummary { id: string; name: string }

export interface LinuxMountableVolume {
  name: string;
  device: string;
  disk: string;
  majorMinor: string;
  fileSystem: string;
  uuid: string;
}

export const linuxBlockDevicesCommand = {
  command: "lsblk",
  args: ["--json", "--paths", "--output", "NAME,TYPE,RM,HOTPLUG,TRAN,FSTYPE,LABEL,UUID,MAJ:MIN,MOUNTPOINTS"],
};

const blockPath = /^\/dev\/[A-Za-z0-9._+-]+$/;
const systemMount = /^\/(?:$|(?:boot|efi|usr|var|nix|sysroot)(?:\/|$)|home$)/;
const nonMountable = /^(?:crypto(?:_|$)|bitlocker$|swap$|swsuspend$|bcache$)|_member$/i;

type BlockDevice = Record<string, unknown>;

function devices(value: unknown): BlockDevice[] {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function mountPoints(device: BlockDevice): string[] {
  return Array.isArray(device.mountpoints) ? device.mountpoints.filter((path): path is string => typeof path === "string" && Boolean(path)) : [];
}

function holdsSystem(device: BlockDevice): boolean {
  return mountPoints(device).some((path) => systemMount.test(path)) || devices(device.children).some(holdsSystem);
}

/** A disk with removable media or an external bus, and its mountable filesystems. */
export function parseLinuxMountableVolumes(text: string): LinuxMountableVolume[] {
  let disks: BlockDevice[];
  try { disks = devices(JSON.parse(text)?.blockdevices); } catch { return []; }
  const result: LinuxMountableVolume[] = [];
  for (const disk of disks) {
    if (disk.type !== "disk" || typeof disk.name !== "string" || !blockPath.test(disk.name) || holdsSystem(disk)) continue;
    if (disk.rm !== true && disk.hotplug !== true && disk.tran !== "usb") continue;
    for (const device of [disk, ...devices(disk.children).filter((entry) => entry.type === "part")]) {
      if (typeof device.name !== "string" || !blockPath.test(device.name) || mountPoints(device).length || devices(device.children).length) continue;
      const fileSystem = device.fstype;
      const majorMinor = device["maj:min"];
      if (typeof fileSystem !== "string" || !/^[A-Za-z0-9_.+-]+$/.test(fileSystem) || nonMountable.test(fileSystem)
        || typeof majorMinor !== "string" || !/^\d+:\d+$/.test(majorMinor)) continue;
      const label = typeof device.label === "string" ? device.label.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 128) : "";
      result.push({ device: device.name, disk: disk.name, majorMinor, fileSystem, uuid: typeof device.uuid === "string" ? device.uuid : "", name: label || basename(device.name) });
      if (result.length >= 128) return result;
    }
  }
  return result;
}
