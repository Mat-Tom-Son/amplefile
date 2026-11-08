import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { createElement, useState } from "react";
import test from "node:test";

import { createDomHarness } from "./support/dom.js";
import type { ConnectedFolderSummary, ConnectedFolderCustomization } from "../web-local/src/types.js";

test("Customize Connected Folder isolates its popup and routes edits to the Connected Folder it was opened for", async (t) => {
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:customize-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:customize-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
    },
  });
  t.after(() => assets.deregister());
  const { ConnectedFolderAppearanceModal } = await import("../web-local/src/components/modals/ConnectedFolderAppearanceModal.js");
  const { connectedFolderIdentityFor } = await import("../web-local/src/lib/connected-folder-identity.js");
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const target = { id: "other-folder", name: "Trip", connectedFolderRoot: "/tmp/trip", location: { kind: "local", storage: "linked" } } as ConnectedFolderSummary;
  const edits: string[] = [];
  let closes = 0;
  const popup = createElement(ConnectedFolderAppearanceModal, {
    connectedFolder: target,
    identity: connectedFolderIdentityFor(target, {}),
    canUndo: true,
    onRenameConnectedFolder: async (connectedFolder, name) => { edits.push(`rename:${connectedFolder.id}:${name}`); },
    onCustomizeConnectedFolder: (id) => { edits.push(`customize:${id}`); },
    onReplaceConnectedFolder: (id) => { edits.push(`replace:${id}`); },
    onUndoConnectedFolder: (id) => { edits.push(`undo:${id}`); },
    onResetConnectedFolder: (id) => { edits.push(`reset:${id}`); },
    onClose: () => { closes += 1; },
  });
  const screen = (open: boolean) => createElement("div", null,
    createElement("main", { id: "work" }, createElement("button", { id: "opener" }, "Customize another Connected Folder")),
    open ? popup : null,
  );
  await dom.render(screen(false));
  document.getElementById("opener")!.focus();
  await dom.render(screen(true));
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  // One page with a section each (2026-11-05), no tabs.
  assert.equal(dialog.querySelector('[role="tablist"]'), null);
  assert.deepEqual([...dialog.querySelectorAll('.connected-folder-appearance-section > h3')].map((heading) => heading.textContent), ["Icon", "Color"]);
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Close Customize Connected Folder");
  assert.equal(document.getElementById("work")!.getAttribute("aria-hidden"), "true");
  assert.equal(document.getElementById("work")!.inert, true);
  await dom.act(() => document.querySelector<HTMLButtonElement>('[aria-label="Use Blue Color"]')!.click());
  await dom.act(() => document.querySelector<HTMLButtonElement>('[title="Undo the last appearance change"]')!.click());
  await dom.act(() => {
    const field = document.querySelector<HTMLInputElement>('[aria-label="Connected Folder name for Trip"]')!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, "Holiday");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await dom.act(() => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.deepEqual(edits, ["customize:other-folder", "undo:other-folder", "rename:other-folder:Holiday"]);
  await dom.press("Escape");
  assert.equal(closes, 1);
  await dom.render(screen(false));
  await dom.settle();
  assert.equal(document.getElementById("work")!.getAttribute("aria-hidden"), null);
  assert.equal(Boolean(document.getElementById("work")!.inert), false);
  assert.equal(document.activeElement?.id, "opener");
});


