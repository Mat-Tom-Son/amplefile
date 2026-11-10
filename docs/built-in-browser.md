# Built-in browser

`desktop/src/built-in-browser.ts`, `src/shared/browser*.ts`,
`src/local/agent/browser-tools.ts`,
`web-local/src/components/file-manager/BrowserPane.tsx`,
`web-local/src/hooks/useBrowserPages.ts`, `web-local/src/lib/browser-pages.ts`,
and their suites are the implementation authority.

AmpleFile's desktop process hosts a browser of its own: Chromium pages in one
persistent profile. Workers and the AmpleFile Agent drive them through the
`browser_*` tools, and the person sees and uses the same pages as tabs in the
file manager window's **Browser pane**: to watch what a Worker does in a page,
to sign in to a site, and to answer a site's question. The desktop process
owns the pages; the window only places them and shows their state.

Pages show only in the file manager window, which needs a Connected Folder.
On first run, or after the last Connected Folder is disconnected, there is no
Browser pane: a page the AmpleFile Agent opens then runs unseen, and a
question its site asks waits until the page leaves or a Connected Folder is
connected and the pane shows it.

## The Browser pane

The Browser pane sits under the folder's contents in the file manager window,
between the sidebar and the right panel. Its tabs belong to no Connected
Folder, so they stay as the folder shown changes, and the panel beside it
keeps the Connected Folder shown and its Chat.

- **Opening it.** The toolbar's **Browser** button opens the pane with a new
  tab, and shows or folds the pane when tabs are open. The window has no pane
  while no tab is open. A tab a Worker opens arrives as the tab strip alone;
  choosing the tab shows its page. A link the person follows into a new tab,
  or a page a Worker opens with `show`, opens the pane.
- **Sharing the area.** A band between two lines separates the folder above
  from the browser below, and the browser's tab strip and address row are
  one surface over the page. The pane has three sizes, chosen with the two
  buttons at the end of its tab strip. Beside the folder, the band is a
  slider with a grip at its middle that sets the browser's share of the
  height (kept between 15 and 85 percent, and
  remembered; double-click resets it, and the arrow keys move it). **Hide
  Folder** folds the folder up so the page has the whole area, and **Show
  Folder** brings it back. **Hide Browser** folds the browser down to its tab
  strip, and **Show Browser** or choosing a tab brings it back. Folding the
  browser never closes a page. Choosing a place in the sidebar, searching, or
  opening Recents brings a folded folder back.
- **Tabs.** The strip shows each tab's site icon and title, and tabs share
  its width: each takes up to 200px and gives way as more open. With more
  tabs than fit, the strip scrolls: the tab in front keeps room for its name
  and always stays inside the strip, and the strip fades at the edge that
  holds more tabs. A frame
  slides behind the tab in front to the tab chosen, a new tab grows in, and a
  closed tab shrinks away; both reduce-motion switches turn that off. A tab
  shows a spinner while it loads, a speaker while it plays sound, the running
  dot while a Worker is using it, an amber dot while its site waits on the
  person, and a small window mark while it holds a pop-up its site tried to
  open. **+** opens a new tab. A tab's × or a middle click closes it,
  and its page with it. Right-clicking a tab offers Reload, Duplicate, Copy
  Address, Open in Your Web Browser, Mute Tab, Print…, Save as PDF…, Close
  Tab, Close Other Browser Tabs, and Reopen Closed Tab. A duplicated or
  reopened tab comes to the front and the browser shows it.
- **The page.** Above the page are Back, Forward, Reload (Stop while
  loading), and the address field with **Site Information**, which says how
  the page reached the browser and lists what the person allowed or blocked
  for the site, each with **Ask Again**. A click in the address field selects
  the address. The field shows an address the person typed while it loads,
  and the tab's own address again if the load is stopped. A page that did
  not load says why in plain words, with Chromium's name for the failure and
  the address beneath, and that message stays until another page arrives.
  Typing lists matching pages from history. An address the browser cannot show (`chrome://…`, `data:…`,
  `mailto:…`) is searched for instead, so Return always leads somewhere.
  **Find in Page** and **Open in Your Web Browser** end the row.
