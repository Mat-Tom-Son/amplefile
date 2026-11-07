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
  surfaceTabsSource,
  chatPanelSource,
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
  readRenderer("hooks/useSurfaceTabs.ts"),
  readRenderer("components/chat/ChatPanel.tsx"),
]);

test("Files is the first primary surface and Connected Folder actions live in the persistent header menu", () => {
  const primaryItems = constArrayBody(connectedFolderChromeSource, "primaryItems");
  const primaryModes = [...primaryItems.matchAll(/mode:\s*"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(primaryModes, ["files", "chats", "history"]);
  assert.doesNotMatch(primaryItems, /mode:\s*"connected-folders"/);
  assert.doesNotMatch(primaryItems, /mode:\s*"library"/, "Library belongs in the Connected Folder–owned tab canvas, not the permanent rail");
  assert.doesNotMatch(primaryItems, /mode:\s*"capabilities"/, "infrequent tool administration must not occupy the primary rail");

  assert.doesNotMatch(connectedFolderChromeSource, /connected-folder-rail-connected-folder-selector|connected-folder-rail-connected-folder-copy/);
  assert.match(connectedFolderChromeSource, /primaryItems\.map/);
  assert.match(connectedFolderChromeSource, /<span>Connect Folder<\/span>/);
  assert.match(connectedFolderChromeSource, /<span>New Connected Folder<\/span>/);
  assert.match(connectedFolderChromeSource, /<span>Manage Connected Folders<\/span>/);
  assert.match(connectedFolderChromeSource, /aria-current=\{shownMode === item\.mode \? "page" : undefined\}/, "the active icon-only destination must be announced");
  assert.match(connectedFolderChromeSource, /aria-label=\{item\.ariaLabel\}/, "icon-only destinations need accessible names");
  assert.doesNotMatch(connectedFolderChromeSource, /<span>connected-folder<\/span>|connected-folder-rail-connected-folder-caret/);
  assert.doesNotMatch(primaryItems, /ChevronRight20Regular/);
});

test("pane navigation uses Fluent icons with the requested Blocks icon for Skills & Extensions", () => {
  for (const [name, source] of [
    ["connectedFolderChrome.tsx", connectedFolderChromeSource],
    ["connectedFolderPanes.tsx", connectedFolderPanesSource],
  ] as const) {
    const navigationSource = name === "connectedFolderChrome.tsx" ? source.replace('import { Blocks } from "lucide-react";', "") : source;
    assert.doesNotMatch(navigationSource, /from\s+["']lucide-react["']/, `${name} must keep the Blocks exception limited to Skills & Extensions`);
    assert.match(source, /from\s+["']@fluentui\/react-icons["']/, `${name} must use Fluent icons`);
  }

  const requiredNavPairs = [
    "DocumentFolder24",
    "ChatMultiple24",
    "History24",
  ];
  for (const icon of requiredNavPairs) {
    assert.match(connectedFolderChromeSource, new RegExp(`\\b${icon}Regular\\b`), `${icon} needs a regular state`);
    assert.match(connectedFolderChromeSource, new RegExp(`\\b${icon}Filled\\b`), `${icon} needs a filled active state`);
  }

  assert.match(connectedFolderChromeSource, /professional-connected-folder-rail/);
  assert.match(connectedFolderChromeSource, /<Blocks size=\{24\} strokeWidth=\{1\.5\} aria-hidden="true" \/>/);
  // The Add button opens the Skills & Extensions popup directly; there is no Add menu (2026-09-25).
  assert.match(connectedFolderChromeSource, /aria-label="Skills & Extensions"/);
  assert.match(connectedFolderChromeSource, /onClick=\{\(\) => onOpenSkillsExtensions\("installed"\)\}/);
  assert.doesNotMatch(connectedFolderChromeSource, /id="connected-folder-add-menu"|chooseAddAction|onOpenLibrary|onOpenApps/);
  assert.doesNotMatch(connectedFolderChromeSource, /aria-label="agent"/);
  assert.doesNotMatch(connectedFolderChromeSource, /mode:\s*"setup"/);
  assert.doesNotMatch(connectedFolderChromeSource, /<Bot\w*[^>]*>.*agent/s);
});

test("the Library is retired from the desktop (2026-09-25)", () => {
  const primaryItems = constArrayBody(connectedFolderChromeSource, "primaryItems");
  assert.doesNotMatch(primaryItems, /mode:\s*"library"/);
  assert.doesNotMatch(connectedFolderChromeSource, /Your Library|onOpenLibrary/);
  assert.doesNotMatch(appSource, /LibraryPane|openLibrary\(|libraryTree|migrateLegacyLibraryMode/);
  assert.doesNotMatch(connectedFolderPanesSource, /export function LibraryPane|From Library/);
  assert.doesNotMatch(surfaceTabsSource, /migrateLegacyLibrary|"library"/);
});

test("Skills & Extensions opens as a popup from the Add button, and apps are managed in Settings", () => {
  const primaryItems = constArrayBody(connectedFolderChromeSource, "primaryItems");
  assert.doesNotMatch(primaryItems, /mode:\s*"capabilities"/);
  assert.doesNotMatch(primaryItems, /mode:\s*"skills"|mode:\s*"extensions"/);
  // The rail's Add button opens one popup: Skills & Extensions. Discovery and
  // management are the same place; apps are managed in Settings → Apps and
  // built by asking a Worker in a Chat, so nothing here seeds a Chat.
  assert.doesNotMatch(connectedFolderChromeSource, /Browse Skills &amp; Extensions|Manage agent tools|Build an app|Your Library|<strong>Apps<\/strong>/);
  assert.match(appSource, /skillsExtensionsView \? <SkillsExtensionsModal/);
  assert.match(appSource, /onOpenSkillsExtensions=\{setSkillsExtensionsView\}/);
  assert.doesNotMatch(appSource, /startAppBuildChat|onBuildApp=|<ConnectedFolderAppsPane|openConnectedFolderAppsSurfaceTab|openAssistantToolsSurfaceTab/);
  assert.match(appSource, /run: \(\) => onOpenSettings\("apps"\)/);
  assert.match(chatPanelSource, /textarea\.setSelectionRange\(end, end\)/);
  assert.doesNotMatch(surfaceTabsSource, /"assistant-tools"|"connected-folder-apps"|"library"/);
  assert.match(capabilitiesSource, /<h1>Skills &amp; Extensions<\/h1>/);
  // Where a tool lives is one explicit decision in the review step, shown as
  // the AmpleFile agent above folders hierarchy rather than a bare Personal/This folder toggle.
  assert.match(capabilitiesSource, /Where should it live\?/);
  assert.match(capabilitiesSource, /function ScopeHierarchyGlyph/);
  assert.match(capabilitiesSource, /"AmpleFile agent"[\s\S]*"Here"/);
  assert.match(capabilitiesSource, /"Everywhere"[\s\S]*This Connected Folder only/);
  assert.doesNotMatch(capabilitiesSource, /Personal · everywhere|"Personal"/);
  // Discover is text-only; installed rows use a neutral type glyph.
  assert.doesNotMatch(capabilitiesSource, /CapabilityMonogram|monogramHue|Bookmark16Regular/);
  assert.match(capabilitiesSource, /capabilities-kind-icon/);
  assert.match(capabilitiesSource, /label="View Source" icon=\{false\}/);
  assert.match(capabilitiesSource, /function GitHubMark/);
  assert.doesNotMatch(capabilitiesSource, />Review<\/button>|Install…/);
  assert.doesNotMatch(capabilitiesSource, /Installation location|Install to</);
  assert.match(appSource, /setSkillsExtensionsView\("installed"\)/);
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
  // Sandboxed apps are a different lane with their own authority model: they
  // live in the Connected Folder–owned Apps tab, never inside Skills & Extensions.
  assert.doesNotMatch(capabilitiesSource, /RestrictedAppsSection|restrictedApps|"Apps"/);
  assert.match(appSource, /id: "go:connected-folder-apps"/);
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
  assert.match(appSource, /onOpenSettings\("ai-models", "connected-folder", true, targetConnectedFolder\.id\)/);
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

test("every used P0 pane class has a CSS selector", () => {
  const p0Classes = [
    "ai-models-settings-section",
    "ai-models-scope-control",
    "ai-models-refresh",
    "ai-models-form-fields",
    "security-note",
    "trust-banner",
    "install-panel",
    "scope-toggle",
    "package-input",
    "card-grid",
    "resource-card",
    "empty-state",
    "tool-details",
    "tool-list",
    "loading-row",
    "inline-error",
    "diagnostics",
    "history-list",
    "history-pane-actions",
    "chat-connected-folder-heading",
    "professional-surface",
    "professional-card",
    "ui-control",
    "professional-field",
    "professional-notice",
    "professional-install-panel",
    "professional-card-grid",
    "professional-empty-state",
  ];
  const staticClasses = staticClassTokens(connectedFolderPanesSource);
  const combinedCss = stripCssComments(`${legacyCss}\n${surfacesCss}`);
  const usedP0Classes = p0Classes.filter((className) => staticClasses.has(className));
  const missingSelectors = usedP0Classes.filter((className) => !hasClassSelector(combinedCss, className));

  assert.ok(usedP0Classes.length > 0, "the P0 contract must cover classes used by spacePanes");
  assert.deepEqual(missingSelectors, [], `P0 classes without CSS selectors: ${missingSelectors.join(", ")}`);
});

test("professional shell keeps compact navigation and the persistent Connected Folder identity header", () => {
  const layoutRule = cssRuleBody(shellCss, ".app-shell .connected-folder-layout");
  const modePaneRule = cssRuleBody(shellCss, ".app-shell .connected-folder-mode-pane");
  const railRule = cssRuleBody(shellCss, ".app-shell .professional-connected-folder-rail");
  const navButtonRule = cssRuleBody(shellCss, ".app-shell .professional-connected-folder-rail .connected-folder-rail-button");
  const compactShellCss = shellCss.slice(shellCss.indexOf("@media (max-width: 820px)"));
  const compactRailRule = cssRuleBody(compactShellCss, ".app-shell .professional-connected-folder-rail");
  const compactNavRule = cssRuleBody(compactShellCss, ".app-shell .professional-connected-folder-rail .connected-folder-rail-nav");
  const compactAccountRule = cssRuleBody(compactShellCss, ".app-shell .professional-connected-folder-rail .connected-folder-rail-account");
  const shortDesktopShellCss = shellCss.slice(shellCss.indexOf("@media (max-height: 720px)"));
  const shortDesktopRailRule = cssRuleBody(shortDesktopShellCss, ".app-shell .professional-connected-folder-rail");
  const paneHeaderRule = cssRuleBody(shellCss, ".app-shell .connected-folder-layout .connected-folder-mode-pane .professional-pane-header");
  const connectedFoldersPaneRule = cssRuleBody(surfacesCss, ".connected-folder-pane-content.professional-connected-folders");

  assert.match(modePaneRule, /border:\s*0/);
  assert.match(railRule, /border:\s*0/);
  assert.match(paneHeaderRule, /border:\s*0/);
  assert.match(paneHeaderRule, /background:\s*var\(--ui-surface\)/);
  for (const structuralRule of [modePaneRule, railRule, paneHeaderRule]) {
    assert.doesNotMatch(structuralRule, /--connected-folder-(?:selection|custom)-/, "structural borders must stay independent of Connected Folder accent colors");
  }

  assert.ok(maxPxValue(customPropertyValue(layoutRule, "--connected-folder-rail-width")) <= 180, "desktop rail must remain compact");
  assert.equal(maxPxValue(customPropertyValue(layoutRule, "--connected-folder-identity-header-height")), 112, "the Connected Folder banner retains the approved personality and geometry");
  assert.ok(pxDeclaration(navButtonRule, "min-height") <= 48, "primary navigation targets must stay compact");
  assert.equal(pxDeclaration(navButtonRule, "width"), pxDeclaration(navButtonRule, "min-height"), "primary navigation uses square icon-only targets");
  assert.match(shellCss, /\.professional-connected-folder-rail \.connected-folder-rail-label\s*\{[\s\S]*?display:\s*none/, "the desktop rail is icon-only; labels live in tooltips and accessible names");
  assert.match(compactShellCss, /\.connected-folder-rail-label\s*\{[\s\S]*?display:\s*block/, "the narrow horizontal rail restores text labels");
  assert.doesNotMatch(`${shellCss}\n${customizationCss}`, /connected-folder-rail-connected-folder-selector|connected-folder-rail-connected-folder-copy|connected-folder-rail-connected-folder-avatar/);
  assert.match(layoutRule, /--connected-folder-identity-title-size:\s*17px/);
  assert.match(layoutRule, /--connected-folder-identity-tracking:\s*0\.01em/);
  assert.match(shortDesktopRailRule, /padding:\s*8px\s+6px\s+6px/, "short desktop layouts must keep navigation compact");
  assert.match(compactRailRule, /overflow:\s*hidden/, "the narrow rail must contain independent scroll regions");
  assert.match(compactNavRule, /flex:\s*1\s+1\s+auto/);
  assert.match(compactNavRule, /overflow-x:\s*auto/, "narrow primary destinations must scroll instead of colliding with tools");
  assert.match(compactAccountRule, /flex:\s*0\s+0\s+auto/, "Shortcuts and Settings must remain reachable while destinations scroll");
  assert.doesNotMatch(shellCss, /data-rail-tooltip/, "icon controls use accessible names without persistent hover labels");
  assert.match(connectedFoldersPaneRule, /scrollbar-gutter:\s*auto/, "the Connected Folders pane must not reserve a dead right-side gutter");
  assert.match(shellCss, /\.professional-connected-folder-rail \.connected-folder-rail-button svg,[\s\S]*?\{[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/);
});

test("Connected Folder customization is visible, compact, and separate from structural chrome", () => {
  assert.match(connectedFolderChromeSource, /"connected-folder-banner-surface"/);
  assert.match(connectedFolderChromeSource, /"connected-folder-identity-header"/);
  assert.match(connectedFolderChromeSource, /connected-folder-pane-banner-image/);
  assert.match(connectedFolderChromeSource, /connectedFolderIdentityStyle\(itemIdentity\)/);
  assert.match(connectedFolderChromeSource, /<ConnectedFolderIconGlyph icon=\{itemIdentity\.Icon\}/);
  assert.match(connectedFolderChromeSource, /data-connected-folder-icon=\{itemIdentity\.iconName\}/);
  assert.match(connectedFolderChromeSource, /<ConnectedFolderBannerPreview/);
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
  assert.match(customizationCss, /\.connected-folder-banner-surface\.banner-none/);

  const bannerHeaderRule = cssRuleBody(customizationCss, ".app-shell .connected-folder-layout .connected-folder-mode-pane .professional-pane-header.connected-folder-identity-header");
  const bannerTitleRule = cssRuleBody(customizationCss, ".app-shell .professional-pane-header.connected-folder-identity-header .connected-folder-pane-current-lockup strong");
  const previewTitleRule = cssRuleBody(customizationCss, ".connected-folder-appearance-preview-copy strong {");
  assert.doesNotMatch(bannerHeaderRule, /border:\s*1px/, "banner artwork has no decorative frame");
  assert.match(bannerTitleRule, /line-height:\s*1\.3/);
  assert.match(bannerTitleRule, /font-size:\s*var\(--connected-folder-identity-title-size\)/);
  assert.match(bannerTitleRule, /letter-spacing:\s*var\(--connected-folder-identity-tracking\)/, "the identity title should read as a deliberate display label without replacing the selected font");
  assert.match(previewTitleRule, /font-size:\s*var\(--connected-folder-identity-title-size\)/, "the appearance preview must match the live identity title scale");
  assert.match(previewTitleRule, /letter-spacing:\s*var\(--connected-folder-identity-tracking\)/);
  assert.match(bannerTitleRule, /padding-block:\s*2px/, "identity titles need descender-safe line boxes");
  assert.doesNotMatch(connectedFolderChromeSource, /connected-folder-identity-header-icon|connected-folder-appearance-preview-icon/);
  assert.doesNotMatch(customizationCss, /connected-folder-identity-header-icon|connected-folder-appearance-preview-icon/);
  assert.match(customizationCss, /\.professional-connected-folder-switcher \.connected-folder-header-switcher-icon[\s\S]*?color:\s*var\(--connected-folder-accent-glyph\)/);
  assert.match(customizationCss, /\.professional-appearance-surface/);
  assert.match(connectedFolderBannerPreviewSource, /bannerFraming/, "image framing remains part of the real banner preview");
  const colorPickerRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .connected-folder-color-picker");
  const colorWheelRule = cssRuleBody(customizationCss, ".app-shell .professional-appearance-surface .connected-folder-color-wheel");
  const colorPairClearRule = cssRuleBody(legacyCss, ".connected-folder-color-pair-clear");
  assert.match(colorPickerRule, /min-height:\s*38px/);
  assert.match(colorPickerRule, /height:\s*auto/, "the custom color wheel must remain inside its control");
  assert.match(colorWheelRule, /width:\s*28px/);
  assert.match(colorPairClearRule, /padding:\s*0/, "the paired-color clear icon must not overflow its control group");
  assert.match(connectedFolderChromeSource, /onInput=[\s\S]*?aria-label="Choose Second Banner Color"/);
  assert.match(customizationCss, /\.connected-folder-banner-surface\.banner-classic[\s\S]*?--connected-folder-banner-secondary-rgb/, "the second color must affect the default banner through its dedicated role");
  const activeRailMarkerRule = cssRuleBody(customizationCss, ".app-shell .professional-connected-folder-rail .connected-folder-rail-button.active::before");
  assert.match(activeRailMarkerRule, /background:\s*var\(--connected-folder-accent-indicator(?:,|\))/, "the contrast-solved indicator role must drive the compact active pill");
  assert.doesNotMatch(activeRailMarkerRule, /box-shadow/, "the active pill must not resurrect the legacy full-row shadow");
  assert.match(customizationCss, /\.professional-connected-folders \.connected-folder-card-shell\.active[\s\S]*?background:\s*var\(--connected-folder-accent-soft-fill\)/);
  assert.match(customizationCss, /\.professional-chats \.chat-connected-folder-heading > span:first-child[\s\S]*?color:\s*var\(--connected-folder-accent-glyph\)/);
  assert.match(legacyCss, /\.message\.user \.message-surface/, "the user bubble keeps its semantic style owner");
  assert.match(legacyCss, /\.message-time\s*\{[\s\S]*?color:\s*var\(--ui-text-muted\)/, "message footer metadata uses the neutral appearance role");
  assert.match(connectedFolderIdentitySource, /"--connected-folder-selection-accent":\s*identity\.color/, "transitional aliases must preserve the v1 accent until their consumers are assigned roles");
  assert.match(connectedFolderIdentitySource, /"--connected-folder-selection-border":\s*identity\.borderColor/);
  assert.match(connectedFolderIdentitySource, /"--connected-folder-selection-surface":\s*identity\.softColor/);
  assert.doesNotMatch(connectedFolderIdentitySource, /"--connected-folder-banner-(?:primary|base)":/, "unused banner string tokens must not be injected at every identity scope");
  assert.match(connectedFolderBannerPreviewSource, /\(\["light", "dark"\] as const\)\.map/, "the editor must preview both modes together");
  assert.match(customizationCss, /\.app-shell \.connected-folder-appearance-preview\.preview-light\s*\{[\s\S]*?--connected-folder-banner-base-rgb:\s*255,\s*255,\s*255/, "the light preview must beat the surrounding app theme");
  assert.match(customizationCss, /\.app-shell \.connected-folder-appearance-preview\.preview-dark\s*\{[\s\S]*?--connected-folder-banner-base-rgb:\s*23,\s*26,\s*33/, "the dark preview must beat the surrounding app theme");
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
  const settingsIconsSource = desktopSettingsSource.replace('import { LayoutPanelLeft } from "lucide-react";', "");
  assert.doesNotMatch(settingsIconsSource, /from\s+["']lucide-react["']/, "Settings keeps its icon exceptions limited to the requested controls");
  assert.match(desktopSettingsSource, /id: "apps", label: "Apps", icon: <LayoutPanelLeft size=\{20\} strokeWidth=\{1\.5\} aria-hidden="true" \/>/);
  assert.match(desktopSettingsSource, /from\s+["']@fluentui\/react-icons["']/);
});

test("Manage Connected Folders is a compact launcher into customization", () => {
  assert.doesNotMatch(connectedFolderPanesSource, /Where does this work live\?|Use an existing folder or create a clean one|professional-connected-folder-intro/);
  assert.doesNotMatch(connectedFolderPanesSource, /Turn it into a Connected Folder|Start with a clean folder|professional-connected-folder-action-copy/);
  assert.match(connectedFolderPanesSource, /className="professional-connected-folder-actions" aria-label="Add a Connected Folder"/);
  const actionRule = cssRuleBody(surfacesCss, ".professional-connected-folder-actions");
  assert.match(actionRule, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.doesNotMatch(surfacesCss.slice(surfacesCss.indexOf("@container space-pane (max-width: 520px)")), /\.professional-connected-folder-actions,[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(connectedFolderPanesSource, /onClick=\{\(\) => onCustomize\(item\)\}/);
  assert.doesNotMatch(appSource, /current === "Connected Folders" \? "files" : current/);
  assert.doesNotMatch(connectedFolderPanesSource, /connected-folder-card-rename|connected-folder-card-customize/);
  assert.match(connectedFolderPanesSource, /connected-folder-card-delete/);
  assert.match(connectedFolderPanesSource, /const deletesFolder = item\.location\.storage === "managed"/);
  assert.match(connectedFolderPanesSource, /aria-label=\{`\$\{deletesFolder \? "Delete" : "Remove"\} \$\{item\.name\}`\}/);
  assert.doesNotMatch(connectedFolderPanesSource, /"Managed [Ff]older"|"Linked [Ff]older"/);
  assert.match(connectedFolderPanesSource, /const location = item\.location\.storage === "managed" \? "" : shortFolderLocation\(item\.connectedFolderRoot\);/);
  assert.match(connectedFolderPanesSource, /<span title=\{item\.connectedFolderRoot \|\| undefined\}>/);
  assert.match(surfacesCss, /\.app-shell \.professional-connected-folders \.connected-folder-card-actions \.connected-folder-card-delete\s*\{[^}]*color:\s*var\(--ui-text-muted\)/);
  assert.doesNotMatch(legacyCss, /\.connected-folder-card-actions\s*\{[^}]*linear-gradient/s);
  assert.match(surfacesCss, /\.professional-connected-folders \.connected-folder-card-main\s*\{[^}]*padding-right:\s*52px/);
  assert.doesNotMatch(appSource, /Give this Connected Folder a recognizable identity|<h2>Customize \{targetConnectedFolder\.name\}<\/h2>/);
});

test("the left header is inherited Connected Folder identity on every mode, not a surface title", () => {
  const headerCall = appSource.match(/<ConnectedFolderPaneHeader[\s\S]*?\/>/)?.[0];
  assert.ok(headerCall, "App must render the shared Connected Folder identity header");
  const headerIdentityProps = headerCall.split(" action=")[0]!;
  assert.match(headerIdentityProps, /connectedFolder=\{connectedFolder\}/);
  assert.match(headerIdentityProps, /identity=\{identity\}/);
  assert.doesNotMatch(headerIdentityProps, /switchable=/, "the Connected Folder menu must remain available on management and custom surfaces");
  assert.doesNotMatch(headerIdentityProps, /title=|paneTitle|onCustomize/);

  assert.match(connectedFolderChromeSource, /<ConnectedFolderBannerTitle identity=\{identity\} name=\{connectedFolder\.name\} caret=\{switcherEnabled\} \/>/);
  assert.match(connectedFolderChromeSource, /<span className="sr-only">\{detail\}<\/span>/);
  assert.match(connectedFolderChromeSource, /className="connected-folder-pane-switch-trigger"/);
  assert.match(connectedFolderChromeSource, /aria-haspopup="menu"/);
  assert.match(connectedFolderChromeSource, /role="menu" aria-label="Connected Folder menu"/);
  assert.match(connectedFolderChromeSource, /role="menuitem"/);
  assert.match(connectedFolderChromeSource, /data-native-view-occluder="true"/);
  assert.match(connectedFolderChromeSource, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(connectedFolderChromeSource, /querySelector<HTMLButtonElement>\('\[role="menuitem"\]'\)\?\.focus\(\)/);
  assert.doesNotMatch(connectedFolderChromeSource, /role=\{switcherEnabled \? "button" : undefined\}/);
  assert.doesNotMatch(connectedFolderChromeSource, /onClick=\{toggleSwitcher\}[\s\S]{0,180}<ConnectedFolderIconGlyph/);
  assert.doesNotMatch(connectedFolderChromeSource, /connected-folder-identity-header-icon/);
  assert.doesNotMatch(connectedFolderChromeSource, /connected-folder-identity-header-text/);
  assert.doesNotMatch(connectedFolderChromeSource, /Customize Connected Folder.*professional-header-action/s);
});

test("every left-pane mode keeps content padding below the shared Connected Folder banner", () => {
  const headerIndex = appSource.indexOf("<ConnectedFolderPaneHeader");
  const filesContentIndex = appSource.indexOf('activeMode === "files" ? <div className="local-files-panel">');
  const localFilesRule = cssRuleBody(legacyCss, ".local-files-panel");

  assert.ok(headerIndex >= 0 && filesContentIndex > headerIndex, "the Files content wrapper must render below the shared header");
  assert.doesNotMatch(appSource, /activeMode === "files" \? "file-panel local-files-panel"/);
  assert.match(localFilesRule, /flex:\s*1 1 auto/);
  assert.match(localFilesRule, /padding:\s*12px/);
});

test("the appearance preview mirrors the Connected Folder header rather than the active surface", () => {
  // Compact, Band and Cover lead with the icon tile; every layout shows the Connected Folder's own name.
  // The preview renders the header's own title component (2026-11-05).
  assert.match(connectedFolderBannerPreviewSource, /connected-folder-appearance-preview-copy"><ConnectedFolderBannerTitle identity=\{identity\} name=\{name\} \/><\/span>/);
  assert.doesNotMatch(connectedFolderChromeSource, /connected-folder-appearance-preview-copy"><strong>Files<\/strong>/);
  assert.match(customizationCss, /\.connected-folder-appearance-preview\s*\{[\s\S]*?min-height:\s*112px;/);
});

async function readRenderer(relativePath: string): Promise<string> {
  return readFile(join(rendererRoot, relativePath), "utf8");
}

function constArrayBody(source: string, constName: string): string {
  const match = source.match(new RegExp(`const\\s+${escapeRegExp(constName)}[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\n\\s*\\];`));
  assert.ok(match, `could not find ${constName} array`);
  return match[1];
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

function customPropertyValue(ruleBody: string, property: string): string {
  const match = ruleBody.match(new RegExp(`${escapeRegExp(property)}:\\s*([^;]+);`));
  assert.ok(match, `could not find ${property}`);
  return match[1];
}

function maxPxValue(value: string): number {
  const values = [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  assert.ok(values.length > 0, `expected a pixel value in: ${value}`);
  return Math.max(...values);
}

function pxDeclaration(ruleBody: string, property: string): number {
  const match = ruleBody.match(new RegExp(`${escapeRegExp(property)}:\\s*(\\d+(?:\\.\\d+)?)px\\s*;`));
  assert.ok(match, `could not find pixel declaration ${property}`);
  return Number(match[1]);
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
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
  assert.match(css, /\.ui-control:not\(\.ui-control--primary\):not\(\.ui-control--icon\),[\s\S]*?\.checks-manual-button\s*\) \{\s*color: var\(--ui-text\);\s*background: var\(--ui-button-fill\);\s*border: 0;\s*box-shadow: inset 0 0 0 1px var\(--ui-button-edge\);/);
});
