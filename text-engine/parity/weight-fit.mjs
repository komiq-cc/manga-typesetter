// How much heavier Safari draws text than the engine, as a dilation: the
// painter's `weight` switch (device pixels by which every filled glyph shape
// is grown) is tried at several values on the real chapter boxes, and each
// picture is laid over Safari's (`runs/ref-wk/base`).
//
//   TP_DATA=/path/to/tp-data ./node_modules/.bin/vite-node text-engine/parity/weight-fit.mjs
//
//   WEIGHTS=0,0.1,...      the weights tried (default 0 to 0.6, closer together round a third)
//   LIMIT=n                every n-th box only (default 1: all of them)
//   PICTURES=id,id,id      also write side-by-side pictures for these boxes
//   BEST=0.4               the weight of the third panel of each picture
//   FIT=0                  skip the fit, write the pictures only
//   OUT=dir                where fit.json and the pictures go
//                          (default $TP_DATA/reports/weight; never the repo:
//                          the pictures are of the user's fonts and text)
//
// The boxes are painted as a capture paints them (the app's renderBoxTexture
// on the Rust engine under boldAdvance=webkit, the Rust painter), so the
// engine's picture at weight 0 is the capture's. Two groups are fitted:
//
//   plain          no band, shadow, blur, gradient, pattern, curve, turn or
//                  synthesised style: the glyphs' own edges
//   banded         the same with one or more bands under the fill
//   made-up plain  the corpus's own plain boxes (`p.base.*`), every font at
//                  14, 22 and 40 px: few chapter boxes have no band
//
// The weight grows fills only; a band stays a stroke of the font's outline
// (see `Request::weight` in src/paint/job.rs for why).
//
// Per box and weight, after moving the engine's picture by whole pixels to
// where it agrees best with Safari's at weight 0 (the same move for every
// weight, so a heavier glyph is not flattered by a better move):
//
//   alpha    mean |alpha difference| over pixels either has inked, of 255
//   overlap  intersection over union of the alpha >= 128 masks
//   colour   mean |difference| of the two pictures laid on mid grey, over
//            the same pixels and the three channels (a white band and a
//            dark fill both count; alpha alone cannot see where a band ends
//            and the fill begins)
//   ink      the engine's summed alpha over Safari's
//   lost     pixels Safari has solid (>= 128) that the engine has under 64,
//            per 1000 of Safari's solid pixels: hairlines that drop out
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../src/test/real-fonts.js'
import { GlobalFonts, createCanvas, loadImage, DOMMatrix, ImageData } from '@napi-rs/canvas'

globalThis.DOMMatrix = DOMMatrix
globalThis.ImageData ??= ImageData

const here = dirname(fileURLToPath(import.meta.url))
const DATA = process.env.TP_DATA
if (!DATA || !existsSync(resolve(DATA, 'runs/ref-wk/base/png'))) {
  console.error('set TP_DATA to the directory that holds corpus/, fonts/ and runs/ref-wk')
  process.exit(1)
}
const OUT = process.env.OUT || resolve(DATA, 'reports/weight')
if (resolve(OUT).startsWith(resolve(here, '../..') + '/')) {
  console.error('OUT is inside the repository: these pictures are of the user\'s fonts and text')
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })
const WEIGHTS = (process.env.WEIGHTS || '0,0.1,0.2,0.25,0.3,0.35,0.4,0.5,0.6').split(',').map(Number)
const LIMIT = Math.max(1, Number(process.env.LIMIT || 1))
const PICTURES = (process.env.PICTURES || '').split(',').filter(Boolean)
const BEST = Number(process.env.BEST || 0.4)
const FIT = process.env.FIT !== '0'
const GROUND = [128, 128, 128]

