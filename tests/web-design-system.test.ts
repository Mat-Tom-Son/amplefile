import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const postcss = createRequire(import.meta.url)("postcss");

const connectedFolderBannerPreviewSource = await readFile(join(process.cwd(), "web-local/src/components/chrome/ConnectedFolderBannerPreview.tsx"), "utf8");

const rendererRoot = join(process.cwd(), "web-local", "src");

const [
  appSource,
  rendererMainSource,
  connectedFolderChromeSource,
  connectedFolderPanesSource,
  connectedFolderIdentitySource,
  foundationCss,
  shellCss,
  legacyCss,
  surfacesCss,
  customizationCss,
  desktopSettingsSource,
  capabilitiesSource,
  fileManagerViewSource,
] = await Promise.all([
  readRenderer("App.tsx"),
  readRenderer("main.tsx"),
  readRenderer("components/panes/connectedFolderChrome.tsx"),
  readRenderer("components/panes/connectedFolderPanes.tsx"),
  readRenderer("lib/connected-folder-identity.ts"),
  readRenderer("styles.css"),
  readRenderer("styles.css"),
  readRenderer("styles.css"),
  readRenderer("styles.css"),
  readRenderer("styles.css"),
  readRenderer("components/modals/DesktopSettingsModal.tsx"),
  readRenderer("components/panes/CapabilitiesPane.tsx"),
  readRenderer("components/file-manager/FileManagerView.tsx"),
]);

