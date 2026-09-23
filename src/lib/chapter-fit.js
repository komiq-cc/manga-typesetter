// ===== Every balloon in the chapter, measured before anything is placed =====
//
// "Place chapter" puts a box on every detected bubble in the chapter, and each
// box's size and shape come out of a balloon fit - a flood fill over the page's
// own pixels (balloon.js). Placement reads those pixels synchronously (see the
// head of page-pixels.js), and the only pixels it can have synchronously are the
// ones the click cache happens to hold: the pages loaded around the reading
// position when the button was pressed. Every other page got the detector's
// rectangle instead, and nothing ever upgraded it. So one chapter placed from
// two reading positions came out as two different documents, and a page the
// user had visited and scrolled away from was placed worse than the one they
// were looking at.
//
// This module is the half of the fix that decodes. It walks the chapter, reads
// each page's pixels once, and answers every fit placement is going to ask for
// BEFORE anything is placed - so placement can stay what it has to be, one
// synchronous pass, fed by answers that no longer depend on what was in memory.
// It commits nothing. The caller decides what the answers are still worth by
// the time they arrive: the run takes seconds, and the document is live under
// it.
//
// Not in page-pixels.js, which is the synchronous click cache and should stay
// exactly that; and not in the store, which has no business owning a decode
// loop. The two opinions this needs from the store - which blocks on a page
// want a fit, and what the fit of a block IS - are handed in as `blocksFor` and
// `fitFor`, so this file can never grow a second copy of either and drift from
// what a click would have measured.
//
// Per page, in index order:
//
//   a page with nothing to fit is skipped before anything is read - no pin, no
//   file read, no decode;
//   the page is held with `withPageImages`, the same pin chapter export and
//   batch detect take, so a page turn cannot revoke the picture mid-read, and
//   it is handed back afterwards unless the window wants it;
//   its pixels come from the click cache if that already holds this raster -
//   read with `peekPagePixels`, which neither promotes nor files anything -
//   and otherwise from a decode of our own, through the same draw-then-read
//   the cache uses (`decodeImagePixels`);
//   the fits are computed once the page's pictures have been given back, with
//   nothing of the page alive but the `ImageData`, and then that goes too.
//
// Memory is the constraint the rest is shaped by. A print page is 24 MB as an
// `ImageData`, and for the moment of the read there are three of it: the
// decoded bitmap, the canvas it is drawn into, and the bytes read back out. The
// canvas is zeroed the instant the read is done and the picture is released
// straight after, so the fits run on one copy - and at the default concurrency
// of 1 there is only ever one page's worth of any of it. Nothing read here is
// filed into the click cache: it holds eight pages, and every page a batch
// added would push out one the canvas decoded for the reader - in a longstrip,
// quite possibly the slice under the cursor.
//
// Cancelling is the `signal`. It is checked before every page and after every
// wait, and an aborted run resolves to null rather than to what it had so far,
// so there is nothing partial for a caller to commit by mistake. The caller
// MUST abort synchronously when the chapter closes or another opens, before the
// old chapter's images are released: a page object from the old chapter handed
// to `withPageImages` after that would be minted from the NEW chapter's
// directories under an id the new chapter reuses - the window would then
// believe that id already minted, and the new chapter's page would draw blank.

import { withPageImages } from './page-images.js';
import { decodeImagePixels, pageRasterSrc, peekPagePixels } from './page-pixels.js';

// Back to the browser between pages. A macrotask, not a resolved promise: a
// microtask runs before the browser paints or looks at its input queue, so the
// next page would start before the progress count could redraw or the Cancel
// button could be pressed.
const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