const wasm = readFileSync(process.env.MT_TEXT_WASM || resolve(here, '../js/generated/mt_text.wasm'))
const { createRustTextEngine } = await import('../../src/lib/text-engine/rust.js')
const rust = await createRustTextEngine(wasm, { rules: { boldAdvance: 'webkit' } })
const list = JSON.parse(readFileSync(resolve(DATA, 'fonts/fonts.json')))
for (const f of list.fonts) {
  const path = resolve(DATA, 'fonts', f.file)
  GlobalFonts.registerFromPath(path, f.family)
  rust.addFace(f.family, f.slot, readFileSync(path))
}
const store = await import('../../src/lib/store.svelte.js')
const measure = await import('../../src/lib/measure.js')
const seam = await import('../../src/lib/text-engine/index.js')
seam.setTextEngine(rust)
const { createRustGlyphPainter } = await import('../../src/lib/text-engine/rust-painter.js')
const contain = await import('../../src/lib/contain.js')
const exporter = await import('../../src/lib/exporter.js')
const solver = await import('../../src/lib/auto-layout.js')
const { prepareFonts } = await import('../../src/test/text-port/fonts.js')
const { probe } = await import('../../src/test/text-port/probe.js')
const families = prepareFonts(store, list)
const modules = { ...measure, ...contain, ...exporter, ...solver, fontByName: store.fontByName }
measure.clearLayoutMemo()

const painters = new Map()
function painterFor(weight) {
  if (!painters.has(weight)) painters.set(weight, createRustGlyphPainter(rust, { weight }))
  return painters.get(weight)
}

/** The box painted with glyphs `weight` device pixels heavier: `{ data, w, h, ox, oy, ss }`. */
function paintBox(c, weight) {
  seam.setGlyphPainter(painterFor(weight))
  for (const result of probe(modules, 'pixels', [c], { families, plain: true })) {
    const r = result.record
    if (r.error || r.skip || !result.canvas) return null
    const { canvas } = result
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    const out = { data: image.data, w: canvas.width, h: canvas.height, ox: r.ox, oy: r.oy, ss: r.ss }
    canvas.width = 0
    canvas.height = 0
    return out
  }
  return null
}

const refRows = new Map(
  readFileSync(resolve(DATA, 'runs/ref-wk/base/pixels.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => {
    const r = JSON.parse(l)
    return [r.id, r]
  }),
)
async function refPicture(id) {
  const r = refRows.get(id)
  if (!r?.png) return null
  const img = await loadImage(resolve(DATA, 'runs/ref-wk/base', r.png))
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height, ox: r.ox, oy: r.oy, ss: r.ss }
}

function kindOf(style) {
  const s = style
  const off = !s.gradient?.on && !s.pattern?.on && !(s.shadows?.length) && !s.blur && !s.motionBlur?.on && !s.path?.on
    && !s.clip?.on && !s.circle?.on && !s.roughen?.on && !s.curve && !s.rotation && !s.flipH && !s.flipV
    && !s.bold && !s.italic && (s.opacity ?? 1) === 1
  if (!off) return 'other'
  const bands = (s.strokes || []).filter((b) => b.width > 0 && b.opacity > 0)
  return bands.length ? 'banded' : 'plain'
}

/**
 * Both pictures on one grid: the engine's moved so that the boxes' own
 * origins agree (`ox`, `oy` are the box's corner inside each picture).
 */
