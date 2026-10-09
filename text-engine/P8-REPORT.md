# P8: everything else that reads a font or draws text

First round: branch `tp/fonts`, on `58369aa4`. Brief: `tp-data/briefs/p8-consumers.md`.
Every figure is marked **[M]** measured here or **[I]** inferred.

A second round followed an outside review (brief
`tp-data/briefs/p8b-consumers-fixes.md`, on `02ebc2c8`): nine defects, five
mutations no test caught, the empty type layers and the audit's fit phase.
It is the section "Second round" at the end. Lines of the first round that
it made untrue are corrected in place. The audit and its tables are the
second round's historical measurements; later proofs are revision-bound
in "Third round" below. Source line numbers in older sections are historical.

With `textEngine: 'browser'` nothing is reached that was not reached before:
every new behaviour is behind `engineDraws()` (text-engine/index.js) or
`fontsGated()` (store.svelte.js:5213), and both are false there. The Skia
capture is byte for byte the base run [M].

| item | state |
|---|---|
| 1. PSD uses the engine's truth | done |
| 2. `.mtchapter` tells the truth about fonts | done, with the switch on; cut-over list below |
| 3. bench runs both engines | done |
| 4. variable fonts | `wght` fixed and measured; `ital`, `slnt`, `opsz` not read |
| 5. the audit | done; two callers left with the switch on |

In the first round no file of another worker was touched. Its
`git diff --name-only 58369aa4..HEAD`
has no line of `TextBox.svelte`, `edit-lines.js`, `curve-caret.js`,
`scripts/editor-check.mjs`, `text-engine/src/paint/*`, `abi.rs` or
`abi_paint.rs` [M]. The variable-font commit added one new Rust file
(`text-engine/src/abi_instance.rs`) and one new JS file
(`text-engine/js/instance.mjs`), and changed `font.rs`, `engine.rs` and four
lines of `lib.rs`. The second round added one more of each
(`text-engine/src/abi_line_fonts.rs`, `text-engine/js/line-fonts.mjs`), two
more lines of `lib.rs`, and a test helper (`src/test/variable-fixture.js`);
the second round's `git diff --name-only 02ebc2c8..HEAD` has no line of `TextBox.svelte`,
`flat-caret.js`, `type-rows.js`, `abi.rs` or `text-engine/src/paint/*` [M].

## 1. The PSD export

**Before.** `fontRequestFor` built a font name from the family the box
names: the PostScript name parsed from a user's file, or the family with a
suffix (`SysTwo-Bold`) for anything else. The faux flags came from the app's
font list, not from what was drawn. `buildPagePsd` waited on
`document.fonts.ready`. A missing font and a borrowed letter left no trace.

**Now**, when the engine draws:

| what | where |
|---|---|
| The name is name ID 6 of the font the engine holds for that weight and slant, user font or system font alike. A name ID 6 of nothing but spaces is no name: the constructed one is written, as before the engine | `engineFontRequest`, psd.js:289; `drawnFace`, text-engine/drawn-face.js:37; `postScriptNameOf`, :23 |
| `fauxBold` / `fauxItalic` are what the adapter synthesised (`matchSlot`) | same |
| The wait is the P3c gate; a gate that gives up throws, so no file is written and the export's toast says why | psd.js:939; exporter.js:1325 |
| `document.fonts.ready` is awaited only when the browser draws | psd.js:941; exporter.js:1314, 1330 |
| One export, one engine: the export holds the engine its waits ended on, and a file the engine changed under is not written | `enginesSettled`, exporter.js:1290; `enginesHeld`, :1300; psd.js:938, 942, 1006 |
| Missing font: the layer names the last-resort face drawn, and its NAME ends ` [font missing: NAME]`. On a raster-only layer too. The importer strips the mark | psd.js:456, 518, 1133 |
| Borrowed letters: see the choice below. Which font drew a stretch, and where it ends, is asked of the engine (`Engine::line_fonts`), the cut it measures and paints in | `borrowedRuns`, psd.js:479; `drawnRuns`, drawn-face.js:75 |

**Tests.** `src/lib/psd.engine.test.js` (16), `src/lib/psd-lines.realfont.test.js`
(1), `src/lib/text-engine/drawn-face.engine.test.js` (7),
`src/lib/exporter-fonts-gate.test.js` (19).

**A box the engines break differently.** In the test lane: Comic Neue bold,
no bold file, width 190. Skia: `WAIT FOR ME / OVER THERE / BY THE OLD /
BRIDGE`. Engine: `WAIT FOR / ME OVER / THERE BY / THE OLD / BRIDGE`. The
layer carries the installed engine's lines in each mode [M]. The cause is
the engine's `size / 36` per glyph on a synthesised bold.

**On a real chapter** (tsukimichi 121, in Chromium 155, engine on) [M]:

| | |
|---|---|
| `psdSelfTest` on page 10 | ok, 0 diffs |
| boxes on the 26 pages the audit did not edit | 375 |
| broken differently by the two engines | 3: p10 b175, p12 b245, p22 b437 |
| PSDs written and read back with ag-psd | pages 10, 12, 14, 22 |
| type layers matched to a painted box by their lines | 49 of 49 |
| of those, font name and both faux flags equal to the engine's | 49 of 49 |
| raster-only layers on those pages | 0 |

b437 is the clean case: CCMeanwhile, same font in both, `meet- / ings.`
from the engine and `meetings.` from the browser; the layer has the
engine's. b175 and b245 name Bangers, which has no file in that session:
the engine drew Arenzi (last resort), the layer says `Arenzi` and its name
ends ` [font missing: Bangers]`. Page 14 has three italic boxes: the layer
names `CCVictorySpeech-Italic` with no faux flag, the real italic file.

"What the engine drew" is read from the painter: its `paint` is wrapped
while each box is rendered, and the job's face is resolved through the
engine. Files: `tp-data/reports/p8/audit.md` (the per-layer tables),
`audit.json`, and four `tsukimichi__121-p*.rust.psd`.

Two type layers on those pages have no text and no font: p10 `line -1`
(box b183: its line, number -1, is empty) and p14 a layer named by a line
break (box b274: its text is one line break). They are boxes with no text.
The same pages written with the switch off have the same two layers, same
name and same rectangle, and the same count of type layers (11, 15, 11, 14)
[M]. So it is what the writer always did with an empty box (`textLayerFor`:
only a raster-only box with no pixels is dropped), not something the switch
adds, and it is left as it is.

## 2. The `.mtchapter` package

**Before.** `fontStatus` knew `builtin`, `present`, `install`, `missing`. A
font installed on the machine was `missing`. The export said nothing about
families that would not travel.

**Now**, with the switch on:

| what | where |
|---|---|
| `fontStatus`: `install` (a shipped face the library has no slot for), then what the font gate says of the family: `missing`, or drawn as itself and so `present` (user library) or `system` (installed here) | package-flow.js:218, 235 |
| Families the chapter names and the manifest leaves out are listed too | `packageFontStatuses`, package-flow.js:263 |
| Both first wait for the gate to know each family: a system family is read the first time it is asked about | `familiesKnown`, package-flow.js:95; `fontFamiliesSettling`, store.svelte.js:5204 |
| The export returns `{ path, staying }`; `staying` is `[{ name, why: 'system' or 'missing' }]` | `fontsStaying`, package-flow.js:78; `exportChapterPackage`, :117 |
| The toast names them | `stayingNote`, package-flow.js:104; ProjectView.svelte:50 |
| The import dialog counts "installed on this computer" | NewChapterDialog.svelte:149 |

