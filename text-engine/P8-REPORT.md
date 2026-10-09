# P8: everything else that reads a font or draws text

Branch `tp/fonts`, on `58369aa4`. Brief: `tp-data/briefs/p8-consumers.md`.
Every figure is marked **[M]** measured here or **[I]** inferred.

With `textEngine: 'browser'` nothing is reached that was not reached before:
every new behaviour is behind `engineDraws()` (text-engine/index.js) or
`fontsGated()` (store.svelte.js:5201), and both are false there. The Skia
capture is byte for byte the base run [M].

| item | state |
|---|---|
| 1. PSD uses the engine's truth | done |
| 2. `.mtchapter` tells the truth about fonts | done, with the switch on; cut-over list below |
| 3. bench runs both engines | done |
| 4. variable fonts | `wght` fixed and measured; `ital`, `slnt`, `opsz` not read |
| 5. the audit | done; two callers left with the switch on |

No file of another worker was touched. `git diff --name-only 58369aa4..HEAD`
has no line of `TextBox.svelte`, `edit-lines.js`, `curve-caret.js`,
`scripts/editor-check.mjs`, `text-engine/src/paint/*`, `abi.rs` or
`abi_paint.rs` [M]. The variable-font commit added one new Rust file
(`text-engine/src/abi_instance.rs`) and one new JS file
(`text-engine/js/instance.mjs`), and changed `font.rs`, `engine.rs` and four
lines of `lib.rs`.

## 1. The PSD export

**Before.** `fontRequestFor` built a font name from the family the box
names: the PostScript name parsed from a user's file, or the family with a
suffix (`SysTwo-Bold`) for anything else. The faux flags came from the app's
font list, not from what was drawn. `buildPagePsd` waited on
`document.fonts.ready`. A missing font and a borrowed letter left no trace.

**Now**, when the engine draws:

| what | where |
|---|---|
| The name is name ID 6 of the font the engine holds for that weight and slant, user font or system font alike | `engineFontRequest`, psd.js:289; `drawnFace`, text-engine/drawn-face.js:32 |
| `fauxBold` / `fauxItalic` are what the adapter synthesised (`matchSlot`) | same |
| The wait is the P3c gate; a gate that gives up throws, so no file is written and the export's toast says why | psd.js:934; exporter.js:1293 |
| `document.fonts.ready` is awaited only when the browser draws | psd.js:936; exporter.js:1282, 1298 |
| Missing font: the layer names the last-resort face drawn, and its NAME ends ` [font missing: NAME]`. On a raster-only layer too. The importer strips the mark | psd.js:456, 518, 1126 |
| Borrowed letters: see the choice below | `borrowedRuns`, psd.js:479; `drawnRuns`, drawn-face.js:58 |

**Tests.** `src/lib/psd.engine.test.js` (14), `src/lib/psd-lines.realfont.test.js`
(1), four more in `src/lib/exporter-fonts-gate.test.js`.

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

Three type layers on those pages have empty text and no font (`line -1`).
They are boxes with no text. Not looked into.

## 2. The `.mtchapter` package

**Before.** `fontStatus` knew `builtin`, `present`, `install`, `missing`. A
font installed on the machine was `missing`. The export said nothing about
families that would not travel.

**Now**, with the switch on:

| what | where |
|---|---|
| `fontStatus`: `install`, `present` (user library), `system` (installed here), `missing` | package-flow.js:195, 204 |
| Families the chapter names and the manifest leaves out are listed too | `packageFontStatuses`, package-flow.js:225 |
| The export returns `{ path, staying }`; `staying` is `[{ name, why: 'system' or 'missing' }]` | `fontsStaying`, package-flow.js:73; `exportChapterPackage`, :95 |
| The toast names them | `stayingNote`, package-flow.js:82; ProjectView.svelte:50 |
| The import dialog counts "installed on this computer" | NewChapterDialog.svelte:149 |

No system font file is copied; a test holds that. The built-in list is not
removed.

**Tests.** `src/lib/package-fonts.test.js` (13). Five of them run with
`app.fonts.builtin = []`, in both modes: a package carrying a font under a
former built-in name installs it, and a font the user loaded under such a
name travels.

**In the audit session** [M]: 16 families, 15 shipped, 2,508,341 bytes.
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
| A font registered again at another place on its axes: shaping, advances, outlines, name | `FontEntry::instance`, font.rs:177; `Engine::add_instance`, engine.rs:206 |
| Outlines drawn at the entry's own coordinates | font.rs:244 |
| The instance's PostScript name, Adobe Technical Note 5902 | font.rs:344 |
| The export | `mt_font_add_instance`, abi_instance.rs:31 (new file) |
| The JS wrapper, with a "can this wasm do it" check | text-engine/js/instance.mjs (new file) |
| The rule: 400 and 700 inside the axis, faux bold only under 600 | `weightOnAxis`, rust.js:60; `weighted`, :130 |
| Instances removed with their face | `forgetWeights`, rust.js:142 |
| The rule written down | RULES.md, rule 13 |