- **A Worker is using a page.** The tab carries the running dot, and beside
  the address field a marker says **Worker in** and the Connected Folder's
  name, with a button that opens that Chat in the panel. The window goes to
  that Connected Folder when another is shown; already in it, the person
  keeps their place. The page stays in view beside the Chat.
- **A site's question.** A bar directly above the page says what the site
  wants, with **Block** and **Allow**. The bar is the window's own, never the
  page's, and only a press there answers it. Each question is its own bar,
  and its buttons take no press for half a second after it appears, so the
  second press of a double-click, or a press aimed at what was there a moment
  before, never answers a question the person has not read; the answer is
  kept for the site. The page moves down in the same frame the bar appears.
  When the page is not in view, the window's notice says the site is
  waiting, with **Show Page**, once for each question, and the notice goes
  when the question is answered, dropped by the page, or brought into view. A
  pop-up a site tried to open without a press, and a permission macOS itself
  keeps off, show in the same place.
- **No page.** A new tab has the address field ready under **Search or Type
  a Web Address**, the pages visited lately with **Clear Browsing History…**,
  and a line saying sign-ins are shared by every Worker and the AmpleFile
  Agent. Clear Browsing History… asks first and says it cannot be undone;
  sign-ins stay.
- **Tab and the keyboard.** The page is a stop in the window's Tab order,
  after the address row: arriving there hands the keyboard to the page. Tab
  and Shift-Tab then move inside the page, which Chromium keeps there, and ⌘L
  brings the keyboard back to the address field.
- **Keys.** These act while the Browser pane or a page in it has the
  keyboard, and keep their own meaning elsewhere in the window: ⌘T opens a
  tab and ⇧⌘T reopens the one closed last, ⌘W closes the tab in front, ⌘L
  goes to the address field, ⌘F finds in the page, and ⌘1 to ⌘9 and
  Control-Tab change tabs. ⌘W does nothing to the browser from a Chat's
  message box, the folder's list, or while a dialog is open. A key pressed
  in a page that the window acts on brings the keyboard back to the window,
  so what is typed next goes to the address or find field and not to the
  page; a tab chosen from a page gives its page the keyboard.
- **What the desktop owns.** The tab list is the desktop's open pages: pages
  that outlived a window reload and tabs a Worker opened before the window
  existed come back as tabs. A window that is closed and reopened, or
  reloaded, shows the pane at the size it was left with the same tab in
  front. Nothing is restored after quitting except sign-ins and history. The page is drawn by the desktop above everything the
  window draws, over a placeholder in the pane, so it steps aside for as long
  as a dialog (or the dimmed backdrop behind one), menu, sheet, or notice of
  the window's crosses it. Notices sit above the pane's top edge for the same
  reason: over the folder's list beside the folder, and over the toolbar with
  the folder folded away. A page shown in the pane takes the pane's size;
  folded away, it keeps its last size. Workers are told the person has a tab
  in front only while its page is drawn where the person can see it: not
  folded away, under a dialog, in a hidden or minimized window, or replaced
  by an error.

The browser preview (`/?fixture=connected-folder`) shows the pane over sample
pages with no page drawn; two of its recent pages show a Worker's marker and a
site's question.

## Profile and sign-ins

One persistent Chromium profile serves every browser page and every Connected
Folder. It lives in AmpleFile's machine-local app data, apart from any other
browser on the Mac, from the app's own window, and from every Connected Folder;
cookies are encrypted with the operating system's keychain like the rest of the
app's Chromium data.
A sign-in in one page holds for every page.

The browser identifies itself the way Claude's own browser does: Chromium's
user agent with the app's name (`amplefile/<version>`) and without Electron's
token. Google's sign-in refuses an embedded browser that poses as plain Chrome
and accepts one that names itself, so the browser does not pose. Sites see
Chromium's brand hints and no automation flag.

Passkeys saved in Apple Passwords, 1Password, or a phone do not work. On macOS
an app may use them for any website only with Apple's managed
`com.apple.developer.web-browser.public-key-credential` entitlement, which
Chrome and Firefox hold; Electron also has no passkey sheet of its own, so a
passkey request waits until the site offers another way (Google: **Try another
way**).

## Pages

