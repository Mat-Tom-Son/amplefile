# Background jobs

A Worker or the AmpleFile agent starts a shell command, keeps working or ends
its turn, and is woken with the result when the command exits. Exports,
conversions, installs, builds, test suites, and servers do not hold a turn
open, and a Chat does not go quiet while something long runs.

In the interface it is a **background job**; on the CLI it is `jobs`; the
tools are `job_start`, `job_output`, and `job_stop`. `src/local/jobs/`,
`src/local/agent/job-tools.ts`, the `jobs` act verbs, and their suites are the
implementation authority. Jobs are part of
[the collaboration contract](collaboration-contract.md).

Pi's `bash` tool takes `command` and `timeout` and blocks the turn until the
command exits, and codemode's script blocks the turn too. A job instead uses
the request's continuation path: the host already starts one deterministic
follow-up turn in an idle Chat when a request's delegated children settle,
records what it delivered so nothing is delivered twice, never replays after a
restart, and fences continuation behind Stop. A finished job takes that same
path.

## Rules

- **A background job belongs to the turn that started it.** A job is one shell
  command started by a running Worker or AmpleFile agent turn. It joins that
  turn's request: while it runs, the request reads `working`, so `chat wait`,
  the work line, the overview, Stop, and settled deletion treat it as
  outstanding work. A job record is journaled before the process starts,
  executes at most once, and is never re-run: a restart records a running job
  as `interrupted`. Pi's `bash` tool stays as it is and is the right tool for
  short commands.
- **A finished job wakes its Chat once.** A job's end is delivered exactly
  once: to a turn in its Chat that reads it, to the next turn that starts in
  that Chat, or else in one host follow-up turn joined to the job's request
  when the Chat is idle. The follow-up carries the exit status, how long it
  ran, its History coverage, and the end of its output. It follows Stop fences,
  the Limits switch that turns continuations off, and "restart never replays".
  Nothing busy-waits, holds a turn, or polls. Nothing wakes a Chat for a job
  that settled before a restart.
- **Job output stays machine-local.** Combined output is kept under the state
  root (`jobs/`), never in the Connected Folder, and is removed with the
  request retention window. Only what a turn reads or what the follow-up turn
  carries enters the Chat. `.amplefile/` and `.pi/` stay untouched; a job's own
  writes are ordinary file changes in whatever folder it writes to.

## Surface

One job service in the local API backs two surfaces with the same records,
refusals, and receipts.

### Tools in every Chat

Three Pi custom tools, registered beside `generate_image` in
`src/local/agent/pi-client.ts`, for Workers and the AmpleFile agent alike. The
tool knows its own turn, Connected Folder, and Chat, so it needs no ids or flags.

