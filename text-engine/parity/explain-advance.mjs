// Why the engine's advance differs from a browser's, font by font.
//
//   TP_DATA=<dir> node text-engine/parity/explain-advance.mjs
//
// The engine shapes a whole line in one run. For every covered case without a
// synthesised bold where that is more than 0.02 px from a reference, three
// other ways of measuring the same line are tried against that reference:
//   by word    each word and each space shaped by itself and summed: no
//              kerning, ligature or contextual form across a space
//              (Chromium's canvas keeps a cache of shaped words)
//   nbsp       a no-break space measured as the space glyph (WebKit)
//   rand on    the font's random alternates applied, per word (HarfBuzz's
//              default, which the engine switches off for measuring)
//   size .01   the font size cut to two decimals (Chromium's canvas does this
//              to the size in the `font` string)
// The table says how many of a font's differing cases each one explains.
// Chapter text is never printed.
import { readFileSync } from 'node:fs'
import { createRustTextEngine } from '../../src/lib/text-engine/rust.js'
import { wasmPath } from './common.mjs'
import { covered, dataDir, readCorpus, readFonts, readRun } from './runs.mjs'

const data = dataDir()
const engine = await createRustTextEngine(readFileSync(wasmPath))
const ids = new Map()
for (const f of readFonts(data)) {
  engine.addFace(f.family, f.slot, readFileSync(`${data}/fonts/${f.file}`))
}
const refs = { 'ref-cr': readRun(data, 'ref-cr', 'metrics'), 'ref-wk': readRun(data, 'ref-wk', 'metrics') }
const near = (a, b) => Math.abs(a - b) <= 0.02

// The raw run keeps HarfBuzz's defaults, `rand` included.
function rawByWord(face, words) {
  const h = engine.resolveFace(face)
  if (!h || h.fauxBold) return NaN
  let id = ids.get(`${face.name}|${h.slot}`)
  if (id === undefined) return NaN
  let units = 0
  for (const w of words) {
    const run = engine.low.shapeUnits(id, w)
    for (let i = 2; i < run.length; i += 6) units += run[i]
  }
  return (units * face.size) / engine.low.fontInfo(id).unitsPerEm
}
// Font ids of the low-level engine, by family and slot, for the raw runs.
for (const f of readFonts(data)) ids.set(`${f.family}|${f.slot}`, engine.low.addFont(readFileSync(`${data}/fonts/${f.file}`)))

const rows = new Map()
for (const c of readCorpus(data, 'metrics').filter(covered)) {
  if ((c.tags ?? []).includes('faux-bold')) continue
  const face = { key: `${c.font}|${c.bold}|${c.italic}|${c.size}`, name: c.font, bold: c.bold, italic: c.italic, size: c.size }
  // What the capture measured: `lineWidth`, which drops trailing whitespace.
  const text = c.text.replace(/\s+$/, '').replace(/[\t\n\f\r]/g, ' ')
  const whole = engine.advance(face, text)
  const words = text.split(/( )/).filter(Boolean)
  const alt = {
    'by word': words.reduce((sum, w) => sum + engine.advance(face, w), 0),
    nbsp: engine.advance(face, text.replace(/ /g, ' ')),
    'rand on': rawByWord(face, words),
    'size .01': engine.advance({ ...face, size: Math.floor(c.size * 100) / 100, key: `${face.key}|cut` }, text),
  }
  for (const [ref, run] of Object.entries(refs)) {
    const want = run.get(c.id)?.adv
    if (want === undefined) continue
    const row = rows.get(c.font) ?? rows.set(c.font, {}).get(c.font)
    const r = (row[ref] ??= { n: 0, differ: 0, 'by word': 0, nbsp: 0, 'rand on': 0, 'size .01': 0, none: 0, worst: 0 })
    r.n++
    if (near(whole, want)) continue
    r.differ++
    r.worst = Math.max(r.worst, Math.abs(whole - want))
    let explained = false
    for (const [name, v] of Object.entries(alt)) {
      if (near(v, want)) {
        r[name]++
        explained = true
      }
    }
    if (!explained) r.none++
  }
}

for (const ref of Object.keys(refs)) {
  console.log(`# whole-line advance against ${ref}: fonts with a differing case (no synthesised bold)`)
  console.log('font                          cases  differ  by word    nbsp  rand on  size .01  unexplained  worst px')
  const list = [...rows].filter(([, r]) => r[ref]?.differ).sort((a, b) => b[1][ref].differ - a[1][ref].differ)
  for (const [font, row] of list) {
    const r = row[ref]
    console.log(`${font.padEnd(28)} ${String(r.n).padStart(6)} ${String(r.differ).padStart(7)} ${String(r['by word']).padStart(8)} ${String(r.nbsp).padStart(7)} ${String(r['rand on']).padStart(8)} ${String(r['size .01']).padStart(9)} ${String(r.none).padStart(12)} ${r.worst.toFixed(3).padStart(9)}`)
  }
  console.log(`${list.length} of ${rows.size} fonts`)
}
