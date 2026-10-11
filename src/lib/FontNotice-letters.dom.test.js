import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import FontNotice from './FontNotice.svelte';
import { app, loadProjectPages } from './store.svelte.js';
import { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch, _engineSwitchSync } from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { fakeRustEngine, fakeNative, SFNT } from '../test/fake-rust-engine.js';
import { emptyFaces } from './data.js';

// The notice's lines for a box whose text is not all drawn in its own font:
// which letters come from which family, and which no installed font has.
// Mounted for real, on the stand-in engine and the stand-in native side.

const box = (id, text, font = 'Wild Words') => ({ id, lineN: null, text, x: 10, y: 10, w: 200, h: 60, style: { font, size: 20 } });
const userFont = (name) => ({ name, css: `'${name}'`, real: true, faces: { ...emptyFaces(), regular: { file: `${name}.ttf` } } });
const sysFont = (name) => ({ name, css: `"${name}", sans-serif`, system: true, faces: { ...emptyFaces(), regular: { file: null } } });
const before = { engine: textEngine(), system: app.fonts.system };
let engine;
let invoke;

async function start({ native = true, hold = false, coverage = [['Hiragino Sans', 'あいう漢♥'], ['Apple SD Gothic Neo', '한']], unreadable = [] } = {}) {
  engine = { ...fakeRustEngine(), wrapPlain: (face, text) => [text] };
  engine.cover('Hiragino Sans', 'あいう漢♥');
  engine.cover('Apple SD Gothic Neo', '한');
  engine.cover('Helvetica Neue', 'Ω');
  const files = Object.fromEntries(['Helvetica Neue', 'Hiragino Sans', 'Apple SD Gothic Neo'].filter((name) => !unreadable.includes(name)).map((name) => [name, [{ slots: { regular: 0 }, bytes: SFNT() }]]));
  invoke = fakeNative(files, { hold, coverage });
  _setEngineSwitchDeps({
    available: () => true,
    createEngine: async () => engine,
    invoke: async () => (native ? invoke : null),
    booted: async () => {},
    records: async () => [{ name: 'Wild Words', slot: 'regular', file: 'Wild Words.ttf', data: SFNT() }],
    watch: () => {},
    os: () => 'macos',
  });
  app.fonts.user = [userFont('Wild Words')];
  app.fonts.system = native ? ['Helvetica Neue', 'Hiragino Sans', 'Apple SD Gothic Neo'].map(sysFont) : [];
  const starting = useTextEngine('rust');
  for (let i = 0; i < 20 && engineSwitch.phase === 'starting'; i++) {
    invoke.release();
    await new Promise((r) => setTimeout(r, 0));
  }
  await starting;
  expect(engineSwitch.phase).toBe('on');
}

const settled = async () => {
  await _engineSwitchSync().settled();
  await tick();
};
const rows = (view) =>
  [...view.container.querySelectorAll('.rv-row')].map((r) => ({
    page: r.querySelector('.rv-pg').textContent,
    text: r.querySelector('.rv-text').textContent,
    why: r.querySelector('.rv-why').textContent,
  }));

afterEach(() => {
  cleanup();
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  setTextEngine(before.engine);
  app.fonts.user = [];
  app.fonts.system = before.system;
  loadProjectPages([]);
});

