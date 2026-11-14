# Contributing to AmpleFile

AmpleFile is an independent project, and help building and maintaining it is
welcome. A focused bug fix, a clearer interaction, a useful test, or a better
explanation is a good first contribution. For anything larger, open an
[issue](https://github.com/Mat-Tom-Son/amplefile/issues/new/choose) or a draft
pull request first so we can agree on the approach.

## Prerequisites

- **Git**, **Node 24** (the root `.nvmrc`; run `nvm use` if you use nvm), and
  **npm 11.16.0 or newer**. The package itself runs on Node 22.19.0 or newer,
  but contributor installs need that npm.
- A Mac: AmpleFile ships for Apple-silicon Macs, and the native lanes
  (`desktop:*`) need one.
- **Google Chrome** or Chromium for the tests that lay out real CSS; without
  one they are skipped. The tests look in the Mac's Applications folder and
  for `google-chrome`, `google-chrome-stable`, `chromium`, and
  `chromium-browser` in `/usr/bin`. Point `AMPLEFILE_CSS_BROWSER` at another
  Chromium to use that.
- No model provider key or Apple account is needed for the checks and tests.

Check `npm --version` after selecting Node: the npm bundled with Node varies.
With an older npm, **every** npm command in this checkout, including
`npm run repo:check`, stops before doing anything:

```text
npm error code EBADDEVENGINES
npm error EBADDEVENGINES Invalid semver version ">=11.16.0" does not match "11.12.1" for "packageManager"
```

Fix it by updating to the newest Node 24 release or by upgrading npm, then
check again:

```sh
npm install -g npm@11
npm --version
```

The requirement exists because `package.json` uses npm's per-dependency
script controls (`allowScripts`) so that the Computer Control helper is built
by our packaging lane, never by an install hook.

## First run

```sh
git clone https://github.com/Mat-Tom-Son/amplefile.git
cd amplefile
npm ci
npm run repo:check
npm run local:dev
```

`npm ci` prints deprecation warnings, an `npm audit` summary, and an
`allowScripts` notice listing a few packages. On a clean install these are
expected and need no action; the install worked if it ends by verifying the
included integrations and adding the packages.

`npm run local:dev` starts the local API on `127.0.0.1:4327` and the browser
UI on **http://localhost:5173**. It is a live development host with its own
**AmpleFile Development** profile, separate from an installed AmpleFile, but
the folders you connect are real: use test folders. Connect a model in
**Settings → AI Models** only when you want to try a real turn.

If port 5173 is already in use, Vite says so and serves on the next free port,
but the local API only accepts the UI from port 5173: the app loads and then
fails its requests with `403 Forbidden`. Stop whatever holds 5173 and restart.

### Preview the UI without the app or a model

With `local:dev` running, these pages draw the real UI from sample data in
`web-local/src/fixtures/` and never call the local API:

- **http://localhost:5173/?fixture=connected-folder**: the window with sample
  Connected Folders.
- **http://localhost:5173/popover.html?fixture=agent**: the AmpleFile Agent's
  menu-bar popover.

They are the fastest loop for layout and styling, and need only Vite
(`npx vite --config vite.local.config.ts`, any port). [Development](docs/development.md#choose-a-development-surface)
lists the options for running Chats, replayed steps, and browser rendering.

### Run the native app

`npm run desktop:smoke` builds and verifies the desktop code, then opens
unpackaged Electron. Use it for native dialogs, preloads, secure storage, the
built-in browser, and anything else the browser preview cannot show.
[Development](docs/development.md#development-state-and-model-access) explains
fully isolated profiles.

## Find the right part of the project

Read [the product model](docs/product-model.md) once, then only the contracts
for the area you touch; [AGENTS.md](AGENTS.md) names the required ones and the
[docs map](docs/README.md) lists them all.

| Working on | Start here |
|---|---|
| Files, Chats, navigation, or UI | `web-local/src/`, [Product model](docs/product-model.md), [Visual system](docs/visual-design.md) |
| The local API, Worker, or domain services | `src/local/`, [Architecture](docs/architecture.md), [source map](docs/development.md#source-map) |
| The AmpleFile Agent, CLI, or shared task state | [Kernel](src/local/amplefile-kernel.ts), [CLI](src/local/cli/), [AmpleFile Agent and CLI](docs/amplefile-agent-and-cli.md) |
| Work across Connected Folders | [Automations](docs/automations.md), [Collaboration contract](docs/collaboration-contract.md) |
| Native desktop behavior | `desktop/src/`, [macOS builds](docs/macos-build.md) |

Use the interface's words in code too: [the vocabulary glossary](scripts/vocabulary/GLOSSARY.md)
lists them.

## Check your change

Pick the smallest lane that can catch what you changed, then run the wider
ones before you hand off:

| You changed | Run |
|---|---|
| Docs only | `npm run repo:check` (links, heading anchors, the npm commands docs name, shared Skills) |
| Any TypeScript | `npm run check` (`repo:check` plus the renderer, desktop, and harness type checks) |
| Behavior | a focused test file while working, then the full `npm test` |
| UI layout or styles | the fixture previews above, plus `npm run check` and the related tests |
| Electron, preloads, packaging, or runtime resources | also `npm run desktop:prepare`, and `npm run desktop:smoke` to look at it |

Tests live in `tests/` as `*.test.ts` files run by Node's test runner through
`tsx`. The full suite takes about a minute on an Apple-silicon Mac. Run one
file, or one of four shards, through the runner:

```sh
npm test -- tests/documentation-contract.test.ts
npm test -- --shard=1/4
```

Always go through `npm test`: it points Pi at a temporary folder so no test can
read your provider keys or write into `~/.pi`. Running a file directly with
`node --import tsx --test` skips that isolation. More in
[verification](docs/development.md#verification).

## Commits and pull requests

- Branch from `main` and keep one focused change per pull request. Preserve
  unrelated work; keep credentials, local settings, and generated output
  (`out/`, `dist/`) out of commits.
- Write commit subjects as a short sentence saying what is now true, in the
  product's words, without a type prefix, for example
  `Guard the text-save route against overwriting a changed file`.
- Update the doc that owns a behavior in the same change. Docs say how
  AmpleFile works today, not what changed.
- Open a **draft pull request** and fill in its template: the problem, the
  resulting behavior, the commands you ran with their results, and a
  screenshot for visible changes.

## How changes are reviewed

GitHub Actions is off in this repository on purpose, so pushes and pull
requests run no remote checks. The commands listed in your pull request are
the evidence a review starts from; expect a maintainer to rerun the relevant
lane on your branch before merging. Before any release, the full local release
check runs again on the exact commit on `main`.

Releases are a maintainer operation, with Developer ID signing and
notarization; see [the release runbook](docs/macos-release.md).

Linux development and packaging also require the native helper toolchain;
see [Linux builds](docs/linux-build.md) for Rust and system dependencies.

## Bring your coding agent

Open the repository root in your agent and give it a concrete task.
[AGENTS.md](AGENTS.md) is the contributor contract for every agent: Codex reads
it directly, Claude Code reads it through [CLAUDE.md](CLAUDE.md), and other
agents can be told to read it. A useful first prompt is:

> Read AGENTS.md and CONTRIBUTING.md. Run npm run repo:check, find the code and
> owning docs for this task, then implement and verify: [describe the change].

Shared Skills live in `.agents/skills/`, and Claude Code sees them through
tracked `.claude/skills/` symlinks; see
[agent setup](docs/development.md#agent-setup-and-shared-skills).

## Bugs, security, and license

For a bug, use the bug report form: the app version, macOS version, expected
and actual behavior, and a small reproduction with non-private files. Report
vulnerabilities privately as [SECURITY.md](SECURITY.md) describes. Keep keys,
tokens, personal paths, and private content out of public reports.

Contributions are distributed under the [MIT License](LICENSE).
