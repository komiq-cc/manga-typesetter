# Text-port compare verification

Implemented the independent comparator, reference envelope CLI, gates, fake-run generator and self-contained HTML report. No app modules are imported. Existing tracked files were unchanged (`git diff --exit-code` exited 0); no git write commands were run. No requested command was blocked by the sandbox.

## Files created

- `src/test/text-port/compare/cli.test.js`
- `src/test/text-port/compare/compare.js`
- `src/test/text-port/compare/distance.js`
- `src/test/text-port/compare/envelope.js`
- `src/test/text-port/compare/fixtures.js`
- `src/test/text-port/compare/gates.js`
- `src/test/text-port/compare/gates.test.js`
- `src/test/text-port/compare/html.js`
- `src/test/text-port/compare/html.test.js`
- `src/test/text-port/compare/images.js`
- `src/test/text-port/compare/images.test.js`
- `src/test/text-port/compare/io.js`
- `src/test/text-port/compare/layout.js`
- `src/test/text-port/compare/numbers.js`
- `src/test/text-port/compare/numbers.test.js`
- `src/test/text-port/compare/records.js`
- `src/test/text-port/compare/records.test.js`
- `src/test/text-port/compare/stats.js`
- `scripts/text-port/COMPARISON.md`
- `scripts/text-port/VERIFICATION.md`
- `scripts/text-port/compare.mjs`
- `scripts/text-port/envelope.mjs`
- `scripts/text-port/fake-runs.mjs`
- `scripts/text-port/gates.json`

Generated fixtures, PNGs, reports and command logs are under `node_modules/.cache/text-port-test/`, outside the source additions.

## Acceptance output

The following is real command output. Both vitest commands exited 0. They ran concurrently, so durations include contention.

`./node_modules/.bin/vitest run src/test/text-port/compare`

```text

 RUN  v3.2.7 /Users/caved/dev/manga-typesetter-wt/tp-compare

 ✓ |unit| src/test/text-port/compare/images.test.js (7 tests) 71ms
 ✓ |unit| src/test/text-port/compare/numbers.test.js (10 tests) 8ms
 ✓ |unit| src/test/text-port/compare/records.test.js (6 tests) 5ms
 ✓ |unit| src/test/text-port/compare/gates.test.js (9 tests) 23ms
 ✓ |unit| src/test/text-port/compare/html.test.js (2 tests) 505ms
   ✓ report in a DOM with 2,000 cases > renders only 100 rows initially, supports show-more and combines font/tag/gate/search filters  378ms
 ✓ |unit| src/test/text-port/compare/cli.test.js (17 tests) 9476ms
   ✓ complete CLI > fails blob with exactly the expected enforced gate pixels.thick  434ms
   ✓ complete CLI > fails shift with exactly the expected enforced gate pixels.bbox  394ms
   ✓ complete CLI > fails missing with exactly the expected enforced gate capture.missing  446ms
   ✓ complete CLI > fails hash with exactly the expected enforced gate capture.hashes  524ms
   ✓ complete CLI > counts and lists skips, and one-sided skips do not fail  437ms
   ✓ complete CLI > makes any capture error fail the run  503ms
   ✓ complete CLI > includes failure assets even with a zero image limit  479ms
   ✓ complete CLI > reports missing/null numeric fields rather than skipping them  478ms
   ✓ complete CLI > report-only gates never fail an otherwise valid pair  406ms
   ✓ complete CLI > returns input-error exit 2 for usage errors, duplicates and bad PNG metadata  2447ms
   ✓ complete CLI > builds every reference pair and supports within-envelope and annotation in the compare CLI  1668ms
   ✓ complete CLI > rejects stale manifest counts so common dropped JSONL rows cannot silently pass  429ms

 Test Files  6 passed (6)
      Tests  51 passed (51)
   Start at  14:48:21
   Duration  10.12s (transform 98ms, setup 0ms, collect 904ms, tests 10.09s, environment 1ms, prepare 391ms)
```

