// Advance distance between two captures, split by what each case exercises
// (the corpus tags) and by font, and the fonts whose line box differs.
//
//   TP_DATA=<dir> node text-engine/parity/by-tag.mjs <runA> <runB> [--fonts]
//
// Covered cases only. `--fonts` adds the per-font table, worst first.
import { covered, dataDir, fmt, pct, readCorpus, readRun, share, stats } from './runs.mjs'

const args = process.argv.slice(2)
const [runA, runB] = args.filter((a) => !a.startsWith('--'))
if (!runA || !runB) {
  console.error('usage: by-tag.mjs <runA> <runB> [--fonts]')
  process.exit(2)
}
const data = dataDir()
const cases = readCorpus(data, 'metrics').filter(covered)
const A = readRun(data, runA, 'metrics')
const B = readRun(data, runB, 'metrics')

const byTag = new Map()
const byFont = new Map()
const box = new Map()
const push = (map, key, v) => (map.get(key) ?? map.set(key, []).get(key)).push(v)
for (const c of cases) {
  const a = A.get(c.id)
  const b = B.get(c.id)
  if (!a || !b || a.skip || b.skip || a.error || b.error) continue
  const d = Math.abs(a.adv - b.adv)
  push(byTag, '(all)', d)
  for (const t of c.tags ?? []) push(byTag, t, d)
  // A case without either tag is what the font does with no help from anyone.
  if (!(c.tags ?? []).some((t) => t === 'faux-bold' || t === 'tab' || t === 'nbsp')) push(byTag, '(no faux-bold, tab, nbsp)', d)
  push(byFont, c.font, d)
  const fb = Math.max(Math.abs(a.font.ascent - b.font.ascent), Math.abs(a.font.descent - b.font.descent))
  box.set(c.font, Math.max(box.get(c.font) ?? 0, fb))
}

function table(title, map, limit = Infinity) {
  console.log(title.padEnd(28) + '       n      p50      p99      max  <=0.02px')
  const rows = [...map].map(([k, v]) => [k, stats(v), share(v, (x) => x <= 0.02)]).sort((x, y) => x[2] - y[2])
  for (const [k, s, w] of rows.slice(0, limit)) {
    console.log(`${k.padEnd(28)} ${String(s.n).padStart(7)} ${fmt(s.p50).padStart(8)} ${fmt(s.p99).padStart(8)} ${fmt(s.max).padStart(8)} ${pct(w).padStart(9)}`)
  }
}

console.log(`# advance, ${runA} against ${runB}, covered cases`)
table('tag', byTag)
if (args.includes('--fonts')) table('font', byFont, 30)
const off = [...box].filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])
console.log(`line box: ${box.size - off.length} of ${box.size} fonts identical at every size`)
for (const [font, v] of off) console.log(`  ${font.padEnd(28)} up to ${fmt(v)} px`)
