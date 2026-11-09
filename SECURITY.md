# Security

## Report a vulnerability privately

Please use a [GitHub private security advisory](https://github.com/Mat-Tom-Son/amplefile/security/advisories/new) to report a suspected vulnerability. Do not open a public issue for an unpatched security problem.

Include the affected version or commit, impact, reproduction steps or proof of concept, and any suggested mitigation you have. Remove real credentials, private documents, and unnecessary personal information from the report.

If a secret was exposed, revoke or rotate it with its provider first. Never paste API keys, tokens, certificate passwords, private keys, or signing material into an issue, discussion, screenshot, test fixture, or repository file.

## Supported versions

AmpleFile is an early-stage project. Security fixes target the current public release and the `main` branch. Upgrade to the newest release when a fix is published; older releases may not receive a backport.

## Security boundaries

AmpleFile is local first, but local does not mean that every action is sandboxed:

- A Connected Folder exposes an ordinary folder to the local application and Pi's filesystem tools.
- Selected chat attachments and later tool results may be sent to the configured model provider as part of an agent turn.
- Native direct OpenAI sign-in verifies ID-token RS256 signature against the pinned public JWKS, issuer, issued-client audience, nonce, lifetime and access-token hash when supplied. It retains the ID token and narrow identity inside the protected Pi credential. Refresh without a new ID token preserves verified identity; if optional identity validation fails after refresh-token rotation, the valid replacement auth credential is kept and unverified identity is cleared. Initial login stays strict. The reviewed Pi patch is hash-enforced during install and in built archives. The distinct Codex grant continues to use Pi's native access-token identity/account metadata.
- OpenAI account reads use only the published HTTPS OIDC user-info endpoint or, for a distinct Codex subscription grant, the fixed chatgpt.com Codex accounts/check and usage endpoints. They reject redirects, bound time/body size, allowlist display fields and recheck the current credential. Codex requests pin the selected workspace header and require the quota response's account id to match it; a default or unrelated workspace cannot substitute. Tokens, raw claims, unrelated account records and upstream error bodies never reach Settings. No reset-consumption or quota mutation is exposed. Account metadata has no CLI or model-tool read operation.
- Microsoft Foundry connections use Pi's native Responses, Chat Completions, and Anthropic adapters. Each connection owns its endpoint and encrypted API-key credential. Settings returns only non-secret connection metadata; saving does not call inference, and source-model headers are not copied into a different connection.
- Skills can influence model behavior and may include executable scripts.
- Extensions and Pi packages can execute code with the current user's permissions and can make network requests.
- Creating or registering a Connected Folder authorizes AmpleFile to load project configuration from its `.pi` and other Pi-supported project resource locations. Registration is authorization, not code review, signing, or malware detection.
- Everywhere capabilities are available across Connected Folders and should be reviewed even though they do not use registered Connected Folder authorization.

AmpleFile intentionally treats successful Connected Folder creation or registration as the project-runtime grant and removes the redundant trust prompt. Native Pi Extensions in that folder can execute with the current user's permissions during catalog loading, and later local, source-control, or synchronization changes to `.pi` do not trigger another prompt. Removing the Connected Folder revokes AmpleFile's exact-root override; it does not rewrite Pi's independent trust store for other Pi clients.

A nested Connected Folder is another explicit registration, with the same project
runtime authorization. Its nearest registered container is projected as
`parentConnectedFolderId` in the kernel and CLI inventory. Parent file operations refuse
delete, move, or rename across nested ownership. These app controls do not sandbox full-trust Pi tools. Local message
routes accept at most eight addressed Worker ids, resolve them against the
registry, and omit the sender and removed registrations. Those context hints
grant no new powers and do not change a retried message's acceptance identity.

### Worker tools and recovery

Progress recovery is a scoped historical read, not execution authority or proof
of a model's conclusion. Host-owned request membership controls access. Captured
file fingerprints expose staleness; untracked inputs, original truncation and
agent-authored findings retain their limits. Recovery never replays tools or
widens the full-trust Pi runtime's filesystem authority.

Worker read-only helpers enforce real-path confinement and a fixed reading
tool set; they do not inherit shell, editing, browser or Extension powers.
Ordinary Workers and terminal jobs retain full-trust Pi authority. Interactive
terminal processes are tracked and stopped by process-group identity. Managed
Git working copies disable checkout hooks and pin a commit before checkout;
registering one authorizes its project Pi resources through the normal path.
See [Worker tools](docs/worker-tools.md).

### Native Extension questions

The native Extension UI adapter scopes pending callbacks and
extension-managed editor text to a root and conversation, validates response
types and selection membership, bounds text and pending counts, and cancels
callbacks on Stop/session disposal. Standard
Pi text input has no secret classification, so Extension authors must use a
desktop setup path for credentials. This adapter is not a sandbox for native
Extensions and does not make their external effects reversible. See
[Extensions and computer work](docs/extension-foundation.md).

### Included native integrations

Computer control, Chrome, Web, Documents and MCP use ordinary Pi Extensions
and the same full-user authority as other native tools. The reviewed source,
package versions, licenses and before/after patch digests are pinned in
[the integration manifest](patches/included-tools/manifest.json). Preparation
refuses unknown or partially patched input. The computer helper is built from
reviewed source and included in the app's signing lane; normal installation
does not run upstream helper downloads. These checks establish provenance,
not a sandbox or proof that every external action is safe.

The built-in browser's pages run in Chromium's sandbox with context isolation,
no Node integration, no preload, and no webview tags, in their own persistent
session; they never receive the app's desktop bridge, and a page is never a
trusted renderer for the app's IPC checks. Non-web schemes are refused (mail
links go to the mail app). Camera, microphone, location, notifications, MIDI,
clipboard reading, window placement, and activity status are granted only after
the person allows them for that site, never by a Worker; USB, serial, HID, and
Bluetooth devices are refused. Workers drive pages with the Chrome DevTools
Protocol through Electron's in-process debugger, which needs no extension or
port and exposes nothing outside the app. A page signed in to an account acts
with that account's authority whether the person or a Worker uses it. A Worker
can attach explicitly named local files to a site's file input through that
debugger; the page receives those files, never a filesystem or desktop bridge.
The tools teach agents to treat site content as untrusted and to use only
task-authorized files and destinations. See
[the built-in browser](docs/built-in-browser.md).