It needed no painter file: the painter draws through
`FontEntry::draw_glyph`. `abi_instance.rs` is compiled with the `paint`
feature only, because `abi::with_engine` is; that `cfg` can go when `abi.rs`
is next opened. `ABI_VERSION` stays 2. A wasm without the export behaves as
before.

**Tests.** `text-engine/tests/instance.rs` (6),
`src/lib/text-engine/variable-font.engine.test.js` (13). Eight of the 13 and
five of the 6 read `/System/Library/Fonts/...` and say SKIPPED by name on a
machine without it.

## 5. The audit

`scripts/text-port/p8-audit.mjs`. It loads the app's own `index.html` from
its own Vite (5204), drives it over DevTools (9382), and installs its
counters before any script of the page. Mouse for select, move and resize;
the Inspector's own controls for font, size, bold and italic. Chapter
tsukimichi 121, 28 pages, 35 font faces of 15 families (the 16th, Bangers, has no file). Zero page errors [M].

**Switch off** [M]:

| call | caller | count |
|---|---|---:|
| `Range.getClientRects` | text-engine/browser.js:87 `wrapPlain` | 30,378 |
| `measureText` | browser.js:18 `advance` | 7,388 |
| `measureText` | browser.js:29 `lineInk` | 5,640 |
| `measureText` | browser.js:22 `fontBox` | 973 |
| `measureText` | browser.js:35 `glyphInk` | 102 |
| `fillText` | text-engine/browser-painter.js:110 | 120 |
| `strokeText` | browser-painter.js:105 | 120 |
| `document.fonts.check` | browser.js:118 `faceReady` | 10 |
| `document.fonts.ready` | exporter.js:1282 | 2 |
| `document.fonts.ready` | psd.js:936 | 1 |
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

Call sites the session did not reach, read from the source:

| site | reached when | who removes it |
|---|---|---|
| browser.js:119 `document.fonts.load` | browser measures, face not loaded | cut-over |
| browser-painter.js:87, 90 (curved text, glyph by glyph) | browser draws | cut-over |
| exporter.js:1298, psd.js:936 | switch on and no font the engine can read | cut-over |
| `TextBox.svelte`, 3 sites | editing a box | P7 |

Per-phase columns and the callers' callers: `tp-data/reports/p8/audit.md`.

## Choices the brief did not make

1. **Borrowed letters: a live layer, not raster-only.** The brief offered
   raster-only, or live with a marked name. Taken: live, name ends
   ` [letters from another font]`, and each borrowed stretch is its own
   `styleRun` with the lender's PostScript name and faux flags. Reason: a
   type layer can state a font per run, so the text stays editable and the
   statement is still true. Photoshop has not been seen to honour it.
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
- The fit phase found nothing to change: setting size 72 in the Inspector
  had already grown the box, and "Fit now" kept it.
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
| package-flow.js:114 | drop the filter; `families = named` |
| package-flow.js:197 | drop the `'builtin'` answer |
| package-flow.js:210-211 | drop `refused`; `if (f.shipped)` |
| package-flow.js:74, 196, 227 | drop the `fontsGated()` conditions: the engine's answers are the only ones |
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
   rule in font.rs:344 is to follow CoreText instead.
5. The same bold box on screen in Tauri (WebKit), switch off and on: is the
   engine's bold the weight WebKit draws of the installed font? WebKit was
   not measured.
6. Export a chapter that uses a system font: the toast names it as
   "installed here". Import the package on a second machine without that
   font: the dialog says missing; with it: installed on this computer.
7. Export with a font whose file is gone: the gate gives up, the toast says
   why, no file is written.
8. Run the audit's session by hand in Tauri with system fonts in use.

## Mutations

Each run in a scratch copy under `node_modules/.cache/p8/mut` [M].

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
| `./node_modules/.bin/vitest run` | 122 files passed, 1 skipped; 3,387 tests passed, 7 skipped (both skips are the env-gated capture and perf tests) |
| `cargo test` in `src-tauri` | 301 passed, 1 ignored |
| `cargo test` in `text-engine` | 102 passed (96 before) |
| `npm run build` | ok |
| capture `p8-sk` against `runs/ref-sk/base` | 1 file differs: `manifest.json` |
| capture `--engine new` `p8-new` against `runs/new/p6b-new2` | 1 file differs: `manifest.json` |
| both runs | deleted |

The tree does not hold `text-port` `e829744`: the Rust capture was compared
with `p6b-new2` as the coordinator asked.

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
