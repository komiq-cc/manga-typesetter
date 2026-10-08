import { afterEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// Which boxes are near the viewport
// ===========================================================================
// One IntersectionObserver for every box. The module keeps the observer, so
// each case loads it fresh against the observer it stubs.

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
  it('looks half a viewport past every edge', async () => {
    const { watchNear, NEAR_MARGIN } = await load();
    watchNear({}, () => {});
    expect(NEAR_MARGIN).toBe('50%');
    expect(FakeObserver.made[0].options).toEqual({ rootMargin: '50%' });
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
