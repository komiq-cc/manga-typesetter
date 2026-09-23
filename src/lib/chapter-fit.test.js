import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ===========================================================================
// Every balloon in the chapter, measured before anything is placed
// ===========================================================================
// `measureChapterFits` reads each page's pixels once and answers the fits
// placement is going to ask for. What is worth pinning about it is what a
// batch over a whole chapter gets wrong: reading pages it did not need,
// reading one twice, holding more than one page at a time, leaving memory
// behind, crowding the click cache, and carrying on after it was told to stop.
//
// The fit itself is not under test - that is balloon.js and the store - so
// `fitFor` is a spy that says which page and which pixels it was handed. The
// real `page-images.js` does the pinning, with `fsx` answering bytes as it does
// in page-images.test.js, and the real `page-pixels.js` is the click cache.
// `Image` and the canvas are the smallest surfaces the decode touches.
const fs = vi.hoisted(() => ({ reads: [] }));
vi.mock('./fsx.js', () => ({
  fsx: {
    join: async (...p) => p.join('/'),
    readFile: async (path) => {
      fs.reads.push(path);
      if (path.includes('missing')) throw new Error('ENOENT');
      return new Uint8Array([1, 2, 3]);
    },
    assetUrl: async () => null,
  },
}));

const { measureChapterFits } = await import('./chapter-fit.js');
const { setChapterImageDirs, setResidentWindow, releaseAllPageImages } = await import('./page-images.js');
const { rememberPagePixels, pagePixelsFor, pagePixelsHeld, pagePixelNotesHeld, forgetPagePixels } =
  await import('./page-pixels.js');

const real = {
  document: globalThis.document,
  Image: globalThis.Image,
  createObjectURL: globalThis.URL.createObjectURL,
  revokeObjectURL: globalThis.URL.revokeObjectURL,
};

// Every picture built, every canvas asked for, and every raster read into
// pixels, in order - the decoder spy.
let images;
let canvases;
let draws;
let revoked;
// Run as every decode starts, so a test can land a cancel in the middle of
// one. `decodeTurns` is how many turns of the event loop a decode takes - the
// real one runs on a decoder thread - so lanes can be seen overlapping and
// finishing out of order.
let onDecode;
let decodeTurns;

class FakeImage {
  #src = null;
  constructor() {
    this.decoding = null;
    this.crossOrigin = null;
    // The URL, kept past the release that clears `src`, and what `crossOrigin`
    // was at the moment the URL was set - which is the moment it counts.
    this.url = null;
    this.corsAtSrc = undefined;
    this.released = 0;
    images.push(this);
  }
  get src() {
    return this.#src;
  }
  set src(v) {
    this.#src = v;
    if (v) {
      this.url = v;
      this.corsAtSrc = this.crossOrigin;
    }
  }
  get naturalWidth() {
    return 40;
  }
  get naturalHeight() {
    return 60;
  }
  async decode() {
    onDecode?.(this);
    for (let i = decodeTurns(this); i > 0; i--) await new Promise((r) => setTimeout(r, 0));
    if (this.url?.includes('undecodable')) throw new Error('broken image');
  }
  removeAttribute(name) {
    if (name !== 'src') return;
    this.released++;
    this.#src = null;
  }
}

// A canvas that records what was drawn into it and hands back pixels that say
// which raster they came from. A URL with 'tainted' in it throws on the read,
// the way a canvas does once a cross-origin picture has been drawn into it.
function fakeCanvas() {
  let drawn = null;
  const c = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage(img) {
        drawn = img.url;
        draws.push(img.url);
      },
      getImageData: (x, y, w, h) => {
        if (String(drawn).includes('tainted')) throw new Error('SecurityError');
        return { width: w, height: h, data: { byteLength: w * h * 4 }, src: drawn };
      },
    }),
  };
  canvases.push(c);
  return c;
}

// Pages whose pictures are already in hand, the way a PSD-imported page's are:
// `page-images.js` leaves a URL it did not mint alone, so every `Image` a test
// sees below is one the batch built. `blocks` is what `blocksFor` answers.
const pagesWith = (...blockCounts) =>
  blockCounts.map((count, i) => ({
    id: i + 1,
    raw: `blob:page-${i + 1}`,
    cleaned: null,
    blocks: Array.from({ length: count }, (_, k) => ({ n: k + 1 })),
  }));

const blocksFor = (p) => p.blocks;
let fitFor;

