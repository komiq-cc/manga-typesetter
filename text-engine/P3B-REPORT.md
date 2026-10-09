# P3b report: the review's fifteen findings

Branch `tp/fonts`, on top of the merge of `text-port` at `56e99c7`. Thirteen
commits, none pushed, none with a trailer. Every item has a test that fails
without its fix; where that was checked by taking the fix back out (a mutation
run), it says so.

## Results

| check | result |
|---|---|
| `vitest run`, whole suite | 99 files passed, 1 skipped; 2,923 tests passed, 7 skipped |
| `cargo test` in `src-tauri` | 285 passed, 0 failed (274 before) |
| `cargo clippy --all-targets -- -D warnings` | fails on two `unnecessary_map_or` in `src/brush/score.rs`, a file this branch does not touch (no diff against the merge base). Nothing reported in `system_fonts.rs` or `font_decode.rs` |
| `npm run build` with the wasm | built; `dist/assets/mt_text-*.wasm` present |
| `npm run build` without the wasm | built; no wasm in `dist` (file moved aside, then put back and rebuilt) |
| default-mode capture `--run p3b-check` | `metrics.jsonl` (64,718 lines), `layout.jsonl` (17,538), `pixels.jsonl` (3,732) and all 3,401 PNGs byte-identical to `runs/ref-sk/base`; the run was deleted afterwards |

The first whole-suite run had one failure, in a file that is not mine and that
I did not touch: `src/test/text-port/compare/cli.test.js` timed out at 5 s
(it took 6.9 s) while the machine's load average was 49. Run alone it passed
(82 of 82 in that folder), and the second whole-suite run, at load 10, is the
row above.

## What was not run

- The app. I cannot drive the Tauri window, so nothing here was seen in the
  desktop app or in a real webview.
- The version 2 answer of `system_font_face` through real Tauri IPC, and the
  new `known` argument through `invoke`. Both sides are tested against the
  same byte layout, each on its own.
- Windows and Linux. The Rust tests that read real system fonts ran on this
  Mac only (they read the real Helvetica Neue collection here).
- The `engine` test lane without the wasm.

## The items

### 1. A WOFF could declare any output size (P1) - `814ee20`

Cause: `wuff` allocates a WOFF1 table with `Vec::with_capacity(origLength)`
straight from the header, so twelve bytes of header could ask for 4 GB. WOFF2
was already bounded inside `wuff`; WOFF1 was not.

Change (`src-tauri/src/font_decode.rs`): the header is read before anything is
decoded. The limit is fixed and stated, `MAX_FONT_BYTES` = 128 MiB, applied to
the input, to WOFF1's `totalSfntSize` and the sum of `origLength`, to WOFF2's
`totalSfntSize` and the sum of the transformed lengths, and to the output. The
plausibility rule is deflate's real ceiling: a table cannot inflate to more
than 1,032 times its compressed length, and its compressed bytes must lie
inside the file. The decoder runs inside `catch_unwind`, so a panic is an error
string.

Tests: `refuses_a_header_that_declares_four_gigabytes_before_anything_is_decoded`,
`refuses_a_file_that_is_cut_short`, `refuses_a_table_whose_declared_length_is_a_lie`,
`a_decoder_that_panics_is_an_error_not_the_end_of_the_process`.

### 2. One usable face made the whole family ready (P1) - `fd13657`

Cause: `stateOf` answered `ready` as soon as any face of a user family was in,
while a bold or italic was still being decoded. A bold box was then measured,
and written, as the regular smeared.

Change (`src/lib/text-engine/font-sync.js`): readiness is "no face of this
family is still on its way". That is the second of the two rules you offered,
not per requested face, and the reason is that which face a style gets is the
engine's rule; a second copy of it in the sync could disagree with it. The
cost is that a regular box waits for a sibling's decode. While it waits the
family is shown as itself if it has a usable face.

Tests: three in `font-sync.test.js` (not ready while any face decodes; ready
again when that face turns out unreadable; a user-family last resort stays the
last resort meanwhile) and one on the real engine in
`engine-switch.engine.test.js`.

### 3. Placement went round the gate (P2) - `e9a152f`

Cause: `bornBox` called `balancedBoxSize` without asking whether the face had
arrived, so a new box was sized from the stand-in.

Change: `bornBox` now takes the block rectangle or the 220 x 92 constants,
marks the box `pending`, and it is solved when the face lands. `resizeBox`
holds its re-set the same way.

The audit you asked for. Every writer of `box.w/h/x/y`, `style.size`,
`box.auto`, `box.review` and `box.fit`, and every caller whose result is
stored, with what it does while the face is arriving:

| writer | while the face is arriving |
|---|---|
| `autoFitBox` | held; runs when the face lands |
| `refitBox`, `autoFitBoxTo`, `reviewBox`, `fitBoxNow` | do nothing |
| `bornBox` (the only stored use of `balancedBoxSize`) | block rectangle or the constants, `pending`, solved on landing |
| `solveBox` through `solvePending`, `resolveBox`, `bornBox` | all behind `faceReady` |
| `refitBalloon` | writes the rectangle from the balloon's own measurement, not from text; the text fit is held and its `refit` entry owes it |
| `resizeBox` | the user's rectangle is written; the re-set is held |
| `moveBoxTo`, nudge, paste, duplicate, rescale, `setBoxLocks`, `rememberSizeFor`, the Inspector's size field | no measurement, or the user's own value and then `boxEdited`, which is held |
| `holdInk` | not gated, and does not need to be: for empty text it is independent of the font; the `fitBoxNow` after it is gated |
| `growHeightTo`, `writeFit`, `writeReview` | reached only through the gated callers above |
| history `restoreFit`, `setFields` | put back recorded values; the `reviewBox` / `refitBox` after them are gated |
| `loadProjectPages` | `solvePending` and `refitPage`, both gated |
| `TextBox.svelte:857` (the effect) | `autoFitBoxTo` / `refitBox`, both gated |
| `TextBox.svelte:1015` (edge-drag floor) | **not gated.** `neededHeight(shaped.length, ...)` uses the line count on screen, which is the stand-in's while a face arrives, to clamp how short the user can drag. The file is not mine to edit in this task |
| `exporter.js`, `psd.js` (`placeBlock`) | output, not the document. An export started while a face arrives is not blocked and would be laid out in the stand-in |
| `auto-layout.js`, `contain.js`, `balancedBlockSize`, `neededHeight` | pure; their results reach the document only through the rows above |

### 4. The late fit ran after the history record (P2) - `e9a152f`

Cause: the fit that was held ran on arrival, after the edit's entry had been
recorded with the unfitted box as its "after".

Change: an entry recorded while a box is held is tagged `fitOwed`. When the fit
lands, the latest entry for that box has its after side corrected, on the live
stack or, for a page that is not on screen, in the stored stack through the
history file. After any undo or redo, if the entry now on top for that box
still owes, the box is fitted there and both entries are corrected; otherwise a
held fit is dropped. No new undo step is ever made. With the browser engine
nothing is held and nothing is tagged.

Tests: `src/lib/editor/history-owed-fit.test.js`, ten cases: edit, arrival,
undo, redo; undone before the face came; redone while it is still coming; two
edits; a move made meanwhile; a width drag; placement at the constants; typing
into a pending box; an off-screen page; nothing marked with no font source.
One more on the real engine, for a system family whose file is still being read.

Known limit: undoing to a state whose "before" was itself recorded before the
face landed restores it as recorded. It is flagged for review, not grown, until
the next font event or reopen.

### 5. The cached path was read unchecked (P2) - `ef0897f`

Cause: `system_font_face` read whatever was at the scan's path, of any size.

Change (`src-tauri/src/system_fonts.rs`): the scan records each chosen file's
length and modification time. Before anything is sent the file must still have
both, be no larger than `MAX_FILE_BYTES` (128 MiB), and parse as a font with a
face at every index the header gives, one of them of the family asked for. The
limit comes from this Mac: the largest text collection is Kaiti.ttc at 101 MB;
Apple Color Emoji at 183 MB is refused.

Wire form: unchanged by this item. New error strings only.

Tests: `a_file_that_went_or_changed_since_the_scan_is_an_error_for_its_family`,
`a_file_swapped_behind_the_same_length_and_date_is_found_by_reading_it` (a temp
file swapped at the same length and date), `a_file_over_the_limit_is_refused_without_being_read`.

### 6. A rescan kept every loaded family with its old bytes (P2) - `154bc21`

Cause: `followSystemList` kept any family that was still listed, so a bold
installed later, or a font updated in place, was never read.

Change: the scan sends a fingerprint per family. The sync remembers the
fingerprint and the set of faces a family was read under; a list that
disagrees forgets the family, and it is sent for again the next time it is
asked about. The last resort is sent for at once, because no box need name it.
What the engine held stays until the new bytes replace it, so nothing is
measured as nothing in between.

Wire form, `system_fonts` (JSON): each entry gains one field.