- An address can be a full address, a bare host (`example.com`, opened over
  https), this computer's servers (`localhost:3000`, `127.0.0.1:5173`, over
  http), or an absolute file path. Only the person's address bar and Workers
  open local files: a web page's links, redirects, and pop-ups never reach a
  file on this computer, though a local page may link to other local files.
- History keeps every web page the browser reaches, Workers' visits included,
  in machine-local app data.
- A site opens a new page or window only within five seconds of a press in the
  page, and one press opens one, as in Chrome. A sized pop-up such as "Sign in
  with…" opens as its own small window that keeps its link to the page that
  opened it, which sign-in flows rely on. Its title always starts with the
  site it is showing, which the page cannot change. Mail links open the mail app; other
  non-web addresses are refused.
- Downloads go to the Downloads folder and never replace a file there, even
  when two with the same name arrive at once. The window's notice names each
  file as it was saved.
- A page may ask to be confirmed before it is left, as one with unsaved
  changes does. When the person leaves it from the window (a typed address,
  Reload, Back, Forward, or closing its tab), the page stays and the window
  asks **Leave This Page?**; nothing leaves until they choose **Leave**. A
  closed tab comes back into the strip with the question. A Worker's action
  runs when called: the page is left, and the action's result says it had
  asked. A link or form pressed inside such a page leaves it without a
  question, because the desktop cannot ask and wait there without stopping
  every Worker, and cannot do the leaving again afterward.
- A page that leaves full screen is told so, so its own full-screen view
  ends with it.
- A site that wants the camera, microphone, location, notifications, MIDI
  devices, the clipboard, window placement, or activity status needs the
  person's answer, and the answer is remembered for that site. Only the person
  answers; a Worker using that page is told the person has to answer. macOS
  has its own switches. AmpleFile can read the camera and microphone ones,
  and says above the page when one is off. It cannot read the location one:
  the installed app declares why it wants location, so macOS asks in its own
  dialog the first time, while an unpackaged development build declares
  nothing, so it refuses location and says so above the page. A
  Worker's script that waits on such a question is told the same after 30
  seconds instead of waiting on, and the question stays for the person.
- Full screen, copying from the page, pointer and keyboard lock, saving to a
  file the person picked, and protected media need no question, as in Chrome.
  USB, serial, HID, and Bluetooth devices stay unavailable.

## Workers

Every Worker and the AmpleFile Agent in the desktop app carry the browser
tools, registered beside the background job tools, and they are how an agent
uses the web interactively. They are part of the app, not one of the four
included tools, so the Skills & Extensions strip does not list them and there
is nothing to set up. A development API without Electron
has no browser and no browser tools.

| Tool | What it does |
|---|---|
| `browser_tabs` | Lists the open pages, their addresses and titles. |
| `browser_open` | Opens an address in a new page and waits for it to load. |
| `browser_navigate` | Loads an address in a page, or goes back, forward, or reloads. |
| `browser_read` | Reads a page: its `structure` (the default), its visible `text`, or its `console` (messages and failed requests). `find` keeps matching lines; long pages come in 50,000-character parts. |
| `browser_screenshot` | A picture of the visible page, one element, or the whole page (up to 8,000 pixels tall), in page pixels. |
| `browser_click`, `browser_type`, `browser_press`, `browser_scroll` | Act in the page by element ref or viewport coordinates. Click supports left, right, middle, double, and modifier keys. Typing replaces a field or chooses a list option. Press can focus a ref and send keys together. Scroll accepts a ref alone to bring it into view, a ref plus direction to scroll inside a panel, or coordinates to aim the wheel. |
| `browser_hover` | Moves the pointer over a ref or viewport coordinates to reveal a hover menu or tooltip. |
| `browser_drag` | Drags between two refs or viewport points: sliders, custom handles, and native HTML drag-and-drop. Both ends must already be visible in the viewport. Stop releases the button and cancels an unfinished native drag. |
| `browser_upload` | Attaches up to 100 existing local files by absolute path to a file input ref, without a native chooser. Multiple files require a multiple-file input; an empty list clears it. Folder inputs are unsupported. Attaching may immediately upload to the site, so the tool teaches the agent to use only the files and destination authorized by the task. |
| `browser_downloads` | Lists a page's latest 50 downloads from this app launch, with ids, source URLs, filenames, byte counts, states, and completed local paths. Optionally waits up to 60 seconds for transfers already in progress. The host retains the most recent 200 finished/active records, never dropping an active transfer. |
| `browser_evaluate` | Runs JavaScript in the page and returns the result. |
| `browser_wait` | Waits for text to appear, or for loading to finish. |
| `browser_close` | Closes a page this Chat opened. Pages another Chat opened stay open. |