function frame(a, b) {
  const ax = Math.round(a.ox * a.ss), ay = Math.round(a.oy * a.ss)
  const bx = Math.round(b.ox * b.ss), by = Math.round(b.oy * b.ss)
  const left = Math.max(ax, bx), top = Math.max(ay, by)
  const w = left + Math.max(a.w - ax, b.w - bx), h = top + Math.max(a.h - ay, b.h - by)
  return { w, h, a: { dx: left - ax, dy: top - ay }, b: { dx: left - bx, dy: top - by } }
}
function placed(p, f, at) {
  const out = new Uint8ClampedArray(f.w * f.h * 4)
  for (let y = 0; y < p.h; y++) {
    const ty = y + at.dy
    if (ty < 0 || ty >= f.h) continue
    const row = p.data.subarray(y * p.w * 4, (y + 1) * p.w * 4)
    const tx = at.dx
    const from = Math.max(0, -tx), to = Math.min(p.w, f.w - tx)
    if (to > from) out.set(row.subarray(from * 4, to * 4), (ty * f.w + tx + from) * 4)
  }
  return out
}
function inkBox(d, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

/** The engine's picture `A` moved by `(mx, my)` against Safari's `B`, over `box`. */
function compare(A, B, w, h, box, mx, my, full) {
  let abs = 0, n = 0, inter = 0, union = 0, inkA = 0, inkB = 0, colour = 0, lost = 0, solid = 0
  for (let y = box.y0; y < box.y1; y++) {
    const sy = y - my
    for (let x = box.x0; x < box.x1; x++) {
      const sx = x - mx
      const i = (y * w + x) * 4
      const inside = sx >= 0 && sy >= 0 && sx < w && sy < h
      const j = (sy * w + sx) * 4
      const a = inside ? A[j + 3] : 0
      const b = B[i + 3]
      if (!a && !b) continue
      n++
      abs += a > b ? a - b : b - a
      if (!full) continue
      inkA += a
      inkB += b
      const am = a >= 128, bm = b >= 128
      if (am && bm) inter++
      if (am || bm) union++
      if (bm) {
        solid++
        if (a < 64) lost++
      }
      for (let k = 0; k < 3; k++) {
        const ca = (inside ? A[j + k] : 0) * a + GROUND[k] * (255 - a)
        const cb = B[i + k] * b + GROUND[k] * (255 - b)
        colour += Math.abs(ca - cb) / 255
      }
    }
  }
  return { abs, n, alpha: n ? abs / n : 0, overlap: union ? inter / union : 1, colour: n ? colour / (3 * n) : 0, inkA, inkB, lost, solid }
}

function bestMove(A, B, w, h, box) {
  let best = null
  for (let my = -2; my <= 2; my++) for (let mx = -2; mx <= 2; mx++) {
    const r = compare(A, B, w, h, box, mx, my, false)
    if (!best || r.abs < best.abs) best = { mx, my, abs: r.abs }
  }
  return best
}

function grown(box, by, w, h) {
  return { x0: Math.max(0, box.x0 - by), y0: Math.max(0, box.y0 - by), x1: Math.min(w, box.x1 + by), y1: Math.min(h, box.y1 + by) }
}

const cases = JSON.parse(readFileSync(resolve(DATA, 'corpus/pixels.json'))).cases
  .filter((c) => (c.id.startsWith('c.') || c.id.startsWith('p.base.')) && !(c.tags || []).includes('uncovered') && c.via !== 'layer')
await exporter.settleNoise(cases.map((c) => c.box))

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-')

if (FIT) {
  const rows = []
  const picked = cases.filter((c) => kindOf(c.box.style) !== 'other').filter((_, i) => i % LIMIT === 0)
  let done = 0
  for (const c of picked) {
    const ref = await refPicture(c.id)
    const first = ref && paintBox(c, WEIGHTS[0])
    if (!first) continue
    const f = frame(first, ref)
    const B = placed(ref, f, f.b)
    const refBox = inkBox(B, f.w, f.h)
    if (!refBox) continue
    const box = grown(refBox, 6, f.w, f.h)
    const kind = (c.id.startsWith('c.') ? '' : 'made-up ') + kindOf(c.box.style)
    const row = { id: c.id, font: c.box.style.font, size: c.box.style.size, ss: first.ss, kind, fits: [] }
    let move = null
    for (const weight of WEIGHTS) {
      const p = weight === WEIGHTS[0] ? first : paintBox(c, weight)
      const A = placed(p, f, f.a)
      move ??= bestMove(A, B, f.w, f.h, box)
      const r = compare(A, B, f.w, f.h, box, move.mx, move.my, true)
      row.fits.push({ weight, alpha: r.alpha, overlap: r.overlap, colour: r.colour, inkA: r.inkA, inkB: r.inkB, lost: r.lost, solid: r.solid })
    }
    row.move = [move.mx, move.my]
    rows.push(row)
    if (++done % 200 === 0) console.error(`${done} / ${picked.length}`)
  }
  writeFileSync(resolve(OUT, 'fit.json'), JSON.stringify({ weights: WEIGHTS, rows }) + '\n')
  report(rows)
}

/** The weight at the bottom of a parabola through the best sample and its neighbours. */
function bottom(fits, key) {
  let k = 0
  for (let i = 1; i < fits.length; i++) if (fits[i][key] < fits[k][key]) k = i
  if (k === 0 || k === fits.length - 1) return fits[k].weight
  const [x0, x1, x2] = [fits[k - 1].weight, fits[k].weight, fits[k + 1].weight]
  const [y0, y1, y2] = [fits[k - 1][key], fits[k][key], fits[k + 1][key]]
  // The slopes of the two chords, and where the line through them is zero.
  const [s0, s1] = [(y1 - y0) / (x1 - x0), (y2 - y1) / (x2 - x1)]
  if (!(s1 > s0)) return x1
  const [m0, m1] = [(x0 + x1) / 2, (x1 + x2) / 2]
  return Math.min(x2, Math.max(x0, m0 - (s0 * (m1 - m0)) / (s1 - s0)))
}
function quantile(sorted, q) {
  if (!sorted.length) return NaN
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function table(title, rows) {
  if (!rows.length) return
  console.log(`\n${title}: ${rows.length} boxes`)
  console.log('| weight (device px) | alpha diff | overlap | colour diff | ink, engine / Safari | lost per 1000 |')
  console.log('|---|---|---|---|---|---|')
  WEIGHTS.forEach((weight, k) => {
    const mean = (key) => rows.reduce((s, r) => s + r.fits[k][key], 0) / rows.length
    const sum = (key) => rows.reduce((s, r) => s + r.fits[k][key], 0)
    console.log(`| ${weight} | ${fmt(mean('alpha'))} | ${fmt(mean('overlap'), 4)} | ${fmt(mean('colour'))} | ${fmt(sum('inkA') / sum('inkB'), 4)} | ${fmt((1000 * sum('lost')) / Math.max(1, sum('solid')))} |`)
  })
  for (const key of ['alpha', 'colour']) {
    const best = rows.map((r) => bottom(r.fits, key)).sort((a, b) => a - b)
    console.log(`best weight per box by ${key}: median ${fmt(quantile(best, 0.5))}, quartiles ${fmt(quantile(best, 0.25))} to ${fmt(quantile(best, 0.75))}, tenths ${fmt(quantile(best, 0.1))} to ${fmt(quantile(best, 0.9))}`)
  }
}

function report(rows) {
  const device = (r) => r.size * r.ss
  const sizes = [['text under 25 px', 0, 25], ['25 to 40 px', 25, 40], ['40 to 60 px', 40, 60], ['60 px and over', 60, Infinity]]
  // A box the two lay out differently (another break, another line) says
  // nothing about the weight of a glyph: left out, and counted.
  const apart = rows.filter((r) => r.fits[0].overlap < 0.5)
  rows = rows.filter((r) => r.fits[0].overlap >= 0.5)
  console.log(`${rows.length} boxes fitted; ${apart.length} left out, laid out differently (overlap under 0.5 at the first weight)`)
  for (const kind of ['plain', 'banded', 'made-up plain']) {
    const of = rows.filter((r) => r.kind === kind)
    table(`${kind}, all sizes`, of)
    for (const [name, lo, hi] of sizes) table(`${kind}, ${name} (${lo * 2} to ${hi * 2} device px at 2x)`, of.filter((r) => r.size >= lo && r.size < hi))
  }
  // Does one weight serve every size? The best weight per box, by the size
  // of the text in device pixels: by alpha for bare text, by colour for
  // text with a band (a band hides the fill's edge from the alpha).
  console.log('\nbest weight per box by size (median, quartiles; boxes)')
  console.log('| text size, device px | plain | made-up plain | banded |')
  console.log('|---|---|---|---|')
  const steps = [0, 30, 40, 50, 60, 70, 80, 100, 120, Infinity]
  for (let k = 0; k + 1 < steps.length; k++) {
    const cell = (kind, key) => {
      const best = rows.filter((r) => r.kind === kind && device(r) >= steps[k] && device(r) < steps[k + 1]).map((r) => bottom(r.fits, key)).sort((a, b) => a - b)
      return best.length ? `${fmt(quantile(best, 0.5))}, ${fmt(quantile(best, 0.25))} to ${fmt(quantile(best, 0.75))}; ${best.length}` : ''
    }
    console.log(`| ${steps[k]} to ${steps[k + 1] === Infinity ? 'up' : steps[k + 1]} | ${cell('plain', 'alpha')} | ${cell('made-up plain', 'alpha')} | ${cell('banded', 'colour')} |`)
  }
  const fonts = new Map()
  for (const r of rows) fonts.set(r.font, (fonts.get(r.font) || 0) + 1)
  console.log('\nbest weight per box by font (median by alpha / by colour; boxes; median size in device px)')
  for (const [font, n] of [...fonts].sort((a, b) => b[1] - a[1])) {
    const of = rows.filter((r) => r.font === font)
    const med = (key) => quantile(of.map((r) => bottom(r.fits, key)).sort((a, b) => a - b), 0.5)
    const size = quantile(of.map(device).sort((a, b) => a - b), 0.5)
    console.log(`  ${font}: ${fmt(med('alpha'))} / ${fmt(med('colour'))}; ${n}; ${fmt(size, 0)}`)
  }
  table('YourHighschoolCrush only', rows.filter((r) => r.font === 'YourHighschoolCrush'))
}

// Pictures: Safari, the engine at weight 0, the engine at BEST, on mid grey;
// each box whole at the capture's own scale and a crop enlarged three times.
function onGround(p) {
  const canvas = createCanvas(p.w, p.h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = `rgb(${GROUND.join(',')})`
  ctx.fillRect(0, 0, p.w, p.h)
  const ink = createCanvas(p.w, p.h)
  ink.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.data), p.w, p.h), 0, 0)
  ctx.drawImage(ink, 0, 0)
  return canvas
}
function sheet(panels, labels, scale, crop) {
  const gap = 12, top = 34
  const w = crop.w * scale, h = crop.h * scale
  const canvas = createCanvas(panels.length * w + (panels.length + 1) * gap, h + top + gap)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#000000'
  ctx.font = '18px sans-serif'
  panels.forEach((p, k) => {
    const x = gap + k * (w + gap)
    ctx.fillText(labels[k], x, 23)
    ctx.drawImage(p, crop.x, crop.y, crop.w, crop.h, x, top, w, h)
  })
  return canvas
}
/** The `cw` by `ch` window of the picture with the most of Safari's ink edge in it. */
function busiest(B, w, h, cw, ch) {
  cw = Math.min(cw, w)
  ch = Math.min(ch, h)
  let best = { x: 0, y: 0, score: -1 }
  for (let y = 0; y + ch <= h; y += 8) for (let x = 0; x + cw <= w; x += 8) {
    let score = 0
    for (let yy = y; yy < y + ch; yy += 2) for (let xx = x; xx < x + cw; xx += 2) {
      const a = B[(yy * w + xx) * 4 + 3]
      if (a > 0 && a < 255) score++
    }
    if (score > best.score) best = { x, y, score }
  }
  return { x: best.x, y: best.y, w: cw, h: ch }
}

