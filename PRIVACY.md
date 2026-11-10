# Privacy

Last updated: November 8, 2026

AmpleFile is a local-first desktop application. It does not use an AmpleFile account or a hosted AmpleFile service. The application does not include first-party analytics, advertising, or usage telemetry.

This document describes the behavior of the open-source AmpleFile application. Model providers, GitHub, package hosts, cloud-sync software, and third-party Skills or Extensions have their own privacy terms.

Direct OpenAI sign-in retains the validated ID token and selected identity metadata
inside the Pi-managed protected credential, using the same encrypted desktop
storage as its access and refresh tokens. Only the email and display metadata
reach Settings → AI Models; raw tokens, subjects and claims do not. Opening a
direct OpenAI connection checks the published OIDC user-info endpoint. Its
subject-only response does not erase the saved identity. Older credentials
without identity require one explicit reconnect to capture it.

The distinct **OpenAI (Codex subscription)** connection can also read its
selected workspace and subscription usage directly from OpenAI's Codex account
endpoints on chatgpt.com. Those bounded, redirect-free reads carry the connection's
selected workspace id and reject quota data for another or unspecified workspace.
Only selected workspace/plan fields, quota windows, usage percentages, reset
times and available reset counts reach Settings. The details refresh every
minute while open and on focus. The UI never consumes an available reset.
Reads recheck that the connection has not changed before returning. Account and
quota details are not persisted separately, sent to a model, or included in
portable Chats or CLI snapshots. **Manage usage in
ChatGPT** opens the corresponding settings page; AmpleFile does not infer
subscription limits from local token totals.

Live Pi Extension questions and answers pass through the local
UI adapter without being written to a transcript or its event replay log.
Pending callbacks and bounded answer drafts stay in memory; the latter are
not saved to browser storage. Extensions remain full-trust and may themselves
record their inputs. Session restart cancels these live callbacks;
durable agent questions remain in the separately documented request store.

## What stays on this computer

By default, AmpleFile stores:

