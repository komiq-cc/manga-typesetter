# P9: what happens to a chapter lettered before the Rust engine

Branch `tp/chapters`, on top of `a0c00bf3`. Two rounds: eleven commits and
the report's own in the first; then the coordinator's merge of `text-port`
(`9757ac50`) and nine commits answering an outside review in the second.
All are listed in section 13.
The briefs are `tp-data/briefs/p9-old-chapters.md` (sections 2 to 6 carry its
item numbers) and `tp-data/briefs/p9b-old-chapters-fixes.md` (section 14,
"Second round"). Sections0–10 and12–14 retain historical measured proofs;
section11 gives the current write contracts, and section15 separates current
P9c repair evidence from its preserved failed drafts. Historical wording is
not current acceptance policy.

Every figure is marked **measured** or **inferred**. Measured on the 13
chapter copies means: the app's own store, switch and font sync in node, the
wasm with sha256 `1aba362c…13ac44` (1,603,347 bytes; the first round ran on
`1c6e5e3f…`, before the merge), the user's 63 font families from
`tp-data/fonts`, and this Mac's installed fonts (432 families found). Measured
in Chromium means headless Chrome 155 driven by
`scripts/text-port/p9-check.mjs`. The machine was loaded while these ran.

No chapter text is in this file. Boxes are named by id. The pictures and the
report for signing are under `tp-data/reports/p9`.

## 0. Result

Current P9c persistence and model results are in section15. The table below
is historical second-round evidence; it does not certify the current tree.

Second round, final tree `3f368143` (every row measured):

| proof | result |
|---|---|
| dry run, twice | byte-identical: 917 files, one digest (section 3). Exit 0 |
| dry run, gate G6 | x, width, size changed: 0. Heights shrank: 0. Top edge moved without its height: 0. The same as a long strip: 0 (2,487 boxes, each opened under both layouts) |
| unexplained changes | 0 of 442 changed boxes |
| dry run against the first round | no total of the first round moved; 911 of 917 files have the same bytes, all 30 sheets and every picture among them (section 14) |
| review findings | 11 of 11 reproduced on `9757ac50` before any fix; 11 fixed (section 14) |
| tests for the first fit | 86 tests in 4 files (first round: 31 in 3); 63 mutations, each fails at least one (section 7) |
| browser check | 21 of 21 checks pass, 0 page errors (section 8) |
| `./node_modules/.bin/vitest run` | 130 files: 128 passed, 2 skipped (env-gated), 0 failed. 3,510 tests: 3,502 passed, 8 skipped, 0 failed. Load 6 to 10 while it ran. The first round ended at 123 files and 3,379 tests on its own tree; the merge of `text-port` and this round account for the rest |
| `npm run build` | exit 0; two messages, neither from this phase: the chunk-size warning, and `INEFFECTIVE_DYNAMIC_IMPORT` for `@tauri-apps/api/app.js` (imported both ways by `package-flow.js` and two components). `npm run build:engine` before it: exit 0, wasm sha256 `1aba362c…13ac44` before and after |
| capture, default mode, against `runs/ref-sk/base` | run `p9b-sk`: 64,718 metrics, 17,538 layouts, 3,732 pictures, 0 errors. `diff -rq`: 3,405 files each side, only `manifest.json` differs. Run deleted |
| capture, `--engine new`, against `runs/new/r4` | run `p9b-new` (wasm `1aba362c…`): 64,718 metrics, 17,538 layouts, 3,732 pictures, 0 skipped, 0 errors. `diff -rq`: 3,736 files each side, only `manifest.json` differs. Run deleted |

## 1. The design: what the version number is for (item 4, first part)

**Before.** Every chapter file has `typesetting: { mode, version }`.
`version` was `LAYOUT_VERSION = 1` in every file, or absent. Nothing read it.
It was stamped "so a later change to the rules can tell the chapters set
under the old ones apart".

**Now.** The number says which engine last fitted the chapter's boxes.

| version | meaning | written by |
|---|---|---|
| 1, or absent | boxes last fitted by the browser | a save with the browser measuring |
| 2 | every box in the file was fitted by the Rust engine | a save with the Rust engine measuring and no box of the chapter still waiting for its font |

