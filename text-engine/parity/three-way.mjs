// Where a capture breaks lines differently from the two browsers, and whether
// the browsers agree with each other there.
//
//   TP_DATA=<dir> node text-engine/parity/three-way.mjs <run> [--list <group>:<class>] [--chapters]
//
// Every covered layout case that has lines falls in one class:
//   all agree   the run, Chromium and WebKit chose the same lines
//   cr alone    the run agrees with WebKit; Chromium differs
//   wk alone    the run agrees with Chromium; WebKit differs
//   run alone   the browsers agree with each other and the run differs
//   all differ  three answers
// `--list plain.synthetic:wk alone` prints those cases (synthetic text only;
// chapter text is never printed). `--chapters` prints every real chapter box
// the run breaks differently from WebKit, without its text.
import { covered, dataDir, isChapter, readCorpus, readRun } from './runs.mjs'

const args = process.argv.slice(2)
const run = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--list')
if (!run) {
  console.error('usage: three-way.mjs <run> [--list <group>:<class>] [--chapters]')
  process.exit(2)
}
const list = args.includes('--list') ? args[args.indexOf('--list') + 1] : null
const data = dataDir()
const cases = readCorpus(data, 'layout').filter(covered)
const C = readRun(data, 'ref-cr', 'layout')
const W = readRun(data, 'ref-wk', 'layout')
const N = readRun(data, run, 'layout')
const same = (a, b) => a.length === b.length && a.every((l, i) => l === b[i])

const table = {}
const chapters = []
for (const c of cases) {
  if (c.solve) continue
  const s = c.box.style
  const group = `${c.mode === 'plain' || s.shape === 'off' ? 'plain' : 'smart'}.${isChapter(c) ? 'chapter' : 'synthetic'}`
  const a = C.get(c.id)
  const b = W.get(c.id)
  const n = N.get(c.id)
  if (!a?.lines || !b?.lines || !n?.lines) continue
  const nc = same(n.lines, a.lines)
  const nw = same(n.lines, b.lines)
  const cw = same(a.lines, b.lines)
  const cls = nc && nw ? 'all agree' : cw ? 'run alone' : nc ? 'wk alone' : nw ? 'cr alone' : 'all differ'
  const row = (table[group] ??= { 'all agree': 0, 'cr alone': 0, 'wk alone': 0, 'run alone': 0, 'all differ': 0 })
  row[cls]++
  const what = `${c.id}  ${s.font} ${s.size}px${s.bold ? ' bold' : ''}${s.italic ? ' italic' : ''}  box ${c.box.w}  lines cr/wk/run ${a.lines.length}/${b.lines.length}/${n.lines.length}`
  if (isChapter(c) && !nw) chapters.push(`${what}  ${cls}`)
  if (list === `${group}:${cls}`) {
    console.log(what)
    if (!isChapter(c)) for (const [name, r] of [['cr ', a], ['wk ', b], ['run', n]]) console.log(`    ${name} ${JSON.stringify(r.lines)}`)
  }
}
console.log(`# ${run} against ref-cr and ref-wk, covered layout cases with lines`)
console.table(table)
if (args.includes('--chapters')) {
  console.log(`real chapter boxes the run breaks differently from ref-wk: ${chapters.length}`)
  for (const line of chapters) console.log(`  ${line}`)
}