beforeEach(() => {
  images = [];
  canvases = [];
  draws = [];
  revoked = [];
  onDecode = null;
  decodeTurns = () => 0;
  fs.reads = [];
  let seq = 0;
  globalThis.Image = FakeImage;
  globalThis.document = { createElement: fakeCanvas };
  globalThis.URL.createObjectURL = () => `blob:minted-${++seq}`;
  globalThis.URL.revokeObjectURL = (u) => revoked.push(u);
  forgetPagePixels();
  fitFor = vi.fn((p, block, pixels) => ({ page: p.id, n: block.n, from: pixels.src }));
});

afterEach(() => {
  releaseAllPageImages();
  forgetPagePixels();
  globalThis.Image = real.Image;
  globalThis.document = real.document;
  globalThis.URL.createObjectURL = real.createObjectURL;
  globalThis.URL.revokeObjectURL = real.revokeObjectURL;
});

describe('what it reads', () => {
  it('reads each page with something to fit once, in page order, and no other page', async () => {
    const ps = pagesWith(1, 0, 2, 0);
    const fits = await measureChapterFits(ps, { blocksFor, fitFor });
    expect(draws).toEqual(['blob:page-1', 'blob:page-3']);
    expect(fitFor).toHaveBeenCalledTimes(3);
    expect([...fits.keys()]).toEqual([ps[0].blocks[0], ps[2].blocks[0], ps[2].blocks[1]]);
    expect(fits.get(ps[2].blocks[1])).toEqual({ page: 3, n: 2, from: 'blob:page-3' });
  });

  // Each read builds one picture and gives it back once, whatever became of
  // the read. A picture still holding its URL is a decoded page the renderer
  // has no reason to release.
  it('gives back every picture it builds, exactly once', async () => {
    const ps = pagesWith(1, 1, 1);
    await measureChapterFits(ps, { blocksFor, fitFor });
    expect(images.length).toBe(3);
    for (const img of images) expect(img.released).toBe(1);
  });

  // The request's mode is fixed when `src` is set. An asset-protocol page
  // loaded without `crossOrigin` taints the canvas it is drawn into, and the
  // read throws - every page silently without a fit.
  it('asks for every picture CORS-clean, before it names the URL', async () => {
    await measureChapterFits(pagesWith(1, 1), { blocksFor, fitFor });
    expect(images.map((i) => i.corsAtSrc)).toEqual(['anonymous', 'anonymous']);
  });

  it('holds one page at a time, unless it is told it may hold more', async () => {
    decodeTurns = () => 1;
    let inFlight = new Set();
    let most = 0;
    // A page is in memory from the moment its picture is named until its last
    // fit has been measured - the `ImageData` lives until then.
    onDecode = (img) => {
      inFlight.add(img.url);
      most = Math.max(most, inFlight.size);
    };
    const counting = (p, block, pixels) => {
      if (block === p.blocks[p.blocks.length - 1]) inFlight.delete(pixels.src);
      return {};
    };
    await measureChapterFits(pagesWith(1, 2, 1, 1, 2), { blocksFor, fitFor: counting });
    expect(most).toBe(1);

    inFlight = new Set();
    most = 0;
    await measureChapterFits(pagesWith(1, 2, 1, 1, 2), { blocksFor, fitFor: counting, concurrency: 2 });
    expect(most).toBe(2);
  });

  // However the lanes happen to finish, the answer comes back in page order.
  // Page 1 is the slowest to decode here, so it is measured last.
  it('answers in page order whatever order the reads finish in', async () => {
    decodeTurns = (img) => ({ 'blob:page-1': 4, 'blob:page-2': 1, 'blob:page-3': 2 })[img.url] ?? 0;
    const measured = [];
    const ps = pagesWith(1, 1, 1, 1);
    const fits = await measureChapterFits(ps, {
      blocksFor,
      fitFor: (p, block, pixels) => {
        measured.push(p.id);
        return fitFor(p, block, pixels);
      },
      concurrency: 3,
    });
    expect(measured[measured.length - 1]).toBe(1);
    expect([...fits.values()].map((f) => f.page)).toEqual([1, 2, 3, 4]);
  });
});