Native resource enable/disable preserves Pi's filters and scopes, pins the
resource and settings identity, journals before effect, and refuses changes
while affected work is active. It is a lifecycle control, not a way to revoke
a hostile full-trust process. Included factories do not start connections,
watchers or setup work during catalog inspection. Native third-party code can
still execute its own factory during Pi loading.

Chrome's Store companion authenticates through an exact-origin native helper
and an app-owned selected-installation proof. Native Messaging authenticates
the extension ID, not the profile. The temporary HTTP lease stays in native
runtime and service-worker memory; the public ZIP contains no user secret.
HTTP polls/results require the selected origin, credential and connection ID,
with protocol/capabilities checked before command delivery. Disconnect and
profile changes refuse affected active work, then revoke stale queues/results
at the accepted safe point. Readiness requires authenticated transport evidence;
socket reachability and issuing a lease are insufficient. See
[Chrome distribution](docs/chrome-extension-distribution.md).
Computer setup names the actual helper identity for macOS permissions. Both
return requested observations through Pi; neither provides continuous screen
recording. External effects may survive Stop and are not made reversible by
receipts. Document scripts run full trust in a terminable worker, with bounded
helper outputs; independent child processes created by a script are outside
that worker's cancellation boundary. See the reviewed dependency mitigations
in [the integration notes](patches/included-tools/README.md).

MCP setup is a trusted local operation bound to an open setup session and an
exact registered connected-folder/runtime. Credential writes and OAuth token commits
recheck the selected configuration revision inside the same capability fence.
Closing setup cancels OAuth and probes; restart does not resume them. Saved
secrets are not returned in status, native config errors omit source snippets,
and the CLI cannot enter these secrets. Native HTTP
and stdio transports remain upstream-owned; only the configured Pi files are
loaded, automatic other-app imports are disabled, and native MCP currently has
no elicitation or sampling path. Desktop OAuth state is encrypted around Pi's
native file and refresh locks. Auth mutations drain old sessions first, and
closed runtime credential stores reject late refresh writes.
A Chat-owned question from a reused connection must not adopt a newer task's
identity.