No system font file is copied; a test holds that. The built-in list is not
removed.

**Tests.** `src/lib/package-fonts.test.js` (14), with a stand-in for the
gate, and `src/lib/package-fonts.engine.test.js` (4), with the real switch
and engine and two fonts the engine cannot read. Five of the 14 run with
`app.fonts.builtin = []`, in both modes: a package carrying a font under a
former built-in name installs it, and a font the user loaded under such a
name travels.

**In the audit session** [M]: 16 families, 15 shipped, 2,508,341 bytes;
15 `present`, Bangers `missing`.
Switch on: `Fonts not in the package: Bangers (no file on this computer)`.
Switch off: nothing said, as before.

## 3. The bench

`runBench(cases, { engine })` runs the cases under one engine and puts the
other back (`withEngine`, src/test/typeset-bench/runner.js:471).
`typeset-bench.realfont.test.js` runs browser then rust, prints the browser
table as it always did, then a side-by-side table and the list of
differences. With `OUT` set it writes `rust: { cases }`, `differences` and
`<category>.rust.png` beside the browser's files.

| | [M] |
|---|---|
| browser results, before and after this change | identical: 25 cases' JSON, 10 contact sheets byte for byte |
| cases that differ between the engines | 9 of 25 |
| differences in lines or size | 0 |
| differences in ink overflow of ±0.5 px only | 7 (exclaim-what, exclaim-wait, para-two, edge-tiny, sfx-balloon, cjk-hangul, cjk-kana) |
| differences in box x and w of 1 to 2 px | 2 (outline-art, sfx-art) |

## 4. Variable fonts

Fonts of this Mac, read in place. No font here has an `ital` or `slnt` axis.
The corpus under `tp-data/fonts` has no variable font: 0 of 108 files [M].

**Before** [M], 20 letters at 100 px:

| font | request | engine | Chromium 155, installed font | Chromium, loaded with `new FontFace(name, bytes)` |
|---|---|---|---|---|
| STIX Two Text (`wght` 400..700, default 400) | regular | 962.2 | 962.2 | 962.2 |
| | bold | 962.2 + smear | 1,047.3, real 700 | 962.2, 400 smeared |
| Kefa III (300..800, default 400) | bold | 936.2 + smear | 1,019.0 | 936.2, smeared |
| SF NS Mono (294.67..900, default 294.67) | regular | the Light | - | weight 400 |
| SF Compact (1..1000, default 1000) | regular | the Black, 1,182.8 | - | weight 400, 975.8 |

So the engine drew the default instance and synthesised bold. That is the
defect the brief names.

**Now** [M]:

| font | request | engine | name written |
|---|---|---|---|
| STIX Two Text | regular | 962.2 | `STIXTwoText` |
| | bold | 1,047.3, no faux bold | `STIXTwoTextRoman-Bold` |
| STIX Two Text Italic | bold italic | 1,011.9, nothing synthesised | `STIXTwoTextItalic-BoldItalic` |
| Kefa III | bold | 1,018.8 (Chromium 1,019.0) | `KefaIII-Bold` |
| SF NS Mono | regular | weight 400; ink of `l` 439 units against 430 at the default | `.SystemSFNSMono_400wght` |
| SF Compact | regular | weight 400, 1,074.4 (Chromium 975.8: `opsz`) | `.SystemSFCompact_400wght` |

Painted ink, STIX line: 18,022 px regular, 28,225 px bold, 10,203 more.
Chromium: 10,214 more for its real 700, 5,702 more for a 400 it smeared.

| what | where |
|---|---|
| A font registered again at another place on its axes: shaping, advances, outlines, name | `FontEntry::instance`, font.rs:183; `Engine::add_instance`, engine.rs:210 |
| Outlines drawn at the entry's own coordinates | font.rs:257 |
| The instance's PostScript name, Adobe Technical Note 5902: value format `fixed_decimal`, over 127 characters `last_resort_name` | font.rs:441, 367, 412 |
| An axis that is not a range is not an axis; no number traps | `axis_is_a_range`, font.rs:350; :188, :195, :317 |
| The export | `mt_font_add_instance`, abi_instance.rs:31 (new file) |
| The JS wrapper, with a "can this wasm do it" check | text-engine/js/instance.mjs (new file) |
| The rule: 400 and 700 inside the axis, faux bold only under 600 | `weightOnAxis`, rust.js:61; `weighted`, :131 |
| Instances removed with their face | `forgetWeights`, rust.js:143 |
| The rule written down | RULES.md, rule 13 |

It needed no painter file: the painter draws through
`FontEntry::draw_glyph`. `abi_instance.rs` is compiled with the `paint`
feature only, because `abi::with_engine` is; that `cfg` can go when `abi.rs`
is next opened. `ABI_VERSION` stays 2. A wasm without the export behaves as
before.

**Tests.** `text-engine/tests/instance.rs` (12),
`src/lib/text-engine/variable-font.engine.test.js` (19). Eight of the 19 and
five of the 12 read `/System/Library/Fonts/...` and say SKIPPED by name on a
machine without it. The other thirteen make their variable font in the test:
a fixture font with an `fvar` (and where needed an `MVAR` or a name) written
into a copy in memory (`src/test/variable-fixture.js`; `variable` in
tests/instance.rs). No font file was added.

## 5. The audit

`scripts/text-port/p8-audit.mjs`. It loads the app's own `index.html` from
its own Vite (5204), drives it over DevTools (9382), and installs its
counters before any script of the page. Mouse for select, move and resize;
the Inspector's own controls for font, size, bold and italic. Chapter
tsukimichi 121, 28 pages, 35 font faces of 15 families (the 16th, Bangers, has no file). Zero page errors [M].

**Switch off** [M]:

| call | caller | count |
|---|---|---:|
| `Range.getClientRects` | text-engine/browser.js:87 `wrapPlain` | 30,310 |
| `measureText` | browser.js:18 `advance` | 7,388 |
| `measureText` | browser.js:29 `lineInk` | 5,640 |
| `measureText` | browser.js:22 `fontBox` | 971 |
| `measureText` | browser.js:35 `glyphInk` | 102 |
| `fillText` | text-engine/browser-painter.js:110 | 120 |
| `strokeText` | browser-painter.js:105 | 120 |
| `document.fonts.check` | browser.js:118 `faceReady` | 10 |
| `document.fonts.ready` | exporter.js:1314 | 2 |
| `document.fonts.ready` | psd.js:941 | 1 |
| `document.fonts.ready` | App.svelte:77 | 1 |
| `new FontFace` | fonts.js:668 `registerFace` | 35 |

**Switch on** [M]:

| call | caller | count | what it is |
|---|---|---:|---|
| `new FontFace` | fonts.js:668 `registerFace` | 35 | UI that stays. A user's font is registered with the browser so that the font menus and the font manager show each family in its own face. Nothing of a text box reads it once the engine draws. |
| `document.fonts.ready` | App.svelte:77 | 1 | At start, before the preference is read: it re-measures once the browser's fonts are in. With the engine on that pass goes through the engine. It belongs to the browser path and goes at cut-over. |

