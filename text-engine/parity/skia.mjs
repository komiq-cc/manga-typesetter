// REF-SK: the engine against Skia (@napi-rs/canvas), in pixels.
//
//   node text-engine/parity/skia.mjs [--json out.json] [--all]
//
// Compares, for 4 fonts x 10 sizes x the corpus: measureText().width,
// fontBoundingBoxAscent/Descent, actualBoundingBox* (left / alphabetic), and
// for single glyphs actualBoundingBox* at center / middle. Then tests the
// candidate rules (which table the line box comes from, where `middle` sits,
// what Skia does to widths and ink boxes) and prints which one holds.
//
// This script reports; it does not gate. The gate is harfbuzz.mjs (exact).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { loadEngine, STRINGS, SIZES, show, stats, fmt, wasmPath, sha256File } from './common.mjs'

const { engine, fonts } = await loadEngine()
const ctx = createCanvas(16, 16).getContext('2d')
for (const f of fonts) {
  f.family = `MTParity ${f.key}`
  GlobalFonts.registerFromPath(f.path, f.family)
}

// Single glyphs measured at center/middle: the corpus singles plus a few
// shapes with different extents (descender, overshoot, dot, narrow, wide).
const GLYPHS = [...new Set([...STRINGS.filter((s) => s.kind === 'single').map((s) => s.text), 'M', 'j', 'y', 'O', '?', '!', 'Q', 'f'])]

const round2 = (v) => Math.round(v * 100) / 100
const isInt = (v) => Math.abs(v - Math.round(v)) < 1e-6

function skMeasure(family, size, text, align, baseline) {
  ctx.font = `${size}px "${family}"`
  ctx.textAlign = align
  ctx.textBaseline = baseline
  const m = ctx.measureText(text)
  return {
    width: m.width,
    left: m.actualBoundingBoxLeft,
    right: m.actualBoundingBoxRight,
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
    fontAscent: m.fontBoundingBoxAscent,
    fontDescent: m.fontBoundingBoxDescent,
  }
}

/** quantity -> list of { font, size, text, kind, sk, mt, d } */
const samples = {}
const add = (q, row) => (samples[q] ??= []).push({ ...row, d: Math.abs(row.sk - row.mt) })

const rule = {
  widthRounded: { exact: 0, total: 0, maxResidual: 0 },
  box: { hhea: 0, typo: 0, win: 0, integerValued: 0, total: 0 },
  middle: {},
  ink: { total: 0, integer: 0, roundOutExact: 0, roundNearestExact: 0, inward: 0, within1: 0 },
  // Skia's reported box against the box of the pixels Skia itself draws.
  raster: { glyphs: 0, sameBox: 0, worst: 0 },
  anchor: { centerX: 0, middleY: 0 },
  widthMisses: { total: 0, ties: 0 },
  tables: [],
}

// Bounding box of what Skia paints for one glyph, in the measureText sign
// convention. This is the direct evidence for what its ink box is a box OF.
const PAD = 40
function skRasterBox(family, size, text) {
  const w = Math.ceil(size * 2) + PAD * 2
  const h = Math.ceil(size * 2.5) + PAD * 2
  const c = createCanvas(w, h)
  const g = c.getContext('2d')
  g.font = `${size}px "${family}"`
  g.textAlign = 'left'
  g.textBaseline = 'alphabetic'
  const ox = PAD + Math.ceil(size / 2)
  const oy = PAD + Math.ceil(size * 1.5)
  g.fillText(text, ox, oy)
  const d = g.getImageData(0, 0, w, h).data
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] === 0) continue
      if (x < x0) x0 = x
      if (x + 1 > x1) x1 = x + 1
      if (y < y0) y0 = y
      if (y + 1 > y1) y1 = y + 1
    }
  }
  if (x1 < 0) return null
  return { left: ox - x0, right: x1 - ox, ascent: oy - y0, descent: y1 - oy }
}
const middleCandidates = {
  '(asc - desc) / 2': (a, d) => (a - d) / 2,
  'asc - round(asc + desc) / 2': (a, d) => a - Math.round(a + d) / 2,
  'asc - (round(asc) + round(desc)) / 2': (a, d) => a - (Math.round(a) + Math.round(d)) / 2,
  '(round(asc) - round(desc)) / 2': (a, d) => (Math.round(a) - Math.round(d)) / 2,
  '0.5 em - desc  (em box of the typo/hhea sum)': (a, d, size) => size / 2 - d,
}
for (const k of Object.keys(middleCandidates)) rule.middle[k] = 0

