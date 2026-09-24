import { describe, it, expect } from 'vitest';
import {
  isEditableTarget,
  onContextMenu,
  installContextMenuGuard,
  isReloadKey,
} from './shell-guards.js';

// A tiny stand-in for an Element: just enough `closest` for the one selector
// shell-guards.js uses (text-like inputs, textarea, and a contenteditable that
// is not "false").
const NON_TEXT = ['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'image'];
function el(tag, attrs = {}, parentElement = null) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), attrs, parentElement };
  node.closest = () => {
    for (let n = node; n; n = n.parentElement) {
      const ce = n.attrs.contenteditable;
      const textInput = n.tagName === 'INPUT' && !NON_TEXT.includes(n.attrs.type);
      if (textInput || n.tagName === 'TEXTAREA' || (ce != null && ce !== 'false')) return n;
    }
    return null;
  };
  return node;
}

describe('shell-guards: contextmenu and editable targets (UX-1)', () => {
  function createFakeEvent(target) {
    let defaultPrevented = false;
    return {
      target,
      get defaultPrevented() {
        return defaultPrevented;
      },
      preventDefault() {
        defaultPrevented = true;
      },
    };
  }

  it('identifies editable targets and rejects non-editable targets', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
    expect(isEditableTarget(el('canvas'))).toBe(false);
    expect(isEditableTarget(el('div'))).toBe(false);
    // <select> is deliberately not exempt for context menu
    expect(isEditableTarget(el('select'))).toBe(false);
    expect(isEditableTarget(el('div', { contenteditable: 'false' }))).toBe(false);

    expect(isEditableTarget(el('input'))).toBe(true);
    expect(isEditableTarget(el('textarea'))).toBe(true);
    expect(isEditableTarget(el('div', { contenteditable: 'true' }))).toBe(true);
    expect(isEditableTarget(el('span', {}, el('div', { contenteditable: '' })))).toBe(true);
    // A Text node inside an editable resolves through its parent element.
    expect(isEditableTarget({ nodeType: 3, parentElement: el('div', { contenteditable: 'true' }) })).toBe(true);
  });

  it('prevents default contextmenu on a canvas-like target', () => {
    const e = createFakeEvent(el('canvas'));
    onContextMenu(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('prevents default contextmenu on a select element', () => {
    const e = createFakeEvent(el('select'));
    onContextMenu(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('does NOT prevent default contextmenu on an input', () => {
    const e = createFakeEvent(el('input'));
    onContextMenu(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('prevents default contextmenu on sliders and checkboxes', () => {
    for (const type of ['range', 'checkbox', 'color']) {
      const e = createFakeEvent(el('input', { type }));
      onContextMenu(e);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  it('does NOT prevent default contextmenu on a textarea', () => {
    const e = createFakeEvent(el('textarea'));
    onContextMenu(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('does NOT prevent default contextmenu inside a contenteditable', () => {
    const e = createFakeEvent(el('span', {}, el('div', { contenteditable: 'true' })));
    onContextMenu(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('installContextMenuGuard registers on capture phase and disposes properly', () => {
    const listeners = [];
    const fakeDoc = {
      addEventListener(type, fn, capture) {
        listeners.push({ type, fn, capture });
      },
      removeEventListener(type, fn, capture) {
        const idx = listeners.findIndex(
          (l) => l.type === type && l.fn === fn && l.capture === capture,
        );
        if (idx !== -1) listeners.splice(idx, 1);
      },
    };

    const dispose = installContextMenuGuard(fakeDoc);
    expect(listeners).toHaveLength(1);
    expect(listeners[0].type).toBe('contextmenu');
    expect(listeners[0].capture).toBe(true);

    dispose();
    expect(listeners).toHaveLength(0);
  });
});

describe('shell-guards: reload keyboard blocking (UX-1)', () => {
  it('identifies reload keys (Cmd+R, Ctrl+R, Cmd+Shift+R, F5) as true', () => {
    expect(isReloadKey({ key: 'r', metaKey: true })).toBe(true); // Cmd+R
    expect(isReloadKey({ key: 'R', metaKey: true })).toBe(true);
    expect(isReloadKey({ code: 'KeyR', metaKey: true })).toBe(true);

    expect(isReloadKey({ key: 'r', ctrlKey: true })).toBe(true); // Ctrl+R
    expect(isReloadKey({ key: 'R', ctrlKey: true })).toBe(true);
    expect(isReloadKey({ code: 'KeyR', ctrlKey: true })).toBe(true);

    expect(isReloadKey({ key: 'r', metaKey: true, shiftKey: true })).toBe(true); // Cmd+Shift+R
    expect(isReloadKey({ key: 'R', metaKey: true, shiftKey: true })).toBe(true);
    expect(isReloadKey({ key: 'R', ctrlKey: true, shiftKey: true })).toBe(true); // Ctrl+Shift+R

    expect(isReloadKey({ key: 'F5' })).toBe(true);
    expect(isReloadKey({ key: 'F5', ctrlKey: true })).toBe(true);
    expect(isReloadKey({ key: 'F5', shiftKey: true })).toBe(true);
  });

  it('identifies non-reload keys (plain r, Cmd+T, etc.) as false', () => {
    expect(isReloadKey({ key: 'r' })).toBe(false);
    expect(isReloadKey({ key: 'R' })).toBe(false);
    expect(isReloadKey({ key: 'r', shiftKey: true })).toBe(false);
    expect(isReloadKey({ key: 't', metaKey: true, code: 'KeyT' })).toBe(false);
    expect(isReloadKey({ key: 't', ctrlKey: true, code: 'KeyT' })).toBe(false);
    expect(isReloadKey({ key: 'r', altKey: true })).toBe(false);
    expect(isReloadKey({ key: 'r', metaKey: true, altKey: true })).toBe(false);
    // Dvorak: the physical R key types P, so this is Cmd+P, not reload.
    expect(isReloadKey({ key: 'p', code: 'KeyR', metaKey: true })).toBe(false);
    expect(isReloadKey({ key: 'r', code: 'KeyO', metaKey: true })).toBe(true);
    // Non-Latin layout: no Latin letter to read, so the physical key decides.
    expect(isReloadKey({ key: 'к', code: 'KeyR', metaKey: true })).toBe(true);
    expect(isReloadKey(null)).toBe(false);
    expect(isReloadKey(undefined)).toBe(false);
  });
});
