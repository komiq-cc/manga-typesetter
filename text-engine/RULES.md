# The rules the text engine measures by

Phase P4 of the text port. Each rule below says what the three reference
captures do, what the engine does, why, and how far the engine is from each
reference. SPIKE.md section 6 describes Skia only; where the two differ, this
file is the one in force.

**[M]** is a number measured in this work, **[I]** is inferred. Distances are
over the *covered* cases of the corpus (57,530 of 64,718 metric cases; a case
is uncovered when its face lacks one of its letters and the host's fallback
font was measured instead).

The references, all captures of the same corpus:

| id | what it is |
|---|---|
| `ref-sk` | node with Skia (`@napi-rs/canvas`): the test lane only |
| `ref-cr` | Chromium 152, captured on macOS |
| `ref-wk` | Safari 27 (WebKit): what the app shows on macOS today |

The engine's captures are `new/e0` (default rules) and `new/e0w` (the same
with `boldAdvance=webkit`), wasm sha256 `f6c0650d…f13644`. To reproduce any
table: `TP_DATA=<data dir> node text-engine/parity/<script>.mjs` (each script
says what it takes at its top).

Two rules are switches (`engine.setRules`, `--rules` on the capture):

| switch | values | default |
|---|---|---|
| `boldAdvance` | `unchanged`, `webkit` | `unchanged` (not decided, see rule 7) |
| `fontBox` | `browser`, `skia` | `browser` |

## 1. Whitespace in a measured string

- **Chromium, WebKit:** a canvas replaces tab, LF, FF and CR with a space
  before it measures, as the HTML standard says. [M: the 528 `tab` cases
  measure as the same string with a space in both.]
- **Skia:** measures the tab as a glyph of the font, usually `.notdef` or a
  wide blank. [M]
- **Engine:** what the browsers do. `advance`, `lineInk`, `glyphInk`,
  `wrapPlain` and `missing` treat U+0009, U+000A, U+000C and U+000D as U+0020.
  The raw run (`shape`, `shapeUnits`) still shows the font's own answer.
- **Distance [M], `tab` cases:** to `ref-wk` 0.000 px max under
  `boldAdvance=webkit`; to `ref-cr` 98.48% within 0.02 px (the rest is rule 8,
  not the tab); to `ref-sk` 10.23% within 0.02 px, p50 6.2 px, which is the
  point.

## 2. Advance, and its rounding

- **Chromium, WebKit:** unrounded. Both report a 32-bit float; neither snaps
  to 1/64 px or to 0.01 px. [M: 20,000 of 20,000 advances are exact float32
  values in each; 6% and 4% happen to be multiples of 1/64.]
- **Skia:** rounds what it reports to about 0.01 px (SPIKE.md). [M]
- **Engine:** the shaped run's advances summed in integer font units, scaled
  once, in 64-bit floats. No rounding.
- **Distance [M]:** on the 31,156 cases that involve none of the rules below
  (no synthesised bold, tab or no-break space, not one of the fonts of rule 8):
  to `ref-cr` p50 0.00002, p99 0.0003, max 0.0012 px; to `ref-wk` p50
  0.0000006, p99 0.00009, max 0.0010 px; the browsers from each other p50
  0.00002, max 0.0012 px. 100% within 0.02 px in all three.
