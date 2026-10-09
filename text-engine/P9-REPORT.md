# P9: what happens to a chapter lettered before the Rust engine

Branch `tp/chapters`, on top of `a0c00bf3`. Eleven commits and this report's
own, listed in section 13.
The brief is `tp-data/briefs/p9-old-chapters.md`; sections 2 to 6 carry its
item numbers.

Every figure is marked **measured** or **inferred**. Measured on the 13
chapter copies means: the app's own store, switch and font sync in node, the
wasm with sha256 `1c6e5e3f…bcbcc`, the user's 63 font families from
`tp-data/fonts`, and this Mac's installed fonts (432 families found). Measured
in Chromium means headless Chrome 155 driven by
`scripts/text-port/p9-check.mjs`. The machine was loaded while these ran.

No chapter text is in this file. Boxes are named by id. The pictures and the
report for signing are under `tp-data/reports/p9`.

## 0. Result

| proof | result |
|---|---|
| dry run, twice | byte-identical: 917 files, one digest (section 3). Exit 0 |
| dry run, gate G6 | x, width, size changed: 0. Heights shrank: 0. Top edge moved without its height: 0 (measured, 2,487 boxes) |
| unexplained changes | 0 of 442 changed boxes (measured) |
| tests for items 1 and 4 | 31 tests in 3 files; 21 mutations, each fails at least one (section 7) |
| browser check | 16 of 16 checks pass, 0 page errors (section 8) |
| `./node_modules/.bin/vitest run` | 123 files: 120 passed, 2 skipped (env-gated), 1 failed. 3,379 tests: 3,369 passed, 8 skipped, 2 failed. Both failures are "Test timed out in 5000ms" in `src/test/text-port/compare/cli.test.js` with the load near 30; that file alone: 19 of 19 pass. The brief's last result was 118 files, 3,340 tests; this phase adds 3 test files with 31 tests, all passing, and the dry run's lane file, skipped without its switch (measured, tree `372e8c82`) |
| `npm run build` | exit 0; one warning, the chunk-size one. wasm sha256 `1c6e5e3f…` before and after (measured) |
| capture, default mode, against `runs/ref-sk/base` | run `p9-sk`: 64,718 metrics, 17,538 layouts, 3,732 pictures, 0 errors. `diff -rq`: 3,405 files each side, only `manifest.json` differs (measured). Run deleted |
| capture, `--engine new`, against `runs/new/r4` | run `p9-new`: 64,718 metrics, 17,538 layouts, 3,732 pictures, 0 skipped, 0 errors. `diff -rq`: 3,736 files each side, only `manifest.json` differs (measured). Run deleted |

## 1. The design: what the version number is for (item 4, first part)

**Before.** Every chapter file has `typesetting: { mode, version }`.
`version` was `LAYOUT_VERSION = 1` in every file, or absent. Nothing read it.
It was stamped "so a later change to the rules can tell the chapters set
under the old ones apart".

**Now.** The number says which engine last fitted the chapter's boxes.

| version | meaning | written by |
|---|---|---|
| 1, or absent | boxes last fitted by the browser | a save with the browser measuring |
| 2 | boxes last fitted by the Rust engine | a save with the Rust engine measuring |

- **Read** once, at open, and only with the switch on: a chapter under 2 is
  one the Rust engine has not fitted. `beginFirstFit`,
  `src/lib/store.svelte.js:1243`.
- **Written** only by a save, in one place: `stampTypesetting`,
  `src/lib/store.svelte.js:1420`, called by the saver as it takes its
  snapshot, `src/lib/library.svelte.js:2044`. An open never writes it.
- **The stored format** changes by this one integer's meaning. No field is
  added. Which boxes had their lines moved is not stored.
- `normalizeTypesetting` (`src/lib/data.js:128`) already kept any positive
  integer, so an older build reads a 2 as it reads a 1 and writes it back
  unchanged (inferred from that code; not run on an old build).

**First open of a version 1 chapter with the switch on.**

1. Every box is noted as the file has it, before the engine fits it.
2. The standing rule runs in memory: heights grow, flags are raised or
   cleared, lines may break elsewhere. Width, size and place do not change.
