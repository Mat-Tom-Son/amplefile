import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decodeMountField,
  decodeUdevLabel,
  ejectCommands,
  ejectVolume,
  linuxUserVolumes,
  listVolumeRecords,
  listVolumes,
  parseMountInfo,
  setEjectRunnerForTests,
  volumeHolds,
  volumeSpaceForPath,
  type EjectCommand,
  type VolumeRecord,
} from "../src/local/volumes.js";

/**
 * Drives for the file manager window (src/local/volumes.ts): which mounts a
 * person calls drives, from realistic and hostile mount tables, and Eject's
 * tools and refusals.
 */

/** Fedora Workstation: btrfs root and /home subvolumes on one disk, /boot, /boot/efi, the kernel's mounts, and a USB stick. */
const fedora = `46 1 0:38 /root / rw,relatime shared:1 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,subvolid=256,subvol=/root
42 46 0:9 / /dev rw,nosuid shared:2 - devtmpfs devtmpfs rw,seclabel,size=7362312k,mode=755
44 42 0:29 / /dev/shm rw,nosuid,nodev shared:3 - tmpfs tmpfs rw,seclabel
48 46 0:28 / /sys rw,nosuid,nodev,noexec,relatime shared:5 - sysfs sysfs rw,seclabel
50 48 0:32 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:7 - cgroup2 cgroup2 rw,seclabel
55 46 0:27 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw
56 46 0:31 / /run rw,nosuid,nodev shared:14 - tmpfs tmpfs rw,seclabel,mode=755
2 55 0:36 / /proc/sys/fs/binfmt_misc rw,relatime shared:15 - autofs systemd-1 rw,fd=41,direct
62 46 0:55 / /tmp rw,nosuid,nodev shared:158 - tmpfs tmpfs rw,seclabel
61 46 0:38 /home /home rw,relatime shared:163 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,subvolid=257,subvol=/home
71 46 259:2 / /boot rw,relatime shared:168 - ext4 /dev/nvme0n1p2 rw,seclabel
76 71 259:1 / /boot/efi rw,relatime shared:173 - vfat /dev/nvme0n1p1 rw,fmask=0077,dmask=0077
478 46 0:85 / /var/lib/nfs/rpc_pipefs rw,relatime shared:863 - rpc_pipefs sunrpc rw
1354 56 0:106 / /run/user/1000 rw,nosuid,nodev,relatime shared:1274 - tmpfs tmpfs rw,seclabel,mode=700,uid=1000
1390 1354 0:107 / /run/user/1000/gvfs rw,nosuid,nodev,relatime shared:1310 - fuse.gvfsd-fuse gvfsd-fuse rw,user_id=1000
1462 1354 0:109 / /run/user/1000/doc rw,nosuid,nodev,relatime shared:1382 - fuse.portal portal rw,user_id=1000
1500 56 8:17 / /run/media/ana/USB\\040Stick rw,nosuid,nodev,relatime shared:1400 - vfat /dev/sdb1 rw,uid=1000,gid=1000
1501 46 0:38 /root/var/lib/machines /var/lib/machines rw,relatime shared:1 - btrfs /dev/nvme0n1p3 rw,subvol=/root/var/lib/machines
`;

