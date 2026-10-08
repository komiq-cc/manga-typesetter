// How many device pixels the display has per CSS px, as something a component
// can depend on.
//
// `window.devicePixelRatio` is a plain number: it changes when the window is
// dragged to another display or the page is zoomed, and nothing re-runs. The
// one consumer is the editor's picture of a box (box-picture.js), which is
// painted at the zoom times this and would otherwise stay at the old display's
// resolution - soft on the sharper one, wasted on the other - until something
// else repainted it.
//
// Nothing here runs until `displayScale()` is first called, and only the Rust
// engine's display path calls it: a session with the switch off never arms
// the listener.
const read = () => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

const display = $state({ dpr: 1 });
let armed = false;

// A `resolution` query matches one ratio, so it tells of ONE change and has to
// be asked again for the next.
function arm() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const mq = window.matchMedia(`(resolution: ${read()}dppx)`);
  const changed = () => {
    display.dpr = read();
    arm();
  };
  if (typeof mq?.addEventListener === 'function') mq.addEventListener('change', changed, { once: true });
}

/** Device px per CSS px, read reactively. */
export function displayScale() {
  if (!armed) {
    armed = true;
    display.dpr = read();
    arm();
  }
  return display.dpr;
}

// For the tests: a display of another density, without a browser to move.
export function _setDisplayScale(dpr) {
  armed = true;
  display.dpr = dpr;
}
