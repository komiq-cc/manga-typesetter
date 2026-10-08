# Text engine feasibility spike

Branch `tp/engine`, crate `text-engine/` (package `mt-text`). October 2026.

Every number below is marked **[M]** measured here, or **[I]** inferred (from
source, documentation, or a pattern in measurements that was not itself tested).

Machine for all timings: Apple M5, macOS (darwin-arm64), node v26.3.0 (V8),
rustc 1.96.0. The machine was busy during the work (load average 4 to 10), so
timings are given as the range seen over several runs, not a single figure.

## 1. Verdict

**Keep the stack.** `harfrust` + `read-fonts`/`skrifa` + `tiny-skia` +
`unicode-linebreak` builds to one `wasm32-unknown-unknown` module with **no
imports**, no C or C++ and no wasm-bindgen, and it meets the measurement goals
with a wide margin. The fallback (`rustybuzz` + `ttf-parser`) is not needed.

| question | answer | |
|---|---|---|
| Does harfrust shape like HarfBuzz? | 0 mismatches in 40,264 strings, 83,234 glyphs, 6 fields each, against HarfBuzz 14.5.0 | M |
| Worst advance difference vs HarfBuzz | 0 font units | M |
| Worst advance difference vs Skia | 0.0080 px (target 0.02); Skia rounds to 0.01 px | M |
| Line box vs Skia | 0.0000 px over 40 font/size pairs, and the same table choice in 7 edited-table cases | M |
| wasm size | 1,827,741 bytes with the painter (575,924 gzip); 1,425,136 without | M |
| Time per uncached `advance` from JS | 0.9 to 1.25 µs for a 20-character line | M |
| 300 uncached advances | p95 0.29 to 0.38 ms on a quiet machine, against a budget of 8 ms | M |
| Same output in two processes | identical hash, also across every build variant | M |

Two things are **not** confirmed and should change the plan (details in
sections 5, 6 and 11):

1. REF-SK is a good reference for advances and the line box, and a poor one for
   ink boxes and pixels. Its boxes are whole pixels of a hinted raster, its
   `fillText` baseline moves by up to half a pixel with the font size, and its
   box for lines with leading or trailing spaces or missing glyphs is not the
   union of the glyphs. The engine reproduces the exact outline instead. The
   port needs tolerances per quantity, not one tolerance.
2. Synthetic bold in Skia uses a miter join; the engine's rule here is a round
   join. That is an open decision, not a measurement gap.

## 2. What was built

```
text-engine/
  Cargo.toml, Cargo.lock      package mt-text, cdylib + rlib, own lock file
  src/font.rs                 font registry entry: names, axes, vertical tables, outline bounds
  src/engine.rs               Engine: fonts, shaping (harfrust), advance
  src/metrics.rs              fontBox, lineInk, glyphInk, the synthetic style rules
  src/wrap.rs                 wrapPlain (UAX #14 greedy wrap)
  src/paint.rs                minimal painter (feature `paint`, tiny-skia)
  src/memory.rs               alloc/free for the ABI, counting allocator on wasm
  src/abi.rs                  the `mt_*` extern "C" exports
  tests/fixtures.rs           18 tests on the four fixture fonts
  tests/paint.rs              5 tests on the painter
  js/engine.mjs               hand-written loader, plain ESM, node and browser
  js/generated/               build output, gitignored
  parity/common.mjs           corpus: 4 fonts, 10 sizes, 65 strings
  parity/harfbuzz.mjs         REF-HB, exact comparison
  parity/skia.mjs             REF-SK report and rule tests
  parity/synth.mjs            synthetic bold and italic in Skia
  parity/bench.mjs            cost and determinism
  parity/paint.mjs            painter against Skia
scripts/build-text-engine.mjs wasm build, copy, manifest
```

The crate is not a member of `src-tauri`; nothing under `src/` or `src-tauri/`
changed. `package.json` gained the `build:engine` script and one exact
devDependency, `harfbuzzjs` 1.6.2 (bundles HarfBuzz 14.5.0).

Resolved versions (in `Cargo.lock`): harfrust 0.14.0 (a port of HarfBuzz
14.5.1), read-fonts 0.45.0, skrifa 0.48.0, font-types 0.12.6, tiny-skia 0.12.0,
unicode-linebreak 0.1.5. 27 packages besides the crate, all Rust.

Interface mapping, one export per engine call:

