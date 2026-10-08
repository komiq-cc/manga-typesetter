import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import FontNotice from './FontNotice.svelte';
import { app, loadProjectPages, noteFontsChanged } from './store.svelte.js';
import { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch } from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { fakeRustEngine, SFNT, WOFF2 } from '../test/fake-rust-engine.js';
import { emptyFaces } from './data.js';

// The notice in the Text Queue that lists the open chapter's missing fonts.
// Mounted for real: that it appears, what it says, where a row takes you, and
// that it goes when the family is loaded.

const box = (id, font, text = 'HELLO') => ({ id, lineN: null, text, x: 10, y: 10, w: 200, h: 60, style: { font, size: 20 } });
const userFont = (name) => ({ name, css: `'${name}'`, real: true, faces: { ...emptyFaces(), regular: { file: `${name}.ttf` } } });

afterEach(() => {
  cleanup();
  app.fonts.user = [];
  loadProjectPages([]);
});

describe('the fonts-missing notice', () => {
  it('is not there for a chapter whose fonts are all here', () => {
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('a', 'Bangers'), box('b', 'Comic Neue')] }]);
    const view = render(FontNotice);
    expect(view.container.querySelector('.rv')).toBe(null);
  });

  it('counts the missing families, and lists each with its boxes once opened', async () => {
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [box('a', 'Bangers'), box('b', 'Gone Font')] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [box('c', 'Gone Font'), box('d', 'Other Gone')] },
    ]);
    const view = render(FontNotice);
    const head = view.getByRole('button', { name: /2 fonts missing/ });
    expect(view.container.querySelectorAll('.rv-row')).toHaveLength(0);
    await fireEvent.click(head);
    const rows = [...view.container.querySelectorAll('.rv-row')];
    expect(rows.map((r) => r.querySelector('.rv-text').textContent)).toEqual(['Gone Font', 'Other Gone']);
    expect(rows.map((r) => r.querySelector('.rv-pg').textContent)).toEqual(['2×', '1×']);
    // The browser is measuring here, and says what it draws instead.
    expect(rows[0].querySelector('.rv-why').textContent).toBe('not on this computer · set in Comic Neue');
  });

  it('takes you to the first box set in the family', async () => {
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [box('a', 'Bangers')] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [box('c', 'Bangers'), box('d', 'Gone Font')] },
    ]);
    const view = render(FontNotice);
    await fireEvent.click(view.getByRole('button', { name: /1 font missing/ }));
    await fireEvent.click(view.container.querySelector('.rv-row'));
    expect(app.pageIndex).toBe(1);
    expect(app.selectedId).toBe('d');
  });

  it('clears when the family is loaded', async () => {
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('a', 'Gone Font')] }]);
    const view = render(FontNotice);
    expect(view.getByRole('button', { name: /1 font missing/ })).toBeTruthy();
    app.fonts.user = [userFont('Gone Font')];
    await tick();
    expect(view.container.querySelector('.rv')).toBe(null);
  });
});

// The switch is on and there is no font the engine can read: no engine is
// installed, and to the font sync every name is one it has no bytes for. The
// notice must not pass that on as an engine's finding.
describe('the notice with the Rust engine on and no font for it to measure with', () => {
  const before = textEngine();
  let watcher;
  const start = async () => {
    // A plain browser: nothing to decode a WOFF with, no system fonts.
    _setEngineSwitchDeps({
      available: () => true,
      // It breaks lines itself, as the real adapter does: with a document
      // about (jsdom), the layout would otherwise ask the DOM, which has no layout here.
      createEngine: async () => ({ ...fakeRustEngine(), wrapPlain: (face, text) => [text] }),
      invoke: async () => null,
      booted: async () => {},
      records: async () => [{ name: 'Webby', slot: 'regular', file: 'Webby.woff2', data: WOFF2() }],
      watch: (w) => (watcher = w),
      os: () => 'macos',
    });
    app.fonts.user = [{ ...userFont('Webby'), faces: { ...emptyFaces(), regular: { file: 'Webby.woff2' } } }];
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [box('a', 'Bangers'), box('b', 'Bangers'), box('c', 'Comic Neue'), box('d', 'Gone Font'), box('e', 'Webby')] },
    ]);
    await useTextEngine('rust');
    expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: null });
    expect(textEngine()).toBe(null);
  };
  afterEach(() => {
    _resetEngineSwitch();
    _setEngineSwitchDeps(null);
    setTextEngine(before);
  });

  it('says that nothing is measuring, and lists only what is true without an engine', async () => {
    await start();
    const view = render(FontNotice);
    // Not four: the two built-ins are drawn by the browser, and no engine says otherwise.
    const head = view.getByRole('button', { name: /no font to measure with/ });
    expect(head.textContent).toContain('2 fonts missing');
    await fireEvent.click(head);
    const rows = [...view.container.querySelectorAll('.rv-row')].map((r) => [r.querySelector('.rv-text').textContent, r.querySelector('.rv-why').textContent]);
    expect(rows.map((r) => r[0])).toEqual(['No font to measure with', 'Gone Font', 'Webby']);
    expect(rows[0][1]).toContain('nothing is measuring');
    expect(rows[0][1]).toContain('Font Library');
    // A name nothing here has, in the browser's words; the user's font the engine could not take, with why.
    expect(rows[1][1]).toBe('not on this computer · set in Comic Neue');
    expect(rows[2][1]).toContain('WOFF');
    // The first row is about no box, and takes you nowhere.
    await fireEvent.click(view.container.querySelector('.rv-row'));
    expect(app.selectedId).toBe(null);
  });

  it('goes back to the engine’s own list the moment it has a font', async () => {
    await start();
    const view = render(FontNotice);
    expect(view.getByRole('button', { name: /no font to measure with/ })).toBeTruthy();
    app.fonts.user = [...app.fonts.user, userFont('Anchor')];
    watcher.added('Anchor', 'regular', SFNT());
    noteFontsChanged();
    await tick();
    expect(engineSwitch.lastResort).toBe('Anchor');
    // Measuring now: the built-ins are fonts it has no bytes for, and are set in Anchor.
    const head = view.getByRole('button', { name: /4 fonts missing/ });
    expect(head.textContent).not.toContain('no font to measure with');
    await fireEvent.click(head);
    const why = Object.fromEntries([...view.container.querySelectorAll('.rv-row')].map((r) => [r.querySelector('.rv-text').textContent, r.querySelector('.rv-why').textContent]));
    expect(why.Bangers).toBe('not on this computer · set in Anchor');
    expect(why['No font to measure with']).toBeUndefined();
  });

  it('says so for a chapter with nothing missing too, and claims nothing is', async () => {
    await start();
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('a', 'Bangers')] }]);
    const view = render(FontNotice);
    // Boxes are not being resized: the letterer has to hear of it where the work is.
    expect(view.getByRole('button', { name: /no font to measure with/ })).toBeTruthy();
    expect(view.container.querySelector('.rv-count').textContent).not.toContain('missing');
  });
});
