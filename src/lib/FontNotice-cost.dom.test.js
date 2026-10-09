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
  return { ...real, missingFonts: vi.fn(real.missingFonts) };
});

const { default: FontNotice } = await import('./FontNotice.svelte');
const { app, loadProjectPages, page, missingFonts, setBoxText, boxEdited, moveBoxTo, resizeBox, deleteBox, setFontSource, noteFontsChanged } =
  await import('./store.svelte.js');
const { emptyFaces } = await import('./data.js');

const box = (id, font, text = 'HELLO') => ({ id, lineN: null, text, x: 10, y: 10, w: 200, h: 60, style: { font, size: 20 } });
const userFont = (name) => ({ name, css: `'${name}'`, real: true, faces: { ...emptyFaces(), regular: { file: `${name}.ttf` } } });

afterEach(() => {
  cleanup();
  setFontSource(null);
  app.fonts.user = [];
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