### Model context inspection (development)

The model-context inspector is an opt-in, memory-only local developer
surface reached explicitly through `?dev-context`, with no Chat, AmpleFile Agent,
or Settings entry. Its routes require the existing renderer authentication; Chat filters
check exact scope and conversation identity. It has no CLI
operation. Capture excludes authentication options, headers and
environment, bounds snapshots and replaces image bytes with metadata, but
recorded message text can contain secrets. Clearing or disabling invalidates
late recorder callbacks. The observer preserves native Pi hooks and payloads,
does not consume model streams, and cannot gate model work. See
[the context inspection contract](docs/tool-feedback.md#inspect-model-context).

### Application state and Connected Folder removal

AmpleFile has its own application id, profile, updater cache, internal scheme, CLI, and `.amplefile/` metadata contract. Pi's personal resources and auth may be shared at the configured Pi root, but AmpleFile sessions use a separate `sessions/amplefile/` namespace.

Loaded Extensions can declare `surface.json` views. AmpleFile reads these only beside an Extension Pi loaded, rejects links and oversized or invalid manifests, and accepts only a fixed plain-data block vocabulary: no HTML, scripts, styles, event handlers, or React code. The window does not draw surfaces. This validation does not sandbox the owning Extension process or make that Extension safe.

The `local:api`, `local:dev`, and non-packaged Electron entrypoints use a separate platform application-data root by default so ordinary development cannot advance installed-product schemas, and the Mac smoke package keeps its own application-data directory. `AMPLEFILE_STATE_DIR` and `AMPLEFILE_DESKTOP_STATE_DIR` are explicit opt-in overrides; the child-only `AMPLEFILE_CLI_STATE_DIR` cannot opt a desktop process into that state.

Connected Folder removal itself is a durable two-phase operation. AmpleFile persists an intent before revoking trust or stopping clients; that intent keeps the Connected Folder hidden and untrusted until idempotent startup recovery finishes. Managed-folder deletion is authorized only for the exact canonical directory and filesystem identity captured by the intent. AmpleFile atomically moves that identity to a random transaction-bound sibling on the same managed filesystem, revalidates it there, durably records the claim, and recursively deletes only the claimed path. A swap, failed restore, replacement directory, junction, symlink, retargeted parent, or uncertain I/O state remains preserved and cleanup-pending; recovery retries a mismatched-claim restore and never redirects deletion to a new occupant of the registered path. Node does not expose handle-relative recursive deletion, so a malicious process already running as the same operating-system user could still attempt to discover and race the high-entropy claim path after verification; hostile same-user filesystem manipulation is outside this local boundary. Post-commit cleanup failure is reported as pending rather than as a false rollback.

Only install Skills, Extensions, and packages whose source you understand. Review capability provenance and supporting scripts before use, especially when a package can run shell commands or access sensitive folders.

A GUI launch (Dock, Finder, Spotlight, `open`) resolves the current user's login-shell environment once at startup so the agent's shell tools see the same `PATH` a terminal `pi` session would. The probe executes the user's own profile files under the user's own account — the same code a new terminal tab runs, so it introduces no new trust boundary — with stdin closed, a bounded output size, a ten-second timeout, and a process-group kill on timeout; a failing or hanging profile leaves the launch environment untouched. Imported values never override explicit `AMPLEFILE_*`, `PI_*`, or Electron runtime variables, `NODE_OPTIONS` and process-identity variables are never imported, and `AMPLEFILE_DISABLE_LOGIN_SHELL_ENV=1` disables the probe. Provider requests use the same guarded, proxy-aware HTTP dispatcher and idle timeouts as the Pi CLI.

## Local management surfaces

**Other AI agents (Settings → Command Line).** Adding the command to Terminal runs one administrator shell command, after the standard macOS password prompt, that writes the app's own `Contents/bin` path to `/etc/paths.d/<command>`; every value in it is shell-quoted, and the action is offered only by an installed app running from its own place. Adding the skill writes a `SKILL.md` into `~/.claude/skills/<command>/` or `~/.codex/skills/<command>/`, and Remove deletes only a skill whose front matter names this one. All of it happens only on the person's click. An agent using the command has the same act lane as the CLI, with the same receipts and limits; the skill tells it never to handle secrets.

Agent work is tracked in machine-local request records under the
application-data `requests/` directory: which turn asked, which Connected Folders and
turns it spans, its open questions, and the results handed back. Those records
never enter a Connected Folder's folder and are not captured by History. What crosses into a
Connected Folder Chat is only that Chat's assignment, an answer to a question it asked, a
payload someone deliberately released to it, and files copied through the
ordinary restore-pointed path — the request graph, other Connected Folders' results, and
the AmpleFile Agent's transcript stay above Connected Folders. A question stops its own task rather
than holding a resource: the turn ends, one accepted answer starts exactly one
continuation turn, and a second answer, a late answer, or an answer from a
Connected Folder that does not own the question is refused. Requests have no
lifetime or total-work quota; transport envelopes, concurrent execution, and
retained history are bounded, and every refusal names the limit it hit.

Background jobs run shell commands with the same local authority as a Worker's
`bash` tool, in their own process group with stdin closed, and outlive the turn
that started them only within the running app: Stop on their request, `jobs
stop`, and quitting AmpleFile end the whole process group, an abrupt exit kills
it, and a restart records any job left running as interrupted, never re-runs
it, and kills a leftover process only when its process id and start time both
match the record. Their combined output stays under the application-data
`jobs/` directory and reaches a Chat only through a turn's read or one
host follow-up carrying the end of it.

The packaged main renderer and AmpleFile Agent popover talk to a loopback-only local API with a per-launch desktop session token and an app-specific allowed origin. That boundary is for trusted packaged renderers; it is not a network API intended for other local applications. The sandboxed popover uses a dedicated narrow preload exposing only that API session, a write-only clipboard, dropped-file path resolution, opening a result file or AI Models settings, hide/show-main actions, and window material; it does not inherit the main renderer's folder, update, settings, or shell bridges. Development mode has different local-origin assumptions and must not be exposed beyond the loopback interface.

The installed `amplefile` command uses a separate protocol-v1 file broker under the platform application-data directory (`~/Library/Application Support/AmpleFile/cli`). Requests and responses are UUID-named, atomic, size- and age-bounded, path-confined, and rejected when they are symbolic links or unsafe file types. Electron's single-instance host serializes accepted requests and cleans stale files.

That broker is same-operating-system-user coordination, not authenticated interprocess communication. Another process running as the same user may be able to submit a request or read its result. Protocol v1 — the read lane — therefore exposes only compact Connected Folder names/paths, running-task metadata, and capability provenance/status. It does not return file contents, conversation text, API keys, provider credentials, or signing material, and it never mutates anything.

Mutations ride a separately versioned act lane over the same broker files. Act requests must carry the per-launch act token the interactive app mints into `cli/act-token.json` on startup and removes on quit; without the running app there is no token match, no act facade, and nothing mutates. The token binds requests to one app run on a single-account machine — it does not distinguish same-user callers, and same-user processes remain inside the trust boundary. Every act command names its Connected Folder explicitly (no working-directory resolution for writes), reuses the interactive app's registered Connected Folder trust grants, History checkpoints, capability-mutation locks, and active-turn conflict checks, and is executed at most once: a mandatory flushed `accepted` journal record is written to `cli/receipts/act.jsonl` (status, list, show, and overview reads use `cli/receipts/act-reads.jsonl`) before the mutation runs, a terminal outcome record follows it, and a duplicated request id — including one replayed after the broker's response file was cleaned up — is refused rather than re-executed. An unreadable journal refuses every act; an unreadable line refuses acts until the freshness window and clock-skew allowance have passed since the line written after it, when no request it could name can still be accepted. The broker additionally refuses requests older than its freshness window, the desktop host refuses an act that waited in its queue longer than that window, and the journals retain replay-relevant records for at least that window. Because act commands include starting agent turns, reading their results, searching content, and listing History records, act request and response files can briefly contain prompt, conversation, query, overview, and listing text; they remain bounded, local, and are deleted after completion, and the receipts journal itself stays metadata-only. The `agent` command group talks to the AmpleFile Agent — a machine-local conversation scope above all Connected Folders whose transcript lives under the app profile's `management/` root. Its Pi session is granted that app-owned folder, whose only project configuration is what AmpleFile itself materializes there (the AmpleFile Agent's `AGENTS.md` and `manage-connected-folders` Skill), plus the user's Everywhere capabilities. Those app-owned resources are mandatory: if they cannot be prepared as safe regular files and directories, the AmpleFile Agent scope remains unavailable instead of running uninstructed. It is a full-trust agent: like every AmpleFile Agent it keeps ordinary local file and shell tools that can reach anything this user can. The materialized instructions teach it to prefer the `amplefile` commands — journaled, connected-folder-explicit, restore-pointed — for cross–Connected Folder work, but that is guidance, not an enforced authority boundary. AmpleFile Agent file/folder/link attachments are bounded references, not copies: missing or unsupported sources are refused, a symlink cannot be attached as the reference root, and their contents remain untrusted data. Readable files may enter model context; folders, binaries, oversized files, and links remain path/link references until tools inspect them. Downstream mutation lineage is explicit rather than ambient: the agent passes the active AmpleFile Agent task id as `--parent-task`, the act host validates it before the journaled mutation, and unrelated same-user commands are not credited to the request. Request records are durable machine-local state; transcripts and act receipts are the durable content records. There are no Chat-scoped grants or per-grant revocation; the personal single-user boundary above applies. See [AmpleFile Agent and CLI](docs/amplefile-agent-and-cli.md).

