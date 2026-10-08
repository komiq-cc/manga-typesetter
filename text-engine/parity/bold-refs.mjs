// How each reference DRAWS a synthesised bold, read off its pictures, and
// which of the painter's two ways of drawing one (`boldDraw`) is nearer to it.
//
//   TP_DATA=/path/to/tp-data node text-engine/parity/bold-refs.mjs
//
// The corpus has six `faux-bold` pixel cases (Comic Neue at 22 and 40 px and
// Bangers at 40 px, a face with no bold of its own, one short text and one
// long). The three with the short text, "AVATAR WAVE!", each have a twin
// drawn in the regular face in the same black: `spacing`, the same box with
// 3 px of letter spacing, which moves the letters and leaves their strokes
// as they are. (The twin has to be black too: Skia thins black text and
// thickens light text, so a twin with a light fill makes every bold look
// lighter than it is.) From the reference pictures of both,
// for `ref-wk` (Safari), `ref-cr` (Chromium) and `ref-sk` (Skia in node):
//
//   stem   how much wider an upright stem is in the bold picture, device px
//   bar    how much thicker a level bar is
//
// A stem is read where the ink's vertical run through a pixel is more than
// four times its horizontal run, a bar the other way round; the width is the
// alpha summed along the short run, and the figure is the median over the
// picture. Device px are twice the text's px (the pictures are drawn at 2x).
//
// Then the engine paints the same lines, regular and bold, with the bold
// drawn each way and the glyphs placed under each `boldAdvance` rule, and
// the same two figures are read off its rasters. Last, each engine raster is
// laid over each reference's bold picture (moved to where they agree best,
// in steps of a quarter pixel) and the two are compared: overlap of the
// `alpha >= 128` masks and mean |alpha difference| over inked pixels.
// The first row of each group is the control: the regular face over the
// reference's regular picture. No reference draws a glyph the way the engine
// does (each is heavier or lighter all round, see P5A-REPORT.md), so that
// row is how far apart the two are before any bold is drawn, and a bold row
// near it is a bold drawn the same way.
//
// Pictures go to js/generated/paint/bold-<case>.png: one row per reference
// with its bold picture, then for each of the engine's three variants the
// engine's raster and the difference (red: only the engine has ink; blue:
// only the reference has).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas'
import { createEngine } from '../js/engine.mjs'
import { paintJob } from '../js/paint.mjs'
import { FONTS, wasmPath, fmt } from './common.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../js/generated/paint')
mkdirSync(outDir, { recursive: true })
const dataDir = process.env.TP_DATA
if (!dataDir || !existsSync(resolve(dataDir, 'runs/ref-wk/base/png'))) {
  console.error('set TP_DATA to the directory that holds runs/ref-wk, runs/ref-cr and runs/ref-sk')
  process.exit(1)
}

const engine = await createEngine(readFileSync(wasmPath))
const fontId = Object.fromEntries(FONTS.map((f) => [f.key, engine.addFont(readFileSync(f.path))]))

// case, font, size, and the lines "AVATAR WAVE!" breaks into in a 240 px box.
const CASES = [
  { n: 0, font: 'ComicNeue', size: 22, lines: ['AVATAR WAVE!'] },
  { n: 1, font: 'ComicNeue', size: 40, lines: ['AVATAR', 'WAVE!'] },
  { n: 2, font: 'Bangers', size: 40, lines: ['AVATAR WAVE!'] },
]
const REFS = [
  { run: 'ref-wk', name: 'WebKit (Safari 27)' },
  { run: 'ref-cr', name: 'Chromium 152' },
  { run: 'ref-sk', name: 'Skia in node' },
]
const VARIANTS = [
  { name: 'outset, advance unchanged', boldDraw: 'outset', rule: 'unchanged' },
  { name: 'outset, advance webkit', boldDraw: 'outset', rule: 'webkit' },
  { name: 'smear, advance webkit', boldDraw: 'smear', rule: 'webkit' },
]
const SS = 2
const [W, H] = [496, 376]

async function reference(run, id) {
  const img = await loadImage(readFileSync(resolve(dataDir, 'runs', run, 'base/png', `${id}.png`)))
  if (img.width !== W || img.height !== H) throw new Error(`${run} ${id}: ${img.width} x ${img.height}`)
  const c = createCanvas(W, H)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, W, H).data
  const a = new Uint8Array(W * H)
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3]
  return a
}

