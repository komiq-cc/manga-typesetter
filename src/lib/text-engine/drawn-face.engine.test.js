import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rustEngine, fixtureFont } from '../../test/rust-engine.js';
import { blankName } from '../../test/variable-fixture.js';
import { createRustGlyphPainter } from './rust-painter.js';
import { drawnFace, drawnRuns, postScriptNameOf } from './drawn-face.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './index.js';
import { clearLayoutMemo } from '../measure.js';
import { textLayerFor, BORROWED_MARK } from '../psd.js';

// ===========================================================================
// Which font drew each stretch of a text: asked of the engine, not reckoned
// ===========================================================================
// The fixture fonts: Comic Neue has no Greek; Bangers has `Ħ` and no `Ω`;
// DejaVu Sans has both, the combining acute, and a double-struck `𝔸`
// (U+1D538) outside the BMP.
//
// A PSD type layer states a font per run (`borrowedRuns`, psd.js). Each
// statement here is checked against the engine twice: against the parts it
// cuts the line into (`lineParts`, the cut it measures and paints by), and
// against arithmetic that does not go through them - the runs, each measured
// alone in the font it names, add up to the line.

const face = (name, { bold = false, italic = false, size = 40 } = {}) => ({
  key: `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px "${name}"`, name, bold, italic, size, css: `"${name}"`,
});
const FAMILY = { 'ComicNeue-Regular': 'Comic Neue', 'Bangers-Regular': 'Bangers', DejaVuSans: 'DejaVu Sans' };

let rust;
const before = { engine: textEngine(), painter: glyphPainter() };
beforeAll(async () => {
  rust = await rustEngine();
});
afterEach(() => {
  rust.setFallbacks([]);
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  clearLayoutMemo();
});

const stated = (f, text) => drawnRuns(rust, f, text).map((r) => [r.start, r.end, r.postScriptName, r.own]);
// The runs, each alone in the font and with the synthesis it states, at the size of `f`.
const alone = (f, text) =>
  drawnRuns(rust, f, text).reduce((sum, r) => sum + rust.advance(face(r.own ? f.name : FAMILY[r.postScriptName], { size: f.size, bold: r.own && f.bold }), text.slice(r.start, r.end)), 0);

