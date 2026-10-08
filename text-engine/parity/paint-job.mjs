// The Rust painter against today's painter, feature by feature.
//
//   npm run build:engine
//   ./node_modules/.bin/vite-node text-engine/parity/paint-job.mjs
//
// It runs under vite-node, not plain node, because the jobs are the app's
// own: each case is a box and a style handed to `renderBoxTexture` in
// src/lib/exporter.js, with a glyph painter installed that keeps the job it
// is given. So the layout, the wrapping, `glyphJob` and `runFill` are the
// app's, through the realfont lane's setup (src/test/real-fonts.js: the
// fixture fonts registered with @napi-rs/canvas, and a `document` that makes
// canvases). Nothing here builds a job by hand except the cost block at the
// end, which is the block of SPIKE.md section 8.
//
// Each job is painted by both painters at the same transform:
//
//   canvas   `createBrowserGlyphPainter().paint(ctx, job)` on an
//            @napi-rs/canvas (Skia) context
//   engine   `paintJob` from ../js/paint.mjs, placed at the origin it returns
//
// and the canvas side is painted a second time as a check on what the first
// comparison can show. Skia fills text of ordinary sizes from glyph masks,
// and a glyph mask is not the glyph's outline: its coverage is bent by the
// fill's colour (black text is thinned, white text is thickened), and along
// a pixel row it sits on whole device pixels. Both are measured in
// P5A-REPORT.md. Above about 256 device px a glyph Skia draws the outline
// itself. So:
//
//   as drawn   the canvas at the job's transform: what the app shows today
//   outlines   the canvas at K times the transform, averaged down K x K to
//              one, with K large enough that a glyph is 448 device px or
//              more: the same drawing calls, with Skia's outlines for glyphs
//
// The engine is compared with both:
//
//   ink box    box of every pixel with any alpha, engine minus canvas, device
//              px (x0 y0 x1 y1; negative x0/y0 and positive x1/y1 mean the
//              engine's ink reaches further)
//   overlap    intersection over union of the two `alpha >= 128` masks
//   alpha      mean |alpha difference| over pixels either side inks, in levels
//              of 255
//   colour     mean and worst |difference| of a colour channel over pixels
//              both sides paint opaque (alpha >= 250): what the alpha columns
//              cannot see of a gradient or a pattern
//   thickness  twice the largest value of the Euclidean distance transform of
//              the XOR of the two masks, device px. The distance is from a
//              pixel's centre to the nearest pixel centre outside the XOR, so
//              a line of disagreement one pixel wide reads 2 and no
//              disagreement reads 0.
//
// Skia's baseline slip (SPIKE.md rule 7) is removed first. Skia lays a line
// out with its ascent rounded to a whole px, so its baseline is
// `round(ascent) - ascent` below the y it is given, in the job's own units.
// Skia cannot be asked to do otherwise, so the slip is removed on the other
// side: the engine is handed each run at the baseline Skia uses. For the
// "as drawn" comparison there is a second slip to remove, which rule 7 does
// not state: a glyph mask along a pixel row is put on a whole device pixel
// (`skiaBaseline` below), so every line is off by an amount of its own. The
// fills are never moved; the canvas does not move them either.
// `--keep-slip` hands the engine the job as it is, to see what the slip is
// worth.
//
// One PNG per case goes to js/generated/paint/job-<case>.png, four panels on
// grey: the canvas as drawn, the engine, the difference from the canvas as
// drawn, the difference from Skia's outlines. In a difference, red is alpha
// only the engine has, blue alpha only the canvas has, green a colour
// difference where both have ink.
import '../../src/test/real-fonts.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, DOMMatrix, ImageData } from '@napi-rs/canvas'
import { createEngine } from '../js/engine.mjs'
import { paintJob } from '../js/paint.mjs'
import { FONTS, wasmPath, fmt } from './common.mjs'