// One raster, read into an `ImageData` through a picture of our own, which is
// released before this returns whatever happens.
//
// Its own element rather than the canvas's or the window's, because neither of
// those is ours to hold: the canvas's `<img>` belongs to whatever page is on
// screen, and the window's pre-decoded handle belongs to the window and is
// released by it. The price is at worst a second decode of a picture the window
// has just decoded, on the decoder thread, one page at a time.
async function readRaster(src, signal) {
  if (!src || typeof Image === 'undefined') return null;
  const img = new Image();
  img.decoding = 'async';
  // Before `src`, always. The request's mode is fixed the moment `src` is set:
  // an asset-protocol page loaded without it is cross-origin, and the canvas
  // it is drawn into comes back tainted - `getImageData` throws and the page
  // silently gets no fit. See `mintAsset` in page-images.js.
  img.crossOrigin = 'anonymous';
  img.src = src;
  try {
    // Decoded on the decoder thread, so the draw below paints a ready bitmap
    // instead of decoding a print page on the main thread in the middle of it.
    await img.decode?.();
    if (signal?.aborted) return null;
    return decodeImagePixels(img);
  } catch {
    // A picture that will not load or decode is a page that cannot be fitted,
    // exactly like a page nobody decoded. Not a reason to fail the chapter.
    return null;
  } finally {
    // `removeAttribute`, not `src = ''`, for the reason `releaseDecoded` in
    // page-images.js gives.
    img.removeAttribute('src');
  }
}

// The page's pixels, with its pictures held only for the read. Returns the
// `ImageData` out of `withPageImages`, so the page is handed back before a
// single fit runs.
function pagePixels(p, signal) {
  return withPageImages(p, async () => {
    if (signal?.aborted) return null;
    return peekPagePixels(p) ?? (await readRaster(pageRasterSrc(p), signal));
  });
}

// A page's answers, one per block, or null when the page could not be read.
// Its own function so the pixels die with its frame: held in the loop below,
// they would stay alive across the pause between pages.
async function measurePage({ p, blocks }, fitFor, signal) {
  const pixels = await pagePixels(p, signal);
  if (!pixels || signal?.aborted) return null;
  return blocks.map((block) => fitFor(p, block, pixels) ?? null);
}

// Measure every fit the chapter's placement will ask for.
//
//   blocksFor(page)               the blocks on this page that want a fit, in
//                                 any form `fitFor` understands. Asked once per
//                                 page, synchronously, at the start: the run is
//                                 decided against the document as it stood
//                                 when the button was pressed.
//   fitFor(page, block, pixels)   the fit of one block, given the pixels of the
//                                 raster the page draws at its natural size.
//                                 null (or undefined) for a block measured and
//                                 found not to have one. Answers in the page's
//                                 own coordinates - and those can differ from
//                                 the pixels' on a page whose space was never
//                                 reconciled with this raster, which is
//                                 `fitFor`'s to map, not this module's.
//   signal                        an AbortSignal. See the head of this file for
//                                 when the caller must fire it.
//   onProgress({ done, total })   once at the start and after every page, when
//                                 there is anything to measure at all; `total`
//                                 counts only the pages with blocks.
//   concurrency                   pages in memory at once.
//
// Resolves to a Map from each block to its fit (or null), in page order and
// block order within a page. A block whose page could not be read is ABSENT -
// not measured, which is a different answer from measured-and-irregular, and
// the caller must be able to tell the two apart. Resolves to null when the run
// was aborted.
export async function measureChapterFits(
  pages,
  { blocksFor, fitFor, signal, onProgress, concurrency = 1 } = {},
) {
  if (signal?.aborted) return null;
  const work = [];
  for (const p of pages ?? []) {
    const blocks = blocksFor(p) ?? [];
    if (blocks.length) work.push({ p, blocks, fits: null });
  }
  const total = work.length;
  if (!total) return new Map();
  let done = 0;
  let next = 0;
  onProgress?.({ done, total });
  // Each lane takes the next page in index order, so with one lane the pages
  // are read strictly in order and with more they are at least started in it.
  const lane = async () => {
    while (next < total && !signal?.aborted) {
      const job = work[next++];
      job.fits = await measurePage(job, fitFor, signal);
      if (signal?.aborted) return;
      onProgress?.({ done: ++done, total });
      if (next < total) await nextTurn();
    }
  };
  const lanes = Math.max(1, Math.min(total, concurrency | 0));
  await Promise.all(Array.from({ length: lanes }, lane));
  if (signal?.aborted) return null;
  // Assembled in page order rather than as the lanes finished, so the answer
  // is the same whatever order the reads happened to complete in.
  const fits = new Map();
  for (const { blocks, fits: answers } of work) {
    if (answers) blocks.forEach((block, i) => fits.set(block, answers[i]));
  }
  return fits;
}
