import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let storage;
beforeEach(() => {
  vi.resetModules();
  storage = {};
  vi.stubGlobal('localStorage', {
    getItem: (key) => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = String(value); },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('previous-box inheritance preference', () => {
  it.each([
    [undefined, true],
    [true, true],
    [false, false],
    ['false', true],
  ])('loads %s as %s and applies it to new-box styling', async (saved, enabled) => {
    storage['mt.prefs'] = JSON.stringify({ inheritBoxStyle: saved });
    const { prefs } = await import('./prefs.svelte.js');
    const { app, inheritedStyleFor } = await import('./store.svelte.js');
    app.lastStyle.rotation = 45;

    expect(prefs.inheritBoxStyle).toBe(enabled);
    expect(inheritedStyleFor({ n: 1, tags: [] }).rotation).toBe(enabled ? 45 : 0);
  });

  it('saves the choice and restores it on the next launch', async () => {
    const { setPref } = await import('./prefs.svelte.js');
    setPref('inheritBoxStyle', false);
    expect(JSON.parse(storage['mt.prefs']).inheritBoxStyle).toBe(false);

    vi.resetModules();
    const { prefs } = await import('./prefs.svelte.js');
    const { app, inheritedStyleFor } = await import('./store.svelte.js');
    app.lastStyle.rotation = 45;

    expect(prefs.inheritBoxStyle).toBe(false);
    expect(inheritedStyleFor({ n: 1, tags: [] }).rotation).toBe(0);
  });
});