globalThis.DOMMatrix = DOMMatrix
const { renderBoxTexture } = await import('../../src/lib/exporter.js')
const { glyphPainter, setGlyphPainter } = await import('../../src/lib/text-engine/index.js')
const { createBrowserGlyphPainter } = await import('../../src/lib/text-engine/browser-painter.js')
const { defaultStyle, PATTERN_KINDS } = await import('../../src/lib/data.js')
const { setTypesetEnabled } = await import('../../src/lib/measure.js')
const { app } = await import('../../src/lib/store.svelte.js')
const { systemFontEntry } = await import('../../src/lib/fonts.js')
// DejaVu Sans is not one of the app's built-in fonts: it goes in the way an
// installed font does, as the realfont tests put it in.
app.fonts.system = [systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } })]
const { patternTileCanvas, TILE_SS } = await import('../../src/lib/text-paint.js')
setTypesetEnabled(true)

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../js/generated/paint')
mkdirSync(outDir, { recursive: true })
const KEEP_SLIP = process.argv.includes('--keep-slip')
const ONLY = process.env.ONLY

const engine = await createEngine(readFileSync(wasmPath))
const fontId = Object.fromEntries(FONTS.map((f) => [f.key, engine.addFont(readFileSync(f.path))]))
// The faces the realfont lane registers. A style the family has no file for
// is synthesised, by Skia on the canvas side and by the engine on the other.
function fontFor(face) {
  if (face.name === 'DejaVu Sans') {
    return face.italic
      ? { font: fontId['DejaVuSans-Oblique'], synth: { bold: face.bold } }
      : { font: fontId.DejaVuSans, synth: { bold: face.bold } }
  }
  const key = face.name === 'Bangers' ? 'Bangers' : 'ComicNeue'
  return { font: fontId[key], synth: { bold: face.bold, italic: face.italic } }
}

// The app's own jobs for a box: every job its exporter hands the painter,
// the silhouette a shadow is cast from included.
const appPainter = glyphPainter()
function jobsFor(box) {
  const jobs = []
  setGlyphPainter({ paint: (_ctx, job) => jobs.push(job) })
  try {
    const tex = renderBoxTexture(box, { lines: [] })
    return { jobs, tex }
  } finally {
    setGlyphPainter(appPainter)
  }
}

const tileCache = new Map()
function tiles(fill) {
  const key = JSON.stringify(fill.style)
  if (!tileCache.has(key)) {
    const c = patternTileCanvas(fill.style, TILE_SS)
    const d = c ? c.getContext('2d').getImageData(0, 0, c.width, c.height) : null
    tileCache.set(key, d && { width: d.width, height: d.height, data: d.data })
  }
  return tileCache.get(key)
}

const browserPainter = createBrowserGlyphPainter()
const probe = createCanvas(8, 8).getContext('2d')
/**
 * The job with every run at the baseline Skia draws it on under `m`.
 *
 * Rule 7: in the job's own units Skia's alphabetic baseline is
 * `y - ascent + round(ascent)`. With `masks`, and a transform that keeps the
 * baseline along a pixel row, that is then rounded to a whole device pixel,
 * which is where a glyph mask goes.
 *
 * A curved run is drawn from the `middle` baseline. There Skia puts the
 * alphabetic baseline `ascent - round(ascent + descent) / 2` below the
 * middle line (rule 4 of SPIKE.md, where the engine keeps `(ascent -
 * descent) / 2` on purpose) and then slips it by rule 7 as well: with both
 * removed the two painters agree to 0.999 overlap on an arc, with rule 4
 * alone to 0.961. The run is moved along its own down direction.
 */
