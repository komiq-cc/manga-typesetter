// What the Rust text engine drew a piece of text in, for whoever has to NAME
// it afterwards: the PSD writer puts a font's PostScript name and two "this
// was synthesised" flags into every type layer, and Photoshop sets the layer
// by them.
//
// Nothing here decides anything. Which face a weight and slant get, and what
// is synthesised of it, is the adapter's rule (`matchSlot`, rust.js); which
// family lends a letter the face lacks is the engine's chain (RULES.md rules
// 10 and 11). This file asks the adapter what it did and reads the name out
// of the font the engine holds - the bytes that were drawn, whichever source
// they came from: a file of the user's, an installed font, a WOFF the native
// side decoded.
//
// `engine` is the adapter `createRustTextEngine` makes; a `face` is what
// `faceFor` (measure.js) makes of a style.

/** The PostScript name (name ID 6) of one engine font; '' when the font states none. */
export function postScriptNameOf(engine, font) {
  try {
    return engine.low.fontInfo(font).postScriptName || '';
  } catch {
    return '';
  }
}

/**
 * The face a request is drawn in, as `{ family, slot, fauxBold, fauxItalic,
 * postScriptName }`: the slot the engine resolved, whether it emboldened or
 * slanted that face itself, and the font's own name. Null for a family the
 * engine does not hold.
 */
export function drawnFace(engine, face) {
  const resolved = engine.resolveFace(face);
  if (!resolved) return null;
  return {
    family: face.name,
    slot: resolved.slot,
    fauxBold: resolved.fauxBold,
    fauxItalic: resolved.fauxItalic,
    postScriptName: postScriptNameOf(engine, engine.handle(face).font),
  };
}

/**
 * `text` cut into the stretches that are drawn from one face each, in order,
 * as `[{ start, end, own, family, slot, fauxBold, fauxItalic, postScriptName }]`
 * (UTF-16 offsets, `end` exclusive; together they cover the text).
 *
 * `own` is the face that was asked for. Every other run is a family of the
 * engine's fallback list lending the letters the face lacks: the FIRST of
 * the list that has the letter, with the face of it the engine lends to this
 * weight and slant. A letter nothing has is drawn as the face's own empty
 * box, so it stays in the face's own run; so does everything that is not a
 * letter the face lacks - spaces and line ends among them.
 *
 * Null for a family the engine does not hold.
 */
export function drawnRuns(engine, face, text) {
  const own = drawnFace(engine, face);
  if (!own) return null;
  const whole = [{ start: 0, end: text.length, own: true, ...own }];
  const lacking = engine.missing(face, text, 0);
  if (!lacking.length) return whole;
  const lenders = engine.lenders(face.bold, face.italic);
  // code point -> index of the family that draws it; absent when none does.
  const from = new Map();
  let left = lacking;
  for (let depth = 1; depth <= lenders.length && left.length; depth++) {
    const still = engine.missing(face, text, depth);
    for (const cp of left) if (!still.includes(cp) && lenders[depth - 1]) from.set(cp, depth - 1);
    left = still;
  }
  if (!from.size) return whole;
  const named = new Map();
  const lender = (i) => {
    if (!named.has(i)) {
      const { family, slot, font, fauxBold, fauxItalic } = lenders[i];
      named.set(i, { family, slot, fauxBold, fauxItalic, postScriptName: postScriptNameOf(engine, font) });
    }
    return named.get(i);
  };
  const runs = [];
  let at = 0;
  let source = -1;
  let start = 0;
  const close = (end) => {
    if (end > start) runs.push({ start, end, own: source < 0, ...(source < 0 ? own : lender(source)) });
    start = end;
  };
  for (const ch of text) {
    const next = from.get(ch.codePointAt(0)) ?? -1;
    if (next !== source) {
      close(at);
      source = next;
    }
    at += ch.length;
  }
  close(text.length);
  return runs;
}