- A page's structure is the accessibility tree Chromium already keeps,
  written as indented lines. Every element a Worker can use carries a ref such
  as `e42`, valid until the page changes, so one read can serve several
  actions.
- Each action says whether it led to a new page, and a page that did not load
  says why.
- A tool without a `tab` uses the page this Chat last used.
- Workers act through the Chrome DevTools Protocol on Electron's own debugger:
  mouse and keyboard input arrive as real presses. Focus emulation lets a
  background page render and take input as if it were in front; the debugger
  lets go after two quiet minutes.
- Clicks, hovering, dragging, file attachment, typing, keys, scrolling, and
  navigation on one page take turns, so two Chats using the same page never
  type into each other's fields. A script run does not take a turn because it
  may wait on page events or navigation; scripts can change the page, so
  agents are taught to prefer the queued tools for input. Download observation
  and waiting likewise leave that queue free.
- The tool instructions teach the same observation loop for every Chat: read
  the page, act on observed refs, and check the resulting page or screenshot
  before claiming success. An unchanged page calls for inspecting an overlay,
  disabled control, or stale ref rather than repeating the same action.
  Page text and downloaded content are untrusted data, not instructions or
  authorization. Download paths become usable evidence only after completion;
  the normal file tools read the saved bytes.
- The tools follow [receipts, not gates](act-ledger.md#receipts-not-gates): an
  action runs when called. Stop before or during an action sends no further
  input (a button already pressed is still released, so the page is never left
  mid-click); Stop also interrupts a wait or a load, but an effect a page
  already received is not undone.

## Boundaries

- Pages run sandboxed with context isolation, without Node, a preload, or
  webview tags, so a page never reaches the app's desktop bridge. A page is
  never a trusted renderer.
- Pages keep running in the background, including after the last window
  closes, until AmpleFile quits.
- Nothing from the browser enters a Connected Folder unless a Worker writes it
  there or the person moves a download in. What a Worker reads from a page
  reaches the model provider like any other tool result.

## Verification

`tests/file-manager-browser-pane.test.ts` mounts the file manager window over
a stand-in for the desktop bridge, with the page's placeholder given a real
box: opening the pane, a Worker's tab arriving and which Chat its marker
opens, the three sizes, the slider, the placements sent to the desktop and
the overlays the page steps aside for, a site's question and the presses it
ignores, a second queued question, the waiting notice, keys pressed in a page
and in the pane, Close Tab with the keyboard elsewhere or a dialog open,
closing tabs, and where the Browser and panel buttons sit in the toolbar. `tests/browser-pages.test.ts` covers
the tab list, `tests/native-view.test.ts` the page's placement and the
overlays it steps aside for, and `tests/tab-chrome-motion.test.ts` the tab
strip's layout and motion in Chromium.

`npm run desktop:browser:smoke`, part of `npm run desktop:prepare`, drives the
real host in Electron against pages served from a loopback server: opening
with no window, structure and refs, trusted clicks and typing, lists, waiting,
scripts, the console, three kinds of screenshot, scrolling, new-page links,
downloads, back and forward, a site's question answered, remembered,
forgotten, blocked, and dropped on navigation, history, pop-up rules, and
overlapping Chats, the keys a page hands to the window with the keyboard, a
script that waits on an unanswered question, a page that asks before it is
left (the person's address, Reload and Close Tab, Stay and Leave, a link
pressed inside it, and a Worker's navigation and click), and a load stopped
after a page that did not load. Its window is off screen and
cannot hold the keyboard, so which web contents has the keyboard is checked
in the running app, not there. `tests/built-in-browser.test.ts` covers addresses, the user
agent, the structure format, keys, the tools, site decisions, history, and
local server addresses.