```
{ "name": "Helvetica Neue",
  "faces": { "regular": true, "bold": true, "italic": true, "boldItalic": true },
  "stamp": "9f2c41d07ab3e615" }
```

(The value shown is made up, to show the shape.)

`stamp` is sixteen lowercase hex digits: a 64-bit hash over each slot's path,
face index, length and modification time. No part of a path is in it. It means
something only between two scans of one run of the app.

Tests: Rust `a_family_s_stamp_moves_when_its_files_do_and_only_then`; eight in
`font-sync.test.js` under "after another scan". Taking the comparison out fails
five of them.

### 7. A failed save kept the file in memory with nobody watching (P2) - `b268ba0`

Cause: `unsavedFaces` kept the buffer for the whole session in every session.

Change (`src/lib/fonts.js`): the bytes are kept only while a watcher is
installed and given back when it goes. A face left without bytes is listed by
`loadedFaceRecords` with `data: null`; the sync takes it as the user's and
unusable, reason `unsaved`, and the notice says so.

Two things to know:

- The notice says "remove it and add the file again", not "add again",
  because `addFontFile` refuses a file whose name the slot already has, and
  changing that would change default-mode behaviour.
- The engine-switch tests had been relying on the defect: plain Node has no
  IndexedDB, so every save in them failed and the bytes came from
  `unsavedFaces`. They now get a stand-in library (`src/test/fake-indexeddb.js`,
  moved out of the watch test).

Tests, both orders, in `engine-switch.test.js`: "added before the switch is on"
(missing, reason `unsaved`, fine after remove and add) and "added with the
switch on" (usable at once, lost after off and on). Two more for the last
resort and for a family with one face lost. Putting the old behaviour back
fails three of the watch tests (item 13).

### 8. Off kept the wasm instance (P2) - `4fd0e1f`

Cause: off emptied the engine and kept the instance, and a wasm memory never
shrinks.

Change (`src/lib/engine-switch.svelte.js`): the compiled `WebAssembly.Module`
is kept for the session; an instance is made from it each time the switch goes
on. Off calls a small `dispose()` that drops the instance and the
missing-letters memo that pointed at it. An instance finished after the switch
was turned off again is assigned nowhere. `dispose()` is where the painter can
be let go.

Tests: on the stand-in, one compile and two engines for two turns, and a
compile that failed is tried again. On the real wasm, the first instance's
memory is unreachable after off (asked of the garbage collector), the second
on gets the same `Module`, and `compile` ran once. Taking `dispose()` out of
the off path fails it.

### 9. A collection was shared inside one family only (P2) - `4003318`

Cause: the file had no identity on the frontend, so two families in one `.ttc`
were two copies in the engine.

Change: the native side names the file. The adapter (`rust.js`) keeps which
engine fonts were read from which named file, makes a second family's faces
beside the ones it has (`mt_font_add_sibling`), and lets the file go with the
last of them. That set is the reference count.

Where I departed from your wording: the frontend does not ask a separate
question first. The one call carries the ids the engine already holds, and the
answer for one of those is the header alone. It is one round trip instead of
two, and the native side still reads and checks the file before saying "you
have it", so item 5's guarantee holds for the second family too.

Wire form, `system_font_face`. Request: `{ family, slot, known }`, where
`known` is an optional array of file ids as sixteen hex digits. Response, all
numbers little-endian:

```
offset  type      meaning
 0      u32       version of this layout: 2
 4      i32 x 4   per slot, in the order regular, bold, italic, boldItalic:
                  the index of that slot's face inside this file, or -1
20      u8 x 8    the file's id, opaque (a hash of path, length and date,
                  big-endian, so its hex is the string sent back in `known`)
28      u64       the file's length in bytes
36      u32       flags; bit 0 set: the file follows, all of it
40      ...       the file, when bit 0 is set; nothing otherwise
```

Version 1 was sixteen bytes, the four `i32` alone, then the file. The frontend
refuses any version it does not know rather than reading a font at the wrong
offset.

Three edges handled, each with a test:

- The family a file was held for goes while the answer is on its way: the sync
  asks again saying nothing is held.
- Two families asked for at the same moment both get the file; the engine
  keeps one copy.
- A family read again after its files moved gets its new faces in before the
  old ones go, so a file it keeps is held through the change.

Tests: Rust `the_answer_is_laid_out_as_the_frontend_reads_it` (byte by byte),
`two_families_in_one_file_are_told_so_and_the_second_is_not_sent_it_again`,
`a_file_the_caller_holds_is_still_checked_and_its_id_moves_when_it_does`; six
on the stand-in; two on the real wasm, where three families of one collection
hold little more heap than one and the heap comes back when the last goes.
Three mutation runs each failed the tests they should.

