import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const root = process.cwd();
const [app, fileManager, chatPanel, messages, workTrail, activity, panes, settingsModal, styles, identity, modelDisplay, desktopMain, localServer, piClient, activityDot] = await Promise.all([
  read("web-local/src/App.tsx"),
  read("web-local/src/components/file-manager/FileManagerView.tsx"),
  read("web-local/src/components/chat/ChatPanel.tsx"),
  read("web-local/src/components/chat/messages.tsx"),
  read("web-local/src/lib/chat-work-trail.ts"),
  read("web-local/src/components/chat/activity.tsx"),
  Promise.all([read("web-local/src/components/panes/connectedFolderPanes.tsx"), read("web-local/src/components/panes/AiModelsPane.tsx")]).then((sources) => sources.join("\n")),
  read("web-local/src/components/modals/DesktopSettingsModal.tsx"),
  Promise.all([read("web-local/src/styles.css"), read("web-local/src/components/chat/work-steps.css")]).then((sources) => sources.join("\n")),
  read("web-local/src/lib/connected-folder-identity.ts"),
  read("web-local/src/lib/model-display.ts"),
  read("desktop/src/main.ts"),
  read("src/local/server.ts"),
  read("src/local/agent/pi-client.ts"),
  read("web-local/src/components/chrome/ActivityDot.tsx"),
]);

test("mid-turn Enter steers the running turn; ⌘Enter queues one visible, cancellable draft the app sends on settle", () => {
  // Plain Enter while a turn runs delivers the text through Pi's steering
  // queue (the agent reads it after its current step) and shows it as a
  // mid-turn user message; if the turn settles first (409) it becomes the
  // queued draft. ⌘/Ctrl+Enter holds the draft as a dashed queued bubble;
  // further Enters append; the queued draft fires through the ordinary send
  // path when the turn settles; Stop and the bubble's cancel return it to the
  // composer ahead of any newer text. Since 2026-10-27 the app holds the
  // queued draft (every window shows it and the app sends it when the turn
  // ends, never after a Stop); a window holds it only while its own turn has
  // not been accepted yet.
  assert.match(chatPanel, /void steerMessage\(content\);/);
  assert.match(chatPanel, /body: \{ content, delivery: "steer", requestId, userMessageId \}/);
  assert.match(chatPanel, /caught instanceof ApiError && caught\.status === 409/);
  assert.match(chatPanel, /event\.metaKey \|\| event\.ctrlKey \|\| pendingSendRef\.current \|\| fixtureMode/);
  assert.match(localServer, /body\.delivery === "steer"/);
  assert.match(localServer, /await client\.steer\(input\.content\);/);
  assert.match(chatPanel, /const next = queueSync\.append\(content\);/);
  assert.match(chatPanel, /if \(queueSync\.applyEvent\(data\)\) publishQueue\(\);/);
  assert.match(chatPanel, /\/queue`, \{\s*method: "PUT",/);
  // Cancel is ordered after any queue write still in flight, so a late write
  // cannot re-queue a cancelled message, and its echo is ignored meanwhile.
  assert.match(chatPanel, /const cancel = queueWritesRef\.current\.catch\(\(\) => undefined\)\s*\.then\(\(\) => api<\{ revision: number \}>\(path, \{ method: "DELETE" \}\)\);/);
  assert.match(chatPanel, /const \{ content, needsDelete \} = queueSync\.cancel\(\);/);
  assert.match(chatPanel, /addressedConnectedFolderIds: addressedFolderIds\(next, mentionFolders\)/);
  assert.match(chatPanel, /if \(data\.type === "queued_message"\)/);
  // A window never sends the message itself while its own queue writes or Cancel are unanswered.
  assert.match(chatPanel, /if \(running \|\| workState\.work\?\.canStop \|\| !queuedSend \|\| queuedOnServer \|\| queueUnsettled \|\| lifecycleView !== "active"\) return;/);
  // A Stop from any surface holds the queued message; only an unheld one is sent.
  assert.match(localServer, /if \(queued && settledStatus === "aborted"\) \{[\s\S]{0,200}held: true/);
  assert.match(localServer, /\} else if \(queued && !queued\.held\) void sendQueuedMessage/);
  assert.match(chatPanel, /className="queued-send-row"/);
  assert.match(chatPanel, /aria-label="Cancel Queued Message"/);
  assert.match(chatPanel, /returnQueuedSendToComposer\(\);\s*\n\s*if \(pendingSendRef\.current\)/);
  assert.match(styles, /\.queued-send-bubble \{/);
});

test("file previews and raw files go through connected-folder-policy routes", () => {
  // The preview endpoint reads a bounded head under the same path policy as
  // every entry route, declines binary and oversized content with a reason,
  // and images ride the existing same-origin raw-file route.
  assert.match(localServer, /file-preview\$\//);
  assert.match(localServer, /getConnectedFolderFilePreview\(connectedFolder\.connectedFolderRoot, path\)/);
  return readFileSyncLike("web-local/src/lib/raw-file.ts").then((source) => {
    // A blob URL carries the session header and stays inside the renderer's
    // img-src/frame-src policy, which a direct local API URL would not.
    assert.match(source, /apiUrl\(`\/api\/connected-folders\/\$\{connectedFolderId\}\/raw-file\?path=/);
    assert.match(source, /getSessionHeaders/);
    assert.match(source, /URL\.createObjectURL/);
  });
});

