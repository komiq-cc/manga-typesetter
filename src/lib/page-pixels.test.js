import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  rememberPagePixels,
  notePageImage,
  pagePixelsFor,
  peekPagePixels,
  decodeImagePixels,
  forgetPagePixels,
  pagePixelsHeld,
  pagePixelNotesHeld,
  pageRasterSrc,
} from './page-pixels.js';

// ===========================================================================
// The page's pixels, decoded once
// ===========================================================================
// Balloon fitting needs an `ImageData` of the page, synchronously, inside a
// click handler. This module is the app's answer, and the two things worth
// pinning about a cache are the two things a cache gets wrong: handing back
// something stale, and never letting go.
//
// The stub is the smallest surface `rememberPagePixels` touches - an element
// with `width`, `height` and a 2D context that can draw an image and read the
// bytes back - because what is under test is the bookkeeping, not the decode.
// `getImageData` returns a distinguishable buffer so a test can tell one page's
// pixels from another's.
const realDocument = globalThis.document;
let decodes;
// Every canvas the module asked for, so a test can see what state it was left
// in - a scratch canvas that keeps its size is a second copy of the page.
let canvases;

const fakeCanvas = () => {
  const c = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage(img) {
        decodes.push(img.tag);
      },
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    }),
  };
  canvases.push(c);
  return c;
};

const img = (tag, w = 4, h = 4) => ({ tag, naturalWidth: w, naturalHeight: h });

beforeEach(() => {
  decodes = [];
  canvases = [];
  globalThis.document = { createElement: () => fakeCanvas() };
  forgetPagePixels();
});

afterEach(() => {
  globalThis.document = realDocument;
  forgetPagePixels();
});

describe('pageRasterSrc', () => {
  // One expression of "which image a page IS", shared by the cache and its
  // callers, because the canvas draws `cleaned ?? raw` and a fit measured
  // against the other one would be a fit of the wrong picture.
  it('is the cleaned raster when there is one, else the raw', () => {
    expect(pageRasterSrc({ raw: 'blob:r', cleaned: 'blob:c' })).toBe('blob:c');
    expect(pageRasterSrc({ raw: 'blob:r', cleaned: null })).toBe('blob:r');
    expect(pageRasterSrc(null)).toBe(null);
  });
});

// ===========================================================================
// The one draw-then-read
// ===========================================================================
// Shared by the click cache and the chapter-wide fit, so the two cannot come to
// different answers about what a page's pixels are.
describe('decodeImagePixels', () => {
  it('reads a decoded picture at its natural size', () => {
    const data = decodeImagePixels(img('a', 6, 8));
    expect([data.width, data.height]).toEqual([6, 8]);
    expect(decodes).toEqual(['a']);
  });

  // The canvas is scratch, written once and read once. Left at its size it is a
  // second full copy of the page in a backing store nothing will look at again,
  // held until the collector gets round to the element.
  it('gives its canvas back before it returns', () => {
    decodeImagePixels(img('a', 6, 8));
    expect(canvases.map((c) => [c.width, c.height])).toEqual([[0, 0]]);
  });

  // A tainted canvas throws on the read - the case a page loaded without
  // `crossOrigin` produces - and that must cost the fit, not the canvas.
  it('gives the canvas back when the read throws', () => {
    const tainted = { width: 0, height: 0 };
    tainted.getContext = () => ({
      drawImage() {},
      getImageData: () => {
        throw new Error('SecurityError');
      },
    });
    globalThis.document = { createElement: () => tainted };
    expect(decodeImagePixels(img('a', 6, 8))).toBe(null);
    expect([tainted.width, tainted.height]).toEqual([0, 0]);
  });

  it('refuses a picture that has not decoded without asking for a canvas', () => {
    expect(decodeImagePixels(img('a', 0, 0))).toBe(null);
    expect(decodeImagePixels(null)).toBe(null);
    expect(canvases).toEqual([]);
  });

  it('is a no-op where there is nothing to decode with', () => {
    globalThis.document = undefined;
    expect(decodeImagePixels(img('a'))).toBe(null);
  });

  // The cache reads through the same function, so a page it files gives its
  // canvas back too.
  it('is what the cache reads through', () => {
    rememberPagePixels(1, 'blob:r1', img('a', 6, 8));
    expect(decodes).toEqual(['a']);
    expect(canvases.map((c) => [c.width, c.height])).toEqual([[0, 0]]);
  });
});

