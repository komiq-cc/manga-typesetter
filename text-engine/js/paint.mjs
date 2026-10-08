// Painting a glyph job with the mt-text engine. Plain ESM with no
// dependencies; runs unchanged in node and in a browser.
//
//   const engine = await createEngine(wasmBytes)        // engine.mjs
//   const font = engine.addFont(fontBytes)
//   const raster = paintJob(engine, { job, font, synth: { bold: false, italic: false },
//                                     transform: [2, 0, 0, 2, 0, 0], tiles })
//   // raster: { x, y, width, height, data } or null
//
// `job` is what `glyphJob` in src/lib/exporter.js returns, unchanged: plain
// data that says what to draw for one box. This file's whole work is to put
// that into one buffer the engine reads (the layout is documented at
// `decode` in text-engine/src/paint/job.rs) and to hand back the pixels.
//
// What is resolved here rather than in the engine:
//
// - colours. A job carries CSS colour strings; the engine takes four bytes.
//   Only the forms the app writes are read (see `parseColor`).
// - pattern tiles. A job names a pattern by its style; the caller supplies
//   the tile's pixels through `tiles`.
//
// What is NOT resolved here: which font a job's `face` means. The caller
// passes the font id, the synthetic style and the fallback chain beside the
// job (an engine face's `font` and `flags`).
//
// Where the glyphs go is the engine's business: the painter shapes each run
// as the engine measures it, under whichever rules are set (`engine.setRule`),
// fallback chain included. How a synthesised bold is DRAWN is the painter's,
// and a switch: `boldDraw` (see `BOLD_DRAW`).
//
// Nothing in this file calls a `Math` function whose result an engine may
// round differently (sin, cos, pow, ...): the numbers a job carries are
// passed through as they are and all arithmetic on them happens in the wasm.

import { CHAIN_SHIFT, SYNTH_BOLD, SYNTH_OBLIQUE } from './engine.mjs'

export const WIRE_VERSION = 3
const MAGIC = 0x4a50544d // "MTPJ"

const STATUS = {
  '-1': 'unreadable font or face index out of range',
  '-2': 'unknown font id',
  '-3': 'text is not valid UTF-8',
  '-4': 'shaping failed',
  '-5': 'malformed paint job, or a surface larger than the engine allows',
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NUM = '\\s*([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)\\s*'
const RGB = new RegExp(`^rgba?\\(${NUM},${NUM},${NUM}(?:,${NUM})?\\)$`, 'i')

const byte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v))

/**
 * A CSS colour as the app writes one, to `[r, g, b, a]` bytes, straight alpha.
 *
 * Read: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r, g, b)` and
 * `rgba(r, g, b, a)` with plain numbers. That is everything a style, a stroke,
 * a shadow or `stopColor` produces. Anything else (a colour name, `hsl()`,
 * percentages) throws: a painter that guessed would paint the wrong colour
 * without anyone being told.
 */
export function parseColor(css) {
  const s = String(css).trim()
  let m = HEX.exec(s)
  if (m) {
    let h = m[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = parseInt(h.slice(0, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6), 16) : 255
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]
  }
  m = RGB.exec(s)
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4])
    return [byte(Number(m[1])), byte(Number(m[2])), byte(Number(m[3])), byte(a * 255)]
  }
  throw new Error(`mt-text: cannot read the colour ${JSON.stringify(css)}`)
}

const ALIGN = { left: 0, start: 0, center: 1, right: 2, end: 2 }

/**
 * How a synthesised bold is drawn (`request.boldDraw`):
 * - `rule` (the default): the way that goes with the engine's `boldAdvance`
 *   rule, `outset` for `unchanged` and `smear` for `webkit`. The engine's
 *   ink (`lineInk`) is measured for that drawing, so this is the one that
 *   paints what was measured.
 * - `outset`: the outline grown on every side by the engine's bold pen. Skia's way.
 * - `smear`: the glyph and a second one `size / 36` to its right, as one shape. WebKit's way.
 */
export const BOLD_DRAW = { rule: 0, outset: 1, smear: 2 }

/** The largest `request.weight` the engine accepts, in device pixels. */
export const MAX_WEIGHT = 64

// One buffer for every job, grown when a job does not fit.
let buf = new ArrayBuffer(4096)
let view = new DataView(buf)
let u8 = new Uint8Array(buf)
let at = 0
const encoder = new TextEncoder()

function need(n) {
  if (at + n <= buf.byteLength) return
  const grown = new ArrayBuffer(Math.max(buf.byteLength * 2, at + n))
  new Uint8Array(grown).set(u8.subarray(0, at))
  buf = grown
  view = new DataView(buf)
  u8 = new Uint8Array(buf)
}
function u32(v) {
  need(4)
  view.setUint32(at, v >>> 0, true)
  at += 4
}
function f64(v) {
  need(8)
  view.setFloat64(at, +v, true)
  at += 8
}
function rgba(css) {
  const c = parseColor(css)
  need(4)
  u8[at] = c[0]
  u8[at + 1] = c[1]
  u8[at + 2] = c[2]
  u8[at + 3] = c[3]
  at += 4
}
function stops(list) {
  u32(list.length)
  for (const st of list) {
    f64(st.pos)
    rgba(st.color)
  }
}

