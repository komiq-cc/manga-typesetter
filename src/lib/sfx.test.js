import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { defaultStyle, normalizeStyle, applyBoxDefaults, SFX_MAX_MOVES } from './data.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { clearLayoutMemo } from './measure.js';
import { boxCandidate, placeBlock, curvedStyle, isAutoBox, manualReason, turnedInk, boxInkRect, REVIEW_REASONS } from './contain.js';
import { glyphJob } from './exporter.js';
import { isRasterOnly } from './psd.js';
import { sfxActive, sfxAvailable, sfxLayout, sfxInfo, sfxPresets, sfxKinds, applySfxPreset, clearSfx, enableSfx } from './sfx.js';

// ===========================================================================
// SFX lettering: the style model, the recipe helpers and the seam
// ===========================================================================
// The Rust engine lays SFX out, and the unit lane has none, so these tests
// bring an engine of arithmetic: it measures the stand-in way and answers
// `sfxLayout` with a layout it can be checked against. The real one is
// exercised in sfx.engine.test.js.

const MOVES = [{ kind: 'step', a: 0.2, b: 0 }];
const PARAMS = [];
function fakeEngine({ sfx = true } = {}) {
  const ink = (face, text) => ({ width: [...text].length * face.size * 0.55, left: 0, right: [...text].length * face.size * 0.55, ascent: face.size * 0.7, descent: face.size * 0.2 });
  const e = {
    id: sfx ? 'rust' : 'browser',
    advance: (face, text) => [...text].length * face.size * 0.55,
    fontBox: (face) => ({ ascent: face.size * 0.8, descent: face.size * 0.2 }),
    lineInk: ink,
    // Offsets from a centred, middle-baseline anchor: left/right are the
    // distances to either side (measure.js negates left), as the engine gives.
    glyphInk: (face) => ({ width: face.size * 0.55, left: face.size * 0.25, right: face.size * 0.25, ascent: face.size * 0.4, descent: face.size * 0.4 }),
    loading: () => false,
    onFontsChange: () => () => {},
    faceReady: () => true,
  };
  if (sfx) {
    // One glyph per non-newline code point: row by row down the lines, each
    // letter a step wider than the one before it.
    e.sfxLayout = (face, rows, params) => {
      PARAMS.push({ face, rows, params });
      const out = [];
      rows.forEach((row, r) => {
        [...row].forEach((ch, i) => out.push({ ch, x: i * 10, y: r * params.lineHeight, rot: 0.1, sx: 1 + i * 0.5, sy: 1, skew: 0.2, w: face.size * 0.55 }));
      });
      return out;
    };
    e.sfxInfo = () => ({ kinds: [{ kind: 'step', label: 'Step' }], presets: [{ id: 'stairs', name: 'Stairs up', moves: MOVES }] });
  }
  return e;
}

const original = textEngine();
beforeEach(() => {
  PARAMS.length = 0;
  setTextEngine(fakeEngine());
  clearLayoutMemo();
});
afterEach(() => {
  setTextEngine(original);
  clearLayoutMemo();
});

const sfxStyle = (over = {}) => {
  const s = defaultStyle();
  s.size = 20;
  s.sfx = { on: true, amount: 1, seed: 3, flow: 'row', rowShift: 0, moves: MOVES.map((m) => ({ ...m })) };
  return Object.assign(s, over);
};
const cand = (style, text = 'BOOM') => ({ x: 0, y: 0, w: 200, h: 100, style, text, fit: null });