A save taken in any other state writes the number the file had: the Rust
engine measuring while a box still waits for a font (the 2 follows with the
save that font's arrival then causes), or the switch on and the engine still
starting (nobody has fitted the open document). Three states, not two;
section 14, findings 4 and 6.

- **Read** once, at open, and only with the switch on: a chapter under 2 is
  one the Rust engine has not fitted. `beginFirstFit`,
  `src/lib/store.svelte.js:1343`.
- **Written** only by a save, in one place: `stampTypesetting`,
  `src/lib/store.svelte.js:1621`, called by the saver as it takes its
  snapshot, `src/lib/library.svelte.js:2044`. An open never writes it. The
  open chapter takes the number in memory when that write lands
  (`stampLanded`, `:1635`, from `markSaved`), not when it is taken: a write
  that fails has stamped nothing.
- **The stored format** changes by this one integer's meaning. No field is
  added. Which boxes had their lines moved is not stored.
- `normalizeTypesetting` (`src/lib/data.js:131`) already kept any positive
  integer, so an older build reads a 2 as it reads a 1 and writes it back
  unchanged (inferred from that code; not run on an old build).

**First open of a version 1 chapter with the switch on.**

1. Every box is noted as the file has it, before the engine fits it.
2. The standing rule runs in memory: heights grow, flags are raised or
   cleared, lines may break elsewhere. Width, size and place do not change.
   One kind of box is outside the rule, under either engine and before this
   phase: a box stored as never laid out (`auto.status: 'pending'`, placed
   while its font was still loading) is laid out by the open that finds its
   font, width and size included. The notice counts it as "laid out for the
   first time". None of the 13 copies has one.
3. The text queue shows one notice with the counts (section 5).
4. Nothing is written. The chapter is not marked unsaved.
5. It is written when the document is no longer what was noted plus what
   the engine did (an edit, marked or not), or when the user presses Keep.
   That write carries the grown heights, the flags, and version 2 (version
   1 for as long as a box still waits for its font; the 2 follows).
6. Left untouched, nothing is written and the next open says the same again.
7. The switch turned off puts every box of an untouched chapter back as it
   was noted, a box laid out for the first time wholly.

"Untouched" is decided by comparing the document with the note, not by the
chapter's saved flag alone (`firstFitUntouched`, `store.svelte.js:1518`):
section 14, finding 1.

**A version 2 chapter under `'browser'`.** It opens as any chapter does today.
The browser's own grow-only pass runs. Leaving saves it, as leaving always
has under the browser, and that save writes version 1. The next open under
the Rust engine then shows the notice again. Measured in section 4.

## 2. Item 1: what the app did to an old chapter, and does now

### What was true before this phase (measured at `72343358`, switch on)

| field | changed by opening | count on the 13 copies |
|---|---|---|
| `x` | never | 0 |
| `w` | never | 0 |
| font size | never | 0 |
| `h` | grows only | 361 grew, 0 shrank |
| `y` | only together with `h` (a box grows about its vertical anchor) | 359; alone 0 |
| lines | can change | 7 of 2,292 compared with Safari |
| `review` | raised or cleared | 75 raised, 4 cleared |
| a box stored as `pending` | would be laid out afresh, width and size included | 0 such boxes in the 13 copies |
| marked unsaved at open | no | 0 of 13 |
| marked unsaved after its fonts arrived | yes, when a system family's bytes land after the open and a box grows | 1 of 13 (`doratama__051`) |
| written to disk | the whole document, 800 ms after that font; and the whole document on leaving, edited or not | leaving: 13 of 13 |

So the standing rule held for the boxes. Two things went beyond it, both
about the file:

- **A1.** A font landing after the open scheduled a write nobody asked for.
- **A2.** Leaving wrote the whole document, with the engine's heights and
  flags in it, though the user had touched nothing. Leaving writes under the
  browser too; under the browser nothing in the file has changed.

The two "marked unsaved" and "written" rows were measured at `72343358`, in
a scratch run that is deleted. The box counts in the table are the final
run's: the open treats boxes the same before and after this phase, and the
scratch run did not yet count the 3 boxes without text (it read 358 grown).
The two defects are re-made by mutations M1 and M2 (section 7), and the tests
fail on them.

### What the code does now

| what | where |
|---|---|
| boxes and pages noted before the load's fit | `store.svelte.js:312`, `beginFirstFit` `:1343`, `noteBox` `:1317` |
| noted when the switch comes on over an open chapter | `setFontSource`, `store.svelte.js:5717` |
| the engine's own writes told from anybody else's | `fitting`, `fitted`, `store.svelte.js:1409`, `:1413`; around `growAndReview` `:1023` and `solvePending` `:1772` |
| a grow-only relayout schedules no write while the Rust engine is on (A1) | `relayoutAll`, `store.svelte.js:1720` |
| leaving a chapter that is only what was noted plus what the engine did writes nothing (A2) | `flushSave`, `store.svelte.js:2227`; the test, `documentAsFitted` `:1519` |
| the switch going off restores `y`, `h`, `review` and the solver's stamp, and a box laid out for the first time wholly; the same test decides | `endFirstFit`, `store.svelte.js:1542` |
| the version is stamped by the saver, and taken when the write lands | `stampTypesetting`, `store.svelte.js:1621`; `stampLanded` `:1635`; `library.svelte.js:2044` |

With `textEngine: 'browser'` no font source is set, so `beginFirstFit`
returns at its second line with nothing noted, `fitting` finds no note,
`firstFitUntouched` answers no at its first line, `relayoutAll` takes the
branch it always took and `flushSave` is not gated. `stampTypesetting`
leaves a 1 a 1.

### Numbers after (measured, 13 copies)

| | before | now |
|---|---|---|
| marked unsaved by opening | 0 of 13 | 0 of 13 |
| marked unsaved after fonts arrived | 1 of 13 | 0 of 13 |
| saves by opening | 0 | 0 |
| saves on leaving, untouched | 13 of 13 | 0 of 13 |
| saves by Keep | n/a | 1 each, version 2 |

A real file: `src/lib/first-fit.engine.test.js` runs the real library over
node's filesystem with the wasm. Every file under the chapter's folder has
the same sha256 before the open, after the open, after a system font landed
late, after the debounce, and after leaving (measured).

## 3. Item 2: the dry-run tool

```
node scripts/text-port/dry-run.mjs --data <tp-data> --out <dir> --legacy-mode smart [--load-fixtures yes]
```

`--legacy-mode smart|plain` has **no default, and the 13 copies need it**:
the run stops at the first chapter that carries no `typesetting.mode` of its
own ("chapter has no typesetting.mode; pass --legacy-mode smart|plain"). 5
of the 13 copies are such chapters (measured). The app opens such a chapter
with what this machine's typesetting switch said when the build that added
the field first ran (`legacyTypesetting`, `src/lib/data.js:150`), which no
copy carries, and the two modes break lines differently: a default would be
a guess that changes the counts. The first round's command line showed the
flag in brackets as if it could be left out; for a data set in which every
chapter carries its mode it can, for this one it cannot.

| part | job |
|---|---|
| `scripts/text-port/dry-run.mjs` | the command; exit 2 on a G6 breach (as pages or as a long strip) or a chapter it refused to open; exit 1 when the run failed |
| `src/lib/text-port-dryrun.realfont.test.js` | the lane: the app's open path on each copy |
| `scripts/text-port/lib/dry-compare.mjs` | what changed for one box |
| `scripts/text-port/lib/dry-report.mjs` | counts, causes, pictures, the two reports |
| `scripts/text-port/lib/installed-fonts.mjs` | the native font answers, re-made in node |

Per chapter the lane runs five opens: nothing measuring (the file's own
flags), the browser's stand-in, the Rust engine as pages, the Rust engine as
a long strip, and the Rust-fitted document back under the stand-in. With the
Rust engine it also reads the notice's counts, leaves, keeps, and records
what each wrote.

What it will not guess (second round, section 14): a stored box is matched
with the box the open made of it by where it stands, as the loader carries
it, and a stored box with no partner stops the run; a box with text and no
layout under an engine stops the run; a chapter with a page the real loader
repairs from its picture (`needsRespace`, or no size) is not opened and the
report says so at its head and exits 2; the project's layout, which the
copies do not carry, is run both ways.

**Deterministic (measured).** Two runs, same tree `3f368143`: `diff -rq`
empty, 917 files each, sha256 of the sorted list of every file's sha256
`085128cf…d860a3dc` both times. No time, home path or random number is
written.

**Reads copies only.** Every path goes through `guardedPath` under `--data`.
It writes under `--out` and nowhere else.

Three things are stood in for, and the report names each: the library's
`loadChapter` (three calls, made in its order), the native side, and the
browser (Skia). Skia cannot break plain text, so the three plain chapters
have no stand-in run.

## 4. Item 3: the report, and what I saw

Written to `tp-data/reports/p9`: `report.html` (21.9 MB, one file, pictures
inside), `report.md`, `totals.json`, `boxes.jsonl`, `sheets/` (30 contact
sheets), `img/`, `raw/`. Opened as `--legacy-mode smart`, as the corpus was
cut.

### Totals (measured)

| | count |
|---|---|
| boxes, in 13 chapters | 2,487 |
| with text | 2,302 |
| compared with Safari's lines and positions | 2,292 |
| x, width or size changed | **0** |
| height shrank | **0** |
| top edge moved without its height | **0** |
| the same three as a long strip | **0** |
| grew taller | **361** (largest 210.49 px, median 6 px) |
| newly flagged | **75** |
| no longer flagged | **4** |
| line breaks changed | **7** |
| text block more than 0.5 px from Safari's | 56 (25 over 2 px); 39 of them in a box that did not change otherwise |
| boxes in a font this Mac lacks | 35 (32 with text), 5 families |
| boxes borrowing a letter | 30 |
| stored as `pending` | 0 |
| stored without an id, or with one used twice (compared under a repaired id) | 0 |
| chapters not opened (a page repaired from its picture) | 0 of 13; such pages: 0 of 793 |
| boxes with text and no layout under an engine | 0 |
| come out differently as a long strip | 8 (a top edge the page holds at its own edge; no height, no flag differs); 253 more differ by less than 0.000001 px |
| flagged in the file, flagged after | 119, 190 |
| changed in any way | 442 |
| **unexplained** | **0** |

### Causes (measured; decided from a recorded fact, named in each sentence)

| change | the file was already behind today's app | rule 4 (ink boxes) | missing built-in font (D2b) |
|---|---|---|---|
| grew, 361 | 352 | 0 | 9 |
| newly flagged, 75 | 59 | 9 | 7 |
| no longer flagged, 4 | 0 | 3 | 1 |
| lines, 7 | 0 | 0 | 7 |
| block moved, box unchanged, 39 | 0 | 19 | 20 |

- **Already behind (411).** Safari's own line count needs more height than
  the file has, or Safari's own check already finds the overflow. Today's app
  does the same on open. 3 of the 352 are boxes with no text, grown to one
  line's height.
- **Rule 4, newly flagged (9).** A true overhang on the right, 1 to 7 px:
  Arenzi 5, JACKBRUSH 3, FairyTale Regular 1. WebKit reports a line's advance
  as its ink edges and never saw it. This is the count the plan's preview
  gave.
- **Rule 4, no longer flagged (3).** The outline's own box is inside where
  WebKit's stepped box was not.
- **Rule 4, moved (19).** 0.57 to 2.72 px; 2 over 2 px. Since the second
  round each is checked, not assumed: the shift the two engines' ink boxes
  predict is set beside the shift seen, and the sentence is said only when
  they agree within 0.05 px, the block is set in the middle and it did not
  move sideways. All 19 agree, the worst by 1.3e-13 px (section 14, finding
  9).
- **Rules 7, 8, 9, 10, 11.** No change is attributed to any of them. 30
  boxes borrow a letter (rule 11); 5 of those changed, each by a nearer cause
  in the table above.
- **Engine-caused line changes in a font the user has: 0.**

### What I saw in the pictures

I looked at all 30 sheets (442 boxes, Safari left, Rust right), and at three
pictures at full size. That was the first round. The second round's run
wrote the same 30 sheets and the same 880 pictures, byte for byte
(measured, on the new wasm), so there was no changed sheet to look at again
and what follows stands.

| sheets | boxes | what I saw |
|---|---|---|
| `lines-01` | 7 | All Bangers. Safari: Bangers, capitals. Rust: Helvetica Neue, mixed case as typed, more or fewer lines. The outline is kept. Not acceptable as lettering; it is the missing font, not the engine |
| `newlyFlagged-01` to `-05` | 75 | 68 pairs: same words, same lines, same face; I could not tell the two apart at sheet size. That fits: 59 are flags Safari would raise too, 9 are overhangs of 1 to 7 px. 7 pairs: Bangers set in Helvetica Neue, visibly wider |
| `unflagged-01` | 4 | 3 pairs alike. 1 (`doratama__051.p24.bb349`, Bebas Neue): Safari's capture has no picture; Rust sets it in Helvetica Neue in a narrow column |
| `grew-01` to `-21` | 326 | 320 pairs: same words, same lines, same face. Where the box grew a lot the right picture is drawn smaller: each picture is scaled to its cell. 3 pairs: Bangers in Helvetica Neue. 3 cells empty: the boxes with no text |
| `moved-01`, `-02` | 30 | 19 pairs alike (the shift is under 3 px). 11 pairs: Bangers in Helvetica Neue, two of them set one letter to a line |

One thumbnail was too small to read (`tsukimichi__122.p11.bb139`, the box
that grew 210 px). At full size: the same 13 lines, the same letters.

I saw no pair where a font the user has was drawn differently, broke
differently, or lost a letter.

### A version 2 chapter back under the browser (measured with the stand-in)

2,102 boxes of the 10 smart chapters, as the Rust engine left them, opened
with the switch off:

| | count |
|---|---|
| x, width or size changed | 0 |
| grew again | 3 |
| flag raised | 11 |
| flag cleared | 8 |
| version written by leaving | 1 (10 of 10 chapters) |

Against Safari instead of the stand-in (inferred from the capture, boxes
whose height did not change): Safari would raise 4 flags and clear 11. The
11 include the 9 rule 4 overhangs: Safari does not see them.

## 5. Item 4: the notice (built)

`src/lib/EngineNotice.svelte`, mounted in the text queue above the review
list (`src/lib/Queue.svelte:287`).

- **Says:** boxes with new line breaks, newly flagged, no longer flagged,
  grown taller, laid out for the first time. Then: no box (no other box,
  when one was laid out for the first time) changed its width, size or
  place; nothing is saved until you edit the chapter or keep these.
- **Step through:** it builds no list. A flagged box is in the review list
  as always. A box whose lines moved and that still fits is listed there
  too, with the reason "Line breaks changed with the new text engine", until
  the notice is answered (`flaggedBoxes`, `store.svelte.js:1162`). It is not
  a flag: the canvas badge and the PSD ask `reviewOf`, which does not answer
  with it. "Show first" selects the first such box.
- **Keep:** saves once, at version 2, and the notice goes. The chapter is
  marked unsaved at the press; the write waits for any box still waiting for
  its font, so that what is kept is everything the engine has to say. After
  an edit has already saved, the button reads "Got it" and only closes. When
  the write fails the notice comes back with Keep to press again, a toast
  says "Could not save: …" and the save indicator shows the failure
  (`keepFirstFit`, `store.svelte.js:1577`; section 14).
- **Not shown** with the browser measuring, for a version 2 chapter, or when
  nothing changed.
- **Counts** come from `firstFitChanges`, `store.svelte.js:1472`. They are
  counts of what the engine did: a box is counted only while it is still as
  the engine left it (`stillFitted`, `:1402`). A box the user has since made
  taller, moved, re-flagged or edited is theirs and drops out, so the counts
  can only fall after the fit, and a notice that was absent cannot appear
  because of something the user did (section 14, finding 11).
- Settings said "chapters are not marked". It now says what happens
  (`src/lib/SettingsModal.svelte:609`, `:616`).

**"New line breaks" in the app.** The file does not hold how a box's lines
broke. The app asks the engine that measured before the switch, once, when it
notes the boxes (`linesBefore`, `store.svelte.js:1368`). In the app that is
WebKit. At cut-over there is no such engine: the count is then never set and
the notice shows heights and flags only. This is scaffolding, marked `AT
CUT-OVER` in the code.

### What the notice says for each chapter (measured, 13 copies)

"Lines" is against the node stand-in here, so it is not the app's number:
the app asks WebKit. The other three agree with the report's own count in
all 13.

| chapter | shown | grew | newly flagged | no longer | lines (stand-in) | lines (Safari, report) |
|---|---|---|---|---|---|---|
| deli-health__011 | yes | 0 | 0 | 0 | 1 | 0 |
| deli-health__012 | yes | 0 | 0 | 2 | 0 | 0 |
| doratama__051 | yes | 2 | 7 | 1 | 3 | 1 |
| dungeon-steamer__001 | no | 0 | 0 | 0 | 0 | 0 |
| dungeon-steamer__002 | no | 0 | 0 | 0 | 0 | 0 |
| surviving-the-apocalypse-2__107 | yes | 19 | 9 | 0 | 0 | 0 |
| surviving-the-apocalypse-2__108 | yes | 18 | 7 | 0 | 0 | 0 |
| surviving-the-apocalypse-2__109 | no | 0 | 0 | 0 | 0 | 0 |
| the-wizard-who-lay-with-10000-girls__002 | yes | 0 | 2 | 0 | 0 | 0 |
| tsukimichi__121 | yes | 163 | 30 | 0 | 3 | 1 |
| tsukimichi__122 | yes | 159 | 19 | 0 | 10 | 5 |
| uncensored-dungeon-streamer__001 | yes | 0 | 1 | 0 | 0 | 0 |
| uncensored-dungeon-streamer__002 | yes | 0 | 0 | 1 | 0 | 0 |

10 of 13 chapters show the notice.

## 6. Item 5: former built-in fonts

Families named by a box that are neither in `tp-data/fonts` nor installed on
this Mac (measured; `system_profiler` also finds none of them):

| family | boxes | with text | chapters | drawn in today |
|---|---|---|---|---|
| Bangers | 29 | 28 | doratama__051 (8), surviving-the-apocalypse-2__107 (7), tsukimichi__121 (6), tsukimichi__122 (8) | Helvetica Neue |
| Bebas Neue | 2 | 2 | doratama__051 | Helvetica Neue |
| Caveat | 2 | 2 | doratama__051 | Helvetica Neue |
| Comic Neue | 1 | 0 | uncensored-dungeon-streamer__001 | Helvetica Neue |
| Patrick Hand | 1 | 0 | doratama__051 | Helvetica Neue |

**These five are the font files the user must load.** All five are former
built-ins. The list with pictures is section 4 of the tool's report.

**The app does not take them yet.** A font whose family name is a built-in's
is refused: `src/lib/fonts.js:806` ("is a built-in font") and `:753` for a
font arriving in a package. So the five cannot be loaded under their names
until the built-in list goes at cut-over. Not changed here (section 10).

What I saw: Bangers is a capitals-only face, so its boxes were typed in mixed
case and now show mixed case in Helvetica Neue. The Bebas Neue box is a
narrow column of nine lines with a borrowed lozenge. The Caveat box is grey
Helvetica Neue bold italic, four lines.

The user has "BebasNeue Regular" loaded. That is another family name; the two
boxes name "Bebas Neue".

All 7 changed line breaks, 7 of the 16 engine-side new flags and 9 of the 9
engine-side growths are in these boxes.

**With the fonts loaded (measured).** The repository has fixture files for
two of the five, Bangers and Comic Neue. `--load-fixtures yes` hands them to
the engine as loaded fonts, which is the state after the built-in list goes.
That run is scratch (`node_modules/.cache/p9/loaded`), not the report for
signing:

| | as today | Bangers and Comic Neue loaded |
|---|---|---|
| line breaks changed | 7 | **0** |
| newly flagged | 75 (59 behind, 9 rule 4, 7 missing font) | 69 (60 behind, 9 rule 4) |
| grew | 361 (352 behind, 9 missing font) | 357 (356 behind, 1 missing font) |
| block moved | 56 (25 over 2 px) | 28 (8 over 2 px; 19 rule 4) |
| boxes in a missing font | 35 | 5 (Bebas Neue 2, Caveat 2, Patrick Hand 1) |
| unexplained | 0 | 0 |

The stand-in browser, which has Bangers, breaks the 28 Bangers boxes with
text as Safari does (measured: 28 of 28).

Borrowed letters (rule 11), for completeness: 30 boxes. Helvetica Neue 16,
Lucida Grande 8, Hiragino Sans 7. No box has a letter no installed font has.

## 7. Tests, and the mutation each fails on

Fixture fonts and made-up chapters only.

| file | lane | tests | what it runs |
|---|---|---|---|
| `src/lib/first-fit.test.js` | unit | 52 (first round: 18) | the real store and switch on two stand-in engines that disagree by a known amount |
| `src/lib/first-fit.engine.test.js` | engine | 8 (5) | the real library over node's filesystem, the wasm, fixture fonts; reads the file's bytes |
| `src/lib/EngineNotice.dom.test.js` | dom | 10 (8) | the notice and the review list, mounted |
| `src/test/text-port/dry-run.test.js` | unit | 16 (new) | the dry run's own helpers: matching, refusing, the ink check, the long strip |

Mutations were run in a scratch copy under `node_modules/.cache/p9/mut`,
one at a time, each against these four files (measured on the final sources,
`3f368143`; **63 of 63 fail at least one test**; the list with the failing
tests' names is `node_modules/.cache/p9/mutations.json`). The first round's
21 were re-aimed at the code as it is now; S1 to S5 are the five the review
found alive; R and D are the second round's.

| | mutation | tests failed | files |
|---|---|---|---|
| S1 | "the Rust engine measures" is read as "a font source exists" | 1 | unit |
| S2 | no save for a late fit that an edit caused | 1 | unit |
| S3 | the switch going off does not put a top edge back | 4 | unit |
| S4 | the switch going off does not put a solver stamp back | 1 | unit |
| S5 | the old engine is asked for lines whether or not its face is ready | 2 | unit |
| M1 | a grow-only relayout schedules a write under the Rust engine (defect A1) | 4 | unit, engine |
| M2 | leaving writes an untouched first-fit chapter (defect A2) | 8 | unit, engine |
| M3 | the switch going off does not put the boxes back | 8 | unit |
| M4 | a save under the Rust engine does not stamp 2 | 13 | unit, engine, dom |
| M5 | a save under the browser leaves a 2 a 2 | 3 | unit, engine |
| M6 | a load notes nothing | 43 | unit, engine, dom |
| M7 | the switch coming on over an open chapter notes nothing | 2 | unit, dom |
| M8 | Keep does not save | 9 | unit, engine, dom |
| M9 | moved lines are never noted | 11 | unit, dom |
| M10 | the review list does not hold boxes whose lines moved | 4 | unit, dom |
| M11 | an edited box is still the engine's (counted, listed) | 1 | unit |
| M12 | a save does not count as kept | 6 | unit, dom |
| M13 | a chapter marked unsaved is still "untouched" when its boxes compare equal | 12 | unit, engine, dom |
| M14 | a version 2 chapter is noted like a version 1 | 3 | unit, engine |
| M15 | the notice shows with nothing to say | 1 | dom |
| M16 | an answered notice still counts | 6 | unit, dom |
| M17 | the saver writes the version it read | 4 | engine |
| M18 | nobody answers how the lines broke before | 9 | unit, dom |
| M19 | the note for moved lines is a flag (`reviewOf` answers with it) | 1 | unit |
| M20 | the open changes a width | 26 | unit, engine, dom |
| M21 | a chapter with no boxes is not noted, so leaving writes it | 1 | unit |
| R1 | untouched is the flag alone: no box is compared (findings 1, 10) | 7 | unit, engine |
| R2 | the comparison leaves out what a fit may write: top, height, flag, stamp (finding 10) | 3 | unit |
| R3 | the comparison leaves out the rest of the box: across, width, size, text | 4 | unit, engine |
| R4 | the page itself is not compared (its boxes' order, its lines) | 1 | unit |
| R5 | the number of pages is not compared | 1 | unit |
| R6 | the loader's dirty flag is read as the user's edit (finding 3) | 1 | unit |
| R7 | the loader's flag is never raised | 1 | unit |
| R8 | a pending box gets its top and height back but not its place across and width (finding 2) | 2 | unit |
| R9 | a pending box keeps the solver record the engine left | 2 | unit |
| R10 | a box laid out for the first time is not counted | 3 | unit, dom |
| R11 | a save stamps 2 while a box still waits for its font (finding 4) | 4 | unit, engine |
| R12 | the save owed for the stamp is never made | 2 | unit, engine |
| R13 | Keep does not wait for the fonts | 1 | unit |
| R14 | Keep does not mark the chapter unsaved while it waits | 9 | unit, engine, dom |
| R15 | a save with the engine still starting turns a 2 into a 1 (finding 6) | 1 | unit |
| R16 | the notice counts a box the user has changed since (finding 11) | 5 | unit |
| R17 | a fit takes a box of the user's for the engine's again | 1 | unit |
| R18 | what the engine wrote is not kept as the engine's | 27 | unit, engine, dom |
| R19 | a Keep that could not be written leaves the notice answered | 3 | unit, engine, dom |
| R20 | the version and "kept" are taken when the save is taken, not when it lands | 3 | unit, dom |
| R21 | a save that failed keeps its stamp for the next landing | 1 | unit |
| R22 | in a long strip a box the open does not grow has its top written again | 1 | unit |
| R23 | a box laid out for the first time in an untouched chapter schedules a write | 1 | unit |
| R24 | the notice does not show for a box laid out alone | 1 | dom |
| R25 | a failed Keep says nothing | 1 | dom |
| R26 | a solve of a pending box is not the engine's write | 4 | unit, dom |
| D1 | a stored box is matched by the id in the file, repaired or not (finding 5) | 1 | dry |
| D2 | a stored box with no partner is passed over (finding 5) | 1 | dry |
| D3 | a page the open rescales is not found (finding 7) | 1 | dry |
| D4 | a layout that threw is an unchanged box (finding 8) | 1 | dry |
| D5 | a moved block is the ink boxes whatever they predict (finding 9) | 1 | dry |
| D6 | a moved block is the ink boxes whatever its alignment | 1 | dry |
| D7 | a moved block is the ink boxes though it moved sideways | 1 | dry |
| D8 | a flag newly raised is rule 4 without Safari's own check | 1 | dry |
| D9 | a flag cleared is rule 4 without Safari's own check | 1 | dry |
| D10 | a flag that differs as a long strip is the strip's arithmetic | 1 | dry |
| D11 | a top the strip left elsewhere is the strip's arithmetic | 1 | dry |

Four of these (R5, R17, R21, D8) survived their first run in this round; a
test was added for each and each then fails (commit `2d7432dd`).

## 8. The browser check

```
node scripts/text-port/p9-check.mjs --data <tp-data> [--out <dir>] [--chapter <stem>]
```

`p9-check.html` and `src/test/p9-check/host.js`: a dev-only page with the
editor's canvas and the real text queue on the real store, switch and wasm.
The driver starts its own Vite on port 5205 and Chromium with DevTools port
9383, and stops both (measured: nothing listening on either port after).

Run on the copy `tsukimichi__122` (366 boxes, 104 of the user's font faces).
Measured, second round, tree `079a5068` and after:

| step | result |
|---|---|
| switch off, chapter open | no notice, nothing noted |
| switch on over the open chapter | notice: 10 boxes with new line breaks, 6 grew. Not unsaved; 0 saves after 1.1 s |
| switch off again | every box's rectangle, size and flag as before; no notice; 0 saves |
| switch on, opened from the file | notice: 10 new line breaks, 19 newly flagged, 160 grew. Not unsaved; 0 saves after 1.1 s |
| leaving untouched | 0 saves (the comparison, with the real components mounted) |
| Show first | goes to page 2 and selects a box |
| review list | 29 rows: 19 flagged and 10 "Line breaks changed with the new text engine" |
| Keep | 1 save, version 2; notice gone; list back to 19 |
| kept chapter opened again | no notice, version 2 |
| kept chapter under the browser, then leaving | no notice; 1 more save, version 1 |
| reopened under the Rust engine; a box the engine left as the file has it is taken by its bottom handle with the real mouse (DevTools `Input.dispatchMouseEvent`), dragged 60 px, the button kept down | the box is taller (506.5 to 716.3 px in page space); the chapter still reads "saved"; the notice still says 160 grew |
| the flush called with the button still down | 1 more save, and the box in it has the dragged height |
| the button let go | the notice still says 160 grew; the app's own save follows |

21 of 21 checks pass; 0 page errors. The load took 276 ms with the noting,
123 ms for the version 2 chapter, 245 ms under the browser (one run, load 5).

Pictures: `tp-data/reports/p9/check/3-opened-window.png` (the window, notice
at the top of the queue), `4-review-list.png` (the list opened),
`6-handle-held.png` (after the handle step) and five more. I looked at
`3-opened-notice.png` and `6-handle-held.png` again in this round: the
notice reads as designed; after the dragged box was saved it reads "These
are saved with the chapter" with "Got it", and its counts are the same as
before the drag.

Three limits of this check. The page has no filesystem, so its saver stamps
as the app's does and counts; the real file is the engine test's business.
The browser here is Chromium with no system fonts, so its last resort is one
of the user's fonts and its counts are not the desktop app's. And "leaving"
is the store's flush, not the window's close: the app's quit path
(`flushBeforeLeaving('quit')`) is run by the engine test, on a real file.

## 9. Choices this brief did not make

1. **The version is written by a save, by the engine that has fitted what
   is saved.** Rust, with no box waiting for a font: 2. Browser: a 2 becomes
   1, any other number stays. Rust with a box still waiting, or the engine
   still starting: the number the file had. So the number is always "who
   last fitted everything that is in the file".
2. **A grow-only relayout never schedules a write while the switch is on.**
   Not only on a first fit: for a version 2 chapter too. The height is worked
   out again at every open and reaches disk with the next save.
3. **A version 1 chapter that is only what was noted plus what the engine
   did is not written on leaving** with the switch on. Decided by comparing
   the document with the note (second round). Under the browser leaving
   still writes, as before.
4. **The switch going off restores the boxes** of such a chapter, by the
   same test. An edited or kept one stays as it is.
5. **A chapter with no boxes is treated the same**: not written by leaving,
   stamped 2 by its first edit.
6. **"New line breaks" is counted in the app by asking the pre-switch
   engine.** It ends at cut-over (section 5).
7. **Moved-line boxes are listed in the review list, not flagged.** Session
   only, never stored, and not seen by the badge or the PSD.
8. **Grown boxes are counted, not listed.** 352 of 361 are the file being
   behind; a list of them would bury the 16 that matter.
9. **The notice returns at every open until answered or edited.** Nothing
   records "seen" outside the file's version.
10. **`kept`, and the version in memory, are set when the write lands**
    (`markSaved`), not when the saver takes its snapshot. The first round
    chose the opposite; it made a failed Keep look kept. A failed write
    leaves the notice standing, the save indicator red, and leaving retries.
11. **The dry run treats Bangers and Comic Neue as missing**, though the
    harness has fixture files under those names: the app has no file for a
    built-in.
12. **The native font answers are re-made in node** (inferred to match the
    Rust commands; they decide only the 35 missing-font and 30 borrowing
    boxes).
13. **"Moved" means more than 0.5 px**, the app's own containment tolerance.
14. **Legacy mode `smart`**, as the corpus was cut.
15. **Boxes with no text are counted** for their rectangle (3 grow).
16. **Settings' text was corrected**; it said chapters are not marked.
17. **`--load-fixtures yes`** was added to the dry run, to measure what is
    left once two of the missing fonts are loaded. The report for signing is
    run without it.
18. **The review list's moved-line rows end with the notice.** Keep, "Got
    it", an edit to the box, or the switch going off removes them.

Second round:

19. **Finding 1 is answered from the store, by comparison**, not by reading
    a gesture state. No line of `TextBox.svelte` is needed.
20. **A box stored as never laid out is noted whole and put back whole**,
    and counted as "laid out for the first time". In a chapter that is
    otherwise untouched its solve schedules no write: it is the open's
    doing, and is redone at the next open.
21. **The stamp stays the file's number until a save with nothing waiting
    for a font**; the font's arrival then causes the save that carries the
    2. And Keep waits for the fonts as well. The user's edit is never held:
    it is written at once, at the file's number.
22. **The notice counts only boxes still as the engine left them.**
23. **A gesture that is cancelled, or an unmarked change put back by hand to
    the last bit, reads as untouched again.** Anything short of that is
    written on leaving: the comparison errs towards writing.
24. **The long-strip float fix is behind the switch only** (section 14,
    "Found by the dry run"). Default mode still rewrites such a top edge in
    its last bit, as it did before this phase.
25. **The dry run refuses a chapter it cannot open as the app would** rather
    than making the loader's repair itself: the copies have no pictures.
26. **The dry run opens every chapter under both layouts**, since the copies
    do not say which their project has. The report's totals are the open as
    pages; the long strip is a section and a gate of its own.

## 10. What I did not do

- I did not run the desktop app. Everything is node or Chromium.
- I did not measure the app's "new line breaks" against WebKit. The report's
  7 are against Safari's capture; the app's own count needs the app.
- I did not run an older build on a version 2 file (inferred from
  `normalizeTypesetting`).
- A chapter whose load has to mint ids or repair page sizes is still marked
  unsaved by opening, as under the browser, and with the switch on that save
  carries version 2 and the engine's heights. None of the 13 copies is one
  (measured: 0 minted).
- The notice is not shown in translate mode differently; a translate chapter
  has no boxes and shows none.
- The three plain chapters have no "back under the browser" run: the node
  stand-in cannot break plain text.
- I did not lift the refusal of a user font named like a built-in
  (`src/lib/fonts.js:753`, `:806`). It belongs with removing the built-in
  list (cut-over). Until then the five families of section 6 stay in the
  last resort.
- The first round's mutations were not run against the dry-run tool. The
  second round's 11 are run against its helpers (`dry-compare.mjs`,
  `dry-report.mjs`), not against the lane that drives the app.
- What the comparison costs was not timed. It reads every box once, as a
  save's snapshot does, at a flush and when the switch goes off.
- I did not look for the long-strip last-bit rewrite's effect on files
  already saved under the browser, and did not change default mode.
- No count of solver stamps moved by a grown height. They are restored with
  the heights.

## 11. Exactly what is written to the user's files, and when

These are the current persistence contracts. Section15 separates current
measured proofs from preserved historical runs; integrated captures and final
whole-P9 review remain the coordinator's acceptance work.

Both browser and Rust final saves converge on the actual outgoing document,
version and mode before ordinary leave/quit/open succeeds. Every actual
chapter.json AND translations.json receipt advances the snapshot ledger; an
older receipt cannot mark newer live intent saved or cancel its pending timer.
An already armed newer debounce keeps its deadline. Newly discovered actual
byte debt arms the natural800ms save even when the saved flag was already false.
Startup readiness alone does not cause repeated identical version1 writes.

A snapshot actually saved under the browser changes version2 to version1;
turning the switch off alone can leave a saved version2 file in place.
Outstanding final ownership stays until its original operations settle.
Physical writer/catalog receipts are retained for their own reference and load
cycle; stale completion cannot alter incoming Keep, stamping or failure state.
Ordinary successful replies are never accepted as known browser-loss prefixes.

With the switch **on**, a version1 chapter is untouched when its durable
chapter mode, typesetting settings, pages in order, and boxes equal the open
plus the engine's own recorded fits, nobody marked an edit, no save has
landed or is in flight, and nobody pressed Keep. Engine-only fits in that
state do not write. Version2 also has private ownership notes, with no
notice, so an engine-only late grow does not arm an autosave; its normal
leave-save contract is retained.

| moment | written |
|---|---|
| opening, a late font, or waiting with an untouched/unkept version1 chapter | nothing |
| leaving/quitting an untouched version1 chapter | nothing |
| switch off for that untouched version1 chapter | nothing; whole boxes return to their open state |
| leaving/quitting/switch off after an unmarked durable change (a held handle, style/fit/text, picture association, translation, page order or mode) | the two document files as the user's document stands; no restore over the change |
| an edit save while a font is still held or the engine still starts | chapter.json and translations.json from one snapshot; the file's current version remains (1 or2) |
| the engine starts/a font lands after a save snapshot | settlement compares the actual current document/version to the landed snapshot; a newer document arms a follow-up save, even if the older write cancelled a debounce |
| a font lands while the final leave/quit/chapter-switch snapshot is held | the outgoing document's actual newer bytes must land before that boundary finishes; no debounce rescue or wait for a still-absent future font |
| an older Rust write lands after off/on, or a browser write already in flight lands after Rust is turned on | the original snapshot remains owned; the newer document cannot become an opened baseline; its natural follow-up debounce writes both files |
| ready Rust save, with no box waiting on any page | the whole document at version2 |
| Keep while a font waits | one deferred write; no ordinary debounce from the press; saved state can remain true while the visible notice says Keep is waiting |
| Keep's fonts land, or four-second deadline expires | write what is ready once; if any font still waits, retain the file's version; close the notice only after both document files land |
| edits reduce all five notice counts to zero during Keep or after its failure | the waiting or retry notice stays visible until the choice finishes |
| a font finally arrives after that deadline | save the fitted document and its ready version2 |
| leaving/quitting/switch off during Keep's wait | honor the choice by writing what is ready; Keep's waiting state belongs to that chapter and is cleared when it ends |
| chapter.json lands but translations.json fails | the whole save has failed: indicator stays failed/unsaved, no new ledger snapshot or kept claim; retry writes both files |
| an older snapshot lands after a durable change | it cannot mark the newer document or fits kept/saved; settlement arms the outstanding write |
| a snapshot's two files land while a newer final/Keep save is queued | its own receipt advances the actual disk ledger; only the latest queued call can clear the indicator/timer |
| load that mints ids or repairs pages | the existing repair/save path remains; the saved snapshot follows the same version rule |

No new persisted field is added. Line-break notes and Keep's waiting state
are memory only. The comparison includes every serialized box/style key,
page/detection/translation data, durable filenames and order. It excludes
runtime picture URLs and editor selection. The version decision is derived
from the engine and every waiting box at each snapshot; it is not a debt
flag remembered when a prior write began.

The prior measured engine-test folder digests in section14 are historical
proofs; the new whole-tree and real-file proofs are listed in section15
only after their new runs finish.

## 12. What only the desktop app can show

A list to walk through, on a copy of a chapter, with the switch on:

1. Open `tsukimichi__122`. The notice is at the top of the text queue. Its
   "new line breaks" count is WebKit's: expect about 5 (Safari's capture),
   not Chromium's 10.
2. Check the file's modified time before and after opening, waiting, and
   going back to the library. It must not change.
3. Press "Show first", then open the review list and click through. Rows
   with "Line breaks changed with the new text engine" must jump to boxes
   that look right.
4. Turn the switch off in Settings. The boxes must return, and the file must
   still be unmodified.
5. Turn it on, press Keep. The file changes once; `typesetting.version` is 2.
6. Open it again: no notice.
7. Turn the switch off, open it, leave. `typesetting.version` is 1 again.
8. Open `doratama__051`: the font notice lists Bangers, Bebas Neue, Caveat
   and Patrick Hand as missing, and those boxes are in the last resort.
9. Try to load a Bangers file in the Font Library. Today the app answers
   "is a built-in font" and does not take it. After cut-over it must take
   it, the 8 Bangers boxes must be Bangers, and the line-break count must
   drop.
10. Long strip mode: "Show first" must scroll the strip to the box.
11. How long the first open takes on the largest chapter (398 boxes). The
    noting asks WebKit for every box's lines once.
12. Quit with an unedited first-fit chapter open: nothing written.
13. Second round. Take a box by a resize handle, hold the button down, and
    quit with Cmd+Q: on the next open the box is as the hand had it. In
    Chromium the check does this through the store's flush (section 8); the
    app's own quit path is `flushBeforeLeaving`, run in the engine test on a
    real file, but not in the app itself.
14. Make a box taller by hand in a chapter the notice is showing for: the
    "grew taller" count must not rise.
15. A chapter with a box placed while its font was loading (stored
    `pending`): the notice must say "laid out for the first time", and the
    switch going off must leave that box exactly as the browser lays it out.
    None of the 13 copies has one.

## 13. Commits

| commit | what |
|---|---|
| `72343358` | the dry run, its lane and its report |
| `ff171936` | first fit in the store: noted, not written, restored, stamped; unit and engine tests |
| `8d5afb33` | the notice in the queue; dom test |
| `4a11c87d` | the dry run reads the notice's counts and what leaving, Keep and going back write |
| `df3f06d1` | the browser check, its page and driver; README |
| `bdd6db71` | Settings' text |
| `5050b422` | the dry run counts top edges |
| `2fae5f7b` | a chapter with no boxes; boxes without text in the dry run |
| `2a3e526b` | the missing-font count's wording |
| `392c9905` | the moved-lines note made lazily (a load-order fault the whole suite found) |
| `372e8c82` | `--load-fixtures`; the engine test says Keep writes two files |
| `51ae6ddb` | the first round's report |
| `9757ac50` | the coordinator's merge of `text-port` (P8); new wasm `1aba362c…` |
| `b12482d8` | second round: untouched by comparison; the engine's writes told apart; pending boxes whole; the loader's flag; the stamp's three states, owed and landed; Keep waits and can fail; the counts |
| `64b9b505` | the notice: laid out for the first time; a failed Keep |
| `0d0bcda9` | the dry run: matching by place, refusing, layout failures, the ink check, the long strip; its unit tests |
| `97ecd8a1` | a long strip's top edge, to the last bit, behind the switch |
| `74ad573a` | the dry run tells the strip's arithmetic from a real difference |
| `079a5068` | the browser check's handle step |
| `2d7432dd` | four tests for mutations that survived |
| `3f368143` | the dry run's long-strip sentence |
| this section's commit | `text-engine/P9-REPORT.md`, second round |

## 14. Historical second round

This section preserves what was measured and intentionally left unchanged at
that time. P9c now also fixes browser review-only persistence and no-growth
longstrip drift; those current results are in section15.

The brief is `tp-data/briefs/p9b-old-chapters-fixes.md`: an outside review
(Codex, read only) of the first round found 11 defects and 5 mutations that
no test saw. Every figure here is **measured** unless marked inferred.

**How each was reproduced.** The tests of this round were written first and
run against the unfixed tree, a scratch copy of `9757ac50` under
`node_modules/.cache/p9/repro` (the merge, before any commit of mine in this
round). There: 25 of the 48 tests `first-fit.test.js` then had fail, 3 of 8
in `first-fit.engine.test.js`, 2 of 10 in `EngineNotice.dom.test.js`. For
the dry run a made-up data set was built in scratch (two made-up fonts, two
made-up chapters: a box with no id, a block 100 px from where its ink boxes
put it, a page marked `needsRespace`) and the unfixed tool run on it. I had
begun editing the store before reproducing; I stopped, built the scratch
copy of the unfixed tree, and reproduced each there.

All 11 findings are real. None is in default mode.

### The app

| # | reproduced on `9757ac50` | what was wrong | what the code does now | test | mutation |
|---|---|---|---|---|---|
| 1 | yes: a box's `x` and `w` changed with the chapter still "saved", then the flush: 0 saves. And the switch going off then put the file's height (26) back over the box the hand had widened (48 expected) | the gate and the restore trusted one flag, `app.saved`, which a handle that is still held has not lowered | "untouched" is a comparison: the pages and every box against what was noted plus what the engine itself wrote (`documentAsFitted`, `store.svelte.js:1519`; the note in two halves, `fitOwn` `:1301` and `fitRest` `:1305`; the page, `pageRest` `:1314`; the engine's writes recorded by `fitting`/`fitted` `:1409`, `:1413`). `flushSave` (`:2227`) and `endFirstFit` (`:1543`) ask the same test | `first-fit.test.js:378` (8 tests: handle, rotation, restore, a box added or removed, a page removed, a font landing under a held handle, a queue line, undone by hand); `first-fit.engine.test.js:332` (real file, `flushBeforeLeaving('quit')`); browser check, section 8 | R1, R3, R4, R5, R17, M13 |
| 2 | yes: a `pending` box solved after the note; the switch going off left the engine's `x`, `w`, size and solver record with the file's `y` and `h`; and the notice did not mention it | the note held `y`, `h`, flag and stamp only, for every box | a box stored as `pending` is noted whole (`noteBox`, `:1317`) and put back whole (`endFirstFit`, `:1548`); its solve is one of the engine's own writes (`solvePending`, `:1772`); the notice counts it as "laid out for the first time" (`firstFitChanges`, `:1489`; `EngineNotice.svelte:42`, `:80`). In an otherwise untouched chapter that solve schedules no write (`relayoutAll`, `:1720`) | `first-fit.test.js:511` (3 tests; one lays the box out late, when its font's bytes arrive); `EngineNotice.dom.test.js:242` | R8, R9, R10, R23, R24, R26 |
| 3 | yes: the switch going off between `loadProjectPages` and the loader's `markSaved` skipped the restore; the heights stayed | the loader holds `app.saved` false while it works; that was read as the user's edit | the loader's flag is its own (`loaderDirty`, raised at `:334`, lowered by `markUnsaved` `:2189` and `markSaved` `:2215`); the test passes over it (`:1521`) | `first-fit.test.js:624` (2 tests: restored; an edit made in that window is still an edit) | R6, R7 |
| 4 | yes: an edit's save while a box waited for its font wrote version 2 with that box unfitted; the box's later grow was never saved; the notice never came back | every save under the Rust engine stamped 2 | **chosen: the stamp stays the file's number until a save with nothing waiting, and Keep waits for the fonts.** `stampTypesetting` (`:1621`) writes 2 only when no box of the chapter is waiting (`anyBoxWaiting`, `:1594`); it remembers that the 2 is owed, and the font's arrival then causes the save that carries it (`stampDue`, `:1633`; `relayoutAll`, `:1720`). Keep marks the chapter unsaved at once and writes when the fonts have settled (`keepFirstFit`, `:1577`). The user's edit is not held: it is written at once, at the file's number | `first-fit.test.js:656` (5 tests); `first-fit.engine.test.js:347` (real file: the edit at version 1, then the grown box at version 2) | R11, R12, R13, R14, S2 |
| 6 | yes: a version 2 chapter saved while the engine was still starting was written as version 1 | two states: "Rust is not measuring" was read as "the browser fitted it" | three states (`stampTypesetting`, `:1625` to `:1628`): the Rust engine measures; no font source at all, which is the browser; a font source that is not measuring yet, which is nobody: the file's number is written | `first-fit.test.js:760` | R15, S1 |
| 10 | yes: "Fit now" on a box it cannot improve changed the reason; the flush wrote nothing; the switch going off undid it | as finding 1: the reason was written and nothing was marked | covered by the comparison, which includes `review` (`fitOwn`, `:1303`). "Fit now" itself is not changed | `first-fit.test.js:474` (3 tests) | R1, R2 |
| 11 | yes: in a chapter the engine changed nothing in, the user made a box taller and the notice appeared saying 1 box grew; a flag raised by an edit was counted too | the counts were against the opening note for ever | a box is counted only while it is still as the engine left it (`stillFitted`, `:1402`; `firstFitChanges`, `:1487`). A box an edit's fit has had is marked (`noteEdited`, `:1433`, from `autoFitBox` `:778`); a box changed without a fit is seen by the comparison. The engine does not take such a box back when it next fits it (`fitting`, `:1411`) | `first-fit.test.js:797` (4 tests); `:436`; browser check | R16, R17, M11 |

**Finding 1: which way, and why.** The second way: the comparison. The
store has no "gesture open" state to read. The handles live in
`TextBox.svelte`, which writes the box as the pointer moves and calls
`markUnsaved` on release; a state would need that file to tell the store,
and would cover gestures only. The comparison needs no line of
`TextBox.svelte`, and it also covers what nobody listed: "Fit now" (finding
10), a queue line, a box or a page added or removed without a mark. The
saved flag is kept as a necessary condition, since an edit outside the
pages (a tag, a setting) is seen only by it. The cost is one pass over the
document, as a save's snapshot takes, at a flush and when the switch goes
off; not timed.

What the comparison does when it is unsure: it writes. A gesture cancelled
back to the exact start compares equal and is untouched again; anything
else is the user's.

**Finding 10: historical browser behavior before the P9c repair.** On a box it
cannot improve it writes the new reason into the box and returns before
`markUnsaved` (`fitBoxNow`, `store.svelte.js:1134`, `:1136`). The chapter
still reads "saved" and no save is scheduled. Under the browser the flush
on leaving always writes, so the reason reaches the file then; a crash
before that loses it. This was left unchanged in the second round; P9c now
marks an actual review-only change dirty, including Make auto clearing review,
without inventing a geometry edit or history entry.

### The dry run

| # | reproduced | what was wrong | what the code does now | test | mutation |
|---|---|---|---|---|---|
| 5 | yes, on the made-up set: the box with no id had `rust: null` and was left out of every count | stored boxes were matched to the opened ones by id, and the load gives a box without one a new id | matched by where the box stands, as the loader carries it (`storedIds`, `dry-compare.mjs:22`); every open is checked to have the file's pages and boxes (`assertPartners`, `:46`, called from the lane at `text-port-dryrun.realfont.test.js:165`); a row with no partner stops the report (`dry-report.mjs:198`). Exit 1 | `dry-run.test.js:18` | D1, D2 |
| 7 | yes: the made-up chapter with a `needsRespace` page was reported as "x, width or size changed: 0" without a word | the stand-in open has no pictures, so it cannot make the loader's repair (`repairRespace`, `library.svelte.js:1848`) and did not say so; and it opened every chapter as pages | **bounded, not fixed.** A chapter with a page the loader repairs from its picture (`needsRespace`, or a page with no size: the loader's own two conditions) is not opened; the report says so at its head and the command exits 2 (`unrepairedPages`, `dry-compare.mjs:66`; lane `:256`; `dry-report.mjs:375`; `dry-run.mjs:68`). The project's layout is run both ways (lane `:319`), with G6 as a long strip a gate of its own (`dry-report.mjs:212`) | `dry-run.test.js:42`, `:138` | D3, D10, D11 |
| 8 | yes, in the helper: a layout that threw gave "nothing changed" | the lane caught the error and the comparison read no layout as no change | a box with text has a layout under each engine or the run fails and names it (`changeOf`, `dry-compare.mjs:99`; the lane collects `layFailures`, `:223`, and fails on any, `:450`) | `dry-run.test.js:52` | D4 |
| 9 | yes: the block 100 px from where its ink boxes put it got the rule 4 sentence; unexplained 0 | "moved and nothing else changed" fell through to rule 4 | the lane records the engine's ink box (`:204`; Safari's is in its capture); `changeOf` works out the shift the two ink boxes predict (`dry-compare.mjs:131`); the sentence is said only when the block is set in the middle, did not move sideways, and prediction and shift agree within 0.05 px (`inkMoved`, `dry-report.mjs:109`). Otherwise unexplained. The two other rule 4 sentences (a flag raised, a flag cleared) are now said only with Safari's own check of the same lines on record | `dry-run.test.js:59`, `:103` | D5 to D9 |