No `measureText`, `fillText`, `strokeText`, `document.fonts.load` or
`.check`, and no `Range` rectangle, in any phase: open, page turns, select,
move, resize, Inspector font, size, bold, italic, fit, auto-typeset, PNG,
PSD, `.mtchapter`.

These are the totals of the second round's run, on the final tree. The
first round's run had 30,378 `Range.getClientRects` and 973 `fontBox` calls
with the switch off: its fit phase set the box to size 72 and changed
nothing, and this one's shrinks the box and fits it (below), so the phase
makes other calls. With the switch on the two runs are the same two rows.

**The fit phase acts** [M]. The box (200.1 x 255.9 at 16 px) is pulled in to
56 x 18, narrower than its longest word and one line high, and "Fit now"
(`fitBoxNow`) is called in the same turn, so that nothing but the fit can
change it. The fit makes it 56 x 116, in both modes. With the switch off
that phase makes 34 `Range.getClientRects` and 12 `measureText` calls; with
it on, none. The script stops with an error if the fit changes nothing.

Call sites the session did not reach, read from the source:

| site | reached when | who removes it |
|---|---|---|
| browser.js:119 `document.fonts.load` | browser measures, face not loaded | cut-over |
| browser-painter.js:87, 90 (curved text, glyph by glyph) | browser draws | cut-over |
| exporter.js:1330, 1296, psd.js:941 | switch on and no font the engine can read | cut-over |
| `TextBox.svelte`, 3 sites | editing a box | P7 |

Per-phase columns and the callers' callers: `tp-data/reports/p8/audit.md`.

## Choices the brief did not make

1. **Borrowed letters: a live layer, not raster-only.** The brief offered
   raster-only, or live with a marked name. Taken: live, name ends
   ` [letters from another font]`, and each borrowed stretch is its own
   `styleRun` with the lender's PostScript name and faux flags. Reason: a
   type layer can state a font per run, so the text stays editable and the
   statement is still true. Photoshop has not been seen to honour it.
   Which font a stretch is in is the engine's own cut of the line, asked
   for (second round, findings 2 and 3), not worked out from coverage.
2. **The missing-font mark** is ` [font missing: NAME]`, on raster-only
   layers too, between the review flag and the raster marker.
3. **With the switch on, an export does not touch `document.fonts.ready`**
   unless the browser still draws.
4. **Package statuses change only with the switch on.** With it off a
   system font is still "will use a fallback". That is the price of
   "browser: nothing changes".
5. **`exportChapterPackage` now resolves `{ path, staying }`**, not a path.
   Its one caller was changed.
6. **A user-loaded variable font draws its real bold.** Chromium smears the
   400 instance for it, because the app gives the browser no weight range.
   One rule for loaded and installed fonts was taken instead.
7. **The instance's name is Adobe's rule**, not CoreText's. CoreText names
   the STIX bold `STIXTwoText_Bold`; the rule gives `STIXTwoTextRoman-Bold`
   [M]. For Kefa III both give `KefaIII-Bold` [M].
8. **A face in a bold slot is drawn at 700 whatever is asked** [I].
9. **The bench writes the Rust engine's sheets beside the browser's**
   (`*.rust.png`) and never over them.
10. **The audit runs the app, not a host page**, and serves the user's
    fonts and chapter from its own Vite so that no third port is opened.
11. **The audit counts `OffscreenCanvas` text calls too.** There were none.
12. **Auto-typeset in the audit** is `placeDetectedOnPage` on the last page,
    emptied of its boxes in the copy, in smart mode: 10 boxes placed.

## Not done

- `ital` and `slnt` axes. No font here has one. An italic asked of such a
  font is still the upright sheared.
- `opsz`. A browser sets it to the font size; the engine leaves it at the
  file's default. Only Apple's hidden system fonts have it here.
- The audit does not open the font manager, the brush tools or Settings.
- The audit has no system fonts and no library on disk (no Tauri). The
  `.mtchapter` phase runs `exportChapterPackage`'s steps after its disk
  read, with a one-pixel picture a page.
- Typing, by the brief.
- A package made with the switch off still does not name built-ins in its
  manifest; with the switch on the import lists them as missing.

## Where the brief was wrong

- It says `system_fonts.rs` keeps a PostScript name per face. It keeps path,
  index, rank and stat. Nothing was needed from it: the engine reads name
  ID 6 from the bytes it holds (`mt_font_info`).
- It expects the fix of item 4 in "JS and native wiring". The wiring was not
  enough: the engine had no way to place a font on its axes. Two engine
  files outside the painter were changed and one added.

## Cut-over: what item 2 needs changed

When the built-in list is removed:

| line | change |
|---|---|
| package-flow.js:135-137 | drop the filter; `families = named` |
| package-flow.js:220 | drop the `'builtin'` answer |
| package-flow.js:241-242 | drop `refused`; `if (f.shipped)` |
| package-flow.js:79, 157, 219, 264, 265, 267 | drop the `fontsGated()` conditions: the engine's answers are the only ones |
| fonts.js:702, 753, 805 | drop the three built-in guards (`_restoreFontRecords`, `installFontFace`, `addFontFile`) |
| NewChapterDialog.svelte:149 and the `builtin` count beside it | drop the built-in wording |
| font-menu.js:23, FontModal.svelte:55-56, store.svelte.js:5111 | the list's other readers, not item 2's |

The five tests under "with no built-in fonts (cut-over)" in
`package-fonts.test.js` pass today with the list emptied, and must pass
then. The test "today a package cannot install a font under a built-in
name" is the one to delete.

## What only the desktop app can show

1. Open a PSD written with the switch on in Photoshop. A user font and a
   system font: is the layer live, in the right face, with no "missing font"
   prompt?
2. A box whose font is missing: does the layer read `... [font missing: X]`
   and show the last-resort face?
3. A box with a borrowed letter: does Photoshop show the borrowed run in the
   lender's font? If it flattens the runs, choice 1 falls back to raster-only.
4. A bold box in STIX Two Text or Kefa III: does Photoshop find
   `STIXTwoTextRoman-Bold`? If it asks for `STIXTwoText_Bold`, the naming
   rule in font.rs:441 is to follow CoreText instead.
5. The same bold box on screen in Tauri (WebKit), switch off and on: is the
   engine's bold the weight WebKit draws of the installed font? WebKit was
   not measured.
6. Export a chapter that uses a system font: the toast names it as
   "installed here". Import the package on a second machine without that
   font: the dialog says missing; with it: installed on this computer.
7. Export with a font whose file is gone: the gate gives up, the toast says
   why, no file is written.
8. Run the audit's session by hand in Tauri with system fonts in use.
9. Flip the switch in Settings while a long chapter exports: the export
   stops, the toast says the engine was switched, and the files already
   written are whole. Is that the behaviour wanted, or should the Settings
   switch be held while `app.exporting` is set?
10. A PSD whose font has a name longer than 127 characters as an instance
    (`Prefix-<32 hex digits>...`): does Photoshop take the name?

