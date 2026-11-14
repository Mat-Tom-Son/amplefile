import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";

function desktopWith(initial: unknown) {
  const actions: string[] = [];
  let listener: ((state: unknown) => void) | null = null;
  window.ampleFileDesktop = {
    app: { platform: "linux", name: "AmpleFile" },
    window: {
      getChromeState: () => Promise.resolve(initial),
      onChromeStateChanged: (callback: (state: unknown) => void) => { listener = callback; return () => { listener = null; }; },
      control: (action: string) => actions.push(action),
    },
  } as never;
  return { actions, emit: (state: unknown) => listener?.(state) };
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>(".desktop-window-control")];

test("the Linux title bar draws the desktop's window buttons, on its side, and they act on the window", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const desktop = desktopWith({ buttonLayout: { left: [], right: ["minimize", "close"] }, maximized: false, fullScreen: false, focused: true, highContrast: false });
  const { DesktopTitleBar } = await import("../web-local/src/components/chrome/DesktopTitleBar.js");
  await dom.render(createElement(DesktopTitleBar));
  await dom.waitFor(() => buttons().length === 2);
  const header = document.querySelector("header.desktop-titlebar")!;
  assert.ok(header.classList.contains("desktop-titlebar--linux"));
  assert.deepEqual(buttons().map((button) => button.getAttribute("aria-label")), ["Minimize", "Close"]);
  assert.equal(header.lastElementChild?.classList.contains("desktop-window-controls--right"), true, "after the drag space");
  assert.equal(document.querySelector('[role="group"][aria-label="Window"]') !== null, true);
  for (const button of buttons()) assert.equal(button.type, "button", "keyboard-reachable real buttons");

  await dom.act(() => buttons()[0]!.click());
  await dom.act(() => buttons()[1]!.click());
  assert.deepEqual(desktop.actions, ["minimize", "close"]);

  // The person moves the buttons to the left and adds maximize; the window is maximized.
  await dom.act(() => desktop.emit({ buttonLayout: { left: ["close", "maximize"], right: [] }, maximized: true, fullScreen: false, focused: false, highContrast: false }));
  assert.deepEqual(buttons().map((button) => button.getAttribute("aria-label")), ["Close", "Restore"]);
  assert.equal(header.firstElementChild?.classList.contains("desktop-window-controls--left"), true, "before the name");
  assert.equal(header.getAttribute("data-window-focused"), "false");
  await dom.act(() => buttons()[1]!.click());
  assert.equal(desktop.actions.at(-1), "toggle-maximize");

  // An empty layout (tiling desktops) draws no buttons; a malformed state changes nothing.
  await dom.act(() => desktop.emit({ buttonLayout: { left: [], right: [] }, maximized: false, fullScreen: false, focused: true, highContrast: false }));
  assert.equal(buttons().length, 0);
  await dom.act(() => desktop.emit({ buttonLayout: { left: ["shade"], right: [] } }));
  assert.equal(buttons().length, 0);
});

test("Windows keeps Electron's overlay buttons", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  window.ampleFileDesktop = { app: { platform: "win32", name: "AmpleFile" }, window: {} } as never;
  const { DesktopTitleBar } = await import("../web-local/src/components/chrome/DesktopTitleBar.js");
  await dom.render(createElement(DesktopTitleBar));
  assert.equal(buttons().length, 0);
  assert.equal(document.querySelector("header.desktop-titlebar--linux"), null);
});

test("the desktop's high-contrast setting turns on More Contrast in the window", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
  const desktop = desktopWith({ buttonLayout: { left: [], right: ["close"] }, maximized: false, fullScreen: false, focused: true, highContrast: false });
  (window.ampleFileDesktop as unknown as { window: Record<string, unknown> }).window.setTheme = () => {};
  const { ApplicationAppearanceStore } = await import("../web-local/src/lib/application-appearance-store.js");
  const { useApplicationAppearance } = await import("../web-local/src/hooks/useApplicationAppearance.js");
  const store = new ApplicationAppearanceStore(null, true);
  function Screen() { useApplicationAppearance({ store }); return null; }
  await dom.render(createElement(Screen));
  await dom.settle();
  assert.equal(document.documentElement.dataset.appearanceContrast, "system");
  await dom.act(() => desktop.emit({ buttonLayout: { left: [], right: ["close"] }, maximized: false, fullScreen: false, focused: true, highContrast: true }));
  assert.equal(document.documentElement.dataset.appearanceContrast, "more");
});