**Receipts, not gates.** AmpleFile has one authority setting for acts: none. Every act-lane verb — including making bytes runnable, widening a standing power, and deleting — runs on its first call through the same prepare, pin, journal-first, fenced execution path the desktop uses, and returns a receipt. The security properties are the receipt and the pins, not a person's click: journal-before-effect, identity pins rechecked at effect time, at-most-once execution, failure without automatic retry, capability-mutation fences, and turn-conflict rejection all remain. A changed package identity or a moved target invalidates an act instead of executing something else. Receipts preserve the initiating surface.

Destruction is reversible. File deletion and Connected Folder removal refuse until affected work has settled, including waiting questions and stopped turns still draining; the desktop and CLI share that reservation. Managed parents also refuse deletion while nested Connected Folder registrations remain. Once idle, `files delete` keeps History coverage and moves every uncovered path into a machine-local trash under the application-data root with a manifest per item (source Connected Folder, original Connected Folder–relative path, kind, size, deleted-at, restore-by, and the receipt that produced it). `connected-folders delete` moves the managed folder and its History there and unregisters the Connected Folder; interrupted moves retain remaining state until it can be matched to one intact recovery entry. Removing an imported Skill moves its whole folder there with its scope. Items are restorable from Settings → Recently Deleted and from `amplefile recently-deleted list|restore`, and are removed only when their retention window ends (30 days by default). No verb empties the trash. `.amplefile/` and `.pi/` are never valid file endpoints.