/** Writes a fill; `tileIndex(fill)` gives a pattern's tile number or -1. */
function fill(f, tileIndex) {
  if (!f) return u32(0)
  switch (f.kind) {
    case 'solid':
      u32(1)
      return rgba(f.color)
    case 'linear':
      u32(2)
      f64(f.x0)
      f64(f.y0)
      f64(f.x1)
      f64(f.y1)
      return stops(f.stops)
    case 'radial':
      u32(3)
      f64(f.cx)
      f64(f.cy)
      f64(f.r)
      return stops(f.stops)
    case 'pattern': {
      u32(4)
      // No tile: the engine paints the style's flat colour, as the canvas
      // painter does when it cannot make a pattern.
      const i = tileIndex(f)
      u32(i < 0 ? 0xffffffff : i)
      f64(f.px)
      f64(f.ax)
      f64(f.ay)
      return rgba(f.style.color)
    }
    default:
      throw new Error(`mt-text: unknown fill kind ${JSON.stringify(f.kind)}`)
  }
}

/** Synthetic styles and fallback chain as an engine face's `flags`. */
function faceFlags(synth) {
  if (typeof synth === 'number') return synth
  if (!synth) return 0
  return (synth.bold ? SYNTH_BOLD : 0) | (synth.italic || synth.oblique ? SYNTH_OBLIQUE : 0)
}

/**
 * A job and what goes with it, as the bytes the engine reads.
 *
 * @param {object} request
 * @param {object} request.job as `glyphJob` returns it
 * @param {number} request.font font id from `engine.addFont`
 * @param {number} [request.size] font size in job units; defaults to `job.face.size`
 * @param {{bold?: boolean, italic?: boolean} | number} [request.synth] styles to synthesise,
 *   or an engine face's `flags`, which hold the fallback chain as well
 * @param {number} [request.chain] fallback chain (`engine.chainNew`) a letter the font
 *   lacks is drawn from; defaults to the one in `synth` when that is a face's flags, else none
 * @param {'rule' | 'outset' | 'smear'} [request.boldDraw] how a synthesised bold is drawn, see `BOLD_DRAW`
 * @param {number} [request.weight] extra weight in device pixels, 0 to `MAX_WEIGHT`: every
 *   filled glyph shape is grown by that much on every side before it is painted, and bands
 *   lie round the grown shape. Default 0: the outline as the font has it.
 * @param {number[]} [request.transform] `[a, b, c, d, e, f]`, job space to device pixels;
 *   the canvas's current transform. Defaults to the identity.
 * @param {(fill: object) => ({width: number, height: number, data: ArrayLike<number>} | null)} [request.tiles]
 *   called for every pattern fill; returns the tile's straight RGBA8 pixels
 *   (`getImageData` of `patternTileCanvas(fill.style, TILE_SS)`), or null to
 *   have the pattern painted in the style's flat colour. The same object
 *   returned twice is sent once.
 * @returns {Uint8Array} a view of a buffer that the next call overwrites
 */
export function encodeJob({ job, font, size, synth, chain, boldDraw = 'rule', weight = 0, transform, tiles }) {
  at = 0
  const sent = []
  const tileIndex = (f) => {
    const tile = tiles ? tiles(f) : null
    if (!tile || !(tile.width > 0) || !(tile.height > 0)) return -1
    if (tile.data.length !== tile.width * tile.height * 4) {
      throw new Error('mt-text: a pattern tile needs width * height * 4 bytes of RGBA')
    }
    const i = sent.indexOf(tile)
    return i >= 0 ? i : sent.push(tile) - 1
  }
  const m = transform ?? [1, 0, 0, 1, 0, 0]
  u32(MAGIC)
  u32(WIRE_VERSION)
  if (!Object.hasOwn(BOLD_DRAW, boldDraw)) throw new Error(`mt-text: unknown boldDraw ${JSON.stringify(boldDraw)}`)
  if (!(weight >= 0 && weight <= MAX_WEIGHT)) throw new Error(`mt-text: weight is 0 to ${MAX_WEIGHT} device pixels, not ${weight}`)
  const flags = faceFlags(synth)
  u32(font)
  u32(flags & ((1 << CHAIN_SHIFT) - 1))
  u32(chain ?? flags >>> CHAIN_SHIFT)
  u32(BOLD_DRAW[boldDraw])
  f64(size ?? job.face?.size)
  for (let i = 0; i < 6; i++) f64(m[i])
  f64(weight)
  u32((job.curved ? 1 : 0) | (job.silhouette ? 2 : 0))
  // An alignment the canvas does not know leaves its `textAlign` at "start".
  u32(ALIGN[job.align] ?? 0)
  f64(job.letterSpacing || 0)
  rgba(job.silhouette || '#000000')
  u32(job.bands.length)
  for (const band of job.bands) {
    rgba(band.color)
    f64(band.opacity)
    f64(band.line)
  }
  fill(job.fill, tileIndex)
  u32(job.runs.length)
  for (const run of job.runs) {
    f64(run.x)
    f64(run.y)
    f64(run.rot ?? 0)
    fill(run.fill, tileIndex)
    const text = String(run.text)
    // A UTF-16 unit is at most 3 UTF-8 bytes.
    need(4 + text.length * 3)
    const { written } = encoder.encodeInto(text, u8.subarray(at + 4))
    u32(written)
    at += written
  }
  u32(sent.length)
  for (const tile of sent) {
    u32(tile.width)
    u32(tile.height)
    need(tile.data.length)
    u8.set(tile.data, at)
    at += tile.data.length
  }
  return u8.subarray(0, at)
}

