import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createFileManagerHarness, type ApiAnswer } from "./support/file-manager.js";
import type { ConnectedFolderSummary } from "../web-local/src/types.js";
import type { ConnectedFolderRole } from "../src/shared/connected-folder-role.js";

// A Connected Folder's Role in Info and in the @ menu, in the real file manager
// window (jsdom, a mocked local API).
const lab = { id: "lab", name: "Lab", connectedFolderRoot: "/tmp/lab", location: { storage: "linked" } } as ConnectedFolderSummary;
const at = "2026-11-27T10:00:00.000Z";
const sampleRole: ConnectedFolderRole = {
  version: 1,
  purpose: "Tax paperwork for the household.",
  askFor: ["Which receipts are missing", "A summary of deductions"],
  produces: ["Yearly summaries"],
  updatedAt: at,
};

interface Backend { role: ConnectedFolderRole | null; puts: unknown[]; refuse: string | null }

function answerFor(backend: Backend): ApiAnswer {
  return (path, options) => {
    if (path === "/api/connected-folders/lab/role") {
      if (options.method === "PUT") {
        backend.puts.push(options.body);
        if (backend.refuse) throw new Error(backend.refuse);
        const body = options.body as Partial<ConnectedFolderRole>;
        backend.role = { ...sampleRole, ...body, updatedAt: at } as ConnectedFolderRole;
        return { role: backend.role, previousRole: null, changed: true };
      }
      return { role: backend.role };
    }
    if (path.startsWith("/api/agent/status")) return { status: { ready: true, configured: true } };
    if (path.startsWith("/api/agent/composer")) return { composer: null };
    if (path === "/api/standard-folders") return { folders: [] };
    if (path.includes("/tree")) return { tree: [] };
    if (path.endsWith("/automations")) return { automations: [] };
    if (path.endsWith("/conversations")) return { conversations: [] };
    if (path === "/api/connected-folders/activity") return { running: [] };
    if (path.endsWith("/suggestions")) return { suggestions: [] };
    if (path.includes("/history/checkpoints")) return { checkpoints: [] };
    return undefined;
  };
}

