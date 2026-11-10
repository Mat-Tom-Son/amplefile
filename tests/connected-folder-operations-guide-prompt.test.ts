import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { ampleFileToolFeedbackGuide } from "../src/local/agent/tool-feedback-guide.js";
import {
  connectedFolderOperationsGuideForScope,
  ampleFileConnectedFolderOperationsGuide,
  ampleFileConnectedFolderOperationsGuideHeading,
  ampleFileWorkerWorkingFilesGuide,
} from "../src/local/agent/connected-folder-operations-guide.js";

/**
 * The operations guide reaches a Connected Folder Chat's real Pi session as a system
 * prompt appendix, after the person's Connected Folder instructions, the way those are
 * appended (docs/collaboration-contract.md). No model is contacted:
 * building the session composes the prompt without a turn.
 */
test("a Connected Folder Chat's system prompt carries Connected Folder instructions and then the operations guide", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amplefile-guide-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const connectedFolderRoot = join(root, "connected-folder");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(connectedFolderRoot, { recursive: true });
  const provider = {
    async resolveRuntime() {
      return { agentDir, workerInstructions: "Prefer short answers." };
    },
  };

  const guided = new PiConversationClient("guide", connectedFolderRoot, provider, undefined, {
    operationsGuide: connectedFolderOperationsGuideForScope("connected-folder-1")!,
  });
  t.after(() => guided.stop());
  await guided.getCatalog();
  const appended = sessionAppendix(guided);
  assert.equal(appended.length, 4, "Connected Folder instructions, operations, working files, and shared tool feedback guidance");
  assert.match(appended[0]!, /^## Worker instructions\n\nPrefer short answers\.$/);
  assert.ok(appended[1]!.startsWith(ampleFileConnectedFolderOperationsGuideHeading));
  assert.equal(appended[2], ampleFileWorkerWorkingFilesGuide);
  assert.equal(appended[3], ampleFileToolFeedbackGuide);

  const unguided = new PiConversationClient("plain", connectedFolderRoot, provider);
  t.after(() => unguided.stop());
  await unguided.getCatalog();
  const plain = sessionAppendix(unguided);
  assert.equal(plain.length, 2, "management also receives shared tool feedback guidance without Connected Folder operations");
  assert.match(plain[0]!, /^## Worker instructions/);
  assert.equal(plain[1], ampleFileToolFeedbackGuide);
  assert.doesNotMatch(plain.join("\n"), /Worker working files/);

  // The guide is a session appendix; nothing new is written into the Connected Folder's folder.
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(connectedFolderRoot), []);
});

/**
 * What the guide teaches has to be what the host does. Two rules cost a Connected Folder
 * Agent a refused command or a false boundary if the text drifts:
 * `chat answer` names the ASKING Connected Folder, not this one (src/local/api/act-lane.ts
 * refuses any other), and `chat wait` returns the destination turn's own
 * latest reply and the selected request result.
 */
test("the guide teaches the two rules the host actually enforces", () => {
  const guide = ampleFileConnectedFolderOperationsGuide();

  // `--connected-folder` is this Connected Folder's id everywhere except `chat answer`.
  assert.match(guide, /child result\/wait and answer reads name the owning Connected Folder/);
  assert.match(guide, /chat answer --connected-folder <the Connected Folder that asked>/);
  assert.match(guide, /Name the asking Connected Folder, never your own/);
  assert.doesNotMatch(guide, /chat answer --connected-folder <id>/, "the answer verb never shows the caller's own id");

  // `chat wait` does not promise a filter the built path does not apply.
  assert.doesNotMatch(guide, /never its Chat/);
  assert.match(guide, /completion returns the latest reply and selected result/);

});

/**
 * The Worker's guide teaches no page.json, page script API, or validate
 * verb, and never mentions publishing.
 */
test("the guide does not teach pages", () => {
  const guide = ampleFileConnectedFolderOperationsGuide();
  assert.doesNotMatch(guide, /### Pages|page\.json|data-page-|pages validate|page tab/);
  assert.doesNotMatch(guide, /pages publish|pages unpublish|Web Access/);
  // Nor single-file sharing.
  assert.doesNotMatch(guide, /Pages the person may share|shareable HTML|sharing pages|shares it from the file's tab/);
});

function sessionAppendix(client: PiConversationClient): string[] {
  const session = (client as unknown as { session: { resourceLoader: { getAppendSystemPrompt(): string[] } } }).session;
  return session.resourceLoader.getAppendSystemPrompt();
}
