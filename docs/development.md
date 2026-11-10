# Development

Start with [Contributing](../CONTRIBUTING.md). [AGENTS.md](../AGENTS.md) owns the
contributor rules; this guide explains how to run and navigate the checkout.

## Choose a development surface

Run commands from the repository root with Node 24 (`.nvmrc`) and npm 11.16.0
or newer. The install requirement and dependency-script policy are explained
in [Contributing](../CONTRIBUTING.md#prerequisites). `npm ci` uses the
committed lockfile. Git, Node, and npm are enough to run the repository checks;
model credentials and Apple signing credentials are separate.

| Surface | Command | What to expect |
|---|---|---|
| Browser UI + local API | `npm run local:dev` | Vite at `http://localhost:5173`, local API at `http://127.0.0.1:4327`; live renderer updates. The local API accepts the UI only from port 5173, so free that port if Vite reports another one |
| Inert UI preview | `npm run local:dev`, then open `http://localhost:5173/?fixture=connected-folder` | Sample Connected Folders drawn as the Mac app shows them; no API or model needed, any port works |
| Native, unpackaged Electron | `npm run desktop:smoke` | Builds and verifies the desktop, then opens Electron; restart after native changes |
| Packaged Mac candidate | See [Mac build lanes](macos-build.md) | Packaging, signing, and publication are separate from everyday development |

The inert UI preview is the fastest loop for layout and styling. It reads
sample data from `web-local/src/fixtures/` and never calls the local API, so
Vite alone (`npx vite --config vite.local.config.ts`) is enough. It imitates
the Mac app—Mac words and key glyphs, the traffic-light inset, and a stand-in
for the window material—unless `&platform=browser` asks for the plain browser
rendering. `/popover.html?fixture=agent` previews the menu-bar popover.
`&agentState=running` and `&agentEvents=1` show a running Chat and its live
steps; in development, `&script=fixture-chat-1` replays a Chat
(`&scriptDelay=` sets the pause in milliseconds). `&update=` shows an update
phase—`available`, `downloading`, `ready`, `installing`, `error`, or
`not_available`—in the sidebar's update indicator and Settings → About,
from the sample statuses in `web-local/src/fixtures/settings-fixture.ts`.
`&setUp=offer` shows the Set Up for Me card on the Connected Folder shown
first. The toolbar's Browser button opens the Browser pane over the sample pages in
`web-local/src/fixtures/browser-fixture.ts`; no page is drawn, and two of the
recent pages show a Worker's marker and a site's question.
Clicking an update asks the same restart question as the app (add
`&agentState=running` to have it name a working Chat) and then says
updating is disabled. The live transitions between phases need the desktop
updater. Actions that would change
files, settings, or History explain that they are disabled in the preview.

The browser preview cannot prove native dialogs, secure storage, preloads, or
built-in browser behavior, including where a page is drawn in the Browser
pane. Use the native lane for those changes.
`desktop:prepare` alone builds and runs automated probes; it does not launch the
normal interactive app or create an installer.

## Development state and model access

The browser/local API and unpackaged Electron default to **AmpleFile
Development** application data, separate from the installed app. They can
share that development profile. Run one development host at a time against a
given profile, and use disposable folders for tests that change files.
An existing folder remains a real folder, even in a development build.

Pi's personal capabilities and auth can still be shared with your normal Pi
configuration. To use separate app and Pi data, choose an explicit temporary
profile in your shell before launching either development surface:

```sh
amplefile_dev_root=$(mktemp -d "${TMPDIR:-/tmp}/amplefile-dev.XXXXXX")
export AMPLEFILE_STATE_DIR="$amplefile_dev_root/state"
export AMPLEFILE_DESKTOP_STATE_DIR="$amplefile_dev_root/state"
export AMPLEFILE_AGENT_DIR="$amplefile_dev_root/pi"
npm run local:dev
```

Use `npm run desktop:smoke` in place of the last command for Electron. The
variables apply to this shell and its children. Stop the host before removing
its temporary profile; keep test folders you want to retain. A data-directory
override does **not** isolate macOS Keychain. A signed Mac candidate uses the
production identity by default—follow the [candidate guidance](macos-build.md#interactive-packaged-smoke)
before launching one.

Real Worker and AmpleFile Agent turns need a model provider and may incur
charges. The browser development host and unpackaged desktop load the root
`.env` when present; already-exported variables win. Copy [the optional template](../.env.example)
only if you need it, and uncomment only the settings you intend to use.
`AMPLEFILE_AGENT_DIR` selects AmpleFile's Pi directory; the native Pi variable
`PI_CODING_AGENT_DIR` is also supported. `PI_AGENT_DIR` is not supported.

The installed `amplefile ... --json` CLI addresses the running app.
`npm run amplefile:drive` is a separate real-Pi-turn test driver and can use a
chosen agent directory; it is not an offline unit test. `--follow-ups <n>` keeps
its local API running for n more turns AmpleFile starts in the same Chat, such as
a [background job](background-jobs.md)'s wake-up, and reports each with the
message that started it. See
[the AmpleFile Agent and CLI](amplefile-agent-and-cli.md) before driving real work.

## Inspect a model request

For an installed Mac build, run:

```sh
open -n -a /Applications/AmpleFile.app --args --amplefile-inspect-context
```

The same command opens or focuses a separate inspector when AmpleFile is
already running. It uses the existing single-instance host and never enables
recording automatically. Close or Escape closes just the inspector window;
turn recording off explicitly when finished, or quit AmpleFile to discard it.
During browser development, open the local renderer with `?dev-context`
(for example, `http://localhost:5173/?dev-context` at Vite's default port).
This is a developer diagnostic route, with no normal Chat, AmpleFile Agent or
Settings entry. Enable **Record model context**, reproduce the behavior in the
app, then refresh and choose the request. The all-request view includes Worker
and AmpleFile Agent turns, titles, bounded inference, and compaction. Search or copy assembled context, compare
provider payloads where the adapter exposes them, and inspect provenance from
the loaded runtime: source paths, instruction digests, Skills, Extensions and
tools. These facts are captured at dispatch, not reconstructed from later file
contents. Inspection itself never starts a model request.

Recording starts off, covers future calls through AmpleFile's native Pi
transport, and keeps bounded snapshots in memory for up to 30 minutes. Images
appear as metadata. Text may contain private content; review it before sharing
a copied snapshot. **Clear all** discards captures while recording continues;
turning recording off clears them and stops capture. Independent transports
inside Extensions are outside this observer. See [the feedback contract](tool-feedback.md#inspect-model-context)
for capture stages, coverage and bounds.

## Source map

| Path | Responsibility |
|---|---|
| `web-local/src/` | React UI, client state, styles, and inert UI fixtures |
| `src/local/server.ts`, `src/local/api/` | The local API: its entry and the [route modules](#local-api-modules) it serves requests through |
| `src/local/server-dev.ts` | The browser development host's entry (`npm run local:api`, started by `local:dev`) |
| `src/local/agent/` | Pi integration, Chat turns, and agent services |
| `src/local/connected-folder*.ts` | Connected Folder registration, path policy, ignore rules, watching, and appearance |
| `src/local/automations/`, `src/local/requests/`, `src/local/jobs/` | Automations (including their folder target resolver), durable request records, and background jobs |
| `src/local/history*.ts`, `src/local/recently-deleted-store.ts`, `src/local/prepared-acts.ts` | History capture and review, Recently Deleted, and prepared acts ([act ledger](act-ledger.md)) |
| `src/local/overview.ts`, `src/local/amplefile-agent-*.ts` | The AmpleFile Agent's overview, attachments, and instructions |
| [Kernel](../src/local/amplefile-kernel.ts), [CLI](../src/local/cli/), [adapter](../src/local/amplefile-cli-adapter.ts) | Shared context, tasks, and control-plane contracts |
| `src/shared/` | Shared types and the product identity contract |
| `desktop/src/` | Electron windows, lifecycle, preloads, the built-in browser, and updater |
| `desktop/cli/`, `desktop/assets/` | The installed `amplefile` command's shims; icons and brand artwork |
| `resources/included-tools/`, `patches/included-tools/` | The four included tools and the reviewed patches to their dependencies ([Extensions and computer work](extension-foundation.md)) |
| `examples/packages/` | Example Pi packages, not installed by default |
| `tests/` | Application regression tests (`*.test.ts`; see [Verification](#verification)) |
| `scripts/` | Shared development, validation, and release commands |
| `site/` | The amplefile.com page and its build ([Website](website.md)) |
| `docs/`, `.agents/skills/` | Product contracts and task-specific contributor workflows |

### Local API modules

`src/local/server.ts` is the entry. `startLocalApi` builds one
`LocalApiState`, constructs the services that close over it, and listens;
`handleRequest` authorizes each request and tries the route groups in a fixed
order. A route group takes a `LocalApiRequest` (the state and the request),
answers and returns `true`, or returns `false` when the request is not one of
its routes. Every module under `src/local/api/` receives the state as an
argument; none imports from `server.ts`.

| Path under `src/local/api/` | Holds |
|---|---|
| `state.ts`, `http.ts` | `LocalApiState`, `LocalApiOptions`, and `LocalApiRequest`; request authorization, body reading, and JSON and error responses |
| `event-streams.ts`, `extension-ui.ts` | The event connection, control hints, Chat event logs, and file-change streams; an Extension's questions in a Chat |
| `reservations.ts` | Capability and Connected Folder mutation reservations, the settled-deletion check, and the History restore and safety wrappers |
| `conversation-clients.ts`, `turn-acceptance.ts`, `turn-run.ts`, `chat-routes.ts` | A Chat's Pi client, turn acceptance with steering and the queued message, running a turn to its settled record, and a Connected Folder's Chat routes |
| `request-routes.ts`, `request-records.ts`, `background-jobs.ts` | Request routes, the request-level stop, and settle evaluation; the collaboration verbs' ownership rules, views, and results; the host side of background jobs |
| `file-routes.ts`, `file-changes.ts`, `place-routes.ts` | A Connected Folder's file routes; deletes, moves, and added files with their recovery; Standard Folders, transfers, Compress, Recents, and Go to Folder |
| `history-routes.ts`, `recently-deleted-routes.ts` | History routes; Settings → Recently Deleted and its restores |
| `connected-folder-routes.ts` | Health, the bootstrap read, and creating, connecting, renaming, removing, and customizing Connected Folders |
| `ai-model-routes.ts`, `capability-routes.ts` | Settings → AI Models and Worker instructions; Skills & Extensions and the included tools |
| `amplefile-agent-routes.ts`, `overview-routes.ts` | The AmpleFile Agent's conversations and request view; the overview and its source readers |
| `automation-settings.ts`, `automation-receipts.ts`, `automation-hops.ts` | The Automations settings facade and Connected Folder routes; run-receipt projection; the hop ports |
| `act-lane.ts`, `act-support.ts`, `prepared-act-adapters.ts` | The act facade; what it shares with the routes; the prepared-act fence and adapters |

Add a route to the group that owns its area. Groups are tried in the order
`handleRequest` lists them, so a new group's routes must not match a request
an earlier group answers.

Use the [docs map](README.md) to find the document that owns an area. Files
in `docs/reference-skills/` are examples; app-generated AmpleFile Agent instructions are runtime resources. Neither is an
extra repository instruction source.

## Verification

- `npm run repo:check` runs without installed dependencies or network access.
  It includes new, non-ignored files, so it is useful before staging a change.
  It verifies shared files, paths, and heading anchors, not model obedience or
  personal settings.
- `npm run check` runs repository hygiene plus all three TypeScript checks:
  `local:check` (renderer), `desktop:check` (local API and Electron), and
  `harness:check` (evaluation and development driver scripts). Test files are
  not type-checked; `tsx` strips their types when they run.
- `npm test` runs the application suite. While editing, run a focused file with
  `npm test -- tests/documentation-contract.test.ts`, substituting the relevant
  test files. Use the full suite before handing off behavior changes.
  The runner can divide the discovered test files into four disjoint shards;
  run one with `npm test -- --shard=1/4` (through `4/4`). Every file belongs to exactly
  one shard; an unsharded `npm test` still runs everything.
- Tests never use your real Pi folder. The runner points `PI_CODING_AGENT_DIR`
  at a temporary folder for every test process, so no test reads your
  provider credentials or writes sessions, settings, or locks into `~/.pi`, and
  it fails the run and names the test file if anything still changes the real
  folder. Running a test file directly with `node --import tsx --test` skips
  that isolation; use `npm test -- <file>` instead.
- `npm run desktop:prepare` verifies desktop resources, compiled code, native
  preloads, and the built-in browser. After a compiled native change,
  `npm run desktop:browser:smoke` drives real browser pages served from a
  loopback server.

GitHub Actions is off in the source repository, so pushes, PRs, and release
tags run no remote checks. The checked-in CI and source-tag workflows are
dormant diagnostics. Use local verification, and do not turn Actions on unless
asked.

Public Mac releases use `npm run desktop:release:mac:check` on the final clean,
committed release SHA with Node 24, supported npm, and Google Chrome on an
Apple-silicon Mac. Chrome runs the real CSS tests. This performs a fresh
install, `check`, the complete unsharded `npm test`, and `desktop:prepare`,
then saves an ignored receipt at `out/release-checks/local-verification.json`.
It records the exact source SHA, tree, build-input fingerprint, runtime, and successful stages; starting or
failing a run invalidates the old receipt, and source changes during the run
fail verification. `npm run desktop:release:mac:check -- --status` checks that
receipt without running the stages. A receipt cannot carry across a merge or
other commit change, even when the tree matches. The full signed build must
start after that check succeeds; a fresh check reinstalls dependencies and
requires a subsequent fresh build. Publication verifies matching Node/npm and
dependency state, including hidden lockfile hashes. A shared per-worktree lock
serializes local checks, all macOS builds, and publication so installation or
preparation cannot race packaging. Test-filter environment flags cannot narrow
the release check. GitHub Actions status is not a publication dependency. See
the [release runbook](macos-release.md).

Async tests should wait on the owned completion signal and verify persistence
separately. Avoid arbitrary sleeps or assuming a journal write appears within
one event-loop turn. When using a fake clock, advance it as async continuations
settle so newly armed timers can run.

## Agent setup and shared Skills

Launch your coding agent from the repository root. Codex reads `AGENTS.md`;
Claude Code reads the root `CLAUDE.md`, whose `@AGENTS.md` import loads the same
contract. Other shell-capable agents can read `AGENTS.md` explicitly and use the
same npm commands. No project-specific plugin or private config is required.

Confirm the instruction sources in a new session. Ask Codex which instruction
files it loaded; in Claude Code, `/context` lists its memory files. Global and
machine-local settings can add instructions or override skill discovery, so
this repository can verify its shared files, not guarantee identical behavior
across personal harness configurations.

Shared workflows have one source at `.agents/skills/<name>/SKILL.md`. Each has
one tracked link at `.claude/skills/<name>` pointing to that directory. There is
no `.agent/` contract. Root `CLAUDE.md` stays an import shim; `.claude/rules/`,
`.claude/agents/`, launch settings, and `.codex/` are not additional shared policy.

To add a shared Skill, author it under `.agents/skills/`, then run from the root
(replace `my-skill` with its name):

```sh
ln -s ../../.agents/skills/my-skill .claude/skills/my-skill
```

Add `!/.claude/skills/my-skill` to the allowlist in `.gitignore`, run
`npm run repo:check`, and commit the source and link together. Edit the canonical
source when updating it. The optional `agents/openai.yaml` is discovery/UI
metadata, not a second workflow. Never copy the Skill into the Claude directory.
Git must preserve symlinks; a flattened link is diagnosed by `repo:check`.

Loading conventions verified against [Codex instructions](https://developers.openai.com/codex/guides/agents-md),
[Codex Skills](https://developers.openai.com/codex/skills),
[Claude memory](https://code.claude.com/docs/en/memory#agentsmd), and
[Claude Skills](https://code.claude.com/docs/en/skills#where-skills-live).
Repository behavior remains defined by `AGENTS.md`.


## Focused harness evaluation

Before proposing a new runtime layer, exercise ordinary content work with the
existing real-Pi driver in disposable Connected Folders. Keep app state, Pi resources and
reference fixtures separate as above; an isolated profile is not an OS sandbox.
The installed CLI addresses its running desktop host, so do not accidentally point
a development Worker at production CLI commands. Tests needing that lane
must supply a matching development broker/host. `amplefile:drive` alone does not
start the installed desktop's CLI broker.

Useful repeatable cases are narrow edits across prose and a guide with unrelated
bytes held out; CSV reconciliation with duplicates, refunds and separate currencies;
a small code repair against independent inputs; and a fresh-Chat comparison of a
saved file with current bytes. Seed known before/after files and keep expected outputs
outside model context. Check final claims as well as file bytes: a correct calculation
can still have an incorrect explanation. Record model, reasoning level, instructions,
resources and starting bytes, and change one factor at a time. Tool counts are
observations, not pass criteria. Keep live-provider results separate from deterministic
regressions and do not report one run as a measured success rate.

The deterministic harness coverage includes `local-history-review`,
`amplefile-history-review-adapters`, `conversation-context-office`, `chat-presentation`,
`history-comparison-ui`, `history-comparison-keyboard`, and `amplefile-turn-store`
test files. They cover scope, completeness, persistence and UI behavior without
requiring a paid model or production user data.

## Real-model harness acceptance

`npm run harness:autonomous -- --model openrouter/openai/gpt-6-luna --case
research --out out/autonomous-eval/research-luna` runs an outcome-based live
case in an isolated profile with an explicitly supplied `OPENROUTER_API_KEY`.
Cases are `research` (confirmed saved-edit loss with exact quotes), `reconcile`
(a policy question and a source correction), and `repair` (a validated patch
while preserving original and uncommitted files). Prompts specify deliverables
and constraints without naming tools or ordering execution. The driver answers
person-directed questions through the real CLI; parent questions remain the
parent's responsibility. Independent checks grade final bytes, source
preservation and request settlement; tool choices, compactions, recovery use,
cost and duration are observations. No tool count is required for a pass.

Each fresh output directory preserves the exact prompt, its digest, source
commit and diff digest, hidden fixture expectations, native journals, provider
usage and result. `--verify --out <saved-directory>` checks saved evidence
without another model call. Preserve failed runs and freeze prompts before
comparing models; repeated coached attempts do not establish an autonomous
success rate. The live cases are separate from deterministic regression tests.
Without compaction flags the autonomous driver uses native Pi settings (the
normal model window, 16,384 reserved tokens and 20,000 recent tokens in Pi
1.1.0). For a context-pressure variant, keep the same prompt and add `--compact-at
18000 --keep-recent 2000`; the host records those explicit compaction settings.
This is a stress configuration, not the production default.

For repeated first-attempt comparisons, commit the evaluator, then create an
immutable plan with `npm run harness:repeat -- --create-plan
out/frozen-eval/plan.json --repetitions 3`. It freezes the three cases, prompts,
answers, expected results, source-file hashes, evaluator files, dependency
lockfile, Node runtime and a copied model catalog. The 36 interleaved trials use
GLM 5.3 and GPT-6 Luna at high reasoning, both normal and stressed settings,
with three concurrent disposable hosts. Hosted model weights and provider
routing are outside this client-side freeze.

With `OPENROUTER_API_KEY` explicitly supplied, run `npm run harness:repeat --
--plan out/frozen-eval/plan.json --out out/frozen-eval/baseline`. Every phase
requires clean committed source and a fresh output directory, refuses changed
evaluation inputs, and preserves each attempt, including failures. Make product
fixes only between phases, commit them, then use the same plan and a new output
directory. `results.json` records every trial and aggregates each model/case/
context cell; no failed attempt is replaced by a retry. Source changes while a
phase is running invalidate it. Exact repeated reads with unchanged bracketed
fingerprints and repeated helper arguments are diagnostic proxies, not proof
that the work was unnecessary. A Done request with failing independent artifact
checks is flagged separately for review of its completion claims. Inspect
explanations as well as machine-graded bytes. Three repetitions per cell provide
an initial signal, not a precise production success-rate estimate.

The repair case's original small-value checker does not establish unrestricted
decimal exactness. The separate `scripts/harness-eval/precision-audit.ts` audit
applies every saved repair patch to a fresh copy and tests 40 independently
specified cases including large magnitudes and cancellation. Freeze that
checker before a comparison with `node --import tsx
scripts/harness-eval/precision-audit.ts --freeze
out/frozen-eval/precision-checker.json`, then run it with `--manifest
out/frozen-eval/precision-checker.json --results
out/frozen-eval/baseline/results.json` (and each later phase). It validates its
own hashes and writes `audited-results.json` beside the untouched original
grades. Report both grades, and apply the same audit to every cohort. It
makes no model calls and never edits a model's saved patch.

`npm run harness:check` checks the evaluation scripts without making model
requests; it is also part of `npm run check`.
Use `npm run harness:eval -- --verify --out <saved-directory> --helper-model
<the-original-helper-model>` to recheck saved evidence without model calls.
Verification resolves files from the host's working-copy identities and stops
the evaluation's own service if it is still running.

With `OPENROUTER_API_KEY` explicitly provided, run `npm run harness:eval --
--model openrouter/openai/gpt-6-luna --helper-model
openrouter/deepseek/deepseek-v4.1-flash --out out/harness-eval/luna`. This spends
real model credit. Use a fresh output directory for each run. It starts the
isolated development host, uses disposable Git folders, answers the model
question through the real CLI while the turn runs, and verifies structured
collaboration, narrow helpers, PTY input, service lifetime, working-copy
isolation/archive/recovery, and one answer continuation from native records.
It never reads personal provider credentials, installs an app, merges code, or
replays old jobs. Output includes provider usage, sessions, journals and an
independently checked summary. Host shutdown stops leftover processes.
