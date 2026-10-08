# Text-port compare: real-scale verification

All recordings and corpus files were read only. Source changes are limited to
this task's allowed files; no app imports, dependencies, network calls, git
staging, commits or other git write commands were introduced.

## Profiling before changes

The original full-run failure (215 s wall, 834 s CPU, 16,992 images, then
`Invalid string length`) is the user's supplied observation, not a rerun claim.
Before editing, I profiled the real Skia/Chromium inputs: all numeric/layout
records, the first 300 comparable images, and 150 asset sets. The inspector
profile is `node_modules/.cache/text-port-test/before.cpuprofile`; its driver is
`profile-before.mjs` in the same cache directory.

Measured wall phase times:

- Read runs/corpus: 1.597 s.
- Compare all numeric/layout records: 0.680 s.
- Decode 300 image pairs: 2.170 s.
- Align/compare those pairs, including full-canvas EDT: 1.662 s.
- Write 150 five-image asset sets: 2.689 s.
- Build metric statistics: 2.148 s; 22,548 font/field buckets.
- RSS at the end: 3,471,917,056 bytes.

Sampled CPU time included 3.066 s in garbage collection, 2.055 s in native
canvas construction/work, 0.832 s in the one-dimensional EDT, and substantial
statistics/percentile and observation-copy work. The full old run also paid for
thousands of unwanted asset sets and attempted to serialize every case in one
string. I did not extrapolate the sampled image timings into an alleged full
baseline measurement.

The implementation now streams numeric rows and the summary, keeps bounded
worst lists, releases processed input records, crops comparisons to ink bounds
plus margin, and uses recycled workers for comparisons and asset generation.
Assets use batches of 32; comparisons use batches of 128, at most two workers.

## Tests

These are actual summary excerpts; both commands exited 0. The complete output
is in the named cache logs.

`./node_modules/.bin/vitest run src/test/text-port/compare`

```text
 Test Files  8 passed (8)
      Tests  61 passed (61)
   Start at  15:38:45
   Duration  6.54s (transform 134ms, setup 0ms, collect 1.03s, tests 10.59s, environment 1ms, prepare 569ms)
```

Full log: `node_modules/.cache/text-port-test/compare-tests.log`.

`./node_modules/.bin/vitest run`

```text
 Test Files  84 passed | 1 skipped (85)
      Tests  2698 passed | 7 skipped (2705)
   Start at  15:39:09
   Duration  18.49s (transform 4.02s, setup 2.27s, collect 21.58s, tests 82.40s, environment 360ms, prepare 6.65s)
```

Full log: `node_modules/.cache/text-port-test/full-tests.log`.

The scale test generates 20,000 metric cases, 2,000 layouts and 300 images,
mostly failing gates. It checks every JSONL id/count, no summary `cases` array,
2,000-id exception caps with full counts, covered/uncovered twins and statistics,
both report size limits, a hard asset cap, explicit all-assets mode, and reuse
with zero assets removing stale images. Additional tests cover missing corpus,
manifest error counts, exact cropped pixel quantities, streamed worst lists,
reference coverage, skips, unpaired coordinates, and valid curved null fields.

## Real comparison commands and stdout

The two commands were run sequentially after the test suite, with
`TP_PROFILE=1` for stderr phase measurements. Stdout remains 29 lines each.
Peak RSS below is measured with Python
`resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss` (bytes on macOS).

```sh
/usr/bin/time -l node scripts/text-port/compare.mjs /Users/caved/dev/manga-typesetter-wt/tp-data/runs/ref-sk/base /Users/caved/dev/manga-typesetter-wt/tp-data/runs/ref-cr/base --corpus /Users/caved/dev/manga-typesetter-wt/tp-data/corpus --out node_modules/.cache/text-port-test/real-sk-cr
```