**Finding 7: how many such pages.** 0 of the 793 pages in the 13 copies:
none has `needsRespace`, none lacks a size. So no chapter was refused. A
picture whose real size differs from the stored one without that mark
cannot be seen from the copies, which have no pictures; the app's loader
does not repair such a page either.

**Finding 9: the 39 again.** 39 boxes have a block more than 0.5 px from
Safari's and no other change to the box.

- **19 are explained by the ink boxes** (rule 4), each with prediction and
  shift agreeing; the worst disagreement is 1.3e-13 px. 0.57 to 2.72 px.
  Fonts: DaftBrush 10, CCVictorySpeech Regular 3, Battle Cry Regular 2, Dan
  Panosian Regular 2, Fighting Words 1, CCMeanwhile Regular 1.
- **20 are in a font this Mac lacks** (D2b: Bangers, drawn in Helvetica
  Neue). That is a recorded fact about the box, not a prediction, and it
  is said first. For 17 of the 18 whose lines stayed the same the ink boxes
  of the two faces also predict the shift seen. For 1 they do not
  (`doratama__051.p9.bb141`: predicted 46.06, seen -2.37): that box is
  warped (a 3 by 3 mesh), and its recorded ink box is the warped one, which
  does not follow the block as plain ink does (inferred from the box's
  style; not pursued, since no rule 4 claim rests on it). For 2 the lines
  broke differently and no prediction is made.
