import assert from "node:assert/strict";
import test from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import type { ChatMessage } from "../web-local/src/types.js";

const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const icons = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:message-link-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:message-link-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(?:png|svg)(?:\?|$)/u.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { ChatMessageRow } = await import("../web-local/src/components/chat/messages.js");
icons.deregister();

const reply = (id: string, content: string): ChatMessage => ({ id, role: "assistant", content, createdAt: "2026-09-27T12:00:00Z" });

function rowProps(message: ChatMessage, resolver: (paths: string[]) => Promise<Map<string, string>>, onOpen: (path: string) => void) {
  return {
    message, copied: false, showLanding: false, suppressEnterAnimation: true, showRuntimePreview: false, runtimePreviews: [],
    connectedFolderId: "folder", connectedFolderRoot: "/folder", onOpenConnectedFolderFile: onOpen,
    resolveConnectedFolderPathLinks: resolver, onCopyMessage() {},
  };
}

test("resolving a reply's file links keeps its elements, and re-rendering never re-resolves or replaces them", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const asked: string[][] = [];
  const resolver = async (paths: string[]) => { asked.push(paths); return new Map([["notes.md", "Docs/notes.md"]]); };
  const opened: string[] = [];
  const onOpen = (path: string) => { opened.push(path); };
  const message = reply("links-kept", "Read notes.md before the review.\n\nSecond paragraph stays put.");
  await dom.render(createElement(ChatMessageRow, rowProps(message, resolver, onOpen)));
  const second = [...dom.container.querySelectorAll("p")].find((item) => item.textContent === "Second paragraph stays put.")!;
  assert.ok(second);
  await dom.waitFor(() => Boolean(dom.container.querySelector(".connected-folder-file-link")));
  assert.equal([...dom.container.querySelectorAll("p")].includes(second), true, "resolving links re-renders only the linked text");
  // A row re-render (copied state flips) with the same callbacks keeps every element.
  await dom.render(createElement(ChatMessageRow, { ...rowProps(message, resolver, onOpen), copied: true }));
  await dom.render(createElement(ChatMessageRow, { ...rowProps(message, resolver, onOpen), copied: false }));
  assert.equal([...dom.container.querySelectorAll("p")].includes(second), true);
  assert.equal(asked.length, 1, "the same reply resolves its links once");
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>(".connected-folder-file-link")!.click());
  assert.deepEqual(opened, ["Docs/notes.md"]);
});

test("a reply whose mentions resolve to nothing is not re-resolved when its parent re-renders", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  let asked = 0;
  const resolver = async () => { asked++; return new Map<string, string>(); };
  const message = reply("links-empty", "Nothing named missing.md exists.");
  await dom.render(createElement(ChatMessageRow, rowProps(message, resolver, () => {})));
  await dom.waitFor(() => asked === 1);
  // A parent that hands a fresh open callback (any re-render of the file
  // manager) must not re-post the reply's paths.
  await dom.render(createElement(ChatMessageRow, rowProps(message, resolver, () => {})));
  await dom.settle();
  assert.equal(asked, 1);
});