## Mutations

Each run in a scratch copy under `node_modules/.cache/p8/mut` [M]. These
are the first round's, run on its tree. Two of them name code the second
round rewrote ("no borrowed runs", "an installed font is called missing");
what stands in their place is mutated in "Second round" (b8 to b12, b22 to
b26).

| mutation | tests that fail |
|---|---|
| psd: the engine is never asked for the face | 5: system font name, list-against-engine flags, missing font, variable instance, the differing-breaks box |
| psd: `buildPagePsd` skips the gate | "a gate that gives up is a PSD that is not built" |
| psd: `buildPagePsd` always awaits `document.fonts.ready` | "the engine's gate, and not the browser's font set" |
| psd: no missing-font mark | 2 |
| psd: no borrowed runs | 2 |
| export: `document.fonts.ready` always awaited first | 2 |
| engine: synthesised bold as wide as the regular | the differing-breaks test |
| package: nothing is said to stay | 2 |
| package: an installed font is called missing | 1 |
| package: the export filters fixed names, not the list | 2 cut-over tests |
| fonts: install refuses a fixed name, not the list | 2 cut-over tests |
| package: a built-in name is said to install today | 1 |
| bench: the engine is not put back | "leaves the browser engine installed" |
| bench: no difference is listed | "lists a case as different exactly when..." |
| variable: every request is weight 400 | 11 |
| variable: a reachable bold is still emboldened | 10 |
| variable: instances not removed with their face | 1 |
| Rust: outlines at the default place | `an_instance_is_measured_and_drawn_at_its_own_place` |
| Rust: shaping at the default place | the same |
| Rust: no instance name | `an_instance_has_the_name_adobes_rule_gives_it` |
| Rust: no clamp to the axis | `a_value_past_the_axis_stops_at_its_end...` |

## The proofs, as run on 2026-10-09 [M]

| proof | result |
|---|---|
First round, on `309da40c`'s tree:

| proof | result |
|---|---|
| `./node_modules/.bin/vitest run` | 122 files passed, 1 skipped; 3,387 tests passed, 7 skipped (both skips are the env-gated capture and perf tests) |
| `cargo test` in `src-tauri` | 301 passed, 1 ignored |
| `cargo test` in `text-engine` | 102 passed (96 before) |
| `npm run build` | ok |
| capture `p8-sk` against `runs/ref-sk/base` | 1 file differs: `manifest.json` |
| capture `--engine new` `p8-new` against `runs/new/p6b-new2` | 1 file differs: `manifest.json` |
| both runs | deleted |

That tree did not hold `text-port` `e829744`: the Rust capture was compared
with `p6b-new2` as the coordinator asked. The final tree's proofs, with the
merge in and against `runs/new/r4`, are at the end of "Second round".

## Second round

