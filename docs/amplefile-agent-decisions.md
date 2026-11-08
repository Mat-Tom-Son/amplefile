# AmpleFile agent decision register

> **Current presentation language.** The **AmpleFile agent** is the Worker
> above all Folders. This decision register retains *the AmpleFile agent* where it names
> its historical technical contract, routes, storage, CLI, and identifiers.
> **Automations** is the visible name for the deterministic automation feature.

> Request lifecycle consolidation: the [collaboration contract](collaboration-contract.md#completion-delivery-and-recovery)
> governs completion across turns. Questions use `chat ask|answer` or `agent
> ask|answer`; an accepted answer remains outstanding until linked. The AmpleFile agent
> and Connected Folder owners receive bounded, recorded child-result deliveries,
> and task result reads expose the request's selected envelope. Transport fields and concurrent execution remain
> bounded; requests and automations have no lifetime or declaration-count quota.


The **AmpleFile agent** is the one user-facing name for AmpleFile's one management
surface: the **AmpleFile agent** above all Connected Folders and its
**menu-bar/tray popover** ("Your fold"). The **Remote access web client**
("Your fold on the web") was removed from the desktop with Web Access on
2026-11-07. It is the one door to all Connected Folders: things come in
through it (drops, attachments, `files add`). Connected Folders are the
rooms; the AmpleFile agent is the door.

> **The AmpleFile agent is the one door to all your Connected Folders: what you hand it gets put
> where it belongs, what you ask for gets done with a receipt, and nothing it
> does is permanent at the moment it happens.**

This document records the decisions the AmpleFile agent's implementation and product
surfaces must preserve, alongside the canonical registers that absorbed the
AmpleFile agent's rails, nouns, and contract text on 2026-08-11:
[Product model](product-model.md) (nouns, explicit-context rows, rails 9–11,
the roadmap direction), `AGENTS.md` (contributor rails, act-lane families),
[the AmpleFile agent layer](amplefile-agent-and-cli.md) (receipts, prepared acts,
the verification map), `README.md`, `SECURITY.md`,
`PRIVACY.md`, [Desktop parity](ui-parity.md), and
[the visual system](visual-design.md). The sibling documents are shipped
contract references retaining the detail canon does not carry:

- [Receipts, not gates](receipts-not-gates.md) — the 2026-09-10 decisions F19–F24, the trash, and automation changes (its app defaults and app AI lanes left with apps on 2026-11-07).
- [The collaboration contract](collaboration-contract.md) — the 2026-09-11 decisions F25–F30: durable requests, Connected Folder turn context, report/ask/answer/handoff, one result shape, and app change hints (removed with apps on 2026-11-07).
- [Background jobs](background-jobs.md) — the 2026-10-18 decisions F31–F33: a job belongs to the turn that started it, a finished job wakes its Chat once, and its output stays machine-local.
- [The verb ledger](act-ledger.md) — every product verb's classification, command shape, receipt additions, undo path, and conflict rules.
- Consecrations (archived in the work-fold repository) — superseded 2026-09-10; retained for the threat-model residuals that still apply.
- [Automations](automations.md) — declared deterministic cross–Connected Folder glue: triggers, declarations, the executor, and bounds.
- [The overview](amplefile-agent-overview.md) — the deterministic digest: sources, sections, markers, surfaces, and non-goals.
- The publishing ladder (archived in the work-fold repository) — retired 2026-11-05 with desktop-served sharing; its replacement, the Online pages plan, was removed from the desktop with Publish on 2026-11-07.
- Integration (archived in the work-fold repository) — the promotion record: applied amendment blocks, cross-thread reconciliations, and the items still held with their gates.

## The doctrine in one paragraph

The AmpleFile agent has a ledger: every product verb executes on the call
that asks for it, pinned, journaled before execution, and receipted after.
There is one authority mode; nothing waits on a card, a standing rule, or a
second click. Every destruction is reversible — History covers what it can
and Recently deleted holds the rest for a retention window — and every
grant is revocable. Disclosure is after the fact: the overview and
receipts say what happened, and needs-you means an
Assistant asked a question. Setup that establishes identity or secrets —
the act token and provider secrets — stays outside the act
vocabulary and never blocks a task. Bounds are generous defaults in
Settings, and every limit hit names the limit. A person's ask is a durable
request: the AmpleFile agent and Workers divide it into child turns, hand each
other one result shape, ask each other and the person questions, and continue
exactly once when an answer arrives. Waiting is a host state, so no turn sits
on a child that is waiting. Above Connected Folders, only declared deterministic
automations run unattended. The overview is the app-composed digest
of recorded state; narration of it is interactive, never scheduled.

What the AmpleFile agent is **not**:

- Not a Connected Folder. Its transcript is machine-local application state and never
  travels with a folder.
- Not a second Assistant, persona, or brand voice. Replies stay labeled
  AmpleFile; the AmpleFile agent is where you meet it and what the conversation is
  called.
- Not a rename of anything else. **Connected Folder**, **Library**, **Assistant
  tools**, **Chats**, and **History** are untouched; there is no "foldr".
  (The desktop Library and the Skills & Extensions tab were retired on 2026-09-25
  by the information-architecture amendment in [the product model](product-model.md);
  that was a separate decision, not a fold rename.)
- Not a new technical contract. `amplefile agent …`, the
  `amplefile-agent` scope id, the `/api/management/*` routes, the
  `management/` application-state root, and "AmpleFile agent" as a contract term all stay exactly as
  documented in [the AmpleFile agent layer](amplefile-agent-and-cli.md).

## Decision register

Recorded from the product owner on **2026-08-10**; promoted into the
canonical documents on 2026-08-11 through the amendment blocks recorded in
Integration (archived in the work-fold repository). The siblings design within these
decisions, not around them. Rows without an inline date were recorded on
2026-08-10. F3–F7 and F17 are retained as history and superseded by F19
(2026-09-10); F8, F9, and F18 are narrowed as noted in their rows. F11 was
retired on 2026-11-05, and F15 narrowed, as noted in their rows. On
2026-11-07 (owner decision) Web Access and Publish were removed from the
desktop: no paired browser, web client connection, or online page remains,
and F1, F11, F13, and F15 carry that note in their rows. Connected Folder
apps and App Studio were removed the same day (owner decision): F21, F22,
and F30 are retired, and F18, F19, F20, F28, and F29 carry that note in
their rows. The
2026-09-10 decisions F19–F24 are recorded here verbatim from
[Receipts, not gates](receipts-not-gates.md), which remains their
specification. The 2026-09-11 decisions F25–F30 are recorded here verbatim
from [the collaboration contract](collaboration-contract.md), which remains
their specification; F8 and F9 keep the narrowings that record relies on.

| # | Decision (dated) | What it does not change |
|---|---|---|
| F1 | One thing, one name: the AmpleFile agent, the menu-bar/tray popover, and the Remote access web client are one product surface named **the AmpleFile agent** — the one door to all Connected Folders, capture in and publish out. *Narrowed 2026-11-07 (owner decision):* the Remote access web client was removed from the desktop with Web Access. | No new runtime, transcript store, or Assistant; the three surfaces keep their existing machinery. |
| F2 | Scope: one complete effort, no phases. Four threads — verb ledger, automations + overview, naming and copy, publishing ladder — delivered as proposal documents; implementation follows owner review. | Nothing in this set is implemented before that review. |
| F3 | **Superseded by F19 (2026-09-10).** The AmpleFile agent becomes able to do anything a person can do in the app, with a receipt for everything — except the consecrations and the never-list. | The click remains the product's definition of authorization; receipts are added, trust prompts are not. |
| F4 | **Superseded by F19 (2026-09-10).** Tier model: exactly two tiers (direct receipted verbs; consecrations) plus a never-list. There is no general "co-sign everything big" tier. | Standing policies narrow consecrations; they do not create a third tier. |
| F5 | **Superseded by F19 (2026-09-10).** Remote consecration clicks: a consecration decision may be approved from the desktop **or** from any approved full-trust remote browser. Compensating controls: every decision receipt names the approving surface and exact browser identity/grant; revoking a browser cancels that browser's pending decisions; a staged act is never decidable from the same remote grant whose request staged it; make-runnable at Personal scope (code loading into the AmpleFile agent's own runtime) is decided on the desktop only; the never-list is untouched. | The never-list is not weakened to match; Remote access administration itself stays desktop-human-only. |
| F6 | **Superseded by F19 (2026-09-10).** The three consecrations are **make bytes runnable**, **widen a power**, and **destroy irreversibly**; the AmpleFile agent may stage all three, and only a human click completes them. Staged acts expire; expiry is not approval; denial is recorded, not retried. | Existing individual grants (destinations, file roots, notification categories, connections, named automations) stay separate acts; consecration is their shared ceremony, not a merge. |
| F7 | **Superseded by F19 (2026-09-10).** Standing policies are person-authored outside any assistant turn, host-evaluated at decision time, inspectable, revocable, and receipted when exercised. The AmpleFile agent may cite policies, never write them. | No model-authored policy, ever; policy evaluation never moves into the model. |
| F8 | Agency on a schedule always lives in Connected Folders. Above Connected Folders, only declared deterministic glue (automations) runs unattended; enabling an automation is a consecration. *Narrowed 2026-09-10:* keeps its ban on ambient or arbitrary event-driven fold turns; now permits an automation's declared `fold` step and, in the collaboration work, bounded continuations of a person-initiated request. Enabling an automation is one receipted call (F23). | Only a declared automation step starts a scheduled AmpleFile agent turn; the overview's narration stays on-demand. |
| F9 | Management-scope and cross–Connected Folder work never runs inside a Connected Folder chat, because Connected Folder transcripts are portable (`.amplefile/conversations/` travels with the folder) and cross–Connected Folder context in a Connected Folder transcript is a leak. *Narrowed 2026-09-10:* a payload-admission rule rather than a transport rule — what may enter a Connected Folder Chat from above is its assignment, explicitly released payloads, and answers to its own questions; the AmpleFile agent transcript, the Connected Folder registry, and other Connected Folders' results never enter a Connected Folder Chat. | Delegated in–Connected Folder work continues to run in Connected Folder chats with that Connected Folder's Assistant. |
| F10 | The overview is a deterministic digest composed by app code from kernel-recorded state only — no model call, no file scanning, no ambient watching. | Nothing new is recorded to feed it; it reads state the product already keeps. |
| F11 | Publishing introduces the **viewer**: per-artifact, read-only, link-scoped, revocable, receipted. Viewers are not paired browsers and never touch the management lane. Out of scope: public discovery, an App Store, uptime promises. *Retired 2026-11-05 (owner decision):* desktop-served sharing and its viewer plane were removed; the Online pages plan (archived in the work-fold repository) proposed the replacement. *2026-11-07:* that replacement was removed from the desktop with Publish. | Paired-browser trust and the bridge's content-free default are not redefined by viewer traffic. |
| F12 | Naming depth: user-facing copy and docs only. The CLI keeps `amplefile agent …`; internal types, protocol identifiers, scope ids, routes, provenance values, and "AmpleFile agent" as a contract term stay. | Brand word and contract words do not have to match; no compatibility break is spent on a rename. |
| F13 | Copy specifics: **"Fold it in"** is the capture verb; Settings → Remote access becomes **"Your fold on the web"** without renaming technical contracts; the word Connected Folder stays; no "foldr"; Connected Folders are never renamed to folds. *Narrowed 2026-11-07:* Settings → Remote access was removed with Web Access. | Connected Folder, Library, Skills & Extensions, Chats, History vocabulary is untouched. |
| F14 | Automation chat-step provenance: the message an automation sends into a Connected Folder chat is an **ordinary user-role message** — the portable transcript carries no automation marker. Attribution is machine-local: automation run receipts, hop journals, run history, and the overview. *Narrowed 2026-09-10 (F23):* the reviewed message is a template; the closed set of host-resolved placeholders is the only substitution, and the resolved text is bounded and recorded on the hop receipt. | The interruption-marker semantics of Connected Folder chats and the F9 leak rule are untouched; the message is still reviewed at enablement and names nothing cross–Connected Folder beyond what the declared placeholders carry. |
| F15 | The AmpleFile agent's Settings surface is one section named **Settings → The AmpleFile agent**, hosting **Your fold on the web** (web access) as a subsection alongside standing policies, automation management, and publication controls. *Narrowed 2026-09-10 (F19, F20):* the section hosts Your fold on the web, Recently deleted, Limits, automation management, and publication controls; it has no standing-rules or authority subsection. *Narrowed 2026-11-05:* publication controls were removed with desktop-served sharing (F11). *Narrowed 2026-11-07:* Your fold on the web was removed with Web Access. | Page ids and routes stay technical per F12; "Remote access" survives in contract and security prose. |
| F16 | At promotion, [fold.md](amplefile-agent-decisions.md) shrinks into a compact fold decision register named by AGENTS.md's required reading (the Checks precedent); the siblings shrink into it as their sections ship. | product-model.md remains the constitution; the amendment blocks in Integration (archived in the work-fold repository) still apply exactly as written. |
| F17 | **Superseded by F19 (2026-09-10).** **Authority modes** (2026-08-31): Settings → The AmpleFile agent → Authority offers **Reviewed** and **Unrestricted**. Reviewed preserves host-composed cards and standing policies. Unrestricted executes every newly admitted staged act, including irreversible destruction, viewer exposure, automation enablement, and whole–Connected Folder file grants. Approved browsers inherit it structurally through the desktop host. Mode changes, pairing, and credential entry remain local setup surfaces with no Assistant/CLI/remote verb. Existing pending cards are not drained when the mode changes. | Pins, eligibility, effect-time rechecks, journal-first consumption, receipts, fences, at-most-once execution, and failure-without-auto-retry remain intact. The five setup-only families are boundaries of identity and secret handling, not recurring approvals. |
| F18 | **Explicit folder observation and text review** (2026-09-05): version-3 automations may watch one bounded folder with explicit types, debounce, and cooldown. Watchers baseline on startup/wake and pause during automation work, without catch-up, to prevent file feedback loops. Cross–Connected Folder composition remains one ordered automation. The built-in text-review Check uses the AmpleFile agent's selected model with only designated text and criteria, no conversation or general tools, and quote/digest admission. *Narrowed 2026-09-10:* the text-review Check keeps its evidence admission; it is no longer the only bounded model lane, and `assistant.infer` reuses its transport. *Amended 2026-10-11 (owner decision):* a version-5 folder trigger may opt into catch-up with `"ifMissed": "run"`: a machine-local metadata snapshot lets AmpleFile start one coalesced run for files added or changed while it was closed, asleep, or the automation was off. Pausing during automation work, the fresh post-run baseline, and the no-backlog rule stay; see [Automations](automations.md). *Amended 2026-11-07 (owner decision):* Checks were removed, the text-review Check with them; folder observation is unchanged, and `assistant.infer` keeps the bounded model transport on its own. *Amended 2026-11-07 (owner decision):* `assistant.infer` left with Connected Folder apps; the host keeps the bounded model transport for its own folder suggestions. | Observation is an exact standing grant, never inferred from opening a Connected Folder. Model findings are suggestions; provider charges and target limits are disclosed at enablement. |
| F19 | **One authority mode** (2026-09-10). The Reviewed/Unrestricted selector, standing policies, decision cards, the pending-decision store, remote `decisions.*` operations, and the `staged` CLI family are removed. The fifteen formerly staged verbs plus `apps uninstall --purge-data` are direct receipted verbs that run through the existing prepare, pin, journal-first, fenced execution path immediately. *Amended 2026-11-07:* `apps uninstall --purge-data` left with Connected Folder apps. | Receipts, identity pins, effect-time rechecks, at-most-once execution, failure-without-auto-retry, capability-mutation fences, and turn-conflict rejection all stay. |
| F20 | **Reversible destruction** (2026-09-10). `files delete` always succeeds: History covers what it can, and every path the safety checkpoint cannot cover is moved into the machine-local trash. `files destroy` is removed. `connected-folders delete` moves the managed folder into the trash and unregisters it. App storage clear, retained-data purge, and uninstall-with-purge write a recovery export into the trash before removing live data. Trash entries are restorable from Settings → Recently deleted and from `amplefile recently-deleted list|restore`, and are purged only by retention (default 30 days, adjustable). *Amended 2026-11-07:* with Connected Folder apps removed, nothing writes app recovery exports into the trash. | The clean-break rule for legacy `.workspace/` trees, History's own capture limits, and the rule that `.amplefile/`, `.pi/`, and `.workspace/` are never valid file endpoints. |
| F21 | **Apps come up able to work** (2026-09-10). Installing a preview or a release grants every declared network destination, file permission (a directory permission binds to the whole Connected Folder), notification category, and Check-result slot, and enables every declared automation. A code change carries forward connections whose destination declaration is byte-identical, automation enabled states by id, and run receipts. Proposing an app from a Connected Folder Chat installs its local preview immediately; the proposal record is the receipt. `apps grant`, `apps revoke`, `apps disconnect`, and `apps automation disable` remain as the person's narrowing controls. *Amended 2026-11-07:* with Checks removed, there is no Check-result slot to grant. *Retired 2026-11-07 (owner decision):* Connected Folder apps were removed, with every app grant, connection, notification, and automation. | Secrets stay person-entered on the trusted surface, once per destination. The sandbox, brokers, declared destinations, and credential isolation of app code are unchanged: they bound generated code, not the Assistant. |
| F22 | **Apps use the AI runtime without a click** (2026-09-10). `assistant.request` dispatches a fresh full-tools Chat in the owning Connected Folder immediately and is available to active views, workers, and named automations. A new `assistant.infer` operation performs a bounded model call on the Connected Folder's configured model with no tools, no transcript, and optional schema-validated JSON output, available to views and workers. Neither needs a grant beyond installation. Both leave receipts with the effective model and usage. Viewers and remote app views get neither. *Retired 2026-11-07 (owner decision):* removed with Connected Folder apps; there is no `assistant.request` or `assistant.infer`. | Full Assistant work and bounded inference stay distinct operations with distinct powers. Model selection stays with the person per Connected Folder and for the AmpleFile agent. |
| F23 | **Cross–Connected Folder glue runs on request, not on ceremony** (2026-09-10). `automations stage` becomes `automations enable`, a direct receipted verb that pins the declaration digest. Chat-step messages accept a closed set of host-resolved placeholders for the triggering event and earlier steps' created files. A `fold` step kind sends a message into the AmpleFile agent, so a person can put the AmpleFile agent on a cadence deliberately. Run slots and step counts are raised to generous defaults. | Automation-caused settles still never fire triggers, observers still pause during automation work, and the files step is still additive and restore-pointed. Those are loop guards and recovery, not gates. |
| F24 | **Needs-you means questions** (2026-09-10). The overview's needs-you section carries Assistant questions, due snoozes, and requests waiting on a person's answer. Nothing there is an approval. Paired browsers see the same. | The overview stays a deterministic digest with no model call. |
| F25 | **Durable requests** (2026-09-11). Every accepted Assistant turn belongs to a machine-local request record. An AmpleFile agent turn creates a root request; a `chat send --parent-task` creates a child request under it; a Connected Folder turn with no parent creates its own root. Records live under the state root (`requests/`), survive restart, are reconciled against the turn journal, and are never replayed. The in-memory AmpleFile agent request registry is replaced by this store; `agent status` keeps its projection. | Turn acceptance, conflict rules, History checkpoints, and kernel task records stay where they are. Connected Folder transcripts carry nothing new. |
| F26 | **Connected Folder turns get their own context** (2026-09-11). Every Connected Folder turn's hidden context names its task id and request id and, when delegated, an opaque parent handle and the assignment text. A compact operations guide is appended to the system prompt the way Connected Folder instructions are, describing the verbs below and the rule that cross–Connected Folder work goes through them. The AmpleFile agent transcript, the Connected Folder registry, and unselected results from other Connected Folders never enter a Connected Folder turn. | Nothing is written into the Connected Folder's folder. `.pi/` and `.amplefile/` are untouched. |
| F27 | **Report, ask, answer, handoff.** Connected Folder–scoped collaboration verbs and management-scoped `agent ask|answer`, receipted and journal-first: `chat report` attaches a result envelope to the caller's task; `chat ask` records a question and puts the task in `waiting`; `chat answer` and `agent answer` durably reserve one answer delivery and start exactly one linked continuation turn; `chat handoff` asks the host to start a new Chat in another Connected Folder with a message and copies of named files. Delivery is host-side: no AmpleFile agent model turn is needed to move a report, an answer, or a handoff. | The person's free-text Chat reply stays a supported way to answer. Automations remain the only unattended cross–Connected Folder glue on a trigger. |
| F28 | **Waiting is a host state.** `chat wait` and `agent wait` return when the followed task reaches a terminal state or `waiting`, and say which. A parent turn never blocks on a child that is waiting for input; it finishes and reports the request as `waiting`. When an owning Chat is idle and its children have settled or asked questions, the host can start one continuation carrying undelivered direct-child reports. This applies to the AmpleFile agent, Connected Folder, app, CLI and automation requests. Delivery is recorded by child turn identity, never inferred from relative settle times. *Amended 2026-11-07:* app requests left with Connected Folder apps. | No arbitrary event-driven fold turns. A continuation belongs to an explicit request; declared automation agent steps remain the only trigger-driven entry. |
| F29 | **One result shape** (2026-09-11). A result envelope is `summary` (text, at most 4 MiB since 2026-10-10), optional `data` (JSON, at most 16 MiB, validated against a schema when the request declared one), optional `files` (Connected Folder–relative paths with digest and size), and `outcome` (`succeeded`, `partial`, or `failed`). Reports, app assistant tasks, handoff outcomes, and automation chat hops all produce it. *Amended 2026-11-07:* app assistant tasks left with Connected Folder apps. | Existing `fileChanges` turn metadata stays as evidence; a report's `files` are the deliverables the Assistant chose. |
| F30 | **Apps see their own work change.** `bridge.tasks.onChanged`, `bridge.checks.onChanged`, and `bridge.files.onChanged` deliver bounded hints for the app's own assistant tasks and inference receipts, its selected Checks, and its granted file roots. Active views subscribe; workers receive task/file hints during an operation, while Check access and hints remain view-only. Viewers do not subscribe. A hint carries ids and revisions, never content; the app re-reads. *Amended 2026-11-07:* with Checks removed, an app has no selected Checks to read or be hinted about. *Retired 2026-11-07 (owner decision):* removed with Connected Folder apps. | Hints never start a model turn. The internal settle signal stays private. |

