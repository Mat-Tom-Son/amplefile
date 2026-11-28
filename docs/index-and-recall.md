# The index and ranked search

Each Connected Folder has an index: a machine-local record of the text in its
files and Chats that answers a ranked search by words and by meaning. The
index lives in the folder's machine-local state, never in the folder, and is
rebuilt whenever it is missing or unreadable. Indexing and embedding happen
on this computer; nothing about the index is sent anywhere.

The live search ([the CLI guide](amplefile-agent-and-cli.md)) is unchanged and
still answers every search. Ranked search is additive: a ranked request gets
the live result and, beside it, the index's best matches.

Source: `src/local/index/` (`content-policy.ts`, `store.ts`, `extract.ts`,
`embedder.ts`, `indexer.ts`, `recall.ts`).

## What is indexed

The index reads the same files Search and History agree on, built from their
own rules rather than a new set:

- always-hidden entries (`.amplefile/`, `.pi/`, and the rest of the built-in
  hidden set) and Office lock files are left out, as Search leaves them out;
- the folder's ignore rules apply, as in Files and Search;
- a nested registered Connected Folder is left out of its parent's index and
  keeps its own;
- symbolic links are never followed;
- the History capture policy's directory skips apply: version-control
  internals, installed dependencies, virtual environments, `CACHEDIR.TAG`
  caches, and directories a `.gitignore` excludes.

The walk is bounded like the Automation file observer: 50,000 files, 200,000
visited entries, and 64 levels. Coverage says which bound stopped it.

On macOS, a cloud placeholder (a file a sync service has not downloaded)
reports no blocks on disk with a non-zero size. The index never opens such a
file and records it as `not-downloaded`.

Each file has one status: `indexed`, `pending`, `not-downloaded`, `binary`,
`too-large`, `unsupported`, or `unreadable`.

| Kind | How its text is read | Location in a hit |
|---|---|---|
| Plain text and Markdown | Search's binary check, then UTF-8 | line range; Markdown also its headings |
| Word (`.docx`, `.docm`, `.dotx`, `.dotm`) | the document's XML, read in-process | paragraph range and headings |
| Excel (`.xlsx`, `.xlsm`, `.xltx`, `.xltm`) | shared strings and sheet XML | sheet name and row range |
| PowerPoint (`.pptx`, `.pptm`, `.potx`, `.potm`) | each slide's XML | slide |
| PDF | macOS PDFKit in a short-lived `osascript` child that is handed the bytes AmpleFile read | page |
| Chat messages | the Connected Folder's Chat records | conversation, message, and part |

Office documents are read with a bounded ZIP reader inside AmpleFile; neither
LibreOffice nor the included Documents tool's libraries are involved. On a
system without PDFKit, a PDF is `unsupported`. Older Office formats, Pages,
Numbers, Keynote, pictures, audio, video, and archives are `unsupported`.
Text is chunked by paragraph into pieces of roughly 200 to 400 words, starting
a new piece at a Markdown heading and repeating a short closing paragraph at
the start of the next piece.

Only prose is ranked by meaning: Markdown, plain text (`.txt`, `.rst`, `.org`,
`.tex`, a file with no extension, and the like), Word, PowerPoint, PDF, and
Chat messages. Source code, configuration, structured data, any other text
file, and spreadsheets are indexed as `code` and ranked by words only; a
sentence embedding adds little there and would cost most of the indexing
time. Coverage counts them apart (`chunks.embeddable` is the prose part).

Bounds: 4 MiB for a text file, 32 MiB for an Office document or PDF, 16 MiB
for one member of an Office document, 500 PDF pages, and 400 chunks per file.
A larger file is `too-large`; a file cut at a bound is indexed and marked
truncated.

## Storage

One SQLite database per Connected Folder, at `index/index.sqlite` in its
machine-local state directory. Text is keyed by content hash: files and Chat
messages point at a SHA-256, and chunks, their full-text rows (FTS5, porter
and unicode61), and their vectors belong to that hash. Renaming, moving, or
duplicating a file costs nothing. Each chunk's text is stored once,
deflated; the full-text index is contentless and keeps no copy. Vectors are
stored under the embedder's id, so another embedder re-embeds lazily. A
database of another schema version (the current one is 2), or one SQLite
cannot read, is deleted and rebuilt, so vectors of an older scheme are never
mixed with new ones.