function skiaBaseline(job, m, masks) {
  if (KEEP_SLIP) return job
  probe.font = job.face.key
  probe.textBaseline = 'alphabetic'
  const box = probe.measureText('H')
  const [asc, desc] = [box.fontBoundingBoxAscent, box.fontBoundingBoxDescent]
  if (job.curved) {
    const d = (asc + desc) / 2 - Math.round(asc + desc) / 2 + Math.round(asc) - asc
    return { ...job, runs: job.runs.map((run) => ({ ...run, x: run.x - d * Math.sin(run.rot), y: run.y + d * Math.cos(run.rot) })) }
  }
  const slip = Math.round(asc) - asc
  const alongRows = masks && m[1] === 0 && m[2] === 0 && m[3] > 0
  const runs = job.runs.map((run) => {
    let y = run.y + slip
    if (alongRows) y = (Math.round(y * m[3] + m[5]) - m[5]) / m[3]
    return { ...run, y }
  })
  return { ...job, runs }
}

/**
 * The canvas painter's picture of `job` under `m`, W x H, straight RGBA8.
 * With `k` above 1 it is painted at k times the transform and averaged down
 * (premultiplied, as a compositor would).
 */
function paintCanvas(job, m, W, H, k = 1) {
  const canvas = createCanvas(W * k, H * k)
  const ctx = canvas.getContext('2d')
  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W * k, H * k)
    ctx.setTransform(...m.map((v) => v * k))
    browserPainter.paint(ctx, job)
  }
  draw()
  const big = ctx.getImageData(0, 0, W * k, H * k).data
  if (k === 1) return { data: big, draw, ctx }
  const sum = new Float64Array(W * H * 4)
  for (let y = 0; y < H * k; y++) {
    const row = ((y / k) | 0) * W
    for (let x = 0; x < W * k; x++) {
      const s = (y * W * k + x) * 4
      const a = big[s + 3]
      if (a === 0) continue
      const d = (row + ((x / k) | 0)) * 4
      sum[d] += big[s] * a
      sum[d + 1] += big[s + 1] * a
      sum[d + 2] += big[s + 2] * a
      sum[d + 3] += a
    }
  }
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H * 4; i += 4) {
    const a = sum[i + 3]
    if (a === 0) continue
    data[i] = Math.round(sum[i] / a)
    data[i + 1] = Math.round(sum[i + 1] / a)
    data[i + 2] = Math.round(sum[i + 2] / a)
    data[i + 3] = Math.round(a / (k * k))
  }
  return { data }
}

function paintEngine(job, m, W, H, masks) {
  const moved = skiaBaseline(job, m, masks)
  const request = { job: moved, ...fontFor(job.face), transform: m, tiles }
  const r = paintJob(engine, request)
  // Largest distance a run was moved, device px.
  const scaleY = Math.hypot(m[2], m[3])
  const slip = Math.max(0, ...job.runs.map((run, i) => Math.hypot(moved.runs[i].y - run.y, moved.runs[i].x - run.x) * scaleY))
  const data = new Uint8ClampedArray(W * H * 4)
  if (r) {
    for (let y = 0; y < r.height; y++) {
      const Y = y + r.y
      if (Y < 0 || Y >= H) continue
      for (let x = 0; x < r.width; x++) {
        const X = x + r.x
        if (X < 0 || X >= W) continue
        const s = (y * r.width + x) * 4
        data.set(r.data.subarray(s, s + 4), (Y * W + X) * 4)
      }
    }
  }
  return { data, raster: r, request, slip }
}

function inkBox(data, W, H, threshold) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] >= threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return [x0, y0, x1 + 1, y1 + 1]
}

// Squared Euclidean distance transform (Felzenszwalb and Huttenlocher): for
// every pixel in `set`, the distance to the nearest pixel outside it.
function maxDistance(set, W, H) {
  const INF = 1e20
  const grid = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) grid[i] = set[i] ? INF : 0
  const n = Math.max(W, H)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const pass = (len) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < len; q++) {
      let s
      do {
        const p = v[k]
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p)
      } while (s <= z[k] && --k >= 0)
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++
      const p = v[k]
      d[q] = (q - p) * (q - p) + f[p]
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x]
    pass(H)
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y]
  }
  let worst = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = grid[y * W + x]
    pass(W)
    for (let x = 0; x < W; x++) if (d[x] > worst) worst = d[x]
  }
  // A set that reaches the canvas edge everywhere has no outside: not a case
  // these pictures have, but a distance of 1e10 would be a lie.
  return worst >= INF ? Infinity : Math.sqrt(worst)
}

