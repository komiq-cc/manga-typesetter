// Which rasteriser the painter should use: the candidates, measured.
//
//   MT_TEXT_FEATURES=raster-compare MT_TEXT_OUT=mt_text.compare.wasm npm run build:engine
//   node text-engine/parity/raster.mjs
//
// Every candidate is given the same polylines (the painter's own outlines
// and strokes) through the same interface, so only the rasteriser differs.
// For each one this prints, per group of jobs:
//
//   levels   distinct alpha values in the raster
//   mean     mean |alpha - truth| over edge pixels (truth strictly inside 0..255), in alpha levels
//   p99, max the same, 99th percentile and worst
//   >16      edge pixels more than 16 levels off, per thousand
//   lost     pixels the truth inks at 16 levels or more that the candidate leaves empty
//   bias     total ink against the truth's, percent
//
// The truth is the same job painted at 32 times the scale with the exact
// rasteriser and averaged down, 32 x 32 device pixels to one. At that scale
// one of its own pixels is 1/1024 of a pixel here, so what it gets wrong
// (see raster.rs) cannot be seen in the average. As a check that this is not
// the exact rasteriser marking its own work, the same average is made from
// tiny-skia at 32x (128 x 128 samples a pixel) and the two are compared.
//
// Then the time for the block of SPIKE.md section 8, and the size of each
// build that is found in js/generated/.
//
// PNGs of a few cases go to js/generated/paint/raster-*.png, enlarged 6x.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, GlobalFonts, ImageData } from '@napi-rs/canvas'
import { createEngine } from '../js/engine.mjs'
import { paintJob } from '../js/paint.mjs'
import { FONTS, fmt } from './common.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const genDir = resolve(here, '../js/generated')
const outDir = resolve(process.env.MT_TEXT_PAINT_OUT ?? resolve(genDir, 'paint'))
mkdirSync(outDir, { recursive: true })
const wasm = resolve(genDir, process.env.MT_TEXT_WASM ?? 'mt_text.compare.wasm')
if (!existsSync(wasm)) {
  console.error(`missing ${wasm}\nbuild it with:\n  MT_TEXT_FEATURES=raster-compare MT_TEXT_OUT=mt_text.compare.wasm npm run build:engine`)
  process.exit(1)
}
const engine = await createEngine(readFileSync(wasm))
const fonts = FONTS.map((f) => ({ ...f, id: engine.addFont(readFileSync(f.path)) }))
const RASTERIZERS = [
  { id: 0, name: 'exact area (ours)' },
  { id: 1, name: 'tiny-skia 0.12' },
  { id: 2, name: 'zeno 0.3' },
  { id: 3, name: 'vello_cpu 0.2' },
].filter((r) => engine.exports.mt_paint_rasterizer(r.id) === 0)
const use = (id) => {
  if (engine.exports.mt_paint_rasterizer(id) !== 0) throw new Error(`rasteriser ${id} is not in this build`)
}

const TRUTH_SCALE = 32
// Off the pixel grid on purpose: a job that starts on a whole pixel flatters
// every rasteriser on its vertical and horizontal edges.
const OFFSET = [0.37, 0.61]
const BLACK = '#000000'
const NONE = '#00000000'

const job = (size, lines, extra = {}) => ({
  face: { size },
  curved: false,
  align: 'left',
  letterSpacing: 0,
  bands: [],
  silhouette: null,
  fill: { kind: 'solid', color: BLACK },
  runs: lines.map((text, i) => ({ text, x: 4, y: size * (1.1 + i * 1.3) })),
  ...extra,
})
const band = (line) => ({ bands: [{ color: BLACK, opacity: 1, line }], fill: { kind: 'solid', color: NONE } })

const SMALL = ['The quick brown fox jumps;', 'AVATAR Ty. office?! g@&%']
const LARGE = ['WHAT?! office Ty.']
const GROUPS = [
  { name: 'fill, 8 to 14 px', jobs: [8, 10, 12, 14].map((s) => ({ size: s, job: job(s, SMALL) })) },
  // At 96 px a shorter line, so that 32 times its width still fits a surface.
  { name: 'fill, 22 to 96 px', jobs: [22, 44, 96].map((s) => ({ size: s, job: job(s, s > 50 ? ['Wag&?'] : LARGE) })) },
  {
    name: 'stroke 0.6 px wide, text 10 to 44 px',
    jobs: [10, 14, 44].map((s) => ({ size: s, job: job(s, s < 20 ? SMALL : LARGE, band(0.6)) })),
  },
  {
    name: 'stroke 1.5 px wide, text 10 to 14 px',
    jobs: [10, 14].map((s) => ({ size: s, job: job(s, SMALL, band(1.5)) })),
  },
  {
    name: 'stroke 12 px wide, text 44 px (strokes of neighbours overlap)',
    jobs: [44].map((s) => ({ size: s, job: job(s, LARGE, band(12)) })),
  },
  {
    name: 'synthetic bold fill, 12 and 44 px',
    jobs: [12, 44].map((s) => ({ size: s, synth: { bold: true }, job: job(s, s < 20 ? SMALL : LARGE) })),
  },
]

