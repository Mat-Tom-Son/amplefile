# Linux builds

AmpleFile has a Linux x64 preview lane producing DEB, RPM and AppImage
packages. [Linux test preview 0.2.1](https://github.com/Mat-Tom-Son/amplefile/releases/tag/linux-test-0.2.1)
uses a separate prerelease tag in the source repository. The public Mac release
and updater remain separate; Linux previews have no automatic update feed.
The build command itself never publishes.

The window fits its own display’s work area on startup and after display-scale
changes, including when restoring a placement from a larger screen. The Linux
title bar follows Appearance and contains the application menus; the sidebar does
not reserve space for Mac window buttons. First-run setup uses the Linux Computer Control surface.

## Title bar and desktop appearance

AmpleFile draws the whole Linux title bar itself: its name, the application
menus, and the window buttons, in the order and on the side the desktop's
button layout gives. GNOME's `org.gnome.desktop.wm.preferences button-layout`
is read through the XDG settings portal (GNOME's default draws Close alone, on
the right); on KDE Plasma, kwinrc's `ButtonsOnLeft` and `ButtonsOnRight` are
read instead. Only Minimize, Maximize (Restore while maximized) and Close are
drawn; app-menu, icon and spacer entries are left out, and an empty layout,
common on tiling desktops such as niri, draws no buttons. Without a portal or
a layout, the three buttons appear on the right. The buttons are ordinary
keyboard-reachable buttons that follow Appearance's light or dark, dim when the
window is in the background, and show the accent in their focus ring; the rest
of the bar still drags the window.

The settings portal's `org.freedesktop.appearance` keys also apply: the
desktop's accent color is the Device Accent in Settings → Appearance (as the
system accent is on a Mac), its light or dark preference decides the System
mode (Electron on Linux would otherwise take light or dark from the GTK theme,
which need not match), and its high-contrast setting turns on More Contrast.
Changes apply immediately. AmpleFile reads the portal with GLib's `gdbus`; one
`gdbus monitor` process follows changes and ends with the app. Without
`gdbus`, a portal, or a key, each setting keeps its earlier behavior: no
device accent, the GTK theme's light or dark, and normal contrast.

