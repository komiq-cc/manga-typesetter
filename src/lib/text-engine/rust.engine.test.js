import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rustEngine, fixtureFont } from '../../test/rust-engine.js';
import { matchSlot } from './rust.js';
import { textEngine, setTextEngine } from './index.js';
import {
  canMeasure, lineWidth, charWidths, fontMetrics, lineInk, glyphInk, layoutLines, faceFor, setTypesetEnabled, typesetEnabled, inkShiftY,
} from '../measure.js';

const defaultEngine = textEngine();
const defaultTypeset = typesetEnabled();
const style = { font: 'Comic Neue', size: 20, bold: false, italic: false, letterSpacing: 0, lineHeight: 1.2, align: 'left' };
const face = (font, size = 20, bold = false, italic = false) => faceFor({ font, bold, italic }, size);
let engine;
beforeAll(async () => {
  engine = await rustEngine();
});
afterEach(() => {
  setTextEngine(defaultEngine);
  setTypesetEnabled(defaultTypeset);
});

describe('the Rust engine behind the measuring seam', () => {
  it('answers every seam method synchronously with plain numbers', () => {
    const f = face('Comic Neue');
    expect(engine.id).toBe('rust');
    expect(engine.loading()).toBe(false);
    expect(engine.faceReady(f)).toBe(true);
    const adv = engine.advance(f, 'WAIT!');
    expect(adv).toBeGreaterThan(40);
    expect(adv).toBeLessThan(70);
    expect(engine.advance(f, '')).toBe(0);
    const box = engine.fontBox(f);
    expect(box.ascent).toBeGreaterThan(box.descent);
    expect(box.ascent + box.descent).toBeGreaterThan(20);
    const ink = engine.lineInk(f, 'WAIT!');
    expect(ink.width).toBe(adv);
    for (const k of ['left', 'right', 'ascent', 'descent']) expect(Number.isFinite(ink[k])).toBe(true);
    expect(ink.right).toBeLessThanOrEqual(adv + 1);
    const g = engine.glyphInk(f, 'W');
    expect(g.left + g.right).toBeCloseTo(engine.lineInk(f, 'W').left + engine.lineInk(f, 'W').right, 9);
  });

  it('measures for measure.js exactly what it answers when asked directly', () => {
    setTextEngine(engine);
    expect(canMeasure()).toBe(true);
    const f = faceFor(style, 20);
    expect(lineWidth('AB  ', style, 20)).toBe(engine.advance(f, 'AB'));
    expect(charWidths('AV', style, 20)).toEqual([engine.advance(f, 'A'), engine.advance(f, 'V')]);
    expect(fontMetrics(style, 20)).toEqual(engine.fontBox(f));
    const raw = engine.lineInk(f, 'AB');
    expect(lineInk('AB', style, 20)).toEqual({ left: -raw.left, right: raw.right, ascent: raw.ascent, descent: raw.descent });
    const g = engine.glyphInk(f, 'A');
    expect(glyphInk('A', style, 20)).toEqual({ left: -g.left, right: g.right, ascent: g.ascent, descent: g.descent });
    setTypesetEnabled(false);
    expect(layoutLines('AB CD', style, 20, 1000)).toEqual(['AB CD']);
    expect(layoutLines('AB CD', style, 20, 30)).toEqual(['AB', 'CD']);
  });

  it('tells its listeners when the faces change, and stops when they unsubscribe', async () => {
    const e = await rustEngine({ fixtures: false });
    const heard = vi.fn();
    const off = e.onFontsChange(heard);
    e.addFace('Bangers', 'regular', fixtureFont('Bangers-Regular.ttf'));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(e.removeFamily('Bangers')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(e.removeFamily('Bangers')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    e.addFace('Bangers', 'regular', fixtureFont('Bangers-Regular.ttf'));
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('refuses a family nobody registered instead of measuring a substitute', async () => {
    const f = face('Wild Words');
    expect(engine.faceReady(f)).toBe(false);
    for (const call of [
      () => engine.advance(f, 'A'), () => engine.fontBox(f), () => engine.lineInk(f, 'A'), () => engine.glyphInk(f, 'A'),
      () => engine.wrapPlain(f, 'A', { width: 100, lineHeight: 1.2, letterSpacing: 0, align: 'left' }), () => engine.missing(f, 'A'),
    ]) expect(call).toThrow("font 'Wild Words' is not registered");
    // A face that leaves is refused from then on, a kept handle included.
    const e = await rustEngine();
    const b = face('Bangers');
    expect(e.advance(b, 'A')).toBeGreaterThan(0);
    e.removeFamily('Bangers');
    expect(e.faceReady(b)).toBe(false);
    expect(() => e.advance(b, 'A')).toThrow("font 'Bangers' is not registered");
    expect(() => e.addFace('Bangers', 'regular', new Uint8Array(64))).toThrow('cannot read Bangers/regular');
    expect(() => e.addFace('Bangers', 'heavy', fixtureFont('Bangers-Regular.ttf'))).toThrow("unknown face slot 'heavy'");
  });
});

describe('face selection', () => {
  it('follows the CSS matching order: slant first, then weight', () => {
    const all = ['regular', 'bold', 'italic', 'boldItalic'];
    expect(matchSlot(all, true, true)).toEqual({ slot: 'boldItalic', fauxBold: false, fauxItalic: false });
    expect(matchSlot(['regular'], true, true)).toEqual({ slot: 'regular', fauxBold: true, fauxItalic: true });
    // An italic request takes the italic face and fakes the weight, not the other way round.
    expect(matchSlot(['regular', 'bold', 'italic'], true, true)).toEqual({ slot: 'italic', fauxBold: true, fauxItalic: false });
    expect(matchSlot(['regular', 'bold'], true, true)).toEqual({ slot: 'bold', fauxBold: false, fauxItalic: true });
    expect(matchSlot(['regular', 'italic'], true, false)).toEqual({ slot: 'regular', fauxBold: true, fauxItalic: false });
    // A family with one heavy or slanted face draws everything from it, unsynthesised.
    expect(matchSlot(['bold'], false, false)).toEqual({ slot: 'bold', fauxBold: false, fauxItalic: false });
    expect(matchSlot(['italic'], false, false)).toEqual({ slot: 'italic', fauxBold: false, fauxItalic: false });
    expect(matchSlot(['boldItalic'], false, true)).toEqual({ slot: 'boldItalic', fauxBold: false, fauxItalic: false });
  });

  it('draws an italic request from the real italic face and a missing one from a slanted regular', () => {
    expect(engine.resolveFace(face('DejaVu Sans', 20, false, true))).toEqual({ slot: 'italic', fauxBold: false, fauxItalic: false });
    expect(engine.resolveFace(face('DejaVu Sans', 20, true, true))).toEqual({ slot: 'italic', fauxBold: true, fauxItalic: false });
    expect(engine.resolveFace(face('Comic Neue', 20, true, true))).toEqual({ slot: 'regular', fauxBold: true, fauxItalic: true });
    expect(engine.resolveFace(face('Wild Words'))).toBeNull();
    // The slanted outline leans past the upright one; the advance is the upright's.
    const up = face('Comic Neue', 40);
    const slanted = face('Comic Neue', 40, false, true);
    expect(engine.advance(slanted, 'WAIT')).toBe(engine.advance(up, 'WAIT'));
    expect(engine.lineInk(slanted, 'WAIT').right).toBeGreaterThan(engine.lineInk(up, 'WAIT').right + 2);
  });

  it('keeps one resolved handle per key and never answers for a different face under it', () => {
    const a = { ...face('Comic Neue', 20), key: 'same' };
    const b = { ...face('Bangers', 20), key: 'same' };
    const wa = engine.advance(a, 'WAIT');
    expect(engine.advance(b, 'WAIT')).not.toBe(wa);
    expect(engine.advance(a, 'WAIT')).toBe(wa);
    expect(engine.advance({ ...a, size: 40 }, 'WAIT')).toBe(wa * 2);
  });
});

describe('the rules a browser canvas follows', () => {
  it('measures a tab, a newline, a form feed and a carriage return as a space', () => {
    for (const font of ['Comic Neue', 'Bangers', 'DejaVu Sans']) {
      const f = face(font, 22.5);
      const spaced = engine.advance(f, 'A B');
      for (const ws of ['\t', '\n', '\f', '\r']) {
        expect(engine.advance(f, `A${ws}B`)).toBe(spaced);
        expect(engine.lineInk(f, `A${ws}B`)).toEqual(engine.lineInk(f, 'A B'));
        expect(engine.missing(f, `A${ws}B`)).toEqual([]);
      }
      // Any other space is the font's own glyph, or its absence.
      expect(engine.advance(f, 'A B')).not.toBe(spaced);
    }
  });

  it('reports the line box in whole pixels, from hhea', () => {
    expect(engine.fontBox(face('Comic Neue', 20))).toEqual({ ascent: 18, descent: 5 });
    expect(engine.fontBox(face('Comic Neue', 14.5))).toEqual({ ascent: 13, descent: 4 });
    // hhea 1901/483 of 2048, not the OS/2 typo 1556/492.
    expect(engine.fontBox(face('DejaVu Sans', 20))).toEqual({ ascent: 19, descent: 5 });
    // 4.5 by plain arithmetic; a TrueType font is scaled in 16.16 fixed point
    // and comes out a hair under, as it does in both browsers.
    expect(engine.fontBox(face('Comic Neue', 5))).toEqual({ ascent: 4, descent: 1 });
  });

  it("reaches a line's ink box to its baseline unless told to report the outline as it is", () => {
    // A hyphen is drawn wholly above the baseline: its outline has a negative descent.
    const f = face('Comic Neue', 40);
    expect(engine.rules().inkBaseline).toBe('include');
    const kept = engine.lineInk(f, '-');
    expect(kept.descent).toBe(0);
    expect(kept.ascent).toBeGreaterThan(5);
    engine.setRules({ inkBaseline: 'exact' });
    try {
      const exact = engine.lineInk(f, '-');
      expect(exact.descent).toBeLessThan(-5);
      expect(exact.ascent).toBe(kept.ascent);
    } finally {
      engine.setRules({ inkBaseline: 'include' });
    }
    expect(() => engine.setRules({ inkBaseline: 'sometimes' })).toThrow(/unknown rule/);
    // The block is centred on its ink only when every line reports one (measure.js).
    setTextEngine(engine);
    setTypesetEnabled(true);
    const s = { ...style, size: 40, valign: 'middle' };
    expect(inkShiftY(['WAIT', '--'], s, 40)).not.toBe(0);
  });

  it('gives a string without ink a width and an empty box', () => {
    const f = face('Comic Neue', 40);
    for (const text of ['', ' ', '   ', '\t']) {
      const ink = engine.lineInk(f, text);
      expect(ink.width).toBe(engine.advance(f, text));
      expect([ink.left, ink.right, ink.ascent, ink.descent]).toEqual([0, 0, 0, 0]);
    }
    // Spaces around ink move it or widen the line; they are not ink.
    const g = engine.lineInk(f, 'g');
    const sp = engine.advance(f, ' ');
    const padded = engine.lineInk(f, ' g ');
    expect(padded.width).toBeCloseTo(g.width + 2 * sp, 9);
    expect(padded.right).toBeCloseTo(g.right + sp, 9);
    expect(padded.left).toBeCloseTo(g.left - sp, 9);
    expect([padded.ascent, padded.descent]).toEqual([g.ascent, g.descent]);
  });

  it('keeps a synthesised bold on the regular advances unless told to widen them as WebKit does', async () => {
    const e = await rustEngine();
    const heard = vi.fn();
    e.onFontsChange(heard);
    const regular = face('Comic Neue', 36);
    const bold = face('Comic Neue', 36, true);
    const w = e.advance(regular, 'WAIT');
    expect(e.rules()).toEqual({ boldAdvance: 'unchanged', fontBox: 'browser', inkBaseline: 'include' });
    expect(e.advance(bold, 'WAIT')).toBe(w);
    expect(e.lineInk(bold, 'WAIT').right).toBeGreaterThan(e.lineInk(regular, 'WAIT').right);

    e.setRules({ boldAdvance: 'webkit' });
    // Numbers measured under the old rule are stale, and the listeners hear it.
    expect(heard).toHaveBeenCalledTimes(1);
    expect(e.advance(bold, 'WAIT')).toBeCloseTo(w + 4, 9);
    expect(e.advance(regular, 'WAIT')).toBe(w);
    // A real face is never widened: DejaVu's italic is a file, its bold is not.
    const oblique = e.advance(face('DejaVu Sans', 36, false, true), 'WAIT');
    expect(e.advance(face('DejaVu Sans', 36, true, true), 'WAIT')).toBeCloseTo(oblique + 4, 9);

    e.setRules({ fontBox: 'skia' });
    expect(e.fontBox(face('Comic Neue', 14.5)).ascent).toBeCloseTo(13.05, 9);
    expect(e.rules()).toEqual({ boldAdvance: 'webkit', fontBox: 'skia', inkBaseline: 'include' });
    expect(() => e.setRules({ boldAdvance: 'gecko' })).toThrow('unknown rule boldAdvance=gecko');
    expect(() => e.setRules({ kerning: 'off' })).toThrow('unknown rule kerning=off');
  });
});

describe('wrapPlain, the CSS breaker', () => {
  const opts = (width, letterSpacing = 0) => ({ width, lineHeight: 1.2, letterSpacing, align: 'left' });
  const f = face('Comic Neue', 20);

  it('fills each line with the words that fit and hangs the spaces at its end', () => {
    const ab = engine.advance(f, 'AB');
    expect(engine.wrapPlain(f, 'AB AB', opts(1000))).toEqual(['AB AB']);
    expect(engine.wrapPlain(f, 'AB      AB', opts(ab))).toEqual(['AB', 'AB']);
    expect(engine.wrapPlain(f, 'AB AB', opts(engine.advance(f, 'AB AB')))).toEqual(['AB AB']);
    expect(engine.wrapPlain(f, 'AB AB', opts(engine.advance(f, 'AB AB') - 0.01))).toEqual(['AB', 'AB']);
    const text = 'WHAT THE HELL ARE YOU DOING?!';
    const lines = engine.wrapPlain(f, text, opts(120));
    expect(lines.join(' ')).toBe(text);
    for (const line of lines) expect(engine.advance(f, line)).toBeLessThanOrEqual(120);
  });

  it('keeps hard breaks, empty lines and the spaces that open a paragraph', () => {
    expect(engine.wrapPlain(f, 'ONE\n\nTWO', opts(1000))).toEqual(['ONE', '', 'TWO']);
    expect(engine.wrapPlain(f, 'ONE\n', opts(1000))).toEqual(['ONE', '']);
    expect(engine.wrapPlain(f, '', opts(1000))).toEqual(['']);
    expect(engine.wrapPlain(f, '  ONE\n  TWO', opts(1000))).toEqual(['  ONE', '  TWO']);
  });

  it('breaks after a hyphen and never at a no-break space', () => {
    expect(engine.wrapPlain(f, 'WELL-KNOWN', opts(70))).toEqual(['WELL-', 'KNOWN']);
    expect(engine.wrapPlain(f, 'NO BREAK HERE', opts(95))).toEqual(['NO BREAK', 'HERE']);
  });

  it('moves a word wider than the line to its own line before cutting it', () => {
    const w = engine.advance(f, 'W');
    expect(engine.wrapPlain(f, 'A WWWWW', opts(3 * w + 0.01))).toEqual(['A', 'WWW', 'WW']);
    // A line always takes one letter, in a box narrower than any; a width
    // below a pixel is a pixel.
    expect(engine.wrapPlain(f, 'WW', opts(0))).toEqual(['W', 'W']);
    expect(engine.wrapPlain(f, 'éé', opts(1))).toEqual(['é', 'é']);
  });

  it('counts letter spacing after every letter of the line', () => {
    const h = engine.advance(f, 'H');
    expect(engine.wrapPlain(f, 'HHHH', opts(4 * h + 12, 3))).toEqual(['HHHH']);
    expect(engine.wrapPlain(f, 'HHHH', opts(4 * h + 10.5, 3))).toEqual(['HHH', 'H']);
    // Spaced letters are not joined: DejaVu's ff ligature is narrower than two f.
    const d = face('DejaVu Sans', 40);
    const apart = 2 * engine.advance(d, 'f');
    expect(engine.advance(d, 'ff')).toBeLessThan(apart - 0.5);
    expect(engine.wrapPlain(d, 'ff', opts(apart + 6, 3))).toEqual(['ff']);
    expect(engine.wrapPlain(d, 'ff', opts(apart + 5.95, 3))).toEqual(['f', 'f']);
  });
});

describe('fallback for a letter the face lacks', () => {
  const OMEGA = 'Ω';
  const HANGUL = '한';
  const opts = (width) => ({ width, lineHeight: 1.2, letterSpacing: 0, align: 'left' });

  it('draws nothing from another font until a list is set', () => {
    const f = face('Comic Neue', 40);
    expect(engine.fallbacks()).toEqual([]);
    expect(engine.missing(f, `A${OMEGA}B${OMEGA}${HANGUL}`)).toEqual([0x3a9, 0xd55c]);
    expect(engine.missing(face('DejaVu Sans', 40), `A${OMEGA}B`)).toEqual([]);
  });

  it('measures the letter in the first listed family that has it, and reports only what none has', async () => {
    const e = await rustEngine();
    const heard = vi.fn();
    e.onFontsChange(heard);
    const f = face('Comic Neue', 40);
    const d = face('DejaVu Sans', 40);
    const notdef = e.advance(f, `A${OMEGA}B`);

    // A name that is not registered is passed over.
    e.setFallbacks(['Wild Words', 'Bangers', 'DejaVu Sans']);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(e.fallbacks()).toEqual(['Wild Words', 'Bangers', 'DejaVu Sans']);
    const want = e.advance(f, 'A') + e.advance(d, OMEGA) + e.advance(f, 'B');
    expect(e.advance(f, `A${OMEGA}B`)).toBeCloseTo(want, 9);
    expect(e.advance(f, `A${OMEGA}B`)).not.toBeCloseTo(notdef, 1);
    expect(e.missing(f, `A${OMEGA}B${HANGUL}`)).toEqual([0xd55c]);

    // Ink is the borrowed glyph's own.
    const line = e.lineInk(f, `A${OMEGA}`);
    expect(line.width).toBeCloseTo(e.advance(f, 'A') + e.advance(d, OMEGA), 9);
    expect(line.right).toBeCloseTo(e.advance(f, 'A') + e.lineInk(d, OMEGA).right, 9);
    const glyph = e.glyphInk(f, OMEGA);
    const own = e.glyphInk(d, OMEGA);
    expect([glyph.left, glyph.right]).toEqual([own.left, own.right]);

    // An accent goes with its letter, though Comic Neue has the accent.
    expect(e.missing(f, '́')).toEqual([]);
    expect(e.advance(f, `A${OMEGA}́B`)).toBeCloseTo(e.advance(f, 'A') + e.advance(d, `${OMEGA}́`) + e.advance(f, 'B'), 9);

    // The breaker tests the width the line will have.
    const word = OMEGA.repeat(3);
    const real = e.advance(f, word);
    expect(e.wrapPlain(f, `${word} ${word}`, opts(real))).toEqual([word, word]);
    expect(e.wrapPlain(f, `${word} ${word}`, opts(real - 0.05)).length).toBe(4);

    // Text the face covers is untouched by the list.
    expect(e.advance(f, 'WAIT!')).toBe(engine.advance(f, 'WAIT!'));
    expect(e.lineInk(f, 'WAIT!')).toEqual(engine.lineInk(f, 'WAIT!'));

    // The list empties, or its family leaves: the face's own empty box again.
    e.removeFamily('DejaVu Sans');
    expect(e.advance(f, `A${OMEGA}B`)).toBeCloseTo(notdef, 9);
    expect(e.missing(f, `A${OMEGA}B`)).toEqual([0x3a9]);
    e.addFace('DejaVu Sans', 'regular', fixtureFont('DejaVuSans.ttf'));
    expect(e.advance(f, `A${OMEGA}B`)).toBeCloseTo(want, 9);
    e.setFallbacks([]);
    expect(e.advance(f, `A${OMEGA}B`)).toBeCloseTo(notdef, 9);
    expect(() => e.setFallbacks('DejaVu Sans')).toThrow('fallbacks are a list of family names');
  });

  it('borrows the letter in the weight and slant that were asked', async () => {
    const e = await rustEngine();
    e.setFallbacks(['DejaVu Sans']);
    const upright = e.advance(face('Comic Neue', 40), OMEGA);
    expect(upright).toBe(e.advance(face('DejaVu Sans', 40), OMEGA));
    // An italic line takes DejaVu's own oblique face, whose ink leans.
    const lean = e.lineInk(face('Comic Neue', 40, false, true), OMEGA);
    expect(lean).toEqual(e.lineInk(face('DejaVu Sans', 40, false, true), OMEGA));
    expect(lean).not.toEqual(e.lineInk(face('Comic Neue', 40), OMEGA));
    // A bold line has no bold DejaVu to take, so the borrowed letter is thickened.
    const heavy = e.lineInk(face('Comic Neue', 40, true), OMEGA);
    expect(heavy.right).toBeGreaterThan(e.lineInk(face('Comic Neue', 40), OMEGA).right);
  });
});