The only human-only surface establishes secrets: entering a provider secret. It has no act verb, and no task needs it mid-flight. This boundary binds the product's lanes; the management agent remains full-trust and taught rather than tool-restricted, and same-user processes remain inside the local trust boundary, exactly as documented above.

Automations are the one thing above Connected Folders that runs unattended. An automation is a machine-local, closed, typed declaration — no code, no credentials, no expressions, and only the literal declared message plus a closed set of host-resolved placeholders — enabled by one receipted `automations enable` act that pins the exact declaration. The executor is app code on the shared scheduler discipline with its own bounded budget; every run and hop is journal-first receipted; a failed hop fails the run rather than being smoothed over; disable and Connected Folder removal stop the active run before the authority change reads as complete, and a suspended automation never retargets or resumes without a fresh enable. Unknown placeholders are refused at enable time; resolved text is bounded and recorded on the hop receipt, and an `agent` step reaches the AmpleFile Agent through the same acceptance path as any other message. Nothing automation-shaped is written into any Connected Folder's folder, and automation-caused settles never trigger other automations. The trusted renderer can also list the automations that name a Connected Folder and turn them on or off or run them through the session-authenticated local API (`/api/connected-folders/:id/automations`); those calls run the same facade methods and receipts as Settings, and refuse an automation that does not name that Connected Folder.

## Release integrity

