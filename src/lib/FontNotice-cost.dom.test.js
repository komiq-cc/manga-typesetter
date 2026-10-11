import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// What the fonts-missing notice costs while the letterer works. It is mounted
// in the Text Queue for the whole session, with either engine measuring, and
// its list is made by walking every box of the chapter (`missingFonts`). That
// walk reads one thing of a box - `style.font` - so it must run again only
// when a font name, the set of boxes or the font lists change: not on a
// keystroke, a drag or a resize, which is nearly everything that happens.
//
// The component is mounted for real and the store's function is counted
// through the module the component imports.
vi.mock('./store.svelte.js', async (original) => {
  const real = await original();
  // `boxText` as the modules outside the store call it: the notice's other
  // list reads a box's text through it (engine-switch.svelte.js), and the
  // store's own fits do not go through this export.
  return { ...real, missingFonts: vi.fn(real.missingFonts), boxText: vi.fn(real.boxText) };
});

const { default: FontNotice } = await import('./FontNotice.svelte');
const { app, loadProjectPages, page, missingFonts, boxText, setBoxText, boxEdited, moveBoxTo, resizeBox, deleteBox, setFontSource, noteFontsChanged } =
  await import('./store.svelte.js');
const { emptyFaces } = await import('./data.js');
const { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch, _engineSwitchSync } = await import('./engine-switch.svelte.js');
const { textEngine, setTextEngine } = await import('./text-engine/index.js');
const { fakeRustEngine, fakeNative, SFNT } = await import('../test/fake-rust-engine.js');

const box = (id, font, text = 'HELLO') => ({ id, lineN: null, text, x: 10, y: 10, w: 200, h: 60, style: { font, size: 20 } });
const userFont = (name) => ({ name, css: `'${name}'`, real: true, faces: { ...emptyFaces(), regular: { file: `${name}.ttf` } } });

const before = { engine: textEngine(), system: app.fonts.system };
afterEach(() => {
  cleanup();
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  setTextEngine(before.engine);
  setFontSource(null);
  app.fonts.user = [];
  app.fonts.system = before.system;
  loadProjectPages([]);
});

async function mounted() {
  loadProjectPages([
    { id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'FROM THE QUEUE' }], boxes: [box('a', 'Gone Font'), box('b', 'Bangers'), { ...box('q', 'Bangers', ''), lineN: 1 }] },
    { id: 2, w: 800, h: 1200, lines: [], boxes: [box('c', 'Gone Font')] },
  ]);
  const view = render(FontNotice);
  await tick();
  expect(view.getByRole('button', { name: /1 font missing/ })).toBeTruthy();
  missingFonts.mockClear();
  return view;
}
const ran = async () => {
  await tick();
  const n = missingFonts.mock.calls.length;
  missingFonts.mockClear();
  return n;
};

describe('the fonts-missing list is not made again', () => {
  it('by typing in a box, in any of the ways text is written', async () => {
    await mounted();
    const [a, , q] = page().boxes;
    for (const text of ['H', 'HE', 'HEL', 'HELP ME']) {
      setBoxText(a, text);
      boxEdited(a);
      expect(await ran()).toBe(0);
    }
    a.text = 'WRITTEN STRAIGHT';
    expect(await ran()).toBe(0);
    // A queue line, and the box that shows it.
    page().lines[0].en = 'THE LINE WAS EDITED';
    boxEdited(q);
    expect(await ran()).toBe(0);
  });

  it('by moving a box, resizing it, or changing anything of its style but the font', async () => {
    await mounted();
    const a = page().boxes[0];
    moveBoxTo(a, 300, 400);
    expect(await ran()).toBe(0);
    resizeBox(1, 'a', { w: 320 });
    expect(await ran()).toBe(0);
    a.h = 90;
    a.style.size = 31;
    a.style.bold = true;
    a.style.lineHeight = 1.3;
    boxEdited(a);
    expect(await ran()).toBe(0);
    app.selectedId = 'a';
    expect(await ran()).toBe(0);
  });
});

describe('the fonts-missing list is made again, once', () => {
  it('when a box changes font', async () => {
    const view = await mounted();
    page().boxes[1].style.font = 'Other Gone';
    expect(await ran()).toBe(1);
    expect(view.getByRole('button', { name: /2 fonts missing/ })).toBeTruthy();
  });

  it('when a box goes, and when a font is loaded', async () => {
    const view = await mounted();
    deleteBox('a');
    expect(await ran()).toBe(1);
    expect(view.getByRole('button', { name: /1 font missing/ })).toBeTruthy();
    app.fonts.user = [userFont('Gone Font')];
    expect(await ran()).toBe(1);
    expect(view.container.querySelector('.rv')).toBe(null);
  });
});

