# Document verification

A Worker that makes a Word report, a slide deck, or a budget workbook looks at
the result before it says the work is done: it sees the pages, reads the
formula results, and fixes what is wrong. This page covers how the Documents
tool reports whether it can do that, how a person sets it up, and what the
Skill teaches.

Without an installed engine, the bundled libraries give a Worker:

| File | Can it see the result? |
| --- | --- |
| PDF | Yes: pages render to images with the bundled renderer. |
| Word, PowerPoint | Only the file structure (ZIP parts, text), plus a Quick Look preview of one page or slide at a time on a Mac. |
| Excel | No calculated values. ExcelJS writes the formula and whatever cached result the script supplied. |

LibreOffice renders Word and PowerPoint files and recalculates workbooks.
Tesseract reads text in scanned page images. AmpleFile bundles and installs
neither.

## Detection

`document_engine status` and every Documents status read look for executable
files only and start nothing (`resources/included-tools/readiness.ts`). They
search `PATH`, `/Applications/LibreOffice.app`, `~/Applications/LibreOffice.app`,
Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), and MacPorts (`/opt/local/bin`),
because an app opened from the Finder gets a short `PATH`. A host's
`documentEngineSearch` reaches both the tool and the status, so they look in
the same places.

**Check** stays explicit. It runs the bundled-library probe and `--version` on
each engine it finds, so an install that is blocked or broken shows as such,
and it records the version or the start problem for that exact path.

## Status

The Documents tile in the **Included with AmpleFile** strip shows one word:

- **Ready**: the bundled libraries passed their check (or a Worker's
  `document_run` proved them) and LibreOffice is found and starts.
- **Not Checked**: LibreOffice is found but the bundled libraries have not been
  checked yet in this run of the app.
- **Setup Needed**: LibreOffice is not found, or it is found but did not start.
  Without it, the detail reads: "Your Worker can make documents but can't check
  how Word and PowerPoint files look or what spreadsheet formulas calculate.
  Install LibreOffice to turn that on." On a Mac where Quick Look works, it
  reads: "Your Worker can preview the first page of a Word file and each slide
  of a deck, but can't check every page or what spreadsheet formulas calculate.
  Install LibreOffice to turn that on." When LibreOffice did not start on a
  Mac, the detail says to open it once from Applications so macOS can approve
  it, then check again.
- **Unavailable**: only when the bundled libraries fail their check.

Tesseract never changes the word. It reads scanned pages only, so it is an
optional row in the details.

## Set Up

The Documents details show a two-row checklist:

1. **LibreOffice** "lets your Worker see Word and PowerPoint pages and
   calculate spreadsheet formulas", with **Download**, which opens the official
   download page (libreoffice.org) in the browser.
2. **Tesseract** "(optional) lets your Worker read the text in scanned pages",
   with **Install Guide**, which opens Tesseract's own guide.

When Homebrew is present, a missing row also shows its command
(`brew install --cask libreoffice` or `brew install tesseract`) with **Copy**.
Under the list, a hint says both are free and, on a Mac without LibreOffice,
to open it once after installing so macOS can approve it.

While the details are open, the dialog's ordinary status refresh (every five
seconds and whenever the window regains focus) runs the same file checks, so
each row ticks off soon after the engine appears, with no extra watcher. An
installed engine's path and version sit in the tooltip of its **Installed**
label; one that did not start says **Didn't Start** with the problem. AmpleFile
itself installs nothing: it opens the official page or shows a command the
person runs.

## The Skill

The Documents tool's Skill
([document-work Skill](../resources/included-tools/documents/skills/documents/SKILL.md))
makes checking a habit:

- **Verify by default.** After making or changing a document, check it before
  reporting:
  - Excel: recalculate a copy, reopen it, compare the key values with what the
    numbers should be, and look for error values (`#REF!`, `#DIV/0!`,
    `#NAME?`, `#VALUE!`, `#N/A`). ExcelJS reads a calculated 0 as no result, so
    such a cell is confirmed from the sheet XML. The calculated values are
    written back as each formula's cached result.
  - Word and PowerPoint: render to PDF, render the pages to images, look at
    them, and fix clipped or overflowing text, broken tables, and wrong page or
    slide counts. Re-render after a fix.
  - PDF: render the pages directly.
  - Look closely: render at `scale: 2` or crop a region, so small text can be
    read.
  - Review copies go in `.worker/<task-id>/`, never beside the deliverable.
