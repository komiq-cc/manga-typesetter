import { afterEach, describe, expect, it, vi } from 'vitest';
import { glyphJob, renderBoxTexture } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createBrowserGlyphPainter } from './text-engine/browser-painter.js';
import { defaultStyle } from './data.js';
import { faceFor, setTypesetEnabled, typesetEnabled } from './measure.js';

const defaultEngine = textEngine();
const defaultPainter = glyphPainter();
const defaultTypeset = typesetEnabled();
afterEach(() => {
  setTextEngine(defaultEngine);
  setGlyphPainter(defaultPainter);
  setTypesetEnabled(defaultTypeset);
  vi.unstubAllGlobals();
});
const style = () => ({ ...defaultStyle(), size: 20, letterSpacing: 2, strokes: [] });
const box = { w: 100, h: 80 };
const layout = (s, extra = {}) => ({
  s, ox: 10, oy: 20, blockY: 5, lineH: 24, baseY: 18,
  isCurve: false, lines: ['AB', 'CD'], lineX: [2, 8], ...extra,
});
const gradient = (extra = {}) => ({
  on: true, kind: 'linear', angle: 0, scope: 'box',
  stops: [{ pos: -0.2, color: '#123456', opacity: 1 }, { pos: 1.2, color: '#abcdef', opacity: 0.5 }], ...extra,
});
const stops = [{ pos: 0, color: '#123456' }, { pos: 1, color: 'rgba(171,205,239,0.5)' }];
const straightRuns = [{ text: 'AB', x: 12, y: 43 }, { text: 'CD', x: 18, y: 67 }];

describe('glyph jobs are plain data', () => {
  it('describes straight text and two stroke bands in paint order', () => {
    const s = { ...style(), strokes: [{ color: '#fff', opacity: 0.7, width: 2 }, { color: '#000', opacity: 0.4, width: 3 }] };
    expect(glyphJob(box, layout(s))).toEqual({
      face: faceFor(s, 20), curved: false, align: s.align, letterSpacing: 2,
      bands: [{ color: '#000', opacity: 0.4, line: 10 }, { color: '#fff', opacity: 0.7, line: 4 }],
      silhouette: null, fill: { kind: 'solid', color: s.color }, runs: straightRuns,
    });
  });

  it('describes one gradient spanning the block', () => {
    const s = { ...style(), gradient: gradient() };
    const job = glyphJob(box, layout(s));
    expect(job.fill).toEqual({ kind: 'linear', x0: 60, y0: 73, x1: 60, y1: 25, stops });
    expect(job.runs).toEqual(straightRuns);
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
  });

  it('describes a gradient per line', () => {
    const s = { ...style(), gradient: gradient({ scope: 'line' }) };
    const job = glyphJob(box, layout(s));
    expect(job.fill).toBeNull();
    expect(job.runs).toEqual([
      { ...straightRuns[0], fill: { kind: 'linear', x0: 60, y0: 49, x1: 60, y1: 25, stops } },
      { ...straightRuns[1], fill: { kind: 'linear', x0: 60, y0: 73, x1: 60, y1: 49, stops } },
    ]);
  });

  it('describes a radial gradient without a canvas gradient', () => {
    const s = { ...style(), gradient: gradient({ kind: 'radial', cx: 0.5, cy: 0.5, radius: 1 }) };
    expect(glyphJob(box, layout(s)).fill).toEqual({ kind: 'radial', cx: 60, cy: 49, r: Math.hypot(48, 24), stops });
  });

  it('describes a pattern pitch and origin, leaving the tile for paint time', () => {
    const s = { ...style(), gradient: gradient({ scope: 'line' }), pattern: { on: true, kind: 'dots', scale: 2, fg: '#123456', bg: '#fff' } };
    const job = glyphJob(box, layout(s));
    expect(job.fill).toBeNull();
    expect(job.runs.map((r) => r.fill)).toEqual([
      { kind: 'pattern', style: { size: 20, color: s.color, pattern: s.pattern }, px: 12, ax: 12, ay: 25 },
      { kind: 'pattern', style: { size: 20, color: s.color, pattern: s.pattern }, px: 12, ax: 12, ay: 49 },
    ]);
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
  });

  it('expresses curved gradients in each translated glyph frame', () => {
    const s = { ...style(), gradient: gradient({ scope: 'line' }) };
    const job = glyphJob(box, layout(s, {
      isCurve: true, layout: [{ ch: 'A', x: 5, y: 2, rot: 0.3 }, { ch: 'B', x: -4, y: 3, rot: -0.2 }],
    }));
    expect(job.curved).toBe(true);
    expect(job.fill).toBeNull();
    expect(job.runs).toEqual([
      { text: 'A', x: 65, y: 62, rot: 0.3, fill: { kind: 'linear', x0: -5, y0: 38, x1: -5, y1: -42, stops } },
      { text: 'B', x: 56, y: 63, rot: -0.2, fill: { kind: 'linear', x0: 4, y0: 37, x1: 4, y1: -43, stops } },
    ]);
  });

  it('describes the silhouette as one flat colour, without the real fill', () => {
    const s = { ...style(), strokes: [{ color: '#fff', width: 2 }], gradient: gradient() };
    const job = glyphJob(box, layout(s, { silhouette: '#777' }));
    expect(job.silhouette).toBe('#777');
    expect(job.fill).toBeNull();
    expect(job.runs).toEqual(straightRuns);
    expect(job.bands).toEqual([{ color: '#fff', opacity: 1, line: 4 }]);
  });
});