for (const f of fonts) {
  const upem = f.info.unitsPerEm
  const v = f.info.vertical
  for (const size of SIZES) {
    const face = engine.face(f.id, size)
    const at = { font: f.key, size }

    // Line box.
    const skBox = skMeasure(f.family, size, 'Hg', 'left', 'alphabetic')
    const mtBox = engine.fontBox(face)
    add('fontBoundingBoxAscent', { ...at, text: 'Hg', sk: skBox.fontAscent, mt: mtBox.ascent })
    add('fontBoundingBoxDescent', { ...at, text: 'Hg', sk: skBox.fontDescent, mt: mtBox.descent })
    rule.box.total += 2
    for (const table of ['hhea', 'typo', 'win']) {
      const t = v[table]
      const dA = Math.abs(skBox.fontAscent - (t.ascent * size) / upem)
      const dD = Math.abs(skBox.fontDescent - (t.descent * size) / upem)
      rule.box[table] = Math.max(rule.box[table], dA, dD)
    }
    rule.box.integerValued += isInt(skBox.fontAscent) + isInt(skBox.fontDescent)

    // Where `middle` sits above alphabetic, from Skia's own two answers.
    const skMid = skMeasure(f.family, size, 'Hg', 'left', 'middle')
    const skShift = skBox.fontAscent - skMid.fontAscent
    add('middle baseline shift', { ...at, text: 'Hg', sk: skShift, mt: (mtBox.ascent - mtBox.descent) / 2 })
    for (const [name, fn] of Object.entries(middleCandidates)) {
      rule.middle[name] = Math.max(rule.middle[name], Math.abs(skShift - fn(skBox.fontAscent, skBox.fontDescent, size)))
    }

    for (const { kind, text } of STRINGS) {
      const sk = skMeasure(f.family, size, text, 'left', 'alphabetic')
      const mt = engine.lineInk(face, text)
      const row = { ...at, text, kind }
      add('advance (measureText.width)', { ...row, sk: sk.width, mt: engine.advance(face, text) })
      rule.widthRounded.total++
      const residual = Math.abs(sk.width - round2(mt.width))
      rule.widthRounded.maxResidual = Math.max(rule.widthRounded.maxResidual, residual)
      if (residual < 1e-4) rule.widthRounded.exact++
      if (residual >= 1e-4) {
        rule.widthMisses.total++
        // An exact advance ending in ...5 thousandths is a rounding tie that
        // float32 can settle either way.
        const frac = Math.abs(((mt.width * 100) % 1) - 0.5)
        if (frac < 0.011) rule.widthMisses.ties++
      }
      // Two groups of strings measure Skia's quirks rather than ink, so they
      // get their own rows: text the font has no glyph for, and text that
      // starts with (or is only) spaces.
      const group =
        kind === 'fallback' ? ' [missing glyphs]' : /^\s/.test(text) ? ' [leading/only spaces]' : ''
      for (const [q, key] of [
        ['actualBoundingBoxLeft', 'left'],
        ['actualBoundingBoxRight', 'right'],
        ['actualBoundingBoxAscent', 'ascent'],
        ['actualBoundingBoxDescent', 'descent'],
      ]) {
        add(`${q}${group}`, { ...row, sk: sk[key], mt: mt[key] })
      }
    }

    for (const text of GLYPHS) {
      const skA = skMeasure(f.family, size, text, 'left', 'alphabetic')
      const sk = skMeasure(f.family, size, text, 'center', 'middle')
      const mt = engine.glyphInk(face, text)
      const mtA = engine.lineInk(face, text)
      const row = { ...at, text, kind: 'glyph' }
      for (const key of ['left', 'right', 'ascent', 'descent']) {
        add(`glyph ${key} (center/middle)${text.trim() ? '' : ' [space]'}`, { ...row, sk: sk[key], mt: mt[key] })
      }
      // The anchoring itself, checked on Skia's own numbers so the pixel
      // rounding of its ink box cancels out: centre = advance / 2, and the
      // vertical move is the middle shift.
      if (skA.right !== 0 || skA.left !== 0) {
        rule.anchor.centerX = Math.max(rule.anchor.centerX, Math.abs(sk.left - (skA.left + skA.width / 2)))
        rule.anchor.middleY = Math.max(rule.anchor.middleY, Math.abs(skA.ascent - sk.ascent - skShift))
        // What Skia's ink box is: integer, and not always an outward rounding.
        for (const key of ['left', 'right', 'ascent', 'descent']) {
          rule.ink.total++
          const s = skA[key]
          const m = mtA[key]
          if (isInt(s)) rule.ink.integer++
          if (Math.abs(s - Math.ceil(m - 1e-9)) < 1e-6) rule.ink.roundOutExact++
          if (Math.abs(s - Math.round(m)) < 1e-6) rule.ink.roundNearestExact++
          if (s < m - 1e-3) rule.ink.inward++
          if (Math.abs(s - m) <= 1 + 1e-6) rule.ink.within1++
        }
        const px = skRasterBox(f.family, size, text)
        if (px) {
          rule.raster.glyphs++
          const off = Math.max(...['left', 'right', 'ascent', 'descent'].map((key) => Math.abs(px[key] - skA[key])))
          rule.raster.worst = Math.max(rule.raster.worst, off)
          if (off < 1e-6) rule.raster.sameBox++
        }
      }
    }
  }
}