```text
Gate                         Result       Within threshold
capture.errors               PASS        85988/85988
capture.missing              PASS        85988/85988
capture.hashes               PASS        5/5
numbers.valid                PASS        64718/64718
metrics.advance              FAIL        56346/57530
metrics.advance.uncovered    FAIL   info 294/7188
metrics.font                 FAIL        51091/57530
metrics.font.uncovered       FAIL   info 6390/7188
metrics.ink                  FAIL        9325/56955
metrics.ink.uncovered        FAIL   info 43/7188
layout.smart-lines           PASS        9436/9493
layout.smart-lines.uncovered FAIL   info 245/250
layout.plain-lines           EMPTY  info 0/0
layout.plain-lines.uncovered EMPTY  info 0/0
layout.verdict               FAIL   info 6557/10013
layout.curve                 FAIL   info 9745/10013
layout.solve                 FAIL   info 10010/10013
pixels.bbox                  FAIL        2583/3349
pixels.bbox.uncovered        FAIL   info 2/52
pixels.thick                 FAIL        5/3349
pixels.thick.uncovered       FAIL   info 0/52
pixels.iou                   FAIL        667/2838
pixels.iou.uncovered         FAIL   info 1/41
metrics: 64718 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 10013 compared; 0 missing; 0 errors; 0 both skipped; 7525 skip mismatches
pixels: 3401 compared; 0 missing; 0 errors; 0 both skipped; 331 skip mismatches
Overall: FAIL
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/real-sk-cr/report.html
```

Timed command exit: 1; wall: 33.425834 s; peak RSS: 2,223,505,408 bytes (2.071 GiB).

| Output | Bytes/count |
| --- | ---: |
| report.json | 401,861,655 bytes |
| report.html | 1,447,054 bytes |
| Files under img/ | 750 |
| cases/metrics.jsonl | 64,718 rows |
| cases/layout.jsonl | 17,538 rows |
| cases/pixels.jsonl | 3,732 rows |

Exact stderr:

```text
Before pixels: {"rss":1993539584,"heapTotal":1308950528,"heapUsed":957984192,"external":13694779,"arrayBuffers":11519420}
After pixels: {"rss":1891893248,"heapTotal":1308950528,"heapUsed":962504528,"external":13695920,"arrayBuffers":11519420}
Compare phases (ms): {"numbers":206.93113299993092,"decode":10427.804910000057,"images":10570.950919000072,"metricsStream":8968.685875000001,"gates":36.44270899999901,"statisticsAndSort":1167.4542500000025}; RSS 1708064768
CLI phases (ms): {"read":1663.2575,"assets":4100.352791000001,"reports":4618.9624170000025}; RSS 1693089792
       33.42 real        46.47 user         3.55 sys
time: sysctl kern.clockrate: Operation not permitted
```

```sh
/usr/bin/time -l node scripts/text-port/compare.mjs /Users/caved/dev/manga-typesetter-wt/tp-data/runs/ref-cr/base /Users/caved/dev/manga-typesetter-wt/tp-data/runs/ref-wk/base --corpus /Users/caved/dev/manga-typesetter-wt/tp-data/corpus --out node_modules/.cache/text-port-test/real-cr-wk
```

```text
Gate                         Result       Within threshold
capture.errors               PASS        85988/85988
capture.missing              PASS        85988/85988
capture.hashes               PASS        5/5
numbers.valid                PASS        64718/64718
metrics.advance              FAIL        34818/57530
metrics.advance.uncovered    FAIL   info 3339/7188
metrics.font                 PASS        57530/57530
metrics.font.uncovered       PASS   info 7188/7188
metrics.ink                  FAIL        6729/56955
metrics.ink.uncovered        FAIL   info 180/7188
layout.smart-lines           PASS        9498/9558
layout.smart-lines.uncovered FAIL   info 248/251
layout.plain-lines           FAIL   info 7220/7382
layout.plain-lines.uncovered FAIL   info 70/77
layout.verdict               FAIL   info 11796/17538
layout.curve                 FAIL   info 17295/17538
layout.solve                 PASS   info 17538/17538
pixels.bbox                  FAIL        3337/3675
pixels.bbox.uncovered        FAIL   info 42/57
pixels.thick                 FAIL        11/3675
pixels.thick.uncovered       FAIL   info 0/57
pixels.iou                   FAIL        1795/3162
pixels.iou.uncovered         FAIL   info 17/45
metrics: 64718 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
layout: 17538 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
pixels: 3732 compared; 0 missing; 0 errors; 0 both skipped; 0 skip mismatches
Overall: FAIL
Report: /Users/caved/dev/manga-typesetter-wt/tp-compare/node_modules/.cache/text-port-test/real-cr-wk/report.html
```

Timed command exit: 1; wall: 21.200210 s; peak RSS: 2,411,216,896 bytes (2.246 GiB).

| Output | Bytes/count |
| --- | ---: |
| report.json | 406,748,218 bytes |
| report.html | 3,350,954 bytes |
| Files under img/ | 750 |
| cases/metrics.jsonl | 64,718 rows |
| cases/layout.jsonl | 17,538 rows |
| cases/pixels.jsonl | 3,732 rows |

