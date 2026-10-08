// REF-HB: the Rust shaper against real HarfBuzz (harfbuzzjs), in font units.
//
//   node text-engine/parity/harfbuzz.mjs [--stress] [--json out.json]
//
// --stress adds every pair of printable ASCII characters (all kerning pairs
// the fonts can have there), every code point from U+00A0 to U+024F alone,
// and each of those after a base letter (mark and accent positioning).
//
// For every (font, string): glyph ids, clusters, advances and offsets must be
// EXACTLY equal. Sizes do not enter: both shapers work in font units and the
// engine scales afterwards. Exits 1 on any mismatch.
import { readFileSync, writeFileSync } from 'node:fs'
import * as hb from 'harfbuzzjs'
import { loadEngine, STRINGS, show, wasmPath, sha256File } from './common.mjs'

const { engine, fonts } = await loadEngine()

function hbShape(font, text) {
  const buffer = new hb.Buffer()
  buffer.addText(text)
  buffer.guessSegmentProperties()
  hb.shape(font, buffer)
  const infos = buffer.getGlyphInfos()
  const pos = buffer.getGlyphPositions()
  const out = new Int32Array(infos.length * 6)
  infos.forEach((g, i) => {
    out.set([g.codepoint, g.cluster, pos[i].xAdvance, pos[i].yAdvance, pos[i].xOffset, pos[i].yOffset], i * 6)
  })
  return out
}

const FIELDS = ['glyph', 'cluster', 'xAdvance', 'yAdvance', 'xOffset', 'yOffset']
const rows = (a) => {
  const r = []
  for (let i = 0; i < a.length; i += 6) r.push(Array.from(a.subarray(i, i + 6)))
  return r
}

const corpus = [...STRINGS]
if (process.argv.includes('--stress')) {
  const ascii = []
  for (let c = 0x20; c < 0x7f; c++) ascii.push(String.fromCharCode(c))
  for (const a of ascii) for (const b of ascii) corpus.push({ kind: 'pair', text: a + b })
  for (let c = 0xa0; c <= 0x24f; c++) {
    corpus.push({ kind: 'latin', text: String.fromCharCode(c) })
    corpus.push({ kind: 'latin', text: `o${String.fromCharCode(c)}n` })
  }
  for (let c = 0x300; c <= 0x36f; c++) corpus.push({ kind: 'combining', text: `a${String.fromCharCode(c)}e${String.fromCharCode(c)}` })
}

const mismatches = []
let cases = 0
let glyphs = 0
let worstAdvanceUnits = 0
const perFont = {}

for (const f of fonts) {
  const blob = new hb.Blob(f.bytes)
  const face = new hb.Face(blob, 0)
  const font = new hb.Font(face)
  let bad = 0
  for (const { kind, text } of corpus) {
    cases++
    const want = hbShape(font, text)
    const got = engine.shapeUnits(f.id, text)
    glyphs += want.length / 6
    const sum = (a) => rows(a).reduce((s, g) => s + g[2], 0)
    worstAdvanceUnits = Math.max(worstAdvanceUnits, Math.abs(sum(want) - sum(got)))
    let diff = null
    if (want.length !== got.length) diff = `glyph count ${got.length / 6} vs HarfBuzz ${want.length / 6}`
    else {
      for (let i = 0; i < want.length; i++) {
        if (want[i] !== got[i]) {
          diff = `glyph ${Math.floor(i / 6)} ${FIELDS[i % 6]}: ${got[i]} vs HarfBuzz ${want[i]}`
          break
        }
      }
    }
    if (diff) {
      bad++
      mismatches.push({ font: f.key, kind, text, diff, engine: rows(got), harfbuzz: rows(want) })
    }
  }
  perFont[f.key] = { strings: corpus.length, mismatches: bad }
}

const report = {
  harfbuzz: hb.versionString(),
  wasm: sha256File(wasmPath),
  fonts: Object.fromEntries(fonts.map((f) => [f.key, sha256File(f.path)])),
  cases,
  glyphs,
  worstAdvanceUnits,
  perFont,
  mismatches,
}

console.log(`REF-HB  HarfBuzz ${report.harfbuzz} (harfbuzzjs)  vs  mt-text wasm ${report.wasm.slice(0, 12)}`)
console.log(`cases ${cases} (4 fonts x ${corpus.length} strings), ${glyphs} glyphs compared on 6 fields each`)
for (const [k, v] of Object.entries(perFont)) console.log(`  ${k.padEnd(20)} mismatches ${v.mismatches}/${v.strings}`)
console.log(`worst total-advance difference: ${worstAdvanceUnits} font units`)
for (const m of mismatches.slice(0, 40)) {
  console.log(`MISMATCH ${m.font} [${m.kind}] ${show(m.text)}: ${m.diff}`)
  console.log(`   engine   ${JSON.stringify(m.engine)}`)
  console.log(`   harfbuzz ${JSON.stringify(m.harfbuzz)}`)
}
const jsonAt = process.argv.indexOf('--json')
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], `${JSON.stringify(report, null, 2)}\n`)
process.exit(mismatches.length ? 1 : 0)
