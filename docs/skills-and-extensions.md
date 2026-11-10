# Skills & Extensions

Product copy calls a Connected Folder's AI helper a **Worker**, the agent above all
Connected Folders the **AmpleFile Agent**, and the model/provider settings page
**AI Models**. Pi's own terms — Skill, Extension, package, and the `global` and
`project` scopes — keep their names.

AmpleFile uses Pi's native capability system for full-trust Skills and Extensions. This guide explains how Skills, Extensions, packages, scopes, and authorization fit the product without confusing them with ordinary files.

**Skills & Extensions…** in the toolbar's **Action** (⋯) menu, or in a Connected Folder's right-click menu in the sidebar, opens the **Skills & Extensions** popup: a dialog like Settings, pinned to the Connected Folder it was opened from. Its **Installed** view answers what is present, where it came from, which scope owns it, and whether Pi loaded it. It starts with an **Included with AmpleFile** strip holding exactly the five included tools — Chrome, Computer Control, Web, Documents, and Service Connections — each with one concise Title Case status (Ready, Setup Needed, Unavailable, Not Checked, or Turned Off; Computer Control evidence older than five minutes says Last Check Passed, Service Connections says No Connections or Configured, and Chrome shows Connected or Not Connected) and a **Set Up** pointer only when a person can act. Below the strip, **Everywhere** (the AmpleFile Agent and every Connected Folder) and **This Connected Folder only** (stored in the Connected Folder's folder) sit side by side and stack on narrow widths; a row opens its details on click, and the groups have no Add buttons. Its **Discover** view searches first-party/reference sources and community Pi packages. Skills and Extensions remain distinct item types inside both views because their behavior and risk are different.

The dialog has one header row that stays in place while its body scrolls: the
title, the Installed/Discover switch, **+ Add Custom** (which opens the
scope-first import and package-source dialog), and Close. Below it, search and
the All/Skills/Extensions filter share one row in both views, and the filter
uses the same segmented control as the view switch. Discover's **Pi Catalog**
heading carries the result count, the sort menu, and the catalog link. Installed
and catalog rows look alike: a type glyph, the name with Skill or Extension
chips, a description, and, in Discover, the author, provenance, and download
count. A row opens its details on click or Enter, and **View Source** stays its
own link; a reference-only catalog entry has nothing to install and says so.
Discover shows a loading state until results for the current search arrive, an
error with **Try Again** when the catalog cannot be reached, and an empty state
only when a finished search matched nothing. The dialog is drawn with the file
manager's tokens and follows Appearance, including Text Size.

## Management visibility

`AmpleFileKernel` exposes a read-only, versioned projection of Pi's authoritative catalog so the renderer, installed CLI, and future scoped adapters see the same Skills, Extensions, tools, packages, prompts, themes, commands, project authorization, provenance, and diagnostics. It does not install or remove resources, activate inactive tools, or bypass registered Connected Folder authorization.

```powershell
amplefile capabilities list --connected-folder "Everywhere connected-folder" --json
```

The CLI projection is intentionally compact and content-free. Capability writes continue through Pi's package/import operations and AmpleFile's trust and concurrency policies. See [AmpleFile Agent and CLI](amplefile-agent-and-cli.md) for the snapshot and protocol boundary.

## Ordinary files are not Pi resources

The word “resource” has two different possible meanings, so AmpleFile uses different product language:

| Kind | Examples | Behavior |
|---|---|---|
| **Ordinary file** | A template, reference document, example, image, or reusable file in a Connected Folder | Passive content. It reaches a Chat only when a person attaches it or a tool reads it. |
| **Pi resource** | A Skill, Extension, prompt template, theme, model/provider configuration, or context instruction | Configuration discovered by Pi. Some resources influence the agent or execute code and therefore have scope and trust implications. |

Internal APIs and storage use the name `resource`. User-facing copy uses the specific Pi term—**Skill**, **Extension**, prompt, or package—when it means agent configuration.

## Skills

A Skill is a reusable way of working. Its interoperable unit is an [Agent Skill](https://agentskills.io): a directory containing `SKILL.md` with `name` and `description` frontmatter. The directory can also contain relative `scripts/`, `references/`, `assets/`, templates, examples, or other supporting files. [Anthropic's public Skills repository](https://github.com/anthropics/skills) provides examples of that structure.

[Pi implements the Agent Skills standard](https://pi.dev/docs/latest/skills) with lenient validation: it warns about most violations and supports some layouts beyond the strict standard. AmpleFile relies on Pi for discovery and runtime behavior. AmpleFile's importer accepts:

- A standalone UTF-8 file named `SKILL.md` with a `name` in YAML frontmatter.
- A `.zip` or `.skill` archive containing one Skill.
- An archive containing multiple Skill directories, including the common `skills/<skill-name>/SKILL.md` layout.
- A compatible Anthropic-style plugin or marketplace bundle, from which AmpleFile imports only the discovered Skill directories.

The last case is deliberately **skill-compatible**, not full plugin compatibility. AmpleFile preserves each discovered Skill directory so its supporting scripts, references, and assets continue to resolve. It does not activate bundled hooks, agents, MCP servers, plugin commands, binaries, marketplace metadata, or Extensions merely because they share an archive with a Skill.

Anthropic marketplace archives may describe several named packs in `.claude-plugin/marketplace.json`. The compatible importer discovers and imports Skill directories safely, but does not offer named-pack selection. This is a known lifecycle gap, not a claim of full Claude plugin compatibility.

### Minimal Skill

Create a folder whose name matches the Skill name and add `SKILL.md`:

```text
meeting-notes/
├── SKILL.md
├── references/
└── assets/
```

```markdown
---
name: meeting-notes
description: Turn raw meeting notes into a clear summary with decisions and follow-ups. Use when the user asks to organize meeting notes.
---

# Meeting notes

Follow the workflow here. Read supporting files with paths relative to this Skill directory.
```

The description should say both what the Skill does and when it should be used. Pi places names and descriptions in its initial context, then loads the full instructions and supporting files on demand. Keep referenced paths relative so the entire directory remains portable.

The directory is the interoperable format. To use AmpleFile's importer, package that directory in `.zip` or `.skill`, or import a standalone file named `SKILL.md`. A standalone import requires a `name`; Pi reports other format diagnostics through its lenient validator.

Import safety checks reject absolute or traversing paths, symbolic links, more than 10,000 archive entries, archives larger than 100 MB, individual expanded files larger than 100 MB, and total expanded content larger than 500 MB. A standalone `SKILL.md` is limited to 2 MB. These checks reduce archive risk; they do not prove that imported scripts are safe. People should inspect an unfamiliar pack before installing it.

If a developer places a Skill directory into a standard Pi scope by another trusted mechanism, AmpleFile discovers it through Pi even though the desktop importer itself accepts files and archives rather than a raw directory picker.

## Extensions

A [Pi Extension](https://pi.dev/docs/latest/extensions) is executable code that can add tools, commands, providers, event behavior, or other runtime capabilities. AmpleFile uses Pi's normal extension loader and adapts supported extension UI requests—such as confirmation, selection, text/editor input, notifications, status and working messages, text widgets, title/editor updates, OAuth handoffs, clipboard actions, and external links—to desktop UI. Terminal-only custom components, custom headers/footers, custom editor components, and autocomplete providers are reported as unsupported rather than pretending their TUI can render in React.

Extensions are more powerful than passive files and should be presented with their source, scope, load status, tools, commands, and diagnostics. Installing a native Pi Extension or registering a folder that already contains one is a full-user code-execution decision, not a content-import decision.

Pi's built-in tools remain available alongside loaded Extensions. AmpleFile does not replace them with a private tool registry.

Every tool family receives shared input-correction feedback on failed calls,
including failures rejected by native validation before execution. Reviewed
included schemas express operation-dependent inputs and target alternatives;
third-party schemas remain native. See [tool feedback](tool-feedback.md).

Workers are taught to create `.worker/<task-id>/` lazily for drafts, scripts,
intermediate data and renders, then deliver requested files outside that folder.
Existing project files are edited in place. `.worker/` is ordinary content:
it shows in the folder list like any other folder, and Search, History, and
attachments use their normal policies, including explicit ignore settings.
It is neither hidden metadata nor a private or automatically cleaned area.
Registration never creates it, and the AmpleFile Agent has no Connected Folder
scratch appendix. Existing contents and conflicting file/link/registered-folder
paths must be respected.

### Feedback and context inspection (development)

The AmpleFile Agent and Workers share concise guidance for inspecting the outcome
of their work using native tools and Skills. Text, data and image observations
follow Pi's existing tool-result path; native image settings and provider
conversion remain authoritative. A stopped native tool may still be draining:
its late activity is hidden and this Chat refuses overlapping work until Pi
settles, while other Chats continue.

The local `?dev-context` developer route opens **Inspect context**; normal
Chats, the AmpleFile Agent and Settings have no inspector entry. Enable **Record model
context** before the request to capture assembled instructions, messages and
tools, provider payloads where Pi exposes them, and loaded-source provenance.
The view includes host title, bounded inference, and compaction calls with
their own attribution. Independent transports inside third-party Extensions
are outside this recorder. Images appear as metadata. Recording is off by
default, bounded and memory-only; clearing, disabling and restart remove
recordings. Inspection never starts model work. See [the feedback
contract](tool-feedback.md) for fidelity and coverage limits.

### Live Extension questions

Ordinary Pi selection, confirmation, text input, and editor requests appear
inline in their owning Connected Folder Chat or AmpleFile Agent Chat. Multiple questions remain
separate; switching Chats and reconnecting restores the current pending set.
Typed responses are validated before the callback settles. A failed send keeps
the field available for retry.
Async context carries the originating task identity while that turn is live.
A later question from an ended turn or a reused connection belongs to the Chat
without borrowing a newer turn's task identity. Session-start and reload
callbacks likewise keep session ownership: their desktop questions can outlive
an ordinary turn. Stop cancels pending
callbacks and questions during native prompt draining. After draining, a
surviving connection may ask a new Chat-owned question; session disposal
permanently cancels that session's UI access.

These are live Pi callbacks, not durable collaboration questions. Stop,
timeout, session disposal and app shutdown cancel them. Restart never recreates
or auto-answers one. Extensions needing a question that ends the turn and
resumes after an answer use `chat ask` or `agent ask` instead. Native
third-party confirmations keep their meaning; AmpleFile does not silently
answer them or turn them into product approval cards.

The host allows eight pending questions per Chat, 64 total, 64 choices per
selection, and 64 KiB per question or answer. The enforcing code and
Settings → Automations → Limits read the same shared constants. Current questions travel as
transient snapshots, outside the Chat replay log. Extension-managed editor
text is scoped by root and conversation. Answer drafts stay in renderer memory
only; password drafts are not retained across navigation. Extensions themselves
remain full-trust and may record values they receive. Standard Pi text input
does not identify secrets; credential setup must use the appropriate desktop
setup surface, not an ordinary Chat question. Terminal-only component
factories remain unsupported.

[Extensions and computer work](extension-foundation.md) defines the included
Computer Control, Chrome, Web, Documents and MCP service connections. Their
pinned versions and reviewed compatibility patches live in
[the integration manifest](../patches/included-tools/manifest.json). “Included
with AmpleFile” describes maintenance, not a different Extension runtime.
AmpleFile also ships one Skill of its own outside the five tools:
`set-up-connected-folder` (`resources/included-tools/skills/`), which **Set Up for
Me** and **Just the Look** use (see [the product model](product-model.md)). It
is listed under **Everywhere** as Included with AmpleFile, and it can be turned
off through the same Pi path filter as any other resource, but never removed.
The Documents tool's own Skill is likewise turned off rather than removed.

The Installed view's **Included with AmpleFile** strip shows each included
tool's observed readiness as one concise status and offers **Set Up** only when a
person can act; enabled state and Pi load diagnostics stay in the tool's
details. Setup belongs to that tool: macOS permissions, the Chrome
companion, optional Brave search credentials, and native MCP server definitions
and authentication. Computer Control setup is one **Allow Computer Control**
button with a two-item permission checklist; Chrome setup is two steps, add the
AmpleFile extension from the Chrome Web Store and choose Connect in it, in either
order. Both also appear in first run's optional **Let your Worker
use your Mac** step, and their setup works with or without a Connected Folder; see
[Extensions and computer work](extension-foundation.md) and
[Chrome extension distribution](chrome-extension-distribution.md). A saved credential alone does not establish readiness.
Visible setup surfaces refresh cold host reads automatically. Successful tool use
supplies native readiness evidence without repeatedly pressing Check. Computer
permissions retain a visible timestamp and become neutral historical evidence
after five minutes; Check observes without helper repair or Chat disposal.
Documents proof belongs to the immutable running build. Service Connections
separates configuration from each connection's checked health. See the
[extension contract](extension-foundation.md#readiness-and-lifecycle) for the exact
observation and lifecycle boundaries.
Web defaults to DuckDuckGo without a key. Documents supplies ordinary libraries
and a cancellable JavaScript worker with continuable PDF observations. Its optional
installed-engine adapter uses LibreOffice for Office rendering/XLSX recalculation
and Tesseract for page-image OCR, reporting missing engines explicitly. Its tile
says Setup Needed while LibreOffice is missing, and its details guide the install
([Document verification](document-verification.md)). MCP sampling
is disabled for the embedded Pi version; stdio servers need their executable
and runtime installed. Setup details and remaining limits are in the contract.

### Declarative Extension surfaces

A loaded Extension may place a versioned `surface.json` manifest beside its entry point. The creation and lifecycle unit is the normal Pi package containing that Extension, its tools or connection logic, and the adjacent manifest. AmpleFile validates the static manifest and carries valid surfaces in the kernel's capability snapshot; the file manager window does not draw them. Manifests cannot provide HTML, scripts, styles, React modules, event handlers, or direct renderer access.

Surface discovery follows Pi's loaded Extension catalog rather than scanning arbitrary files. Everywhere surfaces load with their user-scope Extension. This Connected Folder surfaces load while their folder is registered and Pi loads the adjacent Extension. Invalid, oversized, linked, or unsupported manifests produce capability diagnostics and do not take down other Extensions. See [Extension surfaces](extension-surfaces.md) for the version 1 schema and limits.

A surface does not reduce the trust level of its owning Extension. Extension code still runs with the current user's permissions and can make network requests.

## Scopes

| Product label | Pi scope | Typical location | Availability |
|---|---|---|---|
| **Everywhere** | User/global | The configured Pi agent directory, normally `~/.pi/agent` | Available to the AmpleFile Agent and every Connected Folder. |
| **This Connected Folder only** | Project/local | `.pi/` inside the Connected Folder's folder | Portable with that folder and authorized while it is registered as a Connected Folder. |

Everywhere Skills commonly live below `~/.pi/agent/skills`; Everywhere Extensions below `~/.pi/agent/extensions`. Connected Folder–scoped equivalents live below `.pi/skills` and `.pi/extensions` in the Connected Folder. Pi also discovers global and project `.agents/skills` locations, packages, and paths added through settings. The Pi catalog is therefore the authority rather than a hard-coded directory scan in the renderer.

Everywhere scope (Pi's user scope) is for capabilities a person wants in every Connected Folder — it is what the AmpleFile Agent loads, too. This Connected Folder only scope is appropriate when a capability belongs with one activity or should travel with that folder. The Add dialog asks **Where should it live?** first, and a Discover details dialog asks it in the same review, with the same two-card chooser illustrated as the AmpleFile Agent above a row of Connected Folders so the reach of each option is visible before confirming. Scope does not indicate safety: personal executable code still deserves inspection.

## Registered Connected Folder authorization

Creating or registering a Connected Folder is AmpleFile's authorization to load project Skills, Extensions, packages, scripts, settings, and instructions from that exact folder. There is no second “Trust Connected Folder” prompt. The shared host authority derives from the Connected Folder registry and overrides Pi's independent project-trust decision only inside AmpleFile. Removing the Connected Folder revokes the AmpleFile authorization without rewriting Pi's trust store for other Pi clients.

This choice removes redundant ceremony; it does not certify the folder as safe. Existing native Pi Extension code can execute during the first catalog load, and `.pi` content can change later through local edits, source control, or a synchronization tool. Package installation review, external connections, provider credentials, and Chat attachments remain separate decisions.

Importing a Skill directly into **This Connected Folder only** requires a registered Connected Folder. Importing it for **Everywhere** is an explicit global install action and does not write to the Connected Folder.

## Packages

[Pi packages](https://pi.dev/docs/latest/packages) are a distribution and lifecycle mechanism. A package source can provide one or more Skills, Extensions, prompts, themes, or related resources. AmpleFile delegates installation and discovery to Pi's package manager rather than defining another package format.

Supported Pi sources include npm packages, git sources, HTTPS sources, and local paths. Npm and git sources require their corresponding command-line tools on `PATH`; local paths and direct Skill imports do not. Packages can be personal or project-scoped.

In product language, lead with the outcome (“install this Skill” or “add this Extension”) and show package source, scope, resource types, load state, and diagnostics as provenance. A package can be mixed: installing an item presented as a Skill may also load Extensions, prompts, themes, dependencies, or install scripts. The Discover details dialog must disclose that package boundary before installation: it shows the description, the where-chooser, what is inside (the Skills and Extensions found), one plain warning when the install can run code on the computer, and a collapsed **Technical details** section holding source, version and license, provenance, dependencies, and install scripts. Do not add **Packages** as a peer to Connected Folder or Skills & Extensions unless the product model is deliberately revisited.

AmpleFile delegates package update and removal to Pi so its settings, installed paths, pinned references, and deduplication rules stay authoritative. Project package installation, update, and removal require a registered target Connected Folder. Capability mutations are rejected while an affected Connected Folder has an active agent turn or Chat compaction; switching folders or minimizing the app must not let a catalog reload terminate background work.

Direct Skill imports and packages have different ownership semantics. Package-provided resources can be updated or removed through their package record. Direct-imported Skills have import receipts and a separate removal path that checks their recorded ownership. Removing an imported Skill is reversible: `.pi/` and Pi's own folder are outside History, so the whole Skill folder moves to **Recently Deleted** with its scope and its path inside that scope's skills folder, and the removal toast offers **Undo**. Restoring puts it back in the same scope at the same path under the same capability-mutation fencing and client reload as an install, so it loads with the next turn. A restore is refused, and the Skill stays in Recently Deleted, while a Skill of the same name is installed in that scope — Pi loads only the first Skill of a name — or something occupies its old path; a Connected Folder Skill also needs its Connected Folder registered. Per-resource enable/disable uses Pi's native filters for Extensions, Skills, prompts and themes, preserving unrelated resources, package patterns and scopes. Included resources use the same controls. The desktop and `tools enable|disable --path <resource-path> --kind extensions|skills|prompts|themes --scope everywhere|connected-folder [--connected-folder <id>]` share the prepared, identity-pinned, receipted operation. Affected active work blocks the change; clients are invalidated only after it succeeds. A package configured as a single Extension file cannot be filtered by Pi: AmpleFile explains that limitation and offers package removal rather than showing a false disabled state.

## Discovery sources

The Discover view combines sources without pretending they have one trust level:

- official Pi documentation and maintained first-party/reference repositories;
- the public Pi Skills examples;
- compatible Skills from Anthropic's public repository; and
- npm packages that opt into discovery with the `pi-package` keyword.

Results expose their source and link back to it. Search, type filters, and sorting by first-party/reference status, downloads, recency, or name help navigation. “Official,” download counts, and recency are provenance or popularity signals—not signatures, malware scans, or endorsements. Every third-party package still requires source review, especially when it includes Extensions or lifecycle scripts.

## Authentication and external connections

**Settings → AI Models** separates **Model** from **Provider connections**.
The model picker searches every connected provider's chat models, grouped by
provider and vendor. Its closed control shows the model and connection name;
selection uses the provider/model pair so identical model IDs remain distinct.
Provider connections groups saved connections above available providers and
shows the credential's actual source and its machine-wide scope.
API-key entry is masked with an explicit Show/Hide control. A saved API key
can be replaced through **Change API Key** without removing it first; Cancel
clears the entered replacement and keeps the saved key. Provider connections
are shared; **Save Model** separately saves the displayed Worker's or AmpleFile
agent's model. Connecting or replacing a credential preserves model drafts and
does not save a new model default. Foundry's **Save Azure settings** (OpenAI)
or **Save Foundry settings** saves that connection's endpoint, deployment names,
and optional base-model choices; selecting a deployment uses **Save Model**.
Failed saves keep the entered key for correction;
successful saves clear it. Keys are never read back into the form or carried
across provider or scope changes. Account sign-in and Azure deployment setup
continue through their existing provider-specific paths.

The provider list and account buttons use Pi's complete native provider catalog
and authentication metadata, including providers with no chat models. **Guided
setup** runs Pi's API-key interaction, preserving all returned provider settings
(for example Cloudflare account/gateway IDs, AWS profiles and Vertex credentials).
Account sign-in passes Pi's lazily created installation UUID from global settings;
project settings cannot supply it. Pi owns token exchange, refresh and request auth,
and the desktop persists the full credential through the encrypted host store.
Setup refreshes only that provider's catalog with a bounded network request.
Neither a saved credential nor a successful catalog refresh proves inference or
account eligibility. Provider information and callback prompts remain on trusted
desktop surfaces; credentials never enter the renderer's status response.

In **Settings → AI Models**, Microsoft Foundry accepts an endpoint, an API key,
and **Deployment names**, separated by commas or new lines. Copy the Name
under Deployment info in Azure. These names become the Azure model choices;
there is no prerequisite catalog-model selection or user-written mapping.
Choose the deployment this Worker or the AmpleFile Agent uses in the model
picker after saving the connection. Three independently saved Pi providers can
coexist: **Microsoft Foundry / Azure (OpenAI)** (`azure`, preserving existing
connections), **Microsoft Foundry (Chat Completions)** (`azure-chat-completions`),
and **Microsoft Foundry (Anthropic)** (`azure-anthropic`). Each has its own key,
endpoint, and deployment names. OpenAI resource and full inference URLs normalize
to `/openai/v1`; Claude resource and Messages URLs normalize to `/anthropic`.
An endpoint for the other protocol is rejected. The original Azure/OpenAI
provider retains Pi's per-model Responses or Chat Completions choice, including
existing saved deployments. The separate Chat Completions provider selects
that format explicitly. Portal `api-version` queries
are removed; the Azure Responses transport retains its native Pi `v1` setting.

AmpleFile registers the entered names through Pi's native ModelRuntime on
each runtime load. Model metadata uses Pi's catalog where available. The
original Azure provider retains Pi's CLI fallback policy for compatibility;
new Chat Completions and Anthropic connections use Pi's generic custom-model
limits for unknown aliases (128,000 context tokens, 16,384 output tokens, no
reasoning claim or known price; text input for Chat Completions, text and image
input for Anthropic). The selector labels unmatched names **Default limits
(no matching Pi model)**. **Deployment model details** optionally selects a base-model id from
Pi's Azure or Anthropic catalog for each custom name. Explicit ids are validated
before any credential changes. A saved base-model id removed from Pi's catalog
leaves only that deployment unavailable; Settings stays usable, exposes the
saved selection, and lets the person repair it or remove the connection.
The request's model ID is always the exact entered deployment name,
even when Pi's fuzzy matcher suggests a catalog entry. Pi `models.json`
model definitions and overrides remain available. Registrations select Pi's
`azure-openai-responses`, `openai-completions`, or `anthropic-messages` adapter;
AmpleFile adds no inference transport or response parser. Saved connections
register as native Pi providers, so the person's `models.json` definitions and
overrides compose above the app's declarations. Unsaved placeholders preserve
existing user-defined providers. Foundry Anthropic metadata disables the
unsupported server-side `fallbacks` parameter and caps Sonnet 4.5 at Foundry's
200,000-token context limit. The selected connection
owns its endpoint and key; Pi's request-time `ModelAuth.baseUrl` binds that key
to the saved endpoint even when `models.json` declares another base URL. Model
definitions sharing that provider id use the same saved connection; separate
resources/keys need separate provider ids. Headers from a source model are not copied to it.

Settings persist in the provider credential's Pi `env` values:
`AZURE_OPENAI_BASE_URL` (OpenAI) or `ANTHROPIC_FOUNDRY_BASE_URL` (Anthropic),
`AZURE_OPENAI_API_VERSION`, the JSON name list
`AMPLEFILE_AZURE_OPENAI_DEPLOYMENTS`, and optional native base-model ids in
`AMPLEFILE_FOUNDRY_MODEL_IDS`. Identity mappings in
`AZURE_OPENAI_DEPLOYMENT_NAME_MAP` keep ambient aliases from redirecting the
entered names. The desktop uses its existing encrypted CredentialStore host;
these settings are shared across Connected Folders and the AmpleFile Agent. Saving
with a blank key preserves the current key or Azure API-key environment
reference. The encrypted host store delegates key-reference resolution to Pi's
native in-memory CredentialStore for `$ENV` references. API-key text starting
with `!` stays literal in desktop credential storage; executable credential
configuration stays in Pi's `models.json` path. Deployment
edits preserve the raw stored reference, and first connections can use a key
already supplied through the provider environment. The form only reads back the endpoint and names, never the key or
other provider environment values. Removing the stored credential removes
its stored connection settings; external environment configuration can still
apply. Removing one connection leaves the other formats connected. Saving
validates configuration without making a paid inference request, claiming the
connection was tested, or discovering or creating deployments. API-key setup
covers compatible chat deployments; Entra authentication and image-generation,
embedding, audio, and other non-chat operations are not part of this form.

For a model outside Pi's Azure base-model catalog, native `models.json`
`modelOverrides` can supply the deployment's exact capabilities. For example:

```json
{
  "providers": {
    "azure-chat-completions": {
      "modelOverrides": {
        "my-llama-deployment": {
          "contextWindow": 131072,
          "maxTokens": 16384,
          "input": ["text"],
          "reasoning": false
        }
      }
    }
  }
}
```

Use the limits and capabilities of the actual deployment; the example is not a
claim about every Llama model. Malformed saved Foundry metadata disables only
that connection and shows a correction/removal message in Settings. Raw
parser errors and credential-store values are never returned to the renderer.
While those settings are malformed, its stored key is unavailable to inference,
including additional `models.json` definitions, until it is repaired or removed.

Endpoint and API-key requirements were checked against Microsoft's
[Foundry endpoints](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints)
and [Claude deployment guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude),
and Anthropic's [Claude in Foundry guide](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry).

Model-provider credentials belong to **Settings → AI Models** and application/Pi storage, never to a Connected Folder. They are machine-wide connections. The selected provider/model pair is a separate machine-local preference keyed by portable Connected Folder identity, with one additional preference for the AmpleFile Agent; each Connected Folder may also keep bounded machine-local **Connected Folder instructions** under that same identity. Instructions are appended through Pi's native system-prompt override after AmpleFile's required prompt, never written into `.amplefile/` or `.pi/`, and sent to the selected provider with every subsequent turn in that Connected Folder. The AmpleFile Agent may inspect and change a Connected Folder's model default and instructions through `connected-folders worker`, but it cannot enter, replace, remove, or inspect provider credentials. The desktop path supports API-key setup and exposes Pi's provider OAuth flows when a provider advertises one. AmpleFile opens the provider URL in the system browser, handles device-code and manual-code prompts in native desktop UI, and persists the result through its existing encrypted Pi CredentialStore host. OpenRouter's tool-capable text-model list can be refreshed explicitly from its live API; normalized model metadata and the last successful response are cached in app state without the credential and injected into each fresh cwd-specific Pi registry so display and execution use the same catalog. A failed refresh keeps the previous live cache or Pi's built-in catalog. Support must still be described provider by provider: the presence of a Pi OAuth implementation is not proof that every account tier, billing policy, or packaged release flow has been verified.

Likewise, an Extension can implement an external connection, but that does not make the core app a native integration with that service. Google Drive currently works by registering a folder synchronized through Google Drive for desktop. Direct Drive API synchronization remains future provider-adapter work.

## Capability checklist

For every new agent capability, keep these answers visible in code and UI:

1. What will the agent gain: instructions, files, tools, commands, or network access?
2. Where did it come from?
3. Is it Everywhere or This Connected Folder only?
4. Which Connected Folder and connections does it reach?
5. Is it enabled, loaded, ready, missing setup, or failing diagnostics?
6. How can the person update, disable, remove, or revoke it?

The Pi catalog and import/install surfaces expose provenance, scope, status, diagnostics, package update/removal, native per-resource enable/disable, and direct-import receipts/removal. Full-trust Pi resources retain Pi's authority model. Named Anthropic-pack selection remains lifecycle work to complete.

Management adapters must preserve that checklist. Inventory is not authorization: seeing a capability through the kernel or CLI does not grant it to a Chat or permit another actor to mutate it.

## Pi 1.1 runtime

The desktop embeds Pi 1.1.0. Its native codemode and tool_search factories are
loaded through Pi's ordinary resource loader and enabled alongside default tools
when no explicit `defaultTools` setting exists. Native filters and replacements
remain authoritative. Codemode can call ordinary and MCP tools plus image and
classifier models; the Worker model chooser stays limited to chat models.
Settings → AI Models exposes all provider connections, including providers whose
catalog contains only image/classifier models. Their usage flows through native
Pi session totals into the accepted turn receipt.

Pi's economical cache warming runs while an accepted turn is streaming. `off` is
respected; `idle` is bounded to `streaming` in AmpleFile without changing the
personal settings file, so no model spend starts after request settlement.
Canonical session messages, context edits and compaction are Pi-owned; portable
Chat text and its activity trail remain projections.
