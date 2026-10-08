# P4 report: the Rust engine measures text for the app

Branch `tp/engine`. **[M]** measured in this work, **[I]** inferred. Distances
are over covered cases only (57,530 of 64,718 metric cases, 17,206 of 17,538
layout cases). The rules and their evidence are in `text-engine/RULES.md`;
this report is the summary and the figures.

## 1. What was built

- **`src/lib/text-engine/rust.js`**: `createRustTextEngine(wasmBytesOrModule,
  { rules })`, id `'rust'`, every seam method synchronous. `addFace(family,
  slot, bytes)`, `removeFamily`, `hasFamily`, `setFallbacks`, `fallbacks`,
  `setRules`, `rules`, `missing(face, text)`, `resolveFace`, `wrapPlain`.
  Face selection is slant first, then weight; a missing bold or italic is
  synthesised. An unregistered family: `faceReady` false, every measurement
  throws `font '<name>' is not registered`. A face key resolves to an engine
  handle through a `Map`, checked on a hit against name, size, bold and
  italic; nothing is rebuilt per call.
- **The crate** (`text-engine/src`): the browsers' line box, ASCII whitespace
  measured as a space, `rand` off for measured text, WebKit's synthetic bold
  advance behind a switch, a rewritten `wrapPlain`, fallback chains, and the
  ABI for them (`ABI_VERSION` 2, `mt_rule_set`, `mt_chain_new`,
  `mt_chain_push`, `mt_chain_free`, flags on `mt_advance` and `mt_missing`).
  The module still imports nothing. No new crate, no network use.
- **Capture as `new`**: `node scripts/text-port/capture-node.mjs --data $D
  --engine new --run <id> [--rules boldAdvance=webkit] [--only layout]`. It
  loads the wasm (and fails with "run npm run build:engine" when it is not
  built), registers every face of `fonts.json`, and installs the engine before
  anything measures. Plain mode and `shape: 'off'` are captured, not skipped:
  the probe skips them only when the installed engine cannot break plain text.
- **Tests**: a fourth vitest lane, `engine` (`*.engine.test.js`), which fails
  with "run npm run build:engine" when the wasm is absent [M: checked by
  moving the wasm aside: 2 files failed, exit 1].
- **`text-engine/RULES.md`**, and seven comparison scripts in
  `text-engine/parity/` (`distance`, `by-tag`, `three-way`, `overflow`,
  `explain-advance`, `fontbox`, `harfbuzz-data`; `runs.mjs` is their reader).

Checks [M]:

| check | result |
|---|---|
| `new` capture, whole corpus | 64,718 + 17,538 + 3,732 cases, 0 skipped, 0 errors, 25.7 to 26.4 s over four runs |
| two `new` runs byte-identical | yes, under each bold rule (`e0`/`e1`, `e0w`/`e1w`): the three `.jsonl` files and every PNG |
| `ref-sk` capture byte-identical to `$D/runs/ref-sk/base` | yes: `metrics.jsonl`, `layout.jsonl`, `pixels.jsonl` and 3,401 PNGs (captured into `$D/reports/p4-skcheck`, since `runs/ref-sk` is not mine to write) |
| `cargo test` | 3 + 27 + 5 passed |
| `cargo clippy --all-targets -- -D warnings`, also `--no-default-features` | clean |
| `vitest run`, before | 76 files passed, 1 skipped; 2,637 tests passed, 7 skipped |
| `vitest run`, after | 78 files passed, 1 skipped; 2,678 tests passed, 7 skipped (the 41 new ones are the engine lane; no existing test was edited) |
| harfrust against HarfBuzz, fixture fonts, `--stress` | 0 mismatches |
| same output in two processes (`parity/bench.mjs`) | identical |
| `advance` from JS | 0.88 to 1.03 µs for a 20-character line across the four fixture fonts; 300 uncached calls p95 0.30 to 0.33 ms (one run, busy machine) |

The seam interface (`src/lib/text-engine/index.js`) is unchanged, and so are
`measure.js`, the browser engine and `text-engine.test.js`. The one change to
shared harness code: `probe()` takes a `plain` option (default: what `browser`
was), and its skip message is unchanged.

## 2. Distances

`new/e0` is the engine with default rules, `new/e0w` the same with
`boldAdvance=webkit`. The last row of each table is the two browsers against
each other. All [M].

**Advance**, 57,530 cases:

