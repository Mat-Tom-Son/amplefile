import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decodeMountField,
  decodeUdevLabel,
  ejectCommands,
  ejectVolume,
  linuxUserVolumes,
  listMacTrashTops,
  listVolumeRecords,
  listVolumes,
  MountCalls,
  parseDfSpace,
  parseMacMounts,
  parseMacMountTable,
  parseMountInfo,
  parsePropertyList,
  physicalDisksFromDiskutilInfo,
  runTool,
  setEjectRunnerForTests,
  setVolumeDiskSourceForTests,
  volumeHolds,
  volumesEjectedWith,
  volumeSpaceForPath,
  type EjectCommand,
  type MountedVolume,
  type ToolCommand,
  type ToolLimits,
  type ToolRunner,
  type VolumeRecord,
  type VolumeSpace,
} from "../src/local/volumes.js";

/**
 * Drives for the file manager window (src/local/volumes.ts): which mounts a
 * person calls drives, from realistic and hostile mount tables; measuring them
 * without letting one that has stopped answering hold the host up; which
 * drives leave together when one is ejected; and Eject's tools and refusals.
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

const fixture = (name: string): Promise<string> => readFile(new URL(`./fixtures/volumes/${name}`, import.meta.url), "utf8");

/**
 * Lines as `mount` prints them, beside the ones in `mount-macos.txt` (taken
 * from a Mac with a two-partition disk image attached): shares, and names that
 * try the parser.
 */
const macExtraMounts = [
  "//ana@nas._smb._tcp.local/Team%20Photos on /Volumes/Team Photos (smbfs, nodev, nosuid, mounted by ana)",
  "nas.local:/export/media on /Volumes/media (nfs, nodev, nosuid, mounted by ana)",
  "/dev/disk6s2 on /Volumes/Backup (2019) (hfs, local, nodev, nosuid, journaled, noowners)",
  "/dev/disk7s1 on /Volumes/Notes on Trips (msdos, local, nodev, nosuid, noowners)",
  "//ana@nas/odd on /Volumes/x on /Volumes/Remote (smbfs, nodev, nosuid, mounted by ana)",
  "/dev/disk3s5 on /Volumes/.timemachine (apfs, local, nobrowse)",
  "/dev/disk8s1 on /Volumes/Outer/Inner (apfs, local)",
  "/dev/disk9s1 on /Volumes/NoOptions",
  "/dev/disk9s2 on /Volumes/EmptyOptions ()",
  "/dev/disk9s3 on /Volumes/Nul\0 (apfs, local)",
  "garbage",
  "",
].join("\n");

const noTools: ToolRunner = async (command) => { throw new Error(`no tool should run: ${command.command}`); };

test("macOS lists the mounts directly inside /Volumes from the mount table, without the startup disk or hidden and nested mounts", async () => {
  const table = `${await fixture("mount-macos.txt")}${macExtraMounts}`;
  const volumes = await listVolumeRecords({ platform: "darwin", mountTable: table, measure: async () => null, run: noTools });
  assert.deepEqual(volumes.map((volume) => [volume.name, volume.mountPath, volume.device, volume.fileSystem, volume.ejectable]), [
    ["AFScratch A", "/Volumes/AFScratch A", "/dev/disk5s1", "apfs", true],
    ["AFScratch B", "/Volumes/AFScratch B", "/dev/disk4s2", "exfat", true],
    ["Backup (2019)", "/Volumes/Backup (2019)", "/dev/disk6s2", "hfs", true],
    ["media", "/Volumes/media", "nas.local:/export/media", "nfs", true],
    ["Notes on Trips", "/Volumes/Notes on Trips", "/dev/disk7s1", "msdos", true],
    ["Remote", "/Volumes/Remote", "//ana@nas/odd on /Volumes/x", "smbfs", true],
    ["Team Photos", "/Volumes/Team Photos", "//ana@nas._smb._tcp.local/Team%20Photos", "smbfs", true],
  ]);
  assert.ok(volumes.every((volume) => /^volume-[0-9a-f]{20}$/.test(volume.id)));
  const again = await listVolumes({ platform: "darwin", mountTable: table, measure: async () => null, run: noTools });
  assert.deepEqual(again.map((volume) => volume.id), volumes.map((volume) => volume.id), "the id stays while the drive stays mounted");
  assert.ok(again.every((volume) => !("device" in volume)));

  // A mount point mounted over again shows the newest mount, and another folder holds its own mounts.
  const over = parseMacMounts("/dev/disk4s1 on /Volumes/Camera (msdos, local)\n/dev/disk5s1 on /Volumes/Camera (exfat, local)\n/dev/disk6s1 on /mnt/drives/Spare (hfs, local)\n");
  assert.deepEqual(over.map((mount) => [mount.device, mount.fileSystem]), [["/dev/disk5s1", "exfat"]]);
  assert.deepEqual(parseMacMounts("/dev/disk6s1 on /mnt/drives/Spare (hfs, local)\n", "/mnt/drives/").map((mount) => mount.mountPoint), ["/mnt/drives/Spare"]);
});

