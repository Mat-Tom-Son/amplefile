# Product model and roadmap

This document is the durable product brief for AmpleFile. It keeps design,
implementation, and release decisions aligned as the app grows.

## Product promise

AmpleFile makes an ordinary folder understandable as a place for getting
something done, then gives that place a capable Worker.

Many people already have the right raw material (folders, files,
cloud-synchronized directories, and repeatable ways of working) but do not
think of a folder as an environment they can return to. A **Connected
Folder** closes that gap. It adds a human mental model and a Worker without
turning the folder into a proprietary format.

AmpleFile is for general computer work. Coding is one valid use, not the
organizing metaphor.

## The nouns

| Concept | User promise | Boundary |
|---|---|---|
| **AmpleFile** | The Mac app that brings folders, conversations, materials, and Workers together. | It is not the name of each folder-backed activity. |
| **Connected Folder** | One understandable place for an activity, backed by an ordinary folder. | Connecting a folder does not move or convert it. |
| **Files** | The ordinary folder contents shown for a Connected Folder. | Files are not a separate container or proprietary format. |
| **Chats** | Conversations grounded in one Connected Folder. | A Chat does not automatically receive every file in the Connected Folder. |
| **History** | Restore points and recoverable changes for a Connected Folder. | It is distinct from Chat history. |
| **Worker** | The Pi-powered helper in a Connected Folder. | Provider connections are configured in Settings and stay machine-local; model choices are saved separately for each Connected Folder and for the AmpleFile Agent, apart from Connected Folder content. |
| **Skills & Extensions** | One dialog, opened from the Action menu, to discover and manage what the Workers and the AmpleFile Agent can do. | It groups Skills and Extensions and is pinned to the Connected Folder it was opened from. |
| **Skill** | A reusable way of working that helps the agent approach a task. | A Skill may contain executable scripts and is not merely a document. |
| **Extension** | An executable capability or connection available to the agent. | It has a stronger trust implication than an ordinary file. |
| **AmpleFile Agent** | The agent above all Connected Folders: one conversation scope, shown in the menu-bar popover. | It is not a Connected Folder or a second Worker ([what it is](amplefile-agent-and-cli.md#what-the-amplefile-agent-is)). |
| **Automation** | A declared, inert-until-enabled set of deterministic steps that move work between Connected Folders on a reviewed trigger. | App code runs it, never a Worker conversation, and nothing Automation-shaped is written into any Connected Folder. |
| **Recently Deleted** | The machine-local holding place for anything AmpleFile removed that History could not restore (files, folders, a managed Connected Folder's folder, a deleted Chat, and a removed imported Skill), kept for a retention window and restorable from Settings or the CLI. | It is not a Connected Folder, not portable, not a backup, and never empties on a verb; only retention purges it. |

## The file manager window

AmpleFile's window is a smart file manager that looks native to macOS and
Finder. It uses the same local API, file events, and desktop bridge as every
other surface.

- **Window:** a sidebar, a toolbar (Back and Forward, the folder's name,
  Icons or List, **Organize** at a Connected Folder's top level, the panel
  button, Search), the folder's contents, and Finder's path bar (the disk down
  to the selected item) with an item count. Organize opens a Chat in the
  panel asking the Worker to organize the folder. The toolbar's **Action**
  button (⋯) and right-clicking a Connected Folder in the sidebar offer
  **Customize Connected Folder**, **Set Up for Me**, **Just the Look**,
  **Skills & Extensions…**, **Disconnect…** (or **Delete Connected Folder…**
  for a managed one), and **Settings…**. Dragging the edge beside the
  sidebar or the panel resizes it (double-click resets it; the widths are
  kept); a narrower window takes room from the panel first, so the folder
  list keeps 360px.
- **Sidebar:** flush with the window's edges and square like the rest of the
  window. **Recents** sits at the top: files changed in the last 30 days
  across the Connected Folders and the top of Desktop, Documents, and
  Downloads, newest first, with where each lives; Return opens one and ⌘↑
  shows it in its folder. Then **Standard Folders** (Desktop, Documents,
  Downloads, Pictures, the home folder by the account's name, and iCloud
  Drive), then **Connected Folders**, each drawn as a folder in its own color
  with its chosen icon. A Standard Folder that is a Connected Folder appears
  only under Connected Folders. Each heading has a **+** at its far right:
  beside Standard Folders it adds any folder through the folder picker (kept
  on this computer only); beside Connected Folders it offers **New Connected
  Folder…** and **Connect Folder…**. Right-clicking a Standard Folder offers
  Show in Finder, **Connect This Folder**, and, for one added with +, Remove
  from Sidebar. A Connected Folder's dot pulses while its Worker runs and
  turns green when a Chat has a reply nobody has read; the same dots mark
  History's Chat rows and the History tab.
- **Nested Connected Folders:** a Connected Folder registered inside another
  sits under it, indented, behind a caret in the left gutter. The caret (or
  the arrow keys) shows and hides the Connected Folders inside, the sidebar
  remembers which are open, a closed parent shows its nested Connected
  Folders' activity on its own dot, and going into a nested Connected Folder
  opens its parents. A folder inside a Connected Folder made with **New
  Connected Folder** can become a nested Connected Folder too, although
  managed Connected Folders live in the app's data folder; the rest of that
  folder, and hidden folders such as `.amplefile/`, stay off limits.
- **Standard Folders** are ordinary folders, not Connected Folders: no
  Worker, History, or `.amplefile/` record. The host resolves each from the
  home folder and lists it only when it exists; macOS asks for access the
  first time one is opened. Opening, Quick Look, dragging out, Rename, and
  New Folder work as in a Connected Folder; deleting is the system's **Move
  to Trash**. Anything a registered Connected Folder owns (a Connected Folder
  inside, or a folder holding one) is changed only from that Connected
  Folder, so History keeps it. The panel's **Connect This Folder** registers
  the folder; nothing moves.
- **Contents:** list and icon views, sortable columns (Name, Date Modified,
  Size, Kind), Finder keys (arrows, Shift and Command selection, Space for
  Quick Look, Command-Down to open, Command-Up for the enclosing folder,
  Command-Delete, Return to rename, typing to jump to a name). Double-click
  opens a folder here and a file in its default app. Files drag out to other
  apps; files dragged in from Finder are added to the folder shown, or to the
  folder row they are dropped on, and a file dragged onto a folder row in the
  list moves there, each kept by History (a Standard Folder is changed in
  Finder). Right-click uses the native menu.
- **Finder's file actions:** ⌘C copies the selection, also onto the system
  pasteboard so Finder can paste it; ⌘V pastes what was copied here or in
  Finder (the desktop process reads the pasteboard and pastes; the window
  never reads the clipboard); ⌥⌘V moves what was copied here; ⌘D duplicates;
  the right-click menu adds Copy, Duplicate, Compress, New Folder with
  Selection, and Paste Here. Nothing is replaced: a taken name gets " copy".
  Files dropped on a sidebar place go to its top. Every change keeps a
  History restore point in each Connected Folder it touches (a Standard
  Folder has none), and ⌘Z and ⇧⌘Z undo and redo the last file change. A
  move between Connected Folders copies the items, then deletes each from
  its source with that delete's receipt, and keeps a restore point on both
  sides. It refuses, before copying anything, while the source Connected
  Folder has unfinished work (a running turn or a question waiting on an
  answer), and for an item that is, holds, or sits inside a nested
  Connected Folder. A copy leaves a folder's `.amplefile/` behind; a move
  carries it, so a disconnected Connected Folder keeps its identity and
  Chats. An item whose copy did not carry everything History could not
  keep leaves its source through Recently Deleted rather than being erased,
  and an item that cannot leave its source stays there and the move says
  so; its copy then drops the `.amplefile/` the source still holds, and the
  move names any it could not drop. Any other move across places copies and says the original stays.
  Compress writes the archive beside the items under a hidden working name
  and refuses more than 2 GB of files or 60,000 items, pointing to Finder.
- **Path bar and Go to Folder:** clicking an item in the path bar copies its
  path; double-clicking a folder opens it; a long path keeps the disk and its
  last four items whole with "…" between. The button at the bar's start, or
  ⇧⌘G, opens Go to Folder as Finder has it: a path field (a full path, "~/…",
  or a name inside the folder shown) over the names that complete it; Tab
  completes, the arrow keys choose, Return goes, and a file's path opens its
  folder with the file selected. It opens any folder inside a Connected
  Folder or a Standard Folder and says so plainly for anything else.
- **Search** reads names and contents. A scope bar offers **All Connected
  Folders** or the folder shown; results list name matches, then text matches
  with the words around them, in Name, Match, and Connected Folder columns. A
  Standard Folder searches its names only. Selection is accent-colored while
  the contents have focus. The last row of results asks the Worker to find it
  by what the person remembers; Return with nothing chosen does the same.
- **Right panel:** **Info** shows the selection (a picture shows itself;
  files show Where, Modified, and Size) or, at a Connected Folder's top
  level, its Automations with their on/off switches, followed by the
  ready-made ones it has not turned on ([Automations](automations.md)).
  **History** lists the Connected Folder's changes, then its Chats, newest
  first, each row carrying its own day and time; each section shows its five
  newest until **Show More**. A Chat row opens that Chat in the panel. A
  change offers **Undo** (a "Before …" restore point) or **Restore**; with one
  file selected, History lists that file's versions, marks the **Current**
  one, and offers **Restore** on the others. Each runs at once and leaves its
  own restore point, which the notice's **Undo** goes back to. A deleted file
  comes back this way.
- **Message box:** at the foot of the panel on both Info and History, reading
  "Work in <folder>", "Work on this file", or "Work on these N items". The
  selection goes to the Worker as path references it reads with its own
  tools (a folder too), shown as a removable chip; with nothing selected in a
  subfolder, that folder is the reference. Sending opens the Chat in the
  panel with a back button and a **Reply** field. A small row under either
  field shows the Worker's model (and, in a Chat, its context circle), or
  **Set Up AI** when no AI is connected. It is AmpleFile's ordinary Chat, so
  Stop, questions, and the Worker's steps work the same way, and a Chat left
  running keeps going while Info is shown. There are no automatic AI file
  summaries.
- **Suggested messages:** push buttons above the message box, on Info only,
  that send at once: up to four, or two when the folder already has an
  Automation on. With AI connected, they are written by the Connected
  Folder's own model from the names in the folder shown and its recent Chat
  titles, kept for 30 minutes or until those change; plain ones cover a
  selection and the wait.
- **What the Worker changed:** after a Worker reply or an Automation run, the
  files it added, moved, or changed carry a small dot in the list, and Info
  opens with a receipt ("The Worker changed 14 items · 3 added · 9 moved · 2
  changed") listing the first few, with **Undo** (History's restore) and
  **Done**.
- **A message needs AI:** with no AI connected, sending from the message box,
  a suggestion, Organize, or Set Up for Me opens Set Up AI first and then
  sends.
- **Notices:** one card for everything the window says, errors included: an
  icon for its kind, the words, one action, and Close, stacked over the
  folder list. Errors stay longer and carry a red edge.
- **Disconnecting a Connected Folder:** the Action menu or the sidebar's
  right-click menu offers Disconnect…; a linked folder and its files stay
  where they are, a managed one moves to Recently Deleted, and the host still
  refuses while its work needs it.
- **Settings and dialogs:** Settings (⌘, or the Action menu), Skills &
  Extensions, Connect AI, and the other dialogs open over the file manager in
  its own look. The Settings window is a sidebar of pages beside grouped
  white cards on gray: line icons, a gray pill for the page shown, the page's
  name as its toolbar, groups as headings over white cards, and choices as
  the file manager's pop-up buttons, fields, switches, and segmented
  controls; Skills & Extensions follows the same look. Settings →
  Appearance restyles the file manager (see
  [Application appearance](application-appearance.md)), and Settings'
  buttons open their targets in the file manager: a result file is shown
  selected where it lives. Shortcut Keys lists the file manager's keys.
- **Customize Connected Folder** has Name, Icon, and Color. A chosen icon is
  stamped on the Connected Folder's folder as macOS draws a symbol on a
  folder ([Connected Folder customization](connected-folder-customization.md)).

### First run

With no Connected Folder yet, the window opens on a short first run: a
welcome that says what AmpleFile is, **Connect Your AI**, **Let Your Worker
Use Your Mac** when the app includes Computer Control or the command line
and something is not yet set up (Chrome is set up only in Skills &
Extensions), and **Pick a Folder to Start
With**, which offers Desktop, Documents, Downloads, and Pictures in one
click beside Connect Folder and New Connected Folder.

Connect Your AI offers ChatGPT, Claude, and OpenRouter first, signing in
where the app can run the provider's sign-in and taking a key otherwise,
plus **Another provider**, a search over the rest of Pi's catalog (Azure and
providers that need more than a key go to AI Models). The step is skipped
when a provider is already connected and can be skipped by the person; a
Connected Folder is still a useful folder without AI. The same picker opens
as a dialog from **Set Up AI** under the message box and before Set Up for
Me, which then carries on once a provider is connected; it also leads AI
Models while nothing is connected. Connecting a provider when no usable
default model is saved saves a recommended one for that provider as Pi's
default (OpenAI and ChatGPT: GPT-6.1 Sol; Claude: Claude Opus 4.8;
OpenRouter: GPT-6 Luna; Google: Gemini 3.1 Pro; otherwise the provider's
first model), so every Worker without its own choice and the status agree on
the model in use. ChatGPT sign-in defaults to the direct OpenAI connection.
The included tools' setup works with or without a Connected Folder.

### Set Up for Me and Just the Look

Both start a new Chat in the panel with one message, and the included
`set-up-connected-folder` Skill does the rest. **Set Up for Me** looks the
folder over, organizes it when that helps (moves and renames only, never
deletes, each through a restore-pointed `amplefile files` verb that refuses
to overwrite; a deliberate structure stays; projects, app-managed folders,
and hidden files are left as they are), writes the Connected Folder's Worker
instructions, and sets an icon and a color. **Just the Look** reads the
folder and sets only the look; it never touches a file. The Chat's own reply
says what changed and how to undo it. The Skill is listed under
**Everywhere** as Included with AmpleFile; it can be turned off but not
removed, and a request such as "set up this folder" in any Chat uses it too.

## Chats

Every Chat belongs to one Connected Folder. A working Chat stays alive when
another Chat or folder is shown, when AmpleFile is minimized, and when the
last window closes and is recreated from the Dock. Every accepted Worker turn
has one stable request id through the transcript, kernel task, and bounded
machine-local turn journal. Retrying an uncertain delivery returns that
original acceptance rather than running the Worker twice. The live event
stream carries resumable cursors and an authoritative running and text
snapshot, so sleep, renderer reload, and short local-service disconnects
reconcile without losing or duplicating the visible response. When a settled
turn's transcript read fails, the Chat keeps its reply and steps while
retrying transient failures and shows the Worker as idle; only a successful
read for the same conversation and turn replaces the preview.

A Chat is **Active**, **Snoozed** (deferred until a future local time, when it
returns to Active), or **Archived** (kept as reference). Snoozing or archiving
never deletes or rewrites the transcript; the state is an append-only
lifecycle event in the Chat's portable `.amplefile/conversations/` log. A
snoozed or archived Chat can be opened for reading and shows **Resume Now**
or **Restore**; it must be resumed before another message can be sent.
Lifecycle changes are unavailable while its turn or compaction is active. A
deleted Chat's transcript moves to Recently Deleted and can be restored from
there; the delete refuses while the Chat has a running turn or unfinished
request work. A copy of a Chat starts a new Chat in the same Connected Folder
with that Chat's history as of its last finished reply; the original is never
changed. Snooze, archive, resume, rename, copy, and delete are act verbs
([the act ledger](act-ledger.md#chats)).

A new Chat begins as **New Chat**, with up to three of the Connected Folder's
most recent active Chats listed below as **Recent Chats**. After its first
successful turn, AmpleFile asks that Chat's active Pi model for a short title
based on the first request and reply, then saves it so it stays stable across
restarts and machines. The title request uses the same authenticated Pi model
transport as the turn, including live provider catalogs and stored Azure
endpoint, key, and deployment settings. For reasoning models it prefers the
lowest ordinary reasoning level Pi exposes, avoiding `minimal` when another
level is available because some providers reject it. If that one bounded
request fails, the Chat stays **New Chat** rather than presenting its first
message as a generated title; naming never fails an otherwise successful
turn, and a failed attempt is not repeated. A saved title stays
authoritative, and a person-authored rename always wins, including an
intentional rename to **New Chat**. Title and lifecycle summaries may be
cached in machine-local application state; those caches are disposable and
versioned apart from the portable append-only transcript.

The composer's model label names the provider and model, never the product,
and the reasoning level shares that chip and its menu (for example "GPT-6.1
Sol High"). The menu pins the Connected Folder's saved model first and adds
search when more than eight connected models are available. A selection
saves the Connected Folder's default for new Chats; existing Chat sessions
keep their model. Its **Model Settings** link opens **Settings → AI Models**
scoped to that Connected Folder. The Reasoning row lists only the levels the
model supports, filled before the first send from Pi's saved default; once
the Chat exists it reads **Reasoning for This Chat**, and its live Pi session
is authoritative. `/thinking` does the same from the composer.

The context circle updates during a turn as text and tool results arrive,
using Pi's context estimate and its estimator for a response still
streaming; finalized provider usage replaces that estimate. It opens a
**Context** popover with the share used, tokens of the window, tokens
processed in the Chat, and **Compact Chat**, which takes the same route as
`/compact` and waits for the turn to end. After a successful manual,
automatic, or background compaction, a quiet saved notice says that earlier
messages were summarized and the Chat history is still available. Cancelled
or failed compactions never claim success. An unknown count is never shown
as zero.

The Worker's steps show in the order they happened while a turn runs, with
the active one shimmering and live reasoning in a short panel; once the reply
starts, they fold into one plain line such as "Read a file, edited a file,
ran commands" that opens on click, and a "Thought" row opens its reasoning.
Reasoning a model keeps hidden still shows as "Thought for 3s". Successful
and interrupted Worker messages save their bounded tool trail with terminal
states, so a relaunch restores it without a ghost spinner or replay. A saved
reply keeps every text segment the turn produced, joined as paragraphs in the
order it streamed. A finished reply ends with the files its write and edit
tools changed, each labelled **Saved** or **Edited** with its folder and
opening on click; files that no longer exist are left out, and past five,
**Show all** reveals the rest. A Markdown hard line break in a reply is one
line break.

Provider failures use Pi's bounded retry path, keeping completed tool
results; exhausted retries, setup failures, stops, terminal failures, and
recovery append typed, user-safe results. Startup never reruns a Worker turn
that reached the runtime. The portable transcript is the content authority,
and the local journal supplies acceptance dedup and reconciliation.

**Attachments.** Attaching a file stages a reference to its Connected
Folder–relative path for the next message, shown as a quiet file icon,
filename, and remove control. Selecting a file in the list is not context:
the Worker is told only about what the message box carries. Once a message is
accepted, its files appear as the same chips above the sent message, opening
the file on click; a send that fails keeps them in the composer. The
composer's **+** attaches files from the Connected Folder (a searchable list
of its files, nested Connected Folders excluded) or **From This Computer**,
which copies the chosen files into the dated `Dropped/` folder and attaches
them, the same explicit act as dropping them. A pasted screenshot lands in
`Dropped/` the same way. Documents and other non-image files are not
extracted into the prompt: the Worker is told which paths the person
attached and inspects the originals with its file or document tools.
Attached PNG, JPEG, GIF, or WebP files reach the model as image content
through Pi's bounded vision pipeline. Missing files and invalid paths are
errors, never a successful chip.

**Steering and queued messages.** Enter during a turn delivers the message
through Pi's steering queue; the agent reads it after its current step, and
the transcript records it as sent mid-turn. If the turn settles first, the
message becomes the queued draft instead. ⌘Enter queues one follow-up message
behind the running turn as a visible, cancellable draft that sends when the
turn settles; Stop returns it to the composer. The app, not the window, holds
that queued draft (`PUT`/`DELETE …/conversations/:id/queue`, a
`queued_message` Chat event): every window on the Chat shows it, it outlives
the window that queued it, and the app sends it as an ordinary turn when the
running turn ends, with the files staged when it was queued and the Workers
it addresses with @. A Stop from any surface holds it instead (shown as not
sent); no later turn sends a held message, and Cancel hands it back to the
composer. The app numbers every queue change, and a window applies only a
change newer than any it has applied or made, so an echo can neither erase
newer text nor restore a cancelled message. Quitting AmpleFile drops it. The
AmpleFile Agent's running turn takes steering the same way in the popover;
attachments wait for the next message.

**Addressing Workers.** Typing `@` in a Chat or in the AmpleFile Agent's
popover offers Connected Folder Workers (nested Connected Folders first) and
addresses each one named. See
[the collaboration contract](collaboration-contract.md) for what each Worker
hears.

**Settled deletion.** File deletion and Connected Folder removal refuse until
the affected Connected Folder's requests and delegated work have settled or
been stopped and drained. Running turns, compaction, and Automation file work
hold the same reservation across deletion, and a waiting question counts as
unfinished work. This applies in the window and on the CLI, including a
Worker deleting from its own running turn; a busy refusal must not be
bypassed with raw filesystem tools.

**Long tasks.** Workers can recover their own completed tool observations and
saved findings through `progress` after compaction or an answer. The host
keeps evidence references and file freshness apart from the request's
checklist; a done item remains an agent claim. If compaction removes a Worker
answer continuation's hidden context, the host restates that request's
original assignment separately from its latest answer. Workers keep temporary
working files in an ordinary `.worker/<task-id>/` folder, created only when
needed, and deliver requested files outside it; it follows normal file,
Search, History, and attachment rules and is not hidden metadata or an
automatic cleanup area. Workers can also use structured collaboration calls,
ask asynchronous questions while independent work continues, send input to
terminal jobs, create managed Git working copies, and run focused read-only
helpers ([Worker tools](worker-tools.md)).

## A Connected Folder is a view of a folder, not a new file format

There are two honest ways to make a Connected Folder:

1. **New Connected Folder:** AmpleFile creates a normal folder under its
   managed local content location.
2. **Connect Folder:** AmpleFile registers an existing folder in place.

Both lead to the same experience. Connecting must not move, duplicate, or
rename user files. AmpleFile adds one narrow, hidden metadata layer:
`.amplefile/connected-folder.json` keeps the Connected Folder's identity when
its folder moves, and `.amplefile/conversations/` keeps its Chats with it.
The file list, History, and search hide this directory. Folders used with an
earlier app may also contain a `.work-fold/` folder, which AmpleFile hides
the same way and never reads. Provider credentials, the Connected Folder
registry, History objects, Pi sessions, ignore rules, and other
machine-specific state stay in application storage. Executable Pi
configuration stays separate under `.pi/`. Creating or connecting the
Connected Folder is the person's authorization for AmpleFile to load that
local configuration; disconnecting it revokes that authorization.

A new AmpleFile profile starts empty. Pi's personal resources and
authentication may be shared at the configured Pi root, but AmpleFile
sessions are kept under `sessions/amplefile/`.

Deleting a managed Connected Folder moves its folder into Recently Deleted
and unregisters it; disconnecting a linked Connected Folder only
unregisters it.

A Connected Folder also has a personal look: a name, accent colors, and a
Fluent icon. These help tell Connected Folders apart inside AmpleFile and are
application state on this computer, not part of `connected-folder.json`.

A person can always reveal a Connected Folder in Finder, open its files with
other apps, back it up normally, or synchronize it with a desktop sync tool.
A Google Drive for desktop folder works because it is a local folder; that is
not the same as direct Google Drive API integration.

## Settings

Settings has **Appearance**, **AI Models**, **Automations**, **Command
Line**, **Recently Deleted**, **Shortcut Keys**, and **About**. Automations
carries **Limits**, collapsed by default under a disclosure; **Closing the
window** lives in Appearance → Interface; updates live in About. **Command
Line** adds the `amplefile` command to Terminal and writes the Skill for
Claude Code or Codex, so other AI agents can use AmpleFile
([details](amplefile-agent-and-cli.md#other-ai-agents-settings--command-line)).

**AI Models** separates model defaults, shared provider connections, and
Worker instructions. Its scope is chosen with two large buttons, **This
Worker**, naming the Connected Folder, and **AmpleFile Agent**. The model is a
dropdown: closed, it shows the chosen model; open, it starts with a search
box and groups every connected provider's chat models by provider and vendor
(for OpenRouter, the vendor prefix of the model name), and choosing a model
closes it. **Provider connections** is separate, with saved connections
grouped above available providers. Connection setup keeps the model choice
and draft, including Azure endpoint and deployment setup. Unsaved model and
instruction drafts survive page and scope changes while Settings stays open;
credentials are not cached across scope changes. Accepted saves keep their
completion if Settings closes, so reopening waits for their result. External
settings changes refresh clean forms and offer an explicit reload when
drafts are present. An **Image Model** section holds one machine-wide choice
for every Worker and the AmpleFile Agent, with **Automatic** first
([Image generation](image-generation.md)).

Credentials are shared machine-wide, while model choices and Worker
instructions are machine-local preferences keyed by portable Connected Folder
identity; the AmpleFile Agent has its own model choice but no editable Worker
instructions. A model change becomes the default for new Chats, because a
live Pi session keeps its session model. A Worker-instruction change reloads
that Connected Folder's idle clients and applies to subsequent turns,
including existing Chats. Worker instructions are also where a Worker
remembers: when the person states a lasting preference about working in that
folder, the Worker or the AmpleFile Agent adds it as one line with
`connected-folders worker instructions --append`, which keeps what is already
there and skips an exact repeat, and says what it saved. OpenRouter has an
explicit live refresh backed by its tool-capable text-model API; the last
good result is cached outside every Connected Folder, and Pi's built-in
catalog is the fallback.

AI Models lists Pi's complete provider catalog and uses its advertised
sign-in methods and labels. Providers with no chat models can connect
without changing the Worker's model. Guided setup runs Pi's native
credential prompts, including provider-specific configuration and cloud
credential choices. ChatGPT sign-in uses the installation UUID Pi saves in
global settings, never a project identity. A browser sign-in (in AI Models or
Connect Your AI) opens the provider's page and completes on its own when the
browser returns to this Mac; while it waits, the place that started it says
**Finish signing in to … in your browser** with **Cancel**, and **Paste Link**
for the rare browser that cannot return the sign-in. No dialog asks for the
callback link, and where Pi offers a choice of sign-in method the app takes
browser sign-in. Starting another sign-in cancels one left waiting. Connections keep the complete
credential in encrypted machine-local storage; only non-secret connection
status and model metadata reach Settings. Settings also offers **OpenAI
(Codex subscription)** as a distinct connection for Codex models and account
and usage details; choosing it never silently replaces a working model.

Microsoft Foundry setup offers **Microsoft Foundry / Azure (OpenAI)**,
**Microsoft Foundry (Chat Completions)**, and **Microsoft Foundry
(Anthropic)**. They can be connected together; each keeps its own endpoint,
API key, and deployment names (separated by commas or new lines). The
Azure/OpenAI provider keeps Pi's per-model Responses or Chat Completions
choice; the separate Chat Completions connection selects that format
explicitly. Names become the available model choices without a catalog-model
selection or mapping. An optional **Deployment model details** disclosure
lets the person choose a base model from Pi's catalog when a custom
deployment name hides its context, image, or reasoning capabilities; until
then, Chat Completions and Anthropic deployments get Pi's generic limits,
labeled as default limits. Native Pi `models.json` definitions and overrides
remain available for models outside the base-model picker. A base-model id
missing from the catalog makes only that deployment unavailable; Settings
stays usable to repair or remove it. Pi owns provider auth, streaming, and
tool-call parsing. One deployment is selected separately for each Connected
Folder and the AmpleFile Agent. Resource or full inference URLs normalize to
`/openai/v1` or `/anthropic` for the selected connection. Saving configures
existing chat deployments; it does not test inference, sign in to Azure, or
discover deployments. This setup uses API keys; Microsoft Entra ID
authentication and non-chat model operations are separate work.

For a direct OpenAI account connection, native Pi validates and keeps the
sign-in ID token and its narrow identity metadata in the protected
credential. AI Models shows the kept email even when OIDC UserInfo returns
only a subject. A direct connection saved without identity shows a one-time
reconnect action rather than claiming that OpenAI did not provide the email.
A refresh that returns no ID token keeps the verified identity; an optional
identity-check failure after token rotation clears that identity while
keeping the replacement auth credential, so model access does not break.

The direct ChatGPT-plan grant does not authorize Codex workspace or usage
reads. **View Codex connection** selects the distinct **OpenAI (Codex
subscription)** entry; a person signs in explicitly to that connection. Its
details read the selected workspace name and plan and the provider's actual
usage windows, used percentages, reset timestamps, and available reset count.
Reads pin the workspace header and refuse usage whose returned account id
differs or is missing. They never infer a workspace from email, a user id, an
API organization, or a client id, and never substitute a default workspace.
No reset is consumed by this display. Usage refreshes every minute while the
details are open and on window focus; **Refresh account details** also
updates it without changing the model. A missing field reads **Not returned
by this sign-in**; a failed read says **Unavailable** and explains the
failure. **Manage usage in ChatGPT** opens the provider's usage page. Account
details stay in Settings, outside Chat, CLI snapshots, portable Connected
Folder records, and model prompts.

[Application appearance](application-appearance.md) covers editable presets,
palettes and accent, interface and conversation typography, reading width and
spacing, list density, quiet messages, which Worker steps stay visible while
a turn runs, and accessibility. The window and the popover share
device-local preferences. Typed appearance files are inert data. Undo and
reset change only these preferences, never a Connected Folder's colors or
icon.

## Context is explicit

Connecting a folder is also the host authorization for its existing local Pi
configuration. Agent context, new package installation, and external
connections stay separate:

| Action | What changes | What does not happen implicitly |
|---|---|---|
| Connect a folder | The folder appears in AmpleFile and its local Pi configuration may load. | Files are not uploaded or converted, and local code is not certified as safe. |
| Attach a file to a Chat | That file is made available to the conversation. | Other Connected Folder files are not included automatically. |
| Install an Everywhere Skill or Extension | It becomes available through the person's Pi scope. | It is not copied into every Connected Folder. |
| Delete a file or folder | AmpleFile records a safety restore point; anything the restore point cannot cover moves into Recently Deleted with a manifest naming its Connected Folder, path, size, deleted-at, restore-by, and receipt. | Nothing is permanent at the moment it happens; `.amplefile/` and `.pi/` are never valid endpoints. |
| Restore from Recently Deleted | AmpleFile puts the entry back at its recorded path, or registers a deleted managed Connected Folder again, and receipts the restore. | Only the retention clock empties Recently Deleted; no agent or CLI verb does. |
| Enable an Automation | AmpleFile records an exact-digest grant over one reviewed declaration in a single receipted call. | Proposing, registering, and running once never enable standing behavior; an edited declaration returns to proposed. |
| Run an Automation | App code runs the reviewed steps in order with per-hop receipts inside the shared scheduler bounds. A declared `agent` step may message the AmpleFile Agent, and a closed set of host-resolved placeholders may fill a step's message. | No model composes the steps, an Automation never moves or deletes source files, and no Connected Folder's folder learns another Connected Folder exists. |

"Available", "in this Connected Folder", "in this Chat", and "allowed to
execute" must never collapse into one invisible state.

## Agent model

AmpleFile hosts Pi instead of recreating an agent framework. Pi owns model
and provider behavior, built-in tools, standard resource discovery, packages,
Skills, Extensions, and project trust mechanics. AmpleFile supplies the
desktop experience: setup, catalog surfaces, secure credential storage,
folder selection, the registered Connected Folder authorization override,
Extension UI bridges, and clear execution and permission explanations.

Native Extension questions stay inline in their owning Chat, including the
AmpleFile Agent's, with transient reconnect recovery and Stop. They are live
Pi callbacks rather than durable agent questions. Included capabilities use
the same native Extension path; inclusion describes AmpleFile's maintenance
responsibility, not another trust or runtime tier. See
[Extensions and computer work](extension-foundation.md).

The [tool feedback contract](tool-feedback.md) applies across general
computer work: native tools return observations, and the agent uses Pi's
ordinary loop to verify or correct its result. Context inspection is a
developer-only local diagnostic, outside ordinary Chats and Settings.

There are two capability scopes:

- **Everywhere** (everywhere scope): available to the AmpleFile Agent and
  every Connected Folder from the person's Pi agent directory.
- **This Connected Folder only** (project scope): portable configuration
  stored under the Connected Folder's `.pi/` directory and authorized while
  the folder is connected.

The **Skills & Extensions** dialog unifies discovery and management without
erasing the distinctions that matter. Its Installed view starts with the
**Included with AmpleFile** strip, then shows **Everywhere** and **This
Connected Folder only** side by side; a row opens its details on click, and
adding starts from one Add dialog that asks **Where should it live?** first.
It identifies whether an item is a Skill or Extension, Everywhere or This
Connected Folder only, active or merely available, imported directly or
provided by a package, and healthy or failing diagnostics. Installed items
can be searched, filtered by type and scope, and sorted by name, type, scope,
or source. Discover results can be searched, filtered, and sorted by
first-party or reference status, downloads, recency, or name.

Packages can distribute Skills, Extensions, prompts, themes, and related Pi
resources. They are installation and lifecycle plumbing; the primary UI
describes the capability a person is gaining, shows inspected resource types
and lifecycle scripts when registry metadata is available, and labels
unavailable details as unknown rather than absent. A package that includes
Extensions or install scripts is a code-execution decision and is never
presented as a harmless Skill-only import. See
[Skills & Extensions](skills-and-extensions.md).

Native Pi Extensions are AmpleFile's executable capability lane: standard Pi
package and resource locations, with full current-user execution after an
Everywhere install or a Connected Folder connection. An Extension may add Pi
tools, commands, providers, events, and a static `surface.json` contribution
([Declarative Extension surfaces](extension-surfaces.md)); its code owns its
network and operating-system access.

**Included tools.** The five included tools (Chrome, Computer Control, Web,
Documents, and Service Connections) show observed readiness separately from
native loading. The Skills & Extensions dialog refreshes cold host status
automatically; opening it never launches a helper or connects a server.
Successful use can supply readiness evidence. A computer-permission check
stays visible as Last Check Passed with its timestamp, while Documents proof
belongs to the running build. Service Connections says No Connections or
Configured and leaves actual health to each connection. A selected Chrome
profile reconnects automatically. Check observes; helper repair is a separate
explicit setup operation and never silently disposes idle Chats
([the extension contract](extension-foundation.md#readiness-and-lifecycle)).

**Documents checking.** A Worker checks a document before it calls the work
done: it renders Word and PowerPoint files to pages and looks at them,
recalculates a copy of a workbook and reads its results, fixes what is wrong,
and says in one line what it checked. Checking needs LibreOffice, which
AmpleFile does not bundle or install, so the **Documents** tile says **Setup
Needed** while it is missing; on a Mac without it, a Worker still previews
page 1 of a Word file and any slide of a deck with Quick Look. A Worker
installs an engine only when the person asks. See
[Document verification](document-verification.md).

**Built-in browser.** Every Worker and the AmpleFile Agent can use AmpleFile's
own browser through the `browser_*` tools, with one persistent machine-local
profile apart from Chrome and from every Connected Folder. The tools come
with the app and are not one of the five included tools. See
[Built-in browser](built-in-browser.md).

## Shared semantic layer

`AmpleFileKernel` is the shared in-process read authority above the
individual screens, so the renderer, command line, scripts, and Pi
understand the same product. It resolves actor context to the most specific
Connected Folder, exposes versioned snapshots of registered Connected
Folders and running agent work, and projects Pi's authoritative capability
catalog without creating another registry.

The installed `amplefile` command is an adapter over that layer. Its read
lane reports context, Connected Folders, active agent turns and compactions,
and available Skills, Extensions, tools, packages, prompts, themes, and
commands in human or stable JSON form, and stays content-free. A separately
versioned act lane, authenticated per app launch and recorded with durable
receipts, gives a shell-capable agent the product's verbs while the app is
running: Connected Folder lifecycle and appearance, per–Connected Folder
model defaults and instructions, Chats and their lifecycle, History restore
points and restores, restore-pointed file operations, content search,
Recently Deleted, background jobs, the collaboration verbs and request reads,
and the AmpleFile Agent itself. Act commands reuse the same trust, conflict,
History, and task rules as the window. Acts that make bytes runnable, widen a
standing power, or destroy run immediately through the same prepare, pin,
journal-first, fenced execution path and return a receipt; destruction is
reversible through History or Recently Deleted. Provider credentials, window
state, and other application settings stay outside it. See
[the act ledger](act-ledger.md) and
[the AmpleFile Agent and CLI](amplefile-agent-and-cli.md).

The **AmpleFile Agent** is one conversation scope above all Connected
Folders and the door through which material enters them. Its transcript is
machine-local, and its Pi session loads Everywhere capabilities plus two
app-materialized instructions. It is a full-trust agent with ordinary local
tools, taught to prefer receipted `amplefile` commands for work that touches
Connected Folders. It is reached through `amplefile agent …` and the
menu-bar popover. The popover is drawn as a Chat in the file manager's
panel, in the same design tokens, so Settings → Appearance restyles both:
the person's messages are soft accent-tinted bubbles on the right and agent
replies are unboxed on the left. Its header shows the current Chat title
over a hairline, with icon buttons for **Chats** and **New Chat**; **Chats**
replaces the title with a back button and lists saved Chats by day in
grouped cards, with the file manager's pulsing dot for a working Chat and
its green dot for one that needs an answer. **New Chat** makes a clean
slate, creates a saved transcript on first send, and never deletes a prior
transcript. The message box is the file manager's: a rounded field with
Send inside, and the model and reasoning level in a small row beneath it.
Dragging files, folders, or links over it stages inert reference chips; the
person adds an instruction, and sending stays the explicit act. Its model
label opens **Settings → AI Models** scoped to the AmpleFile Agent. While a
turn runs, the send action becomes **Stop** and the draft stays usable. A request whose delegated
Connected Folder turn is still running shows **handed off**, never done; a
failed child fails the request, Stop names every recorded child it aborts,
and every attachment receives a final disposition. The popover can rename
and delete idle AmpleFile Agent Chats; a deleted one goes to Recently
Deleted.

A person's ask is a **request**: one durable, machine-local record that owns
the outcome across however many turns and Connected Folders it takes
([the collaboration contract](collaboration-contract.md)). The AmpleFile
agent hands a piece of it to a Connected Folder's Worker, the Worker hands
one result shape back (a plain-language summary, optional structured
details, the files it chose, and whether it finished, finished partly, or
failed), and either side can ask a question instead of guessing. A question
stops that task rather than the person's day: the turn ends, the request says
it is waiting, and one accepted answer starts exactly one continuation turn
carrying it. A parent turn never sits on a waiting child; it finishes and
says what is outstanding, and when the work it handed out settles, AmpleFile
starts at most one follow-up turn carrying the collected reports, within that
request's bounds and switchable off in Settings → Automations → Limits. A
Connected Folder that needs another asks for a handoff, and AmpleFile starts
that Chat with the message and copies of the named files through the
ordinary restore-pointed path; no model turn is needed to move a result.
What crosses into a Connected Folder Chat is only its assignment, payloads
someone deliberately released to it, and answers to its own questions. The
same verbs serve the AmpleFile Agent, a Worker, and any shell-capable agent
on the CLI, with the same receipts and the same named limits.

## Desktop shell

- macOS uses its native hidden-inset title bar and application, File, Edit,
  View, Window, and Help menus. Window size, position, and theme are kept,
  and the renderer recovers from a crash.
- Closing the last window keeps AmpleFile running; the Dock icon brings the
  window back. **Quit** exits cleanly. Closing the window never stops an
  accepted turn.
- The menu-bar item opens the AmpleFile Agent popover on click; a right
  click opens a menu with **AmpleFile Agent**, **Open AmpleFile**, **Check
  for Updates...**, and **Quit AmpleFile**. Files or links dropped on the
  icon become reference chips. The popover works with the main window
  closed, holds drops without sending, and its Stop names the AmpleFile
  agent turn and every delegated Connected Folder turn it aborts.
- Explicit Copy actions in the window and the popover write text (and
  formatted Chat HTML when available) through a write-only native clipboard
  bridge that only trusted top-level frames can call. Copy reports success
  only after the write succeeds.
- File opening, reveal, and drag-out use safe Connected Folder–relative paths
  and never escape the Connected Folder root.
- A request from the `amplefile` command coexists with the running app and
  never opens or steals focus from the window. Adding the command to
  Terminal is reversible and never edits shell profile files.
- **Needs you** means an agent asked a question or a snooze came due, never
  an action waiting for approval. Questions appear inside their owning Chats.

## Product rails

When a design is ambiguous, prefer the option that best keeps these
properties:

1. **Local first:** core work needs no account or cloud service.
2. **Ordinary files:** user content stays portable and directly accessible.
3. **Clear language:** show the Connected Folder mental model before
   filesystem or package-manager jargon.
4. **Explicit context:** people can tell what the agent can see in the
   current Chat.
5. **Layered authorization:** connecting a folder authorizes local Pi
   configuration; package installation, connections, and Chat context stay
   explicit and separately revocable.
6. **Pi compatibility:** use standard Pi behavior and formats instead of
   parallel AmpleFile-only systems.
7. **Capability transparency:** show source, scope, status, and diagnostics
   for executable additions.
8. **Provider neutrality:** cloud and model integrations use replaceable
   adapters rather than shape the core model.
9. **Receipts, not gates:** every verb executes on first call, journaled
   before and receipted after; verbs that make bytes runnable, widen a power,
   or destroy keep their identity pins, effect-time rechecks, and
   at-most-once execution as attribution and recovery. No surface offers an
   authority mode, a standing rule, or an approval card
   ([the act ledger](act-ledger.md#receipts-not-gates)).
10. **Reversible destruction, setup-only secrets:** History covers ordinary
    deletion; what it cannot cover goes to Recently Deleted with a retention
    window. Provider credentials are Settings acts with no agent or CLI verb,
    and no task waits on them. Per–Connected Folder model defaults and
    Worker instructions are configuration with narrow receipted verbs.
11. **Agency on a cadence lives in Connected Folders:** above Connected
    Folders, only declared deterministic Automations run unattended;
    enabling one is a single receipted call that pins the declaration
    digest; an Automation may message the AmpleFile Agent only through its
    declared `agent` step; work across Connected Folders never runs inside a
    Connected Folder Chat, because Connected Folder transcripts travel. The
    one bounded exception is a person-started request's follow-up turn: when
    the work it handed out settles, the host may continue that request once
    per settle batch, within the request's own limits.

## Nested Connected Folders

A Connected Folder may be registered inside another, and the deepest
containing Connected Folder is its parent. The sidebar shows the nesting.
Parent writes, creates, uploads, and copies stop at a nested Connected
Folder's root, and a folder that holds a nested Connected Folder is not
offered Rename or Delete from the parent. Deleting a managed parent requires
disconnecting its nested Connected Folders first, even when their Workers are
idle, and a pending managed deletion refuses new nested registrations before
any folder moves. History, search, and Automations treat nested Connected
Folders as separately owned.

History refuses a restore that would overwrite or delete content its new
safety checkpoint cannot capture. Protected metadata and nested Connected
Folders stay outside parent recovery, and a directory once excluded from
History keeps its descendants protected even after ignore rules change.
Relinking a moved Connected Folder on the same computer relocates its
machine-local recovery state before committing the new registration. The
window shows what a restore will change; the window and the CLI hold the same
active-work reservation through restore. History is bounded local recovery,
not a complete or transactional backup.

## Roadmap and known gaps

### Shipped

- Create a Connected Folder or connect an existing folder without
  conversion; rename one, disconnect a linked folder without deleting its
  files, or delete a managed Connected Folder into Recently Deleted.
- Browse Connected Folder and Standard Folder files in a Finder-style file
  manager, run Connected Folder Chats in the panel, and view History.
- Search a Connected Folder by name and by content inside ordinary files and
  Chat transcripts, honouring ignore rules, skipping binary content, and
  saying when a bound stopped the search.
- Restore content-addressed History checkpoints made around file changes and
  agent turns. A full checkpoint hashes real bytes and keeps that cost
  proportional to the person's own work: it skips version-control internals,
  installed dependencies, Python virtual environments, self-declared caches
  (`CACHEDIR.TAG`), AmpleFile's hidden support directories, directories the
  person ignored, and directories a `.gitignore` excludes, while every
  individual file, including a gitignored `.env`, remains recovery material.
  A targeted checkpoint captures exactly the paths it is asked about.
- Configure a Pi provider and model with an API key or an advertised Pi
  provider sign-in and use Pi's built-in tools.
- Discover installed Skills, prompts, Extension commands, and supported
  built-ins from the composer, and see the active model and context-window
  pressure during a conversation.
- Discover, search, import, install, update, and remove Skills, Extensions,
  and Pi packages at Everywhere or This Connected Folder only scope, with
  accurate source, scope, load state, and diagnostics, and browse curated
  first-party and community packages with explicit provenance.
- Customize each Connected Folder's name, colors, and icon; inert proposal
  import and export keep the same typed contract available to people, Codex,
  and Claude Code.
- Inspect context, registered Connected Folders, active agent and compaction
  tasks, and Pi capabilities through `AmpleFileKernel` and the `amplefile`
  read lane, and operate the product from any shell-capable agent through
  the act lane while the app is running.
- Talk to the AmpleFile Agent through `amplefile agent …` and the menu-bar
  popover, with reference attachments, an explicit request and child action
  trail, and machine-local saved transcripts.
- Steer a running turn, queue one follow-up message, choose the reasoning
  level, and attach images and dropped files.
- Run an agent turn without a wall-clock cap, as native Pi does; Pi's HTTP
  idle timeout still catches a provider that stops answering, and a host may
  set an explicit cap with `AMPLEFILE_PI_TURN_TIMEOUT_MS`. A single model
  response that sends no text, thinking, or tool input for three minutes
  (keep-alive pings do not count) ends as a retryable stream timeout, keeping
  its partial response, and Pi's own retry sends it again.
  `AMPLEFILE_PI_STREAM_STALL_MS` changes that silence, and `0` turns it off.
- Give the agent's shell tools the person's real login-shell environment: a
  Dock, Finder, Spotlight, or `open` launch asks the login shell for its
  environment once at startup (profile-provided `PATH` entries such as
  Homebrew or nvm included) before any Pi session exists, while a terminal
  launch keeps the environment it was given;
  `AMPLEFILE_DISABLE_LOGIN_SHELL_ENV=1` opts out.
- Reach model providers through the same transport as the Pi CLI: Pi's
  `httpProxy` setting and `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` are
  honored, Pi's HTTP idle timeout applies to headers and bodies, and the
  guarded dispatcher is installed before the first provider request.
- Declare deterministic Automations between Connected Folders (a schedule or
  an explicitly designated folder change driving fixed Chat, files, and agent
  steps on a separate eight-slot scheduler with per-hop receipts and
  host-resolved placeholders), and read the overview through
  `amplefile agent overview --json`.
- Drive one real Pi turn through the local API with the `amplefile:drive`
  test driver.
- Build, Developer ID-sign, notarize, and publish the Apple-silicon Mac app,
  DMG, ZIP, blockmap, and update metadata.

### Next product layer

- Show the built-in browser's pages and full-width Chats inside the file
  manager window.
- Make Connected Folder location, storage ownership, History coverage, and
  executable capability class easier to inspect at a glance.
- Add named-pack selection for Anthropic marketplace bundles instead of
  importing every discovered Skill in an archive.
- Add Chat-scoped grants and headless execution to the act lane only if it
  ever outgrows the per-launch single-user token.
- Extend Automation triggers only through deliberate contracts for any new
  event source, handoff condition, or recovery behavior. Coordination across
  Connected Folders stays with the AmpleFile Agent; Connected Folder Chats
  stay local to their own work.
- Offer Chrome and Computer Control setup in a Chat the first time a Worker
  needs them; deepen accessibility, renderer interaction tests, recovery,
  export, and diagnostics.

### Later adapters

- Verify and document supported provider sign-in flows account tier by
  account tier in packaged releases; do not turn Pi's generic OAuth hook
  support into a blanket compatibility claim.
- Add direct cloud-storage integrations behind a provider-neutral model with
  stable remote ids, offline behavior, explicit conflicts, and no surprise
  deletion.

Roadmap wording must distinguish shipped behavior from direction. Update this
section when a capability moves between layers.

## Decision test

Before adding a new top-level concept, ask:

1. Can it fit cleanly as Connected Folder content, a Chat, a Skill, or an
   Extension?
2. Is its scope obvious: everywhere, one Connected Folder, or one Chat?
3. Can a person understand what it can read, change, or execute?
4. Does it keep normal folders and standard Pi compatibility?
5. Would it still make sense for non-coding computer work?

If those answers are unclear, the feature needs a sharper mental model before
it needs another navigation item.
