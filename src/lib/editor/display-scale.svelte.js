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
// It is a subscription and not a piece of state: the first reader is a
// `$derived`, and a derived may not write state, so there is nothing here to
// write. Svelte's `createSubscriber` listens while some effect depends on the
// value and stops when none does. Only the Rust engine's display path reads
// it, so a session with the switch off never listens at all.
import { createSubscriber } from 'svelte/reactivity';

const read = () => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

// For the tests: a display of another density, without a browser to move.
let forced = 0;
let poke = null;

const subscribe = createSubscriber((update) => {
  let stop = () => {};
  // A `resolution` query matches one ratio, so it tells of ONE change and has
  // to be asked again for the next.
  const listen = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(`(resolution: ${read()}dppx)`);
    if (typeof mq?.addEventListener !== 'function') return;
    const changed = () => {
      listen();
      update();
    };
    mq.addEventListener('change', changed, { once: true });
    stop = () => mq.removeEventListener('change', changed);
  };
  listen();
  poke = update;
  return () => {
    stop();
    poke = null;
  };
});

/** Device px per CSS px, read reactively. */
export function displayScale() {
  subscribe();
  return forced || read();
}

export function _setDisplayScale(dpr) {
  forced = dpr;
  poke?.();
}