describe('remembering and reading back', () => {
  it('hands the decoded pixels back for the page they were filed against', () => {
    const p = { id: 1, raw: 'blob:r1', cleaned: null };
    const data = rememberPagePixels(p.id, pageRasterSrc(p), img('a', 6, 8));
    expect([data.width, data.height]).toEqual([6, 8]);
    expect(pagePixelsFor(p)).toBe(data);
    // Decoded once. A decode per click is the thing this module exists to
    // prevent.
    expect(decodes).toEqual(['a']);
  });

  // The whole invalidation story for a clean landing, and it needs no event to
  // subscribe to: the cleaned raster is a new object URL, so the page no longer
  // quotes the src the pixels were filed under and the lookup misses.
  it('misses once the page’s raster has been replaced', () => {
    const p = { id: 1, raw: 'blob:r1', cleaned: null };
    rememberPagePixels(p.id, pageRasterSrc(p), img('a'));
    expect(pagePixelsFor(p)).not.toBe(null);
    p.cleaned = 'blob:c1';
    expect(pagePixelsFor(p)).toBe(null);
  });

  // Page ids are per-document counters and collide freely across chapters, so
  // the id alone would let one chapter's page 3 hand its pixels to another's.
  it('will not serve one document’s page to another with the same id', () => {
    rememberPagePixels(3, 'blob:chapter-a-3', img('a'));
    expect(pagePixelsFor({ id: 3, raw: 'blob:chapter-b-3' })).toBe(null);
  });

  it('answers null for a page nobody has looked at', () => {
    expect(pagePixelsFor({ id: 9, raw: 'blob:r9' })).toBe(null);
    expect(pagePixelsFor(null)).toBe(null);
  });

  it('refuses an image that has not decoded, rather than caching nothing', () => {
    expect(rememberPagePixels(1, 'blob:r1', img('a', 0, 0))).toBe(null);
    expect(rememberPagePixels(1, 'blob:r1', null)).toBe(null);
    expect(rememberPagePixels(null, 'blob:r1', img('a'))).toBe(null);
    expect(rememberPagePixels(1, '', img('a'))).toBe(null);
    expect(pagePixelsHeld()).toBe(0);
  });

  it('is a no-op where there is nothing to decode with', () => {
    globalThis.document = undefined;
    expect(rememberPagePixels(1, 'blob:r1', img('a'))).toBe(null);
    expect(pagePixelsHeld()).toBe(0);
  });

  // A decode that throws - a tainted canvas, a browser refusing the allocation
  // - costs the fit and nothing else. Placement falls back.
  it('survives a decode that throws', () => {
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => {
          throw new Error('no');
        },
      }),
    };
    expect(rememberPagePixels(1, 'blob:r1', img('a'))).toBe(null);
    expect(pagePixelsHeld()).toBe(0);
  });
});

