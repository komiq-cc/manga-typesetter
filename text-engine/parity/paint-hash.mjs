// The painter's bytes are the same wherever it runs: a hash of the rasters of
// a fixed set of jobs, across two processes and across every build of the
// wasm found in js/generated/.
//
//   node text-engine/parity/paint-hash.mjs            # the table, exits 1 on any difference
//   node text-engine/parity/paint-hash.mjs --hash     # one line: this wasm's hash (MT_TEXT_WASM picks the file)
//   node text-engine/parity/paint-hash.mjs --dump F   # also write the encoded jobs to F, for the native build:
//   cargo run --release --example paint_hash -- F     #   (from text-engine/) prints the same per-job hashes
//
// The builds compared are the ones of SPIKE.md section 3 that are present:
//
//   mt_text.wasm        npm run build:engine
//   oz.wasm             MT_TEXT_OPT_LEVEL=z MT_TEXT_OUT=oz.wasm npm run build:engine
//   mt_text.simd.wasm   MT_TEXT_FEATURES=simd MT_TEXT_RUSTFLAGS="-C target-feature=+simd128" MT_TEXT_OUT=mt_text.simd.wasm npm run build:engine
//   wasmopt.wasm        MT_TEXT_WASM_OPT=/path/to/wasm-opt MT_TEXT_OUT=wasmopt.wasm npm run build:engine
//   mt_text.compare.wasm  the rasteriser comparison build, with the exact rasteriser selected
//
// The jobs are built by hand, in plain node, from numbers that are exact in
// binary or are written out as decimals here: no job goes through a host
// `Math` function on its way to the engine, so the hash tests the engine and
// not the host. Every feature of a job is in at least one of them.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../js/engine.mjs'
import { paintJob, encodeJob } from '../js/paint.mjs'
import { FONTS, wasmPath } from './common.mjs'

const self = fileURLToPath(import.meta.url)
const genDir = resolve(dirname(self), '../js/generated')

