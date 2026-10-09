# P9: what happens to a chapter lettered before the Rust engine

Branch `tp/chapters`, on top of `a0c00bf3`. Two rounds: eleven commits and
the report's own in the first; then the coordinator's merge of `text-port`
(`9757ac50`) and nine commits answering an outside review in the second.
All are listed in section 13.
The briefs are `tp-data/briefs/p9-old-chapters.md` (sections 2 to 6 carry its
item numbers) and `tp-data/briefs/p9b-old-chapters-fixes.md` (section 14,
"Second round"). Sections 0 to 13 are corrected to what the code does after
the second round; where a first-round statement was wrong, section 14 says
so.

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

Rewritten in the second round. The first round's table was wrong in four
rows: it said "leaving without an edit: nothing" where a change the app had
not marked (a handle still held) was then lost; it gave version 2 to every
save under the Rust engine, a box still waiting for its font included; it
said Keep writes at once; and it did not say what a failed write leaves.

With the switch **off**: nothing changes from before this phase, except that
a chapter at version 2 is saved as version 1.

With the switch **on**, for a chapter at version 1. "Untouched" means: the
document equals what was noted at the open plus what the engine itself wrote
(tops, heights, flags, solver stamps; all of a box laid out for the first
time), compared page by page and box by box, and the chapter has not been
marked unsaved.

| moment | written |
|---|---|
| opening | nothing |
| a font arriving after the open, the chapter untouched | nothing (a box laid out for the first time by it included) |
| leaving, quitting or the window closing, the chapter untouched | nothing |
| turning the switch off, the chapter untouched | nothing; the boxes go back in memory, each whole |
| leaving or quitting with a change the app has not marked yet (a resize, move or rotate handle still held; "Fit now" that only changed the reason; anything else that altered a page or a box) | `chapter.json` and `translations.json`, whole, as below. Nothing is put back |
| the first save an edit causes (800 ms after it, or on leaving) | `chapter.json`, whole, as every save: the edit, every grown `h` and its `y`, every `review` raised or cleared. `typesetting.version: 2` if no box of the chapter is waiting for its font at that moment; otherwise the number the file had (1). And `translations.json`, which every save derives from it |
| the font that box waited for arriving, after such a save | one more save, 800 ms later: the box as the engine has now fitted it, and `typesetting.version: 2` |
| leaving before that font arrives | nothing more; the file stays at version 1, and the next open under the Rust engine shows the notice again |
| Keep on the notice | the same two files, without an edit. If a box is still waiting for its font the write waits for it (the chapter is marked unsaved at the press, so leaving meanwhile writes at once); when the wait gives up, what there is is written, at the file's number |
| a save while the engine is still starting (the switch on, nothing measuring yet) | the edit, at the number the file had; no height or flag of the engine's, since it has fitted nothing |
| a save that fails (disk full, folder gone) | nothing, or whatever the failed write left; the chapter stays unsaved, the indicator shows the failure, the notice stays or comes back, the version in memory stays the file's. Leaving, the next edit or Keep tries again |
| a load that mints ids or repairs pages | as before this phase: the repair is saved, and it carries the above |

With the switch on, for a chapter at version 2: as before this phase, except
that a font arriving late no longer schedules a save unless an edit's own
fit was waiting for it. A version 2 chapter saved while a box waits for its
font stays at 2.

Never written: which boxes had their lines moved; that the notice was seen;
any new field. No file under the chapter's folder changes by opening, by a
late font, by waiting or by leaving (measured: the engine test digests every
file in the folder). Keep changes exactly `chapter.json` and
`translations.json` (measured, same test); the page images and every other
file keep their bytes.

One thing in memory only, with the switch on and in a long strip: a box the
open does not grow no longer has its top edge rewritten in its last bit
(section 14). Under the browser that rewrite still happens, as before this
phase, and reaches the file with the next save.

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

## 14. Second round

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

**Finding 10: what "Fit now" does today under the browser.** On a box it
cannot improve it writes the new reason into the box and returns before
`markUnsaved` (`fitBoxNow`, `store.svelte.js:1134`, `:1136`). The chapter
still reads "saved" and no save is scheduled. Under the browser the flush
on leaving always writes, so the reason reaches the file then; a crash
before that loses it. Old behaviour, not changed.

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
- **Not fixed: default mode.** Under the browser the pass still rewrites
  such a top edge in its last bit and counts the box as moved, so in a long
  strip a font that lands after the open can schedule a save that changes
  nothing visible. It did so before this phase. The rule is that default
  mode is untouched, so it is left and said here.
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
- I did not change "Fit now", or the long-strip rewrite, in default mode.
- The dry run's refusal (finding 7) was run on a made-up chapter only: no
  real copy has such a page.
- The first-round figure "a second run gave 201, 122 and 249 ms" is not
  repeated; section 8 has this round's one run.