describe('the sfx field of a style', () => {
  it('is off, with no moves, in a new style and in an old chapter', () => {
    const plain = { on: false, amount: 1, seed: 1, flow: 'row', rowShift: 0, moves: [], before: null };
    expect(defaultStyle().sfx).toEqual(plain);
    const old = defaultStyle();
    delete old.sfx;
    expect(normalizeStyle(old).sfx).toEqual(plain);
    expect(normalizeStyle(undefined).sfx).toEqual(plain);
  });

  it('round-trips a good recipe', () => {
    const sfx = { on: true, amount: 1.5, seed: 42, flow: 'stack', rowShift: -0.4, moves: [{ kind: 'wave', a: 0.3, b: -2 }, { kind: 'grow', a: 0.5, b: 0 }], before: null };
    const once = normalizeStyle({ ...defaultStyle(), sfx });
    expect(once.sfx).toEqual(sfx);
    expect(normalizeStyle(once).sfx).toEqual(sfx);
  });

  it('repairs every field it can and drops what it cannot', () => {
    const fix = (sfx) => normalizeStyle({ sfx }).sfx;
    expect(fix({ amount: 9 }).amount).toBe(2);
    expect(fix({ amount: -1 }).amount).toBe(0);
    expect(fix({ amount: 'x' }).amount).toBe(1);
    expect(fix({ seed: 0 }).seed).toBe(1);
    expect(fix({ seed: 12.6 }).seed).toBe(13);
    expect(fix({ seed: 1e6 }).seed).toBe(9999);
    expect(fix({ flow: 'diagonal' }).flow).toBe('row');
    expect(fix({ flow: 'stack' }).flow).toBe('stack');
    expect(fix({ rowShift: 7 }).rowShift).toBe(2);
    expect(fix({ rowShift: -7 }).rowShift).toBe(-2);
    expect(fix({ on: 'yes' }).on).toBe(false);
    expect(fix({ moves: 'wave' }).moves).toEqual([]);
    expect(
      fix({
        moves: [
          { kind: 'ok', a: 1, b: 2 },
          { kind: '', a: 1, b: 2 },
          { kind: 7, a: 1, b: 2 },
          { kind: 'nan', a: NaN, b: 0 },
          { kind: 'inf', a: 0, b: Infinity },
          { kind: 'str', a: '1', b: 0 },
          { kind: 'gap', a: 1 },
          null,
          { kind: 'extra', a: 1, b: 2, c: 3 },
        ],
      }).moves,
    ).toEqual([{ kind: 'ok', a: 1, b: 2 }, { kind: 'extra', a: 1, b: 2 }]);
  });

  it('keeps at most SFX_MAX_MOVES moves', () => {
    const moves = Array.from({ length: SFX_MAX_MOVES + 5 }, (_, i) => ({ kind: `k${i}`, a: i, b: 0 }));
    const got = normalizeStyle({ sfx: { moves } }).sfx.moves;
    expect(got).toHaveLength(SFX_MAX_MOVES);
    expect(got[0].kind).toBe('k0');
  });

  it('is plain text again on a newborn box', () => {
    const s = sfxStyle();
    applyBoxDefaults(s);
    expect(s.sfx).toEqual(defaultStyle().sfx);
  });
});

describe('applying a preset', () => {
  const preset = (over = {}) => ({ id: 'p', name: 'P', group: 'Move', flow: 'stack', rowShift: 0.3, gap: -0.1, lineHeight: null, moves: [{ kind: 'step', a: 0.2, b: 0 }, { kind: 'tilt', a: 5, b: 1 }], ...over });

  it('writes the recipe, the gaps, and keeps the box seed', () => {
    const s = sfxStyle({ lineHeight: 1.3 });
    applySfxPreset(s, preset());
    expect(s.sfx).toEqual({ on: true, amount: 1, seed: 3, flow: 'stack', rowShift: 0.3, moves: [{ kind: 'step', a: 0.2, b: 0 }, { kind: 'tilt', a: 5, b: 1 }], before: null });
    expect(s.letterSpacing).toBeCloseTo(-2);
    expect(s.lineHeight).toBe(1.3);
    applySfxPreset(s, preset({ lineHeight: 0.8 }));
    expect(s.lineHeight).toBe(0.8);
  });

  it('copies the moves, so editing the style does not edit the preset', () => {
    const p = preset();
    const s = sfxStyle();
    applySfxPreset(s, p);
    s.sfx.moves[0].a = 99;
    expect(p.moves[0].a).toBe(0.2);
  });

  it('switches the other glyph layouts off', () => {
    const s = sfxStyle({ curve: 40 });
    s.circle.on = true;
    s.path.on = true;
    s.sfx.on = false;
    applySfxPreset(s, preset());
    expect(s.sfx.on).toBe(true);
    expect(s.curve).toBe(0);
    expect(s.circle.on).toBe(false);
    expect(s.path.on).toBe(false);
  });

  it('leaves colour and strokes alone, whatever the preset says', () => {
    const s = sfxStyle({ color: '#123456', strokes: [{ color: '#abcdef', width: 5, opacity: 0.5 }] });
    applySfxPreset(s, preset({ look: 'outline' }));
    expect(s.color).toBe('#123456');
    expect(s.strokes).toEqual([{ color: '#abcdef', width: 5, opacity: 0.5 }]);
  });

  it('clearSfx keeps the recipe, enableSfx brings it back', () => {
    const s = sfxStyle({ curve: 30 });
    clearSfx(s);
    expect(s.sfx.on).toBe(false);
    expect(s.sfx.moves).toEqual(MOVES);
    enableSfx(s);
    expect(s.sfx.on).toBe(true);
    expect(s.curve).toBe(0);
  });
});

