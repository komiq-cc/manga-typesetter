// ===== The colour picker's eyedropper: pick any colour off the screen =====
//
// Two routes, the web one first:
//   - `EyeDropper`, where the webview has it. That is Chromium: a dev server in
//     Chrome, and WebView2 in the Windows app.
//   - the `pick_screen_color` command in the macOS app, whose WKWebView has no
//     `EyeDropper`. It opens AppKit's own sampler (src-tauri/src/screen_color.rs).
// Anywhere else - WebKitGTK on Linux, Safari - there is no route and the picker
// draws no button: the square and the hex field reach the same value.
//
// Tauri is imported lazily, as sidecar.js and fsx.js do, so this module loads
// in vitest and in a plain browser.

import { hexOnCommit } from './color.js';

// Read on each call, not cached: the picker asks once per mount. Its own
// check rather than shortcuts.svelte.js's `isMacKeyboard`, which would pull
// the store into a leaf control, and is about the keyboard, not the sampler.
function onMac() {
  const nav = globalThis.navigator;
  return /Mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
}

/**
 * How to pick a colour off the screen here, or `null` where there is no way.
 * The picker answers lowercase `#rrggbb`, or `null` when the user pressed
 * Escape.
 *
 * @returns {(() => Promise<string | null>) | null}
 */
export function screenColorPicker() {
  const EyeDropper = /** @type {any} */ (globalThis).EyeDropper;
  if (typeof EyeDropper === 'function') {
    return async () => {
      try {
        const picked = await new EyeDropper().open();
        return hexOnCommit(String(picked?.sRGBHex ?? ''));
      } catch {
        return null; // Escape rejects with AbortError
      }
    };
  }
  if (globalThis.window?.__TAURI_INTERNALS__ && onMac()) {
    return async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const picked = await invoke('pick_screen_color');
      return typeof picked === 'string' ? hexOnCommit(picked) : null;
    };
  }
  return null;
}