// A tile made with integer arithmetic only.
const TILE = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) }
for (let y = 0; y < 8; y++) {
  for (let x = 0; x < 8; x++) {
    const on = ((x >> 1) + (y >> 2)) & 1
    TILE.data.set(on ? [29, 53, 87, 255] : [255, 209, 102, (x * 37 + y * 11) & 255], (y * 8 + x) * 4)
  }
}
const STOPS = [
  { pos: 0, color: '#ffd166' },
  { pos: 0.35, color: 'rgba(239,71,111,0.6)' },
  { pos: 1, color: '#073b4c' },
]
const face = (size) => ({ size })
const straight = (over) => ({
  curved: false, align: 'center', letterSpacing: 0, bands: [], silhouette: null,
  fill: { kind: 'solid', color: '#111111' },
  runs: [
    { text: 'WHAT THE HELL', x: 160.3, y: 50.7 },
    { text: 'ARE YOU DOING?!', x: 160.3, y: 81.5 },
    { text: 'office waffle Ty.', x: 160.3, y: 112.3 },
  ],
  ...over,
})
// Angles as written-out radians; the engine takes the sine and cosine.
const curved = (over) => ({
  curved: true, align: 'center', letterSpacing: 0, bands: [{ color: '#ffffff', opacity: 1, line: 4 }], silhouette: null, fill: null,
  runs: [...'CURVE'].map((text, i) => ({
    text, x: 60.25 + i * 31.5, y: 90.125 - [0, 14.5, 19.75, 14.5, 0][i], rot: [-0.6, -0.3, 0, 0.3, 0.6][i],
    fill: { kind: 'linear', x0: -12.5, y0: 30, x1: 14.25, y1: -34, stops: STOPS },
  })),
  ...over,
})
const BANDS = [{ color: '#1d3557', opacity: 0.8, line: 10 }, { color: '#ffffff', opacity: 1, line: 4 }]
const FONT = { comic: 0, bangers: 1, dejavu: 2, oblique: 3 }
// [name, job, font, size, synth, transform]
const JOBS = [
  ['solid', straight({}), FONT.comic, 28, 0, [2, 0, 0, 2, 0, 0]],
  ['solid, 11.5 px, 1x', straight({ align: 'left' }), FONT.dejavu, 11.5, 0, [1, 0, 0, 1, 0.37, 0.61]],
  ['two bands', straight({ bands: BANDS }), FONT.comic, 28, 0, [2, 0, 0, 2, 0, 0]],
  ['hairline', straight({ bands: [{ color: '#e63946', opacity: 0.5, line: 0.3 }], fill: null }), FONT.bangers, 30, 0, [1.5, 0, 0, 1.5, 3.25, 7.75]],
  ['linear', straight({ bands: BANDS, fill: { kind: 'linear', x0: 40, y0: 20.5, x1: 290.25, y1: 130, stops: STOPS } }), FONT.bangers, 30, 0, [2, 0, 0, 2, 0, 0]],
  ['radial', straight({ fill: { kind: 'radial', cx: 150.5, cy: 80.25, r: 121.75, stops: STOPS } }), FONT.dejavu, 22, 0, [2, 0, 0, 2, 0, 0]],
  ['per line', straight({ fill: null, runs: straight({}).runs.map((r, i) => ({ ...r, fill: { kind: 'linear', x0: 0, y0: r.y - 24.5, x1: 0, y1: r.y + 6.25, stops: i === 1 ? STOPS.slice(0, 2) : STOPS } })) }), FONT.comic, 28, 0, [2, 0, 0, 2, 0, 0]],
  ['pattern', straight({ fill: { kind: 'pattern', style: { color: '#e63946' }, px: 10.2, ax: 12.75, ay: 9.5 } }), FONT.bangers, 34, 0, [2, 0, 0, 2, 0, 0]],
  ['pattern, shrunk', straight({ fill: { kind: 'pattern', style: { color: '#e63946' }, px: 2.55, ax: 12.75, ay: 9.5 } }), FONT.bangers, 34, 0, [1, 0, 0, 1, 0, 0]],
  ['curved', curved({}), FONT.comic, 30, 0, [2, 0, 0, 2, 0, 0]],
  ['curved, pattern, bold', curved({ runs: curved({}).runs.map((r) => ({ ...r, fill: { kind: 'pattern', style: { color: '#e63946' }, px: 6.4, ax: -r.x, ay: -r.y } })) }), FONT.dejavu, 26, 1, [2, 0, 0, 2, 0, 0]],
  ['silhouette', straight({ bands: BANDS, silhouette: 'rgba(40,40,40,0.5)', fill: null }), FONT.comic, 28, 0, [2, 0, 0, 2, 6, 6]],
  ['silhouette, curved', curved({ silhouette: '#444444' }), FONT.comic, 30, 0, [2, 0, 0, 2, 0, 0]],
  ['letter spacing', straight({ letterSpacing: 3.5, align: 'right', bands: BANDS.slice(1) }), FONT.comic, 24, 0, [2, 0, 0, 2, 300, 0]],
  ['bold italic', straight({ bands: BANDS }), FONT.comic, 28, 3, [2, 0, 0, 2, 0, 0]],
  ['its own oblique', straight({}), FONT.oblique, 22, 0, [2, 0, 0, 2, 0, 0]],
  // cos and sin of 17 degrees, written out, at 2x.
  ['rotated', straight({ bands: BANDS, fill: { kind: 'linear', x0: 40, y0: 20.5, x1: 290.25, y1: 130, stops: STOPS } }), FONT.comic, 28, 0, [1.9126095119260709, 0.5847434094454735, -0.5847434094454735, 1.9126095119260709, 120.5, 10.25]],
  ['mirrored', straight({ bands: BANDS }), FONT.bangers, 28, 2, [-2, 0, 0, 2, 700, 0]],
  ['sheared, 3.3x', straight({ bands: BANDS.slice(1) }), FONT.dejavu, 20, 1, [3.3, 0.4, -0.7, 3.1, 150.37, 0.61]],
  ['nothing', straight({ runs: [{ text: '   ', x: 0, y: 0 }] }), FONT.comic, 28, 0, [2, 0, 0, 2, 0, 0]],
]

