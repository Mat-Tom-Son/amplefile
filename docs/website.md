# Website

amplefile.com is one static page built from `site/`. It shows the app as HTML
drawn at the file manager's own sizes and words, and each section plays a
short scene while it is on screen.

On a wide screen a section shows the whole window. On a phone, a section whose
action is in the right panel shows the whole window with a close-up of the
panel beneath it; the page draws that view twice and plays both as one scene,
so every step lands on both together. The file manager section's close-up is
the folder area instead: its tabs, icons, list, and search results.

The first section after the headline shows the file manager itself, with
nothing that needs a Worker: Info measuring a folder, a search that finds a
word in names and in the text of files, a second folder tab that keeps its
own Icons view and search, thumbnails, and a photo's Info. The sidebar of
every window holds Recents, the Trash, and Drives.

## Each visitor's system

The page speaks to the visitor's system. A script in the head marks it on the
page (`os-mac`, `os-windows`, or `os-linux`) before anything draws, and the
page shows each system's own words and windows (`per` in `site/views.mjs`):

- **Mac:** "your Mac" and Finder; the window has the Mac's window buttons,
  iCloud Drive among the Standard Folders, Macintosh HD under Drives and at
  the start of the path bar, ⌘ in key hints, and the names macOS gives
  screenshots and installers.
- **Linux:** "your computer" and "your file manager"; the window has the title
  bar AmpleFile draws on Linux, with its menus and window buttons
  ([Linux builds](linux-build.md#title-bar-and-desktop-appearance)), no
  iCloud Drive, File System under Drives and over `/home` in the path bar,
  Ctrl in key hints, the Permissions, Owner, and Group rows Info adds there,
  and the names GNOME gives screenshots and the packages a Linux download is.
- **Windows:** "your PC" and File Explorer, with the neutral window below:
  this repository has no Windows window to draw from, so the page draws none.
- **Anything else** (a phone, an unknown system, or a visit without scripts):
  "your computer" and the neutral window, which has no window buttons, no
  iCloud Drive, and no disk; its path bar starts at the home folder.

`?os=mac`, `?os=windows`, `?os=linux`, or `?os=other` shows the page as that
visitor sees it, for checking each one. The menu bar's note names the menu
bar Agent on a Mac and the AmpleFile Agent elsewhere.

## Files

| Path | Contents |
|---|---|
| `site/build.mjs` | The page shell, its script, and the head; writes `site/public/` |
| `site/manila.mjs` | The page itself: the Manila folder on a dark desk, its sections, the menu bar, the note, and the footer |
| `site/views.mjs` | The app views and their scenes |
| `site/public/` | The built site: `index.html`, the icons, the share image, and `robots.txt` |

The wordmark, icons, and share image come from
[the brand folder](../desktop/assets/brand/README.md). `site/public/` is
generated: change the sources, then rebuild.

## Build and preview

```bash
npm run site:build
```

Download links open the latest release in
`Mat-Tom-Son/amplefile`. When the page loads, it asks GitHub for
that release and points every Download link straight at its DMG, so a new
release needs no rebuild and an unpublished version is never linked.

Linux links open the newest Linux preview. The previews are prereleases in
`Mat-Tom-Son/amplefile`, which no "latest" address reaches, so the same
script asks GitHub for that repository's releases and points every Linux link
at the page of the newest prerelease whose tag starts with `linux-`. Newest
means published last (`site/linux-preview.mjs`): GitHub does not list one
day's releases newest first, so the first match in its list can be an older
preview. Until GitHub answers, a Linux link opens the list of releases. A visitor on Linux
sees the Linux button as the blue one at the top of the page, and the Linux
preview first in the menu bar's Download menu. The footer says the preview
comes as a DEB, an RPM, or an AppImage, and that on Fedora the RPM updates
with the system's software updates
([Package repository](linux-build.md#package-repository)); the DEB and
AppImage have no update path, and the page claims none.

Windows links open AmpleFile's Microsoft Store listing, which installs and
updates the Windows build, so the page asks nothing of GitHub for them. A
visitor on Windows sees the Windows button as the blue one at the top of the
page, and the Store listing first in the Download menu.

The menu bar that arrives on scroll has two menus: **Download**, with the Mac
release, the Windows Store listing, the Linux preview, and all releases, and **Help**, with the docs,
Contributing, Privacy, and the license. The page shows the app's four
included tools in the order the Skills & Extensions dialog lists them.

The build takes the Mac repository from the checked-in update feed stage
([Update feed](macos-release.md#update-feed)), not from a constant: the
separate release repository in the `separate-repository` and `bridge`
stages, and `Mat-Tom-Son/amplefile` in the `source-repository` stage. After a
stage change, rebuild and deploy; a test fails while `site/public/` still
links the other repository.

To preview, serve the folder over HTTP and open http://127.0.0.1:8080:

```bash
python3 -m http.server 8080 --directory site/public
```

The scenes play as each section scrolls into view and replay while it stays
there. With Reduce Motion on, every view shows its finished state. Add
`?os=linux` (or `mac`, `windows`, `other`) to the address to see another
system's page.

## Deploy

The site runs on Railway as the `amplefile-site` service in the
`amplefile-site` project, which serves `site/public` with Caddy. Build first,
then deploy the folder with the Railway CLI while signed in to the account
that owns the project:

```bash
railway up site/public --path-as-root --project b9a68695-c70f-4b1f-b97b-0e6a98f1afc0 --environment production --service amplefile-site --ci
```

If the upload fails with "Failed to snapshot repository", the fault is on
Railway's side; run the same command again after a few minutes.

## Domain

GoDaddy hosts the DNS. `www.amplefile.com` is a CNAME to the Railway service
(`ois18sp4.up.railway.app`), and the `_railway-verify.www` TXT record proves
ownership; Railway issues and renews the certificate. GoDaddy can't point the
bare domain at Railway, so GoDaddy forwarding sends `amplefile.com` to
`https://www.amplefile.com` with a 301.
