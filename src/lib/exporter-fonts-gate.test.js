import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app, loadProjectPages, setFontSource } from './store.svelte.js';
import { exportImages } from './exporter.js';
import { releaseAllPageImages } from './page-images.js';

// Every file an export writes waits for the fonts its pages need
// (`fontsSettling` in the store, which the Rust engine's switch answers; what
// it waits FOR is engine-switch-letters.test.js). Here: that the wait is in
// front of everything `exportImages` paints or writes, for every kind of
// export that draws text, over the right pages - and that with the browser
// measuring nothing is waited for.
//
// The pages have no boxes: what is under test is the order of things, and a
// canvas that answers to anything is enough to let a render run to its end.

let made; // every canvas the export asked for, in order
let downloaded;
const real = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };

const anything = () =>
  new Proxy(
    {},
    {
      get: (target, key) => (key in target ? target[key] : () => undefined),
      set: (target, key, value) => ((target[key] = value), true),
    },
  );

// A font source whose `settle` resolves when the test says so.
function gate() {
  let open;
  const asked = [];
  const promise = new Promise((resolve) => (open = resolve));
  setFontSource({ ready: () => true, settle: (pages) => (asked.push(pages), promise) });
  return { asked, open };
}

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

beforeEach(() => {
  made = [];
  downloaded = [];
  globalThis.document = {
    fonts: { ready: Promise.resolve() },
    createElement: (tag) => {
      if (tag !== 'canvas') return { click() { downloaded.push(this.download); } };
      const canvas = { width: 0, height: 0, getContext: anything, toBlob: (cb) => cb(new Blob(['x'])) };
      made.push(canvas);
      return canvas;
    },
  };
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};
  app.exportName = 'ch01';
  app.projectLayout = 'pages';
  loadProjectPages([
    { id: 11, w: 800, h: 1200, lines: [], boxes: [] },
    { id: 22, w: 800, h: 1200, lines: [], boxes: [] },
  ]);
  app.pageIndex = 1;
});

afterEach(() => {
  setFontSource(null);
  releaseAllPageImages();
  app.projectLayout = 'pages';
  loadProjectPages([]);
  globalThis.document = real.document;
  URL.createObjectURL = real.create;
  URL.revokeObjectURL = real.revoke;
  vi.restoreAllMocks();
});

describe('an export waits for the fonts its pages need', () => {
  for (const [fmt, scope, files] of [
    ['PNG', 'current', ['ch01-22.png']],
    ['JPG', 'all', ['ch01-11.jpg', 'ch01-22.jpg']],
    ['WebP', 'current', ['ch01-22.webp']],
  ]) {
    it(`${fmt}, ${scope}: nothing is painted or written until they are in`, async () => {
      const fonts = gate();
      const exporting = exportImages(fmt, scope);
      await flush();
      expect(fonts.asked).toHaveLength(1);
      expect(fonts.asked[0].map((p) => p.id)).toEqual(scope === 'all' ? [11, 22] : [22]);
      expect(made).toEqual([]);
      expect(downloaded).toEqual([]);
      expect(app.exporting).toBe(true);
      fonts.open();
      expect(await exporting).toBe(true);
      expect(made.length).toBeGreaterThan(0);
      expect(downloaded).toEqual(files);
      expect(app.exporting).toBe(false);
    });
  }

  it('a PSD: the document is not built until they are in', async () => {
    const psd = await import('./psd.js');
    const built = vi.spyOn(psd, 'buildPagePsd').mockResolvedValue(new Uint8Array([1, 2, 3]));
    const fonts = gate();
    const exporting = exportImages('PSD', 'all');
    await flush();
    expect(fonts.asked).toHaveLength(1);
    expect(built).not.toHaveBeenCalled();
    fonts.open();
    await exporting;
    expect(built).toHaveBeenCalledTimes(2);
    expect(downloaded).toEqual(['ch01-11.psd', 'ch01-22.psd']);
  });

  it('a longstrip: one page’s slice paints its neighbours’ lettering, so it waits for the whole chapter', async () => {
    app.projectLayout = 'longstrip';
    app.stripSliceH = 1000;
    const fonts = gate();
    const exporting = exportImages('PNG', 'current');
    await flush();
    expect(fonts.asked[0].map((p) => p.id)).toEqual([11, 22]);
    expect(made).toEqual([]);
    fonts.open();
    expect(await exporting).toBe(true);
    expect(downloaded).toEqual(['ch01-22.png']);

    // And the whole column, re-cut.
    downloaded = [];
    made = [];
    const again = gate();
    const all = exportImages('PNG', 'all');
    await flush();
    expect(again.asked[0].map((p) => p.id)).toEqual([11, 22]);
    expect(made).toEqual([]);
    again.open();
    await all;
    expect(downloaded).toEqual(['ch01-strip-01.png', 'ch01-strip-02.png', 'ch01-strip-03.png']);
  });

  it('with the browser measuring there is nothing to wait for, and the export runs as it did', async () => {
    setFontSource(null);
    expect(await exportImages('PNG', 'current')).toBe(true);
    expect(downloaded).toEqual(['ch01-22.png']);
  });

  it('a wait that fails is an export that fails, said so, and not a page painted anyway', async () => {
    setFontSource({ ready: () => true, settle: () => Promise.reject(new Error('the fonts never settled')) });
    expect(await exportImages('PNG', 'current')).toBe(false);
    expect(made).toEqual([]);
    expect(downloaded).toEqual([]);
    expect(app.toast.msg).toBe('Export failed: the fonts never settled');
    expect(app.exporting).toBe(false);
  });
});