function readFileSyncLike(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}

test("Files exposes folder creation and naming uses in-app UI", () => {
  // Connected Folder creation lives in the right-click menu (2026-10-01); Files has no toolbar buttons.
  assert.doesNotMatch(app, /aria-label="New [Ff]older"/);
  assert.match(fileManager, /onNewFolder=\{\(parent\) => requestNewFolder\(parent\)\}/);
  assert.match(fileManager, /else if \(command === "new-folder"\) requestNewFolder\(/);
  assert.doesNotMatch(app, /aria-label="New file"|onNewFile=/i);
  assert.doesNotMatch(`${app}\n${panes}\n${fileManager}`, /window\.prompt\s*\(/);
  assert.match(fileManager, /<TextInputModal[^>]*title="Rename"/);
});

test("Chat turns report running and settled activity without interrupting active turns", () => {
  assert.match(localServer, /state\.runningTurns\.has\(key\)/);
  // One shared activity mark (2026-10-01) labels a Connected Folder's Chat activity wherever it shows.
  assert.match(activityDot, /status === "running" \? "Working" : "New Reply"/);
  assert.match(chatPanel, /onRunningChangeRef\.current/);
  assert.match(chatPanel, /reportChatSettled\(conversationId\)/);
});

test("Chat titles come from conversation metadata, never from a caller-supplied title", () => {
  assert.doesNotMatch(chatPanel, /targetConversationTitle/);
  assert.doesNotMatch(app, /targetConversationTitle=/);
});

test("Chat and File selection use an immediate whole-row state without a leading stripe", () => {
  const chatShellRule = styles.match(/\.chat-connected-folder-row-shell\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const activeChatRule = styles.match(/\.chat-connected-folder-row-shell\.active\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const selectedFileRule = styles.match(/\.file-row\.selected\s*\{([\s\S]*?)\}/)?.[1] ?? "";

  assert.doesNotMatch(chatShellRule, /transition:/);
  for (const rule of [activeChatRule, selectedFileRule]) {
    assert.match(styles, /\.chat-connected-folder-row-shell\.active[\s\S]*?connected-folder-accent-soft-fill/);
    assert.match(styles, /\.file-row\.selected[\s\S]*?connected-folder-accent-soft-fill/);
    assert.doesNotMatch(rule, /inset\s+[23]px\s+0\s+0/);
  }
  assert.match(styles, /\.chat-connected-folder-row-shell:has\(> \.chat-connected-folder-row:active\)/);
});

test("opening a past Chat never flashes the new-Chat greeting while its messages load", () => {
  assert.match(chatPanel, /const openingPastChat = !fixtureMode && Boolean\(targetConversationId\)\s*&& \(conversation\?\.id !== targetConversationId \|\| openingConversationId === targetConversationId\);/);
  assert.match(chatPanel, /\{!hasTranscript && !openingPastChat \? \(\s*<ChatEmptyState/);
  assert.match(chatPanel, /setOpeningConversationId\(selected\.id\);\s*let transcript: ChatMessage\[\];\s*try \{\s*transcript = await loadMessages\(selected\.id, true\);\s*\} finally \{\s*setOpeningConversationId\(\(current\) => current === selected\.id \? null : current\);/, "a failed load must not leave the Chat blank forever");
});

test("assistant rendering has complete Markdown chrome and Connected Folder–aware accents", () => {
  for (const contract of ["message-code-toolbar", "message-table-scroll", "message-image", "connected-folder-file-link"]) {
    assert.match(messages, new RegExp(contract));
    assert.match(styles, new RegExp(`\\.${contract}`));
  }
  const userRule = styles.match(/(?:^|\n)\.message\.user\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const userSurfaceRule = styles.match(/(?:^|\n)\.message\.user \.message-surface\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const darkUserRule = styles.match(/\.app-shell\[data-theme="dark"\] \.message\.user\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const darkUserSurfaceRule = styles.match(/\.app-shell\[data-theme="dark"\] \.message\.user \.message-surface\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  for (const rule of [userSurfaceRule, darkUserSurfaceRule]) {
    assert.match(
      rule,
      /background:\s*var\(--connected-folder-accent-solid,\s*var\(--connected-folder-custom-color,\s*var\(--amplefile-blue-600\)\)\)/,
    );
    assert.match(rule, /color:\s*var\(--connected-folder-on-accent-solid,\s*var\(--connected-folder-on-primary-accent/);
    assert.doesNotMatch(rule, /linear-gradient|connected-folder-selection-accent2/);
  }
  for (const rule of [userRule, darkUserRule]) {
    assert.match(rule, /background:\s*transparent/);
    assert.match(rule, /box-shadow:\s*none/);
  }
  assert.match(messages, /<div className="message-surface">[\s\S]*?<\/div>\s*<footer className="message-footer">/);
  assert.match(styles, /\.message\.assistant \.message-footer\s*\{[^}]*justify-content:\s*flex-start/);
  const userInlineCodeRule = styles.match(/(?:^|\n)\.message\.user \.message-body code\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const darkUserInlineCodeRule = styles.match(/\.app-shell\[data-theme="dark"\] \.message\.user \.message-body code\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  for (const rule of [userInlineCodeRule, darkUserInlineCodeRule]) {
    assert.match(rule, /background:\s*transparent/, "inline code must not reduce the audited on-accent text contrast");
    assert.match(rule, /color:\s*inherit/);
  }
  const darkFencedCodeRule = styles.match(/\.app-shell\[data-theme="dark"\] \.message-body \.message-code-block pre code\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(darkFencedCodeRule, /background:\s*transparent/, "dark fenced code must not inherit the inline-code highlight");
  assert.match(darkFencedCodeRule, /color:\s*inherit/);
  assert.match(chatPanel, /running \|\| requestBusy \? \(\s*<button className="send-button stop-send-button"/);
  assert.doesNotMatch(chatPanel, /chat-floating-actions|stop-chat-button/);
  assert.match(identity, /onPrimaryAccentColor:\s*readableTextColorOn\(colorOption\.color\)/);
  assert.match(identity, /"--connected-folder-on-primary-accent":\s*identity\.onPrimaryAccentColor/);
  assert.doesNotMatch(`${messages}\n${chatPanel}\n${styles}`, /message-avatar/);
  assert.doesNotMatch(activity, /Learned From/);
});

test("provider interruptions stay visible and the configured model is disclosed before first send", () => {
  assert.match(chatPanel, /ConfiguredModel/);
  assert.match(chatPanel, /\/api\/agent\/status\?connectedFolderId=/);
  assert.match(chatPanel, /\/api\/agent\/composer\?scope=connected-folder&connectedFolderId=/);
  assert.match(chatPanel, /setComposerState\(composerResult\.status === "fulfilled"/);
  assert.match(chatPanel, /loadMessages\(conversationId, false, \{ settleStreamingTurn: true \}\)/);
  assert.match(messages, /Response Interrupted/);
  assert.match(messages, /AmpleFile preserved/);
  assert.match(messages, /Worker setup needed/);
  assert.match(messages, /Request Stopped/);
  assert.match(messages, /savedWorkTrailPreviews\(message\)/);
  assert.match(workTrail, /message\.workTrail\?\.length/);
  assert.match(workTrail, /message\.interruption\?\.activities \?\? \[\]/);
  assert.match(workTrail, /saved-\$\{entry\.kind\}-\$\{message\.id\}-\$\{index\}/);
  assert.match(workTrail, /saved-tool-\$\{message\.id\}-\$\{index\}/);
  assert.doesNotMatch(chatPanel, /addAgentEvent/);
  assert.match(chatPanel, /modelStatus\?\.configured && conversationRuntime/);
  assert.match(chatPanel, /if \(!modelStatus \|\| !modelStatus\.configured\) \{[\s\S]*?setConversationRuntime\(null\)/);
  assert.match(styles, /\.turn-interruption/);
});

test("a new turn clears the prior idle stream snapshot before running becomes visible", () => {
  const sendMessage = chatPanel.match(/async function sendMessage\(contentOverride\?: string[^)]*\) \{[\s\S]*?\n  async function steerMessage/)?.[0] ?? "";
  assert.match(sendMessage, /cancelStreamingFlush\(\);\s*\n\s*setStreamingAssistant\(""\);/);
  assert.ok(sendMessage.indexOf('setStreamingAssistant("");') < sendMessage.indexOf("setRunning(true);"));
  assert.match(chatPanel, /typeof data\.text === "string" && data\.running === true/);
  const admissionStart = localServer.match(/state\.runningTurns\.add\(turnKey\);[\s\S]*?const userMessageId/)?.[0] ?? "";
  assert.match(admissionStart, /state\.runningTurns\.add\(turnKey\);\s*\n[\s\S]*?resetChatEventTurn\(state, turnKey\);/);
  assert.doesNotMatch(admissionStart, /await /);
});

test("settlement prefers a persisted work trail over still-running live previews", () => {
  assert.match(chatPanel, /const hasPersistedWorkTrail = \[\.\.\.transcript\]\.reverse\(\)/);
  assert.match(chatPanel, /if \(!keepSettledTurnArtifacts \|\| hasPersistedWorkTrail\) \{\s*\n\s*clearRuntimePreviews\(\)/);
  assert.match(piClient, /const preserveActiveTurnTrail = this\.promptInFlight/);
  assert.match(piClient, /if \(!preserveActiveTurnTrail\) this\.resetTurnState\(\)/);
  assert.match(localServer, /const finalText = await client\.prompt[\s\S]*?capturedWorkTrail = client\.getTurnWorkTrail\(\);\s*\n\s*promptStarted = false;/);
});

test("Chat composer model and reasoning controls are truthful, scoped, and functional", () => {
  // The control names the actual provider model, never the product. Its
  // click opens an inline list of this Connected Folder's connected models that saves
  // through the same configure endpoint as Settings, and its last item opens
  // Model Settings.
  assert.match(chatPanel, /runtime\.model\?\.name\s*\n\s*\?\? runtime\.model\?\.id/);
  assert.match(chatPanel, /displayModelLabel\(status\.provider \?\? "", status\.model \?\? ""\)/);
  assert.doesNotMatch(modelDisplay, /AmpleFile agent/i);
  assert.match(chatPanel, /`\/api\/agent\/models\?\$\{params\.toString\(\)\}`/);
  assert.match(chatPanel, /\.filter\(\(model\) => model\.authConfigured\)/);
  assert.match(chatPanel, /"\/api\/agent\/configure", \{\s*method: "POST",\s*body: \{ scope: "connected-folder", connectedFolderId, provider: model\.provider, model: model\.id \}/);
  assert.match(chatPanel, /onOpenModelSettings\?\.\(\);\s*\}\}\s*>\s*Model Settings/);
  assert.match(settingsModal, /initialScope=\{initialModelScope\} focusModelOnOpen=\{focusAiModel\}/);
  assert.match(panes, /<ModelCatalogList id="ai-model" labelledBy="ai-model-label"/);

  // Thinking is text-only and calls the real per-conversation endpoint. The
  // control appears only when the current model reports an actual choice.
  assert.doesNotMatch(chatPanel, /Brain(?:Circuit)?\d+(?:Filled|Regular)/);
  assert.match(chatPanel, /reasoningState && \(reasoningState\.thinkingLevels\?\.length \?\? 0\) > 1/);
  assert.match(chatPanel, /\/conversations\/\$\{conversationId\}\/thinking/);
  assert.match(chatPanel, /body: \{ level \}/);
  assert.match(chatPanel, /setConversationRuntime\(result\.runtime\)/);
  // Reasoning shares the model chip and its menu (2026-10-27).
  assert.match(chatPanel, /className="composer-model-reasoning">\{thinkingLevelLabel\(reasoning\.level\)\}/);
  assert.match(chatPanel, /role="radiogroup" aria-labelledby=\{`\$\{menuId\}-reasoning`\}/);
  assert.match(chatPanel, /reasoning\.forThisChat \? "Reasoning for This Chat" : "Reasoning"/);
  assert.doesNotMatch(chatPanel, /ThinkingLevelControl/);
  assert.match(chatPanel, /conversationRuntime \?\? composerState/);
  assert.match(chatPanel, /"\/api\/agent\/thinking"/);
  assert.match(chatPanel, /body: \{ scope: "connected-folder", connectedFolderId: connectedFolder\.id, level \}/);
  assert.doesNotMatch(chatPanel, /No extended reasoning|A brief think before answering|Balanced reasoning|Deeper reasoning/);
  assert.match(styles, /\.composer-reasoning-levels button \{[\s\S]*?font: inherit;/);
  assert.match(styles, /\.composer-model-chip \{[\s\S]*?font-family: inherit;[\s\S]*?font-size: var\(--amplefile-type-2xs\);[\s\S]*?font-weight: 700;/);
  // The context ring is its own button with a popover that compacts (2026-11-05),
  // and the reasoning levels stay on one row.
  assert.match(chatPanel, /<ConversationContextControl runtime=\{conversationRuntime\}[^>]*onCompact=\{compactFromContextMenu\}/);
  assert.match(chatPanel, /\{compacting \? "Compacting" : "Compact Chat"\}/);
  assert.match(styles, /\.composer-reasoning-levels \{[\s\S]*?flex-wrap: nowrap;/);
  assert.match(styles, /\.composer-model-menu \{\s*min-width: min-content;/);
  assert.match(localServer, /await client\.setThinkingLevel\(body\.level\)/);
});

test("reasoning and real tool calls form one chronological steps strip", () => {
  // Rows keep the order events arrived in; the strip folds into a plain
  // summary once a native final reply is known; hidden reasoning keeps its duration.
  assert.match(activity, /entry\.kind === "thinking"/);
  assert.match(activity, /entry\.kind === "tool"/);
  assert.match(activity, /className="work-steps-summary"/);
  assert.match(activity, /Thinking…/);
  assert.match(activity, /Working…/);
  assert.match(activity, /Thought for \$\{formatDuration\(entry\.durationMs \?\? 0\)\}/);
  assert.match(activity, /className=\{`work-step-thought\$\{live \? " live" : ""\}`\}[\s\S]*?<ReactMarkdown/);
  assert.match(activity, /repairReasoningMarkdownArtifacts/);
  assert.match(activity, /node\.type === "text"/);
  assert.match(activity, /connectedFolderPathCandidate\(value\.slice\(root\.length \+ 1\)/);
  assert.match(chatPanel, /if \(data\.type === "tool"\)/);
  assert.match(chatPanel, /kind: "tool"/);
  assert.match(chatPanel, /replyStarted=\{liveTurnView\.hasFinal\}/);
  assert.match(chatPanel, /durationMs: Math\.max\(0, endedAt - entry\.startedAt\)/);
  assert.match(messages, /connectedFolderRoot=\{connectedFolderRoot\}/);
  assert.match(piClient, /event\.detail = previous\?\.detail \|\| event\.detail \|\| ""/);
  assert.match(piClient, /summarizeToolValue\(args\)/);
  assert.doesNotMatch(piClient, /summarizeToolValue\(args \?\? result\)/);
  assert.match(piClient, /\|\| \(entry\.durationMs \?\? 0\) > 0\)/);
  assert.doesNotMatch(activity, /Brain|["']THINKING["']|Working through the request|AgentActivityEvent/);
  assert.doesNotMatch(activity, /return "Complete"/);
  assert.doesNotMatch(chatPanel, /agent-activity-toggle|agent-activity-log|>Activity</);
  assert.doesNotMatch(chatPanel, /typing-line|working-message/);
  assert.match(styles, /\.work-step-thought \{[^}]*min-width: 0;/);
  assert.match(styles, /\.work-step-thought pre \{[^}]*white-space: pre-wrap;/);
  assert.match(styles, /\.work-steps\.settled:not\(\.open\) \.work-steps-rows \{[^}]*grid-template-rows: 0fr;/);
  assert.doesNotMatch(styles, /\.runtime-preview|\.runtime-tool-|\.runtime-thinking|\.typing-line/);
});

test("manual restore points distinguish a new snapshot from already-covered files", () => {
  assert.match(localServer, /const created = !existingIds\.has\(checkpoint\.checkpointId\)/);
});

test("user actions retain semantic footer structure; the real cascade is exercised in application-appearance-surfaces", () => {
  assert.match(messages, /<div className="message-surface">[\s\S]*?<MarkdownMessage[\s\S]*?<\/div>\s*<footer className="message-footer">[\s\S]*?<MessageActions/);
  assert.doesNotMatch(`${messages}\n${chatPanel}`, /message-author|>You<|workerName/);
  const messageActionsSource = messages.match(/export function MessageActions[\s\S]*?(?=\nexport function TurnLanding)/)?.[0] ?? "";
  assert.doesNotMatch(messageActionsSource, /<span>\{copied \? "Copied" : "Copy"\}<\/span>/);
});

test("audited desktop and pane controls have working destinations", () => {
  assert.match(desktopMain, /About \$\{productName\}[\s\S]*?sendRendererMenuCommand\("open-about"\)/);
  assert.doesNotMatch(desktopMain, /About \$\{productName\}[^\n]*enabled:\s*false/);
});

async function read(relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), "utf8");
}
