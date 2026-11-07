# Collaboration contract

Current product language calls the Connected Folder helper a **Worker** and the
management helper the **AmpleFile agent**. This durable contract keeps its
technical `connected-folder`, `fold`, and `automation` record and command names.

> **Status:** Accepted 2026-09-11 (owner decision) as the wave B build
> specification under [Receipts, not gates](receipts-not-gates.md). It turns
> the design in agent collaboration and app AI primitives (archived in the work-fold repository)
> into concrete verbs, records, and defaults. Where this document and that
> plan differ, this document governs; where this document and the receipts
> record differ, the receipts record governs.

The goal: a person asks the AmpleFile agent for an outcome, the AmpleFile agent and Connected Folder
agents divide the work, hand each other selected results, ask each other
and the person questions, and continue exactly once when an answer arrives.
Custom apps see their own work change without polling. Any shell-capable
agent on the CLI gets the same verbs. Nothing in this contract adds a gate.

The person-facing presentation is specified in [Collaboration experience](collaboration-experience.md):
request-wide progress and Stop, addressed questions, selected files, and explicit recovery
across Chats, the AmpleFile agent, and Apps.

Native Pi Extension dialogs are a separate compatibility mechanism: the
development [Extension UI adapter](skills-and-extensions.md#live-extension-questions)
places live callbacks in the owning Chat and cancels them on Stop or session
end. It cannot reconstruct a callback after restart and does not claim F27's
durable answer/continuation semantics. An Extension needing those semantics
uses the collaboration verbs below.

## Register entries

The 2026-10-18 follow-on [Worker tools](worker-tools.md) add typed adapters over
these same verbs, asynchronous questions whose answers queue behind active
work, managed Git working copies registered as ordinary Connected Folders, and
turn-scoped read-only helpers. Ordinary questions keep F27's blocking behavior.
An asynchronous question reads working during its asking turn and waiting
afterward; an accepted answer starts its single continuation only when idle.

| # | Decision | What it does not change |
|---|---|---|
| F25 | **Durable requests.** Every accepted agent turn belongs to a machine-local request record. An AmpleFile agent turn creates a root request; a `chat send --parent-task` creates a child request under it; a Connected Folder turn with no parent creates its own root. Records live under the state root (`requests/`), survive restart, are reconciled against the turn journal, and are never replayed. The in-memory AmpleFile agent request registry is replaced by this store; `agent status` keeps its projection. | Turn acceptance, conflict rules, History checkpoints, and kernel task records stay where they are. Connected Folder transcripts carry nothing new. |
| F26 | **Connected Folder turns get their own context.** Every Connected Folder turn's hidden context names its task id and request id and, when delegated, an opaque parent handle and the assignment text. A compact operations guide is appended to the system prompt the way Connected Folder instructions are, describing the verbs below and the rule that cross–Connected Folder work goes through them. The AmpleFile agent transcript, the Connected Folder registry, and unselected results from other Connected Folders never enter a Connected Folder turn. | Nothing is written into the Connected Folder's folder. `.pi/` and `.amplefile/` are untouched. |
| F27 | **Report, ask, answer, handoff.** Connected Folder–scoped collaboration verbs and management-scoped `agent ask|answer`, receipted and journal-first: `chat report` attaches a result envelope to the caller's task; `chat ask` records a question and puts the task in `waiting`; `chat answer` and `agent answer` durably reserve one answer delivery and start exactly one linked continuation turn; `chat handoff` asks the host to start a new Chat in another Connected Folder with a message and copies of named files. Delivery is host-side: no AmpleFile agent model turn is needed to move a report, an answer, or a handoff. | The person's free-text Chat reply stays a supported way to answer. Automations remain the only unattended cross–Connected Folder glue on a trigger. |
| F28 | **Waiting is a host state.** `chat wait` and `agent wait` return when the followed task reaches a terminal state or `waiting`, and say which. A parent turn never blocks on a child that is waiting for input; it finishes and reports the request as `waiting`. When an owning Chat is idle and its children have settled or asked questions, the host can start one continuation carrying undelivered direct-child reports. This applies to the AmpleFile agent, Connected Folder, app, CLI and automation requests. Delivery is recorded by child turn identity, never inferred from relative settle times. | No arbitrary event-driven fold turns. A continuation belongs to an explicit request; declared automation agent steps remain the only trigger-driven entry. |
| F29 | **One result shape.** A result envelope is `summary` (text, at most 4 MiB), optional `data` (JSON, at most 16 MiB, validated against a schema when the request declared one), optional `files` (Connected Folder–relative paths with digest and size), and `outcome` (`succeeded`, `partial`, or `failed`). Reports, app assistant tasks, handoff outcomes, and automation chat hops all produce it. | Existing `fileChanges` turn metadata stays as evidence; a report's `files` are the deliverables the agent chose. |
| F30 | **Apps see their own work change.** `bridge.tasks.onChanged`, `bridge.checks.onChanged`, and `bridge.files.onChanged` deliver bounded hints for the app's own assistant tasks and inference receipts, its selected Checks, and its granted file roots. Active views subscribe; workers receive task/file hints during an operation, while Check access and hints remain view-only. Viewers do not subscribe. A hint carries ids and revisions, never content; the app re-reads. | Hints never start a model turn. The internal settle signal stays private. |

### 2026-10-01 amendment: Connected Folders inside Connected Folders

A person may register Connected Folders inside another Connected Folder (a repository and its
packages). Each inner Connected Folder's Worker owns that part of the parent's folder.
F26 is amended in two narrow ways; both come from the person's own acts, not
from the registry:

- **Nested Connected Folders.** A Connected Folder turn's hidden context lists the Connected Folders
  registered directly inside its own folder (id, name, path relative to it)
  and asks the Worker to hand their work off with `chat handoff` instead of
  editing it. The parent learns nothing else about them, and a Connected Folder with no
  nested Connected Folders hears nothing new.
- **Addressed Workers.** When the person writes `@Name` in a message, the
  composer sends those Connected Folder ids as `addressedConnectedFolderIds` (at most eight,
  never the sender's own; an id no longer registered is dropped, and the ids
  stay out of the request digest so a retry still replays). The host resolves them to id and name
  in that turn's context only. A Connected Folder Worker hands each its part with
  `chat handoff`; the AmpleFile agent sends each its part with
  `chat send --parent-task`. The `@Name` text stays ordinary message text.
  A message steered into a running turn carries no addressed Workers; the
  composer queues a message that mentions one until the turn ends.
- **Connected Folder operations.** A parent Connected Folder cannot delete, move, or rename a
  folder that holds a nested Connected Folder, or anything inside one; that content is
  changed from the nested Connected Folder itself.

Nothing new is written into a Connected Folder's folder, and the Connected Folder registry, the
AmpleFile agent's transcript, and other Connected Folders' results still never enter a Connected Folder turn.
`amplefile connected-folders list --json` and the AmpleFile agent turn's registry snapshot
carry `parentConnectedFolderId` for a nested Connected Folder, so the AmpleFile agent can split a
request by owner.

### 2026-10-18 amendment: host environment and role

- **Host environment.** Every Worker and AmpleFile agent turn context opens
  with one host-owned line: the weekday and the host's local time in ISO 8601
  with its UTC offset, the IANA time zone, and the platform. The host reads it
  when the turn starts and sends it in the per-turn context, not the system
  prompt, so it stays current and the cached prompt prefix is unchanged. The
  AmpleFile agent resolves the absolute times `at` Automations and
  `chat snooze --until` take from it.
- **Role.** Each request opens with the session's role — this Connected Folder's
  Worker, or the AmpleFile agent — in place of Pi's coding-assistant sentence.
  Only that sentence changes, and only in the request: Pi's tool list, tool
  rules, and docs section stay as Pi renders them, the transcript keeps Pi's
  recorded sections, and a person's own `SYSTEM.md` is left as written.

### 2026-10-18 amendment: background jobs

[Background jobs](background-jobs.md) (F31–F33) add a request's own
long-running work to this contract without a new lifecycle:

- **A job is outstanding work of its request.** A shell command a running
  Worker or AmpleFile agent turn starts with `job_start` or `jobs start`
  joins that turn's request, which reads `working` while it runs (state rule
  6) and `failed` if a restart interrupted it (rule 9). Stop on the request,
  or any ancestor, stops it; settled deletion waits for it.