/** Ubuntu: ext4 root, snaps as squashfs loop mounts, a removable drive in /media, fstab drives in /mnt and elsewhere, Docker, a network share. */
const ubuntu = `25 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw,errors=remount-ro
26 25 0:5 / /dev rw,nosuid,relatime shared:2 - devtmpfs udev rw,size=8056832k
27 25 0:24 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=1621472k,mode=755
28 25 8:1 / /boot/efi rw,relatime shared:7 - vfat /dev/sda1 rw,fmask=0077
29 25 7:0 / /snap/core20/2318 ro,nodev,relatime shared:9 - squashfs /dev/loop0 ro,errors=continue
30 25 7:1 / /snap/firefox/4848 ro,nodev,relatime shared:10 - squashfs /dev/loop1 ro,errors=continue
31 25 7:2 / /snap/snapd/21759 ro,nodev,relatime shared:11 - squashfs /dev/loop2 ro,errors=continue
32 25 0:50 / /var/lib/docker/overlay2/abc/merged rw,relatime - overlay overlay rw,lowerdir=/x,upperdir=/y,workdir=/z
33 27 8:33 / /media/ana/Photos\\040\\0402024 rw,nosuid,nodev,relatime shared:300 - exfat /dev/sdc1 rw,uid=1000
34 25 8:49 / /mnt/data rw,relatime shared:301 - ext4 /dev/sdd1 rw
35 25 8:65 / /data rw,relatime shared:302 - xfs /dev/sde1 rw
36 25 0:60 / /mnt/nas rw,relatime shared:303 - cifs //nas.local/share rw,vers=3.1.1
37 25 8:49 /backups /srv/backups rw,relatime shared:304 - ext4 /dev/sdd1 rw
38 25 7:5 / /media/ana/Ubuntu\\04024.04 ro,nosuid,nodev,relatime shared:305 - iso9660 /dev/loop5 ro
39 25 0:61 / /home/ana/Remote rw,nosuid,nodev,relatime shared:306 - fuse.sshfs ana@server: rw,user_id=1000
40 25 0:62 / /home/ana/.cache/doc rw,nosuid,nodev,relatime shared:307 - fuse.portal portal rw
41 25 8:2 /home/ana/bound /home/ana/Bound rw,relatime shared:1 - ext4 /dev/sda2 rw
`;

const context = { home: "/home/ana", user: "ana" };

test("a Fedora mount table shows only the USB stick, not the root disk's subvolumes or the system's mounts", () => {
  const volumes = linuxUserVolumes(parseMountInfo(fedora), context);
  assert.deepEqual(volumes.map((volume) => [volume.name, volume.mount.mountPoint, volume.ejectable]), [
    ["USB Stick", "/run/media/ana/USB Stick", true],
  ]);
});

test("an Ubuntu mount table leaves out snaps, Docker, the EFI partition, bind mounts, and portal mounts", () => {
  const volumes = linuxUserVolumes(parseMountInfo(ubuntu), context);
  assert.deepEqual(volumes.map((volume) => [volume.name, volume.mount.mountPoint, volume.ejectable]), [
    ["data", "/data", false],
    ["data", "/mnt/data", false],
    ["nas", "/mnt/nas", false],
    ["Photos  2024", "/media/ana/Photos  2024", true],
    ["Remote", "/home/ana/Remote", false],
    ["Ubuntu 24.04", "/media/ana/Ubuntu 24.04", true],
  ]);
});

test("a drive's label names it, and a removable disk outside the desktop's folders can be ejected", () => {
  const volumes = linuxUserVolumes(parseMountInfo(ubuntu), {
    ...context,
    labels: new Map([["/dev/sde1", "Archive"]]),
    removable: new Set(["8:49"]),
  });
  assert.equal(volumes.find((volume) => volume.mount.mountPoint === "/data")?.name, "Archive");
  assert.equal(volumes.find((volume) => volume.mount.mountPoint === "/mnt/data")?.ejectable, true);
  assert.equal(decodeUdevLabel("My\\x20Drive"), "My Drive");
  assert.equal(decodeUdevLabel("bad\\x00"), null);
  assert.equal(decodeUdevLabel("\\xff\\xfe"), null);
});