AmpleFile is built and released only for Apple-silicon macOS.

Local Mac smoke candidates are ad hoc signed and are not public release artifacts. They use the distinct `AmpleFile Local Smoke` name, `com.amplefile.desktop.local-smoke` bundle id, build-channel marker and application-data directory, and never start the production updater. They must not be renamed or installed over `AmpleFile.app`; interactive release-workstation testing uses a Developer ID-signed candidate because a user-data override does not isolate macOS Keychain access control. Public Mac releases use the separate `Mat-Tom-Son/amplefile-mac-releases` feed and require an exact public source tag, Developer ID signing, hardened runtime, Apple notarization and stapling, Gatekeeper acceptance, matching DMG/ZIP update metadata, and remote size/SHA-256 verification.

### History recovery and folder triggers

History restore checks safety-capture coverage before overwrite/deletion, preserves historically excluded descendants, rejects nested registered Connected Folder ownership, and holds an ownership/work reservation through capture and restore. Per-file restored bytes use an atomic sibling rename. Relocation of a registered folder rebinds this product's machine-local History/ignore state with a resumable marker; conflicting destination state is refused. External processes can still change ordinary files outside the app's reservations, so History is not a transactional backup against arbitrary concurrent writers.

Provider changes respect the shared active-work fence.

Automation v3 folder triggers observe a reviewed, bounded metadata tree; links, reserved paths, and separately registered child Connected Folders cannot expand scope. They use the existing journal-before-hop and exact-grant execution path. Observers are invalidated on revocation, pause while automation work executes, and rebaseline on resume/restart; they never replay offline edits or turn generated output into recursive automation chains. A version-5 trigger that declares `"ifMissed": "run"` instead compares its first look after a gap with a saved, bounded, metadata-only snapshot and admits at most one coalesced run through the same dispatch and launch-boundary recheck; the post-run look is saved so a run's own edits never trigger it, and a snapshot an interrupted run may have touched is never compared.

### Control invalidation (development)

The local authenticated control-event stream carries only invalidation kinds,
with bounded connections and no event replay.

### Result file links

Child-file links derive from full History differences recorded in terminal turn
metadata, never filenames inferred from model prose. Projection rechecks current
Connected Folder registration, path visibility, reserved metadata, symlinks and nested
Connected Folder boundaries; opening performs the complete bounded file-read checks again.
These links do not widen the content-free CLI read lane.

The [collaboration contract](docs/collaboration-contract.md#completion-delivery-and-recovery)
tracks work across model turns: durable questions and answer delivery, bounded
continuations for each owner, and selected request results. The request graph
and original assignments remain machine-local. Only deliberately released
child reports enter a Connected Folder Chat. See the contract for stop, expiry and restart behavior.

The popover’s saved-chat list and explicitly selected summary use the authenticated renderer lane and read only management-scope transcripts. Inline Connected Folder previews reuse the existing bounded inert preview broker. Preparing a connected-folder/file chat draft is local UI state and does not execute work.

### History comparison and selected edit evidence

Authenticated `history read`/`history diff` and the corresponding local API routes
resolve an explicit registered Connected Folder, checkpoint and relative path before reading
saved content. They do not accept arbitrary object hashes or expose file bytes in
content-free protocol v1. They reject reserved paths, symlinks and nested registered
Connected Folder traversal, verify saved bytes, and disclose unavailable or incomplete
evidence. Reads create no capture or restoration. Large saved-text ranges stream-verify the complete checkpoint-owned object before releasing a bounded UTF-8 range. List and Search continuation cursors bind scope and source identities and expire on host restart; cursors grant no additional authority. Search streams ordinary files, honors ignore/internal/nested-connected-folder exclusions, and discloses unreadable or changed coverage. See [the History review contract](docs/amplefile-agent-and-cli.md#bounded-history-review-and-durable-turn-evidence).

Only selected built-in edit details may enter portable work-trail metadata, within
per-edit/per-turn bounds and after Connected Folder path checks at tool start and completion.
Unknown/overridden tools keep the generic fallback. This projection does not sandbox
native tools or extensions; Pi remains full trust. Office attachment extraction
bounds actual decompression and expanded output, and refuses incomplete packages
instead of silently sending partial text as complete context.