/** Median width of upright stems and thickness of level bars, device px. */
function strokes(a) {
  const lh = new Float32Array(W * H)
  const lv = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; ) {
      if (a[y * W + x] === 0) {
        x++
        continue
      }
      let e = x
      let s = 0
      while (e < W && a[y * W + e] > 0) s += a[y * W + e++]
      for (let k = x; k < e; k++) lh[y * W + k] = s / 255
      x = e
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; ) {
      if (a[y * W + x] === 0) {
        y++
        continue
      }
      let e = y
      let s = 0
      while (e < H && a[e * W + x] > 0) s += a[e++ * W + x]
      for (let k = y; k < e; k++) lv[k * W + x] = s / 255
      y = e
    }
  }
  const stems = []
  const bars = []
  let ink = 0
  for (let i = 0; i < W * H; i++) {
    ink += a[i]
    if (a[i] < 250) continue
    if (lv[i] > 4 * lh[i]) stems.push(lh[i])
    else if (lh[i] > 4 * lv[i]) bars.push(lv[i])
  }
  const median = (v) => (v.length ? v.sort((p, q) => p - q)[v.length >> 1] : NaN)
  return { stem: median(stems), bar: median(bars), ink: ink / 255 }
}

/** The engine's picture of the case's lines, moved by (dx, dy) device px. */
function paint(c, { bold, boldDraw = 'outset', rule = 'unchanged', spacing = 0 }, dx = 0, dy = 0) {
  engine.setRule('boldAdvance', rule)
  const job = {
    face: { size: c.size },
    curved: false,
    align: 'center',
    letterSpacing: spacing,
    bands: [],
    silhouette: null,
    fill: { kind: 'solid', color: '#000000' },
    // Centred in the 248 px wide texture, lines 1.1 em apart.
    runs: c.lines.map((text, i) => ({ text, x: 124, y: 60 + i * c.size * 1.1 })),
  }
  const r = paintJob(engine, { job, font: fontId[c.font], synth: { bold }, boldDraw, transform: [SS, 0, 0, SS, dx, dy], view: true })
  engine.setRule('boldAdvance', 'unchanged')
  const a = new Uint8Array(W * H)
  for (let y = 0; y < r.height; y++) {
    const Y = y + r.y
    if (Y < 0 || Y >= H) continue
    for (let x = 0; x < r.width; x++) {
      const X = x + r.x
      if (X >= 0 && X < W) a[Y * W + X] = r.data[(y * r.width + x) * 4 + 3]
    }
  }
  return a
}

function bbox(a) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (a[y * W + x] >= 128) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return [x0, y0, x1 + 1, y1 + 1]
}

function distance(a, b) {
  let inter = 0, union = 0, sum = 0, n = 0
  for (let i = 0; i < W * H; i++) {
    const [p, q] = [a[i], b[i]]
    if (p >= 128 && q >= 128) inter++
    if (p >= 128 || q >= 128) union++
    if (p || q) {
      sum += Math.abs(p - q)
      n++
    }
  }
  return { overlap: union ? inter / union : 1, alpha: n ? sum / n : 0 }
}

/** The engine's picture laid where it agrees best with `ref`. */
function fitted(c, variant, ref) {
  // Centre on centre first, then every quarter pixel within 2 px of that.
  const [e, r] = [bbox(paint(c, variant)), bbox(ref)]
  const [cx, cy] = [(r[0] + r[2] - e[0] - e[2]) / 2, (r[1] + r[3] - e[1] - e[3]) / 2]
  let best = null
  for (let dy = -2; dy <= 2; dy += 0.25) {
    for (let dx = -2; dx <= 2; dx += 0.25) {
      const a = paint(c, variant, cx + dx, cy + dy)
      const d = distance(a, ref)
      if (!best || d.alpha < best.alpha) best = { ...d, a, dx: cx + dx, dy: cy + dy }
    }
  }
  return best
}

