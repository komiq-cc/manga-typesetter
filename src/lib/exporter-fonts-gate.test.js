import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app, loadProjectPages, setFontSource } from './store.svelte.js';
import { exportImages } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { releaseAllPageImages } from './page-images.js';
import { fsx } from './fsx.js';

// The native side of a folder export, for the one test that takes it: the
// folder dialog answers '/out', and a path is its parts joined.
const native = vi.hoisted(() => ({}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...args) => native.open(...args), save: (...args) => native.save(...args) }));
vi.mock('@tauri-apps/api/path', () => ({
  join: (...args) => native.join(...args), dirname: (...args) => native.dirname(...args), basename: (...args) => native.basename(...args),
}));

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
  Object.assign(native, {
    open: async () => '/out', save: async () => null, join: async (...parts) => parts.join('/'),
    dirname: async (path) => path.slice(0, path.lastIndexOf('/')), basename: async (path) => path.slice(path.lastIndexOf('/') + 1),
  });
  app.exportDir = '';
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

  it('a PSD whose wait fails is no file at all, and the user is told why', async () => {
    const psd = await import('./psd.js');
    const built = vi.spyOn(psd, 'buildPagePsd').mockResolvedValue(new Uint8Array([1, 2, 3]));
    setFontSource({ ready: () => true, settle: () => Promise.reject(new Error('the fonts kept changing while it waited for them; nothing was written. Try again.')) });
    expect(await exportImages('PSD', 'all')).toBe(false);
    expect(built).not.toHaveBeenCalled();
    expect(downloaded).toEqual([]);
    expect(app.toast.msg).toBe('Export failed: the fonts kept changing while it waited for them; nothing was written. Try again.');
    expect(app.exporting).toBe(false);
  });

  // Which font set an export waits on: the browser's own when the browser
  // draws the text, the engine's gate alone when the engine does.
  describe('the browser’s font set', () => {
    let asked;
    const before = { engine: textEngine(), painter: glyphPainter() };
    beforeEach(() => {
      asked = 0;
      Object.defineProperty(globalThis.document, 'fonts', { get: () => (asked++, { ready: Promise.resolve() }) });
    });
    afterEach(() => {
      setTextEngine(before.engine);
      setGlyphPainter(before.painter);
    });

    it('is what is waited for with the switch off, once, as it was', async () => {
      setFontSource(null);
      expect(await exportImages('PNG', 'current')).toBe(true);
      expect(asked).toBe(1);
    });

    it('is not asked when the engine measures and draws', async () => {
      const engine = { id: 'rust', onFontsChange: () => () => {}, loading: () => false };
      setTextEngine(engine);
      setGlyphPainter({ paint() {}, engine });
      const fonts = gate();
      const exporting = exportImages('PNG', 'current');
      await flush();
      fonts.open();
      expect(await exporting).toBe(true);
      expect(fonts.asked).toHaveLength(1);
      expect(asked).toBe(0);
    });

    it('is waited for after the gate when the switch is on and the browser still draws', async () => {
      const fonts = gate();
      const exporting = exportImages('PNG', 'current');
      await flush();
      expect(asked).toBe(0);
      fonts.open();
      expect(await exporting).toBe(true);
      expect(asked).toBe(1);
    });
  });

  // ONE EXPORT, ONE ENGINE. What an export waited for is the fonts of the
  // engine that was installed while it waited; if another is installed by
  // the time a page is painted, the page was painted from fonts nobody
  // waited for (and a chapter would be half one engine's, half the other's).
  describe('the engine it waited for', () => {
    const stand = () => {
      const engine = { id: 'rust', onFontsChange: () => () => {}, loading: () => false };
      return { engine, painter: { engine, paint() {} } };
    };
    const was = { engine: textEngine(), painter: glyphPainter() };
    afterEach(() => {
      setTextEngine(was.engine);
      setGlyphPainter(was.painter);
    });
    // The browser's font set, asked and never answered.
    function neverReady() {
      const asked = { ready: 0 };
      Object.defineProperty(globalThis.document.fonts, 'ready', { get: () => (asked.ready++, new Promise(() => {})) });
      return asked;
    }
    // Runs `flip` the moment the export asks for its first canvas: after
    // every wait, as the page begins to be painted.
    function atFirstCanvas(flip) {
      const create = globalThis.document.createElement;
      let done = false;
      globalThis.document.createElement = (tag) => {
        if (tag === 'canvas' && !done) {
          done = true;
          flip();
        }
        return create(tag);
      };
      return () => done;
    }

    for (const fmt of ['PNG', 'PSD']) {
      it(`${fmt}: switched off while a page is painted, the export stops and writes no file`, async () => {
        const rust = stand();
        setTextEngine(rust.engine);
        setGlyphPainter(rust.painter);
        gate().open();
        const asked = neverReady();
        const flipped = atFirstCanvas(() => {
          setTextEngine(was.engine);
          setGlyphPainter(was.painter);
        });
        const ok = await exportImages(fmt, 'current');
        expect(flipped()).toBe(true);
        // Not written from the browser's fonts, which nobody had waited for...
        expect(asked.ready).toBe(0);
        expect(downloaded).toEqual([]);
        // ...and said.
        expect(ok).toBe(false);
        expect(app.toast?.msg).toMatch(/text engine was switched/);
      });
    }

    // The engine on, its fonts in, and the switch thrown off at the first
    // canvas asked for once `count()` files have been written.
    function switchedAfter(n, count = () => downloaded.length) {
      const rust = stand();
      setTextEngine(rust.engine);
      setGlyphPainter(rust.painter);
      gate().open();
      neverReady();
      const create = globalThis.document.createElement;
      globalThis.document.createElement = (tag) => {
        if (tag === 'canvas' && count() === n) {
          setTextEngine(was.engine);
          setGlyphPainter(was.painter);
        }
        return create(tag);
      };
    }
    // WHAT IT SAYS is what happened: how many files were written (each one
    // whole, each painted by the one engine), and that the rest were not.
    const ONE = /text engine was switched.* 1 file was written before that, whole, and stays; the one being made and the rest were not written/;
    const NONE = /text engine was switched.* Nothing was written\./;

    for (const fmt of ['PNG', 'PSD']) {
      it(`a whole chapter as ${fmt}: the page written before the switch stands and is counted, the page it happened on and the rest are not written`, async () => {
        switchedAfter(1);
        expect(await exportImages(fmt, 'all')).toBe(false);
        expect(downloaded).toEqual([`ch01-11.${fmt.toLowerCase()}`]);
        expect(app.toast?.msg).toMatch(ONE);
        expect(app.toast?.msg).not.toMatch(NONE);
      });

      it(`one page as ${fmt}: nothing was written, and it says nothing was`, async () => {
        switchedAfter(0);
        expect(await exportImages(fmt, 'current')).toBe(false);
        expect(downloaded).toEqual([]);
        expect(app.toast?.msg).toMatch(NONE);
      });
    }

    it('three pages, switched on the third: two files, said as two', async () => {
      loadProjectPages([11, 22, 33].map((id) => ({ id, w: 800, h: 1200, lines: [], boxes: [] })));
      switchedAfter(2);
      expect(await exportImages('PNG', 'all')).toBe(false);
      expect(downloaded).toEqual(['ch01-11.png', 'ch01-22.png']);
      expect(app.toast?.msg).toMatch(/ 2 files were written before that, whole, and stay; the one being made and the rest were not written/);
    });

    it('strip slices: the slice written before the switch stands and is counted, the one it happened on and the rest are not written', async () => {
      app.projectLayout = 'longstrip';
      app.stripSliceH = 1000;
      switchedAfter(1);
      expect(await exportImages('PNG', 'all')).toBe(false);
      expect(downloaded).toEqual(['ch01-strip-01.png']);
      expect(app.toast?.msg).toMatch(ONE);
    });

    it('into a folder (the desktop app): the folder holds the one whole file, and it is counted', async () => {
      vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
      const wrote = [];
      vi.spyOn(fsx, 'writeFileAtomic').mockImplementation(async (path, bytes) => void wrote.push([path, bytes.byteLength]));
      try {
        switchedAfter(1, () => wrote.length);
        expect(await exportImages('PNG', 'all')).toBe(false);
        // The blob the canvas gave, all of it, and no second file.
        expect(wrote).toEqual([['/out/ch01-11.png', 1]]);
        expect(downloaded).toEqual([]);
        expect(app.toast?.msg).toMatch(ONE);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('an ordinary nested PSD failure counts the completed outer file and removes its local nothing-written claim', async () => {
      const psd = await import('./psd.js');
      vi.spyOn(psd, 'buildPagePsd')
        .mockResolvedValueOnce(new Uint8Array([1]))
        .mockRejectedValueOnce(new Error('the fonts kept changing; nothing was written. Try again.'));
      expect(await exportImages('PSD', 'all')).toBe(false);
      expect(downloaded).toEqual(['ch01-11.psd']);
      expect(app.toast.msg).toMatch(/1 file was written.*remaining files were not written/);
      expect(app.toast.msg).not.toMatch(/nothing was written/i);
    });

    for (const boundary of ['join', 'dialog', 'blob', 'dirname', 'basename', 'write']) {
      it(`a native single-file ${boundary} wait cannot save success after the engine changes; completed files stay counted`, async () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        const rust = stand();
        setTextEngine(rust.engine);
        setGlyphPainter(rust.painter);
        gate().open();
        app.exportDir = '/out';
        native.save = async () => '/out/ch01-22.png';
        const writes = [];
        let release, reached;
        const waiting = new Promise((resolve) => (reached = resolve));
        const pause = (value) => (reached(), new Promise((resolve) => (release = () => resolve(value))));
        const write = vi.spyOn(fsx, 'writeFileAtomic').mockImplementation(async (path) => { writes.push(path); });
        if (boundary === 'blob') {
          const arrayBuffer = Blob.prototype.arrayBuffer;
          vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function () { return pause(await arrayBuffer.call(this)); });
        } else if (boundary === 'write') {
          write.mockImplementation(async (path) => { writes.push(path); return pause(undefined); });
        } else {
          const method = boundary === 'dialog' ? 'save' : boundary;
          const original = native[method];
          native[method] = async (...args) => pause(await original(...args));
        }
        try {
          const exporting = exportImages('PNG', 'current');
          await waiting;
          setTextEngine(was.engine);
          setGlyphPainter(was.painter);
          release();
          expect(await exporting).toBe(false);
          const completed = ['dirname', 'basename', 'write'].includes(boundary);
          expect(writes).toEqual(completed ? ['/out/ch01-22.png'] : []);
          expect(app.toast.msg).toMatch(completed ? ONE : NONE);
          expect(app.toast.msg).not.toMatch(/^Saved/);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    }

    for (const boundary of ['join', 'blob']) {
      it(`a streamed native ${boundary} wait on file two stops before writing it and counts file one`, async () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        const rust = stand();
        setTextEngine(rust.engine);
        setGlyphPainter(rust.painter);
        gate().open();
        const writes = [];
        vi.spyOn(fsx, 'writeFileAtomic').mockImplementation(async (path) => { writes.push(path); });
        let reached, release;
        const waiting = new Promise((resolve) => (reached = resolve));
        let calls = 0;
        const atSecond = (value) => ++calls === 2 ? (reached(), new Promise((resolve) => (release = () => resolve(value)))) : value;
        if (boundary === 'blob') {
          const arrayBuffer = Blob.prototype.arrayBuffer;
          vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function () { return atSecond(await arrayBuffer.call(this)); });
        } else {
          native.join = async (...parts) => atSecond(parts.join('/'));
        }
        try {
          const exporting = exportImages('PNG', 'all');
          await waiting;
          setTextEngine(was.engine);
          setGlyphPainter(was.painter);
          release();
          expect(await exporting).toBe(false);
          expect(writes).toEqual(['/out/ch01-11.png']);
          expect(app.toast.msg).toMatch(ONE);
        } finally {
          vi.unstubAllGlobals();
        }
      });
    }

    // Either half of "the engine" changing is the engine changing: a font
    // landing can take the painter out and leave what measures (`apply`,
    // engine-switch.svelte.js), and the reverse.
    for (const [what, change] of [
      ['only the painter is another', (rust) => setGlyphPainter({ engine: rust.engine, paint() {} })],
      ['only what measures is another', () => setTextEngine(stand().engine)],
    ]) {
      it(`${what}: still not the engine it waited for`, async () => {
        const rust = stand();
        setTextEngine(rust.engine);
        setGlyphPainter(rust.painter);
        gate().open();
        neverReady();
        atFirstCanvas(() => change(rust));
        expect(await exportImages('PNG', 'current')).toBe(false);
        expect(downloaded).toEqual([]);
      });
    }

    it('another engine put in while the first one’s fonts are waited for: that one’s fonts are waited for too, and then it is written', async () => {
      const first = stand();
      setTextEngine(first.engine);
      setGlyphPainter(first.painter);
      const g1 = gate();
      neverReady();
      const done = exportImages('PNG', 'current');
      await flush();
      expect(g1.asked).toHaveLength(1);
      // Off and on again while that wait is open: a new engine, a new
      // painter, and a gate of its own that knows nothing of the first.
      const second = stand();
      setTextEngine(second.engine);
      setGlyphPainter(second.painter);
      const g2 = gate();
      g1.open();
      await flush();
      // Not painted on the strength of the wait that was for the other one.
      expect(g2.asked).toHaveLength(1);
      expect(made).toEqual([]);
      expect(downloaded).toEqual([]);
      g2.open();
      expect(await done).toBe(true);
      expect(downloaded).toEqual(['ch01-22.png']);
    });

    it('switched ON while the browser’s fonts are waited for: the engine’s gate is waited for too, and then it is written', async () => {
      let ready;
      Object.defineProperty(globalThis.document.fonts, 'ready', { get: () => new Promise((resolve) => (ready = resolve)) });
      const done = exportImages('PNG', 'current');
      await flush();
      // The switch goes on while that wait is open.
      const rust = stand();
      setTextEngine(rust.engine);
      setGlyphPainter(rust.painter);
      const g = gate();
      ready();
      await flush();
      expect(g.asked).toHaveLength(1);
      expect(made).toEqual([]);
      g.open();
      expect(await done).toBe(true);
      expect(downloaded).toEqual(['ch01-22.png']);
    });
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