/**
 * Paints one job.
 *
 * @param {object} engine from `createEngine`
 * @param {object} request see `encodeJob`; also
 * @param {boolean} [request.view] return `data` as a view into the engine's
 *   memory instead of a copy. The view is valid only until the next call
 *   into the engine.
 * @returns {{x: number, y: number, width: number, height: number, data: Uint8ClampedArray} | null}
 *   straight-alpha RGBA8 and the device pixel of its top-left corner, cut to
 *   what the job inks (strokes included); null when the job draws nothing.
 */
export function paintJob(engine, request) {
  const ex = engine.exports
  if (!ex.mt_paint_job) throw new Error('mt-text: this wasm was built without the paint feature')
  if (ex.mt_paint_wire_version() !== WIRE_VERSION) {
    throw new Error(`mt-text: wasm reads paint jobs v${ex.mt_paint_wire_version()}, loader writes v${WIRE_VERSION}`)
  }
  const bytes = encodeJob(request)
  const ptr = ex.mt_paint_job_reserve(bytes.length)
  if (!ptr) throw new Error(`mt-text: paintJob: the engine refused a job of ${bytes.length} bytes`)
  // Views over wasm memory are made after the last call that can grow it.
  new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes)
  const code = ex.mt_paint_job(bytes.length)
  if (code < 0) throw new Error(`mt-text: paintJob: ${STATUS[code] ?? `error ${code}`}`)
  if (code === 0) return null
  const [x, y, width, height] = new Float64Array(ex.memory.buffer, ex.mt_paint_job_result(), 4)
  const pixels = ex.mt_paint_job_pixels()
  const len = width * height * 4
  const data = request.view
    ? new Uint8ClampedArray(ex.memory.buffer, pixels, len)
    : new Uint8ClampedArray(ex.memory.buffer.slice(pixels, pixels + len))
  return { x, y, width, height, data }
}

/** Frees the engine's copy of the last raster. The next job would replace it anyway. */
export function releaseRaster(engine) {
  engine.exports.mt_paint_job_release?.()
}

/**
 * A hash of one raster (or of `null`, a job that drew nothing): 16 hex
 * digits over its origin, its size and its bytes. Plain arithmetic on 32-bit
 * integers, so it is the same number in node and in every browser; it is for
 * telling two rasters apart, not for security. The native example
 * (`text-engine/examples/paint_hash.rs`) computes the same.
 */
export function rasterHash(raster) {
  // Two independent 32-bit hashes side by side: FNV-1a, and Jenkins's
  // one-at-a-time.
  let a = 0x811c9dc5
  let b = 0
  const eat = (bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i]
      a = Math.imul(a ^ v, 0x01000193)
      b = (b + v) | 0
      b = (b + (b << 10)) | 0
      b ^= b >>> 6
    }
  }
  if (raster) {
    eat(new Uint8Array(new Int32Array([raster.x, raster.y, raster.width, raster.height]).buffer))
    eat(raster.data)
  }
  b = (b + (b << 3)) | 0
  b ^= b >>> 11
  b = (b + (b << 15)) | 0
  const hex = (v) => (v >>> 0).toString(16).padStart(8, '0')
  return hex(a) + hex(b)
}

/** One hash of a list of hashes, by the same function. */
export function combineHashes(hashes) {
  const text = hashes.join('')
  const codes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) codes[i] = text.charCodeAt(i)
  return rasterHash({ x: 0, y: 0, width: hashes.length, height: 1, data: codes })
}

/**
 * Paints every request and hashes the rasters: one hash each and one of them
 * all. For checking that the painter's bytes are the same in every engine
 * that runs the wasm.
 *
 * @param {object} engine from `createEngine`
 * @param {object[]} requests see `encodeJob`
 * @returns {{hash: string, each: string[]}}
 */
export function hashJobs(engine, requests) {
  const each = requests.map((request) => rasterHash(paintJob(engine, { ...request, view: true })))
  return { hash: combineHashes(each), each }
}
