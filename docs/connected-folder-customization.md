# Connected Folder customization

AmpleFile treats appearance as a safe, machine-local identity layer for a Connected Folder. It is deliberately
smaller than a CSS theme engine: people and agents may choose bounded identity values, while AmpleFile
continues to own navigation, permission UI, native chrome, hit targets, accessibility, and layout
integrity.

Read [the visual system](visual-design.md) for the invariant shell rules.

## Person-facing experience

**Customize Connected Folder** opens a popup dialog from the toolbar's **Action** (⋯) menu, a Connected
Folder's right-click menu in the sidebar, or **Customize This Connected Folder** in **Settings →
Appearance**. Like Settings and Skills & Extensions, it contains keyboard focus and closes with Escape,
its close button, or a click outside. It stays pinned to the Connected Folder it was opened for and
leaves the folder shown and any running Chat in place.

Customize is one scrolling page. The Connected Folder's name (editable in place) and a preview of its
folder stay in fixed positions; the **Icon** and **Color** sections below scroll. The file manager draws
each Connected Folder as a folder in its color with its icon stamped on it, as macOS draws a symbol on a
folder, so the preview shows exactly that. The editor keeps the common path direct:

- browse Popular, Nature, Life, Creative, Travel, Work, or All in the searchable Fluent icon catalog;
- choose a labeled accent preset or a custom color;
- see a warning when the accent does not meet its contrast targets;
- **Undo** the latest edits, **Reset** the Connected Folder, or, under **More**, **Import** or
  **Export** a code-free appearance proposal.

The footer's **Model** and **Instructions** shortcuts open **Settings → AI Models** pinned to this
Connected Folder, even when the popup was opened for a Connected Folder other than the one shown.
Settings shows a back arrow beside its title only when entered through these shortcuts; it returns to
the same Connected Folder and the section that was at the top of the page. Closing Settings or opening
it through a normal entry clears that return path.

Every edit repaints that Connected Folder everywhere it appears in the window. Appearance is
application state on this computer. It is not written into the Connected Folder's `.amplefile/`
directory and does not travel with ordinary files.

Undo keeps the latest 20 edits for the current app session. Durable state keeps the latest committed
appearance plus a last-known-good backup; it is not a persistent theme-history system.

## Banner fields

A Connected Folder's saved appearance can also hold a banner. The file manager window does not draw
it, but proposals, `amplefile connected-folders appearance apply --banner-image`, and **Set Up for Me**
can set it, and the store keeps it:

- `bannerLayout` is `card`, `compact`, `band`, or `cover`; a missing value is Card.
- `bannerTitleFill` is `frosted`, `solid`, `accent`, or `none`, and `bannerIconStyle` is `none`,
  `plain`, `square`, or `circle`.
- `bannerPreset` is one of four stable preset ids (Tide, Ember, Fold, or Dusk, shipped as local WebP
  assets), never an arbitrary asset URL or a copy of the image. A safe uploaded `bannerImage` takes
  precedence if an imported proposal contains both.
- `bannerFraming` holds finite `x` and `y` percentages in 0–100 and `zoom` in 1–2. Invalid framing is
  discarded.

Presets, framing, and icons use the same version-2 normalization, durable store, and proposal round
trips as colors.

## Semantic colour contract

`src/shared/connected-folder-appearance.ts` is the shared pure contract. A stored accent retains the exact
hex as `referenceHex` and records its OKLCH hue and requested chroma. The resolver emits separate
light and dark values for text, glyphs, solid fills, on-solid text, soft fills, state and decorative
borders, focus decoration, indicators, and banner endpoints.

WCAG 2.2 is the conformance gate. APCA is a supplemental gate for perceptual quality; a role
must satisfy both when an APCA target exists. Foreground roles are checked against both the ordinary
surface and the final composited soft fill. The resolver never accepts CSS or JavaScript.

Banner gradients and user images are advisory visual cases because their contrast depends on
position or arbitrary pixels. The UI labels that limitation instead of claiming they are certified.

