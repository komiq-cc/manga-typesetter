// ===== Balloon interior recovery =====
//
// A text box placed on a bubble is currently sized from the detector's text
// block - the rectangle the *Japanese* occupied. That rectangle is wrong twice
// over. The Japanese in most balloons is set vertically, so the block is a tall
// narrow column exactly where the English wants a wide short one; and a bounding
// box says nothing about the balloon's shape, so English laid out inside it runs
// into the curve of an oval near the top and the bottom, which is the one place
// a letterer's eye goes first.
//
// The detector cannot help - `/analyze` reports `box`, `vertical` and
// `font_size` and nothing about the balloon - but the page can. A manga balloon
// is a solid light interior inside a dark outline, which is the one piece of
// structure that is true of nearly every bubble ever drawn, and a flood fill
// from inside the text block recovers it with no model, no network call and no
// change to the Python side.
//
// The module is deliberately split in two.
//
//   the pixel half   `fillInterior` - the only function here that touches an
//                    image. It takes an `ImageData`-shaped object, so the caller
//                    decides where the pixels came from (the canvas, an
//                    offscreen decode of `p.cleaned ?? p.raw`, a test fixture).
//   the geometry     everything else - profile, classify, fit, per-line widths,
//                    inscribed rect. Pure arithmetic on plain objects, testable
//                    under node with no canvas anywhere near it, and cheap
//                    enough that the line-breaker can call `interiorLineWidths`
//                    once per candidate line count inside its own search.
//
// What crosses the boundary between them is a mask; what crosses out of the
// module is a handful of numbers. That matters: the fitted shape is stored on
// the box, written into `chapter.json` and carried through the PSD's embedded
// project, so it has to be plain JSON - `{ kind:'ellipse', cx, cy, rx, ry }` or
// `{ kind:'rect', x, y, w, h }` - and never a mask.

// The knobs, and what each one is trading off. Every one of them is overridable
// per call, because a page of tiny four-panel gag strips and a page of splash
// art are not the same problem and the caller may know which it has.
export const BALLOON_DEFAULTS = {
  // ---- the flood fill ----
  // How far past the detected block the fill is allowed to look, as a multiple
  // of the block's LONGER side. A fill that escapes through a gap in an outline
  // - an open tail, art touching the bubble - would otherwise run away across
  // the whole page, and a full-page scan is both slow and useless: the answer it
  // returns is not a balloon. The longer side rather than each axis separately
  // because a vertical Japanese column is tall and narrow and the balloon around
  // it is wide, so a window scaled per-axis would be clipped exactly where the
  // interesting geometry is.
  windowMargin: 2,
  windowMin: 32, // ...and never less than this, so a tiny SFX label still has room to look
  windowMax: 400, // ...and never more, because no balloon wall is 400px from its own text
  // ...except that "400px" is a statement about a page at a particular scale, and
  // the app is handed pages at every scale there is. A 1200px gag strip, a 3000px
  // splash and a webtoon column rendered at twice the print size all have
  // balloons of about the same size *relative to the page*, so a fixed cap in
  // absolute pixels is a cap that lands in a different place on each of them - and
  // on the big ones it lands INSIDE the balloon, at which point the fill reaches
  // the window border, `escaped` is set, and every large bubble on the page falls
  // back to the detector's rectangle. So the cap is the larger of the absolute
  // number and a fraction of the page's SHORTER side: the shorter side because it
  // scales with the art rather than with how long a strip happens to be.
  windowMaxFrac: 0.2,
  // A region smaller than this fraction of the detected block's own area is not
  // the balloon around that block: it is a pocket of white inside a glyph. The
  // interior of a real bubble contains the text, so it is necessarily bigger
  // than the text's bounding box; the fraction is below 1 only because a
  // detector's box can sit loose around sparse text.
  minInteriorFrac: 0.6,
  // The bounds the derived luminance threshold is clamped into. See
  // `interiorThreshold` for why a derived threshold needs bounds at all.
  minThreshold: 64,
  maxThreshold: 224,
  fillHoles: true, // reclassify enclosed dark islands (the glyphs) as interior

  // ---- the fit ----
  minRows: 8, // a region shorter than this has no profile worth fitting
  maxHoleFrac: 0.05, // fraction of rows with no interior run before the region is refused
  rectTol: 0.15, // row widths within this fraction of each other read as a rectangle
  trimTol: 0.25, // a row whose edge misses the fitted curve by this much of its half-width is an outlier
  maxResidual: 0.12, // RMS edge error, as a fraction of the half-width, above which no fit is believed
  minCoverage: 0.9, // fraction of the rows inside the fitted span that must be inliers
  minSpan: 0.7, // fraction of the region's rows the fitted shape must actually claim
  maxTailWidth: 0.5, // a spike outside the fitted span is a tail only while it stays this narrow

  // ---- the click-point probe (placement with no detected block) ----
  // Placing from the queue does not always have a detector block to seed from:
  // the page may never have been analysed, or the click may land on a bubble the
  // detector missed. All the caller has then is the point the user aimed at, and
  // the question that has to be answered before a fill is even worth starting is
  // "is this a balloon interior or is it art?" - because a fill seeded in art
  // runs away across the page and returns a confident fit to a panel gutter.
  //
  // A balloon interior is the one thing on a manga page that is a solid single
  // colour: near-uniform, and light. Art is not - screentone is periodic, hatching
  // is high contrast, a black panel is uniform but dark. So the probe is a small
  // square of pixels around the click, and it asks both questions.
  probeRadius: 6, // half-size of the sampled square, in pixels
  uniformTol: 20, // luma either side of the median that still reads as one colour
  uniformFrac: 0.92, // ...and the fraction of the sample that must be within it
  // ...and the median must be at least this light, so black is not "solid".
  //
  // The number has to agree with `minThreshold`, and for a long time it did not.
  // The fill's own definition of "interior" is `luma > threshold`, and the
  // threshold is never allowed below `minThreshold` - so anything at or under 64
  // can never be filled, and anything comfortably above it can. A probe gate at
  // 140 was a second, stricter opinion about the same question, and the two
  // disagreed exactly on coloured balloons: a saturated red or blue interior
  // measures 127 by `lumaOf` below, which the fill is happy to flood and the
  // probe used to refuse - so a click on it fell back, while the identical
  // bubble, if the detector had found the text inside it, fitted perfectly.
  //
  // So the gate is the fill's floor plus a margin for scan grain, and no more.
  // What keeps a click on a dark flat from being fitted is not this number - it
  // is the floor itself (a black panel is under it), the uniformity half of the
  // probe (art is not one colour), `minPointArea`, and the escape flag, all of
  // which are still in front of every answer this module gives.
  minInteriorLuma: 80,
  // How far from the click the fill may look, as a half-extent. Unlike the
  // block-seeded window there is no detected rectangle to scale against, so the
  // absolute number carries more weight here - and, for the reason spelled out
  // at `windowMaxFrac`, it is a floor rather than a cap: a splash-page or
  // webtoon-scale balloon is bigger in pixels than one on a paperback page, and
  // a window that ends inside it reads as a leak.
  pointWindow: 360,
  pointWindowFrac: 0.25,
  // A region smaller than this is not a balloon: it is the gap between two
  // strokes, a highlight in an eye, the counter of a glyph. The block-seeded fill
  // gets to scale its floor off the text it found; this one cannot, so it is a
  // flat area in square pixels.
  minPointArea: 400,

  // ---- layout ----
  // The safety inset, so text does not touch the outline. Deliberately the same
  // rule `placementRect` in store.svelte.js already applies (`BUBBLE_INSET` and
  // its two bounds): a fraction of the shape's shorter side, floored so it is
  // never invisible and capped so it never dominates a small bubble. Sharing the
  // rule is what makes a narration box come out of this module the way it comes
  // out of placement today.
  insetFrac: 0.08,
  insetMin: 3,
  insetMax: 14,
  minLineWidth: 1, // a line is never handed back a width of zero, which no breaker can divide by
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// Two decimals is a hair under a tenth of a pixel, which is finer than anything
// the user can see and coarse enough that the same page fitted twice writes the
// same `chapter.json`. A shape that jittered in the last float digit would show
// up as a diff on every save.
const r2 = (v) => Math.round(v * 100) / 100;

// ---------- luminance and the threshold ----------

// How light a pixel is, in integers, for the one purpose this module has: is
// this paper the fill may cross, or is it ink that stops it? Most pages are
// scans of black on white - greyscale in all but the file header - and on those
// every sane definition agrees, which is why the obvious one went unquestioned.
//
// Colour is where it stops being obvious. Rec. 601 luma weights green at 150/256
// and blue at 29/256 because that is how bright the eye finds them, so a
// saturated red balloon reads 76 and a saturated blue one 29 - darker than the
// 64 floor under the fill's own threshold, which is to say: ink. A red shout
// bubble and a blue night-sky balloon are perfectly ordinary things for a page
// to contain, and reporting their interiors as ink loses them both.
//
// So the answer is the LIGHTER of two readings, which is the same number on any
// grey pixel and disagrees only where the colour is saturated:
//
//   Rec. 601 luma   how bright the pixel looks. Yellow is bright, and this is
//                   the reading that knows it (225, against 127 the other way).
//   HSL lightness   `(max + min) / 2` - how far the colour is from black,
//                   independent of hue. Saturated red and saturated blue are
//                   both 127 here: mid-tones, plainly not ink.
//
// Taking the max of the two keeps every dark colour dark - a navy panel is 60,
// a black one 0 - so the gates that exist to refuse a solid dark region still
// refuse it. What changes is only the hue that a luma weighting would have
// buried.
//
// Alpha multiplies the result, which composites the pixel over black. A page
// with alpha is a PSD-derived raster whose transparent parts are outside the art
// entirely, and "outside the art" is somewhere a balloon fill must stop, not
// somewhere it may spread through - so a fully transparent pixel is ink, and a
// half-transparent one is half of whatever it would have been. Treating
// everything above alpha 128 as fully opaque, which is what this used to do,
// let a semi-transparent overlay - a screen-toned gradient, a lightened panel -
// count as solid paper at its full colour and bias the threshold with it.
const lumaOf = (data, i) => {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const a = data[i + 3];
  const y = (r * 77 + g * 150 + b * 29) >> 8;
  const l = ((r > g ? (r > b ? r : b) : g > b ? g : b) + (r < g ? (r < b ? r : b) : g < b ? g : b)) >> 1;
  const v = y > l ? y : l;
  return a === 255 ? v : ((v * a) / 255) | 0;
};

// Otsu's method: the threshold that maximises the variance *between* the two
// classes it splits the histogram into. That is the whole story behind the
// number - it is not a constant someone tuned on three pages, it is the split
// this window's own pixels are most cleanly separable at, so a grey newsprint
// scan and a crisp digital release each get their own.
//
// It is the right tool because the input really is bimodal: paper and ink, with
// an antialiased ramp between them that Otsu lands in the middle of. Pixels on
// that ramp then read as dark, which is what makes the fill stop *at* the
// outline instead of eating half of it.
//
// The bounds in `BALLOON_DEFAULTS` are the answer to Otsu's one failure mode: a
// window containing only paper (a balloon far larger than the search window, a
// blank margin) has no two classes to separate, so the method dutifully splits
// paper noise and returns something like 250 - at which point most of the paper
// counts as ink and the fill fragments on nothing. Capping at 224 says a pixel
// that is plainly paper is always interior; flooring at 64 says a pixel that is
// plainly ink never is. Between the two the histogram decides.
export function interiorThreshold(hist, total, opts = {}) {
  const o = { ...BALLOON_DEFAULTS, ...opts };
  if (!total) return o.maxThreshold;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    // The middle of the plateau, not its first step. A histogram with a clean
    // empty valley between ink and paper - which is what a digital release or a
    // synthetic fixture has - scores identically at every level in that valley,
    // and taking the first one puts the cut hard against the ink where the
    // antialiased edge of every stroke reads as paper. The midpoint is the
    // furthest the cut can be from both classes, which is the whole idea.
    if (between > best) {
      best = between;
      lo = i;
      hi = i;
    } else if (between === best) {
      hi = i;
    }
  }
  return clamp((lo + hi) >> 1, o.minThreshold, o.maxThreshold);
}

