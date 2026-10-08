// Cost of the engine as JS sees it: time per call across the wasm boundary
// (UTF-8 transfer included), time to add a font, memory per font, and whether
// two processes produce the same numbers.
//
//   node text-engine/parity/bench.mjs            full report
//   node text-engine/parity/bench.mjs --hash     print only the output hash
//
// Timings are wall clock on whatever machine runs this; SPIKE.md says which.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import * as hb from 'harfbuzzjs'
import { createEngine } from '../js/engine.mjs'
import { loadEngine, FONTS, STRINGS, SIZES, wasmPath, sha256File, fmt } from './common.mjs'

/** Every number the engine returns for the corpus, hashed. */
function outputHash(engine, fonts) {
  const h = createHash('sha256')
  const f64 = new Float64Array(1)
  const put = (...values) => {
    for (const v of values) {
      f64[0] = v
      h.update(new Uint8Array(f64.buffer))
    }
  }
  for (const f of fonts) {
    for (const size of SIZES) {
      for (const flags of [{}, { bold: true }, { italic: true }]) {
        const face = engine.face(f.id, size, flags)
        const box = engine.fontBox(face)
        put(box.ascent, box.descent)
        for (const { text } of STRINGS) {
          const ink = engine.lineInk(face, text)
          const g = engine.glyphInk(face, text)
          put(engine.advance(face, text), ink.width, ink.left, ink.right, ink.ascent, ink.descent)
          put(g.left, g.right, g.ascent, g.descent)
        }
      }
    }
    for (const { text } of STRINGS) {
      h.update(new Uint8Array(engine.shapeUnits(f.id, text).buffer))
      for (const [a, b] of engine.wrapPlain(engine.face(f.id, 16), text, { width: 90 })) put(a, b)
    }
  }
  return h.digest('hex')
}

if (process.argv.includes('--hash')) {
  const { engine, fonts } = await loadEngine()
  process.stdout.write(outputHash(engine, fonts))
  process.exit(0)
}

// Distinct ~20-character lines of comic dialogue, so no call repeats a string
// (the engine has no string cache, and this keeps any future one honest).
const WORDS = 'WHAT THE HELL ARE YOU DOING NO WAY I WONT LET GET AWAY WITH THIS YOUNG MASTER PLEASE WAIT office waffle Tokyo Avatar quickly judge vow fix flame Typo AVA WAVE To Ty'.split(' ')
function makeLines(count, seed = 1) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const lines = new Set()
  while (lines.size < count) {
    let line = ''
    while (line.length < 17) line += (line ? ' ' : '') + WORDS[Math.floor(rnd() * WORDS.length)]
    lines.add(`${line.slice(0, 18)}${lines.size % 97}`.slice(0, 22))
  }
  return [...lines]
}

const now = () => Number(process.hrtime.bigint())
/** Median ns per call of `fn(line)` over `rounds` passes of `lines`. */
function perCall(lines, fn, rounds = 7) {
  for (const l of lines) fn(l) // warm the JIT
  const samples = []
  for (let r = 0; r < rounds; r++) {
    const t0 = now()
    for (let i = 0; i < lines.length; i++) fn(lines[i])
    samples.push((now() - t0) / lines.length)
  }
  samples.sort((a, b) => a - b)
  return samples[samples.length >> 1]
}

const { engine, fonts } = await loadEngine()
const lines = makeLines(20000)
const meanLen = lines.reduce((a, l) => a + l.length, 0) / lines.length

console.log(`wasm ${wasmPath.split('/').slice(-3).join('/')}  ${statSync(wasmPath).size} bytes  sha256 ${sha256File(wasmPath).slice(0, 16)}`)
console.log(`node ${process.version} ${process.platform}-${process.arch}; ${lines.length} distinct lines, mean ${meanLen.toFixed(1)} chars\n`)

console.log('ns per call from JS, text transfer included (median of 7 passes)')
console.log('font'.padEnd(20) + ['advance', 'lineInk', 'glyphInk', 'shapeUnits', 'shapeLine', 'fontBox'].map((h) => h.padStart(12)).join(''))
const advanceNs = {}
for (const f of fonts) {
  const face = engine.face(f.id, 22.5)
  const row = [
    perCall(lines, (l) => engine.advance(face, l)),
    perCall(lines, (l) => engine.lineInk(face, l)),
    perCall(lines, (l) => engine.glyphInk(face, l[0])),
    perCall(lines, (l) => engine.shapeUnits(f.id, l)),
    perCall(lines, (l) => engine.shapeLine(face, l)),
    perCall(lines, () => engine.fontBox(face)),
  ]
  advanceNs[f.key] = row[0]
  console.log(f.key.padEnd(20) + row.map((v) => v.toFixed(0).padStart(12)).join(''))
}

// Where an advance call's time goes.
{
  const f = fonts[0]
  const face = engine.face(f.id, 22.5)
  const transfer = perCall(lines, (l) => engine.putText(l))
  const n = engine.putText(lines[0])
  const bare = perCall(lines, () => engine.exports.mt_advance(f.id, 22.5, n))
  const one = perCall(lines, () => engine.advance(face, 'A'))
  const accented = lines.map((l) => l.replace('A', 'É').replace('O', 'Ö') + '…')
  const utf8 = perCall(accented, (l) => engine.advance(face, l))
  const long = lines.map((l) => `${l} ${l} ${l} ${l}`)
  const longNs = perCall(long.slice(0, 5000), (l) => engine.advance(face, l))
  console.log(`\n${f.key}: text transfer alone ${transfer.toFixed(0)} ns; mt_advance on text already in memory ${bare.toFixed(0)} ns; one-character advance ${one.toFixed(0)} ns`)
  console.log(`  non-ASCII lines (TextEncoder path) ${utf8.toFixed(0)} ns; ${long[0].length}-char lines ${longNs.toFixed(0)} ns`)
}

