# Automations: declared cross–Connected Folder steps

An **Automation** is fixed, deterministic app work on a reviewed trigger. It is
not an agent scheduler and does not create a second kind of Worker. Code, CLI
verbs, routes, and storage say `automation`/`automations`.
`src/local/automations/` (declarations, store, executor) and its suites are the
implementation authority. This document holds the trigger vocabulary and its
exclusions, the declaration and step contracts, the executor's failure
semantics, the lifecycle record, and the bounds.

An Automation is a machine-local, inert-until-enabled declaration of
deterministic steps that move work between Connected Folders: start a Worker
Chat with a fixed message, copy files from one Connected Folder into another
with a History restore point, or message the AmpleFile agent. App code executes
it on the shared scheduler discipline, never an open-ended Worker conversation,
and it is the only thing above Connected Folders that runs unattended. An
Automation is not a workflow language: no conditions, no branching, no
retries, no loops, no expression templating, and no model deciding which step
runs next. Agentic work happens inside a Chat step, run by that Connected
Folder's own Worker with that Connected Folder's own authority; the executor
itself stays deterministic.

Enabling an Automation is one receipted call that pins the declaration digest.
**Settings → Automations** is the management surface.

## The rule this design enforces

Connected Folder Chat transcripts are portable: `.amplefile/conversations/`
travels with the folder. Cross–Connected Folder work run inside a Connected
Folder Chat would write cross–Connected Folder context into a folder that
travels — a leak no convenience justifies. Automations enforce the boundary
structurally:

- The declaration, enablement grant, cadence anchor, health state, and every
  run receipt are machine-local application state. Nothing automation-shaped is
  ever written under any Connected Folder's `.amplefile/`.
- A Chat step sends only the declared message text, with the closed
  placeholder set filled in host-side, into a new conversation in that one
  Connected Folder. The executor appends no ambient context and no other
  Connected Folder's name. The declaration says exactly what becomes portable
  transcript content in that Connected Folder, and the hop receipt records the
  text AmpleFile filled in.
- The only cross–Connected Folder transfer is the files step: bytes copied
  through the same additive, restore-pointed path as `files add`. The executor
  never relays transcript text between Connected Folders.
- The portable traces an automation leaves are all ordinary records in a single
  Connected Folder: a new Chat in Connected Folder A, copied files and a History
  restore point in Connected Folder B. Neither folder learns the other exists.

The message an automation's chat step sends is an **ordinary user-role
message**: the portable transcript carries no automation marker, and someone
reading it cannot tell an automation-sent message from a person-sent one.
Attribution lives entirely in machine-local records: the automation run
receipt and hop journal name the exact conversation and message, run history
shows every dispatch, and the overview lists automation runs.

## Triggers

An automation has exactly one declared trigger; manual run-now is also
available for every enabled automation. App code evaluates triggers from
recorded schedule state or explicitly granted, bounded folder metadata
observation. Trigger evaluation never calls a model or reads file contents.

**Manual only** is `{"kind":"manual"}` (any version): the automation never
fires on its own and runs only through run-now below.

**Folder changes (version 3)** use `{"kind":"files-changed","connectedFolder":"<connected-folder id>","watch":{"kind":"tree","path":"Incoming","recursive":true,"extensions":[".md",".txt"]},"debounceSeconds":5,"cooldownMinutes":1}`.
The exact named folder must exist at enablement. The host observes matching
ordinary files every two seconds, within 50,000 files, 200,000 visited
entries, and depth 256; it reads metadata only, so no byte bound applies.
Metadata identities include size, nanosecond modification/change times, and
inode; the observer never reads file contents or sends them anywhere. Symlinks
and overlap with separately registered Connected Folders fail closed. The
extension list and recursion are explicit; reserved metadata stays excluded.
Version 6 also admits the Connected Folder's top level,
`"watch": {"kind": "tree", "path": "", "recursive": false, …}`: the ordinary
files directly in the Connected Folder with a watched extension, never a
subfolder, so a nested Connected Folder is never read. A recursive top-level
watch is refused.

By default (no `ifMissed`, or `"ifMissed": "skip"`), a fresh enable, restart,
wake, or recovered observer error first establishes a baseline without firing.
Changes must settle for the declared 1–3600 seconds, with 0–10080 minutes
between firings. Bursts coalesce into the latest snapshot, not a queue of
events. An accepted run records its source Connected Folder, snapshot digest,
and change count before any hop. Every launch rechecks the exact declaration
grant; revocation invalidates in-flight scans. The observer reports
starting/watching/paused/error state and errors in Settings → Automations.

All folder observers pause while any automation executes and establish fresh
baselines afterward. This absorbs automation-generated edits and prevents
cross-automation file loops. Changes made during that pause are **never
replayed**. Changes made while asleep or quit are not replayed either, unless
the trigger opts into one catch-up (below). Either way this is an awake-app
convenience trigger, not a durable filesystem event bus. Keep a complete
cross–Connected Folder sequence in one automation: wait for A's Chat, copy its
created files, then run B's Chat. There is no transcript relay or ambient
context injection. Stop, disable, removal, shutdown, journaling, non-overlap,
and FIFO limits use the executor paths below.

