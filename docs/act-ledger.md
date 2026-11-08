# The AmpleFile agent act ledger

**Status: shipped contract reference.** The verb ledger shipped with the AmpleFile agent
build, and its decisions were promoted on 2026-08-11 into
[the AmpleFile agent](amplefile-agent-decisions.md) decision register, [the AmpleFile agent layer](amplefile-agent-and-cli.md)
(receipts, the act-lane scope and prepared-acts bullets, the
verification map), [the product model](product-model.md) (the act-lane
sentence), `AGENTS.md` (the family list and the appearance bullet),
`README.md`, `SECURITY.md`, and `PRIVACY.md`, with
[Connected Folder customization](connected-folder-customization.md) acknowledging the receipted
appearance path. `src/local/cli/act-commands.ts`,
`src/local/cli/act-facade.ts`, and their suites are the implementation
authority. This document retains what canon does not carry: the per-verb
classification tables, the consolidated conflict rules, the receipt schema
record, and the deliberate absences. The 2026-09-10 supersession is recorded
in [Receipts, not gates](receipts-not-gates.md);
Consecrations (archived in the work-fold repository) is retained only for threat-model
residuals. Automation and overview verbs are owned by
[Automations](automations.md) and [the overview](amplefile-agent-overview.md);
the promotion record by
Fold integration (archived in the work-fold repository).

The doctrine, in one paragraph: every product verb is a receipted act-lane
verb except the setup-only boundary, which the AmpleFile agent can neither do nor
request. Verbs that make bytes runnable, widen a standing power, or delete
are **prepared verbs**: the host prepares typed facts, pins exact
identities, journals first, rechecks at effect time, executes at most once
through a fenced task, never auto-retries, and returns the receipt like any
other verb — immediately. Deletion is reversible through History or Recently
deleted.

## Terms the ledger uses

| Target | Meaning |
|---|---|
| **direct verb** | The AmpleFile agent performs it through the act lane: explicit selection, journal-first receipt, at-most-once execution, desktop conflict rules. |
| **prepared verb** | A direct verb whose execution shape is prepare → pin → journal-first → fenced execute → receipt, run on the call that asks. Covers Pi package and skill-bundle install/update, automation enablement, and managed Connected Folder deletion. |
| **reversible deletion** | A delete whose undo is a History restore point or a Recently-deleted entry (`recently-deleted restore`). No product verb destroys permanently; retention does. |
| **setup-only boundary** | The AmpleFile agent can neither perform nor request it: act-token machinery, provider credentials, settings administration, and anything that widens the set of principals controlling the AmpleFile agent. |
| **deliberately absent** | Not a product verb — desktop-session mechanics, machine-local UI preference, or a surface whose meaning does not survive leaving the desktop. Listed so absence is a decision, not a gap. |

The tables' "Fold today" column is historical: it records what the act lane
had before the AmpleFile agent shipped (`act`/`read`/`none`, audited 2026-08-10). Every
row's target class and command shape is now shipped behavior, and every token
in this record is the token the build ships.

## Rules every verb inherits

Every mutation answers the same five questions the same way, so the tables
record only per-verb additions.

1. **Who journals it.** The act executor
   (`src/local/cli/act-commands.ts`) appends an `accepted` line to
   `cli/receipts/act.jsonl` (`src/local/cli/act-receipts.ts`) **before** the
   mutation runs; an unwritable journal refuses the command. The owning
   domain service then keeps its own durable records exactly as it does for
   the renderer (History checkpoints, transcript lifecycle events,
   automation run receipts).