3. The text queue shows one notice with the counts (section 5).
4. Nothing is written. The chapter is not marked unsaved.
5. It is written when the user edits the chapter (the edit's own save) or
   presses Keep. That write carries the grown heights, the flags, and
   version 2.
6. Left untouched, nothing is written and the next open says the same again.
7. The switch turned off puts every box back as it was noted.

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
| boxes noted before the load's fit | `store.svelte.js:311`, `beginFirstFit` `:1243` |
| noted when the switch comes on over an open chapter | `setFontSource`, `store.svelte.js:5465` |
| a grow-only relayout schedules no write while the Rust engine is on (A1) | `relayoutAll`, `store.svelte.js:1496` |
| leaving an unedited, unkept chapter writes nothing (A2) | `flushSave`, `store.svelte.js:1983` |
| the switch going off restores `y`, `h`, `review` and the solver's stamp | `endFirstFit`, `store.svelte.js:1381` |
| the version is stamped by the saver | `stampTypesetting`, `store.svelte.js:1420`; `library.svelte.js:2044` |

With `textEngine: 'browser'` no font source is set, so `beginFirstFit`
returns at its first line, `relayoutAll` takes the branch it always took and
`flushSave` is not gated. `stampTypesetting` leaves a 1 a 1.

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
node scripts/text-port/dry-run.mjs --data <tp-data> --out <dir> [--legacy-mode smart|plain] [--load-fixtures yes]
```

| part | job |
|---|---|
| `scripts/text-port/dry-run.mjs` | the command; exit 2 on a G6 breach |
| `src/lib/text-port-dryrun.realfont.test.js` | the lane: the app's open path on each copy |
| `scripts/text-port/lib/dry-compare.mjs` | what changed for one box |
| `scripts/text-port/lib/dry-report.mjs` | counts, causes, pictures, the two reports |
| `scripts/text-port/lib/installed-fonts.mjs` | the native font answers, re-made in node |

Per chapter the lane runs four opens: nothing measuring (the file's own
flags), the browser's stand-in, the Rust engine, and the Rust-fitted
document back under the stand-in. With the Rust engine it also reads the
notice's counts, leaves, keeps, and records what each wrote.

**Deterministic (measured).** Two runs, same tree: `diff -rq` empty, 917
files, combined sha256 `59fcf4ab…cb9be196` both times. No time, home path or
random number is written.

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
| grew taller | **361** (largest 210.49 px, median 6 px) |
| newly flagged | **75** |
| no longer flagged | **4** |
| line breaks changed | **7** |
| text block more than 0.5 px from Safari's | 56 (25 over 2 px); 39 of them in a box that did not change otherwise |
| boxes in a font this Mac lacks | 35 (32 with text), 5 families |
| boxes borrowing a letter | 30 |
| stored as `pending` | 0 |
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
- **Rule 4, moved (19).** 0.57 to 2.72 px; 2 over 2 px.
- **Rules 7, 8, 9, 10, 11.** No change is attributed to any of them. 30
  boxes borrow a letter (rule 11); 5 of those changed, each by a nearer cause
  in the table above.
- **Engine-caused line changes in a font the user has: 0.**

### What I saw in the pictures

I looked at all 30 sheets (442 boxes, Safari left, Rust right), and at three
pictures at full size.

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
  grown taller. Then: no box changed its width, size or place; nothing is
  saved until you edit the chapter or keep these.
- **Step through:** it builds no list. A flagged box is in the review list
  as always. A box whose lines moved and that still fits is listed there
  too, with the reason "Line breaks changed with the new text engine", until
  the notice is answered (`flaggedBoxes`, `store.svelte.js:1143`). It is not
  a flag: the canvas badge and the PSD ask `reviewOf`, which does not answer
  with it. "Show first" selects the first such box.
- **Keep:** saves once, at version 2, and the notice goes. After an edit has
  already saved, the button reads "Got it" and only closes.
- **Not shown** with the browser measuring, for a version 2 chapter, or when
  nothing changed.
- **Counts** come from `firstFitChanges`, `store.svelte.js:1347`.
- Settings said "chapters are not marked". It now says what happens
  (`src/lib/SettingsModal.svelte:609`, `:616`).

**"New line breaks" in the app.** The file does not hold how a box's lines
broke. The app asks the engine that measured before the switch, once, when it
notes the boxes (`linesBefore`, `store.svelte.js:1275`). In the app that is
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
is refused: `src/lib/fonts.js:805` ("is a built-in font") and `:753` for a
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
| `src/lib/first-fit.test.js` | unit | 18 | the real store and switch on two stand-in engines that disagree by a known amount |
| `src/lib/first-fit.engine.test.js` | engine | 5 | the real library over node's filesystem, the wasm, fixture fonts; reads the file's bytes |
| `src/lib/EngineNotice.dom.test.js` | dom | 8 | the notice and the review list, mounted |

Mutations were run in a scratch copy under `node_modules/.cache/p9/mut`
(measured on the final sources, `372e8c82`; 21 of 21 fail at least one test):

| | mutation | tests failed | files |
|---|---|---|---|
| M1 | a grow-only relayout schedules a write under the Rust engine (defect A1) | 3 | unit, engine |
| M2 | leaving writes an untouched first-fit chapter (defect A2) | 3 | unit, engine |
| M3 | the switch going off does not put the boxes back | 2 | unit |
| M4 | a save under the Rust engine does not stamp 2 | 8 | unit, engine, dom |
| M5 | a save under the browser leaves a 2 a 2 | 3 | unit, engine |
| M6 | a load notes nothing | 19 | unit, engine, dom |
| M7 | the switch coming on over an open chapter notes nothing | 2 | unit, dom |
| M8 | Keep does not save | 5 | unit, engine, dom |
| M9 | moved lines are never noted | 9 | unit, dom |
| M10 | the review list does not hold boxes whose lines moved | 3 | unit, dom |
| M11 | an edited box is still listed as moved | 1 | unit |
| M12 | a save does not count as kept | 4 | unit, dom |
| M13 | an edited chapter is put back too when the switch goes off | 11 | unit, engine, dom |
| M14 | a version 2 chapter is noted like a version 1 | 2 | unit, engine |
| M15 | the notice shows with nothing to say | 1 | dom |
| M16 | an answered notice still counts | 5 | unit, dom |
| M17 | the saver writes the version it read | 3 | engine |
| M18 | nobody answers how the lines broke before | 7 | unit, dom |
| M19 | the note for moved lines is a flag (`reviewOf` answers with it) | 1 | unit |
| M20 | the open changes a width | 4 | unit, engine |
| M21 | a chapter with no boxes is not noted, so leaving writes it | 1 | unit |

## 8. The browser check

```
node scripts/text-port/p9-check.mjs --data <tp-data> [--out <dir>] [--chapter <stem>]
```

`p9-check.html` and `src/test/p9-check/host.js`: a dev-only page with the
editor's canvas and the real text queue on the real store, switch and wasm.
The driver starts its own Vite on port 5205 and Chromium with DevTools port
9383, and stops both (measured: nothing listening on either port after).

Run on the copy `tsukimichi__122` (366 boxes, 104 of the user's font faces).
Measured:

| step | result |
|---|---|
| switch off, chapter open | no notice, nothing noted |
| switch on over the open chapter | notice: 10 boxes with new line breaks, 6 grew. Not unsaved; 0 saves after 1.1 s |
| switch off again | every box's rectangle, size and flag as before; no notice; 0 saves |
| switch on, opened from the file | notice: 10 new line breaks, 19 newly flagged, 160 grew. Not unsaved; 0 saves after 1.1 s |
| leaving untouched | 0 saves |
| Show first | goes to page 2 and selects a box |
| review list | 29 rows: 19 flagged and 10 "Line breaks changed with the new text engine" |
| Keep | 1 save, version 2; notice gone; list back to 19 |
| kept chapter opened again | no notice, version 2 |
| kept chapter under the browser, then leaving | no notice; 1 more save, version 1 |

16 of 16 checks pass; 0 page errors. The load took 117 ms with the noting,
72 ms for the version 2 chapter, 303 ms under the browser (one run each; a
second run gave 201, 122 and 249).

Pictures: `tp-data/reports/p9/check/3-opened-window.png` (the window, notice
at the top of the queue), `4-review-list.png` (the list opened), and five
more. I looked at both: the notice reads as designed and the list's new rows
carry the reason.

Two limits of this check. The page has no filesystem, so its saver stamps as
the app's does and counts; the real file is the engine test's business. And
the browser here is Chromium with no system fonts, so its last resort is one
of the user's fonts and its counts are not the desktop app's.

## 9. Choices this brief did not make

1. **The version is written by a save, by the engine measuring then.** Rust:
   2. Browser: a 2 becomes 1, any other number stays. So the number is always
   "who last fitted what is in the file".
2. **A grow-only relayout never schedules a write while the switch is on.**
   Not only on a first fit: for a version 2 chapter too. The height is worked
   out again at every open and reaches disk with the next save.
3. **An unedited, unkept version 1 chapter is not written on leaving** with
   the switch on. Under the browser leaving still writes, as before.
4. **The switch going off restores the boxes** of an unedited, unkept
   chapter. An edited or kept one stays as it is.
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
10. **`kept` is set when the saver takes its snapshot**, not when the write
    lands. A failed write leaves the save indicator red and leaving retries.
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
  (`src/lib/fonts.js:753`, `:805`). It belongs with removing the built-in
  list (cut-over). Until then the five families of section 6 stay in the
  last resort.
- The mutations were not run against the dry-run tool, only against the
  app's code.
- No count of solver stamps moved by a grown height. They are restored with
  the heights.

## 11. Exactly what is written to the user's files, and when

With the switch **off**: nothing changes from before this phase, except that
a chapter at version 2 is saved as version 1.

With the switch **on**, for a chapter at version 1:

| moment | written |
|---|---|
| opening | nothing |
| a font arriving after the open | nothing |
| leaving without an edit | nothing |
| turning the switch off without an edit | nothing; the boxes go back in memory |
| the first save an edit causes (800 ms after it, or on leaving) | `chapter.json`, whole, as every save: the edit, every grown `h` and its `y`, every `review` raised or cleared, `typesetting.version: 2`. And `translations.json`, which every save derives from it |
| Keep on the notice | the same two files, the same contents, without an edit |
| a load that mints ids or repairs pages | as before this phase: the repair is saved, and it carries the above |

With the switch on, for a chapter at version 2: as before this phase, except
that a font arriving late no longer schedules a save.

Never written: which boxes had their lines moved; that the notice was seen;
any new field. No file under the chapter's folder changes by opening, by a
late font, by waiting or by leaving (measured: the engine test digests every
file in the folder). Keep changes exactly `chapter.json` and
`translations.json` (measured, same test); the page images and every other
file keep their bytes.

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
| this report's commit | `text-engine/P9-REPORT.md` |
