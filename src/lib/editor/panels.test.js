import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  panels,
  PANEL_IDS,
  MIN_W,
  MIN_H,
  defaultGeometry,
  clampPanel,
  sanitize,
  loadPanels,
  movePanel,
  resizePanel,
  raisePanel,
  setHidden,
  resetPanels,
  serializePanels,
  clampAll,
  flushPanels,
} from './panels.svelte.js';
import { PREF_SAVE_MS } from '../store.svelte.js';

const fakeStorage = (initial) => {
  let v = initial;
  return {
    getItem: () => v,
    setItem: (_k, next) => (v = next),
    dump: () => v,
  };
};

// The module debounces its writes, and the timer it leaves behind outlives the
// case that scheduled it. Every case runs on a fake clock so a write from one
// can never land in the middle of another.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('defaults', () => {
  it('parks both panels down the right edge', () => {
    const g = defaultGeometry(1400);
    expect(g.options.x).toBe(1400 - 320 - 16);
    expect(g.queue.x).toBe(g.options.x);
    expect(g.queue.y).toBeGreaterThan(g.options.y);
    expect(g.options.hidden).toBe(false);
  });

  it('does not park a panel off the left of a narrow window', () => {
    expect(defaultGeometry(200).options.x).toBe(16);
  });
});

describe('clampPanel', () => {
  it('keeps a grab-able strip on screen when the window shrinks', () => {
    const c = clampPanel({ x: 3000, y: 4000, w: 320, h: 400, hidden: false }, 1000, 800);
    expect(c.x).toBeLessThanOrEqual(1000 - 120);
    expect(c.y).toBeLessThanOrEqual(800 - 32);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
  });

  it('refuses a panel smaller than a usable one', () => {
    const c = clampPanel({ x: 0, y: 0, w: 10, h: 10, hidden: false }, 1000, 800);
    expect(c.w).toBe(MIN_W);
    expect(c.h).toBe(MIN_H);
  });

  it('leaves a panel that already fits exactly where it is', () => {
    const g = { x: 200, y: 300, w: 320, h: 400, hidden: false, z: 2 };
    expect(clampPanel(g, 1000, 800)).toEqual(g);
  });

  // A hidden panel is not drawn where it was: its tab lives under the tool
  // strip (RailTools.svelte). Its geometry is the panel it comes back as, so it
  // is held to the panel's rule, hidden or not - a panel shown again is never
  // mostly off screen.
  it('holds a hidden panel to the panel rule, the one it comes back as', () => {
    const c = clampPanel({ x: 5000, y: 5000, w: 320, h: 400, hidden: true }, 1000, 800);
    expect(c.x).toBe(1000 - 120);
    expect(c.y).toBe(800 - 32);
    expect(c.hidden).toBe(true);
  });

  it('clamps the same coordinates the same way, hidden or shown', () => {
    const at = { x: 1000 - 34, y: 8, w: 320, h: 400, z: 1 };
    expect(clampPanel({ ...at, hidden: true }, 1000, 800).x).toBe(1000 - 120);
    expect(clampPanel({ ...at, hidden: false }, 1000, 800).x).toBe(1000 - 120);
  });

  it('a hidden panel shown again is where it was', () => {
    resetPanels(1400, 900);
    movePanel('queue', 300, 400);
    setHidden('queue', true);
    clampAll(1400, 900);
    setHidden('queue', false);
    expect(panels.queue.x).toBe(300);
    expect(panels.queue.y).toBe(400);
  });
});

describe('sanitize', () => {
  it('falls back to defaults for a corrupt blob', () => {
    expect(sanitize('not json at all', 1400, 900)).toEqual(defaultGeometry(1400));
  });

  it('falls back per panel, keeping the half that is valid', () => {
    const g = sanitize({ options: { x: 40, y: 60, w: 300, h: 300, hidden: true } }, 1400, 900);
    expect(g.options.x).toBe(40);
    expect(g.options.hidden).toBe(true);
    expect(g.queue).toEqual(defaultGeometry(1400).queue);
  });

  // The defaults are laid out by width alone, so a short window is the one
  // case where falling back to them can park a panel out of reach.
  it('clamps the panel it falls back to, not just the one it kept', () => {
    const g = sanitize(null, 1000, 400);
    expect(g.queue.y).toBeLessThanOrEqual(400 - 32);
    expect(g.queue.h).toBeLessThanOrEqual(400 - 16);
  });

  it('drops values of the wrong type instead of trusting them', () => {
    const g = sanitize({ options: { x: 'left', y: null, w: 300, h: 300, hidden: 'yes' } }, 1400, 900);
    expect(g.options).toEqual(defaultGeometry(1400).options);
  });
});