test("mount names are decoded from the kernel's escapes, and hostile lines are skipped", () => {
  assert.equal(decodeMountField("/run/media/ana/My\\040Disk\\011Tab\\134Slash"), "/run/media/ana/My Disk\tTab\\Slash");
  assert.equal(decodeMountField("/media/caf\\303\\251"), "/media/café");
  assert.equal(decodeMountField("/media/bad\\377"), null, "bytes that are not UTF-8");
  assert.equal(decodeMountField("/media/\\777"), null);
  const hostile = [
    "", "garbage", "1 2 3", "x 1 8:1 / /media/a rw - ext4 /dev/sdz1 rw",
    "90 25 8:1 / /media/ana/../../etc rw - ext4 /dev/sdz1 rw",
    "91 25 8:1 / relative/path rw - ext4 /dev/sdz1 rw",
    "92 25 8:1 / /media/ana/nul\\000 rw - ext4 /dev/sdz1 rw",
    "93 25 notmajor / /media/ana/x rw - ext4 /dev/sdz1 rw",
    "94 25 8:1 / /media/ana/nofs rw shared:1",
    `95 25 8:1 / /media/ana/${"x".repeat(20_000)} rw - ext4 /dev/sdz1 rw`,
    "96 25 8:97 / /media/ana/Good rw,relatime shared:9 master:3 - ext4 /dev/sdg1 rw",
  ].join("\n");
  const mounts = parseMountInfo(hostile);
  assert.deepEqual(mounts.map((mount) => mount.mountPoint), ["/media/ana/Good"], "only the well-formed line, with optional fields");
  assert.equal(mounts[0]!.fileSystem, "ext4");
  assert.equal(mounts[0]!.source, "/dev/sdg1");
});

test("a mount point mounted over again shows the newest mount", () => {
  const table = `${ubuntu}50 33 8:81 / /media/ana/Photos\\040\\0402024 rw - ext4 /dev/sdf1 rw\n`;
  const photos = linuxUserVolumes(parseMountInfo(table), context).filter((volume) => volume.mount.mountPoint === "/media/ana/Photos  2024");
  assert.equal(photos.length, 1);
  assert.equal(photos[0]!.mount.source, "/dev/sdf1");
});

test("listed drives carry an opaque id that stays the same, their space, and no device path for the window", async () => {
  const measure = async () => ({ totalBytes: 1_000, freeBytes: 250 });
  const first = await listVolumes({ platform: "linux", mountInfo: ubuntu, home: "/home/ana", user: "ana", measure });
  const again = await listVolumes({ platform: "linux", mountInfo: ubuntu, home: "/home/ana", user: "ana", measure });
  assert.deepEqual(first.map((volume) => volume.id), again.map((volume) => volume.id));
  assert.equal(new Set(first.map((volume) => volume.id)).size, first.length);
  for (const volume of first) {
    assert.match(volume.id, /^volume-[0-9a-f]{20}$/);
    assert.equal(volume.totalBytes, 1_000);
    assert.equal(volume.freeBytes, 250);
    assert.ok(!("device" in volume));
    assert.ok(!volume.id.includes("media"), "the id does not reveal the path");
  }
  const records = await listVolumeRecords({ platform: "linux", mountInfo: ubuntu, home: "/home/ana", user: "ana", measure: async () => null });
  assert.equal(records.find((volume) => volume.mountPath === "/data")?.device, "/dev/sde1");
  assert.equal(records.find((volume) => volume.mountPath === "/data")?.totalBytes, null, "a drive that cannot be measured is still listed");
});

test("macOS lists the entries of /Volumes that are mounted, without links (the startup disk) or hidden entries", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-volumes-mac-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "Backup Drive"));
  await mkdir(join(sandbox, "Camera"));
  await mkdir(join(sandbox, "Not Mounted"));
  await mkdir(join(sandbox, ".hidden"));
  await symlink("/", join(sandbox, "Macintosh HD"));
  const mounted = new Set(["Backup Drive", "Camera", "Macintosh HD", ".hidden"].map((name) => join(sandbox, name)));
  const volumes = await listVolumeRecords({ platform: "darwin", volumesFolder: sandbox, isMounted: (path) => mounted.has(path), measure: async () => null });
  assert.deepEqual(volumes.map((volume) => [volume.name, volume.ejectable]), [["Backup Drive", true], ["Camera", true]]);
  // By default a folder on the same device as /Volumes is not a mount: a sandbox has none.
  assert.deepEqual(await listVolumes({ platform: "darwin", volumesFolder: sandbox, measure: async () => null }), []);
});