// ---------- the flood fill ----------

// The detected block, as integer half-open bounds clipped to the image. Accepts
// the detector's own `[x1,y1,x2,y2]` in either winding, because a rect that
// arrives with its corners swapped is a rect, not an error.
function blockBounds(block, W, H) {
  if (!Array.isArray(block) || block.length !== 4) return null;
  const [a, b, c, d] = block.map(Number);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  const x1 = clamp(Math.floor(Math.min(a, c)), 0, W);
  const y1 = clamp(Math.floor(Math.min(b, d)), 0, H);
  const x2 = clamp(Math.ceil(Math.max(a, c)), 0, W);
  const y2 = clamp(Math.ceil(Math.max(b, d)), 0, H);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

// A window bound in pixels, floored by the same bound as a fraction of the
// page's shorter side. See `windowMaxFrac`: the absolute number is right for a
// paperback-scale page and too small for anything drawn bigger, and a window
// that ends inside the balloon reads as a leak rather than as a balloon.
const windowCap = (px, frac, W, H) => Math.max(px, Math.round(frac * Math.min(W, H)));

// Walk outward from a point until a light pixel turns up, and return where. This
// is the answer to the seed problem, and the seed problem is the one that
// decides whether any of the rest works.
//
// The obvious seed - the centre of the detected block - is the worst possible
// one: the block is drawn tight around the Japanese, so its centre is *on* a
// glyph, and a glyph is ink. Seeding there fills nothing. Seeding into the white
// between two strokes is barely better, because a counter (the enclosed white of
// 口, 田, 回) is a pocket of paper with no way out, and the fill would return a
// dozen pixels and call it a balloon.
//
// So every candidate is a direction rather than a point: start on or just past
// an edge of the block and walk away from the text until the first light pixel.
// Walking outward from inside is what makes the answer safe - the first light
// pixel found while leaving the glyphs is balloon paper, because the balloon
// wall has not been crossed yet and the wall is dark.
function probeLight(light, ww, wh, x, y, dx, dy) {
  let cx = x;
  let cy = y;
  for (let step = 0; step <= ww + wh; step++) {
    if (cx < 0 || cy < 0 || cx >= ww || cy >= wh) return -1;
    const i = cy * ww + cx;
    if (light[i]) return i;
    if (dx === 0 && dy === 0) return -1;
    cx += dx;
    cy += dy;
  }
  return -1;
}

// Scanline flood fill, 4-connected, writing `tag` into `label`. Iterative and
// span-based rather than per-pixel recursive: a balloon interior is tens of
// thousands of pixels and a per-pixel stack on that is both slow and a real
// overflow risk in a renderer process.
//
// Which of the window's four borders the fill landed on is reported rather than
// a single flag, because the caller knows something this function does not:
// whether a given border is the edge of the SEARCH or the edge of the PAGE. See
// `escapedFrom` in `runFill` - a fill that reached the edge of its search was
// never bounded by an outline and is not a balloon's interior, while one that
// reached the edge of the paper is simply a balloon the page is cut off at.
function spanFill(light, label, tag, ww, wh, seed) {
  const stack = [seed];
  let count = 0;
  let minX = ww;
  let maxX = -1;
  let minY = wh;
  let maxY = -1;
  let hitT = false;
  let hitB = false;
  let hitL = false;
  let hitR = false;
  while (stack.length) {
    const p = stack.pop();
    if (label[p] !== 0 || !light[p]) continue;
    const y = (p / ww) | 0;
    const base = y * ww;
    const x = p - base;
    let l = x;
    while (l > 0 && light[base + l - 1] && label[base + l - 1] === 0) l--;
    let r = x;
    while (r < ww - 1 && light[base + r + 1] && label[base + r + 1] === 0) r++;
    for (let i = l; i <= r; i++) label[base + i] = tag;
    count += r - l + 1;
    if (l < minX) minX = l;
    if (r > maxX) maxX = r;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (y === 0) hitT = true;
    if (y === wh - 1) hitB = true;
    if (l === 0) hitL = true;
    if (r === ww - 1) hitR = true;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= wh) continue;
      const nb = ny * ww;
      let i = l;
      while (i <= r) {
        while (i <= r && (!light[nb + i] || label[nb + i] !== 0)) i++;
        if (i > r) break;
        let j = i;
        while (j <= r && light[nb + j] && label[nb + j] === 0) j++;
        stack.push(nb + j - 1);
        i = j;
      }
    }
  }
  return { count, hitT, hitB, hitL, hitR, minX, maxX, minY, maxY };
}

