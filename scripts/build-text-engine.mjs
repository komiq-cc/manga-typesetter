// Builds the text engine (text-engine/, crate `mt-text`) to WebAssembly and
// syncs it to text-engine/js/generated/ with a manifest of its size and hash.
//
//   node scripts/build-text-engine.mjs
//
// Environment, all optional (they exist so SPIKE.md's size table can be
// regenerated; the app build uses the defaults):
//   MT_TEXT_FEATURES    cargo features, comma separated (default: crate default)
//   MT_TEXT_NO_DEFAULT  "1" to pass --no-default-features
//   MT_TEXT_OPT_LEVEL   3 | s | z, overrides the release profile's opt-level
//   MT_TEXT_RUSTFLAGS   extra rustc flags, e.g. "-C target-feature=+simd128"
//   MT_TEXT_WASM_OPT    path to a binaryen `wasm-opt`, or "1" to use
//                       node_modules/binaryen if it is installed
//   MT_TEXT_WASM_OPT_LEVEL  -O3 | -O4 | -Os | -Oz (default -O3)
//   MT_TEXT_OUT         output file name inside generated/ (default mt_text.wasm)
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const crateDir = resolve(repoRoot, 'text-engine')
const builtWasm = resolve(crateDir, process.env.CARGO_TARGET_DIR ?? 'target', 'wasm32-unknown-unknown/release/mt_text.wasm')
const outDir = resolve(crateDir, 'js/generated')
const outName = process.env.MT_TEXT_OUT ?? 'mt_text.wasm'
const outWasm = resolve(outDir, outName)
const manifestPath = resolve(outDir, outName.replace(/\.wasm$/, '') + '.manifest.json')

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) process.exit(r.status ?? 1)
  return r
}

const cargoArgs = ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown']
if (process.env.MT_TEXT_NO_DEFAULT === '1') cargoArgs.push('--no-default-features')
if (process.env.MT_TEXT_FEATURES) cargoArgs.push('--features', process.env.MT_TEXT_FEATURES)
const env = { ...process.env }
if (process.env.MT_TEXT_OPT_LEVEL) env.CARGO_PROFILE_RELEASE_OPT_LEVEL = process.env.MT_TEXT_OPT_LEVEL
if (process.env.MT_TEXT_RUSTFLAGS) env.RUSTFLAGS = [env.RUSTFLAGS, process.env.MT_TEXT_RUSTFLAGS].filter(Boolean).join(' ')

process.stdout.write(`cargo ${cargoArgs.join(' ')}\n`)
run('cargo', cargoArgs, { cwd: crateDir, env })

mkdirSync(outDir, { recursive: true })
const rawBytes = statSync(builtWasm).size
const rawSha256 = sha256(builtWasm)

let wasmOpt = null
const optSetting = process.env.MT_TEXT_WASM_OPT
if (optSetting) {
  const level = process.env.MT_TEXT_WASM_OPT_LEVEL ?? '-O3'
  if (!['-O3', '-O4', '-Os', '-Oz'].includes(level)) {
    process.stderr.write(`Unsupported MT_TEXT_WASM_OPT_LEVEL "${level}"\n`)
    process.exit(1)
  }
  const bin = optSetting === '1' ? resolve(repoRoot, 'node_modules/binaryen/bin/wasm-opt') : resolve(optSetting)
  if (!existsSync(bin)) {
    process.stderr.write(`wasm-opt not found at ${bin}\n`)
    process.exit(1)
  }
  // binaryen's npm package ships wasm-opt as a node script; a native binary
  // is run directly.
  const viaNode = /\.(m?js)$/.test(bin) || readFileSync(bin, { encoding: 'latin1' }).startsWith('#!/usr/bin/env node')
  // rustc's wasm32 baseline (Rust 1.87+) uses these proposals; wasm-opt
  // refuses the module unless it is told they are allowed. Every engine the
  // app targets has shipped all of them.
  const features = [
    '--enable-bulk-memory',
    '--enable-nontrapping-float-to-int',
    '--enable-sign-ext',
    '--enable-mutable-globals',
    '--enable-multivalue',
    '--enable-reference-types',
  ]
  if (/simd128/.test(process.env.MT_TEXT_RUSTFLAGS ?? '')) features.push('--enable-simd')
  const args = [level, ...features, builtWasm, '-o', outWasm]
  run(viaNode ? process.execPath : bin, viaNode ? [bin, ...args] : args)
  wasmOpt = level
} else {
  copyFileSync(builtWasm, outWasm)
}

const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' }).stdout.trim()
const manifest = {
  file: outName,
  bytes: statSync(outWasm).size,
  sha256: sha256(outWasm),
  rawBytes,
  rawSha256,
  wasmOpt,
  optLevel: process.env.MT_TEXT_OPT_LEVEL ?? 'profile default',
  features: process.env.MT_TEXT_FEATURES ?? null,
  defaultFeatures: process.env.MT_TEXT_NO_DEFAULT !== '1',
  rustflags: process.env.MT_TEXT_RUSTFLAGS ?? null,
  rustc,
}
// LF and a trailing newline so the file diffs cleanly on every OS.
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${outWasm}\n  ${manifest.bytes} bytes  sha256 ${manifest.sha256}\n`)