test("Eject runs the system's tools without a shell, falling back from eject to unmount", async (t) => {
  t.after(() => setEjectRunnerForTests(null));
  const volume: VolumeRecord = { id: "volume-x", name: "USB Stick", mountPath: "/run/media/ana/USB Stick", totalBytes: null, freeBytes: null, ejectable: true, fileSystem: "vfat", device: "/dev/sdb1" };
  assert.deepEqual(ejectCommands(volume, "linux"), [
    { command: "gio", args: ["mount", "-e", "/run/media/ana/USB Stick"] },
    { command: "gio", args: ["mount", "-u", "/run/media/ana/USB Stick"] },
    { command: "udisksctl", args: ["unmount", "--no-user-interaction", "-b", "/dev/sdb1"] },
  ]);
  assert.deepEqual(ejectCommands({ mountPath: "/mnt/nas", device: "//nas/share" }, "linux").map((command) => command.command), ["gio", "gio"]);
  assert.deepEqual(ejectCommands({ mountPath: "/Volumes/Camera", device: "/Volumes/Camera" }, "darwin"), [
    { command: "diskutil", args: ["eject", "/Volumes/Camera"] },
    { command: "diskutil", args: ["unmount", "/Volumes/Camera"] },
  ]);

  const ran: EjectCommand[] = [];
  setEjectRunnerForTests(async (command) => {
    ran.push(command);
    return command.args[1] === "-e" ? { code: 2, stdout: "", stderr: "gio: file:///run/media/ana/USB%20Stick: Operation not supported" } : { code: 0, stdout: "", stderr: "" };
  });
  await ejectVolume(volume, "linux");
  assert.deepEqual(ran.map((command) => command.args.slice(0, 2)), [["mount", "-e"], ["mount", "-u"]]);

  setEjectRunnerForTests(async () => ({ code: 1, stdout: "", stderr: "Error unmounting /dev/sdb1: target is busy" }));
  await assert.rejects(ejectVolume(volume, "linux"), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 409 && /“USB Stick” is in use/.test(error.message));

  setEjectRunnerForTests(async () => ({ code: null, stdout: "", stderr: "", missing: true }));
  await assert.rejects(ejectVolume(volume, "linux"), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 503 && /neither gio nor udisksctl/.test(error.message));
  await assert.rejects(ejectVolume({ ...volume, mountPath: "/Volumes/Camera" }, "darwin"), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 503 && /diskutil/.test(error.message));

  setEjectRunnerForTests(async () => ({ code: 1, stdout: "", stderr: "Volume Camera on disk4s1 failed to unmount: dissented by PID 312 (Photos)" }));
  await assert.rejects(ejectVolume({ ...volume, name: "Camera", mountPath: "/Volumes/Camera" }, "darwin"), (error: { statusCode?: number }) => error.statusCode === 409);

  setEjectRunnerForTests(async () => ({ code: 4, stdout: "", stderr: "Error: Not authorized" }));
  await assert.rejects(ejectVolume(volume, "linux"), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 500 && /couldn’t be ejected: Error: Not authorized/.test(error.message));
});

test("the space on a volume is measured at the nearest existing folder, and paths are matched to their drive", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-volumes-space-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const space = await volumeSpaceForPath(join(sandbox, "not", "there", "yet"));
  assert.ok(space && space.totalBytes > 0 && space.freeBytes >= 0 && space.freeBytes <= space.totalBytes);
  assert.ok(volumeHolds({ mountPath: "/media/ana/Photos" }, "/media/ana/Photos/2024/a.jpg", "linux"));
  assert.ok(volumeHolds({ mountPath: "/media/ana/Photos" }, "/media/ana/Photos", "linux"));
  assert.ok(!volumeHolds({ mountPath: "/media/ana/Photos" }, "/media/ana/Photos 2", "linux"));
  assert.ok(volumeHolds({ mountPath: "/Volumes/Camera" }, "/volumes/camera/DCIM", "darwin"));
});
