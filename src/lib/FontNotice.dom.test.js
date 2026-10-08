import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import FontNotice from './FontNotice.svelte';
import { app, loadProjectPages } from './store.svelte.js';
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
