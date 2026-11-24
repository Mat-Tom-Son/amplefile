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
| **Recently Deleted** | The machine-local holding place for anything AmpleFile removed that History could not restore (files, folders, a managed Connected Folder's folder, a deleted Chat, and a removed imported Skill), kept for a retention window and restorable from Settings or the CLI. | It is not a Connected Folder, not portable, not a backup, and never empties on a verb; only retention purges it. It is not the computer's Trash either: what is moved to the Trash from a Standard Folder, an other folder, or any app is in the window's **Trash**, which the person can empty. |

## The file manager window

The local [Linux candidate](linux-build.md) resolves Standard Folders through
XDG user directories, including relocated paths, and omits disabled directories
and iCloud Drive. The home row remains separate. **View → AmpleFile Agent**
also opens the agent when the Linux desktop has no tray icon. Closing the
last Linux window preserves accepted work; Quit ends the host. The Linux title
bar draws the window buttons the desktop's button layout asks for, on its side,
and the desktop's accent, light or dark, and contrast apply as a Mac's do
([Title bar and desktop appearance](linux-build.md#title-bar-and-desktop-appearance)).

AmpleFile's window is a smart file manager that looks native to macOS and
Finder. It uses the same local API, file events, and desktop bridge as every
other surface.

- **Window:** a sidebar, a toolbar (Back and Forward, the folder's name,
  Icons or List, Action, the **Browser** button, Search, and the panel
  button), the folder's contents, and Finder's path bar (the disk down to
  the selected item) with an item count and the space available on the
  folder's drive ("12 items, 40.2 GB available"), then the Browser pane while a
  browser tab is open, and the right panel. The panel button is the
  toolbar's last control, to the right of Search and nearest the panel: it
  hides the panel (**Hide Panel**) and shows it again (**Show Panel**). The
  toolbar's **Action** button (⋯) and right-clicking a Connected Folder in
  the sidebar offer **Customize Connected Folder**, **Organize**, **Show in
  Finder**, **Skills & Extensions…**, **Disconnect…** (or **Delete Connected
  Folder…** for a managed one), and **Settings…**. **Organize** opens the
  panel and starts a Chat asking that Connected Folder's Worker to organize
  it, going to that Connected Folder first when another is shown. Dragging the edge beside the
  sidebar or the panel resizes it (double-click resets it; the widths are
  kept); a narrower window takes room from the panel first, so the folder
  list keeps 360px.
- **Sidebar:** flush with the window's edges and square like the rest of the
  window. **Recents** sits at the top: files changed in the last 30 days
  across the Connected Folders and the top of Desktop, Documents, and
  Downloads, newest first, with where each lives; Return opens one and ⌘↑
  shows it in its folder. **Trash** follows it (see **Trash**). Then
  **Standard Folders** (Desktop, Documents,
  Downloads, Pictures, the home folder by the account's name, and iCloud
  Drive), then **Connected Folders**, each drawn as a folder in its own color
  with its chosen icon, then **Drives** (see **Drives**). A Standard Folder that is a Connected Folder appears
  only under Connected Folders. Each heading has a **+** at its far right:
  beside Standard Folders it adds any folder through the folder picker (kept
  on this computer only); beside Connected Folders it offers **New Connected
  Folder…** and **Connect Folder…**. Right-clicking a Standard Folder offers
  Show in Finder, **Connect This Folder**, and, for one added with +, Remove
  from Sidebar. A Connected Folder's dot pulses while its Worker runs and
  turns green when a Chat has a reply nobody has read; the same dots mark
  History's Chat rows and the History tab.
- **Update indicator:** while an update needs the person, the foot of the
  sidebar holds one button with a dot in the window's accent. The foot sits
  below the scrolling lists, in a band level with the path bar. It shows one
  of these:
  - **Update Available** with the version. A click downloads the update, and
    AmpleFile then restarts into it on its own.
  - **Downloading** with its progress. A click opens Settings → About.
  - **Restart to Update**. A click installs it now.
  - **Restarting to Update** while AmpleFile quits.
  - A quiet **Update Failed** when a download, staging step, or install
    failed. A click opens Settings → About, which has the detail and
    **Retry**.

  A click either uses the same updater action as Settings → About's update
  button or opens About. Before any update that ends in a restart, from
  either place, AmpleFile asks **Restart AmpleFile to Update?**. The question
  names the Worker Chats that are working, with their Connected Folders, and
  says when the AmpleFile Agent is working. It says that restarting stops
  that work, which is not run again, and that queued messages are dropped.
  Cancel does nothing.

  A failed check, with nothing being updated, appears only in Settings →
  About, and retrying it only checks again. During a check the indicator
  keeps what it showed before. A screen reader hears when an update becomes
  available, becomes ready, or fails. At the sidebar's narrowest the label
  shortens (Update, Restart, Restarting, Failed). While AmpleFile is up to
  date or has no updater, the sidebar shows nothing there. **AmpleFile >
  Check for Updates…** and Settings → About are where to check.
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
- **Other folders:** any other folder on the computer opens in the window
  too, as a plain folder under the Standard Folder rules: no Worker,
  History, or `.amplefile/` record, deleting is **Move to Trash**, and
  anything a Connected Folder owns is changed only from that Connected
  Folder. It opens from Go to Folder, the path bar, Command-Up, or a folder
  handed to AmpleFile (Finder's open-file, a desktop launcher, or a second
  launch); a file opens its folder with the file selected. The host resolves
  every path to where it really is, then to the place that holds it: inside
  a Connected Folder (the deepest one) it opens there at that folder, inside
  a Standard Folder it opens in that Standard Folder, and anything else
  opens by its path from the disk, which the path bar names first. Opening a
  folder that is a Standard Folder shows that Standard Folder. An other folder
  has no sidebar row, so no row is highlighted; Back and Forward, the path
  bar, the toolbar's title, and the item count work as anywhere else.
  Nothing is registered and nothing is kept about it: the panel offers
  **Connect This Folder** for the folder shown (never for the
  disk itself), at the panel's foot. The path policy is the same as everywhere: no path through
  a symbolic link (a link can be the item an action acts on, never a folder
  a path goes through), and `.amplefile/` and `.pi/` stay hidden. The
  window never goes into `/System/Volumes/Data`, where macOS gives every
  folder on the data volume a second name that is not a link (through it a
  Connected Folder would open as a plain folder): Go to Folder, Finder, a
  folder added to the sidebar, and a folder connected by that name all use
  its usual one, and search and folder sizes never walk into it. The disk's top
  lists its links (a Mac keeps `/etc`, `/tmp`, and `/var` as links into
  `/private`; Linux keeps `/bin` and `/lib` as links into `/usr`) as
  **Symbolic links** describes. A folder the
  account may not read says so (on a Mac, as for Desktop or Documents, with
  where to allow it).
- **Drives:** the sidebar's last section starts with the computer's own disk
  (**Macintosh HD** on a Mac, **File System** on Linux), the top of the file
  system, then every mounted drive the host lists, by name; hovering one
  shows its free and total space. Each opens in the computer place at its
  mount path, so it follows the other-folder rules. An ejectable drive has an
  **Eject** button beside it. Ejecting a drive takes its whole disk, so
  everything else mounted from that disk leaves with it, shown in the list or
  not. While a Connected Folder on any of it has unfinished work, the host
  refuses before anything changes, and its reason names the drive, the
  Connected Folder, and the drive that Connected Folder is on. The check
  also follows linked ancestors of registered roots. While a file
  on the drive itself is in use, the Mac refuses and nothing changes. While a
  file on another drive of the disk is in use, the Mac has already unmounted
  the drive that was asked for when it refuses: the reason names the drives
  the disk holds, and the list shows what is left. The window shows each
  reason as it is. When the Mac cannot say which disk a drive is on, the host
  treats it as sharing the disk rather than risk ejecting it under running
  work. A drive coming or going updates the list on its own, and ejecting the
  drive shown goes back to where the window opened. A drive that has stopped
  answering (a share whose server has gone) stays in the list without its
  space, and the host does not ask it again until it has answered. The host
  reads this computer's own list of mounted drives; nothing about a drive
  leaves it.
- **Trash:** the sidebar's **Trash** shows the computer's Trash in the list
  area: what was moved to the Trash from any app, this window's Standard
  Folders and other folders included, with Name, Original Location, Date
  Deleted, and Size, newest first and sortable. A line above the list says
  how it differs from AmpleFile's own Recently Deleted (in Settings), which
  holds what AmpleFile removes from Connected Folders. **Put Back** returns
  the selected items where they were (a taken name gets " copy"; nothing is
  replaced) and its notice's **Show** opens the folder with the item
  selected. **Delete Immediately** (or Delete, or ⌘⌫) and **Empty Trash**
  delete for good: each first asks in a dialog that names what will be lost
  (the item, or how many items and how much space, drives' Trash folders
  included) and says it cannot be undone, and nothing is deleted without a
  yes. While Empty Trash or Delete Immediately runs, the view says
  **Emptying the Trash…** (or **Deleting…**), and one that takes a moment
  shows its progress with **Stop** in the operations area, as a copy does;
  after Stop the notice says how many items were deleted and how many are
  still in the Trash. The list is read again each
  time it is shown, when the window comes back, and when this window moves
  something to the Trash. Search filters it by name. On a Mac the list needs
  Full Disk Access and says so when it is missing; macOS keeps no record of
  where an item came from that AmpleFile can read, so Put Back there points
  to Finder and the rest works. There a drive's Trash is read from a disk,
  never from a network share, and the list and the Empty Trash result name
  drives whose Trash could not be checked; their items stay where they are.
  On Linux it is the freedesktop.org Trash of the home folder and of each
  mounted drive ([Linux build](linux-build.md#sidebar-and-desktop)).
- **Contents:** list and icon views, sortable columns (Name, Date Modified,
  Size, Kind), Finder keys (arrows, Shift and Command selection, Space for
  Quick Look, Command-Down to open, Command-Up for the enclosing folder
  (from the top of a place, the folder above it, down to the disk),
  Command-Delete, Return to rename, typing to jump to a name, and the
  Copy, Cut, Paste, and Duplicate keys under **Finder's file actions**).
  Double-click opens a folder here and a file in its default app; an
  archive opens in its default app too, and **Extract** is in its menu; a
  Mac package (see **Packages**) opens in its app. Dragging from empty
  space, or in the list from a row outside its icon and name, draws a
  selection rectangle that selects what it touches; Shift or Command adds
  to the selection, and the list scrolls while the pointer is near its top
  or bottom edge. Right-click uses the native menu. Icons or List and the
  sort are remembered for each folder on this computer: a Connected Folder's
  folders by its portable id and the path inside it (so a moved Connected
  Folder keeps its views), any other folder by its path on disk. A folder
  never set shows the last choice made anywhere. The window keeps a few
  hundred folders and forgets the least recently set first; nothing is
  written into a folder. Show Hidden Files stays one choice for the window.
- **Folder tabs:** the window holds folder tabs, as Finder and GNOME Files
  do. Each tab has its own folder, Back and Forward, selection, scroll
  position, search, and whether it shows the Trash or Recents; going to
  another folder in a tab starts that tab fresh there. **New Tab** (⌘T,
  Ctrl+T) opens one right after the tab in front, at what it shows. **Open in
  New Tab** (and **Open in New Window**) is in a folder's menu and in the sidebar's menus; ⌘-click
  (Ctrl-click) a sidebar place, or ⌘-double-click (Ctrl-double-click) a
  folder, opens it in a new tab in front, and a middle click opens it in a
  new tab behind. The next and previous tab are Ctrl+Tab and Ctrl+Shift+Tab,
  ⇧⌘] and ⇧⌘[ on a Mac, and Ctrl+PageDown and Ctrl+PageUp elsewhere. **Close
  Tab** (⌘W, Ctrl+W) closes the tab in front (the browser tab in front while
  the Browser pane has the keyboard) and closing the last one closes that
  window alone, which leaves AmpleFile and its other windows running. The strip sits at the top of the
  folder area and shows once there are two tabs, or always with **View → Show
  Tab Bar**. A tab's title is its folder's name (the place's own name at its
  top, **Trash**, or **Recents**); two tabs on different folders of the same
  name each add as few of the folders above as tell them apart, as **Notes —
  Lab** and **Notes — Work**, and the full path is its tooltip. Tabs reorder
  by dragging; items dropped on a tab move or copy into its folder under the
  same rules as dropping on the list, and items held over a tab bring it to
  the front. The tabs, their folders, Back and Forward, and the one in front
  come back when the window reopens, from this computer only, each window
  with its own. The panel
  follows the tab in front: its Info, History, and message box are for that
  tab's folder, and each tab keeps its own open Chat. A Chat in a tab behind
  stays open out of sight, so its reply goes on and shows where it was;
  closing a tab closes its Chat without stopping a reply, which keeps running
  and stays in the Connected Folder's History. Copies, moves, and the other
  operations in progress belong to the window and keep running when the tab
  that started them closes. The Browser pane and its web tabs stay one set
  for the window.
- **Thumbnails:** icon view shows a picture's or a PDF's first page in its
  tile (PNG, JPEG, GIF, WebP, BMP, AVIF, and PDF; SVG, HEIC, TIFF, RAW, and
  video keep their icons), drawn by the host from the file and cached by its
  size and date, so a changed file gets a new one. Only the tiles near the
  view ask, a few at a time with the ones in view first, and a tile scrolled
  away withdraws its request; anything the host cannot draw keeps its icon.
  The list keeps icons.
- **Folder sizes:** Info measures the folder it describes (a selected folder,
  or the folder shown) when it is shown, saying **Calculating…** meanwhile,
  then its size and how many items it holds, with **Recalculate**. The host
  stops after 10 seconds or a million items; then Info says "At least …" and
  "More than … items" and why, and says so when some items could not be read
  or a drive is mounted inside (not counted). Links are not followed, and
  AmpleFile's and Pi's hidden folders are left out. A folder measured this
  session shows its size in the list's Size column too; the list never
  measures the folders it merely shows. The disk itself is never measured.
- **Big folders:** a folder lists completely up to 200,000 items; one that
  holds more shows 200,000 of them with a note that some items are not
  shown. Only the
  rows (or rows of tiles) in view are drawn, so a folder of 100,000 items
  opens in about the time the host takes to list it and scrolls smoothly;
  selection, the keys, the selection rectangle, and screen readers' row
  counts cover every item, drawn or not.
- **Dragging:** files and folders drag alike. Dragging a selected item
  drags the whole selection, and an unselected item drags alone: out to
  other apps, or onto a folder row or a sidebar place in the window, where
  they move as a move by paste does (a move between places follows the
  rules under **Finder's file actions**, with the same refusals and History
  restore points). Items dragged in from Finder are copied into the folder
  shown, or the folder row they are dropped on; in a Standard Folder or an
  other folder that needs the desktop app, which knows where they are.
  Nothing drops into itself or a folder inside itself, nothing drops into a
  link, and a nested Connected Folder never drags. A link drags as the link
  itself. A drop whose names are taken asks first, as a paste does.
- **Show Hidden Files:** the View menu's **Show Hidden Files**, ⇧⌘. on a
  Mac and Ctrl+H on Linux, shows what the system file manager hides (names
  starting with a period, Finder's custom-icon file, and on a Mac the home
  folder's Library and, at the disk's top, the Mac's system folders such as
  `usr`, `private`, and `Volumes`), dimmed, in every Connected Folder, Standard Folder, and
  other folder, the disk's top included; turning it off hides them again. It
  is one setting for the window, kept on this computer like the view, and
  the menu's check mark follows it. `.amplefile/` and `.pi/` never appear.
- **Symbolic links:** a link is listed by its own name with a small arrow on
  its icon, and its Kind says what it points to (**Link to Folder**, **Link
  to PDF document**, or **Broken Link**); Info shows the item it points to as
  **Original** (or **Missing**). Opening a link to a folder goes where that
  folder really is, as if its path were typed in Go to Folder; opening a
  link to a file opens that file in its default app; a broken link says so
  and opens nothing. **Show Original** goes to the folder holding the item
  it points to, with that item selected. Everything else acts on the link
  itself, never on what it points to, a broken link included: Rename,
  Delete (Move to Trash in a plain folder), Copy, Cut, Duplicate, Move, and
  Compress, and dragging it. A copied or moved link is made again as a link
  pointing where it did (a relative link is kept as written, so it can read
  as broken in its new folder); Compress stores it as a link, and Extract
  makes a link again when it points inside what Extract made. History keeps no
  copy of a link, so a link deleted in a Connected Folder waits in Recently
  Deleted, and History's restore point undoes its rename or move. Nothing
  is ever written through a link or into a linked folder: a link is never
  a folder a path goes through, so New Folder, Paste, a drop, or adding
  files into one is not offered, and the host refuses each. Attaching a
  link to a Chat is not offered. Where the desktop has no Quick
  Look (Linux), Space opens the window's own **Preview** of the selected
  file instead: a panel over the window that follows the selection as the
  arrow keys move it and closes with Space, Esc, or its close button. It
  shows text, images, and PDFs from the place's own `file-preview` and
  `raw-file` routes ([Linux build](linux-build.md#sidebar-and-desktop)).
- **Packages:** on a Mac, a folder Finder shows as one item is one item
  here too: an app (`.app`), a bundle or plug-in, an installer package
  stored as a folder, a Photos, Music, or TV library, an iMovie, Final Cut
  Pro, Logic Pro, or GarageBand project, a Keynote, Pages, or Numbers
  document, an `.rtfd`, an Xcode project, workspace, or playground, a sparse
  bundle, and the like (`src/shared/mac-packages.ts`; a `.framework` is a
  plain folder, as in Finder). The host marks them, and links to them, in
  every listing on macOS only. Double-click, ⌘↓, and Open open one in its
  default app through the same path a file takes, so an app launches; a
  link to one, as `/Applications/Safari.app` is, opens the app it points
  to. That path asks macOS to open it as a Finder double-click does, so
  Gatekeeper checks an app marked as downloaded, one Extract made from a
  downloaded archive included, before it first runs. Its menu offers **Show Package Contents**, which goes inside, and no
  New Folder, Paste, Open in New Tab, or Connect This Folder; a drop on it
  lands in the folder shown. Its Kind says what it is (**Application**,
  **Pages document**, **Photos library**). Copy, move, Compress, drag,
  search, and Info's size treat it as the folder it is.
- **Finder's file actions:** ⌘C copies the selection, also onto the system
  pasteboard so Finder or a Linux file manager can paste it; ⌘X cuts it:
  the items stay where they are, drawn dimmed in every window, until ⌘V in
  any window moves them, under the same rules as a move by paste in the
  window that cut them. ⌘V pastes what was copied or cut here, in another
  window, or in Finder (the desktop process reads the pasteboard and pastes;
  the window never reads the clipboard); ⌥⌘V moves what was copied; ⌘D
  duplicates. A paste that asks about taken names first then carries
  exactly what it asked about: if the pasteboard changed while the question
  was open, the paste is refused and says to paste again. A Mac's
  pasteboard has no Cut marker, so ⌘X puts the files there as Finder's Copy
  does, and the desktop app remembers the Cut by exactly what it put there.
  On Linux a Cut carries the marker GNOME Files and Dolphin use, so a Cut
  made there pastes here as a move and the reverse
  ([Linux build](linux-build.md#sidebar-and-desktop)), and the desktop app
  remembers its own Cut by the files it put there.
  The Cut is forgotten, and no window draws it any more, once it is pasted;
  once **Esc** cancels it (with nothing selected, in a folder that shows a
  cut item); once any of its items is no longer where it was cut (renamed
  or deleted since, or moved by a paste that failed or was stopped partway);
  each of these leaves nothing to paste. On a Mac and on Linux it is also forgotten once
  the pasteboard holds something else: a Copy here, text, or anything
  another app copies. Finder, or a Linux file manager that marks its Copy,
  copying the same files afresh is a Copy of
  them, never the Cut, and pastes as a copy. Elsewhere the clipboard holds
  the items' paths as text, and the Cut lasts while it still does, so
  forgetting a Cut never empties text copied since. A Copy of items, a Copy
  button, or a copied address here forgets the Cut at once; anything else on
  the pasteboard is noticed when a window comes to the front or at the next
  paste. The Edit menu's Cut, Copy, and Paste do the same while the folder
  list has the keyboard.
  The right-click menu (the native menu on the Mac, the window's own with
  the same items elsewhere) adds Copy, Cut, Duplicate, Compress, **Extract**
  for an archive, New Folder with Selection, and Paste Here. Files dropped
  on a sidebar place go to its top.
  - **Progress and Stop:** a copy, move, paste, drop, Duplicate, Compress,
    or Extract that takes more than a moment shows in an operations area at
    the foot of the folder, above the path bar: what it is doing, its items
    and bytes, the item in hand, and **Stop**. A quick one never shows. The
    window stays usable meanwhile, and several run at once. Stop ends at the
    next safe point and the notice says what was done and what was not: the
    finished items stay (with their restore point), the item in hand is
    taken back, and the rest are not done; a stopped move between places
    keeps the items that had already left their source where they went, and
    the rest stay where they were, with any copy made of them across disks
    taken back (the notice names a copy that could not be). A stopped
    Compress or Extract makes nothing.
  - **Taken names:** when a copy, move, paste, drop, or Extract would land
    on names already taken, the window asks once, before anything is
    written: one clash at a time, both items' kind, size, and date, and
    **Keep Both** (the " copy" name), **Skip**, **Replace**, or for two
    folders **Merge** (with what to do about same-named items inside), with
    **Apply to All** while more wait, and **Stop**, which does nothing.
    Apply to All never replaces a folder with a file or a file with a
    folder; those are replaced only when chosen for that item. Duplicate
    always keeps both with the " copy" name. An item that is, holds, or sits
    in a nested Connected Folder is never replaced or merged into.
    **Merge** puts a folder's items into the folder already there, and its
    answer about same-named items inside is that folder's own: each one,
    however deep, is kept beside the item there, skipped, or replaces it
    under Replace's rules, and folders of the same name inside are merged
    the same way. Two folders merged in one operation each follow the answer
    given for them, and a Merge applied to all gives its answer to every
    folder it merges. The question is asked when the folders hold same-named
    items. Extract asks without a count because its check reads only enough
    to identify the item that will land. A folder whose items were all skipped is
    left as it was. After a
    Replace the notice says where the old item went: History keeps it in a
    Connected Folder (⌘Z brings it back), Recently Deleted holds what
    History could not keep, the system Trash takes it in a plain folder, and
    where no Trash can take it, it is gone and the notice says so.
  - **History and Undo:** every change keeps a History restore point in
    each Connected Folder it touches (a Standard Folder has none), and ⌘Z and
    ⇧⌘Z undo and redo the last file change. A move inside one Connected
    Folder, and every copy, is undone through History. A move between
    places, or between plain folders, is undone by moving the items back:
    each to the folder it came from, under the name it had, and a folder a
    merge emptied and removed is made again. A plain folder has no History,
    and an item renamed out of a Connected Folder is the item itself, with
    things History does not keep, so it is moved back, never made again
    from a restore point. That is a move of its own with the rules under
    **Moves**, so putting items back out of a Connected Folder waits for
    its unfinished work; ⌘Z then says so and keeps the step for when the
    work is over. That is the one case in which a step stays: anything else
    that fails is said once, in plain words, and the step ends, so an item
    that can never go back does not block the changes made before it.
    ⌘Z never says it undid a move when an item did not go back. An item
    that is no longer where the move put it (renamed or removed since) is
    named, and the others still go back. An item whose name is taken by
    now in the folder it came from is not put back: it is never given
    another name and never put in place of what is there, it stays where
    the move put it, and ⌘Z says so by name, with where it is. So it says
    of an item whose move back failed, of one that went back but is also
    still where the move put it, and of one that went back except for a
    part that could not be removed. What the move replaced in the target
    Connected Folder comes back from that folder's restore point, which
    also takes away a copy that stayed in both places. That restore point
    is run only when every item went back cleanly and the original of each
    retained copy still holds its contents, checked byte for byte along
    with modes, links, and the Mac metadata the copy holds. Otherwise ⌘Z
    keeps the copy and says History has the restore point. A copy the move left in a plain
    folder, of an item that never left its source, has no History to take
    it away: it stays, and ⌘Z says so. ⇧⌘Z does such a move again, for the
    items that went back, unless the move replaced something or merged
    folders. When a Replace sent something to the Trash or it is gone, ⌘Z
    says plainly that it cannot bring it back, and so it does when a move
    left only copies in a plain folder because nothing could leave where it
    was.
  - **Moves:** a move inside one Connected Folder is History's move. A move
    between plain folders (Standard Folders, folders added to the sidebar,
    and any other folder) is a plain move, as Finder's. A move between
    places (two Connected Folders, or a Connected Folder and a plain
    folder) takes each item out of its source under that place's rules and
    leaves a receipt for each. Out of a Connected Folder that is its
    delete, with the delete's receipt and a restore point for what leaves;
    the move refuses, before anything changes, while that Connected Folder
    has unfinished work (a running turn or a question waiting on an
    answer), and for an item that is, holds, or sits inside a nested
    Connected Folder, whichever way that one's path was written when it was
    connected (another letter case, an accent spelled the other way, or
    through a linked folder). Into a Connected Folder the arrivals get a
    restore point there, and a Replace waits for that folder's unfinished
    work, as any Replace there does; an item replaced in a plain folder
    goes to the system Trash. A plain original leaves only while no
    Connected Folder owns it or sits inside it, compared by its path as
    written and as the disk resolves it, so another letter case, an accent
    spelled the other way, or a linked folder on the way names the same
    Connected Folder; that is checked before anything changes and again as
    the item goes, inside the journaled step. Nothing goes to the Trash for
    having moved: the item is not deleted, it is in the other place. A copy
    leaves a folder's `.amplefile/` behind; a move carries it, so a
    disconnected Connected Folder keeps its identity and Chats. A plain
    folder has no Worker, so nothing there is waited for. Items taken in
    one move from more than one Connected Folder, or from a Connected
    Folder and a plain folder together, are copied, and the notice says the
    originals stay.
    - **On one disk, the item is renamed.** It goes at once and whole, the
      same item under the other folder, with everything it has: its
      resource fork, Finder tags and comments, a download's quarantine mark,
      its access rules, flags, and dates. Nothing is copied, so nothing is
      checked, nothing is in two places, and nothing is set aside in
      Recently Deleted. An item that cannot leave its folder (the folder,
      or the item when it is a folder, cannot be changed) stays where it
      was, whole, and the others still move.
    - **Across disks, it is copied, and then the original goes.** An item
      History could not keep all of, where the copy did not carry the rest
      or the rest is a Connected Folder's identity, leaves its Connected
      Folder whole, for Recently Deleted, with whatever it holds by then.
      Every other original is erased, and only while all of this holds. It
      is still exactly the item the copy read: the same entries, each the
      same file at the same size, modification time, and change time as
      when its bytes were read (a file read within one tick of a disk's
      coarse clock, as FAT's two seconds, is compared with its copy byte
      for byte instead), every link pointing where it did, nothing added
      and nothing gone. The copy holds all of it (every folder, every file
      at the same size and date, every link, and any `.amplefile/` it
      carried). No folder in it that holds something, nor the folder it is
      in, is read-only, so that all of it can go; AmpleFile never widens an
      original's permissions to remove it. And the copy lacks nothing else
      the original has: see **What a copy carries**. The checks leave out
      `.DS_Store` inside a folder. Finder uses it to remember the folder's
      window settings. All of this is
      checked before the copy replaces anything; that the original is still
      what the copy read is checked again as it goes, and for a plain
      original so is that all of it can go. A locked file is not seen
      before its removal is tried.
    - **When an original across disks cannot go.** It stays where it was,
      whole, and its copy stays too, so the item is in both places and the
      notice names it and why; the copy then drops the `.amplefile/` the
      source still holds, and the move names any it could not drop. A copy
      that was to replace an item replaces it only once the checks have
      passed: when they refuse, the item there stays, the copy is taken
      back, and the original is only where it was. The other items still
      move. Removing a folder is not all-or-nothing, so when a removal
      fails the original is looked at again before anything is said: if
      part of it went, the item is said to have moved, because all of it is
      now only in the target, the notice names what is left where it was,
      and ⌘Z moves the item back rather than taking the copy away. An
      original that is already gone when its turn comes has nothing to
      remove; the item is where the move put it.
    - **What a copy carries.** A copy made by AmpleFile (Copy and Paste,
      Duplicate, a drop from Finder, and the copy a move across disks
      makes) carries each file's contents, permissions, and modification
      date, each folder's permissions and modification date, and each link
      as it is. It does not carry extended attributes (a resource fork,
      Finder tags and comments, a custom icon, a download's quarantine
      mark), access rules, the flags that hide or lock an item, or creation
      dates. So a copy of a text clipping is empty, and a copy of a tagged
      file has no tags; the original has them still. A move must not lose
      them, which is why it renames on one disk, and why across disks an
      original stays where it was, with the reason, when it has an extended
      attribute or a hide or lock flag its copy lacks, when it has a Mac
      access control list, or when its extra metadata could not be read.
    - **Where items go.** Nothing is copied, moved, compressed, or extracted
      into a nested Connected Folder named through its parent, or into a
      folder inside one: the window opens a nested Connected Folder as
      itself, and a request that names it through its parent is refused.
  - **Compress and Extract:** Compress writes the archive beside the items
    under a hidden working name, at any size (with the 64-bit zip records a
    large archive needs) and with each item's Unix mode, and stores a link
    as a link; it refuses to start, and stops, when the disk would keep less
    than 256 MB free. **Extract** works as Finder's Archive Utility does: a
    `.zip`, `.tar`, `.tar.gz`, or `.tgz` whose whole content is one file or
    one folder, of any name, gives that item beside it, so Compress then
    Extract gives the item back; an archive of several items gives a new
    folder beside it named after it, never with a leading dot
    (`.agents.zip` gives `agents`). An archive whose one item is a link, a
    hidden item (`.env`, `.agents/`), or a file or folder named as Pi's
    project instructions (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`),
    and an empty archive, give that folder too, so nothing hidden or read as
    instructions lands straight in the folder unseen. Names are compared as
    a Mac volume compares them, so a look-alike (`agentſ.md`) counts, and
    once extracted the volume is asked again whether the one item opens as
    an instructions file. The resource forks and attributes a Mac stores
    beside each item (Archive Utility's `__MACOSX`, and a `._Name` file that
    is AppleDouble or sits beside its `Name`, as a Mac's `tar` writes them)
    and what Extract leaves out are not items and are not written; any other
    `._Name` file is an ordinary file. It works at any
    size and, when done, selects the item or folder it made; a taken name
    asks the name-clash question about that name (reading only enough of
    the archive to know it, and no more than 64 MB of a tar, past which a
    first item is taken as the one item; should more follow, they land in
    the folder named after the archive, keeping both names); it is the
    archive's menu item, and double-clicking an archive still opens it in
    its default app. On a Mac, an archive marked as downloaded passes that
    quarantine mark to everything Extract makes before it takes its name,
    as Archive Utility does, so an app from it gets Gatekeeper's first-open
    check; if the mark cannot be read or carried, nothing is extracted. A
    package (see **Packages**) stays whole. A Merge of its enclosing folder
    keeps a same-named package beside it, or skips it when the inner choice
    is Skip. When Extract makes a package at the top level, the name-clash
    dialog omits Merge.
    Nothing extracted is runnable beyond the execute bits the archive
    records (never setuid, setgid, or sticky); a link is made only when it
    points inside what Extract made (inside the one folder, when that is
    all the archive holds). A Merge keeps links whose targets stay inside
    a folder that arrives whole and reports the other links as skipped.
    Hard links, special files, `.amplefile/`,
    `.pi/`, and `.work-fold/` entries (and any name a Mac volume would take
    as one of them, such as `.ampleﬁle`), and entries that would land
    outside are left out or refused; and the same 256 MB disk guard applies. A
    damaged or password-protected archive says so.
- **Path bar and Go to Folder:** clicking an item in the path bar copies its
  path; double-clicking a folder opens it, above the place's top too, where
  it lives (see **Other folders**); a long path keeps the disk and its
  last four items whole with "…" between. The button at the bar's start, or
  ⇧⌘G, opens Go to Folder as Finder has it: a path field (a full path, "~/…",
  or a name inside the folder shown) over the names that complete it; Tab
  completes, the arrow keys choose, Return goes, and a file's path opens its
  folder with the file selected. It opens any folder or file on the
  computer, completes names in any folder, and says so plainly when nothing
  is at the path or it is hidden AmpleFile or Pi data.
- **Search** reads names and contents. A scope bar offers **All Connected
  Folders** (while any exist) or the folder shown; results list name
  matches, then text matches with the words around them, in Name, Match, and
  Connected Folder columns. In a Standard Folder or any other folder the
  host's folder search reads names and file text below the folder shown, in
  the same list with a Where column; hidden items are searched only while
  Show Hidden Files is on. It reads a bounded amount at a time: when it
  stops early it says so ("Search stopped after a few seconds, having read
  20,000 files.") with **Keep Searching**, and it says when some folders
  could not be read. Connected Folders inside are left to their own search,
  which applies their rules, and the results say so with **Search All
  Connected Folders**. Selection is accent-colored while the contents have
  focus. Where a Worker exists (in a Connected Folder, or searching all of
  them), the last row of results asks the Worker to find it by what the
  person remembers; Return with nothing chosen does the same.
- **Browser pane:** the built-in browser's tabs, under the folder's contents
  ([Built-in browser](built-in-browser.md#the-browser-pane)). The toolbar's
  **Browser** button opens it with a new tab and shows or folds it afterward;
  with no tab open the window has no pane. Its tab strip is always there
  while a tab is open, and two buttons at the strip's end share the area: a
  slider sets how much the folder and the browser each take, **Hide Folder**
  gives the page the whole area, and **Hide Browser** folds the browser down
  to its tab strip. The tabs belong to no Connected Folder: the sidebar and
  the panel keep the Connected Folder shown, so a Chat can be watched beside
  the page its Worker is using. A tab a Worker opens arrives as the strip
  alone, with the running dot; the page shows a **Worker in …** marker that
  opens that Chat. A site's question shows in a bar above the page with
  **Block** and **Allow**, and only the person answers it; with the page out
  of view, a notice offers **Show Page**. Pages show only here, and the
  window is there with or without a Connected Folder.
- **Right panel:** **Info** shows the selection (a picture or PDF shows its
  larger thumbnail, an SVG shows itself; files show Where, Modified, and
  Size; folders add their measured size, see **Folder sizes**), the Trash
  item chosen in the Trash, or, at a Connected Folder's top
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
  summaries. Outside a Connected Folder there is no Worker to message: the
  panel's foot says so and offers **Connect This Folder** for the folder
  shown (never the disk itself, or the Trash) and, with no AI connected,
  **Set Up AI…**.
- **Suggested messages:** push buttons above the message box, on Info only,
  that send at once: up to four, or two when the folder already has an
  Automation on. With AI connected, they are written by the Connected
  Folder's own model from the names in the folder shown and its recent Chat
  titles, kept for 30 minutes or until those change; plain ones cover a
  selection and the wait.
- **What the Worker changed:** after a Worker reply (an Automation's Chat
  step included), the files it added, moved, or changed carry a small dot in
  the list, and Info opens with a receipt ("The Worker changed 14 items · 3
  added · 9 moved · 2 changed") listing the first few, with **Undo** and
  **Done**. The receipt compares the turn's own "Before turn" and "After
  turn" restore points, so nothing changed after the reply (a paste, a move
  in, an edit) is counted as the Worker's. **Undo** puts back only those
  files, each only while it is still as the turn left it; a file changed
  again since stays as it is, and the notice says how many were kept. Undo
  takes its own restore point first, so ⇧⌘Z redoes it.
- **Set Up for Me:** right after a folder is connected, Info opens with a
  card at its top, **Set Up This Folder**, with **Set Up for Me** and **No
  Thanks**. Either answer closes the card for good; the card is the only
  place the window offers it ([Set Up for Me](#set-up-for-me)). With no AI
  connected, the card stays until Set Up AI is finished and the message is
  sent. A folder
  connected while the window is open brings the panel to Info, so the card
  is in view.
- **A message needs AI:** with no AI connected, sending from the message box,
  a suggestion, Organize, or Set Up for Me opens Set Up AI first and then
  sends.
- **Notices:** one card for everything the window says, errors included: an
  icon for its kind, the words, one action, and Close, stacked over the
  folder list. Errors stay longer and carry a red edge. A file operation
  still running shows instead in the operations area above the path bar, a
  row in the same card style with its progress and Stop (**Finder's file
  actions**).
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

### Windows

AmpleFile can show several file manager windows at once. **File → New
Window** (⌘N; Ctrl+N on Linux) opens another window at the folder the front
window shows, or at the home folder, a step down and to the right of it, so
two windows never sit exactly on top of each other. **Open in New Window**,
beside **Open in New Tab** in a folder's menu and the sidebar's menus, opens
that folder in a window of its own. **New Connected Folder** is ⌥⌘N (Ctrl+Alt+N).

- **Each window is its own:** its folder tabs (each with its folder,
  selection, and Chat), panel, Browser pane tabs, and size and place on the
  screen, and the Connected Folder it shows, which names the window in its
  title. The window's title, Open Recent, and **New Window** follow the tab
  in front; while that tab shows a plain folder, the computer, the Trash, or
  Recents, the window shows no Connected Folder and is titled AmpleFile. Every window sees the same Connected
  Folders, Standard Folders, drives, Trash, running Chats, running file
  operations, and Cut, so a change made in one (a rename, a new Connected
  Folder, a finished copy, items cut) shows in the others.
- **The front window:** the menus act on the window in front. A command goes
  to it, and the View menu's check marks and the items that need a Connected
  Folder follow it. A dialog, a native menu, or a site's question opens over
  the window that asked.
- **What windows share:** Icons or List and the sort remembered for each
  folder are one set for every window, so a folder looks the same in all of
  them. The last choice of view and sort (for folders never set), Show
  Hidden Files, and the panel and sidebar widths are kept on this computer:
  each window keeps its own while it is open, and a new window starts with
  the last one changed. The Connected Folder a window shows, its folder tabs,
  and how it left its Browser pane are kept for that window alone, so two
  windows never restore or overwrite each other's tabs.
- **Folders handed to AmpleFile** (Finder's Open, a launcher's argument, a
  second launch, a FileManager1 call on Linux) open in the front window, as
  they did with one window, so an app that asks again and again to show a
  folder never piles windows up. When one request names several folders (a
  launcher given several, `ShowFolders` with several), the first opens in the
  front window and each further one in a new window, as a system file
  manager does.
- **Browser pages** belong to the window that opened them; a page a Worker
  opens appears in the window whose tab in front shows that Worker's Connected
  Folder, else the front window ([Pages and windows](built-in-browser.md#pages-and-windows)).
- **Closing and quitting:** closing one of several windows closes only it.
  Closing the last window keeps AmpleFile and every accepted Chat turn,
  Automation, and file operation running; reopening AmpleFile (the Dock, the
  tray, launching it again) brings the window back. Quit, Restart to Update,
  and the "still running" notice keep their rules and wording: they count the
  work of every window, and the notice comes when the last window closes.
- **Coming back:** the windows open when AmpleFile quit come back at the next
  launch, each where it was. A window closed while others stayed open is
  forgotten; the last window closed keeps its place for the next one.

### First run

A fresh profile opens on a short first run: a
welcome that says what AmpleFile is, **Connect Your AI**, **Let Your Worker
Use Your Mac** when the app includes Computer Control or the command line
and something is not yet set up, and **Pick a Folder to Start
With**, which offers Desktop, Documents, Downloads, and Pictures in one
click beside Connect Folder and New Connected Folder. Every step has
**Browse Files**, which leaves the welcome for good and opens the file
manager at the home folder with nothing connected. Connecting a folder ends
it too. A folder handed to AmpleFile (a launcher, a second launch, or the
system's file manager request on Linux) is shown at once, first run or not.

With no Connected Folder the window is still a whole file manager: the
sidebar's Recents, Trash, Standard Folders, and Drives, every other folder,
Search, Info, Thumbnails, and folder sizes work as anywhere else; the
Connected Folders heading keeps its **+**, and the panel's foot offers
**Connect This Folder** and **Set Up AI…** where the message box would be.
Skills & Extensions, which belongs to a Connected Folder, says to connect
one first. Disconnecting the last Connected Folder leaves the window open,
at the home folder.

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

### Set Up for Me

**Set Up for Me** is offered once for each Connected Folder, on the card
Info shows right after the folder is connected, whichever way it was
connected: New Connected Folder, Connect Folder, Connect This Folder, or
first run. It starts a new Chat in the panel with one message, and the
included `set-up-connected-folder` Skill does the rest: it looks the folder
over, organizes it when that helps (moves and renames only, never deletes,
each through a restore-pointed `amplefile files` verb that refuses to
overwrite; a deliberate structure stays; projects, app-managed folders, and
hidden files are left as they are), writes the Connected Folder's Worker
instructions, and sets an icon and a color. The Chat's own reply says what
changed and how to undo it. The Skill is listed under **Everywhere** as
Included with AmpleFile; it can be turned off but not removed. A request in
any Chat uses it too: "set up this folder" for the whole pass, or asking
only for a look, which sets the banner, icon, and color and never touches a
file.

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
Line**, **File Manager** (Linux only), **Recently Deleted**, **Shortcut
Keys**, and **About**. Automations
carries **Limits**, collapsed by default under a disclosure; **Closing the
window** lives in Appearance → Interface; updates live in About. **Command
Line** adds the `amplefile` command to Terminal and writes the Skill for
Claude Code or Codex, so other AI agents can use AmpleFile
([details](amplefile-agent-and-cli.md#other-ai-agents-settings--command-line)).
**File Manager** lets other Linux apps use AmpleFile as the file manager, as
two separate choices: **Show Files from Other Apps** (AmpleFile answers
"show in folder" requests and is started for them) and **Open Folders with
AmpleFile** (the default folder app). Each shows the system's real state and
turns off from the same place, giving back what was there
([details](linux-build.md#amplefile-as-the-file-manager)).

**AI Models** groups per-scope model and Worker instructions separately from
shared provider connections. Its scope is chosen with two distinct cards,
**This Worker**, naming the Connected Folder, and **AmpleFile Agent**. The
model is a dropdown: closed, it shows the chosen model; open, it starts with a
search box and groups every connected provider's chat models by provider and
vendor (for OpenRouter, the vendor prefix of the model name), and choosing a
model closes it and saves immediately. **Provider Connections** sits below as a
compact list of connected providers (each expandable to inspect or manage) with
a **Connect Provider** drawer for available providers. Connection setup leaves
the active model selection alone, including Azure endpoint and deployment setup.
Unsaved instruction and Foundry drafts survive page and scope changes while
Settings stays open; credentials are not cached across scope changes. Accepted
saves keep their completion if Settings closes, so reopening waits for their
result. External settings changes refresh clean forms and offer an explicit
reload when drafts are present. An **Image Model** section holds one
machine-wide choice for every Worker and the AmpleFile Agent, with **Automatic**
first ([Image generation](image-generation.md)).

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
reads. **Codex Connection** selects the distinct **OpenAI (Codex)** entry; a
person signs in explicitly to that connection. Its details read the selected
workspace name and plan and the provider's actual usage windows, used
percentages, reset timestamps, and available reset count. Reads pin the
workspace header and refuse usage whose returned account id differs or is
missing. They never infer a workspace from email, a user id, an API
organization, or a client id, and never substitute a default workspace. No
reset is consumed by this display. Usage refreshes every minute while the
details are open and on window focus; **Refresh** also updates it without
changing the model. Fields not returned by a sign-in (such as workspace on a
direct OpenAI sign-in) are omitted; a failed read explains that account details
are unavailable. **Usage** opens the provider's usage page. Account details
stay in Settings, outside Chat, CLI snapshots, portable Connected Folder
records, and model prompts.

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

**Included tools.** The four included tools (Computer Control, Web,
Documents, and Service Connections) show observed readiness separately from
native loading. The Skills & Extensions dialog refreshes cold host status
automatically; opening it never launches a helper or connects a server.
Successful use can supply readiness evidence. A computer-permission check
stays visible as Last Check Passed with its timestamp, while Documents proof
belongs to the running build. Service Connections says No Connections or
Configured and leaves actual health to each connection. Check observes; helper repair is a separate
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
profile apart from any other browser on the Mac and from every Connected
Folder. It is how an agent uses the web interactively. The person sees
and uses the same pages in the file manager window's Browser pane, where they
sign in to a site and answer a site's question. The tools come with the app
and are not one of the four included tools. See
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
  View, Window, and Help menus. Each window's size and position, and the
  theme, are kept, and each window's renderer recovers from a crash on its
  own ([Windows](#windows)). File → **Refresh** (⌘R) reads the folder shown
  again in any place (a Connected Folder, a Standard Folder, the disk, or
  any other folder) with the sidebar's Connected Folders and Standard
  Folders; **New Chat** and **Skills & Extensions** wait for a Connected
  Folder.
- Closing one of several windows closes only it. Closing the last window
  keeps AmpleFile running; the Dock icon brings the windows back. **Quit**
  exits cleanly. Closing a window never stops an accepted turn.
- The menu-bar item opens the AmpleFile Agent popover on click; a right
  click opens a menu with **AmpleFile Agent**, **Open AmpleFile**, **Check
  for Updates...**, and **Quit AmpleFile**. View → **Toggle AmpleFile
  Agent** (⌘J) shows or hides the same popover from any window, with or
  without a Connected Folder. Files or links dropped on the
  icon become reference chips. The popover works with every window
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
    window. Emptying the computer's Trash, or deleting from it, is the
    person's own act in the window, after a dialog that says it is final;
    so is a **Replace** in a plain folder, whose old item goes to that Trash
    (or, when no Trash can take it, is removed and the window says so). Provider credentials are Settings acts with no agent or CLI verb,
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
- Browse Connected Folder, Standard Folder, and any other folder's files in a
  Finder-style file manager, with or without a Connected Folder, run
  Connected Folder Chats in the panel, and view History.
- Open drives from the sidebar and eject them; see free space; browse the
  computer's Trash with Put Back, Delete Immediately, and Empty Trash.
- See picture and PDF thumbnails in icon view and in Info, and measure a
  folder's size in Info.
- See and use the built-in browser's pages in the window's Browser pane:
  watch a Worker's page, sign in to a site, and answer a site's question.
- Search a Connected Folder by name and by content inside ordinary files and
  Chat transcripts, honouring ignore rules, skipping binary content, and
  saying when a bound stopped the search; search a Standard Folder or any
  other folder by name and file text, page by page.
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

- Show full-width Chats inside the file manager window.
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
- Offer Computer Control setup in a Chat the first time a Worker
  needs it; deepen accessibility, renderer interaction tests, recovery,
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