- **A finished job continues its request once (F28).** Its end is delivered
  by a read in its Chat, by the next turn's context, or by one host follow-up
  joined to its request, carrying the exit status, History coverage, and the
  end of the output. Delivery is recorded by job id. A finished job does not
  wait for delegated children, and the Limits switch, Stop fences, and
  "restart never replays" apply unchanged.
- **Output stays machine-local.** Only what a turn reads or the follow-up
  carries enters a Chat.

### 2026-10-18 amendment: follow up, redirect, copy, checklist, compaction

A gap review against other agent harnesses found that delegated work could
start and finish but not be continued, corrected, or branched. Three verbs
close that without a second delegation system; each reuses the request
graph, receipts, and Stop above.

- **Follow up.** `chat handoff --to-conversation <id>` sends the next
  message into a Chat the caller's Chat already handed work to, so that
  Worker keeps its context. It becomes a new child of the caller's request,
  and it is refused while that Chat is working. The AmpleFile agent already
  follows up with `chat send --conversation`.
- **Redirect.** `chat steer --conversation <id> --message <text>` adds one
  message to a Chat's running turn, delivered after its current step through
  the same steering path the desktop uses. With `--task`, a Worker can steer
  only a Chat its own Chat handed work to; an idle Chat is refused by name.
- **Copy.** `chat copy --conversation <id>` (and **Make a Copy** in a Chat's
  menu) creates a new Chat in the same Connected Folder with that Chat's visible
  transcript and Pi session as of its last finished reply. A turn still
  running is left out, so the copy never inherits an unanswered tool call.
  Copied messages get new ids and no turn or request identity, and the
  original is never written. With `--task` and `--message`, a Worker copies
  its own Chat, or one it handed work to, to try another direction with the
  same context; that work is a child of its request and reports back like a
  handoff. This is a host-owned copy, not Pi's session switching, which stays
  unavailable.