test("macOS reads the mount table with one tool that asks no drive, and says when it cannot", async () => {
  const ran: Array<{ command: ToolCommand; limits: ToolLimits | undefined }> = [];
  const table = await fixture("mount-macos.txt");
  const volumes = await listVolumes({
    platform: "darwin",
    measure: async () => null,
    run: async (command, limits) => { ran.push({ command, limits }); return { code: 0, stdout: table, stderr: "" }; },
  });
  assert.deepEqual(volumes.map((volume) => volume.name), ["AFScratch A", "AFScratch B"]);
  assert.deepEqual(ran.map((entry) => entry.command), [{ command: "/sbin/mount", args: [] }]);
  assert.equal(ran[0]!.limits?.readOnly, true);
  await assert.rejects(
    listVolumes({ platform: "darwin", measure: async () => null, run: async () => ({ code: 1, stdout: "", stderr: "mount: getmntinfo: Operation not permitted" }) }),
    /couldn’t read which drives are connected/,
  );
  await assert.rejects(
    listVolumes({ platform: "darwin", measure: async () => null, run: async () => ({ code: null, stdout: "", stderr: "", missing: true }) }),
    /couldn’t read which drives are connected/,
  );
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

// Measuring ------------------------------------------------------------------

const dfAnswer = (mountPath: string): string => `Filesystem 1024-blocks Used Available Capacity Mounted on\n//ana@nas/x 1000 400 600 40% ${mountPath}\n`;

test("a disk's volume is measured in this process, and a share by df in a process of its own", async () => {
  const table = `${await fixture("mount-macos.txt")}${macExtraMounts}`;
  const asked: string[] = [];
  const ran: Array<{ command: ToolCommand; limits: ToolLimits | undefined }> = [];
  const volumes = await listVolumes({
    platform: "darwin",
    mountTable: table,
    statfs: async (path) => { asked.push(path); return { totalBytes: 2_000, freeBytes: 500 }; },
    run: async (command, limits) => { ran.push({ command, limits }); return { code: 0, stdout: dfAnswer(command.args[1]!), stderr: "" }; },
    mountCalls: new MountCalls({ limitMs: 2_000 }),
  });
  assert.deepEqual(asked, ["/Volumes/AFScratch A", "/Volumes/AFScratch B", "/Volumes/Backup (2019)", "/Volumes/Notes on Trips"]);
  assert.deepEqual(ran.map((entry) => entry.command).sort((left, right) => left.args[1]!.localeCompare(right.args[1]!)), [
    { command: "/bin/df", args: ["-kP", "/Volumes/media"] },
    { command: "/bin/df", args: ["-kP", "/Volumes/Remote"] },
    { command: "/bin/df", args: ["-kP", "/Volumes/Team Photos"] },
  ]);
  for (const entry of ran) assert.deepEqual(entry.limits, { timeoutMs: 2_000, readOnly: true }, "df is killed at the limit and never holds the host open");
  const space = new Map(volumes.map((volume) => [volume.name, [volume.totalBytes, volume.freeBytes]]));
  assert.deepEqual(space.get("AFScratch B"), [2_000, 500]);
  assert.deepEqual(space.get("Team Photos"), [1_024_000, 614_400]);

  // Linux tells a share from a disk by its mount source.
  const linuxAsked: string[] = [];
  const linuxRan: ToolCommand[] = [];
  await listVolumes({
    platform: "linux",
    mountInfo: ubuntu,
    home: "/home/ana",
    user: "ana",
    statfs: async (path) => { linuxAsked.push(path); return null; },
    run: async (command) => { linuxRan.push(command); return { code: 1, stdout: "", stderr: "df: no such file" }; },
    mountCalls: new MountCalls({ limitMs: 2_000 }),
  });
  assert.deepEqual(linuxAsked.sort(), ["/data", "/media/ana/Photos  2024", "/media/ana/Ubuntu 24.04", "/mnt/data"]);
  assert.deepEqual(linuxRan.sort((left, right) => left.args[1]!.localeCompare(right.args[1]!)), [
    { command: "df", args: ["-kP", "/home/ana/Remote"] },
    { command: "df", args: ["-kP", "/mnt/nas"] },
  ]);
});

test("a drive that never answers is listed without its space and is not asked again until it has answered", async () => {
  const calls = new MountCalls({ limitMs: 300 });
  const asked: string[] = [];
  let answer: ((space: VolumeSpace | null) => void) | null = null;
  // The stat of one drive never returns, as on a disk that has stopped answering.
  const statfs = (path: string): Promise<VolumeSpace | null> => {
    asked.push(path);
    if (path !== "/Volumes/AFScratch A") return Promise.resolve({ totalBytes: 2_000, freeBytes: 500 });
    return new Promise((done) => { answer = done; });
  };
  const mountTable = await fixture("mount-macos.txt");
  const list = async () => new Map((await listVolumes({ platform: "darwin", mountTable, statfs, run: noTools, mountCalls: calls })).map((volume) => [volume.name, volume]));

  const began = Date.now();
  const first = await list();
  assert.ok(Date.now() - began >= 250, "the first listing waits out the limit once");
  assert.equal(first.size, 2, "the drive is still listed");
  assert.equal(first.get("AFScratch A")!.totalBytes, null);
  assert.equal(first.get("AFScratch A")!.freeBytes, null);
  assert.equal(first.get("AFScratch B")!.totalBytes, 2_000, "a healthy drive is measured as usual");

  // However often the list is read, the stalled drive holds one call, and the list does not wait for it again.
  const later = Date.now();
  for (let round = 0; round < 5; round += 1) {
    const again = await list();
    assert.equal(again.get("AFScratch A")!.totalBytes, null);
    assert.equal(again.get("AFScratch B")!.totalBytes, 2_000);
  }
  // Five listings that each waited would take a second and a half.
  assert.ok(Date.now() - later < 1_000, "later listings do not wait for the stalled drive");
  assert.equal(asked.filter((path) => path === "/Volumes/AFScratch A").length, 1, "no second call is started on it");

  // The call returns at last: the next listing asks again.
  answer!(null);
  await new Promise((done) => setImmediate(done));
  const statfsNow = async (path: string) => { asked.push(path); return { totalBytes: 9_000, freeBytes: 1_000 }; };
  const recovered = await listVolumes({ platform: "darwin", mountTable, statfs: statfsNow, run: noTools, mountCalls: calls });
  assert.equal(recovered.find((volume) => volume.name === "AFScratch A")!.totalBytes, 9_000);
  assert.equal(asked.filter((path) => path === "/Volumes/AFScratch A").length, 2);
});

test("the list never has more than two file calls out, so drives that do not answer cannot take the host's file threads", async () => {
  const calls = new MountCalls({ limitMs: 60 });
  const table = ["One", "Two", "Three", "Four"].map((name, index) => `/dev/disk${index + 4}s1 on /Volumes/${name} (exfat, local, nodev, nosuid)`).join("\n");
  const asked: string[] = [];
  const answers = new Map<string, (space: VolumeSpace | null) => void>();
  const healthy = new Set<string>();
  const statfs = (path: string): Promise<VolumeSpace | null> => {
    asked.push(path);
    if (healthy.has(path)) return Promise.resolve({ totalBytes: 4_000, freeBytes: 1_000 });
    return new Promise((done) => { answers.set(path, done); });
  };
  const list = async () => new Map((await listVolumes({ platform: "darwin", mountTable: table, statfs, run: noTools, mountCalls: calls })).map((volume) => [volume.name, volume.totalBytes]));

  // In name order: Four and One stall, and nothing more is started.
  assert.deepEqual([...await list()], [["Four", null], ["One", null], ["Three", null], ["Two", null]]);
  assert.deepEqual(asked, ["/Volumes/Four", "/Volumes/One"]);
  healthy.add("/Volumes/Three").add("/Volumes/Two");
  assert.deepEqual([...await list()], [["Four", null], ["One", null], ["Three", null], ["Two", null]], "even a healthy drive waits while two calls are out");
  assert.deepEqual(asked, ["/Volumes/Four", "/Volumes/One"]);

  // One returns: there is room for the others again.
  answers.get("/Volumes/One")!(null);
  await new Promise((done) => setImmediate(done));
  healthy.add("/Volumes/One");
  assert.deepEqual([...await list()], [["Four", null], ["One", 4_000], ["Three", 4_000], ["Two", 4_000]]);
  assert.deepEqual(asked, ["/Volumes/Four", "/Volumes/One", "/Volumes/One", "/Volumes/Three", "/Volumes/Two"]);
});

test("a share that never answers costs one df at a time, and none while that one has not gone", async () => {
  const calls = new MountCalls({ limitMs: 80 });
  const table = `${await fixture("mount-macos.txt")}//ana@nas/photos on /Volumes/Photos (smbfs, nodev, nosuid, mounted by ana)\n`;
  const ran: ToolCommand[] = [];
  const asked: string[] = [];
  let gone: ((result: { code: number | null; stdout: string; stderr: string }) => void) | null = null;
  // df waits on the dead share. Killed at the limit, it has still not gone: the kernel holds it.
  const run: ToolRunner = (command) => { ran.push(command); return new Promise((done) => { gone = done; }); };
  const statfs = async (path: string) => { asked.push(path); return { totalBytes: 2_000, freeBytes: 500 }; };
  const list = async () => new Map((await listVolumes({ platform: "darwin", mountTable: table, statfs, run, mountCalls: calls })).map((volume) => [volume.name, volume.totalBytes]));

  assert.deepEqual([...await list()], [["AFScratch A", 2_000], ["AFScratch B", 2_000], ["Photos", null]]);
  for (let round = 0; round < 4; round += 1) assert.equal((await list()).get("Photos"), null);
  assert.deepEqual(ran, [{ command: "/bin/df", args: ["-kP", "/Volumes/Photos"] }], "one df, however often the list is read");
  assert.ok(!asked.includes("/Volumes/Photos"), "a share is never asked from this process");

  // The process has gone at last; the next listing may ask again, and this time the share answers.
  gone!({ code: null, stdout: "", stderr: "" });
  await new Promise((done) => setImmediate(done));
  const answering: ToolRunner = async (command) => { ran.push(command); return { code: 0, stdout: dfAnswer(command.args[1]!), stderr: "" }; };
  const recovered = await listVolumes({ platform: "darwin", mountTable: table, statfs, run: answering, mountCalls: calls });
  assert.equal(recovered.find((volume) => volume.name === "Photos")!.totalBytes, 1_024_000);
  assert.equal(ran.length, 2);
});

test("listings that overlap share one call to each drive", async () => {
  const calls = new MountCalls({ limitMs: 2_000 });
  const table = await fixture("mount-macos.txt");
  const waiting: Array<(space: VolumeSpace | null) => void> = [];
  const asked: string[] = [];
  const statfs = (path: string): Promise<VolumeSpace | null> => { asked.push(path); return new Promise((done) => { waiting.push(done); }); };
  const options = { platform: "darwin" as const, mountTable: table, statfs, run: noTools, mountCalls: calls };
  const both = Promise.all([listVolumes(options), listVolumes(options), listVolumes(options)]);
  // Each drive in turn answers for all three.
  for (let answered = 0; answered < 2; answered += 1) {
    while (waiting.length <= answered) await new Promise((done) => setImmediate(done));
    waiting[answered]!({ totalBytes: 7_000, freeBytes: 70 });
  }
  for (const volumes of await both) assert.deepEqual(volumes.map((volume) => volume.freeBytes), [70, 70]);
  assert.deepEqual(asked, ["/Volumes/AFScratch A", "/Volumes/AFScratch B"]);
});

test("df's answer is read from the end, past names that hold spaces", async () => {
  // As macOS and GNU df print it.
  assert.deepEqual(parseDfSpace("Filesystem   1024-blocks Used Available Capacity  Mounted on\n/dev/disk4s2      202436   40    202396     1%    /Volumes/AFScratch B\n", "/Volumes/AFScratch B"), { totalBytes: 202_436 * 1024, freeBytes: 202_396 * 1024 });
  assert.deepEqual(parseDfSpace("Filesystem     1024-blocks      Used Available Capacity Mounted on\n//nas.local/share   976762584 512000000 464762584      53% /mnt/nas\n", "/mnt/nas"), { totalBytes: 976_762_584 * 1024, freeBytes: 464_762_584 * 1024 });
  assert.deepEqual(parseDfSpace("Filesystem 1024-blocks Used Available Capacity Mounted on\nnas:/export/My 2024 Files 100 40 60 40% /Volumes/My 2024 Files\n", "/Volumes/My 2024 Files"), { totalBytes: 102_400, freeBytes: 61_440 });
  assert.deepEqual(parseDfSpace("Filesystem 1024-blocks Used Available Capacity Mounted on\nremote: 0 0 0 - /home/ana/Remote\n", "/home/ana/Remote"), { totalBytes: 0, freeBytes: 0 });
  assert.deepEqual(parseDfSpace("Filesystem 1024-blocks Used Available Capacity Mounted on\n//nas/over 100 140 -40 140% /mnt/over\n", "/mnt/over"), { totalBytes: 102_400, freeBytes: 0 });
  for (const output of ["", "Filesystem 1024-blocks Used Available Capacity Mounted on\n", "df: /Volumes/Gone: No such file or directory\n", "//nas/x lots 40 60 40% /mnt/x\n", "//nas/x 100 40 60 40% relative\n"]) {
    assert.equal(parseDfSpace(output, "/mnt/x"), null, JSON.stringify(output));
  }
  // This computer's own df.
  const real = await runTool({ command: process.platform === "darwin" ? "/bin/df" : "df", args: ["-kP", "/"] }, { timeoutMs: 20_000, readOnly: true });
  assert.equal(real.code, 0, real.stderr);
  const space = parseDfSpace(real.stdout, "/");
  assert.ok(space && space.totalBytes > 0 && space.freeBytes <= space.totalBytes, real.stdout);
});

test("a tool runs without a shell, is stopped at its time limit, and a missing one says so", async () => {
  const began = Date.now();
  const slow = await runTool({ command: "sleep", args: ["30"] }, { timeoutMs: 100, readOnly: true });
  assert.equal(slow.code, null, "killed, not finished");
  assert.ok(Date.now() - began < 15_000);
  const missing = await runTool({ command: "amplefile-no-such-tool", args: [] });
  assert.equal(missing.missing, true);
  // No shell: an argument is one word, whatever it holds.
  const echoed = await runTool({ command: "echo", args: ["$(id) ; café — “quoted”"] });
  assert.equal(echoed.stdout, "$(id) ; café — “quoted”\n");
  const bounded = await runTool({ command: "echo", args: ["x".repeat(4_000)] }, { maxOutput: 100 });
  assert.equal(bounded.stdout.length, 100);
  if (process.platform === "darwin") {
    // This Mac's own mount table: the data volume is a mount directly inside /System/Volumes.
    const table = await runTool({ command: "/sbin/mount", args: [] }, { timeoutMs: 20_000, maxOutput: 1024 * 1024, readOnly: true });
    assert.equal(table.code, 0, table.stderr);
    assert.ok(parseMacMounts(table.stdout, "/System/Volumes").some((mount) => mount.mountPoint === "/System/Volumes/Data" && mount.fileSystem === "apfs" && mount.device.startsWith("/dev/disk")), table.stdout);
  }
});

// Which drives leave together -------------------------------------------------

test("diskutil's answer names the physical disks under a volume: an APFS volume's are its container's stores'", async () => {
  // Taken from a disk image with an APFS container on one partition and an exFAT volume on the other.
  const apfs = await fixture("diskutil-info-apfs-volume.plist");
  const exfat = await fixture("diskutil-info-exfat-partition.plist");
  const notFound = await fixture("diskutil-info-not-found.plist");
  const info = parsePropertyList(apfs);
  assert.ok(info instanceof Map);
  assert.equal(info.get("VolumeName"), "AFScratch A");
  assert.equal(info.get("ParentWholeDisk"), "disk5", "an APFS volume's own whole disk is its container");
  assert.equal(info.get("Ejectable"), true);
  assert.equal(info.get("WholeDisk"), false);
  assert.equal(info.get("Size"), 209_715_200);
  assert.equal(info.get("MediaName"), "");
  assert.deepEqual(info.get("SMARTDeviceSpecificKeysMayVaryNotGuaranteed"), new Map());
  assert.deepEqual(info.get("APFSPhysicalStores"), [new Map([["APFSPhysicalStore", "disk4s1"]])]);

  assert.deepEqual(physicalDisksFromDiskutilInfo(apfs), ["disk4"], "the disk its container is stored on, not the container");
  assert.deepEqual(physicalDisksFromDiskutilInfo(exfat), ["disk4"]);
  assert.deepEqual(physicalDisksFromDiskutilInfo(notFound), [], "diskutil's own error: it knows no disk there");
  // A Fusion Drive's container has a store on each of two disks.
  const fusion = apfs.replace("<string>disk4s1</string>\n\t\t</dict>", "<string>disk0s2</string>\n\t\t</dict>\n\t\t<dict>\n\t\t\t<key>APFSPhysicalStore</key>\n\t\t\t<string>disk1s2</string>\n\t\t</dict>");
  assert.notEqual(fusion, apfs);
  assert.deepEqual(physicalDisksFromDiskutilInfo(fusion), ["disk0", "disk1"]);
  assert.equal(physicalDisksFromDiskutilInfo(apfs.replace("<string>disk4s1</string>", "<string>../../etc</string>")), null, "a store that is not a disk");
  assert.equal(physicalDisksFromDiskutilInfo(exfat.replace("<string>disk4</string>", "<string>not a disk</string>")), null);

  // A whole disk with no partitions is its own disk, and an answer that names no disk at all does not say.
  assert.deepEqual(physicalDisksFromDiskutilInfo("<plist><dict><key>DeviceIdentifier</key><string>disk7</string><key>WholeDisk</key><true/></dict></plist>"), ["disk7"]);
  assert.equal(physicalDisksFromDiskutilInfo("<plist><dict><key>MountPoint</key><string>/Volumes/Odd</string></dict></plist>"), null);
  assert.equal(physicalDisksFromDiskutilInfo("<plist><dict><key>APFSPhysicalStores</key><string>disk4s1</string></dict></plist>"), null);

  // Untrusted text, read strictly: only one whole property list is an answer.
  const strict = [
    "", "not a plist", apfs.slice(0, 900),
    "<plist><dict><key>a</key></dict></plist>",
    "<plist><array><key>a</key></array></plist>",
    `<plist>${"<array>".repeat(64)}${"</array>".repeat(64)}</plist>`,
    `<plist><string>${"x".repeat(1024 * 1024)}</string></plist>`,
    "<plist><dict><key>a</key><string>b</string></dict>",
    "<plist><dict><key>a</key><string>b</string></dict></plist> trailing",
    "<plist><dict>stray<key>a</key><string>b</string></dict></plist>",
    "<plist><dict><key>a</key><unknown/></dict></plist>",
    "<plist><dict><key>a</key><string>b</string></dict><dict/></plist>",
    "<plist><true></true></plist>",
    "<plist/>",
  ];
  for (const text of strict) assert.equal(parsePropertyList(text), null, text.slice(0, 60));
  assert.equal(parsePropertyList("<?xml version=\"1.0\"?>\n<!DOCTYPE plist>\n<plist version=\"1.0\">\n<true/>\n</plist>\n"), true);
  const odd = parsePropertyList("<plist version=\"1.0\"><dict><key>__proto__</key><string>a &amp; b &lt;c&gt; &#233;&#x1F4BE;</string><key>n</key><real>1.5</real><key>list</key><array/></dict></plist>");
  assert.ok(odd instanceof Map);
  assert.equal(odd.get("__proto__"), "a & b <c> é💾");
  assert.equal(odd.get("n"), 1.5);
  assert.deepEqual(odd.get("list"), []);
});

function record(name: string, device: string, fileSystem: string | null = null): VolumeRecord {
  return { id: `volume-${name.toLowerCase().replace(/\W+/g, "-")}`, name, mountPath: `/Volumes/${name}`, totalBytes: null, freeBytes: null, ejectable: true, fileSystem, device };
}

test("ejecting a volume takes every mount of its physical disk, listed as a drive or not, and one the system can't place counts too", async (t) => {
  t.after(() => { setEjectRunnerForTests(null); setVolumeDiskSourceForTests(null); });
  const apfs = await fixture("diskutil-info-apfs-volume.plist");
  const exfat = await fixture("diskutil-info-exfat-partition.plist");
  const notFound = await fixture("diskutil-info-not-found.plist");
  // The fixture's two volumes, then mounts of the same disk the drives list never shows, another disk, and what is on no disk.
  const table = `${await fixture("mount-macos.txt")}${[
    "/dev/disk6s1 on /Volumes/Archive (hfs, local, nodev, nosuid, journaled, noowners)",
    "/dev/disk4s3 on /Users/ana/mnt/Spare (hfs, local, nodev, nosuid, journaled)",
    "/dev/disk4s4 on /Volumes/.hidden (hfs, local, nodev, nosuid, journaled)",
    "/dev/disk4s5 on /Volumes/AFScratch B/inner (msdos, local, nodev, nosuid)",
    "ntfs://disk4s6/Win on /Volumes/Win (ufsd_NTFS, local, nodev, nosuid, noowners)",
    "//ana@nas/Team%20Photos on /Volumes/Team Photos (smbfs, nodev, nosuid, mounted by ana)",
    "ana@server:/srv on /Users/ana/Remote (macfuse, nodev, nosuid, synchronous, mounted by ana)",
  ].join("\n")}\n`;
  const a = record("AFScratch A", "/dev/disk5s1", "apfs");
  const b = record("AFScratch B", "/dev/disk4s2", "exfat");
  const archive = record("Archive", "/dev/disk6s1", "hfs");
  const share = record("Team Photos", "//ana@nas/Team%20Photos", "smbfs");
  const onDisk4 = ["/Volumes/AFScratch B", "/Users/ana/mnt/Spare", "/Volumes/.hidden", "/Volumes/AFScratch B/inner", "/Volumes/Win"];
  const answers = new Map<string, string>([[a.mountPath, apfs], [archive.mountPath, exfat.replaceAll("disk4", "disk6")], ...onDisk4.map((path): [string, string] => [path, exfat])]);
  const silent = new Set<string>();
  const ran: Array<{ command: ToolCommand; limits: ToolLimits | undefined }> = [];
  let mounted = table;
  setEjectRunnerForTests(async (command, limits) => {
    ran.push({ command, limits });
    if (command.command === "/sbin/mount") return { code: 0, stdout: mounted, stderr: "" };
    const path = command.args[2]!;
    if (silent.has(path)) return { code: 1, stdout: "", stderr: "diskutil: timed out" };
    const plist = answers.get(path);
    return plist ? { code: 0, stdout: plist, stderr: "" } : { code: 1, stdout: notFound, stderr: "" };
  });
  const names = async (volume: MountedVolume) => (await volumesEjectedWith(volume, "darwin")).map((companion) => [companion.volume.mountPath, companion.certain]);
  const asked = () => ran.filter((entry) => entry.command.command === "diskutil").map((entry) => entry.command.args[2]);

  // The APFS volume's container is stored on a partition of the disk the others are on, wherever they are mounted.
  assert.deepEqual(await names(a), onDisk4.map((path) => [path, true]));
  assert.deepEqual(ran[0]!.command, { command: "/sbin/mount", args: [] });
  assert.deepEqual(asked(), [a.mountPath, "/Volumes/AFScratch B", archive.mountPath, "/Users/ana/mnt/Spare", "/Volumes/.hidden", "/Volumes/AFScratch B/inner", "/Volumes/Win", "/Users/ana/Remote"],
    "every mount but the system's own and the share is asked, whatever its device is called");
  assert.ok(ran.every((entry) => entry.limits?.readOnly === true));
  assert.ok(ran.filter((entry) => entry.command.command === "diskutil").every((entry) => (entry.limits?.maxOutput ?? 0) >= 64 * 1024));
  assert.deepEqual(await names(b), [[a.mountPath, true], ...onDisk4.slice(1).map((path) => [path, true])]);
  assert.deepEqual(await names(archive), [], "a drive alone on its disk");

  // A share is a server's: it leaves alone, and nothing is asked. So does a mount diskutil knows no disk under.
  ran.length = 0;
  assert.deepEqual(await names(share), []);
  assert.deepEqual(ran, [], "no tool ran");
  assert.deepEqual(await names({ name: "Remote", mountPath: "/Users/ana/Remote", device: "ana@server:/srv", fileSystem: "macfuse" }), []);
  assert.deepEqual(asked(), ["/Users/ana/Remote"], "asked about itself only");
  // With nothing else mounted that could be on a disk, the mount table is all that is read.
  ran.length = 0;
  mounted = "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)\n/dev/disk5s1 on /Volumes/AFScratch A (apfs, local)\n//ana@nas/x on /Volumes/x (smbfs, nodev)\n";
  assert.deepEqual(await names(a), []);
  assert.deepEqual(ran.map((entry) => entry.command.command), ["/sbin/mount"]);
  mounted = table;

  // The system can't say which disk one mount is on: that mount counts, uncertainly.
  silent.add(archive.mountPath);
  assert.deepEqual(await names(a), [...onDisk4.slice(0, 1).map((path) => [path, true]), [archive.mountPath, false], ...onDisk4.slice(1).map((path) => [path, true])]);
  // Nor where the ejected volume is: every mount on some disk counts, and one on no disk still does not.
  assert.deepEqual(await names(archive), [[a.mountPath, false], ...onDisk4.map((path) => [path, false])]);
  silent.clear();
  // diskutil is missing, answers nonsense, or cannot be started.
  const everyOther = [["/Volumes/AFScratch B", false], [archive.mountPath, false], ...onDisk4.slice(1).map((path) => [path, false]), ["/Users/ana/Remote", false]];
  for (const broken of [
    async () => ({ code: null, stdout: "", stderr: "", missing: true }),
    async () => ({ code: 0, stdout: "Device Node: /dev/disk4s2", stderr: "" }),
    async () => { throw new Error("spawn failed"); },
  ] as const) {
    setEjectRunnerForTests(async (command, limits) => command.command === "/sbin/mount" ? { code: 0, stdout: table, stderr: "" } : broken());
    assert.deepEqual(await names(a), everyOther);
  }
  // Without the mount table there is no telling what else is mounted: the eject does not go ahead.
  setEjectRunnerForTests(async () => ({ code: 1, stdout: "", stderr: "mount: failed" }));
  await assert.rejects(volumesEjectedWith(a, "darwin"), /couldn’t read which drives are connected/);

  // Linux checks a drive alone.
  setEjectRunnerForTests(async (command) => { throw new Error(`no tool should run: ${command.command}`); });
  assert.deepEqual(await volumesEjectedWith(record("USB Stick", "/dev/sdb1", "vfat"), "linux"), []);
});

test("a disk that won't go says which drives it holds, and says may of one the system couldn't place", async (t) => {
  t.after(() => setEjectRunnerForTests(null));
  const a = record("AFScratch A", "/dev/disk5s1");
  const sure = (...names: string[]) => names.map((name) => ({ name, certain: true }));
  const unsure = (...names: string[]) => names.map((name) => ({ name, certain: false }));
  const ran: EjectCommand[] = [];
  // diskutil's words when a file on the other volume is open: it has unmounted the one asked for by then.
  setEjectRunnerForTests(async (command) => { ran.push(command); return { code: 1, stdout: "", stderr: "Volume failed to eject\n" }; });
  await assert.rejects(ejectVolume(a, "darwin", [...sure("AFScratch B"), ...unsure("Archive")]), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 409 && error.message === "The disk holding “AFScratch A” and “AFScratch B” couldn’t be ejected. Close the files and apps using those drives, then try again.");
  assert.deepEqual(ran, [{ command: "diskutil", args: ["eject", a.mountPath] }], "the unmount that would follow is not tried: the volume is gone already");

  // Its words when a file on the volume asked for is open.
  const dissent = "Unmount of disk5 failed: at least one volume could not be unmounted\nUnmount was dissented by PID 80173 (/usr/bin/tail)\n";
  setEjectRunnerForTests(async () => ({ code: 1, stdout: "", stderr: dissent }));
  await assert.rejects(ejectVolume(a, "darwin", sure("AFScratch B", "C")), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 409 && error.message === "“AFScratch A” or another drive on its disk (“AFScratch B” and “C”) is in use. Close the files and apps using them, then try again.");
  await assert.rejects(ejectVolume(a, "darwin", sure("B", "C", "D", "E", "F")), /\(“B”, “C”, “D”, and 2 more\) is in use/);
  await assert.rejects(ejectVolume(a, "darwin", unsure("Archive")), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 409 && error.message === "“AFScratch A” is in use, or a drive that may be on its disk (“Archive”) is. Close the files and apps using them, then try again.");
  await assert.rejects(ejectVolume(a, "darwin"), /^Error: “AFScratch A” is in use\. Close the files and apps using it, then try again\.$/);

  // Only a drive the system couldn't place beside it: the unmount is still tried, and a disk that won't go is no server error.
  ran.length = 0;
  setEjectRunnerForTests(async (command) => { ran.push(command); return { code: 1, stdout: "", stderr: command.args[0] === "eject" ? "Volume failed to eject\n" : `Unmount failed for ${a.mountPath}\n` }; });
  await assert.rejects(ejectVolume(a, "darwin", unsure("Archive", "Spare")), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 409 && error.message === "The disk holding “AFScratch A” couldn’t be ejected. “Archive” and “Spare” may be on the same disk. Close the files and apps using those drives, then try again.");
  assert.deepEqual(ran.map((command) => command.args[0]), ["eject", "unmount"]);
  await assert.rejects(ejectVolume(a, "darwin"), (error: { statusCode?: number; message: string }) =>
    error.statusCode === 500 && error.message === "“AFScratch A” couldn’t be ejected: Volume failed to eject", "alone, it is what it was");

  // A drive that can't be ejected is unmounted instead, with or without an unplaced drive beside it.
  for (const alongside of [[], unsure("Archive")]) {
    ran.length = 0;
    setEjectRunnerForTests(async (command) => { ran.push(command); return command.args[0] === "eject" ? { code: 1, stdout: "", stderr: "Volume failed to eject\n" } : { code: 0, stdout: "", stderr: "" }; });
    await ejectVolume(a, "darwin", alongside);
    assert.deepEqual(ran.map((command) => command.args[0]), ["eject", "unmount"]);
  }
});

// What the Trash and the guard share ---------------------------------------------

test("the Trash looks for a drive's Trash folder only on disk volumes directly inside /Volumes", async () => {
  const table = `${await fixture("mount-macos.txt")}${macExtraMounts}`;
  assert.deepEqual(await listMacTrashTops({ mountTable: table }), ["/Volumes/AFScratch A", "/Volumes/AFScratch B", "/Volumes/Backup (2019)", "/Volumes/Notes on Trips"], "no share, nothing hidden or nested");
  await assert.rejects(listMacTrashTops({ run: async () => ({ code: 1, stdout: "", stderr: "mount: failed" }) }), /couldn’t read which drives/i);
  // The whole table keeps what the drives list leaves out.
  assert.deepEqual(parseMacMountTable(table).filter((mount) => ["/", "/Volumes/.timemachine", "/Volumes/Outer/Inner", "/System/Volumes/Data/home"].includes(mount.mountPoint)).map((mount) => [mount.mountPoint, mount.device, mount.fileSystem]), [
    ["/", "/dev/disk3s1s1", "apfs"],
    ["/System/Volumes/Data/home", "map auto_home", "autofs"],
    ["/Volumes/.timemachine", "/dev/disk3s5", "apfs"],
    ["/Volumes/Outer/Inner", "/dev/disk8s1", "apfs"],
  ]);
  assert.deepEqual(parseMacMountTable("/dev/disk4s1 on /Volumes/a/../../etc (apfs, local)\n/dev/disk4s1 on relative (apfs, local)\n"), []);
});

test("one call is out on a mount at a time, whoever makes it, and a caller waits only as long as its own limit", async () => {
  const calls = new MountCalls({ limitMs: 2_000 });
  const order: string[] = [];
  let finishFirst: (value: string) => void = () => undefined;
  const first = calls.call("/Volumes/Disk", { kind: "file" }, () => { order.push("first starts"); return new Promise<string>((done) => { finishFirst = done; }); });
  // Another reader of the same drive waits for the first to return, then makes its own call.
  const second = calls.call("/Volumes/Disk", { kind: "file" }, async () => { order.push("second starts"); return "second"; });
  // One with less patience gives up, and leaves the mount open: the first is not yet past its own limit.
  assert.equal(await calls.call("/Volumes/Disk", { kind: "file", limitMs: 30 }, async () => { order.push("impatient starts"); return "never"; }), null);
  assert.deepEqual(order, ["first starts"]);
  finishFirst("first");
  assert.deepEqual(await first, { value: "first" });
  assert.deepEqual(await second, { value: "second" });
  assert.deepEqual(order, ["first starts", "second starts"]);

  // A call that outlives its limit closes the mount: every caller after gets nothing, at once, until it returns.
  let finishStuck: (value: string) => void = () => undefined;
  assert.equal(await calls.call("/Volumes/Disk", { kind: "file", limitMs: 30 }, () => new Promise<string>((done) => { finishStuck = done; })), null);
  const began = Date.now();
  assert.equal(await calls.call("/Volumes/Disk", { kind: "file", limitMs: 5_000 }, async () => "not started"), null);
  assert.equal(await calls.measure("/Volumes/Disk", "file", async () => ({ totalBytes: 1, freeBytes: 1 })), null);
  assert.ok(Date.now() - began < 1_000, "neither waited");
  assert.deepEqual(await calls.call("/Volumes/Other", { kind: "file" }, async () => "another drive is untouched"), { value: "another drive is untouched" });
  finishStuck("late");
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(await calls.call("/Volumes/Disk", { kind: "file" }, async () => "open again"), { value: "open again" });
  // A call that throws is no answer, and does not close the mount.
  assert.equal(await calls.call("/Volumes/Disk", { kind: "file" }, async () => { throw new Error("EIO"); }), null);
  assert.deepEqual(await calls.call("/Volumes/Disk", { kind: "file" }, async () => "still open"), { value: "still open" });
});