| interface | export | loader |
|---|---|---|
| `advance(face, text)` | `mt_advance` | `engine.advance` |
| `fontBox(face)` | `mt_font_box` | `engine.fontBox` |
| `lineInk(face, text)` | `mt_line_ink` | `engine.lineInk` |
| `glyphInk(face, text)` | `mt_glyph_ink` | `engine.glyphInk` |
| `shapeLine(face, text)` | `mt_shape` | `engine.shapeLine` (px, with clusters), `engine.shapeUnits` (raw font units) |
| `wrapPlain(face, text, {width, letterSpacing})` | `mt_wrap_plain` | `engine.wrapPlain` |
| `paint(spec)` | `mt_paint_begin/line/stroke/fill/end` | `engine.paint` |

Plus `mt_font_add`, `mt_font_add_sibling` (another face of a loaded file,
sharing its bytes), `mt_font_remove`, `mt_font_info`, `mt_missing`,
`mt_alloc`/`mt_free`, `mt_heap_live`, `mt_abi_version`.

ABI shape: text is written as UTF-8 into one reused buffer (`mt_text_reserve`),
results come back in a 16-slot `f64` buffer, a byte buffer, or the shaped run
(six 32-bit fields per glyph). Clusters are UTF-16 code unit offsets, so they
index a JS string directly. `mt_font_add` takes ownership of the bytes it is
given, so a font is held once.

Not built: script itemisation, font fallback, bidi, variable-font instances,
gradients, per-glyph placement on a path, WOFF decoding. `wrapPlain` is a first
cut with unit tests only; it was not compared with any reference.

## 3. How to build and run

Needs the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`).
All commands from the repository root unless a `cd` is shown.

```sh
# native: lint and tests
cd text-engine
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --no-default-features -- -D warnings
cargo test                         # 3 + 18 + 5 tests
cargo test --no-default-features   # 3 + 18, without the painter
cd ..

# wasm: writes text-engine/js/generated/mt_text.wasm and mt_text.manifest.json
npm run build:engine

# checks, all through the same wasm and the same loader
node text-engine/parity/harfbuzz.mjs            # REF-HB, exits 1 on any mismatch
node text-engine/parity/harfbuzz.mjs --stress   # 40,264 cases
node text-engine/parity/skia.mjs                # REF-SK tables, worst cases, rule tests
node text-engine/parity/synth.mjs               # synthetic bold and italic in Skia
node text-engine/parity/bench.mjs               # cost, memory, determinism
node text-engine/parity/paint.mjs               # painter vs Skia, PNGs in js/generated/paint/

# the app's own suite, unchanged: 70 files, 2600 passed, 6 skipped
./node_modules/.bin/vitest run
```

Build variants for the size table (output lands beside the default build):

```sh
MT_TEXT_NO_DEFAULT=1 MT_TEXT_OUT=nopaint.wasm            npm run build:engine
MT_TEXT_OPT_LEVEL=z  MT_TEXT_OUT=oz.wasm                 npm run build:engine
MT_TEXT_FEATURES=simd MT_TEXT_RUSTFLAGS="-C target-feature=+simd128" \
  MT_TEXT_OUT=mt_text.simd.wasm                          npm run build:engine
MT_TEXT_WASM_OPT=/path/to/wasm-opt MT_TEXT_WASM_OPT_LEVEL=-O3 \
  MT_TEXT_OUT=wasmopt.wasm                               npm run build:engine