- Everything further than that from a browser has a named cause: rule 7
  (synthetic bold) and rule 8 (how a line is shaped). The whole corpus:

  | covered advances within 0.02 px | share |
  |---|---|
  | `new/e0` to `ref-cr` | 98.46% [M] |
  | `new/e0w` to `ref-wk` | 99.93% [M] |
  | `new/e0` to `ref-wk` (bold rule not WebKit's) | 61.70% [M] |
  | `new/e0` to `ref-sk` | 96.25% [M] |
  | `ref-cr` to `ref-wk` | 60.56% [M] |

## 3. Line box (`fontBox`)

This is the rule that decides layouts: every baseline and every block height
comes from it.

- **Chromium and WebKit report the same ascent and descent on every covered
  case** [M: 0 differences in 57,530 cases, 2,049 face and size pairs], whole
  pixels both.
- **What they do** [M, `parity/fontbox.mjs`]:
  1. The table is `hhea`, always. Six of the user's faces set
     `USE_TYPO_METRICS` with typo values that differ from `hhea`; both
     browsers still report `hhea` for all six.
  2. The sign of the descender is dropped: one face (dogicapixel) states its
     descender above the baseline and is reported with that magnitude below.
  3. A descender of zero is replaced by the depth of the font's glyph box,
     `-head.yMin` (one face, Malkuns).
  4. The value is scaled to the font size, and ascent and descent are each
     rounded half up to a whole pixel, separately.
  5. The scaling depends on the outline format. A CFF font is scaled by plain
     arithmetic, `units * size / unitsPerEm`. A TrueType font goes through a
     16.16 fixed-point ratio first, `round(units * 65536 / unitsPerEm) / 65536
     * size`, which lands a hair under an exact half and rounds it down (Bebas
     Neue, 900/1000 at 25 px: 22.5 becomes 22).

  | arithmetic | CFF faces (2,534 values) | TrueType faces (1,564 values) |
  |---|---|---|
  | exact | **0 misses** | 4 misses |
  | 16.16, rounded down | 32 misses | 2 misses |
  | 16.16, rounded to nearest | 31 misses | **0 misses** |

- **Skia:** the ladder `hhea`, then OS/2 typo, then OS/2 win, with
  `USE_TYPO_METRICS` honoured, unrounded (SPIKE.md rule 3).
- **Engine:** the browsers' rule, steps 1 to 5 (`fontBox: 'browser'`).
  `fontBox: 'skia'` keeps the spike's rule for comparison with the test lane.
- **Why not stay resolution independent:** the brief preferred an unrounded
  box unless layouts change. They do. `new/e0` and `ref-sk` break 9,648
  smart-mode cases identically and differ there in the line box only: the
  first baseline is more than 1 px apart in 406 of them (p50 0.13, p99 2.8,
  max 10.5 px), and 77 containment verdicts differ, against 6 between
  `new/e0` and `ref-cr`. [M] With the browsers' box the baseline of every
  case with identical lines is the browsers' (`baseY` max 0.000 px against
  both [M]).
- **Residual per font [M]:** none. 66 of 66 fonts, every size in the corpus,
  0.000 px from both browsers (`parity/by-tag.mjs new/e0 ref-cr`).
- **Fonts where the rule cannot be reproduced:** none in this corpus.
- **What rests on few data points [I]:** the choice between the three
  scalings is decided by the ties only: 4 TrueType values and 31 CFF values.
  Steps 2 and 3 each rest on one face. An ascender of zero, and a face with no
  usable `hhea`, do not occur in the corpus; the engine mirrors step 3 for the
  first and falls down Skia's ladder for the second.
- **Platform [I]:** both browser captures were taken on macOS, where both go
  through CoreText; the 16.16 detail is CoreText's. What Chromium reports on
  Windows (DirectWrite) is not in the data. The engine gives the macOS numbers
  on every machine.

## 4. Ink boxes

- **Chromium:** the exact box of the outline, unhinted, as 32-bit floats.
- **WebKit:** vertically the outline's box in steps of 1/64 px. Horizontally
  it reports the *advance* box, not the ink: left is the line's origin and
  right is its width, widened only where a glyph overhangs. So its left and
  right say nothing about side bearings, and leading spaces count as ink.
- **Skia:** whole pixels of a hinted raster (SPIKE.md section 5).
- **Engine:** the exact outline box (SPIKE.md rule 6), which is Chromium's
  rule. No systematic offset from both browsers was found, because the
  browsers do not agree with each other on what the box is.

  | line ink, covered [M] | left p50 / p99 | right p50 / p99 | ascent p50 / p99 | within 0.5 px (left) |
  |---|---|---|---|---|
  | `new/e0` to `ref-cr` | 0.022 / 1.26 | 0.021 / 1.15 | 0.000 / 0.67 | 96.31% |
  | `new/e0w` to `ref-wk` | 0.637 / 15.7 | 1.083 / 13.6 | 0.031 / 1.51 | 43.13% |
  | `new/e0` to `ref-sk` | 0.554 / 9.03 | 0.565 / 3.91 | 0.520 / 1.79 | 45.44% |
  | `ref-cr` to `ref-wk` | 1.080 / 28.0 | 1.255 / 22.6 | 0.013 / 1.71 | 32.21% |

