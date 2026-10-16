// Loader for the mt-text WebAssembly engine. Plain ESM with no dependencies;
// runs unchanged in node and in a browser.
//
//   const engine = await createEngine(wasmBytes)
//   const font = engine.addFont(fontBytes)
//   const face = engine.face(font, 22.5)
//   engine.advance(face, 'WHAT?!')
//
// Instantiation is the only async step. Every method afterwards is a plain
// synchronous call, which is what the layout code needs.
//
// Units: sizes, advances and ink extents are CSS pixels; `shapeUnits` is the
// raw run in font units. Text offsets are UTF-16 code units, i.e. JS string
// indices.

export const ABI_VERSION = 2

const RESULT_SLOTS = 16
const GLYPH_FIELDS = 6
const STATUS = {
  '-1': 'unreadable font or face index out of range',
  '-2': 'unknown font or chain id',
  '-3': 'text is not valid UTF-8',
  '-4': 'shaping failed',
  '-5': 'malformed paint spec',
}

export const SYNTH_BOLD = 1
export const SYNTH_OBLIQUE = 2
/** A face's `flags` hold the synthetic styles in the low byte and a fallback chain's handle above it. */
export const CHAIN_SHIFT = 8

/** The rules that are switches (`engine.setRule`), and their values. */
export const RULES = {
  boldAdvance: { id: 1, values: { unchanged: 0, webkit: 1 } },
  fontBox: { id: 2, values: { browser: 0, skia: 1 } },
}

/**
 * @param {BufferSource | WebAssembly.Module} source the bytes of mt_text.wasm, or a compiled module
 */
export async function createEngine(source) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source)
  // The module imports nothing: no env, no wasi, no JS glue.
  const instance = await WebAssembly.instantiate(module, {})
  return wrap(instance)
}

