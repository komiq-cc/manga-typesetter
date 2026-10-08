import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRustEngine } from '../test/fake-rust-engine.js';

// The `textEngine` preference: stored with the others, applied by the same
// setter, and applied again at the next launch before anything measures.
// Modules are loaded fresh for every case, as prefs.test.js does, because
// prefs.svelte.js applies what it finds on import.

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

// The switch with a stand-in engine, set up before prefs.svelte.js is imported.
async function launch(booted = async () => {}) {
  const sw = await import('./engine-switch.svelte.js');
  const createEngine = vi.fn(async () => fakeRustEngine());
  sw._setEngineSwitchDeps({ available: () => true, createEngine, invoke: async () => null, booted, records: async () => [], os: () => 'macos' });
  const { prefs, setPref } = await import('./prefs.svelte.js');
  return { sw, createEngine, prefs, setPref };
}

describe('the textEngine preference', () => {
  it('is the browser on a fresh install, and nothing of the engine is loaded', async () => {
    const { sw, createEngine, prefs } = await launch();
    expect(prefs.textEngine).toBe('browser');
    expect(sw.engineSwitch).toMatchObject({ mode: 'browser', phase: 'off' });
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('is saved when set, and switches the engine in the same breath', async () => {
    const { sw, createEngine, prefs, setPref } = await launch();
    setPref('textEngine', 'rust');
    expect(prefs.textEngine).toBe('rust');
    expect(JSON.parse(storage['mt.prefs']).textEngine).toBe('rust');
    expect(sw.engineSwitch.mode).toBe('rust');
    await vi.waitFor(() => expect(sw.engineSwitch.phase).toBe('on'));
    expect(createEngine).toHaveBeenCalledTimes(1);
    setPref('textEngine', 'browser');
    expect(JSON.parse(storage['mt.prefs']).textEngine).toBe('browser');
    expect(sw.engineSwitch).toMatchObject({ mode: 'browser', phase: 'off' });
  });

  it('is applied at the next launch, before anything asks', async () => {
    storage['mt.prefs'] = JSON.stringify({ textEngine: 'rust' });
    // The font library is still being read, as it is at a real launch.
    let libraryRead;
    const { sw, prefs } = await launch(() => new Promise((resolve) => (libraryRead = resolve)));
    expect(prefs.textEngine).toBe('rust');
    // Already standing in the way of the first fit, with no call but the import.
    expect(sw.engineSwitch).toMatchObject({ mode: 'rust', phase: 'starting' });
    await vi.waitFor(() => expect(libraryRead).toBeTypeOf('function'));
    libraryRead();
    await vi.waitFor(() => expect(sw.engineSwitch.phase).toBe('on'));
  });

  it.each([['skia'], [true], [null], [1]])('takes nothing but the two engines: %s', async (value) => {
    storage['mt.prefs'] = JSON.stringify({ textEngine: value });
    const { sw, prefs, setPref } = await launch();
    expect(prefs.textEngine).toBe('browser');
    setPref('textEngine', value);
    expect(prefs.textEngine).toBe('browser');
    expect(sw.engineSwitch.mode).toBe('browser');
  });
});