- A tight gate on ink is not meaningful: the two browsers are 1.1 px apart at
  the median and tens of pixels apart at the tail. The engine is closer to
  Chromium than either browser is to the other.
- The remaining distance to Chromium (p99 about 1.2 px, max 20 px) is rule 8
  (the same lines whose advance differs) and synthetic bold and italic, whose
  outlines Chromium draws with Skia's miter join (SPIKE.md risk 4, still
  open). [I: not broken down further.]

## 5. `middle` baseline

Where the alphabetic baseline sits when a glyph is asked for with
`textBaseline = 'middle'`; it enters `glyphInk`, which only curved text uses.

- **Chromium:** the middle of the em box, with the em split in the proportion
  of the OS/2 typo ascender and descender:
  `(typoAsc - typoDesc) / (typoAsc + typoDesc) * size / 2` above the baseline.
  [M: residual p50 0.005 px against that formula.]
- **WebKit:** `floor((A + D) / 2) - D`, with `A` and `D` the whole-pixel
  ascent and descent of rule 3. [M: residual p50 0.005 px.] It jumps by a
  pixel between neighbouring sizes.
- **Skia:** `ascent - round(ascent + descent) / 2` (SPIKE.md rule 4).
- **Engine:** `(a - d) / 2` with the *unrounded* `hhea` ascent and descent:
  WebKit's rule without its two roundings, so it moves smoothly with the size.
- **Distance [M], glyph ascent over 337,362 glyph boxes:** to `ref-wk` p50
  0.30, p99 1.47 px; to `ref-cr` p50 1.20, p99 9.6 px; the browsers from each
  other p50 1.20, p99 9.6 px. The engine is as far from Chromium as WebKit is,
  and a third of a pixel from WebKit.
- **Does it move anything?** Not the placement of curved glyphs: the 266
  curved cases put every glyph where WebKit does (x and y max 0.000 px [M])
  and within 3.3 px of Chromium, which is the browsers' own distance.
- **Open:** WebKit's exact rule is two lines of code now that rule 3 gives its
  integers. It was not taken because it is the one place a number would jump
  with the size; say so if exactness with today's macOS output matters more.

## 6. Spaces at the ends, empty and space-only strings

- **Advance:** spaces count wherever they are, in all references and in the
  engine. `lineWidth` in `measure.js` trims the end of the line before it
  asks, so a trailing space never reaches an engine from there. [M: the 1,048
  `spaces` cases are 100.00% within 0.02 px of `ref-wk`.]
- **Ink with leading spaces:** the engine's box is the union of the glyph
  boxes at their pen positions, so a leading space moves the ink and is not
  part of it. Chromium does the same [M: 520 cases, horizontal edges p50
  0.054, max 2.0 px]. WebKit and Skia pin the left edge to the line's origin
  [M: p50 19.7 and 18.3 px from the engine, and WebKit 19.5 px from Chromium],
  which is rule 4 again, not a rule about spaces.
- **Empty and space-only strings:** the engine answers a width (the advance)
  and a box of four zeros with `hasInk` false. No caller sees it: `lineInk`
  and `glyphInk` in `measure.js` return `null` for a line with nothing to draw
  before they ask any engine. The corpus has no such metric case, so the
  browsers' own answers were not captured. [I: by rule 4 WebKit would report
  the advance box and Chromium an empty one.]

## 7. Synthetic bold and italic: the advance

- **Synthetic italic:** the advance is the upright face's in all three
  references and in the engine. [M: 9,926 of 9,926 cases in each.]
