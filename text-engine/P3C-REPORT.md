# P3c report: a letter the chosen font lacks is drawn in a system font that has it

Branch `tp/fonts`, on top of `5d73134`. Commits are listed in section 10. None
is pushed. None has a trailer. No font file was added. Nothing was copied out
of `tp-data`.

**[M]** is a number measured in this work, on this Mac (macOS 27.0, 432
installed families). **[I]** is inferred.

The machine was loaded while the proofs ran (load average 50 to 100, two other
workers and the coordinator's captures). Timings were taken twice where it
says so: once quiet, once loaded.

## 1. Results

| check | how it was run | result |
|---|---|---|
| default-lane capture | `node scripts/text-port/capture-node.mjs --data /Users/caved/dev/manga-typesetter-wt/tp-data --run p3c-sk-check`, at `a7d9864`, clean tree (manifest `dirty: false`) | [M] 64,718 metrics, 17,538 layout, 3,732 pixels, 7,856 skipped, 0 errors. `cmp` of `metrics.jsonl`, `layout.jsonl`, `pixels.jsonl` against `runs/ref-sk/base`: identical. `diff -rq base/png p3c-sk-check/png`: identical (3,401 PNGs) |
| Rust-lane capture | the same with `--engine new --run p3c-new-check`, at `a7d9864`, clean tree | [M] 64,718 / 17,538 / 3,732, 0 skipped, 0 errors, wasm `68fe845b…9b806`. The three `.jsonl` and all 3,732 PNGs identical to `runs/new/r3` |
| `./node_modules/.bin/vitest run`, whole suite | from the worktree root | [M] run twice, at load average 60 to 100. Both times: 110 files passed, 2 failed, 1 skipped; 3,172 tests passed, 3 failed, 7 skipped. The 3 are time limits, in two files I did not touch: `src/test/text-port/compare/cli.test.js` (2 tests, 5 s limit, took 5.0 to 6.8 s) and `src/lib/solver-perf.realfont.test.js` (`changes no answer`, 60 s limit, took 66 and 88 s). Each file run alone right after, same load: `solver-perf` 2 passed in 41 s, the `compare` folder 64 of 64 passed. No clean whole-suite run was had on this machine today |
| `cargo test` in `src-tauri` | `CARGO_TARGET_DIR=…/tp-fonts/src-tauri/target cargo test` | [M] 299 passed, 0 failed, 1 ignored (the measurement). 285 before; the 14 new are in `font_coverage` |
| `cargo clippy --all-targets -- -D warnings` | same target dir | [M] fails on the two `unnecessary_map_or` in `src/brush/score.rs` (lines 92 and 106), as before this branch. Nothing else. With `-A clippy::unnecessary_map_or` added: clean, exit 0 |
| `npm run build` | from the worktree root | [M] built, exit 0; `dist/assets/mt_text-*.wasm` is 1,541,316 bytes |
| mutation run | each of 10 lines of the new wiring taken out in turn, the four new unit test files run each time | [M] every one of the 10 fails tests (section 6) |

Both check runs were deleted after the comparison.

Everything after `a7d9864` is one JavaScript test file, 12 lines inside a
Rust test, `RULES.md` and this report (`git diff --stat a7d9864 HEAD`). No
file the captures load changed after the captures were taken.

## 2. What was built

### Native: which installed family has a letter

`src-tauri/src/font_coverage.rs`, new. Command
`system_font_coverage(codePoints)`.

- It takes code points and nothing else. No path, no family name.
- It answers `{ families: [{ name, order, codePoints }], none: [...] }`. Each
  code point is in exactly one place. `order` is the sort key of the rule.
- It runs on a blocking thread (`spawn_blocking`), not on the main thread.
- A question of more than 1,024 code points is refused with an error. An
  empty question reads nothing.
- A number that is no Unicode scalar goes to `none`.
- It reads the `cmap` table only: the table directory, then that one table,
  by seeking. A table over 16 MiB is not read.
- `cmap` formats 0, 4, 6, 10, 12 and 13. A letter that maps to glyph 0 is not
  counted as had.
- A file gone or changed since the scan is not offered. This is checked with
  a `stat` at every answer.
- A face with an `sbix`, `CBDT`, `SVG ` or `COLR` table is never offered.
- What was read is kept until the next scan. A new scan drops it all.

`src-tauri/src/system_fonts.rs`: one new method (`FaceFile::unchanged`), and
`index()`, `scan()` and the test helpers made visible inside the crate. The
scan itself is unchanged, line for line.

### The adapter

`src/lib/text-engine/rust.js`: `missing(face, text, depth)`. `depth` 0 asks
the face alone, 1 asks the face and the first family of the chain. Without
`depth` it is what it was. Chains are kept per length, so this builds no new
handle on each call.

### The font sync

`src/lib/text-engine/font-sync.js`.

- `lettersOf(face, text)` answers `{ borrowed: [{ family, letters }], none,
  pending }`. Calling it is what asks.
- A letter is asked about once. Its state is one of: asking, no font has it,
  or the family that has it.
- A family named in an answer is sent for the way `startSystem` sends for
  any system family. When it is in, the chain is rebuilt and the store is
  told (`landed`), so the boxes are measured again.
- `fallbackChain()` is the last resort, then the families found, in the
  rule's order.
- A question that fails is remembered as "no font has these". It is not
  asked again until the next scan.
- A family that cannot be read is remembered the same way.
- A scan forgets every answer. A font may have been installed or removed.
- A question longer than 1,024 code points is split.
- Turning the switch off drops all of it. An answer that lands afterwards
  changes nothing.

### The switch and the store

`src/lib/engine-switch.svelte.js`: `lettersOf(style, text)` (kept per face
and text, so a box asks the engine once), `boxesBorrowingLetters(pages)` for
the notice, `fontsSettled(pages)` for export.

`src/lib/store.svelte.js`: the gate that holds a fit while a face is arriving
now also holds it while a letter of the box's text is being looked for or its
family is being read. It is one function, `faceArriving(style, text)`. Every
place that asked "is the face ready" asks it. `fontsSettling(pages)` is the
store's door for export.

### The notice

`src/lib/FontNotice.svelte`. One line a box:

- `♥ drawn in Hiragino Sans · 한 drawn in Apple SD Gothic Neo`
- `no installed font has ☃ ⛄`
- `no loaded font has あ` in a plain browser, where nobody could be asked.

Six letters are shown, then ` …`. A letter still being looked for is not
listed. A letter the last resort draws is listed too, with the last resort's
name: it is also not the font the user chose.

### Export

`src/lib/exporter.js`, one place: two lines in `exportImages`, right after
`await document.fonts.ready` (line 1235), and one name added to the import
line. `exportImages` is the one entry of every export that draws text: a
page, the chapter and strip slices in PNG, JPG and WebP, and a PSD. A
longstrip waits for the whole chapter, because a slice paints its
neighbours' lettering.

Not gated, on purpose: the JSON text export draws no text. Library thumbnails
are the page picture, not lettering.

With the browser measuring, `fontsSettling` returns `null` and nothing is
awaited.

## 3. The rule

In full: `text-engine/RULES.md`, rule 11. In five lines:

1. The face has the letter: the face draws it.
2. Else the last resort has it: the last resort draws it, nobody is asked.
3. Else the first installed family that has it draws it. The order is this
   OS's short list as written, then every other family by lower-cased name,
   then by the name itself.
4. A colour or bitmap face (`sbix`, `CBDT`, `SVG `, `COLR`) is never used.
5. No installed family has it: it stays the face's empty box, and the notice
   says so.

Each letter is answered by itself. The engine's list is sorted by the rule's
order, not by the order families arrived in.

The macOS list [M] is CoreText's own default cascade list for Helvetica Neue,
cut down: Helvetica, Lucida Grande, Hiragino Sans, Hiragino Sans GB, PingFang
SC, PingFang TC, PingFang HK, Apple SD Gothic Neo, Menlo, Apple Symbols, STIX
Two Math. The Windows and Linux lists are [I], not read off a machine.

### Colour emoji

What the engine does today with an `sbix` face [M, Apple Color Emoji,
192,120,460 bytes, handed to the engine directly]: U+1F600 is not reported
missing. Its advance is one em (40 at 40 px). Its ink box is empty. 0 pixels
are painted.

So a colour face would turn an empty box that says "missing" into an
invisible letter that says nothing. The rule leaves such faces out. An emoji
goes to an outline family that has it, or is reported as a letter no
installed font has. On this Mac U+1F600 is reported: no outline family has
it [M].

`COLR`: not measured. No `COLR` face is installed here [M]. [I] Its base
glyphs are ordinary outlines; some fonts leave them empty.

Colour glyph drawing is not built.

## 4. Measured numbers

### When to read coverage: at the scan, or when asked

`cargo test --lib measure_this_machine -- --ignored --nocapture` in
`src-tauri`. 432 installed families [M].

| | quiet [M] | loaded [M] |
|---|---|---|
| the scan as it is | 118 to 125 ms | 265 ms |
| A: every family's `cmap` read at the scan | +17 to 19 ms | +66 ms (39 ms the second time) |
| A: what it holds | 275,620 ranges, 2,153 KB | the same |
| B: first answer, kana | 0.55 ms, 3 families read | 1.27 ms |
| B: first answer, kana + kanji + Hangul + symbols | 1.0 ms, 8 families read | 1.67 ms |
| B: first answer, a letter nothing has | 18 to 19 ms, 432 families read | 61 ms |
| B: the same question again | 17 to 38 µs | 64 to 66 µs |
| B: a letter nothing has, again | about 2 ms (432 files re-checked) | 4.5 ms |

4 families cannot be read (no Unicode `cmap`). One picture face: Apple Color
Emoji. The family with most ranges: Hiragino Kaku Gothic ProN, 5,378.

**Chosen: B, read when asked, kept until the next scan.** A adds about 15% to
a scan that also runs in default mode, which the brief forbids. B adds
nothing to the scan. Its common answer is under 2 ms and off the main thread.
Its worst answer costs what A costs, once.

### The rule beside CoreText

[M] 23 sample letters Helvetica Neue lacks (kana, kanji, Hangul, hearts,
stars, arrows, notes, a check mark, shapes, an emoji), against
`CTFontCreateForString`: the rule names CoreText's family for 22. The one
that differs is the emoji (the rule: none; CoreText: Apple Color Emoji).

### The user's chapters

[M] The corpus's 2,298 chapter boxes, the 108 loaded faces, the real wasm,
the real font sync, the answer the real command gives on this Mac. Run by a
scratch script that is not in the repository. Numbers only.

| | before | with the rule |
|---|---|---|
| boxes whose face lacks a letter | 28 | 28 |
| of those, the last resort draws it | 16 | 16 |
| of those, an installed family draws it | 0 | 12 |
| of those, an empty box | 12 | 0 |
| distinct letters asked about | | 7 |
| questions sent | | 6 |
| families read | | 2 (Lucida Grande, Hiragino Sans) |

The brief says 30 boxes. The corpus tags 30 as uncovered. 2 of them lack only
U+00A0 or U+000A in their `cmap`, which the engine does not report as missing
[M]. So 28.

The native answer for the 7 letters took 0.73 ms, 3 families read [M,
loaded]. Looking at all 2,298 boxes took 132 to 164 ms the first time and 43
to 51 ms the second, without the switch's memo [M].

## 5. Chosen differently from the brief

1. **The chain is sorted by the rule, not appended to.** The brief says
   "append it to the chain after it is in". Rule 10 takes a letter from the
   first family of the list that has it. With arrival order, the family that
   draws a kanji would depend on which page was opened first. Test: `the
   chain > is in the native side's order, whichever family was asked for
   first`.
2. **A letter is asked about even when a family already on the chain has
   it.** The question is what the face and the last resort lack (`missing`
   with depth 1), not what the whole chain lacks. Same reason. Test: `asks
   about a letter another borrowed family happens to have, so its own family
   is in`. This is why the adapter got `depth`.
3. **One question a new letter, not one a distinct set.** A letter is asked
   about at most once between two scans, whatever set it comes in. This is
   stricter than the brief. On the chapters: 7 letters, 6 questions [M].
4. **No emoji family on the list.** Section 3.
5. **The chain is per engine**, as the brief proposed. Which family a letter
   comes from is a property of the letter, not of the face that lacks it.
   Nothing found against it.

## 6. The proofs, one by one

Unit tests on the stand-in engine. Run with
`./node_modules/.bin/vitest run <file>`.

| file | tests | what |
|---|---|---|
| `src/lib/text-engine/font-sync-letters.test.js` | 18 | the wiring, one question, failure memory, the chain's order, a scan, dispose |
| `src/lib/engine-switch-letters.test.js` | 18 | the gate on fits, off while arriving, what the notice is told, what an export waits for |
| `src/lib/exporter-fonts-gate.test.js` | 7 | PNG, JPG, WebP, PSD, longstrip: nothing painted or written before the gate opens; default mode waits for nothing; a failed wait is a failed export |
| `src/lib/FontNotice-letters.dom.test.js` | 6 | the notice's lines, mounted |
| `src/lib/FontNotice-cost.dom.test.js` | P3b's, unchanged | still passes |

Real engine, fixture fonts, no font added. Run the same way.

| file | tests | what |
|---|---|---|
| `src/lib/text-engine/font-fallback.engine.test.js` | 7 | Comic Neue and Bangers as loaded faces, DejaVu Sans as the installed family. The advance of a mixed line is the sum of its parts in each font, to 1e-9. The heart's ink is DejaVu's. The painted bytes are DejaVu's. A line the face covers is bit for bit what it was. An astral letter. A letter nothing has stays the face's `.notdef`. `wrapPlain` breaks by the borrowed widths |
| `src/lib/engine-switch-letters.engine.test.js` | 2 | the same through the switch, the store, `fonts.js` and `measure.js`: the box is not written from while it waits, the export gate stays shut, then `lineWidth` gives DejaVu's heart and the box is fitted to it |

The coverage answer in both is read out of the fixture's `cmap` by the
harness's own reader (`scripts/text-port/lib/cmap.mjs`), not typed in.

Native, `cargo test --lib font_coverage` in `src-tauri`: 14 tests.

| the brief asks | test |
|---|---|
| odd family names | `odd_family_names_are_names_like_any_other` |
| a file gone since the scan | `a_file_gone_or_changed_since_the_scan_is_not_offered` |
| a code point no font has, astral | `a_letter_nothing_has_an_astral_one_and_a_number_that_is_no_letter` |
| an empty list, a very long list | `an_empty_question_reads_nothing_and_a_long_one_is_refused` (1,024 taken, 1,025 refused) |
| the same every time | `a_letter_s_answer_does_not_depend_on_what_else_was_asked_or_in_what_order` |
| the order | `each_letter_goes_to_the_first_family_in_the_order_that_has_it`, `the_families_the_os_itself_falls_back_to_come_first` |
| colour faces | `a_face_that_draws_pictures_is_never_offered` |
| the reader | four tests: against the harness's reader on the fixtures (DejaVu Sans 5,906 letters), a collection, every `cmap` format, a `cmap` cut short at every length |
| one face judges a family, read once a scan | `a_family_is_judged_by_its_regular_face_and_read_once_a_scan` |
| this machine | `on_this_machine_the_kana_come_from_the_family_the_os_uses` |

Mutation run [M]. Ten lines of the new wiring were taken out one at a time
and the four unit files run. All ten fail tests: 11, 3, 7, (loop), 4, (loop),
5, 1, 1 and 3 tests. The two marked "loop" are the failure memory and the
one-question rule: without them the tests do not end, which is the defect
they guard. The export gate taken out: 6 of 7 fail. The letters gate taken
out of the switch: the real-engine switch test fails.

## 7. What was not run

- **The app.** I cannot drive the Tauri window. Nothing here was seen in the
  desktop app or in a real webview.
- **`system_font_coverage` through real Tauri IPC.** The Rust side and the
  JavaScript side are each tested against the same answer shape
  (`{ families: [{ name, order, codePoints }], none }`, pinned on the Rust
  side by a `serde_json` assertion). The argument name `codePoints` going
  through `invoke` was not run.
- **Windows and Linux.** Their lists are inferred. The Rust tests ran on this
  Mac only.
- **A `COLR` face.** None is installed here.
- **A cold disk.** Every timing above had the font files in the OS cache or
  close to it.

## 8. What only the desktop app can show

- That `invoke('system_font_coverage', { codePoints })` reaches the command
  and its answer comes back in the shape the tests use.
- That a chapter with kana or hearts in a lettering font shows them, in the
  editor and in an exported PNG, in the family the notice names.
- How long the wait is when a page is first opened: the question, then the
  family's file over the bridge (the Hiragino Sans file is 7.2 MB, Lucida
  Grande's 3.2 MB [M]). Whether the box visibly changes when the family
  lands.
- That an export started at once after opening a chapter waits and then
  writes the borrowed letters.
- That startup in default mode is not slower. By construction nothing new
  runs there (no new work in the scan, the command is never called, the
  export gate is `null`), and the default-lane capture is byte-identical. A
  stopwatch on the real app was not run.
- Memory in a long session: borrowed families stay in the engine until the
  switch goes off or the fonts are scanned again.

## 9. Chosen not to fix

- **The notice can name another family than the one that drew the letter**,
  in one case: two borrowed letters side by side, where rule 10 keeps the
  second in the first one's family. Counted on the chapters: 1 box has two
  such letters side by side, 0 boxes differ [M, by walking the text with
  rule 10's words, not read out of the engine]. An exact answer needs the
  wasm to report the font of each part. I left the wasm alone so the `new`
  capture stays byte-identical.
- **A family is judged by its regular face.** A bold face may lack what the
  regular has. Then the letter goes to the next family, or is `.notdef`, and
  the notice still names the first.
- **Fonts the user loaded are not lent from.** Only installed families. A
  browser does the same.
- **Borrowed families stay loaded** until the switch goes off or a scan.
- **`fontsSettled` gives up after 12 rounds** of waiting and lets the export
  run. Each round waits for everything then on its way. A family that
  lands can show a letter it lacks, which is one more round; the rest is
  room. Not reached in any test.
- **A scan forgets every letter**, so every box with a borrowed letter is
  asked about again and fitted again after a scan.
- **The two clippy lints** in `src/brush/score.rs`. Not my file.
- **`cargo fmt`**: the crate is not formatted with it today, and I did not
  run it over my file alone.

## 10. Commits

On `tp/fonts`, oldest first, on top of `5d73134`:

| hash | subject |
|---|---|
| `b30ed1e` | feat(fonts): the native side says which installed family has a letter, by one fixed order |
| `5dd98ba` | feat(text): the adapter says what a face lacks before the n-th fallback family is asked |
| `605684c` | feat(fonts): a letter the face lacks is asked about once, and its family joins the chain in a fixed order |
| `622e901` | feat(fonts): a box waits for the family a letter of its text is borrowed from |
| `b7291c1` | feat(export): every export waits for the fonts its pages need |
| `7bdb160` | feat(fonts): the notice says which letters are drawn in which family, and which no installed font has |
| `a7d9864` | test(fonts): a borrowed letter on the real engine: the advance, the ink and the picture are the lending font's |
| `9fd10c9` | test(fonts): a borrowed letter through the switch and the store on the real engine: the box waits, then is fitted by the lending font's widths |
| `127547e` | test(fonts): the machine measurement also answers a file of code points, as the command would send it |
| `f433e92` | docs(text): rule 11, which family a letter is borrowed from |
| (the next) | docs(text): the P3c report |

## 11. For whoever merges

- `src/lib/exporter.js`: the import line and ten lines in `exportImages`
  after `await document.fonts.ready`. Nothing in `layoutBox`.
- `src/lib/store.svelte.js`: `faceArriving` takes the text; `boxFaceArriving`
  and `faceReady` beside it; the call sites that asked about a face;
  `fontsSettling` at the font source.
- `src/lib/engine-switch.svelte.js`: `systemCoverage` in the sync's options,
  `starting`, the `lettersMemo` clears, the font source's `lettersReady` and
  `settle`, and the functions from `lettersOf` to `fontsSettled`.
- Not touched: `text-engine/src/`, `text-engine/js/`, `TextBox.svelte`,
  `src/lib/editor/`, `rust-painter.js`. The wasm is the same build.