MT_TEXT_WASM=mt_text.simd.wasm node text-engine/parity/bench.mjs   # any script, any variant
```

`wasm-opt` is not a dependency of the repository. The figures below used
binaryen 132.0.0 from a scratch directory.

The default build is reproducible on this machine: two builds gave the same
sha256, `7ac77c1fac5eb66239e1d677a273ac7dbd4e4f5ef88808d5e4f80ddd25dc7794` [M].

## 4. Parity with HarfBuzz (REF-HB)

harfbuzzjs 1.6.2 (HarfBuzz 14.5.0) and the engine shape the same text with the
same guessed segment properties and default features. Compared with `===` on
glyph id, cluster, x advance, y advance, x offset, y offset, in font units.

| run | cases | glyphs | mismatches | worst total-advance difference | |
|---|---|---|---|---|---|
| corpus (4 fonts x 65 strings) | 260 | 2,134 | 0 | 0 font units | M |
| `--stress` (all printable ASCII pairs; U+00A0 to U+024F alone and in context; combining marks) | 40,264 | 83,234 | 0 | 0 font units | M |

The corpus has kerning pairs, ligatures (`fi`, `ffl`), accented Latin, combining
marks, astral code points, missing glyphs, spaces, punctuation and comic
dialogue. It has no complex script (Arabic, Indic), no right-to-left text and
no vertical text: the four fixture fonts do not cover them. Agreement there is
**not** measured.

## 5. Parity with Skia (REF-SK)

`@napi-rs/canvas` 1.0.9 against the engine, 4 fonts x 10 sizes (8, 12, 14.5, 16,
22, 22.5, 30, 40, 64, 96 px) x 65 strings, plus 14 single glyphs with
`textAlign = "center"`, `textBaseline = "middle"`. Absolute differences in px.
All **[M]**.

| quantity | count | max | p99 | p50 |
|---|---|---|---|---|
| fontBoundingBoxAscent | 40 | 0.0000 | 0.0000 | 0.0000 |
| fontBoundingBoxDescent | 40 | 0.0000 | 0.0000 | 0.0000 |
| middle baseline shift | 40 | 0.2500 | 0.2500 | 0.1250 |
| advance (`measureText().width`) | 2600 | 0.0080 | 0.0050 | 0.0020 |
| actualBoundingBoxLeft | 2360 | 0.9920 | 0.9840 | 0.4800 |
| actualBoundingBoxRight | 2360 | 8.7188 | 1.2321 | 0.4799 |
| actualBoundingBoxAscent | 2360 | 2.5820 | 1.9219 | 0.5000 |
| actualBoundingBoxDescent | 2360 | 1.1160 | 1.0000 | 0.2400 |
| glyph left (center/middle) | 520 | 0.9930 | 0.9818 | 0.5172 |
| glyph right (center/middle) | 520 | 0.9940 | 0.9683 | 0.4800 |
| glyph ascent (center/middle) | 520 | 2.0425 | 1.7656 | 0.4360 |
| glyph descent (center/middle) | 520 | 1.2285 | 1.0200 | 0.1975 |

Lines where the two disagree by definition are reported apart:

| quantity | count | max | p99 | p50 |
|---|---|---|---|---|
| Left, leading or only spaces | 120 | 39.5625 | 39.5520 | 0.0000 |
| Right, leading or only spaces | 120 | 32.0640 | 30.5156 | 0.4719 |
| Ascent / Descent, leading or only spaces | 120 | 1.9219 / 1.0400 | 1.9219 / 0.8080 | 0 / 0 |
| Left, missing glyphs | 120 | 0.9840 | 0.9760 | 0.4063 |
| Right, missing glyphs | 120 | 126.9760 | 115.0000 | 0.9100 |
| Ascent / Descent, missing glyphs | 120 | 7.8320 / 11.8080 | 4.8880 / 7.8720 | 0.4883 / 0.1920 |
| glyph box of a space, each edge | 40 | 16.03 (x), 33.77 (y) | | 3.50, 7.42 |

### The worst cases, and why

`node text-engine/parity/skia.mjs` prints the 10 worst rows of every quantity.
They fall into five causes.

**Advance, worst 0.0080 px** (ComicNeue 8 px, "Sphinx of black quartz, judge my
vow": Skia 254.400, engine 254.408). Skia reports widths rounded to 0.01 px;
the engine returns the unrounded sum. All ten worst rows are this rounding.
`skia == round(engine, 0.01)` holds in 2574 of 2600 cases [M]. Of the other 26,
17 are ties at half a hundredth where Skia's 32-bit float decides the
direction, and 9 are long lines one 0.01 step off [M], which is consistent with
Skia adding 32-bit glyph advances while the engine adds integer font units
once [I].

**Ink box edges, up to 0.99 px (2 px and more on ascent)**. Skia's box is the
box of whole pixels its own raster touches, and that raster is hinted:

- every one of 2080 single-glyph edge values from Skia is an integer [M];
- it equals `ceil(engine)` for 1629 of them and lies *inside* the true outline
  for 363 [M], so it is not "outline rounded outward";
- Skia's reported box equals the box of the pixels Skia paints for 495 of 520
  glyphs, the rest are off by 1 px [M];
- worst ascent: DejaVu Sans "ÉCLAT" at 8 px is 10 px tall in Skia and 7.418 px
  in the outline. Grid fitting lifts the accent. Accents at 8 to 22.5 px account
  for all ten worst ascent rows [M].

The binary carries FreeType (the string `FREETYPE_PROPERTIES` is in it), so the
hinting is FreeType's [I].

**Right edge with a trailing space, up to 8.72 px** ("trailing " at 96 px).
**Left edge with a leading space, up to 39.6 px.** Skia does not report the
union of the glyph boxes. The pattern in 20 probes [M]: the left edge is the
first glyph's left bound and the right edge is the last glyph's pen position
plus its right bound, with a space counting as an empty box at its pen
position. So "trailing " ends at the advance of "trailing" (DejaVu 96 px:
337.734, ink 329.016; Bangers: 278.016, which is *inside* the ink at 285.112),
and " a" starts at 0. That this is exactly first-glyph/last-glyph is [I]; it
fits every probe. The engine returns the union of the ink.

**Missing glyphs, right edge up to 127 px.** Advances still agree (so Skia does
not fall back to a system font for the width). The box does not: for "a日" Skia
reports the box of "a" alone, for "日a" the box of "日" alone, for "日本" both
[M]. Skia splits the line where glyph coverage changes and reports the first
part [I]. The engine boxes the `.notdef` outline like any glyph and reports the
offsets through `missing()`.

**A lone space** has no ink. Skia returns a zero box at the pen origin, which
under centre/middle anchoring shows as half the advance and the baseline shift.
The engine returns zeros and `hasInk: false`.

**Middle baseline, 0.25 px.** A rule difference, see rule 4 below.

## 6. Rules derived

Stated as what REF-SK does. "Engine" says what this crate does today.

1. **Advance.** Sum of shaped x advances in integer font units, times
   `size / unitsPerEm`, in `f64`. Skia's is the same value rounded to 0.01 px.
   Engine: unrounded. Worst difference 0.0080 px [M].

2. **Letter spacing** is not part of `advance`; `wrapPlain` adds it per cluster.
   Not checked against a reference.

3. **Line box (`fontBox`).** `ascent = table.ascender * size / unitsPerEm`,
   `descent = -table.descender * size / unitsPerEm`, **not rounded** (8 of 80
   values happen to be integers) [M]. Which table:
   - OS/2 typo metrics if the `USE_TYPO_METRICS` bit (fsSelection bit 7) is set;
   - otherwise `hhea`, if its ascender or descender is non-zero;
   - otherwise OS/2 typo, if non-zero;
   - otherwise OS/2 win.

   Measured on DejaVu Sans and Comic Neue with the tables edited seven ways;
   the engine agrees in all seven [M]. On the fonts as shipped, the residual
   against `hhea` is 6.1e-6 px, against typo 16.2 px, against win 49.7 px [M].
   The fixtures alone cannot separate these branches (Comic Neue has
   `hhea == typo`), which is why the edited tables were needed. Line gap is
   read but not used.

4. **`middle` baseline.** Skia places the alphabetic baseline
   `ascent - round(ascent + descent) / 2` below the middle line: the line
   height is rounded to a whole pixel first. Residual 0.00 over 40 cases [M].
   Other candidates: `(ascent - descent) / 2` 0.25, `ascent - (round(ascent) +
   round(descent)) / 2` 0.50, `(round(ascent) - round(descent)) / 2` 0.44,
   half-em based 7.75 [M]. Engine: `(ascent - descent) / 2`, unrounded, so it
   differs by up to 0.25 px. Skia's rule is not linear in size: at a 2x paint
   scale the 1x value has to be scaled, not recomputed.

5. **`center`.** The anchor is `advance / 2` from the line's start, and the
   vertical shift is the one in rule 4. On Skia's own numbers,
   `left_center - (left + width / 2)` is within 9.5e-7 px and the vertical
   shift is exact [M]. Engine: the same.

6. **Ink box.** Skia: the whole-pixel box of its hinted raster (section 5).
   Engine: the exact box of the unhinted outline, curve extrema included, in
   `f64`. Expect up to 1 px per edge in general and up to about 2.6 px on
   accented glyphs under 24 px [M]. This rule cannot be reproduced without
   reproducing FreeType's hinter, and should not be.

7. **`fillText` baseline.** Skia draws the baseline `ascent - round(ascent)` px
   away from the y it is given. Worst error of that formula 0.063 px at a
   measuring resolution of 0.05 px, over 3 fonts x 6 sizes [M]. Any pixel
   comparison with REF-SK has to remove this first. Engine: draws at the y it
   is given.

8. **Synthetic bold.** Advance unchanged: 0 px change over 3 fonts x 5 sizes x
   4 strings [M]. The outline is stroked and filled with a pen of width
   `size * k`, where `k` falls linearly from 1/24 at 9 px and below to 1/32 at
   36 px and above. Measured stem growth over 9 sizes from 6 to 96 px matches
   `k(size)` within 0.00175 of the size, and the stem centre moves at most
   0.014 px, so it grows evenly on both sides [M]. Engine: `bold_outset(size) =
   size * k / 2` per side, same `k`.
   - The join is a **miter** in Skia: corners grow by up to 2.48 outsets
     (DejaVu "k", 1.55 px at 40 px), where a round join gives 1.00 [M]. Engine:
     round join. With the engine's rule, 88.5% of bold ink box edges are within
     [-1, 2] device px of Skia; with normal weight it is 99.1% [M].
   - Above 256 device px Skia draws from a 64 px outline, where `k` is always
     1/32 [M, seen as the bold stem ratio changing under zoom]. So Skia's bold
     is not scale-invariant; the engine's is.

9. **Synthetic italic.** Advance unchanged [M]. A horizontal skew of 0.25 per
   unit of height about the baseline: measured slope 0.2499, 0.2501, 0.2503,
   shift at the baseline at most 0.087 px [M]. Engine: `OBLIQUE_SKEW = 0.25`,
   `x' = x + 0.25 * y`. 100% of italic ink box edges within [-1, 2] device px
   of Skia [M].