| Tool | Parameters | Returns |
|---|---|---|
| `job_start` | `command`; optional `name` (a short label the person sees), `cwd` (default: the Chat's folder), `timeout` (seconds; none by default), `wait` (seconds to wait before returning; default 3), `until` (a pattern; return as soon as the output matches it) | The job id, its state, and the output so far. A command that finishes inside `wait` returns exactly like `bash`, and its end counts as delivered. |
| `job_output` | optional `job` (omitted: list this Chat's jobs); `wait` (seconds to wait for the job to end); `until` (a pattern); `offset` and `limit` (lines, to page from the start); otherwise the end of the output | State, exit code, running time, total lines and bytes, `nextOffset` for incremental reads, and the requested text. |
| `job_stop` | `job` | The final state and the end of the output. |

`job_start` waits 3 seconds by default, so a typo or a missing program comes
back in the same call; `wait: 0` returns at once. `wait` and `until` let a turn
that has nothing else to do wait in place for a command that should finish
soon, or for a server's "ready" line, without another round trip. Stop
interrupts the wait. The output text uses Pi's own `bash` bounds: the last
2,000 lines or 50 KB per read, whichever is smaller, with ANSI escapes and
control characters removed.

### `amplefile jobs` on the CLI

The same operations as act-lane verbs, so codemode, a Worker's shell, and the
AmpleFile agent can drive Workers' jobs with receipts:

```
amplefile jobs start  --connected-folder <id> --task <own-task-id> (--command "<cmd>" | --command-file <path>) [--name "<label>"] [--cwd <path>] [--timeout <s>] --json
amplefile jobs list   --connected-folder <id> [--conversation <id>] [--running] --json
amplefile jobs show   --connected-folder <id> --job <id> --json
amplefile jobs output --connected-folder <id> --job <id> [--offset <line>] [--limit <lines>] [--wait <s>] [--until "<pattern>"] [--task <own-task-id>] --json
amplefile jobs stop   --connected-folder <id> --job <id> [--parent-task <id>] --json
```

- `start` and `stop` are receipted, journal-first act verbs and join the
  request's action trail as `jobs.start` and `jobs.stop`. `start` requires
  `--task` to be the caller's own running turn, as `chat report` does.
- `list`, `show`, and `output` are act reads. A job is readable only through
  its own Connected Folder. A read counts as delivery only when `--task` names
  the reader's running turn in the job's own Chat; `jobs stop` takes no
  `--task`, so a job stopped from the CLI still wakes its Chat once.
- The AmpleFile agent reaches its own jobs through the tools; `requests show`
  lists them. The AmpleFile agent can read and stop any Worker's job through
  `--connected-folder`.
- The tool path writes the same job journal and request action, so both
  surfaces leave the same record.

## Lifecycle

A job record carries its id (`job-<yyyymmddhhmmss>-<8 hex>`), Connected Folder
(absent for the AmpleFile agent), Chat, starting task, request, name, command,
folder, start and end times, process id, exit code or signal, output size,
History coverage, delivery, and state:

`accepted` → `running` → `exited` | `stopped` | `timed_out` | `failed` (could
not start) | `interrupted` (AmpleFile closed or restarted first).

- **Start.** The `accepted` record is written before the process is spawned;
  an unwritable journal refuses. The command runs through Pi's own shell
  configuration and environment with stdin closed, in its own process group,
  with `AMPLEFILE_JOB_ID` set. A kernel task record (`job`, experimental like
  `automation_run`, outside the stable `amplefile.tasks` v1 projection) lives
  while it runs.
- **Turn end.** The starting turn ends normally; the job keeps running. The
  turn's post-turn History checkpoint covers what the job wrote by then.
- **Shell exit.** Remaining processes in the job's process group receive
  SIGTERM, then SIGKILL after the same grace period Stop uses. The job stays
  live until that group has drained, before History capture and request
  settlement, so a shell's background child cannot keep writing after its job
  is reported finished.
- **Startup write failure.** Exit settlement waits for the running-record write
  to succeed or fail. A failure stops the process and settles it once as
  failed, with History coverage even when a fast command has already exited.
- **Stop.** Stopping a request (the Chat's Stop, the work line's Stop, or
  `agent stop`) stops every running job of that request and its descendants:
  SIGTERM to the process group, then SIGKILL after 5 seconds. `job_stop` and
  `jobs stop` stop one job the same way. Stopping a newer, unrelated request in
  the same Chat does not stop an older request's job.
- **Quit and restart.** Quitting AmpleFile stops every running job the same
  way and records it `interrupted`; closing the window and sleep do not. A
  synchronous exit handler kills the process groups if the app exits abruptly.
  On the next start, any job still `accepted` or `running` is recorded
  `interrupted`; if its process group leader is still alive with the recorded
  start time, it is killed. An interrupted job makes its request read `failed`,
  is never re-run, and never wakes its Chat.
- **Deletion and restore.** A running job keeps its request unfinished, so
  deleting its Chat, a file in its Connected Folder, or the Connected Folder
  refuses until the job ends or is stopped, as settled deletion does for
  turns, and a job a Stop is still ending keeps it unfinished until it has.
  Removing the Connected Folder's registration and restoring the whole
  Connected Folder from History refuse while a job runs in it; the restore
  refusal names the job. Installing, updating, or removing Skills & Extensions
  does not wait for jobs: a shell process loads no Pi resources, and a dev
  server would otherwise block installs for hours.

## Wake-up

When a job ends, the host records it, captures History, and then evaluates
delivery on the same settle chain as turn settles. The job's reference on its
request settles only after that decision, so a request whose follow-up is
reserved never reads `done` in between:

1. If a turn in the job's Chat has already read its end, nothing more happens.
2. If a turn is running in that Chat, it can read the job directly. When that
   turn ends, the job is still undelivered, and the Chat is idle, step 4
   applies.
3. When a new turn starts in that Chat (the person's message, an answer, a
   handoff), its hidden turn context lists the Chat's running jobs and every
   undelivered finished job with its exit status, and those are delivered.
4. Otherwise, once the Chat is idle and not compacting, the job's request is
   not stopped, and no question of that request is waiting for an answer, the
   host reserves one continuation (recording the job ids as delivered) and
   starts one `system`-actor turn joined to the job's request. Jobs that end
   together, and children that settled at the same time, share one follow-up.

The follow-up message is deterministic and needs no model call:

```text
amplefile is continuing request req-…: a background job this Chat started has finished. Nobody typed this message.

- Job job-… "Build the site" — exited with code 1 after 6 min 12 s
  command: npm run build
  History: saved checkpoint … after it finished (1,204 files; 2 skipped as too large)
  output: 18,233 lines (2.1 MB); the last 2,000 lines follow. Read more with job_output.

<last 2,000 lines or 50 KB of output, fenced>

Continue the work this job was part of, using job_output for more of its output. …
```

A request with a job that never exits (a dev server) stays `working` until the
job is stopped. Its parent still receives the Worker's report when the
Worker's turn ends, because settled child turns are delivered on their own,
but reads `handed_off` rather than `done` while the server runs.

## History

The turn's final checkpoint is taken before a background job finishes, so a
job's later writes would be uncovered. When a Connected Folder job ends, the
host attempts a full History capture of that Connected Folder (label
`After background job: <name>`) and records its real coverage on the job: the
checkpoint id, files kept, and files skipped by reason, or why no capture was
possible. Identical content reuses the existing checkpoint. The follow-up
message, `job_output`, and `jobs show` report that coverage as it is. Jobs of
the AmpleFile agent have no History of their own; their record says so, and
the AmpleFile agent's instructions say to take `history save` in a Connected
Folder it changed through a job.

## Storage and bounds

```
<state root>/jobs/jobs.jsonl          job records, compacted like requests.jsonl
<state root>/jobs/<job id>/output.log combined stdout and stderr
<state root>/jobs/<job id>/output.1.log the previous segment after rotation
```

Bounds are resource guards sized so ordinary work never meets them, shown in
Settings → Automations → Limits:

| Bound | Value | On hit |
|---|---|---|
| Running time | none by default; `timeout` sets one | `timed_out`, the process group is stopped |
| Output kept per job | 1 GiB (two 512 MiB segments; the oldest is dropped when a third begins) | the job keeps running; the record says how much early output was dropped |
| Text per read and in the follow-up | last 2,000 lines or 50 KB, Pi's `bash` bounds | the rest stays readable with `offset` and `limit` |
| Running jobs on this computer | 256 | `job_start` is refused and names the number |
| Command text | 1 MiB | refused before anything is recorded |
| Retention | the request retention window (30 days) after the job ends | the record and its output are removed |

A start reserves its running slot before its first asynchronous check, so
concurrent starts cannot exceed the bound. Refused or failed starts release
their slots, and a live process group holds its slot until it drains.

## Teaching

The Worker operations guide and the AmpleFile agent instructions carry one
rule, stated once: *use `job_start` for anything that may take more than a
couple of minutes, or whose partial output decides the next step; use `bash`
for everything else.* Around it they say: after starting a job, keep working
or finish the turn and say what is running — AmpleFile brings its result back
to this Chat once; never poll in a loop or sleep; use `wait`/`until` only when
there is nothing else to do and the result is close; read a job a turn context
lists when it bears on the request; stop servers you started when the work is
done.

## Visibility

- The work line shows **Running in the background** with the job's name and
  running time while the request's only outstanding work is jobs, and keeps
  Stop available.
- A job tool call renders in the Chat's work trail like any other tool.
- Settings → Automations → Limits lists the job bounds, and its one switch
  ("Continue requests when handed-out work or background jobs finish") also
  turns job follow-ups off; a finished job then reaches the next turn's
  context instead.
- `requests show` and the request record list their jobs; `jobs list` lists a
  Connected Folder's.
- A running job's announced local address, such as a dev server's
  `http://localhost:5173/`, is reported by `job_start`, `job_output`, and
  `jobs show` as `serving` while it runs; see [Built-in browser](built-in-browser.md).

The same job service runs interactive terminals (`interactive`, `job_input`)
and services (`service`); see [Worker tools](worker-tools.md). Expect allocates
the terminal and relays bytes with Tcl's binary translation mode, compatible
with Tcl 8 and 9. UTF-8 decoding belongs to the job output reader; the relay
does not transcode input or output.

Jobs send no notification when they end and have no panel of their own. The
CLI does not reach the AmpleFile agent's own jobs; it uses the tools.

## Verification

`tests/background-job-service.test.ts` covers the service on real processes:
start, exit, History and settle ports, `until`, process-group stop, timeout,
paging, line-boundary segment rotation, the running bound, refusals, quit,
restart reconciliation with provable-identity reaping, single delivery, and
retention. `tests/background-jobs-journey.test.ts` drives real turns on a
scripted provider: the one follow-up with exit, History, and output; delivery
by a read and by the next turn's context; request Stop with deletion waiting;
the restore fence; quit and restart without a wake-up; and the AmpleFile
agent's own jobs and scope. `tests/amplefile-cli-jobs-verbs.test.ts` runs the
`jobs` family through the real executor and facade inside a held turn.
Terminal tests cover Unicode input, output split across byte boundaries, and
draining the terminal's process group on Stop.