## Persistence

`ConnectedFolderAppearanceStore` owns version-2 `appearance.json` beneath AmpleFile's application-data
root. Writes use a same-directory temporary file, restrictive file mode, file sync, atomic replacement,
and a last-known-good backup for recovery. Unsupported future versions fail closed and stay
byte-for-byte untouched. The renderer reads the snapshot from `/api/bootstrap` and writes through the
token-authenticated local renderer API.

A Connected Folder with nothing saved shows one of twelve starting colors, picked from its id
(`defaultConnectedFolderAccent`). A newly created or newly registered Connected Folder instead starts in
the starting color the fewest other Connected Folders use, so the first twelve all differ; the local API
saves that choice as its primary accent only when it differs from the id's own pick. A folder that
already carried a Connected Folder identity keeps its color, and a saved choice always wins. A window
that loaded earlier takes saved appearance only for Connected Folders it has none for.

## Agent and harness workflow

Codex, Claude Code, and any other shell-capable development harness use the same checked-in command:

```bash
npm run --silent amplefile:appearance -- create \
  --name "Client work" \
  --color "#0d74ce" \
  --secondary "#6550b9" \
  --icon briefcase \
  --banner aurora \
  --created-by codex \
  --out client-work.amplefile.json

npm run --silent amplefile:appearance -- validate client-work.amplefile.json --json
npm run --silent amplefile:appearance -- resolve client-work.amplefile.json --json
```

Use `--created-by claude-code` from Claude Code. `--banner-image <path>` accepts PNG, JPEG, WebP, GIF,
or BMP, resizes it within 1600×640, and stores a bounded WebP data URL. Run
`npm run --silent amplefile:appearance -- help` for all options.
`--banner-layout cover` selects a layout; `--title-fill accent` and `--icon-style circle` set the title.
`--banner-preset fold` selects a bundled image; `--frame-x`, `--frame-y`, and `--zoom` set its framing.
The same flags can frame an uploaded image. Creating a proposal is inert and never edits a Connected
Folder.

The result is inert:

```json
{
  "kind": "amplefile.connected-folder-appearance",
  "version": 1,
  "name": "Client work",
  "customization": {
    "schema": 2,
    "primary": {
      "schema": 2,
      "hue": 252.12,
      "chroma": 0.16,
      "referenceHex": "#0d74ce"
    },
    "iconName": "briefcase",
    "bannerName": "aurora"
  },
  "createdBy": "codex"
}
```

The proposal command has no `apply` operation. A person imports the file into the target Connected
Folder and sees the resolved preview. Applying a preset is a mutation, and the protocol-v1 management
CLI is read-only. The receipted application path is the act lane's
`amplefile connected-folders appearance apply|reset|undo`, which accepts only the same typed proposal
file, journals before mutating, records the prior customization for one-act undo, and requires the
running app's per-launch act token — the authenticated, scoped, replay-protected, receipted transport
defined in [the AmpleFile agent and CLI](amplefile-agent-and-cli.md). The npm-script primitive stays
inert and import-only.

`amplefile connected-folders appearance apply` can also change just the parts named instead of importing
a proposal: `--banner-image <path>`, `--icon <name>`, and `--color <#rrggbb>`, in any combination (never
with `--proposal`). Each named part replaces only itself, and the rest of the appearance stays. The
banner image is read host-side, resized to fit 1600×640, and stored as the same bounded data URL an
upload uses, with any preset and framing cleared so it shows whole. It is the same journaled act with
the same one-step undo. A Worker uses it to make a picture from
[image generation](image-generation.md) the Connected Folder's banner.

## Verification

The normal gates cover the shared contract, the store, the renderer API, the UI structure, and the
package:

```bash
npm run check
npm test
npm run desktop:prepare
```

For visual acceptance, exercise Customize Connected Folder in light and dark at the standard window
sizes in [the visual system](visual-design.md), including a custom color, an icon search, undo, reset,
proposal export, and proposal import.