function compare(a, b, W, H) {
  const any = [inkBox(a, W, H, 1), inkBox(b, W, H, 1)]
  const xor = new Uint8Array(W * H)
  let inter = 0, union = 0, sumAbs = 0, n = 0, colourSum = 0, colourMax = 0, colourN = 0
  const levels = [new Set(), new Set()]
  for (let i = 0; i < W * H; i++) {
    const [pa, pb] = [a[i * 4 + 3], b[i * 4 + 3]]
    levels[0].add(pa)
    levels[1].add(pb)
    const [ia, ib] = [pa >= 128, pb >= 128]
    if (ia && ib) inter++
    if (ia || ib) union++
    if (ia !== ib) xor[i] = 1
    if (pa || pb) {
      sumAbs += Math.abs(pa - pb)
      n++
    }
    if (pa >= 250 && pb >= 250) {
      for (let c = 0; c < 3; c++) {
        const dc = Math.abs(a[i * 4 + c] - b[i * 4 + c])
        colourSum += dc
        if (dc > colourMax) colourMax = dc
      }
      colourN += 3
    }
  }
  return {
    box: any[0].map((v, i) => v - any[1][i]),
    engineBox: any[0],
    canvasBox: any[1],
    overlap: union ? inter / union : 1,
    alpha: n ? sumAbs / n : 0,
    colourMean: colourN ? colourSum / colourN : 0,
    colourMax,
    thickness: 2 * maxDistance(xor, W, H),
    levels: levels.map((s) => s.size),
  }
}

function difference(engineData, canvasData, W, H) {
  const diff = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const [pa, pb] = [engineData[i * 4 + 3], canvasData[i * 4 + 3]]
    let colour = 0
    if (pa && pb) {
      for (let c = 0; c < 3; c++) colour = Math.max(colour, Math.abs(engineData[i * 4 + c] - canvasData[i * 4 + c]))
      colour = (colour * Math.min(pa, pb)) / 255
    }
    diff.set([Math.max(0, pa - pb), colour, Math.max(0, pb - pa), 255], i * 4)
  }
  return diff
}

function savePng(name, panels, W, H) {
  const gap = 8
  const out = createCanvas(W * panels.length + gap * (panels.length - 1), H)
  const ctx = out.getContext('2d')
  ctx.fillStyle = '#8a8f98'
  ctx.fillRect(0, 0, out.width, out.height)
  panels.forEach((data, i) => {
    const c = createCanvas(W, H)
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0)
    ctx.drawImage(c, i * (W + gap), 0)
  })
  writeFileSync(resolve(outDir, name), out.toBuffer('image/png'))
}

const TEXT = 'WHAT THE HELL ARE YOU DOING?! office waffle Ty.'
const base = (over = {}) => ({ ...defaultStyle(), size: 28, strokes: [], ...over })
const white = (width, opacity = 1) => ({ color: '#ffffff', width, opacity })
const ink = (width, opacity = 1) => ({ color: '#1d3557', width, opacity })
const red = (width, opacity = 1) => ({ color: '#e63946', width, opacity })
const ramp = (over = {}) => ({
  on: true, kind: 'linear', angle: 180, cx: 0.5, cy: 0.5, radius: 1, scope: 'box',
  stops: [{ color: '#ffd166', pos: 0, opacity: 1 }, { color: '#ef476f', pos: 0.5, opacity: 1 }, { color: '#073b4c', pos: 1, opacity: 1 }],
  ...over,
})

