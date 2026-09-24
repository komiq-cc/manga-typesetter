// ===== Shell-level guards for webview desktop app =====
// UX-1: Prevents accidental reload and native reload context menu.

// The one selector that decides where the webview's own context menu may still
// appear: text fields and the in-place editor, where Cut/Copy/Paste/Spelling
// are wanted. `<select>` is deliberately absent - it has no useful native menu
// and would otherwise offer Reload. `closest` covers the target itself and
// every ancestor, so a span inside a contenteditable counts. Only text-like
// inputs: a slider, checkbox or colour well gets the webview's non-editable
// menu, which is the one with Reload in it.
const NOT_TEXT = ['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'image']
  .map((t) => `:not([type=${t}])`)
  .join('');
const EDITABLE = `input${NOT_TEXT}, textarea, [contenteditable]:not([contenteditable="false"])`;

/**
 * @param {any} el event target (an Element, or a Text node inside one)
 * @returns {boolean}
 */
export function isEditableTarget(el) {
  const node = el?.nodeType === 3 ? el.parentElement : el;
  return !!node?.closest?.(EDITABLE);
}

/**
 * Context menu handler that prevents the browser/webview native menu unless
 * the target is an editable element.
 *
 * @param {Event} e
 */
export function onContextMenu(e) {
  if (!isEditableTarget(e?.target)) {
    e?.preventDefault?.();
  }
}

/**
 * Installs the contextmenu guard on the document in the capture phase.
 * Capture phase ensures reload menu prevention runs before target bubbling.
 *
 * @param {Document|any} [doc]
 * @returns {() => void} Disposer
 */
export function installContextMenuGuard(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || typeof doc.addEventListener !== 'function') return () => {};
  doc.addEventListener('contextmenu', onContextMenu, true);
  return () => {
    if (typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('contextmenu', onContextMenu, true);
    }
  };
}

/**
 * Determines whether a keyboard event is a page-reload shortcut:
 * Mod+R, Mod+Shift+R, or F5.
 *
 * @param {KeyboardEvent|any} e
 * @returns {boolean}
 */
export function isReloadKey(e) {
  if (!e) return false;
  if (e.key === 'F5') return true;
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  // The typed letter, not the physical key: on Dvorak the key where QWERTY has
  // R types P, and Cmd+P must stay Cmd+P. `code` is only the fallback for
  // layouts whose letters are not Latin at all (Cyrillic, Greek...), where
  // the system still maps the R position to reload.
  const key = typeof e.key === 'string' ? e.key : '';
  return /^[a-z]$/i.test(key) ? key.toLowerCase() === 'r' : e.code === 'KeyR';
}
