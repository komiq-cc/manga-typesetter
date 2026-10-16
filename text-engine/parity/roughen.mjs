// The roughening's noise field as `turbulenceChannel` in src/lib/text-paint.js
// computes it, at a fixed set of points, as text the Rust port is held to
// (`the_field_is_the_one_in_text_paint_js`, text-engine/src/paint/roughen.rs).
//
//   node text-engine/parity/roughen.mjs           # writes tests/data/roughen.txt
//   node text-engine/parity/roughen.mjs --check   # exits 1 when the file is stale
//
// src/lib/roughen-fixture.test.js runs the check with the app's tests, so a
// change to the JS field fails there until the file is written again and the
// Rust port follows.
//
//   noise <seed> <channel> <frequency> <x> <y> <the value's 64 bits, hex>
//
// The value is the channel at page point (x, y): `turbulence(x * f, y * f)`.
// The inputs are written as JS prints them, the shortest text that reads back
// to the same double; the value is written as its bits, because the port is
// held to every one of them.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { noiseFor, turbulenceChannel } from '../../src/lib/text-paint.js'

const self = fileURLToPath(import.meta.url)
export const FIXTURE = resolve(dirname(self), '../tests/data/roughen.txt')

// mulberry32: the same numbers in every engine.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const bits = new DataView(new ArrayBuffer(8))
function hex(v) {
  bits.setFloat64(0, v)
  return bits.getBigUint64(0).toString(16).padStart(16, '0')
}

// The style's default and its ends, a seed below zero, one with a fraction
// and one past the generator's modulus: `setupSeed` has an answer for each.
const SEEDS = [7, 0, 1, 999, -3, 12345.9, 4294967296]
const FREQS = [0.05, 0.01, 0.2]

/** The file's text. */
export function roughenFixture() {
  const out = []
  SEEDS.forEach((seed, k) => {
    const nz = noiseFor(seed)
    for (const freq of FREQS) {
      const points = []
      // On the lattice and beside it, both sides of zero, and at random over
      // more than a page.
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) points.push([i / freq, j / freq])
      for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) points.push([i * 7.31 + 0.5, j * 5.17 - 0.25])
      const r = rng(1000 + k)
      for (let i = 0; i < 60; i++) points.push([r() * 3000 - 800, r() * 4000 - 900])
      for (const [x, y] of points) {
        for (const channel of [0, 1]) {
          out.push(`noise ${seed} ${channel} ${freq} ${x} ${y} ${hex(turbulenceChannel(nz, channel, x, y, freq))}`)
        }
      }
    }
  })
  return out.join('\n') + '\n'
}

if (process.argv[1] === self) {
  const text = roughenFixture()
  if (process.argv.includes('--check')) {
    const same = readFileSync(FIXTURE, 'utf8') === text
    console.log(same ? 'roughen.txt is what text-paint.js gives' : 'roughen.txt is STALE: run node text-engine/parity/roughen.mjs')
    process.exit(same ? 0 : 1)
  }
  writeFileSync(FIXTURE, text)
  console.log(`wrote ${FIXTURE}: ${text.split('\n').length - 1} lines`)
}