function png(name, rows) {
  const gap = 6
  const cols = Math.max(...rows.map((r) => r.length))
  // Only the band of rows that has ink, to keep the picture small.
  const all = rows.flat()
  let y0 = H, y1 = 0
  for (const a of all) {
    if (!a.alpha) continue
    const b = bbox(a.alpha)
    y0 = Math.min(y0, b[1])
    y1 = Math.max(y1, b[3])
  }
  y0 = Math.max(0, y0 - 8)
  y1 = Math.min(H, y1 + 8)
  const h = y1 - y0
  const out = createCanvas(cols * (W + gap) - gap, rows.length * (h + gap) - gap)
  const ctx = out.getContext('2d')
  ctx.fillStyle = '#8a8f98'
  ctx.fillRect(0, 0, out.width, out.height)
  rows.forEach((row, j) => {
    row.forEach((cell, i) => {
      const d = new Uint8ClampedArray(W * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < W; x++) {
          const s = (y + y0) * W + x
          const o = (y * W + x) * 4
          if (cell.alpha) d.set([0, 0, 0, cell.alpha[s]], o)
          else d.set([Math.max(0, cell.a[s] - cell.b[s]), 0, Math.max(0, cell.b[s] - cell.a[s]), 255], o)
        }
      }
      const c = createCanvas(W, h)
      c.getContext('2d').putImageData(new ImageData(d, W, h), 0, 0)
      ctx.drawImage(c, i * (W + gap), j * (h + gap))
    })
  })
  writeFileSync(resolve(outDir, name), out.toBuffer('image/png'))
}

const k = (s) => (s <= 9 ? 1 / 24 : s >= 36 ? 1 / 32 : 1 / 24 + ((1 / 32 - 1 / 24) * (s - 9)) / 27)
console.log(`engine ${wasmPath}\n`)
console.log('What a bold adds to a stroke, device px at 2x (regular -> bold, and the growth)\n')
console.log('| case | drawn by | stem | bar | ink (px) |')
console.log('|---|---|---|---|---|')
const growth = (reg, bold) =>
  `${fmt(reg.stem, 2)} -> ${fmt(bold.stem, 2)} (+${fmt(bold.stem - reg.stem, 2)}) | ${fmt(reg.bar, 2)} -> ${fmt(bold.bar, 2)} (+${fmt(bold.bar - reg.bar, 2)}) | ${fmt(reg.ink, 0)} -> ${fmt(bold.ink, 0)} (+${fmt((bold.ink / reg.ink - 1) * 100, 1)}%)`
const fits = []
for (const c of CASES) {
  const label = `${c.font} ${c.size} px`
  const refs = []
  for (const ref of REFS) {
    const reg = await reference(ref.run, `p.fx.${c.n}.spacing.0`)
    const bold = await reference(ref.run, `p.fx.${c.n}.faux-bold.0`)
    refs.push({ ...ref, bold, reg })
    console.log(`| ${label} | ${ref.name} | ${growth(strokes(reg), strokes(bold))} |`)
  }
  const regular = strokes(paint(c, { bold: false }))
  for (const v of [VARIANTS[0], VARIANTS[2]]) {
    console.log(`| ${label} | engine, ${v.boldDraw} | ${growth(regular, strokes(paint(c, { bold: true, ...v })))} |`)
  }
  console.log(`| ${label} | the rules, in device px | outset: ${fmt(2 * SS * (c.size * k(c.size)) / 2, 2)} on stems and bars; smear: ${fmt((SS * c.size) / 36, 2)} on stems, 0 on level bars | | |`)
  const rows = []
  for (const ref of refs) {
    const row = [{ alpha: ref.bold }]
    fits.push({ label, ref: ref.name, variant: 'regular face, over the regular picture (control)', ...fitted(c, { bold: false, spacing: 3 }, ref.reg) })
    for (const v of VARIANTS) {
      const f = fitted(c, { bold: true, ...v }, ref.bold)
      fits.push({ label, ref: ref.name, variant: v.name, ...f })
      row.push({ alpha: f.a }, { a: f.a, b: ref.bold })
    }
    rows.push(row)
  }
  png(`bold-${c.font.toLowerCase()}-${c.size}.png`, rows)
}

console.log('\nThe engine\'s bold laid over each reference\'s bold picture, at the best fit\n')
console.log('| case | reference | engine draws | overlap at 50% | mean alpha diff (of 255) | laid at (device px) |')
console.log('|---|---|---|---|---|---|')
for (const f of fits) console.log(`| ${f.label} | ${f.ref} | ${f.variant} | ${fmt(f.overlap, 4)} | ${fmt(f.alpha, 2)} | ${fmt(f.dx, 2)}, ${fmt(f.dy, 2)} |`)
console.log(`\nPNGs in ${outDir}: bold-<font>-<size>.png, a row per reference (WebKit, Chromium, Skia):`)
console.log('its bold picture, then engine and difference for each of: ' + VARIANTS.map((v) => v.name).join('; '))