`./node_modules/.bin/vitest run` (summary excerpt; full output in `node_modules/.cache/text-port-test/full-tests.log`)

```text
Test Files  76 passed (76)
      Tests  2651 passed | 6 skipped (2657)
   Start at  14:48:21
   Duration  15.06s (transform 3.80s, setup 1.83s, collect 17.14s, tests 53.48s, environment 467ms, prepare 5.86s)
```

The whole suite has the original 70 files / 2,600 passing tests / 6 skipped, plus 6 new test files / 51 passing tests.

### Fake CLI pairs

Fixtures were generated with `node scripts/text-port/fake-runs.mjs node_modules/.cache/text-port-test/acceptance`. Each failing pair below has exactly one failed gate, including report-only gates in that check.

**pass, exit 0**

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/acceptance/before node_modules/.cache/text-port-test/acceptance/pass --corpus node_modules/.cache/text-port-test/acceptance/corpus --out node_modules/.cache/text-port-test/acceptance/reports/pass`

```text
Gate                         Result       Within threshold
capture.errors               PASS        7/7
capture.missing              PASS        7/7
capture.hashes               PASS        5/5
numbers.valid                PASS        2/2
metrics.advance              PASS        2/2
metrics.font                 PASS        2/2
metrics.ink                  PASS        2/2
layout.smart-lines           PASS        2/2
layout.plain-lines           EMPTY  info 0/0
layout.verdict               PASS   info 2/2
layout.curve                 PASS   info 2/2
layout.solve                 PASS   info 2/2
pixels.bbox                  PASS        3/3
pixels.thick                 PASS        3/3
pixels.iou                   PASS        2/2
metrics: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 3 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: PASS
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/acceptance/reports/pass/report.html
```

**advance, exit 1**

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/acceptance/before node_modules/.cache/text-port-test/acceptance/advance --corpus node_modules/.cache/text-port-test/acceptance/corpus --out node_modules/.cache/text-port-test/acceptance/reports/advance`

```text
Gate                         Result       Within threshold
capture.errors               PASS        7/7
capture.missing              PASS        7/7
capture.hashes               PASS        5/5
numbers.valid                PASS        2/2
metrics.advance              FAIL        1/2
metrics.font                 PASS        2/2
metrics.ink                  PASS        2/2
layout.smart-lines           PASS        2/2
layout.plain-lines           EMPTY  info 0/0
layout.verdict               PASS   info 2/2
layout.curve                 PASS   info 2/2
layout.solve                 PASS   info 2/2
pixels.bbox                  PASS        3/3
pixels.thick                 PASS        3/3
pixels.iou                   PASS        2/2
metrics: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 3 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: FAIL
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/acceptance/reports/advance/report.html
```

**lines, exit 1**

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/acceptance/before node_modules/.cache/text-port-test/acceptance/lines --corpus node_modules/.cache/text-port-test/acceptance/corpus --out node_modules/.cache/text-port-test/acceptance/reports/lines`

```text
Gate                         Result       Within threshold
capture.errors               PASS        7/7
capture.missing              PASS        7/7
capture.hashes               PASS        5/5
numbers.valid                PASS        2/2
metrics.advance              PASS        2/2
metrics.font                 PASS        2/2
metrics.ink                  PASS        2/2
layout.smart-lines           FAIL        1/2
layout.plain-lines           EMPTY  info 0/0
layout.verdict               PASS   info 2/2
layout.curve                 PASS   info 2/2
layout.solve                 PASS   info 2/2
pixels.bbox                  PASS        3/3
pixels.thick                 PASS        3/3
pixels.iou                   PASS        2/2
metrics: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 3 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: FAIL
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/acceptance/reports/lines/report.html
```

**blob, exit 1**

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/acceptance/before node_modules/.cache/text-port-test/acceptance/blob --corpus node_modules/.cache/text-port-test/acceptance/corpus --out node_modules/.cache/text-port-test/acceptance/reports/blob`

