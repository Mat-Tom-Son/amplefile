import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { build } from "esbuild";

import { createDomHarness } from "./support/dom.js";
import type { ChatMessage } from "../web-local/src/types.js";

// Continue on an interrupted reply. The row is memoized, so
// whether Continue is offered must reach it on its own; and Continue sends
// only its own words, never the files staged for the person's draft.

async function loadChatMessageRow(t: test.TestContext) {
  const compiled = await mkdtemp(resolve("node_modules/.chat-continue-row-test-"));
  t.after(() => rm(compiled, { recursive: true, force: true }));
  const entry = join(compiled, "entry.ts");
  const outfile = join(compiled, "component.mjs");
  await writeFile(entry, `export { ChatMessageRow } from ${JSON.stringify(resolve("web-local/src/components/chat/messages.tsx"))};\n`);
  await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic",
    plugins: [{ name: "renderer-icons", setup(builder) {
      builder.onResolve({ filter: /^@fluentui\/react-icons$/ }, () => ({ path: resolve("node_modules/@fluentui/react-icons/lib/index.js") }));
    } }], logLevel: "silent" });
  return (await import(pathToFileURL(outfile).href) as typeof import("../web-local/src/components/chat/messages.js")).ChatMessageRow;
}

test("an interrupted reply's row shows Continue as soon as it is offered, and calls the current handler", async (t) => {
  const ChatMessageRow = await loadChatMessageRow(t);

  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const message: ChatMessage = {
    id: "reply-1",
    role: "assistant",
    content: "Moving the older notes.",
    createdAt: "2026-10-27T12:00:00.000Z",
    interruption: { reason: "app_interrupted", message: "AmpleFile closed before this turn finished.", retryAttempts: 0, provider: null, model: null, activities: [] },
  } as ChatMessage;
  const props = {
    message, copied: false, showLanding: false, suppressEnterAnimation: true, showRuntimePreview: false, runtimePreviews: [],
    connectedFolderId: "space-0123456789abcdef", connectedFolderRoot: "/tmp/connected-folder", onCopyMessage: () => {},
  };
  const continueButton = () => [...dom.container.querySelectorAll("button")].find((button) => button.textContent === "Continue");

  await dom.render(createElement(ChatMessageRow, props));
  assert.equal(continueButton(), undefined, "not offered while something runs");

  const calls: string[] = [];
  await dom.render(createElement(ChatMessageRow, { ...props, onContinue: () => calls.push("first") }));
  assert.ok(continueButton(), "offering Continue alone re-renders the row");
  await dom.render(createElement(ChatMessageRow, { ...props, onContinue: () => calls.push("second") }));
  await dom.act(() => continueButton()!.click());
  assert.deepEqual(calls, ["second"], "the row never keeps an old handler");
});

test("a stopped reply's card claims a saved reply only when the record marks one, and names kept steps on their own", async (t) => {
  const ChatMessageRow = await loadChatMessageRow(t);
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const stopped = { reason: "cancelled" as const, message: "The agent was stopped before it completed this response.", retryAttempts: 0, provider: null, model: null, activities: [] };
  const row = (message: Partial<ChatMessage>) => createElement(ChatMessageRow, {
    message: { id: "stopped-1", role: "assistant", content: "The agent was stopped before it completed a response.", createdAt: "2026-10-27T12:00:00.000Z", interruption: stopped, ...message } as ChatMessage,
    copied: false, showLanding: false, suppressEnterAnimation: true, showRuntimePreview: false, runtimePreviews: [],
    connectedFolderId: "space-0123456789abcdef", connectedFolderRoot: "/tmp/connected-folder", onCopyMessage: () => {},
  });
  const card = () => dom.container.querySelector(".turn-interruption")!.textContent!;

  await dom.render(row({}));
  assert.match(card(), /You stopped the Worker before it finished\./);
  assert.doesNotMatch(card(), /saved the response|reply so far|steps it took/, "no text and no steps: nothing is claimed as kept");

  await dom.render(row({ workTrail: [{ kind: "tool", text: "Ran sleep 90", toolName: "bash", phase: "complete" }] }));
  assert.match(card(), /The steps it took are kept above\./);
  assert.doesNotMatch(card(), /reply so far/);

  await dom.render(row({ content: "I moved the first two notes and", interruption: { ...stopped, partialResponse: true } }));
  assert.match(card(), /Its reply so far is kept above\./);
});

test("Continue sends without the files staged for the person's draft", async () => {
  const chatPanel = await readFile(resolve("web-local/src/components/chat/ChatPanel.tsx"), "utf8");
  assert.match(chatPanel, /sendMessageRef\.current\(continueInterruptedTurnMessage, \{ withoutAttachments: true \}\)/);
  // The file manager's message box hands its own references in (`options.attachments`); Continue still sends none.
  assert.match(chatPanel, /const attachmentsForSend = options\.withoutAttachments \? \[\] : options\.attachments \?\? contextAttachments;/);
  assert.match(chatPanel, /contextPaths: attachmentsForSend\.map/);
  assert.doesNotMatch(chatPanel, /contextPaths: contextAttachments\.map\(\(attachment\) => attachment\.sourcePath\),\n\s*transientConversation/);
});
