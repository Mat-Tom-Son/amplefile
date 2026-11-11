# Website

amplefile.com is one static page built from `site/`. It shows the app as HTML
drawn at the file manager's own sizes and words, and each section plays a
short scene while it is on screen.

On a wide screen a section shows the whole window. On a phone, a section whose
action is in the right panel shows the whole window with a close-up of the
panel beneath it; the page draws that view twice and plays both as one scene,
so every step lands on both together.

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
at the page of the newest prerelease whose tag starts with `linux-`. Until
GitHub answers, a Linux link opens the list of releases. A visitor on Linux
sees the Linux button as the blue one at the top of the page, and the Linux
preview first in the menu bar's Download menu.

The menu bar that arrives on scroll has two menus: **Download**, with the Mac
release, the Linux preview, and all releases, and **Help**, with the docs,
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
there. With Reduce Motion on, every view shows its finished state.

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
