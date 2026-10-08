// Lines of a capture's plain-mode cases that are wider than the box they were
// broken for, by the engine's own measure of the line as it will be drawn.
//
//   TP_DATA=<dir> node text-engine/parity/overflow.mjs <run>
//
// A breaker that keeps its promise has none. The browsers have a few: they
// test widths taken from inside the paragraph (kerning and ligatures across a
// break still counted, or words measured one at a time), not the line itself.
// One-letter lines are left out: a letter wider than the box has to go
// somewhere.
import { readFileSync } from 'node:fs'
import { createRustTextEngine } from '../../src/lib/text-engine/rust.js'
import { wasmPath } from './common.mjs'
import { covered, dataDir, fmt, isChapter, readCorpus, readFonts, readRun } from './runs.mjs'

const run = process.argv[2]
if (!run) {
  console.error('usage: overflow.mjs <run>')
  process.exit(2)
}
const data = dataDir()
// `contentWidth` of src/lib/measure.js, which cannot be imported outside the
// app's bundler: the box less its padding and its outline, on both sides.
const contentWidth = (w, style) => Math.max(1, w - 2 * (2 + Math.ceil((style.strokes ?? []).reduce((sum, k) => sum + Math.max(0, Number(k?.width) || 0), 0))))
const engine = await createRustTextEngine(readFileSync(wasmPath))
for (const f of readFonts(data)) engine.addFace(f.family, f.slot, readFileSync(`${data}/fonts/${f.file}`))
const records = readRun(data, run, 'layout')

const byFont = new Map()
const over = []
let lines = 0
for (const c of readCorpus(data, 'layout').filter(covered)) {
  if (c.solve || !(c.mode === 'plain' || c.box.style.shape === 'off')) continue
  const r = records.get(c.id)
  if (!r?.lines) continue
  const s = c.box.style
  const avail = contentWidth(c.box.w, s)
  const face = { key: `${s.font}|${s.bold}|${s.italic}|${s.size}`, name: s.font, bold: s.bold, italic: s.italic, size: s.size }
  for (const line of r.lines) {
    const letters = [...line].length
    if (letters < 2) continue
    lines++
    const excess = engine.advance(face, line) + letters * (Number(s.letterSpacing) || 0) - avail
    if (excess <= 0.02) continue
    over.push(excess)
    const row = byFont.get(s.font) ?? byFont.set(s.font, { n: 0, max: 0, at: '' }).get(s.font)
    row.n++
    if (excess > row.max) {
      row.max = excess
      row.at = `${c.id} at ${s.size}px in ${fmt(avail, 1)}px${isChapter(c) ? '' : ` ${JSON.stringify(line)}`}`
    }
  }
}
over.sort((a, b) => a - b)
console.log(`# ${run}: ${over.length} of ${lines} plain-mode lines of two letters or more are wider than their box`)
if (over.length) console.log(`excess p50 ${fmt(over[over.length >> 1])} px, max ${fmt(over.at(-1))} px`)
for (const [font, r] of [...byFont].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) console.log(`  ${font.padEnd(28)} ${String(r.n).padStart(4)}  worst ${fmt(r.max)} px  ${r.at}`)
