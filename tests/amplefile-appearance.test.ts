import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  accentIdentityFromHex,
  createConnectedFolderAppearanceProposal,
  defaultConnectedFolderAccent,
  defaultConnectedFolderAccents,
  parseConnectedFolderAppearanceProposal,
  resolveConnectedFolderAppearance,
  startingConnectedFolderAccentHex,
} from "../src/shared/connected-folder-appearance.js";
import { ConnectedFolderAppearanceStore } from "../src/local/connected-folder-appearance-store.js";
import { configureAmpleFileStateRoot } from "../src/local/state-paths.js";
import { defaultConnectedFolderBannerName } from "../web-local/src/constants.js";
import {
  normalizeConnectedFolderBannerImage,
  normalizeConnectedFolderBannerImagePosition,
  normalizeConnectedFolderCustomizations,
  connectedFolderBannerOptionFor,
} from "../web-local/src/lib/connected-folder-customization.js";
import { writeStoredJsonValue } from "../web-local/src/lib/storage.js";
import { readableTextColorOn } from "../web-local/src/lib/color-contrast.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";

const connectedFolder: ConnectedFolderSummary = {
  id: "connected-folder-home",
  name: "Home projects",
  connectedFolderRoot: "C:\\Users\\you\\Documents\\Home projects",
  location: { kind: "local", storage: "linked" },
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

test("a new Connected Folder starts in a color no other Connected Folder uses while one is free", () => {
  const ids = Array.from({ length: defaultConnectedFolderAccents.length }, (_, index) => `space-${index.toString(16).padStart(16, "0")}`);
  const taken: string[] = [];
  for (const id of ids) taken.push(startingConnectedFolderAccentHex(id, taken));
  assert.equal(new Set(taken).size, defaultConnectedFolderAccents.length, "the first twelve Connected Folders all differ");

  const id = "space-8e5d20705b72ebdb";
  assert.equal(startingConnectedFolderAccentHex(id, []), defaultConnectedFolderAccent(id).hex, "its own pick wins when nothing is taken");
  const thirteenth = startingConnectedFolderAccentHex(id, [...taken, defaultConnectedFolderAccent(id).hex]);
  assert.notEqual(thirteenth, defaultConnectedFolderAccent(id).hex, "once all are used, it avoids the one used twice");
  assert.equal(startingConnectedFolderAccentHex(id, ["#123456", "not a color"]), defaultConnectedFolderAccent(id).hex, "custom colors do not count");
});

test("Connected Folder banners keep Classic as the explicit default while supporting None", () => {
  assert.equal(defaultConnectedFolderBannerName, "classic");
  assert.equal(connectedFolderBannerOptionFor(undefined).name, "classic");
  assert.equal(connectedFolderBannerOptionFor("none").name, "none");
  assert.equal(connectedFolderBannerOptionFor("unknown").name, "classic");
});

test("Connected Folder customization normalization accepts only supported fields", () => {
  const raster = "data:image/png;base64,AA==";
  const normalized = normalizeConnectedFolderCustomizations({
    [connectedFolder.id]: {
      color: "#0D74CE",
      color2: "#5C7C2E",
      iconName: "home",
      bannerName: "aurora",
      bannerImage: raster,
      bannerImagePosition: "bottom",
      ignored: "value",
    },
    removed: { color: "#ffffff" },
  }, new Set([connectedFolder.id]), new Set(["folder", "home", "airplane"]));

  assert.deepEqual(normalized, {
    [connectedFolder.id]: {
      schema: 1,
      color: "#0d74ce",
      color2: "#5c7c2e",
      iconName: "home",
      bannerName: "aurora",
      bannerImage: raster,
      bannerImagePosition: "bottom",
    },
  });
});

test("Connected Folder customization normalization rejects unsafe images and invalid values", () => {
  const normalized = normalizeConnectedFolderCustomizations({
    [connectedFolder.id]: {
      color: "blue",
      color2: "#12345g",
      iconName: "not-a-real-icon",
      bannerName: "not-a-banner",
      bannerImage: "data:image/svg+xml;base64,PHN2Zy8+",
      bannerImagePosition: "left",
    },
  }, undefined, new Set(["folder", "home", "airplane"]));

  assert.deepEqual(normalized, {});
  assert.equal(normalizeConnectedFolderBannerImage("https://example.com/banner.png"), null);
  assert.equal(normalizeConnectedFolderBannerImage("data:image/svg+xml;base64,PHN2Zy8+"), null);
  assert.equal(normalizeConnectedFolderBannerImagePosition("left"), "center");
});

test("preference storage reports quota failures instead of silently claiming durability", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { setItem: () => { throw new Error("quota"); }, removeItem: () => {} } },
    });
    assert.equal(writeStoredJsonValue("amplefile.appearance.test", { color: "#0d74ce" }), false);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { setItem: () => {}, removeItem: () => {} } },
    });
    assert.equal(writeStoredJsonValue("amplefile.appearance.test", { color: "#0d74ce" }), true);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Connected Folder identity chooses user-message text from the primary message background", () => {
  assert.equal(readableTextColorOn("#c5c5c4"), "#182846");
  assert.equal(readableTextColorOn("#0d74ce"), "#ffffff");
});

