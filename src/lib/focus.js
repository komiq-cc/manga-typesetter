// ===== Focus helpers for popovers =====
// A selector, a query and a restore. No third-party trap, no global state.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Every focusable descendant of `root`, in document order, skipping anything
 * hidden.
 * @param {HTMLElement} root
 * @returns {HTMLElement[]}
 */
export function focusable(root) {
  return /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll(FOCUSABLE))).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Remember the focused element so it can be given focus back on close. If it
 * has left the DOM meanwhile, the first focusable in `fallback` takes it, then
 * the first focusable in the old element's surviving parent.
 *
 * @param {HTMLElement | (() => HTMLElement | null | undefined) | null} [fallback]
 * @returns {() => void} restore
 */
export function captureFocus(fallback) {
  const previous = /** @type {HTMLElement | null} */ (document.activeElement);
  const parent = previous?.parentElement ?? null;
  return () => {
    if (previous && document.contains(previous)) {
      previous.focus();
      return;
    }
    const node = typeof fallback === 'function' ? fallback() : fallback;
    if (node && document.contains(node)) {
      (focusable(node)[0] ?? node).focus?.();
      return;
    }
    if (parent && document.contains(parent)) focusable(parent)[0]?.focus();
  };
}