describe('the notice, for a box with letters its font lacks', () => {
  it.each(['absent', 'null'])('does not claim absence or invent a family when lineParts is %s', async (kind) => {
    await start();
    engine.lineParts = kind === 'absent' ? undefined : () => null;
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('mixed', 'Ωあ☃')] }]);
    const view = render(FontNotice);
    await settled();
    await fireEvent.click(view.getByRole('button', { name: /1 box with letters no font has · 1 box with letters from another font/ }));
    expect(rows(view)).toEqual([{ page: 'p.1', text: 'Ωあ☃', why: 'Ω あ drawn in another loaded font · no installed font has ☃' }]);
  });

  it('says which letters are drawn in which family, in one line a box', async () => {
    await start();
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [box('plain', 'ALL HERE'), box('kana', 'あいう!')] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [box('mixed', 'I ♥ 한 Ω')] },
    ]);
    const view = render(FontNotice);
    await settled();
    const head = view.getByRole('button', { name: /2 boxes with letters from another font/ });
    expect(head.textContent).not.toContain('no font has');
    expect(head.textContent).not.toContain('missing');
    await fireEvent.click(head);
    expect(rows(view)).toEqual([
      { page: 'p.1', text: 'あいう!', why: 'あ い う drawn in Hiragino Sans' },
      { page: 'p.2', text: 'I ♥ 한 Ω', why: '♥ drawn in Hiragino Sans · 한 drawn in Apple SD Gothic Neo · Ω drawn in Helvetica Neue' },
    ]);
    // A row takes you to its box.
    await fireEvent.click(view.container.querySelectorAll('.rv-row')[1]);
    expect(app.pageIndex).toBe(1);
    expect(app.selectedId).toBe('mixed');
  });

  it('says "no installed font has" for the ones none does, beside what is borrowed', async () => {
    await start();
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('snow', '☃ あ ☃ ⛄'), box('kana', 'あ')] }]);
    const view = render(FontNotice);
    await settled();
    const head = view.getByRole('button', { name: /1 box with letters no font has · 2 boxes with letters from another font/ });
    await fireEvent.click(head);
    expect(rows(view)).toEqual([
      { page: 'p.1', text: '☃ あ ☃ ⛄', why: 'あ drawn in Hiragino Sans · no installed font has ☃ ⛄' },
      { page: 'p.1', text: 'あ', why: 'あ drawn in Hiragino Sans' },
    ]);
  });

  it('shows six letters and says there are more', async () => {
    await start();
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('many', '①②③④⑤⑥⑦⑧')] }]);
    const view = render(FontNotice);
    await settled();
    await fireEvent.click(view.getByRole('button', { name: /1 box with letters no font has/ }));
    expect(rows(view)[0].why).toBe('no installed font has ① ② ③ ④ ⑤ ⑥ …');
  });

  it('says nothing of a letter while it is being looked for, and then says it', async () => {
    await start({ hold: true });
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('kana', 'あ')] }]);
    const view = render(FontNotice);
    await tick();
    expect(view.container.querySelector('.rv')).toBe(null);
    for (let i = 0; i < 4; i++) {
      invoke.release();
      await new Promise((r) => setTimeout(r, 0));
    }
    await settled();
    expect(view.getByRole('button', { name: /1 box with letters from another font/ })).toBeTruthy();
  });

  it('follows the text: the line goes when the letter does', async () => {
    await start();
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('kana', 'あ')] }]);
    const view = render(FontNotice);
    await settled();
    expect(view.getByRole('button', { name: /1 box with letters from another font/ })).toBeTruthy();
    app.pages[0].boxes[0].text = 'A';
    await tick();
    expect(view.container.querySelector('.rv')).toBe(null);
  });

  it('does not say "no installed font has" of a letter whose font could not be read', async () => {
    await start({ unreadable: ['Hiragino Sans'] });
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('kana', 'あ 한 ☃')] }]);
    const view = render(FontNotice);
    await settled();
    const head = view.getByRole('button', { name: /1 box with letters no font has · 1 box with letters whose font could not be read · 1 box with letters from another font/ });
    await fireEvent.click(head);
    expect(rows(view)).toEqual([{ page: 'p.1', text: 'あ 한 ☃', why: '한 drawn in Apple SD Gothic Neo · no installed font has ☃ · あ is in Hiragino Sans, which could not be read' }]);
  });

  it('nor of a letter nobody could look for: the question failed', async () => {
    await start({ coverage: 'fail' });
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('kana', 'あ ☃')] }]);
    const view = render(FontNotice);
    await settled();
    const head = view.getByRole('button', { name: /1 box with letters whose font could not be read/ });
    expect(head.textContent).not.toContain('no font has');
    await fireEvent.click(head);
    expect(rows(view)).toEqual([{ page: 'p.1', text: 'あ ☃', why: 'could not look for a font with あ ☃' }]);
  });

  it('in a plain browser nobody looked through the installed fonts, and the line does not say anybody did', async () => {
    await start({ native: false });
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('kana', 'あ')] }]);
    const view = render(FontNotice);
    await tick();
    await fireEvent.click(view.getByRole('button', { name: /1 box with letters no font has/ }));
    expect(rows(view)[0].why).toBe('no loaded font has あ');
  });
});
