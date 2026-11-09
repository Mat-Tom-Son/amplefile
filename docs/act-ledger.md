# The act ledger

Every product verb AmpleFile offers to the AmpleFile Agent, a Worker, or a
shell-capable agent on the CLI, with its classification, command shape,
receipt additions, undo path, and conflict rules. `src/local/cli/act-commands.ts`,
`src/local/cli/act-facade.ts`, and their suites are the implementation
authority. Automation and overview verbs are owned by
[Automations](automations.md) and [the overview](amplefile-agent-overview.md);
the CLI, kernel, and request contracts by
[the AmpleFile Agent and CLI](amplefile-agent-and-cli.md).

## Receipts, not gates

AmpleFile is a single-user, local product. Every Worker and the AmpleFile
agent already hold the person's full local authority: each Pi session has
read, bash, edit, and write tools that reach whatever the person can reach. An
approval step in front of a subset of product verbs would add friction
without being a security boundary. So the product works on these rules:

1. **Every verb executes immediately.** There is one authority mode. No
   action a person or an agent asks for waits on a card, a standing rule, a
   toggle, or a second click.
2. **Every effect leaves a receipt.** The journal-first, at-most-once,
   identity-pinned act path is attribution and recovery machinery, not a
   gate.
3. **Every destruction is reversible.** Nothing the product does is
   permanent at the moment it happens. History covers ordinary deletion;
   everything History cannot cover goes to machine-local
   [Recently Deleted](#recently-deleted) with a retention window.
4. **Disclosure is after the fact.** Receipts and
   [the overview](amplefile-agent-overview.md) say what happened. "Needs
   you" means an agent asked a question, never that an action waits for
   approval.
5. **The only human-only surface is not work.** Entering a provider secret
   establishes identity. No task needs it mid-flight, so it never blocks a
   task.
6. **Bounds are visible and named.** Byte envelopes, concurrent work, and
   cancellation boundaries keep the runtime reliable. Requests and
   declarations have no lifetime or count quota. Every enforced bound names
   the field or scheduler state that applies.
7. **One shape for everyone.** The AmpleFile Agent, a Worker, an Automation,
   and an outside harness on the CLI use the same verbs, the same receipts,
   and the same result and question shapes.

A confirmation, hold, or approval state on any verb is a product decision,
not a UI tweak. Person-facing strings never say staged, card, approve,
policy, mode, Reviewed, or Unrestricted.

## Terms

| Target | Meaning |
|---|---|
| **direct verb** | Performed through the act lane: explicit selection, journal-first receipt, at-most-once execution, the desktop's conflict rules. |
| **prepared verb** | A direct verb whose execution shape is prepare → pin → journal-first → fenced execute → receipt, run on the call that asks. Covers Pi package and skill-bundle install, update, and enable/disable, Automation enablement, and managed Connected Folder deletion. |
| **reversible deletion** | A delete whose undo is a History restore point or a Recently Deleted entry (`recently-deleted restore`). No product verb destroys permanently; retention does. |
| **setup-only boundary** | Neither the AmpleFile Agent nor the CLI can perform or request it: act-token machinery, provider credentials, and settings administration. |
| **deliberately absent** | Not a product verb: desktop-session mechanics, machine-local UI preference, or a surface whose meaning does not survive leaving the desktop. Listed so absence is a decision, not a gap. |

## Rules every verb inherits

Every mutation answers the same five questions the same way, so the tables
record only per-verb additions.

1. **Who journals it.** The act executor
   (`src/local/cli/act-commands.ts`) appends an `accepted` line to
   `cli/receipts/act.jsonl` (`src/local/cli/act-receipts.ts`) **before** the
   mutation runs; an unwritable journal refuses the command. Reads of
   AmpleFile's own recorded state (status, lists, shows, the overview) write
   the same lines to `cli/receipts/act-reads.jsonl`, so polling never crowds
   real acts out of the journal. The owning
   domain service keeps its own durable records exactly as it does for the
   desktop (History checkpoints, transcript lifecycle events, Automation run
   receipts).
2. **What the receipt contains.** Baseline: version, timestamp, request id,
   command, outcome (`accepted`/`ok`/`error`/`rejected`), error code,
   Connected Folder and conversation ids, checkpoint id, kernel task id, and
   AmpleFile Agent `parentTaskId` lineage, plus the fields under
   [Receipt schema](#receipt-schema). Receipts stay content-light:
   identifiers, digests, and names, never file contents, message text,
   search queries, or credentials.
3. **How it is undone.** Per verb, in the tables. In general: file
   mutations inside a Connected Folder are undone through the safety restore
   point every mutation records; lifecycle and naming verbs are undone by the
   inverse verb using the prior state captured in the receipt; standing
   powers are narrowed by their twin (disable, remove), which is always
   direct; deletions are undone through the restore point or
   `recently-deleted restore --entry <id>`.
4. **What happens on failure mid-act.** The domain service's atomicity
   applies: placement and restore point succeed or fail together, and
   Connected Folder removal uses a durable cleanup outbox. The executor
   appends a terminal `error` receipt; a crash between `accepted` and the
   terminal line is itself the honest signal that the outcome was
   interrupted. A failed or interrupted prepared verb is never auto-retried;
   another attempt is a fresh call.
5. **How replay is prevented.** The broker's freshness window and pending
   response dedup, then the journal's `accepted` records as the durable
   at-most-once ledger: a duplicated request id is refused outright, and a
   damaged journal fails closed rather than risk re-execution — an
   unreadable file always, an unreadable line until the freshness window
   and clock-skew allowance have passed since the line written after it.
   Journal rotation holds entries at least as long as the freshness window.

Act-protocol conventions: the versioned act envelope
(`src/local/cli/act-protocol.ts`), the per-launch act token, explicit
`--connected-folder` on every Connected Folder–scoped write (never
working-directory resolution), `--parent-task` lineage validated against an
active AmpleFile Agent request, and `--json` output. Prepared verbs use the
same grammar and return the receipt of their immediate execution.

## The ledger

Columns: the verb; where a person does it in the window (— when only the CLI
and agents use it); the target class; the command shape; what the receipt
adds beyond baseline; the undo path; and the conflict rules, which mirror the
desktop's.

### Connected Folder lifecycle

| Verb | In the window | Target | Command shape | Receipt adds | Undo | Conflicts |
|---|---|---|---|---|---|---|
| Create Connected Folder | Sidebar **+** → New Connected Folder…, first run | direct verb | `connected-folders create --name <n>` | Connected Folder id | `connected-folders unregister` (the folder remains) | name collision refused |
| Connect a folder | Sidebar **+** → Connect Folder…, Connect This Folder | direct verb | `connected-folders register --path <abs>` | Connected Folder id | `connected-folders unregister` revokes runtime authorization | an already-registered path is refused |
| Rename Connected Folder | Customize Connected Folder → name | direct verb | `connected-folders rename --connected-folder <id> --name <n>` | prior name | rename back (prior name in receipt) | a duplicate exact name is refused |
| Disconnect | Action menu → Disconnect… | direct verb | `connected-folders unregister --connected-folder <id>` | storage kind | connect the folder again; its `.amplefile/` identity persists | on success, Automations that reference it are suspended and their active runs stopped ([Automations](automations.md)) |
| Delete a managed Connected Folder | Action menu → Delete Connected Folder… | **prepared verb** | `connected-folders delete --connected-folder <id>` | Recently Deleted entry id, canonical root | `recently-deleted restore --entry <id>` registers it again with its portable identity, its Chats, and its History | the claimed folder is moved into Recently Deleted, never erased |
| Apply appearance | Customize Connected Folder | direct verb | `connected-folders appearance apply --connected-folder <id> (--proposal <path> \| [--banner-image <path>] [--icon <name>] [--color <#rrggbb>])` | prior customization ref | `connected-folders appearance undo --connected-folder <id>` | a proposal must parse as the typed `connected-folder-appearance` proposal |
| Reset appearance | Customize Connected Folder | direct verb | `connected-folders appearance reset --connected-folder <id>` | prior customization ref | `connected-folders appearance undo` | — |
| Undo appearance | — | direct verb | `connected-folders appearance undo --connected-folder <id>` | restored and displaced customization refs | apply the displaced ref again; undo is its own inverse | refused with a typed error when the receipt chain records no prior customization ref for that Connected Folder, including when its appearance was last changed in the window |
| Inspect Worker preferences | Settings → AI Models | direct verb (content-bearing act read) | `connected-folders worker show --connected-folder <id>` | — | n/a | returns only connected model choices plus the current model and instruction text; provider credentials never enter the result |
| Set the default model for new Chats | Settings → AI Models | direct verb | `connected-folders worker model --connected-folder <id> --provider <id> --model <id>` | provider and model ids | choose the prior model again | the model must exist and already have configured auth; fenced against active agent or compaction work; existing Chat sessions keep their session model |
| Set or clear Worker instructions | Settings → AI Models | direct verb | `connected-folders worker instructions --connected-folder <id> (--instructions <text> \| --append <text> \| --clear)` | updated character count or cleared marker, never text | set the prior text again or clear | bounded validated text; applies to subsequent turns after scoped client invalidation |

Disconnecting and deleting are separate verbs. Disconnecting is recoverable
and narrows authority, so it is a direct verb valid for both storage kinds.
Deleting a managed Connected Folder's folder is a prepared verb that moves it
into Recently Deleted.

**Appearance is a direct verb.** It is cosmetic, machine-local, carries no
authority, and already has an inert typed proposal format. The risk is
impersonation (an injected instruction restyling one Connected Folder to look
like another), and the mitigations are structural: the verb accepts only the
typed proposal, the receipt captures the prior customization for one-step
undo, the change shows in [the overview](amplefile-agent-overview.md)'s
"what changed" list, and appearance cannot touch the AmpleFile Agent's own
chrome, Settings, or any trust surface.

### Chats

| Verb | In the window | Target | Command shape | Receipt adds | Undo | Conflicts |
|---|---|---|---|---|---|---|
| Create Chat | Message box | direct verb | `chat create --connected-folder <id>` | conversation id | archive it | — |
| Send message | Message box, **Reply** | direct verb | `chat send …` | task id | `chat abort` while running | sending into running work is refused; an archived or snoozed Chat must be resumed first |
| Abort turn | **Stop** | direct verb | `chat abort …` | — | n/a | no active turn is an honest no-op |
| Status, result, list | the Chat in the panel | direct verb (content-bearing act reads) | `chat status`, `chat result`, `chats list` | — | n/a | — |
| Rename Chat | — | direct verb | `chat rename --connected-folder <id> --conversation <id> --title <t>` | prior title | rename back; a person-authored title always wins over a generated one | refused while that Chat's turn or compaction runs |
| Snooze Chat | — | direct verb | `chat snooze --connected-folder <id> --conversation <id> --until <ISO>` | prior lifecycle state | `chat resume` | a future time is required; one lifecycle change per act; refused while a turn or compaction runs; never rewrites the transcript |
| Archive Chat | — | direct verb | `chat archive --connected-folder <id> --conversation <id>` | prior lifecycle state | `chat resume` | same as snooze |
| Resume Chat | **Resume Now** or **Restore** on a snoozed or archived Chat | direct verb | `chat resume --connected-folder <id> --conversation <id>` | prior lifecycle state | archive or snooze again | refused while a turn or compaction runs |
| Compact Chat | Context popover → **Compact Chat**, `/compact` | direct verb | `chat compact --connected-folder <id> --conversation <id>` | kernel task id | none; compaction summarizes and deletes nothing | refused while a turn runs; registers the same kernel `compaction` task and capability fence as the desktop |
| Copy Chat | — | direct verb | `chat copy --connected-folder <id> --conversation <id> [--title <t>] [--task <own-task-id>] [--message <text>]` | copied-from Chat, message count, started task id | archive or delete the copy; the original is never written | a running turn is left out of the copy; refused while compacting; with `--task`, only the caller's own Chat or one it handed work to |
| Steer a running Chat | **Reply** while a turn runs | direct verb | `chat steer --connected-folder <id> --conversation <id> [--task <own-task-id>] --message <text>` | running task id | n/a (delivered after the current step) | refused when no turn runs; with `--task`, only a Chat the caller's Chat handed work to |
| Report a result | — | direct verb | `chat report --connected-folder <id> --task <own-task-id> --summary <text> [--data <json-or-@path>] [--file <path>]... [--outcome …]` | outcome and file count, never the summary or data | none; a report is a record | `--task` must be the caller's own running turn; summary ≤ 4 MiB and data ≤ 16 MiB; each file must be inside the Connected Folder |
| Ask a question | — | direct verb | `chat ask --connected-folder <id> --task <own-task-id> --question <text> [--to person\|parent]` or `agent ask --task <own-task-id> --question <text>` | question id and respondent, never the text | none; the question stays on record and a root Stop closes it | `--to parent` on a root reaches the person and says so; the asking turn is never suspended; the request reads `waiting` |
| Answer a question | The question's answer field, or a reply in the Chat | direct verb | `chat answer --connected-folder <id> --question <id> --answer <text>` or `agent answer --question <id> --answer <text>` | question id and continuation task id, never the answer | none; one accepted answer, one linked continuation turn | refuses a second answer, a stopped request, a Connected Folder that does not own the question, and a Chat whose turn or compaction is running (the question stays open); the turn store dedups the continuation under `answer-<question-id>` |
| Hand work on | — | direct verb | `chat handoff --connected-folder <id> --task <own-task-id> --to-connected-folder <id-or-name> [--to-conversation <id>] (--message <text> \| --message-file <path>) [--file <path>]...` | destination Connected Folder, new Chat, task, restore point, copy count | the destination's restore point (copies are additive, exactly `files add`'s path) | concurrency is checked before any copy; files are copied before acceptance so a refused copy never leaves a started Chat; a handoff within the same Connected Folder takes no `--file` |

Lifecycle events are append-only entries in the Chat's portable
`.amplefile/conversations/` log; the act lane adds receipts, not a second
lifecycle store. Snooze verbs take an explicit `--until`.

`chat wait` and `agent wait` are polls in the CLI shim and settle on either a
terminal turn or a task that is waiting on an answer, printing the status
document with `waiting` set in the second case (exit 0). When a root
AmpleFile Agent request's handed-out work settles after its turn ended, the
host starts one `system`-actor continuation joined to that request under
`continuation-<request-id>-<n>`; never after a root Stop and never because of
a restart.

### Requests

| Verb | In the window | Target | Command shape | Receipt adds | Undo | Conflicts |
|---|---|---|---|---|---|---|
| List requests | — | direct verb (content-bearing act read) | `requests list` | — | n/a | newest 50 roots; `truncated` says when more exist; takes no `--connected-folder` |
| Show a request | — | direct verb (content-bearing act read) | `requests show --request <id>` | — | n/a | the root and its subtree with questions (text), results (summary and data), turns, and usage; the human form clamps, `--json` carries them whole |

### Background jobs

| Verb | In the window | Target | Command shape | Receipt adds | Undo | Conflicts |
|---|---|---|---|---|---|---|
| Start a background job | — (`job_start` in a Chat) | direct verb | `jobs start --connected-folder <id> --task <own-task-id> (--command <cmd> \| --command-file <path>) [--name <label>] [--cwd <folder>] [--timeout <s>]` | job id, state, starting task, never the command text | `jobs stop`, or Stop on its request; History captures what it wrote when it ends | `--task` must be the caller's own running turn of a request that can continue; refused past the running-jobs bound; journaled before the process starts and never re-run |
| List background jobs | the Chat's work line | direct verb (act read) | `jobs list --connected-folder <id> [--conversation <id>] [--running]` | — | n/a | only that Connected Folder's jobs |
| Show a background job | the Chat's work line | direct verb (content-bearing act read) | `jobs show --connected-folder <id> --job <id>` | — | n/a | carries the command, state, exit, History coverage, and delivery |
| Read a job's output | — (`job_output` in a Chat) | direct verb (content-bearing act read) | `jobs output --connected-folder <id> --job <id> [--offset <line>] [--limit <lines>] [--wait <s>] [--until <pattern>] [--task <own-task-id>]` | — | n/a | at most 2,000 lines or 50 KB per read; `--wait` capped at 600 seconds, run beside the CLI host's serial queue; `--task` naming a running turn in the job's own Chat delivers a finished job |
| Send input to a job | — (`job_input` in a Chat) | direct verb | `jobs input …` ([Worker tools](worker-tools.md)) | job id | n/a | only an interactive job of the caller's own request |
| Stop a background job | **Stop** on the request | direct verb | `jobs stop --connected-folder <id> --job <id>` | job id, final state | none; a stopped job is never re-run | SIGTERM to the process group, SIGKILL after 5 seconds; a stopped job still wakes its Chat once |

A job belongs to the request its turn started it in: the request reads
`working` while the job runs, and its end reaches the Chat once, through a
read, the next turn's context, or one `continuation-<request-id>-<n>`
follow-up ([Background jobs](background-jobs.md)).

### History

| Verb | In the window | Target | Command shape | Receipt adds | Undo | Conflicts |
|---|---|---|---|---|---|---|
| List restore points | History tab | direct verb (content-bearing act read) | `history list --connected-folder <id> [--limit <n>] [--cursor <c>]` | — | n/a | — |
| Save a restore point | — | direct verb | `history save --connected-folder <id> [--label <t>]` | checkpoint id, `created` flag | none needed (additive) | unchanged files return an honest "already matches" result, not a new checkpoint |
| Restore a restore point | History tab → **Undo** or **Restore** | direct verb | `history restore --connected-folder <id> --checkpoint <id>` | restored checkpoint id and the pre-restore safety checkpoint id | restore the safety checkpoint the act recorded | **refused while any agent turn or compaction is active in that Connected Folder, or while an Automation run with a files hop targeting it is active**; the desktop uses the same reservation |
| List file versions | Version History, or the History tab with one file selected | direct verb (content-bearing act read) | `history versions --connected-folder <id> --path <p>` | — | n/a | — |
| Read or compare saved text | Version History → Compare | direct verb (content-bearing act read) | `history read …`, `history diff …` ([details](amplefile-agent-and-cli.md#bounded-history-review-and-durable-turn-evidence)) | metadata only | n/a | — |
| Restore a file version | Version History → **Restore** | direct verb | `history restore-file --connected-folder <id> --path <p> --version <sha256>` | safety checkpoint id | restore the safety checkpoint | a missing version is not found; a folder at the path is refused |

A whole–Connected Folder restore records a `pre_restore` safety checkpoint
and a file-version restore records a mutation checkpoint
(`src/local/history.ts`), so every History verb is recoverable through History
itself. Because a restore replaces the working set a running turn may be
reading, the verb refuses concurrent work instead of relying on a
confirmation.

### Files in a Connected Folder

| Verb | In the window | Target | Command shape | Receipt adds | Undo | Conflicts |
|---|---|---|---|---|---|---|
| Add outside material | Drag in from Finder, ⌘V, a drop on the message box | direct verb | `files add --connected-folder <id> --from <p>… [--to <folder>]` | checkpoint id, copied path count | restore the checkpoint | copy and restore point succeed or fail together |
| Move an item | Drag onto a folder row, ⌥⌘V | direct verb | `files move --connected-folder <id> --from <path> --to <folder>` | safety checkpoint id, moved path | restore the safety checkpoint | moving into its own subtree is refused; reserved metadata folders such as `.amplefile/` and `.pi/` are never valid endpoints |
| Rename an item | Right-click → Rename…, Return | direct verb | `files rename --connected-folder <id> --path <p> --name <n>` | safety checkpoint id, prior name | restore the safety checkpoint or rename back | same path policy |
| Delete an item | Right-click → Delete, ⌘⌫ | direct verb | `files delete --connected-folder <id> --path <p>` | safety checkpoint id; the Recently Deleted entry id when the checkpoint could not cover every matched file | the safety checkpoint, or `recently-deleted restore --entry <id>` when the receipt names one | never refuses for coverage reasons; same path policy |
| New folder | Right-click → New Folder Here… | direct verb | `files mkdir --connected-folder <id> --path <folder>` | created path; no safety checkpoint, because creation destroys nothing | `files delete` (an empty folder is fully covered) | an existing name is refused; same path policy |
| New empty file | — | direct verb | `files create --connected-folder <id> --path <p>` | created path; no safety checkpoint, as for `files mkdir` | `files delete` | an existing name is refused; same path policy |
| Content search | Toolbar **Search** | direct verb (content-bearing act read) | `search --connected-folder <id> --query <q> [--scope files\|chats\|all]` | scope only, **not** the query text | n/a | honours ignore rules, skips binary content, and reports when a bound stopped the search rather than implying completeness; the same service as `/api/connected-folders/:id/search` |

The file verbs use the window's own mutation paths and add receipts. When the
safety checkpoint captured everything a delete matched, the delete removes
the item and the checkpoint is its undo. When it could not capture some
matched file (oversized, unreadable, a symbolic link, or excluded, by the
checkpoint's own skip rules), the **whole selected item** moves into Recently
Deleted with a manifest naming each uncovered path and why, so one delete
keeps one undo reference. Deletes in the window are journaled like act verbs,
with the `main-window` surface. History recovery still refuses overlapping
uncovered content, protects nested Connected Folders and excluded
descendants, and reserves affected work against concurrent launches and
ownership changes.

### Recently Deleted

Recently Deleted is the machine-local store under the state root
(`recently-deleted/`, `src/local/recently-deleted-store.ts`) for everything a
deletion could not leave to History. It is not a Connected Folder, not
portable, and not a backup. Each entry records its source Connected Folder,
so the family takes no `--connected-folder`.

What goes there:

- `files delete` of an item the safety checkpoint could not fully cover;
- `connected-folders delete`: the managed folder, together with its
  machine-local History;
- deleting a Worker Chat or an AmpleFile Agent Chat: its transcript;
- removing an imported Skill in Skills & Extensions: its whole folder, with
  its scope (Everywhere or the Connected Folder) and its path inside that
  scope's skills folder, because `.pi/` and Pi's own folder are outside
  History.

Each entry has a manifest: id (`trash-<timestamp>-<hex>`), source Connected
Folder id, original Connected Folder–relative path or folder, kind (`file`,
`folder`, `connected-folder`, or `skill`), a Skill's scope, size, deleted-at,
restore-by, and the receipt id that produced it. The manifest is the commit
marker: a crash leaves either nothing (the source untouched) or a listable
entry whose payload exists.

| Verb | In the window | Target | Command shape | Receipt adds | Undo | Conflicts |
|---|---|---|---|---|---|---|
| List Recently Deleted | Settings → Recently Deleted | direct verb (content-bearing act read) | `recently-deleted list --json` | — | n/a | entries carry the manifest fields above |
| Restore an entry | Settings → Recently Deleted → Restore, the toast's **Undo** | direct verb | `recently-deleted restore --entry <id>` | entry id, kind, restored path or Connected Folder id; the additive restore point for a file or folder | file or folder: its restore point; Connected Folder: `connected-folders delete`; Skill: remove it again | an occupied destination is renamed, never overwritten (`stem (2).ext` / `name-2`), except that a Skill goes back only to its own scope and path, and is refused while a Skill of the same name is installed there, the path is taken, or affected work runs; refused when the source Connected Folder is no longer registered and the entry is not itself a Connected Folder, or when the entry's portable Connected Folder identity is registered elsewhere |

No verb empties Recently Deleted. **Delete Now** in Settings is the only way
to remove one entry early. Retention (default 30 days, 1 to 365, set in
Settings → Recently Deleted) is the only automatic purge; it runs at startup
and about once a day while the app is awake. A tree the store cannot fully
list is never erased by the purge or **Delete Now**: the entry is marked held
and stays until the person restores it or handles the folder outside the
product.

Deletion waits for settled work. Deleting a file, a Chat, or a Connected
Folder is refused while the affected work is running, waiting on an answer,
or still draining after Stop; no second confirmation is added. Deleting a
managed parent is refused until its nested Connected Folders are
disconnected.

Deleting a Connected Folder moves its machine-local History with its folder
into Recently Deleted. If AmpleFile stops between those moves or before the
manifest's final write, startup recovery reconstructs the carried-state
marker or finishes moving the remaining History before clearing the removal
intent. Missing, damaged, or ambiguous destinations keep the state instead of
erasing it; competing History copies are never merged or replaced.

A restored Chat keeps its transcript file name, is refused when that identity
is already taken, and needs its Connected Folder to still be registered.
Creating a Chat with an explicit id, title and lifecycle changes, deletion,
and restoration share one Chat mutation fence through their final filesystem
write, so overlapping operations cannot recreate or rename a deleted Chat.

### Skills & Extensions

The person's surface is the **Skills & Extensions** dialog. Its Add dialog
asks **Where should it live?** and then offers Skill files or a package
source.

| Verb | In the window | Target | Command shape | Receipt adds | Undo | Conflicts |
|---|---|---|---|---|---|---|
| List capabilities | Skills & Extensions → Installed | read lane | `capabilities list --connected-folder <id>` | — | n/a | — |
| Import a skill bundle | Add → Skill files | **prepared verb** | `tools import-skill --scope everywhere\|connected-folder [--connected-folder <id>] --from <path>` | source path, scope, content digest, skill names | Remove Skill (below) | executable content is named in the receipt; blocked while affected work is active |
| Install a catalog capability | Discover → install | **prepared verb** | `tools install --id <catalog-id> --scope … [--connected-folder <id>]` | catalog id, scope, content digest | `tools remove` | the receipt embeds the inspected resource summary the person sees in Skills & Extensions |
| Install a Pi package | Add → package source | **prepared verb** | `tools install --source <pkg> --scope … [--connected-folder <id>]` | source, scope, content digest | `tools remove` | a package with Extensions or install scripts can run code, and the receipt says so, as the desktop review does |
| Update a Pi package | Installed → Update | **prepared verb** | `tools update --source <pkg> --scope … [--connected-folder <id>]` | source, scope, prior and new content digests | reinstall the prior pinned version | updates change runnable bytes; pinned versions stay pinned |
| Turn a resource on or off | Installed → the resource's switch | **prepared verb** (`capability.resource.enabled`) | `tools enable\|disable --path <resource-path> --kind extensions\|skills\|prompts\|themes --scope everywhere\|connected-folder [--connected-folder <id>]` | resource path, kind, scope, enabled state, resource and settings digest | repeat with the opposite state | Pi filters stay authoritative; unrelated entries and scopes survive; refused while affected work runs or the identity changed; single-file package sources cannot be filtered and say so |
| Remove a Pi package | Installed → Remove | direct verb | `tools remove --source <pkg> --scope … [--connected-folder <id>]` | source, scope | reinstall is a fresh prepared verb | blocked while affected work is active |
| Remove an imported Skill | Installed → Skill details → Remove Skill | window only (journaled `skills.remove`, `main-window` surface; no act verb) | — | scope, Skill name, the Recently Deleted entry id | the toast's **Undo**, Settings → Recently Deleted, or `recently-deleted restore --entry <id>` | only Skills in AmpleFile's own import roots; the whole folder moves to Recently Deleted; blocked while affected work is active |

Scope is authority: `--scope everywhere` makes bytes runnable inside the
AmpleFile Agent's own runtime on its next start, and the receipt names that
scope.

### The AmpleFile Agent itself

`agent send|ask|answer|status|result|wait|stop|abort|list` are direct verbs,
joined by `agent overview` ([the overview](amplefile-agent-overview.md)). The
CLI group is `agent`. Automation verbs are in [Automations](automations.md);
`automations enable` is the prepared verb that pins a declaration digest.

### The setup-only boundary

No command shapes. Neither the AmpleFile Agent nor the CLI can perform or
request these; the act lane never grows a verb for them, and a request that
would amount to one is refused at parse time.

| Verb | In the window | Target |
|---|---|---|
| Configure a provider connection, API key, or provider sign-in | Settings → AI Models | **setup-only** (provider credentials) |
| Remove or replace a stored provider credential | Settings → AI Models | **setup-only** |
| Act-token machinery: minting, scope, lifetime | none (app-owned) | **setup-only** |
| **Delete Now** on one Recently Deleted entry, retention, or Limits | Settings → Recently Deleted, Settings → Automations | **window only** (no act verb; nothing a task needs is behind it) |

### Deliberately absent

- **Desktop-session verbs:** reveal in Finder, open with the default app,
  Quick Look, copy a native path, drag out. They act on this desktop's
  windowing session; a receipt for one would mean nothing elsewhere.
- **Navigation and window state:** which folder is shown, the selection,
  panel and sidebar sizes. The AmpleFile Agent reads state through
  [the overview](amplefile-agent-overview.md) instead of driving the
  person's screen.
- **UI preferences:** theme, typography, text size, collapsed folders.
  Machine-local preferences with no product meaning.
- **Self-update:** check, download, install. The updater changes the code
  that enforces everything in this document; it stays a person's action.
- **Answering Extension questions and permission prompts inside a running
  turn:** these render inside the Chat and can carry permission meaning; an
  agent answering them would give an answer the person did not give.
- **Composer slash commands:** `/compact` is a real verb above; the rest are
  conversational conveniences inside a turn.
- **Batch or transactional multi-verb acts:** one request id, one verb, one
  receipt. Composition lives in the AmpleFile Agent's conversation or in a
  declared Automation, never in the protocol.
- **A headless act lane:** every verb needs the running interactive app;
  "Open AmpleFile…" with exit code 6 is the honest failure.

## Conflict rules mirrored from the desktop

1. A Chat's rename, snooze, archive, resume, and compact are refused while
   that Chat's agent turn or compaction is active. One lifecycle change per
   act.
2. A send into an archived or future-snoozed Chat is refused until the Chat
   is resumed; resuming is its own receipted act, never a side effect.
3. Capability mutations (`tools …`) are blocked while affected work is
   active; a catalog reload never silently ends a background turn.
4. Disconnecting a Connected Folder or deleting a managed one suspends the
   Automations that reference it and stops any active run
   ([Automations](automations.md)).
5. Deleting a file, a Chat, or a Connected Folder is refused while affected
   request work is unfinished, waiting on an answer, or draining after Stop.
6. Whole–Connected Folder History restore is refused while any agent turn or
   compaction is active in that Connected Folder, or while an Automation run
   with a files hop targeting it is active.
7. Automation runs obey their scheduler's admission and non-overlap rules.
8. `files delete` never refuses for coverage reasons; paths the safety
   checkpoint cannot cover move into Recently Deleted, and reserved metadata
   folders stay invalid endpoints.

## Receipt schema

`AmpleFileCliActReceiptV1` (`src/local/cli/act-receipts.ts`) carries these
optional fields beyond the baseline:

- `surface`: the authenticated surface that started the act, from the closed
  vocabulary `cli`, `popover`, `main-window`.
- `undoRef`: a typed reference to the prior state an undo needs: prior title
  or name, prior lifecycle state, prior appearance customization ref, safety
  checkpoint id, or Recently Deleted entry id (`recently-deleted-entry`).
  Identifiers and digests only; receipts never hold file contents, message
  text, queries, or secrets.

The journal is append-only and journal-first, rotation never drops an entry
younger than the broker freshness window, and duplicate detection fails
closed. The host keeps accepted ids in memory, reading only what was appended
since it last looked, and cuts an unfinished final line at startup. Renaming a CLI command, flag, or JSON key is a compatibility change:
update the implementation, help, tests, and these docs together.

## Where it lives

| Part | Source | Tests |
|---|---|---|
| Receipt schema | `src/local/cli/act-receipts.ts` | `tests/amplefile-cli-act-receipts.test.ts` |
| Act argv, command table, setup-only refusal | `src/local/cli/act-commands.ts` | `tests/amplefile-cli-act-protocol.test.ts` |
| Facade over the route internals | `src/local/cli/act-facade.ts`, `src/local/server.ts` | `tests/amplefile-act-facade.test.ts` and the owning domain suites |
| History-restore fencing and `chat compact` | `src/local/amplefile-kernel.ts` | `tests/amplefile-kernel.test.ts` |
| Prepared verbs | `src/local/prepared-acts.ts` | `tests/prepared-acts.test.ts` |
| Recently Deleted | `src/local/recently-deleted-store.ts` | `tests/amplefile-recently-deleted-store.test.ts`, `tests/amplefile-cli-recently-deleted-verbs.test.ts`, `tests/recently-deleted-settings.test.ts` |
| Surface attribution | `src/local/requests/request-store.ts` | `tests/agent-requests.test.ts`, `tests/amplefile-agent-api.test.ts` |
| Desktop host and shims | `desktop/src/amplefile-cli-host.ts`, `desktop/cli/` | `tests/desktop-amplefile-cli-host.test.ts`, `tests/desktop-cli-packaging.test.ts` |
| Help and read-lane text | `src/local/cli/commands.ts` | `tests/amplefile-cli-protocol.test.ts` |
| The AmpleFile Agent's taught behavior | `src/local/amplefile-agent-instructions.ts` | `tests/amplefile-agent-conversation.test.ts` |