// name, style, and optionally: text, box size, which job of the box (the
// silhouette is the first of two), the transform.
const CASES = [
  ['solid, Comic Neue', base()],
  ['solid, Bangers', base({ font: 'Bangers' })],
  ['solid, DejaVu Sans', base({ font: 'DejaVu Sans', size: 22 })],
  ['solid, DejaVu Sans, its own oblique face', base({ font: 'DejaVu Sans', size: 22, italic: true })],
  ['solid, 12 px at 1x', base({ size: 12 }), { scale: 1, w: 120, h: 70 }],
  ['one band', base({ strokes: [red(3)] })],
  ['two bands', base({ strokes: [white(2), ink(3)] })],
  ['three bands', base({ strokes: [white(1.5), red(2), ink(2.5)] })],
  ['band at half opacity', base({ strokes: [red(4, 0.5)] })],
  ['two bands at half opacity', base({ strokes: [white(2, 0.5), ink(3, 0.5)] })],
  ['hairline band, 0.5 px', base({ strokes: [ink(0.25)], color: '#ffffff' })],
  ['linear gradient, 180 deg', base({ gradient: ramp(), strokes: [ink(2)] })],
  ['linear gradient, 90 deg', base({ gradient: ramp({ angle: 90 }) })],
  ['linear gradient, 35 deg', base({ gradient: ramp({ angle: 35 }) })],
  ['gradient with a transparent stop', base({ gradient: ramp({ stops: [{ color: '#e63946', pos: 0, opacity: 1 }, { color: '#1d3557', pos: 1, opacity: 0.15 }] }) })],
  ['radial gradient', base({ gradient: ramp({ kind: 'radial' }) })],
  ['radial gradient, off centre', base({ gradient: ramp({ kind: 'radial', cx: 0.2, cy: 0.8, radius: 0.6 }) })],
  ['gradient per line', base({ gradient: ramp({ scope: 'line' }), strokes: [ink(2)] })],
  ...PATTERN_KINDS.map((kind) => [`pattern, ${kind}`, base({ size: 34, font: 'Bangers', pattern: { on: true, kind, fg: '#1d3557', bg: '#ffd166', scale: 1 } })]),
  ['pattern, dots, scale 0.25', base({ size: 34, font: 'Bangers', pattern: { on: true, kind: 'dots', fg: '#1d3557', bg: '#ffd166', scale: 0.25 } })],
  ['pattern, checker, 1x', base({ size: 34, font: 'Bangers', pattern: { on: true, kind: 'checker', fg: '#1d3557', bg: '#ffd166', scale: 1 } }), { scale: 1 }],
  ['curved, arc', base({ curve: 60, strokes: [white(2)] }), { text: 'CURVED TEXT HERE', w: 300, h: 160 }],
  ['curved, arc, gradient', base({ curve: -60, gradient: ramp({ angle: 90 }), strokes: [ink(2)] }), { text: 'CURVED TEXT HERE', w: 300, h: 160 }],
  ['curved, circle, pattern', base({ circle: { on: true, angle: 0, inside: false, r: 0 }, pattern: { on: true, kind: 'stripes', fg: '#1d3557', bg: '#ffd166', scale: 1 } }), { text: 'ROUND AND ROUND IT GOES ', w: 260, h: 260 }],
  ['silhouette, two bands', base({ strokes: [white(2), ink(3)], shadows: [{ color: '#444444', x: 3, y: 3, blur: 0, opacity: 1 }] }), { job: 0 }],
  ['silhouette, curved', base({ curve: 60, strokes: [white(2)], shadows: [{ color: '#444444', x: 3, y: 3, blur: 0, opacity: 1 }] }), { job: 0, text: 'CURVED TEXT HERE', w: 300, h: 160 }],
  ['letter spacing, +4 px', base({ letterSpacing: 4, strokes: [red(2)] }), { w: 320 }],
  ['letter spacing, -1.5 px', base({ letterSpacing: -1.5 })],
  ['letter spacing, +4 px, right', base({ letterSpacing: 4, align: 'right' }), { w: 320 }],
  ['align left', base({ align: 'left' })],
  ['align center', base({ align: 'center' })],
  ['align right', base({ align: 'right' })],
  ['synthetic bold', base({ bold: true })],
  ['synthetic bold, one band', base({ bold: true, strokes: [red(3)] })],
  ['synthetic italic', base({ italic: true })],
  ['synthetic bold italic', base({ bold: true, italic: true })],
  ['synthetic bold, 12 px', base({ bold: true, size: 12 }), { w: 120, h: 70 }],
  // At 36 px and above Skia emboldens a glyph mask and a glyph outline by the
  // same amount (see the report); below, the outline reference is too thin.
  ['synthetic bold, 40 px', base({ bold: true, size: 40 }), { w: 380, h: 200 }],
  ['synthetic bold italic, 40 px, one band', base({ bold: true, italic: true, size: 40, strokes: [red(3)] }), { w: 380, h: 200 }],
  ['rotated transform, 17 deg', base({ strokes: [white(2), ink(3)], gradient: ramp() }), { rotate: 17 }],
  ['rotated transform, -90 deg', base({ strokes: [red(3)] }), { rotate: -90 }],
  ['mirrored transform', base({ strokes: [red(3)], gradient: ramp({ angle: 90 }) }), { mirror: true }],
  ['scale 3.3, off grid', base({ strokes: [white(2), ink(3)] }), { scale: 3.3, shift: [0.37, 0.61] }],
]

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const median = (v) => [...v].sort((a, b) => a - b)[v.length >> 1]
const now = () => performance.now()