// Everything dark that the interior encloses is part of the interior. The
// Japanese glyphs are the reason: they sit in the middle of the balloon, the
// fill flows around them, and a profile taken through them would report the
// widest *gap between glyphs* as the balloon's width - a number some tens of
// percent too small, and lopsided at that, which is exactly the sort of quiet
// wrongness that produces a confident fit to the wrong ellipse.
//
// The classic hole fill answers it: flood the non-interior pixels inward from
// the window border, and anything non-interior the border could not reach is
// enclosed, so it becomes interior. The balloon's own outline is connected to
// the outside and survives; the glyphs, the tone dots inside a thought cloud and
// the counter of every 口 do not.
function fillEnclosed(mask, ww, wh) {
  const outside = new Uint8Array(ww * wh);
  const stack = [];
  for (let x = 0; x < ww; x++) {
    stack.push(x, (wh - 1) * ww + x);
  }
  for (let y = 0; y < wh; y++) {
    stack.push(y * ww, y * ww + ww - 1);
  }
  while (stack.length) {
    const p = stack.pop();
    if (mask[p] || outside[p]) continue;
    const y = (p / ww) | 0;
    const base = y * ww;
    const x = p - base;
    let l = x;
    while (l > 0 && !mask[base + l - 1] && !outside[base + l - 1]) l--;
    let r = x;
    while (r < ww - 1 && !mask[base + r + 1] && !outside[base + r + 1]) r++;
    for (let i = l; i <= r; i++) outside[base + i] = 1;
    // One seed per contiguous eligible RUN in the neighbouring row, exactly as
    // `spanFill` does it, and for a reason that is about memory rather than
    // elegance. Pushing every pixel of the run instead makes the stack O(area),
    // and the area here is the whole window minus the region - on a click at
    // webtoon scale (`pointWindowFrac` of a 3000px page is a 1500px half-extent,
    // so a nine-megapixel window) that was a JS array of several million
    // numbers, tens of megabytes, built and thrown away inside a single click
    // handler. The seeds are redundant either way: whichever pixel of a run is
    // popped, the loop above expands over the entire run.
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= wh) continue;
      const nb = ny * ww;
      let i = l;
      while (i <= r) {
        while (i <= r && (mask[nb + i] || outside[nb + i])) i++;
        if (i > r) break;
        let j = i;
        while (j <= r && !mask[nb + j] && !outside[nb + j]) j++;
        stack.push(nb + j - 1);
        i = j;
      }
    }
  }
  let added = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && !outside[i]) {
      mask[i] = 1;
      added++;
    }
  }
  return added;
}

// The one function here that reads pixels.
//
//   `image`  anything `ImageData`-shaped: `{ width, height, data }` with `data`
//            an RGBA byte array. Tests build one by hand; the app hands over a
//            real `ImageData` from a canvas it already has.
//   `block`  the detector's text block, `[x1,y1,x2,y2]` in page coordinates -
//            the same rect `detectedRectFor` returns.
//
// Returns the filled region, or null when there is nothing worth calling one -
// no pixels, no block, or nothing bigger than the text the seed started from:
//
//   { x, y, w, h,   the search window in page coordinates; `mask` is indexed
//                   over it, row-major, one byte per pixel
//     mask,         Uint8Array, 1 = interior
//     bounds,       tight { x, y, w, h } of the filled pixels, page coordinates
//     count,        interior pixel count
//     escaped,      the fill reached the window border - see `spanFill`
//     threshold,    the luminance cut Otsu chose for this window
//     seed }        the candidate the winning fill started from, page coordinates
//
// Several seeds are tried and the best fill wins - big enough to be a balloon
// first, bounded by an outline second, largest third. The seeds share one label
// buffer, so a candidate that lands in a region an earlier seed already filled
// costs a single array read rather than a second traversal, and the whole sweep
// is O(window) no matter how many candidates there are.
export function fillInterior(image, block, opts = {}) {
  const o = { ...BALLOON_DEFAULTS, ...opts };
  const W = image ? image.width | 0 : 0;
  const H = image ? image.height | 0 : 0;
  const data = image ? image.data : null;
  if (!W || !H || !data || data.length < W * H * 4) return null;
  const b = blockBounds(block, W, H);
  if (!b) return null;

  const bw = b.x2 - b.x1;
  const bh = b.y2 - b.y1;
  const pad = clamp(
    Math.round(o.windowMargin * Math.max(bw, bh)),
    o.windowMin,
    windowCap(o.windowMax, o.windowMaxFrac, W, H),
  );
  const wx = clamp(b.x1 - pad, 0, W);
  const wy = clamp(b.y1 - pad, 0, H);
  const ww = clamp(b.x2 + pad, 0, W) - wx;
  const wh = clamp(b.y2 + pad, 0, H) - wy;
  if (ww <= 0 || wh <= 0) return null;

  // Candidates, in page coordinates, each a start point and a direction to walk.
  // Three fractions down each side rather than the midpoint alone, because the
  // midpoint of a vertical column can be blocked by a neighbouring column, a
  // tail crossing the gap, or an ん that happens to reach the wall.
  const cx = (b.x1 + b.x2) >> 1;
  const cy = (b.y1 + b.y2) >> 1;
  const cands = [[cx, cy, 0, 0]];
  for (const f of [0.5, 0.25, 0.75]) {
    const yy = Math.round(b.y1 + f * bh);
    const xx = Math.round(b.x1 + f * bw);
    cands.push([b.x1, yy, -1, 0], [b.x2 - 1, yy, 1, 0], [xx, b.y1, 0, -1], [xx, b.y2 - 1, 0, 1]);
  }
  cands.push([cx, cy, -1, 0], [cx, cy, 1, 0], [cx, cy, 0, -1], [cx, cy, 0, 1]);

  return runFill(image, { x: wx, y: wy, w: ww, h: wh }, cands, bw * bh * o.minInteriorFrac, o);
}