10. **Clusters** are reported in UTF-16 code units, matching harfbuzzjs
    `addText` [M].

Ink box of the engine against the pixels Skia paints, baseline slip removed,
14 glyphs x 3 fonts x 4 sizes x 4 edges [M]:

| style | count | max px | p99 | p50 | within [-1, 2] device px |
|---|---|---|---|---|---|
| normal | 672 | 0.378 | 0.211 | 0.039 | 99.1% |
| bold | 672 | 0.694 | 0.415 | 0.051 | 88.5% |
| italic | 672 | 0.184 | 0.150 | 0.037 | 100.0% |
| italic bold | 672 | 0.953 | 0.638 | 0.056 | 80.5% |

This table is measured under zoom, where Skia does not hint, and it is the fair
picture of the outline maths: normal and italic agree to a fraction of a pixel.
The bold rows are the miter join.

## 7. Cost

### Size

Bytes of the `.wasm`, and after `gzip -9`. All **[M]**.

| build | raw | gzip |
|---|---|---|
| no painter, opt-level 3 | 1,425,136 | 451,290 |
| no painter, opt-level s | 1,392,171 | 440,367 |
| no painter, opt-level z | 1,328,911 | 417,650 |
| **painter, opt-level 3 (default)** | **1,827,741** | **575,924** |
| painter, opt-level s | 1,873,459 | 564,021 |
| painter, opt-level z | 1,663,333 | 493,106 |
| painter, opt-level 3, `wasm-opt -O3` | 1,572,240 | 554,224 |
| painter, opt-level 3, `wasm-opt -Oz` | 1,554,977 | 553,541 |
| painter, opt-level z, `wasm-opt -Oz` | 1,376,283 | 496,318 |
| painter, simd128, opt-level 3 | 1,701,777 | 538,094 |
| painter, simd128, opt-level 3, `wasm-opt -O3` | 1,482,727 | 515,805 |