// Which vertical metrics table wins. The fixtures alone cannot say: the two
// fonts that set USE_TYPO_METRICS state the same numbers in hhea and OS/2.
// So the tables are edited in memory and both engines read the edited file.
function patchFont(bytes, edits) {
  const out = Buffer.from(bytes)
  const tables = {}
  const n = out.readUInt16BE(4)
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16
    tables[out.toString('latin1', rec, rec + 4)] = out.readUInt32BE(rec + 8)
  }
  for (const [table, offset, value, signed] of edits) {
    const at = tables[table] + offset
    if (signed) out.writeInt16BE(value, at)
    else out.writeUInt16BE(value, at)
  }
  return out
}
const OS2_FS_SELECTION = 62
const USE_TYPO = 0x80
const tmp = mkdtempSync(join(tmpdir(), 'mt-text-parity-'))
function tableCase(label, base, edits) {
  const src = fonts.find((f) => f.key === base)
  const raw = readFileSync(src.path)
  const fs = raw.readUInt16BE(patchOffset(raw, 'OS/2') + OS2_FS_SELECTION)
  const bytes = patchFont(raw, edits(fs))
  const path = join(tmp, `${label.replace(/\W+/g, '_')}.ttf`)
  writeFileSync(path, bytes)
  const family = `MTParity case ${rule.tables.length}`
  GlobalFonts.registerFromPath(path, family)
  const id = engine.addFont(bytes)
  const info = engine.fontInfo(id)
  const size = 100
  const sk = skMeasure(family, size, 'Hg', 'left', 'alphabetic')
  const mt = engine.fontBox(engine.face(id, size))
  const per = (t) => (t ? `${(t.ascent * size) / info.unitsPerEm}/${(t.descent * size) / info.unitsPerEm}` : '-')
  const close = (t) => t && Math.abs(sk.fontAscent - (t.ascent * size) / info.unitsPerEm) < 1e-3 && Math.abs(sk.fontDescent - (t.descent * size) / info.unitsPerEm) < 1e-3
  const v = info.vertical
  const skiaUses = ['hhea', 'typo', 'win'].filter((t) => close(v[t])).join('=') || 'none of the three'
  rule.tables.push({
    label,
    hhea: per(v.hhea),
    typo: per(v.typo),
    win: per(v.win),
    useTypo: v.useTypoMetrics,
    skia: `${fmt(sk.fontAscent, 3)}/${fmt(sk.fontDescent, 3)}`,
    skiaUses,
    engine: `${fmt(mt.ascent, 3)}/${fmt(mt.descent, 3)}`,
    agree: Math.abs(sk.fontAscent - mt.ascent) < 1e-3 && Math.abs(sk.fontDescent - mt.descent) < 1e-3,
  })
  engine.removeFont(id)
}
function patchOffset(buf, tag) {
  const n = buf.readUInt16BE(4)
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16
    if (buf.toString('latin1', rec, rec + 4) === tag) return buf.readUInt32BE(rec + 8)
  }
  throw new Error(`no ${tag} table`)
}
tableCase('DejaVuSans as shipped (hhea != typo, flag off)', 'DejaVuSans', () => [])
tableCase('DejaVuSans + USE_TYPO_METRICS set', 'DejaVuSans', (fs) => [['OS/2', OS2_FS_SELECTION, fs | USE_TYPO, false]])
tableCase('DejaVuSans, hhea ascender/descender zeroed', 'DejaVuSans', () => [
  ['hhea', 4, 0, true],
  ['hhea', 6, 0, true],
])
tableCase('DejaVuSans, hhea and typo zeroed', 'DejaVuSans', () => [
  ['hhea', 4, 0, true],
  ['hhea', 6, 0, true],
  ['OS/2', 68, 0, true],
  ['OS/2', 70, 0, true],
])
tableCase('ComicNeue as shipped (flag on, hhea == typo)', 'ComicNeue', () => [])
tableCase('ComicNeue, typo changed to 800/-200 (flag on)', 'ComicNeue', () => [
  ['OS/2', 68, 800, true],
  ['OS/2', 70, -200, true],
])
tableCase('ComicNeue, typo changed, flag cleared', 'ComicNeue', (fs) => [
  ['OS/2', 68, 800, true],
  ['OS/2', 70, -200, true],
  ['OS/2', OS2_FS_SELECTION, fs & ~USE_TYPO, false],
])
rmSync(tmp, { recursive: true, force: true })

