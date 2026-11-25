/**
 * What anyone writing an Automation declaration needs to know about its
 * shape, kept beside the validator so the two cannot drift apart. Every
 * supported contract version must say what it adds — the Record type makes a
 * missing version a type error — and tests parse every trigger shape and the
 * example through the validator itself. `amplefile help automations` and the
 * AmpleFile Agent's instructions render from here instead of restating it.
 */

import {
  ampleFileAutomationContractVersion,
  ampleFileAutomationProposalKind,
  ampleFileAutomationSupportedContractVersions,
  type AmpleFileAutomationContractVersion,
} from "./automation-declarations.js";

/** What each contract version adds. A newer version accepts every shape an older one does. */
export const ampleFileAutomationVersionAdditions: Readonly<Record<AmpleFileAutomationContractVersion, string>> = {
  1: "manual and interval triggers; chat and files steps",
  2: "the one-time at trigger",
  3: "the files-changed trigger on a folder inside a Connected Folder",
  4: "the agent step, and {{…}} placeholders in chat and agent messages",
  5: "ifMissed on a files-changed trigger, for one catch-up run",
  6: "a files-changed trigger on a Connected Folder's own top level",
};

/** A sample Connected Folder id; an author replaces it with a real one. */
export const ampleFileAutomationGuideSampleConnectedFolder = "space-0000000000000001";
const sampleTargetConnectedFolder = "space-0000000000000002";

export interface AmpleFileAutomationTriggerShape {
  /** When the trigger starts a run, in a person's words. */
  when: string;
  /** The first contract version that accepts it. */
  since: AmpleFileAutomationContractVersion;
  trigger: Record<string, unknown>;
}

const folderWatchTiming = { debounceSeconds: 5, cooldownMinutes: 1 } as const;

/** Every trigger kind the validator accepts, each in a shape it accepts. */
export const ampleFileAutomationTriggerShapes: readonly AmpleFileAutomationTriggerShape[] = [
  { when: "only when run by hand", since: 1, trigger: { kind: "manual" } },
  { when: "every N minutes", since: 1, trigger: { kind: "interval", intervalMinutes: 60 } },
  {
    when: "once, at an exact time with its UTC offset; ifMissed (run or skip) is required",
    since: 2,
    trigger: { kind: "at", at: "2030-01-01T09:00:00-05:00", ifMissed: "run" },
  },
  {
    when: "files change in a folder inside a Connected Folder (recursive: true includes its subfolders)",
    since: 3,
    trigger: {
      kind: "files-changed",
      connectedFolder: ampleFileAutomationGuideSampleConnectedFolder,
      watch: { kind: "tree", path: "Incoming", recursive: true, extensions: [".md", ".txt"] },
      ...folderWatchTiming,
    },
  },
  {
    when: "the same, plus one catch-up run for files that arrived while AmpleFile was closed, asleep, or off",
    since: 5,
    trigger: {
      kind: "files-changed",
      connectedFolder: ampleFileAutomationGuideSampleConnectedFolder,
      watch: { kind: "tree", path: "Incoming", recursive: true, extensions: [".md", ".txt"] },
      ...folderWatchTiming,
      ifMissed: "run",
    },
  },
  {
    when: "files change directly in a Connected Folder's own top level (path \"\"; never its subfolders, so recursive must be false)",
    since: 6,
    trigger: {
      kind: "files-changed",
      connectedFolder: ampleFileAutomationGuideSampleConnectedFolder,
      watch: { kind: "tree", path: "", recursive: false, extensions: [".pdf", ".png"] },
      ...folderWatchTiming,
    },
  },
];

/** A complete proposal using all three step kinds and the placeholders, at the newest version. */
export const ampleFileAutomationGuideExampleProposal = {
  kind: ampleFileAutomationProposalKind,
  version: ampleFileAutomationContractVersion,
  name: "Brief handoff",
  createdBy: "assistant",
  createdAt: "2026-01-01T00:00:00.000Z",
  automation: {
    title: "Brief handoff",
    trigger: {
      kind: "files-changed",
      connectedFolder: ampleFileAutomationGuideSampleConnectedFolder,
      watch: { kind: "tree", path: "Ready", recursive: false, extensions: [".md"] },
      ...folderWatchTiming,
      ifMissed: "run",
    },
    steps: [
      {
        id: "copy",
        kind: "files",
        fromConnectedFolder: ampleFileAutomationGuideSampleConnectedFolder,
        from: { kind: "paths", paths: ["Ready/brief.md"] },
        toConnectedFolder: sampleTargetConnectedFolder,
        to: "Incoming",
      },
      {
        id: "adopt",
        kind: "chat",
        connectedFolder: sampleTargetConnectedFolder,
        message: "Adopt the newest Incoming/brief*.md copy into reference/brief.md. Preserve the draft and other files. Changed files this run:\n{{trigger.changedFiles}}",
      },
      {
        id: "report",
        kind: "agent",
        message: "{{trigger.summary}} The brief handoff finished. Files the adopt step created:\n{{steps.adopt.createdFiles}}",
      },
    ],
  },
} as const;

/** The version guidance, trigger shapes, and example, as lines for `help automations`. */
export function ampleFileAutomationAuthoringGuideLines(): string[] {
  return [
    `Write "version": ${ampleFileAutomationContractVersion}, the newest. Each version adds to the one`,
    "before it and accepts every shape an older one does:",
    ...ampleFileAutomationSupportedContractVersions.map((version) => `  ${version}  ${ampleFileAutomationVersionAdditions[version]}`),
    "",
    "Triggers, each with the version that first accepts it:",
    ...ampleFileAutomationTriggerShapes.flatMap((shape) => [
      `  ${shape.when} (version ${shape.since}):`,
      `    ${JSON.stringify(shape.trigger)}`,
    ]),
    "",
    "Complete proposal example (replace the sample Connected Folder ids,",
    "paths, messages, and timestamp with your own values):",
    JSON.stringify(ampleFileAutomationGuideExampleProposal),
  ];
}
