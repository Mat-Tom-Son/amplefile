# Documentation map

## Current product language

Current documentation uses **Connected Folder** (always capitalized) for the working
context backed by one ordinary folder, **Worker** for its AI assistant,
**AmpleFile agent** for the agent above all Connected Folders, **Automation** for
deterministic cross–Connected Folder steps, **Skills & Extensions** for capability
management, and **Recently deleted** for reversible deletion. There is no
Library. These words are also the code's:
identifiers, HTTP routes, CLI verbs and flags, JSON keys, schemas, and storage
paths use them, with the exceptions listed in [the vocabulary
glossary](../scripts/vocabulary/GLOSSARY.md) (for example the app-state
`management/` folder). Dated evidence and quoted copy retain the names they
recorded.

For a first checkout, start with [Contributing](../CONTRIBUTING.md) and
[Development](development.md). Read [the product model](product-model.md) for product scope and
[AGENTS.md](../AGENTS.md) for contributor rules. This map separates current
contracts from design rationale and unshipped ideas; a proposal is not an
instruction to implement its contents.

## Current contracts

| Area | Read |
|---|---|
| Product and contributor workflow | [Product model](product-model.md), [Contributing](../CONTRIBUTING.md), [Development](development.md), [Architecture](architecture.md) |
| The AmpleFile agent and receipts | [Decision register](amplefile-agent-decisions.md), [Receipts, not gates](receipts-not-gates.md), [Collaboration contract](collaboration-contract.md), [Background jobs](background-jobs.md), [Worker tools](worker-tools.md), [Built-in browser](built-in-browser.md), [The AmpleFile agent and CLI](amplefile-agent-and-cli.md), [Act ledger](act-ledger.md) |
| Automations | [Automations (technical automation contract)](automations.md), [The overview](amplefile-agent-overview.md) |
| Native agent capabilities | [Skills, Extensions, packages, and scopes](skills-and-extensions.md), [Pi resources](pi-resources.md), [Declarative Extension surfaces](extension-surfaces.md) |
| Restricted Connected Folder apps | [Authoring](restricted-app-authoring.md), [Runtime](restricted-app-runtime.md), [App platform foundation](app-platform-foundation.md) |
| Desktop interaction and appearance | [Desktop parity](ui-parity.md), [Collaboration experience](collaboration-experience.md), [Visual system](visual-design.md), [Application appearance](application-appearance.md), [Connected Folder customization](connected-folder-customization.md), [Image generation](image-generation.md) |
| Mac distribution | [Build lanes](macos-build.md), [Release procedure](macos-release.md) |

The App platform's [ontology](app-platform-ontology.md),
[publication/data contracts](app-platform-publication-data.md), and
[portable runtime contract](app-platform-runtime-contract.md) are accepted
supporting design contracts. The foundation's **Current local boundary** and
**Implemented local product boundary** identify what is implemented. Accepted
hosted-runtime semantics do not imply a deployed cloud runtime.

## Harness and example boundaries

- [Repeated frozen autonomy evaluation](frozen-autonomy-evaluation.md) records the 2026-10-19 live-model comparison, runtime fixes, all first attempts and remaining limits. It is evidence for those workloads, not a production success-rate estimate.
- `AGENTS.md` is canonical. [CLAUDE.md](../CLAUDE.md) imports it.
- The shared [release Skill](../.agents/skills/ship-macos-release/SKILL.md)
  lives under `.agents/skills/`; `.claude/skills/ship-macos-release` is a
  tracked symlink to that exact directory. Other `.claude/` and `.codex/`
  content is ignored machine-local state. There is no separate `.agent/`
  contract.
- The AmpleFile agent's runtime instructions and `manage-connected-folders` Skill are generated
  from `src/local/amplefile-agent-instructions.ts`, and the compact operations guide
  every Connected Folder turn receives is generated from
  `src/local/agent/connected-folder-operations-guide.ts`. They are app resources, not
  copies of the repository's contributor contract.
- The [filing Skill](reference-skills/organize-dropped-material/SKILL.md) is a
  reference example, not an automatically installed project Skill. Its
  cross–Connected Folder workflow belongs in the AmpleFile agent.
- [Connected inbox](../examples/packages/connected-inbox/README.md) is a
  full-trust Pi Extension. [Restricted Connected inbox](../examples/packages/restricted-connected-inbox/README.md)
  is the separate sandboxed-app example. Neither is an installed account
  integration merely because its source is checked in.
- [Brand assets](../desktop/assets/brand/README.md) describe the Manila
  artwork's provenance and how every icon is generated from it, not another
  product policy.

## Rationale, proposals, and historical records

| Document | How to use it |
|---|---|
| [Extensions and computer work](extension-foundation.md) | Shared Extension design, first interaction implementation, inclusion candidates and outstanding compatibility/release work |
| [Feedback during agent work](tool-feedback.md) | General native-tool feedback contract, adversarial review decisions, local model-context inspection and implementation evidence |
| [Collaboration contract](collaboration-contract.md) | The built wave B specification (accepted 2026-09-11): durable requests, Connected Folder turn context, report/ask/answer/handoff, one result shape, app change hints — also listed under current contracts |
| [Receipts, not gates](receipts-not-gates.md) | Accepted 2026-09-10 direction and the specification the canonical documents now follow: one authority mode, reversible destruction, apps that come up able to work; supersedes F3–F7 and F17, narrows F8, F9, F18 |
| [Rebrand plan](rebrand-plan.md) | Proposed 2026-11-07: every place the AmpleFile names appear, the contract decisions, what must come along, and the order of work for the new name and repository |

Finished plans, superseded designs, dated evidence, and release notes stay in
the work-fold repository.

## Keep the map accurate

Update the owning contract when behavior changes, and reconcile proposals that
would otherwise contradict it. Preserve dated records as history rather than
globally replacing old names or version numbers. Run `npm run repo:check` after documentation maintenance to check relative
links, current npm commands, ignore rules, and all shared Skill symlinks. Use the
usual behavior and release gates only when those surfaces actually change.
