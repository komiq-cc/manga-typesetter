// How Skia fakes bold and italic when only the regular file exists, and
// whether the engine's rule for it gives the same ink.
//
//   node text-engine/parity/synth.mjs [--json out.json]
//
// Only the regular file of each family is registered; the canvas is then
// asked for `bold`, `italic` and `italic bold`. Everything is read from the
// pixels Skia paints under a scale transform, so one device pixel is a small
// fraction of a text pixel and grid fitting is (almost) out of the way.
//
// The zoom is chosen per size to keep size * zoom under 256 device px. Above
// that Skia stops using a glyph mask made at the font's size and draws a
// path from a canonical 64 px strike, which changes the bold rule to the
// 64 px one whatever the font size is (measured: every size >= 16 px came out
// at 1/32 under a fixed 20x zoom).
import { writeFileSync } from 'node:fs'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { loadEngine, fmt, stats } from './common.mjs'

const { engine, fonts } = await loadEngine()
const regular = fonts.filter((f) => f.key !== 'DejaVuSans-Oblique')
for (const f of regular) {
  f.family = `MTSynth ${f.key}`
  GlobalFonts.registerFromPath(f.path, f.family)
}

const zoomFor = (size) => Math.max(2, Math.min(20, Math.floor(250 / size)))

/** Ink box of what Skia paints, in text px (1/zoom px resolution), plus per-row coverage. */
function paintBox(family, style, size, text, ZOOM = zoomFor(size)) {
  const m = createCanvas(4, 4).getContext('2d')
  m.font = `${style} ${size}px "${family}"`
  const adv = m.measureText(text).width
  const pad = size * 0.6
  const w = Math.ceil((adv + pad * 2) * ZOOM)
  const h = Math.ceil(size * 2.6 * ZOOM)
  const c = createCanvas(w, h)
  const g = c.getContext('2d')
  g.scale(ZOOM, ZOOM)
  g.font = `${style} ${size}px "${family}"`
  g.textBaseline = 'alphabetic'
  const ox = pad
  const oy = size * 1.7
  g.fillText(text, ox, oy)
  const d = g.getImageData(0, 0, w, h).data
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const rows = new Array(h)
  for (let y = 0; y < h; y++) {
    let sum = 0
    let moment = 0
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3]
      if (a === 0) continue
      sum += a / 255
      moment += (a / 255) * (x + 0.5)
      // Any coverage counts: the box of touched pixels contains the outline
      // and overshoots each edge by less than one device pixel.
      {
        if (x < x0) x0 = x
        if (x + 1 > x1) x1 = x + 1
        if (y < y0) y0 = y
        if (y + 1 > y1) y1 = y + 1
      }
    }
    rows[y] = { sum: sum / ZOOM, cx: sum ? moment / sum / ZOOM - ox : NaN }
  }
  return {
    advance: adv,
    left: ox - x0 / ZOOM,
    right: x1 / ZOOM - ox,
    ascent: oy - y0 / ZOOM,
    descent: y1 / ZOOM - oy,
    rows,
    rowOf: (yUp) => Math.round((oy - yUp) * ZOOM),
  }
}

const report = { advance: [], baseline: [], bold: [], skew: [], ink: {}, joins: [] }

// 0. Where Skia paints the baseline. Its fillText does not put the alphabetic
// baseline at the y it is given: the glyphs sit `ascent - round(ascent)`
// higher, because the line it lays out has a whole-pixel ascent. Every pixel
// reading below is corrected by this slip, so it is measured first.
const slipOf = (family, size) => {
  const m = createCanvas(4, 4).getContext('2d')
  m.font = `${size}px "${family}"`
  const a = m.measureText('H').fontBoundingBoxAscent
  return a - Math.round(a)
}
console.log('SYNTHETIC STYLES IN SKIA (regular file only registered)\n')
console.log('0. baseline slip: (painted top of "H" - outline top of "H") against ascent - round(ascent), px')
let slipWorst = 0
for (const f of regular) {
  const cells = []
  for (const size of [12, 14.5, 16, 22.5, 30, 40]) {
    const zoom = 20
    const painted = paintBox(f.family, 'normal', size, 'H', zoom)
    const outline = engine.lineInk(engine.face(f.id, size), 'H')
    const measured = painted.ascent - outline.ascent
    const predicted = slipOf(f.family, size)
    // The touched-pixel box overshoots by up to one device pixel.
    slipWorst = Math.max(slipWorst, Math.abs(measured - predicted))
    cells.push(`${size}: ${fmt(measured, 2)} / ${fmt(predicted, 2)}`)
    report.baseline.push({ font: f.key, size, measured, predicted })
  }
  console.log(`   ${f.key.padEnd(12)} ${cells.join('   ')}`)
}
console.log(`   worst |measured - predicted| = ${fmt(slipWorst, 3)} px (pixel resolution here is 0.05 px)`)