Brief `tp-data/briefs/p8b-consumers-fixes.md`, on `02ebc2c8` (the
coordinator's merge of `text-port`). The review is the end of
`tp-data/reports/codex-p8-review.out`.

**How each finding was reproduced.** The test that now holds it was run
against the code as it was: the sources of `02ebc2c8` put into the scratch
copy (`node_modules/.cache/p8/mut`) under the new tests, for findings 1, 2,
3, 5, 6, 7 and 9; and for findings 4 and 8 the new tests run in the
worktree before the fix was written. All nine were reproduced [M].

### The nine findings

**1. An axis with its minimum above its maximum trapped the engine.**
Reproduced: `add_instance` on a font whose `fvar` says `wght` 800..700
panicked in `f32::clamp`, `min > max, or either was NaN. min = 800.0, max =
700.0` [M]. In the wasm a panic is a trap, and the instance is gone for the
session.

- An axis that is not a range (a minimum above the maximum, a default
  outside the two, a number that is not finite) is not an axis:
  `axis_is_a_range`, font.rs:350. `read_info` does not list it (:317), and
  a place asked on it is `Error::BadSpec` (:195).
- A value that is not a finite number is `BadSpec` on any axis (:188).
- The value is brought into the range with `max` then `min` (:201), which
  cannot panic, so the check is not the only thing between a file and a trap.
- `mt_font_add_instance` (abi_instance.rs:31) answers 0 for all of these;
  `addInstance` (text-engine/js/instance.mjs:40) throws `... axis is not a
  range` or `... is not a number`, the second before the engine is called.
- Every number read from `fvar`: an axis' minimum, default and maximum
  (checked as above); a named instance's coordinates, which are only
  compared, as 16.16 integers (`fixed`, font.rs:356), with the place asked.
  Every argument of `mt_font_add_instance`: the font id (unknown: 0), the
  tag (any 32 bits; an axis the font does not have is ignored, as before),
  the value (above).
- Tests: `an_axis_that_is_not_a_range_is_not_an_axis_and_nothing_traps`
  (tests/instance.rs: four damaged axes, each asked at 700, 0, ±1e30,
  `f32::MAX`, the smallest positive number, NaN and both infinities, with a
  sound axis beside it that still works); in
  `variable-font.engine.test.js`, through the wasm: "an axis that is not a
  range is no axis...", "no number and no tag a caller passes traps the
  engine", and the adapter's weight rule on a font whose `wght` is damaged.
  Each font is a fixture font with an `fvar` written into a copy in memory.
- Mutations b1 to b4.

**2. A borrowed stretch was cut per code point, not per cluster.**
Reproduced: `Ω` with a combining acute, face Comic Neue, lender DejaVu
Sans, gave two runs where the engine draws one cluster [M].
**3. The lender was guessed from the lists of missing letters.**
Reproduced: with the fallbacks Bangers then DejaVu Sans, `ΩĦ` was given as
two runs; the engine draws both letters from DejaVu Sans, keeping `Ħ` in
the lender before it (50.4053 px at 30 px; 40.2348 px with `Ħ` from
Bangers) [M].

One fix for both: the PSD no longer works anything out. It asks the engine
for the cut it measures and paints the line in.

- `Part` (engine.rs:127) now says which stretch of the line it was shaped
  from, in UTF-16 units; `measure_line` fills it in where it already cut the
  line, cluster by cluster. `Engine::line_fonts` (engine.rs:573) hands the
  parts out: it IS `measure_line`, the function `advance` measures with and
  `paint/shape.rs` paints with (rule 11's one code path).
- New export `mt_line_fonts` in a NEW Rust file,
  `text-engine/src/abi_line_fonts.rs` (:38), and its wrapper in a NEW JS
  file, `text-engine/js/line-fonts.mjs` (:32). `abi.rs` is not touched; the
  file passes its own text (`mt_alloc`, a UTF-8 pointer and an out pointer)
  because `abi.rs` keeps its helpers private. Compiled with the `paint`
  feature, like `abi_instance.rs`, for the same reason. `ABI_VERSION` stays
  2; a wasm without the export answers "the whole text is the face's own".
- `lineParts` on the adapter (rust.js:469); `drawnRuns` (drawn-face.js:75)
  maps each part to the face itself or to the family that lends it, with
  the faux flags the part was drawn with, line by line as lines are painted.
- Tests: tests/line_fonts.rs (3); `drawn-face.engine.test.js` (7), of which
  "is the type layer's runs, cluster for cluster, on a text with two
  lenders" sets `textLayerFor`'s `styleRuns` against the engine's parts unit
  by unit on `AĦ ΩĦ ΏB` (Bangers lends the first `Ħ`, DejaVu Sans the rest).
- Mutations a1, a2, b8 to b12.

**4. "Does the engine draw" was asked once and could be stale.**
Reproduced: with the engine swapped as the page's first canvas is made,
`exportImages` wrote the file and said it went well, PNG and PSD alike [M].

**Chosen: the export holds the engine its font waits ended on.** It does
not ask again at each page.

- `enginesNow` / `enginesAre` (text-engine/index.js:77, :80): the engine
  and the painter installed, told by identity. Either changing is a change.
- `enginesSettled` (exporter.js:1290): if another engine is installed when
  the waits end, they were the wrong waits; it waits again, for that one,
  until a wait ends on the engine it began on. Called from `exportImages`
  (:1333) and `buildPagePsd` (psd.js:942).
- `enginesHeld` (exporter.js:1300): asked when a file's pixels are finished
  and before it is written, per page (:1377), per strip slice (:1154) and
  per PSD (psd.js:1006). Another engine by then: that file is not written,
  none after it is, `exportImages` answers false and the toast reads
  `Export failed: the text engine was switched while this was being
  written...`. Files already written were each painted by one engine and
  stand.
- Why not "ask again at the point of painting": a chapter whose first pages
  are the engine's and whose last are the browser's is the same
  half-and-half, spread over files.
- A consequence to know: a font landing can put the engine's painter in or
  take it out (`apply`, engine-switch.svelte.js). If that happens in the
  middle of an export, the export stops and says so. It cannot happen
  through the pages' own fonts, which the export has waited for.
- With the switch left alone nothing new is awaited: the three additions
  are synchronous comparisons.
- Tests: `exporter-fonts-gate.test.js`, "the engine it waited for" (8: PNG,
  PSD, a whole chapter, strip slices, only the painter, only what measures,
  an engine put in during the wait, switched on during the browser's wait);
  `psd.engine.test.js`, two under "what a PSD waits for".
- Mutations b15 to b21.

**5. A name over the limit was cut, and two instances got one name.**
Reproduced: on a font with ten axes, the instance at 650 on the tenth and
the one at 651 were both named `ComicNeue_-123.457aaaa_ ... _-131.457iiii_`,
127 characters, the tenth axis cut away [M]. Now `last_resort_name` (font.rs:412): the prefix (91
characters of it at most), `-`, 32 hex digits of a 128-bit hash of the whole
long name, and `...`. **Not verified against the note:** the note's limit
(127) and that the last-resort name is a hash ending `...` were read; which
hash, and how the prefix is cut, could not be (the later pages of the PDF
did not come out as text). FNV-1a 128 and the 91 are this engine's choices
[I]. The name is distinct per instance and stable; it is not promised to be
the name another implementation makes. Test:
`a_name_too_long_is_the_last_resort_and_still_tells_instances_apart`.
Mutation b5.

**6. Three decimals did not tell two 16.16 values apart.** Reproduced:
650 + 4/65536 was named `650wght` [M]. Now `fixed_decimal` (font.rs:367):
the fewest decimals, five at most, that read back as the same 16.16 number,
no leading or trailing zero (`650`, `.5`, `-.25`, `650.00006`). Places are
compared as 16.16 integers everywhere (`fixed`), never by a tolerance. An
`f32` near 650 holds only every fourth step of 1/65536, so the test takes
single steps near 0 (`slnt`) and steps of four near 650. Test:
`an_axis_value_is_spelled_so_that_it_reads_back_as_the_same_number`.
Mutation b6.

**7. A name ID 6 of only spaces was written as the font name.**
Reproduced: fifteen spaces came out as the layer's font [M]. Now trimmed at
the engine's one reader, `postScriptNameOf` (drawn-face.js:23); an empty
name is no name, and `engineFontRequest` (psd.js:289) writes the
constructed one. Test: "a font whose PostScript name is only spaces".
Mutation b7.

**8. A family was `present` or `system` by being in a list.** Reproduced
with the real switch and engine: a WOFF2 in the library with nothing to
decode it was `present`, and a system family whose file cannot be read was
`system` and "installed here" in the export's note [M]. Both are drawn in
the last-resort face.

- `engineFontStatus` (package-flow.js:235) and `fontsStaying` (:78) ask the
  font gate (`fontMissing`, the editor's "font missing" notice): missing,
  or drawn as itself and then `present` (library) or `system`.
- `install` is still read off the lists, because it is a statement about
  them: a shipped face the library has no slot for is one the import will
  put in. A shipped font whose every face is already in the library is NOT
  installed over (`installFontFace` leaves a slot it finds), so its status
  is what the gate says of what is there.
- Both wait for the gate to know (`familiesKnown`, :95, through the store's
  new `fontFamiliesSettling`, store.svelte.js:5204): a system family is
  read from disk the first time anything asks, and until then it is neither
  missing nor not. `inspectPackage` now waits only with the switch on, before
  the synchronous `packageFontStatuses` reads the known statuses. A wait that
  gave up was suppressed in this earlier round; the Third-round correction
  below now exposes that failure and validates the settled source identity.
- With the switch off nothing of this is reached.
- Tests: `package-fonts.engine.test.js` (4, new); one more in
  `package-fonts.test.js`, whose stand-in for the gate now answers
  `missing` as the engine does.
- Mutations b22 to b26.

**9. A bad tag after a good one leaked the first instance.** Reproduced:
`addInstance(font, { wght: 700, bad: 4 })` threw and left a font id taken
[M]. Now every tag and every value is looked at before anything is made
(instance.mjs:43 to :46), and the steps run inside a `try` that removes
what was made when a later step fails (:52 to :62). Tests: "a bad tag after
a good one is refused before anything is made" (the engine is not called at
all), "a step that fails takes the steps before it back out". Mutations
b13, b14.

### The five mutations the review found uncovered

Each now has a test that fails on it, run in the scratch copy [M].

| | mutation | test that fails |
|---|---|---|
| a1, a2 | astral letters: the loop the review mutated is gone (finding 3); the offsets are now made in `measure_line`, so the mutation is restated there: a part starts one unit a letter (engine.rs:474), a part is as long as its letters (:518) | `a_part_never_ends_inside_a_cluster_and_offsets_are_utf16` (tests/line_fonts.rs). The JS test "counts a letter outside the BMP as the two units it is" holds the same through the wasm; it was not run against a mutated wasm |
| a3 | an instance of an instance starts from nowhere (`self.location.clone()` to empty, font.rs:186) | `an_instance_of_an_instance_keeps_the_axes_it_was_already_moved_on` |
| a4 | an instance keeps the metrics of the font it was made from (`read_info(...)` to `self.info.clone()`, font.rs:212) | `an_instance_has_its_own_line_metrics`: a fixture font given an `MVAR` that moves the ascender and descender with `wght` |
| a5 | a named instance's `postScriptNameID` is not used (font.rs:475) | `a_named_instance_has_the_name_the_font_gives_it` |
| a6 | the instance between two axes is not deleted (instance.mjs:63) | "an instance on two axes is on both, and the step between is not left behind" |

### Mutations of this round's fixes

All run in the scratch copy; every one fails at least one test [M].

| | mutation | tests that fail |
|---|---|---|
| b1 | a place on an axis that is not a range is accepted | 1 (instance.rs) |
| b2 | an axis that is not a range is listed | 1 |
| b3 | a value that is not a number is accepted (Rust) | 2 |
| b4 | a value that is not a number reaches the engine (JS) | 2 |
| b5 | a long name is cut, not replaced | 1 |
| b6 | three decimals at most | 3 |
| b7 | a name of spaces is a name | 1 |
| b8 | the lender is the first of the list | 4 |
| b9 | the lender before is not tried first (engine) | 1 (line_fonts.rs) |
| b10 | a mark is its own cluster (engine) | 1 (line_fonts.rs) |
| b11 | every run is the face's own | 6 |
| b12 | a later line's runs are placed as the first line's | 1 |
| b13 | a tag is looked at only when its step comes | 1 |
| b14 | a step that fails leaves the ones before it | 1 |
| b15 | a page is written whatever engine is installed by then | 4 |
| b16 | a strip slice is written whatever engine is installed by then | 1 |
| b17 | the export does not wait again for an engine put in meanwhile | 2 |
| b18 | a PSD is written whatever engine is installed by then | 1 |
| b19 | a PSD does not wait again | 1 |
| b20 | the engine is told by what measures alone | 1 |
| b21 | the engine is told by the painter alone | 1 |
| b22 | status by the lists, the gate not asked | 4 |
| b23 | the import does not wait for the gate to know | 1 |
| b24 | the export does not wait for the gate to know | 1 |
| b25 | every shipped face in the library is `present`, readable or not | 1 |
| b26 | a library font that stays is called a system font | 1 |

b13 survived its first run: the cleanup of finding 9 hid a tag checked too
late. The test now counts the calls made to the engine, and fails on it.

Not mutated: `clamp` put back in place of `max` then `min`. With the range
check in front of it the two cannot be told apart; it is there so that the
check is not alone.

### The two items of the first report

**The empty type layers.** Boxes with no text (section 1 above): p10 b183
and p14 b274. The same pages written with the switch off hold the same two
layers, same name and rectangle, and as many type layers in all [M]. Old
behaviour; left.

**The fit phase** now changes a box (section 5 above), and with the switch
on it makes no browser text call [M].

### Choices of this round the brief did not make

1. The export holds its engine (finding 4), and stops rather than re-waits
   once it has painted.
2. Findings 2 and 3 are fixed in the engine (a new export) and not in JS.
3. The last-resort name's hash and prefix length (finding 5) [I].
4. A blank name is refused at the reader (JS), not in `mt_font_info`, which
   lives in `abi.rs`.
5. `install` stays a statement about the lists; a shipped font already in
   the library, unreadable there, is `missing` (finding 8).
6. A package's font wait that gives up does not fail the package.
7. In this second round `packageFontStatuses` became async. The third
   round restores its synchronous return value and puts the engine-only
   wait in `inspectPackage`; see below.
8. The audit's fit phase writes the squeezed size straight into the box and
   calls `fitBoxNow` in the same turn, not through the mouse: a drag on a
   handle lets the canvas refit before "Fit now" is reached.

### The proofs on the final tree, 2026-10-09 [M]

Run on `43284e63`; the commit after it changes this file only.

| proof | result |
|---|---|
| `./node_modules/.bin/vitest run` | 124 files passed, 1 skipped; 3,416 tests passed, 7 skipped |
| `cargo test` in `src-tauri` | 301 passed, 1 ignored |
| `cargo test` in `text-engine` | 132 passed |
| `cargo fmt --check` in `text-engine` | clean |
| `cargo clippy --all-targets -- -D warnings`: default features, `--no-default-features`, `--all-features` | clean, clean, clean |
| `npm run build:engine` | ok; `mt_text.wasm` 1,603,347 bytes, sha256 `1aba362c...313ac44`, 41 exports |
| `npm run build` | ok |
| capture `p8b-sk` against `runs/ref-sk/base` (3,405 files) | 1 file differs: `manifest.json` |
| capture `--engine new` `p8b-new` against `runs/new/r4` (3,736 files) | 1 file differs: `manifest.json` |
| both runs | deleted |
| the audit, switch off | `Range.getClientRects` 30,310; `measureText` 14,101; `fillText` 120; `strokeText` 120; `document.fonts.check` 10; `document.fonts.ready` 4; `new FontFace` 35 |
| the audit, switch on | `new FontFace` 35 (fonts.js:668), `document.fonts.ready` 1 (App.svelte:77); nothing else |
| the audit's PSD proof | 49 of 49 type layers with text carry the engine's font and flags; `psdSelfTest` ok; 3 of 375 boxes broken differently; 0 page errors |

Variable fonts do not move the corpus: both captures are byte for byte the
reference runs.

The machine was shared and loaded (load average between 7 and 30 while
these ran). The suite passed whole on its one run; the captures and the
audit count things and time nothing.

## Commits

| commit | |
|---|---|
| `aa556e15` | feat(psd): a type layer names the face that was drawn |
| `b8fd5687` | fix(export): an export waits on one thing |
| `2b9c8686` | feat(package): a chapter package says what each font will be |
| `6f62360c` | test(bench): the bench runs every case under both engines |
| `a97ae22c` | feat(text-engine): a variable font is drawn at the weight asked |
| `3237277f` | test(text-port): the audit |
| `552270e7` | test(text-port): the audit counts the app's start too |
| `709668f3` | fix(text-engine): no font file traps the engine on an axis that is not a range; an instance's name tells every place apart (findings 1, 5, 6) |
| `32dcf95f` | fix(text-engine): making an instance checks everything first and leaves nothing behind (finding 9) |
| `cf4a52f8` | fix(psd): which font drew a borrowed stretch is asked of the engine (findings 2, 3, 7) |
| `7a552e1c` | fix(export): one export is painted by one engine (finding 4) |
| `4bc6487c` | fix(package): a font's status is what the font gate says (finding 8) |
| `161cf8d7`, `5c6f75fa`, `9e1ec38e` | tests the mutations asked for |
| `69b3758e` | docs(text-engine): rules 10 and 13 |
| `43284e63` | test(text-port): the audit's fit phase acts; empty type layers in both modes |


## Third round

Brief `tp-data/briefs/p8c-consumers-small.md`, starting on `788af55`.
The paused five commits end at `d72a8f6`. The review is items6–10 of
`tp-data/reports/codex-round2-review.out`. Fresh-worker instructions:
`tp-data/briefs/resume-p8c.md`. This round includes one integration fix:
the chain
policy previously deferred because `abi.rs` belonged to the typing worker.

This section records focused worker proofs while final verification is
scheduled. Coverage descriptions below are **[I]** unless a measured log
is named. Original worker measurements are historical; no new full suite,
capture or mutation replay is claimed until its log is listed.
The coordinator still has to merge the reviewed P7 tree into this branch,
rerun every proof and get the final read-only Codex review before merging P8.

### Five review findings and four previously untested cases

| finding | final behavior and behavioral coverage [I] |
|---|---|
| Axis tags lose punctuation and two places get one name | `tags_tell_axes_apart` allows readable value/tag names only when every filtered tag starts with a letter and tags remain distinct. Otherwise the last-resort hash includes each exact four-byte tag. `two_places_never_share_a_name_whatever_the_axis_tags_are` covers punctuation, digit-start, empty and distinct tags; shared named-instance words are tested separately. |
| A font states forbidden PostScript bytes | NameID6 and a named instance's stated name must be printable ASCII, with no space or `[ ] ( ) { } < > / %`, and at most127 bytes. An invalid stated name is not passed to a PSD. NameID25's prefix is reduced to letters and digits at its one reader. Rust and wasm tests construct these name tables in memory from tracked fixtures. |
| Export switch failure says nothing was written although whole files exist | `EngineSwitched` carries the completed-file count through page, PSD, strip and folder paths. Its message says how many whole files stand and that the current file and remaining files were not written. The tests cover zero, one and two completed files. |
| Unknown fallback chain silently disappears in `mt_line_fonts` | Unknown and freed nonzero handles are rejected; zero and held empty chains are valid. The whole engine now uses this policy, as described below. |
| Default package statuses gain a Promise tick | `packageFontStatuses` is synchronous again. `inspectPackage` waits for known statuses only when the switch is on. The default-mode same-tick test detects both an async status function and an extra await. |
| Line-font output capacity | `room_for_fewer_parts_than_there_are_is_an_error_and_nothing_is_written` offers a large sentinel buffer with a smaller capacity: one integer short, one part, half a part and zero. All bytes, including those beyond capacity, remain untouched on refusal. |
| Line-font allocation balance | `drawn-face.engine.test.js` counts every allocation/free over1000 calls and on refusal, including empty text. The count and sizes must balance and wasm memory must not grow. |
| Third variable-axis step fails | The wasm test makes the third step fail and requires both intermediate font instances to be removed; cleanup of only the first must fail. |
| Last-resort prefix cap | `the_last_resort_name_is_within_the_limit_whatever_the_prefix` uses a long nameID25 and requires the full generated name to fit127 bytes. |

### One fallback-handle rule across consumers

`Engine::check_chain` rejects a nonzero handle the engine does not hold with
`UnknownFont`. `measure_line` checks before its primary-face fast path and
clears the previous parts and glyph buffers. Font-box methods and the entry
of `wrap_plain` use the same check: an empty string or newline-only paragraph
must not bypass it. Advance, ink, missing glyphs, painter carets and
`line_fonts` then share that rule. Zero means no list; a live empty list is
valid. A live populated list still lends the same glyphs. [I]

The existing return forms remain: `mt_advance` returns NaN; standard buffered
measure exports return `Status::UnknownFont` (-2); `mt_line_fonts` has its
own established -1 unknown / -2 capacity contract. A rejected standard query
clears the shared output and fixed-size result buffers. A rejected
`mt_line_fonts` leaves caller-owned memory untouched. JS wrappers throw
before reading a refused answer, and unknown-handle error text names fonts
and chains. `ABI_VERSION` stays2. Raw `mt_shape`/`shapeUnits` have no chain
argument and retain their raw-font meaning. [I]

New independent coverage: `text-engine/tests/chains.rs` tests every engine
and ABI query on never-made and freed handles, empty/newline-only text,
primary-covered text, borrowed text, valid zero/empty/live controls and
valid→invalid→valid recovery. `src/lib/text-engine/chains.engine.test.js`
checks the same wrappers on the actual rebuilt wasm and allocation balance
when `lineFonts` refuses. Focused worker runs passed this matrix on the code committed as
`1deb27a1fde510ff78144df5abe2cbd445d64550`; measured results follow. [M]

### Mutation provenance

The original25 definitions (14 Rust,11 JS) are preserved intact in
`tp-data/reports/resume-20261009/p8c-mutations-prep/catalog.json` and
`originals/`. Their old assertion kills are prior-worker evidence, not a
fresh proof of this candidate. The original c23 first failed to apply;
its corrected strip-count substitution was repeated and killed its test.
Both outcomes are preserved. The moved shared chain check makes c12's
old `line_fonts`-only substitution obsolete; its equivalent current-policy
mutation must be labeled as a retarget, not reported as the old source
mutation. New chain-policy and buffer/recovery mutations will be listed
with their exact candidate revision and named failed assertions. [I]

### Focused worker verification [M]

Code committed as `1deb27a1fde510ff78144df5abe2cbd445d64550`; report/RULES
edits were pending during the run and do not affect the engine build.
One command at a time; load4.36–4.49 before each command.
Logs and full arguments: `tp-data/reports/resume-20261009/p8c-worker-focused/results.json`.

| command | measured result |
|---|---|
| `cargo fmt --manifest-path text-engine/Cargo.toml --check` | Clean |
| `cargo test --manifest-path text-engine/Cargo.toml --test chains` |4 passed |
| Same with `--no-default-features` |3 passed |
| `npm run build:engine` |1,611,167 bytes; SHA256 `c073ae5ac4c764988655fa6a46e040f782db9182a875b1e106f386de11f8f1ab` |
| `vitest run` with the new chain file and original five P8 JS targets, `--maxWorkers=1 --no-file-parallelism` |6 files,82 tests passed |

The target files were `chains.engine.test.js`, `drawn-face.engine.test.js`,
`variable-font.engine.test.js`, `package-fonts.test.js`,
`package-fonts.engine.test.js` and `exporter-fonts-gate.test.js`.
These focused proofs precede the P7 integration merge and are not full-tree
acceptance. No mutation, capture, full suite or final review ran in this worker window.

The new13 semantic mutation definitions and exact-revision scratch runner
are prepared at `tp-data/reports/resume-20261009/p8c-chain-mutations/`.
They cover the shared guard (labeled c12 retarget), its coverage/empty/metric
entry points, cleared engine runs, shared ABI output/result clearing and JS
status guards. None has been executed. The preserved original25 remain separate.

### Fresh Codex review corrections [M: focused worker proofs; combined acceptance pending]

The independent review of `d7dd4ac254bdcf699dd1f4b07cdf6744c8d5d788`
recorded seven reproducible gaps in
`tp-data/reports/resume-20261009/p8c-final-codex-findings.md`.
Those probes are **[M] for that earlier candidate** and are not fresh
source-build evidence. Fresh source/tests committed as
`2b18610158b815516e29c1afa1c4f05764271c9f` passed the focused worker
proofs below. The behavioral regression claims in this table are **[M]
for that candidate**, while final combined-source acceptance stays pending.

| review gap | correction and focused regression [M] |
|---|---|
| Ordinary nested PSD font failure forgets outer completed files | Every writer supplies its completed count for ordinary failures as well as `EngineSwitched`. A nested local “nothing was written” claim is removed once an outer file exists. The PSD test downloads page11, rejects page22 and requires an accurate one-file message. Strip and native failures use the same count wrapper. |
| Native path/blob/dialog waits outlive the held engine | Checks follow native imports, path resolution, dialog, blob conversion and the actual completed write; the last pre-write check is immediately before `writeFileAtomic`. Tests pause each single-file wait and second-file streamed path/blob waits; a post-write change counts the completed file and suppresses Saved. These are simulated Tauri APIs, not an observed desktop run. |
| Default/named/unnamed locations collide | Named names are compared after capping against the default and other named places. Coordinate and hash spellings are reserved for generated places; a generated name colliding with default uses an exact-location hash. Native and wasm tests construct default/stated/style/coordinate collisions in memory and require three names plus deterministic recovery. Hash collision freedom is not mathematically promised. |
| Invalid ID6 falls back to invalid or overlong family names in PSD | Primary and borrowed engine fallback names are sanitized to allowed printable ASCII and capped to127 bytes with a hash of the full raw identity when altered. Actual PSD type-layer tests require valid, distinct, deterministic primary and borrowed names. The browser's previous constructor stays in its original path and has a compatibility assertion. |
| Non-ASCII family hides valid stated names | Prefix construction always has a usable fallback from ID6 or `Font`, so stated names are checked regardless of ASCII family text. Native and wasm tests require `Test-Heavy` at700 and a separate valid650 name for family `漢字`. |
| Package source replacement/pending/give-up misreports fonts | A new identity getter is read before/after a bounded family wait. Replacement waits repeat; same-source rejection or pending readiness becomes a visible inspection failure. Statuses are read synchronously inside the settled identity check, before another await can apply that check to a replacement. Pending families never count as drawable in synchronous statuses. Tests cover replacement, rejected old wait, give-up, pending and unending changes, plus the existing default same-tick assertion. |
| Painter unknown chains bypass empty/no-paint returns | `paint_job_with` validates the shared chain before transform/size/run fast paths. Native and actual wasm tests cover no runs, zero size, singular transform, empty run and no fill; zero/live empty controls, stale-result refusal and valid raster recovery remain covered. |

No Photoshop identity lookup, native OS dialog/write interaction or
second-machine package observation is claimed by these regressions.

Fresh worker logs and exact commands:
`tp-data/reports/resume-20261009/p8c-worker-review-focused/*.json`.
Each command started with load2.78–3.01 and ran sequentially.

| focused command on `2b18610158b815516e29c1afa1c4f05764271c9f` | result [M] |
|---|---|
| Engine fmt check | Clean |
| Native chains + instance tests |5 +18 passed |
| Same with `--no-default-features` |3 +18 passed |
| `npm run build:engine` |1,614,463 bytes; SHA256 `2a4651940d4c0a47dcb457a85e4ab8c3a45e34afde7136332d355ab9c2fdbf24` |
| Original five P8 JS targets plus chain/painter file |6 files,98 tests passed |

The package replacement regression was subsequently strengthened with a
synchronous new-source call-count assertion before awaiting its signal.
This detects a removed identity retry with an assertion rather than a
five-second timeout. That assertion-only follow-up requires the coordinator's
scheduled repeat; no further worker tests ran after the proof window closed.

Fresh fourteen review-gap mutation definitions are prepared at
`tp-data/reports/resume-20261009/p8c-review-gap-mutations/` and match the
committed source substitutions exactly once. They remain separate from
both the preserved original25 and the new13 chain-policy definitions.
No mutation was executed; every future kill requires its exact-revision log
and named failed assertion.

### Final PSD identity interaction correction [I: new source; proofs pending]

The seven-fix review, pinned to `2b186101`, found three further measured
collisions in the final fallback path: family normalization aliased `Bad []`
and `Bad[]`; an invalid defaultID6 fell back to `Test`, also the valid named700
identity; real bold `Foo` and regular `Foo-Bold` shared one fallback string.
`p8c-seven-fixes-codex-findings.md` records **[M] request collisions**;
Photoshop substitution consequences remain **[I]**. The earlier source and
focused proofs do not establish this correction.

The new fallback always has a generated namespace and hashes the complete
unsanitized `[family, real slot, source identity, salt]` tuple. Normalization
only makes its readable prefix legal, and the complete name fits127 bytes.
The adapter's source identity contains a compact FNV-1a128 bytes fingerprint,
collection index and actual clamped variable place. It excludes reusable wasm
IDs, paint size and faux flags. No second font-byte copy is retained.
The fingerprint uses uint32 limbs instead of per-byte BigInt work; an
independent BigInt reference test covers carries and byte/view boundaries.
Hash collision freedom is not mathematically promised. [I]

Before returning a fallback, the adapter builds a complete set of parsed and
generated names reachable by the app's real regular/bold requests, including
variable instances not requested yet. A direct declared/generated alias moves
the fallback to a deterministic salted hash. The set is cached for the
registration state; any newly made instances share bytes and are removed with
their source slot. This prevents font-request order from changing names. [I]

`drawnFace`/`drawnRuns` expose source metadata only when called with
`{ source: true }`; raw default shapes and raw `fontInfo` names remain the
existing API. Primary and borrowed PSD fallback paths consume the same
metadata and retain their actual faux flags. The browser constructor remains
on its existing path. [I]

New tracked-fixture-only regressions in `psd-identity.engine.test.js` cover
all three collision reproducers, raw-family distinctions on identical bytes,
bytes replacement, shared collection indices, reloading/reallocation and
engine replacement, actual clamped locations, optional metadata, cleanup of
precomputed instances and direct named aliases in both request orders.
Existing PSD fallback validity/cap/borrowed/browser assertions are retained,
with the old bare engine fallback assertion updated to the generated name.
No tests/builds/probes ran in this repair window; the coordinator must pin and
verify the committed candidate before fresh review. [I]

This next candidate will stay frozen through its review. The previous
assertion-only package test follow-up moved HEAD during the seven-fix review;
that review is therefore evidence for the pinned production source and not
acceptance of its drifted test tree.

Fresh PSD-specific mutation definitions are prepared separately; original25,
chain13, seven-gap14 and changed-source retarget catalogs remain untouched.
Their changed fallback substitutions must be reported as obsolete or explicitly
retargeted, never silently counted as original-source kills.

### Final verification [not yet run]

The coordinator will fill this table from exact-revision logs after P7 is
merged into this feature. No capture equality or final suite count is
claimed here. Historical first/second-round proofs remain above.

| proof | revision and measured result |
|---|---|
| Engine rebuild and wasm SHA256 | Pending |
| Engine cargo tests, default and no-default | Pending |
| Engine fmt and clippy, three feature sets | Pending |
| Full Vitest | Pending |
| Tauri cargo tests with the required shared target directory | Pending |
| App build | Pending |
| Fresh default capture against `ref-sk/base` | Pending |
| Fresh Rust capture against `new/r4` | Pending |
| Original25 and current semantic mutation replay | Pending |
| Final independent Codex review | Pending |

### Scope and remaining desktop work

The chain integration changes `abi.rs`, `engine.rs`, `metrics.rs`, `wrap.rs`
and the low-level loader on this branch. The no-`abi.rs` statements above
refer to the first and second consumer rounds only. No typing component,
browser text path or painter pixel rule is changed by this integration fix.
No font binary was added or downloaded. No file from `tp-data` belongs in a
commit. [I]

The desktop/Photoshop/second-machine checks listed above remain unrun.
The old package/default built-in rules and the `ital`/`slnt`/`opsz` limits
remain. The P10 cut-over list is preserved; cut-over needs the user's word.
