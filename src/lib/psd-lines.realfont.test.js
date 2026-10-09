import { describe, it, expect, afterEach } from 'vitest';
import { rustEngine } from '../test/rust-engine.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter, engineDraws } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { layoutLines, applyCase, contentWidth, lineWidth, setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { textLayerFor } from './psd.js';

// ===========================================================================
// The lines in a type layer are the lines of the engine that is measuring
// ===========================================================================
// `textLayerFor` takes its lines, its block and its indents from `placeBlock`
// (contain.js), and `placeBlock` measures with whichever engine is installed.
// So the claim "a PSD written with the Rust engine on carries the Rust
// engine's breaks" needs a box the two engines BREAK DIFFERENTLY, or it is
// true of any engine and proves nothing.
//
// This lane has both: Skia behind the canvas (what `'browser'` is here) and
// the wasm. They disagree by a rule, not by noise: Comic Neue has no bold
// file, both synthesise one, and the Rust engine makes it as wide as WebKit
// does - `size / 36` more per glyph (text-engine/RULES.md, `boldAdvance`) -
// where Skia leaves the advances alone. A width the line fits by Skia's
// measure and not by the engine's is a box they break differently.

const TEXT = 'WAIT FOR ME OVER THERE BY THE OLD BRIDGE';
const style = { font: 'Comic Neue', size: 30, bold: true, italic: false, lineHeight: 1.1, align: 'center', valign: 'top', color: '#000000', strokes: [] };
const boxOf = (w) => ({ id: 'b', lineN: null, text: TEXT, x: 10, y: 10, w, h: 300, style });
const linesOf = (w) => layoutLines(applyCase(TEXT, style), style, style.size, contentWidth(w, style));

const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
function use(engine) {
  setTextEngine(engine ?? before.engine);
  setGlyphPainter(engine ? createRustGlyphPainter(engine) : before.painter);
  clearLayoutMemo();
}

afterEach(() => {
  use(null);
  setTypesetEnabled(before.typeset);
});

describe('a PSD type layer, for a box the two engines break differently', () => {
  it('carries the breaks of the engine that measured it', async () => {
    setTypesetEnabled(true);
    const rust = await rustEngine();

    // The first width at which the two disagree, and what each makes of it.
    let found = null;
    for (let w = 150; w <= 420 && !found; w++) {
      use(null);
      const browser = linesOf(w);
      const wide = Math.max(...browser.map((l) => lineWidth(l, style, style.size)));
      use(rust);
      const engine = linesOf(w);
      if (browser.join('\n') !== engine.join('\n')) found = { w, browser, engine, wide };
    }
    expect(found, 'no width between 150 and 420 at which the engines break this text differently').not.toBe(null);
    const { w, browser, engine, wide } = found;

    // Why: the same words are wider by the engine's measure, by its bold rule.
    use(rust);
    const widest = browser.reduce((a, b) => (lineWidth(a, style, style.size) >= lineWidth(b, style, style.size) ? a : b));
    expect(lineWidth(widest, style, style.size)).toBeGreaterThan(wide);
    expect(lineWidth(widest, style, style.size)).toBeCloseTo(wide + widest.length * (style.size / 36), 0);

    // Switch on: the layer holds the engine's lines, and names the face it synthesised.
    expect(engineDraws()).toBe(true);
    const on = textLayerFor({ lines: [] }, boxOf(w), null);
    expect(on.text.text).toBe(engine.join('\n'));
    expect(on.text.text).not.toBe(browser.join('\n'));
    expect(on.text.style).toMatchObject({ font: { name: 'ComicNeue-Regular' }, fauxBold: true, fauxItalic: false });
    expect(on.text.boxBounds[3]).toBe(Math.ceil(engine.length * style.size * style.lineHeight - 1e-6));

    // Switch off: the same box, the browser's lines, as it always wrote them.
    use(null);
    expect(engineDraws()).toBe(false);
    const off = textLayerFor({ lines: [] }, boxOf(w), null);
    expect(off.text.text).toBe(browser.join('\n'));
    expect(off.text.boxBounds[3]).toBe(Math.ceil(browser.length * style.size * style.lineHeight - 1e-6));
  });
});
