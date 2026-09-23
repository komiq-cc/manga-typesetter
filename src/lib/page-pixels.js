// ===== The page's own pixels, decoded once =====
//
// `balloon.js` recovers a bubble's interior from the page's pixels, and it is
// deliberately agnostic about where those pixels come from: it takes an
// `ImageData`-shaped object and the caller decides. This module is that
// decision for the app.
//
// The requirement that shapes everything here is that placement asks
// SYNCHRONOUSLY. A click lands a box, and the box's size comes out of the fit -
// so the fit has to be available in the same turn as the click, or placement
// would have to become async and every caller of `placeActiveAt` (the canvas,
// the tests, the history) would have to learn about promises for the sake of one
// optional refinement. Decoding a 2000x3000 page costs tens of milliseconds and
// allocates 24 MB; doing that inside a click handler is not acceptable, and
// doing it once per page and remembering the answer is.
//
// Which raster. The canvas draws `p.cleaned ?? p.raw` and so does every
// exporter, so that is what gets decoded here - the detector must run on the
// picture the user is looking at. It matters when the two differ, which is
// exactly the case a clean creates: the raw still has the Japanese in it, and
// the flood fill seeded inside a text block would meet glyphs the cleaned page
// no longer has. Fitting the cleaned raster is both the better answer (a wiped
// balloon is a clean interior with nothing in it to trip over) and the
// consistent one (the shape is stored in page coordinates and drawn over the
// same art).
//
// The bound is the other half. A 200-page chapter decoded page by page would
// hold five gigabytes of `ImageData` alive, which is not a cache, it is a leak
// with a lookup table in front of it. So the map evicts the least recently used,
// and a hit promotes. A miss is not an error: the caller falls back to the
// detector's rectangle, which is what it did before this module existed.
//
// What the bound cannot be is two entries. That was the first number here, and
// it was chosen for a pager - one page on screen, one being turned to - which is
// exactly the reading mode a longstrip chapter does not have. A webtoon column
// mounts a resident window of up to twelve slices around the scroll position
// (`residentRadiusFor` in editor/strip.js) and every one of them decodes and
// calls in here, so a two-entry map is emptied and refilled by pages the user is
// nowhere near. Promotion does not save it: the evictions are driven by DECODES,
// not by reads, and ten of them land between one click and the next. The page
// under the cursor - the only one anybody is going to click - was routinely the
// one thrown away.
//
// So the bound is stated the way the cost actually is: in bytes, with a count
// beside it. An `ImageData` is 4 bytes a pixel and pages differ by an order of
// magnitude in area - a webtoon slice is a fraction of a print page - so a count
// alone is either too loose for big pages or pointlessly tight for small ones.
// The byte budget is what keeps the memory honest; the count keeps the map from
// growing long on thumbnails. Whichever binds first, binds.
const MAX_PAGES = 8;
// 256 MB - about ten print-scale pages, or a resident window of webtoon slices,
// and a small fraction of what the renderer holds in decoded `<img>`s anyway.
const MAX_BYTES = 256 * 1024 * 1024;

const bytesOf = (image) => image?.data?.byteLength ?? (image?.width | 0) * (image?.height | 0) * 4;

// pageId -> { src, image, bytes }. A `Map` because its iteration order is
// insertion order, which is what makes "delete the oldest key" one line and
// "promote on hit" two.
const cache = new Map();

// Drop least-recently-used entries until both bounds hold. Never the last one:
// a single page larger than the whole budget is still the page being looked at,
// and evicting it the instant it is decoded would mean no chapter of that size
// could ever be fitted at all.
function evict() {
  let bytes = 0;
  for (const e of cache.values()) bytes += e.bytes;
  while (cache.size > 1 && (cache.size > MAX_PAGES || bytes > MAX_BYTES)) {
    const oldest = cache.keys().next().value;
    bytes -= cache.get(oldest).bytes;
    cache.delete(oldest);
  }
}

// Whether this environment can decode anything at all. Node cannot, and every
// function here answers null there, which puts placement straight onto its
// fallback path - the same behaviour as a page nobody has looked at yet.
const canDecode = () => typeof document !== 'undefined';

// The raster the canvas draws, and the one a fit must be measured against. One
// expression, exported, so the cache and its callers cannot drift into two
// different opinions about which image a page *is*.
export const pageRasterSrc = (p) => p?.cleaned ?? p?.raw ?? null;