const rows = []
for (const [name, style, opt = {}] of CASES) {
  if (ONLY && !name.includes(ONLY)) continue
  const box = { x: 0, y: 0, w: opt.w ?? 260, h: opt.h ?? 150, text: opt.text ?? TEXT, style }
  const { jobs, tex } = jobsFor(box)
  const job = jobs[opt.job ?? jobs.length - 1]
  const scale = opt.scale ?? 2
  let [W, H] = [Math.ceil(tex.cw * scale), Math.ceil(tex.ch * scale)]
  let m = [scale, 0, 0, scale, ...(opt.shift ?? [0, 0])]
  if (opt.rotate) {
    // About the footprint's centre, on a canvas large enough for any angle.
    const side = Math.ceil(Math.hypot(W, H)) + 8
    const t = (opt.rotate * Math.PI) / 180
    const [c, s] = [Math.cos(t), Math.sin(t)]
    const [cx, cy] = [tex.cw / 2, tex.ch / 2]
    m = [scale * c, scale * s, -scale * s, scale * c, side / 2 - scale * (c * cx - s * cy), side / 2 - scale * (s * cx + c * cy)]
    W = H = side
  }
  if (opt.mirror) m = [-scale, 0, 0, scale, W, 0]
  const cv = paintCanvas(job, m, W, H)
  const en = paintEngine(job, m, W, H, true)
  const drawn = compare(en.data, cv.data, W, H)
  // Skia's outlines: K so that a glyph is 448 device px or more.
  const K = Math.max(2, Math.ceil(448 / (job.face.size * scale)))
  const ref = paintCanvas(job, m, W, H, K)
  const en2 = paintEngine(job, m, W, H, false)
  const outline = compare(en2.data, ref.data, W, H)
  savePng(`job-${slug(name)}.png`, [cv.data, en.data, difference(en.data, cv.data, W, H), difference(en2.data, ref.data, W, H)], W, H)
  const tEngine = []
  const tCanvas = []
  for (let i = 0; i < 15; i++) {
    let t = now()
    paintJob(engine, { ...en.request, view: true })
    tEngine.push(now() - t)
    t = now()
    cv.draw()
    cv.ctx.getImageData(0, 0, 1, 1)
    tCanvas.push(now() - t)
  }
  rows.push({
    name,
    jobs: jobs.length,
    runs: job.runs.length,
    canvasSize: [W, H],
    raster: en.raster && [en.raster.width, en.raster.height],
    slip: en.slip,
    K,
    drawn,
    outline,
    msEngine: [Math.min(...tEngine), median(tEngine)],
    msCanvas: [Math.min(...tCanvas), median(tCanvas)],
  })
}

