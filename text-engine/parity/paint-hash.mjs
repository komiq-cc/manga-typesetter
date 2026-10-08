// The painter's bytes are the same wherever it runs: a hash of the rasters of
// a fixed set of jobs, across two processes, across every build of the wasm
// found in js/generated/, and against the native build.
//
//   node text-engine/parity/paint-hash.mjs            # the table, exits 1 on any difference
//   node text-engine/parity/paint-hash.mjs --native   # the same, and the native build beside it (runs cargo)
//   node text-engine/parity/paint-hash.mjs --hash     # one line: this wasm's hash (MT_TEXT_WASM picks the file)
//
// The jobs and the hashing are in paint-hash-jobs.mjs and ../js/paint.mjs,
// neither of which uses anything of node's, so a browser page can import
// them and print the same 16 digits (see the top of paint-hash-jobs.mjs).
//
// The builds compared are the ones of SPIKE.md section 3 that are present:
//
//   mt_text.wasm        npm run build:engine
//   oz.wasm             MT_TEXT_OPT_LEVEL=z MT_TEXT_OUT=oz.wasm npm run build:engine
//   mt_text.simd.wasm   MT_TEXT_FEATURES=simd MT_TEXT_RUSTFLAGS="-C target-feature=+simd128" MT_TEXT_OUT=mt_text.simd.wasm npm run build:engine
//   wasmopt.wasm        MT_TEXT_WASM_OPT=/path/to/wasm-opt MT_TEXT_OUT=wasmopt.wasm npm run build:engine
//   mt_text.compare.wasm  the rasteriser comparison build, with the exact rasteriser selected
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../js/engine.mjs'
import { FONTS, wasmPath } from './common.mjs'
import { hashFixedJobs } from './paint-hash-jobs.mjs'

const self = fileURLToPath(import.meta.url)
const crateDir = resolve(dirname(self), '..')
const genDir = resolve(crateDir, 'js/generated')

async function hashes(options) {
  const engine = await createEngine(readFileSync(wasmPath))
  // The comparison build starts on the exact rasteriser; say so anyway.
  engine.exports.mt_paint_rasterizer?.(0)
  const ids = FONTS.map((f) => engine.addFont(readFileSync(f.path)))
  return hashFixedJobs(engine, ids, options)
}

if (process.argv.includes('--hash')) {
  console.log((await hashes()).hash)
} else {
  const native = process.argv.includes('--native')
  const here = await hashes({ bytes: native })
  let nativeHashes = null
  if (native) {
    // The encoded jobs, for the native build: u32 count, then per job
    // u32 rule (0 unchanged, 1 webkit), u32 byte length, the bytes.
    const u32 = (v) => {
      const b = Buffer.alloc(4)
      b.writeUInt32LE(v)
      return b
    }
    const parts = [u32(here.each.length)]
    for (const e of here.each) parts.push(u32(e.rule === 'webkit' ? 1 : 0), u32(e.bytes.length), Buffer.from(e.bytes))
    mkdirSync(resolve(genDir, 'paint'), { recursive: true })
    const dump = resolve(genDir, 'paint/hash-jobs.bin')
    writeFileSync(dump, Buffer.concat(parts))
    const run = spawnSync('cargo', ['run', '--quiet', '--release', '--example', 'paint_hash', '--', dump], { cwd: crateDir, encoding: 'utf8' })
    if (run.status !== 0) {
      console.error(run.stderr)
      process.exit(1)
    }
    nativeHashes = run.stdout.trim().split('\n')
  }
  let ok = true
  console.log(`${here.each.length} rasters, node ${process.version}, ${process.arch}`)
  here.each.forEach((e, i) => {
    let beside = ''
    if (nativeHashes) {
      const same = nativeHashes[i] === e.hash
      ok &&= same
      beside = same ? '  native: same' : `  native: ${nativeHashes[i]} DIFFERENT`
    }
    console.log(`  ${e.hash}  ${e.rule.padEnd(9)}  ${e.size.padEnd(11)}  ${e.name}${beside}`)
  })
  const builds = ['mt_text.wasm', 'oz.wasm', 'mt_text.simd.wasm', 'wasmopt.wasm', 'mt_text.compare.wasm']
  const run = (file) =>
    spawnSync(process.execPath, [self, '--hash'], { encoding: 'utf8', env: { ...process.env, MT_TEXT_WASM: file } }).stdout.trim()
  console.log('\n| build | bytes | hash of all rasters | same as the default build |')
  console.log('|---|---|---|---|')
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
    const same = a === b && a === base && /^[0-9a-f]{16}$/.test(a)
    ok &&= same
    console.log(`| ${file} | ${readFileSync(path).length} | ${a}${a === b ? '' : ` and ${b} in a second process`} | ${same ? 'yes, in both processes' : 'NO'} |`)
  }
  if (nativeHashes) console.log(`| native build (${process.arch}) | | ${nativeHashes.length} rasters one by one | ${here.each.every((e, i) => e.hash === nativeHashes[i]) ? 'yes' : 'NO'} |`)
  if (!ok) process.exit(1)
}
