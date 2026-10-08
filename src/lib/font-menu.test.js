import { afterEach, describe, expect, it } from 'vitest';
import { app, setFontSource } from './store.svelte.js';
import { fontCaveat, setBuiltinHidden } from './font-menu.js';
import { systemFontEntry } from './fonts.js';
import { emptyFaces } from './data.js';
import { setPref } from './prefs.svelte.js';

// What a font select says beside the family a box is set in. "Hidden from the
// menus" and "not on this machine" used to be the same words.

afterEach(() => {
  app.fonts.user = [];
  app.fonts.system = [];
  setPref('hiddenBuiltinFonts', []);
  setPref('shownSystemFonts', []);
  setFontSource(null);
});

describe('the note beside a box’s font', () => {
  it('is nothing for a family the menus offer', () => {
    app.fonts.user = [{ name: 'Wild Words', css: "'Wild Words'", real: true, faces: { ...emptyFaces(), regular: { file: 'ww.ttf' } } }];
    expect(fontCaveat('Bangers')).toBe(null);
    expect(fontCaveat('Wild Words')).toBe(null);
    expect(fontCaveat('')).toBe(null);
    expect(fontCaveat(undefined)).toBe(null);
  });

  it('says a hidden built-in and an unshown system font are only out of the menus', () => {
    setBuiltinHidden('Bangers', true);
    app.fonts.system = [systemFontEntry({ name: 'Zapfino', faces: { regular: true } })];
    expect(fontCaveat('Bangers')).toBe('not in menus');
    expect(fontCaveat('Zapfino')).toBe('not in menus');
  });

  it('says a family no list has is missing', () => {
    expect(fontCaveat('Gone Font')).toBe('font missing');
  });

  it('says missing first, even of a family a menu still lists', () => {
    // What the Rust engine's font source answers for a built-in: no bytes.
    setFontSource({ ready: () => true, missing: (name) => name === 'Bangers' });
    expect(fontCaveat('Bangers')).toBe('font missing');
    expect(fontCaveat('Comic Neue')).toBe(null);
    setBuiltinHidden('Comic Neue', true);
    expect(fontCaveat('Comic Neue')).toBe('not in menus');
  });
});
