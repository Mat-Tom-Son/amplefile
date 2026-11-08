# AmpleFile visual system

AmpleFile uses a quiet desktop-tool aesthetic. The interface should feel native, legible, and deliberate before it feels customizable.

## Brand

- The mark is **Manila** (2026-11-07): a manila folder with one Signal dot, the Worker. Its sources live in `desktop/assets/brand/` (see its README): flat SVG masters (full, optically redrawn small, and the menu-bar outline), the outlined wordmark and lockup, and the Icon Composer app icon `AmpleFile.icon` with Apple's own exports. `npm run desktop:icons` builds every installed icon, the dark-theme lockup, and the favicons from them; no surface keeps a private or redrawn copy of the mark.
- Brand colors: Manila `#EFCB7E` (folder front), Manila Deep `#D4A14F` (folder back), Ink `#16202B` (lettering), Signal Blue `#1F63D6` (the dot and the i's tittle), and Light `#F4F5F6` (the icon field). They belong to the mark, the website, and launch moments; the interface keeps its own native palette.
- The interface pairs body ink (`#1c2530`) with the bright blue interactive accent (`#0b6fd6` on light fields, `#1ea0ff` on dark). The Original light palette builds on the `#e9eae6` neutral field; the Original dark palette builds on charcoal (`#202425` canvas). Filled accent controls use the paired contrast color, never white-on-bright-blue.
- In-app lockups are the outlined brand lockup as one image: Ink lettering on light themes, light lettering on dark. The menu-bar icon is an outline folder whose dot is its own shape, so it pulses while work is running (still under Reduce Motion).
- Tokens live in `web-local/src/brand.css` and `web-local/src/styles.css` (desktop shell) and `web-local/src/popover/popover.css` (the AmpleFile agent popover); `tests/amplefile-brand.test.ts` guards the contract.

## Information hierarchy

- The window is the file manager, the only layout (the classic rail-and-tabs layout was removed on 2026-11-07); see the [product model](product-model.md#2026-11-06-file-manager-layout).
- The sidebar lists **Standard Folders**, then **Connected Folders**; selecting one shows its contents. A **Connected Folder** is a root folder, not a peer navigation surface.
- The Worker panel beside the contents holds **Info** and **History** and the message box for the folder or file shown.
- Skills & Extensions and Settings open from the toolbar's Action (⋯) menu as dialogs; provider, model, and authentication controls live in Settings → AI Models.

## Iconography

- Use Fluent System Icons for shell navigation, commands, status, and empty states.
- Use regular icons at rest and the matching filled icon for a selected navigation item.
- Use 16px icons for inline actions, 20px for section markers, and no more than 24px for empty states.
- Material file-type icons retain their familiar type colors; other shell controls retain Fluent icons.
- Keep icon-library exceptions limited to those named controls. The Connected Folder glyph may repeat only where it communicates inherited root context: the sidebar, cards, and Chat groups. The Card banner is name-first; the Compact, Band, and Cover layouts lead with the Connected Folder icon (2026-11-04).
- Connected Folder color may appear as a small avatar accent or active indicator, never as a frame around the application.

## Typography and spacing

- Every platform defaults to the bundled brand fonts: Inter Variable for body copy and controls, Poppins SemiBold (600) for interface headings. Markdown-rendered conversation and document content keeps the body face. Body copy is 15px; interface weights are 400, 500, 600, and 700 only; the fonts ship with the app and the web client, never from a CDN.
- Every interface font size is one step of the type scale in `web-local/src/brand.css` (`--amplefile-type-2xs` through `--amplefile-type-2xl`: 11, 12, 13, 14, 15, 17, 20, and 24px at Standard). The steps are in rem, so Text Size scales the whole interface. Nothing renders below 11px, which is reserved for badges, keycaps, and small labels; metadata and captions are 12px; section and dialog titles are 17px and page titles 20px (2026-11-04).
- Headings, navigation, tab labels, menu items, buttons, field labels, options, and status words are Title Case; sentences, hints, placeholders, toasts, and errors are sentence case. **Connected Folder** is capitalized everywhere, in labels and in sentences, like **Worker**; **AmpleFile agent** keeps "agent" lowercase in sentences (2026-11-07).
- User-selected fonts and text sizes may change type, but must not change shell geometry or push controls out of bounds.
- Use the 4, 8, 12, 16, 24, and 32px spacing scale, with 2, 6, 10, and 20px half-steps inside dense controls.
- Text colors come from the palette (`--ui-text`, `--ui-text-muted`), not hard-coded grays. Muted text keeps at least 4.6:1 contrast on every surface it sits on, in every palette and theme; disabled controls stay legible (about 3.5:1) instead of fading.
- Controls come in three heights (`--amplefile-control-sm/md/lg` in `brand.css`): 24px small icon actions, 30px buttons, toolbar icons, and pane search fields, and 36px form fields and search in dialogs and Settings, with 5px radii. Primary rail targets remain 44px. Files and Chats share 28/30/38px compact/standard/spacious rows, with larger touch targets when the platform requests them.
- Controls keep the arrow pointer, as in a native app; hover and press states show they are clickable. Only links inside Chat messages show the pointing hand (2026-11-05).
- Menus and popovers in dark mode carry a hairline light edge and a deeper shadow so they read as containers above the window.
- Every text button has a visible shape at rest: a fill and a hairline edge (`--ui-button-fill`, `--ui-button-edge`), clearly lighter than the surface in dark mode, and the shared control hover fill. Destructive buttons keep that shape with red text. Icon-only toolbar buttons, list rows, tabs, chips, and menu items stay flat until hovered. Labels that could wrap at the minimum window width stay on one line, shortened with an ellipsis and a tooltip where needed (2026-11-05).
- Avoid all-caps labels, weight 800+, text shadows, ornamental whole-app gradients, and oversized hero headers.

## Layout

- Color and icon identity inherit through Connected Folder–bound cards, chat groups, surfaces, and chat empty states. Content belonging to another Connected Folder carries that Connected Folder's own identity rather than the currently selected one.
- The Skills & Extensions Installed view places the Included with AmpleFile strip above Everywhere and This folder only, which sit side by side and stack on narrow widths; rows open their details on click.
- Skills & Extensions uses compact view tabs beside Add Custom and one aligned search/filter toolbar. Discover listings have text-only names, types, descriptions, provenance and source links, with the same gutters as their heading and search. Installed rows use neutral type glyphs; the five included tools keep their recognizable icons and palette-derived tile borders.
- Hover fills the existing control or row hit area in 110ms without lifting, scaling, or adding an outline. Pressed fills are stronger, and a button settles to 96% while it is held (2026-11-02); keyboard focus retains its independent outline. Selected rows deepen their Connected Folder tint on hover. Neutral and primary states resolve through the selected application palette and accent; Send retains its owning Connected Folder accent. Disabled controls do not react.
- Floating menus have an opaque palette surface and one shared shadow. Settings groups use spacing instead of nested frames; editable fields and data tables keep their visible boundaries.
- Settings → AI Models chooses its scope with two large buttons (This worker, naming the Connected Folder, and AmpleFile agent) rather than radio circles; its model is a dropdown that shows the chosen model closed and opens with a search box at the top and vendor headings, closing again on a choice. Settings → Automations keeps Limits collapsed under a disclosure by default.
- Settings → Appearance starts with a labeled Preview, followed by Presets, without a reserved success-notice strip. AI Models places Save Model at the right of its action row.
- User Chat bubbles use the contrast-solved soft Connected Folder accent and its matching reading foreground; Quiet uses the selected neutral surface. Copy sits at the right edge beneath the user bubble, with its timestamp revealed to its left on hover or keyboard focus. Agent message headers are text-only and do not repeat a decorative agent avatar.
- Forms use stacked labels and hints with an explicit action row.
- Notices use `icon | copy | action` and stack only when their own pane becomes narrow.
- Empty states are centered, restrained, and no wider than 440px.
- Resizable panes must adapt to their own width; prefer container queries to viewport-only breakpoints.

## Motion (2026-11-02)

Motion confirms what happened and where things went; it never decorates. Entrances live in `web-local/src/motion.css`; exits, glides, and the reply-landed moment are played by `web-local/src/lib/motion.ts`.

- Anything a person triggers finishes within about 250ms, and exits run at roughly two-thirds the length of entrances. Durations come from `--amplefile-motion-base` (180ms) and `--amplefile-motion-slow` (260ms) with the shared `--amplefile-ease-smooth` curve; only confirmations use `--amplefile-ease-pop`.
- Dialogs: the backdrop fades in while the window rises 8px and scales up from 97%; on close the window settles back as it fades in 150ms. Menus and popovers grow from the side of the control they open from in 150ms and fade out in 110ms.
- Files: only the folder a person just opened grows open; folders already open when Files renders, or revealed by a search, appear in place. Closing a folder folds its contents away. Toasts slide out to the right and the stack closes the gap.
- A Worker's dot pops in when its turn starts; when the reply lands it pops once and sends out one ring. Copied checks pop once. Settings pages fade up as they open.
- The file manager (2026-11-07, owner request) says where things came from: nested Connected Folders grow in under their parent one after another and collapse away; the Info/History thumb slides to the chosen tab and the pane comes in from that side; a Chat pushes in from the right and Back slides the panel in from the left; a folder you go to slides in from the right going deeper or forward and from the left going up or back, once its items are loaded; first-run steps slide the same way; the Worker's receipt rises in and collapses away on Done; suggestions rise one after another; the Go to Folder sheet drops in and fades out; dots pop in; buttons answer a press. Each uses the motion tokens and both reduce-motion switches remove it.
- Streamed replies and background refreshes never animate. Folder-opening state belongs to its Files tree and is cleared for searches and Connected Folder changes. A leaving element is an inert copy excluded from focus, clicks, and the shell's live-element queries, and a replacement (the next confirmation, the palette handing over to Settings, tabs regrouping) swaps at once. Application Reduce Motion and the operating system preference both remove every animation, including scripted effects already running, and remove existing leaving copies; no new leaving copy is made.

## Windows material

- Use Mica only on Windows 11 22H2 or newer (build 22621+) and only when the operating system does not report reduced transparency.
- When Mica is active, keep the titlebar overlay transparent and make only the root window chrome and pane gutters transparent. Content surfaces remain opaque so hierarchy and contrast do not depend on the wallpaper.
- The preload reports `window.material` and `main.tsx` applies `data-window-material="mica"` synchronously before React's first paint. Do not move this to a passive effect that produces a solid-background flash.
- Older Windows builds and reduced-transparency sessions use a theme-matched solid background. Light, dark, and system theme changes must update native chrome and the renderer together.

## macOS chrome

- Use the hidden-inset native macOS title bar, traffic lights, application menu, and Window menu. Do not render the Windows custom title bar on macOS.
- Reserve one 32px drag strip above the panes on macOS, without stacking the normal 12px page gutter below it. Browser and Windows top gutters remain 12px.
- Keep Settings and About in the application menu, standard editing roles in Edit, and minimize/zoom/front roles in Window.
- Use sidebar vibrancy only for structural chrome when reduced transparency is off. Keep work surfaces opaque and fall back to theme-matched solid chrome.
- Use the macOS system font, system accent color, shortcut glyphs, and native overlay scrollbars without changing the shared Connected Folder, Files, Chats, History, Add, and Skills & Extensions interaction contract.
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

For Electron-integrated changes, repeat a packaged-app pass that confirms the platform material or its solid fallback, light/dark/system transitions, native menus, updater state, and the minimum window size. Browser fixtures cannot prove native material or titlebar behavior.

## Appearance scopes

- **Settings → Appearance** controls the application theme, font, and text size.
- **Customize Connected Folder** controls one Connected Folder's accent, compact banner, and Fluent identity icon.
- Customize Connected Folder opens a popup from the Action menu, a Connected Folder's right-click menu, or Settings → Appearance, pinned to that Connected Folder. Changes repaint every identity consumer immediately.
- Per–Connected Folder appearance is personal application state. It is not written into the user's ordinary folder and does not travel with shared files.
- The editor shows light and dark previews together and reports the semantic contrast audit without claiming that arbitrary images or gradients are statically certified.
- Banner, Icon, and Color sit at the top right of the fixed popup header. Name and paired previews
  keep the same geometry across sections; only the control region scrolls. Bundled images use named
  thumbnails; image framing uses draggable previews and an on-demand position/zoom popover. Color
  offers 24 labeled accent swatches; second colors belong only to Banner’s pattern controls. Icons start with a small Popular
  selection and add Nature, Life, Creative, Travel, Work, and All filters with larger 24px glyphs.
  Keep utility copy short. Worker shortcuts open the existing Connected Folder–scoped model and instruction settings.
- A custom image is resized and compressed before machine-local service storage. Unsafe image formats and malformed stored values are rejected.
- Every Connected Folder appearance control updates the preview, saves immediately, and offers Undo and Reset. Import/export uses the same typed, code-free proposal format as the agent harness.
- Layout order, native chrome, permission UI, target sizes, and non-colour state indicators are invariants, not customization options.

See [Connected Folder customization](connected-folder-customization.md) for the resolver, persistence, and harness contract,
[Desktop experience parity](ui-parity.md) for the complete interaction contract, and
[Architecture](architecture.md) for the native/renderer boundary.

## Desktop consolidation (2026-10-09)

The design thesis is a calm, Finder-native file manager (since 2026-11-07; this section's tab and banner rules described the removed classic layout). Hover fills the existing target within 110ms; active, pressed, keyboard focus and disabled states remain distinct without lifting or scaling controls.

`web-local/src/styles.css` is the canonical desktop stylesheet. The former professional foundation/shell/surfaces/customization, Settings, appearance-editor and History override files are retired. Shared actions use `ui-control` with primary, quiet or icon variants; feature classes own their layout. Styles for retired Library, Drive setup, publishing drawers, activity panes and the standalone shortcuts dialog are removed after checking their renderer consumers. Brand artwork, the shared application preference sheet, and component styles shared with the paired web renderer retain their separate contracts.

`src/shared/application-appearance.ts` remains authoritative for palettes, custom accents, fonts, reading size/measure/spacing, density and accessibility. `application-appearance.css` projects those same preferences into the desktop and menu-bar renderer. Saved records, presets, Undo and Reset keep their schema and behavior. Connected Folder colors, icons, patterns, uploaded banners and framing remain independent; no design selector overrides saved palette variables. The composer shell owns the complete focus boundary, including attach, Commands, the model and reasoning chip, and Send, using the owning Connected Folder's contrast-solved state border. It starts one line tall and grows with the draft; its bar keeps what a person adds (the **+** attach button and Commands) on the left and the model, reasoning, and Send on the right (2026-10-27). Empty Chats use that folder's semantic text and glyph accents for its name and icon; a new Chat places its composer directly under the greeting with up to three of the Connected Folder's recent Chats below, and the first message settles the composer at the bottom. File tabs align metadata, a wrapping action row and document content to one gutter while keeping the selected reading preferences.

