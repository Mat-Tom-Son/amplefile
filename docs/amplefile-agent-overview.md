# The overview — the AmpleFile Agent's deterministic digest

The overview is a small digest a person reads in a few seconds: what is
running right now, what is waiting on them, what changed since they last
looked. App code composes it from state the product already records. No model
call composes it and it adds no watcher. The overview is a projection, not a
store: every item points back at a durable or task-scoped record that exists
for its own reasons, the digest can always be recomputed, and it is never
itself the authority for anything. Its only state of its own is the
per-surface last-seen marker, a machine-local presentation preference in the
same class as the Chat attention marker.

`src/local/overview.ts` and `src/local/overview-seen-store.ts` with their
suites are the implementation authority. This document holds the closed source
inventory, the section and ordering rules, the marker contract, and the
non-goals.

**Needs you** carries recorded questions, due snoozes, and requests waiting on
a person's answer, and nothing else. Nothing in the digest waits to be allowed,
so no surface that renders it offers a control that allows an action.

## The source inventory

The overview may read exactly these sources. The table is closed: adding a
source means adding a row here first, and the row must name a record the
product keeps for its own sake. The overview never causes a record to exist.

| Source | Module | Durability | The overview reads |
|---|---|---|---|
| Running task registry | `AmpleFileKernel` in `src/local/amplefile-kernel.ts` | In-memory, app run | Running `assistant_turn` and `compaction` tasks (stable v1) plus the experimental `automation_run` task, with Connected Folder id, actor, `startedAt` |
| Settled turn outcomes | `SettledTurnRecord` in `src/local/server.ts` | In-memory, app run | Task-scoped `succeeded`/`failed`/`aborted` results with `endedAt` |
| Requests and questions | The durable request store under the state root's `requests/` directory | Durable machine-local app state, reconciled against the turn journal after a restart, never replayed | Requests in `working`/`handed_off` (running) with the child task ids they started, open questions whose respondent is the person (needs you), and settled requests with their outcome |
| Chat lifecycle and titles | `src/local/agent/chat-store.ts` | Durable — append-only portable transcripts with a rebuildable machine-local summary index | `conversation_lifecycle` events, title changes, `snoozedUntil` due times, and the newest assistant `landing.followUpPrompt` |
| History checkpoints | `listConnectedFolderCheckpoints` in `src/local/history.ts` | Durable machine-local app state | `checkpointId`, `createdAt`, `label`, `reason`, `scope` |
| Act receipts | `AmpleFileCliActReceipts` journal (`src/local/cli/act-receipts.ts`) | Durable, rotation-bounded | Terminal `ok`/`error` records: command name, Connected Folder id, outcome, checkpoint id, parent task id |
| Automation runs | `src/local/automations/automation-store.ts` | Durable | Running and settled automation runs with per-hop outcomes |

Durability is disclosed, not papered over. In-memory sources live for the app
run only; after a restart the digest recomputes from durable records and
simply contains less — it never fabricates continuity it cannot re-derive. An
outstanding request and its open questions survive a restart; the kernel's
running-task registry and the settled-turn outcomes do not.

## The digest

One snapshot shape (`amplefile.overview.experimental`, version 0, in
`src/local/overview.ts`), composed on request. Composition is deterministic:
the same recorded state and the same single `composedAt` clock reading produce
a byte-identical digest. Headlines are fixed templates over typed record
fields — never model output, never file content, never free re-wording. A
receipt naming an unregistered Connected Folder renders the id plus
"(removed)". Every section carries a `truncated` flag; bounds are disclosure,
not curation.

**Running now** — everything the product knows is executing: Worker turns and
compactions, and Automation runs. Running work above a single turn is
request-derived: a request in `working` or `handed_off` is one item that
carries the turns it started, wherever those turns run, so a delegated request
and its Connected Folder turns are never double-counted. A request in
`waiting` is not running: what it is waiting on appears in **Needs you**
instead. Ordered by `startedAt` ascending (longest-running first), tie-broken
by id. Cap 256; overflow drops the newest, never the oldest — a long-running
turn must not be hidden by churn.