describe('Remove SFX', () => {
  const preset = (over = {}) => ({ id: 'p', name: 'P', group: 'Move', flow: 'row', rowShift: 0, gap: -0.1, lineHeight: 0.8, moves: MOVES, ...over });
  const plain = (over = {}) => {
    const s = normalizeStyle({ ...defaultStyle(), size: 20, letterSpacing: 3, lineHeight: 1.3, color: '#123456', ...over });
    return s;
  };

  it('puts the gaps and the bends back as they were', () => {
    const s = plain({ curve: 40 });
    s.circle.on = true;
    const was = JSON.parse(JSON.stringify(s));
    applySfxPreset(s, preset());
    expect(s.letterSpacing).toBeCloseTo(-2);
    expect(s.lineHeight).toBe(0.8);
    expect(s.curve).toBe(0);
    expect(s.sfx.before).toMatchObject({ letterSpacing: 3, lineHeight: 1.3, curve: 40, circle: true, path: false });
    clearSfx(s);
    expect(s.sfx.on).toBe(false);
    expect(s.sfx.before).toBe(null);
    // Everything but the recipe SFX keeps is the box as it stood.
    expect({ ...s, sfx: null }).toEqual({ ...was, sfx: null });
  });

  it('goes back to the box, not to the preset picked before', () => {
    const s = plain();
    applySfxPreset(s, preset());
    applySfxPreset(s, preset({ gap: 0.2, lineHeight: null }));
    // A preset with no line gap of its own has the box's, not the last preset's.
    expect(s.lineHeight).toBe(1.3);
    expect(s.letterSpacing).toBeCloseTo(4);
    expect(s.sfx.before.letterSpacing).toBe(3);
    clearSfx(s);
    expect(s.letterSpacing).toBe(3);
    expect(s.lineHeight).toBe(1.3);
  });

  it('survives a save and a load, and an undo snapshot', () => {
    const s = plain();
    applySfxPreset(s, preset());
    const back = normalizeStyle(JSON.parse(JSON.stringify(s)));
    expect(back.sfx.before).toEqual(s.sfx.before);
    clearSfx(back);
    expect(back.letterSpacing).toBe(3);
  });

  it('leaves the bends to a caller that is switching one on', () => {
    const s = plain({ curve: 40 });
    applySfxPreset(s, preset());
    s.circle.on = true;
    clearSfx(s, null, true);
    expect(s.letterSpacing).toBe(3);
    expect(s.curve).toBe(0);
    expect(s.circle.on).toBe(true);
  });
});