- Connected Folder files in the ordinary folders the user creates or registers.
- A hidden `.amplefile/` directory inside each Connected Folder. Its `connected-folder.json` file stores the portable Connected Folder identity, and its `conversations/` directory stores that Connected Folder's append-only Chat records, including title, archive, and snooze lifecycle events.
- The Connected Folder registry, History objects, ignore rules, application settings, per–Connected Folder model defaults and Connected Folder instructions, and machine-local Chat attention acknowledgements under the local AmpleFile application-data directory or browser-backed application storage.
- Pi settings, sessions, Pi's independent trust decisions, personal Skills, Extensions, and packages under the configured Pi agent directory, normally `~/.pi/agent`.
- The built-in browser's profile — cookies, sign-ins, site storage, cache, the pages the browser's tabs visited (`browser-history.json`), and what you allowed or blocked for each site (`browser-site-permissions.json`) — under the local AmpleFile application-data directory, apart from any other browser on the Mac and from every Connected Folder. Open browser tabs are not kept: quitting AmpleFile closes them. A site gets the camera, microphone, location, notifications, or similar access only after you allow it. Its cookies are encrypted with the operating system's keychain. Files it downloads go to the Downloads folder. Nothing is imported from Chrome or another browser ([built-in browser](docs/built-in-browser.md)).
- Provider credentials in an application-scoped file encrypted through Electron's operating-system-backed `safeStorage`. AmpleFile refuses credential operations when that encryption is unavailable. When encryption works but a credential file no longer decrypts, AmpleFile keeps it beside the original, still encrypted, as `*.unreadable-<time>` (renamed with a `.superseded` suffix once credentials are saved again) and never deletes it. Microsoft Foundry connections keep each format's API key, endpoint, deployment names, and optional Pi base-model selections in this same machine-local credential store. Settings reads back only the endpoint, names, and selections. Saving does not send an inference request or discover Azure resources.
- Short-lived CLI request, claim, and response files under the owning app's application-data directory: `~/Library/Application Support/AmpleFile/cli` for the installed Mac app, or the separately identified smoke app's own directory.
- The AmpleFile Agent's machine-local transcript under the application-data `management/` root. When a request includes attachments, its user message stores their typed absolute local paths or http(s) links. Request records — the turns and Connected Folders one ask spans, its questions and answers, and the results handed back — are durable machine-local app state under the application-data `requests/` directory, reconciled after a restart and never replayed, and kept for 30 days after the request settles; act lineage stays metadata in the receipt journal. Like the other records below, nothing in `requests/` is written into a Connected Folder's folder, captured by History, or synchronized by anything that synchronizes a Connected Folder.
- Unsent answers to agent questions in the current renderer's session storage. They survive refresh/reconnect, clear when accepted or when the session ends, and are not sent to the host or model until submitted.
- Act receipts; Recently Deleted items under the application-data `recently-deleted/` directory, each holding the moved bytes or a recovered copy plus a manifest (source Connected Folder id, original Connected Folder–relative path, kind, size, deleted-at, restore-by, and the receipt that produced it), kept for the retention window — 30 days by default, changed in Settings → Recently Deleted — and then removed; automation declarations with their exact-declaration enablement receipts, cadence anchors, and run receipts (including the summary each chat step's Worker reports); request records with their questions, answers, and results under the application-data `requests/` directory; background job records and each job's combined command output under the application-data `jobs/` directory, kept for 30 days after the job ends (only the part a Worker reads, or the end of it in one follow-up turn, enters a Chat); and per-surface overview last-seen markers — all under the AmpleFile application-data directory. Receipts record the initiating surface. None of these records is written into any Connected Folder's folder, captured by History, or synchronized by anything that synchronizes a Connected Folder.

Pi's personal resources and authentication may be read from the configured Pi agent directory, while AmpleFile keeps its Pi sessions in the separate `sessions/amplefile/` namespace.

The sidebar's **Standard Folders** (Desktop, Documents, Downloads, Pictures, the home folder, iCloud Drive, and any folder the person adds with the sidebar's **+**) are read only when the person opens one; macOS asks for access the first time. The list of added folders is kept on this computer only, in AmpleFile's state folder, and **Remove from Sidebar** takes a folder off the list without touching it. With AI connected, the suggested messages over the message box are written by the Connected Folder's configured model from the names of the items in the folder shown and the titles of its recent Chats; that text goes to the AI provider you connected, and no file contents are sent. AmpleFile writes nothing into them on its own — no `.amplefile/` record, History, or Chat — and changes them only when the person renames, makes a folder, moves an item to the system Trash, or puts the folder to work, which registers it like any other folder.

Registering an existing folder does not upload, move, duplicate, or rename the user's files. It does add the documented hidden `.amplefile/` identity and Chat storage. Removing a linked Connected Folder from AmpleFile leaves both the ordinary files and `.amplefile/` in place. Deleting an AmpleFile-managed Connected Folder unregisters it and moves its managed folder into Recently Deleted, where it stays restorable for the retention window. Uninstalling AmpleFile does not itself delete linked Connected Folders.

File and Chat deletion and Connected Folder removal refuse while affected request
work is unfinished, including waiting questions and stopped turns still
draining. Managed parent deletion requires removing nested registrations
first. Its machine-local History travels with the folder into Recently
Deleted; interrupted moves keep the remaining state until recovery can
identify one intact destination. This recovery remains local.

Nested Connected Folder relationships are derived from registered folder paths;
the kernel and CLI expose the nearest container as `parentConnectedFolderId` without
adding a portable nesting record. A parent Worker's model context includes
its directly nested Connected Folders' ids, names, and relative paths. When a
person addresses Workers with `@`, their registered ids and names enter only
that message's turn context; the text remains an ordinary Chat message.
The whole registry and other Connected Folders' transcripts do not enter a
Connected Folder turn. Activity marks use running Connected Folder and Chat ids from the
local host, with unseen-reply acknowledgements saved on this computer.

## Worker tools

Progress recovery retains bounded text from completed tools and selected
agent-authored findings in the Chat's existing machine-local Pi session. These
records can contain private task content and share that session's retention.
Only the current request's own observations are read back to its model; recovery
does not send another model request by itself. Selected ordinary files carry
SHA-256 fingerprints for freshness checks; image pixels are not duplicated.

Read-only helpers send their selected task and file content to the parent's
model provider, or an explicitly selected already-connected helper model.
Their usage and content-free activity are recorded under the parent turn.
Interactive terminal input goes to the local process; only output read by an
agent enters model context. Managed Git working copies remain on this computer
in an app-owned sibling directory; archiving retains their files and history.
See [Worker tools](docs/worker-tools.md).