- **Checklist.** A Worker or the AmpleFile agent can keep a short
  checklist for its request with the `checklist` tool, sending the whole
  list each time. The host keeps it on the request record, shows it in the
  Chat's work view, and hands it back at the start of
  every later turn of that request: an answer's continuation, a follow-up
  that brings results back. When a long turn is compacted partway through,
  the host restates the checklist as it stands together with the turn's ids
  (below). Only the request's running turn can change it.
  An empty list clears it. It holds at most 200 one-line items of 2 KiB.

- **Through compaction.** When Pi compacts in the middle of a long turn, the
  turn's hidden context can be folded into the summary. Measured runs then
  reported under the wrong task id and narrowed the work. A request-local
  note after the summary now restates the turn's exact ids, the person's
  request when it is no longer visible, and the checklist. For Worker answer/result
  continuations it also restores the request's own original assignment,
  separately from the current answer, so the original literal requirements
  remain available beyond the summary. Later answers and
  corrections still apply; long excerpts disclose their bound. It asks the agent
  to recover applicable completed evidence first, then recheck changed sources,
  dynamic state, missing coverage and unresolved concerns. Compaction alone
  does not invalidate completed verification. Nothing is written to the
  session (helper tool experiment, archived in the work-fold repository).

- **Progress and evidence recovery.** `progress` retains bounded completed-tool
  observations and agent-authored findings in the existing machine-local Pi
  session. A request-local index survives compaction and own answer turns;
  host-owned request membership scopes recovery. File fingerprints disclose
  stale or untracked sources rather than turning a checklist into proof. See
  [Worker tools](worker-tools.md#progress-and-evidence-recovery) for pagination,
  retention and source-binding limits. Recovery never replays execution.

"Handed work to" is a host check: some request in the target Chat has a
parent request owned by the caller's Chat. Nothing else about other Chats
is revealed, and the person's own CLI use, which carries no `--task`, is
unchanged.

## Verbs

All are act-lane and receipted; `chat` verbs name a Connected Folder and `agent` verbs own management questions. They are available to the AmpleFile agent, a Connected Folder
agent, an app-requested task, and an outside harness alike. `help
collaborate` documents them with examples that the tests validate.

```
amplefile chat report  --connected-folder <id> --task <own-task-id> --summary "<text>" [--data <json-or-@file>] [--file <connected-folder-path>]... [--outcome succeeded|partial|failed] --json
amplefile chat ask     --connected-folder <id> --task <own-task-id> --question "<text>" [--option "<choice>"]... [--to person|parent] --json
amplefile chat answer  --connected-folder <id> --question <id> --answer "<text>" [--parent-task <id>] --json
amplefile chat handoff --connected-folder <id> --task <own-task-id> --to-connected-folder <id> [--to-conversation <id>] --message "<text>" [--file <connected-folder-path>]... --json
amplefile chat steer   --connected-folder <id> --conversation <id> [--task <own-task-id>] --message "<text>" --json
amplefile chat copy    --connected-folder <id> --conversation <id> [--task <own-task-id>] [--message "<text>"] [--title "<title>"] --json
amplefile chat wait    --connected-folder <id> --task <id> [--timeout <s>] --json     # settles on terminal OR waiting
amplefile agent ask   --task <own-task-id> --question "<text>" [--option "<choice>"]... --json
amplefile agent answer --question <id> --answer "<text>" --json
amplefile agent wait  --task <id> [--timeout <s>] --json                  # same
amplefile requests list|show --request <id> --json                          # management-scope reads of the request graph
```

- A task id in `--task` must belong to the caller's own turn; the host
  validates it the way `--parent-task` is validated today.
- `--option` (repeatable, 2026-10-18) offers suggested answers. Trusted
  surfaces show them as buttons beside the answer box; a click sends that
  choice's text through the same one-answer path, and a typed answer is still
  accepted. A question offers at most 64 choices of at most 4 KiB each, one
  line, none repeated.
- `chat ask --to parent` on a root request with no parent is delivered to the
  person. `--to person` is the default.
- `chat answer` refuses a second answer, an answer after Stop,
  and an answer from a Connected Folder that does not own the question. The
  continuation is a new turn in the same Chat, carrying the answer as an
  ordinary user-role message with the question id in machine-local metadata.
- `chat handoff` copies files through the same additive, restore-pointed path
  as `files add`, starts a new Chat in the destination through the normal
  acceptance path, links it as a child of the caller's root request, and the
  destination's report flows back to that root.
- Delivery of a report to a parent whose turn is still running is available
  to that turn through `chat wait`. Reading a child's settled result with
  `chat result` or `agent result` while the parent's turn runs, which is how
  `chat wait` ends, records that child turn as delivered, so no follow-up
  turn repeats it (2026-10-18). A parent whose turn has ended sees it in
  `agent status`, `requests show`, the overview, and the continuation turn.

## Completion, delivery and recovery

A request owns the work; a turn is one execution within it. Status, waits,
app receipts and automation hops follow the request across answer and synthesis
turns. An unanswered question or an accepted answer without a linked turn
remains outstanding, including after restart. Stop fences answer acceptance
and continuation admission through every ancestor.

The original assignment is saved separately from the latest message. Every
Connected Folder continuation rebuilds its assignment and delegated handle from that
record. Selected direct-child reports may be admitted into a new turn's hidden
context; their delivery identities are recorded. Otherwise an idle owner can
receive one synthesis turn. Children finishing before their parent
ends are eligible too, unless the parent already read that result mid-turn. Nested owners synthesize before their own parent wakes.
When compaction holds an otherwise idle owner, both successful and failed
compaction cleanup reevaluate its pending child deliveries. This releases
only results settled during the current app run; restart never replays them.
The same child turn is not delivered twice, and a continuation cannot wake
itself. A reserved continuation that fails acceptance or is interrupted by
restart is recorded as failed, without redispatch.

`chat result --connected-folder <id> --task <id>` and `agent result --task <id>` return
`request` and the completed request's selected `result` envelope alongside
its latest reply. They refuse while work remains outstanding. A Connected Folder can
read a named child's released result through that child's Connected Folder and task id;
it cannot read the machine-wide request graph. The latest turn's latest
report describes its outcome; old partial reports remain history rather than
permanently preventing a later successful result. File paths belong to the
reporting Connected Folder until explicitly copied.
Synthesis selects that same latest-turn report and its files. An older
success cannot describe a failed answer turn or a new turn with no report;
failed, stopped, and partial request outcomes override an optimistic report.

Deleting a Chat, a file, or a Connected Folder refuses while its affected request
graph remains unfinished, including questions waiting for an answer and
accepted continuations. Stop closes outstanding work but deletion waits for
its accepted turns to drain. File and Connected Folder deletion also reserve the
affected Connected Folder against new turns, compaction, Checks, app jobs with file
access, and Automation file work until the deletion completes.

An app receipt keeps its installation and authority pins while following the
whole owned request. `waiting` is ongoing and has no final result. Stop reaches
outstanding descendants, schema validation applies to every own continuation,
and usage totals include settled delegated work. An automation waits for the
request, not only its first turn. If it needs an answer, the automation ends at
that hop with an explicit failure; answering in the Chat continues that
request but never replays subsequent automation effects.

## Records

- **Request:** id, kind (`management`, `connected-folder`, `app`, `automation`, `cli`),
  root id, parent task id, original assignment, latest message, delivered child
  turn ids, continuation reservation state, owner scope (management, or Connected Folder id plus
  conversation id), app installation when applicable, surface, created at,
  state (`working`, `waiting`, `handed_off`, `done`, `partial`, `failed`,
  `stopped`), children, questions, results, usage, and the optional
  checklist its running turn keeps.
- **Question:** id, request id, task id, respondent (`person` or `parent`),
  text (at most 4 MiB), optional suggested choices, asked at, state (`open`, `answered`,
  `cancelled`), answer and answered at, continuation task id.
- **Result:** the envelope above plus task id, recorded at, and receipt id.
- Records are machine-local under the state root. Only the assignment text,
  the answer text, released report summaries, and copied files ever enter a
  Connected Folder Chat.

## Execution and transport bounds

Requests, questions, reports, and continuations do not have a built-in
lifetime, delegation-depth, or count quota. They remain explicit, durable
records until they settle, are stopped, or retention removes settled data.
Each Chat runs one turn or compaction at a time. Different Chats and
Connected Folders, including AmpleFile agent Chats, can run concurrently; delegated children
have no separate slot limit or waiting queue. Transport fields keep resource
guards sized so ordinary work never meets them (2026-10-10).

| Bound | Value | On hit |
|---|---|---|
| Question text | 4 MiB | the write is refused before it is recorded |
| Question choices | 64 choices, 4 KiB each | the write is refused before it is recorded |
| Answer text | 4 MiB | the write is refused before it is recorded |
| Result summary | 4 MiB | the write is refused before it is recorded |
| Result data | 16 MiB | the write is refused before it is recorded |
| Provider budget per root | no default cap; a host may set one | request fails when the configured cap is exceeded |

## Apps

- `bridge.tasks.onChanged(listener)` fires for the installation's own
  assistant tasks and inference receipts: `{ revision, taskIds, receiptIds }`.
- `bridge.checks.onChanged(listener)` fires when a selected Check's result
  changes: `{ revision, permissionIds }`.
- `bridge.files.onChanged(listener)` fires when files under a granted root
  change on disk, debounced, bounded: `{ revision, permissionIds, truncated }`.
- Subscriptions are per mount, dropped on close, and never replayed. Check
  reads/hints remain view-only. Inference receipt ids can refresh the trusted
  Apps view; the app bridge has no receipt lookup.
- App assistant tasks produce the F29 envelope: `result.summary`,
  `result.data` when the action declared an output schema, and `result.files`.

## What does not change

- Everything in the receipts record's "What does not change".
- The AmpleFile agent has no independent ambient scheduler. A declared automation agent step may start an AmpleFile agent request; its continuations keep the same durable identity and Stop behavior.
- Connected Folder Chats stay portable and carry no cross–Connected Folder state.
- The bounded text-review Check, `assistant.infer`, and the app sandbox.

## Build plan

Wave B is one gated workflow on the `receipts-not-gates` branch: survey →
foundations (request store, question store, envelope validator, help text) →
request integration (replace the in-memory registry; Connected Folder turn context and
guide) → verbs and continuation → app subscriptions → fold instructions,
docs, and copy → gates → adversarial review → checkpoint. Acceptance is the
plan's "Delegate and clarify", "Request help from a Connected Folder", "Compose Connected Folders
and apps", and "Discover and build" journeys, each driven end to end through
the local API and CLI in tests, plus restart and double-answer cases.