// With the Rust engine measuring, "missing" is the engine's answer and not the
// font lists'. It is asked through the one signal a face arriving raises, so
// the same holds: a keystroke asks nothing, a font event asks once.
describe('with a font source answering for the names', () => {
  it('typing and moving ask it nothing; a face arriving asks it again, once', async () => {
    let have = false;
    setFontSource({ ready: () => true, missing: (name) => name === 'Gone Font' && !have });
    const view = await mounted();
    const a = page().boxes[0];
    setBoxText(a, 'TYPED');
    boxEdited(a);
    moveBoxTo(a, 300, 400);
    expect(await ran()).toBe(0);
    have = true;
    noteFontsChanged();
    expect(await ran()).toBe(1);
    expect(view.container.querySelector('.rv')).toBe(null);
  });
});

// The notice's other list, with the Rust engine measuring: the boxes whose
// text is not all drawn in their own font. It is made from every box's TEXT,
// so a keystroke does change what it is made from - of one box. What a
// keystroke costs must not grow with the chapter: the box typed in is looked
// at again, and no other.
describe('with the Rust engine measuring, the list of borrowed letters', () => {
  const PAGES = 40;
  const BOXES = 10;
  const sysFont = (name) => ({ name, css: `"${name}", sans-serif`, system: true, faces: { ...emptyFaces(), regular: { file: null } } });

  async function chapter() {
    const engine = { ...fakeRustEngine(), wrapPlain: (face, text) => [text] };
    engine.cover('Hiragino Sans', '♥');
    const names = ['Helvetica Neue', 'Hiragino Sans'];
    const invoke = fakeNative(Object.fromEntries(names.map((name) => [name, [{ slots: { regular: 0 }, bytes: SFNT() }]])), { coverage: [['Hiragino Sans', '♥']] });
    _setEngineSwitchDeps({
      available: () => true,
      createEngine: async () => engine,
      invoke: async () => invoke,
      booted: async () => {},
      records: async () => [{ name: 'Wild Words', slot: 'regular', file: 'Wild Words.ttf', data: SFNT() }],
      watch: () => {},
      os: () => 'macos',
    });
    app.fonts.user = [userFont('Wild Words')];
    app.fonts.system = names.map(sysFont);
    await useTextEngine('rust');
    expect(engineSwitch.phase).toBe('on');
    // One box a page borrows a heart; the other nine are plain.
    loadProjectPages(
      Array.from({ length: PAGES }, (_, i) => ({
        id: i + 1, w: 800, h: 1200, lines: [],
        boxes: Array.from({ length: BOXES }, (_, j) => box(`b${i}-${j}`, 'Wild Words', j === 0 ? 'I ♥ YOU' : `PLAIN TEXT ${j}`)),
      })),
    );
    const view = render(FontNotice);
    await _engineSwitchSync().settled();
    await tick();
    expect(view.getByRole('button', { name: new RegExp(`${PAGES} boxes with letters from another font`) })).toBeTruthy();
    boxText.mockClear();
    return view;
  }
  // The boxes whose text the list read since the last time this was asked.
  const read = async () => {
    await tick();
    const n = boxText.mock.calls.length;
    boxText.mockClear();
    return n;
  };

  it('looks at one box for a keystroke in one box, in a chapter of four hundred', async () => {
    const view = await chapter();
    const plain = app.pages[7].boxes[4];
    const looks = [];
    const t0 = performance.now();
    for (const text of ['P', 'PL', 'PLA', 'PLAI', 'PLAIN', 'PLAINE', 'PLAINER', 'PLAINER.']) {
      setBoxText(plain, text);
      boxEdited(plain);
      looks.push(await read());
    }
    const each = (performance.now() - t0) / 8;
    console.log(`a keystroke in a chapter of ${PAGES * BOXES} boxes: ${looks.join(' ')} boxes read, ${each.toFixed(2)} ms`);
    expect(looks).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);

    // A box that borrows a letter, typed in: one box again, and the list follows it.
    const heart = app.pages[7].boxes[0];
    setBoxText(heart, 'I ♥ YOU TOO');
    boxEdited(heart);
    expect(await read()).toBe(1);
    setBoxText(heart, 'I LIKE YOU');
    boxEdited(heart);
    expect(await read()).toBe(1);
    expect(view.getByRole('button', { name: new RegExp(`${PAGES - 1} boxes with letters from another font`) })).toBeTruthy();
    setBoxText(plain, 'NOW ♥');
    boxEdited(plain);
    await _engineSwitchSync().settled();
    await read();
    expect(view.getByRole('button', { name: new RegExp(`${PAGES} boxes with letters from another font`) })).toBeTruthy();

    // Borrowing depends on the painted layout: moving/resizing reads only
    // that box. A box borrowing nothing still ignores geometry changes.
    moveBoxTo(plain, 300, 400);
    plain.h = 90;
    boxEdited(plain);
    app.selectedId = plain.id;
    expect(await read()).toBe(1);
    const other = app.pages[8].boxes[4];
    moveBoxTo(other, 300, 400);
    other.h = 90;
    boxEdited(other);
    expect(await read()).toBe(0);
  });

  it('reads every box once when a font lands, and once more for none of them after', async () => {
    await chapter();
    noteFontsChanged();
    expect(await read()).toBe(PAGES * BOXES);
    expect(await read()).toBe(0);
  });
});