// References on the same lines: today's test-lane measurer, and real HarfBuzz.
{
  const f = fonts[0]
  GlobalFonts.registerFromPath(f.path, 'MTBench')
  const ctx = createCanvas(8, 8).getContext('2d')
  ctx.font = '22.5px "MTBench"'
  const skia = perCall(lines, (l) => ctx.measureText(l).width, 3)
  const font = new hb.Font(new hb.Face(new hb.Blob(f.bytes), 0))
  const hbNs = perCall(lines.slice(0, 5000), (l) => {
    const b = new hb.Buffer()
    b.addText(l)
    b.guessSegmentProperties()
    hb.shape(font, b)
    b.destroy?.()
  }, 3)
  console.log(`  for scale, same lines: Skia measureText().width ${skia.toFixed(0)} ns; harfbuzzjs shape (new buffer each call) ${hbNs.toFixed(0)} ns`)
}

// The budget: a layout solve makes a few hundred uncached advance calls and
// has 8 ms at p95 for everything.
{
  console.log('\nbatches of N uncached advance calls, ms (1000 batches each; every line used once per pass)')
  for (const f of [fonts[0], fonts[2]]) {
    const face = engine.face(f.id, 22.5)
    for (const batch of [300, 1000]) {
      const times = []
      let at = 0
      for (let b = 0; b < 1000; b++) {
        const t0 = now()
        for (let i = 0; i < batch; i++) engine.advance(face, lines[(at + i) % lines.length])
        times.push((now() - t0) / 1e6)
        at += batch
      }
      times.sort((a, b) => a - b)
      console.log(`  ${f.key.padEnd(12)} N=${String(batch).padStart(4)}  p50 ${fmt(times[500], 3)}  p95 ${fmt(times[950], 3)}  p99 ${fmt(times[990], 3)}  max ${fmt(times[999], 3)}`)
    }
  }
}

// Fonts: time to add, first-use cost, and memory.
{
  console.log('\nfonts (fresh engine instance per font)')
  console.log('font'.padEnd(20) + ['file bytes', 'add ms', '1st advance ms', 'heap after add', 'after corpus', 'overhead', 'linear memory'].map((h) => h.padStart(16)).join(''))
  const wasm = readFileSync(wasmPath)
  for (const f of FONTS) {
    const bytes = readFileSync(f.path)
    const fresh = await createEngine(wasm)
    const heap0 = fresh.heapLive()
    const t0 = now()
    const id = fresh.addFont(bytes)
    const addMs = (now() - t0) / 1e6
    const heapAdd = fresh.heapLive() - heap0
    const face = fresh.face(id, 22.5)
    const t1 = now()
    fresh.advance(face, 'WHAT THE HELL?!')
    const firstMs = (now() - t1) / 1e6
    for (const { text } of STRINGS) {
      fresh.lineInk(face, text)
      fresh.glyphInk(face, text)
    }
    for (const l of lines.slice(0, 2000)) fresh.lineInk(face, l)
    const heapUsed = fresh.heapLive() - heap0
    // Steady-state add time, without the first call's page faults.
    const adds = []
    for (let i = 0; i < 15; i++) {
      const t = now()
      const again = fresh.addFont(bytes)
      adds.push((now() - t) / 1e6)
      fresh.removeFont(again)
    }
    adds.sort((a, b) => a - b)
    console.log(
      f.key.padEnd(20) +
        [
          bytes.length,
          `${fmt(addMs, 3)} / ${fmt(adds[7], 3)}`,
          fmt(firstMs, 3),
          heapAdd,
          heapUsed,
          `${heapUsed - bytes.length}`,
          fresh.memoryBytes(),
        ]
          .map((v) => String(v).padStart(16))
          .join(''),
    )
  }
  console.log('  add ms = first add / median of 15 more; overhead = heap after the corpus minus the file size')
  const empty = await createEngine(wasm)
  console.log(`  empty instance: linear memory ${empty.memoryBytes()} bytes, live heap ${empty.heapLive()} bytes`)
  const t0 = now()
  await createEngine(wasm)
  const t1 = now()
  const module = await WebAssembly.compile(wasm)
  const t2 = now()
  await createEngine(module)
  console.log(`  compile + instantiate from bytes ${fmt((t1 - t0) / 1e6, 2)} ms; compile alone ${fmt((t2 - t1) / 1e6, 2)} ms; instantiate a compiled module ${fmt((now() - t2) / 1e6, 3)} ms`)
}

// Determinism: the same wasm in two separate processes.
{
  const self = fileURLToPath(import.meta.url)
  const run = () => spawnSync(process.execPath, [self, '--hash'], { encoding: 'utf8', env: process.env }).stdout
  const [a, b] = [run(), run()]
  const here = outputHash(engine, fonts)
  console.log(`\ndeterminism: output hash over the corpus (advance, ink, glyph ink, font box, shaped runs, wraps; 3 styles)`)
  console.log(`  process 1 ${a}\n  process 2 ${b}\n  this one  ${here}  (after ${lines.length * 30}+ other calls)`)
  console.log(`  ${a === b && a === here && a.length === 64 ? 'IDENTICAL' : 'DIFFERENT'}`)
  if (!(a === b && a === here)) process.exitCode = 1
}
