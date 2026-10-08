// How far two text-port captures are from each other, quantity by quantity.
//
//   TP_DATA=<dir> node text-engine/parity/distance.mjs <runA> <runB> [--json]
//
// A run is `ref-sk`, `ref-cr`, `ref-wk` (their `base` capture) or
// `<engine>/<runId>`. Cases tagged `uncovered` (a letter the face has no
// glyph for, so the host's fallback font is what was measured) are left out
// of every figure. Chapter text is never printed.
import { covered, dataDir, fmt, isChapter, pct, readCorpus, readRun, share, stats } from './runs.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const [runA, runB] = args.filter((a) => !a.startsWith('--'))
if (!runA || !runB) {
  console.error('usage: distance.mjs <runA> <runB> [--json]')
  process.exit(2)
}
const data = dataDir()

const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l === b[i])
const plainCase = (c) => c.mode === 'plain' || (c.box ?? c.solve).style.shape === 'off'

export function distance(data, runA, runB) {
  const out = { runA, runB }

  // ---- numbers ----
  const cases = readCorpus(data, 'metrics').filter(covered)
  const A = readRun(data, runA, 'metrics')
  const B = readRun(data, runB, 'metrics')
  const d = { adv: [], advChapter: [], ascent: [], descent: [], inkLeft: [], inkRight: [], inkAscent: [], inkDescent: [], glyphLeft: [], glyphRight: [], glyphAscent: [], glyphDescent: [] }
  let inkNullMismatch = 0
  for (const c of cases) {
    const a = A.get(c.id)
    const b = B.get(c.id)
    if (!a || !b || a.skip || b.skip || a.error || b.error) continue
    const dv = Math.abs(a.adv - b.adv)
    d.adv.push(dv)
    if (isChapter(c)) d.advChapter.push(dv)
    d.ascent.push(Math.abs(a.font.ascent - b.font.ascent))
    d.descent.push(Math.abs(a.font.descent - b.font.descent))
    if (!a.ink !== !b.ink) inkNullMismatch++
    if (a.ink && b.ink) {
      d.inkLeft.push(Math.abs(a.ink.left - b.ink.left))
      d.inkRight.push(Math.abs(a.ink.right - b.ink.right))
      d.inkAscent.push(Math.abs(a.ink.ascent - b.ink.ascent))
      d.inkDescent.push(Math.abs(a.ink.descent - b.ink.descent))
    }
    for (const [ch, ga] of Object.entries(a.glyphs ?? {})) {
      const gb = b.glyphs?.[ch]
      if (!ga || !gb) continue
      d.glyphLeft.push(Math.abs(ga.left - gb.left))
      d.glyphRight.push(Math.abs(ga.right - gb.right))
      d.glyphAscent.push(Math.abs(ga.ascent - gb.ascent))
      d.glyphDescent.push(Math.abs(ga.descent - gb.descent))
    }
  }
  out.metrics = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...stats(v), within002: share(v, (x) => x <= 0.02), within05: share(v, (x) => x <= 0.5) }]))
  out.inkNullMismatch = inkNullMismatch

  // ---- decisions ----
  const lc = readCorpus(data, 'layout').filter(covered)
  const LA = readRun(data, runA, 'layout')
  const LB = readRun(data, runB, 'layout')
  const groups = {}
  const group = (name) => (groups[name] ??= { cases: 0, compared: 0, sameLines: 0, verdictChanged: 0, baseY: [], blockY: [] })
  const solve = { cases: 0, compared: 0, changed: 0, sizeChanged: 0, linesChanged: 0 }
  const curve = { cases: 0, compared: 0, x: [], y: [] }
  const differing = []
  for (const c of lc) {
    const a = LA.get(c.id)
    const b = LB.get(c.id)
    if (c.solve) {
      solve.cases++
      if (!a?.solve || !b?.solve) continue
      solve.compared++
      const s = a.solve.size !== b.solve.size
      const l = !sameLines(a.solve.lines ?? [], b.solve.lines ?? [])
      if (s) solve.sizeChanged++
      if (l) solve.linesChanged++
      if (s || l || a.solve.status !== b.solve.status) solve.changed++
      continue
    }
    const names = [plainCase(c) ? 'plain' : 'smart', `${plainCase(c) ? 'plain' : 'smart'}.${isChapter(c) ? 'chapter' : 'synthetic'}`, isChapter(c) ? 'chapter' : 'synthetic']
    for (const n of names) group(n).cases++
    if (!a || !b || a.skip || b.skip || a.error || b.error) continue
    if (a.curve || b.curve) {
      curve.cases++
      if (a.curve && b.curve && a.curve.length === b.curve.length) {
        curve.compared++
        a.curve.forEach((g, i) => {
          curve.x.push(Math.abs(g.x - b.curve[i].x))
          curve.y.push(Math.abs(g.y - b.curve[i].y))
        })
      }
    }
    for (const n of names) {
      const g = group(n)
      g.compared++
      if (a.lines && b.lines) {
        if (sameLines(a.lines, b.lines)) {
          g.sameLines++
          g.baseY.push(Math.abs(a.baseY - b.baseY))
          g.blockY.push(Math.abs(a.blockY - b.blockY))
        } else if (n === names[0]) differing.push(c.id)
      } else if (!a.lines && !b.lines) g.sameLines++
      if (!!a.verdict?.fits !== !!b.verdict?.fits) g.verdictChanged++
    }
  }
  out.layout = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, {
    cases: g.cases, compared: g.compared, sameLines: g.sameLines, differentLines: g.compared - g.sameLines,
    sameLinesShare: g.compared ? g.sameLines / g.compared : NaN, verdictChanged: g.verdictChanged,
    baseY: stats(g.baseY), baseYOver1: g.baseY.filter((x) => x > 1).length, blockY: stats(g.blockY),
  }]))
  out.solve = solve
  out.curve = { cases: curve.cases, compared: curve.compared, x: stats(curve.x), y: stats(curve.y) }
  out.differing = differing
  return out
}

