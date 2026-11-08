# Documentation map

## Product language

The docs use **Connected Folder** (always capitalized) for the working
context backed by one ordinary folder, **Worker** for its AI helper,
**AmpleFile Agent** for the agent above all Connected Folders, **Automation**
for deterministic steps between Connected Folders, **Skills & Extensions**
for capability management, and **Recently Deleted** for reversible deletion.
These words are also the code's: identifiers, HTTP routes, CLI verbs and
flags, JSON keys, schemas, and storage paths use them, with the exceptions
listed in [the vocabulary glossary](../scripts/vocabulary/GLOSSARY.md) (for
example the app-state `management/` folder).

For a first checkout, start with [Contributing](../CONTRIBUTING.md) and
[Development](development.md). Read [the product model](product-model.md)
for product scope and [AGENTS.md](../AGENTS.md) for contributor rules.

## Contracts

| Area | Read |
|---|---|
| Product and contributor workflow | [Product model](product-model.md), [Contributing](../CONTRIBUTING.md), [Development](development.md), [Architecture](architecture.md) |
| The AmpleFile Agent, the CLI, and receipts | [The AmpleFile Agent and CLI](amplefile-agent-and-cli.md), [Act ledger](act-ledger.md), [Collaboration contract](collaboration-contract.md), [Background jobs](background-jobs.md), [Worker tools](worker-tools.md), [Feedback during Worker work](tool-feedback.md) |
| Automations | [Automations](automations.md), [The overview](amplefile-agent-overview.md) |
| Native agent capabilities | [Skills & Extensions](skills-and-extensions.md), [Pi resources](pi-resources.md), [Extensions and computer work](extension-foundation.md), [Declarative Extension surfaces](extension-surfaces.md), [Built-in browser](built-in-browser.md), [Document verification](document-verification.md), [Image generation](image-generation.md) |
| Desktop interaction and appearance | [Collaboration experience](collaboration-experience.md), [Visual system](visual-design.md), [Application appearance](application-appearance.md), [Connected Folder customization](connected-folder-customization.md) |
| Mac distribution | [Build lanes](macos-build.md), [Release procedure](macos-release.md), [Chrome extension distribution](chrome-extension-distribution.md) |

## Harness and example boundaries

- `AGENTS.md` is canonical. [CLAUDE.md](../CLAUDE.md) imports it.
- The shared [release Skill](../.agents/skills/ship-macos-release/SKILL.md)
  lives under `.agents/skills/`; `.claude/skills/ship-macos-release` is a
  tracked symlink to that exact directory. Other `.claude/` and `.codex/`
  content is ignored machine-local state.
- The AmpleFile Agent's runtime instructions and `manage-connected-folders`
  Skill are generated from `src/local/amplefile-agent-instructions.ts`, and
  the compact operations guide every Connected Folder turn receives is
  generated from `src/local/agent/connected-folder-operations-guide.ts`. They
  are app resources, not copies of the repository's contributor contract.
- The [filing Skill](reference-skills/organize-dropped-material/SKILL.md) is a
  reference example, not an automatically installed project Skill. Its work
  across Connected Folders belongs to the AmpleFile Agent.
- [Connected inbox](../examples/packages/connected-inbox/README.md) is a
  full-trust Pi Extension. It is not an installed account integration merely
  because its source is checked in.
- [Brand assets](../desktop/assets/brand/README.md) describe the Manila
  artwork's provenance and how every icon is generated from it.

## Keep the map accurate

Docs describe how AmpleFile works today. When behavior changes, update the
doc that owns it in the same change, and say what is true now rather than
what changed. Run `npm run repo:check` after documentation maintenance to
check relative links, heading anchors, the npm commands the docs name, ignore
rules, and the shared Skill symlinks.