```text
Gate                         Result       Within threshold
capture.errors               PASS        7/7
capture.missing              PASS        7/7
capture.hashes               PASS        5/5
numbers.valid                PASS        2/2
metrics.advance              PASS        2/2
metrics.font                 PASS        2/2
metrics.ink                  PASS        2/2
layout.smart-lines           PASS        2/2
layout.plain-lines           EMPTY  info 0/0
layout.verdict               PASS   info 2/2
layout.curve                 PASS   info 2/2
layout.solve                 PASS   info 2/2
pixels.bbox                  PASS        3/3
pixels.thick                 FAIL        2/3
pixels.iou                   PASS        2/2
metrics: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 3 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: FAIL
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/acceptance/reports/blob/report.html
```

**shift, exit 1**

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/acceptance/before node_modules/.cache/text-port-test/acceptance/shift --corpus node_modules/.cache/text-port-test/acceptance/corpus --out node_modules/.cache/text-port-test/acceptance/reports/shift`

```text
Gate                         Result       Within threshold
capture.errors               PASS        7/7
capture.missing              PASS        7/7
capture.hashes               PASS        5/5
numbers.valid                PASS        2/2
metrics.advance              PASS        2/2
metrics.font                 PASS        2/2
metrics.ink                  PASS        2/2
layout.smart-lines           PASS        2/2
layout.plain-lines           EMPTY  info 0/0
layout.verdict               PASS   info 2/2
layout.curve                 PASS   info 2/2
layout.solve                 PASS   info 2/2
pixels.bbox                  FAIL        2/3
pixels.thick                 PASS        3/3
pixels.iou                   PASS        2/2
metrics: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 3 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: FAIL
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/acceptance/reports/shift/report.html
```

**missing, exit 1**

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/acceptance/before node_modules/.cache/text-port-test/acceptance/missing --corpus node_modules/.cache/text-port-test/acceptance/corpus --out node_modules/.cache/text-port-test/acceptance/reports/missing`

```text
Gate                         Result       Within threshold
capture.errors               PASS        7/7
capture.missing              FAIL        6/7
capture.hashes               PASS        5/5
numbers.valid                PASS        2/2
metrics.advance              PASS        1/1
metrics.font                 PASS        1/1
metrics.ink                  PASS        1/1
layout.smart-lines           PASS        2/2
layout.plain-lines           EMPTY  info 0/0
layout.verdict               PASS   info 2/2
layout.curve                 PASS   info 2/2
layout.solve                 PASS   info 2/2
pixels.bbox                  PASS        3/3
pixels.thick                 PASS        3/3
pixels.iou                   PASS        2/2
metrics: 1 compared; 1 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 3 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: FAIL
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/acceptance/reports/missing/report.html
```

**hash, exit 1**

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/acceptance/before node_modules/.cache/text-port-test/acceptance/hash --corpus node_modules/.cache/text-port-test/acceptance/corpus --out node_modules/.cache/text-port-test/acceptance/reports/hash`

```text
Gate                         Result       Within threshold
capture.errors               PASS        7/7
capture.missing              PASS        7/7
capture.hashes               FAIL        3/5
numbers.valid                PASS        2/2
metrics.advance              PASS        2/2
metrics.font                 PASS        2/2
metrics.ink                  PASS        2/2
layout.smart-lines           PASS        2/2
layout.plain-lines           EMPTY  info 0/0
layout.verdict               PASS   info 2/2
layout.curve                 PASS   info 2/2
layout.solve                 PASS   info 2/2
pixels.bbox                  PASS        3/3
pixels.thick                 PASS        3/3
pixels.iou                   PASS        2/2
metrics: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 3 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
WARNING: hash mismatch: corpus, supplied corpus.metrics
Overall: FAIL
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/acceptance/reports/hash/report.html
```

### Envelope smoke check

`node scripts/text-port/envelope.mjs node_modules/.cache/text-port-test/acceptance/before node_modules/.cache/text-port-test/acceptance/pass node_modules/.cache/text-port-test/acceptance/advance --out node_modules/.cache/text-port-test/acceptance/envelope.json` exited 0:

```text
Envelope: 3 runs, 3 pairs, 23 metrics -> node_modules/.cache/text-port-test/acceptance/envelope.json
```

A temporary custom gates file replaced the advance gate with `within-envelope`, using the pairwise maximum. The candidate advance difference is 0.5 px, equal to that reference maximum:

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/acceptance/before node_modules/.cache/text-port-test/acceptance/advance --corpus node_modules/.cache/text-port-test/acceptance/corpus --out node_modules/.cache/text-port-test/acceptance/reports/envelope --envelope node_modules/.cache/text-port-test/acceptance/envelope.json --gates node_modules/.cache/text-port-test/acceptance/envelope-gates.json` (exit 0)