- **Unexplained: 0.**

The largest five of each (px, positive is down; "ink top" and "ink bottom"
are how far the engine's ink edge is below WebKit's, against the line
boxes; predicted is minus half their sum):

| box | cause | ink top | ink bottom | predicted | seen |
|---|---|---|---|---|---|
| `deli-health__011.p1.bb5` | rule 4 | -2.2880 | -3.1540 | 2.7210 | 2.7210 |
| `deli-health__011.p12.bb116` | rule 4 | 0.4550 | 4.2331 | -2.3441 | -2.3441 |
| `deli-health__011.p4.bb44` | rule 4 | -2.2238 | -1.4800 | 1.8519 | 1.8519 |
| `deli-health__011.p4.bb45` | rule 4 | -2.2238 | -1.4800 | 1.8519 | 1.8519 |
| `deli-health__011.p12.bb115` | rule 4 | -2.2238 | -1.4800 | 1.8519 | 1.8519 |
| `tsukimichi__122.p28.bb383` | missing font; lines differ | none | none | none | -37.7303 |
| `tsukimichi__122.p26.bb354` | missing font; lines differ | none | none | none | -23.7603 |
| `doratama__051.p24.bb342` | missing font | 3.0294 | 9.7413 | -6.3853 | -6.3853 |
| `doratama__051.p13.bb357` | missing font | 2.3381 | 8.1925 | -5.2653 | -5.2653 |
| `doratama__051.p18.bb241` | missing font | 2.3381 | 7.2238 | -4.7809 | -4.7809 |

What this check is and is not. Each engine centres a middle-set block on
its own ink. The check confirms that the two blocks are centred about the
same line, so the whole shift is the difference between the two ink boxes
and nothing else moved the block. It would fail for a block moved by
anything else (the made-up 100 px case does). It does not say which ink box
is the true one; that is rule 4's own evidence, in the parity reports.

### The five mutations no test saw

Each now fails a test with a fixture that can see it (run on the final
sources; counts in section 7):

| | mutation | the fixture | test |
|---|---|---|---|
| S1 | "the Rust engine measures" replaced by "a font source exists" | a save taken with the switch on and the engine still starting: the gate source exists and measures nothing | `first-fit.test.js:767` |
| S2 | no save for a late fit that an edit caused | a version 2 chapter, an edit to a box whose font's bytes are held back, then released | `first-fit.test.js:742` |
| S3 | no `y` restore | a box set in the middle, which grows about its middle so its top moves | `first-fit.test.js:853` (and 3 more) |
| S4 | no stamp restore | a box with a solver record that the grown height moves the stamp of | `first-fit.test.js:866` |
| S5 | no font-readiness check on the old engine | a face the stand-in browser reports as not loaded; and the browser still loading | `first-fit.test.js:890`, `:899` |

### `keepFirstFit` when the write fails

Looked at as asked; the review had not.

- **On `9757ac50` (reproduced):** the notice was answered before the write
  was tried and `kept` was set when the snapshot was taken. With the disk
  full the notice was gone though nothing was kept; the user saw the toast
  and the save indicator's failure, and had no Keep to press again.
- **Now:** the rejection brings the notice back (`keepFirstFit`,
  `store.svelte.js:1586`); `kept` and the version in memory are taken only
  when a write lands (`stampLanded`, `:1635`, from `markSaved`), and a
  failed save drops its stamp (`saveFailed`, `:2183`). The user sees: the
  notice, with Keep; a toast "Could not save: " and the reason
  (`EngineNotice.svelte:65`); the save indicator in its failed state
  (`app.saveFailed`); the chapter unsaved, so leaving tries again and says
  why if it fails again. A second press with a disk that takes it writes
  once, at version 2.
- **Tests:** `first-fit.test.js:908` (2 tests); `EngineNotice.dom.test.js:214`;
  `first-fit.engine.test.js:371`, on a real file with the chapter's folder
  removed. Mutations R19, R20, R21, R25.

### Found by the dry run: a long strip's top edges

The second layout (finding 7) failed its own gate the first time it ran:
649 boxes had a top edge that moved without the height growing.

- **Cause (reproduced on `9757ac50`, under both engines).** In a long strip
  the grow-only pass works in the strip's coordinates, and wrote the top
  edge back as `(y + top) - top`, which is not always `y` in the last bit
  (214.97986469072157 for …166). No box moved by more than 1e-11 px, but
  the document changed, and with the comparison of finding 1 every such
  chapter would have read as edited.