// ===========================================================================
// The decode that does not happen twice, and the one that happens early
// ===========================================================================
describe('the cost of asking again', () => {
  // A page turn remounts the `<img>` for a page still inside the resident
  // window, so `onload` fires again for a URL that has not changed. Reading a
  // print-scale page back out of a canvas is ~20ms of synchronous main-thread
  // work, and doing it to arrive at bytes already in the map is 20ms of a page
  // turn spent on nothing.
  it('does not re-decode a raster it is already holding', () => {
    const p = { id: 1, raw: 'blob:r1', cleaned: null };
    const first = rememberPagePixels(p.id, 'blob:r1', img('a'));
    const again = rememberPagePixels(p.id, 'blob:r1', img('b'));
    expect(again).toBe(first);
    expect(decodes).toEqual(['a']);
  });

  // The short-circuit is a HIT, so it promotes like one - otherwise a page being
  // remounted over and over would age out under pages nobody is looking at.
  it('promotes on the short circuit', () => {
    for (let i = 1; i <= 8; i++) rememberPagePixels(i, `blob:r${i}`, img(`i${i}`));
    rememberPagePixels(1, 'blob:r1', img('i1'));
    rememberPagePixels(9, 'blob:r9', img('i9'));
    expect(pagePixelsFor({ id: 1, raw: 'blob:r1' })).not.toBe(null);
    expect(pagePixelsFor({ id: 2, raw: 'blob:r2' })).toBe(null);
  });

  // The src check still binds. A cleaned raster landing gives the page a new
  // object URL, and the entry under the old one is about art no longer on screen.
  it('still re-decodes when the raster has been replaced', () => {
    rememberPagePixels(1, 'blob:r1', img('a'));
    rememberPagePixels(1, 'blob:c1', img('b'));
    expect(decodes).toEqual(['a', 'b']);
    expect(pagePixelsHeld()).toBe(1);
  });
});

describe('a click that beats the idle callback', () => {
  // The canvas defers the decode to whenever the browser is next idle and leaves
  // the ingredients behind on the way past. A placement in the gap cannot wait -
  // it is inside a click handler - so the read happens on the spot instead.
  it('decodes synchronously from the note the canvas left', () => {
    const p = { id: 1, raw: 'blob:r1', cleaned: null };
    notePageImage(p.id, 'blob:r1', img('a', 6, 8));
    expect(pagePixelsHeld()).toBe(0);
    const data = pagePixelsFor(p);
    expect([data.width, data.height]).toEqual([6, 8]);
    expect(decodes).toEqual(['a']);
    // And it is a cache entry now, so the idle callback that arrives afterwards
    // costs nothing and the next click is a plain hit.
    expect(pagePixelsHeld()).toBe(1);
    expect(pagePixelsFor(p)).toBe(data);
    expect(decodes).toEqual(['a']);
  });

  // The note is addressed exactly like the cache entry it becomes: a page whose
  // raster has been replaced since the note was left must not be answered with
  // the old picture.
  it('refuses a note about a raster the page no longer draws', () => {
    notePageImage(1, 'blob:r1', img('a'));
    expect(pagePixelsFor({ id: 1, raw: 'blob:r1', cleaned: 'blob:c1' })).toBe(null);
    expect(decodes).toEqual([]);
  });

  it('goes with the rest when a chapter closes', () => {
    notePageImage(1, 'blob:r1', img('a'));
    forgetPagePixels();
    expect(pagePixelsFor({ id: 1, raw: 'blob:r1' })).toBe(null);
    notePageImage(2, 'blob:r2', img('b'));
    forgetPagePixels(2);
    expect(pagePixelsFor({ id: 2, raw: 'blob:r2' })).toBe(null);
    expect(decodes).toEqual([]);
  });

  // Bounded like everything else here. The notes are cheap - a URL and a
  // reference to an element the DOM is holding anyway - but "cheap" is not
  // "unbounded", and a chapter scrolled end to end would leave one per page.
  it('holds only the most recent notes', () => {
    for (let i = 1; i <= 20; i++) notePageImage(i, `blob:r${i}`, img(`i${i}`));
    expect(pagePixelsFor({ id: 1, raw: 'blob:r1' })).toBe(null);
    expect(pagePixelsFor({ id: 20, raw: 'blob:r20' })).not.toBe(null);
  });

  // ...and "the most recent" is a backstop, not the policy. What a note holds is
  // the page's `<img>` ELEMENT, and once the resident window has moved past the
  // page the canvas has unmounted that element - at which point the note is the
  // only thing keeping its decoded bitmap alive, fourteen megabytes of a print
  // page apiece. A note has done its job the moment the decode it was covering
  // for is asked for, however that turns out, so every way out of
  // `rememberPagePixels` drops it.
  describe('and the note that is finished with', () => {
    it('lets go once the pixels are cached', () => {
      notePageImage(1, 'blob:r1', img('a'));
      expect(pagePixelNotesHeld()).toBe(1);
      rememberPagePixels(1, 'blob:r1', img('a'));
      expect(pagePixelNotesHeld()).toBe(0);
    });

    // The path that actually happens, and the one that used to hold on forever:
    // a page turn remounts the `<img>` for a raster already in the map, so the
    // canvas leaves a fresh note and the decode short-circuits. Sixteen of those
    // and the app is holding a quarter of a gigabyte of bitmaps it believes it
    // has given back.
    it('lets go on the short circuit too', () => {
      rememberPagePixels(1, 'blob:r1', img('a'));
      notePageImage(1, 'blob:r1', img('a'));
      expect(pagePixelNotesHeld()).toBe(1);
      expect(rememberPagePixels(1, 'blob:r1', img('a'))).not.toBe(null);
      expect(pagePixelNotesHeld()).toBe(0);
      expect(decodes).toEqual(['a']);
    });

    it('lets go when the decode refuses or throws', () => {
      notePageImage(1, 'blob:r1', img('a'));
      expect(rememberPagePixels(1, 'blob:r1', img('a', 0, 0))).toBe(null);
      expect(pagePixelNotesHeld()).toBe(0);

      globalThis.document = {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => {
            throw new Error('no');
          },
        }),
      };
      notePageImage(2, 'blob:r2', img('b'));
      expect(rememberPagePixels(2, 'blob:r2', img('b'))).toBe(null);
      expect(pagePixelNotesHeld()).toBe(0);
    });

    // Only ever its own note. A decode landing for a raster the page has since
    // replaced must not throw away the note left for the one now on screen -
    // that would cost the click the very fit the note exists to answer.
    it('leaves a note about a different raster alone', () => {
      notePageImage(1, 'blob:c1', img('new'));
      rememberPagePixels(1, 'blob:r1', img('old'));
      expect(pagePixelNotesHeld()).toBe(1);
      expect(pagePixelsFor({ id: 1, raw: 'blob:r1', cleaned: 'blob:c1' })).not.toBe(null);
      expect(decodes).toEqual(['old', 'new']);
    });
  });
});