test("accent colors and icon categories share one Connected Folder editor", async (t) => {
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:customize-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:customize-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
    },
  });
  t.after(() => assets.deregister());
  const { ConnectedFolderAppearanceModal } = await import("../web-local/src/components/modals/ConnectedFolderAppearanceModal.js");
  const { connectedFolderIdentityFor } = await import("../web-local/src/lib/connected-folder-identity.js");
  const { filterConnectedFolderIconOptions, connectedFolderIconGroups } = await import("../web-local/src/connected-folder-icons.js");
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const target = { id: "target-folder", name: "Notes", connectedFolderRoot: "/tmp/notes", location: { kind: "local", storage: "linked" } } as ConnectedFolderSummary;
  const changes: ConnectedFolderCustomization[] = [];
  const shortcuts: string[] = [];
  let saved: ConnectedFolderCustomization = { color: "#0e7490" };
  function Editor() {
    const [customization, setCustomization] = useState(saved);
    return createElement(ConnectedFolderAppearanceModal, {
      connectedFolder: target, identity: connectedFolderIdentityFor(target, { [target.id]: customization }), customization, canUndo: changes.length > 0,
      onCustomizeConnectedFolder: (id, patch) => { assert.equal(id, target.id); changes.push(patch); saved = { ...saved, ...patch }; setCustomization(saved); },
      onReplaceConnectedFolder: () => {}, onUndoConnectedFolder: () => {}, onResetConnectedFolder: () => {}, onClose: () => {}, onRenameConnectedFolder: async () => {},
      onOpenWorkerSettings: (section, returnSection) => { shortcuts.push(`${target.id}:${section}:${returnSection}`); },
    });
  }
  const click = async (selector: string) => dom.act(() => document.querySelector<HTMLButtonElement>(selector)!.click());
  await dom.render(createElement(Editor));
  assert.equal(document.querySelector('[aria-label="Folder color pairs"]'), null);
  await click('[aria-label="Use Blue Color"]');
  assert.equal(saved.color, "#3b82f6");
  const { connectedFolderColorOptions, defaultConnectedFolderColor } = await import("../web-local/src/lib/connected-folder-identity.js");
  const { accentIdentityFromHex, resolveConnectedFolderAppearance } = await import("../src/shared/connected-folder-appearance.js");
  assert.equal(connectedFolderColorOptions.length, 24);
  for (const option of connectedFolderColorOptions) assert.equal(resolveConnectedFolderAppearance({ primary: accentIdentityFromHex(option.color) }).passes, true, `${option.label} remains legible in both modes`);
  const originalColors = ["#60646c", "#ce2c31", "#cc4e00", "#ab6400", "#5c7c2e", "#1a7f37", "#0e7490", "#0d74ce", "#6550b9", "#953ea3", "#c2298a", "#815e46"];
  let hash = 0;
  for (const character of target.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  assert.equal(defaultConnectedFolderColor(target.id).color, originalColors[hash % originalColors.length], "updating the picker preserves default Connected Folder identities");
  assert.equal(document.querySelectorAll('.connected-folder-color-dot').length, 24);
  assert.equal(document.querySelectorAll('.connected-folder-icon-option').length, filterConnectedFolderIconOptions("", "popular").length);
  const nature = [...document.querySelectorAll<HTMLButtonElement>('.connected-folder-icon-categories button')].find(button => button.textContent === "Nature")!;
  await dom.act(() => nature.click());
  await click('[aria-label="Use Leaf Icon"]');
  assert.equal(saved.iconName, "leaf");
  for (const group of connectedFolderIconGroups) if (group.id !== "all") assert.equal(filterConnectedFolderIconOptions("", group.id).length, group.names.length, `${group.label} has no missing icons`);
  assert.equal(filterConnectedFolderIconOptions("camping")[0].name, "tent");
  // Settings returns to the section at the top of the page.
  const tops: Record<string, number> = { icon: 10, color: 500 };
  for (const [section, top] of Object.entries(tops)) document.getElementById(`folder-appearance-section-${section}`)!.getBoundingClientRect = () => ({ top } as DOMRect);
  document.querySelector<HTMLElement>('.connected-folder-appearance-sections')!.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  const shortcutBar = document.querySelector('.connected-folder-customize-worker')!;
  assert.equal(shortcutBar.querySelector('span'), null, "the Worker label and robot have been removed");
  const workerButtons = [...document.querySelectorAll<HTMLButtonElement>('.connected-folder-customize-worker button')];
  await dom.act(() => workerButtons[0].click());
  await dom.act(() => workerButtons[1].click());
  assert.deepEqual(shortcuts, ["target-folder:model:icon", "target-folder:instructions:icon"]);
});
