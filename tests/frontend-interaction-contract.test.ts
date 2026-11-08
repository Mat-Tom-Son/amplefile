import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { nextDialogTabIndex } from "../web-local/src/hooks/useModalDialog.js";
import { resolveMessageImageSource } from "../web-local/src/lib/message-images.js";
import { nextMenuItemIndex } from "../web-local/src/lib/menu-navigation.js";
import { createConnectedFolderOperationGate } from "../web-local/src/lib/connected-folder-operation-gate.js";

const root = process.cwd();
const [capabilities, textInputModal, messages, connectedFolderChrome, indexHtml, app, _retiredNeedsYou, fileManager, ...desktopDialogs] = await Promise.all([
  read("web-local/src/components/panes/CapabilitiesPane.tsx"),
  read("web-local/src/components/modals/TextInputModal.tsx"),
  read("web-local/src/components/chat/messages.tsx"),
  read("web-local/src/components/panes/connectedFolderChrome.tsx"),
  read("web-local/index.html"),
  read("web-local/src/App.tsx"),
  Promise.resolve(""),
  read("web-local/src/components/file-manager/FileManagerView.tsx"),
  read("web-local/src/components/modals/DesktopSettingsModal.tsx"),
  read("web-local/src/components/modals/CreateConnectedFolderModal.tsx"),
  read("web-local/src/components/modals/FileVersionHistoryModal.tsx"),
]);

test("modal focus wrapping handles both boundaries and an escaped focus target", () => {
  assert.equal(nextDialogTabIndex(0, 3, true), 2);
  assert.equal(nextDialogTabIndex(2, 3, false), 0);
  assert.equal(nextDialogTabIndex(1, 3, false), null);
  assert.equal(nextDialogTabIndex(-1, 3, false), 0);
  assert.equal(nextDialogTabIndex(-1, 3, true), 2);
  assert.equal(nextDialogTabIndex(-1, 0, false), null);
});