Exact stderr:

```text
Before pixels: {"rss":2145009664,"heapTotal":1505050624,"heapUsed":889677680,"external":7214324,"arrayBuffers":5030496}
After pixels: {"rss":2056192000,"heapTotal":1142292480,"heapUsed":524364184,"external":7206996,"arrayBuffers":143615}
Compare phases (ms): {"numbers":177.8429169999581,"decode":7666.005055999991,"images":7586.120095000068,"metricsStream":5186.603208,"gates":31.882290999999896,"statisticsAndSort":626.2937920000004}; RSS 2073444352
CLI phases (ms): {"read":1060.885833,"assets":1324.172708,"reports":3526.5426670000015}; RSS 1562886144
       21.19 real        31.20 user         2.25 sys
time: sysctl kern.clockrate: Operation not permitted
```

Both reports complete with expected exit 1 for reference disagreements; all
capture/hash/metric-validity guards pass. HTML is under 5 MB. The summary JSON
is about 400 MB because it retains the full font/glyph field statistics and
200-worst lists; it is streamed, contains no top-level case rows, and has no
single serialization string. The scale fixture's summaries are under 5 MB.

For the final Skia/Chromium run, metrics streaming/comparison/statistics took
8.969 s, worker decoding 10.428 s and image comparison 10.571 s summed across
two workers, asset generation 4.100 s, summary/full-row/HTML writing 4.619 s,
and input reading 1.663 s. Chrome/WebKit used 5.187 s for metrics streaming,
7.666 s decoding and 7.586 s comparing (worker sums), 1.324 s generating
assets, 3.527 s writing reports, and 1.061 s reading. These phase counters do
not sum to wall time when workers overlap.

## Three-reference envelope

```sh
node scripts/text-port/envelope.mjs /Users/caved/dev/manga-typesetter-wt/tp-data/runs/ref-sk/base /Users/caved/dev/manga-typesetter-wt/tp-data/runs/ref-cr/base /Users/caved/dev/manga-typesetter-wt/tp-data/runs/ref-wk/base --corpus /Users/caved/dev/manga-typesetter-wt/tp-data/corpus --out node_modules/.cache/text-port-test/real-envelope.json
```

```text
Envelope: 3 runs, 3 pairs, 480 metrics -> node_modules/.cache/text-port-test/real-envelope.json
```

Exit 0; wall 38.239933 s; peak RSS 3,797,467,136 bytes. No images are written.

Covered distributions (displayed to nine significant figures; JSON keeps unrounded values):

Pair | Covered metric | Count | p50 | p99 | max
--- | --- | ---: | ---: | ---: | ---:
ref-sk / ref-cr | metrics.adv | 57530 | 0.00199890137 | 4.16015625 | 44.8277588
ref-sk / ref-cr | metrics.font.ascent | 57530 | 0.203999519 | 10 | 32.4000015
ref-sk / ref-cr | metrics.ink.right | 56955 | 0.51798439 | 4.07263565 | 49.2793751
ref-sk / ref-cr | pixels.bboxDelta | 3349 | 1 | 12 | Infinity
ref-sk / ref-cr | pixels.iou | 3349 | 0.92583398 | 0.990728384 | 1
ref-sk / ref-cr | pixels.thick | 3349 | 2 | 10.7703296 | 40.4969135
ref-sk / ref-wk | metrics.adv | 57530 | 0.00400018692 | 39.1109619 | 121.245361
ref-sk / ref-wk | metrics.font.ascent | 57530 | 0.203999519 | 10 | 32.4000015
ref-sk / ref-wk | metrics.ink.right | 56955 | 1.05583191 | 21.3147583 | 79.7150879
ref-sk / ref-wk | pixels.bboxDelta | 3349 | 1 | 11 | 145
ref-sk / ref-wk | pixels.iou | 3349 | 0.922849542 | 0.990589241 | 1
ref-sk / ref-wk | pixels.thick | 3349 | 2 | 12.1655251 | 80.0499844
ref-cr / ref-wk | metrics.adv | 57530 | 9.15527344e-05 | 39.111084 | 121.250977
ref-cr / ref-wk | metrics.font.ascent | 57530 | 0 | 0 | 0
ref-cr / ref-wk | metrics.ink.right | 56955 | 1.25523949 | 22.6319962 | 80.0819092
ref-cr / ref-wk | pixels.bboxDelta | 3675 | 1 | 13 | Infinity
ref-cr / ref-wk | pixels.iou | 3675 | 0.972181462 | 0.996693861 | 1
ref-cr / ref-wk | pixels.thick | 3675 | 2 | 14.5602198 | 79.6241169