async function mountWindow(t: Parameters<typeof createFileManagerHarness>[0], backend: Backend) {
  const harness = await createFileManagerHarness(t, answerFor(backend));
  await harness.dom.render(createElement(harness.module.FileManagerView, {
    connectedFolder: lab, connectedFolders: [lab], agent: { ready: true, configured: true } as never, fixture: null,
    onSwitchConnectedFolder() {}, onOpenSettings() {}, onRefreshBootstrap: async () => {}, onCreateConnectedFolder() {}, onOpenFolder() {}, onError() {},
  }));
  const { container } = harness.dom;
  await harness.dom.waitFor(() => Boolean(container.querySelector("nav.fm-sidebar")));
  await harness.dom.waitFor(() => Boolean(container.querySelector(".fm-role")));
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".fm-role button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label)!;
  const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    await harness.dom.act(() => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  return { ...harness, container, button, type, role: () => container.querySelector<HTMLElement>(".fm-role")! };
}

test("Info shows a Role: the purpose, then Ask It For and Produces, and no empty list", async (t) => {
  const view = await mountWindow(t, { role: sampleRole, puts: [], refuse: null });
  const text = view.role().textContent ?? "";
  assert.match(text, /Tax paperwork for the household\./);
  assert.match(text, /Ask It For.*Which receipts are missing.*A summary of deductions/s);
  assert.match(text, /Produces.*Yearly summaries/s);
  assert.doesNotMatch(text, /Accepts/, "a list with no entries is not drawn");
  assert.equal(view.role().querySelector("h2")?.textContent, "Role");
  assert.ok(view.button("Edit"));
  // It sits above the Automations section.
  const sections = [...view.container.querySelectorAll(".fm-panel .fm-sec")].map((item) => item.querySelector("h2")?.textContent);
  assert.ok(sections.indexOf("Role") >= 0 && sections.indexOf("Role") < sections.indexOf("Automations"));
});

test("with no Role Info says so quietly and offers Add Role", async (t) => {
  const backend: Backend = { role: null, puts: [], refuse: null };
  const view = await mountWindow(t, backend);
  assert.match(view.role().textContent ?? "", /No Role yet/);
  assert.equal(view.role().querySelector(".fm-role-view"), null);
  await view.dom.act(() => view.button("Add Role").click());
  assert.equal(view.container.ownerDocument.activeElement, view.container.querySelector("textarea"), "the purpose field takes focus");
  assert.equal(view.container.querySelector<HTMLTextAreaElement>(".fm-role textarea")!.maxLength, 280);
});

test("Edit turns the Role into bounded fields; Save sends them and shows the saved Role", async (t) => {
  const backend: Backend = { role: sampleRole, puts: [], refuse: null };
  const view = await mountWindow(t, backend);
  await view.dom.act(() => view.button("Edit").click());
  const purpose = view.container.querySelector<HTMLTextAreaElement>(".fm-role textarea")!;
  assert.equal(purpose.value, "Tax paperwork for the household.");
  assert.equal(view.container.ownerDocument.activeElement, purpose);
  assert.equal(view.role().querySelectorAll("fieldset").length, 3);
  for (const input of view.role().querySelectorAll<HTMLInputElement>("input")) assert.equal(input.maxLength, 140);
  await view.type(purpose, "Household tax paperwork.");
  await view.dom.act(() => view.button("Add Accepts Entry").click());
  const accepts = view.container.querySelector<HTMLInputElement>('input[aria-label="Accepts, entry 1"]')!;
  await view.type(accepts, "Pay stubs");
  await view.dom.act(() => view.button("Remove Produces entry 1").click());
  // Eight entries is the bound: the eighth Add Entry leaves no ninth.
  for (let i = 0; i < 7; i += 1) await view.dom.act(() => view.button("Add Ask It For Entry").click());
  assert.equal(view.button("Add Ask It For Entry").disabled, true);
  for (let i = 8; i > 2; i -= 1) await view.dom.act(() => view.button(`Remove Ask It For entry ${i}`).click());
  await view.dom.act(async () => { view.container.querySelector<HTMLFormElement>(".fm-role form")!.requestSubmit(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await view.dom.waitFor(() => !view.container.querySelector(".fm-role form"));
  assert.deepEqual(backend.puts, [{ purpose: "Household tax paperwork.", askFor: ["Which receipts are missing", "A summary of deductions"], produces: [], accepts: ["Pay stubs"] }]);
  assert.match(view.role().textContent ?? "", /Household tax paperwork\..*Accepts.*Pay stubs/s);
  assert.equal(view.container.ownerDocument.activeElement, view.button("Edit"), "focus returns to Edit");
});

test("a refused Save shows the host's words, keeps the draft, and claims nothing", async (t) => {
  const backend: Backend = { role: sampleRole, puts: [], refuse: "Wait for the current change to this Connected Folder to finish." };
  const view = await mountWindow(t, backend);
  await view.dom.act(() => view.button("Edit").click());
  await view.type(view.container.querySelector<HTMLTextAreaElement>(".fm-role textarea")!, "A draft I keep");
  await view.dom.act(async () => { view.container.querySelector<HTMLFormElement>(".fm-role form")!.requestSubmit(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await view.dom.waitFor(() => Boolean(view.role().querySelector('[role="alert"]')));
  assert.equal(view.role().querySelector('[role="alert"]')!.textContent, "Wait for the current change to this Connected Folder to finish.");
  assert.equal(view.container.querySelector<HTMLTextAreaElement>(".fm-role textarea")!.value, "A draft I keep");
  assert.doesNotMatch(view.role().textContent ?? "", /Saved/);
  assert.equal(backend.role, sampleRole, "nothing changed");
  // Cancel drops the draft and shows the Role as it was; Escape does the same.
  await view.dom.act(() => view.button("Cancel").click());
  assert.match(view.role().textContent ?? "", /Tax paperwork for the household\./);
  await view.dom.act(() => view.button("Edit").click());
  assert.equal(view.container.querySelector<HTMLTextAreaElement>(".fm-role textarea")!.value, "Tax paperwork for the household.", "a new Edit starts from the saved Role");
  await view.dom.act(() => { view.container.querySelector(".fm-role textarea")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  assert.equal(view.container.querySelector(".fm-role form"), null);
});

test("the @ menu shows each Worker's Role purpose under its name", async (t) => {
  const harness = await createFileManagerHarness(t, () => undefined);
  const { FolderMentionMenu } = await import("../web-local/src/components/chat/FolderMentionMenu.js");
  await harness.dom.render(createElement(FolderMentionMenu, {
    id: "menu", activeIndex: 0, onHover() {}, onChoose() {},
    folders: [{ id: "a", name: "Taxes", rolePurpose: "Tax paperwork for the household." }, { id: "b", name: "Garden" }],
  }));
  const options = [...harness.dom.container.querySelectorAll('[role="option"]')];
  assert.equal(options[0]!.querySelector(".composer-mention-name")?.textContent, "Taxes");
  assert.equal(options[0]!.querySelector(".composer-mention-purpose")?.textContent, "Tax paperwork for the household.");
  assert.equal(options[1]!.querySelector(".composer-mention-purpose"), null, "no Role, no second line");
});