| | p50 px | p99 px | max px | within 0.02 px |
|---|---|---|---|---|
| `new/e0` to `ref-sk` | 0.002 | 2.884 | 37.25 | 96.25% |
| `new/e0` to `ref-cr` | 0.000 | 0.300 | 37.25 | 98.46% |
| `new/e0` to `ref-wk` | 0.000 | 39.11 | 121.25 | 61.70% |
| `new/e0w` to `ref-wk` | 0.000 | 0.000 | 20.00 | 99.93% |
| `new/e0w` to `ref-cr` | 0.000 | 39.11 | 121.25 | 60.57% |
| `ref-cr` to `ref-wk` | 0.000 | 39.11 | 121.25 | 60.56% |

On the 31,156 cases no special rule touches, the engine is within 0.0012 px of
both browsers. Everything else has a named cause (RULES.md rules 7 and 8):
WebKit's synthetic bold, Chromium shaping word by word and cutting the font
size to two decimals, `rand`, WebKit's no-break space, and one kerning pair
where the Rust shaper differs from HarfBuzz.

**Font box**, 57,530 cases:

| | ascent p50 / max px | descent p50 / max px | identical |
|---|---|---|---|
| `new` to `ref-sk` | 0.204 / 32.4 | 0.286 / 40.0 | 25% / 14% within 0.02 px |
| `new` to `ref-cr` | 0.000 / 0.000 | 0.000 / 0.000 | 100% |
| `new` to `ref-wk` | 0.000 / 0.000 | 0.000 / 0.000 | 100% |
| `ref-cr` to `ref-wk` | 0.000 / 0.000 | 0.000 / 0.000 | 100% |

The browsers' rule was reproduced exactly: 66 of 66 fonts, every size, no
residual, no font left out. It is `hhea` always, sign of the descender
dropped, `-head.yMin` for a zero descender, each value rounded half up to a
whole pixel, scaled exactly for CFF fonts and through a 16.16 ratio for
TrueType fonts.

**Ink edges**, 56,955 line boxes, p50 / p99 px and share within 0.5 px:

| | left | right | ascent | descent |
|---|---|---|---|---|
| `new/e0` to `ref-sk` | 0.55 / 9.0, 45% | 0.57 / 3.9, 44% | 0.52 / 1.8, 48% | 0.50 / 1.7, 50% |
| `new/e0` to `ref-cr` | 0.02 / 1.3, 96% | 0.02 / 1.2, 97% | 0.00 / 0.7, 98% | 0.00 / 0.9, 98% |
| `new/e0w` to `ref-wk` | 0.64 / 15.7, 43% | 1.08 / 13.6, 28% | 0.03 / 1.5, 84% | 0.15 / 13.3, 78% |
| `ref-cr` to `ref-wk` | 1.08 / 28.0, 32% | 1.26 / 22.6, 28% | 0.01 / 1.7, 84% | 0.06 / 13.3, 77% |

The engine's exact outline box is Chromium's rule. WebKit reports the advance
box horizontally, so no engine can be near both; a tight gate on ink is not
meaningful.

**Layout decisions**:

| | smart, identical lines (9,699) | plain, identical lines (7,447) | solver answers changed (60) | verdicts changed, smart / plain |
|---|---|---|---|---|
| `new/e0` to `ref-sk` | 9,648, 99.47% | not in `ref-sk` | 0 | 77 / none |
| `new/e0` to `ref-cr` | 9,645, 99.44% | 7,399, 99.36% | 0 | 6 / 3 |
| `new/e0` to `ref-wk` | 9,693, 99.94% | 7,322, 98.32% | 0 | 39 / 29 |
| `new/e0w` to `ref-wk` | 9,699, 100.00% | 7,322, 98.32% | 0 | 37 / 29 |
| `new/e0w` to `ref-cr` | 9,639, 99.38% | 7,399, 99.36% | 0 | 8 / 3 |
| `ref-cr` to `ref-wk` | 9,639, 99.38% | 7,285, 97.82% | 0 | 37 / 26 |

Where lines are identical the first baseline is identical to both browsers
(max 0.000 px). Verdicts follow the ink: the engine's are Chromium's (6 and 3
changed) and are as far from WebKit's as Chromium's own are. Curved text: all
266 cases put every glyph where WebKit does (max 0.000 px).

Plain mode, who stands alone on the 7,121 synthetic cases: all agree 6,958,
Chromium alone 38, WebKit alone 115, the engine alone 1, three answers 9. The
engine never keeps a line wider than its box (0 of 51,899 lines); `ref-wk`
does 63 times, up to 17.2 px, and `ref-cr` 8 times, up to 1.5 px.