// ===========================================================================
// A look that changes nothing
// ===========================================================================
// The chapter-wide fit reads the cache too, and it is not a click: it walks
// every page in order, so everything `pagePixelsFor` does besides answering -
// promoting a hit, decoding a note into an entry - would be a batch reordering
// or filling a cache that exists for the page under the cursor.
describe('peekPagePixels', () => {
  const p = (id) => ({ id, raw: `blob:r${id}` });
  const remember = (id) => rememberPagePixels(id, `blob:r${id}`, img(`i${id}`));

  it('answers from the cache for the raster the page draws', () => {
    const data = remember(1);
    expect(peekPagePixels(p(1))).toBe(data);
    expect(decodes).toEqual(['i1']);
  });

  it('misses on anything else, exactly as a click would', () => {
    remember(1);
    expect(peekPagePixels({ id: 1, raw: 'blob:r1', cleaned: 'blob:c1' })).toBe(null);
    expect(peekPagePixels({ id: 1, raw: null, cleaned: null })).toBe(null);
    expect(peekPagePixels(p(2))).toBe(null);
    expect(peekPagePixels(null)).toBe(null);
  });

  // Read in page order and promoted as it went, the order would end up sorted
  // by page number - and the next decode would evict whichever page comes first
  // in the chapter, not whichever the user looked at longest ago.
  it('does not promote what it reads', () => {
    for (let i = 1; i <= 8; i++) remember(i);
    peekPagePixels(p(1));
    remember(9);
    expect(pagePixelsFor(p(1))).toBe(null);
    expect(pagePixelsFor(p(2))).not.toBe(null);
  });

  // The note is the canvas's, and turning it into an entry is the canvas's
  // idle callback's job. A batch that did it would be filing pages into the
  // click cache on its own schedule.
  it('neither decodes a note nor files anything', () => {
    notePageImage(1, 'blob:r1', img('a'));
    expect(peekPagePixels(p(1))).toBe(null);
    expect(decodes).toEqual([]);
    expect(pagePixelsHeld()).toBe(0);
    expect(pagePixelNotesHeld()).toBe(1);
  });
});