describe('under the browser engine SFX is inert', () => {
  beforeEach(() => {
    setTextEngine(fakeEngine({ sfx: false }));
    clearLayoutMemo();
  });

  it('is not available and never active', () => {
    expect(sfxAvailable()).toBe(false);
    expect(sfxActive(sfxStyle())).toBe(false);
    expect(sfxLayout('BOOM', sfxStyle(), 20)).toEqual([]);
    expect(sfxInfo()).toEqual({ kinds: [], presets: [] });
    expect(sfxPresets()).toEqual([]);
    expect(sfxKinds()).toEqual([]);
  });

  it('is not available with no engine at all', () => {
    setTextEngine(null);
    expect(sfxAvailable()).toBe(false);
    expect(sfxActive(sfxStyle())).toBe(false);
  });

  it('places an SFX box exactly as the same style with the switch off', () => {
    for (const text of ['BOOM', 'GR\nIP!', '']) {
      const on = placeBlock(cand(sfxStyle(), text));
      const off = placeBlock(cand(sfxStyle({ sfx: { ...sfxStyle().sfx, on: false } }), text));
      expect(on.isCurve).toBe(false);
      expect({ ...on, s: null }).toEqual({ ...off, s: null });
    }
    expect(curvedStyle(sfxStyle())).toBe(false);
    expect(isAutoBox(cand(sfxStyle()))).toBe(true);
    expect(isRasterOnly(sfxStyle())).toBe(false);
  });

  it('keeps an arc an arc', () => {
    const arc = placeBlock(cand(sfxStyle({ curve: 40 })));
    expect(arc.isCurve).toBe(true);
    expect(arc.layout.every((g) => g.sx === undefined)).toBe(true);
  });
});

describe('sfxActive', () => {
  it('wants the switch, a move and an engine that can', () => {
    expect(sfxActive(sfxStyle())).toBe(true);
    expect(sfxActive(sfxStyle({ sfx: { ...sfxStyle().sfx, on: false } }))).toBe(false);
    expect(sfxActive(sfxStyle({ sfx: { ...sfxStyle().sfx, moves: [] } }))).toBe(false);
    expect(sfxActive({})).toBe(false);
    expect(sfxActive(null)).toBe(false);
  });

  it('asks the engine once and keeps its table', () => {
    expect(sfxKinds()).toEqual([{ kind: 'step', label: 'Step' }]);
    expect(sfxPresets()[0].id).toBe('stairs');
    expect(sfxInfo()).toBe(sfxInfo());
  });

  // The table was kept beside the last engine that gave one, and the browser
  // engine gives none: switching Rust off left the Rust engine, and all of its
  // wasm memory, held by the SFX panel's table for as long as the app ran.
  it('does not keep alive an engine the app has let go of', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    let ref;
    (() => {
      const e = fakeEngine();
      ref = new WeakRef(e);
      setTextEngine(e);
      expect(sfxPresets()[0].id).toBe('stairs');
    })();
    setTextEngine(fakeEngine({ sfx: false }));
    expect(sfxPresets()).toEqual([]);
    clearLayoutMemo();
    await new Promise((r) => setTimeout(r, 0));
    gc();
    expect(ref.deref()).toBeUndefined();
  });
});