## Optional local context diagnostics

The local `?dev-context` developer route includes optional **Record model
context** diagnostics, with no Chat, AmpleFile Agent, or Settings entry. Recording
starts off and retains future request snapshots only in app memory: at most
24 requests, 2 MiB per record, 16 MiB total and 30 minutes. Text fields and
snapshot depth/size have additional disclosed limits. Images are represented
by metadata and bounded digests, not retained image bytes. Loaded-source
provenance includes local source paths, instruction hashes, Skills, Extensions
and tool identities at dispatch. Disabling, clearing or quitting discards
the recordings. Opening the inspector does not invoke a model.

Captures may include private instructions, messages, file text, tool results
and tool definitions. Authentication headers, environment variables and
provider authentication options are never collected. Known credential-like
payload fields are omitted, but message text can itself contain secrets;
redaction is not comprehensive. Captures have no automatic export, log,
or portable-transcript path. Copying displayed JSON to the clipboard
is an explicit action. The inspector distinguishes assembled context from
observed provider payloads, which are not proof of network delivery; calls an
Extension makes through its own independent transport are outside coverage.

## Included native tools

Included tools are full-trust Pi Extensions. They observe during requested
work, not through continuous desktop recording. Selected screenshots, page
text and document renders can enter the selected model's context as ordinary
native tool results. Pi's machine-local sessions can retain those results;
the compact portable Chat trail and memory-only developer inspector are
separate projections. Created documents and chosen page renders remain normal
files where the script writes them until deliberately removed.

The built-in browser's pages are ordinary web traffic to the sites the person or
a Worker opens; an address-bar search goes to Google. A Worker can read and use
every browser tab, including pages signed in to the person's accounts, and what
it reads or captures from a page reaches the selected model as a tool result.
Workers and the AmpleFile Agent can attach local files to a site's file input;
the site may transmit them as soon as they are attached. The tools teach the
agent to use only the files and destination authorized by the task. Download
observation reports source URLs, filenames, progress, and completed local paths
to the model; the recent transfer records stay in memory for this app launch.

Web sends search terms to DuckDuckGo by default, or Brave when that connection
is selected by saved setup, and fetches explicitly requested URLs. The included
baseline does not import browser cookies, initialize media services or call a
second model. Computer control captures selected native
observations using macOS permissions granted to its helper.

An earlier AmpleFile could register a Native Messaging helper with Google
Chrome. At launch, the installed app removes the helper copy and connection
records from its own application-data directory, and removes Chrome's
registration file only when it names AmpleFile's host and points into that
directory; any other file is left as it is. It reads no Chrome profile. You can
remove the AmpleFile extension from Chrome; removing it deletes its local
connection storage.

Optional Brave credentials use the existing
machine-local Pi CredentialStore. Native MCP definitions use the configured Pi
agent directory's `mcp.json` and a registered Connected Folder's `.pi/mcp.json`; project
configuration can travel with its folder. Host-entered bearer and OAuth
credentials use encrypted desktop storage with identities bound to scope and
endpoint (native Pi profile files in browser/CLI development), and are not returned by setup status. Manually authored native
configuration may itself contain environment or header values: it remains
executable, full-trust configuration, not a secret-free portable data format.
Native MCP connects enabled configured servers in the background when a Chat
session starts; catalog reads do not connect. HTTP sends their protocol
messages and stdio launches the configured local command. Other applications'
MCP settings are not automatically imported. Native MCP currently has no elicitation or sampling path.

## When data leaves this computer

When the agent above your Connected Folders hands work to a Connected Folder, the assignment it
writes becomes an ordinary message in that Connected Folder's portable Chat and goes to
that Connected Folder's configured model provider with the rest of the turn. The same is
true of an answer to a question that Connected Folder asked, and of the message and files
handed over when one Connected Folder asks another for help — copied files land in the
destination Connected Folder with a restore point, exactly like adding a file yourself. A
result handed back — its summary, its structured details, and the list of files
it chose — is recorded machine-locally and reaches another Connected Folder's Chat only
when someone deliberately puts it there. Questions, answers, results, and the
request graph are not sent anywhere else by AmpleFile.

### Model providers