- tiny-skia costs 402,605 bytes at opt-level 3 and 334,422 at z.
- Opt-level `s` is *larger* than 3 with the painter.
- `wasm-opt -O3` removes 14% of the raw size and 4% after gzip.
- The module has no imports [M], so the loader passes an empty import object.

### Speed

Called from JS through the loader, text transfer included. 20,000 distinct
lines of 19.7 characters on average, so nothing is answered from a cache (the
engine has no string cache). Median of 7 passes, ns per call, default build,
range over 3 runs. All **[M]**.

| font | advance | lineInk | glyphInk (1 char) | shapeUnits | shapeLine | fontBox |
|---|---|---|---|---|---|---|
| ComicNeue | 1036 to 1234 | 1219 to 1405 | 205 to 233 | 1206 to 1437 | 1614 to 1851 | 10 |
| Bangers | 924 to 1004 | 1158 to 1214 | 214 to 224 | 1118 to 1265 | 1490 to 1660 | 10 |
| DejaVuSans | 1012 to 1098 | 1200 to 1302 | 224 to 243 | 1193 to 1278 | 1557 to 1734 | 9 |
| DejaVuSans-Oblique | 904 to 1047 | 1107 to 1280 | 210 to 248 | 1084 to 1262 | 1448 to 1691 | 9 |

Where the time goes (ComicNeue, one run): writing the text into wasm memory
29 ns; `mt_advance` on text already in memory 852 ns; a one-character advance
183 ns; non-ASCII lines (`TextEncoder` path) 1144 ns; 79-character lines
3627 ns. So the cost is shaping, it is roughly linear in length (about 45 to 50
ns per character), and the boundary is about 3% of a call.

For scale, on the same lines: Skia `measureText().width` 6977 ns; harfbuzzjs
`shape` with a new buffer per call 1788 ns.

**The budget.** Batches of N uncached advances, 1000 batches each, ms:

| font | N | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| ComicNeue | 300 | 0.326 to 0.358 | 0.341 to 0.384 | 0.355 to 0.448 | 0.376 to 0.538 |
| ComicNeue | 1000 | 1.029 | 1.106 | 1.250 | 2.190 |
| DejaVuSans | 300 | 0.279 to 0.323 | 0.291 to 0.348 | 0.312 to 0.418 | 0.351 to 0.653 |
| DejaVuSans | 1000 | 0.927 | 0.950 | 0.971 | 1.121 |

