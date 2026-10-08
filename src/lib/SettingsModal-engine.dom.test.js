import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// What Settings says about the text engine switch, read off the mounted
// modal. The switch itself is the real one, on a stand-in engine.
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));

const { default: SettingsModal } = await import('./SettingsModal.svelte');
const { app, noteFontsChanged } = await import('./store.svelte.js');
const { engineSwitch, useTextEngine, engineHasNoFont, _setEngineSwitchDeps, _resetEngineSwitch } = await import('./engine-switch.svelte.js');
const { textEngine, setTextEngine } = await import('./text-engine/index.js');
const { fakeRustEngine, SFNT } = await import('../test/fake-rust-engine.js');
const { emptyFaces } = await import('./data.js');

const userFont = (name) => ({ name, css: `'${name}'`, real: true, faces: { ...emptyFaces(), regular: { file: `${name}.ttf` } } });
const before = textEngine();
let watcher;

beforeEach(() => {
  _setEngineSwitchDeps({
    available: () => true,
    createEngine: async () => fakeRustEngine(),
    invoke: async () => null,
    booted: async () => {},
    records: async () => [],
    watch: (w) => (watcher = w),
    os: () => 'macos',
  });
});
afterEach(() => {
  cleanup();
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  setTextEngine(before);
  app.fonts.user = [];
});

async function hint() {
  const view = render(SettingsModal, { open: true });
  await tick();
  await fireEvent.click(view.getByRole('tab', { name: 'Typesetting' }));
  const section = [...view.container.querySelectorAll('.settings-section')].find((s) => s.textContent.includes('TEXT ENGINE'));
  return () => section.querySelector('.qhint').textContent.replace(/\s+/g, ' ').trim();
}

describe('what Settings says of the text engine', () => {
  it('off: the browser measures', async () => {
    expect((await hint())()).toMatch(/^Off: text is measured by the browser/);
  });

  it('on with a font: what a missing font is set in', async () => {
    app.fonts.user = [userFont('Anchor')];
    _setEngineSwitchDeps({
      available: () => true, createEngine: async () => fakeRustEngine(), invoke: async () => null, booted: async () => {}, os: () => 'macos',
      records: async () => [{ name: 'Anchor', slot: 'regular', file: 'Anchor.ttf', data: SFNT() }],
      watch: (w) => (watcher = w),
    });
    await useTextEngine('rust');
    expect(engineHasNoFont()).toBe(false);
    const text = (await hint())();
    expect(text).toMatch(/^On\. Line breaks and box sizes are measured from your font files/);
    expect(text).toContain('is set in Anchor');
  });

  it('on with no font the engine can read: says nothing is measuring, in so many words, until there is one', async () => {
    await useTextEngine('rust');
    // The state the switch is in: on, and no engine installed.
    expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: null });
    expect(textEngine()).toBe(null);
    expect(engineHasNoFont()).toBe(true);
    const read = await hint();
    expect(read()).toMatch(/^Switched on, but nothing is measuring/);
    expect(read()).toContain('no font it can read');
    expect(read()).toContain('Font Library');
    // Not the words for an engine that is at work.
    expect(read()).not.toMatch(/are measured from your font files/);

    // A font arrives: the engine starts by itself, and Settings follows.
    app.fonts.user = [userFont('Anchor')];
    watcher.added('Anchor', 'regular', SFNT());
    noteFontsChanged();
    await tick();
    expect(engineHasNoFont()).toBe(false);
    expect(read()).toContain('is set in Anchor');
  });
});