When a user sends an agent message, Pi sends the request to the provider and model selected in Settings → AI Models. The request can include the message, relevant conversation history and instructions, explicitly selected text attachments, and tool results produced during the turn. A Connected Folder's optional **Connected Folder instructions** stay in machine-local application state rather than the Connected Folder's folder, but they are appended to every subsequent model request for that Connected Folder and therefore sent to the selected provider. Management attachments are references: readable text files can be included directly within the shared context budget; folders, binaries, and oversized files are initially path-only; and attached links are listed as data. If the agent later inspects one with filesystem or network tools, information those tools return may become part of model context. If the agent uses filesystem or Extension tools, information those tools return may likewise become part of later model context.

When a Worker or the AmpleFile Agent makes a picture with [image generation](docs/image-generation.md), the picture's description goes to the connected image model's provider in the same way. A Worker's picture is kept in AmpleFile's machine-local app state (`generated-images/`) so its Chat can show it; the Chat log records only the picture's id, name, type, and size. It becomes a file in the Connected Folder only when the person adds it or asked for it there. The image model chosen in Settings → AI Models is a machine-local preference outside every Connected Folder.

AmpleFile does not proxy these requests through an AmpleFile account service. The selected provider receives and processes them under that provider's terms and settings. Do not send sensitive material to a provider unless its handling is acceptable for that material.

### Application updates

Installed Mac builds check the public `Mat-Tom-Son/amplefile` feed, the source repository's GitHub Releases, shortly after startup, every four hours while running, and when the platform update command is selected. Versions through 0.1.4 check the public `Mat-Tom-Son/amplefile-mac-releases` repository instead. A check sends a normal network request to GitHub, which can receive standard request metadata such as an IP address and user agent.

Update checks do not download an installer. When an update is available, the user chooses **Download update**; AmpleFile downloads it, performs its update-specific shutdown, and asks the updater to relaunch the app. If an already-downloaded update becomes ready outside that immediate action, AmpleFile can offer **Restart now** or **Later**; a ready update deferred with Later installs on explicit application quit. The ad hoc Mac structural package retains updater metadata for verification but is named `AmpleFile Local Smoke`, has a separate bundle identity and application-data directory, and never starts the updater or contacts the production feed.

### Packages and external capabilities

Installing or updating a Pi package can contact its npm, git, HTTPS, or other configured source. Package tools receive the normal network and repository metadata required for that operation.

Skills may include scripts, and Extensions or packages can make their own network requests or open external sites. Their data handling is determined by their code and the services they contact, not by this document. Review the source and documentation before installing an unfamiliar capability.

An Extension can contribute a local declarative surface through `surface.json`. AmpleFile reads that manifest only after Pi loads the Extension; the window does not draw it. Surface version 1 contains static text and data and has no direct account, network, or credential bridge. Do not put credentials or sensitive remote records in a surface manifest, especially when the Connected Folder is synchronized by another application.

## Local CLI and development harness

Settings → Command Line writes only on this computer, and only on a click: one line naming the app's command folder in `/etc/paths.d`, and a skill file in Claude Code's or Codex's skills folder. Nothing is sent anywhere. What another agent then does with the command, and what it sends to its own model provider, is up to that agent and its settings.

The packaged `amplefile` command writes an atomic request beneath the owning app's production or isolated development profile containing its arguments, the terminal's current working directory, a random request id, protocol version, and timestamp. The desktop host returns stdout, stderr, exit status, and a structured result. For read commands that result stays compact and content-free: local Connected Folder names and paths, running agent/compaction task metadata, and capability names, scope, source, and status — never file contents, conversation text, or credentials. A CLI-only environment value routes requests to that exact broker root but is not accepted as desktop-state authorization.