// The same fill, seeded by a POINT instead of a block - the paste-mode click.
//
// Three things differ, and all three follow from having no detected rectangle:
//
//   the window   is a half-extent taken from the page (`pointWindow`, floored by
//                `pointWindowFrac` of the page's shorter side) rather than a
//                multiple of the block's longer side. There is no block to take
//                a multiple of.
//   the floor    is an absolute area (`minPointArea`) rather than a fraction of
//                the block's own area, for the same reason.
//   the seeds    are the click itself first - the user pointed at the interior,
//                so the interior is where the pointer is - and four short walks
//                outward after it, which recover the case where the click landed
//                on something dark inside the balloon (a glyph the clean missed,
//                a stray dot) and the pixel under the pointer is therefore ink.
//   the cut      knows one thing Otsu cannot: what the interior IS. See the note
//                on `interiorLuma` in `runFill` - the pointer is inside the
//                balloon by construction, so a threshold that puts the pixel
//                under it on the ink side of the line has cut in the wrong place
//                and the fill would measure something the user did not point at.
//
// Everything else - the span fill, hole filling, the escape flag - is the
// block-seeded path's machinery unchanged, which is the point: a fit recovered
// from a click and a fit recovered from a detection are the same measurement of
// the same balloon, and the caller cannot tell them apart afterwards.
export function fillFromPoint(image, x, y, opts = {}) {
  const o = { ...BALLOON_DEFAULTS, ...opts };
  const W = image ? image.width | 0 : 0;
  const H = image ? image.height | 0 : 0;
  const data = image ? image.data : null;
  if (!W || !H || !data || data.length < W * H * 4) return null;
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  if (px < 0 || py < 0 || px >= W || py >= H) return null;

  const half = Math.max(
    o.windowMin,
    windowCap(Math.round(o.pointWindow), o.pointWindowFrac, W, H),
  );
  const wx = clamp(px - half, 0, W);
  const wy = clamp(py - half, 0, H);
  const ww = clamp(px + half + 1, 0, W) - wx;
  const wh = clamp(py + half + 1, 0, H) - wy;
  if (ww <= 0 || wh <= 0) return null;

  const cands = [
    [px, py, 0, 0],
    [px, py, -1, 0],
    [px, py, 1, 0],
    [px, py, 0, -1],
    [px, py, 0, 1],
  ];
  // The median of the sample around the click, not the single pixel under it: a
  // speck of dust in the scan or the corner of a glyph the clean missed would
  // otherwise define the interior as ink and defeat the whole point of the hint.
  // `localUniformity` is the same sample the caller's own solid-colour test
  // takes, so the two cannot form different opinions about what was clicked.
  const probe = localUniformity(image, px, py, o);
  return runFill(
    image,
    { x: wx, y: wy, w: ww, h: wh },
    cands,
    o.minPointArea,
    o,
    probe ? probe.median : null,
  );
}