2. **What the receipt contains.** Baseline: version, timestamp, request id,
   command, outcome (`accepted`/`ok`/`error`/`rejected`), error code,
   connected-folder/conversation ids, checkpoint id, kernel task id, and management
   `parentTaskId` lineage — plus the fields under
   [Receipt schema](#receipt-schema). Receipts stay content-light:
   identifiers, digests, and names, never file contents, message text,
   search queries, or credentials.
3. **How it is revoked or undone.** Per verb, in the tables. The general
   shapes: in–Connected Folder file mutations are undone through the safety restore
   point every mutation already records; lifecycle and naming verbs are
   undone by the inverse verb using the prior state captured in the receipt;
   authority verbs are revoked by their narrow-direction twin (revoke,
   disable, disconnect), which is always direct; deletions are
   undone through the restore point or `recently-deleted restore --entry <id>`.
4. **What happens on failure mid-act.** The domain service's existing
   atomicity applies unchanged — placement and restore point succeed or fail
   together, Connected Folder removal uses the durable cleanup outbox. The executor appends a terminal `error`
   receipt; a crash between `accepted` and the terminal line is itself the
   honest signal that the outcome was interrupted. A failed or interrupted
   prepared verb is never auto-retried; another attempt is a fresh call.
5. **How replay is prevented.** The broker's freshness window and pending
   response dedup, then the journal's `accepted` records as the durable
   at-most-once ledger: a duplicated request id is refused outright, and a
   damaged journal fails closed rather than risk re-execution. Journal
   rotation holds entries at least as long as the freshness window.

Act-protocol conventions carry over unchanged: the current act-protocol
envelope (version advanced 2026-09-10; see `src/local/cli/act-protocol.ts`
for the number), per-launch act token, explicit `--connected-folder` on every
Connected Folder–scoped write (never working-directory resolution), `--parent-task`
lineage validated against an active AmpleFile agent request, and `--json`
output. Prepared verbs use the same grammar and return the receipt of their
immediate execution.

## The ledger

Columns: the verb; where a human performs it; what the AmpleFile agent had before the
build (`act`/`read`/`none`); the target class; the command shape; what the
receipt adds beyond baseline; the undo or revocation path; and the conflict
rules, which mirror the desktop's.

### Connected Folder lifecycle

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| Create Connected Folder | Header menu, palette, onboarding | act | direct verb | `connected-folders create --name <n>` | spaceId | `connected-folders unregister` (folder remains) | name collision rejected |
| Register folder | Header menu, native picker | act | direct verb | `connected-folders register --path <abs>` | spaceId | `connected-folders unregister` revokes runtime authorization | already-registered path rejected |
| Rename Connected Folder | Manage Connected Folders pane | none | direct verb | `connected-folders rename --connected-folder <id> --name <n>` | prior name | rename back (prior name in receipt) | duplicate exact name rejected as ambiguous-making |
| Unregister Connected Folder | Manage Connected Folders → Remove (linked) | none | direct verb | `connected-folders unregister --connected-folder <id>` | storage kind | re-register the folder; `.amplefile/` identity persists | on success, automations referencing it suspend with active runs stopped ([Automations](automations.md)) |
| Delete managed Connected Folder's folder | Manage Connected Folders → Delete (managed) | none | **prepared verb** | `connected-folders delete --connected-folder <id>` | trash entry id, canonical root | `recently-deleted restore --entry <id>` re-registers the Connected Folder from Recently deleted with its portable identity, its Chats, and its History | the claimed folder is moved into Recently deleted, never erased, so a legacy `.workspace/` tree moves like any other and the retention purge is what fails closed on it |
| Apply appearance | Customize Connected Folder → Import proposal | none | direct verb (argued below) | `connected-folders appearance apply --connected-folder <id> (--proposal <path> \| [--banner-image <path>] [--icon <name>] [--color <#rrggbb>])` | prior customization ref | `connected-folders appearance undo --connected-folder <id>` | proposal must parse as the typed `connected-folder-appearance` proposal; nothing else is accepted |
| Reset appearance | Customize Connected Folder → Reset | none | direct verb | `connected-folders appearance reset --connected-folder <id>` | prior customization ref | `connected-folders appearance undo` | — |
| Undo appearance | — (the desktop re-imports or resets instead) | none | direct verb | `connected-folders appearance undo --connected-folder <id>` | restored and displaced customization refs | apply the displaced ref again — undo is its own inverse | refused with a typed error when the receipt chain records no prior customization ref for that Connected Folder, including when the current appearance was last changed on the desktop rather than through a receipted act |
| Inspect Worker preferences | Settings → AI Models | none | direct verb (content-bearing act read) | `connected-folders worker show --connected-folder <id>` | — | n/a | returns only connected model choices plus the current model and instruction text; provider credentials never enter the result |
| Set the default model for new Chats | Settings → AI Models | none | direct verb | `connected-folders worker model --connected-folder <id> --provider <id> --model <id>` | provider and model ids | choose the prior model again | selected model must exist and already have configured auth; fenced against active agent or compaction work; existing Chat sessions keep their session model |
| Set or clear Connected Folder instructions | Settings → AI Models | none | direct verb | `connected-folders worker instructions --connected-folder <id> (--instructions <text> \| --clear)` | updated character count or cleared marker — never text | set the prior text again or clear | bounded validated text; fenced against active agent or compaction work; applies to subsequent turns after scoped client invalidation |

The desktop couples managed Connected Folder removal with folder deletion in one
confirm dialog; the ledger splits them. Unregistration is recoverable and
authority-narrowing (a direct verb, valid for both storage kinds, per the
contributor contract's "registration removal remains available without
folder deletion"), while deleting the managed folder is a prepared verb that
moves it into Recently deleted.

**The appearance argument** (recorded verdict: direct verb). Appearance is
cosmetic, machine-local, authority-free, and already has an inert typed
proposal format; requiring a human import click through the AmpleFile agent would spend
attention on the lowest-stakes mutation in the product. The honest
counterargument is impersonation — a prompt-injected fold restyling one
Connected Folder to resemble another — and the mitigations are structural: the verb
accepts only the typed proposal file, the receipt captures the prior
customization for one-act undo, the change surfaces in
[the overview](amplefile-agent-overview.md)'s "what changed" list, and appearance cannot
touch the AmpleFile agent's own chrome, Settings, or any trust surface. If dogfooding
shows appearance changes used to confuse, the escalation path is a register
decision about this one row — never a gate reintroduced elsewhere as a
convenience.

### Chats

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| Create Chat | New Chat button, palette | act | direct verb | `chat create --connected-folder <id>` | conversationId | archive it | — |
| Send message | Composer | act | direct verb | `chat send …` | taskId | `chat abort` while running | send into running work rejected; archived → "Restore this Chat before sending"; snoozed likewise |
| Abort turn | Stop button | act | direct verb | `chat abort …` | — | n/a | no active turn → honest no-op |
| Status / result / list | Chat UI, navigator | act | direct verb (content-bearing act reads) | shipped | — | n/a | — |
| Rename Chat | Chat actions popover | none | direct verb | `chat rename --connected-folder <id> --conversation <id> --title <t>` | prior title | rename back; person-authored rename still always wins over generated titles | refused while that Chat's turn or compaction runs (409) |
| Snooze Chat | Chat actions popover presets | none | direct verb | `chat snooze --connected-folder <id> --conversation <id> --until <ISO>` | prior lifecycle state | `chat resume` | future time required; one lifecycle change per act; refused while turn/compaction runs; closes the open tab but never rewrites the transcript |
| Archive Chat | Chat actions popover | none | direct verb | `chat archive --connected-folder <id> --conversation <id>` | prior lifecycle state | `chat resume` | same as snooze |
| Resume Chat | Popover "Resume now" / "Restore to Active", read-only banner | none | direct verb | `chat resume --connected-folder <id> --conversation <id>` | prior lifecycle state | re-archive or re-snooze | refused while turn/compaction runs |
| Compact Chat | Composer `/compact` | none | direct verb | `chat compact --connected-folder <id> --conversation <id>` | kernel task id | none — compaction is additive summarization, not deletion | refused while a turn runs; registers the same kernel `compaction` task and capability-mutation fencing as the renderer |
| Copy Chat | Chat actions popover "Make a Copy" | act | direct verb | `chat copy --connected-folder <id> --conversation <id> [--title <t>] [--task <own-task-id>] [--message <text>]` | copied-from Chat, message count, started task id | archive or delete the copy; the original is never written | a turn still running is left out of the copy; refused while compacting; with `--task`, only the caller's own Chat or one it handed work to |
| Steer a running Chat | Composer while a turn runs | act | direct verb | `chat steer --connected-folder <id> --conversation <id> [--task <own-task-id>] --message <text>` | running task id | n/a (delivered after the current step) | refused when no turn runs; with `--task`, only a Chat the caller's Chat handed work to |
| Report a result | — (Worker or outside harness) | act | direct verb | `chat report --connected-folder <id> --task <own-task-id> --summary <text> [--data <json-or-@path>] [--file <connected-folder-path>]... [--outcome …]` | outcome and file count — never the summary or data | none — a report is a record, not a mutation | `--task` must be the caller's own running turn; summary ≤ 4 MiB and data ≤ 16 MiB; each file must be inside the Connected Folder |
| Ask a question | — (the same callers) | act | direct verb | `chat ask --connected-folder <id> --task <own-task-id> --question <text> [--to person\|parent]` or `agent ask --task <own-task-id> --question <text>` | question id and respondent — never the text | none — the question stays on record; a root Stop closes it | `--to parent` on a root reaches the person and says so; the asking turn is never suspended; the request reads `waiting` |
| Answer a question | Composer (free-text reply) | act | direct verb | `chat answer --connected-folder <id> --question <id> --answer <text>` or `agent answer --question <id> --answer <text>` | question id and the continuation task id — never the answer | none — one accepted answer, one linked continuation turn | refuses a second answer, a stopped request, a Connected Folder that does not own the question, and a Chat whose turn or compaction is running (the question stays open); the turn store dedups the continuation under `answer-<question-id>` |
| Hand work on | — (the same callers) | act | direct verb | `chat handoff --connected-folder <id> --task <own-task-id> --to-connected-folder <id-or-name> [--to-conversation <id>] (--message <text> \| --message-file <path>) [--file <connected-folder-path>]...` | destination Connected Folder, new Chat, task, restore point, copy count | the destination's restore point (copies are additive, exactly `files add`'s path) | concurrency is checked before any copy; copy before acceptance so a refused copy never leaves a started Chat; same Connected Folder handoff takes no `--file` |

### Requests

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| List requests | the overview | act | direct verb (content-bearing act read) | `requests list` | — | n/a | newest 50 roots; `truncated` says when more exist; no `--connected-folder`, no lineage |
| Show a request | `agent status --task`, the overview | act | direct verb (content-bearing act read) | `requests show --request <id>` | — | n/a | the root and its subtree with questions (text), results (summary and data), turns, usage; the human form clamps, `--json` carries them whole |

### Background jobs

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| Start a background job | — (`job_start` in a Chat) | act | direct verb | `jobs start --connected-folder <id> --task <own-task-id> (--command <cmd> \| --command-file <path>) [--name <label>] [--cwd <folder>] [--timeout <s>]` | job id, state, starting task — never the command text | `jobs stop`, or Stop on its request; History captures what it wrote when it ends | `--task` must be the caller's own running turn of a request that can continue; refused past the running-jobs bound; journaled before the process starts and never re-run |
| List background jobs | the work line | act | direct verb (act read) | `jobs list --connected-folder <id> [--conversation <id>] [--running]` | — | n/a | only that Connected Folder's jobs |
| Show a background job | the work line | act | direct verb (content-bearing act read) | `jobs show --connected-folder <id> --job <id>` | — | n/a | carries the command, state, exit, History coverage, and delivery |
| Read a job's output | — (`job_output` in a Chat) | act | direct verb (content-bearing act read) | `jobs output --connected-folder <id> --job <id> [--offset <line>] [--limit <lines>] [--wait <s>] [--until <pattern>] [--task <own-task-id>]` | — | n/a | at most 2,000 lines or 50 KB per read; `--task` naming a running turn in the job's own Chat delivers a finished job |
| Stop a background job | the work line's Stop (whole request) | act | direct verb | `jobs stop --connected-folder <id> --job <id>` | job id, final state | none — a stopped job is never re-run | SIGTERM to the process group, SIGKILL after 5 seconds; a stopped job still wakes its Chat once |

A job belongs to the request its turn started it in: the request reads
`working` while the job runs, and its end reaches the Chat once — through a
read, the next turn's context, or one `continuation-<request-id>-<n>`
follow-up ([Background jobs](background-jobs.md), F31–F33).

`chat wait` and `agent wait` stay shim-side polls and settle on either a
terminal turn or a task that is waiting on an answer, printing the status
document with `waiting` set in the second case (exit 0). The continuation the
host starts when a root AmpleFile agent request's handed-out work settles after
the AmpleFile agent's turn ended is a `system`-actor turn joined to that request under
`continuation-<request-id>-<n>`; never after a root Stop and never started by
a restart.

Lifecycle events are append-only entries in the Chat's portable
`.amplefile/conversations/` log, exactly as on the desktop; the act lane
adds receipts, not a second lifecycle store. The desktop's snooze presets
stay renderer conveniences — the verb takes an explicit `--until`.

### History

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| List restore points | History pane | none | direct verb (content-bearing act read) | `history list --connected-folder <id>` | — | n/a | — |
| Save restore point | History pane, palette | none | direct verb | `history save --connected-folder <id> [--label <t>]` | checkpointId, `created` flag | none needed (additive) | unchanged files → honest "already matches" result, not a new checkpoint |
| Restore a restore point | History pane → Restore | none | direct verb | `history restore --connected-folder <id> --checkpoint <id>` | restored checkpointId + pre-restore safety checkpointId | restore the safety checkpoint the act itself recorded | **refused while any agent turn or compaction is active in that Connected Folder, or while an automation run with a files hop targeting that Connected Folder is active** — shared with desktop recovery |
| List file versions | File version history modal | none | direct verb (content-bearing act read) | `history versions --connected-folder <id> --path <p>` | — | n/a | — |
| Restore file version | File version history modal | none | direct verb | `history restore-file --connected-folder <id> --path <p> --version <sha256>` | safety checkpointId | restore the safety checkpoint (the modal's own Undo does the same) | missing version → not-found; folder at path → refused |

Whole–Connected Folder restore records a `pre_restore` safety checkpoint and
file-version restore records a mutation checkpoint (`src/local/history.ts`),
so every History verb is recoverable through History itself. Because a
restore replaces the working set a running turn may be reading, the act verb
refuses concurrency instead of trusting a confirm dialog the AmpleFile agent has no way
to honestly present.

### Files in a Connected Folder

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| Add outside material | Upload button, drag-drop, chat drop | act | direct verb | `files add --connected-folder <id> --from <p>… [--to <folder>]` | checkpointId, copied paths count | restore the checkpoint | copy and restore point succeed or fail together |
| Move entry | Drag in tree, context menu | none | direct verb | `files move --connected-folder <id> --from <connected-folder-path> --to <connected-folder-folder>` | safety checkpointId, moved path | restore the safety checkpoint | into-own-subtree refused; `.amplefile/`, `.pi/`, `.workspace/` never valid endpoints (same path policy as the renderer) |
| Rename entry | Context menu → Rename | none | direct verb | `files rename --connected-folder <id> --path <p> --name <n>` | safety checkpointId, prior name | restore the safety checkpoint or rename back | same path policy |
| Delete entry | Context menu → Delete (+ Undo toast) | none | direct verb | `files delete --connected-folder <id> --path <p>` | safety checkpointId; the Recently-deleted entry id when the checkpoint could not cover every matched file | the safety checkpoint, or `recently-deleted restore --entry <id>` when the receipt names one — the durable form of the desktop's Undo toast | never refuses for coverage reasons; `.amplefile/`, `.pi/`, `.workspace/` remain invalid endpoints |
| New folder | Context menu → New folder here | none | direct verb | `files mkdir --connected-folder <id> --path <folder>` | created path — no safety checkpoint, stated deliberately: creation is additive and destroys nothing | `files delete` (an empty folder is fully checkpoint-coverable) | existing name refused; same `.amplefile/`/`.pi/`/`.workspace/` path policy |
| New empty file | Context menu → New file here | none | direct verb | `files create --connected-folder <id> --path <p>` | created path — same no-checkpoint note as `files mkdir` | `files delete` | existing name refused; same path policy |
| Content search | Files search field, Chats search | none | direct verb (content-bearing act read) | `search --connected-folder <id> --query <q> [--scope files\|chats\|all]` | scope only — **not** the query text | n/a | honours ignore rules, skips binary/oversized files, and reports when a bound stopped the search rather than implying completeness — same contract as `/api/connected-folders/:id/search` |

The file verbs use the renderer's own mutation paths and add receipts.
Desktop and CLI delete both succeed on every coverable or uncoverable path.
When the safety checkpoint captured everything it matched, the delete removes
the entry and the checkpoint is its undo. When it could not capture some
matched file (oversized, unreadable, symlink, excluded — the checkpoint's own
skip rules), the **whole selected entry** is moved into Recently deleted with
a manifest naming each uncovered path and why, so one delete keeps one undo
reference instead of splitting across two recovery stores. Both desktop
deletions are journaled like act verbs, with the `main-window` surface. History recovery still refuses overlapping uncovered content,
protects registered child Connected Folders and excluded descendants, and reserves
affected work against concurrent launches and ownership changes.

### Recently deleted

The machine-local trash under the state root (`recently-deleted/`) is Connected Folder–free: each
entry records its source Connected Folder, so the family takes no `--connected-folder`.

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| List Recently deleted | Settings → Recently deleted | none | direct verb (content-bearing act read) | `recently-deleted list --json` | — | n/a | entries carry source Connected Folder id, original Connected Folder–relative path or folder, kind (`file`, `folder`, `connected-folder`, `skill`; an earlier build's app entries keep their `app-storage`, `app-retained`, `app-release`, or `app-studio` kind), a Skill's `scope`, size, deleted-at, restore-by, and the producing receipt id |
| Restore an entry | Recently deleted → Restore | none | direct verb | `recently-deleted restore --entry <id>` | entry id, kind, restored path or Connected Folder id; the additive restore point for a file or folder | file/folder: its restore point; Connected Folder: `connected-folders delete`; Skill: remove it again | an occupied destination is collision-renamed, never overwritten (`stem (2).ext` / `name-2`), except that a Skill goes back only to its own scope and path, and is refused while a Skill of the same name is installed in that scope or the path is taken, and while affected work runs (capability-mutation fencing); refused when the source Connected Folder is unregistered and the entry is not itself a Connected Folder, when the entry's portable Connected Folder identity is registered elsewhere, or when the entry is something an earlier build kept for Connected Folder apps — that stays listed until it expires and can be deleted now, never restored |

No verb empties Recently deleted. **Delete now** is a Settings-only action;
retention (default 30 days, adjustable in Settings → Recently deleted
deleted) is the only automatic purge, run on app start and daily while awake.
Neither the purge nor **Delete now** ever erases an entry whose tree holds
legacy `.workspace/` records: it is marked held and stays until the person
handles the folder outside the product (the clean-break rule). The
producers are `files delete` for uncoverable paths and `connected-folders
delete`.

### Pages (removed)

Pages (`page.json` folders run in a page tab), their Data view, and the
`pages validate` verb were removed on 2026-11-07, the same day as Publish,
the `page.publish` prepared act, and `pages publish|unpublish|list`. There
are no `pages` verbs. A request record that names `pages.share`,
`pages.share-app`, `pages.publish`, or `pages.unpublish` still loads with
that action skipped, and an app-state `pages/` folder from an earlier build
is left untouched.

### Library (removed)

The desktop Library went on 2026-09-25 and the `library` act family, its
`/api/resources` routes, and its code on 2026-10-10. There are no Library
verbs; an app-state `resources/` folder from an earlier build is left
untouched.

### Checks (removed)

Checks went on 2026-11-07, with the whole `checks` act family and its
read-lane status command. There are no Check verbs; Check data an earlier
build stored is left on disk unread.

### Skills & Extensions

*Amended 2026-09-25:* the human surface is the **Skills & Extensions** popup
opened by the rail's Add button; "Add → Skill files" and "Add → package source"
are the two choices its Add dialog offers after asking **Where should it
live?**.

| Verb | Human surface | Fold today | Target | Command shape | Receipt adds | Undo / revocation | Conflicts |
|---|---|---|---|---|---|---|---|
| List capabilities | Skills & Extensions → Installed | read | unchanged | `capabilities list --connected-folder <id>` | — | n/a | — |
| Import skill bundle | Add → Skill files | none | **prepared verb** | `tools import-skill --scope everywhere\|connected-folder [--connected-folder <id>] --from <path>` | source path, scope, content digest, enumerated skill names | Remove Skill (below) | executable content is named in the receipt; blocked while affected work is active (capability-mutation fencing) |
| Install catalog capability | Discover → install | none | **prepared verb** | `tools install --id <catalog-id> --scope … [--connected-folder <id>]` | catalog id, scope, content digest | `tools remove` | the receipt embeds the inspected resource summary the person would see in Skills & Extensions |
| Install Pi package | Add → package source | none | **prepared verb** | `tools install --source <pkg> --scope … [--connected-folder <id>]` | source, scope, content digest | `tools remove` | a package with Extensions or install scripts is a code-execution act and the receipt names it, exactly as the desktop review does |
| Update Pi package | Installed → Update | none | **prepared verb** | `tools update --source <pkg> --scope … [--connected-folder <id>]` | source, scope, prior and new content digests | reinstall the prior pinned version | updates change runnable bytes; pinned versions stay pinned |
| Enable / disable native resource | Installed → resource switch | none | **prepared verb** (`capability.resource.enabled`) | `tools enable\|disable --path <resource-path> --kind extensions\|skills\|prompts\|themes --scope everywhere\|connected-folder [--connected-folder <id>]` | resource path, kind, scope, enabled state, resource/settings digest | repeat with the opposite enabled state | Pi filters remain authoritative; unrelated entries and scopes survive; refused while affected work runs or identity changes; single-file package sources cannot be filtered and give a clear limitation |
| Remove Pi package | Installed → Remove | none | direct verb | `tools remove --source <pkg> --scope … [--connected-folder <id>]` | source, scope | reinstall is a fresh prepared verb | blocked while affected work is active — the kernel's capability-mutation fencing, unchanged |
| Remove imported Skill | Installed → Skill details → Remove Skill | none | **desktop-only** today (journaled `skills.remove`, `main-window` surface; no act verb yet) | — | scope, Skill name, the Recently deleted entry id | the toast's **Undo**, Settings → Recently deleted, or `recently-deleted restore --entry <id>` (2026-10-22) | only Skills in AmpleFile's own import roots; the whole folder moves to Recently deleted; blocked while affected work is active |

Scope is authority: `--scope everywhere` makes bytes runnable inside the AmpleFile agent's
own runtime on next start; the receipt names that scope for what it is.

### Connected Folder apps and App Studio (removed)

Connected Folder apps and App Studio went on 2026-11-07, with the whole
`apps` act family (proposals, previews, grants, connections, app
automations, `apps invoke`, storage, Releases, installs, and uninstall) and
the `app.*` prepared acts. There are no app verbs. Recently deleted entries
and request records an earlier build wrote for apps are tolerated on load,
and nothing creates them anymore.

### The AmpleFile agent itself

`agent send|ask|answer|status|result|wait|stop|abort|list` are shipped direct verbs,
joined by `agent overview` ([the overview](amplefile-agent-overview.md)). The CLI group
keeps the contract name `agent`; "the AmpleFile agent" is user-facing copy per
[The AmpleFile agent](amplefile-agent-decisions.md). Automation verbs are in [Automations](automations.md)
(`automations enable` is the prepared verb that pins a declaration digest);
Recently deleted above.

### Settings and fold administration — the setup-only boundary

No command shapes. The AmpleFile agent can neither perform nor request these; the act
lane never grows a verb for them, and a request that would amount to one is
refused at parse time.

| Verb | Human surface | Target |
|---|---|---|
| Configure a provider connection, API key, or provider OAuth | Settings → AI Models | **setup-only** (provider credentials) |
| Remove or replace stored provider credential | Settings → AI Models | **setup-only** |
| Act-token machinery: minting, scope, lifetime | none (app-owned) | **setup-only** |
| Delete now (purge one Recently-deleted entry early) or change Limits | Settings → Recently deleted or Settings → Automations | **desktop-only** (no act verb; nothing a task needs is behind it) |

Web Access administration and browser pairing left this table on 2026-11-07,
when Web Access was removed from the desktop.

### Deliberately absent

Absences that are decisions, not gaps:

- **Desktop-session verbs** — reveal in OS, open with native app, Quick
  Look preview, copy native path, native drag out. They act on this
  desktop's windowing session; an AmpleFile agent verb would be meaningless from a
  phone and a lie in a receipt.
- **Navigation and workspace state** — switching Connected Folders, opening tabs,
  selecting files, rail modes, pane sizes. Connected Folder–bound tabs are a desktop
  contract; the AmpleFile agent reads state through [the overview](amplefile-agent-overview.md)
  instead of driving the person's screen.
- **UI preferences** — theme, typography, text size, collapsed folders.
  Machine-local preferences with no product meaning.
- **AmpleFile self-update** — check, download, install. The updater changes
  the code that enforces everything in this document; it stays a
  desktop-human action and gains no AmpleFile agent verb.
- **Answering extension-UI and permission prompts inside a running turn** —
  these render inside the Chat surface and can carry permission semantics;
  the AmpleFile agent answering them programmatically would be an answer the person
  did not give. They surface as needs-you questions in the overview and are
  answered on a chat surface by the person.
- **Composer slash commands as an AmpleFile agent surface** — `/compact` graduated to a
  real verb above; the rest remain conversational conveniences inside a
  turn, not product verbs.

## Conflict rules mirrored from the desktop

Consolidated, so implementations and tests can point at one list:

1. A Chat's rename, snooze, archive, resume, and compact are refused while
   that Chat's agent turn or Chat compaction is active (the routes'
   existing 409s). One lifecycle change per act.
2. A send into an archived or future-snoozed Chat is refused until the Chat
   is resumed — resuming is its own receipted act, never a side effect.
3. Capability mutations (`tools …`) are
   blocked while affected work is active; a catalog reload can never
   silently terminate a background turn.
4. Connected Folder unregistration and managed-folder deletion suspend
   automations referencing that Connected Folder, stopping any active run
   ([Automations](automations.md)).
5. Managed recursive deletion fails closed when the claimed tree contains
   preserved `.workspace/` data.
6. Whole–Connected Folder History restore is refused while any agent turn
   or compaction is active in that Connected Folder, or while an automation run with a files hop targeting that Connected Folder is active
   (the desktop uses the same reservation and refusal).
7. Automation runs obey their scheduler's admission and non-overlap rules.
8. `files delete` never refuses for coverage reasons; paths the safety
   checkpoint cannot cover (oversized, unreadable, symlink) move into
   Recently deleted, and `.amplefile/`, `.pi/`, `.workspace/` stay invalid
   endpoints.

## Receipt schema

`AmpleFileCliActReceiptV1` (`src/local/cli/act-receipts.ts`) carries these
optional fields beyond the baseline; readers accept every prior version:

- `surface` — the authenticated surface that initiated the act, from the
  closed vocabulary `cli`, `popover`, `main-window`. Lines written before
  Web Access was removed on 2026-11-07 may carry `remote_web` with browser
  and grant ids; readers still accept them.
- `undoRef` — a typed reference to the prior state an undo verb needs:
  prior title or name, prior lifecycle state, prior appearance
  customization ref, safety checkpoint id, Recently-deleted entry id
  (`recently-deleted-entry`). Identifiers and digests
  only; receipts never grow file contents, message text, queries, or
  secrets.

The act protocol version advanced on 2026-09-10; readers accept every prior
version, and receipts written before that date may still carry the retired
`decisionId` and `policyId` fields and the retired `policy` and
`unrestricted` surfaces. New receipts never do.

The journal keeps its existing properties: append-only, journal-first,
rotation that never drops an entry younger than the broker freshness
window, fail-closed duplicate detection.

## Implementation record

The ledger's plan items shipped as follows (suites named in
[the AmpleFile agent layer](amplefile-agent-and-cli.md)'s verification map):

1. Receipt schema v2 — `src/local/cli/act-receipts.ts`; `tests/amplefile-cli-act-receipts.test.ts`.
2. Act argv and command table, with parse-time setup-only refusal — `src/local/cli/act-commands.ts`; `tests/amplefile-cli-act-protocol.test.ts`.
3. Facade growth over the exact route internals — `src/local/cli/act-facade.ts`, `src/local/server.ts`; `tests/amplefile-act-facade.test.ts` plus the owning domain suites.
4. History-restore fencing and `chat compact` — `src/local/amplefile-kernel.ts`; `tests/amplefile-kernel.test.ts`.
5. Prepared verbs returning receipts — `src/local/prepared-acts.ts`; `tests/prepared-acts.test.ts`.
6. Surface attribution — `src/local/requests/request-store.ts`; `tests/agent-requests.test.ts`, `tests/amplefile-agent-api.test.ts`.
7. Desktop host and shims — `desktop/src/amplefile-cli-host.ts`, `desktop/cli/`; `tests/desktop-amplefile-cli-host.test.ts`, `tests/desktop-cli-packaging.test.ts`.
8. Help and read-lane text — `src/local/cli/commands.ts`; `tests/amplefile-cli-protocol.test.ts`.
9. Management-instruction teaching — `src/local/amplefile-agent-instructions.ts`; `tests/amplefile-agent-conversation.test.ts`.
10. Documentation promotion — recorded in Fold integration (archived in the work-fold repository).
11. Receipts, not gates (2026-09-10) — reclassification of every formerly gated row to a prepared or direct verb, `files destroy` removed, the `recently-deleted` family, `apps list|invoke` (removed with apps on 2026-11-07), and `automations enable`; recorded in [Receipts, not gates](receipts-not-gates.md).

## Deliberately not in this design

- **Gate machinery.** No pending store, cards, expiry, denial memory,
  standing rules, or authority mode — removed 2026-09-10 and not to be
  reintroduced as a convenience.
- **A headless act lane.** Every verb still requires the running
  interactive app; "Open AmpleFile…" with exit code 6 stays the honest
  failure.
- **Caller-authentication changes.** The per-launch act token keeps its
  documented same-user posture; the ledger added attribution and lineage,
  not a new principal model.
- **Batch or transactional multi-verb acts.** One request id, one verb,
  one receipt. Composition lives in the AmpleFile agent's conversation or in a
  declared automation, never in the protocol.
- **Library organization controls** — moot: the Library was removed
  (desktop 2026-09-25, CLI 2026-10-10).
- **Driving the desktop UI** — tabs, selection, navigation, preferences,
  and the updater remain outside the act lane, as listed under deliberately
  absent.
- **Renaming CLI contracts without a migration.** The 2026-10-10 vocabulary
  migration renamed command tokens, flags, and JSON keys to the interface's
  words together with a one-time state migration; any further rename needs
  the same treatment (see [the vocabulary glossary](../scripts/vocabulary/GLOSSARY.md)).
