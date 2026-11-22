import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startLocalApi } from "../src/local/server.js";
import { setTrashOptionsForTests } from "../src/local/system-trash.js";
import { setEjectRunnerForTests, setVolumeSourceForTests, type EjectCommand, type VolumeRecord } from "../src/local/volumes.js";

/**
 * The local API's drives and system Trash routes
 * (src/local/api/volume-trash-routes.ts): listing and change events, the
 * space on a place's volume, Eject and its refusals, and Put Back, including
 * into a Connected Folder, where History records it.
 */

type Api = Awaited<ReturnType<typeof startLocalApi>>;
type Call = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; body: Record<string, any> | null }>;

const uid = typeof process.getuid === "function" ? process.getuid() : 1000;

async function sandboxApi(t: test.TestContext): Promise<{ api: Api; call: Call; sandbox: string; home: string; trash: string }> {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-volume-trash-api-"));
  const home = join(sandbox, "home");
  const trash = join(home, ".local", "share", "Trash");
  await mkdir(join(trash, "files"), { recursive: true });
  await mkdir(join(trash, "info"), { recursive: true });
  setTrashOptionsForTests({ platform: "linux", home, xdgDataHome: join(home, ".local", "share"), uid, volumeTops: [] });
  const api = await startLocalApi({ port: 0, stateBase: join(sandbox, "state"), connectedFolderBase: join(sandbox, "content"), loadEnv: false });
  t.after(async () => {
    setTrashOptionsForTests(null);
    setVolumeSourceForTests(null);
    setEjectRunnerForTests(null);
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const call: Call = async (path, init = {}) => {
    const response = await fetch(`${api.origin}${path}`, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
  };
  return { api, call, sandbox, home, trash };
}

function volume(overrides: Partial<VolumeRecord> & Pick<VolumeRecord, "mountPath">): VolumeRecord {
  return { id: "volume-00000000000000000001", name: "USB Stick", totalBytes: 64_000, freeBytes: 32_000, ejectable: true, fileSystem: "vfat", device: "/dev/sdb1", ...overrides };
}

async function trashFile(trash: string, trashName: string, originalPath: string, content = "content"): Promise<void> {
  await writeFile(join(trash, "files", trashName), content);
  await writeFile(join(trash, "info", `${trashName}.trashinfo`), `[Trash Info]\nPath=${originalPath.split("/").map(encodeURIComponent).join("/")}\nDeletionDate=2026-11-20T09:15:30\n`);
}

/** Reads one SSE stream until `until` is satisfied, running `step` after each event. */
async function readEvents(api: Api, path: string, until: (events: any[]) => boolean, step: (events: any[]) => Promise<void>): Promise<any[]> {
  const controller = new AbortController();
  const response = await fetch(`${api.origin}${path}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: any[] = [];
  let buffered = "";
  try {
    while (!until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
        const data = buffered.slice(0, end).split("\n").find((line) => line.startsWith("data: "));
        buffered = buffered.slice(end + 2);
        if (data) { events.push(JSON.parse(data.slice(6))); await step(events); }
      }
    }
  } finally {
    controller.abort();
  }
  return events;
}

test("the drives list leaves out the device, and its events send the list again when a drive goes", async (t) => {
  const { api, call, sandbox } = await sandboxApi(t);
  let drives: VolumeRecord[] = [volume({ mountPath: join(sandbox, "usb") })];
  setVolumeSourceForTests(async () => drives);
  // The eject finishes and the drive is gone.
  setEjectRunnerForTests(async () => { drives = []; return { code: 0, stdout: "", stderr: "" }; });
  const listed = await call("/api/volumes");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { volumes: [{ id: "volume-00000000000000000001", name: "USB Stick", mountPath: join(sandbox, "usb"), totalBytes: 64_000, freeBytes: 32_000, ejectable: true, fileSystem: "vfat" }] });

  const events = await readEvents(api, "/api/volumes/events", (seen) => seen.length >= 2, async (seen) => {
    if (seen.length !== 1) return;
    // Listeners hear the new list without waiting for the system's notice.
    const ejected = await call("/api/volumes/eject", { method: "POST", body: { volumeId: "volume-00000000000000000001" } });
    assert.equal(ejected.status, 200, JSON.stringify(ejected.body));
  });
  assert.equal(events[0].type, "volumes");
  assert.equal(events[0].volumes.length, 1);
  assert.deepEqual(events[1], { type: "volumes", volumes: [] });
});

test("the window's one event connection can subscribe to the drives list", async (t) => {
  const { api, sandbox } = await sandboxApi(t);
  setVolumeSourceForTests(async () => [volume({ mountPath: join(sandbox, "usb") })]);
  const controller = new AbortController();
  const response = await fetch(`${api.origin}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscriptions: [{ id: "drives", path: "/api/volumes/events" }] }),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let text = "";
  try {
    while (!text.includes("\"type\":\"volumes\"")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  } finally { controller.abort(); }
  assert.match(text, /"subscriptionId":"drives","event":\{"type":"volumes","volumes":\[\{"id":"volume-00000000000000000001"/);
});

test("the space on the volume holding a place's folder", async (t) => {
  const { call, sandbox } = await sandboxApi(t);
  const relative = sandbox.split("/").filter(Boolean).join("/");
  const space = await call(`/api/volume-space?placeKind=standard&placeId=computer&path=${encodeURIComponent(relative)}`);
  assert.equal(space.status, 200, JSON.stringify(space.body));
  assert.ok(space.body!.totalBytes > 0 && space.body!.freeBytes >= 0);
  assert.deepEqual(Object.keys(space.body!).sort(), ["freeBytes", "totalBytes"]);
  const top = await call("/api/volume-space?placeKind=standard&placeId=computer&path=");
  assert.equal(top.status, 200, "the disk's own top");
  assert.equal((await call("/api/volume-space?placeKind=somewhere&placeId=x")).status, 400);
  assert.equal((await call(`/api/volume-space?placeKind=standard&placeId=computer&path=${encodeURIComponent("../etc")}`)).status, 400);
});

test("Eject refuses a drive that isn't listed or can't be ejected, and one holding a Connected Folder with unfinished work", async (t) => {
  const { api, call, sandbox } = await sandboxApi(t);
  const ran: EjectCommand[] = [];
  setEjectRunnerForTests(async (command) => { ran.push(command); return { code: 0, stdout: "", stderr: "" }; });
  const created = await call("/api/connected-folders", { method: "POST", body: { name: "Field Notes" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connectedFolder = created.body!.connectedFolder as { id: string; connectedFolderRoot: string };
  const holding = volume({ id: "volume-00000000000000000002", name: "Field Drive", mountPath: join(sandbox, "content") });
  const internal = volume({ id: "volume-00000000000000000003", name: "Data", mountPath: join(sandbox, "data"), ejectable: false });
  setVolumeSourceForTests(async () => [holding, internal]);

  assert.equal((await call("/api/volumes/eject", { method: "POST", body: {} })).status, 400);
  const unknown = await call("/api/volumes/eject", { method: "POST", body: { volumeId: "volume-ffffffffffffffffffff" } });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body!.error, /isn’t connected anymore/);
  const fixed = await call("/api/volumes/eject", { method: "POST", body: { volumeId: internal.id } });
  assert.equal(fixed.status, 409);
  assert.match(fixed.body!.error, /“Data” can’t be ejected/);

  // A request in the Connected Folder that has not settled holds the drive in place.
  await api.requests.beginRoot({ kind: "connected-folder", owner: { connectedFolderId: connectedFolder.id, connectedFolderName: "Field Notes", conversationId: "conversation-eject-test" }, surface: "renderer", taskId: "task-eject-test" });
  const busy = await call("/api/volumes/eject", { method: "POST", body: { volumeId: holding.id } });
  assert.equal(busy.status, 409, JSON.stringify(busy.body));
  assert.match(busy.body!.error, /Finish or stop Field Notes’s outstanding work before ejecting “Field Drive”/);
  assert.deepEqual(ran, [], "no tool ran");

  // A drive with no Connected Folder on it ejects; a busy one says so.
  const other = volume({ id: "volume-00000000000000000004", name: "Camera", mountPath: join(sandbox, "camera") });
  setVolumeSourceForTests(async () => [holding, other]);
  const ejected = await call("/api/volumes/eject", { method: "POST", body: { volumeId: other.id } });
  assert.equal(ejected.status, 200, JSON.stringify(ejected.body));
  assert.deepEqual(ejected.body, { volumeId: other.id, ejected: true });
  assert.deepEqual(ran, [{ command: "gio", args: ["mount", "-e", join(sandbox, "camera")] }]);
  setEjectRunnerForTests(async () => ({ code: 1, stdout: "", stderr: "Error unmounting block device 8:17: GDBus.Error:org.freedesktop.UDisks2.Error.DeviceBusy: Error unmounting /dev/sdb1: target is busy" }));
  const inUse = await call("/api/volumes/eject", { method: "POST", body: { volumeId: other.id } });
  assert.equal(inUse.status, 409);
  assert.match(inUse.body!.error, /“Camera” is in use/);
  setEjectRunnerForTests(async () => ({ code: null, stdout: "", stderr: "", missing: true }));
  const missing = await call("/api/volumes/eject", { method: "POST", body: { volumeId: other.id } });
  assert.equal(missing.status, 503);
  assert.match(missing.body!.error, /neither gio nor udisksctl/);
});

test("the Trash lists items by opaque id, and Put Back returns one without replacing what took its name", async (t) => {
  const { call, home, trash } = await sandboxApi(t);
  const documents = join(home, "Documents");
  await mkdir(documents, { recursive: true });
  await writeFile(join(documents, "budget.xlsx"), "new budget");
  await trashFile(trash, "budget.xlsx", join(documents, "budget.xlsx"), "old budget");
  const listing = await call("/api/trash");
  assert.equal(listing.status, 200);
  assert.equal(listing.body!.putBackAvailable, true);
  const [item] = listing.body!.items;
  assert.equal(item.name, "budget.xlsx");
  assert.equal(item.originalPath, join(documents, "budget.xlsx"));

  assert.equal((await call("/api/trash/put-back", { method: "POST", body: { itemId: join(trash, "files", "budget.xlsx") } })).status, 404, "a path is not an id");
  assert.equal((await call("/api/trash/put-back", { method: "POST", body: {} })).status, 400);
  const back = await call("/api/trash/put-back", { method: "POST", body: { itemId: item.id } });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body!.name, "budget copy.xlsx");
  assert.equal(back.body!.renamed, true);
  assert.equal(back.body!.restorePoint, null);
  assert.ok(back.body!.location, "the window learns where to show it");
  assert.equal(back.body!.location.select.split("/").at(-1), "budget copy.xlsx");
  assert.equal(await readFile(join(documents, "budget.xlsx"), "utf8"), "new budget");
  assert.equal(await readFile(join(documents, "budget copy.xlsx"), "utf8"), "old budget");
  assert.equal((await call("/api/trash/put-back", { method: "POST", body: { itemId: item.id } })).status, 404, "it is no longer in the Trash");
});

test("Put Back into a Connected Folder goes through its History, which can take it out again", async (t) => {
  const { call, trash } = await sandboxApi(t);
  const created = await call("/api/connected-folders", { method: "POST", body: { name: "Garden" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connectedFolder = created.body!.connectedFolder as { id: string; connectedFolderRoot: string };
  await writeFile(join(connectedFolder.connectedFolderRoot, "plan.md"), "current plan");
  await trashFile(trash, "plan.md", join(connectedFolder.connectedFolderRoot, "plan.md"), "older plan");
  await trashFile(trash, "seeds.csv", join(connectedFolder.connectedFolderRoot, "Spring", "Beds", "seeds.csv"), "tomato,basil");
  const items = (await call("/api/trash")).body!.items as Array<{ id: string; name: string }>;

  const plan = await call("/api/trash/put-back", { method: "POST", body: { itemId: items.find((entry) => entry.name === "plan.md")!.id } });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body!.name, "plan copy.md");
  assert.equal(plan.body!.restorePoint.connectedFolderId, connectedFolder.id);
  assert.deepEqual(plan.body!.location, { place: { kind: "connected-folder", id: connectedFolder.id }, path: "", select: "plan copy.md" });
  assert.equal(await readFile(join(connectedFolder.connectedFolderRoot, "plan.md"), "utf8"), "current plan");

  // A missing folder inside a Connected Folder is recreated, and History records it with the item.
  const seeds = await call("/api/trash/put-back", { method: "POST", body: { itemId: items.find((entry) => entry.name === "seeds.csv")!.id } });
  assert.equal(seeds.status, 200, JSON.stringify(seeds.body));
  assert.deepEqual(seeds.body!.recreatedFolders, [join(connectedFolder.connectedFolderRoot, "Spring"), join(connectedFolder.connectedFolderRoot, "Spring", "Beds")]);
  const checkpoints = (await call(`/api/connected-folders/${connectedFolder.id}/history/checkpoints`)).body!.checkpoints as Array<{ checkpointId: string; label?: string }>;
  assert.ok(checkpoints.some((checkpoint) => checkpoint.checkpointId === seeds.body!.restorePoint.checkpointId && /putting back seeds\.csv/.test(checkpoint.label ?? "")), JSON.stringify(checkpoints));

  const restored = await call(`/api/connected-folders/${connectedFolder.id}/history/checkpoints/${seeds.body!.restorePoint.checkpointId}/restore`, { method: "POST", body: {} });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.ok(!existsSync(join(connectedFolder.connectedFolderRoot, "Spring")), "restoring takes the put-back folder out again");
});