test("semantic Connected Folder palettes preserve v1 light solids and pass both contrast gates", () => {
  const colors = [
    "#60646c", "#ce2c31", "#cc4e00", "#ab6400", "#5c7c2e", "#1a7f37",
    "#0e7490", "#0d74ce", "#6550b9", "#953ea3", "#c2298a", "#815e46",
  ];
  for (const color of colors) {
    const first = resolveConnectedFolderAppearance({ primary: accentIdentityFromHex(color), bannerName: "classic" });
    const second = resolveConnectedFolderAppearance({ primary: accentIdentityFromHex(color), bannerName: "classic" });
    assert.equal(first.light.solid, color, `light solid must preserve ${color}`);
    assert.equal(first.passes, true, `${color} must pass both modes`);
    assert.deepEqual(first, second, "resolution must be deterministic");
    for (const palette of [first.light, first.dark]) {
      assert.deepEqual(palette.audit.filter((entry) => !entry.passes), []);
      assert.equal(palette.audit.find((entry) => entry.role === "textBody")!.wcag >= 4.5, true);
      assert.equal(palette.audit.find((entry) => entry.role === "textBody")!.apca >= 75, true);
      assert.equal(palette.audit.find((entry) => entry.role === "glyph")!.wcag >= 3, true);
    }
  }
});

test("guided palettes resolve extreme and arbitrary user colors in both modes", () => {
  const colors = [
    "#000000", "#ffffff", "#ffffee", "#010001", "#ff00ff", "#00ffff",
    "#7f7f7f", "#123456", "#fedcba", "#80ff00", "#0000ff", "#ff0000",
  ];
  for (const color of colors) {
    const resolved = resolveConnectedFolderAppearance({ primary: accentIdentityFromHex(color) });
    assert.equal(resolved.passes, true, `${color} must produce a passing guided palette`);
    for (const palette of [resolved.light, resolved.dark]) {
      assert.equal(palette.audit.find((entry) => entry.role === "onSolidMuted")?.passes, true);
    }
  }
});

test("appearance identities repair forged hue and chroma metadata from reference hex", () => {
  const parsed = parseConnectedFolderAppearanceProposal({
    kind: "amplefile.connected-folder-appearance",
    version: 1,
    name: "Forged metadata",
    customization: {
      schema: 2,
      primary: { schema: 2, hue: 140, chroma: 0.4, referenceHex: "#ffffff" },
    },
  });
  assert.deepEqual(parsed.customization.primary, accentIdentityFromHex("#ffffff"));
  assert.equal(resolveConnectedFolderAppearance({ primary: parsed.customization.primary! }).passes, true);
});

test("appearance proposals are typed, code-free, and ignore unknown fields", () => {
  const proposal = createConnectedFolderAppearanceProposal({
    name: "Project blue",
    customization: {
      schema: 2,
      primary: accentIdentityFromHex("#0d74ce"),
      iconName: "folder",
      bannerName: "classic",
      ...({ css: "body { display: none }", javascript: "alert(1)" } as Record<string, unknown>),
    },
    createdBy: "codex",
  });
  const parsed = parseConnectedFolderAppearanceProposal(JSON.parse(JSON.stringify(proposal)));
  assert.equal(parsed.kind, "amplefile.connected-folder-appearance");
  assert.equal(parsed.customization.primary?.referenceHex, "#0d74ce");
  assert.equal("css" in parsed.customization, false);
  assert.equal("javascript" in parsed.customization, false);
});

