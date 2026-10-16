import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The previews are the engine's to paint and have their own lane
// (sfx.engine.test.js paints a real one). Here the painters are stand-ins that
// count what they are asked, so these cases are about the panel: what it shows
// under each engine, what a click writes and says, and how the cards are
// painted.
vi.mock('./sfx-preview.js', async (original) => {
  const mod = await original();
  return {
    ...mod,
    paintCard: vi.fn(() => 'data:image/png;base64,AAAA'),
    paintStage: vi.fn(() => true),
  };
});

import SfxPanel from './SfxPanel.svelte';
import { paintCard, paintStage, clearCardCache } from './sfx-preview.js';
import { app, loadProjectPages, page } from './store.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { clearLayoutMemo, setTypesetEnabled, typesetEnabled } from './measure.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

const KINDS = [
  { kind: 'step', label: 'Stairs', unit: 'em', min: -3, max: 3, step: 0.05, b: null },
  { kind: 'jitter', label: 'Shake', unit: 'em', min: 0, max: 1, step: 0.01, b: { label: 'Max tilt', min: 0, max: 45, step: 1, default: 8 } },
  { kind: 'grow', label: 'Grow', unit: 'x', min: -1.5, max: 1.5, step: 0.05, b: null },
];
const PRESETS = [
  { id: 'stairs-down', name: 'Stairs down', group: 'Move', flow: 'row', rowShift: 0, gap: 0, lineHeight: null, moves: [{ kind: 'step', a: 0.3, b: 0 }] },
  { id: 'shaky', name: 'Shaky', group: 'Move', flow: 'row', rowShift: 0, gap: -0.05, lineHeight: null, moves: [{ kind: 'jitter', a: 0.1, b: 8 }] },
  { id: 'grow', name: 'Grow', group: 'Size', flow: 'row', rowShift: 0, gap: 0, lineHeight: null, moves: [{ kind: 'grow', a: 0.8, b: 0 }] },
  { id: 'cascade', name: 'Cascade', group: 'Hand', flow: 'stack', rowShift: 0.2, gap: 0, lineHeight: 0.8, moves: [{ kind: 'step', a: 0.1, b: 0 }] },
];

// A Shape preset: no moves, and an envelope the engine makes a mesh of.
const VALLEY = { id: 'valley', name: 'Valley', group: 'Shape', flow: 'row', rowShift: 0, gap: 0, lineHeight: null, envelope: { kind: 'valley', bend: 0.6, cols: 4, rows: 1 }, moves: [] };
// And a preset with one move, beside it.
const DRIP = { id: 'drip', name: 'Drip', group: 'Hand', flow: 'row', rowShift: 0, gap: 0, lineHeight: null, envelope: null, moves: [{ kind: 'drip', a: 0.45, b: 0.5 }] };
const DRIP_KIND = { kind: 'drip', label: 'Drip', unit: 'em', min: 0, max: 1, step: 0.01, b: { label: 'Spread', min: 0, max: 1, step: 0.01, default: 0.5 } };
// The fake's envelope: the identity grid with its top row raised in the middle.
function fakeEnvelope(kind, bend, cols, rows, w, h) {
  const pts = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) pts.push([(w * i) / cols, (h * j) / rows - 30 * bend * Math.sin((Math.PI * i) / cols)]);
  return pts;
}

function fakeEngine({ sfx, shape = false }) {
  const ink = (face, text) => ({ width: [...text].length * face.size * 0.55, left: 0, right: [...text].length * face.size * 0.55, ascent: face.size * 0.7, descent: face.size * 0.2 });
  const e = {
    id: sfx ? 'rust' : 'browser',
    advance: (face, text) => [...text].length * face.size * 0.55,
    fontBox: (face) => ({ ascent: face.size * 0.8, descent: face.size * 0.2 }),
    lineInk: ink,
    glyphInk: ink,
    loading: () => false,
    onFontsChange: () => () => {},
    faceReady: () => true,
  };
  if (sfx) {
    e.sfxLayout = () => [];
    e.sfxInfo = () => ({ kinds: shape ? [...KINDS, DRIP_KIND] : KINDS, presets: shape ? [...PRESETS, VALLEY, DRIP] : PRESETS, envelopes: ['valley'] });
    e.sfxEnvelope = fakeEnvelope;
  }
  return e;
}

