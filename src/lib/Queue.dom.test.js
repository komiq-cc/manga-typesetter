import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import Queue from './Queue.svelte';
import { app, loadProjectPages, page, settleEdits } from './store.svelte.js';
import { initHistory, resetHistory, undo } from './editor/history.svelte.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  app.chapterRef = null;
  app.chapterMode = 'translate';
  loadProjectPages([{
    id: 1, w: 800, h: 1200, boxes: [],
    lines: [
      { n: 1, en: 'alpha' }, { n: -1, en: 'free' }, { n: 2, en: 'beta' },
      { n: 3, en: 'gamma' }, { n: 4, en: 'delta' },
    ],
  }]);
  page().activeLineN = 2;
  initHistory();
  resetHistory();
});
afterEach(() => {
  cleanup();
  settleEdits();
  resetHistory();
  loadProjectPages([]);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps the move button and textarea on the same content through moves and undo', async () => {
  const view = render(Queue);
  await tick();
  const down = view.getByRole('button', { name: 'Move down' });
  const textarea = view.getByPlaceholderText('English…');
  down.focus();
  await fireEvent.click(down);
  await tick();
  expect(page().activeLineN).toBe(3);
  expect(view.getByPlaceholderText('English…')).toBe(textarea);
  expect(textarea.value).toBe('beta');
  expect(document.activeElement).toBe(down);
  expect([...view.container.querySelectorAll('.qrow .badge')].map((b) => b.textContent)).toEqual(['1', 'T', '2', '3', '4']);
  await fireEvent.click(down);
  expect(page().activeLineN).toBe(4);
  expect(down.disabled).toBe(true);
  expect(document.activeElement).toBe(down.closest('.qrow'));
  expect(undo()).toBe(true);
  expect(undo()).toBe(true);
  await tick();
  expect(view.getByPlaceholderText('English…')).toBe(textarea);
  expect(textarea.value).toBe('beta');
  expect(page().activeLineN).toBe(2);
});

it('leaves typing keys to the textarea and never offers to move a free row', async () => {
  const view = render(Queue);
  await tick();
  const textarea = view.getByPlaceholderText('English…');
  textarea.focus();
  const key = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
  textarea.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);
  await fireEvent.input(textarea, { target: { value: 'typed beta' } });
  expect(page().lines.find((l) => l.n === 2).en).toBe('typed beta');
  await fireEvent.click(view.getByRole('button', { name: 'Create tag' }));
  const tagName = view.getByPlaceholderText('Tag name…');
  await fireEvent.input(tagName, { target: { value: 'draft tag' } });
  await fireEvent.click(view.getByRole('button', { name: 'Move up' }));
  await tick();
  expect(view.getByRole('button', { name: 'Move up' }).disabled).toBe(true);
  expect(view.getByPlaceholderText('English…').value).toBe('typed beta');
  expect(view.getByPlaceholderText('Tag name…')).toBe(tagName);
  expect(tagName.value).toBe('draft tag');
  await fireEvent.keyDown(textarea, { key: 'z', metaKey: true });
  expect(page().lines.find((l) => l.n === 1).en).toBe('beta');
  page().activeLineN = -1;
  await tick();
  expect(view.queryByRole('button', { name: 'Move up' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Move down' })).toBeNull();
});