// 1. Does the advance change?
let advMax = 0
for (const f of regular) {
  const m = createCanvas(4, 4).getContext('2d')
  for (const size of [12, 16, 22.5, 40, 96]) {
    for (const text of ['H', 'Hello', 'WHAT THE HELL?!', 'office waffle']) {
      const w = (style) => ((m.font = `${style} ${size}px "${f.family}"`), m.measureText(text).width)
      const base = w('normal')
      for (const style of ['bold', 'italic', 'italic bold']) advMax = Math.max(advMax, Math.abs(w(style) - base))
    }
  }
}
report.advance = { worstChange: advMax }
console.log(`\n1. advance: worst change of measureText().width under bold / italic / both, 3 fonts x 5 sizes x 4 strings: ${advMax} px`)

// 2. How much does bold add? Width of a vertical stem, mid-height, bold minus regular.
console.log('\n2. bold: stem of "l" at half its height, (bold width - regular width) / size')
console.log('   size   ' + regular.map((f) => f.key.padStart(12)).join('') + '   Skia rule k(size)   engine 2*outset/size')
const kOf = (size) => (size <= 9 ? 1 / 24 : size >= 36 ? 1 / 32 : 1 / 24 + ((1 / 32 - 1 / 24) * (size - 9)) / 27)
let boldWorst = 0
for (const size of [6, 9, 12, 16, 22.5, 27, 36, 48, 96]) {
  const cells = []
  for (const f of regular) {
    const reg = paintBox(f.family, 'normal', size, 'l')
    const bold = paintBox(f.family, 'bold', size, 'l')
    const row = reg.rowOf(reg.ascent / 2)
    const growth = (bold.rows[row].sum - reg.rows[row].sum) / size
    const centre = Math.abs(bold.rows[row].cx - reg.rows[row].cx)
    cells.push(growth)
    boldWorst = Math.max(boldWorst, Math.abs(growth - kOf(size)))
    report.bold.push({ font: f.key, size, growthPerSize: growth, expected: kOf(size), centreShift: centre })
  }
  // The engine's number is taken from its own answer, not from the formula.
  const id = regular[0].id
  const eReg = engine.lineInk(engine.face(id, size), 'l')
  const eBold = engine.lineInk(engine.face(id, size, { bold: true }), 'l')
  const eGrowth = (eBold.right + eBold.left - (eReg.right + eReg.left)) / size
  console.log(`   ${String(size).padStart(5)}  ${cells.map((c) => fmt(c, 5).padStart(12)).join('')}   ${fmt(kOf(size), 5).padStart(10)}          ${fmt(eGrowth, 5)}`)
}
const centreWorst = Math.max(...report.bold.map((b) => b.centreShift))
console.log(`   worst |measured - k(size)| = ${fmt(boldWorst, 5)} of the size; stem centre moves by at most ${fmt(centreWorst, 4)} px (so it grows evenly on both sides)`)

// 3. The slant of a faked italic: horizontal drift of the stem per unit height.
console.log('\n3. italic: slope of the stem of "l" (x shift per unit of height), and its shift at the baseline')
for (const f of regular) {
  // Path mode on purpose (40 px * 20): no grid fitting to bend the stem, and
  // the slant does not depend on the size.
  const size = 40
  const reg = paintBox(f.family, 'normal', size, 'l', 20)
  const ital = paintBox(f.family, 'italic', size, 'l', 20)
  const [ya, yb] = [reg.ascent * 0.2, reg.ascent * 0.8]
  const at = (box, y) => box.rows[reg.rowOf(y)].cx
  const slope = (at(ital, yb) - at(reg, yb) - (at(ital, ya) - at(reg, ya))) / (yb - ya)
  const atBase = at(ital, ya) - at(reg, ya) - slope * ya
  report.skew.push({ font: f.key, slope, shiftAtBaseline: atBase })
  console.log(`   ${f.key.padEnd(12)} slope ${fmt(slope, 4)}   shift extrapolated to y = 0: ${fmt(atBase, 3)} px`)
}

