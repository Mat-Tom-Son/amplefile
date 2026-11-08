# Desktop experience parity

AmpleFile is the clean-break successor to the legacy Workspace extraction of the mature Kai Workspace desktop experience, not a new interface inspired by it. The neutral desktop interaction model from `win-kymadocs` commit `57ff910` is the behavioral baseline. Product-specific integrations and language may be replaced, but the general-purpose interaction quality should be preserved.

## Product translation

| Baseline concept | AmpleFile concept |
| --- | --- |
| Workspace backed by a local SharePoint mirror | Connected Folder backed directly by an ordinary folder |
| Kits | Skills |
| Sources | Ordinary files in a Connected Folder (the desktop Library was retired on 2026-09-25) |
| Microsoft organization login | Agent setup using Pi providers |
| Kai | Agent |
| SharePoint sync and publish | Local files first; cloud-synced folders work through their desktop clients |

The translation is intentionally narrow. It does not justify replacing the shell, tabs, file interactions, chat experience, desktop integration, or accessibility behavior.

## Required interaction model

### Persistent surface tabs

- Chat, file, and History surfaces open as tabs instead of route-only panes.
- Customize Connected Folder opens a popup from the Connected Folder header, Manage Connected Folders, or Settings → Appearance,
  with Banner, Icon, and Color sections, offline image presets, framing, and categorized icon search.
  Model and Instructions shortcuts open that Connected Folder's AI Models settings; a back arrow beside the
  Settings title returns to the same Connected Folder and customization section only from this entry path.
  It stays pinned to the target Connected Folder without creating a tab or replacing the active work surface and uses
  the shared modal focus, Escape, outside-click, and close-control behavior. Old saved appearance
  tabs are discarded on restore while the remaining work tabs stay intact.
- Tabs persist and restore across application restarts.
- Each tab retains its Connected Folder identity; activating a tab from another Connected Folder activates that Connected Folder.
- Each Connected Folder remembers its most recently active tab.
- Existing conversations deduplicate to one tab while multiple unsent New Chat drafts remain possible.
- Renamed conversations update their tab titles.
- Moving or renaming a file retargets its open tab; deleting it closes the affected tab.
- Closing a tab selects the adjacent tab predictably.
- On macOS, right-clicking a tab opens a native menu, as Files and browser tabs do. A Chat tab, or a Chat in the Chats list, offers **Rename…**, **Make a Copy**, **Snooze** (a submenu of times), **Archive**, and **Delete Chat**; every tab ends with **Close Tab**, **Close Other Tabs**, **Close Tabs to the Right**, and **Reopen Closed Tab** (2026-11-04). Other platforms keep the Chat actions popover (2026-10-30).
- Cmd/Ctrl+Shift+T reopens the tab closed last, browser or not, in its old place; a middle-click closes a tab. Two open files with the same name show their folder in the tab (2026-11-04).
- Arrow keys, Home, and End navigate the tab strip with correct focus and ARIA tab semantics.
- With four or more tabs open, tabs narrow but keep their Connected Folder icon and a normal close button.
- Inactive tab panels remain mounted when needed so drafts, scroll position, and transient UI state survive tab switches.

### Desktop shell

