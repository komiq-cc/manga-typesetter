import { afterEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// Which boxes are near the viewport
// ===========================================================================
// One IntersectionObserver for every box of one scrolling area, rooted at
// that area. The module keeps the observers, so each case loads it fresh
// against the observer it stubs.

class FakeObserver {
  static made = [];
  constructor(cb, options) {
    Object.assign(this, { cb, options, watching: new Set() });
    FakeObserver.made.push(this);
  }
  observe(el) {
    this.watching.add(el);
  }
  unobserve(el) {
    this.watching.delete(el);
  }
  say(...entries) {
    this.cb(entries.map(([target, isIntersecting]) => ({ target, isIntersecting })));
  }
}

// Elements as the module reads them: a parent, and through the stubbed
// `getComputedStyle` an overflow.
const node = (parentElement = null, overflow = 'visible', overflowX = overflow) => ({ parentElement, overflowY: overflow, overflowX, ownerDocument: DOC });
const DOC = { body: null, documentElement: null };
DOC.documentElement = node();
DOC.body = node(DOC.documentElement);
const styled = () => vi.stubGlobal('getComputedStyle', (el) => ({ overflowX: el.overflowX, overflowY: el.overflowY }));

async function load(observer = FakeObserver) {
  vi.resetModules();
  FakeObserver.made = [];
  if (observer) vi.stubGlobal('IntersectionObserver', observer);
  else vi.stubGlobal('IntersectionObserver', undefined);
  return import('./near-view.js');
}

afterEach(() => vi.unstubAllGlobals());

describe('watchNear', () => {
  it('makes no observer until something is watched, and then one for everything', async () => {
    const { watchNear } = await load();
    expect(FakeObserver.made).toHaveLength(0);
    const a = {}, b = {};
    watchNear(a, () => {});
    watchNear(b, () => {});
    expect(FakeObserver.made).toHaveLength(1);
    expect([...FakeObserver.made[0].watching]).toEqual([a, b]);
  });
  it('with no scrolling area around the element, looks half a window past every edge of the window', async () => {
    const { watchNear, NEAR_MARGIN } = await load();
    watchNear({}, () => {});
    expect(NEAR_MARGIN).toBe('50%');
    expect(FakeObserver.made[0].options).toEqual({ rootMargin: '50%' });
    // The same for an element whose ancestors all let their content show.
    styled();
    watchNear(node(node(node(DOC.body))), () => {});
    expect(FakeObserver.made).toHaveLength(1);
  });
  it('is rooted at the area the element scrolls in, where the margin is applied before anything clips', async () => {
    const { watchNear } = await load();
    styled();
    const scroller = node(DOC.body, 'auto');
    const el = node(node(node(scroller)));
    watchNear(el, () => {});
    expect(FakeObserver.made).toHaveLength(1);
    expect(FakeObserver.made[0].options).toEqual({ root: scroller, rootMargin: '50%' });
    expect(FakeObserver.made[0].options.root).toBe(scroller);
  });
  it('the nearest one, whichever way it scrolls, and never the page itself', async () => {
    const { watchNear } = await load();
    styled();
    const outer = node(DOC.body, 'scroll');
    const inner = node(node(outer), 'visible', 'auto');
    watchNear(node(inner), () => {});
    expect(FakeObserver.made[0].options.root).toBe(inner);
    // A page whose body scrolls is the window: the margin works there as it is.
    const body = node(DOC.documentElement, 'auto');
    const doc = { body, documentElement: DOC.documentElement };
    body.ownerDocument = doc;
    const onPage = { parentElement: { parentElement: body, overflowX: 'visible', overflowY: 'visible', ownerDocument: doc } };
    watchNear(onPage, () => {});
    expect(FakeObserver.made).toHaveLength(2);
    expect(FakeObserver.made[1].options).toEqual({ rootMargin: '50%' });
  });
  it('one observer for every element of one scrolling area, and one more for another area', async () => {
    const { watchNear } = await load();
    styled();
    const a = node(DOC.body, 'auto');
    const b = node(DOC.body, 'auto');
    const layer = node(a);
    const [a1, a2, a3, b1] = [node(layer), node(layer), node(node(a)), node(b)];
    const said = [];
    for (const el of [a1, a2, a3, b1]) watchNear(el, (near) => said.push([el, near]));
    expect(FakeObserver.made).toHaveLength(2);
    expect([...FakeObserver.made[0].watching]).toEqual([a1, a2, a3]);
    expect([...FakeObserver.made[1].watching]).toEqual([b1]);
    // Each observer's answers reach its own elements.
    FakeObserver.made[1].say([b1, true]);
    FakeObserver.made[0].say([a2, false]);
    expect(said).toEqual([[b1, true], [a2, false]]);
  });
  it('says nothing by itself: the first answer is the observer\'s', async () => {
    const { watchNear } = await load();
    const cb = vi.fn();
    watchNear({}, cb);
    expect(cb).not.toHaveBeenCalled();
  });
  it('tells each element its own answer', async () => {
    const { watchNear } = await load();
    const a = {}, b = {};
    const forA = vi.fn(), forB = vi.fn();
    watchNear(a, forA);
    watchNear(b, forB);
    FakeObserver.made[0].say([a, true], [b, false]);
    expect(forA.mock.calls).toEqual([[true]]);
    expect(forB.mock.calls).toEqual([[false]]);
  });
  it('several answers for one element arrive in order, the last one last', async () => {
    const { watchNear } = await load();
    const a = {};
    const cb = vi.fn();
    watchNear(a, cb);
    FakeObserver.made[0].say([a, true], [a, false], [a, true]);
    expect(cb.mock.calls).toEqual([[true], [false], [true]]);
  });
  it('stops: unobserved, and an answer already on its way is dropped', async () => {
    const { watchNear } = await load();
    const a = {}, b = {};
    const cb = vi.fn();
    const stop = watchNear(a, cb);
    watchNear(b, () => {});
    stop();
    expect([...FakeObserver.made[0].watching]).toEqual([b]);
    FakeObserver.made[0].say([a, true]);
    expect(cb).not.toHaveBeenCalled();
  });
  it('with no observer in the host, everything is near, at once', async () => {
    const { watchNear } = await load(null);
    const cb = vi.fn();
    const stop = watchNear({}, cb);
    expect(cb.mock.calls).toEqual([[true]]);
    expect(() => stop()).not.toThrow();
  });
});