function explain(q, r) {
  if (q.startsWith('advance')) {
    return Math.abs(r.sk - round2(r.mt)) < 1e-4
      ? 'Skia rounds the line width to 0.01 px; engine value rounds to the same number'
      : 'Skia 0.01 px rounding applied per word, not once: one more 0.01 step'
  }
  if (q.startsWith('fontBoundingBox')) return 'float32 precision of the same hhea value'
  if (q.startsWith('middle')) return 'Skia rounds the line height (asc + desc) to a whole pixel before halving; engine does not'
  if (q.includes('[missing glyphs]')) return 'font has no glyph: Skia does not box the .notdef ink the way it boxes real glyphs'
  if (q.includes('[leading/only spaces]') || q.includes('[space]')) {
    return 'Skia unions a zero-size box at the pen origin for a glyph with no ink; engine boxes ink only'
  }
  const inward = r.sk < r.mt - 1e-3
  return inward
    ? 'Skia box = pixels of its hinted raster, here INSIDE the true outline (grid fitting moved an edge)'
    : 'Skia box = whole pixels of its hinted raster; engine is the exact unhinted outline'
}

const showAll = process.argv.includes('--all')
const table = []
console.log(`REF-SK  @napi-rs/canvas (Skia)  vs  mt-text wasm ${sha256File(wasmPath).slice(0, 12)}`)
console.log(`fonts ${fonts.length}, sizes ${SIZES.join(' ')}, strings ${STRINGS.length}, single glyphs ${GLYPHS.length}\n`)
console.log('quantity'.padEnd(44) + 'count'.padStart(6) + 'max'.padStart(10) + 'p99'.padStart(10) + 'p50'.padStart(10))
for (const [q, rows] of Object.entries(samples)) {
  const s = stats(rows.map((r) => r.d))
  table.push({ quantity: q, ...s })
  console.log(q.padEnd(44) + String(s.count).padStart(6) + fmt(s.max).padStart(10) + fmt(s.p99).padStart(10) + fmt(s.p50).padStart(10))
}
console.log('\n10 worst per quantity')
const worst = {}
for (const [q, rows] of Object.entries(samples)) {
  const top = [...rows].sort((a, b) => b.d - a.d).slice(0, showAll ? rows.length : 10)
  worst[q] = top.map((r) => ({ ...r, why: explain(q, r) }))
  console.log(`\n${q}`)
  for (const r of worst[q]) {
    console.log(
      `  ${fmt(r.d).padStart(8)}  ${r.font.padEnd(19)} ${String(r.size).padStart(5)}px ${show(r.text).slice(0, 34).padEnd(34)} skia ${fmt(r.sk, 3).padStart(9)}  engine ${fmt(r.mt, 3).padStart(9)}  ${r.why}`,
    )
  }
}