describe('a borrowed stretch', () => {
  it('is the lender the engine kept, not the first of the list that has the letter', () => {
    rust.setFallbacks(['Bangers', 'DejaVu Sans']);
    const comic = face('Comic Neue');
    // Alone, `Ħ` comes from Bangers, the first of the list.
    expect(stated(comic, 'AĦ')).toEqual([[0, 1, 'ComicNeue-Regular', true], [1, 2, 'Bangers-Regular', false]]);
    // After `Ω`, which only DejaVu Sans has, it stays in DejaVu Sans.
    expect(stated(comic, 'ΩĦ')).toEqual([[0, 2, 'DejaVuSans', false]]);
    expect(stated(comic, 'AĦ ΩĦB')).toEqual([
      [0, 1, 'ComicNeue-Regular', true],
      [1, 2, 'Bangers-Regular', false],
      [2, 3, 'ComicNeue-Regular', true],
      [3, 5, 'DejaVuSans', false],
      [5, 6, 'ComicNeue-Regular', true],
    ]);
    // What the engine measures is those fonts: at 30 px, 50.41 px, where
    // `Ħ` taken from Bangers would make 40.23.
    const at30 = face('Comic Neue', { size: 30 });
    const whole = rust.advance(at30, 'ΩĦ');
    expect(whole).toBeCloseTo(50.4053, 3);
    expect(alone(at30, 'ΩĦ')).toBeCloseTo(whole, 9);
    expect(rust.advance(face('DejaVu Sans', { size: 30 }), 'Ω') + rust.advance(face('Bangers', { size: 30 }), 'Ħ')).toBeCloseTo(40.2348, 3);
    for (const text of ['AĦ ΩĦB', 'ΩĦ ĦΩ Ħ', 'ĦĦΩΩĦ']) expect(alone(comic, text), text).toBeCloseTo(rust.advance(comic, text), 9);
  });

  it('never ends inside a cluster: a letter and the mark on it are one font’s', () => {
    rust.setFallbacks(['DejaVu Sans']);
    const bangers = face('Bangers');
    // Bangers has neither; the engine draws both in DejaVu Sans.
    expect(stated(bangers, 'Ώ')).toEqual([[0, 2, 'DejaVuSans', false]]);
    expect(stated(bangers, 'AΏB')).toEqual([[0, 1, 'Bangers-Regular', true], [1, 3, 'DejaVuSans', false], [3, 4, 'Bangers-Regular', true]]);
    expect(alone(bangers, 'AΏB')).toBeCloseTo(rust.advance(bangers, 'AΏB'), 9);
  });

  it('counts a letter outside the BMP as the two units it is', () => {
    rust.setFallbacks(['DejaVu Sans']);
    const comic = face('Comic Neue');
    const text = 'A\u{1d538}B\u{1d538}\u{1d538}';
    expect(text.length).toBe(8);
    expect(stated(comic, text)).toEqual([
      [0, 1, 'ComicNeue-Regular', true],
      [1, 3, 'DejaVuSans', false],
      [3, 4, 'ComicNeue-Regular', true],
      [4, 8, 'DejaVuSans', false],
    ]);
  });

  it('is asked line by line, as lines are painted, and a line end is the face’s own', () => {
    rust.setFallbacks(['Bangers', 'DejaVu Sans']);
    const comic = face('Comic Neue');
    // `Ħ` opens the second line: nothing before it on ITS line, so Bangers.
    expect(stated(comic, 'AΩ\nĦB')).toEqual([
      [0, 1, 'ComicNeue-Regular', true],
      [1, 2, 'DejaVuSans', false],
      [2, 3, 'ComicNeue-Regular', true],
      [3, 4, 'Bangers-Regular', false],
      [4, 5, 'ComicNeue-Regular', true],
    ]);
    expect(stated(comic, 'A\r\nB')).toEqual([[0, 4, 'ComicNeue-Regular', true]]);
    expect(stated(comic, '')).toEqual([[0, 0, 'ComicNeue-Regular', true]]);
  });

  it('says what the engine synthesised of the lender, and is the engine’s parts', () => {
    rust.setFallbacks(['Bangers', 'DejaVu Sans']);
    const bold = face('Comic Neue', { bold: true });
    const text = 'AĦ ΩĦB';
    const runs = drawnRuns(rust, bold, text);
    const parts = rust.lineParts(bold, text);
    expect(runs.map((r) => [r.start, r.end, r.fauxBold, r.fauxItalic])).toEqual(parts.map((p) => [p.start, p.end, p.bold, p.italic]));
    expect(runs.map((r) => r.postScriptName)).toEqual(parts.map((p) => rust.low.fontInfo(p.font).postScriptName));
    expect(runs.map((r) => r.fauxBold)).toEqual([true, true, true, true, true]);
  });

  it('is the type layer’s runs, cluster for cluster, on a text with two lenders', () => {
    rust.setFallbacks(['Bangers', 'DejaVu Sans']);
    setTextEngine(rust);
    setGlyphPainter(createRustGlyphPainter(rust));
    clearLayoutMemo();
    const style = { font: 'Comic Neue', size: 30, bold: false, italic: false, lineHeight: 1.1, align: 'center', valign: 'top', color: '#000000', strokes: [] };
    const text = 'AĦ ΩĦ ΏB';
    const layer = textLayerFor({ lines: [] }, { id: 'b', lineN: null, text, x: 10, y: 10, w: 600, h: 100, style }, null);
    expect(layer.text.text).toBe(text);
    expect(layer.name.endsWith(BORROWED_MARK)).toBe(true);
    // One font per UTF-16 unit, from the layer and from the engine's parts.
    const perUnit = (runs, name) => runs.flatMap((r) => Array(r.length ?? r.end - r.start).fill(name(r)));
    const fromLayer = perUnit(layer.text.styleRuns, (r) => r.style.font?.name ?? layer.text.style.font.name);
    const fromEngine = perUnit(rust.lineParts(face('Comic Neue', { size: 30 }), text), (p) => rust.low.fontInfo(p.font).postScriptName);
    expect(fromLayer).toEqual(fromEngine);
    expect(fromLayer).toEqual(['ComicNeue-Regular', 'Bangers-Regular', 'ComicNeue-Regular', 'DejaVuSans', 'DejaVuSans', 'ComicNeue-Regular', 'DejaVuSans', 'DejaVuSans', 'ComicNeue-Regular']);
  });
});

describe('a font whose PostScript name is only spaces', () => {
  it('has no name of its own, and the type layer is given the constructed one', () => {
    const bytes = blankName(fixtureFont('Bangers-Regular.ttf'));
    const font = rust.low.addFont(bytes);
    // The engine does not pass it on (font.rs, where name ID 6 is read).
    expect(rust.low.fontInfo(font).postScriptName).toBe('');
    expect(postScriptNameOf(rust, font)).toBe('');
    rust.low.removeFont(font);

    rust.addFace('Blank Name', 'regular', bytes);
    try {
      expect(drawnFace(rust, face('Blank Name')).postScriptName).toBe('');
      setTextEngine(rust);
      setGlyphPainter(createRustGlyphPainter(rust));
      clearLayoutMemo();
      const style = { font: 'Blank Name', size: 30, bold: true, italic: false, lineHeight: 1.1, align: 'center', valign: 'top', color: '#000000', strokes: [] };
      const layer = textLayerFor({ lines: [] }, { id: 'b', lineN: null, text: 'WAIT', x: 10, y: 10, w: 300, h: 100, style }, null);
      // The name the writer constructs when a font states none (`postScriptName`
      // in psd.js: the family's CSS name with its spaces out; here, where the
      // app's own font list does not hold the family, the default family's).
      expect(layer.text.style.font.name).toBe('ComicNeue');
      expect(layer.text.style.fauxBold).toBe(true);
    } finally {
      setTextEngine(before.engine);
      setGlyphPainter(before.painter);
      rust.removeFamily('Blank Name');
    }
  });
});