function promote(pageId, entry) {
  cache.delete(pageId);
  cache.set(pageId, entry);
}

// ===== the one draw-then-read =====
//
// An already-loaded `<img>` in, its `ImageData` out - or null, for a picture
// that has not decoded or a canvas that refuses. Two callers, and they must not
// be two implementations: the cache below, which files what it reads, and the
// chapter-wide fit in chapter-fit.js, which reads pages it is not allowed to
// file. A batch fit measured off a different read than the one a click would
// have made is exactly the "same page, different answer" that module exists to
// remove.
//
// The canvas is given back before this returns. It is scratch - written once,
// read once - and after the read it is a second full copy of the page in its
// backing store that nothing will look at again. Dropping the reference leaves
// that memory to the collector, which is in no hurry about canvases; zeroing the
// size hands it back now. On a click that is one page's worth held a little
// longer than it had to be. In a chapter-wide pass it is one per page.
export function decodeImagePixels(image) {
  const w = image?.naturalWidth | 0;
  const h = image?.naturalHeight | 0;
  if (!w || !h || !canDecode()) return null;
  let c = null;
  try {
    c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    // No `willReadFrequently`. It is exactly the wrong hint here: it asks the
    // browser for a SOFTWARE-backed canvas on the assumption that many reads
    // are coming, and this canvas is written once and read once - so the hint
    // bought a slower `drawImage` to optimise a second `getImageData` that
    // never happens.
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    // A decode that fails - a tainted canvas, a browser refusing the allocation
    // - costs the fit and nothing else. The caller falls back.
    return null;
  } finally {
    if (c) {
      c.width = 0;
      c.height = 0;
    }
  }
}

// Decode an already-loaded `<img>` into an `ImageData` and remember it under
// this page's id. Called from the canvas's own `onload`, which is the one moment
// in the app where a decoded page raster exists and nothing has to be fetched.
//
// `src` is stored alongside the pixels rather than trusted to stay current:
// object URLs are minted per blob, so a page whose cleaned raster is replaced
// gets a new URL, and a lookup that quotes the new URL against an entry holding
// the old one misses instead of handing back the pixels of art that is no longer
// on screen. That is the whole invalidation story for a clean landing - there is
// no event to subscribe to and nothing to remember to call.
export function rememberPagePixels(pageId, src, image) {
  if (pageId == null || !src || !canDecode()) return null;
  // The note exists to cover the window between a picture decoding and its
  // pixels being read (see `notePageImage`), and reaching this function is the
  // end of that window however it turns out - the pixels are cached below, or
  // this raster cannot be read at all. Dropped here rather than only on the
  // success path, because what the note holds is the page's `<img>` ELEMENT,
  // and an element the canvas has since unmounted keeps its decoded bitmap
  // alive for as long as anything points at it. Three of the four ways out of
  // this function used to leave that reference standing, and the most travelled
  // of them is the first one below: turning back to a page whose pixels are
  // already cached re-noted the element and never let go of it again. Sixteen
  // of those is a couple of hundred megabytes of bitmaps the app believes it
  // has given back.
  //
  // Only ever OUR note: a call about an older raster must not throw away the
  // note left for the one now on screen.
  const note = pending.get(pageId);
  if (note && note.src === src) pending.delete(pageId);
  // Already held, for this exact raster. A page turn re-fires the canvas's
  // `onload` for a picture that is still in the resident window - the `<img>`
  // is remounted, the URL is unchanged - and every one of those used to redo a
  // full-page `drawImage` + `getImageData`: ~20ms of synchronous main thread
  // work to arrive at the bytes already sitting in the map. The `src` check is
  // the same one `pagePixelsFor` makes, and it is what makes this safe: a
  // cleaned raster that has been replaced carries a new object URL, so it
  // misses here and is decoded as it always was.
  const held = cache.get(pageId);
  if (held && held.src === src) {
    promote(pageId, held);
    return held.image;
  }
  const data = decodeImagePixels(image);
  if (!data) return null;
  promote(pageId, { src, image: data, bytes: bytesOf(data) });
  evict();
  return data;
}