// The shared half of both fills: a clipped window, a list of seed candidates in
// page coordinates and the area a region has to reach to count. Split out so the
// block-seeded and point-seeded entry points cannot drift into two different
// answers about the same pixels - the only thing either of them decides is where
// to look, how big is big enough, and (only the click) what the interior is.
//
// `interiorLuma` is that last one: a luminance the CALLER knows belongs to the
// interior, or null when it does not know. See the note on the cut below.
function runFill(image, win, cands, minArea, o, interiorLuma = null) {
  const W = image.width | 0;
  const H = image.height | 0;
  const data = image.data;
  const { x: wx, y: wy, w: ww, h: wh } = win;

  // Which of the window's borders exist because the SEARCH stops there, and
  // which because the PAGE does. The two are not the same failure and were being
  // read as one: the window is clipped to the image, so a balloon anywhere near
  // the edge of the page - a panel that bleeds off it, the top bubble of a
  // webtoon slice, anything on a page cropped tight - has the clamped border
  // sitting exactly on the page border, its interior touches it, and `escaped`
  // was set for a fill that never leaked anywhere. Every such balloon fell back.
  //
  // A page border is not a leak: there is nothing beyond it to leak into, and a
  // bubble the paper is cut off at is still a bubble. So a fill that reaches one
  // is allowed - with one exception, which is what keeps the whole page from
  // qualifying on a page smaller than the window. Reaching the page edge on two
  // OPPOSITE sides means the region spans the paper from edge to edge, and that
  // is not a balloon that happens to be cropped, it is the paper itself: a click
  // on bare white with the art nowhere near it, which is precisely the case the
  // escape flag exists to catch and which a small test page or a narrow strip
  // would otherwise sail through.
  const edgeT = wy === 0;
  const edgeB = wy + wh === H;
  const edgeL = wx === 0;
  const edgeR = wx + ww === W;
  const escapedFrom = (r) =>
    (r.hitT && !edgeT) ||
    (r.hitB && !edgeB) ||
    (r.hitL && !edgeL) ||
    (r.hitR && !edgeR) ||
    (r.hitT && r.hitB) ||
    (r.hitL && r.hitR);

  const hist = new Uint32Array(256);
  const lum = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    let si = ((wy + y) * W + wx) * 4;
    let di = y * ww;
    for (let x = 0; x < ww; x++, si += 4, di++) {
      const v = lumaOf(data, si);
      lum[di] = v;
      hist[v]++;
    }
  }
  // Otsu, and then the one correction Otsu cannot make for itself.
  //
  // The method splits the window into the two classes it is most separable
  // into, which on a scan is exactly right - ink and paper, nothing else in the
  // frame. A COLOURED balloon breaks that assumption, and breaks it quietly. A
  // red shout bubble on white paper gives the histogram three modes, not two:
  // black outline, red interior, white page. The most separable split of three
  // modes puts the two darker ones together, so the balloon's own interior ends
  // up on the ink side of the line, the seed walk leaves the bubble looking for
  // a light pixel, finds the page outside it, and the fill measures the paper
  // AROUND the balloon the user clicked in. It escapes, the caller falls back,
  // and every coloured balloon in the chapter is unfittable - not because the
  // shape is hard but because the threshold was answering a different question.
  //
  // The click knows the answer to that question. The user pointed INSIDE the
  // balloon, so the luminance there is interior by construction, and a cut above
  // it is a cut in the wrong place whatever the histogram says. Lowering it to
  // just under that value keeps the outline dark (the floor is still respected,
  // and the probe gate in front of this refuses anything close enough to the
  // floor to matter) while making the interior light, which is all the fill
  // needs: the paper outside the balloon may now be light as well, and it does
  // not matter in the least, because the outline still separates the two and the
  // fill is 4-connected.
  //
  // Only ever downward, and only when the histogram was about to exclude the
  // click. On every greyscale page - which is most of them - the two agree and
  // this changes nothing.
  const otsu = interiorThreshold(hist, ww * wh, o);
  const threshold =
    interiorLuma != null && interiorLuma > o.minThreshold && interiorLuma <= otsu
      ? interiorLuma - 1
      : otsu;
  const light = new Uint8Array(ww * wh);
  for (let i = 0; i < light.length; i++) light[i] = lum[i] > threshold ? 1 : 0;

  // Two questions about a candidate, in this order.
  //
  //   viable    is it big enough to be the balloon around this text at all? A
  //             seed that ends up inside the counter of a 口 fills a couple of
  //             hundred pixels and, left to rank on "did not escape", would beat
  //             the real interior and be fitted - confidently - to a 12px box.
  //             That is worse than no answer, so a region below the floor is not
  //             a candidate at all and a page with no viable region returns null.
  //   escaped   did an outline bound it? Only ever asked of viable regions,
  //             which is why a leak is reported instead of being quietly
  //             replaced by whatever pocket happened to stay inside.
  const rank = (c) => (c.count >= minArea ? 2 : 0) + (c.escaped ? 0 : 1);
  const label = new Uint8Array(ww * wh);
  let tag = 0;
  let best = null;
  for (const [sx, sy, dx, dy] of cands) {
    // The label buffer is a byte, so there are 255 distinct tags to hand out.
    // Both entry points pass under twenty candidates, so this is a bound on the
    // data structure rather than a path anything takes - but it has to be
    // checked BEFORE the tag is taken, not after the fill, or a caller past the
    // limit would give two regions the same tag and the mask would be the union
    // of both.
    if (tag >= 255) break;
    const seed = probeLight(light, ww, wh, sx - wx, sy - wy, dx, dy);
    if (seed < 0 || label[seed] !== 0) continue;
    tag++;
    const res = spanFill(light, label, tag, ww, wh, seed);
    if (!res.count) continue;
    const cand = { tag, seed, ...res, escaped: escapedFrom(res) };
    const better =
      !best || rank(cand) > rank(best) || (rank(cand) === rank(best) && cand.count > best.count);
    if (better) best = cand;
  }
  if (!best || best.count < minArea) return null;

  const mask = new Uint8Array(ww * wh);
  for (let i = 0; i < mask.length; i++) mask[i] = label[i] === best.tag ? 1 : 0;
  // Never on a fill that got out. "Enclosed" is defined by what the window's
  // border can reach, and an escaped region can hold the entire border - at
  // which point nothing is outside, every remaining pixel counts as a hole, and
  // the mask becomes the whole window. The caller is going to fall back anyway,
  // so the honest thing to hand back is the region that actually leaked.
  if (o.fillHoles && !best.escaped) fillEnclosed(mask, ww, wh);

  // The bounds are recomputed rather than carried over from the fill, because
  // hole filling can only have grown the region and a stale box would clip the
  // profile at exactly the rows the glyphs sat on.
  let minX = ww;
  let maxX = -1;
  let minY = wh;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < wh; y++) {
    const base = y * ww;
    for (let x = 0; x < ww; x++) {
      if (!mask[base + x]) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    x: wx,
    y: wy,
    w: ww,
    h: wh,
    mask,
    count,
    escaped: best.escaped,
    threshold,
    seed: { x: wx + (best.seed % ww), y: wy + ((best.seed / ww) | 0) },
    bounds: { x: wx + minX, y: wy + minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

// ---------- the interior profile ----------

// The filled region, reduced to one number pair per row: the widest contiguous
// run of interior pixels, as `[left, right]` inclusive in page coordinates. That
// is all the shape fitting needs, and it is a couple of hundred numbers rather
// than a megabyte of mask.
//
// Widest *contiguous* run, not leftmost-to-rightmost, because the two differ
// exactly where it matters. A row crossing a tail picks up the tail as a second
// run; leftmost-to-rightmost would bridge the gap and report the balloon as
// wider than it is, and text laid out to that width would run off the side of
// the bubble. The widest run is the one the text can actually sit in.
//
// A row inside the region's vertical extent with no run at all is a hole. It
// cannot happen to a single 4-connected fill - reaching row n+1 from row n
// requires a pixel in both - so it means the mask came from somewhere else: a
// union of fills, a hand-built fixture, a future caller. It is counted rather
// than silently skipped, and the classifier refuses a profile with too many of
// them, because a region that is not vertically connected is not one balloon.
//
// Returns `{ y, rows, holes, escaped }` where `rows[i]` describes page row
// `y + i` and is `null` for a hole.
export function interiorProfile(region) {
  const empty = { y: 0, rows: [], holes: 0, escaped: true };
  if (!region || !region.mask) return empty;
  const { x, y, w, h, mask } = region;
  const scan = [];
  let first = -1;
  let last = -1;
  for (let ry = 0; ry < h; ry++) {
    const base = ry * w;
    let bestL = -1;
    let bestR = -1;
    let bestLen = 0;
    let i = 0;
    while (i < w) {
      if (!mask[base + i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < w && mask[base + j]) j++;
      if (j - i > bestLen) {
        bestLen = j - i;
        bestL = i;
        bestR = j - 1;
      }
      i = j;
    }
    scan.push(bestLen ? [x + bestL, x + bestR] : null);
    if (bestLen) {
      if (first < 0) first = ry;
      last = ry;
    }
  }
  if (first < 0) return { ...empty, y, escaped: !!region.escaped };
  const rows = scan.slice(first, last + 1);
  let holes = 0;
  for (const r of rows) if (!r) holes++;
  return { y: y + first, rows, holes, escaped: !!region.escaped };
}

// ---------- classify and fit ----------

const quantile = (sorted, q) => sorted[clamp(Math.round(q * (sorted.length - 1)), 0, sorted.length - 1)];
const sortedCopy = (arr) => [...arr].sort((a, b) => a - b);

// Rows, as continuous geometry. A run `[l, r]` of whole pixels covers `[l, r+1)`
// and row `i` covers `[y+i, y+i+1)`, so the row's own centre line is at
// `y + i + 0.5` and its right edge is at `r + 1`. Getting this half-pixel
// convention right is what keeps a fitted ellipse from coming back systematically
// half a pixel small on every axis.
function rowPoints(profile) {
  const pts = [];
  for (let i = 0; i < profile.rows.length; i++) {
    const r = profile.rows[i];
    if (!r) continue;
    const l = r[0];
    const rr = r[1] + 1;
    if (!(rr > l)) continue;
    pts.push({ y: profile.y + i + 0.5, l, r: rr, c: (l + rr) / 2, hw: (rr - l) / 2 });
  }
  return pts;
}

// One scoring rule for both shapes, so a rectangle and an ellipse can be
// compared at all: per row, the mean of the two edge misses, divided by the
// shape's half-width. Normalising by the *shape's* half-width rather than the
// row's is deliberate - near the top of an ellipse the local half-width goes to
// zero, and a per-row normalisation would turn a one-pixel rasterisation
// difference there into an error of 1.0 and reject every oval ever drawn.
//
//   residual  RMS of that error over the inliers. What "does this shape describe
//             these rows" means, in one number.
//   coverage  the fraction of rows *inside the fitted shape's vertical span*
//             that are inliers. A jagged SFX burst fails here.
//   spanFrac  the fraction of all rows that lie inside the span at all. An
//             ellipse fitted to a third of a region is not a fit, it is a
//             coincidence.
//   tailMax   the widest row outside the span, relative to the half-width. A
//             balloon's tail is a narrow spike hanging off the body and is meant
//             to be tolerated; a wide slab outside the fitted body means the
//             fitted body was the wrong body.
function evaluate(shape, pts, o) {
  const half = shape.kind === 'ellipse' ? shape.rx : shape.w / 2;
  if (!(half > 0)) return { residual: Infinity, coverage: 0, spanFrac: 0, tailMax: Infinity, inliers: [] };
  const inliers = [];
  let sum = 0;
  let span = 0;
  let tailMax = 0;
  for (const p of pts) {
    let pl;
    let pr;
    let inside;
    if (shape.kind === 'ellipse') {
      // Half a row of slack, so the extreme row of a rasterised ellipse - whose
      // centre line sits a hair outside the true curve - is still part of the
      // body rather than being mistaken for a tail.
      inside = Math.abs(p.y - shape.cy) <= shape.ry + 0.5;
      const dy = clamp((p.y - shape.cy) / shape.ry, -1, 1);
      const hw = shape.rx * Math.sqrt(Math.max(0, 1 - dy * dy));
      pl = shape.cx - hw;
      pr = shape.cx + hw;
    } else {
      inside = p.y >= shape.y - 0.5 && p.y <= shape.y + shape.h + 0.5;
      pl = shape.x;
      pr = shape.x + shape.w;
    }
    if (!inside) {
      tailMax = Math.max(tailMax, p.hw / half);
      continue;
    }
    span++;
    const err = (Math.abs(p.l - pl) + Math.abs(p.r - pr)) / 2 / half;
    if (err <= o.trimTol) {
      inliers.push(p);
      sum += err * err;
    }
  }
  const residual = inliers.length ? Math.sqrt(sum / inliers.length) : Infinity;
  return {
    residual,
    coverage: span ? inliers.length / span : 0,
    spanFrac: pts.length ? span / pts.length : 0,
    tailMax,
    inliers,
  };
}

// An unexplained row costs the same as an equal fraction of edge error. One
// line, and it is the only place the two signals trade against each other.
const meritOf = (e) => e.residual + (1 - e.coverage);

const accepted = (e, o) =>
  e.residual <= o.maxResidual &&
  e.coverage >= o.minCoverage &&
  e.spanFrac >= o.minSpan &&
  e.tailMax <= o.maxTailWidth;

// A rectangle, from the medians. The gate in front of it is what actually
// classifies: a narration box has row widths within a few percent of each other
// and row centres that do not move, and nothing else does. Quantiles rather than
// the extremes, so a rounded corner or a stray row of tone does not disqualify a
// box that is plainly a box.
function fitRect(pts, o) {
  const widths = sortedCopy(pts.map((p) => p.r - p.l));
  const centres = sortedCopy(pts.map((p) => p.c));
  const medW = quantile(widths, 0.5);
  const q10 = quantile(widths, 0.1);
  const q90 = quantile(widths, 0.9);
  const gate =
    q90 > 0 &&
    q10 / q90 >= 1 - o.rectTol &&
    quantile(centres, 0.9) - quantile(centres, 0.1) <= o.rectTol * medW;
  if (!(medW > 0)) return null;
  const build = (ps) => {
    const w = quantile(sortedCopy(ps.map((p) => p.r - p.l)), 0.5);
    const c = quantile(sortedCopy(ps.map((p) => p.c)), 0.5);
    // Vertical extents are derived from the inlier set ps so outlier rows
    // (e.g. from panel borders) are trimmed from the refit rectangle height and origin.
    const py0 = ps[0].y - 0.5;
    const py1 = ps[ps.length - 1].y + 0.5;
    return { kind: 'rect', x: c - w / 2, y: py0, w, h: py1 - py0 };
  };
  let shape = build(pts);
  let ev = evaluate(shape, pts, o);
  // One refit on the inliers. A box whose bottom two rows caught the edge of a
  // panel border should be fitted to the box, not to the accident.
  if (ev.inliers.length >= o.minRows && ev.inliers.length < pts.length) {
    const alt = build(ev.inliers);
    const altEv = evaluate(alt, pts, o);
    if (meritOf(altEv) < meritOf(ev)) {
      shape = alt;
      ev = altEv;
    }
  }
  return { shape, ev, gate, merit: meritOf(ev) };
}

// Least squares on the row half-widths, in the one parameterisation where the
// problem is linear. For an ellipse
//
//   hw(y)² = rx² − (rx²/ry²)·(y − cy)²
//
// which in `u = y − y0` is `A + B·u + C·u²` - three unknowns, one 3×3 normal
// system, no iteration and no starting guess. Recovering the ellipse from the
// coefficients needs `C < 0`, which is precisely the statement that the profile
// is widest somewhere in the middle rather than at an end.
//
// The catch is that regressing on hw² weights the wide rows far more heavily
// than the narrow ones. That is usually a virtue - the rows near the top of a
// balloon are the ones a tail or a rasterisation stair-step distorts - but it
// does mean the fit can drift on a short profile, which is why it is only ever a
// candidate here and never the answer on its own.
function lsEllipse(pts) {
  if (pts.length < 5) return null;
  const y0 = (pts[0].y + pts[pts.length - 1].y) / 2;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (const p of pts) {
    const u = p.y - y0;
    const u2 = u * u;
    const z = p.hw * p.hw;
    s0 += 1;
    s1 += u;
    s2 += u2;
    s3 += u2 * u;
    s4 += u2 * u2;
    t0 += z;
    t1 += z * u;
    t2 += z * u2;
  }
  // Cramer's rule on [[s0,s1,s2],[s1,s2,s3],[s2,s3,s4]] · [A,B,C] = [t0,t1,t2].
  const det =
    s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const dA = t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2);
  const dB = s0 * (t1 * s4 - s3 * t2) - t0 * (s1 * s4 - s3 * s2) + s2 * (s1 * t2 - t1 * s2);
  const dC = s0 * (s2 * t2 - t1 * s3) - s1 * (s1 * t2 - t1 * s2) + t0 * (s1 * s3 - s2 * s2);
  const A = dA / det;
  const B = dB / det;
  const C = dC / det;
  if (!(C < 0)) return null;
  const m = -B / (2 * C);
  const rx2 = A - C * m * m;
  if (!(rx2 > 0)) return null;
  const rx = Math.sqrt(rx2);
  const ry2 = rx2 / -C;
  if (!(ry2 > 0)) return null;
  const cx = quantile(sortedCopy(pts.map((p) => p.c)), 0.5);
  return { kind: 'ellipse', cx, cy: y0 + m, rx, ry: Math.sqrt(ry2) };
}

// The other candidate, and the one that is exact for a clean oval: the region's
// own vertical extent is the minor axis, its widest row is the major, and its
// median row centre is the centre. It is trivially right on a bubble and
// trivially wrong on a bubble with a tail, where the extent runs down the tail -
// which is the whole reason there are two candidates and a residual to choose
// between them.
function extentEllipse(pts) {
  const y0 = pts[0].y - 0.5;
  const y1 = pts[pts.length - 1].y + 0.5;
  let rx = 0;
  for (const p of pts) rx = Math.max(rx, p.hw);
  if (!(rx > 0) || !(y1 > y0)) return null;
  return {
    kind: 'ellipse',
    cx: quantile(sortedCopy(pts.map((p) => p.c)), 0.5),
    cy: (y0 + y1) / 2,
    rx,
    ry: (y1 - y0) / 2,
  };
}

// Both candidates, each refined by refitting on its own inliers, and the honest
// score decides. This mirrors the way `typeset.js` handles its hourglass rule:
// the aggressive search only ever *proposes* a candidate, and the plain
// comparison is what accepts one - so a refit that dodges the tail by making a
// mess of the body loses on its own merit.
function fitEllipse(pts, o) {
  let best = null;
  for (const seed of [extentEllipse(pts), lsEllipse(pts)]) {
    let shape = seed;
    for (let iter = 0; shape && iter < 3; iter++) {
      const ev = evaluate(shape, pts, o);
      const cand = { shape, ev, merit: meritOf(ev) };
      if (!best || cand.merit < best.merit) best = cand;
      if (ev.inliers.length === pts.length || ev.inliers.length < 5) break;
      shape = lsEllipse(ev.inliers);
    }
  }
  return best;
}

// Classify, fit, and say how much of it to believe.
//
// Returns a plain object every time - there is no throwing path and no null
// return, because "this is not a balloon" is an answer the caller has to handle
// anyway and it may as well arrive in the same shape as the others:
//
//   { kind,        'ellipse' | 'rect' | 'irregular'
//     shape,       the storable JSON, or null when `kind` is 'irregular'
//     confidence,  0..1
//     residual,    RMS edge error as a fraction of the half-width
//     coverage,    fraction of the fitted span's rows the fit explains
//     reason }     why an irregular verdict was reached
//
// A fill that escaped is refused before anything is fitted. It is worth being
// blunt about why: an escaped fill is not a bad measurement of a balloon, it is
// a good measurement of something else - the paper around the bubble, a whole
// panel, the gutter - and it will very often fit a beautiful rectangle. Fitting
// it and reporting a high confidence would be the single worst failure this
// module could have, because the caller's fallback would never fire.
export function fitBalloonShape(profile, opts = {}) {
  const o = { ...BALLOON_DEFAULTS, ...opts };
  const refuse = (reason, residual = Infinity, coverage = 0) => ({
    kind: 'irregular',
    shape: null,
    confidence: 0,
    residual,
    coverage,
    reason,
  });
  if (!profile || !Array.isArray(profile.rows) || profile.rows.length === 0) return refuse('empty');
  if (profile.escaped) return refuse('escaped');
  const n = profile.rows.length;
  if (n < o.minRows) return refuse('tiny');
  let holes = profile.holes;
  if (!Number.isFinite(holes)) {
    holes = 0;
    for (const r of profile.rows) if (!r) holes++;
  }
  if (holes > o.maxHoleFrac * n) return refuse('holes');
  const pts = rowPoints(profile);
  if (pts.length < o.minRows) return refuse('tiny');

  const finish = (cand) => {
    const s = cand.shape;
    const shape =
      s.kind === 'ellipse'
        ? { kind: 'ellipse', cx: r2(s.cx), cy: r2(s.cy), rx: r2(s.rx), ry: r2(s.ry) }
        : { kind: 'rect', x: r2(s.x), y: r2(s.y), w: r2(s.w), h: r2(s.h) };
    return {
      kind: shape.kind,
      shape,
      // Both signals, multiplied: a fit whose rows sit on the curve but which
      // only explains four fifths of them is not four fifths of a good fit.
      confidence: r2(clamp(1 - cand.ev.residual / o.maxResidual, 0, 1) * cand.ev.coverage),
      residual: r2(cand.ev.residual),
      coverage: r2(cand.ev.coverage),
      reason: 'fit',
    };
  };

  // The rectangle is tried first, and only behind its gate. An ellipse fitted to
  // a profile of constant width is degenerate - `C` goes to zero and the recovered
  // `ry` to infinity - so the shape whose rows do not vary must be claimed by the
  // shape that expects them not to.
  const rect = fitRect(pts, o);
  if (rect && rect.gate && accepted(rect.ev, o)) return finish(rect);
  const ell = fitEllipse(pts, o);
  if (ell && accepted(ell.ev, o)) return finish(ell);
  const best = [rect, ell].filter(Boolean).sort((a, b) => a.merit - b.merit)[0];
  return refuse(
    'irregular',
    best ? r2(best.ev.residual) : Infinity,
    best ? r2(best.ev.coverage) : 0
  );
}

// ---------- layout inside a fitted shape ----------

// The gap between the text and the outline. A fraction of the shape's shorter
// side so a small SFX label is not eaten by a margin sized for a splash page,
// bounded at both ends so it is never invisible and never dominant - and, by
// construction, the same numbers `placementRect` already uses, so a narration
// box laid out through this module gets the same inset it gets today.
export function safetyInset(shape, opts = {}) {
  const o = { ...BALLOON_DEFAULTS, ...opts };
  if (!shape) return o.insetMin;
  const short =
    shape.kind === 'ellipse' ? 2 * Math.min(shape.rx, shape.ry) : Math.min(shape.w, shape.h);
  return clamp(Math.round(short * o.insetFrac), o.insetMin, o.insetMax);
}

// The shape's bounding box, in page coordinates. Handy for the caller that has
// to turn a shape back into something the rest of the app understands.
export function shapeBounds(shape) {
  if (!shape) return null;
  if (shape.kind === 'ellipse') {
    return { x: shape.cx - shape.rx, y: shape.cy - shape.ry, w: 2 * shape.rx, h: 2 * shape.ry };
  }
  return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
}

// Is this page point inside the shape? The click-seeded fit needs it: a fill
// started at the pointer necessarily contains the pointer, but the SHAPE is an
// approximation of that region, and an approximation of a bubble the user
// clicked near the rim of can end up not covering the click at all. A box placed
// from such a fit lands somewhere the user did not point, which reads as the
// click having been ignored - so the caller checks and falls back instead.
export function shapeContainsPoint(shape, x, y) {
  if (!shape || !Number.isFinite(+x) || !Number.isFinite(+y)) return false;
  if (shape.kind === 'ellipse') {
    if (!(shape.rx > 0) || !(shape.ry > 0)) return false;
    const dx = (x - shape.cx) / shape.rx;
    const dy = (y - shape.cy) / shape.ry;
    return dx * dx + dy * dy <= 1;
  }
  return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
}

// The shape, inset by the safety margin. Shrinking an ellipse by subtracting the
// inset from each semi-axis is not a true offset curve, but it gives exactly the
// inset of clearance at the four extreme points and slightly more in between,
// which errs the safe way, and it keeps the result an ellipse - which every
// other function here needs it to be.
function insetShape(shape, o) {
  const inset = Number.isFinite(o.inset) ? o.inset : safetyInset(shape, o);
  if (shape.kind === 'ellipse') {
    return {
      kind: 'ellipse',
      cx: shape.cx,
      cy: shape.cy,
      rx: Math.max(0, shape.rx - inset),
      ry: Math.max(0, shape.ry - inset),
    };
  }
  return {
    kind: 'rect',
    x: shape.x + inset,
    y: shape.y + inset,
    w: Math.max(0, shape.w - 2 * inset),
    h: Math.max(0, shape.h - 2 * inset),
  };
}

// The largest rectangle that fits inside the shape - what placement should size
// the text box to.
//
// For an ellipse of semi-axes a and b the answer is a√2 × b√2: about 70.7% of
// the bounding box on each axis, with the rectangle's corners sitting exactly on
// the curve. That is the number the current code is missing. Insetting the
// detector's rect by 8% of its shorter side, capped at 14px, leaves a rectangle
// at something like 95% of the bounding box - nearly a third wider than an oval
// can actually hold - and the corners of that rectangle are outside the balloon.
export function inscribedRect(shape, opts = {}) {
  if (!shape) return null;
  const o = { ...BALLOON_DEFAULTS, ...opts };
  const s = insetShape(shape, o);
  if (s.kind === 'rect') return { x: s.x, y: s.y, w: s.w, h: s.h };
  const w = s.rx * Math.SQRT2;
  const h = s.ry * Math.SQRT2;
  return { x: s.cx - w / 2, y: s.cy - h / 2, w, h };
}

// The text box a fitted shape is placed at: as wide as the inset shape is at its
// widest, and as tall as its inscribed rectangle.
//
// The width is the point (GEO-1). A centred block is broken to the balloon's own
// rows (`interiorLineWidths`), and the layout caps every row at the box's content
// width so no line is ever wider than the rectangle the user drags. A box at the
// inscribed rectangle is only 70% of the ellipse across, and every row inside
// its height has at least that much room - so the cap bound on every line of
// every block that fitted, and the oval came out a rectangle. At the inset
// shape's full width the widest row IS the box: the cap never binds, the top and
// bottom lines keep their taper, and the box still encloses every line, because
// no row is wider than the inset shape.
//
// The height stays the inscribed rectangle's. A block placed at the full height
// would start on a top row with no room in it; auto height grows the box from
// here as the text needs, as it always has.
//
// A rectangle is its own frame: the inset rectangle, exactly `inscribedRect`.
export function balloonFrame(shape, opts = {}) {
  if (!shape) return null;
  const o = { ...BALLOON_DEFAULTS, ...opts };
  const s = insetShape(shape, o);
  if (s.kind === 'rect') return { x: s.x, y: s.y, w: s.w, h: s.h };
  const w = 2 * s.rx;
  const h = s.ry * Math.SQRT2;
  return { x: s.cx - w / 2, y: s.cy - h / 2, w, h };
}

// The usable width of each line of a block of `lineCount` lines of `lineHeight`,
// laid out inside the shape and anchored by `valign` ('top' | 'middle' |
// 'bottom', as everywhere else in the app).
//
// This is the function the line-breaker calls, once per candidate line count,
// inside its own search - so it is pure, synchronous, allocation-light, O(lines)
// and has nothing to do with a canvas or the DOM.
//
// The one subtlety is which width a line gets. A line is a band of height
// `lineHeight`, not a hairline at its own baseline, and inside a curve the two
// answers differ: the width at the band's centre is wider than the width at
// whichever of its edges is further from the middle of the balloon. Taking the
// centre's width is the mistake that looks right in a diagram and puts the
// tallest glyphs of the top line - the capitals and the ascenders, which live at
// the very top of the band - straight through the outline. So each line gets the
// narrowest interior width across the whole band it occupies, which for an
// ellipse is the width at the band edge furthest from the centre line.
//
// For a rectangle every band gives the same answer and the result is a constant
// width repeated `lineCount` times, which is precisely today's behaviour: a
// narration box goes through the identical code path and comes out with the
// single width the breaker has always been given.
//
// The widths are the balloon's, not the text box's. A caller laying out inside a
// box still owes the box its own inset - `textInset(style)` on each edge, the
// padding plus the outline's reach, which the editor and the exporter both lay
// out inside - as `balloonWidthsFor` (measure.js) does when it caps every row at
// the box's `contentWidth`.
//
// A block taller than the balloon is the one case with no row-by-row answer.
// Left centred, its outer rows fall past the top and the bottom of the curve,
// where the interior is nothing at all - and this used to hand those rows a
// width of one pixel, which a breaker reads as a row that takes exactly one word
// (a single token is always accepted). One word a row means more rows, which
// fall further outside, which take one word each, until the search runs out of
// line counts: fifteen lines, twelve of them outside a 260x160 oval, for a
// sentence the plain box sets in ten. No width fixes a text that is too big for
// its balloon - a smaller size does, and that is the caller's decision - so the
// block gets the widest the balloon ever is, on every row. That is a plain
// rectangle, and a rectangle is never taller than the flat layout of the same
// text in a box no wider than the balloon.
export function interiorLineWidths(shape, lineHeight, lineCount, valign = 'middle', opts = {}) {
  const n = Number.isFinite(+lineCount) ? Math.max(0, Math.floor(+lineCount)) : 0;
  if (!shape || n === 0) return [];
  const o = { ...BALLOON_DEFAULTS, ...opts };
  const s = insetShape(shape, o);
  const lh = lineHeight > 0 ? lineHeight : 0;
  if (s.kind === 'rect') return new Array(n).fill(Math.max(o.minLineWidth, s.w));

  const blockH = n * lh;
  if (blockH > 2 * s.ry) return new Array(n).fill(Math.max(o.minLineWidth, 2 * s.rx));
  // Anchored by valign, and inside the shape by construction: a block that fits
  // sits inside whether it hangs from the top, stands on the bottom or is
  // centred, so there is nothing left to clamp.
  let top;
  if (valign === 'top') top = s.cy - s.ry;
  else if (valign === 'bottom') top = s.cy + s.ry - blockH;
  else top = s.cy - blockH / 2;

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = top + i * lh;
    const b = a + lh;
    const far = Math.min(s.ry, Math.max(Math.abs(a - s.cy), Math.abs(b - s.cy)));
    const k = s.ry > 0 ? far / s.ry : 1;
    out[i] = Math.max(o.minLineWidth, 2 * s.rx * Math.sqrt(Math.max(0, 1 - k * k)));
  }
  return out;
}

// ---------- the click-point probe ----------

// Is the neighbourhood of this point a solid single colour?
//
// This is the cheap question that has to be asked before the expensive one, and
// it is the whole reason a click on art costs nothing. A flood fill seeded in
// artwork does not fail loudly - it escapes through the first gap it finds,
// wanders over half a panel and comes back with a region that will very often
// fit a convincing rectangle. Refusing to start is far safer than fitting and
// then disbelieving.
//
// The test is deliberately two-sided, because "uniform" alone is not enough:
//
//   near-uniform   at least `uniformFrac` of the sampled pixels within
//                  `uniformTol` luma of the sample's median. Screentone fails it
//                  (a dot pattern is bimodal at any scale a probe can see),
//                  hatching fails it, an edge between two flats fails it, and a
//                  balloon interior passes it trivially.
//   and light      the median at least `minInteriorLuma`. A filled black panel,
//                  a solid shadow and the inside of a night sky are all perfectly
//                  uniform and none of them is a balloon. This is the half that
//                  keeps "solid colour" from meaning "solid ink".
//
// The median rather than the mean, so a couple of stray dark pixels - the tip of
// a glyph the clean missed, a speck of dust in the scan - shift the centre of
// the sample not at all instead of dragging it toward the ink.
//
// Returns null when there are no pixels to sample at all (no image, a point off
// the page), which the caller treats the same way it treats every other missing
// measurement: fall back.
export function localUniformity(image, x, y, opts = {}) {
  const o = { ...BALLOON_DEFAULTS, ...opts };
  const W = image ? image.width | 0 : 0;
  const H = image ? image.height | 0 : 0;
  const data = image ? image.data : null;
  if (!W || !H || !data || data.length < W * H * 4) return null;
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  if (px < 0 || py < 0 || px >= W || py >= H) return null;

  const r = Math.max(1, Math.round(o.probeRadius));
  const vals = [];
  for (let yy = py - r; yy <= py + r; yy++) {
    if (yy < 0 || yy >= H) continue;
    for (let xx = px - r; xx <= px + r; xx++) {
      if (xx < 0 || xx >= W) continue;
      vals.push(lumaOf(data, (yy * W + xx) * 4));
    }
  }
  if (!vals.length) return null;
  const sorted = sortedCopy(vals);
  const median = quantile(sorted, 0.5);
  let near = 0;
  for (const v of vals) if (Math.abs(v - median) <= o.uniformTol) near++;
  const frac = near / vals.length;
  return {
    median,
    frac: r2(frac),
    spread: sorted[sorted.length - 1] - sorted[0],
    samples: vals.length,
    uniform: frac >= o.uniformFrac && median >= o.minInteriorLuma,
  };
}

// The click-point pipeline: probe, fill, profile, fit.
//
// Same return shape as `detectBalloon` - so a caller can treat the two
// interchangeably - plus `uniform` and the `probe` behind it, because "the click
// was not on a solid colour" is a different answer from "it was, and the shape
// could not be explained", and a caller deciding what to tell the user wants to
// know which.
//
// The order matters and is the cheap-first one: a click on art is rejected by a
// 169-pixel sample and never reaches the fill.
export function detectBalloonAt(image, x, y, opts = {}) {
  const o = { ...BALLOON_DEFAULTS, ...opts };
  const none = (reason, extra) => ({
    kind: 'irregular',
    shape: null,
    confidence: 0,
    residual: Infinity,
    coverage: 0,
    reason,
    escaped: false,
    threshold: null,
    uniform: false,
    probe: null,
    ...extra,
  });
  const probe = localUniformity(image, x, y, o);
  if (!probe) return none('no-pixels');
  if (!probe.uniform) return none('not-solid', { probe });
  const region = fillFromPoint(image, x, y, o);
  if (!region) return none('no-fill', { probe, uniform: true });
  const fit = fitBalloonShape(interiorProfile(region), o);
  return {
    ...fit,
    escaped: region.escaped,
    threshold: region.threshold,
    uniform: true,
    probe,
  };
}

// The whole pipeline, for the caller that just wants the answer: fill, profile,
// fit. Returns exactly what `fitBalloonShape` returns, plus the two facts about
// the fill worth surfacing for a log or a debug overlay. `shape` is the only
// part meant to be stored on a box.
export function detectBalloon(image, block, opts = {}) {
  const region = fillInterior(image, block, opts);
  if (!region) {
    return {
      kind: 'irregular',
      shape: null,
      confidence: 0,
      residual: Infinity,
      coverage: 0,
      reason: 'no-fill',
      escaped: false,
      threshold: null,
    };
  }
  const fit = fitBalloonShape(interiorProfile(region), opts);
  return { ...fit, escaped: region.escaped, threshold: region.threshold };
}
