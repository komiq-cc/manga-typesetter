// ===== where a caret can stand on a box that is a picture =====
//
// With the Rust engine drawing, a box being typed into is the picture the
// exporter paints (TextBox.svelte). This file says where its carets are, and
// it says it from the SAME statements that picture is painted from, so the
// two cannot drift:
//
//   placeBlock      the lines, the x each is anchored at, the block's top -
//                   what `layoutBox` and `glyphJob` (exporter.js) paint from
//   editLines       each line as the slice of the raw text it came from
//   lineCarets      the engine's pen at every cluster of a line, from the
//                   painter's own shaping of that line (`paint::shape_run`),
//                   for the face, the string and the letter spacing the
//                   painter is given
//
// A line starts where the painter starts it: its anchor moved by the
// alignment's share of the advance `lineCarets` returned with the pens. The
// rest is flat-caret.js, which is arithmetic on the rows made here.
//
// Positions are box-local page px, before the box's flip and its turn: the
// frame the picture itself is painted in.
import { placeBlock, boxCandidate } from './contain.js';
import { faceFor } from './measure.js';
import { editLines } from './edit-lines.js';
import { textEngine } from './text-engine/index.js';
import { buildRows, caseMap, mapRows } from './flat-caret.js';

/** Whether the installed engine can say where a caret stands (the wasm has the export). */
export function canType() {
  return typeof textEngine()?.lineCarets === 'function';
}

// Canvas `textAlign`, as the painter reads a job's (text-engine/js/paint.mjs:
// an alignment it does not know is the line's start).
function alignOffset(align, advance) {
  return align === 'center' ? -advance / 2 : align === 'right' || align === 'end' ? -advance : 0;
}

// Made when first asked for: importing this file runs nothing.
let segmenter;
// Whether a caret may stand at an offset of `text`: a grapheme boundary.
function graphemeBounds(text) {
  if (segmenter === undefined) segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  if (!segmenter) return null;
  // Plain text - the usual case - has a boundary at every offset.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text) && !text.includes('\r')) return null;
  const at = new Set([text.length]);
  for (const { index } of segmenter.segment(text)) at.add(index);
  return (o) => at.has(o);
}

/**
 * The pens of one painted line: `{ at, x, end }`, cluster offsets ascending
 * and the x of each from the line's start, and the advance. `engine` is the
 * Rust adapter; `face` and `letterSpacing` are what the job is painted with.
 */
export function linePens(engine, face, line, letterSpacing) {
  const c = engine.lineCarets(face, line, letterSpacing);
  let at = c.at;
  let x = c.x;
  // Left-to-right text arrives in order. Anything else (a run the shaper
  // reordered) is put in the order of the text, each cluster at its own pen.
  if (at.some((v, i) => i && v <= at[i - 1])) {
    const order = at.map((_, i) => i).sort((p, q) => at[p] - at[q] || x[p] - x[q]);
    at = order.map((i) => c.at[i]).filter((v, i, all) => !i || v !== all[i - 1]);
    const seen = new Set();
    x = order.filter((i) => !seen.has(c.at[i]) && seen.add(c.at[i])).map((i) => c.x[i]);
  }
  return { at, x, end: c.advance };
}

/**
 * What typing into `box` as a picture needs, for the text `text` (the box's
 * own, or what an IME has in hand):
 *
 *   { kind: 'flat', rows, lines, map }    straight text: the rows of
 *                                         flat-caret.js, in page px
 *   { kind: 'curve', glyphs, drawn, map } text on a curve: the glyphs the
 *                                         painter draws (`placeBlock`'s
 *                                         layout, from the box centre), and
 *                                         the cased text they are
 *
 * `map` is `caseMap`'s: null when a raw offset is a cased one. Null when the
 * box cannot be typed into as a picture - the engine has no `lineCarets`,
 * the lines cannot be laid over the text, or the casing cannot be mapped -
 * and it is then typed into as DOM text, as it always was.
 */
export function typeModel(box, text) {
  const engine = textEngine();
  if (typeof engine?.lineCarets !== 'function') return null;
  const raw = String(text ?? '');
  const place = placeBlock(boxCandidate(box, raw));
  if (!place) return null;
  const s = place.s;
  const cased = place.text;
  const map = caseMap(raw, cased);
  if (map === false) return null;
  if (place.isCurve) return { kind: 'curve', glyphs: place.layout, drawn: cased, map };
  // The offsets the rows are made in: the cased text's when there is a map.
  const drawn = map ? cased : raw;
  const segs = editLines(drawn, cased, place.lines);
  if (!segs) return null;
  const face = faceFor(s, s.size);
  const spacing = Number(s.letterSpacing) || 0;
  const geom = place.lines.map((line, i) => {
    const pens = line === '' ? { at: [], x: [], end: 0 } : linePens(engine, face, line, spacing);
    const x0 = place.lineX[i] + alignOffset(s.align, pens.end);
    return {
      top: place.blockY + i * place.lineH,
      height: place.lineH,
      // Where a line with nothing on it starts: the alignment's own edge.
      anchor: place.lineX[i],
      at: pens.at,
      x: pens.x.map((v) => x0 + v),
      end: x0 + pens.end,
    };
  });
  const space = engine.advance(face, ' ') + spacing;
  const rows = mapRows(buildRows(drawn, segs, geom, { space, bounds: graphemeBounds(drawn) }), map);
  return { kind: 'flat', rows, lines: place.lines, map };
}