test("appearance proposals of another kind are rejected", () => {
  const customization = { schema: 2 as const, primary: accentIdentityFromHex("#0d74ce") };
  assert.throws(() => parseConnectedFolderAppearanceProposal({
    kind: "example.connected-folder-appearance",
    version: 1,
    name: "Other kind",
    customization,
  }), /unsupported format/);
});

test("appearance store writes versioned machine-local state atomically", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-appearance-"));
  const path = join(sandbox, "appearance.json");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = await ConnectedFolderAppearanceStore.create({ path });
  const updated = await store.replaceConnectedFolder("connected-folder-home", {
    schema: 2,
    primary: accentIdentityFromHex("#6550b9"),
    iconName: "folder",
  });
  assert.equal(updated.revision, 1);
  assert.equal(updated.customizations["connected-folder-home"]?.primary?.referenceHex, "#6550b9");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), updated);
  const reopened = await ConnectedFolderAppearanceStore.create({ path });
  assert.deepEqual(reopened.snapshot(), updated);
});

test("appearance store recovers its last committed backup and rejects future formats", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-appearance-recovery-"));
  const path = join(sandbox, "appearance.json");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = await ConnectedFolderAppearanceStore.create({ path });
  const first = await store.replaceConnectedFolder("connected-folder-home", { color: "#0d74ce" });
  await store.replaceConnectedFolder("connected-folder-home", { color: "#6550b9" });
  await writeFile(path, "{not-json", "utf8");
  const recovered = await ConnectedFolderAppearanceStore.create({ path });
  assert.deepEqual(recovered.snapshot(), first);

  await writeFile(path, JSON.stringify({ version: 99, revision: 3, customizations: {} }), "utf8");
  await assert.rejects(
    () => ConnectedFolderAppearanceStore.create({ path }),
    /unsupported version 99/i,
  );
});

test("authenticated renderer API owns Connected Folder appearance persistence and removal", async (t) => {
  const { startLocalApi } = await import("../src/local/server.js");
  const sandbox = await mkdtemp(join(tmpdir(), "amplefile-appearance-api-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    connectedFolderBase: join(sandbox, "connected-folders"),
    sessionToken: "appearance-test-token",
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    configureAmpleFileStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  const headers = {
    "content-type": "application/json",
    "x-amplefile-session": "appearance-test-token",
  };
  const createResponse = await fetch(`${api.origin}/api/connected-folders`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Appearance API" }),
  });
  assert.equal(createResponse.status, 201);
  const connectedFolderId = (await createResponse.json() as { connectedFolder: { id: string } }).connectedFolder.id;
  const updateResponse = await fetch(`${api.origin}/api/connected-folders/${connectedFolderId}/appearance`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      customization: {
        schema: 2,
        primary: accentIdentityFromHex("#0d74ce"),
        bannerName: "classic",
      },
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json() as { appearance: { revision: number; customizations: Record<string, { primary?: { referenceHex: string } }> } };
  assert.equal(updated.appearance.revision, 1);
  assert.equal(updated.appearance.customizations[connectedFolderId]?.primary?.referenceHex, "#0d74ce");

  const bootstrapResponse = await fetch(`${api.origin}/api/bootstrap`, { headers });
  const bootstrap = await bootstrapResponse.json() as { appearance: typeof updated.appearance };
  assert.equal(bootstrap.appearance.customizations[connectedFolderId]?.primary?.referenceHex, "#0d74ce");

  const removeResponse = await fetch(`${api.origin}/api/connected-folders/${connectedFolderId}/appearance`, { method: "DELETE", headers });
  const removed = await removeResponse.json() as { appearance: { customizations: Record<string, unknown> } };
  assert.equal(connectedFolderId in removed.appearance.customizations, false);
});
