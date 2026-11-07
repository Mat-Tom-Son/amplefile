import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parseRestrictedAppAppearance, restrictedAppAppearanceCss, restrictedAppAppearanceTokens } from "../desktop/src/restricted-app-appearance.js";
import { resolveLightDark } from "../web-local/src/lib/restricted-app-appearance.js";

const root = resolve(import.meta.dirname, "..");

test("app views get only known tokens with plain values; anything else is dropped, not fatal", () => {
  const parsed = parseRestrictedAppAppearance({
    "--af-accent": "#0d74ce",
    "--af-accent-soft": "color-mix(in srgb, #0d74ce 18%, #fafbf8)",
    "--af-font": "\"AmpleFile Inter\", Inter, system-ui, sans-serif",
    "--af-shadow": "0 8px 16px rgba(23, 29, 39, 0.14)",
    "--af-text": "url(https://example.invalid/x)",
    "--af-surface": "red;}body{display:none",
    "--af-border": "#000\n}",
    "--af-danger": "\"unbalanced",
    "--af-success": "image-set(\"a.png\" 1x)",
    "--not-a-token": "#fff",
  });
  assert.deepEqual(parsed, {
    "--af-accent": "#0d74ce",
    "--af-accent-soft": "color-mix(in srgb, #0d74ce 18%, #fafbf8)",
    "--af-font": "\"AmpleFile Inter\", Inter, system-ui, sans-serif",
    "--af-shadow": "0 8px 16px rgba(23, 29, 39, 0.14)",
  });
  assert.throws(() => parseRestrictedAppAppearance("tokens"), /must be an object/);
});

test("the injected CSS is variables and the font only, so it restyles nothing by itself", () => {
  const css = restrictedAppAppearanceCss("dark", { "--af-accent": "#b1d5ff" });
  assert.match(css, /@font-face\{font-family:"AmpleFile Inter";[^}]*src:url\("\/__amplefile\/fonts\/inter-latin-wght-normal\.woff2"\)/);
  assert.match(css, /:root\{--af-theme:dark;--af-color-scheme:dark;--af-accent:#b1d5ff;\}$/);
  assert.doesNotMatch(css.replace(/@font-face\{[^}]*\}/g, ""), /(^|[;{])color-scheme:|body|\.af-/, "no element rules and no color-scheme change");
  assert.ok(restrictedAppAppearanceTokens.every((name) => name.startsWith("--af-")));
});

test("light-dark pairs are settled for the shell's theme before they reach an app", () => {
  assert.equal(resolveLightDark("light-dark(#0d74ce, #b1d5ff)", "light"), "#0d74ce");
  assert.equal(resolveLightDark("light-dark(#0d74ce, #b1d5ff)", "dark"), "#b1d5ff");
  assert.equal(resolveLightDark("light-dark(rgb(1, 2, 3), rgba(4, 5, 6, 0.5))", "dark"), "rgba(4, 5, 6, 0.5)");
  assert.equal(resolveLightDark("0 0 0 2px light-dark(#fff, #000)", "light"), "0 0 0 2px #fff");
  assert.equal(resolveLightDark("#123456", "dark"), "#123456");
});

test("every kit rule has zero specificity, so an app's own styles always win", async () => {
  const kit = await readFile(resolve(root, "desktop/assets/restricted-app-kit/kit.css"), "utf8");
  const withoutComments = kit.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...withoutComments.matchAll(/(^|})\s*([^@{}][^{}]*)\{/g)].map((match) => match[2]!.trim())
    .filter((selector) => !/^(to|from|\d+%)$/.test(selector) && !selector.startsWith("@"));
  assert.ok(selectors.length > 20);
  for (const selector of selectors) {
    for (const part of selector.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), /^:where\(/, `kit selector "${part.trim()}" must start with :where()`);
    }
  }
  assert.match(kit, /<link rel="stylesheet" href="\/__amplefile\/kit\.css">/);
});
