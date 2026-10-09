# Lettering benchmark

Synthetic balloons run through the app's own placement and layout with real
fonts, and measured. Nothing here is from a real book: the pages are drawn by
`runner.js` (screentone, some art strokes, a white balloon in a dark outline)
and the English in `cases.js` was written for it.

| File | What |
|---|---|
| `cases.js` | the cases: page, balloon, detector rectangle, translation, tag, style, a letterer's size |
| `runner.js` | draws the page, runs the layout, measures, writes the report and contact sheets |
| `approved.json` | the approved layout per case (box, size, lines). Starts empty |
| `../../lib/typeset-bench.realfont.test.js` | the test that runs it |

## Running

```sh
npx vitest run                    # runs it with everything else, prints the table, writes nothing
node scripts/typeset-bench.mjs    # the same, plus report.json and one PNG per category
```

The script writes to `node_modules/.cache/typeset-bench/`: `report.json` (every
case's layout and metrics) and `<category>.png` contact sheets, each tile the
page around the balloon with the detector's rectangle (dashed blue), the box
(magenta) and the text as the exporter paints it. Options:

- `--out DIR` writes somewhere else.
- `--approve all` or `--approve oval-short,edge-tiny` records those cases'
  current layout in `approved.json`. Later runs report each case as `same`,
  `changed(<fields>)` or `new` (not approved yet). Nothing fails on a change.
- `--layout path/to/module.js` benchmarks another layout (below).

The script only sets `TYPESET_BENCH_OUT`, `TYPESET_BENCH_APPROVE` and
`TYPESET_BENCH_LAYOUT` and runs the test file in the `realfont` project, so
those variables work on a plain `npx vitest run --project realfont` too.

## Two engines

Every run does the cases twice: under the browser engine (this lane's canvas,
Skia) and under the Rust text engine (`text-engine/`, measuring from the same
fixture files and painting its own glyphs). The Rust run needs the wasm:
`npm run build:engine`.

- The first table, the summary, the approvals and `report.json`'s `cases` are
  the browser engine's, as they were before there was a second engine.
- After them comes one table with both, each number as `browser | rust`, and
  the list of cases that differ: the layout fields that are not the same
  (size, box, lines) with both layouts, and the ink numbers that moved.
- With `--out`, `report.json` also holds `rust.cases` and `differences`, and
  each category has a second sheet, `<category>.rust.png`.
- `--approve` records the browser engine's layouts only. `approved.json` has
  no Rust entries, and a Rust result is never compared with it.
- `runBench(cases, { engine: 'rust' })` in `runner.js` runs one engine alone;
  `compareEngines(a, b)` compares any two runs.

## Plugging in a layout

The default layout is the store's: `placeDetectedOnPage`, then the lines every
renderer lays that box out in. Another one is a module whose default (or
`layout`) export is

```js
(benchCase, { page, line, det, style }) => ({ x, y, w, h, size, lines, fit, path })
```

`page`, `line` and `det` are the loaded store page, its one line and its one
detection; `style` is the style the store would give a box born on that line.
Return the box in page px, the font size, the lines as laid out, the balloon
fit the box is laid out to (or null), and the layout path if the layout knows
it. The module is imported inside the test run, so it can import app modules
(same store, same mocks). Keep it in the repo, not under `node_modules`.

## Reading the numbers

`runner.js` defines each metric. The ones to watch: `box+` (worst ink past the
box, glyphs and outline, px; above 0.5 is outside), `glyph+` (the same without
the outline), `in-bal` (share of the ink inside the balloon's white),
`size/ref` (size against the size in the case), `oval`/`rect` (line-width
profile against an oval and a rectangle, 1 is a match), `notch` (deepest dent
in the silhouette), `orph` and `hyph`.

## Limits

- The fixture fonts have no Hangul, kana or CJK, so the `cjk` cases draw
  `.notdef` boxes about half an em wide (see `../fonts/README.md`).
- Regular faces only; every case sets `bold: false`.
- Manual correction rate and time per bubble are not measured. They need people
  lettering real pages and cannot be computed offline.