"A few hundred uncached advance calls inside 8 ms" holds with a margin of
about 20 times at p95 (N = 300 rows: range over the quiet runs; N = 1000: one
run). One more run, taken while the load average was above 10, gave p95 2.2 ms,
p99 9.5 ms and max 20.5 ms for N = 300: the tail there is the
operating system taking the thread away, not the engine, but it shows that a
p99 budget cannot be promised from wasm alone.

Build variants, advance ns per call, in the same minutes as default-build runs
of 927 to 1234 [M]:

| build | advance ns | note |
|---|---|---|
| `wasm-opt -O3` | 1012 to 1168 | no difference beyond noise |
| no painter | 937 to 1183 | no difference |
| simd128 | 1059 to 1256 | no difference (shaping has no SIMD paths) |
| opt-level z | 2207 to 2483 | about 2.2x slower |
| opt-level z + `wasm-opt -Oz` | 1722 to 2143 | about 1.8x slower |

Opt-level z saves 164 KB raw and costs a factor of two in the hot path. Keep 3.

### Fonts and memory

Fresh instance per font. All **[M]**.

| font | file bytes | add, first / median of 15 more | first advance | heap after add | heap after the corpus | overhead | linear memory |
|---|---|---|---|---|---|---|---|
| ComicNeue | 57,248 | 0.039 / 0.005 ms | 0.062 ms | 59,700 | 86,340 | 29,092 | 1,441,792 |
| Bangers | 93,148 | 0.022 / 0.005 ms | 0.067 ms | 95,560 | 121,056 | 27,908 | 1,572,864 |
| DejaVuSans | 756,072 | 0.057 / 0.013 ms | 0.071 ms | 758,508 | 796,652 | 40,580 | 2,883,584 |
| DejaVuSans-Oblique | 633,840 | 0.065 / 0.012 ms | 0.057 ms | 636,308 | 673,144 | 39,304 | 2,621,440 |

- Adding a font is a table-directory read plus names and axes: under 0.1 ms.
  The copy of the bytes from JS into wasm memory is not in the "add" figure;
  it is one `Uint8Array.set`.
- Memory per font is the file plus about 2.4 KB at rest, and 28 to 41 KB after
  the whole corpus has been measured (shape plans and cached outline bounds).
- An empty instance is 1,310,720 bytes of linear memory with 128 bytes live.
- Compile and instantiate from bytes: 1.39 ms. Instantiate an already compiled
  module: 0.065 ms. V8 compiles lazily, so the first calls pay some of this
  (the "first advance" column, about 0.06 ms).
- A 7.8 MB CJK collection was loaded natively (section 8) but not through wasm;
  its memory in wasm is [I] file size plus the same kind of overhead.

### Determinism

`bench.mjs` hashes every number the engine returns for the corpus (advance, ink,
glyph ink, font box in three styles, shaped runs, wraps) as raw `f64` bytes.

- Two fresh processes and the benchmark process after 600,000 other calls:
  identical, `e3c644bdc20ae27086fecf9824b2d43d587cef5adb50fe857915a2ca0a07b029` [M].
- The same hash from every build variant tried: opt-level 3 and z, `wasm-opt`
  -O3 and -Oz, simd128, no painter [M].
- Across wasm runtimes (JavaScriptCore in WKWebView, WebKitGTK, WebView2):
  **not measured**. The metric paths use only `f64` add, multiply, divide,
  min, max and `round`, which wasm specifies bit-exactly, and the module has no
  imports, so the same result is expected [I].
- Native build against wasm build: not compared.

## 8. Paint (step 5)

One round-join stroke under a solid fill, under a scale transform, to straight
RGBA8, through `tiny-skia`. Three lines at 44 px, stroke 3 px (pen 6), scale 2,
surface 1200 x 600 device px, against the same drawing in `@napi-rs/canvas`.
PNGs (`<font>-engine.png`, `-skia.png`, `-diff.png`) are written to
`text-engine/js/generated/paint/`. All **[M]**.

| font | ink box, engine minus Skia (x0 y0 x1 y1, device px) | overlap at 50% alpha | mean alpha difference | alpha levels, engine / Skia | Skia baseline slip |
|---|---|---|---|---|---|
| ComicNeue | 0, 0, 0, -1 | 0.9749 | 0.0208 | 32 / 250 | -0.80 |
| Bangers | 0, 1, 0, 0 | 0.9826 | 0.0154 | 29 / 250 | -0.30 |
| DejaVuSans | 0, 0, 0, 1 | 0.9813 | 0.0156 | 29 / 241 | -0.32 |
| DejaVuSans-Oblique | 0, 0, 0, 1 | 0.9819 | 0.0172 | 29 / 246 | -0.32 |