- **Synthetic bold, Chromium and Skia:** advance unchanged. [M]
- **Synthetic bold, WebKit:** every glyph's advance grows by `size / 36`
  (0.2222 px at 8 px, 2.6667 px at 96 px). A ligature is one glyph and grows
  once. [M: with that rule the 22,182 `faux-bold` cases are 99.93% within
  0.02 px of `ref-wk`, and what is left is the no-break space of rule 8;
  without it 0.96%.]
- **Engine:** a named switch, `boldAdvance`, so that both can be captured.
  `unchanged` is Chromium's rule and the default; `webkit` adds `size / 36`
  per glyph to the advance, moves the ink of later glyphs with the pen, and is
  honoured by the breaker and by fallback parts.
- **Not decided here, on purpose.** What each choice does to real chapters
  (every lettered box of 11 chapters, 2,298 boxes) [M]:

  | boxes that break their lines differently from `ref-wk` | count |
  |---|---|
  | `ref-cr` (the two browsers against each other) | 7 |
  | engine, `boldAdvance=unchanged` (`new/e0`) | 6 |
  | engine, `boldAdvance=webkit` (`new/e0w`) | 0 |

  The 6 are the same boxes on which Chromium differs from WebKit for this
  reason, all with a synthesised bold: Battle Cry Regular 91 px bold italic,
  SS Rosehip 40 px bold, Arenzi 60 px and 40 px bold, FairyTale Regular 45 px
  and 40 px bold. Chromium's seventh is a CCMeanwhile box at 15.987 px, not
  bold, where the engine agrees with WebKit [M]; the cause is the font size
  Chromium cuts to two decimals (rule 8) [I: the size is fractional and the
  font is in that table; the box was not re-broken at 15.98 px to prove it].
- **What the choice is between [I]:** `webkit` keeps every existing macOS
  layout that uses a bold the font does not have; `unchanged` matches Windows
  and draws the bold letters closer, as the font spaces them. A bold drawn at
  WebKit's wider advances under a painter that emboldens as Skia does is
  untested until the painter phase.

## 8. How a line is shaped

The engine shapes the whole string in one HarfBuzz-compatible run (harfrust),
default features, script and direction guessed. Where a browser's advance
differs, it is one of these [M, `parity/explain-advance.mjs`, cases without a
synthesised bold; every differing case against `ref-cr` but one is explained]:

| cause | who does it | fonts, differing cases, worst | the engine |
|---|---|---|---|
| **Words shaped one at a time.** Chromium's canvas keeps a cache of shaped words, so nothing reaches across a space: no contextual form, no kerning against the space. | Chromium | SSGirlKisser 120 cases, 11.0 px (`calt` across spaces); Pancake Pen 8 cases, 0.40 px (one kerning pair against the space, which WebKit also leaves out) | whole line, as the font says. Agrees with WebKit on SSGirlKisser, with neither on the 8 Pancake Pen cases |
| **Random alternates (`rand`).** HarfBuzz applies them by default from a sequence that restarts with every buffer; Chromium does, per word. WebKit does not apply the feature. | Chromium | DaftBrush 223 cases, 37.2 px | `rand` off for everything measured. Agrees with WebKit on all 223. A width that changes with what else is in the buffer cannot be laid out against |
| **Font size cut to two decimals.** Chromium measures a `font` of `20.9834…px` at 20.98 px. | Chromium | 15 fonts, 322 chapter lines at fractional sizes, 0.52 px worst (CCVictorySpeech 112, CCMeanwhile 94, MangaMaster BB 30, ArtistsAlleyBB 24, Arenzi 18, BebasNeue 12, Gempita 7, CCMarianChurchland 6, SS Rosehip 6, Prince of Darkness 4, Battle Cry 3, and 1 or 2 lines in four more) | the size it was given. Agrees with WebKit |
| **No-break space measured as a space.** WebKit takes the width of U+0020 for U+00A0; these fonts give U+00A0 a different width. | WebKit | Heaters, JACKBRUSH, dogicapixel, YourHighschoolCrush, CCMarianChurchland: 34 of the 344 `nbsp` cases, 20 px worst | the font's own U+00A0. Agrees with Chromium and Skia |
| **Synthetic bold advance** (rule 7) | WebKit | every synthesised bold; Arenzi, VCR OSD MONO 1.001, SS Rosehip, FairyTale Regular, Battle Cry Regular, Wintersoul, orangefizz in the chapters | the switch |
| **A kerning pair the font states twice.** | the engine | DaftBrush Text `n?`: 1 chapter line, 0.30 px | see below |

