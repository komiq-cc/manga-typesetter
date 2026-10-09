// Variation instances of a font the mt-text engine holds. Plain ESM with no
// dependencies; runs unchanged in node and in a browser.
//
//   const engine = await createEngine(wasmBytes)          // engine.mjs
//   const font = engine.addFont(variableFontBytes)        // the default instance
//   const bold = addInstance(engine, font, { wght: 700 }) // another font id
//
// A variable font is one file and many faces. `addFont` registers it where
// its axes start; `addInstance` registers the same bytes again at another
// place, and the id it returns is a font like any other to every call:
// measured, wrapped, painted and named (`fontInfo(...).postScriptName`) there.
// Remove it with `engine.removeFont`.
//
// This is a file of its own, beside engine.mjs, because the export it calls
// is in a Rust file of its own (text-engine/src/abi_instance.rs).

/** Whether this build of the engine can make instances; an older wasm cannot. */
export function instancesSupported(engine) {
  return typeof engine.exports.mt_font_add_instance === 'function'
}

// An axis tag as the engine takes it: four bytes, first letter in the top one.
function tagBits(tag) {
  if (typeof tag !== 'string' || !/^[\x20-\x7e]{4}$/.test(tag)) throw new Error(`mt-text: '${tag}' is not an axis tag`)
  return ((tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) | (tag.charCodeAt(2) << 8) | tag.charCodeAt(3)) >>> 0
}

/**
 * Registers `font` again at another place on its axes. `settings` is
 * `{ tag: value }` in the axes' own units (`{ wght: 700 }`); an axis left out
 * stays where `font` has it, a value past an axis' range stops at its end,
 * and an axis the font does not have is ignored.
 *
 * Everything is looked at before anything is made: a tag that is not one or
 * a value that is not a number throws with the engine as it was. So does an
 * axis the font's file describes as no range at all. Whatever goes wrong,
 * nothing made on the way is left behind.
 * @returns {number} the new font's id
 */
export function addInstance(engine, font, settings) {
  const add = engine.exports.mt_font_add_instance
  if (typeof add !== 'function') throw new Error('mt-text: this build of the engine cannot make font instances')
  const entries = Object.entries(settings ?? {}).map(([tag, value]) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`mt-text: '${tag}' ${value} is not a number`)
    return [tag, tagBits(tag), value]
  })
  if (!entries.length) throw new Error('mt-text: an instance needs at least one axis value')
  // One axis a call: each step is an instance of the one before, and only the
  // last is kept.
  let at = font
  const made = []
  try {
    for (const [tag, bits, value] of entries) {
      const next = add(at, bits, value)
      if (next === 0) throw new Error(`mt-text: unknown font, or the font's '${tag}' axis is not a range`)
      made.push(next)
      at = next
    }
  } catch (error) {
    for (const id of made) engine.removeFont(id)
    throw error
  }
  for (const id of made.slice(0, -1)) engine.removeFont(id)
  return at
}
