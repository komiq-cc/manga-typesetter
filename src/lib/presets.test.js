import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  presets,
  loadPresets,
  savePreset,
  removePreset,
  copyStyle,
  pasteStyle,
} from './presets.svelte.js';
import { defaultStyle, normalizeWarp } from './data.js';
import { applySfxPreset, clearSfx } from './sfx.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import {
  app,
  loadProjectPages,
  page,
  byId,
  cloneStyle,
} from './store.svelte.js';
import {
  initHistory,
  resetHistory,
  undo,
  redo,
  peekStack,
} from './editor/history.svelte.js';

const doc = () => [
  {
    id: 1,
    w: 800,
    h: 1200,
    lines: [
      { n: 1, type: 'dialogue', jp: 'あ', en: 'ah' },
      { n: 2, type: 'dialogue', jp: 'い', en: 'ee' },
    ],
    boxes: [
      {
        id: 'b1',
        lineN: null,
        text: 'Box One',
        x: 10,
        y: 10,
        w: 100,
        h: 40,
        style: {
          ...defaultStyle(),
          color: '#ff0000',
          size: 32,
          rotation: 45,
          flipH: true,
          flipV: false,
          gradient: {
            on: true,
            angle: 90,
            scope: 'line',
            // Four stops, one of them part-transparent: the target box's
            // gradient has the default two, so copying this one is the case
            // where a whole-gradient replacement has to change the LENGTH of
            // the stop list rather than just its values.
            stops: [
              { color: '#ffffff', pos: 0, opacity: 1 },
              { color: '#00ff00', pos: 0.3, opacity: 0.5 },
              { color: '#0000ff', pos: 0.6, opacity: 0.25 },
              { color: '#ff0000', pos: 1, opacity: 1 },
            ],
          },
          pattern: { on: true, kind: 'checker', fg: '#111', bg: '#eee', scale: 2 },
          strokes: [{ color: '#00ff00', width: 4, opacity: 0.8 }],
          shadows: [{ x: 3, y: 3, blur: 5, color: '#000000', opacity: 0.5 }],
        },
      },
      {
        id: 'b2',
        lineN: null,
        text: 'Box Two',
        x: 50,
        y: 50,
        w: 100,
        h: 40,
        style: {
          ...defaultStyle(),
          color: '#0000ff',
          size: 20,
          rotation: -15,
          flipH: false,
          flipV: true,
          strokes: [],
          shadows: [],
        },
      },
    ],
  },
];

describe('presets management and persistence', () => {
  let storageMap;

  beforeEach(() => {
    storageMap = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => storageMap.get(k) ?? null,
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
      clear: () => storageMap.clear(),
    });
    presets.list = [];
    initHistory();
    resetHistory();
    loadProjectPages(doc());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('savePreset creates a new preset and persists it', () => {
    const s = { ...defaultStyle(), color: '#123456', size: 40 };
    const item = savePreset('Shout', s);

    expect(item).toBeDefined();
    expect(item.name).toBe('Shout');
    expect(item.style.color).toBe('#123456');
    expect(item.style.size).toBe(40);
    expect(presets.list).toHaveLength(1);
    expect(presets.list[0]).toEqual(item);

    // Persisted in localStorage
    const savedRaw = storageMap.get('mt.presets');
    expect(savedRaw).toBeDefined();
    const saved = JSON.parse(savedRaw);
    expect(saved.list).toHaveLength(1);
    expect(saved.list[0].name).toBe('Shout');
    expect(saved.list[0].style.color).toBe('#123456');
  });

  it('savePreset overwrites by name (case-insensitive and trimmed)', () => {
    const s1 = { ...defaultStyle(), color: '#111111' };
    const first = savePreset('Dialogue', s1);
    expect(presets.list).toHaveLength(1);

    const s2 = { ...defaultStyle(), color: '#222222' };
    const second = savePreset('  dialogue  ', s2);

    expect(presets.list).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('dialogue');
    expect(second.style.color).toBe('#222222');
    expect(presets.list[0].style.color).toBe('#222222');
  });

  it('removePreset deletes item by id and persists changes', () => {
    const p1 = savePreset('P1', defaultStyle());
    const p2 = savePreset('P2', defaultStyle());
    expect(presets.list).toHaveLength(2);

    removePreset(p1.id);
    expect(presets.list).toHaveLength(1);
    expect(presets.list[0].id).toBe(p2.id);

    const saved = JSON.parse(storageMap.get('mt.presets'));
    expect(saved.list).toHaveLength(1);
    expect(saved.list[0].id).toBe(p2.id);
  });

  // The loader takes its storage the way the tag registry used to, so what an old stored
  // list normalises to is testable against a fixture rather than a real
  // localStorage. This one is the legacy schema: one outline colour, one width,
  // a shadow with an on switch - the fields only `normalizeStyle` still knows.
  it('migrates an outline/shadow-era preset from storage it is handed', () => {
    const legacy = {
      list: [
        {
          id: 'old_1',
          name: 'Legacy Shout',
          style: {
            font: 'Bangers',
            size: 30,
            outline: '#ff0000',
            outlineWidth: 5,
            shadow: { on: true, x: 1, y: 2, blur: 3, color: '#000000', opacity: 0.7 },
          },
        },
      ],
    };
    loadPresets({ getItem: () => JSON.stringify(legacy), setItem: () => {} });
    expect(presets.list).toHaveLength(1);
    const item = presets.list[0];
    expect(item.id).toBe('old_1');
    expect(item.name).toBe('Legacy Shout');
    expect(item.style.font).toBe('Bangers');
    expect(item.style.strokes).toEqual([{ color: '#ff0000', width: 5, opacity: 1 }]);
    expect(item.style.shadows).toEqual([{ x: 1, y: 2, blur: 3, color: '#000000', opacity: 0.7 }]);
    expect('outline' in item.style).toBe(false);
    expect('outlineWidth' in item.style).toBe(false);
    expect('shadow' in item.style).toBe(false);
  });

  // And the failure modes cost nothing: unparseable storage and a wrong-shaped
  // root both leave an empty list rather than a throw at import time.
  it('falls back to an empty list for storage that does not parse or does not fit', () => {
    loadPresets({ getItem: () => '{not json', setItem: () => {} });
    expect(presets.list).toEqual([]);
    loadPresets({ getItem: () => JSON.stringify({ nope: true }), setItem: () => {} });
    expect(presets.list).toEqual([]);
  });
});