### 10. The missing-letters memo left out capitals (P2) - `e5e7907`

Cause: the key was family, weight, slant and the raw string; the engine was
asked about the string after the capitals setting was applied.

Change: the setting is in the key. Size is deliberately not: a glyph is there
or not at every size.

Test: `ÿ` in lower case is a letter the stand-in has, its capital `Ÿ` is not.
Failed before the change.

### 11. The resolution cache was unbounded (P3) - `afefa47`

Change: 256 names, emptied when full. Forgetting changes no answer and sends
for nothing twice, because what was sent for is remembered elsewhere.

Test: 5,000 names, then the same answers and no second request. Failed at
5,000 before.

### 12. The raw-body test could not fail (P3) - `63c356c`

Change (`src/test/fake-rust-engine.js`): the stand-in keeps the argument it was
given and refuses anything that is not a `Uint8Array` or `ArrayBuffer`, in the
real command's words. Wrapping the bytes in an object in `engine-switch.svelte.js`
now fails the test (checked).

### 13. "Nothing is kept" checked only notifications (P3) - in `b268ba0`

Change (`src/lib/fonts-watch.test.js`): the tests ask the garbage collector.
The font's bytes are made when the file is read and held by the test only
through a `WeakRef`; after a collection they are either reachable or not. This
covers item 7's failed-save case in both directions. The collector is switched
on at run time (`v8.setFlagsFromString('--expose-gc')`), so no test config
changed. Three runs in a row gave the same result.

### 14. The notice's cost - `1ca9b83`

No defect found. `missingFonts(pages)` subscribes to: the pages array and each
page's boxes array (so a box or page coming or going), each box's `style` and
`style.font`, and then either the font lists (browser) or `app.fontsVersion`
(Rust engine). It reads nothing else of a box, so a keystroke, a move, a
resize or any other style change does not re-run it.

Test: `src/lib/FontNotice-cost.dom.test.js` mounts the component and counts the
calls: zero for typing (three ways), moving, resizing and restyling; one for a
font change, a box deleted, a font loaded. Making the walk read `text` and `x`
fails three of the five.

One thing the test does not cover, by design from P3a: with the Rust engine on,
the other list (letters no face has) reads every box's text and so is made
again on a keystroke. The engine is asked only about strings it has not seen;
the rest is one map lookup per box.

### 15. On, with no font to measure with - `cb830e9`

Cause: in that state no engine is installed and the phase is still `'on'`. The
font sync then answers "missing" for every name, and the notice passed that on:
every family of the chapter, built-ins included, listed as not on this
computer.

Change: `engineHasNoFont()` names the state. Settings says "Switched on, but
nothing is measuring", why, and that adding a font starts it. The notice says
nothing is measuring and lists only what is true without an engine: the user's
fonts the engine could not take, with why, and the names nothing here has.

One behaviour to decide on: in that state the notice now shows even for a
chapter with nothing missing, because boxes are not being resized and the
queue is where the letterer would notice.

Tests: `SettingsModal-engine.dom.test.js` mounts Settings and reads the hint in
three states; three cases added to `FontNotice.dom.test.js`. The no-font cases
failed before the change.

## Chosen not to fix

- **`TextBox.svelte:1015`**, the one ungated reader in the item 3 table. Not my
  file in this task.
- **Export while a face is arriving** is not blocked (item 3 table).
- **System families stay loaded** in the engine until the switch goes off, a
  rescan drops them or they are uninstalled. Item 11 bounded the name cache,
  not this; a session that opens many chapters in many system fonts keeps all
  their bytes.
- **Item 9, three costs left in.** The native side reads the whole file even
  when it then sends only the header. Two families asked for at the same
  moment both cross the bridge. A file swapped behind the same path, length
  and date keeps its id; the family check still runs on it.
- **Item 7** keeps a second copy of an unsaved face's bytes while the switch
  is on, beside the engine's own, as you specified.
- **The two clippy lints** in `src/brush/score.rs`.

## For whoever merges `engine-switch.svelte.js`

My hunks in that file, all small and in place: the step 2 comment in the
header; `compile` and `createEngine(module)` in `REAL`; `modulePromise` in
place of `enginePromise`; `dispose()` and its one call in `leave()`; the
engine creation lines in `start()`; `known` on the `systemFace` line;
`engineHasNoFont()` after `whyFontMissing`; the memo key in `lettersMissing`;
the two test hooks at the bottom. `TextBox.svelte` and `exporter.js` are
untouched.
