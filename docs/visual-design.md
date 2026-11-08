# AmpleFile visual system

AmpleFile uses a quiet desktop-tool aesthetic. The interface should feel native, legible, and deliberate before it feels customizable.

## Brand

- The mark is **Manila**: a manila folder with one Signal dot, the Worker. Its sources live in `desktop/assets/brand/` (see its README): flat SVG masters (full, optically redrawn small, and the menu-bar outline), the outlined wordmark and lockup, and the Icon Composer app icon `AmpleFile.icon` with Apple's own exports. `npm run desktop:icons` builds every installed icon, the dark-theme lockup, and the favicons from them; no surface keeps a private or redrawn copy of the mark.
- Brand colors: Manila `#EFCB7E` (folder front), Manila Deep `#D4A14F` (folder back), Ink `#16202B` (lettering), Signal Blue `#1F63D6` (the dot and the i's tittle), and Light `#F4F5F6` (the icon field). They belong to the mark, the website, and launch moments; the interface keeps its own native palette.
- The interface pairs body ink (`#1c2530`) with the bright blue interactive accent (`#0b6fd6` on light fields, `#1ea0ff` on dark). The Original light palette builds on the `#e9eae6` neutral field; the Original dark palette builds on charcoal (`#202425` canvas). Filled accent controls use the paired contrast color, never white-on-bright-blue.
- In-app lockups are the outlined brand lockup as one image: Ink lettering on light themes, light lettering on dark. The menu-bar icon is an outline folder whose dot is its own shape, so it pulses while work is running (still under Reduce Motion).
- Tokens live in `web-local/src/brand.css` and `web-local/src/styles.css` (desktop shell) and `web-local/src/popover/popover.css` (the AmpleFile Agent popover); `tests/amplefile-brand.test.ts` guards the contract.

## Information hierarchy

- The window is the file manager; see the [product model](product-model.md#the-file-manager-window).
- The sidebar lists **Standard Folders**, then **Connected Folders**; selecting one shows its contents. A **Connected Folder** is a root folder, not a peer navigation surface.
- The contents list the folder's Files. The Worker panel beside them holds **Info**, the Chats a person opens from it, and **History**, with the message box for the folder or file shown.
- Skills & Extensions and Settings open from the toolbar's Action (⋯) menu as dialogs; provider, model, and authentication controls live in Settings → AI Models.

## Iconography

- Use Fluent System Icons for shell navigation, commands, status, and empty states.
- Use regular icons at rest and the matching filled icon for a selected navigation item.
- Use 16px icons for inline actions, 20px for section markers, and no more than 24px for empty states.
- Material file-type icons retain their familiar type colors; other shell controls retain Fluent icons.
- Keep icon-library exceptions limited to those named controls. The Connected Folder glyph appears only where it identifies the folder: stamped on its tinted folder in the sidebar and lists.
- Connected Folder color may appear as the folder's tint, a small accent, or an active indicator, never as a frame around the application.

## Typography and spacing

- The app defaults to the bundled brand fonts: Inter Variable for body copy and controls, Poppins SemiBold (600) for interface headings. Markdown-rendered conversation and document content keeps the body face. Body copy is 15px; interface weights are 400, 500, 600, and 700 only; the fonts ship with the app, never from a CDN.
- Every interface font size is one step of the type scale in `web-local/src/brand.css` (`--amplefile-type-2xs` through `--amplefile-type-2xl`: 11, 12, 13, 14, 15, 17, 20, and 24px at Standard). The steps are in rem, so Text Size scales the whole interface. Nothing renders below 11px, which is reserved for badges, keycaps, and small labels; metadata and captions are 12px; section and dialog titles are 17px and page titles 20px.
- Headings, navigation, tab labels, menu items, buttons, field labels, options, and status words are Title Case; sentences, hints, placeholders, toasts, and errors are sentence case. **Connected Folder** is capitalized everywhere, in labels and in sentences, like **Worker**; **AmpleFile Agent** keeps "agent" lowercase in sentences.
- User-selected fonts and text sizes may change type, but must not change shell geometry or push controls out of bounds.
- Use the 4, 8, 12, 16, 24, and 32px spacing scale, with 2, 6, 10, and 20px half-steps inside dense controls.
- Text colors come from the palette (`--ui-text`, `--ui-text-muted`), not hard-coded grays. Muted text keeps at least 4.6:1 contrast on every surface it sits on, in every palette and theme; disabled controls stay legible (about 3.5:1) instead of fading.
- Controls come in three heights (`--amplefile-control-sm/md/lg` in `brand.css`): 24px small icon actions, 30px buttons, toolbar icons, and pane search fields, and 36px form fields and search in dialogs and Settings, with 5px radii. List density scales the file manager's rows (0.86× compact, 1.2× spacious), with larger touch targets when the platform requests them.
- Controls keep the arrow pointer, as in a native app; hover and press states show they are clickable. Only links inside Chat messages show the pointing hand.
- Menus and popovers in dark mode carry a hairline light edge and a deeper shadow so they read as containers above the window.
- Every text button has a visible shape at rest: a fill and a hairline edge (`--ui-button-fill`, `--ui-button-edge`), clearly lighter than the surface in dark mode, and the shared control hover fill. Destructive buttons keep that shape with red text. Icon-only toolbar buttons, list rows, tabs, chips, and menu items stay flat until hovered. Labels that could wrap at the minimum window width stay on one line, shortened with an ellipsis and a tooltip where needed.
- Avoid all-caps labels, weight 800+, text shadows, ornamental whole-app gradients, and oversized hero headers.

## Layout

- Color and icon identity follow the Connected Folder that owns the content. Content belonging to another Connected Folder carries that Connected Folder's own identity rather than the one shown.
- The Skills & Extensions Installed view places the Included with AmpleFile strip above Everywhere and This Connected Folder only, which sit side by side and stack on narrow widths; rows open their details on click.
- Skills & Extensions uses compact view tabs beside Add Custom and one aligned search/filter toolbar. Discover listings have text-only names, types, descriptions, provenance and source links, with the same gutters as their heading and search. Installed rows use neutral type glyphs; the five included tools keep their recognizable icons and palette-derived tile borders.
- Hover fills the existing control or row hit area in 110ms without lifting, scaling, or adding an outline. Pressed fills are stronger, and a button settles to 96% while it is held; keyboard focus retains its independent outline. Selected rows deepen their Connected Folder tint on hover. Neutral and primary states resolve through the selected application palette and accent; Send retains its owning Connected Folder accent. Disabled controls do not react.
- Floating menus have an opaque palette surface and one shared shadow. Settings groups use spacing instead of nested frames; editable fields and data tables keep their visible boundaries.
- Settings → AI Models chooses its scope with two large buttons (**This Worker**, naming the Connected Folder, and **AmpleFile Agent**) rather than radio circles; its model is a dropdown that shows the chosen model closed and opens with a search box at the top and vendor headings, closing again on a choice. Settings → Automations keeps Limits collapsed under a disclosure by default.
- Settings → Appearance starts with a labeled Preview, followed by Presets, without a reserved success-notice strip. AI Models places Save Model at the right of its action row.
- User Chat bubbles use the contrast-solved soft Connected Folder accent and its matching reading foreground; Quiet uses the selected neutral surface. Copy sits at the right edge beneath the user bubble, with its timestamp revealed to its left on hover or keyboard focus. Agent message headers are text-only and do not repeat a decorative agent avatar.
- Forms use stacked labels and hints with an explicit action row.
- Notices use `icon | copy | action` and stack only when their own pane becomes narrow.
- Empty states are centered, restrained, and no wider than 440px.
- Resizable panes must adapt to their own width; prefer container queries to viewport-only breakpoints.

## Motion

Motion confirms what happened and where things went; it never decorates. Entrances live in `web-local/src/motion.css`; exits, glides, and the reply-landed moment are played by `web-local/src/lib/motion.ts`.

- Anything a person triggers finishes within about 250ms, and exits run at roughly two-thirds the length of entrances. Durations come from `--amplefile-motion-base` (180ms) and `--amplefile-motion-slow` (260ms) with the shared `--amplefile-ease-smooth` curve; only confirmations use `--amplefile-ease-pop`.
- Dialogs: the backdrop fades in while the window rises 8px and scales up from 97%; on close the window settles back as it fades in 150ms. Menus and popovers grow from the side of the control they open from in 150ms and fade out in 110ms.
- Notices slide out to the right and the stack closes the gap.
- A Worker's dot pops in when its turn starts; when the reply lands it pops once and sends out one ring. Copied checks pop once. Settings pages fade up as they open.
- The file manager says where things came from: nested Connected Folders grow in under their parent one after another and collapse away; the Info/History thumb slides to the chosen tab and the pane comes in from that side; a Chat pushes in from the right and Back slides the panel in from the left; a folder you go to slides in from the right going deeper or forward and from the left going up or back, once its items are loaded; first-run steps slide the same way; the Worker's receipt rises in and collapses away on Done; suggestions rise one after another; the Go to Folder sheet drops in and fades out; dots pop in; buttons answer a press. Each uses the motion tokens and both reduce-motion switches remove it.
- Streamed replies and background refreshes never animate. A leaving element is an inert copy excluded from focus, clicks, and the shell's live-element queries, and a replacement (such as the next confirmation) swaps at once. Application Reduce Motion and the operating system preference both remove every animation, including scripted effects already running, and remove existing leaving copies; no new leaving copy is made.

## macOS chrome

- Use the hidden-inset native macOS title bar, traffic lights, application menu, and Window menu.
- Reserve one 32px drag strip above the panes, without stacking the normal 12px page gutter below it.
- Keep Settings and About in the application menu, standard editing roles in Edit, and minimize/zoom/front roles in Window.
- Use sidebar vibrancy only for structural chrome when reduced transparency is off. Keep work surfaces opaque and fall back to theme-matched solid chrome.
- Use the macOS system accent color, shortcut glyphs, and native overlay scrollbars without changing the shared interaction contract.
- Support Finder-oriented file behavior: Show in Finder, Quick Look, represented Connected Folders, and recent Connected Folder documents. Keep all host actions path-confined to the owning Connected Folder.

## Visual acceptance

Before a handoff, exercise every primary surface and every Settings section in light and dark themes at 1440×900, 1280×800, and a tall/narrow desktop window. Reject the candidate for:

- overlapping or concatenated copy;
- clipped labels or controls;
- horizontal page overflow;
- full-width buttons without an intentional form layout;
- mixed shell icon weights or sizes;
- repeated decorative identity graphics;
- empty states that leave unexplained split-pane chrome;
- focus, hover, active, and disabled states that are not visually distinct.

For Electron-integrated changes, repeat a packaged-app pass that confirms sidebar vibrancy or its solid fallback, light/dark/system transitions, native menus, updater state, and the minimum window size. Browser fixtures cannot prove native material or titlebar behavior.

## Appearance scopes

- **Settings → Appearance** controls the application theme, font, and text size.
- **Customize Connected Folder** controls one Connected Folder's name, accent, and Fluent identity icon.
- Customize Connected Folder opens a popup from the Action menu, a Connected Folder's right-click menu, or Settings → Appearance, pinned to that Connected Folder. Changes repaint every identity consumer immediately.
- Per–Connected Folder appearance is personal application state. It is not written into the user's ordinary folder and does not travel with shared files.
- The editor previews the Connected Folder's tinted folder and warns when the accent fails the semantic contrast audit.
- The name and preview keep the same position; only the Icon and Color sections scroll. Color
  offers labeled accent swatches and a custom color. Icons start with a small Popular selection and
  add Nature, Life, Creative, Travel, Work, and All filters with larger 24px glyphs. Keep utility copy
  short. Worker shortcuts open the Connected Folder–scoped model and instruction settings.
- Malformed stored values are rejected.
- Every Connected Folder appearance control updates the preview, saves immediately, and offers Undo and Reset. Import/export uses the same typed, code-free proposal format as the agent harness.
- Layout order, native chrome, permission UI, target sizes, and non-colour state indicators are invariants, not customization options.

See [Connected Folder customization](connected-folder-customization.md) for the resolver, persistence, and harness contract,
[the product model](product-model.md) for the window's interaction contract, and
[Architecture](architecture.md) for the native/renderer boundary.

## Stylesheets and preferences

`web-local/src/styles.css` is the canonical desktop stylesheet, with the file manager's own rules in `web-local/src/components/file-manager/file-manager.css`. Shared actions use `ui-control` with primary, quiet, or icon variants; feature classes own their layout. Brand artwork and the shared application preference sheet keep their separate contracts.

`src/shared/application-appearance.ts` is authoritative for palettes, custom accents, fonts, reading size/measure/spacing, density, and accessibility. `application-appearance.css` projects those same preferences into the desktop and menu-bar renderer. Connected Folder colors and icons stay independent; no design selector overrides saved palette variables. The message box owns its complete focus boundary, using the owning Connected Folder's contrast-solved state border.
