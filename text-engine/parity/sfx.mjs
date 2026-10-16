// The SFX layout through the JS loader: `engine.sfxInfo()` and
// `engine.sfxLayout()` against the wasm in js/generated/, and a laid-out word
// painted as a curved job (wire version 4: per-run scale and skew).
//
//   node text-engine/parity/sfx.mjs        # exits 1 on any failure
//
// The maths itself is checked, move by move, by `cargo test` (src/sfx/tests.rs);
// this checks what only the loader can get wrong: the kind numbers on the wire,
// the byte layout of the recipe, code points against UTF-16, and the records.
import { readFileSync } from 'node:fs'
import { createEngine } from '../js/engine.mjs'
import { encodeJob, paintJob, rasterHash } from '../js/paint.mjs'
import { FONTS, wasmPath } from './common.mjs'

let failed = 0
function check(ok, what) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
}
const throws = (f) => {
  try {
    f()
  } catch {
    return true
  }
  return false
}
const near = (a, b) => Math.abs(a - b) < 1e-9

const engine = await createEngine(readFileSync(wasmPath))
const font = engine.addFont(readFileSync(FONTS.find((f) => f.key === 'ComicNeue').path))
const face = engine.face(font, 24)
check(engine.hasSfx, 'the wasm has the sfx exports')

// The table.
const info = engine.sfxInfo()
check(engine.sfxInfo() === info, 'sfxInfo is cached')
check(info.kinds.length === 21 && info.presets.length === 15, `21 kinds and 15 presets (${info.kinds.length}, ${info.presets.length})`)
const ids = new Set(info.kinds.map((k) => k.kind))
check(info.presets.every((p) => (p.moves.length > 0 || p.envelope) && p.moves.every((m) => ids.has(m.kind))), 'every preset move names a kind')
check(
  info.kinds.every((k) => ['em', 'deg', 'x'].includes(k.unit) && k.min < k.max && k.step > 0),
  'every kind has a unit and a range',
)
const wave = info.kinds.find((k) => k.kind === 'wave')
check(wave.b?.label === 'Cycles' && wave.b.default === 1, 'wave has its Cycles number')
const cascade = info.presets.find((p) => p.id === 'cascade')
check(cascade.flow === 'stack' && cascade.lineHeight === 0.72 && !('look' in cascade), 'cascade is a tight stack, and names no colour')

// A layout: each code point measured like `advance`.
const rows = ['SPLRT', '', 'a\u{1F600}b']
const recipe = {
  lineHeight: 30,
  letterSpacing: 1.5,
  amount: 1,
  seed: 5,
  flow: 'row',
  rowShift: 0.25,
  moves: [
    { kind: 'wave', a: 0.3, b: 1 },
    { kind: 'nonesuch', a: 9 },
    { kind: 'mix', a: 0.4 },
    { kind: 'slant', a: -12 },
  ],
}
const out = engine.sfxLayout(face, rows, recipe)
const chars = rows.flatMap((r) => Array.from(r))
check(out.length === 8 && out.map((p) => p.ch).join('') === chars.join(''), `one record per code point (${out.length})`)
check(out.every((p) => near(p.w, engine.advance(face, p.ch))), 'w is the advance of that code point')
check(out.every((p) => [p.x, p.y, p.rot, p.sx, p.sy, p.skew].every(Number.isFinite)), 'every number is finite')
check(near(out.reduce((m, p) => Math.min(m, p.x - (p.w * p.sx) / 2), 1e9) + out.reduce((m, p) => Math.max(m, p.x + (p.w * p.sx) / 2), -1e9), 0), 'the block is centred on x = 0')
const again = engine.sfxLayout(face, rows, recipe)
check(JSON.stringify(again) === JSON.stringify(out), 'the same recipe and seed lay out the same')
check(JSON.stringify(engine.sfxLayout(face, rows, { ...recipe, seed: 6 })) !== JSON.stringify(out), 'another seed does not')
check(
  JSON.stringify(engine.sfxLayout(face, rows, { ...recipe, moves: recipe.moves.filter((m) => m.kind !== 'nonesuch') })) === JSON.stringify(out),
  'an unknown kind is skipped',
)
// A newline inside a row is a row break.
check(JSON.stringify(engine.sfxLayout(face, ['SPLRT\n\na\u{1F600}b'], recipe)) === JSON.stringify(out), 'a newline in a row starts another')
// Hand-checked numbers: step, three letters of equal width.
const flat = engine.sfxLayout(face, ['III'], { lineHeight: 24, moves: [{ kind: 'step', a: 1 }] })
check(near(flat[0].y - flat[1].y, 12) && near(flat[1].y - flat[2].y, 12) && near(flat[1].y, 0), 'step: dy = -A c size, 12 px apart at 24 px')
// Defaults: no letter spacing, amount 1, seed 1, row flow.
check(engine.sfxLayout(face, ['ab'], { lineHeight: 24 }).length === 2, 'the optional fields default')
const stack = engine.sfxLayout(face, ['ab', 'c'], { lineHeight: 24, flow: 'stack' })
check(stack.length === 3 && near(stack[1].y - stack[0].y, 24) && near(stack[2].y - stack[1].y, 24), 'stack flow: a row to a letter')
check(engine.sfxLayout(face, [], { lineHeight: 24 }).length === 0, 'no rows, no records')
check(engine.sfxLayout(face, [''], { lineHeight: 24 }).length === 0, 'no letters, no records')