- **Fix, behind the switch only.** With a font source set, a box the pass
  does not grow is left alone, compared in the strip's own coordinates
  (`growHeightTo`, `store.svelte.js:1071`). Test `first-fit.test.js:960`
  (2 tests; the second pins that the browser's pass is unchanged). Mutation
  R22.
- **Historical default-mode omission, now fixed in P9c.** Under the browser the pass still rewrites
  such a top edge in its last bit and counts the box as moved, so in a long
  strip a font that lands after the open can schedule a save that changes
  nothing visible. It did so before this phase. The rule is that default
  mode was then untouched. P9c now applies the same exact no-growth guard to
  both engines, preserving the original top edge without a tolerance.
- **What is left in the report.** 8 boxes come out differently as a long
  strip: each grew, and its top is where the strip lets it be (above the
  page's top or below its foot by 2 to 16 px) where the page holds it at
  its own edge; no height and no flag differs. 253 more differ by under
  0.000001 px: boxes that grew, their tops worked out in the strip's
  coordinates. G6 as a long strip: 0.

### The dry run again

Run twice into `tp-data/reports/p9` (`check/` kept) and a scratch folder,
with `--legacy-mode smart`, on `3f368143`, wasm `1aba362c…`:

- **Byte-identical:** `diff -rq` empty; 917 files each; sha256 of the
  sorted list of every file's sha256 `085128cf…d860a3dc` both times. Exit 0.
- **Against the first round:** no total of the first round moved. 2,487
  boxes, 2,302 with text, 2,292 compared, x/width/size 0, shrank 0, top
  alone 0, grew 361, newly flagged 75, no longer flagged 4, lines 7, moved
  56 (25 over 2 px), missing font 35, borrowing 30, changed 442,
  unexplained 0, back under the browser 3/11/8: all as before, on a
  different wasm.
- **New totals:** moved with nothing else changed 39, of which by the ink
  boxes 19; differs as a long strip 8, by the strip's arithmetic 253; G6 as
  a long strip 0; ids repaired 0; chapters refused 0; "laid out for the
  first time" 0 in all 13 notices.
- **Files:** 911 of the 917 have the first round's bytes: all 880 pictures,
  all 30 sheets and their index. The 6 that changed are text
  (`report.html`, `report.md`, `totals.json`, `boxes.jsonl`, and the lane's
  two files under `raw/`): the new sections, the ink figures, the new
  wasm's digest.
- **Sheets looked at again:** none changed, so none.

### What I did not do in this round

- I did not run the desktop app.
- I did not time the comparison.
- At this historical checkpoint I did not change "Fit now" or default-mode
  longstrip behavior; the current P9c repair intentionally does both.
- The dry run's refusal (finding 7) was run on a made-up chapter only: no
  real copy has such a page.
- The first-round figure "a second run gave 201, 122 and 249 ms" is not
  repeated; section 8 has this round's one run.


## 15. Third round (P9c)

The current candidate fixes browser and related save defects as well as Rust
persistence. It accepts no ordinary successful leave/open with missing required
intent. The worker's strict6000 run completed all6000 invariant orders, all197113
events, zero unfinished prefixes and zero unresolved cases. The coordinator
must repeat the final pinned tests/captures and obtain independent whole-P9
review before merge. No P10, main merge or push is part of this round.

The chronological records below preserve prior failures, diagnostic categories
and then-unexecuted submissions. They describe their pinned historical trees,
not present acceptance policy. The current implementation and measured repair
proofs are under **Current persistence repair and strict model** below; old
browser loss categories are now diagnostic evidence only.

### Historical starting work and invariant

The two paused files were preserved byte for byte before editing (measured:
SHA256 store `a60516e5a61fb6106a68a4a1ef644c1ba2f3d418b0990fe984c488d64623100d`,
model `fe55b4285a28c3f8ee4547a3b4c1cff56cab5738a3c7a402d3224c9332981d57`).
Their exact starting diff is private in tp-data/reports/resume-20261009.
No reset, stash or revert was used. This round continues that implementation.

`disk` is the last snapshot known to have landed, including the version and
chapter mode. `docText` serializes the durable current document.
`versionNow` derives the number from the current measuring engine and all
waiting boxes. `landed`, font/engine arrival and Keep use `settleDisk` to
ask whether the file is behind. A finishing write is not itself proof that
the newer document is saved. The note comparison sees page position and
mode/settings as well as every durable box/page field. Notes for version2
preserve its engine-only grow policy while keeping its notice off.

The review of `dffafec94d4728244dc381082e4e2375d6079bba` contradicted this
round's earlier switch-off claim: reset erased the pending stamp and restart
treated newer memory as the opened file. The reviewer measured disk height48
against memory70, saved=true, and no quit write; it also measured an older
browser translations snapshot incorrectly adopted by Rust. The source now
records browser snapshots too, retains the last actual disk snapshot across
engine turns, and settles debt Rust acquired after switch-off. A chapter
change clears that ledger, while a simple engine change does not. Settings changes the same
chapter’s breaker without clearing the pending snapshot or document identity;
a held-write mode-switch probe checks the independent chosen mode and both files.
**This was the then-unexecuted submission; current repair proofs are below.**

The static review of `10abda3b8357c6e2b623139580b110a6f46ae863`
found four more gaps. Its findings and pin are preserved. The new source
requests settlement at final leave, quit and real chapter switch. After
each final saver finishes, it checks the outgoing identity and actual
Rust-owned document/version against the landed snapshot. It writes an
already-discovered difference immediately, rather than returning ahead
of its800ms timer. It does not wait for an absent font to arrive. The
library's existing exit timeout, refusal and failure escape are retained.

Incoming workflow mode is now installed before the loader records first-fit
state. Named untouched typeset-to-translate and translate-to-typeset real
opens check both original file bytes, no autosave, and switch-off restoration.
For changed wrapping, direct metrics can predict the vertical move, but
horizontal line correspondence remains unknown. The report now leaves that
placement unexplained instead of giving it a wrap or missing-font cause.
A changed-line-count fixture adds100px horizontally while preserving the
independent vertical prediction. These are source changes, with new proofs
still pending.

The coordinator's first focused run on `6b6dc77` stalled before any named
result. It started at load5.60. The coordinator observed about99% CPU in
its model worker and terminated only the owned processes after129.95s;
exit143 and the full startup log are preserved. This is an interrupted
draft run, not an assertion proof or acceptance. Its concurrent static
review was cancelled before further edits, with exit143 confirmed. It did
not produce a completed review and is not a review pass.

Static diagnosis found final flushes could continually enqueue each other:
library's latest-call guard suppressed not only the indicator but the actual
landed snapshot, so each final loop still saw the old ledger. Keep versus
final flush had the same risk. The new receipt seam separates these facts.
Each completed Rust-owned/acquired snapshot carries its own private receipt
through both physical writes. Its actual ledger is updated even when another
save is queued. Only the latest call still clears the indicator and timer.
At that historical submission pure unowned browser saves kept the old policy;
the current repair below intentionally replaces that omission. The receipt is in a WeakMap;
it adds no persisted field and validates the outgoing document turn.
Two new probes hold the second final/Keep write while checking the first
actual version2 bytes and completion. An omitted notification must fail
those assertions before the second write is released. Cleanup now clears
the outgoing identity before draining, strictly after assertions, so an
old-source failure cannot livelock during cleanup. New execution remains
pending.

The three original bad orders are retained as named real-store/real-saver
model sequences. The old unpatched store's seeds20261102,20261268 and
20261024, and84 failures in1500 sequences, are **historical measured evidence
from the paused worker**, not new measurements by this worker.

The model now reads both chapter.json and translations.json and checks
chapter mode and typesetting mode. Literal version1/version2 fixtures replace
fixtures previously made by running the same implementation. Three distinct
chapter directories each have two pages; opens use the real library transition
while old chapter/translation writes can remain held. It has page-order
and unmarked-handle/mode/style/fit/filename events, an empty chapter event,
and held/failing translation writes. Named boundary probes change each durable field after
an old snapshot, let that snapshot finish, and require the next debounce's
actual bytes without a rescue flush. An untouched version1 must retain both
original byte strings and have zero chapter writes. Version2's existing
leave-save is permitted. A deadline test checks the disk while the font is
still held, before allowing its eventual fit. Named model sequences also
check every previously surviving style/fit/filename/chapter omission and
page order; the offscreen-font check observes the attempted number before
the write lands. A known-geometry deadline boundary requires Keep to write
even when the document bytes and old number have not moved.

The reviewer removed restoration's ownership guard and found that the old
model accepted loss of a user's height33 back to26. Expected user text,
translation, minimum chosen height, style, fit, filenames, order and modes are
now retained independently before automatic operations. They are checked in
memory immediately after the operation, then against both physical files
before cleanup. The diagnostic records both serialized byte strings. Switch-on
does not release writes, drain or flush; at-rest assertion has no final browser
rescue flush. Explicit held Rust off/off-on and held browser-to-Rust cases
observe both files after only the natural debounce and before leaving. A real
second-chapter probe checks that each path retains its own choices.

At this historical checkpoint the Rust invariant included chapters that crossed
back to the browser, while pure never-Rust autosave loss was deferred. The
current model instead checks BOTH files for every completed browser order. Actual leave/open
boundaries still check both files under either engine. Generated unmarked
actions finish with the same real `relayoutAll` boundary as the original
unmarkedHandle action. The ten raw post-snapshot probes still call their
mutations directly, with no relayout or rescue flush.

### Keep and the notice

Keep owns one bounded wait, at most4000ms. The press does not arm the ordinary
800ms edit debounce. The waiting state is visible in EngineNotice, including
what happens at the deadline and after a later font arrives. After failure,
the notice offers Keep again and the save indicator/toast state remains.
Waiting and failure keep it visible even when user edits remove every count;
the DOM probe reaches that state through the real store's ownership tracking.
The timeout writes even if known geometry is unchanged. Multiple arrivals
while one Keep write is in flight are coalesced; a newer snapshot is written
when that write finishes. A close clears the chapter's wait and promise.

The five previously failing tests were not weakened: three exact return
objects now include keeping:false; the held handle is truthfully unsaved
when settlement sees its disk difference; Keep remains saved/visible while
otherwise untouched and waiting, with no write before it finishes. New
fixtures cover non-rotation style, balloon fit, both durable filenames,
page order, an offscreen held font, a never-arriving font/deadline/later fit,
and a stale Keep from a closed chapter.

### Independent rule3/rule4 prediction

The old positioned-ink-minus-blockY calculation is removed. The lane calls
fontBox and lineInk directly for each face and exact line. A system-WebKit
capture reads only existing local font/chapter COPIES and records exact text,
size, spacing, bold/slant, CSS, local font face SHA256s, raw font/ink metrics,
and source file hashes. It uses a nonpersistent local WKWebView with private
HTML; no server, collector, font installation or download is needed.

Canvas lineInk in browser.js does not apply letterSpacing; measure.js adds
horizontal spacing only. This check predicts vertical centring, so the
raw vertical font/ink measurements follow that same contract. Blank lines
are skipped as blockInk skips them. Every named family must have loaded
local FontFace records; missing-family fallback is refused. Individual
missing-glyph fallback can still occur in WebKit; missing/borrowing boxes
are excluded from rule3/rule4 attribution.

The middle-alignment formula decomposes the shift into a font-box baseline
(rule3) and glyph ink relative to that baseline (rule4). A checked sum names
both rules. Neither operand reads the actual placement or positioned ink.
Missing/stale independent metrics do not receive an ink explanation. The
fault probe changes only ascent by200px: the resulting -100px shift is
rule3. A100px unrelated placement fault remains unexplained.

Before a real dry run, on a new private output path:

```
node scripts/text-port/dry-metrics.mjs --data <tp-data> --out <tp-data>/reports/p9-direct-metrics.json
node scripts/text-port/dry-run.mjs --data <tp-data> --out <report-dir> --legacy-mode smart
```

The second command defaults to that metric artifact. A repeat/reference copy
can be selected with `--webkit-metrics <private-json>`. The validated raw
artifact is copied into the report's raw/direct-webkit.json, so report-only
uses the same measurements. Source hashes are checked again.

**Pending measurement:** the real moved-only39 boxes must be recounted
against this independent prediction. No old19/20 split is claimed as proof
of this repair.

### Failed lanes cannot become reports

The lane begins with an incomplete verdict. Its final raw/run.json records
completed/pass status and all layout/paint failures. writeReport requires a
completed passing verdict and independently rejects its failure lists,
including chapter paint metadata. The same check runs for report-only.
Synthetic failed layout/paint metadata is tested through the actual CLI:
exit1 and no new signable HTML/Markdown. A mutation removing that guard must
reach a fully supplied synthetic report fixture, not fail because inputs
are missing.

The reviewer supplied a passing verdict declaring one box with zero raw
records and obtained a zero-box report. Each non-refused chapter now declares
its stored box IDs. The reporter checks the exact chapter/ID denominator,
duplicates, missing/foreign/extra rows and complete finite Rust/strip geometry
before writing any HTML. A missing-font or changed-wrap attribution also
requires an independent numerical placement prediction; metadata cannot hide
an unrelated100px move. The final real39-box division remains pending.

### Historical default-mode defect (now repaired)

`library.svelte.js` calls markSaved at the end of writeOpenChapter only when
no newer save CALL has incremented saveSeq. A user edit during the old
write can arm an800ms timer without yet making such a call. If the old write
lands before that timer, its markSaved clears the timer and says saved;
the newer edit was absent from that snapshot. The code was first read only;
later generated synthetic orders measured this defect while a final leave
or open snapshot was held. No user chapter was modified. It is an old
browser defect whose source repair is now described below. Rust-owned
cross-switch cases remain strict and cannot inherit that exemption.

### Proof record

Measured first focused run:115/117 tests passed; first-fit and DOM files
passed. The model's new held-translation gate was not released by its leave
helper, so a leave-created translation write remained held; this was a
harness defect. Its initial gate-draining workaround is superseded by real
non-draining transitions and explicitly scheduled write events in this model.
The other failure was a strict -0/+0 match in the rule3 decomposition;
zero is now normalized without changing the independent expectation.
Neither failure was classified as a timing flake.

The affected-file focused repeat passed105/105 tests (61 first-fit,
16 model with20 sequences,28 dry-run). The first6000-sequence run found90
failing seeds: all shrank to an empty chapter Keep after a previous chapter's
font request was still held. The harness had treated every old request as
waiting for the current chapter. Its waiting oracle now checks engine turn
and the families actually used by the current chapter. The random empty
chapter/Keep cases were retained, and a named boundary still holds the old
request while proving the new empty Keep completes at version2.

The corrected run passed17/17 tests and6000 sequences (measured,22.12s):
32542 attempted chapter writes,524 intentionally failed writes,3396 Keeps,
2076 as-opened checks,12700 current-document checks,9823 leaves. Intentional
write failures are not sequence failures. Seven additional mutation-sensitive
sequences, four generated unmarked-field events, an attempted-number oracle,
and the known-geometry deadline boundary were added after that run loaded its
source. **A final-source model repeat is still required.** The earlier
successful seed probe with a temporary visible-only Keep guard is superseded;
the retained empty-Keep eligibility passed its own seed repeat and the6000 run.

The coordinator independently ran the later `dffafec` source:87 focused tests
passed, but the6000-sequence generated invariant failed with223 seeds while24
named probes passed. Of those223,175 incorrectly counted held fonts after the
switch was off;48 ended with a new unmarked event whose settlement boundary
or public applicability was not modeled correctly. The off-phase waiting
oracle is corrected. All6000 seeds, event choices
and the223 original failures/shrunk orders are retained; no raw held-snapshot
probe was given a rescue flush. The private preserved log and extracted
p9c-dffafec-223-failures.json are the prior failing record. The review's actual
cross-switch save losses are separate source defects and receive direct tests.

At `10abda3`, the coordinator's focused20-sequence run failed23 of152
tests, with129 passed. Its gated repeat at load5.38 reproduced the same23
failures. The first ungated run is preserved as a failed draft check, not
acceptance. Nineteen failures included an invented translation expectation:
the model edited `tr`, while the actual Queue and serializer use `en`.
Some failures then arose in assertion-bearing cleanup and contaminated later
tests. Two failures reached a plain-wrap DOM fallback the fake engines did
not provide. One expected literal fixture omitted normal serialized
`fit:null` and style keys. The remaining Keep-null failure may be a cleanup
cascade; that explanation is not yet established by a repeat. No failure
has been declared a flake or silently removed.

The model now retains the `en` choice before calling the real Queue action.
Its literal fixtures include schema defaults; their geometry is still
literal, never generated by the current fit/save path. Fake engines provide
deterministic plain wrapping; they make no browser CSS parity claim.
Non-asserting cleanup runs only after a probe has made its assertions, so
it cannot repair a lost-save result into a pass.

The browser generated actions now use their actual public completion:
`setLineText` for Queue text, `boxEdited` for Inspector changes, and the
TextBox resize completion's `markUnsaved`. Open-editor raw picture/order
events still run while Rust has actual cross-switch debt. Once both current
physical files have landed, those open-editor events are inapplicable:
the public library page/art rewrite APIs require `assertClosed`. The model
does not claim generic raw browser mutation robustness. An `app.saved` flag
alone cannot retire debt: current chapter and translation bytes, identity,
and no held writer are required (or the allowed untouched opened bytes).
The ten raw snapshot probes still call their mutations directly, with no
relayout, completion mark or rescue flush. The new generated-stage counts
separate Rust/startup, cross-switch debt, post-debt browser and closed
events, and list each inapplicable public action. These counts include only
the original generated orders, not named probes or shrink replays. Thus the
retained6000 seeds do not imply the old harness's exact coverage semantics.

The coordinator captured7243 direct WebKit metric records on `dffafec`, with
complete=true and no errors, in private p9c-direct-root-dffafec.json. Final
candidate repeats and the canonical local reference installation are pending.

The worker focused run on `d64dc9106fb35b910f469223b1f9227e6fb737be`
finished in14.462s at load5.53:163 of164 tests passed. All named receipt,
final boundary, workflow and raw snapshot probes passed. Only the generated
20-order assertion failed, with three seeds. The coordinator independently
repeated the same163/164 result at load4.99 in14.46s. Both logs and JSON
records are preserved; the source stayed clean and unchanged.

Seed20261024 shrank to `switchOn,open1,editLate,open1`. Its already saved
historical choice made the next open falsely count as a current-cycle edit.
The test oracle now starts every successful real open untouched while
retaining and checking every historical independent choice in both files.
Seeds20261019 and20261026 shrank to `open2,holdWrites,leave,unmarkedMode`
and `open1,holdTranslations,openEmpty,edit`. They exposed the existing pure
browser final-write cancellation. No production browser fix had been made at
that historical checkpoint; the current repair preserves those choices.

The historical model then distinguished one precisely measured deferred
counterexample. This acceptance dispatch has now been removed.
A final-transition window must have begun under the browser with no Rust debt;
it must capture the actual held chapter and translations snapshot. The user
choice must occur while that exact gate is held. A pass-through fake-timer
observer records the800ms markUnsaved timer and that exact ID's cancellation
by markSaved before its deadline, with both old snapshot files already on
disk and the same outgoing identity. Actual physical files must still equal
that snapshot. No Rust ownership or acquisition may occur within the window.
All earlier and unrelated choices remain mandatory. Unknown cases still fail.

A fully proven browser witness stops its original order, just as a
counterexample does. Its full order, executed prefix and unexecuted tail are
retained. The historical wish is not deleted or quarantined, and a later
Rust stage is not granted an exemption for inherited loss. All6000 original
orders are attempted; final proof must report completed invariant orders,
exact browser witness prefixes and unknown failures separately. Deferred
tails make no safety claim. Event totals and ownership stages count only
executed original prefixes. Witness shrink replays do not inflate these
counts. Named known witnesses, a successful historical-choice reopen, and
Rust acquisition during the same held window make this distinction falsifiable.
These oracle changes have not yet run.

Full witnesses are saved only when an explicit fresh private
`MODEL_WITNESS_OUT` path is supplied. The console stays compact; no default
filesystem writes or serialized witness dump is added to CI.

The verified P7/P8 integration was merged into P9 as
`d629769473845f4ae043bbdd908fb28a5cb9a6d3`. A static carry audit found all38
non-store carry files identical to integration0272 and all eight P9-only
source/test/report files unchanged. The store differs only by P8's five-line
fontSourceNow getter; P9's first-fit and actual receipt logic remains intact.
This is a source comparison, not a new behavioral proof.

The coordinator's combined focused20 run on d629 started at load4.05 and
finished in15.88s with unchanged source:167 of168 tests passed. Every named
probe passed. The20 original generated orders classified17 completed,
two exact browser witnesses (seeds20261019/26), and one unknown failure
(seed20261024). Its original661 requested events executed641, with20
unexecuted tail events; shrink replays are separate. The full output and
both-file witness records are preserved in private p9c-root-d629769 artifacts.

The remaining seed shrank to
`switchOn,open1,holdWrites,editLate,open1,unmarked_cleaned`. At rest the
source ordering shows the physical filename check had returned before
the live choice oracle falsely
read page.cleaned's runtime blob URL before page.cleanedFile's durable
filename. Library loading and saving explicitly use those distinct fields.
The narrow test-only correction normalizes live pages through documentNow;
physical serialized records still read their cleaned filename directly.
A named control saves a chosen filename while a runtime blob URL exists,
then separately proves wrong live and wrong physical filenames still fail.
This correction and control are unrun. The failing seed and raw earlier
evidence remain; no production change, event removal or choice exemption
was made.

The model's completed-order claim is scoped: active documents under Rust
or independently outstanding Rust save debt check both physical files at
rest. After actual debt retirement, active ordinary browser disk state is
outside that at-rest invariant; live independent intent still checks, as do
actual leave/open boundaries and inactive chapter files. A completed order
does not prove all active browser autosave states. The exact final-window
browser witnesses and their unexecuted tails remain separately reported.

Syntax checks and parsing of the generated metric page passed (measured).
The private p9c-mutations.py runner requires a full candidate commit SHA and
clean worktree, archives that commit's tracked files, and makes scratch-only
mutations. Each control/mutant checks load below8 at its own start. Private
Vite/dot caches avoid another worktree's transforms. JSON records archive
hash, exact source changes, command/environment, failed test names/messages,
and separate killed/survived/invalid/error/timeout classes. The original16
catalog, ten first-review fixes, four second-review fixes and two receipt
fixes are separately labeled and selectable with --group original, --group review,
--group review2 or --group review3.
The original runner SHA256 `a11ccaca8d44084efc2c0df0461d13f83f0542c68ba7734866639ce3d8c69ef0`
and first-review runner `b13ea5797f7f513bf851f96aec51784e2f6f5ad1b0411657a1ba2ba620967330`
are preserved byte for byte. The new mutations remove final-exit settlement,
final-switch settlement, the incoming workflow baseline, or the unknown
horizontal placement refusal. The second-review runner
`844d5416889abd9a737562fe7392851c8d51c88f26c17a09404ce4e039068bdf`
is also preserved. The separate convergence mutation removes actual landed
notification while retaining the latest queued-call indicator guard. A second
receipt mutation announces landing after chapter.json alone; the failed
translation-file probe requires version1 in memory until both files land.
A positive control
must actually select and pass tests before its mutant runs. Source hashes
are compared at the end. **All four mutation groups, final-source model repeat,
full suites, engine/native tests, browser check, direct metric capture, both
captures, repeated real dry run and final Codex review remain pending.**
They will be scheduled below load8 and recorded here before acceptance. The
existing reports/p9/check directory has not been touched.

The receipt runner `a7744b072af11b1b452de5f1b6a3213b40e0612f5242bd5bc2488488d27715c1`
is preserved before classifier changes. The new classifier requires every
failed named case to contain only an AssertionError, no suite/runtime/timeout
errors, and exactly the selected control name set. Mixed TypeErrors or
unknown Error/rejection failures cannot be called kills. Seven pure parser
examples passed (measured; no mutation execution). A RESET_LEDGER mutation
may now be redundant because the private actual receipt survives clearing
the global stamp; a survivor must be recorded honestly, then investigated.

The narrow cleaned-name correction at e377944 was independently measured by
root: focused20 passed169 tests, with18 completed original orders and two
exact browser-witness prefixes, zero unknown orders in that20-order sample.
Its661 requested generated events executed641 and left20 unexecuted tail
events. Only the generated category/event-stage counters describe original
orders; legacy writes/keeps/asOpened/asDocument/browserDeferred totals also
include named and shrink replays. A witness shrink preserves its class, not
necessarily the original lost key or chapter identity. Attribution uses each
preserved original fullOrder/windows/witness, not its minimized order.

The e377944 full6000 attempt reached root's650-second deadline without a
model result and is a timeout, not a pass. Root confirmed its owned processes
gone after TERM; a redundant KILL cleanup exception prevented the original
metadata write, with the raw log/trace/sample and a separate incident record
preserved. The separate test-only diagnostic archive subsequently timed out
at180 seconds (wrapper124, child143, acceptance false) with source unchanged.
It reached original seed20262477: four pending transitions and a held outgoing
writer after browser handoff. Before that stall its partial transformed output
also recorded31 unknown original orders. These are unresolved; neither a
diagnostic prefix nor the focused20 proves all6000 orders.

The bounded settlement repair now keeps an actual outgoing ref/document-turn
ticket alive until each Rust-owned final call finishes. Acquiring Rust during
an already active final window acquires that same ticket. A matching browser
receipt cannot retire ownership while another current owned final still needs
receipts, and closing/opening another identity prevents an old ticket from
settling or stamping that new chapter. Pure browser final calls remain unowned;
the measured default browser autosave cancellation defect is not repaired.
A bounded overlapping-final regression asserts no further held writer and all
three completed final calls before cleanup. The original33-event seed20262477
is retained separately. Old-source reproduction must select only the bounded
named assertion; a hot loop/timeout never counts as a mutation kill.

The final combined Codex review of e377944 completed with two tool findings.
The dry lane now derives required layoutIds and curveIds from untouched stored
text/translation before any open or engine layout. Report-only validation
requires a complete finite straight/curve layout for those IDs, an explicit
null for a true no-text box, and coherent direct metrics or explicit unknown
metrics. Missing/null/empty layouts cannot silently remove a placement
comparison. The browser checker retains its21 named checks and separately
records a fatal global page-error verdict/count/details before writing its
result; collected Runtime exceptions cannot print all passed or exit0.

The separately labeled review4 catalog removes only active-final retirement
protection, required-layout validation, or the global page-error predicate.
The32 original definitions and their sealed runner remain unchanged. These
current repairs were checked once by the granted worker focused20 at09db11a:
start load3.03,13.77-second Vitest run,197 passing and one failing test, no
timeout, owned cleanup verified empty and source unchanged. The sole failure
was the new bounded overlapping-final fixture expecting a third held writer
after the actual queue had completed following two. All other named cases,
the preserved33-event seed and the generated20-order classification passed
(18 completed, two precise browser prefixes, zero unknown,641/661 events).
That raw failed run is preserved. An initial unrun fixture correction pinned
the measured two post-edit snapshots at2b42ed4. Root then required a stronger
contract: the final probe now releases at most eight held writers, stopping
when none remains, and asserts the queue empty, all three final calls complete,
and both physical independent choices current. Hold remains true throughout;
identity cleanup happens after assertions. Queue coalescing/count is not the
contract. This bounded fixture correction is unrun. All final-source model, mutation,
real dry-run, browser, capture and final review proofs remain pending.

The coordinator subsequently measured the original bounded final fixture
on current cc253fd, on its retirement-guard mutation, and on old e377 with
only that current test overlaid. All three passed. The guard mutation is a
measured survivor; the fixture did not prove the ticket repair. Its late edit
came after two of three final callers had finished, allowing the sole remaining
caller's ordinary latest-save callback to converge even on the old source.
The original catalog and those raw results remain unchanged.

A separate stronger regression now uses three public flushBeforeLeaving
callers. Only A lands before the independent later Queue choice, while B is
held and C is queued. After C's actual current chapter and translations files
land, C must finish while B's already queued follow-up remains held. Subsequent
held writers are released at most eight times; all three callers must finish
with both files current before identity cleanup. Root measured this stronger
regression at4d1069: fixed1PASS and four support controls PASS; old e377 with
only the current model test overlaid and the retirement-guard removal each
failed cleanly at the same early assertion, “C must finish from its actual
both-file receipt while B still waits.” No runtime error, timeout, cleanup
error or source drift occurred. Raw evidence is preserved separately in
p9c-root-public-final-4d1069-001/results.json; the original survivor remains.


### Historical request identity and model evidence candidate

Root replayed five previously unknown ORIGINAL orders on frozen cc253fd:
20261029,20261037,20261867,20261290,20262371. All failed by clean assertions,
with no timeout/runtime/cleanup error or source drift. Separate copied,
observational diagnostics retained original and shrink records independently.
The originals are never inferred from their minimized orders.

Original20262371 established a real queued-save destination defect: the
incoming untouched chapter1 was adopted with its actual version1/opened files
and no incoming choices after all34 events; only during rest did two queued
outgoing requests write that incoming chapter atversion2, without a user Keep.
The library queued only a sequence number, then read app.chapterRef when the
queued writer finally ran. It now captures the object ref at request time and
returns before any read or stamp if execution sees a different ref. This also
rejects stale browser cross-ref requests and same-ID fresh-ref requests; valid
same-ref browser queues and their acquisition by Rust remain valid. This is a
universal request identity guard, not a Rust-only guard. It leaves the ordinary
same-ref browser cancellation/indicator policy intact. Public held-write
controls cover browser/Rust, distinct incoming chapters, same-ID fresh refs,
valid same-ref saves and browser queues acquired by Rust. The original34-event
order is retained as a separate regression.

Original20261029 positively observed both old physical files and cancellation
of the actual800ms late-choice timer atdelta0, with no Rust acquisition. The
model now checks every outgoing open window, including same-ID reopen, before
adoption. If no exact witness qualifies, all historical outgoing choices are
still mandatory. Original20261037 instead had both actual files matching the
current saved browser document at rest; the old model baseline still called
that previous browser edit a current Rust touch. A pre-acquisition baseline is
now allowed only under the actual browser/off engine with independently equal
current chapter/translation bytes, correct identity/version/durable filenames,
all historical choices present, no unsaved/failure state and no pending public
operation, saver, owned final, physical writer, relevant timer or Keep. The
receipt is recorded before Rust starts; historical choices are never cleared.

The model observes real public saver invocations and the ORIGINAL returned
promises using pass-through registration/public API wrappers. Public leave
calls run in test-only AsyncLocalStorage solely to attribute their actual
refusal/force toast emissions and saver calls to the request. Calls, arguments,
returned promise identities, event weights, fake clock advances, drain rounds,
generated orders and cleanup policy remain unchanged. Internal open hooks
without that public leave context cannot acquire a forced-exit/stale-final
classification. Actual snapshot/translation attribution follows the serial
pending saver invocation and its captured ref, including old-ref translations
that finish after adoption. A final snapshot qualifies only for a sole clean
public final request without an earlier queued saver. Ambiguous attribution
remains UNKNOWN. Monotonic observation orders distinguish tied fake timestamps.

Two distinct measured leave cases have narrow candidate classifiers, not a
browser file-check waiver. Original20261867 retired prior Rust debt only after
both exact files were current and all public/save work had settled; its later
ordinary browser final returned old both-file bytes after a late-choice timer
FIRED and a newer actual browser chapter writer was held. Its stale-final
witness requires that actual public leave answer/current ref, the prior actual
retirement, exact old both-file receipt, fired uncancelled timer, independent
late choice in the actual newer queued chapter fields, and no Rust debt,
acquisition or owned pending final. Newer translations remain explicitly
unobserved, not synthesized from the chapter snapshot. Negative controls cover
Rust acquisition, outstanding owned finals, wrong prior ref, one-file-only
retirement and an earlier ambiguous saver. Original20261290 had two injected
failed writes and overlapping public leaves; its forced-exit candidate requires
two actual failed-writer/saver identities attributed to the public refusal and
forced reply, a fresh request-associated exact force toast, unchanged ref and
no intervening actual both-file success or successful public final reply.
Intent and Rust debt remain retained; forced exit never counts as durable
success, retirement or completed invariant order.

After the existing fourteen drain rounds, completion now requires positive
absence of pending public operations/savers/finals, physical writers, relevant
save/Keep timers, font/start gates and a pending Keep. No new drain or rescue
flush is introduced. Explicit private MODEL_WITNESS_OUT now preserves each
UNKNOWN original reason, full order/prefix/tail, stages, canonical live and
physical documents, independent choices/debt and pending observations BEFORE
cleanup; shrink reason/order/proof is saved separately. Completed invariant
orders, exact cancellation prefixes, stale-final prefixes, forced-exit prefixes
and UNKNOWN orders have separate counts. Shrinks preserve the classification.
All6000 seeds/events/weights and the ten raw robustness probes are retained.

Root executed the frozen b1b6643 candidate before the timer correction below.
The focused20-order/four-file run returned219PASS/2FAIL, with no startup/runtime,
timeout, cleanup or source drift. The generated test retained UNKNOWN originals
20261011 and20261026; the existing Inspector retirement assertion also failed.
All new named identity/witness/baseline controls started and passed. Replaying
all31 previously UNKNOWN originals returned2 completed orders,5 exact
cancellation prefixes,1 stale-final prefix,1 forced-exit prefix and22 UNKNOWN
orders, with each original proof preserved separately. This is not acceptance.
Evidence: p9c-root-b1b6643-focused20-001 and
p9c-root-b1b6643-31-originals-001/results.json.

The queued-request identity sensitivity proof passed on b1b6643: all4 public
stale-ref controls and2 same-ref positive controls passed. Exact old4d1069 source
with ONLY the current model-test blob, and the requested-ref guard-removal
mutant, each failed all4 stale-ref controls by the same clean early physical
write-attempt assertion before cleanup. No runtime, timeout, cleanup error or
source drift occurred. Evidence: p9c-root-queue-identity-b1b664-001/results.json.

### Narrow history timer ownership correction (root focused proof)

Root ran a separately sealed, observational copy of exact b1b6643 for the
Inspector and original seeds20261011,20261037,20261601,20262087,20261094,20262168.
All seven diagnostic executions finished without timeout/runtime/cleanup errors
or feature drift; diagnostics are not acceptance. The Inspector had current
matching chapter/translations and retained choices, saved=true, and no pending
saver/public/final/writer/Keep; its only settlement blocker was an800ms timer
whose immediate setter was schedule in editor/history-file.svelte.js. Originals
20261037,20261601 and20262087 likewise had a saved current browser baseline
blocked by that history timer. The document's own timer had already completed.
Each original observation is retained before cleanup; minimized orders are
separate evidence in p9c-root-b1-retirement-{inspector,seed20261037,
seed20261601,seed20262087,seed20261011,seed20261094,seed20262168}-001.

The model now records the immediate setter stack for every actual timer and
excludes a DOC_SAVE_MS timer only when that observed caller is exactly schedule
in src/lib/editor/history-file.svelte.js. Document markUnsaved, Keep, missing
origin and unfamiliar800/4000ms timers continue to block settlement and
quiescence. A similarly named function/file is insufficient. This changes no
production source, generator event/order/weight, clock advance, drain round,
intent history, ref-cycle debt or boundary classification. New controls require
a real pending history timer alongside both actual current files and a retained
line choice before allowing a browser baseline. The existing Inspector control
also requires the real history timer to remain pending through debt retirement.
Other controls exercise real document/Keep timers and actual unknown800/4000ms
timers; unknown timers are the sole blocker over otherwise settled bytes.

Root's exact fd11d908 focused100 run returned226PASS/1FAIL across four files:
94 completed generated originals,5 exact cancellation prefixes and1 UNKNOWN
original20261094. All new history/Inspector/document/Keep/unknown/missing-origin
controls passed. No runtime, timeout, cleanup error or source drift occurred.
Original20261011/20261026 no longer produced UNKNOWN here; no new autosave
category was added. Evidence: p9c-root-fd11-focused100-001. Root's exact31-original
replay returned5 completed,7 cancellation prefixes,1 stale-final prefix,
1 forced-exit prefix and17 UNKNOWN originals, all preserved separately:
p9c-root-fd11-31-originals-001/results.json. No acceptance is claimed.

Root's separate history exclusion sensitivity proof passed: both fixed named
positives and all5 negative controls passed; removing ONLY the history exclusion
produced two clean early functional AssertionErrors for baseline receipt and
debt retirement. All5 mutant negative controls passed. No runtime, timeout,
cleanup error or source drift occurred; restoration and seals verified.
Evidence: p9c-root-history-timer-fd11-001/results.json. This proves the scoped
history exclusion, not full model completion.

### Untouched opened browser settlement proof (aeb50f)

Root ran seven separately sealed exact-fd11 ORIGINAL diagnostic orders:
20261358,20261467,20261873,20261184,20261737,20261094,20262168. Each reproduced
its UNKNOWN by a clean assertion without runtime, timeout, cleanup error or
feature drift. The private p9c-fd11-original-causal-analysis.md identifies
original-only pre-cleanup row locations and compares uninstrumented failures;
no original result is inferred from its minimized order.

Original20261358 row107 establishes a narrow receipt-model gap: fresh browser
ref5 is untouched and saved, BOTH physical files exactly equal that ref's
opened/openedText bytes, actual write count2 equals opened count2, and all
pending public/saver/owned-final/writer/Keep/relevant-timer guards are clear.
Physical identity/mode/version and ALL historical intent pass, including prior
chapter1 text in BOTH files and Empty chapter order in BOTH files. The only
current page difference is browser reflow of the late box from saved48px to
live70px. Requiring current geometry equality prevents a proven old chapter-ID
debt settlement. Later cancellation on fresh browser refs is a separate
physical event, and raw action applicability can change after correct receipt
settlement; its old terminal choices cannot be projected onto a new candidate.

The model now binds openedRef at actual open/adoption and baseline capture.
It retains the current-document equality branch and additionally permits the
literal BOTH untouched opened bytes only under browser/off, exact opened ref,
no touch and unchanged observed write count. Existing pending/public/saver/
owned-final/timer/writer/Keep/saved/failure guards remain mandatory. Physical
chapter/project identity, page order/durable filenames, mode/version and ALL
historical choices across every chapter remain mandatory for either receipt.
There is no debt deletion merely on reopen or ref change, no historical choice
reset and no physical-file or pending-work waiver.

A separate browserSettlements map records every actual positive browser
receipt, with explicit retiredRustDebt=true/false. Pure browser settlement is
not prior Rust debt deletion; the existing Rust retirement map still records
only actual debt retirement. The new map is observational and feeds no
classifier. Existing categories, generator events/weights/orders/stages,
fourteen drains, raw robustness probes and production source are unchanged.

New named controls exercise the real original1358 reflow prefix, functional
old-debt retirement and a fresh Rust baseline with ALL history retained. Thirteen
refusal controls cover either opened file's bytes, exact ref, extra actual
write, touched cycle, current/inactive choice loss, real document/unknown timer,
live durable filename, physical identity, mode and version. A public held
old-ref Rust-owned final cannot qualify a fresh browser receipt; a positive
pure-browser receipt explicitly claims no prior Rust retirement. Independent
static review approved the narrow draft; syntax and whitespace checks pass.
Root's exact aeb50f focused100 proof completed in18.047s with242PASS/1FAIL
across four files; all16 new receipt controls passed and the sole generated
UNKNOWN was original20261094. Runtime/timeouts/cleanup errors were zero and
source was unchanged: p9c-root-aeb50-focused100-001. The exact31-original replay
returned5 completed,8 exact cancellation prefixes,1 stale-final prefix,
1 forced-exit prefix and16 UNKNOWN, with1007 generated events,732 executed and
275 unexecuted tail events. Original and minimized proofs remain separate:
p9c-root-aeb50-31-originals-001/results.json. Original1358 now settles its proven
untouched opened receipt and later reaches the existing exact cancellation;
this does not waive same-ID opens or delete the other chapter's retained debt.

The root-owned fixed reproduction continuation passed all9 cases on exact
aeb50f: p9c-review2-repros/runs/fixed-owned-v2-aeb50-001/results.json. The separate
opened-receipt sensitivity proof passed, including its scoped removal and
negative controls: p9c-root-opened-receipt-aeb50f-001/results.json. No full6000
acceptance is claimed from these bounded proofs.

Remaining pure-browser leave/open traces still have pending actual newer saves
or missing causal attribution. Original20262168's newer chapter/older held
translations cannot satisfy old BOTH cancellation; original20261184's quiet
same-ID loss needs its actual open/saver/timer binding. No new category was
added. The full6000-order model, remaining combined proof lanes and final
review remain pending; no completion is claimed from diagnostic prefixes.


### Actual public-open and saver observations (2a94d measured, acceptance pending)

The committed model-only observation change replaces first-pending filesystem attribution at BOTH
start and landing with the exact still-pending saver invocation's test-only
AsyncLocalStorage context. Public open and saver wrappers pass the same
arguments and return the original promise unchanged. Active matching public
ref/window/generation can bind its saver; missing, expired, mismatched and
superseded contexts remain observations without an authoritative operation
binding. Multiple invocations retain the first snapshot/timer/held evidence and
all invocation serials, while explicit ambiguity refuses known classification.
Stable test-only ref tokens serialize identities without live object cycles.
A chapter snapshot must start on the captured actual ref. Its already-started
translations may finish after incoming adoption, on that exact invocation's
old paths and bytes. Independent raw write tokens preserve actual browser/
version-at-start facts even if saver attribution is unknown; the browser
version invariant must still reject an unattributed current-byte version2
write. No next-writer or next-snapshot guess remains.

Actual public-open fulfillment is distinct from a boolean leave answer. Model
adoption requires observed fulfillment, a changed actual ref, loaded matching
project/target and matching generation. A fulfilled superseded same-ID no-op
must preserve the touched cycle, opened baseline and historical intent.
Independent choices are copied at the actual chapter snapshot boundary before
its hold; existing cancellation/stale-final witnesses must preserve that earlier
map in BOTH files, including the previous value of a later superseded key.
This tightens scope; it does not create a new transient category.

Each actual timer clear records one real clearer stack, immediate caller/source,
monotonic order, inherited public/invocation context and actual physical bytes.
Repeated clears remain in observation history. Existing cancellation additionally
requires the immediate markSaved caller and its still-active exact saver
serial/ref/snapshot before the deadline. An unrelated, expired or incoming LOAD
clear cannot supply that outgoing saver proof. Unknown caller sources remain
unknown, and no clear call or clock change is introduced.

Named controls cover a causal open behind an older held autosave, a missing
earlier same-key intent, missing/expired/mismatched contexts, unrelated/expired
markSaved clears, the original94 incoming LOAD boundary, a fulfilled same-ID
no-op with exact unrelated historical intent/debt/physical obligations,
multiple-invocation refusal with first observations preserved, and original
promise identity. The registered callback's unchanged return is verified
statically; its named observation checks original-promise completion, while
open/direct-save controls compare the public returned identity. Existing four stale queued-ref controls
also check the outgoing BOTH receipt after actual ref adoption. Root measured
exact2a94d focused100:252PASS/3FAIL, with original20261094 UNKNOWN and the two
unrelated/expired markSaved controls failing caller-source metadata only after
their functional refusal/lost-intent assertions passed. Runtime, timeout and
cleanup errors were zero, source unchanged: p9c-root-2a94d-focused100-001.
The exact31-original continuation returned5 completed,11 exact cancellation,
1 stale-final,1 forced-exit and13 UNKNOWN,1007 generated/732 executed/275 tail:
p9c-root-2a94d-31-originals-001/results.json. Quiet1184/2245/2419 now reach the
existing exact cancellation; no new category was added. These bounded results
are not full6000 acceptance.

The root-owned assertion-message-only diagnostic printed each already captured
clearer stack on an exact2a94d archive. Both immediate callers were Proxy.markSaved
at store.svelte.js:2403:3. It returned the expected two clean metadata assertion
failures, no runtime/timeout/cleanup/source errors and verified empty owned
processes: p9c-root-2a94d-clearer-message-001/root-clearer-message.json. Archive,
all610 tracked scratch hashes and sealed inputs were verified after execution.
The original strict immediate-source matcher remains unchanged. The new fixture
draft destructures the same original exported markSaved and calls it directly.

Root also found that shallow proof fields could acquire nested snapshot.text,
physical receipts or timer history during finally cleanup. Existing classifier
outcomes were decided before cleanup; polluted nested fields cannot establish
what had actually started/landed at that boundary. The authorized observation
correction copies the entire ref/promise-stripped proof BEFORE cleanup and
copies a deferred return at its catch boundary. A boundary observation order
makes later clear/receipt additions distinguishable. Actual settlement receipts
now carry a stable ref token and monotonic observation order at creation, with
no eligibility change or debt deletion.

Two named original94/2168 cutoff controls require held chapter translations to
remain unobserved/no physical receipt, or held translations to retain exactly
one actual chapter receipt, after cleanup really completes both physical writes.
Existing same-ID deferred-prefix checks verify returned observations are separate
values from the live cleanup objects. Pure-browser receipt metadata remains
explicitly separate from Rust retirement. Root measured exact2c focused100-002:
256PASS/1 generated UNKNOWN20261094; both cutoff controls and both direct-original
markSaved controls passed. The exact31-original continuation remained5 completed,
11 exact cancellation,1 stale-final,1 forced-exit and13 UNKNOWN,1007 generated/
732 executed/275 tail. Both runs had zero runtime/timeout/cleanup/source errors
and empty owned processes: p9c-root-2c088-focused100-002 and
p9c-root-2c088-31-originals-001/results.json. Original event orders, stages,
executed prefixes and tails were unchanged from2a94d. The immutable-cut summary
is p9c-root-2c088-original-immutable-cut-summary-001.json
(SHA256382985a92f2755de5824baf5ec3b87b9ee965a829b5e12cc9be34d5202c24671).
No new category or full6000 acceptance follows from these bounded runs.

### Outgoing physical rejection must not cancel incoming Keep (P2, verified)

The independent whole-P9 source review identified an outgoing failure that
unconditionally cleared current stamping, flagged current save failure and
ended current Keep in store.saveFailed. Root reproduced it on exact2c with the
real public editor final, overlapping outgoing physical writes, an actual newly
loaded incoming ref and its original font-waiting Keep. The first outgoing
BOTH receipt permits close; only its later actual writer is rejected after
incoming Keep starts. The direct outgoing caller receives the identical Error;
the public outgoing leave still returns false and reports its own error. Yet
incoming Keep rejects with that outgoing Error, its actual4000ms timer is
cancelled and its save-failed indicator becomes true, without any incoming
physical write. Both incoming files remain unchanged at that early assertion.

Root-owned p9c-root-outgoing-rejection-incoming-keep-2c088-002/results.json
confirmed2 clean regression AssertionErrors at the same functional Keep-pending
assertion and2PASS existing same-current failure controls. There were no runtime,
timeout, cleanup, source/configuration errors; all owned processes were empty.
The preserved attempt001 did not start a child because load exceeded8. Original
repro overlays and witnesses remain sealed separately for source-only fixed
continuation; their failing evidence is not replaced by the support fixtures.

The narrow source fix scopes saveFailed effects to the exact request ref object
AND document load turn. A stale failure returns its original Error without
clearing current stamping, changing its indicator or ending its Keep. Final
save already captures both values at call time. Autosave captures them when
its real document-timer callback starts, immediately before runSavers. Capturing
only at timer arm would wrongly suppress a legitimate later-turn failure.
Original rejection/caller behavior and current-document autosave/refusal wording
remain; stale failure now explicitly identifies the previous chapter. The
request-time refusal policy and queued destination repair are described below.

Six expanded named public controls were added and are now verified: genuine same-ID
fresh-ref reopen; same-ref/new public loader turn; delayed actual outgoing
autosave rejection; current explicit-final failure; current actual-autosave
failure while its own Keep waits; and a real autosave timer armed before a
public turn change but fired afterward. Functional assertions cover original
Error identity, the correct Keep/deadline/save indicator and actual BOTH files;
autosave controls retain their own error toast. A diagnostic cut is captured
before the earliest failure assertion; assertion eligibility does not depend
on that metadata. No source-private turn/ticket/stamp inspection or rescue save
is added. Generated events, seeds, weights, stages, fourteen drains, cleanup,
raw probes, categories and all historical choices/debt are unchanged.

The same-ref/new-turn support uses the actual public loader APIs; normal
library reopen changes ref too. Real same-ID fresh-ref reopen changes load turn,
so removal of only the ref comparison may redundantly survive and is not claimed
to be independently killed. Incoming font-wait controls prove Keep and indicator
preservation plus later physical persistence, but do not independently prove
preservation of an already-created incoming stamp. The guarded stamp effect is
statically scoped; stronger live-writer evidence remains separate. runSavers
still dispatches subscribers in a later microtask; this fix does not claim to
bind save destination across a ref change in that separate dispatch window.

Private preparation p9c-2c08871-save-failure-scope-private-v2 was independently
statically approved and regenerated exactly from sealed2c inputs. Root506 measured15 selected controls passing and the unchanged original
continuation2PASS with2same-current supports. The current strict model and
physical persistence proofs below supersede the earlier unexecuted submission.
Mutation sensitivity and final integrated whole-P9 review remain coordinator
acceptance work. No transient browser-loss category is applied.

### Current persistence repair and strict model (2026-10-10)

The user's expanded scope requires fixing genuine browser and related save bugs.
Earlier browser-loss/cancellation/transient verdicts are retained as historical
diagnostics. All five ordinary loss acceptance dispatches are removed, and
every completed browser order checks actual BOTH files and ALL independent
choices. Root's exact original3056/4050/6677 Error-identity replays prove the
unique writer→saver→underlying→own original-public rejection chain; only that
chain can let replay continue. It cannot waive the later disk/version/debt
assertion, and a foreign same-message error or fulfilled-reaction error fails.

Actual original startup seeds20262691/20263661/20264358/20265531 returned TRUE
with Rust on, saved false and BOTH physical files at version1 although the actual
version had become2 before the first public reply. Root retained the original
orders/stages/prefix/tails in p9c-root-506-startup-original*-001 and its
p9c-root-original4-actual-audit-001.json. Four source-free regressions copy the
first original TRUE cut and synchronously close before assertions or later
repair; all fail archived506 at physical version1 and pass this repair at2.
The same literal orders are used; when still pending at their end the named
support uses only the existing fourteen drain rounds. Generated schedules have
not changed.

Final saving now converges for browser as well as Rust. Every actual BOTH-file
receipt advances the exact snapshot ledger, independently of latest-save
indicator permission. A writer marks saved only when its actual receipt matches
the current document/version/mode, so older bytes cannot clear a newer edit's
800ms timer or substitute current live pages as disk evidence. Edited pending
Rust startup is awaited or cancelled before final approval; absent future box
fonts and untouched first-fit trials retain their existing behavior. The public
leave continuation revalidates after its last await, including the bounded quit
history wait, and retries share the original ten-second document deadline.
Open revalidates before discarding the outgoing reference. Actual writes and
queued calls check both exact reference object and public load cycle, including
a same-ref new load; old success cannot clear a newer cycle's failure warning.

A deliberate discard requires a refusal already known when that request began,
the same reference/cycle and unchanged refusal epoch. Concurrent requests begun
before either refusal cannot consume confirmation. Genuine BOTH success and
close clear that basis. Public TRUE replies carry an approval for their exact
reference/cycle/document/version/mode and font-source identity, including the
explicit discard outcome; this is not a durable claim for discard. Route close
and window/menu destroy check that original Promise approval at their final
consumer. A new chapter gets its own quit request. Superseded navigation cannot
close or replace a newer editor, Back consumes only its committed history entry,
and a stale App open failure cannot navigate away from the current chapter.

p9c-worker-save-fixes-focused-005/results.json records43PASS across model,
library, route and App DOM controls. The actual held-browser regressions cover
translation, text, height, color, typesetting mode, chapter mode and page order
in BOTH files, plus raw later edits, startup cancellation/timeout/untouched
supports, concurrent confirmation and incoming cycle protection. The approval
controls use the real library approval API; App DOM tests mock its decision and
independently exercise the actual destruction/navigation continuations.
p9c-worker-save-fixes-old506-003 records19 clean functional AssertionErrors using
identical current tests on immutable archived506 source, including all four
startup cuts, browser handoffs/timer, concurrent confirmation, incoming BOTH
cycle, route/Back and App overlaps. Missing new APIs are not counted as old
failures. Both jobs retain source snapshots, raw reporter/logs and exact owned
cleanup evidence with no timeout, runtime suite, cleanup or source drift.
The full library/route/App check in
p9c-worker-save-fixes-library-route-001 records195PASS with the same clean
source/owned-process guards. Earlier failed fixture attempts remain preserved;
old506-002 stopped before a child because the local Python tar API lacked its
requested keyword.

The worker then reproduced and fixed twelve actual post-snapshot persistence
failures: all ten raw durable fields and two original font/startup orders. A
fired timer is no longer mistaken for an armed timer. A stale BOTH receipt
rearms only actual remaining bytes/version/mode debt, preserving any later
edit's original deadline. A touched held-start support proves identical browser
bytes are not rewritten every800ms; the final caller still waits for actual
startup under its original bounded deadline.

Fit now and Make auto now mark a genuinely changed/deleted review dirty even
when geometry returns false. Equal review values still schedule no write, and
no geometry history entry is added. Real-library controls observe chapter review
and the actual translations/retained choices after natural800ms BOTH writes;
the translations format has no review field. Browser no-growth longstrip passes
now preserve y exactly, using the same algebraic early guard as Rust. These are
intentional browser changes, not pixel-layout changes inferred from a capture.
Final node/browser captures must verify that visual limit.

Stale outgoing failure notices now say **previous chapter** and retain the
original error. They cannot tell the incoming editor to discard its on-screen
work. Actual public leave returns false; outgoing autosave still reports its
failure; incoming Keep/deadline/flags and subsequent BOTH persistence remain
strict. Current-document refusal/discard wording remains covered separately. A stale
editor/quit timeout is now similarly contextualized: its old underlying writer
remains pending, it returns false without banking discard permission, and it
cannot describe incoming editor choices as the work keeping that caller there.
The corrected actual incoming-font/Keep fixture reproduced both wrong notices
before the source change in p9c-worker-stale-timeout-old-002 (2 clean functional
AssertionErrors). Attempt001 had already-loaded fonts and failed setup instead;
it is preserved and is not counted as source failure evidence.

Measured worker proofs (all under tp-data/reports/resume-20261009):

- p9c-worker-strict-named-all-002:427PASS/0 in model, first-fit, library,
  route and App DOM, including literal original20266101, the public stale
  leave and both stale timeout supports. This follows removal of3
  certificate-only private controls whose unused loss waiver no longer exists.
  The earlier all-001 also passed427 before those final control substitutions.
- p9c-worker-review-persistence-old01b-001:19 clean functional AssertionErrors
  on immutable01b source with identical corrected test files:10 raw fields,
  2 original font/startup orders,2 actual-library review BOTH controls,
  4 review/no-growth unit controls and1 stale-autosave notice. The earlier
  Make-auto setup that actually resized was rejected as a fixture and retained;
  the corrected review-only geometry proves the source defect.
- p9c-worker-stale-public-notice-old01b-001:1 clean functional AssertionError
  on unchanged publicFALSE/error attribution because old wording refers to
  incoming on-screen edits instead of the previous failed chapter.
- p9c-worker-strict-generated6000-001:5999 completed orders and1 unresolved
  original20266101; all197113 events executed. The independent original audit
  proves ALL7 choices already present in BOTH files before its fresh open.
  Its final unmarked_fit assigns the same canonical fit; only engine-firstfit
  h48→70 differs. The model now preserves prior touched state for that exact
  no-op fit while retaining assignment, choice Map, relayout and debt. Named
  null→rect and different-rect controls still require actual natural800ms
  BOTH/version2 writes. No other action or at-rest rule is relaxed.
- p9c-worker-fit-bookkeeping-old-wrapper-001: restoring only the old
  unconditional touched=true bookkeeping gives1 clean functional same-fit
  AssertionError;2 genuinely changed-fit controls still pass on identical
  production source. The failed original6000-001 is preserved separately.
- p9c-worker-strict-generated6000-003:6000 completed invariant orders,
  0 unfinished force/ordinary-loss prefixes,0 unresolved;197113 generated and
  executed events,0 tail. This used the unchanged seeded generator/weights,
  schedules, clocks,14 drains, cleanup and independent retained choice oracles.
  Exit0,47.839s, starting load1.83. This final code run follows the dead-waiver
  removal and contextual stale-timeout repair; earlier002 also completed6000.
  The deliberate sequential-refusal support is separately and explicitly
  unfinished; concurrent original failures no longer count as confirmation.

Every listed behavioral run has raw logs/reporters, input and before/after
source snapshots, no timeout/runtime-suite/cleanup error, unchanged execution
source and verified empty owned processes. Early failed named/fixture attempts
remain preserved, including raw domain Broken failures (not mislabeled as
AssertionError kills). Sealed privatev7/v9 old loss fixtures are historical;
unused transient/obsolete-owner predicates and their private fault catalogs
were omitted from current acceptance, not counted as passing proof. Actual
promise/error/owner/disposal/falsy observations, pending underlying guards,
ALL choice/debt checks and genuine public-PENDING CH/TX immutable cut controls
remain. The raw cut controls first prove pending public approval and actual
held bytes; cleanup's later TX/BOTH receipt cannot mutate their retained proof.

These worker results are a concrete candidate, not merge authorization. Root
independent pinned reruns, final mutation/capture/dry-run proofs and whole-P9
review remain outstanding.

### Failed Keep retry keeps its own deadline (2026-10-10)

The independent pause audit found one live defect at `5e25827`. After a
failed Keep, `saved` is false and no ordinary save timer exists. A second
Keep while a font is held made `settleDisk` arm an 800ms save, then its
four-second deadline wrote the same snapshot again. A waiting Keep now
creates no ordinary timer. Any timer already armed by an edit retains its
original deadline. The Keep deadline and later fitted-font debt still write.

Measured worker evidence under `tp-data/reports/resume-20261009`:

- `p9c-worker-keep-fixed-001`:22 passed,0 failed in the complete
  `first-fit.engine.test.js` and `EngineNotice.dom.test.js` files. The notice
  file and its exact one-save assertion at301 are unchanged.
- `p9c-worker-keep-old5e-001`:20 passed,2 clean functional AssertionErrors
  using preserved immutable `5e25827` production and the same new engine
  test overlay. The unchanged notice assertion sees two saves. The new
  real-file retry assertion sees both physical files written at800ms.
- The real-WASM/node:fs regression fails the first translations write after
  chapter.json lands, retries with the font held, and proves no write at800ms
  or before the four-second deadline. Exactly one chapter/translations pair
  lands at that deadline at version1. No redundant pair follows. A later font
  fit persists one new pair with its actual height and version2.
- The separate real-file control arms a user-edit timer before retry. Both
  files retain the edit at its original800ms deadline; the font's later fit
  and version2 follow without losing that text.

Both runs began below load8 and retained raw reporters/logs, exact source
hashes and commands. Neither timed out or changed execution source; the
existing owned-process helper verified an empty process group with no
cleanup or execution error. These focused results do not replace final
root proofs, canonical dry runs or independent whole-P9 review.

### Exact Error binding for the unfinished force escape (2026-10-10)

The final independent reviewer found a model-only gap. The deliberate force
certificate matched injected failed writers to two failed savers by reference,
serial and the words `disk full`. It now requires the identical Error in the
injected physical writer, the finished original saver and the rejected
underlying original flush. The exact snapshot path/raw-write/start ordering,
reference/token, public request and reply ordering must match too. Original
saver, underlying flush and public Promise observations are required. Leave
returns its real Boolean; no nonexistent public rejected Error is inferred.

Measured evidence under `tp-data/reports/resume-20261009`:

- `p9c-worker-force-bind-fixed-002`:7 targeted controls pass. Valid deliberate
  force retains its original exact order, unexecuted `switchOff` tail, choices
  and debt and stays explicitly unfinished. The original overlapping failure
  order remains completed without consuming a force confirmation.
- `p9c-worker-force-bind-old756e-001`:the identical five new controls fail
  clean functional assertions on the immutable old classifier; the two
  matching/concurrent controls pass. Distinct same-message actual writer
  rejections on either failed leave, a foreign observed underlying Error,
  and missing underlying/public Promise observations cannot now certify a
  force prefix. These are model-certificate failures, not production kills.
- `p9c-worker-force-bind-model-all-001`:173 passed,0 failed with generation
  explicitly disabled. The full6000 run follows on the clean committed tree.

Initial fixed attempt001 required an open-only `fulfilled` field from the
leave observer and failed the valid-force control. It is retained and rejected
as acceptance evidence. Corrected002 uses actual leave reply fields. No
production bytes, assertions, generator, schedules, clock, drains, retained
choices/debt or accepted categories were changed by this model correction.
All final listed runs began below load8, retained logs/reporters and source
guards, had no timeout/cleanup/execution errors and verified empty processes.

### The actual dry lane exposed its direct-style fixture error (2026-10-10)

The first final canonical attempt on `1bd5bfc` failed its real-copy lane,
not its historical-output comparison. `layOf` passed `cand.s` into the direct
metric reader, but a containment candidate has `style`; `s` belongs to the
placed block. The reader therefore threw while reading `style.size` for
every straight layout. The fixture now passes `cand.style`. This uses the
candidate's style directly and still takes no positioned geometry as a
metric input. No layout/error assertion or denominator is weakened.

The failed existing regression is retained at
`p9c-root-dry-proofs-v3-owned/runs/worker-feature-canonical1-1bd5bfc/attempts/20261010T183441150613Z`
under `tp-data/reports/resume-20261009`. Its raw verdict is complete but
failed:6218 layout failures, all the same missing-style error,0 paint failures,
13 chapters. The actual assertion at464 fails. The entire failed canonical
output is preserved privately as `failed-canonical-output/` before any new
regeneration. Its recorded output hashes match. Process safety, copied
inputs/source, unlisted files and all9 canonical check files passed their
guards; owned processes were empty after6.288s. This attempt does not count
as either required passing worker dry run. Two fresh canonical runs and the
root's independent comparison follow on the corrected clean tree.