Act commands carry more. A `chat send` or `agent send` request includes the message text (a `--message-file` is embedded into the bounded request payload by the shim), `agent send --attach` places the typed path or link strings in argv, `search` places its query in argv, and `connected-folders worker instructions` places the bounded instruction text in argv. Content-bearing act responses — chat results, search matches, Connected Folder instructions, overview, and History listings — travel through the same bounded, short-lived request/response files and are deleted after the command. Those files do not contain referenced local file contents beyond what the command itself returns. `chat`/`agent` status, result, wait, and list responses include Chat titles, states, and message content. Sending a message routes that prompt and its turn through the configured model provider exactly like an interactive desktop Chat, so treat CLI prompts, attachments, and Connected Folder instructions with the same privacy care. The AmpleFile Agent's transcript is machine-local application state under the app profile (`management/.amplefile/conversations/`), not portable Connected Folder data; it never moves with any folder. Act commands work only while the AmpleFile app is running: the app mints a per-launch token into `cli/act-token.json` (removed on quit), and every act command appends metadata-only records to the local `cli/receipts/act.jsonl` journal (status, list, show, and overview reads to `cli/receipts/act-reads.jsonl`) — timestamps, command names, connected-folder/Chat/task ids (including an explicit AmpleFile Agent parent task id when present), outcomes, error codes, restore-point ids, the initiating surface, and receipt, Recently deleted item, and typed prior-state identifiers, never instruction text, message content, file contents, search queries, or credentials. Both journals are size-rotated and stay on this computer.

The shim removes its request and response after completion, and the broker cleans stale bounded files during initialization. All of these files remain local and are not sent to an AmpleFile service, but another process running as the same operating-system user may be able to read or submit them. See [AmpleFile Agent and CLI](docs/amplefile-agent-and-cli.md) and [Security](SECURITY.md).

`npm run amplefile:drive` is a developer test harness, not the installed management CLI. It sends the supplied prompt and any explicitly selected context through the configured model provider by the same Pi/local-API path as a desktop Chat. In-process runs use temporary AmpleFile application state unless `AMPLEFILE_STATE_DIR` is set; `--agent-dir` can isolate Pi state. Treat its prompts, reports, and provider traffic with the same privacy care as an interactive Chat.

## Connected Folder authorization and agent context

Creating or registering a Connected Folder authorizes AmpleFile to load project Skills, Extensions, packages, scripts, settings, and instructions from Pi-supported locations in that exact folder. This does not upload the whole folder and does not certify its code as safe. Removing the Connected Folder revokes AmpleFile's authorization; the folder and its portable `.amplefile/` data remain according to the linked-versus-managed removal rules above.

The folder's executable configuration can later change through local edits, source control, or a desktop synchronization tool without another registration prompt. Review native Pi Extensions and package changes with the same care as other current-user code. See [Skills & Extensions](docs/skills-and-extensions.md) for the complete distinction.

When the app is launched from the Dock, Finder, Spotlight, or `open` rather than a terminal, it runs the current user's login shell once at startup (`$SHELL -ilc`, so the same profile files a new terminal tab reads) to learn the environment those profiles define, and adopts it for the agent's shell tools: `PATH` entries for tools such as Homebrew or nvm, plus ordinary exported variables. The probe runs only on this computer, nothing it reads is sent anywhere by AmpleFile itself, and it is skipped entirely when `AMPLEFILE_DISABLE_LOGIN_SHELL_ENV=1` is set or the app was launched from a terminal. Pi's `httpProxy` setting and the `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables are honored for provider requests, exactly as in the Pi CLI; a proxy configured that way sees the provider traffic it relays.

A Connected Folder image attached to a Chat turn (PNG, JPEG, GIF, or WebP) is sent to the configured model provider as image content with that message, resized locally first when it exceeds Pi's inline image bounds. A pasted screenshot is first written into the Connected Folder's dated `Dropped/` folder, like a dropped file, and stays there as ordinary user content. A message sent while a turn is running is delivered to the model after its current step and recorded in the Chat transcript as sent mid-turn.

## Google Drive and other synchronized folders

AmpleFile does not currently connect to the Google Drive API or run its own cloud mirror. It can register an ordinary local folder managed by Google Drive for desktop or another sync application. That separate application may upload and synchronize the folder—including `.amplefile/connected-folder.json`, `.amplefile/conversations/`, and any `.pi/` project configuration—under its own settings and privacy terms. Do not place a Connected Folder in a synchronized folder unless synchronizing its Chat history and hidden metadata is acceptable.

## User choices

Users choose which folders become Connected Folders, which files are attached to Chats, which model provider receives Worker and AmpleFile Agent requests, and which Everywhere or This Connected Folder only capabilities are installed. Registering the folder is the local Pi authorization. Everything the AmpleFile Agent, a Worker, or the command line does runs at once and leaves a receipt; nothing waits for a further click. Deletions stay recoverable from Recently Deleted for the retention window. Enabling each automation and turning it off remain separately recorded effects. Revoking one authority does not imply revoking the others or invalidating a credential at its remote provider.