**Needs you** — only things structurally waiting on the person's answer:

- `request-question`: one item per **open question** on a request whose
  respondent is the person, not one item per request phase. A request with two
  open questions contributes two items, and a question addressed to its parent
  request belongs to that parent and never appears here. A **settled
  AmpleFile Agent request** whose own closing reply ends in a question mark
  also contributes one item, with no question id, because that question was
  asked in prose and never recorded.
- `chat-question`: a Connected Folder Chat whose newest transcript message
  carries a recorded follow-up prompt, while Active and not running. It clears
  when the person replies, never merely because it was looked at.
- `due-snooze`.

The headline stays a fixed template over typed fields: a question's own text
is model output, so it is not in the digest. The item's `ref` carries the
question id and the asking Connected Folder, and a surface reads the text
through `requests show`. Nothing here is an action waiting to be allowed;
needs-you means a question. Ordered newest-first. Cap 256; overflow keeps the
newest and states truncation. A needs-you item never disappears because it was
seen; only answering, expiry, or resuming removes it.

**Since you last looked** — settled and recorded changes, newest first:
`checkpoint-saved`, `turn-settled`, `request-settled` (a request reaching a
settled state such as `done`, `partial`, `failed`, or `stopped`; the headline
names that outcome, and the item's `ref` carries the request id so a surface
can read the results handed back through `requests show` — a result's
summary, structured data, and files are never in the digest),
`chat-lifecycle`, `chat-renamed`, `act-performed` (every receipted verb,
including the ones that install code, widen a power, or delete), and
`automation-run-settled`. An answered question adds no kind of its own: it
leaves **Needs you**, and the request's own settle carries the story. Bounded
twice: at most 128 items per kind and 512 total. The `cursor` identifies the
newest change item as `"<at>/<id>"`; surfaces render items newer than their
own marker as new and older items quieter, and a **Show earlier** affordance
reveals the bounded tail regardless of the marker, so marking seen loses
nothing.

## Last-seen markers

One machine-local record (`overview-seen.json` under the state root,
`src/local/overview-seen-store.ts`) maps surface ids to the cursor each
surface has acknowledged. The store accepts `main-window` and `popover`; no
current surface fetches the digest or advances either marker. Markers are
presentation preference exactly as the product model defines for Chat
attention state: machine-local, disposable, never portable, never authority. A
marker advances only when a person viewing a surface acknowledges a rendered
digest; fetching never advances a marker, and the AmpleFile Agent narrating
the overview never advances one either.

Marker advance is the overview's only mutation, and its standard answers:

- **Journaling and receipt:** none, deliberately. The write changes no
  product state, content, or authority — only which items a surface renders
  as new, the same class as the unjournaled Chat attention acknowledgement.
- **Revocation and undo:** a marker hides nothing — **Show earlier** reveals
  the bounded tail regardless — so there is nothing to undo.
- **Failure mid-act:** the store is a single atomic small-file write. A failed
  write leaves the old marker; the failure direction is over-reporting, never
  under-reporting.
- **Replay:** advance is monotonic (cursor comparison by timestamp then id),
  so a replayed or reordered advance is a no-op.

## Surfaces

`amplefile agent overview --json` and the AmpleFile Agent's narration read the
digest on request. No surface receives push: the digest is pulled on request
and never recomputed in the background for nobody.

The menu-bar popover is kept for the live conversation and capture. It does
not request `GET /api/amplefile-agent/overview` and never advances an overview
marker. The main window neither requests nor acknowledges the overview; the
server routes and the seen-marker store are there for a surface that does.

## Narration on demand

