// Reads text-port captures (scripts/text-port/README.md) for the comparison
// scripts beside this file. Nothing here writes, and nothing prints case text.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const dataDir = () => resolve(process.env.TP_DATA ?? 'node_modules/.cache/text-port')

/** `ref-wk` means `ref-wk/base`; `new/a0` is taken as written. */
export const runDir = (data, run) => resolve(data, 'runs', run.includes('/') ? run : `${run}/base`)

export function readCorpus(data, kind) {
  return JSON.parse(readFileSync(resolve(data, `corpus/${kind}.json`), 'utf8')).cases
}

/** id -> record; an empty map for a kind a partial run (`--only`) did not capture */
export function readRun(data, run, kind) {
  const out = new Map()
  const file = resolve(runDir(data, run), `${kind}.jsonl`)
  if (!existsSync(file)) {
    if (!existsSync(runDir(data, run))) throw new Error(`No such run: ${runDir(data, run)}`)
    return out
  }
  const text = readFileSync(file, 'utf8')
  let at = 0
  while (at < text.length) {
    let end = text.indexOf('\n', at)
    if (end < 0) end = text.length
    if (end > at) {
      const r = JSON.parse(text.slice(at, end))
      out.set(r.id, r)
    }
    at = end + 1
  }
  return out
}

export function readFonts(data) {
  return JSON.parse(readFileSync(resolve(data, 'fonts/fonts.json'), 'utf8')).fonts
}

export const covered = (c) => !(c.tags ?? []).includes('uncovered')
export const isChapter = (c) => c.id.startsWith('c.')

export function stats(values) {
  const v = Float64Array.from(values).sort()
  const q = (p) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN)
  return { n: v.length, p50: q(0.5), p99: q(0.99), max: v.length ? v[v.length - 1] : NaN }
}
export const share = (values, pred) => {
  let n = 0
  let hit = 0
  for (const x of values) {
    n++
    if (pred(x)) hit++
  }
  return n ? hit / n : NaN
}
export const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : String(x))
export const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(2)}%` : String(x))
