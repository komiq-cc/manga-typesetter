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

export const ABI_VERSION = 1

const RESULT_SLOTS = 16
const GLYPH_FIELDS = 6
const STATUS = {
  '-1': 'unreadable font or face index out of range',
  '-2': 'unknown font id',
  '-3': 'text is not valid UTF-8',
  '-4': 'shaping failed',
  '-5': 'malformed paint spec',
}

export const SYNTH_BOLD = 1
export const SYNTH_OBLIQUE = 2

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
        vertical: {
          useTypoMetrics: r[5] === 1,
          hhea: line(1, 7),
          typo: line(2, 10),
          win: mask & 4 ? { ascent: r[13], descent: r[14], lineGap: 0 } : null,
        },
      }
    },

    /** A font at a size. `bold`/`italic` ask for the synthesised style. */
    face(font, size, { bold = false, italic = false } = {}) {
      return Object.freeze({ font, size, flags: (bold ? SYNTH_BOLD : 0) | (italic ? SYNTH_OBLIQUE : 0) })
    },

    /** Advance of `text` shaped as one run, no letter spacing. */
    advance(face, text) {
      const w = ex.mt_advance(face.font, face.size, putText(text))
      if (w !== w) throw new Error('mt-text: advance failed (unknown font or shaping error)')
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

    /** UTF-16 offsets of the clusters the font has no glyph for. */
    missing(face, text) {
      const n = check(ex.mt_missing(face.font, putText(text)), 'missing')
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