for (const id of PICTURES) {
  const c = cases.find((k) => k.id === id)
  const ref = c && await refPicture(id)
  const zero = ref && paintBox(c, 0)
  const heavy = zero && paintBox(c, BEST)
  if (!heavy) {
    console.error(`no picture for ${id}`)
    continue
  }
  const f = frame(zero, ref)
  const whole = (data) => ({ data, w: f.w, h: f.h })
  const B = placed(ref, f, f.b)
  const A0 = placed(zero, f, f.a)
  const A1 = placed(heavy, f, f.a)
  const panels = [whole(B), whole(A0), whole(A1)].map(onGround)
  const labels = ['Safari today', 'engine, weight 0', `engine, weight ${BEST} device px`]
  const s = c.box.style
  const name = `${id}`
  writeFileSync(resolve(OUT, `${name}.png`), sheet(panels, labels, 1, { x: 0, y: 0, w: f.w, h: f.h }).toBuffer('image/png'))
  const crop = busiest(B, f.w, f.h, 240, 150)
  writeFileSync(resolve(OUT, `${name}.x3.png`), sheet(panels, labels, 3, crop).toBuffer('image/png'))
  console.log(`${id}: ${s.font} ${s.size} px, ${kindOf(s)}, ${f.w} x ${f.h} at ${zero.ss}x -> ${resolve(OUT, name)}.png and .x3.png`)
}