## 3. Real chapters (ids `c.`)

2,298 boxes: 2,268 covered (1,942 smart, 326 plain) and 30 uncovered. [M]

| boxes that break their lines differently from `ref-wk` | covered (2,268) | uncovered (30) |
|---|---|---|
| `ref-cr` | 7 | 0 |
| engine, `boldAdvance=unchanged` | **6** | 0 |
| engine, `boldAdvance=webkit` | **0** | 0 |

There are not 20 to rank. The 6, all under `unchanged`, all the same cause:
the box is bold, the font has no bold face, and WebKit widens every glyph of a
synthesised bold by `size / 36`, so its lines hold fewer words.

| box | font | lines Chromium / WebKit / engine | cause |
|---|---|---|---|
| `c.deli-health__011.p15.bb136` | Battle Cry Regular 91 px bold italic | 3 / 4 / 3 | synthetic bold advance |
| `c.tsukimichi__122.p14.bb175` | SS Rosehip 40 px bold | 3 / 5 / 3 | synthetic bold advance |
| `c.tsukimichi__122.p16.bb203` | Arenzi 60 px bold | 3 / 3 / 3, other breaks | synthetic bold advance |
| `c.tsukimichi__122.p19.bb256` | FairyTale Regular 45 px bold | 4 / 4 / 4, other breaks | synthetic bold advance |
| `c.tsukimichi__122.p25.bb347` | Arenzi 40 px bold | 4 / 5 / 4 | synthetic bold advance |
| `c.tsukimichi__122.p25.bb348` | FairyTale Regular 40 px bold | 2 / 3 / 2 | synthetic bold advance |

Chromium's seventh (`c.tsukimichi__121.p22.bb437`, CCMeanwhile at 15.987 px,
10 lines against 11) is not bold; the engine agrees with WebKit there [M], and
the cause is Chromium cutting the font size to two decimals [I].

Chapter line advances within 0.02 px of `ref-wk` (2,386 lines): 98.24% under
`unchanged`, 99.96% under `webkit` (one line left, 0.30 px, the DaftBrush
Text kerning pair below). The 30 uncovered boxes break as WebKit breaks them
although the engine measures a `.notdef` box where WebKit measured a system
font's letter.

## 4. Decided

1. **Line box:** the browsers' (`hhea`, whole pixels, CoreText's scaling), not
   Skia's. Zero residual on every font.
2. **Whitespace:** tab, LF, FF, CR are measured as a space.
3. **Advance:** unrounded, whole line in one run.
4. **`rand` is off** for everything measured. WebKit's number exactly; a width
   that depends on what else was shaped cannot be laid out against.
