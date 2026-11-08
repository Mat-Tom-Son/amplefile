import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./support/dom.js";
import { deleteLocalFileRequest, deleteLocalFilesRequest, type PendingDelete } from "../web-local/src/lib/pending-deletes.js";

const pending = (path: string, extra: Partial<PendingDelete> = {}): PendingDelete => ({
  connectedFolderId: "space-a", path, name: path.split("/").pop()!, selectedPath: null, deletedTabPaths: new Set(), ...extra,
});

test("several rows go to the host in one request, and one row keeps its own route", async (t) => {
  const dom = await createDomHarness();
  const previousFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = previousFetch; await dom.cleanup(); });
  const sent: Array<{ url: string; method?: string; body: unknown; keepalive?: boolean }> = [];
  globalThis.fetch = (async (input, init) => {
    sent.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)), keepalive: init?.keepalive });
    if (String(input).endsWith("/local-files")) {
      return Response.json({ deleted: [{ path: "a.txt", kind: "file" }, { path: "b.txt", kind: "file" }], safetyCheckpointId: "cp-1" });
    }
    return Response.json({ deleted: true, path: "solo.txt", kind: "file" });
  }) as typeof fetch;

  const result = await deleteLocalFilesRequest("space-a", ["a.txt", "b.txt"], true);
  assert.equal(result.safetyCheckpointId, "cp-1");
  await deleteLocalFileRequest(pending("solo.txt"));
  assert.deepEqual(sent, [
    { url: "/api/connected-folders/space-a/local-files", method: "DELETE", body: { paths: ["a.txt", "b.txt"] }, keepalive: true },
    { url: "/api/connected-folders/space-a/local-file", method: "DELETE", body: { path: "solo.txt" }, keepalive: false },
  ]);

  globalThis.fetch = (async () => Response.json({ error: "Finish or stop this Connected Folder's outstanding work before deleting." }, { status: 409 })) as typeof fetch;
  await assert.rejects(() => deleteLocalFilesRequest("space-a", ["a.txt", "b.txt"]), /outstanding work/);
});