describe('the pages it cannot read', () => {
  // Not measured is not the same answer as measured and found irregular: the
  // first leaves the block to whatever placement does without a fit, the second
  // is a verdict. So a page that could not be read is left out entirely.
  it('leaves an unreadable page out of the answer and carries on', async () => {
    const ps = [
      { id: 1, raw: null, cleaned: null, blocks: [{ n: 1 }] },
      { id: 2, raw: 'blob:undecodable', cleaned: null, blocks: [{ n: 1 }] },
      { id: 3, raw: 'blob:tainted', cleaned: null, blocks: [{ n: 1 }] },
      { id: 4, raw: 'blob:page-4', cleaned: null, blocks: [{ n: 1 }] },
    ];
    const fits = await measureChapterFits(ps, { blocksFor, fitFor });
    expect([...fits.keys()]).toEqual([ps[3].blocks[0]]);
    expect(fitFor).toHaveBeenCalledTimes(1);
    // And the failures cost nothing: every picture given back, every canvas
    // zeroed, the tainted one included.
    for (const img of images) expect(img.released).toBe(1);
    for (const c of canvases) expect([c.width, c.height]).toEqual([0, 0]);
  });

  it('answers null for a block that was measured and has no fit', async () => {
    const ps = pagesWith(2);
    const fits = await measureChapterFits(ps, {
      blocksFor,
      fitFor: (p, block) => (block.n === 1 ? undefined : { n: 2 }),
    });
    expect(fits.has(ps[0].blocks[0])).toBe(true);
    expect(fits.get(ps[0].blocks[0])).toBe(null);
    expect(fits.get(ps[0].blocks[1])).toEqual({ n: 2 });
  });
});

// ===========================================================================
// The click cache is the reader's, not the batch's
// ===========================================================================
describe('the click cache', () => {
  const decoded = (url) => ({ naturalWidth: 40, naturalHeight: 60, url });

  it('reads a page the cache already holds without decoding it again', async () => {
    const ps = pagesWith(1);
    const cached = rememberPagePixels(ps[0].id, ps[0].raw, decoded(ps[0].raw));
    draws = [];
    let handed = null;
    await measureChapterFits(ps, {
      blocksFor,
      fitFor: (p, block, pixels) => {
        handed = pixels;
        return {};
      },
    });
    expect(handed).toBe(cached);
    expect(draws).toEqual([]);
    expect(images).toEqual([]);
  });

  // Eight pages is the whole cache. Every one a batch filed would push out a
  // page the canvas decoded for the reader.
  it('files nothing into it', async () => {
    await measureChapterFits(pagesWith(1, 1, 1), { blocksFor, fitFor });
    expect(pagePixelsHeld()).toBe(0);
    expect(pagePixelNotesHeld()).toBe(0);
  });

  // Read in page order and promoted as it went, the cache's order would be
  // sorted by page number, and the next decode would evict the page that
  // comes first in the chapter rather than the one looked at longest ago.
  it('leaves the order of what it holds alone', async () => {
    const ps = pagesWith(1, 0, 0, 0, 0, 0, 0, 0);
    for (const p of ps) rememberPagePixels(p.id, p.raw, decoded(p.raw));
    await measureChapterFits(ps, { blocksFor, fitFor });
    rememberPagePixels(9, 'blob:page-9', decoded('blob:page-9'));
    expect(pagePixelsFor(ps[0])).toBe(null);
    expect(pagePixelsFor(ps[1])).not.toBe(null);
  });
});

// ===========================================================================
// Memory
// ===========================================================================
describe('memory', () => {
  // The canvas is a full-size copy of the page for as long as it keeps its
  // size, and a chapter-wide pass makes one per page.
  it('zeroes every canvas it reads through', async () => {
    await measureChapterFits(pagesWith(1, 1, 1), { blocksFor, fitFor });
    expect(canvases.length).toBe(3);
    for (const c of canvases) expect([c.width, c.height]).toEqual([0, 0]);
  });

  // The real window, and a page outside it: minted for the read, handed back
  // BEFORE its fits are measured - so the fits run with nothing of the page
  // alive but the pixels - and nothing read for a page with nothing to fit.
  it('holds a page it needs open only for the read', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      file: `p${i + 1}.png`,
      raw: null,
      cleaned: null,
      blocks: i === 0 || i === 4 ? [{ n: 1 }] : [],
    }));
    await setResidentWindow(ps, 0); // pages 1-3
    await new Promise((r) => setTimeout(r, 0));
    fs.reads = [];
    const during = {};
    const fits = await measureChapterFits(ps, {
      blocksFor,
      fitFor: (p, block, pixels) => {
        during[p.id] = { raw: p.raw, read: pixels.src };
        return {};
      },
    });
    expect(fits.size).toBe(2);
    // Page 1 was already in the window; page 4 had nothing to fit.
    expect(fs.reads).toEqual(['/ch/raws/p5.png']);
    // The window keeps its own page...
    expect(during[1].raw).not.toBe(null);
    expect(ps[0].raw).not.toBe(null);
    // ...and page 5 was given back before its fit ran.
    expect(during[5].raw).toBe(null);
    expect(ps[4].raw).toBe(null);
    expect(revoked).toContain(during[5].read);
  });
});

