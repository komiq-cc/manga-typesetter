// Which arithmetic turns `hhea` into the line box both browsers report.
//
//   TP_DATA=<dir> node text-engine/parity/fontbox.mjs
//
// For every face and size of the metrics corpus, the ascent and the descent a
// browser captured (`ref-wk`; `ref-cr` holds the same numbers) are compared
// with three ways of scaling the table's value and rounding half up:
//   exact         units * size / unitsPerEm
//   16.16 down    floor(units * 65536 / unitsPerEm) / 65536 * size
//   16.16 near    round(units * 65536 / unitsPerEm) / 65536 * size
// counted apart for fonts with CFF outlines and with TrueType outlines. The
// engine's rule (src/metrics.rs) is `exact` for CFF and `16.16 near` for
// TrueType; this script is where that came from. The value scaled is |hhea
// ascender| and |hhea descender|, and -head.yMin where the descender is 0.
import { readFileSync } from 'node:fs'
import { matchSlot } from '../../src/lib/text-engine/rust.js'
import { covered, dataDir, readCorpus, readFonts, readRun } from './runs.mjs'

function tables(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = {}
  for (let i = 0; i < dv.getUint16(4); i++) {
    const o = 12 + i * 16
    at[String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])] = dv.getUint32(o + 8)
  }
  const descender = Math.abs(dv.getInt16(at.hhea + 6))
  return {
    cff: 'CFF ' in at || 'CFF2' in at,
    upem: dv.getUint16(at.head + 18),
    ascent: Math.abs(dv.getInt16(at.hhea + 4)),
    descent: descender || -dv.getInt16(at.head + 38),
  }
}

const data = dataDir()
const families = new Map()
for (const f of readFonts(data)) {
  const fam = families.get(f.family) ?? families.set(f.family, {}).get(f.family)
  fam[f.slot] = tables(readFileSync(`${data}/fonts/${f.file}`))
}
const rules = {
  exact: (u, size, upem) => Math.floor((u * size) / upem + 0.5),
  '16.16 down': (u, size, upem) => Math.floor((Math.floor((u * 65536) / upem) / 65536) * size + 0.5),
  '16.16 near': (u, size, upem) => Math.floor((Math.round((u * 65536) / upem) / 65536) * size + 0.5),
}
const want = readRun(data, 'ref-wk', 'metrics')
const other = readRun(data, 'ref-cr', 'metrics')
const seen = new Set()
const tally = {}
let browsersDiffer = 0
for (const c of readCorpus(data, 'metrics').filter(covered)) {
  const fam = families.get(c.font)
  const { slot } = matchSlot(Object.keys(fam), c.bold, c.italic)
  const key = `${c.font}|${slot}|${c.size}`
  if (seen.has(key)) continue
  seen.add(key)
  const t = fam[slot]
  const box = want.get(c.id).font
  const cr = other.get(c.id).font
  if (box.ascent !== cr.ascent || box.descent !== cr.descent) browsersDiffer++
  for (const [units, value, name] of [[t.ascent, box.ascent, 'ascent'], [t.descent, box.descent, 'descent']]) {
    for (const [rule, fn] of Object.entries(rules)) {
      const row = (tally[`${t.cff ? 'CFF     ' : 'TrueType'} ${rule}`] ??= { values: 0, misses: 0, fonts: new Set() })
      row.values++
      if (fn(units, c.size, t.upem) !== value) {
        row.misses++
        row.fonts.add(`${c.font}/${slot} ${name} ${units}/${t.upem} at ${c.size}`)
      }
    }
  }
}
console.log(`${seen.size} face and size pairs; the two browsers differ on ${browsersDiffer}`)
for (const [name, row] of Object.entries(tally)) {
  console.log(`${name.padEnd(22)} ${String(row.misses).padStart(5)} misses of ${row.values}`)
  for (const line of [...row.fonts].slice(0, 6)) console.log(`      ${line}`)
}