Measured on this repository's 28 Markdown documents (0.67 MB of text), the
index is 1.14 MB; on 842 files of its docs, source, and tests (12.5 MB, most
of it code), 11 MB.

Disconnecting, unregistering, or deleting a Connected Folder deletes its
index first, so it is neither left behind nor carried into Recently Deleted.

## The embedder

`mac-natural-language` uses macOS's own sentence embeddings
(NaturalLanguage's `NLEmbedding`) through one long-lived
`osascript -l JavaScript` child that speaks line-delimited JSON. It starts on
first use, stops after a minute idle and when AmpleFile quits, detects each
text's language, falls back to English, and gives no vector to a text it
cannot embed. Language is detected once per chunk. A chunk is embedded a
sentence or two at a time (at most six passages) and matches by its best
passage. Vectors are L2-normalized and stored as their signs, one bit per
dimension, with one scale: 70 bytes for a 512-dimension vector. A query
stays a full vector, and its score against stored signs is scaled by π/2 to
read as a cosine.

The cost of an embedding is the model's own and grows with the length of the
text, about a quarter of a millisecond per word; moving the vector out of the
helper adds well under a tenth of a millisecond. A folder's first index is
therefore bounded by its prose: this repository's 100,000 words of Markdown
take about 33 seconds, and its 1.1 million words of code are not embedded.
Six passages per chunk was the smallest number that kept retrieval as good
as sixteen 8-bit passages on a set of 18 paraphrased questions over those
documents (mean reciprocal rank 0.40 against 0.38; four passages fell to
0.27). A set that small measures direction, not a precise rate.

When the helper is missing or fails (another system, an error), the embedder
is `none`: ranked search ranks by words only and says so in its coverage.

## When the index updates

A sync walks metadata, compares size and modification time with the index,
hashes, extracts, and embeds what changed, and drops what is gone; then it
does the same for the folder's Chats. Only a complete walk drops anything: a
walk a bound or an unreadable directory cut short leaves what it did not see
in place, and a hit on it is checked against the disk when returned.
Embedding comes last, so words are searchable first (half a second for the
842-file folder above). A sync runs:

- when the folder is first searched with ranked results (the search waits
  briefly, then answers with what is there and says the index is catching up);
- a moment after the folder is shown in a window;
- a few seconds after file changes reported by the window's existing folder
  watcher;
- after a Worker turn settles;
- when a ranked search returns a stale hit.

The indexer works on one Connected Folder at a time, in small steps that can
stop at any wait, and never holds a file open beyond one bounded read. While a
deletion, restore, Eject, or any other reservation is held on a Connected
Folder, it stops at its next step and tries again later. It reserves nothing,
so it never makes another act refuse as busy. The vector scan of a ranked
search yields to the event loop every 12 ms, so neither indexing nor a query
holds the app's main thread for long.

## Ranked results

`recallConnectedFolder(root, query, options)` takes a limit (at most 50), a
path prefix, kinds (`files`, `chats`), and `similarTo` (a file path, for that
file's neighbours). It merges the best FTS5 (bm25) matches and the best
semantic matches by reciprocal rank fusion, with a small boost for recent
files and messages. Scores are rank-based, so a caller can run it for several
Connected Folders and merge the hits by score.

Each hit has its path (or conversation id, message id, title, and role), a
location, a bounded excerpt, a score, its reasons (`lexical`, `semantic`), the
content's SHA-256, when it was indexed (and for a file `modifiedAt`, its
modification time as indexed), and `fresh`. `fresh` is checked when
the hit is returned: a file whose size or modification time no longer matches
is `fresh: false` and queued for re-indexing, never returned as current. A
hit's other paths with exactly the same bytes are listed in `duplicates`.
Read the original before relying on or quoting an excerpt.

`coverage` reports counts by status, Chat messages, chunks with how many are
prose (`embeddable`) and how many of those are embedded, which embedder ranked
(`ranking` is `hybrid` or `lexical`, with `lexicalOnlyReason`; a status read
with no query reports what a query would use now), the last sync, whether one is running, and what the
walk left out and which bound stopped it. A folder never indexed reports
`state: "not-indexed"` with null counts; unknown is never reported as zero.
`complete` is true only when every indexable file and Chat was indexed, its
prose embedded when an embedder is available, and no bound left anything out.

## Surfaces

- `GET /api/connected-folders/:id/search?ranked=1` adds `ranked` (`query`,
  `hits`, `coverage`) to the first page; every existing field keeps its
  meaning. `rankedLimit` (1–50) bounds the hits, and `rankedScope` (`all`, `files`, or `chats`; `scope` when absent) sets what the ranked part covers apart from the live search. `similarTo=<path>` returns
  only `{ similarTo, ranked }` with that file's neighbours.
- `GET /api/connected-folders/:id/index` returns `{ index }`: the same
  coverage with `connectedFolderId`, and `stoppedFor: "reserved"` when the
  last sync stopped for a reservation.
- `amplefile search --connected-folder <id> --query <text> --ranked [--json]`
  adds `ranked` the same way; `--limit` also caps the ranked hits (default
  10, at most 50). The words output lists **Best matches** first.
- `amplefile search --everywhere --ranked --query <text> [--scope …] [--limit <n>] [--json]`
  asks every Connected Folder's index at once (see Everywhere search below).

## Recall for Workers

Every Worker session has a Pi tool, `recall`, registered beside the
collaboration tools (source: `src/local/agent/recall-tool.ts`, hosted by
`src/local/api/recall.ts`). Its parameters are `query`, and optionally `path`
(relative to the Worker's Connected Folder), `kinds` (`files`, `chats`),
`limit` (default 8, at most 20), and `scope` (`folder`, the default, or
`tree`). The AmpleFile Agent has no `recall` tool; it uses everywhere search.

It returns pointers, not content. Each hit gives a path relative to the
Worker's own Connected Folder (or a Chat's title, conversation id, message id,
and role), where inside it (lines, paragraphs, page, slide, sheet and rows,
part, headings), why it matched (words, meaning, or both), how old it is (the
file's modification date or the message's, with a relative age), `fresh`, a
short excerpt (at most 240 characters), and up to three other paths holding
the same bytes. One coverage line follows: how much is indexed, what is not
(still being read, not downloaded, a kind the index does not read, too large,
unreadable), whether a sync is catching up, how the hits were ranked, how many
hits changed since indexed, and, when there are no hits, that this does not
prove absence. A folder never indexed is said to be not indexed yet, never
empty. The whole result stays well under 16 KB.

The tool and the operations guide teach the same rules: use recall to find
where to look; read the original before relying on or quoting anything; a hit
with `fresh: false` changed since it was indexed, so read it again; coverage
says what is not indexed, so a missing hit means look again with grep or
search. A step in the Chat records the query as its detail.

**Tree scope.** `scope: "tree"` also asks the index of every Connected Folder
registered anywhere inside the Worker's own folder, at any depth. The hits of
every folder are merged by score, the best `limit` kept, and then grouped by
the folder that owns them, best group first, each with its id, name, path
relative to the Worker's folder, and Role purpose. A `path` narrows the search
to the folders that hold it or sit under it. A nested folder whose index was
never built is asked to index and listed under `notIndexed`, not counted as
empty; one already indexed answers from its index as it stands and is asked
for a sync shortly after, so a tree search never queues a pass per query.
Tree scope reads nested folders' files only, never their Workers' Chats.
Managed Git working copies are left out. A parent may read a file such a hit
names; changing it still goes to that folder's Worker with a handoff
([the collaboration contract](collaboration-contract.md#connected-folders-inside-connected-folders)).

**The read-only helper** gets `recall` too, in folder scope only, beside its
read, grep, find, and ls, and its prompt says to read the original before
citing anything it points at.

## Everywhere search

`amplefile search --everywhere --ranked --query <text> [--scope files|chats|all] [--limit <n>] [--json]`
asks every registered Connected Folder's index at once. It takes no
`--connected-folder`: it is the one search that names no Connected Folder. The
AmpleFile Agent uses it to find which Worker knows about something, then hands
the work there. The result is `{ everywhere: true, scope, query, ranked }`,
where `ranked` holds:

- `groups`: the Connected Folders holding the merged best hits (at most
  `--limit`, default 10, at most 50), best first, each with `connectedFolder`
  (`id`, `name`, `connectedFolderRoot`, and `rolePurpose` when it has a Role),
  its `hits` (paths relative to that folder), and its `coverage`;
- `notIndexed`: folders never indexed, now asked to index;
- `searched`, `withoutHits`, `failed` (indexes that could not be read this
  time), and `leftOut` (`workingCopies`, and `beyondLimit` past the bound of
  200 folders per search);
- `coverage`: whether everything asked was complete, folders by state, files
  by status summed, `ranking` (`hybrid`, `lexical`, or `mixed`), stale hits,
  and whether any sync is running.

Managed Git working copies are left out. `--everywhere` without `--ranked`,
with `--connected-folder`, with `--path`, or with `--cursor` is a usage error.
Its receipt is an ordinary `search` receipt that names no Connected Folder,
like the `agent`, `requests`, and `receipts` families; its detail is the scope
and `everywhere`, never the query.

## The window

The window shows three things from the index, all in a Connected Folder and
none in a Standard Folder or other folder (a plain folder has no index):

- **Best Matches in Search.** The window's Search asks its one search
  request for ranked results too (`ranked=1`, up to 8 hits; Chats are asked
  for unless the search is inside a subfolder), on the same debounce as the
  name and text search, so a keystroke never fetches twice. **Best Matches**
  sits above the name and text results, which are unchanged. Each hit shows
  the file's name and the folders above it (or the Chat's title, marked
  **Chat**), its place in plain words (**Page 3**, **Lines 12–18**,
  **Slide 4**, **Sheet “Budget”, rows 2–40**, a Markdown or document heading,
  **Part 2** of a long Chat message), and the excerpt with its Markdown marks
  left out. Opening a hit does what opening the same file does from the
  name and text results, or what opening the Chat does from History. Searching all
  Connected Folders merges the hits by score and names each hit's folder.
  A hit whose `fresh` is false is still shown, marked **Changed since
  indexed**. When coverage says a sync is running, files are waiting, or the
  folder was never indexed, one quiet line says so (**Still indexing
  (1,204 of 1,260 files); results may be incomplete.**, with the counts only
  when every folder asked reports them); when a finished sync still left
  files out, the line says **Not every file is in the index, so results may
  be incomplete.** A complete index and a lexical-only ranking say nothing.
  A host that returns no `ranked` field leaves Search as it was.
- **The index row in Info.** At a Connected Folder's top level, below its
  Role, a quiet row reads **1,204 of 1,260 files indexed**, **Indexing…**
  (with the counts) while a sync runs, **Not indexed yet** before the first
  sync, or **No files to index**. **Details** (and hovering the row) list why
  files are not in the index: waiting, not downloaded, too large, of a kind
  that can't be read, not text, couldn't be read, a walk bound that left some
  unseen, and the indexed Chat messages. While a sync runs the row re-reads
  every few seconds; it shows nothing when the host does not answer, and an
  unknown count is never shown as zero.
- **Related in Info.** With one file of a Connected Folder selected, Info
  lists up to five **Related** files from `similarTo`, never the file
  itself, each showing the file in the list when clicked. The window asks
  once the selection has settled (not on every arrow-key move) and shows
  nothing when there are none or the index has nothing for that file.

The preview at `/?fixture=connected-folder` shows sample Best Matches (search
for `quote`), index rows (a complete folder with skipped files, one still
indexing), and Related for `Kitchen refresh/ideas.md`.