```text
Gate                         Result       Within threshold
capture.errors               PASS        7/7 envelope: no comparable metric
capture.missing              PASS        7/7 envelope: no comparable metric
capture.hashes               PASS        5/5 envelope: no comparable metric
numbers.valid                PASS        2/2 envelope: no comparable metric
metrics.advance              PASS        2/2 envelope max ratios: adv=1
metrics.font                 PASS        2/2 envelope max ratios: font.ascent=0, font.descent=0
metrics.ink                  PASS        2/2 envelope max ratios: ink.l=0, ink.t=0, ink.r=0, ink.b=0, glyphs.A.l=0, glyphs.A.r=0
layout.smart-lines           PASS        2/2 envelope: no comparable metric
layout.plain-lines           EMPTY  info 0/0 envelope: no comparable metric
layout.verdict               PASS   info 2/2 envelope: no comparable metric
layout.curve                 PASS   info 2/2 envelope: no comparable metric
layout.solve                 PASS   info 2/2 envelope: no comparable metric
pixels.bbox                  PASS        3/3 envelope max ratios: bboxDelta=0
pixels.thick                 PASS        3/3 envelope max ratios: thick=0
pixels.iou                   PASS        2/2 envelope max ratios: iou=0
metrics: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 3 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: PASS
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/acceptance/reports/envelope/report.html
```

### Size and runtime

Wall time covers the entire spawned CLI process, including input reads, comparisons, report serialization and image copies/encoding. Fixture generation is excluded. Both use the default image limit of 150.