describe('placeBlock with the Rust engine', () => {
  it('lays an SFX box out glyph by glyph, before the arc, the ring and the path', () => {
    const s = sfxStyle({ curve: 50 });
    s.circle.on = true;
    const p = placeBlock(cand(s));
    expect(p.isCurve).toBe(true);
    expect(p.layout.map((g) => g.ch)).toEqual([...'BOOM']);
    for (const g of p.layout) for (const k of ['x', 'y', 'rot', 'sx', 'sy', 'skew', 'w']) expect(Number.isFinite(g[k])).toBe(true);
    expect(PARAMS).toHaveLength(1);
  });

  it('is a manual box, never fitted', () => {
    const c = cand(sfxStyle());
    expect(curvedStyle(c.style)).toBe(true);
    expect(isAutoBox(c)).toBe(false);
    expect(manualReason(c)).toBe(REVIEW_REASONS.curve);
    expect(isRasterOnly(c.style)).toBe(true);
  });

  it('hands the engine the rows, the line height and the spacing, scaled to the size', () => {
    const s = sfxStyle({ lineHeight: 1.5, letterSpacing: 4, size: 20 });
    s.sfx = { ...s.sfx, amount: 1.25, seed: 77, flow: 'stack', rowShift: 0.5 };
    sfxLayout('GR\nIP!', s, 40);
    const { face, rows, params } = PARAMS[0];
    expect(rows).toEqual(['GR', 'IP!']);
    expect(face.size).toBe(40);
    expect(params).toEqual({ lineHeight: 60, letterSpacing: 8, amount: 1.25, seed: 77, flow: 'stack', rowShift: 0.5, moves: MOVES });
    // A style with no line height is one line high.
    sfxLayout('A', sfxStyle({ lineHeight: 0 }), 20);
    expect(PARAMS[1].params.lineHeight).toBe(20);
  });

  it('keeps one glyph per code point, a newline getting one of no advance', () => {
    const l = sfxLayout('GR\nIP!', sfxStyle(), 20);
    expect(l.map((g) => g.ch)).toEqual([...'GR\nIP!']);
    expect(l[2]).toEqual({ ch: '\n', x: l[1].x, y: l[1].y, rot: 0, sx: 1, sy: 1, skew: 0, w: 0 });
    expect(l[3].ch).toBe('I');
    expect(sfxLayout('', sfxStyle(), 20)).toEqual([]);
    expect(placeBlock(cand(sfxStyle(), '   ')).isCurve).toBe(false);
  });

  it('is the plain block when the engine refuses the recipe', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    textEngine().sfxLayout = () => {
      throw new Error('BadSpec');
    };
    expect(sfxLayout('BOOM', sfxStyle(), 20)).toEqual([]);
    const p = placeBlock(cand(sfxStyle()));
    expect(p.isCurve).toBe(false);
    expect(p.lines).toEqual(['BOOM']);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('puts the extra fields on the exporter run, and only when there are any', () => {
    const s = sfxStyle();
    const layout = { s, ox: 0, oy: 0, isCurve: true, layout: [{ ch: 'B', x: 1, y: 2, rot: 0.1, sx: 2, sy: 1.5, skew: -0.3, w: 5 }, { ch: 'O', x: 3, y: 4, rot: 0, w: 5 }] };
    const runs = glyphJob({ w: 100, h: 50 }, layout).runs;
    expect(runs[0]).toMatchObject({ text: 'B', x: 51, y: 27, rot: 0.1, sx: 2, sy: 1.5, skew: -0.3 });
    expect(Object.keys(runs[1]).sort()).toEqual(['fill', 'rot', 'text', 'x', 'y']);
  });
});

describe('the ink of a scaled and leaned glyph', () => {
  const k = { left: -5, right: 5, ascent: 8, descent: 4 };

  it('is the old rectangle for a glyph without the fields', () => {
    const old = turnedInk(k, 0.4, 100, 50);
    expect(turnedInk(k, 0.4, 100, 50, undefined, undefined, undefined)).toEqual(old);
    expect(turnedInk(k, 0.4, 100, 50, 1, 1, 0)).toEqual(old);
    expect(turnedInk(k, 0, 100, 50)).toEqual([95, 42, 105, 54]);
  });

  it('scales about the glyph centre', () => {
    expect(turnedInk(k, 0, 100, 50, 2, 3, 0)).toEqual([90, 26, 110, 62]);
  });

  it('reaches sideways by the lean times the height', () => {
    const [x0, y0, x1, y1] = turnedInk(k, 0, 100, 50, 1, 1, Math.atan(0.5));
    expect([y0, y1]).toEqual([42, 54]);
    // A positive skew leans the top right: the top (v = -8) slides +4, the
    // bottom (v = 4) slides -2.
    expect(x0).toBeCloseTo(100 - 5 - 2);
    expect(x1).toBeCloseTo(100 + 5 + 4);
  });

  it('boxInkRect grows with a scaled glyph and is unchanged without', () => {
    const s = { ...defaultStyle(), size: 20, strokes: [], shadows: [] };
    const c = cand(s);
    const plain = { s, text: 'A', isCurve: true, layout: [{ ch: 'A', x: 0, y: 0, rot: 0, w: 11 }] };
    const same = { ...plain, layout: [{ ...plain.layout[0], sx: 1, sy: 1, skew: 0 }] };
    const big = { ...plain, layout: [{ ...plain.layout[0], sx: 2, sy: 1, skew: 0 }] };
    const r0 = boxInkRect(c, plain);
    expect(boxInkRect(c, same)).toEqual(r0);
    const r2 = boxInkRect(c, big);
    expect(r2.w).toBeCloseTo(r0.w * 2);
    expect(r2.h).toBeCloseTo(r0.h);
  });
});