- **Write documents that render well.** In `docx`, a font size is in
  half-points, and tables get explicit column widths wide enough for their
  longest word or number.
- **Without an engine,** still run the structural checks (reopen the workbook,
  check formula references, estimate whether text fits its box and whether a
  table column is wide enough), then say exactly what could not be checked.
  Never claim a visual check or a calculated value that did not happen.
- **On a Mac without LibreOffice,** preview page 1 of every Word file and every
  slide of a deck with Quick Look, look at them, fix, and preview again. To see
  a later part of a Word document, build a review copy that starts with that
  part. Never reshape the deliverable to suit the preview.
- **The report** includes one line on what was checked and how, and, when
  something could not be checked, ends by pointing to **Skills & Extensions →
  Documents → Set Up** — even when a preview showed the whole file.
- **Installing on request only.** If the person asks the Worker to install
  LibreOffice or Tesseract, it may run the same command Set Up shows, visibly
  in the Chat. It never installs anything unasked.

## Quick Look preview

On macOS, `document_engine` has a `preview` operation that draws a DOCX or
PPTX as a PNG with Quick Look (`/usr/bin/qlmanage -t`), which is built into
macOS and needs nothing installed. `status` lists Quick Look as an engine with
the operation `preview`.

- A preview is page 1 of a Word file, or any one slide of a deck: for a slide
  other than the first, the tool makes a private copy with that slide moved to
  the front. The source file is never changed. A Word document has no such
  order, so only page 1 can be drawn.
- Otherwise it works like `render`: it captures a private copy, reports source
  and output hashes and the Quick Look version, keeps a log, and supports Stop.
- Quick Look never finishes on a file it cannot draw, so `preview` has a
  60-second default deadline (`timeoutMs` overrides it). When no image
  appears, it says: "Quick Look couldn't draw this file. It may be damaged, or
  a kind Quick Look doesn't know."
- Workbooks are not previewed: their thumbnails crop the sheet and show cached
  values only. Fonts are substituted differently from Word, as with
  LibreOffice.

## Rerunning the evaluation

`scripts/document-eval/` measures how Workers do on three seeded tasks — a
budget workbook with formulas and a cross-sheet total, a slide deck whose dense
slide overflows unless the Worker fixes it, and a Word report with a wide
table — each scored by a checker kept outside the Worker's folder and context.
Each run makes a disposable Connected Folder and drives one real Worker turn
through `npm run amplefile:drive`.

The conditions are `engines` (LibreOffice and Tesseract visible),
`no-engines` (the host runs under a macOS `sandbox-exec` profile, so neither
it nor any tool it starts can find them), and `no-libreoffice` (both hidden
from the tools and the shell's `PATH`, while Quick Look stays available). The
OpenRouter key is read from Pi's `auth.json` into the host's environment only;
it is never printed or written.

```bash
npx tsx scripts/document-eval/run.ts --condition engines --repeat 2 --out /tmp/document-eval/engines
npx tsx scripts/document-eval/run.ts --condition no-engines --repeat 2 --out /tmp/document-eval/no-engines
npx tsx scripts/document-eval/run.ts --condition no-libreoffice --tasks report,deck --repeat 3 --out /tmp/document-eval/no-libreoffice
npx tsx scripts/document-eval/score.ts /tmp/document-eval engines no-engines no-libreoffice
```

`--tasks budget,deck,report` limits the tasks. `--host-repo <checkout>` runs
the host from another checkout, such as a baseline of `main`; the drive client
and checker always come from this one. Each run's folder keeps the Worker's
files, the turn report, the tools it called, the hidden checks, and the page
images. Scoring asks whether the output is correct by the hidden checks,
whether the Worker actually verified it, and whether its final report is
honest.

## Not included

- A bundled formula evaluator for formula checks without LibreOffice.
- One-click install through Homebrew from inside AmpleFile.
- Exporting through the person's own Word or PowerPoint with Computer Control
  as a built-in check (a Worker can still use those apps through Computer
  Control when the person wants that).