Because this project is early stage, not every data-management action has a dedicated UI yet. Application and Pi data remain ordinary local files, but manual changes should be made only while AmpleFile is closed and after creating a backup.

## Automations, results, and saved evidence

### Folder-change Automations

An explicitly enabled folder-change automation scans metadata only for its named folder and file types. It does not read file contents or attach files to Chat. Observer baselines are in memory; run receipts retain the source Connected Folder, snapshot digest, and change count. It pauses while automation work runs and restarts from a fresh baseline after work, wake, or launch, without replaying missed edits. An automation that opts into catching up (`"ifMissed": "run"`) also saves that metadata — relative paths with size, times, device, and inode, never contents — in machine-local app state under `automations/folder-snapshots/`, never in the Connected Folder, so that after AmpleFile was closed or asleep it can start one run for the files added or changed meanwhile; deleting the automation, removing its watched Connected Folder, or turning catch-up off removes the snapshot. Each Chat step still sends only its declared message with the host-resolved placeholders it names; a separate files step is the explicit cross–Connected Folder transfer.

### Result file links

Recent machine-local turn records may retain up to 64 changed/new relative file
paths, hashes and sizes with pre/post History checkpoint ids. This is metadata
about observed changes during a turn, not additional file content or a model
request.

### Requests and drafts

The [collaboration contract](docs/collaboration-contract.md#completion-delivery-and-recovery)
tracks work across model turns: durable questions and answer delivery, bounded
continuations for each owner, and selected request results. The request graph
and original assignments remain machine-local. Only deliberately released
child reports enter a Connected Folder Chat. See the contract for stop, expiry and restart behavior.

The AmpleFile Agent popover keeps per-chat text and attachment drafts in renderer memory while switching saved conversations.

### Saved-file comparisons and edit excerpts

History read/diff results may contain bounded complete UTF-8 text from the selected
saved/current file, explicit verified ranges of a large saved file, and a bounded difference. Search pages may contain matching snippets from ordinary files larger than 1 MiB; ignore rules and internal/nested-connected-folder exclusions still apply. Continuation cursors are transient, scope-bound positions (including bounded scan context), expire on host restart, and are not receipt content. They travel through authenticated local
API or act-lane responses; CLI receipt records never include those bytes. The
content-free read lane gains no file-reading operation.
Comparison itself contacts no model provider; a Worker that requests it can use the
returned text in its ordinary provider conversation.

Portable Connected Folder Chat logs may retain a successful native edit's selected diff,
relative path and first changed line, up to 16 KiB per edit and 64 KiB per turn.
These excerpts travel with the Connected Folder just like its existing Chat content. Excerpts
outside the Connected Folder, within nested Connected Folder identities or reserved metadata, and through
symlinks are excluded. Raw tool results are not copied. Optional assistant segment
metadata stores offsets/classifications, not a second copy of message text. Management
transcripts remain machine-local.

### Document and attachment artifacts

Document runs can retain selected render artifacts, complete overflow returns, logs,
and observation metadata in machine-local `document-artifacts/` (or the ordinary
artifact directory explicitly selected for the run). They remain until deliberately
removed so the Worker can retrieve evidence after a bounded response or failure.
Installed-engine conversions remove their private input copy and temporary Office
profile; the selected output and diagnostic log remain. These files are not uploaded
merely by creation. Only deliberately selected tool observations enter model context.

When a large attachment selection's path metadata cannot fit in model context,
the complete selection is retained as a private JSON manifest under machine-local
`attachment-artifacts/`. It contains names, paths, sizes and turn ownership, not
file contents. The model receives its path and can inspect selected files with
ordinary tools. These manifests remain until deliberately removed; standalone
runtimes without application/session storage use explicitly identified system
temporary storage instead. Creating a manifest does not upload the selected files.

## Changes and questions

Material privacy behavior changes should update this file in the same release. General questions can use [GitHub Issues](https://github.com/Mat-Tom-Son/amplefile/issues), but do not include private data or credentials. Report security concerns privately through [SECURITY.md](SECURITY.md).
