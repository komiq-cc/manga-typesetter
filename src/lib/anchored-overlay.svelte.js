// ===== An anchored popover's open state, and how it is dismissed =====
//
// The element that had focus is remembered on the way up. An outside
// pointerdown closes without giving focus back (the press already gave it
// somewhere else), and Escape closes and gives it back.
//
// Tab does NOT dismiss. A popover is a panel of several controls and Tab moves
// between them. What ends it is focus actually arriving somewhere outside the
// anchor (`focusOut`), which is what a Tab off the last control produces.
//
// The outside listener is registered in a `$effect`, so this must be called
// during a component's initialisation.

import { captureFocus } from './focus.js';

/**
 * @param {() => HTMLElement | undefined} root the anchor, trigger included: a
 *   pointerdown inside it is not an outside press
 * @param {() => HTMLElement | undefined} [portal] a panel rendered outside the
 *   anchor, which counts as inside too
 */
export function anchoredOverlay(root, portal = () => undefined) {
  let open = $state(false);
  /** @type {(() => void) | null} */
  let restore = null;
  let openedAtPointerDown = false;

  function show() {
    if (open) return;
    restore = captureFocus(() => root());
    open = true;
  }

  /** @param {{ refocus?: boolean }} [options] */
  function close({ refocus = true } = {}) {
    if (!open) return;
    open = false;
    if (refocus) restore?.();
    restore = null;
  }

  // The trigger's click. A press on the trigger while open is seen by the
  // outside listener first (as an inside press), so the click that follows
  // closes rather than closing and re-opening.
  function toggle() {
    if (openedAtPointerDown) close();
    else if (open) close();
    else show();
    openedAtPointerDown = false;
  }

  /**
   * Escape: close, and put focus back where it was. Propagation is stopped so
   * the editor's own Escape (deselect, close the bulk panel) does not also run.
   * @param {KeyboardEvent} event
   * @returns {boolean} whether the key was a dismissal
   */
  function dismissKey(event) {
    if (event.key !== 'Escape' || !open) return false;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    close();
    return true;
  }

  /**
   * Focus leaving the anchor altogether.
   *
   * A null `relatedTarget` (or body) is NOT a dismissal. It is what a press on
   * the page background produces, and it is also what WebKit - the engine
   * under the macOS app, since Tauri draws in a WKWebView - produces for a
   * press on the panel's own square, rail, label or padding, because WebKit
   * does not focus a button or a range input on click. Reading null as outside
   * closed the panel under the pointer that was using it. The outside press
   * has an owner already (the capture-phase pointerdown below), so this only
   * answers: has focus arrived somewhere that is not in the anchor?
   *
   * @param {FocusEvent} event
   * @returns {boolean} whether it was a dismissal
   */
  function focusOut(event) {
    if (!open) return false;
    const next = /** @type {Node | null} */ (event.relatedTarget);
    if (
      !next ||
      next === document.body ||
      next === document.documentElement ||
      root()?.contains(next) ||
      portal()?.contains(next)
    ) {
      return false;
    }
    close({ refocus: false });
    return true;
  }

  $effect(() => {
    if (!open) return;
    /** @param {PointerEvent} event */
    const outside = (event) => {
      const target = /** @type {Node} */ (event.target);
      const node = root();
      if (node?.contains(target)) openedAtPointerDown = true;
      else if (node && !portal()?.contains(target)) close({ refocus: false });
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      openedAtPointerDown = false;
      restore = null;
    };
  });

  return {
    get open() {
      return open;
    },
    show,
    close,
    toggle,
    dismissKey,
    focusOut,
  };
}