async function hashes() {
  const engine = await createEngine(readFileSync(wasmPath))
  // The comparison build starts on the exact rasteriser; say so anyway.
  engine.exports.mt_paint_rasterizer?.(0)
  const ids = FONTS.map((f) => engine.addFont(readFileSync(f.path)))
  const all = createHash('sha256')
  const each = []
  const dump = []
  for (const [name, job, font, size, synth, transform] of JOBS) {
    const request = { job: { ...job, face: face(size) }, font: ids[font], synth, transform, tiles: () => TILE }
    dump.push(Buffer.from(encodeJob(request)))
    const r = paintJob(engine, request)
    const h = createHash('sha256')
    // 32-bit FNV-1a of the same bytes: what the native example prints.
    let fnv = 0x811c9dc5
    if (r) {
      const head = new Uint8Array(new Float64Array([r.x, r.y, r.width, r.height]).buffer)
      h.update(head)
      h.update(r.data)
      for (const bytes of [head, r.data]) {
        for (let i = 0; i < bytes.length; i++) fnv = Math.imul(fnv ^ bytes[i], 0x01000193)
      }
    }
    const digest = h.digest('hex')
    all.update(digest)
    each.push({ name, size: r ? `${r.width} x ${r.height}` : 'nothing', digest, fnv: (fnv >>> 0).toString(16).padStart(8, '0') })
  }
  return { hash: all.digest('hex'), each, dump }
}

const dumpAt = process.argv.indexOf('--dump')
if (process.argv.includes('--hash') || dumpAt >= 0) {
  const r = await hashes()
  if (dumpAt >= 0) {
    // u32 count, then per job: u32 byte length and the bytes.
    const parts = [Buffer.alloc(4)]
    parts[0].writeUInt32LE(r.dump.length)
    for (const d of r.dump) {
      const len = Buffer.alloc(4)
      len.writeUInt32LE(d.length)
      parts.push(len, d)
    }
    writeFileSync(process.argv[dumpAt + 1], Buffer.concat(parts))
    for (const e of r.each) console.log(`${e.digest.slice(0, 16)}  ${e.fnv}  ${e.size.padEnd(11)}  ${e.name}`)
  }
  console.log(r.hash)
} else {
  const builds = ['mt_text.wasm', 'oz.wasm', 'mt_text.simd.wasm', 'wasmopt.wasm', 'mt_text.compare.wasm']
  const run = (file) =>
    spawnSync(process.execPath, [self, '--hash'], { encoding: 'utf8', env: { ...process.env, MT_TEXT_WASM: file } }).stdout.trim()
  const here = await hashes()
  console.log(`${JOBS.length} jobs, node ${process.version}, ${process.arch}`)
  for (const e of here.each) console.log(`  ${e.digest.slice(0, 16)}  ${e.size.padEnd(11)}  ${e.name}`)
  console.log('\n| build | bytes | hash of all rasters | same as the default build |')
  console.log('|---|---|---|---|')
  let ok = true
  let base = null
  for (const file of builds) {
    const path = resolve(genDir, file)
    if (!existsSync(path)) {
      console.log(`| ${file} | not built | | |`)
      continue
    }
    // Two separate processes for every build.
    const [a, b] = [run(file), run(file)]
    base ??= a
    const same = a === b && a === base && /^[0-9a-f]{64}$/.test(a)
    ok &&= same
    console.log(`| ${file} | ${readFileSync(path).length} | ${a.slice(0, 16)}${a === b ? '' : ` and ${b.slice(0, 16)} in a second process`} | ${same ? 'yes, in both processes' : 'NO'} |`)
  }
  if (!ok) process.exit(1)
}
