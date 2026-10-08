// The minimal painter against Skia: three lines, one round-join stroke under
// a solid fill, at 2x, as a 600 x 300 px block (1200 x 600 device px).
//
//   node text-engine/parity/paint.mjs
//
// Writes <font>-engine.png, <font>-skia.png and <font>-diff.png to
// text-engine/js/generated/paint/ (gitignored) and prints, per font, the ink
// box difference and the time per paint.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, GlobalFonts, ImageData } from '@napi-rs/canvas'
import { loadEngine, fmt } from './common.mjs'

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../js/generated/paint')
mkdirSync(outDir, { recursive: true })

const { engine, fonts } = await loadEngine()
const SCALE = 2
const [W, H] = [600 * SCALE, 300 * SCALE]
const SIZE = 44
const STROKE = 3
const LINES = ['WHAT THE HELL', 'ARE YOU DOING?!', 'office waffle Ty.']
const FILL = 0x111111ff
const OUTLINE = 0xe63946ff
const css = (rgba) => `#${(rgba >>> 0).toString(16).padStart(8, '0')}`
const origin = (i) => ({ x: 24, y: 70 + i * 90 })

function box(data, threshold) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] < threshold) continue
      if (x < x0) x0 = x
      if (x + 1 > x1) x1 = x + 1
      if (y < y0) y0 = y
      if (y + 1 > y1) y1 = y + 1
    }
  }
  return [x0, y0, x1, y1]
}

function savePng(name, data) {
  const c = createCanvas(W, H)
  c.getContext('2d').putImageData(new ImageData(data, W, H), 0, 0)
  writeFileSync(resolve(outDir, name), c.toBuffer('image/png'))
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const now = () => Number(process.hrtime.bigint()) / 1e6

console.log(`3 lines at ${SIZE} px, stroke ${STROKE} px (pen ${STROKE * 2}), scale ${SCALE}, surface ${W} x ${H}\n`)
for (const f of fonts) {
  const family = `MTPaint ${f.key}`
  GlobalFonts.registerFromPath(f.path, family)
  const face = engine.face(f.id, SIZE)
  const spec = {
    width: W,
    height: H,
    transform: [SCALE, 0, 0, SCALE, 0, 0],
    lines: LINES.map((text, i) => ({ face, text, ...origin(i) })),
    stroke: { width: STROKE, color: OUTLINE },
    fill: FILL,
  }
  const mt = engine.paint(spec)

  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  const drawSkia = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.scale(SCALE, SCALE)
    ctx.font = `${SIZE}px "${family}"`
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.lineJoin = 'round'
    ctx.lineWidth = STROKE * 2
    ctx.strokeStyle = css(OUTLINE)
    ctx.fillStyle = css(FILL)
    LINES.forEach((text, i) => ctx.strokeText(text, origin(i).x, origin(i).y))
    LINES.forEach((text, i) => ctx.fillText(text, origin(i).x, origin(i).y))
  }
  drawSkia()
  const sk = ctx.getImageData(0, 0, W, H).data

  // Skia paints the baseline `ascent - round(ascent)` text px above the y it
  // is given (parity/synth.mjs, item 0); in device px that is times the scale.
  const asc = ctx.measureText('H').fontBoundingBoxAscent
  const slip = (asc - Math.round(asc)) * SCALE

  const stat = (threshold) => {
    const a = box(mt.data, threshold)
    const b = box(sk, threshold)
    return { engine: a, skia: b, d: a.map((v, i) => v - b[i]) }
  }
  const any = stat(1)
  const half = stat(128)
  let inter = 0, union = 0, sumAbs = 0, n = 0
  const diff = new Uint8ClampedArray(W * H * 4)
  const levels = [new Set(), new Set()]
  for (let i = 0; i < W * H; i++) {
    const a = mt.data[i * 4 + 3]
    const b = sk[i * 4 + 3]
    levels[0].add(a)
    levels[1].add(b)
    const [ia, ib] = [a >= 128, b >= 128]
    if (ia && ib) inter++
    if (ia || ib) union++
    if (a || b) {
      sumAbs += Math.abs(a - b)
      n++
    }
    // Red where only the engine has ink, blue where only Skia has.
    diff.set([a > b ? a - b : 0, 0, b > a ? b - a : 0, 255], i * 4)
  }
  savePng(`${f.key}-engine.png`, mt.data)
  savePng(`${f.key}-skia.png`, new Uint8ClampedArray(sk))
  savePng(`${f.key}-diff.png`, diff)

  const tEngine = []
  const tSkia = []
  for (let i = 0; i < 40; i++) {
    let t = now()
    engine.paint(spec)
    tEngine.push(now() - t)
    t = now()
    drawSkia()
    ctx.getImageData(0, 0, 1, 1)
    tSkia.push(now() - t)
  }
  console.log(f.key)
  console.log(`  ink box, any coverage   engine [${any.engine}]  skia [${any.skia}]  engine - skia [${any.d}] device px (x0 y0 x1 y1)`)
  console.log(`  ink box, >= 50% alpha   engine [${half.engine}]  skia [${half.skia}]  engine - skia [${half.d}]`)
  console.log(`  known Skia baseline slip: ${fmt(slip, 2)} device px upward (explains that much of y0 and y1)`)
  console.log(`  overlap at 50% alpha (intersection / union) ${fmt(inter / union, 4)};  mean |alpha difference| over inked pixels ${fmt(sumAbs / n / 255, 4)}`)
  console.log(`  distinct alpha levels: engine ${levels[0].size}, skia ${levels[1].size}`)
  console.log(`  time per paint, median of 40: engine ${fmt(median(tEngine), 2)} ms (pixels copied out to JS included), skia ${fmt(median(tSkia), 2)} ms`)

  // Where the engine's time goes, and the same block at 1x.
  const time = (s) => {
    const ts = []
    for (let i = 0; i < 40; i++) {
      const t = now()
      engine.paint(s)
      ts.push(now() - t)
    }
    return fmt(median(ts), 2)
  }
  const oneX = { ...spec, width: W / SCALE, height: H / SCALE, transform: [1, 0, 0, 1, 0, 0] }
  console.log(
    `  engine alone, ms: empty surface ${time({ ...spec, lines: [] })}, fill only ${time({ ...spec, stroke: undefined })}, stroke only ${time({ ...spec, fill: undefined })}; at 1x (${W / SCALE} x ${H / SCALE}) ${time(oneX)}`,
  )
}
console.log(`\nPNGs in ${outDir}`)