const paint = (c, font, scale) =>
  paintJob(engine, {
    job: c.job,
    font: font.id,
    synth: c.synth,
    transform: [scale, 0, 0, scale, OFFSET[0] * scale, OFFSET[1] * scale],
  })

/** Alpha of a 32x raster averaged down to the 1x pixel grid, as floats 0..255, over `box`. */
function average(big, box) {
  const [x0, y0, x1, y1] = box
  const w = x1 - x0
  const out = new Float64Array(w * (y1 - y0))
  const S = TRUTH_SCALE
  for (let by = 0; by < big.height; by++) {
    const y = Math.floor((big.y + by) / S)
    if (y < y0 || y >= y1) continue
    const row = (y - y0) * w
    for (let bx = 0; bx < big.width; bx++) {
      const a = big.data[(by * big.width + bx) * 4 + 3]
      if (a === 0) continue
      const x = Math.floor((big.x + bx) / S)
      if (x >= x0 && x < x1) out[row + (x - x0)] += a
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= S * S
  return out
}

const alphaOver = (r, box) => {
  const [x0, y0, x1, y1] = box
  const w = x1 - x0
  const out = new Float64Array(w * (y1 - y0))
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const X = r.x + x
      const Y = r.y + y
      if (X >= x0 && X < x1 && Y >= y0 && Y < y1) out[(Y - y0) * w + (X - x0)] = r.data[(y * r.width + x) * 4 + 3]
    }
  }
  return out
}

function savePng(name, alpha, w, h, zoom = 6, signed = null) {
  const c = createCanvas(w * zoom, h * zoom)
  const ctx = c.getContext('2d')
  const img = new ImageData(w * zoom, h * zoom)
  for (let y = 0; y < h * zoom; y++) {
    for (let x = 0; x < w * zoom; x++) {
      const i = Math.floor(y / zoom) * w + Math.floor(x / zoom)
      const o = (y * w * zoom + x) * 4
      if (signed) {
        // Red where the candidate has more ink than the truth, blue where less; 4x gain.
        const d = signed[i] * 4
        img.data[o] = 255 - Math.max(0, -d)
        img.data[o + 1] = 255 - Math.abs(d)
        img.data[o + 2] = 255 - Math.max(0, d)
      } else {
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255 - alpha[i]
      }
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  writeFileSync(resolve(outDir, name), c.toBuffer('image/png'))
}

const newStat = () => ({ levels: new Set(), errs: [], over16: 0, lost: 0, ink: 0, truthInk: 0, truthCheck: 0 })
const stats = new Map()
const key = (g, r) => `${g.name}|${r.id}`
let truthVsTiny = 0
let truthPixels = 0
const haveTiny = RASTERIZERS.some((r) => r.id === 1)

for (const group of GROUPS) {
  for (const c of group.jobs) {
    for (const font of fonts) {
      use(0)
      const big = paint(c, font, TRUTH_SCALE)
      const S = TRUTH_SCALE
      const box = [Math.floor(big.x / S) - 1, Math.floor(big.y / S) - 1, Math.ceil((big.x + big.width) / S) + 1, Math.ceil((big.y + big.height) / S) + 1]
      const truth = average(big, box)
      if (haveTiny) {
        use(1)
        const other = average(paint(c, font, TRUTH_SCALE), box)
        for (let i = 0; i < truth.length; i++) {
          if (truth[i] > 0 || other[i] > 0) {
            truthVsTiny = Math.max(truthVsTiny, Math.abs(truth[i] - other[i]))
            truthPixels++
          }
        }
      }
      const w = box[2] - box[0]
      const h = box[3] - box[1]
      for (const r of RASTERIZERS) {
        use(r.id)
        const got = alphaOver(paint(c, font, 1), box)
        const st = stats.get(key(group, r)) ?? stats.set(key(group, r), newStat()).get(key(group, r))
        const signed = new Float64Array(got.length)
        for (let i = 0; i < got.length; i++) {
          st.levels.add(got[i])
          st.ink += got[i]
          st.truthInk += truth[i]
          signed[i] = got[i] - truth[i]
          if (truth[i] > 0.5 && truth[i] < 254.5) {
            const e = Math.abs(got[i] - truth[i])
            st.errs.push(e)
            if (e > 16) st.over16++
          }
          if (truth[i] >= 16 && got[i] === 0) st.lost++
        }
        // Pictures of one font for the cases a person should look at.
        if (font.key === 'ComicNeue' && [10, 12, 44].includes(c.size)) {
          const tag = `${group.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 28)}-${c.size}px-r${r.id}`
          savePng(`raster-${tag}.png`, got, w, h)
          savePng(`raster-${tag}-err.png`, null, w, h, 6, signed)
          if (r.id === 0) savePng(`raster-${tag.replace(/-r0$/, '')}-truth.png`, truth, w, h)
        }
      }
    }
  }
}

console.log(`truth: exact rasteriser at ${TRUTH_SCALE}x, averaged down. Jobs offset by (${OFFSET}) px. 4 fixture fonts.`)
if (haveTiny) {
  console.log(`check on the truth: against tiny-skia at ${TRUTH_SCALE}x averaged the same way, worst difference ${fmt(truthVsTiny, 3)} alpha levels over ${truthPixels} inked pixels\n`)
}
const pct = (xs, q) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]
}
for (const group of GROUPS) {
  console.log(group.name)
  console.log('  rasteriser           levels   mean    p99    max   >16 (per 1000)   lost   bias %   edge pixels')
  for (const r of RASTERIZERS) {
    const st = stats.get(key(group, r))
    const mean = st.errs.reduce((a, b) => a + b, 0) / Math.max(1, st.errs.length)
    console.log(
      `  ${r.name.padEnd(20)} ${String(st.levels.size).padStart(6)} ${fmt(mean, 2).padStart(6)} ${fmt(pct(st.errs, 0.99), 1).padStart(6)} ${fmt(Math.max(0, ...st.errs), 1).padStart(6)} ${fmt((st.over16 / Math.max(1, st.errs.length)) * 1000, 2).padStart(12)} ${String(st.lost).padStart(10)} ${fmt((st.ink / st.truthInk - 1) * 100, 2).padStart(8)} ${String(st.errs.length).padStart(12)}`,
    )
  }
  console.log()
}

