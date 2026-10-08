import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rustEngine, fixtureFont } from '../../test/rust-engine.js';
import { matchSlot } from './rust.js';
import { textEngine, setTextEngine } from './index.js';
import {
  canMeasure, lineWidth, charWidths, fontMetrics, lineInk, glyphInk, layoutLines, faceFor, setTypesetEnabled, typesetEnabled,
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
