# Linux builds

AmpleFile has a Linux x64 preview lane producing DEB, RPM and AppImage
packages. [Linux test preview 0.1.3](https://github.com/Mat-Tom-Son/amplefile/releases/tag/linux-test-0.1.3)
uses a separate prerelease tag in the source repository. The public Mac release
and updater remain separate; Linux previews have no automatic update feed.
The build command itself never publishes.

The window fits its own display’s work area on startup and after display-scale
changes, including when restoring a placement from a larger screen. The Linux
menu bar appears with Alt; the sidebar does not reserve space for Mac window
buttons. First-run setup uses the Linux Computer Control surface.

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
command. Uninstall preserves Connected Folders, Pi resources and app data.
AppImage runs without libfuse2; desktop libraries and a functioning Chromium
sandbox are still required. The app refuses `--no-sandbox`.

Linux app data lives in `$XDG_CONFIG_HOME/AmpleFile` (normally
`~/.config/AmpleFile`). Development uses `AmpleFile Development`. The isolation
variables in [Development](development.md#development-state-and-model-access)
also apply on Linux. Provider and Service Connection credentials require a real
libsecret or KWallet backend; Chromium's `basic_text` fallback is refused.

## Sidebar and desktop

Standard Folders read `$XDG_CONFIG_HOME/user-dirs.dirs`, falling back to
`~/.config/user-dirs.dirs` and conventional directory names when no setting
exists. Desktop, Documents, Downloads and Pictures follow their configured
locations. A directory pointed at the home folder is disabled and omitted;
the home folder has its own row. Only existing directories are listed, and
iCloud Drive is Mac-only. The parser reads data without evaluating shell code.
See the [XDG user directories contract](https://wiki.freedesktop.org/www/Software/xdg-user-dirs/).

The AmpleFile Agent is available from **View → AmpleFile Agent**, including
desktops that do not display tray icons. Closing the last Linux window keeps
the host and accepted work alive; reopening AmpleFile brings back its window.
Use Quit to end the app. Where X11/XWayland is available, Electron uses it by
default for trusted background browser input and screenshots. Wayland desktop
sharing still uses the native portal. Native Wayland-only windowing is not
qualified by this lane.

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

GNOME is the baseline. KDE's helper path requires one connected monitor;
multi-monitor KDE responses are refused. Portal/backend availability, a desktop
accessibility bus, and a session screen-lock service are required. DEB/RPM
declare desktop runtime dependencies. For AppImage, install libei,
libxkbcommon, GStreamer base plugins, the PipeWire GStreamer plugin, and the
appropriate xdg-desktop-portal backend through the distribution.

## Verification

The build verifies packaged assets and fuses, rejects sandbox-disabling
launches, and runs Pi through a synthetic loopback provider. That test checks
the Worker-inherited CLI, exact output bytes, folder identity, Chat, History,
model selection, durable request completion, and renderer sandbox state.
It uses disposable app/Pi profiles, with no personal credentials or paid model.

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
isolated GNOME seat. These fixtures do not establish hardware GPU, physical
sleep, IME, paid-provider or public signed-repository qualification.

The integration combines the Linux action-safety work in `609ddebc` with the
Mac reliability fixes in `d8c90fc7`, `5543df03` and `9a24cd0e` from the source
project. The Mac helper's reviewed bytes and common text-result verification
remain intact; shared-screen support extends the native Extension entrypoint.