// Time: the block of SPIKE.md section 8. Three lines at 44 px, a 3 px stroke
// (pen 6) under a flat fill, at 2x and at 1x.
const LINES = ['WHAT THE HELL', 'ARE YOU DOING?!', 'office waffle Ty.']
const block = {
  face: { size: 44 },
  curved: false,
  align: 'left',
  letterSpacing: 0,
  bands: [{ color: '#e63946', opacity: 1, line: 6 }],
  silhouette: null,
  fill: { kind: 'solid', color: '#111111' },
  runs: LINES.map((text, i) => ({ text, x: 24, y: 70 + i * 90 })),
}
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const now = () => Number(process.hrtime.bigint()) / 1e6
const time = (fn, n = 40) => {
  for (let i = 0; i < 8; i++) fn()
  const ts = []
  for (let i = 0; i < n; i++) {
    const t = now()
    fn()
    ts.push(now() - t)
  }
  return median(ts)
}
console.log('time for the SPIKE.md section 8 block (3 lines at 44 px, pen 6, flat fill), ms, median of 40, pixels copied out to JS included')
console.log('  rasteriser           font                 2x (device px)          1x (device px)')
for (const r of RASTERIZERS) {
  use(r.id)
  for (const font of fonts) {
    const at = (scale) => {
      const req = { job: block, font: font.id, transform: [scale, 0, 0, scale, 0, 0] }
      const size = paintJob(engine, req)
      return `${fmt(time(() => paintJob(engine, req)), 2)} (${size.width} x ${size.height})`
    }
    console.log(`  ${r.name.padEnd(20)} ${font.key.padEnd(20)} ${at(2).padEnd(23)} ${at(1)}`)
  }
}
// The same drawing on a Skia canvas, as the spike timed it.
{
  const [W, H] = [1200, 600]
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  for (const font of fonts) {
    const family = `MTRaster ${font.key}`
    GlobalFonts.registerFromPath(font.path, family)
    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, W, H)
      ctx.scale(2, 2)
      ctx.font = `44px "${family}"`
      ctx.lineJoin = 'round'
      ctx.lineWidth = 6
      ctx.strokeStyle = '#e63946'
      ctx.fillStyle = '#111111'
      LINES.forEach((t, i) => ctx.strokeText(t, 24, 70 + i * 90))
      LINES.forEach((t, i) => ctx.fillText(t, 24, 70 + i * 90))
      ctx.getImageData(0, 0, 1, 1)
    }
    console.log(`  ${'Skia canvas'.padEnd(20)} ${font.key.padEnd(20)} ${fmt(time(draw), 2)} (pixels not read back)`)
  }
}

console.log('\nwasm bytes, for the builds found in js/generated/')
const base = ['nopaint.wasm', 'no painter']
const builds = [
  base,
  ['mt_text.wasm', 'painter, exact area (the default build)'],
  ['mt_text.tiny-skia.wasm', 'the same plus tiny-skia'],
  ['mt_text.zeno.wasm', 'the same plus zeno'],
  ['mt_text.vello.wasm', 'the same plus vello_cpu'],
]
for (const [file, what] of builds) {
  const p = resolve(genDir, file)
  if (existsSync(p)) console.log(`  ${String(statSync(p).size).padStart(9)}  ${what} (${file})`)
}
console.log(`\nPNGs in ${outDir}`)
