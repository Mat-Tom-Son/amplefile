import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import type { FileChangesContext } from "../web-local/src/components/file-manager/useFileChanges.js";
import type { TreeEntry } from "../web-local/src/types.js";
import { createFileManagerHarness } from "./support/file-manager.js";

test("a second Undo waits while the first Undo is waiting for its delete receipt", async (t) => {
  const older = "older.txt";
  const newer = "newer.txt";
  const restores: string[] = [];
  const errors: Array<string | null> = [];
  const { dom } = await createFileManagerHarness(t, (path, options) => {
    const point = /^\/api\/connected-folders\/lab\/history\/checkpoints\/([^/]+)\/restore$/.exec(path)?.[1];
    if (options.method === "POST" && point) {
      restores.push(point);
      return { safetyCheckpointId: `redo-${point}` };
    }
    return undefined;
  });
  const newerDelete = Promise.withResolvers<Response>();
  const deleted: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.equal(url, "/api/connected-folders/lab/local-file");
    assert.equal(init?.method, "DELETE");
    const { path } = JSON.parse(String(init?.body)) as { path: string };
    deleted.push(path);
    return path === newer ? newerDelete.promise : Response.json({ safetyCheckpointId: path });
  });

  const { ToastHost } = await import("../web-local/src/ui/feedback.js");
  const { useFileChanges } = await import("../web-local/src/components/file-manager/useFileChanges.js");
  const { useFileOperations } = await import("../web-local/src/components/file-manager/useFileOperations.js");
  const { useConflictQuestion } = await import("../web-local/src/components/file-manager/ConflictDialog.js");
  const place = { kind: "connected-folder", id: "lab" } as const;
  const entries = new Map([older, newer].map((path) => [path, { path, name: path, kind: "file" } satisfies TreeEntry]));
  let refreshes = 0;
  let changes: ReturnType<typeof useFileChanges>;
  function Window() {
    const context: FileChangesContext = {
      fixtureMode: false, tabId: "1", folderView: true, place, location: { place, path: "" },
      apiBase: "/api/connected-folders/lab", selection: [], byPath: entries,
      listing: { refresh: async () => { refreshes++; } }, standard: { refresh: async () => undefined },
      fileOperations: useFileOperations(false), conflictQuestion: useConflictQuestion(),
      select() {}, setSelection() {}, setHiddenPaths() {}, requestRename() {},
      nameOfPlace: () => "Lab", onError: (message) => { errors.push(message); },
    };
    changes = useFileChanges(context);
    return createElement(ToastHost);
  }
  await dom.render(createElement(Window));
  const commitDelete = async (path: string) => {
    await dom.act(() => changes.deletePaths([path]));
    await dom.act(() => dom.container.querySelector<HTMLButtonElement>('[aria-label="Dismiss Notification"]')!.click());
    await dom.waitFor(() => deleted.includes(path));
  };

  await commitDelete(older);
  await dom.waitFor(() => refreshes === 1);
  await commitDelete(newer);
  let undoBoth: Promise<void[]>;
  await dom.act(() => { undoBoth = Promise.all([changes.undoFileChange(), changes.undoFileChange()]); });
  assert.deepEqual(restores, [], "the older restore cannot start while the newer receipt is outstanding");
  await dom.act(async () => {
    newerDelete.resolve(Response.json({ safetyCheckpointId: newer }));
    await undoBoth;
  });
  assert.deepEqual(restores, [newer, older]);
  assert.deepEqual(errors, []);
});
