# Application appearance

## Design

The visual thesis is a quiet, readable place to work whose materials and typography feel personal while
its navigation stays familiar. **Settings → Appearance** starts with a **Preview** — a small file
manager window drawn in the current choices, with **Undo** and **Reset** — and the built-in
**Presets**, then **Color**, **Interface**, **Conversations**, **Accessibility**, and **Saved
Presets**. At the end, **Customize This Connected Folder** opens the Connected Folder's own
identity popup.

Selection feedback is immediate; the preview follows the actual controls. Hover and focus use the
short shared transitions. Settings opens like every dialog, and each page fades up as it opens
([Motion](visual-design.md#motion)). Reduced motion removes those transitions and animations.

Application preferences describe the person's working environment. Connected Folder appearance
describes the working context. Changing the former never overwrites a Connected Folder's color, icon,
banner, or portable content. Native window controls, navigation order, minimum targets, action
semantics, and non-color status cues stay invariant.

## Contract and scope

Application appearance is a versioned, code-free preference record. It includes color mode, surface
palette, accent, interface font and text size, list density, conversation font, size, width, and line
spacing, code font, how the person's own messages look, which Worker steps stay visible while a turn
runs (every step, or only the current one), contrast, motion, and transparency. Semantic accent roles
reuse the Connected Folder appearance color solver against the chosen application surfaces. A raw
accent color is never used as both text and a button fill.

Preferences and named presets are saved on this device in renderer storage. The file manager window,
its dialogs, and the menu-bar conversation share them. Preferences do not synchronize through an
account or to another origin.

Built-in presets are starting points, not locked themes. Custom presets capture the current
preferences and can be saved under a name, replaced by saving with the same name, removed, exported,
and imported as validated JSON. Import adds a saved preset; applying it is a separate, explicit choice.
Import accepts only the current typed contract, bounded names, and known values; it never loads CSS,
scripts, fonts, URLs, or images. Connected Folder appearance proposals are a separate contract.

Every change is immediate. Undo keeps the most recent 20 preference changes in the current renderer
session; Reset restores the defaults and can itself be undone. Device accessibility preferences always
apply. The person can additionally choose reduced motion, opaque surfaces, or higher contrast inside
AmpleFile. Applying a preset cannot weaken those explicit preferences.

Reading never writes storage. The first explicit change saves `amplefile.application-appearance.v1`; a
second record holds up to 24 named presets. A record or preset from an earlier schema version reads
with the newer settings at their defaults, and the next explicit change rewrites it at the current
version. An unsupported future record stays untouched even after an explicit change: the UI marks such
changes as window-only. A storage failure never reports a successful save. Cross-window storage events
refresh the sibling renderer without writing back, and invalidate stale undo history.

Preset files are at most 16 KiB, have names of 1–60 characters, and contain only the current schema's
closed enums, integer reading size, and validated six-digit accent. Local font stacks have system
fallbacks and never trigger font downloads. Changing global surfaces re-solves each Connected Folder's
accent against those actual surfaces while preserving its underlying identity. Primary actions use the
solver's soft fill and text UI role, which is checked against that composited fill. Send and the
menu-bar primary action keep the matched solid/on-solid pair. Links, focus, and subtle selection use
their own roles. List density sets the row height of the folder list and other lists.

## Verification

Exercise invalid and future records, preset import/export, persistence failure, cross-window updates,
undo/reset, device accent changes, and both mode variants. Inspect Settings at narrow widths, enlarged
reading text, each palette, and high contrast. Verify actual conversation and file-list styling as
well as the illustrative preview. No provider calls are needed.
