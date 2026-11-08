# AmpleFile vocabulary

The desktop interface is the source of truth for product names. Code,
HTTP routes, CLI verbs and flags, JSON keys, storage paths, and schemas follow
it. Labels are Title Case, and **Connected Folder** is capitalized everywhere,
in labels and in sentences, like **Worker**.

| Interface | Code (camel / Pascal) | Kebab (routes, CLI, files, CSS) |
|---|---|---|
| AmpleFile | `ampleFile`, `AmpleFile` | `amplefile` (one word; `AMPLEFILE_` in the environment) |
| Connected Folder | `connectedFolder`, `ConnectedFolder` | `connected-folder` (CLI family `connected-folders`, flag `--connected-folder`) |
| Worker | `worker`, `Worker` | `worker` |
| AmpleFile Agent | `ampleFileAgent`, `AmpleFileAgent` | `amplefile-agent` (scope id; the CLI verb is `agent`) |
| Automation | `automation`, `Automation` | `automation` |
| Recently Deleted | `recentlyDeleted`, `RecentlyDeleted` | `recently-deleted` |
| overview | `overview`, `Overview` | `overview` |
| Everywhere | `everywhere` | `everywhere` |
| Skills & Extensions | `capability` (the internal umbrella) | `capabilities`, `tools` (CLI families) |

Words that are not product vocabulary and keep their ordinary meaning:

- The LLM message role `assistant` and everything that names the model's
  reply (`assistantText`, `assistant_delta`, `AssistantPresentation`,
  streaming-assistant state). These follow the model provider's protocol.
- Pi's own scopes (`global`, `project`), Pi types, and Pi directories.
- The plain word "folder" for an ordinary directory.
- CSS values and keyboard names that merely contain "space"
  (`white-space`, `space-between`, `userSpaceOnUse`, the `Space` key).

Opaque identifiers keep their own prefixes. A Connected Folder id is
`space-<16 hex>` (and a removal transaction `space-removal_<uuid>`, whose
claimed folder is `.space-removal-<uuid>`), because that id is written into
every registered folder's portable `.amplefile/` metadata. A Recently Deleted
entry id is `trash-<timestamp>-<hex>`, because entries name their own
directories. Automation ids start with `automation-`.

The app-state folder that holds managed Connected Folders is `spaces/`, and
the AmpleFile Agent's working folder is `management/`. Path-derived storage
keys keep the same segments, so History, per-folder state, and Pi chat
sessions stay attached to their folders.

`node scripts/rebrand/inventory.mjs --check` fails if a name from the earlier
app comes back.
