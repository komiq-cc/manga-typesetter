import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { rustEngine, FIXTURE_FACES } from '../test/rust-engine.js';
import { textEngine, setTextEngine, setGlyphPainter, glyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { clearLayoutMemo } from './measure.js';
import { defaultStyle } from './data.js';
import { boxCandidate, placeBlock, curvedStyle, isAutoBox, boxInkRect } from './contain.js';
import { glyphJob } from './exporter.js';
import { sfxActive, sfxAvailable, sfxInfo, sfxLayout, sfxKinds, sfxPresets, applySfxPreset, clearSfx, envelopeWarp, envelopeOf, isEnvelope } from './sfx.js';
import { warpActive, identityMesh } from './warp.js';

// ===========================================================================
// SFX lettering against the real Rust engine
// ===========================================================================
// The unit lane (sfx.test.js) pins the JS side against an engine of arithmetic;
// this is the same seam with the real one: the layout the wasm gives, carried
// through `placeBlock`, and a box painted with it.
//
// Needs a wasm built with `sfxLayout` and `sfxInfo` (npm run build:engine). One
// that lacks them fails the first test, saying so, rather than skipping.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const defaultEngine = textEngine();
const defaultPainter = glyphPainter();
let rust;
beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  for (const [family, , file] of FIXTURE_FACES) {
    GlobalFonts.registerFromPath(fileURLToPath(new URL(`../test/fonts/${file}`, import.meta.url)), family);
  }
  rust = await rustEngine();
});
afterEach(() => {
  setTextEngine(defaultEngine);
  setGlyphPainter(defaultPainter);
  clearLayoutMemo();
});
afterAll(() => {
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const style = (over = {}) => ({ ...defaultStyle(), font: 'Bangers', size: 40, strokes: [], lineHeight: 1.1, ...over });
const sfx = (moves, over = {}) => ({ on: true, amount: 1, seed: 5, flow: 'row', rowShift: 0, moves, ...over });
const cand = (s, text = 'BOOM') => ({ x: 0, y: 0, w: 500, h: 200, style: s, text, fit: null });
const use = () => {
  setTextEngine(rust);
  clearLayoutMemo();
};
// A move of the engine's own "grow" kind, strong enough to show.
function growMove() {
  use();
  const k = sfxKinds().find((x) => x.kind === 'grow');
  if (!k) throw new Error('the engine has no "grow" kind');
  return { kind: 'grow', a: k.max, b: k.b?.default ?? 0 };
}

describe('the engine behind the SFX seam', () => {
  it('has the two methods, and says what it can do', () => {
    expect(rust.sfxLayout, 'this wasm has no sfxLayout: run npm run build:engine').toBeTypeOf('function');
    expect(rust.sfxInfo).toBeTypeOf('function');
    use();
    expect(sfxAvailable()).toBe(true);
    const info = sfxInfo();
    expect(info.kinds.length).toBeGreaterThan(0);
    expect(info.presets.length).toBeGreaterThan(0);
    const kinds = new Set(info.kinds.map((k) => k.kind));
    // A preset is a recipe of moves, or an envelope that bends the box: one of
    // the two and never both. (The wrapper keeps the kinds and the presets; the
    // list of envelope kinds is on the engine's own table.)
    const envelopes = rust.sfxInfo().envelopes;
    expect(envelopes).toEqual(expect.arrayContaining(['arch', 'valley', 'flag', 'rise']));
    for (const p of info.presets) {
      const env = p.envelope;
      expect((p.moves.length > 0) !== !!env, `${p.id}: moves or an envelope, not both and not neither`).toBe(true);
      for (const m of p.moves) expect(kinds.has(m.kind), `${p.id}: ${m.kind}`).toBe(true);
      if (!env) continue;
      expect(envelopes, `${p.id}: ${env.kind}`).toContain(env.kind);
      expect(Number.isFinite(env.bend), `${p.id}: bend`).toBe(true);
      for (const k of ['cols', 'rows']) {
        expect(Number.isInteger(env[k]) && env[k] >= 1 && env[k] <= 24, `${p.id}: ${k} ${env[k]}`).toBe(true);
      }
    }
    expect(sfxPresets()).toBe(info.presets);
  });

  it('knows the Shape presets and the drip', () => {
    use();
    const byId = Object.fromEntries(sfxPresets().map((p) => [p.id, p]));
    for (const id of ['valley']) {
      expect(byId[id], id).toBeTruthy();
      expect(byId[id].group, id).toBe('Shape');
      expect(byId[id].envelope.kind, id).toBe(id);
      expect(byId[id].moves, id).toEqual([]);
    }
    expect(byId.drip.group).toBe('Hand');
    expect(byId.drip.envelope ?? null).toBe(null);
    expect(sfxKinds().map((k) => k.kind)).toContain('drip');
  });

  it('is not there for the browser engine', async () => {
    const { createBrowserTextEngine } = await import('./text-engine/browser.js');
    const browser = createBrowserTextEngine();
    expect(browser).not.toBeNull();
    expect('sfxLayout' in browser).toBe(false);
    expect('sfxInfo' in browser).toBe(false);
  });
});

describe('placeBlock with the real engine', () => {
  it('gives one glyph per code point, each with its scale and lean', () => {
    use();
    const s = style({ sfx: sfx([growMove()]) });
    expect(sfxActive(s)).toBe(true);
    for (const text of ['BOOM', 'GR\nIP!']) {
      const p = placeBlock(cand(s, text));
      expect(p.isCurve).toBe(true);
      expect(p.layout.map((g) => g.ch)).toEqual([...text]);
      for (const g of p.layout) for (const k of ['x', 'y', 'rot', 'sx', 'sy', 'skew', 'w']) expect(Number.isFinite(g[k]), `${g.ch}.${k}`).toBe(true);
    }
    expect(curvedStyle(s)).toBe(true);
    expect(isAutoBox(cand(s))).toBe(false);
  });

  it('is the plain block when the switch is off, whatever the recipe', () => {
    use();
    const p = placeBlock(cand(style({ sfx: sfx([growMove()], { on: false }) })));
    expect(p.isCurve).toBe(false);
  });

  it('lays every built-in preset out, finite, in a box that holds something', () => {
    use();
    expect(sfxPresets().length).toBeGreaterThan(0);
    for (const preset of sfxPresets()) {
      const s = style();
      if (preset.envelope) {
        // An envelope makes no SFX layout: its recipe has no moves, the text
        // is set plain, and what shapes it is the mesh the preset wrote.
        const box = { w: 500, h: 200 };
        applySfxPreset(s, preset, box);
        const { cols, rows } = preset.envelope;
        expect(s.warp.on, preset.id).toBe(true);
        expect([s.warp.cols, s.warp.rows], preset.id).toEqual([cols, rows]);
        expect(s.warp.pts, preset.id).toHaveLength((cols + 1) * (rows + 1));
        for (const pt of s.warp.pts) expect(pt.length === 2 && pt.every(Number.isFinite), preset.id).toBe(true);
        expect(warpActive(s, box.w, box.h), preset.id).toBe(true);
        expect(sfxActive(s), preset.id).toBe(false);
        expect(placeBlock(cand(s, 'BOOM!')).isCurve, preset.id).toBe(false);
        continue;
      }
      applySfxPreset(s, preset);
      const c = cand(s, 'BOOM!');
      const p = placeBlock(c);
      expect(p.isCurve, preset.id).toBe(true);
      expect(p.layout, preset.id).toHaveLength(5);
      for (const g of p.layout) for (const k of ['x', 'y', 'rot', 'sx', 'sy', 'skew']) expect(Number.isFinite(g[k]), `${preset.id} ${g.ch}.${k}`).toBe(true);
      const r = boxInkRect(c, p);
      expect(r && r.w > 0 && r.h > 0, preset.id).toBe(true);
    }
  });

  it('does not move on a second call', () => {
    use();
    const s = style({ sfx: sfx([growMove()]) });
    expect(sfxLayout('BOOM', s, 40)).toEqual(sfxLayout('BOOM', s, 40));
  });

  it('gives a dripping glyph the length of its drip, and the others none', () => {
    use();
    const drip = sfxPresets().find((p) => p.id === 'drip');
    const s = style();
    applySfxPreset(s, drip);
    const layout = sfxLayout('BOOM!', s, 40);
    expect(layout).toHaveLength(5);
    for (const g of layout) {
      expect(Number.isFinite(g.drip), `${g.ch}.drip`).toBe(true);
      expect(g.drip, `${g.ch}.drip`).toBeGreaterThanOrEqual(0);
    }
    expect(layout.some((g) => g.drip > 0)).toBe(true);
    // A recipe with no drip in it has none to give.
    const plain = style({ sfx: sfx([growMove()]) });
    for (const g of sfxLayout('BOOM!', plain, 40)) expect(g.drip ?? 0, g.ch).toBe(0);
  });
});

// ---- the presets that bend the box ----
describe('an envelope preset', () => {
  const BOX = { w: 400, h: 120 };
  const preset = (id) => {
    use();
    return sfxPresets().find((p) => p.id === id);
  };
  const hand = (cols = 3, rows = 2) => {
    const pts = identityMesh(cols, rows, BOX.w, BOX.h);
    pts[cols + 1 + 1] = [pts[cols + 1 + 1][0] + 14, pts[cols + 1 + 1][1] - 11];
    return { on: true, cols, rows, pts };
  };
  const same = (a, b) => a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);

  it('writes the engine\'s own mesh to the box, and is recognised by it', () => {
    const valley = preset('valley');
    const s = style();
    applySfxPreset(s, valley, BOX);
    const env = valley.envelope;
    const made = rust.sfxEnvelope(env.kind, env.bend, env.cols, env.rows, BOX.w, BOX.h);
    expect(s.warp.on).toBe(true);
    expect([s.warp.cols, s.warp.rows]).toEqual([env.cols, env.rows]);
    expect(s.warp.pts).toHaveLength(made.length);
    for (const [i, pt] of s.warp.pts.entries()) {
      expect(pt[0], `x ${i}`).toBeCloseTo(made[i][0], 6);
      expect(pt[1], `y ${i}`).toBeCloseTo(made[i][1], 6);
    }
    expect(envelopeWarp(env, BOX.w, BOX.h).pts).toEqual(s.warp.pts);
    expect(isEnvelope(s, env, BOX.w, BOX.h)).toBe(true);
    expect(envelopeOf(s, BOX.w, BOX.h)?.id).toBe('valley');
    // Not another shape's, and not at another size.
    expect(isEnvelope(s, { ...env, kind: 'arch' }, BOX.w, BOX.h)).toBe(false);
    expect(isEnvelope(s, env, BOX.w, BOX.h + 40)).toBe(false);
    // It has no moves, so the text is not an SFX layout.
    expect(s.sfx.on).toBe(true);
    expect(s.sfx.moves).toEqual([]);
    expect(sfxActive(s)).toBe(false);
  });

  it('replaces a mesh the user made', () => {
    const s = style({ warp: hand() });
    const before = s.warp.pts.map((p) => [...p]);
    applySfxPreset(s, preset('valley'), BOX);
    const env = preset('valley').envelope;
    expect([s.warp.cols, s.warp.rows]).toEqual([env.cols, env.rows]);
    expect(isEnvelope(s, env, BOX.w, BOX.h)).toBe(true);
    expect(same(s.warp.pts, before)).toBe(false);
    // And Remove gives the user's mesh back.
    clearSfx(s, BOX);
    expect(s.warp.on).toBe(true);
    expect(same(s.warp.pts, before)).toBe(true);
  });

  it('gives a mesh the user made back when a preset without an envelope follows it', () => {
    const s = style({ warp: hand() });
    const before = s.warp.pts.map((p) => [...p]);
    applySfxPreset(s, preset('valley'), BOX);
    applySfxPreset(s, preset('grow'), BOX);
    expect(s.warp.on).toBe(true);
    expect(same(s.warp.pts, before)).toBe(true);
  });

  it('goes away when another preset without an envelope is picked after it', () => {
    const s = style();
    applySfxPreset(s, preset('valley'), BOX);
    expect(warpActive(s, BOX.w, BOX.h)).toBe(true);
    applySfxPreset(s, preset('grow'), BOX);
    expect(s.warp.on).toBe(false);
    expect(s.warp.pts).toEqual([]);
    expect(sfxActive(s)).toBe(true);
    expect(s.sfx.moves.length).toBeGreaterThan(0);
  });

  it('is not what picking another preset takes from a mesh the user made', () => {
    const s = style({ warp: hand() });
    const before = JSON.parse(JSON.stringify(s.warp));
    applySfxPreset(s, preset('grow'), BOX);
    expect(s.warp).toEqual(before);
    expect(sfxActive(s)).toBe(true);
  });

  it('is no longer the preset\'s once a point is moved, and Remove leaves the mesh', () => {
    const valley = preset('valley');
    const s = style();
    applySfxPreset(s, valley, BOX);
    const mesh = () => JSON.parse(JSON.stringify(s.warp));
    s.warp.pts[2] = [s.warp.pts[2][0] + 5, s.warp.pts[2][1]];
    expect(isEnvelope(s, valley.envelope, BOX.w, BOX.h)).toBe(false);
    expect(envelopeOf(s, BOX.w, BOX.h)).toBe(null);
    const edited = mesh();
    clearSfx(s, BOX);
    expect(s.sfx.on).toBe(false);
    expect(s.warp).toEqual(edited);
    expect(s.warp.on).toBe(true);
  });

  it('is taken away by Remove while it is untouched', () => {
    const s = style();
    applySfxPreset(s, preset('valley'), BOX);
    expect(warpActive(s, BOX.w, BOX.h)).toBe(true);
    clearSfx(s, BOX);
    expect(s.sfx.on).toBe(false);
    expect(s.warp.on).toBe(false);
    expect(s.warp.pts).toEqual([]);
    expect(warpActive(s, BOX.w, BOX.h)).toBe(false);
  });

  it('leaves the mesh as it was when no box says how big to make it', () => {
    const valley = preset('valley');
    const s = style({ warp: hand() });
    const before = JSON.parse(JSON.stringify(s.warp));
    applySfxPreset(s, valley);
    expect(s.warp).toEqual(before);
    // And an envelope laid on a box already bent is not taken off by Remove.
    clearSfx(s);
    expect(s.warp).toEqual(before);
    // The style a preset was applied to without a box has no mesh made for it.
    const fresh = style();
    const none = JSON.parse(JSON.stringify(fresh.warp));
    applySfxPreset(fresh, valley);
    expect(fresh.warp).toEqual(none);
    expect(fresh.sfx.on).toBe(true);
  });
});

// Where a canvas has ink: the box of pixels with any alpha.
function inkBox(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 128) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

describe('a painted SFX box', () => {
  // The job `renderBoxTexture` would hand the painter, from `placeBlock`'s own
  // place, painted by the Rust painter onto a canvas.
  function painted(s, text) {
    use();
    const c = cand(s, text);
    const p = placeBlock(c);
    const L = p.isCurve
      ? { s, ox: 0, oy: 0, isCurve: true, layout: p.layout }
      : { s, ox: 0, oy: 0, isCurve: false, lines: p.lines, lineX: p.lineX, blockY: p.blockY, lineH: p.lineH, baseY: p.baseY };
    const canvas = createCanvas(500, 200);
    createRustGlyphPainter(rust).paint(canvas.getContext('2d'), glyphJob({ w: 500, h: 200 }, L));
    return inkBox(canvas);
  }

  it('is wider with "grow" than the same text set plain', () => {
    const plain = painted(style(), 'BOOM');
    const grown = painted(style({ sfx: sfx([growMove()]) }), 'BOOM');
    expect(plain).not.toBeNull();
    expect(grown).not.toBeNull();
    expect(grown.w).toBeGreaterThan(plain.w);
  });

  it('is painted inside what boxInkRect says it covers', () => {
    const s = style({ sfx: sfx([growMove()]) });
    const ink = painted(s, 'BOOM');
    const r = boxInkRect(cand(s, 'BOOM'));
    expect(ink.x0).toBeGreaterThanOrEqual(Math.floor(r.x) - 1);
    expect(ink.x1).toBeLessThanOrEqual(Math.ceil(r.x + r.w) + 1);
    expect(ink.y0).toBeGreaterThanOrEqual(Math.floor(r.y) - 1);
    expect(ink.y1).toBeLessThanOrEqual(Math.ceil(r.y + r.h) + 1);
  });
});