Pair | All line-eligible smart cases | Covered | Uncovered | Skipped cases
--- | --- | --- | --- | ---:
ref-sk / ref-cr | 9681/9743 = 0.993636457 | 9436/9493 = 0.993995576 | 245/250 = 0.98 | 7856
ref-sk / ref-wk | 9678/9743 = 0.993328544 | 9436/9493 = 0.993995576 | 242/250 = 0.968 | 7856
ref-cr / ref-wk | 9746/9809 = 0.993577327 | 9498/9558 = 0.993722536 | 248/251 = 0.988047809 | 0

Smart-line denominators exclude curved layouts that have no line arrays;
solver lines are included. Skipped cases are excluded per pair, with counts
and ids retained. The two pairs involving Skia each skip 7,525 layouts and
331 pixels; the browser pair skips none. Unpaired coordinate observations from
different line/curve array lengths are counted separately; malformed paired
coordinates still reject the reference.

## Capture observations

No confirmed capture bug was found: counts, hashes, finite metric numbers and
PNG bbox/alphaSum integrity all pass. `p.fx.0.clip-exclude.1` causes infinite
empty-versus-ink bbox delta: Chromium is empty, Skia retains one pixel with
alpha sum 1, and WebKit retains one pixel with alpha sum 14. These PNGs agree
with their records, their threshold masks are empty, and the difference looks
like clip antialiasing, not capture corruption. It remains measured and gated.

The largest covered Chrome/WebKit advance delta is
`c.tsukimichi__122.p19.bb255.m0` (121.2509765625 px), with bold styling. Large
synthetic deltas also cluster under `faux-bold`, including
`m.53-stabby-thin.b.40.pangram` and `m.29-heaters.b.40.pangram`.
Different synthetic-bold handling is a plausible engine explanation; these
observations do not establish a capture/font-registration bug.

## Limitations, sandbox restrictions and deviations

- Both comparison commands meet the 60 s target and 90 s limit; the envelope
  meets the three-minute limit. The memory aim is missed: final comparison
  peaks are 2.22 GB and 2.41 GB rather than under 2 GB. The envelope peaks at
  3.80 GB while pooling the three pairs. These are measured values, not claims
  that the aim was met.
- Both `/usr/bin/time -l node scripts/text-port/compare.mjs ...` invocations
  ran the comparator and printed wall/user/system times, but their extended
  resource lookup failed with exactly
  `time: sysctl kern.clockrate: Operation not permitted`. Their peak-memory
  output is therefore unavailable; the separately measured child rusage
  values above supply the peak RSS. A diagnostic
  `ps -axo pid,rss,command` was also blocked with
  `zsh:1: operation not permitted: ps`.
- Valid curved null fields and unmatched coordinates from changed line arrays
  are handled according to the recording contract rather than treated as
  broken numeric captures. Their decisions and unmatched-observation counts
  remain reported. Smart-line shares state their line-eligible denominator.
- No other brief deviations. No required command was skipped. No source
  outside the allowed paths or data files was modified.

## Files changed

- `scripts/text-port/compare.mjs`
- `scripts/text-port/envelope.mjs`
- `scripts/text-port/fake-runs.mjs`
- `scripts/text-port/gates.json`
- `scripts/text-port/COMPARISON.md`
- `scripts/text-port/VERIFICATION.md`
- `src/test/text-port/compare/compare.js`
- `src/test/text-port/compare/envelope.js`
- `src/test/text-port/compare/fixtures.js`
- `src/test/text-port/compare/gates.js`
- `src/test/text-port/compare/html.js`
- `src/test/text-port/compare/images.js`
- `src/test/text-port/compare/io.js`
- `src/test/text-port/compare/layout.js`
- `src/test/text-port/compare/numbers.js`
- `src/test/text-port/compare/pixel-worker.js`
- `src/test/text-port/compare/cli.test.js`
- `src/test/text-port/compare/envelope.test.js`
- `src/test/text-port/compare/gates.test.js`
- `src/test/text-port/compare/images.test.js`
- `src/test/text-port/compare/numbers.test.js`
- `src/test/text-port/compare/scale.test.js`