The ink box agrees within 1 device px, and the 1 px is on the vertical edges,
where Skia's baseline slip (rule 7) explains it.

Time per paint of this block, median of 40, pixels copied out to JS included,
range over 3 runs and 4 fonts:

| | default build | simd128 build | Skia |
|---|---|---|---|
| 1200 x 600 (the 600 x 300 block at 2x) | 2.9 to 4.3 ms | 2.7 to 3.7 ms | 0.31 to 0.41 ms |
| 600 x 300 at 1x | 1.5 to 2.3 ms | 1.3 to 2.0 ms | not timed |
| of which: empty surface | 0.43 to 0.50 ms | 0.43 to 0.65 ms | |
| fill only | 1.45 to 1.96 ms | 1.29 to 1.53 ms | |
| stroke only | 1.98 to 3.11 ms | 1.82 to 3.07 ms | |

- The painter is about 10 times slower than Skia and still a fifth of a 16 ms
  frame for a whole block at 2x. simd128 gains about 10% here, `wasm-opt`
  nothing. The engine's figure includes copying 2.88 MB of pixels out of wasm
  memory; Skia's does not include reading its pixels back.
- These timings moved by a factor of three on the same build while the machine
  was busier (9 to 13 ms in an earlier, informal run). Treat them as a
  quiet-machine figure.
- **Anti-aliasing is coarser than Skia's.** tiny-skia supersamples 4 x 4, which
  gives about 30 alpha levels where Skia gives about 250. A sliver of ink
  narrower than a quarter of a pixel can vanish (the paint tests allow for it). It is visible in a difference image and
  mostly not at 2x; whether it is acceptable for export is a call for a person
  looking at real pages.
- A stroke over all lines in one path is a union: a translucent stroke is laid
  down once where neighbouring glyph strokes overlap (unit test
  `overlapping_strokes_of_neighbours_are_laid_down_once`).

## 9. Variable fonts, collections, WOFF

Checked with a one-off native program against fonts on this Mac. That program
is not in the repository, because the fonts cannot ship.

**Variable fonts.** Supported by the libraries; the engine does not expose
instances yet.
- `mt_font_info` already reports `is_variable` and each axis (tag, min, default,
  max) [M].
- Shaping at an instance: `font.instance_builder().variations([("wght", v)]).build()`
  in harfrust, then shape with that instance. Advance of "Hello World" in
  Bricolage Grotesque (wght 200 to 800): 5235, 5383, 5541, 5689 units at 200,
  400, 600, 800 [M].
- Outlines at an instance: skrifa `axes().location([("wght", v)])` passed as
  the `LocationRef` of `DrawSettings`; the box of "H" widens from 499 to 591
  units across the axis [M].
- Cost of adding it: a face needs a location, and the plan cache and the
  outline-bounds cache need the location in their key. HVAR/gvar are applied by
  the libraries [I].
- The default instance's name can be odd ("Bricolage Grotesque 96pt
  ExtraBold"): named instances from `fvar`/`STAT` are what a font menu should
  list [M for the name, I for the remedy].

**Collections (TTC).** A face index selects the face; `faces_in_file` reports
how many there are. `add_font_bytes(bytes, 0)` then `add_sibling_face(first, i)`
enumerated Helvetica.ttc (6 faces), Avenir Next.ttc (12) and a Hiragino W3
collection (4 faces, 20,339 glyphs, 7.8 MB) with the right names, sharing one
copy of the bytes [M, native build].

**WOFF and WOFF2.** The engine reads sfnt only and rejects WOFF2 bytes [M].
A maintained pure-Rust decoder exists: **`wuff` 0.2.9** (MIT, WOFF 1 and 2,
depends on `brotli-decompressor` and `flate2`). It decoded a 41,344-byte
variable WOFF2 to an 82,812-byte sfnt in 1.4 ms natively, and the engine
accepted the result [M]. Built alone to wasm it is **288,015 bytes** [M]; added
to this module the cost would be somewhat less, since the standard library is
already there [I]. Others seen on crates.io and not tried: `woff2` 0.3.0,
`woff2-patched` 0.4.0, `woofwoof` 1.0.2. Recommendation: decode in the Rust
side of the app when a font is imported and hand the engine sfnt bytes, so the
wasm does not carry a Brotli decoder [I].

## 10. The stack, crate by crate

