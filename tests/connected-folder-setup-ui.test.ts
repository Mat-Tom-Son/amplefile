import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import test from "node:test";
import { createDomHarness } from "./support/dom.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";

const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:setup-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:setup-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(png|svg)$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { ConnectedFolderPaneHeader } = await import("../web-local/src/components/panes/connectedFolderChrome.js");
const { ConnectedFolderSetUpCard } = await import("../web-local/src/components/panes/ConnectedFolderSetUpCard.js");
const { connectedFolderIdentityFor } = await import("../web-local/src/lib/connected-folder-identity.js");
const setup = await import("../web-local/src/lib/connected-folder-setup.js");
assets.deregister();

const connectedFolder = { id: "setup-owner", name: "Downloads", connectedFolderRoot: "/synthetic/downloads", location: { kind: "local", storage: "linked" } } as ConnectedFolderSummary;

test("the header menu offers Set up for me and Just the look after Customize", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const chosen: string[] = [];
  await dom.render(createElement("div", { className: "app-shell" },
    createElement(ConnectedFolderPaneHeader, {
      connectedFolder, identity: connectedFolderIdentityFor(connectedFolder, {}), connectedFolders: [connectedFolder], connectedFolderCustomizations: {},
      onSwitchConnectedFolder: () => {}, onCreateConnectedFolder: () => {}, onOpenFolder: () => {}, onManageConnectedFolders: () => {},
      onNewChat: () => {}, onOpenAppearance: () => {}, onSetUp: (mode: string) => { chosen.push(mode); },
    }),
  ));
  const header = document.querySelector<HTMLElement>(".connected-folder-identity-header")!;
  const open = async () => {
    await dom.act(() => header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 })));
    await dom.waitFor(() => document.activeElement?.getAttribute("role") === "menuitem");
  };
  await open();
  const labels = Array.from(document.querySelectorAll('[aria-label="Connected Folder actions"] [role="menuitem"]')).map((item) => item.textContent);
  assert.deepEqual(labels.slice(0, 4), ["New Chat", "Customize Connected Folder", "Set Up for Me", "Just the Look"]);
  const item = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent === label)!;
  await dom.act(() => item("Set Up for Me").click());
  await open();
  await dom.act(() => item("Just the Look").click());
  assert.deepEqual(chosen, ["full", "look"]);
});

test("the setup card has two choices and dismisses only with ×", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const chosen: string[] = [];
  let dismissed = 0;
  await dom.render(createElement(ConnectedFolderSetUpCard, { connectedFolderName: "Downloads", onSetUp: (mode: string) => { chosen.push(mode); }, onDismiss: () => { dismissed += 1; } }));
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".connected-folder-setup-card button"));
  assert.deepEqual(buttons.map((button) => button.textContent || button.getAttribute("aria-label")), ["Dismiss", "Set Up for Me", "Just the Look"], "no Not now button");
  await dom.act(() => buttons[1]!.click());
  await dom.act(() => buttons[2]!.click());
  await dom.act(() => buttons[0]!.click());
  assert.deepEqual(chosen, ["full", "look"]);
  assert.equal(dismissed, 1);
});

test("each choice sends its own message, and offers are remembered per Connected Folder", () => {
  assert.equal(setup.connectedFolderSetUpMessage("full"), "Set up this Connected Folder for me.");
  assert.match(setup.connectedFolderSetUpMessage("look"), /^Just the look: .* without changing any of its files\.$/);
  const values = new Map<string, string>();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } },
  });
  try {
    assert.deepEqual(setup.readConnectedFolderSetUpOffers(), []);
    setup.writeConnectedFolderSetUpOffers(["a", "b", "a"]);
    assert.deepEqual(setup.readConnectedFolderSetUpOffers(), ["a", "b"]);
    values.set(setup.connectedFolderSetUpOffersKey, "{not json");
    assert.deepEqual(setup.readConnectedFolderSetUpOffers(), [], "a damaged value reads as no offers");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("the bundled set-up Skill is listed as included, turned off but never removed, and named by its folder", async () => {
  const assetsAgain = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:setup-icons-2", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:setup-icons-2") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (/\.(png|svg|css)$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  const { normalizedCapabilities, canRemoveSkill } = await import("../web-local/src/components/panes/CapabilitiesPane.js");
  assetsAgain.deregister();
  const path = "/app/resources/included-tools/skills/set-up-connected-folder/SKILL.md";
  const resource = { kind: "skills", path, enabled: true, bundled: true, metadata: { source: "Included with AmpleFile", scope: "user", origin: "top-level" } };
  const loaded = normalizedCapabilities({
    skills: [{ name: "set-up-connected-folder", description: "Set up this Connected Folder", path, source: { source: "Included with AmpleFile", scope: "user", origin: "top-level", path } }],
    extensions: [], tools: [], diagnostics: [], resources: [resource],
  } as never);
  const skill = loaded.find((item) => item.path === path)!;
  assert.equal(skill.bundled, true);
  assert.equal(skill.scope, "global", "listed under Everywhere");
  assert.equal(skill.source, "Included with AmpleFile");
  assert.equal(skill.configurable, true, "it can be turned off");
  assert.equal(canRemoveSkill(skill), false, "it is never offered for removal");

  // Turned off, Pi no longer loads it; the row keeps a real name.
  const off = normalizedCapabilities({ skills: [], extensions: [], tools: [], diagnostics: [], resources: [{ ...resource, enabled: false }] } as never);
  assert.equal(off[0]!.name, "set-up-connected-folder");
  assert.equal(off[0]!.status, "disabled");
  assert.equal(canRemoveSkill(off[0]!), false);

  // A person's own Skill can still be removed.
  const own = normalizedCapabilities({ skills: [{ name: "my-skill", description: "", path: "/agent/skills/my-skill/SKILL.md", source: { source: "auto", scope: "user", origin: "top-level", path: "/agent/skills/my-skill/SKILL.md" } }], extensions: [], tools: [], diagnostics: [], resources: [] } as never);
  assert.equal(canRemoveSkill(own[0]!), true);
});