**large-report**: 817.31 ms; report.html **700,145 bytes**; exit 0.

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/large-report/before node_modules/.cache/text-port-test/large-report/pass --corpus node_modules/.cache/text-port-test/large-report/corpus --out node_modules/.cache/text-port-test/large-report/report`

```text
Gate                         Result       Within threshold
capture.errors               PASS        2004/2004
capture.missing              PASS        2004/2004
capture.hashes               PASS        5/5
numbers.valid                PASS        2/2
metrics.advance              PASS        2/2
metrics.font                 PASS        2/2
metrics.ink                  PASS        2/2
layout.smart-lines           PASS        2/2
layout.plain-lines           EMPTY  info 0/0
layout.verdict               PASS   info 2/2
layout.curve                 PASS   info 2/2
layout.solve                 PASS   info 2/2
pixels.bbox                  PASS        2000/2000
pixels.thick                 PASS        2000/2000
pixels.iou                   PASS        1999/1999
metrics: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 2 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 2000 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: PASS
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/large-report/report/report.html
```

**perf**: 8269.60 ms; report.html **1,827,862 bytes**; exit 1.

`node scripts/text-port/compare.mjs node_modules/.cache/text-port-test/perf/before node_modules/.cache/text-port-test/perf/pass --corpus node_modules/.cache/text-port-test/perf/corpus --out node_modules/.cache/text-port-test/perf/report`

```text
Gate                         Result       Within threshold
capture.errors               PASS        9400/9400
capture.missing              PASS        9400/9400
capture.hashes               PASS        5/5
numbers.valid                PASS        8000/8000
metrics.advance              PASS        8000/8000
metrics.font                 PASS        8000/8000
metrics.ink                  PASS        8000/8000
layout.smart-lines           PASS        1000/1000
layout.plain-lines           EMPTY  info 0/0
layout.verdict               PASS   info 1000/1000
layout.curve                 PASS   info 1000/1000
layout.solve                 PASS   info 1000/1000
pixels.bbox                  PASS        400/400
pixels.thick                 FAIL        0/400
pixels.iou                   FAIL        398/399
metrics: 8000 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 1000 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 400 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: FAIL
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/perf/report/report.html
```

The 2,000-pixel fixture uses 16×12 PNGs, plus two metric and two layout cases. Its report retains all 2,000 cases and saves assets for 150 pixel cases. DOM tests verify that a 2,000-case report initially creates only 100 case rows, supports show-more, combines font/tag/gate/search filters and swaps aligned images for flicker.

The performance fixture contains 8,000 metrics (32 character advances each), 1,000 layouts and 400 PNGs at 600×300. Every PNG has a threshold-mask XOR, forcing the exact EDT; all 400 cases get failure assets (2,000 output PNGs). Its exit 1 is expected: all 400 thickness gates fail, and one size-qualified IoU case fails. The complete comparison finishes well under one minute.

## Deviations and explicit contract choices

- No changes to existing files, run/record filenames, dependencies or app code. Only source additions under the two authorized directories, plus authorized temporary cache data.
- Fractional relative device-pixel origins, differing supersampling and texture-versus-layer coordinate systems produce input-error exit 2. The contract does not define resampling for these inputs; the closest strict behavior avoids inventing alpha values. Different canvas sizes and common fractional origins are supported.
- Missing cases and explicit engine errors remain fatal even if a custom gate file disables or omits their guards. This preserves the README’s unconditional failure rule; report-only flags cannot turn a broken capture into an acceptable run. Other gate enforcement flags are respected.
- Manifest group counts are interpreted as all JSONL rows, including skipped/error rows, with counts.skipped summing skips across all files. Stale counts produce input errors. The contract does not explicitly state count inclusion semantics.
- Relative error uses the reference magnitude; infinities are explicit strings in JSON. Numeric array statistics pool observations and also expose case maxima; worst lists contain 200 distinct cases. Median averages middle values and p99 uses nearest rank. Envelopes pool all unordered-pair observations, with an additional 1-iou loss distribution.
- Texture origin offsets are interpreted in page pixels and multiplied by ss; layer origins have the opposite sign. Empty-image metrics and a background border for the pixel-center EDT are defined explicitly. A singleton XOR has thick 2. These conventions and gate/envelope schemas fill gaps in the README and are detailed in [COMPARISON.md](COMPARISON.md).
- Without corpus metadata, font grouping uses the id prefix, mode uses a smart/plain suffix when present, and unknown font sizes are explicitly listed and conservatively included in the IoU gate.
- Asset groups mean metrics/layout/pixels. Every gate exception receives assets, including report-only and tolerated fractional-tail exceptions; all other cases retain numeric/pixel data without image files.
- The blob fixture uses size 12 and faint bounding anchors to isolate thickness; the shift fixture uses alpha 100 to isolate bboxDelta. Ordinary opaque glyph changes can fail multiple pixel gates.

## Open contract questions

- Confirm the page-pixel origin interpretation and whether differing ss or fractional relative grids should instead have a specified resampling policy.
- Should the literal pixel-center EDT remain paired with thick <= 1.5? It rejects any singleton threshold-mask disagreement (thick 2).
- Confirm inclusive manifest counts, pooled pairwise envelope observations, nearest-rank p99 and observation-level array statistics (case-level statistics are also provided).
- Does “per group” for image limits mean recording category, as implemented, or a font/tag subdivision?