#### Catching up after a gap (version 5)

`{"kind":"files-changed", …, "ifMissed":"run"}` (declaration version 5) asks
for one catch-up after AmpleFile could not watch the folder, so that, for
example, screenshots that land while the Mac is asleep still get filed.
`ifMissed` is optional; leaving it out, or `"skip"`, keeps the fresh-baseline
behavior above. A version 3 or 4 declaration that names `ifMissed` is refused
with a message naming version 5.

- **What is kept.** For an opted-in automation only, AmpleFile saves the
  snapshot its observer has accounted for — the same metadata it already reads
  (relative path → device, inode, size, and modification and change times),
  never file contents — plus the time it last started a run and any catch-up
  still owed. It lives at `automations/folder-snapshots/<automation id>.json`
  under the state root, machine-local, never inside a Connected Folder, and
  bounded by the observer's 50,000-file scan. The record is rewritten only when
  that accounted-for state changes: the first look, a firing, the look after an
  automation run, or a catch-up found or spent. Turning the automation off
  keeps it, so Turn On can catch up; deleting the automation, removing its
  watched Connected Folder, or dropping `ifMissed` removes it, and a changed
  folder, recursion, or extension list is never compared with it.
- **When AmpleFile compares.** At the first look after a gap: launch ("while
  AmpleFile was closed"), wake ("while the computer was asleep"), Turn On
  ("while this automation was off"), and recovery from an observer error
  ("while the folder could not be watched"). Replacing a declaration that is
  already on, over the same folder, is not a gap. If an automation run is about
  to start before that first look, AmpleFile makes the comparison just before
  the run's first step, so the run's own edits are never part of it.
- **What counts.** A file is caught up when it is new or its size or
  modification time differs from the saved snapshot. Removed files never start
  a catch-up, and device, inode, or change-time differences alone do not
  either: a remount, a sync client, or opening a file can change those without
  changing the file.
- **At most once.** What the comparison finds is owed as one set, saved with
  the snapshot so a quit before it fires does not lose it. It fires as one run
  once the folder has been stable for the declared debounce and the cooldown
  since the last run — which survives a restart — has passed. Later live
  changes that settle in the same window join that run, and any later gap
  merges into the same set; nothing ever queues. The run lists the owed paths
  that still exist plus any coalesced live changes in
  `{{trigger.changedFiles}}`, and afterward observing continues from the new
  state.
- **No self-trigger.** The observer still pauses during every automation run
  and saves the fresh look it takes afterward, which is what keeps a run's own
  edits from starting another run, across restarts too. While a run is in
  progress the saved snapshot carries a small `<automation id>.running`
  marker; if AmpleFile quits, sleeps, or turns the automation off before the
  post-run look is saved, the next look cannot tell that run's edits apart
  from anyone else's, so it takes a fresh look instead of catching up, and
  Settings says so. A catch-up already found before that run still fires.
  Turning an automation back on catches up on whatever changed while it was
  off, including files another automation wrote meanwhile — a person's
  explicit Turn On, once, never a chain.
- **Same receipts.** A catch-up is an ordinary `files-changed` run with the
  same journal-first accepted and terminal receipts. Its cause adds
  `catchUp: {"reason": "closed"|"asleep"|"off"|"unavailable", "count": n}`,
  where `count` of `changedCount` paths changed during the gap.
  `{{trigger.summary}}` reads, for example, `Caught up on 3 files under
  "Screenshots" in Connected Folder space-… that changed while AmpleFile was
  closed.`
- **Visible.** Settings → Automations adds "catches up after AmpleFile was
  closed" to the trigger summary. The watched-folder section says what catches
  up, shows a catch-up that is still waiting ("Catching up on 2 files that
  changed while the computer was asleep"), the last catch-up from the
  receipts, and any reason one could not happen. Run history labels the run
  "Caught up on 3 files that changed while AmpleFile was closed".
  `automations show` states it on the trigger line, and the trigger ref in
  `automations list|show --json` carries `ifMissed`.

Revocation, Stop, Turn Off, the 50,000-file, 200,000-entry, and depth-256
observer bounds, symlink refusal, and nested Connected Folder refusal apply to
a catch-up exactly as to a live change: a catch-up is admitted through the same
dispatch and launch-boundary recheck.

**Not trigger sources:** Worker-turn settles (standing behavior keyed to a
person finishing a Chat would be ambient watching of their conversation
activity, and those records are in-memory only — the real need, "after the
Worker finishes, move its output," is served inside a run, where the Chat step
waits for its own turn), compaction settles (no recorded outcome), and
AmpleFile agent request settles (in-memory, and steps firing from AmpleFile
agent Chat activity would blur interactive work with the agent into unattended
behavior).

**Automation-caused settles never fire triggers**, so automation chains are
structurally impossible — no cycles, no fan-out. Composition happens inside
one automation's ordered steps.

**The recurring schedule trigger** is
`{"kind": "interval", "intervalMinutes": N}` with bounds of 1 minute to 366
days (1–527,040 minutes). Cadence is durable — a persisted `lastScheduledAt`
anchor resumes across restarts — and catch-up follows the `latest` policy: at
most one make-up run for the most recent missed slot, staggered by the shared
deterministic jitter. Missed slots never queue.

**The one-time schedule trigger** is
`{"kind":"at","at":"2026-09-01T21:00:00-04:00","ifMissed":"run"}` and requires
declaration version 2. `at` must carry an explicit UTC offset; normalization
stores one UTC instant. Enablement rechecks that the instant is in the future
and no more than ten years ahead. `ifMissed` is `run` or `skip`: after launch
or wake, `run` admits one bounded catch-up for the exact slot while `skip`
records that the occurrence did not run. Nothing runs while AmpleFile is quit.

Sleep does not spend work that never launched. If a due `run` occurrence is
waiting for a scheduler slot when suspension cancels the admission, its
durable record stays enabled and the exact slot is admitted once on resume.
An `ifMissed: "skip"` occurrence instead records `run: skipped` followed by
the automation lifecycle `completed`, with no hop execution.

A scheduled one-time occurrence is consumed at most once. The executor writes
the strict run `accepted` receipt, then commits a deterministic occurrence
claim `{occurrenceId, slotAt, consumedAt, runId}`, then begins hop 1. That
claim moves the automation to `completed`; success, failure, Stop, or
interruption do not re-arm it. Startup reconciles a crash between acceptance
and claim by consuming the same deterministic occurrence and recording the run
interrupted. Completed records stay visible until a person deletes them.

**Manual run-now** (`amplefile automations run`) is a direct verb: available
for every *enabled* automation, receipted, never a schedule mutation. Run-now
on a merely proposed automation is refused: enablement is what binds the
person's review to the exact declaration digest, and the executor must never
run an unreviewed standing declaration, even once. For a one-time automation,
run-now executes an independent copy and leaves its declared slot untouched.
If that copy is still running when the slot becomes due, the exact slot waits
behind the copy and launches once it settles; the overlap receipt does not
claim or complete the occurrence. After the slot is consumed, completed health
refuses run-now; another occurrence is a new proposal and enablement.

## The declaration

Authoring follows the inert-proposal pattern: the AmpleFile agent writes an
inert, typed JSON file (`amplefile.automation-proposal`, carrying the
declaration's contract version, with the `.amplefile-automation.json` suffix)
at the top level of its own working folder — never inside a Connected Folder,
because the proposal names multiple Connected Folders and their folders travel.
`src/local/automations/automation-declarations.ts` is the schema authority.
Connected Folders are pinned by stable Connected Folder id; duplicate names are
rejected as ambiguous, and `automations show` resolves ids to current names and
folders so the declaration reads as something a person can check.

The contract accepts versions 1 through 6. Each version adds to the one
before:

| Version | Adds |
|---|---|
| 1 | Manual and interval triggers, `chat` and `files` steps |
| 2 | The one-time `at` trigger |
| 3 | The `files-changed` folder trigger |
| 4 | The closed placeholder set and the `agent` step |
| 5 | `ifMissed` on a folder trigger |
| 6 | The Connected Folder's top level as a watched folder |

Declarations are closed, typed data: no prompts beyond the literal Chat- and
agent-step message plus the closed placeholder set below, no instructions, no
source code, no shell commands, no credentials, no connection data, no
expressions. The only model a declaration names is a step's optional model
(below). The Chat- and agent-step `message` is bounded (4 MiB) and is data
addressed to one Connected Folder's Worker or to the AmpleFile agent; from
version 4 it may carry the closed placeholder set.

### Steps

Steps execute strictly in declaration order. Three kinds:

- **`chat`** — start a **new** conversation in the named Connected Folder with
  the fixed message, through the same acceptance path as
  `amplefile chat send --new`: conflict checks, kernel `assistant_turn` task,
  pre/post-turn History checkpoints, portable transcript persistence. Always a
  new conversation — sending into an existing Chat could collide with a
  person's live turn, and standing behavior must not entangle itself with an
  interactive thread. The hop waits for exactly its own turn's task-scoped
  terminal outcome; `failed` or `aborted` fails the hop.
- **`files`** — copy from one Connected Folder's folder into another's through
  the same additive internals as `files add`: collision-rename on existing
  names, and a targeted restore point that succeeds or fails together with the
  placement. Copy only — an automation never moves, renames, or deletes
  anything in the source Connected Folder. The source is an explicit list of
  exact Connected Folder–relative paths, one bounded tree selector resolved by
  the folder target resolver (`src/local/automations/folder-targets.ts`;
  tighten-only hard limits; symbolic links, `.amplefile/`, `.pi/`, and nested
  registered Connected Folders rejected), or the declared created-files
  handoff below. There are no free glob or regex patterns: the bounded tree
  selector is the hardened enumeration primitive, with review semantics a
  person can actually read.
- **`agent`** (version 4) — start a **new** AmpleFile agent Chat with the
  message, through the same acceptance path as `amplefile agent send --new`.
  It names no Connected Folder: the AmpleFile agent sits above them. Always a
  new Chat, so standing behavior never entangles a live AmpleFile agent Chat
  and turn-conflict rejection stays exact. The hop waits for its own turn's
  terminal outcome and `automations stop` aborts it like a Chat hop. This is
  the one way the AmpleFile agent runs unattended, so a person can put the
  AmpleFile agent on a cadence deliberately. An agent hop records no History
  checkpoints and is never a created-files source.

**Per-step model.** A `chat` or `agent` step may name its own model,
`"model": {"provider": "<provider>", "id": "<model id>"}`, in any declaration
version. It applies only to the new Chat that step starts: the host sets it on
that session before the first turn, so the Chat's later answers and
continuations keep it, and no Connected Folder's, the AmpleFile agent's, or
Pi's default model changes. A step without one uses the Connected Folder's (or
the AmpleFile agent's) model. Enabling refuses a step whose model AmpleFile does
not know or whose provider is not connected, naming the step, so an unattended
run never meets that first. `amplefile automations models` lists the connected
models and whether each accepts images, so an automation that looks at
screenshots, photos, or scans can name one that sees them. The AmpleFile agent
is told to check this and to ask the person when the choice matters. Settings
→ Automations and `automations show` say which model a step uses.

**Steps report their results.** A chat step's message is its Worker's whole
instruction, and the Worker reports back in the one result shape
([the collaboration contract](collaboration-contract.md)). Its turn context
names the Automation that sent the message, says nobody is watching while it
runs, and asks it to finish with `chat report`: a summary, the files it made or
changed, and an outcome. The step takes that outcome. A reported `failed`
fails the step in the Worker's own words, and so the run, like any failed hop.
A reported `partial` keeps the step and the run `succeeded` but marks both
`partial`, shown as **Partly done**. The reported summary becomes the step
receipt's detail. A turn that ends with only a reply keeps the turn's own
outcome, so a Worker that answers with a question instead of doing the work
does not read as done. An `agent` step gets the same unattended framing; the
AmpleFile agent has no report verb, so its final reply is the record.

### Placeholders and the created-files handoff

Every step parameter is a literal in the declaration; there is no
step-output-to-step-input templating and nothing evaluates model output. From
version 4 there is one narrow addition: a **closed set of host-filled
placeholders** in a `chat` or `agent` message. Nothing else inside `{{ }}` is
accepted — an unknown placeholder is a declaration error refused when the
automation is enabled, so it can never appear as an empty sentence in a message
a Worker already received.

| Placeholder | Filled in from | Declaration rule |
|---|---|---|
| `{{trigger.summary}}` | The run's own cause, in one sentence (a catch-up says so) | Valid with every trigger |
| `{{trigger.changedFiles}}` | The changed paths the folder observer recorded, including a catch-up's | Requires a folder-change trigger |
| `{{steps.<id>.createdFiles}}` | The manifest diff of that chat hop's own pre/post checkpoints | Must name an earlier `chat` step in the same automation |

Resolution happens in the executor, after the hop's `accepted` receipt and
before the port is called, and it reads the **run's cause**, never the
declared trigger. A run-now on a folder-change automation therefore says
`(no changed files: this run was started by hand)` instead of pretending files
changed. A resolution that cannot be proven — a created-files gap — fails the
hop closed with a typed reason and skips the later hops; nothing is sent.

Bounds, each named in the text it produces: 1 MiB per filled-in placeholder,
10,000 items per filled-in list, and 8 MiB for the whole message after
substitution (exceeding it fails the hop). The hop's terminal receipt records
`placeholders[]` — each name, the bounded text, its byte length, and whether
it was cut — plus `messageBytes`. That is the one place the receipts journal
carries message text, and it carries only the part AmpleFile itself wrote.

The other declared exception is the **declared created-files handoff**: a
`files` step may name an earlier `chat` step in the same automation as its
source (`{"kind": "step-created-files", "step": "<id>"}` plus mandatory bounds
— `maxFiles` and `maxTotalBytes` required, extension filters optional). It
resolves host-side and deterministically as the manifest diff between that
turn's own pre/post checkpoints, filtered by the declared bounds; no model
output is parsed. Fail-closed edges: a missing checkpoint of the pair, or a
filter-matching file the capture skipped (oversized or unreadable), fails the
hop with a typed error naming the gap — a partial handoff is never silently
delivered.

Determinism covers **selection, not content**. The copied bytes are whatever
the chat step's turn wrote — model output, steered by the fixed message and by
whatever the source Connected Folder's folder contains at run time. An enabled
automation with this handoff is a standing, content-dependent channel from the
source Connected Folder into the destination Connected Folder;
`automations show` and Settings → Automations both state this under **While
This Automation Is On**. Every delivery is inspectable after the fact: the hop
receipt lists the exact copied paths, and the overview's
automation-run-settled item names the destination Connected Folder and the
delivered file count.

### A Chat or agent hop and its request

A Chat or agent hop follows its durable request through answer and synthesis
turns. A question ends this automation at that hop with a visible failure and a
Chat reference; answering continues the request, never the remaining
automation effects. A completed hop carries the selected result envelope
internally, while its receipt keeps identifiers and attribution rather than
copying the report's content. Created-file steps still use their declared
checkpoint diff.

## Ready-made Automations

The file manager's Info panel, at a Connected Folder's top level, lists a small
fixed set a person can switch on for that Connected Folder: **Organize New
Files**, **Give New Files Clear Names**, **Keep Screenshots Together**, and
**Weekly Tidy-Up** (`src/shared/automation-templates.ts`; the host builds their
declarations in `src/local/automations/automation-templates.ts`). Each is one
`chat` step to that Connected Folder's own Worker, in plain words that tell it
never to delete anything, on a version 6 folder-change trigger over the
Connected Folder's top level with `"ifMissed": "run"` (or, for the tidy-up, a
weekly interval). Switching one on is the same receipted `automations.enable`
act as **Turn On** in Settings, with a stable id per Connected Folder
(`automation-ready-<template>-<connected-folder id>`), so off and on again is
the same Automation, and Settings → Automations lists it like any other.

## Storage split

| Record | Location | Reason |
|---|---|---|
| Inert automation proposal | Ordinary file in the AmpleFile agent's working folder | Reviewable and revisable without authority; never placed in the folder of a Connected Folder it names |
| Enabled declaration, exact-digest grant, cadence/occurrence claim, health state | AmpleFile application state (`automations/` under the state root; store schema version 3) | References multiple Connected Folders; must never travel with any folder |
| Automation-run and hop receipts | AmpleFile application state, append-only journal with rotation | Contains Connected Folder names, paths, and ids across Connected Folders |
| Saved folder snapshot and running marker (`"ifMissed": "run"` only) | AmpleFile application state (`automations/folder-snapshots/`), one file per automation | File metadata from a Connected Folder, kept so a catch-up has something to compare with; never portable and never file contents |
| Effects inside Connected Folders | Ordinary Connected Folder records: a new Chat transcript, copied files, a History restore point | The only portable traces are in a single Connected Folder, ordinary, and restorable |

## The executor

The automation service (`src/local/automations/automation-service.ts`) owns
execution as app code. It creates its **own** instance of
`AmpleFileSchedulerService` — the same class and discipline, with its own
64-slot default budget and `ownerId: "amplefile.automation"`. That gives it
FIFO admission, per-automation non-overlap (an overlapping admission settles
`skipped` and is receipted as such; a one-time slot overlapping its own run-now
copy stays pending), interval and one-time schedules, durable cadence, bounded
catch-up with deterministic stagger, suspension and resumption across sleep and
quit, and abort signals through every run.

Every run is journal-first on the act-receipts discipline: a run `accepted`
record before hop 1 — an unwritable journal refuses the run — and a terminal
record after. Each hop writes its own accepted/terminal pair carrying the
underlying domain evidence (chat hop: conversation id, turn task id, outcome,
checkpoint ids, and the summary and `partial` mark its Worker reported; files
hop: source and destination Connected Folder ids, resolved and copied paths
with collision renames, counts, restore-point id). The run's terminal record
names the trigger cause exactly — scheduled slot, folder change, or run-now
request id — plus the declaration digest in force.

**Failure.** A failed hop — including a chat step whose Worker reported
`failed` — fails the run; later hops are recorded `skipped` with the failing
hop named. There are no retries — the next trigger occurrence is the retry,
and the receipt trail makes the failure inspectable rather than smoothed over.
Infrastructure refusals inside a hop fail the hop with the typed reason; they
are automation health, never silently skipped work.

**Stop.** A direct verb and a desktop control. It aborts the current hop
through that domain's own abort path (a files hop is not interruptible
mid-copy — the copy either completes with its restore point or fails as one
unit); later hops are `skipped`, the run settles `stopped`, and the receipt
names every hop task it aborted, exactly as `agent stop` names child turns.

**Disable.** Revocation of standing behavior: it journals the disable,
persists the disabled state, cancels pending admissions, and stops the active
run through the stop path — then reports what it stopped. Disable never
destroys the declaration, grant history, or receipts.

**Referenced Connected Folder removed.** Removing any Connected Folder a step
or trigger names revokes the enablement grant and puts the automation in a
durable `suspended` health state with the missing Connected Folder id
recorded; the active run, if any, is stopped. A suspended automation never
runs, never retargets, and never resumes automatically — not even when a folder
carrying the same portable Connected Folder identity is registered again,
because registration must never silently re-arm standing behavior. Copy
distinguishes "Connected Folder removed" from "registered again with the same
identity"; the semantics are identical, and leaving suspension is a fresh
enablement over the unchanged declaration.

**Crash mid-run.** Startup scans the journal for runs with an `accepted`
record and no terminal record and appends `interrupted` — record, never
replay. Completed hops keep their receipts; the in-flight hop resolves through
its own domain's crash semantics. Before writing that terminal, startup
reconciles the accepted scheduled slot into the durable interval anchor or
one-time occurrence claim. The same slot is therefore never replayed under a
new run id, including a crash after acceptance but before the original process
committed the claim.

**Replay prevention.** Run ids are host-minted per admission; trigger
evaluation is serialized in-process at the settlement funnels; scheduled slots
are claimed durably after acceptance and before hop 1, with missed interval
slots collapsed and one-time occurrences deterministically named; run-now rides
the act lane's request-id at-most-once gate. The journal-first `accepted` gate
plus startup `interrupted` recovery means a crash can interrupt a run but never
execute it twice under one run id.

**Kernel task.** Automation runs register as the experimental kernel task kind
`automation_run`, excluded from stable protocol-v1 task projections.

## Lifecycle and authority

1. **Propose.** The AmpleFile agent (or a person, by hand) writes the inert
   typed proposal. Nothing is registered, armed, or scheduled; proposals are
   ordinary files with no authority.
2. **Enable.** `amplefile automations enable --proposal <path>` — or **Turn
   On** beside a pending file in Settings → Automations — is a direct
   receipted verb ([receipts, not gates](act-ledger.md#receipts-not-gates)).
   It normalizes the declaration, rechecks the one-time horizon, requires
   every referenced Connected Folder to be registered, and commits the
   enablement through the same prepare-pin-journal-execute path every prepared
   act takes — immediately, on the first call. The receipt pins the
   declaration digest and records the surface and request id. Enabling a
   declaration that is already on at the same digest is a no-op: no fresh
   receipt, no journal line, and an active run is left alone. Enabling a
   *changed* declaration is a fresh receipt that first stops any run still
   executing the previous one, because revocation must stop stale work before
   the change reads as complete. The digest pins the declaration, not the
   referenced Connected Folders' capabilities: a chat step runs with whatever
   Worker authority its Connected Folder holds at run time. The declaration
   write and the enablement commit are one logical operation; a failure may
   leave an inert declaration, never undeclared or digest-mismatched
   authority.
3. **Run.** Scheduled, folder change, or run-now. Any edit to the declaration
   changes its digest, and a run admitted under the old digest is refused at
   the launch boundary — an edited automation never coasts on a stale
   enablement.
4. **Disable.** Narrowing is always direct: it journals the disable, persists
   it, cancels pending admissions, and stops the active run.
5. **Delete.** A direct verb on an inert disabled, suspended, or completed
   automation: removes the declaration, enablement history, and cadence
   anchor. An active or claimed-but-unfinished one-time run must settle or be
   stopped first. The receipts journal is kept — audit records survive the
   object.

The five questions, per mutation:

| Mutation | Journaled by | Receipt contains | Revoked / undone by | Mid-act failure | Replay prevented by |
|---|---|---|---|---|---|
| Enable | Act-lane journal plus automation store commit (`automation/enabled` with digest, surface, request id) | Automation id, declaration digest, surface, timestamp | Disable; Connected Folder removal (automatic revocation to `suspended`) | Declaration-then-receipt as one logical operation; failure leaves an inert declaration, never digest-mismatched authority | Act request-id at-most-once; an identical already-enabled digest is a no-op |
| Run (scheduled / folder change) | Automation receipts journal, run `accepted` then durable schedule claim before hop 1, per-hop accepted/terminal pairs | Trigger cause, digest, occurrence id for one-time work, per-hop domain evidence (task ids, run ids, conversation id, restore-point id, counts) | Stop (active); files effects restorable via the hop's restore point; chat effects are an ordinary archivable Chat | Startup reconciles an accepted slot, records `interrupted`, and never replays it; completed hops keep receipts | Host-minted run ids; journal-first accepted gate; pre-hop interval/occurrence claim; serialized trigger funnel |
| Run-now | Act-lane journal plus the same run journal | As above, plus the act request id | Same as a run | Same as a run | Act request-id at-most-once plus run-id gate |
| Stop | Act-lane journal (or desktop action record) plus run terminal record | Run id, aborted hop task ids, skipped hops | Not applicable — stop is itself the revocation act | Abort signals are idempotent; a second stop finds a settled run | Act request-id at-most-once; a settled run refuses stop with its terminal state |
| Disable | Act-lane journal plus automation store | Prior state, stopped run id if one was aborted | Enable again (a fresh receipt) | Disabled intent persists first; startup refuses to arm a disabled automation; the active run at a crash is `interrupted` anyway | Act request-id at-most-once |
| Delete | Act-lane journal plus automation store | Automation id, digest, final health state | Not undoable; the declaration was inert data and receipts are kept | Active and claimed-but-unfinished occurrences are refused; the grant is removed before the declaration so no window holds authority without a declaration | Act request-id at-most-once |

## Where automations live in the product

**Settings → Automations** is the management home: an automation is not one
Connected Folder's object. It carries the list, state, declaration, bounded run
history, and valid actions; **Turn On** is one click that enables the
automation and writes its receipt.

Pending proposal files appear there too. Settings scans the top level of the
AmpleFile agent's working folder — no subfolders, at most 1,000
`*.amplefile-automation.json` files of at most 64 MiB each — validates each
with the proposal schema, and lists the ones not already stored at the same
digest under **Ready to Turn On**, each with its title, trigger, and a **Turn
On** button. A file that does not validate, names an unregistered Connected
Folder, or has a one-time instant outside the enablement horizon shows only its
file name, with the problem as a tooltip and no button; when every file is
invalid the section is titled **Automation Files** so the repair reason stays
visible. Turn On re-reads that exact file — the path must resolve directly
inside the AmpleFile agent's working folder. Reads reject symbolic links and
files that change while being read, and never admit more than 64 MiB. The
action takes the same enable path as `automations enable --proposal`
(content-derived id, digest pinned at that moment, journaled prepared act),
with the receipt's surface recorded as `main-window`. The automation then
appears once, in the main list. The agent is taught to write the file and tell
the person it is there, and to enable it itself only when asked. The scan is a
read of inert files and needs the desktop bridge, so it is absent in the
browser development lane.

When automations name more than one Connected Folder, a chip row filters the
list client-side by the Connected Folders each automation's trigger and steps
name. It is a view over the one list, not a per–Connected Folder place:
automations stay above Connected Folders.

A Connected Folder's Info panel in the file manager shows the automations that
touch it at its top level, each with an on/off switch, followed by the
ready-made ones it has not turned on. The renderer reads
`GET /api/connected-folders/:id/automations` and caches the list per Connected
Folder; changes in Settings or the Info panel refresh it at once. The switches
take the same enable and disable path as Settings. The session-authenticated
local API also serves
`POST /api/connected-folders/:id/automations/:automationId/(run|enable|disable)`,
which runs the exact Settings facade methods — same prepared-act path, same
`main-window` receipts — and refuses an automation that does not name the
Connected Folder. Nothing is authored, edited, or deleted from a Connected
Folder; automations are declared, stored, and receipted above Connected
Folders.

The AmpleFile agent narrates run history on demand, and only an automation's
own `agent` step ever puts it on a cadence. An automation's effects stay
visible where they land: the copied files and restore point in the destination
Connected Folder's files and History, the new conversation in the source
Connected Folder's Chats.

The CLI act-lane group is `amplefile automations
enable|list|show|run|stop|disable|delete|receipts|models` — per-launch token,
journal-first, and like the `agent` group it sits above Connected Folders and
takes no `--connected-folder`. `list`/`show`/`receipts` are content-bearing
(Connected Folder names, paths, messages) and therefore act-lane, because only
content-free summaries live in the read lane.

## Bounds

Declaration structure is validated at parse and execution. Transport,
selection, and concurrent execution are bounded; declarations have no
machine-wide count, step-count, or exact-path-count quota.

| Bound | Value | Source of the value |
|---|---|---|
| Triggers per automation | 1 (plus always-available run-now) | This design |
| Interval | 1 minute to 366 days (1–527,040 minutes) | `ampleFileAutomationBounds` in `src/local/automations/automation-declarations.ts` |
| Catch-up | `latest` only (one make-up run) | `AmpleFileSchedulerService` |
| One-time horizon | at least one second in the future, up to ten years ahead, at enablement | `minAtAdvanceMs`/`maxAtAdvanceMs` in `src/shared/amplefile-limits.ts` |
| One-time missed policy | `run` or `skip` | One bounded catch-up or one recorded non-run |
| One-time occurrence | One scheduled/resume claim ever; completed kept until Delete | Durable completed health and deterministic occurrence id |
| Folder-change debounce / cooldown | 1–3600 seconds / 0–10080 minutes | `src/local/automations/automation-declarations.ts` |
| Folder observer | Metadata only, no byte bound; 50,000 files, 200,000 visited entries, depth 256 | `ampleFileAutomationFileObserverBounds` in `src/local/automations/automation-file-observer.ts` |
| Folder catch-up (`"ifMissed": "run"`) | One coalesced run per gap, never a backlog; the saved snapshot and owed set hold at most the observer's 50,000 files, and a read admits at most 256 MiB | `src/local/automations/automation-file-snapshots.ts` |
| Changed paths recorded per run cause | 10,000 (the count stays exact) | `ampleFileAutomationDeclarationBounds` |
| Concurrent automation runs | 64, FIFO, machine-wide | `ampleFileAutomationMaxConcurrentRuns`; a generous default, not a cap |
| Tree selector resolution | The folder target resolver's hard limits; tighten-only | `src/local/automations/folder-targets.ts` |
| Created-files handoff | `maxFiles` and `maxTotalBytes` mandatory in the declaration, at most 100,000 files and 64 GiB | `ampleFileAutomationBounds` |
| Chat and agent step message | 4 MiB | The model's context window is the practical bound |
| One filled-in placeholder | 1 MiB | A resource guard; the cut names the limit |
| Items in one filled-in list | 10,000 | Same |
| Whole message after substitution | 8 MiB | Exceeding it fails the hop and names the limit |
| Declaration or proposal file | 64 MiB; Settings scans at most 1,000 proposal files | `ampleFileAutomationDocumentMaxBytes`, `ampleFileAutomationProposalScanBounds` |
| Run history / journal | 500 recent results; a 16 MiB receipts file rotated on the act-receipts pattern | Scheduler default; `AMPLEFILE_AUTOMATION_RECEIPTS_MAX_BYTES`, `src/local/cli/act-receipts.ts` |

## Where it lives

- Declaration and proposal schema — `src/local/automations/automation-declarations.ts`; `tests/amplefile-automation-declarations.test.ts`.
- Automation store and receipts journal — `src/local/automations/automation-store.ts`; `tests/amplefile-automation-store.test.ts`.
- Executor service and the `automation_run` kernel kind — `src/local/automations/automation-service.ts`, `src/local/amplefile-kernel.ts`; `tests/amplefile-automation-service.test.ts`, `tests/amplefile-kernel.test.ts`.
- Scheduling, including one-time triggers — `src/local/agent/amplefile-scheduler-service.ts`; `tests/amplefile-scheduler-service.test.ts`.
- Revocation when a Connected Folder is removed — `src/local/connected-folder.ts`; `tests/local-connected-folder.test.ts`.
- Act-lane verbs — `src/local/cli/act-commands.ts`, `src/local/cli/act-facade.ts`; `tests/amplefile-cli-act-protocol.test.ts`, `tests/amplefile-act-facade.test.ts`, `tests/amplefile-cli-automations-show.test.ts`.
- AmpleFile agent instruction teaching — `src/local/amplefile-agent-instructions.ts`; `tests/amplefile-agent-conversation.test.ts`.
- Settings surface and pending proposals — `src/local/automations/automation-proposal-scan.ts`, the `automationSettings` facade in `src/local/server.ts`, the `amplefile:automations:*` channels in `desktop/src/`, `web-local/src/components/modals/AutomationsPane.tsx`; `tests/amplefile-automation-proposal-scan.test.ts`, `tests/automations-settings-api.test.ts`, `tests/automations-settings-ui.test.ts`.
- Per–Connected Folder view and trigger summaries — `src/shared/automation-presentation.ts` (the one trigger summary Settings, the Info panel, and the route share), `ampleFileAutomationConnectedFolderRoles` in `src/local/automations/automation-declarations.ts`, the `/api/connected-folders/:id/automations` routes in `src/local/server.ts`, `web-local/src/hooks/useFolderAutomations.ts`, `web-local/src/components/file-manager/file-manager-automations.ts`; `tests/folder-automations.test.ts`.
- Ready-made Automations — `src/shared/automation-templates.ts`, `src/local/automations/automation-templates.ts`.
- Folder catch-up — `ifMissed` in `src/local/automations/automation-declarations.ts`, the comparison and owed set in `src/local/automations/automation-file-observer.ts`, saved snapshots and running markers in `src/local/automations/automation-file-snapshots.ts`, load/save and the pre-run comparison in `src/local/automations/automation-service.ts`; `tests/amplefile-automation-folder-catch-up.test.ts`.

## Deliberately not in this design

- **Automation chains.** Automation-caused settles never fire triggers;
  multi-hop behavior across automations is excluded structurally, not merely
  bounded.
- **Worker-turn, compaction, and AmpleFile agent request triggers**, for the
  reasons given under Triggers.
- **Ambient or durable file watching.** Only the explicitly reviewed, bounded
  folder observation above is admitted; it never watches an unselected
  Connected Folder or replays offline events. The opt-in catch-up compares one
  saved metadata snapshot with the folder and starts at most one coalesced run
  per gap; it is not an event log, never queues missed events, and never
  replays edits made while an automation was running.
- **Expressions, conditions, branching, retries, or free templating.** Only
  the closed, host-filled placeholder set is admitted; nothing evaluates model
  output, and there is no step-output piping beyond it and the declared
  created-files handoff.
- **Cross–Connected Folder moves or deletions.** The files step only copies
  additively with restore points; destructive operations stay with the person
  and are reversible through Recently Deleted.
- **Recurring time-of-day and calendar schedules.** One-time absolute instants
  are admitted; daily, weekday, monthly, and RRULE-shaped recurrence are not.
- **A newer-than-last-successful-run filter on `files` steps.** Recopying
  unchanged selector matches is safe by construction (additive,
  collision-renamed, restore-pointed), just noisy.
- **Re-enablement when a referenced Connected Folder's capabilities change.**
  The enablement digest pins the declaration; the Connected Folders it names
  govern their own capabilities. `automations show` and Settings → Automations
  state this rather than policing it with re-review machinery.
- **Portable or shared automations.** Declarations never enter `.amplefile/`,
  sync, export, or any distribution lane.
- **A machine-wide automations destination, badge, or notification stream.**
  Settings owns management; the Info panel's list is a view of related
  automations, not a second management home.
- **Read-lane automation status.** All automation commands are act-lane.
- **Hosted or remote execution.** Automations run only on this Mac while the
  app runs.
- **A general job system.** 64 run slots by default, generous bounds, three
  step kinds. A flow that does not fit belongs to a person.

## Authoring guidance

`amplefile help automations` includes a complete version-5 folder-change
proposal that catches up (`"ifMissed": "run"`), with file-copy, Chat, and agent
steps and two placeholders. The AmpleFile agent is instructed to consult it
before authoring, to offer the catch-up when a person wants files that arrive
while AmpleFile is closed handled too, and to leave it out otherwise. The
example is checked against the real proposal validator; it documents the
nested `automation` envelope, additive copies, and observer pauses.