The AmpleFile Agent can say the overview out loud, grounded in the same
digest, never in ambient re-inspection. `amplefile agent overview --json`
returns the digest through the act lane (scoped to the AmpleFile Agent, no
`--connected-folder`, journal-first receipted like every act command). It
mutates nothing; it is act-lane rather than read-lane because the digest is
content-bearing, the same split `chat status` follows. The AmpleFile Agent's
instructions teach it to run the command when asked what is happening, narrate
from its fields, and never present a truncated section as complete — the
`truncated` flags are part of the answer. Narration is interactive only,
inside an AmpleFile Agent Chat, whose transcript is machine-local. The product
never starts narration on its own — only a person's message or an Automation's
declared `agent` step starts an AmpleFile Agent turn — and there is no
scheduled digest, wrap-up, or morning summary. Narration never advances a
marker; the digest's `seen` table lets the AmpleFile Agent say "since you last
looked at the popover" honestly, but only a person viewing a surface marks
seen.

## Non-goals

1. **No model composes the digest.** Composition is app code over typed
   records; a model touches the overview only when a person asks the AmpleFile
   agent to narrate it, and that narration adds no facts to it.
2. **No file is opened to build it.** The overview reads recorded state and
   never scans, stats, hashes, or reads Connected Folder files. If the digest
   cannot know something without opening a file, the digest does not know it.
3. **Nothing ambient.** No watcher, no schedule, no background recomputation.
   The digest exists while a surface is asking for it and is garbage the
   moment it is rendered.
4. **Unrecorded means unknown.** An empty digest means nothing is recorded,
   not that nothing happened. A source that cannot be read is reported as
   unavailable in that section, never rendered as quiet.
5. **The overview is not a store.** No durable activity feed, no event log of
   its own, no retention policy. The one persisted record is the seen-marker
   file, and it is disposable preference.
6. **The overview is not protocol v1.** The read lane stays content-free. The
   snapshot is experimental version 0; promoting it into the stable kernel and
   installed-CLI contracts would be a deliberate version decision.
7. **The overview does not notify.** No OS notifications, no badge counts, no
   Dock or menu-bar numbers. It is where a person looks when they choose to
   look, and looking at it never destroys information.

Also deliberately not part of it:

- **Scheduled or proactive narration** — no morning summary, no idle-time
  digest turn, no notification that "the AmpleFile Agent has news." Agency on a
  schedule lives in Connected Folders; above Connected Folders only declared
  deterministic Automations run unattended, and narration is neither.
- **Marker sync across machines.** Markers are machine-local like every other
  acknowledgement preference.
- **A durable cross-source event store or subscription API.** Extensions and
  other consumers that need events should get a deliberate contract, not a side
  door through the digest.
- **Filtering, muting, pinning, or per-item preferences.** The digest is small
  enough to read; if the caps prove wrong, change the caps.
- **Overview content inside Worker Chats.** A Worker does not receive the
  cross–Connected Folder digest; Connected Folder transcripts are portable and
  cross–Connected Folder context in them is a leak. The rule from
  [Automations](automations.md) applies to reads as well as work.
- **Model summarization of the digest into the digest.** Narration renders
  facts already present; it never writes back.

## Where it lives

- Overview types and composer — `src/local/overview.ts`; `tests/amplefile-overview.test.ts` (byte-identical determinism, ordering, caps, truncation, restart honesty, unavailable sources).
- Seen-marker store — `src/local/overview-seen-store.ts`; `tests/amplefile-overview-seen-store.test.ts`.
- Kernel query (`getOverview`) with the v1-exclusion guard — `src/local/amplefile-kernel.ts`; `tests/amplefile-kernel.test.ts`.
- Local API routes (`/api/amplefile-agent/overview`, `/overview/seen`, served without AmpleFile Agent readiness) — `src/local/server.ts`; `tests/amplefile-agent-api.test.ts`, `tests/local-server.test.ts`.
- CLI act command (`agent overview`) — `src/local/cli/act-commands.ts`, `src/local/cli/act-facade.ts`; `tests/amplefile-cli-act-protocol.test.ts`, `tests/amplefile-cli-commands.test.ts` (read-lane guard).
- Narration teaching in the AmpleFile Agent's instructions — `src/local/amplefile-agent-instructions.ts`; `tests/amplefile-agent-conversation.test.ts`.
- `tests/amplefile-agent-popover-refresh.test.ts` and `tests/frontend-interaction-contract.test.ts` check that the popover and the main window do not render the digest.