// 4. Whole ink boxes: Skia's painted pixels against the engine's answer.
// `over` is how far Skia's touched-pixel box reaches past the engine's edge,
// in DEVICE pixels: an exact outline gives 0..1, grid fitting adds about +-1.
console.log('\n4. ink box: box of the pixels Skia touches under zoom (baseline slip removed), against engine lineInk (14 glyphs x 3 fonts x 4 sizes x 4 edges)')
console.log('   style         count   |diff| px: max     p99     p50     overshoot in device px: min     max    share within [-1, 2]')
const GLYPHS = ['H', 'l', 'o', 'g', 'A', 'V', 'W', 'M', 'T', 'x', 'e', '?', 'j', 'f']
const worstRows = []
for (const [style, flags] of [
  ['normal', {}],
  ['bold', { bold: true }],
  ['italic', { italic: true }],
  ['italic bold', { bold: true, italic: true }],
]) {
  const diffs = []
  const over = []
  for (const f of regular) {
    for (const size of [12, 16, 22.5, 40]) {
      const face = engine.face(f.id, size, flags)
      const zoom = zoomFor(size)
      for (const text of GLYPHS) {
        const sk = paintBox(f.family, style, size, text)
        const slip = slipOf(f.family, size)
        sk.ascent -= slip
        sk.descent += slip
        const mt = engine.lineInk(face, text)
        for (const key of ['left', 'right', 'ascent', 'descent']) {
          const d = Math.abs(sk[key] - mt[key])
          diffs.push(d)
          over.push((sk[key] - mt[key]) * zoom)
          worstRows.push({ style, font: f.key, size, text, key, skia: sk[key], engine: mt[key], d, devicePx: (sk[key] - mt[key]) * zoom })
        }
      }
    }
  }
  const s = stats(diffs)
  const within = over.filter((o) => o >= -1 && o <= 2).length / over.length
  report.ink[style] = { ...s, overshootMin: Math.min(...over), overshootMax: Math.max(...over), within }
  console.log(
    `   ${style.padEnd(12)} ${String(s.count).padStart(6)}${fmt(s.max, 3).padStart(16)}${fmt(s.p99, 3).padStart(8)}${fmt(s.p50, 3).padStart(8)}${fmt(Math.min(...over), 2).padStart(28)}${fmt(Math.max(...over), 2).padStart(8)}${(within * 100).toFixed(1).padStart(12)}%`,
  )
}
worstRows.sort((a, b) => b.d - a.d)
console.log('   worst 10, any style:')
for (const r of worstRows.slice(0, 10)) {
  console.log(`     ${fmt(r.d, 3).padStart(6)} px (${fmt(r.devicePx, 1)} device px)  ${r.style.padEnd(12)} ${r.font.padEnd(11)} ${String(r.size).padStart(5)}px "${r.text}" ${r.key.padEnd(8)} skia ${fmt(r.skia, 3).padStart(8)}  engine ${fmt(r.engine, 3).padStart(8)}`)
}
report.inkWorst = worstRows.slice(0, 40)

// 5. Corners: does the bold grow by the same amount at a sharp corner as on a
// flat edge? A round join would (exactly the outset); a miter join pokes
// further. Read at 20x in path mode, where the rule is the 1/32 one, which is
// also the rule for 40 px.
const outset40 = (40 * kOf(40)) / 2
console.log(`\n5. bold growth of each edge at 40 px, in units of the outset (${fmt(outset40, 3)} px); 1.00 = a round join`)
console.log('   glyph        ' + ['left', 'right', 'top', 'bottom'].map((h) => h.padStart(8)).join(''))
let joinMax = 0
for (const f of regular) {
  for (const text of ['H', 'o', 'A', 'V', 'x', 'k', 'M', '<']) {
    const reg = paintBox(f.family, 'normal', 40, text, 20)
    const bold = paintBox(f.family, 'bold', 40, text, 20)
    const g = ['left', 'right', 'ascent', 'descent'].map((key) => (bold[key] - reg[key]) / outset40)
    joinMax = Math.max(joinMax, ...g)
    report.joins.push({ font: f.key, text, left: g[0], right: g[1], top: g[2], bottom: g[3] })
    console.log(`   ${f.key.padEnd(11)} ${text} ${g.map((v) => fmt(v, 2).padStart(8)).join('')}`)
  }
}
console.log(`   largest growth: ${fmt(joinMax, 2)} outsets = ${fmt(joinMax * outset40, 2)} px at 40 px; the engine's rule (round join) gives 1.00 everywhere`)

const jsonAt = process.argv.indexOf('--json')
if (jsonAt > 0) {
  for (const r of report.inkWorst) delete r.rows
  writeFileSync(process.argv[jsonAt + 1], `${JSON.stringify(report, null, 2)}\n`)
}
