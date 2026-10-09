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

/**
 * The PostScript name of one engine font; '' when it has none. The engine
 * answers a name only if it IS a PostScript name (`is_postscript_name`,
 * text-engine/src/font.rs, where name ID 6 is read): trimmed, printable
 * ASCII with no space and no PostScript delimiter. A name of nothing but
 * spaces, or one with a bracket or a slash in it, is none - a type layer
 * that names its font "   " names no font - and whoever asked makes one.
 */
export function postScriptNameOf(engine, font) {
  try {
    return String(engine.low.fontInfo(font).postScriptName ?? '');
  } catch {
    return '';
  }
}

/**
 * The face a request is drawn in, as `{ family, slot, fauxBold, fauxItalic,
 * postScriptName }`: the slot the engine resolved, whether it emboldened or
 * slanted that face itself, and the font's own name. Null for a family the
 * engine does not hold. `{ source: true }` adds a stable sourceIdentity for
 * PSD fallback naming; the default public shape stays the same.
 */
export function drawnFace(engine, face, { source = false } = {}) {
  const resolved = engine.resolveFace(face);
  if (!resolved) return null;
  const font = engine.handle(face).font;
  return {
    ...(source ? { sourceIdentity: engine.sourceIdentity(font) } : {}),
    family: face.name,
    slot: resolved.slot,
    fauxBold: resolved.fauxBold,
    fauxItalic: resolved.fauxItalic,
    postScriptName: postScriptNameOf(engine, font),
  };
}

const LINE_END = /\r\n|\r|\n/g;

/**
 * `text` cut into the stretches that are drawn from one face each, in order,
 * as `[{ start, end, own, family, slot, fauxBold, fauxItalic, postScriptName }]`
 * (UTF-16 offsets, `end` exclusive; together they cover the text).
 *
 * `own` is the face that was asked for. Every other run is a family of the
 * engine's fallback list lending letters the face lacks.
 *
 * WHICH family, and where a stretch ends, is the engine's answer and not a
 * reckoning made here: `engine.lineParts` is the cut the engine measures the
 * line in and paints it in. So a letter is in the lender the engine kept for
 * it - the one before it, when that one has it, whatever the list puts first
 * - and no run ends inside a cluster: a letter and the mark on it are one
 * font's. `fauxBold` and `fauxItalic` are what the engine synthesised of the
 * font it drew, not what the list would have said.
 *
 * `text` may be several lines (a type layer's text is its lines joined).
 * Each is asked about by itself, as each is painted by itself; what parts
 * two lines is nobody's glyph and stays in the face's own run.
 *
 * Null for a family the engine does not hold. From an engine that cannot say
 * (`lineParts` absent or null) the whole text is the face's own run: nothing
 * is claimed that was not asked. `{ source: true }` includes the actual
 * source identity on primary and borrowed runs, otherwise it is omitted.
 */
export function drawnRuns(engine, face, text, { source = false } = {}) {
  const own = drawnFace(engine, face, { source });
  if (!own) return null;
  const whole = [{ start: 0, end: text.length, own: true, ...own }];
  if (typeof engine.lineParts !== 'function') return whole;
  const ownFont = engine.handle(face).font;
  // engine font -> the family and slot it is, among the families that lend.
  let lenders = null;
  const lender = (font) => {
    lenders ??= engine.lenders(face.bold, face.italic).filter(Boolean);
    return lenders.find((l) => l.font === font) ?? null;
  };
  const named = new Map();
  const source = (part) => {
    if (part.font === ownFont) return own;
    const key = `${part.font}/${part.bold ? 'b' : ''}${part.italic ? 'i' : ''}`;
    if (!named.has(key)) {
      const from = lender(part.font);
      named.set(key, { ...(source ? { sourceIdentity: engine.sourceIdentity(part.font) } : {}), family: from?.family ?? null, slot: from?.slot ?? 'regular', fauxBold: part.bold, fauxItalic: part.italic, postScriptName: postScriptNameOf(engine, part.font) });
    }
    return named.get(key);
  };
  const runs = [];
  const put = (start, end, from) => {
    if (end <= start) return;
    const last = runs[runs.length - 1];
    if (last && last.from === from) last.end = end;
    else runs.push({ start, end, from });
  };
  let at = 0;
  const line = (end) => {
    if (end > at) {
      const parts = engine.lineParts(face, text.slice(at, end));
      if (!parts) return false;
      for (const part of parts) put(at + part.start, at + part.end, source(part));
    }
    return true;
  };
  for (const cut of text.matchAll(LINE_END)) {
    if (!line(cut.index)) return whole;
    put(cut.index, cut.index + cut[0].length, own);
    at = cut.index + cut[0].length;
  }
  if (!line(text.length)) return whole;
  if (!runs.length) return whole;
  return runs.map(({ start, end, from }) => ({ start, end, own: from === own, ...from }));
}