describe('style copy and paste', () => {
  beforeEach(() => {
    initHistory();
    resetHistory();
    loadProjectPages(doc());
  });

  it('copyStyle writes to in-memory clipboard and navigator.clipboard if available', () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      clipboard: { writeText: writeTextMock },
    });

    const b1 = byId('b1');
    const copied = copyStyle(b1);

    expect(copied).toBeDefined();
    expect(copied.color).toBe('#ff0000');
    expect(copied.size).toBe(32);
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeTextMock.mock.calls[0][0]).color).toBe('#ff0000');
  });

  it('pasteStyle returns false when clipboard is empty or box is missing', () => {
    expect(pasteStyle(null)).toBe(false);
  });

  it('pasteStyle excludes rotation, flipH, and flipV while applying other styles', () => {
    const b1 = byId('b1');
    const b2 = byId('b2');

    // b1 has rotation: 45, flipH: true, flipV: false, color: '#ff0000', size: 32, gradient, pattern, strokes, shadows
    // b2 has rotation: -15, flipH: false, flipV: true, color: '#0000ff', size: 20
    copyStyle(b1);

    const success = pasteStyle(b2);
    expect(success).toBe(true);

    // Target box b2 should keep its original transform properties
    expect(b2.style.rotation).toBe(-15);
    expect(b2.style.flipH).toBe(false);
    expect(b2.style.flipV).toBe(true);

    // Target box b2 should receive all visual style properties from b1
    expect(b2.style.color).toBe('#ff0000');
    expect(b2.style.size).toBe(32);
    expect(b2.style.gradient.on).toBe(true);
    expect(b2.style.gradient.angle).toBe(90);
    expect(b2.style.gradient.scope).toBe('line');
    // The whole stop list came across, length and per-stop alpha included -
    // b2 started on the default two opaque stops.
    expect(b2.style.gradient.stops).toEqual([
      { color: '#ffffff', pos: 0, opacity: 1 },
      { color: '#00ff00', pos: 0.3, opacity: 0.5 },
      { color: '#0000ff', pos: 0.6, opacity: 0.25 },
      { color: '#ff0000', pos: 1, opacity: 1 },
    ]);
    expect(b2.style.pattern.on).toBe(true);
    expect(b2.style.pattern.kind).toBe('checker');
    expect(b2.style.strokes).toEqual([{ color: '#00ff00', width: 4, opacity: 0.8 }]);
    expect(b2.style.shadows).toEqual([{ x: 3, y: 3, blur: 5, color: '#000000', opacity: 0.5 }]);

    // Modifying target box styles afterwards should not affect the clipboard (no aliasing)
    b2.style.strokes[0].color = '#000000';
    b2.style.gradient.stops[0].color = '#000000';
    const b3 = { ...b2, id: 'b3', style: { ...defaultStyle() } };
    pasteStyle(b3);
    expect(b3.style.strokes[0].color).toBe('#00ff00');
    expect(b3.style.gradient.stops[0].color).toBe('#ffffff');
  });

  it('pasteStyle updates lastStyle in store so next box inherits it', () => {
    const b1 = byId('b1');
    const b2 = byId('b2');

    copyStyle(b1);
    pasteStyle(b2);

    expect(app.lastStyle.color).toBe('#ff0000');
    expect(app.lastStyle.size).toBe(32);
  });

  // The paste declines rotation and the flips; remembering declines only the
  // flips. Requested behaviour, in the user's words: the next box placed should
  // follow the ROTATION of the box last worked on. The angle that survives here
  // is b2's own -15° - the paste never touched it, and b1's 45° is not carried
  // across, so the clipboard's tilt still cannot reach the next box. The flips
  // stay out: `rememberStyle` copies whole, and letting them through mirrored
  // every box placed after a mirrored one.
  it('remembers the pasted style with the target box’s own rotation, but not the flips', () => {
    const b1 = byId('b1');
    const b2 = byId('b2');

    copyStyle(b1);
    pasteStyle(b2);

    expect(app.lastStyle.color).toBe('#ff0000');
    expect(app.lastStyle.rotation).toBe(-15);
    expect(app.lastStyle.rotation).not.toBe(b1.style.rotation);
    expect(app.lastStyle.flipH).toBe(defaultStyle().flipH);
    expect(app.lastStyle.flipV).toBe(defaultStyle().flipV);
  });

  // SFX remembers what it wrote over (`sfx.before`), mesh included, to put
  // back when it goes off. Pasted, the recipe came with the record of the box
  // it was copied from, while the mesh itself stayed behind: a preset that
  // takes its envelope off later (Valley, then Remove SFX) laid the OTHER box's
  // hand-made mesh onto this one.
  it('pastes an SFX recipe that puts back this box’s own mesh, not the copied box’s', () => {
    const original = textEngine();
    const VALLEY = { id: 'valley', name: 'Valley', moves: [], envelope: { kind: 'valley', bend: 0.5, cols: 1, rows: 1 } };
    const GROW = { id: 'grow', name: 'Grow', moves: [{ kind: 'grow', a: 0.5, b: 0 }] };
    // An engine of arithmetic that knows the two presets and makes Valley's
    // mesh; it lays no SFX out (`sfxLayout`), so both boxes stay auto boxes.
    const ink = (face, text) => ({ width: [...text].length * face.size * 0.55, left: 0, right: [...text].length * face.size * 0.55, ascent: face.size * 0.7, descent: face.size * 0.2 });
    setTextEngine({
      id: 'sfx-tables',
      advance: (face, text) => [...text].length * face.size * 0.55,
      fontBox: (face) => ({ ascent: face.size * 0.8, descent: face.size * 0.2 }),
      lineInk: ink,
      glyphInk: ink,
      loading: () => false,
      onFontsChange: () => () => {},
      faceReady: () => true,
      sfxInfo: () => ({ kinds: [], presets: [GROW, VALLEY] }),
      sfxEnvelope: (kind, bend, cols, rows, w, h) => [[0, 0], [w, 0], [0, h * 0.6], [w, h]],
    });
    try {
      const b1 = byId('b1');
      const b2 = byId('b2');
      const handmade = { on: true, cols: 1, rows: 1, pts: [[-5, 3], [120, -8], [2, 44], [97, 51]] };
      b1.style.warp = handmade;
      applySfxPreset(b1.style, GROW, b1);
      expect(b1.style.sfx.before.warp.pts).toEqual(handmade.pts);
      copyStyle(b1);
      const own = normalizeWarp(b2.style.warp);
      expect(pasteStyle(b2)).toBe(true);
      // The recipe came across; the mesh did not, and neither did its record.
      expect(b2.style.sfx.on).toBe(true);
      expect(b2.style.warp).toEqual(own);
      expect(b2.style.sfx.before.warp).toEqual(own);
      expect(b2.style.sfx.before.path).toBe(!!b2.style.path?.on);
      // Valley, then Remove SFX: the envelope goes, and b2 is as it was.
      applySfxPreset(b2.style, VALLEY, b2);
      expect(b2.style.warp.pts).toEqual([[0, 0], [b2.w, 0], [0, b2.h * 0.6], [b2.w, b2.h]]);
      clearSfx(b2.style, b2);
      expect(b2.style.warp).toEqual(own);
      // The copied box keeps its own record.
      expect(b1.style.sfx.before.warp.pts).toEqual(handmade.pts);
    } finally {
      setTextEngine(original);
    }
  });

  it('pasteStyle records exactly one history entry that can be undone and redone', () => {
    const b1 = byId('b1');
    const b2 = byId('b2');

    copyStyle(b1);
    expect(peekStack().undo).toHaveLength(0);

    pasteStyle(b2);
    expect(peekStack().undo).toHaveLength(1);
    const entry = peekStack().undo[0];
    expect(entry.t).toBe('style');
    expect(entry.pageId).toBe(1);
    expect(entry.boxId).toBe('b2');
    expect(entry.before.color).toBe('#0000ff');
    expect(entry.after.color).toBe('#ff0000');

    // Undo restores previous style
    undo();
    expect(b2.style.color).toBe('#0000ff');
    expect(b2.style.size).toBe(20);
    expect(b2.style.strokes).toEqual([]);

    // Redo re-applies pasted style
    redo();
    expect(b2.style.color).toBe('#ff0000');
    expect(b2.style.size).toBe(32);
    expect(b2.style.strokes).toEqual([{ color: '#00ff00', width: 4, opacity: 0.8 }]);
  });
});