function wrap(instance) {
  const ex = instance.exports
  const memory = ex.memory
  if (!(memory instanceof WebAssembly.Memory)) throw new Error('mt-text: wasm export "memory" is missing')
  const abi = ex.mt_abi_version()
  if (abi !== ABI_VERSION) throw new Error(`mt-text: wasm ABI ${abi}, loader expects ${ABI_VERSION}`)

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  // Views die when linear memory grows (the old ArrayBuffer is detached and
  // its length drops to 0), so they are re-made on demand, never trusted.
  let u8 = new Uint8Array(memory.buffer)
  let f64 = null
  const resultPtr = ex.mt_result_ptr()
  const bytes = () => (u8.byteLength === 0 ? (u8 = new Uint8Array(memory.buffer)) : u8)
  const result = () =>
    f64 === null || f64.byteLength === 0 ? (f64 = new Float64Array(memory.buffer, resultPtr, RESULT_SLOTS)) : f64

  let textPtr = 0
  let textCap = 0
  // `sfxInfo` fills both: the table, and each kind's number on the wire.
  let sfxInfoCache = null
  let sfxKindIds = null

  /** Writes `text` as UTF-8 into the engine's text buffer, returns its byte length. */
  function putText(text) {
    const n = text.length
    // A UTF-16 unit is at most 3 UTF-8 bytes.
    if (n * 3 > textCap) {
      textCap = Math.max(256, n * 6)
      textPtr = ex.mt_text_reserve(textCap)
    }
    const mem = bytes()
    // Comic dialogue is almost always ASCII, and a byte loop beats the call
    // into encodeInto for the short strings the breaker measures.
    let i = 0
    for (; i < n; i++) {
      const c = text.charCodeAt(i)
      if (c > 0x7f) break
      mem[textPtr + i] = c
    }
    if (i === n) return n
    return encoder.encodeInto(text, mem.subarray(textPtr, textPtr + textCap)).written
  }

  function check(code, what) {
    if (code < 0) throw new Error(`mt-text: ${what}: ${STATUS[code] ?? `error ${code}`}`)
    return code
  }

  const outBytes = () => {
    const ptr = ex.mt_out_ptr()
    const len = ex.mt_out_len()
    return bytes().subarray(ptr, ptr + len)
  }
  const outU32 = (count) => {
    const ptr = ex.mt_out_ptr()
    // Copied out: the buffer is reused by the next call.
    return new Uint32Array(memory.buffer.slice(ptr, ptr + count * 4))
  }

  function readInk(r) {
    return { width: r[0], left: r[1], right: r[2], ascent: r[3], descent: r[4], hasInk: r[5] === 1 }
  }

  const engine = {
    abiVersion: abi,

    /**
     * Registers one face of a font file (TTF/OTF/TTC). The bytes are copied
     * into wasm memory once and owned by the engine from then on.
     * @returns {number} font id
     */
    addFont(data, faceIndex = 0) {
      const src = data instanceof Uint8Array ? data : new Uint8Array(data)
      const ptr = ex.mt_alloc(src.byteLength)
      if (ptr === 0) throw new Error(`mt-text: could not allocate ${src.byteLength} bytes for a font`)
      bytes().set(src, ptr)
      // mt_font_add owns `ptr` from here, on failure too.
      const id = ex.mt_font_add(ptr, src.byteLength, faceIndex)
      if (id === 0) throw new Error('mt-text: unreadable font or face index out of range')
      return id
    },

    /** Registers another face of an already loaded file (TTC) without a second copy. */
    addSiblingFace(font, faceIndex) {
      const id = ex.mt_font_add_sibling(font, faceIndex)
      if (id === 0) throw new Error('mt-text: unknown font or face index out of range')
      return id
    },

    removeFont(font) {
      return ex.mt_font_remove(font) === 1
    },

    fontInfo(font) {
      check(ex.mt_font_info(font), 'fontInfo')
      const r = result()
      const lines = decoder.decode(outBytes()).split('\n')
      const mask = r[6]
      const line = (bit, i) =>
        mask & bit ? { ascent: r[i], descent: r[i + 1], lineGap: bit === 4 ? 0 : r[i + 2] } : null
      const axisCount = r[2]
      return {
        family: lines[0],
        subfamily: lines[1],
        fullName: lines[2],
        postScriptName: lines[3],
        typographicFamily: lines[4],
        unitsPerEm: r[0],
        glyphCount: r[1],
        isVariable: axisCount > 0,
        axes: lines.slice(5, 5 + axisCount).map((l) => {
          const [tag, min, def, max] = l.split(' ')
          return { tag, min: +min, default: +def, max: +max }
        }),
        facesInFile: r[3],
        byteLength: r[4],
        /** TrueType outlines (`glyf`) rather than CFF. */
        trueType: r[15] === 1,
        vertical: {
          useTypoMetrics: r[5] === 1,
          hhea: line(1, 7),
          typo: line(2, 10),
          win: mask & 4 ? { ascent: r[13], descent: r[14], lineGap: 0 } : null,
        },
      }
    },

    /**
     * A font at a size. `bold`/`italic` ask for the synthesised style;
     * `chain` (from `chainNew`) is where a letter the font lacks is looked for.
     */
    face(font, size, { bold = false, italic = false, chain = 0 } = {}) {
      return Object.freeze({
        font,
        size,
        flags: (bold ? SYNTH_BOLD : 0) | (italic ? SYNTH_OBLIQUE : 0) | (chain << CHAIN_SHIFT),
      })
    },

    /**
     * Sets one of the rules that are switches, e.g. `setRule('boldAdvance', 'webkit')`.
     * Every number measured before the call may be stale after it.
     */
    setRule(name, value) {
      const rule = RULES[name]
      if (!rule || !(value in rule.values)) throw new Error(`mt-text: unknown rule ${name}=${value}`)
      check(ex.mt_rule_set(rule.id, rule.values[value]), 'setRule')
    },

    /** An empty fallback chain; fonts pushed earlier are preferred. */
    chainNew() {
      return ex.mt_chain_new()
    },
    chainPush(chain, font, { bold = false, italic = false } = {}) {
      check(ex.mt_chain_push(chain, font, (bold ? SYNTH_BOLD : 0) | (italic ? SYNTH_OBLIQUE : 0)), 'chainPush')
    },
    chainFree(chain) {
      return ex.mt_chain_free(chain) === 1
    },

    /**
     * Advance of `text`, no letter spacing. Tab, LF, FF and CR are measured
     * as a space, as a canvas measures them.
     */
    advance(face, text) {
      const w = ex.mt_advance(face.font, face.size, face.flags, putText(text))
      if (w !== w) throw new Error('mt-text: advance failed (unknown font or chain, or shaping error)')
      return w
    },

    fontBox(face) {
      check(ex.mt_font_box(face.font, face.size, face.flags), 'fontBox')
      const r = result()
      return { ascent: r[0], descent: r[1] }
    },

    /** Ink extents, left-aligned, alphabetic baseline (canvas actualBoundingBox*). */
    lineInk(face, text) {
      check(ex.mt_line_ink(face.font, face.size, face.flags, putText(text)), 'lineInk')
      return readInk(result())
    },

    /** Ink extents of one glyph anchored at its centre on the `middle` baseline. */
    glyphInk(face, text) {
      check(ex.mt_glyph_ink(face.font, face.size, face.flags, putText(text)), 'glyphInk')
      return readInk(result())
    },

    /**
     * The shaped run in font units: 6 int32 per glyph
     * (glyph id, cluster, xAdvance, yAdvance, xOffset, yOffset).
     * @returns {Int32Array} a copy
     */
    shapeUnits(font, text) {
      const count = check(ex.mt_shape(font, putText(text)), 'shape')
      const ptr = ex.mt_run_ptr()
      return new Int32Array(memory.buffer.slice(ptr, ptr + count * GLYPH_FIELDS * 4))
    },

    /**
     * Glyphs with pen positions in pixels, and one entry per cluster for
     * carets. `x` is where the glyph's origin sits; `advance` is its own.
     */
    shapeLine(face, text) {
      const run = engine.shapeUnits(face.font, text)
      check(ex.mt_font_info(face.font), 'shapeLine')
      const scale = face.size / result()[0]
      const glyphs = []
      const clusters = []
      let pen = 0
      for (let i = 0; i < run.length; i += GLYPH_FIELDS) {
        const cluster = run[i + 1]
        const adv = run[i + 2]
        glyphs.push({
          id: run[i],
          cluster,
          x: (pen + run[i + 4]) * scale,
          y: run[i + 5] * scale,
          advance: adv * scale,
        })
        const last = clusters[clusters.length - 1]
        if (last && last.start === cluster) last.width += adv * scale
        else clusters.push({ start: cluster, x: pen * scale, width: adv * scale })
        pen += adv
      }
      return { advance: pen * scale, glyphs, clusters }
    },

    /** Whether this wasm has `lineCarets` (it is newer than the ABI number). */
    hasLineCarets: typeof ex.mt_line_carets === 'function',

    /**
     * Where a caret stands on a painted line: the pen of every cluster, from
     * the painter's own shaping of the line (`paint::shape_run`), letter
     * spacing included.
     * @returns {{ at: number[], x: number[], length: number, advance: number }}
     *   `at[k]` the UTF-16 offset of cluster k in `text` and `x[k]` its pen in
     *   pixels from the line's start, in drawing order; `advance` what the
     *   painter aligns the line by.
     */
    lineCarets(face, text, letterSpacing = 0) {
      if (!ex.mt_line_carets) throw new Error('mt-text: this wasm has no mt_line_carets; run npm run build:engine')
      const n = check(ex.mt_line_carets(face.font, face.size, face.flags, putText(text), letterSpacing), 'lineCarets')
      const ptr = ex.mt_out_ptr()
      // Read through a view of its own: the out buffer is bytes and need not
      // sit on an 8-byte boundary.
      const view = new DataView(memory.buffer, ptr, (n + 1) * 16)
      const at = new Array(n)
      const x = new Array(n)
      for (let i = 0; i < n; i++) {
        at[i] = view.getFloat64(i * 16, true)
        x[i] = view.getFloat64(i * 16 + 8, true)
      }
      return { at, x, length: view.getFloat64(n * 16, true), advance: view.getFloat64(n * 16 + 8, true) }
    },

    /** Whether this wasm has `sfxLayout` and `sfxInfo` (it is newer than the ABI number). */
    hasSfx: typeof ex.mt_sfx_layout === 'function' && typeof ex.mt_sfx_info === 'function',

    /** Whether this wasm has `sfxEnvelope`. */
    hasSfxEnvelope: typeof ex.mt_sfx_envelope === 'function',

    /**
     * The kinds of SFX move and the built-in presets, as the engine's table
     * has them (text-engine/src/sfx/table.rs): one JSON document, parsed once
     * and the same object every time, so read it and do not change it.
     * @returns {{ kinds: Array<{ kind: string, label: string, unit: 'em' | 'deg' | 'x',
     *     min: number, max: number, step: number,
     *     b: null | { label: string, min: number, max: number, step: number, default: number } }>,
     *   presets: Array<{ id: string, name: string, group: string, flow: 'row' | 'stack',
     *     rowShift: number, gap: number, lineHeight: number | null,
     *     envelope: null | { kind: 'arch' | 'valley' | 'flag' | 'rise', bend: number, cols: number, rows: number },
     *     moves: Array<{ kind: string, a: number, b: number }> }>,
     *   envelopes: string[] }} `envelopes` are the warp ids; `sfxEnvelope` takes one
     */
    sfxInfo() {
      if (sfxInfoCache) return sfxInfoCache
      if (!engine.hasSfx) throw new Error('mt-text: this wasm has no mt_sfx_info; run npm run build:engine')
      check(ex.mt_sfx_info(), 'sfxInfo')
      sfxInfoCache = JSON.parse(decoder.decode(outBytes()))
      sfxKindIds = new Map(sfxInfoCache.kinds.map((k, i) => [k.kind, i]))
      return sfxInfoCache
    },

    /**
     * Where each letter of an SFX word goes. The engine measures every code
     * point in `face` (as `advance` measures that one code point) and places it:
     * its centre, turn, scale and lean, relative to the centre of the whole
     * block (text-engine/src/sfx/mod.rs says how, move by move).
     *
     * @param {{ font: number, size: number, flags: number }} face from `engine.face`
     * @param {string[]} rows the lines of the text; a `\n` inside one starts another row
     * @param {{ lineHeight: number, letterSpacing?: number, amount?: number, seed?: number,
     *   flow?: 'row' | 'stack', rowShift?: number,
     *   moves?: Array<{ kind: string, a: number, b?: number }> }} params
     *   pixels for `lineHeight` and `letterSpacing`; `amount` scales every move (default 1);
     *   `rowShift` in ems; at most eight moves count, and a kind the engine does not know is skipped
     * @returns {Array<{ ch: string, x: number, y: number, rot: number, sx: number, sy: number,
     *   skew: number, w: number, drip: number }>} one per code point, in order, newlines left out.
     *   `x`, `y` in pixels; `rot` and `skew` in radians (rot clockwise; a positive skew leans the
     *   top right); `w` the letter's advance before scaling; `drip` pixels (never negative) the
     *   painter pulls the lower half of the letter's outline down while its top stays put. Feed
     *   `x, y, rot, sx, sy, skew` to a curved paint job's run (`paint.mjs`).
     */
    sfxLayout(face, rows, params) {
      if (!engine.hasSfx) throw new Error('mt-text: this wasm has no mt_sfx_layout; run npm run build:engine')
      engine.sfxInfo()
      const lines = rows.flatMap((row) => String(row).split('\n'))
      const chars = lines.flatMap((line) => Array.from(line))
      const moves = (params.moves ?? []).filter((m) => sfxKindIds.has(m.kind))
      const flow = params.flow ?? 'row'
      if (flow !== 'row' && flow !== 'stack') throw new Error(`mt-text: unknown sfx flow ${JSON.stringify(flow)}`)
      // The recipe: see text-engine/src/sfx/wire.rs. The size is the face's.
      const wire = new DataView(new ArrayBuffer(44 + moves.length * 20))
      const nums = [params.lineHeight, params.letterSpacing ?? 0, params.amount ?? 1, params.rowShift ?? 0]
      nums.forEach((v, i) => wire.setFloat64(i * 8, +v, true))
      wire.setUint32(32, (params.seed ?? 1) >>> 0, true)
      wire.setUint32(36, flow === 'stack' ? 1 : 0, true)
      wire.setUint32(40, moves.length, true)
      moves.forEach((m, i) => {
        const at = 44 + i * 20
        wire.setUint32(at, sfxKindIds.get(m.kind), true)
        wire.setFloat64(at + 4, +m.a, true)
        wire.setFloat64(at + 12, +(m.b ?? 0), true)
      })
      const textLen = putText(lines.join('\n'))
      const ptr = ex.mt_sfx_params_reserve(wire.byteLength)
      if (!ptr) throw new Error('mt-text: sfxLayout: the engine refused the recipe buffer')
      new Uint8Array(memory.buffer, ptr, wire.byteLength).set(new Uint8Array(wire.buffer))
      const n = check(ex.mt_sfx_layout(face.font, face.size, face.flags, textLen, wire.byteLength), 'sfxLayout')
      if (n !== chars.length) throw new Error(`mt-text: sfxLayout: ${n} records for ${chars.length} letters`)
      // Read through a view of its own: the out buffer is bytes and need not
      // sit on an 8-byte boundary.
      const view = new DataView(memory.buffer, ex.mt_out_ptr(), n * 64)
      return chars.map((ch, i) => {
        const f = (k) => view.getFloat64(i * 64 + k * 8, true)
        return { ch, x: f(0), y: f(1), rot: f(2), sx: f(3), sy: f(4), skew: f(5), w: f(6), drip: f(7) }
      })
    },

    /**
     * Where the nodes of a warp grid go (text-engine/src/sfx/envelope.rs): the
     * identity grid of `cols` by `rows` cells over a box `w` by `h`, bent into
     * the envelope by `bend` (a fraction of `h`, held to -2..2). This is the
     * app's `style.warp.pts`.
     *
     * @param {'arch' | 'valley' | 'flag' | 'rise'} kind one of `sfxInfo().envelopes`
     * @param {number} bend
     * @param {number} cols 1 to 64
     * @param {number} rows 1 to 64
     * @param {number} w pixels, above 0
     * @param {number} h pixels, above 0
     * @returns {Array<[number, number]>} `(cols + 1) * (rows + 1)` points, row-major, top-left first
     */
    sfxEnvelope(kind, bend, cols, rows, w, h) {
      if (!engine.hasSfxEnvelope) throw new Error('mt-text: this wasm has no mt_sfx_envelope; run npm run build:engine')
      const id = engine.sfxInfo().envelopes.indexOf(kind)
      if (id < 0) throw new Error(`mt-text: unknown sfx envelope ${JSON.stringify(kind)}`)
      const n = check(ex.mt_sfx_envelope(id, +bend, cols >>> 0, rows >>> 0, +w, +h), 'sfxEnvelope')
      // Read through a view of its own: the out buffer need not sit on an 8-byte boundary.
      const view = new DataView(memory.buffer, ex.mt_out_ptr(), n * 16)
      const pts = new Array(n)
      for (let i = 0; i < n; i++) pts[i] = [view.getFloat64(i * 16, true), view.getFloat64(i * 16 + 8, true)]
      return pts
    },

    /**
     * Greedy UAX #14 wrapping (CSS `white-space: pre-wrap; overflow-wrap: break-word`).
     * @returns {Array<[number, number]>} [start, end) of every line, end excludes the newline
     */
    wrapPlain(face, text, { width, letterSpacing = 0 }) {
      const n = check(
        ex.mt_wrap_plain(face.font, face.size, face.flags, putText(text), width, letterSpacing),
        'wrapPlain',
      )
      const flat = outU32(n * 2)
      const lines = []
      for (let i = 0; i < n; i++) lines.push([flat[2 * i], flat[2 * i + 1]])
      return lines
    },

    /** UTF-16 offsets of the clusters neither the font nor its fallback chain has a glyph for. */
    missing(face, text) {
      const n = check(ex.mt_missing(face.font, face.flags, putText(text)), 'missing')
      return Array.from(outU32(n))
    },

    /**
     * Paints shaped lines: one round-join stroke of width `stroke.width`
     * (outside the outline; the pen is twice that, as canvas `lineWidth`),
     * unioned over all lines, under a solid fill.
     *
     * @param {{ width: number, height: number, transform?: number[],
     *   lines: Array<{ face: object, text: string, x: number, y: number }>,
     *   stroke?: { width: number, color: number }, fill?: number }} spec
     *   sizes in device pixels, `transform` as canvas setTransform(a..f),
     *   line origins in user space on the alphabetic baseline, colours 0xRRGGBBAA
     * @returns {{ width: number, height: number, data: Uint8ClampedArray }} straight-alpha RGBA8, a copy
     */
    paint(spec) {
      if (!ex.mt_paint_begin) throw new Error('mt-text: this wasm was built without the paint feature')
      const [a, b, c, d, e, f] = spec.transform ?? [1, 0, 0, 1, 0, 0]
      check(ex.mt_paint_begin(spec.width, spec.height, a, b, c, d, e, f), 'paint')
      for (const line of spec.lines) {
        const { face } = line
        check(ex.mt_paint_line(face.font, face.size, face.flags, putText(line.text), line.x, line.y), 'paint')
      }
      if (spec.stroke && spec.stroke.width > 0) {
        check(ex.mt_paint_stroke(spec.stroke.width * 2, spec.stroke.color >>> 0), 'paint')
      }
      if (spec.fill !== undefined) check(ex.mt_paint_fill(spec.fill >>> 0), 'paint')
      const len = check(ex.mt_paint_end(), 'paint')
      const ptr = ex.mt_out_ptr()
      return {
        width: spec.width,
        height: spec.height,
        data: new Uint8ClampedArray(memory.buffer.slice(ptr, ptr + len)),
      }
    },

    /** Bytes the engine holds for one font: the file plus its caches. */
    fontBytesHeld(font) {
      return ex.mt_font_bytes_held(font)
    },

    /** Live heap bytes inside the wasm instance. */
    heapLive() {
      return ex.mt_heap_live()
    },

    /** Size of the instance's linear memory. It only ever grows. */
    memoryBytes() {
      return memory.buffer.byteLength
    },

    /** Raw exports, for benchmarks that want to time the boundary itself. */
    exports: ex,
    putText,
  }
  return engine
}