it('hands renderBoxTexture to the installed painter even with no measuring engine', () => {
  setTextEngine(null);
  setTypesetEnabled(true);
  const ctx = { scale: vi.fn() };
  const canvas = { getContext: () => ctx };
  vi.stubGlobal('document', { createElement: () => canvas });
  const paint = vi.fn();
  setGlyphPainter({ paint });
  const s = style();
  const tex = renderBoxTexture({ ...box, x: 0, y: 0, text: 'AB', style: s }, { lines: [] });
  expect(tex.canvas).toBe(canvas);
  expect(paint).toHaveBeenCalledTimes(1);
  const [context, job] = paint.mock.calls[0];
  expect(context).toBe(ctx);
  expect(job).toEqual({
    face: faceFor(s, 20), curved: false, align: s.align, letterSpacing: 2,
    bands: [], silhouette: null, fill: { kind: 'solid', color: s.color },
    runs: [{ text: 'AB', x: 54, y: 50 }],
  });
});

// Include property assignments in the trace: the painter has to preserve the
// context state as well as the sequence and timing of its draw calls.
function recordingContext(spacing = true) {
  const calls = [];
  const base = spacing ? { letterSpacing: '' } : {};
  for (const name of ['save', 'restore', 'translate', 'rotate', 'fillText', 'strokeText']) {
    base[name] = (...args) => calls.push([name, ...args]);
  }
  base.createLinearGradient = (...args) => {
    calls.push(['createLinearGradient', ...args]);
    return { addColorStop: (...stop) => calls.push(['addColorStop', ...stop]) };
  };
  const ctx = new Proxy(base, { set(target, key, value) {
    calls.push([key, typeof value === 'object' ? 'gradient' : value]);
    target[key] = value;
    return true;
  } });
  return { ctx, calls };
}

it('paints all strokes before creating the block gradient and filling, with the same state changes', () => {
  const s = { ...style(), strokes: [{ color: '#fff', opacity: 0.7, width: 2 }, { color: '#000', opacity: 0.4, width: 3 }], gradient: gradient() };
  const job = glyphJob(box, layout(s));
  const { ctx, calls } = recordingContext();
  createBrowserGlyphPainter().paint(ctx, job);
  expect(calls).toEqual([
    ['font', job.face.key], ['textBaseline', 'alphabetic'], ['lineJoin', 'round'], ['miterLimit', 2],
    ['letterSpacing', '2px'], ['textAlign', s.align],
    ['save'], ['globalAlpha', 0.4], ['strokeStyle', '#000'], ['lineWidth', 10],
    ['strokeText', 'AB', 12, 43], ['strokeText', 'CD', 18, 67], ['restore'],
    ['save'], ['globalAlpha', 0.7], ['strokeStyle', '#fff'], ['lineWidth', 4],
    ['strokeText', 'AB', 12, 43], ['strokeText', 'CD', 18, 67], ['restore'],
    ['createLinearGradient', 60, 73, 60, 25], ['addColorStop', 0, '#123456'], ['addColorStop', 1, 'rgba(171,205,239,0.5)'],
    ['fillStyle', 'gradient'], ['fillText', 'AB', 12, 43], ['fillText', 'CD', 18, 67],
  ]);
});

it('creates a curved gradient inside each glyph save/translate/rotate and restores afterwards', () => {
  const s = { ...style(), gradient: gradient() };
  const job = glyphJob(box, layout(s, { isCurve: true, layout: [{ ch: 'A', x: 5, y: 2, rot: 0.3 }] }));
  const { ctx, calls } = recordingContext();
  createBrowserGlyphPainter().paint(ctx, job);
  expect(calls).toEqual([
    ['font', job.face.key], ['textBaseline', 'alphabetic'], ['lineJoin', 'round'], ['miterLimit', 2],
    ['textBaseline', 'middle'], ['textAlign', 'center'], ['save'], ['translate', 65, 62], ['rotate', 0.3],
    ['createLinearGradient', -5, 38, -5, -42], ['addColorStop', 0, '#123456'], ['addColorStop', 1, 'rgba(171,205,239,0.5)'],
    ['fillStyle', 'gradient'], ['fillText', 'A', 0, 0], ['restore'],
  ]);
});

it('checks for letterSpacing support and paints a silhouette without save/restore or gradients', () => {
  const s = { ...style(), strokes: [{ color: '#fff', width: 2 }], gradient: gradient() };
  const job = glyphJob(box, layout(s, { silhouette: '#777' }));
  const { ctx, calls } = recordingContext(false);
  createBrowserGlyphPainter().paint(ctx, job);
  expect(calls).toEqual([
    ['font', job.face.key], ['textBaseline', 'alphabetic'], ['lineJoin', 'round'], ['miterLimit', 2], ['textAlign', s.align],
    ['strokeStyle', '#777'], ['lineWidth', 4], ['strokeText', 'AB', 12, 43], ['strokeText', 'CD', 18, 67],
    ['fillStyle', '#777'], ['fillText', 'AB', 12, 43], ['fillText', 'CD', 18, 67],
  ]);
});
