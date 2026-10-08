// Whether an element is on screen or close to it, told to whoever asked.
//
// One observer for every box in the editor. A box shown as a picture
// (box-picture.js) holds its pixels, and a box nobody can see should hold
// none: at 300% most of a page is off screen, and in a longstrip most of the
// mounted boxes always are. The browser already knows which elements are near
// the viewport and says so without a layout being forced, which is all this
// is - `IntersectionObserver` with a margin, and a callback per element.
//
// The margin is half a viewport on every side: a box is painted before a pan
// or a scroll brings it into view, and the pixels held are bounded by an area
// of four viewports however long the chapter or deep the zoom.
//
// The first answer for an element comes a frame after `watchNear`, not from
// it; the caller decides what a box does until then.
export const NEAR_MARGIN = '50%';

let observer = null;
const told = new WeakMap();

function observe() {
  observer ??= new IntersectionObserver(
    (entries) => {
      // Several entries for one element are in order; the last is the truth.
      for (const e of entries) told.get(e.target)?.(e.isIntersecting);
    },
    { rootMargin: NEAR_MARGIN },
  );
  return observer;
}

/**
 * Calls `cb(near)` whenever `el` comes within the margin of the viewport or
 * leaves it. Returns the function that stops it. Where the host has no
 * observer everything counts as near, at once.
 */
export function watchNear(el, cb) {
  if (typeof IntersectionObserver === 'undefined') {
    cb(true);
    return () => {};
  }
  const io = observe();
  told.set(el, cb);
  io.observe(el);
  return () => {
    told.delete(el);
    io.unobserve(el);
  };
}
