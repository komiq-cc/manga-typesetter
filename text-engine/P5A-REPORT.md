# P5a report: the glyph painter

Branch `tp/paint`, on top of `text-port` at `190e201` (merged in as asked).
Every figure is marked **[M]** measured here, or **[I]** inferred. Timings were
taken while other agents used the machine (load average 10 to 12 for the last
runs), so they are given as ranges.

## 1. What was built

The Rust engine can now paint everything a glyph job says, with no canvas and
no rasteriser crate in the shipped build.

- **`text-engine/src/paint/`** (replaces the spike's `src/paint.rs`):
  `geom.rs` (points, transforms, polylines), `outline.rs` (glyph outlines from
  skrifa, flattened at a tolerance tied to the device scale), `stroke.rs` (our
  own offsetting: grow, shrink, and the sweep used for WebKit's bold),
  `raster.rs` (the rasteriser), `shade.rs` (flat colour, linear and radial
  gradients, patterns), `compose.rs` (layers laid over each other in
  premultiplied f32, rounded once to straight RGBA8), `shape.rs` (where each
  glyph of a run goes), `job.rs` (the job and its wire form), `mod.rs`
  (`paint_job`, the layer order, the two bold switches), `scene.rs` (the
  spike's `mt_paint_begin / fill / stroke / end / line` exports, kept and now
  drawn by the new rasteriser so the spike's five tests still pass
  unchanged), `raster_compare.rs` (the other rasterisers, comparison builds
  only).
- **`text-engine/src/abi_paint.rs`**: the exports `mt_paint_job_reserve`,
  `mt_paint_job`, `mt_paint_job_result`, `mt_paint_job_pixels`,
  `mt_paint_job_release`, `mt_paint_wire_version` (and `mt_paint_rasterizer`
  in comparison builds). Still zero imports in every build [M].
- **`text-engine/js/paint.mjs`**: `paintJob(engine, { job, font, synth, chain,
  boldDraw, transform, tiles })` takes the object `glyphJob` returns,
  unchanged, and gives back `{ x, y, width, height, data }` (a tight raster
  and where it sits) or `null`. Also `encodeJob`, `parseColor`,
  `releaseRaster`, `rasterHash`, `combineHashes`, `hashJobs`. No dependency,
  nothing of node's.
- What a job can say, and is painted: solid fill; any number of bands (widest
  first, under the fill); the silhouette; linear and radial gradients, for the
  whole block or per line, with transparent stops; the eleven patterns at any
  scale; curved text (each glyph on its own point and angle); letter spacing;
  left, centre and right; a synthesised bold and italic; any affine transform,
  mirrored and sheared included; a fallback chain.
- The wire form ("MTPJ", version 2) is documented at `decode` in `job.rs`. A
  damaged or non-finite job is refused, never guessed at.

Tests: 30 unit tests in the crate (27 of them the painter's), 24 in `tests/paint_job.rs` (one per
feature, the wire form, determinism, the size guard), the spike's 5 and the
27 fixture tests. `cargo test`, `cargo test --no-default-features`,
`cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` (also with
`--no-default-features` and `--features raster-compare`) are clean [M]. The
app's vitest suite passes unchanged: 78 files passed and 1 skipped, 2679 tests
passed and 7 skipped, after the merge [M] (76 and 1, 2638 and 7 before it
[M]). No existing test was edited.

## 2. The rasteriser: measurements and choice

Four rasterisers sit behind one trait (`raster_compare.rs`), selectable at run
time in the comparison build. `text-engine/parity/raster.mjs` paints the same
flattened outlines with each and compares against a truth made by painting at
32 times the size and averaging (the truth was cross-checked against
tiny-skia at 32 times: worst difference 2.29 alpha levels over 214,680 inked
pixels [M]). Errors are in alpha levels of 255, over edge pixels. "Lost" is
inked pixels of the truth left empty.

| job | rasteriser | levels | mean | p99 | max | over 16 (per 1000) | lost |
|---|---|---|---|---|---|---|---|
| fill, 8 to 14 px | **exact area (ours)** | 256 | 0.67 | 2.3 | 73.3 | 0.23 | 0 |
| | tiny-skia 0.12 | 29 | 8.21 | 30.6 | 59.6 | 135.87 | 222 |
| | zeno 0.3 | 256 | 0.96 | 2.9 | 73.3 | 0.23 | 0 |
| | vello_cpu 0.2 | 256 | 0.67 | 2.3 | 73.3 | 0.23 | 0 |
| fill, 22 to 96 px | **exact area (ours)** | 256 | 0.70 | 2.5 | 68.5 | 0.25 | 0 |
| | tiny-skia | 29 | 7.52 | 28.8 | 47.7 | 118.34 | 396 |
| | zeno | 256 | 1.05 | 3.4 | 68.5 | 0.25 | 0 |
| | vello_cpu | 256 | 0.70 | 2.5 | 68.5 | 0.25 | 0 |
| stroke 0.6 px, text 10 to 44 px | **exact area (ours)** | 256 | 1.58 | 31.2 | 116.7 | 25.05 | 0 |
| | tiny-skia | 29 | 9.96 | 39.0 | 72.2 | 195.95 | 408 |
| | zeno | 256 | 2.15 | 36.7 | 118.7 | 33.56 | 0 |
| | vello_cpu | 256 | 1.87 | 36.5 | 116.7 | 33.59 | 0 |
| stroke 1.5 px, text 10 to 14 px | **exact area (ours)** | 256 | 2.84 | 45.6 | 104.5 | 48.82 | 0 |
| | tiny-skia | 29 | 7.76 | 28.7 | 52.3 | 119.35 | 104 |
| | zeno | 256 | 4.85 | 48.2 | 104.5 | 92.78 | 0 |
| | vello_cpu | 256 | 4.63 | 47.8 | 104.5 | 91.19 | 0 |
| stroke 12 px, text 44 px | **exact area (ours)** | 256 | 1.76 | 33.6 | 84.0 | 20.50 | 0 |
| | tiny-skia | 29 | 7.23 | 28.6 | 34.9 | 115.73 | 210 |
| | zeno | 256 | 2.03 | 34.9 | 86.0 | 20.69 | 0 |
| | vello_cpu | 256 | 1.76 | 33.6 | 84.0 | 20.50 | 0 |
| synthetic bold, 12 and 44 px | **exact area (ours)** | 256 | 0.89 | 10.2 | 88.0 | 5.63 | 0 |
| | tiny-skia | 29 | 7.90 | 29.8 | 37.6 | 126.93 | 159 |
| | zeno | 256 | 1.21 | 10.6 | 87.0 | 5.77 | 0 |
| | vello_cpu | 256 | 0.89 | 10.2 | 88.0 | 5.63 | 0 |

All [M], identical before and after the merge. Time for the SPIKE.md section
8 block (three lines at 44 px, a 6 px pen, flat fill), median ms, pixels
copied out, two runs:

| rasteriser | 2x | 1x | wasm bytes with it (gzip) |
|---|---|---|---|
| **exact area (ours)** | 1.65 to 2.00 | 0.65 to 0.82 | 1,534,649 (486,018) |
| tiny-skia 0.12 | 4.40 to 6.92 | 2.01 to 3.28 | 1,830,099 (577,417) |
| zeno 0.3 | 3.91 to 11.01 | 1.60 to 3.63 | 1,714,071 (530,321) |
| vello_cpu 0.2 | 3.90 to 5.74 | 1.81 to 3.09 | 1,950,289 (621,165) |
| Skia canvas in node (pixels not read back) | 0.26 to 0.37 | | |

**Choice: our own exact-area rasteriser.** It accumulates the signed area each
edge covers in each pixel (the method of font-rs and of vello's sparse strips),
in 32-row strips. It ties vello_cpu for accuracy on fills, is the most accurate
on strokes, is the fastest of the four here, has 256 levels where tiny-skia has
29 and loses thin strokes, and costs 97,231 bytes for the whole painter where
the others add 179,000 to 416,000 on top. The stroke rows are better than the
others' because a stroke is painted as two shapes (the outline grown, less the
outline shrunk) instead of one self-overlapping ring; the other three were
given the one-ring form, so those rows compare the method as well as the
rasteriser.

Its known weakness: coverage is accumulated, not unioned, so in a single pixel
where two separate contours of one layer cross, coverage can be over-counted
(it is clamped). That is the `max` column: 68 to 117 levels at a handful of
pixels (0.23 to 49 per 1000 edge pixels, the high figure being 1.5 px strokes
on 10 px text).

## 3. Parity with today's painter

`text-engine/parity/paint-job.mjs` (run with `./node_modules/.bin/vite-node`)
takes 54 boxes through the app's own `renderBoxTexture` with a capturing
painter, so the jobs are the app's own, then paints each job twice: on the
Skia canvas as `browser-painter.js` does, and with the engine. It prints two
tables, because Skia in node does several things to small text that are not
the job's doing (section 6):

- **Against Skia's outlines**: the canvas painted at K times the transform and
  averaged down (K from 5 to 38, so glyphs are over 256 device px and Skia
  draws outlines, not hinted masks). This is the comparison of the painters.
- **Against the canvas as drawn**: the same transform as the job. This is what
  a user of the node lane sees today.

In both, the Skia baseline slip (RULES.md rule 7) is removed on the engine's
side, as the brief asks. The columns are the brief's: ink box difference
(engine minus canvas, device px), overlap of the alpha >= 128 masks
(intersection over union), mean alpha difference over inked pixels (of 255),
and thickness (twice the largest distance-transform value inside the XOR of
the masks; it reads 2.0 for a one-pixel line by definition). All [M], the same
before and after the merge.

### Against Skia's outlines

| feature | ink box | overlap | mean alpha diff | thickness |
|---|---|---|---|---|
| solid: Comic Neue / Bangers / DejaVu Sans / its oblique face / 12 px at 1x | 0 0 0 0 | 0.9933 / 0.9987 / 0.9971 / 0.9964 / 0.9935 | 0.68 / 0.30 / 0.38 / 0.38 / 0.58 | 2.0 |
| one band / two bands / three bands | 0 0 0 0 | 0.9980 / 0.9980 / 0.9992 | 0.59 / 0.52 / 0.23 | 2.0 |
| band at half opacity | 0 0 0 0 | 0.5344 | 8.36 | 10.0 |
| two bands at half opacity | 0 0 0 0 | 0.7873 | 8.04 | 8.0 |
| hairline band, 0.5 px | 0 0 0 0 | 0.9968 | 3.69 | 2.0 |
| linear gradient at 180, 90, 35 degrees | 0 0 0 0 | 0.9981 / 0.9933 / 0.9933 | 0.31 / 0.68 / 0.68 | 2.0 |
| gradient with a transparent stop | 0 0 0 0 | 0.9962 | 0.44 | 2.0 |
| radial gradient, centred and off centre | 0 0 0 0 | 0.9933 | 0.68 | 2.0 |
| gradient per line | 0 0 0 0 | 0.9981 | 0.31 | 2.0 |
| each of the 11 patterns | 0 0 0 0 | 0.9984 | 0.31 | 2.0 |
| pattern at scale 0.25 / checker at 1x | 0 0 0 0 | 0.9984 / 0.9990 | 0.31 / 0.28 | 2.0 |
| curved: arc / arc with gradient / circle with pattern | 0 0 0 0 | 0.9990 / 0.9988 / 0.9974 | 0.28 / 0.31 / 0.65 | 2.0 |
| silhouette, two bands | 0 0 0 0 | 0.9955 | 1.11 | 6.3 |
| silhouette, curved | 0 0 0 0 | 0.9990 | 0.28 | 2.0 |
| letter spacing +4 / -1.5 / +4 right / +3 on a font with ligatures | 0 0 0 0 | 0.9980 / 0.9961 / 0.9923 / 0.9972 | 0.32 / 0.73 / 0.71 / 0.34 | 2.0 |
| align left / centre / right | 0 0 0 0 | 0.9956 / 0.9933 / 0.9921 | 0.62 / 0.68 / 0.73 | 2.0 |
| synthetic italic | 0 0 0 0 | 0.9951 | 0.72 | 2.0 |
| synthetic bold, 40 px | 0 0 0 0 | 0.9984 | 0.51 | 2.0 |
| synthetic bold italic, 40 px, one band | 0 0 0 0 | 0.9992 | 0.29 | 2.0 |
| synthetic bold / with one band / bold italic, 28 px | 0 0 0 0 | 0.9697 / 0.9941 / 0.9634 | 6.96 / 1.81 / 6.94 | 2.0 |
| synthetic bold, 12 px | 0 0 0 1 | 0.8942 | 16.16 | 2.0 |
| transform: rotated 17 degrees / -90 degrees / mirrored | 0 0 0 0 | 0.9980 / 0.9978 / 0.9979 | 0.52 / 0.59 / 0.58 | 2.0 |
| transform: scale 3.3, off grid | 0 0 0 0 | 0.9981 | 0.48 | 4.0 |

Colour, where the fill is not flat (mean / worst difference of 255 over pixels
both painted solid): gradients 0.00 to 0.12 / 0 to 64; patterns 1.86 to 8.37 /
18 to 55; bands 0.10 to 0.31 / 69 to 84 (the worst are single pixels on a
band's edge).

The rows that are not near 0.99, each with its cause:

- **Bands at half opacity (0.53, 0.79).** The canvas strokes each glyph in
  turn, so where the strokes of neighbouring letters overlap the alpha
  doubles; the engine lays a band once. Half opacity is 127.5, which also
  makes the 128 mask meaningless. A deliberate difference (section 5).
- **Silhouette, thickness 6.3.** Skia's stroker leaves a hole in the stroke
  round a dot smaller than the pen radius, so the canvas silhouette has
  crescent holes at "." and at the dots of "?!". The engine's is solid. Seen
  in `job-silhouette-two-bands.png`.
- **Synthetic bold under 36 px (0.89 to 0.97).** The reference is wrong here,
  not the engine: at the large size the outline reference needs, Skia's bold
  uses its large-size constant (1/32 of the size), where at the job's own size
  it uses the interpolated one. The 40 px rows, where the two constants agree,
  are 0.9984 and 0.9992. Measured directly: Skia's bold stem grows 1.908 to
  1.916 device px at 28 px times 2 (the rule gives 1.923) and 1.742 at 56 px
  times 1 (1.75) [M].
- **Hairline (mean 3.69).** A 0.5 px band is mostly partial coverage; the
  mask agrees (0.9968).

### Against the canvas as drawn

| feature | overlap | mean alpha diff |
|---|---|---|
| solid: Comic Neue / Bangers / DejaVu Sans / 12 px at 1x | 0.8510 / 0.9425 / 0.8772 / 0.6342 | 23.27 / 11.02 / 23.11 / 27.60 |
| one / two / three bands | 0.9784 / 0.9835 / 0.9870 | 6.19 / 4.26 / 3.39 |
| gradients | 0.8598 to 0.9587 | 8.89 to 19.97 |
| patterns | 0.9479 to 0.9609 | 8.41 to 10.63 |
| curved | 0.9586 to 0.9703 | 6.00 to 7.48 |
| silhouette | 0.9815 to 0.9835 | 3.92 to 4.59 |
| letter spacing, alignment | 0.8510 to 0.9669 | 8.32 to 23.56 |
| synthetic bold and italic | 0.8337 to 0.9914 | 2.06 to 21.86 |
| transforms | 0.9757 to 0.9859 | 2.79 to 6.17 |

Ink boxes agree to within one device pixel in every row. The engine has 256
alpha levels in every row but two (223 for 12 px text at 1x, 243 for the
gradient with a transparent stop); the canvas has 182 to 256. The largest baseline slip removed was 0.2 to 1.0 device px. With
the slip left in (`--keep-slip`), solid Comic Neue is 0.7897 / 35.94 as drawn
and 0.8906 / 20.45 against outlines [M].

These numbers are low for one reason, and it is Skia's, not the painter's:
bare text (no band under it) is drawn from hinted glyph masks set on whole
device pixels, with coverage bent by the fill's luminance. The same jobs
against Skia's own outlines are 0.99. The rows with bands are high in both
tables because the bands hide the mask edge.

Pictures: `text-engine/js/generated/paint/job-<feature>.png`, four panels each
(canvas, engine, difference against the canvas as drawn, difference against
outlines). I looked at them; the differences are one-pixel outlines of the
letters in the as-drawn panel and near black in the outline panel, except the
cases listed above, which show what is described.

## 4. Cost and size

SPIKE.md section 8 block (three lines at 44 px, 6 px pen, fill), ms per job,
median of 60, from `paint-job.mjs`; the low end is a quieter machine, the high
end is load average 10 to 12 [M]:

| | rasters (Comic Neue, Bangers, DejaVu Sans) | engine | Skia canvas (pixels not read back) |
|---|---|---|---|
| 2x | 716 x 451, 528 x 441, 794 x 456 | 1.54 to 3.69 | 0.26 to 0.52 |
| 1x | 359 x 226, 264 x 221, 397 x 229 | 0.60 to 1.46 | 0.09 to 0.21 |

In the last, loaded run the three fonts at 2x were 3.59, 2.68 and 3.07 (Skia
0.50, 0.52, 0.47) and at 1x 1.46, 1.17 and 1.17 (Skia 0.21, 0.17, 0.20); in an
earlier, quieter one 2.34, 1.89 and 1.88 at 2x and 0.98, 0.80 and 0.70 at 1x.

Copying the pixels out to JS instead of leaving a view on the wasm memory
changes these by less than the noise [M]. Per feature at 2x (median ms, quiet
to loaded): solid 0.3 to 0.7; one band 1.1 to 2.1; two bands 2.1 to 3.6; three
bands 3.0 to 5.4; a pattern 1.4 to 3.1; rotated with two bands and a gradient
2.3 to 4.3; scale 3.3 with two bands 3.9 to 8.9 [M]. The cost is the bands:
each is a grown outline rasterised over the whole block. There is no glyph
cache yet; every job flattens and offsets its outlines again.

Wasm bytes (gzip in brackets) [M]:

| build | before the merge | after the merge |
|---|---|---|
| no painter | 1,425,136 (451,282) | 1,437,418 (455,983) |
| **default: the painter** | 1,520,086 (480,648) | **1,534,649 (486,018)** |
| the painter's own cost | 94,950 | 97,231 (30,035) |
| `opt-level = z` | 1,444,844 (443,779) | 1,458,164 (444,198) |
| `+simd128` | 1,527,636 (483,948) | 1,542,010 (489,616) |
| all three comparison rasterisers | 2,405,901 (748,021) | 2,420,379 (753,301) |

For "before": the spike's build with the tiny-skia painter was 1,827,741
(575,924) [M], and P4-REPORT.md gives 1,840,027 for `text-port` at the merge
(its figure, not re-measured). So the shipped wasm is about 305,000 bytes
smaller than before this task, with a painter that does everything.

## 5. Determinism

`node text-engine/parity/paint-hash.mjs --native` paints 26 fixed jobs under
each of the two bold-advance rules (52 rasters) and hashes origin, size and
pixels [M]:

| build | bytes | hash of all rasters | same |
|---|---|---|---|
| `mt_text.wasm` | 1,534,649 | `16a2bbe9a4656bb4` | yes, in two processes |
| `oz.wasm` | 1,458,164 | `16a2bbe9a4656bb4` | yes, in two processes |
| `mt_text.simd.wasm` | 1,542,010 | `16a2bbe9a4656bb4` | yes, in two processes |
| `mt_text.compare.wasm` (exact rasteriser selected) | 2,420,379 | `16a2bbe9a4656bb4` | yes, in two processes |
| `wasmopt.wasm` | not built: no `wasm-opt` on this machine | | |
| native build, aarch64 | | all 52 rasters one by one | yes |

On NaN, which SPIKE.md section 3 asks about: wasm arithmetic is exact IEEE
except for the payload bits of a NaN, so the bytes can only differ between
hosts if a NaN reaches them. None can. The decoder refuses any non-finite
number; every division is guarded; the only functions used beyond the four
operations are `sqrt` (exact by IEEE), `hypot` (to count a pattern's taps) and
`sin_cos` (a curved glyph's turn), the last two compiled into the wasm from
Rust's own code, so every host runs the same instructions; and the pixels are
integers rounded from clamped f32. Wasm has no fused multiply-add. That native
aarch64 gives the same bytes is a stronger result than was needed, and the one
place it could in principle differ is those two library functions [I].

For the browsers: `rasterHash`, `combineHashes` and `hashJobs` are in
`js/paint.mjs`, and the fixed jobs are in `parity/paint-hash-jobs.mjs`
(`hashFixedJobs(engine, fontIds)`); neither imports anything of node's. A page
loads the four fixture fonts, calls it, and should print `16a2bbe9a4656bb4`.
The hash is two 32-bit sums (FNV-1a and Jenkins) so it needs no BigInt and no
crypto API.

## 6. Every deliberate difference from the canvas, and why

1. **A band is laid once.** The canvas strokes glyph by glyph, so a
   translucent band doubles where letters' strokes overlap. One shape per band
   is what a band means; opaque bands are unaffected.
2. **The fill of a block is one layer** per fill, for the same reason.
3. **The silhouette is one grown shape,** with no hole round small dots (the
   hole is a Skia stroker artefact; whether the two browsers also show it was
   not checked).
4. **No hinting, no snapping of glyphs to device pixels, no luminance bend of
   coverage, no baseline slip.** These are Skia's glyph-mask behaviours in
   node (a black stem measures 4.79 device px and a grey one 5.13 for the same
   glyph [M]); the engine paints the outline's true area at the position the
   measurement gives. This is what makes the engine the same in every browser.
5. **Colour is composited in premultiplied f32 and rounded once,** so a
   gradient through a transparent stop does not darken and there are 256
   levels.
6. **Under letter spacing, ligatures are off** (as the browsers and Skia do),
   and the gap after the last letter counts in the width used for centring
   (seen in the Chromium, WebKit and Skia reference pictures).
7. **Curved text ignores letter spacing,** as today's painter does.
8. **`middle` for curved glyphs is the engine's rule** (`(ascent - descent) /
   2`, unrounded, browsers' line box), not Skia's rounded one.
9. **Patterns are resampled** (bilinear, with more taps when shrunk) instead
   of the canvas's pattern transform; hence the colour differences of 2 to 8
   levels on patterns.
10. **An unknown alignment is left; an unknown colour form throws.** The
    canvas would silently paint black or nothing.
11. **The raster is tight** (cut to the ink, with its origin), not the box.
12. **Synthetic bold** is drawn by a switch, below. As "smear" it is a true
    union, where WebKit composites two draws (so WebKit's edge pixels are a
    little heavier).

## 7. The coordinator's five points

1. **Merged** `text-port` at `190e201`; ABI version 2; the painter's wire form
   went to version 2 to carry the fallback chain. `text-port` has since moved
   to `a6966f8` (the compare tool); I did not merge that, and it has no file
   in common with this branch [M].
2. **Fallback chains.** The painter no longer shapes on its own: a run is
   placed from `Engine::measure_line`, the call that measures it, part by
   part. A letter the face lacks is drawn from the fallback face the
   measurement used (pinned by a test and in the hash jobs). With no chain the
   bytes are as before.
3. **Rules.** `middle` is the unrounded browsers' rule; tab, LF, FF and CR are
   painted as the space they are measured as (test and hash job); `rand` is
   off because the shaping is the measuring one.
4. **Synthetic bold.** Positions come from the engine under whichever
   `boldAdvance` rule is set, so the ink lands where the measurement says
   (test: under `webkit` the painted ink box is the engine's measured ink
   box at each alignment, each glyph `size / 36` further on than the one
   before). How the bold is drawn is a second switch beside `BOLD_JOIN` in
   `paint/mod.rs`: `BoldDraw::Outset` or `BoldDraw::Smear`, carried per job
   (`boldDraw: 'outset' | 'smear'` in `paint.mjs`). Not chosen; the default is
   `Outset`, which is what was there. Findings in section 8.
5. **Hash callable from the loader:** section 5.

## 8. How each reference draws a synthesised bold

`TP_DATA=... node text-engine/parity/bold-refs.mjs` reads the pictures of the
three `faux-bold` cases with a short text (Comic Neue 22 and 40 px, Bangers 40
px, all at 2x) and of a regular twin in the same black (`spacing`), and
measures the median width of upright strokes (stems) and height of level ones
(bars). Device px at 2x, regular to bold [M]:

| case | drawn by | stem grows | bar grows | ink grows |
|---|---|---|---|---|
| Comic Neue 40 px | WebKit (Safari 27) | +2.16 | +0.75 | +30.5% |
| | Chromium 152 | +1.38 | +1.59 | +23.1% |
| | Skia in node | +2.47 | +2.40 | +51.1% |
| | engine, outset (rule: 2.50 and 2.50) | +2.50 | +2.50 | +49.0% |
| | engine, smear (rule: 2.22 and 0) | +2.22 | +0.00 | +32.3% |
| Comic Neue 22 px | WebKit | +1.44 | +0.48 | +32.2% |
| | Chromium | +0.55 | +0.84 | +16.6% |
| | Skia in node | +1.59 | +1.51 | +61.9% |
| | engine, outset (1.61 and 1.61) | +1.61 | +1.61 | +57.5% |
| | engine, smear (1.22 and 0) | +1.22 | +0.00 | +32.3% |
| Bangers 40 px | WebKit | +1.83 | (see below) | +15.2% |
| | Chromium | +1.32 | | +12.5% |
| | Skia in node | +2.33 | | +24.6% |
| | engine, outset | +2.40 | | +23.8% |
| | engine, smear | +2.01 | | +15.9% |

Bangers has too few level strokes for the bar figure to mean anything (the
medians jump between 4 and 13 px), so it is left out.

- **Skia (node): the outline is grown on every side** by `size * k / 2`, k
  from 1/24 at 9 px to 1/32 at 36 px and over. Stems and bars thicken alike;
  the advance is unchanged. This is `BoldDraw::Outset` and the numbers agree
  (+2.47 and +2.40 against 2.50).
- **WebKit: the glyph is drawn a second time, `size / 36` to the right,** as
  expected. Stems thicken by that amount and level bars do not; the ink grows
  by 30.5%, 32.2% and 15.2% where the engine's smear gives 32.3%, 32.3% and
  15.9% and the outset 49.0%, 57.5% and 23.8%. The offset is in the text's own
  units (it scales with the 2x canvas). Direction: laid over WebKit's picture
  at the best fit, the smear sits at the same offset as the regular text does
  over the regular picture (-0.50 px in all three cases), while the outset
  has to be moved 0.75 to 1.25 px to the right, about half the smear's length
  (0.61 px at 22 px, 1.11 px at 40 px): the extra ink is all on the right of
  the glyph's origin. The small
  growth of WebKit's bars (+0.48, +0.75) is what compositing the same soft
  edge twice gives [I]. This is `BoldDraw::Smear` with `boldAdvance=webkit`.
- **Chromium: grown on every side like Skia, but by about half as much** at
  2x (+1.38 and +1.59 at 40 px, +0.55 and +0.84 at 22 px), advance unchanged.
  The amounts are close to Skia's rule at 1x (1.25 and 0.81), so Chromium's
  outset seems not to scale with the canvas transform [I]. Neither switch
  position reproduces that; it would be a third.

One thing in the fit table could mislead, so it is stated: by overlap and mean
alpha difference, the outset "fits" WebKit's picture a little better than the
smear (Comic Neue 40 px: 0.9127 / 19.27 against 0.8795 / 24.86). That is
because WebKit draws all text heavier than its outline: the regular face over
WebKit's regular picture is only 0.8691 / 26.31, and the outset's extra weight
all round hides that. The smear leaves the same residual as regular text has
(24.86, 37.41, 13.92 against 26.31, 37.39, 15.24), which is the sign of the
right shape. With the advance unchanged nothing fits WebKit (0.36 to 0.67),
and with the webkit advance nothing fits Chromium or Skia (0.30 to 0.65).

Pictures: `text-engine/js/generated/paint/bold-comicneue-40.png`,
`bold-comicneue-22.png`, `bold-bangers-40.png`. A row per reference (WebKit,
Chromium, Skia); its bold, then the engine's picture and the difference for
outset with the advance unchanged, outset with the webkit advance, smear with
the webkit advance. Red is ink only the engine has, blue only the reference.
In the WebKit row the outset panel is red above and below every crossbar and
blue beside the stems; the smear panel is a thin even blue line all round,
the same as regular text. I looked at all three; they show the same thing.

## 9. Not done

- The JS painter object (`setGlyphPainter`), blit, font family mapping,
  shadows, blur, roughen, clip, warp: not in this task.
- No glyph outline cache; the cost in section 4 is without one.
- Exact union where two contours of one layer cross inside one pixel (the
  `max` column in section 2).
- The `wasm-opt` build variant was not hashed (not installed).
- The hash was run in node and natively only; the two browsers are the
  coordinator's run.
- `Engine::line_ink` still assumes the outset; under `Smear` the true ink is
  narrower above and below and `size / 36` wider on the right. The painter's
  raster is cut from the real shapes, so nothing is clipped, but the measured
  ink box and the painted one differ by that much under `Smear`.
- Under `Smear`, the inner edge of a band round a glyph whose swept outline
  overlaps itself was not examined closely [I that it is fine: the sweep is
  one positively wound shape and the hash and tests pass].
- The parity cases have an arc and a circle for curved text, not a free
  bezier path (the same code paints all three).
- Whether Chromium and WebKit show Skia's hole in a stroke round a small dot.
- Chromium's bold (grown, but not with the canvas scale) has no switch
  position.

## 10. Every hunk in shared files

- `text-engine/src/abi.rs`: +7 lines, one hunk: `pub(crate) fn with_engine`
  under `#[cfg(feature = "paint")]`, so the paint exports can live in their
  own file.
- `text-engine/src/lib.rs`: +2 lines: `#[cfg(feature = "paint")] pub mod
  abi_paint;`.
- `text-engine/Cargo.toml`: `paint` no longer pulls tiny-skia; features
  `raster-tiny-skia`, `raster-zeno`, `raster-vello`, `raster-compare`; `simd`
  becomes `tiny-skia?/simd`; optional dependencies `zeno 0.3.3` and
  `vello_cpu 0.2.0` (comparison builds only, pure Rust); the `paint_hash`
  example requires `paint`. `Cargo.lock` follows.
- `text-engine/src/paint.rs` is replaced by `text-engine/src/paint/`.
- `engine.rs`, `metrics.rs`, `wrap.rs`, `font.rs`, `js/engine.mjs`,
  `src/lib/**`, `scripts/text-port/**` and every existing test: no line
  changed. `shape.rs` uses `measure_line`, `parts`, `bold_extra` and
  `line_advance` as they are.

## 11. Commits

On `tp/paint`, not pushed, no trailers:

- `349042a` the engine paints a glyph job to pixels
- `262e6b5` paintJob, the loader for the painter
- `9d1eb7f` the rasteriser is chosen by measurement, and a stroke is two shapes
- `34ade7a` the painter is pinned feature by feature
- `fe5c23d` the painter is checked against today's canvas painter
- `2a2bf3f` the painter's bytes are hashed across processes and builds
- `4d1812e` letter spacing is checked on a font with ligatures
- `0b3199d` merge of `text-port` (`190e201`)
- `b4f519a` a shape can be swept along a vector
- `fa7531d` the painter draws the line the engine measured, fallback faces and
  both bold rules included
- `7cf9023` the raster hash check can be run outside node, and covers fallback
  and both bold rules
- `e530dcd` how each reference draws a synthesised bold, measured from its
  pictures
- the commit that adds this report