describe('the live state', () => {
  beforeEach(() => resetPanels(1400, 900));

  it('round-trips through storage', () => {
    const s = fakeStorage(null);
    loadPanels(s, 1400, 900);
    movePanel('queue', 100, 200);
    setHidden('options', true);
    const written = JSON.parse(serializePanels());
    const s2 = fakeStorage(JSON.stringify(written));
    resetPanels(1400, 900);
    loadPanels(s2, 1400, 900);
    expect(panels.queue.x).toBe(100);
    expect(panels.queue.y).toBe(200);
    expect(panels.options.hidden).toBe(true);
  });

  it('survives a storage that throws', () => {
    const s = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
    expect(() => loadPanels(s, 1400, 900)).not.toThrow();
    expect(panels.options).toEqual(defaultGeometry(1400).options);
  });

  it('clamps everything when the window resizes', () => {
    loadPanels(fakeStorage(null), 1400, 900);
    movePanel('options', 1300, 850);
    clampAll(600, 400);
    expect(panels.options.x).toBeLessThanOrEqual(600 - 120);
    expect(panels.options.y).toBeLessThanOrEqual(400 - 32);
  });

  // Clamping only ever shrinks, so a resize that wrote its result would make a
  // moment of small window permanent: the geometry the user chose is squeezed,
  // saved, and does not come back when the window does. The live layout still
  // clamps - only the store is left alone.
  it('does not let a window resize overwrite the stored layout', () => {
    const s = fakeStorage(null);
    loadPanels(s, 1400, 900);
    movePanel('options', 1000, 700);
    vi.advanceTimersByTime(300);
    const before = s.dump();

    clampAll(600, 400, false);
    vi.advanceTimersByTime(300);
    expect(panels.options.x).toBeLessThanOrEqual(600 - 120);
    expect(s.dump()).toBe(before);

    // And the window coming back is enough to restore it: the clamp never
    // reached disk, so the next mount reads the geometry the user placed.
    loadPanels(s, 1400, 900);
    expect(panels.options.x).toBe(1000);
    expect(panels.options.y).toBe(700);
  });

  it('never lands a fresh layout below a short window', () => {
    loadPanels(fakeStorage(null), 1000, 400);
    expect(panels.queue.y).toBeLessThanOrEqual(400 - 32);
    expect(panels.options.y).toBeLessThanOrEqual(400 - 32);
  });

  it('has an id list the UI can iterate', () => {
    expect(PANEL_IDS).toEqual(['options', 'queue']);
  });
});

// The two mutators the brief's own cases do not reach. They are the ones the
// drag/resize component will lean on hardest, so they get a case each.
describe('resize and raise', () => {
  beforeEach(() => resetPanels(1400, 900));

  it('will not resize a panel below a usable size', () => {
    resizePanel('queue', 10, 10);
    expect(panels.queue.w).toBe(MIN_W);
    expect(panels.queue.h).toBe(MIN_H);
  });

  it('puts the raised panel above the other one', () => {
    raisePanel('options');
    expect(panels.options.z).toBeGreaterThan(panels.queue.z);
    raisePanel('queue');
    expect(panels.queue.z).toBeGreaterThan(panels.options.z);
  });

  // A blob saved before z existed loads both panels at the same depth. Being
  // level with the top is not being on top.
  it('still raises when the two panels are level', () => {
    loadPanels(
      fakeStorage(
        JSON.stringify({
          options: { x: 40, y: 40, w: 320, h: 400, hidden: false },
          queue: { x: 80, y: 80, w: 320, h: 400, hidden: false },
        }),
      ),
      1400,
      900,
    );
    expect(panels.options.z).toBe(panels.queue.z);
    raisePanel('options');
    expect(panels.options.z).toBeGreaterThan(panels.queue.z);
  });
});

