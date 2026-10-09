// Which font each stretch of a line is drawn in, from the mt-text engine.
// Plain ESM with no dependencies; runs unchanged in node and in a browser.
//
//   const engine = await createEngine(wasmBytes)           // engine.mjs
//   lineFonts(engine, { font, flags }, 'AΏB')
//   // [{ font: 1, bold: false, italic: false, start: 0, end: 1 },
//   //  { font: 3, bold: false, italic: false, start: 1, end: 3 },
//   //  { font: 1, bold: false, italic: false, start: 3, end: 4 }]
//
// The parts are the engine's own: the ones it measures the line in and the
// ones the painter paints. They cover the text end to end, in order
// (`start` and `end` are UTF-16 offsets, as a JS string counts), and one
// never ends inside a cluster - a letter and the marks on it are one font's.
// `bold` and `italic` are what the engine synthesises of that font.
//
// A file of its own, beside engine.mjs, because the export it calls is in a
// Rust file of its own (text-engine/src/abi_line_fonts.rs), with its own way
// of passing the text.

const FIELDS = 4
const encoder = new TextEncoder()

/** Whether this build of the engine can say it; an older wasm cannot. */
export function lineFontsSupported(engine) {
  return typeof engine.exports.mt_line_fonts === 'function'
}

/**
 * @param {{ font: number, flags: number }} face an engine face, as every measuring call takes it
 * @returns {Array<{ font: number, bold: boolean, italic: boolean, start: number, end: number }>}
 */
export function lineFonts(engine, face, text) {
  const ex = engine.exports
  if (typeof ex.mt_line_fonts !== 'function') throw new Error('mt-text: this build of the engine cannot say which font drew a line')
  const utf8 = encoder.encode(text)
  // A line of n units has at most n parts; an empty one has one.
  const cap = Math.max(1, text.length) * FIELDS
  const textPtr = utf8.length ? ex.mt_alloc(utf8.length) : 0
  const outPtr = ex.mt_alloc(cap * 4)
  try {
    if ((utf8.length && textPtr === 0) || outPtr === 0) throw new Error('mt-text: out of memory')
    new Uint8Array(ex.memory.buffer).set(utf8, textPtr)
    const n = ex.mt_line_fonts(face.font, face.flags, textPtr, utf8.length, outPtr, cap)
    if (n < 0) throw new Error(n === -2 ? 'mt-text: lineFonts: more parts than there is room for' : 'mt-text: lineFonts: unknown font or chain')
    const view = new DataView(ex.memory.buffer, outPtr, n * FIELDS * 4)
    const out = []
    for (let i = 0; i < n; i++) {
      const at = i * FIELDS * 4
      const synth = view.getUint32(at + 4, true)
      out.push({ font: view.getUint32(at, true), bold: (synth & 1) !== 0, italic: (synth & 2) !== 0, start: view.getUint32(at + 8, true), end: view.getUint32(at + 12, true) })
    }
    return out
  } finally {
    if (textPtr) ex.mt_free(textPtr, utf8.length)
    if (outPtr) ex.mt_free(outPtr, cap * 4)
  }
}