The fonts the coordinator asked about:

| font | odd one out | the engine agrees with | cause |
|---|---|---|---|
| SSGirlKisser | Chromium | WebKit | words shaped one at a time; the font's `calt` looks across spaces |
| DaftBrush | all three differ | WebKit (222 of 222 within 0.05 px with `rand` off) | `rand`: Chromium rolls per word [M]; Skia's numbers are a third set [M], per line [I] |
| Arenzi, VCR OSD MONO 1.001, SS Rosehip, FairyTale Regular | WebKit | Chromium by default, WebKit under `boldAdvance=webkit` | the chapter lines in these fonts are bold and the fonts have no bold face; nothing in the font itself |

**harfrust against HarfBuzz on the user's fonts** [M,
`parity/harfbuzz-data.mjs`]: every pair of printable ASCII in every one of the
108 faces, 974,700 pairs. 355 differ, in 4 faces:

- orangefizz regular and italic, 350 pairs: the font kerns with a legacy
  `kern` table only. The engine applies it; harfbuzzjs 1.6.2 does not. Both
  browsers agree with the engine (107 of 109 corpus cases that hold such a
  pair). The reference is the odd one here.
- DaftBrush (`AW`, `Aw`, `aW`, `aw`) and DaftBrush Text (`n?`), 5 pairs: the
  engine kerns 11 or 12 units tighter than HarfBuzz, and both browsers give
  HarfBuzz's number on the one corpus line that holds such a pair. In both
  fonts the GPOS pair set of the first glyph lists a second glyph twice (in
  DaftBrush Text, `n` + `?` is there as -75 and as -63; the engine applies
  -87, HarfBuzz and the browsers -75). **Open:** this is harfrust 0.14
  reading a malformed pair set differently from HarfBuzz; it was not reduced
  further or reported upstream.

## 9. `wrapPlain`

The CSS being imitated is `white-space: pre-wrap; word-break: break-word;
overflow-wrap: break-word`, with `letter-spacing`, and the trimming
`browser.js` did on each line (the adapter does the same).

What the engine does (`src/wrap.rs`):

1. **Break opportunities:** UAX #14 as `unicode-linebreak` implements it. No
   tailoring was needed: no case in the corpus differs from both browsers
   because of where a break is allowed. [M]
2. **Hanging spaces:** spaces at the end of a line are not counted against the
   width, however many.
3. **Greedy fill** from the advances of the paragraph shaped once, with a
   slack of 1/128 px so that a line that exactly fills its box fits.
4. **A word wider than the line** goes to the next line whole, and is cut only
   there: after the last letter that fits, never before a combining mark,
   always at least one letter. The piece is measured shaped by itself, and
   what follows the cut is shaped again from the cut, because a ligature or a
   kerning pair across the cut is gone once the line ends there.
5. **Letter spacing** is added after every letter of the line, the last
   included, and turns `liga` and `clig` off, as both browsers do. [I: the
   corpus has no plain-mode case with letter spacing (0 of 7,447), so this is
   from the CSS specification and unit tests, not from a capture.]

Identical lines, covered plain-mode cases (7,121 synthetic and the 326 boxes
of the plain chapter) [M]:

| | cases | identical | share |
|---|---|---|---|
| engine to `ref-cr` | 7,447 | 7,399 | 99.36% |
| engine to `ref-wk` | 7,447 | 7,322 | 98.32% |
| `ref-cr` to `ref-wk` | 7,447 | 7,285 | 97.82% |

