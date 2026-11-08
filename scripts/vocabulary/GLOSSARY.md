# AmpleFile vocabulary

The desktop interface is the source of truth for product names. Code,
HTTP routes, CLI verbs and flags, JSON keys, storage paths, and schemas follow
it. Labels are Title Case, and **Connected Folder** is capitalized everywhere,
in labels and in sentences, like **Worker**.

| Interface | Code (camel / Pascal) | Kebab (routes, CLI, files, CSS) | Replaces |
|---|---|---|---|
| AmpleFile | `ampleFile`, `AmpleFile` | `amplefile` (one word; `AMPLEFILE_` in the environment) | work-fold |
| Connected Folder | `connectedFolder`, `ConnectedFolder` | `connected-folder` | work-folder; before 2026-10-10, Space |
| Worker | `worker`, `Worker` | `worker` | Space Assistant, product-sense `assistant` |
| AmpleFile agent | `ampleFileAgent`, `AmpleFileAgent` | `amplefile-agent` (CLI verb `agent`) | work-fold agent; management conversation, the fold |
| Automation | `automation`, `Automation` | `automation` | routing |
| Recently deleted | `recentlyDeleted`, `RecentlyDeleted` | `recently-deleted` | trash |
| overview | `overview`, `Overview` | `overview` | glance |
| Everywhere | `everywhere` | `everywhere` | the `personal` capability scope |

Not renamed, because they are not product vocabulary:

- The LLM message role `assistant` and everything that names the model's
  reply (`assistantText`, `assistant_delta`, `AssistantPresentation`,
  streaming-assistant state). These follow the model provider's protocol.
- Pi's own scopes (`global`, `project`), Pi types, and Pi directories.
- The plain word "folder" for an ordinary directory.
- CSS values and keyboard names that merely contain "space"
  (`white-space`, `space-between`, `userSpaceOnUse`, the `Space` key).
- Dated quotations, and the work-fold repository that holds the archives.

Opaque identifiers keep their established prefix: a Connected Folder id is
`space-<16 hex>` (and a removal transaction `space-removal_<uuid>`, whose
claimed folder is `.space-removal-<uuid>`) because
that identity is written into every registered folder's portable
`.amplefile/` metadata, and a Recently deleted entry id stays
`trash-<timestamp>-<hex>` because entries name their own directories.
Machine-local Automation ids follow the new words (`automation-…`).

The folder that holds app-managed Connected Folders keeps its name (`spaces/` in
app state), as does the AmpleFile agent's working folder (`management/`), and
path-derived storage keys keep their old fallback segment: moving or
re-keying them would move user content and detach History, per-folder state,
and Pi chat sessions from existing folders. (The restricted-app bridge API
and the paired-web `management.*` wire operations were also exceptions until
Connected Folder apps and Web Access were removed from the desktop on
2026-11-07.)

## Existing data

The one-time migrations that carried a profile from before 2026-10-10
forward stayed with the work-fold repository: AmpleFile starts with a new
app id and an empty profile, so it has no such state.

## How the names were changed

`scripts/rebrand/rename.mjs` made the 2026-11-07 rename and records its
rules: each code token keeps its case style, and prose uses the display
names. `node scripts/rebrand/inventory.mjs --check` fails while an old name
remains outside the places that name it on purpose.
