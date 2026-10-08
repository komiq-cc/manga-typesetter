# Compare implementation notes

The existing [README.md](README.md) remains the recording contract. The
comparator imports no app modules. Run it with:

```sh
node scripts/text-port/compare.mjs BEFORE AFTER --corpus CORPUS --out REPORT
node scripts/text-port/envelope.mjs REFERENCE1 REFERENCE2 REFERENCE3 --corpus CORPUS --out envelope.json
node scripts/text-port/fake-runs.mjs node_modules/.cache/text-port-test/fake
```

`--limit` defaults to 150 per recording group and accepts zero. Gate
exceptions rank first, followed by severity and id; a failing gate never lifts
the cap. `--assets all` lifts the image cap explicitly. Only pixel records have
capture PNGs. Each selected pixel produces five files: exact before/after,
aligned alpha before/after, and a heat map. Reusing an output directory removes
its previous `img/` files before writing the new selection.

`report.json` is a streamed summary: manifests, counts, gates, capped exception
ids, font/field statistics and 200-worst lists, font/tag gate tables, and asset
selection ids. It contains no `cases` array. Every joined case, including skips,
missing records and errors, is written as a complete row to
`cases/metrics.jsonl`, `cases/layout.jsonl` or `cases/pixels.jsonl`.
Non-finite differences remain explicit strings, including in streamed rows.
Large summaries are serialized in chunks rather than one giant string.

The self-contained HTML embeds only cases with image assets and the worst
`--limit` metric and layout rows. It states that these are a sample, gives the
full totals, and links the three JSONL files. The first 100 sample rows render
initially; font/tag/gate/search filters, show-more and flicker remain available.
HTML font and tag tables show gate quantities; complete font/field numeric
statistics and their 200-worst lists remain in the JSON summary.

Missing captures and explicit engine errors always fail, even if custom gates
omit their integrity guards. Manifest group counts include all JSONL rows;
`counts.skipped` and `counts.errors` must match the corresponding records
across all groups. A stale count is an input error.

Metric rows are processed in batches of 500. Statistics accumulate numeric
observations and bounded worst lists without copying every observation into a
second object graph. The CLI streams full rows and releases processed metric
input records, retaining only detailed HTML sample rows. Pixel comparisons run
in at most two worker threads, recycled after 128 cases each to bound native
PNG-decoder allocations. Alpha alignment and the exact distance transform use
the union of the validated ink bounds plus a one-pixel background margin.
Original capture images and their integrity checks remain unchanged.

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
and 0/0, not presented as evidence that a populated gate passed. Every case's failing gates are retained in its JSONL row, including allowed
fractional tails. Each summary exception list contains at most 2,000 ids;
`exceptionCount`, `failures` and `exceptionsTruncated` disclose the full count.
Unknown-size ids are likewise capped with an uncapped `unknownSizeCount`.

`excludeTags` rejects a case carrying any listed tag. `onlyTags` includes cases
carrying any listed tag; if both selectors appear their filters intersect.
Even empty tag-selector arrays require `--corpus`; omitting it is exit 2.
Every default number/image/line gate excludes `uncovered` and has an otherwise
identical `.uncovered` report-only twin. Integrity gates remain unconditional.

Each group's `byTag` table has a row per corpus tag and explicit `covered` and
`uncovered` rows. Tags can overlap; case counts include every status, while
quantity observations count only eligible cases. Numeric gate quantities are
per-case maximum absolute differences across selected fields; image quantities
are raw metrics, including raw IoU; line/decision/integrity quantities are 0 or
1. Each row reports eligible count, failure count and p50/p99/max per gate.
`byFont` uses the same quantities. Ungated cases do not receive invented zeros.

Curved layouts have no straight lines or straight coordinates. Their null
fields are valid and line gates exclude them; their curve glyphs and changes
remain reported. Smart-line shares use cases with comparable line arrays,
including solver lines.

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

## Reference envelope at scale

The envelope processes one pair at a time, releases its detailed rows, and
writes no image assets. It retains pooled distributions and also `pairwise`
rows with `metrics` (all cases), `covered` and `uncovered` distributions for
every numeric field and pixel metric. IoU keeps both raw and `loss` statistics.
Each pair counts cases skipped by either reference, including group totals,
and excludes them from that pair's observations. `smartLines` gives count,
identical count and share for all, covered and uncovered line-eligible layouts.

Different line/curve array lengths can leave coordinates without a counterpart.
Those observations have no finite delta and are counted by field in
`unpairedObservations`; array length differences remain measured. Null or
missing coordinates inside paired array elements still reject the reference.
Missing cases, explicit capture errors, hash mismatches and invalid metric
numbers remain input errors. Without `--corpus`, coverage tables are null and
metadata explicitly states that tags are unknown.

For a reproducible mostly failing scale fixture:

```sh
node scripts/text-port/fake-runs.mjs node_modules/.cache/text-port-test/scale \
  --metrics 20000 --layout 2000 --pixels 300 --passing-only --failing
```

Set `TP_PROFILE=1` to print phase timings and RSS to stderr. Worker decode and
image times sum work across both threads; they are not wall-clock totals.