## One-sentence definitions

2026-10-08 deletion amendment: F20 guarantees recovery coverage after a
deletion can run; it does not override busy-work conflicts. Files, Chats,
and Connected Folders cannot be deleted while their affected request work is
unfinished or still draining after Stop. Managed parent deletion also
requires removing nested registrations first. See [Trash recovery](receipts-not-gates.md#trash)
for interruption-safe folder and History moves.

- **The verb ledger:** every product verb is a receipted act-lane verb —
  explicit selection, journal-first receipt, at-most-once execution, desktop
  conflict rules — except the setup-only boundary.
- **A prepared act:** the execution shape formerly gated verbs still take —
  host-prepared typed facts, identity pins, effect-time recheck,
  journal-first consumption, fenced execution, at most once, never
  auto-retried — run immediately on the call that asks for it and answered
  with a receipt.
- **Recently deleted (the trash):** the machine-local store under the state
  root where every deletion History cannot cover goes — files, folders, a
  managed Connected Folder's folder — with a
  manifest per entry, restorable from Settings → Recently deleted and
  `amplefile recently-deleted list|restore`, purged only by retention (default 30
  days).
- **Setup-only authority:** the families with no model or CLI verb:
  act-token machinery, provider credentials, and settings administration —
  identity and secrets, never a mid-task wait.
- **An automation:** a machine-local, inert-until-enabled declaration of
  deterministic steps (`chat`, `files`, `agent`) on one
  reviewed trigger, executed by app code with per-hop receipts; enabling it
  is one receipted call that pins the declaration digest.
- **A request:** the machine-local record that owns one outcome — who asked,
  the turns and Connected Folders it spans, its questions, its results, and its usage —
  living under the state root's `requests/` directory,
  reconciled against the turn journal after a restart and never replayed.
- **A question:** a durable record of one Assistant asking the person or its
  parent for something. One accepted answer delivers exactly one
  continuation turn in the asking Chat; a second answer, an answer after
  Stop, and an answer from a Connected Folder that does not own the
  question are refused.
- **A result envelope:** the one shape every report,
  handoff outcome, and automation chat hop produces — a summary, optional
  structured data, optional chosen files, and an outcome of succeeded,
  partial, or failed.
- **Waiting:** a host state, not a blocked process. `chat wait` and
  `agent wait` return when the task they follow settles or starts waiting
  and say which; a parent turn finishes rather than sitting on a waiting
  child; and one continuation turn per settle batch carries the collected
  reports back.
- **The overview:** a deterministic digest — running work, needs-you questions
  and due snoozes, and what changed since the person last looked —
  composed by app code from recorded state only.

## Naming and copy rules

1. **the AmpleFile agent** keeps "agent" lowercase in sentences and always
   takes an article or possessive: "the AmpleFile agent". It names the one
   door — the conversation and every surface that opens it. Never "Fold" as
   a capitalized proper noun, never "a fold", never plural.
2. **AmpleFile stays the actor.** The person tells AmpleFile what to do and
   replies stay labeled "AmpleFile". The AmpleFile agent is the place and the
   conversation's name, not a second persona — so imperative strings
   ("Tell AmpleFile what to do", "Message AmpleFile") keep the product as
   addressee.
3. **"Fold it in"** is the popover composer's capture verb, shown exactly
   when material is being handed over (reference chips present). A
   message without material is just "Send". The popover has no permanent drop-zone instruction; its whole surface shows a
   drop affordance only while files, folders, or links are being dragged over
   it. While a request runs, the same aligned composer action reads **Stop**;
   it does not create a second action row.
4. **"Your fold on the web"** is the user-facing name of the web-access
   area inside **Settings → Web access**. "Web access" is the
   short operational form inside that area (toggle, danger actions, errors).
   "Remote access" survives wherever a document speaks contract or security
   posture. *Retired 2026-11-07* with Web Access.
5. **Contract terms are frozen** (decision F12): `amplefile agent …`, the
   `amplefile-agent` scope id, `/api/management/*`, the `management/`
   application-state root, and the `remote_web` provenance value that older
   records still carry. (The `management.*` remote-facade methods and the
   `remote` settings page id were removed with Web Access on 2026-11-07.) A
   document's first user-facing use binds the vocabularies once — "the AmpleFile agent
   (technically: the AmpleFile agent)" — then each section speaks
   its own language.
6. **Publishing copy** says "pages your fold serves", never "host your
   website". Honest absence states stay honest: an offline desktop is
   "asleep", not an error page pretending otherwise. *Retired 2026-11-05*
   with desktop-served sharing (F11); the
   Online pages plan set publishing copy for
   its replacement, which was removed with Publish on 2026-11-07.
7. Connected Folder, Library, Skills & Extensions, Chats, and History copy is untouched.
   *(2026-09-25: the desktop Library and the Skills & Extensions tab were retired
   separately; Skills & Extensions is the surface's only name.)*
8. **Receipts, not gates, in copy.** Person-facing strings never say staged,
   card, approve, policy, mode, Reviewed, or Unrestricted. Needs you names
   questions and due snoozes. Recently deleted is the trash's name; Restore
   and Delete now are its actions; a limit that stops work names the setting
   in Settings → Automations → Limits.

The shipped copy inventory is pinned by `tests/amplefile-brand.test.ts`
(popover title, tray entry, two-state send button),
`tests/onboarding-welcome.test.ts`, and
`tests/amplefile-agent-conversation.test.ts` (the model-facing identity
line keeps the phrase "AmpleFile agent").

## Where the AmpleFile agent lives in code

The [AmpleFile agent layer](amplefile-agent-and-cli.md)'s implementation and verification
map is the authority; in brief: prepared acts in
`src/local/prepared-acts.ts`, the Recently deleted store under the state
root's `recently-deleted/` directory with its module in `src/local/recently-deleted-store.ts`,
automations under `src/local/automations/`, the overview in `src/local/overview.ts` and
`src/local/overview-seen-store.ts`, the verb families in
`src/local/cli/act-commands.ts` and `src/local/cli/act-facade.ts`, and the
taught behavior in `src/local/amplefile-agent-instructions.ts`.

## Deliberately not

- **No localization pass.** The product is English-only today; the copy
  rules above are English rules and would need their own decision before
  translation.
- **No marketing surface.** The bridge landing page keeps its factual
  register; no taglines beyond the shipped copy, no "host your website"
  framing anywhere (rule 6).
- **No enforced tool restriction of the AmpleFile agent.** It remains full-trust and
  taught, per [the AmpleFile agent layer](amplefile-agent-and-cli.md) and the residual
  risks restated in Consecrations (superseded);
  changing that is a separate deliberate design.
- **No gate reintroduced as a convenience.** A confirmation, hold, or
  approval state on any verb is a register decision, not a UI tweak.
- **No fold on a cadence.** A continuation turn belongs to a
  person-initiated request and happens once per settle batch, within that
  request's limits. It is not a schedule, a watcher, or an event bus, and
  F8's ban on ambient fold turns is unchanged.

## Fold-led Checks (removed)

Checks — with their AmpleFile agent–led authoring, proposals, trials, and
human-reviewed corrections — were removed on 2026-11-07 (owner decision).