const cells = (r) => `${r.box.join(' ')} | ${fmt(r.overlap, 4)} | ${fmt(r.alpha, 2)} | ${fmt(r.colourMean, 2)} / ${r.colourMax} | ${fmt(r.thickness, 1)}`
const head = '| feature | ink box, engine - canvas (x0 y0 x1 y1) | overlap at 50% | mean alpha diff (of 255) | colour diff mean / worst (of 255) | thickness (px) |'
console.log(`engine ${wasmPath}`)
console.log(`Skia baseline slip ${KEEP_SLIP ? 'LEFT IN' : 'removed'}; ${rows.length} cases; jobs from the app's own glyphJob\n`)
console.log('against Skia\'s outlines (the canvas at K times the transform, averaged down)\n')
console.log(`${head} K |`)
console.log('|---|---|---|---|---|---|---|')
for (const r of rows) console.log(`| ${r.name} | ${cells(r.outline)} | ${r.K} |`)
console.log('\nagainst the canvas as drawn (Skia\'s glyph masks)\n')
console.log(`${head} alpha levels engine / canvas | largest baseline slip removed (px) | engine ms (min / median) | canvas ms (min / median) |`)
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const r of rows) {
  console.log(
    `| ${r.name} | ${cells(r.drawn)} | ${r.drawn.levels.join(' / ')} | ${fmt(r.slip, 2)} | ${fmt(r.msEngine[0], 2)} / ${fmt(r.msEngine[1], 2)} | ${fmt(r.msCanvas[0], 2)} / ${fmt(r.msCanvas[1], 2)} |`,
  )
}

// The block of SPIKE.md section 8, as one job built by hand (it is not a box
// of the app's): three lines at 44 px, a 3 px outline and a fill.
const COST_LINES = ['WHAT THE HELL', 'ARE YOU DOING?!', 'office waffle Ty.']
const costJob = (family) => ({
  face: { key: `400 44px '${family}'`, name: family, bold: false, italic: false, size: 44 },
  curved: false,
  align: 'left',
  letterSpacing: 0,
  bands: [{ color: '#e63946', opacity: 1, line: 6 }],
  silhouette: null,
  fill: { kind: 'solid', color: '#111111' },
  runs: COST_LINES.map((text, i) => ({ text, x: 24, y: 70 + i * 90 })),
})
console.log('\ncost of the SPIKE.md section 8 block, ms per job (min / median / max of 60), pixels left in the engine (view) or copied out')
console.log('| font | scale | raster | engine, view | engine, copy | canvas (Skia) |')
console.log('|---|---|---|---|---|---|')
const cost = []
for (const family of ['Comic Neue', 'Bangers', 'DejaVu Sans']) {
  for (const scale of [1, 2]) {
    const job = costJob(family)
    const request = { job, ...fontFor(job.face), transform: [scale, 0, 0, scale, 0, 0] }
    const [W, H] = [600 * scale, 300 * scale]
    const cv = paintCanvas(job, request.transform, W, H)
    const time = (fn) => {
      const t = []
      for (let i = 0; i < 60; i++) {
        const t0 = now()
        fn()
        t.push(now() - t0)
      }
      return [Math.min(...t), median(t), Math.max(...t)]
    }
    const r = paintJob(engine, request)
    const view = time(() => paintJob(engine, { ...request, view: true }))
    const copy = time(() => paintJob(engine, request))
    const canvas = time(() => {
      cv.draw()
      cv.ctx.getImageData(0, 0, 1, 1)
    })
    cost.push({ family, scale, raster: [r.width, r.height], view, copy, canvas })
    const f = (t) => t.map((v) => fmt(v, 2)).join(' / ')
    console.log(`| ${family} | ${scale}x | ${r.width} x ${r.height} | ${f(view)} | ${f(copy)} | ${f(canvas)} |`)
  }
}

writeFileSync(resolve(outDir, 'paint-job.json'), `${JSON.stringify({ wasm: wasmPath, keepSlip: KEEP_SLIP, rows, cost }, null, 1)}\n`)