describe('the bound', () => {
  const p = (id) => ({ id, raw: `blob:r${id}` });
  const remember = (id) => rememberPagePixels(id, `blob:r${id}`, img(`i${id}`));

  // A 200-page chapter decoded page by page would hold gigabytes of ImageData
  // alive, so there is a bound - but it has to be bigger than the two entries a
  // pager needs, because a longstrip chapter keeps a resident window of up to a
  // dozen slices on screen and every one of them decodes. At two, the ten
  // decodes either side of the scroll position evicted the page under the
  // cursor before the user could click it.
  it('holds a longstrip’s worth of pages and drops the least recently used', () => {
    for (let i = 1; i <= 9; i++) remember(i);
    expect(pagePixelsHeld()).toBe(8);
    expect(pagePixelsFor(p(1))).toBe(null);
    for (let i = 2; i <= 9; i++) expect(pagePixelsFor(p(i))).not.toBe(null);
  });

  // Least recently USED, not least recently added: a reader keeps a page alive.
  it('promotes a page on every hit', () => {
    for (let i = 1; i <= 8; i++) remember(i);
    pagePixelsFor(p(1));
    remember(9);
    expect(pagePixelsFor(p(1))).not.toBe(null);
    expect(pagePixelsFor(p(2))).toBe(null);
  });

  // The count is the loose half of the bound. What the memory actually costs is
  // bytes, and a print-scale page is two orders of magnitude bigger than a
  // thumbnail - so eight of them is a quarter of a gigabyte and eight of those
  // is nothing. The budget is what binds on the big ones.
  it('is bounded by bytes as well as by count', () => {
    // 8000x8000 is 256 MB an entry - the whole budget - so no two can be held.
    // Sized rather than allocated: the stub hands back a `data` that reports its
    // own `byteLength`, because the bookkeeping is what is under test.
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: (x, y, w, h) => ({ width: w, height: h, data: { byteLength: w * h * 4 } }),
        }),
      }),
    };
    const huge = (id) => rememberPagePixels(id, `blob:r${id}`, img(`i${id}`, 8000, 8000));
    huge(1);
    huge(2);
    huge(3);
    expect(pagePixelsHeld()).toBe(1);
    expect(pagePixelsFor(p(3))).not.toBe(null);
  });

  // ...and never the last entry, however big it is. A page over the budget on
  // its own is still the page being looked at, and dropping it the instant it
  // decodes would mean a chapter of that size could never be fitted at all.
  it('keeps a page too big for the budget by itself', () => {
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: (x, y, w, h) => ({ width: w, height: h, data: { byteLength: w * h * 4 } }),
        }),
      }),
    };
    rememberPagePixels(1, 'blob:r1', img('i1', 20000, 20000)); // 1.6 GB
    expect(pagePixelsHeld()).toBe(1);
    expect(pagePixelsFor(p(1))).not.toBe(null);
  });

  it('re-decoding a page replaces its entry rather than adding one', () => {
    remember(1);
    remember(1);
    expect(pagePixelsHeld()).toBe(1);
  });

  // The coarse event the src check cannot cover: a chapter closing gives the
  // memory back at once rather than at the next decode.
  it('gives everything back on demand, or one page at a time', () => {
    remember(1);
    remember(2);
    forgetPagePixels(1);
    expect(pagePixelsHeld()).toBe(1);
    expect(pagePixelsFor(p(1))).toBe(null);
    forgetPagePixels();
    expect(pagePixelsHeld()).toBe(0);
  });
});