5. **Ink:** exact outline boxes (Chromium's rule).
6. **`middle`:** `(a - d) / 2` unrounded; p50 0.30 px from WebKit, 1.20 px
   from Chromium, and the browsers are 1.20 px from each other.
7. **No-break space:** the font's own glyph (Chromium, Skia), not WebKit's
   substitution of the space width.
8. **`wrapPlain`:** UAX #14 untailored, hanging spaces, a long word moved then
   cut, a cut piece and what follows it measured as drawn. None of the
   browsers' over-wide or empty lines was copied.
9. **Fallback:** primary face first, then the font the run is in, then list
   order; a mark stays with its base; parts shaped apart.
10. **Font size:** the size given, not Chromium's two decimals.

## 5. Left open

1. **`boldAdvance`** is a switch and was not decided, as asked: 6 real boxes
   against 0, and `webkit` is 99.93% within 0.02 px of today's macOS advances
   where `unchanged` is 61.70%.
2. **harfrust 0.14 differs from HarfBuzz on 5 kerning pairs** in two user
   fonts (DaftBrush `AW Aw aW aw`, DaftBrush Text `n?`; 11 or 12 font units;
   one chapter line, 0.30 px, no break changed). Both browsers give HarfBuzz's
   number. The fonts list a second glyph twice in a GPOS pair set. Not reduced
   further, not reported upstream. Found by `parity/harfbuzz-data.mjs`: 355 of
   974,700 ASCII pairs differ in 4 of 108 faces, and the other 350 (orangefizz,
   a legacy `kern` table) are harfbuzzjs being the odd one.
3. **An unknown font name is not always refused.** The store resolves it to
   the fallback family's CSS, `measure.js` keys its memo by that CSS, and a
   string the fallback family already measured is answered from the memo
   without reaching the engine. Pinned in `measure.engine.test.js`; it belongs
   to the task that gives the app its font-missing state, and `measure.js` was
   not to be changed here.
4. **`middle`:** WebKit's exact rule (`floor((A + D) / 2) - D`) is available
   now and was not taken, to keep the one number that would jump with size.
5. **Windows.** Both browser captures are from macOS, so the line box and
   Chromium's advances are CoreText's. What DirectWrite reports is not in the
   data [I].
6. **The painter is still Skia.** Pixel cases are Rust layout under Skia
   paint; Skia still applies `rand` and knows nothing of WebKit's bold
   advance, so `boldAdvance=webkit` with this painter is untested for pixels.
   Synthetic bold's join (SPIKE.md risk 4) is still open.
7. **Letter spacing in plain mode** is from the CSS rule and unit tests: the
   corpus has no plain-mode case with letter spacing.
8. **Fallback** has no reference to be compared with, no script itemisation
   and no bidi; where system font bytes come from is the later task.
9. **Pancake Pen** kerns one pair against the space; both browsers leave it
   out, the engine applies it (8 cases, 0.40 px).
10. **`ref-sk` residual** (96.25% of advances within 0.02 px) was not broken
    down beyond the tab and `rand`; it is the test lane.
11. SPIKE.md's size and determinism-hash figures describe the spike's build;
    the wasm is now 1,840,027 bytes. The wasm's hash changes when a source
    line moves, because panic messages carry line numbers.

Realfont tests that pin a Skia-only number or need Skia's raster, left on Skia
and not repeated in the engine lane (`src/lib/measure.realfont.test.js`):

- `measures the face, not the stand-in`: `lineWidth` equal to Skia's own
  `measureText` to 3 decimals.
- `resolves every family through the store, unknown names to the fallback
  font`: an unknown name measures as Comic Neue; the Rust engine throws.
- `lays a tab out as one space, which is not what this canvas measures a tab
  as`: asserts Skia's tab is wider than a space.
- The blocks `real glyph ink stays inside the box` and `boxInkRect is the ink
  the exporter paints` (including `paints a tab as the space it was laid out
  as`): they read ink off the exporter's raster, which is Skia until the
  painter phase.
- `solver-perf.realfont.test.js` and `typeset-bench.realfont.test.js`: timing
  of the Skia path.

Every other expectation of `measure.realfont.test.js` (first block),
`auto-layout.realfont.test.js` (all 8) and `edit-lines.realfont.test.js` (all
4) passes unchanged on the Rust engine [M].

## 6. In the references, things that look like capture bugs or accidents

- `ref-cr` was captured on macOS though it stands for Windows.
- Chromium measures a canvas font of `20.9834…px` at 20.98 px: 322 chapter
  lines in 15 fonts are up to 0.52 px narrower than in WebKit for that reason.
- Chapter metric cases with a synthesised bold are not tagged `faux-bold` (41
  covered lines, up to 121 px from `ref-wk`).
- `ref-sk` measures a tab as a glyph, and shapes DaftBrush with random
  alternates, so its DaftBrush widths are a third set of numbers.
- WebKit in plain mode gives a space its own empty line when a letter is
  wider than the box (54 cases, one font), keeps lines up to 17 px wider than
  the box, and accepts a line 1/64 px over. That is its layout, not the
  capture.
- WebKit measures U+00A0 with the width of U+0020 (34 cases, 5 fonts).

## 7. Data written

Under `$D/runs/new/`: `e0`, `e1` (default rules), `e0w`, `e1w`
(`boldAdvance=webkit`); `a0` to `d1` are earlier steps of this work and can be
deleted. Under `$D/reports/`: `p4-distance-*.txt`, `p4-bytag-*.txt`,
`p4-explain-advance.txt`, `p4-fontbox.txt`, `p4-harfbuzz-data.txt`,
`p4-overflow-*.txt`, the capture logs, and `p4-skcheck/` (hard links to the
fonts and the corpus, with the `ref-sk` check runs).

## 8. Commits

```
659fdd6 feat(text): the rust engine sits behind the measuring seam, and the corpus is captured on it
0ba5b4d feat(text): the engine's line box is the browsers', and its other rules are set from the captures
859a394 feat(text): a cut word is measured as it will be drawn, and measured text never shapes at random
d8b5eec test(text): the engine's rules, its breaker and its fallback are pinned on the fixture fonts
4887b30 feat(text): scripts that say where a capture differs from the browsers, and why
532b9b7 docs(text): the rules the engine measures by, each with what the browsers do and how far it is from them
```

and the commit that adds this report. Nothing was pushed.
