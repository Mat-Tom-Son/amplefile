import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./support/dom.js";

// The built-in browser's page is drawn by the desktop above everything the
// window draws, so the window must know when one of its own overlays crosses
// the page's placeholder (web-local/src/lib/native-view.ts).
function place(element: HTMLElement, left: number, top: number, width: number, height: number): void {
  element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
}

test("the page's box is the placeholder inside its borders", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const { nativeViewBounds } = await import("../web-local/src/lib/native-view.js");
  const placeholder = document.createElement("div");
  placeholder.style.borderTop = "1px solid black";
  placeholder.style.borderLeft = "2px solid black";
  dom.container.append(placeholder);
  place(placeholder, 228, 509, 892, 379);
  assert.deepEqual(nativeViewBounds(placeholder), { x: 230, y: 510, width: 890, height: 378 });
});

test("a dialog, menu, sheet, or notice across the placeholder makes the page step aside; one beside it does not", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const { nativeViewOccluded } = await import("../web-local/src/lib/native-view.js");
  const pane = document.createElement("section");
  const placeholder = document.createElement("div");
  const inside = document.createElement("div");
  inside.setAttribute("role", "dialog");
  placeholder.append(inside);
  pane.append(placeholder);
  dom.container.append(pane);
  place(placeholder, 228, 510, 892, 378);
  place(inside, 300, 600, 100, 100);
  assert.equal(nativeViewOccluded(placeholder), false, "the placeholder's own contents never hide it");

  const add = (setup: (element: HTMLElement) => void, box: [number, number, number, number]) => {
    const element = document.createElement("div");
    setup(element);
    dom.container.append(element);
    place(element, ...box);
    return element;
  };
  // Over the folder list, above the page: no overlap.
  const notice = add((element) => { element.className = "toast"; }, [500, 440, 300, 44]);
  assert.equal(nativeViewOccluded(placeholder), false);
  // The same notice lower down crosses the page.
  place(notice, 500, 480, 300, 44);
  assert.equal(nativeViewOccluded(placeholder), true);
  notice.remove();

  for (const [name, setup] of [
    ["a dialog's backdrop", (element: HTMLElement) => { element.className = "modal-backdrop"; }],
    ["Version History's backdrop", (element: HTMLElement) => { element.className = "publish-review-backdrop"; }],
    ["the Model Context inspector's backdrop", (element: HTMLElement) => { element.className = "model-context-backdrop"; }],
    ["the backdrop behind Go to Folder", (element: HTMLElement) => { element.className = "fm-goto-back"; }],
    ["the backdrop behind the window's own Action menu", (element: HTMLElement) => { element.className = "fm-menu-back"; }],
    ["an in-window menu", (element: HTMLElement) => { element.setAttribute("role", "menu"); }],
    ["Go to Folder", (element: HTMLElement) => { element.className = "fm-goto"; element.setAttribute("role", "dialog"); }],
    ["the address bar's suggestions", (element: HTMLElement) => { element.dataset.nativeViewOccluder = "true"; }],
  ] as const) {
    const overlay = add(setup, [0, 0, 1440, 900]);
    assert.equal(nativeViewOccluded(placeholder), true, name);
    overlay.style.display = "none";
    assert.equal(nativeViewOccluded(placeholder), false, `${name}, hidden`);
    overlay.remove();
  }

  // An ancestor that happens to match (the pane inside a dialog) is not an overlay over it.
  pane.setAttribute("role", "dialog");
  place(pane, 0, 0, 1440, 900);
  assert.equal(nativeViewOccluded(placeholder), false);
});