function print(o) {
  console.log(`# ${o.runA} against ${o.runB}, covered cases`)
  console.log('quantity        n        p50      p99      max      <=0.02px  <=0.5px')
  for (const [k, s] of Object.entries(o.metrics)) {
    console.log(`${k.padEnd(14)} ${String(s.n).padStart(7)} ${fmt(s.p50).padStart(8)} ${fmt(s.p99).padStart(8)} ${fmt(s.max).padStart(8)}  ${pct(s.within002).padStart(8)} ${pct(s.within05).padStart(8)}`)
  }
  console.log(`ink present in one run only: ${o.inkNullMismatch}`)
  console.log('layout group        cases  same lines  different  share     verdict changed  baseY p50/p99/max (same lines)  baseY > 1px')
  for (const [k, g] of Object.entries(o.layout)) {
    console.log(`${k.padEnd(18)} ${String(g.compared).padStart(6)} ${String(g.sameLines).padStart(11)} ${String(g.differentLines).padStart(10)}  ${pct(g.sameLinesShare).padStart(7)} ${String(g.verdictChanged).padStart(16)}  ${fmt(g.baseY.p50)}/${fmt(g.baseY.p99)}/${fmt(g.baseY.max)}  ${g.baseYOver1}`)
  }
  console.log(`solver: ${o.solve.compared} answers, ${o.solve.changed} changed (size ${o.solve.sizeChanged}, lines ${o.solve.linesChanged})`)
  console.log(`curved: ${o.curve.compared} of ${o.curve.cases} with the same glyph count; glyph x p50/p99/max ${fmt(o.curve.x.p50)}/${fmt(o.curve.x.p99)}/${fmt(o.curve.x.max)}, y ${fmt(o.curve.y.p50)}/${fmt(o.curve.y.p99)}/${fmt(o.curve.y.max)}`)
}

const o = distance(data, runA, runB)
if (json) console.log(JSON.stringify(o))
else print(o)
