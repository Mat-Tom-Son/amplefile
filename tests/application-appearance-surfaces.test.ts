import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { applicationAppearanceVariables, applicationPalettes, defaultApplicationAppearance } from "../src/shared/application-appearance.js";
import { accentIdentityFromHex, resolveConnectedFolderAppearance, wcagContrast } from "../src/shared/connected-folder-appearance.js";
import { findCssBrowser } from "./support/css-browser.js";

const desktopSheets = ["brand.css", "styles.css", "components/chat/work-steps.css", "application-appearance.css"];
const popoverSheets = ["brand.css", "components/file-manager/file-manager-tokens.css", "popover/popover.css", "popover/popover-document.css", "components/chat/work-steps.css", "application-appearance.css"];
// The panel's Chat as the file manager draws it: the app's sheets, then the file manager's tokens and rules.
const panelSheets = [...desktopSheets, "components/file-manager/file-manager-tokens.css", "components/file-manager/file-manager.css"];
const exec = promisify(execFile);

test("actual desktop and popover CSS honor appearance roles, reading, density and accessibility", { timeout: 60_000 }, async (t) => {
  const browser = await findCssBrowser();
  if (!browser) { t.skip("A Chromium binary is required for the real cascade test; set AMPLEFILE_CSS_BROWSER."); return; }
  const scratch = await mkdtemp(join(tmpdir(), "amplefile-appearance-css-"));
  try {
    const sheets = async (names: string[]) => (await Promise.all(names.map((name) => readFile(resolve("web-local/src", name), "utf8")))).join("\n");
    const desktopCss = await sheets(desktopSheets);
    const popoverCss = await sheets(popoverSheets);
    const panelCss = await sheets(panelSheets);
    const scenarios = Object.keys(applicationPalettes).flatMap((palette) => (["light", "dark"] as const).map((mode) => {
      const preferences = { ...defaultApplicationAppearance, palette: palette as keyof typeof applicationPalettes, mode, accent: "#f5e600", readingSize: 22, readingFont: "serif" as const, codeFont: "consolas" as const, textSize: "large" as const, density: "compact" as const, measure: "focused" as const, spacing: "relaxed" as const };
      const ground = applicationPalettes[preferences.palette];
      const identity = resolveConnectedFolderAppearance({ primary: accentIdentityFromHex("#953ea3"), grounds: {
        light: { mode: "light", surface: ground.light.surface, canvas: ground.light.canvas, softAlpha: 0.13 },
        dark: { mode: "dark", surface: ground.dark.surface, canvas: ground.dark.canvas, softAlpha: 0.13 },
      } })[mode];
      return { palette, mode, variables: applicationAppearanceVariables(preferences, mode, null, true), identity };
    }));
    const desktopBody = `<div class="app-shell"><div class="fm-chat"><section class="chat-panel"><div class="message-list"><article class="message assistant"><div class="message-body"><h2>Workshop plan</h2><p>Readable paragraphs wrap naturally.</p><p>A second paragraph.</p><div class="message-code-block"><pre><code>const budget = 1200;</code></pre></div></div></article><article class="message user"><div class="message-surface"><div class="message-body"><p>Please update the plan.</p></div></div><footer class="message-footer"><span class="message-footer-meta"><div class="message-actions"><button class="message-copy-button" aria-label="Copy message">Copy</button></div><time class="message-time">Today</time></span></footer></article></div><form class="composer"><div class="composer-input-shell"><textarea>Plan a workshop</textarea><button class="send-button">Send</button></div></form><section class="work-steps running open"><div class="work-steps-rows"><div class="work-steps-list"><div class="work-step tool complete">Read</div><div class="work-step tool running active">Reading</div></div></div></section></section></div><section class="settings-modal settings-window"><button class="settings-tab active">Appearance</button><button class="ui-control ui-control--primary">Save</button><button class="ui-control ui-control--primary">Install</button><div class="settings-field"><input value="Example"></div></section><form class="history-file-picker"><label>Compare a file <input placeholder="notes.txt"></label></form></div>`;
    const popoverBody = `<div class="popover"><header><button class="popover-new-chat">New Chat</button></header><button class="agent-chat-row">Workshop plan</button><div class="popover-transcript"><article class="popover-message assistant"><div class="popover-message-body"><p>Workshop ready.</p><pre><code>const budget = 1200;</code></pre></div></article><article class="popover-message user"><div class="popover-message-body">Plan a workshop</div></article></div><form class="composer"><textarea>My draft</textarea><button class="primary">Send</button></form><p class="error-line">Example error</p></div>`;
    // Attribute selectors have the same specificity as these pseudo-classes;
    // this makes each hover/focus cascade deterministic in headless Chromium.
    // Native pointer and keyboard behavior is checked in the dev app too.
    const chatStateCss = desktopCss.replaceAll(":hover", "[data-test-hover]").replaceAll(":active", "[data-test-pressed]").replaceAll(":focus-visible", "[data-test-focus-visible]").replaceAll(":focus-within", "[data-test-focus-within]") + "\n* { transition: none !important; animation: none !important; }";
    const emptyChat = '<div class="chat-empty-state"><strong>Ready when you are.</strong><span class="chat-empty-connected-folder"><svg></svg><span>Workshop</span></span></div>';
    // A person's message with a link in it, in the panel and in the popover.
    const panelBubbleBody = '<div class="app-shell layout-file-manager"><div class="fm-shell"><aside class="fm-panel"><div class="fm-chat"><section class="chat-panel is-in-panel"><div class="message-list"><article class="message user"><div class="message-surface"><div class="message-body"><p>Plan a workshop <a href="#">from these notes</a></p></div></div></article></div></section></div></aside></div></div>';
    const popoverBubbleBody = popoverBody.replace("Plan a workshop</div>", 'Plan a workshop <a href="#">from these notes</a></div>');
    assert.notEqual(popoverBubbleBody, popoverBody);
    const payload = { panelCss, panelBubbleBody, popoverBubbleBody, desktopCss, popoverCss, desktopBody: desktopBody.replace('<section class="chat-panel">','<section class="chat-panel">'+emptyChat), popoverBody, scenarios, chatStateCss };
    // A disposable, non-interactive browser evaluates the exact shipped CSS
    // cascade. It never loads app scripts, an account, or a personal profile.
    const html = `<!doctype html><meta charset="utf-8"><pre id="result">pending</pre><script>
      (async () => {
      const payload = ${JSON.stringify(payload).replace(/</g, "\\u003c")};
      const results = [];
      let frame;
      function fixture(css, body, scenario) {
        frame?.remove(); frame = document.createElement('iframe'); frame.style.cssText = 'width:1200px;height:900px'; document.body.append(frame);
        const doc = frame.contentDocument;
        const variables = Object.entries(scenario.variables).map(([key,value]) => key+':'+value).join(';');
        const attributes = 'data-platform="'+(scenario.platform ?? '')+'" data-theme="'+scenario.mode+'" data-appearance-palette="'+scenario.palette+'" data-appearance-messages="'+(scenario.messages ?? 'tinted')+'" data-appearance-chat-steps="'+(scenario.chatSteps ?? 'every')+'" data-appearance-contrast="more" data-appearance-motion="reduce" data-appearance-transparency="opaque" data-window-material="'+(scenario.material ?? 'vibrancy')+'" style="'+variables.replaceAll('"','&quot;')+';color-scheme:'+scenario.mode+'"';
        const names = {solid:'solid', 'on-accent-solid':'onSolid', 'soft-fill':'softFill', 'text-body':'textBody', 'text-ui':'textUi', 'border-state':'borderState', glyph:'glyph'};
        const identity = Object.entries(names).map(([key,role]) => (key === 'on-accent-solid' ? '--connected-folder-on-accent-solid' : '--connected-folder-accent-'+key)+':'+scenario.identity[role]).join(';');
        body = body.replace('class="app-shell"','class="app-shell" data-theme="'+scenario.mode+'" style="'+identity+'"');
        doc.open(); doc.write('<!doctype html><html '+attributes+'><head><style>'+css+'</style></head><body>'+body+'</body></html>'); doc.close();
        return selector => frame.contentWindow.getComputedStyle(doc.querySelector(selector));
      }
      function color(value) { const el = frame.contentDocument.createElement('i'); el.style.color = value; frame.contentDocument.body.append(el); const result = frame.contentWindow.getComputedStyle(el).color; el.remove(); return result; }
      for (const scenario of payload.scenarios) {
        const d = fixture(payload.desktopCss, payload.desktopBody, scenario);
        const expected = Object.fromEntries(Object.entries(scenario.variables).filter(([key]) => key.startsWith('--ui-')).map(([key,value]) => [key,color(value)]));
        const result = { name:scenario.palette+'/'+scenario.mode, expected, primary:[d('.ui-control--primary').backgroundColor,d('.ui-control--primary').color], professional:[d('.ui-control--primary').backgroundColor,d('.ui-control--primary').color],
          bodySize:d('body').fontSize, reading:[d('.message.assistant .message-body').fontSize,d('.message.assistant .message-body').fontFamily,d('.message.assistant .message-body').lineHeight], code:d('code').fontFamily,
          settingsRow:d('.settings-tab').minHeight, measure:d('.composer-input-shell').maxWidth, paragraph:d('.message-body p').marginBottom,
          surfaces:[d('body').backgroundColor], tinted:[d('.message.user .message-surface').backgroundColor,d('.message.user .message-body').color],
          expectedConnectedFolder:[color(scenario.identity.softFill),color(scenario.identity.glyph),color(scenario.identity.textBody)], motion:d('.message').animationDuration, timeOpacity:d('.message-time').opacity,
          steps:[d('.work-step.complete').display, d('.work-step.active').display] };
        const q = fixture(payload.chatStateCss, payload.desktopBody, scenario);
        const qa = frame.contentDocument;
        const box = (selector) => qa.querySelector(selector).getBoundingClientRect();
        const user = qa.querySelector('.message.user');
        const shell = qa.querySelector('.composer-input-shell');
        shell.setAttribute('data-test-focus-within','');
        qa.querySelector('.composer textarea').setAttribute('data-test-focus-visible','');
        result.design = { shellOutline:q('.composer-input-shell').outlineStyle, shellOutlineWidth:q('.composer-input-shell').outlineWidth, shellColor:q('.composer-input-shell').outlineColor, expectedShellColor:color(scenario.identity.borderState), textareaOutline:q('.composer textarea').outlineWidth,
          emptyColors:[q('.chat-empty-state strong').color,q('.chat-empty-connected-folder').color,q('.chat-empty-connected-folder svg').color], expectedEmptyColors:[color(scenario.variables['--ui-text']),color(scenario.identity.textUi),color(scenario.identity.glyph)],
          copyRight:box('.message.user .message-copy-button').right, bubbleRight:box('.message.user .message-surface').right,
          timeRight:box('.message.user .message-time').right, copyLeft:box('.message.user .message-copy-button').left,
          restTime:q('.message.user .message-time').opacity,
          historyField:[q('.history-file-picker input').backgroundColor,q('.history-file-picker input').borderTopWidth,q('.history-file-picker input').borderRadius], settingsField:[q('.settings-field input').backgroundColor,q('.settings-field input').borderTopWidth,q('.settings-field input').borderRadius] };
        qa.documentElement.setAttribute('data-appearance-contrast','system');
        result.design.regularTime=q('.message.user .message-time').opacity;
        user.setAttribute('data-test-hover','');
        result.design.hoverTime=q('.message.user .message-time').opacity;
        const spaciousScenario = { ...scenario, messages:'quiet', variables: { ...scenario.variables, '--amplefile-list-height':'38px', '--amplefile-list-padding':'7px' } };
        const quiet = fixture(payload.desktopCss, payload.desktopBody, spaciousScenario);
        result.quiet = [quiet('.message.user .message-surface').backgroundColor,quiet('.message.user .message-body').color];
        result.spacious = [quiet('.settings-tab').minHeight];
        const currentStep = fixture(payload.desktopCss, payload.desktopBody, { ...scenario, chatSteps:'current' });
        result.steps.push(currentStep('.work-step.complete').display, currentStep('.work-step.active').display);
        const p = fixture(payload.popoverCss, payload.popoverBody, scenario);
        result.popoverPrimary = [p('button.primary').backgroundColor,p('button.primary').color];
        result.popoverReading = [p('.popover-message-body').fontSize,p('.popover-message-body').fontFamily]; result.popoverCode = p('code').fontFamily;
        result.popoverRow = p('.agent-chat-row').minHeight; result.surfaces.push(p('body').backgroundColor);
        // A person's message is a soft accent tint under the popover's own text, and Reading Font: App Font is the font the popover is drawn in.
        result.popoverBubble = [p('.popover-message.user').backgroundColor, p('.popover-message.user').color, color(p('.popover').getPropertyValue('--fm-bubble')), color(p('.popover').getPropertyValue('--fm-text'))];
        frame.contentDocument.documentElement.setAttribute('data-appearance-reading-font','app');
        result.popoverAppFont = [p('.popover-message-body').fontFamily, p('.popover').fontFamily];
        frame.contentDocument.documentElement.setAttribute('data-amplefile-font','verdana');
        result.popoverAppFont.push(p('.popover-message-body').fontFamily, p('.popover').fontFamily);
        const popoverQuiet = fixture(payload.popoverCss, payload.popoverBody, spaciousScenario);
        result.quiet.push(popoverQuiet('.popover-message.user').backgroundColor,popoverQuiet('.popover-message.user').color);
        // In the popover a quiet message is the file manager's card, in the tokens the popover wears.
        result.popoverCard = ['--fm-card','--fm-text'].map((name) => color(popoverQuiet('.popover').getPropertyValue(name)));
        result.spacious.push(popoverQuiet('.agent-chat-row').minHeight);
        const feedbackBody = '<div class="app-shell"><button id="neutral" class="ui-control">Open</button><button id="primary" class="ui-control ui-control--primary">Save</button><button id="icon" class="ui-control ui-control--icon">Icon</button><button id="disabled" class="ui-control" disabled>Disabled</button><button id="danger" class="ui-control danger">Delete</button><button id="commands" class="composer-command-trigger">Commands</button><div class="context-menu"><button id="menu">Rename</button></div><button id="nameSave" class="connected-folder-name-save">Save</button><button id="upload" class="connected-folder-banner-upload-button">Upload</button><button id="modelTrigger" class="model-catalog-trigger">Model</button><button id="modelOption" class="model-catalog-option">Model option</button><div class="composer-menu"><button id="composerOption">Reasoning</button></div><button id="send" class="send-button">Send</button><div class="composer-command-menu"><button id="model">Model</button></div><button id="copy" class="message-copy-button">Copy</button><button id="included" class="capabilities-included-tile">Tool</button><button id="resource" class="capabilities-resource-card">Skill</button><button id="automation" class="automation-list-row">Automation</button><section class="settings-window"><button id="settingsTab" class="settings-tab">Appearance</button></section></div>';
        const feedback = fixture(payload.chatStateCss,feedbackBody,scenario);
        result.includedBoundary=[feedback('.capabilities-included-tile').borderTopWidth,feedback('.capabilities-included-tile').borderTopColor,color('var(--ui-border-strong)')];
        const feedbackDoc = frame.contentDocument;
        const targets = ['neutral','primary','icon','disabled','danger','commands','menu','nameSave','upload','modelTrigger','modelOption','composerOption','send','model','copy','included','resource','automation','settingsTab'];
        result.feedback = targets.map(id=>{
          const el=feedbackDoc.getElementById(id), selector='#'+id;
          const sample=()=>{const c=feedback(selector),r=el.getBoundingClientRect();return {background:c.backgroundColor,color:c.color,outline:c.outlineStyle,shadow:c.boxShadow,transform:c.transform,width:r.width,height:r.height};};
          const rest=sample(); el.setAttribute('data-test-hover',''); const hover=sample();
          el.setAttribute('data-test-pressed',''); const pressed=sample(); el.removeAttribute('data-test-pressed'); el.removeAttribute('data-test-hover');
          const focusTarget=el.matches('button') ? el : el.querySelector('button,input') ?? el;
          focusTarget.setAttribute('data-test-focus-visible',''); el.setAttribute('data-test-focus-within','');
          const focus=sample(); if(focus.outline==='none') focus.outline=frame.contentWindow.getComputedStyle(focusTarget).outlineStyle;
          focusTarget.removeAttribute('data-test-focus-visible'); el.removeAttribute('data-test-focus-within');
          return {id,rest,hover,pressed,focus};
        });
        result.floating = ['.composer-mention-menu','.composer-menu','.model-catalog-popover'].map(selector=>{ const el=feedbackDoc.createElement('div');el.className=selector.slice(1); feedbackDoc.querySelector('.app-shell').append(el);const c=feedback(selector);return {selector,background:c.backgroundColor,shadow:c.boxShadow}; });
        result.settingsFrames = ['ai-models-scope-control','ai-models-connection-panel'].map(name=>{ const window=feedbackDoc.createElement('section');window.className='settings-window';const el=feedbackDoc.createElement(name==='ai-models-scope-control'?'fieldset':'div');el.className=name;window.append(el);feedbackDoc.querySelector('.app-shell').append(window);return feedback('.'+name).borderTopWidth; });
        result.feedbackExpected = {hover:color('var(--ui-surface-hover)'),pressed:color('var(--ui-control-pressed)'),primaryHover:color('var(--ui-primary-hover)'),primaryPressed:color('var(--ui-primary-pressed)'),danger:color('var(--ui-danger)'),sendHover:color('color-mix(in srgb,'+scenario.identity.solid+' 28%,var(--ui-surface))'),sendPressed:color('color-mix(in srgb,'+scenario.identity.solid+' 38%,var(--ui-surface))')};
        // Text and links on a person's tinted message, measured over the real ground:
        // the tint is translucent, so each color is composited down to the first opaque layer.
        const rgba = (value) => { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d'); x.clearRect(0,0,1,1); x.fillStyle = value; x.fillRect(0,0,1,1); const d = x.getImageData(0,0,1,1).data; return [d[0],d[1],d[2],d[3]/255]; };
        const over = (top, under) => [0,1,2].map(i => top[i]*top[3] + under[i]*(1-top[3])).concat(1);
        const luminance = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4; }; return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2]); };
        const contrastOf = (el) => { const style = (node) => frame.contentWindow.getComputedStyle(node); const layers = []; for (let node = el; node; node = node.parentElement) { const c = rgba(style(node).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] === 1) break; }
          let ground = [255,255,255,1]; for (const layer of layers.reverse()) ground = over(layer, ground); const ink = over(rgba(style(el).color), ground); const a = luminance(ink), b = luminance(ground); return Math.round(((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05))*100)/100; };
        const bubble = (css, body, text, link, attributes) => { fixture(css, body, scenario); const doc = frame.contentDocument; for (const [name, value] of Object.entries(attributes)) doc.documentElement.setAttribute(name, value); return [contrastOf(doc.querySelector(text)), contrastOf(doc.querySelector(link))]; };
        const panelText = '.message.user .message-body p', panelLink = '.message.user .message-body a', popoverText = '.popover-message.user .popover-message-body', popoverLink = '.popover-message.user a';
        // The popover is measured without Opaque Surfaces, over the grey that stands in for its window material in a preview.
        result.bubbleContrast = {
          'panel': bubble(payload.panelCss, payload.panelBubbleBody, panelText, panelLink, {}),
          'panel, chosen accent': bubble(payload.panelCss, payload.panelBubbleBody, panelText, panelLink, {'data-appearance-accent':'custom'}),
          'popover': bubble(payload.popoverCss, payload.popoverBubbleBody, popoverText, popoverLink, {'data-appearance-transparency':'system','data-preview-window':'mac'}),
          'popover, chosen accent': bubble(payload.popoverCss, payload.popoverBubbleBody, popoverText, popoverLink, {'data-appearance-transparency':'system','data-preview-window':'mac','data-appearance-accent':'custom'}),
        };
        results.push(result);
      }
      document.body.innerHTML = '<pre id="result"></pre>'; document.getElementById('result').textContent = JSON.stringify(results);
      })().catch(error => { document.body.innerHTML = '<pre id="result"></pre>'; document.getElementById('result').textContent = JSON.stringify({error:String(error),stack:error.stack}); });
    </script>`;
    const path = join(scratch, "fixture.html");
    await writeFile(path, html);
    const { stdout } = await exec(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--use-mock-keychain", "--password-store=basic", "--virtual-time-budget=1000", "--disable-features=HangWatcher", `--user-data-dir=${join(scratch, "profile")}`, "--dump-dom", pathToFileURL(path).href], { timeout: 35_000, maxBuffer: 5_000_000 });
    const serialized = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
    assert.ok(serialized && serialized !== "pending", "browser must finish the actual CSS fixture");
    const results = JSON.parse(serialized.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(results.length, 10);
    for (const item of results) {
      const expected = item.expected;
      for (const actual of [item.primary, item.professional]) assert.deepEqual(actual, [expected["--ui-accent-soft"], expected["--ui-accent"]], item.name + " desktop primary uses matched soft/text roles");
      assert.deepEqual(item.popoverPrimary, [expected["--ui-accent-solid"], expected["--ui-on-accent"]], item.name + " send uses matched solid/text roles");
      assert.equal(item.bodySize, "18px");
      assert.equal(item.reading[0], "22px"); assert.match(item.reading[1], /Georgia/); assert.equal(Number.parseFloat(item.reading[2]), 40.7);
      // The popover reads like the file manager's narrow panel Chat: two pixels under the chosen size.
      assert.equal(item.popoverReading[0], "20px"); assert.match(item.popoverReading[1], /Georgia/);
      assert.match(item.code, /Consolas/); assert.match(item.popoverCode, /Consolas/);
      assert.equal(item.settingsRow, "28px"); assert.equal(item.popoverRow, "28px");
      assert.equal(item.measure, "600px"); assert.equal(Number.parseFloat(item.paragraph), 26.4);
      assert.deepEqual(item.surfaces, [expected["--ui-canvas"], expected["--ui-canvas"]], item.name + " opaque covers native material");
      assert.deepEqual(item.tinted, [item.expectedConnectedFolder[0], item.expectedConnectedFolder[2]], item.name + " tint keeps Connected Folder identity");
      assert.deepEqual(item.quiet, [expected["--ui-surface-subtle"], expected["--ui-text"], ...item.popoverCard], item.name + " quiet messages");
      assert.deepEqual(item.popoverBubble.slice(0, 2), item.popoverBubble.slice(2), item.name + " tinted popover message is the accent tint under the popover's text");
      assert.equal(item.popoverAppFont[0], item.popoverAppFont[1], item.name + " Reading Font: App Font is the popover's own font");
      assert.equal(item.popoverAppFont[2], item.popoverAppFont[3], item.name + " and follows a chosen App Font");
      assert.notEqual(item.popoverAppFont[2], item.popoverAppFont[0]);
      for (const [surface, [text, link]] of Object.entries(item.bubbleContrast as Record<string, [number, number]>)) {
        assert.ok(text >= 4.5, `${item.name} ${surface}: text on a person's message is ${text}:1`);
        assert.ok(link >= 4.5, `${item.name} ${surface}: a link on a person's message is ${link}:1`);
      }
      assert.deepEqual(item.spacious, ["38px", "38px"]); assert.equal(item.motion, "1e-05s"); assert.equal(item.timeOpacity, "1");
      assert.deepEqual(item.steps, ["grid", "grid", "none", "grid"], item.name + " current-step view hides finished rows while running");
      assert.equal(item.design.shellOutline, "solid", item.name + " whole composer owns focus");
      assert.equal(item.design.shellColor, item.design.expectedShellColor, item.name + " composer focus uses its owning folder, independently of the application accent");
      assert.deepEqual(item.design.emptyColors, item.design.expectedEmptyColors, item.name + " empty chat keeps palette text and owning folder identity");
      assert.equal(item.includedBoundary[0], "1px"); assert.equal(item.includedBoundary[1], item.includedBoundary[2], item.name + " included tools keep a visible palette border");
      assert.equal(item.design.shellOutlineWidth, "2px"); assert.equal(item.design.textareaOutline, "0px");
      assert.ok(Math.abs(item.design.copyRight - item.design.bubbleRight) <= 1, item.name + " copy aligns with the user bubble right edge");
      assert.ok(item.design.timeRight <= item.design.copyLeft - 7, item.name + " timestamp appears left of copy");
      assert.equal(item.design.restTime, "1", item.name + " higher contrast preserves timestamps"); assert.equal(item.design.hoverTime, "1"); assert.equal(item.design.regularTime, "0");
      assert.deepEqual(item.design.historyField, item.design.settingsField, item.name + " History uses the shared field style");
      const neutralControls = new Set(['neutral','icon','commands','menu','nameSave','upload','modelTrigger','modelOption','composerOption','model','copy']);
      const neutralRows = new Set(['included','resource','automation','settingsTab']);
      for(const target of item.feedback) {
        const label=item.name+'/'+target.id;
        if(neutralControls.has(target.id)||neutralRows.has(target.id)) assert.equal(target.hover.background,item.feedbackExpected.hover,label+' receives the full demo hover fill');
        if(neutralControls.has(target.id)) assert.equal(target.pressed.background,item.feedbackExpected.pressed,label+' has a distinct pressed fill');
        if(target.id==='primary') {
          assert.equal(target.hover.background,item.feedbackExpected.primaryHover); assert.equal(target.pressed.background,item.feedbackExpected.primaryPressed);
          assert.notEqual(target.rest.background,target.hover.background,label+' changes its fill instead of drawing a hover border');
          assert.equal(target.hover.shadow,'none');
        }
        if(target.id==='send') { assert.equal(target.hover.background,item.feedbackExpected.sendHover); assert.equal(target.pressed.background,item.feedbackExpected.sendPressed); assert.equal(target.hover.shadow,'none'); }
        if(target.id==='disabled') assert.equal(target.rest.background,target.hover.background,label+' never reacts while disabled');
        if(target.id==='danger') assert.equal(target.hover.color,item.feedbackExpected.danger,label+' retains its destructive intent');
        assert.deepEqual([target.hover.width,target.hover.height],[target.rest.width,target.rest.height],label+' keeps its hit area stable');
        if(target.id==='icon') assert.deepEqual([target.rest.width,target.rest.height],[30,30],label+' retains a square hit area');
        if(neutralControls.has(target.id)) assert.equal(target.hover.transform,'none',label+' never lifts or scales');
        if(target.id!=='disabled') assert.equal(target.focus.outline,'solid',label+' keeps keyboard focus distinct from hover');
      }
      assert.deepEqual(item.settingsFrames,Array(2).fill('0px'),item.name+' Settings uses spacing rather than retained frames');
      for(const floating of item.floating) { assert.equal(floating.background,expected['--ui-surface'],item.name+'/'+floating.selector+' is an opaque menu above content'); assert.notEqual(floating.shadow,'none'); }
      const hex = (rgb: string) => "#" + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      assert.ok(wcagContrast(hex(item.primary[0]), hex(item.primary[1])) >= 4.5, item.name + " actual button contrast");
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