console.log('\nRULES TESTED AGAINST SKIA')
const w = rule.widthRounded
console.log(`width: skia == round(engine advance, 0.01 px) in ${w.exact}/${w.total} cases; worst residual ${w.maxResidual.toExponential(2)} px`)
console.log(`   the ${rule.widthMisses.total} others: ${rule.widthMisses.ties} are ties at half a hundredth (float32 decides the direction); the rest are one 0.01 step off on long lines`)
console.log(`line box, worst |skia - table * size / upem| over ${rule.box.total} values:`)
console.log(`   hhea ${rule.box.hhea.toExponential(2)}   OS/2 typo ${rule.box.typo.toExponential(2)}   OS/2 win ${rule.box.win.toExponential(2)}   integer-valued: ${rule.box.integerValued}/${rule.box.total}`)
console.log('which table wins, on fonts with edited tables (values at 100 px, ascent/descent):')
for (const t of rule.tables) {
  console.log(`   ${t.label.padEnd(50)} hhea ${t.hhea.padEnd(16)} typo ${t.typo.padEnd(16)} win ${t.win.padEnd(16)} skia ${t.skia.padEnd(15)} = ${t.skiaUses.padEnd(13)} engine ${t.engine.padEnd(15)} ${t.agree ? 'AGREE' : 'DIFFER'}`)
}
console.log('middle baseline shift above alphabetic, worst |skia - formula|:')
for (const [name, r] of Object.entries(rule.middle)) console.log(`   ${r.toExponential(2).padStart(9)}  ${name}`)
console.log(`center/middle anchoring on Skia's own numbers: |left_center - (left + width/2)| <= ${rule.anchor.centerX.toExponential(2)},  |ascent - ascent_middle - shift| <= ${rule.anchor.middleY.toExponential(2)}`)
const k = rule.ink
console.log(`single-glyph ink box (${k.total} values): integer in skia ${k.integer}, equal to ceil(engine) ${k.roundOutExact}, equal to round(engine) ${k.roundNearestExact}, skia INSIDE the true outline ${k.inward}, within 1 px ${k.within1}`)
const ra = rule.raster
console.log(`skia's reported box vs the box of the pixels skia itself paints: identical for ${ra.sameBox}/${ra.glyphs} glyphs, worst edge off by ${ra.worst} px`)

const jsonAt = process.argv.indexOf('--json')
if (jsonAt > 0) {
  writeFileSync(process.argv[jsonAt + 1], `${JSON.stringify({ table, rule, worst }, null, 2)}\n`)
}