// ===========================================================================
// Cancelling, and the rest of the run's manners
// ===========================================================================
describe('cancelling', () => {
  it('does nothing at all when it is cancelled before it starts', async () => {
    const ac = new AbortController();
    ac.abort();
    const asked = vi.fn(blocksFor);
    expect(await measureChapterFits(pagesWith(1, 1), { blocksFor: asked, fitFor, signal: ac.signal })).toBe(
      null,
    );
    expect(asked).not.toHaveBeenCalled();
    expect(images).toEqual([]);
  });

  // A cancelled run hands back nothing, so there is nothing partial for the
  // caller to commit by mistake - and it reads nothing after the cancel.
  it('stops after the page it is on and reads no further', async () => {
    const ac = new AbortController();
    const fits = await measureChapterFits(pagesWith(1, 1, 1), {
      blocksFor,
      fitFor,
      signal: ac.signal,
      onProgress: ({ done }) => {
        if (done === 1) ac.abort();
      },
    });
    expect(fits).toBe(null);
    expect(draws).toEqual(['blob:page-1']);
    expect(images.length).toBe(1);
    expect(fitFor).toHaveBeenCalledTimes(1);
  });

  // Not merely no decode: no page opened at all. A cancel is what the caller
  // fires when the chapter is being replaced, and a page object from the old
  // chapter handed to the window after the new chapter's directories are set
  // would be minted from THOSE, under an id the new chapter reuses.
  it('opens no page after the cancel, so nothing is minted for a chapter that has gone', async () => {
    setChapterImageDirs('/ch/raws', null);
    const ps = [1, 2, 3].map((id) => ({ id, file: `p${id}.png`, raw: null, cleaned: null, blocks: [{ n: 1 }] }));
    const ac = new AbortController();
    await measureChapterFits(ps, {
      blocksFor,
      fitFor,
      signal: ac.signal,
      onProgress: ({ done }) => {
        if (done !== 1) return;
        ac.abort();
        setChapterImageDirs('/other/raws', null);
      },
    });
    expect(fs.reads).toEqual(['/ch/raws/p1.png']);
    expect(ps[1].raw).toBe(null);
  });

  // The cancel lands while page 2's picture is decoding. The pixels are never
  // read out of it, and the picture is still given back.
  it('drops a decode that is in flight when the cancel lands', async () => {
    const ac = new AbortController();
    onDecode = (img) => {
      if (img.url === 'blob:page-2') ac.abort();
    };
    const fits = await measureChapterFits(pagesWith(1, 1, 1), { blocksFor, fitFor, signal: ac.signal });
    expect(fits).toBe(null);
    expect(draws).toEqual(['blob:page-1']);
    expect(images.map((i) => [i.url, i.released])).toEqual([
      ['blob:page-1', 1],
      ['blob:page-2', 1],
    ]);
  });
});

describe('progress', () => {
  it('counts the pages with something to fit', async () => {
    const seen = [];
    await measureChapterFits(pagesWith(1, 0, 2), { blocksFor, fitFor, onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  // Between pages the run gives the browser a turn, so the count can redraw
  // and a Cancel can land. Read from the cache, so no decode is there to
  // provide the turn by accident.
  it('lets the browser run between pages', async () => {
    const ps = pagesWith(1, 1);
    for (const p of ps) rememberPagePixels(p.id, p.raw, { naturalWidth: 40, naturalHeight: 60, url: p.raw });
    let ticked = false;
    let tickedBeforePage2 = null;
    await measureChapterFits(ps, {
      blocksFor,
      fitFor: (p) => {
        if (p.id === 1) setTimeout(() => (ticked = true), 0);
        else tickedBeforePage2 = ticked;
        return {};
      },
    });
    expect(tickedBeforePage2).toBe(true);
  });
});