test("the desktop has no Library", () => {
  assert.doesNotMatch(connectedFolderChromeSource, /Your Library|onOpenLibrary/);
  assert.doesNotMatch(appSource, /LibraryPane|openLibrary\(|libraryTree|migrateLegacyLibraryMode/);
  assert.doesNotMatch(connectedFolderPanesSource, /export function LibraryPane|From Library/);
});

test("Skills & Extensions opens as a popup from the Add button", () => {
  // The rail's Add button opens one popup: Skills & Extensions. Discovery and
  // management are the same place, and nothing here seeds a Chat.
  assert.doesNotMatch(connectedFolderChromeSource, /Browse Skills &amp; Extensions|Manage agent tools|Build an app|Your Library|<strong>Apps<\/strong>/);
  assert.match(fileManagerViewSource, /skillsFor \? <SkillsExtensionsModal[^>]*initialView="installed"/);
  assert.doesNotMatch(appSource, /startAppBuildChat|onBuildApp=|<ConnectedFolderAppsPane|openConnectedFolderAppsSurfaceTab|openAssistantToolsSurfaceTab/);
  assert.match(capabilitiesSource, /<h1>Skills &amp; Extensions<\/h1>/);
  // Where a tool lives is one explicit decision in the review step, shown as
  // the AmpleFile Agent above folders hierarchy rather than a bare Personal/This folder toggle.
  assert.match(capabilitiesSource, /Where should it live\?/);
  assert.match(capabilitiesSource, /function ScopeHierarchyGlyph/);
  assert.match(capabilitiesSource, /"AmpleFile Agent"[\s\S]*"Here"/);
  assert.match(capabilitiesSource, /"Everywhere"[\s\S]*This Connected Folder only/);
  assert.doesNotMatch(capabilitiesSource, /Personal · everywhere|"Personal"/);
  // Discover is text-only; installed rows use a neutral type glyph.
  assert.doesNotMatch(capabilitiesSource, /CapabilityMonogram|monogramHue|Bookmark16Regular/);
  assert.match(capabilitiesSource, /capabilities-kind-icon/);
  assert.match(capabilitiesSource, /label="View Source" icon=\{false\}/);
  assert.match(capabilitiesSource, /function GitHubMark/);
  assert.doesNotMatch(capabilitiesSource, />Review<\/button>|Install…/);
  assert.doesNotMatch(capabilitiesSource, /Installation location|Install to</);
  assert.doesNotMatch(appSource, /activeMode === "capabilities"[\s\S]*?<CapabilitiesPane/);
  assert.match(capabilitiesSource, /Installed[\s\S]*Discover/);
  assert.match(capabilitiesSource, /Search installed tools/);
  assert.match(capabilitiesSource, /Skills[\s\S]*Extensions/);
  assert.match(capabilitiesSource, /Everywhere[\s\S]*This Connected Folder only/);
  assert.match(capabilitiesSource, /capabilities\/details\?id=/);
  assert.match(capabilitiesSource, /capabilities\/install/);
  assert.match(capabilitiesSource, /capabilities-view-tabs[\s\S]*?view === "installed" \? \([\s\S]*?capabilities-installed-panel/);
  assert.match(capabilitiesSource, /view === "installed" \? \([\s\S]*?capabilities-installed-panel[\s\S]*?: \([\s\S]*?capabilities-discover-panel/);
  assert.match(capabilitiesSource, /addOpen \? \([\s\S]*?<AddCapabilityDialog/);
  assert.doesNotMatch(capabilitiesSource, /<section className="professional-card capabilities-add-panel"/);
  assert.match(capabilitiesSource, /<CoreToolsSection tools=\{catalog\.tools\} management=\{catalog\.toolManagement\}/);
  assert.match(capabilitiesSource, /tool\.core === true \|\| tool\.kind === "core"/);
  assert.match(capabilitiesSource, /On in New Chats/);
  assert.match(capabilitiesSource, /Available to Chats/);
  assert.match(capabilitiesSource, /On in New Chats[\s\S]*Available to Chats/);
  assert.doesNotMatch(capabilitiesSource, /active\s*·[\s\S]*available tools/i);
  assert.match(capabilitiesSource, /setTypeFilter\("all"\);[\s\S]*selectView\("installed"\)/);
  // Installed tools are grouped by where they live instead of filtered by a
  // scope dropdown; Everywhere comes first because it reaches the most.
  assert.match(capabilitiesSource, /<IncludedToolsStrip[\s\S]*<ScopeGroup[\s\S]*scope="global"[\s\S]*<ScopeGroup[\s\S]*scope="project"/);
  assert.match(capabilitiesSource, /Included with AmpleFile/);
  assert.match(capabilitiesSource, /capabilities-scope-columns/);
  assert.doesNotMatch(capabilitiesSource, /All scopes|installedSort|Add to this folder|Add for everywhere/);
  // Skills & Extensions lists no apps.
  assert.doesNotMatch(capabilitiesSource, /RestrictedAppsSection|restrictedApps|"Apps"/);
  // Catalog listings keep provenance readable in text, including its limit.
  assert.doesNotMatch(capabilitiesSource, /capabilities-external-host|"GitHub"|capabilities-official-badge/);
  assert.match(capabilitiesSource, /safety-reviewed\."\>First-Party \/ Reference</);
  assert.match(capabilitiesSource, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/);
  assert.doesNotMatch(capabilitiesSource, /from\s+["']lucide-react["']/);

  for (const className of [
    "capabilities-pane",
    "skills-extensions-pane",
    "skills-extensions-header",
    "capabilities-view-tabs",
    "capabilities-view-content",
    "capabilities-add-panel",
    "capabilities-toolbar",
    "capabilities-search",
    "capabilities-resource-card",
    "capabilities-discover-card",
    "capability-dialog",
    "capability-review-facts",
    "capability-code-warning",
    "capabilities-core-tools",
    "capabilities-panel",
    "capabilities-scope-group",
  ]) {
    assert.equal(hasClassSelector(surfacesCss, className), true, `Capabilities class .${className} must be styled`);
  }
  for (const className of [...staticClassTokens(capabilitiesSource)].filter((name) => /^capabilit(?:y|ies)-/.test(name))) {
    assert.equal(hasClassSelector(surfacesCss, className), true, `Static Capabilities class .${className} must be styled`);
  }
  assert.match(surfacesCss, /\.skills-extensions-modal\s*\{[^}]*container-name: skills-and-extensions;[^}]*container-type: inline-size/);
  assert.match(surfacesCss, /@container skills-and-extensions \(max-width: 540px\)[\s\S]*?\.capabilities-discover-card/);
  assert.match(surfacesCss, /@media \(max-width: 600px\)[\s\S]*?\.capability-dialog/);
});

test("agent configuration lives in Settings instead of the rail", () => {
  assert.match(desktopSettingsSource, /id:\s*"ai-models"[\s\S]*?label:\s*"AI Models"/);
  assert.match(desktopSettingsSource, /<AiModelsPane[\s\S]*?embedded/);
  assert.match(appSource, /openSettings\("ai-models", scope, true\)/);
  assert.doesNotMatch(appSource, /activeMode\s*===\s*"setup"/);
  assert.doesNotMatch(connectedFolderChromeSource, /agent ·/);
});

test("Connected Folder identity and typography keep the restrained defaults", () => {
  const defaultIconBody = functionBody(connectedFolderIdentitySource, "defaultConnectedFolderIconName");
  assert.match(defaultIconBody, /^\s*return\s+["']folder["'];?\s*$/);
  assert.doesNotMatch(defaultIconBody, /notebook/i);

  const heavyWeightMatch = foundationCss.match(/--amplefile-font-weight-heavy:\s*(\d+)\s*;/);
  assert.ok(heavyWeightMatch, "professional foundation must declare the heavy-weight token");
  assert.equal(Number(heavyWeightMatch[1]), 700);

  const numericWeights = [
    Number(heavyWeightMatch[1]),
    ...[...foundationCss.matchAll(/font-weight:\s*(\d+)\s*;/g)].map((match) => Number(match[1])),
  ];
  assert.ok(numericWeights.every((weight) => weight <= 700), `foundation contains a weight above 700: ${numericWeights.join(", ")}`);
});

test("every referenced elevation and radius token is defined", () => {
  // A var() whose token is undefined is a silent no-op declaration — the
  // rail add menu and the needs-you flyout shipped shadowless, and the
  // capability dialog shipped square-cornered, exactly this way — so every
  // referenced --ui-shadow-* token must resolve in the light root and again
  // in the dark override, and every referenced --ui-radius-* token must
  // resolve in the root (radii are theme-invariant, so the dark override
  // never redefines them).
  const sheets = [foundationCss, shellCss, legacyCss, surfacesCss, customizationCss];
  const referencedShadows = new Set<string>();
  const referencedRadii = new Set<string>();
  for (const css of sheets) {
    for (const match of css.matchAll(/var\((--ui-shadow-[a-z-]+)[,)]/g)) referencedShadows.add(match[1]!);
    for (const match of css.matchAll(/var\((--ui-radius-[a-z-]+)[,)]/g)) referencedRadii.add(match[1]!);
  }
  assert.ok(referencedShadows.has("--ui-shadow-lg"), "the elevated flyout shadow is in use");
  assert.ok(referencedRadii.has("--ui-radius-xl"), "the capability-dialog radius is in use");
  const lightBlock = cssRuleBody(foundationCss, ":root");
  const darkBlock = cssRuleBody(foundationCss, ':root[data-theme="dark"]');
  for (const token of referencedShadows) {
    assert.ok(lightBlock.includes(`${token}:`), `${token} must be defined in the light theme`);
    assert.ok(darkBlock.includes(`${token}:`), `${token} must be defined for the dark theme`);
  }
  for (const token of referencedRadii) {
    assert.ok(lightBlock.includes(`${token}:`), `${token} must be defined in the root theme block`);
  }
});

test("Connected Folder customization is visible, compact, and separate from structural chrome", () => {
  assert.match(connectedFolderChromeSource, /aria-label="Connected Folder color presets"/);
  assert.doesNotMatch(connectedFolderChromeSource, /connectedFolderLookOptions|Connected Folder color pairs/);
  assert.match(connectedFolderChromeSource, /function ConnectedFolderNameEditor/);
  assert.match(connectedFolderChromeSource, /<span>Name<\/span>/);
  assert.match(connectedFolderChromeSource, /finally\s*\{\s*setSaving\(false\);\s*\}/);
  assert.doesNotMatch(connectedFolderChromeSource, /Fine tune|Saved on this computer|Start with a balanced color pair|Shown in the Connected Folder menu and tabs/);
  assert.match(connectedFolderChromeSource, /const connectedFolderIconPageSize = 96/);
  assert.match(connectedFolderChromeSource, /className="connected-folder-icon-browser"/);
  assert.match(connectedFolderChromeSource, /aria-label="Previous Icon Page"/);
  assert.match(connectedFolderChromeSource, /aria-label="Next Icon Page"/);
  assert.match(connectedFolderChromeSource, /\}, \[connectedFolderId, identity\.iconName\]\);/);
  assert.doesNotMatch(connectedFolderChromeSource, /Browse all|Show recommended|\$\{connectedFolderIconOptions\.length\}/);
  assert.match(connectedFolderChromeSource, /onResetConnectedFolder/);

  assert.doesNotMatch(connectedFolderChromeSource, /connected-folder-identity-header-icon|connected-folder-appearance-preview-icon/);
  assert.doesNotMatch(customizationCss, /connected-folder-identity-header-icon|connected-folder-appearance-preview-icon/);
  assert.match(customizationCss, /\.professional-appearance-surface/);
  const colorPickerRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .connected-folder-color-picker");
  const colorWheelRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .connected-folder-color-wheel");
  assert.match(colorPickerRule, /min-height:\s*38px/);
  assert.match(colorPickerRule, /height:\s*auto/, "the custom color wheel must remain inside its control");
  assert.match(colorWheelRule, /width:\s*28px/);
  assert.match(legacyCss, /\.message\.user \.message-surface/, "the user bubble keeps its semantic style owner");
  assert.match(legacyCss, /\.message-time\s*\{[\s\S]*?color:\s*var\(--ui-text-muted\)/, "message footer metadata uses the neutral appearance role");
  assert.match(connectedFolderIdentitySource, /"--connected-folder-selection-accent":\s*identity\.color/, "transitional aliases must preserve the v1 accent until their consumers are assigned roles");
  assert.match(connectedFolderIdentitySource, /"--connected-folder-selection-border":\s*identity\.borderColor/);
  assert.match(connectedFolderIdentitySource, /"--connected-folder-selection-surface":\s*identity\.softColor/);
  assert.match(connectedFolderChromeSource, /parseConnectedFolderAppearanceProposal/, "the editor must import the shared bounded proposal");
  assert.match(connectedFolderChromeSource, /createConnectedFolderAppearanceProposal/, "the editor must export the shared bounded proposal");
  assert.doesNotMatch(
    appSource,
    /normalizeConnectedFolderCustomizations\(customizationsRef\.current,\s*new Set\(Connected Folders/,
    "temporarily missing or moved Connected Folders must keep their identity until an explicit removal",
  );

  assert.match(foundationCss, /--amplefile-ui-font:\s*var\(--amplefile-font-family/);
  assert.match(rendererMainSource, /windowMaterial === "mica" \|\| windowMaterial === "vibrancy"[\s\S]*?dataset\.windowMaterial = windowMaterial/, "window material must be applied before React's first paint");
  assert.match(rendererMainSource, /delete document\.documentElement\.dataset\.windowMaterial/, "solid-material sessions must clear stale material state");
  assert.doesNotMatch(appSource, /dataset\.windowMaterial/, "window material must not wait for a passive React effect");
  assert.match(foundationCss, /--amplefile-font-size:\s*15px/, "the canonical sheet supplies a fallback; the appearance resolver owns the selected size");
  assert.match(foundationCss, /\.composer textarea:focus-visible\s*\{[\s\S]*?outline:\s*0/, "the connected-folder-colored composer shell must own the visible focus treatment");
  assert.doesNotMatch(desktopSettingsSource, /from\s+["']lucide-react["']/, "Settings uses Fluent icons only");
  assert.doesNotMatch(desktopSettingsSource, /id: "apps"|SettingsAppsPane/, "Settings has no Apps page");
  assert.match(desktopSettingsSource, /from\s+["']@fluentui\/react-icons["']/);
});

test("the appearance preview mirrors the Connected Folder header rather than the active surface", () => {
  // Compact, Band and Cover lead with the icon tile; every layout shows the Connected Folder's own name.
  // The preview renders the header's own title component.
  assert.match(connectedFolderBannerPreviewSource, /connected-folder-appearance-preview-copy"><ConnectedFolderBannerTitle identity=\{identity\} name=\{name\} \/><\/span>/);
  assert.doesNotMatch(connectedFolderChromeSource, /connected-folder-appearance-preview-copy"><strong>Files<\/strong>/);
  assert.match(customizationCss, /\.connected-folder-appearance-preview\s*\{[\s\S]*?min-height:\s*112px;/);
});

async function readRenderer(relativePath: string): Promise<string> {
  return readFile(join(rendererRoot, relativePath), "utf8");
}

function functionBody(source: string, functionName: string): string {
  const match = source.match(new RegExp(`function\\s+${escapeRegExp(functionName)}\\s*\\([^)]*\\)\\s*:[^{]+\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `could not find ${functionName} function`);
  return match[1];
}

function staticClassTokens(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/className="([^"]+)"/g)]
      .flatMap((match) => match[1].split(/\s+/))
      .filter(Boolean),
  );
}

function hasClassSelector(css: string, className: string): boolean {
  return new RegExp(`\\.${escapeRegExp(className)}(?=\\s|[.#:>+~,{\\[]|\\))`).test(css);
}

function cssRuleBody(css: string, selector: string): string {
  const target = selector.replace(/\s*\{$/, "");
  const bodies: string[] = [];
  postcss.parse(css).walkRules((rule: { selector: string; nodes: Array<{ type: string; toString(): string }> }) => {
    if (postcss.list.comma(rule.selector).some((s: string) => s === target || (target !== ":root" && s.endsWith(" " + target)))) bodies.push(rule.nodes.filter((n) => n.type === "decl").map((n) => n.toString() + ";").join("\n"));
  });
  assert.ok(bodies.length, `could not find CSS selector: ${target}`);
  return bodies.reverse().join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("controls keep the arrow pointer like a desktop app; only links in Chat show the hand", async () => {
  const sheets = ["web-local/src/styles.css", "web-local/src/panels.css", "web-local/src/popover/popover.css", "web-local/src/components/chat/model-context-inspector.css", "web-local/src/components/chat/work-steps.css", "web-local/src/components/panes/included-tool-setup.css"];
  for (const sheet of sheets) {
    const root = postcss.parse(await readFile(join(process.cwd(), sheet), "utf8"));
    root.walkDecls("cursor", (declaration: { value: string; parent: { selector?: string } }) => {
      assert.notEqual(declaration.value, "not-allowed", `${sheet}: ${declaration.parent.selector} shows a web-style disabled cursor`);
      if (declaration.value !== "pointer") return;
      assert.match(declaration.parent.selector ?? "", /\.message-body [^,]*link/, `${sheet}: ${declaration.parent.selector} uses the hand pointer`);
    });
  }
});

test("text buttons have a visible shape at rest in light and dark", async () => {
  const css = await readFile(join(process.cwd(), "web-local/src/styles.css"), "utf8");
  assert.match(css, /:root \{\s*--ui-button-fill: #ffffff;\s*--ui-button-edge:/);
  assert.match(css, /:root\[data-theme="dark"\] \{\s*--ui-button-fill: color-mix\(in srgb, #ffffff 9%, var\(--ui-surface\)\);\s*--ui-button-edge: rgb\(255 255 255 \/ \.1\);/);
  assert.match(css, /\.ui-control:not\(\.ui-control--primary\):not\(\.ui-control--icon\),[\s\S]*?\.composer-command-menu > button\.composer-context-compact\s*\) \{\s*color: var\(--ui-text\);\s*background: var\(--ui-button-fill\);\s*border: 0;\s*box-shadow: inset 0 0 0 1px var\(--ui-button-edge\);/);
});