// ===== the decode that has not happened yet =====
//
// `rememberPagePixels` is called from the canvas's `onload`, which is the middle
// of a page turn - and a 1500x2400 `getImageData` there is ~20ms of the turn
// spent on something nobody has asked for yet. Most page turns never place a
// box, so most of those decodes are pure cost.
//
// So the canvas defers it to an idle callback and leaves the raw ingredients
// here on the way past. Two things then hold:
//
//   the turn is cheap - the idle callback does the decode when the browser has
//   a moment, and by the time anyone clicks, the map is warm;
//   a click that beats the idle callback still gets its fit - `pagePixelsFor`
//   falls through to this and decodes SYNCHRONOUSLY, which is exactly what the
//   old code did on every turn and is now the rare path rather than the rule.
//
// Bounded like everything else here, and the bound is the FIFO below - but a
// note is meant to be short-lived, not merely capped. What it holds is the
// page's `<img>` element, and that costs nothing beyond the reference only for
// as long as the canvas still has the element mounted: once the resident window
// has moved past the page, the element is detached and the note is the only
// thing keeping its decoded bitmap - fourteen megabytes of a print page -
// alive. So a note is dropped the moment it is answered
// (`rememberPagePixels`) and the moment the page's pictures are given back
// (`forgetPagePixels`, called from `releasePageImages`), and the cap is the
// backstop rather than the policy.
//
// The `src` recorded with it is checked before use, so a note left for a raster
// that has since been replaced misses rather than answering with the wrong art.
const MAX_PENDING = 16;
const pending = new Map();

export function notePageImage(pageId, src, image) {
  if (pageId == null || !src || !image) return;
  pending.delete(pageId);
  pending.set(pageId, { src, image });
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
}

// The pixels for a page, or null. Synchronous by construction: this either
// answers from the map or it does not answer at all.
//
// The `src` check is what makes a hit safe. A page id is only unique within a
// document - `loadProjectPages` keeps the ids a chapter was saved with - so the
// id alone would let one chapter's page 3 hand its pixels to another's.
export function pagePixelsFor(p) {
  const id = p?.id;
  if (id == null) return null;
  const src = pageRasterSrc(p);
  const entry = cache.get(id);
  if (entry && entry.src === src) {
    promote(id, entry);
    return entry.image;
  }
  // The miss that is not a miss: the picture has decoded and the canvas has left
  // a note, but the idle callback that was going to read its pixels has not run
  // yet. A click cannot wait for it - placement is synchronous by construction,
  // see the head of this file - so the read happens here instead, once, and the
  // map is warm for every later click on the page. See `notePageImage`.
  const note = pending.get(id);
  if (note && note.src === src) return rememberPagePixels(id, src, note.image);
  return null;
}

// The same lookup for a reader that is not a click: an entry for this exact
// raster, already here, or null - and nothing else happens either way.
//
// `pagePixelsFor` is a read with two side effects, both right for a click and
// both wrong for a batch. A hit promotes, because the page a user clicks is the
// page they are on - but the chapter-wide fit walks every page in order, and
// promoting as it goes would leave the least-recently-used order sorted by page
// number rather than by what the user has been looking at, so the canvas's next
// decode would evict whichever cached page comes first in the chapter - which
// may well be the one under the cursor. And a pending note is turned into an
// entry on the spot, which is a batch filing pages into the click cache on its
// own schedule. That is the one thing chapter-fit.js must never do: in a cache
// this small every entry a batch adds is one the reader loses.
//
// A miss costs the caller a decode of its own, which it was prepared to do for
// every page anyway.
export function peekPagePixels(p) {
  const id = p?.id;
  if (id == null) return null;
  const entry = cache.get(id);
  return entry && entry.src === pageRasterSrc(p) ? entry.image : null;
}

// Drop one page, or the lot. The src check above already covers a raster being
// replaced; this is for the coarser event - a chapter closing or another one
// opening - where the ids themselves stop meaning what they meant and the memory
// should go back immediately rather than at the next decode.
export function forgetPagePixels(pageId) {
  if (pageId == null) {
    cache.clear();
    pending.clear();
  } else {
    cache.delete(pageId);
    pending.delete(pageId);
  }
}

// For tests and for the settings-modal sort of introspection: how many pages are
// currently held. Deliberately not the pixels themselves.
export const pagePixelsHeld = () => cache.size;

// The other half of the same introspection: how many undecoded notes are being
// held. It is a count of `<img>` ELEMENTS, which is the reason it is worth
// being able to see at all - see `rememberPagePixels` on what one of those
// costs once the canvas has unmounted it.
export const pagePixelNotesHeld = () => pending.size;