- Preserve the Windows custom title bar and the platform menu contract; macOS uses its native hidden-inset title bar plus application, File, Edit, View, Window, and Help menus.
- Preserve window size, position, maximized state, theme integration, and renderer recovery behavior.
- On Windows, closing the window may hide AmpleFile to the system tray when the preference is enabled. On macOS, closing the last window keeps the application host alive and the Dock icon recreates the window. Explicit Quit exits cleanly on both. Close-to-tray remains Windows behavior: the macOS menu-bar item never changes what closing the last macOS window means.
- The tray menu exposes clear **AmpleFile agent**, **Open AmpleFile**, **Check for Updates...**, and **Quit AmpleFile** actions and does not strand an invisible process.
- Both platforms carry the AmpleFile agent popover (the menu's **AmpleFile agent** entry): a macOS menu-bar item where left click opens the popover, right click opens the menu, and files or links dropped on the icon become reference chips; the Windows tray offers the same popover through its menu while click still opens the main window. The popover works with the main window closed, holds drops without sending, and its Stop names the AmpleFile agent turn and every delegated Connected Folder turn it aborts.
- Update status and commands remain available from both the platform-appropriate desktop menu and settings surface.

### Files and folders

- The Files rail item, resizable file pane, search, expandable tree, file-type icons, details pane, and file history remain first-class for the selected Connected Folder.
- Right-click actions are available throughout the file tree and use native desktop context behavior where appropriate.
- Supported actions include open, reveal in Explorer/Finder, copy path, attach to chat, rename, move, upload/import, delete, and version history. **New folder** in the Files toolbar creates a directory at the Connected Folder root; **New Connected Folder Here** in a folder's context menu creates a child directory. Both use an in-app naming dialog and the existing History restore-point path, including the native macOS menu. File creation remains unavailable.
- Files selects several rows the way Finder's list view does (2026-11-05): a plain click selects one row and opens a file's tab; ⌘-click (Ctrl-click on Windows and Linux) adds or removes a row; Shift-click selects the shown rows from the last clicked one, open folders' rows included, and ⌘/Ctrl+Shift-click adds that run. Shift+Arrow, Shift+Home/End, and ⌘/Ctrl+A extend the selection from the keyboard, and Escape narrows it to the focused row. Modified clicks never open a tab, and a row that stops showing leaves the selection. Right-clicking a selected row acts on the whole selection with **Attach to Chat** (files only), **Copy Paths**, and **Delete** (counted, such as **Delete 3 Items**), in the native macOS menu too; right-clicking an unselected row selects just that row first. Dragging a selected row moves or attaches every selected row. Moving or deleting several rows is one request with one History restore point for all of them (2026-11-05). Every row is checked before any of them changes. Each deleted row still gets its own receipt, the busy refusal, and History or Recently deleted for whatever History can't keep, and one Undo covers them all. If a row still fails partway, the rows already done stay done, the rest are left alone, and the restore point undoes exactly what happened.
- Attach to Chat stages a quiet file icon, filename and remove control above the owning Chat's composer, without a success toast or extraction-status badge. The composer's **+** button stages the same chips from a searchable list of the Connected Folder's files, or copies files chosen from the computer into `Dropped/` first, as a drop does. Sending moves those chips onto the sent message. Connected Folder file attachments give the Worker the selected paths to inspect with tools; supported images retain bounded native vision admission. Missing files or invalid paths show a real error instead of a successful attachment chip.
- Explicit Copy actions in the desktop, AmpleFile agent popover, and context inspector write text (and formatted Chat HTML when available) through a write-only native clipboard bridge. Native-menu focus transitions must not make Copy fail. Only trusted top-level renderer frames can call it. Browser hosts retain the browser clipboard API, and copy success is shown only after the write succeeds.
- The file tab offers Copy for text files, including empty ones, and reads the whole current file rather than its bounded preview. Markdown supplies formatted HTML and plain Markdown. Switching tabs, changing the file, or closing the tab cancels an unfinished read; a prior file cannot claim the new one was copied.
- Desktop drag-out, file opening, and reveal operations use safe Connected Folder–relative paths and never escape the Connected Folder root.
- Delete moves content into History's undo window or Recently deleted; confirmations may remain, but nothing is permanent at the moment it happens and the Undo toast restores from whichever holds it.
- A restore point's tab puts its name, date, and **Restore** at the top, then one list of the files changed since then, each marked Changed, Added, or Moved with **Compare** opening beneath it; files that still match are not listed, and the folders History never covers (`.amplefile`, `.pi`, `.workspace`) are not mentioned. The page scrolls within its tab (2026-10-30).
- Registering an existing folder as a Connected Folder never moves or converts user files. It maintains only the documented hidden `.amplefile/` identity and conversation layer; that layer, preserved legacy `.workspace/`, and native `.pi/` configuration never appear as ordinary Files. Legacy `.workspace/` content is never parsed or imported.

### Chat and navigation

- Each message keeps its icon-only Copy control at the far left of its footer.
  Its timestamp occupies the next slot and fades in on hover or keyboard focus
  without moving the Copy control.
- Preserve conversation history, rename, drafts, streamed replies, actual model reasoning text, the compact inline trail of real tool calls, stop behavior, context attachments, copy actions, suggested prompts, and extension UI requests. Persist settled Thinking/tool entries with their agent message so tab switches and relaunches restore the same trail without running indicators or completed-tool replay. Reasoning may carry the quiet `Thinking…`/`Thinking` label; repair only orphan Markdown text markers after parsing, preserve valid code/emphasis, and show safe tool targets rather than raw result bodies. Do not reintroduce a separate Activity drawer, brain icon, completion badge, or large app-authored reasoning status card.
- Preserve the command palette, keyboard shortcuts, toast/confirm feedback, onboarding, Connected Folder creation/linking, themes, typography, and resizable layout. [Application appearance](application-appearance.md) owns device-local presets, readable semantic colors, interface/conversation typography, density, and accessibility. Desktop and menu-bar chat use one shared preference store; Connected Folder identity stays separate, and the paired web fold retains browser appearance.
- The persistent Connected Folder header chooses the root-folder entity and offers compact create/use-existing/manage actions on every left-pane surface. Primary rail navigation uses `Files`, `Chats`, and `History`; Chats in other Connected Folders stay collapsed below the selected Connected Folder's list. The bottom-rail Add button opens the Skills & Extensions popup directly (2026-09-25); there is no Add menu, no Library tab, and no apps (removed 2026-11-07). The Skills & Extensions popup is pinned to the Connected Folder it was opened from and combines Installed and Discover views for Skills and Extensions while retaining scope, provenance, load state, diagnostics, and package lifecycle; its Installed view starts with the Included with AmpleFile strip and shows Everywhere and This folder only side by side. Provider connections, model defaults, per–Connected Folder instructions, API-key, and OAuth setup live in `Settings → AI Models`, whose scope is chosen with two large buttons (This worker and AmpleFile agent) and whose model dropdown opens with a search box and vendor groupings and closes on a choice; only model defaults and Connected Folder instructions have narrow amplefile-agent verbs.

### Collaboration within a conversation

[Collaboration experience](collaboration-experience.md) defines the shared work
presentation. Connected Folder Chats and the AmpleFile agent follow the durable
request while the message stream follows its current turn. Questions show their
origin and an addressed answer field; Needs you opens those questions inline.
Stop includes outstanding delegated work and remains available between turns.
Selected files open in their owning Connected Folder; partial results are named explicitly.
Host continuations appear as quiet activity, never as messages typed by the person.

Refresh and reconnect preserve drafts and focus. Unsent question answers use
session storage for the current renderer or browser tab, clear after acceptance,
and never enter model context before sending. A saved but undelivered answer has
an explicit recovery action.

### Management layer and CLI

- The read-only AmpleFile agent layer is additive infrastructure; it must not replace or weaken Connected Folder–bound tabs, background continuity, native menus, or the visible trust and capability-management surfaces.
- There is no paired web client: Web Access was removed from the desktop on 2026-11-07. Desktop Files remains first-class.
- The installed `amplefile` command resolves the terminal's current folder to the same Connected Folder model as the renderer, can report live agent/compaction tasks, and exposes compact capability metadata through stable JSON.
- A headless CLI request must coexist with the running single-instance desktop app, return bounded stdout/stderr/exit status, and avoid opening or stealing focus from the interactive window.
- Installer PATH integration must be reversible and must not modify shell profile files.
- Settings uses Appearance, AI Models, Automations, Recently deleted, and About. Automations also carries Limits, collapsed by default under a Limits disclosure; Recently deleted carries the entry list, Restore, Delete now, and the retention window; Updates lives in About; no authority selector or standing-rules section exists on any surface.
- On macOS the Connected Folder header's right-click menu is native, like tabs and Files (2026-11-05): New Chat, Customize Connected Folder, Set Up for Me, Just the Look, Show in Finder, and Manage Connected Folders. Elsewhere the in-app menu appears above pane dividers. An outside press dismisses it without starting a resize or activating an underlying control; Escape also dismisses it and returns focus to the header. Pane resizing resumes normally after dismissal.
- **Needs you** shows only agent questions and due snoozes — never an action waiting for approval. On the desktop, questions appear inside their owning Chats and due snoozes return to the Chats list. The popover stays focused on its always-visible, incrementally streaming conversation, one expanding composer whose action becomes **Stop** during active work, a clickable actual-model label, and a text-only supported reasoning selector; it neither fetches nor acknowledges the overview. None of these adds a rail destination, tab, or notification; the main window may carry at most a questions-only indicator that opens those items — never an approval control — and with nothing to show, no control appears.

## Deliberately removed or replaced

- Microsoft/Azure organization authentication and organization-account UI.
- SharePoint mirror, publish, readiness, and controlled-document semantics.
- Compliance/SOP-specific review surfaces and Kymanox/Kai branding.
- Company signing credentials and compatibility identifiers that are not needed by AmpleFile.

Pi remains the agent runtime. AmpleFile should expose Pi's provider setup, standard built-in tools, Skills, Extensions, packages, registered Connected Folder project authorization, and supported extension UI without inventing a second full-trust capability system.

## Acceptance evidence

A corrective port is ready for release only when all of the following are true:

1. The original and Workspace fixture screens have been captured at the same viewport and reviewed side by side.
2. Tabs have been exercised for restore, multiple drafts, cross–Connected Folder activation, rename, move, delete, close fallback, and keyboard navigation.
3. File-tree context actions and native open/reveal/drag behavior have been exercised against a disposable Connected Folder.
4. Custom menus, close-to-tray, Show, Quit, window-state restore, and updater surfaces have been exercised in packaged Electron.
5. Type checks, tests, renderer build, desktop compile/preflight, and a packaged smoke build pass on the supported Node runtime.
6. The app contains no user-facing Kai, Kymanox, Kits, Sources, SharePoint, Microsoft-login, or legacy Workspace copy except in historical documentation.
7. The packaged CLI resolves context, lists connected-folders/tasks/capabilities, coexists with the GUI, and cleans its request/response handoff.
8. No public release is published until the product review is accepted and the exact release commit is green on both main and matching source-tag CI.

## Accepted public baseline

The first July 10, 2026 local candidate at commit `71e5fa4` was rejected after real screenshots exposed two release-blocking defects: it called the Files surface “Connected Folder,” and several newly written pane structures had no matching styles. That build remains historical evidence of why packaged visual review is a release gate.

Workspace 0.2.7 at commit `db5c149` established the accepted public baseline on July 12, 2026. It preserves the interaction contract above, uses the compact Fluent icon-only rail with accessible labels/tooltips, applies supported Windows Mica with a safe fallback, and includes the shared management kernel and installed read-only CLI.

The 0.2.8 development checkpoint at commit `27aa329` established the restricted-app sandbox baseline: Connected Folder–owned rail and work-tab surfaces, separate visible and worker sandboxes, default-off external authority, host-owned connections and storage, deterministic teardown, and a release-gating real-Electron probe. The current version-2 contract replaces its single-job prototype with named automations; compatibility with that unreleased manifest shape is intentionally not retained. Connected Folder apps were removed on 2026-11-07, so this sandbox baseline no longer applies.

Future changes must retain those behaviors while satisfying [the AmpleFile visual system](visual-design.md), [the management-layer contract](amplefile-agent-and-cli.md), and the current build/release gates. Browser review must cover every primary and agent surface in light and dark themes at the true minimum window size and at a tall desktop aspect ratio. Automated checks must continue to guard the Files/connected-folder distinction, Connected Folder–bound tabs, Fluent shell-icon contract, compact neutral chrome, and JSX-to-CSS contracts.