The plain chapter: 326 of 326 identical to both. Who stands alone on the
synthetic cases (`parity/three-way.mjs`) [M]:

| all three agree | Chromium alone | WebKit alone | engine alone | three answers |
|---|---|---|---|---|
| 6,958 | 38 | 115 | 1 | 9 |

What remains different, and why. None of it was copied:

- **WebKit alone, 115.** (a) 54 cases in MumbleGrumbleIBB, whose letters are
  wider than the test boxes: WebKit gives the space between two words a line
  of its own, an empty line; the engine and Chromium hang it. (b) WebKit
  measures words one at a time, so a form that depends on the next word is
  not counted: in YourHighschoolCrush a lone `I` before a word becomes a wide
  crossbar `I`, and WebKit keeps `valley. I told you` (207.0 px drawn) on a
  line of 196 px. (c) The rest of a cut word is not measured again: it lets
  `sis` (61.2 px) stand in a 44 px box. (d) It accepts a line 1/64 px over
  (`Come back`, 116.0156 px in 116 px, VCR OSD MONO).
- **Chromium alone, 38.** It decides where to cut a long word from positions
  inside the uncut paragraph, so the kerning and ligatures across the cut are
  still counted.
- **Engine alone, 1; three answers, 9.** All ten are 40 px text in a box 60 px
  wide, one or two letters to a line, where each implementation's way of
  measuring a two-letter piece gives a different cut.
- **Lines wider than their box**, by the engine's measure of the line as it
  will be drawn (`parity/overflow.mjs`) [M]: `ref-wk` 63 of 51,909 lines of
  two letters or more, up to 17.2 px over; `ref-cr` 8 of 51,896, up to 1.5 px;
  the engine 0 of 51,899. That is the reason nothing above was copied: each
  remaining difference is a browser keeping a line the box does not hold.

## 10. Fallback for a letter the face lacks

No reference to compare with: a browser asks the system for a font, and the
harness has no system fonts. The `new` captures register no fallback, so the
7,188 uncovered metric cases measure the face's own `.notdef` and are judged
apart. The rule is pinned by unit tests on the fixture fonts.

- `setFallbacks([family, …])` on the adapter gives an ordered list of
  registered families. Each answers with the face CSS matching would pick from
  it for the weight and slant asked, synthesised where it has none.
- A line is cut where coverage changes. Each cluster, a letter with the marks
  that belong to it, is drawn from the face itself if the face can; else from
  the font the stretch before it is in, if that font can; else from the first
  font of the list that can; else it is the face's `.notdef`.
- A mark, a joiner, a variation selector or an emoji modifier never leaves its
  base letter, even when the face has the mark and not the letter.
- Each part is shaped by itself with its own font: no kerning across a change
  of font. `advance`, `lineInk`, `glyphInk`, `wrapPlain` and `missing` all go
  through the same parts; `missing` reports what no font of the list has.
- With no list, or when the face has every letter, there is one part and the
  numbers are bit for bit what they were (the fast path shapes with the face
  first and looks further only if a `.notdef` came out).

## What was looked at and found to be a property of a reference

- Both browser captures were taken on macOS. `ref-cr` stands for Windows in
  the plan, but its line box and its advances are CoreText's (rule 3).
- Chromium cuts the font size of a canvas `font` string to two decimals
  (rule 8). It moves a chapter line by up to 0.5 px and, by inference, one
  chapter box's breaks.
- The corpus does not tag chapter metric cases whose bold is synthesised as
  `faux-bold`: 41 covered chapter lines differ from `ref-wk` by up to 121 px
  for that reason alone (42 differ under `boldAdvance=unchanged`, 1 under
  `webkit`) and look like unexplained outliers until rule 7 is applied.
- `ref-sk` measures a tab as a glyph (rule 1) and shapes DaftBrush with
  `rand` on (rule 8); its ink boxes are whole pixels (rule 4).
- WebKit's empty lines and over-wide lines in plain mode (rule 9) are what the
  app shows on macOS today in those boxes; they are WebKit's line layout, not
  a capture error.
