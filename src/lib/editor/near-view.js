// Whether an element is on screen or close to it, told to whoever asked.
//
// A box shown as a picture (box-picture.js) holds its pixels, and a box nobody
// can see should hold none: at 300% most of a page is off screen, and in a
// longstrip most of the mounted boxes always are. The browser already knows
// which elements are near the viewport and says so without a layout being
// forced, which is all this is - `IntersectionObserver` with a margin, and a
// callback per element.
//
// The margin is half the scrolling area's own size on every side: a box is
// painted before a pan or a scroll brings it into view.
//
// WHAT THE MARGIN IS MEASURED FROM. An observer with no `root` judges against
// the window, and its margin grows the window's rectangle - but on the way up
// from the element to the window every scroll container clips first, with no
// margin at all. The editor's canvas is one (`.editor-scroll`, `overflow:
// auto`), so a margin given to the window did nothing: an element 2% of a
// window below the fold was "far", measured in Chromium and in WKWebView. The
// observer is therefore rooted AT the element's scroll container, where the
// margin is the first thing applied. `root` with `rootMargin` is the form
// every engine has had since it had observers (Safari 12.1, Chromium 51, so
// WKWebView, WebView2 and WebKitGTK alike). `scrollMargin` says the same
// without a root, and is Safari 26 and Chromium 120: the window is the
// system's WebKit, which on an older macOS does not have it.
// One observer per root, so the boxes of one canvas still share one.
//
// What it bounds is which boxes hold pixels, not how many pixels: every box
// that touches the grown area - twice the scrolling area each way, four of it
// - holds its WHOLE picture, each up to its own budget (`PICTURE_MAX_PX`).
//
// The first answer for an element comes a frame after `watchNear`, not from
// it; the caller decides what a box does until then.
export const NEAR_MARGIN = '50%';

const SCROLLS = /^(auto|scroll|overlay)$/;

// The nearest ancestor that scrolls its content, or null for the window. Asked
// of the styles once per parent: the boxes of a page are siblings.
let roots = new WeakMap();
function scrollRoot(el) {
  const from = el?.parentElement;
  if (!from || typeof getComputedStyle !== 'function') return null;
  if (roots.has(from)) return roots.get(from);
  const doc = from.ownerDocument;
  let root = null;
  for (let p = from; p && p !== doc?.body && p !== doc?.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (SCROLLS.test(cs.overflowY) || SCROLLS.test(cs.overflowX)) {
      root = p;
      break;
    }
  }
  roots.set(from, root);
  return root;
}

// One observer per root; the window's is filed under this.
const WINDOW = {};
let observers = new WeakMap();
const told = new WeakMap();

function observerFor(root) {
  const key = root ?? WINDOW;
  let io = observers.get(key);
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        // Several entries for one element are in order; the last is the truth.
        for (const e of entries) told.get(e.target)?.(e.isIntersecting);
      },
      root ? { root, rootMargin: NEAR_MARGIN } : { rootMargin: NEAR_MARGIN },
    );
    observers.set(key, io);
  }
  return io;
}

/**
 * Calls `cb(near)` whenever `el` comes within the margin of the area it
 * scrolls in, or leaves it. Returns the function that stops it. Where the host
 * has no observer everything counts as near, at once.
 */
export function watchNear(el, cb) {
  if (typeof IntersectionObserver === 'undefined') {
    cb(true);
    return () => {};
  }
  const io = observerFor(scrollRoot(el));
  told.set(el, cb);
  io.observe(el);
  return () => {
    told.delete(el);
    io.unobserve(el);
  };
}
