# Compare implementation notes

The existing [README.md](README.md) remains the recording contract. The
comparator imports no app modules. Run it with:

```sh
node scripts/text-port/compare.mjs BEFORE AFTER --corpus CORPUS --out REPORT
node scripts/text-port/envelope.mjs REFERENCE1 REFERENCE2 REFERENCE3 --out envelope.json
node scripts/text-port/fake-runs.mjs node_modules/.cache/text-port-test/fake
```

`--limit` defaults to 150, per recording group (`metrics`, `layout`, `pixels`),
and accepts zero. Every gate exception gets assets even when
the aggregate fraction passes. All cases, all numeric observations, all
exceptions and statistics remain in `report.json`; the limit only controls
image files. Exact capture PNGs are copied, and alpha-only aligned views are
also saved so differing origins and canvas dimensions do not confuse flicker.

The report embeds compact case display data and initially renders 100 case
rows, with filters and a show-more button. It needs no server or network.
Original PNGs retain their colors; comparison, aligned views and heat maps use
only alpha. Skips and one-sided skips are listed separately; missing captures
and explicit engine errors always make the run fail, even if a custom gates
file omits the corresponding integrity checks.
Manifest counts are checked against JSONL row totals (including skipped/error
rows), and `counts.skipped` against skip records across all three files. Stale
counts are input errors, preventing common dropped rows from passing without a
corpus. The README does not explicitly define whether group counts include
skips; this implementation uses inclusive record counts.

## Gate file format

`gates.json` has `version: 1` and a `gates` array. Every gate has a unique `id`,
`rule`, `enforce` boolean and `why` string. `enforce: false` preserves the
reported pass/fail result without making that gate fail the run. Missing cases
and engine errors still fail because the recording contract requires it.

Rules:

- `number`: `group`, `fields`, and `abs` and/or `rel`. Patterns ending in `*`
  match prefixes. A numeric observation passes absolute **OR** relative
  tolerance. A case passes only if every selected element passes. Array length
  differences also match the array's field pattern and fail that case.
- `image`: `group: "pixels"`, `metric` (`bboxDelta`, `iou`, `meanAbs`, `thick`),
  and `min` and/or `max`.
- `identical-lines`: `group: "layout"`; compares exact strings and order.
- `unchanged`: `group: "layout"`, `property` (`verdictChanged`, `curveChanged`,
  `solveChanged`). All changed answers are listed.
- `integrity`: `kind` (`errors`, `missing`, `hashes`, `invalid`). `invalid`
  selects non-finite/missing numbers and array length mismatches; optional
  `group` restricts it. The default validity check is for metric records;
  layout coordinates and lengths are reported with no invented tolerance.
- `within-envelope`: `group` and numeric `field` or pixel `metric`. Requires
  `--envelope`. Compares absolute difference (or `1-iou`) against the envelope's
  `stat` (`max` by default; also `p50` or `p99`), times `factor` (default 1).
  A missing or non-finite envelope threshold is an input error.
  Invalid candidate numbers and structural array mismatches fail directly,
  without needing a reference distribution for an error absent from references.
  Reference envelope manifests must have the same font/corpus hashes as both
  compared runs; unrelated reference data cannot supply a tolerance.

Other selectors are `mode` and `minSize`. `atLeast` is the required fraction of
cases within tolerance, default 1. No eligible cases are reported as `empty`
and 0/0, not presented as evidence that a populated gate passed. Gate exceptions
are exhaustive, including the allowed tail of a fractional gate.

Without `--corpus`, font grouping uses the id's first dot-separated component;
`smart`/`plain` is recognized only as an id suffix. Font sizes remain unknown;
size-dependent pixel gates conservatively include them, with an explicit
unknown-size list. With a corpus, its actual bytes are hashed and checked
against both manifests. Corpus cases absent from both runs are missing cases.

## Numeric and pixel conventions

- Relative difference is `abs(after-before)/abs(before)`; zero against zero is
  zero, and a nonzero change from zero is infinite. Missing/null/non-finite
  against a finite number is infinite and explicitly marked invalid. Required
  advance/font/layout/solver number fields missing in both runs are reported
  too. JSON stores non-finite values as `"Infinity"`, `"-Infinity"`, `"NaN"`;
  they never silently serialize to null.
- Numeric field statistics pool element observations for arrays (`chars`,
  `lineX`, and curve records). `caseCount` and `perCase` statistics also report
  maxima per case. Every worst list contains up to 200 **distinct cases**.
  Median averages the two middle observations; p99 is nearest rank.
- Envelopes pool case/element observations over every unordered reference-run
  pair, rather than taking a percentile of pair percentiles. Numeric entries
  contain absolute p50/p99/max plus relative statistics. Image entries contain
  raw p50/p99/max; IoU additionally has `loss` statistics of `1-iou` so a larger
  error always means worse. Hash mismatch, missing cases or engine errors in
  reference runs are input errors; threshold disagreements are allowed.
- Texture `ox`/`oy` are page-pixel offsets inside the canvas. Their device
  origin is `(-ox*ss, -oy*ss)`. Layer `left`/`top` locate the crop in page space
  and have device origin `(left*ss, top*ss)`. A common fractional origin is
  fine; relative origins must differ by integer device pixels. Incompatible
  supersampling, texture/layer coordinate systems or fractional relative
  shifts are input errors. Resampling would invent alpha values.
- Bboxes are exclusive on right/bottom, aligned before comparison, and
  independently recomputed from alpha. A recorded bbox or alphaSum inconsistent
  with its PNG is an input error. Empty/empty has bboxDelta 0, IoU 1, meanAbs 0
  and thick 0. Empty/nonempty has infinite bboxDelta. meanAbs is in alpha units
  0–255, divided by the alpha-positive union, not the whole canvas.
- The exact Euclidean transform measures foreground pixel-center distance to
  background pixel centers. A one-pixel exterior background border bounds
  disagreement touching the canvas edge. `thick` is twice its maximum: an
  isolated XOR pixel therefore has thick 2 and fails the initial 1.5 gate.
  Magenta heat-map opacity ranges 128–255 with magnitude to keep XOR visible;
  yellow opacity equals the absolute alpha difference.

The README does not specify gate-file/envelope serialization, percentile
estimation, origin units, fractional-grid behavior, empty-image metrics or the
distance-transform boundary convention. These choices make those gaps
explicit. Capture-engine changes are not necessary for integer-grid records.

## Fixture isolation

The blob fixture uses size 12 (outside the IoU threshold), with faint bounding
anchors so adding its 5×5 opaque blob changes thickness but not its bbox. The
shift fixture uses alpha 100 (below the mask threshold), so its 3-pixel shift
changes bboxDelta without changing threshold-mask thickness or IoU. These
choices make the six failing pairs fail exactly one gate each. With opaque
glyphs, the same changes can fail several gates under the specified formula.