| crate | verdict | evidence |
|---|---|---|
| `harfrust` 0.14 | keep | exact equality with HarfBuzz on 40,264 strings; about 1 µs per line; faster from JS than harfbuzzjs on the same lines (about 1.0 against 1.8 µs, though harfbuzzjs allocated a buffer per call) |
| `read-fonts` 0.45 | keep | harfrust is built on its `model::Font`; names, axes, `hhea`, `OS/2` all read from it; 360 deliberately damaged copies of the fixtures gave errors or fonts, never a panic |
| `skrifa` 0.48 | keep | needed for outlines (the `model` outline API is private to the crate); exact outline boxes agree with Skia's unhinted raster within 0.38 px |
| `tiny-skia` 0.12 | keep, with eyes open | works in wasm with no imports; 400 KB; 3 to 4 ms per block at 2x; coarser anti-aliasing than Skia. If export quality needs 256 levels, the alternative is a different rasteriser (`vello_cpu` is a candidate, not tried here), not a different stack |
| `unicode-linebreak` 0.1.5 | keep | does what `wrapPlain` needs; but `wrapPlain` itself is unverified |
| `rustybuzz` + `ttf-parser` | not needed | the first choice did not fail anywhere |

One structural note: read-fonts' owned `model::Font` is new in this release
line and harfrust's API changed shape to use it. Pin exact versions in
`Cargo.toml` when the port starts and expect an API change on the next upgrade.

## 11. Open risks for the full port, most serious first

1. **REF-SK is not the app's webview.** Every rule in section 6 describes
   Skia inside `@napi-rs/canvas` with FreeType. WKWebView, WebView2 and
   WebKitGTK were not measured. If the port's goal is "same as the test lane",
   the rules stand. If it is "same as what users see today", the line box
   choice, the 0.01 rounding and the middle rule each need a check in a real
   webview before they are frozen.

2. **Ink boxes cannot match REF-SK to a tight tolerance.** Up to 1 px per edge
   everywhere and 2.6 px on small accented text, because the reference hints.
   Any existing test that pins a Skia ink box to a fraction of a pixel will
   move. Decide the tolerance (or re-pin against the engine) before porting
   callers of `lineInk`/`glyphInk`.

3. **The `middle` rule.** Skia rounds the line height; the engine does not
   (up to 0.25 px). Adopting Skia's rule keeps today's pixels and makes
   vertical centring depend non-linearly on size; keeping the engine's rule
   moves every vertically centred glyph by up to a quarter pixel. One of the
   two has to be chosen deliberately.

4. **Synthetic bold join.** Miter (Skia, up to 2.5 outsets at sharp corners) or
   round (the engine). 11% of bold ink box edges differ by more than the normal
   tolerance. A miter needs a miter limit; Skia's was not measured.

5. **Painter quality and speed.** About 30 alpha levels, and 3 to 4 ms for one
   block at 2x on a quiet machine. A page with many blocks repainted on a
   keystroke will need tight surfaces per block, cached outlines per glyph and
   size, and probably the simd128 build. Gradients, patterns and per-band
   opacity are not built and will add to both size and time.

6. **A trap kills the instance.** `panic = "abort"` means any panic in harfrust
   or read-fonts on a hostile font is a wasm trap, after which the instance and
   every registered font are gone. The damaged-font test is a smoke test (360
   files), not a fuzz run. The loader needs a "rebuild the instance and re-add
   fonts" path, and font import should validate in a throwaway instance first.

7. **Lines Skia boxes oddly.** Leading or trailing spaces, missing glyphs and
   empty runs (section 5). The engine's answers are the defensible ones, but
   callers that today rely on Skia's (for example a trailing space widening the
   box) will see a change.

8. **No itemisation, fallback or bidi.** One run, one font, guessed script and
   direction. Manga dialogue in Latin script is fine; a Japanese SFX in a Latin
   font is a row of `.notdef`. `missing()` reports where, and something above
   the engine has to split runs and pick fonts.

9. **`wrapPlain` is unverified.** It shapes the paragraph once and breaks on
   cluster advances, so a break inside a ligature or a kerning pair uses the
   unbroken advances, and CSS rules such as `overflow-wrap` and hanging spaces
   are approximated. It needs its own parity lane against the current wrapping
   code before anything depends on it.

10. **Variable fonts need an instance in the face.** Small, but it touches the
    face handle, both caches and the ABI (section 9).

11. **Complex scripts are untested.** harfrust claims HarfBuzz parity and the
    Latin evidence is perfect, but there is no Arabic, Indic or vertical-CJK
    fixture here.

12. **Memory growth is one-way.** wasm linear memory does not shrink. Loading
    a 20 MB CJK collection and removing it leaves the instance that large.
    Font bytes could live outside the engine's instance only by re-instantiating.

13. **Cross-runtime determinism is inferred, not measured** (section 7).