// What the shared dialog contract actually does — focus entry and containment,
// Tab wrapping, Escape handling, background isolation, and focus restoration —
// is asserted against a real DOM in renderer-modal-dialog.test.ts. Matching the
// hook's source here would pass whether or not that behaviour survives.
test("in-tree dialogs are wired to the shared dialog contract", () => {
  assert.equal((capabilities.match(/useModalDialog\(\{/g) ?? []).length, 3);
  assert.equal((capabilities.match(/ref=\{dialogRef\}\s+tabIndex=\{-1\}/g) ?? []).length, 3);
  assert.match(capabilities, /initialFocusRef:\s*cancelRef/);
  assert.match(textInputModal, /useModalDialog\(\{\s*onClose,\s*blocked:\s*saving,\s*initialFocusRef:\s*inputRef\s*\}\)/);
  assert.match(textInputModal, /ref=\{dialogRef\}\s+tabIndex=\{-1\}/);
  for (const dialog of desktopDialogs) {
    assert.match(dialog, /useModalDialog\(\{/);
    assert.match(dialog, /ref=\{dialogRef\}\s+tabIndex=\{-1\}/);
  }
});

test("Settings preserves save feedback", async () => {
  const settings = desktopDialogs[0] ?? "";
  // Credential visibility, removal, saves and stale responses are exercised
  // against the real form in ai-models-settings-ui.test.ts.
  const appearance = await read("web-local/src/components/modals/AppearanceSettingsPane.tsx");
  assert.match(appearance, /role="alert">\{appearance\.error\}/);
  assert.doesNotMatch(appearance, /appearance-settings-status-row|appearance\.notice/);
  assert.match(settings, /settings-close-button/);
  assert.match(settings, /setCloseToTrayNotice\("Saved"\)/);
});

test("Settings keeps older page ids landing on the tab that now holds their content", async () => {
  const { createRequire, registerHooks } = await import("node:module");
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:settings-page-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:settings-page-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (/\.(css|png|svg)(?:\?|$)/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  const { settingsTabForPage } = await import("../web-local/src/components/modals/DesktopSettingsModal.js");
  assets.deregister();
  assert.equal(settingsTabForPage("desktop"), "automations");
  assert.equal(settingsTabForPage("general"), "automations");
  assert.equal(settingsTabForPage("desktop", "automations"), "automations");
  assert.equal(settingsTabForPage("desktop", "limits"), "automations");
  assert.equal(settingsTabForPage("desktop", "deleted"), "recently-deleted");
  assert.equal(settingsTabForPage("general", "deleted"), "recently-deleted");
  for (const page of ["appearance", "ai-models", "automations", "apps", "recently-deleted", "shortcuts", "about"] as const) {
    assert.equal(settingsTabForPage(page), page);
  }
  const settings = desktopDialogs[0] ?? "";
  assert.doesNotMatch(settings, /label: "Desktop"/);
  assert.match(settings, /<AutomationsPane fixtureMode=\{fixtureMode\} \/>\s*<AmpleFileLimitsPane onOpenRecentlyDeleted=\{\(\) => setPage\("recently-deleted"\)\} fixtureMode=\{fixtureMode\} \/>/);
  assert.match(settings, /interfaceExtra=\{closeWindowControl\}/);
});

test("no surface offers an authority mode, a policy, or a decision card", () => {
  // docs/receipts-not-gates.md, F19/F24: the Settings → Automations pane has no
  // Authority selector and no Standing policies section; the main window has
  // no needs-you rail control; questions live inside their owning Chat.
  const settings = desktopDialogs[0] ?? "";
  assert.doesNotMatch(settings, /fold-authority|fold-policies|FoldAuthorityPane|FoldPoliciesPane|PolicyMatcherFields|"authority"/);
  assert.doesNotMatch(app, /NeedsYouRailControl|useNeedsYouDecisions|needsYouControl|\/api\/amplefile-agent\/decisions/);
});

test("the main window has no overview panel; the connected-folder-identity header carries no action and Files keeps its actions in the right-click menu", () => {
  // The server digest stays (the popover's GlanceSection is gone too); the
  // main-window "Since you last looked" panel is gone, so the renderer
  // neither fetches nor acknowledges the overview from the main window.
  assert.doesNotMatch(app, /OverviewHeaderControl|OverviewPanel|useOverview/);
  assert.doesNotMatch(app, /headerAction/);
  // 2026-10-01: the search box spans the toolbar; refresh, new folder, and
  // add files are right-click actions, and a background refresh never dims
  // the tree.
  assert.doesNotMatch(app, /refreshFilesButton|aria-label="Refresh files"|aria-label="Add files"/);
  assert.match(fileManager, /onRefresh=\{\(\) => void listing\.refresh\(\)\}/);
  assert.match(fileManager, /else if \(command === "refresh"\) await listing\.refresh\(\);/);
  assert.doesNotMatch(app, /refreshing-files/);
  assert.doesNotMatch(app, /primaryItems[\s\S]{0,400}overview/i);
});

test("the Connected Folder name editor labels its save while saving", () => {
  assert.match(connectedFolderChrome, /aria-label=\{saving \? "Saving Name" : undefined\}/);
});

test("Markdown image policy embeds only CSP-compatible sources and links remote HTTPS images", () => {
  const base = "https://amplefile.local/app";
  assert.deepEqual(resolveMessageImageSource("/api/assets/preview.png", base), {
    kind: "embed",
    src: "https://amplefile.local/api/assets/preview.png",
  });
  assert.deepEqual(resolveMessageImageSource("data:image/png;base64,AA==", base), {
    kind: "embed",
    src: "data:image/png;base64,AA==",
  });
  assert.deepEqual(resolveMessageImageSource("https://images.example/preview.png", base), {
    kind: "external-link",
    href: "https://images.example/preview.png",
  });
  assert.deepEqual(resolveMessageImageSource("http://images.example/preview.png", base), { kind: "blocked" });
  assert.deepEqual(resolveMessageImageSource("docs/preview.png", base), { kind: "blocked" });
  assert.deepEqual(resolveMessageImageSource("data:image/svg+xml;base64,AA==", base), { kind: "blocked" });

  assert.match(messages, /resolution\.kind === "embed"[\s\S]*?<img className="message-image"/);
  assert.match(messages, /resolution\.kind === "external-link"[\s\S]*?message-image-external/);
  assert.match(messages, /message-image-unavailable/);
  assert.match(indexHtml, /img-src 'self' data: blob:/);
  assert.doesNotMatch(indexHtml, /img-src[^;]*https:/);
  assert.doesNotMatch(indexHtml, /frame-ancestors/, "frame-ancestors is ignored in a meta CSP and should not create console noise");
  assert.match(indexHtml, /<link rel="icon" href="data:image\/png;base64,/);
});

test("Connected Folder operation tokens reject stale completions even after switching back", () => {
  const gate = createConnectedFolderOperationGate("connected-folder-a");
  const firstA = gate.capture();
  assert.equal(gate.isCurrent(firstA), true);
  gate.activate("connected-folder-b");
  assert.equal(gate.isCurrent(firstA), false);
  const currentB = gate.capture();
  gate.activate("connected-folder-a");
  assert.equal(gate.isCurrent(firstA), false);
  assert.equal(gate.isCurrent(currentB), false);
  assert.equal(gate.isCurrent(gate.capture()), true);

  assert.match(capabilities, /operationGateRef\.current\.activate\(connectedFolder\.id\)/);
  assert.match(capabilities, /loadCatalog\(operation:\s*ConnectedFolderOperationToken/);
  for (const functionName of ["reviewDiscoverItem", "installPending", "mutatePackage"]) {
    const body = functionBody(capabilities, functionName);
    assert.match(body, /operationGateRef\.current\.capture\(\)/, `${functionName} must capture the active Connected Folder generation`);
    assert.match(body, /operationGateRef\.current\.isCurrent\(operation\)/, `${functionName} must reject stale completion work`);
  }
});

test("menu roving keyboard navigation is deterministic", () => {
  assert.equal(nextMenuItemIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(nextMenuItemIndex(-1, 3, "ArrowUp"), 2);
  assert.equal(nextMenuItemIndex(2, 3, "ArrowDown"), 0);
  assert.equal(nextMenuItemIndex(0, 3, "ArrowUp"), 2);
  assert.equal(nextMenuItemIndex(1, 3, "Home"), 0);
  assert.equal(nextMenuItemIndex(1, 3, "End"), 2);
  assert.equal(nextMenuItemIndex(0, 0, "ArrowDown"), null);
});

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const nextFunction = source.indexOf("\n  async function ", start + 1);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

 test("Keyboard Shortcuts shares Settings navigation and the rail has no shortcuts button", () => {
  assert.match(desktopDialogs[0] ?? "", /id: "shortcuts", label: "Shortcut Keys"/);
  assert.match(app, /openKeyboardShortcuts = useCallback\(\(\) => openSettings\("shortcuts"\)/);
  assert.doesNotMatch(connectedFolderChrome, /onOpenKeyboardShortcuts|<span>Shortcuts<\/span>/);
 });