// Every mutator debounces a write. Nothing above this point advances the
// clock, so without these cases the whole persistence half could be deleted
// and the suite would stay green.
describe('persistence', () => {
  beforeEach(() => {
    resetPanels(1400, 900);
    vi.clearAllTimers(); // the reset's own write is not what any case here is testing
  });

  it('writes the layout once the drag settles', () => {
    const s = fakeStorage(null);
    loadPanels(s, 1400, 900);
    movePanel('queue', 120, 240);
    expect(s.dump()).toBe(null);
    vi.advanceTimersByTime(200);
    expect(JSON.parse(s.dump()).queue).toMatchObject({ x: 120, y: 240 });
  });

  it('coalesces a burst of drag updates into one write', () => {
    const s = fakeStorage(null);
    let writes = 0;
    loadPanels(
      {
        getItem: () => null,
        setItem: (k, v) => {
          writes++;
          s.setItem(k, v);
        },
      },
      1400,
      900,
    );
    movePanel('queue', 100, 100);
    vi.advanceTimersByTime(100);
    movePanel('queue', 140, 160);
    vi.advanceTimersByTime(200);
    expect(writes).toBe(1);
    expect(JSON.parse(s.dump()).queue).toMatchObject({ x: 140, y: 160 });
  });

  // The interval is the store's shared preference beat, not a number this module
  // picked for itself - the sidebar's write coalesces on the same one. What this
  // pins is the duration: `PREF_SAVE_MS` is 199 and 200 by the time the case
  // runs, so a module that went back to a hard-coded 200 of its own would pass
  // it, and only reading the source tells those apart. What it does catch is the
  // divergence that matters - change the shared constant and a writer still
  // sitting on the old number fails here.
  it('writes on the shared preference interval rather than one of its own', () => {
    const s = fakeStorage(null);
    loadPanels(s, 1400, 900);
    movePanel('queue', 10, 12);
    vi.advanceTimersByTime(PREF_SAVE_MS - 1);
    expect(s.dump()).toBe(null);
    vi.advanceTimersByTime(1);
    expect(JSON.parse(s.dump()).queue).toMatchObject({ x: 10, y: 12 });
  });

  // `resetPanels` is a Settings action, and Settings opens from the library
  // screen as readily as from the editor. Nothing in it may need a mounted
  // panel, a DOM or an open document - and the reset has to reach storage, or
  // the next editor mount loads the layout the user just threw away straight
  // back over the top.
  it('resets to the defaults for the live window and persists them', () => {
    const s = fakeStorage(
      JSON.stringify({
        options: { x: -900, y: -900, w: 240, h: 200, hidden: true, z: 1 },
        queue: { x: -900, y: -900, w: 240, h: 200, hidden: true, z: 2 },
      }),
    );
    loadPanels(s, 1400, 900);
    expect(() => resetPanels(1400, 900)).not.toThrow();
    expect(panels.options).toMatchObject(defaultGeometry(1400).options);
    expect(panels.queue.hidden).toBe(false);
    vi.advanceTimersByTime(PREF_SAVE_MS);
    expect(JSON.parse(s.dump()).options).toMatchObject(defaultGeometry(1400).options);
  });

  it('survives a storage that throws on write', () => {
    loadPanels(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      },
      1400,
      900,
    );
    movePanel('options', 40, 40);
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(panels.options.x).toBe(40);
  });
});

// The debounce given back on the way out. ⌘Q destroys the window with no unload
// the page can await, so a panel dragged inside the last PREF_SAVE_MS would be
// lost - the same hole `flushSidebar` closes one module over.
describe('flushPanels', () => {
  beforeEach(() => {
    resetPanels(1400, 900);
    vi.clearAllTimers(); // the reset's own write is not what any case here is testing
  });

  it('writes a pending move immediately instead of losing it', () => {
    const s = fakeStorage(null);
    loadPanels(s, 1400, 900);
    movePanel('queue', 300, 200);
    expect(s.dump()).toBe(null); // still inside the debounce
    flushPanels();
    expect(JSON.parse(s.dump()).queue).toMatchObject({ x: 300, y: 200 });
  });

  // Draining twice must not write twice: the second call has nothing pending,
  // and a flush that wrote anyway would put a layout on disk the user never
  // arranged - the sentinel is what a spurious second write would clobber.
  it('does nothing on a second flush with nothing pending', () => {
    const s = fakeStorage(null);
    loadPanels(s, 1400, 900);
    movePanel('queue', 300, 200);
    flushPanels();
    s.setItem('mt.panels', 'sentinel');
    flushPanels();
    expect(s.dump()).toBe('sentinel');
  });

  // A flush after the timer has already fired must not write a second time:
  // the sentinel would be overwritten if `saveT` were still standing.
  it('does nothing once the debounce has already landed', () => {
    const s = fakeStorage(null);
    loadPanels(s, 1400, 900);
    movePanel('queue', 300, 200);
    vi.advanceTimersByTime(PREF_SAVE_MS);
    s.setItem('mt.panels', 'sentinel');
    flushPanels();
    expect(s.dump()).toBe('sentinel');
  });
});
