// Shared by every parity script: the fixture fonts, the corpus, and loading
// the engine from the SAME wasm file the app would ship.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../js/engine.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(here, '../..')
export const fontDir = resolve(repoRoot, 'src/test/fonts')
export const wasmPath = resolve(here, '../js/generated', process.env.MT_TEXT_WASM ?? 'mt_text.wasm')

export const FONTS = [
  { key: 'ComicNeue', file: 'ComicNeue-Regular.ttf' },
  { key: 'Bangers', file: 'Bangers-Regular.ttf' },
  { key: 'DejaVuSans', file: 'DejaVuSans.ttf' },
  { key: 'DejaVuSans-Oblique', file: 'DejaVuSans-Oblique.ttf' },
].map((f) => ({ ...f, path: resolve(fontDir, f.file) }))

export const SIZES = [8, 12, 14.5, 16, 22, 22.5, 30, 40, 64, 96]

// kind: what the string is there to exercise. `fallback` strings hold code
// points none of the Latin fixtures cover (DejaVu covers a few of them).
export const STRINGS = [
  ['plain', 'hello'],
  ['plain', 'world'],
  ['plain', 'typesetter'],
  ['plain', 'manga'],
  ['plain', 'balloon'],
  ['caps', 'WHAT THE HELL ARE YOU DOING?!'],
  ['caps', 'I WON\'T LET YOU GET AWAY WITH THIS!'],
  ['caps', 'NO WAY...'],
  ['caps', 'YOUNG MASTER, PLEASE WAIT'],
  ['caps', 'AAAAAAH!!'],
  ['mixed', 'The quick brown fox'],
  ['mixed', 'Hello, World'],
  ['mixed', 'Mr. Tanaka said so.'],
  ['mixed', 'iPhone and eBay'],
  ['kern', 'AV'],
  ['kern', 'AVA'],
  ['kern', 'To'],
  ['kern', 'Ty'],
  ['kern', 'WA'],
  ['kern', 'LT'],
  ['kern', 'Yo'],
  ['kern', 'P.'],
  ['kern', 'r.'],
  ['kern', 'AVATAR WAVY TOY'],
  ['liga', 'fi'],
  ['liga', 'fl'],
  ['liga', 'ffi'],
  ['liga', 'ffl'],
  ['liga', 'office waffle'],
  ['punct', '...'],
  ['punct', '!?'],
  ['punct', '?!'],
  ['punct', '—'],
  ['punct', '“quoted”'],
  ['punct', '‘single’'],
  ['punct', '"straight" \'quotes\''],
  ['punct', 'wait…'],
  ['punct', '(parenthetical) [bracket]'],
  ['digits', '0123456789'],
  ['digits', '3.14159'],
  ['digits', '1,000,000'],
  ['hyphen', 'word-'],
  ['hyphen', 'well-known'],
  ['hyphen', 'inter-'],
  ['accent', 'ÉCLAT'],
  ['accent', 'naïve'],
  ['accent', 'Über'],
  ['accent', 'façade'],
  ['accent', 'é'],
  ['space', ' leading'],
  ['space', 'two  spaces'],
  ['space', 'trailing '],
  ['space', '  '],
  ['single', 'A'],
  ['single', 'g'],
  ['single', 'W'],
  ['single', 'i'],
  ['single', '.'],
  ['single', ' '],
  ['pangram', 'Sphinx of black quartz, judge my vow; the five boxing wizards jump quickly.'],
  ['nbsp', 'no break'],
  ['tab', 'tab\there'],
  ['fallback', '한글'],
  ['fallback', 'かな漢字'],
  ['fallback', 'ok 😀'],
].map(([kind, text]) => ({ kind, text }))

export const show = (s) => JSON.stringify(s)

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export async function loadEngine() {
  const engine = await createEngine(readFileSync(wasmPath))
  // The scripts that share this loader set the engine against Skia (the
  // spike's reference), so they ask for Skia's line box and not the browsers'.
  engine.setRule('fontBox', 'skia')
  const fonts = FONTS.map((f) => {
    const bytes = readFileSync(f.path)
    const id = engine.addFont(bytes)
    return { ...f, id, bytes, info: engine.fontInfo(id) }
  })
  return { engine, fonts }
}

/** count / max / p99 / mean of a list of absolute differences. */
export function stats(values) {
  if (values.length === 0) return { count: 0, max: 0, p99: 0, mean: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
  return {
    count: sorted.length,
    max: sorted[sorted.length - 1],
    p99: at(0.99),
    p50: at(0.5),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  }
}

export const fmt = (n, d = 4) => (Number.isFinite(n) ? n.toFixed(d) : String(n))
