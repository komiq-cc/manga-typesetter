// Is a band the stroke of the glyph as it is filled? Checked against a truth
// that shares nothing with the painter's stroker: the glyphs are filled at 8
// times the size, the filled pixels are grown and shrunk by the pen with a
// distance transform, and the band is what lies between, averaged down.
//
//   node text-engine/parity/band-shape.mjs
//   MT_TEXT_WASM=/path/to/another.wasm node text-engine/parity/band-shape.mjs
//
// For each fixture font, a line of separate letters is painted as a band
// alone (no fill over it, so its inner edge shows) with the glyph regular,
// with a synthesised bold drawn as an outset, and with one drawn as a smear
// (the glyph again a 36th of the size to the right, which is how the Mac's
// browsers draw it and what `boldAdvance=webkit` selects). Pens: 0.75, 2 and
// 5 px, the last wider than most stems.
//
// The truth is good to about a sixteenth of a pixel (it is made of whole
// pixels at 8 times the size), which is some 16 alpha levels at an edge. A
// band whose edge is in the wrong place is wrong by whole pixels: `over 64`
// counts those, per 1000 pixels the band touches.
//
// Pictures: js/generated/paint/band-shape-<font>-<drawing>.png, a row per
// pen: the engine's band, the truth, and the difference (red where only the
// engine has ink, blue where only the truth has), three times enlarged.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, ImageData } from '@napi-rs/canvas'
import { createEngine } from '../js/engine.mjs'
import { paintJob } from '../js/paint.mjs'
import { FONTS, wasmPath, fmt } from './common.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../js/generated/paint')
mkdirSync(outDir, { recursive: true })

const K = 8
const SIZE = 56
const TEXT = 'B e g W % & 8 a s i ?'
const PENS = [0.75, 2, 5]
const DRAWINGS = [
  ['regular', { bold: false }, 'rule'],
  ['outset', { bold: true }, 'outset'],
  ['smear', { bold: true }, 'smear'],
]

// Which truth the engine is compared with and pictured against; the table has both.
const TRUTH = process.env.TRUTH === 'shape' ? 'shape' : 'drawn'

const engine = await createEngine(readFileSync(wasmPath))
const fonts = FONTS.filter((f) => f.key !== 'DejaVuSans-Oblique').map((f) => ({ ...f, id: engine.addFont(readFileSync(f.path)) }))

function request(font, synth, boldDraw, over, scale) {
  return {
    job: {
      curved: false, align: 'left', letterSpacing: 10, bands: [], silhouette: null, fill: null,
      runs: [{ text: TEXT, x: 20.3, y: 80.6 }],
      ...over,
    },
    font: font.id, size: SIZE, synth, boldDraw, weight: 0,
    transform: [scale, 0, 0, scale, 0, 0],
  }
}

/** Squared distance of every cell to the nearest cell where `on` is true (Felzenszwalb and Huttenlocher). */
function distance2(on, w, h) {
  const INF = 1e20
  const d = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) d[i] = on[i] ? 0 : INF
  const n = Math.max(w, h)
  const f = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), out = new Float64Array(n)
  const pass = (len) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < len; q++) {
      let s
      for (;;) {
        const p = v[k]
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p)
        if (s > z[k]) break
        k--
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++
      const p = v[k]
      out[q] = (q - p) * (q - p) + f[p]
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x]
    pass(h)
    for (let y = 0; y < h; y++) d[y * w + x] = out[y]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x]
    pass(w)
    for (let x = 0; x < w; x++) d[y * w + x] = out[x]
  }
  return d
}

/**
 * The band as coverage on the device grid, `{ x, y, w, h, cov }`, made one of two ways.
 *
 * `shape`: the stroke, `pen` px each way, of the glyph as it is filled, bold and all.
 * `drawn`: the stroke as the reference that draws the bold that way makes it. Skia strokes
 *   the font's outline with a pen wider by the bold's own; WebKit strokes the font's outline
 *   and does it again a 36th of the size to the right (here with everything between).
 * The two have the same outer edge and differ in where the band ends inside the glyph.
 */
function truth(font, synth, boldDraw, pen, how) {
  const asDrawn = how === 'drawn' && synth.bold
  const fill = paintJob(engine, request(font, asDrawn ? { bold: false } : synth, boldDraw, { fill: { kind: 'solid', color: '#000000' } }, K))
  const smear = asDrawn && boldDraw === 'smear' ? Math.round((SIZE / 36) * K) : 0
  if (asDrawn && boldDraw === 'outset') pen += boldOutset(SIZE)
  const pad = Math.ceil(pen + 2 + smear / K)
  const x = Math.floor(fill.x / K) - pad, y = Math.floor(fill.y / K) - pad
  const w = Math.ceil((fill.x + fill.width) / K) + pad - x, h = Math.ceil((fill.y + fill.height) / K) + pad - y
  const W = w * K, H = h * K
  const inside = new Uint8Array(W * H), outside = new Uint8Array(W * H).fill(1)
  for (let yy = 0; yy < fill.height; yy++) {
    for (let xx = 0; xx < fill.width; xx++) {
      if (fill.data[(yy * fill.width + xx) * 4 + 3] < 128) continue
      const i = (yy + fill.y - y * K) * W + xx + fill.x - x * K
      inside[i] = 1
      outside[i] = 0
    }
  }
  // A cell's centre is half a cell from the edge of its neighbour.
  const reach = pen * K + 0.5
  const toShape = distance2(inside, W, H), toGround = distance2(outside, W, H)
  const cov = new Float32Array(w * h)
  for (let yy = 0; yy < H; yy++) {
    // How many of the cells from here back to `smear` cells to the left are in the band.
    let near = 0
    for (let xx = 0; xx < W; xx++) {
      const i = yy * W + xx
      const band = (c) => (inside[c] ? toGround[c] : toShape[c]) <= reach * reach
      if (band(i)) near++
      if (xx > smear && band(i - smear - 1)) near--
      if (near > 0) cov[Math.floor(yy / K) * w + Math.floor(xx / K)] += 1 / (K * K)
    }
  }
  return { x, y, w, h, cov }
}

