import { afterEach, describe, expect, it, vi } from 'vitest';
import { textEngine, setTextEngine, onTextEngineChange, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import {
  canMeasure, lineWidth, charWidths, fontMetrics, lineInk, glyphInk, layoutLines, wrapLines,
  wrapLinesDOM, blockInk, baselineInLine, faceFor, setTypesetEnabled, typesetEnabled, layoutMemoSize,
} from './measure.js';
import { createBrowserTextEngine, browserFaceReady } from './text-engine/browser.js';

const defaultEngine = textEngine();
const defaultPainter = glyphPainter();
const defaultTypeset = typesetEnabled();
const style = { font: 'Comic Neue', size: 20, bold: true, italic: true, letterSpacing: 2, lineHeight: 1.2, align: 'left' };
afterEach(() => {
  setTextEngine(defaultEngine);
  setGlyphPainter(defaultPainter);
  setTypesetEnabled(defaultTypeset);
  vi.unstubAllGlobals();
});

function fakeEngine() {
  const listeners = new Set();
  const e = {
    id: 'fake',
    advance: vi.fn((_face, text) => [...text].length * 10),
    fontBox: vi.fn(() => ({ ascent: 15, descent: 5 })),
    lineInk: vi.fn(() => ({ width: 20, left: 1, right: 19, ascent: 14, descent: 4 })),
    glyphInk: vi.fn(() => ({ width: 10, left: 4, right: 6, ascent: 7, descent: 3 })),
    wrapPlain: vi.fn(() => ['  ', 'AB', 'CD', '']),
    loading: vi.fn(() => false),
    onFontsChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    faceReady: vi.fn(() => true),
    fontsChanged: () => { for (const cb of listeners) cb(); },
  };
  return e;
}

describe('the measuring engine seam', () => {
  it('hands each measurement the face and leaves spacing and alignment with the caller', () => {
    const e = fakeEngine();
    setTextEngine(e);
    expect(canMeasure()).toBe(true);
    const face = faceFor(style, 20);
    expect(face).toEqual({ key: "italic 700 20px 'Comic Neue', cursive", name: 'Comic Neue', bold: true, italic: true, size: 20, css: "'Comic Neue', cursive" });
    expect(lineWidth('AB  ', style, 20)).toBe(22);
    expect(e.advance).toHaveBeenLastCalledWith(face, 'AB');
    expect(charWidths('A😀', style, 20)).toEqual([10, 10]);
    expect(e.advance.mock.calls.slice(-2)).toEqual([[face, 'A'], [face, '😀']]);
    expect(fontMetrics(style, 20)).toEqual({ ascent: 15, descent: 5 });
    expect(e.fontBox).toHaveBeenCalledWith(face);
    expect(lineInk('AB', style, 20)).toEqual({ left: -1, right: 21, ascent: 14, descent: 4 });
    expect(e.lineInk).toHaveBeenCalledWith(face, 'AB');
    expect(glyphInk('A', style, 20)).toEqual({ left: -4, right: 6, ascent: 7, descent: 3 });
    expect(e.glyphInk).toHaveBeenCalledWith(face, 'A');
    setTypesetEnabled(false);
    expect(layoutLines('AB\tCD', style, 20, 100)).toEqual(['AB', 'CD']);
    expect(e.wrapPlain).toHaveBeenCalledWith(face, 'AB CD', { width: 100, lineHeight: 1.2, letterSpacing: 2, align: 'left' });
  });

  it('uses memo hits without calling measurement methods or rebuilding a face', () => {
    const e = fakeEngine();
    setTextEngine(e);
    setTypesetEnabled(false);
    lineWidth('AB', style, 20);
    fontMetrics(style, 20);
    lineInk('AB', style, 20);
    layoutLines('AB', style, 20, 100);
    // faceFor reads the face flags; the font shorthand still reads them once.
    let boldReads = 0;
    const watched = { ...style, get bold() { boldReads++; return true; } };
    expect(lineWidth('AB', watched, 20)).toBe(22);
    expect(boldReads).toBe(1);
    fontMetrics(style, 20);
    lineInk('AB', style, 20);
    layoutLines('AB', style, 20, 100);
    expect(e.advance).toHaveBeenCalledTimes(1);
    expect(e.fontBox).toHaveBeenCalledTimes(1);
    expect(e.lineInk).toHaveBeenCalledTimes(1);
    expect(e.wrapPlain).toHaveBeenCalledTimes(1);
  });

  // A face change drops the measurements and leaves the layouts, as the font
  // set's events always did: the store drops those itself (`relayoutAll`).
  it('drops both memos on a swap, and the measurements on a face change', () => {
    setTypesetEnabled(false);
    const first = fakeEngine();
    setTextEngine(first);
    const ask = () => {
      lineWidth('AB', style, 20);
      fontMetrics(style, 20);
      lineInk('AB', style, 20);
      layoutLines('AB', style, 20, 100);
    };
    ask();
    first.fontsChanged();
    expect(layoutMemoSize()).toBe(1);
    ask();
    for (const method of ['advance', 'fontBox', 'lineInk']) expect(first[method]).toHaveBeenCalledTimes(2);
    expect(first.wrapPlain).toHaveBeenCalledTimes(1);
    const next = fakeEngine();
    const changed = vi.fn();
    const unsubscribe = onTextEngineChange(changed);
    try {
      setTextEngine(next);
      expect(changed).toHaveBeenCalledWith(next);
      expect(layoutMemoSize()).toBe(0);
      ask();
      first.fontsChanged();
      ask();
      for (const method of ['advance', 'fontBox', 'lineInk', 'wrapPlain']) expect(next[method]).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('does not keep or read memoised measurements while loading', () => {
    const e = fakeEngine();
    setTextEngine(e);
    setTypesetEnabled(false);
    const ask = () => {
      lineWidth('AB', style, 20);
      fontMetrics(style, 20);
      lineInk('AB', style, 20);
      layoutLines('AB', style, 20, 100);
    };
    ask();
    e.loading.mockReturnValue(true);
    ask();
    ask();
    for (const method of ['advance', 'fontBox', 'lineInk']) expect(e[method]).toHaveBeenCalledTimes(3);
    e.fontsChanged();
    e.loading.mockReturnValue(false);
    ask();
    ask();
    for (const method of ['advance', 'fontBox', 'lineInk']) expect(e[method]).toHaveBeenCalledTimes(4);
    // The layout memo does not ask about loading and never did.
    expect(e.wrapPlain).toHaveBeenCalledTimes(1);
  });

  it('validates font and ink metrics exactly as before', () => {
    const e = fakeEngine();
    e.fontBox.mockReturnValue({ ascent: NaN, descent: -1 });
    e.lineInk.mockReturnValue({ width: 20 });
    e.glyphInk.mockReturnValue({ width: 10 });
    setTextEngine(e);
    expect(fontMetrics(style, 20)).toEqual({ ascent: 16, descent: 4 });
    expect(lineInk('AB', style, 20)).toEqual({ left: 0, right: 22, ascent: 16, descent: 4, approx: true });
    expect(glyphInk('A', style, 20)).toEqual({ left: -5, right: 5, ascent: 10, descent: 10 });
  });

  it('uses greedy wrapping if the engine has no plain breaker', () => {
    const e = fakeEngine();
    delete e.wrapPlain;
    setTextEngine(e);
    expect(wrapLinesDOM('AB CD', style, 20, 35)).toEqual(['AB', 'CD']);
    expect(e.advance).toHaveBeenCalled();
  });

  it('keeps every no-engine stand-in, including UTF-16 width and code-point ink', () => {
    setTextEngine(null);
    expect(canMeasure()).toBe(false);
    expect(lineWidth('A😀  ', style, 20)).toBe(3 * 20 * 0.55);
    expect(charWidths('A😀', style, 20)).toEqual([11, 11]);
    expect(fontMetrics(style, 20)).toEqual({ ascent: 16, descent: 4 });
    expect(fontMetrics(style, -20)).toEqual({ ascent: 0, descent: 0 });
    expect(baselineInLine(style, 20)).toBe(18);
    expect(lineInk(' A😀 ', style, 20)).toEqual({ left: 13, right: 37, ascent: 16, descent: 4 });
    expect(glyphInk('A😀', style, 20)).toEqual({ left: -11, right: 11, ascent: 10, descent: 10 });
    expect(blockInk(['AB'], style, 20).shift).toBe(0);
    expect(wrapLines('AB CD  \n EF  ', style, 20, 1)).toEqual(['AB CD', ' EF']);
    expect(wrapLinesDOM('AB CD  \n EF  ', style, 20, 1)).toEqual(['AB CD', ' EF']);
    expect(charWidths('', style, 20)).toEqual([]);
    expect(lineWidth('', style, 20)).toBe(0);
    expect(lineInk(' ', style, 20)).toBeNull();
    expect(glyphInk(' ', style, 20)).toBeNull();
    setTypesetEnabled(false);
    expect(layoutLines('\nAB CD\n', style, 20, 1)).toEqual(['AB CD']);
  });
});

it('keeps the realfont lane loud when its canvas-only document is asked to break plain text', () => {
  vi.stubGlobal('document', { createElement(tag) {
    if (tag !== 'canvas') throw new Error(`realfont lane: document.createElement('${tag}') needs a browser DOM.`);
    return { getContext: () => ({}) };
  } });
  setTextEngine(createBrowserTextEngine());
  setTypesetEnabled(false);
  expect(() => layoutLines('AB', style, 20, 100)).toThrow("realfont lane: document.createElement('div') needs a browser DOM.");
});

it('keeps readiness tied to the live font set even when no canvas was available at import', () => {
  expect(browserFaceReady(faceFor(style, 20))).toBe(true);
  const load = vi.fn(() => Promise.resolve([]));
  vi.stubGlobal('document', { fonts: { check: () => false, load } });
  expect(browserFaceReady(faceFor(style, 20))).toBe(false);
  expect(load).toHaveBeenCalledWith(faceFor(style, 20).key);
});

it('hands plain wrapping back to the greedy breaker if the measuring engine outlives the DOM', () => {
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ measureText: (text) => ({ width: text.length * 10 }) }) }) });
  setTextEngine(createBrowserTextEngine());
  vi.stubGlobal('document', undefined);
  expect(wrapLinesDOM('AB CD', style, 20, 35)).toEqual(['AB', 'CD']);
});
