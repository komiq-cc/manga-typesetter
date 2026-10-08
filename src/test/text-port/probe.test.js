import { describe, it, expect, vi } from 'vitest';
import { probe, pixelStats } from './probe.js';
import { completeStyle } from './corpus.js';
import { prepareFonts } from './fonts.js';

const imageData = { width: 2, height: 2, data: new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255, 0, 0, 0, 0]) };
function fakeApp() {
  return {
    fontByName: (name) => name === 'Comic Neue' ? { name } : null,
    setTypesetEnabled: vi.fn(), applyCase: (s, style) => style.uppercase ? s.toUpperCase() : s,
    lineWidth: vi.fn(() => 12.345), charWidths: () => [1, 2], fontMetrics: () => ({ ascent: 8, descent: 2 }),
    lineInk: () => ({ left: -2, right: 8, ascent: 7, descent: 2, approx: true }), glyphInk: () => null,
    boxCandidate: (box, text) => ({ ...box, text }),
    placeBlock: () => ({ lines: ['AB'], lineX: [10], blockY: 3, blockH: 11, baseY: 8, lineH: 11, isCurve: false }),
    boxInkRect: () => ({ x: 1, y: 2, w: 3, h: 4 }), containBox: () => ({ fits: true, overflow: { l: 0, t: 0, r: 0, b: 0 } }),
    solveLayout: () => ({ size: 22, x: 1, y: 2, w: 3, h: 4, lines: ['AB'], status: 'ok', reasons: ['wide word'] }),
    renderBoxTexture: () => ({ canvas: { width: 2, height: 2, getContext: () => ({ getImageData: () => imageData }) }, ox: 1, oy: 2, cw: 1, ch: 1, ss: 2 }),
    renderBoxLayer: () => ({ imageData, left: 4, top: 5 }),
  };
}
const options = { families: ['Comic Neue'] };
const boxCase = (id, extra = {}) => ({ id, mode: 'smart', page: { w: 800, h: 1200 }, box: { x: 1, y: 2, w: 100, h: 60, text: 'AB', style: completeStyle() }, ...extra });
describe('text-port probe', () => {
  it('records every measurement without rounding and limits glyphs by code point', () => {
    const app = fakeApp();
    const c = { id: 'm.a', font: 'Comic Neue', bold: true, italic: false, size: 22, text: '😀ABCDEFGHIJKLMNOPQRSTUVWXYZ', style: completeStyle({ letterSpacing: 3 }) };
    const [{ record }] = [...probe(app, 'metrics', [c], options)];
    expect(record).toEqual({ id: 'm.a', adv: 12.345, chars: [1, 2], font: { ascent: 8, descent: 2 }, ink: { left: -2, right: 8, ascent: 7, descent: 2, approx: true }, glyphs: Object.fromEntries([...c.text].slice(0, 24).map((ch) => [ch, null])) });
    expect(app.lineWidth.mock.calls[0][1].letterSpacing).toBe(0);
  });
  it('records placement, containment, curved glyphs and solver answers', () => {
    const app = fakeApp();
    const [{ record }] = [...probe(app, 'layout', [boxCase('l.a')], options)];
    expect(record).toEqual({ id: 'l.a', lines: ['AB'], lineX: [10], blockY: 3, blockH: 11, baseY: 8, lineH: 11, curve: null, ink: { l: 1, t: 2, r: 4, b: 6 }, verdict: { fits: true, overflow: { l: 0, t: 0, r: 0, b: 0 } } });
    const curve = [{ ch: 'A', x: 1, y: 2, rot: 0.1, w: 8 }];
    app.placeBlock = () => ({ isCurve: true, layout: curve });
    expect([...probe(app, 'layout', [boxCase('l.arc')], options)][0].record).toMatchObject({ curve, lines: null, blockY: null });
    expect([...probe(app, 'layout', [{ id: 'l.solve', mode: 'smart', solve: { style: completeStyle() } }], options)][0].record.solve).toEqual({ size: 22, x: 1, y: 2, w: 3, h: 4, lines: ['AB'], status: 'ok', reason: ['wide word'] });
  });
  it('returns host-encodable texture and layer pixels with exact alpha statistics', () => {
    const [texture, layer] = [...probe(fakeApp(), 'pixels', [boxCase('p.a'), boxCase('p.b', { via: 'layer' })], options)];
    expect(texture.record).toEqual({ id: 'p.a', png: 'png/p.a.png', ox: 1, oy: 2, cw: 1, ch: 1, ss: 2, bbox: [0, 0, 2, 2], alphaSum: 383 });
    expect(texture.canvas).toBeTruthy();
    expect(layer.record).toEqual({ id: 'p.b', png: 'png/p.b.png', left: 4, top: 5, cw: 2, ch: 2, ss: 1, bbox: [0, 0, 2, 2], alphaSum: 383 });
    expect(layer.imageData).toBe(imageData);
    expect(pixelStats({ width: 1, height: 1, data: [0, 0, 0, 0] })).toEqual({ bbox: null, alphaSum: 0 });
  });
  it('retains plain and empty layer skips, unknown fonts and per-case errors', () => {
    const app = fakeApp();
    const cases = [boxCase('l.plain', { mode: 'plain' }), boxCase('l.bad'), boxCase('l.ok')];
    const place = app.placeBlock;
    app.placeBlock = (c) => { if (c.id === 'l.bad') throw new Error('broken case'); return place(c); };
    // Fake boxCandidate preserves the id for this failure injection.
    cases.forEach((c) => { c.box.id = c.id; });
    const results = [...probe(app, 'layout', cases, { ...options, browser: false })].map((r) => r.record);
    expect(results.map((r) => r.id)).toEqual(cases.map((c) => c.id));
    expect(results[0].skip).toContain('browser DOM');
    expect(results[1]).toEqual({ id: 'l.bad', error: 'broken case' });
    expect(results[2].lines).toEqual(['AB']);
    const off = boxCase('l.off');
    off.box.style.shape = 'off';
    expect([...probe(app, 'layout', [off], { ...options, browser: false })][0].record.skip).toContain("shape: 'off'");
    app.renderBoxLayer = () => null;
    expect([...probe(app, 'pixels', [boxCase('p.empty', { via: 'layer' })], options)][0].record.skip).toContain('paints no pixels');
    const unknown = boxCase('l.unknown');
    unknown.box.style.font = 'Unknown';
    expect([...probe(app, 'layout', [unknown], options)][0].record.error).toContain("Font 'Unknown'");
  });
  it('installs exact store families and rejects duplicate faces and fallback resolution', () => {
    const app = { fonts: {} };
    const store = { app, fontByName: (name) => app.fonts.user.find((f) => f.name === name), fontCssFor: (name) => app.fonts.user.find((f) => f.name === name)?.css };
    const list = { fonts: [{ family: 'DejaVu Sans', slot: 'italic', file: 'x.ttf' }] };
    expect(prepareFonts(store, list)).toEqual(['DejaVu Sans']);
    expect(app.fonts.user[0]).toEqual({ name: 'DejaVu Sans', css: "'DejaVu Sans'", real: true, faces: { regular: null, bold: null, italic: { file: 'x.ttf' }, boldItalic: null } });
    expect(() => prepareFonts(store, { fonts: [...list.fonts, ...list.fonts] })).toThrow('Duplicate');
    expect(() => prepareFonts({ ...store, fontCssFor: () => "'Comic Neue'" }, list)).toThrow('substituted');
  });
});