// What it refuses.
check(throws(() => engine.sfxLayout(face, ['ab'], { ...recipe, lineHeight: NaN })), 'a NaN line height throws')
check(throws(() => engine.sfxLayout(face, ['ab'], { ...recipe, moves: [{ kind: 'step', a: Infinity }] })), 'an infinite move throws')
check(throws(() => engine.sfxLayout(face, ['ab'], { ...recipe, flow: 'column' })), 'an unknown flow throws')
check(throws(() => engine.sfxLayout({ ...face, font: 9999 }, ['ab'], recipe)), 'an unknown font throws')
check(engine.sfxLayout(face, ['ab'], recipe).length === 2 && engine.advance(face, 'ab') > 0, 'a refusal leaves the engine usable')

// Painting: wire version 4. A run with 1, 1, 0 is the run without them.
const word = engine.sfxLayout(face, ['SFX'], { lineHeight: 24, moves: [{ kind: 'grow', a: 1 }, { kind: 'domino', a: 30 }, { kind: 'tilt', a: 8 }] })
const job = (extra) => ({
  curved: true, align: 'center', letterSpacing: 0, bands: [{ color: '#ffffff', opacity: 1, line: 4 }], silhouette: null, fill: null,
  runs: word.map((p) => ({
    text: p.ch, x: 100 + p.x, y: 60 + p.y, rot: p.rot, ...extra(p),
    fill: { kind: 'solid', color: '#111111' },
  })),
})
const paint = (j) => paintJob(engine, { job: j, font, size: 24, synth: 0, transform: [2, 0, 0, 2, 0, 0] })
const plain = paint(job(() => ({})))
const unit = paint(job(() => ({ sx: 1, sy: 1, skew: 0 })))
check(plain && rasterHash(plain) === rasterHash(unit), 'a run of 1, 1, 0 paints as a run without them')
const laid = paint(job((p) => ({ sx: p.sx, sy: p.sy, skew: p.skew })))
check(laid && rasterHash(laid) !== rasterHash(plain), 'a laid-out word paints differently')
check(encodeJob({ job: job(() => ({})), font, size: 24, synth: 0 }).length > 0, 'encodeJob writes the new fields')
check(throws(() => paint(job(() => ({ sx: 0 })))), 'a run scale of 0 is refused')
check(throws(() => paint(job(() => ({ skew: 1.5 })))), 'a skew of 1.5 radians is refused')

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
