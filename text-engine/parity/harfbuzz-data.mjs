// REF-HB on the fonts of a text-port data directory: the Rust shaper against
// real HarfBuzz (harfbuzzjs) for every pair of printable ASCII characters in
// every face, in font units.
//
//   TP_DATA=<dir> node text-engine/parity/harfbuzz-data.mjs
//
// harfbuzz.mjs asks the same of the four fixture fonts and must find nothing.
// This one is a survey: it prints, per face, how many pairs come out
// differently and a few of them, and exits 0 either way. Both shapers run with
// their defaults (the engine's raw run, not the measuring mode).
import { readFileSync } from 'node:fs'
import * as hb from 'harfbuzzjs'
import { createEngine } from '../js/engine.mjs'
import { wasmPath } from './common.mjs'
import { dataDir, readFonts } from './runs.mjs'

const data = dataDir()
const engine = await createEngine(readFileSync(wasmPath))
const ascii = []
for (let c = 0x20; c < 0x7f; c++) ascii.push(String.fromCharCode(c))

let faces = 0
let off = 0
let pairs = 0
let differing = 0
for (const f of readFonts(data)) {
  const bytes = readFileSync(`${data}/fonts/${f.file}`)
  const id = engine.addFont(bytes)
  const font = new hb.Font(new hb.Face(new hb.Blob(bytes), 0))
  const found = []
  for (const a of ascii) {
    for (const b of ascii) {
      const text = a + b
      const buffer = new hb.Buffer()
      buffer.addText(text)
      buffer.guessSegmentProperties()
      hb.shape(font, buffer)
      const infos = buffer.getGlyphInfos()
      const pos = buffer.getGlyphPositions()
      const run = engine.shapeUnits(id, text)
      let same = run.length === infos.length * 6
      for (let i = 0; same && i < infos.length; i++) {
        const o = i * 6
        same = run[o] === infos[i].codepoint && run[o + 1] === infos[i].cluster && run[o + 2] === pos[i].xAdvance && run[o + 3] === pos[i].yAdvance && run[o + 4] === pos[i].xOffset && run[o + 5] === pos[i].yOffset
      }
      pairs++
      if (!same) {
        const mine = []
        for (let i = 2; i < run.length; i += 6) mine.push(run[i])
        found.push(`${JSON.stringify(text)} advances HarfBuzz ${pos.map((p) => p.xAdvance).join('/')} engine ${mine.join('/')}`)
      }
      buffer.destroy?.()
    }
  }
  faces++
  engine.removeFont(id)
  if (!found.length) continue
  off++
  differing += found.length
  console.log(`${f.family} / ${f.slot}: ${found.length} of ${ascii.length ** 2} pairs differ`)
  for (const line of found.slice(0, 6)) console.log(`    ${line}`)
}
console.log(`${differing} of ${pairs} pairs differ, in ${off} of ${faces} faces`)