**File** has New Tab (Ctrl+T, a folder tab at the folder shown), Close Tab
(Ctrl+W: the folder tab in front, or the browser tab in front while the
Browser pane has the keyboard, as ⌘W does on a Mac; closing the last folder tab
closes the window), Close Window (Shift+Ctrl+W, which keeps AmpleFile running)
and Quit (Ctrl+Q). **View** has Show Tab Bar, Show Previous Tab (Ctrl+PageUp),
and Show Next Tab (Ctrl+PageDown), as GNOME Files has them; Ctrl+Tab and
Ctrl+Shift+Tab change folder tabs too. A middle click on a folder or a sidebar
place opens it in a new tab behind the one in front
([Folder tabs](product-model.md#the-file-manager-window)). **Edit** has Paste and Match Style (Shift+Ctrl+V), which pastes text
without its formatting.

## Build and run

Use Node 24, npm 11.16.0 or newer, Rust/Cargo, a C/C++ toolchain, Clang,
pkg-config, and the development headers for GStreamer, libei (1.2 or newer),
and libxkbcommon. Build on a Linux x64 system with glibc 2.39 or newer.
The bundled Rust dependencies have locked versions and retained licenses.
Install `xvfb-run` and `xauth` as well. The build runs its real sandboxed Electron
probes on a private X display, separate from the person's desktop.
Fedora build hosts also need `libxcrypt-compat` for the packager's bundled Ruby;
this is a build dependency, not an application runtime dependency.

```sh
npm ci
npm run check
npm test
node scripts/test-linux-native.mjs
npm run desktop:make:linux
```

`out/linux` holds `AmpleFile-VERSION-linux-amd64.deb`,
`AmpleFile-VERSION-linux-x86_64.rpm` and `.AppImage`,
the unpacked application, `linux-build.json`, and `SHA256SUMS`.
Use `npm run desktop:make:linux -- --dir` for an unpacked diagnostic build.
Existing installer candidates are not overwritten. Move the earlier artifacts
to an archive before rebuilding the same local version.

On Fedora, install the RPM with `sudo dnf install ./AmpleFile-VERSION-linux-x86_64.rpm`.
On Ubuntu, install the DEB with `sudo apt install ./AmpleFile-VERSION-linux-amd64.deb`.
The installer adds the `amplefile` command without replacing another owner's
command. Both packages recommend GNOME Keyring for credential storage, a weak
dependency that a KWallet desktop can decline. On Ubuntu 24.04 and Debian 13
the DEB's audio, GTK and accessibility dependencies also accept the renamed
64-bit-time libraries (`libasound2t64` and others). Uninstall preserves Connected Folders, Pi resources and app data.
AppImage runs without libfuse2; desktop libraries and a functioning Chromium
sandbox are still required. The app refuses `--no-sandbox`.

Linux app data lives in `$XDG_CONFIG_HOME/AmpleFile` (normally
`~/.config/AmpleFile`). Development uses `AmpleFile Development`. The isolation
variables in [Development](development.md#development-state-and-model-access)
also apply on Linux. Provider and Service Connection credentials require a real
libsecret or KWallet backend; Chromium's `basic_text` fallback is refused.
Outside KDE/Plasma, startup explicitly selects the standard Secret Service
backend so desktops such as niri, Sway and Hyprland can use their running keyring.
KDE/Plasma retain Chromium's native KWallet selection; an explicit
`--password-store` choice is respected. Start and unlock GNOME Keyring,
KWallet or another Secret Service implementation before signing in. If it was
started after AmpleFile, quit and reopen the app. No credentials are saved
using Chromium's plaintext fallback.

## Sidebar and desktop

Standard Folders read `$XDG_CONFIG_HOME/user-dirs.dirs`, falling back to
`~/.config/user-dirs.dirs` and conventional directory names when no setting
exists. Desktop, Documents, Downloads and Pictures follow their configured
locations. A directory pointed at the home folder is disabled and omitted;
the home folder has its own row. The path bar names the root **File System**. Only existing directories are listed, and
iCloud Drive is Mac-only. The parser reads data without evaluating shell code.
See the [XDG user directories contract](https://wiki.freedesktop.org/www/Software/xdg-user-dirs/).

The window speaks Linux: Ctrl instead of ⌘ in shortcuts and hints, "this
computer" instead of "this Mac", **Show in File Manager**, and "your file
manager" where the Mac app names Finder. **View → Show Hidden Files** has
GNOME Files' key, Ctrl+H; on Linux it shows names starting with a period
(GNOME's `~` backups and `.hidden` lists are always shown). The window owns
the key, so it works in the browser preview too, and the menu shows it with
a check mark. Right-clicking an item opens the window's own menu with the
same items as the Mac's native one (Copy, Cut, Duplicate, Compress, Extract
for an archive, Paste Here, Rename, Move to Trash or Delete). A link's menu
adds Open (not for a broken link), **Show Original**, **Show in File
Manager**, and **Copy Link Path**, and its other items act on the link
itself. Dragging items out hands the desktop every selected file, folder,
and link at once. Deleting in a Standard Folder or any other folder moves
items to the desktop's Trash (a link goes there as itself); in a Connected
Folder, History brings them back, and a link, which History keeps no copy
of, waits in Recently Deleted. An item a Replace takes the place of in a
plain folder also goes to the desktop's Trash, through Electron's
`shell.trashItem`.

The sidebar's **Trash** is the [freedesktop.org Trash](https://specifications.freedesktop.org/trash-spec/latest/):
the home Trash in `$XDG_DATA_HOME/Trash` (`~/.local/share/Trash` by default)
and each mounted drive's `.Trash/<uid>` or `.Trash-<uid>`, the folders GNOME
Files and Dolphin use, so an item moved to the Trash in either shows here
and the reverse. Put Back returns an item to the path its `.trashinfo`
records. Empty Trash empties all of them, after the window asks, and shows
its progress with Stop in the operations area, as Delete Immediately does.

**Drives** lists what is mounted for the person: the startup disk is the
**File System** row, then drives under `/run/media`, `/media`, `/mnt`, and
the like, named by their label. The host watches the mount table, so a drive
plugged in or ejected elsewhere appears or goes on its own. Eject uses
`gio mount -e`, or `udisksctl` when gio is not there; with neither installed
the window says so. The space shown in the path bar is the drive's free space
as `statfs` reports it to the person. With no Automations yet, Settings → Automations
points to **View → AmpleFile Agent**.

Quick Look is Mac-only. On Linux, Space on a selected file opens AmpleFile's
own **Preview**, a panel over the window, on every desktop (GNOME, KDE, niri,
Sway). The file list keeps the keyboard: the arrow keys move the selection
and the Preview follows it, and Space, Esc, or the close button put it away.
Shortcut Keys lists Space as "Preview the selected item." It works the same
in Connected Folders and Standard Folders:

- Text of any kind, code and Markdown included, shows as plain text, up to
  its first 256 KB; a longer file says where the Preview stops.
- PNG, JPEG, GIF, WebP, BMP, AVIF, and SVG images up to 12 MB show as
  pictures. An SVG is drawn as an image, so its scripts and references never
  run.
- PDFs up to 200 MB open in the built-in PDF viewer.
- Folders, Word, PowerPoint, Excel, archives, audio, video, other binary
  files, and anything over its limit show their icon, kind, and size, with
  **Open**.

The host decides the kind and reads the file through the place's existing
`file-preview` and `raw-file` routes, under the same path policy as every
other route: nothing outside the place, no symbolic links, and nothing in
`.amplefile/` or `.pi/`. Space does nothing on a link row; open the link, or
**Show Original**, to see what it points to. Text is shown, never run; a PDF is drawn by the
built-in viewer inside the sandboxed window, from the file's own bytes; the
window's content policy allows no remote loads; and the Preview starts no
other program. AmpleFile does not use GNOME's Sushi
previewer: it is a separate window that takes the keyboard from the file
list, and a tiling compositor such as niri places it as a new column.

**Open With** shows a menu of the apps the desktop associates with the
file's type, its default app first. The type comes from shared-mime-info
(`gio info`, then `xdg-mime`, then file name globs); the apps come from
desktop entries in `$XDG_DATA_HOME` and `$XDG_DATA_DIRS`, including Flatpak
and Snap exports, and from `mimeapps.list`. Hidden, NoDisplay, other-desktop
and missing-TryExec entries are left out. The chosen app starts through
`gio launch`, so Flatpak, Snap, D-Bus-activated and terminal apps behave as
they do from the desktop. Without `gio`, AmpleFile expands the entry's Exec
line itself, never through a shell, and refuses a terminal app unless
`xdg-terminal-exec` is installed. **Other Application…** opens a file dialog
in `/usr/share/applications` for a desktop entry or any program. Open With
never changes a default app.

Each app in the menu shows its icon from the desktop's icon theme, found as
the [Icon Theme specification](https://specifications.freedesktop.org/icon-theme-spec/latest/)
describes: the current theme (read from the settings portal, then GSettings,
then KDE's `kdeglobals`, else hicolor), its `Inherits` chain, hicolor, then
`/usr/share/pixmaps`, at 16 pixels with a 2x version. PNG icons are scaled;
SVG icons, which native menus cannot draw, are drawn by Chromium in an
offscreen renderer as images, so they run no script and load nothing: a
sandboxed page with JavaScript off, a `default-src 'none'` policy and an
in-memory session that refuses every non-`data:` request. SVG files over
512 KiB and PNG files over 1 MiB are skipped. Icons are cached for the session
and the theme is read again after five minutes. An icon not ready within
400 ms is left out of that menu, which never waits for it; the next menu
shows it. No `rsvg-convert`, gdk-pixbuf helper or other new dependency is
needed. XPM icons are not shown.

The AmpleFile Agent is available from **View → Toggle AmpleFile Agent**
(Ctrl+J), including desktops that do not display tray icons. Opened from the window, it appears
inside the window's top-right corner, under the title bar, on that window's
display. Opened from the tray menu, it appears next to the pointer in an X11
session; in a Wayland session, XWayland included, the pointer position is
not known after a click in the panel, and a tray icon reports no position, so
it appears in the work-area corner nearest the panel on the display of the
AmpleFile window. It always stays inside one display's work area and shrinks
on a display too small for it. Window managers that honor requested positions
(X11, and XWayland under GNOME or KDE) place it there. Wayland compositors
choose window positions themselves: niri opens the fixed-size popover as a
floating window, not a tile, centered on the output, under xwayland-satellite
and natively alike. A niri `window-rule` matching the title `AmpleFile Agent`
with `default-floating-position` can move it. Closing one of several windows closes
only it ([Windows](product-model.md#windows)); closing the last Linux window
keeps the host and accepted work alive, and reopening AmpleFile brings back the
window.
Use **File → Quit** to end the app. The first time the last window closes, a
desktop notification says AmpleFile is still running and how to reopen or
quit it; it needs no tray icon and appears once per profile.

Linux previews have no update feed, so the menus and tray offer no **Check for
Updates…**, Settings → About says updates are not available in this build,
and the sidebar shows no update indicator.

Copying files offers them on the clipboard in every form Linux apps paste:
`x-special/gnome-copied-files` (GNOME Files, Nemo, Caja, Thunar),
`text/uri-list` (Dolphin, GTK file lists) and the absolute paths as plain text,
one per line (`text/plain;charset=utf-8`, `text/plain`, `UTF8_STRING`, `TEXT`,
and Latin-1 `STRING` when every name fits it), so a text editor or terminal
pastes the paths. **Cut** (Ctrl+X) is marked the way GNOME Files and Dolphin
mark theirs: `cut` as the first line of `x-special/gnome-copied-files`, and
`application/x-kde-cutselection` set to `1`, so those file managers paste it
as a move. Electron writes one custom clipboard
format at a time, so a small bundled helper, `amplefile-clipboard`, owns the X
`CLIPBOARD` selection and serves all of them. It runs only while the window
uses X11 (XWayland on a Wayland desktop, per the display rule below) and leaves
when another app copies, when AmpleFile quits or crashes, or after 24 hours.
As with any X11 app, a copy is gone after AmpleFile quits unless a clipboard
manager kept it. On niri, xwayland-satellite hands the helper's copy to native
Wayland apps. When the helper cannot run (native Wayland-only windowing, or a
missing or altered helper), Copy falls back to Electron's single
`text/uri-list`, which GNOME Files, Dolphin and GTK file lists still paste;
that single format cannot carry the Cut marker, so there a Cut made here
pastes in another app as a copy, and still pastes here as a move.

Paste reads files copied in a file manager or another app from
`x-special/gnome-copied-files` or `text/uri-list` (ignoring comments and
non-`file:` URIs), including files another Chromium or Electron app put there,
and copies them in. A file manager's Cut (either marker) is pasted as a move:
each file is named by the Connected Folder that holds it, or else by its
path on the computer, and moves under the same rules as a move made in the
window, so a file inside a Connected Folder leaves it through that Connected
Folder's delete, and one going between a plain folder and a Connected Folder
moves as the [product model](product-model.md#the-file-manager-window)
describes for a move by paste. A finished paste of a Cut empties the
clipboard, as GNOME Files does. The desktop app remembers a Cut made in any
window by the files it put on the clipboard: they are drawn dimmed in every
window and paste as a move in any of them, until they are pasted, Esc
cancels the Cut, one of them is no longer where it was cut, or the clipboard
holds something else. A file manager's marked Copy of the same files is a
Copy, never the Cut. Under
X11 the helper reads the clipboard in its own
process, so a large copy never holds the window; elsewhere Electron reads it,
and another Chromium-based app's files are then not read.

The app follows one display rule however it is launched (menu entry, AppImage,
terminal or `amplefile` command): X11 when an X display is reachable, which on
a Wayland desktop means XWayland, for trusted background browser input and
screenshots; otherwise Electron's own choice, native Wayland on a Wayland-only
session. Chromium picks its display platform before the app's code runs, so
when it picked Wayland and an X display is reachable, the instance that owns
the app starts again once with `--ozone-platform=x11` on its command line; a
second launch only hands its arguments to the running app. The launchers carry
no platform switch, and an explicit `--ozone-platform` is always respected.
Wayland desktop sharing still uses the native portal. Native Wayland-only
windowing starts, but this lane does not qualify browser input or capture there.

Windows use the `amplefile-desktop` app ID (Wayland) and window class (X11),
matching the desktop entry, so docks and task switchers show AmpleFile's icon.
As on the Mac, each window's title is the name of the Connected Folder it
shows (AmpleFile when none is), which task switchers and `niri msg windows`
list. **File → New Window** (Ctrl+N) opens another window at the folder the
front one shows.

**File → Open Recent** lists the Connected Folders shown most recently, as the
Mac's Open Recent does, newest first, followed by **Clear Menu**. Choosing one
opens it the way a folder passed to the app opens; one no longer registered
leaves the list instead. Names come from the Connected Folder list each time,
so a renamed one shows its new name and a disconnected one disappears. The
sidebar's **Recents** is a different list: files changed lately. Electron's
recent-documents calls do nothing on Linux, so up to ten Connected Folder ids
are kept in `recent-connected-folders.json` in the app's data directory.
AmpleFile does not add Connected Folders to the desktop's recent files
(`recently-used.xbel`): there is no command for it, and only GLib's own
writer keeps that shared file intact while other apps update it.
The application menu lists AmpleFile as a file manager, and file managers offer
**Open With AmpleFile** for folders; the packages declare `inode/directory`
but run no `xdg-mime` command and change no `mimeapps.list`. As with a folder
opened from Finder on a Mac, a folder passed to AmpleFile (a launcher's
argument, or a second launch's) opens in the most recently focused window, at
the place that holds it: in the deepest Connected Folder holding it, at that
folder; else in the Standard Folder holding it; else as an other folder under
the Standard Folder rules
([Other folders](product-model.md#the-file-manager-window)). When a launcher
passes several folders, the first opens in that window and each further one
in a new window. A file opens its
folder with the file selected. Nothing is connected, because connecting a
folder is its own explicit act; the panel offers **Connect This Folder**.
This works on a fresh profile too: the folder is shown in the file manager,
not held behind first run's welcome, and with no Connected Folder at all the
window is a whole file manager that opens at the home folder
([First run](product-model.md#first-run)).

## AmpleFile as the file manager

AmpleFile becomes the file manager other apps use only when the person
chooses it, in **Settings → File Manager**, a page shown on Linux alone. It
has two independent choices, each showing what the system says now (never a
remembered flag), saying what it changes, turned off from the same place, and
reporting a failure in plain words beside it. Installing a package changes
neither.

**Show Files from Other Apps** answers the freedesktop
[file manager interface](https://www.freedesktop.org/wiki/Specifications/file-manager-interface/),
`org.freedesktop.FileManager1` on the session bus, which a browser's
downloads list, a chat app or the desktop portal calls to "show in folder".
Turning it on does two things:

- While AmpleFile runs, it owns the name and answers `ShowFolders`,
  `ShowItems` and `ShowItemProperties` through the same path as a folder
  handed to the app: `ShowFolders` opens the folder; `ShowItems` and
  `ShowItemProperties` show the item selected in its folder, a folder too.
  One folder (or one folder's items) opens in the most recently focused
  window, so an app that asks again and again never piles windows up; each
  further folder a call names opens in a new window, as a system file manager
  does, at most eight windows for one call. Items in one folder share its
  window, with the first of them selected. Every URI
  is untrusted: only `file:` URIs with no host (or `localhost`), no query or
  fragment, strict percent-escapes that decode to UTF-8 without NUL, and an
  absolute path of at most 4,096 characters are used; the first 64 URIs of a
  call are read and the rest ignored, and more than ten calls in ten seconds
  are answered and ignored. The window comes forward as it does for a second
  launch. Electron offers no way to hand the caller's startup id or activation
  token to the window manager, so the id is checked and otherwise unused, and a
  desktop's focus-stealing prevention may show an attention hint instead.
- It writes a per-user D-Bus service file,
  `$XDG_DATA_HOME/dbus-1/services/org.freedesktop.FileManager1.service`
  (normally under `~/.local/share`), whose `Exec` starts this copy of
  AmpleFile, so an app's call starts AmpleFile when nothing answers. The file
  begins with a comment saying AmpleFile wrote it, and it is the remembered
  choice: AmpleFile answers at startup only when that file starts this very
  copy. If the person already had their own file there, its bytes are kept,
  base64-encoded, in a `# amplefile-replaced:` comment line of AmpleFile's
  file, and turning the choice off writes them back exactly; otherwise turning
  it off removes the file. Anyone else's file is never removed. After each
  change AmpleFile asks the bus to reload its service files.

Which program the bus starts follows its service directories: both
dbus-daemon (Debian, Ubuntu, Kubuntu) and dbus-broker (Fedora, Arch) read
`$XDG_DATA_HOME/dbus-1/services` before each `$XDG_DATA_DIRS` directory and
`/usr/share`, and the first file to name a bus name wins, whatever the file is
called; dbus-broker logs the later ones as ignored duplicates. So a per-user
file takes precedence on GNOME over Nautilus's
`org.freedesktop.FileManager1.service`, on KDE over Dolphin's
`org.kde.dolphin.FileManager1.service`, and on a bare compositor (niri, Sway)
over whichever file manager package is installed, or is the only provider when
none is. dbus-broker reads service files only at startup and on `ReloadConfig`,
which AmpleFile calls; dbus-daemon also notices the change itself. It starts
an activated program in a transient systemd unit that stops only the first
process, so AmpleFile's one-time restart under X11 (above) keeps running.
These rules were checked on Fedora 44 with dbus-broker 37 (the live user bus,
niri session) and with dbus-daemon 1.16 on a private bus, using a KDE-style
file name; the tests repeat the dbus-daemon check. GNOME and KDE sessions
themselves were not run.

The service file decides who is started, not who answers while running. If
the system's file manager is running and holds the name, as Nautilus does
while it runs in the background after use, AmpleFile asks to replace it, which
succeeds only when that program allows replacement; otherwise AmpleFile waits
in line, Settings names who is answering and that AmpleFile takes over when it
closes, and the bus hands AmpleFile the name then. Without a session bus, or
when the bus refuses, the choice stays on but Settings says AmpleFile can't
answer, and why.

A native package's file starts `/opt/AmpleFile/amplefile-desktop`; an
AppImage's starts the AppImage file itself (`$APPIMAGE`), and an unpacked
development build starts its Electron with the app folder. When the file
starts another copy, such as an AppImage since moved or a development build,
Settings says so and turning the choice on points it at this copy. Paths with
a single quote or a control character are refused rather than escaped.

**Open Folders with AmpleFile** makes AmpleFile this user's default
`inode/directory` handler with `xdg-mime default` (or `gio mime` without
xdg-utils), after remembering in `file-manager-integration.json`, in the app's
data directory, what `$XDG_CONFIG_HOME/mimeapps.list` named for folders and
which app the desktop resolved. If the desktop still resolves another app
afterwards (a setting AmpleFile doesn't change takes precedence), AmpleFile
puts the person's entry back and says so. Turning it off restores that exact
entry, a list included, or removes AmpleFile's line when there was none;
`xdg-mime` and `gio` can set a default but not remove one, so AmpleFile edits
that one line of `mimeapps.list` itself, leaving every other line, and writes
through a symbolic link to its target. When folders no longer open with
AmpleFile, because the person chose another app, turning it off changes
nothing. The choice needs AmpleFile's desktop entry,
`amplefile-desktop.desktop`, which the DEB and RPM install and an AppImage
does not, so on an AppImage without it the choice is unavailable and says why.

Uninstalling changes neither choice. The packages install no system-wide
service file, and their scripts, which run as root for every user, do not
edit anyone's home folder, so turn both choices off before uninstalling. A
service file left behind keeps the system's file manager from being started
on demand until it is removed (`~/.local/share/dbus-1/services/org.freedesktop.FileManager1.service`;
a file it replaced is in its `# amplefile-replaced:` line, base64-encoded), and
a folder default left behind still names `amplefile-desktop.desktop` in
`~/.config/mimeapps.list` until another app is chosen.

## Live file updates

The file list updates as files change. The Linux kernel caps how many
file watches one user may hold across every app (`fs.inotify.max_user_watches`),
so AmpleFile watches a Connected Folder one folder at a time rather than one
file at a time: a watch on a folder already reports the files directly inside
it.

- Ignored folders, hidden AmpleFile and Pi data, and the tool and dependency
  folders History never records (`.git`, `node_modules`, `__pycache__` and the
  like) are not watched, nor is anything beneath them.
- One Connected Folder uses at most an eighth of the kernel's allowance, and
  never more than 16,384 watches. When a folder tree is larger than that, the
  folders nearest the top are watched.
- A folder outside those bounds is still watched while it is on screen: the
  eight most recently shown such folders each hold one watch.
- Changing what a Connected Folder ignores updates what is watched.

A change in an unwatched folder appears the next time that folder is opened.
Standard Folders watch only the folder shown.

## Computer Control

The included Linux helper provides AT-SPI application roots and semantic
actions, including multilingual text. On X11 it also provides screen/input
operations. Wayland uses a separately bundled portal/PipeWire/libei helper
for shared-screen capture and physical input.

Open **Skills & Extensions → Computer Control → Set Up**. In a Wayland
session, **Share desktop** opens the desktop's real permission chooser.
Sharing belongs to the app and can be set up before connecting a folder;
one accepted Chat turn controls it at a time. Tools use explicit shared-screen
targets and fresh observations, and never replay uncertain input. **Stop
sharing** works during an accepted turn and cancels an open chooser. Stop,
lock, sleep, helper failure, removal of the controlling Chat, and Quit revoke
the appropriate control session. Catalog reads do not launch helpers or ask
for screen permission.

GNOME and niri 26.04 are supported. On niri, **Share and Allow Control** opens
the screen portal. After a display is selected, the helper uses niri’s native
virtual-pointer and virtual-keyboard protocols, bound to that display, without a
privileged input daemon. It requires the current user’s active Wayland logind
session and revokes access on `LockedHint`, session deactivation or service loss.
The selected stream must match exactly one monitor’s logical geometry; output
changes invalidate input and require sharing again. Keyboard input uses the
compositor’s keymap, with the same bounded typing rules as the libei path.
Capture requests linear XRGB DMA-BUFs, validates their kernel allocation and
plane layout, and brackets CPU access with the Linux DMA-BUF synchronization
API before producing bounded RGBA/PNG observations. A driver must support
exporting CPU-readable linear buffers.

The helper identifies the desktop from `XDG_CURRENT_DESKTOP` and admits only
an allow-list: GNOME, KDE Plasma and niri. Any other desktop, or an ambiguous
value, is refused before a chooser opens, with the reason. Every admitted
desktop has a lock signal the helper can observe, because locking must end
control. The niri path is a general one for compositors with
`zwlr_virtual_pointer_v1` (version 2), `zwp_virtual_keyboard_v1`,
`xdg-output` (version 3) and `wl_output` (version 4); the compositor must
advertise all of them and exactly one seat. If the seat has no keymap yet,
sharing is refused until a key is pressed on the keyboard.

Sway, river, labwc and Wayfire offer those protocols and capture through
`xdg-desktop-portal-wlr`, but are not supported: no other application can see
when they are locked. Neither these compositors nor their lockers (swaylock,
for one) set logind's `LockedHint`, as checked in the Fedora 44 builds of Sway
1.11, swaylock 1.8.6, labwc 0.9.6, Wayfire 0.10.1 and river 0.5.0, and
`ext-session-lock-v1` state is private to the locker. Hyprland has a lock
notifier (`hyprland_lock_notifier_v1`) that could serve, but its monitor is not
implemented or tested. COSMIC 1.11's portal offers RemoteDesktop with libei,
but neither cosmic-comp nor its locker sets `LockedHint`, and its
`org.freedesktop.ScreenSaver` service reports no lock state.

KDE's helper path requires one connected monitor;
multi-monitor KDE responses are refused. Portal/backend availability, a desktop
accessibility bus, and a session screen-lock service are required. DEB/RPM
declare desktop runtime dependencies. For AppImage, install libei,
libxkbcommon, GStreamer base plugins, the PipeWire GStreamer plugin, and the
appropriate xdg-desktop-portal backend through the distribution.

## Verification

The build runs its probes on a private X display with the person's Wayland
socket removed, verifies packaged assets and fuses, rejects sandbox-disabling
launches, and runs Pi through a synthetic loopback provider. That test checks
the Worker-inherited CLI, exact output bytes, folder identity, Chat, History,
model selection, durable request completion, and renderer sandbox state.
It uses disposable app/Pi profiles, with no personal credentials or paid model.

It then checks the installers themselves, without root or installation: the
DEB and RPM are extracted (`dpkg-deb`, or `ar` and `tar`; `rpm2cpio` and
`cpio`) and the AppImage unpacks itself. Each must contain the executable, the
CLI under `bin/`, the Computer Control, Wayland and clipboard helpers (the
clipboard helper with its provenance and licenses), the desktop entry
(an `Exec` without platform or sandbox switches, `inode/directory`, the menu
categories, `GenericName` and `Comment`) and the hicolor icons from 16 to 512
pixels (plus the scalable SVG in DEB/RPM). The DEB and RPM must declare every
configured dependency and the keyring recommendation, and carry maintainer
scripts that set no default application. A format is skipped, with a printed
notice, only when its extraction tools are missing. To check existing artifacts:

```sh
node scripts/verify-linux-packages.mjs out/linux --version VERSION
```

To check persistence across cold launches:

```sh
node scripts/linux-installed-smoke.mjs out/linux/linux-unpacked/amplefile-desktop --profile-root /absolute/new-fixture --phase seed
node scripts/linux-installed-smoke.mjs out/linux/linux-unpacked/amplefile-desktop --profile-root /absolute/new-fixture --phase verify
```

The native Rust suites and the `computer-session`, `wayland-pi-tools`,
`wayland-setup-ui`, `linux-computer-helper`, and `linux-desktop` application
tests exercise cancellation, ownership, stale observations, setup and native
transport. [Private desktop acceptance](../scripts/linux-wayland-probe/README.md)
tests the actual portal, compositor, capture/input and Pi tool path in an
isolated GNOME seat. [Private niri acceptance](../scripts/linux-niri-probe/README.md)
checks native input and lock revocation at 100% and 125% scale.
[Private Sway acceptance](../scripts/linux-wlroots-probe/README.md) runs the
same virtual-input path and portal capture on Sway 1.11 in a disposable
container at 100% and 125%: exact click coordinates and text, refusal without
a keymap, exact capture pixels, invalidation when the selected output changes
or is removed, refusal of a rotated output, and the product's refusal of Sway
itself. It does not qualify Sway, which still lacks a lock signal. Real niri capture
was also checked on a 1920×1200 display at 125%, including exact PNG pixels and
selected-output coordinate mapping. These fixtures do not establish hardware GPU, physical
sleep, IME, paid-provider or public signed-repository qualification.

The `linux-file-manager-bus`, `linux-file-manager-integration` and
`linux-file-manager-settings` tests cover the file manager choices: the D-Bus
wire format, a private dbus-daemon on which GLib's `gdbus` calls AmpleFile's
FileManager1 service (owning, waiting in line and taking over, ignoring
unusable URIs and bursts) and the written service file wins activation over a
KDE-named system file (skipped without `dbus-daemon` or `gdbus`), URI parsing
and its limits, the service file's content, replacement and removal, and
setting and restoring the folder default against a fake `XDG_CONFIG_HOME` and
`XDG_DATA_HOME`, with the real `xdg-mime` when installed.

The `linux-clipboard-helper` tests run the built clipboard helper on a private
Xvfb display (skipped when it or Xvfb is missing): every offered target and its
bytes, names with spaces, `#`, `%`, non-ASCII characters and newlines, a
5,000-file copy through incremental transfer, and the helper leaving when
replaced, when its input closes and at its time bound. Pasting into GNOME Files
and GNOME Text Editor was checked by hand on such a display; Nemo, Caja, Thunar,
Dolphin and the GNOME and KDE Wayland bridges were not.

The integration combines the Linux action-safety work in `609ddebc` with the
Mac reliability fixes in `d8c90fc7`, `5543df03` and `9a24cd0e` from the source
project. The Mac helper's reviewed bytes and common text-result verification
remain intact; shared-screen support extends the native Extension entrypoint.

Provider sign-in waits for the browser callback automatically. **Paste Link**
is an optional inline fallback in first-run setup and AI Models; sign-in can also
be cancelled there. Required provider codes and device-code instructions still appear.
The built-in Browser pane replaces the removed Chrome extension integration.
Linux packages contain no Chrome bootstrap; startup removes only a provably
owned obsolete registration and helper from the normal app profile.