const original = textEngine();
const typeset = typesetEnabled();
let restoreCanvas;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
  // jsdom lays nothing out and has no observer for it: the stage's width is
  // read through `bind:clientWidth`, which wants one.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => {
  vi.unstubAllGlobals();
  restoreCanvas();
  setTypesetEnabled(typeset);
});
beforeEach(() => {
  clearCardCache();
  clearLayoutMemo();
  paintCard.mockClear();
  paintStage.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setTextEngine(original);
  clearLayoutMemo();
  loadProjectPages([]);
});

// The box lives in the store so that what the panel writes is what it then reads.
function mounted({ sfx = true, shape = false, over = {}, props = {} } = {}) {
  setTextEngine(fakeEngine({ sfx, shape }));
  const style = normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 20, ...over });
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: null, text: 'BOOM\nBAM', x: 100, y: 100, w: 240, h: 90, style }] }]);
  const pg = page();
  const box = pg.boxes[0];
  const touch = vi.fn();
  const view = render(SfxPanel, { props: { box, pg, touch, ...props } });
  return { view, box, touch };
}
const radios = (view) => [...view.container.querySelectorAll('[role=radio]')];

describe('under the browser engine', () => {
  it('says what SFX needs and shows no control', async () => {
    const { view } = mounted({ sfx: false });
    await tick();
    expect(view.container.textContent).toContain('SFX lettering needs the Rust text engine.');
    expect(view.container.querySelectorAll('input, select, [role=radio], canvas')).toHaveLength(0);
    expect(view.queryByRole('button', { name: 'Open settings' })).toBe(null);
    expect(paintStage).not.toHaveBeenCalled();
    expect(paintCard).not.toHaveBeenCalled();
  });

  it('offers Settings when the host can open them', async () => {
    const onSettings = vi.fn();
    const { view } = mounted({ sfx: false, props: { onSettings } });
    await fireEvent.click(view.getByRole('button', { name: 'Open settings' }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});

describe('under the Rust engine', () => {
  it('lists the engine presets as a radiogroup and marks none for a plain box', async () => {
    const { view } = mounted();
    await tick();
    expect(view.getByRole('radiogroup', { name: 'SFX preset' })).toBeTruthy();
    expect(radios(view).map((r) => r.getAttribute('title'))).toEqual(['Stairs down', 'Shaky', 'Grow', 'Cascade']);
    expect(radios(view).every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    expect(view.container.textContent).toContain('Preview · No SFX');
    // No controls and no Remove while SFX is off.
    expect(view.queryByRole('button', { name: 'Remove SFX' })).toBe(null);
    expect(view.container.querySelector('input[type=range]')).toBe(null);
  });

  it('applies a preset on a click, tells the Inspector, and marks the card', async () => {
    const { view, box, touch } = mounted({ over: { curve: 30 } });
    await fireEvent.click(radios(view)[3]);
    expect(box.style.sfx.on).toBe(true);
    expect(box.style.sfx.flow).toBe('stack');
    expect(box.style.sfx.rowShift).toBe(0.2);
    expect(box.style.sfx.moves).toEqual([{ kind: 'step', a: 0.1, b: 0 }]);
    // The same rule `enableSfx` has: the arc is switched off with it.
    expect(box.style.curve).toBe(0);
    expect(box.style.lineHeight).toBe(0.8);
    expect(touch).toHaveBeenCalledTimes(1);
    await tick();
    expect(radios(view).map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'true']);
    expect(view.container.textContent).toContain('Preview · Cascade');
    expect(view.queryByRole('button', { name: 'Remove SFX' })).not.toBe(null);
  });

  it('calls an edited recipe Custom, and takes the mark off the card', async () => {
    const { view, box } = mounted();
    await fireEvent.click(radios(view)[0]);
    await tick();
    box.style.sfx.moves[0].a = 0.9;
    await tick();
    expect(view.container.textContent).toContain('Preview · Custom');
    expect(radios(view).every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
  });

  it('Remove SFX switches it off, puts the box back as it was, tells the Inspector, and goes away', async () => {
    const { view, box, touch } = mounted({ over: { curve: 30, letterSpacing: 4, lineHeight: 1.4, color: '#123456', strokes: [{ color: '#abcdef', width: 5, opacity: 1 }] } });
    const was = JSON.parse(JSON.stringify(box.style));
    // Two presets in a row: what comes back is the box, not the first preset.
    await fireEvent.click(radios(view)[1]);
    await fireEvent.click(radios(view)[3]);
    expect(box.style.letterSpacing).toBe(0);
    expect(box.style.lineHeight).toBe(0.8);
    expect(box.style.curve).toBe(0);
    // A preset is a shape: colour and strokes are the box's throughout.
    expect(box.style.color).toBe('#123456');
    expect(box.style.strokes).toEqual(was.strokes);
    touch.mockClear();
    await tick();
    await fireEvent.click(view.getByRole('button', { name: 'Remove SFX' }));
    expect(box.style.sfx.on).toBe(false);
    expect(JSON.parse(JSON.stringify({ ...box.style, sfx: null }))).toEqual({ ...was, sfx: null });
    expect(touch).toHaveBeenCalledTimes(1);
    await tick();
    expect(view.queryByRole('button', { name: 'Remove SFX' })).toBe(null);
    expect(view.container.textContent).toContain('Preview · No SFX');
  });

  it('filters the cards by group', async () => {
    const { view } = mounted();
    await fireEvent.click(view.getByRole('button', { name: 'Move' }));
    expect(radios(view).map((r) => r.getAttribute('title'))).toEqual(['Stairs down', 'Shaky']);
    await fireEvent.click(view.getByRole('button', { name: 'All' }));
    expect(radios(view)).toHaveLength(4);
  });

  it('has no control to tune a preset with, on or off', async () => {
    const { view } = mounted();
    for (const i of [0, 1, 3]) {
      await fireEvent.click(radios(view)[i]);
      await tick();
      expect(view.container.querySelectorAll('input, select')).toHaveLength(0);
      expect(view.queryByRole('button', { name: 'Reshuffle' })).toBe(null);
      expect(view.queryByRole('button', { name: 'Add move' })).toBe(null);
    }
  });
});

describe('a preset that is the box\'s mesh', () => {
  const HELP = "This shape is the box's mesh. Bend it further in Transform.";
  const card = (view, name) => radios(view).find((r) => r.getAttribute('title') === name);

  it('has its card among the others, in its own group', async () => {
    const { view } = mounted({ shape: true });
    await tick();
    expect(radios(view).map((r) => r.getAttribute('title'))).toEqual(['Stairs down', 'Shaky', 'Grow', 'Cascade', 'Valley', 'Drip']);
    await fireEvent.click(view.getByRole('button', { name: 'Shape' }));
    expect(radios(view).map((r) => r.getAttribute('title'))).toEqual(['Valley']);
  });

  it('writes the mesh on a click, marks its card, and shows one line of help', async () => {
    const { view, box, touch } = mounted({ shape: true });
    await fireEvent.click(card(view, 'Valley'));
    expect(touch).toHaveBeenCalledTimes(1);
    expect(box.style.sfx.on).toBe(true);
    expect(box.style.sfx.moves).toEqual([]);
    expect(box.style.warp.on).toBe(true);
    expect([box.style.warp.cols, box.style.warp.rows]).toEqual([4, 1]);
    expect(box.style.warp.pts).toHaveLength(10);
    await tick();
    expect(card(view, 'Valley').getAttribute('aria-checked')).toBe('true');
    expect(radios(view).filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(view.container.textContent).toContain('Preview · Valley');
    expect(view.container.textContent).toContain(HELP);
    expect(view.container.querySelectorAll('input, select')).toHaveLength(0);
    expect(view.queryByRole('button', { name: 'Remove SFX' })).not.toBe(null);
  });

  it('is Custom once its mesh is edited, and the next preset leaves that mesh', async () => {
    const { view, box } = mounted({ shape: true });
    await fireEvent.click(card(view, 'Valley'));
    await tick();
    box.style.warp.pts[1] = [box.style.warp.pts[1][0] + 5, box.style.warp.pts[1][1]];
    await tick();
    expect(view.container.textContent).toContain('Preview · Custom');
    expect(card(view, 'Valley').getAttribute('aria-checked')).toBe('false');
    expect(view.container.textContent).toContain(HELP);
    // Another preset takes the arch's own mesh away, but not this edited one.
    await fireEvent.click(card(view, 'Stairs down'));
    await tick();
    expect(box.style.warp.on).toBe(true);
    expect(view.container.textContent).not.toContain(HELP);
  });

  it('is taken off the box by the next preset and by Remove SFX', async () => {
    const { view, box, touch } = mounted({ shape: true });
    await fireEvent.click(card(view, 'Valley'));
    await tick();
    await fireEvent.click(card(view, 'Grow'));
    await tick();
    expect(box.style.warp.on).toBe(false);
    expect(box.style.warp.pts).toEqual([]);
    expect(view.container.textContent).not.toContain(HELP);
    await fireEvent.click(card(view, 'Valley'));
    await tick();
    touch.mockClear();
    await fireEvent.click(view.getByRole('button', { name: 'Remove SFX' }));
    expect(touch).toHaveBeenCalledTimes(1);
    expect(box.style.sfx.on).toBe(false);
    expect(box.style.warp.on).toBe(false);
    await tick();
    expect(view.container.textContent).toContain('Preview · No SFX');
    expect(view.container.textContent).not.toContain(HELP);
  });
});

describe('painting', () => {
  it('paints the cards a few a frame, only the group on show, and not again for a cached card', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] });
    const { view } = mounted();
    await tick();
    expect(paintCard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(paintCard).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(20);
    expect(paintCard).toHaveBeenCalledTimes(4);
    await tick();
    expect(view.container.querySelector('.sfx-tile').getAttribute('style')).toContain('data:image/png');
    // Another group, then back: everything is in the cache.
    await fireEvent.click(view.getByRole('button', { name: 'Hand' }));
    await fireEvent.click(view.getByRole('button', { name: 'All' }));
    vi.advanceTimersByTime(100);
    expect(paintCard).toHaveBeenCalledTimes(4);
  });

  it('paints the stage again for a change of style, and the cards only when their picture changes', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] });
    const { view, box } = mounted();
    await tick();
    vi.advanceTimersByTime(100);
    await tick();
    expect(paintStage).toHaveBeenCalledTimes(1);
    const cards = paintCard.mock.calls.length;
    box.style.shadows = [{ x: 3, y: 3, blur: 2, color: '#000000', opacity: 0.5 }];
    await tick();
    vi.advanceTimersByTime(100);
    expect(paintStage).toHaveBeenCalledTimes(2);
    // A shadow is not in a card's look.
    expect(paintCard.mock.calls.length).toBe(cards);
    box.style.color = '#cc0000';
    await tick();
    vi.advanceTimersByTime(300);
    expect(paintCard.mock.calls.length).toBe(cards + PRESETS.length);
    // The text of the card is the first eight code points; the box says BOOM / BAM.
    expect(paintCard.mock.calls.at(-1)[0].text).toBe('BOOM\nBAM');
    expect(view).toBeTruthy();
  });
});