/** Skia's rule for the pen of a synthesised bold, as `bold_outset` in metrics.rs has it. */
function boldOutset(size) {
  const k = size <= 9 ? 1 / 24 : size >= 36 ? 1 / 32 : 1 / 24 + ((1 / 32 - 1 / 24) * (size - 9)) / 27
  return (size * k) / 2
}

function compare(t, band) {
  let n = 0, sum = 0, max = 0, over = 0
  const got = new Float32Array(t.w * t.h)
  if (band) {
    for (let yy = 0; yy < band.height; yy++) {
      for (let xx = 0; xx < band.width; xx++) {
        const gx = xx + band.x - t.x, gy = yy + band.y - t.y
        const a = band.data[(yy * band.width + xx) * 4 + 3] / 255
        if (gx < 0 || gy < 0 || gx >= t.w || gy >= t.h) {
          // Ink where the truth has no room for any: counted as all wrong.
          if (a > 0) {
            n++
            sum += a * 255
            max = Math.max(max, a * 255)
            if (a * 255 > 64) over++
          }
          continue
        }
        got[gy * t.w + gx] = a
      }
    }
  }
  for (let i = 0; i < t.w * t.h; i++) {
    if (got[i] === 0 && t.cov[i] === 0) continue
    const d = Math.abs(got[i] - t.cov[i]) * 255
    n++
    sum += d
    max = Math.max(max, d)
    if (d > 64) over++
  }
  return { n, mean: n ? sum / n : 0, max, over: n ? (1000 * over) / n : 0, got }
}

function picture(rows, name) {
  const S = 3, gap = 10, label = 22
  const w = Math.max(...rows.map((r) => r.t.w)), h = rows.reduce((s, r) => s + r.t.h * S + label + gap, gap)
  const canvas = createCanvas(3 * w * S + 4 * gap, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = false
  ctx.font = '15px sans-serif'
  let y = gap
  for (const { t, got, pen } of rows) {
    const panels = [
      (i) => { const g = 255 - Math.round(got[i] * 255); return [g, g, g] },
      (i) => { const g = 255 - Math.round(t.cov[i] * 255); return [g, g, g] },
      (i) => {
        const d = got[i] - t.cov[i]
        const m = 255 - Math.round(Math.abs(d) * 255)
        return d > 0 ? [255, m, m] : [m, m, 255]
      },
    ]
    const names = [`engine, pen ${pen} px`, `truth (${TRUTH === 'drawn' ? 'the stroke as the reference draws it' : 'the stroke of the filled shape'}, at 8x)`, 'difference: red engine only, blue truth only']
    panels.forEach((colour, k) => {
      const img = new ImageData(t.w, t.h)
      for (let i = 0; i < t.w * t.h; i++) img.data.set([...colour(i), 255], i * 4)
      const small = createCanvas(t.w, t.h)
      small.getContext('2d').putImageData(img, 0, 0)
      const x = gap + k * (w * S + gap)
      ctx.fillStyle = '#000000'
      ctx.fillText(names[k], x, y + 15)
      ctx.drawImage(small, x, y + label, t.w * S, t.h * S)
    })
    y += t.h * S + label + gap
  }
  writeFileSync(resolve(outDir, name), canvas.toBuffer('image/png'))
}

console.log(`engine ${wasmPath}`)
console.log(`"${TEXT}" at ${SIZE} px, a band alone; truth from the fill at ${K}x. Differences in alpha levels of 255 over the pixels either touches.\n`)
console.log('| font | bold drawn as | pen (px) | pixels | as the reference strokes it: mean | max | over 64 (per 1000) | as a stroke of the filled shape: mean | max | over 64 (per 1000) |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const font of fonts) {
  for (const [drawing, synth, boldDraw] of DRAWINGS) {
    const rows = []
    for (const pen of PENS) {
      const band = paintJob(engine, request(font, synth, boldDraw, { bands: [{ color: '#000000', opacity: 1, line: pen * 2 }] }, 1))
      const both = ['drawn', 'shape'].map((how) => {
        const t = truth(font, synth, boldDraw, pen, how)
        return { t, ...compare(t, band) }
      })
      const shown = both[TRUTH === 'drawn' ? 0 : 1]
      rows.push({ t: shown.t, got: shown.got, pen })
      console.log(`| ${font.key} | ${drawing} | ${pen} | ${both[0].n} | ${both.map((r) => `${fmt(r.mean, 2)} | ${fmt(r.max, 1)} | ${fmt(r.over, 2)}`).join(' | ')} |`)
    }
    picture(rows, `band-shape-${font.key.toLowerCase()}-${drawing}.png`)
  }
}
console.log(`\npictures: ${outDir}/band-shape-<font>-<drawing>.png`)
